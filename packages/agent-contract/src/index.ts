export const AGENT_PROTOCOL_MAJOR = 1;
export const AGENT_PROTOCOL_MINOR = 0;
export const AGENT_SCHEMA_VERSION = 1;
export const AGENT_DATABASE_SCHEMA_VERSION = 9;

export type OwnershipState =
  | "extension_legacy"
  | "agent_shadow"
  | "agent_usage_owner"
  | "agent_full_owner";

export type MutableStateOwner = "extension" | "agent";

export type MutableConstruct =
  | "source_registry"
  | "source_checkpoints"
  | "safe_observation_journal"
  | "query_occurrence_ledger"
  | "execution_tree_ledger"
  | "run_ledger"
  | "repository_scope_registry"
  | "repository_observation_state"
  | "workspace_evidence"
  | "work_episodes"
  | "commit_attribution_ledger"
  | "webhook_outbox"
  | "budget_state"
  | "diagnostic_state"
  | "agent_metadata";

export type OwnershipManifestV1 = {
  schemaVersion: 1;
  state: OwnershipState;
  updatedAt: string;
  owners: Record<MutableConstruct, MutableStateOwner>;
};

export type PublicOwnershipMarkerV1 = {
  schemaVersion: 1;
  state: OwnershipState;
  updatedAt: string;
};

export type OwnershipReadinessV1 = {
  schemaVersion: 1;
  current: OwnershipState;
  transitions: {
    target: OwnershipState;
    ready: boolean;
    reasonCodes: (
      | "already_current"
      | "shadow_pipeline_ready"
      | "production_usage_pipeline_not_ready"
      | "extension_usage_consumer_not_ready"
      | "production_usage_pipeline_ready"
      | "extension_usage_consumer_ready"
      | "legacy_engine_drained"
      | "legacy_engine_lease_active"
      | "legacy_engine_observation_window_active"
      | "repository_attribution_not_ready"
      | "extension_engine_removal_not_ready"
      | "repository_attribution_ready"
      | "extension_engine_removed"
      | "unsupported_transition"
    )[];
  }[];
};

export type LegacyEngineLeaseV1 = {
  schemaVersion: 1;
  sessionId: string;
  expiresAt: string;
};

export type EvidenceGrade =
  | "verified_commit_cost"
  | "estimated_usage_cost_unattributed"
  | "provider_reported_ai_contribution"
  | "unsupported";

export type CompatibilityStatus = "supported" | "degraded" | "unsupported";
export type SourceDurability = "durable_checkpoint" | "at_least_once" | "ephemeral";
export type SourceContentRisk = "metadata_only" | "content_possible" | "content_expected";
export type UsageGranularity = "aggregate" | "request" | "prompt" | "turn" | "run";

export type SourceCapabilityV1 = {
  schemaVersion: 1;
  sourceId: string;
  sourceKind: string;
  provider: string;
  runtime: string;
  environmentId: string;
  profileVersion: string;
  granularity: UsageGranularity[];
  tokenDimensions: string[];
  billingEvidence: string[];
  durability: SourceDurability;
  contentRisk: SourceContentRisk;
  compatibility: CompatibilityStatus;
  evidenceGrade: EvidenceGrade;
};

export type SourceRegistrationV1 = SourceCapabilityV1;

export type SourceTestResultV1 = {
  schemaVersion: 1;
  sourceId: string;
  registered: true;
  environmentMatch: true;
  runtimeObserved: boolean;
  lastObservedAt?: string;
  compatibility: CompatibilityStatus;
  evidenceGrade: EvidenceGrade;
};

export type SupportedProvider = "github-copilot" | "claude-code" | "codex" | "cursor";

export type ConfigurableProvider = Exclude<SupportedProvider, "github-copilot">;

export type ProviderConfigurationOwnershipState =
  | "unmanaged"
  | "adoptable_local"
  | "managed_current"
  | "managed_stale_authority"
  | "managed_drifted"
  | "foreign_managed"
  | "invalid"
  | "unavailable";

export type ProviderConfigurationReasonCode =
  | "provider_configured"
  | "already_configured"
  | "provider_restored"
  | "provider_not_managed"
  | "restore_conflict"
  | "existing_exporter_conflict"
  | "invalid_existing_configuration"
  | "source_configuration_unavailable"
  | "logs_missing"
  | "traces_missing"
  | "tool_details_disabled"
  | "tool_content_disabled"
  | "response_content_disabled"
  | "stale_managed_agent_token"
  | "managed_configuration_drifted"
  | "foreign_exporter_present"
  | "local_tirion_exporter_unclaimed";

export type ProviderConfigurationRequestV1 = {
  schemaVersion: 1;
  capturePrompts?: boolean;
  captureToolDetails?: boolean;
  captureToolContent?: boolean;
  captureResponseContent?: boolean;
};

export type ProviderConfigurationV1 = {
  schemaVersion: 1;
  provider: ConfigurableProvider;
  status: "configured" | "already_configured" | "restored" | "not_managed" | "conflict" | "unavailable";
  profileVersion: string;
  ownershipState: ProviderConfigurationOwnershipState;
  promptCaptureEnabled: boolean;
  logsEnabled: boolean;
  tracesEnabled: boolean;
  toolDetailsSupported: boolean;
  toolDetailsEnabled: boolean;
  toolContentSupported: boolean;
  toolContentEnabled: boolean;
  responseContentSupported: boolean;
  responseContentEnabled: boolean;
  restartRequired: boolean;
  reasonCodes: ProviderConfigurationReasonCode[];
};

