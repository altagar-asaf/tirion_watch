import {
  AccountingCoverageReason,
  aiCreditsFromNanoUsd,
  AttributedUsageUnit,
  CostEstimate,
  CostEstimation,
  inferProviderFromModel,
  ModelPricing,
  ModelUsageSummary,
  NANO_USD_PER_USD,
  PricingCoverageSummary,
  PricingCatalog,
  PricingMatchMetadata,
  TokenBreakdown,
  normalizeProvider,
  usdFromNanoUsd
} from "../types";

const EMPTY_PRICING_CATALOG: PricingCatalog = {
  billingContext: "openai-direct",
  primaryBillingUnit: "usd",
  pricingVersions: [],
  pricingTable: []
};

export class DefaultCostEstimation implements CostEstimation {
  private readonly pricingTable: ModelPricing[];

  constructor(
    private readonly pricingCatalog: PricingCatalog = EMPTY_PRICING_CATALOG
  ) {
    this.pricingTable = [...pricingCatalog.pricingTable];
  }

  estimate(input: {
    models: string[];
    tokens: TokenBreakdown;
    startedAt: string;
  }): CostEstimate | null {
    if (input.models.length !== 1 || !hasAnyTokenData(input.tokens)) {
      return null;
    }

    const estimate = this.estimateTokensForModel({
      model: input.models[0],
      tokens: input.tokens,
      startedAt: input.startedAt
    });

    return estimate.pricingCoverage.state === "unpriced" ? null : estimate;
  }

  estimateModelUsage(input: {
    usage: Pick<ModelUsageSummary, "model" | "provider" | "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cachedTokens" | "reasoningOutputTokens" | "totalTokens">;
    startedAt: string;
  }): CostEstimate {
    return this.estimateTokensForModel({
      model: input.usage.model,
      provider: input.usage.provider,
      tokens: input.usage,
      startedAt: input.startedAt
    });
  }

  estimateAttributedUnit(input: {
    unit: Pick<AttributedUsageUnit, "model" | "provider" | "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cachedTokens" | "reasoningOutputTokens" | "totalTokens">;
    startedAt: string;
  }): CostEstimate {
    return this.estimateTokensForModel({
      model: input.unit.model,
      provider: input.unit.provider,
      tokens: input.unit,
      startedAt: input.startedAt
    });
  }

  private findPricing(
    models: string[],
    startedAt: string,
    provider?: string,
    tokens?: TokenBreakdown
  ): { model: string; pricing: ModelPricing; provider?: string } | null {
    const date = new Date(startedAt).getTime();
    const candidates = this.pricingTable
      .map((pricing, index) => ({ pricing, index }))
      .filter(({ pricing }) => new Date(pricing.effectiveFrom).getTime() <= date)
      .sort((a, b) => {
        const byDate = new Date(b.pricing.effectiveFrom).getTime() - new Date(a.pricing.effectiveFrom).getTime();
        return byDate || a.index - b.index;
      });

    for (const model of models) {
      const providerCandidates = pricingProviderCandidates(model, provider);
      for (const { pricing } of candidates) {
        const pricingProvider = normalizeProvider(pricing.provider);
        const matchedProvider = providerCandidates.find((candidate) => !pricingProvider || candidate === pricingProvider);
        if (pricingProvider && !matchedProvider) {
          continue;
        }
        if (matchesPattern(model, pricing.modelPattern) && matchesTokenRange(pricing, tokens)) {
          return { model, pricing, provider: matchedProvider ?? pricingProvider };
        }
      }
    }

    return null;
  }

