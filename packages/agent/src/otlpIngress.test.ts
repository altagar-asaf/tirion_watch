import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStorageClient } from "@tirion/agent-storage";
import { OtlpIngress } from "./otlpIngress";

const ingresses: OtlpIngress[] = [];

afterEach(async () => {
  await Promise.all(ingresses.splice(0).map((ingress) => ingress.stop()));
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

function callOtlp(port: number, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": encoded.length
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
