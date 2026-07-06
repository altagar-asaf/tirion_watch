import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type {
  ExecutionNodeAtomV1,
  ProductionRunV1,
  QueryOccurrenceV1,
  SafeObservationV1
} from "@tirion/agent-contract";
import type { AgentStorageClient } from "@tirion/agent-storage";
import {
  type ArtifactStateEvidence,
  aiCreditsFromNanoUsd,
  type CommitAttributionChange,
  DefaultAgenticWorkEpisodeTracker,
  DefaultWorkspaceChangeTracker,
  DefaultGitAttribution,
  type AgenticQueryRun,
  type AgenticChatSessionGroup,
  type AgenticQueryGroup,
  type AgenticWorkEpisode,
  type CommitAttributionQuery,
  type CommitAttributionSummary,
  type CommitPublicationSnapshot,
  type DateRange,
  type DiagnosticEvent,
  type ExportResult,
  type GitAttribution,
  type PartialAgenticQueryRun,
  type QueryWorkEvidence,
  type RepositorySnapshotObservation,
  type RunLedger,
  type RunQuery,
  type UsageTotals,
  type WorkspaceChangeTracker,
  usdFromNanoUsd
} from "@tirion/engine/production";
import {
  SqliteCommitAttributionLedger,
  SqliteCompletedRunTrackingStore,
  SqliteWorkEpisodeLedger,
  SqliteWorkspaceEvidenceLedger
} from "./attributionStores";
import type { AgentRepositoryObservationService } from "./repositoryObservationService";

const SETTLING_MS = 2 * 60 * 1000;
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_RUN_STALE_MS = 4 * 60 * 60 * 1000;
const ACTIVE_OBSERVATION_POLL_MS = 250;

type RunObservationBoundary = {
  runId: string;
  queryId: string;
  sessionId?: string;
  provider?: ProductionRunV1["provider"];
  runtime?: string;
  startedAt: string;
  endedAt?: string;
};

export class AgentProductionRunAttribution implements WorkspaceChangeTracker {
  private readonly evidence: SqliteWorkspaceEvidenceLedger;
  private readonly episodes: SqliteWorkEpisodeLedger;
  private readonly episodeTracker: DefaultAgenticWorkEpisodeTracker;
  private workspaceTracker?: DefaultWorkspaceChangeTracker;
  private readonly evidenceBoundHandlers = new Set<() => Promise<void>>();
  private readonly runBoundaries = new Map<string, RunObservationBoundary>();
  private pending: QueryWorkEvidence[] = [];
  private running = false;

