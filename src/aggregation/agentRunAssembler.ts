import {
  AccountingCoverage,
  AccountingCoverageReason,
  AccountingInvariantResult,
  AccountingModelSummary,
  AccountingSourceSelection,
  AccountingToolSummary,
  aiCreditsFromNanoUsd,
  AgenticQueryRun,
  AgentRunAssembler,
  AgentRunUpdate,
  AssembledAgentTrace,
  AuthoritativeTraceAccounting,
  AttributedUsageUnit,
  BillingContextId,
  CanonicalEventRecord,
  CanonicalMetricRecord,
  CanonicalOtelRecord,
  CanonicalSpanRecord,
  CostEstimation,
  costCoverageFromPricingCoverage,
  InitialQueryState,
  ModelUsageSummary,
  nanoUsdFromUsd,
  PartialAgenticQueryRun,
  PricingMatchMetadata,
  PricingCoverageSummary,
  SafeSpanAccountingSummary,
  TokenBreakdown,
  TokenMeasurement,
  TokenUsage,
  ToolSummary,
  usdFromNanoUsd
} from "../types";
import { unixNanoToIso } from "../normalization/otelValues";
import { finalizeTokenBreakdown, sumTokenUsage, tokensFromAttributes } from "./tokenMeasurement";
import {
  extractCopilotChatSessionId,
  extractCopilotSessionId,
  extractInitialQueryText,
  extractModel,
  extractServiceName,
  extractSessionId,
  extractSpanDurationMs,
  extractStatus,
  extractToolCallId,
  extractToolName,
  isChatName,
  isExecuteToolName,
  isInvokeAgentName,
  isSpawnedHelperTraceRoot,
  isUserMessageEvent,
  isTerminalSpan,
  recordTimestamp
} from "./otelSemantics";

type ActiveTrace = AssembledAgentTrace & {
  seenKeys: Set<string>;
  initialQueryText?: string;
  initialQueryCandidate?: InitialQueryCandidate;
  initialQueryScore: number;
  queryIdOverride?: string;
};

type ToolCallMetadata = {
  key: string;
  name: string;
  count: number;
  failures: number;
  totalDurationMs?: number;
  spanIds: string[];
  warnings: string[];
};

type InitialQueryCandidate = {
  text: string;
  score: number;
  record: CanonicalOtelRecord;
};

export class DefaultAgentRunAssembler implements AgentRunAssembler {
  private readonly traces = new Map<string, ActiveTrace>();

  constructor(
    private readonly tokenMeasurement: TokenMeasurement,
    private readonly costEstimation: CostEstimation,
    private readonly completionSettleMs = 3_000,
    private readonly billingContext?: BillingContextId
  ) {}

  ingest(record: CanonicalOtelRecord): AgentRunUpdate | null {
    return this.ingestMany([record])[0] ?? null;
  }

  ingestMany(records: CanonicalOtelRecord[]): AgentRunUpdate[] {
    const touchedTraceIds = new Set<string>();

    for (const record of records) {
      const traceId = record.traceId;
      if (!traceId) {
        continue;
      }

      const trace = this.traces.get(traceId) ?? newActiveTrace(traceId);
      if (!upsertRecord(trace, record)) {
        continue;
      }

      trace.rootSpan = chooseRootInvokeAgent(trace.spans);
      this.updateQueryOwnership(trace);
      updateInitialQueryCandidate(trace);
      trace.lastUpdatedAt = new Date().toISOString();
      this.traces.set(traceId, trace);
      touchedTraceIds.add(traceId);
    }

    const updates: AgentRunUpdate[] = [];
    for (const traceId of touchedTraceIds) {
      const update = this.updateForTrace(traceId);
      if (update) {
        updates.push(update);
      }
    }

    return updates;
  }

  private updateForTrace(traceId: string): AgentRunUpdate | null {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return null;
    }

    if (!trace.rootSpan && !hasEventOnlyAgentRun(trace)) {
      return null;
    }

    if (trace.rootSpan && isTerminalSpan(trace.rootSpan)) {
      if (this.completionSettleMs === 0 || traceSettled(trace, this.completionSettleMs)) {
        const run = this.buildRun(trace, "completed") as AgenticQueryRun;
        this.traces.delete(traceId);
        return { kind: "completed", run, trace };
      }
    }

