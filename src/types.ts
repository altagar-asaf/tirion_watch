export type CopilotOtelState =
  | {
      kind: "ready";
      outfile?: string;
      spanDbPath?: string;
      captureContent: boolean;
      dbSpanExporter: boolean;
      exporterType?: string;
      endpoint?: string;
      sourceMode: "file" | "spanDb" | "mixed";
    }
  | { kind: "disabled" }
  | {
      kind: "configuredElsewhere";
      exporterType?: string;
      endpoint?: string;
      outfile?: string;
      spanDbPath?: string;
      captureContent?: boolean;
      dbSpanExporter?: boolean;
    }
  | { kind: "unsupported" };

export type CopilotAgentOtlpConfiguration =
  | { kind: "ready"; endpoint: string }
  | { kind: "conflict"; endpoint?: string; exporterType?: string }
  | { kind: "unsupported" };

export type CopilotAgentOtlpRestoration =
  | { kind: "restored" }
  | { kind: "notManaged" }
  | { kind: "conflict" };

export type TelemetryIngestionMode = "auto" | "spanDb" | "file";

type CheckPublicationIntentV1 = {
  schemaVersion: 1;
  owner: string;
  repository: string;
  commitSha: string;
  publicationVersion: number;
};

export type BillingContextId = "github-copilot" | "openai-direct" | "anthropic-direct" | "cursor";

export type BillingUnit = "aiCredits" | "usd";

export type TelemetryIngestionSource = {
  mode?: TelemetryIngestionMode;
  outfile?: string;
  spanDbPath?: string;
};

export type IngestionCheckpoint = {
  source?: "jsonl" | "spanDb" | "composite";
  outfile?: string;
  spanDbPath?: string;
  spanDbAvailable?: boolean;
  offset: number;
  partialLineLength: number;
  lastReadAt?: string;
  lastLineAt?: string;
  lastSpanAt?: string;
  spanDbLastStartTimeMs?: number;
  spanDbSeenSpanCount?: number;
  spanDbError?: string;
  malformedLineCount: number;
  children?: IngestionCheckpoint[];
};

export type CanonicalOtelRecord =
  | CanonicalSpanRecord
  | CanonicalMetricRecord
  | CanonicalEventRecord;

export type CanonicalSpanRecord = {
  kind: "span";
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  status?: string;
};

export type CanonicalEventRecord = {
  kind: "event";
  traceId?: string;
  spanId?: string;
  name: string;
  timeUnixNano?: string;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
};

export type CanonicalMetricRecord = {
  kind: "metric";
  name: string;
  traceId?: string;
  spanId?: string;
  timeUnixNano?: string;
  value?: number;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
};

export type TokenUsageSource =
  | "invoke_agent"
  | "chat_spans"
  | "events"
  | "metrics"
  | "not_reported"
  | "legacy";

export type SelectedTokenUsageSource = Exclude<TokenUsageSource, "legacy">;

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cachedTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  source: TokenUsageSource;
  sourceSelection?: AccountingSourceSelection;
  attributedUsageUnits: AttributedUsageUnit[];
  modelUsages: ModelUsageSummary[];
  coverage: AccountingCoverage;
  invariants: AccountingInvariantResult[];
  warnings: string[];
};

export type ModelPricing = {
  provider?: string;
  modelPattern: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheCreationUsdPerMillion?: number;
  reasoningOutputUsdPerMillion?: number;
  minInputTokens?: number;
  maxInputTokens?: number;
  longContextInputThreshold?: number;
  longContextNote?: string;
  effectiveFrom: string;
  pricingVersion?: string;
  sourceUrl?: string;
  notes?: string;
};

export type PricingCatalog = {
  billingContext: BillingContextId;
  primaryBillingUnit: BillingUnit;
  pricingVersions: string[];
  pricingTable: ModelPricing[];
};

export type BillingContextResolution = {
  billingContext: BillingContextId;
  primaryBillingUnit: BillingUnit;
  pricingCatalog: PricingCatalog;
};

export function normalizeProvider(provider?: string): string | undefined {
  if (!provider) {
    return undefined;
  }

  const normalized = provider.trim().toLowerCase();
  return normalized === "" ? undefined : normalized;
}

export function inferProviderFromModel(model?: string): string | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = model.trim().toLowerCase();
  if (normalized === "") {
    return undefined;
  }

  if (normalized.includes("claude") || normalized.includes("anthropic")) {
    return "anthropic";
  }
  if (normalized.includes("gemini") || normalized.includes("google")) {
    return "google";
  }
  if (normalized.includes("mai-code") || normalized.includes("microsoft")) {
    return "microsoft";
  }
  if (normalized.includes("raptor") || normalized.includes("github")) {
    return "github";
  }
  if (/^(?:cursor[./:-])?(?:auto|composer)(?:[ ./:-]|$)/.test(normalized)) {
    return "cursor";
  }
  if (
    normalized.startsWith("gpt-")
    || normalized.startsWith("gpt ")
    || normalized.startsWith("o3")
    || normalized.startsWith("o4")
    || normalized === "chat-latest"
    || normalized.includes("openai")
  ) {
    return "openai";
  }

  return undefined;
}

export type NanoUsd = number;

