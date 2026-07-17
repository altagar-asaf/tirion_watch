#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { startClaudeDelayedDecisionReceiver } from "./claude_delayed_decision_receiver.mjs";

const deliveryToken = "receiver-delivery-token-0123456789";
const hmacSecret = "receiver-hmac-secret-0123456789";
const controlToken = "receiver-control-token-0123456789";
const privacyCanary = "PRIVATE_RECEIVER_CANARY";
const rawSession = "CC15C_RECEIVER_RAW_SESSION_0001";
const expectedSessionId = webhookSessionId(rawSession);
const startedAt = "2026-07-14T00:00:00.000Z";
const endedAt = "2026-07-14T00:00:01.000Z";
let now = 1_000;

const receiver = await startClaudeDelayedDecisionReceiver({
  deliveryToken,
  hmacSecret,
  controlToken,
  expectedSessionId,
  privacyCanary,
  monotonicNow: () => now
});
const baseUrl = `http://127.0.0.1:${receiver.port}`;

try {
  const unauthorized = await sendEvent(baseUrl, terminalEvent("evt_unauthorized_0001", 1, "unknown"), "wrong-token-0123456789");
  assert.equal(unauthorized.status, 401);

  assert.equal((await sendEvent(baseUrl, startEvent())).status, 200);
  assert.equal((await sendEvent(baseUrl, terminalEvent("evt_terminal_0000001", 1, "unknown"))).status, 200);
  now += 10;
  assert.equal((await sendEvent(baseUrl, terminalEvent("evt_terminal_0000002", 2, "rejected"))).status, 200);

  const noControl = await fetch(`${baseUrl}/control/status`);
  assert.equal(noControl.status, 401);
  let status = await controlled(baseUrl, "/control/status", "GET");
  assert.equal(status.expectedSessionBound, true);
  assert.equal(status.forbiddenPayloadDetected, false);
  assert.equal(status.runs.length, 1);
  let run = status.runs[0];
  assert.equal(run.alias, "run_001");
  assert.equal(run.runStartCount, 1);
  assert.equal(run.updatesAfterFirstTerminal, 0);
  assert.equal(run.startBeforeFirstTerminal, true);
  assert.equal(run.stableStartedAt, true);
  assert.equal(run.stableRepository, true);
  assert.equal(run.stableSession, true);
  assert.equal(run.expectedSessionBound, true);
  assert.equal(run.expectedSessionMatch, true);
  assert.equal(run.completeLifecycleIdentity, true);
  assert.equal(run.claudeCodeRuntime, true);
  assert.equal(run.completedTerminalState, true);
  assert.equal(run.completeTerminalBoundary, true);
  assert.equal(run.stableTerminalBoundary, true);
  assert.equal(run.baselineTerminalReceiptCaptured, true);
  assert.equal(run.allCorrectionsWithinCorrectionWindow, true);
  assert.equal(run.strictLifecycleClaimsSafe, true);
  assert.equal(run.strictUpdateActivityClaimsSafe, true);
  assert.equal(run.strictTerminalActivityClaimsSafe, true);
  assert.equal(run.strictFileAndCommitClaimsSafe, true);
  assert.equal(run.validTerminalVersions, true);
  assert.equal(run.terminalHistoryOverflow, false);
  assert.equal(run.usageOrCostChangedFromFirstTerminal, false);
  assert.deepEqual(run.terminalVersions.map((terminal) => terminal.version), [1, 2]);
  assert.deepEqual(run.terminalVersions.map((terminal) => terminal.deliveredWithinCorrectionWindow), [true, true]);
  assert.equal(run.terminalVersions[0].unknownWriteCount, 1);
  assert.equal(run.terminalVersions[0].rootSpanEvidence, true);
  assert.equal(run.terminalVersions[0].validWriteActivityEvidence, true);
  assert.equal(run.terminalVersions[0].writeActivityCount, 1);
  assert.equal(run.terminalVersions[0].nonRejectedWriteCount, 1);
  assert.equal(run.terminalVersions[0].writeExecutionGrant, false);
  assert.equal(run.terminalVersions[0].rejectedWriteCount, 0);
  assert.equal(run.terminalVersions[0].nonWriteToolCount, 0);
  assert.equal(run.terminalVersions[0].nonWriteToolExecutionGrant, false);
  assert.equal(run.terminalVersions[1].rejectedWriteCount, 1);
  assert.equal(run.terminalVersions[1].rejectedWriteFailureCount, 1);
  assert.equal(run.terminalVersions[1].rejectedWriteRejectionCount, 1);
  assert.equal(run.terminalVersions[1].rejectedWriteExecutionGrant, false);
  assert.equal(run.terminalVersions[1].strictCc15cActivityClaimsSafe, true);

  // A literal raw scan is insufficient: this body contains the canary only
  // through JSON Unicode escapes, which must still set the sticky safe flag.
  now += 10;
  const escapedCanary = await sendEscapedCanary(baseUrl, terminalEvent("evt_terminal_0000003", 3, "unknown"));
  assert.equal(escapedCanary.status, 422);
  status = await controlled(baseUrl, "/control/status", "GET");
  assert.equal(status.forbiddenPayloadDetected, true);
  assert.equal(JSON.stringify(status).includes(privacyCanary), false);
  assert.equal(JSON.stringify(status).includes(rawSession), false);

  // The correction deadline is measured from the first terminal receipt, not
  // its provider timestamp. This injected monotonic clock avoids a real wait.
  now += 15_001;
  assert.equal((await sendEvent(baseUrl, terminalEvent("evt_terminal_0000004", 3, "unknown"))).status, 200);
  status = await controlled(baseUrl, "/control/status", "GET");
  run = status.runs[0];
  assert.equal(run.allCorrectionsWithinCorrectionWindow, false);
  assert.equal(run.terminalVersions.at(-1)?.deliveredWithinCorrectionWindow, false);

  const duplicate = await sendEvent(baseUrl, terminalEvent("evt_terminal_0000004", 3, "unknown"));
  assert.equal(duplicate.status, 409);
  const invalidSignature = await fetch(`${baseUrl}/webhooks/tirion`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deliveryToken}`,
      "content-type": "application/json",
      "x-tirion-timestamp": "1",
      "x-tirion-signature-256": "sha256=" + "0".repeat(64)
    },
    body: JSON.stringify(terminalEvent("evt_bad_signature_01", 5, "unknown"))
  });
  assert.equal(invalidSignature.status, 401);
} finally {
  await receiver.close();
}

await verifyExpectedSessionMismatch();
await verifyAdditionalToolSummary();
await verifyStrictClaimAllowlist();
await verifySealWaitsForSlowPreSealWebhook();
await verifySealRejectsLateWebhook();
process.stdout.write("claude delayed decision receiver self-test passed\n");

async function verifyExpectedSessionMismatch() {
  const mismatchReceiver = await startClaudeDelayedDecisionReceiver({
    deliveryToken,
    hmacSecret,
    controlToken,
    expectedSessionId
  });
  const mismatchBaseUrl = `http://127.0.0.1:${mismatchReceiver.port}`;
  try {
    const mismatched = startEvent({ sessionId: webhookSessionId("CC15C_OTHER_RAW_SESSION_0001") });
    assert.equal((await sendEvent(mismatchBaseUrl, mismatched)).status, 200);
    const status = await controlled(mismatchBaseUrl, "/control/status", "GET");
    assert.equal(status.expectedSessionBound, true);
    assert.equal(status.runs[0]?.expectedSessionMatch, false);
  } finally {
    await mismatchReceiver.close();
  }
}

