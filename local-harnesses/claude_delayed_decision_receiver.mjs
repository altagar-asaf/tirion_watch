#!/usr/bin/env node
/**
 * Metadata-only receiver for the opt-in CC15C live acceptance harness.
 *
 * It validates Tirion's local bearer/HMAC delivery metadata, reduces webhook
 * bodies immediately to a small safe status model, and never persists or
 * prints webhook payloads.  Opaque run/event identities are retained only in
 * process memory to correlate one live probe and are represented externally by
 * local aliases.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVENTS = 512;
const MAX_TERMINAL_VERSIONS = 16;
const CORRECTION_WINDOW_MS = 15_000;
const RUN_STARTED_WEBHOOK_KEYS = new Set([
  "schemaVersion", "eventType", "eventId", "runId", "sessionId", "traceIds", "sender", "repository",
  "codingHarness", "runtime", "startedAt", "evidence", "coverage", "sequence", "updatedAt", "state", "llmModels"
]);
const RUN_UPDATED_WEBHOOK_KEYS = new Set([
  "schemaVersion", "eventType", "eventId", "runId", "sessionId", "traceIds", "sender", "repository",
  "codingHarness", "runtime", "startedAt", "evidence", "coverage", "sequence", "updatedAt", "state",
  "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens",
  "totalTokens", "llmModels", "estimatedNanoUsd", "usageValueNanoUsd", "costEstimateBasis", "costCoverage",
  "context", "activity"
]);
const RUN_ENDED_WEBHOOK_KEYS = new Set([
  "schemaVersion", "eventType", "eventId", "runId", "sessionId", "traceIds", "sender", "repository",
  "codingHarness", "runtime", "startedAt", "evidence", "coverage", "version", "outcome", "endedAt",
  "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens",
  "totalTokens", "llmModels", "filesChanged", "estimatedNanoUsd", "usageValueNanoUsd", "costEstimateBasis",
  "costCoverage", "context", "activity", "state"
]);
const COMMIT_ATTRIBUTED_WEBHOOK_KEYS = new Set([
  "schemaVersion", "eventType", "eventId", "sender", "repository", "commitSha", "commitMessage", "traceIds",
  "runIds", "estimatedNanoUsd", "usageValueNanoUsd", "costCoverage", "state", "version", "firstVerifiedAt", "updatedAt"
]);
const REJECTED_WRITE_EXECUTION_FIELDS = [
  "endedAt", "durationMs", "resultSizeBytes", "providerReportedResultTokens", "inputTokens", "outputTokens",
  "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens", "totalTokens",
  "usageAttributionBasis", "usageCoverage"
];

/**
 * @param {{ deliveryToken: string, hmacSecret: string, controlToken: string, expectedSessionId?: string, privacyCanary?: string, monotonicNow?: () => number, port?: number, testBeforeAccept?: () => Promise<void> }} options
 */
