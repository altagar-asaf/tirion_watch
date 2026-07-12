import { createHash } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute } from "node:path";
import type { SafeObservationV1, TelemetrySignal } from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { DefaultTelemetryNormalizer, type CanonicalOtelRecord, type DiagnosticEvent } from "@tirion/engine/production";
import {
  DefaultAgentPrivacyGuard,
  DefaultTelemetryClassification,
  safeObservationFrom,
  sourceCapabilityForObservation,
  sourceCapabilityForProviderHookObservation
} from "@tirion/engine";

export const OTLP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const OTLP_MAX_REQUESTS_PER_SECOND = 200;

export type WorkspaceEvidenceResolution = {
  repositoryKey: string;
  artifactKeys: string[];
};

export class OtlpIngress {
  private server?: Server;
  private requestTimes: number[] = [];
  private readonly promptCapture = new Map<SafeObservationV1["provider"], boolean>();
  private readonly privacyGuard = new DefaultAgentPrivacyGuard(
    (provider) => this.promptCapture.get(provider) ?? false,
    () => false
  );

  constructor(
    private readonly storage: AgentStorageClient,
    private readonly environmentId: string,
    private readonly port: number,
    private readonly now: () => Date,
    private readonly onAccepted?: (observation: SafeObservationV1) => Promise<void>,
    private readonly onDiagnosticEvent?: (event: DiagnosticEvent) => void,
    private readonly authToken?: string,
    private readonly maxRequestsPerSecond = OTLP_MAX_REQUESTS_PER_SECOND,
    private readonly resolveWorkspaceEvidence?: (
      workspacePath: string,
      artifactPaths: string[]
    ) => Promise<WorkspaceEvidenceResolution | undefined>
  ) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.route(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    this.recordLifecycle("server", "started", "otlp_ingress_started", {
      severity: "info",
      details: {
        host: "127.0.0.1",
        port: this.address().port
      }
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.recordLifecycle("server", "stopped", "otlp_ingress_stopped", {
        severity: "info"
      });
    }
  }

  address(): { host: "127.0.0.1"; port: number } {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) {
      throw new Error("agent_unavailable");
    }
    return { host: "127.0.0.1", port: address.port };
  }

