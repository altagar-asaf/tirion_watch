import { describe, expect, it } from "vitest";
import {
  AgenticQueryRun,
  AttributionEpoch,
  DiagnosticEvent,
  ObservedCommitCandidate,
  PartialAgenticQueryRun,
  QueryWorkEvidence,
  RepositoryObservation,
  RepositoryObservationEvent,
  RepositorySnapshotObservation,
  WorkspaceEvidenceLedger
} from "../types";
import { DefaultWorkspaceChangeTracker } from "./workspaceChangeTracker";

describe("DefaultWorkspaceChangeTracker", () => {
  it("persists exact state evidence from a clean baseline", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const ledger = new MemoryEvidenceLedger();
    const emitted: QueryWorkEvidence[] = [];
    const tracker = new DefaultWorkspaceChangeTracker(observations, ledger, () => undefined, (evidence) => emitted.push(...evidence));
    await tracker.start();
    await tracker.observeRun(runningRun("query-1"));

    expect(emitted[0]).toMatchObject({
      queryId: "query-1",
      repoKey: "repo-key",
      observedChangeCount: 0,
      headCommitAtStart: "base"
    });

    await observations.emit({ kind: "snapshot", snapshot: snapshot([state("artifact-a", "state-a", 2)], 2) });

    const [evidence] = tracker.pendingEvidence();
    expect(evidence).toMatchObject({
      epochId: "epoch-1",
      baselineTrusted: true,
      baselineSequence: 1,
      artifactKeys: ["artifact-a"]
    });
    expect(evidence.artifactStates?.[0].worktreeStateKey).toBe("state-a");
    expect(emitted).toHaveLength(2);
  });

  it("binds the current repository baseline without blocking on a full refresh", async () => {
    let releaseRefresh!: () => void;
    let refreshStarted = false;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const observations = new FakeRepositoryObservation(snapshot([], 1), async () => {
      refreshStarted = true;
      await refreshBlocked;
    });
    const emitted: QueryWorkEvidence[] = [];
    const tracker = new DefaultWorkspaceChangeTracker(observations, new MemoryEvidenceLedger(), () => undefined, (evidence) => emitted.push(...evidence));
    await tracker.start();

    await tracker.observeRun(runningRun("query-1"));

    expect(refreshStarted).toBe(true);
    expect(emitted).toContainEqual(expect.objectContaining({
      queryId: "query-1",
      repoKey: "repo-key",
      observedChangeCount: 0,
      headCommitAtStart: "base"
    }));

    releaseRefresh();
    await tracker.stop();
  });

  it("defers zero-change baseline handoff when multiple repositories are open", async () => {
    const observations = new FakeRepositoryObservation([
      snapshot([], 1, { repoKey: "repo-a", epochId: "epoch-a", headCommit: "base-a" }),
      snapshot([], 1, { repoKey: "repo-b", epochId: "epoch-b", headCommit: "base-b" })
    ]);
    const emitted: QueryWorkEvidence[] = [];
    const events: DiagnosticEvent[] = [];
    const tracker = new DefaultWorkspaceChangeTracker(
      observations,
      new MemoryEvidenceLedger(),
      (event) => events.push(event),
      (evidence) => emitted.push(...evidence)
    );
    await tracker.start();

    await tracker.observeRun(runningRun("query-1"));

    expect(emitted).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "constructLifecycle",
      construct: "WorkspaceChangeTracker",
      operation: "handoff",
      state: "deferred",
      reason: "workspace_evidence_handoff_deferred_multi_repository_baseline",
      queryId: "query-1",
      details: expect.objectContaining({
        evidenceCount: 2,
        changedEvidenceCount: 0,
        zeroChangeEvidenceCount: 2,
        repoCount: 2
      })
    }));
  });

  it("records index and worktree states independently for partial staging", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const tracker = new DefaultWorkspaceChangeTracker(observations, new MemoryEvidenceLedger());
    await tracker.start();
    await tracker.observeRun(runningRun("query-1"));

    await observations.emit({
      kind: "snapshot",
      snapshot: snapshot([{
        artifactKey: "artifact-a",
        worktreeStateKey: "worktree-state",
        indexStateKey: "index-state",
        changeKind: "modified",
        observedSequence: 2
      }], 2)
    });

    expect(tracker.pendingEvidence()[0].artifactStates?.[0]).toMatchObject({
      worktreeStateKey: "worktree-state",
      indexStateKey: "index-state"
    });
  });

  it("keeps a durable settling window and captures changes that land after run completion", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const ledger = new MemoryEvidenceLedger();
    const emitted: QueryWorkEvidence[] = [];
    const events: DiagnosticEvent[] = [];
    const tracker = new DefaultWorkspaceChangeTracker(
      observations,
      ledger,
      (event) => events.push(event),
      (evidence) => emitted.push(...evidence),
      60_000,
      () => new Date("2026-06-05T00:00:01.000Z").getTime()
    );
    await tracker.start();
    await tracker.observeRun(runningRun("query-1"));

    await tracker.observeRunCompleted(completedRun("query-1"));
    expect((await ledger.listEvidence({}))[0]).toMatchObject({
      queryId: "query-1",
      status: "settling",
      observedChangeCount: 0
    });

    await observations.emit({ kind: "snapshot", snapshot: snapshot([state("artifact-a", "state-a", 2)], 2) });

    expect(tracker.pendingEvidence()[0]).toMatchObject({
      queryId: "query-1",
      status: "settling",
      artifactKeys: ["artifact-a"]
    });
    expect(emitted.at(-1)?.artifactStates?.[0].worktreeStateKey).toBe("state-a");
    expect(events.filter((event) => event.kind === "attributionDecision").map((event) => event.reason)).toEqual([
      "workspace_evidence_settling_started",
      "post_run_settling_evidence_observed"
    ]);
    await tracker.stop();
  });

  it("closes a settling run window when a newer run starts in the same repository", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const ledger = new MemoryEvidenceLedger();
    const tracker = new DefaultWorkspaceChangeTracker(
      observations,
      ledger,
      () => undefined,
      () => undefined,
      60_000,
      () => new Date("2026-06-05T00:00:02.000Z").getTime()
    );
    await tracker.start();
    await tracker.observeRun(runningRun("query-1"));
    await tracker.observeRunCompleted(completedRun("query-1"));

    await tracker.observeRun({
      ...runningRun("query-2"),
      startedAt: "2026-06-05T00:00:02.000Z",
      queryStartedAt: "2026-06-05T00:00:02.000Z"
    });
    await observations.emit({
      kind: "snapshot",
      snapshot: snapshot([state("artifact-a", "state-a", 2)], 2, {
        observedAt: "2026-06-05T00:00:03.000Z"
      })
    });

    expect(tracker.pendingEvidence()).toEqual([
      expect.objectContaining({
        queryId: "query-2",
        artifactKeys: ["artifact-a"]
      })
    ]);
    expect((await ledger.listEvidence()).map((item) => item.queryId)).not.toContain("query-1");
    await tracker.stop();
  });

  it("restores an unfinished settling window after reload", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const ledger = new MemoryEvidenceLedger();
    const now = () => new Date("2026-06-05T00:00:01.000Z").getTime();
    const first = new DefaultWorkspaceChangeTracker(observations, ledger, () => undefined, () => undefined, 60_000, now);
    await first.start();
    await first.observeRun(runningRun("query-1"));
    await first.observeRunCompleted(completedRun("query-1"));
    await first.stop();

    const restarted = new DefaultWorkspaceChangeTracker(observations, ledger, () => undefined, () => undefined, 60_000, now);
    await restarted.start();
    await observations.emit({ kind: "snapshot", snapshot: snapshot([state("artifact-a", "state-a", 2)], 2) });

    expect(restarted.pendingEvidence()[0]).toMatchObject({
      queryId: "query-1",
      status: "settling",
      artifactKeys: ["artifact-a"]
    });
    await restarted.stop();
  });

  it("retires a settled zero-change window instead of leaving it active indefinitely", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const ledger = new MemoryEvidenceLedger();
    let now = new Date("2026-06-05T00:00:01.000Z").getTime();
    const first = new DefaultWorkspaceChangeTracker(observations, ledger, () => undefined, () => undefined, 1_000, () => now);
    await first.start();
    await first.observeRun(runningRun("query-1"));
    await first.observeRunCompleted(completedRun("query-1"));
    await first.stop();

    now = new Date("2026-06-05T00:00:03.000Z").getTime();
    const restarted = new DefaultWorkspaceChangeTracker(observations, ledger, () => undefined, () => undefined, 1_000, () => now);
    await restarted.start();

    expect(restarted.pendingEvidence()).toEqual([]);
    expect(await ledger.listEvidence({})).toEqual([]);
    await restarted.stop();
  });

  it("keeps multiple query occurrences for the same content state", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const tracker = new DefaultWorkspaceChangeTracker(observations, new MemoryEvidenceLedger());
    await tracker.start();
    await tracker.observeRun(runningRun("query-1"));
    await tracker.observeRun(runningRun("query-2"));

    await observations.emit({ kind: "snapshot", snapshot: snapshot([state("artifact-a", "state-a", 2)], 2) });

    expect(tracker.pendingEvidence().map((item) => item.queryId).sort()).toEqual(["query-1", "query-2"]);
  });

  it("records when a matched repository snapshot carries no workspace delta", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const events: DiagnosticEvent[] = [];
    const tracker = new DefaultWorkspaceChangeTracker(
      observations,
      new MemoryEvidenceLedger(),
      (event) => events.push(event)
    );
    await tracker.start();
    await tracker.observeRun(runningRun("query-1"));

    await observations.emit({ kind: "snapshot", snapshot: snapshot([], 2) });

    expect(events).toContainEqual(expect.objectContaining({
      kind: "constructLifecycle",
      construct: "WorkspaceChangeTracker",
      operation: "snapshot_match",
      state: "no_changes_observed",
      reason: "repository_snapshot_no_workspace_changes",
      details: expect.objectContaining({
        matchingEvidenceCount: 1,
        skippedEpochMismatchCount: 0,
        skippedOutsideWindowCount: 0
      })
    }));
  });

  it("restores active evidence windows after reload", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const ledger = new MemoryEvidenceLedger();
    const now = () => new Date("2026-06-05T00:00:01.000Z").getTime();
    const first = new DefaultWorkspaceChangeTracker(observations, ledger, () => undefined, () => undefined, 60_000, now);
    await first.start();
    await first.observeRun(runningRun("query-1"));
    await first.stop();

    const restarted = new DefaultWorkspaceChangeTracker(observations, ledger, () => undefined, () => undefined, 60_000, now);
    await restarted.start();
    await observations.emit({ kind: "snapshot", snapshot: snapshot([state("artifact-a", "state-a", 2)], 2) });

    expect(restarted.pendingEvidence()[0].artifactKeys).toEqual(["artifact-a"]);
  });

  it("retires stale active evidence before it can absorb unrelated later changes", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const ledger = new MemoryEvidenceLedger();
    const events: DiagnosticEvent[] = [];
    let now = new Date("2026-06-05T00:00:01.000Z").getTime();
    const first = new DefaultWorkspaceChangeTracker(
      observations,
      ledger,
      (event) => events.push(event),
      () => undefined,
      60_000,
      () => now,
      4 * 60 * 60 * 1000
    );
    await first.start();
    await first.observeRun(runningRun("query-1"));
    await first.stop();

    now = new Date("2026-06-05T05:00:00.000Z").getTime();
    const restarted = new DefaultWorkspaceChangeTracker(
      observations,
      ledger,
      (event) => events.push(event),
      () => undefined,
      60_000,
      () => now,
      4 * 60 * 60 * 1000
    );
    await restarted.start();
    await observations.emit({ kind: "snapshot", snapshot: snapshot([state("artifact-a", "state-a", 2)], 2) });

    expect(restarted.pendingEvidence()).toEqual([]);
    expect(await ledger.listEvidence({})).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "attributionDecision",
      queryId: "query-1",
      reason: "workspace_active_evidence_expired"
    }));
    await restarted.stop();
  });

  it("retires restored evidence when repository observation starts a new epoch", async () => {
    const observations = new FakeRepositoryObservation(snapshot([], 1));
    const ledger = new MemoryEvidenceLedger();
    const first = new DefaultWorkspaceChangeTracker(observations, ledger);
    await first.start();
    await first.observeRun(runningRun("query-1"));
    await first.stop();
    const restarted = new DefaultWorkspaceChangeTracker(observations, ledger);
    await restarted.start();

    await observations.emit({
      kind: "snapshot",
      snapshot: { ...snapshot([], 1), epochId: "epoch-2" }
    });

    expect(restarted.pendingEvidence()).toEqual([]);
    expect(await ledger.listEvidence({})).toEqual([]);
  });
});