export async function startClaudeDelayedDecisionReceiver(options) {
  const deliveryToken = requireSecret(options.deliveryToken, "delivery_token");
  const hmacSecret = requireSecret(options.hmacSecret, "hmac_secret");
  const controlToken = requireSecret(options.controlToken, "control_token");
  // Claude's public lifecycle payload uses the `ses_<sha256>` identifier
  // produced by telemetry classification, while the relay observes the raw
  // Claude session.  Bind this receiver to the public identifier directly;
  // hashing it again would compare two unrelated identity domains.
  const expectedSessionId = options.expectedSessionId == null
    ? undefined
    : requireWebhookSessionId(options.expectedSessionId, "expected_session_id");
  const expectedSessionBound = expectedSessionId != null;
  const privacyCanary = options.privacyCanary == null
    ? undefined
    : requirePrivacyCanary(options.privacyCanary);
  const privacyCanaryBytes = privacyCanary ? Buffer.from(privacyCanary, "utf8") : undefined;
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  if (typeof monotonicNow !== "function") throw new Error("invalid_monotonic_clock");
  if (options.testBeforeAccept != null && typeof options.testBeforeAccept !== "function") {
    throw new Error("invalid_test_before_accept");
  }
  const testBeforeAccept = options.testBeforeAccept;
  const requestedPort = boundedPort(options.port ?? 0);
  const runs = new Map();
  const aliases = new Map();
  const seenEventIds = new Set();
  let nextAlias = 1;
  let acceptedEventCount = 0;
  let duplicateEventCount = 0;
  let rejectedRequestCount = 0;
  let commitEventCount = 0;
  let forbiddenPayloadDetected = false;
  let webhookSealed = false;
  let inFlightWebhookCount = 0;
  let postSealWebhookAttemptCount = 0;
  /** @type {(() => void)[]} */
  const webhookIdleWaiters = [];

  const status = () => ({
    schemaVersion: 1,
    acceptedEventCount,
    duplicateEventCount,
    rejectedRequestCount,
    commitEventCount,
    forbiddenPayloadDetected,
    expectedSessionBound,
    webhookSealed,
    inFlightWebhookCount,
    postSealWebhookAttemptCount,
    runs: [...runs.values()].map(publicRunSummary)
  });

  const waitForWebhookIdle = async () => {
    if (inFlightWebhookCount === 0) return;
    await new Promise((resolvePromise) => webhookIdleWaiters.push(resolvePromise));
  };

  const finishWebhook = () => {
    inFlightWebhookCount = Math.max(0, inFlightWebhookCount - 1);
    if (inFlightWebhookCount === 0) {
      for (const resolvePromise of webhookIdleWaiters.splice(0)) resolvePromise();
    }
  };

  const clear = () => {
    runs.clear();
    aliases.clear();
    seenEventIds.clear();
    nextAlias = 1;
    acceptedEventCount = 0;
    duplicateEventCount = 0;
    rejectedRequestCount = 0;
    commitEventCount = 0;
    forbiddenPayloadDetected = false;
  };

  const server = createServer(async (request, response) => {
    let countedWebhook = false;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/control/")) {
        if (!constantTimeMatch(request.headers["x-tirion-cc15c-control"], controlToken)) {
          rejectedRequestCount += 1;
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (request.method === "GET" && url.pathname === "/control/status") {
          sendJson(response, 200, status());
          return;
        }
        if (request.method === "POST" && url.pathname === "/control/clear") {
          clear();
          sendJson(response, 200, { schemaVersion: 1, cleared: true });
          return;
        }
        if (request.method === "POST" && url.pathname === "/control/seal") {
          webhookSealed = true;
          await waitForWebhookIdle();
          sendJson(response, 200, status());
          return;
        }
        if (request.method === "POST" && url.pathname === "/control/shutdown") {
          sendJson(response, 200, { status: "shutting_down" });
          setImmediate(() => server.close());
          return;
        }
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      if (request.method !== "POST" || url.pathname !== "/webhooks/tirion") {
        rejectedRequestCount += 1;
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (!constantTimeMatch(bearerToken(request.headers.authorization), deliveryToken)) {
        rejectedRequestCount += 1;
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      countedWebhook = true;
      inFlightWebhookCount += 1;
      if (webhookSealed) {
        rejectedRequestCount += 1;
        postSealWebhookAttemptCount += 1;
        sendJson(response, 409, { error: "receiver_webhook_sealed" });
        return;
      }
      const raw = await readBoundedBody(request, MAX_BODY_BYTES);
      try {
        forbiddenPayloadDetected ||= containsCanary(raw, privacyCanaryBytes);
        if (!validSignature(request.headers, raw, hmacSecret)) {
          rejectedRequestCount += 1;
          sendJson(response, 401, { error: "invalid_signature" });
          return;
        }
        const payload = parseObjectJson(raw);
        // Scan the decoded JSON before rejecting a malformed schema. A privacy
        // canary must remain sticky even when an unknown field makes the
        // payload ineligible for all other receiver processing.
        forbiddenPayloadDetected ||= hasForbiddenPayloadShape(payload, privacyCanary);
        if (!isStrictWebhookEvent(payload)) {
          rejectedRequestCount += 1;
          sendJson(response, 422, { error: "unsupported_event" });
          return;
        }
        // Test-only gate: permits a deterministic regression that seal waits
        // for a fully authenticated, schema-valid pre-seal handler.
        await testBeforeAccept?.();
        const eventId = safeOpaqueId(payload.eventId);
        if (!eventId) {
          rejectedRequestCount += 1;
          sendJson(response, 422, { error: "invalid_event" });
          return;
        }
        if (seenEventIds.has(eventId)) {
          duplicateEventCount += 1;
          sendJson(response, 409, { duplicate: true });
          return;
        }
        seenEventIds.add(eventId);
        if (seenEventIds.size > MAX_EVENTS) {
          seenEventIds.delete(seenEventIds.values().next().value);
        }
        acceptedEventCount += 1;
        if (payload.eventType === "commit.attributed") {
          commitEventCount += 1;
          for (const runId of Array.isArray(payload.runIds) ? payload.runIds : []) {
            const run = typeof runId === "string" ? runs.get(runId) : undefined;
            if (run) run.commitEventCount += 1;
          }
        } else {
          const runId = safeOpaqueId(payload.runId);
          if (!runId) {
            rejectedRequestCount += 1;
            sendJson(response, 422, { error: "invalid_event" });
            return;
          }
          let run = runs.get(runId);
          if (!run) {
            const alias = `run_${String(nextAlias).padStart(3, "0")}`;
            nextAlias += 1;
            aliases.set(runId, alias);
            run = newRun(alias, expectedSessionBound);
            runs.set(runId, run);
          }
          acceptRunEvent(run, payload, expectedSessionId, safeMonotonicMilliseconds(monotonicNow()));
        }
        sendJson(response, 200, { accepted: true });
      } finally {
        zeroBuffer(raw);
      }
    } catch {
      rejectedRequestCount += 1;
      sendJson(response, 400, { error: "invalid_request" });
    } finally {
      if (countedWebhook) finishWebhook();
    }
  });

  await listenLoopback(server, requestedPort);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("receiver_listen_failed");
  }
  let closed = false;
  return {
    port: address.port,
    status,
    async close() {
      if (closed) return;
      closed = true;
      zeroBuffer(privacyCanaryBytes);
      await closeServer(server);
    }
  };
}

function newRun(alias, expectedSessionBound) {
  return {
    alias,
    runStartCount: 0,
    runUpdateCount: 0,
    updatesBeforeFirstStart: 0,
    updatesAfterFirstTerminal: 0,
    startBeforeFirstTerminal: true,
    terminalVersions: [],
    commitEventCount: 0,
    startedAt: undefined,
    repositoryFingerprint: undefined,
    sessionDigest: undefined,
    stableStartedAt: true,
    stableRepository: true,
    stableSession: true,
    expectedSessionBound,
    expectedSessionMatch: expectedSessionBound,
    completeLifecycleIdentity: true,
    claudeCodeRuntime: true,
    completedTerminalState: true,
    completeTerminalBoundary: true,
    validTerminalVersions: true,
    lastTerminalVersion: 0,
    terminalHistoryOverflow: false,
    firstTerminalBoundaryMilliseconds: undefined,
    firstTerminalReceiptMonotonic: undefined,
    stableTerminalBoundary: true,
    baselineTerminalReceiptCaptured: false,
    allCorrectionsWithinCorrectionWindow: true,
    strictLifecycleClaimsSafe: true,
    strictUpdateActivityClaimsSafe: true,
    strictTerminalActivityClaimsSafe: true,
    strictFileAndCommitClaimsSafe: true,
    firstTerminalUsageAndCost: undefined,
    usageOrCostChangedFromFirstTerminal: false,
    previousTerminalNonDecisionClaims: undefined,
    terminalSeen: false
  };
}

function acceptRunEvent(run, payload, expectedSessionId, receivedMonotonicMilliseconds) {
  if (payload.codingHarness !== "claude-code" || payload.runtime !== "claude-code") {
    run.claudeCodeRuntime = false;
  }
  const startedAt = safeIso(payload.startedAt);
  const repositoryFingerprint = safeRepositoryFingerprint(payload.repository);
  const sessionId = safeOpaqueId(payload.sessionId);
  const sessionDigest = sessionId ? opaqueIdentityDigest(sessionId) : undefined;
  if (!startedAt || !repositoryFingerprint || !sessionId || !sessionDigest) {
    run.completeLifecycleIdentity = false;
  }
  if (startedAt && run.startedAt && run.startedAt !== startedAt) run.stableStartedAt = false;
  run.startedAt ??= startedAt;
  if (repositoryFingerprint && run.repositoryFingerprint && run.repositoryFingerprint !== repositoryFingerprint) {
    run.stableRepository = false;
  }
  run.repositoryFingerprint ??= repositoryFingerprint;
  if (sessionDigest && run.sessionDigest && !constantTimeMatch(sessionDigest, run.sessionDigest)) {
    run.stableSession = false;
  }
  run.sessionDigest ??= sessionDigest;
  if (expectedSessionId && (!sessionId || !constantTimeMatch(sessionId, expectedSessionId))) {
    run.expectedSessionMatch = false;
  }
  if (payload.eventType === "run.start") {
    run.runStartCount += 1;
    return;
  }
  if (payload.eventType === "run.update") {
    const activitySafe = isCc15cUpdateActivityClaimSet(payload.activity, payload.llmModels);
    run.strictLifecycleClaimsSafe &&= activitySafe;
    run.strictUpdateActivityClaimsSafe &&= activitySafe;
    run.runUpdateCount += 1;
    if (run.runStartCount === 0) run.updatesBeforeFirstStart += 1;
    if (run.terminalSeen) run.updatesAfterFirstTerminal += 1;
    return;
  }
  if (run.runStartCount === 0) run.startBeforeFirstTerminal = false;
  run.terminalSeen = true;
  const activitySafe = isCc15cTerminalActivityClaimSet(payload.activity, payload.llmModels);
  run.strictLifecycleClaimsSafe &&= activitySafe;
  run.strictTerminalActivityClaimsSafe &&= activitySafe;
  if (!Array.isArray(payload.filesChanged) || payload.filesChanged.length !== 0) {
    run.strictLifecycleClaimsSafe = false;
    run.strictFileAndCommitClaimsSafe = false;
  }
  if (payload.state !== "completed") run.completedTerminalState = false;
  const terminalBoundaryMilliseconds = safeEpochMilliseconds(payload.endedAt);
  if (terminalBoundaryMilliseconds == null) run.completeTerminalBoundary = false;
  let deliveredWithinCorrectionWindow = false;
  if (run.firstTerminalReceiptMonotonic == null) {
    if (receivedMonotonicMilliseconds != null) {
      run.firstTerminalReceiptMonotonic = receivedMonotonicMilliseconds;
      run.baselineTerminalReceiptCaptured = true;
      // The baseline creates the correction-retention clock, so it is
      // necessarily the zero-delay delivery for this bounded status model.
      deliveredWithinCorrectionWindow = true;
    }
  } else {
    deliveredWithinCorrectionWindow = deliveryWithinCorrectionWindow(
      run.firstTerminalReceiptMonotonic,
      receivedMonotonicMilliseconds
    );
    run.allCorrectionsWithinCorrectionWindow &&= deliveredWithinCorrectionWindow;
  }
  if (run.firstTerminalBoundaryMilliseconds == null && terminalBoundaryMilliseconds != null) {
    run.firstTerminalBoundaryMilliseconds = terminalBoundaryMilliseconds;
  } else if (run.firstTerminalBoundaryMilliseconds != null) {
    if (terminalBoundaryMilliseconds !== run.firstTerminalBoundaryMilliseconds) {
      run.stableTerminalBoundary = false;
    }
    run.allCorrectionsWithinCorrectionWindow &&= deliveredWithinCorrectionWindow;
  }
  const terminal = summarizeTerminal(payload, deliveredWithinCorrectionWindow);
  const nonDecisionClaims = terminalNonDecisionClaims(payload);
  terminal.nonDecisionClaimsMatchPrevious = run.previousTerminalNonDecisionClaims == null
    || sameTerminalNonDecisionClaims(run.previousTerminalNonDecisionClaims, nonDecisionClaims);
  run.previousTerminalNonDecisionClaims = nonDecisionClaims;
  run.strictTerminalActivityClaimsSafe &&= terminal.strictCc15cActivityClaimsSafe;
  run.strictLifecycleClaimsSafe &&= terminal.strictCc15cActivityClaimsSafe;
  if (terminal.version !== run.lastTerminalVersion + 1) {
    run.validTerminalVersions = false;
  }
  run.lastTerminalVersion = Math.max(run.lastTerminalVersion, terminal.version);
  const baseline = run.firstTerminalUsageAndCost;
  if (!baseline) {
    run.firstTerminalUsageAndCost = terminal.usageAndCost;
  } else if (!sameUsageAndCost(baseline, terminal.usageAndCost)) {
    run.usageOrCostChangedFromFirstTerminal = true;
  }
  if (run.terminalVersions.length >= MAX_TERMINAL_VERSIONS) {
    run.terminalHistoryOverflow = true;
  } else {
    run.terminalVersions.push(terminal);
  }
}

function summarizeTerminal(payload, deliveredWithinCorrectionWindow) {
  const activity = Array.isArray(payload.activity) ? payload.activity : [];
  let activityCoverageComplete = Array.isArray(payload.activity)
    && payload.activity.length <= 128
    && payload.activity.every(isRecord);
  let validWriteActivityCounts = true;
  let validWriteActivityEvidence = true;
  let writeActivityCount = 0;
  let nonRejectedWriteCount = 0;
  let writeExecutionGrant = false;
  let unknownWriteCount = 0;
  let rejectedWriteCount = 0;
  let rejectedWriteFailureCount = 0;
  let rejectedWriteRejectionCount = 0;
  let rejectedWriteExecutionGrant = false;
  let validNonWriteToolActivityCounts = true;
  let nonWriteToolCount = 0;
  let nonWriteToolExecutionGrant = false;
  let strictCc15cActivityClaimsSafe = isCc15cTerminalActivityClaimSet(activity, payload.llmModels);
  for (const entry of activity.slice(0, 128)) {
    if (!isRecord(entry)) continue;
    strictCc15cActivityClaimsSafe &&= isCc15cActivityClaim(entry, true, payload.llmModels);
    const count = safeCount(entry.count, 1);
    const isWrite = normalizedToken(entry.name) === "write";
    const kind = normalizedToken(entry.kind);
    if (!new Set(["llmrequest", "tool", "subagent", "skill", "mcp", "hook", "unknown"]).has(kind)) {
      activityCoverageComplete = false;
      continue;
    }
    if (kind === "tool" && !isWrite) {
      if (!Number.isSafeInteger(entry.count) || entry.count < 1) validNonWriteToolActivityCounts = false;
      nonWriteToolCount += count;
      nonWriteToolExecutionGrant ||= hasExecutionGrant(entry);
    }
    if (!isWrite) continue;
    if (!Number.isSafeInteger(entry.count) || entry.count < 1) validWriteActivityCounts = false;
    if (kind !== "tool" || !isValidActivityEvidence(entry.evidence)) validWriteActivityEvidence = false;
    writeActivityCount += count;
    writeExecutionGrant ||= hasExecutionGrant(entry);
    if (entry.outcome === "unknown") unknownWriteCount += count;
    if (entry.outcome === "rejected") {
      rejectedWriteCount += count;
      rejectedWriteFailureCount += safeCount(entry.failureCount, 0);
      rejectedWriteRejectionCount += safeCount(entry.rejectedCount, 0);
      rejectedWriteExecutionGrant ||= hasExecutionGrant(entry);
    } else {
      nonRejectedWriteCount += count;
    }
  }
  return {
    version: safeVersion(payload.version) ?? 0,
    rootSpanEvidence: isRecord(payload.evidence) && payload.evidence.basis === "root_span",
    activityCoverageComplete,
    validWriteActivityCounts,
    validWriteActivityEvidence,
    filesChangedCount: Array.isArray(payload.filesChanged) ? payload.filesChanged.length : -1,
    writeActivityCount,
    nonRejectedWriteCount,
    writeExecutionGrant,
    unknownWriteCount,
    rejectedWriteCount,
    rejectedWriteFailureCount,
    rejectedWriteRejectionCount,
    rejectedWriteExecutionGrant,
    validNonWriteToolActivityCounts,
    nonWriteToolCount,
    nonWriteToolExecutionGrant,
    strictCc15cActivityClaimsSafe,
    deliveredWithinCorrectionWindow,
    nonDecisionClaimsMatchPrevious: true,
    usageAndCost: usageAndCostSummary(payload)
  };
}

// A late native decision is permitted to change only the single controlled
// Write's decision fields.  Preserve a canonical, in-memory fingerprint of
// every other safe terminal claim so the external assertion can fail closed
// if a correction also changes accounting, context, models, coverage, or
// another activity's allocation.  Opaque IDs and evidence provenance are
// deliberately excluded: they are not public accounting claims and a later
// source receipt can legitimately replace them.
function terminalNonDecisionClaims(payload) {
  const activity = Array.isArray(payload.activity) ? payload.activity : [];
  return canonicalClaimValue({
    inputTokens: payload.inputTokens,
    outputTokens: payload.outputTokens,
    cacheReadInputTokens: payload.cacheReadInputTokens,
    cacheCreationInputTokens: payload.cacheCreationInputTokens,
    reasoningOutputTokens: payload.reasoningOutputTokens,
    totalTokens: payload.totalTokens,
    llmModels: Array.isArray(payload.llmModels) ? [...payload.llmModels].sort() : [],
    estimatedNanoUsd: payload.estimatedNanoUsd,
    usageValueNanoUsd: hasOwn(payload, "usageValueNanoUsd") ? payload.usageValueNanoUsd : null,
    costEstimateBasis: payload.costEstimateBasis,
    costCoverage: payload.costCoverage,
    outcome: payload.outcome ?? null,
    coverage: payload.coverage,
    context: payload.context ?? null,
    activity: activity
      .filter((entry) => !isControlledWriteActivity(entry))
      .map(nonDecisionActivityClaim)
  });
}

function isControlledWriteActivity(value) {
  return isRecord(value) && value.kind === "tool" && normalizedToken(value.name) === "write";
}

function nonDecisionActivityClaim(value) {
  if (!isRecord(value)) return value;
  const { activityId: _activityId, parentActivityId: _parentActivityId, evidence: _evidence, ...claim } = value;
  return claim;
}

function canonicalClaimValue(value) {
  if (Array.isArray(value)) return value.map(canonicalClaimValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalClaimValue(value[key])]));
}

