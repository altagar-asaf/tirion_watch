import { createHash, randomUUID } from "node:crypto";
import type {
  BillingContextV1,
  ExecutionNodeAtomV1,
  ExecutionNodeContentV1,
  QueryOccurrenceV1,
  RunCompletionFailureCategory,
  SafeActivityAtomV1,
  SensitiveAuditEvidenceV1,
  SafeObservationV1,
  SafeUsageAtomV1,
  SafeUsageAuthority,
  SourceCapabilityV1,
  TelemetrySignal,
  UsagePurposeV1,
  WebhookEvidenceBasisV1
} from "@tirion/agent-contract";
import { resolveModelProvider } from "./modelProviderResolution";

type SensitiveAuditCanonicalKind = Extract<ExecutionNodeContentV1["kind"], "tool_input" | "tool_output" | "path" | "diff" | "file_content">;
type SensitiveAuditKeyDefinition = {
  kind: SensitiveAuditEvidenceV1["kind"];
  canonicalKind: SensitiveAuditCanonicalKind;
  displayLabel: string;
  keys: string[];
};

export type PrivacyApprovedOtlpMetadata = {
  signal: TelemetrySignal;
  serviceNames: string[];
  resourceCount: number;
  recordCount: number;
  observedAt: string;
  queryOccurrences: QueryOccurrenceV1[];
  activityAtoms: SafeActivityAtomV1[];
  executionNodes: ExecutionNodeAtomV1[];
  usageAtoms: SafeUsageAtomV1[];
};

export const OTLP_MAX_RESOURCES = 64;
export const OTLP_MAX_SCOPES_PER_RESOURCE = 128;
export const OTLP_MAX_RECORDS = 10_000;
export const OTLP_MAX_ATTRIBUTES = 2_048;
const MAX_ACTIVE_PROVIDER_QUERIES = 1_024;
const MAX_CLAUDE_BACKGROUND_ROOT_DIAGNOSTIC_COUNT = 8;
const CODEX_HOOK_RECONCILIATION_MS = 15_000;
const TIRION_CLAUDE_SUBMISSION_ATTEMPT_FIELD = "tirion_claude_submission_attempt_id";

type ProviderHookSource = Extract<SafeObservationV1["provider"], "claude-code" | "codex" | "cursor">;
type ActiveProviderQuery = {
  query: string;
  startedAt: string;
};
type ClaudeQueryIdentity = {
  query: string;
  session: string;
};
type ClaudeRequestIdentity = ClaudeQueryIdentity & {
  usagePurpose?: UsagePurposeV1;
};
type ProviderTelemetryIdentity = ClaudeRequestIdentity & {
  request: string;
};
type ClaudeCorrelation<T> =
  | { state: "resolved"; value: T }
  | { state: "conflict" };
type ClaudeUsageOwnerCorrelation =
  | { state: "resolved"; value: string }
  | { state: "conflict"; activityIds: string[] };
type ClaudeStopCandidate = ActiveProviderQuery & {
  session: string;
  stoppedAt: string;
};
type ClaudeClosedInteraction = ClaudeQueryIdentity & {
  completedAt: string;
  nativePrompt?: string;
};
type ClaudeAcceptedSubmission = ActiveProviderQuery & {
  session: string;
};
type ClaudeCompletedSubmission = ClaudeAcceptedSubmission & {
  terminalKind: "closed_root" | "stop_failure";
  completedAt: string;
  failureCategory?: RunCompletionFailureCategory;
};
export type ClaudeTranscriptTailUnavailableReason =
  | "transcript_locator_invalid"
  | "transcript_trust_rejected"
  | "transcript_read_unavailable"
  | "transcript_read_unstable";
export type ClaudeTranscriptTailInput =
  | { state: "available"; tail: string; truncated: boolean }
  | {
      state: "unavailable";
      /** Fixed non-content reason supplied by the trusted transcript reader. */
      diagnosticReason?: ClaudeTranscriptTailUnavailableReason;
    };
export type ClaudeSubmissionProvenanceDiagnosticReason =
  | ClaudeTranscriptTailUnavailableReason
  | "transcript_tail_exceeded"
  | "hook_identity_unavailable"
  | "transcript_candidate_missing"
  | "idless_candidate_stale"
  | "prompt_digest_mismatch"
  | "prompt_identity_conflict"
  | "candidate_ambiguous"
  | "transcript_origin_kind_missing"
  | "transcript_origin_kind_unrecognized"
  | "transcript_prompt_source_missing"
  | "transcript_prompt_source_unrecognized"
  | "transcript_origin_prompt_source_incompatible"
  /** Retained only to safely reduce diagnostics from older in-memory attempts. */
  | "origin_not_human_typed"
  | "malformed_provenance";
type ClaudeSubmissionProvenance =
  | {
      state: "resolved";
      originKind: "human" | "task-notification";
      promptSource: "typed" | "system";
      transcriptPromptId: string;
      transcriptRecordKey?: string;
      transcriptReservationKey?: string;
    }
  | {
      state: "unavailable";
      diagnosticReason?: ClaudeSubmissionProvenanceDiagnosticReason;
    }
  | {
      state: "ambiguous";
      diagnosticReason?: ClaudeSubmissionProvenanceDiagnosticReason;
    };
type ActiveCodexQuery = ActiveProviderQuery & {
  session: string;
  queryBasis: "hook" | "explicit" | "fallback";
};
type ActiveCursorTurn = ActiveProviderQuery & {
  session: string;
  model?: string;
  usage?: ReturnType<typeof tokenUsage>;
};

export class DefaultAgentPrivacyGuard {
  private readonly codexQueriesBySession = new Map<string, ActiveCodexQuery>();
  private readonly codexQueriesByQuery = new Map<string, ActiveCodexQuery>();
  private readonly claudeQueriesBySession = new Map<string, { query: string; startedAt: string }>();
  private readonly claudeSubmissionHooksBySession = new Map<string, ActiveProviderQuery>();
  private readonly claudeQueriesByPrompt = new Map<string, ClaudeCorrelation<ClaudeQueryIdentity>>();
  private readonly claudeQueriesByTrace = new Map<string, ClaudeCorrelation<ClaudeQueryIdentity>>();
  private readonly claudeQueriesByRequest = new Map<string, ClaudeCorrelation<ClaudeRequestIdentity>>();
  private readonly claudeNativePromptsByTrace = new Map<string, ClaudeCorrelation<string>>();
  private readonly claudeTraceParents = new Map<string, ClaudeCorrelation<string>>();
  private readonly claudeTraceToolActivities = new Map<string, ClaudeCorrelation<string>>();
  private readonly claudeUsageOwnersByRequest = new Map<string, ClaudeUsageOwnerCorrelation>();
  private readonly claudeAcceptedSubmissionsByIdentity = new Map<string, ClaudeAcceptedSubmission>();
  private readonly claudeStopCandidatesByIdentity = new Map<string, ClaudeStopCandidate>();
  private readonly claudeClosedInteractionsByIdentity = new Map<string, ClaudeClosedInteraction>();
  private readonly claudeContinuationAuthorizedByIdentity = new Map<string, true>();
  private readonly claudeTaskNotificationTargetBySession = new Map<string, ClaudeAcceptedSubmission>();
  private readonly claudeContinuationFloorsByIdentity = new Map<string, string>();
  private readonly claudeBackgroundPausedNativePrompts = new Map<string, ClaudeQueryIdentity>();
  // This exists solely to make an incomplete background-root boundary visible
  // at a later SessionEnd. Its keys are opaque, and it must never be terminal authority.
  private readonly claudeBackgroundRootsAwaitingTerminalByIdentity = new Map<string, true>();
  private readonly claudeCompletedSubmissionsByIdentity = new Map<string, ClaudeCompletedSubmission>();
  private readonly claudeLatestCompletedBySession = new Map<string, ClaudeCompletedSubmission>();
  private readonly claudeCompletedPromptAliases = new Map<string, ClaudeQueryIdentity>();
  private readonly claudeConsumedTranscriptRows = new Set<string>();
  private readonly claudeTranscriptRowReservations = new Map<string, string>();
  private readonly claudeSubagentStarts = new Map<string, string>();
  private readonly cursorTurnsByGeneration = new Map<string, ActiveCursorTurn>();
  private readonly cursorOpenGenerationBySession = new Map<string, string>();
  private readonly codexSubagentStarts = new Map<string, string>();
  private readonly codexInternalQueries = new Set<string>();
  private readonly codexInternalSessions = new Set<string>();

  constructor(
    private readonly capturePrompts: (provider: SafeObservationV1["provider"]) => boolean = () => false,
    private readonly captureSensitiveAuditEvidence: () => boolean = () => false
  ) {}

  annotateClaudeProviderHook(
    raw: unknown,
    transcript: ClaudeTranscriptTailInput,
    observedAt: string
  ): unknown {
    if (!isRecord(raw)) {
      return raw;
    }
    const reservationKey = claudeSubmissionReservationKey(raw, observedAt);
    const provenance = resolveClaudeSubmissionProvenance(
      raw,
      transcript,
      observedAt,
      this.claudeConsumedTranscriptRows,
      this.claudeTranscriptRowReservations,
      reservationKey
    );
    const promptDigest = claudeSubmissionHookPromptDigest(raw);
    return {
      ...raw,
      ...(promptDigest ? { [TIRION_CLAUDE_PROMPT_DIGEST_FIELD]: promptDigest } : {}),
      tirion_claude_submission_provenance: provenance
    };
  }

  commitClaudeTranscriptProvenance(raw: unknown): void {
    if (!isRecord(raw) || !isRecord(raw.tirion_claude_submission_provenance)) {
      return;
    }
    const provenance = raw.tirion_claude_submission_provenance;
    const transcriptRecordKey = boundedOpaqueText(firstText(provenance.transcriptRecordKey));
    if (provenance.state !== "resolved" || !transcriptRecordKey) {
      return;
    }
    const reservationKey = boundedOpaqueText(firstText(provenance.transcriptReservationKey));
    const reservedBy = this.claudeTranscriptRowReservations.get(transcriptRecordKey);
    if (!reservationKey || (reservedBy && reservedBy !== reservationKey)) {
      return;
    }
    this.claudeTranscriptRowReservations.delete(transcriptRecordKey);
    this.claudeConsumedTranscriptRows.add(transcriptRecordKey);
    pruneInsertionOrderedSet(this.claudeConsumedTranscriptRows, MAX_ACTIVE_PROVIDER_QUERIES);
  }

  releaseClaudeTranscriptProvenance(raw: unknown): void {
    if (!isRecord(raw) || !isRecord(raw.tirion_claude_submission_provenance)) {
      return;
    }
    const provenance = raw.tirion_claude_submission_provenance;
    const transcriptRecordKey = boundedOpaqueText(firstText(provenance.transcriptRecordKey));
    if (!transcriptRecordKey) {
      return;
    }
    const reservationKey = boundedOpaqueText(firstText(provenance.transcriptReservationKey));
    if (reservationKey && this.claudeTranscriptRowReservations.get(transcriptRecordKey) === reservationKey) {
      this.claudeTranscriptRowReservations.delete(transcriptRecordKey);
    }
  }

  sanitizeOtlpEnvelope(raw: unknown, signal: TelemetrySignal, observedAt: string): PrivacyApprovedOtlpMetadata {
    if (!isRecord(raw)) {
      throw new Error("invalid_request");
    }
    const resources = resourceItems(raw, signal);
    assertEnvelopeLimits(resources, signal);
    const serviceNames = resources.flatMap((resource) => serviceNamesFrom(resource)).slice(0, 20);
    return {
      signal,
      serviceNames,
      resourceCount: resources.length,
      recordCount: resources.reduce((sum, resource) => sum + recordCount(resource, signal), 0),
      observedAt,
      queryOccurrences: [],
      activityAtoms: [],
      executionNodes: [],
      usageAtoms: []
    };
  }

  sanitizeUsageAtoms(
    raw: unknown,
    signal: TelemetrySignal,
    classification: ReturnType<DefaultTelemetryClassification["classify"]>,
    observedAt: string
  ): SafeUsageAtomV1[] {
    if (!isRecord(raw)) {
      throw new Error("invalid_request");
    }
    if (classification.provider === "codex" && signal === "logs") {
      return this.sanitizeCodexLogUsageAtoms(raw, classification, observedAt);
    }
    return resourceItems(raw, signal).flatMap((resource) => {
      const resourceAttributes = otlpAttributes(isRecord(resource.resource) ? resource.resource.attributes : undefined);
      // A native Claude permission decision can carry copied model, usage, or
      // billing attributes, but it is not an executed request. Exclude it
      // before identity, ownership, and usage processing so it cannot become
      // an accounting or context atom through any path.
      const records = usageRecords(resource, signal).filter((record) => {
        if (classification.provider !== "claude-code") {
          return true;
        }
        const attributes = recordAttributes(resourceAttributes, record);
        const name = firstText(record.name, attributes["event.name"]) ?? "";
        return !isClaudeToolDecisionEventName(normalizedName(name));
      });
      const owningTools = owningToolActivityIds(
        classification.provider,
        signal,
        records,
        resourceAttributes,
        classification.provider === "claude-code" && signal === "traces"
          ? {
              parents: this.claudeTraceParents,
              toolActivities: this.claudeTraceToolActivities
            }
          : undefined
      );
      return records.flatMap((record) => {
        const attributes = recordAttributes(resourceAttributes, record);
        const usage = tokenUsage(attributes);
        const name = firstText(record.name, attributes["event.name"]) ?? "";
        const reportedNanoUsd = providerReportedNanoUsd(classification.provider, name, attributes);
        if (!hasUsage(usage) && reportedNanoUsd == null) {
          return [];
        }
        const providerScopedIdentity = this.telemetryIdentity(classification.provider, record, attributes, name);
        const codexPromptIdentity = this.codexActivityIdentity(classification.provider, attributes);
        const identity = classification.provider === "codex" && signal === "traces"
          ? mergeCodexTraceIdentity(providerScopedIdentity, codexPromptIdentity)
          : providerScopedIdentity ?? codexPromptIdentity;
        if (!identity) {
          return [];
        }
        const model = safeModel(firstText(
          attributes["gen_ai.request.model"],
          attributes["gen_ai.response.model"],
          attributes["model"],
          attributes["llm.model_name"]
        ));
        const modelProvider = resolveModelProvider({
          model,
          reportedProvider: firstText(
            attributes["gen_ai.provider.name"],
            attributes["provider_name"],
            attributes["provider.name"],
            attributes["llm.provider"]
          )
        });
        const startedAt = timestampToIso(firstText(record.startTimeUnixNano, record.timeUnixNano), observedAt);
        const completedTimestamp = signal === "logs"
          ? firstText(record.timeUnixNano)
          : firstText(record.endTimeUnixNano);
        const candidateEndedAt = optionalTimestampToIso(completedTimestamp);
        const endedAt = candidateEndedAt && candidateEndedAt >= startedAt ? candidateEndedAt : undefined;
        const authority = usageAuthority(classification.provider, name);
        const queryId = opaqueHash("qry", `${classification.provider}|${identity.query}`);
        const sessionId = opaqueHash("ses", `${classification.provider}|${identity.session}`);
        const requestId = opaqueHash("req", `${classification.provider}|${identity.request}`);
        const observedOwningActivityId = owningTools.get(
          owningToolRecordKey(classification.provider, signal, record)
        );
        const ownership = classification.provider === "claude-code"
          ? this.claudeActivityOwnershipForRequest(requestId, observedOwningActivityId)
          : { owningActivityId: observedOwningActivityId };
        const atomIdentity = [
          classification.provider,
          identity.query,
          identity.request,
          "usage",
          authority,
          startedAt
        ].join("|");
        return [{
          schemaVersion: 1,
          atomId: opaqueHash("atom", atomIdentity),
          correlationId: queryId,
          queryId,
          sessionId,
          requestId,
          ...ownership,
          signal,
          sourceId: classification.sourceId,
          profileVersion: classification.profileVersion,
          provider: classification.provider,
          runtime: classification.runtime,
          authority,
          completionMode: completionModeFor(classification.provider, signal, name),
          ...(identity.usagePurpose ? { usagePurpose: identity.usagePurpose } : {}),
          billingContext: billingContextFrom(classification.provider, attributes, model),
          providerReportedNanoUsd: reportedNanoUsd,
          model,
          ...modelProvider,
          ...usage,
          startedAt,
          endedAt
        }];
      });
    });
  }

  sanitizeActivityAtoms(
    raw: unknown,
    signal: TelemetrySignal,
    classification: ReturnType<DefaultTelemetryClassification["classify"]>,
    observedAt: string
  ): SafeActivityAtomV1[] {
    if (!isRecord(raw)) {
      throw new Error("invalid_request");
    }
    if (classification.provider === "codex" && signal === "metrics") {
      return this.sanitizeCodexMetricActivityAtoms(raw, classification, observedAt);
    }
    return resourceItems(raw, signal).flatMap((resource) => {
      const resourceAttributes = otlpAttributes(isRecord(resource.resource) ? resource.resource.attributes : undefined);
      return usageRecords(resource, signal).flatMap((record): SafeActivityAtomV1[] => {
        const attributes = recordAttributes(resourceAttributes, record);
        const name = firstText(record.name, attributes["event.name"]) ?? "";
        const isClaudeToolDecision = classification.provider === "claude-code"
          && isClaudeToolDecisionEventName(normalizedName(name));
        const codexToolCallId = classification.provider === "codex"
          && normalizedName(name) === "codex.tool_result"
          ? firstText(attributes["call_id"], attributes["tool.call.id"], attributes["gen_ai.tool.call.id"])
          : undefined;
        const descriptor = classification.provider === "codex" && !codexToolCallId
          ? undefined
          : activityDescriptor(classification.provider, name, attributes);
        if (!descriptor) {
          return [];
        }
        const providerScopedIdentity = this.telemetryIdentity(classification.provider, record, attributes, name);
        const codexPromptIdentity = this.codexActivityIdentity(classification.provider, attributes);
        const identity = classification.provider === "codex"
          ? mergeCodexTraceIdentity(providerScopedIdentity, codexPromptIdentity)
          : providerScopedIdentity ?? codexPromptIdentity;
        if (!identity) {
          return [];
        }
        const startedAt = timestampToIso(
          firstText(attributes["event.timestamp"], record.startTimeUnixNano, record.timeUnixNano),
          observedAt
        );
        const traceId = firstText(record.traceId) ?? identity.query;
        const toolUseId = firstText(attributes["tool_use_id"]);
        const spanId = firstText(
          toolUseId,
          codexToolCallId,
          attributes["call_id"],
          attributes["tool.call.id"],
          record.spanId
        )
          ?? `${descriptor.name}|${startedAt}`;
        const requestId = opaqueHash("req", `${classification.provider}|${spanId}`);
        const rawEndedAt = optionalTimestampToIso(firstText(record.endTimeUnixNano, record.timeUnixNano));
        const endedAt = isClaudeToolDecision ? undefined : rawEndedAt;
        // A permission decision is not an execution result. Retain only its
        // timestamp and safe outcome, never a duration or result measurement.
        const durationMs = isClaudeToolDecision
          ? undefined
          : nonnegativeInteger(firstText(attributes["duration_ms"]))
            ?? durationBetween(startedAt, rawEndedAt);
        const resultSizeBytes = isClaudeToolDecision
          ? undefined
          : nonnegativeInteger(firstText(
              attributes["output_length"],
              attributes["result_size_bytes"],
              attributes["result_bytes"]
            ));
        const providerReportedResultTokens = isClaudeToolDecision
          ? undefined
          : nonnegativeInteger(firstText(
              attributes["tool_token_count"],
              attributes["result_tokens"]
            ));
        const outcome = providerActivityOutcome(
          classification.provider,
          name,
          descriptor.name,
          record,
          attributes
        );
        // Claude emits a permission decision for the same tool_use_id as the
        // eventual tool result or hook. Keep it as separately addressable
        // evidence; requestId still joins the evidence into one semantic tool.
        const activityId = isClaudeToolDecision
          ? nativeClaudeToolDecisionActivityId(traceId, spanId)
          : activityIdFor(classification.provider, traceId, spanId);
        return [{
          schemaVersion: 1,
          activityId,
          queryId: opaqueHash("qry", `${classification.provider}|${identity.query}`),
          sessionId: opaqueHash("ses", `${classification.provider}|${identity.session}`),
          requestId,
          ...(classification.provider === "claude-code" && toolUseId ? {
            invocationId: opaqueHash("invocation", `${classification.provider}|${toolUseId}`)
          } : {}),
          provider: classification.provider,
          runtime: classification.runtime,
          kind: descriptor.kind,
          name: descriptor.name,
          outcome,
          ...(isClaudeToolDecision && outcome === "rejected"
            ? { outcomeAuthority: "native_permission_decision" as const }
            : {}),
          ...(durationMs != null ? { durationMs } : {}),
          ...(resultSizeBytes != null ? { resultSizeBytes } : {}),
          ...(providerReportedResultTokens != null ? { providerReportedResultTokens } : {}),
          evidenceBasis: signal === "traces" ? "trace_span" : "otel_event",
          evidenceSourceId: classification.sourceId,
          evidenceProfileVersion: classification.profileVersion,
          identityConfidence: "medium",
          timingConfidence: "medium",
          ...(this.captureSensitiveAuditEvidence() && classification.provider !== "codex" && !isClaudeToolDecision
            ? { sensitiveAuditEvidence: sensitiveAuditEvidence(attributes, startedAt, descriptor) }
            : {}),
          startedAt,
          ...(endedAt && endedAt >= startedAt ? { endedAt } : {})
        }];
      });
    });
  }

