import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AccountingCoverage,
  AccountingCoverageReason,
  AccountingModelSummary,
  AccountingSourceSelection,
  AccountingToolSummary,
  AccountingTotals,
  aiCreditsFromNanoUsd,
  AgenticChatSessionGroup,
  AgenticQueryGroup,
  AgenticQueryRun,
  AgenticRunRecord,
  AuthoritativeTraceAccounting,
  BillingContextId,
  CostEstimation,
  CostCoverage,
  costCoverageFromPricingCoverage,
  DateRange,
  ExportResult,
  InitialQueryState,
  LegacyAgenticQueryRun,
  ModelUsageSummary,
  NanoUsd,
  nanoUsdFromUsd,
  PersistedAgenticRunRecord,
  PricingCoverageSummary,
  PricingMatchMetadata,
  RunLedger,
  RunQuery,
  SafeSpanAccountingSummary,
  TokenUsageSource,
  TokenBreakdown,
  ToolSummary,
  usdFromNanoUsd,
  UsageTotals
} from "../types";
import { applyPricingCoveragePolicy } from "../pricing/pricingCoveragePolicy";

const UNKNOWN_CHAT_SESSION_ID = "session unavailable";

type StoredRunEntry = {
  raw?: PersistedAgenticRunRecord;
  normalized?: AgenticRunRecord;
  malformed: boolean;
};

type AggregatedRunAccounting = {
  billingContext?: BillingContextId;
  sourceSelection: AccountingSourceSelection;
  modelSummaries: AccountingModelSummary[];
  toolSummaries: AccountingToolSummary[];
  spanSummaries: SafeSpanAccountingSummary[];
  totals: AccountingTotals;
  coverage: AccountingCoverage;
  pricingMatches: PricingMatchMetadata[];
  warnings: string[];
  legacySchema: boolean;
};

type AggregateAccountingSummary = {
  billingContext?: BillingContextId;
  billingContexts: BillingContextId[];
  pricingCoverage: PricingCoverageSummary;
  accountingCoverage: AccountingCoverage;
  pricingVersions: string[];
  pricingEffectiveFrom: string[];
  unpricedSliceCount: number;
  unavailableSliceCount: number;
  legacyRunCount: number;
};

