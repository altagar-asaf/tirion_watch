import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPrivacyGuard } from "../privacy/privacyGuard";
import { AgenticWorkEpisode } from "../types";
import { JsonlWorkEpisodeLedger } from "./workEpisodeLedger";

describe("JsonlWorkEpisodeLedger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-episode-ledger-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("upserts work episodes and compacts by episode id", async () => {
    const ledger = new JsonlWorkEpisodeLedger(dir, new DefaultPrivacyGuard());

    await ledger.upsertEpisode(episode("episode-1", ["query-1"]));
    await ledger.upsertEpisode({ ...episode("episode-1", ["query-1", "query-2"]), status: "claimed" });

    const records = await ledger.listEpisodes({});
    const content = await fs.readFile(path.join(dir, "work-episodes.jsonl"), "utf8");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ episodeId: "episode-1", queryIds: ["query-1", "query-2"], status: "claimed" });
    expect(content.trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("rejects records with path-shaped attribution fields", async () => {
    const ledger = new JsonlWorkEpisodeLedger(dir, new DefaultPrivacyGuard());
    const unsafe = {
      ...episode("episode-1", ["query-1"]),
      filePath: "src/secret.ts"
    };

    await expect(ledger.upsertEpisode(unsafe as AgenticWorkEpisode)).rejects.toThrow(/privacy violation/i);
  });

  it("applies retention to stale episode records", async () => {
    const ledger = new JsonlWorkEpisodeLedger(
      dir,
      new DefaultPrivacyGuard(),
      () => Date.parse("2026-06-08T00:00:00.000Z")
    );

    await ledger.upsertEpisode({ ...episode("old", ["query-old"]), lastAgentActivityAt: "2020-01-01T00:00:00.000Z" });
    await ledger.upsertEpisode(episode("new", ["query-new"]));

    const removed = await ledger.applyRetention(30);
    const records = await ledger.listEpisodes({});

    expect(removed).toBe(1);
    expect(records.map((record) => record.episodeId)).toEqual(["new"]);
  });

  it("clears episode records", async () => {
    const ledger = new JsonlWorkEpisodeLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertEpisode(episode("episode-1", ["query-1"]));

    await ledger.clear();

    expect(await ledger.listEpisodes({})).toEqual([]);
  });

  it("compacts legacy duplicate logical episodes during initialization", async () => {
    const first = episode("duplicate-1", ["query-1"]);
    const second = {
      ...episode("duplicate-2", ["query-2"]),
      startedAt: "2026-06-05T00:01:00.000Z",
      lastAgentActivityAt: "2026-06-05T00:01:01.000Z"
    };
    await fs.writeFile(
      path.join(dir, "work-episodes.jsonl"),
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      "utf8"
    );
    const ledger = new JsonlWorkEpisodeLedger(dir, new DefaultPrivacyGuard());

    const removed = await ledger.initialize();
    const records = await ledger.listEpisodes({});

    expect(removed).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0].queryIds).toEqual(["query-1", "query-2"]);
  });

  it("does not compact a new open episode into a previously claimed episode", async () => {
    const claimed = {
      ...episode("claimed", ["query-1"]),
      status: "claimed" as const,
      claimedByCommitHash: "commit-1"
    };
    const next = {
      ...episode("next", ["query-2"]),
      startedAt: "2026-06-05T00:02:00.000Z",
      lastAgentActivityAt: "2026-06-05T00:02:01.000Z"
    };
    await fs.writeFile(
      path.join(dir, "work-episodes.jsonl"),
      `${JSON.stringify(claimed)}\n${JSON.stringify(next)}\n`,
      "utf8"
    );
    const ledger = new JsonlWorkEpisodeLedger(dir, new DefaultPrivacyGuard());

    const removed = await ledger.initialize();
    const records = await ledger.listEpisodes({});

    expect(removed).toBe(0);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.episodeId).sort()).toEqual(["claimed", "next"]);
  });
});

function episode(episodeId: string, queryIds: string[]): AgenticWorkEpisode {
  return {
    episodeId,
    repoKey: "repo-key",
    chatSessionId: "session-1",
    queryIds,
    runIds: queryIds.map((queryId) => `${queryId}-run`),
    headCommitAtStart: "base",
    startedAt: "2026-06-05T00:00:00.000Z",
    lastAgentActivityAt: "2026-06-05T00:00:01.000Z",
    status: "open",
    evidence: [],
    confidence: "medium",
    confidenceReasons: ["session_temporal_claim", "missing_file_evidence"]
  };
}