class FakeRepositoryObservation implements RepositoryObservation {
  private handlers = new Set<(event: RepositoryObservationEvent) => void | Promise<void>>();
  private snapshots: RepositorySnapshotObservation[];

  constructor(
    current: RepositorySnapshotObservation | RepositorySnapshotObservation[],
    private readonly onRefresh: () => Promise<void> = async () => undefined
  ) {
    this.snapshots = Array.isArray(current)
      ? current.map((item) => structuredClone(item))
      : [structuredClone(current)];
  }

  start = async () => undefined;
  stop = async () => undefined;
  reset = async () => undefined;
  refresh = async () => this.onRefresh();
  currentSnapshots = () => this.snapshots.map((item) => structuredClone(item));
  listEpochs = async (): Promise<AttributionEpoch[]> => [];
  listCandidates = async (): Promise<ObservedCommitCandidate[]> => [];
  updateCandidate = async () => undefined;
  applyRetention = async () => 0;
  isAncestor = async () => true;
  resolveCommitMessage = async () => undefined;

  onObservation(handler: (event: RepositoryObservationEvent) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async emit(event: RepositoryObservationEvent): Promise<void> {
    if (event.kind === "snapshot") {
      this.snapshots = [event.snapshot];
    }
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}

class MemoryEvidenceLedger implements WorkspaceEvidenceLedger {
  private records = new Map<string, QueryWorkEvidence>();
  async upsertEvidence(evidence: QueryWorkEvidence): Promise<void> {
    this.records.set(`${evidence.queryId}:${evidence.repoKey}`, structuredClone(evidence));
  }
  async listEvidence(): Promise<QueryWorkEvidence[]> {
    return [...this.records.values()].map((item) => structuredClone(item));
  }
  async removeEvidence(queryId: string, repoKey: string): Promise<void> {
    this.records.delete(`${queryId}:${repoKey}`);
  }
  async applyRetention(): Promise<number> {
    return 0;
  }
  async clear(): Promise<void> {
    this.records.clear();
  }
}

function snapshot(
  artifactStates: RepositorySnapshotObservation["artifactStates"],
  observedSequence: number,
  overrides: Partial<RepositorySnapshotObservation> = {}
): RepositorySnapshotObservation {
  return {
    epochId: overrides.epochId ?? "epoch-1",
    repoKey: overrides.repoKey ?? "repo-key",
    headCommit: overrides.headCommit ?? "base",
    refKey: overrides.refKey ?? "ref-main",
    observedAt: "2026-06-05T00:00:00.000Z",
    observedSequence,
    dirty: artifactStates.length > 0,
    dirtyKnown: true,
    artifactStates
  };
}

function state(artifactKey: string, worktreeStateKey: string, observedSequence: number) {
  return { artifactKey, worktreeStateKey, changeKind: "modified" as const, observedSequence };
}

function runningRun(queryId: string): PartialAgenticQueryRun {
  return {
    schemaVersion: 3,
    id: `${queryId}-run`,
    traceId: `${queryId}-run`,
    queryId,
    queryStartedAt: "2026-06-05T00:00:00.000Z",
    initialQueryState: "unavailable",
    tokenUsageSource: "invoke_agent",
    status: "running",
    models: [],
    modelUsages: [],
    llmCallCount: 0,
    toolCallCount: 0,
    tools: [],
    warnings: []
  };
}

function completedRun(queryId: string): AgenticQueryRun {
  return {
    ...runningRun(queryId),
    status: "completed",
    startedAt: "2026-06-05T00:00:00.000Z",
    endedAt: "2026-06-05T00:00:01.000Z",
    costCoverage: "unavailable"
  };
}
