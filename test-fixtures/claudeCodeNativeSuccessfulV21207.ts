// Synthetic metadata-only fixture derived from the privacy-safe Claude Code 2.1.207
// native success census. It contains no prompt/response/tool content, filesystem
// path, account data, or identifier copied from the observed run.

const textAttribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
const intAttribute = (key: string, value: number) => ({ key, value: { intValue: String(value) } });
const doubleAttribute = (key: string, value: number) => ({ key, value: { doubleValue: value } });
const serviceResource = {
  attributes: [
    textAttribute("service.name", "claude-code"),
    textAttribute("service.version", "2.1.207")
  ]
};

const promptId = "fixture-native-success-prompt";
const sessionId = "fixture-native-success-session";
const traceId = "fixture-native-success-trace";
const rootSpanId = "fixture-native-success-root-span";
const titleRequestId = "fixture-native-success-title-request";
const mainRequestOneId = "fixture-native-success-main-request-one";
const mainRequestTwoId = "fixture-native-success-main-request-two";

const apiRequest = (input: {
  at: string;
  requestId: string;
  model: string;
  querySource: "generate_session_title" | "sdk";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}) => ({
  ...(input.querySource === "sdk" ? { traceId, spanId: rootSpanId } : {}),
  timeUnixNano: input.at,
  attributes: [
    textAttribute("event.name", "api_request"),
    textAttribute("prompt.id", promptId),
    textAttribute("request_id", input.requestId),
    textAttribute("model", input.model),
    textAttribute("query_source", input.querySource),
    intAttribute("input_tokens", input.inputTokens),
    intAttribute("output_tokens", input.outputTokens),
    intAttribute("cache_read_tokens", input.cacheReadTokens),
    intAttribute("cache_creation_tokens", input.cacheCreationTokens),
    doubleAttribute("cost_usd", input.costUsd)
  ]
});

const llmRequest = (input: {
  spanId: string;
  requestId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}) => ({
  traceId,
  spanId: input.spanId,
  parentSpanId: rootSpanId,
  name: "claude_code.llm_request",
  startTimeUnixNano: input.startedAt,
  endTimeUnixNano: input.endedAt,
  status: { code: 1 },
  attributes: [
    textAttribute("request_id", input.requestId),
    textAttribute("gen_ai.request.model", input.model),
    intAttribute("input_tokens", input.inputTokens),
    intAttribute("output_tokens", input.outputTokens),
    intAttribute("cache_read_tokens", input.cacheReadTokens),
    intAttribute("cache_creation_tokens", input.cacheCreationTokens),
    { key: "success", value: { boolValue: true } }
  ]
});

export const claudeCodeNativeSuccessfulV21207 = {
  fixtureId: "claude-code-native-success-v2.1.207",
  providerVersion: "2.1.207",
  promptObservedAt: "2026-07-12T08:00:00.000Z",
  promptHook: {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt_id: promptId
  },
  promptLogEnvelope: {
    resourceLogs: [{
      resource: serviceResource,
      scopeLogs: [{ logRecords: [{
        traceId,
        spanId: rootSpanId,
        timeUnixNano: "1783843200010000000",
        attributes: [
          textAttribute("event.name", "user_prompt"),
          textAttribute("prompt.id", promptId)
        ]
      }] }]
    }]
  },
  apiLogEnvelope: {
    resourceLogs: [{
      resource: serviceResource,
      scopeLogs: [{ logRecords: [
        apiRequest({
          at: "1783843200100000000",
          requestId: titleRequestId,
          model: "claude-haiku-4-5-20251001",
          querySource: "generate_session_title",
          inputTokens: 564,
          outputTokens: 15,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.000639
        }),
        apiRequest({
          at: "1783843200200000000",
          requestId: mainRequestOneId,
          model: "claude-sonnet-5",
          querySource: "sdk",
          inputTokens: 2,
          outputTokens: 127,
          cacheReadTokens: 6_263,
          cacheCreationTokens: 5_731,
          costUsd: 0.0381759
        }),
        apiRequest({
          at: "1783843200300000000",
          requestId: mainRequestTwoId,
          model: "claude-sonnet-5",
          querySource: "sdk",
          inputTokens: 2,
          outputTokens: 19,
          cacheReadTokens: 11_994,
          cacheCreationTokens: 223,
          costUsd: 0.0052272
        })
      ] }]
    }]
  },
  traceEnvelope: {
    resourceSpans: [{
      resource: serviceResource,
      scopeSpans: [{ spans: [
        llmRequest({
          spanId: "fixture-native-success-title-span",
          requestId: titleRequestId,
          model: "claude-haiku-4-5-20251001",
          startedAt: "1783843200050000000",
          endedAt: "1783843200100000000",
          inputTokens: 564,
          outputTokens: 15,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        }),
        llmRequest({
          spanId: "fixture-native-success-main-span-one",
          requestId: mainRequestOneId,
          model: "claude-sonnet-5",
          startedAt: "1783843200110000000",
          endedAt: "1783843200200000000",
          inputTokens: 2,
          outputTokens: 127,
          cacheReadTokens: 6_263,
          cacheCreationTokens: 5_731
        }),
        llmRequest({
          spanId: "fixture-native-success-main-span-two",
          requestId: mainRequestTwoId,
          model: "claude-sonnet-5",
          startedAt: "1783843200210000000",
          endedAt: "1783843200300000000",
          inputTokens: 2,
          outputTokens: 19,
          cacheReadTokens: 11_994,
          cacheCreationTokens: 223
        })
      ] }]
    }]
  },
  expectedMainUsage: {
    inputTokens: 4,
    outputTokens: 146,
    cacheReadInputTokens: 18_257,
    cacheCreationInputTokens: 5_954,
    providerReportedNanoUsd: 43_403_100
  },
  syntheticIdentifiers: [
    promptId,
    sessionId,
    traceId,
    rootSpanId,
    titleRequestId,
    mainRequestOneId,
    mainRequestTwoId,
    "fixture-native-success-title-span",
    "fixture-native-success-main-span-one",
    "fixture-native-success-main-span-two"
  ]
} as const;
