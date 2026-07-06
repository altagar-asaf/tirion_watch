import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPrivacyGuard } from "../privacy/privacyGuard";
import { QueryWorkEvidence } from "../types";
import { JsonlWorkspaceEvidenceLedger } from "./workspaceEvidenceLedger";

describe("JsonlWorkspaceEvidenceLedger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-workspace-evidence-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("restores HMAC-only active evidence across instances", async () => {
    await new JsonlWorkspaceEvidenceLedger(dir, new DefaultPrivacyGuard()).upsertEvidence(evidence());

    const [restored] = await new JsonlWorkspaceEvidenceLedger(dir, new DefaultPrivacyGuard()).listEvidence({});

    expect(restored).toMatchObject({
      queryId: "query-1",
      epochId: "epoch-1",
      artifactKeys: ["artifact-key"],
      status: "active"
    });
  });

  it("durably restores an unfinished post-run settling window", async () => {
    const settling = {
      ...evidence(),
      completedAt: "2026-06-05T00:01:00.000Z",
      settlingUntil: "2026-06-05T00:03:00.000Z",
      status: "settling" as const
    };
    await new JsonlWorkspaceEvidenceLedger(dir, new DefaultPrivacyGuard()).upsertEvidence(settling);

    const [restored] = await new JsonlWorkspaceEvidenceLedger(dir, new DefaultPrivacyGuard()).listEvidence({ status: "settling" });

    expect(restored).toMatchObject({
      queryId: "query-1",
      status: "settling",
      settlingUntil: "2026-06-05T00:03:00.000Z"
    });
  });

  it("rejects path-bearing evidence", async () => {
    const ledger = new JsonlWorkspaceEvidenceLedger(dir, new DefaultPrivacyGuard());

    await expect(ledger.upsertEvidence({ ...evidence(), filePath: "secret.ts" } as QueryWorkEvidence)).rejects.toThrow(/privacy violation/i);
  });

  it("removes evidence when its query is no longer retained", async () => {
    const ledger = new JsonlWorkspaceEvidenceLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertEvidence(evidence());

    expect(await ledger.applyRetention(new Set())).toBe(1);
    expect(await ledger.listEvidence({})).toEqual([]);
  });
});

function evidence(): QueryWorkEvidence {
  return {
    queryId: "query-1",
    runIds: ["run-1"],
    repoKey: "repo-key",
    epochId: "epoch-1",
    startedAt: "2026-06-05T00:00:00.000Z",
    baselineTrusted: true,
    baselineReasons: ["clean_baseline"],
    baselineSequence: 1,
    dirtyAtStart: false,
    observedChangeCount: 1,
    artifactKeys: ["artifact-key"],
    artifactStates: [{
      artifactKey: "artifact-key",
      worktreeStateKey: "state-key",
      changeKind: "modified",
      observedSequence: 2
    }],
    addedLines: 1,
    deletedLines: 0,
    status: "active"
  };
}
