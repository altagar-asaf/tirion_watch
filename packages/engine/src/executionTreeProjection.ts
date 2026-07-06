import type {
  ExecutionNodeAtomV1,
  ExecutionRunSummaryV1,
  ExecutionTreeNodeV1,
  ExecutionTreeSnapshotV1,
  ProductionRunV1
} from "@tirion/agent-contract";

export class DefaultExecutionTreeProjection {
  project(runs: ProductionRunV1[], nodes: ExecutionNodeAtomV1[]): ExecutionTreeSnapshotV1[] {
    const byQuery = new Map<string, ExecutionNodeAtomV1[]>();
    for (const node of mergeExecutionNodes(nodes)) {
      byQuery.set(node.queryId, [...(byQuery.get(node.queryId) ?? []), node]);
    }
    return runs.map((run) => projectRunTree(run, byQuery.get(run.queryId ?? run.correlationId) ?? []));
  }

  summaries(trees: ExecutionTreeSnapshotV1[]): ExecutionRunSummaryV1[] {
    return trees.map((tree) => ({
      schemaVersion: 1,
      runId: tree.runId,
      queryId: tree.queryId,
      sessionId: tree.sessionId,
      provider: tree.provider,
      runtime: tree.runtime,
      promptStartedAt: tree.promptStartedAt,
      runEndedAt: tree.runEndedAt,
      nodeCount: tree.nodes.length,
      contentVisibility: contentVisibilityFor(tree.nodes)
    }));
  }
}

function projectRunTree(run: ProductionRunV1, nodes: ExecutionNodeAtomV1[]): ExecutionTreeSnapshotV1 {
  const queryId = run.queryId ?? run.correlationId;
  const promptNode = promptNodeFor(run);
  const withPrompt = nodes.some((node) => node.nodeKind === "prompt")
    ? nodes
    : [promptNode, ...nodes];
  const keyed = new Map(withPrompt.map((node) => [node.nodeId, { ...node }]));
  const root = [...keyed.values()].find((node) => node.nodeKind === "prompt")
    ?? [...keyed.values()].sort(compareNodes)[0];
  for (const node of keyed.values()) {
    if (node.nodeId === root.nodeId) {
      delete node.parentNodeId;
      continue;
    }
    if (!node.parentNodeId || !keyed.has(node.parentNodeId)) {
      node.parentNodeId = root.nodeId;
    }
  }
  const childOrder = new Map<string, ExecutionNodeAtomV1[]>();
  for (const node of keyed.values()) {
    const parent = node.parentNodeId;
    if (!parent) {
      continue;
    }
    childOrder.set(parent, [...(childOrder.get(parent) ?? []), node]);
  }
  for (const children of childOrder.values()) {
    children.sort(compareNodes);
  }
  const projected: ExecutionTreeNodeV1[] = [];
  walk(root.nodeId, keyed, childOrder, projected);
  return {
    schemaVersion: 1,
    runId: run.runId,
    queryId,
    sessionId: run.sessionId,
    provider: run.provider,
    runtime: run.runtime,
    promptStartedAt: run.startedAt,
    runEndedAt: run.endedAt,
    rootNodeKey: root.nodeId,
    nodes: projected
  };
}

function walk(
  nodeId: string,
  keyed: Map<string, ExecutionNodeAtomV1>,
  childOrder: Map<string, ExecutionNodeAtomV1[]>,
  output: ExecutionTreeNodeV1[]
): void {
  const node = keyed.get(nodeId);
  if (!node) {
    return;
  }
  const siblings = node.parentNodeId ? childOrder.get(node.parentNodeId) ?? [] : [node];
  output.push({
    ...node,
    nodeKey: node.nodeId,
    parentNodeKey: node.parentNodeId,
    siblingOrder: Math.max(0, siblings.findIndex((item) => item.nodeId === node.nodeId))
  });
  for (const child of childOrder.get(nodeId) ?? []) {
    walk(child.nodeId, keyed, childOrder, output);
  }
}

