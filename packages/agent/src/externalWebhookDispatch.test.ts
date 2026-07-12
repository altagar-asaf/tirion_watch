import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommitAttributedWebhookEventV1,
  ProductionRunV1,
  RunEndedWebhookEventV1,
  SafeObservationV1
} from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { DefaultProductionUsagePipeline } from "@tirion/engine";
import type {
  CommitAttributionSummary,
  CommitPublicationSnapshot,
  DiagnosticEvent,
  GitHubRepositoryIdentity
} from "@tirion/engine/production";
import {
  activitiesForComplexScenario,
  complexChildAgentScenarios,
  occurrencesForComplexScenario,
  sumComplexRunTokens,
  usageAtomsForComplexScenario
} from "../../../test-fixtures/complexChildAgentScenarios";
import { ExternalWebhookDispatchService } from "./externalWebhookDispatch";
import type { AgentRepositoryObservationService } from "./repositoryObservationService";
import type { AgentVerifiedAttributionService } from "./productionRunAttribution";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const storages: AgentStorageClient[] = [];
const startedServices: ExternalWebhookDispatchService[] = [];

afterEach(async () => {
  await Promise.all(startedServices.splice(0).map((service) => service.stop()));
  await Promise.all(storages.splice(0).map((storage) => storage.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("external webhook dispatch", () => {
  it("persists local webhook configuration and run enablement flag", async () => {
    const { service, root } = await testService();
    const configurationPath = join(root, "webhook-config.json");

    await service.configureUrl({ schemaVersion: 1, url: "http://127.0.0.1:4319/hooks" });
    await service.setBearerToken({ schemaVersion: 1, token: "local-token" });
    await service.setHmacSecret({ schemaVersion: 1, secret: "local-secret" });
    await service.configureSender({
      schemaVersion: 1,
      sender: {
        name: "Ada Lovelace",
        team: "Platform",
        imageUrl: "https://example.com/ada.png"
      }
    });
    await service.setRunEndedEnabled(false);

    const reloadedStorage = serviceStorage(root);
    storages.push(reloadedStorage);
    const reloaded = new ExternalWebhookDispatchService(
      reloadedStorage,
      { configurationPath },
      emptyAttribution(),
      emptyRepositories()
    );

    await expect(reloaded.status()).resolves.toMatchObject({
      schemaVersion: 1,
      url: "http://127.0.0.1:4319/hooks",
      sender: {
        name: "Ada Lovelace",
        team: "Platform",
        imageUrl: "https://example.com/ada.png"
      },
      bearerTokenConfigured: true,
      hmacSecretConfigured: true,
      runEndedEnabled: false,
      commitAttributedEnabled: true
    });
  });

  it("ignores retired persisted commit-attributed disable flags", async () => {
    const { service, root } = await testService();
    const configurationPath = join(root, "webhook-config.json");
    writeFileSync(configurationPath, `${JSON.stringify({
      schemaVersion: 1,
      url: "http://127.0.0.1:4319/hooks",
      runEndedEnabled: true,
      commitAttributedEnabled: false
    }, null, 2)}\n`);

    await expect(service.status()).resolves.toMatchObject({
      schemaVersion: 1,
      url: "http://127.0.0.1:4319/hooks",
      runEndedEnabled: true,
      commitAttributedEnabled: true
    });
  });

  it("blocks live and completed Codex lifecycle projection for a durable internal occurrence", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const { service, storage } = await testService({ recordEvent: (event) => diagnostics.push(event) });
    const internalMarker: SafeObservationV1 = {
      schemaVersion: 1,
      observationId: "obs_internal_marker",
      sourceId: "hook_codex_internal",
      provider: "codex",
      runtime: "codex",
      signal: "logs",
      profileVersion: "codex-hooks-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: "2026-06-08T00:00:01.000Z",
      queryOccurrences: [{
        schemaVersion: 1,
        queryId: "qry_internal_codex",
        sessionId: "ses_internal_codex",
        lifecycleVisibility: "internal",
        provider: "codex",
        runtime: "codex",
        startedAt: "2026-06-08T00:00:01.000Z",
        promptState: "disabled",
        evidence: "provider_prompt_id"
      }],
      usageAtoms: []
    };
    await appendDurableObservation(storage, internalMarker);
    const laterStop: SafeObservationV1 = {
      ...internalMarker,
      observationId: "obs_internal_later_stop",
      sourceId: "hook_codex_lifecycle",
      observedAt: "2026-06-08T00:00:05.000Z",
      repositoryKey: "repo_internal",
      queryOccurrences: [{
        ...internalMarker.queryOccurrences![0],
        lifecycleVisibility: "customer",
        completedAt: "2026-06-08T00:00:05.000Z",
        completionEvidence: "stop_hook",
        repositoryKey: "repo_internal",
        evidence: "submission_hook"
      }]
    };
    await appendDurableObservation(storage, laterStop);

    await service.observeSafeObservation(laterStop);
    await service.observeCompletedRuns([productionRun({
      runId: "run_internal_codex",
      queryId: "qry_internal_codex",
      correlationId: "qry_internal_codex",
      provider: "codex",
      runtime: "codex",
      inputTokens: 8_863,
      outputTokens: 52,
      totalTokens: 8_915,
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: "2026-06-08T00:00:05.000Z"
    })]);

    await expect(service.status()).resolves.toMatchObject({ queuedCount: 0, deliveredCount: 0 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      construct: "ExternalWebhookDispatch",
      operation: "projection",
      state: "blocked",
      reason: "run_lifecycle_internal_harness_session",
      runId: "run_internal_codex"
    }));
  });

  it("dispatches run-ended webhooks for watched repositories without storing prompt text or absolute paths", async () => {
    const received: Array<{ headers: IncomingMessage["headers"]; body: unknown }> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push({ headers: request.headers, body });
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const run = productionRun({
      runId: "run_changed",
      queryId: "qry_changed",
      correlationId: "trace_changed",
      provider: "codex",
      runtime: "codex",
      inputTokens: 25,
      outputTokens: 4,
      totalTokens: 29,
      estimatedNanoUsd: 122_500,
      usageValueNanoUsd: 122_500,
      costEstimateBasis: "catalog_estimate",
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: "2026-06-08T00:00:02.000Z",
      models: ["gpt-5.4"]
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_changed", "qry_changed", ["artifact_src"], "repo_tirion")]
      },
      repositories: {
        relativePaths: () => ["src/index.ts"],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      timing: { runEndedGraceMs: 1 }
    });

    await service.start();
    startedServices.push(service);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.configureSender({
      schemaVersion: 1,
      sender: {
        name: "Ada Lovelace",
        team: "Platform",
        imageUrl: "https://example.com/ada.png"
      }
    });
    await service.setBearerToken({ schemaVersion: 1, token: "local-token" });
    await service.setHmacSecret({ schemaVersion: 1, secret: "local-secret" });
    await service.observeCompletedRuns([run]);

    await waitUntil(() => received.some((item) => (item.body as { eventType?: string }).eventType === "run.ended"));
    expect(received[0]?.headers.authorization).toBe("Bearer local-token");
    expect(received[0]?.headers["x-tirion-signature-256"]).toEqual(expect.stringMatching(/^sha256=/));
    expect(received.map((item) => (item.body as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);
    const runUpdate = received.find((item) => (item.body as { eventType?: string }).eventType === "run.update");
    expect(runUpdate?.body).toMatchObject({
      schemaVersion: 1,
      eventType: "run.update",
      runId: "run_changed",
      sessionId: "ses_qry_changed",
      sender: {
        installationId: expect.stringMatching(/^ins_/),
        name: "Ada Lovelace",
        team: "Platform",
        imageUrl: "https://example.com/ada.png"
      },
      estimatedNanoUsd: 122_500,
      usageValueNanoUsd: 122_500,
      costEstimateBasis: "catalog_estimate",
      costCoverage: "complete",
      coverage: expect.objectContaining({
        costCoverage: "complete"
      })
    });
    const boundedUpdate = runUpdate?.body as {
      startedAt: string;
      updatedAt: string;
      activity: Array<{ startedAt: string; endedAt?: string }>;
    };
    expect(boundedUpdate.updatedAt).toBe("2026-06-08T00:00:02.000Z");
    expect(boundedUpdate.activity.every((item) =>
      item.startedAt >= boundedUpdate.startedAt
      && (item.endedAt ?? item.startedAt) <= boundedUpdate.updatedAt
    )).toBe(true);
    const runEnded = received.find((item) => (item.body as { eventType?: string }).eventType === "run.ended");
    expect(runEnded?.body).toMatchObject({
      schemaVersion: 1,
      eventType: "run.ended",
      runId: "run_changed",
      sessionId: "ses_qry_changed",
      traceIds: ["trace_changed"],
      sender: {
        installationId: expect.stringMatching(/^ins_/),
        name: "Ada Lovelace",
        team: "Platform",
        imageUrl: "https://example.com/ada.png"
      },
      repository: {
        repoKey: "repo_tirion",
        owner: "asafaltagar",
        name: "Tirion",
        fullName: "asafaltagar/Tirion"
      },
      llmModels: ["gpt-5.4"],
      filesChanged: ["src/index.ts"],
      estimatedNanoUsd: 122_500,
      usageValueNanoUsd: 122_500,
      costEstimateBasis: "catalog_estimate",
      state: "completed"
    });
    const payload = JSON.stringify(received.map((item) => item.body));
    expect(payload).not.toContain("promptText");
    expect(payload).not.toContain("Search the workspace");
    expect(payload).not.toContain("/Users/");
  });

  it("does not report snapshot-only files as causal run writes", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const run = productionRun({
      runId: "run_snapshot_only",
      queryId: "qry_snapshot_only",
      correlationId: "trace_snapshot_only",
      provider: "codex",
      runtime: "codex",
      inputTokens: 4,
      outputTokens: 1,
      totalTokens: 5,
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          run.runId,
          run.queryId!,
          ["artifact_observer_output"],
          "repo_tirion",
          []
        )]
      },
      repositories: {
        relativePaths: (_repoKey, artifactKeys) => artifactKeys.length > 0
          ? ["tirion-events/observer-generated.json"]
          : [],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      timing: { runEndedGraceMs: 1 }
    });

    await service.start();
    startedServices.push(service);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([run]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.ended"))
      .toMatchObject({ filesChanged: [] });
  });

  it("publishes terminal activity counts and conserves unattributed token usage", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const run: ProductionRunV1 = {
      ...productionRun({
        runId: "run_activity_integrity",
        queryId: "qry_activity_integrity",
        correlationId: "trace_activity_integrity",
        provider: "claude-code",
        runtime: "claude-code",
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:03.000Z"
      }),
      cacheReadInputTokens: 8,
      reasoningOutputTokens: 4,
      toolCallCount: 7,
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_shell_integrity",
        kind: "tool",
        name: "Shell",
        count: 3,
        failureCount: 1,
        totalDurationMs: 120,
        resultSizeBytes: 640,
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_unknown_shell_integrity",
        kind: "tool",
        name: "Bash",
        count: 1,
        failureCount: 0,
        unknownCount: 1,
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_mcp_integrity",
        kind: "mcp",
        name: "database.query",
        count: 2,
        failureCount: 2,
        totalDurationMs: 80,
        providerReportedResultTokens: 12,
        inputTokens: 20,
        outputTokens: 4,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 1,
        totalTokens: 24,
        attributionBasis: "trace_descendant",
        coverage: "complete"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_overallocated_integrity",
        kind: "subagent",
        name: "overreported",
        count: 1,
        failureCount: 0,
        inputTokens: 40,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 40,
        attributionBasis: "trace_descendant",
        coverage: "complete"
      }]
    };
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_activity_integrity",
          "qry_activity_integrity",
          [],
          "repo_integrity"
        )]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_integrity", root: "/tmp/integrity" }],
        relativePaths: () => []
      },
      recordEvent: (event) => diagnostics.push(event),
      timing: { runEndedGraceMs: 1 }
    });

    await service.start();
    startedServices.push(service);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([run]);
    expect(diagnostics.filter((event) => event.state === "blocked")).toEqual([]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    const ended = received.find((event) => (event as { eventType?: string }).eventType === "run.ended") as {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      reasoningOutputTokens: number;
      activity: Array<{
        kind: string;
        name: string;
        outcome: string;
        count: number;
        failureCount: number;
        unknownCount?: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        reasoningOutputTokens?: number;
        usageCoverage?: string;
      }>;
    };
    expect(ended.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool",
        name: "Shell",
        outcome: "unknown",
        count: 3,
        failureCount: 1,
        resultSizeBytes: 640,
        usageAttributionBasis: "activity_only",
        usageCoverage: "unavailable"
      }),
      expect.objectContaining({
        kind: "tool",
        name: "Bash",
        outcome: "unknown",
        count: 1,
        failureCount: 0,
        unknownCount: 1
      }),
      expect.objectContaining({
        kind: "mcp",
        name: "database.query",
        outcome: "failure",
        count: 2,
        failureCount: 2,
        providerReportedResultTokens: 12,
        usageAttributionBasis: "trace_descendant",
        usageCoverage: "complete"
      }),
      expect.objectContaining({
        kind: "subagent",
        name: "overreported",
        usageAttributionBasis: "activity_only",
        usageCoverage: "unavailable"
      }),
      expect.objectContaining({
        kind: "unknown",
        name: "Unallocated run usage",
        outcome: "unknown",
        inputTokens: 30,
        outputTokens: 6,
        cacheReadInputTokens: 5,
        reasoningOutputTokens: 3,
        usageAttributionBasis: "unavailable",
        usageCoverage: "partial"
      })
    ]));
    expect(ended.activity.find((item) => item.name === "overreported")).not.toHaveProperty("inputTokens");
    expect(ended.activity.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0)).toBe(ended.inputTokens);
    expect(ended.activity.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0)).toBe(ended.outputTokens);
    expect(ended.activity.reduce((sum, item) => sum + (item.cacheReadInputTokens ?? 0), 0)).toBe(ended.cacheReadInputTokens);
    expect(ended.activity.reduce((sum, item) => sum + (item.reasoningOutputTokens ?? 0), 0)).toBe(ended.reasoningOutputTokens);
  });

  it("uses the same terminal activity integrity contract across supported coding harnesses", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const providers: ProductionRunV1["provider"][] = [
      "claude-code",
      "codex",
      "cursor",
      "github-copilot"
    ];
    const runs = providers.map((provider, index) => productionRun({
      runId: `run_contract_${provider}`,
      queryId: `qry_contract_${provider}`,
      correlationId: `trace_contract_${provider}`,
      provider,
      runtime: provider,
      inputTokens: 10 + index,
      outputTokens: 2 + index,
      totalTokens: 12 + (index * 2),
      startedAt: `2026-06-08T00:00:0${index}.000Z`,
      endedAt: `2026-06-08T00:00:1${index}.000Z`
    }));
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => runs.map((run) => workEpisode(
          run.runId,
          run.queryId!,
          [],
          "repo_contract"
        ))
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_contract", root: "/tmp/contract" }],
        relativePaths: () => []
      },
      timing: { runEndedGraceMs: 1 }
    });

    await service.start();
    startedServices.push(service);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns(runs);
    await waitUntil(() => received.filter((event) =>
      (event as { eventType?: string }).eventType === "run.ended"
    ).length === providers.length);

    for (const run of runs) {
      expect(received.find((event) =>
        (event as { eventType?: string; runId?: string }).eventType === "run.ended"
        && (event as { runId?: string }).runId === run.runId
      )).toMatchObject({
        codingHarness: run.provider,
        evidence: expect.objectContaining({
          basis: "usage_projection",
          delayed: true,
          timingConfidence: "medium"
        }),
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        totalTokens: run.totalTokens,
        activity: [expect.objectContaining({
          kind: "llm_request",
          outcome: "unknown",
          count: 1,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          totalTokens: run.totalTokens,
          usageAttributionBasis: "unavailable",
          usageCoverage: "unavailable",
          evidence: expect.objectContaining({ basis: "usage_projection", delayed: true })
        })]
      });
    }
  });

  it("preserves subagent parentage while conserving terminal usage", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const run: ProductionRunV1 = {
      ...productionRun({
        runId: "run_subagent_parentage",
        queryId: "qry_subagent_parentage",
        correlationId: "trace_subagent_parentage",
        provider: "codex",
        runtime: "codex",
        inputTokens: 15,
        outputTokens: 4,
        totalTokens: 19,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:03.000Z"
      }),
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_subagent_parent",
        kind: "subagent",
        name: "explorer",
        count: 1,
        failureCount: 0,
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        attributionBasis: "unavailable",
        coverage: "partial"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_subagent_child_tool",
        parentBreakdownId: "brk_subagent_parent",
        kind: "tool",
        name: "Bash",
        count: 2,
        failureCount: 1,
        inputTokens: 7,
        outputTokens: 2,
        totalTokens: 9,
        attributionBasis: "trace_descendant",
        coverage: "complete"
      }]
    };
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(run.runId, run.queryId!, [], "repo_subagent")]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_subagent", root: "/tmp/subagent" }]
      },
      timing: { runEndedGraceMs: 1 }
    });

    await service.start();
    startedServices.push(service);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([run]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    const ended = received.find((event) => (event as { eventType?: string }).eventType === "run.ended") as {
      inputTokens: number;
      outputTokens: number;
      activity: Array<{ activityId: string; parentActivityId?: string; name: string; inputTokens?: number; outputTokens?: number }>;
    };
    const parent = ended.activity.find((activity) => activity.name === "explorer")!;
    const child = ended.activity.find((activity) => activity.name === "Bash")!;
    expect(child.parentActivityId).toBe(parent.activityId);
    expect(ended.activity.reduce((sum, activity) => sum + (activity.inputTokens ?? 0), 0)).toBe(ended.inputTokens);
    expect(ended.activity.reduce((sum, activity) => sum + (activity.outputTokens ?? 0), 0)).toBe(ended.outputTokens);
  });

  it("dispatches live run-start and run-update events from safe observations before run-ended", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_live", "qry_live", ["artifact_src"], "repo_live")]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live", root: "/tmp/live" }],
        relativePaths: () => ["src/answer.ts"]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(livePromptObservation("qry_live", "ses_live", "2026-06-08T00:00:00.000Z"));
    await waitUntil(() => received.length === 1);
    expect(received[0]).toMatchObject({
      eventType: "run.start",
      runId: "run_live",
      sessionId: "ses_live",
      repository: {
        repoKey: "repo_live",
        owner: "local",
        name: "live",
        fullName: "local/live"
      },
      evidence: expect.objectContaining({
        basis: "prompt_hook",
        delayed: false
      }),
      coverage: expect.objectContaining({
        usageCoverage: "none"
      })
    });

    await service.observeSafeObservation(livePromptObservation(
      "qry_live",
      "ses_live",
      "2026-06-07T23:59:59.994Z"
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);

    await service.observeSafeObservation(liveToolObservation("qry_live", "ses_live", "2026-06-08T00:00:01.000Z"));
    await waitUntil(() => received.length === 2);
    expect(received[1]).toMatchObject({
      eventType: "run.update",
      runId: "run_live",
      sessionId: "ses_live",
      activity: [expect.objectContaining({
        kind: "tool",
        name: "Edit"
      })],
      estimatedNanoUsd: 0,
      costEstimateBasis: "unavailable",
      costCoverage: "unavailable",
      coverage: expect.objectContaining({
        costCoverage: "unavailable"
      })
    });

    await service.observeCompletedRuns([productionRun({
      runId: "run_live",
      queryId: "qry_live",
      sessionId: "ses_live",
      correlationId: "trace_live",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-07T23:59:59.994Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    })]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    expect(received[0]).toMatchObject({ eventType: "run.start" });
    expect(received.at(-1)).toMatchObject({ eventType: "run.ended" });
    expect(received.every((event) =>
      (event as { startedAt?: string }).startedAt === "2026-06-08T00:00:00.000Z"
    )).toBe(true);
    expect(received.slice(1, -1).map((event) => (event as { eventType?: string }).eventType))
      .toEqual(expect.arrayContaining(["run.update"]));
  });

  it("wakes deferred run-ended delivery at the terminal deadline", async () => {
    const received: unknown[] = [];
    const diagnostics: DiagnosticEvent[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const endedAt = new Date(Date.now() - 50).toISOString();
    const startedAt = new Date(Date.parse(endedAt) - 500).toISOString();
    const run = productionRun({
      runId: "run_terminal_wakeup",
      queryId: "qry_terminal_wakeup",
      correlationId: "trace_terminal_wakeup",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt,
      endedAt
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_terminal_wakeup",
          "qry_terminal_wakeup",
          [],
          "repo_terminal_wakeup"
        )]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_terminal_wakeup", root: "/tmp/terminal-wakeup" }]
      },
      recordEvent: (event) => diagnostics.push(event),
      timing: { runEndedGraceMs: 40 }
    });
    await service.start();
    startedServices.push(service);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const queuedAt = Date.now();
    await service.observeCompletedRuns([run]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    await waitUntil(() => diagnostics.some((event) =>
      event.operation === "delivery"
      && event.state === "delivered"
      && event.runId === "run_terminal_wakeup"
      && event.details?.eventType === "run.ended"
    ));

    expect(Date.now() - queuedAt).toBeLessThan(1_000);
    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "delivery",
        state: "delivered",
        reason: "webhook_delivery_succeeded",
        runId: "run_terminal_wakeup",
        details: expect.objectContaining({
          eventType: "run.ended",
          queueLatencyMs: expect.any(Number),
          observationLatencyMs: expect.any(Number)
        })
      })
    ]));
  });

  it("reschedules the next durable lifecycle deadline after the earliest timer fires", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const baseTime = Date.now();
    const first = productionRun({
      runId: "run_deadline_first",
      queryId: "qry_deadline_first",
      correlationId: "trace_deadline_first",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: new Date(baseTime - 500).toISOString(),
      endedAt: new Date(baseTime).toISOString()
    });
    const second = productionRun({
      runId: "run_deadline_second",
      queryId: "qry_deadline_second",
      correlationId: "trace_deadline_second",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 20,
      outputTokens: 4,
      totalTokens: 24,
      startedAt: new Date(baseTime - 400).toISOString(),
      endedAt: new Date(baseTime + 40).toISOString()
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [
          workEpisode(first.runId, first.queryId!, ["artifact_first"], "repo_deadline"),
          workEpisode(second.runId, second.queryId!, ["artifact_second"], "repo_deadline")
        ]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_deadline", root: "/tmp/deadline" }],
        relativePaths: (_repoKey, artifactKeys) => artifactKeys.map((key) => `src/${key}.ts`)
      },
      timing: { runEndedGraceMs: 80 }
    });
    await service.start();
    startedServices.push(service);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const queuedAt = Date.now();
    await service.observeCompletedRuns([first, second]);
    await waitUntil(() => received.filter((event) =>
      (event as { eventType?: string }).eventType === "run.ended"
    ).length === 2);

    expect(Date.now() - queuedAt).toBeLessThan(1_000);
    expect(received.filter((event) => (event as { eventType?: string }).eventType === "run.ended"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: first.runId, totalTokens: 12 }),
        expect.objectContaining({ runId: second.runId, totalTokens: 24 })
      ]));
  });

  it("does not let delayed live telemetry slide the terminal deadline", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    let now = Date.parse("2026-06-08T00:00:02.020Z");
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_terminal_fixed_deadline",
          "qry_terminal_fixed_deadline",
          [],
          "repo_terminal_fixed_deadline"
        )]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_terminal_fixed_deadline", root: "/tmp/fixed-deadline" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 40 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(livePromptObservation(
      "qry_terminal_fixed_deadline",
      "ses_terminal_fixed_deadline",
      "2026-06-08T00:00:01.000Z"
    ));
    await service.observeSafeObservation(liveToolObservation(
      "qry_terminal_fixed_deadline",
      "ses_terminal_fixed_deadline",
      "2026-06-08T00:01:02.000Z"
    ));
    await service.observeCompletedRuns([productionRun({
      runId: "run_terminal_fixed_deadline",
      queryId: "qry_terminal_fixed_deadline",
      sessionId: "ses_terminal_fixed_deadline",
      correlationId: "trace_terminal_fixed_deadline",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    })]);
    expect(received.some((event) => (event as { eventType?: string }).eventType === "run.ended")).toBe(false);

    now += 21;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
  });

  it("replaces provisional settling usage before lifecycle completion is delivered", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    let now = Date.parse("2026-06-08T00:00:02.020Z");
    const provisional = productionRun({
      runId: "run_settling_authority",
      queryId: "qry_settling_authority",
      correlationId: "trace_settling_authority",
      provider: "codex",
      runtime: "codex",
      inputTokens: 60_944,
      outputTokens: 305,
      cacheReadInputTokens: 41_984,
      totalTokens: 61_249,
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const authoritative: ProductionRunV1 = {
      ...provisional,
      inputTokens: 50_792,
      totalTokens: 51_097,
      endedAt: "2026-06-08T00:00:02.009Z"
    };
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_settling_authority",
          "qry_settling_authority",
          ["artifact_src"],
          "repo_settling_authority"
        )]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_settling_authority", root: "/tmp/settling-authority" }],
        relativePaths: () => ["src/answer.ts"]
      },
      now: () => now,
      timing: { runEndedGraceMs: 40 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([provisional]);
    await service.observeCompletedRuns([authoritative]);
    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual(["run.start"]);

    now += 41;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);
    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.update"))
      .toMatchObject({ state: "settling", totalTokens: 51_097 });
    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.ended"))
      .toMatchObject({ totalTokens: 51_097 });
  });

  it("turns a hung webhook request into a bounded retryable timeout", async () => {
    let connectionCount = 0;
    const server = createServer((request) => {
      connectionCount += 1;
      request.resume();
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_timeout", root: "/tmp/timeout" }]
      },
      timing: { requestTimeoutMs: 40 }
    });
    await service.start();
    startedServices.push(service);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const attemptedAt = Date.now();
    await service.observeSafeObservation(livePromptObservation(
      "qry_timeout",
      "ses_timeout",
      new Date().toISOString()
    ));
    await waitUntil(() => connectionCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(Date.now() - attemptedAt).toBeLessThan(1_000);
    expect(connectionCount).toBe(1);
    await expect(service.status()).resolves.toMatchObject({
      queuedCount: 1,
      queuedItems: [expect.objectContaining({
        eventType: "run.start",
        deliveryState: "retry",
        attempts: 1,
        lastErrorCode: "delivery_timeout"
      })]
    });
  });

  it("prioritizes lifecycle delivery ahead of an older commit backlog", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service, storage } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_priority", root: "/tmp/priority" }]
      }
    });
    await service.test();
    const seed = (await storage.listAgentDocuments<{
      event: { eventId: string; runId: string; sender: CommitAttributedWebhookEventV1["sender"] };
    }>("webhook_outbox"))[0].value.event;
    await storage.clearAgentDocuments("webhook_outbox");
    const at = "2026-06-08T00:00:00.000Z";
    const commitSha = "a".repeat(40);
    const commitEvent: CommitAttributedWebhookEventV1 = {
      schemaVersion: 1,
      eventType: "commit.attributed",
      eventId: seed.eventId,
      sender: seed.sender,
      repository: {
        repoKey: "repo_priority",
        owner: "local",
        name: "priority",
        fullName: "local/priority"
      },
      commitSha,
      traceIds: [],
      runIds: [seed.runId],
      estimatedNanoUsd: 0,
      costCoverage: "unavailable",
      state: "active",
      version: 1,
      firstVerifiedAt: at,
      updatedAt: at
    };
    await storage.upsertAgentDocument("webhook_outbox", {
      key: commitEvent.eventId,
      sortAt: at,
      value: {
        schemaVersion: 1,
        key: commitEvent.eventId,
        event: commitEvent,
        eventType: commitEvent.eventType,
        subjectId: `repo_priority:${commitSha}`,
        payloadHash: "commit_backlog",
        deliveryState: "blocked",
        attempts: 2,
        queuedAt: at,
        lastErrorCode: "webhook_url_missing",
        createdAt: at,
        updatedAt: at
      }
    });
    await service.observeSafeObservation(livePromptObservation(
      "qry_priority",
      "ses_priority",
      "2026-06-08T00:00:01.000Z"
    ));
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    await service.retryNow();
    await waitUntil(() => received.length === 2);

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "commit.attributed"
    ]);
  });

  it("prioritizes a fresh run start ahead of updates from other runs", async () => {
    const received: Array<{ eventType?: string; runId?: string }> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as { eventType?: string; runId?: string });
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_start_priority", root: "/tmp/start-priority" }]
      }
    });
    await service.start();
    startedServices.push(service);
    const bind = (observation: SafeObservationV1): SafeObservationV1 => ({
      ...observation,
      repositoryKey: "repo_start_priority",
      queryOccurrences: observation.queryOccurrences?.map((occurrence) => ({
        ...occurrence,
        repositoryKey: "repo_start_priority"
      }))
    });
    await service.observeSafeObservation(bind(liveCodexPromptObservation(
      "qry_existing_update",
      "ses_existing_update",
      "2026-06-08T00:00:00.000Z"
    )));
    await service.observeSafeObservation(bind(liveUsageObservation({
      queryId: "qry_existing_update",
      sessionId: "ses_existing_update",
      observedAt: "2026-06-08T00:00:01.000Z",
      atomId: "atom_existing_update",
      inputTokens: 10,
      outputTokens: 2
    })));
    await service.observeSafeObservation(bind(liveCodexPromptObservation(
      "qry_new_start",
      "ses_new_start",
      "2026-06-08T00:00:02.000Z"
    )));
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    await service.retryNow();
    await waitUntil(() => received.length === 3);

    expect(received.map((event) => [event.eventType, event.runId])).toEqual([
      ["run.start", "run_existing_update"],
      ["run.start", "run_new_start"],
      ["run.update", "run_existing_update"]
    ]);
  });

  it("preserves provider metric evidence on live skill activity updates", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_metric", "qry_metric", ["artifact_src"], "repo_metric")]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_metric", root: "/tmp/metric" }],
        relativePaths: () => ["src/metric.ts"]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveCodexPromptObservation("qry_metric", "ses_metric", "2026-06-08T00:00:00.000Z"));
    await waitUntil(() => received.length === 1);

    await service.observeSafeObservation(liveCodexSkillMetricObservation("qry_metric", "ses_metric", "2026-06-08T00:00:03.000Z"));
    await waitUntil(() => received.length === 2);
    expect(received[1]).toMatchObject({
      eventType: "run.update",
      runId: "run_metric",
      sessionId: "ses_metric",
      codingHarness: "codex",
      activity: [expect.objectContaining({
        kind: "skill",
        name: "tirion-codex-stress-skill",
        evidence: expect.objectContaining({
          basis: "provider_metric",
          sourceId: "otlp_codex_metrics",
          profileVersion: "codex-otel-metrics-v1",
          identityConfidence: "medium",
          timingConfidence: "medium"
        })
      })]
    });
  });

  it("suppresses Codex OTEL prompt fragments until a hook prompt anchors the public lifecycle", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_codex", root: "/tmp/codex" }]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveCodexOtelPromptObservation("qry_codex_otel_prelude", "ses_codex", "2026-06-08T00:00:00.000Z"));
    await service.observeSafeObservation({
      ...liveToolObservation("qry_codex_otel_prelude", "ses_codex", "2026-06-08T00:00:01.000Z"),
      sourceId: "otlp_codex_traces",
      provider: "codex",
      runtime: "codex",
      signal: "traces",
      profileVersion: "codex-otel-traces-v1",
      activityAtoms: [],
      executionNodes: [{
        schemaVersion: 1,
        nodeId: "node_codex_prelude_auth",
        queryId: "qry_codex_otel_prelude",
        sessionId: "ses_codex",
        requestId: "req_codex_prelude_auth",
        provider: "codex",
        runtime: "codex",
        signal: "traces",
        nodeKind: "llm_request",
        name: "auth",
        outcome: "success",
        startedAt: "2026-06-08T00:00:01.000Z",
        endedAt: "2026-06-08T00:00:01.000Z",
        totalTokens: 0
      }]
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(0);

    await service.observeSafeObservation(liveCodexPromptObservation("qry_codex_hook_prompt", "ses_codex", "2026-06-08T00:00:03.000Z"));
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.start"));
    await service.observeSafeObservation(liveCodexSkillMetricObservation("qry_codex_child", "ses_codex", "2026-06-08T00:00:04.000Z"));
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.update"));

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual(["run.start", "run.update"]);
    expect([...new Set(received.map((event) => (event as { runId?: string }).runId))]).toEqual(["run_codex_hook_prompt"]);
    expect(JSON.stringify(received)).not.toContain("run_codex_otel_prelude");
  });

  it("uses an ingress-resolved repository key to bind live lifecycle events with multiple watched repositories", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [
          { repoKey: "repo_a", root: "/tmp/repo-a" },
          { repoKey: "repo_b", root: "/tmp/repo-b" }
        ]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation({
      ...liveCodexPromptObservation("qry_repo_bound", "ses_repo_bound", "2026-06-08T00:00:00.000Z"),
      repositoryKey: "repo_b",
      queryOccurrences: [{
        ...liveCodexPromptObservation("qry_repo_bound", "ses_repo_bound", "2026-06-08T00:00:00.000Z").queryOccurrences![0],
        repositoryKey: "repo_b"
      }]
    });
    await waitUntil(() => received.length === 1);

    expect(received[0]).toMatchObject({
      eventType: "run.start",
      runId: "run_repo_bound",
      repository: {
        repoKey: "repo_b",
        name: "repo-b"
      }
    });
  });

  it("partitions mixed live telemetry by exact lifecycle repository binding", async () => {
    const received: unknown[] = [];
    const diagnostics: DiagnosticEvent[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const repositories = [
      { repoKey: "repo_a", root: "/tmp/repo-a" },
      { repoKey: "repo_b", root: "/tmp/repo-b" }
    ];
    const { service } = await testService({
      repositories: { listRepositories: async () => repositories },
      recordEvent: (event) => diagnostics.push(event)
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    for (const [queryId, sessionId, repositoryKey] of [
      ["qry_mixed_repo_a", "ses_mixed_repo_a", "repo_a"],
      ["qry_mixed_repo_b", "ses_mixed_repo_b", "repo_b"]
    ] as const) {
      const prompt = liveCodexPromptObservation(queryId, sessionId, "2026-06-08T00:00:00.000Z");
      await service.observeSafeObservation({
        ...prompt,
        repositoryKey,
        queryOccurrences: prompt.queryOccurrences?.map((occurrence) => ({ ...occurrence, repositoryKey }))
      });
    }
    await waitUntil(() => received.filter((event) =>
      (event as { eventType?: string }).eventType === "run.start"
    ).length === 2);

    const usageA = liveUsageObservation({
      queryId: "qry_mixed_repo_a",
      sessionId: "ses_mixed_repo_a",
      observedAt: "2026-06-08T00:00:01.000Z",
      atomId: "mixed_repo_a",
      inputTokens: 11,
      outputTokens: 2
    });
    const usageB = liveUsageObservation({
      queryId: "qry_mixed_repo_b",
      sessionId: "ses_mixed_repo_b",
      observedAt: "2026-06-08T00:00:01.000Z",
      atomId: "mixed_repo_b",
      inputTokens: 23,
      outputTokens: 4
    });
    const unknownUsage = liveUsageObservation({
      queryId: "qry_mixed_unknown",
      sessionId: "ses_mixed_unknown",
      observedAt: "2026-06-08T00:00:01.000Z",
      atomId: "mixed_unknown",
      inputTokens: 10_000,
      outputTokens: 1_000
    });
    await service.observeSafeObservation({
      ...usageA,
      observationId: "obs_mixed_multi_repository_usage",
      recordCount: 3,
      usageAtoms: [usageA.usageAtoms[0], usageB.usageAtoms[0], unknownUsage.usageAtoms[0]]
    });
    await waitUntil(() => received.filter((event) =>
      (event as { eventType?: string }).eventType === "run.update"
    ).length === 2);

    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "run.update",
        runId: "run_mixed_repo_a",
        repository: expect.objectContaining({ repoKey: "repo_a" }),
        inputTokens: 11,
        outputTokens: 2
      }),
      expect.objectContaining({
        eventType: "run.update",
        runId: "run_mixed_repo_b",
        repository: expect.objectContaining({ repoKey: "repo_b" }),
        inputTokens: 23,
        outputTokens: 4
      })
    ]));
    expect(received.some((event) =>
      (event as { runId?: string }).runId === "run_mixed_unknown"
    )).toBe(false);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      construct: "ExternalWebhookDispatch",
      operation: "projection",
      state: "blocked",
      reason: "run_lifecycle_record_repository_binding_missing"
    }));
  });

  it("recovers an exact live repository binding from durable query identity after restart", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const repositories = {
      listRepositories: async () => [
        { repoKey: "repo_a", root: "/tmp/repo-a" },
        { repoKey: "repo_b", root: "/tmp/repo-b" }
      ]
    };
    const { service, storage, root } = await testService({ repositories });
    const prompt = liveCodexPromptObservation(
      "qry_durable_repo_binding",
      "ses_durable_repo_binding",
      "2026-06-08T00:00:00.000Z"
    );
    const boundPrompt: SafeObservationV1 = {
      ...prompt,
      repositoryKey: "repo_b",
      queryOccurrences: prompt.queryOccurrences?.map((occurrence) => ({
        ...occurrence,
        repositoryKey: "repo_b"
      }))
    };
    const metadata = await storage.metadata();
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: boundPrompt.sourceId,
      sourceKind: "provider-hook",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: boundPrompt.profileVersion,
      granularity: ["turn"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_not_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, "2026-06-08T00:00:00.000Z");
    await storage.appendSafeObservation(boundPrompt);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(boundPrompt);
    await waitUntil(() => received.some((event) =>
      (event as { eventType?: string }).eventType === "run.start"
    ));

    const restarted = new ExternalWebhookDispatchService(
      storage,
      { configurationPath: join(root, "webhook-config.json") },
      emptyAttribution() as AgentVerifiedAttributionService,
      { ...emptyRepositories(), ...repositories } as AgentRepositoryObservationService
    );
    await restarted.observeSafeObservation(liveUsageObservation({
      queryId: "qry_durable_repo_binding",
      sessionId: "ses_durable_repo_binding",
      observedAt: "2026-06-08T00:00:01.000Z",
      atomId: "durable_repo_binding",
      inputTokens: 31,
      outputTokens: 5
    }));
    await waitUntil(() => received.some((event) =>
      (event as { eventType?: string }).eventType === "run.update"
    ));

    expect(received.find((event) =>
      (event as { eventType?: string }).eventType === "run.update"
    )).toMatchObject({
      runId: "run_durable_repo_binding",
      repository: { repoKey: "repo_b" },
      inputTokens: 31,
      outputTokens: 5
    });
  });

  it("routes exact live identity across every supported harness with multiple watched repositories", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [
          { repoKey: "repo_a", root: "/tmp/repo-a" },
          { repoKey: "repo_b", root: "/tmp/repo-b" }
        ]
      }
    });
    const harnesses = [
      { provider: "claude-code", prompt: livePromptObservation },
      { provider: "codex", prompt: liveCodexPromptObservation },
      { provider: "cursor", prompt: liveCursorPromptObservation },
      { provider: "github-copilot", prompt: liveCopilotRootObservation }
    ] as const;

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    for (const [index, harness] of harnesses.entries()) {
      const queryId = `qry_all_harnesses_${index}`;
      const sessionId = `ses_all_harnesses_${index}`;
      const prompt = harness.prompt(queryId, sessionId, "2026-06-08T00:00:00.000Z");
      await service.observeSafeObservation({
        ...prompt,
        repositoryKey: "repo_b",
        queryOccurrences: prompt.queryOccurrences?.map((occurrence) => ({
          ...occurrence,
          repositoryKey: "repo_b"
        }))
      });
      const usage = liveUsageObservation({
        queryId,
        sessionId,
        observedAt: "2026-06-08T00:00:01.000Z",
        atomId: `all_harnesses_${index}`,
        inputTokens: 10 + index,
        outputTokens: 2 + index
      });
      await service.observeSafeObservation({
        ...usage,
        provider: harness.provider,
        runtime: harness.provider,
        usageAtoms: usage.usageAtoms.map((atom) => ({
          ...atom,
          provider: harness.provider,
          runtime: harness.provider
        }))
      });
    }
    await waitUntil(() => harnesses.every((_, index) => received.some((event) => {
      const update = event as { eventType?: string; runId?: string; inputTokens?: number };
      return update.eventType === "run.update"
        && update.runId === `run_all_harnesses_${index}`
        && update.inputTokens === 10 + index;
    })));

    for (const [index, harness] of harnesses.entries()) {
      expect(received).toContainEqual(expect.objectContaining({
        eventType: "run.update",
        runId: `run_all_harnesses_${index}`,
        codingHarness: harness.provider,
        repository: expect.objectContaining({ repoKey: "repo_b" }),
        inputTokens: 10 + index,
        outputTokens: 2 + index
      }));
    }
  });

  it("reports live context growth across multiple run-update observations for the same run", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_codex", root: "/tmp/codex-repo" }]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(livePromptObservation("qry_codex_growth", "ses_codex_growth", "2026-06-08T00:00:00.000Z"));
    await waitUntil(() => received.length === 1);

    await service.observeSafeObservation(liveUsageObservation({
      queryId: "qry_codex_growth",
      sessionId: "ses_codex_growth",
      observedAt: "2026-06-08T00:00:05.000Z",
      atomId: "atom_first",
      inputTokens: 19_368,
      outputTokens: 142,
      cacheReadInputTokens: 4_992
    }));
    await waitUntil(() => received.length === 2);
    const firstUpdate = received[1] as { eventId: string; context: Record<string, number> };
    expect(firstUpdate.context).toMatchObject({
      accumulatedInputTokens: 24_360,
      initialInputContextTokens: 24_360,
      latestInputContextTokens: 24_360,
      peakInputContextTokens: 24_360,
      observedLlmRequestCount: 1,
      contextGrowthInputTokens: 0,
      contextGrowthRatio: 1
    });

    await service.observeSafeObservation(liveUsageObservation({
      queryId: "qry_codex_growth",
      sessionId: "ses_codex_growth",
      observedAt: "2026-06-08T00:00:25.000Z",
      atomId: "atom_second",
      inputTokens: 19_574,
      outputTokens: 165,
      cacheReadInputTokens: 19_328
    }));
    await waitUntil(() => received.length === 3);
    const secondUpdate = received[2] as {
      eventId: string;
      eventType: string;
      runId: string;
      sessionId: string;
      inputTokens: number;
      cacheReadInputTokens: number;
      context: Record<string, number>;
    };
    expect(secondUpdate).toMatchObject({
      eventType: "run.update",
      runId: "run_codex_growth",
      sessionId: "ses_codex_growth",
      inputTokens: 38_942,
      cacheReadInputTokens: 24_320
    });
    expect(secondUpdate.eventId).not.toBe(firstUpdate.eventId);
    expect(secondUpdate.context).toMatchObject({
      accumulatedInputTokens: 63_262,
      initialInputContextTokens: 24_360,
      latestInputContextTokens: 38_902,
      peakInputContextTokens: 38_902,
      observedLlmRequestCount: 2,
      contextGrowthInputTokens: 14_542
    });
    expect(secondUpdate.context.contextGrowthRatio).toBeCloseTo(38_902 / 24_360, 8);
  });

  it("reconciles live Codex usage from raw authorities and excludes pre-prompt work", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_codex_authority", root: "/tmp/codex-authority" }]
      }
    });
    const queryId = "qry_codex_authority";
    const sessionId = "ses_codex_authority";

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveCodexPromptObservation(
      queryId,
      sessionId,
      "2026-06-08T00:00:01.000Z"
    ));
    await waitUntil(() => received.length === 1);

    await service.observeSafeObservation(liveUsageObservation({
      queryId,
      sessionId,
      observedAt: "2026-06-08T00:00:00.900Z",
      atomId: "atom_codex_prelude",
      inputTokens: 100,
      outputTokens: 0
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);

    await service.observeSafeObservation(liveUsageObservation({
      queryId,
      sessionId,
      observedAt: "2026-06-08T00:00:02.000Z",
      atomId: "atom_codex_response_a",
      inputTokens: 10,
      outputTokens: 2
    }));
    await waitUntil(() => received.length === 2);
    await service.observeSafeObservation(liveUsageObservation({
      queryId,
      sessionId,
      observedAt: "2026-06-08T00:00:03.000Z",
      atomId: "atom_codex_response_b",
      inputTokens: 20,
      outputTokens: 3
    }));
    await waitUntil(() => received.length === 3);

    const turn = liveUsageObservation({
      queryId,
      sessionId,
      observedAt: "2026-06-08T00:00:04.000Z",
      atomId: "atom_codex_turn",
      inputTokens: 30,
      outputTokens: 5
    });
    turn.usageAtoms[0] = {
      ...turn.usageAtoms[0],
      authority: "turn",
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:04.000Z"
    };
    await service.observeSafeObservation(turn);
    await waitUntil(() => received.length === 4);

    const updates = received.slice(1) as Array<{
      eventType: string;
      startedAt: string;
      totalTokens: number;
      activity: unknown[];
      context?: { observedLlmRequestCount?: number };
    }>;
    expect(updates.map((event) => event.totalTokens)).toEqual([12, 35, 35]);
    expect(updates.every((event) => event.eventType === "run.update")).toBe(true);
    expect(updates.every((event) => event.startedAt === "2026-06-08T00:00:01.000Z")).toBe(true);
    expect(updates.every((event) => event.activity.length === 1)).toBe(true);
    expect(updates.at(-1)?.context?.observedLlmRequestCount).toBe(1);
    expect(JSON.stringify(received)).not.toContain("req_atom_codex_prelude");
  });

  it("treats exact cross-surface event and request usage as corroboration instead of additive work", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const rootQueryId = "qry_codex_corroborated_root";
    const fragmentQueryId = "qry_codex_corroborated_fragment";
    const sessionId = "ses_codex_corroborated";
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_codex_corroborated", root: "/tmp/codex-corroborated" }]
      }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveCodexPromptObservation(
      rootQueryId,
      sessionId,
      "2026-06-08T00:00:00.000Z"
    ));
    await waitUntil(() => received.some((event) => event.eventType === "run.start"));

    const traceEvent = liveUsageObservation({
      queryId: fragmentQueryId,
      sessionId,
      observedAt: "2026-06-08T00:00:01.900Z",
      atomId: "codex_corroborated_trace_event",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 4
    });
    traceEvent.sourceId = "otlp_codex_traces";
    traceEvent.profileVersion = "codex-otel-traces-v1";
    traceEvent.usageAtoms[0] = {
      ...traceEvent.usageAtoms[0],
      authority: "event",
      signal: "traces",
      sourceId: "otlp_codex_traces",
      profileVersion: "codex-otel-traces-v1",
      startedAt: "2026-06-08T00:00:01.900Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    };
    traceEvent.executionNodes = [{
      schemaVersion: 1,
      nodeId: "node_codex_corroborated_trace_event",
      queryId: fragmentQueryId,
      sessionId,
      requestId: "req_codex_corroborated_trace_event",
      provider: "codex",
      runtime: "codex",
      signal: "traces",
      nodeKind: "llm_request",
      name: "handle_responses",
      outcome: "success",
      model: "gpt-5.5",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 4,
      startedAt: "2026-06-08T00:00:01.900Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    }];
    await service.observeSafeObservation(traceEvent);

    const logRequest = liveUsageObservation({
      queryId: rootQueryId,
      sessionId,
      observedAt: "2026-06-08T00:00:02.000Z",
      atomId: "codex_corroborated_log_request",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 4
    });
    logRequest.signal = "logs";
    logRequest.sourceId = "otlp_codex_logs";
    logRequest.profileVersion = "codex-otel-logs-v1";
    logRequest.usageAtoms[0] = {
      ...logRequest.usageAtoms[0],
      signal: "logs",
      sourceId: "otlp_codex_logs",
      profileVersion: "codex-otel-logs-v1"
    };
    await service.observeSafeObservation(logRequest);
    await waitUntil(() => received.filter((event) => event.eventType === "run.update").length >= 2);

    const updates = received.filter((event) => event.eventType === "run.update") as Array<{
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      activity: Array<{ kind: string; totalTokens?: number }>;
    }>;
    expect(updates.some((event) => event.totalTokens === 24)).toBe(false);
    expect(updates.at(-1)).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(updates.at(-1)?.activity.filter((activity) => activity.kind === "llm_request")).toHaveLength(1);
  });

  it("keeps live activity beside usage and replaces same-request token revisions", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_integrity", root: "/tmp/live-integrity" }]
      }
    });
    const queryId = "qry_live_integrity";
    const sessionId = "ses_live_integrity";

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveCodexPromptObservation(
      queryId,
      sessionId,
      "2026-06-08T00:00:00.000Z"
    ));
    await waitUntil(() => received.length === 1);

    const firstUsage = liveUsageObservation({
      queryId,
      sessionId,
      observedAt: "2026-06-08T00:00:01.000Z",
      atomId: "atom_live_revision",
      inputTokens: 10,
      outputTokens: 2
    });
    await service.observeSafeObservation({
      ...firstUsage,
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "act_live_revision_tool",
        queryId,
        sessionId,
        requestId: "req_live_revision_tool",
        provider: "codex",
        runtime: "codex",
        kind: "tool",
        name: "Bash",
        outcome: "unknown",
        resultSizeBytes: 128,
        evidenceBasis: "tool_hook",
        startedAt: "2026-06-08T00:00:00.500Z",
        endedAt: "2026-06-08T00:00:00.750Z"
      }]
    });
    await waitUntil(() => received.length === 2);
    expect(received[1]).toMatchObject({
      eventType: "run.update",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      activity: expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "Bash", count: 1, resultSizeBytes: 128 }),
        expect.objectContaining({
          kind: "llm_request",
          inputTokens: 10,
          outputTokens: 2,
          usageAttributionBasis: "provider_reported",
          usageCoverage: "complete"
        })
      ])
    });

    await service.observeSafeObservation(liveUsageObservation({
      queryId,
      sessionId,
      observedAt: "2026-06-08T00:00:02.000Z",
      atomId: "atom_live_revision",
      inputTokens: 12,
      outputTokens: 3
    }));
    await waitUntil(() => received.length === 3);
    expect(received[2]).toMatchObject({
      eventType: "run.update",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      activity: expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "Bash", count: 1 }),
        expect.objectContaining({ kind: "llm_request", inputTokens: 12, outputTokens: 3 })
      ])
    });

    await service.observeSafeObservation({
      ...firstUsage,
      observationId: "obs_live_revision_structured_outcome",
      sourceId: "hook_codex_tools",
      observedAt: "2026-06-08T00:00:03.000Z",
      usageAtoms: [],
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "act_live_revision_structured_outcome",
        queryId,
        sessionId,
        requestId: "req_live_revision_tool",
        provider: "codex",
        runtime: "codex",
        kind: "tool",
        name: "Bash",
        outcome: "failure",
        evidenceBasis: "tool_hook",
        startedAt: "2026-06-08T00:00:00.500Z",
        endedAt: "2026-06-08T00:00:00.750Z"
      }]
    });
    await waitUntil(() => received.length === 4);
    const corrected = received[3] as {
      activity: Array<{ kind: string; name: string; outcome: string; count: number; failureCount: number }>;
    };
    expect(corrected.activity.filter((activity) => activity.kind === "tool")).toEqual([
      expect.objectContaining({
        name: "Bash",
        outcome: "failure",
        count: 1,
        failureCount: 1
      })
    ]);
  });

  it("delivers explicit terminal evidence promptly across supported harnesses", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    let now = Date.parse("2026-06-08T00:00:00.000Z");
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 1_000 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const providers = [
      {
        name: "claude-code",
        prompt: livePromptObservation,
        completionEvidence: "stop_hook" as const
      },
      {
        name: "codex",
        prompt: liveCodexPromptObservation,
        completionEvidence: "stop_hook" as const
      },
      {
        name: "cursor",
        prompt: liveCursorPromptObservation,
        completionEvidence: "session_hook" as const
      },
      {
        name: "github-copilot",
        prompt: liveCopilotRootObservation,
        completionEvidence: "closed_root_span" as const
      }
    ];

    for (const [index, provider] of providers.entries()) {
      const startAt = new Date(Date.parse("2026-06-08T00:00:00.000Z") + index * 10_000).toISOString();
      const completedAt = new Date(Date.parse(startAt) + 1_000).toISOString();
      const queryId = `qry_live_terminal_${provider.name}`;
      const sessionId = `ses_live_terminal_${provider.name}`;
      now = Date.parse(startAt);
      const prompt = provider.prompt(queryId, sessionId, startAt);
      await service.observeSafeObservation(prompt);
      await waitUntil(() => received.some((event) => event.eventType === "run.start" && event.runId === `run_live_terminal_${provider.name}`));

      now = Date.parse(completedAt);
      await service.observeSafeObservation(liveCompletionObservation(prompt, completedAt, provider.completionEvidence));
      now += 1_001;
      await service.retryNow();
      await waitUntil(() => received.some((event) => event.eventType === "run.ended" && event.runId === `run_live_terminal_${provider.name}`));
    }

    const terminals = received.filter((event) => event.eventType === "run.ended") as Array<{
      runId: string;
      evidence: { basis: string; delayed: boolean };
      coverage: { usageCoverage: string };
      state: string;
    }>;
    expect(terminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run_live_terminal_claude-code", evidence: expect.objectContaining({ basis: "stop_hook", delayed: false }), coverage: expect.objectContaining({ usageCoverage: "none" }), state: "completed" }),
      expect.objectContaining({ runId: "run_live_terminal_codex", evidence: expect.objectContaining({ basis: "stop_hook", delayed: false }), coverage: expect.objectContaining({ usageCoverage: "none" }), state: "completed" }),
      expect.objectContaining({ runId: "run_live_terminal_cursor", evidence: expect.objectContaining({ basis: "session_hook", delayed: false }), coverage: expect.objectContaining({ usageCoverage: "none" }), state: "completed" }),
      expect.objectContaining({ runId: "run_live_terminal_github-copilot", evidence: expect.objectContaining({ basis: "root_span", delayed: false }), coverage: expect.objectContaining({ usageCoverage: "none" }), state: "completed" })
    ]));
  });

  it("keeps Codex child turns on one root lifecycle and ends from the closed root turn", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const rootQueryId = "qry_codex_root_turn";
    const rootSessionId = "ses_codex_root_thread";
    const childQueryId = "qry_codex_child_turn";
    const childSessionId = "ses_codex_child_thread";
    const startedAt = "2026-06-08T00:00:00.000Z";
    let now = Date.parse(startedAt);
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 1_000 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    await service.observeSafeObservation(liveCodexPromptObservation(rootQueryId, rootSessionId, startedAt));
    await waitUntil(() => received.some((event) => event.eventType === "run.start"));
    now = Date.parse("2026-06-08T00:00:00.200Z");
    await service.observeSafeObservation(liveUsageObservation({
      queryId: rootQueryId,
      sessionId: rootSessionId,
      observedAt: new Date(now).toISOString(),
      atomId: "atom_codex_root_request_a",
      inputTokens: 10,
      outputTokens: 2
    }));
    now = Date.parse("2026-06-08T00:00:00.400Z");
    await service.observeSafeObservation(liveUsageObservation({
      queryId: rootQueryId,
      sessionId: rootSessionId,
      observedAt: new Date(now).toISOString(),
      atomId: "atom_codex_root_request_b",
      inputTokens: 20,
      outputTokens: 3
    }));
    await waitUntil(() => received.some((event) =>
      event.eventType === "run.update" && event.totalTokens === 35
    ));
    now = Date.parse("2026-06-08T00:00:01.000Z");
    const childPrompt = liveCodexPromptObservation(childQueryId, childSessionId, new Date(now).toISOString());
    childPrompt.queryOccurrences = childPrompt.queryOccurrences?.map((occurrence) => ({
      ...occurrence,
      parentSessionId: rootSessionId
    }));
    await service.observeSafeObservation(childPrompt);
    now = Date.parse("2026-06-08T00:00:02.000Z");
    await service.observeSafeObservation({
      schemaVersion: 1,
      observationId: "obs_codex_subagent_start",
      sourceId: "hook_codex_lifecycle",
      provider: "codex",
      runtime: "codex",
      signal: "logs",
      profileVersion: "codex-hooks-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: new Date(now).toISOString(),
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "act_codex_subagent",
        queryId: rootQueryId,
        sessionId: rootSessionId,
        childSessionId,
        provider: "codex",
        runtime: "codex",
        kind: "subagent",
        name: "explorer",
        outcome: "unknown",
        startedAt: new Date(now).toISOString()
      }],
      usageAtoms: []
    });
    now = Date.parse("2026-06-08T00:00:03.000Z");
    await service.observeSafeObservation(liveCodexToolObservation(childQueryId, childSessionId, [{
      activityId: "act_codex_child_bash",
      name: "Bash",
      startedAt: new Date(now).toISOString()
    }], new Date(now).toISOString()));
    now = Date.parse("2026-06-08T00:00:04.000Z");
    await service.observeSafeObservation(liveClosedCodexTurnObservation({
      queryId: childQueryId,
      sessionId: childSessionId,
      observedAt: new Date(now).toISOString(),
      inputTokens: 30,
      outputTokens: 4
    }));
    await waitUntil(() => received.some((event) =>
      event.eventType === "run.update" && event.totalTokens === 69
    ));
    now += 1_001;
    await service.retryNow();
    expect(received.filter((event) => event.eventType === "run.ended")).toHaveLength(0);

    now = Date.parse("2026-06-08T00:00:06.000Z");
    await service.observeSafeObservation(liveClosedCodexTurnObservation({
      queryId: rootQueryId,
      sessionId: rootSessionId,
      observedAt: new Date(now).toISOString(),
      inputTokens: 100,
      outputTokens: 10
    }));
    now += 1_001;
    await service.retryNow();
    await waitUntil(() => received.some((event) => event.eventType === "run.ended"));

    expect(received.filter((event) => event.eventType === "run.start")).toHaveLength(1);
    expect(received.filter((event) => event.eventType === "run.start")[0]).toMatchObject({
      runId: "run_codex_root_turn",
      sessionId: rootSessionId
    });
    expect(received.find((event) => event.eventType === "run.ended")).toMatchObject({
      runId: "run_codex_root_turn",
      sessionId: rootSessionId,
      endedAt: "2026-06-08T00:00:06.000Z",
      inputTokens: 130,
      outputTokens: 14,
      totalTokens: 144,
      evidence: expect.objectContaining({ basis: "root_span" }),
      activity: expect.arrayContaining([
        expect.objectContaining({ kind: "subagent", name: "explorer", count: 1 }),
        expect.objectContaining({ kind: "tool", name: "Bash", count: 1 })
      ])
    });
  });

  it("resolves a durable linked Codex child anchor through the active root before OTLP projection", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const rootQueryId = "qry_codex_durable_child_root";
    const rootSessionId = "ses_codex_durable_child_root";
    const childQueryId = "qry_codex_durable_child";
    const childSessionId = "ses_codex_durable_child";
    const startedAt = "2026-06-08T00:00:00.000Z";
    const { service, storage } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    await service.observeSafeObservation(liveCodexPromptObservation(rootQueryId, rootSessionId, startedAt));
    await waitUntil(() => received.some((event) => event.eventType === "run.start"));
    const childPrompt = liveCodexPromptObservation(childQueryId, childSessionId, "2026-06-08T00:00:01.000Z");
    childPrompt.queryOccurrences = childPrompt.queryOccurrences?.map((occurrence) => ({
      ...occurrence,
      parentSessionId: rootSessionId
    }));
    await appendDurableObservation(storage, childPrompt);

    await service.observeSafeObservation(liveUsageObservation({
      queryId: childQueryId,
      sessionId: childSessionId,
      observedAt: "2026-06-08T00:00:02.000Z",
      atomId: "codex_durable_child_usage",
      inputTokens: 10,
      outputTokens: 2
    }));
    await waitUntil(() => received.some((event) =>
      event.eventType === "run.update" && event.totalTokens === 12
    ));

    expect(received.filter((event) => event.eventType === "run.start")).toHaveLength(1);
    expect([...new Set(received.map((event) => event.runId))]).toEqual(["run_codex_durable_child_root"]);
  });

  it("keeps provisional Codex child state private until a late parent link reparents it", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const rootQueryId = "qry_codex_late_parent_root";
    const rootSessionId = "ses_codex_late_parent_root";
    const childQueryId = "qry_codex_late_parent_child";
    const childSessionId = "ses_codex_late_parent_child";
    const startedAt = "2026-06-08T00:00:00.000Z";
    let now = Date.parse(startedAt);
    const { service, storage } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 1_000 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const rootPrompt = liveCodexPromptObservation(rootQueryId, rootSessionId, startedAt);
    await service.observeSafeObservation(rootPrompt);
    await waitUntil(() => received.some((event) => event.eventType === "run.start"));
    const childPrompt = liveCodexPromptObservation(childQueryId, childSessionId, "2026-06-08T00:00:01.000Z");
    await appendDurableObservation(storage, childPrompt);
    now = Date.parse("2026-06-08T00:00:02.000Z");
    await service.observeSafeObservation(liveUsageObservation({
      queryId: childQueryId,
      sessionId: childSessionId,
      observedAt: new Date(now).toISOString(),
      atomId: "codex_provisional_child_usage",
      inputTokens: 4,
      outputTokens: 1
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.map((event) => event.eventType)).toEqual(["run.start"]);

    const linkedChildPrompt: SafeObservationV1 = {
      ...childPrompt,
      observationId: `${childPrompt.observationId}_linked`,
      observedAt: "2026-06-08T00:00:03.000Z",
      queryOccurrences: childPrompt.queryOccurrences?.map((occurrence) => ({
        ...occurrence,
        parentSessionId: rootSessionId
      }))
    };
    now = Date.parse(linkedChildPrompt.observedAt);
    await service.observeSafeObservation(linkedChildPrompt);
    now = Date.parse("2026-06-08T00:00:04.000Z");
    await service.observeSafeObservation(liveUsageObservation({
      queryId: childQueryId,
      sessionId: childSessionId,
      observedAt: new Date(now).toISOString(),
      atomId: "codex_reparented_child_usage",
      inputTokens: 6,
      outputTokens: 1
    }));
    await waitUntil(() => received.some((event) =>
      event.eventType === "run.update" && event.totalTokens === 12
    ));

    now = Date.parse("2026-06-08T00:00:05.000Z");
    await service.observeSafeObservation(liveCompletionObservation(linkedChildPrompt, new Date(now).toISOString(), "stop_hook"));
    now += 1_001;
    await service.retryNow();
    expect(received.filter((event) => event.eventType === "run.ended")).toHaveLength(0);

    now = Date.parse("2026-06-08T00:00:07.000Z");
    await service.observeSafeObservation(liveCompletionObservation(rootPrompt, new Date(now).toISOString(), "stop_hook"));
    now += 1_001;
    await service.retryNow();
    await waitUntil(() => received.some((event) => event.eventType === "run.ended"));

    expect(received.filter((event) => event.eventType === "run.start")).toHaveLength(1);
    expect(received.filter((event) => event.eventType === "run.ended")).toHaveLength(1);
    expect([...new Set(received.map((event) => event.runId))]).toEqual(["run_codex_late_parent_root"]);
    expect(received.find((event) => event.eventType === "run.ended")).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12
    });
  });

  it("refreshes a pending hook terminal with late live usage before delivery", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const queryId = "qry_live_terminal_refresh";
    const sessionId = "ses_live_terminal_refresh";
    const startedAt = "2026-06-08T00:00:00.000Z";
    const completedAt = "2026-06-08T00:00:01.000Z";
    let now = Date.parse(startedAt);
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 1_000 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const prompt = liveCodexPromptObservation(queryId, sessionId, startedAt);
    await service.observeSafeObservation(prompt);
    await service.observeSafeObservation(liveUsageObservation({
      queryId,
      sessionId,
      observedAt: "2026-06-08T00:00:00.500Z",
      atomId: "terminal_refresh",
      inputTokens: 10,
      outputTokens: 2
    }));
    now = Date.parse(completedAt);
    await service.observeSafeObservation(liveCompletionObservation(prompt, completedAt, "stop_hook"));
    now += 1;
    const closedTurn = liveUsageObservation({
      queryId,
      sessionId,
      observedAt: "2026-06-08T00:00:01.001Z",
      atomId: "terminal_refresh_turn",
      inputTokens: 12,
      outputTokens: 3
    });
    closedTurn.usageAtoms[0] = {
      ...closedTurn.usageAtoms[0],
      authority: "turn",
      completionMode: "explicit"
    };
    await service.observeSafeObservation(closedTurn);
    now += 1_000;
    await service.retryNow();

    await waitUntil(() => received.some((event) => event.eventType === "run.ended"));
    const ended = received.find((event) => event.eventType === "run.ended")!;
    expect(ended).toMatchObject({
      eventType: "run.ended",
      runId: "run_live_terminal_refresh",
      evidence: { basis: "stop_hook", delayed: false },
      coverage: { usageCoverage: "final" },
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      state: "completed"
    });
    expect((ended.activity as Array<{ kind: string }>).filter((activity) =>
      activity.kind === "llm_request"
    )).toHaveLength(1);
  });

  it("publishes a late closed-root correction immediately after a provisional terminal", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const queryId = "qry_late_closed_root_correction";
    const sessionId = "ses_late_closed_root_correction";
    const startedAt = "2026-06-08T00:00:00.000Z";
    const completedAt = "2026-06-08T00:00:01.000Z";
    let now = Date.parse(startedAt);
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 1_000 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const prompt = liveCodexPromptObservation(queryId, sessionId, startedAt);
    await service.observeSafeObservation(prompt);
    await service.observeSafeObservation(liveUsageObservation({
      queryId,
      sessionId,
      observedAt: "2026-06-08T00:00:00.500Z",
      atomId: "late_closed_root_request",
      inputTokens: 10,
      outputTokens: 2
    }));
    now = Date.parse(completedAt);
    await service.observeSafeObservation(liveCompletionObservation(prompt, completedAt, "stop_hook"));
    now += 1_001;
    await service.retryNow();
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 1);
    expect(received.find((event) => event.eventType === "run.ended")).toMatchObject({
      version: 1,
      totalTokens: 12,
      coverage: { usageCoverage: "complete_so_far" }
    });

    now = Date.parse("2026-06-08T00:00:03.000Z");
    const closedRoot = liveClosedCodexTurnObservation({
      queryId,
      sessionId,
      observedAt: new Date(now).toISOString(),
      inputTokens: 8,
      outputTokens: 2
    });
    closedRoot.usageAtoms[0] = {
      ...closedRoot.usageAtoms[0],
      startedAt,
      endedAt: "2026-06-08T00:00:01.100Z"
    };
    await service.observeSafeObservation(closedRoot);
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 2);

    const terminals = received.filter((event) => event.eventType === "run.ended");
    expect(terminals.at(-1)).toMatchObject({
      version: 2,
      startedAt,
      endedAt: "2026-06-08T00:00:01.100Z",
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      coverage: { usageCoverage: "final" },
      evidence: { basis: "stop_hook" }
    });
    expect(received.filter((event) => event.eventType === "run.start")).toHaveLength(1);
    expect(received.filter((event) => event.eventType === "run.update" && event.totalTokens === 10)).toHaveLength(0);
  });

  it("coalesces an unresolved-child correction and releases it after the bound", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    let now = Date.parse("2026-06-08T00:00:10.000Z");
    const run = {
      ...productionRun({
        runId: "run_coalesced_child_terminal",
        queryId: "qry_coalesced_child_terminal",
        correlationId: "trace_coalesced_child_terminal",
        provider: "codex",
        runtime: "codex",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:01.000Z"
      }),
      repositoryKey: "repo_coalesced_child_terminal"
    };
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{
          repoKey: "repo_coalesced_child_terminal",
          root: "/tmp/coalesced-child-terminal"
        }]
      },
      now: () => now,
      timing: {
        runEndedGraceMs: 20,
        terminalActivityCorrectionCoalesceMs: 40
      }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([run]);
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 1);

    const first = received.find((event) => event.eventType === "run.ended") as RunEndedWebhookEventV1;
    const evidence = first.activity[0].evidence;
    const traceEvidence = {
      ...evidence,
      basis: "trace_span" as const,
      delayed: false,
      identityConfidence: "high" as const,
      timingConfidence: "high" as const
    };
    const subagentEvidence = {
      ...traceEvidence,
      basis: "subagent_hook" as const
    };
    const partial: RunEndedWebhookEventV1 = {
      ...first,
      eventId: "evt_partial_child_terminal",
      version: 2,
      inputTokens: 15,
      outputTokens: 5,
      totalTokens: 20,
      coverage: {
        usageCoverage: "final",
        activityCoverage: "partial",
        costCoverage: "unavailable"
      },
      activity: [{
        activityId: "activity_coalesced_root",
        kind: "llm_request",
        name: "gpt-test",
        outcome: "success",
        count: 1,
        failureCount: 0,
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        usageAttributionBasis: "provider_reported",
        usageCoverage: "complete",
        evidence: traceEvidence
      }, {
        activityId: "activity_coalesced_child",
        kind: "subagent",
        name: "explorer",
        outcome: "success",
        count: 1,
        failureCount: 0,
        usageAttributionBasis: "activity_only",
        usageCoverage: "unavailable",
        evidence: subagentEvidence
      }, {
        activityId: "activity_coalesced_child_llm",
        kind: "llm_request",
        name: "gpt-test",
        outcome: "success",
        count: 1,
        failureCount: 0,
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        usageAttributionBasis: "provider_reported",
        usageCoverage: "complete",
        evidence: traceEvidence
      }]
    };
    const internals = service as unknown as {
      queueRunEndedEvent: (event: RunEndedWebhookEventV1, subjectId: string) => Promise<boolean>;
      processDueEntries: () => Promise<void>;
    };
    const subjectId = `run.ended:${run.runId}`;
    await internals.queueRunEndedEvent(partial, subjectId);
    await internals.processDueEntries();
    expect(received.filter((event) => event.eventType === "run.ended")).toHaveLength(1);

    const grouped: RunEndedWebhookEventV1 = {
      ...partial,
      eventId: "evt_grouped_child_terminal",
      coverage: {
        usageCoverage: "final",
        activityCoverage: "complete_for_reported_surface",
        costCoverage: "unavailable"
      },
      activity: [partial.activity[0], {
        ...partial.activity[1],
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        usageAttributionBasis: "unavailable",
        usageCoverage: "unavailable",
        evidence
      }, {
        ...partial.activity[2],
        parentActivityId: "activity_coalesced_child",
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        usageAttributionBasis: "activity_only",
        usageCoverage: "unavailable"
      }]
    };
    await internals.queueRunEndedEvent(grouped, subjectId);
    await internals.queueRunEndedEvent(partial, subjectId);
    await internals.queueRunEndedEvent(grouped, subjectId);
    await internals.processDueEntries();
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 2);

    const terminals = received.filter((event) => event.eventType === "run.ended");
    expect(terminals.map((event) => event.version)).toEqual([1, 2]);
    expect(terminals.at(-1)).toMatchObject({
      totalTokens: 20,
      coverage: { usageCoverage: "final", activityCoverage: "complete_for_reported_surface" },
      activity: expect.arrayContaining([
        expect.objectContaining({
          kind: "subagent",
          name: "explorer",
          totalTokens: 10,
          usageAttributionBasis: "trace_descendant",
          usageCoverage: "complete"
        })
      ])
    });

    const releaseRun = {
      ...run,
      runId: "run_released_child_terminal",
      queryId: "qry_released_child_terminal",
      correlationId: "trace_released_child_terminal",
      sessionId: "ses_released_child_terminal"
    };
    await service.observeCompletedRuns([releaseRun]);
    await waitUntil(() => received.some((event) =>
      event.eventType === "run.ended" && event.runId === releaseRun.runId));
    const releaseFirst = received.find((event) =>
      event.eventType === "run.ended" && event.runId === releaseRun.runId) as RunEndedWebhookEventV1;
    const releasePartial: RunEndedWebhookEventV1 = {
      ...partial,
      ...releaseFirst,
      eventId: "evt_released_child_terminal",
      version: 2,
      inputTokens: partial.inputTokens,
      outputTokens: partial.outputTokens,
      totalTokens: partial.totalTokens,
      coverage: partial.coverage,
      activity: partial.activity
    };
    const releaseSubjectId = `run.ended:${releaseRun.runId}`;
    await internals.queueRunEndedEvent(releasePartial, releaseSubjectId);
    await internals.processDueEntries();
    expect(received.filter((event) =>
      event.eventType === "run.ended" && event.runId === releaseRun.runId)).toHaveLength(1);

    now += 41;
    await internals.processDueEntries();
    await waitUntil(() => received.filter((event) =>
      event.eventType === "run.ended" && event.runId === releaseRun.runId).length === 2);
    expect(received.filter((event) =>
      event.eventType === "run.ended" && event.runId === releaseRun.runId).at(-1)).toMatchObject({
      version: 2,
      coverage: { usageCoverage: "final", activityCoverage: "partial" }
    });
  });

  it("keeps a published live start anchor through the final terminal correction", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const queryId = "qry_live_terminal_anchor";
    const sessionId = "ses_live_terminal_anchor";
    const startedAt = "2026-06-08T00:00:10.000Z";
    const completedAt = "2026-06-08T00:00:12.000Z";
    let now = Date.parse(startedAt);
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_live_terminal_anchor", queryId, [], "repo_live_terminal")]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 10_000 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const prompt = liveCodexPromptObservation(queryId, sessionId, startedAt);
    await service.observeSafeObservation(prompt);
    await waitUntil(() => received.some((event) => event.eventType === "run.start"));

    now = Date.parse(completedAt);
    await service.observeSafeObservation(liveCompletionObservation(prompt, completedAt, "stop_hook"));
    now += 10_001;
    await service.retryNow();
    await waitUntil(() => received.some((event) => event.eventType === "run.ended"));

    await service.observeCompletedRuns([productionRun({
      runId: "run_live_terminal_anchor",
      queryId,
      sessionId,
      correlationId: "trace_live_terminal_anchor",
      provider: "codex",
      runtime: "codex",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      startedAt: "2026-06-08T00:00:08.000Z",
      endedAt: completedAt
    })]);
    expect(received.filter((event) => event.eventType === "run.ended")).toHaveLength(2);

    const terminals = received.filter((event) => event.eventType === "run.ended");
    expect(terminals).toHaveLength(2);
    expect(terminals.every((event) => event.startedAt === startedAt)).toBe(true);
    expect(terminals.at(-1)).toMatchObject({
      version: 2,
      coverage: { usageCoverage: "final" },
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15
    });
  });

  it("replaces provisional direct tools with authoritative grouped terminal counts", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const queryId = "qry_live_terminal_activity_reconciliation";
    const sessionId = "ses_live_terminal_activity_reconciliation";
    const startedAt = "2026-06-08T00:00:10.000Z";
    const completedAt = "2026-06-08T00:00:12.000Z";
    let now = Date.parse(startedAt);
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_live_terminal_activity_reconciliation",
          queryId,
          [],
          "repo_live_terminal"
        )]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 1 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const prompt = liveCodexPromptObservation(queryId, sessionId, startedAt);
    await service.observeSafeObservation(prompt);
    await waitUntil(() => received.some((event) => event.eventType === "run.start"));
    now += 500;
    await service.observeSafeObservation(liveCodexToolObservation(queryId, sessionId, [
      { activityId: "act_apply_patch", name: "apply_patch", startedAt: "2026-06-08T00:00:10.250Z" },
      { activityId: "act_bash_first", name: "Bash", startedAt: "2026-06-08T00:00:10.350Z" },
      { activityId: "act_bash_second", name: "Bash", startedAt: "2026-06-08T00:00:10.450Z" }
    ], new Date(now).toISOString()));

    now = Date.parse(completedAt);
    await service.observeSafeObservation(liveCompletionObservation(prompt, completedAt, "stop_hook"));
    now += 2;
    await service.retryNow();
    await waitUntil(() => received.some((event) => event.eventType === "run.ended"));

    await service.observeCompletedRuns([{
      ...productionRun({
        runId: "run_live_terminal_activity_reconciliation",
        queryId,
        sessionId,
        correlationId: "trace_live_terminal_activity_reconciliation",
        provider: "codex",
        runtime: "codex",
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        startedAt,
        endedAt: completedAt
      }),
      toolCallCount: 3,
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_apply_patch",
        kind: "tool",
        name: "apply_patch",
        count: 1,
        failureCount: 0,
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_bash",
        kind: "tool",
        name: "Bash",
        count: 2,
        failureCount: 0,
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }]
    }]);
    now += 2;
    await service.retryNow();
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 2);

    const terminals = received.filter((event) => event.eventType === "run.ended") as Array<{
      version: number;
      activity: Array<{
        activityId: string;
        kind: string;
        name: string;
        count?: number;
        evidence: { basis: string };
      }>;
    }>;
    const provisionalTools = terminals[0].activity.filter((activity) => activity.kind === "tool");
    const finalTools = terminals[1].activity.filter((activity) => activity.kind === "tool");
    expect(provisionalTools).toHaveLength(3);
    expect(finalTools).toHaveLength(2);
    expect(finalTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "apply_patch", count: 1, evidence: expect.objectContaining({ basis: "usage_projection" }) }),
      expect.objectContaining({ name: "Bash", count: 2, evidence: expect.objectContaining({ basis: "usage_projection" }) })
    ]));
    expect(finalTools.reduce((count, activity) => count + (activity.count ?? 1), 0)).toBe(3);
    expect(finalTools.map((activity) => activity.activityId)).not.toEqual(expect.arrayContaining([
      "act_apply_patch",
      "act_bash_first",
      "act_bash_second"
    ]));
  });

  it("reconciles authoritative subagent usage only with corroborated live child lineage", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const queryId = "qry_subagent_terminal_usage_reconciliation";
    const sessionId = "ses_subagent_terminal_usage_reconciliation";
    const unlinkedQueryId = "qry_unlinked_terminal_usage_reconciliation";
    const unlinkedSessionId = "ses_unlinked_terminal_usage_reconciliation";
    const startedAt = "2026-06-08T00:00:00.000Z";
    const completedAt = "2026-06-08T00:00:02.000Z";
    let now = Date.parse(startedAt);
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [
          workEpisode(
            "run_subagent_terminal_usage_reconciliation",
            queryId,
            [],
            "repo_live_terminal"
          ),
          workEpisode(
            "run_unlinked_terminal_usage_reconciliation",
            unlinkedQueryId,
            [],
            "repo_live_terminal"
          )
        ]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 1_000 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const prompt = liveCodexPromptObservation(queryId, sessionId, startedAt);
    await service.observeSafeObservation(prompt);
    now += 500;
    await service.observeSafeObservation({
      schemaVersion: 1,
      observationId: "obs_subagent_terminal_usage_reconciliation",
      sourceId: "hook_codex_lifecycle",
      provider: "codex",
      runtime: "codex",
      signal: "logs",
      profileVersion: "codex-hooks-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: new Date(now).toISOString(),
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "act_subagent_terminal_usage_reconciliation",
        queryId,
        sessionId,
        childSessionId: "ses_subagent_terminal_usage_child",
        provider: "codex",
        runtime: "codex",
        kind: "subagent",
        name: "explorer",
        outcome: "success",
        startedAt: new Date(now).toISOString(),
        endedAt: new Date(now).toISOString()
      }],
      usageAtoms: []
    });
    now += 100;
    await service.observeSafeObservation({
      schemaVersion: 1,
      observationId: "obs_child_llm_terminal_usage_reconciliation",
      sourceId: "otlp_codex_traces",
      provider: "codex",
      runtime: "codex",
      signal: "traces",
      profileVersion: "codex-otel-traces-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: new Date(now).toISOString(),
      executionNodes: [{
        schemaVersion: 1,
        nodeId: "node_child_llm_terminal_usage_reconciliation",
        queryId,
        sessionId: "ses_subagent_terminal_usage_child",
        requestId: "req_child_llm_terminal_usage_reconciliation",
        provider: "codex",
        runtime: "codex",
        signal: "traces",
        nodeKind: "llm_request",
        name: "gpt-5.5",
        outcome: "success",
        startedAt: new Date(now).toISOString(),
        endedAt: new Date(now).toISOString(),
        model: "gpt-5.5"
      }],
      usageAtoms: []
    });
    now = Date.parse(completedAt);
    await service.observeSafeObservation(liveCompletionObservation(prompt, completedAt, "stop_hook"));
    now += 500;
    await service.observeSafeObservation(liveUsageObservation({
      queryId,
      sessionId,
      observedAt: new Date(now).toISOString(),
      atomId: "cumulative_parent_child_llm_usage",
      inputTokens: 20,
      outputTokens: 5
    }));
    now = Date.parse(completedAt) + 1_001;
    await service.retryNow();
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 1);

    const authoritativeRun: ProductionRunV1 = {
      ...productionRun({
        runId: "run_subagent_terminal_usage_reconciliation",
        queryId,
        sessionId,
        correlationId: "trace_subagent_terminal_usage_reconciliation",
        provider: "codex",
        runtime: "codex",
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        startedAt,
        endedAt: completedAt
      }),
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_authoritative_explorer",
        kind: "subagent",
        name: "explorer",
        count: 1,
        failureCount: 0,
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        attributionBasis: "unavailable",
        coverage: "unavailable"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_authoritative_unallocated",
        kind: "unallocated",
        name: "Unallocated run usage",
        count: 1,
        failureCount: 0,
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        attributionBasis: "unavailable",
        coverage: "partial"
      }]
    };
    await service.observeCompletedRuns([authoritativeRun]);
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 2);

    const final = received.filter((event) => event.eventType === "run.ended").at(-1) as {
      inputTokens: number;
      outputTokens: number;
      context?: unknown;
      activity: Array<{
        activityId: string;
        parentActivityId?: string;
        kind: string;
        name: string;
        count?: number;
        inputTokens?: number;
        outputTokens?: number;
        usageAttributionBasis?: string;
        usageCoverage?: string;
      }>;
    };
    const explorer = final.activity.find((activity) => activity.kind === "subagent" && activity.name === "explorer")!;
    const llmActivity = final.activity.filter((activity) => activity.kind === "llm_request");
    const childLlm = llmActivity.find((activity) => activity.inputTokens == null)!;
    const parentLlm = llmActivity.find((activity) => activity.inputTokens != null)!;
    expect(explorer).toMatchObject({
      inputTokens: 8,
      outputTokens: 2,
      usageAttributionBasis: "trace_descendant",
      usageCoverage: "complete"
    });
    expect(childLlm).toMatchObject({ parentActivityId: explorer.activityId });
    expect(childLlm.inputTokens).toBeUndefined();
    expect(childLlm.outputTokens).toBeUndefined();
    expect(parentLlm).toMatchObject({ count: 1, inputTokens: 12, outputTokens: 3 });
    expect(final.activity.find((activity) => activity.name === "Unallocated run usage")).toBeUndefined();
    expect(final.context).toBeUndefined();
    expect(final.activity.reduce((sum, activity) => sum + (activity.inputTokens ?? 0), 0)).toBe(final.inputTokens);
    expect(final.activity.reduce((sum, activity) => sum + (activity.outputTokens ?? 0), 0)).toBe(final.outputTokens);

    await service.observeCompletedRuns([authoritativeRun]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.filter((event) => event.eventType === "run.ended")).toHaveLength(2);

    const unlinkedStartedAt = "2026-06-08T00:00:10.000Z";
    const unlinkedCompletedAt = "2026-06-08T00:00:12.000Z";
    now = Date.parse(unlinkedStartedAt);
    const unlinkedPrompt = liveCodexPromptObservation(unlinkedQueryId, unlinkedSessionId, unlinkedStartedAt);
    await service.observeSafeObservation(unlinkedPrompt);
    now += 1_000;
    await service.observeSafeObservation(liveUsageObservation({
      queryId: unlinkedQueryId,
      sessionId: unlinkedSessionId,
      observedAt: new Date(now).toISOString(),
      atomId: "unlinked_root_llm_usage",
      inputTokens: 8,
      outputTokens: 2
    }));
    now = Date.parse(unlinkedCompletedAt);
    await service.observeSafeObservation(liveCompletionObservation(
      unlinkedPrompt,
      unlinkedCompletedAt,
      "stop_hook"
    ));
    now += 1_001;
    await service.retryNow();
    await waitUntil(() => received.some((event) =>
      event.eventType === "run.ended"
      && event.runId === "run_unlinked_terminal_usage_reconciliation"
      && event.version === 1
    ));

    await service.observeCompletedRuns([{
      ...productionRun({
        runId: "run_unlinked_terminal_usage_reconciliation",
        queryId: unlinkedQueryId,
        sessionId: unlinkedSessionId,
        correlationId: "trace_unlinked_terminal_usage_reconciliation",
        provider: "codex",
        runtime: "codex",
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        startedAt: unlinkedStartedAt,
        endedAt: unlinkedCompletedAt
      }),
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_authoritative_unlinked_explorer",
        kind: "subagent",
        name: "explorer",
        count: 1,
        failureCount: 0,
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        attributionBasis: "unavailable",
        coverage: "unavailable"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_authoritative_unlinked_unallocated",
        kind: "unallocated",
        name: "Unallocated run usage",
        count: 1,
        failureCount: 0,
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        attributionBasis: "unavailable",
        coverage: "partial"
      }]
    }]);
    await waitUntil(() => received.some((event) =>
      event.eventType === "run.ended"
      && event.runId === "run_unlinked_terminal_usage_reconciliation"
      && event.version === 2
    ));
    const unlinkedFinal = received.find((event) =>
      event.eventType === "run.ended"
      && event.runId === "run_unlinked_terminal_usage_reconciliation"
      && event.version === 2
    ) as {
      activity: Array<{
        kind: string;
        name: string;
        inputTokens?: number;
        outputTokens?: number;
      }>;
    };
    expect(unlinkedFinal.activity.find((activity) => activity.kind === "llm_request"))
      .toMatchObject({ inputTokens: 8, outputTokens: 2 });
    expect(unlinkedFinal.activity.find((activity) => activity.name === "Unallocated run usage"))
      .toMatchObject({ inputTokens: 4, outputTokens: 1 });
  });

  it("reconciles two same-name child LLM rows only when their exact aggregate is unique", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const queryId = "qry_multi_child_terminal_reconciliation";
    const sessionId = "ses_multi_child_terminal_reconciliation";
    const childQueryIdA = "qry_multi_child_terminal_a";
    const childQueryIdB = "qry_multi_child_terminal_b";
    const startedAt = "2026-06-08T00:00:00.000Z";
    const completedAt = "2026-06-08T00:00:02.000Z";
    let now = Date.parse(startedAt);
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisodeWithEvidence({
          episodeId: "episode_run_multi_child_terminal_reconciliation",
          repoKey: "repo_multi_child_terminal",
          runIds: ["run_multi_child_terminal_reconciliation"],
          queryIds: [queryId, childQueryIdA, childQueryIdB],
          evidence: [{
            runId: "run_multi_child_terminal_reconciliation",
            queryId,
            repoKey: "repo_multi_child_terminal",
            artifactKeys: []
          }]
        })]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_multi_child_terminal", root: "/tmp/multi-child-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 1_000 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const prompt = liveCodexPromptObservation(queryId, sessionId, startedAt);
    await service.observeSafeObservation(prompt);
    for (const [childQueryId, childSessionId, offset] of [
      [childQueryIdA, "ses_multi_child_terminal_a", 300],
      [childQueryIdB, "ses_multi_child_terminal_b", 400]
    ] as const) {
      const childPrompt = liveCodexPromptObservation(
        childQueryId,
        childSessionId,
        new Date(Date.parse(startedAt) + offset).toISOString()
      );
      childPrompt.queryOccurrences = childPrompt.queryOccurrences?.map((occurrence) => ({
        ...occurrence,
        parentSessionId: sessionId
      }));
      await service.observeSafeObservation(childPrompt);
    }
    now += 500;
    await service.observeSafeObservation({
      schemaVersion: 1,
      observationId: "obs_multi_child_terminal_subagents",
      sourceId: "hook_codex_lifecycle",
      provider: "codex",
      runtime: "codex",
      signal: "logs",
      profileVersion: "codex-hooks-v1",
      resourceCount: 1,
      recordCount: 2,
      observedAt: new Date(now).toISOString(),
      activityAtoms: ["a", "b"].map((suffix, index) => ({
        schemaVersion: 1 as const,
        activityId: `act_multi_child_terminal_${suffix}`,
        queryId,
        sessionId,
        childSessionId: `ses_multi_child_terminal_${suffix}`,
        provider: "codex" as const,
        runtime: "codex",
        kind: "subagent" as const,
        name: "explorer",
        outcome: "success" as const,
        startedAt: new Date(now + index * 100).toISOString(),
        endedAt: new Date(now + index * 100).toISOString()
      })),
      usageAtoms: []
    });
    now += 100;
    await service.observeSafeObservation(liveUsageObservation({
      queryId: childQueryIdA,
      sessionId: "ses_multi_child_terminal_a",
      observedAt: new Date(now).toISOString(),
      atomId: "multi_child_terminal_usage_a",
      inputTokens: 8,
      outputTokens: 2
    }));
    now += 100;
    await service.observeSafeObservation(liveUsageObservation({
      queryId: childQueryIdB,
      sessionId: "ses_multi_child_terminal_b",
      observedAt: new Date(now).toISOString(),
      atomId: "multi_child_terminal_usage_b",
      inputTokens: 9,
      outputTokens: 3
    }));
    now = Date.parse(completedAt) - 100;
    await service.observeSafeObservation(liveUsageObservation({
      queryId,
      sessionId,
      observedAt: new Date(now).toISOString(),
      atomId: "multi_child_terminal_cumulative_root",
      inputTokens: 29,
      outputTokens: 8
    }));
    now = Date.parse(completedAt);
    await service.observeSafeObservation(liveCompletionObservation(prompt, completedAt, "stop_hook"));
    now += 1_001;
    await service.retryNow();
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 1);

    const authoritativeRun: ProductionRunV1 = {
      ...productionRun({
        runId: "run_multi_child_terminal_reconciliation",
        queryId,
        sessionId,
        correlationId: "trace_multi_child_terminal_reconciliation",
        provider: "codex",
        runtime: "codex",
        inputTokens: 29,
        outputTokens: 8,
        totalTokens: 37,
        startedAt,
        endedAt: completedAt
      }),
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_multi_child_terminal_explorer",
        kind: "subagent",
        name: "explorer",
        count: 2,
        failureCount: 0,
        inputTokens: 17,
        outputTokens: 5,
        totalTokens: 22,
        attributionBasis: "trace_descendant",
        coverage: "complete"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_multi_child_terminal_unallocated",
        kind: "unallocated",
        name: "Unallocated run usage",
        count: 1,
        failureCount: 0,
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        attributionBasis: "unavailable",
        coverage: "partial"
      }]
    };
    await service.observeCompletedRuns([authoritativeRun]);
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 2);

    const final = received.filter((event) => event.eventType === "run.ended").at(-1) as {
      inputTokens: number;
      outputTokens: number;
      activity: Array<{
        activityId: string;
        parentActivityId?: string;
        kind: string;
        name: string;
        count?: number;
        inputTokens?: number;
        outputTokens?: number;
        usageAttributionBasis?: string;
        usageCoverage?: string;
      }>;
    };
    const explorer = final.activity.find((activity) => activity.kind === "subagent" && activity.name === "explorer")!;
    const childLlm = final.activity.filter((activity) =>
      activity.kind === "llm_request" && activity.parentActivityId === explorer.activityId
    );
    const rootLlm = final.activity.find((activity) =>
      activity.kind === "llm_request" && !activity.parentActivityId && activity.inputTokens != null
    );
    expect(explorer).toMatchObject({
      count: 2,
      inputTokens: 17,
      outputTokens: 5,
      usageAttributionBasis: "trace_descendant",
      usageCoverage: "complete"
    });
    expect(childLlm).toHaveLength(2);
    expect(childLlm.every((activity) => activity.inputTokens == null && activity.outputTokens == null)).toBe(true);
    expect(rootLlm).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(final.activity.find((activity) => activity.name === "Unallocated run usage")).toBeUndefined();
    expect(final.activity.reduce((sum, activity) => sum + (activity.inputTokens ?? 0), 0)).toBe(final.inputTokens);
    expect(final.activity.reduce((sum, activity) => sum + (activity.outputTokens ?? 0), 0)).toBe(final.outputTokens);

    await service.observeCompletedRuns([authoritativeRun]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.filter((event) => event.eventType === "run.ended")).toHaveLength(2);
  });

  for (const scenario of complexChildAgentScenarios) {
    it(`delivers ${scenario.fixtureId} as one conserved canonical webhook stream`, async () => {
      const received: Array<Record<string, unknown>> = [];
      const server = createServer((request, response) => {
        collectJson(request).then((body) => {
          received.push(body as Record<string, unknown>);
          response.statusCode = 200;
          response.end("ok");
        });
      });
      await listen(server);
      servers.push(server);
      const address = server.address() as AddressInfo;
      const runs = new DefaultProductionUsagePipeline().project(
        usageAtomsForComplexScenario(scenario),
        new Date(Date.parse(scenario.root.endedAt) + 1_000),
        occurrencesForComplexScenario(scenario),
        activitiesForComplexScenario(scenario)
      );
      expect(runs).toHaveLength(1);
      const run = runs[0];
      const artifactPaths = new Map(scenario.writes.map((write) => [write.artifactKey, write.relativePath]));
      const { service } = await testService({
        attribution: {
          listWorkEpisodes: async () => [workEpisode(
            run.runId,
            scenario.root.queryId,
            scenario.writes.map((write) => write.artifactKey),
            scenario.repositoryKey
          )]
        },
        repositories: {
          listRepositories: async () => [{
            repoKey: scenario.repositoryKey,
            root: `/tmp/${scenario.fixtureId}`
          }],
          relativePaths: (_repoKey, artifactKeys) => artifactKeys.flatMap((artifactKey) => {
            const relativePath = artifactPaths.get(artifactKey);
            return relativePath ? [relativePath] : [];
          })
        },
        now: () => Date.parse(scenario.root.endedAt) + 10_000,
        timing: { runEndedGraceMs: 1 }
      });
      await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

      await service.observeCompletedRuns([run]);
      await waitUntil(() => received.some((event) =>
        event.eventType === "run.ended" && event.runId === run.runId
      ));

      const lifecycle = received.filter((event) => event.runId === run.runId);
      expect(lifecycle.map((event) => event.eventType)).toEqual(["run.start", "run.update", "run.ended"]);
      const terminal = lifecycle.at(-1) as unknown as RunEndedWebhookEventV1;
      const childTokens = sumComplexRunTokens(scenario.children.map((child) => child.tokens));
      expect(terminal).toMatchObject({
        eventType: "run.ended",
        runId: run.runId,
        version: 1,
        codingHarness: "codex",
        state: "completed",
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cacheReadInputTokens: run.cacheReadInputTokens,
        cacheCreationInputTokens: run.cacheCreationInputTokens,
        reasoningOutputTokens: run.reasoningOutputTokens,
        totalTokens: scenario.expected.publicTotalTokens,
        coverage: expect.objectContaining({ usageCoverage: "final" })
      });
      expect([...terminal.filesChanged].sort()).toEqual(scenario.writes.map((write) => write.relativePath).sort());

      const subagent = terminal.activity.find((activity) =>
        activity.kind === "subagent" && activity.name === scenario.subagent.name
      );
      expect(subagent).toMatchObject({
        outcome: "unknown",
        count: scenario.children.length,
        failureCount: 0,
        unknownCount: scenario.children.length,
        inputTokens: childTokens.inputTokens,
        outputTokens: childTokens.outputTokens,
        cacheReadInputTokens: childTokens.cacheReadInputTokens,
        cacheCreationInputTokens: childTokens.cacheCreationInputTokens,
        reasoningOutputTokens: childTokens.reasoningOutputTokens,
        totalTokens: childTokens.totalTokens,
        usageAttributionBasis: "trace_descendant",
        usageCoverage: "complete"
      });
      const shell = terminal.activity.filter((activity) => activity.kind === "tool" && activity.name === "Bash");
      expect(shell.reduce((sum, activity) => sum + (activity.count ?? 1), 0)).toBe(scenario.expected.shellCount);
      expect(shell.reduce((sum, activity) => sum + (activity.unknownCount ?? 0), 0)).toBe(scenario.expected.shellCount);

      for (const key of [
        "inputTokens",
        "outputTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
        "reasoningOutputTokens",
        "totalTokens"
      ] as const) {
        expect(terminal.activity.reduce((sum, activity) => sum + (activity[key] ?? 0), 0)).toBe(terminal[key]);
      }

      const serialized = JSON.stringify(lifecycle);
      expect(serialized).not.toContain(scenario.internalSession.queryId);
      expect(serialized).not.toContain(scenario.internalSession.sessionId);
      expect(serialized).not.toContain("internal_title_generation");
      expect(serialized).not.toContain("/tmp/");
      for (const write of scenario.writes) {
        expect(serialized).not.toContain(write.artifactKey);
      }
      expect(await service.status()).toMatchObject({ queuedCount: 0, blockedCount: 0 });
    });
  }

  it("assigns authoritative residual usage to the one corroborated root LLM after child reconciliation", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body as Record<string, unknown>);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const rootQueryId = "qry_additive_terminal_root";
    const rootSessionId = "ses_additive_terminal_root";
    const childQueryId = "qry_additive_terminal_child";
    const childSessionId = "ses_additive_terminal_child";
    const startedAt = "2026-06-08T00:00:00.000Z";
    const completedAt = "2026-06-08T00:00:02.000Z";
    let now = Date.parse(startedAt);
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_additive_terminal_root",
          rootQueryId,
          [],
          "repo_live_terminal"
        )]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live_terminal", root: "/tmp/live-terminal" }]
      },
      now: () => now,
      timing: { runEndedGraceMs: 1_000 }
    });
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    const rootPrompt = liveCodexPromptObservation(rootQueryId, rootSessionId, startedAt);
    await service.observeSafeObservation(rootPrompt);
    const childPrompt = liveCodexPromptObservation(childQueryId, childSessionId, "2026-06-08T00:00:00.400Z");
    childPrompt.queryOccurrences = childPrompt.queryOccurrences?.map((occurrence) => ({
      ...occurrence,
      parentSessionId: rootSessionId
    }));
    now = Date.parse(childPrompt.observedAt);
    await service.observeSafeObservation(childPrompt);
    now = Date.parse("2026-06-08T00:00:00.500Z");
    await service.observeSafeObservation({
      schemaVersion: 1,
      observationId: "obs_additive_terminal_subagent",
      sourceId: "hook_codex_lifecycle",
      provider: "codex",
      runtime: "codex",
      signal: "logs",
      profileVersion: "codex-hooks-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: new Date(now).toISOString(),
      activityAtoms: [{
        schemaVersion: 1,
        activityId: "act_additive_terminal_subagent",
        queryId: rootQueryId,
        sessionId: rootSessionId,
        childSessionId,
        provider: "codex",
        runtime: "codex",
        kind: "subagent",
        name: "explorer",
        outcome: "success",
        startedAt: new Date(now).toISOString(),
        endedAt: new Date(now).toISOString()
      }],
      usageAtoms: []
    });
    now = Date.parse("2026-06-08T00:00:00.600Z");
    await service.observeSafeObservation(liveUsageObservation({
      queryId: rootQueryId,
      sessionId: rootSessionId,
      observedAt: new Date(now).toISOString(),
      atomId: "additive_terminal_root_usage",
      inputTokens: 12,
      outputTokens: 3
    }));
    now = Date.parse("2026-06-08T00:00:00.700Z");
    await service.observeSafeObservation(liveUsageObservation({
      queryId: childQueryId,
      sessionId: childSessionId,
      observedAt: new Date(now).toISOString(),
      atomId: "additive_terminal_child_usage",
      inputTokens: 8,
      outputTokens: 2
    }));
    now = Date.parse(completedAt);
    await service.observeSafeObservation(liveCompletionObservation(rootPrompt, completedAt, "stop_hook"));
    now += 1_001;
    await service.retryNow();
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 1);

    await service.observeCompletedRuns([{
      ...productionRun({
        runId: "run_additive_terminal_root",
        queryId: rootQueryId,
        sessionId: rootSessionId,
        correlationId: "trace_additive_terminal_root",
        provider: "codex",
        runtime: "codex",
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        startedAt,
        endedAt: completedAt
      }),
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_additive_terminal_explorer",
        kind: "subagent",
        name: "explorer",
        count: 1,
        failureCount: 0,
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        attributionBasis: "unavailable",
        coverage: "unavailable"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_additive_terminal_unallocated",
        kind: "unallocated",
        name: "Unallocated run usage",
        count: 1,
        failureCount: 0,
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        attributionBasis: "unavailable",
        coverage: "partial"
      }]
    }]);
    await waitUntil(() => received.filter((event) => event.eventType === "run.ended").length === 2);

    const final = received.filter((event) => event.eventType === "run.ended").at(-1) as {
      inputTokens: number;
      outputTokens: number;
      activity: Array<{
        activityId: string;
        parentActivityId?: string;
        kind: string;
        name: string;
        inputTokens?: number;
        outputTokens?: number;
      }>;
    };
    const explorer = final.activity.find((activity) => activity.kind === "subagent" && activity.name === "explorer")!;
    const llm = final.activity.filter((activity) => activity.kind === "llm_request");
    expect(received.filter((event) => event.eventType === "run.start")).toHaveLength(1);
    expect(explorer).toMatchObject({ inputTokens: 8, outputTokens: 2 });
    const childLlm = llm.find((activity) => activity.parentActivityId === explorer.activityId)!;
    expect(childLlm.inputTokens).toBeUndefined();
    expect(childLlm.outputTokens).toBeUndefined();
    expect(llm.find((activity) => activity.parentActivityId == null)).toMatchObject({
      inputTokens: 12,
      outputTokens: 3
    });
    expect(final.activity.find((activity) => activity.name === "Unallocated run usage")).toBeUndefined();
    expect(final.activity.reduce((sum, activity) => sum + (activity.inputTokens ?? 0), 0)).toBe(final.inputTokens);
    expect(final.activity.reduce((sum, activity) => sum + (activity.outputTokens ?? 0), 0)).toBe(final.outputTokens);
  });

  it("prices Cursor live run-update events from Composer usage atoms", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_cursor", root: "/tmp/cursor-repo" }]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveCursorPromptObservation(
      "qry_cursor_live_cost",
      "ses_cursor_live_cost",
      "2026-07-03T00:00:00.000Z"
    ));
    await waitUntil(() => received.length === 1);

    await service.observeSafeObservation(liveCursorUsageObservation({
      queryId: "qry_cursor_live_cost",
      sessionId: "ses_cursor_live_cost",
      observedAt: "2026-07-03T00:00:02.000Z",
      atomId: "atom_cursor_composer_live_cost",
      inputTokens: 2_400,
      cacheReadInputTokens: 200,
      outputTokens: 160,
      reasoningOutputTokens: 30
    }));
    await waitUntil(() => received.length === 2);

    expect(received[1]).toMatchObject({
      eventType: "run.update",
      runId: "run_cursor_live_cost",
      sessionId: "ses_cursor_live_cost",
      codingHarness: "cursor",
      runtime: "cursor",
      llmModels: ["composer-2.5-fast"],
      inputTokens: 2_400,
      cacheReadInputTokens: 200,
      outputTokens: 160,
      reasoningOutputTokens: 30,
      estimatedNanoUsd: 9_550_000,
      usageValueNanoUsd: 9_550_000,
      costEstimateBasis: "catalog_estimate",
      costCoverage: "complete",
      coverage: expect.objectContaining({
        costCoverage: "complete"
      })
    });
  });

  it("does not dispatch a live run-update before the corresponding run-start", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const diagnostics: DiagnosticEvent[] = [];
    const { service } = await testService({
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live", root: "/tmp/live" }]
      },
      recordEvent: (event) => diagnostics.push(event)
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveToolObservation("qry_live_out_of_order", "ses_live", "2026-06-08T00:00:01.000Z"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(received).toHaveLength(0);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "queue",
        state: "blocked",
        reason: "run_update_waiting_for_start",
        runId: "run_live_out_of_order"
      })
    ]));
  });

  it("uses live run-start repository binding for completed read-only runs without settled evidence yet", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const diagnostics: DiagnosticEvent[] = [];
    let now = Date.parse("2026-06-08T00:00:00.000Z");
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => []
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_live", root: "/tmp/live" }]
      },
      recordEvent: (event) => diagnostics.push(event),
      now: () => now
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(livePromptObservation("qry_live_read_only", "ses_live", "2026-06-08T00:00:00.000Z"));
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.start"));
    await service.observeCompletedRuns([productionRun({
      runId: "run_live_read_only",
      queryId: "qry_live_read_only",
      correlationId: "trace_live_read_only",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    })]);
    now += 16_000;
    await service.retryNow();

    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.ended")).toMatchObject({
      eventType: "run.ended",
      runId: "run_live_read_only",
      repository: {
        repoKey: "repo_live",
        owner: "local",
        name: "live",
        fullName: "local/live"
      },
      filesChanged: []
    });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "fallback",
        reason: "run_webhook_repository_bound_from_live_start",
        runId: "run_live_read_only",
        repoKey: "repo_live"
      })
    ]));
  });

  it("binds live lifecycle events to the same provider-neutral repository across coding harnesses", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const diagnostics: DiagnosticEvent[] = [];
    const requestedProviders: Array<"github-copilot" | "claude-code" | "codex" | undefined> = [];
    const { service } = await testService({
      repositories: {
        listRepositories: async (provider?: "github-copilot" | "claude-code" | "codex") => {
          requestedProviders.push(provider);
          return [{ repoKey: "repo_shared", root: "/tmp/shared-repo" }];
        }
      },
      recordEvent: (event) => diagnostics.push(event)
    });
    const baseObservation = livePromptObservation("qry_codex", "ses_codex", "2026-06-08T00:00:00.000Z");

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation({
      ...baseObservation,
      observationId: "obs_prompt_codex",
      sourceId: "hook_codex_lifecycle",
      provider: "codex",
      runtime: "codex",
      profileVersion: "codex-hooks-v1",
      queryOccurrences: baseObservation.queryOccurrences.map((occurrence) => ({
        ...occurrence,
        provider: "codex",
        runtime: "codex"
      })),
      executionNodes: baseObservation.executionNodes.map((node) => ({
        ...node,
        provider: "codex",
        runtime: "codex"
      }))
    });

    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.start"));
    expect(requestedProviders).toContain(undefined);
    expect(requestedProviders).not.toContain("codex");
    expect(received[0]).toMatchObject({
      eventType: "run.start",
      repository: {
        repoKey: "repo_shared",
        owner: "local",
        name: "shared-repo",
        fullName: "local/shared-repo"
      },
      codingHarness: "codex"
    });
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "blocked",
        reason: "run_lifecycle_repository_binding_missing"
      })
    ]));
  });

  it("binds GitHub Copilot live starts to provider-neutral repositories", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const requestedProviders: Array<"github-copilot" | "claude-code" | "codex" | undefined> = [];
    const { service } = await testService({
      repositories: {
        listRepositories: async (provider?: "github-copilot" | "claude-code" | "codex") => {
          requestedProviders.push(provider);
          return [{ repoKey: "repo_copilot", root: "/tmp/copilot-repo" }];
        }
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation({
      schemaVersion: 1,
      observationId: "obs_copilot_root_start",
      sourceId: "otlp_github_copilot_traces",
      provider: "github-copilot",
      runtime: "github-copilot",
      signal: "traces",
      profileVersion: "copilot-otlp-traces-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: "2026-06-08T00:00:00.000Z",
      queryOccurrences: [{
        schemaVersion: 1,
        queryId: "qry_copilot",
        sessionId: "ses_copilot",
        provider: "github-copilot",
        runtime: "github-copilot",
        startedAt: "2026-06-08T00:00:00.000Z",
        promptState: "disabled",
        evidence: "provider_root_span"
      }],
      executionNodes: [{
        schemaVersion: 1,
        nodeId: "node_copilot_root",
        queryId: "qry_copilot",
        sessionId: "ses_copilot",
        requestId: "req_copilot_root",
        provider: "github-copilot",
        runtime: "github-copilot",
        signal: "traces",
        nodeKind: "llm_request",
        name: "invoke_agent",
        outcome: "unknown",
        startedAt: "2026-06-08T00:00:00.000Z",
        model: "gpt-5.4"
      }],
      usageAtoms: []
    });

    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.start"));
    expect(requestedProviders).toContain(undefined);
    expect(requestedProviders).not.toContain("github-copilot");
    expect(received[0]).toMatchObject({
      eventType: "run.start",
      runId: "run_copilot",
      repository: {
        repoKey: "repo_copilot",
        owner: "local",
        name: "copilot-repo",
        fullName: "local/copilot-repo"
      },
      codingHarness: "github-copilot",
      evidence: {
        basis: "root_span",
        sourceId: "qry_copilot"
      }
    });
  });

  it("emits GitHub Copilot run updates and run-ended events from root span lifecycle evidence", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const queryId = "qry_copilot_lifecycle";
    const sessionId = "ses_copilot_lifecycle";
    const runId = "run_copilot_lifecycle";
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(runId, queryId, ["artifact_copilot"], "repo_copilot")]
      },
      repositories: {
        listRepositories: async (provider?: "github-copilot" | "claude-code" | "codex") =>
          provider == null || provider === "github-copilot"
            ? [{ repoKey: "repo_copilot", root: "/tmp/copilot-lifecycle" }]
            : [],
        relativePaths: () => ["src/copilot.ts"]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveCopilotRootObservation(queryId, sessionId, "2026-06-08T00:00:00.000Z"));
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.start"));
    await service.observeSafeObservation(liveCopilotToolObservation(queryId, sessionId, "2026-06-08T00:00:01.000Z"));
    await waitUntil(() => received.some(isCopilotToolUpdate));
    await service.observeCompletedRuns([productionRun({
      runId,
      queryId,
      sessionId,
      correlationId: "trace_copilot_lifecycle",
      provider: "github-copilot",
      runtime: "github-copilot",
      inputTokens: 32,
      outputTokens: 8,
      totalTokens: 40,
      estimatedNanoUsd: 90_000,
      usageValueNanoUsd: 90_000,
      costEstimateBasis: "catalog_estimate",
      billingContext: "github-copilot",
      models: ["gpt-5.4"],
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    })]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    expect(received.map((event) => (event as { eventType?: string }).eventType))
      .toEqual(expect.arrayContaining(["run.start", "run.update", "run.ended"]));
    expect(received.find(isCopilotToolUpdate)).toMatchObject({
      eventType: "run.update",
      runId,
      sessionId,
      codingHarness: "github-copilot",
      activity: expect.arrayContaining([expect.objectContaining({
        kind: "tool",
        name: "apply_patch"
      })])
    });
    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.ended")).toMatchObject({
      eventType: "run.ended",
      runId,
      sessionId,
      traceIds: ["trace_copilot_lifecycle"],
      codingHarness: "github-copilot",
      repository: {
        repoKey: "repo_copilot",
        owner: "local",
        name: "copilot-lifecycle",
        fullName: "local/copilot-lifecycle"
      },
      filesChanged: ["src/copilot.ts"],
      estimatedNanoUsd: 90_000,
      usageValueNanoUsd: 90_000,
      costCoverage: "complete",
      state: "completed"
    });
    const payload = JSON.stringify(received);
    expect(payload).not.toContain("prompt text");
    expect(payload).not.toContain("/tmp/copilot-lifecycle");
  });

  it("drains events queued while another delivery is in flight", async () => {
    const received: unknown[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstResponseReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const server = createServer((request, response) => {
      collectJson(request).then(async (body) => {
        received.push(body);
        if ((body as { runId?: string }).runId === "run_first") {
          await firstResponseReleased;
        }
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const first = productionRun({
      runId: "run_first",
      queryId: "qry_first",
      correlationId: "trace_first",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      estimatedNanoUsd: 10_000,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:01.000Z"
    });
    const second = productionRun({
      runId: "run_second",
      queryId: "qry_second",
      correlationId: "trace_second",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      estimatedNanoUsd: 12_000,
      startedAt: "2026-06-08T00:00:02.000Z",
      endedAt: "2026-06-08T00:00:03.000Z"
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [
          workEpisode("run_first", "qry_first", ["artifact_first"], "repo_tirion"),
          workEpisode("run_second", "qry_second", ["artifact_second"], "repo_tirion")
        ]
      },
      repositories: {
        relativePaths: (_repoKey, artifactKeys) => artifactKeys.map((artifactKey) =>
          artifactKey === "artifact_first" ? "src/first.ts" : "src/second.ts"
        ),
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    const firstDelivery = service.observeCompletedRuns([first]);
    await waitUntil(() => received.length === 1);

    await service.observeCompletedRuns([second]);
    releaseFirst?.();
    await firstDelivery;
    await waitUntil(() => received.length === 6);

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.start",
      "run.update",
      "run.update",
      "run.ended",
      "run.ended"
    ]);
    expect(received.map((event) => (event as { runId?: string }).runId)).toEqual([
      "run_first",
      "run_second",
      "run_first",
      "run_second",
      "run_first",
      "run_second"
    ]);
  });

  it("dispatches run-ended webhooks for repo-reading runs with empty changed files and deduplicates retries", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const run = productionRun({
      runId: "run_read_only",
      queryId: "qry_read_only",
      correlationId: "trace_read_only",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 140,
      outputTokens: 28,
      reasoningOutputTokens: 45,
      totalTokens: 168,
      estimatedNanoUsd: 3_000_000,
      costEstimateBasis: "provider_reported_estimate",
      startedAt: "2026-06-08T00:05:00.000Z",
      endedAt: "2026-06-08T00:05:01.000Z",
      models: ["claude-sonnet-4.6"]
    });
    let now = Date.parse("2026-06-08T00:05:02.000Z");
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_read_only", "qry_read_only", [], "repo_docs")]
      },
      repositories: {
        relativePaths: () => [],
        listRepositories: async () => [{ repoKey: "repo_docs", root: "/tmp/tirion-docs" }]
      },
      now: () => now
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([run]);
    now += 16_000;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    await service.observeCompletedRuns([run]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(3);
    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);
    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.ended")).toMatchObject({
      eventType: "run.ended",
      repository: {
        repoKey: "repo_docs",
        owner: "local",
        name: "tirion-docs",
        fullName: "local/tirion-docs"
      },
      filesChanged: []
    });
  });

  it("versions authoritative terminal corrections without re-emitting run-update", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const baseRun = productionRun({
      runId: "run_reprojected",
      queryId: "qry_reprojected",
      correlationId: "trace_reprojected",
      provider: "codex",
      runtime: "codex",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_reprojected", "qry_reprojected", ["artifact_src"], "repo_code")]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_code", root: "/tmp/code" }],
        relativePaths: () => ["src/answer.ts"]
      },
      recordEvent: (event) => diagnostics.push(event)
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([baseRun]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);

    await service.observeCompletedRuns([{
      ...baseRun,
      outputTokens: 2,
      totalTokens: 12,
      endedAt: "2026-06-08T00:00:03.000Z"
    }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended",
      "run.ended"
    ]);
    const runEndedVersions = received
      .filter((event) => (event as { eventType?: string }).eventType === "run.ended")
      .map((event) => (event as {
        version?: number;
        totalTokens?: number;
        endedAt?: string;
        activity?: Array<{ totalTokens?: number }>;
      }));
    expect(runEndedVersions).toEqual([
      expect.objectContaining({
        version: 1,
        totalTokens: 15,
        endedAt: "2026-06-08T00:00:02.000Z",
        activity: [expect.objectContaining({ totalTokens: 15 })]
      }),
      expect.objectContaining({
        version: 2,
        totalTokens: 12,
        endedAt: "2026-06-08T00:00:03.000Z",
        activity: [expect.objectContaining({ totalTokens: 12 })]
      })
    ]);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "queue",
        state: "suppressed",
        reason: "run_update_after_run_ended_suppressed",
        runId: "run_reprojected"
      })
    ]));
  });

  it("does not publish duplicate terminal meaning when projections alternate", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const run = productionRun({
      runId: "run_terminal_alternating",
      queryId: "qry_terminal_alternating",
      correlationId: "trace_terminal_alternating",
      provider: "codex",
      runtime: "codex",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const projectionA: ProductionRunV1 = {
      ...run,
      reasoningOutputTokens: 81,
      usageValueNanoUsd: 100,
      context: {
        schemaVersion: 1,
        accumulatedInputTokens: 10,
        initialInputContextTokens: 10,
        latestInputContextTokens: 10,
        peakInputContextTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        observedLlmRequestCount: 1,
        contextGrowthInputTokens: 0,
        contextGrowthRatio: 1,
        basis: "derived_from_usage_atoms",
        coverage: "final"
      },
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_terminal_a",
        kind: "tool",
        name: "Bash",
        count: 1,
        failureCount: 0,
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }]
    };
    const projectionB: ProductionRunV1 = {
      ...run,
      context: {
        schemaVersion: 1,
        accumulatedInputTokens: 10,
        initialInputContextTokens: 4,
        latestInputContextTokens: 6,
        peakInputContextTokens: 6,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        observedLlmRequestCount: 3,
        contextGrowthInputTokens: 2,
        contextGrowthRatio: 1.5,
        basis: "derived_from_usage_atoms",
        coverage: "final"
      },
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_terminal_b",
        kind: "skill",
        name: "release-check",
        count: 1,
        failureCount: 0,
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }, {
        schemaVersion: 1,
        breakdownId: "brk_terminal_b_read",
        kind: "tool",
        name: "Read",
        count: 1,
        failureCount: 0,
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }]
    };
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_terminal_alternating",
          "qry_terminal_alternating",
          ["artifact_src"],
          "repo_code"
        )]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_code", root: "/tmp/code" }],
        relativePaths: () => ["src/answer.ts"]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([projectionA]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    await service.observeCompletedRuns([projectionB]);
    await waitUntil(() => received.filter((event) => (event as { eventType?: string }).eventType === "run.ended").length === 2);
    await service.observeCompletedRuns([projectionA]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const ended = received.filter((event) =>
      (event as { eventType?: string }).eventType === "run.ended"
    ) as Array<{
      eventId: string;
      version: number;
      reasoningOutputTokens: number;
      activity: Array<{ name: string }>;
    }>;
    expect(ended).toHaveLength(2);
    expect(ended.map((event) => event.version)).toEqual([1, 2]);
    expect(ended.map((event) => event.reasoningOutputTokens)).toEqual([81, 81]);
    expect(ended[1].activity.map((activity) => activity.name)).toEqual(expect.arrayContaining([
      "Bash",
      "Read",
      "release-check",
      "Unallocated run usage"
    ]));
    const meaning = ended.map(({ eventId: _eventId, version: _version, ...event }) => JSON.stringify(event));
    expect(new Set(meaning).size).toBe(2);
  });

  it("serializes concurrent terminal projections into one delivery", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const run = productionRun({
      runId: "run_terminal_concurrent",
      queryId: "qry_terminal_concurrent",
      correlationId: "trace_terminal_concurrent",
      provider: "codex",
      runtime: "codex",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_terminal_concurrent",
          "qry_terminal_concurrent",
          ["artifact_src"],
          "repo_code"
        )]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_code", root: "/tmp/code" }],
        relativePaths: () => ["src/answer.ts"]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await Promise.all(Array.from({ length: 8 }, () => service.observeCompletedRuns([run])));
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);
  });

  it("does not lose a terminal replacement queued during HTTP delivery", async () => {
    const received: unknown[] = [];
    let firstTerminalStarted = false;
    let releaseFirstTerminal: (() => void) | undefined;
    const firstTerminalGate = new Promise<void>((resolve) => {
      releaseFirstTerminal = resolve;
    });
    const server = createServer((request, response) => {
      collectJson(request).then(async (body) => {
        received.push(body);
        if ((body as { eventType?: string }).eventType === "run.ended" && !firstTerminalStarted) {
          firstTerminalStarted = true;
          await firstTerminalGate;
        }
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const initial = productionRun({
      runId: "run_terminal_inflight",
      queryId: "qry_terminal_inflight",
      correlationId: "trace_terminal_inflight",
      provider: "codex",
      runtime: "codex",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const replacement: ProductionRunV1 = {
      ...initial,
      inputTokens: 20,
      outputTokens: 4,
      totalTokens: 24,
      reasoningOutputTokens: 7
    };
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_terminal_inflight",
          "qry_terminal_inflight",
          ["artifact_src"],
          "repo_code"
        )]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_code", root: "/tmp/code" }],
        relativePaths: () => ["src/answer.ts"]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    const initialProjection = service.observeCompletedRuns([initial]);
    await waitUntil(() => firstTerminalStarted);
    const replacementProjection = service.observeCompletedRuns([replacement]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirstTerminal?.();
    await Promise.all([initialProjection, replacementProjection]);
    await service.observeCompletedRuns([replacement]);
    await waitUntil(() => received.filter((event) =>
      (event as { eventType?: string }).eventType === "run.ended"
    ).length === 2);

    const ended = received.filter((event) =>
      (event as { eventType?: string }).eventType === "run.ended"
    ) as Array<{ version: number; totalTokens: number; reasoningOutputTokens: number }>;
    expect(ended).toEqual([
      expect.objectContaining({ version: 1, totalTokens: 12 }),
      expect.objectContaining({ version: 2, totalTokens: 24, reasoningOutputTokens: 7 })
    ]);
  });

  it("replaces pending run-ended projections for the same subject before delivery", async () => {
    const baseRun = productionRun({
      runId: "run_pending_replacement",
      queryId: "qry_pending_replacement",
      correlationId: "trace_pending_replacement",
      provider: "codex",
      runtime: "codex",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_pending_replacement", "qry_pending_replacement", ["artifact_src"], "repo_code")]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_code", root: "/tmp/code" }],
        relativePaths: () => ["src/answer.ts"]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: "http://127.0.0.1:9/hooks" });
    await service.observeCompletedRuns([baseRun]);
    await service.observeCompletedRuns([{
      ...baseRun,
      outputTokens: 5,
      totalTokens: 15,
      endedAt: "2026-06-08T00:00:03.000Z"
    }]);
    await service.observeCompletedRuns([{
      ...baseRun,
      outputTokens: 8,
      totalTokens: 18,
      endedAt: "2026-06-08T00:00:04.000Z"
    }]);

    const status = await service.status();
    const pendingRunEnded = status.queuedItems.filter((item) =>
      item.eventType === "run.ended"
      && item.subjectId === "run.ended:run_pending_replacement"
    );
    expect(pendingRunEnded).toHaveLength(1);
  });

  it("allows late same-subject file evidence to correct an already delivered terminal", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    let artifactKeys = ["artifact_src"];
    const baseRun: ProductionRunV1 = {
      ...productionRun({
        runId: "run_delivered_files_stable",
        queryId: "qry_delivered_files_stable",
        correlationId: "trace_delivered_files_stable",
        provider: "codex",
        runtime: "codex",
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:02.000Z"
      }),
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_write_delivered_files_stable",
        kind: "tool",
        name: "Write",
        count: 1,
        failureCount: 0,
        totalDurationMs: 10,
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }]
    };
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_delivered_files_stable", "qry_delivered_files_stable", artifactKeys, "repo_code")]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_code", root: "/tmp/code" }],
        relativePaths: (_repoKey, keys) => keys.map((key) => key === "artifact_src" ? "src/answer.ts" : "src/later.ts")
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([baseRun]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    artifactKeys = ["artifact_src", "artifact_later"];
    await service.observeCompletedRuns([{
      ...baseRun,
      outputTokens: 5,
      totalTokens: 15,
      endedAt: "2026-06-08T00:00:03.000Z"
    }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const endedEvents = received
      .filter((event) => (event as { eventType?: string }).eventType === "run.ended")
      .map((event) => event as { version?: number; filesChanged?: string[] });
    expect(endedEvents).toEqual([
      expect.objectContaining({ version: 1, filesChanged: ["src/answer.ts"] }),
      expect.objectContaining({ version: 2, filesChanged: ["src/answer.ts", "src/later.ts"] })
    ]);
  });

  it("does not regress delivered terminal repository or files during late commit reconciliation", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const run: ProductionRunV1 = {
      ...productionRun({
        runId: "run_terminal_nonregression",
        queryId: "qry_terminal_nonregression",
        correlationId: "trace_terminal_nonregression",
        provider: "claude-code",
        runtime: "claude-code",
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:02.000Z"
      }),
      repositoryKey: "repo_code",
      breakdown: [{
        schemaVersion: 1,
        breakdownId: "brk_terminal_nonregression",
        kind: "tool",
        name: "Write",
        count: 1,
        failureCount: 0,
        totalDurationMs: 10,
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }]
    };
    const episode = workEpisode(run.runId, run.queryId!, ["artifact_src"], "repo_code");
    const summary = {
      ...commitSummary("active", 0),
      repoKey: "repo_code",
      episodeIds: [episode.episodeId],
      queryIds: [run.queryId!],
      runIds: [run.runId],
      anchorQueryIds: [run.queryId!],
      inheritedQueryIds: []
    };
    const snapshot = { ...commitSnapshot("active", 0, "2026-06-08T00:00:03.000Z"), repoKey: "repo_code" };
    let repositoryVisible = true;
    const { service, storage } = await testService({
      attribution: {
        listWorkEpisodes: async () => [episode],
        listCommitAttributions: async () => [summary],
        listCommitPublicationSnapshots: async () => [snapshot]
      },
      repositories: {
        listRepositories: async () => repositoryVisible
          ? [{ repoKey: "repo_code", root: "/tmp/claude-code-repo" }]
          : [],
        relativePaths: () => repositoryVisible ? ["src/answer.ts"] : [],
        resolveGitHubRepository: async () => undefined
      }
    });
    await storage.replaceProductionRuns([run]);
    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([run]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    repositoryVisible = false;
    await service.reconcileCommitEvents();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const endedEvents = received.filter((event) =>
      (event as { eventType?: string }).eventType === "run.ended"
    ) as Array<{
      repository: { repoKey: string; owner: string; name: string; fullName: string };
      filesChanged: string[];
      version: number;
    }>;
    expect(endedEvents).toEqual([expect.objectContaining({
      version: 1,
      repository: expect.objectContaining({
        repoKey: "repo_code",
        name: "claude-code-repo",
        fullName: "local/claude-code-repo"
      }),
      filesChanged: ["src/answer.ts"]
    })]);
  });

  it("does not turn a delivered read-only Codex terminal into a writer without write activity", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    let now = Date.parse("2026-06-08T00:00:00.000Z");
    let artifactKeys: string[] = [];
    const readOnlyRun = productionRun({
      runId: "run_delivered_read_only",
      queryId: "qry_delivered_read_only",
      correlationId: "trace_delivered_read_only",
      provider: "codex",
      runtime: "codex",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_delivered_read_only", "qry_delivered_read_only", artifactKeys, "repo_code")]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_code", root: "/tmp/code" }],
        relativePaths: (_repoKey, keys) => keys.map(() => "src/later.ts")
      },
      now: () => now,
      recordEvent: (event) => diagnostics.push(event)
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([readOnlyRun]);
    now += 16_000;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    artifactKeys = ["artifact_later"];
    await service.observeCompletedRuns([{
      ...readOnlyRun,
      outputTokens: 5,
      totalTokens: 15,
      endedAt: "2026-06-08T00:00:03.000Z"
    }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received.filter((event) => (event as { eventType?: string }).eventType === "run.ended")).toHaveLength(1);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "queue",
        state: "blocked",
        reason: "webhook_run_delivered_read_only_files_changed_without_write_activity",
        runId: "run_delivered_read_only"
      })
    ]));
  });

  it("suppresses stale pending run-update retries after run-ended is delivered", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    let failUpdates = true;
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = failUpdates && (body as { eventType?: string }).eventType === "run.update" ? 500 : 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    let now = Date.parse("2026-06-08T00:00:10.000Z");
    const run = productionRun({
      runId: "run_retry_stale_update",
      queryId: "qry_retry_stale_update",
      correlationId: "trace_retry_stale_update",
      provider: "codex",
      runtime: "codex",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_retry_stale_update", "qry_retry_stale_update", ["artifact_src"], "repo_code")]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_code", root: "/tmp/code" }],
        relativePaths: () => ["src/answer.ts"]
      },
      now: () => now,
      recordEvent: (event) => diagnostics.push(event)
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([run]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);

    failUpdates = false;
    now += 31_000;
    await service.retryNow();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);
    await expect(service.status()).resolves.toMatchObject({
      queuedCount: 0,
      blockedCount: 0
    });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "delivery",
        state: "suppressed",
        reason: "run_update_after_run_ended_suppressed",
        runId: "run_retry_stale_update"
      })
    ]));
  });

  it("collapses multi-turn Codex episodes into one accurate run-ended webhook", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const runs = [
      {
        ...productionRun({
        runId: "run_codex_read_turn",
        queryId: "qry_codex_read_turn",
        correlationId: "trace_codex_read_turn",
        provider: "codex",
        runtime: "codex",
        inputTokens: 40,
        outputTokens: 5,
        totalTokens: 45,
        estimatedNanoUsd: 100_000,
        costEstimateBasis: "catalog_estimate",
        startedAt: "2026-06-08T00:10:00.000Z",
        endedAt: "2026-06-08T00:10:02.000Z",
        models: ["gpt-5.3-codex"],
        sessionId: "ses_codex_exec"
        }),
        toolCallCount: 2,
        breakdown: [{
          schemaVersion: 1 as const,
          breakdownId: "brk_codex_read",
          kind: "tool" as const,
          name: "Read",
          count: 2,
          failureCount: 0,
          attributionBasis: "activity_only" as const,
          coverage: "unavailable" as const
        }]
      },
      {
        ...productionRun({
        runId: "run_codex_write_turn",
        queryId: "qry_codex_write_turn",
        correlationId: "trace_codex_write_turn",
        provider: "codex",
        runtime: "codex",
        inputTokens: 60,
        outputTokens: 15,
        totalTokens: 75,
        estimatedNanoUsd: 200_000,
        costEstimateBasis: "catalog_estimate",
        startedAt: "2026-06-08T00:10:03.000Z",
        endedAt: "2026-06-08T00:10:07.000Z",
        models: ["gpt-5.4-codex"],
        sessionId: "ses_codex_exec"
        }),
        toolCallCount: 2,
        breakdown: [{
          schemaVersion: 1 as const,
          breakdownId: "brk_codex_write",
          kind: "tool" as const,
          name: "Write",
          count: 1,
          failureCount: 0,
          attributionBasis: "activity_only" as const,
          coverage: "unavailable" as const
        }, {
          schemaVersion: 1 as const,
          breakdownId: "brk_codex_reviewer",
          kind: "subagent" as const,
          name: "reviewer",
          count: 1,
          failureCount: 0,
          inputTokens: 30,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 35,
          attributionBasis: "trace_descendant" as const,
          coverage: "complete" as const
        }]
      },
      {
        ...productionRun({
        runId: "run_codex_config_turn",
        queryId: "qry_codex_config_turn",
        correlationId: "trace_codex_config_turn",
        provider: "codex",
        runtime: "codex",
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
        estimatedNanoUsd: 50_000,
        costEstimateBasis: "catalog_estimate",
        startedAt: "2026-06-08T00:10:04.000Z",
        endedAt: "2026-06-08T00:10:08.000Z",
        models: ["gpt-5.4-codex"],
        sessionId: "ses_codex_exec"
        }),
        toolCallCount: 1,
        breakdown: [{
          schemaVersion: 1 as const,
          breakdownId: "brk_codex_skill",
          kind: "skill" as const,
          name: "verification",
          count: 1,
          failureCount: 0,
          inputTokens: 5,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 6,
          attributionBasis: "trace_descendant" as const,
          coverage: "complete" as const
        }]
      }
    ];
    const episode = workEpisodeWithEvidence({
      episodeId: "episode_codex_exec",
      repoKey: "repo_tirion",
      chatSessionId: "ses_codex_exec",
      runIds: runs.map((run) => run.runId),
      queryIds: runs.map((run) => run.queryId),
      evidence: [
        { runId: "run_codex_read_turn", queryId: "qry_codex_read_turn", artifactKeys: [] },
        { runId: "run_codex_write_turn", queryId: "qry_codex_write_turn", artifactKeys: ["artifact_answer", "artifact_readme"] },
        { runId: "run_codex_config_turn", queryId: "qry_codex_config_turn", artifactKeys: ["artifact_settings"] }
      ]
    });
    const { service, storage } = await testService({
      attribution: {
        listWorkEpisodes: async () => [episode]
      },
      repositories: {
        relativePaths: (_repoKey, artifactKeys) => artifactKeys.map((artifactKey) => ({
          artifact_answer: "src/answer.ts",
          artifact_readme: "README.md",
          artifact_settings: "config/settings.json"
        }[artifactKey] ?? artifactKey)),
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      }
    });
    await storage.replaceProductionRuns(runs);

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns(runs);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);
    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.ended")).toMatchObject({
      eventType: "run.ended",
      runId: "episode_codex_exec",
      sessionId: "ses_codex_exec",
      traceIds: ["trace_codex_config_turn", "trace_codex_read_turn", "trace_codex_write_turn"],
      codingHarness: "codex",
      runtime: "codex",
      startedAt: "2026-06-08T00:10:00.000Z",
      endedAt: "2026-06-08T00:10:08.000Z",
      inputTokens: 110,
      outputTokens: 23,
      totalTokens: 133,
      llmModels: ["gpt-5.3-codex", "gpt-5.4-codex"],
      filesChanged: ["README.md", "config/settings.json", "src/answer.ts"],
      estimatedNanoUsd: 350_000,
      costEstimateBasis: "catalog_estimate",
      costCoverage: "complete",
      activity: expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "Read", count: 2 }),
        expect.objectContaining({ kind: "tool", name: "Write", count: 1 }),
        expect.objectContaining({
          kind: "subagent",
          name: "reviewer",
          count: 1,
          inputTokens: 30,
          outputTokens: 5,
          usageAttributionBasis: "trace_descendant",
          usageCoverage: "complete"
        }),
        expect.objectContaining({ kind: "skill", name: "verification", count: 1 }),
        expect.objectContaining({
          kind: "unknown",
          name: "Unallocated run usage",
          count: 3,
          inputTokens: 75,
          outputTokens: 17,
          totalTokens: 92,
          usageAttributionBasis: "unavailable",
          usageCoverage: "partial"
        })
      ])
    });
  });

  it("keeps live Codex child fragments and completed aggregation on one lifecycle subject", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const sessionId = "ses_codex_desktop";
    const promptQueryId = "qry_codex_desktop_prompt";
    const childQueryId = "qry_codex_desktop_child";
    const subjectRunId = "run_codex_desktop_prompt";
    const childRunId = "run_codex_desktop_child";
    const runs = [
      productionRun({
        runId: subjectRunId,
        queryId: promptQueryId,
        correlationId: "trace_codex_desktop_prompt",
        provider: "codex",
        runtime: "codex",
        inputTokens: 25,
        outputTokens: 5,
        totalTokens: 30,
        estimatedNanoUsd: 90_000,
        costEstimateBasis: "catalog_estimate",
        startedAt: "2026-06-08T01:00:00.000Z",
        endedAt: "2026-06-08T01:00:10.000Z",
        models: ["gpt-5.4-codex"],
        sessionId
      }),
      productionRun({
        runId: childRunId,
        queryId: childQueryId,
        correlationId: "trace_codex_desktop_child",
        provider: "codex",
        runtime: "codex",
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        estimatedNanoUsd: 260_000,
        costEstimateBasis: "catalog_estimate",
        startedAt: "2026-06-08T01:00:02.000Z",
        endedAt: "2026-06-08T01:00:14.000Z",
        models: ["gpt-5.4-codex"],
        sessionId
      })
    ];
    const episode = workEpisodeWithEvidence({
      episodeId: "episode_codex_desktop",
      repoKey: "repo_tirion",
      chatSessionId: sessionId,
      runIds: runs.map((run) => run.runId),
      queryIds: runs.map((run) => run.queryId),
      evidence: [
        { runId: subjectRunId, queryId: promptQueryId, artifactKeys: [] },
        { runId: childRunId, queryId: childQueryId, artifactKeys: ["artifact_answer"] }
      ]
    });
    const { service, storage } = await testService({
      attribution: {
        listWorkEpisodes: async () => [episode]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_tirion", root: "/tmp/tirion" }],
        relativePaths: () => ["src/answer.ts"],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      recordEvent: (event) => diagnostics.push(event)
    });
    await storage.replaceProductionRuns(runs);

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveCodexPromptObservation(promptQueryId, sessionId, "2026-06-08T01:00:00.000Z"));
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.start"));
    await service.observeSafeObservation(liveCodexSkillMetricObservation(childQueryId, sessionId, "2026-06-08T01:00:03.000Z"));
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.update"));
    await service.observeCompletedRuns(runs);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.update",
      "run.ended"
    ]);
    expect([...new Set(received.map((event) => (event as { runId?: string }).runId).filter((runId): runId is string => Boolean(runId)))].sort())
      .toEqual([subjectRunId]);
    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.update")).toMatchObject({
      eventType: "run.update",
      runId: subjectRunId,
      sessionId,
      activity: [expect.objectContaining({
        kind: "skill",
        name: "tirion-codex-stress-skill"
      })]
    });
    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.ended")).toMatchObject({
      eventType: "run.ended",
      runId: subjectRunId,
      sessionId,
      inputTokens: 105,
      outputTokens: 25,
      totalTokens: 130,
      filesChanged: ["src/answer.ts"],
      version: 1
    });
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "queue",
        state: "blocked",
        reason: "run_update_waiting_for_start"
      })
    ]));
  });

  it("emits later Codex completed runs even when the same session episode already delivered a terminal", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const first = productionRun({
      runId: "run_codex_first_prompt",
      queryId: "qry_codex_first_prompt",
      correlationId: "trace_codex_first_prompt",
      provider: "codex",
      runtime: "codex",
      inputTokens: 40,
      outputTokens: 5,
      totalTokens: 45,
      estimatedNanoUsd: 100_000,
      costEstimateBasis: "catalog_estimate",
      startedAt: "2026-06-08T00:10:00.000Z",
      endedAt: "2026-06-08T00:10:02.000Z",
      models: ["gpt-5.4-codex"],
      sessionId: "ses_codex_thread"
    });
    const later = productionRun({
      runId: "run_codex_later_prompt",
      queryId: "qry_codex_later_prompt",
      correlationId: "trace_codex_later_prompt",
      provider: "codex",
      runtime: "codex",
      inputTokens: 90,
      outputTokens: 11,
      totalTokens: 101,
      estimatedNanoUsd: 250_000,
      costEstimateBasis: "catalog_estimate",
      startedAt: "2026-06-08T00:42:00.000Z",
      endedAt: "2026-06-08T00:42:08.000Z",
      models: ["gpt-5.4-codex"],
      sessionId: "ses_codex_thread"
    });
    let episode = workEpisodeWithEvidence({
      episodeId: "episode_codex_thread",
      repoKey: "repo_tirion",
      chatSessionId: "ses_codex_thread",
      runIds: [first.runId],
      queryIds: [first.queryId],
      evidence: [
        { runId: first.runId, queryId: first.queryId!, artifactKeys: ["artifact_first"] }
      ]
    });
    const { service, storage } = await testService({
      attribution: {
        listWorkEpisodes: async () => [episode]
      },
      repositories: {
        relativePaths: (_repoKey, artifactKeys) => artifactKeys.map((artifactKey) => ({
          artifact_first: "src/first.ts",
          artifact_later: "src/later.ts"
        }[artifactKey] ?? artifactKey)),
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      recordEvent: (event) => diagnostics.push(event)
    });
    await storage.replaceProductionRuns([first]);

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([first]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    episode = workEpisodeWithEvidence({
      episodeId: "episode_codex_thread",
      repoKey: "repo_tirion",
      chatSessionId: "ses_codex_thread",
      runIds: [first.runId, later.runId],
      queryIds: [first.queryId, later.queryId],
      evidence: [
        { runId: first.runId, queryId: first.queryId!, artifactKeys: ["artifact_first"] },
        { runId: later.runId, queryId: later.queryId!, artifactKeys: ["artifact_later"] }
      ]
    });
    await storage.replaceProductionRuns([first, later]);
    await service.observeCompletedRuns([later]);
    await waitUntil(() => received.length === 6);

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended",
      "run.start",
      "run.update",
      "run.ended"
    ]);
    expect(received.map((event) => (event as { runId?: string }).runId)).toEqual([
      first.runId,
      first.runId,
      first.runId,
      later.runId,
      later.runId,
      later.runId
    ]);
    expect(received.at(-1)).toMatchObject({
      eventType: "run.ended",
      runId: later.runId,
      startedAt: later.startedAt,
      endedAt: later.endedAt,
      totalTokens: later.totalTokens,
      filesChanged: ["src/later.ts"]
    });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "fallback",
        reason: "codex_episode_terminal_subject_rotated_for_later_run",
        runId: later.runId,
        episodeId: "episode_codex_thread"
      })
    ]));
  });

  it("does not let a pending live Codex subject absorb later prompt files from the same episode", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const sessionId = "ses_codex_pending_thread";
    const first = productionRun({
      runId: "run_codex_pending_first",
      queryId: "qry_codex_pending_first",
      correlationId: "trace_codex_pending_first",
      provider: "codex",
      runtime: "codex",
      inputTokens: 40,
      outputTokens: 5,
      totalTokens: 45,
      estimatedNanoUsd: 100_000,
      startedAt: "2026-06-08T00:10:00.000Z",
      endedAt: "2026-06-08T00:10:05.000Z",
      sessionId
    });
    const later = productionRun({
      runId: "run_codex_pending_later",
      queryId: "qry_codex_pending_later",
      correlationId: "trace_codex_pending_later",
      provider: "codex",
      runtime: "codex",
      inputTokens: 90,
      outputTokens: 11,
      totalTokens: 101,
      estimatedNanoUsd: 250_000,
      startedAt: "2026-06-08T00:10:20.000Z",
      endedAt: "2026-06-08T00:10:28.000Z",
      sessionId
    });
    let episode = workEpisodeWithEvidence({
      episodeId: "episode_codex_pending_thread",
      repoKey: "repo_tirion",
      chatSessionId: sessionId,
      runIds: [first.runId],
      queryIds: [first.queryId],
      evidence: [
        { runId: first.runId, queryId: first.queryId!, artifactKeys: ["artifact_first"] }
      ]
    });
    const { service, storage } = await testService({
      attribution: {
        listWorkEpisodes: async () => [episode]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_tirion", root: "/tmp/tirion" }],
        relativePaths: (_repoKey, artifactKeys) => artifactKeys.map((artifactKey) => ({
          artifact_first: "src/first.ts",
          artifact_later: "src/later.ts"
        }[artifactKey] ?? artifactKey)),
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      }
    });
    await storage.replaceProductionRuns([first]);

    await service.observeSafeObservation(liveCodexPromptObservation(first.queryId!, sessionId, "2026-06-08T00:10:00.000Z"));
    await service.observeCompletedRuns([first]);

    episode = workEpisodeWithEvidence({
      episodeId: "episode_codex_pending_thread",
      repoKey: "repo_tirion",
      chatSessionId: sessionId,
      runIds: [first.runId, later.runId],
      queryIds: [first.queryId, later.queryId],
      evidence: [
        { runId: first.runId, queryId: first.queryId!, artifactKeys: ["artifact_first"] },
        { runId: later.runId, queryId: later.queryId!, artifactKeys: ["artifact_later"] }
      ]
    });
    await storage.replaceProductionRuns([first, later]);
    await service.observeSafeObservation(liveCodexPromptObservation(later.queryId!, sessionId, "2026-06-08T00:10:20.000Z"));
    await service.observeCompletedRuns([first]);
    await service.observeCompletedRuns([later]);

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.retryNow();
    await waitUntil(() =>
      received.filter((event) => (event as { eventType?: string }).eventType === "run.ended").length >= 2
    );

    const endedEvents = received
      .filter((event) => (event as { eventType?: string }).eventType === "run.ended")
      .map((event) => event as { runId: string; filesChanged?: string[] });
    expect(endedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: first.runId,
        filesChanged: ["src/first.ts"]
      }),
      expect.objectContaining({
        runId: later.runId,
        filesChanged: ["src/later.ts"]
      })
    ]));
    expect(endedEvents.find((event) => event.runId === first.runId)?.filesChanged).not.toContain("src/later.ts");
  });

  it("suppresses live Codex lifecycle replay after an episode-terminal run-ended delivery", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const run = productionRun({
      runId: "run_codex_public",
      queryId: "qry_codex_public",
      correlationId: "trace_codex_public",
      provider: "codex",
      runtime: "codex",
      inputTokens: 40,
      outputTokens: 5,
      totalTokens: 45,
      estimatedNanoUsd: 100_000,
      startedAt: "2026-06-08T00:10:00.000Z",
      endedAt: "2026-06-08T00:10:02.000Z",
      sessionId: "ses_codex_public"
    });
    const episode = workEpisodeWithEvidence({
      episodeId: "episode_codex_public",
      repoKey: "repo_tirion",
      chatSessionId: "ses_codex_public",
      runIds: [run.runId],
      queryIds: [run.queryId],
      evidence: [
        { runId: run.runId, queryId: run.queryId!, artifactKeys: ["artifact_answer"] }
      ]
    });
    const { service, storage } = await testService({
      attribution: {
        listWorkEpisodes: async () => [episode]
      },
      repositories: {
        listRepositories: async () => [{ repoKey: "repo_tirion", root: "/tmp/tirion" }],
        relativePaths: () => ["src/answer.ts"],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      recordEvent: (event) => diagnostics.push(event)
    });
    await storage.replaceProductionRuns([run]);

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([run]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);

    const toolReplay = liveToolObservation("qry_codex_public", "ses_codex_public", "2026-06-08T00:10:04.000Z");
    await service.observeSafeObservation(liveCodexPromptObservation("qry_codex_public", "ses_codex_public", "2026-06-08T00:10:03.000Z"));
    await service.observeSafeObservation({
      ...toolReplay,
      sourceId: "hook_codex_tools",
      provider: "codex",
      runtime: "codex",
      profileVersion: "codex-hooks-v1",
      activityAtoms: (toolReplay.activityAtoms ?? []).map((activity) => ({
        ...activity,
        provider: "codex",
        runtime: "codex"
      })),
      executionNodes: (toolReplay.executionNodes ?? []).map((node) => ({
        ...node,
        provider: "codex",
        runtime: "codex"
      }))
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received.map((event) => (event as { eventType?: string }).eventType)).toEqual([
      "run.start",
      "run.update",
      "run.ended"
    ]);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "queue",
        state: "suppressed",
        reason: "run_start_after_run_ended_suppressed",
        runId: "run_codex_public"
      }),
      expect.objectContaining({
        construct: "ExternalWebhookDispatch",
        operation: "queue",
        state: "suppressed",
        reason: "run_update_after_run_ended_suppressed",
        runId: "run_codex_public"
      })
    ]));
  });

  it("fails closed instead of dispatching run-ended webhooks for ambiguous repository bindings", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisodeWithEvidence({
          episodeId: "episode_ambiguous",
          repoKey: "repo_a",
          repoKeys: ["repo_a", "repo_b"],
          runIds: ["run_ambiguous"],
          queryIds: ["qry_ambiguous"],
          evidence: [
            { runId: "run_ambiguous", queryId: "qry_ambiguous", repoKey: "repo_a", artifactKeys: ["artifact_a"] },
            { runId: "run_ambiguous", queryId: "qry_ambiguous", repoKey: "repo_b", artifactKeys: ["artifact_b"] }
          ]
        })]
      },
      recordEvent: (event) => diagnostics.push(event)
    });

    await service.configureUrl({ schemaVersion: 1, url: "http://127.0.0.1:9/hooks" });
    await service.observeCompletedRuns([productionRun({
      runId: "run_ambiguous",
      queryId: "qry_ambiguous",
      correlationId: "trace_ambiguous",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:20:00.000Z",
      endedAt: "2026-06-08T00:20:01.000Z"
    })]);

    await expect(service.status()).resolves.toMatchObject({
      queuedCount: 0,
      blockedCount: 0,
      deliveredCount: 0
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      construct: "ExternalWebhookDispatch",
      operation: "projection",
      state: "blocked",
      reason: "run_webhook_repository_binding_ambiguous",
      runId: "run_ambiguous"
    }));
  });

  it("uses query-specific evidence when a wider episode spans multiple repositories", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisodeWithEvidence({
          episodeId: "episode_multi_repo",
          repoKey: "repo_a",
          repoKeys: ["repo_a", "repo_b"],
          runIds: ["run_query_a", "run_query_b"],
          queryIds: ["qry_query_a", "qry_query_b"],
          evidence: [
            { runId: "run_query_a", queryId: "qry_query_a", repoKey: "repo_a", artifactKeys: ["artifact_a"] },
            { runId: "run_query_b", queryId: "qry_query_b", repoKey: "repo_b", artifactKeys: ["artifact_b"] }
          ]
        })]
      },
      repositories: {
        relativePaths: () => ["tirion-webhook-smoke-2.txt"],
        resolveGitHubRepository: async () => undefined,
        listRepositories: async () => [{ root: "/tmp/tirion_local_log_server", repoKey: "repo_a" }]
      }
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([productionRun({
      runId: "run_query_a",
      queryId: "qry_query_a",
      correlationId: "trace_query_a",
      provider: "codex",
      runtime: "codex",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:20:00.000Z",
      endedAt: "2026-06-08T00:20:01.000Z"
    })]);

    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));

    const ended = received.find((event) => (event as { eventType?: string }).eventType === "run.ended");
    expect(ended).toMatchObject({
      eventType: "run.ended",
      repository: {
        repoKey: "repo_a",
        fullName: "local/tirion_local_log_server"
      },
      filesChanged: ["tirion-webhook-smoke-2.txt"]
    });
  });

  it("blocks privacy-invalid changed-file paths before outbound delivery", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode("run_privacy", "qry_privacy", ["artifact_secret"], "repo_tirion")]
      },
      repositories: {
        relativePaths: () => ["/Users/asafaltagar/Documents/Tirion/src/secret.ts"],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      recordEvent: (event) => diagnostics.push(event)
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([productionRun({
      runId: "run_privacy",
      queryId: "qry_privacy",
      correlationId: "trace_privacy",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:21:00.000Z",
      endedAt: "2026-06-08T00:21:01.000Z"
    })]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual([]);
    await expect(service.status()).resolves.toMatchObject({
      queuedCount: 0,
      blockedCount: 0,
      deliveredCount: 0
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      construct: "ExternalWebhookDispatch",
      operation: "queue",
      state: "blocked",
      reason: "webhook_privacy_validation_failed",
      runId: "run_privacy",
      details: expect.objectContaining({
        filesChangedCount: 1,
        invalidFilesChangedCount: 1,
        hasAbsoluteFilesChangedPath: true
      })
    }));
  });

  it("drops unsafe changed-file path projections when safe repo-relative paths remain", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const { service } = await testService({
      attribution: {
        listWorkEpisodes: async () => [workEpisode(
          "run_mixed_paths",
          "qry_mixed_paths",
          ["artifact_answer", "artifact_settings", "artifact_absolute"],
          "repo_tirion"
        )]
      },
      repositories: {
        relativePaths: () => [
          "src/answer.ts",
          "config/settings.json",
          "/Users/asafaltagar/Documents/Tirion/src/secret.ts"
        ],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      recordEvent: (event) => diagnostics.push(event)
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeCompletedRuns([productionRun({
      runId: "run_mixed_paths",
      queryId: "qry_mixed_paths",
      correlationId: "trace_mixed_paths",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:21:00.000Z",
      endedAt: "2026-06-08T00:21:01.000Z"
    })]);

    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.ended")).toMatchObject({
      eventType: "run.ended",
      runId: "run_mixed_paths",
      filesChanged: ["config/settings.json", "src/answer.ts"]
    });
    expect(JSON.stringify(received)).not.toContain("/Users/");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      construct: "ExternalWebhookDispatch",
      operation: "projection",
      state: "warning",
      reason: "webhook_changed_file_path_dropped",
      repoKey: "repo_tirion",
      details: expect.objectContaining({
        projectedPathCount: 3,
        acceptedPathCount: 2,
        droppedPathCount: 1
      })
    }));
  });

  it("uses attribution-owned commit cost instead of recomputing from linked runs", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const runs = [
      productionRun({
        runId: "run_expensive_a",
        queryId: "qry_expensive_a",
        correlationId: "trace_expensive_a",
        provider: "claude-code",
        runtime: "claude-code",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        estimatedNanoUsd: 1_000_000,
        startedAt: "2026-06-08T00:30:00.000Z",
        endedAt: "2026-06-08T00:30:01.000Z"
      }),
      productionRun({
        runId: "run_expensive_b",
        queryId: "qry_expensive_b",
        correlationId: "trace_expensive_b",
        provider: "codex",
        runtime: "codex",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        estimatedNanoUsd: 2_000_000,
        startedAt: "2026-06-08T00:30:02.000Z",
        endedAt: "2026-06-08T00:30:03.000Z"
      })
    ];
    const storageRoot = mkdtempSync(join(tmpdir(), "tirion-webhook-dispatch-"));
    roots.push(storageRoot);
    const storage = serviceStorage(storageRoot);
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    await storage.replaceProductionRuns(runs);
    let now = Date.parse("2026-06-08T00:31:05.000Z");
    const service = new ExternalWebhookDispatchService(
      storage,
      { configurationPath: join(storageRoot, "webhook-config.json") },
      {
        listCommitAttributions: async () => [{
          ...commitSummary("active", 125_000),
          commitMessage: "Capture commit message in attribution webhook",
          runIds: ["run_expensive_a", "run_expensive_b"],
          queryIds: ["qry_expensive_a", "qry_expensive_b"]
        }],
        listCommitPublicationSnapshots: async () => [commitSnapshot("active", 125_000, "2026-06-08T00:31:00.000Z")],
        listWorkEpisodes: async () => [
          workEpisode("run_expensive_a", "qry_expensive_a", ["artifact_a"], "repo_tirion"),
          workEpisode("run_expensive_b", "qry_expensive_b", ["artifact_b"], "repo_tirion")
        ]
      } as unknown as AgentVerifiedAttributionService,
      {
        relativePaths: () => ["src/answer.ts"],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion"),
        listRepositories: async () => []
      } as unknown as AgentRepositoryObservationService,
      () => now
    );

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.reconcileCommitEvents();
    now += 5_000;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "commit.attributed"));

    expect(received.filter((event) => (event as { eventType?: string }).eventType === "run.ended")).toHaveLength(2);
    const commitAttributed = received.find((event) => (event as { eventType?: string }).eventType === "commit.attributed");
    expect(commitAttributed).toMatchObject({
      eventType: "commit.attributed",
      commitMessage: "Capture commit message in attribution webhook",
      runIds: ["run_expensive_a", "run_expensive_b"],
      estimatedNanoUsd: 125_000,
      costCoverage: "complete"
    });
  });

  it("emits commit-attributed events for verified GitHub Copilot write runs", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    let now = Date.parse("2026-06-08T00:03:00.000Z");
    const { service, storage } = await testService({
      attribution: {
        listCommitAttributions: async () => [{
          ...commitSummary("active", 42_000),
          queryIds: ["qry_copilot_write"],
          runIds: ["run_copilot_write"],
          linkedQueryCount: 1,
          anchorQueryIds: ["qry_copilot_write"],
          inheritedQueryIds: []
        }],
        listCommitPublicationSnapshots: async () => [commitSnapshot("active", 42_000, "2026-06-08T00:03:00.000Z")],
        listWorkEpisodes: async () => [{
          ...workEpisode("run_copilot_write", "qry_copilot_write", ["artifact_copilot_write"], "repo_tirion"),
          claimedByCommitHash: "a".repeat(40)
        }]
      },
      repositories: {
        relativePaths: () => ["src/copilot-write.ts"],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      now: () => now
    });
    await storage.replaceProductionRuns([productionRun({
      runId: "run_copilot_write",
      queryId: "qry_copilot_write",
      correlationId: "trace_copilot_write",
      provider: "github-copilot",
      runtime: "github-copilot",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      estimatedNanoUsd: 42_000,
      usageValueNanoUsd: 42_000,
      costEstimateBasis: "catalog_estimate",
      billingContext: "github-copilot",
      models: ["gpt-5.4"],
      startedAt: "2026-06-08T00:01:00.000Z",
      endedAt: "2026-06-08T00:01:05.000Z"
    })]);

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.reconcileCommitEvents();
    now += 5_000;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "commit.attributed"));

    expect(received.find((event) => (event as { eventType?: string }).eventType === "run.ended")).toMatchObject({
      eventType: "run.ended",
      runId: "run_copilot_write",
      codingHarness: "github-copilot",
      filesChanged: ["src/copilot-write.ts"]
    });
    expect(received.find((event) => (event as { eventType?: string }).eventType === "commit.attributed")).toMatchObject({
      eventType: "commit.attributed",
      commitSha: "a".repeat(40),
      runIds: ["run_copilot_write"],
      traceIds: ["trace_copilot_write"],
      estimatedNanoUsd: 42_000,
      usageValueNanoUsd: 42_000,
      costCoverage: "complete"
    });
    const payload = JSON.stringify(received);
    expect(payload).not.toContain("prompt text");
    expect(payload).not.toContain("/tmp/");
  });

  it("retries blocked webhook deliveries and emits versioned commit-attributed events only when downstream meaning changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-webhook-dispatch-"));
    roots.push(root);

    const runs = [
      productionRun({
        runId: "run_commit_a",
        queryId: "qry_commit_a",
        correlationId: "trace_commit_a",
        provider: "codex",
        runtime: "codex",
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        estimatedNanoUsd: 100_000,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:01.000Z"
      }),
      productionRun({
        runId: "run_commit_b",
        queryId: "qry_commit_b",
        correlationId: "trace_commit_b",
        provider: "claude-code",
        runtime: "claude-code",
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
        estimatedNanoUsd: 200_000,
        startedAt: "2026-06-08T00:01:00.000Z",
        endedAt: "2026-06-08T00:01:02.000Z"
      })
    ];
    const storage = serviceStorage(root);
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    await storage.replaceProductionRuns(runs);

    let summaries: CommitAttributionSummary[] = [commitSummary("active", 300_000)];
    let snapshots: CommitPublicationSnapshot[] = [commitSnapshot("active", 300_000, "2026-06-08T00:02:00.000Z")];
    let now = Date.parse("2026-06-08T00:10:00.000Z");
    const service = new ExternalWebhookDispatchService(
      storage,
      { configurationPath: join(root, "webhook-config.json") },
      {
        listCommitAttributions: async () => summaries,
        listCommitPublicationSnapshots: async () => snapshots,
        listWorkEpisodes: async () => [
          workEpisode("run_commit_a", "qry_commit_a", ["artifact_a"], "repo_tirion"),
          workEpisode("run_commit_b", "qry_commit_b", ["artifact_b"], "repo_tirion")
        ]
      } as unknown as AgentVerifiedAttributionService,
      {
        relativePaths: (_repoKey, artifactKeys) => artifactKeys.map((key) => `src/${key}.ts`),
        refresh: async () => undefined,
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion"),
        listRepositories: async () => []
      } as unknown as AgentRepositoryObservationService,
      () => now
    );

    await service.configureUrl({ schemaVersion: 1, url: "http://127.0.0.1:9/hooks" });
    await service.reconcileCommitEvents();
    now += 5_000;
    await service.retryNow();
    await service.retryNow();
    await expect(service.status()).resolves.toMatchObject({
      queuedCount: 7,
      blockedCount: 0,
      queuedItems: expect.arrayContaining([
        expect.objectContaining({ eventType: "commit.attributed", deliveryState: "retry", attempts: 2 })
      ])
    });

    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "commit.attributed"));
    expect(received.find((event) => (event as { eventType?: string }).eventType === "commit.attributed")).toMatchObject({
      eventType: "commit.attributed",
      commitSha: "a".repeat(40),
      runIds: ["run_commit_a", "run_commit_b"],
      traceIds: ["trace_commit_a", "trace_commit_b"],
      estimatedNanoUsd: 300_000,
      state: "active",
      version: 1
    });

    await service.reconcileCommitEvents();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.filter((event) => (event as { eventType?: string }).eventType === "commit.attributed")).toHaveLength(1);

    summaries = [commitSummary("superseded", 280_000)];
    snapshots = [commitSnapshot("superseded", 280_000, "2026-06-08T00:03:00.000Z")];
    await service.reconcileCommitEvents();
    now += 10_000;
    await service.retryNow();
    await waitUntil(() => received.some((event) =>
      (event as { eventType?: string; version?: number }).eventType === "commit.attributed"
      && (event as { version?: number }).version === 2
    ));
    expect(received.find((event) =>
      (event as { eventType?: string; version?: number }).eventType === "commit.attributed"
      && (event as { version?: number }).version === 2
    )).toMatchObject({
      eventType: "commit.attributed",
      commitSha: "a".repeat(40),
      estimatedNanoUsd: 280_000,
      state: "superseded",
      version: 2
    });
  });

  it("uses work evidence to populate commit-attributed run IDs before run-ended outbox projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-webhook-dispatch-"));
    roots.push(root);
    const runs = [
      productionRun({
        runId: "run_read_only",
        queryId: "qry_read_only",
        correlationId: "trace_read_only",
        provider: "claude-code",
        runtime: "claude-code",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimatedNanoUsd: 20_000,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:01.000Z"
      }),
      productionRun({
        runId: "run_write",
        queryId: "qry_write",
        correlationId: "trace_write",
        provider: "claude-code",
        runtime: "claude-code",
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        estimatedNanoUsd: 10_000,
        startedAt: "2026-06-08T00:01:00.000Z",
        endedAt: "2026-06-08T00:01:02.000Z"
      })
    ];
    const storage = serviceStorage(root);
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    await storage.replaceProductionRuns(runs);
    await storage.upsertAgentDocument("webhook_delivery_state", {
      key: "run.ended:run_read_only",
      sortAt: "2026-06-08T00:00:02.000Z",
      value: {
        schemaVersion: 1,
        subjectId: "run.ended:run_read_only",
        eventType: "run.ended",
        payloadHash: "read-only-payload",
        eventId: "evt_read_only",
        deliveredAt: "2026-06-08T00:00:02.000Z",
        filesChangedCount: 0,
        updatedAt: "2026-06-08T00:00:02.000Z"
      }
    });

    const summary: CommitAttributionSummary = {
      ...commitSummary("active", 10_000),
      queryIds: ["qry_read_only", "qry_write"],
      runIds: ["run_read_only"],
      linkedQueryCount: 2,
      anchorQueryIds: ["qry_write"],
      inheritedQueryIds: ["qry_read_only"]
    };
    let now = Date.parse("2026-06-08T00:02:00.000Z");
    let refreshed = false;
    const service = new ExternalWebhookDispatchService(
      storage,
      { configurationPath: join(root, "webhook-config.json") },
      {
        listCommitAttributions: async () => [summary],
        listCommitPublicationSnapshots: async () => [commitSnapshot("active", 10_000, "2026-06-08T00:02:00.000Z")],
        listWorkEpisodes: async () => [
          // Simulates a stale post-commit snapshot later matching an already delivered
          // read-only run. The explicit empty run.ended projection must remain authoritative.
          workEpisode("run_read_only", "qry_read_only", ["artifact_stale"], "repo_tirion"),
          {
            ...workEpisode("run_write", "qry_write", ["artifact_src"], "repo_tirion"),
            claimedByCommitHash: "a".repeat(40)
          }
        ]
      } as unknown as AgentVerifiedAttributionService,
      {
        relativePaths: () => refreshed ? ["src/answer.ts"] : [],
        refresh: async () => {
          refreshed = true;
        },
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion"),
        listRepositories: async () => []
      } as unknown as AgentRepositoryObservationService,
      () => now
    );

    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.reconcileCommitEvents();
    now += 5_000;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "commit.attributed"));

    const runEnded = received.find((event) => (event as { eventType?: string }).eventType === "run.ended");
    const commitAttributed = received.find((event) => (event as { eventType?: string }).eventType === "commit.attributed");
    expect(runEnded).toMatchObject({
      eventType: "run.ended",
      runId: "run_write",
      traceIds: ["trace_write"],
      filesChanged: ["src/answer.ts"]
    });
    expect(commitAttributed).toMatchObject({
      eventType: "commit.attributed",
      runIds: ["run_write"],
      traceIds: ["trace_write"],
      estimatedNanoUsd: 10_000,
      costCoverage: "complete"
    });
  });

  it("keeps claimed Codex read-only fragments out of commit-attributed write projections", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-webhook-dispatch-"));
    roots.push(root);
    const runs = [
      productionRun({
        runId: "run_codex_read_only",
        queryId: "qry_codex_read_only",
        correlationId: "trace_codex_read_only",
        provider: "codex",
        runtime: "codex",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        estimatedNanoUsd: 50_000,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:05:00.000Z"
      }),
      productionRun({
        runId: "run_codex_write",
        queryId: "qry_codex_write",
        correlationId: "trace_codex_write",
        provider: "codex",
        runtime: "codex",
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        estimatedNanoUsd: 10_000,
        startedAt: "2026-06-08T00:06:00.000Z",
        endedAt: "2026-06-08T00:06:02.000Z"
      })
    ];
    const storage = serviceStorage(root);
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    await storage.replaceProductionRuns(runs);
    await storage.upsertAgentDocument("webhook_delivery_state", {
      key: "run.ended:run_codex_read_only",
      sortAt: "2026-06-08T00:05:01.000Z",
      value: {
        schemaVersion: 1,
        subjectId: "run.ended:run_codex_read_only",
        eventType: "run.ended",
        payloadHash: "read-only-payload",
        eventId: "evt_read_only",
        deliveredAt: "2026-06-08T00:05:01.000Z",
        filesChangedCount: 0,
        updatedAt: "2026-06-08T00:05:01.000Z"
      }
    });

    const summary: CommitAttributionSummary = {
      ...commitSummary("active", 10_000),
      queryIds: ["qry_codex_read_only", "qry_codex_write"],
      runIds: ["run_codex_read_only", "run_codex_write"],
      linkedQueryCount: 2,
      anchorQueryIds: ["qry_codex_write"],
      inheritedQueryIds: ["qry_codex_read_only"]
    };
    let now = Date.parse("2026-06-08T00:07:00.000Z");
    const service = new ExternalWebhookDispatchService(
      storage,
      { configurationPath: join(root, "webhook-config.json") },
      {
        listCommitAttributions: async () => [summary],
        listCommitPublicationSnapshots: async () => [commitSnapshot("active", 10_000, "2026-06-08T00:07:00.000Z")],
        listWorkEpisodes: async () => [{
          ...workEpisodeWithEvidence({
            episodeId: "episode_codex_session",
            repoKey: "repo_tirion",
            chatSessionId: "session_codex",
            runIds: ["run_codex_read_only", "run_codex_write"],
            queryIds: ["qry_codex_read_only", "qry_codex_write"],
            evidence: [
              { runId: "run_codex_read_only", queryId: "qry_codex_read_only", artifactKeys: [] },
              { runId: "run_codex_write", queryId: "qry_codex_write", artifactKeys: ["artifact_src"] }
            ]
          }),
          claimedByCommitHash: "a".repeat(40)
        }]
      } as unknown as AgentVerifiedAttributionService,
      {
        relativePaths: (_repoKey, artifactKeys) => artifactKeys.map((key) => `src/${key}.ts`),
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion"),
        listRepositories: async () => []
      } as unknown as AgentRepositoryObservationService,
      () => now
    );

    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.reconcileCommitEvents();
    now += 5_000;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "commit.attributed"));

    const endedEvents = received.filter((event) => (event as { eventType?: string }).eventType === "run.ended");
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]).toMatchObject({
      eventType: "run.ended",
      runId: "episode_codex_session",
      filesChanged: ["src/artifact_src.ts"]
    });
    const commitAttributed = received.find((event) => (event as { eventType?: string }).eventType === "commit.attributed");
    expect(commitAttributed).toMatchObject({
      eventType: "commit.attributed",
      runIds: ["episode_codex_session"],
      traceIds: ["trace_codex_write"],
      estimatedNanoUsd: 10_000,
      costCoverage: "complete"
    });
  });

  it("publishes commit-attributed Codex fragment writes under the live public lifecycle subject", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-webhook-dispatch-"));
    roots.push(root);
    const run = productionRun({
      runId: "run_fragment",
      queryId: "qry_fragment",
      correlationId: "trace_fragment",
      provider: "codex",
      runtime: "codex",
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      estimatedNanoUsd: 10_000,
      startedAt: "2026-06-08T00:00:02.000Z",
      endedAt: "2026-06-08T00:00:20.000Z"
    });
    const storage = serviceStorage(root);
    storages.push(storage);
    await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
    await storage.replaceProductionRuns([run]);
    const summary: CommitAttributionSummary = {
      ...commitSummary("active", 10_000),
      queryIds: ["qry_fragment"],
      runIds: ["run_fragment"],
      linkedQueryCount: 1,
      anchorQueryIds: ["qry_fragment"],
      inheritedQueryIds: []
    };
    let now = Date.parse("2026-06-08T00:00:30.000Z");
    const service = new ExternalWebhookDispatchService(
      storage,
      { configurationPath: join(root, "webhook-config.json") },
      {
        listCommitAttributions: async () => [summary],
        listCommitPublicationSnapshots: async () => [commitSnapshot("active", 10_000, "2026-06-08T00:00:30.000Z")],
        listWorkEpisodes: async () => [{
          ...workEpisodeWithEvidence({
            episodeId: "episode_codex_public",
            repoKey: "repo_tirion",
            chatSessionId: "session_codex_public",
            runIds: ["run_public"],
            queryIds: ["qry_public"],
            evidence: [{
              runId: "run_fragment",
              queryId: "qry_fragment",
              artifactKeys: ["artifact_src"]
            }]
          }),
          claimedByCommitHash: "a".repeat(40)
        }]
      } as unknown as AgentVerifiedAttributionService,
      {
        relativePaths: (_repoKey, artifactKeys) => artifactKeys.map((key) => `src/${key}.ts`),
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion"),
        listRepositories: async () => [{
          repoKey: "repo_tirion",
          owner: "local",
          name: "Tirion",
          fullName: "local/Tirion",
          scopeId: "scope_tirion"
        }]
      } as unknown as AgentRepositoryObservationService,
      () => now
    );

    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.observeSafeObservation(liveCodexPromptObservation("qry_public", "session_codex_public", "2026-06-08T00:00:00.000Z"));
    await service.observeSafeObservation(liveUsageObservation({
      queryId: "qry_fragment",
      sessionId: "session_codex_public",
      observedAt: "2026-06-08T00:00:03.000Z",
      atomId: "fragment",
      inputTokens: 1,
      outputTokens: 1
    }));
    await service.reconcileCommitEvents();
    now += 20_000;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "commit.attributed"));

    const runEnded = received.find((event) =>
      (event as { eventType?: string; filesChanged?: string[] }).eventType === "run.ended"
      && (event as { filesChanged?: string[] }).filesChanged?.includes("src/artifact_src.ts")
    );
    expect(runEnded).toMatchObject({
      eventType: "run.ended",
      runId: "run_public",
      filesChanged: ["src/artifact_src.ts"]
    });
    const commitAttributed = received.find((event) => (event as { eventType?: string }).eventType === "commit.attributed");
    expect(commitAttributed).toMatchObject({
      eventType: "commit.attributed",
      runIds: ["run_public"],
      traceIds: ["trace_fragment"],
      estimatedNanoUsd: 10_000,
      costCoverage: "complete"
    });
  });

  it("does not emit commit-attributed events before production write run IDs are available", async () => {
    const diagnostics: DiagnosticEvent[] = [];
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const summary: CommitAttributionSummary = {
      ...commitSummary("active", 10_000),
      runIds: [],
      queryIds: ["qry_write"],
      anchorQueryIds: ["qry_write"],
      inheritedQueryIds: []
    };
    const { service } = await testService({
      attribution: {
        listCommitAttributions: async () => [summary],
        listCommitPublicationSnapshots: async () => [commitSnapshot("active", 10_000, "2026-06-08T00:02:00.000Z")],
        listWorkEpisodes: async () => [{
          ...workEpisode("run_write_missing_trace", "qry_write", ["artifact_src"], "repo_tirion"),
          claimedByCommitHash: "a".repeat(40)
        }]
      },
      repositories: {
        relativePaths: () => ["src/answer.ts"],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      recordEvent: (event) => diagnostics.push(event)
    });

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.reconcileCommitEvents();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      construct: "ExternalWebhookDispatch",
      operation: "projection",
      state: "blocked",
      reason: "commit_webhook_production_run_ids_unavailable",
      commitHash: "a".repeat(40)
    }));
  });

  it("emits commit-attributed events with production run IDs when hook-only writing IDs share the claim", async () => {
    const received: unknown[] = [];
    let now = Date.parse("2026-06-08T00:02:00.000Z");
    const server = createServer((request, response) => {
      collectJson(request).then((body) => {
        received.push(body);
        response.statusCode = 200;
        response.end("ok");
      });
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const summary: CommitAttributionSummary = {
      ...commitSummary("active", 10_000),
      runIds: ["run_write"],
      queryIds: ["qry_hook_only", "qry_write"],
      anchorQueryIds: ["qry_hook_only"],
      inheritedQueryIds: ["qry_write"]
    };
    const { storage, service } = await testService({
      attribution: {
        listCommitAttributions: async () => [summary],
        listCommitPublicationSnapshots: async () => [commitSnapshot("active", 10_000, "2026-06-08T00:02:00.000Z")],
        listWorkEpisodes: async () => [{
          ...workEpisodeWithEvidence({
            episodeId: "episode_mixed_run_ids",
            repoKey: "repo_tirion",
            runIds: ["run_hook_only", "run_write"],
            queryIds: ["qry_hook_only", "qry_write"],
            evidence: [
              { runId: "run_hook_only", queryId: "qry_hook_only", artifactKeys: ["src/answer.ts"] },
              { runId: "run_write", queryId: "qry_write", artifactKeys: ["src/answer.ts"] }
            ]
          }),
          claimedByCommitHash: "a".repeat(40)
        }]
      },
      repositories: {
        relativePaths: () => ["src/answer.ts"],
        resolveGitHubRepository: async () => githubRepository("asafaltagar", "Tirion")
      },
      now: () => now
    });
    await storage.replaceProductionRuns([productionRun({
      runId: "run_write",
      queryId: "qry_write",
      correlationId: "trace_write",
      provider: "claude-code",
      runtime: "claude-code",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z",
      estimatedNanoUsd: 10_000
    })]);

    await service.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });
    await service.reconcileCommitEvents();
    now += 5_000;
    await service.retryNow();
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "commit.attributed"));

    expect(received.find((event) => (event as { eventType?: string }).eventType === "commit.attributed")).toMatchObject({
      eventType: "commit.attributed",
      runIds: ["run_write"],
      traceIds: ["trace_write"],
      estimatedNanoUsd: 10_000,
      costCoverage: "complete"
    });
  });
});

