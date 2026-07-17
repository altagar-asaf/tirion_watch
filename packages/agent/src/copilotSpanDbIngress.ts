import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type {
  CopilotSpanDbConfigurationV1,
  SafeObservationV1,
  SourceCapabilityV1
} from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import type { DiagnosticEvent } from "@tirion/engine/production";
import {
  DefaultAgentPrivacyGuard,
  DefaultTelemetryClassification
} from "@tirion/engine";
import {
  observationWithRepositoryEvidence,
  otlpWorkspaceEvidenceHint,
  type WorkspaceEvidenceResolution
} from "./otlpIngress";

type SqliteRow = Record<string, unknown>;

type SqliteDatabase = {
  prepare(sql: string): {
    all(...params: unknown[]): SqliteRow[];
    get(...params: unknown[]): SqliteRow | undefined;
  };
  exec(sql: string): void;
  close(): void;
};

type DatabaseSyncConstructor = new (location: string, options?: Record<string, unknown>) => SqliteDatabase;

type CopilotSpanDbRecord = {
  span: SqliteRow;
  attributes: Array<{ key: string; value: unknown }>;
  events: SqliteRow[];
  revision: string;
};

const POLL_INTERVAL_MS = 1_000;
const REVISIT_WINDOW_MS = 5 * 60 * 1_000;

export class CopilotSpanDbIngress {
  private timer?: NodeJS.Timeout;
  private polling = false;
  // A span-DB poll is a local telemetry producer just like the OTLP server.
  // Track the entire poll and its detached runtime admission so a pre-stop
  // barrier cannot mistake a durable append for a completed pipeline handoff.
  private readonly inFlightPolls = new Set<Promise<void>>();
  private readonly inFlightAcceptedDispatches = new Set<Promise<void>>();
  private readonly acceptedWorkWaiters = new Set<() => void>();
  private acceptedObservationGeneration = 0;
  private ingressSealed = false;
  private spanDbPath?: string;
  private db?: SqliteDatabase;
  private lastStartTimeMs = 0;
  private readonly seenSpanRevisions = new Map<string, string>();
  private initializedFromSource = false;
  private promptCapture = false;
  private readonly privacyGuard = new DefaultAgentPrivacyGuard(
    () => this.promptCapture,
    () => false
  );
  private currentConfig?: CopilotSpanDbConfigurationV1;

  constructor(
    private readonly storage: AgentStorageClient,
    private readonly environmentId: string,
    private readonly now: () => Date,
    private readonly onAccepted?: (observation: SafeObservationV1) => Promise<void>,
    private readonly onDiagnosticEvent?: (event: DiagnosticEvent) => void,
    private readonly resolveWorkspaceEvidence?: (
      workspacePath: string,
      artifactPaths: string[]
    ) => Promise<WorkspaceEvidenceResolution | undefined>
  ) {}

  setPromptCapture(enabled: boolean): void {
    this.promptCapture = enabled;
  }

  async configure(config?: CopilotSpanDbConfigurationV1): Promise<void> {
    const next = config?.enabled && config.spanDbPath ? config : undefined;
    if (this.currentConfig?.spanDbPath === next?.spanDbPath && this.currentConfig?.enabled === next?.enabled) {
      this.currentConfig = next;
      return;
    }
    this.currentConfig = next;
    await this.stop();
    if (!next?.spanDbPath) {
      return;
    }
    this.spanDbPath = next.spanDbPath;
    this.lastStartTimeMs = 0;
    this.initializedFromSource = false;
    this.seenSpanRevisions.clear();
    this.startPolling();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.polling = false;
    this.spanDbPath = undefined;
    this.lastStartTimeMs = 0;
    this.initializedFromSource = false;
    this.seenSpanRevisions.clear();
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
    this.notifyAcceptedWorkWaiters();
  }

  /**
   * Seal new scheduled span-DB polling while every already-started poll and
   * its detached downstream runtime admission reaches a settled state.
   */
  async sealForQuiesce(timeoutMs: number): Promise<boolean> {
    this.ingressSealed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return await this.drainAcceptedWork(timeoutMs);
  }

  /** Reopen only after a failed pre-stop barrier; successful barriers stay sealed. */
  unsealAfterFailedQuiesce(): void {
    this.ingressSealed = false;
    this.startPolling();
  }

  ingressSealStatus(): { sealed: boolean } {
    return { sealed: this.ingressSealed };
  }