  constructor(
    private readonly storage: AgentStorageClient,
    private readonly repositories: AgentRepositoryObservationService,
    private readonly recordEvent: (event: DiagnosticEvent) => void = () => undefined,
    private readonly now: () => number = Date.now
  ) {
    this.evidence = new SqliteWorkspaceEvidenceLedger(storage);
    this.episodes = new SqliteWorkEpisodeLedger(storage);
    this.episodeTracker = new DefaultAgenticWorkEpisodeTracker(this.episodes, this.recordEvent, 4 * 60 * 60 * 1000, now);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    const observation = this.repositories.requireObservation();
    await this.episodeTracker.start();
    this.workspaceTracker = new DefaultWorkspaceChangeTracker(
      observation,
      this.evidence,
      this.recordEvent,
      async (evidence) => {
        await this.episodeTracker.observeWorkspaceEvidence(evidence);
        await this.notifyEvidenceBound();
      },
      SETTLING_MS,
      this.now
    );
    await this.workspaceTracker.start();
    this.pending = await this.evidence.listEvidence();
    if (this.pending.length > 0) {
      await this.episodeTracker.observeWorkspaceEvidence(this.pending);
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ProductionRunAttribution",
        operation: "startup_rebind",
        state: "completed",
        reason: "restored_workspace_evidence_rebound_to_episodes",
        details: {
          evidenceCount: this.pending.length,
          queryCount: new Set(this.pending.map((item) => item.queryId)).size,
          repoCount: new Set(this.pending.map((item) => item.repoKey)).size
        }
      });
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.workspaceTracker?.stop();
    this.workspaceTracker = undefined;
    await this.episodeTracker.stop();
  }

  async observeProductionRuns(runs: ProductionRunV1[]): Promise<void> {
    if (!this.running) {
      throw new Error("unsupported_capability");
    }
    this.rememberProductionRunBoundaries(runs);
    await this.repositories.refresh();
    for (const run of runs.filter(isCompletedProductionRun).sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      if (!hasWorkspaceAttributionIdentity(run)) {
        this.recordWorkspaceIdentityUnavailable(run, "observe_production_runs");
        continue;
      }
      const snapshots = await this.repositories.listSnapshots(configurableProviderForProductionRun(run.provider));
      const queryRun = productionRunForAttribution(run);
      await this.observeRunCompletedFromSnapshots(queryRun, snapshots);
      await this.augmentExecutionWriteEvidence(queryRun, snapshots);
    }
  }

  listEvidence(): Promise<QueryWorkEvidence[]> {
    return this.evidence.listEvidence();
  }

  listEpisodes(): Promise<AgenticWorkEpisode[]> {
    return this.episodes.listEpisodes();
  }

  workEpisodes(): DefaultAgenticWorkEpisodeTracker {
    return this.episodeTracker;
  }

  onWorkspaceEvidenceBound(handler: () => Promise<void>): () => void {
    this.evidenceBoundHandlers.add(handler);
    return () => this.evidenceBoundHandlers.delete(handler);
  }

  async observeRun(run: PartialAgenticQueryRun): Promise<void> {
    await this.observeRunStart(run);
    await this.augmentExecutionWriteEvidence(run, await this.repositories.listSnapshots());
  }

  async observeSafeObservation(observation: SafeObservationV1): Promise<void> {
    if (!this.running) {
      throw new Error("unsupported_capability");
    }
    const occurrences = (observation.queryOccurrences ?? [])
      .filter(hasOccurrenceWorkspaceIdentity)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const occurrence of occurrences) {
      const boundaryWasNew = this.rememberRunBoundary(boundaryFromOccurrence(occurrence));
      if (!boundaryWasNew) {
        continue;
      }
      await this.observeRunStart(partialRunFromOccurrence(occurrence));
    }
  }

  private async observeRunStart(run: PartialAgenticQueryRun): Promise<void> {
    this.rememberRunBoundary(boundaryFromAttributionRun(run));
    this.repositories.requestActiveObservationWindow(SETTLING_MS, ACTIVE_OBSERVATION_POLL_MS);
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ProductionRunAttribution",
      operation: "observe_run",
      state: "started",
      reason: "production_run_observed",
      runId: run.id,
      queryId: run.queryId,
      sessionId: run.chatSessionId,
      details: {
        activeObservationPollMs: ACTIVE_OBSERVATION_POLL_MS,
        settlingMs: SETTLING_MS
      }
    });
    await this.episodeTracker.observeRun(run);
    await this.requireWorkspaceTracker().observeRun(run);
  }

  async observeRunCompleted(run: AgenticQueryRun): Promise<void> {
    this.rememberRunBoundary(boundaryFromAttributionRun(run));
    this.repositories.requestActiveObservationWindow(SETTLING_MS, ACTIVE_OBSERVATION_POLL_MS);
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ProductionRunAttribution",
      operation: "observe_run_completed",
      state: "started",
      reason: "completed_run_observed",
      runId: run.id,
      queryId: run.queryId,
      sessionId: run.chatSessionId,
      details: {
        activeObservationPollMs: ACTIVE_OBSERVATION_POLL_MS,
        settlingMs: SETTLING_MS
      }
    });
    if (await this.hasTrackedEvidence(run.queryId)) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ProductionRunAttribution",
        operation: "observe_run_completed",
        state: "using_existing_evidence",
        reason: "completed_run_found_tracked_workspace_evidence",
        runId: run.id,
        queryId: run.queryId
      });
      await this.episodeTracker.observeRunCompleted(run);
      await this.requireWorkspaceTracker().observeRunCompleted(run);
      // Populate the episode with settling workspace evidence so that
      // bindRunToRepository can resolve the repo binding for runs (including
      // read-only ones) that were observed as inflight before completion.
      // For write runs this is idempotent — emitEvidence already does it.
      const settlingEvidence = await this.evidence.listEvidence({ queryId: run.queryId });
      if (settlingEvidence.length > 0) {
        await this.episodeTracker.observeWorkspaceEvidence(settlingEvidence);
      }
      const snapshots = await this.repositories.listSnapshots();
      await this.observeRunCompletedFromSnapshots(run, snapshots, { observeRunCompleted: false });
      await this.augmentExecutionWriteEvidence(run, snapshots);
      this.pending = await this.evidence.listEvidence();
      return;
    }
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ProductionRunAttribution",
      operation: "observe_run_completed",
      state: "refreshing_snapshots",
      reason: "completed_run_requires_repository_refresh",
      runId: run.id,
      queryId: run.queryId
    });
    await this.repositories.refresh();
    const snapshots = await this.repositories.listSnapshots();
    const assembled = await this.observeRunCompletedFromSnapshots(run, snapshots);
    this.recordWorkspaceAssemblyOutcome(run, snapshots, assembled);
    if (assembled.length === 0) {
      await this.requireWorkspaceTracker().observeRunCompleted(run);
      this.pending = await this.evidence.listEvidence();
    }
    await this.augmentExecutionWriteEvidence(run, snapshots);
  }

  pendingEvidence(): QueryWorkEvidence[] {
    return structuredClone(this.pending);
  }

  async resolveQueries(queryIds: string[]): Promise<void> {
    const targets = new Set(queryIds);
    for (const item of this.pending.filter((evidence) => targets.has(evidence.queryId))) {
      await this.evidence.removeEvidence(item.queryId, item.repoKey);
    }
    this.pending = this.pending.filter((item) => !targets.has(item.queryId));
  }

  async reset(): Promise<void> {
    await this.evidence.clear();
    await this.episodeTracker.reset();
    this.runBoundaries.clear();
    this.pending = [];
  }

  async applyRetention(retentionDays: number, retainedQueryIds: Set<string>): Promise<number> {
    const [evidenceRemoved, episodesRemoved] = await Promise.all([
      this.evidence.applyRetention(retainedQueryIds),
      this.episodes.applyRetention(retentionDays, retainedQueryIds)
    ]);
    this.pending = this.pending.filter((item) => retainedQueryIds.has(item.queryId));
    return evidenceRemoved + episodesRemoved;
  }

  private async observeRunCompletedFromSnapshots(
    run: AgenticQueryRun,
    snapshots: RepositorySnapshotObservation[],
    options: { observeRunCompleted?: boolean } = {}
  ): Promise<QueryWorkEvidence[]> {
    if (options.observeRunCompleted !== false) {
      await this.episodeTracker.observeRunCompleted(run);
    }
    const acceptingUntil = this.acceptingUntilForRun(run);
    const assembled = assembleWorkspaceEvidence(run, snapshots, this.now(), { acceptingUntil });
    for (const item of assembled) {
      await this.evidence.upsertEvidence(item);
      const index = this.pending.findIndex((existing) =>
        existing.queryId === item.queryId && existing.repoKey === item.repoKey);
      if (index >= 0) {
        this.pending[index] = item;
      } else {
        this.pending.push(item);
      }
    }
    if (assembled.length > 0) {
      await this.episodeTracker.observeWorkspaceEvidence(assembled);
    }
    return assembled;
  }

  private async augmentExecutionWriteEvidence(
    run: PartialAgenticQueryRun,
    snapshots: RepositorySnapshotObservation[]
  ): Promise<void> {
    const writes = await executionWriteEvidenceForQuery(run.queryId, this.storage, this.repositories);
    if (writes.length === 0) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ProductionRunAttribution",
        operation: "execution_write_evidence",
        state: "not_found",
        reason: "no_execution_write_evidence_for_query",
        runId: run.id,
        queryId: run.queryId
      });
      return;
    }
    const existing = await this.evidence.listEvidence({ queryId: run.queryId });
    const existingByRepo = new Map(existing.map((item) => [item.repoKey, item]));
    const augmented: QueryWorkEvidence[] = [];
    for (const write of writes) {
      const current = existingByRepo.get(write.repoKey);
      const next = current
        ? mergeExecutionWriteEvidence(current, write)
        : evidenceFromExecutionWrite(run, write, snapshots, this.now());
      if (current && next && sameEvidenceState(current, next)) {
        continue;
      }
      if (!next) {
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "ProductionRunAttribution",
          operation: "execution_write_evidence",
          state: "unbound",
          reason: "execution_write_evidence_could_not_bind_repository",
          runId: run.id,
          queryId: run.queryId,
          repoKey: write.repoKey
        });
        continue;
      }
      await this.evidence.upsertEvidence(next);
      existingByRepo.set(write.repoKey, next);
      const index = this.pending.findIndex((item) => item.queryId === next.queryId && item.repoKey === next.repoKey);
      if (index >= 0) {
        this.pending[index] = next;
      } else {
        this.pending.push(next);
      }
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ProductionRunAttribution",
        operation: "execution_write_evidence",
        state: current ? "merged" : "created",
        reason: current ? "execution_write_evidence_merged" : "execution_write_evidence_created",
        runId: run.id,
        queryId: run.queryId,
        repoKey: next.repoKey,
        epochId: next.epochId,
        commitHash: next.headCommitAtStart,
        details: {
          observedChangeCount: next.observedChangeCount,
          artifactCount: next.artifactStates?.length ?? 0,
          addedLines: next.addedLines,
          deletedLines: next.deletedLines
        }
      });
      augmented.push(next);
    }
    if (augmented.length === 0) {
      return;
    }
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ProductionRunAttribution",
      operation: "execution_write_evidence",
      state: "handoff_started",
      reason: "execution_write_evidence_handoff_started",
      runId: run.id,
      queryId: run.queryId,
      details: {
        evidenceCount: augmented.length
      }
    });
    await this.episodeTracker.observeWorkspaceEvidence(augmented);
    await this.notifyEvidenceBound();
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ProductionRunAttribution",
      operation: "execution_write_evidence",
      state: "handoff_completed",
      reason: "execution_write_evidence_handoff_completed",
      runId: run.id,
      queryId: run.queryId,
      details: {
        evidenceCount: augmented.length
      }
    });
  }

  private requireWorkspaceTracker(): DefaultWorkspaceChangeTracker {
    if (!this.workspaceTracker) {
      throw new Error("unsupported_capability");
    }
    return this.workspaceTracker;
  }

  private recordWorkspaceIdentityUnavailable(run: ProductionRunV1, operation: string): void {
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ProductionRunAttribution",
      operation,
      state: "blocked",
      reason: "production_run_workspace_identity_unavailable",
      runId: run.runId,
      queryId: run.queryId ?? run.correlationId,
      details: {
        provider: run.provider,
        runtime: run.runtime,
        promptState: run.promptState
      }
    });
  }

  private async hasTrackedEvidence(queryId: string): Promise<boolean> {
    return (await this.evidence.listEvidence({ queryId })).length > 0;
  }

  private recordWorkspaceAssemblyOutcome(
    run: AgenticQueryRun,
    snapshots: RepositorySnapshotObservation[],
    assembled: QueryWorkEvidence[]
  ): void {
    const analysis = analyzeWorkspaceEvidenceAssembly(run, snapshots, { acceptingUntil: this.acceptingUntilForRun(run) });
    if (assembled.length > 0) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ProductionRunAttribution",
        operation: "snapshot_assembly",
        state: "assembled",
        reason: "workspace_evidence_reconstructed_from_snapshots",
        runId: run.id,
        queryId: run.queryId,
        details: {
          repositoryCount: analysis.repositoryCount,
          baselineRepositoryCount: analysis.baselineRepositoryCount,
          eligibleSnapshotCount: analysis.eligibleSnapshotCount,
          changedRepositoryCount: analysis.changedRepositoryCount,
          evidenceCount: assembled.length
        }
      });
      return;
    }
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ProductionRunAttribution",
      operation: "snapshot_assembly",
      state: "no_evidence",
      reason: analysis.reason,
      runId: run.id,
      queryId: run.queryId,
      severity: "warning",
      details: {
        repositoryCount: analysis.repositoryCount,
        baselineRepositoryCount: analysis.baselineRepositoryCount,
        repositoriesWithoutBaseline: analysis.repositoriesWithoutBaseline,
        eligibleSnapshotCount: analysis.eligibleSnapshotCount,
        postRunSnapshotCount: analysis.postRunSnapshotCount,
        changedRepositoryCount: analysis.changedRepositoryCount
      }
    });
  }

  private async notifyEvidenceBound(): Promise<void> {
    for (const handler of this.evidenceBoundHandlers) {
      await handler();
    }
  }

  rememberProductionRunBoundaries(runs: ProductionRunV1[]): void {
    for (const run of runs.filter((candidate) => hasWorkspaceAttributionIdentity(candidate))) {
      this.rememberRunBoundary(boundaryFromProductionRun(run));
    }
  }

  private rememberRunBoundary(boundary: RunObservationBoundary | undefined): boolean {
    if (!boundary || !isFiniteIso(boundary.startedAt)) {
      return false;
    }
    const key = boundary.queryId;
    const existing = this.runBoundaries.get(key);
    if (!existing) {
      this.runBoundaries.set(key, boundary);
      return true;
    }
    const next: RunObservationBoundary = {
      ...existing,
      ...boundary,
      startedAt: earliestIso([existing.startedAt, boundary.startedAt]),
      endedAt: latestIsoOptional([existing.endedAt, boundary.endedAt]),
      sessionId: existing.sessionId ?? boundary.sessionId,
      provider: existing.provider ?? boundary.provider,
      runtime: existing.runtime ?? boundary.runtime
    };
    this.runBoundaries.set(key, next);
    return false;
  }

  private acceptingUntilForRun(run: AgenticQueryRun): string {
    const defaultAcceptingUntil = defaultAcceptingUntilForRun(run, this.now());
    const nextStart = nextRunStartedAt(run, [...this.runBoundaries.values()]);
    return earliestIso([defaultAcceptingUntil, nextStart].filter((value): value is string => Boolean(value)));
  }
}