function sameTerminalNonDecisionClaims(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function usageAndCostSummary(payload) {
  return {
    inputTokens: safeCount(payload.inputTokens, -1),
    outputTokens: safeCount(payload.outputTokens, -1),
    cacheReadInputTokens: safeCount(payload.cacheReadInputTokens, -1),
    cacheCreationInputTokens: safeCount(payload.cacheCreationInputTokens, -1),
    reasoningOutputTokens: safeCount(payload.reasoningOutputTokens, -1),
    totalTokens: safeCount(payload.totalTokens, -1),
    estimatedNanoUsd: safeCount(payload.estimatedNanoUsd, -1)
  };
}

function sameUsageAndCost(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function publicRunSummary(run) {
  return {
    alias: run.alias,
    runStartCount: run.runStartCount,
    runUpdateCount: run.runUpdateCount,
    updatesBeforeFirstStart: run.updatesBeforeFirstStart,
    updatesAfterFirstTerminal: run.updatesAfterFirstTerminal,
    startBeforeFirstTerminal: run.startBeforeFirstTerminal,
    commitEventCount: run.commitEventCount,
    stableStartedAt: run.stableStartedAt,
    stableRepository: run.stableRepository,
    stableSession: run.stableSession,
    expectedSessionBound: run.expectedSessionBound,
    expectedSessionMatch: run.expectedSessionMatch,
    completeLifecycleIdentity: run.completeLifecycleIdentity,
    claudeCodeRuntime: run.claudeCodeRuntime,
    completedTerminalState: run.completedTerminalState,
    completeTerminalBoundary: run.completeTerminalBoundary,
    stableTerminalBoundary: run.stableTerminalBoundary,
    baselineTerminalReceiptCaptured: run.baselineTerminalReceiptCaptured,
    allCorrectionsWithinCorrectionWindow: run.allCorrectionsWithinCorrectionWindow,
    strictLifecycleClaimsSafe: run.strictLifecycleClaimsSafe,
    strictUpdateActivityClaimsSafe: run.strictUpdateActivityClaimsSafe,
    strictTerminalActivityClaimsSafe: run.strictTerminalActivityClaimsSafe,
    strictFileAndCommitClaimsSafe: run.strictFileAndCommitClaimsSafe,
    validTerminalVersions: run.validTerminalVersions,
    terminalHistoryOverflow: run.terminalHistoryOverflow,
    usageOrCostChangedFromFirstTerminal: run.usageOrCostChangedFromFirstTerminal,
    terminalVersions: run.terminalVersions.map((terminal) => ({
      version: terminal.version,
      rootSpanEvidence: terminal.rootSpanEvidence,
      activityCoverageComplete: terminal.activityCoverageComplete,
      validWriteActivityCounts: terminal.validWriteActivityCounts,
      validWriteActivityEvidence: terminal.validWriteActivityEvidence,
      filesChangedCount: terminal.filesChangedCount,
      writeActivityCount: terminal.writeActivityCount,
      nonRejectedWriteCount: terminal.nonRejectedWriteCount,
      writeExecutionGrant: terminal.writeExecutionGrant,
      unknownWriteCount: terminal.unknownWriteCount,
      rejectedWriteCount: terminal.rejectedWriteCount,
      rejectedWriteFailureCount: terminal.rejectedWriteFailureCount,
      rejectedWriteRejectionCount: terminal.rejectedWriteRejectionCount,
      rejectedWriteExecutionGrant: terminal.rejectedWriteExecutionGrant,
      validNonWriteToolActivityCounts: terminal.validNonWriteToolActivityCounts,
      nonWriteToolCount: terminal.nonWriteToolCount,
      nonWriteToolExecutionGrant: terminal.nonWriteToolExecutionGrant,
      strictCc15cActivityClaimsSafe: terminal.strictCc15cActivityClaimsSafe,
      deliveredWithinCorrectionWindow: terminal.deliveredWithinCorrectionWindow,
      nonDecisionClaimsMatchPrevious: terminal.nonDecisionClaimsMatchPrevious
    }))
  };
}

function validSignature(headers, body, secret) {
  const timestamp = singleHeader(headers["x-tirion-timestamp"]);
  const signature = singleHeader(headers["x-tirion-signature-256"]);
  if (!timestamp || !/^[0-9]{1,16}$/.test(timestamp) || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex")}`;
  return constantTimeMatch(signature, expected);
}

// Mirror the public webhook contract at this independent acceptance boundary.
// The receiver deliberately refuses future or malformed shapes rather than
// treating a signed payload as evidence merely because its event type looks
// familiar. That gives the CC15C probe a bounded claim allowlist without
// retaining the original payload.
function isStrictWebhookEvent(value) {
  if (!isRecord(value)) return false;
  if (value.eventType === "run.start") return isStrictRunStartedWebhookEvent(value);
  if (value.eventType === "run.update") return isStrictRunUpdatedWebhookEvent(value);
  if (value.eventType === "run.ended") return isStrictRunEndedWebhookEvent(value);
  if (value.eventType === "commit.attributed") return isStrictCommitAttributedWebhookEvent(value);
  return false;
}

function hasOnlyKnownKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function isStrictRunStartedWebhookEvent(value) {
  return hasOnlyKnownKeys(value, RUN_STARTED_WEBHOOK_KEYS)
    && value.schemaVersion === 1
    && value.eventType === "run.start"
    && isWebhookOpaqueId(value.eventId)
    && isWebhookOpaqueId(value.runId)
    && isWebhookOpaqueId(value.sessionId)
    && isWebhookIdArray(value.traceIds)
    && isWebhookSender(value.sender)
    && isWebhookRepository(value.repository)
    && isWebhookHarness(value.codingHarness)
    && isWebhookRuntime(value.runtime)
    && isTimestamp(value.startedAt)
    && isWebhookEvidence(value.evidence)
    && isWebhookCoverage(value.coverage)
    && isPositiveSafeInteger(value.sequence)
    && isTimestamp(value.updatedAt)
    && value.updatedAt >= value.startedAt
    && value.state === "running"
    && isWebhookStringArray(value.llmModels);
}

function isStrictRunUpdatedWebhookEvent(value) {
  return hasOnlyKnownKeys(value, RUN_UPDATED_WEBHOOK_KEYS)
    && value.schemaVersion === 1
    && value.eventType === "run.update"
    && isWebhookOpaqueId(value.eventId)
    && isWebhookOpaqueId(value.runId)
    && isWebhookOpaqueId(value.sessionId)
    && isWebhookIdArray(value.traceIds)
    && isWebhookSender(value.sender)
    && isWebhookRepository(value.repository)
    && isWebhookHarness(value.codingHarness)
    && isWebhookRuntime(value.runtime)
    && isTimestamp(value.startedAt)
    && isWebhookEvidence(value.evidence)
    && isWebhookCoverage(value.coverage)
    && isPositiveSafeInteger(value.sequence)
    && isTimestamp(value.updatedAt)
    && value.updatedAt >= value.startedAt
    && (value.state === "running" || value.state === "settling")
    && isNonNegativeSafeInteger(value.inputTokens)
    && isNonNegativeSafeInteger(value.outputTokens)
    && isNonNegativeSafeInteger(value.cacheReadInputTokens)
    && isNonNegativeSafeInteger(value.cacheCreationInputTokens)
    && isNonNegativeSafeInteger(value.reasoningOutputTokens)
    && isNonNegativeSafeInteger(value.totalTokens)
    && value.totalTokens === value.inputTokens + value.outputTokens
    && isWebhookStringArray(value.llmModels)
    && isNonNegativeSafeInteger(value.estimatedNanoUsd)
    && (value.usageValueNanoUsd == null || isNonNegativeSafeInteger(value.usageValueNanoUsd))
    && isCostEstimateBasis(value.costEstimateBasis)
    && isCostCoverage(value.costCoverage)
    && value.coverage.costCoverage === value.costCoverage
    && (value.context == null || isWebhookContextFootprint(value.context))
    && isWebhookActivityArray(value.activity)
    && webhookActivityConservesUsage(value.activity, value);
}

function isStrictRunEndedWebhookEvent(value) {
  return hasOnlyKnownKeys(value, RUN_ENDED_WEBHOOK_KEYS)
    && value.schemaVersion === 1
    && value.eventType === "run.ended"
    && isWebhookOpaqueId(value.eventId)
    && isWebhookOpaqueId(value.runId)
    && isWebhookOpaqueId(value.sessionId)
    && isWebhookIdArray(value.traceIds)
    && isWebhookSender(value.sender)
    && isWebhookRepository(value.repository)
    && isWebhookHarness(value.codingHarness)
    && isWebhookRuntime(value.runtime)
    && isTimestamp(value.startedAt)
    && isWebhookEvidence(value.evidence)
    && isWebhookCoverage(value.coverage)
    && (value.version == null || isPositiveSafeInteger(value.version))
    && (value.outcome == null || isCompletionOutcome(value.outcome))
    && isTimestamp(value.endedAt)
    && value.endedAt >= value.startedAt
    && isNonNegativeSafeInteger(value.inputTokens)
    && isNonNegativeSafeInteger(value.outputTokens)
    && isNonNegativeSafeInteger(value.cacheReadInputTokens)
    && isNonNegativeSafeInteger(value.cacheCreationInputTokens)
    && isNonNegativeSafeInteger(value.reasoningOutputTokens)
    && isNonNegativeSafeInteger(value.totalTokens)
    && value.totalTokens === value.inputTokens + value.outputTokens
    && isWebhookStringArray(value.llmModels)
    && isRepoRelativePathArray(value.filesChanged)
    && isNonNegativeSafeInteger(value.estimatedNanoUsd)
    && (value.usageValueNanoUsd == null || isNonNegativeSafeInteger(value.usageValueNanoUsd))
    && isCostEstimateBasis(value.costEstimateBasis)
    && isCostCoverage(value.costCoverage)
    && value.coverage.costCoverage === value.costCoverage
    && isPermittedTerminalUsageCoverage(value.coverage.usageCoverage, value.evidence, value.outcome, value)
    && (value.context == null || isWebhookContextFootprint(value.context, value.coverage.usageCoverage))
    && (value.activity == null || (
      isWebhookActivityArray(value.activity)
      && webhookActivityConservesUsage(value.activity, value)
    ))
    && value.state === "completed";
}

function isStrictCommitAttributedWebhookEvent(value) {
  return hasOnlyKnownKeys(value, COMMIT_ATTRIBUTED_WEBHOOK_KEYS)
    && value.schemaVersion === 1
    && value.eventType === "commit.attributed"
    && isWebhookOpaqueId(value.eventId)
    && isWebhookSender(value.sender)
    && isWebhookRepository(value.repository)
    && typeof value.commitSha === "string"
    && /^[a-f0-9]{7,64}$/i.test(value.commitSha)
    && (value.commitMessage == null || isWebhookSenderText(value.commitMessage))
    && isWebhookIdArray(value.traceIds)
    && isWebhookIdArray(value.runIds)
    && isNonNegativeSafeInteger(value.estimatedNanoUsd)
    && (value.usageValueNanoUsd == null || isNonNegativeSafeInteger(value.usageValueNanoUsd))
    && isCostCoverage(value.costCoverage)
    && (value.state === "active" || value.state === "rewrite_pending" || value.state === "superseded")
    && isPositiveSafeInteger(value.version)
    && isTimestamp(value.firstVerifiedAt)
    && isTimestamp(value.updatedAt);
}

function isWebhookOpaqueId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\t]/.test(value);
}

function isWebhookHarness(value) {
  return value === "github-copilot" || value === "claude-code" || value === "codex" || value === "cursor";
}

function isWebhookRuntime(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\r\n\t]/.test(value);
}