async function testService(options: {
  attribution?: Partial<AgentVerifiedAttributionService>;
  repositories?: Partial<AgentRepositoryObservationService>;
  now?: () => number;
  recordEvent?: (event: DiagnosticEvent) => void;
  timing?: {
    runEndedGraceMs?: number;
    requestTimeoutMs?: number;
    terminalActivityCorrectionCoalesceMs?: number;
  };
} = {}): Promise<{ root: string; storage: AgentStorageClient; service: ExternalWebhookDispatchService }> {
  const root = mkdtempSync(join(tmpdir(), "tirion-webhook-dispatch-"));
  roots.push(root);
  const storage = serviceStorage(root);
  storages.push(storage);
  const metadata = await storage.initialize({
    now: "2026-06-08T00:00:00.000Z",
    ownershipState: "agent_full_owner",
    protocolVersion: "1.0"
  });
  await storage.beginProductionUsageEpoch("2026-06-08T00:00:00.000Z");
  return {
    root,
    storage,
    service: new ExternalWebhookDispatchService(
      storage,
      { configurationPath: join(root, "webhook-config.json") },
      { ...emptyAttribution(), ...options.attribution } as unknown as AgentVerifiedAttributionService,
      { ...emptyRepositories(), ...options.repositories } as unknown as AgentRepositoryObservationService,
      options.now,
      options.recordEvent,
      metadata.installationId,
      options.timing
    )
  };
}