export class AgentVerifiedAttributionService {
  private readonly workspace: AgentProductionRunAttribution;
  private readonly gitAttribution: GitAttribution;
  private readonly ledger: SqliteCommitAttributionLedger;
  private readonly completedRuns: SqliteCompletedRunTrackingStore;

  constructor(
    storage: AgentStorageClient,
    repositories: AgentRepositoryObservationService,
    private readonly recordEvent: (event: DiagnosticEvent) => void = () => undefined,
    private readonly now: () => number = Date.now
  ) {
    this.workspace = new AgentProductionRunAttribution(storage, repositories, recordEvent, now);
    this.ledger = new SqliteCommitAttributionLedger(storage, now);
    this.completedRuns = new SqliteCompletedRunTrackingStore(storage);
    this.gitAttribution = new DefaultGitAttribution(
      repositories.requireObservation(),
      this.workspace.workEpisodes(),
      this.workspace,
      new AgentProductionRunLedger(storage),
      this.ledger,
      recordEvent,
      now
    );
    this.workspace.onWorkspaceEvidenceBound(() => this.gitAttribution.reconcile());
  }

  async start(): Promise<void> {
    await this.workspace.start();
    await this.gitAttribution.start();
  }

  async stop(): Promise<void> {
    await this.gitAttribution.stop();
    await this.workspace.stop();
  }

