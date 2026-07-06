import { describe, expect, it } from "vitest";
import { DefaultCostEstimation } from "../pricing/costEstimation";
import { CanonicalEventRecord, CanonicalSpanRecord, ModelPricing, PricingCatalog } from "../types";
import { DefaultAgentRunAssembler, sortForTraceAssembly } from "./agentRunAssembler";
import { DefaultTokenMeasurement } from "./tokenMeasurement";

describe("DefaultAgentRunAssembler", () => {
  it("assembles one completed agent run with LLM calls and tools", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      0
    );

    const records = sortForTraceAssembly([
      span("invoke_agent", "root", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1000000000", "3000000000"),
      span("chat", "chat-1", "root", { "gen_ai.request.model": "gpt-test" }),
      span("execute_tool readFile", "tool-1", "root", { "gen_ai.tool.name": "readFile" })
    ]);

    const updates = records.flatMap((record) => {
      const update = assembler.ingest(record);
      return update ? [update] : [];
    });

    const completed = updates.at(-1);
    expect(completed?.kind).toBe("completed");
    expect(completed?.run.totalTokens).toBe(120);
    expect(completed?.run.initialQueryState).toBe("unavailable");
    expect(completed?.run.llmCallCount).toBe(1);
    expect(completed?.run.toolCallCount).toBe(1);
    expect(completed?.run.tools[0]).toMatchObject({ name: "readFile", count: 1 });
  });

  it("keeps child invoke_agent spans attached to the parent run", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      0
    );

    const records = sortForTraceAssembly([
      span("invoke_agent", "parent", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1000000000", "5000000000"),
      span("execute_tool runSubagent", "tool-1", "parent", { "gen_ai.tool.name": "runSubagent" }),
      span("invoke_agent", "child", "tool-1", {}, "2000000000", "4000000000"),
      span("chat", "chat-1", "child", { "gen_ai.request.model": "gpt-test" })
    ]);

    const updates = records.flatMap((record) => {
      const update = assembler.ingest(record);
      return update ? [update] : [];
    });

    const completed = updates.at(-1);
    expect(completed?.kind).toBe("completed");
    expect(completed?.run.traceId).toBe("trace-1");
    expect(completed?.run.toolCallCount).toBe(1);
    expect(completed?.run.llmCallCount).toBe(1);
  });

  it("finalizes Copilot event-only traces after they become stale", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      0
    );

    assembler.ingest({
      kind: "event",
      traceId: "event-trace",
      spanId: "root",
      name: "copilot_chat.session.start",
      timeUnixNano: "1779957687834000000",
      attributes: {
        "session.id": "session-1",
        "gen_ai.request.model": "gpt-5.3-codex"
      },
      resourceAttributes: { "service.name": "github-copilot" }
    });

    assembler.ingest({
      kind: "event",
      traceId: "event-trace",
      spanId: "root",
      name: "copilot_chat.agent.turn",
      timeUnixNano: "1779957698686000000",
      attributes: {
        "gen_ai.usage.input_tokens": 20555,
        "gen_ai.usage.output_tokens": 168
      },
      resourceAttributes: {}
    });

    const evicted = assembler.evictStale(-1);

    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toMatchObject({
      traceId: "event-trace",
      initialQueryState: "unavailable",
      status: "completed",
      inputTokens: 20555,
      outputTokens: 168,
      totalTokens: 20723,
      durationMs: 10852
    });
  });

  it("uses a stable per-trace query id and keeps prompt attribution, pricing, and tool summaries", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      0
    );

    const records = sortForTraceAssembly([
      span("invoke_agent", "root", undefined, {
        "gen_ai.conversation.id": "conversation-1",
        "gen_ai.turn.id": "turn-1",
        "tirion.initial_user_query": "measure this prompt",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1780099200000000000", "1780099210000000000"),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-5.3-codex",
        "gen_ai.usage.input_tokens": 80,
        "gen_ai.usage.output_tokens": 10
      }),
      span("execute_tool readFile", "tool-1", "root", {
        "gen_ai.tool.name": "readFile",
        "gen_ai.usage.input_tokens": 5,
        "gen_ai.usage.output_tokens": 2
      })
    ]);

    const updates = records.flatMap((record) => {
      const update = assembler.ingest(record);
      return update ? [update] : [];
    });

    const completed = updates.at(-1);
    expect(completed?.kind).toBe("completed");
    expect(completed?.run).toMatchObject({
      schemaVersion: 3,
      queryId: "trace-1",
      initialQueryText: "measure this prompt",
      initialQueryState: "captured"
    });
    expect(completed?.run.modelUsages).toEqual([]);
    expect(completed?.run.costCoverage).toBe("unavailable");
    expect(completed?.run.tokenUsageSource).toBe("invoke_agent");
    expect(completed?.run.estimatedNanoUsd).toBeUndefined();
    expect(completed?.run.pricingCoverage).toEqual({
      state: "unpriced",
      reasons: ["missing_model_attribution"],
      pricedModels: [],
      unpricedModels: [],
      missingModelSlices: 1,
      pricingVersions: [],
      pricingEffectiveFrom: []
    });
    expect(completed?.run.warnings).toContain(
      "Estimated cost is unavailable because no attributed model slice could be matched to pricing."
    );
    expect(completed?.run.accounting).toMatchObject({
      accountingSchemaVersion: 1,
      sourceSelection: {
        selectedTokenUsageSource: "invoke_agent",
        corroboratingSources: ["chat_spans"],
        dedupedRecordCount: 0,
        discardedOverlapReasons: []
      },
      totals: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        estimatedNanoUsd: undefined,
        pricingCoverage: {
          state: "unpriced",
          reasons: ["missing_model_attribution"],
          pricedModels: [],
          unpricedModels: [],
          missingModelSlices: 1,
          pricingVersions: [],
          pricingEffectiveFrom: []
        }
      }
    });
    expect(completed?.run.accounting.toolSummaries).toEqual([
      expect.objectContaining({
        name: "readFile",
        count: 1,
        coverage: {
          state: "partial",
          reasons: ["missing_tool_attribution"]
        }
      })
    ]);
    expect(completed?.run.accounting.spanSummaries).toEqual([
      expect.objectContaining({
        spanId: "root",
        kind: "root",
        totalTokens: 120,
        coverage: {
          state: "partial",
          reasons: ["missing_model_attribution"]
        }
      })
    ]);
    expect(completed?.run.tools[0]).toMatchObject({
      name: "readFile",
      count: 1,
      failures: 0,
      totalDurationMs: 0
    });
    expect(completed?.run.tools[0].totalTokens).toBeUndefined();
  });

  it("does not double-count overlapping inference-detail events in model pricing", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([
        {
          provider: "openai",
          modelPattern: "^gpt-test$",
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 20,
          effectiveFrom: "2026-01-01"
        }
      ])),
      0
    );

    const records = sortForTraceAssembly([
      span("invoke_agent", "root", undefined, {}, "1780099200000000000", "1780099210000000000"),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-test",
        "gen_ai.usage.input_tokens": 1_000_000,
        "gen_ai.usage.output_tokens": 500_000
      }),
      {
        kind: "event" as const,
        traceId: "trace-1",
        spanId: "chat-1",
        name: "gen_ai.client.inference.operation.details",
        timeUnixNano: "1780099205000000000",
        attributes: {
          "gen_ai.request.model": "gpt-test",
          "gen_ai.usage.input_tokens": 1_000_000,
          "gen_ai.usage.output_tokens": 500_000
        },
        resourceAttributes: {}
      }
    ]);

    const updates = records.flatMap((record) => {
      const update = assembler.ingest(record);
      return update ? [update] : [];
    });

    const completed = updates.at(-1);
    expect(completed?.kind).toBe("completed");
    expect(completed?.run.inputTokens).toBe(1_000_000);
    expect(completed?.run.outputTokens).toBe(500_000);
    expect(completed?.run.modelUsages).toEqual([
      expect.objectContaining({
        model: "gpt-test",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        totalTokens: 1_500_000
      })
    ]);
    expect(completed?.run.tokenUsageSource).toBe("chat_spans");
    expect(completed?.run.costCoverage).toBe("complete");
    expect(completed?.run.estimatedNanoUsd).toBe(20_000_000_000);
    expect(completed?.run.estimatedUsd).toBeCloseTo(20);
    expect(completed?.run.pricingCoverage).toEqual({
      state: "priced",
      reasons: [],
      pricedModels: ["gpt-test"],
      unpricedModels: [],
      missingModelSlices: 0,
      pricingVersions: ["test"],
      pricingEffectiveFrom: ["2026-01-01"]
    });
    expect(completed?.run.accounting.attributedUsageUnits).toHaveLength(1);
    expect(completed?.run.accounting.spanSummaries).toHaveLength(1);
    expect(completed?.run.modelUsages[0].estimatedNanoUsd).toBe(20_000_000_000);
    expect(completed?.run.modelUsages[0].estimatedUsd).toBeCloseTo(20);
  });

  it("marks multi-model runs as partial when only part of the model breakdown can be priced", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([
        {
          provider: "openai",
          modelPattern: "^gpt-test$",
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 20,
          effectiveFrom: "2026-01-01"
        }
      ])),
      0
    );

    const records = sortForTraceAssembly([
      span("invoke_agent", "root", undefined, {}, "1780099200000000000", "1780099210000000000"),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-test",
        "gen_ai.usage.input_tokens": 800_000,
        "gen_ai.usage.output_tokens": 100_000
      }),
      span("chat", "chat-2", "root", {
        "gen_ai.request.model": "claude-sonnet",
        "gen_ai.usage.input_tokens": 200_000,
        "gen_ai.usage.output_tokens": 50_000
      })
    ]);

    const updates = records.flatMap((record) => {
      const update = assembler.ingest(record);
      return update ? [update] : [];
    });

    const completed = updates.at(-1);
    expect(completed?.kind).toBe("completed");
    expect(completed?.run.tokenUsageSource).toBe("chat_spans");
    expect(completed?.run.costCoverage).toBe("partial");
    expect(completed?.run.estimatedNanoUsd).toBe(10_000_000_000);
    expect(completed?.run.estimatedUsd).toBeCloseTo(10);
    expect(completed?.run.pricingCoverage).toEqual({
      state: "partial",
      reasons: ["model_unpriced"],
      pricedModels: ["gpt-test"],
      unpricedModels: ["claude-sonnet"],
      missingModelSlices: 0,
      pricingVersions: ["test"],
      pricingEffectiveFrom: ["2026-01-01"]
    });
    expect(completed?.run.warnings).toContain("Estimated cost is partial and covers only attributed model slices with matched pricing.");
  });

  it("keeps cache-heavy priced runs reconciled across span, model, and run totals", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([
        {
          provider: "openai",
          modelPattern: "^gpt-test$",
          inputUsdPerMillion: 10,
          cachedInputUsdPerMillion: 1,
          cacheCreationUsdPerMillion: 5,
          outputUsdPerMillion: 30,
          effectiveFrom: "2026-01-01"
        }
      ])),
      0
    );

    const records = sortForTraceAssembly([
      span("invoke_agent", "root", undefined, {}, "1780099200000000000", "1780099210000000000"),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-test",
        "gen_ai.usage.input_tokens": 1_000_000,
        "gen_ai.usage.output_tokens": 500_000,
        "gen_ai.usage.cache_read.input_tokens": 200_000,
        "gen_ai.usage.cache_creation.input_tokens": 100_000
      })
    ]);

    const updates = records.flatMap((record) => {
      const update = assembler.ingest(record);
      return update ? [update] : [];
    });

    const completed = updates.at(-1);
    expect(completed?.kind).toBe("completed");
    expect(completed?.run).toMatchObject({
      tokenUsageSource: "chat_spans",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedTokens: 300_000,
      totalTokens: 1_500_000,
      estimatedNanoUsd: 22_700_000_000,
      estimatedUsd: 22.7,
      costCoverage: "complete"
    });
    expect(completed?.run.pricingCoverage).toEqual({
      state: "priced",
      reasons: [],
      pricedModels: ["gpt-test"],
      unpricedModels: [],
      missingModelSlices: 0,
      pricingVersions: ["test"],
      pricingEffectiveFrom: ["2026-01-01"]
    });
    expect(completed?.run.modelUsages).toEqual([
      expect.objectContaining({
        model: "gpt-test",
        cachedTokens: 300_000,
        totalTokens: 1_500_000,
        estimatedNanoUsd: 22_700_000_000
      })
    ]);
    expect(completed?.run.accounting.spanSummaries).toEqual([
      expect.objectContaining({
        model: "gpt-test",
        cachedTokens: 300_000,
        totalTokens: 1_500_000,
        estimatedNanoUsd: 22_700_000_000,
        coverage: { state: "complete", reasons: [] }
      })
    ]);
    expect(completed?.run.accounting.totals).toMatchObject({
      cachedTokens: 300_000,
      totalTokens: 1_500_000,
      estimatedNanoUsd: 22_700_000_000,
      coverage: { state: "complete", reasons: [] }
    });
    expect(completed?.run.accounting.invariants).toContainEqual(expect.objectContaining({
      name: "priced_nano_usd_matches_run",
      status: "passed"
    }));
  });

  it("keeps a terminal trace open long enough to accept a late prompt-bearing span revision", async () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const firstUpdate = assembler.ingest(span("invoke_agent", "root", undefined, {
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20
    }, "1780099200000000000", "1780099210000000000"));

    expect(firstUpdate?.kind).toBe("running");
    expect(firstUpdate?.run.initialQueryText).toBeUndefined();
    expect(firstUpdate?.run.initialQueryState).toBe("pending");
    expect(firstUpdate?.run.tokenUsageSource).toBe("invoke_agent");

    const revisedUpdate = assembler.ingest(span("invoke_agent", "root", undefined, {
      "tirion.initial_user_query": "capture me after completion",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20
    }, "1780099200000000000", "1780099210000000000"));

    expect(revisedUpdate?.kind).toBe("running");
    expect(revisedUpdate?.run.initialQueryText).toBe("capture me after completion");
    expect(revisedUpdate?.run.initialQueryState).toBe("captured");
  });

  it("captures the initial prompt from a root user_message event before span prompt attributes arrive", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const updates = assembler.ingestMany(sortForTraceAssembly([
      span("invoke_agent GitHub Copilot Chat", "root", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1780099200000000000"),
      userMessageEvent("root", "prompt from user_message", "1780099201000000000")
    ]));

    expect(updates.at(-1)?.run).toMatchObject({
      initialQueryText: "prompt from user_message",
      initialQueryState: "captured"
    });

    const revisedRoot = assembler.ingest(span("invoke_agent GitHub Copilot Chat", "root", undefined, {
      "tirion.initial_user_query": "fallback from gen_ai input messages",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20
    }, "1780099200000000000"));

    expect(revisedRoot?.run.initialQueryText).toBe("prompt from user_message");
  });

  it("recomputes prompt candidates when a root span arrives after an early user_message event", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    expect(assembler.ingest(userMessageEvent("root", "early event prompt", "1780099201000000000"))).toBeNull();

    const update = assembler.ingest(span("invoke_agent GitHub Copilot Chat", "root", undefined, {
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20
    }, "1780099200000000000"));

    expect(update?.run).toMatchObject({
      initialQueryText: "early event prompt",
      initialQueryState: "captured"
    });
  });

  it("accepts a user_message event attached to a safe descendant of the root span", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const updates = assembler.ingestMany(sortForTraceAssembly([
      span("invoke_agent GitHub Copilot Chat", "root", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1780099200000000000"),
      span("chat", "chat-1", "root", {}, "1780099200500000000"),
      userMessageEvent("chat-1", "descendant event prompt", "1780099201000000000")
    ]));

    expect(updates.at(-1)?.run).toMatchObject({
      initialQueryText: "descendant event prompt",
      initialQueryState: "captured"
    });
  });

  it("rejects user_message events under tool spans", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const updates = assembler.ingestMany(sortForTraceAssembly([
      span("invoke_agent GitHub Copilot Chat", "root", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1780099200000000000"),
      span("execute_tool readFile", "tool-1", "root", { "gen_ai.tool.name": "readFile" }, "1780099200500000000"),
      span("chat", "tool-chat", "tool-1", {}, "1780099200600000000"),
      userMessageEvent("tool-chat", "tool-adjacent prompt", "1780099201000000000")
    ]));

    expect(updates.at(-1)?.run.initialQueryText).toBeUndefined();
    expect(updates.at(-1)?.run.initialQueryState).toBe("pending");
  });

  it("rejects user_message events under nested invoke_agent spans", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const updates = assembler.ingestMany(sortForTraceAssembly([
      span("invoke_agent GitHub Copilot Chat", "root", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1780099200000000000"),
      span("invoke_agent GitHub Copilot Chat", "nested", "root", {}, "1780099200500000000"),
      span("chat", "nested-chat", "nested", {}, "1780099200600000000"),
      userMessageEvent("nested-chat", "nested helper prompt", "1780099201000000000")
    ]));

    expect(updates.at(-1)?.run.initialQueryText).toBeUndefined();
    expect(updates.at(-1)?.run.initialQueryState).toBe("pending");
  });

  it("rejects user_message prompt candidates from helper traces", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const updates = assembler.ingestMany(sortForTraceAssembly([
      span("invoke_agent GitHub Copilot Chat", "helper-root", undefined, {
        "copilot_chat.session_id": "session-1",
        "copilot_chat.chat_session_id": "helper-chat-1",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1780099200000000000"),
      userMessageEvent("helper-root", "synthetic helper prompt", "1780099201000000000", {
        "copilot_chat.chat_session_id": "helper-chat-1"
      })
    ]));

    expect(updates.at(-1)?.run).toMatchObject({
      traceRole: "helper",
      initialQueryState: "pending"
    });
    expect(updates.at(-1)?.run.initialQueryText).toBeUndefined();
  });

  it("prefers the latest valid user_message event in one trace", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const updates = assembler.ingestMany(sortForTraceAssembly([
      span("invoke_agent GitHub Copilot Chat", "root", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1780099200000000000"),
      userMessageEvent("root", "first prompt", "1780099201000000000"),
      userMessageEvent("root", "second prompt", "1780099202000000000")
    ]));

    expect(updates.at(-1)?.run.initialQueryText).toBe("second prompt");
  });

  it("ignores historical user_message events before the root span starts", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const updates = assembler.ingestMany(sortForTraceAssembly([
      span("invoke_agent GitHub Copilot Chat", "root", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1780099200000000000"),
      userMessageEvent("root", "first session prompt", "1780099100000000000"),
      userMessageEvent("root", "current turn prompt", "1780099201000000000")
    ]));

    expect(updates.at(-1)?.run.initialQueryText).toBe("current turn prompt");
  });

  it("keeps the original user prompt when a later helper rewrite appears in the same trace", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const original = assembler.ingest(span("invoke_agent GitHub Copilot Chat", "root", undefined, {
      "tirion.initial_user_query": "how many pricing models do we support?",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20
    }, "1780099200000000000", "1780099210000000000"));

    expect(original?.run.initialQueryText).toBe("how many pricing models do we support?");

    const rewritten = assembler.ingest(span("invoke_agent GitHub Copilot Chat", "root", undefined, {
      "tirion.initial_user_query": "Find relevant code snippets for: pricing models\n\nCurrent working directory: /repo\n\nMore detailed instructions:\nQuick read-only exploration.",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20
    }, "1780099200000000000", "1780099210000000000"));

    expect(rewritten?.run.initialQueryText).toBe("how many pricing models do we support?");
  });

  it("does not attribute helper-generated rewritten prompts as the user prompt", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      0
    );

    const update = assembler.ingest(span("invoke_agent GitHub Copilot Chat", "root", undefined, {
      "tirion.initial_user_query": "Find relevant code snippets for: pricing models\n\nCurrent working directory: /repo\n\nMore detailed instructions:\nQuick read-only exploration.",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20
    }, "1780099200000000000", "1780099210000000000"));

    expect(update?.run.initialQueryText).toBeUndefined();
    expect(update?.run.initialQueryState).toBe("unavailable");
  });

  it("groups spawned helper traces under the owning top-level user trace and preserves session metadata", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      1_000
    );

    const parent = assembler.ingest({
      ...span("invoke_agent GitHub Copilot Chat", "root", undefined, {
        "tirion.initial_user_query": "what classes are associated with the actual constructs?",
        "copilot_chat.session_id": "session-1",
        "copilot_chat.chat_session_id": "session-1",
        "gen_ai.conversation.id": "session-1",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }, "1780099200000000000", "1780099210000000000"),
      traceId: "trace-parent"
    });

    expect(parent?.run).toMatchObject({
      traceId: "trace-parent",
      queryId: "trace-parent",
      chatSessionId: "session-1",
      copilotSessionId: "session-1",
      traceChatSessionId: "session-1",
      traceRole: "main",
      initialQueryText: "what classes are associated with the actual constructs?",
      initialQueryState: "captured"
    });

    const helper = assembler.ingest({
      ...span("invoke_agent GitHub Copilot Chat", "helper-root", undefined, {
        "tirion.initial_user_query": "Find relevant code snippets for: constructs\n\nCurrent working directory: /repo\n\nMore detailed instructions:\nQuick read-only exploration.",
        "copilot_chat.session_id": "session-1",
        "copilot_chat.chat_session_id": "helper-chat-1",
        "gen_ai.conversation.id": "session-1",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.usage.input_tokens": 30,
        "gen_ai.usage.output_tokens": 5
      }, "1780099205000000000", "1780099215000000000"),
      traceId: "trace-helper"
    });

    expect(helper?.run).toMatchObject({
      traceId: "trace-helper",
      queryId: "trace-parent",
      chatSessionId: "session-1",
      copilotSessionId: "session-1",
      traceChatSessionId: "helper-chat-1",
      traceRole: "helper",
      initialQueryState: "pending"
    });
    expect(helper?.run.initialQueryText).toBeUndefined();
  });

  it("keeps identical user prompt text in separate prompt occurrences", () => {
    const assembler = new DefaultAgentRunAssembler(
      new DefaultTokenMeasurement(),
      new DefaultCostEstimation(testCatalog([])),
      0
    );

    const first = assembler.ingest({
      ...span("invoke_agent GitHub Copilot Chat", "root-1", undefined, {
        "tirion.initial_user_query": "open the dashboard",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5
      }, "1780099200000000000", "1780099201000000000"),
      traceId: "trace-a"
    });

    const second = assembler.ingest({
      ...span("invoke_agent GitHub Copilot Chat", "root-2", undefined, {
        "tirion.initial_user_query": "open the dashboard",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.usage.input_tokens": 12,
        "gen_ai.usage.output_tokens": 6
      }, "1780099202000000000", "1780099203000000000"),
      traceId: "trace-b"
    });

    expect(first?.run).toMatchObject({
      traceId: "trace-a",
      queryId: "trace-a",
      initialQueryText: "open the dashboard",
      initialQueryState: "captured"
    });
    expect(second?.run).toMatchObject({
      traceId: "trace-b",
      queryId: "trace-b",
      initialQueryText: "open the dashboard",
      initialQueryState: "captured"
    });
  });
});

function testCatalog(pricingTable: ModelPricing[]): PricingCatalog {
  return {
    billingContext: "openai-direct",
    primaryBillingUnit: "usd",
    pricingVersions: ["test"],
    pricingTable: pricingTable.map((pricing) => ({ pricingVersion: pricing.pricingVersion ?? "test", ...pricing }))
  };
}

function span(
  name: string,
  spanId: string,
  parentSpanId?: string,
  attributes: Record<string, unknown> = {},
  startTimeUnixNano = "1000000000",
  endTimeUnixNano?: string
): CanonicalSpanRecord {
  return {
    kind: "span",
    traceId: "trace-1",
    spanId,
    parentSpanId,
    name,
    startTimeUnixNano,
    endTimeUnixNano,
    attributes,
    resourceAttributes: {}
  };
}

function userMessageEvent(
  spanId: string,
  initialQueryText: string,
  timeUnixNano: string,
  attributes: Record<string, unknown> = {}
): CanonicalEventRecord {
  return {
    kind: "event",
    traceId: "trace-1",
    spanId,
    name: "user_message",
    timeUnixNano,
    attributes: {
      "tirion.initial_user_query": initialQueryText,
      ...attributes
    },
    resourceAttributes: {}
  };
}
