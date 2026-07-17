import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "claude_cc18_local_mcp_server.mjs");
const CAPABILITY = "A".repeat(43);
const PRIVATE_ARGUMENT_CANARY = "CC18_TEST_UNPERSISTED_ARGUMENT";

function timeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("fixture response timeout")), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function start(mode, capability = CAPABILITY) {
  const root = await mkdtemp(join(tmpdir(), "tirion-cc18-self-test-"));
  const auditPath = join(root, "audit.json");
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      TIRION_CC18_AUDIT_PATH: auditPath,
      TIRION_CC18_CAPABILITY: capability,
      TIRION_CC18_MODE: mode,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = [];
  const waiters = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });
  output.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else lines.push(line);
  });

  const nextLine = async () => {
    if (lines.length > 0) return lines.shift();
    return timeout(new Promise((resolve, reject) => waiters.push({ resolve, reject })));
  };
  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const line = await nextLine();
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      assert.fail("fixture emitted non-JSON protocol output");
    }
    assert.equal(response?.jsonrpc, "2.0", "fixture protocol version mismatch");
    assert.equal(response?.id, id, "fixture response identity mismatch");
    return response;
  };
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };
  const close = async () => {
    child.stdin.end();
    await timeout(once(child, "close"));
    output.close();
    assert.equal(stderrBytes, 0, "fixture wrote stderr output");
    return {
      auditText: await readFile(auditPath, "utf8"),
      root,
    };
  };
  return { root, request, notify, close };
}

async function initializedClient(mode, capability = CAPABILITY) {
  const client = await start(mode, capability);
  const initialize = await client.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "self-test", version: "1" },
  });
  assert.equal(initialize.result?.protocolVersion, "2025-06-18", "fixture did not negotiate offered protocol token");
  client.notify("notifications/initialized", {});
  return client;
}

async function runFixture(mode) {
  const expectedTool = mode === "success"
    ? "tirion_cc18_readonly_success"
    : "tirion_cc18_controlled_failure";
  const client = await initializedClient(mode);
  const list = await client.request(2, "tools/list", {});
  assert.equal(list.result?.tools?.length, 1, "fixture did not expose exactly one tool");
  assert.equal(list.result.tools[0]?.name, expectedTool, "fixture exposed wrong tool");
  const call = await client.request(3, "tools/call", { name: expectedTool, arguments: {} });
  assert.equal(call.result?.content?.[0]?.type, "text", "fixture response lacks fixed text result");
  assert.equal(
    call.result?.content?.[0]?.text,
    mode === "success" ? "CC18_LOCAL_MCP_SUCCESS" : "CC18_LOCAL_MCP_CONTROLLED_FAILURE",
    "fixture response text mismatch",
  );
  assert.equal(call.result?.isError === true, mode === "failure", "fixture result outcome mismatch");
  const { auditText, root } = await client.close();
  try {
    const audit = JSON.parse(auditText);
    assert.equal(audit.mode, mode, "audit mode mismatch");
    assert.equal(audit.tool, expectedTool, "audit tool mismatch");
    assert.equal(audit.initializeCount, 1, "audit initialize count mismatch");
    assert.equal(audit.initializedNotificationCount, 1, "audit initialized notification count mismatch");
    assert.equal(audit.toolsListCount, 1, "audit tools/list count mismatch");
    assert.equal(audit.expectedToolCallCount, 1, "audit expected tool-call count mismatch");
    assert.equal(audit.unexpectedToolCallCount, 0, "audit unexpected tool-call count mismatch");
    assert.equal(audit.malformedMessageCount, 0, "audit malformed-message count mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCapabilityAndPrivacyControl() {
  const noCapability = await initializedClient("success", "");
  const list = await noCapability.request(2, "tools/list", {});
  assert.equal(list.result?.tools?.length, 0, "fixture listed tools without its capability");
  const noCapabilityResult = await noCapability.close();
  try {
    const audit = JSON.parse(noCapabilityResult.auditText);
    assert.equal(audit.capabilityReady, false, "capability control did not record denial");
  } finally {
    await rm(noCapabilityResult.root, { recursive: true, force: true });
  }

  const client = await initializedClient("success");
  await client.request(2, "tools/list", {});
  const rejected = await client.request(3, "tools/call", {
    name: "tirion_cc18_readonly_success",
    arguments: { ignored: PRIVATE_ARGUMENT_CANARY },
  });
  assert.equal(rejected.error?.code, -32602, "fixture accepted non-empty arguments");
  const result = await client.close();
  try {
    assert.equal(result.auditText.includes(PRIVATE_ARGUMENT_CANARY), false, "audit retained tool arguments");
    const audit = JSON.parse(result.auditText);
    assert.equal(audit.expectedToolCallCount, 0, "rejected call became expected evidence");
    assert.equal(audit.unexpectedToolCallCount, 1, "rejected call count missing");
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
}

await runFixture("success");
await runFixture("failure");
await runCapabilityAndPrivacyControl();
process.stdout.write("claude cc18 local mcp fixture self-test passed\n");
