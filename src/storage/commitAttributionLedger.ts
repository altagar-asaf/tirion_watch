import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  aiCreditsFromNanoUsd,
  AttributionConfidence,
  CommitAttributionLedger,
  CommitAttributionQuery,
  CommitAttributionStatus,
  CommitAttributionSummary,
  CommitProviderCost,
  CommitPublicationSnapshot,
  CostCoverage,
  ExportResult,
  FirstClaimInput,
  MatchedCausalWriteArtifactEvidence,
  NativeCausalClaimReconciliationInput,
  NativeCausalClaimReconciliationResult,
  ObservedCommitCandidate,
  PrivacyGuard,
  QueryCostAttribution,
  QueryWorkEvidence,
  usdFromNanoUsd
} from "../types";
import { applyPricingCoveragePolicy } from "../pricing/pricingCoveragePolicy";

export class JsonlCommitAttributionLedger implements CommitAttributionLedger {
  private readonly attributionsPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    storageDir: string,
    protected readonly privacyGuard: PrivacyGuard,
    private readonly now: () => number = Date.now
  ) {
    this.attributionsPath = path.join(storageDir, "commit-attributions.jsonl");
  }

  get filePath(): string {
    return this.attributionsPath;
  }

  async upsertQueryAttribution(attribution: QueryCostAttribution): Promise<void> {
    assertAttributionWritable(attribution, this.privacyGuard);

    await this.enqueueWrite(async () => {
      const attributions = await this.loadAttributions();
      const next = normalizeAttribution(attribution);
      const existingIndex = attributions.findIndex((candidate) => candidate.queryId === next.queryId);
      if (existingIndex >= 0) {
        if (JSON.stringify(attributions[existingIndex]) === JSON.stringify(next)) {
          return;
        }
        attributions[existingIndex] = next;
      } else {
        attributions.push(next);
      }
      await this.persistAttributions(attributions);
    });
  }

  async tryFirstClaim(input: FirstClaimInput): Promise<{ claimedQueryIds: string[]; skippedQueryIds: string[] }> {
    return this.enqueueWrite(async () => {
      const attributions = await this.loadAttributions();
      const byQuery = new Map(attributions.map((item) => [item.queryId, item]));
      const claimedQueryIds: string[] = [];
      const skippedQueryIds: string[] = [];
      const verifiedAt = new Date(this.now()).toISOString();
      for (const queryId of input.queryIds) {
        const attribution = structuredClone(byQuery.get(queryId) ?? emptyAttribution(queryId));
        if (hasActiveFirstClaim(attribution)) {
          skippedQueryIds.push(queryId);
          continue;
        }
        attribution.evidence = mergeEvidence(
          attribution.evidence,
          input.episode.evidence.filter((evidence) => evidence.queryId === queryId)
        );
        attribution.allocations.push(allocationFromClaim(input, attribution, queryId, verifiedAt));
        attribution.status = "attributed";
        await this.validate(attribution);
        byQuery.set(queryId, normalizeAttribution(attribution));
        claimedQueryIds.push(queryId);
      }
      await this.persistAttributions([...byQuery.values()]);
      return { claimedQueryIds, skippedQueryIds };
    });
  }

  async transferFirstClaim(input: FirstClaimInput & { supersededCommitHash: string }): Promise<{ claimedQueryIds: string[]; skippedQueryIds: string[] }> {
    return this.enqueueWrite(async () => {
      const attributions = await this.loadAttributions();
      const byQuery = new Map(attributions.map((item) => [item.queryId, item]));
      const claimedQueryIds: string[] = [];
      const skippedQueryIds: string[] = [];
      const verifiedAt = new Date(this.now()).toISOString();
      for (const queryId of input.queryIds) {
        const attribution = structuredClone(byQuery.get(queryId) ?? emptyAttribution(queryId));
        const previous = attribution.allocations.find((allocation) =>
          allocation.commitHash === input.supersededCommitHash
          && (allocation.status === "active" || allocation.status === "rewrite_pending")
        );
        if (!previous) {
          skippedQueryIds.push(queryId);
          continue;
        }
        attribution.evidence = mergeEvidence(
          attribution.evidence,
          input.episode.evidence.filter((evidence) => evidence.queryId === queryId)
        );
        previous.status = "superseded";
        previous.decision = "superseded";
        previous.rewritePendingAt = undefined;
        previous.stateChangedAt = verifiedAt;
        attribution.allocations.push(allocationFromClaim(input, attribution, queryId, verifiedAt));
        attribution.status = "attributed";
        await this.validate(attribution);
        byQuery.set(queryId, normalizeAttribution(attribution));
        claimedQueryIds.push(queryId);
      }
      await this.persistAttributions([...byQuery.values()]);
      return { claimedQueryIds, skippedQueryIds };
    });
  }

  /**
   * Native Claude permission decisions can arrive after an otherwise valid
   * first claim was durably stored.  Reconcile only allocations that retained
   * the exact causal source pairs used at claim time; legacy/snapshot-only
   * claims intentionally remain outside this narrow correction path.
   */
  async reconcileNativeRejectedCausalClaims(
    input: NativeCausalClaimReconciliationInput
  ): Promise<NativeCausalClaimReconciliationResult> {
    return this.enqueueWrite(async () => {
      const attributions = await this.loadAttributions();
      const candidates = new Map(input.candidates.map((candidate) => [
        candidateKey(candidate.repoKey, candidate.epochId, candidate.commitHash),
        candidate
      ]));
      const changedAt = new Date(this.now()).toISOString();
      const revokedQueryIds = new Set<string>();
      const revokedCommitHashes = new Set<string>();
      const revalidatedQueryIds = new Set<string>();
      const revalidatedCommitHashes = new Set<string>();
      let changed = false;

      for (const attribution of attributions) {
        let attributionChanged = false;
        let revokedAllocation = false;
        for (const allocation of attribution.allocations) {
          if (
            allocation.allocationPolicy !== "first_claim"
            || (allocation.status !== "active" && allocation.status !== "rewrite_pending")
            || !allocation.proof
          ) {
            continue;
          }
          const storedPairs = allocation.proof.matchedCausalWriteArtifacts ?? [];
          if (storedPairs.length === 0 || !allocation.epochId) {
            // Missing proof provenance is deliberately non-revocable: an
            // absent, expired, malformed, or unreadable census is not native
            // rejection authority.
            continue;
          }
          const candidate = candidates.get(candidateKey(
            allocation.repoKey,
            allocation.epochId,
            allocation.commitHash
          ));
          if (!candidate) {
            continue;
          }

          const sourceEvidence = sourceEvidenceForAllocation(input.evidence, allocation);
          const explicitlyRejected = storedPairs.filter((pair) =>
            isExplicitlyNativeRejectedPair(pair, sourceEvidence)
          );
          if (explicitlyRejected.length === 0) {
            continue;
          }

          const currentMatchedPairs = currentMatchedCausalPairsForCandidate(
            sourceEvidence,
            candidate
          );
          if (currentMatchedPairs.length > 0) {
            // An independent current source pair can still prove the exact
            // candidate. Replace stale rejected provenance with only the
            // current matched pair(s), never with every write in the query.
            allocation.proof = {
              ...allocation.proof,
              matchedCausalWriteArtifacts: currentMatchedPairs
            };
            allocation.stateChangedAt = changedAt;
            allocation.evidenceReasons = uniqueStrings([
              ...allocation.evidenceReasons,
              "native_causal_write_revalidated"
            ]);
            attributionChanged = true;
            changed = true;
            revalidatedQueryIds.add(attribution.queryId);
            revalidatedCommitHashes.add(allocation.commitHash);
            continue;
          }

          // Revocation requires every exact pair that justified this stored
          // allocation to be explicitly native-rejected in its own complete
          // query/repository/epoch census. Pair disappearance alone cannot
          // revoke anything.
          if (explicitlyRejected.length !== storedPairs.length) {
            continue;
          }
          allocation.status = "superseded";
          allocation.decision = "superseded";
          allocation.rewritePendingAt = undefined;
          allocation.stateChangedAt = changedAt;
          allocation.evidenceReasons = uniqueStrings([
            ...allocation.evidenceReasons,
            "native_causal_write_retracted"
          ]);
          attributionChanged = true;
          revokedAllocation = true;
          changed = true;
          revokedQueryIds.add(attribution.queryId);
          revokedCommitHashes.add(allocation.commitHash);
        }
        if (!attributionChanged) {
          continue;
        }
        if (revokedAllocation && !hasActiveFirstClaim(attribution)) {
          attribution.status = "rejected";
        }
        await this.validate(attribution);
      }

      if (changed) {
        await this.persistAttributions(attributions);
      }
      return {
        revokedQueryIds: [...revokedQueryIds].sort(),
        revokedCommitHashes: [...revokedCommitHashes].sort(),
        revalidatedQueryIds: [...revalidatedQueryIds].sort(),
        revalidatedCommitHashes: [...revalidatedCommitHashes].sort()
      };
    });
  }

  async markRewritePending(repoKey: string, commitHashes: string[], observedAt = new Date().toISOString()): Promise<number> {
    const targets = new Set(commitHashes);
    return this.enqueueWrite(async () => {
      const attributions = await this.loadAttributions();
      let changed = 0;
      for (const attribution of attributions) {
        for (const allocation of attribution.allocations) {
          if (allocation.repoKey === repoKey && targets.has(allocation.commitHash) && allocation.status === "active") {
            allocation.status = "rewrite_pending";
            allocation.decision = "rewrite_pending";
            allocation.rewritePendingAt = observedAt;
            allocation.stateChangedAt = observedAt;
            attribution.status = "rewrite_pending";
            changed += 1;
          }
        }
      }
      if (changed > 0) {
        await this.persistAttributions(attributions);
      }
      return changed;
    });
  }

  async expireRewritePending(before: string): Promise<number> {
    return this.enqueueWrite(async () => {
      const attributions = await this.loadAttributions();
      let changed = 0;
      for (const attribution of attributions) {
        for (const allocation of attribution.allocations) {
          if (allocation.status !== "rewrite_pending" || !allocation.rewritePendingAt || allocation.rewritePendingAt > before) {
            continue;
          }
          allocation.status = "superseded";
          allocation.decision = "superseded";
          allocation.rewritePendingAt = undefined;
          allocation.stateChangedAt = new Date(this.now()).toISOString();
          attribution.status = "expired";
          changed += 1;
        }
      }
      if (changed > 0) {
        await this.persistAttributions(attributions);
      }
      return changed;
    });
  }

  async quarantineLegacy(activeEpochIds?: Set<string>): Promise<number> {
    return this.enqueueWrite(async () => {
      const attributions = await this.loadAttributions();
      let changed = 0;
      for (const attribution of attributions) {
        const hasLegacyEvidence = attribution.evidence.some((evidence) =>
          !evidence.epochId || (activeEpochIds != null && !activeEpochIds.has(evidence.epochId))
        );
        for (const allocation of attribution.allocations) {
          if (
            !allocation.epochId
            || (activeEpochIds != null && !activeEpochIds.has(allocation.epochId))
            || !allocation.proof
            || !isVerifiedDecision(allocation.decision)
          ) {
            if (allocation.status !== "legacy_unverified" || allocation.decision !== "legacy_unverified") {
              allocation.status = "legacy_unverified";
              allocation.decision = "legacy_unverified";
              changed += 1;
            }
          }
        }
        if (!attribution.allocations.some(isVerifiedAllocation) && (attribution.allocations.length > 0 || hasLegacyEvidence)) {
          if (attribution.status !== "legacy_unverified") {
            changed += 1;
          }
          attribution.status = "legacy_unverified";
        }
      }
      if (changed > 0) {
        await this.persistAttributions(attributions);
      }
      return changed;
    });
  }

  async listQueryAttributions(query: CommitAttributionQuery = {}): Promise<QueryCostAttribution[]> {
    const attributions = await this.loadAttributions();
    return attributions
      .filter((attribution) => matchesQueryAttribution(attribution, query))
      .sort((a, b) => latestAttributionTimestamp(b).localeCompare(latestAttributionTimestamp(a)))
      .slice(0, query.limit ?? attributions.length);
  }

  async listCommitAttributions(query: CommitAttributionQuery = {}): Promise<CommitAttributionSummary[]> {
    const attributions = await this.loadAttributions();
    const summaries = summarizeCommits(attributions)
      .filter((summary) => matchesCommitSummary(summary, query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return typeof query.limit === "number" ? summaries.slice(0, query.limit) : summaries;
  }

  async listCommitPublicationSnapshots(query: CommitAttributionQuery = {}): Promise<CommitPublicationSnapshot[]> {
    const attributions = await this.loadAttributions();
    const snapshots = summarizePublicationSnapshots(attributions)
      .filter((snapshot) =>
        (!query.repoKey || snapshot.repoKey === query.repoKey)
        && (!query.commitHash || snapshot.commitHash === query.commitHash)
        && (!query.range || (snapshot.updatedAt >= query.range.from && snapshot.updatedAt <= query.range.to))
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return typeof query.limit === "number" ? snapshots.slice(0, query.limit) : snapshots;
  }

  async export(format: "json" | "csv", query: CommitAttributionQuery = {}): Promise<ExportResult> {
    const summaries = await this.listCommitAttributions(query);
    return {
      format,
      content: format === "json" ? `${JSON.stringify(summaries, null, 2)}\n` : toCsv(summaries),
      count: summaries.length
    };
  }

  async applyRetention(retentionDays = 180, retainedQueryIds?: Set<string>): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return 0;
    }

    return this.enqueueWrite(async () => {
      const cutoff = this.now() - retentionDays * 24 * 60 * 60 * 1000;
      const attributions = await this.loadAttributions();
      const retained = attributions.filter((attribution) =>
        retainedQueryIds
          ? retainedQueryIds.has(attribution.queryId)
          : new Date(latestAttributionTimestamp(attribution)).getTime() >= cutoff
      );
      const removed = attributions.length - retained.length;
      if (removed > 0) {
        await this.persistAttributions(retained);
      }
      return removed;
    });
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(() => this.persistAttributions([]));
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async validate(record: unknown): Promise<void> {
    const privacy = this.privacyGuard.validateAttribution(record);
    if (!privacy.ok) {
      throw new Error(`Attribution privacy violation: ${privacy.violations.join(", ")}`);
    }
    if (isQueryCostAttribution(record)) {
      assertAttributionInvariants(record);
    }
  }

  protected async loadAttributions(): Promise<QueryCostAttribution[]> {
    let content = "";
    try {
      content = await fs.readFile(this.attributionsPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    return content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return isQueryCostAttribution(parsed) ? [normalizeAttribution(parsed)] : [];
        } catch {
          return [];
        }
      });
  }

  protected async persistAttributions(attributions: QueryCostAttribution[]): Promise<void> {
    await writeAttributions(this.attributionsPath, attributions, this.privacyGuard);
  }
}

