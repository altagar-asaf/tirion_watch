import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPrivacyGuard } from "../privacy/privacyGuard";
import { JsonlCommitAttributionLedger } from "../storage/commitAttributionLedger";
import { JsonlRunLedger } from "../storage/runLedger";
import { JsonlWorkEpisodeLedger } from "../storage/workEpisodeLedger";
import { JsonlWorkspaceEvidenceLedger } from "../storage/workspaceEvidenceLedger";
import {
  AgenticQueryRun,
  AgenticWorkEpisode,
  AgenticWorkEpisodeTracker,
  AttributionEpoch,
  ObservedCommitCandidate,
  QueryCostAttribution,
  QueryWorkEvidence,
  RepositoryObservation,
  RepositoryObservationEvent,
  RepositorySnapshotObservation,
  WorkEpisodeQuery,
  WorkspaceChangeTracker
} from "../types";
import { DefaultGitAttribution } from "./gitAttribution";
import { DefaultAgenticWorkEpisodeTracker } from "./agenticWorkEpisode";
import { DefaultWorkspaceChangeTracker } from "./workspaceChangeTracker";

describe("DefaultGitAttribution", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-attribution-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("allocates only when exact state continuity proves the commit", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);
    await persistCompletedRun(state, run("query-1", 15_000_000));

    await state.observations.addCandidate(candidate("commit-1", "state-a"));

    expect((await state.attribution.listCommitAttributions({}))[0]).toMatchObject({
      commitHash: "commit-1",
      queryIds: ["query-1"],
      allocatedNanoUsd: 15_000_000,
      decision: "reportable",
      proofKinds: ["exact_content_state"]
    });
  });

  it("retracts an arrival-order native causal rejection without letting the candidate remain reportable", async () => {
    const initial = causalEvidence("query-1", "state-a", ["node-write-a"]);
    const state = await attributionWith([episode(["query-1"], [initial])]);
    await persistCompletedRun(state, run("query-1", 15_000_000));

    await state.observations.addCandidate(candidate("commit-1", "state-a"));
    const [claimed] = await state.ledger.listQueryAttributions({});
    expect(claimed.allocations[0]?.proof?.matchedCausalWriteArtifacts).toEqual([{
      queryId: "query-1",
      artifactKey: "artifact-a",
      executionNodeId: "node-write-a"
    }]);

    state.tracker.replaceEvidence("query-1", causalEvidence("query-1", "state-a", [], ["node-write-a"]));
    await state.attribution.reconcile();

    const [retracted] = await state.ledger.listQueryAttributions({});
    expect(retracted).toMatchObject({ status: "rejected" });
    expect(retracted.allocations[0]).toMatchObject({ status: "superseded", decision: "superseded" });
    expect((await state.attribution.listCommitAttributions({}))[0]).toMatchObject({
      status: "superseded",
      decision: "superseded",
      allocatedNanoUsd: undefined
    });
    expect(await state.ledger.listCommitPublicationSnapshots({})).toEqual([
      expect.objectContaining({ commitHash: "commit-1", state: "superseded", allocatedNanoUsd: undefined })
    ]);
    expect((await state.observations.listCandidates())[0]).toMatchObject({
      decision: "pending_evidence",
      reasonCodes: expect.arrayContaining(["native_causal_write_retracted"])
    });
  });

  it("does not report same-file overlap when the committed state differs", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-agent")])]);
    await persistCompletedRun(state, run("query-1", 10_000_000));

    await state.observations.addCandidate(candidate("commit-1", "state-manual"));

    expect(await state.attribution.listCommitAttributions({})).toEqual([]);
    expect((await state.observations.listCandidates())[0].decision).toBe("pending_evidence");
  });

  it("inherits a proven claim across an unambiguous single-repo episode", async () => {
    const state = await attributionWith([episode(["query-1", "query-2"], [evidence("query-1", "state-a")])]);
    await persistCompletedRun(state, run("query-1", 7_000_000));
    await persistCompletedRun(state, run("query-2", 3_000_000));

    await state.observations.addCandidate(candidate("commit-1", "state-a"));

    const [summary] = await state.attribution.listCommitAttributions({});
    expect(summary.queryIds).toEqual(["query-1", "query-2"]);
    expect(summary.allocatedNanoUsd).toBe(10_000_000);
    expect(summary.inheritedQueryIds).toEqual(["query-2"]);
    expect(summary.proofKinds).toEqual(["episode_inheritance", "exact_content_state"]);
  });

  it("creates a verified claim before pricing and reconciles its estimate later", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);

    await state.observations.addCandidate(candidate("commit-1", "state-a"));
    expect((await state.attribution.listCommitAttributions({}))[0].allocatedNanoUsd).toBeUndefined();

    await persistCompletedRun(state, run("query-1", 9_000_000));
    expect((await state.attribution.listCommitAttributions({}))[0].allocatedNanoUsd).toBe(9_000_000);
  });

  it("publishes an allocation change when persisted pricing updates an already verified claim", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);
    await state.observations.addCandidate(candidate("commit-1", "state-a"));
    const changes: Array<{ kind: string; commitHash?: string }> = [];
    state.attribution.onDidChange((change) => changes.push(change));

    await state.runLedger.append(run("query-1", 9_000_000));
    await state.attribution.reconcilePersistedState();

    expect(changes).toContainEqual({ kind: "allocation_changed", commitHash: "commit-1" });
    expect((await state.attribution.listCommitPublicationSnapshots({}))[0]).toMatchObject({
      allocatedNanoUsd: 9_000_000,
      coverage: "complete"
    });
  });

  it("resolves a missing commit message from git for persisted summaries", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);
    await persistCompletedRun(state, run("query-1", 9_000_000));

    await state.observations.addCandidate(candidate("commit-1", "state-a"));
    const [stored] = await state.ledger.listQueryAttributions({});
    stored.allocations[0].commitMessage = undefined;
    await state.ledger.upsertQueryAttribution(stored);
    state.observations.setCommitMessage("commit-1", "Recovered commit subject");

    const [summary] = await state.attribution.listCommitAttributions({});
    expect(summary.commitMessage).toBe("Recovered commit subject");
  });

  it("reconciles revised pricing for the same persisted run without double counting", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);
    await persistCompletedRun(state, run("query-1", 1_000_000));
    await state.observations.addCandidate(candidate("commit-1", "state-a"));
    expect((await state.attribution.listCommitAttributions({}))[0].allocatedNanoUsd).toBe(1_000_000);

    await persistCompletedRun(state, run("query-1", 9_000_000));

    expect((await state.attribution.listCommitAttributions({}))[0].allocatedNanoUsd).toBe(9_000_000);
  });

  it("adds a late pre-commit query to the already verified episode claim", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);
    await persistCompletedRun(state, run("query-1", 7_000_000));
    await state.observations.addCandidate(candidate("commit-1", "state-a"));

    state.tracker.addQuery("query-2");
    await persistCompletedRun(state, run("query-2", 3_000_000));

    const [summary] = await state.attribution.listCommitAttributions({});
    expect(summary.queryIds).toEqual(["query-1", "query-2"]);
    expect(summary.allocatedNanoUsd).toBe(10_000_000);
    expect(summary.inheritedQueryIds).toEqual(["query-2"]);
  });

  it("reconciles a durable commit candidate when evidence arrives later", async () => {
    const pendingEpisode = episode(["query-1"], []);
    pendingEpisode.repoKey = undefined;
    pendingEpisode.repoKeys = [];
    pendingEpisode.epochIds = [];
    const state = await attributionWith([pendingEpisode]);
    await persistCompletedRun(state, run("query-1", 9_000_000));
    await state.observations.addCandidate(candidate("commit-1", "state-a"));
    expect(await state.attribution.listCommitAttributions({})).toEqual([]);

    state.tracker.bindEvidence("query-1", evidence("query-1", "state-a"));
    await state.attribution.reconcile();

    expect((await state.attribution.listCommitAttributions({}))[0].commitHash).toBe("commit-1");
  });

  it("recovers a reportable claim from a stale episode when the candidate was observed during its valid claim window", async () => {
    const staleEpisode = episode(["query-1"], [evidence("query-1", "state-a")]);
    staleEpisode.status = "stale";
    const state = await attributionWith([staleEpisode]);
    await persistCompletedRun(state, run("query-1", 9_000_000));

    await state.observations.addCandidate(candidate("commit-1", "state-a"));

    expect((await state.attribution.listCommitAttributions({}))[0]).toMatchObject({
      commitHash: "commit-1",
      queryIds: ["query-1"],
      allocatedNanoUsd: 9_000_000,
      decision: "reportable"
    });
  });

  it("reports a fresh unbound episode instead of accumulating an unrelated old claim-window failure", async () => {
    const oldBound = episode(["old-query"], [evidence("old-query", "old-state")]);
    oldBound.startedAt = "2026-06-04T00:00:00.000Z";
    oldBound.lastAgentActivityAt = "2026-06-04T00:01:00.000Z";
    const freshUnbound = episode(["fresh-query"], []);
    freshUnbound.repoKey = undefined;
    freshUnbound.repoKeys = [];
    freshUnbound.epochIds = [];
    freshUnbound.startedAt = "2026-06-05T00:01:00.000Z";
    freshUnbound.lastAgentActivityAt = "2026-06-05T00:02:00.000Z";
    const state = await attributionWith([oldBound, freshUnbound]);
    await persistCompletedRun(state, run("fresh-query", 9_000_000));

    await state.observations.addCandidate(candidate("commit-1", "state-a"));

    const [observed] = await state.observations.listCandidates();
    expect(observed.reasonCodes).toContain("fresh_episode_unbound_no_workspace_evidence");
    expect(observed.reasonCodes).not.toContain("claim_window_expired");
    expect(observed.reasonCodes).not.toContain("matching_repository_episode_claim_window_expired");
  });

  it("emits candidate evaluation lifecycle details while waiting for workspace evidence", async () => {
    const events: DiagnosticEvent[] = [];
    const freshUnbound = episode(["query-1"], []);
    freshUnbound.repoKey = undefined;
    freshUnbound.repoKeys = [];
    freshUnbound.epochIds = [];
    const state = await attributionWith([freshUnbound], (event) => events.push(event));
    await persistCompletedRun(state, run("query-1", 9_000_000));

    await state.observations.addCandidate(candidate("commit-1", "state-a"));

    expect(events).toContainEqual(expect.objectContaining({
      kind: "constructLifecycle",
      construct: "GitAttribution",
      operation: "candidate_evaluation",
      state: "waiting_for_workspace_evidence",
      reason: "fresh_episode_unbound_no_workspace_evidence",
      commitHash: "commit-1",
      details: expect.objectContaining({
        candidateDecision: "pending_evidence",
        relevantEpisodeCount: 0,
        freshUnboundEpisodeCount: 1,
        reasonCodes: expect.stringContaining("fresh_episode_unbound_no_workspace_evidence")
      })
    }));
  });

  it("attributes a commit when exact content evidence lands during the post-run settling window", async () => {
    const observations = new FakeRepositoryObservation(repositorySnapshot([], 1, "2026-06-05T00:00:00.000Z"));
    const privacy = new DefaultPrivacyGuard();
    const episodeTracker = new DefaultAgenticWorkEpisodeTracker(
      new JsonlWorkEpisodeLedger(dir, privacy),
      () => undefined,
      4 * 60 * 60 * 1000,
      () => new Date("2026-06-05T00:01:00.000Z").getTime()
    );
    const runLedger = new JsonlRunLedger(dir);
    const attributionLedger = new JsonlCommitAttributionLedger(dir, privacy);
    let attribution: DefaultGitAttribution;
    const workspaceTracker = new DefaultWorkspaceChangeTracker(
      observations,
      new JsonlWorkspaceEvidenceLedger(dir, privacy),
      () => undefined,
      async (workspaceEvidence) => {
        await episodeTracker.observeWorkspaceEvidence(workspaceEvidence);
        await attribution.reconcile();
      },
      2 * 60 * 1000,
      () => new Date("2026-06-05T00:01:00.000Z").getTime()
    );
    attribution = new DefaultGitAttribution(
      observations,
      episodeTracker,
      workspaceTracker,
      runLedger,
      attributionLedger,
      () => undefined,
      () => new Date("2026-06-05T00:03:00.000Z").getTime()
    );
    await episodeTracker.start();
    await workspaceTracker.start();
    await attribution.start();
    const completedRun = run("query-1", 11_000_000);
    await episodeTracker.observeRun(completedRun);
    await workspaceTracker.observeRun(completedRun);
    await runLedger.append(completedRun);
    await episodeTracker.observeRunCompleted(completedRun);
    await workspaceTracker.observeRunCompleted(completedRun);
    await attribution.observeRunCompleted(completedRun);

    await observations.addSnapshot(repositorySnapshot([{
      artifactKey: "artifact-a",
      worktreeStateKey: "settled-state",
      changeKind: "modified",
      observedSequence: 2
    }], 2, "2026-06-05T00:01:20.000Z"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await observations.addCandidate(candidate("commit-after-settle", "settled-state"));

    expect((await attribution.listCommitAttributions({}))[0]).toMatchObject({
      commitHash: "commit-after-settle",
      queryIds: ["query-1"],
      allocatedNanoUsd: 11_000_000,
      decision: "reportable"
    });
    await attribution.stop();
    await workspaceTracker.stop();
    await episodeTracker.stop();
  });

  it("does not allocate one query twice", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);
    await persistCompletedRun(state, run("query-1", 8_000_000));

    await state.observations.addCandidate(candidate("commit-1", "state-a"));
    await state.observations.addCandidate(candidate("commit-2", "state-a", 4));

    expect(await state.attribution.listCommitAttributions({})).toHaveLength(1);
  });

  it("does not treat a branch switch as a rewrite", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);
    await persistCompletedRun(state, run("query-1", 8_000_000));
    await state.observations.addCandidate(candidate("commit-1", "state-a"));
    state.observations.setReachable("commit-1", false);

    await state.observations.emit({
      kind: "transition",
      repoKey: "repo-key",
      epochId: "epoch-1",
      refKey: "ref-main",
      transitionKind: "branch_switch",
      observedAt: "2026-06-05T00:05:00.000Z"
    });

    expect((await state.attribution.listCommitAttributions({}))[0].status).toBe("active");
  });

  it("moves a confirmed rewritten claim only after replacement proof", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);
    await persistCompletedRun(state, run("query-1", 12_000_000));
    await state.observations.addCandidate(candidate("commit-1", "state-a"));
    state.observations.setReachable("commit-1", false);

    await state.observations.emit({
      kind: "transition",
      repoKey: "repo-key",
      epochId: "epoch-1",
      refKey: "ref-main",
      transitionKind: "non_fast_forward_ref_update",
      observedAt: "2026-06-05T00:05:00.000Z"
    });
    expect((await state.attribution.listCommitAttributions({}))).toEqual([]);

    await state.observations.addCandidate(candidate("commit-2", "state-a", 4, "non_fast_forward_ref_update"));
    const summaries = await state.attribution.listCommitAttributions({});
    expect(summaries.find((item) => item.commitHash === "commit-1")?.status).toBe("superseded");
    expect(summaries.find((item) => item.commitHash === "commit-2")?.allocatedNanoUsd).toBe(12_000_000);
  });

  it("supersedes an earlier same-episode commit when a later verified commit better represents the whole conversation", async () => {
    const state = await attributionWith([episode(["query-1"], [evidence("query-1", "state-a")])]);
    await persistCompletedRun(state, run("query-1", 7_000_000));

    await state.observations.addCandidate({
      ...candidate("commit-1", "state-a"),
      observedAt: "2026-06-05T00:02:00.000Z"
    });

    state.tracker.addQuery("query-2");
    state.tracker.bindEvidence("query-2", evidence("query-2", "state-b"));
    await persistCompletedRun(state, run("query-2", 5_000_000));

    await state.observations.addCandidate({
      ...candidate("commit-2", "state-b", 4),
      parentHashes: ["commit-1"],
      observedAt: "2026-06-05T00:04:00.000Z"
    });

    const summaries = await state.attribution.listCommitAttributions({});
    expect(summaries.find((item) => item.commitHash === "commit-1")?.status).toBe("superseded");
    expect(summaries.find((item) => item.commitHash === "commit-2")).toMatchObject({
      queryIds: ["query-1", "query-2"],
      allocatedNanoUsd: 12_000_000,
      inheritedQueryIds: ["query-1"],
      status: "active"
    });
  });

  it("does not transfer a claimed episode onto a later commit from another session without a fresh claim from that episode", async () => {
    const events: DiagnosticEvent[] = [];
    const firstEpisode = episode(["query-1", "query-2"], [evidence("query-1", "state-b")]);
    firstEpisode.chatSessionId = "session-1";
    firstEpisode.startedAt = "2026-06-05T00:00:00.000Z";
    firstEpisode.lastQueryActivityAt = "2026-06-05T00:02:00.000Z";
    firstEpisode.lastAgentActivityAt = "2026-06-05T00:02:00.000Z";
    const secondEpisode = episode(["query-3"], [evidence("query-3", "state-c")]);
    secondEpisode.episodeId = "episode-query-3";
    secondEpisode.chatSessionId = "session-2";
    secondEpisode.startedAt = "2026-06-05T00:03:00.000Z";
    secondEpisode.lastQueryActivityAt = "2026-06-05T00:04:00.000Z";
    secondEpisode.lastAgentActivityAt = "2026-06-05T00:04:00.000Z";
    const state = await attributionWith([firstEpisode, secondEpisode], (event) => events.push(event));
    await persistCompletedRun(state, run("query-1", 7_000_000, "session-1"));
    await persistCompletedRun(state, run("query-2", 5_000_000, "session-1"));
    await persistCompletedRun(state, run("query-3", 3_000_000, "session-2"));

    await state.observations.addCandidate({
      ...candidate("commit-1", "state-b"),
      observedAt: "2026-06-05T00:02:30.000Z"
    });

    state.tracker.bindEvidence("query-1", evidence("query-1", "state-c"));

    await state.observations.addCandidate({
      ...candidate("commit-2", "state-c", 4),
      parentHashes: ["commit-1"],
      observedAt: "2026-06-05T00:05:00.000Z"
    });

    const summaries = await state.attribution.listCommitAttributions({});
    expect(summaries.find((item) => item.commitHash === "commit-1")).toMatchObject({
      queryIds: ["query-1", "query-2"],
      allocatedNanoUsd: 12_000_000,
      status: "active"
    });
    expect(summaries.find((item) => item.commitHash === "commit-2")).toMatchObject({
      queryIds: ["query-3"],
      allocatedNanoUsd: 3_000_000,
      status: "active"
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: "constructLifecycle",
      construct: "GitAttribution",
      operation: "claim_transfer",
      state: "blocked",
      reason: "episode_supersession_requires_fresh_episode_claim",
      episodeId: "episode-query-1-query-2",
      commitHash: "commit-2",
      details: expect.objectContaining({
        transferableQueryCount: 2,
        claimedQueryCount: 0
      })
    }));
  });

  it("quarantines pre-epoch allocations instead of surfacing them", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    const runLedger = new JsonlRunLedger(dir);
    await ledger.upsertQueryAttribution(legacyAttribution());
    const observations = new FakeRepositoryObservation();
    const attribution = new DefaultGitAttribution(
      observations,
      new FakeEpisodeTracker([]),
      new FakeWorkspaceTracker(),
      runLedger,
      ledger,
      () => undefined,
      () => new Date("2026-06-05T01:00:00.000Z").getTime()
    );

    await attribution.start();

    expect(await attribution.listCommitAttributions({})).toEqual([]);
    expect((await ledger.listQueryAttributions({}))[0].status).toBe("legacy_unverified");
  });

  async function attributionWith(
    episodes: AgenticWorkEpisode[],
    recordEvent: (event: DiagnosticEvent) => void = () => undefined
  ) {
    const observations = new FakeRepositoryObservation();
    const tracker = new FakeEpisodeTracker(episodes);
    const workspace = new FakeWorkspaceTracker();
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    const runLedger = new JsonlRunLedger(dir);
    const attribution = new DefaultGitAttribution(
      observations,
      tracker,
      workspace,
      runLedger,
      ledger,
      recordEvent,
      () => new Date("2026-06-05T01:00:00.000Z").getTime()
    );
    await attribution.start();
    return { attribution, observations, tracker, workspace, ledger, runLedger };
  }
});

