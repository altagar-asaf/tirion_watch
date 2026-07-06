import { EventEmitter } from "node:events";
import { IngestionCheckpoint, TelemetryIngestion, TelemetryIngestionSource } from "../types";

export class CompositeTelemetryIngestion implements TelemetryIngestion {
  private readonly emitter = new EventEmitter();
  private activeChildren: TelemetryIngestion[] = [];

  constructor(
    private readonly jsonlIngestion: TelemetryIngestion,
    private readonly spanDbIngestion: TelemetryIngestion
  ) {
    for (const child of [this.jsonlIngestion, this.spanDbIngestion]) {
      child.onRawRecord((record) => this.emitter.emit("rawRecord", record));
      child.onParseError((message, sample) => this.emitter.emit("parseError", message, sample));
      child.onCheckpoint(() => this.emitter.emit("checkpoint", this.getCheckpoint()));
    }
  }

  start(source: TelemetryIngestionSource, checkpoint?: IngestionCheckpoint): void {
    this.stop();
    this.activeChildren = [];

    if (source.mode !== "spanDb" && source.outfile) {
      this.jsonlIngestion.start({ mode: "file", outfile: source.outfile }, checkpointFor(checkpoint, "jsonl"));
      this.activeChildren.push(this.jsonlIngestion);
    }

    if (source.mode !== "file" && source.spanDbPath) {
      this.spanDbIngestion.start({ mode: "spanDb", spanDbPath: source.spanDbPath }, checkpointFor(checkpoint, "spanDb"));
      this.activeChildren.push(this.spanDbIngestion);
    }
  }

  stop(): void {
    for (const child of this.activeChildren) {
      child.stop();
    }
    this.activeChildren = [];
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
    const children = this.activeChildren.map((child) => child.getCheckpoint());
    const lastReadAt = latestDefined(children.map((child) => child.lastReadAt));
    const lastLineAt = latestDefined(children.map((child) => child.lastLineAt));
    const lastSpanAt = latestDefined(children.map((child) => child.lastSpanAt));

    return {
      source: "composite",
      outfile: children.find((child) => child.outfile)?.outfile,
      spanDbPath: children.find((child) => child.spanDbPath)?.spanDbPath,
      spanDbAvailable: children.some((child) => child.spanDbAvailable),
      offset: children.reduce((sum, child) => sum + child.offset, 0),
      partialLineLength: children.reduce((sum, child) => sum + child.partialLineLength, 0),
      lastReadAt,
      lastLineAt,
      lastSpanAt,
      spanDbLastStartTimeMs: Math.max(0, ...children.map((child) => child.spanDbLastStartTimeMs ?? 0)),
      spanDbSeenSpanCount: children.reduce((sum, child) => sum + (child.spanDbSeenSpanCount ?? 0), 0),
      spanDbError: children.find((child) => child.spanDbError)?.spanDbError,
      malformedLineCount: children.reduce((sum, child) => sum + child.malformedLineCount, 0),
      children
    };
  }
}

function latestDefined(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => !!value).sort().at(-1);
}

function checkpointFor(
  checkpoint: IngestionCheckpoint | undefined,
  source: "jsonl" | "spanDb"
): IngestionCheckpoint | undefined {
  if (!checkpoint) {
    return undefined;
  }
  if (checkpoint.source === source) {
    return checkpoint;
  }
  return checkpoint.children?.find((child) => child.source === source);
}
