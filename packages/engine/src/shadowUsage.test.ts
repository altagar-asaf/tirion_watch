import { describe, expect, it } from "vitest";
import type { QueryOccurrenceV1, SafeActivityAtomV1, SafeUsageAtomV1 } from "@tirion/agent-contract";
import { DefaultProductionUsagePipeline, DefaultShadowUsagePipeline } from "./shadowUsage";

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
    ], new Date("2026-06-08T00:03:00.000Z"));
    expect(runs).toEqual([
      expect.objectContaining({
        queryId: "qry_prompt_1",
        sessionId: "ses_claude_1",
        inputTokens: 20,
        outputTokens: 10,
        estimatedNanoUsd: 3_000_000,
        costEstimateBasis: "provider_reported_estimate",
        startedAt: "2026-06-07T23:59:59.000Z",
        endedAt: "2026-06-08T00:00:02.000Z"
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
    ])[0];

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
    ]);
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

  it("keeps Claude stable-log prompts current until the inactivity boundary", () => {
    const pipeline = new DefaultProductionUsagePipeline();
    const usage = atom({
      provider: "claude-code",
      runtime: "claude-code",
      completionMode: "inactivity",
      endedAt: "2026-06-08T00:00:30.000Z"
    });
    expect(pipeline.project([usage], new Date("2026-06-08T00:00:59.999Z"))[0].endedAt).toBeUndefined();
    expect(pipeline.project([usage], new Date("2026-06-08T00:01:00.000Z"))[0].endedAt)
      .toBe("2026-06-08T00:00:30.000Z");
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
