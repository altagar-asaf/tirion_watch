import type {
  OwnershipState,
  ProductionRunV1,
  ProductionTotalsV1,
  ProductionUsageEpochV1,
  QueryOccurrenceV1,
  SafeActivityAtomV1
} from "@tirion/agent-contract";
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
    await this.storage.upsertProductionRuns(projected);
    return await this.storage.listProductionRuns();
  }

  async projectCompletedQuery(owner: OwnershipState, queryId: string): Promise<ProductionRunV1[]> {
    await this.requireReady(owner);
    const epoch = await this.storage.productionUsageEpoch();
    const allOccurrences = await this.storage.listQueryOccurrences();
    const family = queryOccurrenceFamily(allOccurrences, queryId);
    if (!family || family.root.startedAt < epoch!.startedAt) {
      return [];
    }
    const expanded = await this.expandQueryFamily(family, allOccurrences);
    const queryIds = expanded.occurrences.map((occurrence) => occurrence.queryId);
    const projected = this.pipeline.project(
      await this.storage.listSafeUsageAtomsForQueryIds(queryIds),
      this.now(),
      expanded.occurrences,
      expanded.activities
    )
      .filter(isCompletedRun)
      .filter((run) => (run.queryId ?? run.correlationId) === family.root.queryId);
    await this.storage.upsertProductionRuns(projected);
    return projected;
  }

  private async expandQueryFamily(family: {
    root: QueryOccurrenceV1;
    occurrences: QueryOccurrenceV1[];
  }, allOccurrences: QueryOccurrenceV1[]): Promise<{
    occurrences: QueryOccurrenceV1[];
    activities: SafeActivityAtomV1[];
  }> {
    const occurrences = new Map(family.occurrences.map((occurrence) => [occurrence.queryId, occurrence]));
    const sessions = new Set(family.occurrences.map((occurrence) => occurrence.sessionId));
    const activities = new Map<string, SafeActivityAtomV1>();
    const queried = new Set<string>();
    const completedAt = family.root.completedAt;
    let changed = true;
    while (changed) {
      changed = false;
      for (const occurrence of allOccurrences) {
        if (
          occurrences.has(occurrence.queryId)
          || occurrence.lifecycleVisibility === "internal"
          || occurrence.provider !== family.root.provider
          || !occurrence.parentSessionId
          || !sessions.has(occurrence.parentSessionId)
          || occurrence.startedAt < family.root.startedAt
          || (completedAt != null && occurrence.startedAt > completedAt)
        ) {
          continue;
        }
        occurrences.set(occurrence.queryId, occurrence);
        sessions.add(occurrence.sessionId);
        changed = true;
      }

      const pendingQueryIds = [...occurrences.keys()].filter((candidate) => !queried.has(candidate));
      if (pendingQueryIds.length === 0) {
        continue;
      }
      pendingQueryIds.forEach((candidate) => queried.add(candidate));
      for (const activity of await this.storage.listSafeActivityAtomsForQueryIds(pendingQueryIds)) {
        activities.set(activity.activityId, activity);
        if (!activity.childSessionId) {
          continue;
        }
        for (const occurrence of allOccurrences) {
          if (
            occurrences.has(occurrence.queryId)
            || occurrence.lifecycleVisibility === "internal"
            || occurrence.provider !== family.root.provider
            || occurrence.sessionId !== activity.childSessionId
            || occurrence.startedAt < family.root.startedAt
            || (completedAt != null && occurrence.startedAt > completedAt)
          ) {
            continue;
          }
          occurrences.set(occurrence.queryId, occurrence);
          sessions.add(occurrence.sessionId);
          changed = true;
        }
      }
    }
    return {
      occurrences: [...occurrences.values()].sort((left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.queryId.localeCompare(right.queryId)),
      activities: [...activities.values()]
    };
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

function queryOccurrenceFamily(
  occurrences: QueryOccurrenceV1[],
  queryId: string
): { root: QueryOccurrenceV1; occurrences: QueryOccurrenceV1[] } | undefined {
  const target = occurrences.find((occurrence) => occurrence.queryId === queryId);
  if (!target || target.lifecycleVisibility === "internal") {
    return undefined;
  }
  let root = target;
  const visited = new Set([root.queryId]);
  while (root.parentSessionId) {
    const parent = occurrences
      .filter((occurrence) =>
        occurrence.provider === root.provider
        && occurrence.sessionId === root.parentSessionId
        && occurrence.startedAt <= root.startedAt
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    if (!parent || visited.has(parent.queryId) || parent.lifecycleVisibility === "internal") {
      if (parent?.lifecycleVisibility === "internal") {
        return undefined;
      }
      break;
    }
    root = parent;
    visited.add(root.queryId);
  }

  const family = new Map<string, QueryOccurrenceV1>([[root.queryId, root]]);
  const sessions = new Set([root.sessionId]);
  const completedAt = root.completedAt ?? target.completedAt;
  let changed = true;
  while (changed) {
    changed = false;
    for (const occurrence of occurrences) {
      if (
        family.has(occurrence.queryId)
        || occurrence.lifecycleVisibility === "internal"
        || occurrence.provider !== root.provider
        || !occurrence.parentSessionId
        || !sessions.has(occurrence.parentSessionId)
        || occurrence.startedAt < root.startedAt
        || (completedAt != null && occurrence.startedAt > completedAt)
      ) {
        continue;
      }
      family.set(occurrence.queryId, occurrence);
      sessions.add(occurrence.sessionId);
      changed = true;
    }
  }
  return {
    root,
    occurrences: [...family.values()].sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.queryId.localeCompare(right.queryId))
  };
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