export class JsonlRunLedger implements RunLedger {
  private readonly runsPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    storageDir: string,
    private readonly retentionDays = 180,
    private readonly costEstimation?: CostEstimation
  ) {
    this.runsPath = path.join(storageDir, "runs.jsonl");
  }

  get filePath(): string {
    return this.runsPath;
  }

  async append(run: AgenticRunRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const entries = await this.readStoredEntries();
      const existing = entries.filter((entry): entry is StoredRunEntry & { raw: PersistedAgenticRunRecord; normalized: AgenticRunRecord } => entry.raw != null && entry.normalized != null);
      const duplicate = existing.find((entry) => entry.normalized.id === run.id);

      if (!duplicate && entries.every((entry) => !entry.malformed)) {
        await fs.mkdir(path.dirname(this.runsPath), { recursive: true });
        await fs.appendFile(this.runsPath, `${JSON.stringify(run)}\n`, "utf8");
        return;
      }

      if (duplicate) {
        const merged = mergeRun(duplicate.normalized, run);
        if (JSON.stringify(merged) === JSON.stringify(duplicate.raw)) {
          return;
        }

        await writeRuns(
          this.runsPath,
          existing.map((entry) => entry.normalized.id === run.id ? merged : entry.raw)
        );
        return;
      }

      await writeRuns(this.runsPath, [...existing.map((entry) => entry.raw), run]);
    });
  }

  async list(query: RunQuery = {}): Promise<AgenticRunRecord[]> {
    const runs = await this.readAll();
    const filtered = runs
      .filter((run) => matchesQuery(run, query))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return typeof query.limit === "number" ? filtered.slice(0, query.limit) : filtered;
  }

  async listQueryGroups(query: RunQuery = {}): Promise<AgenticQueryGroup[]> {
    const runs = await this.readAll();
    const groups = groupRuns(
      runs
        .filter((run) => matchesQuery(run, { ...query, limit: undefined }))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return typeof query.limit === "number" ? groups.slice(0, query.limit) : groups;
  }

  async listChatSessionGroups(query: RunQuery = {}): Promise<AgenticChatSessionGroup[]> {
    const runs = await this.readAll();
    const filteredRuns = runs
      .filter((run) => matchesQuery(run, { ...query, limit: undefined }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const sessions = groupChatSessions(groupRuns(filteredRuns))
      .sort((a, b) => sessionSortKey(b).localeCompare(sessionSortKey(a)));

    return typeof query.limit === "number" ? sessions.slice(0, query.limit) : sessions;
  }

  async totals(range: DateRange): Promise<UsageTotals> {
    const runs = await this.list({ range });
    const accountings = runs.map(accountingForAggregation);
    const breakdown = sumTokenBreakdowns(accountings.map((accounting) => accounting.totals));
    const aggregateSummary = aggregateRunAccountings(accountings);
    const estimatedNanoUsd = sumOptionalNanoUsd(accountings.map((accounting) => normalizedEstimatedNanoUsd(accounting.totals))) ?? 0;

    return {
      runCount: runs.length,
      inputTokens: breakdown.inputTokens ?? 0,
      outputTokens: breakdown.outputTokens ?? 0,
      reasoningOutputTokens: breakdown.reasoningOutputTokens ?? 0,
      cachedTokens: breakdown.cachedTokens ?? 0,
      totalTokens: breakdown.totalTokens ?? 0,
      tokenSources: uniqueTokenSources(accountings.map((accounting) => accounting.sourceSelection.selectedTokenUsageSource)),
      estimatedNanoUsd,
      estimatedUsd: usdFromNanoUsd(estimatedNanoUsd) ?? 0,
      estimatedAiCredits: aiCreditsFromNanoUsd(estimatedNanoUsd) ?? 0,
      billingContext: aggregateSummary.billingContext,
      billingContexts: aggregateSummary.billingContexts,
      pricingCoverage: aggregateSummary.pricingCoverage,
      costCoverage: costCoverageFromPricingCoverage(aggregateSummary.pricingCoverage),
      accountingCoverage: aggregateSummary.accountingCoverage,
      pricingVersions: aggregateSummary.pricingVersions,
      pricingEffectiveFrom: aggregateSummary.pricingEffectiveFrom,
      unpricedSliceCount: aggregateSummary.unpricedSliceCount,
      unavailableSliceCount: aggregateSummary.unavailableSliceCount,
      legacyRunCount: aggregateSummary.legacyRunCount
    };
  }

  async export(format: "json" | "csv", query: RunQuery = {}): Promise<ExportResult> {
    const groups = await this.listQueryGroups(query);
    return {
      format,
      content: format === "json" ? `${JSON.stringify(groups, null, 2)}\n` : toCsv(groups),
      count: groups.length
    };
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(() => writeRuns(this.runsPath, []));
  }

  async applyRetention(): Promise<number> {
    return this.enqueueWrite(async () => {
      if (!Number.isFinite(this.retentionDays) || this.retentionDays <= 0) {
        return 0;
      }

      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const entries = await this.readStoredEntries();
      const validEntries = entries.filter((entry): entry is StoredRunEntry & { raw: PersistedAgenticRunRecord; normalized: AgenticRunRecord } => entry.raw != null && entry.normalized != null);
      const retained = validEntries.filter((entry) => new Date(entry.normalized.startedAt).getTime() >= cutoff);
      const removed = validEntries.length - retained.length;

      if (removed > 0) {
        await writeRuns(this.runsPath, retained.map((entry) => entry.raw));
      }

      return removed;
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async readAll(): Promise<AgenticRunRecord[]> {
    const entries = await this.readStoredEntries();
    return entries.flatMap((entry) => entry.normalized ? [entry.normalized] : []);
  }

  private async readStoredEntries(): Promise<StoredRunEntry[]> {
    let content = "";
    try {
      content = await fs.readFile(this.runsPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    return content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as PersistedAgenticRunRecord;
          const normalized = normalizeStoredRun(parsed, this.costEstimation);
          return normalized
            ? { raw: parsed, normalized, malformed: false }
            : { malformed: true };
        } catch {
          return { malformed: true };
        }
      });
  }
}

function mergeRun(existing: AgenticRunRecord, incoming: AgenticRunRecord): AgenticRunRecord {
  const preferred = runScore(incoming) >= runScore(existing) ? incoming : existing;
  const fallback = preferred === incoming ? existing : incoming;
  const initialQueryState = preferredInitialQueryState(preferred.initialQueryState, fallback.initialQueryState);
  const accounting = mergeStoredAccounting(preferred, fallback);
  const accountingModelUsages = accounting ? accounting.modelSummaries.map(modelUsageFromAccountingSummary) : undefined;
  const estimatedNanoUsd = accounting
    ? pickNumber(normalizedEstimatedNanoUsd(accounting.totals), pickNumber(normalizedEstimatedNanoUsd(preferred), normalizedEstimatedNanoUsd(fallback)))
    : pickNumber(normalizedEstimatedNanoUsd(preferred), normalizedEstimatedNanoUsd(fallback));
  const pricingCoverage = accounting?.totals.pricingCoverage
    ? normalizePricingCoverage(accounting.totals.pricingCoverage, {
        estimatedNanoUsd: normalizedEstimatedNanoUsd(accounting.totals),
        models: uniqueDefined(accounting.modelSummaries.map((summary) => summary.model)),
        modelUsages: accountingModelUsages
      })
    : aggregatePricingCoverage([
        normalizePricingCoverage(preferred.pricingCoverage, preferred),
        normalizePricingCoverage(fallback.pricingCoverage, fallback)
      ]);

  const mergedBase = {
    ...fallback,
    ...preferred,
    billingContext: preferred.billingContext ?? fallback.billingContext ?? firstBillingContext(accounting?.pricingMatches.map((match) => match.billingContext) ?? []),
    initialQueryText: preferredInitialQueryText(preferred, fallback),
    initialQueryState,
    queryId: pickString(preferred.queryId, fallback.queryId) ?? preferred.traceId,
    queryStartedAt: pickString(preferred.queryStartedAt, fallback.queryStartedAt) ?? preferred.startedAt,
    chatSessionId: pickString(preferred.chatSessionId, fallback.chatSessionId),
    copilotSessionId: pickString(preferred.copilotSessionId, fallback.copilotSessionId),
    traceChatSessionId: pickString(preferred.traceChatSessionId, fallback.traceChatSessionId),
    traceRole: pickTraceRole(preferred.traceRole, fallback.traceRole),
    tokenUsageSource: accounting ? normalizeTokenUsageSource(accounting.sourceSelection.selectedTokenUsageSource) : pickTokenUsageSource(preferred.tokenUsageSource, fallback.tokenUsageSource),
    startedAt: pickString(preferred.startedAt, fallback.startedAt) ?? fallback.startedAt,
    endedAt: pickString(preferred.endedAt, fallback.endedAt),
    sessionId: pickString(preferred.sessionId, fallback.sessionId),
    serviceName: pickString(preferred.serviceName, fallback.serviceName),
    mode: preferred.mode ?? fallback.mode,
    status: preferred.status ?? fallback.status,
    models: accounting ? modelsFromStoredAccounting(accounting) : preferred.models.length >= fallback.models.length ? preferred.models : fallback.models,
    modelUsages: accountingModelUsages ?? (preferred.modelUsages.length >= fallback.modelUsages.length ? preferred.modelUsages : fallback.modelUsages),
    tools: accounting ? accounting.toolSummaries.map(toolSummaryToTool) : preferred.tools.length >= fallback.tools.length ? preferred.tools : fallback.tools,
    warnings: uniqueDefined([...fallback.warnings, ...preferred.warnings, ...(accounting?.warnings ?? []), ...(accounting?.totals.warnings ?? [])]),
    inputTokens: pickNumber(accounting?.totals.inputTokens, pickNumber(preferred.inputTokens, fallback.inputTokens)),
    outputTokens: pickNumber(accounting?.totals.outputTokens, pickNumber(preferred.outputTokens, fallback.outputTokens)),
    cacheReadInputTokens: pickNumber(accounting?.totals.cacheReadInputTokens, pickNumber(preferred.cacheReadInputTokens, fallback.cacheReadInputTokens)),
    cacheCreationInputTokens: pickNumber(accounting?.totals.cacheCreationInputTokens, pickNumber(preferred.cacheCreationInputTokens, fallback.cacheCreationInputTokens)),
    cachedTokens: pickNumber(accounting?.totals.cachedTokens, pickNumber(preferred.cachedTokens, fallback.cachedTokens)),
    reasoningOutputTokens: pickNumber(accounting?.totals.reasoningOutputTokens, pickNumber(preferred.reasoningOutputTokens, fallback.reasoningOutputTokens)),
    totalTokens: pickNumber(accounting?.totals.totalTokens, pickNumber(preferred.totalTokens, fallback.totalTokens)),
    estimatedNanoUsd,
    estimatedUsd: usdFromNanoUsd(estimatedNanoUsd) ?? pickNumber(preferred.estimatedUsd, fallback.estimatedUsd),
    estimatedAiCredits: aiCreditsFromNanoUsd(estimatedNanoUsd) ?? pickNumber(preferred.estimatedAiCredits, fallback.estimatedAiCredits),
    pricingVersion: firstDefined(pricingCoverage.pricingVersions) ?? pickString(preferred.pricingVersion, fallback.pricingVersion),
    pricingCoverage,
    costCoverage: costCoverageFromPricingCoverage(pricingCoverage),
    llmCallCount: Math.max(preferred.llmCallCount, fallback.llmCallCount),
    toolCallCount: accounting ? accounting.toolSummaries.reduce((sum, summary) => sum + summary.count, 0) : Math.max(preferred.toolCallCount, fallback.toolCallCount),
    durationMs: pickNumber(preferred.durationMs, fallback.durationMs)
  };

  return accounting
    ? {
        ...mergedBase,
        schemaVersion: 3,
        accounting
      }
    : {
        ...mergedBase,
        schemaVersion: 2
      };
}

function runScore(run: AgenticRunRecord): number {
  const accounting = accountingForAggregation(run);
  return [
    run.schemaVersion === 3 ? 100 : 0,
    accountingQualityScore(accounting) * 20,
    initialQueryStateRank(run.initialQueryState),
    tokenUsageSourceRank(accounting.sourceSelection.selectedTokenUsageSource) * 2,
    costCoverageRank(accounting.coverage.state) * 6,
    accounting.modelSummaries.length * 6,
    accounting.toolSummaries.length * 4,
    accounting.spanSummaries.length,
    run.llmCallCount,
    run.toolCallCount,
    accounting.totals.totalTokens != null ? 5 : 0,
    run.endedAt ? 1 : 0
  ].reduce((sum, value) => sum + value, 0);
}

function pickString(preferred?: string, fallback?: string): string | undefined {
  return preferred && preferred.trim() !== "" ? preferred : fallback && fallback.trim() !== "" ? fallback : undefined;
}

function pickNumber(preferred?: number, fallback?: number): number | undefined {
  return preferred != null ? preferred : fallback;
}

async function writeRuns(runsPath: string, runs: PersistedAgenticRunRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(runsPath), { recursive: true });
  if (runs.length === 0) {
    await fs.writeFile(runsPath, "", "utf8");
    return;
  }
  await fs.writeFile(runsPath, `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`, "utf8");
}

function matchesQuery(run: AgenticRunRecord, query: RunQuery): boolean {
  if (query.queryId && run.queryId !== query.queryId) {
    return false;
  }

  if (query.status && run.status !== query.status) {
    return false;
  }

  if (query.model && !run.models.some((model) => model.toLowerCase().includes(query.model!.toLowerCase()))) {
    return false;
  }

  if (query.range && (run.startedAt < query.range.from || run.startedAt > query.range.to)) {
    return false;
  }

  return true;
}

function emptyTotals(): UsageTotals {
  return {
    runCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    tokenSources: [],
    estimatedNanoUsd: 0,
    estimatedUsd: 0,
    estimatedAiCredits: 0,
    billingContexts: [],
    pricingCoverage: emptyPricingCoverage(),
    costCoverage: "complete"
  };
}

function normalizeStoredRun(raw: unknown, costEstimation?: CostEstimation): AgenticRunRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (raw.schemaVersion === 3) {
    const run = raw as AgenticRunRecord;
    const modelUsages = (Array.isArray(run.modelUsages) ? run.modelUsages : []).map(normalizeStoredModelUsage);
    const estimatedNanoUsd = normalizedEstimatedNanoUsd(run);
    const repriceMissingSchemaV3Pricing = shouldRepriceMissingSchemaV3Pricing(run, run.accounting);
    const accounting = normalizeStoredAccounting(run.accounting, { ...run, estimatedNanoUsd, modelUsages }, run.startedAt, repriceMissingSchemaV3Pricing ? costEstimation : undefined);
    const authoritativeModelUsages = accountingModelUsages(accounting);
    const authoritativeTools = accountingTools(accounting);
    const authoritativeModels = modelsFromStoredAccounting(accounting);
    const authoritativeTokenUsageSource = normalizeTokenUsageSource(accounting.sourceSelection.selectedTokenUsageSource ?? run.tokenUsageSource);
    const authoritativeEstimatedNanoUsd = normalizedEstimatedNanoUsd(accounting.totals) ?? estimatedNanoUsd;
    const billingContext = run.billingContext ?? firstBillingContext(accounting.pricingMatches.map((match) => match.billingContext));
    const pricingCoverage = normalizePricingCoverage(accounting.totals.pricingCoverage ?? run.pricingCoverage, {
      ...run,
      tokenUsageSource: authoritativeTokenUsageSource,
      models: authoritativeModels.length > 0 ? authoritativeModels : run.models,
      estimatedNanoUsd: authoritativeEstimatedNanoUsd,
      modelUsages: authoritativeModelUsages.length > 0 ? authoritativeModelUsages : modelUsages
    });

    return {
      ...run,
      schemaVersion: 3,
      billingContext,
      queryId: run.queryId || run.traceId,
      queryStartedAt: run.queryStartedAt || run.startedAt,
      traceRole: normalizeTraceRole(run.traceRole),
      initialQueryState: normalizeInitialQueryState(run.initialQueryState, run.initialQueryText),
      tokenUsageSource: authoritativeTokenUsageSource,
      models: authoritativeModels.length > 0 ? authoritativeModels : run.models,
      inputTokens: pickNumber(accounting.totals.inputTokens, run.inputTokens),
      outputTokens: pickNumber(accounting.totals.outputTokens, run.outputTokens),
      cacheReadInputTokens: pickNumber(accounting.totals.cacheReadInputTokens, run.cacheReadInputTokens),
      cacheCreationInputTokens: pickNumber(accounting.totals.cacheCreationInputTokens, run.cacheCreationInputTokens),
      cachedTokens: pickNumber(accounting.totals.cachedTokens, run.cachedTokens),
      reasoningOutputTokens: pickNumber(accounting.totals.reasoningOutputTokens, run.reasoningOutputTokens),
      totalTokens: pickNumber(accounting.totals.totalTokens, run.totalTokens),
      estimatedNanoUsd: authoritativeEstimatedNanoUsd,
      estimatedUsd: usdFromNanoUsd(authoritativeEstimatedNanoUsd) ?? run.estimatedUsd,
      estimatedAiCredits: aiCreditsFromNanoUsd(authoritativeEstimatedNanoUsd) ?? run.estimatedAiCredits,
      pricingVersion: firstDefined(pricingCoverage.pricingVersions) ?? firstDefined(accounting.pricingMatches.map((match) => match.pricingVersion)) ?? run.pricingVersion,
      accounting,
      pricingCoverage,
      costCoverage: costCoverageFromPricingCoverage(pricingCoverage),
      modelUsages: authoritativeModelUsages.length > 0 ? authoritativeModelUsages : modelUsages,
      toolCallCount: authoritativeTools.length > 0 ? authoritativeTools.reduce((sum, tool) => sum + tool.count, 0) : run.toolCallCount,
      tools: authoritativeTools.length > 0 ? authoritativeTools : Array.isArray(run.tools) ? run.tools : [],
      warnings: uniqueDefined([...(Array.isArray(run.warnings) ? run.warnings : []), ...accounting.warnings])
    };
  }

  if (raw.schemaVersion === 2) {
    const run = raw as AgenticRunRecord;
    const modelUsages = maybeRepriceStoredModelUsages(
      (Array.isArray(run.modelUsages) ? run.modelUsages : []).map(normalizeStoredModelUsage),
      run.startedAt,
      costEstimation
    );
    const repriced = maybeRepriceStoredRunPricing(run, modelUsages, run.startedAt, costEstimation);
    return {
      ...run,
      billingContext: run.billingContext,
      queryId: run.queryId || run.traceId,
      queryStartedAt: run.queryStartedAt || run.startedAt,
      traceRole: normalizeTraceRole(run.traceRole),
      initialQueryState: normalizeInitialQueryState(run.initialQueryState, run.initialQueryText),
      tokenUsageSource: normalizeTokenUsageSource(run.tokenUsageSource),
      estimatedNanoUsd: repriced.estimatedNanoUsd,
      estimatedUsd: usdFromNanoUsd(repriced.estimatedNanoUsd) ?? run.estimatedUsd,
      estimatedAiCredits: aiCreditsFromNanoUsd(repriced.estimatedNanoUsd) ?? run.estimatedAiCredits,
      pricingVersion: firstDefined(repriced.pricingCoverage.pricingVersions) ?? firstDefined(modelUsages.map((usage) => usage.pricingVersion)) ?? run.pricingVersion,
      pricingCoverage: repriced.pricingCoverage,
      costCoverage: costCoverageFromPricingCoverage(repriced.pricingCoverage),
      modelUsages,
      tools: Array.isArray(run.tools) ? run.tools : [],
      warnings: uniqueDefined([...(Array.isArray(run.warnings) ? run.warnings : []), legacySchemaWarning(2)])
    };
  }

  if (raw.schemaVersion !== 1) {
    return null;
  }

  const legacy = raw as LegacyAgenticQueryRun;
  const estimatedNanoUsd = normalizedEstimatedNanoUsd(legacy);
  const pricingCoverage = normalizePricingCoverage(undefined, {
    ...legacy,
    estimatedNanoUsd,
    tokenUsageSource: "legacy",
    modelUsages: legacyModelUsages(legacy)
  });
  return {
    ...legacy,
    schemaVersion: 2,
    queryId: legacy.traceId,
    queryStartedAt: legacy.startedAt,
    initialQueryState: "unavailable",
    tokenUsageSource: "legacy",
    estimatedNanoUsd,
    estimatedUsd: usdFromNanoUsd(estimatedNanoUsd) ?? legacy.estimatedUsd,
    estimatedAiCredits: aiCreditsFromNanoUsd(estimatedNanoUsd) ?? legacy.estimatedAiCredits,
    pricingCoverage,
    costCoverage: costCoverageFromPricingCoverage(pricingCoverage),
    modelUsages: legacyModelUsages(legacy),
    warnings: uniqueDefined([...(Array.isArray(legacy.warnings) ? legacy.warnings : []), legacySchemaWarning(1)])
  };
}

function shouldRepriceMissingSchemaV3Pricing(run: AgenticRunRecord, accounting?: AuthoritativeTraceAccounting): boolean {
  if (accounting?.accountingSchemaVersion === 1) {
    const accountingEstimate = normalizedEstimatedNanoUsd(accounting.totals);
    const accountingPricingState = accounting.totals.pricingCoverage?.state;
    if (accountingEstimate != null && accountingPricingState && accountingPricingState !== "unpriced") {
      return false;
    }
    return accountingEstimate == null || accountingPricingState === "unpriced";
  }

  const runEstimate = normalizedEstimatedNanoUsd(run);
  return runEstimate == null || run.pricingCoverage?.state === "unpriced";
}

function normalizeStoredAccounting(
  accounting: AuthoritativeTraceAccounting | undefined,
  run: Pick<AgenticRunRecord, "tokenUsageSource" | "models" | "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cachedTokens" | "reasoningOutputTokens" | "totalTokens" | "estimatedNanoUsd" | "estimatedUsd" | "modelUsages" | "pricingCoverage" | "costCoverage" | "warnings">,
  startedAt: string,
  costEstimation?: CostEstimation
): AuthoritativeTraceAccounting {
  const estimatedNanoUsd = normalizedEstimatedNanoUsd(run);
  const pricingCoverage = normalizePricingCoverage(accounting?.totals.pricingCoverage ?? run.pricingCoverage, {
    ...run,
    estimatedNanoUsd,
    modelUsages: run.modelUsages
  });

  if (!accounting || accounting.accountingSchemaVersion !== 1) {
    const warnings = uniqueDefined([...(Array.isArray(run.warnings) ? run.warnings : []), "Schema v3 row was missing the authoritative accounting payload; reconstructed from stored run totals."]);
    const reconstructedAccounting: AuthoritativeTraceAccounting = {
      accountingSchemaVersion: 1,
      sourceSelection: {
        selectedTokenUsageSource: normalizeTokenUsageSource(run.tokenUsageSource),
        corroboratingSources: [],
        dedupedRecordCount: 0,
        discardedOverlapReasons: []
      },
      attributedUsageUnits: [],
      modelSummaries: [],
      toolSummaries: [],
      spanSummaries: [],
      totals: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cacheReadInputTokens: run.cacheReadInputTokens,
        cacheCreationInputTokens: run.cacheCreationInputTokens,
        cachedTokens: run.cachedTokens,
        reasoningOutputTokens: run.reasoningOutputTokens,
        totalTokens: run.totalTokens,
        estimatedNanoUsd,
        pricingCoverage,
        coverage: { state: normalizeCostCoverage(run.costCoverage, run), reasons: [] },
        warnings
      },
      pricingMatches: [],
      invariants: [],
      coverage: { state: normalizeCostCoverage(run.costCoverage, run), reasons: [] },
      warnings
    };

    return costEstimation ? repriceStoredAccounting(reconstructedAccounting, run, startedAt, costEstimation) : reconstructedAccounting;
  }

  const normalizedAccounting: AuthoritativeTraceAccounting = {
    ...accounting,
    attributedUsageUnits: Array.isArray(accounting.attributedUsageUnits) ? accounting.attributedUsageUnits : [],
    modelSummaries: Array.isArray(accounting.modelSummaries) ? accounting.modelSummaries : [],
    toolSummaries: Array.isArray(accounting.toolSummaries) ? accounting.toolSummaries : [],
    spanSummaries: Array.isArray(accounting.spanSummaries) ? accounting.spanSummaries : [],
    pricingMatches: Array.isArray(accounting.pricingMatches) ? accounting.pricingMatches : [],
    invariants: Array.isArray(accounting.invariants) ? accounting.invariants : [],
    totals: {
      inputTokens: pickNumber(accounting.totals.inputTokens, run.inputTokens),
      outputTokens: pickNumber(accounting.totals.outputTokens, run.outputTokens),
      cacheReadInputTokens: pickNumber(accounting.totals.cacheReadInputTokens, run.cacheReadInputTokens),
      cacheCreationInputTokens: pickNumber(accounting.totals.cacheCreationInputTokens, run.cacheCreationInputTokens),
      cachedTokens: pickNumber(accounting.totals.cachedTokens, run.cachedTokens),
      reasoningOutputTokens: pickNumber(accounting.totals.reasoningOutputTokens, run.reasoningOutputTokens),
      totalTokens: pickNumber(accounting.totals.totalTokens, run.totalTokens),
      estimatedNanoUsd: normalizedEstimatedNanoUsd(accounting.totals) ?? estimatedNanoUsd,
      pricingCoverage,
      coverage: accounting.totals.coverage,
      warnings: uniqueDefined([...(Array.isArray(accounting.totals.warnings) ? accounting.totals.warnings : []), ...(Array.isArray(accounting.warnings) ? accounting.warnings : [])])
    },
    coverage: accounting.coverage,
    warnings: uniqueDefined(Array.isArray(accounting.warnings) ? accounting.warnings : [])
  };

  return costEstimation ? repriceStoredAccounting(normalizedAccounting, run, startedAt, costEstimation) : normalizedAccounting;
}

function maybeRepriceStoredModelUsages(
  modelUsages: ModelUsageSummary[],
  startedAt: string,
  costEstimation?: CostEstimation
): ModelUsageSummary[] {
  if (!costEstimation) {
    return modelUsages;
  }

  return modelUsages.map((usage) => {
    if (normalizedEstimatedNanoUsd(usage) != null && usage.pricingCoverage?.state !== "unpriced") {
      return usage;
    }

    const estimate = costEstimation.estimateModelUsage({ usage, startedAt });
    return {
      ...usage,
      estimatedNanoUsd: estimate.estimatedNanoUsd,
      estimatedUsd: estimate.estimatedUsd,
      pricingVersion: estimate.pricingVersion || undefined,
      matchedModel: estimate.matchedModel || undefined,
      pricingCoverage: estimate.pricingCoverage,
      notes: Array.isArray(usage.notes) ? usage.notes : []
    };
  });
}

function maybeRepriceStoredRunPricing(
  run: Pick<AgenticRunRecord, "models" | "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cachedTokens" | "reasoningOutputTokens" | "totalTokens" | "estimatedNanoUsd" | "estimatedUsd" | "pricingCoverage">,
  modelUsages: ModelUsageSummary[],
  startedAt: string,
  costEstimation?: CostEstimation
): { estimatedNanoUsd?: NanoUsd; pricingCoverage: PricingCoverageSummary } {
  const storedEstimatedNanoUsd = normalizedEstimatedNanoUsd(run);
  if (storedEstimatedNanoUsd != null && run.pricingCoverage?.state !== "unpriced") {
    return {
      estimatedNanoUsd: storedEstimatedNanoUsd,
      pricingCoverage: normalizePricingCoverage(run.pricingCoverage, { ...run, estimatedNanoUsd: storedEstimatedNanoUsd, modelUsages })
    };
  }

  if (costEstimation) {
    if (modelUsages.length > 0) {
      return {
        estimatedNanoUsd: sumOptionalNanoUsd(modelUsages.map((usage) => normalizedEstimatedNanoUsd(usage))),
        pricingCoverage: aggregatePricingCoverage(modelUsages.map((usage) => normalizePricingCoverage(usage.pricingCoverage, {
          ...usage,
          estimatedNanoUsd: normalizedEstimatedNanoUsd(usage),
          modelUsages: [usage]
        })))
      };
    }

    const estimate = costEstimation.estimate({
      models: uniqueDefined(run.models),
      tokens: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cacheReadInputTokens: run.cacheReadInputTokens,
        cacheCreationInputTokens: run.cacheCreationInputTokens,
        cachedTokens: run.cachedTokens,
        reasoningOutputTokens: run.reasoningOutputTokens,
        totalTokens: run.totalTokens
      },
      startedAt
    });

    if (estimate) {
      return {
        estimatedNanoUsd: estimate.estimatedNanoUsd,
        pricingCoverage: estimate.pricingCoverage
      };
    }
  }

  const estimatedNanoUsd = normalizedEstimatedNanoUsd(run);
  return {
    estimatedNanoUsd,
    pricingCoverage: normalizePricingCoverage(run.pricingCoverage, { ...run, estimatedNanoUsd, modelUsages })
  };
}

