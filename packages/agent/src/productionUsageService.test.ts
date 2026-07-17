import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductionRunV1 } from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { ProductionUsageService } from "./productionUsageService";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production usage service", () => {
  it("starts from a clean epoch and never imports pre-epoch shadow atoms", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_usage_owner", protocolVersion: "1.0" });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-otlp-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation(observation("old", "2026-06-08T00:00:00.000Z"));
    const service = new ProductionUsageService(storage);
    await service.startCleanEpoch("9999-01-01T00:00:00.000Z");
    expect(await service.rebuild("agent_usage_owner")).toHaveLength(0);
    expect(await service.totals("agent_usage_owner")).toMatchObject({ production: true, runCount: 0 });
    await storage.close();
  });

  it("fails closed outside production ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-owner-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_shadow", protocolVersion: "1.0" });
    const service = new ProductionUsageService(storage);
    await expect(service.runs("agent_shadow")).rejects.toThrow("unsupported_capability");
    await storage.close();
  });

  it("keeps authoritative production history after the safe journal is pruned", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-pruned-journal-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_usage_owner", protocolVersion: "1.0" });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-otlp-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation(observation("retained", "2026-06-08T00:00:01.000Z"));
    const service = new ProductionUsageService(storage);
    await service.startCleanEpoch("2026-06-08T00:00:00.000Z");
    expect(await service.rebuild("agent_usage_owner")).toHaveLength(1);
    await storage.applySafeObservationRetention("9999-01-01T00:00:00.000Z", 1);
    expect(await storage.safeObservationCount()).toBe(0);
    expect(await service.rebuild("agent_usage_owner")).toHaveLength(1);
    await storage.close();
  });

  it("uses a recent reconciliation window on restart when durable production history already exists", async () => {
    const usageStarts: string[] = [];
    const activityStarts: string[] = [];
    let occurrenceReadCount = 0;
    let persistedRuns: ProductionRunV1[] = [productionRun("existing", "2026-04-10T00:00:00.000Z")];
    const outcomeOccurrence = (queryId: string, completedAt: string) => ({
      schemaVersion: 1 as const,
      queryId,
      sessionId: `ses_${queryId}`,
      lifecycleVisibility: "customer" as const,
      provider: "claude-code" as const,
      runtime: "claude-code",
      startedAt: "2026-04-02T00:00:00.000Z",
      completedAt,
      completionEvidence: "stop_hook" as const,
      completionOutcome: "failure" as const,
      promptState: "disabled" as const,
      evidence: "submission_hook" as const
    });
    const storage = {
      productionUsageEpoch: async () => ({
        schemaVersion: 1,
        epochId: "usage_epoch_12345678",
        startedAt: "2026-04-01T00:00:00.000Z"
      }),
      listProductionRuns: async () => persistedRuns,
      listSafeUsageAtomsSince: async (startedAt: string) => {
        usageStarts.push(startedAt);
        return [];
      },
      listQueryOccurrences: async () => {
        occurrenceReadCount += 1;
        return [
          outcomeOccurrence("qry_old_completion", "2026-06-01T00:00:00.000Z"),
          outcomeOccurrence("qry_recent_completion", "2026-06-29T00:00:00.000Z")
        ];
      },
      listSafeActivityAtomsSince: async (startedAt: string) => {
        activityStarts.push(startedAt);
        return [];
      },
      upsertProductionRuns: async (runs: ProductionRunV1[]) => {
        const byId = new Map(persistedRuns.map((run) => [run.runId, run]));
        runs.forEach((run) => byId.set(run.runId, run));
        persistedRuns = [...byId.values()];
      }
    } as unknown as AgentStorageClient;
    const service = new ProductionUsageService(
      storage,
      () => new Date("2026-06-30T00:00:00.000Z")
    );

    const rebuilt = await service.rebuild("agent_usage_owner");
    expect(rebuilt).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run_existing_12345678" }),
      expect.objectContaining({
        runId: "run_recent_completion",
        startedAt: "2026-04-02T00:00:00.000Z",
        endedAt: "2026-06-29T00:00:00.000Z",
        completionOutcome: "failure"
      })
    ]));
    expect(rebuilt.map((run) => run.runId)).not.toContain("run_old_completion");
    expect(usageStarts).toEqual(["2026-06-23T00:00:00.000Z"]);
    expect(occurrenceReadCount).toBe(1);
    expect(activityStarts).toEqual(["2026-06-23T00:00:00.000Z"]);
    expect(persistedRuns).toHaveLength(2);
  });

  it("projects one completed query family without waiting for a global rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-terminal-family-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_terminal_family",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-terminal-family-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_terminal_family",
      sourceId: "source_terminal_family",
      provider: "codex",
      runtime: "codex",
      signal: "traces",
      profileVersion: "codex-terminal-family-v1",
      resourceCount: 1,
      recordCount: 5,
      observedAt: "2026-06-08T00:00:03.000Z",
      queryOccurrences: [{
        schemaVersion: 1,
        queryId: "qry_terminal_root",
        sessionId: "ses_terminal_root",
        lifecycleVisibility: "customer",
        provider: "codex",
        runtime: "codex",
        startedAt: "2026-06-08T00:00:01.000Z",
        completedAt: "2026-06-08T00:00:03.000Z",
        completionEvidence: "stop_hook",
        repositoryKey: "repo_terminal_family",
        promptState: "disabled",
        evidence: "submission_hook"
      }, {
        schemaVersion: 1,
        queryId: "qry_terminal_child",
        sessionId: "ses_terminal_child",
        lifecycleVisibility: "customer",
        provider: "codex",
        runtime: "codex",
        startedAt: "2026-06-08T00:00:02.000Z",
        completedAt: "2026-06-08T00:00:02.500Z",
        completionEvidence: "provider_completed_event",
        repositoryKey: "repo_terminal_family",
        promptState: "disabled",
        evidence: "submission_hook"
      }],
      usageAtoms: [{
        schemaVersion: 1,
        atomId: "atom_terminal_root",
        correlationId: "qry_terminal_root",
        queryId: "qry_terminal_root",
        sessionId: "ses_terminal_root",
        provider: "codex",
        runtime: "codex",
        authority: "request",
        model: "gpt-5.5",
        inputTokens: 10,
        outputTokens: 2,
        startedAt: "2026-06-08T00:00:01.000Z",
        endedAt: "2026-06-08T00:00:02.900Z"
      }, {
        schemaVersion: 1,
        atomId: "atom_terminal_child",
        correlationId: "qry_terminal_child",
        queryId: "qry_terminal_child",
        sessionId: "ses_terminal_child",
        provider: "codex",
        runtime: "codex",
        authority: "turn",
        model: "gpt-5.5",
        inputTokens: 5,
        outputTokens: 1,
        startedAt: "2026-06-08T00:00:02.000Z",
        endedAt: "2026-06-08T00:00:02.500Z"
      }],
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "activity_terminal_subagent",
        queryId: "qry_terminal_root",
        sessionId: "ses_terminal_root",
        childSessionId: "ses_terminal_child",
        provider: "codex",
        runtime: "codex",
        kind: "subagent",
        name: "explorer",
        outcome: "success",
        startedAt: "2026-06-08T00:00:02.000Z",
        endedAt: "2026-06-08T00:00:02.500Z"
      }]
    });
    const service = new ProductionUsageService(storage, () => new Date("2026-06-08T00:00:04.000Z"));
    await service.startCleanEpoch("2026-06-08T00:00:00.000Z");

    expect(await service.projectCompletedQuery("agent_full_owner", "qry_terminal_root")).toEqual([
      expect.objectContaining({
        queryId: "qry_terminal_root",
        inputTokens: 15,
        outputTokens: 3,
        totalTokens: 18,
        breakdown: expect.arrayContaining([
          expect.objectContaining({ kind: "subagent", name: "explorer", totalTokens: 6 })
        ])
      })
    ]);
    expect(await storage.listProductionRuns()).toEqual([
      expect.objectContaining({ queryId: "qry_terminal_root", totalTokens: 18 })
    ]);
    await storage.close();
  });

  it("keeps late observations on the provider-side durable completion boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-completion-boundary-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-07-12T15:11:40.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_claude_completion_boundary",
      sourceKind: "otlp-http-json",
      provider: "claude-code",
      runtime: "claude-code",
      environmentId: metadata.environmentId,
      profileVersion: "claude-code-completion-boundary-v1",
      granularity: ["request"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-07-12T15:11:40.000Z");
    await storage.beginProductionUsageEpoch("2026-07-12T15:11:40.000Z");
    const queryId = "qry_claude_completion_boundary";
    const sessionId = "ses_claude_completion_boundary";
    const completedAt = "2026-07-12T15:12:10.000Z";
    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_claude_completion_boundary_initial",
      sourceId: "source_claude_completion_boundary",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-completion-boundary-v1",
      resourceCount: 1,
      recordCount: 3,
      observedAt: completedAt,
      queryOccurrences: [{
        schemaVersion: 1,
        queryId,
        sessionId,
        lifecycleVisibility: "customer",
        provider: "claude-code",
        runtime: "claude-code",
        startedAt: "2026-07-12T15:11:42.000Z",
        completedAt,
        completionEvidence: "stop_hook",
        completionOutcome: "success",
        promptState: "disabled",
        evidence: "submission_hook"
      }],
      usageAtoms: [{
        schemaVersion: 1,
        atomId: "atom_claude_completion_boundary_initial",
        correlationId: queryId,
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        model: "claude-sonnet-5",
        inputTokens: 538,
        outputTokens: 9_525,
        startedAt: "2026-07-12T15:11:43.000Z",
        endedAt: "2026-07-12T15:12:00.000Z"
      }],
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "activity_claude_completion_boundary_initial",
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "tool",
        name: "Bash",
        outcome: "success",
        startedAt: "2026-07-12T15:11:44.000Z",
        endedAt: "2026-07-12T15:11:45.000Z"
      }]
    });
    const service = new ProductionUsageService(storage, () => new Date("2026-07-12T15:15:20.000Z"));
    expect(await service.projectCompletedQuery("agent_full_owner", queryId)).toEqual([
      expect.objectContaining({ totalTokens: 10_063, endedAt: completedAt, toolCallCount: 1 })
    ]);

    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_claude_completion_boundary_post_completion",
      sourceId: "source_claude_completion_boundary",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-completion-boundary-v1",
      resourceCount: 1,
      recordCount: 2,
      observedAt: "2026-07-12T15:15:12.000Z",
      usageAtoms: [{
        schemaVersion: 1,
        atomId: "atom_claude_completion_boundary_away_summary",
        correlationId: queryId,
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        model: "claude-sonnet-5",
        inputTokens: 94,
        outputTokens: 90,
        startedAt: "2026-07-12T15:15:11.000Z",
        endedAt: "2026-07-12T15:15:12.000Z"
      }],
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "activity_claude_completion_boundary_away_summary",
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "tool",
        name: "away_summary",
        outcome: "success",
        startedAt: "2026-07-12T15:15:11.000Z",
        endedAt: "2026-07-12T15:15:12.000Z"
      }]
    });
    const afterAuxiliary = await service.projectCompletedQuery("agent_full_owner", queryId);
    expect(afterAuxiliary).toEqual([
      expect.objectContaining({ totalTokens: 10_063, endedAt: completedAt, toolCallCount: 1 })
    ]);
    expect(JSON.stringify(afterAuxiliary)).not.toContain("away_summary");

    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_claude_completion_boundary_late_precompletion",
      sourceId: "source_claude_completion_boundary",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-completion-boundary-v1",
      resourceCount: 1,
      recordCount: 2,
      observedAt: "2026-07-12T15:15:13.000Z",
      usageAtoms: [{
        schemaVersion: 1,
        atomId: "atom_claude_completion_boundary_late_precompletion",
        correlationId: queryId,
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        model: "claude-sonnet-5",
        inputTokens: 7,
        outputTokens: 3,
        startedAt: "2026-07-12T15:12:09.000Z",
        endedAt: "2026-07-12T15:12:11.000Z"
      }],
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "activity_claude_completion_boundary_late_precompletion",
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "tool",
        name: "late_precompletion_tool",
        outcome: "success",
        startedAt: "2026-07-12T15:12:09.000Z",
        endedAt: "2026-07-12T15:12:11.000Z"
      }]
    });
    const enriched = await service.projectCompletedQuery("agent_full_owner", queryId);
    expect(enriched).toEqual([expect.objectContaining({
      inputTokens: 545,
      outputTokens: 9_528,
      totalTokens: 10_073,
      endedAt: completedAt,
      toolCallCount: 2,
      breakdown: expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "late_precompletion_tool" })
      ])
    })]);
    expect(await storage.listProductionRuns()).toEqual([
      expect.objectContaining({ totalTokens: 10_073, endedAt: completedAt, toolCallCount: 2 })
    ]);
    await storage.close();
  });

  it("recovers failed zero-usage terminals from the durable occurrence ledger after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-failed-occurrence-recovery-"));
    roots.push(root);
    const databasePath = join(root, "agent.db");
    const storage = new AgentStorageClient({ databasePath });
    const metadata = await storage.initialize({
      now: "2026-07-12T06:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "hook_claude_code_lifecycle",
      sourceKind: "provider-hook",
      provider: "claude-code",
      runtime: "claude-code",
      environmentId: metadata.environmentId,
      profileVersion: "claude-code-hooks-v1",
      granularity: ["turn"],
      tokenDimensions: [],
      billingEvidence: [],
      durability: "at_least_once",
      contentRisk: "metadata_only",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-07-12T06:00:00.000Z");
    await storage.beginProductionUsageEpoch("2026-07-12T06:00:00.000Z");
    const failedOccurrence = (
      queryId: string,
      sessionId: string,
      completedAt: string,
      startedAt = "2026-07-12T06:00:00.100Z"
    ) => ({
      schemaVersion: 1 as const,
      queryId,
      sessionId,
      lifecycleVisibility: "customer" as const,
      provider: "claude-code" as const,
      runtime: "claude-code",
      startedAt,
      completedAt,
      completionEvidence: "stop_hook" as const,
      completionOutcome: "failure" as const,
      completionFailureCategory: "authentication_failed" as const,
      repositoryKey: "repo_claude_failure_recovery",
      promptState: "disabled" as const,
      evidence: "submission_hook" as const
    });
    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_claude_failure_recovery",
      sourceId: "hook_claude_code_lifecycle",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-hooks-v1",
      resourceCount: 1,
      recordCount: 5,
      observedAt: "2026-07-12T06:00:02.000Z",
      queryOccurrences: [
        failedOccurrence("qry_claude_failure_project", "ses_claude_failure_project", "2026-07-12T06:00:01.000Z"),
        failedOccurrence("qry_claude_failure_rebuild", "ses_claude_failure_rebuild", "2026-07-12T06:00:02.000Z"),
        failedOccurrence(
          "qry_claude_pre_epoch_failure",
          "ses_claude_pre_epoch_failure",
          "2026-07-12T05:59:59.500Z",
          "2026-07-12T05:59:59.000Z"
        ),
        {
          ...failedOccurrence("qry_claude_ordinary_stop", "ses_claude_ordinary_stop", "2026-07-12T06:00:01.500Z"),
          completionOutcome: undefined,
          completionFailureCategory: undefined
        },
        {
          ...failedOccurrence("qry_claude_incomplete", "ses_claude_incomplete", "2026-07-12T06:00:01.750Z"),
          completedAt: undefined,
          completionEvidence: undefined,
          completionOutcome: undefined,
          completionFailureCategory: undefined
        }
      ],
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "activity_claude_failure_recovery",
        queryId: "qry_claude_failure_project",
        sessionId: "ses_claude_failure_project",
        provider: "claude-code",
        runtime: "claude-code",
        kind: "tool",
        name: "Bash",
        outcome: "failure",
        startedAt: "2026-07-12T06:00:00.200Z",
        endedAt: "2026-07-12T06:00:00.300Z"
      }],
      usageAtoms: []
    });
    await storage.close();

    const reopened = new AgentStorageClient({ databasePath });
    await reopened.initialize({
      now: "2026-07-12T06:00:03.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const restarted = new ProductionUsageService(
      reopened,
      () => new Date("2026-07-12T06:00:03.000Z")
    );
    const projectedFailure = await restarted.projectCompletedQuery(
      "agent_full_owner",
      "qry_claude_failure_project"
    );
    expect(projectedFailure).toEqual([expect.objectContaining({
        runId: "run_claude_failure_project",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        completionEvidence: "stop_hook",
        completionOutcome: "failure",
        costEstimateBasis: "unavailable",
        costCoverage: "unavailable",
        breakdown: [expect.objectContaining({ kind: "tool", failureCount: 1 })]
      })]);
    expect(projectedFailure[0].model).toBeUndefined();
    expect(await restarted.rebuild("agent_full_owner")).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run_claude_failure_project", completionOutcome: "failure" }),
      expect.objectContaining({ runId: "run_claude_failure_rebuild", completionOutcome: "failure" })
    ]));
    expect(await reopened.listProductionRuns()).toHaveLength(2);
    expect((await reopened.listProductionRuns()).map((run) => run.runId)).not.toContain("run_claude_ordinary_stop");
    expect((await reopened.listProductionRuns()).map((run) => run.runId)).not.toContain("run_claude_incomplete");
    expect((await reopened.listProductionRuns()).map((run) => run.runId)).not.toContain("run_claude_pre_epoch_failure");
    await restarted.clear("agent_full_owner", "2026-07-12T06:00:04.000Z");
    expect(await restarted.rebuild("agent_full_owner")).toEqual([]);
    await reopened.close();
  });

  it("keeps incomplete usage out of the durable ledger, totals, and completed-run queries", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-current-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_usage_owner", protocolVersion: "1.0" });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-otlp-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation(observation("current", "2026-06-08T00:00:01.000Z", false));
    const service = new ProductionUsageService(storage);
    await service.startCleanEpoch("2026-06-08T00:00:00.000Z");
    expect(await service.rebuild("agent_usage_owner")).toEqual([]);
    expect(await service.currentRuns("agent_usage_owner")).toEqual([
      expect.objectContaining({ runId: "run_current_12345678", endedAt: undefined })
    ]);
    expect(await service.totals("agent_usage_owner")).toMatchObject({ runCount: 0, totalTokens: 0 });
    expect(await storage.listProductionRuns()).toEqual([]);
    await storage.close();
  });

  it("applies agent-owned completed-run retention without retaining old product facts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-production-retention-"));
    roots.push(root);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({ now: "2026-06-08T00:00:00.000Z", ownershipState: "agent_usage_owner", protocolVersion: "1.0" });
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-otlp-v1",
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: [],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2025-01-01T00:00:00.000Z");
    await storage.appendSafeObservation(observation("old", "2025-01-01T00:00:00.000Z"));
    await storage.appendSafeObservation(observation("new", "2026-06-08T00:00:00.000Z"));
    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "observation_old_outcome_only_12345678",
      sourceId: "source_12345678",
      provider: "codex",
      runtime: "codex",
      signal: "logs",
      profileVersion: "codex-otlp-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: "2025-06-01T00:00:01.000Z",
      queryOccurrences: [{
        schemaVersion: 1,
        queryId: "qry_old_outcome_only",
        sessionId: "ses_old_outcome_only",
        lifecycleVisibility: "customer",
        provider: "codex",
        runtime: "codex",
        startedAt: "2025-06-01T00:00:00.000Z",
        completedAt: "2025-06-01T00:00:01.000Z",
        completionEvidence: "stop_hook",
        completionOutcome: "failure",
        promptState: "disabled",
        evidence: "submission_hook"
      }],
      usageAtoms: []
    });
    const service = new ProductionUsageService(storage);
    await service.startCleanEpoch("2025-01-01T00:00:00.000Z");
    expect(await service.rebuild("agent_usage_owner")).toHaveLength(3);
    const epochBeforeRetention = await storage.productionUsageEpoch();
    expect(await service.applyRetention("agent_usage_owner", 180, new Date("2026-06-08T00:00:00.000Z")))
      .toEqual([expect.objectContaining({ runId: "run_new_12345678" })]);
    const epochAfterRetention = await storage.productionUsageEpoch();
    expect(epochAfterRetention?.epochId).toBe(epochBeforeRetention?.epochId);
    expect(Date.parse(epochAfterRetention!.startedAt)).toBe(
      Date.parse("2026-06-08T00:00:00.000Z") - 180 * 24 * 60 * 60 * 1000
    );
    expect(await service.rebuild("agent_usage_owner")).toEqual([
      expect.objectContaining({ runId: "run_new_12345678" })
    ]);
    expect((await storage.listProductionRuns()).map((run) => run.runId)).not.toContain("run_old_outcome_only");
    expect(await service.totals("agent_usage_owner")).toMatchObject({ runCount: 1, totalTokens: 15 });
    await storage.close();
  });
});