  sanitizeExecutionNodes(
    raw: unknown,
    signal: TelemetrySignal,
    classification: ReturnType<DefaultTelemetryClassification["classify"]>,
    observedAt: string
  ): ExecutionNodeAtomV1[] {
    if (!isRecord(raw)) {
      throw new Error("invalid_request");
    }
    return resourceItems(raw, signal).flatMap((resource) => {
      const resourceAttributes = otlpAttributes(isRecord(resource.resource) ? resource.resource.attributes : undefined);
      return usageRecords(resource, signal).flatMap((record): ExecutionNodeAtomV1[] => {
        const attributes = recordAttributes(resourceAttributes, record);
        const name = firstText(record.name, attributes["event.name"]) ?? "";
        const normalized = normalizedName(name);
        const isClaudeToolDecision = classification.provider === "claude-code"
          && isClaudeToolDecisionEventName(normalized);
        const identity = this.telemetryIdentity(classification.provider, record, attributes, name)
          ?? this.codexActivityIdentity(classification.provider, attributes);
        if (!identity) {
          return [];
        }
        const queryId = opaqueHash("qry", `${classification.provider}|${identity.query}`);
        const sessionId = opaqueHash("ses", `${classification.provider}|${identity.session}`);
        const requestId = opaqueHash("req", `${classification.provider}|${identity.request}`);
        const startedAt = timestampToIso(
          firstText(attributes["event.timestamp"], record.startTimeUnixNano, record.timeUnixNano),
          observedAt
        );
        if (classification.provider === "claude-code") {
          this.rememberClaudeQuery(identity.session, { query: identity.query, startedAt });
        }

        if (isProviderPromptEvent(classification.provider, normalized)) {
          return [{
            schemaVersion: 1,
            nodeId: promptNodeId(queryId),
            queryId,
            sessionId,
            requestId,
            provider: classification.provider,
            runtime: classification.runtime,
            signal,
            nodeKind: "prompt",
            name: "Prompt",
            outcome: "success",
            startedAt
          }];
        }

        const descriptor = classification.provider === "codex"
          ? undefined
          : activityDescriptor(classification.provider, name, attributes);
        const usage = tokenUsage(attributes);
        // A Codex turn span is a cumulative accounting boundary, not another LLM
        // request. Keep its usage atom authority, but do not expose it as activity.
        if (
          classification.provider === "codex"
          && signal === "traces"
          && usageAuthority(classification.provider, name) === "turn"
        ) {
          return [];
        }
        const spanId = firstText(record.spanId);
        const traceId = firstText(record.traceId) ?? identity.request;
        const toolUseId = firstText(attributes["tool_use_id"]);
        const model = safeModel(firstText(
          attributes["gen_ai.request.model"],
          attributes["gen_ai.response.model"],
          attributes["model"],
          attributes["llm.model_name"]
        ));
        // Codex copies the active model onto startup, transport, persistence, and
        // response-plumbing records. Only token evidence makes those records
        // customer-visible LLM work; other providers retain explicit model evidence.
        const hasCustomerLlmEvidence = hasUsage(usage)
          || (classification.provider !== "codex" && Boolean(model));
        if (!descriptor && !hasCustomerLlmEvidence) {
          return [];
        }
        const nodeId = isClaudeToolDecision
          ? nativeClaudeToolDecisionExecutionNodeId(queryId, traceId, toolUseId ?? spanId ?? startedAt)
          : executionNodeId(classification.provider, queryId, traceId, spanId, startedAt, normalized || "event");
        const parentSpanId = firstText(record.parentSpanId);
        const parentNodeId = parentSpanId
          ? executionNodeId(classification.provider, queryId, traceId, parentSpanId)
          : promptNodeId(queryId);
        const rawEndedAt = optionalTimestampToIso(firstText(record.endTimeUnixNano, record.timeUnixNano));
        const endedAt = isClaudeToolDecision ? undefined : rawEndedAt;
        const durationMs = isClaudeToolDecision
          ? undefined
          : nonnegativeInteger(firstText(attributes["duration_ms"])) ?? durationBetween(startedAt, rawEndedAt);
        const outcome = descriptor
          ? providerActivityOutcome(
              classification.provider,
              name,
              descriptor.name,
              record,
              attributes
            )
          : explicitLlmOutcome(record, attributes, endedAt);
        return [{
          schemaVersion: 1,
          nodeId,
          queryId,
          sessionId,
          requestId,
          ...(toolUseId ? {
            // `requestId` deliberately remains the telemetry request identity.
            // Claude's tool decision and PostToolUse hook use different request
            // surfaces, so artifact authority joins them only on this opaque
            // provider tool-use identity.
            invocationId: opaqueHash("invocation", `${classification.provider}|${toolUseId}`)
          } : {}),
          provider: classification.provider,
          runtime: classification.runtime,
          signal,
          nodeKind: descriptor ? executionNodeKindForActivity(descriptor.kind) : "llm_request",
          name: descriptor?.name ?? executionNodeDisplayName(classification.provider, name, model),
          parentNodeId: nodeId === promptNodeId(queryId) ? undefined : parentNodeId,
          outcome,
          ...(isClaudeToolDecision && outcome === "rejected"
            ? { outcomeAuthority: "native_permission_decision" as const }
            : {}),
          startedAt,
          ...(endedAt && endedAt >= startedAt ? { endedAt } : {}),
          ...(durationMs != null ? { durationMs } : {}),
          toolName: descriptor?.name,
          // A native Claude permission decision is activity evidence only. It
          // must not retain model, token, or request-purpose/context fields
          // that make the decision look like an executed LLM request.
          ...(isClaudeToolDecision ? {} : {
            model,
            ...(identity.usagePurpose ? { usagePurpose: identity.usagePurpose } : {}),
            ...usage
          })
        }];
      });
    });
  }

  sanitizeQueryOccurrences(
    raw: unknown,
    signal: TelemetrySignal,
    classification: ReturnType<DefaultTelemetryClassification["classify"]>,
    observedAt: string
  ): QueryOccurrenceV1[] {
    if (!isRecord(raw)) {
      throw new Error("invalid_request");
    }
    return resourceItems(raw, signal).flatMap((resource) => {
      const resourceAttributes = otlpAttributes(isRecord(resource.resource) ? resource.resource.attributes : undefined);
      return usageRecords(resource, signal).flatMap((record) => {
        const attributes = recordAttributes(resourceAttributes, record);
        const name = normalizedName(firstText(record.name, attributes["event.name"]) ?? "");
        if (
          classification.provider === "claude-code"
          && signal === "traces"
          && name === "claude_code.interaction"
        ) {
          return this.sanitizeClaudeClosedInteraction(record, attributes, classification);
        }
        if (!isProviderPromptEvent(classification.provider, name) && !isProviderRootRunStart(classification.provider, signal, name)) {
          return [];
        }
        const identity = this.telemetryIdentity(classification.provider, record, attributes, name);
        if (!identity) {
          return [];
        }
        const startedAt = timestampToIso(
          firstText(attributes["event.timestamp"], record.startTimeUnixNano, record.timeUnixNano),
          observedAt
        );
        let occurrenceQuery = identity.query;
        let occurrenceSession = identity.session;
        let occurrenceStartedAt = startedAt;
        let lifecycleVisibility: QueryOccurrenceV1["lifecycleVisibility"];
        if (classification.provider === "codex") {
          const active = this.rememberCodexPromptQuery(
            identity,
            startedAt,
            codexExplicitTurnId(attributes) ? "explicit" : "fallback"
          );
          occurrenceQuery = active.query;
          occurrenceSession = active.session;
          occurrenceStartedAt = active.startedAt;
          lifecycleVisibility = this.isInternalCodexIdentity(active) ? "internal" : undefined;
        } else if (classification.provider === "claude-code") {
          this.rememberClaudeQuery(identity.session, { query: identity.query, startedAt });
          const accepted = this.claudeAcceptedSubmissionsByIdentity.get(
            claudeQueryIdentityKey(identity.session, identity.query)
          );
          const remembered = this.claudeQueriesBySession.get(identity.session);
          const authoritative = accepted
            ?? (remembered?.query === identity.query ? { ...remembered, session: identity.session } : undefined);
          if (authoritative) {
            occurrenceQuery = authoritative.query;
            occurrenceStartedAt = authoritative.startedAt;
          }
        }
        return [{
          schemaVersion: 1,
          queryId: opaqueHash("qry", `${classification.provider}|${occurrenceQuery}`),
          sessionId: opaqueHash("ses", `${classification.provider}|${occurrenceSession}`),
          ...(lifecycleVisibility ? { lifecycleVisibility } : {}),
          provider: classification.provider,
          runtime: classification.runtime,
          startedAt: occurrenceStartedAt,
          promptState: "disabled",
          evidence: queryOccurrenceEvidence(classification.provider, signal, name)
        }];
      });
    });
  }

  sanitizeProviderHookObservation(
    raw: unknown,
    provider: ProviderHookSource,
    observedAt: string
  ): SafeObservationV1 | undefined {
    if (!isRecord(raw)) {
      throw new Error("invalid_request");
    }
    return provider === "claude-code"
      ? this.sanitizeClaudeHookObservation(raw, observedAt)
      : provider === "codex"
        ? this.sanitizeCodexHookObservation(raw, observedAt)
        : this.sanitizeCursorHookObservation(raw, observedAt);
  }

  countClaudeBackgroundRootsAwaitingTerminal(session: unknown): number {
    const safeSession = typeof session === "string" ? boundedOpaqueText(session) : undefined;
    if (!safeSession) {
      return 0;
    }
    let count = 0;
    for (const submission of this.claudeAcceptedSubmissionsByIdentity.values()) {
      if (
        submission.session === safeSession
        && this.claudeBackgroundRootsAwaitingTerminalByIdentity.has(
          claudeBackgroundRootTerminalKey(submission.session, submission.query)
        )
      ) {
        count += 1;
        if (count >= MAX_CLAUDE_BACKGROUND_ROOT_DIAGNOSTIC_COUNT) {
          return MAX_CLAUDE_BACKGROUND_ROOT_DIAGNOSTIC_COUNT;
        }
      }
    }
    return count;
  }

  private sanitizeCodexLogUsageAtoms(
    raw: Record<string, unknown>,
    classification: ReturnType<DefaultTelemetryClassification["classify"]>,
    observedAt: string
  ): SafeUsageAtomV1[] {
    return resourceItems(raw, "logs").flatMap((resource) => {
      const resourceAttributes = otlpAttributes(isRecord(resource.resource) ? resource.resource.attributes : undefined);
      return usageRecords(resource, "logs").flatMap((record) => {
        const attributes = recordAttributes(resourceAttributes, record);
        const name = normalizedName(firstText(record.name, attributes["event.name"]) ?? "");
        // Codex JSON logs currently emit timeUnixNano as zero and carry the real event time as an attribute.
        const eventAt = timestampToIso(firstText(attributes["event.timestamp"], record.timeUnixNano), observedAt);
        if (isProviderPromptEvent("codex", name)) {
          const identity = providerIdentity("codex", record, attributes, name);
          if (identity) {
            this.rememberCodexPromptQuery(
              identity,
              eventAt,
              codexExplicitTurnId(attributes) ? "explicit" : "fallback"
            );
          }
          return [];
        }
        const usage = tokenUsage(attributes);
        if (
          name !== "codex.sse_event"
          || normalizedName(firstText(attributes["event.kind"]) ?? "") !== "response.completed"
          || !hasUsage(usage)
        ) {
          return [];
        }
        const identity = providerIdentity("codex", record, attributes, name)
          ?? sessionOnlyCodexIdentity(record, attributes);
        const current = this.codexRememberedQueryForIdentity(identity, codexExplicitTurnId(attributes));
        if (!current) {
          return [];
        }
        const request = firstText(
          attributes["response.id"],
          attributes["request.id"],
          attributes["event.id"],
          attributes["event.sequence"],
          record.spanId
        ) ?? `${current.query}|response.completed|${eventAt}`;
        return [safeAtom({
          classification,
          identity: { query: current.query, session: current.session, request },
          signal: "logs",
          authority: "request",
          completionMode: "inactivity",
          billingContext: billingContextFrom("codex", attributes),
          model: safeModel(firstText(attributes["model"], attributes["slug"], attributes["gen_ai.request.model"])),
          reportedModelProvider: firstText(
            attributes["gen_ai.provider.name"],
            attributes["provider_name"],
            attributes["provider.name"],
            attributes["llm.provider"]
          ),
          usage,
          startedAt: eventAt,
          endedAt: eventAt
        })];
      });
    });
  }

  private sanitizeCodexMetricActivityAtoms(
    raw: Record<string, unknown>,
    classification: ReturnType<DefaultTelemetryClassification["classify"]>,
    observedAt: string
  ): SafeActivityAtomV1[] {
    return metricDataPoints(raw).flatMap((point) => {
      if (!/(^|\.|_)skill(\.|_)injected$/i.test(point.metricName)) {
        return [];
      }
      const skillName = safeActivityName(firstText(point.attributes.skill));
      if (!skillName) {
        return [];
      }
      const eventAt = timestampToIso(firstText(point.timeUnixNano, point.startTimeUnixNano), observedAt);
      const identity = this.codexMetricActivityIdentity(eventAt);
      if (!identity) {
        return [];
      }
      const queryId = opaqueHash("qry", `${classification.provider}|${identity.query}`);
      const sessionId = opaqueHash("ses", `${classification.provider}|${identity.session}`);
      return [{
        schemaVersion: 1,
        activityId: activityIdFor(classification.provider, identity.query, `${point.metricName}|${skillName}|${eventAt}`),
        queryId,
        sessionId,
        provider: classification.provider,
        runtime: classification.runtime,
        kind: "skill",
        name: skillName,
        outcome: codexMetricOutcome(point.attributes.status),
        startedAt: eventAt,
        evidenceBasis: "provider_metric",
        evidenceSourceId: classification.sourceId,
        evidenceProfileVersion: classification.profileVersion,
        identityConfidence: "medium",
        timingConfidence: "medium"
      }];
    });
  }

  private rememberCodexQuery(session: string, query: { query: string; startedAt: string; queryBasis: ActiveCodexQuery["queryBasis"] }): void {
    const previous = this.codexQueriesBySession.get(session);
    if (previous) {
      this.forgetCodexQuery(previous.query);
    }
    this.forgetCodexQuery(query.query);
    const active: ActiveCodexQuery = { ...query, session };
    this.codexQueriesBySession.set(session, active);
    this.codexQueriesByQuery.set(active.query, active);
    this.pruneCodexQueries();
  }

  private rememberCodexHookQuery(session: string, query: string, startedAt: string): ActiveCodexQuery {
    const previous = this.codexQueriesBySession.get(session);
    if (
      previous?.queryBasis === "fallback"
      && Math.abs(Date.parse(startedAt) - Date.parse(previous.startedAt)) <= CODEX_HOOK_RECONCILIATION_MS
    ) {
      this.forgetCodexQuery(previous.query);
      const active: ActiveCodexQuery = {
        ...previous,
        queryBasis: "hook"
      };
      this.codexQueriesBySession.set(session, active);
      this.codexQueriesByQuery.set(active.query, active);
      this.codexQueriesByQuery.set(query, active);
      this.pruneCodexQueries();
      return active;
    }
    this.rememberCodexQuery(session, { query, startedAt, queryBasis: "hook" });
    return this.codexQueriesBySession.get(session)!;
  }

  private rememberCodexInternalQuery(session: string, query: string, startedAt: string): ActiveCodexQuery {
    const remembered = this.codexRememberedQueryForIdentity({ query, session }, query);
    if (!remembered) {
      this.rememberCodexQuery(session, { query, startedAt, queryBasis: "fallback" });
    }
    const active = remembered ?? this.codexQueriesBySession.get(session)!;
    this.codexInternalQueries.add(active.query);
    this.codexInternalQueries.add(query);
    this.codexInternalSessions.add(active.session);
    this.codexInternalSessions.add(session);
    this.pruneCodexInternalIdentities();
    return active;
  }

  private isInternalCodexIdentity(identity: { query?: string; session?: string }): boolean {
    return Boolean(
      (identity.query && this.codexInternalQueries.has(identity.query))
      || (identity.session && this.codexInternalSessions.has(identity.session))
    );
  }

  private pruneCodexInternalIdentities(): void {
    pruneInsertionOrderedSet(this.codexInternalQueries, MAX_ACTIVE_PROVIDER_QUERIES);
    pruneInsertionOrderedSet(this.codexInternalSessions, MAX_ACTIVE_PROVIDER_QUERIES);
  }

  private rememberCodexPromptQuery(
    identity: { query: string; session: string },
    startedAt: string,
    queryBasis: Exclude<ActiveCodexQuery["queryBasis"], "hook">
  ): ActiveCodexQuery {
    const previous = this.codexQueriesBySession.get(identity.session);
    if (
      queryBasis === "fallback"
      && previous?.queryBasis === "hook"
      && Math.abs(Date.parse(startedAt) - Date.parse(previous.startedAt)) <= 5_000
    ) {
      return previous;
    }
    this.rememberCodexQuery(identity.session, { query: identity.query, startedAt, queryBasis });
    return this.codexQueriesBySession.get(identity.session)!;
  }

  private rememberCodexSessionAlias(session: string | undefined, active: ActiveCodexQuery): void {
    if (!session || session === active.session) {
      return;
    }
    const existing = this.codexQueriesBySession.get(session);
    if (existing && existing.query !== active.query) {
      return;
    }
    this.codexQueriesBySession.delete(session);
    this.codexQueriesBySession.set(session, active);
    this.pruneCodexQueries();
  }

  private forgetCodexQuery(query: string): void {
    const canonicalQuery = this.codexQueriesByQuery.get(query)?.query ?? query;
    for (const [alias, candidate] of [...this.codexQueriesByQuery.entries()]) {
      if (candidate.query === canonicalQuery) {
        this.codexQueriesByQuery.delete(alias);
      }
    }
    for (const [session, candidate] of [...this.codexQueriesBySession.entries()]) {
      if (candidate.query === canonicalQuery) {
        this.codexQueriesBySession.delete(session);
      }
    }
  }

  private pruneCodexQueries(): void {
    while (this.codexQueriesBySession.size > MAX_ACTIVE_PROVIDER_QUERIES) {
      const oldestSession = this.codexQueriesBySession.keys().next().value;
      if (oldestSession == null) {
        break;
      }
      const oldest = this.codexQueriesBySession.get(oldestSession);
      this.codexQueriesBySession.delete(oldestSession);
      if (oldest?.session === oldestSession && this.codexQueriesByQuery.get(oldest.query) === oldest) {
        this.codexQueriesByQuery.delete(oldest.query);
      }
    }
    while (this.codexQueriesByQuery.size > MAX_ACTIVE_PROVIDER_QUERIES) {
      const oldestQuery = this.codexQueriesByQuery.keys().next().value;
      if (oldestQuery == null) {
        break;
      }
      this.forgetCodexQuery(oldestQuery);
    }
  }

  private codexRememberedQueryForIdentity(
    identity: { query?: string; session?: string } | undefined,
    explicitTurnId?: string
  ): ActiveCodexQuery | undefined {
    const query = explicitTurnId ?? identity?.query;
    if (query) {
      const current = this.codexQueriesByQuery.get(query);
      if (current) {
        this.rememberCodexSessionAlias(identity?.session, current);
        return current;
      }
      if (explicitTurnId) {
        const sessionFallback = identity?.session ? this.codexQueriesBySession.get(identity.session) : undefined;
        return sessionFallback?.queryBasis === "fallback" ? sessionFallback : undefined;
      }
    }
    return identity?.session ? this.codexQueriesBySession.get(identity.session) : undefined;
  }

  private telemetryIdentity(
    provider: SafeObservationV1["provider"],
    record: Record<string, unknown>,
    attributes: Record<string, unknown>,
    name: string
  ): ProviderTelemetryIdentity | undefined {
    return provider === "claude-code"
      ? this.claudeTelemetryIdentity(record, attributes)
      : providerIdentity(provider, record, attributes, name);
  }