  async prepareLiveProcessing(historicalCutoffAt: string): Promise<void> {
    await this.completedRuns.ensureState(historicalCutoffAt);
  }

  async observeCompletedRunsIncrementally(runs: ProductionRunV1[]): Promise<{
    processedCount: number;
    deferredCount: number;
    processedRuns: ProductionRunV1[];
  }> {
    const state = await this.completedRuns.state();
    const processed = new Map((await this.completedRuns.listProcessedRuns()).map((item) => [item.runId, item]));
    const completed = runs.filter(isCompletedProductionRun).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    this.workspace.rememberProductionRunBoundaries(runs);
    let processedCount = 0;
    let deferredCount = 0;
    const processedRuns: ProductionRunV1[] = [];
    for (const run of completed) {
      const existing = processed.get(run.runId);
      if (existing && existing.completedAt >= run.endedAt!) {
        continue;
      }
      if (state?.historicalCutoffAt && run.endedAt != null && run.endedAt < state.historicalCutoffAt) {
        deferredCount += 1;
        continue;
      }
      if (!hasWorkspaceAttributionIdentity(run)) {
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "ProductionRunAttribution",
          operation: "completed_run_tracking",
          state: "deferred",
          reason: "production_run_workspace_identity_unavailable",
          runId: run.runId,
          queryId: run.queryId ?? run.correlationId
        });
        deferredCount += 1;
        continue;
      }
      if (existing && existing.completedAt < run.endedAt!) {
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "ProductionRunAttribution",
          operation: "completed_run_tracking",
          state: "reprocessing_advanced_completion",
          reason: "completed_run_advanced_after_prior_processing",
          runId: run.runId,
          queryId: run.queryId ?? run.correlationId,
          details: {
            previousCompletedAt: existing.completedAt,
            advancedCompletedAt: run.endedAt!,
            previousProcessedAt: existing.processedAt
          }
        });
      }
      await this.workspace.observeRunCompleted(productionRunForAttribution(run));
      await this.completedRuns.markProcessed({
        runId: run.runId,
        queryId: run.queryId ?? run.correlationId,
        completedAt: run.endedAt!
      }, new Date(this.now()).toISOString());
      processed.set(run.runId, {
        runId: run.runId,
        queryId: run.queryId ?? run.correlationId,
        completedAt: run.endedAt!,
        processedAt: new Date(this.now()).toISOString()
      });
      processedCount += 1;
      processedRuns.push(run);
    }
    if (processedCount > 0) {
      await this.gitAttribution.reconcilePersistedState();
    }
    return { processedCount, deferredCount, processedRuns };
  }

  async observeProductionRuns(runs: ProductionRunV1[]): Promise<void> {
    this.workspace.rememberProductionRunBoundaries(runs);
    const completed = runs
      .filter(isCompletedProductionRun)
      .filter((run) => hasWorkspaceAttributionIdentity(run))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    await this.workspace.observeProductionRuns(completed);
    await this.completedRuns.markProcessedRuns(
      completed.map((run) => ({
        runId: run.runId,
        queryId: run.queryId ?? run.correlationId,
        completedAt: run.endedAt!
      })),
      new Date(this.now()).toISOString()
    );
    const state = await this.completedRuns.state();
    if (state) {
      await this.completedRuns.writeState({
        ...state,
        lastExplicitReconcileAt: new Date(this.now()).toISOString()
      });
    }
    await this.gitAttribution.reconcilePersistedState();
  }

  async observeCurrentRuns(runs: ProductionRunV1[]): Promise<void> {
    this.workspace.rememberProductionRunBoundaries(runs);
    const activeCutoff = this.now() - ACTIVE_RUN_STALE_MS;
    for (const run of runs
      .filter((item) => !isCompletedProductionRun(item) && Date.parse(item.startedAt) > activeCutoff)
      .filter((item) => hasWorkspaceAttributionIdentity(item))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      await this.workspace.observeRun(productionRunForAttribution(run));
    }
  }

  listCommitAttributions(query: CommitAttributionQuery = {}): Promise<CommitAttributionSummary[]> {
    return this.gitAttribution.listCommitAttributions(query);
  }

  async observeSafeObservation(observation: SafeObservationV1): Promise<void> {
    await this.workspace.observeSafeObservation(observation);
  }

  listCommitPublicationSnapshots(query: CommitAttributionQuery = {}): Promise<CommitPublicationSnapshot[]> {
    return this.gitAttribution.listCommitPublicationSnapshots(query);
  }

  listWorkspaceEvidence(): Promise<QueryWorkEvidence[]> {
    return this.workspace.listEvidence();
  }

  listWorkEpisodes(): Promise<AgenticWorkEpisode[]> {
    return this.workspace.listEpisodes();
  }

  export(format: "json" | "csv", query: CommitAttributionQuery = {}): Promise<ExportResult> {
    return this.gitAttribution.export(format, query);
  }

  async reset(): Promise<void> {
    await this.gitAttribution.reset();
    await Promise.all([
      this.workspace.reset(),
      this.completedRuns.clear()
    ]);
  }

  async applyRetention(retentionDays: number, retainedQueryIds: Set<string>): Promise<number> {
    const [workspaceRemoved, attributionRemoved, completedRemoved] = await Promise.all([
      this.workspace.applyRetention(retentionDays, retainedQueryIds),
      this.ledger.applyRetention(retentionDays, retainedQueryIds),
      this.completedRuns.applyRetention(retainedQueryIds)
    ]);
    return workspaceRemoved + attributionRemoved + completedRemoved;
  }

  runtime(): GitAttribution {
    return this.gitAttribution;
  }

  onDidChange(handler: (change: CommitAttributionChange) => void): () => void {
    return this.gitAttribution.onDidChange(handler);
  }

  onWorkspaceEvidenceBound(handler: () => Promise<void>): () => void {
    return this.workspace.onWorkspaceEvidenceBound(handler);
  }

  async historicalStatus(runs: ProductionRunV1[]): Promise<{
    historicalCutoffAt?: string;
    processedCompletedRunCount: number;
    deferredCompletedRunCount: number;
  }> {
    const state = await this.completedRuns.state();
    const processed = await this.completedRuns.listProcessedRunIds();
    const completed = runs.filter(isCompletedProductionRun);
    return {
      historicalCutoffAt: state?.historicalCutoffAt,
      processedCompletedRunCount: completed.filter((run) => processed.has(run.runId)).length,
      deferredCompletedRunCount: completed.filter((run) =>
        !processed.has(run.runId)
        && state?.historicalCutoffAt != null
        && run.endedAt != null
        && run.endedAt < state.historicalCutoffAt
      ).length
    };
  }
}

