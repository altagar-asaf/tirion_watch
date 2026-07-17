#!/usr/bin/env node
/**
 * Validate one metadata-only CC15C control/receiver status from stdin.
 * Every successful result is a bounded, identifier-free JSON summary so the
 * shell can retain only the terminal version needed for the next phase.
 */

const phase = process.argv[2];
if (!new Set(["baseline", "baseline-diagnostic", "post-release", "receiver-sealed", "relay-held", "relay-released", "relay-sealed", "relay-diagnostic"]).has(phase)) {
  fail("phase_required");
}
const baselineVersion = (phase === "post-release" || phase === "receiver-sealed")
  ? boundedVersion(process.argv[3])
  : undefined;
if ((phase === "post-release" || phase === "receiver-sealed") && baselineVersion == null) fail("baseline_version_required");

let status;
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  try {
    status = JSON.parse(body.toString("utf8"));
  } finally {
    body.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
} catch {
  fail("invalid_status");
}

if (!isRecord(status) || status.schemaVersion !== 1) fail("invalid_status");
if (phase === "relay-diagnostic") {
  emit({ schemaVersion: 1, phase, diagnostic: diagnoseRelayHeld(status) });
  process.exit(0);
}
if (phase === "relay-held" || phase === "relay-released" || phase === "relay-sealed") {
  const relay = validateRelay(status, phase);
  emit({ schemaVersion: 1, phase, relay });
  process.exit(0);
}

// This is intentionally a fixed-enum reducer over the receiver's already
// privacy-safe status. It lets the opt-in live harness report why a baseline
// did not appear without printing event bodies, run/session IDs, timestamps,
// repository data, or provider telemetry.
if (phase === "baseline-diagnostic") {
  emit({ schemaVersion: 1, phase, diagnostic: diagnoseReceiverBaseline(status) });
  process.exit(0);
}

const run = validateReceiver(status);
const terminals = run.terminalVersions;
if (phase === "baseline") {
  validateBaseline(terminals);
  const latest = terminals.at(-1);
  emit({
    schemaVersion: 1,
    phase,
    baselineTerminalVersion: latest.version,
    terminalVersionCount: terminals.length,
    provisionalWriteState: latest.unknownWriteCount === 1 ? "unknown" : "absent"
  });
  process.exit(0);
}

const correction = validatePostRelease(terminals, baselineVersion);
if (phase === "receiver-sealed") {
  if (
    status.webhookSealed !== true
    || boundedCount(status.inFlightWebhookCount) !== 0
    || boundedCount(status.postSealWebhookAttemptCount) !== 0
  ) {
    fail("receiver_seal_invalid");
  }
}
emit({
  schemaVersion: 1,
  phase,
  baselineTerminalVersion: baselineVersion,
  correctedTerminalVersion: correction.version,
  terminalVersionCount: terminals.length
});

