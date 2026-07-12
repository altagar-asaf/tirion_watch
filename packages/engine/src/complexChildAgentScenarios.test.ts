import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activitiesForComplexScenario,
  complexChildAgentScenarios,
  occurrencesForComplexScenario,
  sumComplexRunTokens,
  usageAtomsForComplexScenario
} from "../../../test-fixtures/complexChildAgentScenarios";
import { DefaultProductionUsagePipeline } from "./shadowUsage";

describe("complex child-agent scenario fixtures", () => {
  it("remain metadata-only and repository-relative", () => {
    const forbiddenKeys = new Set([
      "promptText",
      "responseText",
      "toolInput",
      "toolOutput",
      "command",
      "fileContent",
      "diff",
      "transcriptPath",
      "absolutePath"
    ]);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        expect(forbiddenKeys.has(key)).toBe(false);
        visit(child);
      }
    };

    visit(complexChildAgentScenarios);
    for (const scenario of complexChildAgentScenarios) {
      for (const write of scenario.writes) {
        expect(write.artifactKey).toMatch(/^[a-f0-9]{64}$/);
        expect(isAbsolute(write.relativePath)).toBe(false);
        expect(write.relativePath.split("/")).not.toContain("..");
      }
    }
  });

  for (const scenario of complexChildAgentScenarios) {
    it(`replays ${scenario.fixtureId} as one exact public root`, () => {
      const runs = new DefaultProductionUsagePipeline().project(
        usageAtomsForComplexScenario(scenario),
        new Date(Date.parse(scenario.root.endedAt) + 1_000),
        occurrencesForComplexScenario(scenario),
        activitiesForComplexScenario(scenario)
      );
      expect(runs).toHaveLength(1);

      const run = runs[0];
      const childTokens = sumComplexRunTokens(scenario.children.map((child) => child.tokens));
      const publicTokens = sumComplexRunTokens([scenario.root.tokens, childTokens]);
      expect(childTokens.totalTokens).toBe(scenario.expected.childTotalTokens);
      expect(publicTokens.totalTokens).toBe(scenario.expected.publicTotalTokens);
      expect(run).toMatchObject({
        runId: `run_${scenario.root.queryId.slice(4)}`,
        queryId: scenario.root.queryId,
        sessionId: scenario.root.sessionId,
        repositoryKey: scenario.repositoryKey,
        authority: "turn",
        ...publicTokens,
        startedAt: scenario.root.startedAt,
        endedAt: scenario.root.endedAt,
        warnings: expect.arrayContaining(["lower_authority_overlap_discarded"])
      });

      const breakdown = run.breakdown ?? [];
      const subagent = breakdown.find((row) => row.kind === "subagent" && row.name === scenario.subagent.name);
      expect(subagent).toMatchObject({
        count: scenario.children.length,
        failureCount: 0,
        unknownCount: scenario.children.length,
        ...childTokens,
        attributionBasis: "trace_descendant",
        coverage: "complete"
      });
      expect(breakdown.find((row) => row.kind === "unallocated")).toMatchObject({
        ...scenario.root.tokens,
        attributionBasis: "unavailable"
      });

      for (const expected of scenario.rootTools.filter((tool) => tool.name !== "Bash")) {
        expect(breakdown.find((row) => row.kind === "tool" && row.name === expected.name && !row.parentBreakdownId))
          .toMatchObject({
            count: expected.count,
            failureCount: expected.outcome === "failure" || expected.outcome === "rejected" ? expected.count : 0,
            unknownCount: expected.outcome === "unknown" ? expected.count : 0
          });
      }

      const shellRows = breakdown.filter((row) => row.kind === "tool" && row.name === "Bash");
      expect(shellRows.reduce((sum, row) => sum + row.count, 0)).toBe(scenario.expected.shellCount);
      expect(shellRows.reduce((sum, row) => sum + (row.unknownCount ?? 0), 0)).toBe(scenario.expected.shellCount);
      expect(shellRows.filter((row) => row.parentBreakdownId)).toHaveLength(scenario.children.length);

      for (const key of [
        "inputTokens",
        "outputTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
        "reasoningOutputTokens",
        "totalTokens"
      ] as const) {
        expect(breakdown.reduce((sum, row) => sum + (row[key] ?? 0), 0)).toBe(run[key]);
      }

      const serialized = JSON.stringify(runs);
      expect(serialized).not.toContain(scenario.internalSession.queryId);
      expect(serialized).not.toContain(scenario.internalSession.sessionId);
      expect(serialized).not.toContain("internal_title_generation");
      expect(scenario.internalSession.tokens.totalTokens).toBe(scenario.expected.excludedInternalTokens);
      for (const child of scenario.children) {
        expect(runs.some((candidate) => candidate.queryId === child.queryId)).toBe(false);
      }
    });
  }
});
