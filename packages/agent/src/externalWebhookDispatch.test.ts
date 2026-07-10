import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductionRunV1, SafeObservationV1 } from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import type {
  CommitAttributionSummary,
  CommitPublicationSnapshot,
  DiagnosticEvent,
  GitHubRepositoryIdentity
} from "@tirion/engine/production";
import { ExternalWebhookDispatchService } from "./externalWebhookDispatch";
import type { AgentRepositoryObservationService } from "./repositoryObservationService";
import type { AgentVerifiedAttributionService } from "./productionRunAttribution";

const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const storages: AgentStorageClient[] = [];

afterEach(async () => {
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
      }
    });

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
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    })]);
    await waitUntil(() => received.some((event) => (event as { eventType?: string }).eventType === "run.ended"));
    expect(received[0]).toMatchObject({ eventType: "run.start" });
    expect(received.at(-1)).toMatchObject({ eventType: "run.ended" });
    expect(received.slice(1, -1).map((event) => (event as { eventType?: string }).eventType))
      .toEqual(expect.arrayContaining(["run.update"]));
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
      "run.update",
      "run.ended",
      "run.start",
      "run.update",
      "run.ended"
    ]);
    expect(received.map((event) => (event as { runId?: string }).runId)).toEqual([
      "run_first",
      "run_first",
      "run_first",
      "run_second",
      "run_second",
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

  it("does not re-emit run-update when completed-run reprojection changes after run-ended delivery", async () => {
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
      outputTokens: 2,
      totalTokens: 12,
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
      outputTokens: 5,
      totalTokens: 15,
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
      .map((event) => (event as { version?: number; totalTokens?: number; endedAt?: string }));
    expect(runEndedVersions).toEqual([
      expect.objectContaining({ version: 1, totalTokens: 12, endedAt: "2026-06-08T00:00:02.000Z" }),
      expect.objectContaining({ version: 2, totalTokens: 15, endedAt: "2026-06-08T00:00:03.000Z" })
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
    let now = Date.parse("2026-06-08T00:00:00.000Z");
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
      productionRun({
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
      productionRun({
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
      productionRun({
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
      })
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
      costCoverage: "complete"
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
      metadata.installationId
    )
  };
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

function workEpisode(runId: string, queryId: string, artifactKeys: string[], repoKey: string) {
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