function repriceStoredAccounting(
  accounting: AuthoritativeTraceAccounting,
  run: Pick<AgenticRunRecord, "models" | "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cachedTokens" | "reasoningOutputTokens" | "totalTokens" | "estimatedNanoUsd" | "estimatedUsd" | "pricingCoverage">,
  startedAt: string,
  costEstimation: CostEstimation
): AuthoritativeTraceAccounting {
  const attributedUsageUnits = accounting.attributedUsageUnits.map((unit) => repriceStoredAttributedUsageUnit(unit, startedAt, costEstimation));
  const modelSummaries = accounting.modelSummaries.map((summary) => repriceStoredAccountingModelSummary(summary, startedAt, costEstimation));
  const spanSummaries = accounting.spanSummaries.map((summary) => repriceStoredSpanSummary(summary, startedAt, costEstimation));
  const repricedTotals = maybeRepriceStoredRunPricing(
    {
      models: uniqueDefined([...run.models, ...modelSummaries.map((summary) => summary.model)]),
      inputTokens: pickNumber(accounting.totals.inputTokens, run.inputTokens),
      outputTokens: pickNumber(accounting.totals.outputTokens, run.outputTokens),
      cacheReadInputTokens: pickNumber(accounting.totals.cacheReadInputTokens, run.cacheReadInputTokens),
      cacheCreationInputTokens: pickNumber(accounting.totals.cacheCreationInputTokens, run.cacheCreationInputTokens),
      cachedTokens: pickNumber(accounting.totals.cachedTokens, run.cachedTokens),
      reasoningOutputTokens: pickNumber(accounting.totals.reasoningOutputTokens, run.reasoningOutputTokens),
      totalTokens: pickNumber(accounting.totals.totalTokens, run.totalTokens),
      estimatedNanoUsd: normalizedEstimatedNanoUsd(accounting.totals) ?? normalizedEstimatedNanoUsd(run),
      estimatedUsd: usdFromNanoUsd(normalizedEstimatedNanoUsd(accounting.totals) ?? normalizedEstimatedNanoUsd(run)) ?? run.estimatedUsd,
      pricingCoverage: accounting.totals.pricingCoverage ?? run.pricingCoverage
    },
    modelSummaries.map(modelUsageFromAccountingSummary),
    startedAt,
    costEstimation
  );

  return {
    ...accounting,
    attributedUsageUnits,
    modelSummaries,
    spanSummaries,
    totals: {
      ...accounting.totals,
      estimatedNanoUsd: repricedTotals.estimatedNanoUsd,
      pricingCoverage: repricedTotals.pricingCoverage
    },
    pricingMatches: uniquePricingMatches([
      ...accounting.pricingMatches,
      ...attributedUsageUnits.flatMap((unit) => unit.pricing ? [unit.pricing] : []),
      ...modelSummaries.flatMap((summary) => summary.pricing ? [summary.pricing] : []),
      ...spanSummaries.flatMap((summary) => summary.pricing ? [summary.pricing] : [])
    ])
  };
}