function validateRelay(status, requestedPhase) {
  const held = status.heldNativeRejectionCount;
  const hooks = status.forwardedHookEvents;
  if (!isRecord(hooks)) fail("relay_hook_counters_missing");
  const hookCounts = {
    userPromptSubmit: boundedCount(hooks.userPromptSubmit),
    preToolUse: boundedCount(hooks.preToolUse),
    postToolUse: boundedCount(hooks.postToolUse),
    postToolUseFailure: boundedCount(hooks.postToolUseFailure),
    stop: boundedCount(hooks.stop),
    stopFailure: boundedCount(hooks.stopFailure)
  };
  if (
    hookCounts.userPromptSubmit !== 1
    || hookCounts.preToolUse !== 1
    || hookCounts.stop !== 1
    || hookCounts.postToolUse !== 0
    || hookCounts.postToolUseFailure !== 0
    || hookCounts.stopFailure !== 0
  ) {
    fail("relay_lifecycle_cardinality_invalid");
  }
  const forwardedLogRecordCount = boundedCount(status.forwardedLogRecordCount);
  const forwardedTraceRequestCount = boundedCount(status.forwardedTraceRequestCount);
  const forwardedClosedRootTraceCount = boundedCount(status.forwardedClosedRootTraceCount);
  if (forwardedLogRecordCount < 1) fail("generic_log_not_forwarded");
  if (forwardedTraceRequestCount < 1) fail("closed_root_trace_not_forwarded");
  if (forwardedClosedRootTraceCount !== 1) fail("closed_root_trace_not_exact");
  if (
    status.expectedSessionBound !== true
    || status.sourceBeforeClosedBoundary !== true
  ) {
    fail("native_rejection_identity_or_boundary_not_bound");
  }
  if (
    status.targetedPreToolWriteCount !== 1
    || status.deniedPreToolUseCount !== 1
    || status.boundNativeRejectionCount !== 1
    || status.expiredNativeRejectionCount !== 0
    || boundedCount(status.pendingNativeRejectionCount) !== 0
    || status.rejectedRequestCount !== 0
  ) {
    fail("invalid_native_rejection_control_state");
  }
  if (requestedPhase === "relay-held") {
    if (status.decisionState !== "held" || held !== 1 || status.releasedNativeRejectionCount !== 0) {
      fail("native_decision_not_held");
    }
  } else if (
    status.decisionState !== "released"
    || held !== 0
    || status.releasedNativeRejectionCount !== 1
  ) {
    fail("native_decision_not_released");
  }
  if (requestedPhase === "relay-sealed") {
    if (
      status.ingressSealed !== true
      || boundedCount(status.inFlightIngress) !== 0
      || boundedCount(status.postSealIngressAttemptCount) !== 0
    ) {
      fail("relay_seal_invalid");
    }
  }
  return {
    forwardedLogRecordCount,
    forwardedTraceRequestCount,
    forwardedClosedRootTraceCount,
    userPromptSubmitCount: hookCounts.userPromptSubmit,
    preToolUseCount: hookCounts.preToolUse,
    stopCount: hookCounts.stop,
    deniedPreToolUseCount: 1,
    releasedNativeRejectionCount: boundedCount(status.releasedNativeRejectionCount)
  };
}

// This reducer deliberately exposes a fixed reason code only. It is used when
// a live probe fails before the relay can produce its normal success summary;
// it must not disclose IDs, timestamps, paths, hook payloads, or telemetry.
function diagnoseRelayHeld(status) {
  const hooks = status.forwardedHookEvents;
  if (!isRecord(hooks)) return "hook_counters_missing";
  const hookCounts = {
    userPromptSubmit: boundedCount(hooks.userPromptSubmit),
    preToolUse: boundedCount(hooks.preToolUse),
    postToolUse: boundedCount(hooks.postToolUse),
    postToolUseFailure: boundedCount(hooks.postToolUseFailure),
    stop: boundedCount(hooks.stop),
    stopFailure: boundedCount(hooks.stopFailure)
  };
  if (hookCounts.userPromptSubmit !== 1) return "user_prompt_submit_count";
  if (hookCounts.preToolUse !== 1) return "pre_tool_use_count";
  if (hookCounts.stop !== 1 || hookCounts.stopFailure !== 0) return "terminal_hook_count";
  if (hookCounts.postToolUse !== 0 || hookCounts.postToolUseFailure !== 0) return "unexpected_tool_completion_hook";
  const nativeBindingDiagnostic = relayNativeBindingDiagnostic(status.nativeBindingFailureReasons);
  if (nativeBindingDiagnostic) return nativeBindingDiagnostic;
  const rejectionDiagnostic = relayRejectionDiagnostic(status.rejectionReasons);
  if (rejectionDiagnostic) return rejectionDiagnostic;
  if (boundedCount(status.rejectedRequestCount) !== 0) return "relay_rejected_request_unclassified";
  if (boundedCount(status.targetedPreToolWriteCount) !== 1) return "targeted_write_hook_count";
  if (boundedCount(status.deniedPreToolUseCount) !== 1) return "controlled_deny_missing";
  if (boundedCount(status.forwardedLogRecordCount) < 1) return "generic_log_absent";
  if (boundedCount(status.forwardedTraceRequestCount) < 1) return "closed_root_trace_absent";
  if (boundedCount(status.forwardedClosedRootTraceCount) !== 1) return "closed_root_trace_count";
  if (status.expectedSessionBound !== true) return "expected_session_unbound";
  if (status.decisionState === "ambiguous") return "native_rejection_binding_ambiguous";
  if (boundedCount(status.expiredNativeRejectionCount) !== 0 || status.decisionState === "expired") {
    return "native_rejection_expired";
  }
  if (boundedCount(status.pendingNativeRejectionCount) !== 0) return "native_rejection_pending_control";
  if (boundedCount(status.boundNativeRejectionCount) !== 1) return "native_rejection_absent";
  if (status.sourceBeforeClosedBoundary !== true) return "native_rejection_boundary_unbound";
  if (status.decisionState !== "held" || boundedCount(status.heldNativeRejectionCount) !== 1) {
    return "native_rejection_not_held";
  }
  return "relay_held_assertion_failed";
}

