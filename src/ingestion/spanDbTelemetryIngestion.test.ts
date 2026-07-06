import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SpanDbTelemetryIngestion } from "./spanDbTelemetryIngestion";

const tempDirs: string[] = [];

describe("SpanDbTelemetryIngestion", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reads Copilot OTel span DB rows", async () => {
    const dbPath = await createSpanDb();
    const ingestion = new SpanDbTelemetryIngestion(10);
    const records: unknown[] = [];
    ingestion.onRawRecord((record) => records.push(record));

    ingestion.start({ spanDbPath: dbPath });
    await waitFor(() => records.length > 0);
    ingestion.stop();

    expect(records[0]).toMatchObject({
      tirionSource: "copilot-span-db",
      span: {
        span_id: "root",
        trace_id: "trace-1",
        name: "invoke_agent"
      },
      attributes: [
        {
          key: "gen_ai.input.messages"
        }
      ],
      events: [
        {
          name: "copilot_chat.tool.call"
        }
      ]
    });
    expect(ingestion.getCheckpoint().spanDbSeenSpanCount).toBe(1);
  });

  it("re-emits a span when prompt attributes arrive after the initial span row", async () => {
    const dbPath = await createSpanDb({ withPromptAttribute: false });
    const ingestion = new SpanDbTelemetryIngestion(10);
    const records: Array<{ attributes?: Array<{ key: string; value: unknown }> }> = [];
    ingestion.onRawRecord((record) => records.push(record as { attributes?: Array<{ key: string; value: unknown }> }));

    ingestion.start({ spanDbPath: dbPath });
    await waitFor(() => records.length === 1);
    expect(records[0].attributes ?? []).not.toContainEqual(expect.objectContaining({ key: "gen_ai.input.messages" }));

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)")
        .run("root", "gen_ai.input.messages", JSON.stringify([{ role: "user", content: "late prompt" }]));
    } finally {
      db.close();
    }

    await waitFor(() => records.length >= 2);
    ingestion.stop();

    expect(records.at(-1)?.attributes ?? []).toContainEqual(expect.objectContaining({ key: "gen_ai.input.messages" }));
  });

  it("re-emits a span when a user_message event arrives after the initial span row", async () => {
    const dbPath = await createSpanDb();
    const ingestion = new SpanDbTelemetryIngestion(10);
    const records: Array<{ events?: Array<{ name?: string; attributes?: unknown }> }> = [];
    ingestion.onRawRecord((record) => records.push(record as { events?: Array<{ name?: string; attributes?: unknown }> }));

    ingestion.start({ spanDbPath: dbPath });
    await waitFor(() => records.length === 1);

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("INSERT INTO span_events (span_id, name, timestamp_ms, attributes) VALUES (?, ?, ?, ?)")
        .run("root", "user_message", 1_780_099_201_000, JSON.stringify({
          content: "late event prompt",
          "copilot_chat.chat_session_id": "session-1"
        }));
    } finally {
      db.close();
    }

    await waitFor(() => records.some((record) => (record.events ?? []).some((event) => event.name === "user_message")));
    ingestion.stop();

    const revisedRoot = records.findLast((record) => (record.events ?? []).some((event) => event.name === "user_message"));
    expect(revisedRoot?.events ?? []).toContainEqual(expect.objectContaining({
      name: "user_message",
      attributes: expect.stringContaining("late event prompt")
    }));
  });

  it("revisits older root spans after later child spans advance the start-time watermark", async () => {
    const dbPath = await createSpanDb({ withPromptAttribute: false, withChildSpan: true });
    const ingestion = new SpanDbTelemetryIngestion(10, 120_000);
    const records: Array<{ span?: { span_id?: string }; attributes?: Array<{ key: string; value: unknown }> }> = [];
    ingestion.onRawRecord((record) => records.push(record as { span?: { span_id?: string }; attributes?: Array<{ key: string; value: unknown }> }));

    ingestion.start({ spanDbPath: dbPath });
    await waitFor(() => records.some((record) => record.span?.span_id === "child"));

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)")
        .run("root", "gen_ai.input.messages", JSON.stringify([{ role: "user", content: "late root prompt" }]));
    } finally {
      db.close();
    }

    await waitFor(() => records.some((record) => record.span?.span_id === "root" && (record.attributes ?? []).some((attribute) => attribute.key === "gen_ai.input.messages")));
    ingestion.stop();

    const revisedRoot = records.findLast((record) => record.span?.span_id === "root");
    expect(revisedRoot?.attributes ?? []).toContainEqual(expect.objectContaining({ key: "gen_ai.input.messages" }));
  });

  it("uses a checkpoint for bounded at-least-once replay of recent span revisions", async () => {
    const dbPath = await createSpanDb();
    const first = new SpanDbTelemetryIngestion(10);
    const firstRecords: unknown[] = [];
    first.onRawRecord((record) => firstRecords.push(record));
    first.start({ spanDbPath: dbPath });
    await waitFor(() => firstRecords.length === 1);
    const checkpoint = first.getCheckpoint();
    first.stop();

    const resumed = new SpanDbTelemetryIngestion(10);
    const resumedRecords: unknown[] = [];
    resumed.onRawRecord((record) => resumedRecords.push(record));
    resumed.start({ spanDbPath: dbPath }, checkpoint);
    await waitFor(() => resumedRecords.length === 1);

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)")
        .run("root", "late.attribute", "updated");
    } finally {
      db.close();
    }
    await waitFor(() => resumedRecords.length === 2);
    resumed.stop();
  });
});

async function createSpanDb(options: { withPromptAttribute?: boolean; withChildSpan?: boolean } = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-span-db-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "agent-traces.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE spans (
        span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT,
        name TEXT NOT NULL, start_time_ms INTEGER NOT NULL, end_time_ms INTEGER NOT NULL,
        status_code INTEGER NOT NULL DEFAULT 0, status_message TEXT,
        operation_name TEXT, provider_name TEXT, agent_name TEXT, conversation_id TEXT,
        request_model TEXT, response_model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
        tool_name TEXT, tool_call_id TEXT, tool_type TEXT,
        chat_session_id TEXT, turn_index INTEGER, ttft_ms REAL
      );
      CREATE TABLE span_attributes (
        span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
        key TEXT NOT NULL, value TEXT,
        PRIMARY KEY (span_id, key)
      );
      CREATE TABLE span_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
        name TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, attributes TEXT
      );
    `);
    db.prepare(`
      INSERT INTO spans (
        span_id, trace_id, name, start_time_ms, end_time_ms, status_code,
        request_model, input_tokens, output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("root", "trace-1", "invoke_agent", 1_780_099_200_000, 1_780_099_210_000, 1, "gpt-5.3-codex", 100, 20);
    if (options.withPromptAttribute !== false) {
      db.prepare("INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)")
        .run("root", "gen_ai.input.messages", JSON.stringify([{ role: "user", content: "hello" }]));
    }
    db.prepare("INSERT INTO span_events (span_id, name, timestamp_ms, attributes) VALUES (?, ?, ?, ?)")
      .run("root", "copilot_chat.tool.call", 1_780_099_205_000, JSON.stringify({ "gen_ai.tool.name": "readFile" }));
    if (options.withChildSpan) {
      db.prepare(`
        INSERT INTO spans (
          span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms, status_code,
          request_model, input_tokens, output_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("child", "trace-1", "root", "chat", 1_780_099_260_000, 1_780_099_270_000, 1, "gpt-5.3-codex", 40, 10);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1_000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for span DB ingestion.");
}