    return { kind: "running", run: this.buildRun(trace, "running"), trace };
  }

  activeTraceCount(): number {
    return this.traces.size;
  }

  private updateQueryOwnership(trace: ActiveTrace): void {
    if (!trace.rootSpan || !isSpawnedHelperTraceRoot(trace.rootSpan)) {
      return;
    }

    const owner = this.findOwnerTrace(trace);
    if (owner) {
      trace.queryIdOverride = owner.queryIdOverride ?? owner.traceId;
    }
  }

  private findOwnerTrace(trace: ActiveTrace): ActiveTrace | undefined {
    const sessionId = trace.rootSpan ? extractCopilotSessionId(trace.rootSpan) : undefined;
    if (!sessionId) {
      return undefined;
    }

    return [...this.traces.values()]
      .filter((candidate) => candidate.traceId !== trace.traceId && candidate.rootSpan)
      .filter((candidate) => !isSpawnedHelperTraceRoot(candidate.rootSpan!))
      .filter((candidate) => extractCopilotSessionId(candidate.rootSpan!) === sessionId)
      .filter((candidate) => compareTimestamp(candidate.rootSpan?.startTimeUnixNano, trace.rootSpan?.startTimeUnixNano) <= 0)
      .sort((a, b) => compareTimestamp(b.rootSpan?.startTimeUnixNano, a.rootSpan?.startTimeUnixNano))[0];
  }

  evictStale(maxAgeMs: number): AgenticQueryRun[] {
    const now = Date.now();
    const evicted: AgenticQueryRun[] = [];

    for (const [traceId, trace] of this.traces) {
      if (now - new Date(trace.lastUpdatedAt).getTime() <= maxAgeMs || (!trace.rootSpan && !hasEventOnlyAgentRun(trace))) {
        if (!(trace.rootSpan && isTerminalSpan(trace.rootSpan) && traceSettled(trace, this.completionSettleMs))) {
          continue;
        }
      }

      evicted.push(this.buildRun(trace, trace.rootSpan && isTerminalSpan(trace.rootSpan) ? "completed" : "unknown") as AgenticQueryRun);
      this.traces.delete(traceId);
    }

    return evicted;
  }

  private buildRun(
    trace: ActiveTrace,
    fallbackStatus: AgenticQueryRun["status"]
  ): AgenticQueryRun | PartialAgenticQueryRun {
    const root = trace.rootSpan;
    const tokenUsage = this.tokenMeasurement.measure(trace);
    const startedAt = root ? unixNanoToIso(root.startTimeUnixNano) ?? trace.firstSeenAt : eventStartIso(trace) ?? trace.firstSeenAt;
    const endedAt = root ? unixNanoToIso(root.endTimeUnixNano) : eventEndIso(trace);
    const status = fallbackStatus === "completed" ? extractStatus(root) : fallbackStatus === "unknown" ? "completed" : fallbackStatus;
    const queryId = deriveQueryId(trace);
    const initialQueryText = trace.initialQueryText;
    const initialQueryState = deriveInitialQueryState(trace, fallbackStatus);
    const copilotSessionId = firstDefined(trace.spans.map(extractCopilotSessionId).concat(trace.events.map(extractCopilotSessionId)));
    const traceChatSessionId = firstDefined(trace.spans.map(extractCopilotChatSessionId).concat(trace.events.map(extractCopilotChatSessionId)));
    const legacySessionId = firstDefined(trace.spans.map(extractSessionId).concat(trace.events.map(extractSessionId)));
    const chatSessionId = firstDefined([copilotSessionId, traceChatSessionId]);
    const pricedUsageUnits = priceAttributedUsageUnits(tokenUsage.attributedUsageUnits, startedAt, this.costEstimation);
    const accounting = buildAuthoritativeAccounting({
      trace,
      tokenUsage,
      pricedUsageUnits,
      queryId,
      chatSessionId,
      startedAt
    });
    const modelUsages = modelUsagesFromAccounting(accounting.modelSummaries);
    const tools = toolsFromAccounting(accounting.toolSummaries);
    const pricingCoverage = accounting.totals.pricingCoverage;
    const costCoverage = costCoverageFromPricingCoverage(pricingCoverage);
    const estimatedNanoUsd = accounting.totals.estimatedNanoUsd;
    const billingContext = firstBillingContext(accounting.pricingMatches.map((pricing) => pricing.billingContext)) ?? this.billingContext;
    const warnings = uniqueDefined([
      ...accounting.warnings,
      ...(modelUsages.length === 0 ? ["Model name was not reported."] : []),
      ...(costCoverage === "partial"
        ? ["Estimated cost is partial and covers only attributed model slices with matched pricing."]
        : []),
      ...(estimatedNanoUsd == null && tokenUsage.totalTokens != null
        ? ["Estimated cost is unavailable because no attributed model slice could be matched to pricing."]
        : [])
    ]);
    const models = deriveRunModels(accounting, trace, tokenUsage.source);

    return {
      schemaVersion: 3,
      billingContext,
      id: trace.traceId,
      traceId: trace.traceId,
      queryId,
      queryStartedAt: startedAt,
      chatSessionId,
      copilotSessionId,
      traceChatSessionId,
      traceRole: deriveTraceRole(root, copilotSessionId, traceChatSessionId),
      initialQueryText,
      initialQueryState,
      tokenUsageSource: tokenUsage.source,
      pricingCoverage,
      accounting,
      sessionId: firstDefined([copilotSessionId, legacySessionId, traceChatSessionId]),
      startedAt,
      endedAt,
      durationMs: root ? extractSpanDurationMs(root) : eventDurationMs(trace),
      status,
      serviceName: firstDefined(trace.spans.map(extractServiceName).concat(trace.events.map(extractServiceName))),
      mode: inferMode(root),
      models,
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      cacheReadInputTokens: tokenUsage.cacheReadInputTokens,
      cacheCreationInputTokens: tokenUsage.cacheCreationInputTokens,
      cachedTokens: tokenUsage.cachedTokens,
      reasoningOutputTokens: tokenUsage.reasoningOutputTokens,
      totalTokens: tokenUsage.totalTokens,
      estimatedNanoUsd,
      estimatedUsd: usdFromNanoUsd(estimatedNanoUsd),
      estimatedAiCredits: aiCreditsFromNanoUsd(estimatedNanoUsd),
      pricingVersion: firstDefined(accounting.pricingMatches.map((pricing) => pricing.pricingVersion)),
      costCoverage,
      modelUsages,
      llmCallCount: deriveLlmCallCount(tokenUsage, accounting.attributedUsageUnits),
      toolCallCount: tools.reduce((sum, tool) => sum + tool.count, 0),
      tools,
      warnings
    };
  }
}

function newActiveTrace(traceId: string): ActiveTrace {
  const now = new Date().toISOString();
  return {
    traceId,
    spans: [],
    events: [],
    metrics: [],
    firstSeenAt: now,
    lastUpdatedAt: now,
    seenKeys: new Set(),
    initialQueryScore: Number.NEGATIVE_INFINITY
  };
}

function addRecord(trace: ActiveTrace, record: CanonicalOtelRecord): void {
  if (record.kind === "span") {
    trace.spans.push(record);
    return;
  }
  if (record.kind === "event") {
    trace.events.push(record);
    return;
  }
  trace.metrics.push(record);
}

function upsertRecord(trace: ActiveTrace, record: CanonicalOtelRecord): boolean {
  if (record.kind === "span") {
    const index = trace.spans.findIndex((span) => span.spanId === record.spanId);
    if (index === -1) {
      trace.spans.push(record);
      return true;
    }

    if (sameSpan(trace.spans[index], record)) {
      return false;
    }

    trace.spans[index] = record;
    return true;
  }

  const key = recordKey(record);
  if (trace.seenKeys.has(key)) {
    return false;
  }

  trace.seenKeys.add(key);
  addRecord(trace, record);
  return true;
}

