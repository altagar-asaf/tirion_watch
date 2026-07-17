#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { startClaudeDelayedDecisionRelay } from "./claude_delayed_decision_relay.mjs";

const ingressToken = "relay-ingress-token-0123456789";
const relayToken = "relay-auth-token-0123456789";
const controlToken = "relay-control-token-0123456789";
const interactionStart = "1735689600000000000";
const interactionEnd = "1735689600000000004";
const decisionTimestamp = "1735689600000000002";

const received = [];
let nextTargetResponseStatus;
const target = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } finally {
    body.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
  received.push(summarize(request.url ?? "/", payload));
  const reply = request.url === "/v1/provider-hooks/claude-code"
    ? { targetAccepted: true }
    : { partialSuccess: {} };
  const serialized = Buffer.from(JSON.stringify(reply));
  const status = nextTargetResponseStatus ?? 200;
  nextTargetResponseStatus = undefined;
  response.writeHead(status, { "content-type": "application/json", "content-length": String(serialized.length) });
  response.end(serialized);
  serialized.fill(0);
});

await listen(target);
const targetAddress = target.address();
assert.ok(targetAddress && typeof targetAddress !== "string");
const targetBaseUrl = `http://127.0.0.1:${targetAddress.port}`;

try {
  await verifyUnauthenticatedAndGenericForwarding();
  await verifyFixedIngressRejectionCategories();
  await verifyTargetForwardRejectionCategories();
  await verifyDecisionFirstAcceptance();
  await verifyNativeDecisionBeforeControlAcceptance();
  await verifyEarlyWrongToolCannotBind();
  await verifyTraceFirstAcceptance();
  await verifyFractionalIsoInRangeAcceptance();
  await verifyOptionalPromptIdentityAcceptance();
  await verifySealWaitsForSlowPreSealForward();
  await verifySealRejectsLateIngress();
  await verifyMismatchedToolAndSessionRejected();
  await verifyMissingNativeSessionRejected();
  await verifyNativeToolIdentityAliasesBind();
  await verifyPromptMismatchesRemainDiagnostic();
  await verifyPreStartDecisionCannotRelease();
  await verifyPostEndDecisionCannotRelease();
  await verifyFractionalIsoPostEndDecisionCannotRelease();
  await verifyMalformedDecisionCannotRelease();
  await verifyMalformedRootCannotRelease();
  await verifyMixedValidAndMalformedRootCannotRelease();
  await verifyInvalidTraceIdentifiersCannotRelease();
  await verifyPendingDecisionExpires();
  await verifyHeldDecisionExpires();
} finally {
  await close(target);
}

process.stdout.write("claude delayed decision relay self-test passed\n");

async function verifyUnauthenticatedAndGenericForwarding() {
  const session = "SESSION_CANARY_GENERIC";
  await withRelay(session, async (baseUrl) => {
    const unauthorized = await postJson(baseUrl, "/v1/logs", logEnvelope([genericToolRecord()]), "wrong-token-0123456789");
    assert.equal(unauthorized.status, 401);

    const before = received.length;
    const logs = logEnvelope([
      genericToolRecord(),
      acceptedDecisionRecord(),
      ordinaryRecord()
    ]);
    const logResponse = await postJson(baseUrl, "/v1/logs", logs, ingressToken);
    assert.equal(logResponse.status, 200);
    assert.equal(received.slice(before).filter((entry) => entry.path === "/v1/logs").length, 3);
    assert.equal(received.slice(before).some((entry) => entry.decision === "reject"), false);
    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.rejectedRequestCount, 1);
    assert.equal(status.rejectionReasons.ingress_auth, 1);
  });
}

async function verifyFixedIngressRejectionCategories() {
  const binding = fixtureBinding("INGRESS_REJECTIONS");
  await withRelay(binding.session, async (baseUrl) => {
    const invalidRelayToken = await postJson(
      baseUrl,
      "/v1/logs",
      logEnvelope([genericToolRecord()]),
      ingressToken,
      { "x-tirion-cc15c-relay": "wrong-relay-token-0123456789" }
    );
    assert.equal(invalidRelayToken.status, 401);

    const invalidContentType = await fetch(`${baseUrl}/v1/logs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ingressToken}`,
        "content-type": "text/plain",
        "x-tirion-cc15c-relay": relayToken
      },
      body: "{}"
    });
    assert.equal(invalidContentType.status, 415);

    const unsupportedMetrics = await postJson(baseUrl, "/v1/metrics", { resourceMetrics: [] }, ingressToken);
    assert.equal(unsupportedMetrics.status, 404);

    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.rejectedRequestCount, 3);
    assert.equal(status.rejectionReasons.relay_auth, 1);
    assert.equal(status.rejectionReasons.content_type, 1);
    assert.equal(status.rejectionReasons.unsupported_metrics_request, 1);
    assertSafeStatus(status, binding);
  });
}