class AgentProductionRunLedger implements RunLedger {
  constructor(private readonly storage: AgentStorageClient) {}

  append(): Promise<void> {
    return Promise.reject(new Error("ownership_conflict"));
  }

  async list(query: RunQuery = {}): Promise<AgenticQueryRun[]> {
    const runs = (await this.storage.listProductionRuns()).map(productionRunForAttribution)
      .filter((run) => !query.queryId || run.queryId === query.queryId)
      .filter((run) => !query.model || run.models.includes(query.model))
      .filter((run) => !query.status || run.status === query.status)
      .filter((run) => !query.range || (run.startedAt >= query.range.from && run.startedAt <= query.range.to))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return typeof query.limit === "number" ? runs.slice(0, query.limit) : runs;
  }

  async listQueryGroups(query: RunQuery = {}): Promise<AgenticQueryGroup[]> {
    return (await this.list(query)).map(queryGroup);
  }

  async listChatSessionGroups(query: RunQuery = {}): Promise<AgenticChatSessionGroup[]> {
    return (await this.listQueryGroups(query)).map((group) => ({
      chatSessionId: group.chatSessionId ?? group.queryId,
      startedAt: group.startedAt,
      endedAt: group.endedAt,
      durationMs: group.durationMs,
      queryCount: 1,
      runCount: 1,
      models: group.models,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      cacheReadInputTokens: group.cacheReadInputTokens,
      cacheCreationInputTokens: group.cacheCreationInputTokens,
      reasoningOutputTokens: group.reasoningOutputTokens,
      totalTokens: group.totalTokens,
      tokenSources: group.tokenSources,
      estimatedNanoUsd: group.estimatedNanoUsd,
      estimatedUsd: group.estimatedUsd,
      estimatedAiCredits: group.estimatedAiCredits,
      costCoverage: group.costCoverage,
      costLabel: group.costLabel,
      queries: [group],
      warnings: group.warnings
    }));
  }

  async totals(range: DateRange): Promise<UsageTotals> {
    const runs = await this.list({ range });
    const estimatedNanoUsd = runs.reduce((total, run) => total + (run.estimatedNanoUsd ?? 0), 0);
    return {
      runCount: runs.length,
      inputTokens: sumRuns(runs, "inputTokens"),
      outputTokens: sumRuns(runs, "outputTokens"),
      reasoningOutputTokens: sumRuns(runs, "reasoningOutputTokens"),
      cachedTokens: sumRuns(runs, "cachedTokens"),
      totalTokens: sumRuns(runs, "totalTokens"),
      tokenSources: [...new Set(runs.map((run) => run.tokenUsageSource))],
      estimatedNanoUsd,
      estimatedUsd: usdFromNanoUsd(estimatedNanoUsd) ?? 0,
      estimatedAiCredits: aiCreditsFromNanoUsd(estimatedNanoUsd) ?? 0,
      costCoverage: runs.every((run) => run.costCoverage === "complete") ? "complete" : "partial"
    };
  }

  async export(format: "json" | "csv", query: RunQuery = {}): Promise<ExportResult> {
    const groups = await this.listQueryGroups(query);
    return {
      format,
      content: format === "json" ? `${JSON.stringify(groups, null, 2)}\n` : "",
      count: groups.length
    };
  }
}

export function productionRunForAttribution(run: ProductionRunV1): AgenticQueryRun {
  const models = [...new Set(run.models ?? (run.model ? [run.model] : []))];
  const modelUsages = run.model ? [{
    model: run.model,
    provider: run.provider,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadInputTokens: run.cacheReadInputTokens,
    cacheCreationInputTokens: run.cacheCreationInputTokens,
    reasoningOutputTokens: run.reasoningOutputTokens,
    totalTokens: run.totalTokens,
    estimatedNanoUsd: run.estimatedNanoUsd,
    estimatedUsd: usdFromNanoUsd(run.estimatedNanoUsd),
    pricingVersion: run.pricingVersion,
    notes: []
  }] : [];
  const tools = (run.breakdown ?? [])
    .filter((item) => ["tool", "subagent", "skill", "mcp"].includes(item.kind))
    .map((item) => ({
      name: item.name,
      count: item.count,
      failures: item.failureCount,
      totalDurationMs: item.totalDurationMs,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheReadInputTokens: item.cacheReadInputTokens,
      cacheCreationInputTokens: item.cacheCreationInputTokens,
      reasoningOutputTokens: item.reasoningOutputTokens,
      totalTokens: item.totalTokens
    }));
  return {
    schemaVersion: 2,
    id: run.runId,
    traceId: run.correlationId,
    queryId: run.queryId ?? run.correlationId,
    queryStartedAt: run.startedAt,
    chatSessionId: run.sessionId ?? `${run.provider}:${run.correlationId}`,
    traceRole: "main",
    initialQueryState: "unavailable",
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.endedAt ? Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)) : undefined,
    status: isCompletedProductionRun(run) ? "completed" : "running",
    serviceName: run.runtime,
    mode: run.provider === "codex" ? "cli" : run.provider === "claude-code" ? "claude" : "agent",
    models,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadInputTokens: run.cacheReadInputTokens,
    cacheCreationInputTokens: run.cacheCreationInputTokens,
    reasoningOutputTokens: run.reasoningOutputTokens,
    totalTokens: run.totalTokens,
    estimatedNanoUsd: run.estimatedNanoUsd,
    estimatedUsd: usdFromNanoUsd(run.estimatedNanoUsd),
    estimatedAiCredits: aiCreditsFromNanoUsd(run.estimatedNanoUsd),
    pricingVersion: run.pricingVersion,
    billingContext: run.billingContext === "unknown" || run.billingContext === "subscription"
      ? undefined
      : run.billingContext,
    tokenUsageSource: tokenUsageSource(run),
    costCoverage: run.costCoverage,
    modelUsages,
    llmCallCount: 1,
    toolCallCount: run.toolCallCount ?? tools.reduce((sum, tool) => sum + tool.count, 0),
    tools,
    warnings: [...run.warnings]
  };
}