async function appendDurableObservation(storage: AgentStorageClient, observation: SafeObservationV1): Promise<void> {
  const metadata = await storage.metadata();
  await storage.upsertSource({
    schemaVersion: 1,
    sourceId: observation.sourceId,
    sourceKind: "provider-hook",
    provider: observation.provider,
    runtime: observation.runtime,
    environmentId: metadata.environmentId,
    profileVersion: observation.profileVersion,
    granularity: ["turn"],
    tokenDimensions: ["input", "output"],
    billingEvidence: ["model"],
    durability: "at_least_once",
    contentRisk: "content_not_expected",
    compatibility: "supported",
    evidenceGrade: "estimated_usage_cost_unattributed"
  }, observation.observedAt);
  await storage.appendSafeObservation(observation);
}

function serviceStorage(root: string): AgentStorageClient {
  return new AgentStorageClient({ databasePath: join(root, "agent.sqlite3") });
}

function emptyAttribution(): Partial<AgentVerifiedAttributionService> {
  return {
    listCommitAttributions: async () => [],
    listCommitPublicationSnapshots: async () => [],
    listWorkEpisodes: async () => []
  };
}

function emptyRepositories(): Partial<AgentRepositoryObservationService> {
  return {
    relativePaths: () => [],
    refresh: async () => undefined,
    resolveGitHubRepository: async () => undefined,
    listRepositories: async () => []
  };
}