export class StateBackedCommitAttributionLedger extends JsonlCommitAttributionLedger {
  constructor(
    private readonly loadState: () => Promise<QueryCostAttribution[]>,
    private readonly saveState: (attributions: QueryCostAttribution[]) => Promise<void>,
    privacyGuard: PrivacyGuard,
    now: () => number = Date.now
  ) {
    super(".", privacyGuard, now);
  }

  protected override async loadAttributions(): Promise<QueryCostAttribution[]> {
    return (await this.loadState()).map((attribution) => normalizeAttribution(attribution));
  }

  protected override async persistAttributions(attributions: QueryCostAttribution[]): Promise<void> {
    for (const attribution of attributions) {
      assertAttributionWritable(attribution, this.privacyGuard);
    }
    await this.saveState(attributions.map(normalizeAttribution));
  }
}

function summarizeCommits(attributions: QueryCostAttribution[]): CommitAttributionSummary[] {
  const byCommit = new Map<string, Array<{ attribution: QueryCostAttribution; allocation: QueryCostAttribution["allocations"][number] }>>();
  for (const attribution of attributions) {
    for (const allocation of attribution.allocations.filter(isSurfacedAllocation)) {
      const key = `${allocation.repoKey}:${allocation.commitHash}`;
      byCommit.set(key, [...(byCommit.get(key) ?? []), { attribution, allocation }]);
    }
  }

  return [...byCommit.values()].map((items) => {
    const first = items[0].allocation;
    const queryIds = uniqueStrings(items.map((item) => item.attribution.queryId));
    const linkedNanoUsd = sumOptionalNanoUsd(uniqueByQuery(items).map((item) => item.attribution.estimatedNanoUsd));
    const allocatedNanoUsd = sumOptionalNanoUsd(items.map((item) => item.allocation.status === "active" ? item.allocation.allocatedNanoUsd : undefined));
    const coverage = aggregateCoverage(items.flatMap((item) => [item.allocation.coverage, item.attribution.costCoverage]));
    const confidence = aggregateConfidence(items.map((item) => item.allocation.confidence));
    const status = aggregateStatus(items);
    const proofs = items.flatMap((item) => item.allocation.proof ? [item.allocation.proof] : []);
    return {
      commitHash: first.commitHash,
      commitMessage: first.commitMessage,
      parentHashes: uniqueStrings(items.flatMap((item) => item.allocation.parentHashes)),
      repoKey: first.repoKey,
      episodeIds: uniqueStrings(items.flatMap((item) => item.allocation.episodeId ? [item.allocation.episodeId] : [])),
      queryIds,
      runIds: uniqueStrings(items.flatMap((item) => item.attribution.runIds)),
      linkedQueryCount: queryIds.length,
      allocatedNanoUsd,
      allocatedUsd: usdFromNanoUsd(allocatedNanoUsd),
      allocatedAiCredits: aiCreditsFromNanoUsd(allocatedNanoUsd),
      linkedNanoUsd,
      linkedUsd: usdFromNanoUsd(linkedNanoUsd),
      linkedAiCredits: aiCreditsFromNanoUsd(linkedNanoUsd),
      providerCosts: summarizeProviderCosts(items),
      coverage,
      decision: items.some((item) => item.allocation.status === "active") ? "reportable" : "superseded",
      proofKinds: uniqueStrings(proofs.map((proof) => proof.kind)),
      anchorQueryIds: uniqueStrings(proofs.flatMap((proof) => proof.anchorQueryIds)),
      inheritedQueryIds: uniqueStrings(proofs.flatMap((proof) => proof.inheritedQueryIds)),
      confidence,
      status,
      evidenceReasons: uniqueStrings(items.flatMap((item) => item.allocation.evidenceReasons)),
      createdAt: items.map((item) => item.allocation.createdAt).sort().at(-1) ?? new Date().toISOString()
    };
  });
}

