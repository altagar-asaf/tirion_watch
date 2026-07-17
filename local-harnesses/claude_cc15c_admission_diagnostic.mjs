#!/usr/bin/env node
/**
 * Reduce one direct-agent diagnostics snapshot to a fixed CC15C admission
 * outcome. This script never prints diagnostic records, identities, paths,
 * timestamps, prompt data, or other payload fields; it emits one allowlisted
 * code only after the receiver reports that it saw no public run.
 */

const MAX_INPUT_BYTES = 1024 * 1024;
const PROVENANCE_REASON_DIAGNOSTICS = Object.freeze({
  transcript_locator_invalid: "provenance_transcript_locator_invalid",
  transcript_trust_rejected: "provenance_transcript_trust_rejected",
  transcript_read_unavailable: "provenance_transcript_read_unavailable",
  transcript_read_unstable: "provenance_transcript_read_unstable",
  transcript_tail_exceeded: "provenance_transcript_tail_exceeded",
  hook_identity_unavailable: "provenance_hook_identity_unavailable",
  transcript_candidate_missing: "provenance_transcript_candidate_missing",
  idless_candidate_stale: "provenance_idless_candidate_stale",
  prompt_digest_mismatch: "provenance_prompt_digest_mismatch",
  prompt_identity_conflict: "provenance_prompt_identity_conflict",
  candidate_ambiguous: "provenance_candidate_ambiguous",
  transcript_origin_kind_missing: "provenance_transcript_origin_kind_missing",
  transcript_origin_kind_unrecognized: "provenance_transcript_origin_kind_unrecognized",
  transcript_prompt_source_missing: "provenance_transcript_prompt_source_missing",
  transcript_prompt_source_unrecognized: "provenance_transcript_prompt_source_unrecognized",
  transcript_origin_prompt_source_incompatible: "provenance_transcript_origin_prompt_source_incompatible",
  origin_not_human_typed: "provenance_origin_not_human_typed",
  malformed_provenance: "provenance_malformed"
});
let snapshot;
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) throw new Error("diagnostics_too_large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  try {
    snapshot = JSON.parse(body.toString("utf8"));
  } finally {
    body.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
} catch {
  fail();
}

if (!isRecord(snapshot) || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.recentEvents)) {
  fail();
}

emit({
  schemaVersion: 1,
  diagnostic: diagnose(snapshot.recentEvents)
});

function diagnose(events) {
  const telemetryEvents = events.filter(isTelemetryIngressEvent);
  if (telemetryEvents.some((event) => event.details.reason === "claude_deferred_hook_processing_failed")) {
    return "provenance_retry_processing_failed";
  }

  const ignoredSubmission = telemetryEvents.find((event) => (
    event.details.operation === "provider_hook"
    && event.details.state === "ignored"
    && event.details.reason === "provider_hook_event_ignored"
    && event.details.provider === "claude-code"
    && event.details.hookEvent === "user_prompt_submit"
  ));
  if (ignoredSubmission?.details.claudeSubmissionProvenance === "ambiguous") {
    return diagnosticForProvenanceReason(ignoredSubmission.details.claudeSubmissionProvenanceReason)
      ?? "provenance_ambiguous";
  }
  if (ignoredSubmission?.details.claudeSubmissionProvenance === "unavailable") {
    return diagnosticForProvenanceReason(ignoredSubmission.details.claudeSubmissionProvenanceReason)
      ?? "provenance_unavailable";
  }
  if (ignoredSubmission) {
    return "submission_hook_ignored";
  }

  const acceptedSubmission = telemetryEvents.find((event) => (
    event.details.operation === "provider_hook"
    && (event.details.state === "accepted" || event.details.state === "deduplicated")
    && (event.details.reason === "provider_hook_observation_accepted" || event.details.reason === "provider_hook_observation_deduplicated")
    && event.details.provider === "claude-code"
    && event.details.claudeSubmissionProvenance === "human_typed"
    && event.details.sourceId === "hook_claude_code_lifecycle"
  ));
  if (acceptedSubmission) {
    return "submission_hook_accepted_no_run_start";
  }
  return "submission_hook_diagnostic_missing";
}

function diagnosticForProvenanceReason(value) {
  return typeof value === "string"
    ? PROVENANCE_REASON_DIAGNOSTICS[value]
    : undefined;
}

function isTelemetryIngressEvent(event) {
  return isRecord(event)
    && event.code === "construct_lifecycle"
    && isRecord(event.details)
    && event.details.construct === "TelemetryIngress";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail() {
  process.exit(1);
}