function isWebhookEvidence(value) {
  return isRecord(value)
    && Object.keys(value).every((key) => [
      "basis", "sourceId", "profileVersion", "observedAt", "delayed", "identityConfidence", "timingConfidence"
    ].includes(key))
    && isWebhookEvidenceBasis(value.basis)
    && isWebhookOpaqueId(value.sourceId)
    && isWebhookRuntime(value.profileVersion)
    && isTimestamp(value.observedAt)
    && typeof value.delayed === "boolean"
    && (value.identityConfidence === "high" || value.identityConfidence === "medium")
    && (value.timingConfidence === "high" || value.timingConfidence === "medium");
}

function isWebhookEvidenceBasis(value) {
  return new Set([
    "prompt_hook", "session_hook", "tool_hook", "subagent_hook", "stop_hook", "root_span", "trace_span",
    "otel_event", "provider_metric", "span_db_replay", "usage_projection", "inactivity"
  ]).has(value);
}

function isWebhookCoverage(value) {
  return isRecord(value)
    && Object.keys(value).every((key) => ["usageCoverage", "activityCoverage", "costCoverage"].includes(key))
    && new Set(["none", "partial", "complete_so_far", "final"]).has(value.usageCoverage)
    && new Set(["none", "partial", "complete_for_reported_surface"]).has(value.activityCoverage)
    && isCostCoverage(value.costCoverage);
}