function isCompletedProductionRun(run: ProductionRunV1): boolean {
  return Boolean(run.endedAt && run.endedAt >= run.startedAt);
}

function hasWorkspaceAttributionIdentity(run: ProductionRunV1): boolean {
  return run.promptState !== "unavailable";
}

function configurableProviderForProductionRun(provider: ProductionRunV1["provider"]): "claude-code" | "codex" | undefined {
  return provider === "claude-code" || provider === "codex" ? provider : undefined;
}

function boundaryFromProductionRun(run: ProductionRunV1): RunObservationBoundary {
  return {
    runId: run.runId,
    queryId: run.queryId ?? run.correlationId,
    sessionId: run.sessionId,
    provider: run.provider,
    runtime: run.runtime,
    startedAt: run.startedAt,
    endedAt: run.endedAt
  };
}

function boundaryFromAttributionRun(run: PartialAgenticQueryRun): RunObservationBoundary | undefined {
  const startedAt = run.queryStartedAt ?? run.startedAt;
  if (!startedAt) {
    return undefined;
  }
  return {
    runId: run.id,
    queryId: run.queryId,
    sessionId: run.chatSessionId ?? run.sessionId,
    provider: providerFromAttributionRun(run),
    runtime: run.serviceName,
    startedAt,
    endedAt: run.endedAt
  };
}

function boundaryFromOccurrence(occurrence: QueryOccurrenceV1): RunObservationBoundary {
  return {
    runId: runIdForQuery(occurrence.queryId),
    queryId: occurrence.queryId,
    sessionId: occurrence.sessionId,
    provider: occurrence.provider,
    runtime: occurrence.runtime,
    startedAt: occurrence.startedAt
  };
}

function partialRunFromOccurrence(occurrence: QueryOccurrenceV1): PartialAgenticQueryRun {
  return {
    schemaVersion: 2,
    id: runIdForQuery(occurrence.queryId),
    traceId: occurrence.queryId,
    queryId: occurrence.queryId,
    queryStartedAt: occurrence.startedAt,
    chatSessionId: occurrence.sessionId,
    traceRole: "main",
    initialQueryState: occurrence.promptState === "captured" ? "captured" : "unavailable",
    startedAt: occurrence.startedAt,
    status: "running",
    serviceName: occurrence.runtime,
    mode: occurrence.provider === "codex" ? "cli" : occurrence.provider === "claude-code" ? "claude" : "agent",
    models: [],
    tokenUsageSource: "not_reported",
    costCoverage: "unavailable",
    modelUsages: [],
    llmCallCount: 0,
    toolCallCount: 0,
    tools: [],
    warnings: []
  };
}

function hasOccurrenceWorkspaceIdentity(occurrence: QueryOccurrenceV1): boolean {
  return occurrence.promptState !== "unavailable";
}

function runIdForQuery(queryId: string): string {
  return queryId.startsWith("qry_")
    ? `run_${queryId.slice(4)}`
    : `run_${createHash("sha256").update(queryId).digest("hex").slice(0, 32)}`;
}

function providerFromAttributionRun(run: PartialAgenticQueryRun | AgenticQueryRun): ProductionRunV1["provider"] | undefined {
  if (run.mode === "claude") {
    return "claude-code";
  }
  if (run.mode === "cli") {
    return "codex";
  }
  if (run.serviceName === "claude-code" || run.serviceName === "codex") {
    return run.serviceName;
  }
  return undefined;
}

function defaultAcceptingUntilForRun(run: AgenticQueryRun, now: number): string {
  const end = Date.parse(run.endedAt ?? run.startedAt);
  return new Date((Number.isFinite(end) ? end : now) + SETTLING_MS).toISOString();
}

function nextRunStartedAt(run: AgenticQueryRun, boundaries: RunObservationBoundary[]): string | undefined {
  const currentStart = Date.parse(run.startedAt);
  const currentEnd = Date.parse(run.endedAt ?? run.startedAt);
  if (!Number.isFinite(currentStart) || !Number.isFinite(currentEnd)) {
    return undefined;
  }
  const currentProvider = providerFromAttributionRun(run);
  return boundaries
    .filter((boundary) => boundary.queryId !== run.queryId)
    .filter((boundary) => !currentProvider || !boundary.provider || boundary.provider === currentProvider)
    .map((boundary) => boundary.startedAt)
    .filter((startedAt) => {
      const started = Date.parse(startedAt);
      return Number.isFinite(started)
        && started > currentStart
        && started >= currentEnd;
    })
    .sort()[0];
}

export function assembleWorkspaceEvidence(
  run: AgenticQueryRun,
  snapshots: RepositorySnapshotObservation[],
  now: number,
  options: { acceptingUntil?: string } = {}
): QueryWorkEvidence[] {
  const end = Date.parse(run.endedAt ?? run.startedAt);
  const acceptingUntil = options.acceptingUntil ?? new Date(end + SETTLING_MS).toISOString();
  const byRepo = new Map<string, RepositorySnapshotObservation[]>();
  for (const snapshot of snapshots) {
    byRepo.set(snapshot.repoKey, [...(byRepo.get(snapshot.repoKey) ?? []), snapshot]);
  }
  const evidence: QueryWorkEvidence[] = [];
  for (const repoSnapshots of byRepo.values()) {
    const ordered = repoSnapshots.sort((a, b) => a.observedSequence - b.observedSequence);
    const baseline = ordered
      .filter((snapshot) => snapshot.observedAt <= run.startedAt)
      .at(-1);
    if (!baseline) {
      continue;
    }
    const baselineByArtifact = new Map(baseline.artifactStates.map((state) => [state.artifactKey, state]));
    const changed = new Map<string, RepositorySnapshotObservation["artifactStates"][number]>();
    let firstObservedAt: string | undefined;
    let lastObservedAt: string | undefined;
    for (const snapshot of ordered) {
      if (
        snapshot.epochId !== baseline.epochId
        || snapshot.observedSequence <= baseline.observedSequence
        || snapshot.observedAt > acceptingUntil
      ) {
        continue;
      }
      for (const state of snapshot.artifactStates) {
        if (sameArtifactState(baselineByArtifact.get(state.artifactKey), state)) {
          continue;
        }
        changed.set(state.artifactKey, state);
        firstObservedAt ??= snapshot.observedAt;
        lastObservedAt = snapshot.observedAt;
      }
    }
    if (changed.size === 0) {
      continue;
    }
    const artifactStates = [...changed.values()].sort((a, b) => a.artifactKey.localeCompare(b.artifactKey));
    evidence.push({
      queryId: run.queryId,
      runIds: [run.id],
      repoKey: baseline.repoKey,
      epochId: baseline.epochId,
      startedAt: run.startedAt,
      completedAt: run.endedAt ?? run.startedAt,
      settlingUntil: acceptingUntil,
      expiresAt: new Date(Math.max(now, end) + EVIDENCE_TTL_MS).toISOString(),
      baselineTrusted: baseline.dirtyKnown,
      baselineReasons: baseline.dirtyKnown
        ? baseline.dirty ? ["dirty_baseline_known"] : ["clean_baseline"]
        : ["dirty_state_unknown"],
      headCommitAtStart: baseline.headCommit,
      baselineSequence: baseline.observedSequence,
      dirtyAtStart: baseline.dirty,
      observedChangeCount: artifactStates.length,
      artifactKeys: artifactStates.map((state) => state.artifactKey),
      baselineArtifactStates: baseline.artifactStates.map((state) => ({ ...state })),
      artifactStates,
      addedLines: 0,
      deletedLines: 0,
      firstObservedAt,
      lastObservedAt,
      status: "completed"
    });
  }
  return evidence;
}

