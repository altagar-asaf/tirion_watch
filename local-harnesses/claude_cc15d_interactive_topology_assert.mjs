#!/usr/bin/env node
/**
 * Reduce CC15D's already metadata-only receiver status to the one public safe
 * census line. Unknown keys and values fail closed so a future receiver change
 * cannot accidentally expand what the interactive harness prints.
 */

import { pathToFileURL } from "node:url";

const CARDINALITY = new Set(["zero", "one", "many"]);
const YES_NO_UNAVAILABLE = new Set(["yes", "no", "unavailable"]);
const SOURCE_TIME = new Set(["present", "missing"]);
const ROOT_SHAPE = new Set(["all_valid", "some_invalid", "none_valid"]);
const DECISION_RELATION = new Set([
  "inside_unique_root",
  "before_root",
  "after_root",
  "no_unique_root",
  "decision_time_missing",
  "decision_missing",
  "decision_many",
]);
const INPUT_TOP_LEVEL = new Set([
  "schemaVersion",
  "result",
  "mode",
  "hookCardinality",
  "controlledDenial",
  "nativeDecision",
  "closedRoot",
  "promptAliasRelation",
  "ingress",
  "cc15cEligibility",
]);

export function formatCc15dInteractiveTopologyCensus(status, { model, claudeCodeVersion }) {
  const safeStatus = validateStatus(status);
  if (!isExactModel(model) || !isVersion(claudeCodeVersion)) throw new Error("arguments_invalid");
  return {
    schemaVersion: 1,
    result: "census_complete",
    claudeCodeVersion,
    model,
    mode: "interactive_tty",
    hookCardinality: safeStatus.hookCardinality,
    controlledDenial: safeStatus.controlledDenial,
    nativeDecision: safeStatus.nativeDecision,
    closedRoot: safeStatus.closedRoot,
    promptAliasRelation: safeStatus.promptAliasRelation,
    ingress: safeStatus.ingress,
    privacy: {
      canaryDetected: false,
      normalProfileUnchanged: true,
      disposableWorkspaceUnchanged: true,
    },
    cc15cEligibility: safeStatus.cc15cEligibility,
  };
}

function validateStatus(status) {
  if (!isExactRecord(status, INPUT_TOP_LEVEL) || status.schemaVersion !== 1 || status.result !== "census_complete" || status.mode !== "interactive_tty") {
    throw new Error("status_invalid");
  }
  const hookCardinality = validateHooks(status.hookCardinality);
  if (!CARDINALITY.has(status.controlledDenial)) throw new Error("status_invalid");
  const nativeDecision = validateNativeDecision(status.nativeDecision);
  const closedRoot = validateClosedRoot(status.closedRoot);
  if (!new Set(["consistent", "conflict", "unavailable"]).has(status.promptAliasRelation)) throw new Error("status_invalid");
  const ingress = validateIngress(status.ingress);
  const expectedEligibility = eligible({
    hookCardinality,
    controlledDenial: status.controlledDenial,
    nativeDecision,
    closedRoot,
    promptAliasRelation: status.promptAliasRelation,
    ingress,
  });
  if (status.cc15cEligibility !== expectedEligibility) throw new Error("status_invalid");
  return {
    hookCardinality,
    controlledDenial: status.controlledDenial,
    nativeDecision,
    closedRoot,
    promptAliasRelation: status.promptAliasRelation,
    ingress,
    cc15cEligibility: expectedEligibility,
  };
}

function validateHooks(value) {
  const keys = new Set(["userPromptSubmit", "preToolUse", "postToolUse", "postToolUseFailure", "stop", "stopFailure"]);
  if (!isExactRecord(value, keys) || Object.values(value).some((candidate) => !CARDINALITY.has(candidate))) throw new Error("status_invalid");
  return { ...value };
}