export type ProviderConfigurationStateV1 = {
  schemaVersion: 1;
  provider: ConfigurableProvider;
  profileVersion: string;
  configurationState: "configured" | "partial" | "not_configured" | "conflict" | "unavailable";
  ownershipState: ProviderConfigurationOwnershipState;
  promptCaptureEnabled: boolean;
  logsEnabled: boolean;
  tracesEnabled: boolean;
  toolDetailsSupported: boolean;
  toolDetailsEnabled: boolean;
  toolContentSupported: boolean;
  toolContentEnabled: boolean;
  responseContentSupported: boolean;
  responseContentEnabled: boolean;
  reasonCodes: ProviderConfigurationReasonCode[];
};

export type ProviderSourceStatusV1 = {
  schemaVersion: 1;
  provider: SupportedProvider;
  profileVersion: string;
  configurationState: ProviderConfigurationStateV1["configurationState"];
  ownershipState: ProviderConfigurationOwnershipState;
  promptCaptureEnabled: boolean;
  logsEnabled: boolean;
  tracesEnabled: boolean;
  toolDetailsSupported: boolean;
  toolDetailsEnabled: boolean;
  toolContentSupported: boolean;
  toolContentEnabled: boolean;
  responseContentSupported: boolean;
  responseContentEnabled: boolean;
  lastReceiptAt?: string;
  measurementState: "complete" | "awaiting_receipts" | "unavailable";
  reasonCodes: (ProviderConfigurationReasonCode | "no_recent_receipt")[];
};

export type CopilotSpanDbConfigurationV1 = {
  schemaVersion: 1;
  enabled: boolean;
  spanDbPath?: string;
  captureContent: boolean;
  dbSpanExporter: boolean;
};

export type RepositoryScopeV1 = {
  schemaVersion: 1;
  scopeId: string;
  kind: "repository" | "root";
  label: string;
  state: "active" | "paused";
  environmentId: string;
  /**
   * Legacy field from provider-scoped activation. Repository identity is provider-neutral;
   * new agents must not set this and readers should ignore it when binding runs.
   */
  provider?: SupportedProvider;
  addedAt: string;
  updatedAt: string;
  lastObservedAt?: string;
};

export type RepositoryScopeStatusV1 = {
  schemaVersion: 1;
  scope: RepositoryScopeV1;
  health: "healthy" | "paused" | "unavailable";
  reasonCodes: ("scope_paused" | "locator_unavailable")[];
};

export type RepositoryActivationRequestV1 = {
  schemaVersion: 1;
  path: string;
  provider?: SupportedProvider | "auto";
  capturePrompts?: boolean;
  captureToolDetails?: boolean;
  captureToolContent?: boolean;
  captureResponseContent?: boolean;
};

export type RepositoryActivationV1 = {
  schemaVersion: 1;
  activationState: "ready" | "attention_required" | "blocked";
  repositoryScope: RepositoryScopeV1;
  provider?: SupportedProvider;
  sourceStatus?: ProviderSourceStatusV1;
  configurationResult?: ProviderConfigurationV1;
  restartRequired: boolean;
  reasonCodes: (
    | "repository_scope_active"
    | "provider_auto_selected"
    | "provider_configuration_applied"
    | "provider_configuration_ready"
    | "provider_selection_required"
    | "telemetry_receipts_pending"
    | "foreign_provider_configuration"
    | "managed_provider_configuration_drifted"
    | "stale_managed_agent_token"
    | "source_configuration_unavailable"
  )[];
};

export type RepositoryWorkspaceLeaseV1 = {
  schemaVersion: 1;
  leaseId: string;
  label: string;
  environmentId: string;
  expiresAt: string;
};

export type TelemetrySignal = "traces" | "logs" | "metrics";

export type SafeObservationV1 = {
  schemaVersion: 1;
  observationId: string;
  sourceId: string;
  provider: SupportedProvider;
  runtime: string;
  signal: TelemetrySignal;
  profileVersion: string;
  resourceCount: number;
  recordCount: number;
  observedAt: string;
  queryOccurrences?: QueryOccurrenceV1[];
  activityAtoms?: SafeActivityAtomV1[];
  executionNodes?: ExecutionNodeAtomV1[];
  usageAtoms: SafeUsageAtomV1[];
};

export type SafeUsageAuthority = "run" | "request" | "turn" | "model" | "event";
export type SafeActivityKind = "tool" | "subagent" | "skill" | "mcp";
export type SafeActivityOutcome = "success" | "failure" | "rejected" | "unknown";
export type SensitiveAuditEvidenceKind =
  | "tool_arguments"
  | "tool_output"
  | "path"
  | "diff"
  | "file_content";
export type SensitiveAuditEvidenceV1 = {
  schemaVersion: 1;
  evidenceId: string;
  kind: SensitiveAuditEvidenceKind;
  label: string;
  value: string;
  source: "provider_telemetry" | "local_agent";
  activityKind?: SafeActivityKind;
  activityName?: string;
  capturedAt: string;
};
export type RunCompletionMode = "explicit" | "inactivity";
export type CostEstimateBasis = "catalog_estimate" | "provider_reported_estimate" | "unavailable";
/** Legacy compatibility only. New prompt lifecycle records use QueryOccurrenceV1. */
export type SafeAtomKind = "usage" | "lifecycle";
/** Legacy compatibility only. New prompt lifecycle records use QueryOccurrenceV1. */
export type SafeQueryLifecycle = "query_started" | "query_activity" | "query_completed";
export type QueryPromptState = "captured" | "disabled" | "unavailable";
export type QueryOccurrenceEvidence =
  | "provider_prompt_id"
  | "provider_user_prompt_event"
  | "provider_user_message_event"
  | "provider_root_span"
  | "submission_hook";
