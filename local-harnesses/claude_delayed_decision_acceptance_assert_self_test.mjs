#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "claude_delayed_decision_acceptance_assert.mjs");

const held = relayStatus("held");
const heldResult = verify(["relay-held"], held, 0);
assert.equal(JSON.parse(heldResult.stdout).relay.forwardedTraceRequestCount, 1);

const heldDiagnostic = verify(["relay-diagnostic"], held, 0);
assert.equal(JSON.parse(heldDiagnostic.stdout).diagnostic, "relay_held_assertion_failed");

const missingPromptDiagnostic = relayStatus("awaiting");
missingPromptDiagnostic.forwardedHookEvents.userPromptSubmit = 0;
assert.equal(
  JSON.parse(verify(["relay-diagnostic"], missingPromptDiagnostic, 0).stdout).diagnostic,
  "user_prompt_submit_count"
);

const missingLogDiagnostic = relayStatus("awaiting");
missingLogDiagnostic.forwardedLogRecordCount = 0;
assert.equal(
  JSON.parse(verify(["relay-diagnostic"], missingLogDiagnostic, 0).stdout).diagnostic,
  "generic_log_absent"
);

const missingNativeDecisionDiagnostic = relayStatus("awaiting");
missingNativeDecisionDiagnostic.boundNativeRejectionCount = 0;
missingNativeDecisionDiagnostic.heldNativeRejectionCount = 0;
assert.equal(
  JSON.parse(verify(["relay-diagnostic"], missingNativeDecisionDiagnostic, 0).stdout).diagnostic,
  "native_rejection_absent"
);

const pendingNativeDecisionDiagnostic = relayStatus("awaiting");
pendingNativeDecisionDiagnostic.heldNativeRejectionCount = 0;
pendingNativeDecisionDiagnostic.pendingNativeRejectionCount = 1;
pendingNativeDecisionDiagnostic.boundNativeRejectionCount = 0;
assert.equal(
  JSON.parse(verify(["relay-diagnostic"], pendingNativeDecisionDiagnostic, 0).stdout).diagnostic,
  "native_rejection_pending_control"
);

for (const [reason, expectedDiagnostic] of [
  ["expected_session_missing", "relay_binding_expected_session_missing"],
  ["native_session_missing", "relay_binding_native_session_missing"],
  ["native_source_time_missing", "relay_binding_native_source_time_missing"],
  ["native_expected_session_mismatch", "relay_binding_native_expected_session_mismatch"],
  ["targeted_pretool_write_cardinality", "relay_binding_pretool_write_cardinality"],
  ["denied_tool_identity_missing", "relay_binding_denied_tool_identity_missing"],
  ["submission_session_missing", "relay_binding_submission_session_missing"],
  ["expected_session_unbound", "relay_binding_expected_session_unbound"],
  ["native_tool_identity_mismatch", "relay_binding_native_tool_identity_mismatch"],
  ["native_submission_session_mismatch", "relay_binding_native_submission_session_mismatch"]
]) {
  const rejected = relayStatus("awaiting");
  rejected.rejectedRequestCount = 1;
  rejected.rejectionReasons.native_rejection_binding = 1;
  rejected.nativeBindingFailureReasons[reason] = 1;
  assert.equal(
    JSON.parse(verify(["relay-diagnostic"], rejected, 0).stdout).diagnostic,
    expectedDiagnostic
  );
}