  private estimateTokensForModel(input: {
    model?: string;
    provider?: string;
    tokens: TokenBreakdown;
    startedAt: string;
  }): CostEstimate {
    const baseNotes = [
      `Estimated from local token telemetry and the active ${this.pricingCatalog.billingContext} pricing catalog when rates are available.`,
      "Billing can include policies, routing, tiers, discounts, allowances, or rounding not visible in local telemetry."
    ];

    if (!hasAnyTokenData(input.tokens)) {
      return buildEstimate({
        estimatedNanoUsd: 0,
        billingContext: this.pricingCatalog.billingContext,
        pricingCoverage: {
          state: "unpriced",
          reasons: ["not_applicable"],
          pricedModels: [],
          unpricedModels: [],
          missingModelSlices: 0,
          pricingVersions: [],
          pricingEffectiveFrom: []
        },
        notes: baseNotes
      });
    }

    if (!input.model || input.model.trim() === "") {
      return buildEstimate({
        estimatedNanoUsd: 0,
        billingContext: this.pricingCatalog.billingContext,
        pricingCoverage: {
          state: "unpriced",
          reasons: ["missing_model_attribution"],
          pricedModels: [],
          unpricedModels: [],
          missingModelSlices: 1,
          pricingVersions: [],
          pricingEffectiveFrom: []
        },
        notes: [...baseNotes, "Model attribution was missing, so this usage slice could not be priced."]
      });
    }

    const effectiveProvider = normalizeProvider(input.provider) ?? inferProviderFromModel(input.model);
    const match = this.findPricing([input.model], input.startedAt, effectiveProvider, input.tokens);
    if (!match) {
      const providerDescription = effectiveProvider;
      return buildEstimate({
        estimatedNanoUsd: 0,
        billingContext: this.pricingCatalog.billingContext,
        pricingCoverage: {
          state: "unpriced",
          reasons: ["model_unpriced"],
          pricedModels: [],
          unpricedModels: [input.model],
          missingModelSlices: 0,
          pricingVersions: [],
          pricingEffectiveFrom: []
        },
        notes: [
          ...baseNotes,
          providerDescription
            ? `No active ${this.pricingCatalog.billingContext} ${providerDescription} pricing row matched model ${input.model} at ${input.startedAt}.`
            : `No active ${this.pricingCatalog.billingContext} pricing row matched model ${input.model} at ${input.startedAt}; provider attribution was missing or ambiguous.`
        ]
      });
    }

    const cacheRead = input.tokens.cacheReadInputTokens ?? 0;
    const cacheCreation = input.tokens.cacheCreationInputTokens ?? 0;
    const inputTokens = input.tokens.inputTokens ?? 0;
    const outputTokens = resolveBilledOutputTokens(input.tokens);
    const nonCachedInput = Math.max(0, inputTokens - cacheRead - cacheCreation);

    const components = [
      priceComponent(nonCachedInput, match.pricing.inputUsdPerMillion),
      priceComponent(cacheRead, match.pricing.cachedInputUsdPerMillion),
      priceComponent(cacheCreation, match.pricing.cacheCreationUsdPerMillion),
      priceComponent(outputTokens, match.pricing.outputUsdPerMillion)
    ];
    const estimatedNanoUsd = components.reduce((sum, component) => sum + component.estimatedNanoUsd, 0);
    const missingRate = components.some((component) => component.missingRate);
    const longContextUnpublished = isLongContextUnpublished(match.pricing, inputTokens);
    const reasons: AccountingCoverageReason[] = [
      ...(missingRate ? ["pricing_rate_missing"] as AccountingCoverageReason[] : []),
      ...(longContextUnpublished ? ["long_context_rate_unpublished"] as AccountingCoverageReason[] : [])
    ];
    const pricingVersion = resolvePricingVersion(match.pricing, this.pricingCatalog.pricingVersions[0] ?? "");
    const coverageState: PricingCoverageSummary["state"] = reasons.length > 0
      ? (missingRate && estimatedNanoUsd === 0 ? "unpriced" : "partial")
      : "priced";

    const pricingCoverage: PricingCoverageSummary = {
      state: coverageState,
      reasons,
      pricedModels: [input.model],
      unpricedModels: reasons.length > 0 ? [input.model] : [],
      missingModelSlices: 0,
      pricingVersions: [pricingVersion],
      pricingEffectiveFrom: [match.pricing.effectiveFrom]
    };
    const pricingMatch: PricingMatchMetadata = {
      billingContext: this.pricingCatalog.billingContext,
      provider: match.provider ?? match.pricing.provider,
      model: input.model,
      matchedModel: match.model,
      pricingVersion,
      effectiveFrom: match.pricing.effectiveFrom,
      sourceUrl: match.pricing.sourceUrl,
      notes: uniqueStrings([match.pricing.notes ?? ""])
    };
    const notes = [...baseNotes, match.pricing.notes ?? ""];
    if (missingRate) {
      notes.push(`Some token categories for ${input.model} had no matching price rate, so the estimate is partial.`);
    }
    if (longContextUnpublished && match.pricing.longContextNote) {
      notes.push(match.pricing.longContextNote);
    }

    return buildEstimate({
      estimatedNanoUsd,
      billingContext: this.pricingCatalog.billingContext,
      pricingMatch,
      pricingCoverage,
      notes
    });
  }
}

