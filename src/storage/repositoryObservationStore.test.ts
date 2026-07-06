import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPrivacyGuard } from "../privacy/privacyGuard";
import { AttributionEpoch, ObservedCommitCandidate } from "../types";
import { JsonRepositoryObservationStore } from "./repositoryObservationStore";

describe("JsonRepositoryObservationStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-observation-store-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("atomically persists candidates with the advanced epoch cursor", async () => {
    const store = new JsonRepositoryObservationStore(dir, new DefaultPrivacyGuard());
    const nextEpoch = { ...epoch(), cursorHead: "commit-1", nextSequence: 3 };

    await store.persistCandidatesAndAdvance(nextEpoch, [candidate()]);

    expect((await store.listEpochs())[0].cursorHead).toBe("commit-1");
    expect((await store.listCandidates())[0].commitHash).toBe("commit-1");
  });

  it("fails closed when persisted observation state is corrupt", async () => {
    await fs.writeFile(path.join(dir, "repository-observation.json"), "{broken", "utf8");
    const store = new JsonRepositoryObservationStore(dir, new DefaultPrivacyGuard());

    const initialized = await store.initialize();

    expect(initialized.recoveredFromCorruption).toBe(true);
    expect(initialized.epochs).toEqual([]);
    expect(initialized.candidates).toEqual([]);
  });

  it("fails closed across the pre-ref-cursor observation schema boundary", async () => {
    await fs.writeFile(path.join(dir, "repository-observation.json"), JSON.stringify({
      schemaVersion: 1,
      epochs: [epoch()],
      candidates: []
    }), "utf8");
    const store = new JsonRepositoryObservationStore(dir, new DefaultPrivacyGuard());

    const initialized = await store.initialize();

    expect(initialized.recoveredFromCorruption).toBe(true);
    expect(initialized.epochs).toEqual([]);
  });

  it("rejects path-bearing observation fields", async () => {
    const store = new JsonRepositoryObservationStore(dir, new DefaultPrivacyGuard());

    await expect(store.updateCandidate({ ...candidate(), filePath: "secret.ts" } as ObservedCommitCandidate)).rejects.toThrow(/privacy violation/i);
  });
});

function epoch(): AttributionEpoch {
  return {
    epochId: "epoch-1",
    repoKey: "repo-key",
    startedAt: "2026-06-05T00:00:00.000Z",
    initialHead: "base",
    cursorHead: "base",
    refHeads: { "ref-main": "base" },
    nextSequence: 2,
    status: "active"
  };
}

function candidate(): ObservedCommitCandidate {
  return {
    candidateId: "epoch-1:commit-1",
    epochId: "epoch-1",
    repoKey: "repo-key",
    commitHash: "commit-1",
    parentHashes: ["base"],
    observedAt: "2026-06-05T00:01:00.000Z",
    observedSequence: 2,
    artifactStates: [],
    transitionKind: "fast_forward",
    decision: "pending_evidence",
    reasonCodes: []
  };
}