export type BillingContextV1 =
  | "github-copilot"
  | "openai-direct"
  | "anthropic-direct"
  | "cursor"
  | "subscription"
  | "unknown";

export type ModelProviderV1 = "anthropic" | "openai" | "google" | "microsoft" | "github" | "cursor" | "unknown";
export type ModelProviderBasisV1 = "telemetry_reported" | "model_name_rule" | "conflict" | "unknown";

export type SafeUsageAtomV1 = {
  schemaVersion: 1;
  atomId: string;
  /** Legacy alias for queryId, retained for stored v1 compatibility. */
  correlationId: string;
  queryId?: string;
  sessionId?: string;
  requestId?: string;
  owningActivityId?: string;
  signal?: TelemetrySignal;
  sourceId?: string;
  profileVersion?: string;
  provider: SafeObservationV1["provider"];
  runtime: string;
  kind?: SafeAtomKind;
  lifecycle?: SafeQueryLifecycle;
  authority: SafeUsageAuthority;
  completionMode?: RunCompletionMode;
  billingContext?: BillingContextV1;
  providerReportedNanoUsd?: number;
  model?: string;
  modelProvider?: ModelProviderV1;
  modelProviderBasis?: ModelProviderBasisV1;
  modelProviderClassificationVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  startedAt: string;
  endedAt?: string;
};

export type SafeActivityAtomV1 = {
  schemaVersion: 1;
  activityId: string;
  queryId: string;
  sessionId?: string;
  provider: SafeObservationV1["provider"];
  runtime: string;
  kind: SafeActivityKind;
  name: string;
  outcome: SafeActivityOutcome;
  durationMs?: number;
  resultSizeBytes?: number;
  providerReportedResultTokens?: number;
  sensitiveAuditEvidence?: SensitiveAuditEvidenceV1[];
  evidenceBasis?: WebhookEvidenceBasisV1;
  evidenceSourceId?: string;
  evidenceProfileVersion?: string;
  identityConfidence?: WebhookEvidenceV1["identityConfidence"];
  timingConfidence?: WebhookEvidenceV1["timingConfidence"];
  startedAt: string;
  endedAt?: string;
};

export type QueryOccurrenceV1 = {
  schemaVersion: 1;
  queryId: string;
  sessionId: string;
  provider: SafeObservationV1["provider"];
  runtime: string;
  startedAt: string;
  promptState: QueryPromptState;
  promptText?: string;
  evidence: QueryOccurrenceEvidence;
};

export type ExecutionContentVisibilityV1 =
  | "visible"
  | "hidden_by_policy"
  | "disabled_at_source"
  | "not_captured"
  | "redacted";

export type ExecutionNodeKindV1 =
  | "prompt"
  | "llm_request"
  | "tool"
  | "subagent"
  | "skill"
  | "mcp"
  | "response"
  | "unknown";

export type ExecutionNodeContentKindV1 =
  | "prompt_text"
  | "response_text"
  | "tool_input"
  | "tool_output"
  | "path"
  | "diff"
  | "file_content";

export type ExecutionNodeContentV1 = {
  schemaVersion: 1;
  kind: ExecutionNodeContentKindV1;
  visibility: ExecutionContentVisibilityV1;
  text?: string;
  preview?: string;
};

export type ExecutionNodeAtomV1 = {
  schemaVersion: 1;
  nodeId: string;
  queryId: string;
  sessionId?: string;
  requestId?: string;
  provider: SafeObservationV1["provider"];
  runtime: string;
  signal?: TelemetrySignal;
  nodeKind: ExecutionNodeKindV1;
  name: string;
  parentNodeId?: string;
  outcome: SafeActivityOutcome;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  model?: string;
  toolName?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  contents?: ExecutionNodeContentV1[];
};

export type ExecutionTreeNodeV1 = ExecutionNodeAtomV1 & {
  nodeKey: string;
  parentNodeKey?: string;
  siblingOrder: number;
};

export type ExecutionTreeSnapshotV1 = {
  schemaVersion: 1;
  runId: string;
  queryId: string;
  sessionId?: string;
  provider: SafeObservationV1["provider"];
  runtime: string;
  promptStartedAt: string;
  runEndedAt?: string;
  rootNodeKey: string;
  nodes: ExecutionTreeNodeV1[];
};

export type ExecutionRunSummaryV1 = {
  schemaVersion: 1;
  runId: string;
  queryId: string;
  sessionId?: string;
  provider: SafeObservationV1["provider"];
  runtime: string;
  promptStartedAt: string;
  runEndedAt?: string;
  nodeCount: number;
  contentVisibility: "full" | "partial" | "topology_only";
};

export type ExecutionRunListV1 = {
  schemaVersion: 1;
  runs: ExecutionRunSummaryV1[];
};

export type ExecutionRunTreeResponseV1 = {
  schemaVersion: 1;
  run: ExecutionRunSummaryV1;
  tree: ExecutionTreeSnapshotV1;
};

export type RunBreakdownAttributionBasis =
  | "provider_reported"
  | "trace_descendant"
  | "activity_only"
  | "unavailable";

export type RunBreakdownV1 = {
  schemaVersion: 1;
  breakdownId: string;
  kind: "model" | "request" | "tool" | "subagent" | "skill" | "mcp" | "unallocated";
  name: string;
  count: number;
  failureCount: number;
  totalDurationMs?: number;
  resultSizeBytes?: number;
  providerReportedResultTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  attributionBasis: RunBreakdownAttributionBasis;
  coverage: "complete" | "partial" | "unavailable";
  sensitiveAuditEvidence?: SensitiveAuditEvidenceV1[];
};

