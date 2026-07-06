import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { IngestionCheckpoint, TelemetryIngestion, TelemetryIngestionSource } from "../types";

type SqliteRow = Record<string, unknown>;

type SqliteDatabase = {
  prepare(sql: string): {
    all(...params: unknown[]): SqliteRow[];
    get(...params: unknown[]): SqliteRow | undefined;
  };
  exec(sql: string): void;
  close(): void;
};

type DatabaseSyncConstructor = new (location: string, options?: Record<string, unknown>) => SqliteDatabase;

export type CopilotSpanDbRecord = {
  tirionSource: "copilot-span-db";
  span: SqliteRow;
  attributes: Array<{ key: string; value: unknown }>;
  events: SqliteRow[];
};

export class SpanDbTelemetryIngestion implements TelemetryIngestion {
  private readonly emitter = new EventEmitter();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private spanDbPath?: string;
  private db?: SqliteDatabase;
  private lastStartTimeMs = 0;
  private lastReadAt?: string;
  private lastSpanAt?: string;
  private malformedLineCount = 0;
  private seenSpanCount = 0;
  private spanDbAvailable = false;
  private spanDbError?: string;
  private readonly seenSpanRevisions = new Map<string, string>();
  private initializedFromSource = false;

  constructor(
    private readonly pollIntervalMs = 1_000,
    private readonly revisitWindowMs = 5 * 60 * 1000
  ) {}

  start(source: TelemetryIngestionSource, checkpoint?: IngestionCheckpoint): void {
    this.stop();
    this.spanDbPath = source.spanDbPath;
    const resume = checkpoint?.source === "spanDb" && checkpoint.spanDbPath === source.spanDbPath
      ? checkpoint
      : undefined;
    this.lastStartTimeMs = resume?.spanDbLastStartTimeMs ?? 0;
    this.lastReadAt = undefined;
    this.lastSpanAt = undefined;
    this.malformedLineCount = 0;
    this.seenSpanCount = resume?.spanDbSeenSpanCount ?? 0;
    this.spanDbAvailable = false;
    this.spanDbError = undefined;
    this.initializedFromSource = resume != null;
    this.seenSpanRevisions.clear();

    if (!this.spanDbPath) {
      this.spanDbError = "No Copilot span DB path was configured.";
      return;
    }

    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
    this.polling = false;
  }

  onRawRecord(handler: (record: unknown) => void): void {
    this.emitter.on("rawRecord", handler);
  }

  onParseError(handler: (message: string, sample?: string) => void): void {
    this.emitter.on("parseError", handler);
  }

  onCheckpoint(handler: (checkpoint: IngestionCheckpoint) => void): void {
    this.emitter.on("checkpoint", handler);
  }

  getCheckpoint(): IngestionCheckpoint {
    return {
      source: "spanDb",
      spanDbPath: this.spanDbPath,
      spanDbAvailable: this.spanDbAvailable,
      offset: 0,
      partialLineLength: 0,
      lastReadAt: this.lastReadAt,
      lastSpanAt: this.lastSpanAt,
      spanDbLastStartTimeMs: this.lastStartTimeMs,
      spanDbSeenSpanCount: this.seenSpanCount,
      spanDbError: this.spanDbError,
      malformedLineCount: this.malformedLineCount
    };
  }

