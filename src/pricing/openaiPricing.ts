import { ModelPricing } from "../types";

export const OPENAI_PRICING_VERSION = "openai-pricing-2026-07-01-standard";
export const OPENAI_PRICING_SOURCE_URL = "https://developers.openai.com/api/docs/pricing";

const OPENAI_STANDARD_NOTE = "OpenAI API Standard pricing.";
const OPENAI_SHORT_CONTEXT_NOTE = `${OPENAI_STANDARD_NOTE} Short-context tier applies at or below 272K input tokens.`;
const OPENAI_LONG_CONTEXT_NOTE = `${OPENAI_STANDARD_NOTE} Long-context tier applies above 272K input tokens.`;

export const OPENAI_STANDARD_SHORT_CONTEXT_PRICING: ModelPricing[] = [
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.5$",
    maxInputTokens: 272_000,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
    effectiveFrom: "2026-05-30",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_SHORT_CONTEXT_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.5$",
    minInputTokens: 272_001,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 45,
    effectiveFrom: "2026-07-01",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_LONG_CONTEXT_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.5-pro$",
    maxInputTokens: 272_000,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 30,
    outputUsdPerMillion: 180,
    effectiveFrom: "2026-05-30",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_SHORT_CONTEXT_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.5-pro$",
    minInputTokens: 272_001,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 60,
    outputUsdPerMillion: 270,
    effectiveFrom: "2026-07-01",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_LONG_CONTEXT_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.4$",
    maxInputTokens: 272_000,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
    effectiveFrom: "2026-05-30",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_SHORT_CONTEXT_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.4$",
    minInputTokens: 272_001,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 22.5,
    effectiveFrom: "2026-07-01",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_LONG_CONTEXT_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.4-mini$",
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5,
    effectiveFrom: "2026-05-30",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_STANDARD_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.4-nano$",
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.25,
    effectiveFrom: "2026-05-30",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_STANDARD_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.4-pro$",
    maxInputTokens: 272_000,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 30,
    outputUsdPerMillion: 180,
    effectiveFrom: "2026-05-30",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_SHORT_CONTEXT_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.4-pro$",
    minInputTokens: 272_001,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 60,
    outputUsdPerMillion: 270,
    effectiveFrom: "2026-07-01",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_LONG_CONTEXT_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^chat-latest$",
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
    effectiveFrom: "2026-05-30",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_STANDARD_NOTE
  },
  {
    provider: "openai",
    modelPattern: "^gpt-5\\.3-codex$",
    pricingVersion: OPENAI_PRICING_VERSION,
    inputUsdPerMillion: 1.75,
    cachedInputUsdPerMillion: 0.175,
    outputUsdPerMillion: 14,
    effectiveFrom: "2026-05-30",
    sourceUrl: OPENAI_PRICING_SOURCE_URL,
    notes: OPENAI_STANDARD_NOTE
  }
];

export function isOpenAiPricedModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized === "chat-latest" ||
    normalized.includes("openai")
  ) && !normalized.includes("claude") && !normalized.includes("anthropic");
}
