#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_RECORD_LIMIT = 10_000;
const DEFAULT_TOTAL_RECORD_LIMIT = 25_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_QUIET_MS = 2_500;
const MAX_ATTRIBUTE_COUNT = 2_048;
const UNKNOWN_ATTRIBUTE_COUNT = Symbol("unknownAttributeCount");

const TOKEN_FIELDS = new Set([
  "service.version",
  "app.version",
  "os.version",
  "model",
  "gen_ai.request.model",
  "query_source",
  "tool_name",
  "gen_ai.tool.name",
  "agent_type",
  "subagent_type",
  "skill.name",
  "skill_name",
  "skill.source",
  "skill.kind",
  "invocation_trigger",
  "mcp_server.name",
  "mcp_tool.name",
]);

const ENUM_FIELDS = new Map([
  ["service.name", new Set(["claude-code"])],
  ["app.entrypoint", new Set(["cli", "sdk-cli", "sdk-ts", "sdk-py", "claude-vscode"])],
  ["os.type", new Set(["darwin", "linux", "windows"])],
  ["host.arch", new Set(["arm64", "amd64", "x64"])],
  ["gen_ai.system", new Set(["anthropic"])],
  ["llm_request.context", new Set(["interaction", "tool", "standalone"])],
  ["speed", new Set(["normal", "fast"])],
  ["effort", new Set(["low", "medium", "high", "xhigh", "max"])],
  ["stop_reason", new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence", "pause_turn", "refusal"])],
  ["skill.source", new Set(["bundled", "userSettings", "projectSettings", "plugin"])],
  ["skill.kind", new Set(["workflow"])],
  ["invocation_trigger", new Set(["user-slash", "claude-proactive", "nested-skill"])],
  ["mcp_server_scope", new Set(["user", "project", "local", "plugin", "managed"])],
  ["decision", new Set(["accept", "reject", "allow", "deny", "block"])],
  ["decision_type", new Set(["accept", "reject"])],
  ["decision_source", new Set(["config", "hook", "user_permanent", "user_temporary", "user_abort", "user_reject"])],
  ["source", new Set(["config", "hook", "user_permanent", "user_temporary", "user_abort", "user_reject"])],
  ["status", new Set(["ok", "success", "succeeded", "running", "completed", "failed", "failure", "error", "cancelled", "rejected"])],
  ["hook_event_name", new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop", "StopFailure"])],
  ["permission_mode", new Set(["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"])],
  ["command_source", new Set(["builtin", "custom", "mcp"])],
]);

const SAFE_NUMERIC_KEYS = new Set([
  "event.sequence",
  "duration_ms",
  "ttft_ms",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "reasoning_output_tokens",
  "total_tokens",
  "result_tokens",
  "cost_usd",
  "attempt",
  "status_code",
  "tool_input_size_bytes",
  "tool_result_size_bytes",
  "interaction.sequence",
  "interaction.duration_ms",
  "prompt_length",
  "response_length",
  "durationMs",
  "num_hooks",
  "num_success",
  "num_blocking",
  "num_non_blocking_error",
  "num_cancelled",
  "total_duration_ms",
]);

const SAFE_BOOLEAN_KEYS = new Set([
  "success",
  "stop_hook_active",
  "response.has_tool_call",
  "body_truncated",
  "is_interrupt",
]);

const KNOWN_RECORD_NAMES = new Set([
  "user_prompt",
  "assistant_response",
  "tool_result",
  "tool_decision",
  "api_request",
  "api_error",
  "api_refusal",
  "skill_activated",
  "permission_mode_changed",
  "auth",
  "internal_error",
  "mcp_server_connection",
  "hook_registered",
  "hook_execution_start",
  "hook_execution_complete",
  "claude_code.user_prompt",
  "claude_code.assistant_response",
  "claude_code.tool_result",
  "claude_code.tool_decision",
  "claude_code.api_request",
  "claude_code.api_error",
  "claude_code.api_refusal",
  "claude_code.skill_activated",
  "claude_code.interaction",
  "claude_code.llm_request",
  "claude_code.tool",
  "claude_code.tool.blocked_on_user",
  "claude_code.tool.execution",
  "gen_ai.request.attempt",
  "tool.output",
]);
ENUM_FIELDS.set("event.name", KNOWN_RECORD_NAMES);
ENUM_FIELDS.set("span.type", new Set(["interaction", "llm_request"]));

const IDENTITY_KEYS = {
  sessionId: { namespace: "session", keys: ["session.id", "session_id", "gen_ai.conversation.id"] },
  promptId: { namespace: "prompt", keys: ["prompt.id", "prompt_id"] },
  requestId: { namespace: "request", keys: ["request_id", "request.id", "gen_ai.response.id", "client_request_id"] },
  toolUseId: { namespace: "tool_use", keys: ["tool_use_id", "gen_ai.tool.call.id", "tool.call.id"] },
  agentId: { namespace: "agent", keys: ["agent_id", "subagent_id"] },
  parentAgentId: { namespace: "agent", keys: ["parent_agent_id"] },
  workflowRunId: { namespace: "workflow", keys: ["workflow.run_id"] },
};

const IDENTITY_ATTRIBUTE_KEYS = new Set(Object.values(IDENTITY_KEYS).flatMap((entry) => entry.keys));

const FORBIDDEN_KEYS = new Set([
  "prompt",
  "user_prompt",
  "response",
  "last_assistant_message",
  "tool_input",
  "tool_output",
  "tool_response",
  "tool_parameters",
  "command",
  "full_command",
  "bash_command",
  "description",
  "error",
  "error_details",
  "error_type",
  "transcript_path",
  "agent_transcript_path",
  "body",
  "body_ref",
  "hook_definitions",
  "file_path",
  "file.path",
  "path",
  "cwd",
  "working_directory",
  "workspace_path",
  "workspace_root",
  "content",
  "diff",
  "patch",
  "file_content",
  "arguments",
  "input",
  "output",
  "result",
  "headers",
  "authorization",
  "user.email",
  "user.account_uuid",
  "user.account_id",
  "organization.id",
  "background_tasks",
  "session_crons",
]);

const STOP_FAILURE_ERRORS = new Set([
  "authentication_failed",
]);

const HOOK_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
]);

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const PATH_SCOPED_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"]);
const KNOWN_TOOL_NAMES = new Set([
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "Skill",
  "Write",
]);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
// This is deliberately not a general MCP permission.  The census can opt in
// only to this one static, no-argument local fixture so PreToolUse remains
// observable without granting a server, namespace, or generic MCP scope.
const CC18_STATIC_MCP_FIXTURE = "readonly-success";
const CC18_STATIC_MCP_TOOL = "mcp__tirion_cc18_local__tirion_cc18_readonly_success";
const SAFE_BEARER_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const EXACT_MODEL_ID = /^claude-(?=[a-z0-9.-]*[0-9])[a-z0-9][a-z0-9.-]{2,119}$/;
const MOVING_MODEL_SEGMENT = /(?:^|[.-])(?:latest|current)(?:[.-]|$)/;
const SAFE_BASH_COMMAND = /^\.\/[A-Za-z0-9._/-]{1,200}$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SAFE_FIELD_NAME = /^[A-Za-z0-9_.-]{1,120}$/;
const KNOWN_ATTRIBUTE_KEYS = new Set([
  ...TOKEN_FIELDS,
  ...ENUM_FIELDS.keys(),
  ...SAFE_NUMERIC_KEYS,
  ...SAFE_BOOLEAN_KEYS,
  ...IDENTITY_ATTRIBUTE_KEYS,
  ...FORBIDDEN_KEYS,
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function otlpValue(value) {
  if (!isRecord(value)) return value;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "intValue")) return Number(value.intValue);
  if (Object.hasOwn(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.hasOwn(value, "boolValue")) return Boolean(value.boolValue);
  if (Object.hasOwn(value, "bytesValue")) return undefined;
  if (isRecord(value.arrayValue)) {
    return Array.isArray(value.arrayValue.values) ? value.arrayValue.values.map(otlpValue) : [];
  }
  if (isRecord(value.kvlistValue)) {
    return attributes(value.kvlistValue.values);
  }
  return undefined;
}

function attributes(items) {
  if (items == null) return {};
  if (!Array.isArray(items)) throw new Error("invalid_attributes");
  if (items.length > MAX_ATTRIBUTE_COUNT) throw new Error("attribute_limit_exceeded");
  const result = {};
  let unknownAttributeCount = 0;
  for (const item of items) {
    if (!isRecord(item) || typeof item.key !== "string" || !SAFE_FIELD_NAME.test(item.key)) {
      unknownAttributeCount += 1;
      continue;
    }
    result[item.key] = otlpValue(item.value);
  }
  if (unknownAttributeCount > 0) result[UNKNOWN_ATTRIBUTE_COUNT] = unknownAttributeCount;
  return result;
}

function firstText(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 4_096) return value;
  }
  return undefined;
}

