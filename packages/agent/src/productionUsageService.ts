import type { OwnershipState, ProductionRunV1, ProductionTotalsV1, ProductionUsageEpochV1 } from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { DefaultProductionUsagePipeline } from "@tirion/engine";

export const PRODUCTION_REBUILD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export class ProductionUsageService {
  private readonly pipeline = new DefaultProductionUsagePipeline();

  constructor(
    private readonly storage: AgentStorageClient,
    private readonly now: () => Date = () => new Date(),
    private readonly rebuildLookbackMs = PRODUCTION_REBUILD_LOOKBACK_MS
  ) {}

  async startCleanEpoch(startedAt: string): Promise<ProductionUsageEpochV1> {
    return await this.storage.beginProductionUsageEpoch(startedAt);
  }

  async requireReady(owner: OwnershipState): Promise<void> {
    if (owner !== "agent_usage_owner" && owner !== "agent_full_owner") {
      throw new Error("unsupported_capability");
    }
    if (!await this.storage.productionUsageEpoch()) {
      throw new Error("storage_unavailable");
    }
  }

  async rebuild(owner: OwnershipState): Promise<ProductionRunV1[]> {
    await this.requireReady(owner);
    const epoch = await this.storage.productionUsageEpoch();
    const existingRuns = await this.storage.listProductionRuns();
    const projectionStartedAt = this.projectionStartedAt(epoch!.startedAt, existingRuns);
    const projected = this.pipeline.project(
      await this.storage.listSafeUsageAtomsSince(projectionStartedAt),
      this.now(),
      await this.storage.listQueryOccurrences(),
      await this.storage.listSafeActivityAtomsSince(projectionStartedAt)
    )
      .filter(isCompletedRun);
    const byId = new Map(existingRuns
      .filter(isCompletedRun)
      .map((run) => [run.runId, run]));
    for (const run of projected) {
      byId.set(run.runId, run);
    }
    const runs = [...byId.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    await this.storage.replaceProductionRuns(runs);
    return runs;
  }

  async runs(owner: OwnershipState, limit?: number): Promise<ProductionRunV1[]> {
    await this.requireReady(owner);
    const runs = await this.storage.listProductionRuns();
    return limit == null ? runs : runs.slice(0, Math.max(0, limit));
  }

  async currentRuns(owner: OwnershipState, limit?: number): Promise<ProductionRunV1[]> {
    await this.requireReady(owner);
    const epoch = await this.storage.productionUsageEpoch();
    const projectionStartedAt = this.projectionStartedAt(epoch!.startedAt, await this.storage.listProductionRuns());
    const runs = this.pipeline.project(
      await this.storage.listSafeUsageAtomsSince(projectionStartedAt),
      this.now(),
      await this.storage.listQueryOccurrences(),
      await this.storage.listSafeActivityAtomsSince(projectionStartedAt)
    )
      .filter((run) => !isCompletedRun(run));
    return limit == null ? runs : runs.slice(0, Math.max(0, limit));
  }

  async totals(owner: OwnershipState): Promise<ProductionTotalsV1> {
    await this.requireReady(owner);
    return this.pipeline.totals(await this.storage.listProductionRuns());
  }

  async applyRetention(owner: OwnershipState, retentionDays: number, now: Date): Promise<ProductionRunV1[]> {
    await this.requireReady(owner);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return await this.storage.listProductionRuns();
    }
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const retained = (await this.storage.listProductionRuns())
      .filter((run) => Date.parse(run.endedAt ?? run.startedAt) >= cutoff);
    await this.storage.replaceProductionRuns(retained);
    return retained;
  }

  async export(owner: OwnershipState, format: "json" | "csv"): Promise<{
    schemaVersion: 1;
    production: true;
    format: "json" | "csv";
    count: number;
    content: string;
  }> {
    const runs = await this.runs(owner);
    return {
      schemaVersion: 1,
      production: true,
      format,
      count: runs.length,
      content: format === "json" ? `${JSON.stringify(runs, null, 2)}\n` : productionCsv(runs)
    };
  }

  async clear(owner: OwnershipState, startedAt: string): Promise<void> {
    await this.requireReady(owner);
    await this.storage.beginProductionUsageEpoch(startedAt);
  }

  private projectionStartedAt(epochStartedAt: string, existingRuns: ProductionRunV1[]): string {
    if (existingRuns.length === 0 || !Number.isFinite(this.rebuildLookbackMs) || this.rebuildLookbackMs <= 0) {
      return epochStartedAt;
    }
    const lookbackStartedAt = new Date(this.now().getTime() - this.rebuildLookbackMs).toISOString();
    return Date.parse(epochStartedAt) > Date.parse(lookbackStartedAt) ? epochStartedAt : lookbackStartedAt;
  }
}

function isCompletedRun(run: ProductionRunV1): boolean {
  return Boolean(run.endedAt && run.endedAt >= run.startedAt);
}

function productionCsv(runs: ProductionRunV1[]): string {
  const header = "runId,queryId,sessionId,promptState,provider,runtime,model,startedAt,inputTokens,outputTokens,totalTokens,estimatedNanoUsd,usageValueNanoUsd,costEstimateBasis,costCoverage\n";
  return header + runs.map((run) => [
    run.runId,
    run.queryId ?? run.correlationId,
    run.sessionId ?? "",
    run.promptState,
    run.provider,
    run.runtime,
    run.model ?? "",
    run.startedAt,
    run.inputTokens,
    run.outputTokens,
    run.totalTokens,
    run.estimatedNanoUsd ?? "",
    run.usageValueNanoUsd ?? "",
    run.costEstimateBasis ?? "unavailable",
    run.costCoverage
  ].map(csvCell).join(",")).join("\n") + (runs.length > 0 ? "\n" : "");
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}
