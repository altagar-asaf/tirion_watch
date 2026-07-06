import {
  AgenticQueryRun,
  ArtifactStateEvidence,
  DiagnosticEvent,
  PartialAgenticQueryRun,
  QueryWorkEvidence,
  RepositoryObservation,
  RepositoryObservationEvent,
  RepositorySnapshotObservation,
  WorkspaceChangeTracker,
  WorkspaceEvidenceLedger
} from "../types";

type ActiveEvidence = QueryWorkEvidence & {
  baselineByArtifact: Map<string, ArtifactStateEvidence>;
  observedByArtifact: Map<string, ArtifactStateEvidence>;
};

const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVE_EVIDENCE_MS = 4 * 60 * 60 * 1000;
// Absorb delayed agent writes without turning unrelated later edits into query evidence.
const DEFAULT_POST_RUN_SETTLING_MS = 2 * 60 * 1000;

export class DefaultWorkspaceChangeTracker implements WorkspaceChangeTracker {
  private evidenceByQueryRepo = new Map<string, ActiveEvidence>();
  private unsubscribe?: () => void;
  private settlingTimer?: NodeJS.Timeout;
  private mutationQueue: Promise<void> = Promise.resolve();
  private handoffQueue: Promise<void> = Promise.resolve();
  private running = false;

  constructor(
    private readonly observations: RepositoryObservation,
    private readonly ledger: WorkspaceEvidenceLedger,
    private readonly recordEvent: (event: DiagnosticEvent) => void = () => undefined,
    private readonly onEvidence: (evidence: QueryWorkEvidence[]) => void | Promise<void> = () => undefined,
    private readonly settlingMs = DEFAULT_POST_RUN_SETTLING_MS,
    private readonly now: () => number = Date.now,
    private readonly activeEvidenceMs = DEFAULT_ACTIVE_EVIDENCE_MS
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const stored = await this.ledger.listEvidence({});
    for (const evidence of stored.filter((item) =>
      item.status === "active" || item.status === "settling" || item.status === "completed"
    )) {
      this.evidenceByQueryRepo.set(evidenceKey(evidence.queryId, evidence.repoKey), activeEvidence(evidence));
    }
    await this.finalizeEvidenceLifecycle();
    this.unsubscribe = this.observations.onObservation((event) => this.observeRepositoryEvent(event));
    this.scheduleSettlingFinalization();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.settlingTimer) {
      clearTimeout(this.settlingTimer);
      this.settlingTimer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.mutationQueue;
    await this.handoffQueue;
  }

  async observeRun(run: PartialAgenticQueryRun): Promise<void> {
    if (!run.queryId) {
      return;
    }
    const currentSnapshots = this.observations.currentSnapshots();
    if (currentSnapshots.length === 0) {
      this.recordLifecycle("observe_run", "refreshing_snapshots", "observe_run_missing_current_repository_snapshots", {
        queryId: run.queryId,
        details: {
          snapshotCount: 0
        }
      });
      await this.observations.refresh();
      return this.enqueueMutation(() => this.recordRunBaselines(run, this.observations.currentSnapshots(), "refreshed"));
    }
    void this.refreshSnapshotsInBackground(run.queryId);
    return this.enqueueMutation(() => this.recordRunBaselines(run, currentSnapshots, "current"));
  }