function sameSpan(a: CanonicalSpanRecord, b: CanonicalSpanRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function traceSettled(trace: AssembledAgentTrace, completionSettleMs: number): boolean {
  return Date.now() - new Date(trace.lastUpdatedAt).getTime() >= completionSettleMs;
}

function updateInitialQueryCandidate(trace: ActiveTrace): void {
  const candidate = bestInitialQueryCandidate(trace) ?? preservedInitialQueryCandidate(trace.initialQueryCandidate, trace);
  trace.initialQueryScore = candidate?.score ?? Number.NEGATIVE_INFINITY;
  if (candidate) {
    trace.initialQueryText = candidate.text;
    trace.initialQueryCandidate = candidate;
  } else {
    delete trace.initialQueryText;
    delete trace.initialQueryCandidate;
  }
}

function bestInitialQueryCandidate(trace: AssembledAgentTrace): InitialQueryCandidate | undefined {
  const candidates = allTraceRecords(trace)
    .map((record) => {
      const text = extractInitialQueryText(record);
      if (!text) {
        return undefined;
      }
      const score = promptCandidateScore(record, text, trace);
      return score > Number.NEGATIVE_INFINITY ? { text, score, record } : undefined;
    })
    .filter((candidate): candidate is InitialQueryCandidate => candidate != null)
    .sort(compareInitialQueryCandidates);

  return candidates[0];
}

function promptCandidateScore(
  record: CanonicalOtelRecord,
  text: string,
  trace: AssembledAgentTrace
): number {
  if (looksLikeGeneratedHelperPrompt(text)) {
    return Number.NEGATIVE_INFINITY;
  }

  if (trace.rootSpan && isSpawnedHelperTraceRoot(trace.rootSpan)) {
    return Number.NEGATIVE_INFINITY;
  }

  if (isUserMessageEvent(record)) {
    return userMessagePromptScore(record, trace);
  }

  let score = 0;
  if (record.kind === "span") {
    if (!trace.rootSpan && !record.parentSpanId && isSpawnedHelperTraceRoot(record)) {
      return Number.NEGATIVE_INFINITY;
    }
    if (trace.rootSpan && record.spanId === trace.rootSpan.spanId) {
      score += 100;
    }
    if (!record.parentSpanId) {
      score += 20;
    }
    if (isInvokeAgentName(record.name)) {
      score += 10;
    }
  }

  score += Math.min(text.length, 200) / 10;
  return score;
}

function compareInitialQueryCandidates(a: InitialQueryCandidate, b: InitialQueryCandidate): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }

  if (isUserMessageEvent(a.record) && isUserMessageEvent(b.record)) {
    const timeComparison = compareTimestamp(recordTimestamp(b.record), recordTimestamp(a.record));
    if (timeComparison !== 0) {
      return timeComparison;
    }
  }

  return b.text.length - a.text.length || compareTimestamp(recordTimestamp(a.record), recordTimestamp(b.record));
}

function preservedInitialQueryCandidate(
  candidate: InitialQueryCandidate | undefined,
  trace: AssembledAgentTrace
): InitialQueryCandidate | undefined {
  if (!candidate || looksLikeGeneratedHelperPrompt(candidate.text)) {
    return undefined;
  }

  if (trace.rootSpan && isSpawnedHelperTraceRoot(trace.rootSpan)) {
    return undefined;
  }

  if (isUserMessageEvent(candidate.record)) {
    return isValidUserMessagePromptEvent(candidate.record, trace) ? candidate : undefined;
  }

  if (candidate.record.kind !== "span") {
    return undefined;
  }

  if (!trace.rootSpan) {
    return !candidate.record.parentSpanId ? candidate : undefined;
  }

  return candidate.record.spanId === trace.rootSpan.spanId ? candidate : undefined;
}

function userMessagePromptScore(event: CanonicalEventRecord, trace: AssembledAgentTrace): number {
  if (!isValidUserMessagePromptEvent(event, trace)) {
    return Number.NEGATIVE_INFINITY;
  }

  if (!trace.rootSpan) {
    return 800;
  }

  return event.spanId === trace.rootSpan.spanId ? 1_000 : 900;
}

function isValidUserMessagePromptEvent(event: CanonicalEventRecord, trace: AssembledAgentTrace): boolean {
  if (!event.spanId) {
    return false;
  }

  const owner = spanById(trace).get(event.spanId);
  if (!owner) {
    return false;
  }

  if (!isCompatibleChatSession(event, owner)) {
    return false;
  }

  const root = trace.rootSpan;
  if (!root) {
    return !isSpawnedHelperTraceRoot(owner) && !pathContainsToolOrNestedInvoke(trace, owner);
  }

  if (!isCompatibleChatSession(event, root) || isSpawnedHelperTraceRoot(root)) {
    return false;
  }

  if (!isEventWithinRootTiming(event, root)) {
    return false;
  }

  if (event.spanId === root.spanId) {
    return true;
  }

  if (!isDescendantOf(trace, event.spanId, root.spanId)) {
    return false;
  }

  return !pathContainsToolOrNestedInvoke(trace, owner, root);
}

function isEventWithinRootTiming(event: CanonicalEventRecord, root: CanonicalSpanRecord): boolean {
  if (event.timeUnixNano && root.startTimeUnixNano && compareTimestamp(event.timeUnixNano, root.startTimeUnixNano) < 0) {
    return false;
  }

  if (event.timeUnixNano && root.endTimeUnixNano && compareTimestamp(event.timeUnixNano, root.endTimeUnixNano) > 0) {
    return false;
  }

  return true;
}

function isCompatibleChatSession(a: CanonicalOtelRecord, b: CanonicalOtelRecord): boolean {
  const aChatSessionId = extractCopilotChatSessionId(a);
  const bChatSessionId = extractCopilotChatSessionId(b);
  return !aChatSessionId || !bChatSessionId || aChatSessionId === bChatSessionId;
}

function isDescendantOf(trace: AssembledAgentTrace, spanId: string, ancestorSpanId: string): boolean {
  const spans = spanById(trace);
  let current = spans.get(spanId);
  const seen = new Set<string>();

  while (current?.parentSpanId) {
    if (current.parentSpanId === ancestorSpanId) {
      return true;
    }
    if (seen.has(current.parentSpanId)) {
      return false;
    }
    seen.add(current.parentSpanId);
    current = spans.get(current.parentSpanId);
  }

  return false;
}

function pathContainsToolOrNestedInvoke(
  trace: AssembledAgentTrace,
  owner: CanonicalSpanRecord,
  root?: CanonicalSpanRecord
): boolean {
  const spans = spanById(trace);
  let current: CanonicalSpanRecord | undefined = owner;
  const seen = new Set<string>();

  while (current) {
    if (isExecuteToolName(current.name)) {
      return true;
    }
    if (isInvokeAgentName(current.name) && current.spanId !== root?.spanId && current.parentSpanId) {
      return true;
    }
    if (!current.parentSpanId || current.spanId === root?.spanId || seen.has(current.parentSpanId)) {
      return false;
    }
    seen.add(current.parentSpanId);
    current = spans.get(current.parentSpanId);
  }

  return false;
}

function looksLikeGeneratedHelperPrompt(text: string): boolean {
  const normalized = text.trim();
  if (normalized === "") {
    return true;
  }

  if (
    normalized.startsWith("Find relevant code snippets for:") &&
    normalized.includes("Current working directory:") &&
    normalized.includes("More detailed instructions:")
  ) {
    return true;
  }

  if (normalized.startsWith("Summarize the following content in a SINGLE sentence")) {
    return true;
  }

  return false;
}

