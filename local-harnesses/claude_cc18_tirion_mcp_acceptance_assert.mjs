#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const FIXTURES = {
  // `RunBreakdownV1` persists the bounded public MCP identity as server/tool,
  // not Claude's raw tool name or the fixture's bare MCP method name.
  success: "tirion_cc18_local/tirion_cc18_readonly_success",
  failure: "tirion_cc18_local/tirion_cc18_controlled_failure",
};
const FAILURE_CODES = new Set([
  "mode_invalid",
  "arguments_invalid",
  "snapshot_unavailable",
  "snapshot_too_large",
  "snapshot_invalid",
  "runs_schema_invalid",
  "logs_schema_invalid",
  "counter_regressed",
  "mcp_delta_not_one",
  "failure_delta_invalid",
  "rejected_delta_invalid",
  "unknown_delta_invalid",
  "hook_acceptance_delta_not_one",
  "hook_activity_delta_not_one",
  "hook_node_delta_not_one",
]);

export function assertCc18TirionMcpAcceptance(input) {
  const toolName = FIXTURES[input?.mode];
  if (!toolName) {
    throw new Error("mode_invalid");
  }
  const beforeRunCounts = mcpRunCounts(input.beforeRuns, toolName);
  const afterRunCounts = mcpRunCounts(input.afterRuns, toolName);
  const beforeHookCounts = hookAcceptanceCounts(input.beforeLogs);
  const afterHookCounts = hookAcceptanceCounts(input.afterLogs);
  const result = {
    mode: input.mode,
    mcpDelta: afterRunCounts.count - beforeRunCounts.count,
    failureDelta: afterRunCounts.failureCount - beforeRunCounts.failureCount,
    rejectedDelta: afterRunCounts.rejectedCount - beforeRunCounts.rejectedCount,
    unknownDelta: afterRunCounts.unknownCount - beforeRunCounts.unknownCount,
    hookAcceptanceDelta: afterHookCounts.acceptanceCount - beforeHookCounts.acceptanceCount,
    hookActivityDelta: afterHookCounts.activityAtomCount - beforeHookCounts.activityAtomCount,
    hookNodeDelta: afterHookCounts.executionNodeCount - beforeHookCounts.executionNodeCount,
  };
  if (Object.values(result).some((value) => typeof value === "number" && value < 0)) {
    throw new Error("counter_regressed");
  }
  if (result.mcpDelta !== 1) {
    throw new Error("mcp_delta_not_one");
  }
  if (result.mode === "success" && result.failureDelta !== 0) {
    throw new Error("failure_delta_invalid");
  }
  if (result.mode === "failure" && result.failureDelta !== 1) {
    throw new Error("failure_delta_invalid");
  }
  if (result.rejectedDelta !== 0) {
    throw new Error("rejected_delta_invalid");
  }
  if (result.unknownDelta !== 0) {
    throw new Error("unknown_delta_invalid");
  }
  if (result.hookAcceptanceDelta !== 1) {
    throw new Error("hook_acceptance_delta_not_one");
  }
  if (result.hookActivityDelta !== 1) {
    throw new Error("hook_activity_delta_not_one");
  }
  if (result.hookNodeDelta !== 1) {
    throw new Error("hook_node_delta_not_one");
  }
  return result;
}

export function formatCc18TirionMcpAcceptance(result) {
  return [
    `CC18 Tirion MCP ${result.mode} acceptance complete:`,
    `mcp_delta=${result.mcpDelta}`,
    `failure_delta=${result.failureDelta}`,
    `rejected_delta=${result.rejectedDelta}`,
    `unknown_delta=${result.unknownDelta}`,
    `hook_acceptance_delta=${result.hookAcceptanceDelta}`,
    `hook_activity_delta=${result.hookActivityDelta}`,
    `hook_node_delta=${result.hookNodeDelta}`,
  ].join(" ");
}

function mcpRunCounts(document, toolName) {
  if (!isRecord(document) || document.schemaVersion !== 1 || !Array.isArray(document.runs)) {
    throw new Error("runs_schema_invalid");
  }
  const counts = { count: 0, failureCount: 0, rejectedCount: 0, unknownCount: 0 };
  for (const run of document.runs) {
    if (!isRecord(run) || run.provider !== "claude-code" || !Array.isArray(run.breakdown)) {
      continue;
    }
    for (const row of run.breakdown) {
      if (!isRecord(row) || row.kind !== "mcp" || row.name !== toolName) {
        continue;
      }
      counts.count += safeCount(row.count, "runs_schema_invalid");
      counts.failureCount += safeCount(row.failureCount, "runs_schema_invalid");
      counts.rejectedCount += safeOptionalCount(row.rejectedCount, "runs_schema_invalid");
      counts.unknownCount += safeOptionalCount(row.unknownCount, "runs_schema_invalid");
    }
  }
  return counts;
}

function hookAcceptanceCounts(document) {
  if (!isRecord(document) || document.schemaVersion !== 1 || !Array.isArray(document.events)) {
    throw new Error("logs_schema_invalid");
  }
  const counts = { acceptanceCount: 0, activityAtomCount: 0, executionNodeCount: 0 };
  for (const event of document.events) {
    if (!isRecord(event) || !isRecord(event.details)) {
      continue;
    }
    const details = event.details;
    if (
      event.code !== "construct_lifecycle"
      || details.construct !== "TelemetryIngress"
      || details.operation !== "provider_hook"
      || details.state !== "accepted"
      || details.reason !== "provider_hook_observation_accepted"
      || details.provider !== "claude-code"
      || details.sourceId !== "hook_claude_code_tools"
    ) {
      continue;
    }
    counts.acceptanceCount += 1;
    counts.activityAtomCount += safeCount(details.activityAtomCount, "logs_schema_invalid");
    counts.executionNodeCount += safeCount(details.executionNodeCount, "logs_schema_invalid");
  }
  return counts;
}

function safeCount(value, failureCode) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) {
    throw new Error(failureCode);
  }
  return value;
}

function safeOptionalCount(value, failureCode) {
  return value == null ? 0 : safeCount(value, failureCode);
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || typeof value !== "string" || values.has(key)) {
      throw new Error("arguments_invalid");
    }
    values.set(key, value);
  }
  const allowed = new Set(["--mode", "--before-runs", "--after-runs", "--before-logs", "--after-logs"]);
  if (values.size !== allowed.size || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("arguments_invalid");
  }
  return {
    mode: values.get("--mode"),
    beforeRuns: readSnapshot(values.get("--before-runs")),
    afterRuns: readSnapshot(values.get("--after-runs")),
    beforeLogs: readSnapshot(values.get("--before-logs")),
    afterLogs: readSnapshot(values.get("--after-logs")),
  };
}

function readSnapshot(path) {
  try {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("snapshot_unavailable");
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("snapshot_unavailable");
    }
    if (stat.size < 1 || stat.size > MAX_SNAPSHOT_BYTES) {
      throw new Error("snapshot_too_large");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && FAILURE_CODES.has(error.message)) {
      throw error;
    }
    throw new Error("snapshot_invalid");
  }
}

function safeFailureCode(error) {
  return error instanceof Error && FAILURE_CODES.has(error.message) ? error.message : "snapshot_invalid";
}

function isMain() {
  return process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  try {
    const result = assertCc18TirionMcpAcceptance(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${formatCc18TirionMcpAcceptance(result)}\n`);
  } catch (error) {
    process.stderr.write(`CC18 Tirion MCP acceptance failed: ${safeFailureCode(error)}\n`);
    process.exitCode = 1;
  }
}