  private claudeTelemetryIdentity(
    record: Record<string, unknown>,
    attributes: Record<string, unknown>
  ): ProviderTelemetryIdentity | undefined {
    const prompt = firstText(attributes["prompt.id"], attributes["prompt_id"]);
    const session = firstText(
      attributes["session.id"],
      attributes["session_id"],
      attributes["gen_ai.conversation.id"]
    );
    const trace = firstText(record.traceId);
    const request = firstText(
      attributes["request_id"],
      attributes["request.id"],
      attributes["gen_ai.response.id"]
    );
    const promptCorrelation = prompt ? this.claudeQueriesByPrompt.get(prompt) : undefined;
    const traceCorrelation = trace ? this.claudeQueriesByTrace.get(trace) : undefined;
    const requestCorrelation = request ? this.claudeQueriesByRequest.get(request) : undefined;
    if (
      promptCorrelation?.state === "conflict"
      || traceCorrelation?.state === "conflict"
      || requestCorrelation?.state === "conflict"
    ) {
      return undefined;
    }

    const candidates: ClaudeQueryIdentity[] = [];
    if (prompt && session) {
      if (promptCorrelation?.state === "resolved") {
        if (promptCorrelation.value.session !== session) {
          setBoundedMap(this.claudeQueriesByPrompt, prompt, { state: "conflict" });
          return undefined;
        }
        candidates.push(promptCorrelation.value);
      } else {
        const activeSubmission = this.claudeSubmissionHooksBySession.get(session);
        const continuationAuthorized = activeSubmission
          ? this.claudeContinuationAuthorizedByIdentity.has(
              claudeQueryIdentityKey(session, activeSubmission.query)
            )
          : false;
        candidates.push({
          query: activeSubmission
            && (activeSubmission.query === prompt || continuationAuthorized)
            ? activeSubmission.query
            : prompt,
          session
        });
      }
    }
    if (promptCorrelation?.state === "resolved") {
      candidates.push(promptCorrelation.value);
    }
    if (traceCorrelation?.state === "resolved") {
      candidates.push(traceCorrelation.value);
    }
    if (requestCorrelation?.state === "resolved") {
      candidates.push(requestCorrelation.value);
    }
    const hasExactCorrelation = promptCorrelation?.state === "resolved"
      || traceCorrelation?.state === "resolved"
      || requestCorrelation?.state === "resolved";
    const activeSession = session && !prompt && !hasExactCorrelation
      ? this.claudeSubmissionHooksBySession.get(session) ?? this.claudeQueriesBySession.get(session)
      : undefined;
    if (activeSession && session) {
      candidates.push({ query: activeSession.query, session });
    }
    const identity = candidates[0];
    if (!identity) {
      return undefined;
    }
    if (candidates.some((candidate) => !sameClaudeQueryIdentity(candidate, identity))) {
      if (prompt) setBoundedMap(this.claudeQueriesByPrompt, prompt, { state: "conflict" });
      if (trace) setBoundedMap(this.claudeQueriesByTrace, trace, { state: "conflict" });
      if (request) setBoundedMap(this.claudeQueriesByRequest, request, { state: "conflict" });
      return undefined;
    }

    if (
      prompt
      && rememberClaudeQueryCorrelation(this.claudeQueriesByPrompt, prompt, identity).state === "conflict"
    ) {
      return undefined;
    }
    if (
      trace
      && rememberClaudeQueryCorrelation(this.claudeQueriesByTrace, trace, identity).state === "conflict"
    ) {
      return undefined;
    }
    if (prompt && trace) {
      rememberExactStringCorrelation(this.claudeNativePromptsByTrace, trace, prompt);
      if (this.claudeNativePromptsByTrace.get(trace)?.state === "conflict") {
        return undefined;
      }
    }

    const querySourcePurpose = claudeUsagePurpose(attributes["query_source"]);
    const operationPurpose = claudeOperationUsagePurpose(attributes["operation.name"]);
    if (querySourcePurpose && operationPurpose && querySourcePurpose !== operationPurpose) {
      if (request) setBoundedMap(this.claudeQueriesByRequest, request, { state: "conflict" });
      return undefined;
    }
    const sourcePurpose = querySourcePurpose ?? operationPurpose;
    let usagePurpose = requestCorrelation?.state === "resolved"
      ? requestCorrelation.value.usagePurpose
      : undefined;
    if (sourcePurpose && usagePurpose && sourcePurpose !== usagePurpose) {
      if (request) setBoundedMap(this.claudeQueriesByRequest, request, { state: "conflict" });
      return undefined;
    }
    usagePurpose ??= sourcePurpose;
    if (request) {
      const rememberedRequest = rememberClaudeRequestCorrelation(
        this.claudeQueriesByRequest,
        request,
        { ...identity, ...(usagePurpose ? { usagePurpose } : {}) }
      );
      if (rememberedRequest.state === "conflict") {
        return undefined;
      }
      usagePurpose = rememberedRequest.value.usagePurpose;
    }

    const eventSequence = firstText(attributes["event.sequence"]);
    return {
      ...identity,
      request: request
        ?? firstText(
          record.spanId,
          trace,
          eventSequence && `${identity.session}|${eventSequence}`
        )
        ?? identity.query,
      ...(usagePurpose ? { usagePurpose } : {})
    };
  }

  private sanitizeClaudeClosedInteraction(
    record: Record<string, unknown>,
    attributes: Record<string, unknown>,
    classification: ReturnType<DefaultTelemetryClassification["classify"]>
  ): QueryOccurrenceV1[] {
    const completedAt = optionalTimestampToIso(firstText(record.endTimeUnixNano));
    if (!completedAt) {
      return [];
    }
    const identity = this.claudeTelemetryIdentity(record, attributes);
    if (!identity) {
      return [];
    }
    const identityKey = claudeQueryIdentityKey(identity.session, identity.query);
    if (this.claudeCompletedSubmissionsByIdentity.has(identityKey)) {
      return [];
    }
    const continuationFloor = this.claudeContinuationFloorsByIdentity.get(identityKey);
    if (continuationFloor && completedAt <= continuationFloor) {
      return [];
    }
    const trace = firstText(record.traceId);
    const nativePromptCorrelation = trace ? this.claudeNativePromptsByTrace.get(trace) : undefined;
    const nativePrompt = nativePromptCorrelation?.state === "resolved"
      ? nativePromptCorrelation.value
      : undefined;
    if (nativePrompt) {
      const pausedKey = claudeNativePromptIdentityKey(identity.session, nativePrompt);
      const pausedIdentity = this.claudeBackgroundPausedNativePrompts.get(pausedKey);
      if (pausedIdentity && sameClaudeQueryIdentity(pausedIdentity, identity)) {
        this.claudeBackgroundPausedNativePrompts.delete(pausedKey);
        if (this.claudeClosedInteractionsByIdentity.get(identityKey)?.nativePrompt === nativePrompt) {
          this.claudeClosedInteractionsByIdentity.delete(identityKey);
        }
        return [];
      }
    }
    const closed = {
      query: identity.query,
      session: identity.session,
      completedAt,
      ...(nativePrompt ? { nativePrompt } : {})
    };
    setBoundedMap(this.claudeClosedInteractionsByIdentity, identityKey, closed);
    const accepted = this.claudeAcceptedSubmissionsByIdentity.get(identityKey);
    if (accepted) {
      this.releaseClaudeSubmission(accepted);
    }
    const candidate = this.claudeStopCandidatesByIdentity.get(identityKey);
    if (
      !candidate
      || candidate.session !== identity.session
      || !timestampAtOrAfterWithin(completedAt, candidate.stoppedAt, 5_000)
    ) {
      return [];
    }
    this.claudeStopCandidatesByIdentity.delete(identityKey);
    this.claudeClosedInteractionsByIdentity.delete(identityKey);
    const completed = this.completeClaudeSubmission({
      query: identity.query,
      session: identity.session,
      startedAt: candidate.startedAt
    }, "closed_root", completedAt);
    if (!completed) {
      return [];
    }
    return [claudeCompletedOccurrence(candidate, completedAt, classification)];
  }

  private rememberClaudeQuery(session: string, query: { query: string; startedAt: string }): void {
    const hookAuthoritative = this.claudeSubmissionHooksBySession.get(session);
    if (hookAuthoritative && hookAuthoritative.query !== query.query) {
      return;
    }
    const current = this.claudeQueriesBySession.get(session);
    rememberSessionQuery(
      this.claudeQueriesBySession,
      session,
      current?.query === query.query ? current : query
    );
  }

  private claudeActivityOwnershipForRequest(
    requestId: string,
    observedOwningActivityId: string | undefined
  ): Pick<SafeUsageAtomV1, "owningActivityId" | "ownershipConflictActivityIds"> {
    const current = this.claudeUsageOwnersByRequest.get(requestId);
    if (current?.state === "conflict") {
      const activityIds = boundedOpaqueIds([
        ...current.activityIds,
        ...(observedOwningActivityId ? [observedOwningActivityId] : [])
      ]);
      setBoundedMap(this.claudeUsageOwnersByRequest, requestId, { state: "conflict", activityIds });
      return { ownershipConflictActivityIds: activityIds };
    }
    if (
      current?.state === "resolved"
      && observedOwningActivityId
      && current.value !== observedOwningActivityId
    ) {
      const activityIds = boundedOpaqueIds([current.value, observedOwningActivityId]);
      setBoundedMap(this.claudeUsageOwnersByRequest, requestId, { state: "conflict", activityIds });
      return { ownershipConflictActivityIds: activityIds };
    }
    if (observedOwningActivityId) {
      setBoundedMap(this.claudeUsageOwnersByRequest, requestId, {
        state: "resolved",
        value: observedOwningActivityId
      });
      return { owningActivityId: observedOwningActivityId };
    }
    return current?.state === "resolved" ? { owningActivityId: current.value } : {};
  }

  private knownClaudePromptIdentity(prompt: string, session: string): ClaudeQueryIdentity | undefined {
    const completedAlias = this.claudeCompletedPromptAliases.get(prompt);
    if (completedAlias) {
      return completedAlias.session === session ? completedAlias : undefined;
    }
    const correlation = this.claudeQueriesByPrompt.get(prompt);
    if (correlation?.state === "conflict") {
      return undefined;
    }
    if (correlation?.state === "resolved") {
      return correlation.value.session === session ? correlation.value : undefined;
    }
    return { query: prompt, session };
  }

  private rememberClaudeTaskNotification(
    raw: Record<string, unknown>,
    session: string,
    provenance: Extract<ClaudeSubmissionProvenance, { state: "resolved" }>,
    observedAt: string
  ): void {
    const explicitTarget = this.claudeTaskNotificationTargetBySession.get(session);
    const target = explicitTarget
      ?? this.claudeLatestCompletedBySession.get(session);
    if (!target) {
      return;
    }
    const identity = { query: target.query, session };
    const aliases = [...new Set([
      firstText(raw.prompt_id, raw.turn_id),
      provenance.transcriptPromptId
    ].filter((value): value is string => Boolean(value)))];
    if (!this.rememberClaudePromptAliases(aliases, identity)) {
      return;
    }
    if (explicitTarget) {
      const identityKey = claudeQueryIdentityKey(session, explicitTarget.query);
      const currentFloor = this.claudeContinuationFloorsByIdentity.get(identityKey);
      const continuationFloor = currentFloor && currentFloor >= observedAt ? currentFloor : observedAt;
      setBoundedMap(this.claudeContinuationFloorsByIdentity, identityKey, continuationFloor);
      const candidate = this.claudeStopCandidatesByIdentity.get(identityKey);
      if (candidate && candidate.stoppedAt <= observedAt) {
        this.claudeStopCandidatesByIdentity.delete(identityKey);
      }
      const closed = this.claudeClosedInteractionsByIdentity.get(identityKey);
      if (closed && closed.completedAt <= continuationFloor) {
        this.claudeClosedInteractionsByIdentity.delete(identityKey);
      }
      const active = this.claudeSubmissionHooksBySession.get(session);
      if (!active || active.query === explicitTarget.query) {
        this.activateClaudeSubmission(explicitTarget);
      }
    }
    this.rememberClaudeQuery(session, {
      query: target.query,
      startedAt: target.startedAt
    });
  }

  private rememberClaudePromptAliases(
    aliases: readonly string[],
    identity: ClaudeQueryIdentity
  ): boolean {
    const hasConflict = aliases.some((alias) => {
      const completed = this.claudeCompletedPromptAliases.get(alias);
      const current = this.claudeQueriesByPrompt.get(alias);
      return Boolean(completed && !sameClaudeQueryIdentity(completed, identity))
        || current?.state === "conflict"
        || Boolean(
          current?.state === "resolved"
          && !sameClaudeQueryIdentity(current.value, identity)
        );
    });
    if (hasConflict) {
      for (const alias of aliases) {
        setBoundedMap(this.claudeQueriesByPrompt, alias, { state: "conflict" });
      }
      return false;
    }
    for (const alias of aliases) {
      rememberClaudeQueryCorrelation(this.claudeQueriesByPrompt, alias, identity);
    }
    return true;
  }

  private rememberClaudeAcceptedSubmission(submission: ClaudeAcceptedSubmission): ClaudeAcceptedSubmission {
    const identityKey = claudeQueryIdentityKey(submission.session, submission.query);
    const current = this.claudeAcceptedSubmissionsByIdentity.get(identityKey);
    const accepted = current ?? submission;
    setBoundedMap(this.claudeAcceptedSubmissionsByIdentity, identityKey, accepted);
    return accepted;
  }

  private activateClaudeSubmission(submission: ClaudeAcceptedSubmission): void {
    rememberSessionQuery(this.claudeSubmissionHooksBySession, submission.session, submission);
    rememberSessionQuery(this.claudeQueriesBySession, submission.session, submission);
  }

  private releaseClaudeSubmission(submission: ClaudeAcceptedSubmission): void {
    if (this.claudeSubmissionHooksBySession.get(submission.session)?.query === submission.query) {
      this.claudeSubmissionHooksBySession.delete(submission.session);
    }
    if (this.claudeQueriesBySession.get(submission.session)?.query === submission.query) {
      this.claudeQueriesBySession.delete(submission.session);
    }
  }

  private claudeSubmissionHasPendingTerminalHalf(identity: ClaudeQueryIdentity): boolean {
    const identityKey = claudeQueryIdentityKey(identity.session, identity.query);
    return this.claudeStopCandidatesByIdentity.has(identityKey)
      || this.claudeClosedInteractionsByIdentity.has(identityKey);
  }

  private completeClaudeSubmission(
    submission: ClaudeAcceptedSubmission,
    terminalKind: ClaudeCompletedSubmission["terminalKind"],
    completedAt: string,
    failureCategory?: RunCompletionFailureCategory
  ): ClaudeCompletedSubmission | undefined {
    const identityKey = claudeQueryIdentityKey(submission.session, submission.query);
    if (this.claudeCompletedSubmissionsByIdentity.has(identityKey)) {
      return undefined;
    }
    const completed: ClaudeCompletedSubmission = {
      ...submission,
      terminalKind,
      completedAt,
      ...(failureCategory ? { failureCategory } : {})
    };
    setBoundedMap(this.claudeCompletedSubmissionsByIdentity, identityKey, completed);
    setBoundedMap(this.claudeLatestCompletedBySession, submission.session, completed);
    const identity = { query: submission.query, session: submission.session };
    setBoundedMap(this.claudeCompletedPromptAliases, submission.query, identity);
    for (const [prompt, correlation] of this.claudeQueriesByPrompt) {
      if (
        correlation.state === "resolved"
        && sameClaudeQueryIdentity(correlation.value, identity)
      ) {
        setBoundedMap(this.claudeCompletedPromptAliases, prompt, identity);
      }
    }
    this.claudeContinuationAuthorizedByIdentity.delete(identityKey);
    this.claudeContinuationFloorsByIdentity.delete(identityKey);
    this.claudeBackgroundRootsAwaitingTerminalByIdentity.delete(
      claudeBackgroundRootTerminalKey(submission.session, submission.query)
    );
    for (const [pausedKey, pausedIdentity] of this.claudeBackgroundPausedNativePrompts) {
      if (sameClaudeQueryIdentity(pausedIdentity, identity)) {
        this.claudeBackgroundPausedNativePrompts.delete(pausedKey);
      }
    }
    this.releaseClaudeSubmission(submission);
    return completed;
  }

  private codexActivityIdentity(
    provider: SafeObservationV1["provider"],
    attributes: Record<string, unknown>
  ): ProviderTelemetryIdentity | undefined {
    if (provider !== "codex") {
      return undefined;
    }
    const explicitTurnId = codexExplicitTurnId(attributes);
    if (explicitTurnId) {
      const current = this.codexRememberedQueryForIdentity({
        query: explicitTurnId,
        session: codexSessionId(attributes)
      }, explicitTurnId);
      return current ? { query: current.query, session: current.session, request: current.query } : undefined;
    }
    const session = codexSessionId(attributes);
    const current = session ? this.codexQueriesBySession.get(session) : undefined;
    return current ? { query: current.query, session: current.session, request: current.query } : undefined;
  }

  private codexMetricActivityIdentity(eventAt: string): { query: string; session: string; request: string } | undefined {
    const eventMs = Date.parse(eventAt);
    if (!Number.isFinite(eventMs)) {
      return undefined;
    }
    const candidates = [...this.codexQueriesBySession.entries()]
      .map(([_session, query]) => ({ ...query, startedMs: Date.parse(query.startedAt) }))
      .filter((query) => Number.isFinite(query.startedMs) && query.startedMs <= eventMs && eventMs - query.startedMs <= 15 * 60 * 1000)
      .sort((left, right) => right.startedMs - left.startedMs);
    const latest = candidates[0];
    return latest ? { query: latest.query, session: latest.session, request: latest.query } : undefined;
  }

