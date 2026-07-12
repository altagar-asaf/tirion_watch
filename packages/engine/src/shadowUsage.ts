import type {
  SafeActivityAtomV1,
  SafeObservationV1,
  SafeUsageAtomV1,
  SafeUsageAuthority,
  QueryOccurrenceV1,
  ProductionRunV1,
  ProductionTotalsV1,
  RunBreakdownV1,
  RunContextFootprintV1,
  ShadowComparisonV1,
  ShadowRunV1,
  ShadowTotalsV1
} from "@tirion/agent-contract";
import { createHash } from "node:crypto";
import { resolveModelProvider } from "./modelProviderResolution";

export const INACTIVITY_COMPLETION_MS = 30 * 1000;

type Rate = {
  context: ShadowRunV1["billingContext"];
  version: string;
  pattern: RegExp;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoningOutput?: number;
  minInputTokens?: number;
  maxInputTokens?: number;
  effectiveFrom?: string;
  effectiveUntil?: string;
};

type PriceProjection = {
  complete: boolean;
  estimatedNanoUsd: number;
  pricingVersion?: string;
  costEstimateBasis: ShadowRunV1["costEstimateBasis"];
};

const COPILOT_PRICING_VERSION = "copilot-pricing-2026-07-01";
const OPENAI_PRICING_VERSION = "openai-pricing-2026-07-01-standard";
const ANTHROPIC_PRICING_VERSION = "anthropic-pricing-2026-07-01-first-party";
const CURSOR_PRICING_VERSION = "cursor-pricing-2026-07-03";

const RATES: Rate[] = [
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.5$/, maxInputTokens: 272_000, input: 5, cacheRead: 0.5, output: 30 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.5$/, minInputTokens: 272_001, input: 10, cacheRead: 1, output: 45 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.5-pro$/, maxInputTokens: 272_000, input: 30, output: 180 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.5-pro$/, minInputTokens: 272_001, input: 60, output: 270 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.4$/, maxInputTokens: 272_000, input: 2.5, cacheRead: 0.25, output: 15 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.4$/, minInputTokens: 272_001, input: 5, cacheRead: 0.5, output: 22.5 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.4-mini$/, input: 0.75, cacheRead: 0.075, output: 4.5 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.4-nano$/, input: 0.2, cacheRead: 0.02, output: 1.25 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.4-pro$/, maxInputTokens: 272_000, input: 30, output: 180 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.4-pro$/, minInputTokens: 272_001, input: 60, output: 270 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^chat-latest$/, input: 5, cacheRead: 0.5, output: 30 },
  { context: "openai-direct", version: OPENAI_PRICING_VERSION, pattern: /^gpt-5\.3-codex$/, input: 1.75, cacheRead: 0.175, output: 14 },
  { context: "anthropic-direct", version: ANTHROPIC_PRICING_VERSION, pattern: /^claude-fable-5$/, input: 10, cacheRead: 1, output: 50 },
  { context: "anthropic-direct", version: ANTHROPIC_PRICING_VERSION, pattern: /^claude-mythos-5$/, input: 10, cacheRead: 1, output: 50 },
  { context: "anthropic-direct", version: ANTHROPIC_PRICING_VERSION, pattern: /^claude-opus-4(?:\.8|-8|\.7|-7|\.6|-6|\.5|-5)$/, input: 5, cacheRead: 0.5, output: 25 },
  { context: "anthropic-direct", version: ANTHROPIC_PRICING_VERSION, pattern: /^claude-opus-4(?:\.1|-1)$/, input: 15, cacheRead: 1.5, output: 75 },
  { context: "anthropic-direct", version: ANTHROPIC_PRICING_VERSION, pattern: /^claude-sonnet-5$/, input: 3, cacheRead: 0.3, output: 15, effectiveFrom: "2026-09-01" },
  { context: "anthropic-direct", version: ANTHROPIC_PRICING_VERSION, pattern: /^claude-sonnet-5$/, input: 2, cacheRead: 0.2, output: 10, effectiveFrom: "2026-07-01", effectiveUntil: "2026-09-01" },
  { context: "anthropic-direct", version: ANTHROPIC_PRICING_VERSION, pattern: /^claude-sonnet-4(?:\.5|-5|\.6|-6)?$/, input: 3, cacheRead: 0.3, output: 15 },
  { context: "anthropic-direct", version: ANTHROPIC_PRICING_VERSION, pattern: /^claude-haiku-4(?:\.5|-5)?(?:-\d{8})?$/, input: 1, cacheRead: 0.1, output: 5 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gpt[- ]5[- ]mini$/i, input: 0.25, cacheRead: 0.025, output: 2 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gpt[- ]5\.3[- ]codex$/i, input: 1.75, cacheRead: 0.175, output: 14 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gpt[- ]5\.4$/i, maxInputTokens: 272_000, input: 2.5, cacheRead: 0.25, output: 15 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gpt[- ]5\.4$/i, minInputTokens: 272_001, input: 5, cacheRead: 0.5, output: 22.5 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gpt[- ]5\.4[- ]mini$/i, input: 0.75, cacheRead: 0.075, output: 4.5 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gpt[- ]5\.4[- ]nano$/i, input: 0.2, cacheRead: 0.02, output: 1.25 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gpt[- ]5\.5$/i, maxInputTokens: 272_000, input: 5, cacheRead: 0.5, output: 30 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gpt[- ]5\.5$/i, minInputTokens: 272_001, input: 10, cacheRead: 1, output: 45 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^claude[- ]haiku[- ]4(?:\.5|-5)$/i, input: 1, cacheRead: 0.1, cacheCreation: 1.25, output: 5 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^claude[- ]sonnet[- ]4$/i, input: 3, cacheRead: 0.3, cacheCreation: 3.75, output: 15 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^claude[- ]sonnet[- ]4(?:\.5|-5)$/i, input: 3, cacheRead: 0.3, cacheCreation: 3.75, output: 15 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^claude[- ]sonnet[- ]4(?:\.6|-6)$/i, input: 3, cacheRead: 0.3, cacheCreation: 3.75, output: 15 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^claude[- ]opus[- ]4(?:\.5|-5|\.6|-6|\.7|-7|\.8|-8)$/i, input: 5, cacheRead: 0.5, cacheCreation: 6.25, output: 25 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^claude[- ]sonnet[- ]5$/i, input: 2, cacheRead: 0.2, cacheCreation: 2.5, output: 10 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^claude[- ]opus[- ]4(?:\.8|-8)(?:[- ]\(?fast(?:[- ]mode)?\)?)$/i, input: 10, cacheRead: 1, cacheCreation: 12.5, output: 50 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^claude[- ]fable[- ]5$/i, input: 10, cacheRead: 1, cacheCreation: 12.5, output: 50 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gemini[- ]2\.5[- ]pro$/i, input: 1.25, cacheRead: 0.125, output: 10 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gemini[- ]3[- ]flash$/i, input: 0.5, cacheRead: 0.05, output: 3 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gemini[- ]3\.1[- ]pro$/i, maxInputTokens: 200_000, input: 2, cacheRead: 0.2, output: 12 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gemini[- ]3\.1[- ]pro$/i, minInputTokens: 200_001, input: 4, cacheRead: 0.4, output: 18 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^gemini[- ]3\.5[- ]flash$/i, input: 1.5, cacheRead: 0.15, output: 9 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^raptor[- ]mini$/i, input: 0.25, cacheRead: 0.025, output: 2 },
  { context: "github-copilot", version: COPILOT_PRICING_VERSION, pattern: /^mai[- ]code[- ]1[- ]flash$/i, input: 0.75, cacheRead: 0.075, output: 4.5 },
  { context: "cursor", version: CURSOR_PRICING_VERSION, pattern: /^(?:cursor[- ./:])?auto$/i, input: 1.25, cacheRead: 0.25, cacheCreation: 1.25, output: 6 },
  { context: "cursor", version: CURSOR_PRICING_VERSION, pattern: /^(?:cursor[- ./:])?composer[- ]1$/i, input: 1.25, cacheRead: 0.125, cacheCreation: 1.25, output: 10 },
  { context: "cursor", version: CURSOR_PRICING_VERSION, pattern: /^(?:cursor[- ./:])?composer[- ]1\.5$/i, input: 3.5, cacheRead: 0.35, cacheCreation: 3.5, output: 17.5 },
  { context: "cursor", version: CURSOR_PRICING_VERSION, pattern: /^(?:cursor[- ./:])?composer[- ]2$/i, input: 0.5, cacheRead: 0.2, cacheCreation: 0.5, output: 2.5 },
  { context: "cursor", version: CURSOR_PRICING_VERSION, pattern: /^(?:cursor[- ./:])?composer[- ]2[- ]fast$/i, input: 1.5, cacheRead: 0.35, cacheCreation: 1.5, output: 7.5 },
  { context: "cursor", version: CURSOR_PRICING_VERSION, pattern: /^(?:cursor[- ./:])?composer[- ]2\.5$/i, input: 0.5, cacheRead: 0.2, cacheCreation: 0.5, output: 2.5 },
  { context: "cursor", version: CURSOR_PRICING_VERSION, pattern: /^(?:cursor[- ./:])?composer[- ]2\.5[- ]fast$/i, input: 3, cacheRead: 0.5, cacheCreation: 3, output: 15 }
];

