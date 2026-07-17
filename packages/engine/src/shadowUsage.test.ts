import { describe, expect, it } from "vitest";
import type { QueryOccurrenceV1, SafeActivityAtomV1, SafeUsageAtomV1 } from "@tirion/agent-contract";
import { claudeCodeNativeSuccessfulV21207 } from "../../../test-fixtures/claudeCodeNativeSuccessfulV21207";
import { DefaultProductionUsagePipeline, DefaultShadowUsagePipeline, preferredSafeActivities } from "./shadowUsage";
import { DefaultAgentPrivacyGuard, DefaultTelemetryClassification } from "./telemetryClassification";

describe("shadow usage pipeline", () => {
  it("selects Claude request authority and discards overlapping model atoms", () => {
    const pipeline = new DefaultShadowUsagePipeline();
    const runs = pipeline.project([
      atom({ atomId: "atom_request", provider: "claude-code", runtime: "claude-code", authority: "request", model: "claude-sonnet-4.6", inputTokens: 100, outputTokens: 20 }),
      atom({ atomId: "atom_model", provider: "claude-code", runtime: "claude-code", authority: "model", model: "claude-sonnet-4.6", inputTokens: 100, outputTokens: 20 })
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      authority: "request",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      billingContext: "unknown",
      costCoverage: "unavailable",
      warnings: ["lower_authority_overlap_discarded", "billing_context_unavailable"]
    });
  });

  it("deduplicates atoms and separates provider correlations", () => {
    const pipeline = new DefaultShadowUsagePipeline();
    const codex = atom({ atomId: "atom_codex", correlationId: "cor_codex", provider: "codex", runtime: "codex", authority: "turn", model: "gpt-5.4", inputTokens: 10, outputTokens: 5 });
    const claude = atom({ atomId: "atom_claude", correlationId: "cor_claude", provider: "claude-code", runtime: "claude-code", authority: "request", model: "claude-sonnet-4.6", inputTokens: 20, outputTokens: 7 });
    const totals = pipeline.totals(pipeline.project([codex, codex, claude]));
    expect(totals).toMatchObject({ runCount: 2, inputTokens: 30, outputTokens: 12, totalTokens: 42, pricedRunCount: 0, unpricedRunCount: 2 });
  });

  it("excludes usage and activity for a durably internal harness occurrence", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const runs = pipeline.project([
      atom({ atomId: "atom_customer", queryId: "qry_customer", correlationId: "qry_customer", inputTokens: 20, outputTokens: 2 }),
      atom({ atomId: "atom_internal", queryId: "qry_internal", correlationId: "qry_internal", inputTokens: 8_863, outputTokens: 52 })
    ], new Date("2026-06-08T00:00:10.000Z"), [
      occurrence({ queryId: "qry_customer", lifecycleVisibility: "customer" }),
      occurrence({ queryId: "qry_internal", sessionId: "ses_internal", lifecycleVisibility: "internal" })
    ], [
      activity({ activityId: "act_customer", queryId: "qry_customer" }),
      activity({ activityId: "act_internal", queryId: "qry_internal", name: "internal_tool" })
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      queryId: "qry_customer",
      inputTokens: 20,
      outputTokens: 2,
      totalTokens: 22
    });
    expect(JSON.stringify(runs)).not.toContain("internal_tool");
    expect(JSON.stringify(runs)).not.toContain("8915");
  });

  it("requires durable submission-hook authority for Claude production roots", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const authorizedQueryId = "qry_claude_authorized";
    const ghostQueryId = "qry_claude_task_notification_ghost";
    const runs = pipeline.project([
      atom({
        atomId: "atom_claude_authorized",
        queryId: authorizedQueryId,
        correlationId: authorizedQueryId,
        sessionId: "ses_claude_shared",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        inputTokens: 14,
        outputTokens: 922
      }),
      atom({
        atomId: "atom_claude_task_notification_ghost",
        queryId: ghostQueryId,
        correlationId: ghostQueryId,
        sessionId: "ses_claude_shared",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        inputTokens: 96,
        outputTokens: 102
      })
    ], new Date("2026-07-12T22:50:00.000Z"), [
      occurrence({
        queryId: authorizedQueryId,
        sessionId: "ses_claude_shared",
        provider: "claude-code",
        runtime: "claude-code",
        evidence: "submission_hook"
      }),
      occurrence({
        queryId: ghostQueryId,
        sessionId: "ses_claude_shared",
        provider: "claude-code",
        runtime: "claude-code",
        startedAt: "2026-07-12T22:46:40.977Z",
        evidence: "provider_prompt_id"
      })
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      queryId: authorizedQueryId,
      inputTokens: 14,
      outputTokens: 922,
      totalTokens: 936
    });
    expect(JSON.stringify(runs)).not.toContain(ghostQueryId);
    expect(JSON.stringify(runs)).not.toContain("198");

    const ghostOnly = atom({
      atomId: "atom_claude_cold_start_ghost",
      queryId: ghostQueryId,
      correlationId: ghostQueryId,
      sessionId: "ses_claude_shared",
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      inputTokens: 2,
      outputTokens: 23
    });
    expect(pipeline.project([ghostOnly], new Date("2026-07-12T22:50:00.000Z"), [])).toEqual([]);
    expect(pipeline.project([ghostOnly], new Date("2026-07-12T22:50:00.000Z"), [
      occurrence({ queryId: "qry_unrelated_codex", provider: "codex", runtime: "codex" }),
      occurrence({
        queryId: "qry_unrelated_claude",
        provider: "claude-code",
        runtime: "claude-code",
        evidence: "submission_hook"
      })
    ])).toEqual([]);
  });

  it("excludes exact auxiliary session-title usage from customer projection", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({
        atomId: "claude-customer-request",
        correlationId: "qry_claude_customer",
        queryId: "qry_claude_customer",
        sessionId: "ses_claude_customer",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        usagePurpose: "customer",
        model: "claude-sonnet-5",
        billingContext: "anthropic-direct",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 20,
        reasoningOutputTokens: 5,
        startedAt: "2026-07-01T00:00:01.000Z"
      }),
      atom({
        atomId: "claude-session-title-request",
        correlationId: "qry_claude_customer",
        queryId: "qry_claude_customer",
        sessionId: "ses_claude_customer",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        usagePurpose: "auxiliary_session_title",
        model: "claude-haiku-4-5-20251001",
        billingContext: "anthropic-direct",
        providerReportedNanoUsd: 99_000_000,
        inputTokens: 8_000,
        outputTokens: 500,
        cacheReadInputTokens: 2_000,
        reasoningOutputTokens: 100,
        startedAt: "2026-07-01T00:00:02.000Z"
      })
    ], new Date("2026-07-01T00:01:00.000Z"), [occurrence({
      queryId: "qry_claude_customer",
      sessionId: "ses_claude_customer",
      provider: "claude-code",
      runtime: "claude-code"
    })])[0];

    expect(run).toMatchObject({
      queryId: "qry_claude_customer",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      modelProvider: "anthropic",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 120,
      billingContext: "anthropic-direct",
      costEstimateBasis: "catalog_estimate",
      costCoverage: "complete",
      estimatedNanoUsd: 414_000,
      usageValueNanoUsd: 414_000,
      context: {
        schemaVersion: 1,
        accumulatedInputTokens: 120,
        initialInputContextTokens: 120,
        latestInputContextTokens: 120,
        peakInputContextTokens: 120,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 0,
        observedLlmRequestCount: 1,
        contextGrowthInputTokens: 0,
        contextGrowthRatio: 1,
        basis: "derived_from_usage_atoms",
        coverage: "complete_so_far"
      },
      warnings: ["auxiliary_session_title_excluded"]
    });
    expect(run.breakdown).toEqual([expect.objectContaining({
      kind: "unallocated",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 120
    })]);
    expect(JSON.stringify(run)).not.toContain("claude-haiku-4-5-20251001");
    expect(JSON.stringify(run)).not.toContain("99000000");
  });

  it("projects a trace-before-log native Claude 2.1.207 ledger without title overhead", () => {
    const fixture = claudeCodeNativeSuccessfulV21207;
    const guard = new DefaultAgentPrivacyGuard();
    const prompt = guard.sanitizeProviderHookObservation(
      fixture.promptHook,
      "claude-code",
      fixture.promptObservedAt
    );
    const promptMetadata = guard.sanitizeOtlpEnvelope(
      fixture.promptLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    guard.sanitizeQueryOccurrences(
      fixture.promptLogEnvelope,
      "logs",
      new DefaultTelemetryClassification().classify(promptMetadata),
      promptMetadata.observedAt
    );

    const traceMetadata = guard.sanitizeOtlpEnvelope(
      fixture.traceEnvelope,
      "traces",
      fixture.promptObservedAt
    );
    const traceClassification = new DefaultTelemetryClassification().classify(traceMetadata);
    guard.sanitizeExecutionNodes(
      fixture.traceEnvelope,
      "traces",
      traceClassification,
      traceMetadata.observedAt
    );
    const traceAtoms = guard.sanitizeUsageAtoms(
      fixture.traceEnvelope,
      "traces",
      traceClassification,
      traceMetadata.observedAt
    );

    const logMetadata = guard.sanitizeOtlpEnvelope(
      fixture.apiLogEnvelope,
      "logs",
      fixture.promptObservedAt
    );
    const logClassification = new DefaultTelemetryClassification().classify(logMetadata);
    guard.sanitizeExecutionNodes(
      fixture.apiLogEnvelope,
      "logs",
      logClassification,
      logMetadata.observedAt
    );
    const logAtoms = guard.sanitizeUsageAtoms(
      fixture.apiLogEnvelope,
      "logs",
      logClassification,
      logMetadata.observedAt
    );

    expect(traceAtoms.every((atom) => atom.usagePurpose == null)).toBe(true);
    expect(logAtoms.map((atom) => atom.usagePurpose)).toEqual([
      "auxiliary_session_title",
      "customer",
      "customer"
    ]);

    const run = new DefaultProductionUsagePipeline().project(
      [...traceAtoms, ...logAtoms],
      new Date("2026-07-12T08:00:01.000Z"),
      prompt?.queryOccurrences ?? []
    )[0];

    expect(run).toMatchObject({
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      inputTokens: fixture.expectedMainUsage.inputTokens,
      outputTokens: fixture.expectedMainUsage.outputTokens,
      cacheReadInputTokens: fixture.expectedMainUsage.cacheReadInputTokens,
      cacheCreationInputTokens: fixture.expectedMainUsage.cacheCreationInputTokens,
      totalTokens: fixture.expectedMainUsage.inputTokens + fixture.expectedMainUsage.outputTokens,
      estimatedNanoUsd: fixture.expectedMainUsage.providerReportedNanoUsd,
      costEstimateBasis: "provider_reported_estimate",
      costCoverage: "complete",
      context: expect.objectContaining({
        observedLlmRequestCount: 2,
        cacheReadInputTokens: fixture.expectedMainUsage.cacheReadInputTokens,
        cacheCreationInputTokens: fixture.expectedMainUsage.cacheCreationInputTokens
      }),
      warnings: expect.arrayContaining([
        "auxiliary_session_title_excluded",
        "lower_authority_overlap_discarded",
        "billing_context_unavailable",
        "provider_reported_estimate"
      ])
    });
    expect(JSON.stringify(run)).not.toContain("claude-haiku-4-5-20251001");
    expect(run).not.toHaveProperty("usagePurpose");
  });

  it("counts explicit customer and unclassified usage purposes", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({
        atomId: "purpose-customer",
        correlationId: "qry_usage_purpose_fail_open",
        queryId: "qry_usage_purpose_fail_open",
        usagePurpose: "customer",
        model: "gpt-5.4",
        billingContext: "openai-direct",
        inputTokens: 10,
        outputTokens: 2,
        startedAt: "2026-07-01T00:00:01.000Z"
      }),
      atom({
        atomId: "purpose-unclassified",
        correlationId: "qry_usage_purpose_fail_open",
        queryId: "qry_usage_purpose_fail_open",
        model: "gpt-5.5",
        billingContext: "openai-direct",
        inputTokens: 30,
        outputTokens: 4,
        startedAt: "2026-07-01T00:00:02.000Z"
      })
    ])[0];

    expect(run).toMatchObject({
      models: ["gpt-5.4", "gpt-5.5"],
      inputTokens: 40,
      outputTokens: 6,
      totalTokens: 46,
      estimatedNanoUsd: 325_000,
      usageValueNanoUsd: 325_000,
      context: expect.objectContaining({
        accumulatedInputTokens: 40,
        initialInputContextTokens: 10,
        latestInputContextTokens: 30,
        peakInputContextTokens: 30,
        observedLlmRequestCount: 2
      })
    });
    expect(run.warnings).not.toContain("auxiliary_session_title_excluded");
    expect(run.breakdown).toEqual([expect.objectContaining({
      kind: "unallocated",
      inputTokens: 40,
      outputTokens: 6,
      totalTokens: 46
    })]);
  });

  it("does not create a customer run from auxiliary session-title usage alone", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    expect(pipeline.project([atom({
      atomId: "auxiliary-only",
      correlationId: "qry_auxiliary_only",
      queryId: "qry_auxiliary_only",
      usagePurpose: "auxiliary_session_title"
    })])).toEqual([]);
  });

  it("retains an authoritative failed outcome when auxiliary title usage is the only usage", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const queryId = "qry_auxiliary_only_failure";
    const run = pipeline.project([atom({
      atomId: "auxiliary-only-failed-run",
      correlationId: queryId,
      queryId,
      provider: "claude-code",
      runtime: "claude-code",
      usagePurpose: "auxiliary_session_title",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 500,
      outputTokens: 10
    })], new Date("2026-07-12T06:00:02.000Z"), [occurrence({
      queryId,
      provider: "claude-code",
      runtime: "claude-code",
      completedAt: "2026-07-12T06:00:01.000Z",
      completionEvidence: "stop_hook",
      completionOutcome: "failure"
    })])[0];

    expect(run).toMatchObject({
      queryId,
      completionOutcome: "failure",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      warnings: [
        "auxiliary_session_title_excluded",
        "no_usage_atoms",
        "model_unavailable",
        "billing_context_unavailable"
      ]
    });
    expect(run.model).toBeUndefined();
    expect(run.models).toBeUndefined();
    expect(run.estimatedNanoUsd).toBeUndefined();
  });

  it("selects Copilot invoke-agent authority over corroborating model spans", () => {
    const pipeline = new DefaultShadowUsagePipeline();
    const runs = pipeline.project([
      atom({ atomId: "copilot-root", provider: "github-copilot", runtime: "github-copilot", authority: "run", model: "gpt-5.4", inputTokens: 50, outputTokens: 10 }),
      atom({ atomId: "copilot-chat", provider: "github-copilot", runtime: "github-copilot", authority: "model", model: "gpt-5.4", inputTokens: 50, outputTokens: 10 })
    ]);
    expect(runs[0]).toMatchObject({
      provider: "github-copilot",
      modelProvider: "openai",
      modelProviderBasis: "model_name_rule",
      authority: "run",
      billingContext: "github-copilot",
      totalTokens: 60,
      warnings: ["lower_authority_overlap_discarded"]
    });
  });

  it("prices all GitHub-published Copilot model rows in live run projection", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const cases: [model: string, expectedNanoUsd: number][] = [
      ["gpt-5-mini", 2_250_000_000],
      ["gpt-5.3-codex", 15_750_000_000],
      ["gpt-5.4-mini", 5_250_000_000],
      ["gpt-5.4-nano", 1_450_000_000],
      ["claude-haiku-4.5", 6_000_000_000],
      ["claude-sonnet-4", 18_000_000_000],
      ["claude-sonnet-4.5", 18_000_000_000],
      ["claude-sonnet-4.6", 18_000_000_000],
      ["claude-opus-4.5", 30_000_000_000],
      ["claude-opus-4.6", 30_000_000_000],
      ["claude-opus-4.7", 30_000_000_000],
      ["claude-opus-4.8", 30_000_000_000],
      ["claude-sonnet-5", 12_000_000_000],
      ["claude-opus-4.8-fast-mode", 60_000_000_000],
      ["claude-fable-5", 60_000_000_000],
      ["gemini-2.5-pro", 11_250_000_000],
      ["gemini-3-flash", 3_500_000_000],
      ["gemini-3.5-flash", 10_500_000_000],
      ["raptor-mini", 2_250_000_000],
      ["mai-code-1-flash", 5_250_000_000]
    ];

    for (const [model, expectedNanoUsd] of cases) {
      const run = pipeline.project([atom({
        provider: "github-copilot",
        runtime: "github-copilot",
        authority: "run",
        model,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000
      })])[0];

      expect(run).toMatchObject({
        model,
        billingContext: "github-copilot",
        costCoverage: "complete",
        costEstimateBasis: "catalog_estimate",
        estimatedNanoUsd: expectedNanoUsd,
        pricingVersion: "copilot-pricing-2026-07-01"
      });
    }
  });

  it("uses Copilot long-context pricing thresholds in live run projection", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const cases: [model: string, inputTokens: number, outputTokens: number, expectedNanoUsd: number][] = [
      ["gpt-5.4", 272_000, 1_000, 695_000_000],
      ["gpt-5.4", 272_001, 1_000, 1_382_505_000],
      ["gpt-5.5", 272_000, 1_000, 1_390_000_000],
      ["gpt-5.5", 272_001, 1_000, 2_765_010_000],
      ["gemini-3.1-pro", 200_000, 1_000, 412_000_000],
      ["gemini-3.1-pro", 200_001, 1_000, 818_004_000]
    ];

    for (const [model, inputTokens, outputTokens, expectedNanoUsd] of cases) {
      const run = pipeline.project([atom({
        provider: "github-copilot",
        runtime: "github-copilot",
        authority: "run",
        model,
        inputTokens,
        outputTokens
      })])[0];

      expect(run).toMatchObject({
        model,
        billingContext: "github-copilot",
        costCoverage: "complete",
        estimatedNanoUsd: expectedNanoUsd,
        pricingVersion: "copilot-pricing-2026-07-01"
      });
    }
  });

  it("enriches Copilot run authority with corroborating trace reasoning and cache breakdown", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({
        atomId: "copilot-run",
        provider: "github-copilot",
        runtime: "github-copilot",
        authority: "run",
        signal: "traces",
        sourceId: "otlp_github_copilot_traces",
        profileVersion: "copilot-otlp-traces-v1",
        model: undefined,
        inputTokens: 100,
        outputTokens: 20
      }),
      atom({
        atomId: "copilot-chat-1",
        provider: "github-copilot",
        runtime: "github-copilot",
        authority: "model",
        signal: "traces",
        sourceId: "otlp_github_copilot_traces",
        profileVersion: "copilot-otlp-traces-v1",
        model: "gpt-5.4",
        inputTokens: 40,
        outputTokens: 8,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        reasoningOutputTokens: 6
      }),
      atom({
        atomId: "copilot-chat-2",
        provider: "github-copilot",
        runtime: "github-copilot",
        authority: "model",
        signal: "traces",
        sourceId: "otlp_github_copilot_traces",
        profileVersion: "copilot-otlp-traces-v1",
        model: "gpt-5.4",
        inputTokens: 60,
        outputTokens: 12,
        cacheReadInputTokens: 15,
        cacheCreationInputTokens: 7,
        reasoningOutputTokens: 9
      })
    ])[0];
    expect(run).toMatchObject({
      provider: "github-copilot",
      authority: "run",
      model: "gpt-5.4",
      modelProvider: "openai",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 25,
      cacheCreationInputTokens: 12,
      reasoningOutputTokens: 15,
      totalTokens: 120
    });
  });

  it("keeps model provider separate from the coding tool and billing context", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([atom({
      provider: "github-copilot",
      runtime: "github-copilot",
      model: "claude-sonnet-4.6",
      billingContext: "github-copilot"
    })])[0];
    expect(run).toMatchObject({
      provider: "github-copilot",
      modelProvider: "anthropic",
      modelProviderBasis: "model_name_rule",
      billingContext: "github-copilot"
    });
  });

  it("reports mixed model providers as unknown instead of assigning the whole run", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({ atomId: "openai", model: "gpt-5.4" }),
      atom({ atomId: "anthropic", model: "claude-sonnet-4.6" })
    ])[0];
    expect(run).toMatchObject({
      model: undefined,
      models: ["gpt-5.4", "claude-sonnet-4.6"],
      modelProvider: "unknown",
      modelProviderBasis: "conflict"
    });
  });

  it("reports safe comparison reason codes", () => {
    const pipeline = new DefaultShadowUsagePipeline();
    const actual = pipeline.totals(pipeline.project([atom({})]));
    expect(pipeline.compare({
      runCount: 1,
      inputTokens: 999,
      outputTokens: 5,
      totalTokens: 15,
      estimatedNanoUsd: actual.estimatedNanoUsd
    }, actual)).toMatchObject({
      matches: false,
      reasonCodes: ["input_tokens_mismatch"]
    });
  });

  it("projects the same authority policy into explicitly production-scoped DTOs", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const runs = pipeline.project([atom({})]);
    expect(runs[0]).toMatchObject({ production: true, runId: expect.stringMatching(/^run_/), totalTokens: 15 });
    expect(pipeline.totals(runs)).toMatchObject({ production: true, runCount: 1, totalTokens: 15 });
  });

  it("keeps a grouped run current until every selected-authority atom is complete", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const current = pipeline.project([
      atom({ atomId: "atom_complete", endedAt: "2026-06-08T00:00:01.000Z" }),
      atom({ atomId: "atom_current" })
    ]);
    expect(current[0].endedAt).toBeUndefined();
    const completed = pipeline.project([
      atom({ atomId: "atom_complete", endedAt: "2026-06-08T00:00:01.000Z" }),
      atom({ atomId: "atom_current", endedAt: "2026-06-08T00:00:02.000Z" })
    ]);
    expect(completed[0].endedAt).toBe("2026-06-08T00:00:02.000Z");
  });

  it("keeps Codex event-authority trace fragments current until inactivity proves the run ended", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const atoms = [
      atom({
        atomId: "codex-fragment-1",
        authority: "event",
        signal: "traces",
        sourceId: "otlp_codex_traces",
        profileVersion: "codex-otel-traces-v1",
        correlationId: "qry_codex_live",
        queryId: "qry_codex_live",
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:05.000Z",
        completionMode: "explicit"
      }),
      atom({
        atomId: "codex-fragment-2",
        authority: "event",
        signal: "traces",
        sourceId: "otlp_codex_traces",
        profileVersion: "codex-otel-traces-v1",
        correlationId: "qry_codex_live",
        queryId: "qry_codex_live",
        startedAt: "2026-06-08T00:01:00.000Z",
        endedAt: "2026-06-08T00:01:10.000Z",
        completionMode: "explicit"
      })
    ];
    expect(pipeline.project(atoms, new Date("2026-06-08T00:01:39.999Z"))[0].endedAt).toBeUndefined();
    expect(pipeline.project(atoms, new Date("2026-06-08T00:01:40.000Z"))[0].endedAt).toBe("2026-06-08T00:01:10.000Z");
  });

  it("keeps a hook-anchored turn open across model responses until the harness stop occurrence", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const usage = atom({
      atomId: "codex-cumulative-turn",
      correlationId: "qry_codex_hook_turn",
      queryId: "qry_codex_hook_turn",
      sessionId: "ses_codex_hook_session",
      authority: "turn",
      completionMode: "inactivity",
      inputTokens: 1_514_607,
      outputTokens: 20_193,
      cacheReadInputTokens: 1_403_520,
      reasoningOutputTokens: 2_227,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:09:58.000Z"
    });
    const started = {
      schemaVersion: 1 as const,
      queryId: "qry_codex_hook_turn",
      sessionId: "ses_codex_hook_session",
      provider: "codex" as const,
      runtime: "codex",
      startedAt: "2026-06-08T00:00:00.000Z",
      promptState: "disabled" as const,
      evidence: "submission_hook" as const,
      repositoryKey: "repo_ground_truth"
    };

    expect(pipeline.project([usage], new Date("2026-06-08T00:20:00.000Z"), [started])[0]).toMatchObject({
      repositoryKey: "repo_ground_truth",
      endedAt: undefined,
      inputTokens: 1_514_607,
      outputTokens: 20_193
    });

    expect(pipeline.project([usage], new Date("2026-06-08T00:20:00.000Z"), [{
      ...started,
      completedAt: "2026-06-08T00:10:09.789Z",
      completionEvidence: "stop_hook"
    }])[0]).toMatchObject({
      endedAt: "2026-06-08T00:10:09.789Z",
      repositoryKey: "repo_ground_truth",
      totalTokens: 1_534_800
    });
  });

  it("rejects the 184-token auxiliary request that starts after durable completion", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const queryId = "qry_claude_completion_boundary";
    const sessionId = "ses_claude_completion_boundary";
    const occurrenceRecord = occurrence({
      queryId,
      sessionId,
      lifecycleVisibility: "customer",
      provider: "claude-code",
      runtime: "claude-code",
      startedAt: "2026-07-12T15:11:42.000Z",
      completedAt: "2026-07-12T15:12:10.000Z",
      completionEvidence: "stop_hook",
      completionOutcome: "success"
    });
    const run = pipeline.project([
      atom({
        atomId: "atom_claude_customer_request",
        correlationId: queryId,
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        model: "claude-sonnet-5",
        inputTokens: 538,
        outputTokens: 9_525,
        cacheReadInputTokens: 380_195,
        startedAt: "2026-07-12T15:11:43.000Z",
        endedAt: "2026-07-12T15:12:00.000Z"
      }),
      atom({
        atomId: "atom_claude_away_summary",
        correlationId: queryId,
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        model: "claude-sonnet-5",
        inputTokens: 94,
        outputTokens: 90,
        cacheReadInputTokens: 42_563,
        startedAt: "2026-07-12T15:15:11.000Z",
        endedAt: "2026-07-12T15:15:12.000Z"
      })
    ], new Date("2026-07-12T15:15:13.000Z"), [occurrenceRecord], [
      activity({
        activityId: "activity_claude_customer_bash",
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        name: "Bash",
        startedAt: "2026-07-12T15:11:44.000Z",
        endedAt: "2026-07-12T15:11:45.000Z"
      }),
      activity({
        activityId: "activity_claude_away_summary",
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        name: "away_summary",
        startedAt: "2026-07-12T15:15:11.000Z",
        endedAt: "2026-07-12T15:15:12.000Z"
      })
    ])[0];

    expect(run).toMatchObject({
      inputTokens: 538,
      outputTokens: 9_525,
      cacheReadInputTokens: 380_195,
      totalTokens: 10_063,
      toolCallCount: 1,
      endedAt: occurrenceRecord.completedAt
    });
    expect(JSON.stringify(run)).not.toContain("away_summary");
    expect(JSON.stringify(run)).not.toContain("42563");
  });

  it("accepts evidence delivered late when its provider start precedes durable completion", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const queryId = "qry_late_precompletion_evidence";
    const sessionId = "ses_late_precompletion_evidence";
    const occurrenceRecord = occurrence({
      queryId,
      sessionId,
      lifecycleVisibility: "customer",
      provider: "claude-code",
      runtime: "claude-code",
      startedAt: "2026-07-12T15:11:42.000Z",
      completedAt: "2026-07-12T15:12:10.000Z",
      completionEvidence: "stop_hook",
      completionOutcome: "success"
    });
    const initial = atom({
      atomId: "atom_late_boundary_initial",
      correlationId: queryId,
      queryId,
      sessionId,
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      inputTokens: 538,
      outputTokens: 9_525,
      startedAt: "2026-07-12T15:11:43.000Z",
      endedAt: "2026-07-12T15:12:00.000Z"
    });
    const deliveredLate = atom({
      atomId: "atom_late_boundary_enrichment",
      correlationId: queryId,
      queryId,
      sessionId,
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      inputTokens: 7,
      outputTokens: 3,
      startedAt: "2026-07-12T15:12:09.000Z",
      endedAt: "2026-07-12T15:12:11.000Z"
    });

    expect(pipeline.project(
      [initial, deliveredLate],
      new Date("2026-07-12T15:15:13.000Z"),
      [occurrenceRecord]
    )[0]).toMatchObject({
      inputTokens: 545,
      outputTokens: 9_528,
      totalTokens: 10_073,
      endedAt: occurrenceRecord.completedAt
    });
  });

  it("revises an inactivity-completed occurrence with later provider evidence", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const queryId = "qry_revised_after_inactivity";
    const sessionId = "ses_revised_after_inactivity";
    const inactivityOccurrence = occurrence({
      queryId,
      sessionId,
      lifecycleVisibility: "customer",
      provider: "cursor",
      runtime: "cursor",
      evidence: "provider_user_prompt_event",
      startedAt: "2026-07-12T15:11:42.000Z",
      completedAt: "2026-07-12T15:12:10.000Z",
      completionEvidence: "inactivity"
    });
    const initial = atom({
      atomId: "atom_before_inactivity_completion",
      correlationId: queryId,
      queryId,
      sessionId,
      provider: "cursor",
      runtime: "cursor",
      authority: "request",
      completionMode: "inactivity",
      inputTokens: 100,
      outputTokens: 10,
      startedAt: "2026-07-12T15:11:43.000Z",
      endedAt: "2026-07-12T15:12:00.000Z"
    });
    const laterProviderEvidence = atom({
      atomId: "atom_after_inactivity_completion",
      correlationId: queryId,
      queryId,
      sessionId,
      provider: "cursor",
      runtime: "cursor",
      authority: "request",
      completionMode: "inactivity",
      inputTokens: 7,
      outputTokens: 3,
      startedAt: "2026-07-12T15:12:20.000Z",
      endedAt: "2026-07-12T15:12:30.000Z"
    });

    expect(pipeline.project(
      [initial],
      new Date("2026-07-12T15:12:31.000Z"),
      [inactivityOccurrence]
    )[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      endedAt: "2026-07-12T15:12:00.000Z"
    });

    expect(pipeline.project(
      [initial, laterProviderEvidence],
      new Date("2026-07-12T15:13:00.000Z"),
      [inactivityOccurrence],
      [activity({
        activityId: "activity_after_inactivity_completion",
        queryId,
        sessionId,
        provider: "cursor",
        runtime: "cursor",
        name: "Read",
        startedAt: "2026-07-12T15:12:21.000Z",
        endedAt: "2026-07-12T15:12:22.000Z"
      })]
    )[0]).toMatchObject({
      inputTokens: 107,
      outputTokens: 13,
      totalTokens: 120,
      toolCallCount: 1,
      endedAt: "2026-07-12T15:12:30.000Z"
    });
  });

  it("projects a failed completed occurrence without inventing usage, cost, or a model", () => {
    const occurrenceRecord = occurrence({
      queryId: "qry_claude_stop_failure",
      sessionId: "ses_claude_stop_failure",
      provider: "claude-code",
      runtime: "claude-code",
      startedAt: "2026-07-12T06:00:00.000Z",
      completedAt: "2026-07-12T06:00:01.000Z",
      completionEvidence: "stop_hook",
      completionOutcome: "failure"
    });
    const failedActivity = activity({
      activityId: "act_claude_stop_failure_request",
      queryId: occurrenceRecord.queryId,
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Bash",
      outcome: "failure",
      startedAt: "2026-07-12T06:00:00.100Z",
      endedAt: "2026-07-12T06:00:00.200Z"
    });
    const shadow = new DefaultShadowUsagePipeline().project(
      [],
      new Date("2026-07-12T06:00:02.000Z"),
      [occurrenceRecord],
      [failedActivity]
    )[0];
    const production = new DefaultProductionUsagePipeline().project(
      [],
      new Date("2026-07-12T06:00:02.000Z"),
      [occurrenceRecord],
      [failedActivity]
    )[0];

    for (const run of [shadow, production]) {
      expect(run).toMatchObject({
        authority: "event",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costEstimateBasis: "unavailable",
        costCoverage: "unavailable",
        endedAt: "2026-07-12T06:00:01.000Z",
        completionEvidence: "stop_hook",
        completionOutcome: "failure",
        breakdown: [expect.objectContaining({
          kind: "tool",
          failureCount: 1,
          attributionBasis: "activity_only",
          coverage: "unavailable"
        })],
        warnings: expect.arrayContaining(["no_usage_atoms", "model_unavailable"])
      });
      expect(run.model).toBeUndefined();
      expect(run.models).toBeUndefined();
      expect(run.estimatedNanoUsd).toBeUndefined();
      expect(run.usageValueNanoUsd).toBeUndefined();
    }
  });

  it("does not synthesize zero-usage runs for incomplete, internal, or outcome-less Stop occurrences", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const incomplete = occurrence({ queryId: "qry_incomplete" });
    const ordinaryStop = occurrence({
      queryId: "qry_ordinary_stop",
      completedAt: "2026-07-12T06:00:01.000Z",
      completionEvidence: "stop_hook"
    });
    const internalFailure = occurrence({
      queryId: "qry_internal_failure",
      lifecycleVisibility: "internal",
      completedAt: "2026-07-12T06:00:01.000Z",
      completionEvidence: "stop_hook",
      completionOutcome: "failure"
    });

    expect(pipeline.project([], new Date("2026-07-12T06:00:02.000Z"), [
      incomplete,
      ordinaryStop,
      internalFailure
    ])).toEqual([]);
  });

  it("completes a hook-anchored run from a closed authoritative turn but not from model responses", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const started = occurrence({
      queryId: "qry_codex_closed_turn",
      sessionId: "ses_codex_closed_turn",
      startedAt: "2026-06-08T00:00:00.000Z"
    });
    const response = atom({
      atomId: "codex-response-only",
      correlationId: started.queryId,
      queryId: started.queryId,
      sessionId: started.sessionId,
      authority: "request",
      signal: "logs",
      sourceId: "otlp_codex_logs",
      profileVersion: "codex-otel-logs-v1",
      completionMode: "explicit",
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });

    expect(pipeline.project([response], new Date("2026-06-08T00:10:00.000Z"), [started])[0].endedAt)
      .toBeUndefined();

    const closedTurn = atom({
      atomId: "codex-closed-turn",
      correlationId: started.queryId,
      queryId: started.queryId,
      sessionId: started.sessionId,
      authority: "turn",
      signal: "traces",
      sourceId: "otlp_codex_traces",
      profileVersion: "codex-otel-traces-v1",
      completionMode: "explicit",
      inputTokens: 120,
      outputTokens: 12,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:05.000Z"
    });
    expect(pipeline.project([response, closedTurn], new Date("2026-06-08T00:00:05.100Z"), [started])[0])
      .toMatchObject({
        authority: "turn",
        endedAt: "2026-06-08T00:00:05.000Z",
        inputTokens: 120,
        outputTokens: 12,
        totalTokens: 132
      });
  });

  it("merges linked child sessions into one root run exactly once with subagent usage and failures", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const atoms = [
      atom({
        atomId: "parent-usage",
        correlationId: "qry_parent",
        queryId: "qry_parent",
        sessionId: "ses_parent",
        inputTokens: 100,
        outputTokens: 20,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:09:50.000Z"
      }),
      atom({
        atomId: "child-a-usage",
        correlationId: "qry_child_a",
        queryId: "qry_child_a",
        sessionId: "ses_child_a",
        inputTokens: 40,
        outputTokens: 5,
        startedAt: "2026-06-08T00:02:00.000Z",
        endedAt: "2026-06-08T00:04:00.000Z"
      }),
      atom({
        atomId: "child-b-usage",
        correlationId: "qry_child_b",
        queryId: "qry_child_b",
        sessionId: "ses_child_b",
        inputTokens: 30,
        outputTokens: 4,
        startedAt: "2026-06-08T00:02:05.000Z",
        endedAt: "2026-06-08T00:03:30.000Z"
      })
    ];
    const occurrences = [
      occurrence({
        queryId: "qry_parent",
        sessionId: "ses_parent",
        startedAt: "2026-06-08T00:00:00.000Z",
        completedAt: "2026-06-08T00:10:09.789Z",
        completionEvidence: "stop_hook",
        repositoryKey: "repo_deep"
      }),
      occurrence({
        queryId: "qry_child_a",
        sessionId: "ses_child_a",
        startedAt: "2026-06-08T00:02:00.000Z",
        completedAt: "2026-06-08T00:04:00.000Z",
        completionEvidence: "stop_hook",
        repositoryKey: "repo_deep"
      }),
      occurrence({
        queryId: "qry_child_b",
        sessionId: "ses_child_b",
        startedAt: "2026-06-08T00:02:05.000Z",
        completedAt: "2026-06-08T00:03:30.000Z",
        completionEvidence: "stop_hook",
        repositoryKey: "repo_deep"
      })
    ];
    const activities = [
      activity({ activityId: "subagent-a", queryId: "qry_parent", sessionId: "ses_parent", kind: "subagent", name: "explorer", childSessionId: "ses_child_a", outcome: "success" }),
      activity({ activityId: "subagent-b", queryId: "qry_parent", sessionId: "ses_parent", kind: "subagent", name: "explorer", childSessionId: "ses_child_b", outcome: "success" }),
      activity({ activityId: "subagent-failed", queryId: "qry_parent", sessionId: "ses_parent", kind: "subagent", name: "explorer", outcome: "failure" }),
      activity({ activityId: "parent-edit", queryId: "qry_parent", sessionId: "ses_parent", kind: "tool", name: "apply_patch", outcome: "success" }),
      activity({ activityId: "child-a-shell", queryId: "qry_child_a", sessionId: "ses_child_a", kind: "tool", name: "Bash", outcome: "success" }),
      activity({ activityId: "child-b-shell", queryId: "qry_child_b", sessionId: "ses_child_b", kind: "tool", name: "Bash", outcome: "failure" })
    ];

    const runs = pipeline.project(atoms, new Date("2026-06-08T00:11:00.000Z"), occurrences, activities);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      queryId: "qry_parent",
      repositoryKey: "repo_deep",
      inputTokens: 170,
      outputTokens: 29,
      totalTokens: 199,
      endedAt: "2026-06-08T00:10:09.789Z",
      breakdown: expect.arrayContaining([
        expect.objectContaining({
          kind: "subagent",
          name: "explorer",
          count: 3,
          failureCount: 1,
          inputTokens: 70,
          outputTokens: 9,
          totalTokens: 79,
          attributionBasis: "unavailable",
          coverage: "unavailable"
        }),
        expect.objectContaining({ kind: "tool", name: "apply_patch", count: 1 }),
        expect.objectContaining({ kind: "tool", name: "Bash", parentBreakdownId: expect.any(String) })
      ])
    });
    expect((runs[0].breakdown ?? []).reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(199);
  });

  it("conserves context footprint across a directly linked child without inventing latest-context order", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const runs = pipeline.project([
      atom({
        atomId: "context-direct-parent",
        correlationId: "qry_context_direct_parent",
        queryId: "qry_context_direct_parent",
        sessionId: "ses_context_direct_parent",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 5,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:00:09.000Z"
      }),
      atom({
        atomId: "context-direct-child",
        correlationId: "qry_context_direct_child",
        queryId: "qry_context_direct_child",
        sessionId: "ses_context_direct_child",
        inputTokens: 150,
        outputTokens: 10,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 2,
        startedAt: "2026-06-08T00:02:00.000Z",
        endedAt: "2026-06-08T00:04:00.000Z"
      })
    ], new Date("2026-06-08T00:11:00.000Z"), [
      occurrence({
        queryId: "qry_context_direct_parent",
        sessionId: "ses_context_direct_parent",
        completedAt: "2026-06-08T00:10:00.000Z",
        completionEvidence: "stop_hook"
      }),
      occurrence({
        queryId: "qry_context_direct_child",
        sessionId: "ses_context_direct_child",
        startedAt: "2026-06-08T00:02:00.000Z",
        completedAt: "2026-06-08T00:04:00.000Z",
        completionEvidence: "stop_hook"
      })
    ], [activity({
      activityId: "context-direct-link",
      queryId: "qry_context_direct_parent",
      sessionId: "ses_context_direct_parent",
      kind: "subagent",
      name: "explorer",
      childSessionId: "ses_context_direct_child"
    })]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      queryId: "qry_context_direct_parent",
      inputTokens: 250,
      cacheReadInputTokens: 70,
      cacheCreationInputTokens: 7,
      context: {
        schemaVersion: 1,
        accumulatedInputTokens: 327,
        initialInputContextTokens: 125,
        peakInputContextTokens: 202,
        cacheReadInputTokens: 70,
        cacheCreationInputTokens: 7,
        observedLlmRequestCount: 2,
        contextGrowthInputTokens: 77,
        contextGrowthRatio: 202 / 125,
        basis: "derived_from_usage_atoms",
        coverage: "final"
      }
    });
    expect(runs[0].context).not.toHaveProperty("latestInputContextTokens");
    expect(runs[0].context?.accumulatedInputTokens).toBe(
      runs[0].inputTokens + runs[0].cacheReadInputTokens + runs[0].cacheCreationInputTokens
    );
  });

  it("recursively conserves context footprint across nested linked children", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const runs = pipeline.project([
      atom({
        atomId: "context-nested-root",
        correlationId: "qry_context_nested_root",
        queryId: "qry_context_nested_root",
        sessionId: "ses_context_nested_root",
        inputTokens: 80,
        outputTokens: 8,
        cacheReadInputTokens: 10,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:10:00.000Z"
      }),
      atom({
        atomId: "context-nested-child",
        correlationId: "qry_context_nested_child",
        queryId: "qry_context_nested_child",
        sessionId: "ses_context_nested_child",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 5,
        startedAt: "2026-06-08T00:02:00.000Z",
        endedAt: "2026-06-08T00:08:00.000Z"
      }),
      atom({
        atomId: "context-nested-grandchild",
        correlationId: "qry_context_nested_grandchild",
        queryId: "qry_context_nested_grandchild",
        sessionId: "ses_context_nested_grandchild",
        inputTokens: 150,
        outputTokens: 15,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 10,
        startedAt: "2026-06-08T00:03:00.000Z",
        endedAt: "2026-06-08T00:05:00.000Z"
      })
    ], new Date("2026-06-08T00:11:00.000Z"), [
      occurrence({
        queryId: "qry_context_nested_root",
        sessionId: "ses_context_nested_root",
        completedAt: "2026-06-08T00:10:00.000Z",
        completionEvidence: "stop_hook"
      }),
      occurrence({
        queryId: "qry_context_nested_child",
        sessionId: "ses_context_nested_child",
        startedAt: "2026-06-08T00:02:00.000Z",
        completedAt: "2026-06-08T00:08:00.000Z",
        completionEvidence: "stop_hook"
      }),
      occurrence({
        queryId: "qry_context_nested_grandchild",
        sessionId: "ses_context_nested_grandchild",
        startedAt: "2026-06-08T00:03:00.000Z",
        completedAt: "2026-06-08T00:05:00.000Z",
        completionEvidence: "stop_hook"
      })
    ], [
      activity({
        activityId: "context-nested-root-link",
        queryId: "qry_context_nested_root",
        sessionId: "ses_context_nested_root",
        kind: "subagent",
        name: "explorer",
        childSessionId: "ses_context_nested_child"
      }),
      activity({
        activityId: "context-nested-child-link",
        queryId: "qry_context_nested_child",
        sessionId: "ses_context_nested_child",
        kind: "subagent",
        name: "reviewer",
        childSessionId: "ses_context_nested_grandchild"
      })
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      queryId: "qry_context_nested_root",
      inputTokens: 330,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 15,
      context: {
        schemaVersion: 1,
        accumulatedInputTokens: 425,
        initialInputContextTokens: 90,
        peakInputContextTokens: 210,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 15,
        observedLlmRequestCount: 3,
        contextGrowthInputTokens: 120,
        contextGrowthRatio: 210 / 90,
        basis: "derived_from_usage_atoms",
        coverage: "final"
      }
    });
    expect(runs[0].context).not.toHaveProperty("latestInputContextTokens");
    expect(runs[0].context?.accumulatedInputTokens).toBe(
      runs[0].inputTokens + runs[0].cacheReadInputTokens + runs[0].cacheCreationInputTokens
    );
  });

  it("retains only observed linked context and omits context when every linked run lacks input context", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const occurrences = [
      occurrence({
        queryId: "qry_context_absent_parent",
        sessionId: "ses_context_absent_parent",
        completedAt: "2026-06-08T00:10:00.000Z",
        completionEvidence: "stop_hook"
      }),
      occurrence({
        queryId: "qry_context_absent_child",
        sessionId: "ses_context_absent_child",
        startedAt: "2026-06-08T00:02:00.000Z",
        completedAt: "2026-06-08T00:04:00.000Z",
        completionEvidence: "stop_hook"
      })
    ];
    const links = [activity({
      activityId: "context-absent-link",
      queryId: "qry_context_absent_parent",
      sessionId: "ses_context_absent_parent",
      kind: "subagent",
      name: "explorer",
      childSessionId: "ses_context_absent_child"
    })];
    const oneObserved = pipeline.project([
      atom({
        atomId: "context-absent-parent-observed",
        correlationId: "qry_context_absent_parent",
        queryId: "qry_context_absent_parent",
        sessionId: "ses_context_absent_parent",
        inputTokens: 30,
        outputTokens: 3,
        cacheReadInputTokens: 10,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:10:00.000Z"
      }),
      atom({
        atomId: "context-absent-child-output-only",
        correlationId: "qry_context_absent_child",
        queryId: "qry_context_absent_child",
        sessionId: "ses_context_absent_child",
        inputTokens: undefined,
        outputTokens: 7,
        startedAt: "2026-06-08T00:02:00.000Z",
        endedAt: "2026-06-08T00:04:00.000Z"
      })
    ], new Date("2026-06-08T00:11:00.000Z"), occurrences, links)[0];

    expect(oneObserved.context).toEqual({
      schemaVersion: 1,
      accumulatedInputTokens: 40,
      initialInputContextTokens: 40,
      latestInputContextTokens: 40,
      peakInputContextTokens: 40,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 0,
      observedLlmRequestCount: 1,
      contextGrowthInputTokens: 0,
      contextGrowthRatio: 1,
      basis: "derived_from_usage_atoms",
      coverage: "partial"
    });

    const noneObserved = pipeline.project([
      atom({
        atomId: "context-absent-parent-output-only",
        correlationId: "qry_context_absent_parent",
        queryId: "qry_context_absent_parent",
        sessionId: "ses_context_absent_parent",
        inputTokens: undefined,
        outputTokens: 3,
        startedAt: "2026-06-08T00:00:00.000Z",
        endedAt: "2026-06-08T00:10:00.000Z"
      }),
      atom({
        atomId: "context-absent-child-output-only-both",
        correlationId: "qry_context_absent_child",
        queryId: "qry_context_absent_child",
        sessionId: "ses_context_absent_child",
        inputTokens: undefined,
        outputTokens: 7,
        startedAt: "2026-06-08T00:02:00.000Z",
        endedAt: "2026-06-08T00:04:00.000Z"
      })
    ], new Date("2026-06-08T00:11:00.000Z"), occurrences, links)[0];

    expect(noneObserved).not.toHaveProperty("context");
  });

  it("marks a same-name subagent aggregate complete only when every child session is exactly linked", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const runs = pipeline.project([
      atom({
        atomId: "multi-child-parent",
        correlationId: "qry_multi_child_parent",
        queryId: "qry_multi_child_parent",
        sessionId: "ses_multi_child_parent",
        inputTokens: 100,
        outputTokens: 20
      }),
      atom({
        atomId: "multi-child-a",
        correlationId: "qry_multi_child_a",
        queryId: "qry_multi_child_a",
        sessionId: "ses_multi_child_a",
        inputTokens: 40,
        outputTokens: 5
      }),
      atom({
        atomId: "multi-child-b",
        correlationId: "qry_multi_child_b",
        queryId: "qry_multi_child_b",
        sessionId: "ses_multi_child_b",
        inputTokens: 30,
        outputTokens: 4
      })
    ], new Date(), [
      occurrence({ queryId: "qry_multi_child_parent", sessionId: "ses_multi_child_parent" }),
      occurrence({ queryId: "qry_multi_child_a", sessionId: "ses_multi_child_a" }),
      occurrence({ queryId: "qry_multi_child_b", sessionId: "ses_multi_child_b" })
    ], [
      activity({
        activityId: "act_multi_child_a",
        queryId: "qry_multi_child_parent",
        sessionId: "ses_multi_child_parent",
        kind: "subagent",
        name: "explorer",
        childSessionId: "ses_multi_child_a"
      }),
      activity({
        activityId: "act_multi_child_b",
        queryId: "qry_multi_child_parent",
        sessionId: "ses_multi_child_parent",
        kind: "subagent",
        name: "explorer",
        childSessionId: "ses_multi_child_b"
      })
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].breakdown).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "subagent",
      name: "explorer",
      count: 2,
      inputTokens: 70,
      outputTokens: 9,
      totalTokens: 79,
      attributionBasis: "trace_descendant",
      coverage: "complete"
    })]));
    expect((runs[0].breakdown ?? []).reduce((sum, row) => sum + (row.totalTokens ?? 0), 0))
      .toBe(runs[0].totalTokens);
  });

  it("sums Codex model responses once and lets a cumulative turn trace supersede them", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const responseA = atom({
      atomId: "codex-response-a",
      correlationId: "qry_codex_responses",
      queryId: "qry_codex_responses",
      sessionId: "ses_codex_responses",
      authority: "request",
      signal: "logs",
      inputTokens: 100,
      outputTokens: 3,
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: "2026-06-08T00:00:01.000Z"
    });
    const responseB = atom({
      atomId: "codex-response-b",
      correlationId: "qry_codex_responses",
      queryId: "qry_codex_responses",
      sessionId: "ses_codex_responses",
      authority: "request",
      signal: "logs",
      inputTokens: 140,
      outputTokens: 5,
      startedAt: "2026-06-08T00:00:02.000Z",
      endedAt: "2026-06-08T00:00:02.000Z"
    });
    const occurrenceRecord = occurrence({
      queryId: "qry_codex_responses",
      sessionId: "ses_codex_responses",
      startedAt: "2026-06-08T00:00:00.000Z",
      completedAt: "2026-06-08T00:00:03.000Z",
      completionEvidence: "stop_hook"
    });

    expect(pipeline.project([responseA, responseB], new Date(), [occurrenceRecord])[0]).toMatchObject({
      authority: "request",
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:03.000Z",
      inputTokens: 240,
      outputTokens: 8,
      totalTokens: 248
    });

    const cumulativeTurn = atom({
      atomId: "codex-turn-total",
      correlationId: "qry_codex_responses",
      queryId: "qry_codex_responses",
      sessionId: "ses_codex_responses",
      authority: "turn",
      signal: "traces",
      sourceId: "otlp_codex_traces",
      profileVersion: "codex-otel-traces-v1",
      inputTokens: 240,
      outputTokens: 8,
      startedAt: "2026-06-08T00:00:00.000Z",
      endedAt: "2026-06-08T00:00:03.000Z"
    });
    expect(pipeline.project([responseA, responseB, cumulativeTurn], new Date(), [occurrenceRecord])[0]).toMatchObject({
      authority: "turn",
      inputTokens: 240,
      outputTokens: 8,
      totalTokens: 248,
      warnings: expect.arrayContaining(["lower_authority_overlap_discarded"])
    });
  });

  it("merges hook and trace evidence for one tool call without losing descendant usage", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({
        atomId: "tool-root-total",
        correlationId: "qry_tool_merge",
        queryId: "qry_tool_merge",
        authority: "turn",
        inputTokens: 100,
        outputTokens: 20
      }),
      atom({
        atomId: "tool-descendant-usage",
        correlationId: "qry_tool_merge",
        queryId: "qry_tool_merge",
        authority: "model",
        owningActivityId: "act_trace_tool",
        inputTokens: 30,
        outputTokens: 5
      })
    ], new Date(), [], [
      activity({
        activityId: "act_trace_tool",
        queryId: "qry_tool_merge",
        requestId: "req_shared_tool",
        name: "apply_patch",
        outcome: "success",
        evidenceBasis: "trace_span"
      }),
      activity({
        activityId: "act_hook_tool",
        queryId: "qry_tool_merge",
        requestId: "req_shared_tool",
        name: "apply_patch",
        outcome: "failure",
        evidenceBasis: "tool_hook"
      })
    ])[0];

    expect(run.toolCallCount).toBe(1);
    expect(run.breakdown).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "tool",
      name: "apply_patch",
      count: 1,
      failureCount: 1,
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
      attributionBasis: "trace_descendant"
    })]));
    expect((run.breakdown ?? []).reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(run.totalTokens);
  });

  it("collapses parallel Claude Agent, trace, and SubagentStart copies only by exact identities", () => {
    const activities = ["a", "b", "c"].flatMap((suffix) => [
      activity({
        activityId: `act_claude_agent_trace_${suffix}`,
        queryId: "qry_claude_parallel_agents",
        requestId: `req_claude_agent_${suffix}`,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "unknown",
        evidenceBasis: "trace_span",
        evidenceSourceId: "otlp_claude_code_traces",
        startedAt: "2026-06-08T00:00:01.000Z",
        endedAt: "2026-06-08T00:00:04.000Z",
        durationMs: 3_000
      }),
      activity({
        activityId: `act_claude_agent_hook_${suffix}`,
        queryId: "qry_claude_parallel_agents",
        requestId: `req_claude_agent_${suffix}`,
        childSessionId: `ses_claude_child_${suffix}`,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "unknown",
        evidenceBasis: "subagent_hook",
        evidenceSourceId: "hook_claude_code_tools",
        startedAt: "2026-06-08T00:00:00.994Z",
        endedAt: "2026-06-08T00:00:01.000Z",
        durationMs: 6
      }),
      activity({
        activityId: `act_claude_subagent_start_${suffix}`,
        queryId: "qry_claude_parallel_agents",
        requestId: `req_claude_child_${suffix}`,
        childSessionId: `ses_claude_child_${suffix}`,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "unknown",
        evidenceBasis: "subagent_hook",
        evidenceSourceId: "hook_claude_code_lifecycle",
        startedAt: "2026-06-08T00:00:01.001Z"
      })
    ]);

    const preferred = preferredSafeActivities(activities);
    expect(preferred).toHaveLength(3);
    expect(preferred.map((item) => item.activityId).sort()).toEqual([
      "act_claude_agent_trace_a",
      "act_claude_agent_trace_b",
      "act_claude_agent_trace_c"
    ]);
    expect(preferred.map((item) => item.childSessionId).sort()).toEqual([
      "ses_claude_child_a",
      "ses_claude_child_b",
      "ses_claude_child_c"
    ]);
    expect(preferred.every((item) =>
      item.kind === "subagent"
      && item.name === "Explore"
      && item.outcome === "unknown"
      && item.startedAt === "2026-06-08T00:00:01.001Z"
      && item.endedAt == null
      && item.durationMs == null
      && item.evidenceSourceId === "hook_claude_code_lifecycle"
    )).toBe(true);
  });

  it("allocates every exact Claude child owner across trace and event launch components", () => {
    const queryId = "qry_claude_mixed_child_owners";
    const sessionId = "ses_claude_mixed_child_owners";
    const childSpecs = [
      { suffix: "a", ownerBasis: "trace_span" as const, input: 4, output: 10, cacheRead: 100, cacheCreate: 10 },
      { suffix: "b", ownerBasis: "trace_span" as const, input: 5, output: 11, cacheRead: 200, cacheCreate: 20 },
      { suffix: "c", ownerBasis: "otel_event" as const, input: 6, output: 12, cacheRead: 300, cacheCreate: 30 }
    ];
    const activities = childSpecs.flatMap(({ suffix, ownerBasis }) => [
      activity({
        activityId: `act_claude_owner_${suffix}`,
        queryId,
        sessionId,
        requestId: `req_claude_agent_${suffix}`,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "unknown",
        evidenceBasis: ownerBasis,
        evidenceSourceId: ownerBasis === "trace_span" ? "otlp_claude_code_traces" : "otlp_claude_code_logs",
        startedAt: `2026-07-12T21:58:2${suffix === "a" ? "3" : suffix === "b" ? "5" : "6"}.000Z`,
        endedAt: `2026-07-12T21:58:2${suffix === "a" ? "3" : suffix === "b" ? "5" : "6"}.003Z`
      }),
      activity({
        activityId: `act_claude_agent_hook_${suffix}`,
        queryId,
        sessionId,
        requestId: `req_claude_agent_${suffix}`,
        childSessionId: `ses_claude_child_${suffix}`,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "unknown",
        evidenceBasis: "subagent_hook",
        evidenceSourceId: "hook_claude_code_tools",
        startedAt: `2026-07-12T21:58:2${suffix === "a" ? "3" : suffix === "b" ? "5" : "6"}.004Z`
      }),
      activity({
        activityId: `act_claude_subagent_start_${suffix}`,
        queryId,
        sessionId,
        requestId: `req_claude_child_${suffix}`,
        childSessionId: `ses_claude_child_${suffix}`,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "unknown",
        evidenceBasis: "subagent_hook",
        evidenceSourceId: "hook_claude_code_lifecycle",
        startedAt: `2026-07-12T21:58:2${suffix === "a" ? "3" : suffix === "b" ? "5" : "6"}.005Z`
      })
    ]);
    const rootUsage = atom({
      atomId: "atom_claude_mixed_child_root",
      correlationId: queryId,
      queryId,
      sessionId,
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      signal: "traces",
      sourceId: "otlp_claude_code_traces",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 1_000,
      cacheCreationInputTokens: 100
    });
    const childUsage = childSpecs.map(({ suffix, input, output, cacheRead, cacheCreate }) => atom({
      atomId: `atom_claude_child_${suffix}`,
      correlationId: queryId,
      queryId,
      sessionId,
      requestId: `req_claude_usage_${suffix}`,
      owningActivityId: `act_claude_owner_${suffix}`,
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      signal: "traces",
      sourceId: "otlp_claude_code_traces",
      model: "claude-sonnet-5",
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreate
    }));
    const project = (orderedActivities: SafeActivityAtomV1[]) =>
      new DefaultProductionUsagePipeline().project(
        [rootUsage, ...childUsage],
        new Date("2026-07-12T22:00:00.000Z"),
        [occurrence({
          queryId,
          sessionId,
          provider: "claude-code",
          runtime: "claude-code"
        })],
        orderedActivities
      )[0];

    for (const run of [project(activities), project([...activities].reverse())]) {
      expect(run).toMatchObject({
        inputTokens: 115,
        outputTokens: 53,
        cacheReadInputTokens: 1_600,
        cacheCreationInputTokens: 160,
        totalTokens: 168
      });
      expect(run.breakdown).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "subagent",
          name: "Explore",
          count: 3,
          unknownCount: 3,
          inputTokens: 15,
          outputTokens: 33,
          cacheReadInputTokens: 600,
          cacheCreationInputTokens: 60,
          totalTokens: 48,
          attributionBasis: "trace_descendant",
          coverage: "complete"
        }),
        expect.objectContaining({
          kind: "unallocated",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 1_000,
          cacheCreationInputTokens: 100,
          totalTokens: 120
        })
      ]));
      expect((run.breakdown ?? []).reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(run.totalTokens);
    }

    const partial = new DefaultProductionUsagePipeline().project(
      [rootUsage, ...childUsage.slice(0, 2)],
      new Date("2026-07-12T22:00:00.000Z"),
      [occurrence({
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code"
      })],
      activities
    )[0];
    expect(partial.breakdown).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "subagent",
      name: "Explore",
      count: 3,
      inputTokens: 9,
      outputTokens: 21,
      totalTokens: 30,
      attributionBasis: "trace_descendant",
      coverage: "partial"
    })]));
  });

  it("fails Claude child usage ownership closed when one exact component conflicts", () => {
    const queryId = "qry_claude_conflicting_child_owner";
    const sessionId = "ses_claude_conflicting_child_owner";
    const activities = [
      activity({
        activityId: "act_claude_conflicting_owner",
        queryId,
        sessionId,
        requestId: "req_claude_conflicting_agent",
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "unknown",
        evidenceBasis: "otel_event",
        evidenceSourceId: "otlp_claude_code_logs"
      }),
      ...["a", "b"].flatMap((suffix) => [
        activity({
          activityId: `act_claude_conflicting_hook_${suffix}`,
          queryId,
          sessionId,
          requestId: "req_claude_conflicting_agent",
          childSessionId: `ses_claude_conflicting_child_${suffix}`,
          provider: "claude-code",
          runtime: "claude-code",
          kind: "subagent",
          name: "Explore",
          outcome: "unknown",
          evidenceBasis: "subagent_hook",
          evidenceSourceId: "hook_claude_code_tools"
        }),
        activity({
          activityId: `act_claude_conflicting_start_${suffix}`,
          queryId,
          sessionId,
          requestId: `req_claude_conflicting_child_${suffix}`,
          childSessionId: `ses_claude_conflicting_child_${suffix}`,
          provider: "claude-code",
          runtime: "claude-code",
          kind: "subagent",
          name: "Explore",
          outcome: "unknown",
          evidenceBasis: "subagent_hook",
          evidenceSourceId: "hook_claude_code_lifecycle"
        })
      ])
    ];
    const usage = [
      atom({
        atomId: "atom_claude_conflicting_root",
        correlationId: queryId,
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        inputTokens: 100,
        outputTokens: 20
      }),
      atom({
        atomId: "atom_claude_conflicting_child",
        correlationId: queryId,
        queryId,
        sessionId,
        owningActivityId: "act_claude_conflicting_owner",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        inputTokens: 7,
        outputTokens: 3
      })
    ];
    const run = new DefaultProductionUsagePipeline().project(usage, new Date(), [occurrence({
      queryId,
      sessionId,
      provider: "claude-code",
      runtime: "claude-code"
    })], activities)[0];

    expect(run.breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "subagent",
        name: "Explore",
        attributionBasis: "activity_only",
        coverage: "unavailable"
      }),
      expect.objectContaining({
        kind: "unallocated",
        inputTokens: 107,
        outputTokens: 23,
        totalTokens: 130
      })
    ]));
  });

  it("keeps every signal copy of a conflicted Claude request unallocated", () => {
    const queryId = "qry_claude_durable_owner_conflict";
    const sessionId = "ses_claude_durable_owner_conflict";
    const requestId = "req_claude_durable_owner_conflict";
    const bashOwner = "act_claude_conflict_bash";
    const agentOwner = "act_claude_conflict_agent";
    const root = atom({ atomId: "atom_conflict_root", correlationId: queryId, queryId, sessionId, requestId: "req_conflict_root", provider: "claude-code", runtime: "claude-code", authority: "request", inputTokens: 100, outputTokens: 20 });
    const lowerLog = atom({ atomId: "atom_conflict_log", correlationId: queryId, queryId, sessionId, requestId, owningActivityId: bashOwner, provider: "claude-code", runtime: "claude-code", authority: "request", signal: "logs", sourceId: "otlp_claude_code_logs", inputTokens: 2, outputTokens: 79 });
    const preferredTraceConflict = atom({ atomId: "atom_conflict_trace", correlationId: queryId, queryId, sessionId, requestId, ownershipConflictActivityIds: [bashOwner, agentOwner], provider: "claude-code", runtime: "claude-code", authority: "request", signal: "traces", sourceId: "otlp_claude_code_traces", inputTokens: 2, outputTokens: 79 });
    const activities = [
      activity({ activityId: bashOwner, queryId, sessionId, provider: "claude-code", runtime: "claude-code", kind: "tool", name: "Bash", outcome: "unknown" }),
      activity({ activityId: agentOwner, queryId, sessionId, provider: "claude-code", runtime: "claude-code", kind: "subagent", name: "Explore", outcome: "unknown" })
    ];
    const project = (usage: SafeUsageAtomV1[]) => new DefaultProductionUsagePipeline().project(
      usage,
      new Date("2026-07-12T22:47:00.000Z"),
      [occurrence({ queryId, sessionId, provider: "claude-code", runtime: "claude-code" })],
      activities
    )[0];

    for (const projected of [
      project([root, lowerLog, preferredTraceConflict]),
      project([preferredTraceConflict, lowerLog, root])
    ]) {
      expect(projected).toMatchObject({ inputTokens: 102, outputTokens: 99, totalTokens: 201 });
      expect(projected.breakdown).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "Bash", attributionBasis: "activity_only", coverage: "unavailable" }),
        expect.objectContaining({ kind: "subagent", name: "Explore", attributionBasis: "activity_only", coverage: "unavailable" }),
        expect.objectContaining({ kind: "unallocated", inputTokens: 102, outputTokens: 99, totalTokens: 201 })
      ]));
      expect((projected.breakdown ?? []).reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(projected.totalTokens);
    }
  });

  it("marks a tool group partial when valid usage coexists with a conflicted request", () => {
    const queryId = "qry_claude_partial_tool_conflict";
    const sessionId = "ses_claude_partial_tool_conflict";
    const bashOwner = "act_claude_partial_bash";
    const agentOwner = "act_claude_partial_agent";
    const usage = [
      atom({
        atomId: "atom_partial_tool_root",
        correlationId: queryId,
        queryId,
        sessionId,
        requestId: "req_partial_tool_root",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        inputTokens: 100,
        outputTokens: 20
      }),
      atom({
        atomId: "atom_partial_tool_valid",
        correlationId: queryId,
        queryId,
        sessionId,
        requestId: "req_partial_tool_valid",
        owningActivityId: bashOwner,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        inputTokens: 5,
        outputTokens: 7
      }),
      atom({
        atomId: "atom_partial_tool_conflict",
        correlationId: queryId,
        queryId,
        sessionId,
        requestId: "req_partial_tool_conflict",
        ownershipConflictActivityIds: [bashOwner, agentOwner],
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        inputTokens: 2,
        outputTokens: 79
      })
    ];
    const run = new DefaultProductionUsagePipeline().project(
      usage,
      new Date("2026-07-12T22:47:00.000Z"),
      [occurrence({ queryId, sessionId, provider: "claude-code", runtime: "claude-code" })],
      [activity({
        activityId: bashOwner,
        queryId,
        sessionId,
        provider: "claude-code",
        runtime: "claude-code",
        kind: "tool",
        name: "Bash",
        outcome: "unknown"
      })]
    )[0];

    expect(run.breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool",
        name: "Bash",
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
        attributionBasis: "trace_descendant",
        coverage: "partial"
      }),
      expect.objectContaining({
        kind: "unallocated",
        inputTokens: 102,
        outputTokens: 99,
        totalTokens: 201
      })
    ]));
    expect((run.breakdown ?? []).reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(run.totalTokens);
  });

  it("reconciles distinct Claude trace revisions by request and retains owner conflict", () => {
    const queryId = "qry_claude_request_revision";
    const sessionId = "ses_claude_request_revision";
    const requestId = "req_claude_request_revision";
    const bashOwner = "act_claude_revision_bash";
    const agentOwner = "act_claude_revision_agent";
    const root = atom({
      atomId: "atom_claude_revision_root",
      correlationId: queryId,
      queryId,
      sessionId,
      requestId: "req_claude_revision_root",
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      signal: "traces",
      inputTokens: 100,
      outputTokens: 20
    });
    const revision = (atomId: string, owner: string) => atom({
      atomId,
      correlationId: queryId,
      queryId,
      sessionId,
      requestId,
      owningActivityId: owner,
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      signal: "traces",
      inputTokens: 2,
      outputTokens: 79,
      endedAt: "2026-07-12T22:46:42.000Z"
    });
    const activities = [
      activity({ activityId: bashOwner, queryId, sessionId, provider: "claude-code", runtime: "claude-code", kind: "tool", name: "Bash" }),
      activity({ activityId: agentOwner, queryId, sessionId, provider: "claude-code", runtime: "claude-code", kind: "subagent", name: "Explore" })
    ];
    const project = (usage: SafeUsageAtomV1[]) => new DefaultProductionUsagePipeline().project(
      usage,
      new Date("2026-07-12T22:47:00.000Z"),
      [occurrence({ queryId, sessionId, provider: "claude-code", runtime: "claude-code" })],
      activities
    )[0];

    for (const run of [
      project([root, revision("atom_claude_revision_a", bashOwner), revision("atom_claude_revision_b", agentOwner)]),
      project([revision("atom_claude_revision_b", agentOwner), revision("atom_claude_revision_a", bashOwner), root])
    ]) {
      expect(run).toMatchObject({ inputTokens: 102, outputTokens: 99, totalTokens: 201 });
      expect(run.breakdown).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "Bash", coverage: "unavailable" }),
        expect.objectContaining({ kind: "subagent", name: "Explore", coverage: "unavailable" }),
        expect.objectContaining({ kind: "unallocated", inputTokens: 102, outputTokens: 99, totalTokens: 201 })
      ]));
    }
  });

  it("ignores a superseded open Claude request revision when projecting authoritative completion", () => {
    const queryId = "qry_claude_closed_request_revision";
    const sessionId = "ses_claude_closed_request_revision";
    const requestId = "req_claude_closed_request_revision";
    const root = atom({
      atomId: "atom_claude_closed_revision_root",
      correlationId: queryId,
      queryId,
      sessionId,
      requestId: "req_claude_closed_revision_root",
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      signal: "traces",
      inputTokens: 100,
      outputTokens: 20,
      endedAt: "2026-07-12T22:46:42.000Z"
    });
    const openRevision = atom({
      atomId: "atom_claude_open_request_revision",
      correlationId: queryId,
      queryId,
      sessionId,
      requestId,
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      signal: "traces",
      inputTokens: 9,
      outputTokens: 90,
      endedAt: undefined
    });
    const closedRevision = atom({
      atomId: "atom_claude_closed_request_revision",
      correlationId: queryId,
      queryId,
      sessionId,
      requestId,
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      signal: "traces",
      inputTokens: 3,
      outputTokens: 80,
      endedAt: "2026-07-12T22:46:43.000Z"
    });
    const completedOccurrence = occurrence({
      queryId,
      sessionId,
      provider: "claude-code",
      runtime: "claude-code",
      completedAt: "2026-07-12T22:46:46.840Z",
      completionEvidence: "closed_root_span"
    });
    const project = (usage: SafeUsageAtomV1[]) => new DefaultProductionUsagePipeline().project(
      usage,
      new Date("2026-07-12T22:47:00.000Z"),
      [completedOccurrence]
    )[0];

    for (const run of [
      project([root, openRevision, closedRevision]),
      project([closedRevision, openRevision, root])
    ]) {
      expect(run).toMatchObject({
        inputTokens: 103,
        outputTokens: 100,
        totalTokens: 203,
        endedAt: "2026-07-12T22:46:46.840Z"
      });
    }
  });

  it("merges exact Claude tool decisions without fabricating accepted execution", () => {
    const trace = activity({
      activityId: "act_claude_decision_trace",
      queryId: "qry_claude_decision",
      requestId: "req_claude_decision",
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "unknown",
      evidenceBasis: "trace_span",
      evidenceSourceId: "otlp_claude_code_traces",
      startedAt: "2026-07-14T04:00:00.000Z",
      endedAt: "2026-07-14T04:00:01.000Z"
    });
    const rejectedDecision = activity({
      activityId: "act_claude_decision_rejected",
      queryId: "qry_claude_decision",
      requestId: "req_claude_decision",
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "rejected",
      evidenceBasis: "otel_event",
      evidenceSourceId: "otlp_claude_code_logs",
      startedAt: "2026-07-14T04:00:00.500Z",
      endedAt: "2026-07-14T04:00:00.500Z"
    });
    const acceptedDecision = {
      ...rejectedDecision,
      activityId: "act_claude_decision_accepted",
      outcome: "unknown" as const
    };

    expect(preferredSafeActivities([trace, rejectedDecision])).toEqual([
      expect.objectContaining({
        activityId: "act_claude_decision_trace",
        name: "Write",
        outcome: "rejected"
      })
    ]);
    expect(preferredSafeActivities([trace, acceptedDecision])).toEqual([
      expect.objectContaining({
        activityId: "act_claude_decision_trace",
        name: "Write",
        outcome: "unknown"
      })
    ]);
  });

  it("preserves an exact native Claude denial over same-tool generic failure evidence", () => {
    const rejectedDecision = activity({
      activityId: "act_claude_native_decision",
      queryId: "qry_claude_native_decision",
      requestId: "req_claude_native_decision",
      invocationId: "invocation_claude_native_decision",
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      evidenceBasis: "otel_event",
      evidenceSourceId: "otlp_claude_code_logs",
      startedAt: "2026-07-14T04:00:00.500Z"
    });
    const genericFailure = activity({
      activityId: "act_claude_native_result",
      queryId: "qry_claude_native_decision",
      requestId: "req_claude_native_decision",
      invocationId: "invocation_claude_native_decision",
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "failure",
      durationMs: 1_000,
      resultSizeBytes: 256,
      providerReportedResultTokens: 12,
      sensitiveAuditEvidence: [{
        schemaVersion: 1,
        evidenceId: "audit_native_result",
        kind: "tool_output",
        queryId: "qry_claude_native_decision",
        capturedAt: "2026-07-14T04:00:01.000Z"
      }],
      evidenceBasis: "trace_span",
      evidenceSourceId: "otlp_claude_code_traces",
      startedAt: "2026-07-14T04:00:00.000Z",
      endedAt: "2026-07-14T04:00:01.000Z"
    });

    for (const replay of [
      [rejectedDecision, genericFailure],
      [genericFailure, rejectedDecision]
    ]) {
      const [merged] = preferredSafeActivities(replay);
      expect(merged).toMatchObject({
        activityId: "act_claude_native_decision",
        requestId: "req_claude_native_decision",
        kind: "tool",
        name: "Write",
        outcome: "rejected",
        outcomeAuthority: "native_permission_decision",
        startedAt: "2026-07-14T04:00:00.500Z"
      });
      expect(merged).not.toHaveProperty("endedAt");
      expect(merged).not.toHaveProperty("durationMs");
      expect(merged).not.toHaveProperty("resultSizeBytes");
      expect(merged).not.toHaveProperty("providerReportedResultTokens");
      expect(merged).not.toHaveProperty("sensitiveAuditEvidence");
    }
  });

  it("does not merge a native Claude decision across distinct tool invocations, while legacy request fallback remains narrow", () => {
    const generic = activity({
      activityId: "act_claude_reused_request_generic",
      queryId: "qry_claude_reused_request",
      requestId: "req_reused_claude_request",
      invocationId: "invocation_first_write",
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "success",
      evidenceBasis: "tool_hook",
      startedAt: "2026-07-14T04:10:00.000Z"
    });
    const unrelatedDecision = activity({
      ...generic,
      activityId: "act_claude_reused_request_native_other",
      invocationId: "invocation_second_write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      evidenceBasis: "otel_event",
      evidenceSourceId: "otlp_claude_code_logs"
    });

    expect(preferredSafeActivities([generic, unrelatedDecision])).toEqual(expect.arrayContaining([
      expect.objectContaining({ activityId: generic.activityId, outcome: "success" }),
      expect.objectContaining({ activityId: unrelatedDecision.activityId, outcome: "rejected" })
    ]));
    expect(preferredSafeActivities([generic, unrelatedDecision])).toHaveLength(2);

    const legacyGeneric = { ...generic, activityId: "act_claude_legacy_generic", invocationId: undefined };
    const legacyDecision = {
      ...unrelatedDecision,
      activityId: "act_claude_legacy_native",
      invocationId: undefined
    };
    expect(preferredSafeActivities([legacyGeneric, legacyDecision])).toEqual([
      expect.objectContaining({
        activityId: legacyDecision.activityId,
        outcome: "rejected",
        outcomeAuthority: "native_permission_decision"
      })
    ]);
  });

  it("keeps rejected Claude permission decisions and generic descendant usage separate", () => {
    const queryId = "qry_claude_rejected_usage";
    const sessionId = "ses_claude_rejected_usage";
    const rejectedDecision = activity({
      activityId: "act_claude_rejected_permission",
      queryId,
      sessionId,
      requestId: "req_claude_rejected_tool",
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      evidenceBasis: "otel_event",
      evidenceSourceId: "otlp_claude_code_logs",
      startedAt: "2026-07-14T04:00:00.500Z"
    });
    const genericTraceResult = activity({
      activityId: "act_claude_rejected_generic_trace",
      queryId,
      sessionId,
      requestId: "req_claude_rejected_tool",
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "failure",
      evidenceBasis: "trace_span",
      evidenceSourceId: "otlp_claude_code_traces",
      startedAt: "2026-07-14T04:00:00.000Z",
      endedAt: "2026-07-14T04:00:01.000Z"
    });
    const usage = [
      atom({
        atomId: "atom_claude_rejected_root",
        correlationId: queryId,
        queryId,
        sessionId,
        requestId: "req_claude_rejected_root",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        signal: "traces",
        inputTokens: 100,
        outputTokens: 20
      }),
      atom({
        atomId: "atom_claude_rejected_generic_descendant",
        correlationId: queryId,
        queryId,
        sessionId,
        requestId: "req_claude_rejected_generic_descendant",
        owningActivityId: genericTraceResult.activityId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        signal: "traces",
        inputTokens: 7,
        outputTokens: 3
      }),
      atom({
        atomId: "atom_claude_rejected_decision_descendant",
        correlationId: queryId,
        queryId,
        sessionId,
        requestId: "req_claude_rejected_decision_descendant",
        owningActivityId: rejectedDecision.activityId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        signal: "traces",
        inputTokens: 11,
        outputTokens: 5
      })
    ];
    const project = (activities: SafeActivityAtomV1[]) => new DefaultProductionUsagePipeline().project(
      usage,
      new Date("2026-07-14T04:01:00.000Z"),
      [occurrence({ queryId, sessionId, provider: "claude-code", runtime: "claude-code" })],
      activities
    )[0];

    for (const run of [
      project([rejectedDecision, genericTraceResult]),
      project([genericTraceResult, rejectedDecision])
    ]) {
      expect(run).toMatchObject({
        inputTokens: 118,
        outputTokens: 28,
        totalTokens: 146
      });
      expect(run.breakdown).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          name: "Write",
          count: 1,
          failureCount: 1,
          rejectedCount: 1,
          attributionBasis: "activity_only",
          coverage: "unavailable"
        }),
        expect.objectContaining({
          kind: "unallocated",
          inputTokens: 118,
          outputTokens: 28,
          totalTokens: 146
        })
      ]));
      const rejectedBreakdown = run.breakdown?.find((row) => row.kind === "tool" && row.name === "Write");
      expect(rejectedBreakdown).not.toHaveProperty("inputTokens");
      expect(rejectedBreakdown).not.toHaveProperty("outputTokens");
      expect((run.breakdown ?? []).reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(run.totalTokens);
    }
  });

  it("keeps an incompatible same-request Claude activity independent of a native rejection", () => {
    const queryId = "qry_claude_incompatible_rejection";
    const sessionId = "ses_claude_incompatible_rejection";
    const requestId = "req_claude_incompatible_rejection";
    const rejectedDecision = activity({
      activityId: "act_claude_incompatible_decision",
      queryId,
      sessionId,
      requestId,
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      evidenceBasis: "otel_event",
      evidenceSourceId: "otlp_claude_code_logs",
      startedAt: "2026-07-14T04:00:00.500Z"
    });
    const unrelatedGenericActivity = activity({
      activityId: "act_claude_incompatible_generic",
      queryId,
      sessionId,
      requestId,
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Bash",
      outcome: "success",
      evidenceBasis: "trace_span",
      evidenceSourceId: "otlp_claude_code_traces",
      startedAt: "2026-07-14T04:00:00.000Z",
      endedAt: "2026-07-14T04:00:01.000Z"
    });
    const usage = [
      atom({
        atomId: "atom_claude_incompatible_root",
        correlationId: queryId,
        queryId,
        sessionId,
        requestId: "req_claude_incompatible_root",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        signal: "traces",
        inputTokens: 100,
        outputTokens: 20
      }),
      atom({
        atomId: "atom_claude_incompatible_decision_descendant",
        correlationId: queryId,
        queryId,
        sessionId,
        requestId: "req_claude_incompatible_decision_descendant",
        owningActivityId: rejectedDecision.activityId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        signal: "traces",
        inputTokens: 7,
        outputTokens: 3
      }),
      atom({
        atomId: "atom_claude_incompatible_generic_descendant",
        correlationId: queryId,
        queryId,
        sessionId,
        requestId: "req_claude_incompatible_generic_descendant",
        owningActivityId: unrelatedGenericActivity.activityId,
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        signal: "traces",
        inputTokens: 11,
        outputTokens: 5
      })
    ];
    const project = (activities: SafeActivityAtomV1[]) => new DefaultProductionUsagePipeline().project(
      usage,
      new Date("2026-07-14T04:01:00.000Z"),
      [occurrence({ queryId, sessionId, provider: "claude-code", runtime: "claude-code" })],
      activities
    )[0];

    for (const run of [
      project([rejectedDecision, unrelatedGenericActivity]),
      project([unrelatedGenericActivity, rejectedDecision])
    ]) {
      expect(run).toMatchObject({
        toolCallCount: 2,
        inputTokens: 118,
        outputTokens: 28,
        totalTokens: 146
      });
      expect(run.breakdown).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          name: "Write",
          count: 1,
          failureCount: 1,
          rejectedCount: 1,
          attributionBasis: "activity_only",
          coverage: "unavailable"
        }),
        expect.objectContaining({
          kind: "tool",
          name: "Bash",
          count: 1,
          failureCount: 0,
          inputTokens: 11,
          outputTokens: 5,
          totalTokens: 16,
          attributionBasis: "trace_descendant",
          coverage: "complete"
        }),
        expect.objectContaining({
          kind: "unallocated",
          inputTokens: 107,
          outputTokens: 23,
          totalTokens: 130
        })
      ]));
      const rejectedBreakdown = run.breakdown?.find((row) => row.kind === "tool" && row.name === "Write");
      expect(rejectedBreakdown).not.toHaveProperty("inputTokens");
      expect(rejectedBreakdown).not.toHaveProperty("outputTokens");
      expect((run.breakdown ?? []).reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(run.totalTokens);
    }
  });

  it("keeps a native Claude denial distinct from an incompatible child identity", () => {
    const rejectedDecision = activity({
      activityId: "act_claude_native_decision_child",
      queryId: "qry_claude_native_decision_child",
      requestId: "req_claude_native_decision_child",
      childSessionId: "ses_shared_child",
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      startedAt: "2026-07-14T04:00:00.500Z"
    });
    const otherToolFailure = activity({
      activityId: "act_claude_other_child",
      queryId: "qry_claude_native_decision_child",
      requestId: "req_claude_other_tool",
      childSessionId: "ses_shared_child",
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Read",
      outcome: "failure",
      startedAt: "2026-07-14T04:00:01.000Z"
    });

    expect(preferredSafeActivities([rejectedDecision, otherToolFailure])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activityId: "act_claude_native_decision_child",
        outcome: "rejected",
        outcomeAuthority: "native_permission_decision"
      }),
      expect.objectContaining({
        activityId: "act_claude_other_child",
        outcome: "failure"
      })
    ]));
  });

  it("keeps a linked Claude Agent launch open without lifecycle evidence", () => {
    const preferred = preferredSafeActivities([
      activity({
        activityId: "act_claude_open_agent_trace",
        queryId: "qry_claude_open_agent",
        requestId: "req_claude_open_agent",
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "success",
        evidenceBasis: "trace_span",
        evidenceSourceId: "otlp_claude_code_traces",
        startedAt: "2026-06-08T00:00:00.990Z",
        endedAt: "2026-06-08T00:00:01.005Z",
        durationMs: 15
      }),
      activity({
        activityId: "act_claude_open_agent_event",
        queryId: "qry_claude_open_agent",
        requestId: "req_claude_open_agent",
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "success",
        evidenceBasis: "otel_event",
        evidenceSourceId: "otlp_claude_code_logs",
        startedAt: "2026-06-08T00:00:00.992Z",
        endedAt: "2026-06-08T00:00:01.004Z",
        durationMs: 12
      }),
      activity({
        activityId: "act_claude_open_agent_hook",
        queryId: "qry_claude_open_agent",
        requestId: "req_claude_open_agent",
        childSessionId: "ses_claude_open_child",
        provider: "claude-code",
        runtime: "claude-code",
        kind: "subagent",
        name: "Explore",
        outcome: "unknown",
        evidenceBasis: "subagent_hook",
        evidenceSourceId: "hook_claude_code_tools",
        timingConfidence: "medium",
        startedAt: "2026-06-08T00:00:01.000Z"
      })
    ]);

    expect(preferred).toEqual([expect.objectContaining({
      activityId: "act_claude_open_agent_trace",
      childSessionId: "ses_claude_open_child",
      kind: "subagent",
      name: "Explore",
      outcome: "unknown",
      evidenceBasis: "subagent_hook",
      evidenceSourceId: "hook_claude_code_tools",
      timingConfidence: "medium",
      startedAt: "2026-06-08T00:00:01.000Z",
      endedAt: undefined,
      durationMs: undefined
    })]);
  });

  it("merges Codex shell hook and protocol evidence without inventing an outcome", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([atom({
      atomId: "codex-tool-outcome-root",
      correlationId: "qry_codex_tool_outcome",
      queryId: "qry_codex_tool_outcome",
      inputTokens: 10,
      outputTokens: 2
    })], new Date(), [], [
      activity({
        activityId: "act_codex_tool_hook",
        queryId: "qry_codex_tool_outcome",
        requestId: "req_codex_tool_outcome",
        name: "Bash",
        outcome: "unknown",
        evidenceBasis: "tool_hook"
      }),
      activity({
        activityId: "act_codex_tool_result",
        queryId: "qry_codex_tool_outcome",
        requestId: "req_codex_tool_outcome",
        name: "exec_command",
        outcome: "unknown",
        evidenceBasis: "otel_event"
      })
    ])[0];

    expect(run.toolCallCount).toBe(1);
    expect(run.breakdown).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "tool",
      name: "Bash",
      count: 1,
      failureCount: 0,
      unknownCount: 1
    })]));
  });

  it("keeps merged Claude shell hook and OTLP wrapper evidence unknown", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([atom({
      atomId: "claude-shell-outcome-root",
      correlationId: "qry_claude_shell_outcome",
      queryId: "qry_claude_shell_outcome",
      provider: "claude-code",
      runtime: "claude-code",
      authority: "request",
      inputTokens: 4,
      outputTokens: 233
    })], new Date(), [occurrence({
      queryId: "qry_claude_shell_outcome",
      provider: "claude-code",
      runtime: "claude-code"
    })], [
      activity({
        activityId: "act_claude_shell_hook",
        queryId: "qry_claude_shell_outcome",
        requestId: "req_claude_shell_outcome",
        provider: "claude-code",
        runtime: "claude-code",
        name: "Bash",
        outcome: "unknown",
        evidenceBasis: "tool_hook"
      }),
      activity({
        activityId: "act_claude_shell_wrapper",
        queryId: "qry_claude_shell_outcome",
        requestId: "req_claude_shell_outcome",
        provider: "claude-code",
        runtime: "claude-code",
        name: "Bash",
        outcome: "unknown",
        evidenceBasis: "otel_event"
      })
    ])[0];

    expect(run.toolCallCount).toBe(1);
    expect(run.breakdown).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "tool",
      name: "Bash",
      count: 1,
      failureCount: 0,
      unknownCount: 1
    })]));
  });

  it("does not let a prompt-start lifecycle atom keep completed usage current", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const completed = pipeline.project([
      atom({
        atomId: "prompt-start",
        kind: "lifecycle",
        lifecycle: "query_started",
        inputTokens: undefined,
        outputTokens: undefined,
        endedAt: undefined
      }),
      atom({ atomId: "completed-usage", endedAt: "2026-06-08T00:00:02.000Z" })
    ]);
    expect(completed[0].endedAt).toBe("2026-06-08T00:00:02.000Z");
  });

  it("prices Codex only when verified auth-mode evidence proves direct API billing", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const direct = pipeline.project([atom({ billingContext: "openai-direct" })])[0];
    expect(direct).toMatchObject({
      billingContext: "openai-direct",
      costCoverage: "complete",
      estimatedNanoUsd: expect.any(Number),
      usageValueNanoUsd: 100_000,
      warnings: []
    });
    const subscription = pipeline.project([atom({ billingContext: "subscription" })])[0];
    expect(subscription).toMatchObject({
      billingContext: "subscription",
      costCoverage: "unavailable",
      estimatedNanoUsd: undefined,
      usageValueNanoUsd: 100_000,
      warnings: ["subscription_usage_only"]
    });
  });

  it("prices current Codex gpt-5.5 direct API runs", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({
        model: "gpt-5.5",
        billingContext: "openai-direct",
        inputTokens: 10,
        outputTokens: 5
      })
    ])[0];
    expect(run).toMatchObject({
      costCoverage: "complete",
      estimatedNanoUsd: 200_000,
      usageValueNanoUsd: 200_000,
      pricingVersion: "openai-pricing-2026-07-01-standard",
      warnings: []
    });
  });

  it("prices updated direct OpenAI and Anthropic catalog rows in live run projection", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const cases: [model: string, billingContext: SafeUsageAtomV1["billingContext"], inputTokens: number, outputTokens: number, expectedNanoUsd: number][] = [
      ["gpt-5.4", "openai-direct", 272_001, 1_000, 1_382_505_000],
      ["gpt-5.5-pro", "openai-direct", 272_001, 1_000, 16_590_060_000],
      ["gpt-5.4-nano", "openai-direct", 1_000_000, 1_000_000, 1_450_000_000],
      ["claude-sonnet-5", "anthropic-direct", 1_000_000, 1_000_000, 12_000_000_000],
      ["claude-fable-5", "anthropic-direct", 1_000_000, 1_000_000, 60_000_000_000],
      ["claude-mythos-5", "anthropic-direct", 1_000_000, 1_000_000, 60_000_000_000],
      ["claude-opus-4.1", "anthropic-direct", 1_000_000, 1_000_000, 90_000_000_000]
    ];

    for (const [model, billingContext, inputTokens, outputTokens, expectedNanoUsd] of cases) {
      const run = pipeline.project([
        atom({
          model,
          billingContext,
          inputTokens,
          outputTokens,
          startedAt: "2026-07-01T00:00:00.000Z"
        })
      ])[0];

      expect(run).toMatchObject({
        costCoverage: "complete",
        estimatedNanoUsd: expectedNanoUsd,
        usageValueNanoUsd: expectedNanoUsd
      });
    }
  });

  it("prices Cursor Composer catalog rows in live run projection", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({
        provider: "cursor",
        runtime: "cursor",
        model: "composer-2.5-fast",
        billingContext: "cursor",
        inputTokens: 68_310,
        cacheReadInputTokens: 67_046,
        outputTokens: 537,
        startedAt: "2026-07-03T00:00:00.000Z"
      })
    ])[0];

    expect(run).toMatchObject({
      provider: "cursor",
      model: "composer-2.5-fast",
      modelProvider: "cursor",
      modelProviderBasis: "model_name_rule",
      billingContext: "cursor",
      costCoverage: "complete",
      costEstimateBasis: "catalog_estimate",
      estimatedNanoUsd: 45_370_000,
      usageValueNanoUsd: 45_370_000,
      pricingVersion: "cursor-pricing-2026-07-03",
      warnings: []
    });
  });

  it("switches Claude Sonnet 5 direct pricing at the announced standard-pricing boundary", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({
        model: "claude-sonnet-5",
        billingContext: "anthropic-direct",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        startedAt: "2026-09-01T00:00:00.000Z"
      })
    ])[0];

    expect(run).toMatchObject({
      costCoverage: "complete",
      estimatedNanoUsd: 18_000_000_000,
      usageValueNanoUsd: 18_000_000_000,
      pricingVersion: "anthropic-pricing-2026-07-01-first-party"
    });
  });

  it("groups provider requests by prompt while preserving their shared session", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const runs = pipeline.project([
      atom({
        atomId: "claude-prompt-start",
        correlationId: "qry_prompt_1",
        queryId: "qry_prompt_1",
        sessionId: "ses_claude_1",
        requestId: "req_prompt_start",
        provider: "claude-code",
        runtime: "claude-code",
        kind: "lifecycle",
        lifecycle: "query_started",
        authority: "request",
        completionMode: "inactivity",
        inputTokens: undefined,
        outputTokens: undefined,
        model: undefined,
        startedAt: "2026-06-07T23:59:59.000Z",
        endedAt: "2026-06-07T23:59:59.000Z"
      }),
      atom({
        atomId: "claude-request-1",
        correlationId: "qry_prompt_1",
        queryId: "qry_prompt_1",
        sessionId: "ses_claude_1",
        requestId: "req_claude_1",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        completionMode: "inactivity",
        providerReportedNanoUsd: 1_000_000,
        model: "claude-sonnet-4.6",
        endedAt: "2026-06-08T00:00:01.000Z"
      }),
      atom({
        atomId: "claude-request-2",
        correlationId: "qry_prompt_1",
        queryId: "qry_prompt_1",
        sessionId: "ses_claude_1",
        requestId: "req_claude_2",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        completionMode: "inactivity",
        providerReportedNanoUsd: 2_000_000,
        model: "claude-sonnet-4.6",
        endedAt: "2026-06-08T00:00:02.000Z"
      })
    ], new Date("2026-06-08T00:03:00.000Z"), [occurrence({
      queryId: "qry_prompt_1",
      sessionId: "ses_claude_1",
      provider: "claude-code",
      runtime: "claude-code"
    })]);
    expect(runs).toEqual([
      expect.objectContaining({
        queryId: "qry_prompt_1",
        sessionId: "ses_claude_1",
        inputTokens: 20,
        outputTokens: 10,
        estimatedNanoUsd: 3_000_000,
        costEstimateBasis: "provider_reported_estimate",
        startedAt: "2026-06-07T23:59:59.000Z",
        endedAt: undefined
      })
    ]);
  });

  it("uses complete Claude provider-reported estimates as usage value when direct catalog value is unavailable", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({
        atomId: "claude-haiku-provider-estimate",
        correlationId: "qry_claude_provider_reported",
        queryId: "qry_claude_provider_reported",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 4_191,
        outputTokens: 742,
        cacheReadInputTokens: 125_748,
        cacheCreationInputTokens: 11_991,
        providerReportedNanoUsd: 45_000_000
      }),
      atom({
        atomId: "claude-sonnet-provider-estimate",
        correlationId: "qry_claude_provider_reported",
        queryId: "qry_claude_provider_reported",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        model: "claude-sonnet-5",
        inputTokens: 0,
        outputTokens: 0,
        providerReportedNanoUsd: 85_945_400
      })
    ], new Date("2026-06-08T00:01:00.000Z"), [occurrence({
      queryId: "qry_claude_provider_reported",
      provider: "claude-code",
      runtime: "claude-code"
    })])[0];

    expect(run).toMatchObject({
      provider: "claude-code",
      costEstimateBasis: "provider_reported_estimate",
      costCoverage: "complete",
      estimatedNanoUsd: 130_945_400,
      usageValueNanoUsd: 130_945_400
    });
  });

  it("prefers Claude traces for overlapping requests while retaining log-only cost evidence", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const runs = pipeline.project([
      atom({
        atomId: "claude-log-overlap",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        signal: "logs",
        sourceId: "otlp_claude_code_logs",
        profileVersion: "claude-code-otel-logs-v1",
        correlationId: "qry_claude_reasoning",
        queryId: "qry_claude_reasoning",
        sessionId: "ses_claude_reasoning",
        requestId: "req_claude_overlap",
        providerReportedNanoUsd: 1_000_000,
        inputTokens: 80,
        outputTokens: 10,
        reasoningOutputTokens: 0
      }),
      atom({
        atomId: "claude-trace-overlap",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        signal: "traces",
        sourceId: "otlp_claude_code_traces",
        profileVersion: "claude-code-enhanced-traces-beta-v1",
        correlationId: "qry_claude_reasoning",
        queryId: "qry_claude_reasoning",
        sessionId: "ses_claude_reasoning",
        requestId: "req_claude_overlap",
        inputTokens: 100,
        outputTokens: 20,
        reasoningOutputTokens: 45
      }),
      atom({
        atomId: "claude-log-fallback",
        provider: "claude-code",
        runtime: "claude-code",
        authority: "request",
        signal: "logs",
        sourceId: "otlp_claude_code_logs",
        profileVersion: "claude-code-otel-logs-v1",
        correlationId: "qry_claude_reasoning",
        queryId: "qry_claude_reasoning",
        sessionId: "ses_claude_reasoning",
        requestId: "req_claude_fallback",
        providerReportedNanoUsd: 2_000_000,
        inputTokens: 40,
        outputTokens: 8
      })
    ], new Date("2026-06-08T00:01:00.000Z"), [occurrence({
      queryId: "qry_claude_reasoning",
      sessionId: "ses_claude_reasoning",
      provider: "claude-code",
      runtime: "claude-code"
    })]);
    expect(runs).toEqual([expect.objectContaining({
      queryId: "qry_claude_reasoning",
      authority: "request",
      inputTokens: 140,
      outputTokens: 28,
      reasoningOutputTokens: 45,
      totalTokens: 168,
      estimatedNanoUsd: 3_000_000,
      costEstimateBasis: "provider_reported_estimate"
    })]);
  });

  it("marks preferred Claude trace usage partial when one request lacks matching reported cost", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const queryId = "qry_claude_partial_trace_cost";
    const common = {
      provider: "claude-code" as const,
      runtime: "claude-code" as const,
      authority: "request" as const,
      correlationId: queryId,
      queryId,
      sessionId: "ses_claude_partial_trace_cost",
      model: "claude-sonnet-5"
    };
    const run = pipeline.project([
      atom({
        ...common,
        atomId: "claude-partial-cost-matched-log",
        requestId: "req_claude_partial_cost_matched",
        signal: "logs",
        sourceId: "otlp_claude_code_logs",
        providerReportedNanoUsd: 1_000_000,
        inputTokens: 80,
        outputTokens: 10
      }),
      atom({
        ...common,
        atomId: "claude-partial-cost-matched-trace",
        requestId: "req_claude_partial_cost_matched",
        signal: "traces",
        sourceId: "otlp_claude_code_traces",
        inputTokens: 100,
        outputTokens: 20
      }),
      atom({
        ...common,
        atomId: "claude-partial-cost-trace-only",
        requestId: "req_claude_partial_cost_trace_only",
        signal: "traces",
        sourceId: "otlp_claude_code_traces",
        inputTokens: 30,
        outputTokens: 5
      })
    ], new Date("2026-06-08T00:01:00.000Z"), [occurrence({
      queryId,
      sessionId: common.sessionId,
      provider: "claude-code",
      runtime: "claude-code"
    })])[0];

    expect(run).toMatchObject({
      authority: "request",
      inputTokens: 130,
      outputTokens: 25,
      totalTokens: 155,
      estimatedNanoUsd: 1_000_000,
      costEstimateBasis: "provider_reported_estimate",
      costCoverage: "partial"
    });
    expect(run.usageValueNanoUsd).toBeUndefined();
  });

  it("prefers Codex trace usage over overlapping Codex log snapshots", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const runs = pipeline.project([
      atom({
        atomId: "codex-log-snapshot",
        signal: "logs",
        sourceId: "otlp_codex_logs",
        profileVersion: "codex-otel-logs-v1",
        correlationId: "qry_codex_reasoning",
        queryId: "qry_codex_reasoning",
        sessionId: "ses_codex_reasoning",
        requestId: "req_codex_log",
        inputTokens: 100,
        outputTokens: 25,
        reasoningOutputTokens: 60
      }),
      atom({
        atomId: "codex-trace-turn",
        signal: "traces",
        sourceId: "otlp_codex_traces",
        profileVersion: "codex-otel-traces-v1",
        correlationId: "qry_codex_reasoning",
        queryId: "qry_codex_reasoning",
        sessionId: "ses_codex_reasoning",
        requestId: "req_codex_trace",
        inputTokens: 120,
        outputTokens: 30,
        reasoningOutputTokens: 80
      })
    ]);
    expect(runs).toEqual([expect.objectContaining({
      queryId: "qry_codex_reasoning",
      authority: "turn",
      inputTokens: 120,
      outputTokens: 30,
      reasoningOutputTokens: 80,
      totalTokens: 150
    })]);
  });

  it("keeps distinct Codex context revisions while billing the latest revised atom", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const runs = pipeline.project([
      atom({
        atomId: "codex-revised-turn",
        signal: "traces",
        sourceId: "otlp_codex_traces",
        profileVersion: "codex-otel-traces-v1",
        correlationId: "qry_codex_revised",
        queryId: "qry_codex_revised",
        sessionId: "ses_codex_revised",
        requestId: "req_codex_revised",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        endedAt: "2026-06-08T00:00:01.000Z"
      }),
      atom({
        atomId: "codex-revised-turn",
        signal: "traces",
        sourceId: "otlp_codex_traces",
        profileVersion: "codex-otel-traces-v1",
        correlationId: "qry_codex_revised",
        queryId: "qry_codex_revised",
        sessionId: "ses_codex_revised",
        requestId: "req_codex_revised",
        inputTokens: 150,
        outputTokens: 25,
        cacheReadInputTokens: 50,
        endedAt: "2026-06-08T00:00:02.000Z"
      }),
      atom({
        atomId: "codex-revised-turn",
        signal: "traces",
        sourceId: "otlp_codex_traces",
        profileVersion: "codex-otel-traces-v1",
        correlationId: "qry_codex_revised",
        queryId: "qry_codex_revised",
        sessionId: "ses_codex_revised",
        requestId: "req_codex_revised",
        inputTokens: 150,
        outputTokens: 25,
        cacheReadInputTokens: 50,
        endedAt: "2026-06-08T00:00:02.000Z"
      })
    ]);
    expect(runs).toEqual([expect.objectContaining({
      queryId: "qry_codex_revised",
      inputTokens: 150,
      outputTokens: 25,
      cacheReadInputTokens: 50,
      totalTokens: 175,
      context: expect.objectContaining({
        accumulatedInputTokens: 200,
        initialInputContextTokens: 100,
        latestInputContextTokens: 200,
        peakInputContextTokens: 200,
        cacheReadInputTokens: 50,
        observedLlmRequestCount: 2,
        contextGrowthInputTokens: 100,
        contextGrowthRatio: 2
      })
    })]);
  });

  it("keeps submission-authorized Claude stable-log prompts open without explicit completion", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const usage = atom({
      provider: "claude-code",
      runtime: "claude-code",
      completionMode: "inactivity",
      endedAt: "2026-06-08T00:00:30.000Z"
    });
    const lifecycle = [occurrence({
      queryId: "cor_default",
      provider: "claude-code",
      runtime: "claude-code"
    })];
    expect(pipeline.project([usage], new Date("2026-06-08T00:00:59.999Z"), lifecycle)[0].endedAt).toBeUndefined();
    expect(pipeline.project([usage], new Date("2026-06-08T00:01:00.000Z"), lifecycle)[0].endedAt)
      .toBeUndefined();
  });

  it("joins prompt and session data from the query-occurrence ledger without changing usage grouping", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const usage = atom({
      correlationId: "qry_joined",
      queryId: "qry_joined",
      sessionId: "ses_usage_fallback"
    });
    const occurrence: QueryOccurrenceV1 = {
      schemaVersion: 1,
      queryId: "qry_joined",
      sessionId: "ses_authoritative",
      provider: "codex",
      runtime: "codex",
      startedAt: "2026-06-08T00:00:00.000Z",
      promptState: "captured",
      promptText: "Associate this prompt with its run",
      evidence: "provider_user_prompt_event"
    };
    expect(pipeline.project([usage], new Date(), [occurrence])[0]).toMatchObject({
      queryId: "qry_joined",
      sessionId: "ses_authoritative",
      promptState: "captured",
      promptText: "Associate this prompt with its run",
      totalTokens: 15
    });
  });

  it("conserves run totals while attributing only trace-proven tool descendants", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const run = pipeline.project([
      atom({
        atomId: "root",
        provider: "github-copilot",
        runtime: "github-copilot",
        authority: "run",
        inputTokens: 100,
        outputTokens: 20
      }),
      atom({
        atomId: "child",
        provider: "github-copilot",
        runtime: "github-copilot",
        authority: "model",
        owningActivityId: "act_subagent",
        inputTokens: 30,
        outputTokens: 5
      })
    ], new Date(), [], [activity({
      activityId: "act_subagent",
      provider: "github-copilot",
      runtime: "github-copilot",
      kind: "subagent",
      name: "runSubagent"
    })])[0];
    expect(run).toMatchObject({
      totalTokens: 120,
      toolCallCount: 1,
      breakdown: [
        expect.objectContaining({
          kind: "subagent",
          name: "runSubagent",
          totalTokens: 35,
          attributionBasis: "trace_descendant",
          coverage: "complete"
        }),
        expect.objectContaining({
          kind: "unallocated",
          inputTokens: 70,
          outputTokens: 15,
          totalTokens: 85,
          coverage: "partial"
        })
      ]
    });
    expect(run.breakdown?.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0)).toBe(run.totalTokens);
  });
});

function atom(overrides: Partial<SafeUsageAtomV1>): SafeUsageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: "atom_default",
    correlationId: "cor_default",
    provider: "codex",
    runtime: "codex",
    authority: "turn",
    model: "gpt-5.4",
    inputTokens: 10,
    outputTokens: 5,
    startedAt: "2026-06-08T00:00:00.000Z",
    ...overrides
  };
}

function activity(overrides: Partial<SafeActivityAtomV1>): SafeActivityAtomV1 {
  return {
    schemaVersion: 1,
    activityId: "act_default",
    queryId: "cor_default",
    provider: "codex",
    runtime: "codex",
    kind: "tool",
    name: "shell",
    outcome: "success",
    startedAt: "2026-06-08T00:00:00.000Z",
    ...overrides
  };
}

function occurrence(overrides: Partial<QueryOccurrenceV1>): QueryOccurrenceV1 {
  return {
    schemaVersion: 1,
    queryId: "qry_default",
    sessionId: "ses_default",
    provider: "codex",
    runtime: "codex",
    startedAt: "2026-06-08T00:00:00.000Z",
    promptState: "disabled",
    evidence: "submission_hook",
    ...overrides
  };
}