async function verifyAdditionalToolSummary() {
  const toolReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const toolBaseUrl = `http://127.0.0.1:${toolReceiver.port}`;
  try {
    assert.equal((await sendEvent(toolBaseUrl, startEvent({ sessionId: webhookSessionId("CC15C_TOOL_RAW_SESSION_0001") }))).status, 200);
    const event = terminalEvent("evt_extra_tool_000001", 1, "unknown", {
      sessionId: webhookSessionId("CC15C_TOOL_RAW_SESSION_0001"),
      activity: [
        activity("Write", "unknown"),
        { ...activity("Bash", "success"), durationMs: 2 },
        unallocatedUsageActivity()
      ]
    });
    assert.equal((await sendEvent(toolBaseUrl, event)).status, 200);
    const status = await controlled(toolBaseUrl, "/control/status", "GET");
    const terminal = status.runs[0]?.terminalVersions[0];
    assert.equal(terminal?.validNonWriteToolActivityCounts, true);
    assert.equal(terminal?.nonWriteToolCount, 1);
    assert.equal(terminal?.nonWriteToolExecutionGrant, true);
    assert.equal(terminal?.strictCc15cActivityClaimsSafe, false);
    assert.equal(status.runs[0]?.strictTerminalActivityClaimsSafe, false);
  } finally {
    await toolReceiver.close();
  }
}