function githubRepository(owner: string, repository: string): GitHubRepositoryIdentity {
  return { host: "github.com", owner, repository };
}

function workEpisode(
  runId: string,
  queryId: string,
  artifactKeys: string[],
  repoKey: string,
  causalArtifactKeys = artifactKeys
) {
  return {
    episodeId: `episode_${runId}`,
    repoKeys: [repoKey],
    queryIds: [queryId],
    runIds: [runId],
    startedAt: "2026-06-08T00:00:00.000Z",
    lastAgentActivityAt: "2026-06-08T00:00:02.000Z",
    status: "claimed",
    evidence: [{
      queryId,
      runIds: [runId],
      repoKey,
      startedAt: "2026-06-08T00:00:00.000Z",
      baselineTrusted: true,
      baselineReasons: ["repo_bound"],
      dirtyAtStart: false,
      observedChangeCount: artifactKeys.length,
      artifactKeys,
      causalArtifactKeys,
      addedLines: 0,
      deletedLines: 0
    }]
  };
}

function workEpisodeWithEvidence(input: {
  episodeId: string;
  repoKey: string;
  repoKeys?: string[];
  chatSessionId?: string;
  runIds: string[];
  queryIds: string[];
  evidence: Array<{ runId: string; queryId: string; repoKey?: string; artifactKeys: string[] }>;
}) {
  return {
    episodeId: input.episodeId,
    chatSessionId: input.chatSessionId,
    repoKeys: input.repoKeys ?? [input.repoKey],
    queryIds: input.queryIds,
    runIds: input.runIds,
    startedAt: "2026-06-08T00:00:00.000Z",
    lastAgentActivityAt: "2026-06-08T00:00:02.000Z",
    status: "claimed",
    evidence: input.evidence.map((item) => ({
      queryId: item.queryId,
      runIds: [item.runId],
      repoKey: item.repoKey ?? input.repoKey,
      startedAt: "2026-06-08T00:00:00.000Z",
      baselineTrusted: true,
      baselineReasons: ["repo_bound"],
      dirtyAtStart: false,
      observedChangeCount: item.artifactKeys.length,
      artifactKeys: item.artifactKeys,
      causalArtifactKeys: item.artifactKeys,
      addedLines: 0,
      deletedLines: 0
    }))
  };
}

