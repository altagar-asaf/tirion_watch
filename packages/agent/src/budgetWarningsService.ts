import { createHash } from "node:crypto";
import type {
  AgentBudgetSnapshotV1,
  AgentBudgetThresholdsV1,
  AgentBudgetWarningV1,
  ProductionRunV1
} from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";

export const DEFAULT_AGENT_BUDGET_THRESHOLDS: AgentBudgetThresholdsV1 = {
  schemaVersion: 1,
  runTokens: 50_000,
  runEstimatedNanoUsd: 100_000_000,
  dailyEstimatedNanoUsd: 1_000_000_000,
  monthlyEstimatedNanoUsd: 10_000_000_000
};

export class AgentBudgetWarningsService {
  constructor(private readonly storage: AgentStorageClient) {}

  async snapshot(): Promise<AgentBudgetSnapshotV1> {
    return {
      schemaVersion: 1,
      thresholds: await this.thresholds(),
      warnings: (await this.storage.listAgentDocuments<AgentBudgetWarningV1>("budget_warning")).map((item) => item.value)
    };
  }

  async configure(thresholds: AgentBudgetThresholdsV1, runs: ProductionRunV1[]): Promise<AgentBudgetSnapshotV1> {
    assertThresholds(thresholds);
    await this.storage.replaceAgentDocuments("budget_config", [{
      key: "thresholds",
      sortAt: new Date(0).toISOString(),
      value: thresholds
    }]);
    return await this.rebuild(runs);
  }

  async rebuild(runs: ProductionRunV1[]): Promise<AgentBudgetSnapshotV1> {
    const thresholds = await this.thresholds();
    const warnings = warningsForRuns(runs, thresholds);
    await this.storage.replaceAgentDocuments("budget_warning", warnings.map((warning) => ({
      key: warning.warningId,
      sortAt: warning.createdAt,
      value: warning
    })));
    return { schemaVersion: 1, thresholds, warnings };
  }

  async clearWarnings(): Promise<void> {
    await this.storage.clearAgentDocuments("budget_warning");
  }

  private async thresholds(): Promise<AgentBudgetThresholdsV1> {
    const configured = (await this.storage.listAgentDocuments<AgentBudgetThresholdsV1>("budget_config"))
      .find((item) => item.key === "thresholds")?.value;
    if (!configured) {
      return DEFAULT_AGENT_BUDGET_THRESHOLDS;
    }
    assertThresholds(configured);
    return configured;
  }
}

export function parseAgentBudgetThresholds(value: unknown): AgentBudgetThresholdsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  const keys = ["schemaVersion", "runTokens", "runEstimatedNanoUsd", "dailyEstimatedNanoUsd", "monthlyEstimatedNanoUsd"];
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new Error("invalid_request");
  }
  const thresholds: AgentBudgetThresholdsV1 = {
    schemaVersion: 1,
    runTokens: Number(record.runTokens),
    runEstimatedNanoUsd: Number(record.runEstimatedNanoUsd),
    dailyEstimatedNanoUsd: Number(record.dailyEstimatedNanoUsd),
    monthlyEstimatedNanoUsd: Number(record.monthlyEstimatedNanoUsd)
  };
  assertThresholds(thresholds);
  return thresholds;
}

function warningsForRuns(runs: ProductionRunV1[], thresholds: AgentBudgetThresholdsV1): AgentBudgetWarningV1[] {
  const warnings: AgentBudgetWarningV1[] = [];
  const daily = new Map<string, { total: number; latest: string }>();
  const monthly = new Map<string, { total: number; latest: string }>();

  for (const run of runs) {
    if (run.totalTokens >= thresholds.runTokens) {
      warnings.push(warning("run_tokens", run.runId, undefined, run.totalTokens, thresholds.runTokens, "tokens", run.startedAt));
    }
    if (run.estimatedNanoUsd != null && run.estimatedNanoUsd >= thresholds.runEstimatedNanoUsd) {
      warnings.push(warning(
        "run_estimated_cost",
        run.runId,
        undefined,
        run.estimatedNanoUsd,
        thresholds.runEstimatedNanoUsd,
        "estimated_nano_usd",
        run.startedAt
      ));
    }
    if (run.estimatedNanoUsd == null) {
      continue;
    }
    const day = periodStart(run.startedAt, "day");
    const month = periodStart(run.startedAt, "month");
    addPeriod(daily, day, run.estimatedNanoUsd, run.startedAt);
    addPeriod(monthly, month, run.estimatedNanoUsd, run.startedAt);
  }

  for (const [period, value] of daily) {
    if (value.total >= thresholds.dailyEstimatedNanoUsd) {
      warnings.push(warning(
        "daily_estimated_cost",
        undefined,
        period,
        value.total,
        thresholds.dailyEstimatedNanoUsd,
        "estimated_nano_usd",
        value.latest
      ));
    }
  }
  for (const [period, value] of monthly) {
    if (value.total >= thresholds.monthlyEstimatedNanoUsd) {
      warnings.push(warning(
        "monthly_estimated_cost",
        undefined,
        period,
        value.total,
        thresholds.monthlyEstimatedNanoUsd,
        "estimated_nano_usd",
        value.latest
      ));
    }
  }
  return warnings.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.warningId.localeCompare(right.warningId));
}

function warning(
  kind: AgentBudgetWarningV1["kind"],
  runId: string | undefined,
  periodStartValue: string | undefined,
  observed: number,
  threshold: number,
  unit: AgentBudgetWarningV1["unit"],
  createdAt: string
): AgentBudgetWarningV1 {
  const identity = `${kind}|${runId ?? periodStartValue ?? ""}`;
  return {
    schemaVersion: 1,
    warningId: `warning_${createHash("sha256").update(identity).digest("hex")}`,
    kind,
    runId,
    periodStart: periodStartValue,
    observed,
    threshold,
    unit,
    createdAt
  };
}

function addPeriod(target: Map<string, { total: number; latest: string }>, period: string, amount: number, at: string): void {
  const current = target.get(period);
  target.set(period, {
    total: (current?.total ?? 0) + amount,
    latest: current && current.latest > at ? current.latest : at
  });
}

function periodStart(value: string, kind: "day" | "month"): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("invalid_request");
  }
  return kind === "day"
    ? `${date.toISOString().slice(0, 10)}T00:00:00.000Z`
    : `${date.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
}

function assertThresholds(thresholds: AgentBudgetThresholdsV1): void {
  if (
    thresholds.schemaVersion !== 1
    || !positiveSafeInteger(thresholds.runTokens)
    || !positiveSafeInteger(thresholds.runEstimatedNanoUsd)
    || !positiveSafeInteger(thresholds.dailyEstimatedNanoUsd)
    || !positiveSafeInteger(thresholds.monthlyEstimatedNanoUsd)
  ) {
    throw new Error("invalid_request");
  }
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
