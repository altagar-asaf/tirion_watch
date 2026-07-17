import type { RunCompletionFailureCategory } from "@tirion/agent-contract";

/**
 * Synthetic metadata-only replay derived from the privacy-safe Claude Code
 * 2.1.201 StopFailure census. It intentionally contains no prompt, response,
 * error detail, tool payload, transcript locator, workspace path, or raw ID.
 */
export const claudeCodeNativeStopFailureV21201 = {
  schemaVersion: 1,
  fixtureId: "claude-code-2.1.201-stop-failure-authentication-v1",
  derivedFrom: "claude-code-2.1.201-native-metadata-census",
  providerVersion: "2.1.201",
  requestedModel: "claude-sonnet-5",
  observedModels: ["claude-sonnet-5", "claude-haiku-4-5-20251001"],
  promptObservedAt: "2026-07-12T06:00:00.000Z",
  failureObservedAt: "2026-07-12T06:00:01.000Z",
  promptHook: {
    hook_event_name: "UserPromptSubmit",
    session_id: "fixture-claude-stop-failure-session",
    prompt_id: "fixture-claude-stop-failure-prompt"
  },
  stopFailureHook: {
    hook_event_name: "StopFailure",
    session_id: "fixture-claude-stop-failure-session",
    prompt_id: "fixture-claude-stop-failure-prompt",
    error: "authentication_failed" as RunCompletionFailureCategory
  },
  failedLlmTraceEnvelope: {
    resourceSpans: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }]
      },
      scopeSpans: [{
        spans: [{
          traceId: "fixture-claude-stop-failure-trace",
          spanId: "fixture-claude-stop-failure-main-request",
          name: "claude_code.llm_request",
          startTimeUnixNano: "1783836000100000000",
          endTimeUnixNano: "1783836000200000000",
          attributes: [
            { key: "prompt.id", value: { stringValue: "fixture-claude-stop-failure-prompt" } },
            { key: "session.id", value: { stringValue: "fixture-claude-stop-failure-session" } },
            { key: "request.id", value: { stringValue: "fixture-claude-stop-failure-main-request" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-5" } },
            { key: "success", value: { boolValue: false } },
            { key: "status_code", value: { intValue: "401" } }
          ]
        }, {
          traceId: "fixture-claude-stop-failure-trace",
          spanId: "fixture-claude-stop-failure-title-request",
          name: "claude_code.llm_request",
          startTimeUnixNano: "1783836000300000000",
          endTimeUnixNano: "1783836000400000000",
          attributes: [
            { key: "prompt.id", value: { stringValue: "fixture-claude-stop-failure-prompt" } },
            { key: "session.id", value: { stringValue: "fixture-claude-stop-failure-session" } },
            { key: "request.id", value: { stringValue: "fixture-claude-stop-failure-title-request" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-haiku-4-5-20251001" } },
            { key: "operation.name", value: { stringValue: "generate_session_title" } },
            { key: "success", value: { boolValue: false } },
            { key: "status_code", value: { intValue: "401" } }
          ]
        }]
      }]
    }]
  },
  nativeEvidence: {
    userPromptSubmitHookCount: 1,
    stopFailureHookCount: 1,
    stopHookCount: 0,
    failedLlmRequestCount: 2,
    failedLlmRequestStatusCodes: [401, 401],
    auxiliaryRequestPurpose: "generate_session_title",
    closedInteractionCount: 1,
    apiErrorLogCount: 2,
    safeRecordCount: 20,
    cliExit: "nonzero" as const
  },
  expected: {
    completionEvidence: "stop_hook" as const,
    completionOutcome: "failure" as const,
    completionFailureCategory: "authentication_failed" as RunCompletionFailureCategory
  }
} as const;
