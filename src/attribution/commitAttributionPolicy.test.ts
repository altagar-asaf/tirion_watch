import { describe, expect, it } from "vitest";
import { AgenticWorkEpisode, ObservedCommitCandidate, QueryWorkEvidence } from "../types";
import { evaluateCommitAttribution } from "./commitAttributionPolicy";

describe("evaluateCommitAttribution", () => {
  it("requires exact state continuity rather than file overlap", () => {
    const result = evaluateCommitAttribution({
      candidate: candidate("committed-state"),
      episode: episode([evidence("observed-state")]),
      lineageVerifiedQueryIds: new Set(["query-1", "query-2"]),
      activeQueryIds: new Set(),
      candidateAnchorQueryIds: new Set()
    });

    expect(result.decision).toBe("pending_evidence");
  });

  it("reports exact worktree state continuity", () => {
    const result = evaluateCommitAttribution({
      candidate: candidate("state-a"),
      episode: episode([evidence("state-a")]),
      lineageVerifiedQueryIds: new Set(["query-1", "query-2"]),
      activeQueryIds: new Set(),
      candidateAnchorQueryIds: new Set()
    });

    expect(result).toMatchObject({
      decision: "reportable",
      queryIds: ["query-1"],
      proof: {
        kind: "exact_content_state",
        anchorQueryIds: ["query-1"],
        matchedArtifactCount: 1
      }
    });
  });

  it("reports matching staged state even when the worktree moved on", () => {
    const item = evidence("later-worktree");
    item.artifactStates![0].indexStateKey = "staged-state";
    const result = evaluateCommitAttribution({
      candidate: candidate("staged-state"),
      episode: episode([item]),
      lineageVerifiedQueryIds: new Set(["query-1", "query-2"]),
      activeQueryIds: new Set(),
      candidateAnchorQueryIds: new Set()
    });

    expect(result.decision).toBe("reportable");
  });

  it("rejects evidence from a previous repository epoch", () => {
    const item = evidence("state-a");
    item.epochId = "old-epoch";
    const result = evaluateCommitAttribution({
      candidate: candidate("state-a"),
      episode: episode([item]),
      lineageVerifiedQueryIds: new Set(["query-1", "query-2"]),
      activeQueryIds: new Set(),
      candidateAnchorQueryIds: new Set()
    });

    expect(result).toMatchObject({ decision: "rejected", reasonCodes: ["epoch_mismatch"] });
  });

  it("inherits no-evidence queries only in an unambiguous single-repo episode", () => {
    const work = episode([evidence("state-a")]);
    work.queryIds.push("query-2");
    const result = evaluateCommitAttribution({
      candidate: candidate("state-a"),
      episode: work,
      lineageVerifiedQueryIds: new Set(["query-1", "query-2"]),
      activeQueryIds: new Set(),
      candidateAnchorQueryIds: new Set()
    });

    expect(result.proof?.inheritedQueryIds).toEqual(["query-2"]);
  });

  it("allows an existing anchor on the same candidate to prove late episode inheritance", () => {
    const work = episode([evidence("state-a")]);
    work.queryIds.push("query-2");
    const result = evaluateCommitAttribution({
      candidate: candidate("state-a"),
      episode: work,
      lineageVerifiedQueryIds: new Set(["query-1", "query-2"]),
      activeQueryIds: new Set(["query-1"]),
      candidateAnchorQueryIds: new Set(["query-1"])
    });

    expect(result).toMatchObject({
      decision: "reportable",
      queryIds: ["query-2"],
      proof: {
        anchorQueryIds: ["query-1"],
        inheritedQueryIds: ["query-2"]
      }
    });
  });

  it("allows current-epoch proof without inheriting a query evidenced in an old epoch", () => {
    const old = evidence("old-state");
    old.epochId = "old-epoch";
    const current = evidence("state-a");
    current.queryId = "query-2";
    current.runIds = ["run-2"];
    const work = episode([old, current]);
    work.queryIds.push("query-2");
    const result = evaluateCommitAttribution({
      candidate: candidate("state-a"),
      episode: work,
      lineageVerifiedQueryIds: new Set(["query-1", "query-2"]),
      activeQueryIds: new Set(),
      candidateAnchorQueryIds: new Set()
    });

    expect(result).toMatchObject({
      decision: "reportable",
      queryIds: ["query-2"],
      proof: { anchorQueryIds: ["query-2"], inheritedQueryIds: [] }
    });
  });

  it("claims an earlier query without inheriting a query whose evidence window opened after the commit", () => {
    const late = evidence("state-a");
    late.baselineSequence = 4;
    const early = evidence("state-a");
    early.queryId = "query-2";
    early.runIds = ["run-2"];
    const work = episode([late, early]);
    work.queryIds.push("query-2");
    const result = evaluateCommitAttribution({
      candidate: candidate("state-a"),
      episode: work,
      lineageVerifiedQueryIds: new Set(["query-1", "query-2"]),
      activeQueryIds: new Set(),
      candidateAnchorQueryIds: new Set()
    });

    expect(result).toMatchObject({
      decision: "reportable",
      queryIds: ["query-2"],
      proof: { anchorQueryIds: ["query-2"], inheritedQueryIds: [] }
    });
  });

  it("claims only the direct anchor whose own baseline lineage is proven", () => {
    const first = evidence("state-a");
    const second = evidence("state-a");
    second.queryId = "query-2";
    second.runIds = ["run-2"];
    const work = episode([first, second]);
    work.queryIds.push("query-2");
    const result = evaluateCommitAttribution({
      candidate: candidate("state-a"),
      episode: work,
      lineageVerifiedQueryIds: new Set(["query-2"]),
      activeQueryIds: new Set(),
      candidateAnchorQueryIds: new Set()
    });

    expect(result).toMatchObject({
      decision: "reportable",
      queryIds: ["query-2"],
      proof: { anchorQueryIds: ["query-2"], inheritedQueryIds: [] }
    });
  });

  it("explains when proof exists but another commit already holds the active claim", () => {
    const result = evaluateCommitAttribution({
      candidate: candidate("state-a"),
      episode: episode([evidence("state-a")]),
      lineageVerifiedQueryIds: new Set(["query-1"]),
      activeQueryIds: new Set(["query-1"]),
      candidateAnchorQueryIds: new Set()
    });

    expect(result).toMatchObject({
      decision: "pending_evidence",
      reasonCodes: ["query_already_claimed_by_other_commit"]
    });
  });
});