  /** In-memory only; used to prove a sealed drain reached a joint fixed point. */
  acceptedWorkGeneration(): number {
    return this.acceptedObservationGeneration;
  }

  /** Wait for currently accepted polling and detached admission work to settle. */
  async drainAcceptedWork(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return false;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await Promise.resolve();
      if (this.acceptedWorkIdle()) {
        return true;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      await this.waitForAcceptedWorkChange(remainingMs);
    }
  }

  private startPolling(): void {
    if (this.ingressSealed || !this.spanDbPath || this.timer) {
      return;
    }
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.poll();
  }

  private poll(): void {
    if (!this.spanDbPath || this.polling || this.ingressSealed) {
      return;
    }
    this.polling = true;
    const poll = this.pollOnce(this.spanDbPath);
    this.inFlightPolls.add(poll);
    void poll.finally(() => {
      this.inFlightPolls.delete(poll);
      this.polling = false;
      this.notifyAcceptedWorkWaiters();
    });
  }

  private async pollOnce(spanDbPath: string): Promise<void> {
    try {
      if (!fs.existsSync(spanDbPath)) {
        this.recordLifecycle("provider_replay", "waiting", "copilot_span_db_not_found", {
          severity: "warning",
          details: { configured: true }
        });
        return;
      }
      const db = this.openDb(spanDbPath);
      if (!this.initializedFromSource) {
        const latest = db.prepare("SELECT MAX(start_time_ms) AS max_start_time_ms FROM spans").get();
        this.lastStartTimeMs = numberValue(latest?.max_start_time_ms) ?? 0;
        this.initializedFromSource = true;
      }
      const lowerBoundStartTimeMs = Math.max(0, this.lastStartTimeMs - REVISIT_WINDOW_MS);
      const spans = db
        .prepare("SELECT * FROM spans WHERE start_time_ms >= ? ORDER BY start_time_ms, span_id")
        .all(lowerBoundStartTimeMs);
      const attributesForSpan = db.prepare("SELECT key, value FROM span_attributes WHERE span_id = ?");
      const eventsForSpan = db.prepare("SELECT * FROM span_events WHERE span_id = ? ORDER BY timestamp_ms, id");
      for (const span of spans) {
        // A poll may have selected a batch before the pre-stop seal arrived.
        // Only the record already in durable admission may finish; leave every
        // later record unremembered so a failed barrier can replay it.
        if (this.ingressSealed) {
          break;
        }
        const spanId = stringValue(span.span_id);
        if (!spanId) {
          continue;
        }
        const startTimeMs = numberValue(span.start_time_ms) ?? 0;
        const attributes = attributesForSpan.all(spanId).map((row) => ({
          key: stringValue(row.key) ?? "",
          value: row.value
        })).filter((row) => row.key !== "");
        const events = eventsForSpan.all(spanId);
        const revision = revisionForSpan(span, attributes, events);
        if (this.seenSpanRevisions.get(spanId) === revision) {
          continue;
        }
        const record: CopilotSpanDbRecord = {
          span,
          attributes,
          events,
          revision
        };
        await this.acceptRecord(record);
        this.rememberSpanRevision(spanId, revision);
        this.lastStartTimeMs = Math.max(this.lastStartTimeMs, startTimeMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordLifecycle("provider_replay", "failed", "copilot_span_db_read_failed", {
        severity: "error",
        details: {
          message: redactPathFromMessage(message, spanDbPath)
        }
      });
      this.closeDb();
    }
  }

  private dispatchAccepted(observation: SafeObservationV1): void {
    this.acceptedObservationGeneration += 1;
    const dispatch = Promise.resolve()
      .then(async () => {
        await this.onAccepted?.(observation);
      })
      .catch(() => undefined);
    this.inFlightAcceptedDispatches.add(dispatch);
    void dispatch.finally(() => {
      this.inFlightAcceptedDispatches.delete(dispatch);
      this.notifyAcceptedWorkWaiters();
    });
  }

  private acceptedWorkIdle(): boolean {
    return this.inFlightPolls.size === 0 && this.inFlightAcceptedDispatches.size === 0;
  }

  private async waitForAcceptedWorkChange(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const release = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.acceptedWorkWaiters.delete(release);
        resolve();
      };
      const timeout = setTimeout(release, timeoutMs);
      timeout.unref?.();
      this.acceptedWorkWaiters.add(release);
      if (this.acceptedWorkIdle()) {
        release();
      }
    });
  }

  private notifyAcceptedWorkWaiters(): void {
    for (const release of [...this.acceptedWorkWaiters]) {
      release();
    }
  }

  private async acceptRecord(record: CopilotSpanDbRecord): Promise<boolean> {
    let accepted = false;
    const traceEnvelope = toTraceEnvelope(record);
    accepted = await this.acceptEnvelope(traceEnvelope, "traces", record) || accepted;
    const logEnvelope = toLogEnvelope(record);
    if (logEnvelope) {
      accepted = await this.acceptEnvelope(logEnvelope, "logs", record) || accepted;
    }
    return accepted;
  }

  private async acceptEnvelope(
    raw: unknown,
    signal: "traces" | "logs",
    record: CopilotSpanDbRecord
  ): Promise<boolean> {
    const metadata = this.privacyGuard.sanitizeOtlpEnvelope(raw, signal, this.now().toISOString());
    const classification = new DefaultTelemetryClassification().classify(metadata);
    metadata.queryOccurrences = this.privacyGuard.sanitizeQueryOccurrences(raw, signal, classification, metadata.observedAt);
    metadata.activityAtoms = this.privacyGuard.sanitizeActivityAtoms(raw, signal, classification, metadata.observedAt);
    metadata.executionNodes = this.privacyGuard.sanitizeExecutionNodes(raw, signal, classification, metadata.observedAt);
    metadata.usageAtoms = this.privacyGuard.sanitizeUsageAtoms(raw, signal, classification, metadata.observedAt);
    if (
      metadata.queryOccurrences.length === 0
      && metadata.activityAtoms.length === 0
      && metadata.executionNodes.length === 0
      && metadata.usageAtoms.length === 0
    ) {
      return false;
    }
    const sourceId = signal === "traces" ? "span_db_github_copilot_traces" : "span_db_github_copilot_logs";
    const profileVersion = signal === "traces" ? "copilot-span-db-traces-v1" : "copilot-span-db-logs-v1";
    const sanitized: SafeObservationV1 = {
      schemaVersion: 1,
      observationId: opaqueHash("obs", `${sourceId}|${stringValue(record.span.span_id) ?? "unknown"}|${record.revision}`),
      sourceId,
      provider: classification.provider,
      runtime: classification.runtime,
      signal,
      profileVersion,
      resourceCount: metadata.resourceCount,
      recordCount: metadata.recordCount,
      observedAt: metadata.observedAt,
      queryOccurrences: metadata.queryOccurrences,
      activityAtoms: metadata.activityAtoms,
      executionNodes: metadata.executionNodes,
      usageAtoms: metadata.usageAtoms
    };
    const workspaceHint = otlpWorkspaceEvidenceHint(raw);
    const workspaceEvidence = workspaceHint.workspacePath && this.resolveWorkspaceEvidence
      ? await this.resolveWorkspaceEvidence(workspaceHint.workspacePath, workspaceHint.artifactPaths)
      : undefined;
    const observation = workspaceEvidence
      ? observationWithRepositoryEvidence(sanitized, workspaceEvidence, "provider_tool_event")
      : sanitized;
    await this.storage.upsertSource(sourceCapabilityForCopilotSpanDb(
      this.environmentId,
      signal,
      this.currentConfig?.captureContent === true
    ), metadata.observedAt);
    const appended = await this.storage.appendSafeObservation(observation);
    if (appended) {
      this.recordLifecycle("provider_replay", "accepted", "copilot_span_db_observation_accepted", {
        severity: "info",
        details: {
          signal,
          sourceId,
          recordCount: metadata.recordCount,
          queryOccurrenceCount: metadata.queryOccurrences.length,
          activityAtomCount: metadata.activityAtoms.length,
          executionNodeCount: metadata.executionNodes.length,
          usageAtomCount: metadata.usageAtoms.length
        }
      });
      this.dispatchAccepted(observation);
    }
    return appended;
  }

  private openDb(spanDbPath: string): SqliteDatabase {
    if (this.db) {
      return this.db;
    }
    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(spanDbPath, { readOnly: true, open: true });
    try {
      db.exec("PRAGMA query_only = ON");
      assertSpanDbSchema(db);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private closeDb(): void {
    if (!this.db) {
      return;
    }
    this.db.close();
    this.db = undefined;
  }

  private rememberSpanRevision(spanId: string, revision: string): void {
    this.seenSpanRevisions.set(spanId, revision);
    if (this.seenSpanRevisions.size <= 20_000) {
      return;
    }
    const oldest = this.seenSpanRevisions.keys().next().value;
    if (typeof oldest === "string") {
      this.seenSpanRevisions.delete(oldest);
    }
  }

  private recordLifecycle(
    operation: string,
    state: string,
    reason: string,
    options?: {
      severity?: "info" | "warning" | "error";
      details?: Record<string, string | number | boolean | null>;
    }
  ): void {
    this.onDiagnosticEvent?.({
      kind: "constructLifecycle",
      construct: "TelemetryIngress",
      operation,
      state,
      reason,
      ...(options?.severity ? { severity: options.severity } : {}),
      ...(options?.details ? { details: options.details } : {})
    });
  }
}

function sourceCapabilityForCopilotSpanDb(
  environmentId: string,
  signal: "traces" | "logs",
  captureContent: boolean
): SourceCapabilityV1 {
  return {
    schemaVersion: 1,
    sourceId: signal === "traces" ? "span_db_github_copilot_traces" : "span_db_github_copilot_logs",
    sourceKind: "sqlite-span-db",
    provider: "github-copilot",
    runtime: "github-copilot",
    environmentId,
    profileVersion: signal === "traces" ? "copilot-span-db-traces-v1" : "copilot-span-db-logs-v1",
    granularity: signal === "traces" ? ["run", "turn"] : ["prompt", "turn"],
    tokenDimensions: signal === "traces"
      ? ["input", "output", "cache_read_input", "reasoning_output", "total"]
      : ["input", "output", "cache_read_input", "total"],
    billingEvidence: ["copilot_context"],
    durability: "durable_checkpoint",
    contentRisk: captureContent ? "content_expected" : "metadata_only",
    compatibility: "supported",
    evidenceGrade: "estimated_usage_cost_unattributed"
  };
}

function toTraceEnvelope(record: CopilotSpanDbRecord): Record<string, unknown> {
  const span = record.span;
  const attributes = {
    ...spanColumnAttributes(span),
    ...spanDbAttributes(record.attributes)
  };
  const status = otlpStatus(span.status_code, span.status_message);
  return {
    resourceSpans: [{
      resource: {
        attributes: [otlpAttribute("service.name", "github-copilot")]
      },
      scopeSpans: [{
        spans: [{
          traceId: stringValue(span.trace_id),
          spanId: stringValue(span.span_id),
          parentSpanId: stringValue(span.parent_span_id),
          name: stringValue(span.name),
          startTimeUnixNano: msToUnixNano(span.start_time_ms),
          endTimeUnixNano: msToUnixNano(span.end_time_ms),
          ...(status ? { status } : {}),
          attributes: Object.entries(attributes).map(([key, value]) => otlpAttribute(key, value))
        }]
      }]
    }]
  };
}

function toLogEnvelope(record: CopilotSpanDbRecord): Record<string, unknown> | undefined {
  const traceId = stringValue(record.span.trace_id);
  const spanId = stringValue(record.span.span_id);
  const logRecords = record.events.flatMap((event) => {
    const name = stringValue(event.name);
    if (!name) {
      return [];
    }
    const attributes = {
      "event.name": name,
      ...parseJsonObject(event.attributes)
    };
    return [{
      traceId,
      spanId,
      timeUnixNano: msToUnixNano(event.timestamp_ms),
      attributes: Object.entries(attributes).map(([key, value]) => otlpAttribute(key, value))
    }];
  });
  if (logRecords.length === 0) {
    return undefined;
  }
  return {
    resourceLogs: [{
      resource: {
        attributes: [otlpAttribute("service.name", "github-copilot")]
      },
      scopeLogs: [{
        logRecords
      }]
    }]
  };
}

function otlpAttribute(key: string, value: unknown): Record<string, unknown> {
  return {
    key,
    value: otlpValue(value)
  };
}

function otlpValue(value: unknown): Record<string, unknown> {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { intValue: String(value) };
  }
  if (typeof value === "number") {
    return { doubleValue: value };
  }
  if (value == null) {
    return { stringValue: "" };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  return { stringValue: JSON.stringify(value) };
}

function revisionForSpan(
  span: SqliteRow,
  attributes: Array<{ key: string; value: unknown }>,
  events: SqliteRow[]
): string {
  return createHash("sha256").update(JSON.stringify({
    endTimeMs: span.end_time_ms ?? null,
    statusCode: span.status_code ?? null,
    statusMessage: span.status_message ?? null,
    attributes: attributes.map((attribute) => [attribute.key, stableValue(attribute.value)]),
    events: events.map((event) => [event.id ?? null, event.name ?? null, event.timestamp_ms ?? null, stableValue(event.attributes)])
  })).digest("hex");
}

function stableValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? null);
}