function repriceStoredAttributedUsageUnit(
  unit: AuthoritativeTraceAccounting["attributedUsageUnits"][number],
  startedAt: string,
  costEstimation: CostEstimation
): AuthoritativeTraceAccounting["attributedUsageUnits"][number] {
  if (!unit.model) {
    return unit;
  }

  const estimate = costEstimation.estimateAttributedUnit({ unit, startedAt });
  return {
    ...unit,
    estimatedNanoUsd: estimate.estimatedNanoUsd,
    pricing: estimate.pricingMatch,
    pricingCoverage: estimate.pricingCoverage
  };
}

function repriceStoredAccountingModelSummary(
  summary: AccountingModelSummary,
  startedAt: string,
  costEstimation: CostEstimation
): AccountingModelSummary {
  const estimate = costEstimation.estimateModelUsage({ usage: summary, startedAt });
  return {
    ...summary,
    estimatedNanoUsd: estimate.estimatedNanoUsd,
    pricing: estimate.pricingMatch,
    pricingCoverage: estimate.pricingCoverage
  };
}

function repriceStoredSpanSummary(
  summary: SafeSpanAccountingSummary,
  startedAt: string,
  costEstimation: CostEstimation
): SafeSpanAccountingSummary {
  if (!summary.model) {
    return summary;
  }

  const estimate = costEstimation.estimateAttributedUnit({
    unit: {
      model: summary.model,
      provider: summary.provider,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cacheReadInputTokens: summary.cacheReadInputTokens,
      cacheCreationInputTokens: summary.cacheCreationInputTokens,
      cachedTokens: summary.cachedTokens,
      reasoningOutputTokens: summary.reasoningOutputTokens,
      totalTokens: summary.totalTokens
    },
    startedAt
  });

  return {
    ...summary,
    estimatedNanoUsd: estimate.estimatedNanoUsd,
    pricing: estimate.pricingMatch,
    pricingCoverage: estimate.pricingCoverage
  };
}

function uniquePricingMatches(matches: PricingMatchMetadata[]): PricingMatchMetadata[] {
  const seen = new Set<string>();
  const unique: PricingMatchMetadata[] = [];

  for (const match of matches) {
    const key = JSON.stringify([
      match.billingContext ?? "",
      match.provider ?? "",
      match.model ?? "",
      match.matchedModel ?? "",
      match.pricingVersion,
      match.effectiveFrom ?? "",
      match.sourceUrl ?? "",
      ...(Array.isArray(match.notes) ? match.notes : [])
    ]);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(match);
  }

  return unique;
}

function accountingModelUsages(accounting: AuthoritativeTraceAccounting): ModelUsageSummary[] {
  return accounting.modelSummaries.map(modelUsageFromAccountingSummary);
}

function accountingTools(accounting: AuthoritativeTraceAccounting): ToolSummary[] {
  return accounting.toolSummaries.map(toolSummaryToTool);
}

function modelUsageFromAccountingSummary(summary: AccountingModelSummary): ModelUsageSummary {
  return {
    model: summary.model,
    provider: summary.provider,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadInputTokens: summary.cacheReadInputTokens,
    cacheCreationInputTokens: summary.cacheCreationInputTokens,
    cachedTokens: summary.cachedTokens,
    reasoningOutputTokens: summary.reasoningOutputTokens,
    totalTokens: summary.totalTokens,
    estimatedNanoUsd: summary.estimatedNanoUsd,
    estimatedUsd: usdFromNanoUsd(summary.estimatedNanoUsd),
    pricingVersion: summary.pricing?.pricingVersion,
    matchedModel: summary.pricing?.matchedModel,
    pricingCoverage: summary.pricingCoverage,
    notes: uniqueDefined(summary.warnings)
  };
}

function toolSummaryToTool(summary: AccountingToolSummary): ToolSummary {
  return {
    name: summary.name,
    count: summary.count,
    failures: summary.failures,
    totalDurationMs: summary.totalDurationMs,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadInputTokens: summary.cacheReadInputTokens,
    cacheCreationInputTokens: summary.cacheCreationInputTokens,
    cachedTokens: summary.cachedTokens,
    reasoningOutputTokens: summary.reasoningOutputTokens,
    totalTokens: summary.totalTokens
  };
}

function accountingForAggregation(run: AgenticRunRecord): AggregatedRunAccounting {
  if (run.schemaVersion === 3) {
    return {
      billingContext: run.billingContext ?? firstBillingContext(run.accounting.pricingMatches.map((match) => match.billingContext)),
      ...run.accounting,
      warnings: uniqueDefined([...(Array.isArray(run.warnings) ? run.warnings : []), ...run.accounting.warnings, ...run.accounting.totals.warnings]),
      legacySchema: false
    };
  }

  const pricingCoverage = normalizePricingCoverage(run.pricingCoverage, run);
  const warnings = uniqueDefined(Array.isArray(run.warnings) ? run.warnings : []);
  const coverage: AccountingCoverage = {
    state: normalizeCostCoverage(run.costCoverage, run),
    reasons: uniqueReasons([
      ...pricingCoverage.reasons,
      ...(run.tokenUsageSource === "legacy" ? (["legacy_schema"] as AccountingCoverageReason[]) : [])
    ])
  };

  return {
    billingContext: run.billingContext,
    sourceSelection: {
      selectedTokenUsageSource: normalizeTokenUsageSource(run.tokenUsageSource),
      corroboratingSources: [],
      dedupedRecordCount: 0,
      discardedOverlapReasons: run.tokenUsageSource === "legacy" ? ["legacy_schema"] : []
    },
    modelSummaries: run.modelUsages.map(accountingModelSummaryFromUsage),
    toolSummaries: run.tools.map((tool) => accountingToolSummaryFromTool(tool, coverage)),
    spanSummaries: [],
    totals: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadInputTokens: run.cacheReadInputTokens,
      cacheCreationInputTokens: run.cacheCreationInputTokens,
      cachedTokens: run.cachedTokens,
      reasoningOutputTokens: run.reasoningOutputTokens,
      totalTokens: run.totalTokens,
      estimatedNanoUsd: normalizedEstimatedNanoUsd(run),
      pricingCoverage,
      coverage,
      warnings
    },
    coverage,
    pricingMatches: [],
    warnings,
    legacySchema: true
  };
}