  private sanitizeClaudeHookObservation(
    raw: Record<string, unknown>,
    observedAt: string
  ): SafeObservationV1 | undefined {
    const eventName = normalizedName(firstText(raw.hook_event_name) ?? "");
    if (eventName === "userpromptsubmit") {
      const session = firstText(raw.session_id);
      if (!session) {
        return undefined;
      }
      const provenance = claudeSubmissionProvenance(raw);
      if (provenance && provenance.state !== "resolved") {
        return undefined;
      }
      if (
        provenance?.state === "resolved"
        && provenance.originKind === "task-notification"
        && provenance.promptSource === "system"
      ) {
        this.rememberClaudeTaskNotification(raw, session, provenance, observedAt);
        return undefined;
      }
      if (
        provenance?.state === "resolved"
        && (provenance.originKind !== "human" || provenance.promptSource !== "typed")
      ) {
        return undefined;
      }
      const rawQuery = firstText(raw.prompt_id, raw.turn_id);
      const explicitQuery = provenance?.state === "resolved"
        ? provenance.transcriptPromptId
        : rawQuery;
      const activeSubmission = this.claudeSubmissionHooksBySession.get(session);
      if (activeSubmission && !explicitQuery) {
        return undefined;
      }
      const explicitIdentity = explicitQuery
        ? this.knownClaudePromptIdentity(explicitQuery, session)
        : undefined;
      if (
        explicitQuery
        && explicitIdentity
        && (
          this.claudeCompletedSubmissionsByIdentity.has(
            claudeQueryIdentityKey(explicitIdentity.session, explicitIdentity.query)
          )
          || (
            this.claudeAcceptedSubmissionsByIdentity.has(
              claudeQueryIdentityKey(explicitIdentity.session, explicitIdentity.query)
            )
            && this.claudeSubmissionHasPendingTerminalHalf(explicitIdentity)
          )
        )
      ) {
        return undefined;
      }
      if (
        activeSubmission
        && explicitIdentity
        && explicitIdentity.query !== activeSubmission.query
        && this.claudeAcceptedSubmissionsByIdentity.has(
          claudeQueryIdentityKey(explicitIdentity.session, explicitIdentity.query)
        )
      ) {
        return undefined;
      }
      const activeIdentityKey = activeSubmission
        ? claudeQueryIdentityKey(session, activeSubmission.query)
        : undefined;
      const distinctExplicitPrompt = Boolean(
        activeSubmission
        && explicitQuery
        && explicitQuery !== activeSubmission.query
      );
      const continuationAuthorized = activeIdentityKey
        ? provenance == null && this.claudeContinuationAuthorizedByIdentity.has(activeIdentityKey)
        : false;
      if (
        distinctExplicitPrompt
        && !continuationAuthorized
        && explicitIdentity?.query === activeSubmission?.query
      ) {
        return undefined;
      }
      const foldIntoActive = Boolean(
        activeSubmission
        && (!distinctExplicitPrompt || continuationAuthorized)
      );
      const query = foldIntoActive
        ? activeSubmission?.query ?? `${session}|${observedAt}`
        : explicitIdentity?.query
        ?? explicitQuery
        ?? `${session}|${observedAt}`;
      const startedAt = foldIntoActive ? activeSubmission?.startedAt ?? observedAt : observedAt;
      const promptAliases = [...new Set([explicitQuery, rawQuery].filter((value): value is string => Boolean(value)))];
      if (!this.rememberClaudePromptAliases(promptAliases, { query, session })) {
        return undefined;
      }
      if (distinctExplicitPrompt && continuationAuthorized && activeIdentityKey) {
        this.claudeContinuationAuthorizedByIdentity.delete(activeIdentityKey);
      }
      const accepted = this.rememberClaudeAcceptedSubmission({ query, session, startedAt });
      this.activateClaudeSubmission(accepted);
      if (this.claudeSubmissionHasPendingTerminalHalf({ query, session })) {
        this.releaseClaudeSubmission(accepted);
      }
      return promptHookObservation({
        provider: "claude-code",
        sourceId: "hook_claude_code_lifecycle",
        profileVersion: "claude-code-hooks-v1",
        observedAt,
        query,
        session,
        startedAt: accepted.startedAt,
        evidence: "submission_hook"
      });
    }
    if (eventName === "stop") {
      const session = firstText(raw.session_id);
      const prompt = firstText(raw.prompt_id);
      const promptIdentity = session && prompt ? this.knownClaudePromptIdentity(prompt, session) : undefined;
      const active = session ? this.claudeSubmissionHooksBySession.get(session) : undefined;
      const targetIdentity = session
        ? prompt
          ? promptIdentity
          : active ? { query: active.query, session } : undefined
        : undefined;
      if (!session || !targetIdentity) {
        return undefined;
      }
      const identityKey = claudeQueryIdentityKey(targetIdentity.session, targetIdentity.query);
      const current = this.claudeAcceptedSubmissionsByIdentity.get(identityKey);
      if (!current || this.claudeCompletedSubmissionsByIdentity.has(identityKey)) {
        return undefined;
      }
      if (hasProviderWorkItems(raw.background_tasks) || hasProviderWorkItems(raw.session_crons)) {
        this.claudeStopCandidatesByIdentity.delete(identityKey);
        setBoundedMap(
          this.claudeBackgroundRootsAwaitingTerminalByIdentity,
          claudeBackgroundRootTerminalKey(current.session, current.query),
          true
        );
        setBoundedMap(this.claudeTaskNotificationTargetBySession, session, current);
        if (prompt) {
          setBoundedMap(this.claudeContinuationAuthorizedByIdentity, identityKey, true);
        }
        const closed = this.claudeClosedInteractionsByIdentity.get(identityKey);
        this.claudeClosedInteractionsByIdentity.delete(identityKey);
        if (prompt && closed?.nativePrompt !== prompt) {
          setBoundedMap(
            this.claudeBackgroundPausedNativePrompts,
            claudeNativePromptIdentityKey(session, prompt),
            targetIdentity
          );
        }
        const activeSubmission = this.claudeSubmissionHooksBySession.get(session);
        if (!activeSubmission || activeSubmission.query === current.query) {
          this.activateClaudeSubmission(current);
        }
        return undefined;
      }
      const continuationFloor = this.claudeContinuationFloorsByIdentity.get(identityKey);
      if (continuationFloor && observedAt <= continuationFloor) {
        return undefined;
      }
      this.claudeContinuationAuthorizedByIdentity.delete(identityKey);
      this.claudeContinuationFloorsByIdentity.delete(identityKey);
      if (prompt) {
        this.claudeBackgroundPausedNativePrompts.delete(
          claudeNativePromptIdentityKey(session, prompt)
        );
      }
      const candidate = {
        query: current.query,
        session,
        startedAt: current.startedAt,
        stoppedAt: observedAt
      };
      setBoundedMap(this.claudeStopCandidatesByIdentity, identityKey, candidate);
      this.releaseClaudeSubmission(current);
      const closed = this.claudeClosedInteractionsByIdentity.get(identityKey);
      if (!closed || closed.session !== session) {
        return undefined;
      }
      if (!timestampAtOrAfterWithin(closed.completedAt, observedAt, 5_000)) {
        this.claudeClosedInteractionsByIdentity.delete(identityKey);
        return undefined;
      }
      this.claudeStopCandidatesByIdentity.delete(identityKey);
      this.claudeClosedInteractionsByIdentity.delete(identityKey);
      const completed = this.completeClaudeSubmission(current, "closed_root", closed.completedAt);
      if (!completed) {
        return undefined;
      }
      return completionHookObservation({
        provider: "claude-code",
        sourceId: "hook_claude_code_lifecycle",
        profileVersion: "claude-code-hooks-v1",
        observedAt,
        query: current.query,
        session,
        startedAt: current.startedAt,
        completedAt: closed.completedAt,
        completionEvidence: "closed_root_span",
        observationIdentity: `claude-code|closed_interaction|${session}|${current.query}|${closed.completedAt}`
      });
    }
    if (eventName === "stopfailure") {
      const session = firstText(raw.session_id);
      const prompt = firstText(raw.prompt_id);
      const promptIdentity = session && prompt ? this.knownClaudePromptIdentity(prompt, session) : undefined;
      const failureCategory = claudeStopFailureCategory(raw.error);
      if (
        !session
        || !prompt
        || !promptIdentity
        || !failureCategory
      ) {
        return undefined;
      }
      const identityKey = claudeQueryIdentityKey(promptIdentity.session, promptIdentity.query);
      let completed = this.claudeCompletedSubmissionsByIdentity.get(identityKey);
      if (completed) {
        if (completed.terminalKind !== "stop_failure" || !completed.failureCategory) {
          return undefined;
        }
        const enrichedCategory = monotonicClaudeFailureCategory(
          completed.failureCategory,
          failureCategory
        );
        if (!enrichedCategory) {
          return undefined;
        }
        if (enrichedCategory !== completed.failureCategory) {
          completed = { ...completed, failureCategory: enrichedCategory };
          setBoundedMap(this.claudeCompletedSubmissionsByIdentity, identityKey, completed);
        }
      } else {
        const accepted = this.claudeAcceptedSubmissionsByIdentity.get(identityKey);
        if (!accepted) {
          return undefined;
        }
        this.claudeStopCandidatesByIdentity.delete(identityKey);
        this.claudeClosedInteractionsByIdentity.delete(identityKey);
        completed = this.completeClaudeSubmission(
          accepted,
          "stop_failure",
          observedAt,
          failureCategory
        );
        if (!completed) {
          return undefined;
        }
      }
      const effectiveFailureCategory = completed.failureCategory;
      if (!effectiveFailureCategory) {
        return undefined;
      }
      return completionHookObservation({
        provider: "claude-code",
        sourceId: "hook_claude_code_lifecycle",
        profileVersion: "claude-code-hooks-v1",
        observedAt,
        query: completed.query,
        session,
        startedAt: completed.startedAt,
        completedAt: completed.completedAt,
        completionEvidence: "stop_hook",
        completionOutcome: "failure",
        completionFailureCategory: effectiveFailureCategory,
        observationIdentity: `claude-code|stop_failure|${session}|${completed.query}|${effectiveFailureCategory}`
      });
    }
    if (eventName === "subagentstart" || eventName === "subagentstop") {
      return this.sanitizeClaudeSubagentHookObservation(raw, observedAt, eventName);
    }
    if (eventName !== "posttooluse" && eventName !== "posttoolusefailure") {
      return undefined;
    }
    const session = firstText(raw.session_id);
    const current = session
      ? this.claudeSubmissionHooksBySession.get(session) ?? this.claudeQueriesBySession.get(session)
      : undefined;
    if (!session || !current) {
      return undefined;
    }
    const toolName = safeActivityName(firstText(raw.tool_name)) ?? "unknown";
    const toolInput = isRecord(raw.tool_input) ? raw.tool_input : undefined;
    const toolResponse = isRecord(raw.tool_response) ? raw.tool_response : undefined;
    const isAgentTool = normalizedName(toolName) === "agent";
    // Claude Code 2.1.207 reports the exact SubagentStart agent_id as
    // PostToolUse tool_response.agentId. Read only that opaque identity and the
    // allowlisted subtype; the rest of both content-bearing objects is discarded.
    const childSession = eventName === "posttooluse" && isAgentTool
      ? firstText(toolResponse?.agentId)
      : undefined;
    const subagentName = isAgentTool
      ? safeActivityName(firstText(toolInput?.subagent_type))
      : undefined;
    const descriptor = isAgentTool && (subagentName || childSession)
      ? { kind: "subagent" as const, name: subagentName ?? "Agent" }
      : activityDescriptor("claude-code", "claude_code.tool_result", { tool_name: toolName }) ?? {
          kind: "tool" as const,
          name: toolName
        };
    const durationMs = nonnegativeInteger(firstText(raw.duration_ms));
    const startedAt = childSession
      ? observedAt
      : subtractDurationMs(observedAt, durationMs) ?? observedAt;
    const toolUseId = firstText(raw.tool_use_id);
    const attributes = hookSensitiveAttributes(
      raw.tool_input,
      eventName === "posttooluse"
        ? raw.tool_response
        : {
            error: firstText(raw.error) ?? "tool_failed",
            is_interrupt: raw.is_interrupt === true
      },
      firstText(raw.cwd)
    );
    const outcome = eventName === "posttoolusefailure"
      ? raw.is_interrupt === true ? "rejected" : "failure"
      : childSession
        // Agent calls are background-by-default in the accepted native version.
        // A successful PostToolUse proves launch/return, not child completion.
        ? "unknown"
        : claudeHookOutcome(toolName, raw.tool_response);
    return hookObservation({
      provider: "claude-code",
      sourceId: "hook_claude_code_tools",
      profileVersion: "claude-code-hooks-v1",
      observedAt,
      query: current.query,
      session,
      request: toolUseId ?? `${eventName}|${toolName}|${startedAt}`,
      activity: {
        kind: descriptor.kind,
        name: descriptor.name,
        outcome,
        durationMs: childSession ? undefined : durationMs,
        childSession,
        timingConfidence: childSession ? "medium" : undefined
      },
      node: {
        nodeKind: executionNodeKindForActivity(descriptor.kind),
        name: descriptor.name,
        toolName: descriptor.name,
        ...(toolUseId ? { invocation: toolUseId } : {}),
        outcome,
        startedAt,
        endedAt: childSession ? undefined : observedAt,
        durationMs: childSession ? undefined : durationMs
      }
    });
  }

  private sanitizeClaudeSubagentHookObservation(
    raw: Record<string, unknown>,
    observedAt: string,
    eventName: "subagentstart" | "subagentstop"
  ): SafeObservationV1 | undefined {
    const session = firstText(raw.session_id);
    const current = session
      ? this.claudeSubmissionHooksBySession.get(session) ?? this.claudeQueriesBySession.get(session)
      : undefined;
    if (!session || !current) {
      return undefined;
    }
    const name = safeActivityName(firstText(raw.agent_type, raw.subagent_type, raw.agent_name, raw.name)) ?? "subagent";
    const childSession = firstText(raw.subagent_id, raw.agent_id);
    const request = childSession ?? `subagent|${name}|${observedAt}`;
    const ledgerKey = childSession ? `${session}|${current.query}|${childSession}` : undefined;
    if (eventName === "subagentstop" && (!ledgerKey || !this.claudeSubagentStarts.has(ledgerKey))) {
      return undefined;
    }
    if (eventName === "subagentstart" && ledgerKey) {
      setBoundedMap(this.claudeSubagentStarts, ledgerKey, observedAt);
    }
    const durationMs = nonnegativeInteger(firstText(raw.duration_ms));
    const startedAt = (ledgerKey ? this.claudeSubagentStarts.get(ledgerKey) : undefined)
      ?? subtractDurationMs(observedAt, durationMs)
      ?? observedAt;
    const outcome = eventName === "subagentstart"
      ? "unknown"
      : raw.is_interrupt === true
        ? "rejected"
        : firstText(raw.error)
          ? "failure"
          : "unknown";
    return hookObservation({
      provider: "claude-code",
      sourceId: "hook_claude_code_lifecycle",
      profileVersion: "claude-code-hooks-v1",
      observedAt,
      query: current.query,
      session,
      request,
      observationRevision: `${eventName}|${observedAt}`,
      activity: {
        kind: "subagent",
        name,
        outcome,
        durationMs,
        childSession
      },
      node: {
        nodeKind: "subagent",
        name,
        outcome,
        startedAt,
        durationMs
      }
    });
  }

  private sanitizeCodexHookObservation(
    raw: Record<string, unknown>,
    observedAt: string
  ): SafeObservationV1 | undefined {
    const eventName = normalizedName(firstText(raw.hook_event_name) ?? "");
    if (eventName === "userpromptsubmit") {
      const query = firstText(raw.turn_id);
      const reportedSession = firstText(raw.session_id);
      const session = codexHookSession(raw) ?? query;
      if (!query || !session) {
        return undefined;
      }
      // Codex Desktop also invokes hooks for ephemeral internal work such as title
      // generation. Record only an opaque internal marker so earlier or later OTLP
      // evidence for the same identity cannot be promoted after a restart.
      if (!codexHookHasTranscriptLocator(raw)) {
        const active = this.rememberCodexInternalQuery(session, query, observedAt);
        return internalCodexHookObservation({
          observedAt,
          query: active.query,
          session: active.session,
          startedAt: active.startedAt
        });
      }
      const active = this.rememberCodexHookQuery(session, query, observedAt);
      return promptHookObservation({
        provider: "codex",
        sourceId: "hook_codex_lifecycle",
        profileVersion: "codex-hooks-v1",
        observedAt,
        query: active.query,
        session: active.session,
        parentSession: reportedSession && reportedSession !== active.session ? reportedSession : undefined,
        startedAt: active.startedAt,
        evidence: "submission_hook",
        lifecycleVisibility: "customer"
      });
    }
    const query = firstText(raw.turn_id);
    const reportedSession = firstText(raw.session_id);
    const session = codexHookSession(raw) ?? query;
    if (this.isInternalCodexIdentity({ query, session: session ?? reportedSession })) {
      return undefined;
    }
    const isSubagentLifecycle = eventName === "subagentstart" || eventName === "subagentstop";
    const current = isSubagentLifecycle && reportedSession
      ? this.codexQueriesBySession.get(reportedSession)
      : query
        ? this.codexRememberedQueryForIdentity({ query, session: session ?? query }, query)
        : session ? this.codexQueriesBySession.get(session) : undefined;
    if (current && this.isInternalCodexIdentity(current)) {
      return undefined;
    }
    if (eventName === "stop") {
      if (!current) {
        return undefined;
      }
      return completionHookObservation({
        provider: "codex",
        sourceId: "hook_codex_lifecycle",
        profileVersion: "codex-hooks-v1",
        observedAt,
        query: current.query,
        session: current.session,
        startedAt: current.startedAt,
        completionEvidence: "stop_hook"
      });
    }
    if (eventName === "subagentstart" || eventName === "subagentstop") {
      if (!current) {
        return undefined;
      }
      const childSession = firstText(raw.agent_id, raw.subagent_id);
      const request = childSession ?? `${eventName}|${observedAt}`;
      if (eventName === "subagentstart") {
        this.codexSubagentStarts.set(request, observedAt);
      }
      const startedAt = this.codexSubagentStarts.get(request)
        ?? subtractDurationMs(observedAt, nonnegativeInteger(firstText(raw.duration_ms)))
        ?? observedAt;
      if (eventName === "subagentstop") {
        this.codexSubagentStarts.delete(request);
      }
      const name = safeActivityName(firstText(raw.agent_type, raw.subagent_type, raw.agent_name, raw.name)) ?? "subagent";
      return hookObservation({
        provider: "codex",
        sourceId: "hook_codex_lifecycle",
        profileVersion: "codex-hooks-v1",
        observedAt,
        query: current.query,
        session: current.session,
        request,
        activity: {
          kind: "subagent",
          name,
          outcome: eventName === "subagentstart" ? "unknown" : raw.error ? "failure" : "success",
          childSession
        },
        node: {
          nodeKind: "subagent",
          name,
          outcome: eventName === "subagentstart" ? "unknown" : raw.error ? "failure" : "success",
          startedAt,
          endedAt: eventName === "subagentstop" ? observedAt : undefined,
          durationMs: nonnegativeInteger(firstText(raw.duration_ms))
        }
      });
    }
    if (eventName !== "posttooluse" && eventName !== "posttoolusefailure") {
      return undefined;
    }
    if (!current) {
      return undefined;
    }
    const toolName = safeActivityName(firstText(raw.tool_name)) ?? "unknown";
    const descriptor = activityDescriptor("codex", "codex.tool_result", { tool_name: toolName }) ?? {
      kind: "tool" as const,
      name: toolName
    };
    const durationMs = nonnegativeInteger(firstText(raw.duration_ms));
    const startedAt = subtractDurationMs(observedAt, durationMs) ?? observedAt;
    const toolUseId = firstText(raw.tool_use_id);
    const attributes = hookSensitiveAttributes(raw.tool_input, raw.tool_response, firstText(raw.cwd));
    const outcome = eventName === "posttoolusefailure"
      ? raw.is_interrupt === true ? "rejected" : "failure"
      : codexHookOutcome(toolName, raw.tool_response);
    const toolResponse = isRecord(raw.tool_response) ? raw.tool_response : undefined;
    const childSession = descriptor.kind === "subagent"
      ? firstText(raw.agent_id, raw.subagent_id, toolResponse?.agent_id, toolResponse?.subagent_id)
      : undefined;
    return hookObservation({
      provider: "codex",
      sourceId: "hook_codex_tools",
      profileVersion: "codex-hooks-v1",
      observedAt,
      query: current.query,
      session: current.session,
      request: toolUseId ?? `${toolName}|${startedAt}`,
      activity: {
        kind: descriptor.kind,
        name: descriptor.name,
        outcome,
        durationMs,
        childSession
      },
      node: {
        nodeKind: executionNodeKindForActivity(descriptor.kind),
        name: descriptor.name,
        toolName: descriptor.name,
        outcome,
        startedAt,
        endedAt: observedAt,
        durationMs
      }
    });
  }

  private sanitizeCursorHookObservation(
    raw: Record<string, unknown>,
    observedAt: string
  ): SafeObservationV1 | undefined {
    const eventName = normalizedName(firstText(raw.hook_event_name) ?? "");
    const session = firstText(raw.conversation_id, raw.session_id);
    if (!session) {
      return undefined;
    }
    if (eventName === "beforesubmitprompt") {
      const query = firstText(raw.generation_id) ?? `${session}|${observedAt}`;
      const model = safeModel(firstText(raw.model));
      this.rememberCursorTurn(query, {
        query,
        session,
        startedAt: observedAt,
        ...(model ? { model } : {})
      });
      return promptHookObservation({
        provider: "cursor",
        sourceId: "hook_cursor_lifecycle",
        profileVersion: "cursor-hooks-v1",
        observedAt,
        query,
        session,
        evidence: "submission_hook"
      });
    }

    if (eventName === "afteragentresponse") {
      const turn = this.cursorTurnForPayload(raw, observedAt);
      if (!turn) {
        return undefined;
      }
      const usage = tokenUsage(raw);
      if (!hasUsage(usage)) {
        return undefined;
      }
      turn.usage = usage;
      const model = safeModel(firstText(raw.model)) ?? turn.model;
      if (model) {
        turn.model = model;
      }
      return cursorUsageHookObservation({
        observedAt,
        turn,
        endedAt: undefined,
        model,
        usage
      });
    }

    if (eventName === "stop" || eventName === "sessionend") {
      const turn = this.cursorTurnForPayload(raw, observedAt, { allowGenerationDrift: true });
      if (!turn) {
        return undefined;
      }
      const usage = tokenUsage(raw);
      const observedUsage = hasUsage(usage) ? usage : turn.usage;
      if (observedUsage) {
        turn.usage = observedUsage;
      }
      const model = observedUsage ? (safeModel(firstText(raw.model)) ?? turn.model) : undefined;
      if (model) {
        turn.model = model;
      }
      this.closeCursorTurn(turn);
      return cursorUsageHookObservation({
        observedAt,
        turn,
        endedAt: observedAt,
        model,
        usage: observedUsage ?? {},
        completedAt: observedAt,
        completionEvidence: eventName === "sessionend" ? "session_hook" : "stop_hook"
      });
    }

    const activity = cursorActivityFromHook(eventName, raw, observedAt);
    if (!activity) {
      return undefined;
    }
    const turn = this.cursorTurnForPayload(raw, observedAt);
    if (!turn) {
      return undefined;
    }
    return cursorActivityHookObservation({
      observedAt,
      turn,
      activity
    });
  }

  private rememberCursorTurn(generation: string, turn: ActiveCursorTurn): void {
    this.cursorTurnsByGeneration.set(generation, turn);
    this.cursorOpenGenerationBySession.set(turn.session, generation);
    while (this.cursorTurnsByGeneration.size > MAX_ACTIVE_PROVIDER_QUERIES) {
      const oldest = this.cursorTurnsByGeneration.keys().next().value;
      if (oldest == null) {
        break;
      }
      const removed = this.cursorTurnsByGeneration.get(oldest);
      this.cursorTurnsByGeneration.delete(oldest);
      if (removed && this.cursorOpenGenerationBySession.get(removed.session) === oldest) {
        this.cursorOpenGenerationBySession.delete(removed.session);
      }
    }
  }

  private cursorTurnForPayload(
    raw: Record<string, unknown>,
    observedAt: string,
    options: { allowGenerationDrift?: boolean } = {}
  ): ActiveCursorTurn | undefined {
    const session = firstText(raw.conversation_id, raw.session_id);
    if (!session) {
      return undefined;
    }
    const generation = firstText(raw.generation_id);
    const direct = generation ? this.cursorTurnsByGeneration.get(generation) : undefined;
    if (direct) {
      const model = safeModel(firstText(raw.model));
      if (model) {
        direct.model = model;
      }
      return direct;
    }
    const fallbackGeneration = options.allowGenerationDrift
      ? this.cursorOpenGenerationBySession.get(session)
      : undefined;
    const fallback = fallbackGeneration ? this.cursorTurnsByGeneration.get(fallbackGeneration) : undefined;
    if (fallback) {
      return fallback;
    }
    if (!generation) {
      return undefined;
    }
    const model = safeModel(firstText(raw.model));
    const inferred: ActiveCursorTurn = {
      query: generation,
      session,
      startedAt: observedAt,
      ...(model ? { model } : {})
    };
    this.rememberCursorTurn(generation, inferred);
    return inferred;
  }

  private closeCursorTurn(turn: ActiveCursorTurn): void {
    for (const [generation, candidate] of this.cursorTurnsByGeneration.entries()) {
      if (candidate === turn && this.cursorOpenGenerationBySession.get(turn.session) === generation) {
        this.cursorOpenGenerationBySession.delete(turn.session);
      }
    }
  }
}