async function verifyTargetForwardRejectionCategories() {
  const logBinding = fixtureBinding("TARGET_LOG_RATE_LIMIT");
  await withRelay(logBinding.session, async (baseUrl) => {
    nextTargetResponseStatus = 429;
    try {
      const rejectedLog = await postJson(baseUrl, "/v1/logs", logEnvelope([genericToolRecord()]), ingressToken);
      assert.equal(rejectedLog.status, 502);
    } finally {
      nextTargetResponseStatus = undefined;
    }
    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.rejectedRequestCount, 1);
    assert.equal(status.rejectionReasons.target_log_rate_limited, 1);
    assertSafeStatus(status, logBinding);
  });

  const traceBinding = fixtureBinding("TARGET_TRACE_SERVER");
  await withRelay(traceBinding.session, async (baseUrl) => {
    nextTargetResponseStatus = 500;
    try {
      const rejectedTrace = await postRootTrace(baseUrl, traceBinding);
      assert.equal(rejectedTrace.status, 502);
    } finally {
      nextTargetResponseStatus = undefined;
    }
    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.rejectedRequestCount, 1);
    assert.equal(status.rejectionReasons.target_trace_5xx, 1);
    assertSafeStatus(status, traceBinding);
  });

  const hookBinding = fixtureBinding("TARGET_HOOK_CLIENT");
  await withRelay(hookBinding.session, async (baseUrl) => {
    nextTargetResponseStatus = 401;
    try {
      const rejectedHook = await postHook(baseUrl, {
        hook_event_name: "UserPromptSubmit",
        session_id: hookBinding.session,
        prompt_id: hookBinding.prompt
      });
      assert.equal(rejectedHook.status, 502);
    } finally {
      nextTargetResponseStatus = undefined;
    }
    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.rejectedRequestCount, 1);
    assert.equal(status.rejectionReasons.target_hook_4xx, 1);
    assertSafeStatus(status, hookBinding);
  });
}

async function verifyDecisionFirstAcceptance() {
  const binding = fixtureBinding("DECISION_FIRST");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    assert.equal((await postDecision(baseUrl, binding)).status, 200);
    assert.equal((await postRootTrace(baseUrl, binding)).status, 200);
    await postStop(baseUrl, binding);

    const held = await control(baseUrl, "/control/status", "GET");
    assertHeldAndBound(held, binding);

    const released = await control(baseUrl, "/control/release", "POST");
    assertReleasedAndBound(released, binding);
  });
}

async function verifyNativeDecisionBeforeControlAcceptance() {
  const binding = fixtureBinding("NATIVE_BEFORE_CONTROL");
  await withRelay(binding.session, async (baseUrl) => {
    assert.equal((await postDecision(baseUrl, binding)).status, 200);
    // OTLP logs/traces may reach the relay before independently delivered
    // hooks. The relay may buffer one exact native candidate, but must not
    // release it until the controlled hook denial arrives.
    assert.equal((await postRootTrace(baseUrl, binding)).status, 200);
    const pending = await control(baseUrl, "/control/status", "GET");
    assert.equal(pending.decisionState, "awaiting");
    assert.equal(pending.pendingNativeRejectionCount, 1);
    assert.equal(pending.heldNativeRejectionCount, 0);
    assert.equal(pending.rejectedRequestCount, 0);
    assertSafeStatus(pending, binding);

    await establishControlledWriteDenial(baseUrl, binding);
    await postStop(baseUrl, binding);

    const held = await control(baseUrl, "/control/status", "GET");
    assertHeldAndBound(held, binding);

    const released = await control(baseUrl, "/control/release", "POST");
    assertReleasedAndBound(released, binding);
  });
}

async function verifyEarlyWrongToolCannotBind() {
  const binding = fixtureBinding("EARLY_WRONG_TOOL");
  await withRelay(binding.session, async (baseUrl) => {
    assert.equal((await postDecision(baseUrl, {
      ...binding,
      toolUseId: "TOOL_USE_CANARY_EARLY_OTHER"
    })).status, 200);
    const pending = await control(baseUrl, "/control/status", "GET");
    assert.equal(pending.pendingNativeRejectionCount, 1);

    await establishControlledWriteDenial(baseUrl, binding);
    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.decisionState, "ambiguous");
    assert.equal(status.pendingNativeRejectionCount, 0);
    assert.equal(status.heldNativeRejectionCount, 0);
    assert.equal(status.rejectionReasons.native_rejection_binding, 1);
    assert.equal(status.nativeBindingFailureReasons.native_tool_identity_mismatch, 1);
    assertSafeStatus(status, binding);
    await assertCannotRelease(baseUrl);
  });
}