for (const [reason, expectedDiagnostic] of [
  ["control_auth", "relay_control_auth"],
  ["ingress_sealed", "relay_ingress_sealed"],
  ["unsupported_metrics_request", "relay_unsupported_metrics_request"],
  ["unsupported_path", "relay_unsupported_path"],
  ["ingress_auth", "relay_ingress_auth"],
  ["relay_auth", "relay_custom_header_auth"],
  ["content_type", "relay_content_type"],
  ["empty_log_payload", "relay_empty_log_payload"],
  ["duplicate_native_rejection", "relay_duplicate_native_rejection"],
  ["native_rejection_binding", "relay_native_rejection_binding"],
  ["target_log_unavailable", "relay_target_log_unavailable"],
  ["target_log_rate_limited", "relay_target_log_rate_limited"],
  ["target_log_4xx", "relay_target_log_4xx"],
  ["target_log_5xx", "relay_target_log_5xx"],
  ["target_log_unexpected", "relay_target_log_unexpected"],
  ["target_trace_unavailable", "relay_target_trace_unavailable"],
  ["target_trace_rate_limited", "relay_target_trace_rate_limited"],
  ["target_trace_4xx", "relay_target_trace_4xx"],
  ["target_trace_5xx", "relay_target_trace_5xx"],
  ["target_trace_unexpected", "relay_target_trace_unexpected"],
  ["hook_event_mismatch", "relay_hook_event_mismatch"],
  ["target_hook_unavailable", "relay_target_hook_unavailable"],
  ["target_hook_rate_limited", "relay_target_hook_rate_limited"],
  ["target_hook_4xx", "relay_target_hook_4xx"],
  ["target_hook_5xx", "relay_target_hook_5xx"],
  ["target_hook_unexpected", "relay_target_hook_unexpected"],
  ["invalid_request", "relay_invalid_request"]
]) {
  const rejected = relayStatus("awaiting");
  rejected.rejectedRequestCount = 1;
  rejected.rejectionReasons[reason] = 1;
  assert.equal(
    JSON.parse(verify(["relay-diagnostic"], rejected, 0).stdout).diagnostic,
    expectedDiagnostic
  );
}

const unclassifiedRejection = relayStatus("awaiting");
unclassifiedRejection.rejectedRequestCount = 1;
unclassifiedRejection.rejectionReasons = {};
assert.equal(
  JSON.parse(verify(["relay-diagnostic"], unclassifiedRejection, 0).stdout).diagnostic,
  "relay_rejected_request_unclassified"
);

const released = relayStatus("released");
released.heldNativeRejectionCount = 0;
released.releasedNativeRejectionCount = 1;
const releasedResult = verify(["relay-released"], released, 0);
assert.equal(JSON.parse(releasedResult.stdout).relay.releasedNativeRejectionCount, 1);

const sealedRelay = relayStatus("released");
sealedRelay.heldNativeRejectionCount = 0;
sealedRelay.releasedNativeRejectionCount = 1;
sealedRelay.ingressSealed = true;
const sealedRelayResult = verify(["relay-sealed"], sealedRelay, 0);
assert.equal(JSON.parse(sealedRelayResult.stdout).relay.releasedNativeRejectionCount, 1);

const baseline = receiverStatus([
  terminal(1, 0, 0),
  // An ordinary usage/cost refinement can arrive before the held decision.
  terminal(2, 1, 0)
]);
baseline.runs[0].usageOrCostChangedFromFirstTerminal = true;
const baselineResult = verify(["baseline"], baseline, 0);
assert.equal(JSON.parse(baselineResult.stdout).baselineTerminalVersion, 2);
assert.equal(receiverDiagnostic(baseline), "baseline_ready");

