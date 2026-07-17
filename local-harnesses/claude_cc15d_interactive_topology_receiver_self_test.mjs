#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startCc15dInteractiveTopologyReceiver } from "./claude_cc15d_interactive_topology_receiver.mjs";

const PRIVATE_CANARY = "CC15D_TOPOLOGY_RECEIVER_PRIVATE_CANARY";
const INGRESS_TOKEN = "cc15d-ingress-token-0123456789";
const CONTROL_TOKEN = "cc15d-control-token-0123456789";
const SESSION = "cc15d-session-a";
const OTHER_SESSION = "cc15d-session-b";
const PROMPT = "cc15d-prompt-a";
const OTHER_PROMPT = "cc15d-prompt-b";
const TOOL = "cc15d-tool-a";
const OTHER_TOOL = "cc15d-tool-b";
const START = "1700000000000000000";
const INSIDE = "1700000005000000000";
const END = "1700000010000000000";
const BEFORE = "1699999999000000000";
const AFTER = "1700000011000000000";

await scenario("eligible", async (client) => {
  await client.baseline();
  const beforeSeal = await client.status();
  assert.equal(beforeSeal.ingress.state, "open");
  assert.equal(beforeSeal.cc15cEligibility, "not_eligible");
  const status = await client.seal();
  assert.equal(status.ingress.state, "sealed");
  assert.equal(status.cc15cEligibility, "eligible");
  assert.equal(status.closedRoot.decisionRelation, "inside_unique_root");
  assert.equal(status.closedRoot.expectedSubmissionSession, "yes");
  assert.equal(status.nativeDecision.samePreToolInvocation, "yes");
  assert.equal(status.nativeDecision.samePreToolSubmissionSession, "yes");
  assert.equal(status.nativeDecision.sameStopSubmissionSession, "yes");
  assertNoLeak(status);
});

await scenario("prompt-alias-variance-is-diagnostic", async (client) => {
  await client.hooks({ prompt: PROMPT });
  await client.log({ prompt: OTHER_PROMPT });
  await client.trace({ prompt: OTHER_PROMPT });
  const status = await client.seal();
  assert.equal(status.promptAliasRelation, "conflict");
  assert.equal(status.cc15cEligibility, "eligible");
  assertNoLeak(status);
});