  private async poll(): Promise<void> {
    if (!this.spanDbPath || this.polling) {
      return;
    }

    this.polling = true;
    try {
      if (!fs.existsSync(this.spanDbPath)) {
        this.spanDbAvailable = false;
        this.spanDbError = "Copilot span DB has not been created yet.";
        return;
      }

      const db = this.openDb();
      if (!this.initializedFromSource) {
        const latest = db.prepare("SELECT MAX(start_time_ms) AS max_start_time_ms FROM spans").get();
        this.lastStartTimeMs = numberValue(latest?.max_start_time_ms) ?? 0;
        this.initializedFromSource = true;
      }
      const lowerBoundStartTimeMs = Math.max(0, this.lastStartTimeMs - this.revisitWindowMs);
      const spans = db
        .prepare("SELECT * FROM spans WHERE start_time_ms >= ? ORDER BY start_time_ms, span_id")
        .all(lowerBoundStartTimeMs);
      const attributesForSpan = db.prepare("SELECT key, value FROM span_attributes WHERE span_id = ?");
      const eventsForSpan = db.prepare("SELECT * FROM span_events WHERE span_id = ? ORDER BY timestamp_ms, id");

      this.lastReadAt = new Date().toISOString();
      this.spanDbAvailable = true;
      this.spanDbError = undefined;

      for (const span of spans) {
        const spanId = stringValue(span.span_id);
        if (!spanId) {
          continue;
        }

        const startTimeMs = numberValue(span.start_time_ms) ?? 0;
        const attributes = attributesForSpan.all(spanId).map((row) => ({
          key: stringValue(row.key) ?? "",
          value: row.value
        })).filter((row) => row.key !== "");
        const events = eventsForSpan.all(spanId);
        const revision = revisionForSpan(span, attributes, events);
        if (this.seenSpanRevisions.get(spanId) === revision) {
          continue;
        }

        this.rememberSpanRevision(spanId, revision);
        this.lastStartTimeMs = Math.max(this.lastStartTimeMs, startTimeMs);
        this.lastSpanAt = new Date(startTimeMs).toISOString();
        this.seenSpanCount += 1;

        const record: CopilotSpanDbRecord = {
          tirionSource: "copilot-span-db",
          span,
          attributes,
          events
        };

        this.emitter.emit("rawRecord", record);
      }
      this.emitter.emit("checkpoint", this.getCheckpoint());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.spanDbAvailable = false;
      this.spanDbError = message;
      this.malformedLineCount += 1;
      this.emitter.emit("parseError", `Span DB read failed: ${message}`);
      this.closeDb();
    } finally {
      this.polling = false;
    }
  }

  private openDb(): SqliteDatabase {
    if (this.db) {
      return this.db;
    }

    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(this.spanDbPath!, { readOnly: true, open: true });
    try {
      db.exec("PRAGMA query_only = ON");
      assertSpanDbSchema(db);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private closeDb(): void {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = undefined;
  }

  private rememberSpanRevision(spanId: string, revision: string): void {
    this.seenSpanRevisions.set(spanId, revision);
    if (this.seenSpanRevisions.size <= 20_000) {
      return;
    }

    const first = this.seenSpanRevisions.keys().next().value;
    if (typeof first === "string") {
      this.seenSpanRevisions.delete(first);
    }
  }
}

function revisionForSpan(
  span: SqliteRow,
  attributes: Array<{ key: string; value: unknown }>,
  events: SqliteRow[]
): string {
  return createHash("sha256").update(JSON.stringify({
    endTimeMs: span.end_time_ms ?? null,
    statusCode: span.status_code ?? null,
    statusMessage: span.status_message ?? null,
    attributes: attributes.map((attribute) => [attribute.key, stableValue(attribute.value)]),
    events: events.map((event) => [event.id ?? null, event.name ?? null, event.timestamp_ms ?? null, stableValue(event.attributes)])
  })).digest("hex");
}

function stableValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? null);
}

function loadDatabaseSync(): DatabaseSyncConstructor {
  try {
    const sqlite = require("node:sqlite") as { DatabaseSync?: DatabaseSyncConstructor };
    if (!sqlite.DatabaseSync) {
      throw new Error("node:sqlite DatabaseSync is unavailable.");
    }
    return sqlite.DatabaseSync;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`This runtime cannot read Copilot's span DB because node:sqlite is unavailable: ${message}`);
  }
}

function assertSpanDbSchema(db: SqliteDatabase): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all();
  const names = new Set(rows.map((row) => stringValue(row.name)).filter((name): name is string => !!name));
  const required = ["spans", "span_attributes", "span_events"];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Not a Copilot OTel span DB. Missing tables: ${missing.join(", ")}`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
