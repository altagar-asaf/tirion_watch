import { describe, expect, it } from "vitest";
import { pricingCatalogForBillingContext } from "../billing/billingContextResolver";
import { BillingContextId, ModelPricing, PricingCatalog } from "../types";
import { DefaultCostEstimation } from "./costEstimation";

describe("DefaultCostEstimation", () => {
  it("suppresses estimates when model pricing is unknown in the active catalog", () => {
    const estimator = new DefaultCostEstimation(testCatalog([]));

    expect(
      estimator.estimate({
        models: ["unknown-model"],
        startedAt: "2026-05-28T00:00:00.000Z",
        tokens: {
          source: "invoke_agent",
          warnings: [],
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500
        }
      })
    ).toBeNull();
  });

  it("estimates non-cached input, cached input, cache writes, and output costs", () => {
    const estimator = new DefaultCostEstimation(testCatalog([
      {
        provider: "openai",
        modelPattern: "gpt-test",
        inputUsdPerMillion: 10,
        cachedInputUsdPerMillion: 1,
        cacheCreationUsdPerMillion: 5,
        outputUsdPerMillion: 30,
        effectiveFrom: "2026-01-01"
      }
    ]));

    const result = estimator.estimate({
      models: ["gpt-test"],
      startedAt: "2026-05-28T00:00:00.000Z",
      tokens: {
        source: "invoke_agent",
        warnings: [],
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadInputTokens: 200_000,
        cacheCreationInputTokens: 100_000,
        cachedTokens: 300_000,
        totalTokens: 1_500_000
      }
    });

    expect(result?.estimatedNanoUsd).toBe(22_700_000_000);
    expect(result?.estimatedUsd).toBeCloseTo(22.7);
    expect(result?.estimatedAiCredits).toBeCloseTo(2270);
    expect(result?.billingContext).toBe("openai-direct");
  });

  it("uses direct OpenAI pricing only when the OpenAI direct catalog is active", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("openai-direct"));

    const result = estimator.estimate({
      models: ["gpt-5.3-codex"],
      startedAt: "2026-05-30T00:00:00.000Z",
      tokens: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 100_000,
        cachedTokens: 100_000,
        totalTokens: 2_000_000
      }
    });

    expect(result?.estimatedNanoUsd).toBe(15_592_500_000);
    expect(result?.estimatedUsd).toBeCloseTo(15.5925);
    expect(result?.pricingMatch).toMatchObject({ billingContext: "openai-direct", provider: "openai" });
  });

  it("prices updated direct OpenAI frontier rows and long-context tiers", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("openai-direct"));
    const cases: [model: string, inputTokens: number, outputTokens: number, expectedNanoUsd: number][] = [
      ["gpt-5.4", 272_000, 1_000, 695_000_000],
      ["gpt-5.4", 272_001, 1_000, 1_382_505_000],
      ["gpt-5.5", 272_000, 1_000, 1_390_000_000],
      ["gpt-5.5", 272_001, 1_000, 2_765_010_000],
      ["gpt-5.4-nano", 1_000_000, 1_000_000, 1_450_000_000],
      ["gpt-5.4-pro", 1_000_000, 1_000_000, 330_000_000_000],
      ["gpt-5.5-pro", 272_001, 1_000, 16_590_060_000]
    ];

    for (const [model, inputTokens, outputTokens, expectedNanoUsd] of cases) {
      const result = estimator.estimateModelUsage({
        usage: {
          model,
          provider: "openai",
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens
        },
        startedAt: "2026-07-01T00:00:00.000Z"
      });

      expect(result.estimatedNanoUsd).toBe(expectedNanoUsd);
      expect(result.pricingCoverage).toMatchObject({
        state: "priced",
        pricingVersions: ["openai-pricing-2026-07-01-standard"]
      });
    }
  });

  it("does not fall through to direct API pricing when Copilot catalog has no matching provider/model pair", () => {
    const estimator = new DefaultCostEstimation(testCatalog([], "github-copilot"));

    const result = estimator.estimateModelUsage({
      usage: {
        model: "gpt-5.3-codex",
        provider: "openai",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000
      },
      startedAt: "2026-06-03T00:00:00.000Z"
    });

    expect(result.estimatedNanoUsd).toBe(0);
    expect(result.pricingCoverage).toMatchObject({
      state: "unpriced",
      reasons: ["model_unpriced"],
      unpricedModels: ["gpt-5.3-codex"]
    });
    expect(result.billingContext).toBe("github-copilot");
  });

  it("selects the latest pricing row effective at the run start time", () => {
    const estimator = new DefaultCostEstimation(testCatalog([
      {
        provider: "openai",
        modelPattern: "^gpt-test$",
        inputUsdPerMillion: 10,
        outputUsdPerMillion: 20,
        effectiveFrom: "2026-01-01"
      },
      {
        provider: "openai",
        modelPattern: "^gpt-test$",
        inputUsdPerMillion: 12,
        outputUsdPerMillion: 24,
        effectiveFrom: "2026-06-01"
      }
    ]));

    const beforeBoundary = estimator.estimateModelUsage({
      usage: {
        model: "gpt-test",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        totalTokens: 1_500_000
      },
      startedAt: "2026-05-31T23:59:59.000Z"
    });

    const onBoundary = estimator.estimateModelUsage({
      usage: {
        model: "gpt-test",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        totalTokens: 1_500_000
      },
      startedAt: "2026-06-01T00:00:00.000Z"
    });

    expect(beforeBoundary.estimatedNanoUsd).toBe(20_000_000_000);
    expect(beforeBoundary.pricingMatch).toMatchObject({ effectiveFrom: "2026-01-01" });

    expect(onBoundary.estimatedNanoUsd).toBe(24_000_000_000);
    expect(onBoundary.pricingMatch).toMatchObject({ effectiveFrom: "2026-06-01" });
  });

  it("prices all GitHub-published Copilot model rows from the Copilot catalog", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("github-copilot"));

    const cases: [model: string, provider: string, expectedNanoUsd: number][] = [
      ["gpt-5-mini", "openai", 2_250_000_000],
      ["gpt-5.3-codex", "openai", 15_750_000_000],
      ["gpt-5.4-mini", "openai", 5_250_000_000],
      ["gpt-5.4-nano", "openai", 1_450_000_000],
      ["claude-haiku-4.5", "anthropic", 6_000_000_000],
      ["claude-sonnet-4", "anthropic", 18_000_000_000],
      ["claude-sonnet-4.5", "anthropic", 18_000_000_000],
      ["claude-sonnet-4.6", "github", 18_000_000_000],
      ["claude-opus-4.5", "anthropic", 30_000_000_000],
      ["claude-opus-4.6", "anthropic", 30_000_000_000],
      ["claude-opus-4.7", "anthropic", 30_000_000_000],
      ["claude-opus-4.8", "anthropic", 30_000_000_000],
      ["claude-sonnet-5", "anthropic", 12_000_000_000],
      ["claude-opus-4.8-fast-mode", "anthropic", 60_000_000_000],
      ["claude-fable-5", "anthropic", 60_000_000_000],
      ["gemini-2.5-pro", "google", 11_250_000_000],
      ["gemini-3-flash", "google", 3_500_000_000],
      ["gemini-3.5-flash", "google", 10_500_000_000],
      ["raptor-mini", "github", 2_250_000_000],
      ["mai-code-1-flash", "microsoft", 5_250_000_000]
    ];

    for (const [model, provider, expectedNanoUsd] of cases) {
      expect(priceOneMillion(estimator, model, provider)).toBe(expectedNanoUsd);
    }
  });

  it("prices GPT-5 mini as a Copilot billed model from the current GitHub table", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("github-copilot"));

    const result = estimator.estimateModelUsage({
      usage: {
        model: "gpt-5-mini",
        provider: "openai",
        inputTokens: 1_000_000,
        cacheReadInputTokens: 100_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000
      },
      startedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(result.estimatedNanoUsd).toBe(2_227_500_000);
    expect(result.estimatedAiCredits).toBeCloseTo(222.75);
    expect(result.pricingCoverage).toMatchObject({
      state: "priced",
      pricedModels: ["gpt-5-mini"],
      unpricedModels: []
    });
  });

  it("prices Anthropic Copilot cache creation tokens using GitHub cache-write rates", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("github-copilot"));

    const result = estimator.estimateModelUsage({
      usage: {
        model: "claude-sonnet-4.6",
        provider: "anthropic",
        inputTokens: 1_000_000,
        cacheReadInputTokens: 400_000,
        cacheCreationInputTokens: 100_000,
        outputTokens: 500_000,
        totalTokens: 1_500_000
      },
      startedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(result.estimatedNanoUsd).toBe(9_495_000_000);
    expect(result.pricingCoverage).toMatchObject({
      state: "priced",
      reasons: [],
      pricingVersions: ["copilot-pricing-2026-07-01"]
    });
  });

  it("keeps direct Anthropic cache creation partial without a direct cache-write duration signal", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("anthropic-direct"));

    const result = estimator.estimateModelUsage({
      usage: {
        model: "claude-sonnet-4.6",
        provider: "anthropic",
        inputTokens: 1_000_000,
        cacheReadInputTokens: 400_000,
        cacheCreationInputTokens: 100_000,
        outputTokens: 500_000,
        totalTokens: 1_500_000
      },
      startedAt: "2026-06-01T00:00:00.000Z"
    });

    expect(result.estimatedNanoUsd).toBe(9_120_000_000);
    expect(result.pricingCoverage).toEqual({
      state: "partial",
      reasons: ["pricing_rate_missing"],
      pricedModels: ["claude-sonnet-4.6"],
      unpricedModels: ["claude-sonnet-4.6"],
      missingModelSlices: 0,
      pricingVersions: ["anthropic-pricing-2026-07-01-first-party"],
      pricingEffectiveFrom: ["2026-06-01"]
    });
  });

  it("prices current direct Anthropic additions and the Sonnet 5 pricing boundary", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("anthropic-direct"));
    const cases: [model: string, startedAt: string, expectedNanoUsd: number, effectiveFrom: string][] = [
      ["claude-sonnet-5", "2026-07-01T00:00:00.000Z", 11_820_000_000, "2026-07-01"],
      ["claude-sonnet-5", "2026-09-01T00:00:00.000Z", 17_730_000_000, "2026-09-01"],
      ["claude-fable-5", "2026-07-01T00:00:00.000Z", 59_100_000_000, "2026-07-01"],
      ["claude-mythos-5", "2026-07-01T00:00:00.000Z", 59_100_000_000, "2026-07-01"],
      ["claude-opus-4.1", "2026-07-01T00:00:00.000Z", 88_650_000_000, "2026-07-01"]
    ];

    for (const [model, startedAt, expectedNanoUsd, effectiveFrom] of cases) {
      const result = estimator.estimateModelUsage({
        usage: {
          model,
          provider: "anthropic",
          inputTokens: 1_000_000,
          cacheReadInputTokens: 100_000,
          outputTokens: 1_000_000,
          totalTokens: 2_000_000
        },
        startedAt
      });

      expect(result.estimatedNanoUsd).toBe(expectedNanoUsd);
      expect(result.pricingCoverage).toMatchObject({
        state: "priced",
        pricingVersions: ["anthropic-pricing-2026-07-01-first-party"],
        pricingEffectiveFrom: [effectiveFrom]
      });
    }
  });

  it("prices Cursor-published Auto and Composer model rows", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("cursor"));
    const cases: [model: string, expectedNanoUsd: number][] = [
      ["auto", 7_250_000_000],
      ["composer-1", 11_250_000_000],
      ["composer-1.5", 21_000_000_000],
      ["composer-2", 3_000_000_000],
      ["composer-2-fast", 9_000_000_000],
      ["composer-2.5", 3_000_000_000],
      ["composer-2.5-fast", 18_000_000_000]
    ];

    for (const [model, expectedNanoUsd] of cases) {
      const result = estimator.estimateModelUsage({
        usage: {
          model,
          provider: "cursor",
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          totalTokens: 2_000_000
        },
        startedAt: "2026-07-03T00:00:00.000Z"
      });

      expect(result.estimatedNanoUsd).toBe(expectedNanoUsd);
      expect(result.pricingCoverage).toMatchObject({
        state: "priced",
        pricingVersions: ["cursor-pricing-2026-07-03"]
      });
      expect(result.pricingMatch).toMatchObject({ billingContext: "cursor", provider: "cursor" });
    }
  });

  it("prices Cursor Composer cache-read-heavy runs using Cursor rates", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("cursor"));

    const result = estimator.estimateModelUsage({
      usage: {
        model: "composer-2.5-fast",
        provider: "cursor",
        inputTokens: 68_310,
        cacheReadInputTokens: 67_046,
        outputTokens: 537,
        totalTokens: 68_847
      },
      startedAt: "2026-07-03T00:00:00.000Z"
    });

    expect(result.estimatedNanoUsd).toBe(45_370_000);
    expect(result.pricingCoverage).toMatchObject({
      state: "priced",
      pricingVersions: ["cursor-pricing-2026-07-03"]
    });
  });

  it("selects Copilot long-context rates by input token threshold", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("github-copilot"));

    const cases: [model: string, provider: string, inputTokens: number, outputTokens: number, expectedNanoUsd: number][] = [
      ["gpt-5.4", "openai", 272_000, 1_000, 695_000_000],
      ["gpt-5.4", "openai", 272_001, 1_000, 1_382_505_000],
      ["gpt-5.5", "openai", 272_000, 1_000, 1_390_000_000],
      ["gpt-5.5", "openai", 272_001, 1_000, 2_765_010_000],
      ["gemini-3.1-pro", "google", 200_000, 1_000, 412_000_000],
      ["gemini-3.1-pro", "google", 200_001, 1_000, 818_004_000]
    ];

    for (const [model, provider, inputTokens, outputTokens, expectedNanoUsd] of cases) {
      const result = estimator.estimateModelUsage({
        usage: {
          model,
          provider,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens
        },
        startedAt: "2026-07-01T00:00:00.000Z"
      });

      expect(result.estimatedNanoUsd).toBe(expectedNanoUsd);
      expect(result.pricingCoverage).toMatchObject({
        state: "priced",
        reasons: [],
        pricedModels: [model],
        unpricedModels: []
      });
    }
  });

  it("marks attributed usage as unpriced when model attribution is missing", () => {
    const estimator = new DefaultCostEstimation(pricingCatalogForBillingContext("github-copilot"));

    const result = estimator.estimateAttributedUnit({
      unit: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120
      },
      startedAt: "2026-06-03T00:00:00.000Z"
    });

    expect(result.estimatedNanoUsd).toBe(0);
    expect(result.billingContext).toBe("github-copilot");
    expect(result.pricingCoverage).toEqual({
      state: "unpriced",
      reasons: ["missing_model_attribution"],
      pricedModels: [],
      unpricedModels: [],
      missingModelSlices: 1,
      pricingVersions: [],
      pricingEffectiveFrom: []
    });
  });
});

function testCatalog(
  pricingTable: ModelPricing[],
  billingContext: BillingContextId = "openai-direct",
  pricingVersions: string[] = ["test"]
): PricingCatalog {
  return {
    billingContext,
    primaryBillingUnit: billingContext === "github-copilot" ? "aiCredits" : "usd",
    pricingVersions,
    pricingTable: pricingTable.map((pricing) => ({ pricingVersion: pricing.pricingVersion ?? pricingVersions[0], ...pricing }))
  };
}

function priceOneMillion(estimator: DefaultCostEstimation, model: string, provider: string): number {
  return estimator.estimateModelUsage({
    usage: {
      model,
      provider,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000
    },
    startedAt: "2026-07-01T00:00:00.000Z"
  }).estimatedNanoUsd;
}
