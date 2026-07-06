import { ModelPricing } from "../types";

export const CURSOR_PRICING_VERSION = "cursor-pricing-2026-07-03";
export const CURSOR_PRICING_SOURCE_URL = "https://cursor.com/docs/models-and-pricing";

const CURSOR_MODEL_SOURCE_URL = "https://cursor.com/docs/models/cursor-composer-2-5";
const CURSOR_PRICING_EFFECTIVE_FROM = "2026-07-03";
const CURSOR_PRICING_NOTE =
  "Cursor-published per-million-token pricing. Estimates do not include plan allowances, on-demand settings, routing policies, taxes, discounts, or dashboard rounding.";

type CursorPricingInput = Omit<ModelPricing, "provider" | "pricingVersion" | "effectiveFrom" | "sourceUrl" | "notes"> & {
  notes?: string;
  sourceUrl?: string;
};

export const CURSOR_PRICING: ModelPricing[] = [
  cursorPricing({
    modelPattern: "^(?:cursor[- ./:])?auto$",
    inputUsdPerMillion: 1.25,
    cacheCreationUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 6,
    notes: "Auto draws from Cursor's Auto + Composer pool."
  }),
  cursorPricing({
    modelPattern: "^(?:cursor[- ./:])?composer[- ]1$",
    inputUsdPerMillion: 1.25,
    cacheCreationUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.125,
    outputUsdPerMillion: 10,
    notes: "Composer 1 is hidden in Cursor's current model catalog but remains documented for historical client emissions."
  }),
  cursorPricing({
    modelPattern: "^(?:cursor[- ./:])?composer[- ]1\\.5$",
    inputUsdPerMillion: 3.5,
    cacheCreationUsdPerMillion: 3.5,
    cachedInputUsdPerMillion: 0.35,
    outputUsdPerMillion: 17.5,
    notes: "Composer 1.5 is hidden in Cursor's current model catalog but remains documented for historical client emissions."
  }),
  cursorPricing({
    modelPattern: "^(?:cursor[- ./:])?composer[- ]2$",
    inputUsdPerMillion: 0.5,
    cacheCreationUsdPerMillion: 0.5,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 2.5,
    notes: "Composer 2 standard tier."
  }),
  cursorPricing({
    modelPattern: "^(?:cursor[- ./:])?composer[- ]2[- ]fast$",
    inputUsdPerMillion: 1.5,
    cacheCreationUsdPerMillion: 1.5,
    cachedInputUsdPerMillion: 0.35,
    outputUsdPerMillion: 7.5,
    notes: "Composer 2 fast tier."
  }),
  cursorPricing({
    modelPattern: "^(?:cursor[- ./:])?composer[- ]2\\.5$",
    inputUsdPerMillion: 0.5,
    cacheCreationUsdPerMillion: 0.5,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 2.5,
    sourceUrl: CURSOR_MODEL_SOURCE_URL,
    notes: "Composer 2.5 standard tier."
  }),
  cursorPricing({
    modelPattern: "^(?:cursor[- ./:])?composer[- ]2\\.5[- ]fast$",
    inputUsdPerMillion: 3,
    cacheCreationUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 15,
    sourceUrl: CURSOR_MODEL_SOURCE_URL,
    notes: "Composer 2.5 fast tier. Cursor documents this as the default fast variant for interactive sessions."
  })
];

export function isCursorPricedModel(model: string): boolean {
  const normalized = model.trim().toLowerCase().replaceAll("_", "-");
  return /^(?:cursor[- ./:])?(?:auto|composer[- ](?:1|1\.5|2|2[- ]fast|2\.5|2\.5[- ]fast))$/.test(normalized);
}

function cursorPricing(input: CursorPricingInput): ModelPricing {
  return {
    provider: "cursor",
    ...input,
    pricingVersion: CURSOR_PRICING_VERSION,
    effectiveFrom: CURSOR_PRICING_EFFECTIVE_FROM,
    sourceUrl: input.sourceUrl ?? CURSOR_PRICING_SOURCE_URL,
    notes: input.notes ? `${CURSOR_PRICING_NOTE} ${input.notes}` : CURSOR_PRICING_NOTE
  };
}