  setPromptCapture(provider: SafeObservationV1["provider"], enabled: boolean): void {
    this.promptCapture.set(provider, enabled);
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    const hookProvider = providerHookFor(request.method, request.url);
    const signal = signalFor(request.method, request.url);
    if (!this.allowRequest()) {
      this.recordLifecycle("request", "rate_limited", "otlp_rate_limit_exceeded", {
        severity: "warning",
        details: {
          method: request.method ?? "unknown",
          path: request.url ?? "unknown",
          signal: signal ?? hookProvider ?? "unsupported"
        }
      });
      return send(response, 429, { error: "rate_limited" });
    }
    if (hookProvider) {
      return await this.handleProviderHook(request, response, hookProvider);
    }
    if (!signal) {
      this.recordLifecycle("request", "rejected", "unsupported_otlp_path", {
        severity: "warning",
        details: {
          method: request.method ?? "unknown",
          path: request.url ?? "unknown"
        }
      });
      return send(response, 404, { error: "unsupported_source" });
    }
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      this.recordLifecycle("request", "rejected", "unsupported_content_type", {
        severity: "warning",
        details: {
          signal,
          contentType: String(request.headers["content-type"] ?? "absent")
        }
      });
      return send(response, 415, { error: "unsupported_content_type" });
    }
    try {
      const raw = await readBoundedJson(request);
      const metadata = this.privacyGuard.sanitizeOtlpEnvelope(raw, signal, this.now().toISOString());
      const classification = new DefaultTelemetryClassification().classify(metadata);
      if (
        classification.provider !== "github-copilot"
        && this.authToken
        && bearerCredential(request) !== this.authToken
      ) {
        this.recordLifecycle("request", "rejected", "authentication_required", {
          severity: "warning",
          details: {
            signal,
            provider: classification.provider,
            runtime: classification.runtime
          }
        });
        return send(response, 401, { error: "authentication_required" });
      }
      metadata.queryOccurrences = this.privacyGuard.sanitizeQueryOccurrences(raw, signal, classification, metadata.observedAt);
      metadata.activityAtoms = this.privacyGuard.sanitizeActivityAtoms(raw, signal, classification, metadata.observedAt);
      metadata.executionNodes = this.privacyGuard.sanitizeExecutionNodes(raw, signal, classification, metadata.observedAt);
      metadata.usageAtoms = this.privacyGuard.sanitizeUsageAtoms(raw, signal, classification, metadata.observedAt);
      const sanitized = safeObservationFrom(metadata, classification, requestObservationId(request));
      const workspaceHint = otlpWorkspaceEvidenceHint(raw);
      const workspaceEvidence = workspaceHint.workspacePath && this.resolveWorkspaceEvidence
        ? await this.resolveWorkspaceEvidence(workspaceHint.workspacePath, workspaceHint.artifactPaths)
        : undefined;
      const observation = workspaceEvidence
        ? observationWithRepositoryEvidence(sanitized, workspaceEvidence, "provider_tool_event")
        : sanitized;
      const capability = sourceCapabilityForObservation(observation, this.environmentId);
      await this.storage.upsertSource(capability, this.now().toISOString());
      const appended = await this.storage.appendSafeObservation(observation);
      this.recordLifecycle("receipt", appended ? "accepted" : "deduplicated", appended ? "otlp_observation_accepted" : "otlp_observation_deduplicated", {
        severity: "info",
        details: {
          signal,
          provider: observation.provider,
          runtime: observation.runtime,
          sourceId: observation.sourceId,
          resourceCount: observation.resourceCount,
          recordCount: observation.recordCount,
          queryOccurrenceCount: observation.queryOccurrences?.length ?? 0,
          activityAtomCount: observation.activityAtoms?.length ?? 0,
          executionNodeCount: observation.executionNodes?.length ?? 0,
          usageAtomCount: observation.usageAtoms.length
        }
      });
      if (appended) {
        this.dispatchAccepted(observation);
      }
      return send(response, 200, { partialSuccess: {} });
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      const status = code === "payload_too_large" ? 413 : code === "unsupported_source" ? 422 : 400;
      this.recordLifecycle("request", "rejected", code, {
        severity: code === "invalid_request" ? "warning" : "error",
        details: {
          signal
        }
      });
      return send(response, status, { error: code === "unsupported_source" ? code : "invalid_request" });
    }
  }

  private async handleProviderHook(
    request: IncomingMessage,
    response: ServerResponse,
    provider: "claude-code" | "codex" | "cursor"
  ): Promise<void> {
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      this.recordLifecycle("provider_hook", "rejected", "unsupported_content_type", {
        severity: "warning",
        details: {
          provider,
          contentType: String(request.headers["content-type"] ?? "absent")
        }
      });
      return send(response, 415, { error: "unsupported_content_type" });
    }
    if (this.authToken && bearerCredential(request) !== this.authToken) {
      this.recordLifecycle("provider_hook", "rejected", "authentication_required", {
        severity: "warning",
        details: { provider }
      });
      return send(response, 401, { error: "authentication_required" });
    }
    try {
      const raw = normalizeProviderHookPayload(await readBoundedJson(request));
      const sanitized = this.privacyGuard.sanitizeProviderHookObservation(raw, provider, this.now().toISOString());
      if (!sanitized) {
        this.recordLifecycle("provider_hook", "ignored", "provider_hook_event_ignored", {
          severity: "info",
          details: {
            provider,
            ...providerHookShapeDetails(raw)
          }
        });
        return send(response, 200, {});
      }
      const workspacePath = providerHookWorkspacePath(raw);
      const artifactPaths = providerHookWritePaths(raw);
      const workspaceEvidence = workspacePath && this.resolveWorkspaceEvidence
        ? await this.resolveWorkspaceEvidence(workspacePath, artifactPaths)
        : undefined;
      const observation = workspaceEvidence
        ? observationWithRepositoryEvidence(sanitized, workspaceEvidence, "provider_write_hook")
        : sanitized;
      const capability = sourceCapabilityForProviderHookObservation(observation, this.environmentId);
      await this.storage.upsertSource(capability, this.now().toISOString());
      const appended = await this.storage.appendSafeObservation(observation);
      this.recordLifecycle("provider_hook", appended ? "accepted" : "deduplicated", appended ? "provider_hook_observation_accepted" : "provider_hook_observation_deduplicated", {
        severity: "info",
        details: {
          provider,
          sourceId: observation.sourceId,
          queryOccurrenceCount: observation.queryOccurrences?.length ?? 0,
          activityAtomCount: observation.activityAtoms?.length ?? 0,
          executionNodeCount: observation.executionNodes?.length ?? 0
        }
      });
      if (appended) {
        this.dispatchAccepted(observation);
      }
      return send(response, 200, {});
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      const status = code === "payload_too_large" ? 413 : 400;
      this.recordLifecycle("provider_hook", "rejected", code, {
        severity: code === "invalid_request" ? "warning" : "error",
        details: { provider }
      });
      return send(response, status, { error: "invalid_request" });
    }
  }

  private dispatchAccepted(observation: SafeObservationV1): void {
    void this.onAccepted?.(observation).catch(() => undefined);
  }

  private allowRequest(): boolean {
    const now = this.now().getTime();
    this.requestTimes = this.requestTimes.filter((at) => at > now - 1_000 && at <= now);
    if (this.requestTimes.length >= this.maxRequestsPerSecond) {
      return false;
    }
    this.requestTimes.push(now);
    return true;
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

function providerHookWorkspacePath(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const candidate = [raw.cwd, raw.workspace_path, raw.workspacePath]
    .find((value): value is string => typeof value === "string" && value.trim() !== "")
    ?.trim();
  return candidate && candidate.length <= 4_096 && isAbsolute(candidate) && !candidate.includes("\0")
    ? candidate
    : undefined;
}

const PROVIDER_HOOK_FIELD_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["hook_event_name", ["hook_event_name", "hookEventName", "event_name", "eventName"]],
  ["session_id", ["session_id", "sessionId"]],
  ["turn_id", ["turn_id", "turnId"]],
  ["prompt_id", ["prompt_id", "promptId"]],
  ["conversation_id", ["conversation_id", "conversationId"]],
  ["generation_id", ["generation_id", "generationId"]],
  ["transcript_path", ["transcript_path", "transcriptPath"]],
  ["cwd", [
    "cwd",
    "working_directory",
    "workingDirectory",
    "workspace_path",
    "workspacePath",
    "workspace_root",
    "workspaceRoot",
    "project_dir",
    "projectDir",
    "repository_path",
    "repositoryPath",
    "repo_root",
    "repoRoot"
  ]],
  ["tool_name", ["tool_name", "toolName"]],
  ["tool_use_id", ["tool_use_id", "toolUseId"]],
  ["tool_input", ["tool_input", "toolInput"]],
  ["tool_response", ["tool_response", "toolResponse"]],
  ["duration_ms", ["duration_ms", "durationMs"]],
  ["agent_id", ["agent_id", "agentId"]],
  ["agent_type", ["agent_type", "agentType"]],
  ["subagent_id", ["subagent_id", "subagentId"]],
  ["subagent_type", ["subagent_type", "subagentType"]],
  ["is_interrupt", ["is_interrupt", "isInterrupt"]],
  ["file_path", ["file_path", "filePath"]],
  ["edit_id", ["edit_id", "editId"]]
];

