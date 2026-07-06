import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { EventEmitter } from "node:events";
import { IngestionCheckpoint, TelemetryIngestion, TelemetryIngestionSource } from "../types";
import { isRecord, stableRecordKey } from "../normalization/otelValues";

export class JsonlTelemetryIngestion implements TelemetryIngestion {
  private readonly emitter = new EventEmitter();
  private timer?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  private polling = false;
  private outfile?: string;
  private readOffset = 0;
  private checkpointOffset = 0;
  private checkpointFloor = 0;
  private partial: Buffer = Buffer.alloc(0);
  private discardLeadingPartial = false;
  private initialized = false;
  private malformedLineCount = 0;
  private lastReadAt?: string;
  private lastLineAt?: string;
  private readonly seenRawKeys = new Set<string>();

  constructor(
    private readonly pollIntervalMs = 1_000,
    private readonly bootstrapMode: "tail" | "beginning" = "tail",
    private readonly maxReadBytes = 1_024 * 1_024,
    private readonly resumeReplayBytes = 4 * 1_024 * 1_024
  ) {}

  start(source: TelemetryIngestionSource, checkpoint?: IngestionCheckpoint): void {
    this.stop();
    if (!source.outfile) {
      return;
    }

    this.outfile = source.outfile;
    const resumeOffset = checkpoint?.source === "jsonl" && checkpoint.outfile === source.outfile
      ? Math.max(0, checkpoint.offset)
      : undefined;
    this.readOffset = resumeOffset == null ? 0 : Math.max(0, resumeOffset - this.resumeReplayBytes);
    this.checkpointOffset = resumeOffset ?? 0;
    this.checkpointFloor = resumeOffset ?? 0;
    this.partial = Buffer.alloc(0);
    this.discardLeadingPartial = resumeOffset != null && this.readOffset > 0 && this.readOffset < resumeOffset;
    this.initialized = resumeOffset != null || this.bootstrapMode === "beginning";
    this.malformedLineCount = 0;
    this.seenRawKeys.clear();

    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref?.();

    try {
      this.watcher = fs.watch(source.outfile, { persistent: false }, () => void this.poll());
    } catch {
      this.watcher = undefined;
    }

    void this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
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
      source: "jsonl",
      outfile: this.outfile,
      offset: this.checkpointOffset,
      partialLineLength: this.partial.length,
      lastReadAt: this.lastReadAt,
      lastLineAt: this.lastLineAt,
      malformedLineCount: this.malformedLineCount
    };
  }

  private async poll(): Promise<void> {
    if (!this.outfile || this.polling) {
      return;
    }

    this.polling = true;
    try {
      const stat = await safeStat(this.outfile);
      if (!stat) {
        return;
      }

      if (!this.initialized) {
        this.readOffset = stat.size;
        this.checkpointOffset = stat.size;
        this.checkpointFloor = stat.size;
        this.initialized = true;
        this.emitCheckpoint();
        return;
      }

      if (stat.size < this.readOffset || stat.size < this.checkpointFloor) {
        this.readOffset = this.bootstrapMode === "tail" ? stat.size : 0;
        this.checkpointOffset = this.readOffset;
        this.checkpointFloor = this.readOffset;
        this.partial = Buffer.alloc(0);
        this.discardLeadingPartial = false;
      }

      if (stat.size === this.readOffset) {
        return;
      }

      const length = Math.min(stat.size - this.readOffset, this.maxReadBytes);
      const chunk = await readRange(this.outfile, this.readOffset, length);
      this.readOffset += chunk.length;
      this.lastReadAt = new Date().toISOString();

      const split = splitCompleteLines(Buffer.concat([this.partial, chunk]));
      this.partial = split.partial;
      if (this.discardLeadingPartial && split.lines.length > 0) {
        split.lines.shift();
        this.discardLeadingPartial = false;
      }
      this.checkpointOffset = Math.max(this.checkpointFloor, this.readOffset - this.partial.length);

      for (const line of split.lines) {
        if (!line.trim()) {
          continue;
        }
        this.parseLine(line);
      }
      this.emitCheckpoint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitter.emit("parseError", `JSONL read failed: ${message}`);
    } finally {
      this.polling = false;
    }
  }

  private parseLine(line: string): void {
    try {
      const raw = JSON.parse(line);
      const key = rawRecordKey(raw);
      if (this.seenRawKeys.has(key)) {
        return;
      }

      this.rememberRawKey(key);
      this.lastLineAt = new Date().toISOString();
      this.emitter.emit("rawRecord", raw);
    } catch (error) {
      this.malformedLineCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      this.emitter.emit("parseError", message, line.slice(0, 500));
    }
  }

  private rememberRawKey(key: string): void {
    this.seenRawKeys.add(key);
    if (this.seenRawKeys.size <= 10_000) {
      return;
    }

    const first = this.seenRawKeys.values().next().value;
    if (first) {
      this.seenRawKeys.delete(first);
    }
  }

  private emitCheckpoint(): void {
    this.emitter.emit("checkpoint", this.getCheckpoint());
  }
}

async function safeStat(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(filePath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function splitCompleteLines(buffer: Buffer): { lines: string[]; partial: Buffer } {
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) {
      continue;
    }
    const lineEnd = index > lineStart && buffer[index - 1] === 0x0d ? index - 1 : index;
    lines.push(buffer.subarray(lineStart, lineEnd).toString("utf8"));
    lineStart = index + 1;
  }
  return { lines, partial: buffer.subarray(lineStart) };
}

function rawRecordKey(record: unknown): string {
  if (!isRecord(record)) {
    return stableRecordKey(record);
  }

  const traceId = stringFrom(record.traceId);
  const spanId = stringFrom(record.spanId);
  const name = stringFrom(record.name);
  const time = stringFrom(record.timeUnixNano ?? record.startTimeUnixNano ?? record.endTimeUnixNano);

  if (traceId || spanId || name || time) {
    return `${traceId}:${spanId}:${name}:${time}`;
  }

  return stableRecordKey(record);
}

function stringFrom(value: unknown): string {
  return typeof value === "string" ? value : "";
}