  async observeRunCompleted(run: AgenticQueryRun): Promise<void> {
    await this.observeRun(run);
    return this.enqueueMutation(async () => {
      const completed: QueryWorkEvidence[] = [];
      for (const [key, evidence] of this.evidenceByQueryRepo) {
        if (evidence.queryId !== run.queryId) {
          continue;
        }
        evidence.runIds = uniqueStrings([...evidence.runIds, run.id]);
        evidence.completedAt = run.endedAt ?? new Date().toISOString();
        evidence.expiresAt = new Date(new Date(evidence.completedAt).getTime() + EVIDENCE_TTL_MS).toISOString();
        evidence.settlingUntil = new Date(new Date(evidence.completedAt).getTime() + this.settlingMs).toISOString();
        evidence.status = new Date(evidence.settlingUntil).getTime() > this.now() ? "settling" : "completed";
        await this.ledger.upsertEvidence(publicEvidence(evidence));
        if (evidence.status === "settling") {
          this.recordLifecycle("settling", "started", "workspace_evidence_settling_started", {
            queryId: evidence.queryId,
            repoKey: evidence.repoKey,
            epochId: evidence.epochId,
            commitHash: evidence.headCommitAtStart,
            details: {
              observedChangeCount: evidence.observedChangeCount,
              dirty: evidence.dirtyAtStart,
              observedSequence: evidence.baselineSequence ?? null
            }
          });
          this.recordEvent({
            kind: "workspaceEvidence",
            queryId: evidence.queryId,
            repoKey: evidence.repoKey,
            state: "settling_started",
            reason: "workspace_evidence_settling_started",
            observedChangeCount: evidence.observedChangeCount,
            dirty: evidence.dirtyAtStart,
            headCommitAtStart: evidence.headCommitAtStart,
            observedSequence: evidence.baselineSequence
          });
          this.recordEvent({
            kind: "attributionDecision",
            queryId: evidence.queryId,
            status: "pending_evidence",
            reason: "workspace_evidence_settling_started"
          });
        }
        if (evidence.observedChangeCount > 0) {
          completed.push(publicEvidence(evidence));
        } else if (evidence.status === "completed") {
          this.evidenceByQueryRepo.delete(key);
          await this.ledger.removeEvidence(evidence.queryId, evidence.repoKey);
        }
      }
      this.scheduleSettlingFinalization();
      if (completed.length > 0) {
        await this.emitEvidence(completed, "run_completed");
      }
    });
  }

  pendingEvidence(): QueryWorkEvidence[] {
    return [...this.evidenceByQueryRepo.values()]
      .filter((evidence) => evidence.observedChangeCount > 0)
      .map(publicEvidence);
  }

  async resolveQueries(queryIds: string[]): Promise<void> {
    const resolved = new Set(queryIds);
    return this.enqueueMutation(async () => {
      for (const [key, evidence] of this.evidenceByQueryRepo) {
        if (!resolved.has(evidence.queryId)) {
          continue;
        }
        this.evidenceByQueryRepo.delete(key);
        await this.ledger.removeEvidence(evidence.queryId, evidence.repoKey);
      }
    });
  }

  async reset(): Promise<void> {
    await this.enqueueMutation(async () => {
      this.evidenceByQueryRepo.clear();
      await this.ledger.clear();
    });
  }

  private observeRepositoryEvent(event: RepositoryObservationEvent): Promise<void> {
    if (event.kind !== "snapshot") {
      return Promise.resolve();
    }
    return this.enqueueMutation(() => this.recordSnapshotEvidence(event.snapshot));
  }

  private async recordSnapshotEvidence(snapshot: RepositorySnapshotObservation): Promise<void> {
    await this.finalizeEvidenceLifecycle(snapshot.observedAt);
    const changed: QueryWorkEvidence[] = [];
    let matchingEvidenceCount = 0;
    let skippedEpochMismatchCount = 0;
    let skippedOutsideWindowCount = 0;
    for (const [key, evidence] of this.evidenceByQueryRepo) {
      if (evidence.repoKey !== snapshot.repoKey) {
        continue;
      }
      matchingEvidenceCount += 1;
      if (evidence.epochId !== snapshot.epochId) {
        this.evidenceByQueryRepo.delete(key);
        await this.ledger.removeEvidence(evidence.queryId, evidence.repoKey);
        skippedEpochMismatchCount += 1;
        continue;
      }
      if (!acceptsSnapshot(evidence, snapshot)) {
        skippedOutsideWindowCount += 1;
        continue;
      }
      const wasEmptySettlingWindow = evidence.status === "settling" && evidence.observedChangeCount === 0;
      for (const state of snapshot.artifactStates) {
        const baseline = evidence.baselineByArtifact.get(state.artifactKey);
        if (sameArtifactState(baseline, state)) {
          continue;
        }
        evidence.observedByArtifact.set(state.artifactKey, state);
      }
      hydrateEvidence(evidence);
      if (evidence.observedChangeCount > 0) {
        await this.ledger.upsertEvidence(publicEvidence(evidence));
        this.recordLifecycle("snapshot_match", "changes_observed", "repository_snapshot_observed_workspace_changes", {
          queryId: evidence.queryId,
          repoKey: evidence.repoKey,
          epochId: evidence.epochId,
          commitHash: snapshot.headCommit,
          details: {
            observedChangeCount: evidence.observedChangeCount,
            dirty: snapshot.dirty,
            observedSequence: snapshot.observedSequence
          }
        });
        this.recordEvent({
          kind: "workspaceEvidence",
          queryId: evidence.queryId,
          repoKey: evidence.repoKey,
          commitHash: snapshot.headCommit,
          state: "snapshot_matched",
          reason: "repository_snapshot_observed_workspace_changes",
          observedChangeCount: evidence.observedChangeCount,
          dirty: snapshot.dirty,
          headCommitAtStart: evidence.headCommitAtStart,
          observedSequence: snapshot.observedSequence
        });
        changed.push(publicEvidence(evidence));
        if (wasEmptySettlingWindow) {
          this.recordEvent({
            kind: "attributionDecision",
            queryId: evidence.queryId,
            status: "pending_evidence",
            reason: "post_run_settling_evidence_observed"
          });
        }
      }
    }
    if (matchingEvidenceCount > 0 && changed.length === 0) {
      this.recordLifecycle("snapshot_match", "no_changes_observed", "repository_snapshot_no_workspace_changes", {
        repoKey: snapshot.repoKey,
        epochId: snapshot.epochId,
        commitHash: snapshot.headCommit,
        details: {
          matchingEvidenceCount,
          skippedEpochMismatchCount,
          skippedOutsideWindowCount,
          dirty: snapshot.dirty,
          observedSequence: snapshot.observedSequence
        }
      });
    }
    if (changed.length > 0) {
      await this.emitEvidence(changed, "snapshot_change");
    }
  }

