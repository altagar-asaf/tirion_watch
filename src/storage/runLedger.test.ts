import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pricingCatalogForBillingContext } from "../billing/billingContextResolver";
import { DefaultCostEstimation } from "../pricing/costEstimation";
import { OPENAI_PRICING_VERSION } from "../pricing/openaiPricing";
import { JsonlRunLedger } from "./runLedger";
import { AgenticRunRecord, LegacyAgenticQueryRun, ModelPricing, PricingCatalog, PricingCoverageSummary } from "../types";

describe("JsonlRunLedger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-ledger-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("persists runs, groups by initial query, and exports grouped CSV", async () => {
    const ledger = new JsonlRunLedger(dir);
    await ledger.append(run("trace-1", "query-1", 100, "please fix tests", { chatSessionId: "session-1", copilotSessionId: "session-1", traceChatSessionId: "session-1", traceRole: "main" }));
    await ledger.append(run("trace-2", "query-1", 200, "please fix tests", { chatSessionId: "session-1", copilotSessionId: "session-1", traceChatSessionId: "session-1", traceRole: "main" }));

    const runs = await ledger.list({});
    const groups = await ledger.listQueryGroups({});
    const csv = await ledger.export("csv", {});

    expect(runs).toHaveLength(2);
    expect(groups).toHaveLength(1);
    expect(groups[0].totalTokens).toBe(300);
    expect(groups[0].initialQueryText).toBe("please fix tests");
    expect(groups[0].initialQueryState).toBe("captured");
    expect(groups[0]).toMatchObject({
      chatSessionId: "session-1",
      copilotSessionId: "session-1"
    });
    expect(csv.count).toBe(1);
    expect(csv.content).toContain("Initial Query");
    expect(csv.content).toContain("Chat Session ID");
    expect(csv.content).toContain("Trace ID");
    expect(csv.content).toContain("trace-1");
    expect(csv.content).toContain("session-1");
  });

  it("reads legacy v1 rows as v2 records", async () => {
    const legacy: LegacyAgenticQueryRun = {
      schemaVersion: 1,
      id: "legacy-trace",
      traceId: "legacy-trace",
      startedAt: "2026-05-28T00:00:00.000Z",
      status: "completed",
      models: ["gpt-test"],
      inputTokens: 70,
      outputTokens: 30,
      totalTokens: 100,
      estimatedUsd: 0.0001,
      estimatedAiCredits: 0.01,
      llmCallCount: 1,
      toolCallCount: 0,
      tools: [],
      warnings: []
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "runs.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");

    const ledger = new JsonlRunLedger(dir);
    const runs = await ledger.list({});

    expect(runs[0]).toMatchObject({
      schemaVersion: 2,
      queryId: "legacy-trace",
      queryStartedAt: "2026-05-28T00:00:00.000Z",
      initialQueryState: "unavailable",
      estimatedNanoUsd: 100_000,
      tokenUsageSource: "legacy"
    });
    expect(runs[0].warnings).toContain("Read from legacy schema v1 run without authoritative accounting; per-span attribution is unavailable.");
    expect(runs[0].pricingCoverage).toEqual({
      state: "partial",
      reasons: ["legacy_schema"],
      pricedModels: ["gpt-test"],
      unpricedModels: [],
      missingModelSlices: 0,
      pricingVersions: [],
      pricingEffectiveFrom: []
    });
    expect(runs[0].modelUsages[0]).toMatchObject({ model: "gpt-test", totalTokens: 100 });
  });

  it("reads schema v3 rows and preserves authoritative accounting summaries", async () => {
    const record = runV3("trace-v3", "query-v3", 150, "trace accounting", {
      estimatedUsd: 0.0002,
      estimatedAiCredits: 0.02
    });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    const ledger = new JsonlRunLedger(dir);
    const [run] = await ledger.list({});

    expect(run).toMatchObject({
      schemaVersion: 3,
      queryId: "query-v3",
      tokenUsageSource: "invoke_agent"
    });
    expect(run.accounting).toMatchObject({
      accountingSchemaVersion: 1,
      totals: {
        totalTokens: 150,
        inputTokens: 140,
        outputTokens: 10
      }
    });
    expect(run.accounting?.spanSummaries).toEqual([
      expect.objectContaining({
        spanId: "trace:trace-v3:root",
        totalTokens: 150,
        kind: "root"
      })
    ]);
  });

  it("normalizes schema v3 run fields from authoritative accounting when compatibility fields drift", async () => {
    const record = withPricedAuthoritativeAccounting(run("trace-v3", "query-v3", 150, "trace accounting"), {
      model: "gpt-test",
      pricingVersion: "phase7",
      effectiveFrom: "2026-01-01",
      estimatedNanoUsd: 200_000,
      tokenUsageSource: "chat_spans"
    });

    record.models = ["compat-wrong"];
    record.modelUsages = [{ model: "compat-wrong", inputTokens: 1, outputTokens: 1, totalTokens: 2, notes: [] }];
    record.tools = [{ name: "compatTool", count: 9, failures: 0, inputTokens: 9, outputTokens: 9, totalTokens: 18 }];
    record.inputTokens = 1;
    record.outputTokens = 1;
    record.totalTokens = 2;
    record.estimatedUsd = 999;
    record.estimatedAiCredits = 999;
    record.pricingVersion = "compat-wrong";
    record.pricingCoverage = {
      state: "unpriced",
      reasons: ["missing_model_attribution"],
      pricedModels: [],
      unpricedModels: [],
      missingModelSlices: 1,
      pricingVersions: [],
      pricingEffectiveFrom: []
    };
    record.costCoverage = "unavailable";
    record.tokenUsageSource = "not_reported";
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    const ledger = new JsonlRunLedger(dir);
    const [storedRun] = await ledger.list({});

    expect(storedRun).toMatchObject({
      schemaVersion: 3,
      tokenUsageSource: "chat_spans",
      inputTokens: 140,
      outputTokens: 10,
      totalTokens: 150,
      estimatedNanoUsd: 200_000,
      estimatedUsd: 0.0002,
      estimatedAiCredits: 0.02,
      pricingVersion: "phase7",
      costCoverage: "complete"
    });
    expect(storedRun.models).toEqual(["gpt-test"]);
    expect(storedRun.modelUsages).toEqual([expect.objectContaining({ model: "gpt-test", totalTokens: 150, pricingVersion: "phase7" })]);
    expect(storedRun.tools).toEqual([expect.objectContaining({ name: "readFile", totalTokens: 4 })]);
    expect(storedRun.pricingCoverage).toEqual(pricedCoverage("gpt-test", "phase7", "2026-01-01"));
  });

  it("preserves schema v3 historical pricing on read even when current pricing tables differ", async () => {
    const base = run("trace-repriced", "query-repriced", 1500, "trace accounting", {
      models: ["gpt-5.4"],
      tokenUsageSource: "invoke_agent"
    });
    base.startedAt = "2026-06-01T00:00:00.000Z";
    base.queryStartedAt = "2026-06-01T00:00:00.000Z";
    base.inputTokens = 1000;
    base.outputTokens = 500;
    base.reasoningOutputTokens = 200;
    base.totalTokens = 1500;
    base.modelUsages = [
      {
        model: "gpt-5.4",
        provider: "openai",
        inputTokens: 1000,
        outputTokens: 500,
        reasoningOutputTokens: 200,
        totalTokens: 1500,
        notes: []
      }
    ];

    const record = withPricedAuthoritativeAccounting(base, {
      model: "gpt-5.4",
      pricingVersion: "stale-pricing",
      effectiveFrom: "2026-05-01",
      estimatedNanoUsd: 10_000_000,
      tokenUsageSource: "invoke_agent"
    });
    const staleCoverage: PricingCoverageSummary = {
      state: "partial",
      reasons: ["pricing_rate_missing"],
      pricedModels: ["gpt-5.4"],
      unpricedModels: [],
      missingModelSlices: 0,
      pricingVersions: ["stale-pricing"],
      pricingEffectiveFrom: ["2026-05-01"]
    };

    record.pricingCoverage = staleCoverage;
    record.pricingVersion = "stale-pricing";
    record.costCoverage = "partial";
    record.modelUsages = record.modelUsages.map((usage) => ({
      ...usage,
      pricingVersion: "stale-pricing",
      pricingCoverage: staleCoverage
    }));
    record.accounting = {
      ...record.accounting,
      modelSummaries: record.accounting.modelSummaries.map((summary) => ({
        ...summary,
        pricing: summary.pricing ? { ...summary.pricing, pricingVersion: "stale-pricing", effectiveFrom: "2026-05-01" } : summary.pricing,
        pricingCoverage: staleCoverage,
        coverage: { state: "partial", reasons: ["pricing_rate_missing"] }
      })),
      spanSummaries: record.accounting.spanSummaries.map((summary) => ({
        ...summary,
        pricing: summary.pricing ? { ...summary.pricing, pricingVersion: "stale-pricing", effectiveFrom: "2026-05-01" } : summary.pricing,
        pricingCoverage: staleCoverage
      })),
      totals: {
        ...record.accounting.totals,
        pricingCoverage: staleCoverage,
        coverage: { state: "partial", reasons: ["pricing_rate_missing"] }
      },
      pricingMatches: record.accounting.pricingMatches.map((match) => ({
        ...match,
        pricingVersion: "stale-pricing",
        effectiveFrom: "2026-05-01"
      })),
      coverage: { state: "partial", reasons: ["pricing_rate_missing"] }
    };

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    const ledger = new JsonlRunLedger(dir, 180, new DefaultCostEstimation(testCatalog([])));
    const [storedRun] = await ledger.list({});
    const [queryGroup] = await ledger.listQueryGroups({});
    const [sessionGroup] = await ledger.listChatSessionGroups({});
    const totals = await ledger.totals({
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-30T23:59:59.999Z"
    });

    expect(storedRun.reasoningOutputTokens).toBe(200);
    expect(storedRun.costCoverage).toBe("partial");
    expect(storedRun.pricingVersion).toBe("stale-pricing");
    expect(storedRun.pricingCoverage).toEqual(staleCoverage);
    expect(storedRun.estimatedUsd).toBeCloseTo(0.01);
    expect(storedRun.modelUsages).toEqual([
      expect.objectContaining({
        model: "gpt-5.4",
        reasoningOutputTokens: 200,
        pricingVersion: "stale-pricing",
        estimatedUsd: 0.01
      })
    ]);
    expect(storedRun.accounting?.totals.pricingCoverage).toEqual(staleCoverage);
    expect(queryGroup.costLabel).toBe("Partial estimate");
    expect(sessionGroup.costLabel).toBe("Partial estimate");
    expect(totals.costCoverage).toBe("partial");
  });

  it("fills missing schema v3 pricing on read without repricing already-priced rows", async () => {
    const unpricedCoverage: PricingCoverageSummary = {
      state: "unpriced",
      reasons: ["model_unpriced"],
      pricedModels: [],
      unpricedModels: ["claude-sonnet-4.6"],
      missingModelSlices: 0,
      pricingVersions: [],
      pricingEffectiveFrom: []
    };
    const record = runV3("trace-missing-price", "query-missing-price", 1500, "trace accounting", {
      models: ["claude-sonnet-4.6"],
      modelUsages: [
        {
          model: "claude-sonnet-4.6",
          provider: "github",
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          pricingCoverage: unpricedCoverage,
          notes: []
        }
      ],
      tokenUsageSource: "invoke_agent"
    });
    record.startedAt = "2026-07-01T00:00:00.000Z";
    record.inputTokens = 1000;
    record.outputTokens = 500;
    record.totalTokens = 1500;
    record.pricingCoverage = unpricedCoverage;
    record.costCoverage = "unavailable";
    record.accounting = {
      ...record.accounting,
      totals: {
        ...record.accounting.totals,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        pricingCoverage: unpricedCoverage,
        coverage: { state: "partial", reasons: ["model_unpriced"] }
      },
      modelSummaries: record.accounting.modelSummaries.map((summary) => ({
        ...summary,
        provider: "github",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        pricingCoverage: unpricedCoverage,
        coverage: { state: "partial", reasons: ["model_unpriced"] }
      })),
      spanSummaries: record.accounting.spanSummaries.map((summary) => ({
        ...summary,
        model: "claude-sonnet-4.6",
        provider: "github",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        pricingCoverage: unpricedCoverage,
        coverage: { state: "partial", reasons: ["model_unpriced"] }
      })),
      coverage: { state: "partial", reasons: ["model_unpriced"] }
    };

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    const ledger = new JsonlRunLedger(dir, 180, new DefaultCostEstimation(pricingCatalogForBillingContext("github-copilot")));
    const [storedRun] = await ledger.list({});

    expect(storedRun.costCoverage).toBe("complete");
    expect(storedRun.estimatedNanoUsd).toBe(10_500_000);
    expect(storedRun.estimatedAiCredits).toBe(1.05);
    expect(storedRun.pricingVersion).toBe("copilot-pricing-2026-07-01");
    expect(storedRun.modelUsages[0]).toMatchObject({
      model: "claude-sonnet-4.6",
      provider: "github",
      estimatedUsd: 0.0105,
      pricingCoverage: {
        state: "priced",
        pricedModels: ["claude-sonnet-4.6"]
      }
    });
  });

  it("updates duplicate run ids when replayed telemetry reconstructs a richer run", async () => {
    const ledger = new JsonlRunLedger(dir);
    const replayed = run("trace-1", "query-1", 100, "please fix tests");
    const repaired = {
      ...replayed,
      initialQueryText: "please fix tests with the real prompt",
      modelUsages: [
        {
          model: "gpt-test",
          inputTokens: 90,
          outputTokens: 10,
          totalTokens: 100,
          notes: []
        },
        {
          model: "gpt-sidecar",
          inputTokens: 5,
          outputTokens: 5,
          totalTokens: 10,
          notes: []
        }
      ],
      tools: [
        ...replayed.tools,
        {
          name: "grepSearch",
          count: 2,
          failures: 0,
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6
        }
      ],
      llmCallCount: 2,
      toolCallCount: 3
    };

    await ledger.append(replayed);
    await ledger.append({ ...replayed, initialQueryText: undefined, modelUsages: [], tools: [], llmCallCount: 0, toolCallCount: 0 } as AgenticRunRecord);
    await ledger.append(repaired);

    await expect(ledger.list({})).resolves.toEqual([
      expect.objectContaining({
        traceId: "trace-1",
        initialQueryText: "please fix tests with the real prompt",
        initialQueryState: "captured",
        llmCallCount: 2,
        toolCallCount: 3
      })
    ]);
  });

  it("keeps identical prompt text in separate groups when the prompt occurrence id differs", async () => {
    const ledger = new JsonlRunLedger(dir);
    await ledger.append(run("trace-1", "query-1", 100, "open the dashboard"));
    await ledger.append(run("trace-2", "query-2", 120, "open the dashboard"));

    const groups = await ledger.listQueryGroups({});

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.queryId)).toEqual(["query-1", "query-2"]);
    expect(groups.map((group) => group.initialQueryText)).toEqual(["open the dashboard", "open the dashboard"]);
  });

  it("prefers a captured prompt state over unavailable helper rows in the same group", async () => {
    const ledger = new JsonlRunLedger(dir);
    await ledger.append(run("trace-parent", "query-1", 100, "open the dashboard", "captured"));
    await ledger.append(run("trace-helper", "query-1", 40, undefined, "unavailable"));

    const groups = await ledger.listQueryGroups({});

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      queryId: "query-1",
      initialQueryText: "open the dashboard",
      initialQueryState: "captured"
    });
  });

  it("groups multiple queries into one chat session and keeps helper traces under the query group", async () => {
    const ledger = new JsonlRunLedger(dir);
    await ledger.append(run("trace-parent", "query-1", 100, "open the dashboard", {
      chatSessionId: "session-1",
      copilotSessionId: "session-1",
      traceChatSessionId: "session-1",
      traceRole: "main"
    }));
    await ledger.append(run("trace-helper", "query-1", 40, undefined, {
      initialQueryState: "unavailable",
      chatSessionId: "session-1",
      copilotSessionId: "session-1",
      traceChatSessionId: "helper-chat-1",
      traceRole: "helper"
    }));
    await ledger.append({
      ...run("trace-2", "query-2", 120, "draft a changelog", {
        chatSessionId: "session-1",
        copilotSessionId: "session-1",
        traceChatSessionId: "session-1",
        traceRole: "main"
      }),
      queryStartedAt: "2026-05-28T01:00:00.000Z",
      startedAt: "2026-05-28T01:00:00.000Z"
    });

    const queryGroups = await ledger.listQueryGroups({});
    const sessions = await ledger.listChatSessionGroups({});

    expect(queryGroups).toHaveLength(2);
    expect(queryGroups.find((group) => group.queryId === "query-1")).toMatchObject({
      chatSessionId: "session-1",
      runCount: 2,
      tokenSources: ["not_reported"]
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      chatSessionId: "session-1",
      queryCount: 2,
      runCount: 3,
      tokenSources: ["not_reported"]
    });
    expect(sessions[0].queries.map((group) => group.queryId)).toEqual(["query-2", "query-1"]);
  });

  it("groups older rows without chat session metadata into a stable fallback bucket", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "runs.jsonl"), `${JSON.stringify(run("trace-legacy", "query-legacy", 90, "legacy prompt"))}\n`, "utf8");

    const ledger = new JsonlRunLedger(dir);
    const sessions = await ledger.listChatSessionGroups({});

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      chatSessionId: "session unavailable",
      queryCount: 1,
      runCount: 1
    });
  });

  it("compacts malformed ledger rows when a new append rewrites the file", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "runs.jsonl"),
      `${JSON.stringify(run("trace-1", "query-1", 100, "first prompt"))}\nnot-json\n`,
      "utf8"
    );

    const ledger = new JsonlRunLedger(dir);
    await ledger.append(run("trace-2", "query-2", 120, "second prompt"));

    await expect(ledger.list({})).resolves.toHaveLength(2);

    const content = await fs.readFile(path.join(dir, "runs.jsonl"), "utf8");
    expect(content).not.toContain("not-json");
  });

  it("appends schema v3 runs without rewriting untouched legacy rows", async () => {
    const legacy: LegacyAgenticQueryRun = {
      schemaVersion: 1,
      id: "legacy-trace",
      traceId: "legacy-trace",
      startedAt: "2026-05-28T00:00:00.000Z",
      status: "completed",
      models: ["gpt-test"],
      inputTokens: 70,
      outputTokens: 30,
      totalTokens: 100,
      estimatedUsd: 0.0001,
      estimatedAiCredits: 0.01,
      llmCallCount: 1,
      toolCallCount: 0,
      tools: [],
      warnings: []
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "runs.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");

    const ledger = new JsonlRunLedger(dir);
    await ledger.append(runV3("trace-v3", "query-v3", 150, "new run"));

    const content = await fs.readFile(path.join(dir, "runs.jsonl"), "utf8");
    const lines = content.trim().split(/\r?\n/);

    expect(JSON.parse(lines[0])).toMatchObject({ schemaVersion: 1, traceId: "legacy-trace" });
    expect(lines[0]).not.toContain("\"accounting\"");
    expect(JSON.parse(lines[1])).toMatchObject({ schemaVersion: 3, traceId: "trace-v3" });
  });

  it("reads v1 and v2 rows beside v3 rows while keeping legacy counts explicit", async () => {
    const legacy: LegacyAgenticQueryRun = {
      schemaVersion: 1,
      id: "legacy-trace",
      traceId: "legacy-trace",
      startedAt: "2026-05-28T00:00:00.000Z",
      status: "completed",
      models: ["gpt-test"],
      inputTokens: 70,
      outputTokens: 30,
      totalTokens: 100,
      estimatedUsd: 0.0001,
      estimatedAiCredits: 0.01,
      llmCallCount: 1,
      toolCallCount: 0,
      tools: [],
      warnings: []
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "runs.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");

    const ledger = new JsonlRunLedger(dir);
    await ledger.append(run("trace-v2", "query-v2", 90, "legacy v2", {
      chatSessionId: "session-1",
      copilotSessionId: "session-1",
      estimatedUsd: 0.0001,
      estimatedAiCredits: 0.01,
      costCoverage: "complete",
      tokenUsageSource: "invoke_agent"
    }));
    await ledger.append(withPricedAuthoritativeAccounting(run("trace-v3", "query-v3", 120, "authoritative v3", {
      chatSessionId: "session-1",
      copilotSessionId: "session-1"
    }), { pricingVersion: "phase7" }));

    const groups = await ledger.listQueryGroups({});
    const sessions = await ledger.listChatSessionGroups({});
    const totals = await ledger.totals({ from: "2026-05-28T00:00:00.000Z", to: "2026-05-29T00:00:00.000Z" });

    expect(groups.find((group) => group.queryId === "legacy-trace")).toMatchObject({
      legacyRunCount: 1,
      accountingCoverage: { state: "partial", reasons: ["legacy_schema"] }
    });
    expect(groups.find((group) => group.queryId === "query-v2")).toMatchObject({
      legacyRunCount: 1,
      chatSessionId: "session-1"
    });
    expect(groups.find((group) => group.queryId === "query-v3")).toMatchObject({
      legacyRunCount: 0,
      chatSessionId: "session-1",
      accountingCoverage: { state: "complete" }
    });

    expect(sessions.find((session) => session.chatSessionId === "session-1")).toMatchObject({
      queryCount: 2,
      runCount: 2,
      legacyRunCount: 1
    });
    expect(sessions.find((session) => session.chatSessionId === "session unavailable")).toMatchObject({
      queryCount: 1,
      runCount: 1,
      legacyRunCount: 1
    });

    expect(totals.legacyRunCount).toBe(2);
    expect(totals.tokenSources).toEqual(expect.arrayContaining(["legacy", "invoke_agent"]));
    expect(totals.accountingCoverage).toMatchObject({ state: "partial" });
    expect(totals.accountingCoverage?.reasons).toContain("legacy_schema");
  });

  it("aggregates query, session, and totals from authoritative accounting instead of compatibility fields", async () => {
    const ledger = new JsonlRunLedger(dir);
    const runWithAccounting = withPricedAuthoritativeAccounting(
      run("trace-v3", "query-v3", 150, "phase 5 prompt", {
        chatSessionId: "session-1",
        copilotSessionId: "session-1"
      }),
      { pricingVersion: "phase5", effectiveFrom: "2026-01-01" }
    );

    runWithAccounting.models = ["compat-wrong"];
    runWithAccounting.inputTokens = 1;
    runWithAccounting.outputTokens = 1;
    runWithAccounting.totalTokens = 2;
    runWithAccounting.modelUsages = [{ model: "compat-wrong", inputTokens: 1, outputTokens: 1, totalTokens: 2, notes: [] }];
    runWithAccounting.tools = [{ name: "compatTool", count: 3, failures: 0, inputTokens: 9, outputTokens: 9, totalTokens: 18 }];
    runWithAccounting.tokenUsageSource = "not_reported";
    runWithAccounting.costCoverage = "unavailable";
    runWithAccounting.pricingCoverage = {
      state: "unpriced",
      reasons: ["missing_model_attribution"],
      pricedModels: [],
      unpricedModels: [],
      missingModelSlices: 1,
      pricingVersions: [],
      pricingEffectiveFrom: []
    };

    await ledger.append(runWithAccounting);

    const [group] = await ledger.listQueryGroups({});
    const [session] = await ledger.listChatSessionGroups({});
    const totals = await ledger.totals({ from: "2026-05-28T00:00:00.000Z", to: "2026-05-29T00:00:00.000Z" });

    expect(group).toMatchObject({
      totalTokens: 150,
      inputTokens: 140,
      outputTokens: 10,
      tokenSources: ["invoke_agent"],
      costCoverage: "complete",
      pricingVersion: "phase5",
      pricingVersions: ["phase5"],
      pricingEffectiveFrom: ["2026-01-01"],
      unpricedSliceCount: 0,
      unavailableSliceCount: 0,
      legacyRunCount: 0,
      accountingCoverage: { state: "complete" }
    });
    expect(group.models).toEqual(["gpt-test"]);
    expect(group.modelUsages).toEqual([expect.objectContaining({ model: "gpt-test", totalTokens: 150, pricingVersion: "phase5" })]);
    expect(group.tools).toEqual([expect.objectContaining({ name: "readFile", totalTokens: 4 })]);

    expect(session).toMatchObject({
      totalTokens: 150,
      tokenSources: ["invoke_agent"],
      pricingVersions: ["phase5"],
      pricingEffectiveFrom: ["2026-01-01"],
      legacyRunCount: 0,
      accountingCoverage: { state: "complete" }
    });

    expect(totals).toMatchObject({
      totalTokens: 150,
      inputTokens: 140,
      outputTokens: 10,
      tokenSources: ["invoke_agent"],
      estimatedNanoUsd: 200_000,
      estimatedUsd: 0.0002,
      costCoverage: "complete",
      pricingVersions: ["phase5"],
      pricingEffectiveFrom: ["2026-01-01"],
      legacyRunCount: 0,
      accountingCoverage: { state: "complete" }
    });
  });

  it("prefers authoritative accounting completeness over larger compatibility arrays when merging duplicates", async () => {
    const ledger = new JsonlRunLedger(dir);
    await ledger.append({
      ...run("trace-1", "query-1", 100, "merge prompt", {
        estimatedUsd: undefined,
        estimatedAiCredits: undefined,
        costCoverage: "unavailable",
        tokenUsageSource: "not_reported",
        models: ["gpt-test", "claude-sonnet"],
        modelUsages: [
          { model: "gpt-test", inputTokens: 60, outputTokens: 10, totalTokens: 70, notes: [] },
          { model: "claude-sonnet", inputTokens: 20, outputTokens: 10, totalTokens: 30, notes: [] }
        ]
      }),
      tools: [
        { name: "readFile", count: 2, failures: 0, inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        { name: "grepSearch", count: 1, failures: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      ],
      llmCallCount: 3,
      toolCallCount: 3
    });
    await ledger.append(withPricedAuthoritativeAccounting(run("trace-1", "query-1", 100, "merge prompt"), { pricingVersion: "phase5" }));

    const [merged] = await ledger.list({});

    expect(merged).toMatchObject({
      schemaVersion: 3,
      tokenUsageSource: "invoke_agent",
      costCoverage: "complete",
      pricingVersion: "phase5"
    });
    expect(merged.accounting).toBeDefined();
    expect(merged.models).toEqual(["gpt-test"]);
    expect(merged.pricingCoverage).toEqual(pricedCoverage("gpt-test", "phase5", "2026-01-01"));
  });

  it("exports coverage, pricing provenance, and legacy-schema indicators", async () => {
    const ledger = new JsonlRunLedger(dir);
    await ledger.append(withPricedAuthoritativeAccounting(run("trace-v3", "query-v3", 120, "export prompt"), { pricingVersion: "phase5" }));
    await ledger.append(run("trace-v2", "query-v2", 90, "legacy export", {
      estimatedUsd: 0.0001,
      estimatedAiCredits: 0.01,
      costCoverage: "complete",
      tokenUsageSource: "invoke_agent"
    }));

    const csv = await ledger.export("csv", {});
    const json = await ledger.export("json", {});

    expect(csv.content).toContain("Run Pricing Versions");
    expect(csv.content).toContain("Run Legacy Schema");
    expect(csv.content).toContain("Query Accounting Coverage");
    expect(csv.content).toContain("Query Legacy Runs");
    expect(csv.content).toContain("phase5");
    expect(csv.content).toContain("yes");
    expect(csv.content).toContain("no");
    expect(json.content).toContain("\"accountingSchemaVersion\": 1");
    expect(json.content).toContain("\"pricingVersions\"");
  });

  it("marks query and session estimates as partial when some runs have no USD estimate", async () => {
    const ledger = new JsonlRunLedger(dir);
    await ledger.append(run("trace-priced", "query-1", 100, "priced prompt", {
      estimatedUsd: 0.0002,
      estimatedAiCredits: 0.02,
      costCoverage: "complete"
    }));
    await ledger.append(run("trace-unpriced", "query-1", 120, "priced prompt", {
      estimatedUsd: undefined,
      estimatedAiCredits: undefined,
      costCoverage: "unavailable",
      models: ["claude-sonnet"],
      modelUsages: []
    }));

    const [group] = await ledger.listQueryGroups({});
    const [session] = await ledger.listChatSessionGroups({});
    const totals = await ledger.totals({ from: "2026-05-28T00:00:00.000Z", to: "2026-05-29T00:00:00.000Z" });

    expect(group).toMatchObject({ costCoverage: "partial", costLabel: "Priced models only", estimatedNanoUsd: 200_000, estimatedUsd: 0.0002 });
    expect(group.pricingCoverage).toEqual({
      state: "partial",
      reasons: ["model_unpriced"],
      pricedModels: ["gpt-test"],
      unpricedModels: ["claude-sonnet"],
      missingModelSlices: 0,
      pricingVersions: [],
      pricingEffectiveFrom: []
    });
    expect(session).toMatchObject({ costCoverage: "partial", costLabel: "Priced models only", estimatedNanoUsd: 200_000, estimatedUsd: 0.0002 });
    expect(session.pricingCoverage).toEqual(group.pricingCoverage);
    expect(totals).toMatchObject({ estimatedNanoUsd: 200_000, estimatedUsd: 0.0002, costCoverage: "partial", tokenSources: ["invoke_agent", "not_reported"] });
    expect(totals.pricingCoverage).toEqual(group.pricingCoverage);
  });

  it("reconciles schema v3 span, run, query, session, and totals from the same stored accounting payload", async () => {
    const ledger = new JsonlRunLedger(dir);
    await ledger.append(withPricedAuthoritativeAccounting(run("trace-a", "query-1", 100, "first prompt", {
      chatSessionId: "session-1",
      copilotSessionId: "session-1"
    }), { pricingVersion: "phase7-a", estimatedNanoUsd: 120_000 }));
    await ledger.append(withPricedAuthoritativeAccounting(run("trace-b", "query-1", 60, "first prompt", {
      chatSessionId: "session-1",
      copilotSessionId: "session-1"
    }), { pricingVersion: "phase7-a", estimatedNanoUsd: 80_000 }));
    await ledger.append(withPricedAuthoritativeAccounting({
      ...run("trace-c", "query-2", 40, "second prompt", {
        chatSessionId: "session-1",
        copilotSessionId: "session-1"
      }),
      queryStartedAt: "2026-05-28T01:00:00.000Z",
      startedAt: "2026-05-28T01:00:00.000Z"
    }, { pricingVersion: "phase7-b", estimatedNanoUsd: 50_000 }));

    const runs = await ledger.list({});
    const groups = await ledger.listQueryGroups({});
    const sessions = await ledger.listChatSessionGroups({});
    const totals = await ledger.totals({ from: "2026-05-28T00:00:00.000Z", to: "2026-05-29T00:00:00.000Z" });
    const queryOneRuns = runs.filter((run) => run.queryId === "query-1");
    const queryOne = groups.find((group) => group.queryId === "query-1");
    const session = sessions.find((entry) => entry.chatSessionId === "session-1");

    const queryOneSpanTokens = queryOneRuns
      .flatMap((run) => run.accounting?.spanSummaries ?? [])
      .reduce((sum, span) => sum + (span.totalTokens ?? 0), 0);
    const queryOneSpanNanoUsd = queryOneRuns
      .flatMap((run) => run.accounting?.spanSummaries ?? [])
      .reduce((sum, span) => sum + (span.estimatedNanoUsd ?? 0), 0);
    const summedGroupTokens = groups.reduce((sum, group) => sum + (group.totalTokens ?? 0), 0);
    const summedGroupNanoUsd = groups.reduce((sum, group) => sum + (group.estimatedNanoUsd ?? 0), 0);

    expect(queryOne).toMatchObject({
      runCount: 2,
      totalTokens: 160,
      estimatedNanoUsd: 200_000,
      pricingVersions: ["phase7-a"],
      accountingCoverage: { state: "complete" },
      legacyRunCount: 0
    });
    expect(queryOne?.modelUsages).toEqual([
      expect.objectContaining({ model: "gpt-test", totalTokens: 160, estimatedNanoUsd: 200_000 })
    ]);
    expect(queryOne?.tools).toEqual([
      expect.objectContaining({ name: "readFile", count: 2, totalTokens: 8 })
    ]);
    expect(queryOneSpanTokens).toBe(queryOne?.totalTokens);
    expect(queryOneSpanNanoUsd).toBe(queryOne?.estimatedNanoUsd);

    expect(session).toMatchObject({
      queryCount: 2,
      runCount: 3,
      totalTokens: 200,
      estimatedNanoUsd: 250_000,
      accountingCoverage: { state: "complete" },
      legacyRunCount: 0
    });
    expect(session?.pricingVersions).toEqual(expect.arrayContaining(["phase7-a", "phase7-b"]));

    expect(totals).toMatchObject({
      runCount: 3,
      totalTokens: 200,
      estimatedNanoUsd: 250_000,
      accountingCoverage: { state: "complete" },
      legacyRunCount: 0
    });
    expect(totals.pricingVersions).toEqual(expect.arrayContaining(["phase7-a", "phase7-b"]));
    expect(session?.totalTokens).toBe(summedGroupTokens);
    expect(session?.estimatedNanoUsd).toBe(summedGroupNanoUsd);
    expect(totals.totalTokens).toBe(summedGroupTokens);
    expect(totals.estimatedNanoUsd).toBe(summedGroupNanoUsd);
  });
});