function candidate(stateKey: string): ObservedCommitCandidate {
  return {
    candidateId: "epoch-1:commit-1",
    epochId: "epoch-1",
    repoKey: "repo-key",
    commitHash: "commit-1",
    parentHashes: ["base"],
    observedAt: "2026-06-05T00:03:00.000Z",
    observedSequence: 3,
    artifactStates: [{
      artifactKey: "artifact-a",
      stateKey,
      changeKind: "modified",
      observedSequence: 3
    }],
    transitionKind: "fast_forward",
    decision: "pending_evidence",
    reasonCodes: []
  };
}

function episode(evidenceRecords: QueryWorkEvidence[]): AgenticWorkEpisode {
  return {
    episodeId: "episode-1",
    repoKey: "repo-key",
    repoKeys: ["repo-key"],
    epochIds: ["epoch-1"],
    chatSessionId: "session-1",
    queryIds: ["query-1"],
    runIds: ["run-1"],
    startedAt: "2026-06-05T00:00:00.000Z",
    lastAgentActivityAt: "2026-06-05T00:01:00.000Z",
    status: "open",
    evidence: evidenceRecords
  };
}

function evidence(worktreeStateKey: string): QueryWorkEvidence {
  return {
    queryId: "query-1",
    runIds: ["run-1"],
    repoKey: "repo-key",
    epochId: "epoch-1",
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
      worktreeStateKey,
      changeKind: "modified",
      observedSequence: 2
    }],
    addedLines: 1,
    deletedLines: 0,
    status: "completed"
  };
}
