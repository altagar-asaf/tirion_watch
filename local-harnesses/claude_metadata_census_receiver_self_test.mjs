#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertObservedModelContract,
  assertSuccessfulLlmTopology,
  assertStopFailureLlmTopology,
  assertToolPermissionParity,
  CLAUDE_TITLE_MODEL,
} from "./claude_metadata_census_acceptance.mjs";
import { startClaudeMetadataCensusReceiver } from "./claude_metadata_census_receiver.mjs";

const root = mkdtempSync(join(tmpdir(), "tirion-claude-census-self-test-"));
chmodSync(root, 0o700);
const repositoryRoot = join(root, "repo");
const safeDir = join(root, "safe");
mkdirSync(repositoryRoot, { mode: 0o700 });
mkdirSync(join(repositoryRoot, "fixtures"), { recursive: true, mode: 0o700 });
mkdirSync(safeDir, { mode: 0o700 });
writeFileSync(join(repositoryRoot, "README.md"), "SYNTHETIC_REPOSITORY_CONTENT_CANARY\n", { mode: 0o600 });
const outsidePath = join(root, "outside-target.txt");
writeFileSync(outsidePath, "OUTSIDE_FILE_CONTENT_CANARY\n", { mode: 0o600 });
const repositoryEscapeLink = join(repositoryRoot, "fixtures", "escape-link.txt");
symlinkSync(outsidePath, repositoryEscapeLink);
const repositoryHardLink = join(repositoryRoot, "fixtures", "hard-link.txt");
linkSync(outsidePath, repositoryHardLink);

const outputPath = join(safeDir, "events.safe.ndjson");
const summaryPath = join(safeDir, "summary.safe.json");
const manifestPath = join(safeDir, "manifest.safe.json");
const token = "AUTHORIZATION_TOKEN_CANARY_DO_NOT_PERSIST";