export class DefaultShadowUsagePipeline {
  project(
    atoms: SafeUsageAtomV1[],
    now = new Date(),
    occurrences: QueryOccurrenceV1[] = [],
    activities: SafeActivityAtomV1[] = []
  ): ShadowRunV1[] {
    const internalQueryIds = new Set(occurrences
      .filter((occurrence) => occurrence.lifecycleVisibility === "internal")
      .map((occurrence) => occurrence.queryId));
    const visibleAtoms = atoms.filter((atom) => !internalQueryIds.has(atom.queryId ?? atom.correlationId));
    const visibleActivities = activities.filter((activity) => !internalQueryIds.has(activity.queryId));
    const deduped = [...new Map(visibleAtoms.map((atom) => [atom.atomId, atom])).values()];
    const groups = new Map<string, SafeUsageAtomV1[]>();
    const contextGroups = new Map<string, SafeUsageAtomV1[]>();
    for (const atom of visibleAtoms) {
      const queryId = atom.queryId ?? atom.correlationId;
      contextGroups.set(queryId, [...(contextGroups.get(queryId) ?? []), atom]);
    }
    for (const atom of deduped) {
      const queryId = atom.queryId ?? atom.correlationId;
      groups.set(queryId, [...(groups.get(queryId) ?? []), atom]);
    }
    const occurrenceByQuery = new Map(occurrences.map((occurrence) => [occurrence.queryId, occurrence]));
    const preferredActivityAtoms = preferredSafeActivities(visibleActivities);
    const activitiesByQuery = new Map<string, SafeActivityAtomV1[]>();
    for (const activity of preferredActivityAtoms) {
      activitiesByQuery.set(activity.queryId, [...(activitiesByQuery.get(activity.queryId) ?? []), activity]);
    }
    const projected = [...groups.entries()].map(([queryId, group]) =>
      projectGroup(
        queryId,
        group,
        now,
        occurrenceByQuery.get(queryId),
        activitiesByQuery.get(queryId) ?? [],
        contextGroups.get(queryId) ?? group
      ));
    return aggregateLinkedSubagentRuns(projected, preferredActivityAtoms)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  totals(runs: ShadowRunV1[]): ShadowTotalsV1 {
    return {
      schemaVersion: 1,
      shadow: true,
      runCount: runs.length,
      inputTokens: sum(runs, "inputTokens"),
      outputTokens: sum(runs, "outputTokens"),
      cacheReadInputTokens: sum(runs, "cacheReadInputTokens"),
      cacheCreationInputTokens: sum(runs, "cacheCreationInputTokens"),
      reasoningOutputTokens: sum(runs, "reasoningOutputTokens"),
      totalTokens: sum(runs, "totalTokens"),
      estimatedNanoUsd: runs.reduce((total, run) => total + (run.estimatedNanoUsd ?? 0), 0),
      usageValueNanoUsd: runs.reduce((total, run) => total + (run.usageValueNanoUsd ?? 0), 0),
      pricedRunCount: runs.filter((run) => run.estimatedNanoUsd != null).length,
      unpricedRunCount: runs.filter((run) => run.estimatedNanoUsd == null).length
    };
  }

  compare(expected: ShadowComparisonV1["expected"], actual: ShadowTotalsV1): ShadowComparisonV1 {
    const reasonCodes: ShadowComparisonV1["reasonCodes"] = [];
    if (expected.runCount !== actual.runCount) reasonCodes.push("run_count_mismatch");
    if (expected.inputTokens !== actual.inputTokens) reasonCodes.push("input_tokens_mismatch");
    if (expected.outputTokens !== actual.outputTokens) reasonCodes.push("output_tokens_mismatch");
    if (expected.totalTokens !== actual.totalTokens) reasonCodes.push("total_tokens_mismatch");
    if (expected.estimatedNanoUsd !== actual.estimatedNanoUsd) reasonCodes.push("estimated_cost_mismatch");
    return {
      schemaVersion: 1,
      shadow: true,
      expected,
      actual: {
        runCount: actual.runCount,
        inputTokens: actual.inputTokens,
        outputTokens: actual.outputTokens,
        totalTokens: actual.totalTokens,
        estimatedNanoUsd: actual.estimatedNanoUsd
      },
      matches: reasonCodes.length === 0,
      reasonCodes
    };
  }
}

type LinkedSubagentRun = {
  parentQueryId: string;
  childQueryId: string;
  activity: SafeActivityAtomV1;
};

function aggregateLinkedSubagentRuns(runs: ShadowRunV1[], activities: SafeActivityAtomV1[]): ShadowRunV1[] {
  const runsByQuery = new Map(runs.map((run) => [run.queryId ?? run.correlationId, run]));
  const runsBySession = new Map<string, ShadowRunV1[]>();
  for (const run of runs) {
    if (run.sessionId) {
      runsBySession.set(run.sessionId, [...(runsBySession.get(run.sessionId) ?? []), run]);
    }
  }
  const completedActivities = preferredSafeActivities(activities);
  const candidates = completedActivities.flatMap<LinkedSubagentRun>((activity) => {
    if (activity.kind !== "subagent" || !activity.childSessionId) {
      return [];
    }
    const children = runsBySession.get(activity.childSessionId) ?? [];
    if (children.length !== 1) {
      return [];
    }
    const childQueryId = children[0].queryId ?? children[0].correlationId;
    if (childQueryId === activity.queryId) {
      return [];
    }
    const parent = runsByQuery.get(activity.queryId);
    if (!parent || (parent.repositoryKey && children[0].repositoryKey && parent.repositoryKey !== children[0].repositoryKey)) {
      return [];
    }
    return [{ parentQueryId: activity.queryId, childQueryId, activity }];
  });
  const parentsByChild = new Map<string, Set<string>>();
  for (const link of candidates) {
    const parents = parentsByChild.get(link.childQueryId) ?? new Set<string>();
    parents.add(link.parentQueryId);
    parentsByChild.set(link.childQueryId, parents);
  }
  const links = candidates.filter((link) => parentsByChild.get(link.childQueryId)?.size === 1);
  const linksByParent = new Map<string, LinkedSubagentRun[]>();
  for (const link of links) {
    linksByParent.set(link.parentQueryId, [...(linksByParent.get(link.parentQueryId) ?? []), link]);
  }
  const linkedChildren = new Set(links.map((link) => link.childQueryId));
  const merge = (run: ShadowRunV1, visiting: Set<string>): ShadowRunV1 => {
    const queryId = run.queryId ?? run.correlationId;
    if (visiting.has(queryId)) {
      return run;
    }
    const nextVisiting = new Set(visiting).add(queryId);
    const directLinks = linksByParent.get(queryId) ?? [];
    const merged = directLinks.reduce((parent, link) => {
      const child = runsByQuery.get(link.childQueryId);
      return child ? mergeLinkedSubagentRun(parent, merge(child, nextVisiting), link.activity) : parent;
    }, run);
    return finalizeLinkedSubagentBreakdown(merged, directLinks);
  };
  return runs
    .filter((run) => !linkedChildren.has(run.queryId ?? run.correlationId))
    .map((run) => merge(run, new Set()));
}

function finalizeLinkedSubagentBreakdown(
  run: ShadowRunV1,
  links: LinkedSubagentRun[]
): ShadowRunV1 {
  if (links.length === 0 || !run.breakdown) {
    return run;
  }
  const linkedCountByName = new Map<string, number>();
  for (const link of links) {
    linkedCountByName.set(link.activity.name, (linkedCountByName.get(link.activity.name) ?? 0) + 1);
  }
  return {
    ...run,
    breakdown: run.breakdown.map((row) => {
      if (
        row.kind !== "subagent"
        || row.parentBreakdownId
        || linkedCountByName.get(row.name) !== row.count
        || !hasTokenTotals(tokenTotalsFromBreakdown(row))
      ) {
        return row;
      }
      return {
        ...row,
        attributionBasis: "trace_descendant",
        coverage: "complete"
      };
    })
  };
}

export function preferredSafeActivities(activities: SafeActivityAtomV1[]): SafeActivityAtomV1[] {
  const parents = activities.map((_activity, index) => index);
  const owners = new Map<string, number>();
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parents[rightRoot] = leftRoot;
    }
  };
  for (const [index, activity] of activities.entries()) {
    const scope = `${activity.provider}|${activity.queryId}`;
    const keys = [
      `${scope}|activity|${activity.activityId}`,
      ...(activity.requestId ? [`${scope}|request|${activity.requestId}`] : []),
      ...(activity.childSessionId ? [`${scope}|child|${activity.childSessionId}`] : [])
    ];
    for (const key of keys) {
      const owner = owners.get(key);
      if (owner != null) {
        union(index, owner);
      }
      owners.set(key, index);
    }
  }
  const preferred = new Map<number, SafeActivityAtomV1>();
  for (const [index, activity] of activities.entries()) {
    const root = find(index);
    const existing = preferred.get(root);
    preferred.set(root, existing ? mergeActivityEvidence(existing, activity) : activity);
  }
  return [...preferred.values()];
}