export type RunContextFootprintBasisV1 =
  | "provider_reported_input_tokens"
  | "derived_from_usage_atoms"
  | "derived_from_execution_nodes"
  | "unavailable";

export type RunContextFootprintCoverageV1 =
  | "none"
  | "partial"
  | "complete_so_far"
  | "final";

export type RunContextFootprintV1 = {
  schemaVersion: 1;
  /** Sum of reported input context tokens across observed LLM requests, including cache read/creation components. */
  accumulatedInputTokens: number;
  /** Reported input context tokens on the first observed LLM request for this run. */
  initialInputContextTokens?: number;
  /** Reported input context tokens on the latest observed LLM request for this run. */
  latestInputContextTokens?: number;
  /** Largest reported input-context-token footprint on any observed LLM request for this run. */
  peakInputContextTokens?: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  observedLlmRequestCount: number;
  contextGrowthInputTokens?: number;
  contextGrowthRatio?: number;
  basis: RunContextFootprintBasisV1;
  coverage: RunContextFootprintCoverageV1;
};

export type ShadowRunV1 = {
  schemaVersion: 1;
  shadow: true;
  runId: string;
  /** Legacy alias for queryId, retained for client compatibility. */
  correlationId: string;
  queryId?: string;
  sessionId?: string;
  promptState: QueryPromptState;
  promptText?: string;
  provider: SafeObservationV1["provider"];
  runtime: string;
  model?: string;
  models?: string[];
  modelProvider?: ModelProviderV1;
  modelProviderBasis?: ModelProviderBasisV1;
  modelProviderClassificationVersion?: string;
  authority: SafeUsageAuthority;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedNanoUsd?: number;
  usageValueNanoUsd?: number;
  costEstimateBasis?: CostEstimateBasis;
  pricingVersion?: string;
  billingContext: BillingContextV1;
  costCoverage: "complete" | "partial" | "unavailable";
  evidenceGrade: EvidenceGrade;
  /** Optional only for stored v1 run compatibility. New projections always populate this field. */
  toolCallCount?: number;
  /** Optional only for stored v1 run compatibility. New projections always populate this field. */
  breakdown?: RunBreakdownV1[];
  /** Optional only when no privacy-safe reported input-token footprint is available. */
  context?: RunContextFootprintV1;
  startedAt: string;
  endedAt?: string;
  warnings: ShadowReasonCode[];
};

export type ShadowReasonCode =
  | "model_unavailable"
  | "billing_context_unavailable"
  | "subscription_usage_only"
  | "pricing_unavailable"
  | "provider_reported_estimate"
  | "session_identity_unavailable"
  | "lower_authority_overlap_discarded"
  | "no_usage_atoms";

export type ShadowTotalsV1 = {
  schemaVersion: 1;
  shadow: true;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedNanoUsd: number;
  usageValueNanoUsd: number;
  pricedRunCount: number;
  unpricedRunCount: number;
};

export type ProductionRunV1 = Omit<ShadowRunV1, "shadow" | "runId"> & {
  production: true;
  runId: string;
};

export type ProductionTotalsV1 = Omit<ShadowTotalsV1, "shadow"> & {
  production: true;
};

export type ProductionUsageEpochV1 = {
  schemaVersion: 1;
  epochId: string;
  startedAt: string;
};

export type AgentBudgetThresholdsV1 = {
  schemaVersion: 1;
  runTokens: number;
  runEstimatedNanoUsd: number;
  dailyEstimatedNanoUsd: number;
  monthlyEstimatedNanoUsd: number;
};

export type AgentBudgetWarningV1 = {
  schemaVersion: 1;
  warningId: string;
  kind: "run_tokens" | "run_estimated_cost" | "daily_estimated_cost" | "monthly_estimated_cost";
  runId?: string;
  periodStart?: string;
  observed: number;
  threshold: number;
  unit: "tokens" | "estimated_nano_usd";
  createdAt: string;
};

export type AgentBudgetSnapshotV1 = {
  schemaVersion: 1;
  thresholds: AgentBudgetThresholdsV1;
  warnings: AgentBudgetWarningV1[];
};

export type AgentDiagnosticEventCode =
  | "runtime_started"
  | "runtime_warmup_changed"
  | "runtime_stopping"
  | "ownership_transitioned"
  | "production_usage_rebuilt"
  | "safe_journal_pruned"
  | "product_retention_applied"
  | "production_history_cleared"
  | "agent_data_cleared"
  | "repository_scopes_changed"
  | "webhook_changed"
  | "full_owner_bootstrap_changed"
  | "historical_reconciliation_changed"
  | "construct_lifecycle"
  | "live_pipeline_event";

export type AgentDiagnosticDetailValue = string | number | boolean | null;
export type AgentDiagnosticDetailsV1 = Record<string, AgentDiagnosticDetailValue>;

export type AgentDiagnosticEventV1 = {
  schemaVersion: 1;
  eventId: string;
  code: AgentDiagnosticEventCode;
  severity: "info" | "warning" | "error";
  at: string;
  message?: string;
  details?: AgentDiagnosticDetailsV1;
};

export type AgentConstructStateV1 = {
  schemaVersion: 1;
  construct: string;
  state: string;
  health: "healthy" | "degraded" | "blocked";
  updatedAt: string;
  reason?: string;
  details?: AgentDiagnosticDetailsV1;
};

export type AgentLogResponseV1 = {
  schemaVersion: 1;
  events: AgentDiagnosticEventV1[];
};

export type AgentEventKind =
  | "health_changed"
  | "ownership_changed"
  | "usage_changed"
  | "repository_changed"
  | "attribution_changed"
  | "webhook_changed"
  | "warnings_changed";