await scenario("cross-session-decoy-root", async (client) => {
  await client.hooks({ session: OTHER_SESSION });
  await client.log({ session: OTHER_SESSION });
  await client.trace({ session: OTHER_SESSION });
  await client.trace({
    session: SESSION,
    traceId: "cccccccccccccccccccccccccccccccc",
    spanId: "dddddddddddddddd",
  });
  const status = await client.seal();
  assert.equal(status.closedRoot.expectedSession, "one");
  assert.equal(status.closedRoot.submissionSession, "one");
  assert.equal(status.closedRoot.decisionSession, "one");
  assert.equal(status.closedRoot.expectedSubmissionSession, "no");
  assert.equal(status.closedRoot.decisionRelation, "inside_unique_root");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("wrong-stop-session", async (client) => {
  assert.equal((await client.hook("UserPromptSubmit")).status, 200);
  assert.equal((await client.hook("PreToolUse")).status, 200);
  assert.equal((await client.hook("Stop", { session: OTHER_SESSION })).status, 200);
  await client.log();
  await client.trace();
  const status = await client.seal();
  assert.equal(status.nativeDecision.sameStopSubmissionSession, "no");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("foreign-log-source", async (client) => {
  await client.hooks();
  await client.log({ serviceName: "not-claude-code" });
  await client.trace();
  const status = await client.seal();
  assert.equal(status.ingress.logs, "missing");
  assert.equal(status.nativeDecision.rejectedWrite, "zero");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("zero-root", async (client) => {
  await client.hooks();
  await client.log();
  const status = await client.status();
  assert.equal(status.closedRoot.expectedSession, "zero");
  assert.equal(status.closedRoot.decisionRelation, "no_unique_root");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("many-roots", async (client) => {
  await client.baseline();
  await client.trace({ traceId: "cccccccccccccccccccccccccccccccc", spanId: "dddddddddddddddd" });
  const status = await client.status();
  assert.equal(status.closedRoot.expectedSession, "many");
  assert.equal(status.closedRoot.decisionRelation, "no_unique_root");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("wrong-decision-session", async (client) => {
  await client.hooks();
  await client.log({ session: OTHER_SESSION });
  await client.trace();
  const status = await client.status();
  assert.equal(status.nativeDecision.sameSubmissionSession, "no");
  assert.equal(status.closedRoot.decisionSession, "zero");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("mismatched-tool", async (client) => {
  await client.hooks();
  await client.log({ tool: OTHER_TOOL });
  await client.trace();
  const status = await client.status();
  assert.equal(status.nativeDecision.samePreToolInvocation, "no");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("missing-decision-time", async (client) => {
  await client.hooks();
  await client.log({ timestamp: undefined });
  await client.trace();
  const status = await client.status();
  assert.equal(status.nativeDecision.sourceTime, "missing");
  assert.equal(status.closedRoot.decisionRelation, "decision_time_missing");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("decision-before-root", async (client) => {
  await client.hooks();
  await client.log({ timestamp: BEFORE });
  await client.trace();
  const status = await client.status();
  assert.equal(status.closedRoot.decisionRelation, "before_root");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("decision-after-root", async (client) => {
  await client.hooks();
  await client.log({ timestamp: AFTER });
  await client.trace();
  const status = await client.status();
  assert.equal(status.closedRoot.decisionRelation, "after_root");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("malformed-root", async (client) => {
  await client.hooks();
  await client.log();
  await client.trace({ parentSpanId: "aaaaaaaaaaaaaaaa" });
  const status = await client.status();
  assert.equal(status.closedRoot.shape, "none_valid");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("post-tool", async (client) => {
  await client.baseline();
  await client.hook("PostToolUse");
  const status = await client.status();
  assert.equal(status.hookCardinality.postToolUse, "one");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("post-seal", async (client) => {
  await client.baseline();
  const sealed = await client.seal();
  assert.equal(sealed.ingress.postSeal, "none");
  const response = await client.hook("PostToolUse");
  assert.equal(response.status, 409);
  const status = await client.status();
  assert.equal(status.ingress.postSeal, "present");
  assert.equal(status.cc15cEligibility, "not_eligible");
  assertNoLeak(status);
});

await scenario("unauthenticated-traffic-does-not-poison-seal", async (client) => {
  await client.baseline();
  await client.seal();
  assert.equal((await client.unauthenticatedHook()).status, 401);
  assert.equal((await client.badControlStatus()).status, 401);
  const status = await client.status();
  assert.equal(status.ingress.postSeal, "none");
  assert.equal(status.ingress.rejected, "none");
  assert.equal(status.cc15cEligibility, "eligible");
  assertNoLeak(status);
});

process.stdout.write("cc15d interactive topology receiver self-test passed\n");

async function scenario(_name, run) {
  const receiver = await startCc15dInteractiveTopologyReceiver({
    ingressToken: INGRESS_TOKEN,
    controlToken: CONTROL_TOKEN,
    expectedSessionDigest: digest(SESSION),
  });
  const client = createClient(receiver.port);
  try {
    await run(client);
  } finally {
    await receiver.close();
  }
}

function createClient(port) {
  const base = `http://127.0.0.1:${port}`;
  const ingressHeaders = {
    authorization: `Bearer ${INGRESS_TOKEN}`,
    "x-tirion-cc15d-receiver": INGRESS_TOKEN,
    "content-type": "application/json",
    connection: "close",
  };
  const controlHeaders = {
    "x-tirion-cc15d-control": CONTROL_TOKEN,
    connection: "close",
  };
  const request = async (path, payload, headers = ingressHeaders) => fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return {
    async hook(eventName, overrides = {}) {
      return request("/v1/provider-hooks/claude-code", {
        hook_event_name: eventName,
        session_id: overrides.session ?? SESSION,
        prompt_id: overrides.prompt ?? PROMPT,
        tool_name: eventName === "PreToolUse" ? "Write" : undefined,
        tool_use_id: eventName === "PreToolUse" ? TOOL : undefined,
        tool_input: { ignored: PRIVATE_CANARY },
      }, { ...ingressHeaders, "x-tirion-hook-event": eventName });
    },
    async hooks(overrides = {}) {
      assert.equal((await this.hook("UserPromptSubmit", overrides)).status, 200);
      assert.equal((await this.hook("PreToolUse", overrides)).status, 200);
      assert.equal((await this.hook("Stop", overrides)).status, 200);
    },
    async log(overrides = {}) {
      const response = await request("/v1/logs", logEnvelope({
        session: SESSION,
        tool: TOOL,
        timestamp: INSIDE,
        ...overrides,
      }));
      assert.equal(response.status, 200);
    },
    async trace(overrides = {}) {
      const response = await request("/v1/traces", traceEnvelope({
        session: SESSION,
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spanId: "bbbbbbbbbbbbbbbb",
        start: START,
        end: END,
        ...overrides,
      }));
      assert.equal(response.status, 200);
    },
    async baseline(overrides = {}) {
      await this.hooks(overrides);
      await this.log(overrides);
      await this.trace(overrides);
    },
    async status() {
      const response = await fetch(`${base}/control/status`, { headers: controlHeaders });
      assert.equal(response.status, 200);
      return response.json();
    },
    async seal() {
      const response = await fetch(`${base}/control/seal`, { method: "POST", headers: controlHeaders });
      assert.equal(response.status, 200);
      return response.json();
    },
    async unauthenticatedHook() {
      return fetch(`${base}/v1/provider-hooks/claude-code`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ hook_event_name: "PostToolUse" }),
      });
    },
    async badControlStatus() {
      return fetch(`${base}/control/status`, {
        headers: { "x-tirion-cc15d-control": "wrong-control-token", connection: "close" },
      });
    },
  };
}

function logEnvelope({ session, tool, timestamp, prompt = PROMPT, serviceName = "claude-code" }) {
  const attributes = [
    attribute("event.name", "claude_code.tool_decision"),
    attribute("decision", "reject"),
    attribute("gen_ai.tool.name", "Write"),
    attribute("tool_use_id", tool),
    attribute("session.id", session),
    attribute("prompt.id", prompt),
  ];
  if (timestamp !== undefined) attributes.push(attribute("event.timestamp", timestamp));
  return {
    resourceLogs: [{
      resource: { attributes: [attribute("service.name", serviceName)] },
      scopeLogs: [{ logRecords: [{ attributes, body: { stringValue: PRIVATE_CANARY } }] }],
    }],
  };
}

function traceEnvelope({ session, traceId, spanId, parentSpanId = "", start, end, prompt = PROMPT }) {
  return {
    resourceSpans: [{
      resource: { attributes: [attribute("service.name", "claude-code")] },
      scopeSpans: [{ spans: [{
        name: "claude_code.interaction",
        traceId,
        spanId,
        parentSpanId,
        startTimeUnixNano: start,
        endTimeUnixNano: end,
        attributes: [
          attribute("session.id", session),
          attribute("prompt.id", prompt),
          attribute("ignored", PRIVATE_CANARY),
        ],
      }] }],
    }],
  };
}

function attribute(key, stringValue) {
  return { key, value: { stringValue } };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertNoLeak(status) {
  const rendered = JSON.stringify(status);
  for (const secret of [PRIVATE_CANARY, SESSION, OTHER_SESSION, PROMPT, OTHER_PROMPT, TOOL, OTHER_TOOL, START, INSIDE, END, BEFORE, AFTER]) {
    assert.equal(rendered.includes(secret), false, `receiver status leaked ${secret}`);
  }
}
