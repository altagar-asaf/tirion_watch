import { describe, expect, it } from "vitest";
import {
  canonicalSensitiveAuditKind,
  DefaultAgentPrivacyGuard,
  DefaultTelemetryClassification,
  OTLP_MAX_RECORDS,
  displayLabelForSensitiveAuditKind,
  safeObservationFrom,
  sourceCapabilityForObservation
} from "./telemetryClassification";

function otlpNano(iso: string): string {
  return `${BigInt(Date.parse(iso)) * 1_000_000n}`;
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

  it("segments Codex log usage by user prompt and revises cumulative completion snapshots", () => {
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
    expect(atoms[0].atomId).toBe(atoms[1].atomId);
    expect(atoms[1]).toMatchObject({
      queryId: occurrences[0].queryId,
      sessionId: occurrences[0].sessionId,
      authority: "turn",
      signal: "logs",
      sourceId: "otlp_codex_logs",
      profileVersion: "codex-otel-logs-v1",
      billingContext: "openai-direct",
      inputTokens: 140,
      outputTokens: 5,
      cacheReadInputTokens: 40,
      reasoningOutputTokens: 35,
      startedAt: "2026-06-08T00:00:00.000Z",
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
      authority: "turn",
      inputTokens: 200,
      outputTokens: 20,
      startedAt: "2026-06-08T00:00:00.000Z",
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

  it("records Claude prompt hooks as safe query lifecycle observations without prompt text", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const observation = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session-1",
      prompt: "write the secret feature"
    }, "claude-code", "2026-06-08T00:00:00.000Z");

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
    expect(JSON.stringify(observation)).not.toContain("write the secret feature");
  });

  it("records Codex prompt hooks as safe query lifecycle observations and correlates later tool hooks", () => {
    const guard = new DefaultAgentPrivacyGuard();
    const promptObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      prompt: "change src/secret.ts"
    }, "codex", "2026-06-08T00:00:00.000Z");
    const toolObservation = guard.sanitizeProviderHookObservation({
      hook_event_name: "PostToolUse",
      session_id: "codex-session-1",
      turn_id: "codex-turn-1",
      tool_name: "apply_patch",
      tool_input: { command: "do not store this" },
      tool_response: { success: true, content: "ok" }
    }, "codex", "2026-06-08T00:00:01.000Z");

    expect(promptObservation).toMatchObject({
      sourceId: "hook_codex_lifecycle",
      queryOccurrences: [expect.objectContaining({
        promptState: "disabled",
        evidence: "submission_hook"
      })]
    });
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
    expect(JSON.stringify([promptObservation, toolObservation])).not.toContain("change src/secret.ts");
    expect(JSON.stringify([promptObservation, toolObservation])).not.toContain("do not store this");
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
