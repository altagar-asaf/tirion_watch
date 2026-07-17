import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SafeObservationV1, TelemetrySignal } from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { DefaultTelemetryNormalizer, type CanonicalOtelRecord, type DiagnosticEvent } from "@tirion/engine/production";
import {
  DefaultAgentPrivacyGuard,
  DefaultTelemetryClassification,
  isClaudeNamespacedMcpToolName,
  isClaudeSubmissionProvenanceDiagnosticReason,
  type ClaudeTranscriptTailInput,
  safeObservationFrom,
  sourceCapabilityForObservation,
  sourceCapabilityForProviderHookObservation
} from "@tirion/engine";

export const OTLP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const OTLP_MAX_REQUESTS_PER_SECOND = 200;
export const CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES = 256 * 1024;
export const CLAUDE_TRANSCRIPT_RETRY_DELAYS_MS = [25, 75, 150, 300, 600] as const;
export const CLAUDE_CLOSE_CONTINUATION_SETTLE_MS = 25;
const TIRION_CLAUDE_SUBMISSION_ATTEMPT_FIELD = "tirion_claude_submission_attempt_id";

export type WorkspaceEvidenceResolution = {
  repositoryKey: string;
  artifactKeys: string[];
};

type PendingClaudeHook = {
  raw: Record<string, unknown>;
  observedAt: string;
  needsResolvedPromptId: boolean;
};

type MinimalPendingClaudeHook = Omit<PendingClaudeHook, "observedAt">;

type PendingClaudeSubmissionState = {
  count: number;
  hooks: PendingClaudeHook[];
  allResolved: boolean;
  ambiguous: boolean;
};

