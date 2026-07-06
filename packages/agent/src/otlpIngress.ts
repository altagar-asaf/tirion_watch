import { createHash } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SafeObservationV1, TelemetrySignal } from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import type { DiagnosticEvent } from "@tirion/engine/production";
import {
  DefaultAgentPrivacyGuard,
  DefaultTelemetryClassification,
  safeObservationFrom,
  sourceCapabilityForObservation,
  sourceCapabilityForProviderHookObservation
} from "@tirion/engine";

export const OTLP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const OTLP_MAX_REQUESTS_PER_SECOND = 200;

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
    private readonly maxRequestsPerSecond = OTLP_MAX_REQUESTS_PER_SECOND
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
      const observation = safeObservationFrom(metadata, classification, requestObservationId(request));
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
      const raw = await readBoundedJson(request);
      const observation = this.privacyGuard.sanitizeProviderHookObservation(raw, provider, this.now().toISOString());
      if (!observation) {
        this.recordLifecycle("provider_hook", "ignored", "provider_hook_event_ignored", {
          severity: "info",
          details: { provider }
        });
        return send(response, 200, {});
      }
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