export type AgentEventV1 = {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  kind: AgentEventKind;
  at: string;
};

export type AgentDiagnosticsV1 = {
  schemaVersion: 1;
  health: AgentHealth;
  ownershipState: OwnershipState;
  executionEnvironment: "local";
  sourceCount: number;
  safeObservationCount: number;
  journalPrunedCount: number;
  journalOverflowCount: number;
  productionRunCount: number;
  pricedRunCount: number;
  unpricedRunCount: number;
  repositoryScopeCount: number;
  activeRepositoryScopeCount: number;
  verifiedAttributionCount: number;
  budgetWarningCount: number;
  webhook?: AgentWebhookStatusV1;
  constructStates: AgentConstructStateV1[];
  recentEvents: AgentDiagnosticEventV1[];
};

export type AgentCommitAttributionProviderCostV1 = {
  provider: string;
  queryCount: number;
  estimatedNanoUsd?: number;
};

export type AgentCommitAttributionV1 = {
  schemaVersion: 1;
  commitHash: string;
  repoKey: string;
  queryIds: string[];
  runIds: string[];
  attributedQueryCount: number;
  estimatedNanoUsd?: number;
  providerCosts: AgentCommitAttributionProviderCostV1[];
  costCoverage: "complete" | "partial" | "unavailable";
  decision: "reportable" | "superseded";
  proofKinds: ("exact_content_state" | "observed_deletion" | "episode_inheritance")[];
  status: "active" | "rewrite_pending" | "manual_review" | "superseded" | "mixed";
  createdAt: string;
};

export type AttributionQueryResponseV1 = {
  schemaVersion: 1;
  attributions: AgentCommitAttributionV1[];
};

export type AttributionExportV1 = {
  schemaVersion: 1;
  format: "json" | "csv";
  count: number;
  content: string;
};

export type WebhookEventTypeV1 = "run.start" | "run.update" | "run.ended" | "commit.attributed";

export type WebhookRepositoryV1 = {
  repoKey: string;
  owner: string;
  name: string;
  fullName: string;
};

export type WebhookSenderProfileV1 = {
  name?: string;
  team?: string;
  imageUrl?: string;
};

export type WebhookSenderV1 = WebhookSenderProfileV1 & {
  installationId: string;
};

export type WebhookEvidenceBasisV1 =
  | "prompt_hook"
  | "session_hook"
  | "tool_hook"
  | "subagent_hook"
  | "stop_hook"
  | "root_span"
  | "trace_span"
  | "otel_event"
  | "provider_metric"
  | "span_db_replay"
  | "inactivity";

export type WebhookEvidenceV1 = {
  basis: WebhookEvidenceBasisV1;
  sourceId: string;
  profileVersion: string;
  observedAt: string;
  delayed: boolean;
  identityConfidence: "high" | "medium";
  timingConfidence: "high" | "medium";
};

export type WebhookCoverageV1 = {
  usageCoverage: "none" | "partial" | "complete_so_far" | "final";
  activityCoverage: "none" | "partial" | "complete_for_reported_surface";
  costCoverage: "complete" | "partial" | "unavailable";
};

export type RunLifecycleActivityWebhookV1 = {
  activityId: string;
  parentActivityId?: string;
  kind: "llm_request" | "tool" | "subagent" | "skill" | "mcp" | "hook" | "unknown";
  name: string;
  outcome: SafeActivityOutcome;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  evidence: WebhookEvidenceV1;
};

type RunWebhookEventBaseV1 = {
  schemaVersion: 1;
  eventType: "run.start" | "run.update" | "run.ended";
  eventId: string;
  runId: string;
  sessionId: string;
  traceIds: string[];
  sender: WebhookSenderV1;
  repository: WebhookRepositoryV1;
  codingHarness: SafeObservationV1["provider"];
  runtime: string;
  startedAt: string;
  evidence: WebhookEvidenceV1;
  coverage: WebhookCoverageV1;
};

export type RunStartedWebhookEventV1 = RunWebhookEventBaseV1 & {
  eventType: "run.start";
  sequence: number;
  updatedAt: string;
  state: "running";
  llmModels: string[];
};

export type RunUpdatedWebhookEventV1 = RunWebhookEventBaseV1 & {
  eventType: "run.update";
  sequence: number;
  updatedAt: string;
  state: "running" | "settling";
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  llmModels: string[];
  estimatedNanoUsd: number;
  usageValueNanoUsd?: number;
  costEstimateBasis: CostEstimateBasis;
  costCoverage: "complete" | "partial" | "unavailable";
  context?: RunContextFootprintV1;
  activity: RunLifecycleActivityWebhookV1[];
};

export type RunEndedWebhookEventV1 = RunWebhookEventBaseV1 & {
  eventType: "run.ended";
  version?: number;
  endedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  llmModels: string[];
  filesChanged: string[];
  estimatedNanoUsd: number;
  usageValueNanoUsd?: number;
  costEstimateBasis: CostEstimateBasis;
  costCoverage: "complete" | "partial" | "unavailable";
  context?: RunContextFootprintV1;
  state: "completed";
};

export type CommitAttributedWebhookEventV1 = {
  schemaVersion: 1;
  eventType: "commit.attributed";
  eventId: string;
  sender: WebhookSenderV1;
  repository: WebhookRepositoryV1;
  commitSha: string;
  commitMessage?: string;
  traceIds: string[];
  runIds: string[];
  estimatedNanoUsd: number;
  usageValueNanoUsd?: number;
  costCoverage: "complete" | "partial" | "unavailable";
  state: "active" | "rewrite_pending" | "superseded";
  version: number;
  firstVerifiedAt: string;
  updatedAt: string;
};