function normalizeProviderHookPayload(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }
  const normalized: Record<string, unknown> = { ...raw };
  for (const [canonicalField, aliases] of PROVIDER_HOOK_FIELD_ALIASES) {
    const value = firstProviderHookValue(raw, aliases);
    if (value != null) {
      normalized[canonicalField] = value;
    }
  }
  return normalized;
}

function firstProviderHookValue(
  raw: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value != null && (!(typeof value === "string") || value.trim() !== "")) {
      return value;
    }
  }
  return undefined;
}

function providerHookShapeDetails(raw: unknown): Record<string, string | boolean> {
  const record = isRecord(raw) ? raw : undefined;
  return {
    hookEvent: safeProviderHookEventName(record?.hook_event_name),
    hasSessionId: hasProviderHookText(record?.session_id),
    hasTurnId: hasProviderHookText(record?.turn_id),
    hasTranscriptPath: hasProviderHookText(record?.transcript_path),
    hasWorkspacePath: providerHookWorkspacePath(record) != null
  };
}

function safeProviderHookEventName(value: unknown): string {
  const knownEvents: Record<string, string> = {
    userpromptsubmit: "user_prompt_submit",
    stop: "stop",
    posttooluse: "post_tool_use",
    posttoolusefailure: "post_tool_use_failure",
    subagentstart: "subagent_start",
    subagentstop: "subagent_stop",
    beforesubmitprompt: "before_submit_prompt",
    afteragentresponse: "after_agent_response",
    afterfileedit: "after_file_edit",
    sessionstart: "session_start",
    sessionend: "session_end"
  };
  return knownEvents[normalizedIdentifier(value)] ?? "unknown";
}

function hasProviderHookText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