function analyzeWorkspaceEvidenceAssembly(
  run: AgenticQueryRun,
  snapshots: RepositorySnapshotObservation[],
  options: { acceptingUntil?: string } = {}
): {
  reason: string;
  repositoryCount: number;
  baselineRepositoryCount: number;
  repositoriesWithoutBaseline: number;
  eligibleSnapshotCount: number;
  postRunSnapshotCount: number;
  changedRepositoryCount: number;
} {
  const end = Date.parse(run.endedAt ?? run.startedAt);
  const acceptingUntil = options.acceptingUntil ?? new Date(end + SETTLING_MS).toISOString();
  const byRepo = new Map<string, RepositorySnapshotObservation[]>();
  for (const snapshot of snapshots) {
    byRepo.set(snapshot.repoKey, [...(byRepo.get(snapshot.repoKey) ?? []), snapshot]);
  }
  let baselineRepositoryCount = 0;
  let repositoriesWithoutBaseline = 0;
  let eligibleSnapshotCount = 0;
  let postRunSnapshotCount = 0;
  let changedRepositoryCount = 0;
  for (const repoSnapshots of byRepo.values()) {
    const ordered = repoSnapshots.sort((a, b) => a.observedSequence - b.observedSequence);
    const baseline = ordered.filter((snapshot) => snapshot.observedAt <= run.startedAt).at(-1);
    if (!baseline) {
      repositoriesWithoutBaseline += 1;
      continue;
    }
    baselineRepositoryCount += 1;
    const baselineByArtifact = new Map(baseline.artifactStates.map((state) => [state.artifactKey, state]));
    let repoChanged = false;
    for (const snapshot of ordered) {
      if (snapshot.observedSequence <= baseline.observedSequence || snapshot.epochId !== baseline.epochId) {
        continue;
      }
      if (snapshot.observedAt <= acceptingUntil) {
        eligibleSnapshotCount += 1;
      }
      if (snapshot.observedAt > run.startedAt && snapshot.observedAt <= acceptingUntil) {
        postRunSnapshotCount += 1;
      }
      if (snapshot.observedAt > acceptingUntil) {
        continue;
      }
      for (const state of snapshot.artifactStates) {
        if (!sameArtifactState(baselineByArtifact.get(state.artifactKey), state)) {
          repoChanged = true;
          break;
        }
      }
      if (repoChanged) {
        changedRepositoryCount += 1;
        break;
      }
    }
  }
  const reason = baselineRepositoryCount === 0
    ? "no_baseline_before_run"
    : postRunSnapshotCount === 0
      ? "no_post_start_snapshots_in_settling_window"
      : changedRepositoryCount === 0
        ? "no_post_start_artifact_delta"
        : "workspace_evidence_unbound";
  return {
    reason,
    repositoryCount: byRepo.size,
    baselineRepositoryCount,
    repositoriesWithoutBaseline,
    eligibleSnapshotCount,
    postRunSnapshotCount,
    changedRepositoryCount
  };
}

function tokenUsageSource(run: ProductionRunV1): AgenticQueryRun["tokenUsageSource"] {
  if (run.authority === "run") {
    return "invoke_agent";
  }
  if (run.authority === "event") {
    return "events";
  }
  return "chat_spans";
}

type ExecutionWriteEvidence = {
  queryId: string;
  repoKey: string;
  observedAt: string;
  artifactStates: ArtifactStateEvidence[];
};

async function executionWriteEvidenceForQuery(
  queryId: string,
  storage: AgentStorageClient,
  repositories: AgentRepositoryObservationService
): Promise<ExecutionWriteEvidence[]> {
  const [nodes, knownRepositories] = await Promise.all([
    storage.listAgentDocuments<ExecutionNodeAtomV1>("execution_node_atom"),
    repositories.listRepositories()
  ]);
  const byRepo = new Map<string, ExecutionWriteEvidence>();
  const sortedRepositories = knownRepositories
    .map((repo) => ({ repoKey: repo.repoKey, root: canonicalPath(repo.root) }))
    .sort((a, b) => b.root.length - a.root.length);
  for (const node of nodes
    .map((document) => document.value)
    .filter((item) =>
      item.queryId === queryId
      && item.nodeKind === "tool"
      && (item.toolName === "Write" || item.toolName === "Edit")
      && item.outcome === "success"
    )) {
    for (const content of node.contents ?? []) {
      if (content.kind !== "tool_input" || content.visibility !== "visible" || !content.text) {
        continue;
      }
      const payload = parseExecutionToolInput(content.text);
      if (!payload || typeof payload.file_path !== "string") {
        continue;
      }
      const absolute = canonicalPath(payload.file_path);
      const repository = sortedRepositories.find((candidate) =>
        absolute === candidate.root || absolute.startsWith(`${candidate.root}${path.sep}`)
      );
      if (!repository) {
        continue;
      }
      const relativePath = path.relative(repository.root, absolute).replace(/\\/g, "/");
      if (relativePath === "" || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
        continue;
      }
      const artifactState = executionArtifactState(
        absolute,
        repositories.artifactKey(repository.repoKey, relativePath),
        repositories
      );
      if (!artifactState) {
        continue;
      }
      const existing = byRepo.get(repository.repoKey);
      byRepo.set(repository.repoKey, existing
        ? {
            ...existing,
            observedAt: maxIso(existing.observedAt, node.startedAt),
            artifactStates: mergeArtifactStates(existing.artifactStates, [artifactState])
          }
        : {
            queryId,
            repoKey: repository.repoKey,
            observedAt: node.startedAt,
            artifactStates: [artifactState]
          });
    }
  }
  return [...byRepo.values()];
}