function accountingModelSummaryFromUsage(usage: ModelUsageSummary): AccountingModelSummary {
  const pricingCoverage = normalizePricingCoverage(usage.pricingCoverage, {
    estimatedNanoUsd: normalizedEstimatedNanoUsd(usage),
    estimatedUsd: usage.estimatedUsd,
    model: usage.model,
    modelUsages: [usage]
  });

  return {
    model: usage.model,
    provider: usage.provider,
    attributionIds: [],
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cachedTokens: usage.cachedTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
    estimatedNanoUsd: normalizedEstimatedNanoUsd(usage),
    pricing: usage.pricingVersion
      ? {
          provider: usage.provider,
          model: usage.model,
          matchedModel: usage.matchedModel,
          pricingVersion: usage.pricingVersion,
          notes: []
        }
      : undefined,
    pricingCoverage,
    coverage: {
      state: costCoverageFromPricingCoverage(pricingCoverage),
      reasons: uniqueReasons(pricingCoverage.reasons)
    },
    warnings: uniqueDefined(usage.notes)
  };
}

function accountingToolSummaryFromTool(
  tool: ToolSummary,
  parentCoverage: AccountingCoverage
): AccountingToolSummary {
  const coverage = hasReportedTokens(tool)
    ? parentCoverage
    : {
        state: parentCoverage.state === "complete" ? "partial" : parentCoverage.state,
        reasons: uniqueReasons([...parentCoverage.reasons, "missing_tool_attribution"])
      };

  return {
    name: tool.name,
    count: tool.count,
    failures: tool.failures,
    totalDurationMs: tool.totalDurationMs,
    attributionIds: [],
    inputTokens: tool.inputTokens,
    outputTokens: tool.outputTokens,
    cacheReadInputTokens: tool.cacheReadInputTokens,
    cacheCreationInputTokens: tool.cacheCreationInputTokens,
    cachedTokens: tool.cachedTokens,
    reasoningOutputTokens: tool.reasoningOutputTokens,
    totalTokens: tool.totalTokens,
    coverage,
    warnings: []
  };
}

function aggregateRunAccountings(accountings: AggregatedRunAccounting[]): AggregateAccountingSummary {
  const pricingCoverage = aggregatePricingCoverage(accountings.map(pricingCoverageFromAggregatedAccounting));
  const billingContexts = uniqueBillingContexts(accountings.map((accounting) => accounting.billingContext));
  const accountingCoverage: AccountingCoverage = {
    state: aggregateCostCoverage(accountings.map((accounting) => ({
      costCoverage: accounting.coverage.state,
      estimatedNanoUsd: normalizedEstimatedNanoUsd(accounting.totals),
      estimatedUsd: usdFromNanoUsd(normalizedEstimatedNanoUsd(accounting.totals)),
      pricingCoverage: pricingCoverageFromAggregatedAccounting(accounting)
    }))),
    reasons: uniqueReasons([...accountings.flatMap((accounting) => accounting.coverage.reasons), ...pricingCoverage.reasons])
  };

  return {
    billingContext: billingContexts.length === 1 ? billingContexts[0] : undefined,
    billingContexts,
    pricingCoverage,
    accountingCoverage,
    pricingVersions: uniqueDefined([...pricingCoverage.pricingVersions, ...accountings.flatMap((accounting) => accounting.pricingMatches.map((match) => match.pricingVersion))]),
    pricingEffectiveFrom: uniqueDefined([...pricingCoverage.pricingEffectiveFrom, ...accountings.flatMap((accounting) => accounting.pricingMatches.flatMap((match) => match.effectiveFrom ? [match.effectiveFrom] : []))]),
    unpricedSliceCount: accountings.reduce((sum, accounting) => sum + countUnpricedSlices(accounting), 0),
    unavailableSliceCount: accountings.reduce((sum, accounting) => sum + countUnavailableSlices(accounting), 0),
    legacyRunCount: accountings.filter((accounting) => accounting.legacySchema).length
  };
}

function aggregateGroupAccountings(groups: AgenticQueryGroup[]): AggregateAccountingSummary {
  const pricingCoverage = aggregatePricingCoverage(groups.map((group) => normalizePricingCoverage(group.pricingCoverage, group)));
  const billingContexts = uniqueBillingContexts(groups.flatMap((group) => group.billingContexts ?? (group.billingContext ? [group.billingContext] : [])));
  const accountingCoverage: AccountingCoverage = {
    state: aggregateCostCoverage(groups.map((group) => ({
      costCoverage: group.accountingCoverage?.state ?? normalizeCostCoverage(group.costCoverage, group),
      estimatedNanoUsd: normalizedEstimatedNanoUsd(group),
      estimatedUsd: group.estimatedUsd,
      pricingCoverage: normalizePricingCoverage(group.pricingCoverage, group)
    }))),
    reasons: uniqueReasons([...groups.flatMap((group) => group.accountingCoverage?.reasons ?? []), ...pricingCoverage.reasons])
  };

  return {
    billingContext: billingContexts.length === 1 ? billingContexts[0] : undefined,
    billingContexts,
    pricingCoverage,
    accountingCoverage,
    pricingVersions: uniqueDefined([...pricingCoverage.pricingVersions, ...groups.flatMap((group) => group.pricingVersions ?? [])]),
    pricingEffectiveFrom: uniqueDefined([...pricingCoverage.pricingEffectiveFrom, ...groups.flatMap((group) => group.pricingEffectiveFrom ?? [])]),
    unpricedSliceCount: groups.reduce((sum, group) => sum + (group.unpricedSliceCount ?? 0), 0),
    unavailableSliceCount: groups.reduce((sum, group) => sum + (group.unavailableSliceCount ?? 0), 0),
    legacyRunCount: groups.reduce((sum, group) => sum + (group.legacyRunCount ?? 0), 0)
  };
}

function pricingCoverageFromAggregatedAccounting(accounting: AggregatedRunAccounting): PricingCoverageSummary {
  return normalizePricingCoverage(accounting.totals.pricingCoverage, {
    estimatedNanoUsd: normalizedEstimatedNanoUsd(accounting.totals),
    models: uniqueDefined(accounting.modelSummaries.map((summary) => summary.model)),
    modelUsages: accounting.modelSummaries.map(modelUsageFromAccountingSummary),
    tokenUsageSource: accounting.sourceSelection.selectedTokenUsageSource
  });
}

function modelsFromStoredAccounting(accounting: AuthoritativeTraceAccounting): string[] {
  return uniqueDefined([
    ...accounting.modelSummaries.map((summary) => summary.model),
    ...(accounting.totals.pricingCoverage?.pricedModels ?? []),
    ...(accounting.totals.pricingCoverage?.unpricedModels ?? [])
  ]);
}

function modelsFromAggregatedAccounting(accounting: AggregatedRunAccounting): string[] {
  const pricingCoverage = pricingCoverageFromAggregatedAccounting(accounting);
  return uniqueDefined([
    ...accounting.modelSummaries.map((summary) => summary.model),
    ...pricingCoverage.pricedModels,
    ...pricingCoverage.unpricedModels
  ]);
}

function countUnpricedSlices(accounting: AggregatedRunAccounting): number {
  const unpricedModelSlices = accounting.modelSummaries.reduce((sum, summary) => sum + ((summary.pricingCoverage?.state ?? "unpriced") === "priced" ? 0 : 1), 0);
  return unpricedModelSlices + (accounting.totals.pricingCoverage?.missingModelSlices ?? 0);
}

function countUnavailableSlices(accounting: AggregatedRunAccounting): number {
  const unavailableSpans = accounting.spanSummaries.filter((summary) => summary.coverage.state === "unavailable").length;
  if (unavailableSpans > 0) {
    return unavailableSpans;
  }

  return accounting.coverage.state === "unavailable" ? 1 : 0;
}

function mergeStoredAccounting(
  preferred: AgenticRunRecord,
  fallback: AgenticRunRecord
): AuthoritativeTraceAccounting | undefined {
  const candidates = [preferred, fallback]
    .filter((run): run is AgenticRunRecord & { schemaVersion: 3; accounting: AuthoritativeTraceAccounting } => run.schemaVersion === 3 && run.accounting != null)
    .sort((a, b) => accountingQualityScore(accountingForAggregation(b)) - accountingQualityScore(accountingForAggregation(a)));

  if (candidates.length === 0) {
    return undefined;
  }

  const best = candidates[0].accounting;
  return {
    ...best,
    totals: {
      ...best.totals,
      warnings: uniqueDefined([...best.totals.warnings, ...candidates.flatMap((run) => run.accounting.totals.warnings)])
    },
    warnings: uniqueDefined([...best.warnings, ...candidates.flatMap((run) => run.accounting.warnings)])
  };
}

function accountingQualityScore(accounting: AggregatedRunAccounting): number {
  const pricingCoverage = pricingCoverageFromAggregatedAccounting(accounting);
  return [
    accounting.legacySchema ? 0 : 10,
    costCoverageRank(accounting.coverage.state) * 6,
    pricingCoverageStateRank(pricingCoverage.state) * 5,
    accounting.modelSummaries.length * 2,
    accounting.toolSummaries.length,
    accounting.spanSummaries.length,
    normalizedEstimatedNanoUsd(accounting.totals) != null ? 4 : 0
  ].reduce((sum, value) => sum + value, 0);
}

function legacySchemaWarning(schemaVersion: 1 | 2): string {
  return schemaVersion === 1
    ? "Read from legacy schema v1 run without authoritative accounting; per-span attribution is unavailable."
    : "Read from legacy schema v2 run without authoritative accounting; per-span attribution is unavailable.";
}