async function verifyStrictClaimAllowlist() {
  const strictReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const strictBaseUrl = `http://127.0.0.1:${strictReceiver.port}`;
  try {
    const sessionId = webhookSessionId("CC15C_STRICT_RAW_SESSION_0001");
    assert.equal((await sendEvent(strictBaseUrl, startEvent({ sessionId, eventId: "evt_strict_start_000001" }))).status, 200);

    const invalidState = updateEvent("evt_strict_invalid_state", {
      sessionId,
      state: "completed"
    });
    assert.equal((await sendEvent(strictBaseUrl, invalidState)).status, 422);

    const invalidFileClaim = updateEvent("evt_strict_invalid_file", {
      sessionId,
      filesChanged: ["cc15c-denied.txt"]
    });
    assert.equal((await sendEvent(strictBaseUrl, invalidFileClaim)).status, 422);
    const invalidStatus = await controlled(strictBaseUrl, "/control/status", "GET");
    assert.equal(invalidStatus.rejectedRequestCount, 2);
  } finally {
    await strictReceiver.close();
  }

  const updateReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const updateBaseUrl = `http://127.0.0.1:${updateReceiver.port}`;
  try {
    const sessionId = webhookSessionId("CC15C_UPDATE_RAW_SESSION_0001");
    assert.equal((await sendEvent(updateBaseUrl, startEvent({ sessionId, eventId: "evt_update_start_000001" }))).status, 200);
    const executedUpdate = updateEvent("evt_update_executed_write", {
      sessionId,
      activity: [
        { ...activity("Write", "success"), durationMs: 0 },
        unallocatedUsageActivity()
      ]
    });
    assert.equal((await sendEvent(updateBaseUrl, executedUpdate)).status, 200);
    const prematureRejection = updateEvent("evt_update_premature_reject", {
      sessionId,
      activity: [activity("Write", "rejected"), unallocatedUsageActivity()]
    });
    assert.equal((await sendEvent(updateBaseUrl, prematureRejection)).status, 200);
    const status = await controlled(updateBaseUrl, "/control/status", "GET");
    assert.equal(status.runs[0]?.strictUpdateActivityClaimsSafe, false);
    assert.equal(status.runs[0]?.strictLifecycleClaimsSafe, false);
  } finally {
    await updateReceiver.close();
  }

  const forgedLlmReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const forgedLlmBaseUrl = `http://127.0.0.1:${forgedLlmReceiver.port}`;
  try {
    const sessionId = webhookSessionId("CC15C_FORGED_LLM_RAW_SESSION_0001");
    assert.equal((await sendEvent(forgedLlmBaseUrl, startEvent({ sessionId, eventId: "evt_llm_start_0000000001" }))).status, 200);
    // Schema-valid LLM-shaped rows must not smuggle an extra Write execution
    // through the general activity channel before the native correction.
    const forgedUpdate = updateEvent("evt_llm_forged_update_01", {
      sessionId,
      activity: [
        {
          ...activity("Write", "success"),
          kind: "llm_request",
          endedAt,
          durationMs: 1,
          resultSizeBytes: 1,
          providerReportedResultTokens: 1
        },
        unallocatedUsageActivity()
      ]
    });
    assert.equal((await sendEvent(forgedLlmBaseUrl, forgedUpdate)).status, 200);
    let status = await controlled(forgedLlmBaseUrl, "/control/status", "GET");
    assert.equal(status.runs[0]?.strictUpdateActivityClaimsSafe, false);
    assert.equal(status.runs[0]?.strictLifecycleClaimsSafe, false);

    // The same disguise cannot be added alongside the exact rejected Write in
    // the terminal correction either.
    const forgedTerminal = terminalEvent("evt_llm_forged_terminal", 1, "rejected", {
      sessionId,
      activity: [
        activity("Write", "rejected"),
        { ...activity("Bash", "success"), kind: "llm_request", endedAt, durationMs: 1 },
        unallocatedUsageActivity()
      ]
    });
    assert.equal((await sendEvent(forgedLlmBaseUrl, forgedTerminal)).status, 200);
    status = await controlled(forgedLlmBaseUrl, "/control/status", "GET");
    assert.equal(status.runs[0]?.strictTerminalActivityClaimsSafe, false);
    assert.equal(status.runs[0]?.terminalVersions[0]?.strictCc15cActivityClaimsSafe, false);
  } finally {
    await forgedLlmReceiver.close();
  }

  const rejectionReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const rejectionBaseUrl = `http://127.0.0.1:${rejectionReceiver.port}`;
  try {
    const sessionId = webhookSessionId("CC15C_REJECTION_RAW_SESSION_0001");
    assert.equal((await sendEvent(rejectionBaseUrl, startEvent({ sessionId, eventId: "evt_rejection_start_001" }))).status, 200);
    const zeroValuedExecution = terminalEvent("evt_rejection_zero_execution", 1, "rejected", {
      sessionId,
      activity: [
        { ...activity("Write", "rejected"), endedAt: endedAt, durationMs: 0, totalTokens: 0 },
        unallocatedUsageActivity()
      ]
    });
    assert.equal((await sendEvent(rejectionBaseUrl, zeroValuedExecution)).status, 200);
    const status = await controlled(rejectionBaseUrl, "/control/status", "GET");
    assert.equal(status.runs[0]?.strictTerminalActivityClaimsSafe, false);
    assert.equal(status.runs[0]?.terminalVersions[0]?.strictCc15cActivityClaimsSafe, false);
  } finally {
    await rejectionReceiver.close();
  }

  const changedClaimReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const changedClaimBaseUrl = `http://127.0.0.1:${changedClaimReceiver.port}`;
  try {
    const sessionId = webhookSessionId("CC15C_CHANGED_CLAIM_RAW_SESSION_001");
    assert.equal((await sendEvent(changedClaimBaseUrl, startEvent({ sessionId, eventId: "evt_claim_start_00000001" }))).status, 200);
    assert.equal((await sendEvent(changedClaimBaseUrl, terminalEvent("evt_claim_baseline_00001", 1, "unknown", { sessionId }))).status, 200);
    const changedUsage = {
      inputTokens: 40,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 90
    };
    const changedCorrection = terminalEvent("evt_claim_correction_01", 2, "rejected", {
      sessionId,
      ...changedUsage,
      estimatedNanoUsd: 120,
      usageValueNanoUsd: 120,
      costEstimateBasis: "provider_reported_estimate",
      costCoverage: "complete",
      coverage: coverage("final", "complete_for_reported_surface", "complete"),
      llmModels: ["claude-test-model"],
      context: {
        schemaVersion: 1,
        accumulatedInputTokens: 40,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        observedLlmRequestCount: 1,
        basis: "provider_reported_input_tokens",
        coverage: "final"
      },
      activity: [activity("Write", "rejected"), unallocatedUsageActivity(changedUsage)]
    });
    assert.equal((await sendEvent(changedClaimBaseUrl, changedCorrection)).status, 200);
    const status = await controlled(changedClaimBaseUrl, "/control/status", "GET");
    assert.equal(status.runs[0]?.terminalVersions[0]?.nonDecisionClaimsMatchPrevious, true);
    assert.equal(status.runs[0]?.terminalVersions[1]?.nonDecisionClaimsMatchPrevious, false);
  } finally {
    await changedClaimReceiver.close();
  }

  const changedOutcomeReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const changedOutcomeBaseUrl = `http://127.0.0.1:${changedOutcomeReceiver.port}`;
  try {
    const sessionId = webhookSessionId("CC15C_CHANGED_OUTCOME_RAW_SESSION_1");
    assert.equal((await sendEvent(changedOutcomeBaseUrl, startEvent({ sessionId, eventId: "evt_outcome_start_0000001" }))).status, 200);
    assert.equal((await sendEvent(changedOutcomeBaseUrl, terminalEvent("evt_outcome_baseline_000", 1, "unknown", {
      sessionId,
      outcome: "success"
    }))).status, 200);
    assert.equal((await sendEvent(changedOutcomeBaseUrl, terminalEvent("evt_outcome_correction_00", 2, "rejected", {
      sessionId,
      outcome: "failure"
    }))).status, 200);
    const status = await controlled(changedOutcomeBaseUrl, "/control/status", "GET");
    assert.equal(status.runs[0]?.terminalVersions[1]?.nonDecisionClaimsMatchPrevious, false);
  } finally {
    await changedOutcomeReceiver.close();
  }

  const mcpReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const mcpBaseUrl = `http://127.0.0.1:${mcpReceiver.port}`;
  try {
    const sessionId = webhookSessionId("CC15C_MCP_RAW_SESSION_0001");
    assert.equal((await sendEvent(mcpBaseUrl, startEvent({ sessionId, eventId: "evt_mcp_start_00000001" }))).status, 200);
    const mcpTerminal = terminalEvent("evt_mcp_terminal_000001", 1, "unknown", {
      sessionId,
      activity: [
        activity("Write", "unknown"),
        { ...activity("metadata.lookup", "success"), kind: "mcp", durationMs: 5 },
        unallocatedUsageActivity()
      ]
    });
    assert.equal((await sendEvent(mcpBaseUrl, mcpTerminal)).status, 200);
    const status = await controlled(mcpBaseUrl, "/control/status", "GET");
    assert.equal(status.runs[0]?.strictTerminalActivityClaimsSafe, false);
    assert.equal(status.runs[0]?.terminalVersions[0]?.strictCc15cActivityClaimsSafe, false);
  } finally {
    await mcpReceiver.close();
  }

  const fileReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const fileBaseUrl = `http://127.0.0.1:${fileReceiver.port}`;
  try {
    const sessionId = webhookSessionId("CC15C_FILE_RAW_SESSION_0001");
    assert.equal((await sendEvent(fileBaseUrl, startEvent({ sessionId, eventId: "evt_file_start_0000001" }))).status, 200);
    const fileTerminal = terminalEvent("evt_file_terminal_00001", 1, "unknown", {
      sessionId,
      filesChanged: ["cc15c-denied.txt"]
    });
    assert.equal((await sendEvent(fileBaseUrl, fileTerminal)).status, 200);
    const status = await controlled(fileBaseUrl, "/control/status", "GET");
    assert.equal(status.runs[0]?.strictFileAndCommitClaimsSafe, false);
    assert.equal(status.runs[0]?.strictLifecycleClaimsSafe, false);
  } finally {
    await fileReceiver.close();
  }
}

