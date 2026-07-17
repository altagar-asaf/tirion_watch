import { describe, expect, it } from "vitest";
import {
  AgenticWorkEpisode,
  PartialAgenticQueryRun,
  QueryWorkEvidence,
  WorkEpisodeLedger,
  WorkEpisodeQuery
} from "../types";
import { DefaultAgenticWorkEpisodeTracker } from "./agenticWorkEpisode";

describe("DefaultAgenticWorkEpisodeTracker", () => {
  it("groups prompts by session before a repository is known", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();

    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));
    await tracker.observeRun(partialRun("query-2", "run-2", "session-1"));

    const [episode] = await tracker.listEpisodes({});
    expect(episode.queryIds).toEqual(["query-1", "query-2"]);
    expect(episode.repoKeys).toEqual([]);
    expect(episode.decision).toBe("pending_evidence");
  });

  it("binds an episode only to repositories with observed evidence", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();
    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));

    await tracker.observeWorkspaceEvidence([evidence("query-1", "repo-a", "epoch-a")]);

    const [episode] = await tracker.listEpisodes({});
    expect(episode.repoKeys).toEqual(["repo-a"]);
    expect(episode.epochIds).toEqual(["epoch-a"]);
    expect(episode.repoKey).toBe("repo-a");
  });

  it("replaces same-query evidence when repository observation starts a new epoch", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();
    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));
    await tracker.observeWorkspaceEvidence([evidence("query-1", "repo-a", "epoch-a")]);

    await tracker.observeWorkspaceEvidence([evidence("query-1", "repo-a", "epoch-b")]);

    const [episode] = await tracker.listEpisodes({});
    expect(episode.epochIds).toEqual(["epoch-b"]);
    expect(episode.evidence).toHaveLength(1);
    expect(episode.evidence[0].epochId).toBe("epoch-b");
  });

  it("preserves exact successful-write artifact pairs when same-epoch evidence merges", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();
    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));
    const first = {
      ...evidence("query-1", "repo-a", "epoch-a"),
      causalWriteArtifacts: [{
        artifactKey: "artifact-a",
        executionNodeId: "node_successful_write_a"
      }]
    };
    const later = {
      ...first,
      artifactKeys: ["artifact-a", "artifact-b"],
      causalArtifactKeys: ["artifact-a", "artifact-b"],
      causalWriteArtifacts: [{
        artifactKey: "artifact-b",
        executionNodeId: "node_successful_write_b"
      }]
    };

    await tracker.observeWorkspaceEvidence([first]);
    await tracker.observeWorkspaceEvidence([later]);

    expect((await tracker.listEpisodes({}))[0]?.evidence[0]?.causalWriteArtifacts).toEqual([
      { artifactKey: "artifact-a", executionNodeId: "node_successful_write_a" },
      { artifactKey: "artifact-b", executionNodeId: "node_successful_write_b" }
    ]);
  });

  it("replaces the native-rejected pair marker with a complete current causal census", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();
    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));
    const first = {
      ...evidence("query-1", "repo-a", "epoch-a"),
      causalArtifactKeys: ["artifact-a", "artifact-b"],
      causalWriteArtifacts: [{
        artifactKey: "artifact-a",
        executionNodeId: "node_successful_write_a"
      }, {
        artifactKey: "artifact-b",
        executionNodeId: "node_successful_write_b"
      }],
      nativeRejectedCausalWriteArtifacts: [],
      causalWriteArtifactsComplete: true
    };
    const retracted = {
      ...first,
      causalArtifactKeys: ["artifact-b"],
      causalWriteArtifacts: [{
        artifactKey: "artifact-b",
        executionNodeId: "node_successful_write_b"
      }],
      nativeRejectedCausalWriteArtifacts: [{
        artifactKey: "artifact-a",
        executionNodeId: "node_successful_write_a"
      }]
    };
    const noLongerMarked = {
      ...retracted,
      nativeRejectedCausalWriteArtifacts: []
    };

    await tracker.observeWorkspaceEvidence([first]);
    await tracker.observeWorkspaceEvidence([retracted]);
    expect((await tracker.listEpisodes({}))[0]?.evidence[0]).toMatchObject({
      causalWriteArtifacts: [{ artifactKey: "artifact-b", executionNodeId: "node_successful_write_b" }],
      nativeRejectedCausalWriteArtifacts: [{ artifactKey: "artifact-a", executionNodeId: "node_successful_write_a" }]
    });

    await tracker.observeWorkspaceEvidence([noLongerMarked]);
    expect((await tracker.listEpisodes({}))[0]?.evidence[0]?.nativeRejectedCausalWriteArtifacts).toEqual([]);
  });

  it("keeps concurrent sessions separate", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();

    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));
    await tracker.observeRun(partialRun("query-2", "run-2", "session-2"));

    expect(await tracker.listEpisodes({})).toHaveLength(2);
  });

  it("serializes concurrent updates into one episode", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      tracker.observeRun(partialRun(`query-${index}`, `run-${index}`, "session-1"))
    ));

    const [episode] = await tracker.listEpisodes({});
    expect(episode.queryIds).toHaveLength(20);
  });

  it("reopens claimed episodes only after a confirmed rewrite", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();
    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));
    const [episode] = await tracker.listEpisodes({});
    await tracker.markClaimed(episode.episodeId, "commit-1", "2026-06-05T00:03:00.000Z");

    await tracker.reopenSupersededCommit("commit-1");

    expect((await tracker.listEpisodes({}))[0]).toMatchObject({
      status: "open",
      decision: "rewrite_pending",
      claimedByCommitHash: undefined
    });
  });

  it("keeps later helper runs for an attributed query in the claimed episode", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();
    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));
    const [episode] = await tracker.listEpisodes({});
    await tracker.markClaimed(episode.episodeId, "commit-1", "2026-06-05T00:03:00.000Z");

    await tracker.observeRun(partialRun("query-1", "helper-run", "session-1", "2026-06-05T00:02:00.000Z"));

    const episodes = await tracker.listEpisodes({});
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ status: "claimed", decision: "reportable" });
    expect(episodes[0].runIds).toContain("helper-run");
  });

  it("joins late telemetry for a pre-commit query to the claimed episode", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();
    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));
    const [episode] = await tracker.listEpisodes({});
    await tracker.markClaimed(episode.episodeId, "commit-1", "2026-06-05T00:03:00.000Z");

    await tracker.observeRun(partialRun("query-2", "run-2", "session-1", "2026-06-05T00:02:00.000Z"));

    const episodes = await tracker.listEpisodes({});
    expect(episodes).toHaveLength(1);
    expect(episodes[0].queryIds).toEqual(["query-1", "query-2"]);
  });

  it("keeps extending a claimed session episode when the conversation continues after the first claim", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();
    await tracker.observeRun(partialRun("query-1", "run-1", "session-1"));
    const [episode] = await tracker.listEpisodes({});
    await tracker.markClaimed(episode.episodeId, "commit-1", "2026-06-05T00:03:00.000Z");

    await tracker.observeRun(partialRun("query-2", "run-2", "session-1", "2026-06-05T00:04:00.000Z"));

    const episodes = await tracker.listEpisodes({});
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      queryIds: ["query-1", "query-2"],
      status: "claimed",
      decision: "pending_evidence",
      claimedByCommitHash: "commit-1"
    });
  });

  it("does not rebuild episodes from historical telemetry replay", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    const tracker = trackerWith(ledger);
    await tracker.start();

    await tracker.observeRun(partialRun("query-old", "run-old", "session-old", "2026-06-04T00:00:00.000Z"));

    expect(await tracker.listEpisodes({})).toEqual([]);
  });

  it("marks persisted open episodes stale after the four-hour claim window", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    await ledger.upsertEpisode({
      observationSchemaVersion: 1,
      episodeId: "stale-episode",
      chatSessionId: "session-1",
      queryIds: ["query-1"],
      runIds: ["run-1"],
      startedAt: "2026-06-05T00:00:00.000Z",
      lastAgentActivityAt: "2026-06-05T00:01:00.000Z",
      status: "open",
      decision: "pending_evidence",
      evidence: []
    });
    const tracker = new DefaultAgenticWorkEpisodeTracker(
      ledger,
      () => undefined,
      4 * 60 * 60 * 1000,
      () => new Date("2026-06-05T05:00:00.000Z").getTime()
    );

    await tracker.start();

    expect((await tracker.listEpisodes({}))[0]).toMatchObject({ status: "stale", decision: "expired" });
  });

  it("quarantines pre-observation episodes so they cannot inherit a new claim", async () => {
    const ledger = new MemoryWorkEpisodeLedger();
    await ledger.upsertEpisode({
      episodeId: "legacy",
      chatSessionId: "session-1",
      queryIds: ["legacy-query"],
      runIds: ["legacy-run"],
      startedAt: "2026-06-05T00:00:00.000Z",
      lastAgentActivityAt: "2026-06-05T00:01:00.000Z",
      status: "open",
      evidence: []
    });
    const tracker = trackerWith(ledger);

    await tracker.start();

    expect((await tracker.listEpisodes({}))[0]).toMatchObject({
      status: "expired",
      decision: "legacy_unverified"
    });
  });
});

