#!/usr/bin/env node
/**
 * CC15D's loopback-only, source-topology census receiver.
 *
 * It accepts only the transient Claude hook/log/trace envelopes needed to
 * classify a controlled interactive denial's topology. Request bodies are
 * parsed in memory, reduced to opaque digests and fixed categories, then
 * zeroed. It never forwards, stores, prints, or exposes provider payloads.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONTAINERS = 2_000;
const MAX_CANDIDATES = 8;
const MAX_IDENTITIES = 3;
const HOOK_NAMES = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
]);

/**
 * @typedef {{ ingressToken: string, controlToken: string, expectedSessionDigest: string, port?: number, bodyLimitBytes?: number }} Cc15dReceiverOptions
 */

/**
 * Start the ephemeral source-only CC15D census receiver.
 *
 * @param {Cc15dReceiverOptions} options
 */
export async function startCc15dInteractiveTopologyReceiver(options) {
  const ingressToken = requireSecret(options?.ingressToken, "ingress_token");
  const controlToken = requireSecret(options?.controlToken, "control_token");
  const expectedSessionDigest = requireDigest(options?.expectedSessionDigest, "expected_session_digest");
  const port = boundedPort(options?.port ?? 0);
  const bodyLimitBytes = boundedInteger(options?.bodyLimitBytes, MAX_BODY_BYTES, 1_024, MAX_BODY_BYTES);

  let ingressSealed = false;
  let closed = false;
  let inFlightIngress = 0;
  let postSealIngressAttemptCount = 0;
  let rejectedIngressCount = 0;
  /** @type {(() => void)[]} */
  const idleWaiters = [];

  const hooks = Object.fromEntries([...HOOK_NAMES].map((name) => [name, 0]));
  let controlledDenialCount = 0;
  let logRecordCount = 0;
  let traceRequestCount = 0;
  let rejectedWriteDecisionCount = 0;
  let decisionOverflow = false;
  let rootOverflow = false;
  /** @type {{ values: Set<string>, overflow: boolean }} */
  const submissionSessions = emptyDigestSet();
  /** @type {{ values: Set<string>, overflow: boolean }} */
  const preToolIdentities = emptyDigestSet();
  /** @type {{ values: Set<string>, overflow: boolean }} */
  const preToolSessions = emptyDigestSet();
  /** @type {{ values: Set<string>, overflow: boolean }} */
  const stopSessions = emptyDigestSet();
  /** @type {{ values: Set<string>, overflow: boolean }} */
  const decisionSessions = emptyDigestSet();
  /** @type {{ values: Set<string>, overflow: boolean }} */
  const promptAliases = emptyDigestSet();
  /** @type {{ identityDigest: string | undefined, sessionDigest: string | undefined, sourceTimestampNanoseconds: bigint | undefined }[]} */
  const decisions = [];
  /** @type {{ sessionDigest: string | undefined, valid: boolean, startNanoseconds: bigint | undefined, endNanoseconds: bigint | undefined }[]} */
  const roots = [];

  const rememberPrompt = (value) => rememberDigest(promptAliases, digestIdentity(value));
  const rejectIngress = (response, status = 400) => {
    rejectedIngressCount = saturatingIncrement(rejectedIngressCount);
    sendJson(response, status, { error: "request_rejected" });
  };

  const recordRejectedWriteDecision = (decision) => {
    rejectedWriteDecisionCount = saturatingIncrement(rejectedWriteDecisionCount);
    if (decisions.length >= MAX_CANDIDATES) {
      decisionOverflow = true;
      return;
    }
    decisions.push(decision);
    rememberDigest(decisionSessions, decision.sessionDigest);
  };

  const recordRoot = (root) => {
    if (roots.length >= MAX_CANDIDATES) {
      rootOverflow = true;
      return;
    }
    roots.push(root);
  };

  const currentStatus = () => {
    const hookCardinality = Object.fromEntries(
      [...HOOK_NAMES].map((name) => [camelHookName(name), cardinality(hooks[name])])
    );
    const nativeDecision = classifyNativeDecision({
      decisionCount: rejectedWriteDecisionCount,
      decisionOverflow,
      decisions,
      preToolIdentityCount: controlledDenialCount,
      preToolIdentities,
      preToolSessions,
      stopSessions,
      submissionSessions,
    });
    const closedRoot = classifyClosedRoots({
      roots,
      rootOverflow,
      expectedSessionDigest,
      submissionSessions,
      decisionSessions,
      decisions,
      rejectedWriteDecisionCount,
      decisionOverflow,
    });
    const promptAliasRelation = promptAliases.overflow || promptAliases.values.size > 1
      ? "conflict"
      : promptAliases.values.size === 1 ? "consistent" : "unavailable";
    const ingress = {
      logs: logRecordCount > 0 ? "seen" : "missing",
      traces: traceRequestCount > 0 ? "seen" : "missing",
      rejected: rejectedIngressCount > 0 ? "present" : "none",
      postSeal: postSealIngressAttemptCount > 0 ? "present" : "none",
      state: ingressSealed ? "sealed" : "open",
      inFlight: inFlightIngress > 0 ? "present" : "none",
    };
    const eligible = (
      hookCardinality.userPromptSubmit === "one"
      && hookCardinality.preToolUse === "one"
      && hookCardinality.postToolUse === "zero"
      && hookCardinality.postToolUseFailure === "zero"
      && hookCardinality.stop === "one"
      && hookCardinality.stopFailure === "zero"
      && cardinality(controlledDenialCount) === "one"
      && nativeDecision.rejectedWrite === "one"
      && nativeDecision.samePreToolInvocation === "yes"
      && nativeDecision.samePreToolSubmissionSession === "yes"
      && nativeDecision.sameStopSubmissionSession === "yes"
      && nativeDecision.sameSubmissionSession === "yes"
      && nativeDecision.sourceTime === "present"
      && closedRoot.expectedSession === "one"
      && closedRoot.submissionSession === "one"
      && closedRoot.decisionSession === "one"
      && closedRoot.expectedSubmissionSession === "yes"
      && closedRoot.shape === "all_valid"
      && closedRoot.decisionRelation === "inside_unique_root"
      && ingress.logs === "seen"
      && ingress.traces === "seen"
      && ingress.rejected === "none"
      && ingress.postSeal === "none"
      && ingress.state === "sealed"
      && ingress.inFlight === "none"
    );
    return {
      schemaVersion: 1,
      result: "census_complete",
      mode: "interactive_tty",
      hookCardinality,
      controlledDenial: cardinality(controlledDenialCount),
      nativeDecision,
      closedRoot,
      promptAliasRelation,
      ingress,
      cc15cEligibility: eligible ? "eligible" : "not_eligible",
    };
  };

  const waitForIngressIdle = async () => {
    if (inFlightIngress === 0) return;
    await new Promise((resolvePromise) => idleWaiters.push(resolvePromise));
  };

  const finishIngress = () => {
    inFlightIngress = Math.max(0, inFlightIngress - 1);
    if (inFlightIngress === 0) {
      for (const resolvePromise of idleWaiters.splice(0)) resolvePromise();
    }
  };

  const server = createServer(async (request, response) => {
    const url = safeRequestUrl(request.url);
    if (!url) {
      sendJson(response, 400, { error: "request_rejected" });
      return;
    }
    if (url.pathname.startsWith("/control/")) {
      if (!constantTimeMatch(request.headers["x-tirion-cc15d-control"], controlToken)) {
        sendJson(response, 401, { error: "request_rejected" });
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
      if (request.method === "POST" && url.pathname === "/control/shutdown") {
        ingressSealed = true;
        await waitForIngressIdle();
        sendJson(response, 200, { schemaVersion: 1, state: "shutting_down" });
        setImmediate(() => void close());
        return;
      }
      sendJson(response, 404, { error: "request_rejected" });
      return;
    }

    const supportedPath = (
      url.pathname === "/v1/logs"
      || url.pathname === "/v1/traces"
      || url.pathname === "/v1/provider-hooks/claude-code"
    );
    if (request.method !== "POST" || !supportedPath) {
      sendJson(response, 404, { error: "request_rejected" });
      return;
    }
    if (
      !constantTimeMatch(bearerToken(request.headers.authorization), ingressToken)
      || !constantTimeMatch(request.headers["x-tirion-cc15d-receiver"], ingressToken)
    ) {
      sendJson(response, 401, { error: "request_rejected" });
      return;
    }
    if (ingressSealed) {
      postSealIngressAttemptCount = saturatingIncrement(postSealIngressAttemptCount);
      sendJson(response, 409, { error: "ingress_sealed" });
      return;
    }
    if (!isJsonContentType(request.headers["content-type"])) {
      rejectIngress(response, 415);
      return;
    }

    inFlightIngress += 1;
    try {
      const body = await readBoundedBody(request, bodyLimitBytes);
      try {
        const payload = parseObjectJson(body);
        if (url.pathname === "/v1/logs") {
          observeLogs(payload, {
            rememberPrompt,
            recordRejectedWriteDecision,
            onRecord: () => { logRecordCount = saturatingIncrement(logRecordCount); },
          });
          sendJson(response, 200, { partialSuccess: {} });
          return;
        }
        if (url.pathname === "/v1/traces") {
          observeTraces(payload, {
            rememberPrompt,
            recordRoot,
            onRequest: () => { traceRequestCount = saturatingIncrement(traceRequestCount); },
          });
          sendJson(response, 200, { partialSuccess: {} });
          return;
        }

        const hookEventName = safeHookEventName(payload.hook_event_name);
        if (!hookEventName || !HOOK_NAMES.has(hookEventName) || !constantTimeMatch(request.headers["x-tirion-hook-event"], hookEventName)) {
          rejectIngress(response, 422);
          return;
        }
        hooks[hookEventName] = saturatingIncrement(hooks[hookEventName]);
        rememberPrompt(payload.prompt_id ?? payload.promptId);
        const sessionDigest = digestIdentity(payload.session_id ?? payload.sessionId);
        if (hookEventName === "UserPromptSubmit") {
          rememberDigest(submissionSessions, sessionDigest);
        }
        if (hookEventName === "Stop") {
          rememberDigest(stopSessions, sessionDigest);
        }
        if (hookEventName === "PreToolUse" && normalizedToken(payload.tool_name ?? payload.toolName) === "write") {
          controlledDenialCount = saturatingIncrement(controlledDenialCount);
          const identity = digestIdentity(payload.tool_use_id ?? payload.toolUseId);
          rememberDigest(preToolIdentities, identity);
          rememberDigest(preToolSessions, sessionDigest);
          sendJson(response, 200, {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Controlled Tirion topology census denial",
            },
          });
          return;
        }
        sendJson(response, 200, {});
      } finally {
        zeroBuffer(body);
      }
    } catch {
      rejectIngress(response, 400);
    } finally {
      finishIngress();
    }
  });

  await listenLoopback(server, port);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("receiver_listen_failed");
  }

  const close = async () => {
    if (closed) return;
    closed = true;
    ingressSealed = true;
    await waitForIngressIdle();
    await closeServer(server);
  };

  return { port: address.port, status: currentStatus, close };
}