async function verifySealRejectsLateWebhook() {
  const sealedReceiver = await startClaudeDelayedDecisionReceiver({ deliveryToken, hmacSecret, controlToken });
  const sealedBaseUrl = `http://127.0.0.1:${sealedReceiver.port}`;
  try {
    const sealed = await controlled(sealedBaseUrl, "/control/seal", "POST");
    assert.equal(sealed.webhookSealed, true);
    assert.equal(sealed.inFlightWebhookCount, 0);
    assert.equal(sealed.postSealWebhookAttemptCount, 0);

    const late = await sendEvent(sealedBaseUrl, startEvent({ eventId: "evt_sealed_late_start" }));
    assert.equal(late.status, 409);
    const status = await controlled(sealedBaseUrl, "/control/status", "GET");
    assert.equal(status.webhookSealed, true);
    assert.equal(status.inFlightWebhookCount, 0);
    assert.equal(status.postSealWebhookAttemptCount, 1);
    assert.equal(status.rejectedRequestCount, 1);
    assert.equal(JSON.stringify(status).includes(privacyCanary), false);
  } finally {
    await sealedReceiver.close();
  }
}

async function verifySealWaitsForSlowPreSealWebhook() {
  let releaseAcceptance;
  let acceptanceStarted;
  const acceptanceStartedPromise = new Promise((resolve) => {
    acceptanceStarted = resolve;
  });
  let blockNextAccept = true;
  const slowReceiver = await startClaudeDelayedDecisionReceiver({
    deliveryToken,
    hmacSecret,
    controlToken,
    testBeforeAccept: async () => {
      if (!blockNextAccept) return;
      blockNextAccept = false;
      acceptanceStarted?.();
      await new Promise((resolve) => {
        releaseAcceptance = resolve;
      });
    }
  });
  const slowBaseUrl = `http://127.0.0.1:${slowReceiver.port}`;
  try {
    const preSealWebhook = sendEvent(slowBaseUrl, startEvent({ eventId: "evt_slow_preseal_start" }));
    await Promise.race([
      acceptanceStartedPromise,
      wait(1_000).then(() => {
        throw new Error("slow_preseal_webhook_not_started");
      })
    ]);

    let sealResolved = false;
    const sealing = controlled(slowBaseUrl, "/control/seal", "POST").then((status) => {
      sealResolved = true;
      return status;
    });
    await wait(20);
    assert.equal(sealResolved, false);

    releaseAcceptance?.();
    assert.equal((await preSealWebhook).status, 200);
    const sealed = await sealing;
    assert.equal(sealed.webhookSealed, true);
    assert.equal(sealed.inFlightWebhookCount, 0);
    assert.equal(sealed.postSealWebhookAttemptCount, 0);

    const lateWebhook = await sendEvent(slowBaseUrl, startEvent({ eventId: "evt_slow_postseal_start" }));
    assert.equal(lateWebhook.status, 409);
    const status = await controlled(slowBaseUrl, "/control/status", "GET");
    assert.equal(status.webhookSealed, true);
    assert.equal(status.inFlightWebhookCount, 0);
    assert.equal(status.postSealWebhookAttemptCount, 1);
    assert.equal(status.rejectedRequestCount, 1);
    assert.equal(JSON.stringify(status).includes(privacyCanary), false);
  } finally {
    releaseAcceptance?.();
    await slowReceiver.close();
  }
}