// The live harness may time out while polling the receiver. Lock every
// privacy-safe fixed diagnostic to the exact assertion decision path so a
// future invariant change cannot collapse it back into an opaque timeout.
for (const [expectedDiagnostic, mutate] of [
  ["receiver_privacy_failure", (status) => { status.forbiddenPayloadDetected = true; }],
  ["receiver_ingress_not_clean", (status) => { status.rejectedRequestCount = 1; }],
  ["receiver_session_not_bound", (status) => { status.expectedSessionBound = false; }],
  ["unexpected_commit", (status) => { status.commitEventCount = 1; }],
  ["runs_missing_or_invalid", (status) => { status.runs = {}; }],
  ["no_run_received", (status) => { status.runs = []; }],
  ["unexpected_run_count", (status) => { status.runs.push(status.runs[0]); }],
  ["invalid_run", (status) => { status.runs[0] = null; }],
  ["missing_or_duplicate_start", (status) => { status.runs[0].runStartCount = 0; }],
  ["terminal_arrived_before_start", (status) => { status.runs[0].startBeforeFirstTerminal = false; }],
  ["pre_start_update", (status) => { status.runs[0].updatesBeforeFirstStart = 1; }],
  ["post_terminal_update", (status) => { status.runs[0].updatesAfterFirstTerminal = 1; }],
  ["unexpected_run_commit", (status) => { status.runs[0].commitEventCount = 1; }],
  ["terminal_identity_incomplete_or_changed", (status) => { status.runs[0].completeLifecycleIdentity = false; }],
  ["not_authoritative_claude_terminal", (status) => { status.runs[0].baselineTerminalReceiptCaptured = false; }],
  ["terminal_missing", (status) => { status.runs[0].terminalVersions = []; }],
  ["invalid_terminal_versions", (status) => { status.runs[0].terminalVersions[0].version = 2; }],
  ["terminal_not_root_span_authority", (status) => { status.runs[0].terminalVersions[0].rootSpanEvidence = false; }],
  ["terminal_activity_coverage_invalid", (status) => { status.runs[0].terminalVersions[0].validWriteActivityEvidence = false; }],
  ["unexpected_non_write_tool_activity", (status) => { status.runs[0].terminalVersions[0].nonWriteToolCount = 1; }],
  ["terminal_correction_delivery_late", (status) => { status.runs[0].terminalVersions[0].deliveredWithinCorrectionWindow = false; }],
  ["terminal_non_decision_claim_comparison_missing", (status) => { status.runs[0].terminalVersions[0].nonDecisionClaimsMatchPrevious = undefined; }],
  ["denied_write_changed_files", (status) => { status.runs[0].terminalVersions[0].filesChangedCount = 1; }],
  ["native_decision_execution_grant", (status) => { status.runs[0].terminalVersions[0].writeExecutionGrant = true; }],
  ["invalid_write_counts", (status) => { status.runs[0].terminalVersions[0].unknownWriteCount = -1; }],
  ["write_activity_outcome_or_count_invalid", (status) => { status.runs[0].terminalVersions[0].writeActivityCount = 2; }],
  ["native_rejection_leaked_before_release", (status) => {
    status.runs[0].terminalVersions[0].rejectedWriteCount = 1;
    status.runs[0].terminalVersions[0].rejectedWriteFailureCount = 1;
    status.runs[0].terminalVersions[0].rejectedWriteRejectionCount = 1;
    status.runs[0].terminalVersions[0].writeActivityCount = 1;
  }],
  ["pre_release_write_execution_or_outcome", (status) => {
    status.runs[0].terminalVersions[0].unknownWriteCount = 2;
    status.runs[0].terminalVersions[0].writeActivityCount = 2;
    status.runs[0].terminalVersions[0].nonRejectedWriteCount = 2;
  }]
]) {
  const status = receiverStatus([terminal(1, 0, 0)]);
  mutate(status);
  assert.equal(receiverDiagnostic(status), expectedDiagnostic);
}

const corrected = receiverStatus([
  terminal(1, 0, 0),
  terminal(2, 1, 0),
  terminal(3, 0, 1)
]);
corrected.runs[0].usageOrCostChangedFromFirstTerminal = true;
const correctedResult = verify(["post-release", "2"], corrected, 0);
assert.equal(JSON.parse(correctedResult.stdout).correctedTerminalVersion, 3);

const sealedReceiver = receiverStatus([terminal(1, 0, 0), terminal(2, 0, 1)]);
sealedReceiver.runs[0].usageOrCostChangedFromFirstTerminal = true;
sealedReceiver.webhookSealed = true;
const sealedReceiverResult = verify(["receiver-sealed", "1"], sealedReceiver, 0);
assert.equal(JSON.parse(sealedReceiverResult.stdout).correctedTerminalVersion, 2);

const skippedVersion = receiverStatus([terminal(1, 0, 0), terminal(3, 1, 0)]);
verify(["baseline"], skippedVersion, 1);

const successBetweenUnknownAndRejection = receiverStatus([
  terminal(1, 1, 0),
  terminal(2, 0, 0, { writeActivityCount: 1, nonRejectedWriteCount: 1 }),
  terminal(3, 0, 1)
]);
verify(["post-release", "1"], successBetweenUnknownAndRejection, 1);

const receiverSessionUnbound = receiverStatus([terminal(1, 0, 0)]);
receiverSessionUnbound.expectedSessionBound = false;
verify(["baseline"], receiverSessionUnbound, 1);

const receiverSessionMismatch = receiverStatus([terminal(1, 0, 0)]);
receiverSessionMismatch.runs[0].expectedSessionMatch = false;
verify(["baseline"], receiverSessionMismatch, 1);

const relaySessionUnbound = relayStatus("held");
relaySessionUnbound.expectedSessionBound = false;
verify(["relay-held"], relaySessionUnbound, 1);

