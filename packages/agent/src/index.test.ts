import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime, restorePreUpgradeBackup } from "./index";
import { ExternalWebhookDispatchService } from "./externalWebhookDispatch";
import { AgentVerifiedAttributionService } from "./productionRunAttribution";
import { OTLP_BODY_LIMIT_BYTES } from "./otlpIngress";
import { AgentStorageClient } from "@tirion/agent-storage";
import { OTLP_MAX_RECORDS } from "@tirion/engine";
import type { AgentPaths } from "@tirion/platform";

const agents: AgentRuntime[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.stop()));
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("agent runtime control and client gateway", () => {
  it("starts without VS Code and exposes isolated status", async () => {
    const agent = await startAgent();
    const response = await call(agent.socketPath(), "GET", "/v1/status");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ health: "healthy", ownershipState: "agent_shadow" });
    const ownership = await call(agent.socketPath(), "GET", "/v1/ownership", undefined, agent.bootstrapCredential());
    expect(ownership.body).toMatchObject({
      state: "agent_shadow",
      owners: {
        run_ledger: "agent",
        safe_observation_journal: "agent",
        commit_attribution_ledger: "agent"
      }
    });
    const readiness = await call(agent.socketPath(), "GET", "/v1/ownership/readiness", undefined, agent.bootstrapCredential());
    expect(readiness.body).toMatchObject({
      current: "agent_shadow",
      transitions: expect.arrayContaining([
        expect.objectContaining({
          target: "agent_usage_owner",
          ready: false,
          reasonCodes: expect.arrayContaining(["legacy_engine_observation_window_active"])
        })
      ])
    });
    const rejected = await call(agent.socketPath(), "POST", "/v1/ownership/transition", { target: "agent_usage_owner" }, agent.bootstrapCredential());
    expect(rejected).toMatchObject({ status: 409, body: { error: "unsupported_capability" } });
  });

  it("moves to a clean agent-owned usage epoch only after the drain gate passes", async () => {
    let now = new Date("2026-06-08T00:00:00.000Z");
    const paths = testPaths();
    const agent = new AgentRuntime({ paths, otlpPort: 0, now: () => now, initialOwnershipState: "agent_shadow" });
    agents.push(agent);
    await agent.start();
    now = new Date("2026-06-08T00:01:00.000Z");
    const readiness = await call(agent.socketPath(), "GET", "/v1/ownership/readiness", undefined, agent.bootstrapCredential());
    expect(readiness.body).toMatchObject({
      transitions: expect.arrayContaining([
        expect.objectContaining({
          target: "agent_usage_owner",
          ready: true,
          reasonCodes: ["production_usage_pipeline_ready", "extension_usage_consumer_ready", "legacy_engine_drained"]
        })
      ])
    });
    const transitioned = await call(agent.socketPath(), "POST", "/v1/ownership/transition", {
      target: "agent_usage_owner"
    }, agent.bootstrapCredential());
    expect(transitioned).toMatchObject({ status: 200, body: { state: "agent_usage_owner" } });
    expect(JSON.parse(readFileSync(paths.ownershipMarkerPath, "utf8"))).toMatchObject({ state: "agent_usage_owner" });
    expect(await call(agent.socketPath(), "GET", "/v1/runs", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { production: true, runs: [] } });
    expect(await call(agent.socketPath(), "POST", "/v1/legacy-engine-lease/heartbeat", {
      schemaVersion: 1,
      sessionId: "legacy_1234567890abcdef"
    })).toMatchObject({ status: 409, body: { error: "ownership_conflict" } });
    const fullReadiness = await call(agent.socketPath(), "GET", "/v1/ownership/readiness", undefined, agent.bootstrapCredential());
    expect(fullReadiness.body).toMatchObject({
      transitions: expect.arrayContaining([
        expect.objectContaining({
          target: "agent_full_owner",
          ready: true,
          reasonCodes: ["repository_attribution_ready", "extension_engine_removed"]
        })
      ])
    });
    expect(await call(agent.socketPath(), "POST", "/v1/ownership/transition", {
      target: "agent_full_owner"
    }, agent.bootstrapCredential())).toMatchObject({ status: 200, body: { state: "agent_full_owner" } });
    expect(JSON.parse(readFileSync(paths.ownershipMarkerPath, "utf8"))).toMatchObject({ state: "agent_full_owner" });
  });

  it("hosts bounded verified-attribution queries when a proven full-owner installation restarts", async () => {
    const paths = testPaths();
    const storage = new AgentStorageClient({ databasePath: paths.databasePath });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_shadow",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:01.000Z");
    await storage.transitionOwnership({
      expected: "agent_shadow",
      next: "agent_full_owner",
      now: "2026-06-08T00:00:02.000Z"
    });
    await storage.close();
    const agent = new AgentRuntime({ paths, otlpPort: 0 });
    agents.push(agent);
    await agent.start();
    expect(await call(agent.socketPath(), "GET", "/v1/attributions", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { schemaVersion: 1, attributions: [] } });
    expect(await call(agent.socketPath(), "GET", "/v1/ownership", undefined, agent.bootstrapCredential()))
      .toMatchObject({ body: { state: "agent_full_owner", owners: { commit_attribution_ledger: "agent" } } });
  });

  it("becomes operational while background runtime warmup is still running", async () => {
    const paths = testPaths();
    const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_usage_owner" });
    agents.push(agent);
    (agent as any).performRuntimeWarmup = async () => {
      await new Promise(() => undefined);
    };
    await agent.start();

    expect(await call(agent.socketPath(), "GET", "/v1/status", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          health: "healthy",
          ownershipState: "agent_usage_owner",
          runtimeWarmupState: "starting"
        }
      });
    expect(await call(agent.socketPath(), "GET", "/v1/doctor", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          facts: {
            runtimeWarmupState: "starting"
          }
        }
      });
  });

  it("keeps doctor responsive while construct diagnostics refresh is still running", async () => {
    const agent = await startAgent();
    let refreshStarted = false;
    let releaseRefresh: (() => void) | undefined;
    (agent as any).refreshConstructStates = async () => {
      refreshStarted = true;
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
    };

    const response = call(agent.socketPath(), "GET", "/v1/doctor", undefined, agent.bootstrapCredential());
    const result = await Promise.race([
      response,
      wait(200).then(() => "timed_out" as const)
    ]);
    releaseRefresh?.();

    expect(result).not.toBe("timed_out");
    expect(refreshStarted).toBe(true);
    expect(result).toMatchObject({
      status: 200,
      body: {
        facts: {
          runtimeWarmupState: expect.any(String)
        }
      }
    });
  });

  it("becomes operational while verified attribution starts in the background", async () => {
    const originalStart = AgentVerifiedAttributionService.prototype.start;
    AgentVerifiedAttributionService.prototype.start = async function (): Promise<void> {
      await new Promise(() => undefined);
    };
    try {
      const paths = testPaths();
      const storage = new AgentStorageClient({ databasePath: paths.databasePath });
      await storage.initialize({
        now: "2026-06-08T00:00:00.000Z",
        ownershipState: "agent_full_owner",
        protocolVersion: "1.0"
      });
      await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
      await storage.close();

      const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_full_owner" });
      agents.push(agent);
      await agent.start();

      expect(await call(agent.socketPath(), "GET", "/v1/status", undefined, agent.bootstrapCredential()))
        .toMatchObject({
          status: 200,
          body: {
            health: "healthy",
            ownershipState: "agent_full_owner"
          }
        });
      await waitUntil(async () => {
        const status = await call(agent.socketPath(), "GET", "/v1/status", undefined, agent.bootstrapCredential());
        return status.body.runtimeWarmupState === "ready";
      });
    } finally {
      AgentVerifiedAttributionService.prototype.start = originalStart;
    }
  });

  it("keeps full-owner control surfaces available while historical reconciliation remains deferred", async () => {
    const paths = testPaths();
    const storage = new AgentStorageClient({ databasePath: paths.databasePath });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    await storage.close();

    const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_full_owner" });
    agents.push(agent);
    await agent.start();

    expect(await call(agent.socketPath(), "GET", "/v1/status", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          health: "healthy",
          ownershipState: "agent_full_owner",
          fullOwnerBootstrapState: "deferred",
          historicalReconciliationState: "deferred"
        }
      });
    expect(await call(agent.socketPath(), "GET", "/v1/doctor", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          facts: {
            fullOwnerBootstrapState: "deferred",
            historicalReconciliationState: "deferred"
          }
        }
      });
  });

  it("runs historical reconciliation only when explicitly requested", async () => {
    const paths = testPaths();
    const storage = new AgentStorageClient({ databasePath: paths.databasePath });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    await storage.close();

    const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_full_owner" });
    agents.push(agent);
    let reconciled = false;
    (agent as any).reconcileHistoricalFullOwnerState = async () => {
      reconciled = true;
    };
    await agent.start();

    expect(reconciled).toBe(false);
    expect(await call(agent.socketPath(), "POST", "/v1/attributions/reconcile", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          schemaVersion: 1,
          state: "ready",
          liveFirst: true,
          historicalSecond: true
        }
      });
    expect(reconciled).toBe(true);
  });

  it("reconciles commit webhooks when verified attribution changes after durable writes", async () => {
    const originalOnDidChange = AgentVerifiedAttributionService.prototype.onDidChange;
    const originalReconcileCommitEvents = ExternalWebhookDispatchService.prototype.reconcileCommitEvents;
    const handlers = new Set<(change: { kind: "allocation_changed" | "history_rewrite" | "candidate_changed"; commitHash?: string; queryId?: string }) => void>();
    const reconciledCommits: Array<string | undefined> = [];

    AgentVerifiedAttributionService.prototype.onDidChange = function (handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    };
    ExternalWebhookDispatchService.prototype.reconcileCommitEvents = async function (commitHash?: string) {
      reconciledCommits.push(commitHash);
    };
    try {
      const paths = testPaths();
      const storage = new AgentStorageClient({ databasePath: paths.databasePath });
      await storage.initialize({
        now: "2026-06-08T00:00:00.000Z",
        ownershipState: "agent_full_owner",
        protocolVersion: "1.0"
      });
      await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
      await storage.close();

      const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_full_owner" });
      agents.push(agent);
      await agent.start();

      const baselineCalls = reconciledCommits.length;

      handlers.forEach((handler) => handler({ kind: "candidate_changed", commitHash: "commit_skip" }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(reconciledCommits).toHaveLength(baselineCalls);

      handlers.forEach((handler) => handler({ kind: "allocation_changed", commitHash: "commit_live" }));
      await waitUntil(() => reconciledCommits.length === baselineCalls + 1);
      expect(reconciledCommits.at(-1)).toBe("commit_live");
    } finally {
      AgentVerifiedAttributionService.prototype.onDidChange = originalOnDidChange;
      ExternalWebhookDispatchService.prototype.reconcileCommitEvents = originalReconcileCommitEvents;
    }
  });

  it("offers already-processed completed runs to webhook dispatch on full-owner rebuilds", async () => {
    const originalObserveIncremental = AgentVerifiedAttributionService.prototype.observeCompletedRunsIncrementally;
    const originalObserveCompletedRuns = ExternalWebhookDispatchService.prototype.observeCompletedRuns;
    const originalReconcileCommitEvents = ExternalWebhookDispatchService.prototype.reconcileCommitEvents;
    const dispatchedRunBatches: string[][] = [];
    let completedRunsObserved = false;
    let reconciledAfterCompletedRuns = false;

    AgentVerifiedAttributionService.prototype.observeCompletedRunsIncrementally = async function () {
      return { processedCount: 0, deferredCount: 0, processedRuns: [] };
    };
    ExternalWebhookDispatchService.prototype.observeCompletedRuns = async function (runs) {
      completedRunsObserved = true;
      dispatchedRunBatches.push(runs.map((run) => run.runId));
    };
    ExternalWebhookDispatchService.prototype.reconcileCommitEvents = async function () {
      if (completedRunsObserved) {
        reconciledAfterCompletedRuns = true;
      }
    };
    try {
      const paths = testPaths();
      const storage = new AgentStorageClient({ databasePath: paths.databasePath });
      await storage.initialize({
        now: "2026-06-08T00:00:00.000Z",
        ownershipState: "agent_full_owner",
        protocolVersion: "1.0"
      });
      await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
      await storage.replaceProductionRuns([{
        schemaVersion: 1,
        production: true,
        runId: "run_already_processed",
        correlationId: "qry_already_processed",
        queryId: "qry_already_processed",
        sessionId: "ses_already_processed",
        promptState: "disabled",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "turn",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 15,
        billingContext: "anthropic-direct",
        costCoverage: "unavailable",
        evidenceGrade: "estimated_usage_cost_unattributed",
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:01.000Z",
        warnings: []
      }]);
      await storage.close();

      const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_full_owner" });
      agents.push(agent);
      await agent.start();
      await (agent as unknown as { rebuildUsageProducts: () => Promise<unknown> }).rebuildUsageProducts();

      expect(dispatchedRunBatches).toContainEqual(["run_already_processed"]);
      expect(reconciledAfterCompletedRuns).toBe(true);
    } finally {
      AgentVerifiedAttributionService.prototype.observeCompletedRunsIncrementally = originalObserveIncremental;
      ExternalWebhookDispatchService.prototype.observeCompletedRuns = originalObserveCompletedRuns;
      ExternalWebhookDispatchService.prototype.reconcileCommitEvents = originalReconcileCommitEvents;
    }
  });

  it("offers completed lifecycle webhooks before attribution settling completes", async () => {
    const originalObserveIncremental = AgentVerifiedAttributionService.prototype.observeCompletedRunsIncrementally;
    const originalObserveCompletedRuns = ExternalWebhookDispatchService.prototype.observeCompletedRuns;
    const dispatchedRunBatches: string[][] = [];
    let releaseAttribution!: () => void;
    const attributionSettling = new Promise<void>((resolve) => {
      releaseAttribution = resolve;
    });
    let attributionStarted = false;

    AgentVerifiedAttributionService.prototype.observeCompletedRunsIncrementally = async function () {
      attributionStarted = true;
      await attributionSettling;
      return { processedCount: 1, deferredCount: 0, processedRuns: [] };
    };
    ExternalWebhookDispatchService.prototype.observeCompletedRuns = async function (runs) {
      dispatchedRunBatches.push(runs.map((run) => run.runId));
    };
    try {
      const paths = testPaths();
      const storage = new AgentStorageClient({ databasePath: paths.databasePath });
      await storage.initialize({
        now: "2026-06-08T00:00:00.000Z",
        ownershipState: "agent_full_owner",
        protocolVersion: "1.0"
      });
      await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
      await storage.replaceProductionRuns([{
        schemaVersion: 1,
        production: true,
        runId: "run_webhook_before_settling",
        correlationId: "qry_webhook_before_settling",
        queryId: "qry_webhook_before_settling",
        sessionId: "ses_webhook_before_settling",
        promptState: "disabled",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "turn",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 15,
        billingContext: "anthropic-direct",
        costCoverage: "unavailable",
        evidenceGrade: "estimated_usage_cost_unattributed",
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:01.000Z",
        warnings: []
      }]);
      await storage.close();

      const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_full_owner" });
      agents.push(agent);
      await agent.start();
      const rebuild = (agent as unknown as { rebuildUsageProducts: () => Promise<unknown> }).rebuildUsageProducts();

      await waitUntil(() =>
        attributionStarted
        && dispatchedRunBatches.some((batch) => batch.includes("run_webhook_before_settling"))
      );
      releaseAttribution();
      await rebuild;
    } finally {
      releaseAttribution?.();
      AgentVerifiedAttributionService.prototype.observeCompletedRunsIncrementally = originalObserveIncremental;
      ExternalWebhookDispatchService.prototype.observeCompletedRuns = originalObserveCompletedRuns;
    }
  });

  it("reconciles commit webhooks after incremental verified attribution processes completed runs", async () => {
    const originalObserveIncremental = AgentVerifiedAttributionService.prototype.observeCompletedRunsIncrementally;
    const originalReconcileCommitEvents = ExternalWebhookDispatchService.prototype.reconcileCommitEvents;
    let reconcileCalls = 0;

    AgentVerifiedAttributionService.prototype.observeCompletedRunsIncrementally = async function () {
      return { processedCount: 1, deferredCount: 0, processedRuns: [] };
    };
    ExternalWebhookDispatchService.prototype.reconcileCommitEvents = async function () {
      reconcileCalls += 1;
    };
    try {
      const paths = testPaths();
      const storage = new AgentStorageClient({ databasePath: paths.databasePath });
      await storage.initialize({
        now: "2026-06-08T00:00:00.000Z",
        ownershipState: "agent_full_owner",
        protocolVersion: "1.0"
      });
      await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
      await storage.replaceProductionRuns([{
        schemaVersion: 1,
        production: true,
        runId: "run_incremental_commit_webhook",
        correlationId: "qry_incremental_commit_webhook",
        queryId: "qry_incremental_commit_webhook",
        sessionId: "ses_incremental_commit_webhook",
        promptState: "disabled",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "turn",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 15,
        billingContext: "anthropic-direct",
        costCoverage: "unavailable",
        evidenceGrade: "estimated_usage_cost_unattributed",
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:01.000Z",
        warnings: []
      }]);
      await storage.close();

      const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_full_owner" });
      agents.push(agent);
      await agent.start();
      const baselineCalls = reconcileCalls;
      await (agent as unknown as { rebuildUsageProducts: () => Promise<unknown> }).rebuildUsageProducts();

      expect(reconcileCalls).toBeGreaterThan(baselineCalls);
    } finally {
      AgentVerifiedAttributionService.prototype.observeCompletedRunsIncrementally = originalObserveIncremental;
      ExternalWebhookDispatchService.prototype.reconcileCommitEvents = originalReconcileCommitEvents;
    }
  });

  it("reprojects lifecycle webhooks when workspace evidence binds after completed runs were delivered", async () => {
    const originalOnWorkspaceEvidenceBound = AgentVerifiedAttributionService.prototype.onWorkspaceEvidenceBound;
    const originalObserveCompletedRuns = ExternalWebhookDispatchService.prototype.observeCompletedRuns;
    const originalReconcileCommitEvents = ExternalWebhookDispatchService.prototype.reconcileCommitEvents;
    const handlers = new Set<() => Promise<void>>();
    const dispatchedRunBatches: string[][] = [];
    let reconcileCalls = 0;

    AgentVerifiedAttributionService.prototype.onWorkspaceEvidenceBound = function (handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    };
    ExternalWebhookDispatchService.prototype.observeCompletedRuns = async function (runs) {
      dispatchedRunBatches.push(runs.map((run) => run.runId));
    };
    ExternalWebhookDispatchService.prototype.reconcileCommitEvents = async function () {
      reconcileCalls += 1;
    };
    try {
      const paths = testPaths();
      const storage = new AgentStorageClient({ databasePath: paths.databasePath });
      await storage.initialize({
        now: "2026-06-08T00:00:00.000Z",
        ownershipState: "agent_full_owner",
        protocolVersion: "1.0"
      });
      await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
      await storage.replaceProductionRuns([{
        schemaVersion: 1,
        production: true,
        runId: "run_late_evidence_webhook",
        correlationId: "qry_late_evidence_webhook",
        queryId: "qry_late_evidence_webhook",
        sessionId: "ses_late_evidence_webhook",
        promptState: "disabled",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "turn",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 15,
        billingContext: "anthropic-direct",
        costCoverage: "unavailable",
        evidenceGrade: "estimated_usage_cost_unattributed",
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:01.000Z",
        warnings: []
      }]);
      await storage.close();

      const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_full_owner" });
      agents.push(agent);
      await agent.start();
      const baselineDispatches = dispatchedRunBatches.length;
      const baselineReconciles = reconcileCalls;

      for (const handler of handlers) {
        await handler();
      }

      await waitUntil(() =>
        dispatchedRunBatches.length > baselineDispatches
        && reconcileCalls > baselineReconciles
      );
      expect(dispatchedRunBatches.at(-1)).toContain("run_late_evidence_webhook");
    } finally {
      AgentVerifiedAttributionService.prototype.onWorkspaceEvidenceBound = originalOnWorkspaceEvidenceBound;
      ExternalWebhookDispatchService.prototype.observeCompletedRuns = originalObserveCompletedRuns;
      ExternalWebhookDispatchService.prototype.reconcileCommitEvents = originalReconcileCommitEvents;
    }
  });

  it("exposes faithful execution trees from agent-owned execution evidence", async () => {
    const paths = testPaths();
    const storage = new AgentStorageClient({ databasePath: paths.databasePath });
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_usage_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    await storage.replaceProductionRuns([{
      schemaVersion: 1,
      production: true,
      runId: "run_12345678",
      correlationId: "qry_12345678",
      queryId: "qry_12345678",
      sessionId: "ses_12345678",
      promptState: "captured",
      promptText: "Open README",
      provider: "codex",
      runtime: "codex",
      authority: "turn",
      inputTokens: 5,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 7,
      billingContext: "openai-direct",
      costCoverage: "unavailable",
      evidenceGrade: "estimated_usage_cost_unattributed",
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:01.000Z",
      warnings: []
    }]);
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "node_root",
      sortAt: "2026-06-08T00:00:00.100Z",
      value: {
        schemaVersion: 1,
        nodeId: "node_root",
        queryId: "qry_12345678",
        sessionId: "ses_12345678",
        provider: "codex",
        runtime: "codex",
        nodeKind: "llm_request",
        name: "turn",
        parentNodeId: "node_prompt_12345678",
        outcome: "success",
        startedAt: "2026-06-08T00:00:00.100Z"
      }
    });
    await storage.close();

    const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_usage_owner" });
    agents.push(agent);
    await agent.start();
    expect(await call(agent.socketPath(), "GET", "/v1/execution/runs", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: { schemaVersion: 1, runs: [expect.objectContaining({ runId: "run_12345678", contentVisibility: "full" })] }
      });
    expect(await call(agent.socketPath(), "GET", "/v1/execution/runs/run_12345678/tree", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          schemaVersion: 1,
          run: expect.objectContaining({ runId: "run_12345678" }),
          tree: {
            rootNodeKey: "node_prompt_12345678",
            nodes: expect.arrayContaining([
              expect.objectContaining({ nodeKey: "node_prompt_12345678", nodeKind: "prompt" }),
              expect.objectContaining({ nodeKey: "node_root", parentNodeKey: "node_prompt_12345678" })
            ])
          }
        }
      });
  });

  it("keeps usage ownership transition closed while a legacy engine lease is active", async () => {
    const agent = await startAgent();
    const lease = await call(agent.socketPath(), "POST", "/v1/legacy-engine-lease/heartbeat", {
      schemaVersion: 1,
      sessionId: "legacy_1234567890abcdef"
    });
    expect(lease).toMatchObject({ status: 200, body: { sessionId: "legacy_1234567890abcdef" } });
    const readiness = await call(agent.socketPath(), "GET", "/v1/ownership/readiness", undefined, agent.bootstrapCredential());
    expect(readiness.body).toMatchObject({
      transitions: expect.arrayContaining([
        expect.objectContaining({
          target: "agent_usage_owner",
          reasonCodes: expect.arrayContaining(["legacy_engine_lease_active"])
        })
      ])
    });
    expect(await call(agent.socketPath(), "POST", "/v1/legacy-engine-lease/release", {
      schemaVersion: 1,
      sessionId: "legacy_1234567890abcdef"
    })).toMatchObject({ status: 200, body: { released: true } });
  });

  it("configures supported providers through an agent-owned path without returning locators", async () => {
    const paths = testPaths();
    const sourceRoot = mkdtempSync(join(tmpdir(), "tirion-agent-source-config-"));
    roots.push(sourceRoot);
    const agent = new AgentRuntime({
      paths,
      otlpPort: 0,
      initialOwnershipState: "agent_shadow",
      sourceConfigurationPaths: {
        claudeSettingsPath: join(sourceRoot, "claude", "settings.json"),
        codexConfigPath: join(sourceRoot, "codex", "config.toml"),
        restoreStatePath: join(paths.stateDir, "source-configuration-restore.json"),
        codexHookRelayPath: join(paths.stateDir, "codex-hook-relay.cjs"),
        cursorHooksPath: join(sourceRoot, "cursor", "hooks.json"),
        cursorHookRelayPath: join(paths.stateDir, "cursor-hook-relay.cjs")
      }
    });
    agents.push(agent);
    await agent.start();
    const result = await call(agent.socketPath(), "POST", "/v1/configure/codex", undefined, agent.bootstrapCredential());
    expect(result).toMatchObject({
      status: 200,
      body: { provider: "codex", status: "configured", promptCaptureEnabled: false, restartRequired: true }
    });
    expect(JSON.stringify(result.body)).not.toContain(sourceRoot);
    const restored = await call(agent.socketPath(), "POST", "/v1/configure/codex/restore", undefined, agent.bootstrapCredential());
    expect(restored).toMatchObject({
      status: 200,
      body: { provider: "codex", status: "restored", restartRequired: true }
    });

    const cursor = await call(agent.socketPath(), "POST", "/v1/configure/cursor", undefined, agent.bootstrapCredential());
    expect(cursor).toMatchObject({
      status: 200,
      body: { provider: "cursor", status: "configured", promptCaptureEnabled: false, restartRequired: true }
    });
    expect(JSON.stringify(cursor.body)).not.toContain(sourceRoot);
    const restoredCursor = await call(agent.socketPath(), "POST", "/v1/configure/cursor/restore", undefined, agent.bootstrapCredential());
    expect(restoredCursor).toMatchObject({
      status: 200,
      body: { provider: "cursor", status: "restored", restartRequired: true }
    });

    const disabled = await call(agent.socketPath(), "POST", "/v1/configure/claude-code", {
      capturePrompts: false
    }, agent.bootstrapCredential());
    expect(disabled).toMatchObject({
      status: 200,
      body: { provider: "claude-code", status: "configured", promptCaptureEnabled: false }
    });
  });

  it("accepts only an environment-local approved Copilot source registration", async () => {
    const agent = await startAgent();
    const status = (await call(agent.socketPath(), "GET", "/v1/status")).body;
    const logsRegistration = {
      schemaVersion: 1,
      sourceId: "otlp_github_copilot_logs",
      sourceKind: "otlp-http-json",
      provider: "github-copilot",
      runtime: "github-copilot",
      environmentId: status.environmentId,
      profileVersion: "copilot-otlp-logs-v1",
      granularity: ["prompt"],
      tokenDimensions: ["input", "output", "cache_read_input", "cache_creation_input", "total"],
      billingEvidence: ["copilot_context"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    };
    const tracesRegistration = {
      ...logsRegistration,
      sourceId: "otlp_github_copilot_traces",
      profileVersion: "copilot-otlp-traces-v1",
      granularity: ["run", "turn"],
      tokenDimensions: ["input", "output", "cache_read_input", "cache_creation_input", "reasoning_output", "total"]
    };
    expect(await call(agent.socketPath(), "POST", "/v1/sources/register", logsRegistration, agent.bootstrapCredential()))
      .toMatchObject({ status: 201, body: { sourceId: "otlp_github_copilot_logs" } });
    expect(await call(agent.socketPath(), "POST", "/v1/sources/register", tracesRegistration, agent.bootstrapCredential()))
      .toMatchObject({ status: 201, body: { sourceId: "otlp_github_copilot_traces" } });
    expect(await call(agent.socketPath(), "POST", "/v1/sources/register", {
      ...logsRegistration,
      environmentId: "environment_other"
    }, agent.bootstrapCredential())).toMatchObject({ status: 409, body: { error: "unsupported_capability" } });
  });

  it("enrolls and controls encrypted repository scopes without echoing locators", async () => {
    const agent = await startAgent();
    const repository = mkdtempSync(join(tmpdir(), "tirion-agent-enrolled-repo-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    const added = await call(agent.socketPath(), "POST", "/v1/repositories", {
      schemaVersion: 1,
      path: repository,
      kind: "repository"
    }, agent.bootstrapCredential());
    expect(added).toMatchObject({ status: 201, body: { kind: "repository", state: "active" } });
    expect(JSON.stringify(added.body)).not.toContain(repository);
    const scopeId = String(added.body.scopeId);
    expect(await call(agent.socketPath(), "POST", `/v1/repositories/${scopeId}/pause`, undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { state: "paused" } });
    expect(await call(agent.socketPath(), "GET", "/v1/repositories", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { scopes: [expect.objectContaining({ scopeId, state: "paused" })] } });
    expect(await call(agent.socketPath(), "GET", `/v1/repositories/${scopeId}`, undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { health: "paused", scope: { scopeId }, reasonCodes: ["scope_paused"] } });
    expect(await call(agent.socketPath(), "DELETE", `/v1/repositories/${scopeId}`, undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { removed: true } });
  });

  it("activates repository measurement through a single agent-owned route", async () => {
    const paths = testPaths();
    const sourceRoot = mkdtempSync(join(tmpdir(), "tirion-agent-activation-source-"));
    roots.push(sourceRoot);
    const agent = new AgentRuntime({
      paths,
      otlpPort: 0,
      initialOwnershipState: "agent_shadow",
      sourceConfigurationPaths: {
        claudeSettingsPath: join(sourceRoot, "claude", "settings.json"),
        codexConfigPath: join(sourceRoot, "codex", "config.toml"),
        restoreStatePath: join(paths.stateDir, "source-configuration-restore.json"),
        codexHookRelayPath: join(paths.stateDir, "codex-hook-relay.cjs"),
        cursorHooksPath: join(sourceRoot, "cursor", "hooks.json"),
        cursorHookRelayPath: join(paths.stateDir, "cursor-hook-relay.cjs")
      }
    });
    agents.push(agent);
    await agent.start();
    const repository = mkdtempSync(join(tmpdir(), "tirion-agent-activate-repo-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    const activated = await call(agent.socketPath(), "POST", "/v1/repositories/activate", {
      path: repository,
      provider: "codex"
    }, agent.bootstrapCredential());
    expect(activated).toMatchObject({
      status: 200,
      body: {
        activationState: "ready",
          provider: "codex",
          repositoryScope: { kind: "repository", state: "active" },
          sourceStatus: {
            provider: "codex",
          configurationState: "configured",
          ownershipState: "managed_current",
          logsEnabled: true,
          tracesEnabled: true
        }
      }
    });
    expect(activated.body.repositoryScope).not.toHaveProperty("provider");
  });

  it("activates GitHub Copilot repositories through configured span DB telemetry", async () => {
    const paths = testPaths();
    const agent = new AgentRuntime({
      paths,
      otlpPort: 0,
      initialOwnershipState: "agent_shadow"
    });
    agents.push(agent);
    await agent.start();
    const repository = mkdtempSync(join(tmpdir(), "tirion-agent-activate-copilot-repo-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    const spanDbPath = join(paths.stateDir, "agent-traces.db");

    expect(await call(agent.socketPath(), "POST", "/v1/provider-sources/github-copilot/span-db", {
      schemaVersion: 1,
      enabled: true,
      spanDbPath,
      captureContent: false,
      dbSpanExporter: true
    }, agent.bootstrapCredential())).toMatchObject({
      status: 200,
      body: {
        enabled: true,
        captureContent: false,
        dbSpanExporter: true
      }
    });

    const activated = await call(agent.socketPath(), "POST", "/v1/repositories/activate", {
      schemaVersion: 1,
      path: repository,
      provider: "github-copilot"
    }, agent.bootstrapCredential());

    expect(activated).toMatchObject({
      status: 200,
      body: {
        activationState: "ready",
        provider: "github-copilot",
        repositoryScope: { kind: "repository", state: "active" },
        sourceStatus: {
          provider: "github-copilot",
          configurationState: "configured",
          ownershipState: "managed_current",
          logsEnabled: true,
          tracesEnabled: true,
          measurementState: "awaiting_receipts"
        }
      }
    });
    expect(activated.body.repositoryScope).not.toHaveProperty("provider");
    expect(JSON.stringify(activated.body)).not.toContain(repository);
    expect(JSON.stringify(activated.body)).not.toContain(spanDbPath);
  });

  it("creates, renews, and releases non-durable workspace observation leases", async () => {
    const agent = await startAgent();
    const repository = mkdtempSync(join(tmpdir(), "tirion-agent-leased-repo-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    const created = await call(agent.socketPath(), "POST", "/v1/repository-leases", {
      schemaVersion: 1,
      path: repository
    }, agent.bootstrapCredential());
    expect(created).toMatchObject({
      status: 201,
      body: { leaseId: expect.stringMatching(/^lease_/), label: expect.any(String), expiresAt: expect.any(String) }
    });
    expect(JSON.stringify(created.body)).not.toContain(repository);
    const leaseId = String(created.body.leaseId);
    expect(await call(agent.socketPath(), "GET", "/v1/repository-leases", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { leases: [expect.objectContaining({ leaseId })] } });
    expect(await call(agent.socketPath(), "POST", `/v1/repository-leases/${leaseId}/heartbeat`, undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { leaseId } });
    expect(await call(agent.socketPath(), "DELETE", `/v1/repository-leases/${leaseId}`, undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { removed: true } });
    expect(await call(agent.socketPath(), "GET", "/v1/repository-leases", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { leases: [] } });
  });

  it("publishes a safe durable ownership marker for stopped-agent startup decisions", async () => {
    const paths = testPaths();
    const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_shadow", otlpAuthToken: false });
    agents.push(agent);
    await agent.start();
    expect(await call(agent.socketPath(), "GET", "/v1/ownership/public")).toMatchObject({
      status: 200,
      body: { schemaVersion: 1, state: "agent_shadow" }
    });
    expect(JSON.parse(readFileSync(paths.ownershipMarkerPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      state: "agent_shadow"
    });
    expect(readFileSync(paths.ownershipMarkerPath, "utf8")).not.toContain("installation");
    await agent.stop();
    expect(existsSync(paths.ownershipMarkerPath)).toBe(true);
  });

  it("fails closed when a second agent tries to own the same environment", async () => {
    const paths = testPaths();
    const first = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_shadow", otlpAuthToken: false });
    agents.push(first);
    await first.start();
    const second = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_shadow", otlpAuthToken: false });
    await expect(second.start()).rejects.toThrow("ownership_conflict");
  });

  it("pairs and revokes a scoped local client", async () => {
    const agent = await startAgent();
    const bootstrap = agent.bootstrapCredential();
    const paired = await call(agent.socketPath(), "POST", "/v1/clients/pair", {
      schemaVersion: 1,
      kind: "test",
      nonce: "nonce_12345678",
      capabilities: ["runtime:read", "runs:read"]
    }, bootstrap);
    expect(paired.status).toBe(201);
    const credential = String(paired.body.credential);
    const handshake = await call(agent.socketPath(), "POST", "/v1/handshake", {
      schemaVersion: 1,
      clientKind: "test",
      clientVersion: "0.1.0",
      protocol: { major: 1, minor: 0 },
      eventSchemaVersions: [1],
      requestedCapabilities: ["runtime:read", "runs:read"]
    }, credential);
    expect(handshake.status).toBe(200);

    const clientId = String((paired.body.client as Record<string, unknown>).clientId);
    expect((await call(agent.socketPath(), "POST", `/v1/clients/${clientId}/revoke`, undefined, bootstrap)).status).toBe(200);
    expect((await call(agent.socketPath(), "POST", "/v1/handshake", {
      schemaVersion: 1,
      clientKind: "test",
      clientVersion: "0.1.0",
      protocol: { major: 1, minor: 0 },
      eventSchemaVersions: [1],
      requestedCapabilities: ["runtime:read"]
    }, credential)).status).toBe(401);
  });

  it("fails closed on a major protocol mismatch", async () => {
    const agent = await startAgent();
    const result = await call(agent.socketPath(), "POST", "/v1/handshake", {
      schemaVersion: 1,
      clientKind: "tirionctl",
      clientVersion: "0.1.0",
      protocol: { major: 99, minor: 0 },
      eventSchemaVersions: [1],
      requestedCapabilities: ["runtime:read"]
    }, agent.bootstrapCredential());
    expect(result).toMatchObject({ status: 409, body: { error: "protocol_major_mismatch" } });
  });

  it("rejects oversized control bodies without persisting them", async () => {
    const agent = await startAgent();
    const result = await call(agent.socketPath(), "POST", "/v1/handshake", { value: "x".repeat(70_000) }, agent.bootstrapCredential());
    expect(result).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  });

  it("returns a content-free support bundle", async () => {
    const agent = await startAgent();
    const result = await call(agent.socketPath(), "GET", "/v1/support-bundle", undefined, agent.bootstrapCredential());
    expect(result.status).toBe(200);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(agent.socketPath());
    expect(serialized).not.toContain("bootstrap");
    expect(serialized).not.toContain("installationId");
    expect(serialized).not.toContain("environmentId");
  });

  it("returns authenticated privacy-safe operational doctor facts", async () => {
    const agent = await startAgent();
    expect(await call(agent.socketPath(), "GET", "/v1/doctor"))
      .toMatchObject({ status: 403, body: { error: "authorization_denied" } });
    expect(await call(agent.socketPath(), "GET", "/v1/doctor", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          databaseIntegrity: "ok",
          checks: {
            singleOwner: true,
            storageWorker: true,
            protocolCompatible: true,
            privateStateDirectory: true,
            privateControlSocket: true
          },
          facts: {
            sourceCount: 0,
            repositoryScopeCount: 0,
            workspaceLeaseCount: 0
          }
        }
      });
  });

  it("returns bounded typed diagnostic logs without reading the raw log file", async () => {
    const agent = await startAgent();
    const result = await call(agent.socketPath(), "GET", "/v1/logs?limit=1", undefined, agent.bootstrapCredential());
    expect(result).toMatchObject({
      status: 200,
      body: {
        schemaVersion: 1,
        events: [expect.objectContaining({ code: "runtime_started", severity: "info" })]
      }
    });
    expect(JSON.stringify(result.body)).not.toContain(agent.socketPath());
  });

  it("streams bounded client-safe live events over the control socket", async () => {
    const agent = await startAgent();
    const event = await firstEvent(agent.socketPath(), agent.bootstrapCredential());
    expect(event).toMatchObject({
      schemaVersion: 1,
      sequence: 1,
      kind: "health_changed"
    });
    expect(JSON.stringify(event)).not.toContain(agent.socketPath());
  });

  it("creates and restores an agent-owned pre-upgrade database backup", async () => {
    const paths = testPaths();
    const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_shadow" });
    agents.push(agent);
    await agent.start();
    const prepared = await call(
      agent.socketPath(),
      "POST",
      "/v1/maintenance/prepare-upgrade",
      undefined,
      agent.bootstrapCredential()
    );
    expect(prepared).toMatchObject({
      status: 200,
      body: { backupAvailable: true, databaseSchemaVersion: 9 }
    });
    expect(await call(
      agent.socketPath(),
      "GET",
      "/v1/maintenance/rollback-info",
      undefined,
      agent.bootstrapCredential()
    )).toMatchObject({
      status: 200,
      body: { backupAvailable: true, agentVersion: "0.1.6", databaseSchemaVersion: 9 }
    });
    expect(JSON.stringify(prepared.body)).not.toContain(paths.stateDir);
    await agent.stop();
    agents.splice(agents.indexOf(agent), 1);
    writeFileSync(paths.databasePath, "corrupt replacement");
    restorePreUpgradeBackup(paths);
    const storage = new AgentStorageClient({ databasePath: paths.databasePath });
    expect(await storage.integrityCheck()).toBe("ok");
    expect((await storage.metadata()).ownershipState).toBe("agent_shadow");
    await storage.close();
  });

  it("durably acknowledges only privacy-safe Claude Code OTLP metadata", async () => {
    const paths = testPaths();
    const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_shadow", otlpAuthToken: false });
    agents.push(agent);
    await agent.start();
    const secret = "never-persist-this-prompt";
    const result = await callOtlp(agent.otlpAddress()!.port, "/v1/traces", {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeSpans: [{ spans: [{
          traceId: "claude-trace-sensitive",
          spanId: "claude-request-sensitive",
          name: "claude.request",
          attributes: [
            { key: "prompt.id", value: { stringValue: "claude-prompt-sensitive" } },
            { key: "session.id", value: { stringValue: "claude-session-sensitive" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4.6" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "20" } },
            { key: "prompt", value: { stringValue: secret } }
          ]
        }, {
          traceId: "claude-trace-sensitive",
          spanId: "claude-model-sensitive",
          name: "chat",
          attributes: [
            { key: "prompt.id", value: { stringValue: "claude-prompt-sensitive" } },
            { key: "session.id", value: { stringValue: "claude-session-sensitive" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4.6" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "20" } }
          ]
        }] }]
      }]
    });
    expect(result.status).toBe(200);
    const sources = await call(agent.socketPath(), "GET", "/v1/sources", undefined, agent.bootstrapCredential());
    expect(sources.status).toBe(200);
    expect(JSON.stringify(sources.body)).toContain("claude-code");
    expect(await call(agent.socketPath(), "GET", "/v1/sources/otlp_claude_code_traces/test", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          sourceId: "otlp_claude_code_traces",
          registered: true,
          environmentMatch: true,
          runtimeObserved: true,
          lastObservedAt: expect.any(String),
          compatibility: "supported"
        }
      });
    const totals = await call(agent.socketPath(), "GET", "/v1/shadow/totals", undefined, agent.bootstrapCredential());
    expect(totals.body).toMatchObject({
      shadow: true,
      runCount: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      pricedRunCount: 0,
      unpricedRunCount: 1
    });
    const runs = await call(agent.socketPath(), "GET", "/v1/shadow/runs", undefined, agent.bootstrapCredential());
    expect(runs.body.runs).toEqual([
      expect.objectContaining({
        authority: "request",
        billingContext: "unknown",
        warnings: ["lower_authority_overlap_discarded", "billing_context_unavailable"]
      })
    ]);
    const safeSurfaces = await Promise.all([
      call(agent.socketPath(), "GET", "/v1/logs", undefined, agent.bootstrapCredential()),
      call(agent.socketPath(), "GET", "/v1/diagnostics", undefined, agent.bootstrapCredential()),
      call(agent.socketPath(), "GET", "/v1/support-bundle", undefined, agent.bootstrapCredential()),
      call(agent.socketPath(), "GET", "/v1/shadow/export?format=json", undefined, agent.bootstrapCredential())
    ]);
    expect(JSON.stringify(safeSurfaces)).not.toContain(secret);
    for (const path of [paths.databasePath, `${paths.databasePath}-wal`]) {
      if (existsSync(path)) {
        expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
      }
    }
  });

  it("prefers Claude traces over overlapping logs while keeping provider-reported cost with prompt text disabled", async () => {
    let now = new Date("2026-06-08T00:05:00.000Z");
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_full_owner",
      otlpAuthToken: false,
      now: () => now
    });
    agents.push(agent);
    await agent.start();
    const log = (attributes: { key: string; value: Record<string, unknown> }[]) => ({
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{ attributes }] }]
      }]
    });
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", log([
      { key: "event.name", value: { stringValue: "claude_code.user_prompt" } },
      { key: "prompt.id", value: { stringValue: "claude-prompt" } },
      { key: "session.id", value: { stringValue: "claude-session" } },
      { key: "prompt", value: { stringValue: "Keep Claude reasoning tied to this run" } }
    ]), "claude-mixed-prompt")).status).toBe(200);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", log([
      { key: "event.name", value: { stringValue: "claude_code.api_request" } },
      { key: "prompt.id", value: { stringValue: "claude-prompt" } },
      { key: "session.id", value: { stringValue: "claude-session" } },
      { key: "request.id", value: { stringValue: "claude-request-1" } },
      { key: "model", value: { stringValue: "claude-sonnet-4.6" } },
      { key: "input_tokens", value: { intValue: "80" } },
      { key: "output_tokens", value: { intValue: "10" } },
      { key: "cost_usd", value: { doubleValue: 0.001 } }
    ]), "claude-mixed-log-overlap")).status).toBe(200);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", log([
      { key: "event.name", value: { stringValue: "claude_code.api_request" } },
      { key: "prompt.id", value: { stringValue: "claude-prompt" } },
      { key: "session.id", value: { stringValue: "claude-session" } },
      { key: "request.id", value: { stringValue: "claude-request-2" } },
      { key: "model", value: { stringValue: "claude-sonnet-4.6" } },
      { key: "input_tokens", value: { intValue: "40" } },
      { key: "output_tokens", value: { intValue: "8" } },
      { key: "cost_usd", value: { doubleValue: 0.002 } }
    ]), "claude-mixed-log-fallback")).status).toBe(200);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeSpans: [{ spans: [{
          traceId: "claude-trace",
          spanId: "claude-request-span",
          name: "claude.request",
          startTimeUnixNano: "1780876800000000000",
          endTimeUnixNano: "1780876801000000000",
          attributes: [
            { key: "prompt.id", value: { stringValue: "claude-prompt" } },
            { key: "session.id", value: { stringValue: "claude-session" } },
            { key: "request.id", value: { stringValue: "claude-request-1" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4.6" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "20" } },
            { key: "gen_ai.usage.reasoning.output_tokens", value: { intValue: "45" } }
          ]
        }] }]
      }]
    }, "claude-mixed-trace")).status).toBe(200);
    expect(await call(agent.socketPath(), "GET", "/v1/current-runs", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          current: true,
          runs: [expect.objectContaining({
            provider: "claude-code",
            inputTokens: 140,
            outputTokens: 28,
            reasoningOutputTokens: 45,
            totalTokens: 168,
            costEstimateBasis: "provider_reported_estimate",
            estimatedNanoUsd: 3_000_000,
            promptState: "disabled"
          })]
        }
      });
  });

  it("replays shadow atoms idempotently after restart", async () => {
    const paths = testPaths();
    const first = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_shadow", otlpAuthToken: false });
    agents.push(first);
    await first.start();
    const body = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "codex-trace",
          spanId: "codex-turn",
          name: "codex.turn",
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } }
          ]
        }] }]
      }]
    };
    expect((await callOtlp(first.otlpAddress()!.port, "/v1/traces", body, "stable-observation-id")).status).toBe(200);
    expect((await call(first.socketPath(), "GET", "/v1/shadow/totals", undefined, first.bootstrapCredential())).body).toMatchObject({ runCount: 1, totalTokens: 15 });
    await first.stop();
    agents.splice(agents.indexOf(first), 1);

    const second = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_shadow", otlpAuthToken: false });
    agents.push(second);
    await second.start();
    expect((await call(second.socketPath(), "GET", "/v1/shadow/totals", undefined, second.bootstrapCredential())).body).toMatchObject({ runCount: 1, totalTokens: 15 });
    expect((await callOtlp(second.otlpAddress()!.port, "/v1/traces", body, "stable-observation-id")).status).toBe(200);
    expect((await call(second.socketPath(), "GET", "/v1/shadow/totals", undefined, second.bootstrapCredential())).body).toMatchObject({ runCount: 1, totalTokens: 15 });
  });

  it("keeps in-flight spans out of production totals and attribution until completion", async () => {
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_full_owner",
      otlpAuthToken: false
    });
    agents.push(agent);
    await agent.start();
    const span = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "codex-current-trace",
          spanId: "codex-current-turn",
          name: "codex.turn",
          startTimeUnixNano: "1780876800000000000",
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } }
          ]
        }] }]
      }]
    };
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", span, "current-observation")).status).toBe(200);
    const current = await call(agent.socketPath(), "GET", "/v1/current-runs", undefined, agent.bootstrapCredential());
    expect(current).toMatchObject({ status: 200, body: { current: true, runs: [expect.any(Object)] } });
    expect((current.body.runs as Record<string, unknown>[])[0]).not.toHaveProperty("endedAt");
    expect(await call(agent.socketPath(), "GET", "/v1/runs", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { runs: [] } });
    expect(await call(agent.socketPath(), "GET", "/v1/totals", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { runCount: 0, totalTokens: 0 } });

    const completed = structuredClone(span);
    (completed.resourceSpans[0].scopeSpans[0].spans[0] as Record<string, unknown>).endTimeUnixNano = "1780876801000000000";
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", completed, "completed-observation")).status).toBe(200);
    expect(await call(agent.socketPath(), "GET", "/v1/current-runs", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { runs: [] } });
    expect(await call(agent.socketPath(), "GET", "/v1/runs", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { runs: [expect.objectContaining({ endedAt: "2026-06-08T00:00:01.000Z" })] } });
    expect(await call(agent.socketPath(), "GET", "/v1/totals", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { runCount: 1, totalTokens: 15 } });
  });

  it("keeps Codex run identity across exporter batches and stores the final cumulative snapshot", async () => {
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_full_owner",
      otlpAuthToken: false
    });
    agents.push(agent);
    await agent.start();
    const log = (attributes: { key: string; value: Record<string, unknown> }[]) => ({
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{ attributes }] }]
      }]
    });
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", log([
      { key: "event.name", value: { stringValue: "codex.user_prompt" } },
      { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.000Z" } },
      { key: "conversation.id", value: { stringValue: "codex-session" } },
      { key: "prompt", value: { stringValue: "Associate this Codex prompt with its run" } }
    ]), "codex-prompt")).status).toBe(200);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", log([
      { key: "event.name", value: { stringValue: "codex.sse_event" } },
      { key: "event.kind", value: { stringValue: "response.completed" } },
      { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:01.000Z" } },
      { key: "conversation.id", value: { stringValue: "codex-session" } },
      { key: "auth_mode", value: { stringValue: "Chatgpt" } },
      { key: "model", value: { stringValue: "gpt-5.5" } },
      { key: "input_token_count", value: { intValue: "100" } }
    ]), "codex-first-snapshot")).status).toBe(200);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", log([
      { key: "event.name", value: { stringValue: "codex.sse_event" } },
      { key: "event.kind", value: { stringValue: "response.completed" } },
      { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:02.000Z" } },
      { key: "conversation.id", value: { stringValue: "codex-session" } },
      { key: "auth_mode", value: { stringValue: "Chatgpt" } },
      { key: "model", value: { stringValue: "gpt-5.5" } },
      { key: "input_token_count", value: { intValue: "140" } },
      { key: "output_token_count", value: { intValue: "5" } },
      { key: "cached_token_count", value: { intValue: "40" } }
    ]), "codex-final-snapshot")).status).toBe(200);
    expect(await call(agent.socketPath(), "GET", "/v1/current-runs", undefined, agent.bootstrapCredential()))
      .toMatchObject({ status: 200, body: { runs: [] } });
    expect(await call(agent.socketPath(), "GET", "/v1/runs", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          runs: [expect.objectContaining({
            provider: "codex",
            inputTokens: 140,
            outputTokens: 5,
            cacheReadInputTokens: 40,
            totalTokens: 145,
            billingContext: "subscription",
            promptState: "disabled",
            endedAt: "2026-06-08T00:00:02.000Z"
          })]
        }
      });
  });

  it("prefers Codex traces over fallback logs while preserving reasoning tokens with prompt text disabled", async () => {
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_full_owner",
      otlpAuthToken: false
    });
    agents.push(agent);
    await agent.start();
    const log = (attributes: { key: string; value: Record<string, unknown> }[]) => ({
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeLogs: [{ logRecords: [{ attributes }] }]
      }]
    });
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", log([
      { key: "event.name", value: { stringValue: "codex.user_prompt" } },
      { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:00.000Z" } },
      { key: "conversation.id", value: { stringValue: "codex-session" } },
      { key: "prompt", value: { stringValue: "Keep trace reasoning tied to this commit" } }
    ]), "codex-mixed-prompt")).status).toBe(200);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", log([
      { key: "event.name", value: { stringValue: "codex.sse_event" } },
      { key: "event.kind", value: { stringValue: "response.completed" } },
      { key: "event.timestamp", value: { stringValue: "2026-06-08T00:00:01.000Z" } },
      { key: "conversation.id", value: { stringValue: "codex-session" } },
      { key: "auth_mode", value: { stringValue: "ApiKey" } },
      { key: "model", value: { stringValue: "gpt-5.4" } },
      { key: "input_token_count", value: { intValue: "100" } },
      { key: "output_token_count", value: { intValue: "25" } },
      { key: "reasoning_token_count", value: { intValue: "60" } }
    ]), "codex-mixed-fallback-log")).status).toBe(200);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "codex-trace",
          spanId: "codex-turn-span",
          name: "codex.turn",
          startTimeUnixNano: "1780876801000000000",
          endTimeUnixNano: "1780876802000000000",
          attributes: [
            { key: "conversation.id", value: { stringValue: "codex-session" } },
            { key: "turn.id", value: { stringValue: "codex-turn" } },
            { key: "request.id", value: { stringValue: "codex-request" } },
            { key: "auth_mode", value: { stringValue: "ApiKey" } },
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "30" } },
            { key: "gen_ai.usage.reasoning.output_tokens", value: { intValue: "80" } }
          ]
        }] }]
      }]
    }, "codex-mixed-trace")).status).toBe(200);
    expect(await call(agent.socketPath(), "GET", "/v1/runs", undefined, agent.bootstrapCredential()))
      .toMatchObject({
        status: 200,
        body: {
          runs: [expect.objectContaining({
            provider: "codex",
            inputTokens: 120,
            outputTokens: 30,
            reasoningOutputTokens: 80,
            totalTokens: 150,
            billingContext: "openai-direct",
            promptState: "disabled",
            endedAt: "2026-06-08T00:00:02.000Z"
          })]
        }
      });
  });

  it("ingests Claude provider hook tool output into the execution tree alongside OTLP run identity", async () => {
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_usage_owner",
      otlpAuthToken: false
    });
    agents.push(agent);
    await agent.start();

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1780876800000000000",
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.user_prompt" } },
            { key: "prompt.id", value: { stringValue: "claude-hook-prompt" } },
            { key: "session.id", value: { stringValue: "claude-hook-session" } },
            { key: "prompt", value: { stringValue: "Inspect the README with Claude hooks" } }
          ]
        }] }]
      }]
    }, "claude-hook-prompt")).status).toBe(200);

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/provider-hooks/claude-code", {
      hook_event_name: "PostToolUse",
      session_id: "claude-hook-session",
      tool_name: "Read",
      tool_use_id: "claude-tool-1",
      cwd: "/workspace",
      duration_ms: 25,
      tool_input: {
        file_path: "README.md",
        offset: 0,
        limit: 50
      },
      tool_response: {
        success: true,
        content: "hello from claude hook"
      }
    }, "claude-hook-tool")).status).toBe(200);

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeSpans: [{ spans: [{
          traceId: "claude-hook-trace",
          spanId: "claude-hook-request-span",
          name: "claude.request",
          startTimeUnixNano: "1780876800000000000",
          endTimeUnixNano: "1780876801000000000",
          attributes: [
            { key: "prompt.id", value: { stringValue: "claude-hook-prompt" } },
            { key: "session.id", value: { stringValue: "claude-hook-session" } },
            { key: "request.id", value: { stringValue: "claude-hook-request" } },
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4.6" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "40" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "8" } }
          ]
        }] }]
      }]
    }, "claude-hook-trace")).status).toBe(200);

    await waitUntil(async () => {
      const execution = await call(agent.socketPath(), "GET", "/v1/execution/runs", undefined, agent.bootstrapCredential());
      return Array.isArray(execution.body.runs) && execution.body.runs.length === 1;
    });

    const execution = await call(agent.socketPath(), "GET", "/v1/execution/runs", undefined, agent.bootstrapCredential());
    const runId = String((execution.body.runs as Record<string, unknown>[])[0]?.runId);
    expect(execution).toMatchObject({
      status: 200,
      body: {
        runs: [expect.objectContaining({
          provider: "claude-code",
          contentVisibility: "topology_only"
        })]
      }
    });
    const tree = await call(agent.socketPath(), "GET", `/v1/execution/runs/${runId}/tree`, undefined, agent.bootstrapCredential());
    expect(tree).toMatchObject({
      status: 200,
      body: {
        tree: {
          nodes: expect.arrayContaining([
            expect.objectContaining({ nodeKind: "prompt" }),
            expect.objectContaining({ nodeKind: "tool", toolName: "Read" })
          ])
        }
      }
    });
    expect(JSON.stringify(tree.body)).not.toContain("Inspect the README with Claude hooks");
    expect(JSON.stringify(tree.body)).not.toContain("README.md");
    expect(JSON.stringify(tree.body)).not.toContain("hello from claude hook");
    const sources = await call(agent.socketPath(), "GET", "/v1/sources", undefined, agent.bootstrapCredential());
    expect(JSON.stringify(sources.body)).toContain("hook_claude_code_tools");
    expect(JSON.stringify(sources.body)).toContain("provider-hook-http-json");
  });

  it("ingests Codex provider hooks for prompt and tool content while keeping OTLP traces authoritative for usage", async () => {
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_usage_owner",
      otlpAuthToken: false
    });
    agents.push(agent);
    await agent.start();

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/provider-hooks/codex", {
      hook_event_name: "UserPromptSubmit",
      turn_id: "codex-hook-turn",
      session_id: "codex-hook-session",
      prompt: "Search the workspace with Codex hooks"
    }, "codex-hook-prompt")).status).toBe(200);

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/provider-hooks/codex", {
      hook_event_name: "PostToolUse",
      turn_id: "codex-hook-turn",
      session_id: "codex-hook-session",
      tool_name: "grep",
      tool_use_id: "codex-tool-1",
      cwd: "/workspace",
      duration_ms: 10,
      tool_input: {
        path: "src/index.ts",
        pattern: "hook"
      },
      tool_response: {
        success: true,
        content: "src/index.ts: provider hook support"
      }
    }, "codex-hook-tool")).status).toBe(200);

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [{
          traceId: "codex-hook-trace",
          spanId: "codex-hook-turn-span",
          name: "codex.turn",
          startTimeUnixNano: "1780876801000000000",
          endTimeUnixNano: "1780876802000000000",
          attributes: [
            { key: "conversation.id", value: { stringValue: "codex-hook-session" } },
            { key: "turn.id", value: { stringValue: "codex-hook-turn" } },
            { key: "request.id", value: { stringValue: "codex-hook-request" } },
            { key: "auth_mode", value: { stringValue: "ApiKey" } },
            { key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "25" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "4" } }
          ]
        }] }]
      }]
    }, "codex-hook-trace")).status).toBe(200);

    await waitUntil(async () => {
      const execution = await call(agent.socketPath(), "GET", "/v1/execution/runs", undefined, agent.bootstrapCredential());
      return Array.isArray(execution.body.runs) && execution.body.runs.length === 1;
    });

    const runs = await call(agent.socketPath(), "GET", "/v1/runs", undefined, agent.bootstrapCredential());
    expect(runs).toMatchObject({
      status: 200,
      body: {
        runs: [expect.objectContaining({
          provider: "codex",
          inputTokens: 25,
          outputTokens: 4,
          promptState: "disabled",
          toolCallCount: 1
        })]
      }
    });
    const execution = await call(agent.socketPath(), "GET", "/v1/execution/runs", undefined, agent.bootstrapCredential());
    const runId = String((execution.body.runs as Record<string, unknown>[])[0]?.runId);
    const tree = await call(agent.socketPath(), "GET", `/v1/execution/runs/${runId}/tree`, undefined, agent.bootstrapCredential());
    expect(tree).toMatchObject({
      status: 200,
      body: {
        tree: {
          nodes: expect.arrayContaining([
            expect.objectContaining({ nodeKind: "prompt" }),
            expect.objectContaining({ nodeKind: "tool", toolName: "grep" })
          ])
        }
      }
    });
    expect(JSON.stringify(tree.body)).not.toContain("Search the workspace with Codex hooks");
    expect(JSON.stringify(tree.body)).not.toContain("src/index.ts");
    expect(JSON.stringify(tree.body)).not.toContain("provider hook support");
    const sources = await call(agent.socketPath(), "GET", "/v1/sources", undefined, agent.bootstrapCredential());
    expect(JSON.stringify(sources.body)).toContain("hook_codex_tools");
    expect(JSON.stringify(sources.body)).toContain("provider-hook-command-json");
  });

  it("ingests Cursor provider hooks as completed runs and metadata-only activity", async () => {
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_usage_owner",
      otlpAuthToken: false
    });
    agents.push(agent);
    await agent.start();

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/provider-hooks/cursor", {
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "cursor-hook-conversation",
      generation_id: "cursor-hook-generation",
      model: "claude-sonnet-4.6",
      prompt: "Open /Users/asaf/private.md"
    }, "cursor-hook-prompt")).status).toBe(200);

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/provider-hooks/cursor", {
      hook_event_name: "afterAgentResponse",
      conversation_id: "cursor-hook-conversation",
      generation_id: "cursor-hook-generation",
      model: "claude-sonnet-4.6",
      input_tokens: 44,
      output_tokens: 9,
      cache_read_tokens: 7
    }, "cursor-hook-usage")).status).toBe(200);

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/provider-hooks/cursor", {
      hook_event_name: "afterFileEdit",
      conversation_id: "cursor-hook-conversation",
      generation_id: "cursor-hook-generation",
      edit_id: "cursor-edit-1",
      file_path: "/Users/asaf/private.md",
      content: "private edit content"
    }, "cursor-hook-edit")).status).toBe(200);

    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/provider-hooks/cursor", {
      hook_event_name: "stop",
      conversation_id: "cursor-hook-conversation",
      generation_id: "cursor-stop-generation-drift"
    }, "cursor-hook-stop")).status).toBe(200);

    await waitUntil(async () => {
      const runs = await call(agent.socketPath(), "GET", "/v1/runs", undefined, agent.bootstrapCredential());
      return Array.isArray(runs.body.runs) && runs.body.runs.length === 1;
    });

    const runs = await call(agent.socketPath(), "GET", "/v1/runs", undefined, agent.bootstrapCredential());
    expect(runs).toMatchObject({
      status: 200,
      body: {
        runs: [expect.objectContaining({
          provider: "cursor",
          billingContext: "unknown",
          inputTokens: 44,
          outputTokens: 9,
          cacheReadInputTokens: 7,
          totalTokens: 53,
          promptState: "disabled",
          toolCallCount: 1,
          endedAt: expect.any(String)
        })]
      }
    });
    const execution = await call(agent.socketPath(), "GET", "/v1/execution/runs", undefined, agent.bootstrapCredential());
    const runId = String((execution.body.runs as Record<string, unknown>[])[0]?.runId);
    const tree = await call(agent.socketPath(), "GET", `/v1/execution/runs/${runId}/tree`, undefined, agent.bootstrapCredential());
    expect(tree).toMatchObject({
      status: 200,
      body: {
        tree: {
          nodes: expect.arrayContaining([
            expect.objectContaining({ nodeKind: "prompt" }),
            expect.objectContaining({ nodeKind: "tool", toolName: "file_edit" })
          ])
        }
      }
    });
    const serialized = JSON.stringify({ runs: runs.body, tree: tree.body });
    expect(serialized).not.toContain("Open /Users/asaf/private.md");
    expect(serialized).not.toContain("/Users/asaf/private.md");
    expect(serialized).not.toContain("private edit content");
    const sources = await call(agent.socketPath(), "GET", "/v1/sources", undefined, agent.bootstrapCredential());
    expect(JSON.stringify(sources.body)).toContain("hook_cursor_lifecycle");
    expect(JSON.stringify(sources.body)).toContain("hook_cursor_tools");
    expect(JSON.stringify(sources.body)).toContain("provider-hook-command-json");
  });

  it("discards prompt text at ingress when provider prompt capture is disabled", async () => {
    const paths = testPaths();
    const sourceRoot = mkdtempSync(join(tmpdir(), "tirion-agent-disabled-prompts-"));
    roots.push(sourceRoot);
    const agent = new AgentRuntime({
      paths,
      otlpPort: 0,
      initialOwnershipState: "agent_shadow",
      otlpAuthToken: false,
      sourceConfigurationPaths: {
        claudeSettingsPath: join(sourceRoot, "claude", "settings.json"),
        codexConfigPath: join(sourceRoot, "codex", "config.toml"),
        restoreStatePath: join(paths.stateDir, "source-configuration-restore.json"),
        codexHookRelayPath: join(paths.stateDir, "codex-hook-relay.cjs"),
        cursorHooksPath: join(sourceRoot, "cursor", "hooks.json"),
        cursorHookRelayPath: join(paths.stateDir, "cursor-hook-relay.cjs")
      }
    });
    agents.push(agent);
    await agent.start();
    expect(await call(agent.socketPath(), "POST", "/v1/configure/claude-code", {
      capturePrompts: false
    }, agent.bootstrapCredential())).toMatchObject({
      status: 200,
      body: { promptCaptureEnabled: false }
    });
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/logs", {
      resourceLogs: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1780876800000000000",
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.user_prompt" } },
            { key: "prompt.id", value: { stringValue: "claude-disabled-prompt" } },
            { key: "session.id", value: { stringValue: "claude-disabled-session" } },
            { key: "prompt", value: { stringValue: "must not be stored" } }
          ]
        }, {
          timeUnixNano: "1780876801000000000",
          attributes: [
            { key: "event.name", value: { stringValue: "claude_code.api_request" } },
            { key: "prompt.id", value: { stringValue: "claude-disabled-prompt" } },
            { key: "session.id", value: { stringValue: "claude-disabled-session" } },
            { key: "request.id", value: { stringValue: "claude-disabled-request" } },
            { key: "model", value: { stringValue: "claude-sonnet-4.6" } },
            { key: "input_tokens", value: { intValue: "10" } },
            { key: "output_tokens", value: { intValue: "2" } },
            { key: "cost_usd", value: { doubleValue: 0.001 } }
          ]
        }] }]
      }]
    }, "claude-disabled-observation")).status).toBe(200);
    const runs = await call(agent.socketPath(), "GET", "/v1/shadow/runs", undefined, agent.bootstrapCredential());
    expect(runs).toMatchObject({
      status: 200,
      body: { runs: [expect.objectContaining({ promptState: "disabled" })] }
    });
    expect(JSON.stringify(runs)).not.toContain("must not be stored");
  });

  it("reports safe shadow comparisons and exports", async () => {
    const agent = await startAgent();
    const comparison = await call(agent.socketPath(), "POST", "/v1/shadow/compare", {
      runCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedNanoUsd: 0
    }, agent.bootstrapCredential());
    expect(comparison.body).toMatchObject({ matches: false, reasonCodes: ["run_count_mismatch"] });
    const exported = await call(agent.socketPath(), "GET", "/v1/shadow/export?format=csv", undefined, agent.bootstrapCredential());
    expect(exported.body).toMatchObject({ shadow: true, format: "csv", count: 0 });
    const production = await call(agent.socketPath(), "GET", "/v1/runs", undefined, agent.bootstrapCredential());
    expect(production).toMatchObject({ status: 409, body: { error: "unsupported_capability" } });
  });

  it("requires the configured ingress credential for providers that support OTLP headers", async () => {
    const token = "otlp_test_credential_12345678";
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_shadow",
      otlpAuthToken: token
    });
    agents.push(agent);
    await agent.start();
    const body = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [] }]
      }]
    };
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", body)).status).toBe(401);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", body, undefined, token)).status).toBe(200);
    const diagnostics = await call(agent.socketPath(), "GET", "/v1/diagnostics", undefined, agent.bootstrapCredential());
    expect(diagnostics.body.constructStates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "TelemetryIngress",
        details: expect.objectContaining({
          acceptedReceiptCount: 1,
          rejectedRequestCount: 1,
          lastRejectedReason: "authentication_required"
        })
      }),
      expect.objectContaining({
        construct: "TelemetrySourceConfiguration"
      }),
      expect.objectContaining({
        construct: "Diagnostics",
        details: expect.objectContaining({
          logChannel: "agent.log.jsonl"
        })
      })
    ]));
    const logs = await call(agent.socketPath(), "GET", "/v1/logs", undefined, agent.bootstrapCredential());
    expect(logs.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "construct_lifecycle",
        details: expect.objectContaining({
          construct: "TelemetryIngress",
          reason: "authentication_required"
        })
      })
    ]));
  });

  it("fails closed for oversized, unknown, and disabled OTLP inputs", async () => {
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_shadow",
      otlpAuthToken: false
    });
    agents.push(agent);
    await agent.start();
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", { payload: "x".repeat(OTLP_BODY_LIMIT_BYTES + 1) })).status).toBe(413);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: Array.from({ length: OTLP_MAX_RECORDS + 1 }, () => ({})) }]
      }]
    })).status).toBe(413);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", {
      resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "unknown-runtime" } }] } }]
    })).status).toBe(422);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/unknown", { resourceMetrics: [] })).status).toBe(404);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/metrics", {
      resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeMetrics: [{ metrics: [] }]
      }]
    })).status).toBe(200);
  });

  it("rate-limits loopback OTLP requests before they can create unbounded work", async () => {
    const agent = new AgentRuntime({
      paths: testPaths(),
      otlpPort: 0,
      initialOwnershipState: "agent_shadow",
      otlpAuthToken: false,
      otlpMaxRequestsPerSecond: 1
    });
    agents.push(agent);
    await agent.start();
    const body = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex" } }] },
        scopeSpans: [{ spans: [] }]
      }]
    };
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", body)).status).toBe(200);
    expect((await callOtlp(agent.otlpAddress()!.port, "/v1/traces", body)).status).toBe(429);
  });

  it("keeps repository locators out of durable state, logs, IPC, exports, diagnostics, and publication status", async () => {
    const paths = testPaths();
    const repository = mkdtempSync(join(tmpdir(), "tirion-private-locator-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    const agent = new AgentRuntime({ paths, otlpPort: 0, initialOwnershipState: "agent_full_owner" });
    agents.push(agent);
    await agent.start();
    expect(await call(agent.socketPath(), "POST", "/v1/repositories", {
      schemaVersion: 1,
      path: repository,
      kind: "repository"
    }, agent.bootstrapCredential())).toMatchObject({ status: 201 });
    expect(await call(
      agent.socketPath(),
      "POST",
      "/v1/maintenance/prepare-upgrade",
      undefined,
      agent.bootstrapCredential()
    )).toMatchObject({ status: 200, body: { backupAvailable: true } });

    const responses = await Promise.all([
      call(agent.socketPath(), "GET", "/v1/repositories", undefined, agent.bootstrapCredential()),
      call(agent.socketPath(), "GET", "/v1/diagnostics", undefined, agent.bootstrapCredential()),
      call(agent.socketPath(), "GET", "/v1/support-bundle", undefined, agent.bootstrapCredential()),
      call(agent.socketPath(), "GET", "/v1/export?format=json", undefined, agent.bootstrapCredential()),
      call(agent.socketPath(), "GET", "/v1/attributions/export?format=json", undefined, agent.bootstrapCredential()),
      call(agent.socketPath(), "GET", "/v1/budgets", undefined, agent.bootstrapCredential()),
      call(agent.socketPath(), "GET", "/v1/logs", undefined, agent.bootstrapCredential())
    ]);
    expect(JSON.stringify(responses)).not.toContain(repository);
    expect(JSON.stringify(await firstEvent(agent.socketPath(), agent.bootstrapCredential()))).not.toContain(repository);

    for (const path of [
      paths.databasePath,
      `${paths.databasePath}-wal`,
      paths.logPath ?? join(paths.stateDir, "agent.log.jsonl"),
      paths.ownershipMarkerPath,
      paths.preUpgradeBackupPath ?? join(paths.stateDir, "pre-upgrade-agent.db")
    ]) {
      if (existsSync(path)) {
        expect(readFileSync(path).includes(Buffer.from(repository))).toBe(false);
      }
    }
  });
});

