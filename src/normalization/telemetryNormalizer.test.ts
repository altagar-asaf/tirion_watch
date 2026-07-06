import { describe, expect, it } from "vitest";
import { DefaultTelemetryNormalizer } from "./telemetryNormalizer";

describe("DefaultTelemetryNormalizer", () => {
  it("normalizes spans from OTLP-style resourceSpans", () => {
    const normalizer = new DefaultTelemetryNormalizer();
    const records = normalizer.normalizeMany({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "github-copilot" } }
            ]
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace-1",
                  spanId: "root",
                  name: "invoke_agent",
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "2000000000",
                  attributes: [
                    { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "span",
      traceId: "trace-1",
      spanId: "root",
      name: "invoke_agent",
      attributes: { "gen_ai.usage.input_tokens": 12 },
      resourceAttributes: { "service.name": "github-copilot" }
    });
  });

  it("normalizes Copilot SDK log records", () => {
    const normalizer = new DefaultTelemetryNormalizer();
    const records = normalizer.normalizeMany({
      hrTime: [1779957698, 686000000],
      spanContext: {
        traceId: "trace-1",
        spanId: "span-1"
      },
      resource: {
        attributes: {
          "service.name": "github-copilot"
        }
      },
      attributes: {
        "event.name": "copilot_chat.agent.turn",
        "gen_ai.usage.input_tokens": 20555,
        "gen_ai.usage.output_tokens": 168
      },
      _body: "copilot_chat.agent.turn: 0"
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "event",
      traceId: "trace-1",
      spanId: "span-1",
      name: "copilot_chat.agent.turn",
      timeUnixNano: "1779957698686000000",
      attributes: {
        "gen_ai.usage.input_tokens": 20555,
        "gen_ai.usage.output_tokens": 168
      }
    });
  });

  it("normalizes Copilot SDK metrics", () => {
    const normalizer = new DefaultTelemetryNormalizer();
    const records = normalizer.normalizeMany({
      resource: { attributes: { "service.name": "github-copilot" } },
      scopeMetrics: [
        {
          metrics: [
            {
              descriptor: { name: "gen_ai.client.token.usage" },
              dataPoints: [
                {
                  value: { sum: 767, count: 3 },
                  attributes: { "gen_ai.token.type": "input" },
                  endTime: [1779957692, 457000000]
                }
              ]
            }
          ]
        }
      ]
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "metric",
      name: "gen_ai.client.token.usage",
      value: 767,
      timeUnixNano: "1779957692457000000"
    });
  });

  it("normalizes Copilot span DB rows into spans and span events", () => {
    const normalizer = new DefaultTelemetryNormalizer();
    const records = normalizer.normalizeMany({
      tirionSource: "copilot-span-db",
      span: {
        span_id: "root",
        trace_id: "trace-1",
        name: "invoke_agent",
        start_time_ms: 1_780_099_200_000,
        end_time_ms: 1_780_099_210_000,
        status_code: 1,
        conversation_id: "conversation-1",
        request_model: "gpt-5.3-codex",
        input_tokens: 100,
        output_tokens: 20
      },
      attributes: [
        {
          key: "gen_ai.input.messages",
          value: JSON.stringify([{ role: "user", content: "measure the span db" }])
        }
      ],
      events: [
        {
          name: "copilot_chat.tool.call",
          timestamp_ms: 1_780_099_205_000,
          attributes: JSON.stringify({ "gen_ai.tool.name": "readFile" })
        }
      ]
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "span",
      traceId: "trace-1",
      spanId: "root",
      name: "invoke_agent",
      startTimeUnixNano: "1780099200000000000",
      endTimeUnixNano: "1780099210000000000",
      attributes: {
        "gen_ai.conversation.id": "conversation-1",
        "gen_ai.request.model": "gpt-5.3-codex",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
        "gen_ai.input.messages": [{ role: "user", content: "measure the span db" }]
      }
    });
    expect(records[1]).toMatchObject({
      kind: "event",
      traceId: "trace-1",
      spanId: "root",
      name: "copilot_chat.tool.call",
      attributes: { "gen_ai.tool.name": "readFile" }
    });
  });

  it("normalizes span DB user_message events with prompt and chat session attributes", () => {
    const normalizer = new DefaultTelemetryNormalizer();
    const records = normalizer.normalizeMany({
      tirionSource: "copilot-span-db",
      span: {
        span_id: "root",
        trace_id: "trace-1",
        name: "invoke_agent",
        start_time_ms: 1_780_099_200_000,
        end_time_ms: null,
        status_code: 0
      },
      attributes: [],
      events: [
        {
          name: "user_message",
          timestamp_ms: 1_780_099_201_000,
          attributes: JSON.stringify({
            content: "measure prompts earlier",
            "copilot_chat.chat_session_id": "session-1"
          })
        }
      ]
    });

    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      kind: "event",
      traceId: "trace-1",
      spanId: "root",
      name: "user_message",
      timeUnixNano: "1780099201000000000",
      attributes: {
        content: "measure prompts earlier",
        "copilot_chat.chat_session_id": "session-1"
      }
    });
  });
});