const relayLateSource = relayStatus("held");
relayLateSource.sourceBeforeClosedBoundary = false;
verify(["relay-held"], relayLateSource, 1);

const lateCorrection = receiverStatus([
  terminal(1, 0, 0),
  terminal(2, 0, 1, { deliveredWithinCorrectionWindow: false })
]);
lateCorrection.runs[0].allCorrectionsWithinCorrectionWindow = false;
verify(["post-release", "1"], lateCorrection, 1);

const changedCorrectionClaims = receiverStatus([terminal(1, 0, 0), terminal(2, 0, 1, {
  nonDecisionClaimsMatchPrevious: false
})]);
verify(["post-release", "1"], changedCorrectionClaims, 1);

const changedTerminalOutcome = receiverStatus([terminal(1, 0, 0), terminal(2, 0, 1, {
  nonDecisionClaimsMatchPrevious: false
})]);
verify(["post-release", "1"], changedTerminalOutcome, 1);

const invalidWriteEvidence = receiverStatus([terminal(1, 0, 0, { validWriteActivityEvidence: false })]);
verify(["baseline"], invalidWriteEvidence, 1);

const terminalHistoryOverflow = receiverStatus([terminal(1, 0, 0)]);
terminalHistoryOverflow.runs[0].terminalHistoryOverflow = true;
verify(["baseline"], terminalHistoryOverflow, 1);

const missingIdentity = receiverStatus([terminal(1, 0, 0)]);
missingIdentity.runs[0].completeLifecycleIdentity = false;
verify(["baseline"], missingIdentity, 1);

const postTerminalUpdate = receiverStatus([terminal(1, 0, 0)]);
postTerminalUpdate.runs[0].updatesAfterFirstTerminal = 1;
verify(["baseline"], postTerminalUpdate, 1);

const preStartUpdate = receiverStatus([terminal(1, 0, 0)]);
preStartUpdate.runs[0].updatesBeforeFirstStart = 1;
verify(["baseline"], preStartUpdate, 1);

const outOfOrderTerminals = receiverStatus([terminal(2, 0, 0), terminal(1, 0, 0)]);
verify(["baseline"], outOfOrderTerminals, 1);

const duplicateIngress = receiverStatus([terminal(1, 0, 0)]);
duplicateIngress.duplicateEventCount = 1;
verify(["baseline"], duplicateIngress, 1);

const rejectedIngress = receiverStatus([terminal(1, 0, 0)]);
rejectedIngress.rejectedRequestCount = 1;
verify(["baseline"], rejectedIngress, 1);

const missingRootSpan = receiverStatus([terminal(1, 0, 0)]);
missingRootSpan.runs[0].terminalVersions[0].rootSpanEvidence = false;
verify(["baseline"], missingRootSpan, 1);

const extraExecutedWrite = receiverStatus([
  terminal(1, 0, 0),
  terminal(2, 0, 1, { nonRejectedWriteCount: 1, writeActivityCount: 2 })
]);
verify(["post-release", "1"], extraExecutedWrite, 1);

const extraBashTool = receiverStatus([terminal(1, 0, 0, { nonWriteToolCount: 1 })]);
verify(["baseline"], extraBashTool, 1);

const unsafeUpdateActivity = receiverStatus([terminal(1, 0, 0)]);
unsafeUpdateActivity.runs[0].strictUpdateActivityClaimsSafe = false;
verify(["baseline"], unsafeUpdateActivity, 1);

const unsafeTerminalClaim = receiverStatus([terminal(1, 0, 0, { strictCc15cActivityClaimsSafe: false })]);
verify(["baseline"], unsafeTerminalClaim, 1);

const postToolCompletion = relayStatus("held");
postToolCompletion.forwardedHookEvents.postToolUse = 1;
verify(["relay-held"], postToolCompletion, 1);

const promptAbsent = relayStatus("held");
promptAbsent.promptIdentityObserved = false;
verify(["relay-held"], promptAbsent, 0);

const promptConflict = relayStatus("held");
promptConflict.promptIdentityConflictFree = false;
verify(["relay-held"], promptConflict, 0);

assert.equal(`${heldResult.stdout}${baselineResult.stdout}${correctedResult.stdout}`.includes("PRIVATE_ASSERT_CANARY"), false);
process.stdout.write("claude delayed decision acceptance assertion self-test passed\n");