function trackerWith(ledger: WorkEpisodeLedger): DefaultAgenticWorkEpisodeTracker {
  return new DefaultAgenticWorkEpisodeTracker(
    ledger,
    () => undefined,
    4 * 60 * 60 * 1000,
    () => new Date("2026-06-05T01:00:00.000Z").getTime()
  );
}

function partialRun(queryId: string, id: string, chatSessionId: string, startedAt = "2026-06-05T00:00:00.000Z"): PartialAgenticQueryRun {
  return {
    schemaVersion: 3,
    id,
    traceId: id,
    queryId,
    chatSessionId,
    queryStartedAt: startedAt,
    startedAt,
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

function evidence(queryId: string, repoKey: string, epochId: string): QueryWorkEvidence {
  return {
    queryId,
    runIds: [`${queryId}-run`],
    repoKey,
    epochId,
    startedAt: "2026-06-05T00:00:00.000Z",
    baselineTrusted: true,
    baselineReasons: ["clean_baseline"],
    headCommitAtStart: "base",
    baselineSequence: 1,
    dirtyAtStart: false,
    observedChangeCount: 1,
    artifactKeys: ["artifact-a"],
    artifactStates: [{
      artifactKey: "artifact-a",
      worktreeStateKey: "state-a",
      changeKind: "modified",
      observedSequence: 2
    }],
    addedLines: 1,
    deletedLines: 0,
    status: "completed"
  };
}

class MemoryWorkEpisodeLedger implements WorkEpisodeLedger {
  private readonly episodes = new Map<string, AgenticWorkEpisode>();

  async initialize(): Promise<number> {
    return 0;
  }

  async upsertEpisode(episode: AgenticWorkEpisode): Promise<void> {
    this.episodes.set(episode.episodeId, structuredClone(episode));
  }

  async listEpisodes(query: WorkEpisodeQuery = {}): Promise<AgenticWorkEpisode[]> {
    return [...this.episodes.values()]
      .filter((episode) => !query.episodeId || episode.episodeId === query.episodeId)
      .filter((episode) => !query.repoKey || (episode.repoKeys ?? []).includes(query.repoKey))
      .filter((episode) => !query.commitHash || episode.claimedByCommitHash === query.commitHash)
      .filter((episode) => !query.status || episode.status === query.status)
      .filter((episode) => !query.queryId || episode.queryIds.includes(query.queryId))
      .filter((episode) => !query.runId || episode.runIds.includes(query.runId))
      .filter((episode) => !query.chatSessionId || episode.chatSessionId === query.chatSessionId)
      .map((episode) => structuredClone(episode));
  }

  async applyRetention(): Promise<number> {
    return 0;
  }

  async clear(): Promise<void> {
    this.episodes.clear();
  }
}