function chooseRootInvokeAgent(spans: CanonicalSpanRecord[]): CanonicalSpanRecord | undefined {
  const invokeSpans = spans.filter((span) => isInvokeAgentName(span.name) && !span.parentSpanId);
  if (invokeSpans.length === 0) {
    return undefined;
  }

  return [...invokeSpans].sort((a, b) => compareTimestamp(a.startTimeUnixNano, b.startTimeUnixNano))[0];
}

function summarizeTools(trace: AssembledAgentTrace): ToolSummary[] {
  const summaries = new Map<string, ToolSummary>();
  const seenCalls = new Set<string>();
  for (const span of trace.spans.filter((candidate) => isExecuteToolName(candidate.name))) {
    const name = extractToolName(span);
    const spanCallId = extractToolCallId(span);
    const callKey = spanCallId ? `call:${spanCallId}` : `span:${span.spanId}`;
    if (seenCalls.has(callKey)) {
      continue;
    }
    seenCalls.add(callKey);
    const current = summaries.get(name) ?? { name, count: 0, failures: 0, totalDurationMs: 0 };
    current.count += 1;
    if (span.status === "STATUS_CODE_ERROR" || span.status === "ERROR") {
      current.failures += 1;
    }
    const durationMs = extractSpanDurationMs(span);
    if (durationMs != null) {
      current.totalDurationMs = (current.totalDurationMs ?? 0) + durationMs;
    }
    mergeTokenBreakdown(current, toolTokenUsage(trace, span));
    summaries.set(name, current);
  }

  for (const event of trace.events.filter((candidate) => candidate.name === "copilot_chat.tool.call")) {
    const name = typeof event.attributes["gen_ai.tool.name"] === "string" ? event.attributes["gen_ai.tool.name"] : "unknown";
    const eventCallId = extractToolCallId(event);
    const callKey = eventCallId ? `call:${eventCallId}` : `event:${event.traceId ?? ""}:${event.spanId ?? ""}:${event.timeUnixNano ?? ""}`;
    if (seenCalls.has(callKey)) {
      continue;
    }
    seenCalls.add(callKey);
    const current = summaries.get(name) ?? { name, count: 0, failures: 0, totalDurationMs: 0 };
    current.count += 1;
    if (event.attributes.success === false) {
      current.failures += 1;
    }
    const durationMs = typeof event.attributes.duration_ms === "number" ? event.attributes.duration_ms : undefined;
    if (durationMs != null) {
      current.totalDurationMs = (current.totalDurationMs ?? 0) + durationMs;
    }
    mergeTokenBreakdown(current, finalizeTokenBreakdown(tokensFromAttributes(event.attributes)));
    summaries.set(name, current);
  }
  return [...summaries.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildAuthoritativeAccounting(input: {
  trace: AssembledAgentTrace;
  tokenUsage: TokenUsage;
  pricedUsageUnits: AttributedUsageUnit[];
  queryId: string;
  chatSessionId?: string;
  startedAt: string;
}): AuthoritativeTraceAccounting {
  const attributedUsageUnits = input.pricedUsageUnits.map((unit) => ({
    ...unit,
    queryId: input.queryId,
    chatSessionId: input.chatSessionId
  }));
  const modelSummaries = buildAccountingModelSummaries(attributedUsageUnits);
  const compatibilityModelUsages = modelUsagesFromAccounting(modelSummaries);
  const pricingCoverage = deriveRunPricingCoverage(input.tokenUsage, attributedUsageUnits, compatibilityModelUsages);
  const toolSummaries = buildAccountingToolSummaries(input.trace, attributedUsageUnits, input.tokenUsage);
  const spanSummaries = buildSafeSpanSummaries(attributedUsageUnits, pricingCoverage);
  const estimatedNanoUsd = sumOptionalNanoUsd(modelSummaries.map((summary) => summary.estimatedNanoUsd));
  const pricingMatches = uniquePricingMatches([
    ...attributedUsageUnits.flatMap((unit) => unit.pricing ? [unit.pricing] : []),
    ...modelSummaries.flatMap((summary) => summary.pricing ? [summary.pricing] : []),
    ...toolSummaries.flatMap((summary) => summary.pricing ? [summary.pricing] : [])
  ]);
  const invariants = finalizeAccountingInvariants(input.tokenUsage.invariants, attributedUsageUnits, estimatedNanoUsd);
  const warnings = uniqueDefined([
    ...input.tokenUsage.warnings,
    ...modelSummaries.flatMap((summary) => summary.warnings),
    ...toolSummaries.flatMap((summary) => summary.warnings),
    ...spanSummaries.flatMap((summary) => summary.warnings)
  ]);
  const totalsCoverage = deriveAccountingCoverage(input.tokenUsage.coverage, pricingCoverage, toolSummaries, spanSummaries);

  return {
    accountingSchemaVersion: 1,
    sourceSelection: input.tokenUsage.sourceSelection ?? missingSourceSelection(),
    attributedUsageUnits,
    modelSummaries,
    toolSummaries,
    spanSummaries,
    totals: {
      inputTokens: input.tokenUsage.inputTokens,
      outputTokens: input.tokenUsage.outputTokens,
      cacheReadInputTokens: input.tokenUsage.cacheReadInputTokens,
      cacheCreationInputTokens: input.tokenUsage.cacheCreationInputTokens,
      cachedTokens: input.tokenUsage.cachedTokens,
      reasoningOutputTokens: input.tokenUsage.reasoningOutputTokens,
      totalTokens: input.tokenUsage.totalTokens,
      estimatedNanoUsd,
      pricingCoverage,
      coverage: totalsCoverage,
      warnings
    },
    pricingMatches,
    invariants,
    coverage: totalsCoverage,
    warnings
  };
}

function missingSourceSelection(): AccountingSourceSelection {
  return {
    selectedTokenUsageSource: "not_reported",
    corroboratingSources: [],
    dedupedRecordCount: 0,
    discardedOverlapReasons: []
  };
}

function buildAccountingModelSummaries(units: AttributedUsageUnit[]): AccountingModelSummary[] {
  const byModel = new Map<string, AttributedUsageUnit[]>();
  for (const unit of units.filter((candidate) => candidate.model)) {
    const key = modelProviderKey(unit.model!, unit.provider);
    byModel.set(key, [...(byModel.get(key) ?? []), unit]);
  }

  return [...byModel.entries()]
    .map(([, modelUnits]) => {
      const model = modelUnits[0].model!;
      const breakdown = finalizeTokenBreakdown(sumUsageUnits(modelUnits));
      const pricingCoverage = aggregateUnitPricingCoverage(modelUnits);
      return {
        model,
        provider: firstDefined(modelUnits.map((unit) => unit.provider)),
        attributionIds: modelUnits.map((unit) => unit.attributionId),
        estimatedNanoUsd: sumOptionalNanoUsd(modelUnits.map((unit) => unit.estimatedNanoUsd)),
        pricing: singlePricingMatch(modelUnits.map((unit) => unit.pricing)),
        pricingCoverage,
        coverage: aggregateAccountingCoverage(modelUnits.map((unit) => unit.coverage), pricingCoverage),
        warnings: uniqueDefined(modelUnits.flatMap((unit) => unit.warnings)),
        ...breakdown
      };
    })
    .sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0) || a.model.localeCompare(b.model) || (a.provider ?? "").localeCompare(b.provider ?? ""));
}

