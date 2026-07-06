import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttributionHasher } from "../attribution/fingerprints";
import { DefaultPrivacyGuard } from "../privacy/privacyGuard";
import { QueryCostAttribution } from "../types";
import { JsonlCommitAttributionLedger } from "./commitAttributionLedger";

describe("JsonlCommitAttributionLedger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-commit-ledger-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("upserts query attribution records and compacts by query id", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());

    await ledger.upsertQueryAttribution(attribution("query-1", 10));
    await ledger.upsertQueryAttribution({ ...attribution("query-1", 25), status: "attributed" });

    const records = await ledger.listQueryAttributions({});
    const content = await fs.readFile(path.join(dir, "commit-attributions.jsonl"), "utf8");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ queryId: "query-1", estimatedNanoUsd: 25, status: "attributed" });
    expect(content.trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("rejects attribution records with path-shaped fields", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    const unsafe = {
      ...attribution("query-1", 10),
      filePath: "src/secret.ts"
    };

    await expect(ledger.upsertQueryAttribution(unsafe as QueryCostAttribution)).rejects.toThrow(/privacy violation/i);
  });

  it("rejects multiple active first claims and allocations above persisted query cost", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    const record = attribution("query-1", 10);

    await expect(ledger.upsertQueryAttribution({
      ...record,
      allocations: [...record.allocations, { ...record.allocations[0], commitHash: "commit-2" }]
    })).rejects.toThrow(/multiple active first claims/i);

    await expect(ledger.upsertQueryAttribution({
      ...record,
      allocations: [{ ...record.allocations[0], allocatedNanoUsd: 11 }]
    })).rejects.toThrow(/exceeds persisted query cost/i);
  });

  it("builds stable local fingerprints without making salts interchangeable", () => {
    const first = new AttributionHasher("salt-a");
    const second = new AttributionHasher("salt-a");
    const different = new AttributionHasher("salt-b");

    expect(first.artifactKey("repo", "src/file.ts")).toBe(second.artifactKey("repo", "src/file.ts"));
    expect(first.artifactKey("repo", "src/file.ts")).not.toBe(different.artifactKey("repo", "src/file.ts"));
  });

  it("applies retention to old attribution records", async () => {
    const ledger = new JsonlCommitAttributionLedger(
      dir,
      new DefaultPrivacyGuard(),
      () => Date.parse("2026-06-08T00:00:00.000Z")
    );

    await ledger.upsertQueryAttribution({
      ...attribution("old", 10),
      evidence: [{ ...attribution("old", 10).evidence[0], startedAt: "2020-01-01T00:00:00.000Z", completedAt: "2020-01-01T00:00:01.000Z" }],
      allocations: [{ ...attribution("old", 10).allocations[0], createdAt: "2020-01-01T00:00:02.000Z" }]
    });
    await ledger.upsertQueryAttribution(attribution("new", 10));

    const removed = await ledger.applyRetention(30);
    const records = await ledger.listQueryAttributions({});

    expect(removed).toBe(1);
    expect(records.map((record) => record.queryId)).toEqual(["new"]);
  });

  it("exports commit summaries separately from query run history", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertQueryAttribution(attribution("query-1", 10));

    const csv = await ledger.export("csv", {});
    const json = await ledger.export("json", {});

    expect(csv.content).toContain("Commit Hash,Commit Message,Repo Key,Episode IDs,Query IDs");
    expect(csv.content).toContain("commit-1");
    expect(json.content).toContain("\"commitHash\": \"commit-1\"");
  });

  it("surfaces only verified first claims and normalizes legacy long-context coverage", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertQueryAttribution({
      ...attribution("query-high", 25),
      costCoverage: "partial",
      pricingCoverage: {
        state: "partial",
        reasons: ["long_context_rate_unpublished"],
        pricedModels: ["gpt-5.4"],
        unpricedModels: ["gpt-5.4"],
        missingModelSlices: 0,
        pricingVersions: ["test"],
        pricingEffectiveFrom: ["2026-01-01"]
      },
      allocations: [{
        ...attribution("query-high", 25).allocations[0],
        coverage: "partial"
      }]
    });
    await ledger.upsertQueryAttribution({
      ...attribution("query-low-link", 10),
      status: "split_linked",
      allocations: [{
        ...attribution("query-low-link", 10).allocations[0],
        allocatedNanoUsd: undefined,
        allocationPolicy: "unallocated_link",
        confidence: "low"
      }]
    });

    const [summary] = await ledger.listCommitAttributions({});

    expect(summary).toMatchObject({
      queryIds: ["query-high"],
      linkedQueryCount: 1,
      allocatedNanoUsd: 25,
      linkedNanoUsd: 25,
      coverage: "complete",
      decision: "reportable",
      proofKinds: ["exact_content_state"]
    });
  });

  it("aggregates active allocated cost per provider for a commit, falling back to 'unknown'", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertQueryAttribution({ ...attribution("query-claude", 10), provider: "claude-code" });
    await ledger.upsertQueryAttribution({ ...attribution("query-codex", 20), provider: "codex" });
    await ledger.upsertQueryAttribution(attribution("query-unknown", 5));

    const [summary] = await ledger.listCommitAttributions({});

    expect(summary.providerCosts).toEqual([
      { provider: "claude-code", queryCount: 1, allocatedNanoUsd: 10, allocatedUsd: 10 / 1_000_000_000, allocatedAiCredits: 10 / 10_000_000 },
      { provider: "codex", queryCount: 1, allocatedNanoUsd: 20, allocatedUsd: 20 / 1_000_000_000, allocatedAiCredits: 20 / 10_000_000 },
      { provider: "unknown", queryCount: 1, allocatedNanoUsd: 5, allocatedUsd: 5 / 1_000_000_000, allocatedAiCredits: 5 / 10_000_000 }
    ]);
  });

  it("quarantines pre-epoch evidence even when it never produced an allocation", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertQueryAttribution({
      ...attribution("legacy-pending", 10),
      status: "pending_commit",
      allocations: [],
      evidence: attribution("legacy-pending", 10).evidence.map((item) => ({ ...item, epochId: undefined }))
    });

    await ledger.quarantineLegacy();

    expect((await ledger.listQueryAttributions({}))[0].status).toBe("legacy_unverified");
    expect(await ledger.listCommitAttributions({})).toEqual([]);
  });

  it("expires rewrite-pending claims back to unattributed spend", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertQueryAttribution(attribution("query-1", 10));
    await ledger.markRewritePending("repo-key", ["commit-1"], "2026-06-01T00:00:00.000Z");

    expect(await ledger.expireRewritePending("2026-06-02T00:00:00.000Z")).toBe(1);

    const [record] = await ledger.listQueryAttributions({});
    expect(record.status).toBe("expired");
    expect(record.allocations[0]).toMatchObject({ status: "superseded", decision: "superseded" });
    expect(await ledger.listCommitPublicationSnapshots({})).toEqual([]);
  });

  it("does not quarantine verified rewrite-pending claims on reload reconciliation", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertQueryAttribution(attribution("query-1", 10));
    await ledger.markRewritePending("repo-key", ["commit-1"], "2026-06-05T00:00:00.000Z");

    expect(await ledger.quarantineLegacy()).toBe(0);
    expect((await ledger.listQueryAttributions({}))[0]).toMatchObject({ status: "rewrite_pending" });
  });

  it("returns only verified publication snapshots and includes rewrite states", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertQueryAttribution(attribution("query-1", 10));
    await ledger.upsertQueryAttribution({
      ...attribution("legacy", 12),
      status: "legacy_unverified",
      allocations: [{
        ...attribution("legacy", 12).allocations[0],
        commitHash: "legacy-commit",
        status: "legacy_unverified",
        decision: "legacy_unverified",
        proof: undefined,
        epochId: undefined
      }]
    });

    await ledger.markRewritePending("repo-key", ["commit-1"], "2026-06-05T00:02:00.000Z");

    const snapshots = await ledger.listCommitPublicationSnapshots({});
    expect(snapshots).toEqual([expect.objectContaining({
      commitHash: "commit-1",
      state: "rewrite_pending",
      firstVerifiedAt: "2026-06-05T00:00:02.000Z",
      updatedAt: "2026-06-05T00:02:00.000Z",
      allocatedNanoUsd: 10,
      attributedQueryCount: 1
    })]);
  });

  it("publishes known cost as partial when a verified commit mixes priced and unpriced queries", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertQueryAttribution(attribution("priced-query", 25));
    const unpriced = attribution("unpriced-query", 10);
    unpriced.estimatedNanoUsd = undefined;
    unpriced.estimatedUsd = undefined;
    unpriced.estimatedAiCredits = undefined;
    unpriced.costCoverage = "unavailable";
    unpriced.allocations[0].allocatedNanoUsd = undefined;
    unpriced.allocations[0].coverage = "unavailable";
    await ledger.upsertQueryAttribution(unpriced);

    expect(await ledger.listCommitPublicationSnapshots({})).toEqual([
      expect.objectContaining({
        commitHash: "commit-1",
        allocatedNanoUsd: 25,
        coverage: "partial",
        attributedQueryCount: 2
      })
    ]);
  });

  it("records first verification at the durable claim time rather than candidate observation time", async () => {
    const verifiedAt = "2026-06-08T00:00:00.000Z";
    const ledger = new JsonlCommitAttributionLedger(
      dir,
      new DefaultPrivacyGuard(),
      () => Date.parse(verifiedAt)
    );
    await ledger.upsertQueryAttribution({
      ...attribution("late-query", 10),
      status: "pending_commit",
      allocations: []
    });

    await ledger.tryFirstClaim({
      candidate: {
        candidateId: "candidate-1",
        epochId: "epoch-1",
        repoKey: "repo-key",
        commitHash: "commit-late",
        parentHashes: ["parent-1"],
        refKey: "ref-main",
        observedAt: "2026-06-07T00:00:00.000Z",
        observedSequence: 2,
        artifactStates: [],
        transitionKind: "fast_forward",
        decision: "pending_evidence",
        reasonCodes: ["commit_observed_after_epoch"]
      },
      episode: {
        episodeId: "episode-late",
        repoKey: "repo-key",
        repoKeys: ["repo-key"],
        epochIds: ["epoch-1"],
        queryIds: ["late-query"],
        runIds: ["late-query-run"],
        startedAt: "2026-06-07T00:00:00.000Z",
        lastAgentActivityAt: "2026-06-07T00:01:00.000Z",
        status: "open",
        decision: "pending_evidence",
        evidence: []
      },
      proof: {
        kind: "exact_content_state",
        anchorQueryIds: ["late-query"],
        inheritedQueryIds: [],
        matchedArtifactCount: 1,
        reasonCodes: ["content_state_continuity"]
      },
      queryIds: ["late-query"]
    });

    const [record] = await ledger.listQueryAttributions({});
    expect(record.allocations[0]).toMatchObject({
      createdAt: "2026-06-07T00:00:00.000Z",
      verifiedAt,
      stateChangedAt: verifiedAt
    });
  });

  it("transfers an active first claim to a later same-episode commit", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard(), () => Date.parse("2026-06-08T00:05:00.000Z"));
    await ledger.upsertQueryAttribution(attribution("query-1", 10));

    const result = await ledger.transferFirstClaim({
      candidate: {
        candidateId: "candidate-2",
        epochId: "epoch-1",
        repoKey: "repo-key",
        commitHash: "commit-2",
        parentHashes: ["commit-1"],
        refKey: "ref-main",
        observedAt: "2026-06-08T00:04:00.000Z",
        observedSequence: 4,
        artifactStates: [],
        transitionKind: "fast_forward",
        decision: "pending_evidence",
        reasonCodes: ["verified_content_continuity"]
      },
      episode: {
        episodeId: "episode-1",
        repoKey: "repo-key",
        repoKeys: ["repo-key"],
        epochIds: ["epoch-1"],
        queryIds: ["query-1"],
        runIds: ["query-1-run"],
        startedAt: "2026-06-08T00:00:00.000Z",
        lastAgentActivityAt: "2026-06-08T00:04:00.000Z",
        status: "claimed",
        decision: "reportable",
        evidence: [{
          ...attribution("query-1", 10).evidence[0],
          completedAt: "2026-06-08T00:04:00.000Z"
        }]
      },
      proof: {
        kind: "episode_inheritance",
        anchorQueryIds: ["query-1"],
        inheritedQueryIds: ["query-1"],
        matchedArtifactCount: 1,
        reasonCodes: ["content_state_continuity", "unambiguous_episode_inheritance"]
      },
      queryIds: ["query-1"],
      supersededCommitHash: "commit-1"
    });

    expect(result).toEqual({ claimedQueryIds: ["query-1"], skippedQueryIds: [] });
    const [record] = await ledger.listQueryAttributions({});
    expect(record.allocations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        commitHash: "commit-1",
        status: "superseded",
        decision: "superseded"
      }),
      expect.objectContaining({
        commitHash: "commit-2",
        status: "active",
        decision: "reportable",
        proof: expect.objectContaining({ kind: "episode_inheritance" })
      })
    ]));
  });

  it("quarantines verified allocations whose repository epoch is no longer active", async () => {
    const ledger = new JsonlCommitAttributionLedger(dir, new DefaultPrivacyGuard());
    await ledger.upsertQueryAttribution(attribution("query-1", 10));

    expect(await ledger.quarantineLegacy(new Set(["different-epoch"]))).toBeGreaterThan(0);
    expect(await ledger.listCommitAttributions({})).toEqual([]);
    expect((await ledger.listQueryAttributions({}))[0].status).toBe("legacy_unverified");
  });
});