function classifyNativeDecision(input) {
  const decisionCount = cardinality(input.decisionOverflow ? 2 : input.decisionCount);
  const onlyDecision = input.decisionCount === 1 && !input.decisionOverflow ? input.decisions[0] : undefined;
  const exactlyOnePreToolIdentity = input.preToolIdentityCount === 1
    && !input.preToolIdentities.overflow
    && input.preToolIdentities.values.size === 1
    ? [...input.preToolIdentities.values][0]
    : undefined;
  const exactlyOneSubmissionSession = !input.submissionSessions.overflow && input.submissionSessions.values.size === 1
    ? [...input.submissionSessions.values][0]
    : undefined;
  const exactlyOnePreToolSession = !input.preToolSessions.overflow && input.preToolSessions.values.size === 1
    ? [...input.preToolSessions.values][0]
    : undefined;
  const exactlyOneStopSession = !input.stopSessions.overflow && input.stopSessions.values.size === 1
    ? [...input.stopSessions.values][0]
    : undefined;
  const samePreToolInvocation = !onlyDecision || !onlyDecision.identityDigest || !exactlyOnePreToolIdentity
    ? "unavailable"
    : constantTimeTextMatch(onlyDecision.identityDigest, exactlyOnePreToolIdentity) ? "yes" : "no";
  const sameSubmissionSession = !onlyDecision || !onlyDecision.sessionDigest || !exactlyOneSubmissionSession
    ? "unavailable"
    : constantTimeTextMatch(onlyDecision.sessionDigest, exactlyOneSubmissionSession) ? "yes" : "no";
  const samePreToolSubmissionSession = !exactlyOnePreToolSession || !exactlyOneSubmissionSession
    ? "unavailable"
    : constantTimeTextMatch(exactlyOnePreToolSession, exactlyOneSubmissionSession) ? "yes" : "no";
  const sameStopSubmissionSession = !exactlyOneStopSession || !exactlyOneSubmissionSession
    ? "unavailable"
    : constantTimeTextMatch(exactlyOneStopSession, exactlyOneSubmissionSession) ? "yes" : "no";
  return {
    rejectedWrite: decisionCount,
    samePreToolInvocation,
    samePreToolSubmissionSession,
    sameStopSubmissionSession,
    sameSubmissionSession,
    sourceTime: onlyDecision?.sourceTimestampNanoseconds != null ? "present" : "missing",
  };
}

