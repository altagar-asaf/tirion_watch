import {
  AccountingCoverage,
  AccountingCoverageReason,
  AccountingInvariantResult,
  AccountingSourceSelection,
  AssembledAgentTrace,
  AttributedUsageUnit,
  CanonicalEventRecord,
  CanonicalMetricRecord,
  CanonicalOtelRecord,
  CanonicalSpanRecord,
  inferProviderFromModel,
  ModelUsageSummary,
  normalizeProvider,
  SelectedTokenUsageSource,
  TokenBreakdown,
  TokenMeasurement,
  TokenUsage
} from "../types";
import { toNumber } from "../normalization/otelValues";
import {
  extractConversationId,
  extractModel,
  extractProvider,
  extractTurnId,
  isChatName,
  isInvokeAgentName,
  recordTimestamp
} from "./otelSemantics";

type TokenUsageDraft = TokenBreakdown;
type SourceCandidate = {
  source: SelectedTokenUsageSource;
  units: AttributedUsageUnit[];
  warnings: string[];
  discardedOverlapReasons: AccountingCoverageReason[];
};

type ModelUsageSelection = {
  modelUsages: ModelUsageSummary[];
  coverage: AccountingCoverage;
  warnings: string[];
};

function enrichSelectedReasoning(
  selected: SourceCandidate | undefined,
  candidates: SourceCandidate[]
): SourceCandidate | undefined {
  if (!selected || selected.source !== "invoke_agent" || selected.units.length !== 1) {
    return selected;
  }

  if (selected.units[0].reasoningOutputTokens != null) {
    return selected;
  }

  const chatCandidate = candidates.find((candidate) => candidate.source === "chat_spans");
  if (!chatCandidate) {
    return selected;
  }

  const selectedBreakdown = finalizeTokenBreakdown(sumUsageUnits(selected.units));
  const chatBreakdown = finalizeTokenBreakdown(sumUsageUnits(chatCandidate.units));
  if (chatBreakdown.reasoningOutputTokens == null) {
    return selected;
  }

  // Only borrow the reasoning subset when corroborating chat spans reconcile to
  // the same invoke_agent input/output totals; otherwise the lower-priority data
  // may describe a different slice of the trace.
  if (
    !matchingBreakdownValue(selectedBreakdown.inputTokens, chatBreakdown.inputTokens)
    || !matchingBreakdownValue(selectedBreakdown.outputTokens, chatBreakdown.outputTokens)
  ) {
    return selected;
  }

  const selectedModel = selected.units[0].model;
  const chatModels = uniqueDefined(chatCandidate.units.map((unit) => unit.model));
  if (chatModels.length > 1) {
    return selected;
  }

  if (selectedModel && chatModels.length === 1 && chatModels[0] !== selectedModel) {
    return selected;
  }

  return {
    ...selected,
    units: [{
      ...selected.units[0],
      reasoningOutputTokens: chatBreakdown.reasoningOutputTokens
    }]
  };
}

export class DefaultTokenMeasurement implements TokenMeasurement {
  measure(runTrace: AssembledAgentTrace): TokenUsage {
    const candidates = classifySourceCandidates(runTrace);
    const selected = enrichSelectedReasoning(candidates[0], candidates);

    if (!selected) {
      return missingTokenUsage(runTrace);
    }

    const breakdown = finalizeTokenBreakdown(sumUsageUnits(selected.units));
    const warnings = [...selected.warnings];
    const cachedTokenMismatch =
      breakdown.cachedTokens != null
      && breakdown.inputTokens != null
      && breakdown.cachedTokens > breakdown.inputTokens;

    if (cachedTokenMismatch) {
      warnings.push("Cached input tokens exceed input tokens; treating cached tokens as reported metadata only.");
    }

    const modelSelection = selectedModelUsages(selected.units);
    warnings.push(...modelSelection.warnings);

    const invariants = buildInvariants(breakdown, selected.units, modelSelection);
    const coverage = deriveCoverage(
      runTrace,
      selected.source,
      modelSelection.coverage,
      invariants,
      selected.discardedOverlapReasons,
      cachedTokenMismatch
    );

    return {
      ...breakdown,
      source: selected.source,
      sourceSelection: buildSourceSelection(selected, candidates),
      attributedUsageUnits: selected.units,
      modelUsages: modelSelection.modelUsages,
      coverage,
      invariants,
      warnings: uniqueStrings(warnings)
    };
  }
}