function startEvent(overrides = {}) {
  return {
    ...eventBase(),
    schemaVersion: 1,
    eventType: "run.start",
    eventId: "evt_start_00000000001",
    runId: "run_receiver_00000001",
    sessionId: expectedSessionId,
    sequence: 1,
    updatedAt: startedAt,
    state: "running",
    llmModels: [],
    ...overrides
  };
}

function terminalEvent(eventId, version, outcome, overrides = {}) {
  return {
    ...eventBase(),
    schemaVersion: 1,
    eventType: "run.ended",
    eventId,
    runId: "run_receiver_00000001",
    sessionId: expectedSessionId,
    version,
    filesChanged: [],
    inputTokens: 4,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 9,
    estimatedNanoUsd: 12,
    costEstimateBasis: "unavailable",
    costCoverage: "unavailable",
    llmModels: [],
    endedAt,
    state: "completed",
    activity: [activity("Write", outcome), unallocatedUsageActivity()],
    ...overrides
  };
}

function updateEvent(eventId, overrides = {}) {
  return {
    ...eventBase(),
    schemaVersion: 1,
    eventType: "run.update",
    eventId,
    runId: "run_receiver_00000001",
    sessionId: expectedSessionId,
    sequence: 2,
    updatedAt: endedAt,
    state: "running",
    inputTokens: 4,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 9,
    llmModels: [],
    estimatedNanoUsd: 12,
    costEstimateBasis: "unavailable",
    costCoverage: "unavailable",
    coverage: coverage("complete_so_far", "partial"),
    activity: [unallocatedUsageActivity()],
    ...overrides
  };
}