function assertEnvelopeLimits(resources: Record<string, unknown>[], signal: TelemetrySignal): void {
  if (resources.length > OTLP_MAX_RESOURCES) {
    throw new Error("payload_too_large");
  }
  const scopeKey = signal === "traces" ? "scopeSpans" : signal === "logs" ? "scopeLogs" : "scopeMetrics";
  const recordKey = signal === "traces" ? "spans" : signal === "logs" ? "logRecords" : "metrics";
  let records = 0;
  for (const resource of resources) {
    const resourceAttributes = isRecord(resource.resource) && Array.isArray(resource.resource.attributes)
      ? resource.resource.attributes
      : [];
    if (resourceAttributes.length > OTLP_MAX_ATTRIBUTES) {
      throw new Error("payload_too_large");
    }
    const scopes = Array.isArray(resource[scopeKey]) ? resource[scopeKey] : [];
    if (scopes.length > OTLP_MAX_SCOPES_PER_RESOURCE) {
      throw new Error("payload_too_large");
    }
    for (const scope of scopes.filter(isRecord)) {
      const items = Array.isArray(scope[recordKey]) ? scope[recordKey] : [];
      records += items.length;
      if (records > OTLP_MAX_RECORDS) {
        throw new Error("payload_too_large");
      }
      if (items.filter(isRecord).some((item) => Array.isArray(item.attributes) && item.attributes.length > OTLP_MAX_ATTRIBUTES)) {
        throw new Error("payload_too_large");
      }
    }
  }
}

export class DefaultTelemetryClassification {
  classify(metadata: PrivacyApprovedOtlpMetadata): {
    provider: SafeObservationV1["provider"];
    runtime: string;
    profileVersion: string;
    sourceId: string;
  } {
    const names = metadata.serviceNames.map((name) => name.toLowerCase());
    if (names.some((name) => name.includes("claude"))) {
      return {
        provider: "claude-code",
        runtime: "claude-code",
        profileVersion: metadata.signal === "traces" ? "claude-code-enhanced-traces-beta-v1" : "claude-code-otel-logs-v1",
        sourceId: metadata.signal === "traces" ? "otlp_claude_code_traces" : "otlp_claude_code_logs"
      };
    }
    if (names.some((name) => name.includes("codex"))) {
      if (metadata.signal !== "logs" && metadata.signal !== "traces" && metadata.signal !== "metrics") {
        throw new Error("unsupported_source");
      }
      return {
        provider: "codex",
        runtime: "codex",
        profileVersion: metadata.signal === "logs"
          ? "codex-otel-logs-v1"
          : metadata.signal === "traces" ? "codex-otel-traces-v1" : "codex-otel-metrics-v1",
        sourceId: metadata.signal === "logs"
          ? "otlp_codex_logs"
          : metadata.signal === "traces" ? "otlp_codex_traces" : "otlp_codex_metrics"
      };
    }
    if (names.some((name) => name.includes("cursor"))) {
      if (metadata.signal !== "logs" && metadata.signal !== "traces") {
        throw new Error("unsupported_source");
      }
      return {
        provider: "cursor",
        runtime: "cursor",
        profileVersion: metadata.signal === "logs" ? "cursor-otlp-logs-v1" : "cursor-otlp-traces-v1",
        sourceId: metadata.signal === "logs" ? "otlp_cursor_logs" : "otlp_cursor_traces"
      };
    }
    if (names.some((name) => name.includes("copilot"))) {
      return {
        provider: "github-copilot",
        runtime: "github-copilot",
        profileVersion: metadata.signal === "traces" ? "copilot-otlp-traces-v1" : "copilot-otlp-logs-v1",
        sourceId: metadata.signal === "traces" ? "otlp_github_copilot_traces" : "otlp_github_copilot_logs"
      };
    }
    throw new Error("unsupported_source");
  }
}

export function safeObservationFrom(
  metadata: PrivacyApprovedOtlpMetadata,
  classification: ReturnType<DefaultTelemetryClassification["classify"]>,
  observationId = `obs_${randomUUID()}`
): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId,
    sourceId: classification.sourceId,
    provider: classification.provider,
    runtime: classification.runtime,
    signal: metadata.signal,
    profileVersion: classification.profileVersion,
    resourceCount: metadata.resourceCount,
    recordCount: metadata.recordCount,
    observedAt: metadata.observedAt,
    queryOccurrences: metadata.queryOccurrences,
    activityAtoms: metadata.activityAtoms,
    executionNodes: metadata.executionNodes,
    usageAtoms: metadata.usageAtoms
  };
}

export function sourceCapabilityForObservation(observation: SafeObservationV1, environmentId: string): SourceCapabilityV1 {
  return {
    schemaVersion: 1,
    sourceId: observation.sourceId,
    sourceKind: "otlp-http-json",
    provider: observation.provider,
    runtime: observation.runtime,
    environmentId,
    profileVersion: observation.profileVersion,
    granularity: observation.provider === "claude-code"
      ? observation.signal === "traces" ? ["request"] : ["prompt", "request"]
      : observation.provider === "codex" || observation.provider === "cursor"
        ? ["turn", "request"]
        : observation.signal === "traces" ? ["run", "turn"] : ["prompt"],
    tokenDimensions: sourceTokenDimensions(observation),
    billingEvidence: observation.provider === "github-copilot"
      ? ["copilot_context"]
      : observation.provider === "codex"
        ? ["auth_mode_when_present"]
        : observation.provider === "cursor"
          ? ["cursor_catalog_when_model_matches", "provider_reported_cost_when_present"]
        : ["provider_reported_cost_when_present"],
    durability: "at_least_once",
    contentRisk: "content_expected",
    compatibility: "supported",
    evidenceGrade: "estimated_usage_cost_unattributed"
  };
}

export function sourceCapabilityForProviderHookObservation(
  observation: SafeObservationV1,
  environmentId: string
): SourceCapabilityV1 {
  return {
    schemaVersion: 1,
    sourceId: observation.sourceId,
    sourceKind: observation.provider === "claude-code" ? "provider-hook-http-json" : "provider-hook-command-json",
    provider: observation.provider,
    runtime: observation.runtime,
    environmentId,
    profileVersion: observation.profileVersion,
    granularity: observation.provider === "claude-code" ? ["prompt", "request"] : ["prompt", "turn"],
    tokenDimensions: observation.provider === "cursor"
      ? ["input", "output", "cache_read_input", "cache_creation_input", "total"]
      : [],
    billingEvidence: observation.provider === "cursor"
      ? ["cursor_catalog_when_model_matches", "provider_reported_cost_when_present"]
      : [],
    durability: "ephemeral",
    contentRisk: "content_expected",
    compatibility: "supported",
    evidenceGrade: "estimated_usage_cost_unattributed"
  };
}

function sourceTokenDimensions(observation: SafeObservationV1): string[] {
  if (observation.provider === "cursor") {
    return ["input", "output", "cache_read_input", "cache_creation_input", "reasoning_output", "total"];
  }
  if (observation.provider === "codex") {
    return observation.signal === "traces"
      ? ["input", "output", "cache_read_input", "cache_creation_input", "reasoning_output", "total"]
      : ["input", "output", "cache_read_input", "total"];
  }
  if (observation.provider === "claude-code") {
    return observation.signal === "traces"
      ? ["input", "output", "cache_read_input", "cache_creation_input", "reasoning_output", "total"]
      : ["input", "output", "cache_read_input", "cache_creation_input", "total"];
  }
  return observation.signal === "traces"
    ? ["input", "output", "cache_read_input", "cache_creation_input", "reasoning_output", "total"]
    : ["input", "output", "cache_read_input", "cache_creation_input", "total"];
}

function resourceItems(raw: Record<string, unknown>, signal: TelemetrySignal): Record<string, unknown>[] {
  const key = signal === "traces" ? "resourceSpans" : signal === "logs" ? "resourceLogs" : "resourceMetrics";
  const value = raw[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function serviceNamesFrom(resourceItem: Record<string, unknown>): string[] {
  const resource = isRecord(resourceItem.resource) ? resourceItem.resource : undefined;
  const attributes = Array.isArray(resource?.attributes) ? resource.attributes : [];
  return attributes.filter(isRecord).flatMap((attribute) => {
    if (attribute.key !== "service.name" || !isRecord(attribute.value)) {
      return [];
    }
    const value = attribute.value.stringValue;
    return typeof value === "string" && value.length <= 100 ? [value] : [];
  });
}

function recordCount(resource: Record<string, unknown>, signal: TelemetrySignal): number {
  const scopeKey = signal === "traces" ? "scopeSpans" : signal === "logs" ? "scopeLogs" : "scopeMetrics";
  const recordKey = signal === "traces" ? "spans" : signal === "logs" ? "logRecords" : "metrics";
  const scopes = Array.isArray(resource[scopeKey]) ? resource[scopeKey] : [];
  return scopes.filter(isRecord).reduce((sum, scope) => sum + (Array.isArray(scope[recordKey]) ? scope[recordKey].length : 0), 0);
}

function usageRecords(resource: Record<string, unknown>, signal: TelemetrySignal): Record<string, unknown>[] {
  const scopeKey = signal === "traces" ? "scopeSpans" : signal === "logs" ? "scopeLogs" : "scopeMetrics";
  const recordKey = signal === "traces" ? "spans" : signal === "logs" ? "logRecords" : "metrics";
  const scopes = Array.isArray(resource[scopeKey]) ? resource[scopeKey] : [];
  return scopes.filter(isRecord).flatMap((scope) => Array.isArray(scope[recordKey]) ? scope[recordKey].filter(isRecord) : []);
}

function metricDataPoints(raw: Record<string, unknown>): {
  metricName: string;
  attributes: Record<string, unknown>;
  startTimeUnixNano?: string;
  timeUnixNano?: string;
}[] {
  return resourceItems(raw, "metrics").flatMap((resource) => {
    const scopes = Array.isArray(resource.scopeMetrics) ? resource.scopeMetrics.filter(isRecord) : [];
    return scopes.flatMap((scope) => {
      const metrics = Array.isArray(scope.metrics) ? scope.metrics.filter(isRecord) : [];
      return metrics.flatMap((metric) => {
        const metricName = firstText(metric.name) ?? "";
        return metricPoints(metric).map((point) => ({
          metricName,
          attributes: otlpAttributes(point.attributes),
          startTimeUnixNano: firstText(point.startTimeUnixNano),
          timeUnixNano: firstText(point.timeUnixNano)
        }));
      });
    });
  });
}

function metricPoints(metric: Record<string, unknown>): Record<string, unknown>[] {
  return ["sum", "gauge", "histogram", "exponentialHistogram", "summary"].flatMap((key) => {
    const container = metric[key];
    if (!isRecord(container) || !Array.isArray(container.dataPoints)) {
      return [];
    }
    return container.dataPoints.filter(isRecord);
  });
}

function recordAttributes(
  resourceAttributes: Record<string, unknown>,
  record: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...resourceAttributes,
    ...otlpAttributes(record.attributes),
    ...spanEventContentAttributes(record)
  };
}

function spanEventContentAttributes(record: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const event of spanEvents(record)) {
    const eventName = normalizedName(firstText(event.name) ?? "");
    if (eventName !== "tool.output" && eventName !== "tool_output") {
      continue;
    }
    for (const [key, value] of Object.entries(otlpAttributes(event.attributes))) {
      if (!SPAN_EVENT_CONTENT_KEYS.has(key)) {
        continue;
      }
      attributes[key] = value;
    }
  }
  return attributes;
}

function spanEvents(record: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(record.events) ? record.events.filter(isRecord) : [];
}

function rememberSessionQuery(
  store: Map<string, ActiveProviderQuery>,
  session: string,
  query: ActiveProviderQuery
): void {
  setBoundedMap(store, session, query);
}

function setBoundedMap<K, V>(store: Map<K, V>, key: K, value: V): void {
  store.delete(key);
  store.set(key, value);
  while (store.size > MAX_ACTIVE_PROVIDER_QUERIES) {
    const oldest = store.keys().next().value;
    if (oldest == null) {
      break;
    }
    store.delete(oldest);
  }
}

function sameClaudeQueryIdentity(left: ClaudeQueryIdentity, right: ClaudeQueryIdentity): boolean {
  return left.query === right.query && left.session === right.session;
}

function claudeQueryIdentityKey(session: string, query: string): string {
  return JSON.stringify([session, query]);
}

function claudeBackgroundRootTerminalKey(session: string, query: string): string {
  return opaqueHash("cbr", JSON.stringify([session, query]));
}

function claudeNativePromptIdentityKey(session: string, prompt: string): string {
  return JSON.stringify([session, prompt]);
}

const CLAUDE_TRANSCRIPT_MATCH_WINDOW_MS = 2_000;
const CLAUDE_IDLESS_TRANSCRIPT_MATCH_WINDOW_MS = 250;
const CLAUDE_TRANSCRIPT_MAX_TAIL_CHARACTERS = 262_144;
const CLAUDE_TRANSCRIPT_MAX_RECORDS = 512;
const TIRION_CLAUDE_PROMPT_DIGEST_FIELD = "tirion_claude_submission_prompt_digest";
const CLAUDE_TRANSCRIPT_TAIL_UNAVAILABLE_REASONS = new Set<ClaudeTranscriptTailUnavailableReason>([
  "transcript_locator_invalid",
  "transcript_trust_rejected",
  "transcript_read_unavailable",
  "transcript_read_unstable"
]);
const CLAUDE_SUBMISSION_PROVENANCE_DIAGNOSTIC_REASONS = new Set<ClaudeSubmissionProvenanceDiagnosticReason>([
  ...CLAUDE_TRANSCRIPT_TAIL_UNAVAILABLE_REASONS,
  "transcript_tail_exceeded",
  "hook_identity_unavailable",
  "transcript_candidate_missing",
  "idless_candidate_stale",
  "prompt_digest_mismatch",
  "prompt_identity_conflict",
  "candidate_ambiguous",
  "transcript_origin_kind_missing",
  "transcript_origin_kind_unrecognized",
  "transcript_prompt_source_missing",
  "transcript_prompt_source_unrecognized",
  "transcript_origin_prompt_source_incompatible",
  "origin_not_human_typed",
  "malformed_provenance"
]);

function resolveClaudeSubmissionProvenance(
  raw: Record<string, unknown>,
  transcript: ClaudeTranscriptTailInput,
  observedAt: string,
  consumedTranscriptRows: Set<string>,
  transcriptRowReservations: Map<string, string>,
  reservationKey: string
): ClaudeSubmissionProvenance {
  if (transcript.state !== "available") {
    return unavailableClaudeSubmissionProvenance(
      claudeTranscriptTailUnavailableReason(transcript.diagnosticReason) ?? "transcript_read_unavailable"
    );
  }
  if (transcript.tail.length > CLAUDE_TRANSCRIPT_MAX_TAIL_CHARACTERS) {
    return unavailableClaudeSubmissionProvenance("transcript_tail_exceeded");
  }
  const session = firstText(raw.session_id);
  const observedMs = Date.parse(observedAt);
  if (!session || !Number.isFinite(observedMs)) {
    return unavailableClaudeSubmissionProvenance("hook_identity_unavailable");
  }
  const candidates = transcript.tail
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-CLAUDE_TRANSCRIPT_MAX_RECORDS)
    .flatMap((line) => {
      let record: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          return [];
        }
        record = parsed;
      } catch {
        return [];
      }
      const message = isRecord(record.message) ? record.message : undefined;
      const recordSession = firstText(record.sessionId, record.session_id);
      const transcriptPromptId = boundedOpaqueText(firstText(
        record.promptId,
        record.prompt_id,
        record.uuid
      ));
      const timestamp = firstText(record.timestamp);
      const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
      if (
        normalizedName(firstText(record.type) ?? "") !== "user"
        || normalizedName(firstText(message?.role) ?? "") !== "user"
        || typeof message?.content !== "string"
        || recordSession !== session
        || !transcriptPromptId
        || !Number.isFinite(timestampMs)
      ) {
        return [];
      }
      const distanceMs = Math.abs(timestampMs - observedMs);
      if (distanceMs > CLAUDE_TRANSCRIPT_MATCH_WINDOW_MS) {
        return [];
      }
      const transcriptRecordKey = opaqueHash(
        "claude_transcript_row",
        JSON.stringify([session, transcriptPromptId, timestamp])
      );
      const reservedBy = transcriptRowReservations.get(transcriptRecordKey);
      if (consumedTranscriptRows.has(transcriptRecordKey) || (reservedBy && reservedBy !== reservationKey)) {
        return [];
      }
      const origin = isRecord(record.origin) ? record.origin : undefined;
      return [{
        transcriptPromptId,
        transcriptRecordKey,
        distanceMs,
        promptDigest: claudePromptDigest(message.content),
        originKind: firstText(origin?.kind),
        promptSource: firstText(record.promptSource, record.prompt_source)
      }];
    });
  if (candidates.length === 0) {
    return unavailableClaudeSubmissionProvenance("transcript_candidate_missing");
  }
  const rawPrompt = boundedOpaqueText(firstText(raw.prompt_id, raw.turn_id));
  if (!rawPrompt) {
    const freshCandidates = candidates.filter(
      (candidate) => candidate.distanceMs <= CLAUDE_IDLESS_TRANSCRIPT_MATCH_WINDOW_MS
    );
    if (freshCandidates.length === 0) {
      return unavailableClaudeSubmissionProvenance("idless_candidate_stale");
    }
    candidates.splice(0, candidates.length, ...freshCandidates);
  }
  const hookPromptDigest = claudeSubmissionHookPromptDigest(raw);
  if (hookPromptDigest) {
    const promptMatches = candidates.filter((candidate) => candidate.promptDigest === hookPromptDigest);
    if (promptMatches.length === 0) {
      return unavailableClaudeSubmissionProvenance("prompt_digest_mismatch");
    }
    const rawPromptMatches = rawPrompt
      ? candidates.filter((candidate) => candidate.transcriptPromptId === rawPrompt)
      : [];
    if (
      rawPromptMatches.length > 0
      && !rawPromptMatches.some((candidate) => candidate.promptDigest === hookPromptDigest)
    ) {
      return ambiguousClaudeSubmissionProvenance("prompt_identity_conflict");
    }
    candidates.splice(0, candidates.length, ...promptMatches);
  }
  const exactPromptCandidates = rawPrompt
    ? candidates.filter((candidate) => candidate.transcriptPromptId === rawPrompt)
    : [];
  const pool = exactPromptCandidates.length > 0 ? exactPromptCandidates : candidates;
  const nearestDistance = Math.min(...pool.map((candidate) => candidate.distanceMs));
  const nearest = pool.filter((candidate) => candidate.distanceMs === nearestDistance);
  if (nearest.length !== 1) {
    return ambiguousClaudeSubmissionProvenance("candidate_ambiguous");
  }
  const match = nearest[0];
  const originKind = claudeTranscriptOriginKind(match.originKind);
  const promptSource = claudeTranscriptPromptSource(match.promptSource);
  if (originKind === "human" && promptSource === "typed") {
    setBoundedMap(transcriptRowReservations, match.transcriptRecordKey, reservationKey);
    return {
      state: "resolved",
      originKind: "human",
      promptSource: "typed",
      transcriptPromptId: match.transcriptPromptId,
      transcriptRecordKey: match.transcriptRecordKey,
      transcriptReservationKey: reservationKey
    };
  }
  if (originKind === "task-notification" && promptSource === "system") {
    setBoundedMap(transcriptRowReservations, match.transcriptRecordKey, reservationKey);
    return {
      state: "resolved",
      originKind: "task-notification",
      promptSource: "system",
      transcriptPromptId: match.transcriptPromptId,
      transcriptRecordKey: match.transcriptRecordKey,
      transcriptReservationKey: reservationKey
    };
  }
  if (originKind === "missing") {
    return unavailableClaudeSubmissionProvenance("transcript_origin_kind_missing");
  }
  if (originKind === "unrecognized") {
    return unavailableClaudeSubmissionProvenance("transcript_origin_kind_unrecognized");
  }
  if (promptSource === "missing") {
    return unavailableClaudeSubmissionProvenance("transcript_prompt_source_missing");
  }
  if (promptSource === "unrecognized") {
    return unavailableClaudeSubmissionProvenance("transcript_prompt_source_unrecognized");
  }
  return unavailableClaudeSubmissionProvenance("transcript_origin_prompt_source_incompatible");
}

function claudeTranscriptOriginKind(
  value: string | undefined
): "human" | "task-notification" | "missing" | "unrecognized" {
  if (!value) return "missing";
  if (value === "human" || value === "task-notification") return value;
  return "unrecognized";
}

function claudeTranscriptPromptSource(
  value: string | undefined
): "typed" | "system" | "missing" | "unrecognized" {
  if (!value) return "missing";
  if (value === "typed" || value === "system") return value;
  return "unrecognized";
}

function unavailableClaudeSubmissionProvenance(
  diagnosticReason: ClaudeSubmissionProvenanceDiagnosticReason
): Extract<ClaudeSubmissionProvenance, { state: "unavailable" }> {
  return { state: "unavailable", diagnosticReason };
}

function ambiguousClaudeSubmissionProvenance(
  diagnosticReason: ClaudeSubmissionProvenanceDiagnosticReason
): Extract<ClaudeSubmissionProvenance, { state: "ambiguous" }> {
  return { state: "ambiguous", diagnosticReason };
}