function safeToken(value) {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

function safeModelId(value) {
  return typeof value === "string" && EXACT_MODEL_ID.test(value) && !MOVING_MODEL_SEGMENT.test(value)
    ? value
    : undefined;
}

function knownRecordName(value) {
  return typeof value === "string" && KNOWN_RECORD_NAMES.has(value) ? value : undefined;
}

function safeNumberForKey(key, value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  if (key === "cost_usd") return number <= 1_000_000 ? number : undefined;
  if (key === "status_code") return Number.isSafeInteger(number) && number <= 599 ? number : undefined;
  if (key.includes("tokens") || key === "result_tokens") {
    return Number.isSafeInteger(number) && number <= 1_000_000_000_000 ? number : undefined;
  }
  if (key.includes("duration") || key === "ttft_ms") {
    return Number.isSafeInteger(number) && number <= 7 * 24 * 60 * 60 * 1_000 ? number : undefined;
  }
  return Number.isSafeInteger(number) && number <= 1_000_000_000 ? number : undefined;
}

function safeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function timestampFromNanos(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  try {
    const milliseconds = Number(BigInt(String(value)) / 1_000_000n);
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function safeHeaderMatches(actual, expectedToken) {
  if (!expectedToken) return false;
  if (typeof actual !== "string") return false;
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  const provided = Buffer.from(actual);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function parseJsonRecord(value) {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.length > 64 * 1024) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolPathFrom(source) {
  const direct = firstText(source, ["file_path", "file.path", "path"]);
  if (direct) return direct;
  const input = parseJsonRecord(source.tool_input);
  return input ? firstText(input, ["file_path", "path"]) : undefined;
}

function guardedRepositoryPath(candidate, repositoryRoot, allowMissingLeaf) {
  if (!candidate || !repositoryRoot) return undefined;
  try {
    const repositoryReal = realpathSync(repositoryRoot);
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(repositoryRoot, candidate);
    let targetReal;
    try {
      const targetLink = lstatSync(absolute);
      if (targetLink.isSymbolicLink() || (targetLink.isFile() && targetLink.nlink !== 1)) return undefined;
      targetReal = realpathSync(absolute);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || !allowMissingLeaf) return undefined;
      const parentReal = realpathSync(dirname(absolute));
      targetReal = resolve(parentReal, absolute.slice(absolute.lastIndexOf(sep) + 1));
    }
    const projected = relative(repositoryReal, targetReal);
    if (!projected || projected === "." || projected === ".." || projected.startsWith(`..${sep}`) || isAbsolute(projected)) {
      return undefined;
    }
    return projected.split(sep).join("/");
  } catch {
    return undefined;
  }
}

function preToolGuard(payload, policy, repositoryRoot) {
  if (payload.hook_event_name !== "PreToolUse") return undefined;
  const toolName = safeToken(payload.tool_name);
  if (policy.cc18StaticMcpFixture === CC18_STATIC_MCP_FIXTURE && toolName === CC18_STATIC_MCP_TOOL) {
    // The fixture server itself accepts one fixed, no-argument method and
    // verifies that condition in its separate audit.  Do not inspect its
    // arguments here: this guard only permits the exact generated fixture
    // name, never a server, namespace, or generic MCP capability.
    return {
      decision: "allow",
      reasonCode: "cc18_static_mcp_fixture",
      approvedToolName: toolName,
      staticMcpFixture: true,
    };
  }
  const permissions = toolName ? policy.toolPermissions.get(toolName) : undefined;
  if (!toolName || !permissions || permissions.length === 0) {
    return { decision: "deny", reasonCode: "tool_not_allowed" };
  }
  if (policy.rejectToolName === toolName) {
    return { decision: "deny", reasonCode: "scenario_rejection" };
  }
  const input = parseJsonRecord(payload.tool_input) ?? {};
  let approvedRelativePath;
  if (PATH_SCOPED_TOOLS.has(toolName)) {
    const candidate = firstText(input, toolName === "Glob" || toolName === "Grep"
      ? ["path"]
      : ["file_path", "path"]);
    const allowMissingLeaf = WRITE_TOOLS.has(toolName);
    approvedRelativePath = guardedRepositoryPath(candidate, repositoryRoot, allowMissingLeaf);
    if (!approvedRelativePath) {
      return { decision: "deny", reasonCode: "path_outside_repository" };
    }
    if (!permissions.some((permission) => permission.relativePath === approvedRelativePath)) {
      return { decision: "deny", reasonCode: "path_not_permitted" };
    }
  }
  if (toolName === "Bash") {
    const command = firstText(input, ["command"]);
    if (!command || !permissions.some((permission) => permission.command === command)) {
      return { decision: "deny", reasonCode: "bash_command_not_allowed" };
    }
  }
  if (toolName === "Agent") {
    const subagentType = safeToken(firstText(input, ["subagent_type"]));
    if (!subagentType || !permissions.some((permission) => permission.subagentType === subagentType)) {
      return { decision: "deny", reasonCode: "agent_subtype_not_permitted" };
    }
  }
  if (toolName === "Skill") {
    const skillName = safeToken(firstText(input, ["skill", "skill_name"]));
    if (!skillName || !permissions.some((permission) => permission.skillName === skillName)) {
      return { decision: "deny", reasonCode: "skill_not_permitted" };
    }
  }
  return {
    decision: "allow",
    reasonCode: "scenario_allowed",
    approvedToolName: toolName,
    ...(approvedRelativePath ? { approvedRelativePath } : {}),
  };
}

function assertAbsent(path) {
  try {
    lstatSync(path);
    throw new Error("output_path_must_be_absent");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function assertPrivateParent(path) {
  const parent = dirname(path);
  const parentLink = lstatSync(parent);
  const parentStat = statSync(parent);
  if (
    parentLink.isSymbolicLink()
    || !parentStat.isDirectory()
  ) {
    throw new Error("output_parent_must_be_real_directory");
  }
  if (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) {
    throw new Error("output_parent_wrong_owner");
  }
  if ((parentStat.mode & 0o077) !== 0) throw new Error("output_parent_not_private");
}

function openExclusivePrivate(path) {
  assertPrivateParent(path);
  assertAbsent(path);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  const stat = fstatSync(fd);
  if (
    !stat.isFile()
    || stat.nlink !== 1
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (stat.mode & 0o777) !== 0o600
  ) {
    closeSync(fd);
    throw new Error("output_file_not_private_regular_file");
  }
  return fd;
}

function writeAll(fd, value, position = null) {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, position == null ? null : position + offset);
    if (written < 1) throw new Error("output_write_failed");
    offset += written;
  }
  bytes.fill(0);
}

function replaceFdJson(fd, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  ftruncateSync(fd, 0);
  writeAll(fd, serialized, 0);
}

function countPayloadRecords(path, payload) {
  if (path === "/v1/provider-hooks/claude-code") return 1;
  if (path === "/v1/logs") {
    return (payload.resourceLogs ?? []).reduce((sum, resource) => sum + (resource.scopeLogs ?? [])
      .reduce((scopeSum, scope) => scopeSum + (scope.logRecords?.length ?? 0), 0), 0);
  }
  return (payload.resourceSpans ?? []).reduce((sum, resource) => sum + (resource.scopeSpans ?? [])
    .reduce((scopeSum, scope) => scopeSum + (scope.spans ?? [])
      .reduce((spanSum, span) => spanSum + 1 + (span.events?.length ?? 0), 0), 0), 0);
}

async function readJsonBody(request, limitBytes) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limitBytes) throw new Error("payload_too_large");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("invalid_json");
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_json") throw error;
    throw new Error("invalid_json");
  } finally {
    body.fill(0);
    chunks.forEach((chunk) => chunk.fill(0));
  }
}

