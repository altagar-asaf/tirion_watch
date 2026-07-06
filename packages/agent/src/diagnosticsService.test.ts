import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStorageClient } from "@tirion/agent-storage";
import type { QueryCostAttribution } from "@tirion/engine/production";
import { AgentDiagnosticsService } from "./diagnosticsService";

const roots: string[] = [];
const storages: AgentStorageClient[] = [];

afterEach(async () => {
  await Promise.all(storages.splice(0).map((storage) => storage.close().catch(() => undefined)));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("agent diagnostics", () => {
  it("persists only bounded safe-code events and derives product facts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-diagnostics-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const logPath = join(root, "agent.log.jsonl");
    const diagnostics = new AgentDiagnosticsService(storage, logPath);
    await diagnostics.record("runtime_started", "info", "2026-06-08T00:00:01.000Z", {
      message: "Runtime started for diagnostics testing.",
      details: {
        connected: true,
        queuedCount: 0
      }
    });
    const snapshot = await diagnostics.snapshot({
      health: "healthy",
      ownershipState: "agent_full_owner"
    });
    expect(snapshot).toMatchObject({
      health: "healthy",
      ownershipState: "agent_full_owner",
      executionEnvironment: "local",
      sourceCount: 0,
      productionRunCount: 0,
      budgetWarningCount: 0,
      recentEvents: [expect.objectContaining({ code: "runtime_started", severity: "info" })]
    });
    expect(JSON.stringify(snapshot)).not.toContain(root);
    expect(JSON.parse(readFileSync(logPath, "utf8").trim())).toMatchObject({
      code: "runtime_started",
      severity: "info",
      message: "Runtime started for diagnostics testing.",
      details: {
        connected: true,
        queuedCount: 0
      }
    });
    expect(readFileSync(logPath, "utf8")).not.toContain(root);
  });

  it("counts only surfaced verified commit attributions", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-diagnostics-attribution-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertAgentDocument("query_attribution", {
      key: "query-reportable",
      sortAt: "2026-06-08T00:00:02.000Z",
      value: attribution("query-reportable", "attributed")
    });
    await storage.upsertAgentDocument("query_attribution", {
      key: "query-pending",
      sortAt: "2026-06-08T00:01:00.000Z",
      value: {
        ...attribution("query-pending", "pending_evidence"),
        allocations: [],
        evidence: []
      }
    });

    const diagnostics = new AgentDiagnosticsService(storage);
    const snapshot = await diagnostics.snapshot({
      health: "healthy",
      ownershipState: "agent_full_owner"
    });

    expect(snapshot.verifiedAttributionCount).toBe(1);
  });

  it("persists construct lifecycle diagnostics with correlation keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-diagnostics-lifecycle-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });

    const diagnostics = new AgentDiagnosticsService(storage);
    await diagnostics.record("construct_lifecycle", "warning", "2026-06-08T00:00:03.000Z", {
      message: "ExternalWebhookDispatch.delivery: blocked (delivery_blocked)",
      details: {
        construct: "ExternalWebhookDispatch",
        operation: "delivery",
        state: "blocked",
        reason: "delivery_blocked",
        commitHash: "a".repeat(40),
        publicationVersion: 2,
        correlationId: "check_publication_deadbeef",
        lastErrorCode: "auth_required"
      }
    });

    const snapshot = await diagnostics.snapshot({
      health: "degraded",
      ownershipState: "agent_full_owner"
    });

    expect(snapshot.recentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "construct_lifecycle",
        severity: "warning",
        details: expect.objectContaining({
          construct: "ExternalWebhookDispatch",
          operation: "delivery",
          state: "blocked",
          correlationId: "check_publication_deadbeef"
        })
      })
    ]));
  });

  it("surfaces durable construct state snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-diagnostics-construct-state-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });

    const diagnostics = new AgentDiagnosticsService(storage);
    await diagnostics.recordConstructState({
      schemaVersion: 1,
      construct: "GitAttribution",
      state: "pending_evidence",
      health: "degraded",
      updatedAt: "2026-06-08T00:00:03.000Z",
      reason: "pending_commit_candidates_waiting_for_evidence",
      details: {
        pendingCandidateCount: 2,
        reportableCandidateCount: 1
      }
    });

    const snapshot = await diagnostics.snapshot({
      health: "healthy",
      ownershipState: "agent_full_owner"
    });

    expect(snapshot.constructStates).toEqual([
      expect.objectContaining({
        construct: "GitAttribution",
        state: "pending_evidence",
        health: "degraded",
        reason: "pending_commit_candidates_waiting_for_evidence",
        details: expect.objectContaining({
          pendingCandidateCount: 2,
          reportableCandidateCount: 1
        })
      })
    ]);
  });

  it("keeps durable diagnostic events capped even when the JSONL log is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-diagnostics-cap-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-30T08:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const diagnostics = new AgentDiagnosticsService(storage, join(root, "agent.log.jsonl"));

    for (let index = 0; index < 1005; index += 1) {
      await diagnostics.record("construct_lifecycle", "info", `2026-06-30T08:00:${String(index % 60).padStart(2, "0")}.000Z`, {
        message: "RepositoryObservation.scan: queued (repository_scan_queued_while_inflight)",
        details: {
          construct: "RepositoryObservation",
          operation: "scan",
          state: "queued",
          reason: "repository_scan_queued_while_inflight",
          queuedRequestCount: index + 1
        }
      });
    }

    expect(await storage.listAgentDocuments("diagnostic_event")).toHaveLength(1000);
    expect(await diagnostics.events()).toHaveLength(1000);
  });
});

function attribution(queryId: string, status: QueryCostAttribution["status"]): QueryCostAttribution {
  return {
    queryId,
    runIds: [`${queryId}-run`],
    estimatedNanoUsd: 10,
    estimatedUsd: 10 / 1_000_000_000,
    estimatedAiCredits: 10 / 10_000_000,
    costCoverage: "complete",
    status,
    evidence: [{
      queryId,
      runIds: [`${queryId}-run`],
      repoKey: "repo-key",
      epochId: "epoch-1",
      startedAt: "2026-06-05T00:00:00.000Z",
      completedAt: "2026-06-05T00:00:01.000Z",
      baselineTrusted: true,
      baselineReasons: ["clean_baseline"],
      dirtyAtStart: false,
      observedChangeCount: 1,
      artifactKeys: ["artifact-a"],
      addedLines: 1,
      deletedLines: 0,
      firstObservedAt: "2026-06-05T00:00:00.500Z",
      lastObservedAt: "2026-06-05T00:00:01.000Z"
    }],
    allocations: [{
      episodeId: "episode-1",
      epochId: "epoch-1",
      commitHash: "commit-1",
      parentHashes: ["parent-1"],
      repoKey: "repo-key",
      queryId,
      allocatedNanoUsd: 10,
      allocationPolicy: "first_claim",
      decision: "reportable",
      proof: {
        kind: "exact_content_state",
        anchorQueryIds: [queryId],
        inheritedQueryIds: [],
        matchedArtifactCount: 1,
        reasonCodes: ["content_state_continuity"]
      },
      confidence: "high",
      coverage: "complete",
      evidenceReasons: ["artifact_overlap_1", "first_claim_allocated"],
      status: "active",
      verifiedAt: "2026-06-05T00:00:02.000Z",
      stateChangedAt: "2026-06-05T00:00:02.000Z",
      createdAt: "2026-06-05T00:00:02.000Z"
    }]
  };
}
