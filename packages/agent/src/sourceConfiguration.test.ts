import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify, type TomlTable } from "smol-toml";
import { SourceConfigurationService } from "./sourceConfiguration";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("source configuration", () => {
  it("configures Claude Code logs and traces with privacy-closed content capture defaults", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      restartRequired: true,
      tracesEnabled: true,
      toolDetailsSupported: true,
      toolDetailsEnabled: true,
      toolContentSupported: true,
      toolContentEnabled: false,
      responseContentSupported: true,
      responseContentEnabled: false
    });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      env: Record<string, string>;
      hooks: Record<string, unknown>;
    };
    expect(settings.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer local-token",
      OTEL_BSP_SCHEDULE_DELAY: "250",
      OTEL_TRACES_EXPORT_INTERVAL: "250",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "0",
      OTEL_LOG_ASSISTANT_RESPONSES: "0",
      OTEL_LOG_RAW_API_BODIES: "0"
    });
    expect(settings.hooks).toMatchObject({
      UserPromptSubmit: [expect.any(Object)],
      Stop: [expect.any(Object)],
      StopFailure: [expect.any(Object)],
      SessionEnd: [expect.any(Object)],
      SubagentStart: [expect.any(Object)],
      SubagentStop: [expect.any(Object)],
      PostToolUse: [expect.objectContaining({
        matcher: "*",
        hooks: [expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:4318/v1/provider-hooks/claude-code"
        })]
      })],
      PostToolUseFailure: [expect.objectContaining({
        matcher: "*",
        hooks: [expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:4318/v1/provider-hooks/claude-code"
        })]
      })]
    });
    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "configured",
      toolDetailsEnabled: true,
      toolContentEnabled: false,
      responseContentEnabled: false,
      reasonCodes: []
    });
  });

  it("manages Claude native trace export cadence reversibly on a fresh configuration", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);

    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      profileVersion: "claude-code-otel-logs-traces-v2"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: {
        OTEL_BSP_SCHEDULE_DELAY: "250",
        OTEL_TRACES_EXPORT_INTERVAL: "250"
      },
      hooks: {
        SessionEnd: [claudeHookGroup("SessionEnd")]
      }
    });
    expect(JSON.parse(readFileSync(paths.restoreStatePath, "utf8"))).toMatchObject({
      "claude-code": {
        claudeProfileVersion: 5,
        previousTraceBatchDelay: "absent",
        previousTraceExportInterval: "absent"
      }
    });

    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(existsSync(paths.claudeSettingsPath)).toBe(false);
    expect(existsSync(paths.restoreStatePath)).toBe(false);
  });

  it("fails closed when a v5 Claude restore ledger lacks a managed batch-delay baseline", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const restoreState = JSON.parse(readFileSync(paths.restoreStatePath, "utf8")) as {
      "claude-code": Record<string, unknown>;
    };
    delete restoreState["claude-code"].previousTraceBatchDelay;
    writeFileSync(paths.restoreStatePath, JSON.stringify(restoreState));

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "unavailable",
      ownershipState: "unavailable",
      reasonCodes: ["source_configuration_unavailable"]
    });
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "unavailable",
      reasonCodes: ["source_configuration_unavailable"]
    });
  });

  it("fails closed when an inferred v4 Claude restore ledger lacks a managed batch-delay baseline", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const restoreState = JSON.parse(readFileSync(paths.restoreStatePath, "utf8")) as {
      "claude-code": Record<string, unknown>;
    };
    delete restoreState["claude-code"].claudeProfileVersion;
    delete restoreState["claude-code"].previousTraceBatchDelay;
    writeFileSync(paths.restoreStatePath, JSON.stringify(restoreState));

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "unavailable",
      ownershipState: "unavailable",
      reasonCodes: ["source_configuration_unavailable"]
    });
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "unavailable",
      reasonCodes: ["source_configuration_unavailable"]
    });
  });

  it("fails closed when a pre-v4 Claude restore ledger carries a native interval baseline", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const restoreState = JSON.parse(readFileSync(paths.restoreStatePath, "utf8")) as {
      "claude-code": Record<string, unknown>;
    };
    restoreState["claude-code"].claudeProfileVersion = 3;
    writeFileSync(paths.restoreStatePath, JSON.stringify(restoreState));

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "unavailable",
      ownershipState: "unavailable",
      reasonCodes: ["source_configuration_unavailable"]
    });
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "unavailable",
      reasonCodes: ["source_configuration_unavailable"]
    });
  });

  it("treats a user-owned Claude native trace cadence as configurable rather than a foreign exporter", () => {
    const paths = testPaths();
    const original = { theme: "dark", env: { OTEL_TRACES_EXPORT_INTERVAL: "5000" } };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    const service = new SourceConfigurationService(paths);

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "not_configured",
      ownershipState: "unmanaged",
      reasonCodes: expect.arrayContaining([
        "logs_missing",
        "traces_missing",
        "trace_export_interval_unoptimized"
      ])
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: { OTEL_TRACES_EXPORT_INTERVAL: "250" }
    });
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual(original);
  });

  it("preserves an existing valid Claude trace batch delay across configure and restore", () => {
    const paths = testPaths();
    const original = { theme: "dark", env: { OTEL_BSP_SCHEDULE_DELAY: "5000" } };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    const service = new SourceConfigurationService(paths);

    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: {
        OTEL_BSP_SCHEDULE_DELAY: "250",
        OTEL_TRACES_EXPORT_INTERVAL: "250"
      }
    });
    expect(JSON.parse(readFileSync(paths.restoreStatePath, "utf8"))).toMatchObject({
      "claude-code": {
        presentKeys: expect.arrayContaining(["OTEL_BSP_SCHEDULE_DELAY"]),
        previousTraceBatchDelay: "5000",
        previousTraceExportInterval: "absent"
      }
    });

    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual(original);
  });

  it("preserves an existing Claude-native trace export interval across configure and restore", () => {
    const paths = testPaths();
    const original = { theme: "dark", env: { OTEL_TRACES_EXPORT_INTERVAL: "5000" } };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    const service = new SourceConfigurationService(paths);

    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: { OTEL_TRACES_EXPORT_INTERVAL: "250" }
    });
    expect(JSON.parse(readFileSync(paths.restoreStatePath, "utf8"))).toMatchObject({
      "claude-code": {
        presentKeys: expect.arrayContaining(["OTEL_TRACES_EXPORT_INTERVAL"]),
        previousTraceExportInterval: "5000"
      }
    });

    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual(original);
  });

  it("requires the Claude Code enhanced telemetry gate before reporting traces ready", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      tracesEnabled: true
    });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      env: Record<string, string>;
    };
    delete settings.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA;
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));
    rmSync(paths.restoreStatePath, { force: true });

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "partial",
      ownershipState: "adoptable_local",
      logsEnabled: true,
      tracesEnabled: false,
      reasonCodes: expect.arrayContaining([
        "local_tirion_exporter_unclaimed",
        "traces_missing",
        "enhanced_traces_disabled"
      ])
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      tracesEnabled: true
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1" }
    });
  });

  it("recognizes Claude's enhanced telemetry alias without accepting canonical managed drift", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      env: Record<string, string>;
    };
    delete settings.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA;
    settings.env.ENABLE_ENHANCED_TELEMETRY_BETA = "1";
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "conflict",
      ownershipState: "managed_drifted",
      tracesEnabled: true,
      reasonCodes: ["managed_configuration_drifted"]
    });
  });

  it("classifies changed or removed managed Claude trace batch delay as drift and repairs it", () => {
    for (const replacement of ["5000", undefined]) {
      const paths = testPaths();
      const service = new SourceConfigurationService(paths);
      expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        status: "configured"
      });
      const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
        env: Record<string, string>;
      };
      if (replacement == null) {
        delete settings.env.OTEL_BSP_SCHEDULE_DELAY;
      } else {
        settings.env.OTEL_BSP_SCHEDULE_DELAY = replacement;
      }
      writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));

      expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        configurationState: "conflict",
        ownershipState: "managed_drifted",
        reasonCodes: ["trace_batch_delay_unoptimized"]
      });
      expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        status: "conflict",
        reasonCodes: ["restore_conflict"]
      });
      expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        status: "configured"
      });
      expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
        env: { OTEL_BSP_SCHEDULE_DELAY: "250" }
      });
    }
  });

  it("classifies changed or removed Claude-native trace export cadence as drift and repairs it", () => {
    for (const replacement of ["5000", undefined]) {
      const paths = testPaths();
      const service = new SourceConfigurationService(paths);
      expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        status: "configured"
      });
      const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
        env: Record<string, string>;
      };
      if (replacement == null) {
        delete settings.env.OTEL_TRACES_EXPORT_INTERVAL;
      } else {
        settings.env.OTEL_TRACES_EXPORT_INTERVAL = replacement;
      }
      writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));

      expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        configurationState: "conflict",
        ownershipState: "managed_drifted",
        reasonCodes: ["trace_export_interval_unoptimized"]
      });
      expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        status: "conflict",
        reasonCodes: ["restore_conflict"]
      });
      expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        status: "configured"
      });
      expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
        env: { OTEL_TRACES_EXPORT_INTERVAL: "250" }
      });
    }
  });

  it("fails closed for an invalid managed Claude trace batch delay", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      env: Record<string, string>;
    };
    settings.env.OTEL_BSP_SCHEDULE_DELAY = "not-a-number";
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));
    const beforeSettings = readFileSync(paths.claudeSettingsPath, "utf8");
    const beforeRestoreState = readFileSync(paths.restoreStatePath, "utf8");

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "conflict",
      ownershipState: "managed_drifted",
      reasonCodes: ["invalid_existing_configuration"]
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "conflict",
      reasonCodes: ["invalid_existing_configuration"]
    });
    expect(readFileSync(paths.claudeSettingsPath, "utf8")).toBe(beforeSettings);
    expect(readFileSync(paths.restoreStatePath, "utf8")).toBe(beforeRestoreState);
  });

  it("fails closed for an invalid Claude-native trace export interval", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      env: Record<string, string>;
    };
    settings.env.OTEL_TRACES_EXPORT_INTERVAL = "not-a-number";
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));
    const beforeSettings = readFileSync(paths.claudeSettingsPath, "utf8");
    const beforeRestoreState = readFileSync(paths.restoreStatePath, "utf8");

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "conflict",
      ownershipState: "managed_drifted",
      reasonCodes: ["invalid_existing_configuration"]
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "conflict",
      reasonCodes: ["invalid_existing_configuration"]
    });
    expect(readFileSync(paths.claudeSettingsPath, "utf8")).toBe(beforeSettings);
    expect(readFileSync(paths.restoreStatePath, "utf8")).toBe(beforeRestoreState);
  });

  it("requires an auth-matching StopFailure hook for managed Claude lifecycle readiness", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      hooks: Record<string, { hooks: { headers: Record<string, string> }[] }[]>;
    };
    settings.hooks.StopFailure[0]!.hooks[0]!.headers.Authorization = "Bearer changed-token";
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "conflict",
      ownershipState: "managed_drifted",
      reasonCodes: ["managed_configuration_drifted"]
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "configured",
      reasonCodes: []
    });
  });

  it("repairs a missing diagnostic-only Claude SessionEnd hook without blocking measurement readiness", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    delete settings.hooks.SessionEnd;
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "configured",
      ownershipState: "managed_current",
      reasonCodes: []
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      hooks: { SessionEnd: [claudeHookGroup("SessionEnd")] }
    });
  });

  it("does not claim Claude hooks are active when local hook policy disables HTTP hooks", () => {
    for (const policy of [{ disableAllHooks: true }, { allowedHttpHookUrls: [] }]) {
      const paths = testPaths();
      const service = new SourceConfigurationService(paths);
      expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        status: "configured"
      });
      const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as Record<string, unknown>;
      Object.assign(settings, policy);
      writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));
      expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        configurationState: "conflict",
        ownershipState: "managed_drifted",
        reasonCodes: ["hooks_disabled"]
      });
      rmSync(paths.restoreStatePath, { force: true });
      const before = readFileSync(paths.claudeSettingsPath, "utf8");

      expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        configurationState: "partial",
        ownershipState: "adoptable_local",
        reasonCodes: expect.arrayContaining(["hooks_disabled"])
      });
      expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        status: "conflict",
        reasonCodes: ["hooks_disabled"]
      });
      expect(readFileSync(paths.claudeSettingsPath, "utf8")).toBe(before);
    }
  });

  it("requires exact Claude hook matcher, cardinality, and headers", () => {
    const mutations: ((group: {
      matcher: string;
      hooks: { headers: Record<string, string> }[];
    }) => void)[] = [
      (group) => { group.matcher = "StopFailure"; },
      (group) => { group.hooks.push({ headers: {} }); },
      (group) => { group.hooks[0]!.headers["X-Extra"] = "not-managed"; }
    ];
    for (const mutate of mutations) {
      const paths = testPaths();
      const service = new SourceConfigurationService(paths);
      expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        status: "configured"
      });
      const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
        hooks: Record<string, { matcher: string; hooks: { headers: Record<string, string> }[] }[]>;
      };
      mutate(settings.hooks.StopFailure[0]!);
      writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));

      expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
        configurationState: "conflict",
        ownershipState: "managed_drifted",
        reasonCodes: ["managed_configuration_drifted"]
      });
    }
  });

  it("restores with one uniform stale Claude hook token but rejects a divergent or missing hook token", () => {
    const uniformPaths = testPaths();
    const uniformService = new SourceConfigurationService(uniformPaths);
    expect(uniformService.configure("claude-code", "http://127.0.0.1:4318", "old-token")).toMatchObject({
      status: "configured"
    });
    expect(uniformService.restore("claude-code", "http://127.0.0.1:4318", "new-token")).toMatchObject({
      status: "restored"
    });

    for (const replacement of ["Bearer divergent-token", undefined]) {
      const paths = testPaths();
      const service = new SourceConfigurationService(paths);
      expect(service.configure("claude-code", "http://127.0.0.1:4318", "old-token")).toMatchObject({
        status: "configured"
      });
      const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
        hooks: Record<string, { hooks: { headers: Record<string, string> }[] }[]>;
      };
      if (replacement == null) {
        delete settings.hooks.StopFailure[0]!.hooks[0]!.headers.Authorization;
      } else {
        settings.hooks.StopFailure[0]!.hooks[0]!.headers.Authorization = replacement;
      }
      writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));

      expect(service.restore("claude-code", "http://127.0.0.1:4318", "new-token")).toMatchObject({
        status: "conflict",
        reasonCodes: ["restore_conflict"]
      });
    }
  });

  it("privacy-closes existing Claude content gates and restores them with foreign hooks exactly", () => {
    const paths = testPaths();
    const original = {
      theme: "dark",
      env: {
        FOREIGN_ENVIRONMENT_SETTING: "preserve-me",
        CLAUDE_CODE_ENABLE_TELEMETRY: "0",
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "0",
        OTEL_LOGS_EXPORTER: "console",
        OTEL_TRACES_EXPORTER: "console",
        OTEL_LOG_USER_PROMPTS: "1",
        OTEL_LOG_TOOL_DETAILS: "0",
        OTEL_LOG_TOOL_CONTENT: "1",
        OTEL_LOG_ASSISTANT_RESPONSES: "1",
        OTEL_LOG_RAW_API_BODIES: "1"
      },
      hooks: {
        StopFailure: [{
          matcher: "quota_exceeded",
          hooks: [{ type: "command", command: "/usr/local/bin/foreign-stop-failure", timeout: 5 }]
        }]
      }
    };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    const service = new SourceConfigurationService(paths);

    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      promptCaptureEnabled: false,
      toolDetailsEnabled: true,
      toolContentEnabled: false,
      responseContentEnabled: false
    });
    const configured = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      env: Record<string, string>;
      hooks: Record<string, unknown[]>;
    };
    expect(configured.env).toMatchObject({
      FOREIGN_ENVIRONMENT_SETTING: "preserve-me",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "0",
      OTEL_LOG_ASSISTANT_RESPONSES: "0",
      OTEL_LOG_RAW_API_BODIES: "0"
    });
    expect(configured.hooks.StopFailure).toEqual([
      original.hooks.StopFailure[0],
      expect.objectContaining({
        matcher: "*",
        hooks: [expect.objectContaining({
          type: "http",
          url: "http://127.0.0.1:4318/v1/provider-hooks/claude-code"
        })]
      })
    ]);
    delete configured.env.OTEL_LOG_ASSISTANT_RESPONSES;
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(configured));
    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "conflict",
      ownershipState: "managed_drifted",
      reasonCodes: ["managed_configuration_drifted"]
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      responseContentEnabled: false
    });
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual(original);
  });

  it("accounts for Claude assistant-response fallback and restores an absent explicit gate", () => {
    const paths = testPaths();
    const original = {
      env: {
        OTEL_LOGS_EXPORTER: "console",
        OTEL_TRACES_EXPORTER: "console",
        OTEL_LOG_USER_PROMPTS: "1"
      }
    };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    const service = new SourceConfigurationService(paths);

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      promptCaptureEnabled: true,
      responseContentEnabled: true
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      promptCaptureEnabled: false,
      responseContentEnabled: false
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: {
        OTEL_LOG_USER_PROMPTS: "0",
        OTEL_LOG_ASSISTANT_RESPONSES: "0",
        OTEL_LOG_RAW_API_BODIES: "0"
      }
    });
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual(original);
  });

  it("upgrades an existing Claude Code logs-only install to include traces and richer tool capture", () => {
    const paths = testPaths();
    writeFileSync(paths.claudeSettingsPath, JSON.stringify({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer local-token",
        OTEL_LOG_USER_PROMPTS: "0",
        OTEL_LOG_TOOL_DETAILS: "0",
        OTEL_LOG_TOOL_CONTENT: "0",
        OTEL_LOG_RAW_API_BODIES: "0"
      }
    }));
    const service = new SourceConfigurationService(paths);
    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "partial",
      promptCaptureEnabled: false,
      tracesEnabled: false,
      toolDetailsSupported: true,
      toolDetailsEnabled: false,
      toolContentSupported: true,
      toolContentEnabled: false,
      responseContentSupported: true,
      responseContentEnabled: false,
      reasonCodes: expect.arrayContaining([
        "traces_missing",
        "tool_details_disabled"
      ])
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token", {
      captureToolDetails: true,
      captureToolContent: true,
      captureResponseContent: true
    })).toMatchObject({
      status: "configured",
      promptCaptureEnabled: false,
      tracesEnabled: true,
      toolDetailsSupported: true,
      toolDetailsEnabled: true,
      toolContentSupported: true,
      toolContentEnabled: true,
      responseContentSupported: true,
      responseContentEnabled: true
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: {
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
        OTEL_LOG_USER_PROMPTS: "0",
        OTEL_LOG_TOOL_DETAILS: "1",
        OTEL_LOG_TOOL_CONTENT: "1",
        OTEL_LOG_ASSISTANT_RESPONSES: "1",
        OTEL_LOG_RAW_API_BODIES: "1"
      },
      hooks: {
        UserPromptSubmit: [expect.any(Object)],
        Stop: [expect.any(Object)],
        StopFailure: [expect.any(Object)],
        SubagentStart: [expect.any(Object)],
        SubagentStop: [expect.any(Object)],
        PostToolUse: [expect.any(Object)],
        PostToolUseFailure: [expect.any(Object)]
      }
    });
  });

  it("refuses to overwrite a Claude Code logs exporter conflict", () => {
    const paths = testPaths();
    writeFileSync(paths.claudeSettingsPath, JSON.stringify({
      env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.example/v1/logs" }
    }));
    const before = readFileSync(paths.claudeSettingsPath, "utf8");
    expect(new SourceConfigurationService(paths).configure("claude-code", "http://127.0.0.1:4318")).toMatchObject({
      status: "conflict",
      reasonCodes: ["existing_exporter_conflict"]
    });
    expect(readFileSync(paths.claudeSettingsPath, "utf8")).toBe(before);
  });

  it("configures Codex privacy-projected JSON logs and authoritative traces with prompt capture disabled by default", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      toolDetailsSupported: true,
      toolDetailsEnabled: true,
      toolContentSupported: true,
      toolContentEnabled: true,
      responseContentSupported: false,
    });
    expect(parse(readFileSync(paths.codexConfigPath, "utf8"))).toMatchObject({
      features: {
        hooks: true
      },
      otel: {
        log_user_prompt: false,
        exporter: {
          "otlp-http": {
            endpoint: "http://127.0.0.1:4318/v1/logs",
            protocol: "json",
            headers: { Authorization: "Bearer local-token" }
          }
        },
        trace_exporter: {
          "otlp-http": {
            endpoint: "http://127.0.0.1:4318/v1/traces",
            protocol: "json",
            headers: { Authorization: "Bearer local-token" }
          }
        },
        metrics_exporter: {
          "otlp-http": {
            endpoint: "http://127.0.0.1:4318/v1/metrics",
            protocol: "json",
            headers: { Authorization: "Bearer local-token" }
          }
        }
      },
      hooks: {
        UserPromptSubmit: [expect.any(Object)],
        Stop: [expect.any(Object)],
        SubagentStart: [expect.any(Object)],
        SubagentStop: [expect.any(Object)],
        PostToolUse: [expect.objectContaining({
          matcher: ".*",
          hooks: [expect.objectContaining({
            type: "command",
            command: expect.stringContaining("http://127.0.0.1:4318/v1/provider-hooks/codex")
          })]
        })]
      }
    });
    expect(readFileSync(paths.codexHookRelayPath, "utf8")).toContain("configuredEventName");
    expect(readFileSync(paths.codexConfigPath, "utf8")).toContain("'UserPromptSubmit'");
    const before = readFileSync(paths.codexConfigPath, "utf8");
    expect(service.configure("codex", "http://127.0.0.1:9999")).toMatchObject({
      status: "conflict",
      reasonCodes: ["existing_exporter_conflict"]
    });
    expect(readFileSync(paths.codexConfigPath, "utf8")).toBe(before);
  });

  it("preserves unchanged Codex hook ordering and persisted trust state byte for byte", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const config = parse(readFileSync(paths.codexConfigPath, "utf8")) as TomlTable;
    const hooks = config.hooks as TomlTable;
    const postToolUse = hooks.PostToolUse as unknown[];
    postToolUse.unshift({
      matcher: "^Bash$",
      hooks: [{ type: "command", command: "/usr/local/bin/foreign-hook", timeout: 5 }]
    });
    hooks.state = {
      [`${paths.codexConfigPath}:post_tool_use:1:0`]: {
        trusted_hash: "sha256:trusted-tirion-hook"
      }
    };
    writeFileSync(paths.codexConfigPath, stringify(config));
    const before = readFileSync(paths.codexConfigPath, "utf8");

    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "already_configured"
    });
    expect(readFileSync(paths.codexConfigPath, "utf8")).toBe(before);
    expect(parse(before)).not.toHaveProperty("hooks.PostToolUseFailure");
  });

  it("refreshes an outdated private relay without rewriting an otherwise current Codex config", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const configBefore = readFileSync(paths.codexConfigPath, "utf8");
    writeFileSync(paths.codexHookRelayPath, "\"use strict\";\n// stale\n");

    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    expect(readFileSync(paths.codexConfigPath, "utf8")).toBe(configBefore);
    expect(readFileSync(paths.codexHookRelayPath, "utf8")).toContain("withHookContext");
  });

  it("configures Cursor hooks through a private relay while preserving foreign hook entries", () => {
    const paths = testPaths();
    writeFileSync(paths.cursorHooksPath, JSON.stringify({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: "/usr/local/bin/foreign-cursor-hook" }]
      }
    }));
    const service = new SourceConfigurationService(paths);
    expect(service.configure("cursor", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      provider: "cursor",
      status: "configured",
      promptCaptureEnabled: false,
      logsEnabled: true,
      tracesEnabled: true,
      toolDetailsEnabled: true,
      toolContentEnabled: false,
      restartRequired: true
    });
    const hooks = JSON.parse(readFileSync(paths.cursorHooksPath, "utf8")) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(hooks.hooks.beforeSubmitPrompt).toEqual([
      { command: "/usr/local/bin/foreign-cursor-hook" },
      expect.objectContaining({
        command: expect.stringContaining("http://127.0.0.1:4318/v1/provider-hooks/cursor")
      })
    ]);
    expect(hooks.hooks.stop).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("cursor-hook-relay.cjs")
      })
    ]);
    expect(hooks.hooks.afterFileEdit).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("cursor-hook-relay.cjs")
      })
    ]);
    expect(readFileSync(paths.cursorHookRelayPath, "utf8")).toContain("content-type");
    expect(service.status("cursor", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "configured",
      ownershipState: "managed_current",
      logsEnabled: true,
      tracesEnabled: true,
      toolDetailsEnabled: true,
      toolContentEnabled: false,
      reasonCodes: []
    });
    expect(service.restore("cursor", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.cursorHooksPath, "utf8"))).toEqual({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: "/usr/local/bin/foreign-cursor-hook" }]
      }
    });
    expect(existsSync(paths.cursorHookRelayPath)).toBe(false);
  });

  it("restores Cursor hooks without inventing a version field for versionless configs", () => {
    const paths = testPaths();
    writeFileSync(paths.cursorHooksPath, JSON.stringify({
      hooks: {
        sessionStart: [{ command: "/usr/local/bin/foreign-cursor-session-hook" }]
      }
    }));
    const service = new SourceConfigurationService(paths);
    expect(service.configure("cursor", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      provider: "cursor",
      status: "configured"
    });
    expect(JSON.parse(readFileSync(paths.cursorHooksPath, "utf8"))).toMatchObject({
      version: 1,
      hooks: expect.objectContaining({
        sessionStart: expect.arrayContaining([
          { command: "/usr/local/bin/foreign-cursor-session-hook" }
        ])
      })
    });
    expect(service.restore("cursor", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.cursorHooksPath, "utf8"))).toEqual({
      hooks: {
        sessionStart: [{ command: "/usr/local/bin/foreign-cursor-session-hook" }]
      }
    });
  });

  it("treats a Codex logs-and-traces exporter without metrics as partial for skill reporting", () => {
    const paths = testPaths();
    writeFileSync(paths.codexConfigPath, stringify({
      otel: {
        log_user_prompt: false,
        exporter: {
          "otlp-http": {
            endpoint: "http://127.0.0.1:4318/v1/logs",
            protocol: "json",
            headers: { Authorization: "Bearer local-token" }
          }
        },
        trace_exporter: {
          "otlp-http": {
            endpoint: "http://127.0.0.1:4318/v1/traces",
            protocol: "json",
            headers: { Authorization: "Bearer local-token" }
          }
        }
      }
    }));
    const service = new SourceConfigurationService(paths);
    expect(service.status("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "partial",
      ownershipState: "adoptable_local",
      logsEnabled: true,
      tracesEnabled: false,
      reasonCodes: expect.arrayContaining([
        "local_tirion_exporter_unclaimed",
        "traces_missing"
      ])
    });
    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      tracesEnabled: true
    });
    expect(parse(readFileSync(paths.codexConfigPath, "utf8"))).toMatchObject({
      otel: {
        metrics_exporter: {
          "otlp-http": {
            endpoint: "http://127.0.0.1:4318/v1/metrics",
            protocol: "json",
            headers: { Authorization: "Bearer local-token" }
          }
        }
      }
    });
  });

  it("classifies a Tirion-managed Codex exporter with a stale auth token and repairs it in place", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("codex", "http://127.0.0.1:4318", "old-token")).toMatchObject({
      status: "configured",
      ownershipState: "managed_current"
    });
    expect(service.status("codex", "http://127.0.0.1:4318", "new-token")).toMatchObject({
      configurationState: "conflict",
      ownershipState: "managed_stale_authority",
      reasonCodes: ["stale_managed_agent_token"]
    });
    expect(service.configure("codex", "http://127.0.0.1:4318", "new-token")).toMatchObject({
      status: "configured",
      ownershipState: "managed_current"
    });
    expect(service.restore("codex", "http://127.0.0.1:4318", "latest-token")).toMatchObject({
      status: "restored"
    });
    expect(existsSync(paths.codexConfigPath)).toBe(false);
    expect(existsSync(paths.codexHookRelayPath)).toBe(false);
  });

  it("classifies a removed Tirion-managed Claude Code exporter as managed drift", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    writeFileSync(paths.claudeSettingsPath, JSON.stringify({ env: {} }));
    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "conflict",
      ownershipState: "managed_drifted",
      reasonCodes: ["managed_configuration_drifted"]
    });
  });

  it("restores a pre-enhanced legacy Claude profile without requiring new keys or StopFailure", () => {
    const paths = testPaths();
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(legacyClaudeSettings()));
    writeFileSync(paths.restoreStatePath, JSON.stringify(legacyClaudeRestoreState({
      filePresent: false,
      containerPresent: false
    })));
    const service = new SourceConfigurationService(paths);

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "partial",
      ownershipState: "managed_current",
      logsEnabled: true,
      tracesEnabled: false,
      reasonCodes: expect.arrayContaining(["enhanced_traces_disabled", "hooks_disabled"])
    });
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored",
      promptCaptureEnabled: false,
      logsEnabled: false,
      tracesEnabled: false,
      toolDetailsEnabled: false,
      toolContentEnabled: false,
      responseContentEnabled: false
    });
    expect(existsSync(paths.claudeSettingsPath)).toBe(false);
    expect(existsSync(paths.restoreStatePath)).toBe(false);
  });

  it("upgrades a legacy Claude restore profile while retaining its original baseline", () => {
    const paths = testPaths();
    writeFileSync(paths.claudeSettingsPath, JSON.stringify({
      theme: "dark",
      ...legacyClaudeSettings("console,otlp")
    }));
    writeFileSync(paths.restoreStatePath, JSON.stringify(legacyClaudeRestoreState({
      filePresent: true,
      containerPresent: true,
      presentKeys: ["OTEL_LOGS_EXPORTER", "OTEL_TRACES_EXPORTER"],
      previousExporter: "console",
      previousTraceExporter: "console"
    })));
    const service = new SourceConfigurationService(paths);

    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      tracesEnabled: true
    });
    const upgraded = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      env: Record<string, string>;
      hooks: Record<string, unknown>;
    };
    expect(upgraded.env).toMatchObject({
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_LOG_ASSISTANT_RESPONSES: "0"
    });
    expect(upgraded.hooks).toHaveProperty("StopFailure");
    expect(upgraded.hooks).toHaveProperty("SessionEnd");
    const ledger = JSON.parse(readFileSync(paths.restoreStatePath, "utf8")) as {
      "claude-code": Record<string, unknown>;
    };
    expect(ledger["claude-code"]).toMatchObject({
      claudeProfileVersion: 5,
      previousEnhancedTelemetry: "absent",
      previousAssistantResponses: "absent",
      previousTraceBatchDelay: "absent",
      previousTraceExportInterval: "absent",
      claudeOwnedHookEvents: expect.arrayContaining(["StopFailure"])
    });
    expect(JSON.stringify(ledger)).not.toContain("local-token");

    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored",
      logsEnabled: false,
      tracesEnabled: false
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual({
      theme: "dark",
      env: {
        OTEL_LOGS_EXPORTER: "console",
        OTEL_TRACES_EXPORTER: "console"
      }
    });
  });

  it("upgrades a v2 Claude profile while preserving its pre-batch-delay baseline", () => {
    const paths = testPaths();
    const base = legacyClaudeSettings();
    const original = {
      theme: "dark",
      env: {
        ...base.env,
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
        OTEL_LOG_ASSISTANT_RESPONSES: "0",
        OTEL_BSP_SCHEDULE_DELAY: "750"
      },
      hooks: Object.fromEntries([...LEGACY_CLAUDE_HOOK_EVENTS, "StopFailure"].map((eventName) => [
        eventName,
        [claudeHookGroup(eventName)]
      ]))
    };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    writeFileSync(paths.restoreStatePath, JSON.stringify({
      "claude-code": {
        filePresent: true,
        containerPresent: true,
        claudeProfileVersion: 2,
        claudeOwnedHookEvents: [...LEGACY_CLAUDE_HOOK_EVENTS, "StopFailure"],
        claudePreservedHookEvents: [...LEGACY_CLAUDE_HOOK_EVENTS, "StopFailure"],
        presentKeys: Object.keys(original.env).filter((key) => key !== "OTEL_BSP_SCHEDULE_DELAY"),
        previousExporter: "otlp",
        previousTraceExporter: "otlp",
        configuredPromptCapture: false,
        configuredToolDetails: true,
        configuredToolContent: false,
        configuredResponseContent: false,
        configuredToolHookCapture: true,
        previousTelemetryEnabled: "1",
        previousEnhancedTelemetry: "1",
        previousPromptCapture: "0",
        previousToolDetails: "1",
        previousToolContent: "0",
        previousAssistantResponses: "0",
        previousResponseContent: "0"
      }
    }));
    const service = new SourceConfigurationService(paths);

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "partial",
      ownershipState: "managed_current",
      reasonCodes: ["trace_batch_delay_unoptimized", "trace_export_interval_unoptimized"]
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: {
        OTEL_BSP_SCHEDULE_DELAY: "250",
        OTEL_TRACES_EXPORT_INTERVAL: "250"
      }
    });
    expect(JSON.parse(readFileSync(paths.restoreStatePath, "utf8"))).toMatchObject({
      "claude-code": {
        claudeProfileVersion: 5,
        presentKeys: expect.arrayContaining(["OTEL_BSP_SCHEDULE_DELAY"]),
        previousTraceBatchDelay: "750",
        previousTraceExportInterval: "absent"
      }
    });

    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual(original);
  });

  it("upgrades a v3 Claude profile while preserving an unowned native trace interval", () => {
    const paths = testPaths();
    const base = legacyClaudeSettings();
    writeFileSync(paths.claudeSettingsPath, JSON.stringify({
      theme: "dark",
      env: {
        ...base.env,
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
        OTEL_LOG_ASSISTANT_RESPONSES: "0",
        OTEL_BSP_SCHEDULE_DELAY: "250",
        OTEL_TRACES_EXPORT_INTERVAL: "5000"
      },
      hooks: Object.fromEntries([...LEGACY_CLAUDE_HOOK_EVENTS, "StopFailure"].map((eventName) => [
        eventName,
        [claudeHookGroup(eventName)]
      ]))
    }));
    writeFileSync(paths.restoreStatePath, JSON.stringify({
      "claude-code": {
        filePresent: true,
        containerPresent: true,
        claudeProfileVersion: 3,
        claudeOwnedHookEvents: [...LEGACY_CLAUDE_HOOK_EVENTS, "StopFailure"],
        claudePreservedHookEvents: [],
        presentKeys: [],
        previousExporter: "absent",
        previousTraceExporter: "absent",
        previousTraceBatchDelay: "absent",
        configuredPromptCapture: false,
        configuredToolDetails: true,
        configuredToolContent: false,
        configuredResponseContent: false,
        configuredToolHookCapture: true,
        previousTelemetryEnabled: "absent",
        previousEnhancedTelemetry: "absent",
        previousPromptCapture: "absent",
        previousToolDetails: "absent",
        previousToolContent: "absent",
        previousAssistantResponses: "absent",
        previousResponseContent: "absent"
      }
    }));
    const service = new SourceConfigurationService(paths);

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "partial",
      ownershipState: "managed_current",
      reasonCodes: ["trace_export_interval_unoptimized"]
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: { OTEL_TRACES_EXPORT_INTERVAL: "250" }
    });
    expect(JSON.parse(readFileSync(paths.restoreStatePath, "utf8"))).toMatchObject({
      "claude-code": {
        claudeProfileVersion: 5,
        presentKeys: expect.arrayContaining(["OTEL_TRACES_EXPORT_INTERVAL"]),
        previousTraceBatchDelay: "absent",
        previousTraceExportInterval: "5000"
      }
    });

    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual({
      theme: "dark",
      env: { OTEL_TRACES_EXPORT_INTERVAL: "5000" }
    });
  });

  it("upgrades a v4 Claude ledger by owning SessionEnd while preserving a preexisting foreign handler", () => {
    const paths = testPaths();
    const base = legacyClaudeSettings();
    const foreignSessionEnd = {
      matcher: "other",
      hooks: [{ type: "command", command: "/usr/local/bin/foreign-session-end", timeout: 5 }]
    };
    const original = {
      theme: "dark",
      env: {
        ...base.env,
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
        OTEL_LOG_ASSISTANT_RESPONSES: "0",
        OTEL_BSP_SCHEDULE_DELAY: "250",
        OTEL_TRACES_EXPORT_INTERVAL: "250"
      },
      hooks: {
        ...base.hooks,
        StopFailure: [claudeHookGroup("StopFailure")],
        SessionEnd: [foreignSessionEnd]
      }
    };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    writeFileSync(paths.restoreStatePath, JSON.stringify({
      "claude-code": {
        filePresent: true,
        containerPresent: false,
        claudeProfileVersion: 4,
        // A historical v4 ledger can lack the explicit owned-event list. Its
        // fallback must not claim the preexisting SessionEnd handler.
        claudePreservedHookEvents: [],
        presentKeys: [],
        previousExporter: "absent",
        previousTraceExporter: "absent",
        previousTraceBatchDelay: "absent",
        previousTraceExportInterval: "absent",
        configuredPromptCapture: false,
        configuredToolDetails: true,
        configuredToolContent: false,
        configuredResponseContent: false,
        configuredToolHookCapture: true,
        previousTelemetryEnabled: "absent",
        previousEnhancedTelemetry: "absent",
        previousPromptCapture: "absent",
        previousToolDetails: "absent",
        previousToolContent: "absent",
        previousAssistantResponses: "absent",
        previousResponseContent: "absent"
      }
    }));
    const service = new SourceConfigurationService(paths);

    expect(service.status("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      configurationState: "configured",
      ownershipState: "managed_current",
      reasonCodes: []
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const upgraded = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(upgraded.hooks.SessionEnd).toEqual([
      foreignSessionEnd,
      claudeHookGroup("SessionEnd")
    ]);
    expect(JSON.parse(readFileSync(paths.restoreStatePath, "utf8"))).toMatchObject({
      "claude-code": {
        claudeProfileVersion: 5,
        claudeOwnedHookEvents: expect.arrayContaining(["SessionEnd"]),
        claudePreservedHookEvents: []
      }
    });

    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual({
      theme: "dark",
      hooks: { SessionEnd: [foreignSessionEnd] }
    });
  });

  it("backfills every missing v1 Claude Boolean baseline before privacy-closing the upgraded profile", () => {
    const paths = testPaths();
    const configured = legacyClaudeSettings();
    Object.assign(configured.env, {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "0",
      OTEL_LOG_USER_PROMPTS: "1",
      OTEL_LOG_TOOL_DETAILS: "0",
      OTEL_LOG_TOOL_CONTENT: "1",
      OTEL_LOG_ASSISTANT_RESPONSES: "1",
      OTEL_LOG_RAW_API_BODIES: "1"
    });
    writeFileSync(paths.claudeSettingsPath, JSON.stringify({ theme: "dark", ...configured }));
    writeFileSync(paths.restoreStatePath, JSON.stringify(legacyClaudeRestoreState({
      filePresent: true,
      containerPresent: true,
      presentKeys: [
        "CLAUDE_CODE_ENABLE_TELEMETRY",
        "OTEL_LOGS_EXPORTER",
        "OTEL_TRACES_EXPORTER",
        "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_LOG_USER_PROMPTS",
        "OTEL_LOG_TOOL_DETAILS",
        "OTEL_LOG_TOOL_CONTENT",
        "OTEL_LOG_RAW_API_BODIES"
      ],
      configuredPromptCapture: true,
      configuredToolDetails: false,
      configuredToolContent: true,
      configuredResponseContent: true
    })));
    const service = new SourceConfigurationService(paths);

    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured",
      promptCaptureEnabled: false,
      toolDetailsEnabled: true,
      toolContentEnabled: false,
      responseContentEnabled: false
    });
    const ledger = JSON.parse(readFileSync(paths.restoreStatePath, "utf8")) as {
      "claude-code": Record<string, unknown>;
    };
    expect(ledger["claude-code"]).toMatchObject({
      previousTelemetryEnabled: "1",
      previousEnhancedTelemetry: "0",
      previousPromptCapture: "1",
      previousToolDetails: "0",
      previousToolContent: "1",
      previousAssistantResponses: "1",
      previousResponseContent: "1"
    });

    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored",
      promptCaptureEnabled: true,
      logsEnabled: true,
      tracesEnabled: false,
      toolDetailsEnabled: false,
      toolContentEnabled: false,
      responseContentEnabled: true
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual({
      theme: "dark",
      env: configured.env
    });
  });

  it("adopts an orphaned local Claude Code Tirion exporter and restores its safe observable baseline", () => {
    const paths = testPaths();
    const original = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "console,otlp",
        OTEL_TRACES_EXPORTER: "otlp,console",
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer current-token",
        OTEL_LOG_USER_PROMPTS: "1",
        OTEL_LOG_TOOL_DETAILS: "1",
        OTEL_LOG_TOOL_CONTENT: "1",
        OTEL_LOG_RAW_API_BODIES: "0"
      }
    };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    const service = new SourceConfigurationService(paths);
    expect(service.status("claude-code", "http://127.0.0.1:4318", "current-token")).toMatchObject({
      configurationState: "partial",
      ownershipState: "adoptable_local",
      reasonCodes: expect.arrayContaining([
        "local_tirion_exporter_unclaimed",
        "enhanced_traces_disabled",
        "hooks_disabled"
      ])
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "current-token")).toMatchObject({
      status: "configured",
      ownershipState: "managed_current"
    });
    const adoptionLedger = readFileSync(paths.restoreStatePath, "utf8");
    expect(adoptionLedger).not.toContain("current-token");
    expect(adoptionLedger).not.toContain("127.0.0.1");
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "latest-token")).toMatchObject({
      status: "restored",
      promptCaptureEnabled: true,
      logsEnabled: true,
      tracesEnabled: false,
      toolDetailsEnabled: false,
      toolContentEnabled: false,
      responseContentEnabled: true
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual({
      env: {
        ...original.env,
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer current-token"
      }
    });
  });

  it("refuses first adoption of a stale-auth Claude exporter without mutating settings", () => {
    const paths = testPaths();
    const original = { env: legacyClaudeSettings().env };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    const before = readFileSync(paths.claudeSettingsPath, "utf8");
    const service = new SourceConfigurationService(paths);

    expect(service.configure("claude-code", "http://127.0.0.1:4318", "new-token")).toMatchObject({
      status: "conflict",
      ownershipState: "adoptable_local",
      reasonCodes: ["stale_managed_agent_token"]
    });
    expect(readFileSync(paths.claudeSettingsPath, "utf8")).toBe(before);
    expect(existsSync(paths.restoreStatePath)).toBe(false);
  });

  it("refuses first adoption of a non-exact Tirion-marked Claude hook without a restore ledger", () => {
    const paths = testPaths();
    const original = {
      env: legacyClaudeSettings().env,
      hooks: {
        StopFailure: [claudeHookGroup("StopFailure", "stale-hook-token")]
      }
    };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    const before = readFileSync(paths.claudeSettingsPath, "utf8");
    const service = new SourceConfigurationService(paths);

    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "conflict",
      reasonCodes: ["existing_exporter_conflict"]
    });
    expect(readFileSync(paths.claudeSettingsPath, "utf8")).toBe(before);
    expect(existsSync(paths.restoreStatePath)).toBe(false);
  });

  it("preserves pre-adoption Tirion-marked Claude hook events by event-name ownership", () => {
    const paths = testPaths();
    const stopFailure = claudeHookGroup("StopFailure");
    const original = {
      ...legacyClaudeSettings(),
      hooks: {
        StopFailure: [stopFailure]
      }
    };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    const service = new SourceConfigurationService(paths);

    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const ledgerText = readFileSync(paths.restoreStatePath, "utf8");
    const ledger = JSON.parse(ledgerText) as {
      "claude-code": { claudePreservedHookEvents: string[] };
    };
    expect(ledger["claude-code"].claudePreservedHookEvents).toEqual(["StopFailure"]);
    expect(ledgerText).not.toContain("local-token");
    expect(ledgerText).not.toContain("127.0.0.1");
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual(original);
  });

  it("keeps adopted Claude authorization immutable across restart when it cannot restore the old secret", () => {
    const paths = testPaths();
    const original = {
      ...legacyClaudeSettings(),
      env: {
        ...legacyClaudeSettings().env,
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer token-a"
      },
      hooks: {
        StopFailure: [claudeHookGroup("StopFailure", "token-a")]
      }
    };
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(original));
    expect(new SourceConfigurationService(paths)
      .configure("claude-code", "http://127.0.0.1:4318", "token-a")).toMatchObject({
      status: "configured"
    });
    const configuredBefore = readFileSync(paths.claudeSettingsPath, "utf8");
    const ledgerBefore = readFileSync(paths.restoreStatePath, "utf8");
    expect(ledgerBefore).not.toContain("token-a");

    const conflict = new SourceConfigurationService(paths)
      .configure("claude-code", "http://127.0.0.1:4318", "token-b");
    expect(conflict).toMatchObject({
      status: "conflict",
      ownershipState: "managed_stale_authority",
      reasonCodes: ["restore_conflict"]
    });
    expect(JSON.stringify(conflict)).not.toContain("token-a");
    expect(JSON.stringify(conflict)).not.toContain("token-b");
    expect(readFileSync(paths.claudeSettingsPath, "utf8")).toBe(configuredBefore);
    expect(readFileSync(paths.restoreStatePath, "utf8")).toBe(ledgerBefore);

    const restored = new SourceConfigurationService(paths)
      .restore("claude-code", "http://127.0.0.1:4318", "token-a");
    expect(restored).toMatchObject({ status: "restored" });
    expect(JSON.stringify(restored)).not.toContain("token-a");
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual(original);
  });

  it("rotates fresh Claude authority while preserving foreign sibling handlers and ordering", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "token-a")).toMatchObject({
      status: "configured"
    });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      hooks: Record<string, Record<string, unknown>[]>;
    };
    const managedStop = settings.hooks.Stop![0]!;
    const managedHandler = (managedStop.hooks as Record<string, unknown>[])[0]!;
    const before = { matcher: "before", hooks: [{ type: "command", command: "/foreign/before" }] };
    const foreignSibling = { type: "command", command: "/foreign/sibling" };
    const after = { matcher: "after", hooks: [{ type: "command", command: "/foreign/after" }] };
    settings.hooks.Stop = [
      before,
      { ...managedStop, hooks: [managedHandler, foreignSibling] },
      after
    ];
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));

    const rotation = service.configure("claude-code", "http://127.0.0.1:4318", "token-b");
    expect(rotation).toMatchObject({
      status: "configured"
    });
    expect(JSON.stringify(rotation)).not.toContain("token-a");
    expect(JSON.stringify(rotation)).not.toContain("token-b");
    const ledger = readFileSync(paths.restoreStatePath, "utf8");
    expect(ledger).not.toContain("token-a");
    expect(ledger).not.toContain("token-b");
    const refreshed = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      env: Record<string, string>;
      hooks: Record<string, Record<string, unknown>[]>;
    };
    expect(refreshed.env.OTEL_EXPORTER_OTLP_HEADERS).toBe("Authorization=Bearer token-b");
    expect(refreshed.hooks.Stop).toEqual([
      before,
      { matcher: "*", hooks: [foreignSibling] },
      after,
      claudeHookGroup("Stop", "token-b")
    ]);
    const restored = service.restore("claude-code", "http://127.0.0.1:4318", "token-b");
    expect(restored).toMatchObject({
      status: "restored"
    });
    expect(JSON.stringify(restored)).not.toContain("token-a");
    expect(JSON.stringify(restored)).not.toContain("token-b");
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual({
      hooks: {
        Stop: [
          before,
          { matcher: "*", hooks: [foreignSibling] },
          after
        ]
      }
    });
  });

  it("restores directly through a mixed Claude hook group without deleting its foreign sibling", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const settings = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8")) as {
      hooks: Record<string, { matcher: string; hooks: Record<string, unknown>[] }[]>;
    };
    const foreignSibling = { type: "command", command: "/foreign/direct-restore" };
    settings.hooks.Stop[0]!.hooks.push(foreignSibling);
    writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));

    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored",
      logsEnabled: false,
      tracesEnabled: false
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual({
      hooks: {
        Stop: [{ matcher: "*", hooks: [foreignSibling] }]
      }
    });
  });

  it("allows prompt capture to be disabled for Claude Code and Codex", () => {
    const paths = testPaths();
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token", { capturePrompts: false })).toMatchObject({
      status: "configured",
      promptCaptureEnabled: false
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toMatchObject({
      env: { OTEL_LOG_USER_PROMPTS: "0" }
    });
    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token", { capturePrompts: false })).toMatchObject({
      status: "configured",
      promptCaptureEnabled: false
    });
    expect(parse(readFileSync(paths.codexConfigPath, "utf8"))).toMatchObject({
      otel: { log_user_prompt: false }
    });
  });

  it("restores only the safe Claude Code fields Tirion added", () => {
    const paths = testPaths();
    writeFileSync(paths.claudeSettingsPath, JSON.stringify({
      theme: "dark",
      env: { OTEL_LOGS_EXPORTER: "console", OTEL_TRACES_EXPORTER: "console" }
    }));
    const service = new SourceConfigurationService(paths);
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    const restoration = readFileSync(paths.restoreStatePath, "utf8");
    expect(restoration).not.toContain("local-token");
    expect(restoration).not.toContain("127.0.0.1");
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored",
      restartRequired: true
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual({
      theme: "dark",
      env: { OTEL_LOGS_EXPORTER: "console", OTEL_TRACES_EXPORTER: "console" }
    });
    expect(existsSync(paths.restoreStatePath)).toBe(false);
  });

  it("restores Codex settings and fails closed after a managed field changes", () => {
    const paths = testPaths();
    writeFileSync(paths.codexConfigPath, stringify({ model: "gpt-5.4", otel: { log_user_prompt: true } }));
    const service = new SourceConfigurationService(paths);
    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({ status: "configured" });
    const configured = parse(readFileSync(paths.codexConfigPath, "utf8")) as TomlTable;
    (configured.otel as TomlTable).exporter = { "otlp-http": { endpoint: "https://changed.example", protocol: "json" } };
    writeFileSync(paths.codexConfigPath, stringify(configured));
    expect(service.restore("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "conflict",
      reasonCodes: ["restore_conflict"]
    });
    expect(parse(readFileSync(paths.codexConfigPath, "utf8"))).toMatchObject({
      otel: { exporter: { "otlp-http": { endpoint: "https://changed.example" } } }
    });
  });

  it("enables Codex hooks and restores the previous feature flag without disturbing other features", () => {
    const paths = testPaths();
    writeFileSync(paths.codexConfigPath, stringify({
      features: { hooks: false, multi_agent: true },
      model: "gpt-5.5"
    }));
    const service = new SourceConfigurationService(paths);

    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "configured"
    });
    expect(parse(readFileSync(paths.codexConfigPath, "utf8"))).toMatchObject({
      features: { hooks: true, multi_agent: true }
    });

    expect(service.restore("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({
      status: "restored"
    });
    expect(parse(readFileSync(paths.codexConfigPath, "utf8"))).toEqual({
      features: { hooks: false, multi_agent: true },
      model: "gpt-5.5"
    });
  });

  it("preserves an already matching Codex exporter when restoring log prompt privacy", () => {
    const paths = testPaths();
    const exporter = {
      "otlp-http": {
        endpoint: "http://127.0.0.1:4318/v1/logs",
        protocol: "json",
        headers: { Authorization: "Bearer local-token" }
      }
    };
    const traceExporter = {
      "otlp-http": {
        endpoint: "http://127.0.0.1:4318/v1/traces",
        protocol: "json",
        headers: { Authorization: "Bearer local-token" }
      }
    };
    writeFileSync(paths.codexConfigPath, stringify({ otel: { exporter, trace_exporter: traceExporter, log_user_prompt: false } }));
    const service = new SourceConfigurationService(paths);
    expect(service.configure("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({ status: "configured" });
    expect(service.restore("codex", "http://127.0.0.1:4318", "local-token")).toMatchObject({ status: "restored" });
    expect(parse(readFileSync(paths.codexConfigPath, "utf8"))).toEqual({ otel: {} });
    expect(existsSync(paths.codexHookRelayPath)).toBe(false);
  });
});

