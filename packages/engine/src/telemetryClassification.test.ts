import { describe, expect, it } from "vitest";
import { claudeCodeNativeBlockedStopV21207 } from "../../../test-fixtures/claudeCodeNativeBlockedStopV21207";
import { claudeCodeNativeSuccessfulV21207 } from "../../../test-fixtures/claudeCodeNativeSuccessfulV21207";
import { claudeCodeNativeStopFailureV21201 } from "../../../test-fixtures/claudeCodeNativeStopFailure";
import {
  canonicalSensitiveAuditKind,
  DefaultAgentPrivacyGuard,
  DefaultTelemetryClassification,
  OTLP_MAX_RECORDS,
  type ClaudeTranscriptTailInput,
  displayLabelForSensitiveAuditKind,
  safeObservationFrom,
  sourceCapabilityForObservation
} from "./telemetryClassification";

function otlpNano(iso: string): string {
  return `${BigInt(Date.parse(iso)) * 1_000_000n}`;
}

function claudeAgentToolTraceEnvelope(input: {
  traceId: string;
  spanId: string;
  toolUseId: string;
  promptId: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeSpans: [{ spans: [{
        traceId: input.traceId,
        spanId: input.spanId,
        name: "claude_code.tool",
        startTimeUnixNano: otlpNano("2026-06-08T00:00:01.000Z"),
        endTimeUnixNano: otlpNano("2026-06-08T00:00:01.050Z"),
        attributes: [
          { key: "prompt.id", value: { stringValue: input.promptId } },
          { key: "session.id", value: { stringValue: input.sessionId } },
          { key: "tool_name", value: { stringValue: "Agent" } },
          { key: "tool_use_id", value: { stringValue: input.toolUseId } },
          { key: "subagent_type", value: { stringValue: "Explore" } }
        ]
      }] }]
    }]
  };
}

function claudeChildUsageTraceEnvelope(input: {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  requestId: string;
  sessionId?: string;
}): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeSpans: [{ spans: [{
        traceId: input.traceId,
        spanId: input.spanId,
        parentSpanId: input.parentSpanId,
        name: "claude_code.llm_request",
        startTimeUnixNano: otlpNano("2026-06-08T00:00:02.000Z"),
        endTimeUnixNano: otlpNano("2026-06-08T00:00:03.000Z"),
        attributes: [
          { key: "request_id", value: { stringValue: input.requestId } },
          ...(input.sessionId
            ? [{ key: "session.id", value: { stringValue: input.sessionId } }]
            : []),
          { key: "agent_id", value: { stringValue: "PRIVATE_CROSS_ENVELOPE_AGENT_ID" } },
          { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-5" } },
          { key: "input_tokens", value: { intValue: "30" } },
          { key: "output_tokens", value: { intValue: "5" } },
          { key: "success", value: { boolValue: true } }
        ]
      }] }]
    }]
  };
}

function claudePromptLogEnvelope(input: {
  sessionId: string;
  promptId: string;
  traceId: string;
  at: string;
}): Record<string, unknown> {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeLogs: [{ logRecords: [{
        traceId: input.traceId,
        spanId: `${input.traceId}-root`,
        timeUnixNano: otlpNano(input.at),
        attributes: [
          { key: "event.name", value: { stringValue: "user_prompt" } },
          { key: "prompt.id", value: { stringValue: input.promptId } },
          { key: "session.id", value: { stringValue: input.sessionId } }
        ]
      }] }]
    }]
  };
}

function claudeClosedInteractionTraceEnvelope(input: {
  traceId: string;
  startedAt: string;
  completedAt: string;
}): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeSpans: [{ spans: [{
        traceId: input.traceId,
        spanId: `${input.traceId}-root`,
        name: "claude_code.interaction",
        startTimeUnixNano: otlpNano(input.startedAt),
        endTimeUnixNano: otlpNano(input.completedAt),
        status: { code: 1 },
        attributes: [{ key: "span.type", value: { stringValue: "interaction" } }]
      }] }]
    }]
  };
}

function sanitizeClaudeOccurrences(
  guard: DefaultAgentPrivacyGuard,
  raw: Record<string, unknown>,
  signal: "logs" | "traces",
  observedAt: string
) {
  const metadata = guard.sanitizeOtlpEnvelope(raw, signal, observedAt);
  return guard.sanitizeQueryOccurrences(
    raw,
    signal,
    new DefaultTelemetryClassification().classify(metadata),
    metadata.observedAt
  );
}

function claudeTranscriptUserRecord(input: {
  sessionId: string;
  promptId: string;
  timestamp: string;
  originKind: "human" | "task-notification";
  promptSource: "typed" | "system";
  content?: string;
}): Record<string, unknown> {
  return {
    type: "user",
    sessionId: input.sessionId,
    uuid: input.promptId,
    timestamp: input.timestamp,
    origin: { kind: input.originKind },
    promptSource: input.promptSource,
    message: {
      role: "user",
      content: input.content ?? "PRIVATE_TRANSCRIPT_CONTENT_CANARY"
    }
  };
}

function availableClaudeTranscriptTail(...records: Record<string, unknown>[]) {
  return {
    state: "available" as const,
    tail: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    truncated: false
  };
}