function classifyClosedRoots(input) {
  const submissionSessionDigests = [...input.submissionSessions.values];
  const decisionSessionDigests = [...input.decisionSessions.values];
  const expectedSubmissionSession = input.submissionSessions.overflow || submissionSessionDigests.length !== 1
    ? "unavailable"
    : constantTimeTextMatch(input.expectedSessionDigest, submissionSessionDigests[0]) ? "yes" : "no";
  const validRoots = input.roots.filter((candidate) => candidate.valid && candidate.sessionDigest);
  const countFor = (digests) => {
    if (input.rootOverflow || digests.length === 0) return input.rootOverflow ? "many" : "zero";
    const count = validRoots.filter((candidate) => digests.some((digest) => constantTimeTextMatch(candidate.sessionDigest, digest))).length;
    return cardinality(count);
  };
  const relevantDigests = new Set([input.expectedSessionDigest, ...submissionSessionDigests, ...decisionSessionDigests]);
  const relevantRoots = input.roots.filter((candidate) => candidate.sessionDigest && relevantDigests.has(candidate.sessionDigest));
  const relevantValidRoots = relevantRoots.filter((candidate) => candidate.valid);
  const shape = relevantValidRoots.length === 0
    ? "none_valid"
    : input.rootOverflow || relevantRoots.some((candidate) => !candidate.valid) ? "some_invalid" : "all_valid";
  let decisionRelation = "decision_missing";
  if (input.decisionOverflow || input.rejectedWriteDecisionCount > 1) {
    decisionRelation = "decision_many";
  } else if (input.rejectedWriteDecisionCount === 1) {
    const decision = input.decisions[0];
    if (!decision?.sourceTimestampNanoseconds) {
      decisionRelation = "decision_time_missing";
    } else if (!decision.sessionDigest || input.rootOverflow) {
      decisionRelation = "no_unique_root";
    } else {
      const matchingRoots = validRoots.filter((candidate) => constantTimeTextMatch(candidate.sessionDigest, decision.sessionDigest));
      if (matchingRoots.length !== 1) {
        decisionRelation = "no_unique_root";
      } else if (decision.sourceTimestampNanoseconds < matchingRoots[0].startNanoseconds) {
        decisionRelation = "before_root";
      } else if (decision.sourceTimestampNanoseconds > matchingRoots[0].endNanoseconds) {
        decisionRelation = "after_root";
      } else {
        decisionRelation = "inside_unique_root";
      }
    }
  }
  return {
    expectedSession: countFor([input.expectedSessionDigest]),
    submissionSession: countFor(submissionSessionDigests),
    decisionSession: countFor(decisionSessionDigests),
    expectedSubmissionSession,
    shape,
    decisionRelation,
  };
}