function isWebhookContextFootprint(value, requiredCoverage) {
  return isRecord(value)
    && Object.keys(value).every((key) => [
      "schemaVersion", "accumulatedInputTokens", "initialInputContextTokens", "latestInputContextTokens",
      "peakInputContextTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "observedLlmRequestCount",
      "contextGrowthInputTokens", "contextGrowthRatio", "basis", "coverage"
    ].includes(key))
    && value.schemaVersion === 1
    && isNonNegativeSafeInteger(value.accumulatedInputTokens)
    && (value.initialInputContextTokens == null || isNonNegativeSafeInteger(value.initialInputContextTokens))
    && (value.latestInputContextTokens == null || isNonNegativeSafeInteger(value.latestInputContextTokens))
    && (value.peakInputContextTokens == null || isNonNegativeSafeInteger(value.peakInputContextTokens))
    && isNonNegativeSafeInteger(value.cacheReadInputTokens)
    && isNonNegativeSafeInteger(value.cacheCreationInputTokens)
    && isNonNegativeSafeInteger(value.observedLlmRequestCount)
    && (value.contextGrowthInputTokens == null || isNonNegativeSafeInteger(value.contextGrowthInputTokens))
    && (value.contextGrowthRatio == null || (typeof value.contextGrowthRatio === "number" && Number.isFinite(value.contextGrowthRatio) && value.contextGrowthRatio >= 0))
    && new Set(["provider_reported_input_tokens", "derived_from_usage_atoms", "derived_from_execution_nodes", "unavailable"]).has(value.basis)
    && new Set(["none", "partial", "complete_so_far", "final"]).has(value.coverage)
    && (requiredCoverage == null || value.coverage === requiredCoverage);
}

