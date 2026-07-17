import { request } from "node:http";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStorageClient } from "@tirion/agent-storage";
import {
  CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES,
  OtlpIngress,
  readClaudeTranscriptTail
} from "./otlpIngress";

const ingresses: OtlpIngress[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...ingresses.splice(0).map((ingress) => ingress.stop()),
    ...tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  ]);
});

describe("OtlpIngress", () => {
  it("acknowledges after durable append without waiting for downstream processing", async () => {
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation: vi.fn(async () => true)
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      async () => {
        await new Promise(() => undefined);
      }
    );
    ingresses.push(ingress);
    await ingress.start();

    const response = callOtlp(ingress.address().port, "/v1/traces", codexTraceBody())
      .catch((error: Error) => ({ error: error.message }));
    const result = await Promise.race([
      response,
      wait(100).then(() => "timed_out")
    ]);

    expect(result).toMatchObject({ status: 200 });
    expect(storage.appendSafeObservation).toHaveBeenCalledTimes(1);
  });

  it("does not report a pre-stop drain while an accepted ingress request is still durable-writing", async () => {
    let releaseAppend: (() => void) | undefined;
    let appendStarted: (() => void) | undefined;
    const appendStartedPromise = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation: vi.fn(async () => {
        appendStarted?.();
        await new Promise<void>((resolve) => {
          releaseAppend = resolve;
        });
        return true;
      })
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z")
    );
    ingresses.push(ingress);
    await ingress.start();

    const response = callOtlp(ingress.address().port, "/v1/traces", codexTraceBody());
    await appendStartedPromise;
    await expect(ingress.drainAcceptedWork(10)).resolves.toBe(false);
    releaseAppend?.();
    await expect(response).resolves.toMatchObject({ status: 200 });
    await expect(ingress.drainAcceptedWork(100)).resolves.toBe(true);
  });

  it("seals direct ingress only after detached accepted-work admission settles", async () => {
    let releaseAccepted: (() => void) | undefined;
    let acceptedStarted: (() => void) | undefined;
    const acceptedStartedPromise = new Promise<void>((resolve) => {
      acceptedStarted = resolve;
    });
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation: vi.fn(async () => true)
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      async () => {
        acceptedStarted?.();
        await new Promise<void>((resolve) => {
          releaseAccepted = resolve;
        });
      }
    );
    ingresses.push(ingress);
    await ingress.start();

    await expect(callOtlp(ingress.address().port, "/v1/traces", codexTraceBody())).resolves.toMatchObject({ status: 200 });
    await acceptedStartedPromise;

    let sealResolved = false;
    const seal = ingress.sealForQuiesce(500).then((result) => {
      sealResolved = true;
      return result;
    });
    await wait(20);
    expect(sealResolved).toBe(false);

    releaseAccepted?.();
    await expect(seal).resolves.toBe(true);
    await expect(callOtlp(ingress.address().port, "/v1/traces", codexTraceBody())).resolves.toMatchObject({ status: 409 });
    expect(ingress.ingressSealStatus()).toEqual({ sealed: true, postSealRequestCount: 1 });
  });

  it("resolves provider-hook workspace context to an opaque repository key before persistence", async () => {
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const resolveWorkspaceEvidence = vi.fn(async (_workspacePath: string, artifactPaths: string[]) => ({
      repositoryKey: "repo_target",
      artifactKeys: artifactPaths.length > 0 ? ["artifact_target"] : []
    }));
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      undefined,
      undefined,
      undefined,
      200,
      resolveWorkspaceEvidence
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/codex", {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-1",
      transcript_path: "/private/session/session-1.jsonl",
      cwd: "/Users/example/private/project",
      prompt: "private prompt"
    })).toMatchObject({ status: 200 });

    expect(resolveWorkspaceEvidence).toHaveBeenCalledWith("/Users/example/private/project", []);
    const observation = appendSafeObservation.mock.calls[0]?.[0];
    expect(observation).toMatchObject({
      repositoryKey: "repo_target",
      queryOccurrences: [expect.objectContaining({ repositoryKey: "repo_target" })]
    });
    expect(JSON.stringify(observation)).not.toContain("/Users/example/private/project");
    expect(JSON.stringify(observation)).not.toContain("private prompt");

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/codex", {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: "/Users/example/private/project",
      tool_name: "Write",
      tool_use_id: "tool-1",
      tool_input: { file_path: "src/private.ts", content: "private content" },
      tool_response: { success: true }
    })).toMatchObject({ status: 200 });

    expect(resolveWorkspaceEvidence).toHaveBeenLastCalledWith(
      "/Users/example/private/project",
      ["src/private.ts"]
    );
    const toolObservation = appendSafeObservation.mock.calls[1]?.[0];
    expect(toolObservation).toMatchObject({
      repositoryKey: "repo_target",
      executionNodes: [expect.objectContaining({
        artifactKeys: ["artifact_target"],
        artifactEvidence: "provider_write_hook"
      })]
    });
    expect(JSON.stringify(toolObservation)).not.toContain("src/private.ts");
    expect(JSON.stringify(toolObservation)).not.toContain("private content");

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/codex", {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: "/Users/example/private/project",
      tool_name: "apply_patch",
      tool_use_id: "tool-2",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: src/created.ts\n+private\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch"
      },
      tool_response: { success: true }
    })).toMatchObject({ status: 200 });
    expect(resolveWorkspaceEvidence).toHaveBeenLastCalledWith(
      "/Users/example/private/project",
      ["src/created.ts", "README.md"]
    );
    expect(JSON.stringify(appendSafeObservation.mock.calls[2]?.[0])).not.toContain("src/created.ts");
    expect(JSON.stringify(appendSafeObservation.mock.calls[2]?.[0])).not.toContain("private");
  });

  it("persists only an unbound opaque marker for transcriptless Codex internal work", async () => {
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const resolveWorkspaceEvidence = vi.fn(async () => ({
      repositoryKey: "repo_must_not_bind",
      artifactKeys: []
    }));
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      undefined,
      undefined,
      undefined,
      200,
      resolveWorkspaceEvidence
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/codex", {
      hook_event_name: "UserPromptSubmit",
      session_id: "private-internal-session",
      turn_id: "private-internal-turn",
      transcript_path: null,
      cwd: "/Users/example/private/project"
    })).toMatchObject({ status: 200 });

    const observation = appendSafeObservation.mock.calls[0]?.[0];
    expect(observation).toMatchObject({
      sourceId: "hook_codex_internal",
      queryOccurrences: [expect.objectContaining({ lifecycleVisibility: "internal" })],
      usageAtoms: []
    });
    expect(observation).not.toHaveProperty("repositoryKey");
    expect(observation?.queryOccurrences?.[0]).not.toHaveProperty("repositoryKey");
    expect(JSON.stringify(observation)).not.toContain("private-internal-session");
    expect(JSON.stringify(observation)).not.toContain("private-internal-turn");
    expect(JSON.stringify(observation)).not.toContain("/Users/example/private/project");
  });

  it("normalizes provider hook aliases before resolving transient workspace evidence", async () => {
    const appendSafeObservation = vi.fn(async () => true);
    const resolveWorkspaceEvidence = vi.fn(async () => ({
      repositoryKey: "repo_alias_target",
      artifactKeys: []
    }));
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      undefined,
      undefined,
      undefined,
      200,
      resolveWorkspaceEvidence
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/codex", {
      hookEventName: "UserPromptSubmit",
      sessionId: "private-session-id",
      turnId: "private-turn-id",
      transcriptPath: "/private/session/private-session-id.jsonl",
      workingDirectory: "/Users/example/private/project"
    })).toMatchObject({ status: 200 });

    expect(resolveWorkspaceEvidence).toHaveBeenCalledWith("/Users/example/private/project", []);
    const observation = appendSafeObservation.mock.calls[0]?.[0];
    expect(observation).toMatchObject({
      repositoryKey: "repo_alias_target",
      queryOccurrences: [expect.objectContaining({ repositoryKey: "repo_alias_target" })]
    });
    expect(JSON.stringify(observation)).not.toContain("private-session-id");
    expect(JSON.stringify(observation)).not.toContain("private-turn-id");
    expect(JSON.stringify(observation)).not.toContain("/Users/example/private/project");
  });

  it("records only safe hook-shape diagnostics for ignored provider events", async () => {
    const diagnostics = vi.fn();
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation: vi.fn(async () => true)
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      undefined,
      diagnostics
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/codex", {
      hookEventName: "Unrecognized private event",
      sessionId: "private-session-id",
      workingDirectory: "/Users/example/private/project"
    })).toMatchObject({ status: 200 });

    const ignored = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_event_ignored");
    expect(ignored).toMatchObject({
      details: {
        hookEvent: "unknown",
        hasSessionId: true,
        hasTurnId: false,
        hasWorkspacePath: true
      }
    });
    expect(JSON.stringify(ignored)).not.toContain("private-session-id");
    expect(JSON.stringify(ignored)).not.toContain("/Users/example/private/project");
  });

  it("reduces ignored Claude StopFailure and paused-stop payloads to bounded safe diagnostics", async () => {
    const diagnostics = vi.fn();
    const upsertSource = vi.fn(async () => undefined);
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource,
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      undefined,
      diagnostics
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hookEventName: "StopFailure",
      sessionId: "private-claude-session",
      transcriptPath: "/private/transcripts/private-claude-session.jsonl",
      workingDirectory: "/Users/example/private/project",
      errorType: "rate_limit",
      error_details: "PRIVATE_ERROR_DETAILS_CANARY",
      last_assistant_message: "PRIVATE_ASSISTANT_CANARY",
      stopHookActive: true,
      backgroundTasks: [{
        type: "shell",
        status: "running",
        command: "PRIVATE_COMMAND_CANARY",
        description: "PRIVATE_DESCRIPTION_CANARY"
      }],
      sessionCrons: [{
        recurring: true,
        prompt: "PRIVATE_CRON_PROMPT_CANARY"
      }]
    })).toMatchObject({ status: 200 });

    expect(appendSafeObservation).not.toHaveBeenCalled();
    const ignored = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_event_ignored");
    expect(ignored).toMatchObject({
      details: {
        hookEvent: "stop_failure",
        hasSessionId: true,
        hasTurnId: false,
        hasTranscriptPath: true,
        hasWorkspacePath: true,
        stopHookActive: true,
        backgroundTaskCount: 1,
        sessionCronCount: 1,
        hasStructuredErrorCategory: true
      }
    });
    const serialized = JSON.stringify(ignored);
    for (const canary of [
      "private-claude-session",
      "/private/transcripts",
      "/Users/example/private/project",
      "PRIVATE_ERROR_DETAILS_CANARY",
      "PRIVATE_ASSISTANT_CANARY",
      "PRIVATE_COMMAND_CANARY",
      "PRIVATE_DESCRIPTION_CANARY",
      "PRIVATE_CRON_PROMPT_CANARY"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("drops forged Claude provenance diagnostic reasons before recording ingress diagnostics", async () => {
    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      undefined,
      diagnostics
    );
    ingresses.push(ingress);
    await ingress.start();

    const privateCanary = "PRIVATE_FORGED_CLAUDE_PROVENANCE_REASON_CANARY";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "Stop",
      session_id: "private-forged-provenance-session",
      tirion_claude_submission_provenance: {
        state: "unavailable",
        diagnosticReason: privateCanary
      }
    })).toMatchObject({ status: 200 });

    expect(appendSafeObservation).not.toHaveBeenCalled();
    const ignored = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_event_ignored");
    expect(ignored).toMatchObject({
      details: { claudeSubmissionProvenance: "unavailable" }
    });
    expect(ignored?.details).not.toHaveProperty("claudeSubmissionProvenanceReason");
    expect(JSON.stringify({ ignored, appended: appendSafeObservation.mock.calls })).not.toContain(privateCanary);
  });

  it("accepts only human Claude transcript provenance and suppresses task-notification ghosts", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_INGRESS_CLAUDE_SESSION_CANARY";
    const humanPrompt = "PRIVATE_INGRESS_HUMAN_PROMPT_ID_CANARY";
    const taskPrompt = "PRIVATE_INGRESS_TASK_PROMPT_ID_CANARY";
    const humanRecord = claudeTranscriptRecord({
      sessionId: session,
      promptId: humanPrompt,
      timestamp: "2026-07-12T21:58:20.725Z",
      originKind: "human",
      promptSource: "typed",
      content: "PRIVATE_RAW_HOOK_PROMPT_CANARY"
    });
    await writeFile(transcript, `${JSON.stringify(humanRecord)}\n`);

    let observedAt = "2026-07-12T21:58:20.725Z";
    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: humanPrompt,
      transcript_path: transcript,
      prompt: "PRIVATE_RAW_HOOK_PROMPT_CANARY",
      tirion_claude_submission_prompt_digest: "0".repeat(64)
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).toHaveBeenCalledTimes(1);
    expect(appendSafeObservation.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-code",
      queryOccurrences: [expect.objectContaining({ evidence: "submission_hook" })]
    });

    observedAt = "2026-07-12T21:58:27.767Z";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: humanPrompt,
      transcript_path: transcript,
      background_tasks: [{ task_id: "one" }, { task_id: "two" }, { task_id: "three" }]
    })).toMatchObject({ status: 200 });

    const taskRecord = claudeTranscriptRecord({
      sessionId: session,
      promptId: taskPrompt,
      timestamp: "2026-07-12T21:58:28.356Z",
      originKind: "task-notification",
      promptSource: "system",
      content: "PRIVATE_RAW_TASK_HOOK_PROMPT_CANARY"
    });
    await writeFile(transcript, `${JSON.stringify(humanRecord)}\n${JSON.stringify(taskRecord)}\n`);
    observedAt = "2026-07-12T21:58:28.356Z";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: "PRIVATE_MISMATCHED_RAW_TASK_ID_CANARY",
      transcript_path: transcript,
      prompt: "PRIVATE_RAW_TASK_HOOK_PROMPT_CANARY"
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).toHaveBeenCalledTimes(1);

    const accepted = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_observation_accepted");
    const ignoredTask = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_event_ignored"
        && event.details?.claudeSubmissionProvenance === "task_notification_system");
    expect(accepted).toMatchObject({
      details: { claudeSubmissionProvenance: "human_typed" }
    });
    expect(ignoredTask).toMatchObject({
      details: { claudeSubmissionProvenance: "task_notification_system" }
    });
    const serialized = JSON.stringify({
      observation: appendSafeObservation.mock.calls[0]?.[0],
      accepted,
      ignoredTask
    });
    for (const canary of [
      session,
      humanPrompt,
      taskPrompt,
      transcript,
      "PRIVATE_INGRESS_HUMAN_CONTENT_CANARY",
      "PRIVATE_INGRESS_TASK_CONTENT_CANARY",
      "PRIVATE_RAW_HOOK_PROMPT_CANARY",
      "PRIVATE_RAW_TASK_HOOK_PROMPT_CANARY",
      "PRIVATE_MISMATCHED_RAW_TASK_ID_CANARY"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("retries Claude provenance after returning from the synchronous hook", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_DEFERRED_CLAUDE_SESSION_CANARY";
    const promptId = "PRIVATE_DEFERRED_CLAUDE_PROMPT_ID_CANARY";
    let observedAt = "2026-07-12T22:46:34.185Z";
    await writeFile(transcript, "");

    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      cwd: root,
      prompt: "PRIVATE_DEFERRED_RAW_PROMPT_CONTENT_CANARY"
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).not.toHaveBeenCalled();
    expect(diagnostics.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      reason: "claude_transcript_provenance_pending",
      state: "deferred"
    }));

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "PostToolUse",
      session_id: session,
      cwd: root,
      tool_name: "Agent",
      tool_use_id: "PRIVATE_DEFERRED_AGENT_TOOL_USE_ID_CANARY",
      tool_input: {
        subagent_type: "Explore",
        prompt: "PRIVATE_DEFERRED_AGENT_INPUT_CONTENT_CANARY"
      },
      tool_response: {
        agentId: "PRIVATE_DEFERRED_AGENT_ID_CANARY",
        content: "PRIVATE_DEFERRED_AGENT_RESPONSE_CONTENT_CANARY"
      }
    })).toMatchObject({ status: 200 });
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "SubagentStart",
      session_id: session,
      cwd: root,
      agent_id: "PRIVATE_DEFERRED_AGENT_ID_CANARY",
      agent_type: "Explore"
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).not.toHaveBeenCalled();

    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId,
      timestamp: "2026-07-12T22:46:34.165Z",
      originKind: "human",
      promptSource: "typed",
      content: "PRIVATE_DEFERRED_RAW_PROMPT_CONTENT_CANARY"
    }))}\n`);
    for (let attempt = 0; attempt < 20 && appendSafeObservation.mock.calls.length < 3; attempt += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(3);
    expect(appendSafeObservation.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-code",
      queryOccurrences: [expect.objectContaining({ evidence: "submission_hook" })]
    });
    expect(appendSafeObservation.mock.calls.slice(1).map(([observation]) => observation)).toEqual([
      expect.objectContaining({
        activityAtoms: [expect.objectContaining({
          kind: "subagent",
          name: "Explore",
          childSessionId: expect.stringMatching(/^ses_/)
        })]
      }),
      expect.objectContaining({
        activityAtoms: [expect.objectContaining({
          kind: "subagent",
          name: "Explore",
          childSessionId: expect.stringMatching(/^ses_/)
        })]
      })
    ]);
    const accepted = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_observation_accepted");
    expect(accepted).toMatchObject({
      details: { claudeSubmissionProvenance: "human_typed" }
    });

    observedAt = "2026-07-12T22:46:40.980Z";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      cwd: root,
      prompt: "PRIVATE_DEFERRED_TASK_RAW_CONTENT_CANARY"
    })).toMatchObject({ status: 200 });
    await appendFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId: "PRIVATE_DEFERRED_TASK_PROMPT_ID_CANARY",
      timestamp: "2026-07-12T22:46:40.977Z",
      originKind: "task-notification",
      promptSource: "system",
      content: "PRIVATE_DEFERRED_TASK_RAW_CONTENT_CANARY"
    }))}\n`);
    let taskIgnored: unknown;
    for (let attempt = 0; attempt < 20 && !taskIgnored; attempt += 1) {
      await wait(10);
      taskIgnored = diagnostics.mock.calls.map(([event]) => event)
        .find((event) => event.reason === "provider_hook_event_ignored"
          && event.details?.claudeSubmissionProvenance === "task_notification_system");
    }
    expect(taskIgnored).toMatchObject({
      details: { claudeSubmissionProvenance: "task_notification_system" }
    });
    expect(appendSafeObservation).toHaveBeenCalledTimes(3);

    const serialized = JSON.stringify({
      observation: appendSafeObservation.mock.calls[0]?.[0],
      diagnostics: diagnostics.mock.calls
    });
    for (const canary of [
      session,
      promptId,
      transcript,
      "PRIVATE_DEFERRED_RAW_PROMPT_CONTENT_CANARY",
      "PRIVATE_DEFERRED_TRANSCRIPT_CONTENT_CANARY",
      "PRIVATE_DEFERRED_TASK_PROMPT_ID_CANARY",
      "PRIVATE_DEFERRED_TASK_RAW_CONTENT_CANARY",
      "PRIVATE_DEFERRED_TASK_TRANSCRIPT_CONTENT_CANARY",
      "PRIVATE_DEFERRED_AGENT_TOOL_USE_ID_CANARY",
      "PRIVATE_DEFERRED_AGENT_ID_CANARY",
      "PRIVATE_DEFERRED_AGENT_INPUT_CONTENT_CANARY",
      "PRIVATE_DEFERRED_AGENT_RESPONSE_CONTENT_CANARY"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("replays a pending interrupted Claude shell hook without retaining its content", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_PENDING_INTERRUPT_SESSION_CANARY";
    const promptId = "PRIVATE_PENDING_INTERRUPT_PROMPT_ID_CANARY";
    const command = "PRIVATE_PENDING_INTERRUPT_COMMAND_CANARY";
    const output = "PRIVATE_PENDING_INTERRUPT_OUTPUT_CANARY";
    const observedAt = "2026-07-13T17:16:26.394Z";
    await writeFile(transcript, "");

    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      cwd: root,
      prompt: "PRIVATE_PENDING_INTERRUPT_PROMPT_CONTENT_CANARY"
    })).toMatchObject({ status: 200 });
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "PostToolUse",
      session_id: session,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "PRIVATE_PENDING_INTERRUPT_TOOL_USE_ID_CANARY",
      tool_input: { command },
      tool_response: {
        interrupted: true,
        stdout: output,
        stderr: output
      }
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).not.toHaveBeenCalled();

    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId,
      timestamp: "2026-07-13T17:16:26.350Z",
      originKind: "human",
      promptSource: "typed",
      content: "PRIVATE_PENDING_INTERRUPT_PROMPT_CONTENT_CANARY"
    }))}\n`);
    for (let attempt = 0; attempt < 20 && appendSafeObservation.mock.calls.length < 2; attempt += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(2);
    expect(appendSafeObservation.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-code",
      queryOccurrences: [expect.objectContaining({ evidence: "submission_hook" })]
    });
    expect(appendSafeObservation.mock.calls[1]?.[0]).toMatchObject({
      provider: "claude-code",
      sourceId: "hook_claude_code_tools",
      activityAtoms: [expect.objectContaining({
        kind: "tool",
        name: "Bash",
        outcome: "rejected"
      })],
      executionNodes: [expect.objectContaining({
        nodeKind: "tool",
        name: "Bash",
        outcome: "rejected"
      })]
    });
    const serialized = JSON.stringify({
      observations: appendSafeObservation.mock.calls,
      diagnostics: diagnostics.mock.calls
    });
    for (const canary of [
      session,
      promptId,
      transcript,
      root,
      command,
      output,
      "PRIVATE_PENDING_INTERRUPT_PROMPT_CONTENT_CANARY",
      "PRIVATE_PENDING_INTERRUPT_TOOL_USE_ID_CANARY"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("replays a pending namespaced Claude MCP success hook without retaining its content", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_PENDING_MCP_SUCCESS_SESSION_CANARY";
    const promptId = "PRIVATE_PENDING_MCP_SUCCESS_PROMPT_ID_CANARY";
    const prompt = "PRIVATE_PENDING_MCP_SUCCESS_PROMPT_CONTENT_CANARY";
    const toolUseId = "PRIVATE_PENDING_MCP_SUCCESS_TOOL_USE_ID_CANARY";
    const toolInput = "PRIVATE_PENDING_MCP_SUCCESS_INPUT_CANARY";
    const toolResponse = "PRIVATE_PENDING_MCP_SUCCESS_RESPONSE_CANARY";
    const toolResponseAgentId = "PRIVATE_PENDING_MCP_SUCCESS_AGENT_ID_CANARY";
    const observedAt = "2026-07-15T16:35:58.000Z";
    await writeFile(transcript, "");

    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      cwd: root,
      prompt
    })).toMatchObject({ status: 200 });
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "PostToolUse",
      session_id: session,
      cwd: root,
      tool_name: "mcp__tirion_cc18_local__tirion_cc18_readonly_success",
      tool_use_id: toolUseId,
      tool_input: { arguments: { canary: toolInput } },
      tool_response: { agentId: toolResponseAgentId, content: toolResponse }
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).not.toHaveBeenCalled();

    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId,
      timestamp: "2026-07-15T16:35:57.980Z",
      originKind: "human",
      promptSource: "typed",
      content: prompt
    }))}\n`);
    for (let attempt = 0; attempt < 20 && appendSafeObservation.mock.calls.length < 2; attempt += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(2);
    const queryId = appendSafeObservation.mock.calls[0]?.[0].queryOccurrences?.[0]?.queryId;
    expect(queryId).toMatch(/^qry_/);
    expect(appendSafeObservation.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-code",
      queryOccurrences: [expect.objectContaining({ evidence: "submission_hook", queryId })]
    });
    expect(appendSafeObservation.mock.calls[1]?.[0]).toMatchObject({
      provider: "claude-code",
      sourceId: "hook_claude_code_tools",
      activityAtoms: [expect.objectContaining({
        queryId,
        kind: "mcp",
        name: "tirion_cc18_local/tirion_cc18_readonly_success",
        outcome: "success"
      })],
      executionNodes: [expect.objectContaining({
        queryId,
        nodeKind: "mcp",
        name: "tirion_cc18_local/tirion_cc18_readonly_success",
        outcome: "success"
      })]
    });
    const serialized = JSON.stringify({
      observations: appendSafeObservation.mock.calls,
      diagnostics: diagnostics.mock.calls
    });
    for (const canary of [
      session,
      promptId,
      transcript,
      root,
      prompt,
      toolUseId,
      toolInput,
      toolResponse,
      toolResponseAgentId
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("replays a pending namespaced Claude MCP failure hook without retaining its content", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_PENDING_MCP_FAILURE_SESSION_CANARY";
    const promptId = "PRIVATE_PENDING_MCP_FAILURE_PROMPT_ID_CANARY";
    const prompt = "PRIVATE_PENDING_MCP_FAILURE_PROMPT_CONTENT_CANARY";
    const toolUseId = "PRIVATE_PENDING_MCP_FAILURE_TOOL_USE_ID_CANARY";
    const toolInput = "PRIVATE_PENDING_MCP_FAILURE_INPUT_CANARY";
    const toolResponse = "PRIVATE_PENDING_MCP_FAILURE_RESPONSE_CANARY";
    const failure = "PRIVATE_PENDING_MCP_FAILURE_ERROR_CANARY";
    const observedAt = "2026-07-15T16:35:59.000Z";
    await writeFile(transcript, "");

    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      cwd: root,
      prompt
    })).toMatchObject({ status: 200 });
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "PostToolUseFailure",
      session_id: session,
      cwd: root,
      tool_name: "mcp__tirion_cc18_local__tirion_cc18_controlled_failure",
      tool_use_id: toolUseId,
      tool_input: { arguments: { canary: toolInput } },
      tool_response: { content: toolResponse },
      error: failure
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).not.toHaveBeenCalled();

    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId,
      timestamp: "2026-07-15T16:35:58.980Z",
      originKind: "human",
      promptSource: "typed",
      content: prompt
    }))}\n`);
    for (let attempt = 0; attempt < 20 && appendSafeObservation.mock.calls.length < 2; attempt += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(2);
    const queryId = appendSafeObservation.mock.calls[0]?.[0].queryOccurrences?.[0]?.queryId;
    expect(queryId).toMatch(/^qry_/);
    expect(appendSafeObservation.mock.calls[1]?.[0]).toMatchObject({
      provider: "claude-code",
      sourceId: "hook_claude_code_tools",
      activityAtoms: [expect.objectContaining({
        queryId,
        kind: "mcp",
        name: "tirion_cc18_local/tirion_cc18_controlled_failure",
        outcome: "failure"
      })],
      executionNodes: [expect.objectContaining({
        queryId,
        nodeKind: "mcp",
        name: "tirion_cc18_local/tirion_cc18_controlled_failure",
        outcome: "failure"
      })]
    });
    const serialized = JSON.stringify({
      observations: appendSafeObservation.mock.calls,
      diagnostics: diagnostics.mock.calls
    });
    for (const canary of [
      session,
      promptId,
      transcript,
      root,
      prompt,
      toolUseId,
      toolInput,
      toolResponse,
      failure
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("does not replay a malformed pending Claude MCP-like tool name", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_PENDING_MCP_MALFORMED_SESSION_CANARY";
    const promptId = "PRIVATE_PENDING_MCP_MALFORMED_PROMPT_ID_CANARY";
    const prompt = "PRIVATE_PENDING_MCP_MALFORMED_PROMPT_CONTENT_CANARY";
    const toolUseId = "PRIVATE_PENDING_MCP_MALFORMED_TOOL_USE_ID_CANARY";
    const toolInput = "PRIVATE_PENDING_MCP_MALFORMED_INPUT_CANARY";
    const toolResponse = "PRIVATE_PENDING_MCP_MALFORMED_RESPONSE_CANARY";
    const malformedToolName = "mcp__tirion_cc18_local__bad tool";
    const observedAt = "2026-07-15T16:36:00.000Z";
    await writeFile(transcript, "");

    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      cwd: root,
      prompt
    })).toMatchObject({ status: 200 });
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "PostToolUse",
      session_id: session,
      cwd: root,
      tool_name: malformedToolName,
      tool_use_id: toolUseId,
      tool_input: { arguments: { canary: toolInput } },
      tool_response: { content: toolResponse }
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).not.toHaveBeenCalled();

    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId,
      timestamp: "2026-07-15T16:35:59.980Z",
      originKind: "human",
      promptSource: "typed",
      content: prompt
    }))}\n`);
    for (let attempt = 0; attempt < 20 && appendSafeObservation.mock.calls.length < 1; attempt += 1) {
      await wait(10);
    }
    await expect(ingress.drainAcceptedWork(100)).resolves.toBe(true);

    expect(appendSafeObservation).toHaveBeenCalledTimes(1);
    expect(appendSafeObservation.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-code",
      queryOccurrences: [expect.objectContaining({ evidence: "submission_hook" })]
    });
    const serialized = JSON.stringify({
      observations: appendSafeObservation.mock.calls,
      diagnostics: diagnostics.mock.calls
    });
    for (const canary of [
      session,
      promptId,
      transcript,
      root,
      prompt,
      toolUseId,
      toolInput,
      toolResponse,
      malformedToolName
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("continues safe pending-hook replay and releases state after one exhausted append", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_REPLAY_FAILURE_SESSION_CANARY";
    const promptId = "PRIVATE_REPLAY_FAILURE_PROMPT_ID_CANARY";
    const prompt = "PRIVATE_REPLAY_FAILURE_CONTENT_CANARY";
    await writeFile(transcript, "");
    const diagnostics = vi.fn();
    const durable: unknown[] = [];
    let attempt = 0;
    const appendSafeObservation = vi.fn(async (observation: unknown) => {
      attempt += 1;
      if (attempt === 2 || attempt === 3) {
        throw new Error("transient_storage_failure");
      }
      durable.push(observation);
      return true;
    });
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-07-12T22:46:34.185Z"),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt
    });
    await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "PostToolUse",
      session_id: session,
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore", prompt: "PRIVATE_REPLAY_FAILURE_AGENT_PROMPT" },
      tool_response: { agentId: "PRIVATE_REPLAY_FAILURE_AGENT_ID" }
    });
    await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "SubagentStart",
      session_id: session,
      agent_id: "PRIVATE_REPLAY_FAILURE_AGENT_ID",
      agent_type: "Explore"
    });
    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId,
      timestamp: "2026-07-12T22:46:34.165Z",
      originKind: "human",
      promptSource: "typed",
      content: prompt
    }))}\n`);
    for (let poll = 0; poll < 20 && attempt < 4; poll += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(4);
    expect(durable).toHaveLength(2);
    expect(diagnostics.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      reason: "claude_deferred_hook_processing_failed",
      state: "rejected"
    }));
    const serialized = JSON.stringify({ durable, diagnostics: diagnostics.mock.calls });
    for (const canary of [session, promptId, prompt, "PRIVATE_REPLAY_FAILURE_AGENT_PROMPT", "PRIVATE_REPLAY_FAILURE_AGENT_ID"]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("does not accept a stale nearest transcript row for an id-less Claude hook", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_STALE_TAIL_SESSION_CANARY";
    const observedAt = "2026-07-12T22:46:40.980Z";
    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId: "PRIVATE_STALE_HUMAN_PROMPT_ID_CANARY",
      timestamp: "2026-07-12T22:46:39.980Z",
      originKind: "human",
      promptSource: "typed",
      content: "PRIVATE_REPEATED_PROMPT_CONTENT_CANARY"
    }))}\n`);
    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: "PRIVATE_REPEATED_PROMPT_CONTENT_CANARY"
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).not.toHaveBeenCalled();
    expect(diagnostics.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      reason: "claude_transcript_provenance_pending"
    }));

    await appendFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId: "PRIVATE_CURRENT_TASK_PROMPT_ID_CANARY",
      timestamp: "2026-07-12T22:46:40.977Z",
      originKind: "task-notification",
      promptSource: "system",
      content: "PRIVATE_REPEATED_PROMPT_CONTENT_CANARY"
    }))}\n`);
    let taskIgnored: unknown;
    for (let attempt = 0; attempt < 20 && !taskIgnored; attempt += 1) {
      await wait(10);
      taskIgnored = diagnostics.mock.calls.map(([event]) => event)
        .find((event) => event.reason === "provider_hook_event_ignored"
          && event.details?.claudeSubmissionProvenance === "task_notification_system");
    }

    expect(taskIgnored).toBeDefined();
    expect(appendSafeObservation).not.toHaveBeenCalled();
    const serialized = JSON.stringify(diagnostics.mock.calls);
    for (const canary of [
      session,
      transcript,
      "PRIVATE_STALE_HUMAN_PROMPT_ID_CANARY",
      "PRIVATE_CURRENT_TASK_PROMPT_ID_CANARY",
      "PRIVATE_REPEATED_PROMPT_CONTENT_CANARY"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("does not reuse a consumed rapid identical transcript row for an id-less hook", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_CONSUMED_ROW_SESSION_CANARY";
    const repeatedPromptId = "PRIVATE_CONSUMED_ROW_PROMPT_ID_CANARY";
    const repeatedPrompt = "PRIVATE_CONSUMED_ROW_CONTENT_CANARY";
    const firstRecord = claudeTranscriptRecord({
      sessionId: session,
      promptId: repeatedPromptId,
      timestamp: "2026-07-12T22:46:40.977Z",
      originKind: "human",
      promptSource: "typed",
      content: repeatedPrompt
    });
    await writeFile(transcript, `${JSON.stringify(firstRecord)}\n`);
    let observedAt = "2026-07-12T22:46:40.980Z";
    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: repeatedPrompt
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).toHaveBeenCalledTimes(1);

    observedAt = "2026-07-12T22:46:40.983Z";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: repeatedPrompt
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).toHaveBeenCalledTimes(1);
    expect(diagnostics.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      reason: "claude_transcript_provenance_pending"
    }));

    await appendFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId: repeatedPromptId,
      timestamp: "2026-07-12T22:46:40.984Z",
      originKind: "task-notification",
      promptSource: "system",
      content: repeatedPrompt
    }))}\n`);
    let taskIgnored: unknown;
    for (let attempt = 0; attempt < 20 && !taskIgnored; attempt += 1) {
      await wait(10);
      taskIgnored = diagnostics.mock.calls.map(([event]) => event)
        .find((event) => event.reason === "provider_hook_event_ignored"
          && event.details?.claudeSubmissionProvenance === "task_notification_system");
    }

    expect(taskIgnored).toBeDefined();
    expect(appendSafeObservation).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify({ diagnostics: diagnostics.mock.calls, calls: appendSafeObservation.mock.calls });
    for (const canary of [session, repeatedPromptId, repeatedPrompt]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("reserves an uncommitted transcript row across overlapping identical id-less hooks", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_RESERVED_ROW_SESSION_CANARY";
    const repeatedPrompt = "PRIVATE_RESERVED_ROW_CONTENT_CANARY";
    const firstPromptId = "PRIVATE_RESERVED_ROW_PROMPT_ONE_ID_CANARY";
    const secondPromptId = "PRIVATE_RESERVED_ROW_PROMPT_TWO_ID_CANARY";
    const firstRecord = claudeTranscriptRecord({
      sessionId: session,
      promptId: firstPromptId,
      timestamp: "2026-07-12T22:46:34.165Z",
      originKind: "human",
      promptSource: "typed",
      content: repeatedPrompt
    });
    await writeFile(transcript, `${JSON.stringify(firstRecord)}\n`);
    let observedAt = "2026-07-12T22:46:34.185Z";
    let releaseFirstAppend!: () => void;
    const firstAppendGate = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    const durable: unknown[] = [];
    let appendAttempt = 0;
    const appendSafeObservation = vi.fn(async (observation: unknown) => {
      appendAttempt += 1;
      if (appendAttempt === 1) {
        await firstAppendGate;
      }
      durable.push(observation);
      return true;
    });
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      undefined,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    const firstResponse = callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: repeatedPrompt
    });
    for (let poll = 0; poll < 20 && appendAttempt < 1; poll += 1) {
      await wait(2);
    }
    expect(appendAttempt).toBe(1);

    observedAt = "2026-07-12T22:46:34.205Z";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: repeatedPrompt
    })).toMatchObject({ status: 200 });
    expect(appendAttempt).toBe(1);
    await appendFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId: secondPromptId,
      timestamp: "2026-07-12T22:46:34.195Z",
      originKind: "human",
      promptSource: "typed",
      content: repeatedPrompt
    }))}\n`);
    releaseFirstAppend();
    expect(await firstResponse).toMatchObject({ status: 200 });
    for (let poll = 0; poll < 20 && durable.length < 2; poll += 1) {
      await wait(10);
    }

    expect(durable).toHaveLength(2);
    const queryIds = durable.flatMap((observation) =>
      (observation as { queryOccurrences?: Array<{ queryId: string }> }).queryOccurrences?.map((item) => item.queryId) ?? []
    );
    expect(new Set(queryIds).size).toBe(2);
    const serialized = JSON.stringify(durable);
    for (const canary of [session, repeatedPrompt, firstPromptId, secondPromptId]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("replays safe StopFailure metadata while preserving object and string paused-work evidence", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_DEFERRED_FAILURE_SESSION_CANARY";
    const promptId = "PRIVATE_DEFERRED_FAILURE_PROMPT_ID_CANARY";
    const prompt = "PRIVATE_DEFERRED_FAILURE_CONTENT_CANARY";
    const observedAt = "2026-07-12T22:46:34.185Z";
    await writeFile(transcript, "");
    let appendAttempt = 0;
    const appendSafeObservation = vi.fn(async () => {
      appendAttempt += 1;
      if (appendAttempt === 2) {
        throw new Error("PRIVATE_DEFERRED_FAILURE_TRANSIENT_STORAGE_CANARY");
      }
      return true;
    });
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      undefined,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt
    })).toMatchObject({ status: 200 });
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "Stop",
      session_id: session,
      background_tasks: { task: "PRIVATE_DEFERRED_COMMAND_CANARY" },
      session_crons: "PRIVATE_DEFERRED_CRON_CANARY"
    })).toMatchObject({ status: 200 });
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "StopFailure",
      session_id: session,
      error: "rate_limit",
      error_details: "PRIVATE_DEFERRED_FAILURE_DETAIL_CANARY"
    })).toMatchObject({ status: 200 });
    expect(appendSafeObservation).not.toHaveBeenCalled();

    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId,
      timestamp: "2026-07-12T22:46:34.165Z",
      originKind: "human",
      promptSource: "typed",
      content: prompt
    }))}\n`);
    for (let attempt = 0; attempt < 20 && appendSafeObservation.mock.calls.length < 3; attempt += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(3);
    const submission = appendSafeObservation.mock.calls[0]?.[0];
    const failure = appendSafeObservation.mock.calls.at(-1)?.[0];
    expect(submission.queryOccurrences?.[0]).toMatchObject({ evidence: "submission_hook" });
    expect(failure.queryOccurrences?.[0]).toMatchObject({
      queryId: submission.queryOccurrences?.[0]?.queryId,
      completionEvidence: "stop_hook",
      completionOutcome: "failure",
      completionFailureCategory: "rate_limit"
    });
    const serialized = JSON.stringify({ submission, failure });
    for (const canary of [
      session,
      promptId,
      prompt,
      "PRIVATE_DEFERRED_COMMAND_CANARY",
      "PRIVATE_DEFERRED_CRON_CANARY",
      "PRIVATE_DEFERRED_FAILURE_DETAIL_CANARY",
      "PRIVATE_DEFERRED_FAILURE_TRANSIENT_STORAGE_CANARY"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("records Claude SessionEnd only as a bounded privacy-safe diagnostic", async () => {
    const session = "PRIVATE_SESSION_END_SESSION_CANARY";
    const sessionReason = "prompt_input_exit";
    const assistantContent = "PRIVATE_SESSION_END_ASSISTANT_CONTENT_CANARY";
    const diagnostics = vi.fn();
    const upsertSource = vi.fn(async () => undefined);
    const appendSafeObservation = vi.fn(async () => true);
    const onAccepted = vi.fn(async () => undefined);
    const resolveWorkspaceEvidence = vi.fn(async () => undefined);
    const storage = {
      upsertSource,
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-07-13T12:17:28.745Z"),
      onAccepted,
      diagnostics,
      undefined,
      200,
      resolveWorkspaceEvidence
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "SessionEnd",
      session_id: session,
      reason: sessionReason,
      transcript_path: "/private/session-end-transcript.jsonl",
      cwd: "/private/session-end-workspace",
      last_assistant_message: assistantContent
    })).toMatchObject({ status: 200 });
    expect(upsertSource).not.toHaveBeenCalled();
    expect(appendSafeObservation).not.toHaveBeenCalled();
    expect(resolveWorkspaceEvidence).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    const ignored = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_event_ignored");
    expect(diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "claude_background_root_missing_terminal")).toBeUndefined();
    expect(ignored).toMatchObject({
      details: {
        hookEvent: "session_end",
        sessionEndReason: "prompt_input_exit",
        hasSessionId: true,
        hasTranscriptPath: true,
        hasWorkspacePath: true
      }
    });
    const serialized = JSON.stringify(ignored);
    for (const canary of [
      session,
      assistantContent,
      "/private/session-end-transcript.jsonl",
      "/private/session-end-workspace"
    ]) {
      expect(serialized).not.toContain(canary);
    }

    const unknownReason = "PRIVATE_SESSION_END_REASON_CANARY";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "SessionEnd",
      session_id: session,
      reason: unknownReason
    })).toMatchObject({ status: 200 });
    const unknown = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_event_ignored"
        && event.details?.sessionEndReason === "unknown");
    expect(unknown).toBeDefined();
    expect(JSON.stringify(unknown)).not.toContain(unknownReason);
  });

  it("labels Claude PreToolUse in diagnostics without retaining tool content", async () => {
    const session = "PRIVATE_PRE_TOOL_SESSION_CANARY";
    const command = "PRIVATE_PRE_TOOL_COMMAND_CANARY";
    const workspacePath = "/private/pre-tool-workspace";
    const diagnostics = vi.fn();
    const upsertSource = vi.fn(async () => undefined);
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource,
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-07-13T17:45:57.453Z"),
      undefined,
      diagnostics
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "PreToolUse",
      session_id: session,
      cwd: workspacePath,
      tool_name: "Bash",
      tool_use_id: "PRIVATE_PRE_TOOL_USE_ID_CANARY",
      tool_input: { command }
    }, {
      "X-Tirion-Hook-Event": "PreToolUse"
    })).toMatchObject({ status: 200 });

    expect(upsertSource).not.toHaveBeenCalled();
    expect(appendSafeObservation).not.toHaveBeenCalled();
    const ignored = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_event_ignored");
    expect(ignored).toMatchObject({
      details: {
        hookEvent: "pre_tool_use",
        hasSessionId: true,
        hasWorkspacePath: true
      }
    });
    const serialized = JSON.stringify(ignored);
    for (const canary of [session, command, workspacePath, "PRIVATE_PRE_TOOL_USE_ID_CANARY"]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("records a count-only Claude background-root gap at prompt-input exit without lifecycle side effects", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_CC07Y_INGRESS_SESSION_CANARY";
    const promptId = "PRIVATE_CC07Y_INGRESS_PROMPT_ID_CANARY";
    const promptContent = "PRIVATE_CC07Y_INGRESS_PROMPT_CONTENT_CANARY";
    const assistantContent = "PRIVATE_CC07Y_INGRESS_ASSISTANT_CONTENT_CANARY";
    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId,
      timestamp: "2026-07-13T13:19:45.684Z",
      originKind: "human",
      promptSource: "typed",
      content: promptContent
    }))}\n`);

    let observedAt = "2026-07-13T13:19:45.684Z";
    const diagnostics = vi.fn();
    const upsertSource = vi.fn(async () => undefined);
    const appendSafeObservation = vi.fn(async () => true);
    const onAccepted = vi.fn(async () => undefined);
    const resolveWorkspaceEvidence = vi.fn(async () => undefined);
    const storage = {
      upsertSource,
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      onAccepted,
      diagnostics,
      undefined,
      200,
      resolveWorkspaceEvidence,
      root
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      prompt_id: promptId,
      transcript_path: transcript,
      prompt: promptContent,
      tirion_claude_submission_prompt_digest: "0".repeat(64)
    })).toMatchObject({ status: 200 });
    observedAt = "2026-07-13T13:19:47.000Z";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: promptId,
      background_tasks: [{ task_id: "PRIVATE_CC07Y_BACKGROUND_TASK_CANARY" }],
      session_crons: []
    })).toMatchObject({ status: 200 });

    expect(upsertSource).toHaveBeenCalledTimes(1);
    expect(appendSafeObservation).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(resolveWorkspaceEvidence).not.toHaveBeenCalled();

    for (const [reason, at] of [
      ["clear", "2026-07-13T13:19:49.000Z"],
      ["resume", "2026-07-13T13:19:50.000Z"]
    ] as const) {
      observedAt = at;
      expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
        hook_event_name: "SessionEnd",
        session_id: session,
        reason,
        transcript_path: transcript,
        cwd: "/private/cc07y-session-end-workspace",
        last_assistant_message: assistantContent
      })).toMatchObject({ status: 200 });
    }
    expect(diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "claude_background_root_missing_terminal")).toBeUndefined();
    expect(upsertSource).toHaveBeenCalledTimes(1);
    expect(appendSafeObservation).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(resolveWorkspaceEvidence).not.toHaveBeenCalled();

    observedAt = "2026-07-13T13:19:52.000Z";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "SessionEnd",
      session_id: session,
      reason: "prompt_input_exit",
      transcript_path: transcript,
      cwd: "/private/cc07y-session-end-workspace",
      last_assistant_message: assistantContent
    })).toMatchObject({ status: 200 });

    expect(upsertSource).toHaveBeenCalledTimes(1);
    expect(appendSafeObservation).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(resolveWorkspaceEvidence).not.toHaveBeenCalled();
    const gap = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "claude_background_root_missing_terminal");
    expect(gap).toMatchObject({
      operation: "provider_hook",
      state: "warning",
      severity: "warning",
      details: {
        provider: "claude-code",
        sessionEndReason: "prompt_input_exit",
        unresolvedBackgroundRootCount: 1
      }
    });
    expect(gap?.details).toEqual({
      provider: "claude-code",
      sessionEndReason: "prompt_input_exit",
      unresolvedBackgroundRootCount: 1
    });
    expect(diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "provider_hook_event_ignored"
        && event.details?.hookEvent === "session_end")).toBeDefined();

    const serialized = JSON.stringify({
      observation: appendSafeObservation.mock.calls[0]?.[0],
      diagnostics: diagnostics.mock.calls
    });
    for (const canary of [
      session,
      promptId,
      promptContent,
      assistantContent,
      transcript,
      "/private/cc07y-session-end-workspace",
      "PRIVATE_CC07Y_BACKGROUND_TASK_CANARY"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("rejects a Claude managed-hook header/body event mismatch before persistence", async () => {
    const session = "PRIVATE_MANAGED_HOOK_MISMATCH_SESSION_CANARY";
    const transcriptPath = "/private/managed-hook-mismatch-transcript.jsonl";
    const workspacePath = "/private/managed-hook-mismatch-workspace";
    const diagnostics = vi.fn();
    const upsertSource = vi.fn(async () => undefined);
    const appendSafeObservation = vi.fn(async () => true);
    const onAccepted = vi.fn(async () => undefined);
    const resolveWorkspaceEvidence = vi.fn(async () => ({
      repositoryKey: "repo_must_not_bind",
      artifactKeys: []
    }));
    const storage = {
      upsertSource,
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-07-13T13:24:42.114Z"),
      onAccepted,
      diagnostics,
      undefined,
      200,
      resolveWorkspaceEvidence
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: "PRIVATE_MANAGED_HOOK_MISMATCH_PROMPT_CANARY",
      transcript_path: transcriptPath,
      cwd: workspacePath
    }, {
      "X-Tirion-Hook-Event": "SessionEnd"
    })).toEqual({ status: 400, body: { error: "invalid_request" } });

    expect(upsertSource).not.toHaveBeenCalled();
    expect(appendSafeObservation).not.toHaveBeenCalled();
    expect(resolveWorkspaceEvidence).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    const rejected = diagnostics.mock.calls.map(([event]) => event)
      .find((event) => event.reason === "managed_hook_event_mismatch");
    expect(rejected).toMatchObject({
      construct: "TelemetryIngress",
      operation: "provider_hook",
      state: "rejected",
      reason: "managed_hook_event_mismatch"
    });
    const serialized = JSON.stringify(rejected);
    for (const canary of [session, transcriptPath, workspacePath, "PRIVATE_MANAGED_HOOK_MISMATCH_PROMPT_CANARY"]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("drops session-scoped pending hooks when unresolved Claude submissions overlap", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_OVERLAP_SESSION_CANARY";
    let observedAt = "2026-07-12T22:46:34.185Z";
    await writeFile(transcript, "");
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      undefined,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    for (const prompt of ["PRIVATE_OVERLAP_PROMPT_ONE", "PRIVATE_OVERLAP_PROMPT_TWO"]) {
      expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        transcript_path: transcript,
        prompt
      })).toMatchObject({ status: 200 });
      observedAt = "2026-07-12T22:46:34.205Z";
    }
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "PostToolUse",
      session_id: session,
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore", prompt: "PRIVATE_OVERLAP_AGENT_PROMPT" },
      tool_response: { agentId: "PRIVATE_OVERLAP_AGENT_ID" }
    })).toMatchObject({ status: 200 });

    await writeFile(transcript, [
      claudeTranscriptRecord({
        sessionId: session,
        promptId: "PRIVATE_OVERLAP_PROMPT_ID_ONE",
        timestamp: "2026-07-12T22:46:34.165Z",
        originKind: "human",
        promptSource: "typed",
        content: "PRIVATE_OVERLAP_PROMPT_ONE"
      }),
      claudeTranscriptRecord({
        sessionId: session,
        promptId: "PRIVATE_OVERLAP_PROMPT_ID_TWO",
        timestamp: "2026-07-12T22:46:34.195Z",
        originKind: "human",
        promptSource: "typed",
        content: "PRIVATE_OVERLAP_PROMPT_TWO"
      })
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    for (let attempt = 0; attempt < 20 && appendSafeObservation.mock.calls.length < 2; attempt += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(2);
    expect(appendSafeObservation.mock.calls.every(([observation]) =>
      observation.queryOccurrences?.[0]?.evidence === "submission_hook"
    )).toBe(true);
    const serialized = JSON.stringify(appendSafeObservation.mock.calls);
    for (const canary of [
      session,
      "PRIVATE_OVERLAP_PROMPT_ONE",
      "PRIVATE_OVERLAP_PROMPT_TWO",
      "PRIVATE_OVERLAP_AGENT_PROMPT",
      "PRIVATE_OVERLAP_AGENT_ID"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("persists exact Claude tool decisions as safe rejected activity metadata", async () => {
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-07-14T04:00:02.000Z")
    );
    ingresses.push(ingress);
    await ingress.start();

    const session = "PRIVATE_CLAUDE_DECISION_INGRESS_SESSION";
    const prompt = "PRIVATE_CLAUDE_DECISION_INGRESS_PROMPT";
    const toolUseId = "PRIVATE_CLAUDE_DECISION_INGRESS_TOOL";
    expect(await callOtlp(
      ingress.address().port,
      "/v1/logs",
      claudePromptLogBody(session, prompt, "2026-07-14T04:00:00.000Z")
    )).toMatchObject({ status: 200 });
    expect(await callOtlp(
      ingress.address().port,
      "/v1/logs",
      claudeToolDecisionLogBody(session, prompt, toolUseId, "2026-07-14T04:00:01.000Z")
    )).toMatchObject({ status: 200 });

    expect(appendSafeObservation).toHaveBeenCalledTimes(2);
    const decisionObservation = appendSafeObservation.mock.calls[1]?.[0];
    expect(decisionObservation).toMatchObject({
      sourceId: "otlp_claude_code_logs",
      activityAtoms: [expect.objectContaining({
        kind: "tool",
        name: "Write",
        outcome: "rejected",
        evidenceBasis: "otel_event"
      })],
      executionNodes: [expect.objectContaining({
        nodeKind: "tool",
        name: "Write",
        outcome: "rejected"
      })]
    });
    expect(decisionObservation?.executionNodes?.[0]).not.toHaveProperty("artifactKeys");
    const serialized = JSON.stringify(decisionObservation);
    for (const canary of [
      session,
      prompt,
      toolUseId,
      "/PRIVATE_CLAUDE_DECISION_INGRESS_PATH",
      "PRIVATE_CLAUDE_DECISION_INGRESS_CONTENT",
      "user_reject"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("keeps a Claude denial separate from a same-tool failed result before durable append", async () => {
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-07-14T04:00:03.000Z")
    );
    ingresses.push(ingress);
    await ingress.start();

    const session = "PRIVATE_CLAUDE_COLLISION_INGRESS_SESSION";
    const prompt = "PRIVATE_CLAUDE_COLLISION_INGRESS_PROMPT";
    const toolUseId = "PRIVATE_CLAUDE_COLLISION_INGRESS_TOOL";
    expect(await callOtlp(
      ingress.address().port,
      "/v1/logs",
      claudePromptLogBody(session, prompt, "2026-07-14T04:00:00.000Z")
    )).toMatchObject({ status: 200 });
    expect(await callOtlp(
      ingress.address().port,
      "/v1/logs",
      claudeToolDecisionLogBody(session, prompt, toolUseId, "2026-07-14T04:00:01.000Z")
    )).toMatchObject({ status: 200 });
    expect(await callOtlp(
      ingress.address().port,
      "/v1/logs",
      claudeToolResultFailureLogBody(session, prompt, toolUseId, "2026-07-14T04:00:02.000Z")
    )).toMatchObject({ status: 200 });

    expect(appendSafeObservation).toHaveBeenCalledTimes(3);
    const observations = appendSafeObservation.mock.calls.map(([observation]) => observation);
    const decisionObservation = observations.find((observation) =>
      observation.activityAtoms?.[0]?.outcome === "rejected");
    const failureObservation = observations.find((observation) =>
      observation.activityAtoms?.[0]?.outcome === "failure");
    const decision = decisionObservation?.activityAtoms?.[0];
    const failure = failureObservation?.activityAtoms?.[0];
    expect(decision).toMatchObject({
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision"
    });
    expect(failure).toMatchObject({ outcome: "failure" });
    expect(decision?.activityId).not.toBe(failure?.activityId);
    expect(decision?.requestId).toBe(failure?.requestId);
    expect(decision).not.toHaveProperty("endedAt");
    expect(decision).not.toHaveProperty("durationMs");
    expect(decision).not.toHaveProperty("resultSizeBytes");
    expect(decision).not.toHaveProperty("providerReportedResultTokens");
    expect(decisionObservation?.executionNodes?.[0]).not.toHaveProperty("artifactKeys");
    expect(decisionObservation?.executionNodes?.[0]).not.toHaveProperty("artifactEvidence");

    const serialized = JSON.stringify(observations);
    for (const canary of [
      session,
      prompt,
      toolUseId,
      "user_reject",
      "/PRIVATE_CLAUDE_DECISION_INGRESS_PATH",
      "PRIVATE_CLAUDE_DECISION_INGRESS_CONTENT",
      "/PRIVATE_CLAUDE_COLLISION_RESULT_PATH",
      "PRIVATE_CLAUDE_COLLISION_RESULT_CONTENT"
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("holds Claude OTLP classification until pending hook provenance settles", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_PENDING_OTLP_SESSION_CANARY";
    const promptId = "PRIVATE_PENDING_OTLP_PROMPT_ID_CANARY";
    const prompt = "PRIVATE_PENDING_OTLP_CONTENT_CANARY";
    const observedAt = "2026-07-12T22:46:34.185Z";
    await writeFile(transcript, "");
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      undefined,
      undefined,
      200,
      undefined,
      root,
      [20, 20]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt
    })).toMatchObject({ status: 200 });
    const otlpResponse = callOtlp(
      ingress.address().port,
      "/v1/logs",
      claudePromptLogBody(session, promptId, "2026-07-12T22:46:34.165Z")
    );
    expect(await Promise.race([otlpResponse, wait(5).then(() => "pending")])).toBe("pending");

    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId,
      timestamp: "2026-07-12T22:46:34.165Z",
      originKind: "human",
      promptSource: "typed",
      content: prompt
    }))}\n`);
    expect(await otlpResponse).toMatchObject({ status: 200 });
    for (let attempt = 0; attempt < 20 && appendSafeObservation.mock.calls.length < 2; attempt += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(2);
    const [hookObservation, otlpObservation] = appendSafeObservation.mock.calls.map(([observation]) => observation);
    expect(hookObservation.queryOccurrences?.[0]?.evidence).toBe("submission_hook");
    expect(otlpObservation.queryOccurrences?.[0]?.queryId)
      .toBe(hookObservation.queryOccurrences?.[0]?.queryId);
    expect(JSON.stringify({ hookObservation, otlpObservation })).not.toContain(prompt);
    expect(JSON.stringify({ hookObservation, otlpObservation })).not.toContain(session);
  });

  it("holds task-notification OTLP until deferred provenance aliases the authorized root", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_PENDING_TASK_OTLP_SESSION_CANARY";
    const rootPromptId = "PRIVATE_PENDING_TASK_ROOT_PROMPT_ID_CANARY";
    const taskPromptId = "PRIVATE_PENDING_TASK_PROMPT_ID_CANARY";
    const rootPrompt = "PRIVATE_PENDING_TASK_ROOT_CONTENT_CANARY";
    const taskPrompt = "PRIVATE_PENDING_TASK_CONTENT_CANARY";
    const rootRecord = claudeTranscriptRecord({
      sessionId: session,
      promptId: rootPromptId,
      timestamp: "2026-07-12T22:46:34.165Z",
      originKind: "human",
      promptSource: "typed",
      content: rootPrompt
    });
    await writeFile(transcript, `${JSON.stringify(rootRecord)}\n`);
    let observedAt = "2026-07-12T22:46:34.185Z";
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      undefined,
      undefined,
      200,
      undefined,
      root,
      [20, 20]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: rootPrompt
    })).toMatchObject({ status: 200 });
    const authorizedRoot = appendSafeObservation.mock.calls[0]?.[0];
    expect(authorizedRoot.queryOccurrences?.[0]).toMatchObject({ evidence: "submission_hook" });

    observedAt = "2026-07-12T22:46:40.953Z";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: rootPromptId,
      background_tasks: [{ task_id: "PRIVATE_PENDING_TASK_BACKGROUND_ID_CANARY" }]
    })).toMatchObject({ status: 200 });

    observedAt = "2026-07-12T22:46:40.980Z";
    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: taskPrompt
    })).toMatchObject({ status: 200 });
    const otlpResponse = callOtlp(
      ingress.address().port,
      "/v1/logs",
      claudePromptLogBody(session, taskPromptId, "2026-07-12T22:46:40.977Z")
    );
    expect(await Promise.race([otlpResponse, wait(5).then(() => "pending")])).toBe("pending");

    await appendFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId: taskPromptId,
      timestamp: "2026-07-12T22:46:40.977Z",
      originKind: "task-notification",
      promptSource: "system",
      content: taskPrompt
    }))}\n`);
    expect(await otlpResponse).toMatchObject({ status: 200 });
    for (let attempt = 0; attempt < 20 && appendSafeObservation.mock.calls.length < 2; attempt += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(2);
    const taskOtlp = appendSafeObservation.mock.calls[1]?.[0];
    expect(taskOtlp.queryOccurrences?.[0]).toMatchObject({
      queryId: authorizedRoot.queryOccurrences?.[0]?.queryId,
      evidence: "provider_prompt_id"
    });
    const serialized = JSON.stringify({ authorizedRoot, taskOtlp });
    for (const canary of [session, rootPromptId, taskPromptId, rootPrompt, taskPrompt]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("settles a close-first Claude trace until a later task hook can suppress the intermediate terminal", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_CLOSE_FIRST_SESSION_CANARY";
    const rootPromptId = "PRIVATE_CLOSE_FIRST_ROOT_PROMPT_ID_CANARY";
    const firstTaskPromptId = "PRIVATE_CLOSE_FIRST_TASK_ONE_ID_CANARY";
    const secondTaskPromptId = "PRIVATE_CLOSE_FIRST_TASK_TWO_ID_CANARY";
    const rootPrompt = "PRIVATE_CLOSE_FIRST_ROOT_CONTENT_CANARY";
    const firstTaskPrompt = "PRIVATE_CLOSE_FIRST_TASK_ONE_CONTENT_CANARY";
    const secondTaskPrompt = "PRIVATE_CLOSE_FIRST_TASK_TWO_CONTENT_CANARY";
    const startedAt = "2026-07-12T22:46:34.165Z";
    const rootRecord = claudeTranscriptRecord({
      sessionId: session,
      promptId: rootPromptId,
      timestamp: startedAt,
      originKind: "human",
      promptSource: "typed",
      content: rootPrompt
    });
    await writeFile(transcript, `${JSON.stringify(rootRecord)}\n`);
    let observedAt = "2026-07-12T22:46:34.185Z";
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      undefined,
      undefined,
      200,
      undefined,
      root,
      [10, 20, 40]
    );
    ingresses.push(ingress);
    await ingress.start();

    await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: rootPrompt
    });
    const authorizedQueryId = appendSafeObservation.mock.calls[0]?.[0].queryOccurrences?.[0]?.queryId;
    expect(authorizedQueryId).toMatch(/^qry_/);

    observedAt = "2026-07-12T22:46:40.953Z";
    await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: rootPromptId,
      background_tasks: [{ task_id: "PRIVATE_CLOSE_FIRST_BACKGROUND_ID_CANARY" }]
    });
    const firstTaskRecord = claudeTranscriptRecord({
      sessionId: session,
      promptId: firstTaskPromptId,
      timestamp: "2026-07-12T22:46:40.977Z",
      originKind: "task-notification",
      promptSource: "system",
      content: firstTaskPrompt
    });
    await appendFile(transcript, `${JSON.stringify(firstTaskRecord)}\n`);
    observedAt = "2026-07-12T22:46:40.980Z";
    await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: firstTaskPrompt
    });
    await callOtlp(
      ingress.address().port,
      "/v1/logs",
      claudePromptLogBody(session, firstTaskPromptId, "2026-07-12T22:46:40.980Z", "trace-close-first-one")
    );

    observedAt = "2026-07-12T22:46:43.453Z";
    await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: firstTaskPromptId,
      background_tasks: [],
      session_crons: []
    });
    observedAt = "2026-07-12T22:46:43.473Z";
    const intermediateClose = callOtlp(
      ingress.address().port,
      "/v1/traces",
      claudeClosedInteractionTraceBody(
        "trace-close-first-one",
        startedAt,
        "2026-07-12T22:46:43.473Z"
      )
    );
    await wait(2);

    observedAt = "2026-07-12T22:46:43.475Z";
    await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt: secondTaskPrompt
    });
    await appendFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId: secondTaskPromptId,
      timestamp: "2026-07-12T22:46:43.475Z",
      originKind: "task-notification",
      promptSource: "system",
      content: secondTaskPrompt
    }))}\n`);
    expect(await intermediateClose).toMatchObject({ status: 200 });

    const completedBeforeFinal = appendSafeObservation.mock.calls
      .flatMap(([observation]) => observation.queryOccurrences ?? [])
      .filter((occurrence) => occurrence.completedAt);
    expect(completedBeforeFinal).toEqual([]);

    observedAt = "2026-07-12T22:46:43.480Z";
    await callOtlp(
      ingress.address().port,
      "/v1/logs",
      claudePromptLogBody(session, secondTaskPromptId, "2026-07-12T22:46:43.475Z", "trace-close-first-two")
    );
    observedAt = "2026-07-12T22:46:46.829Z";
    await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "Stop",
      session_id: session,
      prompt_id: secondTaskPromptId,
      background_tasks: [],
      session_crons: []
    });
    observedAt = "2026-07-12T22:46:46.900Z";
    await callOtlp(
      ingress.address().port,
      "/v1/traces",
      claudeClosedInteractionTraceBody(
        "trace-close-first-two",
        startedAt,
        "2026-07-12T22:46:46.840Z"
      )
    );

    const completed = appendSafeObservation.mock.calls
      .flatMap(([observation]) => observation.queryOccurrences ?? [])
      .filter((occurrence) => occurrence.completedAt);
    expect(completed).toEqual([expect.objectContaining({
      queryId: authorizedQueryId,
      completedAt: "2026-07-12T22:46:46.840Z"
    })]);
    const serialized = JSON.stringify(appendSafeObservation.mock.calls);
    for (const canary of [session, rootPromptId, firstTaskPromptId, secondTaskPromptId, rootPrompt, firstTaskPrompt, secondTaskPrompt]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("cancels deferred Claude transcript retries when ingress stops", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const observedAt = "2026-07-12T22:46:34.185Z";
    await writeFile(transcript, "");
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      undefined,
      undefined,
      200,
      undefined,
      root,
      [20]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: "PRIVATE_STOPPED_RETRY_SESSION_CANARY",
      transcript_path: transcript,
      prompt: "PRIVATE_STOPPED_RETRY_PROMPT_CANARY"
    })).toMatchObject({ status: 200 });
    await ingress.stop();
    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: "PRIVATE_STOPPED_RETRY_SESSION_CANARY",
      promptId: "PRIVATE_STOPPED_RETRY_PROMPT_ID_CANARY",
      timestamp: "2026-07-12T22:46:34.165Z",
      originKind: "human",
      promptSource: "typed"
    }))}\n`);
    await wait(40);

    expect(appendSafeObservation).not.toHaveBeenCalled();
  });

  it("fails closed after the bounded Claude transcript retry grace", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    await writeFile(transcript, "");
    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-07-12T22:46:34.185Z"),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [5]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: "PRIVATE_EXHAUSTED_RETRY_SESSION_CANARY",
      transcript_path: transcript,
      prompt: "PRIVATE_EXHAUSTED_RETRY_PROMPT_CANARY"
    })).toMatchObject({ status: 200 });
    await expect(ingress.drainAcceptedWork(100)).resolves.toBe(true);

    expect(appendSafeObservation).not.toHaveBeenCalled();
    expect(diagnostics.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      reason: "provider_hook_event_ignored",
      state: "ignored",
      details: expect.objectContaining({
        claudeSubmissionProvenance: "unavailable",
        claudeSubmissionProvenanceReason: "transcript_candidate_missing"
      })
    }));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("PRIVATE_EXHAUSTED_RETRY_PROMPT_CANARY");
  });

  it("emits a fixed origin-shape category without retaining an unrecognized transcript origin", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_ORIGIN_SHAPE_SESSION_CANARY";
    const prompt = "PRIVATE_ORIGIN_SHAPE_PROMPT_CANARY";
    const observedAt = "2026-07-12T22:46:35.185Z";
    const record = claudeTranscriptRecord({
      sessionId: session,
      promptId: "PRIVATE_ORIGIN_SHAPE_PROMPT_ID_CANARY",
      timestamp: observedAt,
      originKind: "human",
      promptSource: "typed",
      content: prompt
    });
    const privateOriginKind = "PRIVATE_ORIGIN_KIND_SHAPE_CANARY";
    record.origin = { kind: privateOriginKind };
    await writeFile(transcript, `${JSON.stringify(record)}\n`);
    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [5]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt
    })).toMatchObject({ status: 200 });
    await expect(ingress.drainAcceptedWork(100)).resolves.toBe(true);

    expect(appendSafeObservation).not.toHaveBeenCalled();
    expect(diagnostics.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      reason: "provider_hook_event_ignored",
      state: "ignored",
      details: expect.objectContaining({
        claudeSubmissionProvenance: "unavailable",
        claudeSubmissionProvenanceReason: "transcript_origin_kind_unrecognized"
      })
    }));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(prompt);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(session);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(privateOriginKind);
  });

  it("retries a privacy-sanitized Claude hook after a transient durable append failure", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const session = "PRIVATE_RETRY_APPEND_SESSION_CANARY";
    const prompt = "PRIVATE_RETRY_APPEND_PROMPT_CANARY";
    const observedAt = "2026-07-12T22:46:34.185Z";
    await writeFile(transcript, "");
    const diagnostics = vi.fn();
    const appendSafeObservation = vi.fn()
      .mockRejectedValueOnce(new Error("PRIVATE_APPEND_ERROR_CANARY"))
      .mockResolvedValue(true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date(observedAt),
      undefined,
      diagnostics,
      undefined,
      200,
      undefined,
      root,
      [5, 5, 5]
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      transcript_path: transcript,
      prompt
    })).toMatchObject({ status: 200 });
    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: session,
      promptId: "PRIVATE_RETRY_APPEND_PROMPT_ID_CANARY",
      timestamp: "2026-07-12T22:46:34.165Z",
      originKind: "human",
      promptSource: "typed",
      content: prompt
    }))}\n`);
    for (let attempt = 0; attempt < 20 && !diagnostics.mock.calls.some(([event]) =>
      event.reason === "provider_hook_observation_accepted"); attempt += 1) {
      await wait(10);
    }

    expect(appendSafeObservation).toHaveBeenCalledTimes(2);
    expect(diagnostics.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      reason: "provider_hook_observation_accepted",
      details: expect.objectContaining({ claudeSubmissionProvenance: "human_typed" })
    }));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("PRIVATE_APPEND_ERROR_CANARY");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(prompt);
  });

  it("reads only a bounded complete-line tail from a trusted Claude transcript", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    const validRecord = claudeTranscriptRecord({
      sessionId: "bounded-session",
      promptId: "bounded-prompt",
      timestamp: "2026-07-12T22:00:00.000Z",
      originKind: "human",
      promptSource: "typed"
    });
    const prefixCanary = "PRIVATE_PREFIX_OUTSIDE_BOUNDED_TAIL_CANARY";
    const oversizedPrefix = prefixCanary.repeat(
      Math.ceil((CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES + 4_096) / prefixCanary.length)
    );
    await writeFile(transcript, `${oversizedPrefix}\n${JSON.stringify(validRecord)}\n`);

    const result = await readClaudeTranscriptTail({ transcript_path: transcript }, root);

    expect(result).toMatchObject({ state: "available", truncated: true });
    if (result.state !== "available") {
      throw new Error("expected_available_tail");
    }
    expect(Buffer.byteLength(result.tail)).toBeLessThanOrEqual(CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES);
    expect(result.tail).toContain("bounded-prompt");
    expect(result.tail).not.toContain(prefixCanary);
    expect(result.tail.startsWith("{")).toBe(true);
  });

  it("rejects Claude transcript path escapes and symlinks", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: "path-session",
      promptId: "path-prompt",
      timestamp: "2026-07-12T22:10:00.000Z",
      originKind: "human",
      promptSource: "typed"
    }))}\n`);
    const outside = await mkdtemp(join(tmpdir(), "tirion-claude-outside-"));
    tempDirectories.push(outside);
    const outsideTranscript = join(outside, "outside.jsonl");
    await writeFile(outsideTranscript, "PRIVATE_OUTSIDE_TRANSCRIPT_CANARY\n");
    const finalSymlink = join(dirname(transcript), "final-symlink.jsonl");
    await symlink(transcript, finalSymlink);
    const escapedDirectory = join(root, "escaped-directory");
    await symlink(outside, escapedDirectory);

    expect(await readClaudeTranscriptTail({ transcript_path: "relative.jsonl" }, root))
      .toEqual({ state: "unavailable", diagnosticReason: "transcript_locator_invalid" });
    expect(await readClaudeTranscriptTail({ transcript_path: join(root, "missing.jsonl") }, root))
      .toEqual({ state: "unavailable", diagnosticReason: "transcript_read_unavailable" });
    expect(await readClaudeTranscriptTail({ transcript_path: outsideTranscript }, root))
      .toEqual({ state: "unavailable", diagnosticReason: "transcript_trust_rejected" });
    expect(await readClaudeTranscriptTail({ transcript_path: finalSymlink }, root))
      .toEqual({ state: "unavailable", diagnosticReason: "transcript_trust_rejected" });
    expect(await readClaudeTranscriptTail({
      transcript_path: join(escapedDirectory, "outside.jsonl")
    }, root)).toEqual({ state: "unavailable", diagnosticReason: "transcript_trust_rejected" });
  });

  it("fails closed if a Claude transcript changes during the bounded read", async () => {
    const { root, transcript } = await createClaudeTranscriptFixture();
    await writeFile(transcript, `${JSON.stringify(claudeTranscriptRecord({
      sessionId: "race-session",
      promptId: "race-prompt",
      timestamp: "2026-07-12T22:20:00.000Z",
      originKind: "human",
      promptSource: "typed"
    }))}\n`);

    const result = await readClaudeTranscriptTail(
      { transcript_path: transcript },
      root,
      { afterOpen: async () => await appendFile(transcript, "PRIVATE_RACE_CANARY\n") }
    );

    expect(result).toEqual({ state: "unavailable", diagnosticReason: "transcript_read_unstable" });
  });

  it("projects exact Copilot OTLP write targets into opaque causal artifact evidence", async () => {
    const appendSafeObservation = vi.fn(async () => true);
    const storage = {
      upsertSource: vi.fn(async () => undefined),
      appendSafeObservation
    } as unknown as AgentStorageClient;
    const resolveWorkspaceEvidence = vi.fn(async (_workspacePath: string, artifactPaths: string[]) => ({
      repositoryKey: "repo_copilot",
      artifactKeys: artifactPaths.map(() => "artifact_copilot_write")
    }));
    const ingress = new OtlpIngress(
      storage,
      "env_test",
      0,
      () => new Date("2026-06-30T08:00:00.000Z"),
      undefined,
      undefined,
      undefined,
      200,
      resolveWorkspaceEvidence
    );
    ingresses.push(ingress);
    await ingress.start();

    expect(await callOtlp(ingress.address().port, "/v1/traces", copilotWriteTraceBody()))
      .toMatchObject({ status: 200 });
    expect(resolveWorkspaceEvidence).toHaveBeenCalledWith(
      "/Users/example/private/copilot-project",
      ["src/copilot-write.ts"]
    );
    const observation = appendSafeObservation.mock.calls[0]?.[0];
    expect(observation).toMatchObject({
      repositoryKey: "repo_copilot",
      provider: "github-copilot",
      executionNodes: expect.arrayContaining([expect.objectContaining({
        nodeKind: "tool",
        name: "writeFile",
        artifactKeys: ["artifact_copilot_write"],
        artifactEvidence: "provider_tool_event"
      })])
    });
    expect(JSON.stringify(observation)).not.toContain("copilot-project");
    expect(JSON.stringify(observation)).not.toContain("copilot-write.ts");
  });
});

function callOtlp(
  port: number,
  path: string,
  body: unknown,
  additionalHeaders: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": encoded.length,
        ...additionalHeaders
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
      }));
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function createClaudeTranscriptFixture(): Promise<{
  root: string;
  transcript: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "tirion-claude-transcripts-"));
  tempDirectories.push(root);
  const transcript = join(root, "project", "session.jsonl");
  await mkdir(dirname(transcript), { recursive: true });
  return { root, transcript };
}

function claudeTranscriptRecord(input: {
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

function claudePromptLogBody(sessionId: string, promptId: string, at: string, traceId?: string): Record<string, unknown> {
  return {
    resourceLogs: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }]
      },
      scopeLogs: [{
        logRecords: [{
          ...(traceId ? { traceId, spanId: `${traceId}-prompt` } : {}),
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: at } },
            { key: "session.id", value: { stringValue: sessionId } },
            { key: "prompt.id", value: { stringValue: promptId } }
          ]
        }]
      }]
    }]
  };
}

function claudeToolDecisionLogBody(
  sessionId: string,
  promptId: string,
  toolUseId: string,
  at: string
): Record<string, unknown> {
  return {
    resourceLogs: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }]
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_decision" } },
            { key: "event.timestamp", value: { stringValue: at } },
            { key: "session.id", value: { stringValue: sessionId } },
            { key: "prompt.id", value: { stringValue: promptId } },
            { key: "tool_name", value: { stringValue: "Write" } },
            { key: "tool_use_id", value: { stringValue: toolUseId } },
            { key: "decision", value: { stringValue: "reject" } },
            { key: "source", value: { stringValue: "user_reject" } },
            { key: "tool_parameters", value: { stringValue: "{\"file_path\":\"/PRIVATE_CLAUDE_DECISION_INGRESS_PATH\",\"content\":\"PRIVATE_CLAUDE_DECISION_INGRESS_CONTENT\"}" } }
          ]
        }]
      }]
    }]
  };
}

function claudeToolResultFailureLogBody(
  sessionId: string,
  promptId: string,
  toolUseId: string,
  at: string
): Record<string, unknown> {
  return {
    resourceLogs: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }]
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.tool_result" } },
            { key: "event.timestamp", value: { stringValue: at } },
            { key: "session.id", value: { stringValue: sessionId } },
            { key: "prompt.id", value: { stringValue: promptId } },
            { key: "tool_name", value: { stringValue: "Write" } },
            { key: "tool_use_id", value: { stringValue: toolUseId } },
            { key: "success", value: { boolValue: false } },
            { key: "duration_ms", value: { intValue: "1000" } },
            { key: "result_size_bytes", value: { intValue: "256" } },
            { key: "result_tokens", value: { intValue: "12" } },
            { key: "tool_parameters", value: { stringValue: "{\"file_path\":\"/PRIVATE_CLAUDE_COLLISION_RESULT_PATH\",\"content\":\"PRIVATE_CLAUDE_COLLISION_RESULT_CONTENT\"}" } }
          ]
        }]
      }]
    }]
  };
}

function claudeClosedInteractionTraceBody(
  traceId: string,
  startedAt: string,
  completedAt: string
): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }]
      },
      scopeSpans: [{
        spans: [{
          traceId,
          spanId: `${traceId}-root`,
          name: "claude_code.interaction",
          startTimeUnixNano: `${Date.parse(startedAt)}000000`,
          endTimeUnixNano: `${Date.parse(completedAt)}000000`,
          status: { code: 1 },
          attributes: [{ key: "span.type", value: { stringValue: "interaction" } }]
        }]
      }]
    }]
  };
}

function codexTraceBody(): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "codex" } }]
      },
      scopeSpans: [{
        spans: [{
          traceId: "1234567890abcdef1234567890abcdef",
          spanId: "1234567890abcdef",
          name: "codex turn",
          startTimeUnixNano: "1782806400000000000",
          endTimeUnixNano: "1782806401000000000",
          attributes: [
            { key: "gen_ai.system", value: { stringValue: "openai" } },
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4-mini" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } }
          ]
        }]
      }]
    }]
  };
}

function copilotWriteTraceBody(): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "github-copilot" } },
          { key: "process.cwd", value: { stringValue: "/Users/example/private/copilot-project" } }
        ]
      },
      scopeSpans: [{
        spans: [{
          traceId: "copilot-write-trace",
          spanId: "copilot-root",
          name: "invoke_agent",
          startTimeUnixNano: "1782806400000000000",
          attributes: [
            { key: "gen_ai.turn.id", value: { stringValue: "copilot-turn" } },
            { key: "copilot_chat.session_id", value: { stringValue: "copilot-session" } }
          ]
        }, {
          traceId: "copilot-write-trace",
          spanId: "copilot-tool",
          parentSpanId: "copilot-root",
          name: "execute_tool writeFile",
          startTimeUnixNano: "1782806400100000000",
          endTimeUnixNano: "1782806400200000000",
          attributes: [
            { key: "gen_ai.turn.id", value: { stringValue: "copilot-turn" } },
            { key: "copilot_chat.session_id", value: { stringValue: "copilot-session" } },
            { key: "gen_ai.tool.name", value: { stringValue: "writeFile" } },
            { key: "arguments", value: { stringValue: "{\"path\":\"src/copilot-write.ts\"}" } },
            { key: "success", value: { boolValue: true } }
          ]
        }]
      }]
    }]
  };
}