  private async finalizeEvidenceLifecycle(at = new Date(this.now()).toISOString()): Promise<void> {
    const finalized: QueryWorkEvidence[] = [];
    for (const [key, evidence] of this.evidenceByQueryRepo) {
      if (
        evidence.status === "active"
        && new Date(evidence.startedAt).getTime() + this.activeEvidenceMs <= new Date(at).getTime()
      ) {
        this.evidenceByQueryRepo.delete(key);
        await this.ledger.removeEvidence(evidence.queryId, evidence.repoKey);
        this.recordLifecycle("lifecycle", "active_expired", "workspace_active_evidence_expired", {
          queryId: evidence.queryId,
          repoKey: evidence.repoKey,
          epochId: evidence.epochId,
          commitHash: evidence.headCommitAtStart,
          severity: "warning",
          details: {
            observedChangeCount: evidence.observedChangeCount,
            dirty: evidence.dirtyAtStart,
            observedSequence: evidence.baselineSequence ?? null
          }
        });
        this.recordEvent({
          kind: "workspaceEvidence",
          queryId: evidence.queryId,
          repoKey: evidence.repoKey,
          state: "active_evidence_expired",
          reason: "workspace_active_evidence_expired",
          observedChangeCount: evidence.observedChangeCount,
          dirty: evidence.dirtyAtStart,
          headCommitAtStart: evidence.headCommitAtStart,
          observedSequence: evidence.baselineSequence
        });
        this.recordEvent({
          kind: "attributionDecision",
          queryId: evidence.queryId,
          status: "skipped",
          reason: "workspace_active_evidence_expired"
        });
        continue;
      }
      if (evidence.status !== "settling" || !evidence.settlingUntil || evidence.settlingUntil > at) {
        continue;
      }
      evidence.status = "completed";
      if (evidence.observedChangeCount === 0) {
        this.evidenceByQueryRepo.delete(key);
        await this.ledger.removeEvidence(evidence.queryId, evidence.repoKey);
        this.recordLifecycle("settling", "expired_no_changes", "workspace_evidence_settling_expired_no_changes", {
          queryId: evidence.queryId,
          repoKey: evidence.repoKey,
          epochId: evidence.epochId,
          commitHash: evidence.headCommitAtStart,
          severity: "warning",
          details: {
            observedChangeCount: 0,
            dirty: evidence.dirtyAtStart,
            observedSequence: evidence.baselineSequence ?? null
          }
        });
        this.recordEvent({
          kind: "workspaceEvidence",
          queryId: evidence.queryId,
          repoKey: evidence.repoKey,
          state: "settling_expired_no_changes",
          reason: "workspace_evidence_settling_expired_no_changes",
          observedChangeCount: 0,
          dirty: evidence.dirtyAtStart,
          headCommitAtStart: evidence.headCommitAtStart,
          observedSequence: evidence.baselineSequence
        });
        this.recordEvent({
          kind: "attributionDecision",
          queryId: evidence.queryId,
          status: "skipped",
          reason: "workspace_evidence_settling_expired_no_changes"
        });
        continue;
      }
      await this.ledger.upsertEvidence(publicEvidence(evidence));
      this.recordLifecycle("settling", "finalized_with_changes", "workspace_evidence_settling_finalized_with_changes", {
        queryId: evidence.queryId,
        repoKey: evidence.repoKey,
        epochId: evidence.epochId,
        commitHash: evidence.headCommitAtStart,
        details: {
          observedChangeCount: evidence.observedChangeCount,
          dirty: evidence.dirtyAtStart,
          observedSequence: evidence.baselineSequence ?? null
        }
      });
      this.recordEvent({
        kind: "workspaceEvidence",
        queryId: evidence.queryId,
        repoKey: evidence.repoKey,
        state: "settling_finalized_with_changes",
        reason: "workspace_evidence_settling_finalized_with_changes",
        observedChangeCount: evidence.observedChangeCount,
        dirty: evidence.dirtyAtStart,
        headCommitAtStart: evidence.headCommitAtStart,
        observedSequence: evidence.baselineSequence
      });
      finalized.push(publicEvidence(evidence));
    }
    if (finalized.length > 0) {
      await this.emitEvidence(finalized, "settling_finalized");
    }
  }

