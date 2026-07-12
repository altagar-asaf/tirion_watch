import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStorageClient } from "@tirion/agent-storage";
import type { SafeObservationV1 } from "@tirion/agent-contract";
import type { DiagnosticEvent } from "@tirion/engine/production";
import { CopilotSpanDbIngress } from "./copilotSpanDbIngress";

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
};

type DatabaseSyncConstructor = new (location: string, options?: Record<string, unknown>) => SqliteDatabase;

const roots: string[] = [];
const storages: AgentStorageClient[] = [];
const ingresses: CopilotSpanDbIngress[] = [];

afterEach(async () => {
  await Promise.all(ingresses.splice(0).map((ingress) => ingress.stop()));
  await Promise.all(storages.splice(0).map((storage) => storage.close()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CopilotSpanDbIngress", () => {
  it("replays Copilot span DB rows as github-copilot usage observations", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-copilot-span-db-"));
    roots.push(root);
    const dbPath = join(root, "agent-traces.db");
    createSpanDb(dbPath);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.sqlite3") });
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });

    let acceptedCount = 0;
    const ingress = new CopilotSpanDbIngress(
      storage,
      "env_test",
      () => new Date("2026-06-08T00:00:03.000Z"),
      async () => {
        acceptedCount += 1;
      }
    );
    ingresses.push(ingress);
    await ingress.configure({
      schemaVersion: 1,
      enabled: true,
      spanDbPath: dbPath,
      captureContent: false,
      dbSpanExporter: true
    });

    await sleep(1_100);
    appendCopilotRunSpan(dbPath);

    await waitUntil(async () => (await storage.listSafeUsageAtoms()).length === 1);

    const atoms = await storage.listSafeUsageAtoms();
    expect(atoms[0]).toMatchObject({
      provider: "github-copilot",
      runtime: "github-copilot",
      signal: "traces",
      sourceId: "otlp_github_copilot_traces",
      profileVersion: "copilot-otlp-traces-v1",
      authority: "run",
      billingContext: "github-copilot",
      model: "gpt-5.4",
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadInputTokens: 100,
      reasoningOutputTokens: 0,
      startedAt: "2026-05-30T00:00:01.000Z",
      endedAt: "2026-05-30T00:00:02.000Z"
    });
    expect(atoms[0]?.queryId).toMatch(/^qry_/);
    expect(atoms[0]?.sessionId).toMatch(/^ses_/);
    expect(atoms[0]?.requestId).toMatch(/^req_/);

    await waitUntil(async () =>
      (await storage.listSources()).some((source) =>
        source.sourceId === "span_db_github_copilot_traces"
        && source.provider === "github-copilot"
        && source.runtime === "github-copilot"
        && source.sourceKind === "sqlite-span-db"
        && source.environmentId === "env_test"
      )
    );
    expect(acceptedCount).toBeGreaterThanOrEqual(1);
  });

  it("passes accepted span DB observations to live processing for lifecycle webhooks", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-copilot-span-db-live-"));
    roots.push(root);
    const dbPath = join(root, "agent-traces.db");
    createSpanDb(dbPath);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.sqlite3") });
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });

    const accepted: SafeObservationV1[] = [];
    const ingress = new CopilotSpanDbIngress(
      storage,
      "env_test",
      () => new Date("2026-06-08T00:00:03.000Z"),
      async (observation) => {
        accepted.push(observation);
      }
    );
    ingresses.push(ingress);
    await ingress.configure({
      schemaVersion: 1,
      enabled: true,
      spanDbPath: dbPath,
      captureContent: false,
      dbSpanExporter: true
    });

    await sleep(1_100);
    appendCopilotInFlightRootSpan(dbPath);

    await waitUntil(async () => accepted.some((observation) =>
      observation.sourceId === "span_db_github_copilot_traces"
      && observation.provider === "github-copilot"
      && observation.runtime === "github-copilot"
      && (observation.queryOccurrences ?? []).some((occurrence) =>
        occurrence.evidence === "provider_root_span"
        && occurrence.startedAt === "2026-05-30T00:00:01.000Z"
      )
    ));
  });

  it("preserves successful Copilot tool status and attaches only opaque causal artifact evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-copilot-span-db-write-"));
    roots.push(root);
    const dbPath = join(root, "agent-traces.db");
    createSpanDb(dbPath);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.sqlite3") });
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });

    const accepted: SafeObservationV1[] = [];
    const resolverCalls: Array<{ workspacePath: string; artifactPaths: string[] }> = [];
    const ingress = new CopilotSpanDbIngress(
      storage,
      "env_test",
      () => new Date("2026-06-08T00:00:03.000Z"),
      async (observation) => {
        accepted.push(observation);
      },
      undefined,
      async (workspacePath, artifactPaths) => {
        resolverCalls.push({ workspacePath, artifactPaths });
        return {
          repositoryKey: "repo_opaque",
          artifactKeys: ["artifact_a", "artifact_b", "artifact_c"]
        };
      }
    );
    ingresses.push(ingress);
    await ingress.configure({
      schemaVersion: 1,
      enabled: true,
      spanDbPath: dbPath,
      captureContent: false,
      dbSpanExporter: true
    });

    await sleep(1_100);
    appendCopilotWriteToolSpan(dbPath);

    await waitUntil(async () => accepted.length > 0);
    expect(resolverCalls).toEqual([{
      workspacePath: "/workspace/copilot-repo",
      artifactPaths: ["src/answer.ts", "docs/copilot-notes.md", "config/settings.json"]
    }]);
    const writeObservation = accepted.find((observation) => observation.repositoryKey === "repo_opaque");
    expect(writeObservation).toMatchObject({
      repositoryKey: "repo_opaque",
      executionNodes: [expect.objectContaining({
        nodeKind: "tool",
        outcome: "success",
        repositoryKey: "repo_opaque",
        artifactKeys: ["artifact_a", "artifact_b", "artifact_c"],
        artifactEvidence: "provider_tool_event"
      })]
    });
    expect(JSON.stringify(writeObservation)).not.toContain("/workspace/copilot-repo");
    expect(JSON.stringify(writeObservation)).not.toContain("src/answer.ts");
  });

  it("reports missing span DBs without leaking absolute paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-copilot-span-db-missing-"));
    roots.push(root);
    const dbPath = join(root, "agent-traces.db");
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.sqlite3") });
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const diagnostics: DiagnosticEvent[] = [];
    const ingress = new CopilotSpanDbIngress(
      storage,
      "env_test",
      () => new Date("2026-06-08T00:00:03.000Z"),
      undefined,
      (event) => diagnostics.push(event)
    );
    ingresses.push(ingress);

    await ingress.configure({
      schemaVersion: 1,
      enabled: true,
      spanDbPath: dbPath,
      captureContent: false,
      dbSpanExporter: true
    });

    await waitUntil(async () => diagnostics.length > 0);
    expect(diagnostics).toEqual([expect.objectContaining({
      kind: "constructLifecycle",
      construct: "TelemetryIngress",
      operation: "provider_replay",
      state: "waiting",
      reason: "copilot_span_db_not_found"
    })]);
    expect(JSON.stringify(diagnostics)).not.toContain(dbPath);
    expect(JSON.stringify(diagnostics)).not.toContain(root);
  });
});