function validateNativeDecision(value) {
  const keys = new Set(["rejectedWrite", "samePreToolInvocation", "samePreToolSubmissionSession", "sameStopSubmissionSession", "sameSubmissionSession", "sourceTime"]);
  if (
    !isExactRecord(value, keys)
    || !CARDINALITY.has(value.rejectedWrite)
    || !YES_NO_UNAVAILABLE.has(value.samePreToolInvocation)
    || !YES_NO_UNAVAILABLE.has(value.samePreToolSubmissionSession)
    || !YES_NO_UNAVAILABLE.has(value.sameStopSubmissionSession)
    || !YES_NO_UNAVAILABLE.has(value.sameSubmissionSession)
    || !SOURCE_TIME.has(value.sourceTime)
  ) throw new Error("status_invalid");
  return { ...value };
}

function validateClosedRoot(value) {
  const keys = new Set(["expectedSession", "submissionSession", "decisionSession", "expectedSubmissionSession", "shape", "decisionRelation"]);
  if (
    !isExactRecord(value, keys)
    || !CARDINALITY.has(value.expectedSession)
    || !CARDINALITY.has(value.submissionSession)
    || !CARDINALITY.has(value.decisionSession)
    || !YES_NO_UNAVAILABLE.has(value.expectedSubmissionSession)
    || !ROOT_SHAPE.has(value.shape)
    || !DECISION_RELATION.has(value.decisionRelation)
  ) throw new Error("status_invalid");
  return { ...value };
}

function validateIngress(value) {
  const keys = new Set(["logs", "traces", "rejected", "postSeal", "state", "inFlight"]);
  if (
    !isExactRecord(value, keys)
    || !new Set(["seen", "missing"]).has(value.logs)
    || !new Set(["seen", "missing"]).has(value.traces)
    || !new Set(["none", "present"]).has(value.rejected)
    || !new Set(["none", "present"]).has(value.postSeal)
    || !new Set(["open", "sealed"]).has(value.state)
    || !new Set(["none", "present"]).has(value.inFlight)
  ) throw new Error("status_invalid");
  return { ...value };
}

function eligible(input) {
  const hooks = input.hookCardinality;
  return (
    hooks.userPromptSubmit === "one"
    && hooks.preToolUse === "one"
    && hooks.postToolUse === "zero"
    && hooks.postToolUseFailure === "zero"
    && hooks.stop === "one"
    && hooks.stopFailure === "zero"
    && input.controlledDenial === "one"
    && input.nativeDecision.rejectedWrite === "one"
    && input.nativeDecision.samePreToolInvocation === "yes"
    && input.nativeDecision.samePreToolSubmissionSession === "yes"
    && input.nativeDecision.sameStopSubmissionSession === "yes"
    && input.nativeDecision.sameSubmissionSession === "yes"
    && input.nativeDecision.sourceTime === "present"
    && input.closedRoot.expectedSession === "one"
    && input.closedRoot.submissionSession === "one"
    && input.closedRoot.decisionSession === "one"
    && input.closedRoot.expectedSubmissionSession === "yes"
    && input.closedRoot.shape === "all_valid"
    && input.closedRoot.decisionRelation === "inside_unique_root"
    && input.ingress.logs === "seen"
    && input.ingress.traces === "seen"
    && input.ingress.rejected === "none"
    && input.ingress.postSeal === "none"
    && input.ingress.state === "sealed"
    && input.ingress.inFlight === "none"
  ) ? "eligible" : "not_eligible";
}

function isExactRecord(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactModel(value) {
  return typeof value === "string"
    && /^claude-[a-z0-9][a-z0-9.-]*$/.test(value)
    && /[0-9]/.test(value)
    && !/(^|[.-])(latest|current)([.-]|$)/.test(value);
}

function isVersion(value) {
  return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
}

async function main() {
  const [model, claudeCodeVersion] = process.argv.slice(2);
  const status = await readStatus();
  const result = formatCc15dInteractiveTopologyCensus(status, { model, claudeCodeVersion });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function readStatus() {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 65_536) throw new Error("status_invalid");
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks);
    try { return JSON.parse(body.toString("utf8")); } finally { body.fill(0); }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("CC15D topology census failed: status_invalid\n");
    process.exitCode = 1;
  });
}