function mergeActivityEvidence(left: SafeActivityAtomV1, right: SafeActivityAtomV1): SafeActivityAtomV1 {
  const preferred = activityPreference(right) >= activityPreference(left) ? right : left;
  const trace = [left, right].find((activity) => activity.evidenceBasis === "trace_span");
  const canonical = trace ?? preferred;
  const failed = [left, right].find((activity) => activity.outcome === "failure" || activity.outcome === "rejected");
  const outcome = failed?.outcome
    ?? ([left, right].some((activity) => activity.outcome === "success") ? "success" : "unknown");
  return {
    ...canonical,
    name: preferred.name,
    kind: preferred.kind,
    outcome,
    requestId: preferred.requestId ?? canonical.requestId,
    childSessionId: preferred.childSessionId ?? canonical.childSessionId,
    startedAt: left.startedAt < right.startedAt ? left.startedAt : right.startedAt,
    endedAt: [left.endedAt, right.endedAt].filter((value): value is string => Boolean(value)).sort().at(-1),
    durationMs: Math.max(left.durationMs ?? 0, right.durationMs ?? 0) || undefined,
    resultSizeBytes: Math.max(left.resultSizeBytes ?? 0, right.resultSizeBytes ?? 0) || undefined,
    providerReportedResultTokens: Math.max(
      left.providerReportedResultTokens ?? 0,
      right.providerReportedResultTokens ?? 0
    ) || undefined
  };
}

function activityPreference(activity: SafeActivityAtomV1): number {
  const basis = activity.evidenceBasis === "subagent_hook"
    ? 16
    : activity.evidenceBasis === "tool_hook"
      ? 12
      : activity.evidenceBasis === "trace_span"
        ? 8
        : 0;
  return basis
    + (activity.endedAt ? 4 : 0)
    + (activity.outcome === "failure" || activity.outcome === "rejected" ? 2 : activity.outcome === "success" ? 1 : 0);
}

function mergeLinkedSubagentRun(
  parent: ShadowRunV1,
  child: ShadowRunV1,
  activity: SafeActivityAtomV1
): ShadowRunV1 {
  const models = [...new Set([...(parent.models ?? (parent.model ? [parent.model] : [])), ...(child.models ?? (child.model ? [child.model] : []))])];
  const modelProviders = new Set([parent.modelProvider, child.modelProvider].filter(Boolean));
  const estimatedNanoUsd = optionalPairSum(parent.estimatedNanoUsd, child.estimatedNanoUsd);
  const usageValueNanoUsd = optionalPairSum(parent.usageValueNanoUsd, child.usageValueNanoUsd);
  return {
    ...parent,
    model: models.length === 1 ? models[0] : undefined,
    ...(models.length > 0 ? { models } : {}),
    modelProvider: modelProviders.size === 1 ? [...modelProviders][0] : "unknown",
    modelProviderBasis: modelProviders.size === 1 ? parent.modelProviderBasis : "conflict",
    inputTokens: parent.inputTokens + child.inputTokens,
    outputTokens: parent.outputTokens + child.outputTokens,
    cacheReadInputTokens: parent.cacheReadInputTokens + child.cacheReadInputTokens,
    cacheCreationInputTokens: parent.cacheCreationInputTokens + child.cacheCreationInputTokens,
    reasoningOutputTokens: parent.reasoningOutputTokens + child.reasoningOutputTokens,
    totalTokens: parent.totalTokens + child.totalTokens,
    estimatedNanoUsd,
    usageValueNanoUsd,
    costCoverage: combinedCostCoverage(parent.costCoverage, child.costCoverage),
    toolCallCount: (parent.toolCallCount ?? 0) + (child.toolCallCount ?? 0),
    breakdown: mergeSubagentBreakdown(parent, child, activity),
    startedAt: parent.startedAt < child.startedAt ? parent.startedAt : child.startedAt,
    endedAt: parent.endedAt && child.endedAt
      ? (parent.endedAt > child.endedAt ? parent.endedAt : child.endedAt)
      : undefined,
    warnings: [...new Set([...parent.warnings, ...child.warnings])]
  };
}