function run(
  traceId: string,
  queryId: string,
  totalTokens: number,
  initialQueryText?: string,
  options: {
    initialQueryState?: AgenticRunRecord["initialQueryState"];
    chatSessionId?: string;
    copilotSessionId?: string;
    traceChatSessionId?: string;
    traceRole?: AgenticRunRecord["traceRole"];
    models?: string[];
    modelUsages?: AgenticRunRecord["modelUsages"];
    estimatedUsd?: number;
    estimatedAiCredits?: number;
    costCoverage?: AgenticRunRecord["costCoverage"];
    tokenUsageSource?: AgenticRunRecord["tokenUsageSource"];
  } | AgenticRunRecord["initialQueryState"] = initialQueryText ? "captured" : "unavailable"
): AgenticRunRecord {
  const normalizedOptions = typeof options === "string"
    ? { initialQueryState: options }
    : options;

  return {
    schemaVersion: 2,
    id: traceId,
    traceId,
    queryId,
    queryStartedAt: "2026-05-28T00:00:00.000Z",
    chatSessionId: normalizedOptions.chatSessionId,
    copilotSessionId: normalizedOptions.copilotSessionId,
    traceChatSessionId: normalizedOptions.traceChatSessionId,
    traceRole: normalizedOptions.traceRole,
    initialQueryText,
    initialQueryState: normalizedOptions.initialQueryState ?? (initialQueryText ? "captured" : "unavailable"),
    startedAt: "2026-05-28T00:00:00.000Z",
    status: "completed",
    models: normalizedOptions.models ?? ["gpt-test"],
    inputTokens: totalTokens - 10,
    outputTokens: 10,
    totalTokens,
    estimatedUsd: normalizedOptions.estimatedUsd,
    estimatedAiCredits: normalizedOptions.estimatedAiCredits,
    tokenUsageSource: normalizedOptions.tokenUsageSource ?? (normalizedOptions.estimatedUsd == null ? "not_reported" : "invoke_agent"),
    costCoverage: normalizedOptions.costCoverage ?? (normalizedOptions.estimatedUsd == null ? "unavailable" : "complete"),
    modelUsages: normalizedOptions.modelUsages ?? [
      {
        model: (normalizedOptions.models ?? ["gpt-test"])[0],
        inputTokens: totalTokens - 10,
        outputTokens: 10,
        totalTokens,
        estimatedUsd: normalizedOptions.estimatedUsd,
        notes: []
      }
    ],
    llmCallCount: 1,
    toolCallCount: 1,
    tools: [
      {
        name: "readFile",
        count: 1,
        failures: 0,
        inputTokens: 3,
        outputTokens: 1,
        totalTokens: 4
      }
    ],
    warnings: []
  };
}

