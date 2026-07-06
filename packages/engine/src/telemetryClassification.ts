import { createHash, randomUUID } from "node:crypto";
import type {
  BillingContextV1,
  ExecutionNodeAtomV1,
  ExecutionNodeContentV1,
  QueryOccurrenceV1,
  SafeActivityAtomV1,
  SensitiveAuditEvidenceV1,
  SafeObservationV1,
  SafeUsageAtomV1,
  SafeUsageAuthority,
  SourceCapabilityV1,
  TelemetrySignal,
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

type ProviderHookSource = Extract<SafeObservationV1["provider"], "claude-code" | "codex" | "cursor">;
type ActiveProviderQuery = {
  query: string;
  startedAt: string;
};
type ActiveCodexQuery = ActiveProviderQuery & {
  session: string;
  queryBasis: "explicit" | "fallback";
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
  private readonly cursorTurnsByGeneration = new Map<string, ActiveCursorTurn>();
  private readonly cursorOpenGenerationBySession = new Map<string, string>();

  constructor(
    private readonly capturePrompts: (provider: SafeObservationV1["provider"]) => boolean = () => false,
    private readonly captureSensitiveAuditEvidence: () => boolean = () => false
  ) {}

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
      const records = usageRecords(resource, signal);
      const owningTools = owningToolActivityIds(classification.provider, records, resourceAttributes);
      return records.flatMap((record) => {
        const attributes = recordAttributes(resourceAttributes, record);
        const usage = tokenUsage(attributes);
        const name = firstText(record.name, attributes["event.name"]) ?? "";
        const reportedNanoUsd = providerReportedNanoUsd(classification.provider, name, attributes);
        if (!hasUsage(usage) && reportedNanoUsd == null) {
          return [];
        }
        const providerScopedIdentity = providerIdentity(classification.provider, record, attributes, name);
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
          owningActivityId: owningTools.get(firstText(record.spanId) ?? ""),
          signal,
          sourceId: classification.sourceId,
          profileVersion: classification.profileVersion,
          provider: classification.provider,
          runtime: classification.runtime,
          authority,
          completionMode: completionModeFor(classification.provider, signal, name),
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
        const descriptor = activityDescriptor(classification.provider, name, attributes);
        if (!descriptor) {
          return [];
        }
        const identity = providerIdentity(classification.provider, record, attributes, name)
          ?? this.codexActivityIdentity(classification.provider, attributes);
        if (!identity) {
          return [];
        }
        const startedAt = timestampToIso(
          firstText(attributes["event.timestamp"], record.startTimeUnixNano, record.timeUnixNano),
          observedAt
        );
        const endedAt = optionalTimestampToIso(firstText(record.endTimeUnixNano, record.timeUnixNano));
        const traceId = firstText(record.traceId) ?? identity.query;
        const spanId = firstText(record.spanId, attributes["tool_use_id"], attributes["call_id"], attributes["tool.call.id"])
          ?? `${descriptor.name}|${startedAt}`;
        const durationMs = nonnegativeInteger(firstText(attributes["duration_ms"]))
          ?? durationBetween(startedAt, endedAt);
        const resultSizeBytes = nonnegativeInteger(firstText(
          attributes["output_length"],
          attributes["result_size_bytes"],
          attributes["result_bytes"]
        ));
        const providerReportedResultTokens = nonnegativeInteger(firstText(
          attributes["tool_token_count"],
          attributes["result_tokens"]
        ));
        return [{
          schemaVersion: 1,
          activityId: activityIdFor(classification.provider, traceId, spanId),
          queryId: opaqueHash("qry", `${classification.provider}|${identity.query}`),
          sessionId: opaqueHash("ses", `${classification.provider}|${identity.session}`),
          provider: classification.provider,
          runtime: classification.runtime,
          kind: descriptor.kind,
          name: descriptor.name,
          outcome: activityOutcome(record, attributes),
          durationMs,
          resultSizeBytes,
          providerReportedResultTokens,
          ...(this.captureSensitiveAuditEvidence()
            ? { sensitiveAuditEvidence: sensitiveAuditEvidence(attributes, startedAt, descriptor) }
            : {}),
          startedAt,
          endedAt: endedAt && endedAt >= startedAt ? endedAt : undefined
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
        const identity = providerIdentity(classification.provider, record, attributes, name)
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

        const descriptor = activityDescriptor(classification.provider, name, attributes);
        const usage = tokenUsage(attributes);
        const spanId = firstText(record.spanId);
        const traceId = firstText(record.traceId) ?? identity.request;
        if (!descriptor && !spanId && !hasUsage(usage)) {
          return [];
        }
        const nodeId = executionNodeId(classification.provider, queryId, traceId, spanId, startedAt, normalized || "event");
        const parentSpanId = firstText(record.parentSpanId);
        const parentNodeId = parentSpanId
          ? executionNodeId(classification.provider, queryId, traceId, parentSpanId)
          : promptNodeId(queryId);
        const model = safeModel(firstText(
          attributes["gen_ai.request.model"],
          attributes["gen_ai.response.model"],
          attributes["model"],
          attributes["llm.model_name"]
        ));
        const endedAt = optionalTimestampToIso(firstText(record.endTimeUnixNano, record.timeUnixNano));
        return [{
          schemaVersion: 1,
          nodeId,
          queryId,
          sessionId,
          requestId,
          provider: classification.provider,
          runtime: classification.runtime,
          signal,
          nodeKind: descriptor ? executionNodeKindForActivity(descriptor.kind) : "llm_request",
          name: descriptor?.name ?? executionNodeDisplayName(classification.provider, name, model),
          parentNodeId: nodeId === promptNodeId(queryId) ? undefined : parentNodeId,
          outcome: descriptor ? activityOutcome(record, attributes) : endedAt ? "success" : "unknown",
          startedAt,
          endedAt: endedAt && endedAt >= startedAt ? endedAt : undefined,
          durationMs: nonnegativeInteger(firstText(attributes["duration_ms"])) ?? durationBetween(startedAt, endedAt),
          model,
          toolName: descriptor?.name,
          ...usage
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
        if (!isProviderPromptEvent(classification.provider, name) && !isProviderRootRunStart(classification.provider, signal, name)) {
          return [];
        }
        const identity = providerIdentity(classification.provider, record, attributes, name);
        if (!identity) {
          return [];
        }
        const startedAt = timestampToIso(
          firstText(attributes["event.timestamp"], record.startTimeUnixNano, record.timeUnixNano),
          observedAt
        );
        if (classification.provider === "codex") {
          this.rememberCodexQuery(identity.session, {
            query: identity.query,
            startedAt,
            queryBasis: codexExplicitTurnId(attributes) ? "explicit" : "fallback"
          });
        } else if (classification.provider === "claude-code") {
          this.rememberClaudeQuery(identity.session, { query: identity.query, startedAt });
        }
        return [{
          schemaVersion: 1,
          queryId: opaqueHash("qry", `${classification.provider}|${identity.query}`),
          sessionId: opaqueHash("ses", `${classification.provider}|${identity.session}`),
          provider: classification.provider,
          runtime: classification.runtime,
          startedAt,
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
            this.rememberCodexQuery(identity.session, {
              query: identity.query,
              startedAt: eventAt,
              queryBasis: codexExplicitTurnId(attributes) ? "explicit" : "fallback"
            });
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
        return [safeAtom({
          classification,
          identity: { query: current.query, session: current.session, request: current.query },
          signal: "logs",
          authority: "turn",
          completionMode: "explicit",
          billingContext: billingContextFrom("codex", attributes),
          model: safeModel(firstText(attributes["model"], attributes["slug"], attributes["gen_ai.request.model"])),
          reportedModelProvider: firstText(
            attributes["gen_ai.provider.name"],
            attributes["provider_name"],
            attributes["provider.name"],
            attributes["llm.provider"]
          ),
          usage,
          startedAt: current.startedAt,
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

  private rememberCodexSessionAlias(session: string | undefined, active: ActiveCodexQuery): void {
    if (!session || session === active.session) {
      return;
    }
    this.codexQueriesBySession.delete(session);
    this.codexQueriesBySession.set(session, active);
    this.pruneCodexQueries();
  }

  private forgetCodexQuery(query: string): void {
    this.codexQueriesByQuery.delete(query);
    for (const [session, candidate] of [...this.codexQueriesBySession.entries()]) {
      if (candidate.query === query) {
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

  private rememberClaudeQuery(session: string, query: { query: string; startedAt: string }): void {
    rememberSessionQuery(this.claudeQueriesBySession, session, query);
  }

  private codexActivityIdentity(
    provider: SafeObservationV1["provider"],
    attributes: Record<string, unknown>
  ): { query: string; session: string; request: string } | undefined {
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
      const query = firstText(raw.prompt_id, raw.turn_id) ?? `${session}|${observedAt}`;
      this.rememberClaudeQuery(session, { query, startedAt: observedAt });
      return promptHookObservation({
        provider: "claude-code",
        sourceId: "hook_claude_code_lifecycle",
        profileVersion: "claude-code-hooks-v1",
        observedAt,
        query,
        session,
        evidence: "submission_hook"
      });
    }
    if (eventName === "stop") {
      return undefined;
    }
    if (eventName === "subagentstop") {
      return this.sanitizeClaudeSubagentStopHookObservation(raw, observedAt);
    }
    if (eventName !== "posttooluse" && eventName !== "posttoolusefailure") {
      return undefined;
    }
    const session = firstText(raw.session_id);
    const current = session ? this.claudeQueriesBySession.get(session) : undefined;
    if (!session || !current) {
      return undefined;
    }
    const toolName = safeActivityName(firstText(raw.tool_name)) ?? "unknown";
    const descriptor = activityDescriptor("claude-code", "claude_code.tool_result", { tool_name: toolName }) ?? {
      kind: "tool" as const,
      name: toolName
    };
    const durationMs = nonnegativeInteger(firstText(raw.duration_ms));
    const startedAt = subtractDurationMs(observedAt, durationMs) ?? observedAt;
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
        outcome: eventName === "posttoolusefailure"
          ? raw.is_interrupt === true ? "rejected" : "failure"
          : hookOutcomeFromResponse(raw.tool_response),
        durationMs
      },
      node: {
        nodeKind: executionNodeKindForActivity(descriptor.kind),
        name: descriptor.name,
        toolName: descriptor.name,
        outcome: eventName === "posttoolusefailure"
          ? raw.is_interrupt === true ? "rejected" : "failure"
          : hookOutcomeFromResponse(raw.tool_response),
        startedAt,
        endedAt: observedAt,
        durationMs
      }
    });
  }

  private sanitizeClaudeSubagentStopHookObservation(
    raw: Record<string, unknown>,
    observedAt: string
  ): SafeObservationV1 | undefined {
    const session = firstText(raw.session_id);
    const current = session ? this.claudeQueriesBySession.get(session) : undefined;
    if (!session || !current) {
      return undefined;
    }
    const name = safeActivityName(firstText(raw.subagent_type, raw.agent_name, raw.name)) ?? "subagent";
    const durationMs = nonnegativeInteger(firstText(raw.duration_ms));
    const startedAt = subtractDurationMs(observedAt, durationMs) ?? observedAt;
    return hookObservation({
      provider: "claude-code",
      sourceId: "hook_claude_code_lifecycle",
      profileVersion: "claude-code-hooks-v1",
      observedAt,
      query: current.query,
      session,
      request: firstText(raw.subagent_id) ?? `subagent|${name}|${startedAt}`,
      activity: {
        kind: "subagent",
        name,
        outcome: raw.error ? "failure" : "success",
        durationMs
      },
      node: {
        nodeKind: "subagent",
        name,
        outcome: raw.error ? "failure" : "success",
        startedAt,
        endedAt: observedAt,
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
      const session = firstText(raw.session_id) ?? query;
      if (!query || !session) {
        return undefined;
      }
      this.rememberCodexQuery(session, { query, startedAt: observedAt, queryBasis: "explicit" });
      return promptHookObservation({
        provider: "codex",
        sourceId: "hook_codex_lifecycle",
        profileVersion: "codex-hooks-v1",
        observedAt,
        query,
        session,
        evidence: "submission_hook"
      });
    }
    if (eventName !== "posttooluse") {
      return undefined;
    }
    const query = firstText(raw.turn_id);
    const session = firstText(raw.session_id) ?? query;
    if (!query || !session) {
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
    const outcome = hookOutcomeFromResponse(raw.tool_response);
    return hookObservation({
      provider: "codex",
      sourceId: "hook_codex_tools",
      profileVersion: "codex-hooks-v1",
      observedAt,
      query,
      session,
      request: toolUseId ?? `${toolName}|${startedAt}`,
      activity: {
        kind: descriptor.kind,
        name: descriptor.name,
        outcome,
        durationMs
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
        usage: observedUsage ?? {}
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
  store.delete(session);
  store.set(session, query);
  while (store.size > MAX_ACTIVE_PROVIDER_QUERIES) {
    const oldest = store.keys().next().value;
    if (oldest == null) {
      break;
    }
    store.delete(oldest);
  }
}

function owningToolActivityIds(
  provider: SafeObservationV1["provider"],
  records: Record<string, unknown>[],
  resourceAttributes: Record<string, unknown>
): Map<string, string> {
  const bySpanId = new Map(records.flatMap((record) => {
    const spanId = firstText(record.spanId);
    return spanId ? [[spanId, record] as const] : [];
  }));
  const toolSpanIds = new Set(records.flatMap((record) => {
    const spanId = firstText(record.spanId);
    const attributes = { ...resourceAttributes, ...otlpAttributes(record.attributes) };
    const name = firstText(record.name, attributes["event.name"]) ?? "";
    return spanId && activityDescriptor(provider, name, attributes) ? [spanId] : [];
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
      if (toolSpanIds.has(currentSpanId)) {
        result.set(spanId, activityIdFor(provider, firstText(current.traceId) ?? "", currentSpanId));
        break;
      }
      const parentSpanId = firstText(current.parentSpanId);
      current = parentSpanId ? bySpanId.get(parentSpanId) : undefined;
    }
  }
  return result;
}

function activityDescriptor(
  provider: SafeObservationV1["provider"],
  rawName: string,
  attributes: Record<string, unknown>
): { kind: SafeActivityAtomV1["kind"]; name: string } | undefined {
  const name = normalizedName(rawName);
  const isTool = provider === "github-copilot"
    ? name.startsWith("execute_tool") || name === "copilot_chat.tool.call"
    : provider === "claude-code"
      ? name.includes("tool_result") || name.includes("tool_use")
      : provider === "codex"
        ? name === "codex.tool_result" || name.includes("dispatch_tool_call")
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
  const toolParameters = parseJsonRecord(firstText(attributes["tool_parameters"]));
  const skillName = safeActivityName(firstText(attributes["skill.name"], attributes["skill_name"], toolParameters?.skill_name));
  const mcpName = safeActivityName(firstText(attributes["mcp_server"], attributes["mcp_server.name"], toolParameters?.mcp_server_name));
  const subagentName = safeActivityName(firstText(attributes["subagent_type"], toolParameters?.subagent_type));
  const normalizedTool = normalizedName(toolName);
  const kind: SafeActivityAtomV1["kind"] = mcpName
    ? "mcp"
    : skillName
      ? "skill"
      : subagentName || normalizedTool.includes("agent") || normalizedTool.includes("subagent")
        ? "subagent"
        : "tool";
  return { kind, name: skillName ?? mcpName ?? subagentName ?? toolName };
}

function safeActivityName(value?: string): string | undefined {
  const text = value?.trim();
  return text && /^[A-Za-z0-9_.:/ -]{1,100}$/.test(text) ? text : undefined;
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
  const success = firstText(attributes.success)?.toLowerCase();
  if (success === "true") return "success";
  if (success === "false") return "failure";
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

function activityIdFor(provider: SafeObservationV1["provider"], traceId: string, spanId: string): string {
  return opaqueHash("act", `${provider}|${traceId}|${spanId}`);
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
  query: string;
  session: string;
  evidence: QueryOccurrenceV1["evidence"];
}): SafeObservationV1 {
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
      provider: input.provider,
      runtime: input.provider,
      startedAt: input.observedAt,
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
      startedAt: input.observedAt
    }],
    usageAtoms: []
  };
}

function hookObservation(input: {
  provider: ProviderHookSource;
  sourceId: string;
  profileVersion: string;
  observedAt: string;
  query: string;
  session: string;
  request: string;
  activity: {
    kind: SafeActivityAtomV1["kind"];
    name: string;
    outcome: SafeActivityAtomV1["outcome"];
    durationMs?: number;
    sensitiveAuditEvidence?: SensitiveAuditEvidenceV1[];
  };
  node: {
    nodeKind: ExecutionNodeAtomV1["nodeKind"];
    name: string;
    toolName?: string;
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
  const activityId = activityIdFor(input.provider, input.query, requestId);
  return {
    schemaVersion: 1,
    observationId: opaqueHash("obs", [
      input.sourceId,
      input.query,
      input.request,
      input.node.startedAt,
      JSON.stringify(input.node.contents ?? [])
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
      provider: input.provider,
      runtime: input.provider,
      kind: input.activity.kind,
      name: input.activity.name,
      outcome: input.activity.outcome,
      durationMs: input.activity.durationMs,
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
      provider: "cursor",
      runtime: "cursor",
      kind: input.activity.kind,
      name: input.activity.name,
      outcome: input.activity.outcome,
      durationMs: input.activity.durationMs,
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
      evidenceBasis: "subagent_hook"
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
): { query: string; session: string; request: string } | undefined {
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
  traceIdentity: { query: string; session: string; request: string } | undefined,
  promptIdentity: { query: string; session: string; request: string } | undefined
): { query: string; session: string; request: string } | undefined {
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