function relayNativeBindingDiagnostic(value) {
  if (!isRecord(value)) return undefined;
  const reasons = [
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
  ];
  for (const [reason, diagnostic] of reasons) {
    if (boundedCount(value[reason]) > 0) return diagnostic;
  }
  return undefined;
}

function relayRejectionDiagnostic(value) {
  if (!isRecord(value)) return undefined;
  const reasons = [
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
  ];
  for (const [reason, diagnostic] of reasons) {
    if (boundedCount(value[reason]) > 0) return diagnostic;
  }
  return undefined;
}

function validateReceiver(status) {
  const diagnostic = receiverValidationDiagnostic(status);
  if (diagnostic) fail(diagnostic);
  return { terminalVersions: status.runs[0].terminalVersions };
}

function diagnoseReceiverBaseline(status) {
  return receiverValidationDiagnostic(status) ?? baselineDiagnostic(status.runs[0].terminalVersions) ?? "baseline_ready";
}

// Keep receiver validation and diagnostic classification on one decision path.
// A future assertion change therefore cannot silently turn a known failure
// into an opaque live timeout.
function receiverValidationDiagnostic(status) {
  if (status.forbiddenPayloadDetected !== false) return "receiver_privacy_failure";
  if (status.duplicateEventCount !== 0 || status.rejectedRequestCount !== 0) {
    return "receiver_ingress_not_clean";
  }
  if (status.expectedSessionBound !== true) return "receiver_session_not_bound";
  if (status.commitEventCount !== 0) return "unexpected_commit";
  if (!Array.isArray(status.runs)) return "runs_missing_or_invalid";
  if (status.runs.length === 0) return "no_run_received";
  if (status.runs.length !== 1) return "unexpected_run_count";
  const run = status.runs[0];
  if (!isRecord(run)) return "invalid_run";
  if (run.runStartCount !== 1) return "missing_or_duplicate_start";
  if (run.startBeforeFirstTerminal !== true) return "terminal_arrived_before_start";
  if (run.updatesBeforeFirstStart !== 0) return "pre_start_update";
  if (run.updatesAfterFirstTerminal !== 0) return "post_terminal_update";
  if (run.commitEventCount !== 0) return "unexpected_run_commit";
  if (
    run.stableStartedAt !== true
    || run.stableRepository !== true
    || run.stableSession !== true
    || run.expectedSessionMatch !== true
    || run.completeLifecycleIdentity !== true
  ) {
    return "terminal_identity_incomplete_or_changed";
  }
  if (
    run.claudeCodeRuntime !== true
    || run.completedTerminalState !== true
    || run.completeTerminalBoundary !== true
    || run.stableTerminalBoundary !== true
    || run.validTerminalVersions !== true
    || run.terminalHistoryOverflow !== false
    || run.baselineTerminalReceiptCaptured !== true
    || run.allCorrectionsWithinCorrectionWindow !== true
    || run.strictLifecycleClaimsSafe !== true
    || run.strictUpdateActivityClaimsSafe !== true
    || run.strictTerminalActivityClaimsSafe !== true
    || run.strictFileAndCommitClaimsSafe !== true
  ) {
    return "not_authoritative_claude_terminal";
  }
  if (!Array.isArray(run.terminalVersions) || run.terminalVersions.length < 1) {
    return "terminal_missing";
  }
  for (const [index, terminal] of run.terminalVersions.entries()) {
    const expectedVersion = index + 1;
    if (!isRecord(terminal) || terminal.version !== expectedVersion) {
      return "invalid_terminal_versions";
    }
    if (terminal.rootSpanEvidence !== true) return "terminal_not_root_span_authority";
    if (
      terminal.activityCoverageComplete !== true
      || terminal.validWriteActivityCounts !== true
      || terminal.validWriteActivityEvidence !== true
      || terminal.validNonWriteToolActivityCounts !== true
      || terminal.strictCc15cActivityClaimsSafe !== true
    ) {
      return "terminal_activity_coverage_invalid";
    }
    if (terminal.nonWriteToolCount !== 0 || terminal.nonWriteToolExecutionGrant !== false) {
      return "unexpected_non_write_tool_activity";
    }
    if (terminal.deliveredWithinCorrectionWindow !== true) {
      return "terminal_correction_delivery_late";
    }
    if (typeof terminal.nonDecisionClaimsMatchPrevious !== "boolean") {
      return "terminal_non_decision_claim_comparison_missing";
    }
    if (terminal.filesChangedCount !== 0) return "denied_write_changed_files";
    if (terminal.writeExecutionGrant !== false || terminal.rejectedWriteExecutionGrant !== false) {
      return "native_decision_execution_grant";
    }
    if (
      !isCount(terminal.writeActivityCount)
      || !isCount(terminal.nonRejectedWriteCount)
      || !isCount(terminal.unknownWriteCount)
      || !isCount(terminal.rejectedWriteCount)
      || !isCount(terminal.rejectedWriteFailureCount)
      || !isCount(terminal.rejectedWriteRejectionCount)
    ) {
      return "invalid_write_counts";
    }
    if (
      terminal.writeActivityCount !== terminal.nonRejectedWriteCount + terminal.rejectedWriteCount
      || terminal.nonRejectedWriteCount !== terminal.unknownWriteCount
      || terminal.rejectedWriteRejectionCount > terminal.rejectedWriteFailureCount
      || terminal.rejectedWriteFailureCount > terminal.rejectedWriteCount
    ) {
      return "write_activity_outcome_or_count_invalid";
    }
  }
  return undefined;
}