export type WebhookEventV1 =
  | RunStartedWebhookEventV1
  | RunUpdatedWebhookEventV1
  | RunEndedWebhookEventV1
  | CommitAttributedWebhookEventV1;

export type WebhookUrlConfigurationV1 = {
  schemaVersion: 1;
  url: string;
};

export type WebhookBearerTokenConfigurationV1 = {
  schemaVersion: 1;
  token: string;
};

export type WebhookSecretConfigurationV1 = {
  schemaVersion: 1;
  secret: string;
};

export type WebhookSenderConfigurationV1 = {
  schemaVersion: 1;
  sender: WebhookSenderProfileV1;
};

export type AgentWebhookConfigurationV1 = {
  schemaVersion: 1;
  url?: string;
  sender: WebhookSenderProfileV1;
  runEndedEnabled: boolean;
  commitAttributedEnabled: boolean;
  bearerTokenConfigured: boolean;
  hmacSecretConfigured: boolean;
};

export type AgentWebhookDeliveryItemV1 = {
  schemaVersion: 1;
  eventId: string;
  eventType: WebhookEventTypeV1;
  subjectId: string;
  deliveryState: "pending" | "retry" | "blocked" | "delivered";
  attempts: number;
  queuedAt: string;
  firstAttemptAt?: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  nextAttemptAt?: string;
  lastErrorCode?: string;
  updatedAt: string;
};

export type AgentWebhookStatusV1 = AgentWebhookConfigurationV1 & {
  queuedCount: number;
  blockedCount: number;
  deliveredCount: number;
  oldestQueuedAt?: string;
  maxQueueAgeMs?: number;
  lastDeliveredAt?: string;
  lastErrorCode?: string;
  blockedItems?: AgentWebhookDeliveryItemV1[];
  queuedItems?: AgentWebhookDeliveryItemV1[];
};

export type ShadowComparisonV1 = {
  schemaVersion: 1;
  shadow: true;
  expected: Pick<ShadowTotalsV1, "runCount" | "inputTokens" | "outputTokens" | "totalTokens" | "estimatedNanoUsd">;
  actual: Pick<ShadowTotalsV1, "runCount" | "inputTokens" | "outputTokens" | "totalTokens" | "estimatedNanoUsd">;
  matches: boolean;
  reasonCodes: ("run_count_mismatch" | "input_tokens_mismatch" | "output_tokens_mismatch" | "total_tokens_mismatch" | "estimated_cost_mismatch")[];
};

export type ClientKind = "tirionctl" | "installer" | "test";

export type ClientCapability =
  | "runtime:read"
  | "runtime:control"
  | "clients:manage"
  | "sources:read"
  | "sources:manage"
  | "repositories:read"
  | "repositories:manage"
  | "runs:read"
  | "runs:export"
  | "execution:read"
  | "attribution:read"
  | "webhooks:read"
  | "webhooks:manage"
  | "diagnostics:read";

export type ProtocolVersionV1 = {
  major: number;
  minor: number;
};

export type HandshakeRequestV1 = {
  schemaVersion: 1;
  clientKind: ClientKind;
  clientVersion: string;
  protocol: ProtocolVersionV1;
  eventSchemaVersions: number[];
  requestedCapabilities: ClientCapability[];
  environmentId?: string;
};

export type HandshakeResponseV1 = {
  schemaVersion: 1;
  protocol: ProtocolVersionV1;
  agentVersion: string;
  runtimeVersion: string;
  environmentId: string;
  installationId: string;
  ownershipState: OwnershipState;
  enabledCapabilities: ClientCapability[];
  warnings: SafeErrorCode[];
  readOnly: boolean;
  degraded: boolean;
};

export type AgentHealth = "starting" | "healthy" | "degraded" | "stopping";

export type AgentStatusV1 = {
  schemaVersion: 1;
  health: AgentHealth;
  agentVersion: string;
  runtimeVersion: string;
  installationId: string;
  environmentId: string;
  ownershipState: OwnershipState;
  protocol: ProtocolVersionV1;
  databaseSchemaVersion: number;
  startedAt: string;
  pid: number;
  runtimeWarmupState?: "starting" | "ready" | "failed";
  runtimeWarmupLastErrorCode?: SafeErrorCode;
  fullOwnerBootstrapState?: "not_required" | "deferred" | "running" | "ready" | "failed";
  fullOwnerBootstrapLastErrorCode?: SafeErrorCode;
  historicalReconciliationState?: "not_required" | "deferred" | "running" | "ready" | "failed";
  historicalReconciliationLastErrorCode?: SafeErrorCode;
  otlp?: {
    host: "127.0.0.1";
    port: number;
    paths: ("/v1/traces" | "/v1/logs" | "/v1/metrics")[];
  };
};

export type AgentVersionV1 = {
  schemaVersion: 1;
  agentVersion: string;
  runtimeVersion: string;
  protocol: ProtocolVersionV1;
  databaseSchemaVersion: number;
};

export type AgentUpgradePreparationV1 = {
  schemaVersion: 1;
  backupAvailable: true;
  databaseSchemaVersion: number;
  preparedAt: string;
};

export type AgentRollbackInfoV1 = {
  schemaVersion: 1;
  backupAvailable: true;
  agentVersion: string;
  databaseSchemaVersion: number;
  preparedAt: string;
};

