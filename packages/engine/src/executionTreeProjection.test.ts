import { describe, expect, it } from "vitest";
import type { ExecutionNodeAtomV1, ProductionRunV1 } from "@tirion/agent-contract";
import { DefaultExecutionTreeProjection } from "./executionTreeProjection";

describe("execution tree projection", () => {
  it("builds a faithful node hierarchy for a completed run", () => {
    const projection = new DefaultExecutionTreeProjection();
    const run: ProductionRunV1 = {
      schemaVersion: 1,
      production: true,
      runId: "run_12345678",
      correlationId: "qry_12345678",
      queryId: "qry_12345678",
      sessionId: "ses_12345678",
      promptState: "captured",
      promptText: "Ship it",
      provider: "github-copilot",
      runtime: "github-copilot",
      authority: "run",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 15,
      billingContext: "github-copilot",
      costCoverage: "unavailable",
      evidenceGrade: "estimated_usage_cost_unattributed",
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:03.000Z",
      warnings: []
    };
    const nodes: ExecutionNodeAtomV1[] = [
      {
        schemaVersion: 1,
        nodeId: "node_prompt_12345678",
        queryId: "qry_12345678",
        sessionId: "ses_12345678",
        provider: "github-copilot",
        runtime: "github-copilot",
        nodeKind: "prompt",
        name: "Prompt",
        outcome: "success",
        startedAt: "2026-06-08T00:00:00.000Z",
        contents: [{
          schemaVersion: 1,
          kind: "prompt_text",
          visibility: "visible",
          text: "Ship it",
          preview: "Ship it"
        }]
      },
      {
        schemaVersion: 1,
        nodeId: "node_root",
        queryId: "qry_12345678",
        sessionId: "ses_12345678",
        provider: "github-copilot",
        runtime: "github-copilot",
        nodeKind: "llm_request",
        name: "invoke_agent",
        parentNodeId: "node_prompt_12345678",
        outcome: "success",
        startedAt: "2026-06-08T00:00:00.100Z"
      },
      {
        schemaVersion: 1,
        nodeId: "node_tool",
        queryId: "qry_12345678",
        sessionId: "ses_12345678",
        provider: "github-copilot",
        runtime: "github-copilot",
        nodeKind: "tool",
        name: "readFile",
        parentNodeId: "node_root",
        outcome: "success",
        startedAt: "2026-06-08T00:00:00.200Z",
        contents: [{
          schemaVersion: 1,
          kind: "tool_input",
          visibility: "visible",
          text: "{\"path\":\"README.md\"}",
          preview: "{\"path\":\"README.md\"}"
        }]
      }
    ];

    const tree = projection.project([run], nodes)[0];
    const summary = projection.summaries([tree])[0];
    expect(tree).toMatchObject({
      runId: "run_12345678",
      rootNodeKey: "node_prompt_12345678"
    });
    expect(tree.nodes).toEqual([
      expect.objectContaining({ nodeKey: "node_prompt_12345678", siblingOrder: 0 }),
      expect.objectContaining({ nodeKey: "node_root", parentNodeKey: "node_prompt_12345678", siblingOrder: 0 }),
      expect.objectContaining({ nodeKey: "node_tool", parentNodeKey: "node_root", siblingOrder: 0 })
    ]);
    expect(summary).toMatchObject({
      runId: "run_12345678",
      nodeCount: 3,
      contentVisibility: "full"
    });
  });

  it("falls back to topology only when no visible content survives", () => {
    const projection = new DefaultExecutionTreeProjection();
    const run: ProductionRunV1 = {
      schemaVersion: 1,
      production: true,
      runId: "run_topology",
      correlationId: "qry_topology",
      queryId: "qry_topology",
      provider: "codex",
      runtime: "codex",
      authority: "turn",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 2,
      billingContext: "unknown",
      costCoverage: "unavailable",
      evidenceGrade: "estimated_usage_cost_unattributed",
      promptState: "disabled",
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:01.000Z",
      warnings: []
    };
    const tree = projection.project([run], [])[0];
    expect(projection.summaries([tree])[0]).toMatchObject({ contentVisibility: "topology_only" });
  });
});