export class OtlpIngress {
  private server?: Server;
  private requestTimes: number[] = [];
  private readonly claudeTranscriptRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly inFlightClaudeRetries = new Set<Promise<void>>();
  private readonly pendingClaudeSubmissions = new Map<string, PendingClaudeSubmissionState>();
  private readonly pendingClaudeSubmissionWaiters = new Set<() => void>();
  private inFlightRequests = 0;
  // OTLP acknowledges after a durable append. Downstream runtime admission is
  // detached from that acknowledgement, but pre-stop draining must wait for
  // it so a just-accepted observation cannot appear after its fixed point.
  private readonly inFlightAcceptedDispatches = new Set<Promise<void>>();
  private readonly acceptedWorkWaiters = new Set<() => void>();
  private acceptedObservationGeneration = 0;
  private ingressSealed = false;
  private postSealRequestCount = 0;
  private acceptingDeferredClaudeHooks = false;
  private claudeRetryGeneration = 0;
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
    ) => Promise<WorkspaceEvidenceResolution | undefined>,
    private readonly claudeTranscriptRoot = join(homedir(), ".claude", "projects"),
    private readonly claudeTranscriptRetryDelaysMs: readonly number[] = CLAUDE_TRANSCRIPT_RETRY_DELAYS_MS,
    private readonly claudeCloseContinuationSettleMs = CLAUDE_CLOSE_CONTINUATION_SETTLE_MS
  ) {}

  async start(): Promise<void> {
    this.claudeRetryGeneration += 1;
    this.acceptingDeferredClaudeHooks = true;
    this.ingressSealed = false;
    this.postSealRequestCount = 0;
    this.server = createServer((request, response) => {
      this.inFlightRequests += 1;
      void this.route(request, response).finally(() => this.finishRequest());
    });
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
    this.acceptingDeferredClaudeHooks = false;
    this.claudeRetryGeneration += 1;
    for (const timer of this.claudeTranscriptRetryTimers) {
      clearTimeout(timer);
    }
    this.claudeTranscriptRetryTimers.clear();
    this.pendingClaudeSubmissions.clear();
    this.releasePendingClaudeSubmissionWaiters();
    this.notifyAcceptedWorkWaiters();
    await Promise.allSettled([...this.inFlightClaudeRetries]);
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

  /**
   * Wait for every already-accepted request and deferred Claude transcript
   * retry to settle.  This does not close ingress or discard work: callers
   * must first seal their own upstream producer, and a timeout is an explicit
   * failure rather than evidence that pending provenance can be ignored.
   */
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

  /** Seal new OTLP/provider-hook ingress while already-accepted work drains. */
  async sealForQuiesce(timeoutMs: number): Promise<boolean> {
    this.ingressSealed = true;
    return await this.drainAcceptedWork(timeoutMs);
  }

  /** Reopen only after a failed pre-stop barrier; successful barriers stay sealed. */
  unsealAfterFailedQuiesce(): void {
    this.ingressSealed = false;
    this.postSealRequestCount = 0;
  }

  ingressSealStatus(): { sealed: boolean; postSealRequestCount: number } {
    return { sealed: this.ingressSealed, postSealRequestCount: this.postSealRequestCount };
  }

  /** In-memory only; used to prove a sealed drain reached a joint fixed point. */
  acceptedWorkGeneration(): number {
    return this.acceptedObservationGeneration;
  }

  setPromptCapture(provider: SafeObservationV1["provider"], enabled: boolean): void {
    this.promptCapture.set(provider, enabled);
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (this.ingressSealed) {
      this.postSealRequestCount += 1;
      this.recordLifecycle("request", "rejected", "otlp_ingress_sealed", {
        severity: "warning",
        details: {
          method: request.method ?? "unknown",
          path: request.url ?? "unknown"
        }
      });
      return send(response, 409, { error: "ingress_sealed" });
    }
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
      if (classification.provider === "claude-code") {
        if (hasClaudeClosedInteraction(raw, signal)) {
          await wait(Math.max(0, this.claudeCloseContinuationSettleMs));
        }
        await this.waitForPendingClaudeSubmissions();
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
      const normalized = normalizeProviderHookPayload(await readBoundedJson(request));
      const managedClaudeEventMismatch = provider === "claude-code"
        ? managedClaudeHookEventMismatch(request, normalized)
        : undefined;
      if (managedClaudeEventMismatch) {
        this.recordLifecycle("provider_hook", "rejected", "managed_hook_event_mismatch", {
          severity: "warning",
          details: {
            provider,
            ...managedClaudeEventMismatch
          }
        });
        return send(response, 400, { error: "invalid_request" });
      }
      const observedAt = this.now().toISOString();
      const submissionInput = provider === "claude-code" && isClaudeUserPromptSubmit(normalized) && isRecord(normalized)
        ? { ...normalized, [TIRION_CLAUDE_SUBMISSION_ATTEMPT_FIELD]: randomUUID() }
        : normalized;
      const raw = provider === "claude-code" && isClaudeUserPromptSubmit(submissionInput)
        ? this.privacyGuard.annotateClaudeProviderHook(
            submissionInput,
            await readClaudeTranscriptTail(submissionInput, this.claudeTranscriptRoot),
            observedAt
          )
        : submissionInput;
      if (
        provider === "claude-code"
        && isClaudeUserPromptSubmit(normalized)
        && unresolvedClaudeSubmissionProvenance(raw)
      ) {
        const deferred = minimalClaudeSubmissionRetryPayload(raw);
        if (deferred && this.claudeTranscriptRetryDelaysMs.length > 0) {
          this.recordLifecycle("provider_hook", "deferred", "claude_transcript_provenance_pending", {
            severity: "info",
            details: {
              provider,
              ...providerHookShapeDetails(raw),
              ...providerHookProvenanceDetails(raw)
            }
          });
          this.rememberPendingClaudeSubmission(deferred);
          this.scheduleClaudeSubmissionRetry(deferred, observedAt, 0);
          return send(response, 200, {});
        }
      }
      if (!await this.appendProviderHookObservation(raw, provider, observedAt)) {
        if (provider === "claude-code" && this.bufferPendingClaudeHook(normalized, observedAt)) {
          this.recordLifecycle("provider_hook", "deferred", "claude_provider_hook_waiting_for_submission", {
            severity: "info",
            details: {
              provider,
              ...providerHookShapeDetails(normalized)
            }
          });
        }
        return send(response, 200, {});
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

  private scheduleClaudeSubmissionRetry(
    raw: Record<string, unknown>,
    observedAt: string,
    attempt: number,
    generation = this.claudeRetryGeneration
  ): void {
    const delayMs = this.claudeTranscriptRetryDelaysMs[attempt];
    if (!this.acceptingDeferredClaudeHooks || delayMs == null) {
      return;
    }
    const timer = setTimeout(() => {
      this.claudeTranscriptRetryTimers.delete(timer);
      this.notifyAcceptedWorkWaiters();
      const retry = this.retryClaudeSubmission(raw, observedAt, attempt, generation)
        .catch(() => this.handleClaudeRetryFailure(raw, observedAt, attempt, generation));
      this.inFlightClaudeRetries.add(retry);
      void retry.finally(() => {
        this.inFlightClaudeRetries.delete(retry);
        this.notifyAcceptedWorkWaiters();
      });
    }, Math.max(0, delayMs));
    this.claudeTranscriptRetryTimers.add(timer);
  }

  private async retryClaudeSubmission(
    raw: Record<string, unknown>,
    observedAt: string,
    attempt: number,
    generation: number
  ): Promise<void> {
    if (!this.claudeRetryIsCurrent(generation)) {
      return;
    }
    const transcript = await readClaudeTranscriptTail(raw, this.claudeTranscriptRoot);
    if (!this.claudeRetryIsCurrent(generation)) {
      return;
    }
    const annotated = this.privacyGuard.annotateClaudeProviderHook(
      raw,
      transcript,
      observedAt
    );
    if (unresolvedClaudeSubmissionProvenance(annotated)) {
      if (attempt + 1 < this.claudeTranscriptRetryDelaysMs.length) {
        this.scheduleClaudeSubmissionRetry(raw, observedAt, attempt + 1, generation);
        return;
      }
      this.recordLifecycle("provider_hook", "ignored", "provider_hook_event_ignored", {
        severity: "info",
        details: {
          provider: "claude-code",
          ...providerHookShapeDetails(annotated),
          ...providerHookProvenanceDetails(annotated)
        }
      });
      await this.finishPendingClaudeSubmission(raw, false);
      return;
    }
    if (!this.claudeRetryIsCurrent(generation)) {
      return;
    }
    await this.appendProviderHookObservation(annotated, "claude-code", observedAt);
    if (!this.claudeRetryIsCurrent(generation)) {
      return;
    }
    await this.finishPendingClaudeSubmission(annotated, true);
  }

  private claudeRetryIsCurrent(generation: number): boolean {
    return this.acceptingDeferredClaudeHooks && generation === this.claudeRetryGeneration;
  }

  private async handleClaudeRetryFailure(
    raw: Record<string, unknown>,
    observedAt: string,
    attempt: number,
    generation: number
  ): Promise<void> {
    if (!this.claudeRetryIsCurrent(generation)) {
      return;
    }
    if (attempt + 1 < this.claudeTranscriptRetryDelaysMs.length) {
      this.scheduleClaudeSubmissionRetry(raw, observedAt, attempt + 1, generation);
      return;
    }
    this.recordLifecycle("provider_hook", "rejected", "claude_deferred_hook_processing_failed", {
      severity: "error",
      details: { provider: "claude-code" }
    });
    await this.finishPendingClaudeSubmission(raw, false);
  }

  private rememberPendingClaudeSubmission(raw: Record<string, unknown>): void {
    const session = typeof raw.session_id === "string" ? raw.session_id : undefined;
    if (!session) {
      return;
    }
    const current = this.pendingClaudeSubmissions.get(session) ?? {
      count: 0,
      hooks: [],
      allResolved: true,
      ambiguous: false
    };
    if (current.count > 0) {
      current.ambiguous = true;
    }
    current.count += 1;
    this.pendingClaudeSubmissions.set(session, current);
    while (this.pendingClaudeSubmissions.size > 64) {
      const oldest = this.pendingClaudeSubmissions.keys().next().value as string | undefined;
      if (oldest == null) {
        break;
      }
      this.pendingClaudeSubmissions.delete(oldest);
    }
    this.notifyAcceptedWorkWaiters();
  }

  private bufferPendingClaudeHook(raw: unknown, observedAt: string): boolean {
    if (!isRecord(raw) || isClaudeUserPromptSubmit(raw)) {
      return false;
    }
    const session = typeof raw.session_id === "string" ? raw.session_id : undefined;
    const pending = session ? this.pendingClaudeSubmissions.get(session) : undefined;
    const minimal = pending ? minimalPendingClaudeHookPayload(raw) : undefined;
    if (!pending || !minimal) {
      return false;
    }
    pending.hooks.push({ ...minimal, observedAt });
    if (pending.hooks.length > 256) {
      pending.hooks.splice(0, pending.hooks.length - 256);
    }
    return true;
  }

  private async finishPendingClaudeSubmission(raw: unknown, resolved: boolean): Promise<void> {
    const session = isRecord(raw) && typeof raw.session_id === "string" ? raw.session_id : undefined;
    const pending = session ? this.pendingClaudeSubmissions.get(session) : undefined;
    if (!session || !pending) {
      return;
    }
    pending.allResolved = pending.allResolved && resolved;
    pending.count = Math.max(0, pending.count - 1);
    if (pending.count > 0) {
      return;
    }
    this.pendingClaudeSubmissions.delete(session);
    try {
      if (pending.allResolved && !pending.ambiguous) {
        const resolvedPrompt = resolvedClaudeTranscriptPromptId(raw);
        for (const hook of pending.hooks) {
          if (!this.acceptingDeferredClaudeHooks) {
            break;
          }
          const replay = hook.needsResolvedPromptId && resolvedPrompt && typeof hook.raw.prompt_id !== "string"
            ? { ...hook.raw, prompt_id: resolvedPrompt }
            : hook.raw;
          try {
            await this.appendProviderHookObservation(replay, "claude-code", hook.observedAt, 2);
          } catch {
            this.recordLifecycle("provider_hook", "rejected", "claude_deferred_hook_processing_failed", {
              severity: "error",
              details: { provider: "claude-code" }
            });
          }
        }
      }
    } finally {
      if (this.pendingClaudeSubmissions.size === 0) {
        this.releasePendingClaudeSubmissionWaiters();
      }
      this.notifyAcceptedWorkWaiters();
    }
  }

  private finishRequest(): void {
    this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
    this.notifyAcceptedWorkWaiters();
  }

  private acceptedWorkIdle(): boolean {
    return this.inFlightRequests === 0
      && this.inFlightAcceptedDispatches.size === 0
      && this.claudeTranscriptRetryTimers.size === 0
      && this.inFlightClaudeRetries.size === 0
      && this.pendingClaudeSubmissions.size === 0;
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

  private async waitForPendingClaudeSubmissions(): Promise<void> {
    if (this.pendingClaudeSubmissions.size === 0) {
      return;
    }
    const maximumWaitMs = this.claudeTranscriptRetryDelaysMs.reduce(
      (total, delay) => total + Math.max(0, delay),
      0
    ) + 100;
    await new Promise<void>((resolve) => {
      let settled = false;
      const release = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.pendingClaudeSubmissionWaiters.delete(release);
        resolve();
      };
      const timeout = setTimeout(release, maximumWaitMs);
      this.pendingClaudeSubmissionWaiters.add(release);
      if (this.pendingClaudeSubmissions.size === 0) {
        release();
      }
    });
  }

  private releasePendingClaudeSubmissionWaiters(): void {
    for (const release of [...this.pendingClaudeSubmissionWaiters]) {
      release();
    }
  }

  private async appendProviderHookObservation(
    raw: unknown,
    provider: "claude-code" | "codex" | "cursor",
    observedAt: string,
    durableAppendAttempts = 1
  ): Promise<boolean> {
    const sanitized = this.privacyGuard.sanitizeProviderHookObservation(raw, provider, observedAt);
    if (!sanitized) {
      const unresolvedBackgroundRootCount = provider === "claude-code"
        ? claudePromptInputExitBackgroundRootCount(raw, this.privacyGuard)
        : 0;
      if (unresolvedBackgroundRootCount > 0) {
        this.recordLifecycle("provider_hook", "warning", "claude_background_root_missing_terminal", {
          severity: "warning",
          details: {
            provider: "claude-code",
            sessionEndReason: "prompt_input_exit",
            unresolvedBackgroundRootCount
          }
        });
      }
      if (
        provider === "claude-code"
        && providerHookProvenanceDetails(raw).claudeSubmissionProvenance === "task_notification_system"
      ) {
        this.privacyGuard.commitClaudeTranscriptProvenance(raw);
      } else if (provider === "claude-code") {
        this.privacyGuard.releaseClaudeTranscriptProvenance(raw);
      }
      this.recordLifecycle("provider_hook", "ignored", "provider_hook_event_ignored", {
        severity: "info",
        details: {
          provider,
          ...providerHookShapeDetails(raw),
          ...providerHookProvenanceDetails(raw)
        }
      });
      return false;
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
    let appended = false;
    try {
      await this.storage.upsertSource(capability, this.now().toISOString());
      for (let attempt = 0; attempt < Math.max(1, durableAppendAttempts); attempt += 1) {
        try {
          appended = await this.storage.appendSafeObservation(observation);
          break;
        } catch (error) {
          if (attempt + 1 >= Math.max(1, durableAppendAttempts)) {
            throw error;
          }
        }
      }
    } catch (error) {
      if (provider === "claude-code") {
        this.privacyGuard.releaseClaudeTranscriptProvenance(raw);
      }
      throw error;
    }
    if (provider === "claude-code") {
      this.privacyGuard.commitClaudeTranscriptProvenance(raw);
    }
    this.recordLifecycle("provider_hook", appended ? "accepted" : "deduplicated", appended ? "provider_hook_observation_accepted" : "provider_hook_observation_deduplicated", {
      severity: "info",
      details: {
        provider,
        sourceId: observation.sourceId,
        ...providerHookProvenanceDetails(raw),
        queryOccurrenceCount: observation.queryOccurrences?.length ?? 0,
        activityAtomCount: observation.activityAtoms?.length ?? 0,
        executionNodeCount: observation.executionNodes?.length ?? 0
      }
    });
    if (appended) {
      this.dispatchAccepted(observation);
    }
    return true;
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
  ["stop_hook_active", ["stop_hook_active", "stopHookActive"]],
  ["background_tasks", ["background_tasks", "backgroundTasks"]],
  ["session_crons", ["session_crons", "sessionCrons"]],
  ["error", ["error", "errorType"]],
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

function isClaudeUserPromptSubmit(raw: unknown): boolean {
  return isRecord(raw)
    && safeProviderHookEventName(raw.hook_event_name) === "user_prompt_submit";
}

function claudePromptInputExitBackgroundRootCount(
  raw: unknown,
  privacyGuard: DefaultAgentPrivacyGuard
): number {
  if (
    !isRecord(raw)
    || safeProviderHookEventName(raw.hook_event_name) !== "session_end"
    || safeClaudeSessionEndReason(raw.reason) !== "prompt_input_exit"
  ) {
    return 0;
  }
  const session = boundedProviderHookScalar(raw.session_id);
  return typeof session === "string"
    ? privacyGuard.countClaudeBackgroundRootsAwaitingTerminal(session)
    : 0;
}

function managedClaudeHookEventMismatch(
  request: IncomingMessage,
  raw: unknown
): { configuredHookEvent: string; payloadHookEvent: string } | undefined {
  const configuredHeader = request.headers["x-tirion-hook-event"];
  const configuredHookEvent = safeProviderHookEventName(
    typeof configuredHeader === "string" ? configuredHeader : undefined
  );
  const payloadHookEvent = safeProviderHookEventName(
    isRecord(raw) ? raw.hook_event_name : undefined
  );
  return configuredHookEvent !== "unknown"
    && payloadHookEvent !== "unknown"
    && configuredHookEvent !== payloadHookEvent
    ? { configuredHookEvent, payloadHookEvent }
    : undefined;
}

function unresolvedClaudeSubmissionProvenance(raw: unknown): boolean {
  const provenance = providerHookProvenanceDetails(raw).claudeSubmissionProvenance;
  return provenance === "unavailable" || provenance === "ambiguous";
}

function minimalClaudeSubmissionRetryPayload(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw) || !isClaudeUserPromptSubmit(raw)) {
    return undefined;
  }
  const retry: Record<string, unknown> = { hook_event_name: "UserPromptSubmit" };
  for (const key of [
    "session_id",
    "turn_id",
    "prompt_id",
    "transcript_path",
    "cwd",
    "tirion_claude_submission_prompt_digest",
    TIRION_CLAUDE_SUBMISSION_ATTEMPT_FIELD
  ] as const) {
    const value = raw[key];
    if (
      typeof value === "string"
      && value.length > 0
      && value.length <= 4_096
      && !value.includes("\0")
    ) {
      retry[key] = value;
    }
  }
  return typeof retry.session_id === "string" && typeof retry.transcript_path === "string"
    ? retry
    : undefined;
}

function minimalPendingClaudeHookPayload(raw: Record<string, unknown>): MinimalPendingClaudeHook | undefined {
  const event = safeProviderHookEventName(raw.hook_event_name);
  const hookEventName = boundedProviderHookScalar(raw.hook_event_name);
  const session = boundedProviderHookScalar(raw.session_id);
  if (typeof hookEventName !== "string" || typeof session !== "string") {
    return undefined;
  }
  if (
    (event === "post_tool_use" || event === "post_tool_use_failure")
    && normalizedIdentifier(raw.tool_name) !== "agent"
    // A bounded MCP identity is metadata-only and must survive the short
    // provenance race so its eventual outcome can join the resolved prompt.
    // Other non-Agent tool hooks remain interrupted-only while pending.
    && !isClaudeNamespacedMcpToolName(raw.tool_name)
  ) {
    return minimalPendingClaudeInterruptedToolHook(raw, event, hookEventName, session);
  }
  const minimal: Record<string, unknown> = {
    hook_event_name: hookEventName,
    session_id: session
  };
  for (const key of [
    "prompt_id",
    "tool_name",
    "tool_use_id",
    "agent_id",
    "subagent_id",
    "agent_type",
    "subagent_type",
    "duration_ms",
    "cwd"
  ] as const) {
    const value = boundedProviderHookScalar(raw[key]);
    if (value != null) {
      minimal[key] = value;
    }
  }
  if (raw.is_interrupt === true) {
    minimal.is_interrupt = true;
  }
  if (event === "stop") {
    minimal.stop_hook_active = raw.stop_hook_active === true;
    minimal.background_tasks = providerHookHasWorkItems(raw.background_tasks) ? [{}] : [];
    minimal.session_crons = providerHookHasWorkItems(raw.session_crons) ? [{}] : [];
    return { raw: minimal, needsResolvedPromptId: true };
  }
  if (event === "stop_failure") {
    minimal.error = safeClaudeStopFailureCategory(raw.error);
    return { raw: minimal, needsResolvedPromptId: true };
  }
  if (event === "subagent_start" || event === "subagent_stop") {
    if (typeof raw.error === "string" && raw.error.length > 0) {
      minimal.error = "child_failed";
    }
    return { raw: minimal, needsResolvedPromptId: true };
  }
  if (event !== "post_tool_use" && event !== "post_tool_use_failure") {
    return undefined;
  }
  if (normalizedIdentifier(raw.tool_name) === "agent") {
    const toolInput = isRecord(raw.tool_input) ? raw.tool_input : undefined;
    const toolResponse = isRecord(raw.tool_response) ? raw.tool_response : undefined;
    const subtype = boundedProviderHookScalar(toolInput?.subagent_type);
    const agentId = boundedProviderHookScalar(toolResponse?.agentId);
    if (typeof subtype === "string") {
      minimal.tool_input = { subagent_type: subtype };
    }
    if (typeof agentId === "string") {
      minimal.tool_response = { agentId };
    }
  }
  if (event === "post_tool_use_failure" && typeof raw.error === "string" && raw.error.length > 0) {
    minimal.error = "tool_failed";
  }
  return { raw: minimal, needsResolvedPromptId: true };
}

function minimalPendingClaudeInterruptedToolHook(
  raw: Record<string, unknown>,
  event: "post_tool_use" | "post_tool_use_failure",
  hookEventName: string,
  session: string
): MinimalPendingClaudeHook | undefined {
  const toolUseId = boundedProviderHookScalar(raw.tool_use_id);
  const toolResponse = isRecord(raw.tool_response) ? raw.tool_response : undefined;
  const interrupted = raw.is_interrupt === true
    || toolResponse?.interrupted === true
    || toolResponse?.is_interrupt === true
    || toolResponse?.isInterrupt === true;
  if (typeof toolUseId !== "string" || !interrupted) {
    return undefined;
  }
  return {
    raw: {
      hook_event_name: hookEventName,
      session_id: session,
      tool_name: safePendingClaudeToolName(raw.tool_name),
      tool_use_id: toolUseId,
      ...(event === "post_tool_use"
        ? { tool_response: { interrupted: true } }
        : { is_interrupt: true })
    },
    needsResolvedPromptId: false
  };
}

function safePendingClaudeToolName(value: unknown): string {
  const names: Readonly<Record<string, string>> = {
    bash: "Bash",
    read: "Read",
    write: "Write",
    edit: "Edit",
    glob: "Glob",
    grep: "Grep",
    skill: "Skill",
    webfetch: "WebFetch",
    websearch: "WebSearch"
  };
  return names[normalizedIdentifier(value)] ?? "unknown";
}

function providerHookHasWorkItems(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return typeof value === "string" && value.trim().length > 0;
}

function safeClaudeStopFailureCategory(value: unknown): string {
  const category = typeof value === "string" ? value : undefined;
  return category && CLAUDE_STOP_FAILURE_CATEGORIES.has(category) ? category : "unknown";
}

function safeClaudeSessionEndReason(value: unknown): string | undefined {
  return CLAUDE_SESSION_END_REASONS[normalizedIdentifier(value)];
}

const CLAUDE_STOP_FAILURE_CATEGORIES = new Set([
  "rate_limit",
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "invalid_request",
  "server_error",
  "max_output_tokens",
  "unknown"
]);

const CLAUDE_SESSION_END_REASONS: Readonly<Record<string, string>> = {
  clear: "clear",
  resume: "resume",
  logout: "logout",
  promptinputexit: "prompt_input_exit",
  bypasspermissionsdisabled: "bypass_permissions_disabled",
  other: "other"
};

function boundedProviderHookScalar(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && !value.includes("\0")
    ? value
    : undefined;
}

export async function readClaudeTranscriptTail(
  raw: unknown,
  transcriptRoot: string,
  hooks?: { afterOpen?: () => void | Promise<void> }
): Promise<ClaudeTranscriptTailInput> {
  if (!isRecord(raw)) {
    return unavailableClaudeTranscriptTail("transcript_locator_invalid");
  }
  const transcriptPath = boundedAbsolutePath(raw.transcript_path);
  const configuredRoot = boundedAbsolutePath(transcriptRoot);
  if (!transcriptPath || !configuredRoot) {
    return unavailableClaudeTranscriptTail("transcript_locator_invalid");
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const lexicalRoot = resolve(configuredRoot);
    const lexicalCandidate = resolve(transcriptPath);
    if (!pathIsWithin(lexicalRoot, lexicalCandidate)) {
      return unavailableClaudeTranscriptTail("transcript_trust_rejected");
    }

    const trustedRoot = await realpath(lexicalRoot);
    if (!(await stat(trustedRoot)).isDirectory()) {
      return unavailableClaudeTranscriptTail("transcript_read_unavailable");
    }
    const candidateBeforeOpen = await realpath(lexicalCandidate);
    if (!pathIsWithin(trustedRoot, candidateBeforeOpen)) {
      return unavailableClaudeTranscriptTail("transcript_trust_rejected");
    }
    if ((await lstat(lexicalCandidate)).isSymbolicLink()) {
      return unavailableClaudeTranscriptTail("transcript_trust_rejected");
    }

    handle = await open(lexicalCandidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) {
      return unavailableClaudeTranscriptTail("transcript_read_unavailable");
    }
    await hooks?.afterOpen?.();

    const candidateAfterOpen = await realpath(lexicalCandidate);
    if (!pathIsWithin(trustedRoot, candidateAfterOpen)) {
      return unavailableClaudeTranscriptTail("transcript_trust_rejected");
    }
    if (candidateAfterOpen !== candidateBeforeOpen) {
      return unavailableClaudeTranscriptTail("transcript_read_unstable");
    }
    const pathState = await stat(candidateAfterOpen);
    if (pathState.dev !== before.dev || pathState.ino !== before.ino) {
      return unavailableClaudeTranscriptTail("transcript_read_unstable");
    }

    const length = Math.min(before.size, CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES);
    const offset = before.size - length;
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, offset);
    if (bytesRead !== length) {
      return unavailableClaudeTranscriptTail("transcript_read_unstable");
    }
    const after = await handle.stat();
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
    ) {
      return unavailableClaudeTranscriptTail("transcript_read_unstable");
    }

    const truncated = before.size > CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES;
    let tail = bytes.toString("utf8");
    if (truncated) {
      const firstNewline = tail.indexOf("\n");
      tail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : "";
    }
    return { state: "available", tail, truncated };
  } catch {
    return unavailableClaudeTranscriptTail("transcript_read_unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function unavailableClaudeTranscriptTail(
  diagnosticReason: Exclude<ClaudeTranscriptTailInput, { state: "available" }>["diagnosticReason"]
): ClaudeTranscriptTailInput {
  return { state: "unavailable", diagnosticReason };
}

function boundedAbsolutePath(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || value.includes("\0")
    || !isAbsolute(value)
  ) {
    return undefined;
  }
  return value;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && pathFromRoot !== ".."
      && !isAbsolute(pathFromRoot));
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

function providerHookShapeDetails(raw: unknown): Record<string, string | number | boolean> {
  const record = isRecord(raw) ? raw : undefined;
  const hookEvent = safeProviderHookEventName(record?.hook_event_name);
  return {
    hookEvent,
    hasSessionId: hasProviderHookText(record?.session_id),
    hasTurnId: hasProviderHookText(record?.turn_id),
    hasTranscriptPath: hasProviderHookText(record?.transcript_path),
    hasWorkspacePath: providerHookWorkspacePath(record) != null,
    stopHookActive: record?.stop_hook_active === true,
    backgroundTaskCount: boundedProviderHookArrayCount(record?.background_tasks),
    sessionCronCount: boundedProviderHookArrayCount(record?.session_crons),
    hasStructuredErrorCategory: hasProviderHookText(record?.error),
    ...(hookEvent === "session_end" ? {
      sessionEndReason: safeClaudeSessionEndReason(record?.reason) ?? "unknown"
    } : {})
  };
}

function providerHookProvenanceDetails(raw: unknown): Record<string, string> {
  if (!isRecord(raw) || !("tirion_claude_submission_provenance" in raw)) {
    return {};
  }
  const provenance = raw.tirion_claude_submission_provenance;
  if (!isRecord(provenance)) {
    return {
      claudeSubmissionProvenance: "unavailable",
      claudeSubmissionProvenanceReason: "malformed_provenance"
    };
  }
  const diagnosticReason = safeClaudeSubmissionProvenanceDiagnosticReason(provenance.diagnosticReason);
  if (provenance.state === "ambiguous") {
    return {
      claudeSubmissionProvenance: "ambiguous",
      ...(diagnosticReason ? { claudeSubmissionProvenanceReason: diagnosticReason } : {})
    };
  }
  if (provenance.state !== "resolved") {
    return {
      claudeSubmissionProvenance: "unavailable",
      ...(diagnosticReason ? { claudeSubmissionProvenanceReason: diagnosticReason } : {})
    };
  }
  if (provenance.originKind === "human" && provenance.promptSource === "typed") {
    return { claudeSubmissionProvenance: "human_typed" };
  }
  if (
    provenance.originKind === "task-notification"
    && provenance.promptSource === "system"
  ) {
    return { claudeSubmissionProvenance: "task_notification_system" };
  }
  return {
    claudeSubmissionProvenance: "unavailable",
    claudeSubmissionProvenanceReason: "malformed_provenance"
  };
}

function safeClaudeSubmissionProvenanceDiagnosticReason(value: unknown): string | undefined {
  return isClaudeSubmissionProvenanceDiagnosticReason(value)
    ? value
    : undefined;
}

function resolvedClaudeTranscriptPromptId(raw: unknown): string | undefined {
  if (!isRecord(raw) || !isRecord(raw.tirion_claude_submission_provenance)) {
    return undefined;
  }
  const provenance = raw.tirion_claude_submission_provenance;
  const transcriptPromptId = boundedProviderHookScalar(provenance.transcriptPromptId);
  return provenance.state === "resolved" && typeof transcriptPromptId === "string"
    ? transcriptPromptId
    : undefined;
}

function boundedProviderHookArrayCount(value: unknown): number {
  return Array.isArray(value) ? Math.min(value.length, 10_000) : 0;
}

function safeProviderHookEventName(value: unknown): string {
  const knownEvents: Record<string, string> = {
    userpromptsubmit: "user_prompt_submit",
    pretooluse: "pre_tool_use",
    stop: "stop",
    stopfailure: "stop_failure",
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

function hasClaudeClosedInteraction(raw: unknown, signal: TelemetrySignal): boolean {
  return signal === "traces" && new DefaultTelemetryNormalizer().normalizeMany(raw).some((record) =>
    record.kind === "span"
    && normalizedIdentifier(record.name) === "claudecodeinteraction"
    && typeof record.endTimeUnixNano === "string"
    && record.endTimeUnixNano.length > 0
  );
}

function wait(delayMs: number): Promise<void> {
  return delayMs === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, delayMs));
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
