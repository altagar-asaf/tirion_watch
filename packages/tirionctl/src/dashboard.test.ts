import { describe, expect, it } from "vitest";
import type { AgentCommitAttributionV1, ProductionRunV1 } from "@tirion/agent-contract";
import { renderDashboard } from "./dashboard";

describe("renderDashboard", () => {
  it("shows placeholders when there are no commits or runs", () => {
    expect(renderDashboard([], [])).toBe([
      "Start at: no runs recorded",
      "",
      "Commits by provider cost:",
      "  (none)",
      "",
      "Runs by provider:",
      "  (none)",
      ""
    ].join("\n"));
  });

  it("breaks down each commit's cost by provider", () => {
    const attributions: AgentCommitAttributionV1[] = [
      commitAttribution({
        commitHash: "abcdef1234567890",
        repoKey: "github.com/acme/widgets",
        providerCosts: [
          { provider: "claude-code", queryCount: 2, estimatedNanoUsd: 1_500_000 },
          { provider: "codex", queryCount: 1, estimatedNanoUsd: 500_000 }
        ]
      }),
      commitAttribution({
        commitHash: "0011223344556677",
        repoKey: "github.com/acme/widgets",
        providerCosts: []
      })
    ];

    const output = renderDashboard(attributions, []);

    expect(output).toContain("abcdef1234  github.com/acme/widgets  claude-code: $0.0015 (2 queries), codex: $0.0005 (1 query)");
    expect(output).toContain("0011223344  github.com/acme/widgets  (no cost data)");
  });

  it("groups runs by provider and sums their estimated cost", () => {
    const runs: ProductionRunV1[] = [
      productionRun({ provider: "claude-code", estimatedNanoUsd: 1_000_000, usageValueNanoUsd: 1_000_000 }),
      productionRun({ provider: "claude-code", estimatedNanoUsd: 2_000_000, usageValueNanoUsd: 2_000_000 }),
      productionRun({ provider: "codex", estimatedNanoUsd: undefined, usageValueNanoUsd: 500_000 })
    ];

    const output = renderDashboard([], runs);

    expect(output).toContain("claude-code: 2 runs, estimated cost $0.0030, usage value $0.0030");
    expect(output).toContain("codex: 1 run, estimated cost n/a, usage value $0.0005");
  });
});

function commitAttribution(overrides: Partial<AgentCommitAttributionV1>): AgentCommitAttributionV1 {
  return {
    schemaVersion: 1,
    commitHash: "0000000000000000",
    repoKey: "github.com/acme/widgets",
    queryIds: ["query-1"],
    attributedQueryCount: 1,
    estimatedNanoUsd: undefined,
    providerCosts: [],
    costCoverage: "complete",
    decision: "reportable",
    proofKinds: ["exact_content_state"],
    status: "active",
    createdAt: "2026-06-08T00:00:00.000Z",
    ...overrides
  };
}

function productionRun(overrides: Partial<ProductionRunV1>): ProductionRunV1 {
  return {
    schemaVersion: 1,
    production: true,
    runId: "run_12345678",
    correlationId: "correlation_12345678",
    promptState: "unavailable",
    provider: "claude-code",
    runtime: "claude-code",
    authority: "turn",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    billingContext: "anthropic-direct",
    costCoverage: "complete",
    evidenceGrade: "estimated_usage_cost_unattributed",
    startedAt: "2026-06-08T00:00:00.000Z",
    warnings: [],
    ...overrides
  };
}