export type AgentDoctorV1 = {
  schemaVersion: 1;
  health: AgentHealth;
  ownershipState: OwnershipState;
  databaseIntegrity: "ok" | "failed" | "unavailable";
  checks: {
    singleOwner: boolean;
    storageWorker: boolean;
    protocolCompatible: boolean;
    privateStateDirectory: boolean;
    privateControlSocket: boolean;
  };
  facts: {
    sourceCount: number;
    sourceProviders: SafeObservationV1["provider"][];
    sourceStatuses: ProviderSourceStatusV1[];
    productionRunCount: number;
    unpricedRunCount: number;
    repositoryScopeCount: number;
    activeRepositoryScopeCount: number;
    unavailableRepositoryScopeCount: number;
    pausedRepositoryScopeCount: number;
    workspaceLeaseCount: number;
    verifiedAttributionCount: number;
    budgetWarningCount: number;
    journalOverflowCount: number;
    runtimeWarmupState: "starting" | "ready" | "failed";
    runtimeWarmupLastErrorCode?: SafeErrorCode;
    fullOwnerBootstrapState: "not_required" | "deferred" | "running" | "ready" | "failed";
    fullOwnerBootstrapLastErrorCode?: SafeErrorCode;
    historicalReconciliationState: "not_required" | "deferred" | "running" | "ready" | "failed";
    historicalReconciliationLastErrorCode?: SafeErrorCode;
    historicalCutoffAt?: string;
    processedCompletedRunCount: number;
    deferredCompletedRunCount: number;
  };
};

export type AgentHistoricalReconciliationStatusV1 = {
  schemaVersion: 1;
  state: "not_required" | "deferred" | "running" | "ready" | "failed";
  liveFirst: true;
  historicalSecond: true;
  historicalCutoffAt?: string;
  processedCompletedRunCount: number;
  deferredCompletedRunCount: number;
  lastErrorCode?: SafeErrorCode;
};

export type AgentSupportBundleV1 = {
  schemaVersion: 1;
  generatedAt: string;
  version: AgentVersionV1;
  status: Omit<AgentStatusV1, "installationId" | "environmentId" | "pid">;
  doctor: AgentDoctorV1;
  diagnostics: AgentDiagnosticsV1;
};

