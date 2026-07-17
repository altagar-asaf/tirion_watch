import type { AgentStorageClient } from "@tirion/agent-storage";
import {
  DefaultPrivacyGuard,
  StateBackedCommitAttributionLedger,
  type AgenticWorkEpisode,
  type PrivacyGuard,
  type QueryCostAttribution,
  type QueryWorkEvidence,
  type WorkEpisodeLedger,
  type WorkEpisodeQuery,
  type WorkspaceEvidenceLedger
} from "@tirion/engine/production";

export type CompletedRunTrackingState = {
  schemaVersion: 1;
  historicalCutoffAt: string;
  initializedAt: string;
  lastExplicitReconcileAt?: string;
};

export type CompletedRunTrackingRecord = {
  runId: string;
  queryId: string;
  completedAt: string;
  processedAt: string;
  outcome?: "processed" | "identity_deferred";
};

export class SqliteCommitAttributionLedger extends StateBackedCommitAttributionLedger {
  constructor(storage: AgentStorageClient, now: () => number = Date.now) {
    const privacy = new DefaultPrivacyGuard();
    super(
      async () => (await storage.listAgentDocuments<QueryCostAttribution>("query_attribution"))
        .map((document) => document.value),
      async (attributions) => {
        await storage.replaceAgentDocuments("query_attribution", attributions.map((attribution) => ({
          key: attribution.queryId,
          sortAt: latestAttributionTimestamp(attribution),
          value: attribution
        })));
      },
      privacy,
      now
    );
  }
}

export class SqliteWorkspaceEvidenceLedger implements WorkspaceEvidenceLedger {
  private readonly privacy: PrivacyGuard = new DefaultPrivacyGuard();

  constructor(private readonly storage: AgentStorageClient) {}

  async upsertEvidence(evidence: QueryWorkEvidence): Promise<void> {
    this.validate(evidence);
    const normalized = normalizeEvidence(evidence);
    await this.storage.upsertAgentDocument("workspace_evidence", {
      key: evidenceKey(normalized.queryId, normalized.repoKey),
      sortAt: normalized.lastObservedAt ?? normalized.completedAt ?? normalized.startedAt,
      value: normalized
    });
  }

  async listEvidence(query: {
    queryId?: string;
    repoKey?: string;
    status?: QueryWorkEvidence["status"];
  } = {}): Promise<QueryWorkEvidence[]> {
    return (await this.storage.listWorkspaceEvidenceDocuments<QueryWorkEvidence>(query))
      .map((document) => normalizeEvidence(document.value))
      .map((item) => structuredClone(item));
  }

  async removeEvidence(queryId: string, repoKey: string): Promise<void> {
    await this.storage.removeAgentDocument("workspace_evidence", evidenceKey(queryId, repoKey));
  }

  async applyRetention(retainedQueryIds: Set<string>): Promise<number> {
    const documents = await this.storage.listAgentDocuments<QueryWorkEvidence>("workspace_evidence");
    const retained = documents.filter((document) => retainedQueryIds.has(document.value.queryId));
    const removed = documents.length - retained.length;
    if (removed > 0) {
      await this.storage.replaceAgentDocuments("workspace_evidence", retained);
    }
    return removed;
  }

  async clear(): Promise<void> {
    await this.storage.clearAgentDocuments("workspace_evidence");
  }

  private validate(value: unknown): void {
    const result = this.privacy.validateAttribution(value);
    if (!result.ok) {
      throw new Error("privacy_violation");
    }
  }
}

export class SqliteWorkEpisodeLedger implements WorkEpisodeLedger {
  private readonly privacy: PrivacyGuard = new DefaultPrivacyGuard();

  constructor(private readonly storage: AgentStorageClient) {}

  async initialize(): Promise<number> {
    return 0;
  }

  async upsertEpisode(episode: AgenticWorkEpisode): Promise<void> {
    this.validate(episode);
    const normalized = normalizeEpisode(episode);
    await this.storage.upsertAgentDocument("work_episode", {
      key: normalized.episodeId,
      sortAt: normalized.lastAgentActivityAt,
      value: normalized
    });
  }