export function observationWithRepositoryEvidence(
  observation: SafeObservationV1,
  evidence: WorkspaceEvidenceResolution,
  artifactEvidence: "provider_write_hook" | "provider_tool_event"
): SafeObservationV1 {
  const repositoryKey = evidence.repositoryKey;
  const internalQueryIds = new Set((observation.queryOccurrences ?? [])
    .filter((occurrence) => occurrence.lifecycleVisibility === "internal")
    .map((occurrence) => occurrence.queryId));
  const hasCustomerRecord = Boolean(observation.queryOccurrences?.some((occurrence) =>
    occurrence.lifecycleVisibility !== "internal"))
    || observation.usageAtoms.some((atom) => !internalQueryIds.has(atom.queryId ?? atom.correlationId))
    || Boolean(observation.activityAtoms?.some((atom) => !internalQueryIds.has(atom.queryId)))
    || Boolean(observation.executionNodes?.some((node) => !internalQueryIds.has(node.queryId)));
  if (!hasCustomerRecord) {
    return observation;
  }
  const eligibleNodeIds = observation.executionNodes
    ?.filter((node) => node.nodeKind === "tool" && node.outcome === "success")
    .map((node) => node.nodeId) ?? [];
  const causalNodeId = eligibleNodeIds.length === 1 && evidence.artifactKeys.length > 0
    ? eligibleNodeIds[0]
    : undefined;
  return {
    ...observation,
    repositoryKey,
    queryOccurrences: observation.queryOccurrences?.map((occurrence) =>
      occurrence.lifecycleVisibility === "internal" ? occurrence : { ...occurrence, repositoryKey }),
    usageAtoms: observation.usageAtoms.map((atom) =>
      internalQueryIds.has(atom.queryId ?? atom.correlationId) ? atom : { ...atom, repositoryKey }),
    activityAtoms: observation.activityAtoms?.map((atom) =>
      internalQueryIds.has(atom.queryId) ? atom : { ...atom, repositoryKey }),
    executionNodes: observation.executionNodes?.map((node) => ({
      ...node,
      ...(!internalQueryIds.has(node.queryId) ? { repositoryKey } : {}),
      ...(node.nodeId === causalNodeId && !internalQueryIds.has(node.queryId) ? {
        artifactKeys: evidence.artifactKeys,
        artifactEvidence
      } : {})
    }))
  };
}

function providerHookWritePaths(raw: unknown): string[] {
  if (!isRecord(raw)) {
    return [];
  }
  const eventName = normalizedIdentifier(raw.hook_event_name);
  if (eventName.includes("failure") || eventName.startsWith("before") || eventName.startsWith("pre")) {
    return [];
  }
  if (eventName === "afterfileedit") {
    return structuredPathCandidates(raw);
  }
  if (eventName !== "posttooluse" || hookResponseFailed(raw.tool_response)) {
    return [];
  }
  if (!isWorkspaceMutationTool(raw.tool_name)) {
    return [];
  }
  const structured = structuredPathCandidates(raw.tool_input);
  return normalizedIdentifier(raw.tool_name) === "applypatch"
    ? uniqueStrings([...structured, ...applyPatchPathCandidates(raw.tool_input)]).slice(0, 64)
    : structured;
}

export function otlpWorkspaceEvidenceHint(raw: unknown): { workspacePath?: string; artifactPaths: string[] } {
  const records = new DefaultTelemetryNormalizer().normalizeMany(raw);
  const workspacePaths = uniqueStrings(records.flatMap((record) => workspacePathsForRecord(record)));
  const mutations = records.filter(isSuccessfulWorkspaceMutationRecord);
  return {
    ...(workspacePaths.length === 1 ? { workspacePath: workspacePaths[0] } : {}),
    artifactPaths: mutations.length === 1 ? structuredPathCandidates(mutations[0].attributes) : []
  };
}

function workspacePathsForRecord(record: CanonicalOtelRecord): string[] {
  return uniqueStrings([
    ...workspacePathValues(record.attributes),
    ...workspacePathValues(record.resourceAttributes)
  ]).filter(validAbsolutePath);
}

function workspacePathValues(attributes: Record<string, unknown>): string[] {
  return [
    attributes.cwd,
    attributes["process.cwd"],
    attributes.working_directory,
    attributes.workspace_path,
    attributes["workspace.path"],
    attributes.repository_path,
    attributes["repository.path"]
  ].filter((value): value is string => typeof value === "string");
}

function isSuccessfulWorkspaceMutationRecord(record: CanonicalOtelRecord): boolean {
  if (record.kind === "metric") {
    return false;
  }
  const eventName = normalizedIdentifier(record.attributes["event.name"] ?? record.name);
  if (eventName.includes("failure") || eventName.startsWith("pre") || eventName.startsWith("before")) {
    return false;
  }
  if (record.kind === "span" && normalizedIdentifier(record.status).includes("error")) {
    return false;
  }
  if (hookResponseFailed(record.attributes)) {
    return false;
  }
  const toolName = record.attributes.tool_name
    ?? record.attributes["tool.name"]
    ?? record.attributes["gen_ai.tool.name"]
    ?? record.attributes.name;
  return eventName === "afterfileedit" || isWorkspaceMutationTool(toolName);
}