export const NANO_USD_PER_USD = 1_000_000_000;
export const NANO_USD_PER_AI_CREDIT = 10_000_000;

export function nanoUsdFromUsd(usd?: number): NanoUsd | undefined {
  return usd == null ? undefined : Math.round(usd * NANO_USD_PER_USD);
}

export function usdFromNanoUsd(nanoUsd?: NanoUsd): number | undefined {
  return nanoUsd == null ? undefined : nanoUsd / NANO_USD_PER_USD;
}

export function aiCreditsFromNanoUsd(nanoUsd?: NanoUsd): number | undefined {
  return nanoUsd == null ? undefined : nanoUsd / NANO_USD_PER_AI_CREDIT;
}

export type CostEstimate = {
  billingContext?: BillingContextId;
  estimatedNanoUsd: NanoUsd;
  estimatedUsd: number;
  estimatedAiCredits: number;
  pricingVersion: string;
  matchedModel: string;
  pricingMatch?: PricingMatchMetadata;
  pricingCoverage: PricingCoverageSummary;
  notes: string[];
};

export type CostCoverage = "complete" | "partial" | "unavailable";

export type CostLabel = "All estimated" | "Priced models only" | "Partial estimate" | "Unavailable";

export type AccountingCoverageReason =
  | "source_not_reported"
  | "source_ambiguous"
  | "duplicate_overlap_discarded"
  | "model_not_reported"
  | "model_unpriced"
  | "pricing_rate_missing"
  | "long_context_rate_unpublished"
  | "missing_model_attribution"
  | "missing_tool_attribution"
  | "span_cost_unavailable"
  | "metrics_only_trace"
  | "event_only_trace"
  | "legacy_schema"
  | "invariant_failed"
  | "tool_call_id_missing"
  | "not_applicable";

export type AccountingCoverage = {
  state: CostCoverage;
  reasons: AccountingCoverageReason[];
};

export type PricingMatchMetadata = {
  billingContext?: BillingContextId;
  provider?: string;
  model?: string;
  matchedModel?: string;
  pricingVersion: string;
  effectiveFrom?: string;
  sourceUrl?: string;
  notes: string[];
};

export type PricingCoverageState = "priced" | "partial" | "unpriced";

export type PricingCoverageSummary = {
  state: PricingCoverageState;
  reasons: AccountingCoverageReason[];
  pricedModels: string[];
  unpricedModels: string[];
  missingModelSlices: number;
  pricingVersions: string[];
  pricingEffectiveFrom: string[];
};

export function costCoverageFromPricingCoverage(pricingCoverage?: PricingCoverageSummary): CostCoverage {
  switch (pricingCoverage?.state) {
    case "priced":
      return "complete";
    case "partial":
      return "partial";
    case "unpriced":
    default:
      return "unavailable";
  }
}

export type AccountingInvariantName =
  | "attributed_input_matches_run"
  | "attributed_output_matches_run"
  | "attributed_total_matches_run"
  | "model_totals_match_run"
  | "tool_totals_match_run"
  | "priced_nano_usd_matches_run";

export type AccountingInvariantStatus = "passed" | "failed" | "not_applicable";

export type AccountingInvariantResult = {
  name: AccountingInvariantName;
  status: AccountingInvariantStatus;
  message?: string;
  expected?: TokenBreakdown;
  actual?: TokenBreakdown;
  expectedNanoUsd?: NanoUsd;
  actualNanoUsd?: NanoUsd;
};

export type AttributionUnitKind = "model" | "tool" | "span" | "trace";

export type SafeSpanKind = "root" | "llm" | "tool" | "event" | "metric" | "unknown";

export type TokenBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cachedTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

export type ModelUsageSummary = TokenBreakdown & {
  model: string;
  provider?: string;
  estimatedNanoUsd?: NanoUsd;
  estimatedUsd?: number;
  pricingVersion?: string;
  matchedModel?: string;
  pricingCoverage?: PricingCoverageSummary;
  notes: string[];
};

export type ToolSummary = TokenBreakdown & {
  name: string;
  count: number;
  failures: number;
  totalDurationMs?: number;
};

export type AttributedUsageUnit = TokenBreakdown & {
  attributionId: string;
  kind: AttributionUnitKind;
  name: string;
  traceId: string;
  queryId?: string;
  chatSessionId?: string;
  spanId?: string;
  parentSpanId?: string;
  spanKind?: SafeSpanKind;
  model?: string;
  provider?: string;
  toolName?: string;
  tokenUsageSource: SelectedTokenUsageSource;
  recordKeys: string[];
  discardedRecordKeys: string[];
  estimatedNanoUsd?: NanoUsd;
  pricing?: PricingMatchMetadata;
  pricingCoverage?: PricingCoverageSummary;
  coverage: AccountingCoverage;
  warnings: string[];
};

export type AccountingModelSummary = TokenBreakdown & {
  model: string;
  provider?: string;
  attributionIds: string[];
  estimatedNanoUsd?: NanoUsd;
  pricing?: PricingMatchMetadata;
  pricingCoverage?: PricingCoverageSummary;
  coverage: AccountingCoverage;
  warnings: string[];
};