function mergeSubagentBreakdown(
  parent: ShadowRunV1,
  child: ShadowRunV1,
  activity: SafeActivityAtomV1
): RunBreakdownV1[] {
  const parentQueryId = parent.queryId ?? parent.correlationId;
  const rows = (parent.breakdown ?? []).map((row) => ({ ...row }));
  let subagentIndex = rows.findIndex((row) => row.kind === "subagent" && row.name === activity.name);
  if (subagentIndex < 0) {
    rows.push({
      schemaVersion: 1,
      breakdownId: breakdownId(parentQueryId, `subagent:${activity.name}`),
      kind: "subagent",
      name: activity.name,
      count: 1,
      failureCount: activity.outcome === "failure" || activity.outcome === "rejected" ? 1 : 0,
      unknownCount: activity.outcome === "unknown" ? 1 : 0,
      attributionBasis: "activity_only",
      coverage: "unavailable"
    });
    subagentIndex = rows.length - 1;
  }
  const subagent = rows[subagentIndex];
  const childTotals = tokenTotalsFromRun(child);
  const allocated = emptyTokenTotals();
  for (const childRow of child.breakdown ?? []) {
    const usage = tokenTotalsFromBreakdown(childRow);
    if (childRow.kind === "unallocated") {
      addTokenTotalsToBreakdown(subagent, usage);
      addTokenTotals(allocated, usage);
      continue;
    }
    addTokenTotals(allocated, usage);
    rows.push({
      ...childRow,
      breakdownId: breakdownId(parentQueryId, `${activity.activityId}|${childRow.breakdownId}`),
      parentBreakdownId: subagent.breakdownId
    });
  }
  const residual = subtractTokenTotals(childTotals, allocated);
  if (hasTokenTotals(residual)) {
    addTokenTotalsToBreakdown(subagent, residual);
  }
  if (hasTokenTotals(tokenTotalsFromBreakdown(subagent))) {
    subagent.attributionBasis = "unavailable";
    subagent.coverage = (child.breakdown ?? []).some((row) => row.kind !== "unallocated" && hasTokenTotals(tokenTotalsFromBreakdown(row)))
      ? "partial"
      : "unavailable";
  }
  rows[subagentIndex] = subagent;
  return rows;
}

type MutableTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

function emptyTokenTotals(): MutableTokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function tokenTotalsFromRun(run: ShadowRunV1): MutableTokenTotals {
  return {
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadInputTokens: run.cacheReadInputTokens,
    cacheCreationInputTokens: run.cacheCreationInputTokens,
    reasoningOutputTokens: run.reasoningOutputTokens,
    totalTokens: run.totalTokens
  };
}

function tokenTotalsFromBreakdown(row: RunBreakdownV1): MutableTokenTotals {
  return {
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheReadInputTokens: row.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: row.cacheCreationInputTokens ?? 0,
    reasoningOutputTokens: row.reasoningOutputTokens ?? 0,
    totalTokens: row.totalTokens ?? ((row.inputTokens ?? 0) + (row.outputTokens ?? 0))
  };
}

function addTokenTotals(target: MutableTokenTotals, value: MutableTokenTotals): void {
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.cacheReadInputTokens += value.cacheReadInputTokens;
  target.cacheCreationInputTokens += value.cacheCreationInputTokens;
  target.reasoningOutputTokens += value.reasoningOutputTokens;
  target.totalTokens = target.inputTokens + target.outputTokens;
}

function addTokenTotalsToBreakdown(target: RunBreakdownV1, value: MutableTokenTotals): void {
  target.inputTokens = (target.inputTokens ?? 0) + value.inputTokens;
  target.outputTokens = (target.outputTokens ?? 0) + value.outputTokens;
  target.cacheReadInputTokens = (target.cacheReadInputTokens ?? 0) + value.cacheReadInputTokens;
  target.cacheCreationInputTokens = (target.cacheCreationInputTokens ?? 0) + value.cacheCreationInputTokens;
  target.reasoningOutputTokens = (target.reasoningOutputTokens ?? 0) + value.reasoningOutputTokens;
  target.totalTokens = (target.inputTokens ?? 0) + (target.outputTokens ?? 0);
}

function subtractTokenTotals(total: MutableTokenTotals, allocated: MutableTokenTotals): MutableTokenTotals {
  return {
    inputTokens: Math.max(0, total.inputTokens - allocated.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - allocated.outputTokens),
    cacheReadInputTokens: Math.max(0, total.cacheReadInputTokens - allocated.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(0, total.cacheCreationInputTokens - allocated.cacheCreationInputTokens),
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - allocated.reasoningOutputTokens),
    totalTokens: Math.max(0, total.inputTokens - allocated.inputTokens) + Math.max(0, total.outputTokens - allocated.outputTokens)
  };
}

function hasTokenTotals(value: MutableTokenTotals): boolean {
  return value.inputTokens > 0
    || value.outputTokens > 0
    || value.cacheReadInputTokens > 0
    || value.cacheCreationInputTokens > 0
    || value.reasoningOutputTokens > 0;
}

function optionalPairSum(left?: number, right?: number): number | undefined {
  return left == null && right == null ? undefined : (left ?? 0) + (right ?? 0);
}

function combinedCostCoverage(left: ShadowRunV1["costCoverage"], right: ShadowRunV1["costCoverage"]): ShadowRunV1["costCoverage"] {
  if (left === "complete" && right === "complete") return "complete";
  if (left === "unavailable" && right === "unavailable") return "unavailable";
  return "partial";
}

export class DefaultProductionUsagePipeline {
  private readonly shadowPolicy = new DefaultShadowUsagePipeline();

  project(
    atoms: SafeUsageAtomV1[],
    now = new Date(),
    occurrences: QueryOccurrenceV1[] = [],
    activities: SafeActivityAtomV1[] = []
  ): ProductionRunV1[] {
    return this.shadowPolicy.project(atoms, now, occurrences, activities).map(({ shadow: _shadow, ...run }) => ({
      ...run,
      production: true,
      runId: `run_${(run.queryId ?? run.correlationId).slice(4)}`
    }));
  }

  totals(runs: ProductionRunV1[]): ProductionTotalsV1 {
    const shadowRuns: ShadowRunV1[] = runs.map(({ production: _production, ...run }) => ({ ...run, shadow: true }));
    const { shadow: _shadow, ...totals } = this.shadowPolicy.totals(shadowRuns);
    return { ...totals, production: true };
  }
}

