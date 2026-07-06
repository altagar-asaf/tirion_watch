import {
  AgenticQueryGroup,
  AgenticQueryRun,
  AgenticWorkEpisode,
  aiCreditsFromNanoUsd,
  AttributionSpendSummary,
  CommitAttributionChange,
  CommitAttributionLedger,
  CommitAttributionQuery,
  CommitAttributionSummary,
  CommitPublicationSnapshot,
  CostCoverage,
  DiagnosticEvent,
  ExportResult,
  GitAttribution,
  normalizeProvider,
  ObservedCommitCandidate,
  QueryCostAttribution,
  RepositoryObservation,
  RepositoryObservationEvent,
  RunLedger,
  usdFromNanoUsd,
  WorkspaceChangeTracker,
  AgenticWorkEpisodeTracker
} from "../types";
import { evaluateCommitAttribution } from "./commitAttributionPolicy";

const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
const RECONCILIATION_RETRY_MS = 60_000;
const EPISODE_CLAIM_WINDOW_MS = 4 * 60 * 60 * 1000;

export class DefaultGitAttribution implements GitAttribution {
  private readonly changeHandlers = new Set<(change: CommitAttributionChange) => void>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private retryTimer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly observations: RepositoryObservation,
    private readonly episodes: AgenticWorkEpisodeTracker,
    private readonly workspaceChanges: WorkspaceChangeTracker,
    private readonly runLedger: RunLedger,
    private readonly ledger: CommitAttributionLedger,
    private readonly recordEvent: (event: DiagnosticEvent) => void = () => undefined,
    private readonly now: () => number = Date.now
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.recordLifecycle("reconciler", "started", "git_attribution_started");
    this.unsubscribe = this.observations.onObservation((event) => this.observeRepositoryEvent(event));
    await this.reconcilePersistedState();
    this.scheduleRetry();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.mutationQueue;
  }

  onDidChange(handler: (change: CommitAttributionChange) => void): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  async observeRunCompleted(run: AgenticQueryRun): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.synchronizePersistedCosts(run.queryId);
      await this.reconcileInternal();
      this.publish({ kind: "allocation_changed", queryId: run.queryId });
    });
  }

  async reconcilePersistedState(): Promise<void> {
    return this.enqueueMutation(async () => {
      const pricingChangedCommits = await this.synchronizePersistedCosts();
      const activeEpochIds = new Set((await this.observations.listEpochs())
        .filter((epoch) => epoch.status === "active")
        .map((epoch) => epoch.epochId));
      const quarantined = await this.ledger.quarantineLegacy(activeEpochIds);
      if (quarantined > 0) {
        this.recordEvent({
          kind: "attributionDecision",
          status: "legacy_unverified",
          reason: `legacy_allocations_quarantined_${quarantined}`
        });
      }
      await this.reconcileInternal();
      for (const commitHash of pricingChangedCommits) {
        this.publish({ kind: "allocation_changed", commitHash });
      }
    });
  }

  async reconcile(): Promise<void> {
    return this.enqueueMutation(() => this.reconcileInternal());
  }

  async listCommitAttributions(query: CommitAttributionQuery = {}): Promise<CommitAttributionSummary[]> {
    const summaries = await this.ledger.listCommitAttributions(query);
    return Promise.all(summaries.map(async (summary) => {
      if (summary.commitMessage?.trim()) {
        return summary;
      }
      const commitMessage = await this.observations.resolveCommitMessage(summary.repoKey, summary.commitHash);
      return commitMessage ? { ...summary, commitMessage } : summary;
    }));
  }

  listCommitPublicationSnapshots(query: CommitAttributionQuery = {}): Promise<CommitPublicationSnapshot[]> {
    return this.ledger.listCommitPublicationSnapshots(query);
  }

  async spendSummary(): Promise<AttributionSpendSummary> {
    const attributions = await this.ledger.listQueryAttributions({});
    const pendingNanoUsd = sumOptionalNanoUsd(attributions
      .filter((item) => item.status === "pending_commit" || item.status === "pending_evidence" || item.status === "rewrite_pending")
      .map((item) => item.estimatedNanoUsd));
    const unattributedNanoUsd = sumOptionalNanoUsd(attributions
      .filter((item) => item.status === "unattributed" || item.status === "rejected" || item.status === "expired" || item.status === "legacy_unverified")
      .map((item) => item.estimatedNanoUsd));
    return {
      pendingNanoUsd,
      pendingUsd: usdFromNanoUsd(pendingNanoUsd),
      pendingAiCredits: aiCreditsFromNanoUsd(pendingNanoUsd),
      unattributedNanoUsd,
      unattributedUsd: usdFromNanoUsd(unattributedNanoUsd),
      unattributedAiCredits: aiCreditsFromNanoUsd(unattributedNanoUsd)
    };
  }

  export(format: "json" | "csv", query: CommitAttributionQuery = {}): Promise<ExportResult> {
    return this.ledger.export(format, query);
  }

  async reset(): Promise<void> {
    await this.enqueueMutation(() => this.ledger.clear());
  }

  private observeRepositoryEvent(event: RepositoryObservationEvent): Promise<void> {
    return this.enqueueMutation(async () => {
      if (event.kind === "transition" && event.transitionKind === "non_fast_forward_ref_update") {
        await this.markConfirmedRewrites(event.repoKey, event.refKey, event.observedAt);
      }
      if (event.kind === "commit_candidate" || event.kind === "transition") {
        await this.reconcileInternal();
      }
    });
  }

  private async reconcileInternal(): Promise<void> {
    const expiredRewrites = await this.ledger.expireRewritePending(new Date(this.now() - CANDIDATE_TTL_MS).toISOString());
    if (expiredRewrites > 0) {
      this.recordEvent({
        kind: "attributionDecision",
        status: "superseded",
        reason: `rewrite_pending_expired_${expiredRewrites}`
      });
    }
    const epochs = await this.observations.listEpochs();
    const activeEpochIds = new Set(epochs.filter((epoch) => epoch.status === "active").map((epoch) => epoch.epochId));
    const quarantined = await this.ledger.quarantineLegacy(activeEpochIds);
    if (quarantined > 0) {
      this.recordEvent({
        kind: "attributionDecision",
        status: "legacy_unverified",
        reason: `inactive_epoch_allocations_quarantined_${quarantined}`
      });
      this.publish({ kind: "allocation_changed" });
    }
    const [candidates, episodes, attributions] = await Promise.all([
      this.observations.listCandidates(),
      this.episodes.listEpisodes({}),
      this.ledger.listQueryAttributions({})
    ]);
    const synchronizedStatuses = await this.synchronizeQueryStatuses(episodes, attributions);
    if (synchronizedStatuses > 0) {
      this.publish({ kind: "candidate_changed" });
    }
    const activeQueryIds = activeFirstClaimQueryIds(attributions);

    for (const candidate of candidates.filter((item) =>
      activeEpochIds.has(item.epochId)
      && (item.decision === "pending_evidence" || item.decision === "rewrite_pending" || item.decision === "reportable")
    )) {
      const previousDecision = candidate.decision;
      const previousReasons = JSON.stringify(candidate.reasonCodes);
      const candidateEpisodes = episodes.filter((episode) =>
        new Date(candidate.observedAt).getTime() >= new Date(episode.startedAt).getTime()
      );
      const temporallyRelevantEpisodes = candidateEpisodes.filter((episode) =>
        new Date(candidate.observedAt).getTime() - new Date(episode.lastAgentActivityAt).getTime() <= EPISODE_CLAIM_WINDOW_MS
      );
      const relevantEpisodes = temporallyRelevantEpisodes.filter((episode) =>
        episodeRepoKeys(episode).includes(candidate.repoKey)
      );
      const freshUnboundEpisodes = temporallyRelevantEpisodes.filter((episode) => episodeRepoKeys(episode).length === 0);
      const matchingRepositoryEpisodeObserved = candidateEpisodes.some((episode) =>
        episodeRepoKeys(episode).includes(candidate.repoKey)
      );
      const candidateEpisodeTransferableGroups = mergeClaimGroups(relevantEpisodes.map((episode) =>
        activeEpisodeSupersessionGroups(attributions, candidate, episode)
      ));
      const candidateEpisodeTransferableQueryIds = new Set([...candidateEpisodeTransferableGroups.values()].flat());
      const wasReportable = candidate.decision === "reportable";
      let reported = false;
      const reasons = new Set(candidate.reasonCodes.filter(isObservationReasonCode));
      if (wasReportable) {
        reasons.add("verified_content_continuity");
      }

      for (const episode of relevantEpisodes) {
        const episodeTransferableGroups = activeEpisodeSupersessionGroups(attributions, candidate, episode);
        const episodeTransferableQueryIds = new Set([...episodeTransferableGroups.values()].flat());
        const lineageVerifiedQueryIds = await this.lineageVerifiedQueryIds(candidate, episode);
        const result = evaluateCommitAttribution({
          candidate,
          episode,
          lineageVerifiedQueryIds,
          activeQueryIds: subtractQueries(activeQueryIds, episodeTransferableQueryIds),
          candidateAnchorQueryIds: activeCandidateAnchorQueryIds(attributions, candidate, episode)
        });
        result.reasonCodes.forEach((reason) => reasons.add(reason));
        if (result.decision === "pending_evidence") {
          continue;
        }
        if (result.decision !== "reportable" || !result.proof || result.queryIds.length === 0) {
          continue;
        }

        const rewriteGroups = rewritePendingGroups(attributions, result.queryIds, candidate.commitHash);
        const episodeTransferGroups = filterClaimGroups(episodeTransferableGroups, result.queryIds);
        const transferredQueryIds = new Set([
          ...[...rewriteGroups.values()].flat(),
          ...[...episodeTransferGroups.values()].flat()
        ]);
        const regularQueryIds = result.queryIds.filter((queryId) => !transferredQueryIds.has(queryId));
        const claimed = regularQueryIds.length > 0
          ? await this.ledger.tryFirstClaim({ candidate, episode, proof: result.proof, queryIds: regularQueryIds })
          : { claimedQueryIds: [], skippedQueryIds: [] };
        const transferred: string[] = [];
        for (const [supersededCommitHash, queryIds] of rewriteGroups) {
          const transfer = await this.ledger.transferFirstClaim({
            candidate,
            episode,
            proof: result.proof,
            queryIds,
            supersededCommitHash
          });
          transferred.push(...transfer.claimedQueryIds);
        }
        const claimedFreshEpisodeQueries = claimed.claimedQueryIds.length > 0;
        const sameEpisodeSupersessionAllowed = claimedFreshEpisodeQueries || episodeHasQueryActivitySinceClaim(episode);
        if (!sameEpisodeSupersessionAllowed && episodeTransferGroups.size > 0) {
          this.recordLifecycle("claim_transfer", "blocked", "episode_supersession_requires_fresh_episode_claim", {
            episodeId: episode.episodeId,
            repoKey: candidate.repoKey,
            epochId: candidate.epochId,
            commitHash: candidate.commitHash,
            details: {
              regularQueryCount: regularQueryIds.length,
              claimedQueryCount: claimed.claimedQueryIds.length,
              skippedQueryCount: claimed.skippedQueryIds.length,
              lastQueryActivityAt: episode.lastQueryActivityAt ?? null,
              claimedAt: episode.claimedAt ?? null,
              supersededCommitCount: episodeTransferGroups.size,
              transferableQueryCount: [...episodeTransferGroups.values()].flat().length
            }
          });
        } else {
          for (const [supersededCommitHash, queryIds] of episodeTransferGroups) {
            const transfer = await this.ledger.transferFirstClaim({
              candidate,
              episode,
              proof: result.proof,
              queryIds,
              supersededCommitHash
            });
            transferred.push(...transfer.claimedQueryIds);
            if (transfer.claimedQueryIds.length > 0) {
              this.recordLifecycle("claim_transfer", "episode_superseded", "same_episode_later_commit", {
                episodeId: episode.episodeId,
                repoKey: candidate.repoKey,
                epochId: candidate.epochId,
                commitHash: candidate.commitHash,
                details: {
                  supersededCommitHash,
                  transferredQueryCount: transfer.claimedQueryIds.length
                }
              });
            }
          }
        }
        const claimedQueryIds = uniqueStrings([...claimed.claimedQueryIds, ...transferred]);
        if (claimedQueryIds.length === 0) {
          continue;
        }
        reported = true;
        claimedQueryIds.forEach((queryId) => activeQueryIds.add(queryId));
        await this.episodes.markClaimed(episode.episodeId, candidate.commitHash, candidate.observedAt);
        await this.workspaceChanges.resolveQueries(claimedQueryIds);
        this.recordEvent({
          kind: "attributionDecision",
          episodeId: episode.episodeId,
          commitHash: candidate.commitHash,
          status: "reportable",
          reason: "verified_content_continuity"
        });
        this.recordLifecycle("candidate", "reportable", "verified_content_continuity", {
          episodeId: episode.episodeId,
          repoKey: candidate.repoKey,
          epochId: candidate.epochId,
          commitHash: candidate.commitHash,
          details: {
            claimedQueryCount: claimedQueryIds.length,
            regularClaimedQueryCount: claimed.claimedQueryIds.length,
            transferredQueryCount: transferred.length,
            rewriteTransferQueryCount: [...rewriteGroups.values()].flat().length,
            episodeTransferQueryCount: [...episodeTransferGroups.values()].flat().length,
            relevantEpisodeCount: relevantEpisodes.length,
            freshUnboundEpisodeCount: freshUnboundEpisodes.length,
            lineageVerifiedQueryCount: lineageVerifiedQueryIds.size
          }
        });
        this.publish({ kind: "allocation_changed", commitHash: candidate.commitHash });
      }

      if (!reported && !wasReportable) {
        if (freshUnboundEpisodes.length > 0) {
          reasons.add("fresh_episode_unbound_no_workspace_evidence");
        }
        if (relevantEpisodes.length === 0 && freshUnboundEpisodes.length === 0) {
          reasons.add(candidateEpisodes.some((episode) => episodeRepoKeys(episode).includes(candidate.repoKey))
            ? "matching_repository_episode_claim_window_expired"
            : "no_temporally_relevant_episode");
        }
      }
      candidate.decision = reported || wasReportable
        ? "reportable"
        : isExpired(candidate, this.now())
          ? "expired"
          : "pending_evidence";
      candidate.reasonCodes = uniqueStrings([...reasons]);
      const evaluation = candidateEvaluationOutcome({
        reported,
        wasReportable,
        relevantEpisodeCount: relevantEpisodes.length,
        freshUnboundEpisodeCount: freshUnboundEpisodes.length,
        matchingRepositoryEpisodeObserved,
        reasonCodes: candidate.reasonCodes
      });
      this.recordLifecycle("candidate_evaluation", evaluation.state, evaluation.reason, {
        repoKey: candidate.repoKey,
        epochId: candidate.epochId,
        commitHash: candidate.commitHash,
        details: {
          candidateDecision: candidate.decision,
          candidateEpisodeCount: candidateEpisodes.length,
          temporallyRelevantEpisodeCount: temporallyRelevantEpisodes.length,
          relevantEpisodeCount: relevantEpisodes.length,
          freshUnboundEpisodeCount: freshUnboundEpisodes.length,
          episodeTransferableQueryCount: candidateEpisodeTransferableQueryIds.size,
          episodeTransferableCommitCount: candidateEpisodeTransferableGroups.size,
          matchingRepositoryEpisodeObserved,
          candidateEpisodeIds: summarizeEpisodeIds(candidateEpisodes),
          temporallyRelevantEpisodeIds: summarizeEpisodeIds(temporallyRelevantEpisodes),
          relevantEpisodeIds: summarizeEpisodeIds(relevantEpisodes),
          freshUnboundEpisodeIds: summarizeEpisodeIds(freshUnboundEpisodes),
          reasonCodes: candidate.reasonCodes.join(",") || null
        }
      });
      if (candidate.decision !== previousDecision || JSON.stringify(candidate.reasonCodes) !== previousReasons) {
        await this.observations.updateCandidate(candidate);
        this.recordLifecycle("candidate", candidate.decision, primaryCandidateReason(candidate.reasonCodes), {
          repoKey: candidate.repoKey,
          epochId: candidate.epochId,
          commitHash: candidate.commitHash,
          details: {
            candidateEpisodeCount: candidateEpisodes.length,
            relevantEpisodeCount: relevantEpisodes.length,
            freshUnboundEpisodeCount: freshUnboundEpisodes.length,
            reasonCodeCount: candidate.reasonCodes.length
          }
        });
        this.recordEvent({
          kind: "attributionDecision",
          commitHash: candidate.commitHash,
          status: candidate.decision,
          reason: primaryCandidateReason(candidate.reasonCodes)
        });
        this.publish({ kind: "candidate_changed", commitHash: candidate.commitHash });
      }
    }
  }

  private async synchronizeQueryStatuses(
    episodes: AgenticWorkEpisode[],
    attributions: QueryCostAttribution[]
  ): Promise<number> {
    const now = this.now();
    const expiredQueryIds: string[] = [];
    let changed = 0;
    for (const attribution of attributions) {
      if (attribution.status === "attributed" || attribution.status === "rewrite_pending" || attribution.status === "legacy_unverified") {
        continue;
      }
      const queryEpisodes = episodes.filter((episode) => episode.queryIds.includes(attribution.queryId));
      const evidence = queryEpisodes.flatMap((episode) =>
        episode.evidence.filter((item) => item.queryId === attribution.queryId)
      );
      const nextStatus = evidence.length === 0
        ? "unattributed"
        : queryEpisodes.every((episode) => episode.status === "stale" || episode.status === "expired")
          || evidence.every((item) => item.expiresAt && new Date(item.expiresAt).getTime() <= now)
          ? "expired"
          : "pending_evidence";
      if (attribution.status === nextStatus) {
        continue;
      }
      attribution.status = nextStatus;
      await this.ledger.upsertQueryAttribution(attribution);
      changed += 1;
      if (nextStatus === "expired") {
        expiredQueryIds.push(attribution.queryId);
      }
    }
    if (expiredQueryIds.length > 0) {
      await this.workspaceChanges.resolveQueries(expiredQueryIds);
    }
    return changed;
  }

  private async lineageVerifiedQueryIds(candidate: ObservedCommitCandidate, episode: AgenticWorkEpisode): Promise<Set<string>> {
    const verified = new Set<string>();
    const evidence = episode.evidence.filter((item) => item.repoKey === candidate.repoKey && item.epochId === candidate.epochId);
    for (const item of evidence) {
      if (!item.headCommitAtStart && item.baselineSequence != null && candidate.observedSequence > item.baselineSequence) {
        verified.add(item.queryId);
        continue;
      }
      if (item.headCommitAtStart && await this.observations.isAncestor(candidate.repoKey, item.headCommitAtStart, candidate.commitHash)) {
        verified.add(item.queryId);
      }
    }
    return verified;
  }

  private async markConfirmedRewrites(repoKey: string, refKey: string | undefined, observedAt: string): Promise<void> {
    if (!refKey) {
      return;
    }
    const epoch = (await this.observations.listEpochs()).find((item) => item.repoKey === repoKey && item.status === "active");
    const currentRefHead = epoch?.refHeads?.[refKey];
    if (!currentRefHead) {
      this.recordEvent({
        kind: "attributionDecision",
        status: "skipped",
        reason: "rewrite_ref_cursor_unavailable"
      });
      return;
    }
    const attributions = await this.ledger.listQueryAttributions({ repoKey });
    const unreachable = new Set<string>();
    for (const attribution of attributions) {
      for (const allocation of attribution.allocations.filter((item) => item.status === "active" && item.decision === "reportable")) {
        if (allocation.refKey === refKey && !await this.observations.isAncestor(repoKey, allocation.commitHash, currentRefHead)) {
          unreachable.add(allocation.commitHash);
        }
      }
    }
    if (unreachable.size === 0) {
      return;
    }
    await this.ledger.markRewritePending(repoKey, [...unreachable], observedAt);
    for (const commitHash of unreachable) {
      await this.episodes.reopenSupersededCommit(commitHash);
    }
    this.recordEvent({
      kind: "attributionDecision",
      status: "rewrite_pending",
      reason: `confirmed_ref_rewrite_${unreachable.size}`
    });
    this.recordLifecycle("rewrite", "rewrite_pending", "confirmed_ref_rewrite", {
      repoKey,
      commitHash: [...unreachable][0],
      details: {
        unreachableCommitCount: unreachable.size,
        refKey: refKey ?? null
      }
    });
    this.publish({ kind: "history_rewrite", commitHash: [...unreachable][0] });
  }

  private async findQueryAttribution(queryId: string): Promise<QueryCostAttribution | undefined> {
    return (await this.ledger.listQueryAttributions({})).find((candidate) => candidate.queryId === queryId);
  }

  private async synchronizePersistedCosts(queryId?: string): Promise<string[]> {
    const groups = await this.runLedger.listQueryGroups(queryId ? { queryId } : {});
    const changedCommits = new Set<string>();
    for (const group of groups) {
      const existing = await this.findQueryAttribution(group.queryId);
      const next = mergePersistedQueryCost(
        structuredClone(existing ?? emptyAttribution(group.queryId)),
        group
      );
      if (existing && JSON.stringify(existing) !== JSON.stringify(next)) {
        for (const allocation of next.allocations.filter((item) =>
          item.allocationPolicy === "first_claim"
          && (item.status === "active" || item.status === "rewrite_pending")
        )) {
          changedCommits.add(allocation.commitHash);
        }
      }
      await this.ledger.upsertQueryAttribution(next);
    }
    return [...changedCommits];
  }

  private publish(change: CommitAttributionChange): void {
    for (const handler of this.changeHandlers) {
      try {
        handler(change);
      } catch {
        // Surface refresh listeners cannot invalidate a durable attribution write.
      }
    }
  }

  private scheduleRetry(): void {
    if (!this.running) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      void this.reconcile()
        .catch((error) => {
          this.recordEvent({
            kind: "info",
            message: `Attribution reconciliation failed and will retry: ${error instanceof Error ? error.message : String(error)}`
          });
        })
        .finally(() => this.scheduleRetry());
    }, RECONCILIATION_RETRY_MS);
    this.retryTimer.unref?.();
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private recordLifecycle(
    operation: string,
    state: string,
    reason: string,
    options?: {
      episodeId?: string;
      repoKey?: string;
      epochId?: string;
      commitHash?: string;
      details?: Record<string, string | number | boolean | null>;
    }
  ): void {
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "GitAttribution",
      operation,
      state,
      reason,
      ...(options?.episodeId ? { episodeId: options.episodeId } : {}),
      ...(options?.repoKey ? { repoKey: options.repoKey } : {}),
      ...(options?.epochId ? { epochId: options.epochId } : {}),
      ...(options?.commitHash ? { commitHash: options.commitHash } : {}),
      ...(options?.details ? { details: options.details } : {})
    });
  }
}

