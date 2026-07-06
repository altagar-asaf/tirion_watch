import { describe, expect, it } from "vitest";
import { DefaultShadowUsagePipeline } from "@tirion/engine";
import { DefaultTokenMeasurement } from "../aggregation/tokenMeasurement";
import { DefaultCostEstimation } from "../pricing/costEstimation";
import { pricingCatalogForBillingContext } from "../billing/billingContextResolver";
import type { AssembledAgentTrace } from "../types";

describe("agent shadow compatibility", () => {
  it("matches current Copilot token authority and estimated cost for a root-plus-chat fixture", () => {
    const trace = copilotTrace();
    const currentUsage = new DefaultTokenMeasurement().measure(trace);
    const currentEstimate = new DefaultCostEstimation(pricingCatalogForBillingContext("github-copilot")).estimateAttributedUnit({
      unit: currentUsage.attributedUsageUnits[0],
      startedAt: "2026-07-01T00:00:00.000Z"
    });
    const shadowRuns = new DefaultShadowUsagePipeline().project([
      {
        schemaVersion: 1,
        atomId: "root",
        correlationId: "cor_fixture",
        provider: "github-copilot",
        runtime: "github-copilot",
        authority: "run",
        model: "gpt-5.4",
        inputTokens: 100,
        outputTokens: 20,
        startedAt: "2026-07-01T00:00:00.000Z"
      },
      {
        schemaVersion: 1,
        atomId: "chat",
        correlationId: "cor_fixture",
        provider: "github-copilot",
        runtime: "github-copilot",
        authority: "model",
        model: "gpt-5.4",
        inputTokens: 100,
        outputTokens: 20,
        startedAt: "2026-07-01T00:00:00.000Z"
      }
    ]);

    expect(shadowRuns[0]).toMatchObject({
      inputTokens: currentUsage.inputTokens,
      outputTokens: currentUsage.outputTokens,
      totalTokens: currentUsage.totalTokens,
      estimatedNanoUsd: currentEstimate.estimatedNanoUsd
    });
  });
});

function copilotTrace(): AssembledAgentTrace {
  return {
    traceId: "fixture-trace",
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastUpdatedAt: "2026-07-01T00:00:01.000Z",
    rootSpan: {
      kind: "span",
      traceId: "fixture-trace",
      spanId: "root",
      name: "invoke_agent",
      attributes: {
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      },
      resourceAttributes: { "service.name": "github-copilot" }
    },
    spans: [{
      kind: "span",
      traceId: "fixture-trace",
      spanId: "chat",
      name: "chat",
      attributes: {
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      },
      resourceAttributes: { "service.name": "github-copilot" }
    }],
    events: [],
    metrics: []
  };
}
