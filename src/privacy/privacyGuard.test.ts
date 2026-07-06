import { describe, expect, it } from "vitest";
import { DefaultPrivacyGuard } from "./privacyGuard";

describe("DefaultPrivacyGuard", () => {
  it("drops content-bearing attributes from canonical records", () => {
    const guard = new DefaultPrivacyGuard();
    const sanitized = guard.sanitize({
      kind: "span",
      traceId: "trace",
      spanId: "span",
      name: "chat",
      attributes: {
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.input.messages": "secret prompt",
        "tool.arguments": "secret file"
      },
      resourceAttributes: {
        "service.name": "github-copilot"
      }
    });

    expect(sanitized.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(sanitized.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(sanitized.attributes["tool.arguments"]).toBeUndefined();
  });

  it("stores only the initial user query from captured messages", () => {
    const guard = new DefaultPrivacyGuard();
    const sanitized = guard.sanitize({
      kind: "span",
      traceId: "trace",
      spanId: "span",
      name: "invoke_agent",
      attributes: {
        "gen_ai.input.messages": JSON.stringify([
          { role: "system", content: "hidden system prompt" },
          { role: "user", content: "please refactor the parser" }
        ]),
        "gen_ai.output.messages": "secret response",
        "gen_ai.tool.call.arguments": "secret tool args"
      },
      resourceAttributes: {}
    });

    expect(sanitized.attributes["tirion.initial_user_query"]).toBe("please refactor the parser");
    expect(sanitized.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(sanitized.attributes["gen_ai.output.messages"]).toBeUndefined();
    expect(sanitized.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
  });

  it("stores only the initial user query from exact user_message event content", () => {
    const guard = new DefaultPrivacyGuard();
    const sanitized = guard.sanitize({
      kind: "event",
      traceId: "trace",
      spanId: "root",
      name: "user_message",
      timeUnixNano: "1780099201000000000",
      attributes: {
        content: "please show prompts earlier",
        "copilot_chat.chat_session_id": "session-1"
      },
      resourceAttributes: {}
    });

    expect(sanitized.attributes["tirion.initial_user_query"]).toBe("please show prompts earlier");
    expect(sanitized.attributes.content).toBeUndefined();
    expect(sanitized.attributes["copilot_chat.chat_session_id"]).toBe("session-1");
  });

  it("drops content from non-user_message events without treating it as an initial query", () => {
    const guard = new DefaultPrivacyGuard();
    const sanitized = guard.sanitize({
      kind: "event",
      traceId: "trace",
      spanId: "root",
      name: "copilot_chat.tool.call",
      timeUnixNano: "1780099201000000000",
      attributes: {
        content: "secret tool result",
        "gen_ai.tool.name": "readFile"
      },
      resourceAttributes: {}
    });

    expect(sanitized.attributes["tirion.initial_user_query"]).toBeUndefined();
    expect(sanitized.attributes.content).toBeUndefined();
    expect(sanitized.attributes["gen_ai.tool.name"]).toBe("readFile");
  });

  it("stores the initial user query from Copilot message parts", () => {
    const guard = new DefaultPrivacyGuard();
    const sanitized = guard.sanitize({
      kind: "span",
      traceId: "trace",
      spanId: "span",
      name: "invoke_agent GitHub Copilot Chat",
      attributes: {
        "gen_ai.input.messages": JSON.stringify([
          {
            role: "user",
            parts: [
              { type: "text", content: "do we have db span enabled?" }
            ]
          }
        ])
      },
      resourceAttributes: {}
    });

    expect(sanitized.attributes["tirion.initial_user_query"]).toBe("do we have db span enabled?");
    expect(sanitized.attributes["gen_ai.input.messages"]).toBeUndefined();
  });

  it("extracts the user request from Copilot prompt envelope strings", () => {
    const guard = new DefaultPrivacyGuard();
    const sanitized = guard.sanitize({
      kind: "span",
      traceId: "trace",
      spanId: "span",
      name: "invoke_agent",
      attributes: {
        "gen_ai.input.messages": `<environment_info>
The user's current OS is: macOS
</environment_info>
<workspace_info>
The workspace contains Tirion.
</workspace_info>
<userRequest>
why don't we use the actual query text instead
</userRequest>`
      },
      resourceAttributes: {}
    });

    expect(sanitized.attributes["tirion.initial_user_query"]).toBe("why don't we use the actual query text instead");
    expect(sanitized.attributes["gen_ai.input.messages"]).toBeUndefined();
  });

  it("extracts the user request from a wrapped parsed user message", () => {
    const guard = new DefaultPrivacyGuard();
    const sanitized = guard.sanitize({
      kind: "span",
      traceId: "trace",
      spanId: "span",
      name: "invoke_agent",
      attributes: {
        "gen_ai.input.messages": JSON.stringify([
          {
            role: "user",
            content: `<environment_info>
The user's current OS is: macOS
</environment_info>
<workspace_info>
The workspace contains Tirion.
</workspace_info>
<userRequest>
show the actual user prompt
</userRequest>`
          }
        ])
      },
      resourceAttributes: {}
    });

    expect(sanitized.attributes["tirion.initial_user_query"]).toBe("show the actual user prompt");
    expect(sanitized.attributes["gen_ai.input.messages"]).toBeUndefined();
  });

  it("allows initialQueryText in run summaries", () => {
    const guard = new DefaultPrivacyGuard();
    const result = guard.validateRun({
      schemaVersion: 2,
      id: "trace",
      traceId: "trace",
      queryId: "query",
      queryStartedAt: "2026-05-28T00:00:00.000Z",
      initialQueryText: "This prompt text is intentionally stored.",
      startedAt: "2026-05-28T00:00:00.000Z",
      status: "completed",
      models: ["gpt-5.3-codex"],
      tokenUsageSource: "invoke_agent",
      costCoverage: "complete",
      modelUsages: [],
      llmCallCount: 1,
      toolCallCount: 0,
      tools: [],
      warnings: []
    });

    expect(result.ok).toBe(true);
  });

  it("rejects content-bearing run fields outside the initial query exception", () => {
    const guard = new DefaultPrivacyGuard();
    const run = {
      schemaVersion: 2,
      id: "trace",
      traceId: "trace",
      queryId: "query",
      queryStartedAt: "2026-05-28T00:00:00.000Z",
      initialQueryText: "allowed prompt text",
      startedAt: "2026-05-28T00:00:00.000Z",
      status: "completed",
      models: ["gpt-5.3-codex"],
      tokenUsageSource: "invoke_agent",
      costCoverage: "complete",
      modelUsages: [],
      llmCallCount: 1,
      toolCallCount: 0,
      tools: [],
      warnings: [],
      toolArguments: "secret"
    } as const;

    expect(guard.validateRun(run).ok).toBe(false);
  });

  it("allows HMAC state evidence and rejects content-bearing attribution keys", () => {
    const guard = new DefaultPrivacyGuard();
    const safe = {
      epochId: "epoch-key",
      repoKey: "repo-key",
      artifactStates: [{
        artifactKey: "artifact-key",
        stateKey: "hmac-state-key",
        changeKind: "modified",
        observedSequence: 2
      }]
    };

    expect(guard.validateAttribution(safe).ok).toBe(true);
    expect(guard.validateAttribution({ ...safe, fileContent: "secret" }).ok).toBe(false);
    expect(guard.validateAttribution({ ...safe, rawDiff: "secret" }).ok).toBe(false);
  });

  it("strictly validates outbound GitHub Check publication intents", () => {
    const guard = new DefaultPrivacyGuard();
    const intent = {
      schemaVersion: 1,
      owner: "tirion",
      repository: "extension",
      commitSha: "a".repeat(40),
      publicationVersion: 1,
      state: "active",
      estimatedNanoUsd: 1_000_000,
      coverage: "complete",
      attributedQueryCount: 1,
      firstVerifiedAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z"
    };

    expect(guard.validatePublication(intent).ok).toBe(true);
    expect(guard.validatePublication({ ...intent, commitMessage: "feat: add commit message to publication" }).ok).toBe(true);
    for (const forbidden of [
      { prompt: "secret prompt" },
      { queryIds: ["secret-query"] },
      { episodeIds: ["secret-episode"] },
      { repoKey: "local-repo-key" },
      { filePath: "src/secret.ts" },
      { diff: "secret diff" },
      { toolArguments: "secret tool data" },
      { evidenceFingerprint: "secret-fingerprint" },
      { evidenceReasons: ["secret-reason"] }
    ]) {
      expect(guard.validatePublication({ ...intent, ...forbidden }).ok).toBe(false);
    }
  });

  it("allows commit messages on outbound commit-attributed webhooks", () => {
    const guard = new DefaultPrivacyGuard();
    const event = {
      schemaVersion: 1,
      eventType: "commit.attributed",
      eventId: "evt_commit_attributed_repo_commit",
      sender: {
        installationId: "ins_test",
        name: "Ada Lovelace",
        team: "Platform",
        imageUrl: "https://example.com/ada.png"
      },
      repository: {
        repoKey: "repo_tirion",
        owner: "tirion",
        name: "extension",
        fullName: "tirion/extension"
      },
      commitSha: "a".repeat(40),
      commitMessage: "feat: include commit message in attribution webhook",
      traceIds: ["trace_commit"],
      runIds: ["run_commit"],
      estimatedNanoUsd: 1_000_000,
      usageValueNanoUsd: 1_500_000,
      costCoverage: "complete",
      state: "active",
      version: 1,
      firstVerifiedAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z"
    };

    expect(guard.validatePublication(event).ok).toBe(true);
    expect(guard.validatePublication({ ...event, usageValueNanoUsd: -1 }).ok).toBe(false);
    expect(guard.validatePublication({ ...event, commitMessage: "x".repeat(1001) }).ok).toBe(false);
    expect(guard.validatePublication({
      ...event,
      sender: {
        installationId: "ins_test",
        imageUrl: "file:///Users/asaf/avatar.png"
      }
    }).ok).toBe(false);
    expect(guard.validatePublication({
      ...event,
      sender: {
        installationId: "ins_test",
        name: "Ada\nLovelace"
      }
    }).ok).toBe(false);
  });

  it("allows numeric usage value on outbound run lifecycle webhooks", () => {
    const guard = new DefaultPrivacyGuard();
    const event = {
      schemaVersion: 1,
      eventType: "run.ended",
      eventId: "evt_run_value",
      runId: "run_value",
      sessionId: "ses_value",
      traceIds: ["trace_value"],
      sender: {
        installationId: "ins_test"
      },
      repository: {
        repoKey: "repo_tirion",
        owner: "tirion",
        name: "extension",
        fullName: "tirion/extension"
      },
      codingHarness: "codex",
      runtime: "codex",
      startedAt: "2026-06-08T00:00:00.000Z",
      evidence: {
        basis: "stop_hook",
        sourceId: "source_test",
        profileVersion: "codex-otel-logs-v1",
        observedAt: "2026-06-08T00:00:01.000Z",
        delayed: false,
        identityConfidence: "high",
        timingConfidence: "high"
      },
      coverage: {
        usageCoverage: "final",
        activityCoverage: "none",
        costCoverage: "unavailable"
      },
      endedAt: "2026-06-08T00:00:01.000Z",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 15,
      llmModels: ["gpt-5.4"],
      filesChanged: [],
      estimatedNanoUsd: 0,
      usageValueNanoUsd: 100_000,
      costEstimateBasis: "unavailable",
      costCoverage: "unavailable",
      state: "completed"
    };

    expect(guard.validatePublication(event).ok).toBe(true);
    expect(guard.validatePublication({
      ...event,
      codingHarness: "cursor",
      runtime: "cursor",
      evidence: {
        ...event.evidence,
        sourceId: "hook_cursor_lifecycle",
        profileVersion: "cursor-hooks-v1"
      }
    }).ok).toBe(true);
    expect(guard.validatePublication({ ...event, usageValueNanoUsd: -1 }).ok).toBe(false);
    expect(guard.validatePublication({ ...event, usageValueUsd: 0.0001 }).ok).toBe(false);
  });
});
