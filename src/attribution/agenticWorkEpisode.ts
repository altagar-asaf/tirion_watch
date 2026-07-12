import { randomUUID } from "node:crypto";
import {
  AgenticQueryRun,
  AgenticWorkEpisode,
  AgenticWorkEpisodeTracker,
  DiagnosticEvent,
  PartialAgenticQueryRun,
  QueryWorkEvidence,
  WorkEpisodeLedger,
  WorkEpisodeQuery
} from "../types";

const DEFAULT_STALE_MS = 4 * 60 * 60 * 1000;

export class DefaultAgenticWorkEpisodeTracker implements AgenticWorkEpisodeTracker {
  private mutationQueue: Promise<void> = Promise.resolve();
  private running = false;

  constructor(
    private readonly ledger: WorkEpisodeLedger,
    private readonly recordEvent: (event: DiagnosticEvent) => void = () => undefined,
    private readonly staleMs = DEFAULT_STALE_MS,
    private readonly now: () => number = Date.now
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const compacted = await this.ledger.initialize();
    if (compacted > 0) {
      this.recordEvent({ kind: "attributionDecision", status: "skipped", reason: `episode_legacy_compacted_${compacted}` });
    }
    for (const episode of await this.ledger.listEpisodes({})) {
      if (episode.observationSchemaVersion === 1) {
        if (episode.status === "open" && isStale(episode, new Date(this.now()).toISOString(), this.staleMs)) {
          episode.status = "stale";
          episode.decision = "expired";
          await this.upsert(episode, "episode_stale");
        }
        continue;
      }
      episode.status = "expired";
      episode.decision = "legacy_unverified";
      await this.upsert(episode, "legacy_episode_quarantined");
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.mutationQueue;
  }

  async observeRun(run: PartialAgenticQueryRun): Promise<void> {
    return this.enqueueMutation(async () => {
      if (!run.queryId) {
        return;
      }
      const runTime = run.queryStartedAt ?? run.startedAt ?? new Date().toISOString();
      await this.markStaleOpenEpisodes(runTime);
      if (this.now() - new Date(runTime).getTime() > this.staleMs) {
        return;
      }
      const episode = await this.findOrCreateEpisode(run, runTime);
      const queryAlreadyTracked = episode.queryIds.includes(run.queryId);
      episode.queryIds = uniqueStrings([...episode.queryIds, run.queryId]);
      episode.runIds = uniqueStrings([...episode.runIds, run.id]);
      const queryActivityAt = run.endedAt ?? run.startedAt ?? run.queryStartedAt ?? runTime;
      episode.lastQueryActivityAt = maxIso(episode.lastQueryActivityAt ?? episode.lastAgentActivityAt, queryActivityAt);
      episode.lastAgentActivityAt = maxIso(episode.lastAgentActivityAt, queryActivityAt);
      if (episode.status !== "claimed" || !queryAlreadyTracked) {
        episode.decision = "pending_evidence";
      }
      await this.upsert(episode, "episode_extended");
    });
  }

  async observeRunCompleted(run: AgenticQueryRun): Promise<void> {
    await this.observeRun(run);
  }

  async observeWorkspaceEvidence(evidence: QueryWorkEvidence[]): Promise<void> {
    return this.enqueueMutation(async () => {
      if (evidence.length === 0) {
        return;
      }
      for (const item of evidence) {
        const episodes = await this.ledger.listEpisodes({ queryId: item.queryId });
        const episode = episodes.find((candidate) => candidate.queryIds.includes(item.queryId));
        if (!episode) {
          continue;
        }
        episode.evidence = mergeEvidence(
          episode.evidence.filter((existing) =>
            existing.queryId !== item.queryId
            || existing.repoKey !== item.repoKey
            || existing.epochId === item.epochId
          ),
          [item]
        );
        episode.runIds = uniqueStrings([...episode.runIds, ...item.runIds]);
        episode.repoKeys = uniqueStrings([...(episode.repoKeys ?? []), item.repoKey]);
        episode.epochIds = uniqueStrings(episode.evidence.map((existing) => existing.epochId).filter(isDefined));
        episode.repoKey = episode.repoKeys.length === 1 ? episode.repoKeys[0] : undefined;
        episode.headCommitAtStart ??= item.headCommitAtStart;
        episode.lastObservedChangeAt = maxIsoOptional(episode.lastObservedChangeAt, item.lastObservedAt ?? item.firstObservedAt);
        episode.lastAgentActivityAt = maxIso(episode.lastAgentActivityAt, item.completedAt ?? item.lastObservedAt ?? item.startedAt);
        episode.decision = "pending_evidence";
        await this.upsert(episode, "episode_evidence_bound");
      }
    });
  }

  listEpisodes(query: WorkEpisodeQuery = {}): Promise<AgenticWorkEpisode[]> {
    return this.ledger.listEpisodes(query);
  }

  async markClaimed(episodeId: string, commitHash: string, claimedAt: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const [episode] = await this.ledger.listEpisodes({ episodeId });
      if (!episode) {
        return;
      }
      episode.status = "claimed";
      episode.decision = "reportable";
      episode.claimedByCommitHash = commitHash;
      episode.claimedAt = claimedAt;
      await this.upsert(episode, "episode_claimed", commitHash);
    });
  }

  async reopenSupersededCommit(commitHash: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const episodes = await this.ledger.listEpisodes({ commitHash });
      for (const episode of episodes) {
        episode.status = "open";
        episode.decision = "rewrite_pending";
        episode.claimedByCommitHash = undefined;
        episode.claimedAt = undefined;
        await this.upsert(episode, "history_rewrite_pending", commitHash);
      }
    });
  }

  async reset(): Promise<void> {
    await this.enqueueMutation(() => this.ledger.clear());
  }

  private async findOrCreateEpisode(run: PartialAgenticQueryRun, runTime: string): Promise<AgenticWorkEpisode> {
    const sessionId = sessionGroupingId(run);
    const episodes = await this.ledger.listEpisodes(run.chatSessionId
      ? { chatSessionId: run.chatSessionId }
      : { queryId: run.queryId! });
    const existing = episodes.find((episode) =>
      (
        episode.status === "open"
        || (
          episode.status === "claimed"
          && (
            episode.queryIds.includes(run.queryId!)
            || episode.claimedAt == null
            || runTime <= episode.claimedAt
            || sameChatSession(episode, run)
          )
        )
      )
      && !isStale(episode, runTime, this.staleMs)
      && sessionGroupingIdFromEpisode(episode) === sessionId
    );
    if (existing) {
      return existing;
    }
    const episode: AgenticWorkEpisode = {
      observationSchemaVersion: 1,
      episodeId: randomUUID(),
      chatSessionId: run.chatSessionId,
      repoKeys: [],
      epochIds: [],
      queryIds: [run.queryId!],
      runIds: [run.id],
      startedAt: runTime,
      lastQueryActivityAt: runTime,
      lastAgentActivityAt: runTime,
      status: "open",
      decision: "pending_evidence",
      evidence: []
    };
    await this.upsert(episode, "episode_created");
    return episode;
  }

  private async markStaleOpenEpisodes(at: string): Promise<void> {
    for (const episode of await this.ledger.listEpisodes({ status: "open" })) {
      if (!isStale(episode, at, this.staleMs)) {
        continue;
      }
      episode.status = "stale";
      episode.decision = "expired";
      await this.upsert(episode, "episode_stale");
    }
  }

  private async upsert(episode: AgenticWorkEpisode, reason: string, commitHash?: string): Promise<void> {
    await this.ledger.upsertEpisode(episode);
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "AgenticWorkEpisode",
      operation: "episode",
      state: episode.status,
      reason,
      sessionId: episode.chatSessionId,
      episodeId: episode.episodeId,
      commitHash,
      details: {
        decision: episode.decision ?? "pending_evidence",
        queryCount: episode.queryIds.length,
        runCount: episode.runIds.length,
        repoCount: episode.repoKeys?.length ?? 0,
        evidenceCount: episode.evidence.length
      }
    });
    this.recordEvent({
      kind: "attributionDecision",
      episodeId: episode.episodeId,
      commitHash,
      status: episode.decision ?? "pending_evidence",
      reason
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function mergeEvidence(existing: QueryWorkEvidence[], next: QueryWorkEvidence[]): QueryWorkEvidence[] {
  const byQueryRepo = new Map(existing.map((evidence) => [evidenceKey(evidence), evidence]));
  for (const evidence of next) {
    const key = evidenceKey(evidence);
    const current = byQueryRepo.get(key);
    byQueryRepo.set(key, current ? mergeEvidenceRecord(current, evidence) : evidence);
  }
  return [...byQueryRepo.values()];
}

function evidenceKey(evidence: QueryWorkEvidence): string {
  return `${evidence.queryId}:${evidence.repoKey}:${evidence.epochId ?? "legacy"}`;
}

function sameChatSession(episode: AgenticWorkEpisode, run: PartialAgenticQueryRun): boolean {
  return episode.chatSessionId != null
    && run.chatSessionId != null
    && episode.chatSessionId === run.chatSessionId;
}

function mergeEvidenceRecord(a: QueryWorkEvidence, b: QueryWorkEvidence): QueryWorkEvidence {
  const artifactStates = mergeArtifactStates(a.artifactStates ?? [], b.artifactStates ?? []);
  return {
    ...a,
    ...b,
    runIds: uniqueStrings([...a.runIds, ...b.runIds]),
    baselineTrusted: a.baselineTrusted && b.baselineTrusted,
    baselineReasons: uniqueStrings([...a.baselineReasons, ...b.baselineReasons]),
    dirtyAtStart: a.dirtyAtStart || b.dirtyAtStart,
    observedChangeCount: artifactStates.length,
    artifactKeys: uniqueStrings([...a.artifactKeys, ...b.artifactKeys]),
    causalArtifactKeys: uniqueStrings([...(a.causalArtifactKeys ?? []), ...(b.causalArtifactKeys ?? [])]),
    artifactStates,
    addedLines: Math.max(a.addedLines, b.addedLines),
    deletedLines: Math.max(a.deletedLines, b.deletedLines),
    firstObservedAt: minIsoOptional(a.firstObservedAt, b.firstObservedAt),
    lastObservedAt: maxIsoOptional(a.lastObservedAt, b.lastObservedAt)
  };
}

function mergeArtifactStates(a: NonNullable<QueryWorkEvidence["artifactStates"]>, b: NonNullable<QueryWorkEvidence["artifactStates"]>) {
  const states = new Map(a.map((state) => [state.artifactKey, state]));
  for (const state of b) {
    states.set(state.artifactKey, state);
  }
  return [...states.values()];
}

function sessionGroupingId(run: PartialAgenticQueryRun): string {
  return run.chatSessionId ?? run.copilotSessionId ?? run.traceChatSessionId ?? run.queryId ?? run.traceId;
}

function sessionGroupingIdFromEpisode(episode: AgenticWorkEpisode): string {
  return episode.chatSessionId ?? episode.queryIds[0] ?? episode.episodeId;
}

function isStale(episode: AgenticWorkEpisode, at: string, staleMs: number): boolean {
  return new Date(at).getTime() - new Date(episode.lastAgentActivityAt).getTime() > staleMs;
}

function minIsoOptional(a: string | undefined, b: string | undefined): string | undefined {
  return [a, b].filter(isDefined).sort()[0];
}

function maxIsoOptional(a: string | undefined, b: string | undefined): string | undefined {
  return [a, b].filter(isDefined).sort().at(-1);
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}

function isDefined<T>(value: T | undefined): value is T {
  return value != null;
}