function claudeSubmissionHookPromptDigest(raw: Record<string, unknown>): string | undefined {
  const prompt = firstText(raw.prompt);
  if (prompt != null) {
    return claudePromptDigest(prompt);
  }
  const retainedDigest = boundedOpaqueText(firstText(raw[TIRION_CLAUDE_PROMPT_DIGEST_FIELD]));
  if (retainedDigest && /^[a-f0-9]{64}$/.test(retainedDigest)) {
    return retainedDigest;
  }
  return undefined;
}

function claudeSubmissionReservationKey(raw: Record<string, unknown>, observedAt: string): string {
  const attemptId = boundedOpaqueText(firstText(raw[TIRION_CLAUDE_SUBMISSION_ATTEMPT_FIELD]));
  return attemptId ?? opaqueHash("claude_submission_attempt", JSON.stringify([
    firstText(raw.session_id),
    firstText(raw.prompt_id, raw.turn_id),
    claudeSubmissionHookPromptDigest(raw),
    observedAt
  ]));
}

function claudePromptDigest(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function claudeSubmissionProvenance(
  raw: Record<string, unknown>
): ClaudeSubmissionProvenance | undefined {
  if (!("tirion_claude_submission_provenance" in raw)) {
    return undefined;
  }
  const value = raw.tirion_claude_submission_provenance;
  if (!isRecord(value)) {
    return unavailableClaudeSubmissionProvenance("malformed_provenance");
  }
  if (value.state === "unavailable" || value.state === "ambiguous") {
    const diagnosticReason = claudeSubmissionProvenanceDiagnosticReason(value.diagnosticReason);
    return {
      state: value.state,
      ...(diagnosticReason ? { diagnosticReason } : {})
    };
  }
  const transcriptPromptId = boundedOpaqueText(firstText(value.transcriptPromptId));
  if (
    value.state === "resolved"
    && transcriptPromptId
    && (
      (value.originKind === "human" && value.promptSource === "typed")
      || (value.originKind === "task-notification" && value.promptSource === "system")
    )
  ) {
    return {
      state: "resolved",
      originKind: value.originKind,
      promptSource: value.promptSource,
      transcriptPromptId
    };
  }
  return unavailableClaudeSubmissionProvenance("malformed_provenance");
}

export function isClaudeSubmissionProvenanceDiagnosticReason(
  value: unknown
): value is ClaudeSubmissionProvenanceDiagnosticReason {
  return typeof value === "string" && CLAUDE_SUBMISSION_PROVENANCE_DIAGNOSTIC_REASONS.has(
    value as ClaudeSubmissionProvenanceDiagnosticReason
  );
}

function claudeSubmissionProvenanceDiagnosticReason(
  value: unknown
): ClaudeSubmissionProvenanceDiagnosticReason | undefined {
  return isClaudeSubmissionProvenanceDiagnosticReason(value) ? value : undefined;
}

function claudeTranscriptTailUnavailableReason(
  value: unknown
): ClaudeTranscriptTailUnavailableReason | undefined {
  return typeof value === "string" && CLAUDE_TRANSCRIPT_TAIL_UNAVAILABLE_REASONS.has(
    value as ClaudeTranscriptTailUnavailableReason
  )
    ? value as ClaudeTranscriptTailUnavailableReason
    : undefined;
}

function boundedOpaqueText(value: string | undefined): string | undefined {
  return value && value.length <= 4_096 && !value.includes("\0") ? value : undefined;
}

function boundedOpaqueIds(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length <= 4_096 && !value.includes("\0")))].slice(0, 8);
}

function monotonicClaudeFailureCategory(
  current: RunCompletionFailureCategory,
  incoming: RunCompletionFailureCategory
): RunCompletionFailureCategory | undefined {
  if (current === incoming) {
    return current;
  }
  if (current === "unknown") {
    return incoming;
  }
  if (incoming === "unknown") {
    return current;
  }
  return undefined;
}

function rememberClaudeQueryCorrelation(
  store: Map<string, ClaudeCorrelation<ClaudeQueryIdentity>>,
  key: string,
  value: ClaudeQueryIdentity
): ClaudeCorrelation<ClaudeQueryIdentity> {
  const current = store.get(key);
  const next: ClaudeCorrelation<ClaudeQueryIdentity> = current?.state === "conflict"
    || (current?.state === "resolved" && !sameClaudeQueryIdentity(current.value, value))
    ? { state: "conflict" }
    : { state: "resolved", value: current?.state === "resolved" ? current.value : value };
  setBoundedMap(store, key, next);
  return next;
}

function rememberClaudeRequestCorrelation(
  store: Map<string, ClaudeCorrelation<ClaudeRequestIdentity>>,
  key: string,
  value: ClaudeRequestIdentity
): ClaudeCorrelation<ClaudeRequestIdentity> {
  const current = store.get(key);
  if (
    current?.state === "conflict"
    || (current?.state === "resolved" && !sameClaudeQueryIdentity(current.value, value))
    || (
      current?.state === "resolved"
      && current.value.usagePurpose
      && value.usagePurpose
      && current.value.usagePurpose !== value.usagePurpose
    )
  ) {
    const conflict = { state: "conflict" } as const;
    setBoundedMap(store, key, conflict);
    return conflict;
  }
  const resolved = {
    state: "resolved",
    value: {
      ...value,
      ...(current?.state === "resolved" && current.value.usagePurpose
        ? { usagePurpose: current.value.usagePurpose }
        : {})
    }
  } as const;
  setBoundedMap(store, key, resolved);
  return resolved;
}

function claudeUsagePurpose(value: unknown): UsagePurposeV1 | undefined {
  if (value === "generate_session_title") {
    return "auxiliary_session_title";
  }
  return value === "sdk" ? "customer" : undefined;
}

function claudeOperationUsagePurpose(value: unknown): UsagePurposeV1 | undefined {
  return value === "generate_session_title" ? "auxiliary_session_title" : undefined;
}

function hasProviderWorkItems(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return typeof value === "string" && value.trim().length > 0;
}

function owningToolActivityIds(
  provider: SafeObservationV1["provider"],
  signal: TelemetrySignal,
  records: Record<string, unknown>[],
  resourceAttributes: Record<string, unknown>,
  claudeTraceOwnership?: {
    parents: Map<string, ClaudeCorrelation<string>>;
    toolActivities: Map<string, ClaudeCorrelation<string>>;
  }
): Map<string, string> {
  if (provider === "claude-code" && signal === "traces" && claudeTraceOwnership) {
    rememberClaudeTraceOwnership(records, resourceAttributes, claudeTraceOwnership);
    const result = new Map<string, string>();
    for (const record of records) {
      const owningActivityId = resolveClaudeTraceToolActivity(record, claudeTraceOwnership);
      if (owningActivityId) {
        result.set(traceSpanRecordKey(record), owningActivityId);
      }
    }
    return result;
  }

  const bySpanId = new Map(records.flatMap((record) => {
    const spanId = firstText(record.spanId);
    return spanId ? [[spanId, record] as const] : [];
  }));
  const toolActivityIdsBySpan = new Map(records.flatMap((record) => {
    const spanId = firstText(record.spanId);
    const attributes = { ...resourceAttributes, ...otlpAttributes(record.attributes) };
    const name = firstText(record.name, attributes["event.name"]) ?? "";
    const isNativeClaudeToolDecision = provider === "claude-code"
      && isClaudeToolDecisionEventName(normalizedName(name));
    if (!spanId || provider === "codex" || isNativeClaudeToolDecision || !activityDescriptor(provider, name, attributes)) {
      return [];
    }
    // sanitizeActivityAtoms uses the native tool/call identity ahead of the
    // wrapper span ID. Preserve that exact identity here so descendant usage
    // points at the same activity instead of an unreachable span-keyed clone.
    const activityIdentity = firstText(
      attributes["tool_use_id"],
      attributes["call_id"],
      attributes["tool.call.id"],
      record.spanId
    );
    const traceId = firstText(record.traceId) ?? "";
    return activityIdentity
      ? [[spanId, activityIdFor(provider, traceId, activityIdentity)] as const]
      : [];
  }));
  const result = new Map<string, string>();
  for (const record of records) {
    const spanId = firstText(record.spanId);
    if (!spanId) {
      continue;
    }
    let current: Record<string, unknown> | undefined = record;
    const seen = new Set<string>();
    while (current) {
      const currentSpanId = firstText(current.spanId);
      if (!currentSpanId || seen.has(currentSpanId)) {
        break;
      }
      seen.add(currentSpanId);
      const owningActivityId = toolActivityIdsBySpan.get(currentSpanId);
      if (owningActivityId) {
        result.set(spanId, owningActivityId);
        break;
      }
      const parentSpanId = firstText(current.parentSpanId);
      current = parentSpanId ? bySpanId.get(parentSpanId) : undefined;
    }
  }
  return result;
}

function rememberClaudeTraceOwnership(
  records: Record<string, unknown>[],
  resourceAttributes: Record<string, unknown>,
  stores: {
    parents: Map<string, ClaudeCorrelation<string>>;
    toolActivities: Map<string, ClaudeCorrelation<string>>;
  }
): void {
  for (const record of records) {
    const traceId = firstText(record.traceId);
    const spanId = firstText(record.spanId);
    if (!traceId || !spanId) {
      continue;
    }
    const spanKey = traceSpanKey(traceId, spanId);
    const parentSpanId = firstText(record.parentSpanId);
    if (parentSpanId) {
      rememberExactStringCorrelation(stores.parents, spanKey, traceSpanKey(traceId, parentSpanId));
    }

    const attributes = { ...resourceAttributes, ...otlpAttributes(record.attributes) };
    const name = normalizedName(firstText(record.name, attributes["event.name"]) ?? "");
    const toolName = normalizedName(firstText(
      attributes["gen_ai.tool.name"],
      attributes["tool.name"],
      attributes["tool_name"]
    ) ?? "");
    const toolUseId = firstText(attributes["tool_use_id"]);
    if (name === "claude_code.tool" && toolName === "agent" && toolUseId) {
      rememberExactStringCorrelation(
        stores.toolActivities,
        spanKey,
        activityIdFor("claude-code", traceId, toolUseId)
      );
    }
  }
}

function resolveClaudeTraceToolActivity(
  record: Record<string, unknown>,
  stores: {
    parents: Map<string, ClaudeCorrelation<string>>;
    toolActivities: Map<string, ClaudeCorrelation<string>>;
  }
): string | undefined {
  const traceId = firstText(record.traceId);
  const spanId = firstText(record.spanId);
  if (!traceId || !spanId) {
    return undefined;
  }
  let current = traceSpanKey(traceId, spanId);
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const tool = stores.toolActivities.get(current);
    if (tool?.state === "conflict") {
      return undefined;
    }
    if (tool?.state === "resolved") {
      return tool.value;
    }
    const parent = stores.parents.get(current);
    if (!parent || parent.state === "conflict") {
      return undefined;
    }
    current = parent.value;
  }
  return undefined;
}

function rememberExactStringCorrelation(
  store: Map<string, ClaudeCorrelation<string>>,
  key: string,
  value: string
): void {
  const current = store.get(key);
  const next: ClaudeCorrelation<string> = current?.state === "conflict"
    || (current?.state === "resolved" && current.value !== value)
    ? { state: "conflict" }
    : { state: "resolved", value };
  setBoundedMap(store, key, next);
}

function traceSpanRecordKey(record: Record<string, unknown>): string {
  const traceId = firstText(record.traceId);
  const spanId = firstText(record.spanId);
  return traceId && spanId ? traceSpanKey(traceId, spanId) : "";
}

function owningToolRecordKey(
  provider: SafeObservationV1["provider"],
  signal: TelemetrySignal,
  record: Record<string, unknown>
): string {
  return provider === "claude-code" && signal === "traces"
    ? traceSpanRecordKey(record)
    : firstText(record.spanId) ?? "";
}

function traceSpanKey(traceId: string, spanId: string): string {
  return opaqueHash("tsp", `claude-trace|${traceId}|${spanId}`);
}

function activityDescriptor(
  provider: SafeObservationV1["provider"],
  rawName: string,
  attributes: Record<string, unknown>
): { kind: SafeActivityAtomV1["kind"]; name: string } | undefined {
  const name = normalizedName(rawName);
  const claudeToolDecision = provider === "claude-code" && isClaudeToolDecisionEventName(name);
  const isTool = provider === "github-copilot"
    ? name.startsWith("execute_tool") || name === "copilot_chat.tool.call"
      : provider === "claude-code"
      ? name === "claude_code.tool" || claudeToolDecision || name.includes("tool_result") || name.includes("tool_use")
      : provider === "codex"
        // Current Codex exposes the authoritative tool boundary through PostToolUse.
        // dispatch_tool_call spans are internal wrappers and can appear more than once
        // for one invocation, so treating them as tools double-counts customer work.
        ? name === "codex.tool_result"
        : name.includes("tool") || name.includes("shell") || name.includes("mcp");
  if (!isTool) {
    return undefined;
  }
  const toolName = safeActivityName(firstText(
    attributes["gen_ai.tool.name"],
    attributes["tool.name"],
    attributes["tool_name"],
    attributes["copilot.tool.name"],
    rawName.replace(/^execute_tool\s*/i, "")
  )) ?? "unknown";
  if (
    claudeToolDecision
    && (
      claudeToolDecisionOutcome(attributes["decision"]) == null
      || !firstText(attributes["tool_use_id"])
      || toolName === "unknown"
    )
  ) {
    return undefined;
  }
  // A permission decision carries an authority boundary, not a result. Its
  // parameters can contain input content, so never derive a richer semantic
  // name from them; retain only the safe primary tool category.
  const toolParameters = claudeToolDecision ? undefined : parseJsonRecord(firstText(attributes["tool_parameters"]));
  const skillName = safeActivityName(firstText(attributes["skill.name"], attributes["skill_name"], toolParameters?.skill_name));
  const explicitMcpServer = safeActivityName(firstText(
    attributes["mcp_server"],
    attributes["mcp_server.name"],
    toolParameters?.mcp_server_name
  ));
  const explicitMcpTool = safeActivityName(firstText(
    attributes["mcp_tool"],
    attributes["mcp_tool.name"],
    toolParameters?.mcp_tool_name
  ));
  // Claude Code can surface an MCP invocation only through its namespaced tool
  // name (`mcp__server__tool`). Parse that bounded identifier directly, never
  // tool arguments, and fail back to a generic tool if explicit metadata
  // disagrees with it.
  const namespacedMcp = provider === "claude-code" ? claudeMcpToolParts(toolName) : undefined;
  const mcpMetadataConflict = Boolean(
    namespacedMcp
    && (
      (explicitMcpServer && normalizedName(explicitMcpServer) !== normalizedName(namespacedMcp.server))
      || (explicitMcpTool && normalizedName(explicitMcpTool) !== normalizedName(namespacedMcp.tool))
    )
  );
  const mcpServer = mcpMetadataConflict ? undefined : explicitMcpServer ?? namespacedMcp?.server;
  const mcpTool = mcpMetadataConflict ? undefined : explicitMcpTool ?? namespacedMcp?.tool;
  const mcpName = mcpServer
    ? safeActivityName(mcpTool ? `${mcpServer}/${mcpTool}` : mcpServer)
    : undefined;
  const subagentName = safeActivityName(firstText(attributes["subagent_type"], toolParameters?.subagent_type));
  const normalizedTool = normalizedName(toolName);
  const isProviderSubagentOperation = provider === "github-copilot"
    && (normalizedTool === "runsubagent" || normalizedTool === "invokeagent");
  const kind: SafeActivityAtomV1["kind"] = mcpName
    ? "mcp"
    : skillName
      ? "skill"
      : subagentName || isProviderSubagentOperation
        ? "subagent"
        : "tool";
  return { kind, name: mcpName ?? skillName ?? subagentName ?? toolName };
}

function safeActivityName(value?: string): string | undefined {
  const text = value?.trim();
  return text && /^[A-Za-z0-9_.:/ -]{1,100}$/.test(text) ? text : undefined;
}

const CLAUDE_NAMESPACED_MCP_TOOL_NAME = /^mcp__([A-Za-z0-9][A-Za-z0-9_.-]{0,59})__([A-Za-z0-9][A-Za-z0-9_.-]{0,59})$/;

// This is the shared grammar for Claude's metadata-only MCP tool identity.
// Callers must still apply their own safe-name/output bounds before persisting
// a derived activity name.
export function isClaudeNamespacedMcpToolName(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_NAMESPACED_MCP_TOOL_NAME.test(value);
}

function claudeMcpToolParts(toolName: string): { server: string; tool: string } | undefined {
  const match = CLAUDE_NAMESPACED_MCP_TOOL_NAME.exec(toolName);
  if (!match) return undefined;
  const [, server, tool] = match;
  return { server, tool };
}

function parseJsonRecord(value?: string): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function activityOutcome(record: Record<string, unknown>, attributes: Record<string, unknown>): SafeActivityAtomV1["outcome"] {
  if (attributes.success === true) return "success";
  if (attributes.success === false) return "failure";
  const success = firstText(attributes.success)?.toLowerCase();
  if (success === "true") return "success";
  if (success === "false") return "failure";
  const otlpStatusCode = isRecord(record.status) ? Number(record.status.code) : Number.NaN;
  if (otlpStatusCode === 1) return "success";
  if (otlpStatusCode === 2) return "failure";
  const status = normalizedName(firstText(
    isRecord(record.status) ? record.status.code : undefined,
    attributes["status"],
    attributes["outcome"]
  ) ?? "");
  if (status.includes("reject")) return "rejected";
  if (status.includes("error") || status.includes("fail")) return "failure";
  if (status.includes("ok") || status.includes("success")) return "success";
  return "unknown";
}

function explicitLlmOutcome(
  record: Record<string, unknown>,
  attributes: Record<string, unknown>,
  endedAt: string | undefined
): SafeActivityAtomV1["outcome"] {
  const explicit = activityOutcome(record, attributes);
  return explicit === "unknown" && endedAt ? "success" : explicit;
}

function providerActivityOutcome(
  provider: SafeObservationV1["provider"],
  eventName: string,
  toolName: string,
  record: Record<string, unknown>,
  attributes: Record<string, unknown>
): SafeActivityAtomV1["outcome"] {
  if (provider === "claude-code" && isClaudeToolDecisionEventName(normalizedName(eventName))) {
    // Claude's documented tool-decision event establishes only whether
    // permission was accepted or rejected. An accepted decision is not a tool
    // result, so it must remain unknown until explicit result evidence arrives.
    return claudeToolDecisionOutcome(attributes["decision"]) ?? "unknown";
  }
  const outcome = activityOutcome(record, attributes);
  if (
    provider === "claude-code"
    && normalizedName(firstText(
      attributes["gen_ai.tool.name"],
      attributes["tool.name"],
      attributes["tool_name"]
    ) ?? "") === "agent"
  ) {
    if (outcome === "failure" || outcome === "rejected") {
      return outcome;
    }
    // Agent tool success establishes a successful launch/return boundary. It
    // does not prove that the linked child has reached an accepted terminal.
    return "unknown";
  }
  if (
    provider === "claude-code"
    && isHookShellTool(toolName)
  ) {
    if (outcome === "failure" || outcome === "rejected") {
      return outcome;
    }
    const explicit = explicitOtlpShellOutcome(attributes);
    if (explicit) {
      return explicit;
    }
    // Claude's log events and trace spans describe tool-protocol completion.
    // Neither surface establishes the child process result without an explicit
    // exit code or semantic process status.
    return "unknown";
  }
  if (
    provider === "codex"
    && normalizedName(eventName) === "codex.tool_result"
    && isHookShellTool(toolName)
    && outcome === "success"
  ) {
    // Codex reports whether unified exec returned a protocol result here, not
    // whether the child process exited successfully. Preserve explicit dispatch
    // failures, but do not turn a protocol success into a shell outcome.
    return "unknown";
  }
  return outcome;
}

function claudeToolDecisionOutcome(value: unknown): SafeActivityAtomV1["outcome"] | undefined {
  const decision = normalizedName(firstText(value) ?? "");
  if (decision === "reject") return "rejected";
  if (decision === "accept") return "unknown";
  return undefined;
}

function isClaudeToolDecisionEventName(name: string): boolean {
  return name === "claude_code.tool_decision" || name === "tool_decision";
}

function explicitOtlpShellOutcome(
  attributes: Record<string, unknown>
): SafeActivityAtomV1["outcome"] | undefined {
  if (
    explicitBoolean(attributes["interrupted"]) === true
    || explicitBoolean(attributes["is_interrupt"]) === true
    || explicitBoolean(attributes["isInterrupt"]) === true
  ) {
    return "rejected";
  }
  if (
    explicitBoolean(attributes["success"]) === false
    || explicitBoolean(attributes["is_error"]) === true
    || explicitBoolean(attributes["isError"]) === true
    || firstText(attributes["error"])
  ) {
    return "failure";
  }
  const statusOutcomes = [
    attributes["command_status"],
    attributes["shell.status"],
    attributes["exit_status"],
    attributes["status"],
    attributes["outcome"]
  ].map((value) => explicitShellStatusOutcome(firstText(value)));
  if (statusOutcomes.includes("rejected")) {
    return "rejected";
  }
  if (statusOutcomes.includes("failure")) {
    return "failure";
  }
  const exitCode = nonnegativeInteger(firstText(
    attributes["exit_code"],
    attributes["exit.code"],
    attributes["process.exit_code"],
    attributes["process.exit.code"],
    attributes["command.exit_code"],
    attributes["shell.exit_code"]
  ));
  if (exitCode != null) {
    return exitCode === 0 ? "success" : "failure";
  }
  return statusOutcomes.includes("success") ? "success" : undefined;
}