function legacyModelUsages(run: LegacyAgenticQueryRun): ModelUsageSummary[] {
  if (run.models.length !== 1 || (run.inputTokens == null && run.outputTokens == null)) {
    return [];
  }

  return [{
    model: run.models[0],
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadInputTokens: run.cacheReadInputTokens,
    cacheCreationInputTokens: run.cacheCreationInputTokens,
    cachedTokens: run.cachedTokens,
    reasoningOutputTokens: run.reasoningOutputTokens,
    totalTokens: run.totalTokens,
    estimatedNanoUsd: normalizedEstimatedNanoUsd(run),
    estimatedUsd: run.estimatedUsd,
    pricingVersion: run.pricingVersion,
    notes: ["Read from legacy schema v1 run totals."]
  }];
}

function groupRuns(runs: AgenticRunRecord[]): AgenticQueryGroup[] {
  const byQuery = new Map<string, AgenticRunRecord[]>();
  for (const run of runs) {
    byQuery.set(run.queryId, [...(byQuery.get(run.queryId) ?? []), run]);
  }

  return [...byQuery.entries()].map(([queryId, groupRunsForQuery]) => {
    const sortedRuns = [...groupRunsForQuery].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const runAccountings = sortedRuns.map(accountingForAggregation);
    const breakdown = sumTokenBreakdowns(runAccountings.map((accounting) => accounting.totals));
    const aggregateSummary = aggregateRunAccountings(runAccountings);
    const modelUsages = mergeModelUsages(runAccountings.flatMap((accounting) => accounting.modelSummaries.map(modelUsageFromAccountingSummary)));
    const tools = mergeTools(runAccountings.flatMap((accounting) => accounting.toolSummaries.map(toolSummaryToTool)));
    const models = uniqueDefined(runAccountings.flatMap(modelsFromAggregatedAccounting));
    const estimatedNanoUsd = sumOptionalNanoUsd(runAccountings.map((accounting) => normalizedEstimatedNanoUsd(accounting.totals)));
    const estimatedUsd = usdFromNanoUsd(estimatedNanoUsd);
    const hasNonOpenAiModels = models.some(isLikelyNonOpenAiModel);
    const pricingCoverage = aggregateSummary.pricingCoverage;
    const costCoverage = costCoverageFromPricingCoverage(pricingCoverage);
    const firstRun = sortedRuns[0];
    const endedAt = latestDefined(sortedRuns.map((run) => run.endedAt));
    const initialQueryState = groupInitialQueryState(sortedRuns);

    return {
      queryId,
      chatSessionId: firstDefined(sortedRuns.map((run) => run.chatSessionId)),
      copilotSessionId: firstDefined(sortedRuns.map((run) => run.copilotSessionId)),
      startedAt: firstRun.queryStartedAt,
      endedAt,
      durationMs: groupDurationMs(firstRun.queryStartedAt, endedAt),
      initialQueryText: groupInitialQueryText(sortedRuns),
      initialQueryState,
      runCount: sortedRuns.length,
      models,
      modelUsages,
      toolCallCount: sortedRuns.reduce((sum, run) => sum + run.toolCallCount, 0),
      tools,
      tokenSources: uniqueTokenSources(runAccountings.map((accounting) => accounting.sourceSelection.selectedTokenUsageSource)),
      estimatedNanoUsd,
      estimatedUsd,
      estimatedAiCredits: aiCreditsFromNanoUsd(estimatedNanoUsd),
      billingContext: aggregateSummary.billingContext,
      billingContexts: aggregateSummary.billingContexts,
      pricingVersion: firstDefined(aggregateSummary.pricingVersions),
      pricingCoverage,
      costCoverage,
      accountingCoverage: aggregateSummary.accountingCoverage,
      pricingVersions: aggregateSummary.pricingVersions,
      pricingEffectiveFrom: aggregateSummary.pricingEffectiveFrom,
      unpricedSliceCount: aggregateSummary.unpricedSliceCount,
      unavailableSliceCount: aggregateSummary.unavailableSliceCount,
      legacyRunCount: aggregateSummary.legacyRunCount,
      hasNonOpenAiModels,
      costLabel: costLabel(costCoverage, pricingCoverage),
      runs: [...sortedRuns].reverse(),
      warnings: uniqueDefined([...sortedRuns.flatMap((run) => run.warnings), ...runAccountings.flatMap((accounting) => accounting.warnings)]),
      ...breakdown
    };
  });
}

function groupChatSessions(groups: AgenticQueryGroup[]): AgenticChatSessionGroup[] {
  const byChatSession = new Map<string, AgenticQueryGroup[]>();
  for (const group of groups) {
    const key = pickString(group.chatSessionId) ?? UNKNOWN_CHAT_SESSION_ID;
    byChatSession.set(key, [...(byChatSession.get(key) ?? []), group]);
  }

  return [...byChatSession.entries()].map(([chatSessionId, sessionGroups]) => {
    const sortedGroups = [...sessionGroups].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const oldestGroup = [...sessionGroups].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    const endedAt = latestDefined(sessionGroups.map((group) => group.endedAt));
    const estimatedNanoUsd = sumOptionalNanoUsd(sessionGroups.map((group) => normalizedEstimatedNanoUsd(group)));
    const estimatedUsd = usdFromNanoUsd(estimatedNanoUsd);
    const aggregateSummary = aggregateGroupAccountings(sessionGroups);
    const pricingCoverage = aggregateSummary.pricingCoverage;
    const costCoverage = costCoverageFromPricingCoverage(pricingCoverage);

    return {
      chatSessionId,
      copilotSessionId: firstDefined(sortedGroups.map((group) => group.copilotSessionId)),
      startedAt: oldestGroup.startedAt,
      endedAt,
      durationMs: groupDurationMs(oldestGroup.startedAt, endedAt),
      queryCount: sortedGroups.length,
      runCount: sortedGroups.reduce((sum, group) => sum + group.runCount, 0),
      models: uniqueDefined(sortedGroups.flatMap((group) => group.models)),
      tokenSources: uniqueTokenSources(sortedGroups.flatMap((group) => group.tokenSources)),
      estimatedNanoUsd,
      estimatedUsd,
      estimatedAiCredits: aiCreditsFromNanoUsd(estimatedNanoUsd),
      billingContext: aggregateSummary.billingContext,
      billingContexts: aggregateSummary.billingContexts,
      pricingCoverage,
      costCoverage,
      accountingCoverage: aggregateSummary.accountingCoverage,
      pricingVersions: aggregateSummary.pricingVersions,
      pricingEffectiveFrom: aggregateSummary.pricingEffectiveFrom,
      unpricedSliceCount: aggregateSummary.unpricedSliceCount,
      unavailableSliceCount: aggregateSummary.unavailableSliceCount,
      legacyRunCount: aggregateSummary.legacyRunCount,
      costLabel: sessionCostLabel(costCoverage, sortedGroups),
      queries: sortedGroups,
      warnings: uniqueDefined(sortedGroups.flatMap((group) => group.warnings)),
      ...sumGroupBreakdowns(sortedGroups)
    };
  });
}

function mergeModelUsages(usages: ModelUsageSummary[]): ModelUsageSummary[] {
  const byModel = new Map<string, ModelUsageSummary>();
  for (const usage of usages) {
    const key = modelProviderKey(usage.model, usage.provider);
    const current = byModel.get(key) ?? { model: usage.model, provider: usage.provider, notes: [] };
    mergeBreakdown(current, usage);
    current.estimatedNanoUsd = addNanoUsd(current.estimatedNanoUsd, normalizedEstimatedNanoUsd(usage));
    current.estimatedUsd = usdFromNanoUsd(current.estimatedNanoUsd) ?? add(current.estimatedUsd, usage.estimatedUsd);
    current.pricingVersion = current.pricingVersion ?? usage.pricingVersion;
    current.matchedModel = current.matchedModel ?? usage.matchedModel;
    current.pricingCoverage = aggregatePricingCoverage([
      normalizePricingCoverage(current.pricingCoverage, current),
      normalizePricingCoverage(usage.pricingCoverage, usage)
    ]);
    current.notes = uniqueDefined([...current.notes, ...usage.notes]);
    byModel.set(key, current);
  }
  return [...byModel.values()].sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0) || a.model.localeCompare(b.model) || (a.provider ?? "").localeCompare(b.provider ?? ""));
}

function modelProviderKey(model: string, provider?: string): string {
  return `${provider ?? ""}::${model}`;
}

