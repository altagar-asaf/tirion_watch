import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IngestionCheckpoint, IngestionCheckpointStore } from "../types";

export class JsonIngestionCheckpointStore implements IngestionCheckpointStore {
  private readonly checkpointPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastSaved?: string;

  constructor(storageDir: string) {
    this.checkpointPath = path.join(storageDir, "ingestion-checkpoint.json");
  }

  async load(): Promise<IngestionCheckpoint | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.checkpointPath, "utf8"));
      return isCheckpoint(parsed) ? parsed : undefined;
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  async save(checkpoint: IngestionCheckpoint): Promise<void> {
    const serialized = `${JSON.stringify(checkpoint)}\n`;
    if (serialized === this.lastSaved) {
      return;
    }
    await this.enqueueWrite(async () => {
      if (serialized === this.lastSaved) {
        return;
      }
      await fs.mkdir(path.dirname(this.checkpointPath), { recursive: true });
      const tempPath = `${this.checkpointPath}.tmp`;
      await fs.writeFile(tempPath, serialized, "utf8");
      await fs.rename(tempPath, this.checkpointPath);
      this.lastSaved = serialized;
    });
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      await fs.rm(this.checkpointPath, { force: true });
      this.lastSaved = undefined;
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function isCheckpoint(value: unknown): value is IngestionCheckpoint {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { offset?: unknown }).offset === "number"
    && typeof (value as { partialLineLength?: unknown }).partialLineLength === "number"
    && typeof (value as { malformedLineCount?: unknown }).malformedLineCount === "number";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
