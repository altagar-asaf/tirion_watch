// Synthetic metadata-only fixture derived from the privacy-safe Claude Code 2.1.207
// blocked-Stop census. No captured content, paths, account data, or observed raw
// identifiers are included.

const textAttribute = (key: string, value: string) => ({ key, value: { stringValue: value } });

const sessionId = "fixture-blocked-stop-session";
const promptId = "fixture-blocked-stop-prompt";
const traceId = "fixture-blocked-stop-trace";
const rootSpanId = "fixture-blocked-stop-root-span";

export const claudeCodeNativeBlockedStopV21207 = {
  fixtureId: "claude-code-native-blocked-stop-v2.1.207",
  providerVersion: "2.1.207",
  promptObservedAt: "2026-07-12T09:54:55.480Z",
  firstStopObservedAt: "2026-07-12T09:54:57.633Z",
  finalStopObservedAt: "2026-07-12T09:54:59.428Z",
  interactionCompletedAt: "2026-07-12T09:54:59.430Z",
  promptHook: {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt_id: promptId
  },
  promptLogEnvelope: {
    resourceLogs: [{
      resource: {
        attributes: [
          textAttribute("service.name", "claude-code"),
          textAttribute("service.version", "2.1.207")
        ]
      },
      scopeLogs: [{ logRecords: [{
        traceId,
        spanId: rootSpanId,
        timeUnixNano: "1783850095503000000",
        attributes: [
          textAttribute("event.name", "user_prompt"),
          textAttribute("prompt.id", promptId)
        ]
      }] }]
    }]
  },
  firstStopHook: {
    hook_event_name: "Stop",
    session_id: sessionId,
    prompt_id: promptId,
    stop_hook_active: false,
    background_tasks: [],
    session_crons: []
  },
  finalStopHook: {
    hook_event_name: "Stop",
    session_id: sessionId,
    prompt_id: promptId,
    stop_hook_active: true,
    background_tasks: [],
    session_crons: []
  },
  closedInteractionTraceEnvelope: {
    resourceSpans: [{
      resource: {
        attributes: [
          textAttribute("service.name", "claude-code"),
          textAttribute("service.version", "2.1.207")
        ]
      },
      scopeSpans: [{ spans: [{
        traceId,
        spanId: rootSpanId,
        name: "claude_code.interaction",
        startTimeUnixNano: "1783850095480000000",
        endTimeUnixNano: "1783850099430000000",
        status: { code: 1 },
        attributes: [
          textAttribute("span.type", "interaction"),
          { key: "interaction.sequence", value: { intValue: "1" } }
        ]
      }] }]
    }]
  },
  syntheticIdentifiers: [sessionId, promptId, traceId, rootSpanId]
} as const;
