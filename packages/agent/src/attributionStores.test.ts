import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStorageClient } from "@tirion/agent-storage";
import {
  SqliteCommitAttributionLedger,
  SqliteWorkEpisodeLedger,
  SqliteWorkspaceEvidenceLedger
} from "./attributionStores";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("agent attribution stores", () => {
  it("persists privacy-safe evidence and episodes through the dedicated SQLite worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-attribution-store-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const evidenceStore = new SqliteWorkspaceEvidenceLedger(storage);
    await evidenceStore.upsertEvidence({
      queryId: "query_12345678",
      runIds: ["run_12345678"],
      repoKey: "repo_12345678",
      epochId: "epoch_12345678",
      startedAt: "2026-06-08T00:00:01.000Z",
      baselineTrusted: true,
      baselineReasons: ["observed_baseline"],
      dirtyAtStart: false,
      observedChangeCount: 1,
      artifactKeys: ["artifact_12345678"],
      causalArtifactKeys: ["artifact_12345678"],
      causalWriteArtifacts: [{
        artifactKey: "artifact_12345678",
        executionNodeId: "node_successful_write_01"
      }],
      nativeRejectedCausalWriteArtifacts: [{
        artifactKey: "artifact_rejected_12345678",
        executionNodeId: "node_rejected_write_01"
      }],
      addedLines: 1,
      deletedLines: 0,
      status: "completed"
    });
    expect(await evidenceStore.listEvidence({ queryId: "query_12345678" })).toEqual([
      expect.objectContaining({
        causalWriteArtifacts: [{
          artifactKey: "artifact_12345678",
          executionNodeId: "node_successful_write_01"
        }],
        nativeRejectedCausalWriteArtifacts: [{
          artifactKey: "artifact_rejected_12345678",
          executionNodeId: "node_rejected_write_01"
        }]
      })
    ]);

    const episodeStore = new SqliteWorkEpisodeLedger(storage);
    await episodeStore.upsertEpisode({
      observationSchemaVersion: 1,
      episodeId: "episode_12345678",
      repoKey: "repo_12345678",
      repoKeys: ["repo_12345678"],
      epochIds: ["epoch_12345678"],
      queryIds: ["query_12345678"],
      runIds: ["run_12345678"],
      startedAt: "2026-06-08T00:00:01.000Z",
      lastAgentActivityAt: "2026-06-08T00:00:02.000Z",
      status: "open",
      evidence: await evidenceStore.listEvidence()
    });
    expect(await episodeStore.listEpisodes({ repoKey: "repo_12345678" })).toHaveLength(1);

    await storage.close();
    const reopened = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await reopened.initialize({
      now: "2026-06-08T00:00:03.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    expect(await new SqliteWorkspaceEvidenceLedger(reopened).listEvidence()).toHaveLength(1);
    expect(await new SqliteWorkEpisodeLedger(reopened).listEpisodes()).toHaveLength(1);
    await reopened.close();
  });

  it("atomically enforces one durable first claim per query", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-attribution-claim-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const ledger = new SqliteCommitAttributionLedger(storage, () => Date.parse("2026-06-08T00:00:04.000Z"));
    await ledger.upsertQueryAttribution({
      queryId: "query_12345678",
      runIds: ["run_12345678"],
      estimatedNanoUsd: 100,
      costCoverage: "complete",
      status: "pending_evidence",
      evidence: [],
      allocations: []
    });
    const input = {
      candidate: {
        candidateId: "candidate_12345678",
        epochId: "epoch_12345678",
        repoKey: "repo_12345678",
        commitHash: "commit_12345678",
        parentHashes: ["parent_12345678"],
        observedAt: "2026-06-08T00:00:03.000Z",
        observedSequence: 3,
        artifactStates: [],
        transitionKind: "fast_forward" as const,
        decision: "reportable" as const,
        reasonCodes: ["verified_content_continuity"]
      },
      episode: {
        observationSchemaVersion: 1 as const,
        episodeId: "episode_12345678",
        repoKey: "repo_12345678",
        queryIds: ["query_12345678"],
        runIds: ["run_12345678"],
        startedAt: "2026-06-08T00:00:01.000Z",
        lastAgentActivityAt: "2026-06-08T00:00:02.000Z",
        status: "open" as const,
        evidence: []
      },
      proof: {
        kind: "exact_content_state" as const,
        anchorQueryIds: ["query_12345678"],
        inheritedQueryIds: [],
        matchedArtifactCount: 1,
        reasonCodes: ["content_state_continuity"]
      },
      queryIds: ["query_12345678"]
    };
    expect(await ledger.tryFirstClaim(input)).toEqual({ claimedQueryIds: ["query_12345678"], skippedQueryIds: [] });
    expect(await ledger.tryFirstClaim(input)).toEqual({ claimedQueryIds: [], skippedQueryIds: ["query_12345678"] });
    expect(await ledger.transferFirstClaim({
      ...input,
      candidate: {
        ...input.candidate,
        commitHash: "commit_87654321",
        parentHashes: ["commit_12345678"],
        observedAt: "2026-06-08T00:00:05.000Z"
      },
      proof: {
        ...input.proof,
        kind: "episode_inheritance",
        inheritedQueryIds: ["query_12345678"]
      },
      supersededCommitHash: "commit_12345678"
    })).toEqual({ claimedQueryIds: ["query_12345678"], skippedQueryIds: [] });
    expect(await storage.listAgentDocuments("query_attribution")).toHaveLength(1);
    await storage.close();
  });

  it("rejects repository locators before durable attribution storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-attribution-privacy-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await expect(new SqliteWorkspaceEvidenceLedger(storage).upsertEvidence({
      queryId: "query_12345678",
      runIds: [],
      repoKey: "repo_12345678",
      startedAt: "2026-06-08T00:00:01.000Z",
      baselineTrusted: false,
      baselineReasons: [],
      dirtyAtStart: false,
      observedChangeCount: 0,
      artifactKeys: [],
      addedLines: 0,
      deletedLines: 0,
      repositoryPath: "/private/repository"
    } as never)).rejects.toThrow("privacy_violation");
    expect(await storage.listAgentDocuments("workspace_evidence")).toEqual([]);
    await expect(new SqliteWorkspaceEvidenceLedger(storage).upsertEvidence({
      queryId: "query_opaque_proof",
      runIds: [],
      repoKey: "repo_12345678",
      startedAt: "2026-06-08T00:00:01.000Z",
      baselineTrusted: false,
      baselineReasons: [],
      dirtyAtStart: false,
      observedChangeCount: 1,
      artifactKeys: ["artifact_opaque"],
      causalWriteArtifacts: [{
        artifactKey: "/private/repository.ts",
        executionNodeId: "node_successful_write_01"
      }],
      addedLines: 0,
      deletedLines: 0
    })).rejects.toThrow("privacy_violation");
    expect(await storage.listAgentDocuments("workspace_evidence")).toEqual([]);
    await storage.close();
  });
});