const WORKSPACE_MUTATION_TOOLS = new Set([
  "applypatch",
  "createfile",
  "deletefile",
  "edit",
  "fileedit",
  "insertedit",
  "movefile",
  "multiedit",
  "notebookedit",
  "renamefile",
  "replaceinfile",
  "strreplace",
  "write",
  "writefile"
]);

function isWorkspaceMutationTool(value: unknown): boolean {
  return WORKSPACE_MUTATION_TOOLS.has(normalizedIdentifier(value));
}

function hookResponseFailed(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.success === false || value.interrupted === true) {
    return true;
  }
  const status = normalizedIdentifier(value.status);
  return status.includes("fail") || status.includes("error") || status.includes("reject");
}

const ARTIFACT_PATH_KEYS = new Set([
  "destinationpath",
  "filepath",
  "newpath",
  "notebookpath",
  "path",
  "targetfile",
  "targetpath"
]);

function structuredPathCandidates(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    if (value.length > 65_536) {
      return [];
    }
    try {
      return structuredPathCandidates(JSON.parse(value), depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return uniqueStrings(value.slice(0, 64).flatMap((item) => structuredPathCandidates(item, depth + 1)));
  }
  if (!isRecord(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const [key, candidate] of Object.entries(value).slice(0, 128)) {
    if (ARTIFACT_PATH_KEYS.has(normalizedIdentifier(key)) && typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed && trimmed.length <= 4_096 && !trimmed.includes("\0")) {
        paths.push(trimmed);
      }
      continue;
    }
    if (normalizedIdentifier(key) === "patch" && typeof candidate === "string") {
      paths.push(...applyPatchPathCandidates(candidate));
      continue;
    }
    if (typeof candidate === "object" && candidate !== null) {
      paths.push(...structuredPathCandidates(candidate, depth + 1));
    } else if (typeof candidate === "string" && looksLikeStructuredJson(candidate)) {
      paths.push(...structuredPathCandidates(candidate, depth + 1));
    }
  }
  return uniqueStrings(paths).slice(0, 64);
}

function applyPatchPathCandidates(value: unknown): string[] {
  const patch = typeof value === "string"
    ? value
    : isRecord(value) && typeof value.patch === "string"
      ? value.patch
      : isRecord(value) && typeof value.command === "string"
        ? value.command
        : undefined;
  if (!patch || patch.length > 1_048_576) {
    return [];
  }
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/, 20_000)) {
    const tirionPatchHeader = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
      ?? /^\*\*\* Move to: (.+)$/.exec(line);
    const unifiedDiffHeader = /^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/.exec(line);
    const candidate = (tirionPatchHeader?.[1] ?? unifiedDiffHeader?.[1])?.trim();
    if (
      candidate
      && candidate !== "/dev/null"
      && candidate.length <= 4_096
      && !candidate.includes("\0")
    ) {
      paths.push(candidate);
    }
  }
  return uniqueStrings(paths).slice(0, 64);
}

function looksLikeStructuredJson(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function normalizedIdentifier(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function validAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 4_096 && isAbsolute(trimmed) && !trimmed.includes("\0");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearerCredential(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function signalFor(method?: string, path?: string): TelemetrySignal | undefined {
  if (method !== "POST") {
    return undefined;
  }
  if (path === "/v1/traces") {
    return "traces";
  }
  if (path === "/v1/logs") {
    return "logs";
  }
  if (path === "/v1/metrics") {
    return "metrics";
  }
  return undefined;
}

function providerHookFor(method?: string, path?: string): "claude-code" | "codex" | "cursor" | undefined {
  if (method !== "POST") {
    return undefined;
  }
  if (path === "/v1/provider-hooks/claude-code") {
    return "claude-code";
  }
  if (path === "/v1/provider-hooks/codex") {
    return "codex";
  }
  if (path === "/v1/provider-hooks/cursor") {
    return "cursor";
  }
  return undefined;
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > OTLP_BODY_LIMIT_BYTES) {
      throw new Error("payload_too_large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_request");
  }
}

function requestObservationId(request: IncomingMessage): string | undefined {
  const value = request.headers["x-tirion-observation-id"];
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(value)
    ? `obs_${createHash("sha256").update(value).digest("hex")}`
    : undefined;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}
