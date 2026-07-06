import { ModelPricing } from "../types";

export const ANTHROPIC_PRICING_VERSION = "anthropic-pricing-2026-07-01-first-party";
export const ANTHROPIC_PRICING_SOURCE_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_CACHE_DURATION_NOTE = "Anthropic first-party Claude API pricing. Cache creation rates vary by duration and are not priced without an explicit write-duration signal.";

export const ANTHROPIC_STANDARD_PRICING: ModelPricing[] = [
  {
    provider: "anthropic",
    modelPattern: "^claude-fable-5$",
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 50,
    effectiveFrom: "2026-07-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: ANTHROPIC_CACHE_DURATION_NOTE
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-mythos-5$",
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 50,
    effectiveFrom: "2026-07-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: `${ANTHROPIC_CACHE_DURATION_NOTE} Claude Mythos 5 is limited availability in Anthropic's published pricing table.`
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-opus-4(?:\\.8|-8)$",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    effectiveFrom: "2026-06-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: ANTHROPIC_CACHE_DURATION_NOTE
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-opus-4(?:\\.1|-1)$",
    inputUsdPerMillion: 15,
    cachedInputUsdPerMillion: 1.5,
    outputUsdPerMillion: 75,
    effectiveFrom: "2026-07-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: `${ANTHROPIC_CACHE_DURATION_NOTE} Claude Opus 4.1 is deprecated in Anthropic's published pricing table.`
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-opus-4(?:\\.7|-7)$",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    effectiveFrom: "2026-06-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: ANTHROPIC_CACHE_DURATION_NOTE
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-opus-4(?:\\.6|-6)$",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    effectiveFrom: "2026-06-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: ANTHROPIC_CACHE_DURATION_NOTE
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-opus-4(?:\\.5|-5)$",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    effectiveFrom: "2026-06-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: ANTHROPIC_CACHE_DURATION_NOTE
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-sonnet-5$",
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    effectiveFrom: "2026-09-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: `${ANTHROPIC_CACHE_DURATION_NOTE} Standard Claude Sonnet 5 pricing starts September 1, 2026.`
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-sonnet-5$",
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 10,
    effectiveFrom: "2026-07-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: `${ANTHROPIC_CACHE_DURATION_NOTE} Introductory Claude Sonnet 5 pricing is effective through August 31, 2026.`
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-sonnet-4(?:\\.6|-6)$",
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    effectiveFrom: "2026-06-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: ANTHROPIC_CACHE_DURATION_NOTE
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-sonnet-4(?:\\.5|-5)$",
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    effectiveFrom: "2026-06-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: ANTHROPIC_CACHE_DURATION_NOTE
  },
  {
    provider: "anthropic",
    modelPattern: "^claude-haiku-4(?:\\.5|-5)$",
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 5,
    effectiveFrom: "2026-06-01",
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    sourceUrl: ANTHROPIC_PRICING_SOURCE_URL,
    notes: ANTHROPIC_CACHE_DURATION_NOTE
  }
];