function explicitShellStatusOutcome(value?: string): SafeActivityAtomV1["outcome"] | undefined {
  if (!value) {
    return undefined;
  }
  const status = normalizedName(value);
  const tokens = status.split(/[^a-z0-9]+/).filter(Boolean);
  if (
    status === "unsuccessful"
    || tokens.some((token) => ["fail", "failed", "failure", "error", "errored"].includes(token))
  ) {
    return "failure";
  }
  if (tokens.some((token) => [
    "interrupt",
    "interrupted",
    "cancel",
    "canceled",
    "cancelled",
    "reject",
    "rejected"
  ].includes(token))) {
    return "rejected";
  }
  if (["success", "successful", "succeeded", "ok"].includes(status)) {
    return "success";
  }
  return undefined;
}

function explicitBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const text = firstText(value)?.trim().toLowerCase();
  return text === "true" ? true : text === "false" ? false : undefined;
}

function codexMetricOutcome(value: unknown): SafeActivityAtomV1["outcome"] {
  const status = normalizedName(firstText(value) ?? "");
  if (status === "ok" || status.includes("success")) return "success";
  if (status.includes("fail") || status.includes("error")) return "failure";
  if (status.includes("reject") || status.includes("cancel")) return "rejected";
  return "unknown";
}

export function canonicalSensitiveAuditKind(kind: SensitiveAuditEvidenceV1["kind"]): SensitiveAuditCanonicalKind {
  return SENSITIVE_AUDIT_KEY_DEFINITIONS.find((definition) => definition.kind === kind)?.canonicalKind ?? "file_content";
}

export function displayLabelForSensitiveAuditKind(kind: SensitiveAuditEvidenceV1["kind"]): string {
  return SENSITIVE_AUDIT_KEY_DEFINITIONS.find((definition) => definition.kind === kind)?.displayLabel ?? kind.replaceAll("_", " ");
}

function sensitiveAuditEvidence(
  attributes: Record<string, unknown>,
  capturedAt: string,
  activity?: Pick<SafeActivityAtomV1, "kind" | "name">
): SensitiveAuditEvidenceV1[] {
  const entries: SensitiveAuditEvidenceV1[] = [];
  for (const definition of SENSITIVE_AUDIT_KEY_DEFINITIONS) {
    for (const key of definition.keys) {
      const value = firstSensitiveText(attributes[key]);
      if (!value) {
        continue;
      }
      entries.push({
        schemaVersion: 1,
        evidenceId: opaqueHash("evidence", `${definition.kind}|${key}|${capturedAt}|${value}`),
        kind: definition.kind,
        label: key,
        value: value.slice(0, 65_536),
        source: "provider_telemetry",
        activityKind: activity?.kind,
        activityName: activity?.name,
        capturedAt
      });
    }
  }
  return entries.slice(0, 25);
}

const SENSITIVE_AUDIT_KEY_DEFINITIONS: SensitiveAuditKeyDefinition[] = [{
  kind: "tool_arguments",
  canonicalKind: "tool_input",
  displayLabel: "tool input",
  keys: [
    "gen_ai.tool.call.arguments",
    "tool.arguments",
    "tool.args",
    "tool_input",
    "input",
    "arguments"
  ],
}, {
  kind: "tool_output",
  canonicalKind: "tool_output",
  displayLabel: "tool output",
  keys: [
    "gen_ai.tool.call.result",
    "gen_ai.tool.result",
    "tool.result",
    "tool.output",
    "tool_response",
    "tool_output",
    "output",
    "result"
  ],
}, {
  kind: "path",
  canonicalKind: "path",
  displayLabel: "path",
  keys: [
    "file.path",
    "file_path",
    "path",
    "cwd",
    "working_directory"
  ],
}, {
  kind: "diff",
  canonicalKind: "diff",
  displayLabel: "diff",
  keys: [
    "diff",
    "patch",
    "file.diff"
  ],
}, {
  kind: "file_content",
  canonicalKind: "file_content",
  displayLabel: "file content",
  keys: [
    "file.content",
    "file_content",
    "content"
  ],
}];

const SPAN_EVENT_CONTENT_KEYS = new Set<string>(SENSITIVE_AUDIT_KEY_DEFINITIONS.flatMap((definition) => definition.keys));

function firstSensitiveText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() ? value : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" && serialized !== "[]" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function nonnegativeInteger(value?: string): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function durationBetween(startedAt: string, endedAt?: string): number | undefined {
  if (!endedAt) return undefined;
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function timestampAtOrAfterWithin(candidate: string, anchor: string, maximumDifferenceMs: number): boolean {
  const difference = Date.parse(candidate) - Date.parse(anchor);
  return Number.isFinite(difference) && difference >= 0 && difference <= maximumDifferenceMs;
}

function activityIdFor(provider: SafeObservationV1["provider"], traceId: string, spanId: string): string {
  return opaqueHash("act", `${provider}|${traceId}|${spanId}`);
}

function nativeClaudeToolDecisionActivityId(traceId: string, toolUseId: string): string {
  return opaqueHash("act", `claude-code|${traceId}|native_permission_decision|${toolUseId}`);
}

function nativeClaudeToolDecisionExecutionNodeId(queryId: string, traceId: string, toolUseId: string): string {
  return opaqueHash("node", `claude-code|${queryId}|${traceId}|native_permission_decision|${toolUseId}`);
}

function promptNodeId(queryId: string): string {
  return `node_prompt_${queryId.slice(4)}`;
}

function executionNodeId(
  provider: SafeObservationV1["provider"],
  queryId: string,
  traceId: string,
  spanId?: string,
  startedAt?: string,
  fallbackName?: string
): string {
  if (spanId) {
    return opaqueHash("node", `${provider}|${queryId}|${traceId}|${spanId}`);
  }
  return opaqueHash("node", `${provider}|${queryId}|${traceId}|${startedAt ?? ""}|${fallbackName ?? "event"}`);
}

function executionNodeKindForActivity(kind: SafeActivityAtomV1["kind"]): ExecutionNodeAtomV1["nodeKind"] {
  if (kind === "tool") return "tool";
  if (kind === "subagent") return "subagent";
  if (kind === "skill") return "skill";
  if (kind === "mcp") return "mcp";
  return "unknown";
}

function executionNodeDisplayName(provider: SafeObservationV1["provider"], name: string, model?: string): string {
  const normalized = normalizedName(name);
  if (provider === "github-copilot" && normalized.startsWith("invoke_agent")) {
    return "invoke_agent";
  }
  if (provider === "codex" && normalized.includes("turn")) {
    return "turn";
  }
  if (provider === "claude-code" && normalized.includes("request")) {
    return "request";
  }
  return model ? `${normalized || "request"} (${model})` : normalized || "request";
}

function executionContentsFromSensitiveAudit(
  attributes: Record<string, unknown>,
  startedAt: string
): ExecutionNodeContentV1[] | undefined {
  const evidence = sensitiveAuditEvidence(attributes, startedAt);
  const contents = evidence.map<ExecutionNodeContentV1>((item) => {
    return {
      schemaVersion: 1,
      kind: canonicalSensitiveAuditKind(item.kind),
      visibility: "visible",
      text: item.value,
      preview: previewText(item.value)
    };
  });
  return contents.length > 0 ? contents : undefined;
}

function previewText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function promptHookObservation(input: {
  provider: ProviderHookSource;
  sourceId: string;
  profileVersion: string;
  observedAt: string;
  startedAt?: string;
  query: string;
  session: string;
  parentSession?: string;
  evidence: QueryOccurrenceV1["evidence"];
  lifecycleVisibility?: QueryOccurrenceV1["lifecycleVisibility"];
}): SafeObservationV1 {
  const startedAt = input.startedAt ?? input.observedAt;
  const queryId = opaqueHash("qry", `${input.provider}|${input.query}`);
  const sessionId = opaqueHash("ses", `${input.provider}|${input.session}`);
  const requestId = opaqueHash("req", `${input.provider}|${input.query}`);
  return {
    schemaVersion: 1,
    observationId: opaqueHash("obs", `${input.sourceId}|${input.query}|${input.observedAt}`),
    sourceId: input.sourceId,
    provider: input.provider,
    runtime: input.provider,
    signal: "logs",
    profileVersion: input.profileVersion,
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    queryOccurrences: [{
      schemaVersion: 1,
      queryId,
      sessionId,
      ...(input.parentSession ? { parentSessionId: opaqueHash("ses", `${input.provider}|${input.parentSession}`) } : {}),
      ...(input.lifecycleVisibility ? { lifecycleVisibility: input.lifecycleVisibility } : {}),
      provider: input.provider,
      runtime: input.provider,
      startedAt,
      promptState: "disabled",
      evidence: input.evidence
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: promptNodeId(queryId),
      queryId,
      sessionId,
      requestId,
      provider: input.provider,
      runtime: input.provider,
      signal: "logs",
      nodeKind: "prompt",
      name: "Prompt",
      outcome: "success",
      startedAt
    }],
    usageAtoms: []
  };
}

function internalCodexHookObservation(input: {
  observedAt: string;
  query: string;
  session: string;
  startedAt: string;
}): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: opaqueHash("obs", `hook_codex_internal|${input.query}|${input.observedAt}`),
    sourceId: "hook_codex_internal",
    provider: "codex",
    runtime: "codex",
    signal: "logs",
    profileVersion: "codex-hooks-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    queryOccurrences: [{
      schemaVersion: 1,
      queryId: opaqueHash("qry", `codex|${input.query}`),
      sessionId: opaqueHash("ses", `codex|${input.session}`),
      lifecycleVisibility: "internal",
      provider: "codex",
      runtime: "codex",
      startedAt: input.startedAt,
      promptState: "disabled",
      evidence: "provider_prompt_id"
    }],
    usageAtoms: []
  };
}

function completionHookObservation(input: {
  provider: ProviderHookSource;
  sourceId: string;
  profileVersion: string;
  observedAt: string;
  query: string;
  session: string;
  startedAt: string;
  completionEvidence: NonNullable<QueryOccurrenceV1["completionEvidence"]>;
  completionOutcome?: QueryOccurrenceV1["completionOutcome"];
  completionFailureCategory?: RunCompletionFailureCategory;
  observationIdentity?: string;
  completedAt?: string;
}): SafeObservationV1 {
  const queryId = opaqueHash("qry", `${input.provider}|${input.query}`);
  const sessionId = opaqueHash("ses", `${input.provider}|${input.session}`);
  return {
    schemaVersion: 1,
    observationId: opaqueHash(
      "obs",
      input.observationIdentity ?? `${input.sourceId}|${input.query}|completed|${input.observedAt}`
    ),
    sourceId: input.sourceId,
    provider: input.provider,
    runtime: input.provider,
    signal: "logs",
    profileVersion: input.profileVersion,
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    queryOccurrences: [{
      schemaVersion: 1,
      queryId,
      sessionId,
      provider: input.provider,
      runtime: input.provider,
      startedAt: input.startedAt,
      completedAt: input.completedAt ?? input.observedAt,
      completionEvidence: input.completionEvidence,
      ...(input.completionOutcome ? { completionOutcome: input.completionOutcome } : {}),
      ...(input.completionFailureCategory
        ? { completionFailureCategory: input.completionFailureCategory }
        : {}),
      promptState: "disabled",
      evidence: "submission_hook"
    }],
    usageAtoms: []
  };
}

function claudeCompletedOccurrence(
  candidate: ClaudeStopCandidate,
  completedAt: string,
  classification: ReturnType<DefaultTelemetryClassification["classify"]>
): QueryOccurrenceV1 {
  return {
    schemaVersion: 1,
    queryId: opaqueHash("qry", `claude-code|${candidate.query}`),
    sessionId: opaqueHash("ses", `claude-code|${candidate.session}`),
    provider: "claude-code",
    runtime: classification.runtime,
    startedAt: candidate.startedAt,
    completedAt,
    completionEvidence: "closed_root_span",
    promptState: "disabled",
    evidence: "submission_hook"
  };
}

function claudeStopFailureCategory(value: unknown): RunCompletionFailureCategory | undefined {
  const category = firstText(value);
  if (!category) {
    return undefined;
  }
  return CLAUDE_STOP_FAILURE_CATEGORIES.has(category as RunCompletionFailureCategory)
    ? category as RunCompletionFailureCategory
    : "unknown";
}

const CLAUDE_STOP_FAILURE_CATEGORIES = new Set<RunCompletionFailureCategory>([
  "rate_limit",
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "invalid_request",
  "server_error",
  "max_output_tokens",
  "unknown"
]);

function hookObservation(input: {
  provider: ProviderHookSource;
  sourceId: string;
  profileVersion: string;
  observedAt: string;
  query: string;
  session: string;
  request: string;
  observationRevision?: string;
  activity: {
    kind: SafeActivityAtomV1["kind"];
    name: string;
    outcome: SafeActivityAtomV1["outcome"];
    durationMs?: number;
    sensitiveAuditEvidence?: SensitiveAuditEvidenceV1[];
    childSession?: string;
    timingConfidence?: SafeActivityAtomV1["timingConfidence"];
  };
  node: {
    nodeKind: ExecutionNodeAtomV1["nodeKind"];
    name: string;
    toolName?: string;
    /** Raw provider tool-use ID; converted to an opaque execution identity below. */
    invocation?: string;
    outcome: ExecutionNodeAtomV1["outcome"];
    startedAt: string;
    endedAt?: string;
    durationMs?: number;
    contents?: ExecutionNodeContentV1[];
  };
}): SafeObservationV1 {
  const queryId = opaqueHash("qry", `${input.provider}|${input.query}`);
  const sessionId = opaqueHash("ses", `${input.provider}|${input.session}`);
  const requestId = opaqueHash("req", `${input.provider}|${input.request}`);
  const invocationId = input.node.invocation
    ? opaqueHash("invocation", `${input.provider}|${input.node.invocation}`)
    : undefined;
  // Keep separate provider tool uses separately durable even when a hook
  // surface reuses its request ID. The opaque invocation field joins them
  // semantically; this ID prevents storage replacement before that join.
  const activityId = activityIdFor(input.provider, input.query, input.node.invocation ?? requestId);
  return {
    schemaVersion: 1,
    observationId: opaqueHash("obs", [
      input.sourceId,
      input.query,
      input.request,
      input.node.startedAt,
      JSON.stringify(input.node.contents ?? []),
      input.observationRevision ?? "semantic"
    ].join("|")),
    sourceId: input.sourceId,
    provider: input.provider,
    runtime: input.provider,
    signal: "logs",
    profileVersion: input.profileVersion,
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    activityAtoms: [{
      schemaVersion: 1,
      activityId,
      queryId,
      sessionId,
      requestId,
      ...(input.provider === "claude-code" && invocationId ? { invocationId } : {}),
      provider: input.provider,
      runtime: input.provider,
      kind: input.activity.kind,
      name: input.activity.name,
      outcome: input.activity.outcome,
      durationMs: input.activity.durationMs,
      evidenceBasis: input.activity.kind === "subagent" ? "subagent_hook" : "tool_hook",
      evidenceSourceId: input.sourceId,
      evidenceProfileVersion: input.profileVersion,
      identityConfidence: "high",
      timingConfidence: input.activity.timingConfidence ?? "high",
      ...(input.activity.childSession
        ? { childSessionId: opaqueHash("ses", `${input.provider}|${input.activity.childSession}`) }
        : {}),
      ...(input.activity.sensitiveAuditEvidence ? { sensitiveAuditEvidence: input.activity.sensitiveAuditEvidence } : {}),
      startedAt: input.node.startedAt,
      endedAt: input.node.endedAt
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: executionNodeId(input.provider, queryId, input.query, requestId, input.node.startedAt, normalizedName(input.node.name)),
      queryId,
      sessionId,
      requestId,
      ...(invocationId ? { invocationId } : {}),
      provider: input.provider,
      runtime: input.provider,
      signal: "logs",
      nodeKind: input.node.nodeKind,
      name: input.node.name,
      parentNodeId: promptNodeId(queryId),
      outcome: input.node.outcome,
      startedAt: input.node.startedAt,
      endedAt: input.node.endedAt,
      durationMs: input.node.durationMs,
      toolName: input.node.toolName,
      contents: input.node.contents
    }],
    usageAtoms: []
  };
}

function cursorUsageHookObservation(input: {
  observedAt: string;
  turn: ActiveCursorTurn;
  endedAt?: string;
  model?: string;
  usage: ReturnType<typeof tokenUsage>;
  completedAt?: string;
  completionEvidence?: NonNullable<QueryOccurrenceV1["completionEvidence"]>;
}): SafeObservationV1 {
  const classification = {
    provider: "cursor" as const,
    runtime: "cursor",
    sourceId: "hook_cursor_lifecycle",
    profileVersion: "cursor-hooks-v1"
  };
  const queryId = opaqueHash("qry", `cursor|${input.turn.query}`);
  const sessionId = opaqueHash("ses", `cursor|${input.turn.session}`);
  const requestId = opaqueHash("req", `cursor|${input.turn.query}`);
  const usage = input.usage;
  return {
    schemaVersion: 1,
    observationId: opaqueHash("obs", [
      classification.sourceId,
      input.turn.query,
      input.observedAt,
      input.endedAt ?? "open",
      JSON.stringify(usage)
    ].join("|")),
    sourceId: classification.sourceId,
    provider: classification.provider,
    runtime: classification.runtime,
    signal: "logs",
    profileVersion: classification.profileVersion,
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    ...(input.completedAt ? {
      queryOccurrences: [{
        schemaVersion: 1 as const,
        queryId,
        sessionId,
        provider: "cursor" as const,
        runtime: "cursor",
        startedAt: input.turn.startedAt,
        completedAt: input.completedAt,
        completionEvidence: input.completionEvidence ?? "stop_hook",
        promptState: "disabled" as const,
        evidence: "submission_hook" as const
      }]
    } : {}),
    executionNodes: [{
      schemaVersion: 1,
      nodeId: executionNodeId("cursor", queryId, input.turn.query, requestId, input.turn.startedAt, "cursor_turn"),
      queryId,
      sessionId,
      requestId,
      provider: "cursor",
      runtime: "cursor",
      signal: "logs",
      nodeKind: "llm_request",
      name: input.model ?? "cursor_turn",
      parentNodeId: promptNodeId(queryId),
      outcome: input.endedAt ? "success" : "unknown",
      startedAt: input.turn.startedAt,
      endedAt: input.endedAt,
      model: input.model,
      ...usage
    }],
    usageAtoms: [safeAtom({
      classification,
      identity: { query: input.turn.query, session: input.turn.session, request: input.turn.query },
      signal: "logs",
      authority: "turn",
      completionMode: "explicit",
      billingContext: cursorBillingContextForModel(input.model),
      model: input.model,
      usage,
      startedAt: input.turn.startedAt,
      endedAt: input.endedAt
    })]
  };
}

function cursorActivityHookObservation(input: {
  observedAt: string;
  turn: ActiveCursorTurn;
  activity: {
    request: string;
    kind: SafeActivityAtomV1["kind"];
    name: string;
    outcome: SafeActivityAtomV1["outcome"];
    startedAt: string;
    endedAt?: string;
    durationMs?: number;
    evidenceBasis: WebhookEvidenceBasisV1;
    childSession?: string;
  };
}): SafeObservationV1 {
  const queryId = opaqueHash("qry", `cursor|${input.turn.query}`);
  const sessionId = opaqueHash("ses", `cursor|${input.turn.session}`);
  const requestId = opaqueHash("req", `cursor|${input.activity.request}`);
  const activityId = activityIdFor("cursor", input.turn.query, requestId);
  return {
    schemaVersion: 1,
    observationId: opaqueHash("obs", [
      "hook_cursor_tools",
      input.turn.query,
      input.activity.request,
      input.activity.startedAt,
      input.activity.endedAt ?? "open",
      input.activity.outcome
    ].join("|")),
    sourceId: "hook_cursor_tools",
    provider: "cursor",
    runtime: "cursor",
    signal: "logs",
    profileVersion: "cursor-hooks-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    activityAtoms: [{
      schemaVersion: 1,
      activityId,
      queryId,
      sessionId,
      requestId,
      provider: "cursor",
      runtime: "cursor",
      kind: input.activity.kind,
      name: input.activity.name,
      outcome: input.activity.outcome,
      durationMs: input.activity.durationMs,
      ...(input.activity.childSession
        ? { childSessionId: opaqueHash("ses", `cursor|${input.activity.childSession}`) }
        : {}),
      startedAt: input.activity.startedAt,
      endedAt: input.activity.endedAt,
      evidenceBasis: input.activity.evidenceBasis,
      evidenceSourceId: "hook_cursor_tools",
      evidenceProfileVersion: "cursor-hooks-v1"
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: executionNodeId("cursor", queryId, input.turn.query, requestId, input.activity.startedAt, input.activity.name),
      queryId,
      sessionId,
      requestId,
      provider: "cursor",
      runtime: "cursor",
      signal: "logs",
      nodeKind: executionNodeKindForActivity(input.activity.kind),
      name: input.activity.name,
      parentNodeId: promptNodeId(queryId),
      outcome: input.activity.outcome,
      startedAt: input.activity.startedAt,
      endedAt: input.activity.endedAt,
      durationMs: input.activity.durationMs,
      toolName: input.activity.name
    }],
    usageAtoms: []
  };
}