const LEGACY_CLAUDE_HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure"
] as const;

function claudeHookGroup(eventName: string, authToken = "local-token") {
  return {
    matcher: "*",
    hooks: [{
      type: "http",
      url: "http://127.0.0.1:4318/v1/provider-hooks/claude-code",
      timeout: 10,
      headers: {
        "X-Tirion-Hook-Surface": "claude-code",
        "X-Tirion-Hook-Event": eventName,
        Authorization: `Bearer ${authToken}`
      }
    }]
  };
}

function legacyClaudeSettings(exporter: "otlp" | "console,otlp" = "otlp") {
  return {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: exporter,
      OTEL_TRACES_EXPORTER: exporter,
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer local-token",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "0",
      OTEL_LOG_RAW_API_BODIES: "0"
    },
    hooks: Object.fromEntries(LEGACY_CLAUDE_HOOK_EVENTS.map((eventName) => [
      eventName,
      [claudeHookGroup(eventName)]
    ]))
  };
}

function legacyClaudeRestoreState(input: {
  filePresent: boolean;
  containerPresent: boolean;
  presentKeys?: string[];
  previousExporter?: "absent" | "console";
  previousTraceExporter?: "absent" | "console";
  configuredPromptCapture?: boolean;
  configuredToolDetails?: boolean;
  configuredToolContent?: boolean;
  configuredResponseContent?: boolean;
}) {
  return {
    "claude-code": {
      filePresent: input.filePresent,
      containerPresent: input.containerPresent,
      presentKeys: input.presentKeys ?? [],
      previousExporter: input.previousExporter ?? "absent",
      previousTraceExporter: input.previousTraceExporter ?? "absent",
      configuredPromptCapture: input.configuredPromptCapture ?? false,
      configuredToolDetails: input.configuredToolDetails ?? true,
      configuredToolContent: input.configuredToolContent ?? false,
      configuredResponseContent: input.configuredResponseContent ?? false,
      configuredToolHookCapture: true
    }
  };
}

function testPaths() {
  const root = mkdtempSync(join(tmpdir(), "tirion-source-config-"));
  roots.push(root);
  mkdirSync(join(root, "claude"), { recursive: true });
  mkdirSync(join(root, "codex"), { recursive: true });
  mkdirSync(join(root, "cursor"), { recursive: true });
  return {
    claudeSettingsPath: join(root, "claude", "settings.json"),
    codexConfigPath: join(root, "codex", "config.toml"),
    cursorHooksPath: join(root, "cursor", "hooks.json"),
    restoreStatePath: join(root, "restore.json"),
    codexHookRelayPath: join(root, "codex-hook-relay.cjs"),
    cursorHookRelayPath: join(root, "cursor-hook-relay.cjs")
  };
}
