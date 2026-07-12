import type {
  QueryOccurrenceV1,
  SafeActivityAtomV1,
  SafeActivityOutcome,
  SafeUsageAtomV1
} from "@tirion/agent-contract";

export type ComplexRunTokenVector = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

type ComplexRunParticipant = {
  queryId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  tokens: ComplexRunTokenVector;
};

type ComplexRunChild = ComplexRunParticipant & {
  tools: Array<{
    name: string;
    count: number;
    outcome: SafeActivityOutcome;
  }>;
};

export type ComplexChildAgentScenario = {
  schemaVersion: 1;
  fixtureId: string;
  derivedFrom: "codex-desktop-v3" | "codex-desktop-v4";
  provider: "codex";
  runtime: "codex";
  model: string;
  repositoryKey: string;
  root: ComplexRunParticipant;
  children: ComplexRunChild[];
  internalSession: ComplexRunParticipant;
  subagent: {
    name: string;
    outcome: "unknown";
  };
  rootTools: Array<{
    name: string;
    count: number;
    outcome: SafeActivityOutcome;
  }>;
  writes: Array<{
    artifactKey: string;
    relativePath: string;
  }>;
  expected: {
    publicTotalTokens: number;
    childTotalTokens: number;
    excludedInternalTokens: number;
    shellCount: number;
  };
};

