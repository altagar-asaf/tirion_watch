#!/usr/bin/env node
/**
 * Test-only loopback relay for the Claude Code delayed-native-decision
 * acceptance probe.
 *
 * It forwards Claude OTLP and provider-hook traffic to a local Tirion agent,
 * returns a controlled PreToolUse Write denial, and holds exactly one matching
 * native rejected `tool_decision` log record in memory until an authenticated
 * local control request releases it.  It never writes request data to disk or
 * stdout/stderr.  Its status endpoint exposes only bounded counters.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CLAUDE_DELAY_RELAY_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
// A real Claude turn can finish its model response after it emits the native
// decision.  Keep the test-only, in-memory hold comfortably longer than that
// gap; the shell releases it immediately after the baseline terminal arrives.
export const CLAUDE_DELAY_RELAY_DEFAULT_HOLD_MS = 60_000;
export const CLAUDE_DELAY_RELAY_MAX_HOLD_MS = 300_000;
const FORWARD_RESPONSE_LIMIT_BYTES = 64 * 1024;
const RELAY_REJECTION_REASONS = [
  "control_auth",
  "ingress_sealed",
  "unsupported_path",
  "unsupported_metrics_request",
  "ingress_auth",
  "relay_auth",
  "content_type",
  "empty_log_payload",
  "duplicate_native_rejection",
  "native_rejection_binding",
  "target_log_unavailable",
  "target_log_rate_limited",
  "target_log_4xx",
  "target_log_5xx",
  "target_log_unexpected",
  "target_trace_unavailable",
  "target_trace_rate_limited",
  "target_trace_4xx",
  "target_trace_5xx",
  "target_trace_unexpected",
  "hook_event_mismatch",
  "target_hook_unavailable",
  "target_hook_rate_limited",
  "target_hook_4xx",
  "target_hook_5xx",
  "target_hook_unexpected",
  "invalid_request"
];
const NATIVE_BINDING_FAILURE_REASONS = [
  "expected_session_missing",
  "native_session_missing",
  "native_source_time_missing",
  "native_expected_session_mismatch",
  "targeted_pretool_write_cardinality",
  "denied_tool_identity_missing",
  "submission_session_missing",
  "expected_session_unbound",
  "native_tool_identity_mismatch",
  "native_submission_session_mismatch"
];

/**
 * @typedef {Object} ClaudeDelayedDecisionRelayOptions
 * @property {string} targetBaseUrl
 * @property {string} ingressToken
 * @property {string} relayToken
 * @property {string} controlToken
 * @property {string=} expectedSessionDigest
 * @property {number=} port
 * @property {number=} holdMs
 * @property {number=} bodyLimitBytes
 * @property {(() => Promise<void>)=} testBeforeForward Test-only deterministic in-flight gate.
 */

/**
 * Start a loopback-only test relay.  This is exported so its privacy and
 * forwarding boundaries can be exercised without an authenticated Claude run.
 *
 * @param {ClaudeDelayedDecisionRelayOptions} options
 */