  private scheduleSettlingFinalization(): void {
    if (this.settlingTimer) {
      clearTimeout(this.settlingTimer);
      this.settlingTimer = undefined;
    }
    if (!this.running) {
      return;
    }
    const next = [...this.evidenceByQueryRepo.values()]
      .flatMap((evidence) => {
        if (evidence.status === "active") {
          const expiresAt = new Date(evidence.startedAt).getTime() + this.activeEvidenceMs;
          return Number.isFinite(expiresAt) ? [expiresAt] : [];
        }
        return evidence.status === "settling" && evidence.settlingUntil
          ? [new Date(evidence.settlingUntil).getTime()]
          : [];
      })
      .sort((a, b) => a - b)[0];
    if (next == null) {
      return;
    }
    this.settlingTimer = setTimeout(() => {
      void this.enqueueMutation(() => this.finalizeEvidenceLifecycle())
        .catch((error) => {
          this.recordEvent({
            kind: "info",
            message: `Workspace evidence settling finalization failed and will retry: ${error instanceof Error ? error.message : String(error)}`
          });
        })
        .finally(() => this.scheduleSettlingFinalization());
    }, Math.max(0, next - this.now()));
    this.settlingTimer.unref?.();
  }

  private async recordRunBaselines(
    run: PartialAgenticQueryRun,
    snapshots: RepositorySnapshotObservation[],
    snapshotSource: "current" | "refreshed"
  ): Promise<void> {
    if (snapshots.length === 0) {
      this.recordLifecycle("observe_run", "no_repository_snapshots", "observe_run_without_repository_snapshots", {
        queryId: run.queryId,
        details: {
          snapshotCount: 0,
          snapshotSource
        }
      });
      this.recordEvent({
        kind: "workspaceEvidence",
        queryId: run.queryId,
        state: "no_repository_snapshots",
        reason: "observe_run_without_repository_snapshots",
        snapshotCount: 0
      });
      return;
    }
    this.recordLifecycle(
      "observe_run",
      snapshotSource === "current" ? "using_current_snapshots" : "using_refreshed_snapshots",
      snapshotSource === "current"
        ? "observe_run_used_current_repository_snapshots"
        : "observe_run_used_refreshed_repository_snapshots",
      {
        queryId: run.queryId,
        details: {
          snapshotCount: snapshots.length,
          maxSnapshotAgeMs: Math.max(
            0,
            ...snapshots.map((snapshot) => Math.max(0, this.now() - new Date(snapshot.observedAt).getTime()))
          )
        }
      }
    );
    await this.closeSettlingEvidenceAtRunStart(run, snapshots);
    const created: QueryWorkEvidence[] = [];
    for (const snapshot of snapshots) {
      const key = evidenceKey(run.queryId!, snapshot.repoKey);
      const existing = this.evidenceByQueryRepo.get(key);
      if (existing?.epochId === snapshot.epochId) {
        existing.runIds = uniqueStrings([...existing.runIds, run.id]);
        await this.ledger.upsertEvidence(publicEvidence(existing));
        this.recordLifecycle("observe_run", "baseline_refreshed", "observe_run_reused_repository_baseline", {
          queryId: run.queryId,
          repoKey: snapshot.repoKey,
          epochId: snapshot.epochId,
          commitHash: existing.headCommitAtStart,
          details: {
            snapshotCount: snapshots.length,
            observedChangeCount: existing.observedChangeCount,
            dirty: snapshot.dirty,
            observedSequence: snapshot.observedSequence,
            snapshotSource
          }
        });
        this.recordEvent({
          kind: "workspaceEvidence",
          queryId: run.queryId,
          repoKey: snapshot.repoKey,
          state: "baseline_refreshed",
          reason: "observe_run_reused_repository_baseline",
          snapshotCount: snapshots.length,
          observedChangeCount: existing.observedChangeCount,
          dirty: snapshot.dirty,
          headCommitAtStart: existing.headCommitAtStart,
          observedSequence: snapshot.observedSequence
        });
        continue;
      }
      if (existing) {
        this.evidenceByQueryRepo.delete(key);
        await this.ledger.removeEvidence(existing.queryId, existing.repoKey);
      }
      const evidence = evidenceFromBaseline(run, snapshot);
      this.evidenceByQueryRepo.set(key, evidence);
      await this.ledger.upsertEvidence(publicEvidence(evidence));
      const publicRecord = publicEvidence(evidence);
      created.push(publicRecord);
      this.recordLifecycle("observe_run", "baseline_created", "observe_run_created_repository_baseline", {
        queryId: run.queryId,
        repoKey: snapshot.repoKey,
        epochId: snapshot.epochId,
        commitHash: snapshot.headCommit,
        details: {
          snapshotCount: snapshots.length,
          observedChangeCount: evidence.observedChangeCount,
          dirty: snapshot.dirty,
          observedSequence: snapshot.observedSequence,
          snapshotSource
        }
      });
      this.recordEvent({
        kind: "workspaceEvidence",
        queryId: run.queryId,
        repoKey: snapshot.repoKey,
        state: "baseline_created",
        reason: "observe_run_created_repository_baseline",
        snapshotCount: snapshots.length,
        observedChangeCount: evidence.observedChangeCount,
        dirty: snapshot.dirty,
        headCommitAtStart: snapshot.headCommit,
        observedSequence: snapshot.observedSequence
      });
    }
    this.scheduleSettlingFinalization();
    if (created.length > 0) {
      if (created.length === 1) {
        await this.emitEvidence(created, "baseline_binding");
        return;
      }
      this.recordLifecycle("handoff", "deferred", "workspace_evidence_handoff_deferred_multi_repository_baseline", {
        queryId: run.queryId,
        details: {
          source: "baseline_binding",
          evidenceCount: created.length,
          changedEvidenceCount: created.filter((item) => item.observedChangeCount > 0).length,
          zeroChangeEvidenceCount: created.filter((item) => item.observedChangeCount === 0).length,
          repoCount: uniqueStrings(created.map((item) => item.repoKey)).length,
          repoKeys: summarizeIds(created.map((item) => item.repoKey))
        }
      });
    }
  }

