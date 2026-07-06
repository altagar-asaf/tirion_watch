import type { ShadowComparisonV1, ShadowRunV1, ShadowTotalsV1 } from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { DefaultShadowUsagePipeline } from "@tirion/engine";

export const SHADOW_REBUILD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export class ShadowUsageService {
  private readonly pipeline = new DefaultShadowUsagePipeline();

  constructor(
    private readonly storage: AgentStorageClient,
    private readonly now: () => Date = () => new Date(),
    private readonly rebuildLookbackMs = SHADOW_REBUILD_LOOKBACK_MS
  ) {}

  async rebuild(): Promise<ShadowRunV1[]> {
    const existingRuns = await this.storage.listShadowRuns();
    const projectionStartedAt = this.projectionStartedAt();
    const projected = existingRuns.length === 0
      ? this.pipeline.project(
          await this.storage.listSafeUsageAtoms(),
          this.now(),
          await this.storage.listQueryOccurrences(),
          await this.storage.listSafeActivityAtoms()
        )
      : this.pipeline.project(
          await this.storage.listSafeUsageAtomsSince(projectionStartedAt),
          this.now(),
          await this.storage.listQueryOccurrences(),
          await this.storage.listSafeActivityAtomsSince(projectionStartedAt)
        );
    const byId = new Map(existingRuns.map((run) => [run.runId, run]));
    for (const run of projected) {
      byId.set(run.runId, run);
    }
    const runs = [...byId.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    await this.storage.replaceShadowRuns(runs);
    return runs;
  }

  async runs(limit?: number): Promise<ShadowRunV1[]> {
    const runs = await this.storage.listShadowRuns();
    return limit == null ? runs : runs.slice(0, Math.max(0, limit));
  }

  async totals(): Promise<ShadowTotalsV1> {
    return this.pipeline.totals(await this.storage.listShadowRuns());
  }

  async export(format: "json" | "csv"): Promise<{ schemaVersion: 1; shadow: true; format: "json" | "csv"; count: number; content: string }> {
    const runs = await this.storage.listShadowRuns();
    return {
      schemaVersion: 1,
      shadow: true,
      format,
      count: runs.length,
      content: format === "json" ? `${JSON.stringify(runs, null, 2)}\n` : toCsv(runs)
    };
  }

  async compare(expected: ShadowComparisonV1["expected"]): Promise<ShadowComparisonV1> {
    return this.pipeline.compare(expected, await this.totals());
  }

  private projectionStartedAt(): string {
    if (!Number.isFinite(this.rebuildLookbackMs) || this.rebuildLookbackMs <= 0) {
      return new Date(0).toISOString();
    }
    return new Date(this.now().getTime() - this.rebuildLookbackMs).toISOString();
  }
}

function toCsv(runs: ShadowRunV1[]): string {
  const header = [
    "runId",
    "queryId",
    "sessionId",
    "promptState",
    "provider",
    "runtime",
    "model",
    "authority",
    "startedAt",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "estimatedNanoUsd",
    "usageValueNanoUsd",
    "costEstimateBasis",
    "costCoverage",
    "evidenceGrade"
  ];
  const rows = runs.map((run) => [
    run.runId,
    run.queryId ?? run.correlationId,
    run.sessionId ?? "",
    run.promptState,
    run.provider,
    run.runtime,
    run.model ?? "",
    run.authority,
    run.startedAt,
    run.inputTokens,
    run.outputTokens,
    run.totalTokens,
    run.estimatedNanoUsd ?? "",
    run.usageValueNanoUsd ?? "",
    run.costEstimateBasis ?? "unavailable",
    run.costCoverage,
    run.evidenceGrade
  ].map(csvCell).join(","));
  return `${header.join(",")}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}