function runV3(
  traceId: string,
  queryId: string,
  totalTokens: number,
  initialQueryText?: string,
  options: Parameters<typeof run>[4] = initialQueryText ? "captured" : "unavailable"
): AgenticRunRecord {
  const base = run(traceId, queryId, totalTokens, initialQueryText, options);

  return {
    ...base,
    schemaVersion: 3,
    accounting: {
      accountingSchemaVersion: 1,
      sourceSelection: {
        selectedTokenUsageSource: base.tokenUsageSource,
        corroboratingSources: [],
        dedupedRecordCount: 0,
        discardedOverlapReasons: []
      },
      attributedUsageUnits: [],
      modelSummaries: base.modelUsages.map((usage) => ({
        model: usage.model,
        provider: usage.provider,
        attributionIds: [],
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cachedTokens: usage.cachedTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        totalTokens: usage.totalTokens,
        estimatedNanoUsd: usage.estimatedNanoUsd,
        pricingCoverage: usage.pricingCoverage,
        coverage: { state: "complete", reasons: [] },
        warnings: []
      })),
      toolSummaries: [],
      spanSummaries: [
        {
          spanId: `trace:${traceId}:root`,
          traceId,
          queryId,
          kind: "root",
          name: "invoke_agent",
          attributionIds: [`trace:${traceId}:root`],
          inputTokens: base.inputTokens,
          outputTokens: base.outputTokens,
          cacheReadInputTokens: base.cacheReadInputTokens,
          cacheCreationInputTokens: base.cacheCreationInputTokens,
          cachedTokens: base.cachedTokens,
          reasoningOutputTokens: base.reasoningOutputTokens,
          totalTokens: base.totalTokens,
          estimatedNanoUsd: base.estimatedNanoUsd,
          pricingCoverage: base.pricingCoverage,
          coverage: { state: "complete", reasons: [] },
          warnings: []
        }
      ],
      totals: {
        inputTokens: base.inputTokens,
        outputTokens: base.outputTokens,
        cacheReadInputTokens: base.cacheReadInputTokens,
        cacheCreationInputTokens: base.cacheCreationInputTokens,
        cachedTokens: base.cachedTokens,
        reasoningOutputTokens: base.reasoningOutputTokens,
        totalTokens: base.totalTokens,
        estimatedNanoUsd: base.estimatedNanoUsd,
        pricingCoverage: base.pricingCoverage,
        coverage: { state: base.costCoverage, reasons: [] },
        warnings: []
      },
      pricingMatches: [],
      invariants: [],
      coverage: { state: base.costCoverage, reasons: [] },
      warnings: []
    }
  };
}