function mergeExecutionNodes(nodes: ExecutionNodeAtomV1[]): ExecutionNodeAtomV1[] {
  const merged = new Map<string, ExecutionNodeAtomV1>();
  for (const node of nodes) {
    const existing = merged.get(node.nodeId);
    merged.set(node.nodeId, existing ? mergeExecutionNode(existing, node) : node);
  }
  return [...merged.values()].sort(compareNodes);
}

function mergeExecutionNode(existing: ExecutionNodeAtomV1, incoming: ExecutionNodeAtomV1): ExecutionNodeAtomV1 {
  return {
    ...existing,
    ...incoming,
    parentNodeId: incoming.parentNodeId ?? existing.parentNodeId,
    endedAt: latestTimestamp(existing.endedAt, incoming.endedAt),
    durationMs: Math.max(existing.durationMs ?? 0, incoming.durationMs ?? 0) || undefined,
    inputTokens: incoming.inputTokens ?? existing.inputTokens,
    outputTokens: incoming.outputTokens ?? existing.outputTokens,
    cacheReadInputTokens: incoming.cacheReadInputTokens ?? existing.cacheReadInputTokens,
    cacheCreationInputTokens: incoming.cacheCreationInputTokens ?? existing.cacheCreationInputTokens,
    reasoningOutputTokens: incoming.reasoningOutputTokens ?? existing.reasoningOutputTokens,
    contents: mergeContents(existing.contents, incoming.contents)
  };
}

function mergeContents(
  existing: ExecutionNodeAtomV1["contents"],
  incoming: ExecutionNodeAtomV1["contents"]
): ExecutionNodeAtomV1["contents"] {
  const merged = new Map<string, NonNullable<ExecutionNodeAtomV1["contents"]>[number]>();
  for (const content of [...(existing ?? []), ...(incoming ?? [])]) {
    const previous = merged.get(content.kind);
    merged.set(content.kind, previous ? preferContent(previous, content) : content);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function preferContent(
  existing: NonNullable<ExecutionNodeAtomV1["contents"]>[number],
  incoming: NonNullable<ExecutionNodeAtomV1["contents"]>[number]
): NonNullable<ExecutionNodeAtomV1["contents"]>[number] {
  const rank = (visibility: NonNullable<ExecutionNodeAtomV1["contents"]>[number]["visibility"]): number =>
    visibility === "visible" ? 4 : visibility === "redacted" ? 3 : visibility === "hidden_by_policy" ? 2 : visibility === "disabled_at_source" ? 1 : 0;
  return rank(incoming.visibility) >= rank(existing.visibility)
    ? incoming.text || incoming.preview ? incoming : { ...incoming, text: existing.text, preview: incoming.preview ?? existing.preview }
    : existing;
}

function promptNodeFor(run: ProductionRunV1): ExecutionNodeAtomV1 {
  return {
    schemaVersion: 1,
    nodeId: `node_prompt_${(run.queryId ?? run.correlationId).slice(4)}`,
    queryId: run.queryId ?? run.correlationId,
    sessionId: run.sessionId,
    provider: run.provider,
    runtime: run.runtime,
    nodeKind: "prompt",
    name: "Prompt",
    outcome: "success",
    startedAt: run.startedAt,
    contents: [{
      schemaVersion: 1,
      kind: "prompt_text",
      visibility: run.promptText ? "visible" : run.promptState === "disabled" ? "disabled_at_source" : "not_captured",
      text: run.promptText,
      preview: previewText(run.promptText)
    }]
  };
}

function compareNodes(left: ExecutionNodeAtomV1, right: ExecutionNodeAtomV1): number {
  return left.startedAt.localeCompare(right.startedAt) || left.nodeId.localeCompare(right.nodeId);
}

function latestTimestamp(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function contentVisibilityFor(nodes: ExecutionTreeNodeV1[]): ExecutionRunSummaryV1["contentVisibility"] {
  const contents = nodes.flatMap((node) => node.contents ?? []);
  const visible = contents.filter((content) => content.visibility === "visible").length;
  if (contents.length === 0 || visible === 0) {
    return "topology_only";
  }
  return visible === contents.length ? "full" : "partial";
}

function previewText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}