function newAliasState(initial) {
  const namespaces = initial
    ? new Map([...initial].map(([namespace, values]) => [namespace, new Map(values)]))
    : new Map();
  return {
    alias(namespace, value) {
      if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return undefined;
      let values = namespaces.get(namespace);
      if (!values) {
        values = new Map();
        namespaces.set(namespace, values);
      }
      let alias = values.get(value);
      if (!alias) {
        alias = `${namespace}_${String(values.size + 1).padStart(3, "0")}`;
        values.set(value, alias);
      }
      return alias;
    },
    counts() {
      return Object.fromEntries([...namespaces.entries()]
        .map(([namespace, values]) => [namespace, values.size])
        .sort(([left], [right]) => left.localeCompare(right)));
    },
    clone() {
      return newAliasState(namespaces);
    },
  };
}

function identityProjection(source, aliasState, extra = {}) {
  const result = {};
  for (const [outputKey, spec] of Object.entries(IDENTITY_KEYS)) {
    const raw = firstText(source, spec.keys);
    const alias = aliasState.alias(spec.namespace, raw);
    if (alias) result[outputKey] = alias;
  }
  for (const [outputKey, { namespace, value }] of Object.entries(extra)) {
    const alias = aliasState.alias(namespace, value);
    if (alias) result[outputKey] = alias;
  }
  return result;
}

function projectedAttributes(source, context, inheritedUnknownFieldCount = 0) {
  const safe = {};
  const presentFields = new Set();
  const redactedFields = new Set();
  let unknownFieldCount = inheritedUnknownFieldCount;
  let invalidKnownFieldCount = 0;

  for (const [key, value] of Object.entries(source)) {
    if (!SAFE_FIELD_NAME.test(key) || !KNOWN_ATTRIBUTE_KEYS.has(key)) {
      unknownFieldCount += 1;
      continue;
    }
    presentFields.add(key);
    if (IDENTITY_ATTRIBUTE_KEYS.has(key)) continue;
    if (key === "error" && context.kind === "hook" && context.name === "StopFailure") {
      if (typeof value === "string" && STOP_FAILURE_ERRORS.has(value)) safe.error = value;
      else invalidKnownFieldCount += 1;
      continue;
    }
    if (FORBIDDEN_KEYS.has(key)) {
      redactedFields.add(key);
      continue;
    }
    if (key === "model" || key === "gen_ai.request.model") {
      const model = safeModelId(value);
      if (model != null) safe[key] = model;
      else invalidKnownFieldCount += 1;
      continue;
    }
    if (ENUM_FIELDS.has(key)) {
      if (typeof value === "string" && ENUM_FIELDS.get(key).has(value)) safe[key] = value;
      else invalidKnownFieldCount += 1;
      continue;
    }
    if (TOKEN_FIELDS.has(key)) {
      const text = safeToken(value);
      if (text != null) safe[key] = text;
      else invalidKnownFieldCount += 1;
      continue;
    }
    if (SAFE_NUMERIC_KEYS.has(key)) {
      const number = safeNumberForKey(key, value);
      if (number != null) safe[key] = number;
      else invalidKnownFieldCount += 1;
      continue;
    }
    if (SAFE_BOOLEAN_KEYS.has(key)) {
      const boolean = safeBoolean(value);
      if (boolean != null) safe[key] = boolean;
      else invalidKnownFieldCount += 1;
      continue;
    }
    unknownFieldCount += 1;
  }

  return {
    safe,
    presentFields: [...presentFields].sort(),
    redactedFields: [...redactedFields].sort(),
    unknownFieldCount,
    invalidKnownFieldCount,
  };
}