function observeLogs(payload, callbacks) {
  if (!Array.isArray(payload.resourceLogs) || payload.resourceLogs.length > MAX_CONTAINERS) throw new Error("invalid_log_payload");
  for (const resourceLog of payload.resourceLogs) {
    if (!isRecord(resourceLog) || !Array.isArray(resourceLog.scopeLogs) || resourceLog.scopeLogs.length > MAX_CONTAINERS) {
      throw new Error("invalid_log_payload");
    }
    const resourceAttributes = otlpAttributes(resourceLog.resource?.attributes);
    if (resourceAttributes["service.name"] !== "claude-code") continue;
    for (const scopeLog of resourceLog.scopeLogs) {
      if (!isRecord(scopeLog) || !Array.isArray(scopeLog.logRecords) || scopeLog.logRecords.length > MAX_CONTAINERS) {
        throw new Error("invalid_log_payload");
      }
      for (const record of scopeLog.logRecords) {
        if (!isRecord(record)) throw new Error("invalid_log_payload");
        callbacks.onRecord();
        const attributes = { ...resourceAttributes, ...otlpAttributes(record.attributes) };
        const eventName = normalizedToken(attributes["event.name"] ?? otlpPrimitive(record.body));
        const decision = normalizedToken(attributes.decision);
        const toolName = normalizedToken(attributes["gen_ai.tool.name"] ?? attributes["tool.name"] ?? attributes.tool_name);
        if (eventName !== "claude_code.tool_decision" && eventName !== "tool_decision") continue;
        if (decision !== "reject" || toolName !== "write") continue;
        const identity = digestIdentity(attributes.tool_use_id ?? attributes["tool.use.id"] ?? attributes["gen_ai.tool.call.id"] ?? attributes["tool.call.id"]);
        const session = digestIdentity(attributes["session.id"] ?? attributes.session_id ?? attributes["gen_ai.conversation.id"]);
        callbacks.rememberPrompt(attributes["prompt.id"] ?? attributes.prompt_id);
        callbacks.recordRejectedWriteDecision({
          identityDigest: identity,
          sessionDigest: session,
          sourceTimestampNanoseconds: sourceTimestampNanoseconds(record, attributes),
        });
      }
    }
  }
}