// These are synthetic metadata-only replays of the v3/v4 acceptance invariants.
// Public and child totals match the accepted runs; token-dimension allocations are
// deterministic test data and do not contain captured prompt, response, or tool content.
export const complexChildAgentScenarios: readonly ComplexChildAgentScenario[] = [{
  schemaVersion: 1,
  fixtureId: "codex-three-child-single-file-v1",
  derivedFrom: "codex-desktop-v3",
  provider: "codex",
  runtime: "codex",
  model: "gpt-5.5",
  repositoryKey: "repo_fixture_codex_three_child",
  root: {
    queryId: "qry_fixture_codex_three_child",
    sessionId: "ses_fixture_codex_three_child",
    startedAt: "2026-07-11T08:00:00.000Z",
    endedAt: "2026-07-11T08:00:20.000Z",
    tokens: tokenVector(157_800, 566, 120_000, 0, 64)
  },
  children: [{
    queryId: "qry_fixture_codex_three_child_a",
    sessionId: "ses_fixture_codex_three_child_a",
    startedAt: "2026-07-11T08:00:02.000Z",
    endedAt: "2026-07-11T08:00:08.000Z",
    tokens: tokenVector(31_500, 215, 24_000, 0, 40),
    tools: [{ name: "Bash", count: 1, outcome: "unknown" }]
  }, {
    queryId: "qry_fixture_codex_three_child_b",
    sessionId: "ses_fixture_codex_three_child_b",
    startedAt: "2026-07-11T08:00:03.000Z",
    endedAt: "2026-07-11T08:00:12.000Z",
    tokens: tokenVector(49_000, 309, 40_000, 0, 60),
    tools: [{ name: "Bash", count: 1, outcome: "unknown" }]
  }, {
    queryId: "qry_fixture_codex_three_child_c",
    sessionId: "ses_fixture_codex_three_child_c",
    startedAt: "2026-07-11T08:00:04.000Z",
    endedAt: "2026-07-11T08:00:10.000Z",
    tokens: tokenVector(31_300, 201, 24_000, 0, 32),
    tools: [{ name: "Bash", count: 1, outcome: "unknown" }]
  }],
  internalSession: {
    queryId: "qry_fixture_codex_three_child_internal",
    sessionId: "ses_fixture_codex_three_child_internal",
    startedAt: "2026-07-11T08:00:00.100Z",
    endedAt: "2026-07-11T08:00:01.000Z",
    tokens: tokenVector(8_863, 52, 7_500, 0, 0)
  },
  subagent: { name: "explorer", outcome: "unknown" },
  rootTools: [
    { name: "spawn_agent", count: 3, outcome: "success" },
    { name: "close_agent", count: 3, outcome: "success" },
    { name: "apply_patch", count: 2, outcome: "success" },
    { name: "Bash", count: 1, outcome: "unknown" }
  ],
  writes: [{
    artifactKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    relativePath: "fixtures/codex-three-child.txt"
  }],
  expected: {
    publicTotalTokens: 270_891,
    childTotalTokens: 112_525,
    excludedInternalTokens: 8_915,
    shellCount: 4
  }
}, {
  schemaVersion: 1,
  fixtureId: "codex-four-child-multi-file-v1",
  derivedFrom: "codex-desktop-v4",
  provider: "codex",
  runtime: "codex",
  model: "gpt-5.5",
  repositoryKey: "repo_fixture_codex_four_child",
  root: {
    queryId: "qry_fixture_codex_four_child",
    sessionId: "ses_fixture_codex_four_child",
    startedAt: "2026-07-11T09:00:00.000Z",
    endedAt: "2026-07-11T09:00:24.000Z",
    tokens: tokenVector(206_800, 503, 170_000, 0, 70)
  },
  children: [{
    queryId: "qry_fixture_codex_four_child_a",
    sessionId: "ses_fixture_codex_four_child_a",
    startedAt: "2026-07-11T09:00:02.000Z",
    endedAt: "2026-07-11T09:00:08.000Z",
    tokens: tokenVector(29_000, 177, 22_000, 0, 30),
    tools: [{ name: "Bash", count: 1, outcome: "unknown" }]
  }, {
    queryId: "qry_fixture_codex_four_child_b",
    sessionId: "ses_fixture_codex_four_child_b",
    startedAt: "2026-07-11T09:00:03.000Z",
    endedAt: "2026-07-11T09:00:09.000Z",
    tokens: tokenVector(29_350, 200, 22_500, 0, 32),
    tools: [{ name: "Bash", count: 1, outcome: "unknown" }]
  }, {
    queryId: "qry_fixture_codex_four_child_c",
    sessionId: "ses_fixture_codex_four_child_c",
    startedAt: "2026-07-11T09:00:04.000Z",
    endedAt: "2026-07-11T09:00:10.000Z",
    tokens: tokenVector(29_180, 181, 22_100, 0, 31),
    tools: [{ name: "Bash", count: 1, outcome: "unknown" }]
  }, {
    queryId: "qry_fixture_codex_four_child_d",
    sessionId: "ses_fixture_codex_four_child_d",
    startedAt: "2026-07-11T09:00:05.000Z",
    endedAt: "2026-07-11T09:00:11.000Z",
    tokens: tokenVector(29_450, 219, 22_400, 0, 36),
    tools: [{ name: "Bash", count: 1, outcome: "unknown" }]
  }],
  internalSession: {
    queryId: "qry_fixture_codex_four_child_internal",
    sessionId: "ses_fixture_codex_four_child_internal",
    startedAt: "2026-07-11T09:00:00.100Z",
    endedAt: "2026-07-11T09:00:01.000Z",
    tokens: tokenVector(8_863, 52, 7_500, 0, 0)
  },
  subagent: { name: "explorer", outcome: "unknown" },
  rootTools: [
    { name: "spawn_agent", count: 4, outcome: "success" },
    { name: "close_agent", count: 4, outcome: "success" },
    { name: "apply_patch", count: 2, outcome: "success" },
    { name: "Bash", count: 2, outcome: "unknown" }
  ],
  writes: [{
    artifactKey: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    relativePath: "fixtures/codex-four-child-a.txt"
  }, {
    artifactKey: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    relativePath: "fixtures/codex-four-child-b.txt"
  }],
  expected: {
    publicTotalTokens: 325_060,
    childTotalTokens: 117_757,
    excludedInternalTokens: 8_915,
    shellCount: 6
  }
}];

export function usageAtomsForComplexScenario(scenario: ComplexChildAgentScenario): SafeUsageAtomV1[] {
  return [scenario.root, ...scenario.children]
    .flatMap((participant) => participantUsageAtoms(scenario, participant))
    .concat(participantUsageAtoms(scenario, scenario.internalSession, "internal"));
}