function observation(id: string, observedAt: string, completed = true) {
  return {
    schemaVersion: 1 as const,
    observationId: `observation_${id}_12345678`,
    sourceId: "source_12345678",
    provider: "codex" as const,
    runtime: "codex",
    signal: "traces" as const,
    profileVersion: "codex-otlp-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    usageAtoms: [{
      schemaVersion: 1 as const,
      atomId: `atom_${id}_12345678`,
      correlationId: `cor_${id}_12345678`,
      provider: "codex" as const,
      runtime: "codex",
      authority: "turn" as const,
      model: "gpt-5.4",
      inputTokens: 10,
      outputTokens: 5,
      startedAt: observedAt,
      endedAt: completed ? observedAt : undefined
    }]
  };
}

function productionRun(id: string, startedAt: string): ProductionRunV1 {
  return {
    schemaVersion: 1,
    production: true,
    runId: `run_${id}_12345678`,
    correlationId: `cor_${id}_12345678`,
    provider: "codex",
    runtime: "codex",
    model: "gpt-5.4",
    authority: "turn",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 15,
    estimatedNanoUsd: 0,
    pricingVersion: "test",
    billingContext: "unknown",
    costCoverage: "none",
    evidenceGrade: "estimated_usage_cost_unattributed",
    startedAt,
    endedAt: startedAt,
    warnings: []
  };
}