async function verifyTraceFirstAcceptance() {
  const binding = fixtureBinding("TRACE_FIRST");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    assert.equal((await postRootTrace(baseUrl, binding)).status, 200);
    assert.equal((await postDecision(baseUrl, binding)).status, 200);
    await postStop(baseUrl, binding);

    const held = await control(baseUrl, "/control/status", "GET");
    assertHeldAndBound(held, binding);

    const released = await control(baseUrl, "/control/release", "POST");
    assertReleasedAndBound(released, binding);
  });
}

async function verifyFractionalIsoInRangeAcceptance() {
  const binding = fixtureBinding("FRACTIONAL_ISO_IN_RANGE");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    assert.equal((await postDecision(baseUrl, binding, {
      timestamp: "1735689600000000005",
      eventTimestamp: "2025-01-01T00:00:00.000000002Z"
    })).status, 200);
    assert.equal((await postRootTrace(baseUrl, binding)).status, 200);
    await postStop(baseUrl, binding);

    const held = await control(baseUrl, "/control/status", "GET");
    assertHeldAndBound(held, binding);

    const released = await control(baseUrl, "/control/release", "POST");
    assertReleasedAndBound(released, binding);
  });
}

async function verifyOptionalPromptIdentityAcceptance() {
  const fullyAbsent = { ...fixtureBinding("PROMPT_ABSENT"), prompt: undefined };
  await withRelay(fullyAbsent.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, fullyAbsent);
    assert.equal((await postDecision(baseUrl, fullyAbsent)).status, 200);
    assert.equal((await postRootTrace(baseUrl, fullyAbsent)).status, 200);
    await postStop(baseUrl, fullyAbsent);

    const held = await control(baseUrl, "/control/status", "GET");
    assertHeldAndBound(held, fullyAbsent, { promptIdentityObserved: false });

    const released = await control(baseUrl, "/control/release", "POST");
    assertReleasedAndBound(released, fullyAbsent, { promptIdentityObserved: false });
  });

  const partial = fixtureBinding("PROMPT_PARTIALLY_ABSENT");
  await withRelay(partial.session, async (baseUrl) => {
    const prompt = await postHook(baseUrl, {
      hook_event_name: "UserPromptSubmit",
      session_id: partial.session,
      prompt_id: partial.prompt
    });
    assert.equal(prompt.status, 200);
    const denied = await postHook(baseUrl, {
      hook_event_name: "PreToolUse",
      session_id: partial.session,
      tool_name: "Write",
      tool_use_id: partial.toolUseId
    });
    assert.equal(denied.status, 200);
    assert.equal((await denied.json()).hookSpecificOutput.permissionDecision, "deny");

    const withoutPrompt = { ...partial, prompt: undefined };
    assert.equal((await postDecision(baseUrl, withoutPrompt)).status, 200);
    assert.equal((await postRootTrace(baseUrl, withoutPrompt)).status, 200);
    await postStop(baseUrl, withoutPrompt);

    const held = await control(baseUrl, "/control/status", "GET");
    assertHeldAndBound(held, withoutPrompt, { promptIdentityObserved: true });

    const released = await control(baseUrl, "/control/release", "POST");
    assertReleasedAndBound(released, withoutPrompt, { promptIdentityObserved: true });
  });
}

async function verifySealRejectsLateIngress() {
  const binding = fixtureBinding("SEALED_INGRESS");
  await withRelay(binding.session, async (baseUrl) => {
    const sealed = await control(baseUrl, "/control/seal", "POST");
    assert.equal(sealed.ingressSealed, true);
    assert.equal(sealed.inFlightIngress, 0);
    assert.equal(sealed.postSealIngressAttemptCount, 0);

    const lateHook = await postHook(baseUrl, {
      hook_event_name: "UserPromptSubmit",
      session_id: binding.session,
      prompt_id: binding.prompt
    });
    assert.equal(lateHook.status, 409);
    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.ingressSealed, true);
    assert.equal(status.inFlightIngress, 0);
    assert.equal(status.postSealIngressAttemptCount, 1);
    assert.equal(status.rejectedRequestCount, 1);
    assert.equal(status.rejectionReasons.ingress_sealed, 1);
    assertSafeStatus(status, binding);
  });
}