export type AccountingToolSummary = ToolSummary & {
  attributionIds: string[];
  estimatedNanoUsd?: NanoUsd;
  pricing?: PricingMatchMetadata;
  pricingCoverage?: PricingCoverageSummary;
  coverage: AccountingCoverage;
  warnings: string[];
};

export type SafeSpanAccountingSummary = TokenBreakdown & {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  queryId?: string;
  chatSessionId?: string;
  kind: SafeSpanKind;
  name: string;
  model?: string;
  provider?: string;
  toolName?: string;
  attributionIds: string[];
  estimatedNanoUsd?: NanoUsd;
  pricing?: PricingMatchMetadata;
  pricingCoverage?: PricingCoverageSummary;
  coverage: AccountingCoverage;
  warnings: string[];
};

export type AccountingTotals = TokenBreakdown & {
  estimatedNanoUsd?: NanoUsd;
  pricingCoverage?: PricingCoverageSummary;
  coverage: AccountingCoverage;
  warnings: string[];
};

export type AccountingSourceSelection = {
  selectedTokenUsageSource: TokenUsageSource;
  corroboratingSources: SelectedTokenUsageSource[];
  dedupedRecordCount: number;
  discardedOverlapReasons: AccountingCoverageReason[];
};

export type AuthoritativeTraceAccounting = {
  accountingSchemaVersion: 1;
  sourceSelection: AccountingSourceSelection;
  attributedUsageUnits: AttributedUsageUnit[];
  modelSummaries: AccountingModelSummary[];
  toolSummaries: AccountingToolSummary[];
  spanSummaries: SafeSpanAccountingSummary[];
  totals: AccountingTotals;
  pricingMatches: PricingMatchMetadata[];
  invariants: AccountingInvariantResult[];
  coverage: AccountingCoverage;
  warnings: string[];
};

export type LegacyAgenticQueryRun = {
  schemaVersion: 1;
  id: string;
  traceId: string;
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "completed" | "error" | "cancelled" | "unknown";
  agentName?: string;
  serviceName?: string;
  mode?: "ask" | "edit" | "agent" | "plan" | "cli" | "claude" | "unknown";
  models: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cachedTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  estimatedNanoUsd?: NanoUsd;
  estimatedUsd?: number;
  estimatedAiCredits?: number;
  pricingVersion?: string;
  llmCallCount: number;
  toolCallCount: number;
  tools: ToolSummary[];
  warnings: string[];
};

export type InitialQueryState = "captured" | "pending" | "unavailable";

export type TraceRole = "main" | "helper" | "unknown";

type AgenticRunRecordBase = Omit<LegacyAgenticQueryRun, "schemaVersion"> & {
  billingContext?: BillingContextId;
  repoKey?: string;
  queryId: string;
  queryStartedAt: string;
  chatSessionId?: string;
  copilotSessionId?: string;
  traceChatSessionId?: string;
  traceRole?: TraceRole;
  initialQueryText?: string;
  initialQueryState: InitialQueryState;
  tokenUsageSource: TokenUsageSource;
  accounting?: AuthoritativeTraceAccounting;
  pricingCoverage?: PricingCoverageSummary;
  costCoverage: CostCoverage;
  modelUsages: ModelUsageSummary[];
};

export type AgenticRunRecordV2 = AgenticRunRecordBase & {
  schemaVersion: 2;
};

export type AgenticRunRecordV3 = AgenticRunRecordBase & {
  schemaVersion: 3;
  accounting: AuthoritativeTraceAccounting;
};

export type AgenticRunRecord = AgenticRunRecordV2 | AgenticRunRecordV3;

export type PersistedAgenticRunRecord = LegacyAgenticQueryRun | AgenticRunRecord;

export type AgenticQueryRun = AgenticRunRecord;

export type PartialAgenticQueryRun = Partial<AgenticRunRecordBase & { schemaVersion: 2 | 3; accounting?: AuthoritativeTraceAccounting }> &
  Pick<AgenticRunRecordBase, "id" | "traceId" | "queryId" | "queryStartedAt" | "initialQueryState" | "status" | "models" | "llmCallCount" | "toolCallCount" | "tools" | "warnings" | "modelUsages"> &
  { schemaVersion: 2 | 3 };

export type AggregateAccountingMetadata = {
  billingContext?: BillingContextId;
  billingContexts?: BillingContextId[];
  accountingCoverage?: AccountingCoverage;
  pricingVersions?: string[];
  pricingEffectiveFrom?: string[];
  unpricedSliceCount?: number;
  unavailableSliceCount?: number;
  legacyRunCount?: number;
};

export type AgenticQueryGroup = TokenBreakdown & AggregateAccountingMetadata & {
  queryId: string;
  chatSessionId?: string;
  copilotSessionId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  initialQueryText?: string;
  initialQueryState: InitialQueryState;
  runCount: number;
  models: string[];
  modelUsages: ModelUsageSummary[];
  toolCallCount: number;
  tools: ToolSummary[];
  tokenSources: TokenUsageSource[];
  estimatedNanoUsd?: NanoUsd;
  estimatedUsd?: number;
  estimatedAiCredits?: number;
  pricingVersion?: string;
  pricingCoverage?: PricingCoverageSummary;
  costCoverage: CostCoverage;
  hasNonOpenAiModels: boolean;
  costLabel: CostLabel;
  runs: AgenticRunRecord[];
  warnings: string[];
};