async function persistCompletedRun(
  state: { runLedger: JsonlRunLedger; attribution: DefaultGitAttribution },
  completedRun: AgenticQueryRun
): Promise<void> {
  await state.runLedger.append(completedRun);
  await state.attribution.observeRunCompleted(completedRun);
}

class FakeRepositoryObservation implements RepositoryObservation {
  private handlers = new Set<(event: RepositoryObservationEvent) => void | Promise<void>>();
  private candidates: ObservedCommitCandidate[] = [];
  private reachable = new Map<string, boolean>();
  private commitMessages = new Map<string, string>();

  constructor(private snapshot?: RepositorySnapshotObservation) {}

  start = async () => undefined;
  stop = async () => undefined;
  reset = async () => undefined;
  refresh = async () => undefined;
  currentSnapshots = (): RepositorySnapshotObservation[] => this.snapshot ? [structuredClone(this.snapshot)] : [];
  listEpochs = async (): Promise<AttributionEpoch[]> => [{
    epochId: "epoch-1",
    repoKey: "repo-key",
    startedAt: "2026-06-05T00:00:00.000Z",
    initialHead: "base",
    cursorHead: "base",
    refHeads: { "ref-main": "current-ref-head" },
    nextSequence: 1,
    status: "active"
  }];
  listCandidates = async () => this.candidates.map((item) => structuredClone(item));
  updateCandidate = async (candidate: ObservedCommitCandidate) => {
    const index = this.candidates.findIndex((item) => item.candidateId === candidate.candidateId);
    this.candidates[index] = structuredClone(candidate);
  };
  applyRetention = async () => 0;
  isAncestor = async (_repoKey: string, ancestor: string) => this.reachable.get(ancestor) ?? true;
  resolveCommitMessage = async (_repoKey: string, commitHash: string) => this.commitMessages.get(commitHash);