  private async closeSettlingEvidenceAtRunStart(
    run: PartialAgenticQueryRun,
    snapshots: RepositorySnapshotObservation[]
  ): Promise<void> {
    const runStartedAt = run.queryStartedAt ?? run.startedAt;
    if (!run.queryId || !runStartedAt) {
      return;
    }
    const runStartedMs = Date.parse(runStartedAt);
    if (!Number.isFinite(runStartedMs)) {
      return;
    }
    const repoKeys = new Set(snapshots.map((snapshot) => snapshot.repoKey));
    const finalized: QueryWorkEvidence[] = [];
    for (const [key, evidence] of this.evidenceByQueryRepo) {
      if (
        evidence.queryId === run.queryId
        || evidence.status !== "settling"
        || !repoKeys.has(evidence.repoKey)
        || !evidence.settlingUntil
      ) {
        continue;
      }
      const evidenceStartedMs = Date.parse(evidence.startedAt);
      const completedMs = evidence.completedAt ? Date.parse(evidence.completedAt) : Number.NaN;
      const settlingMs = Date.parse(evidence.settlingUntil);
      if (
        !Number.isFinite(evidenceStartedMs)
        || !Number.isFinite(completedMs)
        || !Number.isFinite(settlingMs)
        || evidenceStartedMs > runStartedMs
        || completedMs > runStartedMs
        || settlingMs <= runStartedMs
      ) {
        continue;
      }
      evidence.settlingUntil = runStartedAt;
      evidence.status = "completed";
      if (evidence.observedChangeCount > 0) {
        await this.ledger.upsertEvidence(publicEvidence(evidence));
        finalized.push(publicEvidence(evidence));
      } else {
        this.evidenceByQueryRepo.delete(key);
        await this.ledger.removeEvidence(evidence.queryId, evidence.repoKey);
      }
      this.recordLifecycle("settling", "completed", "workspace_evidence_settling_closed_by_new_run", {
        queryId: evidence.queryId,
        repoKey: evidence.repoKey,
        epochId: evidence.epochId,
        commitHash: evidence.headCommitAtStart,
        details: {
          nextQueryId: run.queryId,
          observedChangeCount: evidence.observedChangeCount,
          previousSettlingUntil: new Date(settlingMs).toISOString()
        }
      });
      this.recordEvent({
        kind: "workspaceEvidence",
        queryId: evidence.queryId,
        repoKey: evidence.repoKey,
        state: "settling_completed",
        reason: "workspace_evidence_settling_closed_by_new_run",
        observedChangeCount: evidence.observedChangeCount,
        dirty: evidence.dirtyAtStart,
        headCommitAtStart: evidence.headCommitAtStart,
        observedSequence: evidence.baselineSequence
      });
    }
    if (finalized.length > 0) {
      await this.emitEvidence(finalized, "settling_finalized");
    }
  }