  async listEpisodes(query: WorkEpisodeQuery = {}): Promise<AgenticWorkEpisode[]> {
    const episodes = (await this.storage.listWorkEpisodeDocuments<AgenticWorkEpisode>(query))
      .map((document) => normalizeEpisode(document.value))
      .filter((episode) => matchesEpisode(episode, query))
      .sort((a, b) => b.lastAgentActivityAt.localeCompare(a.lastAgentActivityAt))
      .map((episode) => structuredClone(episode));
    return typeof query.limit === "number" ? episodes.slice(0, query.limit) : episodes;
  }

  async applyRetention(retentionDays = 180, retainedQueryIds?: Set<string>): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return 0;
    }
    const documents = await this.storage.listAgentDocuments<AgenticWorkEpisode>("work_episode");
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const retained = documents.filter((document) => retainedQueryIds
      ? document.value.queryIds.some((queryId) => retainedQueryIds.has(queryId))
      : new Date(document.value.lastAgentActivityAt).getTime() >= cutoff);
    const removed = documents.length - retained.length;
    if (removed > 0) {
      await this.storage.replaceAgentDocuments("work_episode", retained);
    }
    return removed;
  }

  async clear(): Promise<void> {
    await this.storage.clearAgentDocuments("work_episode");
  }

  private validate(value: unknown): void {
    const result = this.privacy.validateAttribution(value);
    if (!result.ok) {
      throw new Error("privacy_violation");
    }
  }
}

export class SqliteCompletedRunTrackingStore {
  constructor(private readonly storage: AgentStorageClient) {}

  async state(): Promise<CompletedRunTrackingState | undefined> {
    return (await this.storage.listAgentDocuments<CompletedRunTrackingState>("completed_run_tracking_state"))[0]?.value;
  }

  async ensureState(historicalCutoffAt: string): Promise<CompletedRunTrackingState> {
    const existing = await this.state();
    if (existing) {
      return existing;
    }
    const state: CompletedRunTrackingState = {
      schemaVersion: 1,
      historicalCutoffAt,
      initializedAt: historicalCutoffAt
    };
    await this.writeState(state);
    return state;
  }

  async writeState(state: CompletedRunTrackingState): Promise<void> {
    await this.storage.replaceAgentDocuments("completed_run_tracking_state", [{
      key: "live_first_state",
      sortAt: state.lastExplicitReconcileAt ?? state.initializedAt,
      value: state
    }]);
  }

  async listProcessedRuns(): Promise<CompletedRunTrackingRecord[]> {
    return (await this.storage.listAgentDocuments<CompletedRunTrackingRecord>("completed_run_tracking"))
      .map((document) => document.value);
  }

  async listProcessedRunIds(): Promise<Set<string>> {
    return new Set((await this.listProcessedRuns())
      .filter((item) => item.outcome !== "identity_deferred")
      .map((item) => item.runId));
  }

  async markProcessed(run: { runId: string; queryId: string; completedAt: string }, processedAt: string): Promise<void> {
    await this.storage.upsertAgentDocument("completed_run_tracking", {
      key: run.runId,
      sortAt: processedAt,
      value: {
        runId: run.runId,
        queryId: run.queryId,
        completedAt: run.completedAt,
        processedAt,
        outcome: "processed"
      }
    });
  }

  async markIdentityDeferred(run: { runId: string; queryId: string; completedAt: string }, deferredAt: string): Promise<void> {
    await this.storage.upsertAgentDocument("completed_run_tracking", {
      key: run.runId,
      sortAt: deferredAt,
      value: {
        runId: run.runId,
        queryId: run.queryId,
        completedAt: run.completedAt,
        processedAt: deferredAt,
        outcome: "identity_deferred"
      } satisfies CompletedRunTrackingRecord
    });
  }

  async markProcessedRuns(
    runs: { runId: string; queryId: string; completedAt: string }[],
    processedAt: string
  ): Promise<void> {
    for (const run of runs) {
      await this.markProcessed(run, processedAt);
    }
  }