export type AgenticChatSessionGroup = TokenBreakdown & AggregateAccountingMetadata & {
  chatSessionId: string;
  copilotSessionId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  queryCount: number;
  runCount: number;
  models: string[];
  tokenSources: TokenUsageSource[];
  estimatedNanoUsd?: NanoUsd;
  estimatedUsd?: number;
  estimatedAiCredits?: number;
  pricingCoverage?: PricingCoverageSummary;
  costCoverage: CostCoverage;
  costLabel: CostLabel;
  queries: AgenticQueryGroup[];
  warnings: string[];
};

export type AssembledAgentTrace = {
  traceId: string;
  rootSpan?: CanonicalSpanRecord;
  spans: CanonicalSpanRecord[];
  events: CanonicalEventRecord[];
  metrics: CanonicalMetricRecord[];
  firstSeenAt: string;
  lastUpdatedAt: string;
};

export type AgentRunUpdate =
  | { kind: "running"; run: PartialAgenticQueryRun; trace: AssembledAgentTrace }
  | { kind: "completed"; run: AgenticQueryRun; trace: AssembledAgentTrace };

export type DateRange = {
  from: string;
  to: string;
};

export type RunQuery = {
  limit?: number;
  range?: DateRange;
  queryId?: string;
  model?: string;
  status?: AgenticRunRecord["status"];
};

export type UsageTotals = AggregateAccountingMetadata & {
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  tokenSources: TokenUsageSource[];
  estimatedNanoUsd?: NanoUsd;
  estimatedUsd: number;
  estimatedAiCredits: number;
  pricingCoverage?: PricingCoverageSummary;
  costCoverage: CostCoverage;
};

export type ExportResult = {
  format: "json" | "csv";
  content: string;
  count: number;
};

export type PrivacyValidationResult = {
  ok: boolean;
  violations: string[];
};

export type BudgetWarning = {
  kind: "runTokens" | "runCredits" | "dailyCredits" | "monthlyCredits";
  message: string;
  runId?: string;
};

export type AttributionConfidence = "high" | "medium" | "low";

export type AttributionDecision =
  | "reportable"
  | "pending_evidence"
  | "rejected"
  | "expired"
  | "rewrite_pending"
  | "superseded"
  | "legacy_unverified";

export type AttributionProofKind =
  | "exact_content_state"
  | "observed_deletion"
  | "episode_inheritance";

export type RepositoryTransitionKind =
  | "fast_forward"
  | "branch_switch"
  | "non_fast_forward_ref_update"
  | "detached_head_change"
  | "ref_deleted"
  | "unknown";

export type QueryAttributionStatus =
  | "unattributed"
  | "pending_commit"
  | "pending_evidence"
  | "attributed"
  | "split_linked"
  | "manual_review"
  | "rejected"
  | "expired"
  | "rewrite_pending"
  | "legacy_unverified";

export type AllocationPolicy = "first_claim" | "unallocated_link";

export type AttributionCoverage = CostCoverage;

export type WorkEpisodeStatus = "open" | "claimed" | "stale" | "manual_review" | "expired";

export type WorkEpisodeConfidenceReason =
  | "artifact_overlap"
  | "session_temporal_claim"
  | "same_head_lineage"
  | "dirty_baseline_known"
  | "dirty_state_unknown"
  | "missing_file_evidence"
  | "external_changes_present"
  | "commit_after_agent_activity"
  | "commit_before_priced_run_reconciled"
  | "history_rewrite_superseded";

export type AttributionEpoch = {
  epochId: string;
  repoKey: string;
  startedAt: string;
  initialHead?: string;
  cursorHead?: string;
  cursorRefKey?: string;
  refHeads?: Record<string, string>;
  nextSequence: number;
  status: "active" | "superseded";
};

export type ArtifactStateEvidence = {
  artifactKey: string;
  previousArtifactKey?: string;
  stateKey?: string;
  worktreeStateKey?: string;
  indexStateKey?: string;
  changeKind: "added" | "modified" | "deleted" | "renamed" | "binary";
  observedSequence: number;
};

export type ObservedCommitCandidate = {
  candidateId: string;
  epochId: string;
  repoKey: string;
  commitHash: string;
  commitMessage?: string;
  parentHashes: string[];
  refKey?: string;
  observedAt: string;
  committedAt?: string;
  observedSequence: number;
  artifactStates: ArtifactStateEvidence[];
  transitionKind: RepositoryTransitionKind;
  decision: AttributionDecision;
  reasonCodes: string[];
};

export type AttributionProof = {
  kind: AttributionProofKind;
  anchorQueryIds: string[];
  inheritedQueryIds: string[];
  matchedArtifactCount: number;
  reasonCodes: string[];
};

export type RepositorySnapshotObservation = {
  epochId: string;
  repoKey: string;
  headCommit?: string;
  refKey?: string;
  observedAt: string;
  observedSequence: number;
  dirty: boolean;
  dirtyKnown: boolean;
  /** A partial snapshot can prove observed changes but cannot establish a complete baseline. */
  artifactCoverage?: "complete" | "partial";
  artifactStates: ArtifactStateEvidence[];
};

