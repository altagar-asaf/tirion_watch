#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "claude_cc15c_admission_diagnostic.mjs");

assert.equal(diagnose([
  telemetryEvent({
    state: "ignored",
    reason: "provider_hook_event_ignored",
    hookEvent: "user_prompt_submit",
    claudeSubmissionProvenance: "unavailable"
  })
]), "provenance_unavailable");

assert.equal(diagnose([
  telemetryEvent({
    state: "ignored",
    reason: "provider_hook_event_ignored",
    hookEvent: "user_prompt_submit",
    claudeSubmissionProvenance: "unavailable",
    claudeSubmissionProvenanceReason: "transcript_read_unstable"
  })
]), "provenance_transcript_read_unstable");

assert.equal(diagnose([
  telemetryEvent({
    state: "ignored",
    reason: "provider_hook_event_ignored",
    hookEvent: "user_prompt_submit",
    claudeSubmissionProvenance: "unavailable",
    claudeSubmissionProvenanceReason: "transcript_candidate_missing"
  })
]), "provenance_transcript_candidate_missing");

assert.equal(diagnose([
  telemetryEvent({
    state: "ignored",
    reason: "provider_hook_event_ignored",
    hookEvent: "user_prompt_submit",
    claudeSubmissionProvenance: "unavailable",
    claudeSubmissionProvenanceReason: "transcript_origin_kind_missing"
  })
]), "provenance_transcript_origin_kind_missing");

for (const reason of [
  "transcript_origin_kind_unrecognized",
  "transcript_prompt_source_missing",
  "transcript_prompt_source_unrecognized",
  "transcript_origin_prompt_source_incompatible"
]) {
  assert.equal(diagnose([
    telemetryEvent({
      state: "ignored",
      reason: "provider_hook_event_ignored",
      hookEvent: "user_prompt_submit",
      claudeSubmissionProvenance: "unavailable",
      claudeSubmissionProvenanceReason: reason
    })
  ]), `provenance_${reason}`);
}

assert.equal(diagnose([
  telemetryEvent({
    state: "ignored",
    reason: "provider_hook_event_ignored",
    hookEvent: "user_prompt_submit",
    claudeSubmissionProvenance: "ambiguous"
  })
]), "provenance_ambiguous");

assert.equal(diagnose([
  telemetryEvent({
    state: "ignored",
    reason: "provider_hook_event_ignored",
    hookEvent: "user_prompt_submit",
    claudeSubmissionProvenance: "ambiguous",
    claudeSubmissionProvenanceReason: "candidate_ambiguous"
  })
]), "provenance_candidate_ambiguous");

assert.equal(diagnose([
  telemetryEvent({
    state: "rejected",
    reason: "claude_deferred_hook_processing_failed"
  })
]), "provenance_retry_processing_failed");

assert.equal(diagnose([
  telemetryEvent({
    state: "accepted",
    reason: "provider_hook_observation_accepted",
    sourceId: "hook_claude_code_lifecycle",
    claudeSubmissionProvenance: "human_typed"
  })
]), "submission_hook_accepted_no_run_start");

assert.equal(diagnose([
  telemetryEvent({
    state: "ignored",
    reason: "provider_hook_event_ignored",
    hookEvent: "user_prompt_submit"
  })
]), "submission_hook_ignored");

assert.equal(diagnose([]), "submission_hook_diagnostic_missing");

const privateCanary = "PRIVATE_CC15C_ADMISSION_DIAGNOSTIC_CANARY";
const result = run({
  schemaVersion: 1,
  recentEvents: [telemetryEvent({
    state: "ignored",
    reason: "provider_hook_event_ignored",
    hookEvent: "user_prompt_submit",
    claudeSubmissionProvenance: "unavailable",
    claudeSubmissionProvenanceReason: privateCanary,
    privateCanary
  })]
});
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).diagnostic, "provenance_unavailable");
assert.equal(`${result.stdout}${result.stderr}`.includes(privateCanary), false);

const invalid = run({ schemaVersion: 1, recentEvents: {} });
assert.notEqual(invalid.status, 0);

process.stdout.write("cc15c admission diagnostic self-test passed\n");

function diagnose(events) {
  const result = run({ schemaVersion: 1, recentEvents: events });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).diagnostic;
}

function run(snapshot) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(snapshot),
    encoding: "utf8"
  });
}

function telemetryEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: "diagnostic_safe_fixture",
    code: "construct_lifecycle",
    severity: "info",
    at: "2026-07-15T00:00:00.000Z",
    details: {
      construct: "TelemetryIngress",
      operation: "provider_hook",
      state: "accepted",
      reason: "provider_hook_observation_accepted",
      provider: "claude-code",
      ...overrides
    }
  };
}