function attr(key, value) {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

async function request(receiver, path, {
  body,
  auth = true,
  contentType = "application/json",
  method = "POST",
  scenarioId = "receiver-self-test",
  hookEvent,
} = {}) {
  const inferredHookEvent = hookEvent === undefined
    && path === "/v1/provider-hooks/claude-code"
    && body
    && typeof body === "object"
    ? body.hook_event_name
    : hookEvent;
  return fetch(`${receiver.baseUrl}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(scenarioId == null ? {} : { "x-tirion-census-scenario": scenarioId }),
      ...(inferredHookEvent == null ? {} : { "x-tirion-hook-event": inferredHookEvent }),
      ...(contentType ? { "content-type": contentType } : {}),
    },
    ...(body == null ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function privateCaseDirectory(name, mode = 0o700) {
  const path = join(root, name);
  mkdirSync(path, { mode });
  chmodSync(path, mode);
  return path;
}

function receiverOptions(directory, overrides = {}) {
  return {
    outputPath: join(directory, "events.safe.ndjson"),
    summaryPath: join(directory, "summary.safe.json"),
    manifestPath: join(directory, "manifest.safe.json"),
    repositoryRoot,
    scenarioId: "adversarial-self-test",
    claudeVersion: "2.1.201",
    cliMode: "synthetic-self-test",
    authClass: "subscription:synthetic",
    apiProvider: "firstParty",
    requestedModel: "claude-synthetic-1",
    bearerToken: token,
    toolPermissions: [],
    quietMs: 0,
    bodyLimitBytes: 256 * 1024,
    recordLimit: 100,
    totalRecordLimit: 100,
    outputLimitBytes: 1024 * 1024,
    ...overrides,
  };
}

function validateStopFailureTopologyShapes() {
  const requestedModel = "claude-sonnet-5";
  const rootInteraction = {
    identities: { traceId: "trace_001", spanId: "span_001" },
  };
  const failedSpan = (model, overrides = {}) => ({
    kind: "span",
    name: "claude_code.llm_request",
    identities: { traceId: "trace_001", parentSpanId: "span_001" },
    attributes: { model, success: false },
    ...overrides,
  });
  const requested = failedSpan(requestedModel);
  const title = failedSpan(CLAUDE_TITLE_MODEL);

  assert.deepEqual(assertStopFailureLlmTopology([requested], requestedModel, rootInteraction), {
    requestedSpanCount: 1,
    titleSpanCount: 0,
  });
  assert.deepEqual(assertStopFailureLlmTopology([requested, title], requestedModel, rootInteraction), {
    requestedSpanCount: 1,
    titleSpanCount: 1,
  });
  assert.throws(() => assertStopFailureLlmTopology([], requestedModel, rootInteraction));
  assert.throws(() => assertStopFailureLlmTopology([requested, requested], requestedModel, rootInteraction));
  assert.throws(() => assertStopFailureLlmTopology([requested, title, title], requestedModel, rootInteraction));
  assert.throws(() => assertStopFailureLlmTopology([
    requested,
    failedSpan("claude-opus-4-20250514"),
  ], requestedModel, rootInteraction));
  assert.throws(() => assertStopFailureLlmTopology([
    failedSpan(requestedModel, { identities: { traceId: "trace_002", parentSpanId: "span_001" } }),
  ], requestedModel, rootInteraction));
}

function validateSuccessfulTopologyShapes() {
  const requestedModel = "claude-sonnet-5";
  const rootInteraction = {
    identities: { traceId: "trace_001", spanId: "span_001" },
  };
  const llmSpan = (model, requestId, overrides = {}) => ({
    kind: "span",
    name: "claude_code.llm_request",
    identities: {
      requestId,
      traceId: "trace_001",
      parentSpanId: "span_001",
    },
    attributes: { model, success: true },
    ...overrides,
  });
  const requested = llmSpan(requestedModel, "request_001");
  const title = llmSpan(CLAUDE_TITLE_MODEL, "request_002");
  const titleLog = {
    kind: "log",
    name: "api_request",
    identities: { requestId: "request_002" },
    attributes: {
      model: CLAUDE_TITLE_MODEL,
      query_source: "generate_session_title",
    },
  };

  assert.deepEqual(assertSuccessfulLlmTopology([requested], requestedModel, rootInteraction), {
    requestedSpanCount: 1,
    titleSpanCount: 0,
  });
  assert.deepEqual(assertSuccessfulLlmTopology([requested, title, titleLog], requestedModel, rootInteraction), {
    requestedSpanCount: 1,
    titleSpanCount: 1,
  });
  assert.throws(() => assertSuccessfulLlmTopology([], requestedModel, rootInteraction));
  assert.throws(() => assertSuccessfulLlmTopology([requested, title], requestedModel, rootInteraction));
  assert.throws(() => assertSuccessfulLlmTopology([
    requested,
    title,
    { ...titleLog, attributes: { ...titleLog.attributes, query_source: "sdk" } },
  ], requestedModel, rootInteraction));
  assert.throws(() => assertSuccessfulLlmTopology([
    requested,
    title,
    llmSpan(CLAUDE_TITLE_MODEL, "request_003"),
    titleLog,
  ], requestedModel, rootInteraction));
  assert.throws(() => assertSuccessfulLlmTopology([
    requested,
    llmSpan(CLAUDE_TITLE_MODEL, "request_002", {
      identities: { requestId: "request_002", traceId: "trace_001", parentSpanId: "span_999" },
    }),
    titleLog,
  ], requestedModel, rootInteraction));
}

function validateToolPermissionParity() {
  const policy = [
    { toolName: "Agent", subagentType: "Explore" },
    { toolName: "Read", relativePath: "README.md" },
  ];
  assert.doesNotThrow(() => assertToolPermissionParity(
    policy,
    "",
    ["Agent", "Read", "Glob", "Grep"],
    ["Agent(Explore)", "Read(./README.md)"],
  ));
  assert.throws(() => assertToolPermissionParity(policy, "", ["Agent", "Read"], ["Agent", "Read"]));
  assert.throws(() => assertToolPermissionParity(policy, "", ["Agent", "Read"], ["Agent(Explore)", "Read(./other.md)"]));
  assert.throws(() => assertToolPermissionParity([
    ...policy,
    { toolName: "Glob", relativePath: "README.md" },
  ], "", ["Agent", "Read", "Glob"], ["Agent(Explore)", "Read(./README.md)"]));
  assert.doesNotThrow(() => assertToolPermissionParity(
    [{ toolName: "Read", relativePath: "README.md" }],
    "Read",
    ["Read"],
    [],
  ));
}

function validateObservedModelContracts() {
  assert.doesNotThrow(() => assertObservedModelContract(["claude-sonnet-5"], "claude-sonnet-5"));
  assert.throws(() => assertObservedModelContract([], "claude-sonnet-5"));
  assert.throws(() => assertObservedModelContract([
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5",
  ], "claude-sonnet-5"));
  assert.doesNotThrow(() => assertObservedModelContract([
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5",
  ], "claude-sonnet-5", { allowTitleModel: true }));
}

let receiver;
try {
  validateStopFailureTopologyShapes();
  validateSuccessfulTopologyShapes();
  validateToolPermissionParity();
  validateObservedModelContracts();
  const missingBearerDir = privateCaseDirectory("missing-bearer");
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(missingBearerDir, { bearerToken: undefined })),
    /receiver_bearer_required/,
  );
  assert.equal(existsSync(join(missingBearerDir, "events.safe.ndjson")), false);

  const movingModelDir = privateCaseDirectory("moving-model");
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(movingModelDir, { requestedModel: "sonnet" })),
    /exact_model_id_required/,
  );

  const malformedMcpFixtureDir = privateCaseDirectory("malformed-mcp-fixture");
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(malformedMcpFixtureDir, {
      cc18StaticMcpFixture: "any-mcp-tool",
    })),
    /invalid_cc18_static_mcp_fixture/,
  );
  const conflictingMcpFixtureDir = privateCaseDirectory("conflicting-mcp-fixture");
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(conflictingMcpFixtureDir, {
      cc18StaticMcpFixture: "readonly-success",
      toolPermissions: [{ toolName: "Read", relativePath: "README.md" }],
    })),
    /cc18_static_mcp_policy_conflict/,
  );

  const barePermissionDir = privateCaseDirectory("bare-permission");
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(barePermissionDir, {
      toolPermissions: [{ toolName: "Read" }],
    })),
    /invalid_tool_permission_path/,
  );

  const duplicatePathsDir = privateCaseDirectory("duplicate-paths");
  const duplicatePath = join(duplicatePathsDir, "same.safe.json");
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(duplicatePathsDir, {
      outputPath: duplicatePath,
      summaryPath: duplicatePath,
    })),
    /output_paths_must_be_distinct/,
  );

  const publicParentDir = privateCaseDirectory("public-parent", 0o755);
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(publicParentDir)),
    /output_parent_not_private/,
  );

  const symlinkOutputDir = privateCaseDirectory("symlink-output");
  const symlinkTarget = join(root, "symlink-target-canary.txt");
  writeFileSync(symlinkTarget, "SYMLINK_TARGET_MUST_NOT_CHANGE\n", { mode: 0o600 });
  symlinkSync(symlinkTarget, join(symlinkOutputDir, "events.safe.ndjson"));
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(symlinkOutputDir)),
    /output_path_must_be_absent/,
  );
  assert.equal(readFileSync(symlinkTarget, "utf8"), "SYMLINK_TARGET_MUST_NOT_CHANGE\n");

  const existingOutputDir = privateCaseDirectory("existing-output");
  const existingOutputPath = join(existingOutputDir, "events.safe.ndjson");
  writeFileSync(existingOutputPath, "EXISTING_OUTPUT_MUST_NOT_CHANGE\n", { mode: 0o600 });
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(existingOutputDir)),
    /output_path_must_be_absent/,
  );
  assert.equal(readFileSync(existingOutputPath, "utf8"), "EXISTING_OUTPUT_MUST_NOT_CHANGE\n");

  const lateExistingOutputDir = privateCaseDirectory("late-existing-output");
  writeFileSync(join(lateExistingOutputDir, "summary.safe.json"), "LATE_EXISTING_OUTPUT_MUST_NOT_CHANGE\n", { mode: 0o600 });
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(lateExistingOutputDir)),
    /output_path_must_be_absent/,
  );
  assert.equal(existsSync(join(lateExistingOutputDir, "events.safe.ndjson")), false);

  const realOutputParent = privateCaseDirectory("real-output-parent");
  const linkedOutputParent = join(root, "linked-output-parent");
  symlinkSync(realOutputParent, linkedOutputParent);
  await assert.rejects(
    startClaudeMetadataCensusReceiver(receiverOptions(linkedOutputParent)),
    /output_parent_must_be_real_directory/,
  );

  receiver = await startClaudeMetadataCensusReceiver({
    outputPath,
    summaryPath,
    manifestPath,
    repositoryRoot,
    scenarioId: "receiver-self-test",
    claudeVersion: "2.1.201",
    cliMode: "synthetic-self-test",
    authClass: "subscription:synthetic",
    apiProvider: "firstParty",
    requestedModel: "claude-synthetic-1",
    bearerToken: token,
    toolPermissions: [
      { toolName: "Read", relativePath: "README.md" },
      { toolName: "Bash", command: "./fail-seven.sh" },
      { toolName: "Agent", subagentType: "Explore" },
      { toolName: "Skill", skillName: "tirion-claude-census-skill" },
      ...[
        "fixtures/census.txt",
        "fixtures/out-of-order.txt",
        "fixtures/omitted-completion-path.txt",
        "fixtures/name-conflict.txt",
        "fixtures/path-approved.txt",
        "fixtures/corroboration-approved.txt",
        "fixtures/escape-link.txt",
        "fixtures/hard-link.txt",
      ].map((relativePath) => ({ toolName: "Write", relativePath })),
    ],
    rejectToolName: "Read",
    stopBlockCount: 1,
    quietMs: 20,
    bodyLimitBytes: 256 * 1024,
    recordLimit: 100,
    totalRecordLimit: 100,
    outputLimitBytes: 1024 * 1024,
  });

  assert.equal((await request(receiver, "/v1/logs", { auth: false, body: {} })).status, 401);
  const beforeHeaderRejections = receiver.snapshot();
  assert.equal((await request(receiver, "/v1/logs", { body: {}, scenarioId: null })).status, 403);
  assert.equal((await request(receiver, "/v1/logs", { body: {}, scenarioId: "wrong-scenario" })).status, 403);
  assert.equal((await request(receiver, "/v1/logs", { body: {}, scenarioId: "adversarial-self-test" })).status, 403);
  const headerProbeHook = {
    hook_event_name: "UserPromptSubmit",
    session_id: "HEADER_REJECTED_SESSION_CANARY",
    prompt_id: "HEADER_REJECTED_PROMPT_CANARY",
    prompt: "HEADER_REJECTED_PROMPT_CONTENT_CANARY",
  };
  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: headerProbeHook,
    hookEvent: null,
  })).status, 422);
  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: headerProbeHook,
    hookEvent: "Stop",
  })).status, 422);
  assert.deepEqual(receiver.snapshot(), beforeHeaderRejections, "header rejection mutated receiver state");
  assert.equal((await request(receiver, "/v1/logs", { contentType: "text/plain", body: "{}" })).status, 415);
  assert.equal((await request(receiver, "/v1/logs", { body: "{not-json" })).status, 400);
  assert.equal((await request(receiver, "/not-supported", { body: {} })).status, 404);
  assert.equal((await request(receiver, "/v1/logs", {
    body: JSON.stringify({ padding: "x".repeat(257 * 1024) }),
  })).status, 413);
  assert.equal((await request(receiver, "/v1/logs", {
    body: {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: Array.from({ length: 101 }, () => ({
            attributes: [attr("event.name", "api_request")],
          })),
        }],
      }],
    },
  })).status, 413);

  const beforeRejectedHook = receiver.snapshot();
  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "FutureHookEvent",
      session_id: "REJECTED_RAW_SESSION_ID_CANARY",
      prompt_id: "REJECTED_RAW_PROMPT_ID_CANARY",
    },
  })).status, 422);
  assert.deepEqual(receiver.snapshot(), beforeRejectedHook, "rejected hook mutated receiver state");

  const promptHook = {
    hook_event_name: "UserPromptSubmit",
    session_id: "RAW_SESSION_ID_CANARY",
    prompt_id: "RAW_PROMPT_ID_CANARY",
    transcript_path: `${root}/private-transcript-canary.jsonl`,
    cwd: repositoryRoot,
    prompt: "PROMPT_TEXT_CANARY_DO_NOT_PERSIST",
  };
  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", { body: promptHook })).status, 200);


  const denyResponse = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PreToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Read",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_READ",
      tool_input: { file_path: `${repositoryRoot}/README.md`, secret: "TOOL_ARGUMENT_CANARY" },
    },
  });
  assert.equal(denyResponse.status, 200);
  assert.equal((await denyResponse.json()).hookSpecificOutput.permissionDecision, "deny");
  const secondDenyResponse = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PreToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Read",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_READ_2",
      tool_input: { file_path: `${repositoryRoot}/README.md` },
    },
  });
  assert.equal((await secondDenyResponse.json()).hookSpecificOutput.permissionDecision, "deny");

  const freeTextTool = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PreToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Read /private/free text",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_FREE_TEXT",
      tool_input: { file_path: outsidePath },
    },
  });
  assert.equal((await freeTextTool.json()).hookSpecificOutput.permissionDecision, "deny");

  for (const [toolUseId, filePath] of [
    ["RAW_TOOL_USE_ID_CANARY_OUTSIDE", outsidePath],
    ["RAW_TOOL_USE_ID_CANARY_SYMLINK", repositoryEscapeLink],
    ["RAW_TOOL_USE_ID_CANARY_HARDLINK", repositoryHardLink],
  ]) {
    const response = await request(receiver, "/v1/provider-hooks/claude-code", {
      body: {
        hook_event_name: "PreToolUse",
        session_id: "RAW_SESSION_ID_CANARY",
        tool_name: "Write",
        tool_use_id: toolUseId,
        tool_input: { file_path: filePath, content: "PATH_GUARD_CONTENT_CANARY" },
      },
    });
    assert.equal((await response.json()).hookSpecificOutput.permissionDecision, "deny");
  }

  const expandedBash = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PreToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Bash",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_BASH_EXPANSION",
      tool_input: { command: "./fail-seven.sh || echo BASH_EXPANSION_CANARY" },
    },
  });
  assert.equal((await expandedBash.json()).hookSpecificOutput.permissionDecision, "deny");
  const bareBash = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_BASH_BARE",
      tool_input: {},
    },
  });
  assert.equal((await bareBash.json()).hookSpecificOutput.permissionDecision, "deny");

  const exactBash = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PreToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Bash",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_BASH_EXACT",
      tool_input: { command: "./fail-seven.sh" },
    },
  });
  assert.equal((await exactBash.json()).hookSpecificOutput.permissionDecision, "allow");

  for (const [toolUseId, toolInput, expectedDecision] of [
    ["RAW_TOOL_USE_ID_CANARY_WRITE_BARE", {}, "deny"],
    ["RAW_TOOL_USE_ID_CANARY_WRITE_UNPERMITTED", { file_path: `${repositoryRoot}/fixtures/not-permitted.txt` }, "deny"],
  ]) {
    const response = await request(receiver, "/v1/provider-hooks/claude-code", {
      body: {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_use_id: toolUseId,
        tool_input: toolInput,
      },
    });
    assert.equal((await response.json()).hookSpecificOutput.permissionDecision, expectedDecision);
  }

  for (const [toolUseId, toolInput, expectedDecision] of [
    ["RAW_TOOL_USE_ID_CANARY_AGENT_BARE", {}, "deny"],
    ["RAW_TOOL_USE_ID_CANARY_AGENT_WRONG", { subagent_type: "Plan" }, "deny"],
    ["RAW_TOOL_USE_ID_CANARY_AGENT_EXACT", { subagent_type: "Explore" }, "allow"],
  ]) {
    const response = await request(receiver, "/v1/provider-hooks/claude-code", {
      body: {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: toolUseId,
        tool_input: toolInput,
      },
    });
    assert.equal((await response.json()).hookSpecificOutput.permissionDecision, expectedDecision);
  }

  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PostToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Agent",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_AGENT_EXACT",
      tool_input: {
        subagent_type: "Explore",
        prompt: "AGENT_PROMPT_CANARY_DO_NOT_PERSIST",
      },
      tool_response: {
        status: "async_launched",
        agentId: "RAW_HOOK_AGENT_ID_CANARY",
        content: "AGENT_RESPONSE_CANARY_DO_NOT_PERSIST",
      },
    },
  })).status, 200);
  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "SubagentStart",
      session_id: "RAW_SESSION_ID_CANARY",
      agent_id: "RAW_HOOK_AGENT_ID_CANARY",
      agent_type: "Explore",
    },
  })).status, 200);

  for (const [toolUseId, toolInput, expectedDecision] of [
    ["RAW_TOOL_USE_ID_CANARY_SKILL_BARE", {}, "deny"],
    ["RAW_TOOL_USE_ID_CANARY_SKILL_WRONG", { skill: "other-skill" }, "deny"],
    ["RAW_TOOL_USE_ID_CANARY_SKILL_EXACT", { skill: "tirion-claude-census-skill" }, "allow"],
  ]) {
    const response = await request(receiver, "/v1/provider-hooks/claude-code", {
      body: {
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_use_id: toolUseId,
        tool_input: toolInput,
      },
    });
    assert.equal((await response.json()).hookSpecificOutput.permissionDecision, expectedDecision);
  }

  for (const toolName of ["Glob", "Grep"]) {
    const response = await request(receiver, "/v1/provider-hooks/claude-code", {
      body: {
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_use_id: `RAW_TOOL_USE_ID_CANARY_${toolName.toUpperCase()}`,
        tool_input: { path: repositoryRoot },
      },
    });
    assert.equal((await response.json()).hookSpecificOutput.permissionDecision, "deny");
  }

  const allowedWrite = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PreToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Write",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_WRITE",
      tool_input: { file_path: `${repositoryRoot}/fixtures/census.txt`, content: "FILE_CONTENT_CANARY_DO_NOT_PERSIST" },
    },
  });
  assert.equal((await allowedWrite.json()).hookSpecificOutput.permissionDecision, "allow");

  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PostToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Write",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_WRITE",
      tool_input: {
        file_path: `${repositoryRoot}/fixtures/census.txt`,
        content: "FILE_CONTENT_CANARY_DO_NOT_PERSIST",
      },
      tool_response: {
        success: true,
        content: "TOOL_RESPONSE_CANARY_DO_NOT_PERSIST",
      },
    },
  })).status, 200);

  assert.deepEqual(receiver.snapshot().causalWrites, [], "causal writes exposed before the contradiction horizon");

  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PostToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Write",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_OUT_OF_ORDER",
      tool_input: {
        file_path: `${repositoryRoot}/fixtures/out-of-order.txt`,
        content: "TUPLE_CONTENT_CANARY",
      },
    },
  })).status, 200);
  const outOfOrderApproval = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PreToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Write",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_OUT_OF_ORDER",
      tool_input: {
        file_path: `${repositoryRoot}/fixtures/out-of-order.txt`,
        content: "TUPLE_CONTENT_CANARY",
      },
    },
  });
  assert.equal((await outOfOrderApproval.json()).hookSpecificOutput.permissionDecision, "allow");

  const omittedCompletionPath = `${repositoryRoot}/fixtures/omitted-completion-path.txt`;
  writeFileSync(omittedCompletionPath, "OMITTED_PATH_CONTENT_CANARY", { mode: 0o600 });
  const omittedPathApproval = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PreToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Write",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_OMITTED_COMPLETION_PATH",
      tool_input: { file_path: omittedCompletionPath, content: "OMITTED_PATH_CONTENT_CANARY" },
    },
  });
  assert.equal((await omittedPathApproval.json()).hookSpecificOutput.permissionDecision, "allow");
  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "PostToolUse",
      session_id: "RAW_SESSION_ID_CANARY",
      tool_name: "Write",
      tool_use_id: "RAW_TOOL_USE_ID_CANARY_OMITTED_COMPLETION_PATH",
      tool_input: { content: "OMITTED_PATH_CONTENT_CANARY" },
    },
  })).status, 200);
  assert.equal(readFileSync(omittedCompletionPath, "utf8"), "OMITTED_PATH_CONTENT_CANARY");

  for (const tuple of [{
    toolUseId: "RAW_TOOL_USE_ID_CANARY_NAME_CONFLICT",
    approvedPath: `${repositoryRoot}/fixtures/name-conflict.txt`,
    completionName: "Edit",
    completionPath: `${repositoryRoot}/fixtures/name-conflict.txt`,
  }, {
    toolUseId: "RAW_TOOL_USE_ID_CANARY_PATH_CONFLICT",
    approvedPath: `${repositoryRoot}/fixtures/path-approved.txt`,
    completionName: "Write",
    completionPath: `${repositoryRoot}/fixtures/path-conflict.txt`,
  }, {
    toolUseId: "RAW_TOOL_USE_ID_CANARY_CORROBORATION_CONFLICT",
    approvedPath: `${repositoryRoot}/fixtures/corroboration-approved.txt`,
    completionName: "Write",
    completionPath: `${repositoryRoot}/fixtures/corroboration-approved.txt`,
  }]) {
    const approval = await request(receiver, "/v1/provider-hooks/claude-code", {
      body: {
        hook_event_name: "PreToolUse",
        session_id: "RAW_SESSION_ID_CANARY",
        tool_name: "Write",
        tool_use_id: tuple.toolUseId,
        tool_input: { file_path: tuple.approvedPath, content: "TUPLE_CONTENT_CANARY" },
      },
    });
    assert.equal((await approval.json()).hookSpecificOutput.permissionDecision, "allow");
    assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
      body: {
        hook_event_name: "PostToolUse",
        session_id: "RAW_SESSION_ID_CANARY",
        tool_name: tuple.completionName,
        tool_use_id: tuple.toolUseId,
        tool_input: { file_path: tuple.completionPath, content: "TUPLE_CONTENT_CANARY" },
      },
    })).status, 200);
  }

  const blockedStopResponse = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "Stop",
      session_id: "RAW_SESSION_ID_CANARY",
      prompt_id: "RAW_PROMPT_ID_CANARY",
      stop_hook_active: false,
      last_assistant_message: "ASSISTANT_MESSAGE_CANARY_DO_NOT_PERSIST",
      background_tasks: [{
        id: "RAW_BACKGROUND_TASK_ID_CANARY",
        type: "shell",
        status: "running",
        description: "BACKGROUND_DESCRIPTION_CANARY",
        command: "BACKGROUND_COMMAND_CANARY",
      }, {
        id: "RAW_SUBAGENT_TASK_ID_CANARY",
        type: "subagent",
        status: "running",
        agent_type: "Explore",
      }],
      session_crons: [{
        id: "RAW_CRON_ID_CANARY",
        schedule: "CRON_SCHEDULE_CANARY",
        recurring: true,
        prompt: "CRON_PROMPT_CANARY",
      }],
    },
  });
  assert.equal(blockedStopResponse.status, 200);
  assert.deepEqual(await blockedStopResponse.json(), {
    decision: "block",
    reason: "Synthetic census requires one additional stop cycle",
  });
  const allowedStopResponse = await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "Stop",
      session_id: "RAW_SESSION_ID_CANARY",
      prompt_id: "RAW_PROMPT_ID_CANARY",
      stop_hook_active: true,
      background_tasks: [],
      session_crons: [],
    },
  });
  assert.equal(allowedStopResponse.status, 200);
  assert.deepEqual(await allowedStopResponse.json(), {});
  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "StopFailure",
      session_id: "RAW_SESSION_ID_CANARY",
      prompt_id: "RAW_PROMPT_ID_CANARY",
      transcript_path: `${root}/stop-failure-transcript-canary.jsonl`,
      cwd: repositoryRoot,
      error: "authentication_failed",
      error_details: "STOP_FAILURE_DETAILS_CANARY_DO_NOT_PERSIST",
      last_assistant_message: "STOP_FAILURE_MESSAGE_CANARY_DO_NOT_PERSIST",
    },
  })).status, 200);
  assert.equal((await request(receiver, "/v1/provider-hooks/claude-code", {
    body: {
      hook_event_name: "StopFailure",
      session_id: "RAW_SESSION_ID_CANARY",
      prompt_id: "RAW_PROMPT_ID_CANARY",
      error: "model_not_found",
    },
  })).status, 200);

  const logs = {
    resourceLogs: [{
      resource: {
        attributes: [
          attr("service.name", "claude-code"),
          attr("service.version", "2.1.201"),
          attr("user.email", "PRIVATE_EMAIL_CANARY@example.test"),
          attr("organization.id", "RAW_ORGANIZATION_ID_CANARY"),
          attr("user.account_uuid", "RAW_ACCOUNT_UUID_CANARY"),
        ],
      },
      scopeLogs: [{
        logRecords: [{
          traceId: "RAW_TRACE_ID_CANARY",
          spanId: "RAW_LOG_SPAN_ID_CANARY",
          timeUnixNano: "1780876801000000000",
          body: { stringValue: "claude_code.api_request" },
          attributes: [
            attr("event.name", "api_request"),
            attr("event.sequence", 4),
            attr("session.id", "RAW_SESSION_ID_CANARY"),
            attr("prompt.id", "RAW_PROMPT_ID_CANARY"),
            attr("request_id", "RAW_REQUEST_ID_CANARY"),
            attr("model", "claude-synthetic-1"),
            attr("gen_ai.request.model", "sonnet"),
            attr("skill.source", "INVALID_ENUM_CANARY"),
            attr("future.secret", "UNKNOWN_FIELD_VALUE_CANARY"),
            attr("future/unsafe", "UNSAFE_FIELD_VALUE_CANARY"),
            attr("error_type", "ERROR_TYPE_SECRET_CANARY"),
            attr("input_tokens", 101),
            attr("output_tokens", 17),
            attr("cache_read_tokens", 23),
            attr("cache_creation_tokens", 5),
            attr("cost_usd", 0.0025),
            attr("prompt", "OTLP_PROMPT_CANARY_DO_NOT_PERSIST"),
            attr("response", "OTLP_RESPONSE_CANARY_DO_NOT_PERSIST"),
            attr("error", "OTLP_ERROR_MESSAGE_CANARY_DO_NOT_PERSIST"),
          ],
        }, {
          traceId: "RAW_TRACE_ID_CANARY",
          spanId: "RAW_INTERACTION_SPAN_ID_CANARY",
          timeUnixNano: "1780876800000000000",
          body: { stringValue: "claude_code.user_prompt" },
          attributes: [
            attr("event.name", "user_prompt"),
            attr("prompt.id", "RAW_PROMPT_ID_CANARY"),
            attr("event.sequence", 1),
            attr("prompt", "USER_PROMPT_BRIDGE_CONTENT_CANARY"),
          ],
        }],
      }],
    }],
  };
  assert.equal((await request(receiver, "/v1/logs", { body: logs })).status, 200);

  const traces = {
    resourceSpans: [{
      resource: {
        attributes: [
          attr("service.name", "claude-code"),
          attr("user.email", "TRACE_PRIVATE_EMAIL_CANARY@example.test"),
        ],
      },
      scopeSpans: [{
        spans: [{
          traceId: "RAW_TRACE_ID_CANARY",
          spanId: "RAW_INTERACTION_SPAN_ID_CANARY",
          name: "claude_code.interaction",
          startTimeUnixNano: "1780876800000000000",
          endTimeUnixNano: "1780876803000000000",
          attributes: [
            attr("session.id", "RAW_SESSION_ID_CANARY"),
            attr("prompt.id", "RAW_PROMPT_ID_CANARY"),
            attr("interaction.sequence", 1),
            attr("user_prompt", "TRACE_PROMPT_CANARY_DO_NOT_PERSIST"),
          ],
        }, {
          traceId: "RAW_TRACE_ID_CANARY",
          spanId: "RAW_LLM_SPAN_ID_CANARY",
          parentSpanId: "RAW_INTERACTION_SPAN_ID_CANARY",
          name: "claude_code.llm_request",
          startTimeUnixNano: "1780876800100000000",
          endTimeUnixNano: "1780876801100000000",
          attributes: [
            attr("session.id", "RAW_SESSION_ID_CANARY"),
            attr("prompt.id", "RAW_PROMPT_ID_CANARY"),
            attr("request_id", "RAW_REQUEST_ID_CANARY"),
            attr("agent_id", "RAW_AGENT_ID_CANARY"),
            attr("parent_agent_id", "RAW_PARENT_AGENT_ID_CANARY"),
            attr("model", "claude-synthetic-1"),
            attr("input_tokens", 101),
            attr("output_tokens", 17),
            attr("success", true),
          ],
        }, {
          traceId: "RAW_TRACE_ID_CANARY",
          spanId: "RAW_PARENT_AGENT_SPAN_ID_CANARY",
          parentSpanId: "RAW_INTERACTION_SPAN_ID_CANARY",
          name: "claude_code.llm_request",
          startTimeUnixNano: "1780876800200000000",
          endTimeUnixNano: "1780876801000000000",
          attributes: [
            attr("session.id", "RAW_SESSION_ID_CANARY"),
            attr("prompt.id", "RAW_PROMPT_ID_CANARY"),
            attr("request_id", "RAW_PARENT_REQUEST_ID_CANARY"),
            attr("agent_id", "RAW_PARENT_AGENT_ID_CANARY"),
            attr("model", "claude-synthetic-1"),
            attr("input_tokens", 11),
            attr("output_tokens", 3),
            attr("success", true),
          ],
        }, {
          traceId: "RAW_TRACE_ID_CANARY",
          spanId: "RAW_TOOL_SPAN_ID_CANARY",
          parentSpanId: "RAW_INTERACTION_SPAN_ID_CANARY",
          name: "claude_code.tool",
          startTimeUnixNano: "1780876801200000000",
          endTimeUnixNano: "1780876802200000000",
          attributes: [
            attr("session.id", "RAW_SESSION_ID_CANARY"),
            attr("prompt.id", "RAW_PROMPT_ID_CANARY"),
            attr("tool_use_id", "RAW_TOOL_USE_ID_CANARY_WRITE"),
            attr("tool_name", "Write"),
            attr("file_path", `${repositoryRoot}/fixtures/census.txt`),
            attr("success", true),
          ],
          events: [{
            name: "tool.output",
            timeUnixNano: "1780876802100000000",
            attributes: [
              attr("tool_output", "TRACE_TOOL_OUTPUT_CANARY_DO_NOT_PERSIST"),
              attr("content", "TRACE_FILE_CONTENT_CANARY_DO_NOT_PERSIST"),
            ],
          }],
        }, {
          traceId: "RAW_TRACE_ID_CANARY",
          spanId: "RAW_OUT_OF_ORDER_TOOL_SPAN_ID_CANARY",
          parentSpanId: "RAW_INTERACTION_SPAN_ID_CANARY",
          name: "claude_code.tool",
          startTimeUnixNano: "1780876801250000000",
          endTimeUnixNano: "1780876802250000000",
          attributes: [
            attr("tool_use_id", "RAW_TOOL_USE_ID_CANARY_OUT_OF_ORDER"),
            attr("tool_name", "Write"),
            attr("file_path", `${repositoryRoot}/fixtures/out-of-order.txt`),
            attr("success", true),
          ],
        }, {
          traceId: "RAW_TRACE_ID_CANARY",
          spanId: "RAW_CONFLICT_TOOL_SPAN_ID_CANARY",
          parentSpanId: "RAW_INTERACTION_SPAN_ID_CANARY",
          name: "claude_code.tool",
          startTimeUnixNano: "1780876801300000000",
          endTimeUnixNano: "1780876802300000000",
          attributes: [
            attr("tool_use_id", "RAW_TOOL_USE_ID_CANARY_CORROBORATION_CONFLICT"),
            attr("tool_name", "Write"),
            attr("file_path", `${repositoryRoot}/fixtures/corroboration-conflict.txt`),
            attr("success", true),
          ],
        }],
      }],
    }],
  };
  assert.equal((await request(receiver, "/v1/traces", { body: traces })).status, 200);
  assert.deepEqual(receiver.snapshot().causalWrites, [], "corroboration exposed causal writes before finalization");

  const beforeAttributeLimit = receiver.snapshot();
  assert.equal((await request(receiver, "/v1/logs", {
    body: {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            attributes: Array.from({ length: 2_049 }, (_, index) => attr(`future_${index}`, "ATTRIBUTE_LIMIT_CANARY")),
          }],
        }],
      }],
    },
  })).status, 400);
  assert.deepEqual(receiver.snapshot(), beforeAttributeLimit, "attribute-limit rejection mutated receiver state");

  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  const statusResponse = await request(receiver, "/control/status", { method: "GET", body: undefined, contentType: undefined });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).quiet, true);

  await receiver.close();
  receiver = undefined;

  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(safeDir).mode & 0o777, 0o700);
  for (const path of [outputPath, summaryPath, manifestPath]) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }

  const eventsText = readFileSync(outputPath, "utf8");
  const summaryText = readFileSync(summaryPath, "utf8");
  const manifestText = readFileSync(manifestPath, "utf8");
  const retained = `${eventsText}\n${summaryText}\n${manifestText}`;
  const forbiddenValues = [
    root,
    token,
    "RAW_SESSION_ID_CANARY",
    "RAW_PROMPT_ID_CANARY",
    "RAW_REQUEST_ID_CANARY",
    "RAW_PARENT_REQUEST_ID_CANARY",
    "RAW_TRACE_ID_CANARY",
    "RAW_AGENT_ID_CANARY",
    "RAW_PARENT_AGENT_ID_CANARY",
    "RAW_HOOK_AGENT_ID_CANARY",
    "AGENT_PROMPT_CANARY_DO_NOT_PERSIST",
    "AGENT_RESPONSE_CANARY_DO_NOT_PERSIST",
    "RAW_TOOL_USE_ID_CANARY",
    "PROMPT_TEXT_CANARY_DO_NOT_PERSIST",
    "TOOL_ARGUMENT_CANARY",
    "FILE_CONTENT_CANARY_DO_NOT_PERSIST",
    "TOOL_RESPONSE_CANARY_DO_NOT_PERSIST",
    "ASSISTANT_MESSAGE_CANARY_DO_NOT_PERSIST",
    "BACKGROUND_DESCRIPTION_CANARY",
    "BACKGROUND_COMMAND_CANARY",
    "CRON_SCHEDULE_CANARY",
    "CRON_PROMPT_CANARY",
    "PRIVATE_EMAIL_CANARY@example.test",
    "RAW_ORGANIZATION_ID_CANARY",
    "RAW_ACCOUNT_UUID_CANARY",
    "OTLP_PROMPT_CANARY_DO_NOT_PERSIST",
    "OTLP_RESPONSE_CANARY_DO_NOT_PERSIST",
    "OTLP_ERROR_MESSAGE_CANARY_DO_NOT_PERSIST",
    "USER_PROMPT_BRIDGE_CONTENT_CANARY",
    "TRACE_PROMPT_CANARY_DO_NOT_PERSIST",
    "TRACE_TOOL_OUTPUT_CANARY_DO_NOT_PERSIST",
    "TRACE_FILE_CONTENT_CANARY_DO_NOT_PERSIST",
    "STOP_FAILURE_DETAILS_CANARY_DO_NOT_PERSIST",
    "STOP_FAILURE_MESSAGE_CANARY_DO_NOT_PERSIST",
    "SYNTHETIC_REPOSITORY_CONTENT_CANARY",
    "OUTSIDE_FILE_CONTENT_CANARY",
    "PATH_GUARD_CONTENT_CANARY",
    "Read /private/free text",
    "BASH_EXPANSION_CANARY",
    "INVALID_ENUM_CANARY",
    "future.secret",
    "future/unsafe",
    "UNKNOWN_FIELD_VALUE_CANARY",
    "UNSAFE_FIELD_VALUE_CANARY",
    "ERROR_TYPE_SECRET_CANARY",
    "model_not_found",
    "sonnet",
    "REJECTED_RAW_SESSION_ID_CANARY",
    "REJECTED_RAW_PROMPT_ID_CANARY",
    "HEADER_REJECTED_SESSION_CANARY",
    "HEADER_REJECTED_PROMPT_CANARY",
    "HEADER_REJECTED_PROMPT_CONTENT_CANARY",
    "TUPLE_CONTENT_CANARY",
    "OMITTED_PATH_CONTENT_CANARY",
  ];
  for (const forbidden of forbiddenValues) {
    assert.equal(retained.includes(forbidden), false, `safe output retained forbidden value: ${forbidden}`);
  }

  const events = eventsText.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.identities?.sessionId === "session_001"));
  assert.ok(events.some((event) => event.identities?.requestId === "request_001"));
  const childTopology = events.find((event) => event.identities?.agentId && event.identities?.parentAgentId);
  assert.ok(childTopology);
  assert.match(childTopology.identities.agentId, /^agent_[0-9]{3}$/);
  assert.match(childTopology.identities.parentAgentId, /^agent_[0-9]{3}$/);
  assert.ok(events.some((event) => event.identities?.agentId === childTopology.identities.parentAgentId));
  assert.equal(events.some((event) => Object.values(event.identities ?? {}).some((value) => value.startsWith("parent_agent_"))), false);
  const agentToolCompletion = events.find((event) =>
    event.kind === "hook"
    && event.name === "PostToolUse"
    && event.attributes?.tool_name === "Agent"
  );
  const agentStart = events.find((event) =>
    event.kind === "hook"
    && event.name === "SubagentStart"
    && event.attributes?.agent_type === "Explore"
  );
  assert.ok(agentToolCompletion?.identities?.toolResponseAgentId);
  assert.equal(agentToolCompletion.identities.toolResponseAgentId, agentStart?.identities?.agentId);
  const interaction = events.find((event) => event.kind === "span" && event.name === "claude_code.interaction");
  const promptBridge = events.find((event) => event.kind === "log" && event.name === "user_prompt");
  const promptSubmission = events.find((event) => event.kind === "hook" && event.name === "UserPromptSubmit");
  const authenticatedFailure = events.find((event) => event.kind === "hook"
    && event.name === "StopFailure"
    && event.attributes?.error === "authentication_failed");
  assert.ok(interaction && promptBridge);
  assert.equal(promptSubmission?.identities?.sessionId, authenticatedFailure?.identities?.sessionId);
  assert.equal(promptSubmission?.identities?.promptId, authenticatedFailure?.identities?.promptId);
  assert.equal(promptBridge.identities?.promptId, promptSubmission?.identities?.promptId);
  assert.equal(promptBridge.identities?.sessionId, undefined);
  assert.equal(promptBridge.identities?.promptId, interaction.identities?.promptId);
  assert.equal(promptBridge.identities?.traceId, interaction.identities?.traceId);
  assert.equal(promptBridge.identities?.spanId, interaction.identities?.spanId);
  for (const llmSpan of events.filter((event) => event.kind === "span" && event.name === "claude_code.llm_request")) {
    assert.equal(llmSpan.identities?.traceId, interaction.identities?.traceId);
    assert.equal(llmSpan.identities?.parentSpanId, interaction.identities?.spanId);
  }
  assert.ok(events.some((event) => event.name === "Stop" && event.backgroundTaskCount === 2 && event.sessionCronCount === 1));
  assert.ok(events.some((event) => event.name === "StopFailure" && event.attributes?.error === "authentication_failed"));
  assert.ok(events.some((event) => event.name === "StopFailure"
    && !event.attributes?.error
    && event.invalidKnownFieldCount > 0));
  assert.equal(events.some((event) => Object.hasOwn(event, "causalRelativePath")), false);
  assert.ok(events.some((event) => event.guardReasonCode === "path_outside_repository" && event.outcome === "rejected"));
  assert.ok(events.some((event) => event.guardReasonCode === "path_not_permitted" && event.outcome === "rejected"));
  assert.ok(events.some((event) => event.guardReasonCode === "agent_subtype_not_permitted" && event.outcome === "rejected"));
  assert.ok(events.some((event) => event.guardReasonCode === "skill_not_permitted" && event.outcome === "rejected"));
  assert.ok(events.some((event) => event.guardReasonCode === "tool_not_allowed" && event.outcome === "rejected"));
  assert.ok(events.some((event) => event.redactedFields.includes("prompt")));
  assert.ok(events.some((event) => event.redactedFields.includes("tool_input")));
  assert.ok(events.some((event) => event.redactedFields.includes("body")));
  assert.ok(events.some((event) => event.redactedFields.includes("error_type")));
  assert.ok(events.some((event) => event.attributes?.input_tokens === 101 && event.attributes?.output_tokens === 17));

  const summary = JSON.parse(summaryText);
  assert.equal(summary.rawCapturePersisted, false);
  assert.deepEqual(summary.causalWrites, [
    "fixtures/census.txt",
    "fixtures/omitted-completion-path.txt",
    "fixtures/out-of-order.txt",
  ]);
  assert.ok(summary.acceptedRecordCount >= 10);
  assert.ok(summary.unknownFieldCount >= 1);
  assert.ok(summary.invalidKnownFieldCount >= 3);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.claudeVersion, "2.1.201");
  assert.equal(manifest.authClass, "subscription:synthetic");
  assert.equal(manifest.requestedModel, "claude-synthetic-1");
  assert.deepEqual(manifest.observedModels, ["claude-synthetic-1"]);
  assert.deepEqual(manifest.requestedTelemetryGates, {
    userPrompts: false,
    assistantResponses: false,
    toolDetails: true,
    toolContent: false,
    rawApiBodies: false,
    enhancedTelemetry: true,
  });
  assert.equal(manifest.telemetryGateEffectObserved, false);
  assert.equal(manifest.rawCapturePersisted, false);

  const staticMcpFixtureDir = privateCaseDirectory("cc18-static-mcp-fixture");
  const staticMcpFixtureScenario = "cc18-static-mcp-self-test";
  let staticMcpFixtureReceiver = await startClaudeMetadataCensusReceiver(receiverOptions(staticMcpFixtureDir, {
    scenarioId: staticMcpFixtureScenario,
    cc18StaticMcpFixture: "readonly-success",
    toolPermissions: [],
  }));
  try {
    const acceptedPre = await request(staticMcpFixtureReceiver, "/v1/provider-hooks/claude-code", {
      scenarioId: staticMcpFixtureScenario,
      body: {
        hook_event_name: "PreToolUse",
        session_id: "CC18_STATIC_MCP_SESSION_CANARY",
        tool_name: "mcp__tirion_cc18_local__tirion_cc18_readonly_success",
        tool_use_id: "CC18_STATIC_MCP_TOOL_USE_CANARY",
        tool_input: { ignored: "CC18_STATIC_MCP_INPUT_CANARY" },
        tool_parameters: {
          mcp_server_name: "CC18_STATIC_MCP_PARAMETER_SERVER_CANARY",
          mcp_tool_name: "CC18_STATIC_MCP_PARAMETER_TOOL_CANARY",
        },
      },
    });
    assert.equal((await acceptedPre.json()).hookSpecificOutput.permissionDecision, "allow");
    for (const toolName of [
      "mcp__tirion_cc18_local__tirion_cc18_controlled_failure",
      "mcp__unrelated_server__unrelated_tool",
    ]) {
      const rejectedPre = await request(staticMcpFixtureReceiver, "/v1/provider-hooks/claude-code", {
        scenarioId: staticMcpFixtureScenario,
        body: {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_use_id: `CC18_STATIC_MCP_REJECTED_${toolName}`,
          tool_input: { ignored: "CC18_STATIC_MCP_REJECTED_INPUT_CANARY" },
        },
      });
      assert.equal((await rejectedPre.json()).hookSpecificOutput.permissionDecision, "deny");
    }
    assert.equal((await request(staticMcpFixtureReceiver, "/v1/provider-hooks/claude-code", {
      scenarioId: staticMcpFixtureScenario,
      body: {
        hook_event_name: "PostToolUse",
        session_id: "CC18_STATIC_MCP_SESSION_CANARY",
        tool_name: "mcp__tirion_cc18_local__tirion_cc18_readonly_success",
        tool_use_id: "CC18_STATIC_MCP_TOOL_USE_CANARY",
        tool_input: { ignored: "CC18_STATIC_MCP_POST_INPUT_CANARY" },
        tool_parameters: {
          mcp_server_name: "CC18_STATIC_MCP_POST_PARAMETER_SERVER_CANARY",
          mcp_tool_name: "CC18_STATIC_MCP_POST_PARAMETER_TOOL_CANARY",
        },
        tool_response: { content: "CC18_STATIC_MCP_RESPONSE_CANARY" },
      },
    })).status, 200);
  } finally {
    await staticMcpFixtureReceiver.close();
    staticMcpFixtureReceiver = undefined;
  }
  const staticMcpEventsText = readFileSync(join(staticMcpFixtureDir, "events.safe.ndjson"), "utf8");
  for (const forbidden of [
    "CC18_STATIC_MCP_SESSION_CANARY",
    "CC18_STATIC_MCP_TOOL_USE_CANARY",
    "CC18_STATIC_MCP_INPUT_CANARY",
    "CC18_STATIC_MCP_PARAMETER_SERVER_CANARY",
    "CC18_STATIC_MCP_PARAMETER_TOOL_CANARY",
    "CC18_STATIC_MCP_REJECTED_INPUT_CANARY",
    "CC18_STATIC_MCP_POST_INPUT_CANARY",
    "CC18_STATIC_MCP_POST_PARAMETER_SERVER_CANARY",
    "CC18_STATIC_MCP_POST_PARAMETER_TOOL_CANARY",
    "CC18_STATIC_MCP_RESPONSE_CANARY",
  ]) {
    assert.equal(staticMcpEventsText.includes(forbidden), false, `static MCP output retained: ${forbidden}`);
  }
  const staticMcpEvents = staticMcpEventsText.trim().split("\n").filter(Boolean).map(JSON.parse);
  const staticMcpPre = staticMcpEvents.find((event) => event.name === "PreToolUse"
    && event.attributes?.tool_name === "mcp__tirion_cc18_local__tirion_cc18_readonly_success");
  const staticMcpPost = staticMcpEvents.find((event) => event.name === "PostToolUse"
    && event.attributes?.tool_name === "mcp__tirion_cc18_local__tirion_cc18_readonly_success");
  assert.equal(staticMcpPre?.guardDecision, "allow");
  assert.equal(staticMcpPre?.guardReasonCode, "cc18_static_mcp_fixture");
  assert.equal(staticMcpPost?.outcome, "success");
  assert.equal(staticMcpPre?.mcpServerName, undefined);
  assert.equal(staticMcpPre?.mcpToolName, undefined);
  assert.equal(staticMcpPost?.mcpServerName, undefined);
  assert.equal(staticMcpPost?.mcpToolName, undefined);

  const totalLimitDir = privateCaseDirectory("total-limit");
  let totalLimitReceiver = await startClaudeMetadataCensusReceiver(receiverOptions(totalLimitDir, {
    totalRecordLimit: 1,
  }));
  try {
    assert.equal((await request(totalLimitReceiver, "/v1/provider-hooks/claude-code", {
      scenarioId: "adversarial-self-test",
      body: {
        hook_event_name: "UserPromptSubmit",
        session_id: "TOTAL_LIMIT_SESSION_A_CANARY",
        prompt: "TOTAL_LIMIT_PROMPT_CANARY",
      },
    })).status, 200);
    const beforeTotalLimit = totalLimitReceiver.snapshot();
    assert.equal((await request(totalLimitReceiver, "/v1/logs", {
      scenarioId: "adversarial-self-test",
      body: {
        resourceLogs: [{
          scopeLogs: [{
            logRecords: [{
              attributes: [
                attr("event.name", "api_request"),
                attr("session.id", "TOTAL_LIMIT_REJECTED_SESSION_B_CANARY"),
              ],
            }, {
              attributes: [
                attr("event.name", "api_request"),
                attr("session.id", "TOTAL_LIMIT_REJECTED_SESSION_C_CANARY"),
              ],
            }],
          }],
        }],
      },
    })).status, 413);
    assert.deepEqual(totalLimitReceiver.snapshot(), beforeTotalLimit, "global record limit rejection mutated state");
  } finally {
    await totalLimitReceiver.close();
    totalLimitReceiver = undefined;
  }
  const totalLimitLines = readFileSync(join(totalLimitDir, "events.safe.ndjson"), "utf8").trim().split("\n").filter(Boolean);
  assert.equal(totalLimitLines.length, 1);

  const outputLimitDir = privateCaseDirectory("output-limit");
  let outputLimitReceiver = await startClaudeMetadataCensusReceiver(receiverOptions(outputLimitDir, {
    outputLimitBytes: 1,
  }));
  try {
    const beforeOutputLimit = outputLimitReceiver.snapshot();
    assert.equal((await request(outputLimitReceiver, "/v1/provider-hooks/claude-code", {
      scenarioId: "adversarial-self-test",
      body: {
        hook_event_name: "UserPromptSubmit",
        session_id: "OUTPUT_LIMIT_REJECTED_SESSION_CANARY",
        prompt: "OUTPUT_LIMIT_PROMPT_CANARY",
      },
    })).status, 413);
    assert.deepEqual(outputLimitReceiver.snapshot(), beforeOutputLimit, "output limit rejection mutated state");
  } finally {
    await outputLimitReceiver.close();
    outputLimitReceiver = undefined;
  }
  assert.equal(readFileSync(join(outputLimitDir, "events.safe.ndjson"), "utf8"), "");

  const tupleRollbackDir = privateCaseDirectory("tuple-rollback");
  let tupleRollbackReceiver = await startClaudeMetadataCensusReceiver(receiverOptions(tupleRollbackDir, {
    toolPermissions: [{ toolName: "Write", relativePath: "fixtures/rollback-valid.txt" }],
    totalRecordLimit: 2,
  }));
  try {
    const approvedPath = `${repositoryRoot}/fixtures/rollback-valid.txt`;
    const approval = await request(tupleRollbackReceiver, "/v1/provider-hooks/claude-code", {
      scenarioId: "adversarial-self-test",
      body: {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_use_id: "ROLLBACK_TOOL_USE_ID_CANARY",
        tool_input: { file_path: approvedPath, content: "ROLLBACK_CONTENT_CANARY" },
      },
    });
    assert.equal((await approval.json()).hookSpecificOutput.permissionDecision, "allow");
    assert.equal((await request(tupleRollbackReceiver, "/v1/provider-hooks/claude-code", {
      scenarioId: "adversarial-self-test",
      body: {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_use_id: "ROLLBACK_TOOL_USE_ID_CANARY",
        tool_input: { file_path: approvedPath, content: "ROLLBACK_CONTENT_CANARY" },
      },
    })).status, 200);
    assert.equal((await request(tupleRollbackReceiver, "/v1/provider-hooks/claude-code", {
      scenarioId: "adversarial-self-test",
      body: {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_use_id: "ROLLBACK_TOOL_USE_ID_CANARY",
        tool_input: { file_path: approvedPath, content: "ROLLBACK_MISMATCH_CANARY" },
      },
    })).status, 413);
    assert.deepEqual(tupleRollbackReceiver.snapshot().causalWrites, []);
  } finally {
    await tupleRollbackReceiver.close();
    tupleRollbackReceiver = undefined;
  }
  const tupleRollbackSummary = JSON.parse(readFileSync(join(tupleRollbackDir, "summary.safe.json"), "utf8"));
  assert.deepEqual(tupleRollbackSummary.causalWrites, ["fixtures/rollback-valid.txt"]);
  const tupleRollbackEvents = readFileSync(join(tupleRollbackDir, "events.safe.ndjson"), "utf8");
  assert.equal(tupleRollbackEvents.trim().split("\n").length, 2);
  for (const forbidden of [root, "ROLLBACK_TOOL_USE_ID_CANARY", "ROLLBACK_CONTENT_CANARY", "ROLLBACK_MISMATCH_CANARY"]) {
    assert.equal(tupleRollbackEvents.includes(forbidden), false);
  }

  process.stdout.write("PASS: Claude metadata census receiver self-test\n");
} finally {
  if (receiver) await receiver.close();
  rmSync(root, { recursive: true, force: true });
}