function executionArtifactState(
  absolutePath: string,
  artifactKey: string,
  repositories: AgentRepositoryObservationService
): ArtifactStateEvidence | undefined {
  if (!existsSync(absolutePath)) {
    return {
      artifactKey,
      changeKind: "deleted",
      observedSequence: 0
    };
  }
  try {
    return {
      artifactKey,
      worktreeStateKey: repositories.blobStateKey(gitBlobObjectId(readFileSync(absolutePath))),
      changeKind: "added",
      observedSequence: 0
    };
  } catch {
    return undefined;
  }
}

function parseExecutionToolInput(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function evidenceFromExecutionWrite(
  run: PartialAgenticQueryRun,
  write: ExecutionWriteEvidence,
  snapshots: RepositorySnapshotObservation[],
  now: number
): QueryWorkEvidence | undefined {
  const startedAt = run.startedAt ?? run.queryStartedAt;
  if (!startedAt) {
    return undefined;
  }
  const baseline = snapshots
    .filter((snapshot) => snapshot.repoKey === write.repoKey && snapshot.observedAt <= startedAt)
    .sort((a, b) => a.observedSequence - b.observedSequence)
    .at(-1);
  if (!baseline) {
    return undefined;
  }
  const end = Date.parse(run.endedAt ?? startedAt);
  return {
    queryId: run.queryId,
    runIds: [run.id],
    repoKey: write.repoKey,
    epochId: baseline.epochId,
    startedAt,
    completedAt: run.endedAt ?? startedAt,
    settlingUntil: new Date(end + SETTLING_MS).toISOString(),
    expiresAt: new Date(Math.max(now, end) + EVIDENCE_TTL_MS).toISOString(),
    baselineTrusted: baseline.dirtyKnown,
    baselineReasons: baseline.dirtyKnown
      ? baseline.dirty ? ["dirty_baseline_known"] : ["clean_baseline"]
      : ["dirty_state_unknown"],
    headCommitAtStart: baseline.headCommit,
    baselineSequence: baseline.observedSequence,
    dirtyAtStart: baseline.dirty,
    observedChangeCount: write.artifactStates.length,
    artifactKeys: write.artifactStates.map((state) => state.artifactKey).sort(),
    baselineArtifactStates: baseline.artifactStates.map((state) => ({ ...state })),
    artifactStates: write.artifactStates.map((state) => ({ ...state })),
    addedLines: 0,
    deletedLines: 0,
    firstObservedAt: write.observedAt,
    lastObservedAt: write.observedAt,
    status: "completed"
  };
}

function mergeExecutionWriteEvidence(current: QueryWorkEvidence, write: ExecutionWriteEvidence): QueryWorkEvidence {
  const artifactStates = mergeArtifactStates(current.artifactStates ?? [], write.artifactStates);
  return {
    ...current,
    observedChangeCount: artifactStates.length,
    artifactKeys: artifactStates.map((state) => state.artifactKey).sort(),
    artifactStates,
    firstObservedAt: current.firstObservedAt ?? write.observedAt,
    lastObservedAt: maxIsoOptional(current.lastObservedAt, write.observedAt)
  };
}

function sameEvidenceState(a: QueryWorkEvidence, b: QueryWorkEvidence): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeArtifactStates(
  existing: ArtifactStateEvidence[],
  next: ArtifactStateEvidence[]
): ArtifactStateEvidence[] {
  const states = new Map(existing.map((state) => [state.artifactKey, state]));
  for (const state of next) {
    states.set(state.artifactKey, state);
  }
  return [...states.values()].sort((a, b) => a.artifactKey.localeCompare(b.artifactKey));
}

function gitBlobObjectId(content: string | Buffer): string {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

function maxIsoOptional(a: string | undefined, b: string | undefined): string | undefined {
  return [a, b].filter((value): value is string => value != null).sort().at(-1);
}

function latestIsoOptional(values: (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => value != null && isFiniteIso(value)).sort().at(-1);
}

function earliestIso(values: string[]): string {
  return values.filter(isFiniteIso).sort()[0] ?? new Date(0).toISOString();
}

function isFiniteIso(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameArtifactState(
  a: RepositorySnapshotObservation["artifactStates"][number] | undefined,
  b: RepositorySnapshotObservation["artifactStates"][number]
): boolean {
  return a?.worktreeStateKey === b.worktreeStateKey
    && a?.indexStateKey === b.indexStateKey
    && a?.changeKind === b.changeKind;
}

function queryGroup(run: AgenticQueryRun): AgenticQueryGroup {
  return {
    queryId: run.queryId,
    chatSessionId: run.chatSessionId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    initialQueryState: run.initialQueryState,
    runCount: 1,
    models: run.models,
    modelUsages: run.modelUsages,
    toolCallCount: run.toolCallCount,
    tools: run.tools,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadInputTokens: run.cacheReadInputTokens,
    cacheCreationInputTokens: run.cacheCreationInputTokens,
    cachedTokens: run.cachedTokens,
    reasoningOutputTokens: run.reasoningOutputTokens,
    totalTokens: run.totalTokens,
    tokenSources: [run.tokenUsageSource],
    estimatedNanoUsd: run.estimatedNanoUsd,
    estimatedUsd: run.estimatedUsd,
    estimatedAiCredits: run.estimatedAiCredits,
    pricingVersion: run.pricingVersion,
    costCoverage: run.costCoverage,
    hasNonOpenAiModels: run.models.some((model) => !model.toLowerCase().includes("gpt")),
    costLabel: run.costCoverage === "complete" ? "All estimated" : run.costCoverage === "partial" ? "Partial estimate" : "Unavailable",
    runs: [run],
    warnings: run.warnings
  };
}

function sumRuns(runs: AgenticQueryRun[], key: keyof AgenticQueryRun): number {
  return runs.reduce((total, run) => total + (typeof run[key] === "number" ? run[key] as number : 0), 0);
}
