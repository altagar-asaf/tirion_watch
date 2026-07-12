import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductionRunV1 } from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { ProductionUsageService } from "./productionUsageService";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production usage service", () => {
  it("starts from a clean epoch and never imports pre-epoch shadow atoms", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_usage_owner", protocolVersion: "1.0" });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-otlp-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation(observation("old", "2026-06-08T00:00:00.000Z"));
    const service = new ProductionUsageService(storage);
    await service.startCleanEpoch("9999-01-01T00:00:00.000Z");
    expect(await service.rebuild("agent_usage_owner")).toHaveLength(0);
    expect(await service.totals("agent_usage_owner")).toMatchObject({ production: true, runCount: 0 });
    await storage.close();
  });

  it("fails closed outside production ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-owner-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_shadow", protocolVersion: "1.0" });
    const service = new ProductionUsageService(storage);
    await expect(service.runs("agent_shadow")).rejects.toThrow("unsupported_capability");
    await storage.close();
  });

  it("keeps authoritative production history after the safe journal is pruned", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-pruned-journal-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_usage_owner", protocolVersion: "1.0" });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-otlp-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation(observation("retained", "2026-06-08T00:00:01.000Z"));
    const service = new ProductionUsageService(storage);
    await service.startCleanEpoch("2026-06-08T00:00:00.000Z");
    expect(await service.rebuild("agent_usage_owner")).toHaveLength(1);
    await storage.applySafeObservationRetention("9999-01-01T00:00:00.000Z", 1);
    expect(await storage.safeObservationCount()).toBe(0);
    expect(await service.rebuild("agent_usage_owner")).toHaveLength(1);
    await storage.close();
  });

  it("uses a recent reconciliation window on restart when durable production history already exists", async () => {
    const usageStarts: string[] = [];
    const activityStarts: string[] = [];
    let occurrenceReadCount = 0;
    let persistedRuns: ProductionRunV1[] = [productionRun("existing", "2026-04-10T00:00:00.000Z")];
    const storage = {
      productionUsageEpoch: async () => ({
        schemaVersion: 1,
        epochId: "usage_epoch_12345678",
        startedAt: "2026-04-01T00:00:00.000Z"
      }),
      listProductionRuns: async () => persistedRuns,
      listSafeUsageAtomsSince: async (startedAt: string) => {
        usageStarts.push(startedAt);
        return [];
      },
      listQueryOccurrences: async () => {
        occurrenceReadCount += 1;
        return [];
      },
      listSafeActivityAtomsSince: async (startedAt: string) => {
        activityStarts.push(startedAt);
        return [];
      },
      upsertProductionRuns: async (runs: ProductionRunV1[]) => {
        const byId = new Map(persistedRuns.map((run) => [run.runId, run]));
        runs.forEach((run) => byId.set(run.runId, run));
        persistedRuns = [...byId.values()];
      }
    } as unknown as AgentStorageClient;
    const service = new ProductionUsageService(
      storage,
      () => new Date("2026-06-30T00:00:00.000Z")
    );

    expect(await service.rebuild("agent_usage_owner")).toEqual([
      expect.objectContaining({ runId: "run_existing_12345678" })
    ]);
    expect(usageStarts).toEqual(["2026-06-23T00:00:00.000Z"]);
    expect(occurrenceReadCount).toBe(1);
    expect(activityStarts).toEqual(["2026-06-23T00:00:00.000Z"]);
    expect(persistedRuns).toEqual([
      expect.objectContaining({ runId: "run_existing_12345678" })
    ]);
  });

  it("projects one completed query family without waiting for a global rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-terminal-family-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_terminal_family",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-terminal-family-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_terminal_family",
      sourceId: "source_terminal_family",
      provider: "codex",
      runtime: "codex",
      signal: "traces",
      profileVersion: "codex-terminal-family-v1",
      resourceCount: 1,
      recordCount: 5,
      observedAt: "2026-06-08T00:00:03.000Z",
      queryOccurrences: [{
        schemaVersion: 1,
        queryId: "qry_terminal_root",
        sessionId: "ses_terminal_root",
        lifecycleVisibility: "customer",
        provider: "codex",
        runtime: "codex",
        startedAt: "2026-06-08T00:00:01.000Z",
        completedAt: "2026-06-08T00:00:03.000Z",
        completionEvidence: "stop_hook",
        repositoryKey: "repo_terminal_family",
        promptState: "disabled",
        evidence: "submission_hook"
      }, {
        schemaVersion: 1,
        queryId: "qry_terminal_child",
        sessionId: "ses_terminal_child",
        lifecycleVisibility: "customer",
        provider: "codex",
        runtime: "codex",
        startedAt: "2026-06-08T00:00:02.000Z",
        completedAt: "2026-06-08T00:00:02.500Z",
        completionEvidence: "provider_completed_event",
        repositoryKey: "repo_terminal_family",
        promptState: "disabled",
        evidence: "submission_hook"
      }],
      usageAtoms: [{
        schemaVersion: 1,
        atomId: "atom_terminal_root",
        correlationId: "qry_terminal_root",
        queryId: "qry_terminal_root",
        sessionId: "ses_terminal_root",
        provider: "codex",
        runtime: "codex",
        authority: "request",
        model: "gpt-5.5",
        inputTokens: 10,
        outputTokens: 2,
        startedAt: "2026-06-08T00:00:01.000Z",
        endedAt: "2026-06-08T00:00:02.900Z"
      }, {
        schemaVersion: 1,
        atomId: "atom_terminal_child",
        correlationId: "qry_terminal_child",
        queryId: "qry_terminal_child",
        sessionId: "ses_terminal_child",
        provider: "codex",
        runtime: "codex",
        authority: "turn",
        model: "gpt-5.5",
        inputTokens: 5,
        outputTokens: 1,
        startedAt: "2026-06-08T00:00:02.000Z",
        endedAt: "2026-06-08T00:00:02.500Z"
      }],
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "activity_terminal_subagent",
        queryId: "qry_terminal_root",
        sessionId: "ses_terminal_root",
        childSessionId: "ses_terminal_child",
        provider: "codex",
        runtime: "codex",
        kind: "subagent",
        name: "explorer",
        outcome: "success",
        startedAt: "2026-06-08T00:00:02.000Z",
        endedAt: "2026-06-08T00:00:02.500Z"
      }]
    });
    const service = new ProductionUsageService(storage, () => new Date("2026-06-08T00:00:04.000Z"));
    await service.startCleanEpoch("2026-06-08T00:00:00.000Z");

    expect(await service.projectCompletedQuery("agent_full_owner", "qry_terminal_root")).toEqual([
      expect.objectContaining({
        queryId: "qry_terminal_root",
        inputTokens: 15,
        outputTokens: 3,
        totalTokens: 18,
        breakdown: expect.arrayContaining([
          expect.objectContaining({ kind: "subagent", name: "explorer", totalTokens: 6 })
        ])
      })
    ]);
    expect(await storage.listProductionRuns()).toEqual([
      expect.objectContaining({ queryId: "qry_terminal_root", totalTokens: 18 })
    ]);
    await storage.close();
  });

  it("keeps incomplete usage out of the durable ledger, totals, and completed-run queries", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-current-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_usage_owner", protocolVersion: "1.0" });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-otlp-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation(observation("current", "2026-06-08T00:00:01.000Z", false));
    const service = new ProductionUsageService(storage);
    await service.startCleanEpoch("2026-06-08T00:00:00.000Z");
    expect(await service.rebuild("agent_usage_owner")).toEqual([]);
    expect(await service.currentRuns("agent_usage_owner")).toEqual([
      expect.objectContaining({ runId: "run_current_12345678", endedAt: undefined })
    ]);
    expect(await service.totals("agent_usage_owner")).toMatchObject({ runCount: 0, totalTokens: 0 });
    expect(await storage.listProductionRuns()).toEqual([]);
    await storage.close();
  });

  it("applies agent-owned completed-run retention without retaining old product facts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-retention-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_usage_owner", protocolVersion: "1.0" });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-otlp-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: [],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2025-01-01T00:00:00.000Z");
    await storage.appendSafeObservation(observation("old", "2025-01-01T00:00:00.000Z"));
    await storage.appendSafeObservation(observation("new", "2026-06-08T00:00:00.000Z"));
    const service = new ProductionUsageService(storage);
    await service.startCleanEpoch("2025-01-01T00:00:00.000Z");
    expect(await service.rebuild("agent_usage_owner")).toHaveLength(2);
    expect(await service.applyRetention("agent_usage_owner", 180, new Date("2026-06-08T00:00:00.000Z")))
      .toEqual([expect.objectContaining({ runId: "run_new_12345678" })]);
    expect(await service.totals("agent_usage_owner")).toMatchObject({ runCount: 1, totalTokens: 15 });
    await storage.close();
  });
});

