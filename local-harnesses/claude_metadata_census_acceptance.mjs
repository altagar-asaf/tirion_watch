import assert from "node:assert/strict";

export const CLAUDE_TITLE_MODEL = "claude-haiku-4-5-20251001";

export function cliScopeForPermission(permission) {
  if (permission.relativePath) return `${permission.toolName}(./${permission.relativePath})`;
  if (permission.command) return `Bash(${permission.command})`;
  if (permission.subagentType) return `Agent(${permission.subagentType})`;
  if (permission.skillName) return `Skill(${permission.skillName})`;
  assert.fail("unscoped receiver permission");
}

export function assertToolPermissionParity(policy, rejectedTool, availableTools, cliPermissions) {
  const available = new Set(availableTools);
  assert.ok(policy.every((permission) => available.has(permission.toolName)), "receiver policy contains an unavailable tool");
  const expectedCli = policy
    .filter((permission) => permission.toolName !== rejectedTool)
    .map(cliScopeForPermission)
    .sort();
  assert.deepEqual([...cliPermissions].sort(), expectedCli, "CLI and receiver scoped permissions diverged");
}

export function assertObservedModelContract(observedModels, requestedModel, { allowTitleModel = false } = {}) {
  assert.ok(observedModels.includes(requestedModel), "requested model was not observed");
  const allowed = allowTitleModel ? new Set([requestedModel, CLAUDE_TITLE_MODEL]) : new Set([requestedModel]);
  const unsupportedModels = observedModels.filter((model) => !allowed.has(model));
  assert.deepEqual(unsupportedModels, [], `scenario observed unsupported model(s): ${unsupportedModels.join(", ")}`);
  if (!allowTitleModel) assert.deepEqual(observedModels, [requestedModel], "successful scenario model set was not exact");
}

function modelFor(record) {
  return record.attributes?.model ?? record.attributes?.["gen_ai.request.model"];
}

export function assertSuccessfulLlmTopology(events, requestedModel, rootInteraction) {
  const llmSpans = events.filter((event) => event.kind === "span" && event.name === "claude_code.llm_request");
  const requestedSpans = llmSpans.filter((span) => modelFor(span) === requestedModel);
  const titleSpans = llmSpans.filter((span) => modelFor(span) === CLAUDE_TITLE_MODEL);

  assert.ok(requestedSpans.length >= 1, "successful scenario requires requested-model LLM work");
  assert.ok(titleSpans.length <= 1, "successful scenario permits at most one auxiliary Haiku title span");
  assert.equal(
    llmSpans.length,
    requestedSpans.length + titleSpans.length,
    "successful scenario observed an unsupported LLM model",
  );

  if (titleSpans.length === 1) {
    const titleSpan = titleSpans[0];
    const titleRequestId = titleSpan.identities?.requestId;
    assert.equal(titleSpan.identities?.traceId, rootInteraction.identities?.traceId, "title LLM trace mismatch");
    assert.equal(titleSpan.identities?.parentSpanId, rootInteraction.identities?.spanId, "title LLM parent mismatch");
    assert.equal(titleSpan.attributes?.success, true, "successful title LLM span lacks success evidence");
    assert.equal(typeof titleRequestId, "string", "title LLM span lacks request identity");

    const titleRecords = events.filter((event) => modelFor(event) === CLAUDE_TITLE_MODEL);
    assert.ok(titleRecords.every((event) => event.identities?.requestId === titleRequestId), "title model records do not share one request identity");
    const titleRequestLogs = titleRecords.filter((event) => event.kind === "log"
      && (event.name === "api_request" || event.name === "claude_code.api_request"));
    assert.equal(titleRequestLogs.length, 1, "title model requires exactly one API request log");
    assert.equal(
      titleRequestLogs[0].attributes?.query_source,
      "generate_session_title",
      "auxiliary Haiku request is not native session-title work",
    );
  }

  return {
    requestedSpanCount: requestedSpans.length,
    titleSpanCount: titleSpans.length,
  };
}

export function assertStopFailureLlmTopology(events, requestedModel, rootInteraction) {
  const llmSpans = events.filter((event) => event.kind === "span" && event.name === "claude_code.llm_request");
  const requestedSpans = llmSpans.filter((span) => modelFor(span) === requestedModel);
  const titleSpans = llmSpans.filter((span) => modelFor(span) === CLAUDE_TITLE_MODEL);

  assert.equal(requestedSpans.length, 1, "CC-13 requires exactly one failed requested-model LLM span");
  assert.ok(titleSpans.length <= 1, "CC-13 permits at most one auxiliary Haiku title span");
  assert.equal(
    llmSpans.length,
    requestedSpans.length + titleSpans.length,
    "CC-13 observed an unsupported LLM model",
  );

  for (const span of llmSpans) {
    assert.equal(span.identities?.traceId, rootInteraction.identities?.traceId, "failed LLM trace mismatch");
    assert.equal(span.identities?.parentSpanId, rootInteraction.identities?.spanId, "failed LLM parent mismatch");
    assert.ok(
      span.attributes?.status_code === 401 || span.attributes?.success === false || span.statusCode === 2,
      "LLM span lacks native failure evidence",
    );
  }

  return {
    requestedSpanCount: requestedSpans.length,
    titleSpanCount: titleSpans.length,
  };
}
