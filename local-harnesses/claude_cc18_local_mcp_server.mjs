#!/usr/bin/env node

// Disposable, stdio-only MCP fixture for CC-18. It intentionally exposes one
// static no-argument tool at a time, makes no filesystem or network requests,
// and writes only an allowlisted counter summary to its caller-owned audit file.

import { chmodSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const SERVER_NAME = "tirion_cc18_local";
const MAX_MESSAGE_BYTES = 64 * 1024;
const SAFE_CAPABILITY = /^[A-Za-z0-9_-]{32,128}$/;
const SAFE_PROTOCOL_VERSION = /^20\d{2}-\d{2}-\d{2}$/;

const FIXTURES = {
  success: {
    toolName: "tirion_cc18_readonly_success",
    description: "Returns a fixed non-sensitive success result.",
    resultText: "CC18_LOCAL_MCP_SUCCESS",
    isError: false,
  },
  failure: {
    toolName: "tirion_cc18_controlled_failure",
    description: "Returns a fixed controlled failure result.",
    resultText: "CC18_LOCAL_MCP_CONTROLLED_FAILURE",
    isError: true,
  },
};

const mode = process.env.TIRION_CC18_MODE;
const fixture = typeof mode === "string" ? FIXTURES[mode] : undefined;
const auditPath = process.env.TIRION_CC18_AUDIT_PATH;
const capabilityReady = typeof process.env.TIRION_CC18_CAPABILITY === "string"
  && SAFE_CAPABILITY.test(process.env.TIRION_CC18_CAPABILITY);
const auditReady = typeof auditPath === "string" && isAbsolute(auditPath);
const ready = Boolean(fixture && capabilityReady && auditReady);

const audit = {
  schemaVersion: 1,
  server: SERVER_NAME,
  mode: fixture ? mode : "invalid",
  capabilityReady,
  auditReady,
  initializeCount: 0,
  initializedNotificationCount: 0,
  toolsListCount: 0,
  expectedToolCallCount: 0,
  unexpectedToolCallCount: 0,
  malformedMessageCount: 0,
  otherRequestCount: 0,
  ...(fixture ? { tool: fixture.toolName } : {}),
};

let initialized = false;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeProtocolVersion(value) {
  return typeof value === "string" && SAFE_PROTOCOL_VERSION.test(value) ? value : undefined;
}

function responseId(value) {
  return value === null || typeof value === "string" || typeof value === "number" ? value : null;
}

function writeAudit() {
  if (!auditReady) return;
  try {
    writeFileSync(auditPath, `${JSON.stringify(audit)}\n`, { mode: 0o600 });
    chmodSync(auditPath, 0o600);
  } catch {
    // The fixture must never write diagnostics to stdout: that channel is MCP.
    process.exitCode = 1;
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id: responseId(id), result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id: responseId(id), error: { code, message } });
}

function toolDefinition() {
  return {
    name: fixture.toolName,
    description: fixture.description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

function validEmptyArguments(value) {
  return value == null || (isRecord(value) && Object.keys(value).length === 0);
}

function handle(message) {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    audit.malformedMessageCount += 1;
    writeAudit();
    return;
  }

  const { id, method } = message;
  const params = isRecord(message.params) ? message.params : {};

  if (method === "initialize") {
    audit.initializeCount += 1;
    const protocolVersion = safeProtocolVersion(params.protocolVersion);
    if (protocolVersion) audit.protocolVersion = protocolVersion;
    writeAudit();
    respond(id, {
      protocolVersion: protocolVersion ?? "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    initialized = true;
    audit.initializedNotificationCount += 1;
    writeAudit();
    return;
  }

  if (method === "ping") {
    audit.otherRequestCount += 1;
    writeAudit();
    respond(id, {});
    return;
  }

  if (method === "tools/list") {
    audit.toolsListCount += 1;
    writeAudit();
    if (!initialized) {
      respondError(id, -32000, "CC18 fixture not initialized");
      return;
    }
    respond(id, { tools: ready ? [toolDefinition()] : [] });
    return;
  }

  if (method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    const expectedCall = ready && initialized && toolName === fixture.toolName && validEmptyArguments(params.arguments);
    if (!expectedCall) {
      audit.unexpectedToolCallCount += 1;
      writeAudit();
      respondError(id, -32602, "CC18 fixture rejected this tool call");
      return;
    }
    audit.expectedToolCallCount += 1;
    writeAudit();
    respond(id, {
      content: [{ type: "text", text: fixture.resultText }],
      ...(fixture.isError ? { isError: true } : {}),
    });
    return;
  }

  audit.otherRequestCount += 1;
  writeAudit();
  if (id !== undefined) respondError(id, -32601, "CC18 fixture does not implement this method");
}

writeAudit();

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
    audit.malformedMessageCount += 1;
    writeAudit();
    return;
  }
  try {
    handle(JSON.parse(line));
  } catch {
    audit.malformedMessageCount += 1;
    writeAudit();
  }
});
input.on("close", () => writeAudit());