  onObservation(handler: (event: RepositoryObservationEvent) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async addCandidate(value: ObservedCommitCandidate): Promise<void> {
    this.candidates.push(structuredClone(value));
    if (value.commitMessage) {
      this.commitMessages.set(value.commitHash, value.commitMessage);
    }
    await this.emit({ kind: "commit_candidate", candidate: value });
  }

  async addSnapshot(value: RepositorySnapshotObservation): Promise<void> {
    this.snapshot = structuredClone(value);
    await this.emit({ kind: "snapshot", snapshot: value });
  }

  setReachable(commitHash: string, reachable: boolean): void {
    this.reachable.set(commitHash, reachable);
  }

  setCommitMessage(commitHash: string, message: string): void {
    this.commitMessages.set(commitHash, message);
  }

  async emit(event: RepositoryObservationEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}

class FakeEpisodeTracker implements AgenticWorkEpisodeTracker {
  constructor(private episodes: AgenticWorkEpisode[]) {}
  start = async () => undefined;
  stop = async () => undefined;
  observeRun = async () => undefined;
  observeRunCompleted = async () => undefined;
  observeWorkspaceEvidence = async () => undefined;
  listEpisodes = async (_query: WorkEpisodeQuery = {}) => this.episodes.map((item) => structuredClone(item));
  markClaimed = async (episodeId: string, commitHash: string, claimedAt: string) => {
    const episode = this.episodes.find((item) => item.episodeId === episodeId);
    if (episode) {
      episode.status = "claimed";
      episode.claimedByCommitHash = commitHash;
      episode.claimedAt = claimedAt;
    }
  };
  reopenSupersededCommit = async (commitHash: string) => {
    for (const episode of this.episodes.filter((item) => item.claimedByCommitHash === commitHash)) {
      episode.status = "open";
      episode.claimedByCommitHash = undefined;
    }
  };
  reset = async () => undefined;

  bindEvidence(queryId: string, evidenceRecord: QueryWorkEvidence): void {
    const episode = this.episodes.find((item) => item.queryIds.includes(queryId));
    if (!episode) {
      return;
    }
    episode.evidence.push(evidenceRecord);
    episode.repoKey = evidenceRecord.repoKey;
    episode.repoKeys = [evidenceRecord.repoKey];
    episode.epochIds = evidenceRecord.epochId ? [evidenceRecord.epochId] : [];
  }

  replaceEvidence(queryId: string, evidenceRecord: QueryWorkEvidence): void {
    const episode = this.episodes.find((item) => item.queryIds.includes(queryId));
    if (!episode) {
      return;
    }
    episode.evidence = episode.evidence.map((existing) =>
      existing.queryId === queryId
      && existing.repoKey === evidenceRecord.repoKey
      && existing.epochId === evidenceRecord.epochId
        ? evidenceRecord
        : existing
    );
  }

  addQuery(queryId: string): void {
    const episode = this.episodes[0];
    episode.queryIds.push(queryId);
    episode.runIds.push(`${queryId}-run`);
    episode.lastQueryActivityAt = "2026-06-05T00:03:30.000Z";
    episode.lastAgentActivityAt = "2026-06-05T00:03:30.000Z";
  }
}

class FakeWorkspaceTracker implements WorkspaceChangeTracker {
  resolved: string[] = [];
  start = async () => undefined;
  stop = async () => undefined;
  observeRun = async () => undefined;
  observeRunCompleted = async () => undefined;
  pendingEvidence = () => [];
  resolveQueries = async (queryIds: string[]) => { this.resolved.push(...queryIds); };
  reset = async () => undefined;
}

function candidate(
  commitHash: string,
  stateKey: string,
  observedSequence = 3,
  transitionKind: ObservedCommitCandidate["transitionKind"] = "fast_forward"
): ObservedCommitCandidate {
  return {
    candidateId: `epoch-1:${commitHash}`,
    epochId: "epoch-1",
    repoKey: "repo-key",
    commitHash,
    parentHashes: ["base"],
    refKey: "ref-main",
    observedAt: "2026-06-05T00:03:00.000Z",
    observedSequence,
    artifactStates: [{
      artifactKey: "artifact-a",
      stateKey,
      changeKind: "modified",
      observedSequence
    }],
    transitionKind,
    decision: "pending_evidence",
    reasonCodes: ["commit_observed_after_epoch"]
  };
}

function repositorySnapshot(
  artifactStates: RepositorySnapshotObservation["artifactStates"],
  observedSequence: number,
  observedAt: string
): RepositorySnapshotObservation {
  return {
    epochId: "epoch-1",
    repoKey: "repo-key",
    headCommit: "base",
    refKey: "ref-main",
    observedAt,
    observedSequence,
    dirty: artifactStates.length > 0,
    dirtyKnown: true,
    artifactStates
  };
}

function episode(queryIds: string[], evidenceRecords: QueryWorkEvidence[]): AgenticWorkEpisode {
  return {
    episodeId: `episode-${queryIds.join("-")}`,
    repoKey: "repo-key",
    repoKeys: ["repo-key"],
    epochIds: ["epoch-1"],
    chatSessionId: "session-1",
    queryIds,
    runIds: queryIds.map((queryId) => `${queryId}-run`),
    startedAt: "2026-06-05T00:00:00.000Z",
    lastQueryActivityAt: "2026-06-05T00:01:00.000Z",
    lastAgentActivityAt: "2026-06-05T00:01:00.000Z",
    status: "open",
    decision: "pending_evidence",
    evidence: evidenceRecords
  };
}

function evidence(queryId: string, worktreeStateKey: string): QueryWorkEvidence {
  return {
    queryId,
    runIds: [`${queryId}-run`],
    repoKey: "repo-key",
    epochId: "epoch-1",
    startedAt: "2026-06-05T00:00:00.000Z",
    completedAt: "2026-06-05T00:01:00.000Z",
    baselineTrusted: true,
    baselineReasons: ["clean_baseline"],
    headCommitAtStart: "base",
    baselineSequence: 1,
    dirtyAtStart: false,
    observedChangeCount: 1,
    artifactKeys: ["artifact-a"],
    artifactStates: [{
      artifactKey: "artifact-a",
      worktreeStateKey,
      changeKind: "modified",
      observedSequence: 2
    }],
    addedLines: 1,
    deletedLines: 0,
    status: "completed"
  };
}

function causalEvidence(
  queryId: string,
  worktreeStateKey: string,
  successfulNodeIds: string[],
  nativeRejectedNodeIds: string[] = []
): QueryWorkEvidence {
  const base = evidence(queryId, worktreeStateKey);
  return {
    ...base,
    causalArtifactKeys: successfulNodeIds.length > 0 ? ["artifact-a"] : [],
    causalWriteArtifacts: successfulNodeIds.map((executionNodeId) => ({
      artifactKey: "artifact-a",
      executionNodeId
    })),
    nativeRejectedCausalWriteArtifacts: nativeRejectedNodeIds.map((executionNodeId) => ({
      artifactKey: "artifact-a",
      executionNodeId
    })),
    causalWriteArtifactsComplete: true
  };
}

function run(queryId: string, estimatedNanoUsd: number, chatSessionId = "session-1"): AgenticQueryRun {
  return {
    schemaVersion: 2,
    id: `${queryId}-run`,
    traceId: `${queryId}-run`,
    queryId,
    queryStartedAt: "2026-06-05T00:00:00.000Z",
    chatSessionId,
    initialQueryState: "unavailable",
    tokenUsageSource: "invoke_agent",
    status: "completed",
    models: [],
    modelUsages: [],
    llmCallCount: 0,
    toolCallCount: 0,
    tools: [],
    warnings: [],
    startedAt: "2026-06-05T00:00:00.000Z",
    endedAt: "2026-06-05T00:01:00.000Z",
    costCoverage: "complete",
    estimatedNanoUsd,
    estimatedUsd: estimatedNanoUsd / 1_000_000_000,
    estimatedAiCredits: estimatedNanoUsd / 10_000_000
  };
}

function legacyAttribution(): QueryCostAttribution {
  return {
    queryId: "legacy-query",
    runIds: [],
    estimatedNanoUsd: 5,
    costCoverage: "complete",
    status: "attributed",
    evidence: [],
    allocations: [{
      commitHash: "legacy-commit",
      parentHashes: [],
      repoKey: "repo-key",
      queryId: "legacy-query",
      allocatedNanoUsd: 5,
      allocationPolicy: "first_claim",
      confidence: "high",
      coverage: "complete",
      evidenceReasons: ["artifact_overlap"],
      status: "active",
      createdAt: "2026-06-05T00:00:00.000Z"
    }]
  };
}