function withPricedAuthoritativeAccounting(
  base: AgenticRunRecord,
  input: {
    model?: string;
    pricingVersion?: string;
    effectiveFrom?: string;
    estimatedNanoUsd?: number;
    toolName?: string;
    tokenUsageSource?: AgenticRunRecord["tokenUsageSource"];
  } = {}
): AgenticRunRecord {
  const model = input.model ?? "gpt-test";
  const pricingVersion = input.pricingVersion ?? "phase5";
  const effectiveFrom = input.effectiveFrom ?? "2026-01-01";
  const estimatedNanoUsd = input.estimatedNanoUsd ?? 200_000;
  const pricingCoverage = pricedCoverage(model, pricingVersion, effectiveFrom);
  const estimatedUsd = estimatedNanoUsd / 1_000_000_000;
  const estimatedAiCredits = estimatedNanoUsd / 10_000_000;
  const toolName = input.toolName ?? "readFile";

  return {
    ...base,
    schemaVersion: 3,
    tokenUsageSource: input.tokenUsageSource ?? "invoke_agent",
    costCoverage: "complete",
    estimatedNanoUsd,
    estimatedUsd,
    estimatedAiCredits,
    pricingVersion,
    pricingCoverage,
    models: [model],
    modelUsages: [
      {
        model,
        inputTokens: base.inputTokens,
        outputTokens: base.outputTokens,
        cacheReadInputTokens: base.cacheReadInputTokens,
        cacheCreationInputTokens: base.cacheCreationInputTokens,
        cachedTokens: base.cachedTokens,
        reasoningOutputTokens: base.reasoningOutputTokens,
        totalTokens: base.totalTokens,
        estimatedNanoUsd,
        estimatedUsd,
        pricingVersion,
        matchedModel: model,
        pricingCoverage,
        notes: []
      }
    ],
    tools: [
      {
        name: toolName,
        count: 1,
        failures: 0,
        totalDurationMs: 0,
        inputTokens: 3,
        outputTokens: 1,
        totalTokens: 4
      }
    ],
    accounting: {
      accountingSchemaVersion: 1,
      sourceSelection: {
        selectedTokenUsageSource: input.tokenUsageSource ?? "invoke_agent",
        corroboratingSources: [],
        dedupedRecordCount: 0,
        discardedOverlapReasons: []
      },
      attributedUsageUnits: [],
      modelSummaries: [
        {
          model,
          attributionIds: [],
          inputTokens: base.inputTokens,
          outputTokens: base.outputTokens,
          cacheReadInputTokens: base.cacheReadInputTokens,
          cacheCreationInputTokens: base.cacheCreationInputTokens,
          cachedTokens: base.cachedTokens,
          reasoningOutputTokens: base.reasoningOutputTokens,
          totalTokens: base.totalTokens,
          estimatedNanoUsd,
          pricing: {
            provider: "openai",
            model,
            matchedModel: model,
            pricingVersion,
            effectiveFrom,
            notes: []
          },
          pricingCoverage,
          coverage: { state: "complete", reasons: [] },
          warnings: []
        }
      ],
      toolSummaries: [
        {
          name: toolName,
          count: 1,
          failures: 0,
          totalDurationMs: 0,
          attributionIds: [],
          inputTokens: 3,
          outputTokens: 1,
          totalTokens: 4,
          coverage: { state: "complete", reasons: [] },
          warnings: []
        }
      ],
      spanSummaries: [
        {
          spanId: `trace:${base.traceId}:root`,
          traceId: base.traceId,
          queryId: base.queryId,
          chatSessionId: base.chatSessionId,
          kind: "root",
          name: "invoke_agent",
          model,
          attributionIds: [`trace:${base.traceId}:root`],
          inputTokens: base.inputTokens,
          outputTokens: base.outputTokens,
          cacheReadInputTokens: base.cacheReadInputTokens,
          cacheCreationInputTokens: base.cacheCreationInputTokens,
          cachedTokens: base.cachedTokens,
          reasoningOutputTokens: base.reasoningOutputTokens,
          totalTokens: base.totalTokens,
          estimatedNanoUsd,
          pricing: {
            provider: "openai",
            model,
            matchedModel: model,
            pricingVersion,
            effectiveFrom,
            notes: []
          },
          pricingCoverage,
          coverage: { state: "complete", reasons: [] },
          warnings: []
        }
      ],
      totals: {
        inputTokens: base.inputTokens,
        outputTokens: base.outputTokens,
        cacheReadInputTokens: base.cacheReadInputTokens,
        cacheCreationInputTokens: base.cacheCreationInputTokens,
        cachedTokens: base.cachedTokens,
        reasoningOutputTokens: base.reasoningOutputTokens,
        totalTokens: base.totalTokens,
        estimatedNanoUsd,
        pricingCoverage,
        coverage: { state: "complete", reasons: [] },
        warnings: []
      },
      pricingMatches: [
        {
          provider: "openai",
          model,
          matchedModel: model,
          pricingVersion,
          effectiveFrom,
          notes: []
        }
      ],
      invariants: [],
      coverage: { state: "complete", reasons: [] },
      warnings: []
    }
  };
}

function pricedCoverage(model: string, pricingVersion: string, effectiveFrom: string): PricingCoverageSummary {
  return {
    state: "priced",
    reasons: [],
    pricedModels: [model],
    unpricedModels: [],
    missingModelSlices: 0,
    pricingVersions: [pricingVersion],
    pricingEffectiveFrom: [effectiveFrom]
  };
}

function testCatalog(pricingTable: ModelPricing[]): PricingCatalog {
  return {
    billingContext: "openai-direct",
    primaryBillingUnit: "usd",
    pricingVersions: ["test"],
    pricingTable: pricingTable.map((pricing) => ({ pricingVersion: pricing.pricingVersion ?? "test", ...pricing }))
  };
}
