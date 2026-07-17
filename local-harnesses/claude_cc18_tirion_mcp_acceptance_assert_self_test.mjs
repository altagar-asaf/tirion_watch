import assert from "node:assert/strict";
import {
  assertCc18TirionMcpAcceptance,
  formatCc18TirionMcpAcceptance,
} from "./claude_cc18_tirion_mcp_acceptance_assert.mjs";

const PRIVATE_CANARY = "CC18_TIRION_ACCEPTANCE_PRIVATE_CANARY";

function runs(mode, count, failureCount = 0, rejectedCount = 0, unknownCount = 0) {
  const tool = mode === "success"
    ? "tirion_cc18_local/tirion_cc18_readonly_success"
    : "tirion_cc18_local/tirion_cc18_controlled_failure";
  return {
    schemaVersion: 1,
    runs: [{
      provider: "claude-code",
      privateCanary: PRIVATE_CANARY,
      breakdown: [{
        kind: "mcp",
        name: tool,
        count,
        failureCount,
        rejectedCount,
        unknownCount,
        privateCanary: PRIVATE_CANARY,
      }],
    }],
  };
}

function logs(count, activityCount, nodeCount) {
  return {
    schemaVersion: 1,
    events: Array.from({ length: count }, () => ({
      code: "construct_lifecycle",
      eventId: PRIVATE_CANARY,
      details: {
        construct: "TelemetryIngress",
        operation: "provider_hook",
        state: "accepted",
        reason: "provider_hook_observation_accepted",
        provider: "claude-code",
        sourceId: "hook_claude_code_tools",
        activityAtomCount: activityCount / Math.max(count, 1),
        executionNodeCount: nodeCount / Math.max(count, 1),
        privateCanary: PRIVATE_CANARY,
      },
    })),
  };
}

const success = assertCc18TirionMcpAcceptance({
  mode: "success",
  beforeRuns: runs("success", 4),
  afterRuns: runs("success", 5),
  beforeLogs: logs(2, 2, 2),
  afterLogs: logs(3, 3, 3),
});
assert.deepEqual(success, {
  mode: "success",
  mcpDelta: 1,
  failureDelta: 0,
  rejectedDelta: 0,
  unknownDelta: 0,
  hookAcceptanceDelta: 1,
  hookActivityDelta: 1,
  hookNodeDelta: 1,
});
const rendered = formatCc18TirionMcpAcceptance(success);
assert.match(rendered, /^CC18 Tirion MCP success acceptance complete:/);
assert.ok(!rendered.includes(PRIVATE_CANARY), "acceptance output retained a private canary");

const failure = assertCc18TirionMcpAcceptance({
  mode: "failure",
  beforeRuns: runs("failure", 8, 3),
  afterRuns: runs("failure", 9, 4),
  beforeLogs: logs(5, 5, 5),
  afterLogs: logs(6, 6, 6),
});
assert.equal(failure.failureDelta, 1);
assert.equal(failure.rejectedDelta, 0);
assert.equal(failure.unknownDelta, 0);

assert.throws(() => assertCc18TirionMcpAcceptance({
  mode: "success",
  beforeRuns: runs("success", 1),
  afterRuns: runs("success", 1),
  beforeLogs: logs(0, 0, 0),
  afterLogs: logs(1, 1, 1),
}), /mcp_delta_not_one/);

assert.throws(() => assertCc18TirionMcpAcceptance({
  mode: "success",
  beforeRuns: { schemaVersion: 1, runs: [] },
  afterRuns: { schemaVersion: 1, runs: [] },
  beforeLogs: { schemaVersion: 1, events: [] },
  afterLogs: { schemaVersion: 1, events: [] },
}), /mcp_delta_not_one/);

process.stdout.write("claude cc18 tirion mcp acceptance assertion self-test passed\n");