function mergeTools(tools: ToolSummary[]): ToolSummary[] {
  const byName = new Map<string, ToolSummary>();
  for (const tool of tools) {
    const current = byName.get(tool.name) ?? { name: tool.name, count: 0, failures: 0, totalDurationMs: 0 };
    current.count += tool.count;
    current.failures += tool.failures;
    current.totalDurationMs = add(current.totalDurationMs, tool.totalDurationMs);
    mergeBreakdown(current, tool);
    byName.set(tool.name, current);
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function sumBreakdowns(runs: AgenticRunRecord[]): TokenBreakdown {
  return sumTokenBreakdowns(runs);
}

function sumTokenBreakdowns(breakdowns: TokenBreakdown[]): TokenBreakdown {
  const total: TokenBreakdown = {};
  for (const breakdown of breakdowns) {
    mergeBreakdown(total, breakdown);
  }
  return total;
}

function mergeBreakdown(target: TokenBreakdown, usage: TokenBreakdown): void {
  target.inputTokens = add(target.inputTokens, usage.inputTokens);
  target.outputTokens = add(target.outputTokens, usage.outputTokens);
  target.cacheReadInputTokens = add(target.cacheReadInputTokens, usage.cacheReadInputTokens);
  target.cacheCreationInputTokens = add(target.cacheCreationInputTokens, usage.cacheCreationInputTokens);
  target.cachedTokens = add(target.cachedTokens, usage.cachedTokens);
  target.reasoningOutputTokens = add(target.reasoningOutputTokens, usage.reasoningOutputTokens);
  target.totalTokens = add(target.totalTokens, usage.totalTokens);
}

function preferredInitialQueryState(
  preferred?: InitialQueryState,
  fallback?: InitialQueryState
): InitialQueryState {
  const normalizedPreferred = normalizeInitialQueryState(preferred);
  const normalizedFallback = normalizeInitialQueryState(fallback);
  return initialQueryStateRank(normalizedPreferred) >= initialQueryStateRank(normalizedFallback)
    ? normalizedPreferred
    : normalizedFallback;
}

function preferredInitialQueryText(
  preferred: Pick<AgenticRunRecord, "initialQueryText" | "initialQueryState">,
  fallback: Pick<AgenticRunRecord, "initialQueryText" | "initialQueryState">
): string | undefined {
  const candidates = [preferred, fallback]
    .filter((run) => pickString(run.initialQueryText) != null)
    .sort((a, b) => initialQueryStateRank(normalizeInitialQueryState(b.initialQueryState, b.initialQueryText)) - initialQueryStateRank(normalizeInitialQueryState(a.initialQueryState, a.initialQueryText)));

  return candidates.length > 0 ? candidates[0].initialQueryText : undefined;
}

function groupInitialQueryState(runs: AgenticRunRecord[]): InitialQueryState {
  return runs.reduce<InitialQueryState>(
    (best, run) => preferredInitialQueryState(run.initialQueryState, best),
    "unavailable"
  );
}

function groupInitialQueryText(runs: AgenticRunRecord[]): string | undefined {
  return runs.reduce<Pick<AgenticRunRecord, "initialQueryText" | "initialQueryState"> | undefined>((best, run) => {
    if (pickString(run.initialQueryText) == null) {
      return best;
    }

    if (!best) {
      return run;
    }

    return preferredInitialQueryText(run, best) === run.initialQueryText ? run : best;
  }, undefined)?.initialQueryText;
}

function sumGroupBreakdowns(groups: AgenticQueryGroup[]): TokenBreakdown {
  const total: TokenBreakdown = {};
  for (const group of groups) {
    mergeBreakdown(total, group);
  }
  return total;
}

function normalizeInitialQueryState(
  state?: InitialQueryState,
  initialQueryText?: string
): InitialQueryState {
  if (state === "captured" || state === "pending" || state === "unavailable") {
    return state;
  }

  return pickString(initialQueryText) != null ? "captured" : "unavailable";
}

function initialQueryStateRank(state?: InitialQueryState): number {
  switch (normalizeInitialQueryState(state)) {
    case "captured":
      return 100;
    case "pending":
      return 10;
    case "unavailable":
    default:
      return 0;
  }
}

function normalizeTraceRole(traceRole?: AgenticRunRecord["traceRole"]): AgenticRunRecord["traceRole"] {
  if (traceRole === "main" || traceRole === "helper" || traceRole === "unknown") {
    return traceRole;
  }
  return undefined;
}

function pickTraceRole(
  preferred?: AgenticRunRecord["traceRole"],
  fallback?: AgenticRunRecord["traceRole"]
): AgenticRunRecord["traceRole"] {
  return normalizeTraceRole(preferred) ?? normalizeTraceRole(fallback);
}

function normalizeTokenUsageSource(source?: TokenUsageSource): TokenUsageSource {
  switch (source) {
    case "invoke_agent":
    case "chat_spans":
    case "events":
    case "metrics":
    case "not_reported":
    case "legacy":
      return source;
    default:
      return "legacy";
  }
}

function pickTokenUsageSource(
  preferred?: TokenUsageSource,
  fallback?: TokenUsageSource
): TokenUsageSource {
  const normalizedPreferred = normalizeTokenUsageSource(preferred);
  const normalizedFallback = normalizeTokenUsageSource(fallback);
  return tokenUsageSourceRank(normalizedPreferred) >= tokenUsageSourceRank(normalizedFallback)
    ? normalizedPreferred
    : normalizedFallback;
}

function uniqueTokenSources(values: Array<TokenUsageSource | undefined>): TokenUsageSource[] {
  return [...new Set(values.map((value) => normalizeTokenUsageSource(value)))];
}

function uniqueBillingContexts(values: Array<BillingContextId | undefined>): BillingContextId[] {
  return [...new Set(values.filter((value): value is BillingContextId => value != null))];
}

function costLabel(
  coverage: CostCoverage,
  pricingCoverage: PricingCoverageSummary
): AgenticQueryGroup["costLabel"] {
  if (coverage === "unavailable") {
    return "Unavailable";
  }

  if (coverage === "partial") {
    const pricedModels = new Set(pricingCoverage.pricedModels);
    if (pricingCoverage.unpricedModels.some((model) => !pricedModels.has(model))) {
      return "Priced models only";
    }

    return "Partial estimate";
  }

  return "All estimated";
}

function sessionCostLabel(
  coverage: CostCoverage,
  groups: AgenticQueryGroup[]
): AgenticChatSessionGroup["costLabel"] {
  if (coverage === "unavailable") {
    return "Unavailable";
  }

  if (coverage === "complete") {
    return "All estimated";
  }

  if (groups.some((group) => group.costLabel === "Partial estimate" || group.costLabel === "Unavailable")) {
    return "Partial estimate";
  }

  if (groups.some((group) => group.costLabel === "Priced models only")) {
    return "Priced models only";
  }

  return "Partial estimate";
}

function toCsv(groups: AgenticQueryGroup[]): string {
  const columns: Array<[string, (group: AgenticQueryGroup, run: AgenticRunRecord) => unknown]> = [
    ["Query Started At", (group) => group.startedAt],
    ["Initial Query", (group) => group.initialQueryText ?? ""],
    ["Chat Session ID", (group) => group.chatSessionId ?? ""],
    ["Run Started At", (_group, run) => run.startedAt],
    ["Ended At", (_group, run) => run.endedAt ?? ""],
    ["Query ID", (group) => group.queryId],
    ["Trace ID", (_group, run) => run.traceId],
    ["Trace Role", (_group, run) => run.traceRole ?? ""],
    ["Trace Chat Session ID", (_group, run) => run.traceChatSessionId ?? ""],
    ["Mode", (_group, run) => run.mode ?? ""],
    ["Billing Context", (_group, run) => run.billingContext ?? ""],
    ["Models", (_group, run) => run.models.join("; ")],
    ["Token Source", (_group, run) => run.tokenUsageSource],
    ["Model Usage", (_group, run) => formatModelUsage(run.modelUsages)],
    ["Input", (_group, run) => run.inputTokens ?? ""],
    ["Output", (_group, run) => run.outputTokens ?? ""],
    ["Cached", (_group, run) => run.cachedTokens ?? ""],
    ["Total", (_group, run) => run.totalTokens ?? ""],
    ["Est. Credits", (_group, run) => run.estimatedAiCredits ?? ""],
    ["Est. USD", (_group, run) => run.estimatedUsd ?? ""],
    ["Run Cost Coverage", (_group, run) => run.costCoverage],
    ["Run Pricing Coverage", (_group, run) => normalizePricingCoverage(run.pricingCoverage, run).state],
    ["Run Pricing Versions", (_group, run) => normalizePricingCoverage(run.pricingCoverage, run).pricingVersions.join("; ")],
    ["Run Pricing Effective From", (_group, run) => normalizePricingCoverage(run.pricingCoverage, run).pricingEffectiveFrom.join("; ")],
    ["Run Legacy Schema", (_group, run) => run.schemaVersion === 3 ? "no" : "yes"],
    ["Cost Scope", (group) => group.costLabel],
    ["Query Billing Context", (group) => group.billingContext ?? ""],
    ["Query Billing Contexts", (group) => (group.billingContexts ?? []).join("; ")],
    ["Query Accounting Coverage", (group) => group.accountingCoverage?.state ?? ""],
    ["Query Pricing Coverage", (group) => group.pricingCoverage?.state ?? ""],
    ["Query Pricing Versions", (group) => (group.pricingVersions ?? []).join("; ")],
    ["Query Pricing Effective From", (group) => (group.pricingEffectiveFrom ?? []).join("; ")],
    ["Query Unpriced Slices", (group) => group.unpricedSliceCount ?? 0],
    ["Query Unavailable Slices", (group) => group.unavailableSliceCount ?? 0],
    ["Query Legacy Runs", (group) => group.legacyRunCount ?? 0],
    ["Tools", (_group, run) => formatTools(run.tools)],
    ["Tool Calls", (_group, run) => run.toolCallCount],
    ["Duration Ms", (_group, run) => run.durationMs ?? ""],
    ["Status", (_group, run) => run.status],
    ["Warnings", (_group, run) => run.warnings.join("; ")]
  ];

  const header = columns.map(([label]) => csvEscape(label)).join(",");
  const rows = groups.flatMap((group) =>
    group.runs.map((run) => columns.map(([, getter]) => csvEscape(getter(group, run))).join(","))
  );
  return [header, ...rows].join("\n") + "\n";
}

function formatModelUsage(modelUsages: ModelUsageSummary[]): string {
  return modelUsages
    .map((usage) => `${usage.provider ? `${usage.provider}/` : ""}${usage.model}: input ${usage.inputTokens ?? "n/a"}, output ${usage.outputTokens ?? "n/a"}, total ${usage.totalTokens ?? "n/a"}, credits ${aiCreditsFromNanoUsd(normalizedEstimatedNanoUsd(usage)) ?? ""}, usd ${usage.estimatedUsd ?? ""}`)
    .join("; ");
}

function formatTools(tools: ToolSummary[]): string {
  return tools
    .map((tool) => `${tool.name}: calls ${tool.count}, input ${tool.inputTokens ?? "n/a"}, output ${tool.outputTokens ?? "n/a"}, total ${tool.totalTokens ?? "n/a"}`)
    .join("; ");
}

function firstDefined(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value != null && value.trim() !== "");
}

function firstBillingContext(values: Array<BillingContextId | undefined>): BillingContextId | undefined {
  return values.find((value): value is BillingContextId => value != null);
}

function latestDefined(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => value != null && value.trim() !== "").sort().at(-1);
}

function sessionSortKey(session: AgenticChatSessionGroup): string {
  return latestDefined(session.queries.map((query) => query.endedAt ?? query.startedAt)) ?? session.startedAt;
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value != null && value.trim() !== ""))];
}