export function occurrencesForComplexScenario(scenario: ComplexChildAgentScenario): QueryOccurrenceV1[] {
  return [{
    schemaVersion: 1,
    queryId: scenario.root.queryId,
    sessionId: scenario.root.sessionId,
    lifecycleVisibility: "customer",
    provider: scenario.provider,
    runtime: scenario.runtime,
    startedAt: scenario.root.startedAt,
    completedAt: scenario.root.endedAt,
    completionEvidence: "stop_hook",
    repositoryKey: scenario.repositoryKey,
    promptState: "disabled",
    evidence: "submission_hook"
  }, ...scenario.children.map((child): QueryOccurrenceV1 => ({
    schemaVersion: 1,
    queryId: child.queryId,
    sessionId: child.sessionId,
    parentSessionId: scenario.root.sessionId,
    lifecycleVisibility: "customer",
    provider: scenario.provider,
    runtime: scenario.runtime,
    startedAt: child.startedAt,
    completedAt: child.endedAt,
    completionEvidence: "closed_root_span",
    repositoryKey: scenario.repositoryKey,
    promptState: "disabled",
    evidence: "submission_hook"
  })), {
    schemaVersion: 1,
    queryId: scenario.internalSession.queryId,
    sessionId: scenario.internalSession.sessionId,
    lifecycleVisibility: "internal",
    provider: scenario.provider,
    runtime: scenario.runtime,
    startedAt: scenario.internalSession.startedAt,
    completedAt: scenario.internalSession.endedAt,
    completionEvidence: "provider_completed_event",
    promptState: "disabled",
    evidence: "provider_prompt_id"
  }];
}

export function activitiesForComplexScenario(scenario: ComplexChildAgentScenario): SafeActivityAtomV1[] {
  let sequence = 0;
  const nextTime = (): string => new Date(Date.parse(scenario.root.startedAt) + (++sequence * 10)).toISOString();
  const rootActivities = scenario.rootTools.flatMap((group) => Array.from({ length: group.count }, (_, index) => {
    const at = nextTime();
    return {
      schemaVersion: 1 as const,
      activityId: `act_${scenario.fixtureId}_root_${safeId(group.name)}_${index}`,
      queryId: scenario.root.queryId,
      sessionId: scenario.root.sessionId,
      repositoryKey: scenario.repositoryKey,
      provider: scenario.provider,
      runtime: scenario.runtime,
      kind: "tool" as const,
      name: group.name,
      outcome: group.outcome,
      startedAt: at,
      endedAt: at
    };
  }));
  const subagents = scenario.children.map((child, index): SafeActivityAtomV1 => ({
    schemaVersion: 1,
    activityId: `act_${scenario.fixtureId}_subagent_${index}`,
    queryId: scenario.root.queryId,
    sessionId: scenario.root.sessionId,
    repositoryKey: scenario.repositoryKey,
    childSessionId: child.sessionId,
    provider: scenario.provider,
    runtime: scenario.runtime,
    kind: "subagent",
    name: scenario.subagent.name,
    outcome: scenario.subagent.outcome,
    startedAt: child.startedAt,
    endedAt: child.endedAt
  }));
  const childTools = scenario.children.flatMap((child, childIndex) => child.tools.flatMap((group) =>
    Array.from({ length: group.count }, (_, index): SafeActivityAtomV1 => ({
      schemaVersion: 1,
      activityId: `act_${scenario.fixtureId}_child_${childIndex}_${safeId(group.name)}_${index}`,
      queryId: child.queryId,
      sessionId: child.sessionId,
      repositoryKey: scenario.repositoryKey,
      provider: scenario.provider,
      runtime: scenario.runtime,
      kind: "tool",
      name: group.name,
      outcome: group.outcome,
      startedAt: child.startedAt,
      endedAt: child.endedAt
    }))));
  const internalActivity: SafeActivityAtomV1 = {
    schemaVersion: 1,
    activityId: `act_${scenario.fixtureId}_internal_title`,
    queryId: scenario.internalSession.queryId,
    sessionId: scenario.internalSession.sessionId,
    provider: scenario.provider,
    runtime: scenario.runtime,
    kind: "tool",
    name: "internal_title_generation",
    outcome: "success",
    startedAt: scenario.internalSession.startedAt,
    endedAt: scenario.internalSession.endedAt
  };
  return [...rootActivities, ...subagents, ...childTools, internalActivity];
}