function validateBaseline(terminals) {
  const diagnostic = baselineDiagnostic(terminals);
  if (diagnostic) fail(diagnostic);
}

function validatePostRelease(terminals, baseline) {
  const correction = terminals.at(-1);
  if (!correction || correction.version <= baseline) fail("terminal_correction_missing");
  if (terminals.filter((terminal) => terminal.version > baseline).some((terminal) => terminal.nonDecisionClaimsMatchPrevious !== true)) {
    fail("native_rejection_changed_non_decision_claim");
  }
  for (const terminal of terminals.slice(0, -1)) {
    validateBaselineTerminal(terminal);
  }
  if (
    correction.rejectedWriteCount !== 1
    || correction.rejectedWriteFailureCount !== 1
    || correction.rejectedWriteRejectionCount !== 1
    || correction.rejectedWriteExecutionGrant !== false
    || correction.writeActivityCount !== 1
    || correction.nonRejectedWriteCount !== 0
    || correction.writeExecutionGrant !== false
  ) {
    fail("native_rejection_not_exact");
  }
  return correction;
}

function validateBaselineTerminal(terminal) {
  const diagnostic = baselineTerminalDiagnostic(terminal);
  if (diagnostic) fail(diagnostic);
}

function baselineDiagnostic(terminals) {
  for (const terminal of terminals) {
    const diagnostic = baselineTerminalDiagnostic(terminal);
    if (diagnostic) return diagnostic;
  }
  return undefined;
}

function baselineTerminalDiagnostic(terminal) {
  if (
    terminal.rejectedWriteCount !== 0
    || terminal.rejectedWriteFailureCount !== 0
    || terminal.rejectedWriteRejectionCount !== 0
  ) {
    return "native_rejection_leaked_before_release";
  }
  // The provider can either expose one provisional unknown Write or omit it;
  // any other outcome or cardinality contradicts the strict one-call probe.
  if (
    terminal.unknownWriteCount > 1
    || terminal.writeActivityCount !== terminal.unknownWriteCount
    || terminal.nonRejectedWriteCount !== terminal.unknownWriteCount
    || terminal.writeExecutionGrant !== false
    || terminal.rejectedWriteExecutionGrant !== false
  ) {
    return "pre_release_write_execution_or_outcome";
  }
  return undefined;
}

function boundedVersion(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : undefined;
}

function boundedCount(value) {
  return isCount(value) ? value : -1;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code) {
  process.stderr.write(`cc15c_assertion_failed:${code}\n`);
  process.exit(1);
}
