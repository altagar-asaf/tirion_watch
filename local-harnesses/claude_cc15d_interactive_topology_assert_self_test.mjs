#!/usr/bin/env node
import assert from "node:assert/strict";
import { formatCc15dInteractiveTopologyCensus } from "./claude_cc15d_interactive_topology_assert.mjs";

const PRIVATE_CANARY = "CC15D_TOPOLOGY_ASSERT_PRIVATE_CANARY";
const status = {
  schemaVersion: 1,
  result: "census_complete",
  mode: "interactive_tty",
  hookCardinality: {
    userPromptSubmit: "one",
    preToolUse: "one",
    postToolUse: "zero",
    postToolUseFailure: "zero",
    stop: "one",
    stopFailure: "zero",
  },
  controlledDenial: "one",
  nativeDecision: {
    rejectedWrite: "one",
    samePreToolInvocation: "yes",
    samePreToolSubmissionSession: "yes",
    sameStopSubmissionSession: "yes",
    sameSubmissionSession: "yes",
    sourceTime: "present",
  },
  closedRoot: {
    expectedSession: "one",
    submissionSession: "one",
    decisionSession: "one",
    expectedSubmissionSession: "yes",
    shape: "all_valid",
    decisionRelation: "inside_unique_root",
  },
  promptAliasRelation: "consistent",
  ingress: {
    logs: "seen",
    traces: "seen",
    rejected: "none",
    postSeal: "none",
    state: "sealed",
    inFlight: "none",
  },
  cc15cEligibility: "eligible",
};

const result = formatCc15dInteractiveTopologyCensus(status, {
  model: "claude-sonnet-5",
  claudeCodeVersion: "2.1.210",
});
assert.equal(result.cc15cEligibility, "eligible");
assert.equal(JSON.stringify(result).includes(PRIVATE_CANARY), false);
assert.deepEqual(result.privacy, {
  canaryDetected: false,
  normalProfileUnchanged: true,
  disposableWorkspaceUnchanged: true,
});

const mismatchedEligibility = structuredClone(status);
mismatchedEligibility.cc15cEligibility = "not_eligible";
assert.throws(() => formatCc15dInteractiveTopologyCensus(mismatchedEligibility, {
  model: "claude-sonnet-5",
  claudeCodeVersion: "2.1.210",
}), /status_invalid/);

const unsealedEligible = structuredClone(status);
unsealedEligible.ingress.state = "open";
assert.throws(() => formatCc15dInteractiveTopologyCensus(unsealedEligible, {
  model: "claude-sonnet-5",
  claudeCodeVersion: "2.1.210",
}), /status_invalid/);

const crossSessionEligible = structuredClone(status);
crossSessionEligible.closedRoot.expectedSubmissionSession = "no";
assert.throws(() => formatCc15dInteractiveTopologyCensus(crossSessionEligible, {
  model: "claude-sonnet-5",
  claudeCodeVersion: "2.1.210",
}), /status_invalid/);

const wrongStopEligible = structuredClone(status);
wrongStopEligible.nativeDecision.sameStopSubmissionSession = "no";
assert.throws(() => formatCc15dInteractiveTopologyCensus(wrongStopEligible, {
  model: "claude-sonnet-5",
  claudeCodeVersion: "2.1.210",
}), /status_invalid/);

const promptAliasVariance = structuredClone(status);
promptAliasVariance.promptAliasRelation = "conflict";
assert.equal(formatCc15dInteractiveTopologyCensus(promptAliasVariance, {
  model: "claude-sonnet-5",
  claudeCodeVersion: "2.1.210",
}).cc15cEligibility, "eligible");

const extended = { ...status, privateCanary: PRIVATE_CANARY };
assert.throws(() => formatCc15dInteractiveTopologyCensus(extended, {
  model: "claude-sonnet-5",
  claudeCodeVersion: "2.1.210",
}), /status_invalid/);

const nonEligible = structuredClone(status);
nonEligible.closedRoot.decisionRelation = "no_unique_root";
nonEligible.cc15cEligibility = "not_eligible";
assert.equal(formatCc15dInteractiveTopologyCensus(nonEligible, {
  model: "claude-sonnet-5",
  claudeCodeVersion: "2.1.210",
}).cc15cEligibility, "not_eligible");

process.stdout.write("cc15d interactive topology assertion self-test passed\n");