  private emitEvidence(
    evidence: QueryWorkEvidence[],
    source: "baseline_binding" | "snapshot_change" | "run_completed" | "settling_finalized"
  ): Promise<void> {
    const next = this.handoffQueue.then(async () => {
      this.recordLifecycle("handoff", "started", "workspace_evidence_handoff_started", {
        details: {
          source,
          evidenceCount: evidence.length,
          changedEvidenceCount: evidence.filter((item) => item.observedChangeCount > 0).length,
          zeroChangeEvidenceCount: evidence.filter((item) => item.observedChangeCount === 0).length,
          queryCount: uniqueStrings(evidence.map((item) => item.queryId)).length,
          repoCount: uniqueStrings(evidence.map((item) => item.repoKey)).length,
          queryIds: summarizeIds(evidence.map((item) => item.queryId)),
          repoKeys: summarizeIds(evidence.map((item) => item.repoKey))
        }
      });
      try {
        await this.onEvidence(evidence);
        this.recordLifecycle("handoff", "completed", "workspace_evidence_handoff_completed", {
          details: {
            source,
            evidenceCount: evidence.length,
            changedEvidenceCount: evidence.filter((item) => item.observedChangeCount > 0).length,
            zeroChangeEvidenceCount: evidence.filter((item) => item.observedChangeCount === 0).length,
            queryCount: uniqueStrings(evidence.map((item) => item.queryId)).length,
            repoCount: uniqueStrings(evidence.map((item) => item.repoKey)).length,
            queryIds: summarizeIds(evidence.map((item) => item.queryId)),
            repoKeys: summarizeIds(evidence.map((item) => item.repoKey))
          }
        });
      } catch (error) {
        this.recordLifecycle("handoff", "failed", "workspace_evidence_handoff_failed", {
          severity: "warning",
          details: {
            source,
            evidenceCount: evidence.length,
            queryIds: summarizeIds(evidence.map((item) => item.queryId)),
            repoKeys: summarizeIds(evidence.map((item) => item.repoKey)),
            error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)
          }
        });
        this.recordEvent({
          kind: "info",
          message: `Workspace evidence handoff failed and will reconcile on reload: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    });
    this.handoffQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async refreshSnapshotsInBackground(queryId: string): Promise<void> {
    try {
      await this.observations.refresh();
    } catch (error) {
      this.recordLifecycle("observe_run", "refresh_failed", "observe_run_background_refresh_failed", {
        severity: "warning",
        queryId,
        details: {
          error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)
        }
      });
    }
  }

  private recordLifecycle(
    operation: string,
    state: string,
    reason: string,
    options?: {
      severity?: "info" | "warning" | "error";
      queryId?: string;
      repoKey?: string;
      epochId?: string;
      commitHash?: string;
      details?: Record<string, string | number | boolean | null>;
    }
  ): void {
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "WorkspaceChangeTracker",
      operation,
      state,
      reason,
      ...(options?.severity ? { severity: options.severity } : {}),
      ...(options?.queryId ? { queryId: options.queryId } : {}),
      ...(options?.repoKey ? { repoKey: options.repoKey } : {}),
      ...(options?.epochId ? { epochId: options.epochId } : {}),
      ...(options?.commitHash ? { commitHash: options.commitHash } : {}),
      ...(options?.details ? { details: options.details } : {})
    });
  }
}

function evidenceFromBaseline(run: PartialAgenticQueryRun, snapshot: RepositorySnapshotObservation): ActiveEvidence {
  const baselineArtifactStates = snapshot.artifactStates.map((state) => ({ ...state }));
  const baselineTrusted = snapshot.dirtyKnown;
  const evidence: QueryWorkEvidence = {
    queryId: run.queryId!,
    runIds: [run.id],
    repoKey: snapshot.repoKey,
    epochId: snapshot.epochId,
    startedAt: run.queryStartedAt ?? run.startedAt ?? new Date().toISOString(),
    baselineTrusted,
    baselineReasons: snapshot.dirtyKnown
      ? snapshot.dirty ? ["dirty_baseline_known"] : ["clean_baseline"]
      : ["dirty_state_unknown"],
    headCommitAtStart: snapshot.headCommit,
    baselineSequence: snapshot.observedSequence,
    dirtyAtStart: snapshot.dirty,
    observedChangeCount: 0,
    artifactKeys: [],
    baselineArtifactStates,
    artifactStates: [],
    addedLines: 0,
    deletedLines: 0,
    status: "active"
  };
  return activeEvidence(evidence);
}

function activeEvidence(evidence: QueryWorkEvidence): ActiveEvidence {
  return {
    ...evidence,
    baselineByArtifact: new Map((evidence.baselineArtifactStates ?? []).map((state) => [state.artifactKey, state])),
    observedByArtifact: new Map((evidence.artifactStates ?? []).map((state) => [state.artifactKey, state]))
  };
}

function hydrateEvidence(evidence: ActiveEvidence): void {
  const states = [...evidence.observedByArtifact.values()].sort((a, b) => a.artifactKey.localeCompare(b.artifactKey));
  evidence.artifactStates = states;
  evidence.artifactKeys = states.map((state) => state.artifactKey);
  evidence.observedChangeCount = states.length;
  const observedAt = new Date().toISOString();
  evidence.firstObservedAt = states.length > 0 ? evidence.firstObservedAt ?? observedAt : undefined;
  evidence.lastObservedAt = states.length > 0 ? observedAt : undefined;
}

function publicEvidence(evidence: ActiveEvidence): QueryWorkEvidence {
  const {
    baselineByArtifact: _baselineByArtifact,
    observedByArtifact: _observedByArtifact,
    ...record
  } = evidence;
  return structuredClone(record);
}

function sameArtifactState(a: ArtifactStateEvidence | undefined, b: ArtifactStateEvidence): boolean {
  if (!a) {
    return false;
  }
  return a.worktreeStateKey === b.worktreeStateKey
    && a.indexStateKey === b.indexStateKey
    && a.changeKind === b.changeKind;
}

function acceptsSnapshot(evidence: QueryWorkEvidence, snapshot: RepositorySnapshotObservation): boolean {
  return evidence.status === "active"
    || (
      evidence.status === "settling"
      && evidence.settlingUntil != null
      && snapshot.observedAt <= evidence.settlingUntil
    );
}

function evidenceKey(queryId: string, repoKey: string): string {
  return `${queryId}:${repoKey}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}

function summarizeIds(values: string[]): string | null {
  const unique = uniqueStrings(values);
  if (unique.length === 0) {
    return null;
  }
  const shown = unique.slice(0, 8);
  return shown.length === unique.length
    ? shown.join(",")
    : `${shown.join(",")},+${unique.length - shown.length}`;
}