export function tokensFromAttributes(attributes: Record<string, unknown>): TokenUsageDraft {
  return {
    inputTokens: numberFromAny(attributes, [
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.prompt_tokens",
      "llm.usage.prompt_tokens",
      "input_tokens",
      "prompt_tokens"
    ]),
    outputTokens: numberFromAny(attributes, [
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.completion_tokens",
      "llm.usage.completion_tokens",
      "output_tokens",
      "completion_tokens"
    ]),
    cacheReadInputTokens: numberFromAny(attributes, [
      "gen_ai.usage.cache_read.input_tokens",
      "gen_ai.usage.cached_tokens",
      "cache_read_input_tokens",
      "cached_tokens"
    ]),
    cacheCreationInputTokens: numberFromAny(attributes, [
      "gen_ai.usage.cache_creation.input_tokens",
      "cache_creation_input_tokens"
    ]),
    reasoningOutputTokens: numberFromAny(attributes, [
      "gen_ai.usage.reasoning.output_tokens",
      "reasoning_output_tokens"
    ])
  };
}

function tokensFromMetrics(metrics: CanonicalMetricRecord[]): TokenUsageDraft {
  const usageMetrics = metrics.filter((metric) => metric.name === "gen_ai.client.token.usage");
  const usages = usageMetrics.map((metric) => {
    const tokenType = String(metric.attributes["gen_ai.token.type"] ?? metric.attributes.type ?? "").toLowerCase();
    if (tokenType.includes("input") || tokenType.includes("prompt")) {
      return { inputTokens: metric.value };
    }
    if (tokenType.includes("output") || tokenType.includes("completion")) {
      return { outputTokens: metric.value };
    }
    if (tokenType.includes("cache")) {
      return { cacheReadInputTokens: metric.value };
    }
    return {};
  });
  return sumTokenUsage(usages);
}