function observeTraces(payload, callbacks) {
  if (!Array.isArray(payload.resourceSpans) || payload.resourceSpans.length > MAX_CONTAINERS) throw new Error("invalid_trace_payload");
  callbacks.onRequest();
  for (const resourceSpan of payload.resourceSpans) {
    if (!isRecord(resourceSpan) || !Array.isArray(resourceSpan.scopeSpans) || resourceSpan.scopeSpans.length > MAX_CONTAINERS) {
      throw new Error("invalid_trace_payload");
    }
    const resourceAttributes = otlpAttributes(resourceSpan.resource?.attributes);
    if (resourceAttributes["service.name"] !== "claude-code") continue;
    for (const scopeSpan of resourceSpan.scopeSpans) {
      if (!isRecord(scopeSpan) || !Array.isArray(scopeSpan.spans) || scopeSpan.spans.length > MAX_CONTAINERS) {
        throw new Error("invalid_trace_payload");
      }
      for (const span of scopeSpan.spans) {
        if (!isRecord(span) || span.name !== "claude_code.interaction") continue;
        const attributes = { ...resourceAttributes, ...otlpAttributes(span.attributes) };
        callbacks.rememberPrompt(attributes["prompt.id"] ?? attributes.prompt_id);
        const sessionDigest = digestIdentity(attributes["session.id"] ?? attributes.session_id ?? attributes["gen_ai.conversation.id"]);
        const startNanoseconds = positiveNanoseconds(span.startTimeUnixNano);
        const endNanoseconds = positiveNanoseconds(span.endTimeUnixNano);
        callbacks.recordRoot({
          sessionDigest,
          valid: Boolean(
            sessionDigest
            && isRootSpan(span.parentSpanId)
            && isValidOtlpHexIdentifier(span.traceId, 32)
            && isValidOtlpHexIdentifier(span.spanId, 16)
            && startNanoseconds != null
            && endNanoseconds != null
            && startNanoseconds <= endNanoseconds
          ),
          startNanoseconds,
          endNanoseconds,
        });
      }
    }
  }
}

function emptyDigestSet() {
  return { values: new Set(), overflow: false };
}