function priceComponent(tokens: number, usdPerMillion?: number): { estimatedNanoUsd: number; missingRate: boolean } {
  if (tokens === 0) {
    return { estimatedNanoUsd: 0, missingRate: false };
  }

  if (usdPerMillion == null) {
    return { estimatedNanoUsd: 0, missingRate: true };
  }

  return {
    estimatedNanoUsd: Math.round((tokens * usdPerMillion * NANO_USD_PER_USD) / 1_000_000),
    missingRate: false
  };
}

function resolveBilledOutputTokens(tokens: TokenBreakdown): number {
  if (tokens.outputTokens != null) {
    return Math.max(0, tokens.outputTokens);
  }

  if (tokens.totalTokens != null && tokens.inputTokens != null) {
    return Math.max(0, tokens.totalTokens - tokens.inputTokens);
  }

  return 0;
}

function buildEstimate(input: {
  estimatedNanoUsd: number;
  billingContext?: PricingMatchMetadata["billingContext"];
  pricingCoverage: PricingCoverageSummary;
  pricingMatch?: PricingMatchMetadata;
  notes: string[];
}): CostEstimate {
  const estimatedUsd = usdFromNanoUsd(input.estimatedNanoUsd) ?? 0;
  return {
    billingContext: input.billingContext ?? input.pricingMatch?.billingContext,
    estimatedNanoUsd: input.estimatedNanoUsd,
    estimatedUsd,
    estimatedAiCredits: aiCreditsFromNanoUsd(input.estimatedNanoUsd) ?? 0,
    pricingVersion: input.pricingMatch?.pricingVersion ?? input.pricingCoverage.pricingVersions[0] ?? "",
    matchedModel: input.pricingMatch?.matchedModel ?? input.pricingMatch?.model ?? "",
    pricingMatch: input.pricingMatch,
    pricingCoverage: {
      ...input.pricingCoverage,
      reasons: uniqueReasons(input.pricingCoverage.reasons),
      pricedModels: uniqueStrings(input.pricingCoverage.pricedModels),
      unpricedModels: uniqueStrings(input.pricingCoverage.unpricedModels),
      pricingVersions: uniqueStrings(input.pricingCoverage.pricingVersions),
      pricingEffectiveFrom: uniqueStrings(input.pricingCoverage.pricingEffectiveFrom)
    },
    notes: uniqueStrings(input.notes)
  };
}

function hasAnyTokenData(tokens: TokenBreakdown): boolean {
  return [
    tokens.inputTokens,
    tokens.outputTokens,
    tokens.cacheReadInputTokens,
    tokens.cacheCreationInputTokens,
    tokens.reasoningOutputTokens,
    tokens.totalTokens
  ].some((value) => value != null);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function resolvePricingVersion(pricing: ModelPricing, defaultPricingVersion: string): string {
  return pricing.pricingVersion ?? defaultPricingVersion;
}

function pricingProviderCandidates(model: string, provider?: string): string[] {
  const normalizedProvider = normalizeProvider(provider);
  const inferredProvider = inferProviderFromModel(model);
  if (normalizedProvider === "github" && inferredProvider && inferredProvider !== "github") {
    return [inferredProvider, normalizedProvider];
  }
  return uniqueStrings([normalizedProvider ?? "", inferredProvider ?? ""]);
}

function uniqueReasons(values: AccountingCoverageReason[]): AccountingCoverageReason[] {
  return [...new Set(values)];
}

function matchesPattern(model: string, pattern: string): boolean {
  if (model === pattern) {
    return true;
  }

  try {
    return new RegExp(pattern, "i").test(model);
  } catch {
    return model.toLowerCase().includes(pattern.toLowerCase());
  }
}

function isLongContextUnpublished(pricing: ModelPricing, inputTokens: number): boolean {
  return pricing.longContextInputThreshold != null && inputTokens > pricing.longContextInputThreshold;
}

function matchesTokenRange(pricing: ModelPricing, tokens?: TokenBreakdown): boolean {
  const inputTokens = tokens?.inputTokens ?? 0;
  return (pricing.minInputTokens == null || inputTokens >= pricing.minInputTokens)
    && (pricing.maxInputTokens == null || inputTokens <= pricing.maxInputTokens);
}