function createSpanDb(dbPath: string): void {
  const db = newDatabase(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE spans (
      span_id TEXT PRIMARY KEY,
      trace_id TEXT,
      parent_span_id TEXT,
      name TEXT,
      start_time_ms INTEGER,
      end_time_ms INTEGER,
      operation_name TEXT,
      provider_name TEXT,
      agent_name TEXT,
      conversation_id TEXT,
      request_model TEXT,
      response_model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      reasoning_tokens INTEGER,
      tool_name TEXT,
      tool_call_id TEXT,
      tool_type TEXT,
      chat_session_id TEXT,
      turn_index INTEGER,
      ttft_ms INTEGER,
      status_code TEXT,
      status_message TEXT
    );
    CREATE TABLE span_attributes (
      span_id TEXT,
      key TEXT,
      value TEXT
    );
    CREATE TABLE span_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      span_id TEXT,
      name TEXT,
      timestamp_ms INTEGER,
      attributes TEXT
    );
  `);
  db.close();
}

function appendCopilotRunSpan(dbPath: string): void {
  const db = newDatabase(dbPath);
  db.prepare(`
    INSERT INTO spans (
      span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms,
      operation_name, provider_name, agent_name, conversation_id,
      request_model, response_model, input_tokens, output_tokens, cached_tokens,
      reasoning_tokens, tool_name, tool_call_id, tool_type, chat_session_id,
      turn_index, ttft_ms, status_code, status_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "span_root",
    "trace_copilot_1",
    null,
    "invoke_agent GitHub Copilot Chat",
    1_780_099_201_000,
    1_780_099_202_000,
    "invoke_agent",
    "github-copilot",
    "GitHub Copilot Chat",
    "conversation-1",
    "gpt-5.4",
    "gpt-5.4",
    1200,
    80,
    100,
    0,
    null,
    null,
    null,
    "chat-session-1",
    1,
    25,
    "ok",
    null
  );
  db.close();
}