function mergePersistedQueryCost(attribution: QueryCostAttribution, group: AgenticQueryGroup): QueryCostAttribution {
  attribution.runIds = uniqueStrings(group.runs.map((run) => run.id));
  attribution.provider = normalizeProvider(group.modelUsages[0]?.provider ?? group.runs[0]?.serviceName);
  attribution.estimatedNanoUsd = group.estimatedNanoUsd;
  attribution.estimatedUsd = group.estimatedUsd;
  attribution.estimatedAiCredits = group.estimatedAiCredits;
  attribution.costCoverage = group.costCoverage;
  attribution.pricingCoverage = group.pricingCoverage;
  for (const allocation of attribution.allocations.filter((item) =>
    item.allocationPolicy === "first_claim"
    && item.decision === "reportable"
    && (item.status === "active" || item.status === "rewrite_pending")
  )) {
    allocation.allocatedNanoUsd = attribution.estimatedNanoUsd;
    allocation.coverage = attribution.costCoverage;
  }
  return attribution;
}

function activeFirstClaimQueryIds(attributions: QueryCostAttribution[]): Set<string> {
  return new Set(attributions
    .filter((attribution) => attribution.allocations.some((allocation) =>
      allocation.allocationPolicy === "first_claim"
      && allocation.status === "active"
    ))
    .map((attribution) => attribution.queryId));
}