async function startAgent(): Promise<AgentRuntime> {
  const agent = new AgentRuntime({ paths: testPaths(), otlpPort: 0, initialOwnershipState: "agent_shadow" });
  agents.push(agent);
  await agent.start();
  return agent;
}

function callOtlp(port: number, path: string, body: unknown, observationId?: string, credential?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": encoded.length,
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(observationId ? { "x-tirion-observation-id": observationId } : {})
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
      }));
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

function firstEvent(socketPath: string, credential: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      method: "GET",
      path: "/v1/events",
      headers: { authorization: `Bearer ${credential}`, accept: "text/event-stream" }
    }, (response) => {
      let buffered = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffered += chunk;
        const data = buffered.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data) {
          resolve(JSON.parse(data) as Record<string, unknown>);
          response.destroy();
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function testPaths(): AgentPaths {
  const root = mkdtempSync(join(tmpdir(), "tirion-agent-"));
  roots.push(root);
  return {
    stateDir: root,
    databasePath: join(root, "agent.db"),
    lockPath: join(root, "agent.lock"),
    bootstrapTokenPath: join(root, "bootstrap.token"),
    ownershipMarkerPath: join(root, "ownership.json"),
    repositoryLocatorKeyPath: join(root, "repository-locator.key"),
    attributionHmacKeyPath: join(root, "attribution-hmac.key"),
    logPath: join(root, "agent.log.jsonl"),
    socketPath: join(root, "agent.sock")
  };
}

function call(socketPath: string, method: string, path: string, body?: unknown, credential?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const encoded = body == null ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      method,
      path,
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(encoded ? { "content-type": "application/json", "content-length": encoded.length } : {})
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
        });
      });
    });
    req.on("error", reject);
    if (encoded) {
      req.write(encoded);
    }
    req.end();
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed_out");
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