async function verifySealWaitsForSlowPreSealForward() {
  const binding = fixtureBinding("SEALED_SLOW_INGRESS");
  let releaseForward;
  let forwardStarted;
  const forwardStartedPromise = new Promise((resolve) => {
    forwardStarted = resolve;
  });
  let blockNextForward = true;
  await withRelay(binding.session, async (baseUrl) => {
    try {
      const preSealIngress = postJson(baseUrl, "/v1/logs", logEnvelope([genericToolRecord()]), ingressToken);
      await Promise.race([
        forwardStartedPromise,
        wait(1_000).then(() => {
          throw new Error("slow_preseal_forward_not_started");
        })
      ]);

      let sealResolved = false;
      const sealing = control(baseUrl, "/control/seal", "POST").then((status) => {
        sealResolved = true;
        return status;
      });
      await wait(20);
      assert.equal(sealResolved, false);

      releaseForward?.();
      assert.equal((await preSealIngress).status, 200);
      const sealed = await sealing;
      assert.equal(sealed.ingressSealed, true);
      assert.equal(sealed.inFlightIngress, 0);
      assert.equal(sealed.postSealIngressAttemptCount, 0);

      const lateIngress = await postJson(baseUrl, "/v1/logs", logEnvelope([genericToolRecord()]), ingressToken);
      assert.equal(lateIngress.status, 409);
      const status = await control(baseUrl, "/control/status", "GET");
      assert.equal(status.ingressSealed, true);
      assert.equal(status.inFlightIngress, 0);
      assert.equal(status.postSealIngressAttemptCount, 1);
      assert.equal(status.rejectedRequestCount, 1);
      assert.equal(status.rejectionReasons.ingress_sealed, 1);
      assertSafeStatus(status, binding);
    } finally {
      releaseForward?.();
    }
  }, {
    testBeforeForward: async () => {
      if (!blockNextForward) return;
      blockNextForward = false;
      forwardStarted?.();
      await new Promise((resolve) => {
        releaseForward = resolve;
      });
    }
  });
}

async function verifyMismatchedToolAndSessionRejected() {
  const binding = fixtureBinding("IDENTITY_MISMATCH");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    const mismatchedTool = await postDecision(baseUrl, { ...binding, toolUseId: "TOOL_USE_CANARY_OTHER" });
    assert.equal(mismatchedTool.status, 409);
    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.decisionState, "ambiguous");
    assert.equal(status.heldNativeRejectionCount, 0);
    assert.equal(status.sourceBeforeClosedBoundary, false);
    assert.equal(status.rejectionReasons.native_rejection_binding, 1);
    assert.equal(status.nativeBindingFailureReasons.native_tool_identity_mismatch, 1);
  });

  const sessionBinding = fixtureBinding("SESSION_MISMATCH");
  await withRelay(sessionBinding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, sessionBinding);
    const mismatchedSession = await postDecision(baseUrl, {
      ...sessionBinding,
      session: "SESSION_CANARY_OTHER"
    });
    assert.equal(mismatchedSession.status, 409);
    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.decisionState, "ambiguous");
    assert.equal(status.heldNativeRejectionCount, 0);
    assert.equal(status.sourceBeforeClosedBoundary, false);
    assert.equal(status.rejectionReasons.native_rejection_binding, 1);
    assert.equal(status.nativeBindingFailureReasons.native_expected_session_mismatch, 1);
  });

  const rootSessionBinding = fixtureBinding("ROOT_SESSION_MISMATCH");
  await withRelay(rootSessionBinding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, rootSessionBinding);
    assert.equal((await postDecision(baseUrl, rootSessionBinding)).status, 200);
    assertSafeNegativeResponse(await postRootTrace(baseUrl, {
      ...rootSessionBinding,
      session: "SESSION_CANARY_OTHER"
    }));
    await assertCannotRelease(baseUrl);
  });
}

async function verifyMissingNativeSessionRejected() {
  const binding = fixtureBinding("NATIVE_SESSION_MISSING");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    const missingSession = await postDecision(baseUrl, { ...binding, session: undefined });
    assert.equal(missingSession.status, 409);
    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.decisionState, "ambiguous");
    assert.equal(status.pendingNativeRejectionCount, 0);
    assert.equal(status.heldNativeRejectionCount, 0);
    assert.equal(status.rejectionReasons.native_rejection_binding, 1);
    assert.equal(status.nativeBindingFailureReasons.native_session_missing, 1);
    assertSafeStatus(status, binding);
  });
}

async function verifyNativeToolIdentityAliasesBind() {
  for (const toolIdentityKey of ["gen_ai.tool.call.id", "tool.call.id"]) {
    const binding = fixtureBinding(`TOOL_ID_ALIAS_${toolIdentityKey.replaceAll(".", "_")}`);
    await withRelay(binding.session, async (baseUrl) => {
      await establishControlledWriteDenial(baseUrl, binding);
      assert.equal((await postDecision(baseUrl, binding, { toolIdentityKey })).status, 200);
      assert.equal((await postRootTrace(baseUrl, binding)).status, 200);
      await postStop(baseUrl, binding);

      const held = await control(baseUrl, "/control/status", "GET");
      assertHeldAndBound(held, binding);

      const released = await control(baseUrl, "/control/release", "POST");
      assertReleasedAndBound(released, binding);
    });
  }
}