export type RepositoryObservationEvent =
  | { kind: "snapshot"; snapshot: RepositorySnapshotObservation }
  | { kind: "commit_candidate"; candidate: ObservedCommitCandidate }
  | { kind: "transition"; repoKey: string; epochId: string; refKey?: string; previousRefKey?: string; transitionKind: RepositoryTransitionKind; observedAt: string };

export type QueryWorkEvidence = {
  queryId: string;
  runIds: string[];
  repoKey: string;
  epochId?: string;
  startedAt: string;
  completedAt?: string;
  settlingUntil?: string;
  expiresAt?: string;
  baselineTrusted: boolean;
  baselineReasons: string[];
  headCommitAtStart?: string;
  baselineSequence?: number;
  dirtyAtStart: boolean;
  observedChangeCount: number;
  artifactKeys: string[];
  /** Artifact keys causally tied to this query by exact successful write telemetry. */
  causalArtifactKeys?: string[];
  baselineArtifactStates?: ArtifactStateEvidence[];
  artifactStates?: ArtifactStateEvidence[];
  addedLines: number;
  deletedLines: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  status?: "active" | "settling" | "completed" | "resolved" | "expired";
};

export type CommitCostAllocation = {
  episodeId?: string;
  epochId?: string;
  commitHash: string;
  commitMessage?: string;
  parentHashes: string[];
  repoKey: string;
  refKey?: string;
  queryId: string;
  allocatedNanoUsd?: NanoUsd;
  allocationPolicy: AllocationPolicy;
  decision?: AttributionDecision;
  proof?: AttributionProof;
  confidence?: AttributionConfidence;
  coverage: AttributionCoverage;
  evidenceReasons: string[];
  status: "active" | "rewrite_pending" | "superseded" | "legacy_unverified";
  verifiedAt?: string;
  stateChangedAt?: string;
  rewritePendingAt?: string;
  createdAt: string;
};

export type QueryCostAttribution = {
  queryId: string;
  runIds: string[];
  provider?: string;
  estimatedNanoUsd?: NanoUsd;
  estimatedUsd?: number;
  estimatedAiCredits?: number;
  costCoverage: CostCoverage;
  pricingCoverage?: PricingCoverageSummary;
  status: QueryAttributionStatus;
  evidence: QueryWorkEvidence[];
  allocations: CommitCostAllocation[];
};

export type CommitAttributionStatus = "active" | "rewrite_pending" | "manual_review" | "superseded" | "mixed";

export type CommitProviderCost = {
  provider: string;
  queryCount: number;
  allocatedNanoUsd?: NanoUsd;
  allocatedUsd?: number;
  allocatedAiCredits?: number;
};

export type CommitAttributionSummary = {
  commitHash: string;
  commitMessage?: string;
  parentHashes: string[];
  repoKey: string;
  episodeIds: string[];
  queryIds: string[];
  runIds: string[];
  linkedQueryCount: number;
  allocatedNanoUsd?: NanoUsd;
  allocatedUsd?: number;
  allocatedAiCredits?: number;
  linkedNanoUsd?: NanoUsd;
  linkedUsd?: number;
  linkedAiCredits?: number;
  providerCosts: CommitProviderCost[];
  coverage: AttributionCoverage;
  decision: AttributionDecision;
  proofKinds: AttributionProofKind[];
  anchorQueryIds: string[];
  inheritedQueryIds: string[];
  confidence?: AttributionConfidence;
  status: CommitAttributionStatus;
  evidenceReasons: string[];
  createdAt: string;
};

export type CommitAttributionQuery = {
  limit?: number;
  range?: DateRange;
  commitHash?: string;
  repoKey?: string;
};

export type GitHubRepositoryIdentity = {
  host: "github.com";
  owner: string;
  repository: string;
};

export type CommitPublicationSnapshot = {
  repoKey: string;
  commitHash: string;
  commitMessage?: string;
  state: "active" | "rewrite_pending" | "superseded";
  firstVerifiedAt: string;
  updatedAt: string;
  allocatedNanoUsd?: NanoUsd;
  coverage: AttributionCoverage;
  attributedQueryCount: number;
};

export type CommitCheckPublicationQuery = {
  limit?: number;
  commitHash?: string;
};

export type PublicationDeliveryState = "pending" | "retry" | "blocked" | "delivered";

export type CommitCheckPublicationStatus = {
  repoKey?: string;
  host?: "github.com";
  owner?: string;
  repository?: string;
  fullName?: string;
  commitHash: string;
  publicationState: CommitPublicationSnapshot["state"];
  deliveryState: PublicationDeliveryState | "not_queued";
  publicationVersion?: number;
  checkUrl?: string;
  lastErrorCode?: string;
  correlationId?: string;
  attempts?: number;
  queuedAt?: string;
  firstAttemptAt?: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  nextAttemptAt?: string;
  queueAgeMs?: number;
  queueDwellMs?: number;
  firstVerifiedAt: string;
  updatedAt: string;
};

