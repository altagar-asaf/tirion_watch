import { AccountingCoverageReason, PricingCoverageSummary } from "../types";

const NON_DEGRADING_REASONS = new Set<AccountingCoverageReason>([
  "long_context_rate_unpublished"
]);

export function applyPricingCoveragePolicy(coverage: PricingCoverageSummary): PricingCoverageSummary {
  const pricedModels = uniqueStrings(coverage.pricedModels);
  const hadNonDegradingReason = coverage.reasons.some((reason) => NON_DEGRADING_REASONS.has(reason));
  const reasons = uniqueReasons(coverage.reasons.filter((reason) => !NON_DEGRADING_REASONS.has(reason)));
  const policyOnlyPartial = hadNonDegradingReason
    && coverage.state === "partial"
    && reasons.length === 0
    && coverage.missingModelSlices === 0;
  const unpricedModels = policyOnlyPartial
    ? uniqueStrings(coverage.unpricedModels.filter((model) => !pricedModels.includes(model)))
    : uniqueStrings(coverage.unpricedModels);

  return {
    ...coverage,
    state: policyOnlyPartial && unpricedModels.length === 0 ? "priced" : coverage.state,
    reasons,
    pricedModels,
    unpricedModels,
    pricingVersions: uniqueStrings(coverage.pricingVersions),
    pricingEffectiveFrom: uniqueStrings(coverage.pricingEffectiveFrom)
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}

function uniqueReasons(values: AccountingCoverageReason[]): AccountingCoverageReason[] {
  return [...new Set(values)].sort();
}