function numberFromAny(attributes: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = toNumber(attributes[key]);
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

export function sumTokenUsage(usages: TokenUsageDraft[]): TokenUsageDraft {
  return usages.reduce<TokenUsageDraft>((acc, usage) => ({
    inputTokens: add(acc.inputTokens, usage.inputTokens),
    outputTokens: add(acc.outputTokens, usage.outputTokens),
    cacheReadInputTokens: add(acc.cacheReadInputTokens, usage.cacheReadInputTokens),
    cacheCreationInputTokens: add(acc.cacheCreationInputTokens, usage.cacheCreationInputTokens),
    reasoningOutputTokens: add(acc.reasoningOutputTokens, usage.reasoningOutputTokens)
  }), {});
}

export function finalizeTokenBreakdown(usage: TokenUsageDraft): TokenBreakdown {
  const cachedTokens = add(usage.cacheReadInputTokens, usage.cacheCreationInputTokens);
  const totalTokens = add(usage.inputTokens, usage.outputTokens);

  return {
    ...usage,
    cachedTokens,
    totalTokens
  };
}

function add(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function recordsWithTokenUsage<T extends CanonicalOtelRecord>(records: T[]): T[] {
  return records.filter((record) => hasTokenData(tokensFromAttributes(record.attributes)));
}

function hasTokenData(usage: TokenUsageDraft): boolean {
  return (
    usage.inputTokens != null ||
    usage.outputTokens != null ||
    usage.cacheReadInputTokens != null ||
    usage.cacheCreationInputTokens != null ||
    usage.reasoningOutputTokens != null
  );
}

function classifySourceCandidates(runTrace: AssembledAgentTrace): SourceCandidate[] {
  return [
    invokeAgentCandidate(runTrace),
    chatSpanCandidate(runTrace),
    eventCandidate(runTrace),
    metricsCandidate(runTrace)
  ].filter((candidate): candidate is SourceCandidate => candidate != null);
}

function invokeAgentCandidate(runTrace: AssembledAgentTrace): SourceCandidate | undefined {
  if (!runTrace.rootSpan) {
    return undefined;
  }

  const usage = tokensFromAttributes(runTrace.rootSpan.attributes);
  if (!hasTokenData(usage)) {
    return undefined;
  }

  const unit = createUsageUnit({
    source: "invoke_agent",
    record: runTrace.rootSpan,
    usage,
    attributionId: `trace:${runTrace.traceId}:invoke_agent:${runTrace.rootSpan.spanId}`,
    kind: "trace",
    spanKind: "root",
    name: runTrace.rootSpan.name,
    model: extractModel(runTrace.rootSpan),
    warnings: []
  });

  return {
    source: "invoke_agent",
    units: [unit],
    warnings: unit.warnings,
    discardedOverlapReasons: []
  };
}

function chatSpanCandidate(runTrace: AssembledAgentTrace): SourceCandidate | undefined {
  const chatRecords = recordsWithTokenUsage(runTrace.spans.filter((span) => isChatName(span.name)));
  if (chatRecords.length === 0) {
    return undefined;
  }

  const units = chatRecords.map((record) => createUsageUnit({
    source: "chat_spans",
    record,
    usage: tokensFromAttributes(record.attributes),
    attributionId: `span:${runTrace.traceId}:${record.spanId}`,
    kind: "model",
    spanKind: "llm",
    name: record.name,
    model: extractModel(record),
    warnings: []
  }));

  return {
    source: "chat_spans",
    units,
    warnings: units.flatMap((unit) => unit.warnings),
    discardedOverlapReasons: []
  };
}

function eventCandidate(runTrace: AssembledAgentTrace): SourceCandidate | undefined {
  const events = recordsWithTokenUsage(runTrace.events.filter(isEventTokenRecord));
  if (events.length === 0) {
    return undefined;
  }

  const byKey = new Map<string, CanonicalEventRecord[]>();
  for (const event of events) {
    const key = eventAttributionKey(event);
    byKey.set(key, [...(byKey.get(key) ?? []), event]);
  }

  const discardedOverlapReasons = new Set<AccountingCoverageReason>();
  const warnings: string[] = [];
  const units = [...byKey.entries()].map(([key, records]) => {
    const preferred = [...records].sort((a, b) => eventCompletenessScore(b) - eventCompletenessScore(a))[0];
    const discarded = records.filter((record) => record !== preferred);
    const preferredUsage = tokensFromAttributes(preferred.attributes);
    const hasConflictingTokens = discarded.some((record) => !sameUsage(preferredUsage, tokensFromAttributes(record.attributes)));
    const modelNames = uniqueDefined(records.map(extractModel));
    const extraCoverageReasons: AccountingCoverageReason[] = [];
    const unitWarnings: string[] = [];

    if (discarded.length > 0) {
      discardedOverlapReasons.add("duplicate_overlap_discarded");
      unitWarnings.push("Discarded overlapping event token records while deduplicating event-derived call units.");
    }

    if (hasConflictingTokens || modelNames.length > 1) {
      discardedOverlapReasons.add("source_ambiguous");
      extraCoverageReasons.push("source_ambiguous");
      unitWarnings.push("Overlapping event token records disagreed; selected the most complete event record for attribution.");
    }

    const unit = createUsageUnit({
      source: "events",
      record: preferred,
      usage: preferredUsage,
      attributionId: `event:${runTrace.traceId}:${key}`,
      kind: "model",
      spanKind: "event",
      name: preferred.name,
      model: extractModel(preferred),
      discardedRecordKeys: discarded.map(canonicalRecordKey),
      warnings: unitWarnings,
      extraCoverageReasons
    });

    warnings.push(...unitWarnings);
    return unit;
  });

  return {
    source: "events",
    units,
    warnings,
    discardedOverlapReasons: [...discardedOverlapReasons]
  };
}

function metricsCandidate(runTrace: AssembledAgentTrace): SourceCandidate | undefined {
  const usageMetrics = runTrace.metrics.filter((metric) => metric.name === "gen_ai.client.token.usage");
  const usage = tokensFromMetrics(usageMetrics);
  if (!hasTokenData(usage)) {
    return undefined;
  }

  const unit = createUsageUnit({
    source: "metrics",
    usage,
    attributionId: `metric:${runTrace.traceId}:gen_ai.client.token.usage`,
    kind: "trace",
    spanKind: "metric",
    name: "gen_ai.client.token.usage",
    traceId: runTrace.traceId,
    recordKeys: usageMetrics.map(canonicalRecordKey),
    warnings: ["Metric token usage may be aggregate telemetry when trace correlation is incomplete."],
    extraCoverageReasons: ["metrics_only_trace"]
  });

  return {
    source: "metrics",
    units: [unit],
    warnings: unit.warnings,
    discardedOverlapReasons: []
  };
}

function missingTokenUsage(runTrace: AssembledAgentTrace): TokenUsage {
  const warnings: string[] = [];
  if (runTrace.spans.some((span) => isInvokeAgentName(span.name) || isChatName(span.name))) {
    warnings.push("Token usage was not reported in Copilot telemetry for this run.");
  }

  return {
    source: "not_reported",
    attributedUsageUnits: [],
    modelUsages: [],
    coverage: {
      state: "unavailable",
      reasons: ["source_not_reported"]
    },
    invariants: [],
    warnings
  };
}

function buildSourceSelection(
  selected: SourceCandidate,
  candidates: SourceCandidate[]
): AccountingSourceSelection {
  return {
    selectedTokenUsageSource: selected.source,
    corroboratingSources: candidates
      .filter((candidate) => candidate.source !== selected.source)
      .map((candidate) => candidate.source),
    dedupedRecordCount: selected.units.reduce((sum, unit) => sum + unit.discardedRecordKeys.length, 0),
    discardedOverlapReasons: uniqueCoverageReasons(selected.discardedOverlapReasons)
  };
}

function sumUsageUnits(units: AttributedUsageUnit[]): TokenUsageDraft {
  return sumTokenUsage(units.map((unit) => ({
    inputTokens: unit.inputTokens,
    outputTokens: unit.outputTokens,
    cacheReadInputTokens: unit.cacheReadInputTokens,
    cacheCreationInputTokens: unit.cacheCreationInputTokens,
    reasoningOutputTokens: unit.reasoningOutputTokens
  })));
}

function selectedModelUsages(units: AttributedUsageUnit[]): ModelUsageSelection {
  const tokenUnits = units.filter((unit) => hasTokenData(unit));
  if (tokenUnits.length === 0) {
    return {
      modelUsages: [],
      coverage: { state: "complete", reasons: [] },
      warnings: []
    };
  }

  if (tokenUnits.some((unit) => !unit.model)) {
    return {
      modelUsages: [],
      coverage: { state: "partial", reasons: ["missing_model_attribution"] },
      warnings: ["Per-model token usage is unavailable because the selected token source did not report a model for every attributed unit."]
    };
  }

  const byModel = new Map<string, TokenUsageDraft & { model: string; provider?: string }>();
  for (const unit of tokenUnits) {
    const provider = normalizeProvider(unit.provider) ?? inferProviderFromModel(unit.model);
    const key = modelProviderKey(unit.model!, provider);
    byModel.set(key, {
      model: unit.model!,
      provider,
      ...sumTokenUsage([byModel.get(key) ?? {}, unit])
    });
  }

  return {
    modelUsages: [...byModel.values()]
      .map((usage) => ({
        model: usage.model,
        provider: usage.provider,
        ...finalizeTokenBreakdown(usage),
        notes: []
      }))
      .sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0) || a.model.localeCompare(b.model) || (a.provider ?? "").localeCompare(b.provider ?? "")),
    coverage: { state: "complete", reasons: [] },
    warnings: []
  };
}

