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
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer local-token",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "0",
      OTEL_LOG_RAW_API_BODIES: "0"
    });
    expect(settings.hooks).toMatchObject({
      UserPromptSubmit: [expect.any(Object)],
      Stop: [expect.any(Object)],
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
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
        OTEL_LOG_USER_PROMPTS: "0",
        OTEL_LOG_TOOL_DETAILS: "1",
        OTEL_LOG_TOOL_CONTENT: "1",
        OTEL_LOG_RAW_API_BODIES: "1"
      },
      hooks: {
        UserPromptSubmit: [expect.any(Object)],
        Stop: [expect.any(Object)],
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

  it("adopts an orphaned local Claude Code Tirion exporter and restores it to a clean slate", () => {
    const paths = testPaths();
    writeFileSync(paths.claudeSettingsPath, JSON.stringify({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer stale-token",
        OTEL_LOG_USER_PROMPTS: "1",
        OTEL_LOG_TOOL_DETAILS: "1",
        OTEL_LOG_TOOL_CONTENT: "1",
        OTEL_LOG_RAW_API_BODIES: "0"
      }
    }));
    const service = new SourceConfigurationService(paths);
    expect(service.status("claude-code", "http://127.0.0.1:4318", "current-token")).toMatchObject({
      configurationState: "conflict",
      ownershipState: "adoptable_local",
      reasonCodes: ["stale_managed_agent_token", "local_tirion_exporter_unclaimed"]
    });
    expect(service.configure("claude-code", "http://127.0.0.1:4318", "current-token")).toMatchObject({
      status: "configured",
      ownershipState: "managed_current"
    });
    expect(service.restore("claude-code", "http://127.0.0.1:4318", "latest-token")).toMatchObject({
      status: "restored"
    });
    expect(JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual({ env: {} });
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