function toolDetails(source, context, identities, state) {
  const toolUseId = identities.toolUseId;
  if (!toolUseId) return {};
  const prior = state.tools.get(toolUseId);
  const staticMcpFixture = context.guard?.staticMcpFixture === true || prior?.staticMcpFixture === true;
  const toolParameters = staticMcpFixture ? undefined : parseJsonRecord(source.tool_parameters);
  const name = safeToken(firstText(source, ["tool_name", "gen_ai.tool.name"]))
    ?? safeToken(toolParameters?.subagent_type ? "Agent" : undefined);
  const suppliedPath = staticMcpFixture ? undefined : toolPathFrom(source);
  const relativePath = guardedRepositoryPath(suppliedPath, state.repositoryRoot, true);
  const next = prior ?? {
    approvalObserved: false,
    approvedToolName: undefined,
    approvedRelativePath: undefined,
    staticMcpFixture: false,
    observedToolNames: new Set(),
    observedRelativePaths: new Set(),
    invalidPathEvidence: false,
    rejectedPreToolUse: false,
    completionMissingToolName: false,
    completionOutcomes: new Set(),
    observedOutcomes: new Set(),
    conflict: false,
  };

  if (staticMcpFixture) next.staticMcpFixture = true;

  if (name) next.observedToolNames.add(name);
  if (suppliedPath) {
    if (relativePath) next.observedRelativePaths.add(relativePath);
    else next.invalidPathEvidence = true;
  }

  if (context.kind === "hook" && context.name === "PreToolUse" && context.guard) {
    if (context.guard.decision === "allow") {
      const approvedToolName = context.guard.approvedToolName;
      const approvedRelativePath = context.guard.approvedRelativePath;
      if (next.approvalObserved && (
        next.approvedToolName !== approvedToolName
        || next.approvedRelativePath !== approvedRelativePath
      )) {
        next.conflict = true;
      }
      if (!next.approvalObserved) {
        next.approvalObserved = true;
        next.approvedToolName = approvedToolName;
        next.approvedRelativePath = approvedRelativePath;
      }
      if (
        next.rejectedPreToolUse
        || next.invalidPathEvidence
        || next.completionMissingToolName
        || [...next.observedToolNames].some((observed) => observed !== next.approvedToolName)
        || [...next.observedRelativePaths].some((observed) => observed !== next.approvedRelativePath)
      ) {
        next.conflict = true;
      }
    } else {
      next.rejectedPreToolUse = true;
      if (next.approvalObserved) next.conflict = true;
    }
  }

  if (next.approvalObserved && (
    (name && name !== next.approvedToolName)
    || (suppliedPath && (!relativePath || relativePath !== next.approvedRelativePath))
  )) {
    next.conflict = true;
  }

  let outcome;
  if (context.kind === "hook") {
    if (context.name === "PostToolUse") outcome = "success";
    if (context.name === "PostToolUseFailure") outcome = source.is_interrupt === true ? "rejected" : "failure";
    if (context.guard?.decision === "deny") outcome = "rejected";
  }
  const success = safeBoolean(source.success);
  if (success != null) outcome = success ? "success" : "failure";
  const decision = typeof source.decision === "string" ? source.decision.toLowerCase() : undefined;
  if (decision === "reject" || decision === "deny") outcome = "rejected";
  if (outcome) {
    next.observedOutcomes.add(outcome);
    if (context.kind === "hook" && (context.name === "PostToolUse" || context.name === "PostToolUseFailure")) {
      if (!name) next.completionMissingToolName = true;
      if (next.approvalObserved && (
        !name
        || name !== next.approvedToolName
        || (suppliedPath && (!relativePath || relativePath !== next.approvedRelativePath))
      )) {
        next.conflict = true;
      }
      next.completionOutcomes.add(outcome);
    }
  }
  if (next.observedOutcomes.size > 1 || next.completionOutcomes.size > 1) next.conflict = true;
  state.tools.set(toolUseId, next);

  return {
    ...(safeToken(toolParameters?.skill_name) ? { skillName: safeToken(toolParameters.skill_name) } : {}),
    ...(safeToken(toolParameters?.subagent_type) ? { subagentType: safeToken(toolParameters.subagent_type) } : {}),
    ...(safeToken(toolParameters?.mcp_server_name) ? { mcpServerName: safeToken(toolParameters.mcp_server_name) } : {}),
    ...(safeToken(toolParameters?.mcp_tool_name) ? { mcpToolName: safeToken(toolParameters.mcp_tool_name) } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

function makeSafeRecord(input, state) {
  const combined = { ...input.resourceAttributes, ...input.attributes };
  const identities = identityProjection(combined, state.aliases, input.extraIdentities);
  const inheritedUnknownFieldCount = (input.resourceAttributes[UNKNOWN_ATTRIBUTE_COUNT] ?? 0)
    + (input.attributes[UNKNOWN_ATTRIBUTE_COUNT] ?? 0);
  const projection = projectedAttributes(
    combined,
    { kind: input.kind, name: input.name },
    inheritedUnknownFieldCount,
  );
  const tool = toolDetails(combined, { kind: input.kind, name: input.name, guard: input.guard }, identities, state);
  const backgroundTaskCount = input.kind === "hook" && Array.isArray(input.raw.background_tasks)
    ? input.raw.background_tasks.length
    : undefined;
  const sessionCronCount = input.kind === "hook" && Array.isArray(input.raw.session_crons)
    ? input.raw.session_crons.length
    : undefined;
  if (backgroundTaskCount != null) projection.redactedFields.push("background_tasks");
  if (sessionCronCount != null) projection.redactedFields.push("session_crons");

  for (const modelKey of ["model", "gen_ai.request.model"]) {
    if (typeof projection.safe[modelKey] === "string") state.observedModels.add(projection.safe[modelKey]);
  }

  return {
    schemaVersion: 1,
    scenarioId: state.scenarioId,
    sequence: ++state.sequence,
    kind: input.kind,
    signal: input.signal,
    name: input.name,
    receivedAt: input.receivedAt,
    ...(input.providerStartedAt ? { providerStartedAt: input.providerStartedAt } : {}),
    ...(input.providerEndedAt ? { providerEndedAt: input.providerEndedAt } : {}),
    ...(input.statusCode != null ? { statusCode: input.statusCode } : {}),
    ...(Object.keys(identities).length > 0 ? { identities } : {}),
    ...(Object.keys(projection.safe).length > 0 ? { attributes: projection.safe } : {}),
    ...(backgroundTaskCount != null ? { backgroundTaskCount } : {}),
    ...(sessionCronCount != null ? { sessionCronCount } : {}),
    ...(input.guard ? { guardDecision: input.guard.decision, guardReasonCode: input.guard.reasonCode } : {}),
    ...tool,
    presentFields: projection.presentFields,
    redactedFields: [...new Set(projection.redactedFields)].sort(),
    unknownFieldCount: projection.unknownFieldCount + (input.unknownName ? 1 : 0),
    invalidKnownFieldCount: projection.invalidKnownFieldCount,
  };
}

function reduceHook(payload, receivedAt, state, guard) {
  const name = typeof payload.hook_event_name === "string" && HOOK_EVENTS.has(payload.hook_event_name)
    ? payload.hook_event_name
    : undefined;
  if (!name) throw new Error("unsupported_hook_event");
  const toolResponse = isRecord(payload.tool_response) ? payload.tool_response : undefined;
  const toolResponseAgentId = name === "PostToolUse"
    && payload.tool_name === "Agent"
    && toolResponse
    ? firstText(toolResponse, ["agentId"])
    : undefined;
  const record = makeSafeRecord({
    kind: "hook",
    signal: "hooks",
    name,
    receivedAt,
    raw: payload,
    resourceAttributes: {},
    attributes: payload,
    extraIdentities: {
      toolResponseAgentId: { namespace: "agent", value: toolResponseAgentId },
    },
    guard,
  }, state);
  return [record];
}

function reduceLogs(payload, receivedAt, state) {
  const result = [];
  for (const resourceLog of payload.resourceLogs ?? []) {
    if (!isRecord(resourceLog)) continue;
    const resourceAttributes = attributes(isRecord(resourceLog.resource) ? resourceLog.resource.attributes : undefined);
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      if (!isRecord(scopeLog)) continue;
      for (const record of scopeLog.logRecords ?? []) {
        if (!isRecord(record)) continue;
        const recordAttributes = attributes(record.attributes);
        const body = otlpValue(record.body);
        const name = knownRecordName(recordAttributes["event.name"])
          ?? knownRecordName(body)
          ?? "unknown";
        const safeRecord = makeSafeRecord({
          kind: "log",
          signal: "logs",
          name,
          receivedAt,
          raw: record,
          resourceAttributes,
          attributes: recordAttributes,
          providerStartedAt: timestampFromNanos(record.timeUnixNano),
          unknownName: name === "unknown",
          extraIdentities: {
            traceId: { namespace: "trace", value: typeof record.traceId === "string" ? record.traceId : undefined },
            spanId: { namespace: "span", value: typeof record.spanId === "string" ? record.spanId : undefined },
          },
        }, state);
        if (record.body != null) {
          safeRecord.redactedFields = [...new Set([...safeRecord.redactedFields, "body"])].sort();
        }
        result.push(safeRecord);
      }
    }
  }
  return result;
}

function reduceTraces(payload, receivedAt, state) {
  const result = [];
  for (const resourceSpan of payload.resourceSpans ?? []) {
    if (!isRecord(resourceSpan)) continue;
    const resourceAttributes = attributes(isRecord(resourceSpan.resource) ? resourceSpan.resource.attributes : undefined);
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      if (!isRecord(scopeSpan)) continue;
      for (const span of scopeSpan.spans ?? []) {
        if (!isRecord(span)) continue;
        const spanAttributes = attributes(span.attributes);
        const name = knownRecordName(span.name) ?? "unknown";
        const extraIdentities = {
          traceId: { namespace: "trace", value: typeof span.traceId === "string" ? span.traceId : undefined },
          spanId: { namespace: "span", value: typeof span.spanId === "string" ? span.spanId : undefined },
          parentSpanId: { namespace: "span", value: typeof span.parentSpanId === "string" ? span.parentSpanId : undefined },
        };
        result.push(makeSafeRecord({
          kind: "span",
          signal: "traces",
          name,
          receivedAt,
          raw: span,
          resourceAttributes,
          attributes: spanAttributes,
          providerStartedAt: timestampFromNanos(span.startTimeUnixNano),
          providerEndedAt: timestampFromNanos(span.endTimeUnixNano),
          statusCode: isRecord(span.status) ? safeNumberForKey("status_code", span.status.code) : undefined,
          extraIdentities,
          unknownName: name === "unknown",
        }, state));
        for (const event of span.events ?? []) {
          if (!isRecord(event)) continue;
          const eventAttributes = attributes(event.attributes);
          result.push(makeSafeRecord({
            kind: "span_event",
            signal: "traces",
            name: knownRecordName(event.name) ?? "unknown",
            receivedAt,
            raw: event,
            resourceAttributes,
            attributes: eventAttributes,
            providerStartedAt: timestampFromNanos(event.timeUnixNano),
            extraIdentities,
            unknownName: !knownRecordName(event.name),
          }, state));
        }
      }
    }
  }
  return result;
}

function manifestFor(state) {
  return {
    schemaVersion: 1,
    scenarioId: state.scenarioId,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    claudeVersion: state.claudeVersion,
    cliMode: state.cliMode,
    authClass: state.authClass,
    apiProvider: state.apiProvider,
    requestedModel: state.requestedModel,
    observedModels: [...state.observedModels].sort(),
    requestedTelemetryGates: {
      userPrompts: false,
      assistantResponses: false,
      toolDetails: true,
      toolContent: false,
      rawApiBodies: false,
      enhancedTelemetry: true,
    },
    telemetryGateEffectObserved: false,
    rawCapturePersisted: false,
  };
}

function summaryFor(state) {
  const causalWrites = state.completedAt
    ? [...new Set([...state.tools.values()]
      .filter((tool) => tool.approvalObserved
        && !tool.conflict
        && !tool.invalidPathEvidence
        && !tool.rejectedPreToolUse
        && !tool.completionMissingToolName
        && WRITE_TOOLS.has(tool.approvedToolName)
        && typeof tool.approvedRelativePath === "string"
        && [...tool.observedToolNames].every((observed) => observed === tool.approvedToolName)
        && [...tool.observedRelativePaths].every((observed) => observed === tool.approvedRelativePath)
        && tool.completionOutcomes.size === 1
        && tool.completionOutcomes.has("success")
        && tool.observedOutcomes.size === 1
        && tool.observedOutcomes.has("success"))
      .map((tool) => tool.approvedRelativePath))].sort()
    : [];
  return {
    schemaVersion: 1,
    scenarioId: state.scenarioId,
    acceptedRequestCount: state.acceptedRequests,
    acceptedRecordCount: state.sequence,
    outputBytes: state.outputBytes,
    firstAcceptedAt: state.firstAcceptedAt,
    lastAcceptedAt: state.lastAcceptedAt,
    recordCounts: Object.fromEntries([...state.recordCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    redactedFieldCounts: Object.fromEntries([...state.redactedFieldCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    unknownFieldCount: state.unknownFieldCount,
    invalidKnownFieldCount: state.invalidKnownFieldCount,
    aliasCounts: state.aliases.counts(),
    observedModels: [...state.observedModels].sort(),
    causalWrites,
    rawCapturePersisted: false,
  };
}

function jsonResponse(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function transactionState(state) {
  return {
    ...state,
    aliases: state.aliases.clone(),
    tools: new Map([...state.tools].map(([key, value]) => [key, {
      ...value,
      observedToolNames: new Set(value.observedToolNames),
      observedRelativePaths: new Set(value.observedRelativePaths),
      completionOutcomes: new Set(value.completionOutcomes),
      observedOutcomes: new Set(value.observedOutcomes),
    }])),
    observedModels: new Set(state.observedModels),
  };
}

function commitTransaction(state, transaction) {
  state.aliases = transaction.aliases;
  state.tools = transaction.tools;
  state.observedModels = transaction.observedModels;
  state.sequence = transaction.sequence;
}

export async function startClaudeMetadataCensusReceiver(options) {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("receiver_must_bind_loopback");
  if (!options.outputPath || !options.summaryPath || !options.manifestPath) throw new Error("missing_output_path");
  if (typeof options.bearerToken !== "string" || !SAFE_BEARER_TOKEN.test(options.bearerToken)) {
    throw new Error("receiver_bearer_required");
  }
  if (!Number.isSafeInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65_535) {
    throw new Error("invalid_receiver_port");
  }
  if (!options.repositoryRoot) throw new Error("repository_root_required");
  const requestedRepositoryRoot = resolve(options.repositoryRoot);
  const repositoryLink = lstatSync(requestedRepositoryRoot);
  const repositoryStat = statSync(requestedRepositoryRoot);
  if (repositoryLink.isSymbolicLink() || !repositoryStat.isDirectory()) throw new Error("repository_root_must_be_real_directory");
  const repositoryRoot = realpathSync(requestedRepositoryRoot);
  const scenarioId = safeToken(options.scenarioId);
  const claudeVersion = safeToken(options.claudeVersion);
  const cliMode = safeToken(options.cliMode);
  const authClass = safeToken(options.authClass);
  const apiProvider = safeToken(options.apiProvider);
  const requestedModel = safeModelId(options.requestedModel);
  if (!scenarioId) throw new Error("invalid_scenario_id");
  if (!claudeVersion) throw new Error("invalid_claude_version");
  if (!cliMode) throw new Error("invalid_cli_mode");
  if (!authClass) throw new Error("invalid_auth_class");
  if (!apiProvider) throw new Error("invalid_api_provider");
  if (!requestedModel) throw new Error("exact_model_id_required");
  if (!Array.isArray(options.toolPermissions)) throw new Error("invalid_tool_permissions");
  const cc18StaticMcpFixture = options.cc18StaticMcpFixture == null || options.cc18StaticMcpFixture === ""
    ? undefined
    : options.cc18StaticMcpFixture;
  if (cc18StaticMcpFixture && cc18StaticMcpFixture !== CC18_STATIC_MCP_FIXTURE) {
    throw new Error("invalid_cc18_static_mcp_fixture");
  }
  const toolPermissions = new Map();
  const permissionSignatures = new Set();
  for (const permission of options.toolPermissions) {
    if (!isRecord(permission) || !KNOWN_TOOL_NAMES.has(permission.toolName)) throw new Error("invalid_tool_permission");
    const keys = Object.keys(permission).sort();
    let expectedKeys;
    let signature;
    if (PATH_SCOPED_TOOLS.has(permission.toolName)) {
      expectedKeys = ["relativePath", "toolName"];
      if (
        typeof permission.relativePath !== "string"
        || !SAFE_RELATIVE_PATH.test(permission.relativePath)
        || permission.relativePath.split("/").some((segment) => segment === "." || segment === "..")
      ) {
        throw new Error("invalid_tool_permission_path");
      }
      signature = `${permission.toolName}:path:${permission.relativePath}`;
    } else if (permission.toolName === "Bash") {
      expectedKeys = ["command", "toolName"];
      if (
        typeof permission.command !== "string"
        || !SAFE_BASH_COMMAND.test(permission.command)
        || permission.command.split("/").includes("..")
      ) {
        throw new Error("invalid_tool_permission_command");
      }
      signature = `${permission.toolName}:command:${permission.command}`;
    } else if (permission.toolName === "Agent") {
      expectedKeys = ["subagentType", "toolName"];
      if (!safeToken(permission.subagentType)) throw new Error("invalid_tool_permission_subagent");
      signature = `${permission.toolName}:subagent:${permission.subagentType}`;
    } else if (permission.toolName === "Skill") {
      expectedKeys = ["skillName", "toolName"];
      if (!safeToken(permission.skillName)) throw new Error("invalid_tool_permission_skill");
      signature = `${permission.toolName}:skill:${permission.skillName}`;
    } else {
      throw new Error("unscoped_tool_permission_forbidden");
    }
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error("invalid_tool_permission_shape");
    }
    if (permissionSignatures.has(signature)) throw new Error("duplicate_tool_permission");
    permissionSignatures.add(signature);
    const existing = toolPermissions.get(permission.toolName) ?? [];
    existing.push({ ...permission });
    toolPermissions.set(permission.toolName, existing);
  }
  const rejectToolName = options.rejectToolName == null || options.rejectToolName === ""
    ? undefined
    : options.rejectToolName;
  if (rejectToolName && !toolPermissions.has(rejectToolName)) throw new Error("invalid_rejected_tool");
  if (cc18StaticMcpFixture && (toolPermissions.size !== 0 || rejectToolName)) {
    throw new Error("cc18_static_mcp_policy_conflict");
  }
  const stopBlockCount = options.stopBlockCount ?? 0;
  if (!Number.isSafeInteger(stopBlockCount) || stopBlockCount < 0 || stopBlockCount > 8) {
    throw new Error("invalid_stop_block_count");
  }

  const outputPath = resolve(options.outputPath);
  const summaryPath = resolve(options.summaryPath);
  const manifestPath = resolve(options.manifestPath);
  if (new Set([outputPath, summaryPath, manifestPath]).size !== 3) throw new Error("output_paths_must_be_distinct");
  const outputPaths = [outputPath, summaryPath, manifestPath];
  for (const path of outputPaths) {
    assertPrivateParent(path);
    assertAbsent(path);
  }
  const opened = [];
  let outputFd;
  let summaryFd;
  let manifestFd;
  try {
    outputFd = openExclusivePrivate(outputPath);
    opened.push([outputFd, outputPath]);
    summaryFd = openExclusivePrivate(summaryPath);
    opened.push([summaryFd, summaryPath]);
    manifestFd = openExclusivePrivate(manifestPath);
    opened.push([manifestFd, manifestPath]);
  } catch (error) {
    for (const [fd] of [...opened].reverse()) {
      try { closeSync(fd); } catch {}
    }
    for (const [, path] of [...opened].reverse()) {
      try { unlinkSync(path); } catch {}
    }
    throw error;
  }

  const state = {
    scenarioId,
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    claudeVersion,
    cliMode,
    authClass,
    apiProvider,
    requestedModel,
    repositoryRoot,
    aliases: newAliasState(),
    tools: new Map(),
    observedModels: new Set(),
    sequence: 0,
    outputBytes: 0,
    unknownFieldCount: 0,
    invalidKnownFieldCount: 0,
    acceptedRequests: 0,
    firstAcceptedAt: undefined,
    lastAcceptedAt: undefined,
    lastAcceptedMs: undefined,
    recordCounts: new Map(),
    redactedFieldCounts: new Map(),
    stopBlocksRemaining: stopBlockCount,
  };

  const quietMs = Number.isSafeInteger(options.quietMs) && options.quietMs >= 0 ? options.quietMs : DEFAULT_QUIET_MS;
  const bodyLimitBytes = Number.isSafeInteger(options.bodyLimitBytes) && options.bodyLimitBytes > 0
    ? options.bodyLimitBytes
    : DEFAULT_BODY_LIMIT_BYTES;
  const recordLimit = Number.isSafeInteger(options.recordLimit) && options.recordLimit > 0
    ? options.recordLimit
    : DEFAULT_RECORD_LIMIT;
  const totalRecordLimit = Number.isSafeInteger(options.totalRecordLimit) && options.totalRecordLimit > 0
    ? options.totalRecordLimit
    : DEFAULT_TOTAL_RECORD_LIMIT;
  const outputLimitBytes = Number.isSafeInteger(options.outputLimitBytes) && options.outputLimitBytes > 0
    ? options.outputLimitBytes
    : DEFAULT_OUTPUT_LIMIT_BYTES;
  const token = options.bearerToken;
  const policy = {
    toolPermissions,
    rejectToolName,
    cc18StaticMcpFixture,
  };
  let finalized = false;

  try {
    replaceFdJson(manifestFd, manifestFor(state));
  } catch (error) {
    for (const [fd] of [...opened].reverse()) {
      try { closeSync(fd); } catch {}
    }
    for (const [, path] of [...opened].reverse()) {
      try { unlinkSync(path); } catch {}
    }
    throw error;
  }

  const appendRecords = (records, transaction) => {
    const serialized = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    const bytes = Buffer.byteLength(serialized);
    if (transaction.sequence > totalRecordLimit) throw new Error("total_record_limit_exceeded");
    if (state.outputBytes + bytes > outputLimitBytes) throw new Error("output_limit_exceeded");
    try {
      writeAll(outputFd, serialized, state.outputBytes);
    } catch (error) {
      ftruncateSync(outputFd, state.outputBytes);
      throw error;
    }
    commitTransaction(state, transaction);
    state.outputBytes += bytes;
    for (const record of records) {
      const countKey = `${record.kind}:${record.name}`;
      state.recordCounts.set(countKey, (state.recordCounts.get(countKey) ?? 0) + 1);
      state.unknownFieldCount += record.unknownFieldCount;
      state.invalidKnownFieldCount += record.invalidKnownFieldCount;
      for (const key of record.redactedFields) {
        state.redactedFieldCounts.set(key, (state.redactedFieldCounts.get(key) ?? 0) + 1);
      }
    }
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    state.completedAt = new Date().toISOString();
    closeSync(outputFd);
    replaceFdJson(summaryFd, summaryFor(state));
    replaceFdJson(manifestFd, manifestFor(state));
    closeSync(summaryFd);
    closeSync(manifestFd);
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!safeHeaderMatches(request.headers.authorization, token)) {
        jsonResponse(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.headers["x-tirion-census-scenario"] !== state.scenarioId) {
        jsonResponse(response, 403, { error: "scenario_mismatch" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/control/status") {
        const quietForMs = state.lastAcceptedMs == null ? 0 : Math.max(0, Date.now() - state.lastAcceptedMs);
        jsonResponse(response, 200, {
          schemaVersion: 1,
          acceptedRequestCount: state.acceptedRequests,
          acceptedRecordCount: state.sequence,
          quietForMs,
          quiet: state.lastAcceptedMs != null && quietForMs >= quietMs,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/control/shutdown") {
        jsonResponse(response, 200, { status: "shutting_down" });
        setImmediate(() => server.close(() => finalize()));
        return;
      }
      const allowedPath = url.pathname === "/v1/logs"
        || url.pathname === "/v1/traces"
        || url.pathname === "/v1/provider-hooks/claude-code";
      if (request.method !== "POST" || !allowedPath) {
        jsonResponse(response, 404, { error: "not_found" });
        return;
      }
      if (String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        jsonResponse(response, 415, { error: "json_required" });
        return;
      }
      const payload = await readJsonBody(request, bodyLimitBytes);
      if (
        url.pathname === "/v1/provider-hooks/claude-code"
        && request.headers["x-tirion-hook-event"] !== payload.hook_event_name
      ) {
        jsonResponse(response, 422, { error: "hook_event_mismatch" });
        return;
      }
      const recordCount = countPayloadRecords(url.pathname, payload);
      if (!Number.isSafeInteger(recordCount) || recordCount < 1 || recordCount > recordLimit) {
        jsonResponse(response, 413, { error: "record_limit_exceeded" });
        return;
      }
      const receivedAt = new Date().toISOString();
      const transaction = transactionState(state);
      const stopGuard = url.pathname === "/v1/provider-hooks/claude-code"
        && payload.hook_event_name === "Stop"
        && state.stopBlocksRemaining > 0
        ? { decision: "block", reasonCode: "scenario_stop_block" }
        : undefined;
      const guard = url.pathname === "/v1/provider-hooks/claude-code"
        ? preToolGuard(payload, policy, repositoryRoot) ?? stopGuard
        : undefined;
      const records = url.pathname === "/v1/logs"
        ? reduceLogs(payload, receivedAt, transaction)
        : url.pathname === "/v1/traces"
          ? reduceTraces(payload, receivedAt, transaction)
          : reduceHook(payload, receivedAt, transaction, guard);
      if (records.length < 1 || records.length > recordLimit) {
        jsonResponse(response, 422, { error: "no_supported_records" });
        return;
      }
      appendRecords(records, transaction);
      state.acceptedRequests += 1;
      state.firstAcceptedAt ??= receivedAt;
      state.lastAcceptedAt = receivedAt;
      state.lastAcceptedMs = Date.now();

      if (
        url.pathname === "/v1/provider-hooks/claude-code"
        && payload.hook_event_name === "PreToolUse"
        && guard
      ) {
        jsonResponse(response, 200, {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: guard.decision,
            permissionDecisionReason: guard.decision === "allow"
              ? "Synthetic census scope accepted"
              : "Synthetic census scope rejected",
          },
        });
        return;
      }
      if (
        url.pathname === "/v1/provider-hooks/claude-code"
        && payload.hook_event_name === "Stop"
        && guard?.decision === "block"
      ) {
        state.stopBlocksRemaining -= 1;
        jsonResponse(response, 200, {
          decision: "block",
          reason: "Synthetic census requires one additional stop cycle",
        });
        return;
      }
      jsonResponse(response, 200, {});
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      const limited = code === "payload_too_large" || code === "total_record_limit_exceeded" || code === "output_limit_exceeded";
      const unsupported = code === "unsupported_hook_event";
      jsonResponse(response, limited ? 413 : unsupported ? 422 : 400, {
        error: limited ? code : unsupported ? code : "invalid_json",
      });
    }
  });

  server.on("close", finalize);
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port ?? 0, host, resolveListen);
    });
  } catch (error) {
    finalized = true;
    for (const [fd] of [...opened].reverse()) {
      try { closeSync(fd); } catch {}
    }
    for (const [, path] of [...opened].reverse()) {
      try { unlinkSync(path); } catch {}
    }
    throw error;
  }
  const address = server.address();
  if (!isRecord(address)) throw new Error("receiver_address_unavailable");

  return {
    host,
    port: address.port,
    baseUrl: `http://${host}:${address.port}`,
    snapshot: () => summaryFor(state),
    async close() {
      if (!server.listening) {
        finalize();
        return;
      }
      await new Promise((resolveClose) => server.close(resolveClose));
      finalize();
    },
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error("invalid_arguments");
    values[key.slice(2)] = value;
  }
  return values;
}

function parseJsonArray(value) {
  if (value == null || value === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid_json_array");
  }
  if (!Array.isArray(parsed)) throw new Error("invalid_json_array");
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const receiver = await startClaudeMetadataCensusReceiver({
    port: Number(args.port ?? 0),
    outputPath: args.output,
    summaryPath: args.summary,
    manifestPath: args.manifest,
    repositoryRoot: args["repo-root"],
    scenarioId: args.scenario,
    claudeVersion: process.env.TIRION_CENSUS_CLAUDE_VERSION,
    cliMode: process.env.TIRION_CENSUS_CLI_MODE,
    authClass: process.env.TIRION_CENSUS_AUTH_CLASS,
    apiProvider: process.env.TIRION_CENSUS_API_PROVIDER,
    requestedModel: process.env.TIRION_CENSUS_MODEL,
    bearerToken: process.env.TIRION_CENSUS_BEARER_TOKEN,
    toolPermissions: parseJsonArray(process.env.TIRION_CENSUS_TOOL_PERMISSIONS_JSON),
    cc18StaticMcpFixture: process.env.TIRION_CENSUS_CC18_STATIC_MCP_FIXTURE,
    rejectToolName: process.env.TIRION_CENSUS_REJECT_TOOL_NAME,
    stopBlockCount: Number(process.env.TIRION_CENSUS_STOP_BLOCK_COUNT ?? 0),
    quietMs: Number(args["quiet-ms"] ?? DEFAULT_QUIET_MS),
    bodyLimitBytes: Number(args["body-limit-bytes"] ?? DEFAULT_BODY_LIMIT_BYTES),
    recordLimit: Number(args["record-limit"] ?? DEFAULT_RECORD_LIMIT),
    totalRecordLimit: Number(args["total-record-limit"] ?? DEFAULT_TOTAL_RECORD_LIMIT),
    outputLimitBytes: Number(args["output-limit-bytes"] ?? DEFAULT_OUTPUT_LIMIT_BYTES),
  });
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, host: receiver.host, port: receiver.port })}\n`);
  const shutdown = async () => {
    await receiver.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "receiver_failed"}\n`);
    process.exit(1);
  });
}