function commitSummary(
  status: CommitAttributionSummary["status"],
  allocatedNanoUsd: number
): CommitAttributionSummary {
  return {
    commitHash: "a".repeat(40),
    parentHashes: ["b".repeat(40)],
    repoKey: "repo_tirion",
    episodeIds: ["episode_commit"],
    queryIds: ["qry_commit_a", "qry_commit_b"],
    runIds: ["run_commit_a", "run_commit_b"],
    linkedQueryCount: 2,
    allocatedNanoUsd,
    linkedNanoUsd: allocatedNanoUsd,
    providerCosts: [],
    coverage: "complete",
    decision: "reportable",
    proofKinds: ["exact_content_state"],
    anchorQueryIds: ["qry_commit_a"],
    inheritedQueryIds: ["qry_commit_b"],
    status,
    evidenceReasons: ["content_continuity"],
    createdAt: "2026-06-08T00:02:00.000Z"
  };
}

function commitSnapshot(
  state: CommitPublicationSnapshot["state"],
  allocatedNanoUsd: number,
  updatedAt: string
): CommitPublicationSnapshot {
  return {
    repoKey: "repo_tirion",
    commitHash: "a".repeat(40),
    state,
    firstVerifiedAt: "2026-06-08T00:02:00.000Z",
    updatedAt,
    allocatedNanoUsd,
    coverage: "complete",
    attributedQueryCount: 2
  };
}

