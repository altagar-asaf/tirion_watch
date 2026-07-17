import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import {
  hasExactNativePermissionRejectionForExecutionNode,
  isNativePermissionRejectionExecutionNode
} from "@tirion/agent-contract";
import type {
  ExecutionNodeAtomV1,
  ProductionRunV1,
  QueryOccurrenceV1,
  SafeObservationV1
} from "@tirion/agent-contract";
import type { AgentStorageClient } from "@tirion/agent-storage";
import {
  type ArtifactStateEvidence,
  type CausalWriteArtifactEvidence,
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
  type WorkEpisodeQuery,
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
const WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  "applypatch",
  "createfile",
  "deletefile",
  "edit",
  "fileedit",
  "insertedit",
  "movefile",
  "multiedit",
  "notebookedit",
  "patch",
  "renamefile",
  "replaceinfile",
  "strreplace",
  "write",
  "writefile"
]);

type RunObservationBoundary = {
  runId: string;
  queryId: string;
  sessionId?: string;
  provider?: ProductionRunV1["provider"];
  runtime?: string;
  repoKey?: string;
  startedAt: string;
  endedAt?: string;
};

export class AgentProductionRunAttribution implements WorkspaceChangeTracker {
  private readonly evidence: SqliteWorkspaceEvidenceLedger;
  private readonly episodes: SqliteWorkEpisodeLedger;
  private readonly episodeTracker: DefaultAgenticWorkEpisodeTracker;
  private workspaceTracker?: DefaultWorkspaceChangeTracker;
  private readonly evidenceBoundHandlers = new Set<(evidence: QueryWorkEvidence[]) => Promise<void>>();
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
        await this.notifyEvidenceBound(evidence);
      },
      SETTLING_MS,
      this.now
    );
    await this.workspaceTracker.start();
    await this.refreshPendingEvidence();
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

  listEpisodes(query: WorkEpisodeQuery = {}): Promise<AgenticWorkEpisode[]> {
    return this.episodes.listEpisodes(query);
  }

  workEpisodes(): DefaultAgenticWorkEpisodeTracker {
    return this.episodeTracker;
  }

  onWorkspaceEvidenceBound(handler: (evidence: QueryWorkEvidence[]) => Promise<void>): () => void {
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
      .filter((occurrence) => occurrence.lifecycleVisibility !== "internal")
      .filter(hasOccurrenceWorkspaceIdentity)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const newlyBoundCompletedQueryIds = new Set<string>();
    for (const occurrence of occurrences) {
      const before = this.runBoundaries.get(occurrence.queryId);
      const boundaryWasNew = this.rememberRunBoundary(boundaryFromOccurrence(occurrence));
      const after = this.runBoundaries.get(occurrence.queryId);
      if (
        after?.endedAt
        && isFiniteIso(after.endedAt)
        && after.endedAt !== before?.endedAt
      ) {
        newlyBoundCompletedQueryIds.add(occurrence.queryId);
      }
      if (!boundaryWasNew) {
        continue;
      }
      await this.observeRunStart(partialRunFromOccurrence(occurrence));
    }
    // A native decision can arrive after the completed run and after an
    // earlier successful Write was already merged into workspace evidence.
    // Re-census the durable execution nodes immediately so causal authority is
    // retractable rather than append-only.
    const decisionQueryIds = new Set((observation.executionNodes ?? [])
      .filter(isNativePermissionRejectionExecutionNode)
      .map((node) => node.queryId));
    const reCensusQueryIds = new Set([
      ...decisionQueryIds,
      ...newlyBoundCompletedQueryIds
    ]);
    if (reCensusQueryIds.size === 0) {
      return;
    }
    const completedDecisionBoundaries = [...reCensusQueryIds]
      .map((queryId) => this.runBoundaries.get(queryId))
      .filter((boundary): boundary is RunObservationBoundary & { endedAt: string } =>
        Boolean(boundary?.endedAt && isFiniteIso(boundary.endedAt))
      );
    // A decision observed while a run is still open cannot be classified as a
    // late correction: without a trusted explicit completion boundary there
    // is no source-time upper bound. Retain its safe node, then re-census when
    // that boundary arrives so pre-terminal receipt order cannot bypass the
    // same source-time gate.
    if (completedDecisionBoundaries.length === 0) {
      return;
    }
    const snapshots = await this.repositories.listSnapshots();
    for (const boundary of completedDecisionBoundaries) {
      await this.augmentExecutionWriteEvidence(partialRunFromBoundary(boundary), snapshots);
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
      await this.refreshPendingEvidence();
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
      await this.refreshPendingEvidence();
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
      await this.notifyEvidenceBound(assembled);
    }
    return assembled;
  }

  private async augmentExecutionWriteEvidence(
    run: PartialAgenticQueryRun,
    snapshots: RepositorySnapshotObservation[]
  ): Promise<void> {
    const retainedBoundary = this.runBoundaries.get(run.queryId);
    const completedAt = retainedBoundary?.endedAt && isFiniteIso(retainedBoundary.endedAt)
      ? retainedBoundary.endedAt
      : validCompletedBoundary(run.startedAt, run.endedAt);
    const writes = await executionWriteEvidenceForQuery(
      run.queryId,
      completedAt,
      this.storage,
      this.repositories
    );
    const existing = await this.evidence.listEvidence({ queryId: run.queryId });
    const existingByRepo = new Map(existing.map((item) => [item.repoKey, item]));
    const writesByRepo = new Map(writes.map((write) => [write.repoKey, write]));
    // An explicit causal proof set is a replaceable projection of durable
    // execution nodes, not an append-only fact. Include prior execution-backed
    // records so a later native decision can remove stale writer authority.
    const repositoryKeys = new Set([
      ...writesByRepo.keys(),
      ...existing
        .filter((item) => item.causalWriteArtifacts !== undefined)
        .map((item) => item.repoKey)
    ]);
    if (repositoryKeys.size === 0) {
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
    const augmented: QueryWorkEvidence[] = [];
    for (const repoKey of repositoryKeys) {
      const write = writesByRepo.get(repoKey);
      const current = existingByRepo.get(repoKey);
      const next = write
        ? current
          ? mergeExecutionWriteEvidence(current, write)
          : evidenceFromExecutionWrite(run, write, snapshots, this.now())
        : current
          ? withoutExecutionWriteCausalEvidence(current)
          : undefined;
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
          repoKey
        });
        continue;
      }
      await this.evidence.upsertEvidence(next);
      existingByRepo.set(repoKey, next);
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
    await this.notifyEvidenceBound(augmented);
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

  private async refreshPendingEvidence(): Promise<void> {
    this.pending = (await Promise.all([
      this.evidence.listEvidence({ status: "active" }),
      this.evidence.listEvidence({ status: "settling" }),
      this.evidence.listEvidence({ status: "completed" })
    ])).flat();
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

  private async notifyEvidenceBound(evidence: QueryWorkEvidence[]): Promise<void> {
    for (const handler of this.evidenceBoundHandlers) {
      await handler(evidence);
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
      // The first explicit completion freezes causal authority. A corrupt or
      // replayed later completion for the same opaque query must not widen the
      // interval in which a native decision can revoke a prior write proof.
      endedAt: earliestIsoOptional([existing.endedAt, boundary.endedAt]),
      sessionId: existing.sessionId ?? boundary.sessionId,
      provider: existing.provider ?? boundary.provider,
      runtime: existing.runtime ?? boundary.runtime,
      repoKey: existing.repoKey ?? boundary.repoKey
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
    this.workspace.onWorkspaceEvidenceBound(async () => await this.gitAttribution.reconcile());
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
      const completionUnchanged = Boolean(existing && existing.completedAt >= run.endedAt!);
      if (completionUnchanged && existing?.outcome !== "identity_deferred") {
        continue;
      }
      if (state?.historicalCutoffAt && run.endedAt != null && run.endedAt < state.historicalCutoffAt) {
        deferredCount += 1;
        continue;
      }
      if (!hasWorkspaceAttributionIdentity(run)) {
        if (completionUnchanged && existing?.outcome === "identity_deferred") {
          deferredCount += 1;
          continue;
        }
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "ProductionRunAttribution",
          operation: "completed_run_tracking",
          state: "deferred",
          reason: "production_run_workspace_identity_unavailable",
          runId: run.runId,
          queryId: run.queryId ?? run.correlationId
        });
        await this.completedRuns.markIdentityDeferred({
          runId: run.runId,
          queryId: run.queryId ?? run.correlationId,
          completedAt: run.endedAt!
        }, new Date(this.now()).toISOString());
        processed.set(run.runId, {
          runId: run.runId,
          queryId: run.queryId ?? run.correlationId,
          completedAt: run.endedAt!,
          processedAt: new Date(this.now()).toISOString(),
          outcome: "identity_deferred"
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
        processedAt: new Date(this.now()).toISOString(),
        outcome: "processed"
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

  listWorkEpisodes(query: WorkEpisodeQuery = {}): Promise<AgenticWorkEpisode[]> {
    return this.workspace.listEpisodes(query);
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

  onWorkspaceEvidenceBound(handler: (evidence: QueryWorkEvidence[]) => Promise<void>): () => void {
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
    repoKey: run.repositoryKey,
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
  return validCompletedBoundary(run.startedAt, run.endedAt) != null;
}

function hasWorkspaceAttributionIdentity(run: ProductionRunV1): boolean {
  return run.promptState !== "unavailable";
}

function configurableProviderForProductionRun(provider: ProductionRunV1["provider"]): "claude-code" | "codex" | undefined {
  return provider === "claude-code" || provider === "codex" ? provider : undefined;
}

function boundaryFromProductionRun(run: ProductionRunV1): RunObservationBoundary {
  const endedAt = validCompletedBoundary(run.startedAt, run.endedAt);
  return {
    runId: run.runId,
    queryId: run.queryId ?? run.correlationId,
    sessionId: run.sessionId,
    provider: run.provider,
    runtime: run.runtime,
    repoKey: run.repositoryKey,
    startedAt: run.startedAt,
    ...(endedAt ? { endedAt } : {})
  };
}

function boundaryFromAttributionRun(run: PartialAgenticQueryRun): RunObservationBoundary | undefined {
  const startedAt = run.queryStartedAt ?? run.startedAt;
  if (!startedAt) {
    return undefined;
  }
  const endedAt = validCompletedBoundary(startedAt, run.endedAt);
  return {
    runId: run.id,
    queryId: run.queryId,
    sessionId: run.chatSessionId ?? run.sessionId,
    provider: providerFromAttributionRun(run),
    runtime: run.serviceName,
    repoKey: run.repoKey,
    startedAt,
    ...(endedAt ? { endedAt } : {})
  };
}

function boundaryFromOccurrence(occurrence: QueryOccurrenceV1): RunObservationBoundary {
  const completedAt = typeof occurrence.completedAt === "string"
    && occurrence.completedAt.trim() !== ""
    && occurrence.completionEvidence != null
    && occurrence.completionEvidence !== "inactivity"
    ? occurrence.completedAt
    : undefined;
  const endedAt = validCompletedBoundary(occurrence.startedAt, completedAt);
  return {
    runId: runIdForQuery(occurrence.queryId),
    queryId: occurrence.queryId,
    sessionId: occurrence.sessionId,
    provider: occurrence.provider,
    runtime: occurrence.runtime,
    repoKey: occurrence.repositoryKey,
    startedAt: occurrence.startedAt,
    ...(endedAt ? { endedAt } : {})
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
    repoKey: occurrence.repositoryKey,
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

function partialRunFromBoundary(boundary: RunObservationBoundary): PartialAgenticQueryRun {
  return {
    schemaVersion: 2,
    id: boundary.runId,
    traceId: boundary.queryId,
    queryId: boundary.queryId,
    queryStartedAt: boundary.startedAt,
    chatSessionId: boundary.sessionId,
    traceRole: "main",
    initialQueryState: "unavailable",
    startedAt: boundary.startedAt,
    ...(boundary.endedAt ? { endedAt: boundary.endedAt, status: "completed" as const } : { status: "running" as const }),
    serviceName: boundary.runtime,
    mode: boundary.provider === "codex" ? "cli" : boundary.provider === "claude-code" ? "claude" : "agent",
    repoKey: boundary.repoKey,
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
    .filter((boundary) => !run.repoKey || !boundary.repoKey || boundary.repoKey === run.repoKey)
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
  for (const snapshot of snapshots.filter((candidate) => !run.repoKey || candidate.repoKey === run.repoKey)) {
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
    const baselineTrust = snapshotBaselineTrust(baseline);
    evidence.push({
      queryId: run.queryId,
      runIds: [run.id],
      repoKey: baseline.repoKey,
      epochId: baseline.epochId,
      startedAt: run.startedAt,
      completedAt: run.endedAt ?? run.startedAt,
      settlingUntil: acceptingUntil,
      expiresAt: new Date(Math.max(now, end) + EVIDENCE_TTL_MS).toISOString(),
      baselineTrusted: baselineTrust.trusted,
      baselineReasons: baselineTrust.reasons,
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
  for (const snapshot of snapshots.filter((candidate) => !run.repoKey || candidate.repoKey === run.repoKey)) {
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
  causalWriteArtifacts: CausalWriteArtifactEvidence[];
  /** Exact successful pairs natively contradicted in the current node census. */
  nativeRejectedCausalWriteArtifacts: CausalWriteArtifactEvidence[];
};

async function executionWriteEvidenceForQuery(
  queryId: string,
  completedAt: string | undefined,
  storage: AgentStorageClient,
  repositories: AgentRepositoryObservationService
): Promise<ExecutionWriteEvidence[]> {
  const [nodes, knownRepositories] = await Promise.all([
    storage.listExecutionNodeDocumentsForQuery<ExecutionNodeAtomV1>(queryId),
    repositories.listRepositories()
  ]);
  const byRepo = new Map<string, ExecutionWriteEvidence>();
  const sortedRepositories = knownRepositories
    .map((repo) => ({ repoKey: repo.repoKey, root: canonicalPath(repo.root) }))
    .sort((a, b) => b.root.length - a.root.length);
  const executionNodes = nodes
    .map((document) => document.value)
    // An explicit completed-run boundary freezes causal file authority as
    // well as usage. A delayed receipt is eligible only when its provider
    // source began on or before that boundary; malformed time fails closed.
    .filter((node) => executionNodeBeginsAtOrBeforeCompletedBoundary(node, completedAt));
  for (const node of executionNodes.filter(isSuccessfulSemanticWriteNode)) {
    // An empty or unreadable source census is never a native rejection. Only
    // record this marker when this exact successful invocation has a durable
    // Claude native-permission decision counterpart.
    const nativelyRejected = hasExactNativePermissionRejectionForExecutionNode(node, executionNodes);
    const repositoryByKey = node.repositoryKey
      ? sortedRepositories.find((candidate) => candidate.repoKey === node.repositoryKey)
      : undefined;
    if (
      !repositoryByKey
      || !hasAllowlistedWriteArtifactEvidence(node)
      || (node.artifactKeys?.length ?? 0) === 0
    ) {
      continue;
    }
    for (const artifactKey of node.artifactKeys ?? []) {
      const relativePath = repositories.relativePaths(repositoryByKey.repoKey, [artifactKey])[0];
      if (!relativePath) {
        continue;
      }
      const absolute = canonicalPath(path.join(repositoryByKey.root, relativePath));
      const relative = path.relative(repositoryByKey.root, absolute).replace(/\\/g, "/");
      if (relative === "" || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
        continue;
      }
      if (nativelyRejected) {
        mergeNativeRejectedExecutionWriteArtifact(
          byRepo,
          node.queryId,
          repositoryByKey.repoKey,
          node.startedAt,
          artifactKey,
          node.nodeId
        );
        continue;
      }
      const artifactState = executionArtifactState(absolute, artifactKey, repositories);
      if (artifactState) {
        mergeExecutionWriteState(
          byRepo,
          node.queryId,
          repositoryByKey.repoKey,
          node.startedAt,
          artifactState,
          node.nodeId
        );
      }
    }
  }
  return [...byRepo.values()];
}

function executionNodeBeginsAtOrBeforeCompletedBoundary(
  node: ExecutionNodeAtomV1,
  completedAt: string | undefined
): boolean {
  if (!completedAt) {
    return true;
  }
  const nodeStartedAt = Date.parse(node.startedAt);
  const boundaryAt = Date.parse(completedAt);
  return Number.isFinite(nodeStartedAt)
    && Number.isFinite(boundaryAt)
    && nodeStartedAt <= boundaryAt;
}

function isSuccessfulSemanticWriteNode(node: ExecutionNodeAtomV1): boolean {
  if (node.nodeKind !== "tool" || node.outcome !== "success") {
    return false;
  }
  return isWorkspaceMutationToolName(node.toolName ?? node.name);
}

function hasAllowlistedWriteArtifactEvidence(node: ExecutionNodeAtomV1): boolean {
  return node.artifactEvidence === "provider_write_hook"
    || node.artifactEvidence === "provider_tool_event";
}

function isWorkspaceMutationToolName(value: string): boolean {
  return WORKSPACE_MUTATION_TOOL_NAMES.has(normalizedToolName(value));
}

function normalizedToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mergeExecutionWriteState(
  byRepo: Map<string, ExecutionWriteEvidence>,
  queryId: string,
  repoKey: string,
  observedAt: string,
  artifactState: ArtifactStateEvidence,
  executionNodeId: string
): void {
  const existing = byRepo.get(repoKey);
  const causalWriteArtifact: CausalWriteArtifactEvidence = {
    artifactKey: artifactState.artifactKey,
    executionNodeId
  };
  byRepo.set(repoKey, existing
    ? {
        ...existing,
        observedAt: maxIso(existing.observedAt, observedAt),
        artifactStates: mergeArtifactStates(existing.artifactStates, [artifactState]),
        causalWriteArtifacts: mergeCausalWriteArtifacts(existing.causalWriteArtifacts, [causalWriteArtifact])
      }
    : {
      queryId,
      repoKey,
      observedAt,
      artifactStates: [artifactState],
      causalWriteArtifacts: [causalWriteArtifact],
      nativeRejectedCausalWriteArtifacts: []
    });
}

function mergeNativeRejectedExecutionWriteArtifact(
  byRepo: Map<string, ExecutionWriteEvidence>,
  queryId: string,
  repoKey: string,
  observedAt: string,
  artifactKey: string,
  executionNodeId: string
): void {
  const existing = byRepo.get(repoKey);
  const causalWriteArtifact: CausalWriteArtifactEvidence = { artifactKey, executionNodeId };
  byRepo.set(repoKey, existing
    ? {
        ...existing,
        observedAt: maxIso(existing.observedAt, observedAt),
        nativeRejectedCausalWriteArtifacts: mergeCausalWriteArtifacts(
          existing.nativeRejectedCausalWriteArtifacts,
          [causalWriteArtifact]
        )
      }
    : {
        queryId,
        repoKey,
        observedAt,
        artifactStates: [],
        causalWriteArtifacts: [],
        nativeRejectedCausalWriteArtifacts: [causalWriteArtifact]
      });
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
  const baselineTrust = snapshotBaselineTrust(baseline);
  return {
    queryId: run.queryId,
    runIds: [run.id],
    repoKey: write.repoKey,
    epochId: baseline.epochId,
    startedAt,
    completedAt: run.endedAt ?? startedAt,
    settlingUntil: new Date(end + SETTLING_MS).toISOString(),
    expiresAt: new Date(Math.max(now, end) + EVIDENCE_TTL_MS).toISOString(),
    baselineTrusted: baselineTrust.trusted,
    baselineReasons: baselineTrust.reasons,
    headCommitAtStart: baseline.headCommit,
    baselineSequence: baseline.observedSequence,
    dirtyAtStart: baseline.dirty,
    observedChangeCount: write.artifactStates.length,
    artifactKeys: write.artifactStates.map((state) => state.artifactKey).sort(),
    causalArtifactKeys: write.artifactStates.map((state) => state.artifactKey).sort(),
    causalWriteArtifacts: write.causalWriteArtifacts,
    nativeRejectedCausalWriteArtifacts: write.nativeRejectedCausalWriteArtifacts,
    causalWriteArtifactsComplete: true,
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
  // Rebuild causal authority from the current source-node census. Retaining a
  // past successful node after a same-invocation native denial would let an
  // append-only evidence record outlive the authority that created it.
  const causalArtifactKeys = write.artifactStates.map((state) => state.artifactKey).sort();
  const causalWriteArtifacts = write.causalWriteArtifacts;
  return {
    ...current,
    observedChangeCount: artifactStates.length,
    artifactKeys: artifactStates.map((state) => state.artifactKey).sort(),
    causalArtifactKeys,
    causalWriteArtifacts,
    nativeRejectedCausalWriteArtifacts: write.nativeRejectedCausalWriteArtifacts,
    causalWriteArtifactsComplete: true,
    artifactStates,
    firstObservedAt: current.firstObservedAt ?? write.observedAt,
    lastObservedAt: maxIsoOptional(current.lastObservedAt, write.observedAt)
  };
}

function withoutExecutionWriteCausalEvidence(current: QueryWorkEvidence): QueryWorkEvidence {
  return {
    ...current,
    // Empty (rather than absent) deliberately records that execution evidence
    // was revalidated and no longer supports any writer claim. Snapshot state
    // remains useful diagnostic context, but policy must not treat it as an
    // unbounded replacement for a retracted causal tool proof.
    causalArtifactKeys: [],
    causalWriteArtifacts: [],
    // Source disappearance is not a native decision. Preserve only a marker
    // that was previously established by an exact durable native rejection.
    nativeRejectedCausalWriteArtifacts: current.nativeRejectedCausalWriteArtifacts ?? [],
    causalWriteArtifactsComplete: true
  };
}

function snapshotBaselineTrust(snapshot: RepositorySnapshotObservation): {
  trusted: boolean;
  reasons: string[];
} {
  const artifactCoverageComplete = snapshot.artifactCoverage !== "partial";
  return {
    trusted: snapshot.dirtyKnown && artifactCoverageComplete,
    reasons: [
      ...(snapshot.dirtyKnown
        ? snapshot.dirty ? ["dirty_baseline_known"] : ["clean_baseline"]
        : ["dirty_state_unknown"]),
      ...(artifactCoverageComplete ? [] : ["artifact_state_coverage_partial"])
    ]
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

function mergeCausalWriteArtifacts(
  existing: CausalWriteArtifactEvidence[],
  next: CausalWriteArtifactEvidence[]
): CausalWriteArtifactEvidence[] {
  const byPair = new Map<string, CausalWriteArtifactEvidence>();
  for (const item of [...existing, ...next]) {
    byPair.set(`${item.artifactKey}:${item.executionNodeId}`, item);
  }
  return [...byPair.values()].sort((left, right) =>
    left.artifactKey.localeCompare(right.artifactKey)
    || left.executionNodeId.localeCompare(right.executionNodeId)
  );
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

function earliestIsoOptional(values: (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => value != null && isFiniteIso(value)).sort()[0];
}

function earliestIso(values: string[]): string {
  return values.filter(isFiniteIso).sort()[0] ?? new Date(0).toISOString();
}

function isFiniteIso(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCompletedBoundary(startedAt: string | undefined, endedAt: string | undefined): string | undefined {
  const startedAtMs = Date.parse(startedAt ?? "");
  const endedAtMs = Date.parse(endedAt ?? "");
  return Number.isFinite(startedAtMs)
    && Number.isFinite(endedAtMs)
    && endedAtMs >= startedAtMs
    ? endedAt
    : undefined;
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