function attribution(queryId: string, estimatedNanoUsd: number): QueryCostAttribution {
  return {
    queryId,
    runIds: [`${queryId}-run`],
    estimatedNanoUsd,
    estimatedUsd: estimatedNanoUsd / 1_000_000_000,
    estimatedAiCredits: estimatedNanoUsd / 10_000_000,
    costCoverage: "complete",
    status: "attributed",
    evidence: [{
      queryId,
      runIds: [`${queryId}-run`],
      repoKey: "repo-key",
      startedAt: "2026-06-05T00:00:00.000Z",
      completedAt: "2026-06-05T00:00:01.000Z",
      baselineTrusted: true,
      baselineReasons: ["clean_baseline"],
      dirtyAtStart: false,
      observedChangeCount: 1,
      artifactKeys: ["artifact-a"],
      addedLines: 1,
      deletedLines: 0,
      firstObservedAt: "2026-06-05T00:00:00.500Z",
      lastObservedAt: "2026-06-05T00:00:01.000Z"
    }],
    allocations: [{
      episodeId: "episode-1",
      epochId: "epoch-1",
      commitHash: "commit-1",
      parentHashes: ["parent-1"],
      repoKey: "repo-key",
      queryId,
      allocatedNanoUsd: estimatedNanoUsd,
      allocationPolicy: "first_claim",
      decision: "reportable",
      proof: {
        kind: "exact_content_state",
        anchorQueryIds: [queryId],
        inheritedQueryIds: [],
        matchedArtifactCount: 1,
        reasonCodes: ["content_state_continuity"]
      },
      confidence: "high",
      coverage: "complete",
      evidenceReasons: ["artifact_overlap_1", "first_claim_allocated"],
      status: "active",
      verifiedAt: "2026-06-05T00:00:02.000Z",
      stateChangedAt: "2026-06-05T00:00:02.000Z",
      createdAt: "2026-06-05T00:00:02.000Z"
    }]
  };
}