function productionRun(input: {
  runId: string;
  queryId: string;
  correlationId: string;
  provider: ProductionRunV1["provider"];
  runtime: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  startedAt: string;
  endedAt: string;
  reasoningOutputTokens?: number;
  estimatedNanoUsd?: number;
  usageValueNanoUsd?: number;
  costEstimateBasis?: ProductionRunV1["costEstimateBasis"];
  billingContext?: ProductionRunV1["billingContext"];
  models?: string[];
  sessionId?: string;
}): ProductionRunV1 {
  return {
    schemaVersion: 1,
    production: true,
    runId: input.runId,
    correlationId: input.correlationId,
    queryId: input.queryId,
    sessionId: input.sessionId ?? `ses_${input.queryId}`,
    promptState: "disabled",
    provider: input.provider,
    runtime: input.runtime,
    authority: "turn",
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: input.reasoningOutputTokens ?? 0,
    totalTokens: input.totalTokens,
    estimatedNanoUsd: input.estimatedNanoUsd,
    usageValueNanoUsd: input.usageValueNanoUsd,
    costEstimateBasis: input.costEstimateBasis ?? "unavailable",
    billingContext: input.billingContext ?? "openai-direct",
    costCoverage: input.estimatedNanoUsd == null ? "unavailable" : "complete",
    evidenceGrade: "estimated_usage_cost_unattributed",
    toolCallCount: 0,
    breakdown: [],
    models: input.models,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    warnings: []
  };
}