export type PublicationOutboxEntry = {
  key: string;
  intent: CheckPublicationIntentV1;
  payloadHash: string;
  correlationId: string;
  state: PublicationDeliveryState;
  attempts: number;
  queuedAt: string;
  firstAttemptAt?: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  nextAttemptAt?: string;
  lastErrorCode?: string;
  checkUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type AttributionSpendSummary = {
  pendingNanoUsd?: NanoUsd;
  pendingUsd?: number;
  pendingAiCredits?: number;
  unattributedNanoUsd?: NanoUsd;
  unattributedUsd?: number;
  unattributedAiCredits?: number;
};

export type AgenticWorkEpisode = {
  observationSchemaVersion?: 1;
  episodeId: string;
  repoKey?: string;
  repoKeys?: string[];
  epochIds?: string[];
  chatSessionId?: string;
  queryIds: string[];
  runIds: string[];
  headCommitAtStart?: string;
  startedAt: string;
  lastQueryActivityAt?: string;
  lastAgentActivityAt: string;
  lastObservedChangeAt?: string;
  status: WorkEpisodeStatus;
  evidence: QueryWorkEvidence[];
  claimedByCommitHash?: string;
  claimedAt?: string;
  decision?: AttributionDecision;
  confidence?: AttributionConfidence;
  confidenceReasons?: WorkEpisodeConfidenceReason[];
};

export type WorkEpisodeClaimInput = {
  repoKey: string;
  parentHashes: string[];
  commitHash: string;
  committedAt: string;
  artifactKeys: string[];
};

export type WorkEpisodeQuery = {
  limit?: number;
  range?: DateRange;
  episodeId?: string;
  repoKey?: string;
  commitHash?: string;
  status?: WorkEpisodeStatus;
  queryId?: string;
  runId?: string;
  chatSessionId?: string;
};

export type CommitAttributionChange = {
  kind: "allocation_changed" | "history_rewrite" | "candidate_changed";
  queryId?: string;
  commitHash?: string;
};

export type DiagnosticScalar = string | number | boolean | null;
export type DiagnosticScalarMap = Record<string, DiagnosticScalar>;

export type DiagnosticEvent =
  | { kind: "otelState"; state: CopilotOtelState }
  | { kind: "ingestionCheckpoint"; checkpoint: IngestionCheckpoint }
  | { kind: "recordsNormalized"; spans: number; events: number; metrics: number }
  | { kind: "parseError"; message: string; sample?: string }
  | { kind: "normalizerIgnored"; reason: string }
  | { kind: "runUpdated"; summary: DiagnosticRunSummary }
  | { kind: "runCompleted"; summary: DiagnosticRunSummary }
  | { kind: "privacyViolation"; runId?: string; violations: string[] }
  | { kind: "attributionPrivacyViolation"; queryId?: string; violations: string[] }
  | { kind: "repoDiscovery"; repoCount: number; skippedCount: number }
  | {
      kind: "constructLifecycle";
      construct: string;
      operation: string;
      state: string;
      reason: string;
      severity?: "info" | "warning" | "error";
      runId?: string;
      queryId?: string;
      sessionId?: string;
      episodeId?: string;
      repoKey?: string;
      epochId?: string;
      commitHash?: string;
      publicationVersion?: number;
      batchId?: string;
      agentInstanceId?: string;
      correlationId?: string;
      details?: DiagnosticScalarMap;
    }
  | {
      kind: "workspaceEvidence";
      queryId?: string;
      repoKey?: string;
      commitHash?: string;
      state:
        | "no_repository_snapshots"
        | "baseline_created"
        | "baseline_refreshed"
        | "settling_started"
        | "snapshot_matched"
        | "settling_completed"
        | "settling_finalized_with_changes"
        | "settling_expired_no_changes"
        | "active_evidence_expired";
      reason: string;
      snapshotCount?: number;
      observedChangeCount?: number;
      dirty?: boolean;
      headCommitAtStart?: string;
      observedSequence?: number;
    }
  | {
      kind: "attributionDecision";
      episodeId?: string;
      queryId?: string;
      commitHash?: string;
      confidence?: AttributionConfidence;
      status: QueryAttributionStatus | CommitAttributionStatus | AttributionDecision | "skipped";
      reason: string;
    }
  | { kind: "storage"; message: string }
  | { kind: "info"; message: string };

export type DiagnosticRunSummary = {
  runId: string;
  traceId: string;
  queryId: string;
  billingContext?: BillingContextId;
  tokenUsageSource: TokenUsageSource;
  costCoverage: CostCoverage;
  pricingCoverageState?: PricingCoverageState;
  pricingCoverageReasons: AccountingCoverageReason[];
  pricingVersions: string[];
  pricingEffectiveFrom: string[];
  accountingCoverageState?: CostCoverage;
  accountingCoverageReasons: AccountingCoverageReason[];
  corroboratingSources: SelectedTokenUsageSource[];
  dedupedRecordCount: number;
  discardedOverlapReasons: AccountingCoverageReason[];
  legacySchemaRead: boolean;
  invariantFailures: string[];
};

export type DiagnosticSnapshot = {
  startedAt: string;
  otelState?: CopilotOtelState;
  checkpoint?: IngestionCheckpoint;
  lastParseError?: { message: string; sample?: string; at: string };
  ignoredRecordCount: number;
  activeTraceCount: number;
  normalizedSpanCount: number;
  normalizedEventCount: number;
  normalizedMetricCount: number;
  lastCompletedRun?: string;
  lastRunSummary?: DiagnosticRunSummary;
  lastAttributionDecision?: {
    queryId?: string;
    episodeId?: string;
    commitHash?: string;
    confidence?: AttributionConfidence;
    status: QueryAttributionStatus | CommitAttributionStatus | AttributionDecision | "skipped";
    reason: string;
    at: string;
  };
  billingContext?: BillingContextId;
  primaryBillingUnit?: BillingUnit;
  pricingVersion?: string;
  pricingVersions?: string[];
  storageLocation?: string;
  recentEvents: DiagnosticEvent[];
};

export interface CopilotTelemetrySource {
  inspect(): Promise<CopilotOtelState>;
  configureTirionTelemetry(): Promise<CopilotOtelState>;
  configureAgentOtlp(endpoint: string): Promise<CopilotAgentOtlpConfiguration>;
  restoreAgentOtlp(): Promise<CopilotAgentOtlpRestoration>;
  configureFileMode(): Promise<CopilotOtelState>;
  enableContentCapture(): Promise<CopilotOtelState>;
}

export interface TelemetryIngestion {
  start(source: TelemetryIngestionSource, checkpoint?: IngestionCheckpoint): void;
  stop(): void;
  onRawRecord(handler: (record: unknown) => void): void;
  onParseError(handler: (message: string, sample?: string) => void): void;
  onCheckpoint(handler: (checkpoint: IngestionCheckpoint) => void): void;
  getCheckpoint(): IngestionCheckpoint;
}

export interface IngestionCheckpointStore {
  load(): Promise<IngestionCheckpoint | undefined>;
  save(checkpoint: IngestionCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

export interface TelemetryNormalizer {
  normalize(raw: unknown): CanonicalOtelRecord | null;
  normalizeMany(raw: unknown): CanonicalOtelRecord[];
}

export interface AgentRunAssembler {
  ingest(record: CanonicalOtelRecord): AgentRunUpdate | null;
}

export interface TokenMeasurement {
  measure(runTrace: AssembledAgentTrace): TokenUsage;
}

export interface CostEstimation {
  estimate(input: {
    models: string[];
    tokens: TokenBreakdown;
    startedAt: string;
  }): CostEstimate | null;
  estimateModelUsage(input: {
    usage: Pick<ModelUsageSummary, "model" | "provider" | "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cachedTokens" | "reasoningOutputTokens" | "totalTokens">;
    startedAt: string;
  }): CostEstimate;
  estimateAttributedUnit(input: {
    unit: Pick<AttributedUsageUnit, "model" | "provider" | "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cachedTokens" | "reasoningOutputTokens" | "totalTokens">;
    startedAt: string;
  }): CostEstimate;
}

export interface RunLedger {
  append(run: AgenticRunRecord): Promise<void>;
  list(query: RunQuery): Promise<AgenticRunRecord[]>;
  listQueryGroups(query: RunQuery): Promise<AgenticQueryGroup[]>;
  listChatSessionGroups(query?: RunQuery): Promise<AgenticChatSessionGroup[]>;
  totals(range: DateRange): Promise<UsageTotals>;
  export(format: "json" | "csv", query: RunQuery): Promise<ExportResult>;
}

export interface WorkspaceChangeTracker {
  start(): Promise<void>;
  stop(): Promise<void> | void;
  observeRun(run: PartialAgenticQueryRun): Promise<void>;
  observeRunCompleted(run: AgenticQueryRun): Promise<void>;
  pendingEvidence(): QueryWorkEvidence[];
  resolveQueries(queryIds: string[]): Promise<void>;
  reset(): Promise<void>;
}

export interface AgenticWorkEpisodeTracker {
  start(): Promise<void>;
  stop(): Promise<void> | void;
  observeRun(run: PartialAgenticQueryRun): Promise<void>;
  observeRunCompleted(run: AgenticQueryRun): Promise<void>;
  observeWorkspaceEvidence(evidence: QueryWorkEvidence[]): Promise<void>;
  listEpisodes(query?: WorkEpisodeQuery): Promise<AgenticWorkEpisode[]>;
  markClaimed(episodeId: string, commitHash: string, claimedAt: string): Promise<void>;
  reopenSupersededCommit(commitHash: string): Promise<void>;
  reset(): Promise<void>;
}

export interface GitAttribution {
  start(): Promise<void>;
  stop(): Promise<void> | void;
  observeRunCompleted(run: AgenticQueryRun): Promise<void>;
  reconcilePersistedState(): Promise<void>;
  reconcile(): Promise<void>;
  onDidChange(handler: (change: CommitAttributionChange) => void): () => void;
  listCommitAttributions(query?: CommitAttributionQuery): Promise<CommitAttributionSummary[]>;
  listCommitPublicationSnapshots(query?: CommitAttributionQuery): Promise<CommitPublicationSnapshot[]>;
  spendSummary(): Promise<AttributionSpendSummary>;
  export(format: "json" | "csv", query?: CommitAttributionQuery): Promise<ExportResult>;
  reset(): Promise<void>;
}

export interface RepositoryObservation {
  start(): Promise<void>;
  stop(): Promise<void> | void;
  onObservation(handler: (event: RepositoryObservationEvent) => void | Promise<void>): () => void;
  requestActiveObservationWindow(durationMs: number, pollMs?: number): void;
  refresh(): Promise<void>;
  currentSnapshots(): RepositorySnapshotObservation[];
  listEpochs(): Promise<AttributionEpoch[]>;
  listCandidates(): Promise<ObservedCommitCandidate[]>;
  updateCandidate(candidate: ObservedCommitCandidate): Promise<void>;
  applyRetention(): Promise<number>;
  isAncestor(repoKey: string, ancestor: string, descendant: string): Promise<boolean>;
  resolveCommitMessage(repoKey: string, commitHash: string): Promise<string | undefined>;
  resolveGitHubRepository(repoKey: string): Promise<GitHubRepositoryIdentity | undefined>;
  reset(): Promise<void>;
}

export interface RepositoryObservationStore {
  initialize(): Promise<{ epochs: AttributionEpoch[]; candidates: ObservedCommitCandidate[]; recoveredFromCorruption: boolean }>;
  upsertEpoch(epoch: AttributionEpoch): Promise<void>;
  persistCandidatesAndAdvance(epoch: AttributionEpoch, candidates: ObservedCommitCandidate[]): Promise<void>;
  updateCandidate(candidate: ObservedCommitCandidate): Promise<void>;
  listEpochs(): Promise<AttributionEpoch[]>;
  listCandidates(): Promise<ObservedCommitCandidate[]>;
  applyCandidateRetention(retainAfter: string): Promise<number>;
  clear(): Promise<void>;
}

export interface WorkEpisodeLedger {
  initialize(): Promise<number>;
  upsertEpisode(episode: AgenticWorkEpisode): Promise<void>;
  listEpisodes(query?: WorkEpisodeQuery): Promise<AgenticWorkEpisode[]>;
  applyRetention(retentionDays?: number, retainedQueryIds?: Set<string>): Promise<number>;
  clear(): Promise<void>;
}

export interface WorkspaceEvidenceLedger {
  upsertEvidence(evidence: QueryWorkEvidence): Promise<void>;
  listEvidence(query?: { queryId?: string; repoKey?: string; status?: QueryWorkEvidence["status"] }): Promise<QueryWorkEvidence[]>;
  removeEvidence(queryId: string, repoKey: string): Promise<void>;
  applyRetention(retainedQueryIds: Set<string>): Promise<number>;
  clear(): Promise<void>;
}

export type FirstClaimInput = {
  candidate: ObservedCommitCandidate;
  episode: AgenticWorkEpisode;
  proof: AttributionProof;
  queryIds: string[];
};

export interface CommitAttributionLedger {
  upsertQueryAttribution(attribution: QueryCostAttribution): Promise<void>;
  tryFirstClaim(input: FirstClaimInput): Promise<{ claimedQueryIds: string[]; skippedQueryIds: string[] }>;
  transferFirstClaim(input: FirstClaimInput & { supersededCommitHash: string }): Promise<{ claimedQueryIds: string[]; skippedQueryIds: string[] }>;
  markRewritePending(repoKey: string, commitHashes: string[], observedAt?: string): Promise<number>;
  expireRewritePending(before: string): Promise<number>;
  quarantineLegacy(activeEpochIds?: Set<string>): Promise<number>;
  listQueryAttributions(query?: CommitAttributionQuery): Promise<QueryCostAttribution[]>;
  listCommitAttributions(query?: CommitAttributionQuery): Promise<CommitAttributionSummary[]>;
  listCommitPublicationSnapshots(query?: CommitAttributionQuery): Promise<CommitPublicationSnapshot[]>;
  export(format: "json" | "csv", query?: CommitAttributionQuery): Promise<ExportResult>;
  applyRetention(retentionDays?: number, retainedQueryIds?: Set<string>): Promise<number>;
  clear(): Promise<void>;
}

export interface PrivacyGuard {
  sanitize(record: CanonicalOtelRecord): CanonicalOtelRecord;
  validateRun(run: AgenticQueryRun): PrivacyValidationResult;
  validateAttribution(record: unknown): PrivacyValidationResult;
  validatePublication(record: unknown): PrivacyValidationResult;
}

export interface PublicationOutbox {
  initialize(): Promise<PublicationOutboxEntry[]>;
  list(): Promise<PublicationOutboxEntry[]>;
  upsert(entry: PublicationOutboxEntry): Promise<void>;
  replaceIfCurrent(entry: PublicationOutboxEntry, expectedPublicationVersion: number, expectedPayloadHash: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  discardUnpublished(): Promise<number>;
  retainDeliveredCommitHashes(commitHashes: Set<string>): Promise<number>;
  applyRetention(retentionDays: number): Promise<number>;
  clear(): Promise<void>;
}

export interface UserSurface {
  showCurrentRun(run: PartialAgenticQueryRun): void;
  showCompletedRun(run: AgenticQueryRun): void;
  showWarning(warning: BudgetWarning): void;
  openDashboard(): void;
  refreshDashboard(): void;
}

export interface Diagnostics {
  recordEvent(event: DiagnosticEvent): void;
  snapshot(): DiagnosticSnapshot;
}