function summarizeProviderCosts(
  items: Array<{ attribution: QueryCostAttribution; allocation: QueryCostAttribution["allocations"][number] }>
): CommitProviderCost[] {
  const byProvider = new Map<string, { queryIds: Set<string>; nanoUsd: Array<number | undefined> }>();
  for (const item of items.filter((entry) => entry.allocation.status === "active")) {
    const provider = item.attribution.provider ?? "unknown";
    const entry = byProvider.get(provider) ?? { queryIds: new Set<string>(), nanoUsd: [] };
    entry.queryIds.add(item.attribution.queryId);
    entry.nanoUsd.push(item.allocation.allocatedNanoUsd);
    byProvider.set(provider, entry);
  }
  return [...byProvider.entries()]
    .map(([provider, entry]) => {
      const allocatedNanoUsd = sumOptionalNanoUsd(entry.nanoUsd);
      return {
        provider,
        queryCount: entry.queryIds.size,
        allocatedNanoUsd,
        allocatedUsd: usdFromNanoUsd(allocatedNanoUsd),
        allocatedAiCredits: aiCreditsFromNanoUsd(allocatedNanoUsd)
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function summarizePublicationSnapshots(attributions: QueryCostAttribution[]): CommitPublicationSnapshot[] {
  const byCommit = new Map<string, Array<{ attribution: QueryCostAttribution; allocation: QueryCostAttribution["allocations"][number] }>>();
  for (const attribution of attributions) {
    const currentPublication = attribution.status === "attributed" || attribution.status === "rewrite_pending";
    const nativeCorrection = attribution.status === "rejected";
    if (!currentPublication && !nativeCorrection) {
      continue;
    }
    for (const allocation of attribution.allocations.filter((item) =>
      isPublicationAllocation(item)
      && (currentPublication || isNativeCausalRetractionAllocation(item))
    )) {
      const key = `${allocation.repoKey}:${allocation.commitHash}`;
      byCommit.set(key, [...(byCommit.get(key) ?? []), { attribution, allocation }]);
    }
  }

  return [...byCommit.values()].map((items) => {
    const first = items[0].allocation;
    const states = items.map((item) => item.allocation.status);
    const state = states.includes("rewrite_pending")
      ? "rewrite_pending"
      : states.includes("active")
        ? "active"
        : "superseded";
    const verifiedTimes = items.map((item) => item.allocation.verifiedAt ?? item.allocation.createdAt).sort();
    const updateTimes = items.map((item) =>
      item.allocation.stateChangedAt ?? item.allocation.rewritePendingAt ?? item.allocation.createdAt
    ).sort();
    return {
      repoKey: first.repoKey,
      commitHash: first.commitHash,
      commitMessage: first.commitMessage,
      state,
      firstVerifiedAt: verifiedTimes[0],
      updatedAt: updateTimes.at(-1) ?? verifiedTimes[0],
      allocatedNanoUsd: sumOptionalNanoUsd(items.map((item) =>
        item.allocation.status === "superseded" ? undefined : item.allocation.allocatedNanoUsd
      )),
      coverage: aggregateCoverage(items.map((item) => item.allocation.coverage)),
      attributedQueryCount: uniqueStrings(items.map((item) => item.attribution.queryId)).length
    };
  });
}

function isNativeCausalRetractionAllocation(allocation: QueryCostAttribution["allocations"][number]): boolean {
  return allocation.status === "superseded"
    && allocation.decision === "superseded"
    && allocation.evidenceReasons.includes("native_causal_write_retracted");
}

function isSurfacedAllocation(allocation: QueryCostAttribution["allocations"][number]): boolean {
  return allocation.allocationPolicy === "first_claim"
    && (allocation.decision === "reportable" || allocation.decision === "superseded")
    && allocation.epochId != null
    && allocation.proof != null
    && (allocation.status === "active" || allocation.status === "superseded");
}

function isPublicationAllocation(allocation: QueryCostAttribution["allocations"][number]): boolean {
  return allocation.allocationPolicy === "first_claim"
    && allocation.epochId != null
    && allocation.proof != null
    && (allocation.decision === "reportable" || allocation.decision === "rewrite_pending" || allocation.decision === "superseded")
    && (allocation.status === "active" || allocation.status === "rewrite_pending" || allocation.status === "superseded");
}

function candidateKey(repoKey: string, epochId: string, commitHash: string): string {
  return `${repoKey}\u0000${epochId}\u0000${commitHash}`;
}

function sourceEvidenceForAllocation(
  evidence: QueryWorkEvidence[],
  allocation: QueryCostAttribution["allocations"][number]
): QueryWorkEvidence[] {
  if (!allocation.proof || !allocation.epochId) {
    return [];
  }
  const sourceQueryIds = new Set((allocation.proof.matchedCausalWriteArtifacts ?? [])
    .map((pair) => pair.queryId));
  return evidence.filter((item) =>
    sourceQueryIds.has(item.queryId)
    && item.repoKey === allocation.repoKey
    && item.epochId === allocation.epochId
  );
}

function isExplicitlyNativeRejectedPair(
  pair: MatchedCausalWriteArtifactEvidence,
  evidence: QueryWorkEvidence[]
): boolean {
  return evidence.some((item) =>
    item.queryId === pair.queryId
    && item.causalWriteArtifactsComplete === true
    && containsCausalPair(item.nativeRejectedCausalWriteArtifacts, pair)
    && !containsCausalPair(item.causalWriteArtifacts, pair)
  );
}

function currentMatchedCausalPairsForCandidate(
  evidence: QueryWorkEvidence[],
  candidate: ObservedCommitCandidate
): MatchedCausalWriteArtifactEvidence[] {
  const pairs = new Map<string, MatchedCausalWriteArtifactEvidence>();
  for (const item of evidence) {
    if (item.causalWriteArtifactsComplete !== true) {
      continue;
    }
    for (const pair of item.causalWriteArtifacts ?? []) {
      const matchesCandidate = (item.artifactStates ?? []).some((observed) =>
        observed.artifactKey === pair.artifactKey
        && candidate.artifactStates.some((committed) => artifactStatesMatch(observed, committed))
      );
      if (!matchesCandidate) {
        continue;
      }
      const matched: MatchedCausalWriteArtifactEvidence = {
        queryId: item.queryId,
        artifactKey: pair.artifactKey,
        executionNodeId: pair.executionNodeId
      };
      pairs.set(matchedCausalPairKey(matched), matched);
    }
  }
  return [...pairs.values()].sort((left, right) =>
    left.queryId.localeCompare(right.queryId)
    || left.artifactKey.localeCompare(right.artifactKey)
    || left.executionNodeId.localeCompare(right.executionNodeId)
  );
}

function containsCausalPair(
  pairs: QueryWorkEvidence["causalWriteArtifacts"],
  expected: MatchedCausalWriteArtifactEvidence
): boolean {
  return (pairs ?? []).some((pair) =>
    pair.artifactKey === expected.artifactKey
    && pair.executionNodeId === expected.executionNodeId
  );
}

function matchedCausalPairKey(pair: MatchedCausalWriteArtifactEvidence): string {
  return `${pair.queryId}\u0000${pair.artifactKey}\u0000${pair.executionNodeId}`;
}

function artifactStatesMatch(
  observed: NonNullable<QueryWorkEvidence["artifactStates"]>[number],
  committed: ObservedCommitCandidate["artifactStates"][number]
): boolean {
  const sameArtifact = observed.artifactKey === committed.artifactKey
    || observed.artifactKey === committed.previousArtifactKey
    || observed.previousArtifactKey === committed.artifactKey;
  if (!sameArtifact) {
    return false;
  }
  if (observed.changeKind === "deleted" && committed.changeKind === "deleted") {
    return true;
  }
  if (!committed.stateKey) {
    return false;
  }
  return committed.stateKey === observed.worktreeStateKey || committed.stateKey === observed.indexStateKey;
}

function normalizeAttribution(attribution: QueryCostAttribution): QueryCostAttribution {
  const pricingCoverage = attribution.pricingCoverage
    ? applyPricingCoveragePolicy(attribution.pricingCoverage)
    : undefined;
  const costCoverage = pricingCoverage?.state === "priced" ? "complete" : attribution.costCoverage;
  const allocations = attribution.allocations
    .map((allocation) => ({
      ...allocation,
      coverage: pricingCoverage?.state === "priced" && allocation.coverage === "partial" ? "complete" : allocation.coverage,
      parentHashes: uniqueStrings(allocation.parentHashes),
      evidenceReasons: uniqueStrings(allocation.evidenceReasons),
      proof: allocation.proof ? normalizeProof(allocation.proof) : undefined
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commitHash.localeCompare(b.commitHash));

  return {
    ...attribution,
    costCoverage,
    pricingCoverage,
    runIds: uniqueStrings(attribution.runIds),
    evidence: attribution.evidence.map((evidence) => ({
      ...evidence,
      runIds: uniqueStrings(evidence.runIds),
      baselineReasons: uniqueStrings(evidence.baselineReasons),
      artifactKeys: uniqueStrings(evidence.artifactKeys),
      causalArtifactKeys: evidence.causalArtifactKeys ? uniqueStrings(evidence.causalArtifactKeys) : undefined,
      causalWriteArtifacts: evidence.causalWriteArtifacts
        ? uniqueCausalWriteArtifacts(evidence.causalWriteArtifacts)
        : undefined,
      nativeRejectedCausalWriteArtifacts: evidence.nativeRejectedCausalWriteArtifacts
        ? uniqueCausalWriteArtifacts(evidence.nativeRejectedCausalWriteArtifacts)
        : undefined
    })),
    allocations
  };
}

function normalizeProof(proof: NonNullable<QueryCostAttribution["allocations"][number]["proof"]>) {
  return {
    ...proof,
    anchorQueryIds: uniqueStrings(proof.anchorQueryIds),
    inheritedQueryIds: uniqueStrings(proof.inheritedQueryIds),
    matchedCausalWriteArtifacts: proof.matchedCausalWriteArtifacts
      ? uniqueMatchedCausalWriteArtifacts(proof.matchedCausalWriteArtifacts)
      : undefined,
    reasonCodes: uniqueStrings(proof.reasonCodes)
  };
}

function uniqueMatchedCausalWriteArtifacts(
  pairs: MatchedCausalWriteArtifactEvidence[]
): MatchedCausalWriteArtifactEvidence[] {
  const byPair = new Map<string, MatchedCausalWriteArtifactEvidence>();
  for (const pair of pairs) {
    byPair.set(matchedCausalPairKey(pair), pair);
  }
  return [...byPair.values()].sort((left, right) =>
    left.queryId.localeCompare(right.queryId)
    || left.artifactKey.localeCompare(right.artifactKey)
    || left.executionNodeId.localeCompare(right.executionNodeId)
  );
}

function uniqueCausalWriteArtifacts(
  artifacts: NonNullable<QueryCostAttribution["evidence"][number]["causalWriteArtifacts"]>
): NonNullable<QueryCostAttribution["evidence"][number]["causalWriteArtifacts"]> {
  const byPair = new Map<string, NonNullable<QueryCostAttribution["evidence"][number]["causalWriteArtifacts"]>[number]>();
  for (const artifact of artifacts) {
    byPair.set(`${artifact.artifactKey}:${artifact.executionNodeId}`, artifact);
  }
  return [...byPair.values()].sort((left, right) =>
    left.artifactKey.localeCompare(right.artifactKey)
    || left.executionNodeId.localeCompare(right.executionNodeId)
  );
}

function matchesQueryAttribution(attribution: QueryCostAttribution, query: CommitAttributionQuery): boolean {
  if (query.repoKey && !attribution.evidence.some((evidence) => evidence.repoKey === query.repoKey) && !attribution.allocations.some((allocation) => allocation.repoKey === query.repoKey)) {
    return false;
  }
  if (query.commitHash && !attribution.allocations.some((allocation) => allocation.commitHash === query.commitHash)) {
    return false;
  }
  if (query.range) {
    const timestamp = latestAttributionTimestamp(attribution);
    return timestamp >= query.range.from && timestamp <= query.range.to;
  }
  return true;
}

function matchesCommitSummary(summary: CommitAttributionSummary, query: CommitAttributionQuery): boolean {
  if (query.repoKey && summary.repoKey !== query.repoKey) {
    return false;
  }
  if (query.commitHash && summary.commitHash !== query.commitHash) {
    return false;
  }
  if (query.range) {
    return summary.createdAt >= query.range.from && summary.createdAt <= query.range.to;
  }
  return true;
}

function aggregateCoverage(values: CostCoverage[]): CostCoverage {
  const reported = values.filter((value) => value !== "unavailable");
  if (reported.length === 0) {
    return "unavailable";
  }
  return reported.length === values.length && reported.every((value) => value === "complete")
    ? "complete"
    : "partial";
}

function aggregateConfidence(values: Array<AttributionConfidence | undefined>): AttributionConfidence | undefined {
  const reported = values.filter((value): value is AttributionConfidence => value != null);
  if (reported.length === 0) {
    return undefined;
  }
  if (reported.includes("low")) {
    return "low";
  }
  if (reported.includes("medium")) {
    return "medium";
  }
  return "high";
}

function aggregateStatus(items: Array<{ attribution: QueryCostAttribution; allocation: QueryCostAttribution["allocations"][number] }>): CommitAttributionStatus {
  if (items.some((item) => item.allocation.status === "rewrite_pending")) {
    return "rewrite_pending";
  }
  if (items.every((item) => item.allocation.status === "superseded")) {
    return "superseded";
  }
  if (items.some((item) => item.attribution.status === "manual_review")) {
    return "manual_review";
  }
  if (items.some((item) => item.allocation.status === "superseded")) {
    return "mixed";
  }
  return "active";
}

function isVerifiedAllocation(allocation: QueryCostAttribution["allocations"][number]): boolean {
  return allocation.allocationPolicy === "first_claim"
    && allocation.epochId != null
    && allocation.proof != null
    && isVerifiedDecision(allocation.decision);
}

function isVerifiedDecision(decision: QueryCostAttribution["allocations"][number]["decision"]): boolean {
  return decision === "reportable" || decision === "rewrite_pending" || decision === "superseded";
}

function hasActiveFirstClaim(attribution: QueryCostAttribution): boolean {
  return attribution.allocations.some((allocation) =>
    allocation.allocationPolicy === "first_claim"
    && (allocation.status === "active" || allocation.status === "rewrite_pending")
  );
}

function allocationFromClaim(
  input: FirstClaimInput,
  attribution: QueryCostAttribution,
  queryId: string,
  verifiedAt: string
): QueryCostAttribution["allocations"][number] {
  return {
    episodeId: input.episode.episodeId,
    epochId: input.candidate.epochId,
    commitHash: input.candidate.commitHash,
    commitMessage: input.candidate.commitMessage,
    parentHashes: input.candidate.parentHashes,
    repoKey: input.candidate.repoKey,
    refKey: input.candidate.refKey,
    queryId,
    allocatedNanoUsd: attribution.estimatedNanoUsd,
    allocationPolicy: "first_claim",
    decision: "reportable",
    proof: proofForQuery(input.proof, queryId),
    coverage: attribution.costCoverage,
    evidenceReasons: uniqueStrings([...input.proof.reasonCodes, ...input.candidate.reasonCodes]),
    status: "active",
    verifiedAt,
    stateChangedAt: verifiedAt,
    createdAt: input.candidate.observedAt
  };
}

function proofForQuery(proof: NonNullable<QueryCostAttribution["allocations"][number]["proof"]>, queryId: string) {
  const { matchedCausalWriteArtifacts, ...base } = proof;
  // Direct allocations retain only pairs from their own query. An inherited
  // allocation depends on its direct anchor(s), so it retains those source
  // pairs instead. This prevents a sibling anchor's valid write from keeping a
  // rejected direct allocation alive.
  const scopedPairs = proof.inheritedQueryIds.includes(queryId)
    ? matchedCausalWriteArtifacts
    : matchedCausalWriteArtifacts?.filter((pair) => pair.queryId === queryId);
  const scoped = scopedPairs && scopedPairs.length > 0
    ? { matchedCausalWriteArtifacts: uniqueMatchedCausalWriteArtifacts(scopedPairs) }
    : {};
  return proof.inheritedQueryIds.includes(queryId)
    ? {
        ...base,
        ...scoped,
        kind: "episode_inheritance" as const,
        inheritedQueryIds: [queryId]
      }
    : {
        ...base,
        ...scoped,
        inheritedQueryIds: []
      };
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

function mergeEvidence(existing: QueryCostAttribution["evidence"], next: QueryCostAttribution["evidence"]): QueryCostAttribution["evidence"] {
  const byKey = new Map(existing.map((item) => [`${item.queryId}:${item.repoKey}`, item]));
  for (const item of next) {
    byKey.set(`${item.queryId}:${item.repoKey}`, item);
  }
  return [...byKey.values()];
}

function latestAttributionTimestamp(attribution: QueryCostAttribution): string {
  return [
    ...attribution.allocations.map((allocation) => allocation.createdAt),
    ...attribution.evidence.map((evidence) => evidence.completedAt ?? evidence.lastObservedAt ?? evidence.startedAt)
  ].sort().at(-1) ?? "";
}

function uniqueByQuery(items: Array<{ attribution: QueryCostAttribution; allocation: QueryCostAttribution["allocations"][number] }>): Array<{ attribution: QueryCostAttribution; allocation: QueryCostAttribution["allocations"][number] }> {
  const seen = new Set<string>();
  const unique: Array<{ attribution: QueryCostAttribution; allocation: QueryCostAttribution["allocations"][number] }> = [];
  for (const item of items) {
    if (seen.has(item.attribution.queryId)) {
      continue;
    }
    seen.add(item.attribution.queryId);
    unique.push(item);
  }
  return unique;
}

function sumOptionalNanoUsd(values: Array<number | undefined>): number | undefined {
  const reported = values.filter((value): value is number => value != null);
  return reported.length > 0 ? reported.reduce((sum, value) => sum + value, 0) : undefined;
}

function toCsv(summaries: CommitAttributionSummary[]): string {
  const columns: Array<[string, (summary: CommitAttributionSummary) => unknown]> = [
    ["Commit Hash", (summary) => summary.commitHash],
    ["Commit Message", (summary) => summary.commitMessage ?? ""],
    ["Repo Key", (summary) => summary.repoKey],
    ["Episode IDs", (summary) => summary.episodeIds.join("; ")],
    ["Query IDs", (summary) => summary.queryIds.join("; ")],
    ["Allocated Nano USD", (summary) => summary.allocatedNanoUsd ?? ""],
    ["Estimated USD", (summary) => summary.allocatedUsd ?? ""],
    ["Estimated AI Credits", (summary) => summary.allocatedAiCredits ?? ""],
    ["Coverage", (summary) => summary.coverage],
    ["Decision", (summary) => summary.decision],
    ["Proof Kinds", (summary) => summary.proofKinds.join("; ")],
    ["Anchor Query IDs", (summary) => summary.anchorQueryIds.join("; ")],
    ["Inherited Query IDs", (summary) => summary.inheritedQueryIds.join("; ")],
    ["Status", (summary) => summary.status],
    ["Evidence Reasons", (summary) => summary.evidenceReasons.join("; ")],
    ["Created At", (summary) => summary.createdAt]
  ];
  return [
    columns.map(([label]) => csvEscape(label)).join(","),
    ...summaries.map((summary) => columns.map(([, getter]) => csvEscape(getter(summary))).join(","))
  ].join("\n") + "\n";
}

function csvEscape(value: unknown): string {
  const raw = String(value ?? "");
  if (!/[",\n\r]/.test(raw)) {
    return raw;
  }
  return `"${raw.replace(/"/g, "\"\"")}"`;
}

async function writeAttributions(fileName: string, attributions: QueryCostAttribution[], privacyGuard: PrivacyGuard): Promise<void> {
  for (const attribution of attributions) {
    assertAttributionWritable(attribution, privacyGuard);
  }
  await fs.mkdir(path.dirname(fileName), { recursive: true });
  const tempPath = `${fileName}.tmp`;
  await fs.writeFile(tempPath, attributions.map((attribution) => JSON.stringify(attribution)).join("\n") + (attributions.length > 0 ? "\n" : ""), "utf8");
  await fs.rename(tempPath, fileName);
}

function assertAttributionWritable(attribution: QueryCostAttribution, privacyGuard: PrivacyGuard): void {
  const privacy = privacyGuard.validateAttribution(attribution);
  if (!privacy.ok) {
    throw new Error(`Attribution privacy violation: ${privacy.violations.join(", ")}`);
  }
  assertAttributionInvariants(attribution);
}

function assertAttributionInvariants(attribution: QueryCostAttribution): void {
  const activeFirstClaims = attribution.allocations.filter((allocation) =>
    allocation.allocationPolicy === "first_claim"
    && (allocation.status === "active" || allocation.status === "rewrite_pending")
  );
  if (activeFirstClaims.length > 1) {
    throw new Error(`Attribution invariant violation: query ${attribution.queryId} has multiple active first claims.`);
  }
  if (attribution.allocations.some((allocation) => allocation.queryId !== attribution.queryId)) {
    throw new Error(`Attribution invariant violation: allocation query ID does not match ${attribution.queryId}.`);
  }
  for (const allocation of activeFirstClaims) {
    if (allocation.allocatedNanoUsd != null && attribution.estimatedNanoUsd == null) {
      throw new Error(`Attribution invariant violation: query ${attribution.queryId} allocates unavailable cost.`);
    }
    if (
      allocation.allocatedNanoUsd != null
      && attribution.estimatedNanoUsd != null
      && allocation.allocatedNanoUsd > attribution.estimatedNanoUsd
    ) {
      throw new Error(`Attribution invariant violation: query ${attribution.queryId} allocation exceeds persisted query cost.`);
    }
    if (allocation.decision === "reportable" && (!allocation.epochId || !allocation.proof)) {
      throw new Error(`Attribution invariant violation: reportable query ${attribution.queryId} lacks epoch or proof.`);
    }
  }
}

function isQueryCostAttribution(value: unknown): value is QueryCostAttribution {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.queryId === "string"
    && Array.isArray(value.runIds)
    && typeof value.costCoverage === "string"
    && typeof value.status === "string"
    && Array.isArray(value.evidence)
    && Array.isArray(value.allocations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}