function projectGroup(
  queryId: string,
  atoms: SafeUsageAtomV1[],
  now: Date,
  occurrence: QueryOccurrenceV1 | undefined,
  activities: SafeActivityAtomV1[],
  contextAtoms: SafeUsageAtomV1[]
): ShadowRunV1 {
  const provider = atoms[0].provider;
  const priority = authorityPriority(provider);
  const accountingAtoms = atoms.filter((atom) => atom.kind !== "lifecycle");
  const authorityCandidates = accountingAtoms.length > 0 ? accountingAtoms : atoms;
  const selectedAuthority = [...authorityCandidates]
    .sort((a, b) => priority.indexOf(a.authority) - priority.indexOf(b.authority))[0].authority;
  const selectedCandidates = accountingAtoms.filter((atom) => atom.authority === selectedAuthority);
  const selected = enrichProviderUsageSurface(
    provider,
    selectedAuthority,
    preferProviderUsageSurface(provider, selectedCandidates),
    accountingAtoms
  );
  const models = [...new Set(selected.flatMap((atom) => atom.model ? [atom.model] : []))];
  const model = models.length === 1 ? models[0] : undefined;
  const modelProviderResolutions = selected.map((atom) => atom.modelProvider
    ? {
        modelProvider: atom.modelProvider,
        modelProviderBasis: atom.modelProviderBasis ?? "unknown",
        modelProviderClassificationVersion: atom.modelProviderClassificationVersion ?? "unknown"
      }
    : resolveModelProvider({ model: atom.model }));
  if (modelProviderResolutions.length === 0) {
    modelProviderResolutions.push(resolveModelProvider({}));
  }
  const modelProviders = [...new Set(modelProviderResolutions.map((item) => item.modelProvider))];
  const modelProvider = modelProviders.length === 1 ? modelProviders[0] : "unknown";
  const matchingResolution = modelProviderResolutions.find((item) => item.modelProvider === modelProvider);
  const inputTokens = tokenSum(selected, "inputTokens");
  const outputTokens = tokenSum(selected, "outputTokens");
  const cacheReadInputTokens = tokenSum(selected, "cacheReadInputTokens");
  const cacheCreationInputTokens = tokenSum(selected, "cacheCreationInputTokens");
  const reasoningOutputTokens = tokenSum(selected, "reasoningOutputTokens");
  const resolvedBillingContext = billingContext(selected);
  const price = priceAtoms(selected, resolvedBillingContext);
  const usageValue = usageValueAtoms(selected, price);
  const warnings: ShadowRunV1["warnings"] = [];
  if (accountingAtoms.length > selected.length) warnings.push("lower_authority_overlap_discarded");
  if (accountingAtoms.length === 0) warnings.push("no_usage_atoms");
  if (!model) warnings.push("model_unavailable");
  if (resolvedBillingContext === "unknown") warnings.push("billing_context_unavailable");
  if (resolvedBillingContext === "subscription") warnings.push("subscription_usage_only");
  if (price.costEstimateBasis === "provider_reported_estimate") warnings.push("provider_reported_estimate");
  if (!price.complete && resolvedBillingContext !== "unknown" && resolvedBillingContext !== "subscription") {
    warnings.push("pricing_unavailable");
  }
  const startedAt = [occurrence?.startedAt, ...atoms.map((atom) => atom.startedAt)]
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const sessionIds = [...new Set(atoms.flatMap((atom) => atom.sessionId ? [atom.sessionId] : []))];
  const sessionId = occurrence?.sessionId ?? (sessionIds.length === 1 ? sessionIds[0] : queryId);
  if (sessionIds.length !== 1 && atoms.some((atom) => atom.queryId)) warnings.push("session_identity_unavailable");
  const endedAt = completedAt(
    accountingAtoms.length > 0 ? accountingAtoms : atoms,
    now,
    accountingAtoms.length > 0,
    occurrence
  );
  const breakdown = runBreakdown(queryId, provider, atoms, activities, {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens
  });
  const context = contextFootprintFromUsageAtoms(selected, {
    accumulatedInputTokens: inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    coverage: endedAt ? "final" : "complete_so_far"
  }, contextUsageSurface(provider, selectedAuthority, selected, accountingAtoms, contextAtoms));
  return {
    schemaVersion: 1,
    shadow: true,
    runId: `shadow_${queryId.slice(4)}`,
    correlationId: queryId,
    queryId,
    sessionId,
    ...(occurrence?.repositoryKey ? { repositoryKey: occurrence.repositoryKey } : {}),
    promptState: occurrence?.promptState ?? "unavailable",
    promptText: occurrence?.promptText,
    provider,
    runtime: atoms[0].runtime,
    model,
    ...(models.length ? { models } : {}),
    modelProvider,
    modelProviderBasis: matchingResolution?.modelProviderBasis ?? "conflict",
    modelProviderClassificationVersion: matchingResolution?.modelProviderClassificationVersion ?? "unknown",
    authority: selectedAuthority,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedNanoUsd: price.complete || price.estimatedNanoUsd > 0 ? price.estimatedNanoUsd : undefined,
    usageValueNanoUsd: usageValue.complete ? usageValue.estimatedNanoUsd : undefined,
    costEstimateBasis: price.costEstimateBasis,
    pricingVersion: price.complete || price.estimatedNanoUsd > 0 ? price.pricingVersion : undefined,
    billingContext: resolvedBillingContext,
    costCoverage: price.complete ? "complete" : price.estimatedNanoUsd > 0 ? "partial" : "unavailable",
    evidenceGrade: "estimated_usage_cost_unattributed",
    toolCallCount: activities.length,
    breakdown,
    ...(context ? { context } : {}),
    startedAt,
    endedAt,
    warnings: [...new Set(warnings)]
  };
}