function rewritePendingGroups(attributions: QueryCostAttribution[], queryIds: string[], replacementCommitHash: string): Map<string, string[]> {
  const requested = new Set(queryIds);
  const groups = new Map<string, string[]>();
  for (const attribution of attributions.filter((item) => requested.has(item.queryId))) {
    const pending = attribution.allocations.find((allocation) => allocation.status === "rewrite_pending");
    if (pending && pending.commitHash !== replacementCommitHash) {
      groups.set(pending.commitHash, [...(groups.get(pending.commitHash) ?? []), attribution.queryId]);
    }
  }
  return groups;
}

function activeEpisodeSupersessionGroups(
  attributions: QueryCostAttribution[],
  candidate: ObservedCommitCandidate,
  episode: AgenticWorkEpisode
): Map<string, string[]> {
  const requested = new Set(episode.queryIds);
  const groups = new Map<string, string[]>();
  for (const attribution of attributions.filter((item) => requested.has(item.queryId))) {
    const active = attribution.allocations.find((allocation) =>
      allocation.status === "active"
      && allocation.decision === "reportable"
      && allocation.episodeId === episode.episodeId
      && allocation.repoKey === candidate.repoKey
      && allocation.epochId === candidate.epochId
      && allocation.commitHash !== candidate.commitHash
      && allocation.createdAt < candidate.observedAt
    );
    if (!active) {
      continue;
    }
    groups.set(active.commitHash, [...(groups.get(active.commitHash) ?? []), attribution.queryId]);
  }
  return groups;
}