function appendCopilotInFlightRootSpan(dbPath: string): void {
  const db = newDatabase(dbPath);
  db.prepare(`
    INSERT INTO spans (
      span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms,
      operation_name, provider_name, agent_name, conversation_id,
      request_model, response_model, input_tokens, output_tokens, cached_tokens,
      reasoning_tokens, tool_name, tool_call_id, tool_type, chat_session_id,
      turn_index, ttft_ms, status_code, status_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "span_live_root",
    "trace_copilot_live",
    null,
    "invoke_agent GitHub Copilot Chat",
    1_780_099_201_000,
    null,
    "invoke_agent",
    "github-copilot",
    "GitHub Copilot Chat",
    "conversation-live",
    "gpt-5.4",
    "gpt-5.4",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "chat-session-live",
    1,
    25,
    null,
    null
  );
  db.close();
}

function appendCopilotWriteToolSpan(dbPath: string): void {
  const db = newDatabase(dbPath);
  db.prepare(`
    INSERT INTO spans (
      span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms,
      operation_name, provider_name, agent_name, conversation_id,
      request_model, response_model, input_tokens, output_tokens, cached_tokens,
      reasoning_tokens, tool_name, tool_call_id, tool_type, chat_session_id,
      turn_index, ttft_ms, status_code, status_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "span_write_tool",
    "trace_copilot_write",
    "span_write_root",
    "execute_tool apply_patch",
    1_780_099_201_100,
    1_780_099_201_240,
    "execute_tool",
    "github-copilot",
    "GitHub Copilot Chat",
    "conversation-write",
    null,
    null,
    null,
    null,
    null,
    null,
    "apply_patch",
    "tool-call-write",
    "tool",
    "chat-session-write",
    2,
    null,
    "ok",
    null
  );
  const insertAttribute = db.prepare("INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)");
  for (const [key, value] of [
    ["workspace.path", "/workspace/copilot-repo"],
    ["file.path", "src/answer.ts"],
    ["target.path", "docs/copilot-notes.md"],
    ["destination.path", "config/settings.json"]
  ]) {
    insertAttribute.run("span_write_tool", key, value);
  }
  db.close();
}

function newDatabase(path: string): SqliteDatabase {
  const sqlite = require("node:sqlite") as { DatabaseSync?: DatabaseSyncConstructor };
  if (!sqlite.DatabaseSync) {
    throw new Error("node:sqlite DatabaseSync is unavailable");
  }
  return new sqlite.DatabaseSync(path);
}

async function waitUntil(predicate: () => Promise<boolean>, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("timed_out");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
