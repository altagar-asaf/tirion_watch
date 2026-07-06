import { ModelPricing } from "../types";

export const COPILOT_PRICING_VERSION = "copilot-pricing-2026-07-01";
export const COPILOT_PRICING_SOURCE_URL = "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";

const COPILOT_PRICING_EFFECTIVE_FROM = "2026-07-01";
const COPILOT_PRICING_NOTE = "GitHub Copilot per-token pricing verified from GitHub Docs on 2026-07-01. Estimates are converted to GitHub AI credits at 1 AI credit = $0.01 USD.";

type CopilotPricingInput = Omit<ModelPricing, "pricingVersion" | "effectiveFrom" | "sourceUrl" | "notes"> & {
  notes?: string;
};

export const COPILOT_PRICING: ModelPricing[] = [
  copilotPricing({
    provider: "openai",
    modelPattern: "^gpt[- ]5[- ]mini$",
    inputUsdPerMillion: 0.25,
    cachedInputUsdPerMillion: 0.025,
    outputUsdPerMillion: 2
  }),
  copilotPricing({
    provider: "openai",
    modelPattern: "^gpt[- ]5\\.3[- ]codex$",
    inputUsdPerMillion: 1.75,
    cachedInputUsdPerMillion: 0.175,
    outputUsdPerMillion: 14
  }),
  copilotPricing({
    provider: "openai",
    modelPattern: "^gpt[- ]5\\.4$",
    maxInputTokens: 272_000,
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
    notes: "Default tier applies at or below 272K input tokens."
  }),
  copilotPricing({
    provider: "openai",
    modelPattern: "^gpt[- ]5\\.4$",
    minInputTokens: 272_001,
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 22.5,
    notes: "Long-context tier applies above 272K input tokens."
  }),
  copilotPricing({
    provider: "openai",
    modelPattern: "^gpt[- ]5\\.4[- ]mini$",
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5
  }),
  copilotPricing({
    provider: "openai",
    modelPattern: "^gpt[- ]5\\.4[- ]nano$",
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.25
  }),
  copilotPricing({
    provider: "openai",
    modelPattern: "^gpt[- ]5\\.5$",
    maxInputTokens: 272_000,
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
    notes: "Default tier applies at or below 272K input tokens."
  }),
  copilotPricing({
    provider: "openai",
    modelPattern: "^gpt[- ]5\\.5$",
    minInputTokens: 272_001,
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 45,
    notes: "Long-context tier applies above 272K input tokens."
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]haiku[- ]4(?:\\.5|-5)$",
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    cacheCreationUsdPerMillion: 1.25,
    outputUsdPerMillion: 5
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]sonnet[- ]4$",
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    cacheCreationUsdPerMillion: 3.75,
    outputUsdPerMillion: 15
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]sonnet[- ]4(?:\\.5|-5)$",
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    cacheCreationUsdPerMillion: 3.75,
    outputUsdPerMillion: 15
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]sonnet[- ]4(?:\\.6|-6)$",
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.3,
    cacheCreationUsdPerMillion: 3.75,
    outputUsdPerMillion: 15
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]opus[- ]4(?:\\.5|-5)$",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheCreationUsdPerMillion: 6.25,
    outputUsdPerMillion: 25
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]opus[- ]4(?:\\.6|-6)$",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheCreationUsdPerMillion: 6.25,
    outputUsdPerMillion: 25
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]opus[- ]4(?:\\.7|-7)$",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheCreationUsdPerMillion: 6.25,
    outputUsdPerMillion: 25
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]opus[- ]4(?:\\.8|-8)$",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheCreationUsdPerMillion: 6.25,
    outputUsdPerMillion: 25
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]sonnet[- ]5$",
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    cacheCreationUsdPerMillion: 2.5,
    outputUsdPerMillion: 10,
    notes: "Promotional pricing applies through 2026-08-31 according to GitHub Docs."
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]opus[- ]4(?:\\.8|-8)(?:[- ]\\(?fast(?:[- ]mode)?\\)?)$",
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    cacheCreationUsdPerMillion: 12.5,
    outputUsdPerMillion: 50,
    notes: "Preview fast-mode row from GitHub Docs."
  }),
  copilotPricing({
    provider: "anthropic",
    modelPattern: "^claude[- ]fable[- ]5$",
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    cacheCreationUsdPerMillion: 12.5,
    outputUsdPerMillion: 50,
    notes: "GitHub Docs publish this price row while also marking Claude Fable 5 currently unavailable."
  }),
  copilotPricing({
    provider: "google",
    modelPattern: "^gemini[- ]2\\.5[- ]pro$",
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10
  }),
  copilotPricing({
    provider: "google",
    modelPattern: "^gemini[- ]3[- ]flash$",
    inputUsdPerMillion: 0.5,
    cachedInputUsdPerMillion: 0.05,
    outputUsdPerMillion: 3
  }),
  copilotPricing({
    provider: "google",
    modelPattern: "^gemini[- ]3\\.1[- ]pro$",
    maxInputTokens: 200_000,
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 12,
    notes: "Default tier applies at or below 200K input tokens."
  }),
  copilotPricing({
    provider: "google",
    modelPattern: "^gemini[- ]3\\.1[- ]pro$",
    minInputTokens: 200_001,
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 18,
    notes: "Long-context tier applies above 200K input tokens."
  }),
  copilotPricing({
    provider: "google",
    modelPattern: "^gemini[- ]3\\.5[- ]flash$",
    inputUsdPerMillion: 1.5,
    cachedInputUsdPerMillion: 0.15,
    outputUsdPerMillion: 9
  }),
  copilotPricing({
    provider: "github",
    modelPattern: "^raptor[- ]mini$",
    inputUsdPerMillion: 0.25,
    cachedInputUsdPerMillion: 0.025,
    outputUsdPerMillion: 2
  }),
  copilotPricing({
    provider: "microsoft",
    modelPattern: "^mai[- ]code[- ]1[- ]flash$",
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5
  })
];

function copilotPricing(input: CopilotPricingInput): ModelPricing {
  return {
    ...input,
    pricingVersion: COPILOT_PRICING_VERSION,
    effectiveFrom: COPILOT_PRICING_EFFECTIVE_FROM,
    sourceUrl: COPILOT_PRICING_SOURCE_URL,
    notes: input.notes ? `${COPILOT_PRICING_NOTE} ${input.notes}` : COPILOT_PRICING_NOTE
  };
}