  async applyRetention(retainedQueryIds: Set<string>): Promise<number> {
    const documents = await this.storage.listAgentDocuments<{
      runId: string;
      queryId: string;
      completedAt: string;
      processedAt: string;
    }>("completed_run_tracking");
    const retained = documents.filter((document) => retainedQueryIds.has(document.value.queryId));
    const removed = documents.length - retained.length;
    if (removed > 0) {
      await this.storage.replaceAgentDocuments("completed_run_tracking", retained);
    }
    return removed;
  }

  async clear(): Promise<void> {
    await Promise.all([
      this.storage.clearAgentDocuments("completed_run_tracking"),
      this.storage.clearAgentDocuments("completed_run_tracking_state")
    ]);
  }
}

function normalizeEvidence(evidence: QueryWorkEvidence): QueryWorkEvidence {
  return {
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
      : undefined,
    baselineArtifactStates: evidence.baselineArtifactStates?.map((item) => ({ ...item })),
    artifactStates: evidence.artifactStates?.map((item) => ({ ...item }))
  };
}

function uniqueCausalWriteArtifacts(
  artifacts: NonNullable<QueryWorkEvidence["causalWriteArtifacts"]>
): NonNullable<QueryWorkEvidence["causalWriteArtifacts"]> {
  const byPair = new Map<string, NonNullable<QueryWorkEvidence["causalWriteArtifacts"]>[number]>();
  for (const artifact of artifacts) {
    byPair.set(`${artifact.artifactKey}:${artifact.executionNodeId}`, artifact);
  }
  return [...byPair.values()].sort((left, right) =>
    left.artifactKey.localeCompare(right.artifactKey)
    || left.executionNodeId.localeCompare(right.executionNodeId)
  );
}

function normalizeEpisode(episode: AgenticWorkEpisode): AgenticWorkEpisode {
  const repoKeys = uniqueStrings(episode.repoKeys ?? (episode.repoKey ? [episode.repoKey] : []));
  return {
    ...episode,
    repoKey: repoKeys.length === 1 ? repoKeys[0] : undefined,
    repoKeys,
    epochIds: uniqueStrings(episode.epochIds ?? []),
    queryIds: uniqueStrings(episode.queryIds),
    runIds: uniqueStrings(episode.runIds),
    evidence: episode.evidence.map(normalizeEvidence),
    confidenceReasons: episode.confidenceReasons ? uniqueStrings(episode.confidenceReasons) : undefined
  };
}

function matchesEpisode(episode: AgenticWorkEpisode, query: WorkEpisodeQuery): boolean {
  if (query.episodeId && episode.episodeId !== query.episodeId) {
    return false;
  }
  if (query.repoKey && episode.repoKey !== query.repoKey && !(episode.repoKeys ?? []).includes(query.repoKey)) {
    return false;
  }
  if (query.commitHash && episode.claimedByCommitHash !== query.commitHash) {
    return false;
  }
  if (query.status && episode.status !== query.status) {
    return false;
  }
  if (query.queryId && !episode.queryIds.includes(query.queryId)) {
    return false;
  }
  if (query.runId && !episode.runIds.includes(query.runId)) {
    return false;
  }
  if (query.chatSessionId && episode.chatSessionId !== query.chatSessionId) {
    return false;
  }
  return !query.range
    || (episode.lastAgentActivityAt >= query.range.from && episode.lastAgentActivityAt <= query.range.to);
}

function evidenceKey(queryId: string, repoKey: string): string {
  return `${queryId}:${repoKey}`;
}

function latestAttributionTimestamp(attribution: QueryCostAttribution): string {
  return [
    ...attribution.allocations.map((allocation) => allocation.stateChangedAt ?? allocation.createdAt),
    ...attribution.evidence.map((evidence) => evidence.completedAt ?? evidence.lastObservedAt ?? evidence.startedAt)
  ].sort().at(-1) ?? new Date(0).toISOString();
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}