function observation(id: string, observedAt: string, completed = true) {
  return {
    schemaVersion: 1 as const,
    observationId: `observation_${id}_12345678`,
    sourceId: "source_12345678",
    provider: "codex" as const,
    runtime: "codex",
    signal: "traces" as const,
    profileVersion: "codex-otlp-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    usageAtoms: [{
      schemaVersion: 1 as const,
      atomId: `atom_${id}_12345678`,
      correlationId: `cor_${id}_12345678`,
      provider: "codex" as const,
      runtime: "codex",
      authority: "turn" as const,
      model: "gpt-5.4",
      inputTokens: 10,
      outputTokens: 5,
      startedAt: observedAt,
      endedAt: completed ? observedAt : undefined
    }]
  };
}

function productionRun(id: string, startedAt: string): ProductionRunV1 {
  return {
    schemaVersion: 1,
    production: true,
    runId: `run_${id}_12345678`,
    correlationId: `cor_${id}_12345678`,
    provider: "codex",
    runtime: "codex",
    model: "gpt-5.4",
    authority: "turn",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 15,
    estimatedNanoUsd: 0,
    pricingVersion: "test",
    billingContext: "unknown",
    costCoverage: "none",
    evidenceGrade: "estimated_usage_cost_unattributed",
    startedAt,
    endedAt: startedAt,
    warnings: []
  };
}
