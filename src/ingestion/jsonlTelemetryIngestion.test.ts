import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlTelemetryIngestion } from "./jsonlTelemetryIngestion";

const tempDirs: string[] = [];

describe("JsonlTelemetryIngestion", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("tails an existing archive on first observation instead of replaying it", async () => {
    const outfile = await createOutfile([record("historical")]);
    const ingestion = new JsonlTelemetryIngestion(10);
    const records: unknown[] = [];
    ingestion.onRawRecord((record) => records.push(record));

    ingestion.start({ outfile });
    await waitFor(() => ingestion.getCheckpoint().offset > 0);
    expect(records).toEqual([]);

    await fs.appendFile(outfile, `${JSON.stringify(record("new"))}\n`);
    await waitFor(() => records.length === 1);
    ingestion.stop();

    expect(records[0]).toMatchObject({ spanId: "new" });
  });

  it("resumes from a durable checkpoint without replaying processed rows", async () => {
    const outfile = await createOutfile([record("one")]);
    const first = new JsonlTelemetryIngestion(10, "beginning");
    const firstRecords: unknown[] = [];
    first.onRawRecord((record) => firstRecords.push(record));
    first.start({ outfile });
    await waitFor(() => firstRecords.length === 1);
    const checkpoint = first.getCheckpoint();
    first.stop();

    await fs.appendFile(outfile, `${JSON.stringify(record("two"))}\n`);
    const resumed = new JsonlTelemetryIngestion(10, "tail", 1_024 * 1_024, 0);
    const resumedRecords: unknown[] = [];
    resumed.onRawRecord((record) => resumedRecords.push(record));
    resumed.start({ outfile }, checkpoint);
    await waitFor(() => resumedRecords.length === 1);
    resumed.stop();

    expect(resumedRecords[0]).toMatchObject({ spanId: "two" });
  });

  it("replays only a bounded recent window to rebuild in-flight state", async () => {
    const historical = Array.from({ length: 20 }, (_, index) => record(`span-${index}`));
    const outfile = await createOutfile(historical);
    const stat = await fs.stat(outfile);
    const ingestion = new JsonlTelemetryIngestion(10, "tail", 1_024 * 1_024, 300);
    const records: unknown[] = [];
    ingestion.onRawRecord((record) => records.push(record));

    ingestion.start({ outfile }, {
      source: "jsonl",
      outfile,
      offset: stat.size,
      partialLineLength: 0,
      malformedLineCount: 0
    });
    await waitFor(() => records.length > 0);
    ingestion.stop();

    expect(records.length).toBeLessThan(historical.length);
  });

  it("keeps incomplete rows behind the checkpoint and handles UTF-8 across bounded reads", async () => {
    const dir = await createTempDir();
    const outfile = path.join(dir, "otel.jsonl");
    const complete = `${JSON.stringify(record("one"))}\n`;
    const pending = JSON.stringify({ ...record("two"), message: "שלום" });
    await fs.writeFile(outfile, complete + pending.slice(0, -1), "utf8");

    const first = new JsonlTelemetryIngestion(10, "beginning", 5);
    const firstRecords: unknown[] = [];
    first.onRawRecord((record) => firstRecords.push(record));
    first.start({ outfile });
    await waitFor(() => firstRecords.length === 1 && first.getCheckpoint().partialLineLength > 0);
    const checkpoint = first.getCheckpoint();
    first.stop();

    expect(checkpoint.offset).toBe(Buffer.byteLength(complete));
    await fs.appendFile(outfile, `${pending.slice(-1)}\n`, "utf8");

    const resumed = new JsonlTelemetryIngestion(10, "tail", 5, 0);
    const resumedRecords: unknown[] = [];
    resumed.onRawRecord((record) => resumedRecords.push(record));
    resumed.start({ outfile }, checkpoint);
    await waitFor(() => resumedRecords.length === 1);
    resumed.stop();

    expect(resumedRecords[0]).toMatchObject({ spanId: "two", message: "שלום" });
  });
});

function record(spanId: string): Record<string, string> {
  return { traceId: `trace-${spanId}`, spanId, name: "invoke_agent", startTimeUnixNano: spanId };
}

async function createOutfile(records: unknown[]): Promise<string> {
  const dir = await createTempDir();
  const outfile = path.join(dir, "otel.jsonl");
  await fs.writeFile(outfile, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return outfile;
}

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-jsonl-ingestion-"));
  tempDirs.push(dir);
  return dir;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1_000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for JSONL ingestion.");
}