async function verifyPromptMismatchesRemainDiagnostic() {
  const decisionBinding = fixtureBinding("DECISION_PROMPT_MISMATCH");
  await withRelay(decisionBinding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, decisionBinding);
    const mismatchedDecision = await postDecision(baseUrl, {
      ...decisionBinding,
      prompt: "PROMPT_CANARY_OTHER"
    });
    assert.equal(mismatchedDecision.status, 200);
    assert.equal((await postRootTrace(baseUrl, decisionBinding)).status, 200);
    await postStop(baseUrl, decisionBinding);
    const held = await control(baseUrl, "/control/status", "GET");
    assertHeldAndBound(held, decisionBinding, { promptIdentityConflictFree: false });
    const released = await control(baseUrl, "/control/release", "POST");
    assertReleasedAndBound(released, decisionBinding, { promptIdentityConflictFree: false });
  });

  const rootBinding = fixtureBinding("ROOT_PROMPT_MISMATCH");
  await withRelay(rootBinding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, rootBinding);
    assert.equal((await postDecision(baseUrl, rootBinding)).status, 200);
    assert.equal((await postRootTrace(baseUrl, {
      ...rootBinding,
      prompt: "PROMPT_CANARY_OTHER"
    })).status, 200);
    await postStop(baseUrl, rootBinding);
    const held = await control(baseUrl, "/control/status", "GET");
    assertHeldAndBound(held, rootBinding, { promptIdentityConflictFree: false });
    const released = await control(baseUrl, "/control/release", "POST");
    assertReleasedAndBound(released, rootBinding, { promptIdentityConflictFree: false });
  });

  const hookBinding = fixtureBinding("HOOK_PROMPT_MISMATCH");
  await withRelay(hookBinding.session, async (baseUrl) => {
    const prompt = await postHook(baseUrl, {
      hook_event_name: "UserPromptSubmit",
      session_id: hookBinding.session,
      prompt_id: hookBinding.prompt
    });
    assert.equal(prompt.status, 200);
    const mismatchedPreTool = await postHook(baseUrl, {
      hook_event_name: "PreToolUse",
      session_id: hookBinding.session,
      prompt_id: "PROMPT_CANARY_OTHER",
      tool_name: "Write",
      tool_use_id: hookBinding.toolUseId
    });
    assert.equal(mismatchedPreTool.status, 200);
    const thirdPrompt = { ...hookBinding, prompt: "PROMPT_CANARY_THIRD" };
    assert.equal((await postDecision(baseUrl, thirdPrompt)).status, 200);
    assert.equal((await postRootTrace(baseUrl, { ...hookBinding, prompt: "PROMPT_CANARY_FOURTH" })).status, 200);
    await postStop(baseUrl, { ...hookBinding, prompt: "PROMPT_CANARY_FIFTH" });
    const held = await control(baseUrl, "/control/status", "GET");
    assertHeldAndBound(held, hookBinding, { promptIdentityConflictFree: false });
    const released = await control(baseUrl, "/control/release", "POST");
    assertReleasedAndBound(released, hookBinding, { promptIdentityConflictFree: false });
  });
}

async function verifyPreStartDecisionCannotRelease() {
  const binding = fixtureBinding("PRE_START");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    assertSafeNegativeResponse(await postDecision(baseUrl, binding, { timestamp: "1735689599999999999" }));
    assertSafeNegativeResponse(await postRootTrace(baseUrl, binding));
    await assertCannotRelease(baseUrl);
  });
}

async function verifyPostEndDecisionCannotRelease() {
  const binding = fixtureBinding("POST_END");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    assertSafeNegativeResponse(await postDecision(baseUrl, binding, { timestamp: "1735689600000000005" }));
    assertSafeNegativeResponse(await postRootTrace(baseUrl, binding));
    await assertCannotRelease(baseUrl);
  });
}

async function verifyFractionalIsoPostEndDecisionCannotRelease() {
  const binding = fixtureBinding("FRACTIONAL_ISO_POST_END");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    assertSafeNegativeResponse(await postDecision(baseUrl, binding, {
      eventTimestamp: "2025-01-01T00:00:00.000000005Z"
    }));
    assertSafeNegativeResponse(await postRootTrace(baseUrl, binding));
    await assertCannotRelease(baseUrl);
  });
}