function activeCandidateAnchorQueryIds(
  attributions: QueryCostAttribution[],
  candidate: ObservedCommitCandidate,
  episode: AgenticWorkEpisode
): Set<string> {
  return new Set(attributions
    .filter((attribution) => attribution.allocations.some((allocation) =>
      allocation.status === "active"
      && allocation.decision === "reportable"
      && allocation.commitHash === candidate.commitHash
      && allocation.episodeId === episode.episodeId
    ))
    .map((attribution) => attribution.queryId));
}

function subtractQueries(activeQueryIds: Set<string>, excludedQueryIds: Set<string>): Set<string> {
  return new Set([...activeQueryIds].filter((queryId) => !excludedQueryIds.has(queryId)));
}

function filterClaimGroups(groups: Map<string, string[]>, queryIds: string[]): Map<string, string[]> {
  const requested = new Set(queryIds);
  const filtered = new Map<string, string[]>();
  for (const [commitHash, groupQueryIds] of groups) {
    const matching = groupQueryIds.filter((queryId) => requested.has(queryId));
    if (matching.length > 0) {
      filtered.set(commitHash, matching);
    }
  }
  return filtered;
}

function mergeClaimGroups(groups: Map<string, string[]>[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const group of groups) {
    for (const [commitHash, queryIds] of group) {
      merged.set(commitHash, uniqueStrings([...(merged.get(commitHash) ?? []), ...queryIds]));
    }
  }
  return merged;
}