function loadDatabaseSync(): DatabaseSyncConstructor {
  const sqlite = require("node:sqlite") as { DatabaseSync?: DatabaseSyncConstructor };
  if (!sqlite.DatabaseSync) {
    throw new Error("node:sqlite DatabaseSync is unavailable.");
  }
  return sqlite.DatabaseSync;
}

function assertSpanDbSchema(db: SqliteDatabase): void {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => stringValue(row.name))
      .filter((value): value is string => typeof value === "string")
  );
  for (const table of ["spans", "span_attributes", "span_events"]) {
    if (!tables.has(table)) {
      throw new Error(`Missing Copilot span DB table: ${table}`);
    }
  }
}

function spanColumnAttributes(span: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  addAttribute(attributes, "gen_ai.operation.name", span.operation_name);
  addAttribute(attributes, "gen_ai.provider.name", span.provider_name);
  addAttribute(attributes, "gen_ai.agent.name", span.agent_name);
  addAttribute(attributes, "gen_ai.conversation.id", span.conversation_id);
  addAttribute(attributes, "copilot_chat.session_id", span.conversation_id);
  addAttribute(attributes, "gen_ai.request.model", span.request_model);
  addAttribute(attributes, "gen_ai.response.model", span.response_model);
  addAttribute(attributes, "gen_ai.usage.input_tokens", span.input_tokens);
  addAttribute(attributes, "gen_ai.usage.output_tokens", span.output_tokens);
  addAttribute(attributes, "gen_ai.usage.cache_read.input_tokens", span.cached_tokens);
  addAttribute(attributes, "gen_ai.usage.reasoning.output_tokens", span.reasoning_tokens);
  addAttribute(attributes, "gen_ai.tool.name", span.tool_name);
  addAttribute(attributes, "gen_ai.tool.call.id", span.tool_call_id);
  addAttribute(attributes, "gen_ai.tool.type", span.tool_type);
  addAttribute(attributes, "copilot_chat.chat_session_id", span.chat_session_id);
  addAttribute(attributes, "turn.index", span.turn_index);
  addAttribute(attributes, "copilot_chat.time_to_first_token", span.ttft_ms);
  return attributes;
}