function modelProviderKey(model: string, provider?: string): string {
  return `${provider ?? ""}::${model}`;
}

function buildAccountingToolSummaries(
  trace: AssembledAgentTrace,
  units: AttributedUsageUnit[],
  tokenUsage: TokenUsage
): AccountingToolSummary[] {
  const toolCalls = collectToolCallMetadata(trace);
  if (toolCalls.length === 0) {
    return [];
  }

  const parentBySpanId = new Map(trace.spans.map((span) => [span.spanId, span.parentSpanId]));
  const toolKeyBySpanId = new Map<string, string>();
  for (const tool of toolCalls) {
    for (const spanId of tool.spanIds) {
      toolKeyBySpanId.set(spanId, tool.key);
    }
  }

  const unitsByToolKey = new Map<string, AttributedUsageUnit[]>();
  for (const unit of units) {
    const key = owningToolKeyForUnit(unit, parentBySpanId, toolKeyBySpanId);
    if (!key) {
      continue;
    }

    unitsByToolKey.set(key, [...(unitsByToolKey.get(key) ?? []), unit]);
  }

  return toolCalls.map((tool) => {
    const toolUnits = unitsByToolKey.get(tool.key) ?? [];
    const breakdown = finalizeTokenBreakdown(sumUsageUnits(toolUnits));
    const pricingCoverage = toolUnits.length > 0 ? aggregateUnitPricingCoverage(toolUnits) : undefined;
    const coverageReasons = new Set<AccountingCoverageReason>();
    const warnings = [...tool.warnings, ...toolUnits.flatMap((unit) => unit.warnings)];

    if (toolUnits.length === 0) {
      coverageReasons.add(tokenUsage.source === "not_reported" ? "source_not_reported" : "missing_tool_attribution");
      warnings.push(
        tokenUsage.source === "not_reported"
          ? "Tool token attribution is unavailable because token usage was not reported for this run."
          : "Selected token source could not attribute token usage to this tool call."
      );
    }

    for (const unit of toolUnits) {
      for (const reason of unit.coverage.reasons) {
        coverageReasons.add(reason);
      }
    }

    if (pricingCoverage) {
      for (const reason of pricingCoverage.reasons) {
        coverageReasons.add(reason);
      }
    }

    return {
      name: tool.name,
      count: tool.count,
      failures: tool.failures,
      totalDurationMs: tool.totalDurationMs,
      attributionIds: toolUnits.map((unit) => unit.attributionId),
      estimatedNanoUsd: sumOptionalNanoUsd(toolUnits.map((unit) => unit.estimatedNanoUsd)),
      pricing: singlePricingMatch(toolUnits.map((unit) => unit.pricing)),
      pricingCoverage,
      coverage: {
        state: accountingCoverageState(coverageReasons, pricingCoverage),
        reasons: [...coverageReasons]
      },
      warnings: uniqueDefined(warnings),
      ...breakdown
    };
  });
}