function episodeHasQueryActivitySinceClaim(episode: AgenticWorkEpisode): boolean {
  if (!episode.claimedAt) {
    return true;
  }
  const lastQueryActivityAt = episode.lastQueryActivityAt ?? episode.lastAgentActivityAt;
  return new Date(lastQueryActivityAt).getTime() > new Date(episode.claimedAt).getTime();
}

function emptyAttribution(queryId: string): QueryCostAttribution {
  return {
    queryId,
    runIds: [],
    costCoverage: "unavailable",
    status: "unattributed",
    evidence: [],
    allocations: []
  };
}

function isExpired(candidate: ObservedCommitCandidate, now: number): boolean {
  return now - new Date(candidate.observedAt).getTime() > CANDIDATE_TTL_MS;
}

function episodeRepoKeys(episode: AgenticWorkEpisode): string[] {
  return episode.repoKeys ?? (episode.repoKey ? [episode.repoKey] : []);
}

function isObservationReasonCode(reason: string): boolean {
  return reason.endsWith("_observed_after_epoch");
}

function primaryCandidateReason(reasons: string[]): string {
  return reasons.find((reason) => !isObservationReasonCode(reason))
    ?? reasons[0]
    ?? "candidate_reconciled";
}

function sumOptionalNanoUsd(values: Array<number | undefined>): number | undefined {
  const reported = values.filter((value): value is number => value != null);
  return reported.length > 0 ? reported.reduce((sum, value) => sum + value, 0) : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}