function buildInvariants(
  totals: TokenBreakdown,
  units: AttributedUsageUnit[],
  modelSelection: ModelUsageSelection
): AccountingInvariantResult[] {
  const attributedTotals = finalizeTokenBreakdown(sumUsageUnits(units));

  return [
    tokenInvariant("attributed_input_matches_run", "inputTokens", totals.inputTokens, attributedTotals.inputTokens),
    tokenInvariant("attributed_output_matches_run", "outputTokens", totals.outputTokens, attributedTotals.outputTokens),
    tokenInvariant("attributed_total_matches_run", "totalTokens", totals.totalTokens, attributedTotals.totalTokens),
    modelInvariant(totals, modelSelection),
    {
      name: "tool_totals_match_run",
      status: "not_applicable",
      message: "Tool attribution is computed outside TokenMeasurement."
    },
    {
      name: "priced_nano_usd_matches_run",
      status: "not_applicable",
      message: "Pricing is applied after TokenMeasurement."
    }
  ];
}

function tokenInvariant(
  name: AccountingInvariantResult["name"],
  field: keyof TokenBreakdown,
  expected?: number,
  actual?: number
): AccountingInvariantResult {
  const expectedBreakdown = { [field]: expected } as TokenBreakdown;
  const actualBreakdown = { [field]: actual } as TokenBreakdown;

  if (matchingBreakdownValue(expected, actual)) {
    return {
      name,
      status: "passed",
      expected: expectedBreakdown,
      actual: actualBreakdown
    };
  }

  return {
    name,
    status: "failed",
    message: `Expected ${field} ${expected ?? "n/a"} but measured ${actual ?? "n/a"}.`,
    expected: expectedBreakdown,
    actual: actualBreakdown
  };
}

