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
    })).toMatchObject({ schemaVersion: 9 });
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
        provider: "claude-code",
        runtime: "claude-code",
        startedAt: "2026-06-08T00:00:01.000Z",
        promptState: "captured",
        promptText: "Implement the durable query ledger",
        evidence: "provider_prompt_id"
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
        provider: "claude-code",
        runtime: "claude-code",
        startedAt: "2026-06-08T00:00:01.000Z",
        promptState: "disabled",
        evidence: "provider_prompt_id"
      }],
      usageAtoms: []
    });
    expect(await storage.listQueryOccurrences()).toEqual([
      expect.objectContaining({
        promptState: "captured",
        promptText: "Implement the durable query ledger"
      })
    ]);
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