async function verifyMalformedDecisionCannotRelease() {
  const binding = fixtureBinding("MALFORMED_SOURCE");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    const malformed = await postDecision(baseUrl, binding, { timestamp: "not-a-nanosecond" });
    assertSafeNegativeResponse(malformed);
    await assertCannotRelease(baseUrl);
  });

  const invalidDateBinding = fixtureBinding("INVALID_RFC3339_DATE");
  await withRelay(invalidDateBinding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, invalidDateBinding);
    const invalidDate = await postDecision(baseUrl, invalidDateBinding, {
      eventTimestamp: "2025-02-30T00:00:00.000000002Z"
    });
    assert.equal(invalidDate.status, 409);
    await assertCannotRelease(baseUrl);
  });
}

async function verifyMalformedRootCannotRelease() {
  const binding = fixtureBinding("MALFORMED_ROOT");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    assert.equal((await postDecision(baseUrl, binding)).status, 200);
    assertSafeNegativeResponse(await postRootTrace(baseUrl, binding, { start: "not-a-nanosecond" }));
    await assertCannotRelease(baseUrl);
  });
}

async function verifyMixedValidAndMalformedRootCannotRelease() {
  const binding = fixtureBinding("MIXED_VALID_MALFORMED_ROOT");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    assert.equal((await postDecision(baseUrl, binding)).status, 200);
    assertSafeNegativeResponse(await postMixedRootTrace(baseUrl, binding));

    const status = await control(baseUrl, "/control/status", "GET");
    assert.equal(status.decisionState, "ambiguous");
    assert.equal(status.heldNativeRejectionCount, 0);
    assert.equal(status.sourceBeforeClosedBoundary, false);
    assertSafeStatus(status, binding);
    await assertCannotRelease(baseUrl);
  });
}

async function verifyInvalidTraceIdentifiersCannotRelease() {
  const cases = [
    { name: "MISSING_TRACE_ID", traceId: undefined },
    { name: "MALFORMED_TRACE_ID", traceId: "not-a-valid-trace-id" },
    { name: "MISSING_SPAN_ID", spanId: undefined },
    { name: "MALFORMED_SPAN_ID", spanId: "not-a-valid-span-id" }
  ];
  for (const testCase of cases) {
    const binding = fixtureBinding(testCase.name);
    await withRelay(binding.session, async (baseUrl) => {
      await establishControlledWriteDenial(baseUrl, binding);
      assert.equal((await postDecision(baseUrl, binding)).status, 200);
      assertSafeNegativeResponse(await postRootTrace(baseUrl, binding, testCase));
      await assertCannotRelease(baseUrl);
    });
  }
}

async function verifyHeldDecisionExpires() {
  const binding = fixtureBinding("EXPIRING");
  await withRelay(binding.session, async (baseUrl) => {
    await establishControlledWriteDenial(baseUrl, binding);
    assert.equal((await postDecision(baseUrl, binding)).status, 200);
    assert.equal((await postRootTrace(baseUrl, binding)).status, 200);
    await wait(180);
    const expired = await control(baseUrl, "/control/status", "GET");
    assert.equal(expired.decisionState, "expired");
    assert.equal(expired.heldNativeRejectionCount, 0);
    assert.equal(expired.expiredNativeRejectionCount, 1);
    assert.equal(expired.sourceBeforeClosedBoundary, false);
  }, { holdMs: 100 });
}

async function verifyPendingDecisionExpires() {
  const binding = fixtureBinding("PENDING_EXPIRING");
  await withRelay(binding.session, async (baseUrl) => {
    assert.equal((await postDecision(baseUrl, binding)).status, 200);
    await wait(180);
    const expired = await control(baseUrl, "/control/status", "GET");
    assert.equal(expired.decisionState, "expired");
    assert.equal(expired.pendingNativeRejectionCount, 0);
    assert.equal(expired.heldNativeRejectionCount, 0);
    assert.equal(expired.expiredNativeRejectionCount, 1);
    assert.equal(expired.sourceBeforeClosedBoundary, false);
    assertSafeStatus(expired, binding);
  }, { holdMs: 100 });
}

async function withRelay(session, test, { holdMs = 5_000, testBeforeForward } = {}) {
  const relay = await startClaudeDelayedDecisionRelay({
    targetBaseUrl,
    ingressToken,
    relayToken,
    controlToken,
    expectedSessionDigest: opaqueDigest(session),
    holdMs,
    testBeforeForward
  });
  try {
    await test(`http://127.0.0.1:${relay.port}`);
  } finally {
    await relay.close();
  }
}

function fixtureBinding(name) {
  const identifiers = createHash("sha256").update(`TRACE_CANARY_${name}`).digest("hex");
  return {
    session: `SESSION_CANARY_${name}`,
    prompt: `PROMPT_CANARY_${name}`,
    toolUseId: `TOOL_USE_CANARY_${name}`,
    traceId: identifiers.slice(0, 32),
    spanId: identifiers.slice(32, 48)
  };
}