function runBreakdown(
  queryId: string,
  provider: SafeObservationV1["provider"],
  atoms: SafeUsageAtomV1[],
  activities: SafeActivityAtomV1[],
  totals: Pick<ShadowRunV1, "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "reasoningOutputTokens" | "totalTokens">
): RunBreakdownV1[] {
  const dedupedActivities = [...new Map(activities.map((activity) => [activity.activityId, activity])).values()];
  const byGroup = new Map<string, SafeActivityAtomV1[]>();
  for (const activity of dedupedActivities) {
    const key = `${activity.kind}:${activity.name}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), activity]);
  }
  const breakdown: RunBreakdownV1[] = [];
  let allocatedInput = 0;
  let allocatedOutput = 0;
  let allocatedCacheRead = 0;
  let allocatedCacheCreation = 0;
  let allocatedReasoning = 0;
  for (const [key, group] of byGroup) {
    const activityIds = new Set(group.map((activity) => activity.activityId));
    const candidates = atoms.filter((atom) => atom.owningActivityId && activityIds.has(atom.owningActivityId));
    const priority = authorityPriority(provider);
    const selectedAuthority = candidates.length > 0
      ? [...candidates].sort((a, b) => priority.indexOf(a.authority) - priority.indexOf(b.authority))[0].authority
      : undefined;
    const selected = selectedAuthority
      ? preferProviderUsageSurface(provider, candidates.filter((atom) => atom.authority === selectedAuthority))
      : [];
    const inputTokens = tokenSum(selected, "inputTokens");
    const outputTokens = tokenSum(selected, "outputTokens");
    const cacheReadInputTokens = tokenSum(selected, "cacheReadInputTokens");
    const cacheCreationInputTokens = tokenSum(selected, "cacheCreationInputTokens");
    const reasoningOutputTokens = tokenSum(selected, "reasoningOutputTokens");
    const totalTokens = inputTokens + outputTokens;
    const conserves = allocatedInput + inputTokens <= totals.inputTokens
      && allocatedOutput + outputTokens <= totals.outputTokens
      && allocatedCacheRead + cacheReadInputTokens <= totals.cacheReadInputTokens
      && allocatedCacheCreation + cacheCreationInputTokens <= totals.cacheCreationInputTokens
      && allocatedReasoning + reasoningOutputTokens <= totals.reasoningOutputTokens;
    const hasAttributedUsage = selected.length > 0 && conserves;
    if (hasAttributedUsage) {
      allocatedInput += inputTokens;
      allocatedOutput += outputTokens;
      allocatedCacheRead += cacheReadInputTokens;
      allocatedCacheCreation += cacheCreationInputTokens;
      allocatedReasoning += reasoningOutputTokens;
    }
    breakdown.push({
      schemaVersion: 1,
      breakdownId: breakdownId(queryId, key),
      kind: group[0].kind,
      name: group[0].name,
      count: group.length,
      failureCount: group.filter((activity) => activity.outcome === "failure" || activity.outcome === "rejected").length,
      unknownCount: group.filter((activity) => activity.outcome === "unknown").length,
      totalDurationMs: optionalSum(group.map((activity) => activity.durationMs)),
      resultSizeBytes: optionalSum(group.map((activity) => activity.resultSizeBytes)),
      providerReportedResultTokens: optionalSum(group.map((activity) => activity.providerReportedResultTokens)),
      sensitiveAuditEvidence: group.flatMap((activity) => activity.sensitiveAuditEvidence ?? []),
      ...(hasAttributedUsage ? {
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        reasoningOutputTokens,
        totalTokens
      } : {}),
      attributionBasis: hasAttributedUsage ? "trace_descendant" : "activity_only",
      coverage: hasAttributedUsage ? "complete" : "unavailable"
    });
  }
  const unallocated = {
    inputTokens: Math.max(0, totals.inputTokens - allocatedInput),
    outputTokens: Math.max(0, totals.outputTokens - allocatedOutput),
    cacheReadInputTokens: Math.max(0, totals.cacheReadInputTokens - allocatedCacheRead),
    cacheCreationInputTokens: Math.max(0, totals.cacheCreationInputTokens - allocatedCacheCreation),
    reasoningOutputTokens: Math.max(0, totals.reasoningOutputTokens - allocatedReasoning)
  };
  const unallocatedTotal = unallocated.inputTokens + unallocated.outputTokens;
  if (unallocatedTotal > 0 || unallocated.cacheReadInputTokens > 0 || unallocated.cacheCreationInputTokens > 0 || unallocated.reasoningOutputTokens > 0) {
    breakdown.push({
      schemaVersion: 1,
      breakdownId: breakdownId(queryId, "unallocated"),
      kind: "unallocated",
      name: "Unallocated run usage",
      count: 1,
      failureCount: 0,
      ...unallocated,
      totalTokens: unallocatedTotal,
      attributionBasis: "unavailable",
      coverage: activities.length > 0 ? "partial" : "unavailable"
    });
  }
  return breakdown.sort((a, b) => a.kind === "unallocated" ? 1 : b.kind === "unallocated" ? -1 : b.count - a.count || a.name.localeCompare(b.name));
}

function optionalSum(values: (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value != null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function breakdownId(queryId: string, key: string): string {
  return `brk_${createHash("sha256").update(`${queryId}|${key}`).digest("hex")}`;
}

function priceAtoms(atoms: SafeUsageAtomV1[], context: ShadowRunV1["billingContext"]): PriceProjection {
  if (atoms.length === 0) {
    return { complete: false, estimatedNanoUsd: 0, costEstimateBasis: "unavailable" };
  }
  const reported = atoms.map((atom) => atom.providerReportedNanoUsd);
  if (reported.some((value) => value != null)) {
    return {
      complete: reported.every((value) => value != null),
      estimatedNanoUsd: reported.reduce<number>((total, value) => total + (value ?? 0), 0),
      pricingVersion: "provider-reported-v1",
      costEstimateBasis: "provider_reported_estimate"
    };
  }
  let complete = true;
  let estimatedNanoUsd = 0;
  const versions = new Set<string>();
  for (const atom of atoms) {
    const rate = rateForAtom(context, atom);
    if (!rate) {
      complete = false;
      continue;
    }
    versions.add(rate.version);
    const priced = priceAtomWithRate(atom, rate);
    if (!priced.complete) complete = false;
    estimatedNanoUsd += priced.estimatedNanoUsd;
  }
  return {
    complete,
    estimatedNanoUsd,
    pricingVersion: versions.size === 1 ? [...versions][0] : undefined,
    costEstimateBasis: versions.size > 0 ? "catalog_estimate" : "unavailable"
  };
}

function usageValueAtoms(atoms: SafeUsageAtomV1[], price?: PriceProjection): {
  complete: boolean;
  estimatedNanoUsd: number;
} {
  if (atoms.length === 0) {
    return { complete: false, estimatedNanoUsd: 0 };
  }
  if (price?.complete && price.costEstimateBasis === "provider_reported_estimate") {
    return { complete: true, estimatedNanoUsd: price.estimatedNanoUsd };
  }
  let complete = true;
  let estimatedNanoUsd = 0;
  for (const atom of atoms) {
    const rate = usageValueRate(atom);
    if (!rate) {
      complete = false;
      continue;
    }
    const priced = priceAtomWithRate(atom, rate);
    if (!priced.complete) complete = false;
    estimatedNanoUsd += priced.estimatedNanoUsd;
  }
  return { complete, estimatedNanoUsd };
}

function usageValueRate(atom: SafeUsageAtomV1): Rate | undefined {
  if (!atom.model) {
    return undefined;
  }
  const contexts = usageValueContexts(atom);
  for (const context of contexts) {
    const rate = rateForAtom(context, atom);
    if (rate) {
      return rate;
    }
  }
  return undefined;
}

function usageValueContexts(atom: SafeUsageAtomV1): Rate["context"][] {
  if (atom.billingContext === "openai-direct" || atom.billingContext === "anthropic-direct" || atom.billingContext === "cursor") {
    return [atom.billingContext];
  }
  const modelProvider = atom.modelProvider && atom.modelProvider !== "unknown"
    ? atom.modelProvider
    : resolveModelProvider({ model: atom.model }).modelProvider;
  if (modelProvider === "openai") {
    return ["openai-direct"];
  }
  if (modelProvider === "anthropic") {
    return ["anthropic-direct"];
  }
  if (modelProvider === "cursor") {
    return ["cursor"];
  }
  return [];
}

function rateForAtom(context: Rate["context"], atom: SafeUsageAtomV1): Rate | undefined {
  if (!atom.model) {
    return undefined;
  }
  const inputTokens = atom.inputTokens ?? 0;
  const startedAtMs = Date.parse(atom.startedAt);
  return RATES.find((candidate) =>
    candidate.context === context
    && candidate.pattern.test(atom.model!)
    && (candidate.minInputTokens == null || inputTokens >= candidate.minInputTokens)
    && (candidate.maxInputTokens == null || inputTokens <= candidate.maxInputTokens)
    && rateEffectiveAt(candidate, startedAtMs)
  );
}

function rateEffectiveAt(rate: Rate, startedAtMs: number): boolean {
  if (Number.isNaN(startedAtMs)) {
    return true;
  }
  const effectiveFromMs = rate.effectiveFrom ? Date.parse(rate.effectiveFrom) : undefined;
  const effectiveUntilMs = rate.effectiveUntil ? Date.parse(rate.effectiveUntil) : undefined;
  return (effectiveFromMs == null || startedAtMs >= effectiveFromMs)
    && (effectiveUntilMs == null || startedAtMs < effectiveUntilMs);
}

function priceAtomWithRate(atom: SafeUsageAtomV1, rate: Rate): {
  complete: boolean;
  estimatedNanoUsd: number;
} {
  let complete = true;
  let estimatedNanoUsd = 0;
  const cacheRead = atom.cacheReadInputTokens ?? 0;
  const cacheCreation = atom.cacheCreationInputTokens ?? 0;
  const nonCachedInput = Math.max(0, (atom.inputTokens ?? 0) - cacheRead - cacheCreation);
  const components: [number, number | undefined][] = [
    [nonCachedInput, rate.input],
    [cacheRead, rate.cacheRead],
    [cacheCreation, rate.cacheCreation],
    [atom.outputTokens ?? 0, rate.output],
    [atom.reasoningOutputTokens ?? 0, rate.reasoningOutput ?? rate.output]
  ];
  for (const [tokens, usdPerMillion] of components) {
    if (tokens > 0 && usdPerMillion == null) {
      complete = false;
    } else {
      estimatedNanoUsd += Math.round((tokens * (usdPerMillion ?? 0) * 1_000_000_000) / 1_000_000);
    }
  }
  return { complete, estimatedNanoUsd };
}

function completedAt(
  atoms: SafeUsageAtomV1[],
  now: Date,
  hasAccounting: boolean,
  occurrence?: QueryOccurrenceV1
): string | undefined {
  if (!hasAccounting) {
    return undefined;
  }
  const closedBoundaries = atoms.filter(isClosedAuthoritativeRunBoundaryAtom);
  const latestClosedBoundary = closedBoundaries.map((atom) => atom.endedAt!).sort().at(-1);
  const allAccountingEnded = atoms.every((atom) => atom.endedAt);
  const latest = atoms.flatMap((atom) => atom.endedAt ? [atom.endedAt] : []).sort().at(-1);
  if (occurrence?.completedAt) {
    if (!allAccountingEnded || !latest) {
      return undefined;
    }
    return occurrence.completedAt > latest ? occurrence.completedAt : latest;
  }
  // Submission hooks prove that a harness lifecycle surface is active. Individual
  // model responses are revisions of that turn, not terminal evidence. A closed
  // provider-authoritative turn/run boundary is terminal even when the harness
  // omits its stop hook.
  if (occurrence?.evidence === "submission_hook") {
    return latestClosedBoundary;
  }
  if (!allAccountingEnded || !latest) {
    return undefined;
  }
  if (
    (
      atoms.some((atom) => atom.completionMode === "inactivity")
      || requiresRunLevelSettling(atoms)
    )
    && Date.parse(latest) + INACTIVITY_COMPLETION_MS > now.getTime()
  ) {
    return undefined;
  }
  return latest;
}

export function isClosedAuthoritativeRunBoundaryAtom(atom: SafeUsageAtomV1): atom is SafeUsageAtomV1 & { endedAt: string } {
  if (atom.completionMode !== "explicit" || !atom.endedAt || !isTraceUsageSurface(atom)) {
    return false;
  }
  if (atom.provider === "github-copilot") {
    return atom.authority === "run";
  }
  if (atom.provider === "codex" || atom.provider === "cursor") {
    return atom.authority === "turn";
  }
  return false;
}

function isTraceUsageSurface(atom: SafeUsageAtomV1): boolean {
  return atom.signal === "traces"
    || atom.sourceId === "otlp_codex_traces"
    || atom.sourceId === "otlp_github_copilot_traces"
    || atom.sourceId === "otlp_cursor_traces"
    || atom.profileVersion === "codex-otel-traces-v1"
    || atom.profileVersion === "copilot-otlp-traces-v1"
    || atom.profileVersion === "cursor-otel-traces-v1";
}

function requiresRunLevelSettling(atoms: SafeUsageAtomV1[]): boolean {
  return atoms.length > 0
    && atoms.every((atom) =>
      atom.provider === "codex"
      && atom.authority === "event"
      && (
        atom.signal === "traces"
        || atom.profileVersion === "codex-otel-traces-v1"
        || atom.sourceId === "otlp_codex_traces"
      )
    );
}

function authorityPriority(provider: SafeObservationV1["provider"]): SafeUsageAuthority[] {
  if (provider === "github-copilot") return ["run", "request", "turn", "model", "event"];
  if (provider === "claude-code") return ["request", "turn", "model", "event", "run"];
  return ["turn", "request", "model", "event", "run"];
}

function preferProviderUsageSurface(
  provider: SafeObservationV1["provider"],
  atoms: SafeUsageAtomV1[]
): SafeUsageAtomV1[] {
  if (provider === "github-copilot") {
    const traceAtoms = atoms.filter((atom) =>
      atom.signal === "traces"
      || atom.profileVersion === "copilot-otlp-traces-v1"
      || atom.sourceId === "otlp_github_copilot_traces"
    );
    return traceAtoms.length > 0 ? traceAtoms : atoms;
  }
  if (provider === "codex") {
    const traceAtoms = atoms.filter((atom) =>
      atom.signal === "traces"
      || atom.profileVersion === "codex-otel-traces-v1"
      || atom.sourceId === "otlp_codex_traces"
    );
    return traceAtoms.length > 0 ? traceAtoms : atoms;
  }
  if (provider !== "claude-code") {
    return atoms;
  }
  const traceAtoms = atoms.filter((atom) =>
    atom.signal === "traces"
    || atom.profileVersion === "claude-code-enhanced-traces-beta-v1"
    || atom.sourceId === "otlp_claude_code_traces"
  );
  if (traceAtoms.length === 0) {
    return atoms;
  }
  const logAtoms = atoms.filter((atom) => !traceAtoms.includes(atom));
  const logsByRequest = new Map(logAtoms.flatMap((atom) => atom.requestId ? [[atom.requestId, atom] as const] : []));
  const traceRequests = new Set(traceAtoms.flatMap((atom) => atom.requestId ? [atom.requestId] : []));
  const enrichedTraces = traceAtoms.map((atom) => {
    const fallback = atom.requestId ? logsByRequest.get(atom.requestId) : undefined;
    if (!fallback) {
      return atom;
    }
    return {
      ...fallback,
      ...atom,
      providerReportedNanoUsd: atom.providerReportedNanoUsd ?? fallback.providerReportedNanoUsd,
      startedAt: fallback.startedAt < atom.startedAt ? fallback.startedAt : atom.startedAt,
      endedAt: atom.endedAt ?? fallback.endedAt
    };
  });
  const unmatchedLogs = logAtoms.filter((atom) => !atom.requestId || !traceRequests.has(atom.requestId));
  return [...enrichedTraces, ...unmatchedLogs];
}

function enrichProviderUsageSurface(
  provider: SafeObservationV1["provider"],
  authority: SafeUsageAuthority,
  selected: SafeUsageAtomV1[],
  accountingAtoms: SafeUsageAtomV1[]
): SafeUsageAtomV1[] {
  if (provider !== "github-copilot" || authority !== "run" || selected.length !== 1) {
    return selected;
  }
  return enrichCopilotRunSelection(selected, accountingAtoms);
}

function enrichCopilotRunSelection(
  selected: SafeUsageAtomV1[],
  accountingAtoms: SafeUsageAtomV1[]
): SafeUsageAtomV1[] {
  const [runAtom] = selected;
  if (!runAtom) {
    return selected;
  }
  const corroborating = preferProviderUsageSurface(
    "github-copilot",
    accountingAtoms.filter((atom) => atom.authority === "model" || atom.authority === "turn")
  );
  if (corroborating.length === 0) {
    return selected;
  }
  const selectedInput = tokenSum(selected, "inputTokens");
  const selectedOutput = tokenSum(selected, "outputTokens");
  const corroboratingInput = tokenSum(corroborating, "inputTokens");
  const corroboratingOutput = tokenSum(corroborating, "outputTokens");
  if (selectedInput !== corroboratingInput || selectedOutput !== corroboratingOutput) {
    return selected;
  }
  const models = [...new Set(corroborating.flatMap((atom) => atom.model ? [atom.model] : []))];
  if (models.length > 1 || (runAtom.model && models.length === 1 && models[0] !== runAtom.model)) {
    return selected;
  }
  const reasoningOutputTokens = tokenSum(corroborating, "reasoningOutputTokens");
  const cacheReadInputTokens = tokenSum(corroborating, "cacheReadInputTokens");
  const cacheCreationInputTokens = tokenSum(corroborating, "cacheCreationInputTokens");
  const modelProviderResolutions = corroborating.flatMap((atom) =>
    atom.modelProvider ? [{
      modelProvider: atom.modelProvider,
      modelProviderBasis: atom.modelProviderBasis ?? "unknown",
      modelProviderClassificationVersion: atom.modelProviderClassificationVersion ?? "unknown"
    }] : []
  );
  const modelProviders = [...new Set(modelProviderResolutions.map((item) => item.modelProvider))];
  const modelProvider = modelProviders.length === 1 ? modelProviderResolutions.find((item) => item.modelProvider === modelProviders[0]) : undefined;
  const unresolvedModelProvider = runAtom.modelProvider == null || runAtom.modelProvider === "unknown";
  return [{
    ...runAtom,
    model: runAtom.model ?? models[0],
    modelProvider: unresolvedModelProvider ? modelProvider?.modelProvider ?? runAtom.modelProvider : runAtom.modelProvider,
    modelProviderBasis: unresolvedModelProvider ? modelProvider?.modelProviderBasis ?? runAtom.modelProviderBasis : runAtom.modelProviderBasis,
    modelProviderClassificationVersion: unresolvedModelProvider
      ? modelProvider?.modelProviderClassificationVersion ?? runAtom.modelProviderClassificationVersion
      : runAtom.modelProviderClassificationVersion,
    cacheReadInputTokens: (runAtom.cacheReadInputTokens ?? 0) > 0 ? runAtom.cacheReadInputTokens : cacheReadInputTokens || runAtom.cacheReadInputTokens,
    cacheCreationInputTokens: (runAtom.cacheCreationInputTokens ?? 0) > 0 ? runAtom.cacheCreationInputTokens : cacheCreationInputTokens || runAtom.cacheCreationInputTokens,
    reasoningOutputTokens: (runAtom.reasoningOutputTokens ?? 0) > 0 ? runAtom.reasoningOutputTokens : reasoningOutputTokens || runAtom.reasoningOutputTokens
  }];
}

function billingContext(atoms: SafeUsageAtomV1[]): ShadowRunV1["billingContext"] {
  const contexts = new Set(atoms.map((atom) =>
    atom.billingContext ?? (atom.provider === "github-copilot" ? "github-copilot" : "unknown")));
  return contexts.size === 1 ? [...contexts][0] : "unknown";
}

function tokenSum(atoms: SafeUsageAtomV1[], key: keyof SafeUsageAtomV1): number {
  return atoms.reduce((total, atom) => total + (typeof atom[key] === "number" ? atom[key] as number : 0), 0);
}

function contextFootprintFromUsageAtoms(
  atoms: SafeUsageAtomV1[],
  totals: Pick<RunContextFootprintV1, "accumulatedInputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "coverage">,
  contextAtoms = atoms
): RunContextFootprintV1 | undefined {
  const requests = contextAtoms
    .filter(hasReportedInputContext)
    .sort(compareUsageAtomsForContext);
  if (requests.length === 0) {
    return undefined;
  }
  const inputFootprints = requests.map(inputContextFootprint);
  const initialInputContextTokens = inputFootprints[0];
  const latestInputContextTokens = inputFootprints.at(-1)!;
  const peakInputContextTokens = Math.max(...inputFootprints);
  const contextGrowthInputTokens = Math.max(0, peakInputContextTokens - initialInputContextTokens);
  return {
    schemaVersion: 1,
    accumulatedInputTokens: totals.accumulatedInputTokens,
    initialInputContextTokens,
    latestInputContextTokens,
    peakInputContextTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    observedLlmRequestCount: requests.length,
    contextGrowthInputTokens,
    ...(initialInputContextTokens > 0 ? { contextGrowthRatio: peakInputContextTokens / initialInputContextTokens } : {}),
    basis: "derived_from_usage_atoms",
    coverage: totals.coverage
  };
}

function compareUsageAtomsForContext(left: SafeUsageAtomV1, right: SafeUsageAtomV1): number {
  return left.startedAt.localeCompare(right.startedAt)
    || (left.endedAt ?? "").localeCompare(right.endedAt ?? "")
    || (left.requestId ?? "").localeCompare(right.requestId ?? "")
    || left.atomId.localeCompare(right.atomId)
    || inputContextFootprint(left) - inputContextFootprint(right);
}

function contextUsageSurface(
  provider: SafeObservationV1["provider"],
  authority: SafeUsageAuthority,
  selected: SafeUsageAtomV1[],
  accountingAtoms: SafeUsageAtomV1[],
  contextAtoms: SafeUsageAtomV1[]
): SafeUsageAtomV1[] {
  const rawCandidates = contextAtoms
    .filter((atom) => atom.kind !== "lifecycle")
    .filter((atom) => atom.authority === authority);
  const surface = preferProviderUsageSurface(provider, rawCandidates);
  const enriched = enrichProviderUsageSurface(provider, authority, surface, accountingAtoms);
  return dedupeContextSnapshots(enriched.length > 0 ? enriched : selected);
}

function dedupeContextSnapshots(atoms: SafeUsageAtomV1[]): SafeUsageAtomV1[] {
  const seen = new Set<string>();
  return atoms.filter((atom) => {
    const key = [
      atom.atomId,
      atom.inputTokens ?? 0,
      atom.cacheReadInputTokens ?? 0,
      atom.cacheCreationInputTokens ?? 0
    ].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function inputContextFootprint(atom: SafeUsageAtomV1): number {
  return (atom.inputTokens ?? 0)
    + (atom.cacheReadInputTokens ?? 0)
    + (atom.cacheCreationInputTokens ?? 0);
}

function hasReportedInputContext(atom: SafeUsageAtomV1): boolean {
  return isNonNegativeSafeInteger(atom.inputTokens)
    || isNonNegativeSafeInteger(atom.cacheReadInputTokens)
    || isNonNegativeSafeInteger(atom.cacheCreationInputTokens);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sum(runs: ShadowRunV1[], key: keyof ShadowRunV1): number {
  return runs.reduce((total, run) => total + (typeof run[key] === "number" ? run[key] as number : 0), 0);
}