function verify(args, status, expectedStatus) {
  const result = spawnSync(process.execPath, [script, ...args], {
    input: JSON.stringify(status),
    encoding: "utf8"
  });
  assert.equal(result.status, expectedStatus, result.stderr);
  return result;
}

function receiverDiagnostic(status) {
  return JSON.parse(verify(["baseline-diagnostic"], status, 0).stdout).diagnostic;
}

function relayStatus(state) {
  return {
    schemaVersion: 1,
    decisionState: state,
    heldNativeRejectionCount: 1,
    pendingNativeRejectionCount: 0,
    forwardedLogRecordCount: 1,
    forwardedTraceRequestCount: 1,
    forwardedClosedRootTraceCount: 1,
    expectedSessionBound: true,
    promptIdentityConflictFree: true,
    promptIdentityObserved: true,
    sourceBeforeClosedBoundary: true,
    ingressSealed: false,
    inFlightIngress: 0,
    postSealIngressAttemptCount: 0,
    forwardedHookCount: 3,
    forwardedHookEvents: {
      userPromptSubmit: 1,
      preToolUse: 1,
      postToolUse: 0,
      postToolUseFailure: 0,
      stop: 1,
      stopFailure: 0
    },
    targetedPreToolWriteCount: 1,
    deniedPreToolUseCount: 1,
    boundNativeRejectionCount: 1,
    releasedNativeRejectionCount: 0,
    expiredNativeRejectionCount: 0,
    rejectedRequestCount: 0,
    nativeBindingFailureReasons: Object.fromEntries([
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
    ].map((reason) => [reason, 0])),
    rejectionReasons: Object.fromEntries([
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
    ].map((reason) => [reason, 0]))
  };
}

function receiverStatus(terminalVersions) {
  return {
    schemaVersion: 1,
    acceptedEventCount: terminalVersions.length + 1,
    duplicateEventCount: 0,
    rejectedRequestCount: 0,
    commitEventCount: 0,
    forbiddenPayloadDetected: false,
    expectedSessionBound: true,
    webhookSealed: false,
    inFlightWebhookCount: 0,
    postSealWebhookAttemptCount: 0,
    runs: [{
      alias: "run_001",
      runStartCount: 1,
      runUpdateCount: 0,
      updatesBeforeFirstStart: 0,
      updatesAfterFirstTerminal: 0,
      startBeforeFirstTerminal: true,
      commitEventCount: 0,
      stableStartedAt: true,
      stableRepository: true,
      stableSession: true,
      expectedSessionMatch: true,
      completeLifecycleIdentity: true,
      claudeCodeRuntime: true,
      completedTerminalState: true,
      completeTerminalBoundary: true,
      stableTerminalBoundary: true,
      baselineTerminalReceiptCaptured: true,
      allCorrectionsWithinCorrectionWindow: true,
      strictLifecycleClaimsSafe: true,
      strictUpdateActivityClaimsSafe: true,
      strictTerminalActivityClaimsSafe: true,
      strictFileAndCommitClaimsSafe: true,
      validTerminalVersions: true,
      terminalHistoryOverflow: false,
      usageOrCostChangedFromFirstTerminal: false,
      terminalVersions
    }]
  };
}

function terminal(version, unknownWriteCount, rejectedWriteCount, overrides = {}) {
  return {
    version,
    rootSpanEvidence: true,
    activityCoverageComplete: true,
    validWriteActivityCounts: true,
    validWriteActivityEvidence: true,
    validNonWriteToolActivityCounts: true,
    strictCc15cActivityClaimsSafe: true,
    filesChangedCount: 0,
    nonWriteToolCount: 0,
    nonWriteToolExecutionGrant: false,
    writeActivityCount: unknownWriteCount + rejectedWriteCount,
    nonRejectedWriteCount: unknownWriteCount,
    writeExecutionGrant: false,
    unknownWriteCount,
    rejectedWriteCount,
    rejectedWriteFailureCount: rejectedWriteCount,
    rejectedWriteRejectionCount: rejectedWriteCount,
    rejectedWriteExecutionGrant: false,
    deliveredWithinCorrectionWindow: true,
    nonDecisionClaimsMatchPrevious: true,
    ...overrides
  };
}
