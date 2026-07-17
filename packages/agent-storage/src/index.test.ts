import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStorageClient } from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("agent storage worker", () => {
  it("initializes isolated agent metadata and clients", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_shadow",
      protocolVersion: "1.0"
    });
    expect(metadata.ownershipState).toBe("agent_shadow");
    expect(await storage.transitionOwnership({
      expected: "extension_legacy",
      next: "agent_shadow",
      now: "2026-06-08T00:00:00.500Z"
    })).toBeUndefined();
    expect(await storage.transitionOwnership({
      expected: "agent_shadow",
      next: "agent_usage_owner",
      now: "2026-06-08T00:00:00.500Z"
    })).toMatchObject({ ownershipState: "agent_usage_owner" });
    await storage.close();
    const reopened = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    expect(await reopened.initialize({
      now: "2026-06-08T00:00:00.750Z",
      ownershipState: "agent_shadow",
      protocolVersion: "1.0"
    })).toMatchObject({ ownershipState: "agent_usage_owner" });

    const credentialHash = hash("secret");
    const client = await reopened.issueClient({
      kind: "test",
      credentialHash,
      capabilities: ["runtime:read", "runs:read"],
      now: "2026-06-08T00:00:01.000Z"
    });
    expect(client.kind).toBe("test");
    expect(await reopened.authenticateClient({ credentialHash, now: "2026-06-08T00:00:02.000Z" })).toMatchObject({ clientId: client.clientId });
    expect(await reopened.revokeClient({ clientId: client.clientId, now: "2026-06-08T00:00:03.000Z" })).toBe(true);
    expect(await reopened.authenticateClient({ credentialHash, now: "2026-06-08T00:00:04.000Z" })).toBeUndefined();
    expect(await reopened.integrityCheck()).toBe("ok");
    await reopened.upsertSource({
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "claude-code",
      runtime: "claude-code",
      environmentId: metadata.environmentId,
      profileVersion: "claude-code-otlp-v1",
      granularity: ["request"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:05.000Z");
    expect(await reopened.listSources()).toHaveLength(1);
    expect(await reopened.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_12345678",
      sourceId: "source_12345678",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "traces",
      profileVersion: "claude-code-otlp-v1",
      resourceCount: 1,
      recordCount: 2,
      observedAt: "2026-06-08T00:00:06.000Z",
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "activity_12345678",
        queryId: "correlation_12345678",
        provider: "claude-code",
        runtime: "claude-code",
        kind: "tool",
        name: "readFile",
        outcome: "success",
        durationMs: 10,
        startedAt: "2026-06-08T00:00:06.000Z"
      }],
      executionNodes: [{
        schemaVersion: 1,
        nodeId: "node_12345678",
        queryId: "correlation_12345678",
        provider: "claude-code",
        runtime: "claude-code",
        nodeKind: "tool",
        name: "readFile",
        outcome: "success",
        startedAt: "2026-06-08T00:00:06.000Z"
      }],
      usageAtoms: [{
        schemaVersion: 1,
        atomId: "atom_12345678",
        correlationId: "correlation_12345678",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        model: "claude-sonnet-4.6",
        inputTokens: 12,
        outputTokens: 3,
        startedAt: "2026-06-08T00:00:06.000Z"
      }]
    })).toBe(true);
    expect(await reopened.safeObservationCount()).toBe(1);
    expect(await reopened.listSafeUsageAtoms()).toHaveLength(1);
    expect(await reopened.listSafeActivityAtoms()).toEqual([
      expect.objectContaining({ activityId: "activity_12345678", name: "readFile" })
    ]);
    expect(await reopened.listAgentDocuments("execution_node_atom")).toEqual([
      expect.objectContaining({
        key: "node_12345678",
        value: expect.objectContaining({ nodeId: "node_12345678", nodeKind: "tool" })
      })
    ]);
    await reopened.replaceShadowRuns([{
      schemaVersion: 1,
      shadow: true,
      runId: "shadow_12345678",
      correlationId: "correlation_12345678",
      provider: "claude-code",
      runtime: "claude-code",
      model: "claude-sonnet-4.6",
      authority: "request",
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 15,
      estimatedNanoUsd: 81_000,
      pricingVersion: "test",
      billingContext: "anthropic-direct",
      costCoverage: "complete",
      evidenceGrade: "estimated_usage_cost_unattributed",
      startedAt: "2026-06-08T00:00:06.000Z",
      warnings: []
    }]);
    expect(await reopened.listShadowRuns()).toHaveLength(1);
    const productionEpoch = await reopened.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    expect(productionEpoch.epochId).toMatch(/^usage_/);
    expect(await reopened.productionUsageEpoch()).toEqual(productionEpoch);
    expect(await reopened.listSafeUsageAtomsSince(productionEpoch.startedAt)).toHaveLength(1);
    await reopened.replaceProductionRuns([{
      schemaVersion: 1,
      production: true,
      runId: "run_12345678",
      correlationId: "correlation_12345678",
      provider: "claude-code",
      runtime: "claude-code",
      model: "claude-sonnet-4.6",
      authority: "request",
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 15,
      estimatedNanoUsd: 81_000,
      pricingVersion: "test",
      billingContext: "anthropic-direct",
      costCoverage: "complete",
      evidenceGrade: "estimated_usage_cost_unattributed",
      startedAt: "2026-06-08T00:00:06.000Z",
      warnings: []
    }]);
    expect(await reopened.listProductionRuns()).toHaveLength(1);
    const [storedProductionRun] = await reopened.listProductionRuns();
    await reopened.upsertProductionRuns([{
      ...storedProductionRun,
      outputTokens: 4,
      totalTokens: 16
    }]);
    expect(await reopened.listProductionRuns()).toEqual([
      expect.objectContaining({ runId: "run_12345678", outputTokens: 4, totalTokens: 16 })
    ]);
    await reopened.upsertRepositoryScope({
      scope: {
        schemaVersion: 1,
        scopeId: "scope_12345678",
        kind: "repository",
        label: "approved-label",
        state: "active",
        environmentId: metadata.environmentId,
        addedAt: "2026-06-08T00:00:07.000Z",
        updatedAt: "2026-06-08T00:00:07.000Z"
      },
      locatorCiphertext: "encrypted",
      locatorIv: "iv",
      locatorTag: "tag"
    });
    expect(await reopened.listRepositoryScopes()).toEqual([
      expect.objectContaining({ scope: expect.objectContaining({ scopeId: "scope_12345678" }) })
    ]);
    expect(await reopened.removeRepositoryScope("scope_12345678")).toBe(true);
    await reopened.upsertAgentDocument("workspace_evidence", {
      key: "query_12345678:repo_12345678",
      sortAt: "2026-06-08T00:00:08.000Z",
      value: { queryId: "query_12345678", repoKey: "repo_12345678" }
    });
    expect(await reopened.listAgentDocuments("workspace_evidence")).toEqual([
      expect.objectContaining({
        key: "query_12345678:repo_12345678",
        value: { queryId: "query_12345678", repoKey: "repo_12345678" }
      })
    ]);
    await reopened.replaceAgentDocuments("workspace_evidence", [{
      key: "query_87654321:repo_12345678",
      sortAt: "2026-06-08T00:00:09.000Z",
      value: { queryId: "query_87654321", repoKey: "repo_12345678" }
    }]);
    expect(await reopened.removeAgentDocument("workspace_evidence", "query_87654321:repo_12345678")).toBe(true);
    expect(await reopened.listAgentDocuments("workspace_evidence")).toEqual([]);
    const backupPath = join(root, "backups", "agent.db");
    await reopened.backupTo(backupPath);
    expect(existsSync(backupPath)).toBe(true);
    await reopened.close();
  });

  it("retrieves and retains execution evidence without loading unrelated nodes", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-execution-evidence-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "node_old",
      sortAt: "2026-06-01T00:00:00.000Z",
      value: { queryId: "query_target", nodeId: "node_old" }
    });
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "node_target",
      sortAt: "2026-06-08T00:00:00.000Z",
      value: { queryId: "query_target", nodeId: "node_target" }
    });
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "node_other",
      sortAt: "2026-06-09T00:00:00.000Z",
      value: { queryId: "query_other", nodeId: "node_other" }
    });

    expect(await storage.readAgentDocument("execution_node_atom", "node_target")).toEqual(
      expect.objectContaining({ key: "node_target" })
    );
    expect(await storage.listExecutionNodeDocumentsForQuery<{ queryId: string }>("query_target")).toEqual([
      expect.objectContaining({ key: "node_old", value: expect.objectContaining({ queryId: "query_target" }) }),
      expect.objectContaining({ key: "node_target", value: expect.objectContaining({ queryId: "query_target" }) })
    ]);

    expect(await storage.applyExecutionNodeRetention("2026-06-07T00:00:00.000Z", 2)).toEqual({
      removedByAge: 1,
      removedByOverflow: 0,
      retainedCount: 2
    });
    expect(await storage.listExecutionNodeDocumentsForQuery<{ queryId: string }>("query_target")).toEqual([
      expect.objectContaining({ key: "node_target" })
    ]);
    await storage.close();
  });

  it("reads only due webhook outbox rows and the next durable delivery deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-webhook-outbox-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const entry = (key: string, deliveryState: string, nextAttemptAt?: string) => ({
      key,
      sortAt: "2026-06-08T00:00:00.000Z",
      value: { key, deliveryState, nextAttemptAt }
    });
    await storage.upsertAgentDocument("webhook_outbox", entry("pending_due", "pending", "2026-06-08T00:00:01.000Z"));
    await storage.upsertAgentDocument("webhook_outbox", entry("pending_later", "pending", "2026-06-08T00:00:03.000Z"));
    await storage.upsertAgentDocument("webhook_outbox", entry("retry_later", "retry", "2026-06-08T00:00:02.000Z"));
    await storage.upsertAgentDocument("webhook_outbox", entry("blocked", "blocked"));
    await storage.upsertAgentDocument("webhook_outbox", entry("delivered", "delivered"));

    expect(await storage.listWebhookOutboxDueDocuments<{ key: string }>("2026-06-08T00:00:01.500Z"))
      .toEqual([expect.objectContaining({ key: "pending_due" })]);
    expect(await storage.listWebhookOutboxDueDocuments<{ key: string }>("2026-06-08T00:00:01.500Z", true))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "pending_due" }),
        expect.objectContaining({ key: "retry_later" }),
        expect.objectContaining({ key: "blocked" })
      ]));
    expect((await storage.listWebhookOutboxDueDocuments("2026-06-08T00:00:01.500Z", true))
      .map((document) => document.key)).not.toContain("pending_later");
    expect(await storage.nextWebhookOutboxAttemptAt()).toBe("2026-06-08T00:00:01.000Z");
    await storage.close();
  });

  it("compacts a materially fragmented database without failing storage startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-compact-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertAgentDocument("workspace_evidence", {
      key: "fragmented",
      sortAt: "2026-06-08T00:00:00.000Z",
      value: { payload: "x".repeat(5 * 1024 * 1024) }
    });
    await storage.removeAgentDocument("workspace_evidence", "fragmented");

    const result = await storage.compactIfFragmented();
    expect(result).toMatchObject({ compacted: true });
    expect(result.pageCountAfter).toBeLessThan(result.pageCountBefore);
    expect(await storage.integrityCheck()).toBe("ok");
    await storage.close();
  });

  it("prunes legacy oversized repository snapshots inside the storage worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-snapshot-prune-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertAgentDocument("repository_snapshot", {
      key: "snapshot_small",
      sortAt: "2026-06-08T00:00:00.000Z",
      value: { artifactStates: [{ artifactKey: "one" }] }
    });
    await storage.upsertAgentDocument("repository_snapshot", {
      key: "snapshot_oversized",
      sortAt: "2026-06-08T00:00:01.000Z",
      value: { artifactStates: Array.from({ length: 101 }, (_, index) => ({ artifactKey: `item_${index}` })) }
    });

    expect(await storage.pruneRepositorySnapshotDocuments(100)).toBe(1);
    expect(await storage.listAgentDocuments("repository_snapshot")).toEqual([
      expect.objectContaining({ key: "snapshot_small" })
    ]);
    await storage.close();
  });

  it("scopes lifecycle storage reads and fails closed oversized attribution evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-lifecycle-scope-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource({ ...source("source_lifecycle_scope"), environmentId: metadata.environmentId }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_lifecycle_scope",
      sourceId: "source_lifecycle_scope",
      provider: "codex",
      runtime: "codex",
      signal: "traces",
      profileVersion: "codex-otlp-v1",
      resourceCount: 1,
      recordCount: 2,
      observedAt: "2026-06-08T00:00:01.000Z",
      usageAtoms: [{
        schemaVersion: 1,
        atomId: "atom_scope_a",
        queryId: "qry_scope_a",
        provider: "codex",
        runtime: "codex",
        authority: "request",
        inputTokens: 1,
        outputTokens: 1,
        startedAt: "2026-06-08T00:00:01.000Z"
      }, {
        schemaVersion: 1,
        atomId: "atom_scope_b",
        queryId: "qry_scope_b",
        provider: "codex",
        runtime: "codex",
        authority: "request",
        inputTokens: 2,
        outputTokens: 1,
        startedAt: "2026-06-08T00:00:01.000Z"
      }],
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "activity_scope_a",
        queryId: "qry_scope_a",
        provider: "codex",
        runtime: "codex",
        kind: "tool",
        name: "Bash",
        outcome: "success",
        startedAt: "2026-06-08T00:00:01.000Z"
      }, {
        schemaVersion: 1,
        activityId: "activity_scope_b",
        queryId: "qry_scope_b",
        provider: "codex",
        runtime: "codex",
        kind: "tool",
        name: "Read",
        outcome: "success",
        startedAt: "2026-06-08T00:00:01.000Z"
      }]
    });
    expect((await storage.listSafeUsageAtomsForQueryIds(["qry_scope_a"])).map((atom) => atom.atomId)).toEqual(["atom_scope_a"]);
    expect((await storage.listSafeActivityAtomsForQueryIds(["qry_scope_a"])).map((atom) => atom.activityId))
      .toEqual(["activity_scope_a"]);

    const oversizedEvidence = {
      queryId: "qry_scope_a",
      repoKey: "repo_scope",
      status: "completed",
      baselineTrusted: true,
      baselineReasons: [],
      artifactKeys: ["artifact_legacy"],
      causalArtifactKeys: ["artifact_legacy"],
      causalWriteArtifacts: Array.from({ length: 3 }, (_, index) => ({
        artifactKey: `artifact_causal_${index}`,
        executionNodeId: `node_causal_${index}`
      })),
      baselineArtifactStates: [{ artifactKey: "baseline_1" }, { artifactKey: "baseline_2" }, { artifactKey: "baseline_3" }],
      artifactStates: [{ artifactKey: "artifact_1" }, { artifactKey: "artifact_2" }, { artifactKey: "artifact_3" }],
      observedChangeCount: 3,
      addedLines: 9,
      deletedLines: 2
    };
    await storage.upsertAgentDocument("workspace_evidence", {
      key: "qry_scope_a:repo_scope",
      sortAt: "2026-06-08T00:00:02.000Z",
      value: oversizedEvidence
    });
    await storage.upsertAgentDocument("workspace_evidence", {
      key: "qry_scope_b:repo_scope",
      sortAt: "2026-06-08T00:00:03.000Z",
      value: {
        ...oversizedEvidence,
        queryId: "qry_scope_b",
        status: "active",
        baselineArtifactStates: [],
        artifactStates: []
      }
    });
    await storage.upsertAgentDocument("work_episode", {
      key: "episode_scope_a",
      sortAt: "2026-06-08T00:00:04.000Z",
      value: {
        episodeId: "episode_scope_a",
        chatSessionId: "ses_scope",
        repoKeys: ["repo_scope"],
        queryIds: ["qry_scope_a"],
        runIds: ["run_scope_a"],
        status: "open",
        evidence: [oversizedEvidence]
      }
    });
    await storage.upsertAgentDocument("work_episode", {
      key: "episode_scope_b",
      sortAt: "2026-06-08T00:00:05.000Z",
      value: {
        episodeId: "episode_scope_b",
        chatSessionId: "ses_other",
        repoKeys: [],
        queryIds: ["qry_scope_b"],
        runIds: ["run_scope_b"],
        status: "claimed",
        evidence: []
      }
    });
    expect(await storage.listWorkspaceEvidenceDocuments({ queryId: "qry_scope_a" })).toHaveLength(1);
    expect(await storage.listWorkEpisodeDocuments({ queryId: "qry_scope_a", runId: "run_scope_a" })).toEqual([
      expect.objectContaining({ key: "episode_scope_a" })
    ]);
    expect(await storage.attributionDocumentSummary()).toMatchObject({
      workspaceEvidence: { totalCount: 2, statusCounts: { active: 1, completed: 1 } },
      workEpisodes: { totalCount: 2, statusCounts: { open: 1, claimed: 1 }, unboundCount: 1 }
    });
    expect(await storage.sanitizeOversizedAttributionDocuments(2)).toEqual({
      workspaceEvidenceSanitized: 2,
      workEpisodesSanitized: 1
    });
    expect((await storage.listWorkspaceEvidenceDocuments<{
      baselineTrusted: boolean;
      artifactStates: unknown[];
      causalWriteArtifacts: unknown[];
    }>({ queryId: "qry_scope_a" }))[0]?.value)
      .toMatchObject({ baselineTrusted: false, artifactStates: [], causalWriteArtifacts: [] });
    expect((await storage.listWorkspaceEvidenceDocuments<{
      baselineTrusted: boolean;
      artifactStates: unknown[];
      causalWriteArtifacts: unknown[];
    }>({ queryId: "qry_scope_b" }))[0]?.value)
      .toMatchObject({ baselineTrusted: false, artifactStates: [], causalWriteArtifacts: [] });
    expect((await storage.listWorkEpisodeDocuments<{
      evidence: Array<{ artifactStates: unknown[]; artifactKeys: unknown[]; causalWriteArtifacts: unknown[] }>;
    }>({ runId: "run_scope_a" }))[0]?.value.evidence[0])
      .toMatchObject({ artifactStates: [], artifactKeys: [], causalWriteArtifacts: [] });

    const deliveredWriting = {
      schemaVersion: 1,
      key: "evt_scope_ended",
      eventType: "run.ended",
      subjectId: "run.ended:run_scope_a",
      deliveryState: "delivered",
      queuedAt: "2026-06-08T00:00:06.000Z",
      deliveredAt: "2026-06-08T00:00:07.000Z",
      updatedAt: "2026-06-08T00:00:07.000Z",
      event: {
        eventType: "run.ended",
        runId: "run_scope_a",
        sessionId: "ses_scope",
        traceIds: ["qry_scope_a"],
        filesChanged: ["src/scope.ts"]
      }
    };
    await storage.upsertAgentDocument("webhook_outbox", {
      key: deliveredWriting.key,
      sortAt: deliveredWriting.updatedAt,
      value: deliveredWriting
    });
    await storage.upsertAgentDocument("webhook_outbox", {
      key: "evt_scope_pending",
      sortAt: "2026-06-08T00:00:08.000Z",
      value: {
        ...deliveredWriting,
        key: "evt_scope_pending",
        eventType: "run.update",
        subjectId: "run.update:run_scope_a",
        deliveryState: "pending",
        queuedAt: "2026-06-08T00:00:08.000Z",
        deliveredAt: undefined,
        updatedAt: "2026-06-08T00:00:08.000Z",
        event: { ...deliveredWriting.event, eventType: "run.update", filesChanged: undefined }
      }
    });
    expect(await storage.webhookOutboxStatus()).toMatchObject({
      pendingCount: 1,
      deliveredCount: 1,
      activeEntries: [expect.objectContaining({ key: "evt_scope_pending" })]
    });
    expect(await storage.listWebhookLifecycleDocuments({ traceId: "qry_scope_a" })).toHaveLength(2);
    expect(await storage.listDeliveredWritingLifecycleRunIds()).toEqual(["run_scope_a"]);
    await storage.upsertAgentDocument("webhook_delivery_state", {
      key: "run.ended:run_scope_a",
      sortAt: "2026-06-08T00:00:09.000Z",
      value: {
        subjectId: "run.ended:run_scope_a",
        eventType: "run.ended",
        deliveredAt: "2026-06-08T00:00:09.000Z",
        filesChangedCount: 0
      }
    });
    expect(await storage.listDeliveredWritingLifecycleRunIds()).toEqual([]);
    await storage.upsertAgentDocument("webhook_delivery_state", {
      key: "run.ended:run_scope_a",
      sortAt: "2026-06-08T00:00:10.000Z",
      value: {
        subjectId: "run.ended:run_scope_a",
        eventType: "run.ended",
        deliveredAt: "2026-06-08T00:00:10.000Z",
        filesChangedCount: 1
      }
    });
    expect(await storage.listDeliveredWritingLifecycleRunIds()).toEqual(["run_scope_a"]);
    await storage.close();
  });

  it("migrates forward with backups and supports rollback from an explicit backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-upgrade-"));
    roots.push(root);
    const databasePath = join(root, "agent.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE agent_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE clients (
        client_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        capabilities_json TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const storage = new AgentStorageClient({ databasePath });
    expect(await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    })).toMatchObject({ schemaVersion: 10 });
    expect(existsSync(`${databasePath}.pre-migration-1.bak`)).toBe(true);
    await storage.upsertSource(source("source_before_backup"), "2026-06-08T00:00:01.000Z");
    const backupPath = join(root, "rollback.db");
    await storage.backupTo(backupPath);
    await storage.upsertSource(source("source_after_backup"), "2026-06-08T00:00:02.000Z");
    await storage.close();

    const rollback = new AgentStorageClient({ databasePath: backupPath });
    await rollback.initialize({
      now: "2026-06-08T00:00:03.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    expect((await rollback.listSources()).map((item) => item.sourceId)).toEqual(["source_before_backup"]);
    await rollback.close();
  });

  it("fails closed for corrupt and future-version databases", async () => {
    const corruptRoot = mkdtempSync(join(tmpdir(), "tirion-storage-corrupt-"));
    const futureRoot = mkdtempSync(join(tmpdir(), "tirion-storage-future-"));
    roots.push(corruptRoot, futureRoot);
    const corruptPath = join(corruptRoot, "agent.db");
    writeFileSync(corruptPath, "not a sqlite database");
    const corrupt = new AgentStorageClient({ databasePath: corruptPath });
    await expect(corrupt.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    })).rejects.toThrow("storage_unavailable");
    await corrupt.close().catch(() => undefined);

    const futurePath = join(futureRoot, "agent.db");
    const future = new DatabaseSync(futurePath);
    future.exec("PRAGMA user_version = 999;");
    future.close();
    const unsupported = new AgentStorageClient({ databasePath: futurePath });
    await expect(unsupported.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    })).rejects.toThrow("storage_unavailable");
    await unsupported.close().catch(() => undefined);
  });

  it("survives an abrupt process exit after a committed observation", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-kill-point-"));
    roots.push(root);
    const databasePath = join(root, "agent.db");
    const modulePath = join(__dirname, "..", "dist", "index.js");
    const input = {
      databasePath,
      source: source("source_kill_point")
    };
    const script = `
      const { AgentStorageClient } = require(${JSON.stringify(modulePath)});
      const input = ${JSON.stringify(input)};
      (async () => {
        const storage = new AgentStorageClient({ databasePath: input.databasePath });
        const metadata = await storage.initialize({
          now: "2026-06-08T00:00:00.000Z",
          ownershipState: "agent_full_owner",
          protocolVersion: "1.0"
        });
        await storage.upsertSource({ ...input.source, environmentId: metadata.environmentId }, "2026-06-08T00:00:01.000Z");
        await storage.appendSafeObservation({
          schemaVersion: 1,
          observationId: "observation_kill_point",
          sourceId: input.source.sourceId,
          provider: "codex",
          runtime: "codex",
          signal: "traces",
          profileVersion: "codex-otlp-v1",
          resourceCount: 1,
          recordCount: 1,
          observedAt: "2026-06-08T00:00:01.000Z",
          usageAtoms: []
        });
        process.exit(137);
      })();
    `;
    expect(spawnSync(process.execPath, ["-e", script]).status).toBe(137);

    const recovered = new AgentStorageClient({ databasePath });
    await recovered.initialize({
      now: "2026-06-08T00:00:02.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    expect(await recovered.integrityCheck()).toBe("ok");
    expect(await recovered.safeObservationCount()).toBe(1);
    await recovered.close();
  });

  it("replaces a privacy-safe in-flight atom when a later observation completes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-atom-revision-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource({ ...source("source_revision"), environmentId: metadata.environmentId }, "2026-06-08T00:00:00.000Z");
    const base = {
      schemaVersion: 1 as const,
      sourceId: "source_revision",
      provider: "codex" as const,
      runtime: "codex",
      signal: "traces" as const,
      profileVersion: "codex-otlp-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: "2026-06-08T00:00:01.000Z"
    };
    const atom = {
      schemaVersion: 1 as const,
      atomId: "atom_revision_12345678",
      correlationId: "cor_revision_12345678",
      provider: "codex" as const,
      runtime: "codex",
      authority: "turn" as const,
      inputTokens: 1,
      startedAt: "2026-06-08T00:00:01.000Z"
    };
    await storage.appendSafeObservation({ ...base, observationId: "observation_revision_open", usageAtoms: [atom] });
    await storage.appendSafeObservation({
      ...base,
      observationId: "observation_revision_completed",
      usageAtoms: [{ ...atom, endedAt: "2026-06-08T00:00:02.000Z" }]
    });
    expect(await storage.listSafeUsageAtoms()).toEqual([
      expect.objectContaining({ atomId: atom.atomId, endedAt: "2026-06-08T00:00:02.000Z" })
    ]);
    await storage.close();
  });

  it("retains Claude request-owner conflicts monotonically across replay and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-owner-conflict-"));
    roots.push(root);
    const databasePath = join(root, "agent.db");
    const storage = new AgentStorageClient({ databasePath });
    const metadata = await storage.initialize({
      now: "2026-07-12T22:46:34.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource(
      { ...source("source_owner_conflict"), environmentId: metadata.environmentId },
      "2026-07-12T22:46:34.000Z"
    );
    const base = {
      schemaVersion: 1 as const,
      sourceId: "source_owner_conflict",
      provider: "claude-code" as const,
      runtime: "claude-code",
      signal: "traces" as const,
      profileVersion: "claude-code-enhanced-traces-beta-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: "2026-07-12T22:46:34.000Z"
    };
    const atom = {
      schemaVersion: 1 as const,
      atomId: "atom_owner_conflict",
      correlationId: "qry_owner_conflict",
      queryId: "qry_owner_conflict",
      requestId: "req_owner_conflict",
      provider: "claude-code" as const,
      runtime: "claude-code",
      authority: "request" as const,
      inputTokens: 2,
      outputTokens: 79,
      startedAt: "2026-07-12T22:46:34.000Z"
    };
    await storage.appendSafeObservation({
      ...base,
      observationId: "observation_owner_a",
      usageAtoms: [{ ...atom, owningActivityId: "act_owner_a" }]
    });
    await storage.appendSafeObservation({
      ...base,
      observationId: "observation_owner_conflict",
      usageAtoms: [{ ...atom, ownershipConflictActivityIds: ["act_owner_a", "act_owner_b"] }]
    });
    await storage.close();

    const reopened = new AgentStorageClient({ databasePath });
    await reopened.initialize({
      now: "2026-07-12T22:46:35.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await reopened.appendSafeObservation({
      ...base,
      observationId: "observation_owner_replay",
      usageAtoms: [{ ...atom, owningActivityId: "act_owner_a" }]
    });
    await reopened.appendSafeObservation({
      ...base,
      observationId: "observation_owner_c_first",
      usageAtoms: [{ ...atom, atomId: "atom_owner_direct_conflict", owningActivityId: "act_owner_c" }]
    });
    await reopened.appendSafeObservation({
      ...base,
      observationId: "observation_owner_d_second",
      usageAtoms: [{ ...atom, atomId: "atom_owner_direct_conflict", owningActivityId: "act_owner_d" }]
    });

    expect(await reopened.listSafeUsageAtoms()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        atomId: "atom_owner_conflict",
        ownershipConflictActivityIds: ["act_owner_a", "act_owner_b"]
      }),
      expect.objectContaining({
        atomId: "atom_owner_direct_conflict",
        ownershipConflictActivityIds: ["act_owner_c", "act_owner_d"]
      })
    ]));
    for (const retained of await reopened.listSafeUsageAtoms()) {
      expect(retained).not.toHaveProperty("owningActivityId");
    }
    await reopened.close();
  });

  it("persists distinct activity and execution-node revisions by semantic identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-activity-revision-"));
    roots.push(root);
    const databasePath = join(root, "agent.db");
    const storage = new AgentStorageClient({ databasePath });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource(
      { ...source("source_activity_revision"), environmentId: metadata.environmentId },
      "2026-06-08T00:00:00.000Z"
    );
    const base = {
      schemaVersion: 1 as const,
      sourceId: "source_activity_revision",
      provider: "claude-code" as const,
      runtime: "claude-code",
      signal: "logs" as const,
      profileVersion: "claude-code-hooks-v1",
      resourceCount: 1,
      recordCount: 1
    };
    const activity = {
      schemaVersion: 1 as const,
      activityId: "activity_revision_12345678",
      queryId: "qry_revision_12345678",
      requestId: "req_revision_12345678",
      provider: "claude-code" as const,
      runtime: "claude-code",
      kind: "subagent" as const,
      name: "Explore",
      startedAt: "2026-06-08T00:00:01.000Z"
    };
    const node = {
      schemaVersion: 1 as const,
      nodeId: "node_revision_12345678",
      queryId: "qry_revision_12345678",
      requestId: "req_revision_12345678",
      provider: "claude-code" as const,
      runtime: "claude-code",
      nodeKind: "subagent" as const,
      name: "Explore",
      startedAt: "2026-06-08T00:00:01.000Z"
    };
    await storage.appendSafeObservation({
      ...base,
      observationId: "observation_activity_revision_open",
      observedAt: "2026-06-08T00:00:01.000Z",
      usageAtoms: [],
      activityAtoms: [{ ...activity, outcome: "unknown" }],
      executionNodes: [{ ...node, outcome: "unknown" }]
    });
    await storage.appendSafeObservation({
      ...base,
      observationId: "observation_activity_revision_terminal",
      observedAt: "2026-06-08T00:00:03.000Z",
      usageAtoms: [],
      activityAtoms: [{
        ...activity,
        outcome: "success",
        endedAt: "2026-06-08T00:00:03.000Z"
      }],
      executionNodes: [{
        ...node,
        outcome: "success",
        endedAt: "2026-06-08T00:00:03.000Z"
      }]
    });
    await storage.close();

    const reopened = new AgentStorageClient({ databasePath });
    await reopened.initialize({
      now: "2026-06-08T00:00:04.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    expect(await reopened.safeObservationCount()).toBe(2);
    expect(await reopened.listSafeActivityAtoms()).toEqual([expect.objectContaining({
      activityId: activity.activityId,
      outcome: "success",
      endedAt: "2026-06-08T00:00:03.000Z"
    })]);
    expect(await reopened.readAgentDocument("execution_node_atom", node.nodeId)).toMatchObject({
      value: expect.objectContaining({
        nodeId: node.nodeId,
        outcome: "success",
        endedAt: "2026-06-08T00:00:03.000Z"
      })
    });
    await reopened.close();
  });

  it("retains a native permission rejection across legacy same-identity activity revisions", async () => {
    const decision = {
      schemaVersion: 1 as const,
      activityId: "activity_native_permission_decision",
      queryId: "qry_native_permission_decision",
      requestId: "req_native_permission_decision",
      provider: "claude-code" as const,
      runtime: "claude-code",
      kind: "tool" as const,
      name: "Write",
      outcome: "rejected" as const,
      outcomeAuthority: "native_permission_decision" as const,
      startedAt: "2026-07-14T04:00:00.000Z"
    };
    const genericFailure = {
      ...decision,
      outcome: "failure" as const,
      outcomeAuthority: undefined,
      durationMs: 1_000,
      resultSizeBytes: 256,
      providerReportedResultTokens: 12,
      endedAt: "2026-07-14T04:00:01.000Z"
    };
    for (const [index, atoms] of [
      [decision, genericFailure],
      [genericFailure, decision]
    ].entries()) {
      const root = mkdtempSync(join(tmpdir(), `tirion-storage-native-decision-${index}-`));
      roots.push(root);
      const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
      const metadata = await storage.initialize({
        now: "2026-07-14T04:00:00.000Z",
        ownershipState: "agent_full_owner",
        protocolVersion: "1.0"
      });
      await storage.upsertSource(
        { ...source("source_native_permission_decision"), environmentId: metadata.environmentId },
        "2026-07-14T04:00:00.000Z"
      );
      for (const [revision, atom] of atoms.entries()) {
        await storage.appendSafeObservation({
          schemaVersion: 1,
          observationId: `observation_native_permission_decision_${index}_${revision}`,
          sourceId: "source_native_permission_decision",
          provider: "claude-code",
          runtime: "claude-code",
          signal: "logs",
          profileVersion: "claude-code-otlp-v1",
          resourceCount: 1,
          recordCount: 1,
          observedAt: `2026-07-14T04:00:0${revision}.000Z`,
          activityAtoms: [atom],
          usageAtoms: []
        });
      }
      expect(await storage.safeObservationCount()).toBe(2);
      expect(await storage.listSafeActivityAtoms()).toEqual([expect.objectContaining({
        activityId: decision.activityId,
        outcome: "rejected",
        outcomeAuthority: "native_permission_decision"
      })]);
      const [retained] = await storage.listSafeActivityAtoms();
      expect(retained).not.toHaveProperty("endedAt");
      expect(retained).not.toHaveProperty("durationMs");
      expect(retained).not.toHaveProperty("resultSizeBytes");
      expect(retained).not.toHaveProperty("providerReportedResultTokens");
      await storage.close();
    }
  });

  it("bounds safe-journal replay and accounts for overflow after downstream projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-journal-retention-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource({ ...source("source_retention"), environmentId: metadata.environmentId }, "2026-06-08T00:00:00.000Z");
    for (const id of ["first", "second"]) {
      await storage.appendSafeObservation({
        schemaVersion: 1,
        observationId: `observation_${id}_retention`,
        sourceId: "source_retention",
        provider: "codex",
        runtime: "codex",
        signal: "traces",
        profileVersion: "codex-otlp-v1",
        resourceCount: 1,
        recordCount: 1,
        observedAt: "2026-06-08T00:00:01.000Z",
        usageAtoms: []
      });
    }
    expect(await storage.applySafeObservationRetention("1970-01-01T00:00:00.000Z", 1)).toMatchObject({
      removedByAge: 0,
      removedByOverflow: 1,
      retainedCount: 1
    });
    await storage.close();
  });

  it("keeps query occurrences durable when their safe-journal observations are pruned", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-query-occurrence-"));
    roots.push(root);
    const databasePath = join(root, "agent.db");
    const storage = new AgentStorageClient({ databasePath });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource({ ...source("source_query_occurrence"), environmentId: metadata.environmentId }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_query_occurrence",
      sourceId: "source_query_occurrence",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-otel-logs-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: "2026-06-08T00:00:01.000Z",
      queryOccurrences: [{
        schemaVersion: 1,
        queryId: "qry_query_occurrence",
        sessionId: "ses_query_occurrence",
        parentSessionId: "ses_parent_query_occurrence",
        lifecycleVisibility: "customer",
        provider: "claude-code",
        runtime: "claude-code",
        startedAt: "2026-06-08T00:00:01.000Z",
        promptState: "captured",
        promptText: "Implement the durable query ledger",
        evidence: "submission_hook"
      }],
      usageAtoms: []
    });
    expect(await storage.applySafeObservationRetention("2099-06-09T00:00:00.000Z", 1)).toMatchObject({
      removedByAge: 1,
      retainedCount: 0
    });
    expect(await storage.listQueryOccurrences()).toEqual([
      expect.objectContaining({
        queryId: "qry_query_occurrence",
        promptState: "captured",
        promptText: "Implement the durable query ledger"
      })
    ]);
    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_query_occurrence_replay",
      sourceId: "source_query_occurrence",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-otel-logs-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: "2026-06-08T00:00:02.000Z",
      queryOccurrences: [{
        schemaVersion: 1,
        queryId: "qry_query_occurrence",
        sessionId: "ses_query_occurrence",
        lifecycleVisibility: "internal",
        provider: "claude-code",
        runtime: "claude-code",
        startedAt: "2026-06-08T00:00:01.000Z",
        completedAt: "2026-06-08T00:00:02.000Z",
        completionEvidence: "stop_hook",
        repositoryKey: "repo_query_occurrence",
        promptState: "disabled",
        evidence: "provider_user_prompt_event"
      }],
      usageAtoms: []
    });
    expect(await storage.listQueryOccurrences()).toEqual([
      expect.objectContaining({
        promptState: "captured",
        promptText: "Implement the durable query ledger",
        completedAt: "2026-06-08T00:00:02.000Z",
        completionEvidence: "stop_hook",
        repositoryKey: "repo_query_occurrence",
        evidence: "submission_hook",
        lifecycleVisibility: "internal",
        parentSessionId: "ses_parent_query_occurrence"
      })
    ]);
    await expect(storage.readQueryOccurrence("qry_query_occurrence")).resolves.toMatchObject({
      queryId: "qry_query_occurrence",
      lifecycleVisibility: "internal"
    });
    await expect(storage.readQueryOccurrence("qry_missing")).resolves.toBeUndefined();
    await storage.close();

    const reopened = new AgentStorageClient({ databasePath });
    await reopened.initialize({
      now: "2026-06-09T00:00:01.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    expect(await reopened.listQueryOccurrencesSince("2026-06-08T00:00:00.000Z")).toHaveLength(1);
    expect(await reopened.applyQueryOccurrenceRetention("2026-06-09T00:00:00.000Z")).toBe(1);
    expect(await reopened.listQueryOccurrences()).toEqual([]);
    await reopened.close();
  });

  it("retains failed completion evidence across duplicates and lower-information revisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-storage-failed-completion-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-07-12T06:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource(
      { ...source("source_claude_stop_failure"), environmentId: metadata.environmentId },
      "2026-07-12T06:00:00.000Z"
    );
    const failedObservation = {
      schemaVersion: 1 as const,
      observationId: "observation_claude_stop_failure",
      sourceId: "source_claude_stop_failure",
      provider: "claude-code" as const,
      runtime: "claude-code",
      signal: "logs" as const,
      profileVersion: "claude-code-hooks-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: "2026-07-12T06:00:01.000Z",
      queryOccurrences: [{
        schemaVersion: 1 as const,
        queryId: "qry_claude_stop_failure",
        sessionId: "ses_claude_stop_failure",
        provider: "claude-code" as const,
        runtime: "claude-code",
        startedAt: "2026-07-12T06:00:00.000Z",
        completedAt: "2026-07-12T06:00:01.000Z",
        completionEvidence: "stop_hook" as const,
        completionOutcome: "failure" as const,
        completionFailureCategory: "authentication_failed" as const,
        promptState: "disabled" as const,
        evidence: "submission_hook" as const
      }],
      usageAtoms: []
    };
    const {
      completionOutcome: _completionOutcome,
      completionFailureCategory: _completionFailureCategory,
      ...lowerInformationOccurrence
    } = failedObservation.queryOccurrences[0];

    await expect(storage.appendSafeObservation(failedObservation)).resolves.toBe(true);
    await expect(storage.appendSafeObservation(failedObservation)).resolves.toBe(false);
    await storage.appendSafeObservation({
      ...failedObservation,
      observationId: "observation_claude_stop_failure_lower_information",
      observedAt: "2026-07-12T06:00:02.000Z",
      queryOccurrences: [{
        ...lowerInformationOccurrence,
        completedAt: "2026-07-12T06:00:02.000Z",
        completionEvidence: "provider_completed_event"
      }]
    });
    await storage.appendSafeObservation({
      ...failedObservation,
      observationId: "observation_claude_stop_failure_equal_outcome_weaker_evidence",
      observedAt: "2026-07-12T06:00:03.000Z",
      queryOccurrences: [{
        ...failedObservation.queryOccurrences[0],
        completedAt: "2026-07-12T06:00:03.000Z",
        completionEvidence: "provider_completed_event"
      }]
    });

    await expect(storage.readQueryOccurrence("qry_claude_stop_failure")).resolves.toMatchObject({
      completedAt: "2026-07-12T06:00:01.000Z",
      completionEvidence: "stop_hook",
      completionOutcome: "failure",
      completionFailureCategory: "authentication_failed"
    });
    await storage.close();
  });

});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function source(sourceId: string) {
  return {
    schemaVersion: 1,
    sourceId,
    sourceKind: "otlp-http-json",
    provider: "codex",
    runtime: "codex",
    environmentId: "environment_test",
    profileVersion: "codex-otlp-v1",
    granularity: ["turn"] as const,
    tokenDimensions: ["input", "output"],
    billingEvidence: ["model"],
    durability: "at_least_once" as const,
    contentRisk: "content_expected" as const,
    compatibility: "supported" as const,
    evidenceGrade: "estimated_usage_cost_unattributed" as const
  };
}