function livePromptObservation(queryId: string, sessionId: string, observedAt: string): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_prompt_${queryId}`,
    sourceId: "hook_claude_code_lifecycle",
    provider: "claude-code",
    runtime: "claude-code",
    signal: "logs",
    profileVersion: "claude-code-hooks-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    queryOccurrences: [{
      schemaVersion: 1,
      queryId,
      sessionId,
      provider: "claude-code",
      runtime: "claude-code",
      startedAt: observedAt,
      promptState: "disabled",
      evidence: "submission_hook"
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: `node_prompt_${queryId.slice(4)}`,
      queryId,
      sessionId,
      requestId: `req_${queryId.slice(4)}`,
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      nodeKind: "prompt",
      name: "Prompt",
      outcome: "success",
      startedAt: observedAt
    }],
    usageAtoms: []
  };
}

function liveToolObservation(queryId: string, sessionId: string, observedAt: string): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_tool_${queryId}`,
    sourceId: "hook_claude_code_tools",
    provider: "claude-code",
    runtime: "claude-code",
    signal: "logs",
    profileVersion: "claude-code-hooks-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    activityAtoms: [{
      schemaVersion: 1,
      activityId: `act_${queryId.slice(4)}`,
      queryId,
      sessionId,
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Edit",
      outcome: "success",
      durationMs: 12,
      startedAt: observedAt,
      endedAt: observedAt
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: `node_tool_${queryId.slice(4)}`,
      queryId,
      sessionId,
      requestId: `req_tool_${queryId.slice(4)}`,
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      nodeKind: "tool",
      name: "Edit",
      outcome: "success",
      startedAt: observedAt,
      endedAt: observedAt,
      durationMs: 12
    }],
    usageAtoms: []
  };
}