function isWebhookActivityArray(value) {
  return Array.isArray(value) && value.every(isWebhookActivity);
}

function isWebhookActivity(value) {
  return isRecord(value)
    && Object.keys(value).every((key) => [
      "activityId", "parentActivityId", "kind", "name", "outcome", "count", "failureCount", "rejectedCount",
      "unknownCount", "startedAt", "endedAt", "durationMs", "resultSizeBytes", "providerReportedResultTokens",
      "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens",
      "totalTokens", "usageAttributionBasis", "usageCoverage", "evidence"
    ].includes(key))
    && isWebhookOpaqueId(value.activityId)
    && (value.parentActivityId == null || isWebhookOpaqueId(value.parentActivityId))
    && new Set(["llm_request", "tool", "subagent", "skill", "mcp", "hook", "unknown"]).has(value.kind)
    && isWebhookRuntime(value.name)
    && new Set(["success", "failure", "rejected", "unknown"]).has(value.outcome)
    && (value.count == null || isPositiveSafeInteger(value.count))
    && (value.failureCount == null || (
      isNonNegativeSafeInteger(value.failureCount)
      && isPositiveSafeInteger(value.count)
      && value.failureCount <= value.count
    ))
    && (value.rejectedCount == null || (
      isNonNegativeSafeInteger(value.rejectedCount)
      && isPositiveSafeInteger(value.count)
      && value.rejectedCount <= Number(value.failureCount ?? 0)
    ))
    && (value.unknownCount == null || (
      isNonNegativeSafeInteger(value.unknownCount)
      && isPositiveSafeInteger(value.count)
      && value.unknownCount <= value.count
      && Number(value.failureCount ?? 0) + value.unknownCount <= value.count
    ))
    && isTimestamp(value.startedAt)
    && (value.endedAt == null || (isTimestamp(value.endedAt) && value.endedAt >= value.startedAt))
    && (value.durationMs == null || isNonNegativeSafeInteger(value.durationMs))
    && (value.resultSizeBytes == null || isNonNegativeSafeInteger(value.resultSizeBytes))
    && (value.providerReportedResultTokens == null || isNonNegativeSafeInteger(value.providerReportedResultTokens))
    && (value.inputTokens == null || isNonNegativeSafeInteger(value.inputTokens))
    && (value.outputTokens == null || isNonNegativeSafeInteger(value.outputTokens))
    && (value.cacheReadInputTokens == null || isNonNegativeSafeInteger(value.cacheReadInputTokens))
    && (value.cacheCreationInputTokens == null || isNonNegativeSafeInteger(value.cacheCreationInputTokens))
    && (value.reasoningOutputTokens == null || isNonNegativeSafeInteger(value.reasoningOutputTokens))
    && (value.totalTokens == null || isNonNegativeSafeInteger(value.totalTokens))
    && (value.totalTokens == null || (value.inputTokens == null && value.outputTokens == null)
      || value.totalTokens === (value.inputTokens ?? 0) + (value.outputTokens ?? 0))
    && (value.usageAttributionBasis == null || new Set([
      "provider_reported", "trace_descendant", "activity_only", "unavailable"
    ]).has(value.usageAttributionBasis))
    && (value.usageCoverage == null || new Set(["complete", "partial", "unavailable"]).has(value.usageCoverage))
    && isWebhookEvidence(value.evidence);
}