describe("first-heartbeat privacy and classification", () => {
  it("classifies Claude Code while discarding content", () => {
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeSpans: [{ spans: [{ name: "turn", attributes: [{ key: "prompt", value: { stringValue: "secret text" } }] }] }]
      }]
    };
    const metadata = new DefaultAgentPrivacyGuard().sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:00.000Z");
    expect(JSON.stringify(metadata)).not.toContain("secret text");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    metadata.usageAtoms = new DefaultAgentPrivacyGuard().sanitizeUsageAtoms(raw, "traces", classification, metadata.observedAt);
    const observation = safeObservationFrom(metadata, classification, "obs_test_12345678");
    expect(observation).toMatchObject({ provider: "claude-code", recordCount: 1 });
    expect(sourceCapabilityForObservation(observation, "environment_12345678")).toMatchObject({
      evidenceGrade: "estimated_usage_cost_unattributed"
    });
  });

  it("keeps only hashed correlation and allowlisted usage atoms", () => {
    const traceId = "sensitive-provider-trace-id";
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId,
          spanId: "span-sensitive",
          name: "codex.turn",
          startTimeUnixNano: "1780876800000000000",
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } },
            { key: "prompt", value: { stringValue: "private prompt" } }
          ]
        }] }]
      }]
    };
    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:00.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    metadata.usageAtoms = guard.sanitizeUsageAtoms(raw, "traces", classification, metadata.observedAt);
    const serialized = JSON.stringify(metadata.usageAtoms);
    expect(metadata.usageAtoms[0]).toMatchObject({
      authority: "turn",
      inputTokens: 12,
      outputTokens: 5,
      model: "gpt-5.4",
      modelProvider: "openai",
      modelProviderBasis: "model_name_rule",
      endedAt: undefined
    });
    expect(serialized).not.toContain(traceId);
    expect(serialized).not.toContain("private prompt");
  });

  it("prefers supported explicit model-provider telemetry", () => {
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "copilot-chat" } }] },
        scopeSpans: [{ spans: [{
          traceId: "provider-trace",
          spanId: "provider-span",
          name: "invoke_agent",
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4.6" } },
            { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } }
          ]
        }] }]
      }]
    };
    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:00.000Z");
    metadata.usageAtoms = guard.sanitizeUsageAtoms(raw, "traces", new DefaultTelemetryClassification().classify(metadata), metadata.observedAt);
    expect(metadata.usageAtoms[0]).toMatchObject({
      provider: "github-copilot",
      modelProvider: "anthropic",
      modelProviderBasis: "telemetry_reported"
    });
  });

  it("namespaces identical provider correlation values", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const atoms = ["claude-code", "codex"].map((serviceName) => {
      const raw = {
        resourceSpans: [{
          resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
          scopeSpans: [{ spans: [{
            traceId: "same-provider-trace",
            spanId: `${serviceName}-span`,
            name: serviceName === "codex" ? "codex.turn" : "claude.request",
            attributes: [
              { key: "gen_ai.usage.input_tokens", value: { intValue: "1" } },
              ...(serviceName === "claude-code" ? [
                { key: "prompt.id", value: { stringValue: "prompt-1" } },
                { key: "session.id", value: { stringValue: "session-1" } }
              ] : [])
            ]
          }] }]
        }]
      };
      const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:00.000Z");
      return guard.sanitizeUsageAtoms(raw, "traces", new DefaultTelemetryClassification().classify(metadata), metadata.observedAt)[0];
    });
    expect(atoms[0].correlationId).not.toBe(atoms[1].correlationId);
  });

  it("fails closed for unknown producers", () => {
    const metadata = new DefaultAgentPrivacyGuard().sanitizeOtlpEnvelope({ resourceSpans: [] }, "traces", "2026-06-08T00:00:00.000Z");
    expect(() => new DefaultTelemetryClassification().classify(metadata)).toThrow("unsupported_source");
  });

  it("rejects record fan-out beyond the privacy-safe ingress limit", () => {
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: Array.from({ length: OTLP_MAX_RECORDS + 1 }, () => ({})) }]
      }]
    };
    expect(() => new DefaultAgentPrivacyGuard().sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:00.000Z"))
      .toThrow("payload_too_large");
  });

  it("marks completed spans and usage log events without inventing an end time", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const span = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "trace-completed",
          spanId: "span-completed",
          name: "codex.turn",
          startTimeUnixNano: "1780876800000000000",
          endTimeUnixNano: "1780876801000000000",
          attributes: [
            { key: "gen_ai.usage.input_tokens", value: { intValue: "1" } },
            { key: "auth_mode", value: { stringValue: "api-key" } }
          ]
        }] }]
      }]
    };
    const spanMetadata = guard.sanitizeOtlpEnvelope(span, "traces", "2026-06-08T00:00:00.000Z");
    expect(guard.sanitizeUsageAtoms(span, "traces", new DefaultTelemetryClassification().classify(spanMetadata), spanMetadata.observedAt)[0])
      .toMatchObject({
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:01.000Z",
        billingContext: "openai-direct"
      });

    const log = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          traceId: "log-completed",
          timeUnixNano: "1780876802000000000",
          attributes: [
            { key: "prompt.id", value: { stringValue: "prompt-1" } },
            { key: "session.id", value: { stringValue: "session-1" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "1" } }
          ]
        }] }]
      }]
    };
    const logMetadata = guard.sanitizeOtlpEnvelope(log, "logs", "2026-06-08T00:00:00.000Z");
    expect(guard.sanitizeUsageAtoms(log, "logs", new DefaultTelemetryClassification().classify(logMetadata), logMetadata.observedAt)[0])
      .toMatchObject({
        startedAt: "2026-06-08T00:00:02.000Z",
        endedAt: "2026-06-08T00:00:02.000Z",
        completionMode: "inactivity",
        billingContext: "unknown"
      });
  });

  it("projects provider-specific prompt, session, and request identities without retaining raw IDs", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const claude = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1780876799000000000",
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.user_prompt" } },
            { key: "prompt.id", value: { stringValue: "claude-prompt" } },
            { key: "session.id", value: { stringValue: "claude-session" } }
          ]
        }, ...["request-1", "request-2"].map((requestId, index) => ({
          timeUnixNano: `178087680${index}000000000`,
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.api_request" } },
            { key: "prompt.id", value: { stringValue: "claude-prompt" } },
            { key: "session.id", value: { stringValue: "claude-session" } },
            { key: "request.id", value: { stringValue: requestId } },
            { key: "model", value: { stringValue: "claude-sonnet-4.6" } },
            { key: "input_tokens", value: { intValue: "10" } },
            { key: "output_tokens", value: { intValue: "2" } },
            { key: "cost_usd", value: { doubleValue: 0.001 } }
          ]
        }))] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(claude, "logs", "2026-06-08T00:00:00.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const occurrences = guard.sanitizeQueryOccurrences(claude, "logs", classification, metadata.observedAt);
    const atoms = guard.sanitizeUsageAtoms(
      claude,
      "logs",
      classification,
      metadata.observedAt
    );
    expect(occurrences).toEqual([
      expect.objectContaining({
        provider: "claude-code",
        promptState: "disabled",
        evidence: "provider_prompt_id"
      })
    ]);
    expect(new Set(atoms.map((atom) => atom.queryId)).size).toBe(1);
    expect(new Set(atoms.map((atom) => atom.sessionId)).size).toBe(1);
    expect(new Set(atoms.map((atom) => atom.requestId)).size).toBe(2);
    const usageAtom = atoms[0];
    expect(usageAtom).toMatchObject({
      correlationId: usageAtom.queryId,
      completionMode: "inactivity",
      providerReportedNanoUsd: 1_000_000
    });
    expect(JSON.stringify(atoms)).not.toContain("claude-prompt");
    expect(JSON.stringify(atoms)).not.toContain("claude-session");
    expect(JSON.stringify(atoms)).not.toContain("request-1");

    const codex = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "codex-trace",
          spanId: "codex-turn-span",
          name: "codex.turn",
          attributes: [
            { key: "thread.id", value: { stringValue: "codex-thread" } },
            { key: "turn.id", value: { stringValue: "codex-turn" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "3" } }
          ]
        }] }]
      }]
    };
    const codexMetadata = guard.sanitizeOtlpEnvelope(codex, "traces", "2026-06-08T00:00:00.000Z");
    const codexAtom = guard.sanitizeUsageAtoms(
      codex,
      "traces",
      new DefaultTelemetryClassification().classify(codexMetadata),
      codexMetadata.observedAt
    )[0];
    expect(codexAtom.queryId).not.toBe(codexAtom.sessionId);

  });

  it("treats Claude traces as a distinct reasoning-capable source surface", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeSpans: [{ spans: [{
          traceId: "claude-trace",
          spanId: "claude-request-span",
          name: "claude.request",
          startTimeUnixNano: "1780876800000000000",
          endTimeUnixNano: "1780876801000000000",
          attributes: [
            { key: "prompt.id", value: { stringValue: "claude-prompt" } },
            { key: "session.id", value: { stringValue: "claude-session" } },
            { key: "request.id", value: { stringValue: "claude-request" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4.6" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "20" } },
            { key: "gen_ai.usage.reasoning.output_tokens", value: { intValue: "45" } },
            { key: "cost_usd", value: { doubleValue: 0.001 } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:02.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    metadata.usageAtoms = guard.sanitizeUsageAtoms(raw, "traces", classification, metadata.observedAt);
    const observation = safeObservationFrom(metadata, classification, "obs_claude_trace_reasoning");

    expect(classification).toMatchObject({
      provider: "claude-code",
      profileVersion: "claude-code-enhanced-traces-beta-v1",
      sourceId: "otlp_claude_code_traces"
    });
    expect(metadata.usageAtoms).toEqual([expect.objectContaining({
      signal: "traces",
      sourceId: "otlp_claude_code_traces",
      profileVersion: "claude-code-enhanced-traces-beta-v1",
      inputTokens: 100,
      outputTokens: 20,
      reasoningOutputTokens: 45
    })]);
    expect(sourceCapabilityForObservation(observation, "environment_12345678")).toMatchObject({
      sourceId: "otlp_claude_code_traces",
      granularity: ["request"],
      tokenDimensions: ["input", "output", "cache_read_input", "cache_creation_input", "reasoning_output", "total"]
    });
  });

  it("treats Copilot traces as a distinct reasoning-capable source surface", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "github-copilot" } }] },
        scopeSpans: [{ spans: [{
          traceId: "copilot-trace",
          spanId: "copilot-run-span",
          name: "invoke_agent",
          startTimeUnixNano: "1780876800000000000",
          endTimeUnixNano: "1780876801000000000",
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "20" } },
            { key: "gen_ai.usage.reasoning.output_tokens", value: { intValue: "45" } },
            { key: "gen_ai.usage.cache_creation.input_tokens", value: { intValue: "12" } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:02.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    metadata.usageAtoms = guard.sanitizeUsageAtoms(raw, "traces", classification, metadata.observedAt);
    const observation = safeObservationFrom(metadata, classification, "obs_copilot_trace_reasoning");

    expect(classification).toMatchObject({
      provider: "github-copilot",
      profileVersion: "copilot-otlp-traces-v1",
      sourceId: "otlp_github_copilot_traces"
    });
    expect(metadata.usageAtoms).toEqual([expect.objectContaining({
      signal: "traces",
      sourceId: "otlp_github_copilot_traces",
      profileVersion: "copilot-otlp-traces-v1",
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 12,
      reasoningOutputTokens: 45
    })]);
    expect(sourceCapabilityForObservation(observation, "environment_12345678")).toMatchObject({
      sourceId: "otlp_github_copilot_traces",
      granularity: ["run", "turn"],
      tokenDimensions: ["input", "output", "cache_read_input", "cache_creation_input", "reasoning_output", "total"]
    });
  });

  it("uses Copilot invoke-agent root spans as prompt-free run starts", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "copilot-chat" } }] },
        scopeSpans: [{ spans: [{
          traceId: "copilot-root-trace",
          spanId: "copilot-root-span",
          name: "invoke_agent",
          startTimeUnixNano: "1780876800000000000",
          attributes: [
            { key: "copilot_chat.session_id", value: { stringValue: "copilot-session" } },
            { key: "gen_ai.input.messages", value: { stringValue: "[{\"content\":\"private prompt\"}]" } },
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:02.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const occurrences = guard.sanitizeQueryOccurrences(raw, "traces", classification, metadata.observedAt);

    expect(occurrences).toEqual([expect.objectContaining({
      provider: "github-copilot",
      runtime: "github-copilot",
      promptState: "disabled",
      evidence: "provider_root_span",
      startedAt: "2026-06-08T00:00:00.000Z"
    })]);
    expect(occurrences[0].queryId).toMatch(/^qry_/);
    expect(occurrences[0].sessionId).toMatch(/^ses_/);
    expect(JSON.stringify(occurrences)).not.toContain("private prompt");
    expect(JSON.stringify(occurrences)).not.toContain("copilot-root-trace");
    expect(JSON.stringify(occurrences)).not.toContain("copilot-session");
  });

  it("segments Codex log usage by user prompt and retains every completed model response", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-conversation" } },
            { key: "auth_mode", value: { stringValue: "Chatgpt" } },
            { key: "model", value: { stringValue: "gpt-5.5" } }
          ]
        }, ...[{
          at: "2026-06-08T00:00:01.000Z",
          input: "100",
          output: "0",
          cached: "0",
          reasoning: "0"
        }, {
          at: "2026-06-08T00:00:02.000Z",
          input: "140",
          output: "5",
          cached: "40",
          reasoning: "35"
        }].map((snapshot) => ({
          attributes: [
            { key: "event.name", value: { stringValue: "codex.sse_event" } },
            { key: "event.kind", value: { stringValue: "response.completed" } },
            { key: "event.timestamp", value: { stringValue: snapshot.at } },
            { key: "conversation.id", value: { stringValue: "codex-conversation" } },
            { key: "auth_mode", value: { stringValue: "ApiKey" } },
            { key: "model", value: { stringValue: "gpt-5.5" } },
            { key: "input_token_count", value: { intValue: snapshot.input } },
            { key: "output_token_count", value: { intValue: snapshot.output } },
            { key: "cached_token_count", value: { intValue: snapshot.cached } },
            { key: "reasoning_token_count", value: { intValue: snapshot.reasoning } }
          ]
        }))] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-06-08T00:00:03.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const occurrences = guard.sanitizeQueryOccurrences(raw, "logs", classification, metadata.observedAt);
    const atoms = guard.sanitizeUsageAtoms(raw, "logs", classification, metadata.observedAt);
    expect(classification.profileVersion).toBe("codex-otel-logs-v1");
    expect(occurrences).toEqual([expect.objectContaining({
      promptState: "disabled",
      evidence: "provider_user_prompt_event",
      startedAt: "2026-06-08T00:00:00.000Z"
    })]);
    expect(atoms).toHaveLength(2);
    expect(atoms[0].atomId).not.toBe(atoms[1].atomId);
    expect(atoms[0].requestId).not.toBe(atoms[1].requestId);
    expect(atoms[1]).toMatchObject({
      queryId: occurrences[0].queryId,
      sessionId: occurrences[0].sessionId,
      authority: "request",
      signal: "logs",
      sourceId: "otlp_codex_logs",
      profileVersion: "codex-otel-logs-v1",
      billingContext: "openai-direct",
      inputTokens: 140,
      outputTokens: 5,
      cacheReadInputTokens: 40,
      reasoningOutputTokens: 35,
      startedAt: "2026-06-08T00:00:02.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    expect(JSON.stringify(atoms)).not.toContain("codex-conversation");
  });

  it("correlates Codex completion logs by turn when conversation identity changes", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const prompt = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-parent-conversation" } },
            { key: "turn.id", value: { stringValue: "codex-turn-1" } }
          ]
        }] }]
      }]
    };
    const completion = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.sse_event" } },
            { key: "event.kind", value: { stringValue: "response.completed" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:04.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-child-conversation" } },
            { key: "turn.id", value: { stringValue: "codex-turn-1" } },
            { key: "input_token_count", value: { intValue: "200" } },
            { key: "output_token_count", value: { intValue: "20" } }
          ]
        }] }]
      }]
    };
    const promptMetadata = guard.sanitizeOtlpEnvelope(prompt, "logs", "2026-06-08T00:00:00.000Z");
    const promptClassification = new DefaultTelemetryClassification().classify(promptMetadata);
    const occurrences = guard.sanitizeQueryOccurrences(prompt, "logs", promptClassification, promptMetadata.observedAt);
    const completionMetadata = guard.sanitizeOtlpEnvelope(completion, "logs", "2026-06-08T00:00:04.000Z");
    const completionClassification = new DefaultTelemetryClassification().classify(completionMetadata);
    const atoms = guard.sanitizeUsageAtoms(completion, "logs", completionClassification, completionMetadata.observedAt);

    expect(atoms).toEqual([expect.objectContaining({
      queryId: occurrences[0].queryId,
      sessionId: occurrences[0].sessionId,
      authority: "request",
      inputTokens: 200,
      outputTokens: 20,
      startedAt: "2026-06-08T00:00:04.000Z",
      endedAt: "2026-06-08T00:00:04.000Z"
    })]);
    expect(JSON.stringify(atoms)).not.toContain("codex-parent-conversation");
    expect(JSON.stringify(atoms)).not.toContain("codex-child-conversation");
    expect(JSON.stringify(atoms)).not.toContain("codex-turn-1");
  });

  it("uses prompt identity for Codex traces while preserving reasoning token coverage", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const prompt = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-conversation" } },
            { key: "turn.id", value: { stringValue: "codex-turn" } }
          ]
        }] }]
      }]
    };
    const promptMetadata = guard.sanitizeOtlpEnvelope(prompt, "logs", "2026-06-08T00:00:00.000Z");
    const promptClassification = new DefaultTelemetryClassification().classify(promptMetadata);
    const occurrences = guard.sanitizeQueryOccurrences(prompt, "logs", promptClassification, promptMetadata.observedAt);

    const trace = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "codex-trace",
          spanId: "codex-turn-span",
          name: "codex.turn",
          startTimeUnixNano: "1780876801000000000",
          endTimeUnixNano: "1780876802000000000",
          attributes: [
            { key: "conversation.id", value: { stringValue: "codex-child-conversation" } },
            { key: "turn.id", value: { stringValue: "codex-turn" } },
            { key: "request.id", value: { stringValue: "codex-request" } },
            { key: "auth_mode", value: { stringValue: "ApiKey" } },
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "30" } },
            { key: "gen_ai.usage.reasoning.output_tokens", value: { intValue: "80" } }
          ]
        }] }]
      }]
    };
    const traceMetadata = guard.sanitizeOtlpEnvelope(trace, "traces", "2026-06-08T00:00:02.000Z");
    const traceClassification = new DefaultTelemetryClassification().classify(traceMetadata);
    traceMetadata.usageAtoms = guard.sanitizeUsageAtoms(trace, "traces", traceClassification, traceMetadata.observedAt);
    const observation = safeObservationFrom(traceMetadata, traceClassification, "obs_codex_trace_reasoning");

    expect(traceMetadata.usageAtoms).toEqual([expect.objectContaining({
      queryId: occurrences[0].queryId,
      sessionId: occurrences[0].sessionId,
      signal: "traces",
      sourceId: "otlp_codex_traces",
      profileVersion: "codex-otel-traces-v1",
      requestId: expect.any(String),
      inputTokens: 120,
      outputTokens: 30,
      reasoningOutputTokens: 80,
      billingContext: "openai-direct"
    })]);
    expect(traceMetadata.usageAtoms[0].requestId).not.toBe(traceMetadata.usageAtoms[0].queryId);
    expect(sourceCapabilityForObservation(observation, "environment_12345678")).toMatchObject({
      sourceId: "otlp_codex_traces",
      profileVersion: "codex-otel-traces-v1",
      tokenDimensions: ["input", "output", "cache_read_input", "cache_creation_input", "reasoning_output", "total"]
    });
  });

  it("reconciles delayed root and child Codex hooks without replacing the active root turn", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const rootSession = "019f4fd6-2481-73e2-b765-bd1b21209467";
    const childSession = "019f4fd6-4d3b-7ca0-b63c-31c75ce51794";
    const rootTurn = "019f4fd6-2caa-7a75-b226-c328794de001";
    const childTurn = "019f4fd6-51ad-7f12-abc6-9fef9b326c62";
    const promptEnvelope = (session: string, at: string) => ({
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: at } },
            { key: "conversation.id", value: { stringValue: session } }
          ]
        }] }]
      }]
    });
    const rootPrompt = promptEnvelope(rootSession, "2026-06-08T00:00:00.000Z");
    const rootMetadata = guard.sanitizeOtlpEnvelope(rootPrompt, "logs", "2026-06-08T00:00:00.000Z");
    const rootClassification = new DefaultTelemetryClassification().classify(rootMetadata);
    const rootOccurrence = guard.sanitizeQueryOccurrences(
      rootPrompt,
      "logs",
      rootClassification,
      rootMetadata.observedAt
    )[0];
    const rootHook = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: rootSession,
      turn_id: rootTurn,
      transcript_path: `/private/session/rollout-2026-06-08T03-00-00-${rootSession}.jsonl`,
      prompt: "private root prompt"
    }, "codex", "2026-06-08T00:00:02.000Z");
    expect(rootHook?.queryOccurrences?.[0]).toMatchObject({
      queryId: rootOccurrence.queryId,
      sessionId: rootOccurrence.sessionId,
      startedAt: rootOccurrence.startedAt,
      evidence: "submission_hook",
      lifecycleVisibility: "customer"
    });

    const childPrompt = promptEnvelope(childSession, "2026-06-08T00:00:03.100Z");
    const childMetadata = guard.sanitizeOtlpEnvelope(childPrompt, "logs", "2026-06-08T00:00:03.100Z");
    const childClassification = new DefaultTelemetryClassification().classify(childMetadata);
    const childOccurrence = guard.sanitizeQueryOccurrences(
      childPrompt,
      "logs",
      childClassification,
      childMetadata.observedAt
    )[0];
    const childHook = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: rootSession,
      turn_id: childTurn,
      transcript_path: `/private/session/rollout-2026-06-08T03-00-03-${childSession}.jsonl`,
      prompt: "private child prompt"
    }, "codex", "2026-06-08T00:00:05.000Z");
    expect(childHook?.queryOccurrences?.[0]).toMatchObject({
      queryId: childOccurrence.queryId,
      sessionId: childOccurrence.sessionId,
      parentSessionId: rootOccurrence.sessionId,
      startedAt: childOccurrence.startedAt,
      evidence: "submission_hook"
    });
    expect(childOccurrence.sessionId).not.toBe(rootOccurrence.sessionId);
    const subagentStart = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStart",
      session_id: rootSession,
      turn_id: childTurn,
      transcript_path: `/private/session/rollout-2026-06-08T03-00-03-${childSession}.jsonl`,
      agent_id: childSession,
      agent_type: "explorer"
    }, "codex", "2026-06-08T00:00:05.100Z");
    expect(subagentStart?.activityAtoms?.[0]).toMatchObject({
      queryId: rootOccurrence.queryId,
      childSessionId: childOccurrence.sessionId
    });

    const childTrace = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "codex-child-trace",
          spanId: "codex-child-turn",
          name: "codex.turn",
          startTimeUnixNano: otlpNano("2026-06-08T00:00:03.100Z"),
          endTimeUnixNano: otlpNano("2026-06-08T00:00:07.000Z"),
          attributes: [
            { key: "conversation.id", value: { stringValue: rootSession } },
            { key: "turn.id", value: { stringValue: childTurn } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "30" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "4" } }
          ]
        }] }]
      }]
    };
    const childTraceMetadata = guard.sanitizeOtlpEnvelope(childTrace, "traces", "2026-06-08T00:00:07.100Z");
    const childTraceClassification = new DefaultTelemetryClassification().classify(childTraceMetadata);
    const childAtoms = guard.sanitizeUsageAtoms(
      childTrace,
      "traces",
      childTraceClassification,
      childTraceMetadata.observedAt
    );
    expect(childAtoms).toEqual([expect.objectContaining({
      queryId: childOccurrence.queryId,
      sessionId: childOccurrence.sessionId,
      authority: "turn",
      completionMode: "explicit"
    })]);

    const rootResponse = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.sse_event" } },
            { key: "event.kind", value: { stringValue: "response.completed" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:08.000Z" } },
            { key: "conversation.id", value: { stringValue: rootSession } },
            { key: "input_token_count", value: { intValue: "80" } },
            { key: "output_token_count", value: { intValue: "8" } }
          ]
        }] }]
      }]
    };
    const rootResponseMetadata = guard.sanitizeOtlpEnvelope(rootResponse, "logs", "2026-06-08T00:00:08.000Z");
    const rootResponseClassification = new DefaultTelemetryClassification().classify(rootResponseMetadata);
    expect(guard.sanitizeUsageAtoms(
      rootResponse,
      "logs",
      rootResponseClassification,
      rootResponseMetadata.observedAt
    )).toEqual([expect.objectContaining({
      queryId: rootOccurrence.queryId,
      sessionId: rootOccurrence.sessionId,
      authority: "request"
    })]);
    expect(JSON.stringify([rootHook, childHook, childAtoms])).not.toContain("/private/session");
    expect(JSON.stringify([rootHook, childHook])).not.toContain("private root prompt");
    expect(JSON.stringify([rootHook, childHook])).not.toContain("private child prompt");
  });

  it("does not expose Codex implementation spans as LLM or tool activity", () => {
    const guard = new DefaultAgentPrivacyGuard();
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-internal-session",
      turn_id: "codex-internal-turn",
      transcript_path: "/private/session/codex-internal-session.jsonl"
    }, "codex", "2026-06-08T00:00:00.000Z")).toBeDefined();
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "codex-internal-trace",
          spanId: "turn",
          name: "codex.turn",
          startTimeUnixNano: otlpNano("2026-06-08T00:00:00.000Z"),
          endTimeUnixNano: otlpNano("2026-06-08T00:00:02.000Z"),
          attributes: [
            { key: "conversation.id", value: { stringValue: "codex-internal-session" } },
            { key: "turn.id", value: { stringValue: "codex-internal-turn" } },
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.5" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "20" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "3" } }
          ]
        }, {
          traceId: "codex-internal-trace",
          spanId: "startup",
          parentSpanId: "turn",
          name: "codex.startup_phase",
          startTimeUnixNano: otlpNano("2026-06-08T00:00:00.050Z"),
          endTimeUnixNano: otlpNano("2026-06-08T00:00:00.075Z"),
          attributes: [
            { key: "conversation.id", value: { stringValue: "codex-internal-session" } },
            { key: "turn.id", value: { stringValue: "codex-internal-turn" } },
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.5" } }
          ]
        }, {
          traceId: "codex-internal-trace",
          spanId: "persist",
          parentSpanId: "turn",
          name: "persist_rollout_items",
          startTimeUnixNano: otlpNano("2026-06-08T00:00:00.100Z"),
          endTimeUnixNano: otlpNano("2026-06-08T00:00:00.200Z"),
          attributes: [
            { key: "conversation.id", value: { stringValue: "codex-internal-session" } },
            { key: "turn.id", value: { stringValue: "codex-internal-turn" } }
          ]
        }, {
          traceId: "codex-internal-trace",
          spanId: "dispatch",
          parentSpanId: "turn",
          name: "dispatch_tool_call_with_terminal_outcome",
          startTimeUnixNano: otlpNano("2026-06-08T00:00:00.300Z"),
          endTimeUnixNano: otlpNano("2026-06-08T00:00:00.400Z"),
          attributes: [
            { key: "conversation.id", value: { stringValue: "codex-internal-session" } },
            { key: "turn.id", value: { stringValue: "codex-internal-turn" } },
            { key: "gen_ai.tool.name", value: { stringValue: "exec_command" } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:02.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);

    expect(guard.sanitizeActivityAtoms(raw, "traces", classification, metadata.observedAt)).toEqual([]);
    expect(guard.sanitizeExecutionNodes(raw, "traces", classification, metadata.observedAt)).toEqual([]);
    expect(guard.sanitizeUsageAtoms(raw, "traces", classification, metadata.observedAt)).toEqual([
      expect.objectContaining({
        authority: "turn",
        model: "gpt-5.5",
        inputTokens: 20,
        outputTokens: 3
      })
    ]);
  });

  it("marks transcriptless Codex work internal and cannot promote it through a later Stop hook", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const fallbackPrompt = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-ephemeral-session" } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(fallbackPrompt, "logs", "2026-06-08T00:00:00.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const fallbackOccurrence = guard.sanitizeQueryOccurrences(
      fallbackPrompt,
      "logs",
      classification,
      metadata.observedAt
    )[0];
    const marker = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-ephemeral-session",
      turn_id: "codex-ephemeral-turn",
      transcript_path: null
    }, "codex", "2026-06-08T00:00:01.000Z");
    expect(marker).toMatchObject({
      sourceId: "hook_codex_internal",
      queryOccurrences: [{
        queryId: fallbackOccurrence.queryId,
        sessionId: fallbackOccurrence.sessionId,
        lifecycleVisibility: "internal"
      }],
      usageAtoms: []
    });
    expect(marker?.executionNodes).toBeUndefined();
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: "codex-ephemeral-session",
      turn_id: "codex-ephemeral-turn",
      transcript_path: null
    }, "codex", "2026-06-08T00:00:02.000Z")).toBeUndefined();
    expect(JSON.stringify(marker)).not.toContain("codex-ephemeral-session");
    expect(JSON.stringify(marker)).not.toContain("codex-ephemeral-turn");
  });

  it("captures only exact initiating prompt events and honors the disabled policy", () => {
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-conversation" } },
            { key: "prompt", value: { stringValue: "Fix the query association" } }
          ]
        }, {
          traceId: "unrelated-trace",
          attributes: [
            { key: "event.name", value: { stringValue: "codex.tool_user_prompt_dump" } },
            { key: "conversation.id", value: { stringValue: "codex-conversation" } },
            { key: "content", value: { stringValue: "must never be captured" } }
          ]
        }] }]
      }]
    };
    const enabled = new DefaultAgentPrivacyGuard();
    const metadata = enabled.sanitizeOtlpEnvelope(raw, "logs", "2026-06-08T00:00:01.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    expect(enabled.sanitizeQueryOccurrences(raw, "logs", classification, metadata.observedAt)).toEqual([
      expect.objectContaining({
        promptState: "disabled",
        evidence: "provider_user_prompt_event"
      })
    ]);

    const disabled = new DefaultAgentPrivacyGuard(() => false);
    expect(disabled.sanitizeQueryOccurrences(raw, "logs", classification, metadata.observedAt)).toEqual([
      expect.objectContaining({
        promptState: "disabled"
      })
    ]);
    expect(JSON.stringify(disabled.sanitizeQueryOccurrences(raw, "logs", classification, metadata.observedAt)))
      .not.toContain("Fix the query association");
  });

  it("associates provider-specific prompt occurrences with their broader sessions", () => {
    const examples = [{
      provider: "claude-code",
      service: "claude-code",
      event: "user_prompt",
      identity: [
        { key: "prompt.id", value: { stringValue: "claude-prompt" } },
        { key: "session.id", value: { stringValue: "claude-session" } }
      ],
      evidence: "provider_prompt_id"
    }, {
      provider: "github-copilot",
      service: "github-copilot",
      event: "user_message",
      traceId: "copilot-prompt-trace",
      identity: [{ key: "copilot_chat.session_id", value: { stringValue: "copilot-session" } }],
      evidence: "provider_user_message_event"
    }] as const;
    for (const example of examples) {
      const raw = {
        resourceLogs: [{
          resource: { attributes: [{ key: "service.name", value: { stringValue: example.service } }] },
          scopeLogs: [{ logRecords: [{
            traceId: "traceId" in example ? example.traceId : undefined,
            attributes: [
              { key: "event.name", value: { stringValue: example.event } },
              { key: "prompt", value: { stringValue: `${example.provider} prompt` } },
              ...example.identity
            ]
          }] }]
        }]
      };
      const guard = new DefaultAgentPrivacyGuard();
      const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-06-08T00:00:00.000Z");
      const occurrences = guard.sanitizeQueryOccurrences(
        raw,
        "logs",
        new DefaultTelemetryClassification().classify(metadata),
        metadata.observedAt
      );
      expect(occurrences).toEqual([expect.objectContaining({
        provider: example.provider,
        promptState: "disabled",
        evidence: example.evidence
      })]);
      expect(occurrences[0].queryId).not.toBe(occurrences[0].sessionId);
    }
  });

  it("attaches activity metadata to sensitive audit evidence", () => {
    const guard = new DefaultAgentPrivacyGuard(() => true, () => true);
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1780876800000000000",
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_result" } },
            { key: "prompt.id", value: { stringValue: "claude-prompt" } },
            { key: "session.id", value: { stringValue: "claude-session" } },
            { key: "tool_name", value: { stringValue: "Read" } },
            { key: "tool_input", value: { stringValue: "{\"file_path\":\"README.md\"}" } }
          ]
        }] }]
      }]
    };

    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-06-08T00:00:00.000Z");
    const activities = guard.sanitizeActivityAtoms(
      raw,
      "logs",
      new DefaultTelemetryClassification().classify(metadata),
      metadata.observedAt
    );

    expect(activities[0]?.sensitiveAuditEvidence).toEqual([
      expect.objectContaining({
        kind: "tool_arguments",
        activityKind: "tool",
        activityName: "Read"
      })
    ]);
  });

  it("extracts Claude Code Skill tool parameters as skill activity", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: otlpNano("2026-06-08T00:00:01.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_result" } },
            { key: "prompt.id", value: { stringValue: "claude-skill-prompt" } },
            { key: "session.id", value: { stringValue: "claude-skill-session" } },
            { key: "tool_name", value: { stringValue: "Skill" } },
            { key: "tool_parameters", value: { stringValue: "{\"skill_name\":\"tirion-claude-stress-skill\"}" } },
            { key: "success", value: { stringValue: "true" } }
          ]
        }] }]
      }]
    };

    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-06-08T00:00:01.000Z");
    const activities = guard.sanitizeActivityAtoms(
      raw,
      "logs",
      new DefaultTelemetryClassification().classify(metadata),
      metadata.observedAt
    );

    expect(activities).toEqual([
      expect.objectContaining({
        provider: "claude-code",
        kind: "skill",
        name: "tirion-claude-stress-skill",
        outcome: "success",
        startedAt: "2026-06-08T00:00:01.000Z"
      })
    ]);
    expect(activities[0]?.name).not.toBe("Skill");
  });

  it("classifies bounded Claude MCP identities without retaining tool arguments", () => {
    const argumentCanary = "CC18_MCP_ARGUMENT_CANARY";
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: otlpNano("2026-07-15T00:00:01.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_result" } },
            { key: "prompt.id", value: { stringValue: "claude-mcp-prompt" } },
            { key: "session.id", value: { stringValue: "claude-mcp-session" } },
            { key: "tool_name", value: { stringValue: "mcp__tirion_cc18_local__tirion_cc18_readonly_success" } },
            { key: "tool_use_id", value: { stringValue: "claude-mcp-success-tool-use" } },
            { key: "tool_parameters", value: { stringValue: `{\"arguments\":{\"ignored\":\"${argumentCanary}\"}}` } },
            { key: "success", value: { boolValue: true } }
          ]
        }, {
          timeUnixNano: otlpNano("2026-07-15T00:00:02.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_result" } },
            { key: "prompt.id", value: { stringValue: "claude-mcp-prompt" } },
            { key: "session.id", value: { stringValue: "claude-mcp-session" } },
            { key: "tool_name", value: { stringValue: "MCP" } },
            { key: "tool_use_id", value: { stringValue: "claude-mcp-failure-tool-use" } },
            { key: "mcp_server.name", value: { stringValue: "tirion_cc18_local" } },
            { key: "mcp_tool.name", value: { stringValue: "tirion_cc18_controlled_failure" } },
            { key: "success", value: { boolValue: false } }
          ]
        }] }]
      }]
    };

    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-07-15T00:00:02.000Z");
    const activities = guard.sanitizeActivityAtoms(
      raw,
      "logs",
      new DefaultTelemetryClassification().classify(metadata),
      metadata.observedAt
    );

    expect(activities.map((activity) => ({ kind: activity.kind, name: activity.name, outcome: activity.outcome }))).toEqual([
      { kind: "mcp", name: "tirion_cc18_local/tirion_cc18_readonly_success", outcome: "success" },
      { kind: "mcp", name: "tirion_cc18_local/tirion_cc18_controlled_failure", outcome: "failure" }
    ]);
    expect(JSON.stringify(activities)).not.toContain(argumentCanary);
  });

  it("does not promote conflicting Claude MCP metadata", () => {
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: otlpNano("2026-07-15T00:00:01.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_result" } },
            { key: "prompt.id", value: { stringValue: "claude-mcp-conflict-prompt" } },
            { key: "session.id", value: { stringValue: "claude-mcp-conflict-session" } },
            { key: "tool_name", value: { stringValue: "mcp__tirion_cc18_local__tirion_cc18_readonly_success" } },
            { key: "mcp_server.name", value: { stringValue: "other_server" } },
            { key: "success", value: { boolValue: true } }
          ]
        }] }]
      }]
    };

    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-07-15T00:00:01.000Z");
    const [activity] = guard.sanitizeActivityAtoms(
      raw,
      "logs",
      new DefaultTelemetryClassification().classify(metadata),
      metadata.observedAt
    );

    expect(activity).toEqual(expect.objectContaining({
      kind: "tool",
      name: "mcp__tirion_cc18_local__tirion_cc18_readonly_success",
      outcome: "success"
    }));
  });

  it("accepts only exact Claude tool decisions without retaining decision payload content", () => {
    const rejectedToolUseId = "PRIVATE_CLAUDE_DECISION_REJECT_TOOL_ID";
    const acceptedToolUseId = "PRIVATE_CLAUDE_DECISION_ACCEPT_TOOL_ID";
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: otlpNano("2026-07-14T04:00:01.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "tool_decision" } },
            { key: "prompt.id", value: { stringValue: "PRIVATE_CLAUDE_DECISION_PROMPT_ID" } },
            { key: "session.id", value: { stringValue: "PRIVATE_CLAUDE_DECISION_SESSION_ID" } },
            { key: "tool_name", value: { stringValue: "Write" } },
            { key: "tool_use_id", value: { stringValue: rejectedToolUseId } },
            { key: "decision", value: { stringValue: "reject" } },
            { key: "source", value: { stringValue: "user_reject" } },
            { key: "tool_input", value: { stringValue: "{\"file_path\":\"/PRIVATE_CLAUDE_DECISION_INPUT_PATH\",\"content\":\"PRIVATE_CLAUDE_DECISION_INPUT_CONTENT\"}" } },
            { key: "tool_parameters", value: { stringValue: "{\"file_path\":\"/PRIVATE_CLAUDE_DECISION_PATH\",\"content\":\"PRIVATE_CLAUDE_DECISION_CONTENT\"}" } }
          ]
        }, {
          timeUnixNano: otlpNano("2026-07-14T04:00:02.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_decision" } },
            { key: "prompt.id", value: { stringValue: "PRIVATE_CLAUDE_DECISION_PROMPT_ID" } },
            { key: "session.id", value: { stringValue: "PRIVATE_CLAUDE_DECISION_SESSION_ID" } },
            { key: "tool_name", value: { stringValue: "Skill" } },
            { key: "tool_use_id", value: { stringValue: acceptedToolUseId } },
            { key: "decision", value: { stringValue: "accept" } },
            { key: "source", value: { stringValue: "config" } },
            { key: "tool_parameters", value: { stringValue: "{\"skill_name\":\"PRIVATE_CLAUDE_ACCEPT_SKILL\",\"content\":\"PRIVATE_CLAUDE_ACCEPT_CONTENT\"}" } }
          ]
        }, {
          timeUnixNano: otlpNano("2026-07-14T04:00:03.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_decision" } },
            { key: "prompt.id", value: { stringValue: "PRIVATE_CLAUDE_DECISION_PROMPT_ID" } },
            { key: "session.id", value: { stringValue: "PRIVATE_CLAUDE_DECISION_SESSION_ID" } },
            { key: "tool_name", value: { stringValue: "Edit" } },
            { key: "tool_use_id", value: { stringValue: "PRIVATE_CLAUDE_INVALID_DECISION_TOOL_ID" } },
            { key: "decision", value: { stringValue: "deny" } },
            { key: "tool_parameters", value: { stringValue: "{\"replace_all\":true,\"content\":\"PRIVATE_CLAUDE_INVALID_DECISION_CONTENT\"}" } }
          ]
        }, {
          timeUnixNano: otlpNano("2026-07-14T04:00:04.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "tool_decision" } },
            { key: "prompt.id", value: { stringValue: "PRIVATE_CLAUDE_DECISION_PROMPT_ID" } },
            { key: "session.id", value: { stringValue: "PRIVATE_CLAUDE_DECISION_SESSION_ID" } },
            { key: "tool_name", value: { stringValue: "Write" } },
            { key: "decision", value: { stringValue: "reject" } },
            { key: "tool_parameters", value: { stringValue: "{\"content\":\"PRIVATE_CLAUDE_MISSING_ID_CONTENT\"}" } }
          ]
        }] }]
      }]
    };

    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-07-14T04:00:04.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const activities = guard.sanitizeActivityAtoms(raw, "logs", classification, metadata.observedAt);
    const nodes = guard.sanitizeExecutionNodes(raw, "logs", classification, metadata.observedAt);

    expect(activities.map((activity) => [activity.name, activity.outcome])).toEqual([
      ["Write", "rejected"],
      ["Skill", "unknown"]
    ]);
    expect(nodes.map((node) => [node.name, node.outcome])).toEqual([
      ["Write", "rejected"],
      ["Skill", "unknown"]
    ]);
    const auditGuard = new DefaultAgentPrivacyGuard(() => false, () => true);
    const auditMetadata = auditGuard.sanitizeOtlpEnvelope(raw, "logs", metadata.observedAt);
    const auditActivities = auditGuard.sanitizeActivityAtoms(raw, "logs", classification, auditMetadata.observedAt);
    expect(auditActivities).toHaveLength(2);
    expect(auditActivities.every((activity) => !("sensitiveAuditEvidence" in activity))).toBe(true);
    const serialized = JSON.stringify({ activities, nodes });
    for (const canary of [
      "PRIVATE_CLAUDE_DECISION_PROMPT_ID",
      "PRIVATE_CLAUDE_DECISION_SESSION_ID",
      rejectedToolUseId,
      acceptedToolUseId,
      "PRIVATE_CLAUDE_DECISION_PATH",
      "PRIVATE_CLAUDE_DECISION_CONTENT",
      "PRIVATE_CLAUDE_DECISION_INPUT_PATH",
      "PRIVATE_CLAUDE_DECISION_INPUT_CONTENT",
      "user_reject",
      "PRIVATE_CLAUDE_ACCEPT_SKILL",
      "PRIVATE_CLAUDE_ACCEPT_CONTENT",
      "PRIVATE_CLAUDE_INVALID_DECISION_TOOL_ID",
      "PRIVATE_CLAUDE_INVALID_DECISION_CONTENT",
      "PRIVATE_CLAUDE_MISSING_ID_CONTENT"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("keeps a native Claude denial distinct from same-tool result evidence", () => {
    const session = "PRIVATE_CLAUDE_COLLISION_SESSION";
    const prompt = "PRIVATE_CLAUDE_COLLISION_PROMPT";
    const toolUseId = "PRIVATE_CLAUDE_COLLISION_TOOL_USE";
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: otlpNano("2026-07-14T04:00:00.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_decision" } },
            { key: "event.timestamp", value: { stringValue: "2026-07-14T04:00:00.000Z" } },
            { key: "prompt.id", value: { stringValue: prompt } },
            { key: "session.id", value: { stringValue: session } },
            { key: "tool_name", value: { stringValue: "Write" } },
            { key: "tool_use_id", value: { stringValue: toolUseId } },
            { key: "decision", value: { stringValue: "reject" } },
            { key: "query_source", value: { stringValue: "sdk" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-decision-only-model" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "101" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "202" } },
            { key: "gen_ai.usage.cache_read.input_tokens", value: { intValue: "303" } },
            { key: "gen_ai.usage.cache_creation.input_tokens", value: { intValue: "404" } },
            { key: "gen_ai.usage.reasoning.output_tokens", value: { intValue: "505" } },
            { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
            { key: "billing_context", value: { stringValue: "PRIVATE_CLAUDE_DECISION_BILLING" } },
            { key: "gen_ai.usage.cost_usd", value: { doubleValue: 123.45 } },
            { key: "source", value: { stringValue: "PRIVATE_CLAUDE_COLLISION_SOURCE" } },
            { key: "tool_input", value: { stringValue: "{\"file_path\":\"/PRIVATE_CLAUDE_COLLISION_DECISION_PATH\",\"content\":\"PRIVATE_CLAUDE_COLLISION_DECISION_CONTENT\"}" } }
          ]
        }, {
          timeUnixNano: otlpNano("2026-07-14T04:00:01.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_result" } },
            { key: "event.timestamp", value: { stringValue: "2026-07-14T04:00:01.000Z" } },
            { key: "prompt.id", value: { stringValue: prompt } },
            { key: "session.id", value: { stringValue: session } },
            { key: "tool_name", value: { stringValue: "Write" } },
            { key: "tool_use_id", value: { stringValue: toolUseId } },
            { key: "success", value: { boolValue: false } },
            { key: "duration_ms", value: { intValue: "1000" } },
            { key: "result_size_bytes", value: { intValue: "256" } },
            { key: "result_tokens", value: { intValue: "12" } },
            { key: "tool_parameters", value: { stringValue: "{\"file_path\":\"/PRIVATE_CLAUDE_COLLISION_RESULT_PATH\",\"content\":\"PRIVATE_CLAUDE_COLLISION_RESULT_CONTENT\"}" } }
          ]
        }] }]
      }]
    };
    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-07-14T04:00:01.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const activities = guard.sanitizeActivityAtoms(raw, "logs", classification, metadata.observedAt);
    const nodes = guard.sanitizeExecutionNodes(raw, "logs", classification, metadata.observedAt);
    const usageAtoms = guard.sanitizeUsageAtoms(raw, "logs", classification, metadata.observedAt);

    expect(activities).toHaveLength(2);
    expect(new Set(activities.map((activity) => activity.activityId)).size).toBe(2);
    expect(new Set(activities.map((activity) => activity.requestId)).size).toBe(1);
    expect(new Set(activities.map((activity) => activity.invocationId)).size).toBe(1);
    expect(activities[0]?.invocationId).toMatch(/^invocation_/);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool",
        name: "Write",
        outcome: "rejected",
        outcomeAuthority: "native_permission_decision"
      }),
      expect.objectContaining({
        kind: "tool",
        name: "Write",
        outcome: "failure",
        durationMs: 1_000,
        resultSizeBytes: 256,
        providerReportedResultTokens: 12
      })
    ]));
    const decision = activities.find((activity) => activity.outcome === "rejected");
    expect(decision).not.toHaveProperty("endedAt");
    expect(decision).not.toHaveProperty("durationMs");
    expect(decision).not.toHaveProperty("resultSizeBytes");
    expect(decision).not.toHaveProperty("providerReportedResultTokens");
    expect(new Set(nodes.map((node) => node.nodeId)).size).toBe(2);
    expect(nodes.find((node) => node.outcome === "rejected")).not.toHaveProperty("endedAt");
    expect(nodes.find((node) => node.outcome === "rejected")).not.toHaveProperty("durationMs");
    const decisionNode = nodes.find((node) => node.outcome === "rejected");
    expect(decisionNode).toMatchObject({
      nodeKind: "tool",
      name: "Write",
      toolName: "Write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision"
    });
    expect(decision?.invocationId).toBe(decisionNode?.invocationId);
    for (const field of [
      "model",
      "usagePurpose",
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "reasoningOutputTokens"
    ]) {
      expect(decisionNode).not.toHaveProperty(field);
    }
    // A decision can carry copied model, usage, and billing fields. It must
    // remain activity-only rather than create an accounting/context atom.
    expect(usageAtoms).toEqual([]);

    const serialized = JSON.stringify({ activities, nodes, usageAtoms });
    for (const canary of [
      session,
      prompt,
      toolUseId,
      "claude-decision-only-model",
      "PRIVATE_CLAUDE_DECISION_BILLING",
      "PRIVATE_CLAUDE_COLLISION_SOURCE",
      "PRIVATE_CLAUDE_COLLISION_DECISION_PATH",
      "PRIVATE_CLAUDE_COLLISION_DECISION_CONTENT",
      "PRIVATE_CLAUDE_COLLISION_RESULT_PATH",
      "PRIVATE_CLAUDE_COLLISION_RESULT_CONTENT"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("extracts Codex skill injection metrics only after a remembered prompt", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const prompt = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-skill-conversation" } }
          ]
        }] }]
      }]
    };
    const metrics = {
      resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeMetrics: [{ metrics: [{
          name: "codex.skill.injected",
          sum: {
            dataPoints: [{
              timeUnixNano: otlpNano("2026-06-08T00:00:03.000Z"),
              attributes: [
                { key: "skill", value: { stringValue: "tirion-codex-stress-skill" } },
                { key: "status", value: { stringValue: "ok" } }
              ]
            }]
          }
        }] }]
      }]
    };

    const promptMetadata = guard.sanitizeOtlpEnvelope(prompt, "logs", "2026-06-08T00:00:00.000Z");
    const promptClassification = new DefaultTelemetryClassification().classify(promptMetadata);
    const occurrences = guard.sanitizeQueryOccurrences(prompt, "logs", promptClassification, promptMetadata.observedAt);
    const metricMetadata = guard.sanitizeOtlpEnvelope(metrics, "metrics", "2026-06-08T00:00:03.000Z");
    const metricClassification = new DefaultTelemetryClassification().classify(metricMetadata);
    const activities = guard.sanitizeActivityAtoms(metrics, "metrics", metricClassification, metricMetadata.observedAt);

    expect(activities).toEqual([
      expect.objectContaining({
        provider: "codex",
        queryId: occurrences[0]?.queryId,
        sessionId: occurrences[0]?.sessionId,
        kind: "skill",
        name: "tirion-codex-stress-skill",
        outcome: "success",
        startedAt: "2026-06-08T00:00:03.000Z",
        evidenceBasis: "provider_metric",
        evidenceSourceId: "otlp_codex_metrics",
        evidenceProfileVersion: "codex-otel-metrics-v1",
        identityConfidence: "medium",
        timingConfidence: "medium"
      })
    ]);

    const isolatedGuard = new DefaultAgentPrivacyGuard();
    expect(isolatedGuard.sanitizeActivityAtoms(metrics, "metrics", metricClassification, metricMetadata.observedAt))
      .toEqual([]);
  });

  it("captures Claude trace tool content from tool.output span events", () => {
    const guard = new DefaultAgentPrivacyGuard(() => true, () => true);
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeSpans: [{ spans: [{
          traceId: "claude-trace",
          spanId: "claude-tool-span",
          name: "claude_code.tool_use",
          startTimeUnixNano: "1780876800000000000",
          endTimeUnixNano: "1780876801000000000",
          attributes: [
            { key: "prompt.id", value: { stringValue: "claude-prompt" } },
            { key: "session.id", value: { stringValue: "claude-session" } },
            { key: "tool_name", value: { stringValue: "Read" } }
          ],
          events: [{
            name: "tool.output",
            attributes: [
              { key: "tool_input", value: { stringValue: "{\"file_path\":\"README.md\"}" } },
              { key: "tool_response", value: { stringValue: "{\"content\":\"hello\"}" } }
            ]
          }]
        }] }]
      }]
    };

    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:00.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const activities = guard.sanitizeActivityAtoms(raw, "traces", classification, metadata.observedAt);
    const nodes = guard.sanitizeExecutionNodes(raw, "traces", classification, metadata.observedAt);

    expect(activities[0]?.sensitiveAuditEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool_arguments",
        label: "tool_input",
        value: "{\"file_path\":\"README.md\"}"
      }),
      expect.objectContaining({
        kind: "tool_output",
        label: "tool_response",
        value: "{\"content\":\"hello\"}"
      })
    ]));
    expect(nodes[0]?.contents).toBeUndefined();
  });

  it("normalizes sensitive audit evidence kinds into canonical execution concepts", () => {
    expect(canonicalSensitiveAuditKind("tool_arguments")).toBe("tool_input");
    expect(canonicalSensitiveAuditKind("tool_output")).toBe("tool_output");
    expect(displayLabelForSensitiveAuditKind("tool_arguments")).toBe("tool input");
    expect(displayLabelForSensitiveAuditKind("file_content")).toBe("file content");
  });

  it("fails closed for Codex completion logs without a preceding user prompt", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.sse_event" } },
            { key: "event.kind", value: { stringValue: "response.completed" } },
            { key: "conversation.id", value: { stringValue: "unknown-conversation" } },
            { key: "input_token_count", value: { intValue: "10" } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-06-08T00:00:03.000Z");
    expect(guard.sanitizeUsageAtoms(raw, "logs", new DefaultTelemetryClassification().classify(metadata), metadata.observedAt))
      .toEqual([]);
  });

  it("does not correlate Codex completion logs with a different explicit turn", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const prompt = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-conversation" } },
            { key: "turn.id", value: { stringValue: "codex-turn-1" } }
          ]
        }] }]
      }]
    };
    const completion = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.sse_event" } },
            { key: "event.kind", value: { stringValue: "response.completed" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:04.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-conversation" } },
            { key: "turn.id", value: { stringValue: "codex-turn-2" } },
            { key: "input_token_count", value: { intValue: "10" } }
          ]
        }] }]
      }]
    };
    const promptMetadata = guard.sanitizeOtlpEnvelope(prompt, "logs", "2026-06-08T00:00:00.000Z");
    const promptClassification = new DefaultTelemetryClassification().classify(promptMetadata);
    expect(guard.sanitizeQueryOccurrences(prompt, "logs", promptClassification, promptMetadata.observedAt)).toHaveLength(1);
    const completionMetadata = guard.sanitizeOtlpEnvelope(completion, "logs", "2026-06-08T00:00:04.000Z");
    expect(guard.sanitizeUsageAtoms(
      completion,
      "logs",
      new DefaultTelemetryClassification().classify(completionMetadata),
      completionMetadata.observedAt
    )).toEqual([]);
  });

  it("keeps request atom identity stable when a provider revises usage counts", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = (inputTokens: string) => ({
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "trace-revision",
          spanId: "turn-revision",
          name: "codex.turn",
          startTimeUnixNano: "1780876800000000000",
          attributes: [
            { key: "thread.id", value: { stringValue: "thread-revision" } },
            { key: "turn.id", value: { stringValue: "turn-revision" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: inputTokens } }
          ]
        }] }]
      }]
    });
    const first = raw("1");
    const metadata = guard.sanitizeOtlpEnvelope(first, "traces", "2026-06-08T00:00:00.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const firstAtom = guard.sanitizeUsageAtoms(first, "traces", classification, metadata.observedAt)[0];
    const revisedAtom = guard.sanitizeUsageAtoms(raw("2"), "traces", classification, metadata.observedAt)[0];
    expect(revisedAtom.atomId).toBe(firstAtom.atomId);
    expect(revisedAtom.inputTokens).toBe(2);
  });

  it("projects privacy-safe Copilot tool activity and proves descendant usage ownership", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "github-copilot" } }] },
        scopeSpans: [{ spans: [{
          traceId: "copilot-trace",
          spanId: "root",
          name: "invoke_agent",
          attributes: [
            { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "20" } }
          ]
        }, {
          traceId: "copilot-trace",
          spanId: "tool",
          parentSpanId: "root",
          name: "execute_tool runSubagent",
          startTimeUnixNano: "1780876800000000000",
          endTimeUnixNano: "1780876801000000000",
          attributes: [
            { key: "gen_ai.tool.name", value: { stringValue: "runSubagent" } },
            { key: "arguments", value: { stringValue: "must not survive" } },
            { key: "output", value: { stringValue: "must not survive either" } }
          ]
        }, {
          traceId: "copilot-trace",
          spanId: "child-model",
          parentSpanId: "tool",
          name: "chat",
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "30" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:02.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const activities = guard.sanitizeActivityAtoms(raw, "traces", classification, metadata.observedAt);
    const atoms = guard.sanitizeUsageAtoms(raw, "traces", classification, metadata.observedAt);
    expect(activities).toEqual([expect.objectContaining({
      kind: "subagent",
      name: "runSubagent",
      durationMs: 1_000
    })]);
    expect(atoms.find((atom) => atom.requestId !== atom.queryId && atom.authority === "model")?.owningActivityId)
      .toBe(activities[0].activityId);
    expect(JSON.stringify(activities)).not.toContain("must not survive");
  });

  it("uses Claude tool_use_id for exact Agent descendant usage ownership", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeSpans: [{ spans: [{
          traceId: "claude-agent-owner-trace",
          spanId: "claude-agent-wrapper-span",
          name: "claude_code.tool",
          startTimeUnixNano: otlpNano("2026-06-08T00:00:01.000Z"),
          endTimeUnixNano: otlpNano("2026-06-08T00:00:04.000Z"),
          attributes: [
            { key: "prompt.id", value: { stringValue: "claude-agent-owner-prompt" } },
            { key: "session.id", value: { stringValue: "claude-agent-owner-session" } },
            { key: "tool_name", value: { stringValue: "Agent" } },
            { key: "tool_use_id", value: { stringValue: "claude-agent-owner-tool-use" } },
            { key: "subagent_type", value: { stringValue: "Explore" } }
          ]
        }, {
          traceId: "claude-agent-owner-trace",
          spanId: "claude-agent-child-request-span",
          parentSpanId: "claude-agent-wrapper-span",
          name: "claude_code.llm_request",
          startTimeUnixNano: otlpNano("2026-06-08T00:00:02.000Z"),
          endTimeUnixNano: otlpNano("2026-06-08T00:00:03.000Z"),
          attributes: [
            { key: "request_id", value: { stringValue: "claude-agent-child-request" } },
            { key: "agent_id", value: { stringValue: "PRIVATE_NATIVE_CHILD_AGENT_ID" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-5" } },
            { key: "input_tokens", value: { intValue: "30" } },
            { key: "output_tokens", value: { intValue: "5" } },
            { key: "success", value: { boolValue: true } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:04.100Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const activities = guard.sanitizeActivityAtoms(raw, "traces", classification, metadata.observedAt);
    const atoms = guard.sanitizeUsageAtoms(raw, "traces", classification, metadata.observedAt);

    expect(activities).toEqual([expect.objectContaining({
      kind: "subagent",
      name: "Explore",
      outcome: "unknown",
      evidenceBasis: "trace_span"
    })]);
    expect(atoms).toEqual([expect.objectContaining({
      owningActivityId: activities[0]?.activityId,
      inputTokens: 30,
      outputTokens: 5
    })]);
    expect(JSON.stringify([activities, atoms])).not.toContain("PRIVATE_NATIVE_CHILD_AGENT_ID");
  });

  it("retains exact Claude Agent ownership across parent-first OTLP envelopes", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const parent = claudeAgentToolTraceEnvelope({
      traceId: "claude-cross-envelope-trace",
      spanId: "claude-cross-envelope-agent-span",
      toolUseId: "claude-cross-envelope-tool-use",
      promptId: "claude-cross-envelope-prompt",
      sessionId: "claude-cross-envelope-session"
    });
    const parentMetadata = guard.sanitizeOtlpEnvelope(parent, "traces", "2026-06-08T00:00:01.100Z");
    const classification = new DefaultTelemetryClassification().classify(parentMetadata);
    const parentActivities = guard.sanitizeActivityAtoms(
      parent,
      "traces",
      classification,
      parentMetadata.observedAt
    );
    expect(guard.sanitizeUsageAtoms(parent, "traces", classification, parentMetadata.observedAt)).toEqual([]);

    const child = claudeChildUsageTraceEnvelope({
      traceId: "claude-cross-envelope-trace",
      spanId: "claude-cross-envelope-child-span",
      parentSpanId: "claude-cross-envelope-agent-span",
      requestId: "claude-cross-envelope-child-request"
    });
    const childAtoms = guard.sanitizeUsageAtoms(
      child,
      "traces",
      classification,
      "2026-06-08T00:00:03.100Z"
    );

    expect(childAtoms).toEqual([expect.objectContaining({
      owningActivityId: parentActivities[0]?.activityId,
      inputTokens: 30,
      outputTokens: 5
    })]);
    expect(JSON.stringify([parentActivities, childAtoms])).not.toMatch(
      /claude-cross-envelope-trace|claude-cross-envelope-agent-span|claude-cross-envelope-tool-use|claude-cross-envelope-child-request/
    );
  });

  it("preserves one exact Claude request owner and fails closed on a conflicting owner", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const firstParent = claudeAgentToolTraceEnvelope({
      traceId: "claude-request-owner-trace",
      spanId: "claude-request-owner-parent-a",
      toolUseId: "claude-request-owner-tool-a",
      promptId: "claude-request-owner-prompt",
      sessionId: "claude-request-owner-session"
    });
    const metadata = guard.sanitizeOtlpEnvelope(firstParent, "traces", "2026-06-08T00:00:01.100Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const firstParentActivity = guard.sanitizeActivityAtoms(
      firstParent,
      "traces",
      classification,
      metadata.observedAt
    )[0];
    guard.sanitizeUsageAtoms(firstParent, "traces", classification, metadata.observedAt);

    const owned = guard.sanitizeUsageAtoms(claudeChildUsageTraceEnvelope({
      traceId: "claude-request-owner-trace",
      spanId: "claude-request-owner-child-a",
      parentSpanId: "claude-request-owner-parent-a",
      requestId: "claude-request-owner-shared-request"
    }), "traces", classification, "2026-06-08T00:00:03.100Z")[0];
    const corroboratingUnowned = guard.sanitizeUsageAtoms(claudeChildUsageTraceEnvelope({
      traceId: "claude-request-owner-trace",
      spanId: "claude-request-owner-unparented-copy",
      parentSpanId: "claude-request-owner-missing-parent",
      requestId: "claude-request-owner-shared-request"
    }), "traces", classification, "2026-06-08T00:00:03.200Z")[0];
    expect(corroboratingUnowned).toMatchObject({
      atomId: owned?.atomId,
      requestId: owned?.requestId,
      owningActivityId: firstParentActivity?.activityId
    });

    const secondParent = claudeAgentToolTraceEnvelope({
      traceId: "claude-request-owner-trace",
      spanId: "claude-request-owner-parent-b",
      toolUseId: "claude-request-owner-tool-b",
      promptId: "claude-request-owner-prompt",
      sessionId: "claude-request-owner-session"
    });
    guard.sanitizeUsageAtoms(secondParent, "traces", classification, "2026-06-08T00:00:03.300Z");
    const conflicting = guard.sanitizeUsageAtoms(claudeChildUsageTraceEnvelope({
      traceId: "claude-request-owner-trace",
      spanId: "claude-request-owner-child-b",
      parentSpanId: "claude-request-owner-parent-b",
      requestId: "claude-request-owner-shared-request"
    }), "traces", classification, "2026-06-08T00:00:03.400Z")[0];
    expect(conflicting).toMatchObject({
      atomId: owned?.atomId,
      requestId: owned?.requestId,
      ownershipConflictActivityIds: expect.arrayContaining([
        firstParentActivity?.activityId,
        expect.stringMatching(/^act_/)
      ])
    });
    expect(conflicting).not.toHaveProperty("owningActivityId");

    const afterConflict = guard.sanitizeUsageAtoms(claudeChildUsageTraceEnvelope({
      traceId: "claude-request-owner-trace",
      spanId: "claude-request-owner-late-copy",
      parentSpanId: "claude-request-owner-missing-parent",
      requestId: "claude-request-owner-shared-request"
    }), "traces", classification, "2026-06-08T00:00:03.500Z")[0];
    expect(afterConflict).toMatchObject({
      ownershipConflictActivityIds: conflicting?.ownershipConflictActivityIds
    });
    expect(afterConflict).not.toHaveProperty("owningActivityId");
  });

  it("keeps child-first cross-envelope Claude ownership unsupported rather than guessing", () => {
    const guard = new DefaultAgentPrivacyGuard();
    guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-child-first-session",
      prompt_id: "claude-child-first-prompt"
    }, "claude-code", "2026-06-08T00:00:00.000Z");
    const child = claudeChildUsageTraceEnvelope({
      traceId: "claude-child-first-trace",
      spanId: "claude-child-first-span",
      parentSpanId: "claude-child-first-parent-span",
      requestId: "claude-child-first-request",
      sessionId: "claude-child-first-session"
    });
    const childMetadata = guard.sanitizeOtlpEnvelope(child, "traces", "2026-06-08T00:00:03.100Z");
    const classification = new DefaultTelemetryClassification().classify(childMetadata);
    const childAtoms = guard.sanitizeUsageAtoms(
      child,
      "traces",
      classification,
      childMetadata.observedAt
    );
    expect(childAtoms).toEqual([expect.not.objectContaining({ owningActivityId: expect.anything() })]);

    const laterParent = claudeAgentToolTraceEnvelope({
      traceId: "claude-child-first-trace",
      spanId: "claude-child-first-parent-span",
      toolUseId: "claude-child-first-tool-use",
      promptId: "claude-child-first-prompt",
      sessionId: "claude-child-first-session"
    });
    expect(guard.sanitizeUsageAtoms(
      laterParent,
      "traces",
      classification,
      "2026-06-08T00:00:04.100Z"
    )).toEqual([]);
    // The raw child envelope is not retained, so the later parent must not
    // manufacture a timing-based revision for the already-emitted safe atom.
    expect(childAtoms[0]?.owningActivityId).toBeUndefined();
  });

  it("fails closed when one Claude trace span reports conflicting tool identities", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const firstParent = claudeAgentToolTraceEnvelope({
      traceId: "claude-conflicting-owner-trace",
      spanId: "claude-conflicting-owner-span",
      toolUseId: "claude-conflicting-owner-a",
      promptId: "claude-conflicting-owner-prompt",
      sessionId: "claude-conflicting-owner-session"
    });
    const firstMetadata = guard.sanitizeOtlpEnvelope(firstParent, "traces", "2026-06-08T00:00:01.100Z");
    const classification = new DefaultTelemetryClassification().classify(firstMetadata);
    guard.sanitizeActivityAtoms(firstParent, "traces", classification, firstMetadata.observedAt);
    guard.sanitizeUsageAtoms(firstParent, "traces", classification, firstMetadata.observedAt);

    const conflictingParent = claudeAgentToolTraceEnvelope({
      traceId: "claude-conflicting-owner-trace",
      spanId: "claude-conflicting-owner-span",
      toolUseId: "claude-conflicting-owner-b",
      promptId: "claude-conflicting-owner-prompt",
      sessionId: "claude-conflicting-owner-session"
    });
    guard.sanitizeUsageAtoms(
      conflictingParent,
      "traces",
      classification,
      "2026-06-08T00:00:01.200Z"
    );
    // Once conflicted, replaying the first value cannot restore authority.
    guard.sanitizeUsageAtoms(firstParent, "traces", classification, "2026-06-08T00:00:01.300Z");

    const child = claudeChildUsageTraceEnvelope({
      traceId: "claude-conflicting-owner-trace",
      spanId: "claude-conflicting-owner-child",
      parentSpanId: "claude-conflicting-owner-span",
      requestId: "claude-conflicting-owner-request"
    });
    expect(guard.sanitizeUsageAtoms(
      child,
      "traces",
      classification,
      "2026-06-08T00:00:03.100Z"
    )).toEqual([expect.not.objectContaining({ owningActivityId: expect.anything() })]);
  });

  it("drops cross-envelope Claude ownership after the bounded trace ledger evicts it", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const parent = claudeAgentToolTraceEnvelope({
      traceId: "claude-evicted-owner-trace",
      spanId: "claude-evicted-owner-span",
      toolUseId: "claude-evicted-owner-tool",
      promptId: "claude-evicted-owner-prompt",
      sessionId: "claude-evicted-owner-session"
    });
    const metadata = guard.sanitizeOtlpEnvelope(parent, "traces", "2026-06-08T00:00:01.100Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    guard.sanitizeActivityAtoms(parent, "traces", classification, metadata.observedAt);
    guard.sanitizeUsageAtoms(parent, "traces", classification, metadata.observedAt);

    for (let index = 0; index <= 1_024; index += 1) {
      guard.sanitizeUsageAtoms(claudeAgentToolTraceEnvelope({
        traceId: `claude-ledger-churn-trace-${index}`,
        spanId: `claude-ledger-churn-span-${index}`,
        toolUseId: `claude-ledger-churn-tool-${index}`,
        promptId: `claude-ledger-churn-prompt-${index}`,
        sessionId: `claude-ledger-churn-session-${index}`
      }), "traces", classification, "2026-06-08T00:00:02.000Z");
    }

    const child = claudeChildUsageTraceEnvelope({
      traceId: "claude-evicted-owner-trace",
      spanId: "claude-evicted-owner-child",
      parentSpanId: "claude-evicted-owner-span",
      requestId: "claude-evicted-owner-request"
    });
    expect(guard.sanitizeUsageAtoms(
      child,
      "traces",
      classification,
      "2026-06-08T00:00:03.100Z"
    )).toEqual([expect.not.objectContaining({ owningActivityId: expect.anything() })]);
  });

  it("preserves prompt and span parentage as execution nodes", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "github-copilot" } }] },
        scopeSpans: [{ spans: [{
          traceId: "copilot-tree",
          spanId: "root",
          name: "invoke_agent",
          startTimeUnixNano: "1780876800000000000",
          attributes: [
            { key: "gen_ai.turn.id", value: { stringValue: "turn-1" } },
            { key: "copilot_chat.session_id", value: { stringValue: "session-1" } },
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } }
          ]
        }, {
          traceId: "copilot-tree",
          spanId: "tool",
          parentSpanId: "root",
          name: "execute_tool readFile",
          startTimeUnixNano: "1780876800100000000",
          attributes: [
            { key: "gen_ai.turn.id", value: { stringValue: "turn-1" } },
            { key: "copilot_chat.session_id", value: { stringValue: "session-1" } },
            { key: "gen_ai.tool.name", value: { stringValue: "readFile" } },
            { key: "arguments", value: { stringValue: "{\"path\":\"README.md\"}" } }
          ]
        }] }]
      }],
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "github-copilot" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1780876799000000000",
          attributes: [
            { key: "event.name", value: { stringValue: "user_message" } },
            { key: "gen_ai.turn.id", value: { stringValue: "turn-1" } },
            { key: "copilot_chat.session_id", value: { stringValue: "session-1" } },
            { key: "content", value: { stringValue: "Open the file" } }
          ]
        }] }]
      }]
    };
    const logMetadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-06-08T00:00:00.000Z");
    const logClassification = new DefaultTelemetryClassification().classify(logMetadata);
    const traceMetadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:00.000Z");
    const traceClassification = new DefaultTelemetryClassification().classify(traceMetadata);
    const promptNode = guard.sanitizeExecutionNodes(raw, "logs", logClassification, logMetadata.observedAt)[0];
    const traceNodes = guard.sanitizeExecutionNodes(raw, "traces", traceClassification, traceMetadata.observedAt);
    expect(promptNode).toMatchObject({
      nodeKind: "prompt"
    });
    expect(promptNode?.contents).toBeUndefined();
    expect(traceNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeKind: "llm_request", parentNodeId: promptNode.nodeId }),
      expect.objectContaining({ nodeKind: "tool", parentNodeId: traceNodes[0]?.nodeId })
    ]));
  });

  it("correlates Claude provider hooks from trace identity even when no prompt log was received", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeSpans: [{ spans: [{
          traceId: "claude-hook-trace",
          spanId: "claude-hook-request",
          name: "claude.request",
          startTimeUnixNano: "1780876800000000000",
          endTimeUnixNano: "1780876801000000000",
          attributes: [
            { key: "prompt.id", value: { stringValue: "claude-trace-query" } },
            { key: "session.id", value: { stringValue: "claude-trace-session" } },
            { key: "request.id", value: { stringValue: "claude-request-1" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4.6" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "2" } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "traces", "2026-06-08T00:00:00.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    guard.sanitizeExecutionNodes(raw, "traces", classification, metadata.observedAt);
    const observation = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "claude-trace-session",
      tool_name: "Read",
      tool_use_id: "claude-tool-1",
      tool_input: { file_path: "README.md" },
      tool_response: { success: true, content: "hello from hook" }
    }, "claude-code", metadata.observedAt);
    expect(observation).toMatchObject({
      sourceId: "hook_claude_code_tools",
      executionNodes: [expect.objectContaining({
        nodeKind: "tool",
        contents: undefined
      })]
    });
  });

  it("uses the same opaque execution invocation for an OTLP Claude decision and PostToolUse despite different request identities", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1780876800000000000",
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_decision" } },
            { key: "prompt.id", value: { stringValue: "claude-cross-surface-prompt" } },
            { key: "session.id", value: { stringValue: "claude-cross-surface-session" } },
            { key: "request.id", value: { stringValue: "claude-otlp-decision-request" } },
            { key: "tool_name", value: { stringValue: "Write" } },
            { key: "tool_use_id", value: { stringValue: "claude-cross-surface-tool-use" } },
            { key: "decision", value: { stringValue: "reject" } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-07-14T12:00:00.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const decision = guard.sanitizeExecutionNodes(raw, "logs", classification, metadata.observedAt)[0]!;
    const decisionActivity = guard.sanitizeActivityAtoms(raw, "logs", classification, metadata.observedAt)[0]!;
    const hook = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "claude-cross-surface-session",
      tool_name: "Write",
      tool_use_id: "claude-cross-surface-tool-use",
      tool_input: { file_path: "README.md" },
      tool_response: { success: true }
    }, "claude-code", metadata.observedAt);
    const successfulHookNode = hook?.executionNodes?.[0];
    const successfulHookActivity = hook?.activityAtoms?.[0];

    expect(decision).toMatchObject({
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      invocationId: expect.stringMatching(/^invocation_/)
    });
    expect(successfulHookNode).toMatchObject({
      outcome: "success",
      invocationId: decision.invocationId
    });
    expect(successfulHookNode?.requestId).not.toBe(decision.requestId);
    expect(successfulHookActivity).toMatchObject({ invocationId: decisionActivity.invocationId });
    // Activity request identity is intentionally stable for this provider
    // surface; invocation identity still prevents accidental joins if that
    // request is later reused for a different tool use.
    expect(successfulHookActivity?.requestId).toBe(decisionActivity.requestId);
    expect(JSON.stringify({ decision, decisionActivity, successfulHookNode, successfulHookActivity }))
      .not.toContain("claude-cross-surface-tool-use");
  });

  it("does not promote Claude shell hook protocol completion without an explicit command outcome", () => {
    const guard = new DefaultAgentPrivacyGuard();
    guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-shell-outcome-session",
      prompt_id: "claude-shell-outcome-prompt"
    }, "claude-code", "2026-06-08T00:00:00.000Z");

    const observations = [{
      hook_event_name: "PostToolUse",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-no-response"
    }, {
      hook_event_name: "PostToolUse",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-protocol-response",
      tool_response: {
        stdout: "PRIVATE_CLAUDE_SHELL_OUTPUT",
        stderr: "",
        interrupted: false
      }
    }, {
      hook_event_name: "PostToolUse",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-exit-zero",
      tool_response: { exit_code: 0 }
    }, {
      hook_event_name: "PostToolUse",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-exit-seven",
      tool_response: { exit_code: "7" }
    }, {
      hook_event_name: "PostToolUse",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-status-failed",
      tool_response: { status: "failed" }
    }, {
      hook_event_name: "PostToolUse",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-status-completed",
      tool_response: { status: "completed" }
    }, {
      hook_event_name: "PostToolUse",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-status-unsuccessful",
      tool_response: { status: "unsuccessful" }
    }, {
      hook_event_name: "PostToolUse",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-contradictory-status",
      tool_response: { status: "ok", success: false }
    }, {
      hook_event_name: "PostToolUse",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-interrupted-response",
      tool_input: { command: "PRIVATE_CLAUDE_INTERRUPTED_SHELL_COMMAND" },
      tool_response: { interrupted: true, output: "PRIVATE_CLAUDE_INTERRUPTED_SHELL_OUTPUT" }
    }, {
      hook_event_name: "PostToolUseFailure",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-explicit-failure",
      error: "PRIVATE_CLAUDE_SHELL_ERROR"
    }, {
      hook_event_name: "PostToolUseFailure",
      session_id: "claude-shell-outcome-session",
      tool_name: "Bash",
      tool_use_id: "claude-shell-explicit-rejection",
      is_interrupt: true
    }].map((raw, index) => guard.sanitizeProviderHookObservation(
      raw,
      "claude-code",
      `2026-06-08T00:00:${String(index + 1).padStart(2, "0")}.000Z`
    ));

    expect(observations.map((observation) => observation?.activityAtoms?.[0]?.outcome)).toEqual([
      "unknown",
      "unknown",
      "success",
      "failure",
      "failure",
      "unknown",
      "failure",
      "failure",
      "rejected",
      "failure",
      "rejected"
    ]);
    expect(observations.map((observation) => observation?.executionNodes?.[0]?.outcome)).toEqual([
      "unknown",
      "unknown",
      "success",
      "failure",
      "failure",
      "unknown",
      "failure",
      "failure",
      "rejected",
      "failure",
      "rejected"
    ]);
    expect(JSON.stringify(observations)).not.toContain("PRIVATE_CLAUDE_SHELL_OUTPUT");
    expect(JSON.stringify(observations)).not.toContain("PRIVATE_CLAUDE_SHELL_ERROR");
    expect(JSON.stringify(observations)).not.toContain("PRIVATE_CLAUDE_INTERRUPTED_SHELL_COMMAND");
    expect(JSON.stringify(observations)).not.toContain("PRIVATE_CLAUDE_INTERRUPTED_SHELL_OUTPUT");
  });

  it("does not promote Claude OTLP shell protocol success without exit or semantic status evidence", () => {
    const attributesFor = (
      toolUseId: string,
      toolName: string,
      extra: Array<{ key: string; value: Record<string, string> }>
    ) => [
      { key: "event.name", value: { stringValue: "claude_code.tool_result" } },
      { key: "prompt.id", value: { stringValue: "claude-otlp-shell-prompt" } },
      { key: "session.id", value: { stringValue: "claude-otlp-shell-session" } },
      { key: "tool_name", value: { stringValue: toolName } },
      { key: "tool_use_id", value: { stringValue: toolUseId } },
      ...extra
    ];
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: attributesFor("claude-otlp-shell-protocol", "Bash", [
            { key: "success", value: { stringValue: "true" } }
          ])
        }, {
          name: "claude_code.tool_use",
          attributes: attributesFor("claude-otlp-shell-wrapper-name", "Bash", [
            { key: "success", value: { stringValue: "true" } }
          ])
        }, {
          attributes: attributesFor("claude-otlp-shell-exit-zero", "Bash", [
            { key: "success", value: { stringValue: "true" } },
            { key: "exit_code", value: { intValue: "0" } }
          ])
        }, {
          attributes: attributesFor("claude-otlp-shell-exit-seven", "Bash", [
            { key: "success", value: { stringValue: "true" } },
            { key: "exit_code", value: { intValue: "7" } }
          ])
        }, {
          attributes: attributesFor("claude-otlp-shell-completed", "Bash", [
            { key: "success", value: { stringValue: "true" } },
            { key: "status", value: { stringValue: "completed" } }
          ])
        }, {
          attributes: attributesFor("claude-otlp-shell-unsuccessful", "Bash", [
            { key: "success", value: { stringValue: "true" } },
            { key: "status", value: { stringValue: "unsuccessful" } }
          ])
        }, {
          attributes: attributesFor("claude-otlp-shell-contradictory", "Bash", [
            { key: "success", value: { stringValue: "false" } },
            { key: "status", value: { stringValue: "ok" } }
          ])
        }, {
          attributes: attributesFor("claude-otlp-shell-dispatch-failure", "Bash", [
            { key: "success", value: { stringValue: "false" } }
          ])
        }, {
          attributes: attributesFor("claude-otlp-read-success", "Read", [
            { key: "success", value: { stringValue: "true" } }
          ])
        }] }]
      }]
    };
    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-06-08T00:00:01.000Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const activities = guard.sanitizeActivityAtoms(
      raw,
      "logs",
      classification,
      metadata.observedAt
    );
    const nodes = guard.sanitizeExecutionNodes(raw, "logs", classification, metadata.observedAt);

    expect(activities.map((activity) => [activity.name, activity.outcome])).toEqual([
      ["Bash", "unknown"],
      ["Bash", "unknown"],
      ["Bash", "success"],
      ["Bash", "failure"],
      ["Bash", "unknown"],
      ["Bash", "failure"],
      ["Bash", "failure"],
      ["Bash", "failure"],
      ["Read", "success"]
    ]);
    expect(nodes.map((node) => [node.name, node.outcome])).toEqual([
      ["Bash", "unknown"],
      ["Bash", "unknown"],
      ["Bash", "success"],
      ["Bash", "failure"],
      ["Bash", "unknown"],
      ["Bash", "failure"],
      ["Bash", "failure"],
      ["Bash", "failure"],
      ["Read", "success"]
    ]);
  });

  it("records Claude prompt hooks as safe query lifecycle observations without prompt text", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const observation = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session-1",
      prompt: "write the secret feature"
    }, "claude-code", "2026-06-08T00:00:00.000Z");
    const subagentStart = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStart",
      session_id: "claude-session-1",
      subagent_id: "claude-child-session-1",
      agent_type: "researcher"
    }, "claude-code", "2026-06-08T00:00:01.000Z");
    const subagentStop = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStop",
      session_id: "claude-session-1",
      subagent_id: "claude-child-session-1",
      agent_type: "researcher"
    }, "claude-code", "2026-06-08T00:00:03.000Z");
    const stop = guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: "claude-session-1"
    }, "claude-code", "2026-06-08T00:00:04.000Z");

    expect(observation).toMatchObject({
      sourceId: "hook_claude_code_lifecycle",
      queryOccurrences: [expect.objectContaining({
        promptState: "disabled",
        evidence: "submission_hook"
      })],
      executionNodes: [expect.objectContaining({
        nodeKind: "prompt",
        name: "Prompt"
      })],
      usageAtoms: []
    });
    expect(subagentStart).toMatchObject({
      activityAtoms: [expect.objectContaining({
        kind: "subagent",
        name: "researcher",
        outcome: "unknown",
        childSessionId: expect.stringMatching(/^ses_/),
        startedAt: "2026-06-08T00:00:01.000Z",
        endedAt: undefined
      })]
    });
    expect(subagentStop).toMatchObject({
      activityAtoms: [expect.objectContaining({
        kind: "subagent",
        name: "researcher",
        outcome: "unknown",
        childSessionId: subagentStart?.activityAtoms?.[0]?.childSessionId,
        startedAt: "2026-06-08T00:00:01.000Z",
        endedAt: undefined
      })]
    });
    expect(subagentStop?.observationId).not.toBe(subagentStart?.observationId);
    expect(stop).toBeUndefined();
    expect(JSON.stringify([observation, subagentStart, subagentStop, stop])).not.toContain("write the secret feature");
  });

  it("joins Claude Agent PostToolUse to SubagentStart by the exact native agent identity", () => {
    const guard = new DefaultAgentPrivacyGuard();
    guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-agent-join-session",
      prompt_id: "claude-agent-join-prompt",
      prompt: "PRIVATE_ROOT_PROMPT"
    }, "claude-code", "2026-06-08T00:00:00.000Z");

    const agentTool = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "claude-agent-join-session",
      tool_name: "Agent",
      tool_use_id: "claude-agent-tool-use",
      tool_input: {
        subagent_type: "Explore",
        prompt: "PRIVATE_CHILD_PROMPT"
      },
      tool_response: {
        status: "async_launched",
        agentId: "claude-exact-child-agent",
        content: "PRIVATE_CHILD_RESPONSE"
      },
      duration_ms: 6
    }, "claude-code", "2026-06-08T00:00:01.000Z");
    const subagentStart = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStart",
      session_id: "claude-agent-join-session",
      agent_id: "claude-exact-child-agent",
      agent_type: "Explore"
    }, "claude-code", "2026-06-08T00:00:01.001Z");

    expect(agentTool?.activityAtoms?.[0]).toMatchObject({
      kind: "subagent",
      name: "Explore",
      outcome: "unknown",
      childSessionId: subagentStart?.activityAtoms?.[0]?.childSessionId,
      evidenceBasis: "subagent_hook"
    });
    expect(agentTool?.executionNodes?.[0]).toMatchObject({
      nodeKind: "subagent",
      name: "Explore",
      outcome: "unknown"
    });
    expect(JSON.stringify([agentTool, subagentStart])).not.toMatch(
      /PRIVATE_ROOT_PROMPT|PRIVATE_CHILD_PROMPT|PRIVATE_CHILD_RESPONSE|claude-exact-child-agent|claude-agent-tool-use/
    );

    const nonNativeAlias = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "claude-agent-join-session",
      tool_name: "Agent",
      tool_use_id: "claude-agent-tool-unlinked",
      tool_input: { subagent_type: "Explore" },
      tool_response: { status: "async_launched", agent_id: "claude-unaccepted-child-alias" }
    }, "claude-code", "2026-06-08T00:00:02.000Z");
    expect(nonNativeAlias?.activityAtoms?.[0]?.childSessionId).toBeUndefined();
  });

  it("keeps an Agent-linked child open when SubagentStart is missing", () => {
    const guard = new DefaultAgentPrivacyGuard();
    guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-agent-open-session",
      prompt_id: "claude-agent-open-prompt"
    }, "claude-code", "2026-06-08T00:00:00.000Z");

    const agentTool = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "claude-agent-open-session",
      tool_name: "Agent",
      tool_use_id: "claude-agent-open-tool-use",
      tool_input: { subagent_type: "Explore", prompt: "PRIVATE_CHILD_PROMPT" },
      tool_response: {
        status: "async_launched",
        agentId: "claude-agent-open-child",
        content: "PRIVATE_CHILD_RESPONSE"
      },
      duration_ms: 9
    }, "claude-code", "2026-06-08T00:00:01.000Z");

    expect(agentTool?.activityAtoms?.[0]).toMatchObject({
      kind: "subagent",
      name: "Explore",
      outcome: "unknown",
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: undefined,
      durationMs: undefined,
      timingConfidence: "medium"
    });
    expect(agentTool?.executionNodes?.[0]).toMatchObject({
      nodeKind: "subagent",
      outcome: "unknown",
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: undefined,
      durationMs: undefined
    });
    expect(JSON.stringify(agentTool)).not.toMatch(
      /PRIVATE_CHILD_PROMPT|PRIVATE_CHILD_RESPONSE|claude-agent-open-child|claude-agent-open-tool-use/
    );
  });

  it("fails closed for unmatched and repeated Claude subagent stop attempts", () => {
    const guard = new DefaultAgentPrivacyGuard();
    guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-subagent-ledger-session",
      prompt_id: "claude-subagent-ledger-prompt"
    }, "claude-code", "2026-06-08T00:00:00.000Z");

    const unmatched = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStop",
      session_id: "claude-subagent-ledger-session",
      subagent_id: "claude-never-started-child",
      subagent_type: "explorer",
      duration_ms: 500
    }, "claude-code", "2026-06-08T00:00:01.000Z");
    const start = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStart",
      session_id: "claude-subagent-ledger-session",
      subagent_id: "claude-matched-child",
      subagent_type: "explorer"
    }, "claude-code", "2026-06-08T00:00:02.000Z");
    const stop = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStop",
      session_id: "claude-subagent-ledger-session",
      subagent_id: "claude-matched-child",
      subagent_type: "explorer",
      duration_ms: 9000,
      stop_hook_active: false
    }, "claude-code", "2026-06-08T00:00:04.000Z");
    const duplicateLateStop = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStop",
      session_id: "claude-subagent-ledger-session",
      subagent_id: "claude-matched-child",
      subagent_type: "explorer",
      stop_hook_active: true
    }, "claude-code", "2026-06-08T00:00:10.000Z");

    expect(unmatched).toBeUndefined();
    expect(duplicateLateStop).toBeDefined();
    expect(start?.activityAtoms?.[0]).toMatchObject({
      outcome: "unknown",
      startedAt: "2026-06-08T00:00:02.000Z",
      endedAt: undefined
    });
    expect(stop?.activityAtoms?.[0]).toMatchObject({
      activityId: start?.activityAtoms?.[0]?.activityId,
      requestId: start?.activityAtoms?.[0]?.requestId,
      childSessionId: start?.activityAtoms?.[0]?.childSessionId,
      outcome: "unknown",
      startedAt: "2026-06-08T00:00:02.000Z",
      endedAt: undefined
    });
    expect(stop?.executionNodes?.[0]).toMatchObject({
      nodeId: start?.executionNodes?.[0]?.nodeId,
      requestId: start?.executionNodes?.[0]?.requestId,
      outcome: "unknown",
      startedAt: "2026-06-08T00:00:02.000Z",
      endedAt: undefined
    });
    expect(duplicateLateStop?.activityAtoms?.[0]).toMatchObject({
      activityId: start?.activityAtoms?.[0]?.activityId,
      requestId: start?.activityAtoms?.[0]?.requestId,
      childSessionId: start?.activityAtoms?.[0]?.childSessionId,
      outcome: "unknown",
      startedAt: "2026-06-08T00:00:02.000Z",
      endedAt: undefined
    });
    expect(new Set([
      start?.observationId,
      stop?.observationId,
      duplicateLateStop?.observationId
    ]).size).toBe(3);
  });

  it("correlates the native Claude 2.1.207 missing-session identity chain and bounds usage purpose", () => {
    const fixture = claudeCodeNativeSuccessfulV21207;
    const guard = new DefaultAgentPrivacyGuard();
    const promptHook = guard.sanitizeProviderHookObservation(
      fixture.promptHook,
      "claude-code",
      fixture.promptObservedAt
    );

    const promptMetadata = guard.sanitizeOtlpEnvelope(
      fixture.promptLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    const promptClassification = new DefaultTelemetryClassification().classify(promptMetadata);
    const promptOccurrences = guard.sanitizeQueryOccurrences(
      fixture.promptLogEnvelope,
      "logs",
      promptClassification,
      promptMetadata.observedAt
    );
    const promptNodes = guard.sanitizeExecutionNodes(
      fixture.promptLogEnvelope,
      "logs",
      promptClassification,
      promptMetadata.observedAt
    );

    const logMetadata = guard.sanitizeOtlpEnvelope(
      fixture.apiLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    const logClassification = new DefaultTelemetryClassification().classify(logMetadata);
    const logAtoms = guard.sanitizeUsageAtoms(
      fixture.apiLogEnvelope,
      "logs",
      logClassification,
      logMetadata.observedAt
    );
    const logNodes = guard.sanitizeExecutionNodes(
      fixture.apiLogEnvelope,
      "logs",
      logClassification,
      logMetadata.observedAt
    );

    const traceMetadata = guard.sanitizeOtlpEnvelope(
      fixture.traceEnvelope,
      "traces",
      fixture.promptObservedAt
    );
    const traceClassification = new DefaultTelemetryClassification().classify(traceMetadata);
    const traceAtoms = guard.sanitizeUsageAtoms(
      fixture.traceEnvelope,
      "traces",
      traceClassification,
      traceMetadata.observedAt
    );
    const traceNodes = guard.sanitizeExecutionNodes(
      fixture.traceEnvelope,
      "traces",
      traceClassification,
      traceMetadata.observedAt
    );

    expect(promptOccurrences).toEqual([expect.objectContaining({
      queryId: promptHook?.queryOccurrences?.[0]?.queryId,
      sessionId: promptHook?.queryOccurrences?.[0]?.sessionId,
      evidence: "provider_prompt_id"
    })]);
    expect(promptNodes).toEqual([expect.objectContaining({ nodeKind: "prompt" })]);
    expect(logAtoms).toHaveLength(3);
    expect(traceAtoms).toHaveLength(3);
    expect(logNodes).toHaveLength(3);
    expect(traceNodes).toHaveLength(3);

    const titleLog = logAtoms.find((atom) => atom.model === "claude-haiku-4-5-20251001");
    const titleTrace = traceAtoms.find((atom) => atom.model === "claude-haiku-4-5-20251001");
    expect(titleLog).toMatchObject({
      usagePurpose: "auxiliary_session_title",
      inputTokens: 564,
      outputTokens: 15
    });
    expect(titleTrace).toMatchObject({
      usagePurpose: "auxiliary_session_title",
      requestId: titleLog?.requestId
    });

    const mainLogAtoms = logAtoms.filter((atom) => atom.usagePurpose === "customer");
    const mainTraceAtoms = traceAtoms.filter((atom) => atom.usagePurpose === "customer");
    expect(mainLogAtoms).toHaveLength(2);
    expect(mainTraceAtoms).toHaveLength(2);
    expect(mainLogAtoms.reduce((totals, atom) => ({
      inputTokens: totals.inputTokens + (atom.inputTokens ?? 0),
      outputTokens: totals.outputTokens + (atom.outputTokens ?? 0),
      cacheReadInputTokens: totals.cacheReadInputTokens + (atom.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: totals.cacheCreationInputTokens + (atom.cacheCreationInputTokens ?? 0),
      providerReportedNanoUsd: totals.providerReportedNanoUsd + (atom.providerReportedNanoUsd ?? 0)
    }), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      providerReportedNanoUsd: 0
    })).toEqual(fixture.expectedMainUsage);

    const logRequestsByUsage = new Map(logAtoms.map((atom) => [
      `${atom.model}|${atom.inputTokens}|${atom.outputTokens}`,
      atom.requestId
    ]));
    for (const atom of traceAtoms) {
      expect(atom.requestId).toBe(logRequestsByUsage.get(
        `${atom.model}|${atom.inputTokens}|${atom.outputTokens}`
      ));
    }
    for (const atom of [...logAtoms, ...traceAtoms]) {
      expect(atom.queryId).toBe(promptHook?.queryOccurrences?.[0]?.queryId);
      expect(atom.sessionId).toBe(promptHook?.queryOccurrences?.[0]?.sessionId);
    }
    expect(logNodes.map((node) => node.usagePurpose)).toEqual([
      "auxiliary_session_title",
      "customer",
      "customer"
    ]);
    expect(traceNodes.map((node) => node.usagePurpose)).toEqual([
      "auxiliary_session_title",
      "customer",
      "customer"
    ]);

    const serialized = JSON.stringify([
      promptHook,
      promptOccurrences,
      promptNodes,
      logAtoms,
      logNodes,
      traceAtoms,
      traceNodes
    ]);
    for (const rawIdentifier of fixture.syntheticIdentifiers) {
      expect(serialized).not.toContain(rawIdentifier);
    }
    expect(serialized).not.toContain("generate_session_title");
    expect(serialized).not.toContain('"sdk"');
    expect(serialized).not.toContain("query_source");
  });

  it("never persists an arbitrary native Claude query_source value", () => {
    const fixture = claudeCodeNativeSuccessfulV21207;
    const guard = new DefaultAgentPrivacyGuard();
    guard.sanitizeProviderHookObservation(fixture.promptHook, "claude-code", fixture.promptObservedAt);
    const promptMetadata = guard.sanitizeOtlpEnvelope(
      fixture.promptLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    guard.sanitizeQueryOccurrences(
      fixture.promptLogEnvelope,
      "logs",
      new DefaultTelemetryClassification().classify(promptMetadata),
      promptMetadata.observedAt
    );

    const canary = "PRIVATE_ARBITRARY_QUERY_SOURCE_CANARY";
    const sourceRecord = fixture.apiLogEnvelope.resourceLogs[0].scopeLogs[0].logRecords[0];
    const unknownSourceEnvelope = {
      resourceLogs: [{
        ...fixture.apiLogEnvelope.resourceLogs[0],
        scopeLogs: [{ logRecords: [{
          ...sourceRecord,
          attributes: sourceRecord.attributes.map((attribute) => attribute.key === "query_source"
            ? { key: "query_source", value: { stringValue: canary } }
            : attribute)
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(
      unknownSourceEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    const atoms = guard.sanitizeUsageAtoms(
      unknownSourceEnvelope,
      "logs",
      new DefaultTelemetryClassification().classify(metadata),
      metadata.observedAt
    );
    const nodes = guard.sanitizeExecutionNodes(
      unknownSourceEnvelope,
      "logs",
      new DefaultTelemetryClassification().classify(metadata),
      metadata.observedAt
    );

    expect(atoms).toHaveLength(1);
    expect(atoms[0].usagePurpose).toBeUndefined();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].usagePurpose).toBeUndefined();
    expect(JSON.stringify([atoms, nodes])).not.toContain(canary);
  });

  it("fails closed when a native Claude prompt correlation conflicts", () => {
    const fixture = claudeCodeNativeSuccessfulV21207;
    const guard = new DefaultAgentPrivacyGuard();
    expect(guard.sanitizeProviderHookObservation(
      fixture.promptHook,
      "claude-code",
      fixture.promptObservedAt
    )).toBeDefined();
    expect(guard.sanitizeProviderHookObservation({
      ...fixture.promptHook,
      session_id: "fixture-conflicting-session"
    }, "claude-code", "2026-07-12T08:00:00.001Z")).toBeUndefined();

    const promptMetadata = guard.sanitizeOtlpEnvelope(
      fixture.promptLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    const promptClassification = new DefaultTelemetryClassification().classify(promptMetadata);
    expect(guard.sanitizeQueryOccurrences(
      fixture.promptLogEnvelope,
      "logs",
      promptClassification,
      promptMetadata.observedAt
    )).toEqual([]);
    const apiMetadata = guard.sanitizeOtlpEnvelope(
      fixture.apiLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    expect(guard.sanitizeUsageAtoms(
      fixture.apiLogEnvelope,
      "logs",
      new DefaultTelemetryClassification().classify(apiMetadata),
      apiMetadata.observedAt
    )).toEqual([]);
  });

  it("folds same-session Claude continuation prompt IDs until exact ordinary completion", () => {
    const session = "fixture-claude-continuation-session";
    const initialPrompt = "fixture-claude-continuation-initial";
    const continuationPrompt = "fixture-claude-continuation-scheduled";
    const nextPrompt = "fixture-claude-continuation-next";
    const promptAt = "2026-07-12T08:00:00.000Z";
    const continuationAt = "2026-07-12T10:00:00.000Z";
    const stoppedAt = "2026-07-12T10:00:05.000Z";
    const completedAt = "2026-07-12T10:00:05.002Z";
    const nextAt = "2026-07-12T11:00:00.000Z";

    const runScenario = (closeFirst: boolean) => {
      const trace = `fixture-claude-continuation-trace-${closeFirst ? "first" : "last"}`;
      const guard = new DefaultAgentPrivacyGuard();
      const initial = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: initialPrompt
      }, "claude-code", promptAt);
      expect(guard.sanitizeProviderHookObservation({
        hook_event_name: "Stop",
        session_id: session,
        prompt_id: initialPrompt,
        background_tasks: [{ task_id: "fixture-continuation-task" }],
        session_crons: []
      }, "claude-code", "2026-07-12T09:59:59.000Z")).toBeUndefined();
      const continuationPromptEnvelope = {
        resourceLogs: [{
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }]
          },
          scopeLogs: [{ logRecords: [{
            traceId: trace,
            spanId: "fixture-claude-continuation-root-span",
            timeUnixNano: otlpNano(continuationAt),
            attributes: [
              { key: "event.name", value: { stringValue: "user_prompt" } },
              { key: "prompt.id", value: { stringValue: continuationPrompt } },
              { key: "session.id", value: { stringValue: session } }
            ]
          }] }]
        }]
      };
      const promptMetadata = guard.sanitizeOtlpEnvelope(
        continuationPromptEnvelope,
        "logs",
        continuationAt
      );
      const continuationOccurrence = guard.sanitizeQueryOccurrences(
        continuationPromptEnvelope,
        "logs",
        new DefaultTelemetryClassification().classify(promptMetadata),
        promptMetadata.observedAt
      )[0];
      const continuation = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: continuationPrompt
      }, "claude-code", "2026-07-12T10:00:00.100Z");
      const request = `fixture-claude-continuation-request-${closeFirst ? "first" : "last"}`;
      const requestLogEnvelope = {
        resourceLogs: [{
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }]
          },
          scopeLogs: [{ logRecords: [{
            timeUnixNano: otlpNano("2026-07-12T10:00:00.200Z"),
            attributes: [
              { key: "event.name", value: { stringValue: "api_request" } },
              { key: "prompt.id", value: { stringValue: continuationPrompt } },
              { key: "session.id", value: { stringValue: session } },
              { key: "request_id", value: { stringValue: request } },
              { key: "model", value: { stringValue: "claude-sonnet-5" } },
              { key: "input_tokens", value: { intValue: "2" } },
              { key: "output_tokens", value: { intValue: "3" } }
            ]
          }] }]
        }]
      };
      const requestLogMetadata = guard.sanitizeOtlpEnvelope(
        requestLogEnvelope,
        "logs",
        "2026-07-12T10:00:00.200Z"
      );
      const requestLogUsage = guard.sanitizeUsageAtoms(
        requestLogEnvelope,
        "logs",
        new DefaultTelemetryClassification().classify(requestLogMetadata),
        requestLogMetadata.observedAt
      )[0];
      const requestTraceEnvelope = {
        resourceSpans: [{
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }]
          },
          scopeSpans: [{ spans: [{
            spanId: "fixture-claude-continuation-request-span",
            name: "claude_code.llm_request",
            startTimeUnixNano: otlpNano("2026-07-12T10:00:00.200Z"),
            endTimeUnixNano: otlpNano("2026-07-12T10:00:00.300Z"),
            attributes: [
              { key: "request.id", value: { stringValue: request } },
              { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-5" } },
              { key: "input_tokens", value: { intValue: "2" } },
              { key: "output_tokens", value: { intValue: "3" } }
            ]
          }] }]
        }]
      };
      const requestTraceMetadata = guard.sanitizeOtlpEnvelope(
        requestTraceEnvelope,
        "traces",
        "2026-07-12T10:00:00.300Z"
      );
      const requestTraceUsage = guard.sanitizeUsageAtoms(
        requestTraceEnvelope,
        "traces",
        new DefaultTelemetryClassification().classify(requestTraceMetadata),
        requestTraceMetadata.observedAt
      )[0];
      const closedInteractionEnvelope = {
        resourceSpans: [{
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }]
          },
          scopeSpans: [{ spans: [{
            traceId: trace,
            spanId: "fixture-claude-continuation-root-span",
            name: "claude_code.interaction",
            startTimeUnixNano: otlpNano(promptAt),
            endTimeUnixNano: otlpNano(completedAt),
            status: { code: 1 },
            attributes: [{ key: "span.type", value: { stringValue: "interaction" } }]
          }] }]
        }]
      };
      const stop = () => guard.sanitizeProviderHookObservation({
        hook_event_name: "Stop",
        session_id: session,
        prompt_id: continuationPrompt,
        background_tasks: [],
        session_crons: []
      }, "claude-code", stoppedAt);
      const close = () => {
        const metadata = guard.sanitizeOtlpEnvelope(
          closedInteractionEnvelope,
          "traces",
          completedAt
        );
        return guard.sanitizeQueryOccurrences(
          closedInteractionEnvelope,
          "traces",
          new DefaultTelemetryClassification().classify(metadata),
          metadata.observedAt
        );
      };

      let terminal;
      if (closeFirst) {
        expect(close()).toEqual([]);
        terminal = stop()?.queryOccurrences ?? [];
      } else {
        expect(stop()).toBeUndefined();
        terminal = close();
      }
      const lateContinuationHook = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: continuationPrompt
      }, "claude-code", "2026-07-12T10:00:06.000Z");
      const next = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: nextPrompt
      }, "claude-code", nextAt);

      expect(continuationOccurrence).toMatchObject({
        queryId: initial?.queryOccurrences?.[0]?.queryId,
        sessionId: initial?.queryOccurrences?.[0]?.sessionId,
        startedAt: promptAt
      });
      expect(continuation?.queryOccurrences?.[0]).toMatchObject({
        queryId: initial?.queryOccurrences?.[0]?.queryId,
        sessionId: initial?.queryOccurrences?.[0]?.sessionId,
        startedAt: promptAt
      });
      expect(requestLogUsage).toMatchObject({
        queryId: initial?.queryOccurrences?.[0]?.queryId,
        sessionId: initial?.queryOccurrences?.[0]?.sessionId
      });
      expect(requestTraceUsage).toMatchObject({
        queryId: initial?.queryOccurrences?.[0]?.queryId,
        sessionId: initial?.queryOccurrences?.[0]?.sessionId,
        requestId: requestLogUsage.requestId
      });
      expect(terminal).toEqual([expect.objectContaining({
        queryId: initial?.queryOccurrences?.[0]?.queryId,
        sessionId: initial?.queryOccurrences?.[0]?.sessionId,
        startedAt: promptAt,
        completedAt,
        completionEvidence: "closed_root_span"
      })]);
      expect(lateContinuationHook).toBeUndefined();
      expect(next?.queryOccurrences?.[0]).toMatchObject({ startedAt: nextAt });
      expect(next?.queryOccurrences?.[0]?.queryId).not.toBe(initial?.queryOccurrences?.[0]?.queryId);
      expect(JSON.stringify([
        initial,
        continuationOccurrence,
        continuation,
        requestLogUsage,
        requestTraceUsage,
        terminal,
        next
      ]))
        .not.toContain(session);
    };

    runScenario(false);
    runScenario(true);
  });

  it("accepts an exact Claude continuation alias on StopFailure and releases the session", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-claude-failed-continuation-session";
    const initial = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "fixture-claude-failed-continuation-initial"
    }, "claude-code", "2026-07-12T12:00:00.000Z");
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: "fixture-claude-failed-continuation-initial",
      background_tasks: [{ task_id: "fixture-failed-continuation-task" }],
      session_crons: []
    }, "claude-code", "2026-07-12T12:59:59.000Z")).toBeUndefined();
    expect(guard.countClaudeBackgroundRootsAwaitingTerminal(session)).toBe(1);
    guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "fixture-claude-failed-continuation-scheduled"
    }, "claude-code", "2026-07-12T13:00:00.000Z");
    const stopFailure = {
      hook_event_name: "StopFailure",
      session_id: session,
      prompt_id: "fixture-claude-failed-continuation-scheduled",
      error: "authentication_failed"
    };
    const failed = guard.sanitizeProviderHookObservation(
      stopFailure,
      "claude-code",
      "2026-07-12T13:00:01.000Z"
    );
    const duplicate = guard.sanitizeProviderHookObservation(
      stopFailure,
      "claude-code",
      "2026-07-12T13:00:02.000Z"
    );
    const next = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "fixture-claude-failed-continuation-next"
    }, "claude-code", "2026-07-12T14:00:00.000Z");

    expect(failed?.queryOccurrences?.[0]).toMatchObject({
      queryId: initial?.queryOccurrences?.[0]?.queryId,
      startedAt: "2026-07-12T12:00:00.000Z",
      completionOutcome: "failure",
      completionFailureCategory: "authentication_failed"
    });
    expect(guard.countClaudeBackgroundRootsAwaitingTerminal(session)).toBe(0);
    expect(duplicate?.observationId).toBe(failed?.observationId);
    expect(next?.queryOccurrences?.[0]).toMatchObject({ startedAt: "2026-07-12T14:00:00.000Z" });
    expect(next?.queryOccurrences?.[0]?.queryId).not.toBe(initial?.queryOccurrences?.[0]?.queryId);
  });

  it("never resurrects an older completed Claude continuation alias", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-claude-completed-alias-session";
    const submit = (promptId: string, traceId: string, at: string) => {
      const hook = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: promptId
      }, "claude-code", at);
      sanitizeClaudeOccurrences(
        guard,
        claudePromptLogEnvelope({ sessionId: session, promptId, traceId, at }),
        "logs",
        at
      );
      return hook;
    };
    const complete = (
      promptId: string,
      traceId: string,
      startedAt: string,
      stoppedAt: string,
      completedAt: string
    ) => {
      expect(guard.sanitizeProviderHookObservation({
        hook_event_name: "Stop",
        session_id: session,
        prompt_id: promptId,
        background_tasks: [],
        session_crons: []
      }, "claude-code", stoppedAt)).toBeUndefined();
      return sanitizeClaudeOccurrences(
        guard,
        claudeClosedInteractionTraceEnvelope({ traceId, startedAt, completedAt }),
        "traces",
        completedAt
      );
    };

    const initial = submit(
      "fixture-claude-completed-alias-a",
      "fixture-claude-completed-alias-trace-a",
      "2026-07-12T15:00:00.000Z"
    );
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: "fixture-claude-completed-alias-a",
      background_tasks: [{ task_id: "fixture-completed-alias-task" }],
      session_crons: []
    }, "claude-code", "2026-07-12T15:00:00.900Z")).toBeUndefined();
    const continuation = submit(
      "fixture-claude-completed-alias-b",
      "fixture-claude-completed-alias-trace-b",
      "2026-07-12T15:00:01.000Z"
    );
    const firstTerminal = complete(
      "fixture-claude-completed-alias-b",
      "fixture-claude-completed-alias-trace-b",
      "2026-07-12T15:00:00.000Z",
      "2026-07-12T15:00:02.000Z",
      "2026-07-12T15:00:02.002Z"
    );
    const later = submit(
      "fixture-claude-completed-alias-c",
      "fixture-claude-completed-alias-trace-c",
      "2026-07-12T15:00:03.000Z"
    );
    const laterTerminal = complete(
      "fixture-claude-completed-alias-c",
      "fixture-claude-completed-alias-trace-c",
      "2026-07-12T15:00:03.000Z",
      "2026-07-12T15:00:04.000Z",
      "2026-07-12T15:00:04.002Z"
    );
    const lateOldAlias = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "fixture-claude-completed-alias-b"
    }, "claude-code", "2026-07-12T15:00:05.000Z");

    expect(continuation?.queryOccurrences?.[0]?.queryId).toBe(initial?.queryOccurrences?.[0]?.queryId);
    expect(firstTerminal[0]?.queryId).toBe(initial?.queryOccurrences?.[0]?.queryId);
    expect(later?.queryOccurrences?.[0]?.queryId).not.toBe(initial?.queryOccurrences?.[0]?.queryId);
    expect(laterTerminal[0]?.queryId).toBe(later?.queryOccurrences?.[0]?.queryId);
    expect(lateOldAlias).toBeUndefined();
  });

  it("does not fold a distinct manual Claude prompt without exact continuation authority", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-claude-manual-distinct-session";
    const initial = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "fixture-claude-manual-distinct-a"
    }, "claude-code", "2026-07-12T15:30:00.000Z");
    sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: "fixture-claude-manual-distinct-a",
        traceId: "fixture-claude-manual-distinct-trace-a",
        at: "2026-07-12T15:30:00.000Z"
      }),
      "logs",
      "2026-07-12T15:30:00.000Z"
    );
    const manualPromptOccurrence = sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: "fixture-claude-manual-distinct-b",
        traceId: "fixture-claude-manual-distinct-trace-b",
        at: "2026-07-12T15:30:00.900Z"
      }),
      "logs",
      "2026-07-12T15:30:00.900Z"
    )[0];
    const manualNext = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "fixture-claude-manual-distinct-b"
    }, "claude-code", "2026-07-12T15:30:01.000Z");
    const nextTool = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: session,
      tool_name: "Read",
      tool_use_id: "fixture-claude-manual-distinct-tool-b",
      tool_response: { success: true }
    }, "claude-code", "2026-07-12T15:30:02.000Z");

    expect(manualNext?.queryOccurrences?.[0]).toMatchObject({
      startedAt: "2026-07-12T15:30:01.000Z"
    });
    expect(manualPromptOccurrence?.queryId).toBe(manualNext?.queryOccurrences?.[0]?.queryId);
    expect(manualNext?.queryOccurrences?.[0]?.queryId).not.toBe(initial?.queryOccurrences?.[0]?.queryId);
    expect(nextTool?.activityAtoms?.[0]?.queryId).toBe(manualNext?.queryOccurrences?.[0]?.queryId);
  });

  it("never retroactively folds a prompt that precedes its delayed background Stop", () => {
    const runScenario = (closeBeforePrompt: boolean) => {
      const guard = new DefaultAgentPrivacyGuard();
      const suffix = closeBeforePrompt ? "close-first" : "open";
      const session = `fixture-claude-delayed-background-session-${suffix}`;
      const promptA = `fixture-claude-delayed-background-a-${suffix}`;
      const promptB = `fixture-claude-delayed-background-b-${suffix}`;
      const traceA = `fixture-claude-delayed-background-trace-a-${suffix}`;
      const initial = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: promptA
      }, "claude-code", "2026-07-12T15:45:00.000Z");
      sanitizeClaudeOccurrences(
        guard,
        claudePromptLogEnvelope({
          sessionId: session,
          promptId: promptA,
          traceId: traceA,
          at: "2026-07-12T15:45:00.000Z"
        }),
        "logs",
        "2026-07-12T15:45:00.000Z"
      );
      const delayedClose = () => sanitizeClaudeOccurrences(
        guard,
        claudeClosedInteractionTraceEnvelope({
          traceId: traceA,
          startedAt: "2026-07-12T15:45:00.000Z",
          completedAt: "2026-07-12T15:45:01.002Z"
        }),
        "traces",
        "2026-07-12T15:45:01.002Z"
      );
      if (closeBeforePrompt) {
        expect(delayedClose()).toEqual([]);
      }
      const next = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: promptB
      }, "claude-code", "2026-07-12T15:45:01.100Z");
      expect(guard.sanitizeProviderHookObservation({
        hook_event_name: "Stop",
        session_id: session,
        prompt_id: promptA,
        background_tasks: [{ task_id: "fixture-delayed-background-task" }],
        session_crons: []
      }, "claude-code", "2026-07-12T15:45:01.000Z")).toBeUndefined();
      if (!closeBeforePrompt) {
        expect(delayedClose()).toEqual([]);
      }
      expect(guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: promptA
      }, "claude-code", "2026-07-12T15:45:01.500Z")).toBeUndefined();
      const nextTool = guard.sanitizeProviderHookObservation({
        hook_event_name: "PostToolUse",
        session_id: session,
        tool_name: "Read",
        tool_use_id: `fixture-claude-delayed-background-tool-${suffix}`,
        tool_response: { success: true }
      }, "claude-code", "2026-07-12T15:45:02.000Z");

      expect(next?.queryOccurrences?.[0]?.queryId).not.toBe(initial?.queryOccurrences?.[0]?.queryId);
      expect(nextTool?.activityAtoms?.[0]?.queryId).toBe(next?.queryOccurrences?.[0]?.queryId);
    };

    runScenario(false);
    runScenario(true);
  });

  it("starts a distinct Claude query after either exact ordinary terminal half", () => {
    const runScenario = (closeFirst: boolean) => {
      const guard = new DefaultAgentPrivacyGuard();
      const suffix = closeFirst ? "close-first" : "stop-first";
      const session = `fixture-claude-terminal-half-session-${suffix}`;
      const promptA = `fixture-claude-terminal-half-a-${suffix}`;
      const promptB = `fixture-claude-terminal-half-b-${suffix}`;
      const traceA = `fixture-claude-terminal-half-trace-a-${suffix}`;
      const startedAt = "2026-07-12T16:00:00.000Z";
      const stoppedAt = "2026-07-12T16:00:02.000Z";
      const completedAt = "2026-07-12T16:00:02.002Z";
      const initial = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: promptA
      }, "claude-code", startedAt);
      sanitizeClaudeOccurrences(
        guard,
        claudePromptLogEnvelope({ sessionId: session, promptId: promptA, traceId: traceA, at: startedAt }),
        "logs",
        startedAt
      );
      const stop = () => guard.sanitizeProviderHookObservation({
        hook_event_name: "Stop",
        session_id: session,
        prompt_id: promptA,
        background_tasks: [],
        session_crons: []
      }, "claude-code", stoppedAt);
      const close = () => sanitizeClaudeOccurrences(
        guard,
        claudeClosedInteractionTraceEnvelope({ traceId: traceA, startedAt, completedAt }),
        "traces",
        completedAt
      );

      if (closeFirst) {
        expect(close()).toEqual([]);
      } else {
        expect(stop()).toBeUndefined();
      }
      const next = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: promptB
      }, "claude-code", "2026-07-12T16:00:02.100Z");
      const terminal = closeFirst ? stop()?.queryOccurrences ?? [] : close();
      const nextTool = guard.sanitizeProviderHookObservation({
        hook_event_name: "PostToolUse",
        session_id: session,
        tool_name: "Read",
        tool_use_id: `fixture-claude-terminal-half-tool-${suffix}`,
        tool_response: { success: true }
      }, "claude-code", "2026-07-12T16:00:02.200Z");

      expect(next?.queryOccurrences?.[0]?.queryId).not.toBe(initial?.queryOccurrences?.[0]?.queryId);
      expect(terminal).toEqual([expect.objectContaining({
        queryId: initial?.queryOccurrences?.[0]?.queryId,
        startedAt,
        completedAt
      })]);
      expect(nextTool?.activityAtoms?.[0]?.queryId).toBe(next?.queryOccurrences?.[0]?.queryId);
    };

    runScenario(false);
    runScenario(true);
  });

  it("keeps background-paused Claude physical interactions continuation-eligible in every reorder", () => {
    const runScenario = (order: "stop-close-hook" | "close-stop-hook" | "stop-hook-close") => {
      const guard = new DefaultAgentPrivacyGuard();
      const session = `fixture-claude-background-session-${order}`;
      const promptA = `fixture-claude-background-a-${order}`;
      const promptB = `fixture-claude-background-b-${order}`;
      const traceA = `fixture-claude-background-trace-a-${order}`;
      const traceB = `fixture-claude-background-trace-b-${order}`;
      const startedAt = "2026-07-12T17:00:00.000Z";
      const pausedAt = "2026-07-12T17:00:01.000Z";
      const pausedCloseAt = "2026-07-12T17:00:01.002Z";
      const initial = guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: promptA
      }, "claude-code", startedAt);
      sanitizeClaudeOccurrences(
        guard,
        claudePromptLogEnvelope({ sessionId: session, promptId: promptA, traceId: traceA, at: startedAt }),
        "logs",
        startedAt
      );
      const backgroundStop = () => guard.sanitizeProviderHookObservation({
        hook_event_name: "Stop",
        session_id: session,
        prompt_id: promptA,
        background_tasks: [{ task_id: "fixture-background-task" }],
        session_crons: []
      }, "claude-code", pausedAt);
      const pausedClose = () => sanitizeClaudeOccurrences(
        guard,
        claudeClosedInteractionTraceEnvelope({
          traceId: traceA,
          startedAt,
          completedAt: pausedCloseAt
        }),
        "traces",
        pausedCloseAt
      );
      const continuationHook = () => guard.sanitizeProviderHookObservation({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: promptB
      }, "claude-code", "2026-07-12T17:00:01.100Z");

      let continuation;
      if (order === "stop-close-hook") {
        expect(backgroundStop()).toBeUndefined();
        expect(pausedClose()).toEqual([]);
        continuation = continuationHook();
      } else if (order === "close-stop-hook") {
        expect(pausedClose()).toEqual([]);
        expect(backgroundStop()).toBeUndefined();
        continuation = continuationHook();
      } else {
        expect(backgroundStop()).toBeUndefined();
        continuation = continuationHook();
        expect(pausedClose()).toEqual([]);
      }
      sanitizeClaudeOccurrences(
        guard,
        claudePromptLogEnvelope({
          sessionId: session,
          promptId: promptB,
          traceId: traceB,
          at: "2026-07-12T17:00:01.110Z"
        }),
        "logs",
        "2026-07-12T17:00:01.110Z"
      );
      const tool = guard.sanitizeProviderHookObservation({
        hook_event_name: "PostToolUse",
        session_id: session,
        tool_name: "Read",
        tool_use_id: `fixture-claude-background-tool-${order}`,
        tool_response: { success: true }
      }, "claude-code", "2026-07-12T17:00:01.200Z");
      expect(guard.sanitizeProviderHookObservation({
        hook_event_name: "Stop",
        session_id: session,
        prompt_id: promptB,
        background_tasks: [],
        session_crons: []
      }, "claude-code", "2026-07-12T17:00:02.000Z")).toBeUndefined();
      const terminal = sanitizeClaudeOccurrences(
        guard,
        claudeClosedInteractionTraceEnvelope({
          traceId: traceB,
          startedAt,
          completedAt: "2026-07-12T17:00:02.002Z"
        }),
        "traces",
        "2026-07-12T17:00:02.002Z"
      );

      expect(continuation?.queryOccurrences?.[0]?.queryId).toBe(initial?.queryOccurrences?.[0]?.queryId);
      expect(tool?.activityAtoms?.[0]?.queryId).toBe(initial?.queryOccurrences?.[0]?.queryId);
      expect(terminal).toEqual([expect.objectContaining({
        queryId: initial?.queryOccurrences?.[0]?.queryId,
        completedAt: "2026-07-12T17:00:02.002Z"
      })]);
    };

    runScenario("stop-close-hook");
    runScenario("close-stop-hook");
    runScenario("stop-hook-close");
  });

  it("resolves production Claude submission provenance without retaining transcript content", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "PRIVATE_PROVENANCE_SESSION_CANARY";
    const transcriptPrompt = "PRIVATE_PROVENANCE_PROMPT_CANARY";
    const observedAt = "2026-07-12T20:00:00.200Z";
    const annotated = guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: "/Users/private/.claude/projects/private.jsonl",
      prompt: "PRIVATE_HUMAN_PROMPT_CONTENT_CANARY"
    }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
      sessionId: session,
      promptId: transcriptPrompt,
      timestamp: "2026-07-12T20:00:00.100Z",
      originKind: "human",
      promptSource: "typed",
      content: "PRIVATE_HUMAN_PROMPT_CONTENT_CANARY"
    })), observedAt);
    const observation = guard.sanitizeProviderHookObservation(
      annotated,
      "claude-code",
      observedAt
    );

    expect(observation?.queryOccurrences).toEqual([expect.objectContaining({
      evidence: "submission_hook",
      startedAt: observedAt
    })]);
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("PRIVATE_HUMAN_PROMPT_CONTENT_CANARY");
    expect(serialized).not.toContain(session);
    expect(serialized).not.toContain(transcriptPrompt);
    expect(serialized).not.toContain("/Users/private");
  });

  it("fails closed on unavailable or equally-near Claude transcript provenance", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-claude-provenance-ambiguous-session";
    const observedAt = "2026-07-12T20:10:01.000Z";
    const hook = {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "fixture-raw-prompt-mismatch"
    };

    const unavailable = guard.annotateClaudeProviderHook(
      hook,
      { state: "unavailable" },
      observedAt
    );
    const ambiguous = guard.annotateClaudeProviderHook(hook, availableClaudeTranscriptTail(
      claudeTranscriptUserRecord({
        sessionId: session,
        promptId: "fixture-nearest-left",
        timestamp: "2026-07-12T20:10:00.900Z",
        originKind: "human",
        promptSource: "typed"
      }),
      claudeTranscriptUserRecord({
        sessionId: session,
        promptId: "fixture-nearest-right",
        timestamp: "2026-07-12T20:10:01.100Z",
        originKind: "task-notification",
        promptSource: "system"
      })
    ), observedAt);

    expect(unavailable).toMatchObject({
      tirion_claude_submission_provenance: {
        state: "unavailable",
        diagnosticReason: "transcript_read_unavailable"
      }
    });
    expect(ambiguous).toMatchObject({
      tirion_claude_submission_provenance: {
        state: "ambiguous",
        diagnosticReason: "candidate_ambiguous"
      }
    });
    expect(guard.sanitizeProviderHookObservation(
      unavailable,
      "claude-code",
      observedAt
    )).toBeUndefined();
    expect(guard.sanitizeProviderHookObservation(
      ambiguous,
      "claude-code",
      observedAt
    )).toBeUndefined();
  });

  it("retains only fixed non-content Claude transcript failure reasons", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const observedAt = "2026-07-12T20:10:02.000Z";
    const hook = {
      hook_event_name: "UserPromptSubmit",
      session_id: "fixture-claude-transcript-reason-session"
    };
    const stableReadRace = guard.annotateClaudeProviderHook(
      hook,
      { state: "unavailable", diagnosticReason: "transcript_read_unstable" },
      observedAt
    );
    const privateCanary = "PRIVATE_CLAUDE_TRANSCRIPT_REASON_CANARY";
    const forgedReason = guard.annotateClaudeProviderHook(
      hook,
      {
        state: "unavailable",
        diagnosticReason: privateCanary
      } as unknown as ClaudeTranscriptTailInput,
      observedAt
    );

    expect(stableReadRace).toMatchObject({
      tirion_claude_submission_provenance: {
        state: "unavailable",
        diagnosticReason: "transcript_read_unstable"
      }
    });
    expect(forgedReason).toMatchObject({
      tirion_claude_submission_provenance: {
        state: "unavailable",
        diagnosticReason: "transcript_read_unavailable"
      }
    });
    expect(JSON.stringify([stableReadRace, forgedReason])).not.toContain(privateCanary);
  });

  it("distinguishes Claude transcript origin and prompt-source failures without retaining their values", () => {
    const observedAt = "2026-07-12T20:10:03.000Z";
    const privateCanary = "PRIVATE_CLAUDE_TRANSCRIPT_ORIGIN_SHAPE_CANARY";
    const cases: Array<{
      expected: string;
      mutate: (record: Record<string, unknown>) => void;
    }> = [
      {
        expected: "transcript_origin_kind_missing",
        mutate: (record) => { delete record.origin; }
      },
      {
        expected: "transcript_origin_kind_unrecognized",
        mutate: (record) => { record.origin = { kind: privateCanary }; }
      },
      {
        expected: "transcript_prompt_source_missing",
        mutate: (record) => { delete record.promptSource; }
      },
      {
        expected: "transcript_prompt_source_unrecognized",
        mutate: (record) => { record.promptSource = privateCanary; }
      },
      {
        expected: "transcript_origin_prompt_source_incompatible",
        mutate: (record) => { record.promptSource = "system"; }
      }
    ];

    for (const [index, fixture] of cases.entries()) {
      const guard = new DefaultAgentPrivacyGuard();
      const promptId = `fixture-claude-origin-shape-${index}`;
      const record = claudeTranscriptUserRecord({
        sessionId: "fixture-claude-origin-shape-session",
        promptId,
        timestamp: observedAt,
        originKind: "human",
        promptSource: "typed"
      });
      fixture.mutate(record);
      const annotated = guard.annotateClaudeProviderHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "fixture-claude-origin-shape-session",
        prompt_id: promptId
      }, availableClaudeTranscriptTail(record), observedAt);

      expect(annotated).toMatchObject({
        tirion_claude_submission_provenance: {
          state: "unavailable",
          diagnosticReason: fixture.expected
        }
      });
      expect(guard.sanitizeProviderHookObservation(
        annotated,
        "claude-code",
        observedAt
      )).toBeUndefined();
      expect(JSON.stringify(annotated)).not.toContain(privateCanary);
    }
  });

  it("accepts the existing snake_case Claude transcript prompt-source alias", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const observedAt = "2026-07-12T20:10:04.000Z";
    const record = claudeTranscriptUserRecord({
      sessionId: "fixture-claude-snake-source-session",
      promptId: "fixture-claude-snake-source-prompt",
      timestamp: observedAt,
      originKind: "human",
      promptSource: "typed"
    });
    record.prompt_source = record.promptSource;
    delete record.promptSource;
    const annotated = guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "fixture-claude-snake-source-session",
      prompt_id: "fixture-claude-snake-source-prompt"
    }, availableClaudeTranscriptTail(record), observedAt);

    expect(annotated).toMatchObject({
      tirion_claude_submission_provenance: {
        state: "resolved",
        originKind: "human",
        promptSource: "typed"
      }
    });
    expect(guard.sanitizeProviderHookObservation(
      annotated,
      "claude-code",
      observedAt
    )).toBeDefined();
  });

  it("preflights every Claude prompt alias before atomically correlating any alias", () => {
    type PromptCorrelation = {
      state: "resolved" | "conflict";
      value?: { query: string; session: string };
    };
    const promptCorrelations = (guard: DefaultAgentPrivacyGuard) => (
      guard as unknown as { claudeQueriesByPrompt: Map<string, PromptCorrelation> }
    ).claudeQueriesByPrompt;
    const annotate = (
      guard: DefaultAgentPrivacyGuard,
      sessionId: string,
      rawPrompt: string,
      transcriptPrompt: string,
      at: string,
      originKind: "human" | "task-notification",
      promptSource: "typed" | "system"
    ) => guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt_id: rawPrompt
    }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
      sessionId,
      promptId: transcriptPrompt,
      timestamp: at,
      originKind,
      promptSource
    })), at);

    const humanGuard = new DefaultAgentPrivacyGuard();
    const humanSession = "fixture-human-alias-atomic-session";
    expect(humanGuard.sanitizeProviderHookObservation(
      annotate(
        humanGuard,
        humanSession,
        "fixture-human-existing-raw-alias",
        "fixture-human-existing-transcript-alias",
        "2026-07-12T20:20:00.000Z",
        "human",
        "typed"
      ),
      "claude-code",
      "2026-07-12T20:20:00.000Z"
    )).toBeDefined();
    expect(humanGuard.sanitizeProviderHookObservation(
      annotate(
        humanGuard,
        humanSession,
        "fixture-human-existing-raw-alias",
        "fixture-human-new-transcript-alias",
        "2026-07-12T20:20:01.000Z",
        "human",
        "typed"
      ),
      "claude-code",
      "2026-07-12T20:20:01.000Z"
    )).toBeUndefined();
    expect(promptCorrelations(humanGuard).get("fixture-human-new-transcript-alias"))
      .toEqual({ state: "conflict" });
    expect(promptCorrelations(humanGuard).get("fixture-human-existing-raw-alias"))
      .toEqual({ state: "conflict" });

    const taskGuard = new DefaultAgentPrivacyGuard();
    const taskSession = "fixture-task-alias-atomic-session";
    const first = taskGuard.sanitizeProviderHookObservation(
      annotate(
        taskGuard,
        taskSession,
        "fixture-task-a-raw",
        "fixture-task-a-transcript",
        "2026-07-12T20:30:00.000Z",
        "human",
        "typed"
      ),
      "claude-code",
      "2026-07-12T20:30:00.000Z"
    );
    expect(taskGuard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: taskSession,
      prompt_id: "fixture-task-a-raw",
      background_tasks: [{ task_id: "fixture-task-a" }]
    }, "claude-code", "2026-07-12T20:30:01.000Z")).toBeUndefined();
    const second = taskGuard.sanitizeProviderHookObservation(
      annotate(
        taskGuard,
        taskSession,
        "fixture-task-b-raw",
        "fixture-task-conflicting-transcript-alias",
        "2026-07-12T20:30:02.000Z",
        "human",
        "typed"
      ),
      "claude-code",
      "2026-07-12T20:30:02.000Z"
    );
    expect(taskGuard.sanitizeProviderHookObservation(
      annotate(
        taskGuard,
        taskSession,
        "fixture-task-new-raw-alias",
        "fixture-task-conflicting-transcript-alias",
        "2026-07-12T20:30:03.000Z",
        "task-notification",
        "system"
      ),
      "claude-code",
      "2026-07-12T20:30:03.000Z"
    )).toBeUndefined();
    expect(first?.queryOccurrences?.[0]?.queryId)
      .not.toBe(second?.queryOccurrences?.[0]?.queryId);
    expect(promptCorrelations(taskGuard).get("fixture-task-new-raw-alias"))
      .toEqual({ state: "conflict" });
    expect(promptCorrelations(taskGuard).get("fixture-task-conflicting-transcript-alias"))
      .toEqual({ state: "conflict" });
  });

  it("keeps the CC06-R task-notification sequence inside one public Claude lifecycle", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-cc06-r-session";
    const rootPrompt = "fixture-cc06-r-root";
    const trace = "fixture-cc06-r-trace";
    const taskTrace = "fixture-cc06-r-task-trace";
    const startedAt = "2026-07-12T21:58:20.725Z";
    const rootHook = guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: rootPrompt
    }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
      sessionId: session,
      promptId: rootPrompt,
      timestamp: startedAt,
      originKind: "human",
      promptSource: "typed"
    })), startedAt);
    const initial = guard.sanitizeProviderHookObservation(rootHook, "claude-code", startedAt);
    sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({ sessionId: session, promptId: rootPrompt, traceId: trace, at: startedAt }),
      "logs",
      startedAt
    );

    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: rootPrompt,
      background_tasks: [{ task_id: "one" }, { task_id: "two" }, { task_id: "three" }],
      session_crons: []
    }, "claude-code", "2026-07-12T21:58:27.767Z")).toBeUndefined();

    const taskOne = guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "fixture-cc06-r-task-raw"
    }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
      sessionId: session,
      promptId: "fixture-cc06-r-task-transcript",
      timestamp: "2026-07-12T21:58:28.356Z",
      originKind: "task-notification",
      promptSource: "system"
    })), "2026-07-12T21:58:28.356Z");
    expect(guard.sanitizeProviderHookObservation(
      taskOne,
      "claude-code",
      "2026-07-12T21:58:28.356Z"
    )).toBeUndefined();
    sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: "fixture-cc06-r-task-transcript",
        traceId: taskTrace,
        at: "2026-07-12T21:58:28.525Z"
      }),
      "logs",
      "2026-07-12T21:58:28.525Z"
    );

    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: "fixture-cc06-r-task-raw",
      background_tasks: [],
      session_crons: []
    }, "claude-code", "2026-07-12T21:58:30.563Z")).toBeUndefined();
    const terminal = sanitizeClaudeOccurrences(
      guard,
      claudeClosedInteractionTraceEnvelope({
        traceId: taskTrace,
        startedAt,
        completedAt: "2026-07-12T21:58:30.567Z"
      }),
      "traces",
      "2026-07-12T21:58:30.567Z"
    );

    const duplicateTranscriptPrompt = "fixture-cc06-r-duplicate-transcript-prompt";
    const lateMismatched = guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "fixture-cc06-r-mismatched-raw-prompt"
    }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
      sessionId: session,
      promptId: duplicateTranscriptPrompt,
      timestamp: "2026-07-12T21:58:30.580Z",
      originKind: "task-notification",
      promptSource: "system"
    })), "2026-07-12T21:58:30.583Z");
    const lateDuplicate = guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: duplicateTranscriptPrompt
    }, availableClaudeTranscriptTail(
      claudeTranscriptUserRecord({
        sessionId: session,
        promptId: duplicateTranscriptPrompt,
        timestamp: "2026-07-12T21:58:30.580Z",
        originKind: "task-notification",
        promptSource: "system"
      }),
      claudeTranscriptUserRecord({
        sessionId: session,
        promptId: duplicateTranscriptPrompt,
        timestamp: "2026-07-12T21:58:30.618Z",
        originKind: "task-notification",
        promptSource: "system"
      })
    ), "2026-07-12T21:58:30.619Z");
    expect(guard.sanitizeProviderHookObservation(
      lateMismatched,
      "claude-code",
      "2026-07-12T21:58:30.583Z"
    )).toBeUndefined();
    expect(guard.sanitizeProviderHookObservation(
      lateDuplicate,
      "claude-code",
      "2026-07-12T21:58:30.619Z"
    )).toBeUndefined();

    const lateOccurrences = sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: "fixture-cc06-r-mismatched-raw-prompt",
        traceId: "fixture-cc06-r-late-trace",
        at: "2026-07-12T22:01:00.000Z"
      }),
      "logs",
      "2026-07-12T22:01:00.000Z"
    );
    const publicLifecycle = [
      ...(initial?.queryOccurrences ?? []),
      ...terminal,
      ...lateOccurrences
    ].filter((occurrence) => occurrence.lifecycleVisibility !== "internal");
    const queryIds = new Set(publicLifecycle.map((occurrence) => occurrence.queryId));

    expect(initial?.queryOccurrences).toHaveLength(1);
    expect(terminal).toEqual([expect.objectContaining({
      queryId: initial?.queryOccurrences?.[0]?.queryId,
      startedAt,
      completedAt: "2026-07-12T21:58:30.567Z"
    })]);
    expect(queryIds).toEqual(new Set([initial?.queryOccurrences?.[0]?.queryId]));
    expect(new Set(publicLifecycle
      .filter((occurrence) => occurrence.completedAt == null)
      .map((occurrence) => occurrence.queryId))).toHaveLength(1);
    expect(publicLifecycle.filter((occurrence) => occurrence.completedAt != null)).toHaveLength(1);
  });

  it("invalidates an intermediate Claude Stop when a delayed task notification follows it", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-cc06-rr-session";
    const rootPrompt = "fixture-cc06-rr-root";
    const rootTrace = "fixture-cc06-rr-root-trace";
    const firstTaskPrompt = "fixture-cc06-rr-task-one";
    const firstTaskTrace = "fixture-cc06-rr-task-one-trace";
    const lateTaskPrompt = "fixture-cc06-rr-task-late";
    const lateTaskTrace = "fixture-cc06-rr-task-late-trace";
    const startedAt = "2026-07-12T22:46:34.165Z";
    const annotate = (
      promptId: string,
      at: string,
      originKind: "human" | "task-notification",
      promptSource: "typed" | "system"
    ) => guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: promptId
    }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
      sessionId: session,
      promptId,
      timestamp: at,
      originKind,
      promptSource
    })), at);

    const root = guard.sanitizeProviderHookObservation(
      annotate(rootPrompt, startedAt, "human", "typed"),
      "claude-code",
      startedAt
    );
    sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({ sessionId: session, promptId: rootPrompt, traceId: rootTrace, at: startedAt }),
      "logs",
      startedAt
    );
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: rootPrompt,
      background_tasks: [{ task_id: "one" }, { task_id: "two" }]
    }, "claude-code", "2026-07-12T22:46:40.953Z")).toBeUndefined();

    expect(guard.sanitizeProviderHookObservation(
      annotate(firstTaskPrompt, "2026-07-12T22:46:40.980Z", "task-notification", "system"),
      "claude-code",
      "2026-07-12T22:46:40.980Z"
    )).toBeUndefined();
    const firstTask = sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: firstTaskPrompt,
        traceId: firstTaskTrace,
        at: "2026-07-12T22:46:40.980Z"
      }),
      "logs",
      "2026-07-12T22:46:40.980Z"
    );

    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: firstTaskPrompt,
      background_tasks: [],
      session_crons: []
    }, "claude-code", "2026-07-12T22:46:43.453Z")).toBeUndefined();
    expect(guard.sanitizeProviderHookObservation(
      annotate(lateTaskPrompt, "2026-07-12T22:46:43.475Z", "task-notification", "system"),
      "claude-code",
      "2026-07-12T22:46:43.475Z"
    )).toBeUndefined();
    const lateTask = sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: lateTaskPrompt,
        traceId: lateTaskTrace,
        at: "2026-07-12T22:46:43.475Z"
      }),
      "logs",
      "2026-07-12T22:46:43.475Z"
    );
    const supersededClose = sanitizeClaudeOccurrences(
      guard,
      claudeClosedInteractionTraceEnvelope({
        traceId: firstTaskTrace,
        startedAt,
        completedAt: "2026-07-12T22:46:43.473Z"
      }),
      "traces",
      "2026-07-12T22:46:44.367Z"
    );

    expect(supersededClose).toEqual([]);
    expect(firstTask[0]?.queryId).toBe(root?.queryOccurrences?.[0]?.queryId);
    expect(lateTask[0]?.queryId).toBe(root?.queryOccurrences?.[0]?.queryId);
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: lateTaskPrompt,
      background_tasks: [],
      session_crons: []
    }, "claude-code", "2026-07-12T22:46:46.829Z")).toBeUndefined();
    const terminal = sanitizeClaudeOccurrences(
      guard,
      claudeClosedInteractionTraceEnvelope({
        traceId: lateTaskTrace,
        startedAt,
        completedAt: "2026-07-12T22:46:46.840Z"
      }),
      "traces",
      "2026-07-12T22:46:46.900Z"
    );
    expect(terminal).toEqual([expect.objectContaining({
      queryId: root?.queryOccurrences?.[0]?.queryId,
      startedAt,
      completedAt: "2026-07-12T22:46:46.840Z"
    })]);
  });

  it("keeps close-first and older-Stop reorderings behind the newest task-notification floor", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-cc06-rr-reordered-session";
    const rootPrompt = "fixture-cc06-rr-reordered-root";
    const startedAt = "2026-07-12T22:46:34.165Z";
    const annotateTask = (promptId: string, at: string) => guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: promptId
    }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
      sessionId: session,
      promptId,
      timestamp: at,
      originKind: "task-notification",
      promptSource: "system"
    })), at);
    const root = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: rootPrompt
    }, "claude-code", startedAt);
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: rootPrompt,
      background_tasks: [{ task_id: "one" }]
    }, "claude-code", "2026-07-12T22:46:40.953Z")).toBeUndefined();

    const firstTaskPrompt = "fixture-cc06-rr-reordered-task-one";
    const firstTaskTrace = "fixture-cc06-rr-reordered-task-one-trace";
    guard.sanitizeProviderHookObservation(
      annotateTask(firstTaskPrompt, "2026-07-12T22:46:40.980Z"),
      "claude-code",
      "2026-07-12T22:46:40.980Z"
    );
    sanitizeClaudeOccurrences(guard, claudePromptLogEnvelope({
      sessionId: session,
      promptId: firstTaskPrompt,
      traceId: firstTaskTrace,
      at: "2026-07-12T22:46:40.980Z"
    }), "logs", "2026-07-12T22:46:40.980Z");
    expect(sanitizeClaudeOccurrences(guard, claudeClosedInteractionTraceEnvelope({
      traceId: firstTaskTrace,
      startedAt,
      completedAt: "2026-07-12T22:46:43.473Z"
    }), "traces", "2026-07-12T22:46:44.367Z")).toEqual([]);

    const secondTaskPrompt = "fixture-cc06-rr-reordered-task-two";
    const finalTaskPrompt = "fixture-cc06-rr-reordered-task-three";
    const finalTaskTrace = "fixture-cc06-rr-reordered-task-three-trace";
    guard.sanitizeProviderHookObservation(
      annotateTask(secondTaskPrompt, "2026-07-12T22:46:43.475Z"),
      "claude-code",
      "2026-07-12T22:46:43.475Z"
    );
    guard.sanitizeProviderHookObservation(
      annotateTask(finalTaskPrompt, "2026-07-12T22:46:43.478Z"),
      "claude-code",
      "2026-07-12T22:46:43.478Z"
    );
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: firstTaskPrompt,
      background_tasks: []
    }, "claude-code", "2026-07-12T22:46:43.477Z")).toBeUndefined();
    sanitizeClaudeOccurrences(guard, claudePromptLogEnvelope({
      sessionId: session,
      promptId: finalTaskPrompt,
      traceId: finalTaskTrace,
      at: "2026-07-12T22:46:43.478Z"
    }), "logs", "2026-07-12T22:46:43.478Z");
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: finalTaskPrompt,
      background_tasks: []
    }, "claude-code", "2026-07-12T22:46:46.829Z")).toBeUndefined();
    const terminal = sanitizeClaudeOccurrences(guard, claudeClosedInteractionTraceEnvelope({
      traceId: finalTaskTrace,
      startedAt,
      completedAt: "2026-07-12T22:46:46.840Z"
    }), "traces", "2026-07-12T22:46:46.900Z");
    expect(terminal).toEqual([expect.objectContaining({
      queryId: root?.queryOccurrences?.[0]?.queryId,
      completedAt: "2026-07-12T22:46:46.840Z"
    })]);
  });

  it("does not let a newer manual Claude query steal delayed task notifications", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-claude-task-target-session";
    const annotate = (
      rawPrompt: string,
      transcriptPrompt: string,
      at: string,
      originKind: "human" | "task-notification",
      promptSource: "typed" | "system"
    ) => guard.annotateClaudeProviderHook({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: rawPrompt
    }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
      sessionId: session,
      promptId: transcriptPrompt,
      timestamp: at,
      originKind,
      promptSource
    })), at);

    const first = guard.sanitizeProviderHookObservation(
      annotate("raw-a", "prompt-a", "2026-07-12T21:00:00.000Z", "human", "typed"),
      "claude-code",
      "2026-07-12T21:00:00.000Z"
    );
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: "raw-a",
      background_tasks: [{ task_id: "task-a" }]
    }, "claude-code", "2026-07-12T21:00:01.000Z")).toBeUndefined();
    const second = guard.sanitizeProviderHookObservation(
      annotate("raw-b", "prompt-b", "2026-07-12T21:00:02.000Z", "human", "typed"),
      "claude-code",
      "2026-07-12T21:00:02.000Z"
    );
    expect(guard.sanitizeProviderHookObservation(
      annotate("late-task-a-raw", "late-task-a", "2026-07-12T21:00:03.000Z", "task-notification", "system"),
      "claude-code",
      "2026-07-12T21:00:03.000Z"
    )).toBeUndefined();
    const delayedA = sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: "late-task-a-raw",
        traceId: "late-task-a-trace",
        at: "2026-07-12T21:00:03.100Z"
      }),
      "logs",
      "2026-07-12T21:00:03.100Z"
    );

    expect(delayedA[0]?.queryId).toBe(first?.queryOccurrences?.[0]?.queryId);
    expect(delayedA[0]?.queryId).not.toBe(second?.queryOccurrences?.[0]?.queryId);

    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: "raw-b",
      background_tasks: [{ task_id: "task-b" }]
    }, "claude-code", "2026-07-12T21:00:04.000Z")).toBeUndefined();
    expect(guard.sanitizeProviderHookObservation(
      annotate("task-b-raw", "task-b-prompt", "2026-07-12T21:00:05.000Z", "task-notification", "system"),
      "claude-code",
      "2026-07-12T21:00:05.000Z"
    )).toBeUndefined();
    const taskB = sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: "task-b-prompt",
        traceId: "task-b-trace",
        at: "2026-07-12T21:00:05.100Z"
      }),
      "logs",
      "2026-07-12T21:00:05.100Z"
    );
    expect(taskB[0]?.queryId).toBe(second?.queryOccurrences?.[0]?.queryId);
  });

  it("keeps the active Claude hook authoritative over a late completed OTLP pointer", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-claude-late-pointer-session";
    const promptA = "fixture-claude-late-pointer-a";
    const promptC = "fixture-claude-late-pointer-c";
    const traceA = "fixture-claude-late-pointer-trace-a";
    const initial = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: promptA
    }, "claude-code", "2026-07-12T18:00:00.000Z");
    sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: promptA,
        traceId: traceA,
        at: "2026-07-12T18:00:00.000Z"
      }),
      "logs",
      "2026-07-12T18:00:00.000Z"
    );
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: promptA,
      background_tasks: [],
      session_crons: []
    }, "claude-code", "2026-07-12T18:00:01.000Z")).toBeUndefined();
    sanitizeClaudeOccurrences(
      guard,
      claudeClosedInteractionTraceEnvelope({
        traceId: traceA,
        startedAt: "2026-07-12T18:00:00.000Z",
        completedAt: "2026-07-12T18:00:01.002Z"
      }),
      "traces",
      "2026-07-12T18:00:01.002Z"
    );
    const current = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: promptC
    }, "claude-code", "2026-07-12T18:00:02.000Z");
    const lateOldOccurrence = sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: promptA,
        traceId: traceA,
        at: "2026-07-12T18:00:03.000Z"
      }),
      "logs",
      "2026-07-12T18:00:03.000Z"
    )[0];
    const currentTool = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: session,
      tool_name: "Read",
      tool_use_id: "fixture-claude-late-pointer-tool-c",
      tool_response: { success: true }
    }, "claude-code", "2026-07-12T18:00:04.000Z");

    expect(lateOldOccurrence?.queryId).toBe(initial?.queryOccurrences?.[0]?.queryId);
    expect(current?.queryOccurrences?.[0]?.queryId).not.toBe(initial?.queryOccurrences?.[0]?.queryId);
    expect(currentTool?.activityAtoms?.[0]?.queryId).toBe(current?.queryOccurrences?.[0]?.queryId);
  });

  it("enriches Claude StopFailure category without moving or weakening its first terminal boundary", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-claude-stop-failure-enrichment-session";
    const prompt = "fixture-claude-stop-failure-enrichment-prompt";
    const startedAt = "2026-07-12T19:00:00.000Z";
    const firstCompletedAt = "2026-07-12T19:00:01.000Z";
    const initial = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: prompt
    }, "claude-code", startedAt);
    const failure = (error: string, observedAt: string) => guard.sanitizeProviderHookObservation({
      hook_event_name: "StopFailure",
      session_id: session,
      prompt_id: prompt,
      error
    }, "claude-code", observedAt);
    const unknown = failure("fixture-unclassified-provider-error", firstCompletedAt);
    const enriched = failure("authentication_failed", "2026-07-12T19:00:02.000Z");
    const laterUnknown = failure("fixture-later-unclassified-error", "2026-07-12T19:00:03.000Z");
    const conflictingKnown = failure("rate_limit", "2026-07-12T19:00:04.000Z");

    expect(unknown?.queryOccurrences?.[0]).toMatchObject({
      queryId: initial?.queryOccurrences?.[0]?.queryId,
      startedAt,
      completedAt: firstCompletedAt,
      completionOutcome: "failure",
      completionFailureCategory: "unknown"
    });
    expect(enriched?.queryOccurrences?.[0]).toMatchObject({
      startedAt,
      completedAt: firstCompletedAt,
      completionOutcome: "failure",
      completionFailureCategory: "authentication_failed"
    });
    expect(laterUnknown?.queryOccurrences?.[0]).toMatchObject({
      completedAt: firstCompletedAt,
      completionFailureCategory: "authentication_failed"
    });
    expect(laterUnknown?.observationId).toBe(enriched?.observationId);
    expect(conflictingKnown).toBeUndefined();
  });

  it("confirms the CC-11 final Claude Stop only with the matching closed interaction", () => {
    const fixture = claudeCodeNativeBlockedStopV21207;
    const guard = new DefaultAgentPrivacyGuard();
    const prompt = guard.sanitizeProviderHookObservation(
      fixture.promptHook,
      "claude-code",
      fixture.promptObservedAt
    );
    const promptMetadata = guard.sanitizeOtlpEnvelope(
      fixture.promptLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    guard.sanitizeQueryOccurrences(
      fixture.promptLogEnvelope,
      "logs",
      new DefaultTelemetryClassification().classify(promptMetadata),
      promptMetadata.observedAt
    );

    expect(guard.sanitizeProviderHookObservation(
      fixture.firstStopHook,
      "claude-code",
      fixture.firstStopObservedAt
    )).toBeUndefined();
    expect(guard.sanitizeProviderHookObservation(
      fixture.finalStopHook,
      "claude-code",
      fixture.finalStopObservedAt
    )).toBeUndefined();

    const traceMetadata = guard.sanitizeOtlpEnvelope(
      fixture.closedInteractionTraceEnvelope,
      "traces",
      fixture.interactionCompletedAt
    );
    const terminal = guard.sanitizeQueryOccurrences(
      fixture.closedInteractionTraceEnvelope,
      "traces",
      new DefaultTelemetryClassification().classify(traceMetadata),
      traceMetadata.observedAt
    );
    expect(terminal).toEqual([expect.objectContaining({
      queryId: prompt?.queryOccurrences?.[0]?.queryId,
      sessionId: prompt?.queryOccurrences?.[0]?.sessionId,
      startedAt: fixture.promptObservedAt,
      completedAt: fixture.interactionCompletedAt,
      completionEvidence: "closed_root_span"
    })]);
    expect(terminal[0].completionOutcome).toBeUndefined();
    const serialized = JSON.stringify(terminal);
    for (const rawIdentifier of fixture.syntheticIdentifiers) {
      expect(serialized).not.toContain(rawIdentifier);
    }
  });

  it("supports a bounded trace-before-Stop reorder and rejects a stale background close", () => {
    const fixture = claudeCodeNativeBlockedStopV21207;
    const reorderedGuard = new DefaultAgentPrivacyGuard();
    reorderedGuard.sanitizeProviderHookObservation(
      fixture.promptHook,
      "claude-code",
      fixture.promptObservedAt
    );
    const reorderedPromptMetadata = reorderedGuard.sanitizeOtlpEnvelope(
      fixture.promptLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    reorderedGuard.sanitizeQueryOccurrences(
      fixture.promptLogEnvelope,
      "logs",
      new DefaultTelemetryClassification().classify(reorderedPromptMetadata),
      reorderedPromptMetadata.observedAt
    );
    const reorderedTraceMetadata = reorderedGuard.sanitizeOtlpEnvelope(
      fixture.closedInteractionTraceEnvelope,
      "traces",
      fixture.interactionCompletedAt
    );
    expect(reorderedGuard.sanitizeQueryOccurrences(
      fixture.closedInteractionTraceEnvelope,
      "traces",
      new DefaultTelemetryClassification().classify(reorderedTraceMetadata),
      reorderedTraceMetadata.observedAt
    )).toEqual([]);
    expect(reorderedGuard.sanitizeProviderHookObservation(
      fixture.finalStopHook,
      "claude-code",
      fixture.finalStopObservedAt
    )?.queryOccurrences?.[0]).toMatchObject({
      completedAt: fixture.interactionCompletedAt,
      completionEvidence: "closed_root_span"
    });

    const staleGuard = new DefaultAgentPrivacyGuard();
    staleGuard.sanitizeProviderHookObservation(fixture.promptHook, "claude-code", fixture.promptObservedAt);
    const stalePromptMetadata = staleGuard.sanitizeOtlpEnvelope(
      fixture.promptLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    staleGuard.sanitizeQueryOccurrences(
      fixture.promptLogEnvelope,
      "logs",
      new DefaultTelemetryClassification().classify(stalePromptMetadata),
      stalePromptMetadata.observedAt
    );
    expect(staleGuard.sanitizeProviderHookObservation({
      ...fixture.firstStopHook,
      background_tasks: [{ task_id: "synthetic-background-task" }]
    }, "claude-code", fixture.firstStopObservedAt)).toBeUndefined();
    const staleTraceMetadata = staleGuard.sanitizeOtlpEnvelope(
      fixture.closedInteractionTraceEnvelope,
      "traces",
      fixture.interactionCompletedAt
    );
    expect(staleGuard.sanitizeQueryOccurrences(
      fixture.closedInteractionTraceEnvelope,
      "traces",
      new DefaultTelemetryClassification().classify(staleTraceMetadata),
      staleTraceMetadata.observedAt
    )).toEqual([]);

    const laterStopAt = "2026-07-12T09:55:11.430Z";
    expect(staleGuard.sanitizeProviderHookObservation(
      fixture.finalStopHook,
      "claude-code",
      laterStopAt
    )).toBeUndefined();
    const newCloseAt = "2026-07-12T09:55:11.432Z";
    const newClosedInteraction = {
      resourceSpans: fixture.closedInteractionTraceEnvelope.resourceSpans.map((resource) => ({
        ...resource,
        scopeSpans: resource.scopeSpans.map((scope) => ({
          ...scope,
          spans: scope.spans.map((span) => ({
            ...span,
            endTimeUnixNano: otlpNano(newCloseAt)
          }))
        }))
      }))
    };
    const newTraceMetadata = staleGuard.sanitizeOtlpEnvelope(
      newClosedInteraction,
      "traces",
      newCloseAt
    );
    expect(staleGuard.sanitizeQueryOccurrences(
      newClosedInteraction,
      "traces",
      new DefaultTelemetryClassification().classify(newTraceMetadata),
      newTraceMetadata.observedAt
    )).toEqual([expect.objectContaining({
      completedAt: newCloseAt,
      completionEvidence: "closed_root_span"
    })]);
  });

  it("clears background closes and never completes a Stop from an earlier cached close", () => {
    const fixture = claudeCodeNativeBlockedStopV21207;
    const guardWithCachedClose = () => {
      const guard = new DefaultAgentPrivacyGuard();
      guard.sanitizeProviderHookObservation(
        fixture.promptHook,
        "claude-code",
        fixture.promptObservedAt
      );
      const promptMetadata = guard.sanitizeOtlpEnvelope(
        fixture.promptLogEnvelope,
        "logs",
        fixture.promptObservedAt
      );
      guard.sanitizeQueryOccurrences(
        fixture.promptLogEnvelope,
        "logs",
        new DefaultTelemetryClassification().classify(promptMetadata),
        promptMetadata.observedAt
      );
      const traceMetadata = guard.sanitizeOtlpEnvelope(
        fixture.closedInteractionTraceEnvelope,
        "traces",
        fixture.interactionCompletedAt
      );
      expect(guard.sanitizeQueryOccurrences(
        fixture.closedInteractionTraceEnvelope,
        "traces",
        new DefaultTelemetryClassification().classify(traceMetadata),
        traceMetadata.observedAt
      )).toEqual([]);
      return guard;
    };

    const backgroundGuard = guardWithCachedClose();
    expect(backgroundGuard.sanitizeProviderHookObservation({
      ...fixture.firstStopHook,
      background_tasks: [{ task_id: "synthetic-background-task" }]
    }, "claude-code", fixture.firstStopObservedAt)).toBeUndefined();
    expect(backgroundGuard.sanitizeProviderHookObservation(
      fixture.finalStopHook,
      "claude-code",
      fixture.finalStopObservedAt
    )).toBeUndefined();

    const earlierCloseGuard = guardWithCachedClose();
    expect(earlierCloseGuard.sanitizeProviderHookObservation(
      fixture.finalStopHook,
      "claude-code",
      "2026-07-12T09:54:59.500Z"
    )).toBeUndefined();
  });

  it("classifies the native Claude 2.1.201 StopFailure shape as one privacy-safe failed terminal", () => {
    const fixture = claudeCodeNativeStopFailureV21201;
    const guard = new DefaultAgentPrivacyGuard();
    const prompt = guard.sanitizeProviderHookObservation(
      fixture.promptHook,
      "claude-code",
      fixture.promptObservedAt
    );
    const failure = guard.sanitizeProviderHookObservation({
      ...fixture.stopFailureHook,
      error_details: "PRIVATE_STOP_FAILURE_DETAIL_CANARY",
      last_assistant_message: "PRIVATE_STOP_FAILURE_ASSISTANT_CANARY",
      cwd: "/private/stop-failure-workspace",
      transcript_path: "/private/stop-failure-transcript.jsonl"
    }, "claude-code", fixture.failureObservedAt);

    expect(failure).toMatchObject({
      sourceId: "hook_claude_code_lifecycle",
      profileVersion: "claude-code-hooks-v1",
      queryOccurrences: [{
        queryId: prompt?.queryOccurrences?.[0]?.queryId,
        sessionId: prompt?.queryOccurrences?.[0]?.sessionId,
        startedAt: fixture.promptObservedAt,
        completedAt: fixture.failureObservedAt,
        ...fixture.expected,
        promptState: "disabled",
        evidence: "submission_hook"
      }],
      usageAtoms: []
    });
    expect(failure?.queryOccurrences).toHaveLength(1);
    expect(failure?.activityAtoms).toBeUndefined();
    expect(failure?.executionNodes).toBeUndefined();

    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain('"completionOutcome":"success"');
    for (const forbidden of [
      fixture.promptHook.session_id,
      fixture.promptHook.prompt_id,
      "PRIVATE_STOP_FAILURE_DETAIL_CANARY",
      "PRIVATE_STOP_FAILURE_ASSISTANT_CANARY",
      "/private/stop-failure-workspace",
      "/private/stop-failure-transcript.jsonl"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps the CC07Y background-root gap visible without treating exit as terminal authority", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "fixture-cc07y-background-session";
    const rootPrompt = "fixture-cc07y-root-prompt";
    const taskRawPrompt = "fixture-cc07y-task-raw-prompt";
    const taskTranscriptPrompt = "fixture-cc07y-task-transcript-prompt";
    const rootTrace = "fixture-cc07y-root-trace";
    const taskTrace = "fixture-cc07y-task-trace";
    const startedAt = "2026-07-13T13:19:45.684Z";
    const root = guard.sanitizeProviderHookObservation(
      guard.annotateClaudeProviderHook({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: rootPrompt
      }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
        sessionId: session,
        promptId: rootPrompt,
        timestamp: startedAt,
        originKind: "human",
        promptSource: "typed"
      })), startedAt),
      "claude-code",
      startedAt
    );
    sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: rootPrompt,
        traceId: rootTrace,
        at: startedAt
      }),
      "logs",
      startedAt
    );

    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStart",
      session_id: session,
      agent_id: "fixture-cc07y-child",
      agent_type: "Explore"
    }, "claude-code", "2026-07-13T13:19:46.000Z")?.activityAtoms?.[0]).toMatchObject({
      kind: "subagent",
      name: "Explore"
    });
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: rootPrompt,
      background_tasks: [{ task_id: "one" }],
      session_crons: []
    }, "claude-code", "2026-07-13T13:19:47.000Z")).toBeUndefined();
    expect(guard.countClaudeBackgroundRootsAwaitingTerminal(session)).toBe(1);
    expect(sanitizeClaudeOccurrences(
      guard,
      claudeClosedInteractionTraceEnvelope({
        traceId: rootTrace,
        startedAt,
        completedAt: "2026-07-13T13:19:48.000Z"
      }),
      "traces",
      "2026-07-13T13:19:48.000Z"
    )).toEqual([]);
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStop",
      session_id: session,
      agent_id: "fixture-cc07y-child",
      agent_type: "Explore"
    }, "claude-code", "2026-07-13T13:19:49.000Z")?.activityAtoms?.[0]).toMatchObject({
      kind: "subagent",
      name: "Explore"
    });

    expect(guard.sanitizeProviderHookObservation(
      guard.annotateClaudeProviderHook({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt_id: taskRawPrompt
      }, availableClaudeTranscriptTail(claudeTranscriptUserRecord({
        sessionId: session,
        promptId: taskTranscriptPrompt,
        timestamp: "2026-07-13T13:19:50.000Z",
        originKind: "task-notification",
        promptSource: "system"
      })), "2026-07-13T13:19:50.000Z"),
      "claude-code",
      "2026-07-13T13:19:50.000Z"
    )).toBeUndefined();
    sanitizeClaudeOccurrences(
      guard,
      claudePromptLogEnvelope({
        sessionId: session,
        promptId: taskTranscriptPrompt,
        traceId: taskTrace,
        at: "2026-07-13T13:19:50.100Z"
      }),
      "logs",
      "2026-07-13T13:19:50.100Z"
    );
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: taskRawPrompt,
      background_tasks: [],
      session_crons: []
    }, "claude-code", "2026-07-13T13:19:51.000Z")).toBeUndefined();
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "SessionEnd",
      session_id: session,
      reason: "prompt_input_exit"
    }, "claude-code", "2026-07-13T13:19:52.000Z")).toBeUndefined();
    expect(guard.countClaudeBackgroundRootsAwaitingTerminal(session)).toBe(1);

    const terminal = sanitizeClaudeOccurrences(
      guard,
      claudeClosedInteractionTraceEnvelope({
        traceId: taskTrace,
        startedAt,
        completedAt: "2026-07-13T13:19:51.002Z"
      }),
      "traces",
      "2026-07-13T13:19:52.100Z"
    );
    expect(terminal).toEqual([expect.objectContaining({
      queryId: root?.queryOccurrences?.[0]?.queryId,
      startedAt,
      completedAt: "2026-07-13T13:19:51.002Z",
      completionEvidence: "closed_root_span"
    })]);
    expect(guard.countClaudeBackgroundRootsAwaitingTerminal(session)).toBe(0);
  });

  it("caps Claude background-root diagnostics and ignores evicted correlation state", () => {
    const cappedGuard = new DefaultAgentPrivacyGuard();
    const session = "fixture-claude-background-count-cap-session";
    const humanHook = (prompt: string) => ({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: prompt,
      tirion_claude_submission_provenance: {
        state: "resolved",
        originKind: "human",
        promptSource: "typed",
        transcriptPromptId: prompt
      }
    });
    for (let index = 0; index < 9; index += 1) {
      const prompt = `fixture-claude-background-count-cap-${index}`;
      expect(cappedGuard.sanitizeProviderHookObservation(
        humanHook(prompt),
        "claude-code",
        `2026-07-13T14:00:0${index}.000Z`
      )).toBeDefined();
      expect(cappedGuard.sanitizeProviderHookObservation({
        hook_event_name: "Stop",
        session_id: session,
        prompt_id: prompt,
        background_tasks: [{ task_id: `fixture-task-${index}` }]
      }, "claude-code", `2026-07-13T14:01:0${index}.000Z`)).toBeUndefined();
    }
    expect(cappedGuard.countClaudeBackgroundRootsAwaitingTerminal(session)).toBe(8);

    const evictedGuard = new DefaultAgentPrivacyGuard();
    const stalePrompt = "fixture-claude-background-evicted-root";
    expect(evictedGuard.sanitizeProviderHookObservation(
      humanHook(stalePrompt),
      "claude-code",
      "2026-07-13T15:00:00.000Z"
    )).toBeDefined();
    expect(evictedGuard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: stalePrompt,
      background_tasks: [{ task_id: "fixture-stale-task" }]
    }, "claude-code", "2026-07-13T15:00:01.000Z")).toBeUndefined();
    expect(evictedGuard.countClaudeBackgroundRootsAwaitingTerminal(session)).toBe(1);
    for (let index = 0; index < 1_024; index += 1) {
      expect(evictedGuard.sanitizeProviderHookObservation(
        humanHook(`fixture-claude-background-eviction-${index}`),
        "claude-code",
        "2026-07-13T15:00:02.000Z"
      )).toBeDefined();
    }
    expect(evictedGuard.countClaudeBackgroundRootsAwaitingTerminal(session)).toBe(0);
  });

  it("does not promote an allowlisted Claude SessionEnd into a terminal", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "PRIVATE_CLAUDE_SESSION_END_SESSION_CANARY";
    const promptId = "PRIVATE_CLAUDE_SESSION_END_PROMPT_ID_CANARY";
    const promptContent = "PRIVATE_CLAUDE_SESSION_END_PROMPT_CONTENT_CANARY";
    const sessionReason = "prompt_input_exit";
    const startedAt = "2026-07-13T12:06:22.428Z";
    const completedAt = "2026-07-13T12:17:28.745Z";
    const prompt = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: promptId,
      prompt: promptContent,
      cwd: "/private/session-end-workspace",
      transcript_path: "/private/session-end-transcript.jsonl"
    }, "claude-code", startedAt);
    const ended = guard.sanitizeProviderHookObservation({
      hook_event_name: "SessionEnd",
      session_id: session,
      reason: sessionReason,
      last_assistant_message: "PRIVATE_CLAUDE_SESSION_END_ASSISTANT_CONTENT_CANARY",
      cwd: "/private/session-end-workspace",
      transcript_path: "/private/session-end-transcript.jsonl"
    }, "claude-code", completedAt);

    expect(prompt?.queryOccurrences).toHaveLength(1);
    expect(ended).toBeUndefined();

    const serialized = JSON.stringify({ prompt, ended });
    expect(serialized).not.toContain('"completionOutcome":"success"');
    for (const forbidden of [
      session,
      promptId,
      promptContent,
      sessionReason,
      "PRIVATE_CLAUDE_SESSION_END_ASSISTANT_CONTENT_CANARY",
      "/private/session-end-workspace",
      "/private/session-end-transcript.jsonl"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not promote a Claude SessionEnd with an unrecognized reason", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "PRIVATE_CLAUDE_SESSION_END_UNKNOWN_REASON_SESSION_CANARY";
    guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "PRIVATE_CLAUDE_SESSION_END_UNKNOWN_REASON_PROMPT_CANARY"
    }, "claude-code", "2026-07-13T12:06:22.428Z");

    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "SessionEnd",
      session_id: session,
      reason: "PRIVATE_CLAUDE_SESSION_END_UNKNOWN_REASON_CANARY",
      last_assistant_message: "PRIVATE_CLAUDE_SESSION_END_UNKNOWN_REASON_CONTENT_CANARY"
    }, "claude-code", "2026-07-13T12:17:28.745Z")).toBeUndefined();
  });

  it("does not bind a Claude SessionEnd across two unresolved submission roots", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const session = "PRIVATE_CLAUDE_SESSION_END_AMBIGUOUS_SESSION_CANARY";
    const first = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "PRIVATE_CLAUDE_SESSION_END_FIRST_PROMPT_CANARY"
    }, "claude-code", "2026-07-13T12:06:22.428Z");
    const second = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "PRIVATE_CLAUDE_SESSION_END_SECOND_PROMPT_CANARY"
    }, "claude-code", "2026-07-13T12:06:24.428Z");

    expect(first?.queryOccurrences?.[0]?.queryId).not.toBe(second?.queryOccurrences?.[0]?.queryId);
    expect(guard.sanitizeProviderHookObservation({
      hook_event_name: "SessionEnd",
      session_id: session,
      reason: "prompt_input_exit"
    }, "claude-code", "2026-07-13T12:17:28.745Z")).toBeUndefined();
  });

  it("preserves both native failed Claude LLM request outcomes without false success", () => {
    const fixture = claudeCodeNativeStopFailureV21201;
    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(
      fixture.failedLlmTraceEnvelope,
      "traces",
      fixture.failureObservedAt
    );
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const nodes = guard.sanitizeExecutionNodes(
      fixture.failedLlmTraceEnvelope,
      "traces",
      classification,
      metadata.observedAt
    );

    expect(nodes).toHaveLength(2);
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeKind: "llm_request",
        model: "claude-sonnet-5",
        outcome: "failure"
      }),
      expect.objectContaining({
        nodeKind: "llm_request",
        model: "claude-haiku-4-5-20251001",
        outcome: "failure",
        usagePurpose: "auxiliary_session_title"
      })
    ]));
    expect(nodes.find((node) => node.model === "claude-sonnet-5")?.usagePurpose).toBeUndefined();
    expect(JSON.stringify(nodes)).not.toContain('"outcome":"success"');
    expect(JSON.stringify(nodes)).not.toContain("generate_session_title");
  });

  it("never persists or classifies an arbitrary native Claude operation.name", () => {
    const fixture = claudeCodeNativeStopFailureV21201;
    const canary = "PRIVATE_ARBITRARY_OPERATION_NAME_CANARY";
    const unknownOperationEnvelope = {
      resourceSpans: fixture.failedLlmTraceEnvelope.resourceSpans.map((resource) => ({
        ...resource,
        scopeSpans: resource.scopeSpans.map((scope) => ({
          ...scope,
          spans: scope.spans.map((span) => ({
            ...span,
            attributes: span.attributes.map((attribute) => attribute.key === "operation.name"
              ? { key: "operation.name", value: { stringValue: canary } }
              : attribute)
          }))
        }))
      }))
    };
    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(
      unknownOperationEnvelope,
      "traces",
      fixture.failureObservedAt
    );
    const nodes = guard.sanitizeExecutionNodes(
      unknownOperationEnvelope,
      "traces",
      new DefaultTelemetryClassification().classify(metadata),
      metadata.observedAt
    );

    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.usagePurpose == null)).toBe(true);
    expect(JSON.stringify(nodes)).not.toContain(canary);
  });

  it("requires actual Claude submission-hook provenance for StopFailure", () => {
    const fixture = claudeCodeNativeStopFailureV21201;
    const guard = new DefaultAgentPrivacyGuard();
    const metadata = guard.sanitizeOtlpEnvelope(
      fixture.failedLlmTraceEnvelope,
      "traces",
      fixture.failureObservedAt
    );
    const classification = new DefaultTelemetryClassification().classify(metadata);
    guard.sanitizeExecutionNodes(
      fixture.failedLlmTraceEnvelope,
      "traces",
      classification,
      metadata.observedAt
    );
    expect(guard.sanitizeProviderHookObservation(
      fixture.stopFailureHook,
      "claude-code",
      fixture.failureObservedAt
    )).toBeUndefined();

    const prompt = guard.sanitizeProviderHookObservation(
      fixture.promptHook,
      "claude-code",
      fixture.promptObservedAt
    );
    const unrelatedOtlp = {
      resourceSpans: fixture.failedLlmTraceEnvelope.resourceSpans.map((resource) => ({
        ...resource,
        scopeSpans: resource.scopeSpans.map((scope) => ({
          ...scope,
          spans: scope.spans.map((span) => ({
            ...span,
            attributes: span.attributes.map((attribute) => attribute.key === "prompt.id"
              ? { key: "prompt.id", value: { stringValue: "fixture-unrelated-otel-prompt" } }
              : attribute)
          }))
        }))
      }))
    };
    guard.sanitizeExecutionNodes(unrelatedOtlp, "traces", classification, metadata.observedAt);
    expect(guard.sanitizeProviderHookObservation(
      fixture.stopFailureHook,
      "claude-code",
      fixture.failureObservedAt
    )?.queryOccurrences?.[0]).toMatchObject({
      queryId: prompt?.queryOccurrences?.[0]?.queryId,
      completionOutcome: "failure"
    });
  });

  it("deduplicates repeated Claude StopFailure hooks and fails closed on mismatched prompt identity", () => {
    const fixture = claudeCodeNativeStopFailureV21201;
    const guard = new DefaultAgentPrivacyGuard();
    guard.sanitizeProviderHookObservation(fixture.promptHook, "claude-code", fixture.promptObservedAt);

    const first = guard.sanitizeProviderHookObservation(
      fixture.stopFailureHook,
      "claude-code",
      fixture.failureObservedAt
    );
    const duplicate = guard.sanitizeProviderHookObservation(
      fixture.stopFailureHook,
      "claude-code",
      "2026-07-12T06:00:02.000Z"
    );
    const mismatched = guard.sanitizeProviderHookObservation({
      ...fixture.stopFailureHook,
      prompt_id: "fixture-different-prompt"
    }, "claude-code", "2026-07-12T06:00:03.000Z");
    const freeTextError = guard.sanitizeProviderHookObservation({
      ...fixture.stopFailureHook,
      error: "PRIVATE_FREE_TEXT_STOP_FAILURE_CANARY"
    }, "claude-code", "2026-07-12T06:00:04.000Z");
    const objectError = guard.sanitizeProviderHookObservation({
      ...fixture.stopFailureHook,
      error: { category: "authentication_failed" }
    }, "claude-code", "2026-07-12T06:00:05.000Z");
    const { error: _error, ...missingErrorHook } = fixture.stopFailureHook;
    const missingError = guard.sanitizeProviderHookObservation(
      missingErrorHook,
      "claude-code",
      "2026-07-12T06:00:06.000Z"
    );

    expect(first?.observationId).toBe(duplicate?.observationId);
    expect(first?.queryOccurrences?.[0]).toMatchObject({
      completionOutcome: "failure",
      completionFailureCategory: "authentication_failed"
    });
    expect(mismatched).toBeUndefined();
    expect(freeTextError?.queryOccurrences?.[0]?.completionFailureCategory).toBe("authentication_failed");
    expect(JSON.stringify(freeTextError)).not.toContain("PRIVATE_FREE_TEXT_STOP_FAILURE_CANARY");
    expect(objectError).toBeUndefined();
    expect(missingError).toBeUndefined();
  });

  it("records Codex prompt hooks as safe query lifecycle observations and correlates later tool hooks", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const promptObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      transcript_path: "/private/session/codex-session-1.jsonl",
      prompt: "change src/secret.ts"
    }, "codex", "2026-06-08T00:00:00.000Z");
    const fallbackPromptLog = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.250Z" } },
            { key: "conversation.id", value: { stringValue: "codex-session-1" } }
          ]
        }] }]
      }]
    };
    const fallbackMetadata = guard.sanitizeOtlpEnvelope(fallbackPromptLog, "logs", "2026-06-08T00:00:00.250Z");
    const fallbackClassification = new DefaultTelemetryClassification().classify(fallbackMetadata);
    const fallbackOccurrences = guard.sanitizeQueryOccurrences(
      fallbackPromptLog,
      "logs",
      fallbackClassification,
      fallbackMetadata.observedAt
    );
    guard.sanitizeUsageAtoms(fallbackPromptLog, "logs", fallbackClassification, fallbackMetadata.observedAt);
    const toolObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      tool_name: "apply_patch",
      tool_input: { command: "do not store this" },
      tool_response: { success: true, content: "ok" }
    }, "codex", "2026-06-08T00:00:01.000Z");
    const failedToolObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUseFailure",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      tool_name: "exec_command",
      tool_input: { command: "do not store this either" },
      error: "private failure"
    }, "codex", "2026-06-08T00:00:02.000Z");
    const spawnToolObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      tool_name: "spawn_agent",
      tool_response: { success: true, agent_id: "codex-child-session-1" }
    }, "codex", "2026-06-08T00:00:02.100Z");
    const waitToolObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      tool_name: "multi_agent_v1wait_agent",
      tool_response: { success: true }
    }, "codex", "2026-06-08T00:00:02.200Z");
    const subagentStart = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStart",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      agent_id: "codex-child-session-1",
      agent_type: "explorer"
    }, "codex", "2026-06-08T00:00:03.000Z");
    const subagentStop = guard.sanitizeProviderHookObservation({
      hook_event_name: "SubagentStop",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      agent_id: "codex-child-session-1",
      agent_type: "explorer"
    }, "codex", "2026-06-08T00:00:04.000Z");
    const childPrompt = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-child-session-1",
      turn_id: "codex-child-turn-1",
      transcript_path: "/private/session/codex-child-session-1.jsonl"
    }, "codex", "2026-06-08T00:00:03.100Z");
    const stopObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "Stop",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1"
    }, "codex", "2026-06-08T00:00:05.000Z");

    expect(promptObservation).toMatchObject({
      sourceId: "hook_codex_lifecycle",
      queryOccurrences: [expect.objectContaining({
        promptState: "disabled",
        evidence: "submission_hook"
      })]
    });
    expect(fallbackOccurrences).toEqual([expect.objectContaining({
      queryId: promptObservation?.queryOccurrences?.[0]?.queryId,
      sessionId: promptObservation?.queryOccurrences?.[0]?.sessionId,
      startedAt: "2026-06-08T00:00:00.000Z"
    })]);
    expect(toolObservation).toMatchObject({
      sourceId: "hook_codex_tools",
      activityAtoms: [expect.objectContaining({
        kind: "tool",
        name: "apply_patch"
      })],
      executionNodes: [expect.objectContaining({
        nodeKind: "tool",
        contents: undefined
      })]
    });
    expect(failedToolObservation).toMatchObject({
      activityAtoms: [expect.objectContaining({
        kind: "tool",
        name: "exec_command",
        outcome: "failure"
      })]
    });
    expect(spawnToolObservation).toMatchObject({
      activityAtoms: [expect.objectContaining({ kind: "tool", name: "spawn_agent" })]
    });
    expect(waitToolObservation).toMatchObject({
      activityAtoms: [expect.objectContaining({ kind: "tool", name: "multi_agent_v1wait_agent" })]
    });
    expect(subagentStart).toMatchObject({
      activityAtoms: [expect.objectContaining({ kind: "subagent", outcome: "unknown" })]
    });
    expect(subagentStop).toMatchObject({
      activityAtoms: [expect.objectContaining({
        kind: "subagent",
        outcome: "success",
        startedAt: "2026-06-08T00:00:03.000Z",
        endedAt: "2026-06-08T00:00:04.000Z",
        childSessionId: childPrompt?.queryOccurrences?.[0]?.sessionId
      })]
    });
    expect(stopObservation).toMatchObject({
      sourceId: "hook_codex_lifecycle",
      queryOccurrences: [expect.objectContaining({
        queryId: promptObservation?.queryOccurrences?.[0]?.queryId,
        startedAt: "2026-06-08T00:00:00.000Z",
        completedAt: "2026-06-08T00:00:05.000Z",
        completionEvidence: "stop_hook"
      })]
    });
    const serialized = JSON.stringify([
      promptObservation,
      toolObservation,
      failedToolObservation,
      spawnToolObservation,
      waitToolObservation,
      subagentStart,
      subagentStop,
      childPrompt,
      stopObservation
    ]);
    expect(serialized).not.toContain("change src/secret.ts");
    expect(serialized).not.toContain("do not store this");
    expect(serialized).not.toContain("do not store this either");
    expect(serialized).not.toContain("private failure");
  });

  it("does not mistake Codex unified-exec protocol success for a shell outcome", () => {
    const guard = new DefaultAgentPrivacyGuard(() => true, () => true);
    guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-outcome-session",
      turn_id: "codex-outcome-turn",
      transcript_path: "/private/session/codex-outcome-session.jsonl"
    }, "codex", "2026-06-08T00:00:00.000Z");
    const hook = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "codex-outcome-session",
      turn_id: "codex-outcome-turn",
      tool_name: "Bash",
      tool_use_id: "call-exit-seven",
      tool_input: { command: "PRIVATE_TOOL_ARGUMENT" },
      tool_response: "PRIVATE_TOOL_OUTPUT"
    }, "codex", "2026-06-08T00:00:01.000Z");
    const structuredFailureHook = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "codex-outcome-session",
      turn_id: "codex-outcome-turn",
      tool_name: "Bash",
      tool_use_id: "call-structured-exit-seven",
      tool_response: { exit_code: 7, output: "PRIVATE_STRUCTURED_TOOL_OUTPUT" }
    }, "codex", "2026-06-08T00:00:01.050Z");
    const raw = {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: otlpNano("2026-06-08T00:00:01.000Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "codex.tool_result" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:01.000Z" } },
            { key: "conversation.id", value: { stringValue: "codex-outcome-session" } },
            { key: "turn.id", value: { stringValue: "codex-outcome-turn" } },
            { key: "tool_name", value: { stringValue: "exec_command" } },
            { key: "call_id", value: { stringValue: "call-exit-seven" } },
            { key: "duration_ms", value: { intValue: "12" } },
            { key: "success", value: { stringValue: "true" } },
            { key: "arguments", value: { stringValue: "PRIVATE_TOOL_ARGUMENT" } },
            { key: "output", value: { stringValue: "PRIVATE_TOOL_OUTPUT" } }
          ]
        }, {
          attributes: [
            { key: "event.name", value: { stringValue: "codex.tool_result" } },
            { key: "conversation.id", value: { stringValue: "codex-outcome-session" } },
            { key: "turn.id", value: { stringValue: "codex-outcome-turn" } },
            { key: "tool_name", value: { stringValue: "exec_command" } },
            { key: "success", value: { stringValue: "false" } }
          ]
        }, {
          timeUnixNano: otlpNano("2026-06-08T00:00:01.100Z"),
          attributes: [
            { key: "event.name", value: { stringValue: "codex.tool_result" } },
            { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:01.100Z" } },
            { key: "conversation.id", value: { stringValue: "codex-outcome-session" } },
            { key: "turn.id", value: { stringValue: "codex-outcome-turn" } },
            { key: "tool_name", value: { stringValue: "exec_command" } },
            { key: "call_id", value: { stringValue: "call-dispatch-failure" } },
            { key: "success", value: { stringValue: "false" } }
          ]
        }] }]
      }]
    };
    const metadata = guard.sanitizeOtlpEnvelope(raw, "logs", "2026-06-08T00:00:01.100Z");
    const classification = new DefaultTelemetryClassification().classify(metadata);
    const atoms = guard.sanitizeActivityAtoms(raw, "logs", classification, metadata.observedAt);

    expect(hook).toMatchObject({
      activityAtoms: [expect.objectContaining({
        name: "Bash",
        outcome: "unknown"
      })]
    });
    expect(structuredFailureHook).toMatchObject({
      activityAtoms: [expect.objectContaining({
        name: "Bash",
        outcome: "failure"
      })]
    });
    expect(atoms).toEqual([
      expect.objectContaining({
        queryId: hook?.activityAtoms?.[0]?.queryId,
        requestId: hook?.activityAtoms?.[0]?.requestId,
        kind: "tool",
        name: "exec_command",
        outcome: "unknown",
        durationMs: 12,
        evidenceBasis: "otel_event"
      }),
      expect.objectContaining({
        queryId: hook?.activityAtoms?.[0]?.queryId,
        kind: "tool",
        name: "exec_command",
        outcome: "failure",
        evidenceBasis: "otel_event"
      })
    ]);
    expect(atoms[0].sensitiveAuditEvidence).toBeUndefined();
    const serialized = JSON.stringify([hook, structuredFailureHook, atoms]);
    expect(serialized).not.toContain("PRIVATE_TOOL_ARGUMENT");
    expect(serialized).not.toContain("PRIVATE_TOOL_OUTPUT");
    expect(serialized).not.toContain("PRIVATE_STRUCTURED_TOOL_OUTPUT");
  });

  it("records Cursor hook runs with token revisions and metadata-only activity", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const promptObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "cursor-conversation-1",
      generation_id: "cursor-generation-1",
      model: "claude-sonnet-4.6",
      prompt: "summarize /Users/asaf/secret-plan.md"
    }, "cursor", "2026-06-08T00:00:00.000Z");
    const usageObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "afterAgentResponse",
      conversation_id: "cursor-conversation-1",
      generation_id: "cursor-generation-1",
      model: "claude-sonnet-4.6",
      input_tokens: 120,
      output_tokens: 25,
      cache_read_tokens: 40,
      cache_write_tokens: 12
    }, "cursor", "2026-06-08T00:00:02.000Z");
    const shellObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "afterShellExecution",
      conversation_id: "cursor-conversation-1",
      generation_id: "cursor-generation-1",
      shell_execution_id: "cursor-shell-1",
      command: "cat /Users/asaf/private.txt",
      output: "private output",
      exit_code: 0,
      duration_ms: 500
    }, "cursor", "2026-06-08T00:00:03.000Z");
    const fileObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "afterFileEdit",
      conversation_id: "cursor-conversation-1",
      generation_id: "cursor-generation-1",
      edit_id: "cursor-edit-1",
      file_path: "/Users/asaf/secret-plan.md",
      content: "private file content"
    }, "cursor", "2026-06-08T00:00:04.000Z");
    const stopObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "stop",
      conversation_id: "cursor-conversation-1",
      generation_id: "cursor-stop-generation-drift"
    }, "cursor", "2026-06-08T00:00:05.000Z");

    expect(promptObservation).toMatchObject({
      sourceId: "hook_cursor_lifecycle",
      queryOccurrences: [expect.objectContaining({
        promptState: "disabled",
        evidence: "submission_hook"
      })]
    });
    expect(usageObservation).toMatchObject({
      sourceId: "hook_cursor_lifecycle",
      usageAtoms: [expect.objectContaining({
        provider: "cursor",
        authority: "turn",
        billingContext: "unknown",
        model: "claude-sonnet-4.6",
        modelProvider: "anthropic",
        inputTokens: 120,
        outputTokens: 25,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 12,
        endedAt: undefined
      })]
    });
    expect(shellObservation).toMatchObject({
      sourceId: "hook_cursor_tools",
      activityAtoms: [expect.objectContaining({
        kind: "tool",
        name: "shell_exec",
        outcome: "success",
        durationMs: 500
      })],
      executionNodes: [expect.objectContaining({
        nodeKind: "tool"
      })]
    });
    expect(shellObservation?.executionNodes?.[0]).not.toHaveProperty("contents");
    expect(fileObservation).toMatchObject({
      sourceId: "hook_cursor_tools",
      activityAtoms: [expect.objectContaining({
        kind: "tool",
        name: "file_edit"
      })]
    });
    expect(stopObservation).toMatchObject({
      sourceId: "hook_cursor_lifecycle",
      usageAtoms: [expect.objectContaining({
        inputTokens: 120,
        outputTokens: 25,
        endedAt: "2026-06-08T00:00:05.000Z"
      })]
    });
    const serialized = JSON.stringify([
      promptObservation,
      usageObservation,
      shellObservation,
      fileObservation,
      stopObservation
    ]);
    expect(serialized).not.toContain("summarize /Users/asaf/secret-plan.md");
    expect(serialized).not.toContain("cat /Users/asaf/private.txt");
    expect(serialized).not.toContain("private output");
    expect(serialized).not.toContain("/Users/asaf/secret-plan.md");
    expect(serialized).not.toContain("private file content");
    expect(serialized).not.toContain("cursor-conversation-1");
    expect(serialized).not.toContain("cursor-generation-1");
  });

  it("assigns Cursor catalog billing to Cursor-priced Composer hook models", () => {
    const guard = new DefaultAgentPrivacyGuard();
    guard.sanitizeProviderHookObservation({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "cursor-composer-conversation",
      generation_id: "cursor-composer-generation",
      model: "composer-2.5-fast"
    }, "cursor", "2026-07-03T00:00:00.000Z");

    const usageObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "afterAgentResponse",
      conversation_id: "cursor-composer-conversation",
      generation_id: "cursor-composer-generation",
      model: "composer-2.5-fast",
      input_tokens: 120,
      output_tokens: 25,
      cache_read_tokens: 40
    }, "cursor", "2026-07-03T00:00:02.000Z");

    expect(usageObservation).toMatchObject({
      sourceId: "hook_cursor_lifecycle",
      usageAtoms: [expect.objectContaining({
        provider: "cursor",
        billingContext: "cursor",
        model: "composer-2.5-fast",
        modelProvider: "cursor",
        modelProviderBasis: "model_name_rule"
      })]
    });
  });
});