export function sumComplexRunTokens(vectors: readonly ComplexRunTokenVector[]): ComplexRunTokenVector {
  return vectors.reduce((sum, vector) => tokenVector(
    sum.inputTokens + vector.inputTokens,
    sum.outputTokens + vector.outputTokens,
    sum.cacheReadInputTokens + vector.cacheReadInputTokens,
    sum.cacheCreationInputTokens + vector.cacheCreationInputTokens,
    sum.reasoningOutputTokens + vector.reasoningOutputTokens
  ), tokenVector(0, 0, 0, 0, 0));
}

function participantUsageAtoms(
  scenario: ComplexChildAgentScenario,
  participant: ComplexRunParticipant,
  visibility: "customer" | "internal" = "customer"
): SafeUsageAtomV1[] {
  const slices = splitTokenVector(participant.tokens);
  const stem = `${scenario.fixtureId}_${participant.queryId}`;
  const common = {
    schemaVersion: 1 as const,
    correlationId: participant.queryId,
    queryId: participant.queryId,
    sessionId: participant.sessionId,
    ...(visibility === "customer" ? { repositoryKey: scenario.repositoryKey } : {}),
    provider: scenario.provider,
    runtime: scenario.runtime,
    billingContext: "subscription" as const,
    model: scenario.model,
    modelProvider: "openai" as const,
    modelProviderBasis: "telemetry_reported" as const,
    startedAt: participant.startedAt
  };
  return slices.map((slice, index): SafeUsageAtomV1 => ({
    ...common,
    atomId: `atom_${stem}_response_${index + 1}`,
    requestId: `req_${stem}_response_${index + 1}`,
    signal: "logs",
    sourceId: "otlp_codex_logs",
    profileVersion: "codex-otel-logs-v1",
    authority: "request",
    ...usageTokenFields(slice),
    endedAt: new Date(Date.parse(participant.startedAt) + ((index + 1) * 100)).toISOString()
  })).concat({
    ...common,
    atomId: `atom_${stem}_turn`,
    requestId: `req_${stem}_turn`,
    signal: "traces",
    sourceId: "otlp_codex_traces",
    profileVersion: "codex-otel-traces-v1",
    authority: "turn",
    completionMode: "explicit",
    ...usageTokenFields(participant.tokens),
    endedAt: participant.endedAt
  });
}

function splitTokenVector(tokens: ComplexRunTokenVector): [ComplexRunTokenVector, ComplexRunTokenVector] {
  const first = tokenVector(
    Math.floor(tokens.inputTokens / 2),
    Math.floor(tokens.outputTokens / 2),
    Math.floor(tokens.cacheReadInputTokens / 2),
    Math.floor(tokens.cacheCreationInputTokens / 2),
    Math.floor(tokens.reasoningOutputTokens / 2)
  );
  return [first, tokenVector(
    tokens.inputTokens - first.inputTokens,
    tokens.outputTokens - first.outputTokens,
    tokens.cacheReadInputTokens - first.cacheReadInputTokens,
    tokens.cacheCreationInputTokens - first.cacheCreationInputTokens,
    tokens.reasoningOutputTokens - first.reasoningOutputTokens
  )];
}

function usageTokenFields(tokens: ComplexRunTokenVector): Pick<
  SafeUsageAtomV1,
  "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "reasoningOutputTokens"
> {
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadInputTokens: tokens.cacheReadInputTokens,
    cacheCreationInputTokens: tokens.cacheCreationInputTokens,
    reasoningOutputTokens: tokens.reasoningOutputTokens
  };
}

function tokenVector(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
  reasoningOutputTokens: number
): ComplexRunTokenVector {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens
  };
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}
