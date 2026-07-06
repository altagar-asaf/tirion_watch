import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IngestionCheckpoint } from "../types";
import { JsonIngestionCheckpointStore } from "./ingestionCheckpointStore";

describe("JsonIngestionCheckpointStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-checkpoint-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("persists and clears a durable ingestion checkpoint", async () => {
    const store = new JsonIngestionCheckpointStore(dir);
    const checkpoint: IngestionCheckpoint = {
      source: "jsonl",
      outfile: "/fingerprinted/source",
      offset: 42,
      partialLineLength: 0,
      malformedLineCount: 0
    };

    await store.save(checkpoint);
    expect(await new JsonIngestionCheckpointStore(dir).load()).toEqual(checkpoint);

    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
});