function spanDbAttributes(value: unknown): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const row of Array.isArray(value) ? value : []) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      continue;
    }
    const key = stringValue((row as Record<string, unknown>).key);
    if (!key) {
      continue;
    }
    attributes[key] = parseSpanDbValue((row as Record<string, unknown>).value);
  }
  return attributes;
}

function addAttribute(attributes: Record<string, unknown>, key: string, value: unknown): void {
  if (value == null || value === "") {
    return;
  }
  attributes[key] = parseSpanDbValue(value);
}

function parseSpanDbValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return numeric;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return value;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseSpanDbValue(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function msToUnixNano(value: unknown): string | undefined {
  const milliseconds = numberValue(value);
  return milliseconds == null ? undefined : `${milliseconds * 1_000_000}`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}

function otlpStatus(code: unknown, message: unknown): { code: number; message?: string } | undefined {
  const messageText = stringValue(message);
  const numericCode = numberValue(code);
  const normalizedCode = numericCode != null
    ? numericCode
    : (() => {
        const text = stringValue(code)?.trim().toLowerCase();
        if (!text) return undefined;
        if (text === "ok" || text.includes("success")) return 1;
        if (text.includes("error") || text.includes("fail")) return 2;
        return 0;
      })();
  if (normalizedCode == null && !messageText) {
    return undefined;
  }
  return {
    code: normalizedCode ?? 0,
    ...(messageText ? { message: messageText } : {})
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function redactPathFromMessage(message: string, path?: string): string {
  return path ? message.replaceAll(path, "[redacted-path]") : message;
}

function opaqueHash(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex")}`;
}