function rememberDigest(target, digest) {
  if (!digest || target.values.has(digest)) return;
  if (target.values.size >= MAX_IDENTITIES) {
    target.overflow = true;
    return;
  }
  target.values.add(digest);
}

function digestIdentity(value) {
  const identity = safeOpaqueIdentity(value);
  return identity ? createHash("sha256").update(identity).digest("hex") : undefined;
}

function cardinality(value) {
  return value <= 0 ? "zero" : value === 1 ? "one" : "many";
}

function saturatingIncrement(value) {
  return Math.min(2, value + 1);
}

function camelHookName(value) {
  return value[0].toLowerCase() + value.slice(1);
}

function sourceTimestampNanoseconds(record, attributes) {
  const candidate = attributes["event.timestamp"] ?? record.startTimeUnixNano ?? record.timeUnixNano;
  if (typeof candidate === "string" && /^[1-9][0-9]{0,19}$/.test(candidate)) {
    try { return BigInt(candidate); } catch { return undefined; }
  }
  return rfc3339TimestampNanoseconds(candidate);
}

function rfc3339TimestampNanoseconds(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return undefined;
  const wholeSecond = `${match[1]}.000Z`;
  const milliseconds = Date.parse(wholeSecond);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || new Date(milliseconds).toISOString() !== wholeSecond) {
    return undefined;
  }
  try { return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0")); } catch { return undefined; }
}

function otlpAttributes(value) {
  if (!Array.isArray(value) || value.length > MAX_CONTAINERS) return {};
  const attributes = {};
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== "string" || !isRecord(item.value)) continue;
    const parsed = otlpPrimitive(item.value);
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") attributes[item.key] = parsed;
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

function positiveNanoseconds(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return undefined;
  try { return BigInt(value); } catch { return undefined; }
}

function isRootSpan(value) {
  return value == null || value === "" || value === "0000000000000000";
}

function isValidOtlpHexIdentifier(value, length) {
  return typeof value === "string" && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value) && !/^0+$/.test(value);
}

function safeHookEventName(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value) ? value : undefined;
}

function requireSecret(value, field) {
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096 || value.includes("\0")) throw new Error(`invalid_${field}`);
  return value;
}

function requireDigest(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`invalid_${field}`);
  return value;
}

function boundedPort(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error("invalid_port");
  return value;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("invalid_numeric_option");
  return value;
}

function bearerToken(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : undefined;
}

function constantTimeMatch(value, expected) {
  const actual = Array.isArray(value) ? value[0] : value;
  return typeof actual === "string" && constantTimeTextMatch(actual, expected);
}

function constantTimeTextMatch(actual, expected) {
  const length = Math.max(actual.length, expected.length);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < length; index += 1) difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  return difference === 0;
}

function isJsonContentType(value) {
  const contentType = Array.isArray(value) ? value[0] : value;
  return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function safeRequestUrl(value) {
  try { return new URL(value ?? "/", "http://127.0.0.1"); } catch { return undefined; }
}

async function readBoundedBody(request, limitBytes) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) throw new Error("payload_too_large");
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
  try { parsed = JSON.parse(body.toString("utf8")); } catch { throw new Error("invalid_json"); }
  if (!isRecord(parsed)) throw new Error("invalid_json");
  return parsed;
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
    "cache-control": "no-store",
  });
  response.end(body);
}

async function listenLoopback(server, port) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
}

async function closeServer(server) {
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function main() {
  const receiver = await startCc15dInteractiveTopologyReceiver({
    ingressToken: process.env.TIRION_CC15D_INGRESS_TOKEN ?? "",
    controlToken: process.env.TIRION_CC15D_CONTROL_TOKEN ?? "",
    expectedSessionDigest: process.env.TIRION_CC15D_EXPECTED_SESSION_DIGEST ?? "",
    port: process.env.TIRION_CC15D_PORT == null ? 0 : Number(process.env.TIRION_CC15D_PORT),
  });
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ready: true, port: receiver.port })}\n`);
  const stop = () => void receiver.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.stderr.write("claude_cc15d_topology_receiver_failed\n");
    process.exitCode = 1;
  });
}