async function establishControlledWriteDenial(baseUrl, binding) {
  const prompt = await postHook(baseUrl, {
    hook_event_name: "UserPromptSubmit",
    session_id: binding.session,
    prompt_id: binding.prompt
  });
  assert.equal(prompt.status, 200);

  const denied = await postHook(baseUrl, {
    hook_event_name: "PreToolUse",
    session_id: binding.session,
    prompt_id: binding.prompt,
    tool_name: "Write",
    tool_use_id: binding.toolUseId
  });
  assert.equal(denied.status, 200);
  assert.equal((await denied.json()).hookSpecificOutput.permissionDecision, "deny");
}

async function postStop(baseUrl, binding) {
  const stop = await postHook(baseUrl, {
    hook_event_name: "Stop",
    session_id: binding.session,
    prompt_id: binding.prompt
  });
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { targetAccepted: true });
}

async function postDecision(baseUrl, binding, {
  timestamp = decisionTimestamp,
  eventTimestamp,
  toolIdentityKey
} = {}) {
  return await postJson(baseUrl, "/v1/logs", logEnvelope([
    rejectedWriteDecisionRecord(binding, timestamp, eventTimestamp, toolIdentityKey)
  ]), ingressToken);
}

async function postRootTrace(baseUrl, binding, options = {}) {
  const {
    start = interactionStart,
    end = interactionEnd,
    parentSpanId = ""
  } = options;
  const traceId = Object.prototype.hasOwnProperty.call(options, "traceId")
    ? options.traceId
    : binding.traceId;
  const spanId = Object.prototype.hasOwnProperty.call(options, "spanId")
    ? options.spanId
    : binding.spanId;
  return await postJson(baseUrl, "/v1/traces", traceEnvelope(binding, {
    start,
    end,
    parentSpanId,
    traceId,
    spanId
  }), ingressToken);
}

async function postMixedRootTrace(baseUrl, binding) {
  const payload = traceEnvelope(binding, {
    start: interactionStart,
    end: interactionEnd,
    parentSpanId: "",
    traceId: binding.traceId,
    spanId: binding.spanId
  });
  payload.resourceSpans[0].scopeSpans[0].spans.push({
    name: "claude_code.interaction",
    parentSpanId: "",
    traceId: binding.traceId,
    spanId: "not-a-valid-span-id",
    startTimeUnixNano: interactionStart,
    endTimeUnixNano: interactionEnd,
    attributes: [
      attr("session.id", binding.session),
      attr("prompt.id", binding.prompt)
    ]
  });
  return await postJson(baseUrl, "/v1/traces", payload, ingressToken);
}

async function postHook(baseUrl, payload) {
  return await postJson(baseUrl, "/v1/provider-hooks/claude-code", payload, ingressToken, {
    "x-tirion-hook-event": payload.hook_event_name
  });
}

function assertHeldAndBound(status, binding, {
  promptIdentityObserved = true,
  promptIdentityConflictFree = true
} = {}) {
  assert.equal(status.heldNativeRejectionCount, 1);
  assert.equal(status.pendingNativeRejectionCount, 0);
  assert.equal(status.decisionState, "held");
  assert.equal(status.expectedSessionBound, true);
  assert.equal(status.promptIdentityConflictFree, promptIdentityConflictFree);
  assert.equal(status.promptIdentityObserved, promptIdentityObserved);
  assert.equal(status.sourceBeforeClosedBoundary, true);
  assert.equal(status.forwardedClosedRootTraceCount, 1);
  assert.equal(status.targetedPreToolWriteCount, 1);
  assert.equal(status.boundNativeRejectionCount, 1);
  assert.equal(status.rejectedRequestCount, 0);
  assertSafeStatus(status, binding);
}

function assertReleasedAndBound(status, binding, {
  promptIdentityObserved = true,
  promptIdentityConflictFree = true
} = {}) {
  assert.equal(status.heldNativeRejectionCount, 0);
  assert.equal(status.pendingNativeRejectionCount, 0);
  assert.equal(status.decisionState, "released");
  assert.equal(status.expectedSessionBound, true);
  assert.equal(status.promptIdentityConflictFree, promptIdentityConflictFree);
  assert.equal(status.promptIdentityObserved, promptIdentityObserved);
  assert.equal(status.sourceBeforeClosedBoundary, true);
  assert.equal(status.releasedNativeRejectionCount, 1);
  assert.equal(status.forwardedClosedRootTraceCount, 1);
  assert.equal(status.rejectedRequestCount, 0);
  assertSafeStatus(status, binding);
}

