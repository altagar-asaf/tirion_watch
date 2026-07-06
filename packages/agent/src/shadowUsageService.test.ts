import { describe, expect, it } from "vitest";
import type { ShadowRunV1 } from "@tirion/agent-contract";
import type { AgentStorageClient } from "@tirion/agent-storage";
import { ShadowUsageService } from "./shadowUsageService";

describe("shadow usage service", () => {
  it("uses a recent reconciliation window when shadow history already exists", async () => {
    const usageStarts: string[] = [];
    const activityStarts: string[] = [];
    let occurrenceReadCount = 0;
    let replacedRuns: ShadowRunV1[] = [];
    const storage = {
      listShadowRuns: async () => [shadowRun("existing", "2026-04-10T00:00:00.000Z")],
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
      replaceShadowRuns: async (runs: ShadowRunV1[]) => {
        replacedRuns = runs;
      }
    } as unknown as AgentStorageClient;
    const service = new ShadowUsageService(
      storage,
      () => new Date("2026-06-30T00:00:00.000Z")
    );

    expect(await service.rebuild()).toEqual([
      expect.objectContaining({ runId: "shadow_existing_12345678" })
    ]);
    expect(usageStarts).toEqual(["2026-06-23T00:00:00.000Z"]);
    expect(occurrenceReadCount).toBe(1);
    expect(activityStarts).toEqual(["2026-06-23T00:00:00.000Z"]);
    expect(replacedRuns).toEqual([
      expect.objectContaining({ runId: "shadow_existing_12345678" })
    ]);
  });
});

function shadowRun(id: string, startedAt: string): ShadowRunV1 {
  return {
    schemaVersion: 1,
    shadow: true,
    runId: `shadow_${id}_12345678`,
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
