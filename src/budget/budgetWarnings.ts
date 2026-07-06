import { AgenticQueryRun, BudgetWarning, UsageTotals } from "../types";

export type BudgetThresholds = {
  warnRunTokens: number;
  warnRunCredits: number;
  warnDailyCredits: number;
  warnMonthlyCredits: number;
};

export function warningsForRun(
  run: AgenticQueryRun,
  thresholds: BudgetThresholds,
  dailyTotals?: UsageTotals,
  monthlyTotals?: UsageTotals
): BudgetWarning[] {
  const warnings: BudgetWarning[] = [];

  if ((run.totalTokens ?? 0) >= thresholds.warnRunTokens) {
    warnings.push({
      kind: "runTokens",
      runId: run.id,
      message: `Tirion run used ${run.totalTokens} reported tokens.`
    });
  }

  if ((run.estimatedAiCredits ?? 0) >= thresholds.warnRunCredits) {
    warnings.push({
      kind: "runCredits",
      runId: run.id,
      message: `Tirion run is estimated at ${run.estimatedAiCredits?.toFixed(2)} AI credits.`
    });
  }

  if (dailyTotals && dailyTotals.estimatedAiCredits >= thresholds.warnDailyCredits) {
    warnings.push({
      kind: "dailyCredits",
      message: `Daily Tirion usage is estimated at ${dailyTotals.estimatedAiCredits.toFixed(2)} AI credits.`
    });
  }

  if (monthlyTotals && monthlyTotals.estimatedAiCredits >= thresholds.warnMonthlyCredits) {
    warnings.push({
      kind: "monthlyCredits",
      message: `Monthly Tirion usage is estimated at ${monthlyTotals.estimatedAiCredits.toFixed(2)} AI credits.`
    });
  }

  return warnings;
}