function assertSafeNegativeResponse(response) {
  assert.ok(response.status === 200 || response.status === 409, `unexpected_negative_status:${response.status}`);
}

async function assertCannotRelease(baseUrl) {
  const before = await control(baseUrl, "/control/status", "GET");
  assert.notEqual(before.decisionState, "released");
  assert.equal(before.sourceBeforeClosedBoundary, false);
  const release = await fetch(`${baseUrl}/control/release`, {
    method: "POST",
    headers: { "x-tirion-relay-control": controlToken }
  });
  assert.equal(release.status, 409);
  const after = await control(baseUrl, "/control/status", "GET");
  assert.notEqual(after.decisionState, "released");
  assert.equal(after.heldNativeRejectionCount, 0);
  assert.equal(after.sourceBeforeClosedBoundary, false);
}

function logEnvelope(records) {
  return {
    resourceLogs: [{
      resource: { attributes: [attr("service.name", "claude-code")] },
      scopeLogs: [{
        scope: { name: "claude-code" },
        logRecords: records
      }]
    }]
  };
}

function genericToolRecord() {
  return {
    timeUnixNano: "1735689600000000000",
    attributes: [
      attr("event.name", "claude_code.tool"),
      attr("tool_name", "Write"),
      attr("tool_use_id", "TOOL_USE_CANARY_WRITE")
    ]
  };
}

function acceptedDecisionRecord() {
  return {
    timeUnixNano: "1735689600000000001",
    attributes: [
      attr("event.name", "claude_code.tool_decision"),
      attr("decision", "accept"),
      attr("tool_name", "Read"),
      attr("tool_use_id", "TOOL_USE_CANARY_READ")
    ]
  };
}

function rejectedWriteDecisionRecord(binding, timestamp, eventTimestamp, toolIdentityKey = "tool_use_id") {
  const attributes = [
    attr("event.name", "claude_code.tool_decision"),
    attr("decision", "reject"),
    attr("tool_name", "Write"),
    attr(toolIdentityKey, binding.toolUseId)
  ];
  if (typeof binding.session === "string") attributes.push(attr("session.id", binding.session));
  if (typeof binding.prompt === "string") attributes.push(attr("prompt.id", binding.prompt));
  if (eventTimestamp != null) attributes.push(attr("event.timestamp", eventTimestamp));
  return {
    timeUnixNano: timestamp,
    attributes,
    body: { stringValue: "PRIVATE_RELAY_CANARY_DO_NOT_PERSIST" }
  };
}

function traceEnvelope(binding, { start, end, parentSpanId, traceId, spanId }) {
  const span = {
    name: "claude_code.interaction",
    parentSpanId,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: [
      attr("session.id", binding.session),
      ...(typeof binding.prompt === "string" ? [attr("prompt.id", binding.prompt)] : [])
    ]
  };
  if (traceId !== undefined) span.traceId = traceId;
  if (spanId !== undefined) span.spanId = spanId;
  return {
    resourceSpans: [{
      resource: { attributes: [attr("service.name", "claude-code")] },
      scopeSpans: [{
        scope: { name: "claude-code" },
        spans: [span]
      }]
    }]
  };
}

function ordinaryRecord() {
  return {
    timeUnixNano: "1735689600000000003",
    attributes: [attr("event.name", "claude_code.assistant_response")]
  };
}

function attr(key, value) {
  return { key, value: { stringValue: value } };
}

function summarize(path, payload) {
  if (path === "/v1/provider-hooks/claude-code") {
    return { path, hook: payload.hook_event_name, tool: payload.tool_name };
  }
  const record = payload.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0];
  const attributes = Object.fromEntries((record?.attributes ?? []).map((entry) => [entry.key, entry.value?.stringValue]));
  return { path, name: attributes["event.name"], decision: attributes.decision, tool: attributes.tool_name };
}

function opaqueDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeStatus(status, binding) {
  const serialized = JSON.stringify(status);
  const forbidden = [
    binding.session,
    binding.toolUseId,
    binding.traceId,
    binding.spanId,
    opaqueDigest(binding.session),
    "PRIVATE_RELAY_CANARY"
  ];
  if (typeof binding.prompt === "string") {
    forbidden.push(binding.prompt, opaqueDigest(binding.prompt));
  }
  for (const value of forbidden) {
    assert.equal(serialized.includes(value), false);
  }
}

async function postJson(baseUrl, path, payload, token, additionalHeaders = {}) {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-tirion-cc15c-relay": relayToken,
      ...additionalHeaders
    },
    body: JSON.stringify(payload)
  });
}

async function control(baseUrl, path, method) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "x-tirion-relay-control": controlToken }
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