function eventBase() {
  return {
    traceIds: ["trace_receiver_000001"],
    sender: { installationId: "sender_receiver_000001" },
    repository: {
      repoKey: "repo_receiver_0000001",
      owner: "tirion",
      name: "receiver",
      fullName: "tirion/receiver"
    },
    codingHarness: "claude-code",
    runtime: "claude-code",
    startedAt,
    evidence: evidence("root_span"),
    coverage: coverage("final", "complete_for_reported_surface")
  };
}

function evidence(basis) {
  return {
    basis,
    sourceId: "source_receiver_000001",
    profileVersion: "profile_receiver_v1",
    observedAt: endedAt,
    delayed: false,
    identityConfidence: "high",
    timingConfidence: "high"
  };
}

function coverage(usageCoverage, activityCoverage, costCoverage = "unavailable") {
  return { usageCoverage, activityCoverage, costCoverage };
}

function activity(name, outcome) {
  return {
    activityId: `activity_${name.toLowerCase()}_${outcome}_000001`,
    name,
    kind: "tool",
    evidence: evidence("otel_event"),
    outcome,
    count: 1,
    failureCount: outcome === "rejected" ? 1 : 0,
    startedAt,
    ...(outcome === "rejected" ? { rejectedCount: 1 } : {})
  };
}