function webhookActivityConservesUsage(activity, run) {
  if (!Array.isArray(activity) || !isRecord(run)) return false;
  return [
    "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens", "totalTokens"
  ].every((field) => activity.reduce((sum, item) => {
    const value = isRecord(item) ? item[field] : undefined;
    return sum + (isNonNegativeSafeInteger(value) ? value : 0);
  }, 0) === run[field]);
}

function isWebhookIdArray(value) {
  return Array.isArray(value) && value.every(isWebhookOpaqueId);
}

function isWebhookStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 200 && !/[\r\n\t]/.test(item));
}

function isWebhookSender(value) {
  return isRecord(value)
    && Object.keys(value).every((key) => ["installationId", "name", "team", "imageUrl"].includes(key))
    && isWebhookOpaqueId(value.installationId)
    && (value.name == null || isWebhookSenderText(value.name))
    && (value.team == null || isWebhookSenderText(value.team))
    && (value.imageUrl == null || isWebhookImageUrl(value.imageUrl));
}

function isWebhookSenderText(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\r\n\t]/.test(value);
}

function isWebhookImageUrl(value) {
  if (typeof value !== "string" || value.length > 2_000 || /[\r\n\t]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isWebhookRepository(value) {
  return isRecord(value)
    && Object.keys(value).every((key) => ["repoKey", "owner", "name", "fullName"].includes(key))
    && isWebhookOpaqueId(value.repoKey)
    && isRepositoryNamePart(value.owner)
    && isRepositoryNamePart(value.name)
    && isRepositoryFullName(value.fullName);
}

function isRepositoryNamePart(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && /^[A-Za-z0-9_. -]+$/.test(value);
}

function isRepositoryFullName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 401
    && /^[A-Za-z0-9_. /-]+$/.test(value) && value.includes("/");
}

function isRepoRelativePathArray(value) {
  return Array.isArray(value) && value.every(isRepoRelativePath);
}

function isRepoRelativePath(value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 1_000 || /[\r\n\t]/.test(value)) return false;
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/")
    && !normalized.startsWith("../")
    && !normalized.includes("/../")
    && normalized !== ".."
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !isAbsolute(value)
    && normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPermittedTerminalUsageCoverage(usageCoverage, evidence, outcome, terminal) {
  if (usageCoverage === "final") return true;
  if (
    new Set(["none", "partial", "complete_so_far"]).has(usageCoverage)
    && isExplicitTerminalWebhookEvidence(evidence)
  ) {
    return true;
  }
  return usageCoverage === "none"
    && isCompletionOutcome(outcome)
    && isDelayedOutcomeTerminalWebhookEvidence(evidence)
    && isZeroUsageTerminal(terminal);
}

function isExplicitTerminalWebhookEvidence(value) {
  return isRecord(value) && value.delayed === false && value.identityConfidence === "high"
    && value.timingConfidence === "high" && new Set(["stop_hook", "session_hook", "root_span", "otel_event"]).has(value.basis);
}

function isDelayedOutcomeTerminalWebhookEvidence(value) {
  return isRecord(value) && value.delayed === true && value.identityConfidence === "high"
    && value.timingConfidence === "high" && new Set(["stop_hook", "session_hook", "root_span", "otel_event"]).has(value.basis);
}

function isZeroUsageTerminal(value) {
  return isRecord(value)
    && value.inputTokens === 0 && value.outputTokens === 0 && value.cacheReadInputTokens === 0
    && value.cacheCreationInputTokens === 0 && value.reasoningOutputTokens === 0 && value.totalTokens === 0
    && Array.isArray(value.llmModels) && value.llmModels.length === 0;
}

function isCompletionOutcome(value) {
  return value === "success" || value === "failure" || value === "unknown";
}

function isCostEstimateBasis(value) {
  return value === "catalog_estimate" || value === "provider_reported_estimate" || value === "unavailable";
}

function isCostCoverage(value) {
  return value === "complete" || value === "partial" || value === "unavailable";
}

function isPositiveSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCc15cUpdateActivityClaimSet(value, llmModels) {
  return Array.isArray(value)
    && value.length <= 128
    && value.every((entry) => isCc15cActivityClaim(entry, false, llmModels));
}

function isCc15cTerminalActivityClaimSet(value, llmModels) {
  return Array.isArray(value)
    && value.length <= 128
    && value.every((entry) => isCc15cActivityClaim(entry, true, llmModels));
}

function isCc15cActivityClaim(activity, allowRejectedWrite, llmModels) {
  if (!isWebhookActivity(activity)) return false;
  if (activity.kind === "llm_request") return isCc15cLlmRequestClaim(activity, llmModels);
  if (activity.kind === "unknown" && activity.name === "Unallocated run usage") {
    return activity.outcome === "unknown"
      && (activity.count ?? 1) === 1
      && (activity.failureCount ?? 0) === 0
      && (activity.rejectedCount ?? 0) === 0
      && !hasOwn(activity, "resultSizeBytes")
      && !hasOwn(activity, "providerReportedResultTokens");
  }
  if (activity.kind !== "tool" || normalizedToken(activity.name) !== "write") return false;
  if (activity.outcome !== "unknown" && (!allowRejectedWrite || activity.outcome !== "rejected")) return false;
  if ((activity.count ?? 1) !== 1) return false;
  if (activity.outcome === "unknown" && (
    (activity.failureCount ?? 0) !== 0 || (activity.rejectedCount ?? 0) !== 0
  )) {
    return false;
  }
  if (activity.outcome === "rejected" && (
    activity.failureCount !== 1 || activity.rejectedCount !== 1
  )) {
    return false;
  }
  return REJECTED_WRITE_EXECUTION_FIELDS.every((field) => !hasOwn(activity, field));
}

// CC15C permits ordinary model-accounting rows, but they must not become a
// second channel for claiming a tool execution.  The sender's public model
// list is the only admissible semantic binding for a model-named row; the two
// generic request names cover providers that omit the model.  Tool-result
// measurements are intentionally never accepted on an LLM row in this
// one-Write denial probe.
function isCc15cLlmRequestClaim(activity, llmModels) {
  const name = normalizedToken(activity.name);
  const advertisedModels = new Set(
    (Array.isArray(llmModels) ? llmModels : [])
      .map((model) => normalizedToken(model))
      .filter(Boolean)
  );
  const generic = new Set(["llmrequest", "claudecodellmrequest", "request", "claudecoderequest"]).has(name);
  const toolShaped = new Set([
    "write", "edit", "bash", "read", "glob", "grep", "task", "agent",
    "mcp", "skill", "websearch", "webfetch", "notebookedit"
  ]).has(name);
  return !toolShaped
    && (generic || advertisedModels.has(name))
    && !hasOwn(activity, "resultSizeBytes")
    && !hasOwn(activity, "providerReportedResultTokens");
}

function hasOwn(value, key) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function hasForbiddenPayloadShape(payload, privacyCanary) {
  const forbidden = new Set([
    "prompt", "prompttext", "response", "responsetext", "toolarguments", "toolresults",
    "filecontents", "diff", "absolutepath", "rawtelemetry", "executiontree", "arguments", "output"
  ]);
  const stack = [payload];
  let visited = 0;
  while (stack.length > 0 && visited < 20_000) {
    const current = stack.pop();
    visited += 1;
    if (typeof current === "string") {
      if (privacyCanary && current.includes(privacyCanary)) return true;
      continue;
    }
    if (!isRecord(current) && !Array.isArray(current)) continue;
    if (Array.isArray(current)) {
      for (const value of current) stack.push(value);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (forbidden.has(key.toLowerCase().replace(/[^a-z]/g, ""))) return true;
      if (privacyCanary && key.includes(privacyCanary)) return true;
      stack.push(value);
    }
  }
  return visited >= 20_000;
}

function hasExecutionGrant(activity) {
  return [
    activity.durationMs,
    activity.resultSizeBytes,
    activity.providerReportedResultTokens,
    activity.inputTokens,
    activity.outputTokens,
    activity.cacheReadInputTokens,
    activity.cacheCreationInputTokens,
    activity.reasoningOutputTokens,
    activity.totalTokens
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function isValidActivityEvidence(evidence) {
  return isRecord(evidence)
    && new Set([
      "prompt_hook", "session_hook", "tool_hook", "subagent_hook", "stop_hook", "root_span", "trace_span",
      "otel_event", "provider_metric", "span_db_replay", "usage_projection", "inactivity"
    ]).has(evidence.basis);
}

function safeRepositoryFingerprint(repository) {
  if (!isRecord(repository)) return undefined;
  const key = safeOpaqueId(repository.repoKey);
  return key ? `repo:${key}` : undefined;
}

function safeOpaqueId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,512}$/.test(value) ? value : undefined;
}

function opaqueIdentityDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function safeEpochMilliseconds(value) {
  if (!safeIso(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

function defaultMonotonicNow() {
  return performance.now();
}

function safeMonotonicMilliseconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function deliveryWithinCorrectionWindow(firstReceiptMilliseconds, receivedMilliseconds) {
  return typeof firstReceiptMilliseconds === "number"
    && Number.isFinite(firstReceiptMilliseconds)
    && typeof receivedMilliseconds === "number"
    && Number.isFinite(receivedMilliseconds)
    && receivedMilliseconds >= firstReceiptMilliseconds
    && receivedMilliseconds - firstReceiptMilliseconds <= CORRECTION_WINDOW_MS;
}

function safeVersion(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 10_000 ? value : undefined;
}

function safeCount(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : fallback;
}

function normalizedToken(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function bearerToken(value) {
  const header = singleHeader(value);
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function requireSecret(value, field) {
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requireWebhookSessionId(value, field) {
  if (typeof value !== "string" || !/^ses_[a-f0-9]{64}$/.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requirePrivacyCanary(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{8,128}$/.test(value)) {
    throw new Error("invalid_privacy_canary");
  }
  return value;
}

function containsCanary(body, canary) {
  return Buffer.isBuffer(body) && Buffer.isBuffer(canary) && canary.length > 0 && body.indexOf(canary) >= 0;
}

function constantTimeMatch(value, expected) {
  const actual = singleHeader(value);
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  try {
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  } finally {
    zeroBuffer(actualBytes);
    zeroBuffer(expectedBytes);
  }
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function readBoundedBody(request, limitBytes) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limitBytes) throw new Error("payload_too_large");
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limitBytes) {
        zeroBuffer(bytes);
        throw new Error("payload_too_large");
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) zeroBuffer(chunk);
  }
}

function parseObjectJson(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
  if (!isRecord(parsed)) throw new Error("invalid_json");
  return parsed;
}

function boundedPort(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error("invalid_port");
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroBuffer(value) {
  if (Buffer.isBuffer(value)) value.fill(0);
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function listenLoopback(server, port) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

async function closeServer(server) {
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function main() {
  const receiver = await startClaudeDelayedDecisionReceiver({
    deliveryToken: process.env.TIRION_CC15C_RECEIVER_TOKEN ?? "",
    hmacSecret: process.env.TIRION_CC15C_RECEIVER_HMAC_SECRET ?? "",
    controlToken: process.env.TIRION_CC15C_RECEIVER_CONTROL_TOKEN ?? "",
    expectedSessionId: process.env.TIRION_CC15C_EXPECTED_WEBHOOK_SESSION_ID,
    privacyCanary: process.env.TIRION_CC15C_PRIVACY_CANARY,
    port: process.env.TIRION_CC15C_RECEIVER_PORT == null ? 0 : Number(process.env.TIRION_CC15C_RECEIVER_PORT)
  });
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ready: true, port: receiver.port })}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await receiver.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.stderr.write("claude_delayed_decision_receiver_failed\n");
    process.exitCode = 1;
  });
}