function cursorActivityFromHook(
  eventName: string,
  raw: Record<string, unknown>,
  observedAt: string
): {
  request: string;
  kind: SafeActivityAtomV1["kind"];
  name: string;
  outcome: SafeActivityAtomV1["outcome"];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  evidenceBasis: WebhookEvidenceBasisV1;
  childSession?: string;
} | undefined {
  const durationMs = nonnegativeInteger(firstText(raw.duration_ms));
  const startedAt = subtractDurationMs(observedAt, durationMs) ?? observedAt;
  if (eventName === "pretooluse" || eventName === "posttooluse" || eventName === "posttoolusefailure") {
    const name = safeActivityName(firstText(raw.tool_name, raw.tool)) ?? "unknown";
    const descriptor = activityDescriptor("cursor", "cursor.tool_call", { tool_name: name }) ?? { kind: "tool" as const, name };
    return {
      request: firstText(raw.tool_call_id, raw.tool_use_id) ?? `${eventName}|${name}|${observedAt}`,
      kind: descriptor.kind,
      name: descriptor.name,
      outcome: eventName === "pretooluse" ? "unknown" : eventName === "posttoolusefailure" ? "failure" : hookOutcomeFromResponse(raw.tool_response),
      startedAt,
      endedAt: eventName === "pretooluse" ? undefined : observedAt,
      durationMs,
      evidenceBasis: descriptor.kind === "subagent" ? "subagent_hook" : descriptor.kind === "mcp" ? "tool_hook" : "tool_hook"
    };
  }
  if (eventName === "beforeshellexecution" || eventName === "aftershellexecution") {
    const exitCode = nonnegativeInteger(firstText(raw.exit_code, raw.exitCode));
    return {
      request: firstText(raw.shell_execution_id) ?? `shell|${observedAt}`,
      kind: "tool",
      name: "shell_exec",
      outcome: eventName === "beforeshellexecution" ? "unknown" : exitCode == null || exitCode === 0 ? "success" : "failure",
      startedAt,
      endedAt: eventName === "beforeshellexecution" ? undefined : observedAt,
      durationMs,
      evidenceBasis: "tool_hook"
    };
  }
  if (eventName === "beforemcpexecution" || eventName === "aftermcpexecution") {
    const server = safeActivityName(firstText(raw.server, raw.mcp_server));
    const tool = safeActivityName(firstText(raw.tool, raw.tool_name)) ?? "mcp_call";
    return {
      request: firstText(raw.mcp_call_id, raw.tool_call_id) ?? `mcp|${server ?? ""}|${tool}|${observedAt}`,
      kind: "mcp",
      name: server ? `${server}/${tool}` : tool,
      outcome: eventName === "beforemcpexecution" ? "unknown" : hookOutcomeFromResponse(raw.tool_response),
      startedAt,
      endedAt: eventName === "beforemcpexecution" ? undefined : observedAt,
      durationMs,
      evidenceBasis: "tool_hook"
    };
  }
  if (eventName === "subagentstart" || eventName === "subagentstop") {
    const name = safeActivityName(firstText(raw.subagent_type, raw.type, raw.agent_name, raw.name)) ?? "subagent";
    return {
      request: firstText(raw.subagent_id, raw.agent_id, raw.tool_call_id, raw.tool_use_id) ?? `subagent|${name}|${observedAt}`,
      kind: "subagent",
      name,
      outcome: eventName === "subagentstart" ? "unknown" : raw.error ? "failure" : "success",
      startedAt,
      endedAt: eventName === "subagentstart" ? undefined : observedAt,
      durationMs,
      evidenceBasis: "subagent_hook",
      childSession: firstText(raw.subagent_id, raw.agent_id)
    };
  }
  if (eventName === "afterfileedit") {
    return {
      request: firstText(raw.edit_id, raw.tool_call_id) ?? `file_edit|${observedAt}`,
      kind: "tool",
      name: "file_edit",
      outcome: "success",
      startedAt,
      endedAt: observedAt,
      durationMs,
      evidenceBasis: "tool_hook"
    };
  }
  return undefined;
}

function hookSensitiveAttributes(
  toolInput: unknown,
  toolOutput: unknown,
  cwd?: string
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    tool_input: toolInput
  };
  if (toolOutput != null) {
    attributes.tool_output = toolOutput;
  }
  if (cwd) {
    attributes.cwd = cwd;
  }
  copyHookSurfaceFields(attributes, toolInput);
  copyHookSurfaceFields(attributes, toolOutput);
  return attributes;
}

function copyHookSurfaceFields(target: Record<string, unknown>, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["file_path", "path", "cwd", "working_directory", "diff", "patch", "file_content", "content"]) {
    if (target[key] == null && value[key] != null) {
      target[key] = value[key];
    }
  }
}

function subtractDurationMs(observedAt: string, durationMs?: number): string | undefined {
  if (durationMs == null) {
    return undefined;
  }
  const milliseconds = Date.parse(observedAt) - durationMs;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function hookOutcomeFromResponse(value: unknown): SafeActivityAtomV1["outcome"] {
  if (!isRecord(value)) {
    return "success";
  }
  if (typeof value.success === "boolean") {
    return value.success ? "success" : "failure";
  }
  if (typeof value.interrupted === "boolean") {
    return value.interrupted ? "rejected" : "success";
  }
  if (typeof value.is_error === "boolean") {
    return value.is_error ? "failure" : "success";
  }
  if (typeof value.isError === "boolean") {
    return value.isError ? "failure" : "success";
  }
  if (typeof value.exit_code === "number") {
    return value.exit_code === 0 ? "success" : "failure";
  }
  if (typeof value.exitCode === "number") {
    return value.exitCode === 0 ? "success" : "failure";
  }
  if (typeof value.status === "string") {
    const status = normalizedName(value.status);
    if (status.includes("fail") || status.includes("error")) {
      return "failure";
    }
    if (status.includes("interrupt") || status.includes("cancel")) {
      return "rejected";
    }
  }
  return "success";
}

function claudeHookOutcome(toolName: string, value: unknown): SafeActivityAtomV1["outcome"] {
  if (!isHookShellTool(toolName)) {
    return hookOutcomeFromResponse(value);
  }
  if (!isRecord(value)) {
    return "unknown";
  }
  if (
    explicitBoolean(value.interrupted) === true
    || explicitBoolean(value.is_interrupt) === true
    || explicitBoolean(value.isInterrupt) === true
  ) {
    return "rejected";
  }
  if (
    explicitBoolean(value.success) === false
    || explicitBoolean(value.is_error) === true
    || explicitBoolean(value.isError) === true
    || firstText(value.error)
  ) {
    return "failure";
  }
  const exitCode = nonnegativeInteger(firstText(value.exit_code, value.exitCode));
  if (exitCode != null) {
    return exitCode === 0 ? "success" : "failure";
  }
  if (typeof value.status === "string") {
    return explicitShellStatusOutcome(value.status) ?? "unknown";
  }
  return "unknown";
}

function codexHookOutcome(toolName: string, value: unknown): SafeActivityAtomV1["outcome"] {
  if (!isRecord(value) && isHookShellTool(toolName)) {
    return "unknown";
  }
  return hookOutcomeFromResponse(value);
}

function isHookShellTool(toolName: string): boolean {
  const normalized = normalizedName(toolName).replace(/[.:/\-]/g, "_");
  return ["bash", "exec_command", "write_stdin", "shell", "shell_command", "unified_exec"].includes(normalized);
}

function otlpAttributes(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(value.filter(isRecord).flatMap((attribute) => {
    if (typeof attribute.key !== "string" || !isRecord(attribute.value)) {
      return [];
    }
    return [[attribute.key, unwrapOtlpValue(attribute.value)]];
  }));
}

function unwrapOtlpValue(value: Record<string, unknown>): unknown {
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    if (value[key] != null) {
      return value[key];
    }
  }
  return undefined;
}

function tokenUsage(attributes: Record<string, unknown>): Pick<
  SafeUsageAtomV1,
  "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "reasoningOutputTokens"
> {
  return {
    inputTokens: firstNumber(attributes, ["codex.turn.token_usage.input_tokens", "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "input_tokens", "prompt_tokens", "input_token_count"]),
    outputTokens: firstNumber(attributes, ["codex.turn.token_usage.output_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "output_tokens", "completion_tokens", "output_token_count"]),
    cacheReadInputTokens: firstNumber(attributes, ["codex.turn.token_usage.cached_input_tokens", "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cached_tokens", "cursor.usage.cache_read_tokens", "cache_read_input_tokens", "cache_read_tokens", "cacheReadTokens", "cached_tokens", "cached_token_count"]),
    cacheCreationInputTokens: firstNumber(attributes, ["gen_ai.usage.cache_creation.input_tokens", "cursor.usage.cache_write_tokens", "cache_creation_input_tokens", "cache_creation_tokens", "cache_write_tokens", "cacheWriteTokens"]),
    reasoningOutputTokens: firstNumber(attributes, ["codex.turn.token_usage.reasoning_output_tokens", "gen_ai.usage.reasoning.output_tokens", "cursor.usage.reasoning_tokens", "reasoning_output_tokens", "reasoning_tokens", "reasoning_token_count"])
  };
}

function codexExplicitTurnId(attributes: Record<string, unknown>): string | undefined {
  return firstText(attributes["turn.id"], attributes["gen_ai.turn.id"]);
}

function codexSessionId(attributes: Record<string, unknown>, traceId?: string): string | undefined {
  return firstText(
    attributes["thread.id"],
    attributes["conversation.id"],
    attributes["gen_ai.conversation.id"],
    attributes["session.id"],
    traceId
  );
}

function codexHookSession(raw: Record<string, unknown>): string | undefined {
  const transcriptPath = firstText(raw.transcript_path, raw.transcriptPath);
  const transcriptFile = transcriptPath?.split(/[\\/]/).at(-1);
  const transcriptSession = transcriptFile?.match(
    /(?:^|[-_])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  )?.[1];
  return transcriptSession ?? firstText(raw.session_id);
}

function codexHookHasTranscriptLocator(raw: Record<string, unknown>): boolean {
  return firstText(raw.transcript_path, raw.transcriptPath) != null;
}

function sessionOnlyCodexIdentity(
  record: Record<string, unknown>,
  attributes: Record<string, unknown>
): { session?: string } | undefined {
  const session = codexSessionId(attributes, firstText(record.traceId));
  return session ? { session } : undefined;
}

function providerIdentity(
  provider: SafeObservationV1["provider"],
  record: Record<string, unknown>,
  attributes: Record<string, unknown>,
  name: string
): ProviderTelemetryIdentity | undefined {
  const traceId = firstText(record.traceId);
  const spanId = firstText(record.spanId);
  const eventSequence = firstText(attributes["event.sequence"]);
  if (provider === "claude-code") {
    const query = firstText(
      attributes["prompt.id"],
      normalizedName(name).includes("interaction") ? traceId : undefined
    );
    const session = firstText(attributes["session.id"], attributes["gen_ai.conversation.id"]);
    if (!query || !session) {
      return undefined;
    }
    return {
      query,
      session,
      request: firstText(attributes["request.id"], spanId, traceId, eventSequence && `${session}|${eventSequence}`) ?? query
    };
  }
  if (provider === "codex") {
    const session = codexSessionId(attributes, traceId);
    const eventAt = firstText(attributes["event.timestamp"], record.timeUnixNano);
    const query = firstText(
      codexExplicitTurnId(attributes),
      normalizedName(name).includes("user_prompt") && session && eventAt ? `${session}|${timestampToIso(eventAt, undefined)}` : undefined,
      traceId
    );
    if (!query) {
      return undefined;
    }
    return {
      query,
      session: session ?? query,
      request: firstText(attributes["request.id"], spanId, traceId, eventSequence && `${query}|${eventSequence}`) ?? query
    };
  }
  if (provider === "cursor") {
    const session = firstText(
      attributes["cursor.conversation.id"],
      attributes["conversation_id"],
      attributes["conversation.id"],
      attributes["gen_ai.conversation.id"],
      attributes["session.id"],
      traceId
    );
    const query = firstText(
      attributes["cursor.generation.id"],
      attributes["generation_id"],
      attributes["gen_ai.turn.id"],
      attributes["turn.id"],
      traceId
    );
    if (!query) {
      return undefined;
    }
    return {
      query,
      session: session ?? query,
      request: firstText(attributes["request.id"], spanId, traceId, eventSequence && `${query}|${eventSequence}`) ?? query
    };
  }
  const query = firstText(attributes["gen_ai.turn.id"], attributes["turn.id"], attributes["request.id"], traceId);
  if (!query) {
    return undefined;
  }
  return {
    query,
    session: firstText(
      attributes["copilot_chat.session_id"],
      attributes["gen_ai.conversation.id"],
      attributes["session.id"],
      attributes["copilot_chat.chat_session_id"],
      query
    )!,
    request: firstText(attributes["request.id"], spanId, traceId, eventSequence && `${query}|${eventSequence}`) ?? query
  };
}

function mergeCodexTraceIdentity(
  traceIdentity: ProviderTelemetryIdentity | undefined,
  promptIdentity: ProviderTelemetryIdentity | undefined
): ProviderTelemetryIdentity | undefined {
  if (!traceIdentity) {
    return promptIdentity;
  }
  if (!promptIdentity) {
    return traceIdentity;
  }
  return {
    query: promptIdentity.query,
    session: promptIdentity.session,
    request: traceIdentity.request
  };
}

function completionModeFor(
  provider: SafeObservationV1["provider"],
  signal: TelemetrySignal,
  name: string
): SafeUsageAtomV1["completionMode"] {
  if (provider === "claude-code" && (signal === "logs" || !normalizedName(name).includes("interaction"))) {
    return "inactivity";
  }
  return "explicit";
}

function providerReportedNanoUsd(
  provider: SafeObservationV1["provider"],
  name: string,
  attributes: Record<string, unknown>
): number | undefined {
  if (provider === "cursor") {
    const cents = firstNonnegativeNumber(attributes, [
      "cursor.cost.total_cents",
      "cursor.dashboard.usage.total_cents",
      "total_cents",
      "totalCents"
    ]);
    return cents == null ? undefined : Math.round(cents * 10_000_000);
  }
  if (provider !== "claude-code" || !normalizedName(name).includes("api_request")) {
    return undefined;
  }
  const usd = firstNonnegativeNumber(attributes, ["cost_usd", "claude_code.cost_usd", "gen_ai.usage.cost_usd"]);
  return usd == null ? undefined : Math.round(usd * 1_000_000_000);
}

function firstNonnegativeNumber(attributes: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(attributes[key]);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function firstNumber(attributes: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(attributes[key]);
    if (Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function hasUsage(usage: ReturnType<typeof tokenUsage>): boolean {
  return Object.values(usage).some((value) => value != null);
}

function usageAuthority(provider: SafeObservationV1["provider"], name: string): SafeUsageAuthority {
  const normalized = normalizedName(name);
  if (provider === "github-copilot" && normalized.startsWith("invoke_agent")) {
    return "run";
  }
  if (provider === "claude-code" && (normalized.includes("prompt") || normalized.includes("request"))) {
    return "request";
  }
  if (provider === "codex" && normalized.includes("turn")) {
    return "turn";
  }
  if (provider === "cursor" && (
    normalized.includes("turn")
    || normalized.includes("agentresponse")
    || normalized.includes("after_agent_response")
    || normalized.includes("stop")
  )) {
    return "turn";
  }
  if (normalized.includes("chat") || normalized.includes("model")) {
    return "model";
  }
  return "event";
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_");
}

function billingContextFrom(
  provider: SafeObservationV1["provider"],
  attributes: Record<string, unknown>,
  model?: string
): BillingContextV1 {
  if (provider === "github-copilot") {
    return "github-copilot";
  }
  if (provider === "codex") {
    const authMode = firstText(
      attributes["auth_mode"],
      attributes["codex.auth_mode"],
      attributes["gen_ai.auth_mode"]
    )?.toLowerCase().replaceAll("-", "_");
    if (authMode === "api" || authMode === "api_key" || authMode === "apikey") {
      return "openai-direct";
    }
    if (authMode === "swic" || authMode === "chatgpt" || authMode === "chatgpt_plan") {
      return "subscription";
    }
  }
  if (provider === "cursor") {
    const context = firstText(
      attributes["cursor.billing_context"],
      attributes["billing_context"],
      attributes["accounting"]
    )?.toLowerCase().replaceAll("-", "_");
    if (context === "subscription" || context === "cursor_subscription") {
      return "subscription";
    }
    if (
      context === "cursor"
      || context === "cursor_auto_composer"
      || context === "auto_composer"
      || context === "composer"
    ) {
      return "cursor";
    }
    return cursorBillingContextForModel(model);
  }
  return "unknown";
}

function cursorBillingContextForModel(model?: string): BillingContextV1 {
  return model && isCursorPricedModel(model) ? "cursor" : "unknown";
}

function isCursorPricedModel(model: string): boolean {
  const normalized = model.trim().toLowerCase().replaceAll("_", "-");
  return /^(?:cursor[- ./:])?(?:auto|composer[- ](?:1|1\.5|2|2[- ]fast|2\.5|2\.5[- ]fast))$/.test(normalized);
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "" && value.length <= 500) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function safeModel(value?: string): string | undefined {
  return value && /^[A-Za-z0-9_.:/-]{1,100}$/.test(value) ? value : undefined;
}

function timestampToIso(value: string | undefined, fallback: string | undefined): string {
  if (!value) {
    return fallback ?? new Date(0).toISOString();
  }
  try {
    const milliseconds = BigInt(value) / 1_000_000n;
    const date = new Date(Number(milliseconds));
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback ?? new Date(0).toISOString();
  } catch {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback ?? new Date(0).toISOString();
  }
}

function optionalTimestampToIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = timestampToIso(value, "");
  return parsed || undefined;
}

function opaqueHash(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex")}`;
}

function safeAtom(input: {
  classification: ReturnType<DefaultTelemetryClassification["classify"]>;
  identity: { query: string; session: string; request: string };
  signal: TelemetrySignal;
  authority: SafeUsageAuthority;
  completionMode: SafeUsageAtomV1["completionMode"];
  billingContext?: BillingContextV1;
  model?: string;
  reportedModelProvider?: string;
  usage?: ReturnType<typeof tokenUsage>;
  startedAt: string;
  endedAt?: string;
}): SafeUsageAtomV1 {
  const queryId = opaqueHash("qry", `${input.classification.provider}|${input.identity.query}`);
  const usage = input.usage ?? {};
  const modelProvider = resolveModelProvider({
    model: input.model,
    reportedProvider: input.reportedModelProvider
  });
  return {
    schemaVersion: 1,
    atomId: opaqueHash("atom", [
      input.classification.provider,
      input.identity.query,
      input.identity.request,
      "usage",
      input.authority,
      input.startedAt
    ].join("|")),
    correlationId: queryId,
    queryId,
    sessionId: opaqueHash("ses", `${input.classification.provider}|${input.identity.session}`),
    requestId: opaqueHash("req", `${input.classification.provider}|${input.identity.request}`),
    signal: input.signal,
    sourceId: input.classification.sourceId,
    profileVersion: input.classification.profileVersion,
    provider: input.classification.provider,
    runtime: input.classification.runtime,
    authority: input.authority,
    completionMode: input.completionMode,
    billingContext: input.billingContext ?? "unknown",
    model: input.model,
    ...modelProvider,
    ...usage,
    startedAt: input.startedAt,
    endedAt: input.endedAt
  };
}

function isProviderPromptEvent(provider: SafeObservationV1["provider"], name: string): boolean {
  if (provider === "github-copilot") return name === "user_message";
  if (provider === "claude-code") return name === "claude_code.user_prompt" || name === "user_prompt";
  if (provider === "cursor") return name === "cursor.user_prompt" || name === "beforesubmitprompt" || name === "before_submit_prompt";
  return name === "codex.user_prompt";
}

function isProviderRootRunStart(provider: SafeObservationV1["provider"], signal: TelemetrySignal, name: string): boolean {
  return provider === "github-copilot" && signal === "traces" && name.startsWith("invoke_agent");
}

function queryOccurrenceEvidence(
  provider: SafeObservationV1["provider"],
  signal: TelemetrySignal,
  name: string
): QueryOccurrenceV1["evidence"] {
  if (isProviderRootRunStart(provider, signal, name)) {
    return "provider_root_span";
  }
  if (provider === "github-copilot") {
    return "provider_user_message_event";
  }
  if (provider === "claude-code") {
    return "provider_prompt_id";
  }
  if (provider === "cursor") {
    return "provider_user_prompt_event";
  }
  return "provider_user_prompt_event";
}

function firstPromptText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function safePromptText(value?: string): string | undefined {
  if (!value || value === "<REDACTED>") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 60_000) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneInsertionOrderedSet(values: Set<string>, maxSize: number): void {
  while (values.size > maxSize) {
    const oldest = values.values().next().value;
    if (oldest == null) {
      return;
    }
    values.delete(oldest);
  }
}