export type ClientSummaryV1 = {
  schemaVersion: 1;
  clientId: string;
  kind: ClientKind;
  capabilities: ClientCapability[];
  issuedAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type PairClientRequestV1 = {
  schemaVersion: 1;
  kind: ClientKind;
  nonce: string;
  capabilities: ClientCapability[];
};

export type PairClientResponseV1 = {
  schemaVersion: 1;
  client: ClientSummaryV1;
  credential: string;
  nonce: string;
};

export type SafeErrorCode =
  | "agent_unavailable"
  | "agent_stopping"
  | "authentication_required"
  | "authorization_denied"
  | "client_revoked"
  | "invalid_request"
  | "protocol_major_mismatch"
  | "unsupported_capability"
  | "ownership_conflict"
  | "storage_unavailable"
  | "internal_error";

export type ErrorResponseV1 = {
  schemaVersion: 1;
  error: SafeErrorCode;
};

const HANDSHAKE_KEYS = new Set([
  "schemaVersion",
  "clientKind",
  "clientVersion",
  "protocol",
  "eventSchemaVersions",
  "requestedCapabilities",
  "environmentId"
]);
const PUBLIC_OWNERSHIP_MARKER_KEYS = new Set(["schemaVersion", "state", "updatedAt"]);
const PROTOCOL_KEYS = new Set(["major", "minor"]);
const PAIR_KEYS = new Set(["schemaVersion", "kind", "nonce", "capabilities"]);
const SOURCE_CAPABILITY_KEYS = new Set([
  "schemaVersion",
  "sourceId",
  "sourceKind",
  "provider",
  "runtime",
  "environmentId",
  "profileVersion",
  "granularity",
  "tokenDimensions",
  "billingEvidence",
  "durability",
  "contentRisk",
  "compatibility",
  "evidenceGrade"
]);
const COPILOT_SPAN_DB_CONFIGURATION_KEYS = new Set([
  "schemaVersion",
  "enabled",
  "spanDbPath",
  "captureContent",
  "dbSpanExporter"
]);

const CLIENT_KINDS: readonly ClientKind[] = ["tirionctl", "installer", "test"];
const CAPABILITIES: readonly ClientCapability[] = [
  "runtime:read",
  "runtime:control",
  "clients:manage",
  "sources:read",
  "sources:manage",
  "repositories:read",
  "repositories:manage",
  "runs:read",
  "runs:export",
  "execution:read",
  "attribution:read",
  "webhooks:read",
  "webhooks:manage",
  "diagnostics:read"
];

export const ADMIN_CAPABILITIES: readonly ClientCapability[] = CAPABILITIES;
export function ownershipManifestFor(state: OwnershipState, updatedAt: string): OwnershipManifestV1 {
  const owner: MutableStateOwner = state === "extension_legacy" ? "extension" : "agent";
  return {
    schemaVersion: 1,
    state,
    updatedAt,
    owners: {
      source_registry: owner,
      source_checkpoints: owner,
      safe_observation_journal: "agent",
      query_occurrence_ledger: "agent",
      execution_tree_ledger: "agent",
      run_ledger: owner,
      repository_scope_registry: "agent",
      repository_observation_state: owner,
      workspace_evidence: owner,
      work_episodes: owner,
      commit_attribution_ledger: owner,
      webhook_outbox: owner,
      budget_state: owner,
      diagnostic_state: owner,
      agent_metadata: "agent"
    }
  };
}

export function publicOwnershipMarkerFor(state: OwnershipState, updatedAt: string): PublicOwnershipMarkerV1 {
  return { schemaVersion: 1, state, updatedAt };
}

export function parsePublicOwnershipMarkerV1(value: unknown): PublicOwnershipMarkerV1 {
  if (
    !isRecordWithOnly(value, PUBLIC_OWNERSHIP_MARKER_KEYS)
    || value.schemaVersion !== 1
    || !isOwnershipState(value.state)
    || !isIsoTimestamp(value.updatedAt)
  ) {
    throw new Error("Public ownership marker is invalid.");
  }
  return value as PublicOwnershipMarkerV1;
}

export function agentOwnsUsage(state: OwnershipState): boolean {
  return state === "agent_usage_owner" || state === "agent_full_owner";
}

export function parseHandshakeRequestV1(value: unknown): HandshakeRequestV1 {
  if (!isRecordWithOnly(value, HANDSHAKE_KEYS)) {
    throw new Error("Handshake contains unsupported fields.");
  }
  if (
    value.schemaVersion !== 1
    || !isClientKind(value.clientKind)
    || !isBoundedText(value.clientVersion, 100)
    || !isProtocolVersion(value.protocol)
    || !isIntegerArray(value.eventSchemaVersions)
    || !isCapabilityArray(value.requestedCapabilities)
    || (value.environmentId != null && !isOpaqueId(value.environmentId))
  ) {
    throw new Error("Handshake is invalid.");
  }
  return value as HandshakeRequestV1;
}

export function parsePairClientRequestV1(value: unknown): PairClientRequestV1 {
  if (!isRecordWithOnly(value, PAIR_KEYS)) {
    throw new Error("Pair request contains unsupported fields.");
  }
  if (
    value.schemaVersion !== 1
    || !isClientKind(value.kind)
    || !isOpaqueId(value.nonce)
    || !isCapabilityArray(value.capabilities)
  ) {
    throw new Error("Pair request is invalid.");
  }
  return value as PairClientRequestV1;
}

export function parseSourceCapabilityV1(value: unknown): SourceCapabilityV1 {
  if (!isRecordWithOnly(value, SOURCE_CAPABILITY_KEYS)) {
    throw new Error("Source capability contains unsupported fields.");
  }
  if (
    value.schemaVersion !== 1
    || !isOpaqueId(value.sourceId)
    || !isBoundedText(value.sourceKind, 100)
    || !isBoundedText(value.provider, 100)
    || !isBoundedText(value.runtime, 100)
    || !isOpaqueId(value.environmentId)
    || !isBoundedText(value.profileVersion, 100)
    || !isStringArray(value.granularity, ["aggregate", "request", "prompt", "turn", "run"])
    || !isBoundedStringArray(value.tokenDimensions)
    || !isBoundedStringArray(value.billingEvidence)
    || !["durable_checkpoint", "at_least_once", "ephemeral"].includes(value.durability as string)
    || !["metadata_only", "content_possible", "content_expected"].includes(value.contentRisk as string)
    || !["supported", "degraded", "unsupported"].includes(value.compatibility as string)
    || !["verified_commit_cost", "estimated_usage_cost_unattributed", "provider_reported_ai_contribution", "unsupported"].includes(value.evidenceGrade as string)
  ) {
    throw new Error("Source capability is invalid.");
  }
  return value as SourceCapabilityV1;
}

export function parseCopilotSpanDbConfigurationV1(value: unknown): CopilotSpanDbConfigurationV1 {
  if (!isRecordWithOnly(value, COPILOT_SPAN_DB_CONFIGURATION_KEYS)) {
    throw new Error("Copilot span DB configuration contains unsupported fields.");
  }
  if (
    value.schemaVersion !== 1
    || typeof value.enabled !== "boolean"
    || typeof value.captureContent !== "boolean"
    || typeof value.dbSpanExporter !== "boolean"
    || (value.spanDbPath != null && !isBoundedText(value.spanDbPath, 2_000))
    || (value.enabled && !isBoundedText(value.spanDbPath, 2_000))
  ) {
    throw new Error("Copilot span DB configuration is invalid.");
  }
  return value as CopilotSpanDbConfigurationV1;
}

export function negotiateProtocol(requested: ProtocolVersionV1): ProtocolVersionV1 {
  if (requested.major !== AGENT_PROTOCOL_MAJOR) {
    throw new Error("protocol_major_mismatch");
  }
  return { major: AGENT_PROTOCOL_MAJOR, minor: Math.min(requested.minor, AGENT_PROTOCOL_MINOR) };
}

export function errorResponse(error: SafeErrorCode): ErrorResponseV1 {
  return { schemaVersion: 1, error };
}

function isRecordWithOnly(value: unknown, keys: Set<string>): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocolVersion(value: unknown): value is ProtocolVersionV1 {
  return isRecordWithOnly(value, PROTOCOL_KEYS)
    && isNonNegativeInteger(value.major)
    && isNonNegativeInteger(value.minor);
}

function isClientKind(value: unknown): value is ClientKind {
  return CLIENT_KINDS.includes(value as ClientKind);
}

function isOwnershipState(value: unknown): value is OwnershipState {
  return ["extension_legacy", "agent_shadow", "agent_usage_owner", "agent_full_owner"].includes(value as OwnershipState);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCapabilityArray(value: unknown): value is ClientCapability[] {
  return Array.isArray(value)
    && value.length <= CAPABILITIES.length
    && new Set(value).size === value.length
    && value.every((item) => CAPABILITIES.includes(item as ClientCapability));
}

function isIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length <= 20
    && value.every(isNonNegativeInteger);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(value);
}

function isBoundedStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 30
    && value.every((item) => isBoundedText(item, 100));
}

function isStringArray(value: unknown, allowed: readonly string[]): value is string[] {
  return isBoundedStringArray(value) && value.every((item) => allowed.includes(item));
}