function modelInvariant(
  totals: TokenBreakdown,
  modelSelection: ModelUsageSelection
): AccountingInvariantResult {
  if (modelSelection.coverage.state !== "complete") {
    return {
      name: "model_totals_match_run",
      status: "not_applicable",
      message: "Per-model attribution was not fully reported by the selected token source."
    };
  }

  const modelTotals = finalizeTokenBreakdown(sumTokenUsage(modelSelection.modelUsages));
  const passed = matchingBreakdownValue(totals.inputTokens, modelTotals.inputTokens)
    && matchingBreakdownValue(totals.outputTokens, modelTotals.outputTokens)
    && matchingBreakdownValue(totals.totalTokens, modelTotals.totalTokens);

  if (passed) {
    return {
      name: "model_totals_match_run",
      status: "passed",
      expected: totals,
      actual: modelTotals
    };
  }

  return {
    name: "model_totals_match_run",
    status: "failed",
    message: "Per-model totals did not reconcile with the selected run totals.",
    expected: totals,
    actual: modelTotals
  };
}

function deriveCoverage(
  runTrace: AssembledAgentTrace,
  source: SelectedTokenUsageSource,
  modelCoverage: AccountingCoverage,
  invariants: AccountingInvariantResult[],
  discardedOverlapReasons: AccountingCoverageReason[],
  cachedTokenMismatch: boolean
): AccountingCoverage {
  const reasons = new Set<AccountingCoverageReason>(discardedOverlapReasons);

  for (const reason of modelCoverage.reasons) {
    reasons.add(reason);
  }

  if (source === "metrics") {
    reasons.add("metrics_only_trace");
  }

  if (source === "events" && !runTrace.rootSpan && runTrace.spans.length === 0) {
    reasons.add("event_only_trace");
  }

  if (cachedTokenMismatch || invariants.some((invariant) => invariant.status === "failed")) {
    reasons.add("invariant_failed");
  }

  return {
    state: coverageStateFromReasons(reasons),
    reasons: [...reasons]
  };
}

function coverageStateFromReasons(reasons: Set<AccountingCoverageReason>): AccountingCoverage["state"] {
  if (reasons.has("source_not_reported")) {
    return "unavailable";
  }

  const partialReasons: AccountingCoverageReason[] = [
    "source_ambiguous",
    "model_not_reported",
    "missing_model_attribution",
    "missing_tool_attribution",
    "metrics_only_trace",
    "span_cost_unavailable",
    "invariant_failed"
  ];

  return partialReasons.some((reason) => reasons.has(reason)) ? "partial" : "complete";
}