export async function startClaudeDelayedDecisionRelay(options) {
  const target = parseLoopbackTarget(options.targetBaseUrl);
  const ingressToken = requireSecret(options.ingressToken, "ingress_token");
  const relayToken = requireSecret(options.relayToken, "relay_token");
  const controlToken = requireSecret(options.controlToken, "control_token");
  const expectedSessionDigest = options.expectedSessionDigest == null
    ? undefined
    : requireOpaqueDigest(options.expectedSessionDigest, "expected_session_digest");
  const holdMs = boundedPositiveInteger(
    options.holdMs,
    CLAUDE_DELAY_RELAY_DEFAULT_HOLD_MS,
    100,
    CLAUDE_DELAY_RELAY_MAX_HOLD_MS
  );
  const bodyLimitBytes = boundedPositiveInteger(
    options.bodyLimitBytes,
    CLAUDE_DELAY_RELAY_BODY_LIMIT_BYTES,
    1_024,
    CLAUDE_DELAY_RELAY_BODY_LIMIT_BYTES
  );
  const requestedPort = boundedPort(options.port ?? 0);
  if (options.testBeforeForward != null && typeof options.testBeforeForward !== "function") {
    throw new Error("invalid_test_before_forward");
  }
  const testBeforeForward = options.testBeforeForward;

  /** @type {{ body: Buffer, timer: NodeJS.Timeout, sourceTimestampNanoseconds: bigint, boundaryValidated: boolean } | undefined} */
  let heldDecision;
  /** @type {{ body: Buffer, timer: NodeJS.Timeout, sourceTimestampNanoseconds: bigint, identityDigest: string, sessionDigest: string | undefined } | undefined} */
  let pendingDecision;
  /** @type {string | undefined} */
  let deniedToolIdentityDigest;
  /** @type {string | undefined} */
  let submissionSessionDigest;
  /** @type {string | undefined} */
  let submissionPromptDigest;
  /** @type {{ startNanoseconds: bigint, endNanoseconds: bigint } | undefined} */
  let closedInteractionBoundary;
  let expectedSessionBound = false;
  let promptIdentityConflictFree = true;
  let promptIdentityObserved = false;
  let sourceBeforeClosedBoundary = false;
  let ingressSealed = false;
  let inFlightIngress = 0;
  let postSealIngressAttemptCount = 0;
  /** @type {(() => void)[]} */
  const ingressIdleWaiters = [];
  /** @type {"awaiting" | "held" | "released" | "expired" | "ambiguous"} */
  let decisionState = "awaiting";
  const counters = {
    forwardedLogRecordCount: 0,
    forwardedTraceRequestCount: 0,
    forwardedClosedRootTraceCount: 0,
    forwardedHookCount: 0,
    forwardedHookEvents: {
      userPromptSubmit: 0,
      preToolUse: 0,
      postToolUse: 0,
      postToolUseFailure: 0,
      stop: 0,
      stopFailure: 0
    },
    targetedPreToolWriteCount: 0,
    deniedPreToolUseCount: 0,
    boundNativeRejectionCount: 0,
    heldNativeRejectionCount: 0,
    releasedNativeRejectionCount: 0,
    expiredNativeRejectionCount: 0,
    rejectedRequestCount: 0,
    nativeBindingFailureReasons: Object.fromEntries(
      NATIVE_BINDING_FAILURE_REASONS.map((reason) => [reason, 0])
    ),
    rejectionReasons: Object.fromEntries(RELAY_REJECTION_REASONS.map((reason) => [reason, 0]))
  };

  /** @param {typeof RELAY_REJECTION_REASONS[number]} reason */
  const rejectRequest = (reason) => {
    if (!Object.hasOwn(counters.rejectionReasons, reason)) {
      throw new Error("invalid_rejection_reason");
    }
    counters.rejectedRequestCount += 1;
    counters.rejectionReasons[reason] += 1;
  };

  const clearHeldDecision = () => {
    if (!heldDecision) return;
    clearTimeout(heldDecision.timer);
    zeroBuffer(heldDecision.body);
    heldDecision = undefined;
  };

  const clearPendingDecision = () => {
    if (!pendingDecision) return;
    clearTimeout(pendingDecision.timer);
    zeroBuffer(pendingDecision.body);
    pendingDecision = undefined;
  };

  const expireHeldDecision = () => {
    if (!heldDecision) return;
    zeroBuffer(heldDecision.body);
    heldDecision = undefined;
    counters.expiredNativeRejectionCount += 1;
    deniedToolIdentityDigest = undefined;
    sourceBeforeClosedBoundary = false;
    decisionState = "expired";
  };

  const expirePendingDecision = () => {
    if (!pendingDecision) return;
    zeroBuffer(pendingDecision.body);
    pendingDecision = undefined;
    counters.expiredNativeRejectionCount += 1;
    deniedToolIdentityDigest = undefined;
    sourceBeforeClosedBoundary = false;
    decisionState = "expired";
  };

  const markAmbiguous = () => {
    clearHeldDecision();
    clearPendingDecision();
    deniedToolIdentityDigest = undefined;
    closedInteractionBoundary = undefined;
    sourceBeforeClosedBoundary = false;
    decisionState = "ambiguous";
  };

  const validateHeldDecisionBoundary = () => {
    if (!heldDecision || !closedInteractionBoundary) return;
    if (
      heldDecision.sourceTimestampNanoseconds < closedInteractionBoundary.startNanoseconds
      || heldDecision.sourceTimestampNanoseconds > closedInteractionBoundary.endNanoseconds
    ) {
      markAmbiguous();
      return;
    }
    heldDecision.boundaryValidated = true;
    sourceBeforeClosedBoundary = true;
  };

  // Claude prompt IDs are useful metadata-only diagnostics, but the program
  // has observed absent, mismatched, and duplicate IDs across native surfaces.
  // They must never override the authoritative fresh session, exact tool ID,
  // and source-time/root-boundary gates below.
  const observePromptIdentity = (promptDigest) => {
    if (!promptDigest) return;
    promptIdentityObserved = true;
    if (submissionPromptDigest && !constantTimeTextMatch(promptDigest, submissionPromptDigest)) {
      promptIdentityConflictFree = false;
    }
    submissionPromptDigest ??= promptDigest;
  };

  /** @param {{ boundaries: { startNanoseconds: bigint, endNanoseconds: bigint }[], malformed: boolean, promptDigests: string[] }} match */
  const acceptClosedInteractionBoundaries = (match) => {
    for (const promptDigest of match.promptDigests) observePromptIdentity(promptDigest);
    if (match.malformed) {
      markAmbiguous();
      return;
    }
    const { boundaries } = match;
    if (boundaries.length === 0) return;
    if (boundaries.length !== 1 || closedInteractionBoundary != null) {
      markAmbiguous();
      return;
    }
    closedInteractionBoundary = boundaries[0];
    validateHeldDecisionBoundary();
  };

  /** @param {string[]} reasons */
  const recordNativeBindingFailures = (reasons) => {
    if (reasons.length === 0) return;
    for (const reason of new Set(reasons)) {
      if (!Object.hasOwn(counters.nativeBindingFailureReasons, reason)) {
        throw new Error("invalid_native_binding_failure_reason");
      }
      counters.nativeBindingFailureReasons[reason] += 1;
    }
    rejectRequest("native_rejection_binding");
  };

  /** @param {{ sessionDigest: string | undefined, sourceTimestampNanoseconds: bigint | undefined }} decision */
  const staticNativeBindingFailures = (decision) => {
    const reasons = [];
    if (!expectedSessionDigest) reasons.push("expected_session_missing");
    if (!decision.sessionDigest) {
      reasons.push("native_session_missing");
    } else if (expectedSessionDigest && !constantTimeTextMatch(decision.sessionDigest, expectedSessionDigest)) {
      reasons.push("native_expected_session_mismatch");
    }
    if (decision.sourceTimestampNanoseconds == null) reasons.push("native_source_time_missing");
    return reasons;
  };

  /** @param {{ identityDigest: string, sessionDigest: string | undefined }} decision */
  const controlledNativeBindingFailures = (decision) => {
    const reasons = [];
    if (counters.targetedPreToolWriteCount !== 1) reasons.push("targeted_pretool_write_cardinality");
    if (!deniedToolIdentityDigest) reasons.push("denied_tool_identity_missing");
    if (!submissionSessionDigest) reasons.push("submission_session_missing");
    if (expectedSessionBound !== true) reasons.push("expected_session_unbound");
    if (
      deniedToolIdentityDigest
      && !constantTimeTextMatch(decision.identityDigest, deniedToolIdentityDigest)
    ) {
      reasons.push("native_tool_identity_mismatch");
    }
    if (
      decision.sessionDigest
      && submissionSessionDigest
      && !constantTimeTextMatch(decision.sessionDigest, submissionSessionDigest)
    ) {
      reasons.push("native_submission_session_mismatch");
    }
    return reasons;
  };

  const controlBindingReady = () => (
    counters.targetedPreToolWriteCount === 1
    && deniedToolIdentityDigest != null
    && submissionSessionDigest != null
    && expectedSessionBound === true
  );

  const promotePendingDecision = () => {
    if (!pendingDecision) return;
    const pending = pendingDecision;
    clearTimeout(pending.timer);
    pendingDecision = undefined;
    const timer = setTimeout(expireHeldDecision, holdMs);
    timer.unref?.();
    heldDecision = {
      body: pending.body,
      timer,
      sourceTimestampNanoseconds: pending.sourceTimestampNanoseconds,
      boundaryValidated: false
    };
    counters.heldNativeRejectionCount += 1;
    counters.boundNativeRejectionCount += 1;
    decisionState = "held";
    validateHeldDecisionBoundary();
  };

  /** @returns {"none" | "awaiting_control" | "held" | "rejected"} */
  const bindPendingDecisionIfReady = () => {
    if (!pendingDecision) return "none";
    const staticFailures = staticNativeBindingFailures(pendingDecision);
    if (staticFailures.length > 0) {
      recordNativeBindingFailures(staticFailures);
      markAmbiguous();
      return "rejected";
    }
    if (!controlBindingReady()) {
      if (counters.targetedPreToolWriteCount > 1) {
        recordNativeBindingFailures(["targeted_pretool_write_cardinality"]);
        markAmbiguous();
        return "rejected";
      }
      return "awaiting_control";
    }
    const controlledFailures = controlledNativeBindingFailures(pendingDecision);
    if (controlledFailures.length > 0) {
      recordNativeBindingFailures(controlledFailures);
      markAmbiguous();
      return "rejected";
    }
    promotePendingDecision();
    return decisionState === "held" ? "held" : "rejected";
  };

  const currentStatus = () => ({
    schemaVersion: 1,
    decisionState,
    heldNativeRejectionCount: heldDecision ? 1 : 0,
    pendingNativeRejectionCount: pendingDecision ? 1 : 0,
    forwardedLogRecordCount: counters.forwardedLogRecordCount,
    forwardedTraceRequestCount: counters.forwardedTraceRequestCount,
    forwardedClosedRootTraceCount: counters.forwardedClosedRootTraceCount,
    expectedSessionBound,
    promptIdentityConflictFree,
    promptIdentityObserved,
    sourceBeforeClosedBoundary,
    ingressSealed,
    inFlightIngress,
    postSealIngressAttemptCount,
    forwardedHookCount: counters.forwardedHookCount,
    forwardedHookEvents: { ...counters.forwardedHookEvents },
    targetedPreToolWriteCount: counters.targetedPreToolWriteCount,
    deniedPreToolUseCount: counters.deniedPreToolUseCount,
    boundNativeRejectionCount: counters.boundNativeRejectionCount,
    releasedNativeRejectionCount: counters.releasedNativeRejectionCount,
    expiredNativeRejectionCount: counters.expiredNativeRejectionCount,
    rejectedRequestCount: counters.rejectedRequestCount,
    nativeBindingFailureReasons: { ...counters.nativeBindingFailureReasons },
    rejectionReasons: { ...counters.rejectionReasons }
  });

  const waitForIngressIdle = async () => {
    if (inFlightIngress === 0) return;
    await new Promise((resolvePromise) => ingressIdleWaiters.push(resolvePromise));
  };

  const finishIngress = () => {
    inFlightIngress = Math.max(0, inFlightIngress - 1);
    if (inFlightIngress === 0) {
      for (const resolvePromise of ingressIdleWaiters.splice(0)) resolvePromise();
    }
  };

  /**
   * @param {string} path
   * @param {Buffer} body
   * @param {string=} hookEventName
   */
  const forwardToTarget = async (path, body, hookEventName) => {
    // This hook is only accepted by the exported local self-test surface. It
    // lets the regression prove that sealing waits for a real pre-seal forward
    // without recording request contents or relying on timing luck.
    await testBeforeForward?.();
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${ingressToken}`
    };
    if (hookEventName) {
      headers["x-tirion-hook-surface"] = "claude-code";
      headers["x-tirion-hook-event"] = hookEventName;
    }
    try {
      const response = await fetch(new URL(path, target), {
        method: "POST",
        headers,
        body,
        redirect: "error"
      });
      const responseBody = await readBoundedResponse(response, FORWARD_RESPONSE_LIMIT_BYTES);
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: responseBody
      };
    } catch {
      // Preserve only an identifier-free availability class. Network errors and
      // response bodies must never reach status or shell output.
      return { status: 0, contentType: "application/json", body: Buffer.alloc(0) };
    }
  };

  /** @param {Buffer} body */
  const forwardLogRecord = async (body) => {
    const result = await forwardToTarget("/v1/logs", body);
    try {
      return {
        accepted: result.status >= 200 && result.status < 300,
        rejectionReason: result.status >= 200 && result.status < 300
          ? undefined
          : targetForwardRejectionReason("log", result.status)
      };
    } finally {
      zeroBuffer(result.body);
    }
  };

  const server = createServer(async (request, response) => {
    let countedIngress = false;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/control/")) {
        if (!constantTimeSecretMatch(request.headers["x-tirion-relay-control"], controlToken)) {
          rejectRequest("control_auth");
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (request.method === "GET" && url.pathname === "/control/status") {
          sendJson(response, 200, currentStatus());
          return;
        }
        if (request.method === "POST" && url.pathname === "/control/seal") {
          ingressSealed = true;
          await waitForIngressIdle();
          sendJson(response, 200, currentStatus());
          return;
        }
        if (request.method === "POST" && url.pathname === "/control/release") {
          if (!heldDecision || heldDecision.boundaryValidated !== true || !sourceBeforeClosedBoundary) {
            markAmbiguous();
            sendJson(response, 409, { error: "no_held_native_rejection" });
            return;
          }
          const pending = heldDecision;
          try {
            const forwarded = await forwardLogRecord(pending.body);
            if (!forwarded.accepted) {
              sendJson(response, 502, { error: "target_rejected_held_native_rejection" });
              return;
            }
            clearTimeout(pending.timer);
            zeroBuffer(pending.body);
            heldDecision = undefined;
            deniedToolIdentityDigest = undefined;
            counters.releasedNativeRejectionCount += 1;
            decisionState = "released";
            sendJson(response, 200, currentStatus());
          } catch {
            sendJson(response, 502, { error: "target_unavailable" });
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/control/shutdown") {
          clearHeldDecision();
          clearPendingDecision();
          sendJson(response, 200, { status: "shutting_down" });
          setImmediate(() => server.close());
          return;
        }
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      countedIngress = true;
      inFlightIngress += 1;
      if (ingressSealed) {
        rejectRequest("ingress_sealed");
        postSealIngressAttemptCount += 1;
        sendJson(response, 409, { error: "relay_ingress_sealed" });
        return;
      }
      const supportedPath = url.pathname === "/v1/logs"
        || url.pathname === "/v1/traces"
        || url.pathname === "/v1/provider-hooks/claude-code";
      if (request.method !== "POST" || !supportedPath) {
        rejectRequest(unsupportedIngressRejectionReason(url.pathname));
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (!constantTimeSecretMatch(bearerToken(request.headers.authorization), ingressToken)) {
        rejectRequest("ingress_auth");
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!constantTimeSecretMatch(request.headers["x-tirion-cc15c-relay"], relayToken)) {
        rejectRequest("relay_auth");
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!isJsonContentType(request.headers["content-type"])) {
        rejectRequest("content_type");
        sendJson(response, 415, { error: "json_required" });
        return;
      }

      const body = await readBoundedBody(request, bodyLimitBytes);
      try {
        const payload = parseObjectJson(body);
        if (url.pathname === "/v1/logs") {
          const records = splitLogRecords(payload, bodyLimitBytes);
          try {
            if (records.length === 0) {
              rejectRequest("empty_log_payload");
              sendJson(response, 422, { error: "no_log_records" });
              return;
            }
            const delayed = records.flatMap((record) => {
              const decision = rejectedClaudeWriteDecision(record.sourceRecord, record.resourceAttributes);
              return decision ? [{ record, ...decision, identityDigest: opaqueIdentityDigest(decision.toolUseId) }] : [];
            });
            if (
              delayed.length > 1
              || (delayed.length === 1 && (heldDecision || pendingDecision || decisionState !== "awaiting"))
            ) {
              rejectRequest("duplicate_native_rejection");
              markAmbiguous();
              sendJson(response, 409, { error: "ambiguous_native_rejection" });
              return;
            }
            for (const record of records) {
              if (record === delayed[0]?.record) continue;
              const forwarded = await forwardLogRecord(record.body);
              if (!forwarded.accepted) {
                rejectRequest(forwarded.rejectionReason);
                sendJson(response, 502, { error: "target_rejected_log" });
                return;
              }
              counters.forwardedLogRecordCount += 1;
            }
            if (delayed[0]) {
              observePromptIdentity(delayed[0].promptDigest);
              const staticFailures = staticNativeBindingFailures(delayed[0]);
              if (staticFailures.length > 0) {
                recordNativeBindingFailures(staticFailures);
                markAmbiguous();
                sendJson(response, 409, { error: "native_rejection_not_bound" });
                return;
              }
              const timer = setTimeout(expirePendingDecision, holdMs);
              timer.unref?.();
              pendingDecision = {
                body: delayed[0].record.body,
                timer,
                sourceTimestampNanoseconds: delayed[0].sourceTimestampNanoseconds,
                identityDigest: delayed[0].identityDigest,
                sessionDigest: delayed[0].sessionDigest
              };
              // An OTLP exporter can beat independently delivered provider
              // hooks. Retain one bounded candidate only, then require the
              // exact controlled session/tool denial before it becomes held.
              if (bindPendingDecisionIfReady() === "rejected") {
                sendJson(response, 409, { error: "native_rejection_not_bound" });
                return;
              }
            }
            sendJson(response, 200, { partialSuccess: {} });
            return;
          } finally {
            const retained = heldDecision?.body ?? pendingDecision?.body;
            for (const record of records) {
              if (record.body !== retained) zeroBuffer(record.body);
            }
          }
        }

        if (url.pathname === "/v1/traces") {
          const closedInteractionMatch = matchingClaudeClosedInteractionBoundaries(
            payload,
            expectedSessionDigest,
            submissionSessionDigest
          );
          const forwarded = await forwardToTarget("/v1/traces", body);
          try {
            if (forwarded.status < 200 || forwarded.status >= 300) {
              rejectRequest(targetForwardRejectionReason("trace", forwarded.status));
              sendJson(response, 502, { error: "target_rejected_trace" });
              return;
            }
          } finally {
            zeroBuffer(forwarded.body);
          }
          counters.forwardedTraceRequestCount += 1;
          counters.forwardedClosedRootTraceCount += closedInteractionMatch.boundaries.length;
          acceptClosedInteractionBoundaries(closedInteractionMatch);
          sendJson(response, 200, { partialSuccess: {} });
          return;
        }

        const hookEventName = safeHookEventName(payload.hook_event_name);
        if (!hookEventName || !constantTimeTextMatch(request.headers["x-tirion-hook-event"], hookEventName)) {
          rejectRequest("hook_event_mismatch");
          sendJson(response, 422, { error: "hook_event_mismatch" });
          return;
        }
        const forwarded = await forwardToTarget("/v1/provider-hooks/claude-code", body, hookEventName);
        if (forwarded.status < 200 || forwarded.status >= 300) {
          zeroBuffer(forwarded.body);
          rejectRequest(targetForwardRejectionReason("hook", forwarded.status));
          sendJson(response, 502, { error: "target_rejected_hook" });
          return;
        }
        counters.forwardedHookCount += 1;
        const hookCounter = hookCounterKey(hookEventName);
        if (hookCounter) {
          counters.forwardedHookEvents[hookCounter] += 1;
        }
        if (hookEventName === "UserPromptSubmit") {
          const sessionDigest = hookSessionIdentityDigest(payload);
          const promptDigest = hookPromptIdentityDigest(payload);
          observePromptIdentity(promptDigest);
          if (
            !sessionDigest
            || submissionSessionDigest
            || !expectedSessionDigest
            || !constantTimeTextMatch(sessionDigest, expectedSessionDigest)
          ) {
            markAmbiguous();
          } else {
            submissionSessionDigest = sessionDigest;
            expectedSessionBound = true;
            bindPendingDecisionIfReady();
          }
        }
        if (isTargetedPreToolWrite(payload, hookEventName)) {
          counters.targetedPreToolWriteCount += 1;
          const toolIdentityDigest = hookToolUseIdentityDigest(payload);
          const sessionDigest = hookSessionIdentityDigest(payload);
          const promptDigest = hookPromptIdentityDigest(payload);
          observePromptIdentity(promptDigest);
          zeroBuffer(forwarded.body);
          if (
            counters.targetedPreToolWriteCount !== 1
            || !toolIdentityDigest
            || !sessionDigest
            || !submissionSessionDigest
            || expectedSessionBound !== true
            || !expectedSessionDigest
            || !constantTimeTextMatch(sessionDigest, submissionSessionDigest)
            || !constantTimeTextMatch(sessionDigest, expectedSessionDigest)
            || deniedToolIdentityDigest
            || decisionState !== "awaiting"
          ) {
            markAmbiguous();
            sendJson(response, 200, {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "Controlled Tirion acceptance denial"
              }
            });
            return;
          }
          deniedToolIdentityDigest = toolIdentityDigest;
          counters.deniedPreToolUseCount += 1;
          bindPendingDecisionIfReady();
          sendJson(response, 200, {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Controlled Tirion acceptance denial"
            }
          });
          return;
        }
        if (hookEventName === "Stop") {
          const sessionDigest = hookSessionIdentityDigest(payload);
          const promptDigest = hookPromptIdentityDigest(payload);
          observePromptIdentity(promptDigest);
          if (
            !sessionDigest
            || !submissionSessionDigest
            || expectedSessionBound !== true
            || !expectedSessionDigest
            || !constantTimeTextMatch(sessionDigest, submissionSessionDigest)
            || !constantTimeTextMatch(sessionDigest, expectedSessionDigest)
          ) {
            markAmbiguous();
          }
        }
        sendRawJson(response, 200, forwarded.body);
      } finally {
        zeroBuffer(body);
      }
    } catch {
      rejectRequest("invalid_request");
      sendJson(response, 400, { error: "invalid_request" });
    } finally {
      if (countedIngress) finishIngress();
    }
  });

  await listenLoopback(server, requestedPort);
  const address = server.address();
  if (!address || typeof address === "string") {
    clearHeldDecision();
    await closeServer(server);
    throw new Error("relay_listen_failed");
  }

  let closed = false;
  return {
    port: address.port,
    status: currentStatus,
    async close() {
      if (closed) return;
      closed = true;
      clearHeldDecision();
      clearPendingDecision();
      await closeServer(server);
    }
  };
}

function parseLoopbackTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error("invalid_target");
  }
  if (
    target.protocol !== "http:"
    || !isLoopbackHost(target.hostname)
    || target.username.length > 0
    || target.password.length > 0
  ) {
    throw new Error("target_must_be_loopback_http");
  }
  target.pathname = "/";
  target.search = "";
  target.hash = "";
  return target;
}

function isLoopbackHost(host) {
  const normalized = host.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function requireSecret(value, field) {
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function requireOpaqueDigest(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function boundedPositiveInteger(value, fallback, minimum, maximum) {
  if (value == null) return fallback;
  const candidate = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error("invalid_numeric_option");
  }
  return candidate;
}

function boundedPort(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("invalid_port");
  }
  return value;
}

function bearerToken(value) {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length);
}

function constantTimeSecretMatch(value, expected) {
  return typeof value === "string" && constantTimeTextMatch(value, expected);
}

function constantTimeTextMatch(value, expected) {
  const actual = Array.isArray(value) ? value[0] : value;
  if (typeof actual !== "string") return false;
  const length = Math.max(actual.length, expected.length);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isJsonContentType(value) {
  const contentType = Array.isArray(value) ? value[0] : value;
  return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function readBoundedBody(request, limitBytes) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new Error("payload_too_large");
  }
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

async function readBoundedResponse(response, limitBytes) {
  const chunks = [];
  let size = 0;
  try {
    if (!response.body) return Buffer.alloc(0);
    for await (const chunk of response.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limitBytes) {
        zeroBuffer(bytes);
        throw new Error("forward_response_too_large");
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
  if (!isRecord(parsed)) {
    throw new Error("invalid_json");
  }
  return parsed;
}

function splitLogRecords(payload, limitBytes) {
  if (!Array.isArray(payload.resourceLogs)) {
    throw new Error("invalid_log_payload");
  }
  const result = [];
  try {
    for (const resourceLog of payload.resourceLogs) {
      if (!isRecord(resourceLog) || !Array.isArray(resourceLog.scopeLogs)) {
        throw new Error("invalid_log_payload");
      }
      const { scopeLogs, ...resourceEnvelope } = resourceLog;
      const resourceAttributes = otlpAttributes(
        isRecord(resourceLog.resource) ? resourceLog.resource.attributes : undefined
      );
      for (const scopeLog of scopeLogs) {
        if (!isRecord(scopeLog) || !Array.isArray(scopeLog.logRecords)) {
          throw new Error("invalid_log_payload");
        }
        const { logRecords, ...scopeEnvelope } = scopeLog;
        for (const sourceRecord of logRecords) {
          if (!isRecord(sourceRecord)) {
            throw new Error("invalid_log_payload");
          }
          const body = Buffer.from(JSON.stringify({
            resourceLogs: [{
              ...resourceEnvelope,
              scopeLogs: [{
                ...scopeEnvelope,
                logRecords: [sourceRecord]
              }]
            }]
          }));
          if (body.length > limitBytes) {
            zeroBuffer(body);
            throw new Error("payload_too_large");
          }
          result.push({ sourceRecord, resourceAttributes, body });
        }
      }
    }
    return result;
  } catch (error) {
    for (const record of result) zeroBuffer(record.body);
    throw error;
  }
}

function rejectedClaudeWriteDecision(record, resourceAttributes) {
  const attributes = { ...resourceAttributes, ...otlpAttributes(record.attributes) };
  const eventName = normalizedToken(attributes["event.name"] ?? otlpPrimitive(record.body));
  const decision = normalizedToken(attributes.decision);
  const toolName = normalizedToken(attributes["gen_ai.tool.name"] ?? attributes["tool.name"] ?? attributes.tool_name);
  const toolUseId = safeOpaqueIdentity(
    attributes.tool_use_id
    ?? attributes["tool.use.id"]
    ?? attributes["gen_ai.tool.call.id"]
    ?? attributes["tool.call.id"]
  );
  if (
    (eventName === "claude_code.tool_decision" || eventName === "tool_decision")
    && decision === "reject"
    && toolName === "write"
    && toolUseId
  ) {
    const session = safeOpaqueIdentity(
      attributes["session.id"] ?? attributes.session_id ?? attributes["gen_ai.conversation.id"]
    );
    const prompt = safeOpaqueIdentity(attributes["prompt.id"] ?? attributes.prompt_id);
    return {
      toolUseId,
      sessionDigest: session ? opaqueIdentityDigest(session) : undefined,
      promptDigest: prompt ? opaqueIdentityDigest(prompt) : undefined,
      sourceTimestampNanoseconds: sourceTimestampNanoseconds(record, attributes)
    };
  }
  return undefined;
}

function sourceTimestampNanoseconds(record, attributes) {
  const candidate = attributes["event.timestamp"]
    ?? record.startTimeUnixNano
    ?? record.timeUnixNano;
  if (typeof candidate !== "string") return undefined;
  if (/^[1-9][0-9]{0,19}$/.test(candidate)) {
    try {
      return BigInt(candidate);
    } catch {
      return undefined;
    }
  }
  return rfc3339TimestampNanoseconds(candidate);
}

function rfc3339TimestampNanoseconds(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return undefined;

  // Validate the whole-second portion without ever parsing (and truncating)
  // the fractional component.  The canonical round trip rejects normalized
  // invalid dates such as 2025-02-30 or 24:00:00.
  const wholeSecond = `${match[1]}.000Z`;
  const milliseconds = Date.parse(wholeSecond);
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
    || new Date(milliseconds).toISOString() !== wholeSecond
  ) {
    return undefined;
  }
  try {
    const fractionalNanoseconds = BigInt((match[2] ?? "").padEnd(9, "0"));
    return BigInt(milliseconds) * 1_000_000n + fractionalNanoseconds;
  } catch {
    return undefined;
  }
}

function otlpAttributes(value) {
  if (!Array.isArray(value)) return {};
  const attributes = {};
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== "string" || !isRecord(item.value)) continue;
    const parsed = otlpPrimitive(item.value);
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
      attributes[item.key] = parsed;
    }
  }
  return attributes;
}

function otlpPrimitive(value) {
  if (!isRecord(value)) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.intValue === "string" || typeof value.intValue === "number") return String(value.intValue);
  if (typeof value.doubleValue === "number") return value.doubleValue;
  return undefined;
}

function normalizedToken(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9_.]/g, "_") : "";
}

function safeOpaqueIdentity(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,512}$/.test(value) ? value : undefined;
}

function opaqueIdentityDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hookToolUseIdentityDigest(payload) {
  if (!isRecord(payload)) return undefined;
  const toolUseId = safeOpaqueIdentity(payload.tool_use_id ?? payload.toolUseId);
  return toolUseId ? opaqueIdentityDigest(toolUseId) : undefined;
}

function hookSessionIdentityDigest(payload) {
  if (!isRecord(payload)) return undefined;
  const session = safeOpaqueIdentity(payload.session_id ?? payload.sessionId);
  return session ? opaqueIdentityDigest(session) : undefined;
}

function hookPromptIdentityDigest(payload) {
  if (!isRecord(payload)) return undefined;
  const prompt = safeOpaqueIdentity(payload.prompt_id ?? payload.promptId);
  return prompt ? opaqueIdentityDigest(prompt) : undefined;
}

function matchingClaudeClosedInteractionBoundaries(
  payload,
  expectedSessionDigest,
  submissionSessionDigest
) {
  const match = { boundaries: [], malformed: false, promptDigests: [] };
  if (!expectedSessionDigest || !isRecord(payload) || !Array.isArray(payload.resourceSpans)) {
    return match;
  }
  for (const resourceSpan of payload.resourceSpans) {
    if (!isRecord(resourceSpan)) continue;
    const resourceAttributes = otlpAttributes(isRecord(resourceSpan.resource) ? resourceSpan.resource.attributes : undefined);
    if (resourceAttributes["service.name"] !== "claude-code") continue;
    if (!Array.isArray(resourceSpan.scopeSpans)) continue;
    for (const scopeSpan of resourceSpan.scopeSpans) {
      if (!isRecord(scopeSpan) || !Array.isArray(scopeSpan.spans)) continue;
      for (const span of scopeSpan.spans) {
        if (!isRecord(span) || span.name !== "claude_code.interaction") continue;
        const attributes = { ...resourceAttributes, ...otlpAttributes(span.attributes) };
        const session = safeOpaqueIdentity(
          attributes["session.id"] ?? attributes.session_id ?? attributes["gen_ai.conversation.id"]
        );
        if (!session) continue;
        const sessionDigest = opaqueIdentityDigest(session);
        if (
          !constantTimeTextMatch(sessionDigest, expectedSessionDigest)
          || (submissionSessionDigest != null && !constantTimeTextMatch(sessionDigest, submissionSessionDigest))
        ) {
          continue;
        }
        const prompt = safeOpaqueIdentity(attributes["prompt.id"] ?? attributes.prompt_id);
        const promptDigest = prompt ? opaqueIdentityDigest(prompt) : undefined;
        if (promptDigest) match.promptDigests.push(promptDigest);

        const startNanoseconds = positiveNanoseconds(span.startTimeUnixNano);
        const endNanoseconds = positiveNanoseconds(span.endTimeUnixNano);
        if (
          !isRootSpan(span.parentSpanId)
          || !isValidOtlpHexIdentifier(span.traceId, 32)
          || !isValidOtlpHexIdentifier(span.spanId, 16)
          || startNanoseconds == null
          || endNanoseconds == null
          || startNanoseconds > endNanoseconds
        ) {
          match.malformed = true;
          continue;
        }
        match.boundaries.push({ startNanoseconds, endNanoseconds });
      }
    }
  }
  return match;
}

function isRootSpan(parentSpanId) {
  return parentSpanId == null || parentSpanId === "" || parentSpanId === "0000000000000000";
}

function positiveNanoseconds(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function isValidOtlpHexIdentifier(value, length) {
  return typeof value === "string"
    && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)
    && !/^0+$/.test(value);
}

function safeHookEventName(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value) ? value : undefined;
}

function hookCounterKey(eventName) {
  switch (eventName) {
    case "UserPromptSubmit": return "userPromptSubmit";
    case "PreToolUse": return "preToolUse";
    case "PostToolUse": return "postToolUse";
    case "PostToolUseFailure": return "postToolUseFailure";
    case "Stop": return "stop";
    case "StopFailure": return "stopFailure";
    default: return undefined;
  }
}

function isTargetedPreToolWrite(payload, hookEventName) {
  return hookEventName === "PreToolUse"
    && isRecord(payload)
    && normalizedToken(payload.tool_name) === "write";
}

function unsupportedIngressRejectionReason(pathname) {
  // This relay intentionally accepts only the signals necessary for the
  // CC15C decision contract. Preserve a fixed diagnostics category if the
  // provider emits a metrics request; do not silently widen the relay.
  return pathname === "/v1/metrics" ? "unsupported_metrics_request" : "unsupported_path";
}

function targetForwardRejectionReason(surface, status) {
  const table = {
    log: {
      unavailable: "target_log_unavailable",
      rateLimited: "target_log_rate_limited",
      client: "target_log_4xx",
      server: "target_log_5xx",
      unexpected: "target_log_unexpected"
    },
    trace: {
      unavailable: "target_trace_unavailable",
      rateLimited: "target_trace_rate_limited",
      client: "target_trace_4xx",
      server: "target_trace_5xx",
      unexpected: "target_trace_unexpected"
    },
    hook: {
      unavailable: "target_hook_unavailable",
      rateLimited: "target_hook_rate_limited",
      client: "target_hook_4xx",
      server: "target_hook_5xx",
      unexpected: "target_hook_unexpected"
    }
  };
  const reasons = table[surface];
  if (!reasons) return "invalid_request";
  if (status === 0) return reasons.unavailable;
  if (status === 429) return reasons.rateLimited;
  if (status >= 400 && status < 500) return reasons.client;
  if (status >= 500 && status < 600) return reasons.server;
  return reasons.unexpected;
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

function sendRawJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store"
  });
  const clear = () => zeroBuffer(body);
  response.once("finish", clear);
  response.once("close", clear);
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
  const relay = await startClaudeDelayedDecisionRelay({
    targetBaseUrl: process.env.TIRION_CC_DELAY_RELAY_TARGET ?? "",
    ingressToken: process.env.TIRION_CC_DELAY_RELAY_INGRESS_TOKEN ?? "",
    relayToken: process.env.TIRION_CC_DELAY_RELAY_TOKEN ?? "",
    controlToken: process.env.TIRION_CC_DELAY_RELAY_CONTROL_TOKEN ?? "",
    expectedSessionDigest: process.env.TIRION_CC_DELAY_RELAY_EXPECTED_SESSION_DIGEST,
    port: process.env.TIRION_CC_DELAY_RELAY_PORT == null ? 0 : Number(process.env.TIRION_CC_DELAY_RELAY_PORT),
    holdMs: process.env.TIRION_CC_DELAY_RELAY_HOLD_MS == null ? undefined : Number(process.env.TIRION_CC_DELAY_RELAY_HOLD_MS)
  });
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ready: true, port: relay.port })}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await relay.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.stderr.write("claude_delayed_decision_relay_failed\n");
    process.exitCode = 1;
  });
}