function normalizeStoredModelUsage(usage: ModelUsageSummary): ModelUsageSummary {
  const estimatedNanoUsd = normalizedEstimatedNanoUsd(usage);
  const pricingCoverage = normalizePricingCoverage(usage.pricingCoverage, { ...usage, model: usage.model });
  return {
    ...usage,
    estimatedNanoUsd,
    estimatedUsd: usdFromNanoUsd(estimatedNanoUsd) ?? usage.estimatedUsd,
    pricingCoverage
  };
}

function emptyPricingCoverage(): PricingCoverageSummary {
  return {
    state: "priced",
    reasons: [],
    pricedModels: [],
    unpricedModels: [],
    missingModelSlices: 0,
    pricingVersions: [],
    pricingEffectiveFrom: []
  };
}

function normalizePricingCoverage(
  pricingCoverage?: PricingCoverageSummary,
  value?: {
    estimatedNanoUsd?: NanoUsd;
    estimatedUsd?: number;
    model?: string;
    models?: string[];
    modelUsages?: ModelUsageSummary[];
    pricingVersion?: string;
    tokenUsageSource?: TokenUsageSource;
  }
): PricingCoverageSummary {
  if (pricingCoverage) {
    return applyPricingCoveragePolicy({
      state: pricingCoverage.state,
      reasons: uniqueReasons(pricingCoverage.reasons),
      pricedModels: uniqueDefined(pricingCoverage.pricedModels),
      unpricedModels: uniqueDefined(pricingCoverage.unpricedModels),
      missingModelSlices: Math.max(0, pricingCoverage.missingModelSlices),
      pricingVersions: uniqueDefined(pricingCoverage.pricingVersions),
      pricingEffectiveFrom: uniqueDefined(pricingCoverage.pricingEffectiveFrom)
    });
  }

  return value ? deriveStoredPricingCoverage(value) : emptyPricingCoverage();
}

function deriveStoredPricingCoverage(value: {
  estimatedNanoUsd?: NanoUsd;
  estimatedUsd?: number;
  model?: string;
  models?: string[];
  modelUsages?: ModelUsageSummary[];
  pricingVersion?: string;
  tokenUsageSource?: TokenUsageSource;
}): PricingCoverageSummary {
  const estimatedNanoUsd = normalizedEstimatedNanoUsd(value);
  const models = uniqueDefined(value.models ?? (value.model ? [value.model] : []));
  const modelUsages = (value.modelUsages ?? []).map((usage) => normalizeStoredModelUsage(usage));
  const pricedModels = uniqueDefined(modelUsages.flatMap((usage) => usage.pricingCoverage?.pricedModels ?? (normalizedEstimatedNanoUsd(usage) != null ? [usage.model] : [])));
  const unpricedModels = uniqueDefined(modelUsages.flatMap((usage) => usage.pricingCoverage?.unpricedModels ?? (normalizedEstimatedNanoUsd(usage) == null ? [usage.model] : [])));
  const reasons = new Set<AccountingCoverageReason>();

  if (estimatedNanoUsd == null) {
    if (models.some(isLikelyNonOpenAiModel)) {
      reasons.add("model_unpriced");
    } else {
      reasons.add("missing_model_attribution");
    }
  } else if (models.some((model) => !pricedModels.includes(model))) {
    reasons.add(models.some((model) => isLikelyNonOpenAiModel(model) && !pricedModels.includes(model)) ? "model_unpriced" : "missing_model_attribution");
  }

  if (value.tokenUsageSource === "legacy") {
    reasons.add("legacy_schema");
  }

  return {
    state: estimatedNanoUsd == null ? "unpriced" : models.some((model) => !pricedModels.includes(model)) || reasons.has("legacy_schema") ? "partial" : "priced",
    reasons: uniqueReasons([...reasons]),
    pricedModels: pricedModels.length > 0 ? pricedModels : estimatedNanoUsd != null && models.length === 1 && !models.some(isLikelyNonOpenAiModel) ? models : [],
    unpricedModels: estimatedNanoUsd == null ? models : unpricedModels,
    missingModelSlices: estimatedNanoUsd == null && models.length === 0 ? 1 : 0,
    pricingVersions: uniqueDefined(value.pricingVersion ? [value.pricingVersion] : []),
    pricingEffectiveFrom: uniqueDefined(modelUsages.flatMap((usage) => usage.pricingCoverage?.pricingEffectiveFrom ?? []))
  };
}

function normalizedEstimatedNanoUsd(
  value?: { estimatedNanoUsd?: NanoUsd; estimatedUsd?: number }
): NanoUsd | undefined {
  return value?.estimatedNanoUsd ?? nanoUsdFromUsd(value?.estimatedUsd);
}

function add(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function addNanoUsd(a?: NanoUsd, b?: NanoUsd): NanoUsd | undefined {
  return add(a, b);
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const reported = values.filter((value): value is number => value != null);
  return reported.length === 0 ? undefined : reported.reduce((sum, value) => sum + value, 0);
}

function sumOptionalNanoUsd(values: Array<NanoUsd | undefined>): NanoUsd | undefined {
  return sumOptional(values);
}

function aggregateCostCoverage<T extends { costCoverage: CostCoverage; estimatedNanoUsd?: NanoUsd; estimatedUsd?: number }>(items: T[]): CostCoverage {
  if (items.some((item) => "pricingCoverage" in item && (item as { pricingCoverage?: PricingCoverageSummary }).pricingCoverage != null)) {
    return costCoverageFromPricingCoverage(aggregatePricingCoverage(items.map((item) => normalizePricingCoverage((item as { pricingCoverage?: PricingCoverageSummary }).pricingCoverage, item))));
  }

  if (items.length === 0) {
    return "complete";
  }

  if (items.every((item) => normalizeCostCoverage(item.costCoverage) === "complete")) {
    return "complete";
  }

  return items.some((item) => normalizedEstimatedNanoUsd(item) != null) ? "partial" : "unavailable";
}

function normalizeCostCoverage(
  coverage?: CostCoverage,
  run?: Pick<AgenticRunRecord, "estimatedNanoUsd" | "estimatedUsd" | "models" | "modelUsages" | "pricingCoverage">
): CostCoverage {
  if (run?.pricingCoverage) {
    return costCoverageFromPricingCoverage(normalizePricingCoverage(run.pricingCoverage, run));
  }

  if (coverage === "complete" || coverage === "partial" || coverage === "unavailable") {
    return coverage;
  }

  return run ? deriveStoredRunCostCoverage(run) : "unavailable";
}

function deriveStoredRunCostCoverage(
  run: Pick<AgenticRunRecord, "estimatedNanoUsd" | "estimatedUsd" | "models" | "modelUsages" | "pricingCoverage">
): CostCoverage {
  if (run.pricingCoverage) {
    return costCoverageFromPricingCoverage(normalizePricingCoverage(run.pricingCoverage, run));
  }

  if (normalizedEstimatedNanoUsd(run) == null) {
    return "unavailable";
  }

  if (run.models.length <= 1 && run.modelUsages.length === 0) {
    return "complete";
  }

  if (run.modelUsages.length === 0) {
    return "partial";
  }

  const models = uniqueDefined(run.models);
  return run.modelUsages.length >= models.length && run.modelUsages.every((usage) => normalizedEstimatedNanoUsd(usage) != null)
    ? "complete"
    : "partial";
}

function aggregatePricingCoverage(coverages: PricingCoverageSummary[]): PricingCoverageSummary {
  if (coverages.length === 0) {
    return emptyPricingCoverage();
  }

  const pricedModels = uniqueDefined(coverages.flatMap((coverage) => coverage.pricedModels));
  const unpricedModels = uniqueDefined(coverages.flatMap((coverage) => coverage.unpricedModels));
  const missingModelSlices = coverages.reduce((sum, coverage) => sum + coverage.missingModelSlices, 0);
  const reasons = uniqueReasons(coverages.flatMap((coverage) => coverage.reasons));
  const pricingVersions = uniqueDefined(coverages.flatMap((coverage) => coverage.pricingVersions));
  const pricingEffectiveFrom = uniqueDefined(coverages.flatMap((coverage) => coverage.pricingEffectiveFrom));
  const hasPriced = pricedModels.length > 0 || coverages.some((coverage) => coverage.state === "priced" || coverage.state === "partial");
  const hasUnpriced = unpricedModels.length > 0 || missingModelSlices > 0 || coverages.some((coverage) => coverage.state === "partial" || coverage.state === "unpriced");

  return {
    state: hasPriced ? (hasUnpriced ? "partial" : "priced") : "unpriced",
    reasons,
    pricedModels,
    unpricedModels,
    missingModelSlices,
    pricingVersions,
    pricingEffectiveFrom
  };
}

function uniqueReasons(values: AccountingCoverageReason[]): AccountingCoverageReason[] {
  return [...new Set(values)];
}

function costCoverageRank(coverage?: CostCoverage): number {
  switch (normalizeCostCoverage(coverage)) {
    case "complete":
      return 2;
    case "partial":
      return 1;
    case "unavailable":
    default:
      return 0;
  }
}

function pricingCoverageStateRank(state?: PricingCoverageSummary["state"]): number {
  switch (state) {
    case "priced":
      return 2;
    case "partial":
      return 1;
    case "unpriced":
    default:
      return 0;
  }
}

function tokenUsageSourceRank(source?: TokenUsageSource): number {
  switch (normalizeTokenUsageSource(source)) {
    case "invoke_agent":
      return 5;
    case "chat_spans":
      return 4;
    case "events":
      return 3;
    case "metrics":
      return 2;
    case "not_reported":
      return 1;
    case "legacy":
    default:
      return 0;
  }
}

function groupDurationMs(startedAt: string, endedAt?: string): number | undefined {
  if (!endedAt) {
    return undefined;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

function hasReportedTokens(usage: TokenBreakdown): boolean {
  return (
    usage.inputTokens != null ||
    usage.outputTokens != null ||
    usage.cacheReadInputTokens != null ||
    usage.cacheCreationInputTokens != null ||
    usage.cachedTokens != null ||
    usage.reasoningOutputTokens != null ||
    usage.totalTokens != null
  );
}

function isLikelyNonOpenAiModel(model: string): boolean {
  const normalized = model.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("anthropic")) {
    return true;
  }
  return !(
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized === "chat-latest" ||
    normalized.includes("openai")
  );
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
