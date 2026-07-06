import { describe, expect, it } from "vitest";
import { DefaultTokenMeasurement } from "./tokenMeasurement";
import { AssembledAgentTrace, CanonicalEventRecord, CanonicalMetricRecord, CanonicalOtelRecord, CanonicalSpanRecord } from "../types";

describe("DefaultTokenMeasurement", () => {
  it("uses invoke_agent totals and does not double-count cached input tokens", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithSpans([
      span("invoke_agent", "root", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 40,
        "gen_ai.usage.cache_read.input_tokens": 30,
        "gen_ai.usage.cache_creation.input_tokens": 10
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.source).toBe("invoke_agent");
    expect(result.cachedTokens).toBe(40);
    expect(result.totalTokens).toBe(140);
  });

  it("falls back to summing child chat spans", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithSpans([
      span("invoke_agent", "root"),
      span("chat", "chat-1", "root", {
        "gen_ai.usage.input_tokens": 15,
        "gen_ai.usage.output_tokens": 5
      }),
      span("chat", "chat-2", "root", {
        "gen_ai.usage.input_tokens": 20,
        "gen_ai.usage.output_tokens": 7
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.source).toBe("chat_spans");
    expect(result.inputTokens).toBe(35);
    expect(result.outputTokens).toBe(12);
    expect(result.totalTokens).toBe(47);
    expect(result.modelUsages).toEqual([]);
  });

  it("summarizes token usage by reported model", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithSpans([
      span("invoke_agent", "root"),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-5.3-codex",
        "gen_ai.usage.input_tokens": 15,
        "gen_ai.usage.output_tokens": 5
      }),
      span("chat", "chat-2", "root", {
        "gen_ai.request.model": "gpt-5.3-codex",
        "gen_ai.usage.input_tokens": 20,
        "gen_ai.usage.output_tokens": 7
      }),
      span("chat", "chat-3", "root", {
        "gen_ai.request.model": "claude-sonnet",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 2
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.inputTokens).toBe(45);
    expect(result.outputTokens).toBe(14);
    expect(result.modelUsages).toEqual([
      expect.objectContaining({ model: "gpt-5.3-codex", inputTokens: 35, outputTokens: 12, totalTokens: 47 }),
      expect.objectContaining({ model: "claude-sonnet", provider: "anthropic", inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    ]);
  });

  it("uses the underlying model family when Copilot reports GitHub as the host provider", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithSpans([
      span("invoke_agent", "root"),
      span("chat", "chat-1", "root", {
        "gen_ai.provider.name": "github",
        "gen_ai.request.model": "claude-sonnet-4.6",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 2
      }),
      span("chat", "chat-2", "root", {
        "gen_ai.provider.name": "github",
        "gen_ai.request.model": "raptor-mini",
        "gen_ai.usage.input_tokens": 5,
        "gen_ai.usage.output_tokens": 1
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.modelUsages).toEqual([
      expect.objectContaining({ model: "claude-sonnet-4.6", provider: "anthropic", totalTokens: 12 }),
      expect.objectContaining({ model: "raptor-mini", provider: "github", totalTokens: 6 })
    ]);
  });

  it("uses the selected chat span source for model usage when inference events overlap the same call", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithRecords([
      span("invoke_agent", "root"),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-5.3-codex",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }),
      event("gen_ai.client.inference.operation.details", {
        "gen_ai.request.model": "gpt-5.3-codex",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.source).toBe("chat_spans");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
    expect(result.modelUsages).toEqual([
      expect.objectContaining({ model: "gpt-5.3-codex", inputTokens: 100, outputTokens: 20, totalTokens: 120 })
    ]);
  });

  it("drops partial per-model breakdowns when selected token records are missing model attribution", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithRecords([
      span("invoke_agent", "root"),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-5.3-codex",
        "gen_ai.usage.input_tokens": 15,
        "gen_ai.usage.output_tokens": 5
      }),
      span("chat", "chat-2", "root", {
        "gen_ai.usage.input_tokens": 20,
        "gen_ai.usage.output_tokens": 7
      }),
      span("chat", "chat-3", "root", {
        "gen_ai.request.model": "claude-sonnet",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 2
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.inputTokens).toBe(45);
    expect(result.outputTokens).toBe(14);
    expect(result.modelUsages).toEqual([]);
    expect(result.warnings).toContain("Per-model token usage is unavailable because the selected token source did not report a model for every attributed unit.");
  });

  it("keeps invoke_agent totals authoritative when lower-priority chat spans corroborate the trace", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithRecords([
      span("invoke_agent", "root", undefined, {
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-5.3-codex",
        "gen_ai.usage.input_tokens": 80,
        "gen_ai.usage.output_tokens": 10
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.source).toBe("invoke_agent");
    expect(result.sourceSelection).toMatchObject({
      selectedTokenUsageSource: "invoke_agent",
      corroboratingSources: ["chat_spans"]
    });
    expect(result.attributedUsageUnits).toHaveLength(1);
    expect(result.modelUsages).toEqual([]);
    expect(result.coverage).toEqual({
      state: "partial",
      reasons: ["missing_model_attribution"]
    });
    expect(result.invariants).toContainEqual(expect.objectContaining({ name: "attributed_total_matches_run", status: "passed" }));
    expect(result.invariants).toContainEqual(expect.objectContaining({ name: "model_totals_match_run", status: "not_applicable" }));
  });

  it("enriches invoke_agent totals with corroborating chat-span reasoning tokens", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithRecords([
      span("invoke_agent", "root", undefined, {
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.usage.input_tokens": 40,
        "gen_ai.usage.output_tokens": 8,
        "gen_ai.usage.reasoning.output_tokens": 5
      }),
      span("chat", "chat-2", "root", {
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.usage.input_tokens": 60,
        "gen_ai.usage.output_tokens": 12,
        "gen_ai.usage.reasoning.output_tokens": 7
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.source).toBe("invoke_agent");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
    expect(result.reasoningOutputTokens).toBe(12);
    expect(result.modelUsages).toEqual([
      expect.objectContaining({
        model: "gpt-5.4",
        inputTokens: 100,
        outputTokens: 20,
        reasoningOutputTokens: 12,
        totalTokens: 120
      })
    ]);
  });

  it("dedupes overlapping agent-turn and inference-detail events into one attributed unit", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithRecords([
      event("copilot_chat.agent.turn", {
        "gen_ai.conversation.id": "conversation-1",
        "gen_ai.turn.id": "turn-1",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }),
      event("gen_ai.client.inference.operation.details", {
        "gen_ai.conversation.id": "conversation-1",
        "gen_ai.turn.id": "turn-1",
        "gen_ai.request.model": "gpt-test",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.source).toBe("events");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
    expect(result.totalTokens).toBe(120);
    expect(result.attributedUsageUnits).toHaveLength(1);
    expect(result.modelUsages).toEqual([
      expect.objectContaining({ model: "gpt-test", inputTokens: 100, outputTokens: 20, totalTokens: 120 })
    ]);
    expect(result.sourceSelection).toMatchObject({
      selectedTokenUsageSource: "events",
      dedupedRecordCount: 1,
      discardedOverlapReasons: ["duplicate_overlap_discarded"]
    });
    expect(result.coverage).toEqual({
      state: "complete",
      reasons: ["duplicate_overlap_discarded", "event_only_trace"]
    });
  });

  it("marks conflicting overlapping event records as ambiguous", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithRecords([
      event("copilot_chat.agent.turn", {
        "gen_ai.conversation.id": "conversation-1",
        "gen_ai.turn.id": "turn-1",
        "gen_ai.request.model": "gpt-test",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20
      }),
      event("gen_ai.client.inference.operation.details", {
        "gen_ai.conversation.id": "conversation-1",
        "gen_ai.turn.id": "turn-1",
        "gen_ai.request.model": "gpt-test",
        "gen_ai.usage.input_tokens": 120,
        "gen_ai.usage.output_tokens": 20
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.source).toBe("events");
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.reasons).toContain("source_ambiguous");
    expect(result.warnings).toContain("Overlapping event token records disagreed; selected the most complete event record for attribution.");
  });

  it("marks metrics-only traces as partial and exposes not-applicable model invariants", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithRecords([
      metric("input", 30),
      metric("output", 12)
    ]);

    const result = measurement.measure(trace);

    expect(result.source).toBe("metrics");
    expect(result.inputTokens).toBe(30);
    expect(result.outputTokens).toBe(12);
    expect(result.totalTokens).toBe(42);
    expect(result.modelUsages).toEqual([]);
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.reasons).toContain("metrics_only_trace");
    expect(result.invariants).toContainEqual(expect.objectContaining({ name: "model_totals_match_run", status: "not_applicable" }));
  });

  it("aggregates partial input and output pairs across selected chat spans", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithRecords([
      span("invoke_agent", "root"),
      span("chat", "chat-1", "root", {
        "gen_ai.request.model": "gpt-test",
        "gen_ai.usage.input_tokens": 10
      }),
      span("chat", "chat-2", "root", {
        "gen_ai.request.model": "gpt-test",
        "gen_ai.usage.output_tokens": 5
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.source).toBe("chat_spans");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(result.totalTokens).toBe(15);
    expect(result.coverage).toEqual({ state: "complete", reasons: [] });
    expect(result.modelUsages).toEqual([
      expect.objectContaining({ model: "gpt-test", inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    ]);
  });

  it("marks cached token inconsistencies as partial", () => {
    const measurement = new DefaultTokenMeasurement();
    const trace = traceWithRecords([
      span("invoke_agent", "root", undefined, {
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
        "gen_ai.usage.cache_read.input_tokens": 20
      })
    ]);

    const result = measurement.measure(trace);

    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.reasons).toContain("invariant_failed");
    expect(result.warnings).toContain("Cached input tokens exceed input tokens; treating cached tokens as reported metadata only.");
  });
});

function traceWithSpans(spans: CanonicalSpanRecord[]): AssembledAgentTrace {
  return traceWithRecords(spans);
}

function traceWithRecords(records: CanonicalOtelRecord[]): AssembledAgentTrace {
  return {
    traceId: "trace-1",
    rootSpan: records.find((record): record is CanonicalSpanRecord => record.kind === "span"),
    spans: records.filter((record): record is CanonicalSpanRecord => record.kind === "span"),
    events: records.filter((record): record is CanonicalEventRecord => record.kind === "event"),
    metrics: records.filter((record): record is CanonicalMetricRecord => record.kind === "metric"),
    firstSeenAt: "2026-05-28T00:00:00.000Z",
    lastUpdatedAt: "2026-05-28T00:00:00.000Z"
  };
}

function span(
  name: string,
  spanId: string,
  parentSpanId?: string,
  attributes: Record<string, unknown> = {}
): CanonicalSpanRecord {
  return {
    kind: "span",
    traceId: "trace-1",
    spanId,
    parentSpanId,
    name,
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: name === "invoke_agent" ? "2000000000" : undefined,
    attributes,
    resourceAttributes: {}
  };
}

function event(
  name: string,
  attributes: Record<string, unknown> = {}
): CanonicalEventRecord {
  return {
    kind: "event",
    traceId: "trace-1",
    spanId: "chat-1",
    name,
    timeUnixNano: "1500000000",
    attributes,
    resourceAttributes: {}
  };
}

function metric(tokenType: string, value: number): CanonicalMetricRecord {
  return {
    kind: "metric",
    name: "gen_ai.client.token.usage",
    traceId: "trace-1",
    spanId: "metric-span-1",
    timeUnixNano: "1500000000",
    value,
    attributes: {
      "gen_ai.token.type": tokenType
    },
    resourceAttributes: {}
  };
}
