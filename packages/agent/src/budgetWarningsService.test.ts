import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStorageClient } from "@tirion/agent-storage";
import type { ProductionRunV1 } from "@tirion/agent-contract";
import { AgentBudgetWarningsService } from "./budgetWarningsService";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("agent budget warnings", () => {
  it("rebuilds durable fixed-precision warnings idempotently from production runs", async () => {
    const storage = await testStorage();
    const service = new AgentBudgetWarningsService(storage);
    const runs = [
      productionRun("run_first", "2026-06-08T01:00:00.000Z", 20, 200),
      productionRun("run_second", "2026-06-08T02:00:00.000Z", 30, 300)
    ];
    const first = await service.configure({
      schemaVersion: 1,
      runTokens: 10,
      runEstimatedNanoUsd: 100,
      dailyEstimatedNanoUsd: 400,
      monthlyEstimatedNanoUsd: 500
    }, runs);
    expect(first.warnings).toHaveLength(6);
    expect(new Set(first.warnings.map((warning) => warning.warningId)).size).toBe(6);
    const second = await service.rebuild(runs);
    expect(second).toEqual(first);
    expect((await new AgentBudgetWarningsService(storage).snapshot()).warnings).toEqual(first.warnings);
    await service.clearWarnings();
    expect((await service.snapshot()).warnings).toEqual([]);
    await storage.close();
  });

  it("rejects non-positive or non-integral threshold policy", async () => {
    const storage = await testStorage();
    const service = new AgentBudgetWarningsService(storage);
    await expect(service.configure({
      schemaVersion: 1,
      runTokens: 0,
      runEstimatedNanoUsd: 1,
      dailyEstimatedNanoUsd: 1,
      monthlyEstimatedNanoUsd: 1
    }, [])).rejects.toThrow("invalid_request");
    await storage.close();
  });
});

async function testStorage(): Promise<AgentStorageClient> {
  const root = mkdtempSync(join(tmpdir(), "tirion-agent-budget-"));
  roots.push(root);
  const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
  await storage.initialize({
    now: "2026-06-08T00:00:00.000Z",
    ownershipState: "agent_full_owner",
    protocolVersion: "1.0"
  });
  return storage;
}

function productionRun(runId: string, startedAt: string, totalTokens: number, estimatedNanoUsd: number): ProductionRunV1 {
  return {
    schemaVersion: 1,
    production: true,
    runId,
    correlationId: `correlation_${runId}`,
    provider: "codex",
    runtime: "codex",
    model: "gpt-5.4",
    authority: "turn",
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
    estimatedNanoUsd,
    pricingVersion: "test",
    billingContext: "openai-direct",
    costCoverage: "complete",
    evidenceGrade: "estimated_usage_cost_unattributed",
    startedAt,
    warnings: []
  };
}