function unallocatedUsageActivity(overrides = {}) {
  return {
    activityId: "activity_unallocated_receiver_000001",
    kind: "unknown",
    name: "Unallocated run usage",
    outcome: "unknown",
    count: 1,
    failureCount: 0,
    startedAt,
    inputTokens: 4,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 9,
    usageAttributionBasis: "unavailable",
    usageCoverage: "unavailable",
    evidence: evidence("root_span"),
    ...overrides
  };
}

async function sendEscapedCanary(baseUrl, event) {
  const placeholder = "CC15C_ESCAPED_PLACEHOLDER";
  const serialized = JSON.stringify({ ...event, safeNote: placeholder });
  const escaped = [...privacyCanary].map((character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`).join("");
  return await sendSerialized(baseUrl, serialized.replace(placeholder, escaped));
}

async function sendEvent(baseUrl, event, token = deliveryToken) {
  return await sendSerialized(baseUrl, JSON.stringify(event), token);
}

async function sendSerialized(baseUrl, serialized, token = deliveryToken) {
  const body = Buffer.from(serialized);
  const timestamp = "1700000000";
  const signature = `sha256=${createHmac("sha256", hmacSecret).update(timestamp).update(".").update(body).digest("hex")}`;
  try {
    return await fetch(`${baseUrl}/webhooks/tirion`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-tirion-timestamp": timestamp,
        "x-tirion-signature-256": signature
      },
      body
    });
  } finally {
    body.fill(0);
  }
}

async function controlled(baseUrl, path, method) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "x-tirion-cc15c-control": controlToken }
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function webhookSessionId(rawSessionId) {
  return `ses_${createHash("sha256").update(`claude-code|${rawSessionId}`).digest("hex")}`;
}