function createUsageUnit(input: {
  source: SelectedTokenUsageSource;
  usage: TokenUsageDraft;
  attributionId: string;
  name: string;
  kind: AttributedUsageUnit["kind"];
  spanKind: AttributedUsageUnit["spanKind"];
  record?: CanonicalOtelRecord;
  traceId?: string;
  model?: string;
  recordKeys?: string[];
  discardedRecordKeys?: string[];
  warnings: string[];
  extraCoverageReasons?: AccountingCoverageReason[];
}): AttributedUsageUnit {
  const breakdown = finalizeTokenBreakdown(input.usage);
  const reasons = new Set<AccountingCoverageReason>(input.extraCoverageReasons ?? []);

  if (!input.model) {
    reasons.add("missing_model_attribution");
  }

  if (input.source === "metrics") {
    reasons.add("metrics_only_trace");
  }

  return {
    attributionId: input.attributionId,
    kind: input.kind,
    name: input.name,
    traceId: input.traceId ?? input.record?.traceId ?? "unknown",
    spanId: input.record?.kind === "metric" ? input.record.spanId : input.record?.spanId,
    parentSpanId: input.record?.kind === "span" ? input.record.parentSpanId : undefined,
    spanKind: input.spanKind,
    model: input.model,
    provider: extractProvider(input.record ?? fallbackRecord(input.traceId, input.model)) ?? inferProviderFromModel(input.model),
    tokenUsageSource: input.source,
    recordKeys: input.recordKeys ?? (input.record ? [canonicalRecordKey(input.record)] : []),
    discardedRecordKeys: input.discardedRecordKeys ?? [],
    coverage: {
      state: coverageStateFromReasons(reasons),
      reasons: [...reasons]
    },
    warnings: input.warnings,
    ...breakdown
  };
}

function isEventTokenRecord(event: CanonicalEventRecord): boolean {
  return event.name === "copilot_chat.agent.turn" || event.name === "gen_ai.client.inference.operation.details";
}

function eventAttributionKey(event: CanonicalEventRecord): string {
  const conversationId = extractConversationId(event);
  const turnId = extractTurnId(event);
  if (conversationId || turnId) {
    return `turn:${conversationId ?? "unknown"}:${turnId ?? event.spanId ?? "unknown"}`;
  }

  const usage = tokensFromAttributes(event.attributes);
  return [
    event.spanId ?? "no-span",
    usage.inputTokens ?? "na",
    usage.outputTokens ?? "na",
    usage.cacheReadInputTokens ?? "na",
    usage.cacheCreationInputTokens ?? "na",
    usage.reasoningOutputTokens ?? "na"
  ].join(":");
}

function eventCompletenessScore(event: CanonicalEventRecord): number {
  const usage = tokensFromAttributes(event.attributes);
  return countDefinedTokenFields(usage) * 10
    + (extractModel(event) ? 100 : 0)
    + (event.name === "copilot_chat.agent.turn" ? 1 : 0);
}

function countDefinedTokenFields(usage: TokenUsageDraft): number {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
    usage.reasoningOutputTokens
  ].filter((value) => value != null).length;
}

function canonicalRecordKey(record: CanonicalOtelRecord): string {
  return [
    record.kind,
    record.traceId ?? "no-trace",
    record.kind === "span" ? record.spanId : record.spanId ?? "no-span",
    record.name,
    recordTimestamp(record) ?? "no-time"
  ].join(":");
}

function sameUsage(a: TokenUsageDraft, b: TokenUsageDraft): boolean {
  return matchingBreakdownValue(a.inputTokens, b.inputTokens)
    && matchingBreakdownValue(a.outputTokens, b.outputTokens)
    && matchingBreakdownValue(a.cacheReadInputTokens, b.cacheReadInputTokens)
    && matchingBreakdownValue(a.cacheCreationInputTokens, b.cacheCreationInputTokens)
    && matchingBreakdownValue(a.reasoningOutputTokens, b.reasoningOutputTokens);
}

function matchingBreakdownValue(expected?: number, actual?: number): boolean {
  if (expected == null && actual == null) {
    return true;
  }

  if (expected == null || actual == null) {
    return false;
  }

  return expected === actual;
}

function modelProviderKey(model: string, provider?: string): string {
  return `${provider ?? ""}::${model}`;
}

function fallbackRecord(traceId: string | undefined, model?: string): CanonicalOtelRecord {
  return {
    kind: "event",
    traceId,
    name: "provider_inference",
    attributes: model ? { "gen_ai.request.model": model } : {},
    resourceAttributes: {}
  };
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value != null && value.trim() !== ""))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function uniqueCoverageReasons(values: AccountingCoverageReason[]): AccountingCoverageReason[] {
  return [...new Set(values)];
}