function liveCopilotRootObservation(queryId: string, sessionId: string, observedAt: string): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_copilot_root_${queryId}`,
    sourceId: "otlp_github_copilot_traces",
    provider: "github-copilot",
    runtime: "github-copilot",
    signal: "traces",
    profileVersion: "copilot-otlp-traces-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    queryOccurrences: [{
      schemaVersion: 1,
      queryId,
      sessionId,
      provider: "github-copilot",
      runtime: "github-copilot",
      startedAt: observedAt,
      promptState: "disabled",
      evidence: "provider_root_span"
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: `node_copilot_root_${queryId.slice(4)}`,
      queryId,
      sessionId,
      requestId: `req_copilot_root_${queryId.slice(4)}`,
      provider: "github-copilot",
      runtime: "github-copilot",
      signal: "traces",
      nodeKind: "llm_request",
      name: "invoke_agent",
      outcome: "unknown",
      startedAt: observedAt,
      model: "gpt-5.4"
    }],
    usageAtoms: []
  };
}

function liveCopilotToolObservation(queryId: string, sessionId: string, observedAt: string): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_copilot_tool_${queryId}`,
    sourceId: "otlp_github_copilot_traces",
    provider: "github-copilot",
    runtime: "github-copilot",
    signal: "traces",
    profileVersion: "copilot-otlp-traces-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    activityAtoms: [{
      schemaVersion: 1,
      activityId: `act_copilot_${queryId.slice(4)}`,
      queryId,
      sessionId,
      provider: "github-copilot",
      runtime: "github-copilot",
      kind: "tool",
      name: "apply_patch",
      outcome: "success",
      durationMs: 12,
      startedAt: observedAt,
      endedAt: observedAt
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: `node_copilot_tool_${queryId.slice(4)}`,
      queryId,
      sessionId,
      requestId: `req_copilot_tool_${queryId.slice(4)}`,
      provider: "github-copilot",
      runtime: "github-copilot",
      signal: "traces",
      nodeKind: "tool",
      name: "apply_patch",
      outcome: "success",
      startedAt: observedAt,
      endedAt: observedAt,
      durationMs: 12
    }],
    usageAtoms: []
  };
}

function isCopilotToolUpdate(event: unknown): boolean {
  const candidate = event as {
    eventType?: string;
    activity?: Array<{ kind?: string; name?: string }>;
  };
  return candidate.eventType === "run.update"
    && candidate.activity?.some((activity) =>
      activity.kind === "tool" && activity.name === "apply_patch") === true;
}

function liveCodexPromptObservation(queryId: string, sessionId: string, observedAt: string): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_prompt_${queryId}`,
    sourceId: "hook_codex_lifecycle",
    provider: "codex",
    runtime: "codex",
    signal: "logs",
    profileVersion: "codex-hooks-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    queryOccurrences: [{
      schemaVersion: 1,
      queryId,
      sessionId,
      provider: "codex",
      runtime: "codex",
      startedAt: observedAt,
      promptState: "disabled",
      evidence: "submission_hook"
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: `node_prompt_${queryId.slice(4)}`,
      queryId,
      sessionId,
      requestId: `req_${queryId.slice(4)}`,
      provider: "codex",
      runtime: "codex",
      signal: "logs",
      nodeKind: "prompt",
      name: "Prompt",
      outcome: "success",
      startedAt: observedAt
    }],
    usageAtoms: []
  };
}

function liveCodexToolObservation(
  queryId: string,
  sessionId: string,
  tools: Array<{ activityId: string; name: string; startedAt: string }>,
  observedAt: string
): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_tools_${queryId}`,
    sourceId: "hook_codex_tools",
    provider: "codex",
    runtime: "codex",
    signal: "logs",
    profileVersion: "codex-hooks-v1",
    resourceCount: 1,
    recordCount: tools.length,
    observedAt,
    activityAtoms: tools.map((tool) => ({
      schemaVersion: 1,
      activityId: tool.activityId,
      queryId,
      sessionId,
      provider: "codex",
      runtime: "codex",
      kind: "tool",
      name: tool.name,
      outcome: "success",
      startedAt: tool.startedAt,
      endedAt: tool.startedAt
    })),
    usageAtoms: []
  };
}

function liveClosedCodexTurnObservation(input: {
  queryId: string;
  sessionId: string;
  observedAt: string;
  inputTokens: number;
  outputTokens: number;
}): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_closed_turn_${input.queryId}`,
    sourceId: "otlp_codex_traces",
    provider: "codex",
    runtime: "codex",
    signal: "traces",
    profileVersion: "codex-otel-traces-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    usageAtoms: [{
      schemaVersion: 1,
      atomId: `atom_closed_turn_${input.queryId}`,
      correlationId: input.queryId,
      queryId: input.queryId,
      sessionId: input.sessionId,
      requestId: `req_closed_turn_${input.queryId}`,
      signal: "traces",
      sourceId: "otlp_codex_traces",
      profileVersion: "codex-otel-traces-v1",
      provider: "codex",
      runtime: "codex",
      authority: "turn",
      completionMode: "explicit",
      billingContext: "openai-direct",
      model: "gpt-5.5",
      modelProvider: "openai",
      modelProviderBasis: "telemetry_reported",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      startedAt: input.observedAt,
      endedAt: input.observedAt
    }]
  };
}

function liveCompletionObservation(
  prompt: SafeObservationV1,
  completedAt: string,
  completionEvidence: "stop_hook" | "session_hook" | "closed_root_span" | "provider_completed_event"
): SafeObservationV1 {
  const occurrences = prompt.queryOccurrences ?? [];
  if (occurrences.length === 0) {
    throw new Error("missing_prompt_occurrence");
  }
  return {
    ...prompt,
    observationId: `${prompt.observationId}_completed`,
    observedAt: completedAt,
    queryOccurrences: occurrences.map((occurrence) => ({
      ...occurrence,
      completedAt,
      completionEvidence
    })),
    executionNodes: [],
    usageAtoms: []
  };
}

function liveCodexOtelPromptObservation(queryId: string, sessionId: string, observedAt: string): SafeObservationV1 {
  return {
    ...liveCodexPromptObservation(queryId, sessionId, observedAt),
    sourceId: "otlp_codex_logs",
    profileVersion: "codex-otel-logs-v1",
    queryOccurrences: [{
      schemaVersion: 1,
      queryId,
      sessionId,
      provider: "codex",
      runtime: "codex",
      startedAt: observedAt,
      promptState: "disabled",
      evidence: "provider_user_prompt_event"
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: `node_prompt_${queryId.slice(4)}`,
      queryId,
      sessionId,
      requestId: `req_${queryId.slice(4)}`,
      provider: "codex",
      runtime: "codex",
      signal: "logs",
      nodeKind: "prompt",
      name: "Prompt",
      outcome: "success",
      startedAt: observedAt
    }]
  };
}

function liveCodexSkillMetricObservation(queryId: string, sessionId: string, observedAt: string): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_metric_${queryId}`,
    sourceId: "otlp_codex_metrics",
    provider: "codex",
    runtime: "codex",
    signal: "metrics",
    profileVersion: "codex-otel-metrics-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    activityAtoms: [{
      schemaVersion: 1,
      activityId: `act_${queryId.slice(4)}_skill`,
      queryId,
      sessionId,
      provider: "codex",
      runtime: "codex",
      kind: "skill",
      name: "tirion-codex-stress-skill",
      outcome: "success",
      startedAt: observedAt,
      evidenceBasis: "provider_metric",
      evidenceSourceId: "otlp_codex_metrics",
      evidenceProfileVersion: "codex-otel-metrics-v1",
      identityConfidence: "medium",
      timingConfidence: "medium"
    }],
    usageAtoms: []
  };
}

function liveCursorPromptObservation(queryId: string, sessionId: string, observedAt: string): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_cursor_prompt_${queryId}`,
    sourceId: "hook_cursor_lifecycle",
    provider: "cursor",
    runtime: "cursor",
    signal: "logs",
    profileVersion: "cursor-hooks-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    queryOccurrences: [{
      schemaVersion: 1,
      queryId,
      sessionId,
      provider: "cursor",
      runtime: "cursor",
      startedAt: observedAt,
      promptState: "disabled",
      evidence: "submission_hook"
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: `node_cursor_prompt_${queryId.slice(4)}`,
      queryId,
      sessionId,
      requestId: `req_cursor_prompt_${queryId.slice(4)}`,
      provider: "cursor",
      runtime: "cursor",
      signal: "logs",
      nodeKind: "prompt",
      name: "Prompt",
      outcome: "success",
      startedAt: observedAt
    }],
    usageAtoms: []
  };
}

function liveCursorUsageObservation(input: {
  queryId: string;
  sessionId: string;
  observedAt: string;
  atomId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
}): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_cursor_usage_${input.atomId}`,
    sourceId: `hook_cursor_usage_${input.atomId}`,
    provider: "cursor",
    runtime: "cursor",
    signal: "logs",
    profileVersion: "cursor-hooks-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    usageAtoms: [{
      schemaVersion: 1,
      atomId: input.atomId,
      correlationId: input.queryId,
      queryId: input.queryId,
      sessionId: input.sessionId,
      requestId: `req_${input.atomId}`,
      signal: "logs",
      sourceId: `hook_${input.atomId}`,
      profileVersion: "cursor-hooks-v1",
      provider: "cursor",
      runtime: "cursor",
      authority: "request",
      billingContext: "cursor",
      model: "composer-2.5-fast",
      modelProvider: "cursor",
      modelProviderBasis: "model_name_rule",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens,
      reasoningOutputTokens: input.reasoningOutputTokens,
      startedAt: input.observedAt,
      endedAt: input.observedAt
    }]
  };
}

function liveUsageObservation(input: {
  queryId: string;
  sessionId: string;
  observedAt: string;
  atomId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_usage_${input.atomId}`,
    sourceId: `source_${input.atomId}`,
    provider: "codex",
    runtime: "codex",
    signal: "traces",
    profileVersion: "tirion-run-lifecycle-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    usageAtoms: [{
      schemaVersion: 1,
      atomId: input.atomId,
      correlationId: input.queryId,
      queryId: input.queryId,
      sessionId: input.sessionId,
      requestId: `req_${input.atomId}`,
      signal: "traces",
      sourceId: `node_${input.atomId}`,
      profileVersion: "tirion-run-lifecycle-v1",
      provider: "codex",
      runtime: "codex",
      authority: "request",
      billingContext: "openai-direct",
      model: "gpt-5.5",
      modelProvider: "openai",
      modelProviderBasis: "telemetry_reported",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens,
      startedAt: input.observedAt,
      endedAt: input.observedAt
    }]
  };
}

async function collectJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function waitUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed_out");
}
