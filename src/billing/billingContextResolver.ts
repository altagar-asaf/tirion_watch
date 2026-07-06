import { ANTHROPIC_PRICING_VERSION, ANTHROPIC_STANDARD_PRICING } from "../pricing/anthropicPricing";
import { COPILOT_PRICING, COPILOT_PRICING_VERSION } from "../pricing/copilotPricing";
import { CURSOR_PRICING, CURSOR_PRICING_VERSION } from "../pricing/cursorPricing";
import { OPENAI_PRICING_VERSION, OPENAI_STANDARD_SHORT_CONTEXT_PRICING } from "../pricing/openaiPricing";
import { BillingContextId, BillingContextResolution, PricingCatalog } from "../types";

export class DefaultBillingContextResolver {
  resolve(): BillingContextResolution {
    return {
      billingContext: "github-copilot",
      primaryBillingUnit: "aiCredits",
      pricingCatalog: pricingCatalogForBillingContext("github-copilot")
    };
  }
}

export function pricingCatalogForBillingContext(billingContext: BillingContextId): PricingCatalog {
  switch (billingContext) {
    case "github-copilot":
      return {
        billingContext,
        primaryBillingUnit: "aiCredits",
        pricingVersions: [COPILOT_PRICING_VERSION],
        pricingTable: COPILOT_PRICING
      };
    case "openai-direct":
      return {
        billingContext,
        primaryBillingUnit: "usd",
        pricingVersions: [OPENAI_PRICING_VERSION],
        pricingTable: OPENAI_STANDARD_SHORT_CONTEXT_PRICING
      };
    case "anthropic-direct":
      return {
        billingContext,
        primaryBillingUnit: "usd",
        pricingVersions: [ANTHROPIC_PRICING_VERSION],
        pricingTable: ANTHROPIC_STANDARD_PRICING
      };
    case "cursor":
      return {
        billingContext,
        primaryBillingUnit: "usd",
        pricingVersions: [CURSOR_PRICING_VERSION],
        pricingTable: CURSOR_PRICING
      };
  }
}