function summarizeEpisodeIds(episodes: AgenticWorkEpisode[]): string | null {
  if (episodes.length === 0) {
    return null;
  }
  return episodes.map((episode) => episode.episodeId).join(",");
}

function candidateEvaluationOutcome(input: {
  reported: boolean;
  wasReportable: boolean;
  relevantEpisodeCount: number;
  freshUnboundEpisodeCount: number;
  matchingRepositoryEpisodeObserved: boolean;
  reasonCodes: string[];
}): {
  state: string;
  reason: string;
} {
  if (input.reported) {
    return { state: "matched_reportable", reason: "verified_content_continuity" };
  }
  if (input.wasReportable) {
    return { state: "reportable_retained", reason: "verified_content_continuity" };
  }
  if (input.relevantEpisodeCount === 0 && input.freshUnboundEpisodeCount > 0) {
    return { state: "waiting_for_workspace_evidence", reason: "fresh_episode_unbound_no_workspace_evidence" };
  }
  if (input.relevantEpisodeCount === 0 && input.matchingRepositoryEpisodeObserved) {
    return { state: "claim_window_expired", reason: "matching_repository_episode_claim_window_expired" };
  }
  if (input.relevantEpisodeCount === 0) {
    return { state: "no_matching_episode", reason: "no_temporally_relevant_episode" };
  }
  if (input.reasonCodes.includes("query_already_claimed_by_other_commit")) {
    return { state: "blocked_by_active_claim", reason: "query_already_claimed_by_other_commit" };
  }
  return {
    state: "evaluated_no_reportable_match",
    reason: primaryCandidateReason(input.reasonCodes)
  };
}