function collectToolCallMetadata(trace: AssembledAgentTrace): ToolCallMetadata[] {
  const summaries = new Map<string, ToolCallMetadata>();
  for (const span of trace.spans.filter((candidate) => isExecuteToolName(candidate.name))) {
    const name = extractToolName(span);
    const spanCallId = extractToolCallId(span);
    const key = spanCallId ? `call:${spanCallId}` : `span:${span.spanId}`;
    const current = summaries.get(key) ?? { key, name, count: 0, failures: 0, totalDurationMs: 0, spanIds: [], warnings: [] };
    current.count += 1;
    current.spanIds = uniqueDefined([...current.spanIds, span.spanId]);
    if (span.status === "STATUS_CODE_ERROR" || span.status === "ERROR") {
      current.failures += 1;
    }
    const durationMs = extractSpanDurationMs(span);
    if (durationMs != null) {
      current.totalDurationMs = (current.totalDurationMs ?? 0) + durationMs;
    }
    summaries.set(key, current);
  }

  for (const event of trace.events.filter((candidate) => candidate.name === "copilot_chat.tool.call")) {
    const name = typeof event.attributes["gen_ai.tool.name"] === "string" ? event.attributes["gen_ai.tool.name"] : "unknown";
    const eventCallId = extractToolCallId(event);
    const key = eventCallId ? `call:${eventCallId}` : `event:${event.traceId ?? ""}:${event.spanId ?? ""}:${event.timeUnixNano ?? ""}`;
    const current = summaries.get(key) ?? { key, name, count: 0, failures: 0, totalDurationMs: 0, spanIds: [], warnings: [] };
    current.count += 1;
    if (event.spanId) {
      current.spanIds = uniqueDefined([...current.spanIds, event.spanId]);
    }
    if (event.attributes.success === false) {
      current.failures += 1;
    }
    const durationMs = typeof event.attributes.duration_ms === "number" ? event.attributes.duration_ms : undefined;
    if (durationMs != null) {
      current.totalDurationMs = (current.totalDurationMs ?? 0) + durationMs;
    }
    summaries.set(key, current);
  }

  return [...summaries.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function owningToolKeyForUnit(
  unit: AttributedUsageUnit,
  parentBySpanId: Map<string, string | undefined>,
  toolKeyBySpanId: Map<string, string>
): string | undefined {
  let currentSpanId = unit.spanId;
  while (currentSpanId) {
    const toolKey = toolKeyBySpanId.get(currentSpanId);
    if (toolKey) {
      return toolKey;
    }

    currentSpanId = parentBySpanId.get(currentSpanId);
  }

  return undefined;
}

function buildSafeSpanSummaries(
  units: AttributedUsageUnit[],
  runPricingCoverage: PricingCoverageSummary
): SafeSpanAccountingSummary[] {
  return units.map((unit) => ({
    spanId: unit.spanId ?? unit.attributionId,
    parentSpanId: unit.parentSpanId,
    traceId: unit.traceId,
    queryId: unit.queryId,
    chatSessionId: unit.chatSessionId,
    kind: unit.spanKind ?? "unknown",
    name: unit.name,
    model: unit.model,
    provider: unit.provider,
    toolName: unit.toolName,
    attributionIds: [unit.attributionId],
    estimatedNanoUsd: unit.estimatedNanoUsd,
    pricing: unit.pricing,
    pricingCoverage: unit.pricingCoverage,
    coverage: aggregateAccountingCoverage([unit.coverage], unit.pricingCoverage ?? runPricingCoverage),
    warnings: uniqueDefined(unit.warnings),
    inputTokens: unit.inputTokens,
    outputTokens: unit.outputTokens,
    cacheReadInputTokens: unit.cacheReadInputTokens,
    cacheCreationInputTokens: unit.cacheCreationInputTokens,
    cachedTokens: unit.cachedTokens,
    reasoningOutputTokens: unit.reasoningOutputTokens,
    totalTokens: unit.totalTokens
  }));
}

function finalizeAccountingInvariants(
  invariants: AccountingInvariantResult[],
  units: AttributedUsageUnit[],
  estimatedNanoUsd?: number
): AccountingInvariantResult[] {
  const pricedNanoUsd = sumOptionalNanoUsd(units.map((unit) => unit.estimatedNanoUsd));

  return [
    ...invariants.filter((invariant) => invariant.name !== "priced_nano_usd_matches_run"),
    pricedNanoUsd == null && estimatedNanoUsd == null
      ? {
          name: "priced_nano_usd_matches_run",
          status: "not_applicable",
          message: "No attributed usage unit matched pricing for this run."
        }
      : pricedNanoUsd === estimatedNanoUsd
        ? {
            name: "priced_nano_usd_matches_run",
            status: "passed",
            expectedNanoUsd: estimatedNanoUsd,
            actualNanoUsd: pricedNanoUsd
          }
        : {
            name: "priced_nano_usd_matches_run",
            status: "failed",
            message: "Priced attributed-unit USD did not reconcile with the run estimate.",
            expectedNanoUsd: estimatedNanoUsd,
            actualNanoUsd: pricedNanoUsd
          }
  ];
}

function deriveAccountingCoverage(
  tokenCoverage: AccountingCoverage,
  pricingCoverage: PricingCoverageSummary,
  toolSummaries: AccountingToolSummary[],
  spanSummaries: SafeSpanAccountingSummary[]
): AccountingCoverage {
  const coverage = aggregateAccountingCoverage(
    [
      tokenCoverage,
      ...toolSummaries.map((summary) => summary.coverage),
      ...spanSummaries.map((summary) => summary.coverage)
    ],
    pricingCoverage
  );

  return {
    state: coverage.state,
    reasons: uniquePricingReasons(coverage.reasons)
  };
}

function aggregateAccountingCoverage(
  coverages: AccountingCoverage[],
  pricingCoverage?: PricingCoverageSummary
): AccountingCoverage {
  const reasons = new Set<AccountingCoverageReason>();
  for (const coverage of coverages) {
    for (const reason of coverage.reasons) {
      reasons.add(reason);
    }
  }

  if (pricingCoverage) {
    for (const reason of pricingCoverage.reasons) {
      reasons.add(reason);
    }
  }

  return {
    state: accountingCoverageState(reasons, pricingCoverage),
    reasons: [...reasons]
  };
}

function accountingCoverageState(
  reasons: Set<AccountingCoverageReason>,
  pricingCoverage?: PricingCoverageSummary
): AccountingCoverage["state"] {
  if (reasons.has("source_not_reported")) {
    return "unavailable";
  }

  if (pricingCoverage?.state === "partial" || pricingCoverage?.state === "unpriced") {
    return "partial";
  }

  return reasons.size > 0 ? "partial" : "complete";
}

function aggregateUnitPricingCoverage(units: AttributedUsageUnit[]): PricingCoverageSummary {
  const pricedModels = uniqueDefined(units.flatMap((unit) => unit.pricingCoverage?.pricedModels ?? []));
  const unpricedModels = uniqueDefined(units.flatMap((unit) => unit.pricingCoverage?.unpricedModels ?? []));
  const missingModelSlices = units.reduce((sum, unit) => sum + (unit.pricingCoverage?.missingModelSlices ?? 0), 0);
  const reasons = uniquePricingReasons(units.flatMap((unit) => unit.pricingCoverage?.reasons ?? []));
  const pricingVersions = uniqueDefined(units.flatMap((unit) => unit.pricingCoverage?.pricingVersions ?? []));
  const pricingEffectiveFrom = uniqueDefined(units.flatMap((unit) => unit.pricingCoverage?.pricingEffectiveFrom ?? []));
  const hasPriced = pricedModels.length > 0 || units.some((unit) => unit.pricingCoverage?.state === "priced" || unit.pricingCoverage?.state === "partial");
  const hasUnpriced = unpricedModels.length > 0 || missingModelSlices > 0 || units.some((unit) => unit.pricingCoverage?.state === "partial" || unit.pricingCoverage?.state === "unpriced");

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

function singlePricingMatch(matches: Array<PricingMatchMetadata | undefined>): PricingMatchMetadata | undefined {
  const defined = matches.filter((match): match is PricingMatchMetadata => match != null);
  if (defined.length === 0) {
    return undefined;
  }

  const [first] = defined;
  const allSame = defined.every((match) => pricingMatchKey(match) === pricingMatchKey(first));
  return allSame ? first : undefined;
}

function uniquePricingMatches(matches: PricingMatchMetadata[]): PricingMatchMetadata[] {
  const seen = new Set<string>();
  const unique: PricingMatchMetadata[] = [];
  for (const match of matches) {
    const key = pricingMatchKey(match);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(match);
  }
  return unique;
}

function pricingMatchKey(match: PricingMatchMetadata): string {
  return [
    match.billingContext ?? "",
    match.provider ?? "",
    match.model ?? "",
    match.matchedModel ?? "",
    match.pricingVersion,
    match.effectiveFrom ?? "",
    match.sourceUrl ?? ""
  ].join("::");
}

function modelUsagesFromAccounting(modelSummaries: AccountingModelSummary[]): ModelUsageSummary[] {
  return modelSummaries.map((summary) => ({
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
    notes: uniqueDefined([...summary.warnings, ...summary.coverage.reasons])
  }));
}

function toolsFromAccounting(toolSummaries: AccountingToolSummary[]): ToolSummary[] {
  return toolSummaries.map((summary) => ({
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
  }));
}

function deriveRunModels(
  accounting: AuthoritativeTraceAccounting,
  trace: AssembledAgentTrace,
  source: TokenUsage["source"]
): string[] {
  const accountingModels = uniqueDefined([
    ...accounting.modelSummaries.map((summary) => summary.model),
    ...(accounting.totals.pricingCoverage?.pricedModels ?? []),
    ...(accounting.totals.pricingCoverage?.unpricedModels ?? [])
  ]);

  if (accountingModels.length > 0 || source !== "not_reported") {
    return accountingModels;
  }

  return uniqueDefined(trace.spans.map(extractModel).concat(trace.events.map(extractModel)));
}

function deriveLlmCallCount(tokenUsage: TokenUsage, units: AttributedUsageUnit[]): number {
  if (tokenUsage.source === "invoke_agent" || tokenUsage.source === "metrics") {
    return units.length > 0 ? 1 : 0;
  }

  return units.filter((unit) => unit.kind === "model").length;
}

function priceModelUsages(
  modelUsages: ModelUsageSummary[],
  startedAt: string,
  costEstimation: CostEstimation
): ModelUsageSummary[] {
  return modelUsages.map((usage) => {
    const cost = costEstimation.estimateModelUsage({ usage, startedAt });
    return {
      ...usage,
      estimatedNanoUsd: cost.pricingCoverage.state === "unpriced" ? undefined : cost.estimatedNanoUsd,
      estimatedUsd: cost.pricingCoverage.state === "unpriced" ? undefined : cost.estimatedUsd,
      pricingVersion: cost.pricingCoverage.state === "unpriced" ? undefined : cost.pricingVersion,
      matchedModel: cost.pricingCoverage.state === "unpriced" ? undefined : cost.matchedModel,
      pricingCoverage: cost.pricingCoverage,
      notes: [...usage.notes, ...cost.notes]
    };
  });
}

function priceAttributedUsageUnits(
  units: AttributedUsageUnit[],
  startedAt: string,
  costEstimation: CostEstimation
): AttributedUsageUnit[] {
  return units.map((unit) => {
    const cost = costEstimation.estimateAttributedUnit({ unit, startedAt });
    return {
      ...unit,
      estimatedNanoUsd: cost.pricingCoverage.state === "unpriced" ? undefined : cost.estimatedNanoUsd,
      pricing: cost.pricingMatch,
      pricingCoverage: cost.pricingCoverage
    };
  });
}

function deriveRunPricingCoverage(
  tokenUsage: TokenUsage,
  pricedUsageUnits: AttributedUsageUnit[],
  modelUsages: ModelUsageSummary[]
): PricingCoverageSummary {
  const pricedModels = uniqueDefined(modelUsages.flatMap((usage) => usage.pricingCoverage?.pricedModels ?? []));
  const unpricedModels = uniqueDefined(modelUsages.flatMap((usage) => usage.pricingCoverage?.unpricedModels ?? []));
  const missingModelSlices = pricedUsageUnits.reduce((sum, unit) => sum + (unit.pricingCoverage?.missingModelSlices ?? 0), 0);
  const pricingVersions = uniqueDefined(modelUsages.flatMap((usage) => usage.pricingCoverage?.pricingVersions ?? []));
  const pricingEffectiveFrom = uniqueDefined(modelUsages.flatMap((usage) => usage.pricingCoverage?.pricingEffectiveFrom ?? []));
  const reasons = uniquePricingReasons([
    ...modelUsages.flatMap((usage) => usage.pricingCoverage?.reasons ?? []),
    ...pricedUsageUnits.flatMap((unit) => unit.pricingCoverage?.reasons ?? []),
    ...pricingReasonsFromTokenUsage(tokenUsage)
  ]);
  const hasPricedSlices = pricedModels.length > 0;
  const hasUnpricedSlices = unpricedModels.length > 0 || missingModelSlices > 0 || reasons.length > 0;

  return {
    state: hasPricedSlices ? (hasUnpricedSlices ? "partial" : "priced") : "unpriced",
    reasons,
    pricedModels,
    unpricedModels,
    missingModelSlices,
    pricingVersions,
    pricingEffectiveFrom
  };
}

function pricingReasonsFromTokenUsage(tokenUsage: TokenUsage): AccountingCoverageReason[] {
  const pricingRelevantReasons = new Set<AccountingCoverageReason>([
    "source_ambiguous",
    "model_not_reported",
    "missing_model_attribution",
    "metrics_only_trace",
    "event_only_trace",
    "invariant_failed"
  ]);

  return (tokenUsage.coverage.reasons ?? []).filter((reason) => pricingRelevantReasons.has(reason));
}

function uniquePricingReasons(values: AccountingCoverageReason[]): AccountingCoverageReason[] {
  return [...new Set(values)];
}

function deriveQueryId(trace: AssembledAgentTrace): string {
  return (trace as ActiveTrace).queryIdOverride ?? trace.rootSpan?.traceId ?? trace.traceId;
}

function deriveInitialQueryState(
  trace: ActiveTrace,
  fallbackStatus: AgenticQueryRun["status"]
): InitialQueryState {
  if (trace.initialQueryText?.trim()) {
    return "captured";
  }

  if (fallbackStatus === "running") {
    return "pending";
  }

  return "unavailable";
}

function deriveTraceRole(
  root: CanonicalSpanRecord | undefined,
  copilotSessionId?: string,
  traceChatSessionId?: string
): AgenticQueryRun["traceRole"] {
  if (!root) {
    return "unknown";
  }

  if (copilotSessionId != null && traceChatSessionId != null) {
    return copilotSessionId !== traceChatSessionId ? "helper" : "main";
  }

  return "unknown";
}

function allTraceRecords(trace: AssembledAgentTrace): CanonicalOtelRecord[] {
  return [...trace.spans, ...trace.events, ...trace.metrics];
}

function spanById(trace: AssembledAgentTrace): Map<string, CanonicalSpanRecord> {
  return new Map(trace.spans.map((span) => [span.spanId, span]));
}

function toolTokenUsage(trace: AssembledAgentTrace, toolSpan: CanonicalSpanRecord): TokenBreakdown {
  const ownUsage = tokensFromAttributes(toolSpan.attributes);
  const descendants = descendantSpans(trace, toolSpan.spanId);
  const childInvokeUsages = descendants
    .filter((span) => isInvokeAgentName(span.name))
    .map((span) => tokensFromAttributes(span.attributes))
    .filter(hasTokenData);
  const fallbackChatUsages = childInvokeUsages.length === 0
    ? descendants.filter((span) => isChatName(span.name)).map((span) => tokensFromAttributes(span.attributes)).filter(hasTokenData)
    : [];

  return finalizeTokenBreakdown(sumTokenUsage([ownUsage, ...childInvokeUsages, ...fallbackChatUsages]));
}

function descendantSpans(trace: AssembledAgentTrace, spanId: string): CanonicalSpanRecord[] {
  const byParent = new Map<string, CanonicalSpanRecord[]>();
  for (const span of trace.spans) {
    if (!span.parentSpanId) {
      continue;
    }
    byParent.set(span.parentSpanId, [...(byParent.get(span.parentSpanId) ?? []), span]);
  }

  const descendants: CanonicalSpanRecord[] = [];
  const queue = [...(byParent.get(spanId) ?? [])];
  while (queue.length > 0) {
    const span = queue.shift()!;
    descendants.push(span);
    queue.push(...(byParent.get(span.spanId) ?? []));
  }
  return descendants;
}

function mergeTokenBreakdown(target: ToolSummary, usage: TokenBreakdown): void {
  target.inputTokens = add(target.inputTokens, usage.inputTokens);
  target.outputTokens = add(target.outputTokens, usage.outputTokens);
  target.cacheReadInputTokens = add(target.cacheReadInputTokens, usage.cacheReadInputTokens);
  target.cacheCreationInputTokens = add(target.cacheCreationInputTokens, usage.cacheCreationInputTokens);
  target.reasoningOutputTokens = add(target.reasoningOutputTokens, usage.reasoningOutputTokens);
  target.cachedTokens = add(target.cachedTokens, usage.cachedTokens);
  target.totalTokens = add(target.totalTokens, usage.totalTokens);
}

function sumUsageUnits(units: AttributedUsageUnit[]): TokenBreakdown {
  return units.reduce<TokenBreakdown>((total, unit) => ({
    inputTokens: add(total.inputTokens, unit.inputTokens),
    outputTokens: add(total.outputTokens, unit.outputTokens),
    cacheReadInputTokens: add(total.cacheReadInputTokens, unit.cacheReadInputTokens),
    cacheCreationInputTokens: add(total.cacheCreationInputTokens, unit.cacheCreationInputTokens),
    cachedTokens: add(total.cachedTokens, unit.cachedTokens),
    reasoningOutputTokens: add(total.reasoningOutputTokens, unit.reasoningOutputTokens),
    totalTokens: add(total.totalTokens, unit.totalTokens)
  }), {});
}

function sumOptionalNanoUsd(values: Array<number | undefined>): number | undefined {
  const reported = values.filter((value): value is number => value != null);
  return reported.length === 0 ? undefined : reported.reduce((sum, value) => sum + value, 0);
}

function add(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function hasTokenData(usage: TokenBreakdown): boolean {
  return (
    usage.inputTokens != null ||
    usage.outputTokens != null ||
    usage.cacheReadInputTokens != null ||
    usage.cacheCreationInputTokens != null ||
    usage.reasoningOutputTokens != null ||
    usage.totalTokens != null
  );
}

function hasEventOnlyAgentRun(trace: AssembledAgentTrace): boolean {
  return trace.events.some((event) => event.name === "copilot_chat.session.start" || event.name === "copilot_chat.agent.turn");
}

function eventStartIso(trace: AssembledAgentTrace): string | undefined {
  const first = [...trace.events]
    .sort((a, b) => (a.timeUnixNano ?? "").localeCompare(b.timeUnixNano ?? ""))[0];
  return first ? unixNanoToIso(first.timeUnixNano) : undefined;
}

function eventEndIso(trace: AssembledAgentTrace): string | undefined {
  const last = [...trace.events]
    .sort((a, b) => (b.timeUnixNano ?? "").localeCompare(a.timeUnixNano ?? ""))[0];
  return last ? unixNanoToIso(last.timeUnixNano) : undefined;
}

function eventDurationMs(trace: AssembledAgentTrace): number | undefined {
  const timestamps = trace.events
    .map((event) => event.timeUnixNano)
    .filter((value): value is string => value != null)
    .sort();

  if (timestamps.length < 2) {
    return undefined;
  }

  const start = Number(timestamps[0]);
  const end = Number(timestamps[timestamps.length - 1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }

  return Math.round((end - start) / 1_000_000);
}

function inferMode(root?: CanonicalSpanRecord): AgenticQueryRun["mode"] {
  if (!root) {
    return "unknown";
  }
  const mode = root.attributes.mode ?? root.attributes["copilot.mode"] ?? root.attributes["agent.mode"];
  if (mode === "ask" || mode === "edit" || mode === "agent" || mode === "plan" || mode === "cli" || mode === "claude") {
    return mode;
  }
  return isInvokeAgentName(root.name) ? "agent" : "unknown";
}

function firstDefined(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value != null && value.trim() !== "");
}

function firstBillingContext(values: Array<BillingContextId | undefined>): BillingContextId | undefined {
  return values.find((value): value is BillingContextId => value != null);
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value != null && value.trim() !== ""))];
}

function compareTimestamp(a?: string, b?: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

function recordKey(record: CanonicalOtelRecord): string {
  if (record.kind === "span") {
    return `span:${record.traceId}:${record.spanId}:${record.endTimeUnixNano ?? ""}`;
  }
  if (record.kind === "event") {
    return `event:${record.traceId ?? ""}:${record.spanId ?? ""}:${record.name}:${record.timeUnixNano ?? ""}:${stableRecordValue(record.attributes)}`;
  }
  return `metric:${record.traceId ?? ""}:${record.spanId ?? ""}:${record.name}:${record.timeUnixNano ?? ""}:${record.value ?? ""}`;
}

function stableRecordValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableRecordValue).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableRecordValue(child)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

export function sortForTraceAssembly(records: CanonicalOtelRecord[]): CanonicalOtelRecord[] {
  return [...records].sort((a, b) => {
    const aIsTerminalRoot = a.kind === "span" && isInvokeAgentName(a.name) && isTerminalSpan(a);
    const bIsTerminalRoot = b.kind === "span" && isInvokeAgentName(b.name) && isTerminalSpan(b);
    if (aIsTerminalRoot && bIsTerminalRoot) {
      return (recordTimestamp(b) ?? "").localeCompare(recordTimestamp(a) ?? "");
    }
    if (aIsTerminalRoot !== bIsTerminalRoot) {
      return aIsTerminalRoot ? 1 : -1;
    }
    return (recordTimestamp(a) ?? "").localeCompare(recordTimestamp(b) ?? "");
  });
}
