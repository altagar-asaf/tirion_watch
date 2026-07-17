import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  ConfigurableProvider,
  ProviderConfigurationOwnershipState,
  ProviderConfigurationRequestV1,
  ProviderConfigurationStateV1,
  ProviderConfigurationV1
} from "@tirion/agent-contract";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "@tirion/platform";
import { parse, stringify, type TomlTable } from "smol-toml";

export type SourceConfigurationPaths = {
  claudeSettingsPath: string;
  codexConfigPath: string;
  cursorHooksPath: string;
  restoreStatePath: string;
  codexHookRelayPath: string;
  cursorHookRelayPath: string;
};

export type CodexHookReadiness = "ready" | "review_required" | "disabled" | "unavailable";

export type CodexHookReadinessProbeInput = {
  codexConfigPath: string;
  cwd: string;
  expectedRelayPath: string;
  expectedUrl: string;
};

export type CodexHookReadinessProbe = (
  input: CodexHookReadinessProbeInput
) => Promise<CodexHookReadiness>;

type SourceConfigurationOptions = Omit<ProviderConfigurationRequestV1, "schemaVersion">;

type ConfigurationSnapshot = {
  promptCaptureEnabled: boolean;
  logsEnabled: boolean;
  tracesEnabled: boolean;
  toolDetailsEnabled: boolean;
  toolContentEnabled: boolean;
  responseContentEnabled: boolean;
};

type ProviderCapabilitySnapshot = {
  toolDetailsSupported: boolean;
  toolContentSupported: boolean;
  responseContentSupported: boolean;
};

export function resolveSourceConfigurationPaths(
  restoreStatePath: string,
  environment: NodeJS.ProcessEnv = process.env
): SourceConfigurationPaths {
  return {
    claudeSettingsPath: join(environment.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"),
    codexConfigPath: join(environment.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
    cursorHooksPath: join(environment.CURSOR_HOME ?? join(homedir(), ".cursor"), "hooks.json"),
    restoreStatePath,
    codexHookRelayPath: join(dirname(restoreStatePath), "codex-hook-relay.cjs"),
    cursorHookRelayPath: join(dirname(restoreStatePath), "cursor-hook-relay.cjs")
  };
}

export async function probeCodexHookReadiness(
  input: CodexHookReadinessProbeInput
): Promise<CodexHookReadiness> {
  const executable = resolveCodexExecutable(process.env);
  return await new Promise<CodexHookReadiness>((resolve) => {
    let settled = false;
    let stdout = "";
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd: input.cwd,
      env: { ...process.env, CODEX_HOME: dirname(input.codexConfigPath) },
      stdio: ["pipe", "pipe", "ignore"]
    });
    const finish = (status: CodexHookReadiness) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve(status);
    };
    const send = (value: unknown) => {
      if (!settled) child.stdin.write(`${JSON.stringify(value)}\n`);
    };
    const timeout = setTimeout(() => finish("unavailable"), 3_000);
    child.stdin.on("error", () => finish("unavailable"));
    child.once("error", () => finish("unavailable"));
    child.once("exit", () => finish("unavailable"));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2_000_000) {
        finish("unavailable");
        return;
      }
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let message: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!isRecord(parsed)) continue;
          message = parsed;
        } catch {
          continue;
        }
        if (message.id === 1 && isRecord(message.result)) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "hooks/list", params: { cwds: [input.cwd] } });
          continue;
        }
        if (message.id === 2) {
          finish(codexHookReadinessFromListResponse(message.result, input.expectedUrl));
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "tirion-agent", version: "0.1" },
        capabilities: { experimentalApi: true }
      }
    });
  });
}

function codexHookReadinessFromListResponse(result: unknown, expectedUrl: string): CodexHookReadiness {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    return "unavailable";
  }
  const hooks = result.data.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) return [];
    return entry.hooks.filter(isRecord);
  }).filter((hook) =>
    typeof hook.command === "string"
    && hook.command.includes("codex-hook-relay.cjs")
    && hook.command.includes(expectedUrl));
  const requiredEvents = new Set(["userPromptSubmit", "stop", "subagentStart", "subagentStop", "postToolUse"]);
  const byEvent = new Map<string, Record<string, unknown>>();
  for (const hook of hooks) {
    if (typeof hook.eventName === "string" && requiredEvents.has(hook.eventName)) {
      byEvent.set(hook.eventName, hook);
    }
  }
  if ([...requiredEvents].some((eventName) => !byEvent.has(eventName))) {
    return "unavailable";
  }
  if ([...byEvent.values()].some((hook) => hook.enabled !== true)) {
    return "disabled";
  }
  if ([...byEvent.values()].some((hook) => !["trusted", "managed"].includes(String(hook.trustStatus)))) {
    return "review_required";
  }
  return "ready";
}

function resolveCodexExecutable(environment: NodeJS.ProcessEnv): string {
  const configured = environment.TIRION_CODEX_BIN?.trim();
  if (configured) return configured;
  for (const candidate of [
    join(homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex"
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "codex";
}

export class SourceConfigurationService {
  constructor(
    private readonly paths: SourceConfigurationPaths,
    private readonly probeCodexHooks: CodexHookReadinessProbe = probeCodexHookReadiness
  ) {}

  async codexHookReadiness(cwd: string, otlpBaseUrl: string): Promise<CodexHookReadiness> {
    return await this.probeCodexHooks({
      codexConfigPath: this.paths.codexConfigPath,
      cwd,
      expectedRelayPath: this.paths.codexHookRelayPath,
      expectedUrl: `${otlpBaseUrl}/v1/provider-hooks/codex`
    });
  }

  configure(
    provider: ConfigurableProvider,
    otlpBaseUrl: string,
    authToken?: string,
    options: SourceConfigurationOptions = {}
  ): ProviderConfigurationV1 {
    try {
      return provider === "claude-code"
        ? this.configureClaudeCode(otlpBaseUrl, authToken, options)
        : provider === "codex"
          ? this.configureCodex(otlpBaseUrl, authToken, options)
          : this.configureCursor(otlpBaseUrl, authToken, options);
    } catch {
      return result(provider, "unavailable", "source_configuration_unavailable");
    }
  }

  status(provider: ConfigurableProvider, otlpBaseUrl: string, authToken?: string): ProviderConfigurationStateV1 {
    try {
      return provider === "claude-code"
        ? this.claudeCodeStatus(otlpBaseUrl, authToken)
        : provider === "codex"
          ? this.codexStatus(otlpBaseUrl, authToken)
          : this.cursorStatus(otlpBaseUrl, authToken);
    } catch {
      return unavailableState(provider);
    }
  }

  restore(provider: ConfigurableProvider, otlpBaseUrl: string, authToken?: string): ProviderConfigurationV1 {
    try {
      return provider === "claude-code"
        ? this.restoreClaudeCode(otlpBaseUrl, authToken)
        : provider === "codex"
          ? this.restoreCodex(otlpBaseUrl, authToken)
          : this.restoreCursor(otlpBaseUrl, authToken);
    } catch {
      return result(provider, "unavailable", "source_configuration_unavailable");
    }
  }

  private configureClaudeCode(
    otlpBaseUrl: string,
    authToken: string | undefined,
    options: SourceConfigurationOptions
  ): ProviderConfigurationV1 {
    const currentStatus = this.claudeCodeStatus(otlpBaseUrl, authToken);
    const current = readJsonObject(this.paths.claudeSettingsPath);
    if (!current.ok) {
      return result("claude-code", "conflict", "invalid_existing_configuration", undefined, undefined, "invalid");
    }
    const env = current.value.env == null ? {} : asStringRecord(current.value.env);
    if (!env) {
      return result("claude-code", "conflict", "invalid_existing_configuration", undefined, undefined, "invalid");
    }
    if (
      !claudeTraceBatchDelayIsValid(env.OTEL_BSP_SCHEDULE_DELAY)
      || !claudeTraceExportIntervalIsValid(env.OTEL_TRACES_EXPORT_INTERVAL)
    ) {
      return result(
        "claude-code",
        "conflict",
        "invalid_existing_configuration",
        undefined,
        undefined,
        currentStatus.ownershipState
      );
    }
    const existingRestoration = this.restoreState()["claude-code"];
    const endpoint = `${otlpBaseUrl}/v1/logs`;
    const traceEndpoint = `${otlpBaseUrl}/v1/traces`;
    const hookEndpoint = `${otlpBaseUrl}/v1/provider-hooks/claude-code`;
    if (!claudeLocalHookPolicyAllows(current.value, hookEndpoint)) {
      return result("claude-code", "conflict", "hooks_disabled", undefined, undefined, currentStatus.ownershipState);
    }
    if (!existingRestoration) {
      if (
        currentStatus.ownershipState === "adoptable_local"
        && currentStatus.reasonCodes.includes("stale_managed_agent_token")
      ) {
        return result(
          "claude-code",
          "conflict",
          "stale_managed_agent_token",
          undefined,
          undefined,
          "adoptable_local"
        );
      }
      if (!claudePreexistingTirionHooksExact(current.value.hooks, otlpBaseUrl, authToken)) {
        return result(
          "claude-code",
          "conflict",
          "existing_exporter_conflict",
          undefined,
          undefined,
          currentStatus.ownershipState
        );
      }
    }
    const existingEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    const existingTraceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const existingProtocol = env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL;
    const existingTraceProtocol = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    const desiredHeaders = authToken ? `Authorization=Bearer ${authToken}` : undefined;
    const existingHeaders = env.OTEL_EXPORTER_OTLP_HEADERS;
    if (
      existingRestoration
      && !claudeManagedAuthorityChangeIsReversible(
        existingRestoration,
        current.value.hooks,
        otlpBaseUrl,
        authToken,
        existingHeaders,
        desiredHeaders
      )
    ) {
      return result(
        "claude-code",
        "conflict",
        "restore_conflict",
        undefined,
        undefined,
        currentStatus.ownershipState
      );
    }
    const localTirionConfig = currentStatus.ownershipState === "adoptable_local";
    const recoverableConflict = currentStatus.ownershipState === "managed_stale_authority"
      || localTirionConfig
      || (currentStatus.ownershipState === "managed_drifted"
        && Object.keys(env).length === 0
        && !existingEndpoint
        && !existingTraceEndpoint
        && !existingProtocol
        && !existingTraceProtocol
        && !existingHeaders);
    const desiredPromptCapture = options.capturePrompts ?? false;
    const desiredToolDetails = options.captureToolDetails ?? true;
    const desiredToolContent = options.captureToolContent ?? false;
    const desiredResponseContent = options.captureResponseContent ?? false;
    const desiredToolHookCapture = desiredHookCapture(options.captureToolDetails, options.captureToolContent, true);
    const managedBooleanKeys = [
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
      "OTEL_LOG_USER_PROMPTS",
      "OTEL_LOG_TOOL_DETAILS",
      "OTEL_LOG_TOOL_CONTENT",
      "OTEL_LOG_ASSISTANT_RESPONSES",
      "OTEL_LOG_RAW_API_BODIES"
    ] as const;
    if (
      (existingEndpoint && existingEndpoint !== endpoint)
      || (existingTraceEndpoint && existingTraceEndpoint !== traceEndpoint)
      || (existingProtocol && existingProtocol !== "http/json")
      || (existingTraceProtocol && existingTraceProtocol !== "http/json")
      || (existingHeaders && existingHeaders !== desiredHeaders)
      || managedBooleanKeys.some((key) =>
        env[key]
        && !isManagedBooleanValueAllowed(key, env[key]))
    ) {
      if (!recoverableConflict) {
        return result("claude-code", "conflict", "existing_exporter_conflict", undefined, undefined, currentStatus.ownershipState);
      }
    }
    const logsExporters = exporterList(env.OTEL_LOGS_EXPORTER);
    const tracesExporters = exporterList(env.OTEL_TRACES_EXPORTER);
    const safeLogsExporters = logsExporters ?? [];
    const safeTracesExporters = tracesExporters ?? [];
    if (
      !logsExporters
      || logsExporters.includes("none")
      || logsExporters.some((item) => !["console", "otlp"].includes(item))
      || (logsExporters.includes("otlp") && existingEndpoint !== endpoint)
      || !tracesExporters
      || tracesExporters.includes("none")
      || tracesExporters.some((item) => !["console", "otlp"].includes(item))
      || (tracesExporters.includes("otlp") && existingTraceEndpoint !== traceEndpoint)
    ) {
      if (!recoverableConflict) {
        return result("claude-code", "conflict", "existing_exporter_conflict", undefined, undefined, currentStatus.ownershipState);
      }
    }
    const desiredEnv = {
      ...env,
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_LOGS_EXPORTER: [...new Set([...safeLogsExporters, "otlp"])].join(","),
      OTEL_TRACES_EXPORTER: [...new Set([...safeTracesExporters, "otlp"])].join(","),
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: traceEndpoint,
      OTEL_EXPORTER_OTLP_HEADERS: desiredHeaders,
      OTEL_BSP_SCHEDULE_DELAY: CLAUDE_TRACE_BATCH_DELAY_MILLIS,
      OTEL_TRACES_EXPORT_INTERVAL: CLAUDE_TRACE_EXPORT_INTERVAL_MILLIS,
      OTEL_LOG_USER_PROMPTS: desiredPromptCapture ? "1" : "0",
      OTEL_LOG_TOOL_DETAILS: desiredToolDetails ? "1" : "0",
      OTEL_LOG_TOOL_CONTENT: desiredToolContent ? "1" : "0",
      OTEL_LOG_ASSISTANT_RESPONSES: desiredResponseContent ? "1" : "0",
      OTEL_LOG_RAW_API_BODIES: desiredResponseContent ? "1" : "0"
    };
    const previouslyOwnedHookEvents = new Set(existingRestoration ? claudeOwnedHookEvents(existingRestoration) : []);
    const newlyObservedHookEvents = claudeManagedHookEventsPresent(current.value.hooks)
      .filter((eventName) => !previouslyOwnedHookEvents.has(eventName));
    const preservedHookEvents = uniqueClaudeHookEvents([
      ...claudePreservedHookEvents(existingRestoration),
      ...newlyObservedHookEvents
    ]);
    const desiredHooks = claudeHooksValue(
      current.value.hooks,
      otlpBaseUrl,
      authToken,
      desiredToolHookCapture,
      preservedHookEvents
    );
    const next = mergeClaudeConfiguration(current.value, desiredEnv, desiredHooks);
    const restoreBaseline: ProviderRestoreState = {
      filePresent: existsSync(this.paths.claudeSettingsPath),
      containerPresent: current.value.env != null,
      claudeProfileVersion: CLAUDE_CURRENT_RESTORE_PROFILE,
      claudeOwnedHookEvents: claudeConfiguredHookEvents(desiredToolHookCapture),
      claudePreservedHookEvents: preservedHookEvents,
      presentKeys: CLAUDE_MANAGED_KEYS.filter((key) => env[key] != null),
      previousExporter: claudeExporterRestoreValue(env.OTEL_LOGS_EXPORTER),
      previousTraceExporter: claudeExporterRestoreValue(env.OTEL_TRACES_EXPORTER),
      previousTraceBatchDelay: claudeTraceBatchDelayRestoreValue(env.OTEL_BSP_SCHEDULE_DELAY),
      previousTraceExportInterval: claudeTraceExportIntervalRestoreValue(env.OTEL_TRACES_EXPORT_INTERVAL),
      configuredPromptCapture: desiredPromptCapture,
      configuredToolDetails: desiredToolDetails,
      configuredToolContent: desiredToolContent,
      configuredResponseContent: desiredResponseContent,
      configuredToolHookCapture: desiredToolHookCapture,
      previousTelemetryEnabled: claudeBooleanRestoreValue(env.CLAUDE_CODE_ENABLE_TELEMETRY),
      previousEnhancedTelemetry: claudeBooleanRestoreValue(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA),
      previousPromptCapture: claudeBooleanRestoreValue(env.OTEL_LOG_USER_PROMPTS),
      previousToolDetails: claudeBooleanRestoreValue(env.OTEL_LOG_TOOL_DETAILS),
      previousToolContent: claudeBooleanRestoreValue(env.OTEL_LOG_TOOL_CONTENT),
      previousAssistantResponses: claudeBooleanRestoreValue(env.OTEL_LOG_ASSISTANT_RESPONSES),
      previousResponseContent: claudeBooleanRestoreValue(env.OTEL_LOG_RAW_API_BODIES)
    };
    if (JSON.stringify(current.value) === JSON.stringify(next)) {
      if (localTirionConfig) {
        this.recordRestoreState("claude-code", restoreBaseline);
      }
      return result("claude-code", "already_configured", "already_configured", desiredEnv, undefined, currentStatus.ownershipState);
    }
    this.recordRestoreState("claude-code", restoreBaseline);
    ensurePrivateDirectory(dirname(this.paths.claudeSettingsPath));
    writePrivateFileAtomic(this.paths.claudeSettingsPath, `${JSON.stringify(next, null, 2)}\n`);
    return result("claude-code", "configured", "provider_configured", desiredEnv, undefined, "managed_current");
  }

  private configureCodex(
    otlpBaseUrl: string,
    authToken: string | undefined,
    options: SourceConfigurationOptions
  ): ProviderConfigurationV1 {
    const currentStatus = this.codexStatus(otlpBaseUrl, authToken);
    const localTirionConfig = currentStatus.ownershipState === "adoptable_local";
    const current = readToml(this.paths.codexConfigPath);
    if (!current.ok) {
      return result("codex", "conflict", "invalid_existing_configuration", undefined, undefined, "invalid");
    }
    const otel = current.value.otel == null ? {} : asTomlTable(current.value.otel);
    const features = current.value.features == null ? {} : asTomlTable(current.value.features);
    if (!otel || !features) {
      return result("codex", "conflict", "invalid_existing_configuration", undefined, undefined, "invalid");
    }
    const recoverableConflict = currentStatus.ownershipState === "managed_stale_authority"
      || localTirionConfig
      || (currentStatus.ownershipState === "managed_drifted"
        && otel.exporter == null
        && otel.trace_exporter == null
        && otel.metrics_exporter == null
        && otel.log_user_prompt == null);
    const desiredExporter = {
      "otlp-http": {
        endpoint: `${otlpBaseUrl}/v1/logs`,
        protocol: "json",
        ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {})
      }
    };
    const desiredTraceExporter = {
      "otlp-http": {
        endpoint: `${otlpBaseUrl}/v1/traces`,
        protocol: "json",
        ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {})
      }
    };
    const desiredMetricsExporter = codexDesiredMetricsExporter(otlpBaseUrl, authToken);
    const desiredToolHookCapture = desiredHookCapture(options.captureToolDetails, options.captureToolContent, true);
    const desiredPromptHookCapture = true;
    if (
      (otel.exporter != null && JSON.stringify(otel.exporter) !== JSON.stringify(desiredExporter))
      || (otel.trace_exporter != null && JSON.stringify(otel.trace_exporter) !== JSON.stringify(desiredTraceExporter))
      || (otel.metrics_exporter != null && JSON.stringify(otel.metrics_exporter) !== JSON.stringify(desiredMetricsExporter))
    ) {
      if (!recoverableConflict) {
        return result("codex", "conflict", "existing_exporter_conflict", undefined, undefined, currentStatus.ownershipState);
      }
    }
    const desiredPromptCapture = options.capturePrompts ?? false;
    const desiredHooks = codexHooksValue(
      current.value.hooks,
      this.paths.codexHookRelayPath,
      otlpBaseUrl,
      authToken,
      desiredPromptHookCapture,
      desiredToolHookCapture
    );
    const relayScript = relayScriptRequired(desiredToolHookCapture, desiredPromptHookCapture)
      ? codexHookRelayScript()
      : undefined;
    const relayScriptNeedsUpdate = relayScript != null
      && !privateFileMatches(this.paths.codexHookRelayPath, relayScript);
    const next = {
      ...current.value,
      features: {
        ...features,
        hooks: true
      },
      otel: {
        ...otel,
        log_user_prompt: desiredPromptCapture,
        exporter: desiredExporter,
        trace_exporter: desiredTraceExporter,
        metrics_exporter: desiredMetricsExporter
      },
      ...(desiredHooks ? { hooks: desiredHooks } : {})
    };
    if (!desiredHooks) {
      delete (next as TomlTable).hooks;
    }
    if (JSON.stringify(current.value) === JSON.stringify(next) && !relayScriptNeedsUpdate) {
      if (localTirionConfig) {
        this.recordRestoreState("codex", {
          filePresent: existsSync(this.paths.codexConfigPath),
          containerPresent: current.value.otel != null,
          adoptedWithoutBaseline: true,
          exporterPresent: false,
          traceExporterPresent: false,
          metricsExporterPresent: false,
          logUserPrompt: "absent",
          configuredPromptCapture: desiredPromptCapture,
          configuredToolHookCapture: desiredToolHookCapture,
          configuredPromptHookCapture: desiredPromptHookCapture,
          featuresContainerPresent: current.value.features != null,
          hooksFeature: codexHooksFeatureState(features.hooks)
        });
      }
      return result("codex", "already_configured", "already_configured", undefined, {
        promptCaptureEnabled: desiredPromptCapture,
        logsEnabled: true,
        tracesEnabled: true,
        toolDetailsEnabled: desiredToolHookCapture,
        toolContentEnabled: desiredToolHookCapture
      }, currentStatus.ownershipState);
    }
    this.recordRestoreState("codex", localTirionConfig
      ? {
          filePresent: existsSync(this.paths.codexConfigPath),
          containerPresent: current.value.otel != null,
          adoptedWithoutBaseline: true,
          exporterPresent: false,
          traceExporterPresent: false,
          metricsExporterPresent: false,
          logUserPrompt: "absent",
          configuredPromptCapture: desiredPromptCapture,
          configuredToolHookCapture: desiredToolHookCapture,
          configuredPromptHookCapture: desiredPromptHookCapture,
          featuresContainerPresent: current.value.features != null,
          hooksFeature: codexHooksFeatureState(features.hooks)
        }
      : {
          filePresent: existsSync(this.paths.codexConfigPath),
          containerPresent: current.value.otel != null,
          exporterPresent: otel.exporter != null,
          traceExporterPresent: otel.trace_exporter != null,
          metricsExporterPresent: otel.metrics_exporter != null,
          logUserPrompt: otel.log_user_prompt === true ? "true" : otel.log_user_prompt === false ? "false" : "absent",
          configuredPromptCapture: desiredPromptCapture,
          configuredToolHookCapture: desiredToolHookCapture,
          configuredPromptHookCapture: desiredPromptHookCapture,
          featuresContainerPresent: current.value.features != null,
          hooksFeature: codexHooksFeatureState(features.hooks)
        });
    ensurePrivateDirectory(dirname(this.paths.codexConfigPath));
    if (relayScript != null) {
      ensurePrivateDirectory(dirname(this.paths.codexHookRelayPath));
      writePrivateFileAtomic(this.paths.codexHookRelayPath, relayScript);
    }
    writePrivateFileAtomic(this.paths.codexConfigPath, stringify(next));
    return result("codex", "configured", "provider_configured", undefined, {
      promptCaptureEnabled: desiredPromptCapture,
      logsEnabled: true,
      tracesEnabled: true,
      toolDetailsEnabled: desiredToolHookCapture,
      toolContentEnabled: desiredToolHookCapture
    }, "managed_current");
  }

  private configureCursor(
    otlpBaseUrl: string,
    authToken: string | undefined,
    options: SourceConfigurationOptions
  ): ProviderConfigurationV1 {
    const currentStatus = this.cursorStatus(otlpBaseUrl, authToken);
    const localTirionConfig = currentStatus.ownershipState === "adoptable_local";
    const current = readJsonObject(this.paths.cursorHooksPath);
    if (!current.ok) {
      return result("cursor", "conflict", "invalid_existing_configuration", undefined, undefined, "invalid");
    }
    const recoverableConflict = currentStatus.ownershipState === "managed_stale_authority"
      || currentStatus.ownershipState === "managed_drifted"
      || localTirionConfig;
    if (current.value.hooks != null && !isRecord(current.value.hooks)) {
      return result("cursor", "conflict", "invalid_existing_configuration", undefined, undefined, "invalid");
    }
    const desiredActivityHookCapture = desiredHookCapture(options.captureToolDetails, options.captureToolContent, true);
    const desiredHooks = cursorHooksValue(
      current.value,
      this.paths.cursorHookRelayPath,
      otlpBaseUrl,
      authToken,
      desiredActivityHookCapture
    );
    const relayScript = codexHookRelayScript();
    const relayScriptNeedsUpdate = !privateFileMatches(this.paths.cursorHookRelayPath, relayScript);
    const next = {
      ...current.value,
      version: current.value.version ?? 1,
      hooks: desiredHooks
    };
    if (JSON.stringify(current.value) === JSON.stringify(next) && !relayScriptNeedsUpdate) {
      if (localTirionConfig) {
        this.recordRestoreState("cursor", {
          filePresent: existsSync(this.paths.cursorHooksPath),
          containerPresent: isRecord(current.value.hooks),
          adoptedWithoutBaseline: true,
          versionPresent: current.value.version != null,
          configuredPromptCapture: false,
          configuredToolHookCapture: desiredActivityHookCapture
        });
      }
      return result("cursor", "already_configured", "already_configured", undefined, {
        promptCaptureEnabled: false,
        logsEnabled: true,
        tracesEnabled: true,
        toolDetailsEnabled: desiredActivityHookCapture,
        toolContentEnabled: false
      }, currentStatus.ownershipState);
    }
    if (currentStatus.configurationState === "conflict" && !recoverableConflict) {
      return result("cursor", "conflict", "existing_exporter_conflict", undefined, undefined, currentStatus.ownershipState);
    }
    this.recordRestoreState("cursor", localTirionConfig
      ? {
          filePresent: existsSync(this.paths.cursorHooksPath),
          containerPresent: isRecord(current.value.hooks),
          adoptedWithoutBaseline: true,
          versionPresent: current.value.version != null,
          configuredPromptCapture: false,
          configuredToolHookCapture: desiredActivityHookCapture
        }
      : {
          filePresent: existsSync(this.paths.cursorHooksPath),
          containerPresent: isRecord(current.value.hooks),
          versionPresent: current.value.version != null,
          configuredPromptCapture: false,
          configuredToolHookCapture: desiredActivityHookCapture
        });
    ensurePrivateDirectory(dirname(this.paths.cursorHooksPath));
    ensurePrivateDirectory(dirname(this.paths.cursorHookRelayPath));
    writePrivateFileAtomic(this.paths.cursorHookRelayPath, relayScript);
    writePrivateFileAtomic(this.paths.cursorHooksPath, `${JSON.stringify(next, null, 2)}\n`);
    return result("cursor", "configured", "provider_configured", undefined, {
      promptCaptureEnabled: false,
      logsEnabled: true,
      tracesEnabled: true,
      toolDetailsEnabled: desiredActivityHookCapture,
      toolContentEnabled: false
    }, "managed_current");
  }

  private restoreClaudeCode(otlpBaseUrl: string, authToken?: string): ProviderConfigurationV1 {
    const restoration = this.restoreState()["claude-code"];
    if (!restoration) {
      return result("claude-code", "not_managed", "provider_not_managed", undefined, undefined, "unmanaged");
    }
    const ownership = this.claudeCodeStatus(otlpBaseUrl, authToken).ownershipState;
    const current = readJsonObject(this.paths.claudeSettingsPath);
    const env = current.ok && current.value.env != null ? asStringRecord(current.value.env) : current.ok ? {} : undefined;
    if (!current.ok || !env) {
      return result("claude-code", "conflict", "restore_conflict", undefined, undefined, "managed_drifted");
    }
    const desired = claudeDesiredValues(
      otlpBaseUrl,
      authToken,
      restoration.previousExporter ?? "absent",
      restoration.previousTraceExporter ?? "absent",
      restoration.configuredPromptCapture ?? true,
      restoration.configuredToolDetails ?? true,
      restoration.configuredToolContent ?? true,
      restoration.configuredResponseContent ?? true
    );
    const presentKeys = restoration.presentKeys ?? [];
    const ownedKeys = claudeOwnedKeys(restoration);
    const changedKeys = restoration.adoptedWithoutBaseline
      ? [...ownedKeys]
      : ownedKeys.filter((key) => {
          const previousValue = claudePreviousManagedValue(restoration, key);
          if (!presentKeys.includes(key)) return true;
          if (
            (key === "OTEL_LOGS_EXPORTER" || key === "OTEL_TRACES_EXPORTER")
            && previousValue === "absent"
          ) {
            return false;
          }
          return previousValue != null && previousValue !== desired[key];
        });
    if (restoration.adoptedWithoutBaseline) {
      if (ownership !== "managed_current" && ownership !== "managed_stale_authority") {
        return result("claude-code", "conflict", "restore_conflict", undefined, undefined, "managed_drifted");
      }
    } else if (changedKeys.some((key) =>
      key === "OTEL_EXPORTER_OTLP_HEADERS" && ownership === "managed_stale_authority"
        ? env[key] == null
        : env[key] !== desired[key])) {
      return result("claude-code", "conflict", "restore_conflict", undefined, undefined, "managed_drifted");
    }
    const ownedHookEvents = claudeOwnedHookEvents(restoration);
    const staleAuthorization = ownership === "managed_stale_authority"
      ? claudeHookAuthorizationFromOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
      : undefined;
    const hooksConfigured = claudeHookEventsRestorable(
      current.value.hooks,
      otlpBaseUrl,
      authToken,
      ownedHookEvents,
      staleAuthorization
    );
    if (
      !hooksConfigured
      || (ownership === "managed_stale_authority" && (
        staleAuthorization == null
        || !claudeManagedHookAuthorizationsUniform(current.value.hooks, ownedHookEvents, staleAuthorization)
      ))
    ) {
      return result("claude-code", "conflict", "restore_conflict", undefined, undefined, "managed_drifted");
    }
    const restoredEnv = { ...env };
    for (const key of changedKeys) {
      const previousBoolean = claudePreviousBooleanValue(restoration, key);
      if (key === "OTEL_LOGS_EXPORTER" && restoration.previousExporter && restoration.previousExporter !== "absent") {
        restoredEnv[key] = restoration.previousExporter;
      } else if (key === "OTEL_TRACES_EXPORTER" && restoration.previousTraceExporter && restoration.previousTraceExporter !== "absent") {
        restoredEnv[key] = restoration.previousTraceExporter;
      } else if (
        key === "OTEL_BSP_SCHEDULE_DELAY"
        && restoration.previousTraceBatchDelay != null
        && restoration.previousTraceBatchDelay !== "absent"
      ) {
        restoredEnv[key] = restoration.previousTraceBatchDelay;
      } else if (
        key === "OTEL_TRACES_EXPORT_INTERVAL"
        && restoration.previousTraceExportInterval != null
        && restoration.previousTraceExportInterval !== "absent"
      ) {
        restoredEnv[key] = restoration.previousTraceExportInterval;
      } else if (previousBoolean === "0" || previousBoolean === "1") {
        restoredEnv[key] = previousBoolean;
      } else {
        delete restoredEnv[key];
      }
    }
    const restored = { ...current.value };
    if (!restoration.containerPresent && Object.keys(restoredEnv).length === 0) {
      delete restored.env;
    } else {
      restored.env = restoredEnv;
    }
    const preservedHookEvents = new Set(claudePreservedHookEvents(restoration));
    const restoredHooks = removeClaudeHooks(
      current.value.hooks,
      ownedHookEvents.filter((eventName) => !preservedHookEvents.has(eventName))
    );
    if (restoredHooks && Object.keys(restoredHooks).length > 0) {
      restored.hooks = restoredHooks;
    } else {
      delete restored.hooks;
    }
    writeOrRemoveConfiguration(this.paths.claudeSettingsPath, restored, restoration.filePresent, "json");
    this.clearRestoreState("claude-code");
    const restoredBaseSnapshot = claudeState(restoredEnv, otlpBaseUrl);
    const restoredHookShape = claudeHookShape(restored.hooks, otlpBaseUrl, authToken);
    const restoredHooksLocallyEnabled = claudeLocalHookPolicyAllows(
      restored,
      `${otlpBaseUrl}/v1/provider-hooks/claude-code`
    );
    return result("claude-code", "restored", "provider_restored", undefined, {
      ...restoredBaseSnapshot,
      toolDetailsEnabled: restoredBaseSnapshot.toolDetailsEnabled
        && restoredHooksLocallyEnabled
        && restoredHookShape.toolHooksConfigured,
      toolContentEnabled: restoredBaseSnapshot.toolContentEnabled
        && restoredHooksLocallyEnabled
        && restoredHookShape.toolHooksConfigured
    }, "managed_current");
  }

  private restoreCodex(otlpBaseUrl: string, authToken?: string): ProviderConfigurationV1 {
    const restoration = this.restoreState().codex;
    if (!restoration) {
      return result("codex", "not_managed", "provider_not_managed", undefined, undefined, "unmanaged");
    }
    const ownership = this.codexStatus(otlpBaseUrl, authToken).ownershipState;
    const current = readToml(this.paths.codexConfigPath);
    const otel = current.ok && current.value.otel != null ? asTomlTable(current.value.otel) : current.ok ? {} : undefined;
    const features = current.ok && current.value.features != null ? asTomlTable(current.value.features) : current.ok ? {} : undefined;
    const desiredExporter = codexDesiredExporter(otlpBaseUrl, authToken);
    const desiredTraceExporter = codexDesiredTraceExporter(otlpBaseUrl, authToken);
    const desiredMetricsExporter = codexDesiredMetricsExporter(otlpBaseUrl, authToken);
    const codexHooks = current.ok
      ? codexHookShape(current.value.hooks, this.paths.codexHookRelayPath, otlpBaseUrl, authToken, true)
      : { promptHooksConfigured: false, toolHooksConfigured: false, localTirionShape: false };
    const restoreReady = restoration.adoptedWithoutBaseline
      ? ownership === "managed_current" || ownership === "managed_stale_authority"
      : current.ok
        && Boolean(otel)
        && Boolean(features)
        && features!.hooks === true
        && codexExporterMatchesForRestore(otel!.exporter, desiredExporter, ownership === "managed_stale_authority")
        && codexExporterMatchesForRestore(otel!.trace_exporter, desiredTraceExporter, ownership === "managed_stale_authority")
        && codexExporterMatchesForRestore(otel!.metrics_exporter, desiredMetricsExporter, ownership === "managed_stale_authority")
        && otel!.log_user_prompt === (restoration.configuredPromptCapture ?? true)
        && ((restoration.configuredPromptHookCapture === true ? codexHooks.promptHooksConfigured : true)
          && (restoration.configuredToolHookCapture === true ? codexHooks.toolHooksConfigured : true));
    if (!current.ok || !otel || !features || !restoreReady) {
      return result("codex", "conflict", "restore_conflict", undefined, undefined, "managed_drifted");
    }
    const restoredOtel = { ...otel };
    if (restoration.adoptedWithoutBaseline || !restoration.exporterPresent) {
      delete restoredOtel.exporter;
    }
    if (restoration.adoptedWithoutBaseline || !restoration.traceExporterPresent) {
      delete restoredOtel.trace_exporter;
    }
    if (restoration.adoptedWithoutBaseline || !restoration.metricsExporterPresent) {
      delete restoredOtel.metrics_exporter;
    }
    if (restoration.adoptedWithoutBaseline || restoration.logUserPrompt === "absent") {
      delete restoredOtel.log_user_prompt;
    } else {
      restoredOtel.log_user_prompt = restoration.logUserPrompt === "true";
    }
    const restored = { ...current.value };
    if (!restoration.containerPresent && Object.keys(restoredOtel).length === 0) {
      delete restored.otel;
    } else {
      restored.otel = restoredOtel;
    }
    const restoredHooks = removeCodexHooks(current.value.hooks);
    if (restoredHooks && Object.keys(restoredHooks).length > 0) {
      restored.hooks = restoredHooks as TomlTable;
    } else {
      delete restored.hooks;
    }
    const restoredFeatures = { ...features };
    if (restoration.adoptedWithoutBaseline || restoration.hooksFeature === "absent") {
      delete restoredFeatures.hooks;
    } else {
      restoredFeatures.hooks = restoration.hooksFeature === "true";
    }
    if (!restoration.featuresContainerPresent && Object.keys(restoredFeatures).length === 0) {
      delete restored.features;
    } else {
      restored.features = restoredFeatures;
    }
    writeOrRemoveConfiguration(this.paths.codexConfigPath, restored, restoration.filePresent, "toml");
    rmSync(this.paths.codexHookRelayPath, { force: true });
    this.clearRestoreState("codex");
    return result("codex", "restored", "provider_restored", undefined, {
      promptCaptureEnabled: restoration.logUserPrompt === "true",
      logsEnabled: restoration.exporterPresent === true,
      tracesEnabled: restoration.traceExporterPresent === true,
      toolDetailsEnabled: restoration.configuredToolHookCapture === true,
      toolContentEnabled: restoration.configuredToolHookCapture === true
    }, "managed_current");
  }

  private restoreCursor(otlpBaseUrl: string, authToken?: string): ProviderConfigurationV1 {
    const restoration = this.restoreState().cursor;
    if (!restoration) {
      return result("cursor", "not_managed", "provider_not_managed", undefined, undefined, "unmanaged");
    }
    const ownership = this.cursorStatus(otlpBaseUrl, authToken).ownershipState;
    const current = readJsonObject(this.paths.cursorHooksPath);
    const hookShape = current.ok
      ? cursorHookShape(current.value, this.paths.cursorHookRelayPath, otlpBaseUrl)
      : { lifecycleHooksConfigured: false, activityHooksConfigured: false, localTirionShape: false };
    const restoreReady = restoration.adoptedWithoutBaseline
      ? ownership === "managed_current" || ownership === "managed_stale_authority"
      : current.ok
        && hookShape.lifecycleHooksConfigured
        && (restoration.configuredToolHookCapture === true ? hookShape.activityHooksConfigured : true);
    if (!current.ok || !restoreReady) {
      return result("cursor", "conflict", "restore_conflict", undefined, undefined, "managed_drifted");
    }
    const restored = { ...current.value };
    const restoredHooks = removeCursorHooks(current.value);
    if (restoredHooks && Object.keys(restoredHooks).length > 0) {
      restored.hooks = restoredHooks;
    } else {
      delete restored.hooks;
    }
    if (!restoration.versionPresent) {
      delete restored.version;
    }
    writeOrRemoveConfiguration(this.paths.cursorHooksPath, restored, restoration.filePresent, "json");
    rmSync(this.paths.cursorHookRelayPath, { force: true });
    this.clearRestoreState("cursor");
    return result("cursor", "restored", "provider_restored", undefined, {
      promptCaptureEnabled: false,
      logsEnabled: false,
      tracesEnabled: false,
      toolDetailsEnabled: restoration.configuredToolHookCapture === true,
      toolContentEnabled: false
    }, "managed_current");
  }

  private recordRestoreState(provider: ConfigurableProvider, value: ProviderRestoreState): void {
      const state = this.restoreState();
      if (state[provider]) {
        const existing = state[provider]!;
        const legacyClaudeProfile = provider === "claude-code" && claudeRestoreProfile(existing) === 1;
        const upgradingClaudeTraceBatchDelay = provider === "claude-code" && claudeRestoreProfile(existing) < 3;
        const upgradingClaudeTraceExportInterval = provider === "claude-code" && claudeRestoreProfile(existing) < 4;
        state[provider] = {
          ...existing,
        configuredPromptCapture: value.configuredPromptCapture,
        configuredToolDetails: value.configuredToolDetails,
        configuredToolContent: value.configuredToolContent,
        configuredResponseContent: value.configuredResponseContent,
        configuredToolHookCapture: value.configuredToolHookCapture,
        configuredPromptHookCapture: value.configuredPromptHookCapture,
        ...(provider === "claude-code" ? {
          claudeProfileVersion: value.claudeProfileVersion,
          presentKeys: upgradingClaudeTraceBatchDelay || upgradingClaudeTraceExportInterval
            ? uniqueClaudeManagedKeys([
                ...(existing.presentKeys ?? []),
                ...(value.presentKeys ?? []).filter((key) =>
                  (upgradingClaudeTraceBatchDelay && key === "OTEL_BSP_SCHEDULE_DELAY")
                  || (upgradingClaudeTraceExportInterval && key === "OTEL_TRACES_EXPORT_INTERVAL"))
              ])
            : existing.presentKeys,
          claudeOwnedHookEvents: value.claudeOwnedHookEvents,
          claudePreservedHookEvents: uniqueClaudeHookEvents([
            ...claudePreservedHookEvents(existing),
            ...claudePreservedHookEvents(value)
          ]),
          previousTelemetryEnabled: existing.previousTelemetryEnabled
            ?? (legacyClaudeProfile
              ? claudeLegacyBooleanBaseline(existing, value, "CLAUDE_CODE_ENABLE_TELEMETRY", "previousTelemetryEnabled")
              : undefined),
          previousEnhancedTelemetry: existing.previousEnhancedTelemetry ?? value.previousEnhancedTelemetry,
          previousPromptCapture: existing.previousPromptCapture
            ?? (legacyClaudeProfile
              ? claudeLegacyBooleanBaseline(existing, value, "OTEL_LOG_USER_PROMPTS", "previousPromptCapture")
              : undefined),
          previousToolDetails: existing.previousToolDetails
            ?? (legacyClaudeProfile
              ? claudeLegacyBooleanBaseline(existing, value, "OTEL_LOG_TOOL_DETAILS", "previousToolDetails")
              : undefined),
          previousToolContent: existing.previousToolContent
            ?? (legacyClaudeProfile
              ? claudeLegacyBooleanBaseline(existing, value, "OTEL_LOG_TOOL_CONTENT", "previousToolContent")
              : undefined),
          previousAssistantResponses: existing.previousAssistantResponses ?? value.previousAssistantResponses,
          previousTraceBatchDelay: existing.previousTraceBatchDelay
            ?? (upgradingClaudeTraceBatchDelay ? value.previousTraceBatchDelay : undefined),
          previousTraceExportInterval: existing.previousTraceExportInterval
            ?? (upgradingClaudeTraceExportInterval ? value.previousTraceExportInterval : undefined),
          previousResponseContent: existing.previousResponseContent
            ?? (legacyClaudeProfile
              ? claudeLegacyBooleanBaseline(existing, value, "OTEL_LOG_RAW_API_BODIES", "previousResponseContent")
              : undefined)
        } : {})
      };
      writePrivateFileAtomic(this.paths.restoreStatePath, `${JSON.stringify(state)}\n`);
      return;
    }
    ensurePrivateDirectory(dirname(this.paths.restoreStatePath));
    writePrivateFileAtomic(this.paths.restoreStatePath, `${JSON.stringify({ ...state, [provider]: value })}\n`);
  }

  private clearRestoreState(provider: ConfigurableProvider): void {
    const state = this.restoreState();
    delete state[provider];
    if (Object.keys(state).length === 0) {
      rmSync(this.paths.restoreStatePath, { force: true });
      return;
    }
    writePrivateFileAtomic(this.paths.restoreStatePath, `${JSON.stringify(state)}\n`);
  }

  private restoreState(): RestoreState {
    if (!existsSync(this.paths.restoreStatePath)) {
      return {};
    }
    try {
      return parseRestoreState(JSON.parse(readFileSync(this.paths.restoreStatePath, "utf8")));
    } catch {
      throw new Error("source_configuration_unavailable");
    }
  }

  private claudeCodeStatus(otlpBaseUrl: string, authToken?: string): ProviderConfigurationStateV1 {
    const restoration = this.restoreState()["claude-code"];
    const current = readJsonObject(this.paths.claudeSettingsPath);
    if (!current.ok) {
      return state("claude-code", "conflict", ["invalid_existing_configuration"], undefined, "invalid");
    }
    const env = current.value.env == null ? {} : asStringRecord(current.value.env);
    if (!env) {
      return state("claude-code", "conflict", ["invalid_existing_configuration"], undefined, "invalid");
    }
    const desiredHeaders = authToken ? `Authorization=Bearer ${authToken}` : undefined;
    const logsExporters = exporterList(env.OTEL_LOGS_EXPORTER);
    const tracesExporters = exporterList(env.OTEL_TRACES_EXPORTER);
    const baseSnapshot = claudeState(env, otlpBaseUrl);
    const configuredHookShape = claudeHookShape(current.value.hooks, otlpBaseUrl, authToken);
    const hooksLocallyEnabled = claudeLocalHookPolicyAllows(
      current.value,
      `${otlpBaseUrl}/v1/provider-hooks/claude-code`
    );
    const hookShape = {
      lifecycleHooksConfigured: hooksLocallyEnabled && configuredHookShape.lifecycleHooksConfigured,
      toolHooksConfigured: hooksLocallyEnabled && configuredHookShape.toolHooksConfigured
    };
    const snapshot = {
      ...baseSnapshot,
      toolDetailsEnabled: baseSnapshot.toolDetailsEnabled && hookShape.toolHooksConfigured,
      toolContentEnabled: baseSnapshot.toolContentEnabled && hookShape.toolHooksConfigured
    };
    const traceBatchDelayValid = claudeTraceBatchDelayIsValid(env.OTEL_BSP_SCHEDULE_DELAY);
    const traceBatchDelayOptimized = env.OTEL_BSP_SCHEDULE_DELAY === CLAUDE_TRACE_BATCH_DELAY_MILLIS;
    const traceExportIntervalValid = claudeTraceExportIntervalIsValid(env.OTEL_TRACES_EXPORT_INTERVAL);
    const traceExportIntervalOptimized = env.OTEL_TRACES_EXPORT_INTERVAL === CLAUDE_TRACE_EXPORT_INTERVAL_MILLIS;
    const allowedLogsExporters = Boolean(logsExporters)
      && !logsExporters?.includes("none")
      && !logsExporters?.some((item) => !["console", "otlp"].includes(item));
    const allowedTracesExporters = Boolean(tracesExporters)
      && !tracesExporters?.includes("none")
      && !tracesExporters?.some((item) => !["console", "otlp"].includes(item));
    const transportMatches = (env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL == null || env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL === "http/json")
      && (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL == null || env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL === "http/json")
      && !foreignEndpoint(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, `${otlpBaseUrl}/v1/logs`)
      && !foreignEndpoint(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, `${otlpBaseUrl}/v1/traces`);
    const headersMatch = env.OTEL_EXPORTER_OTLP_HEADERS === desiredHeaders;
    const hasManagedFootprint = CLAUDE_MANAGED_KEYS.some((key) => env[key] != null);
    // A user-owned cadence preference alone carries no exporter endpoint or
    // authority. It is safe to adopt, preserve, and restore; do not classify it
    // as a foreign telemetry configuration merely because it has no Tirion auth
    // header yet.
    const hasExporterAuthorityFootprint = [
      "OTEL_LOGS_EXPORTER",
      "OTEL_TRACES_EXPORTER",
      "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS"
    ].some((key) => env[key] != null);
    const hasConflictShape = !allowedLogsExporters
      || !allowedTracesExporters
      || !transportMatches;
    const localTirionShape = allowedLogsExporters
      && allowedTracesExporters
      && transportMatches
      && hasManagedFootprint
      && env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === `${otlpBaseUrl}/v1/logs`
      && env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === `${otlpBaseUrl}/v1/traces`;
    if (!traceBatchDelayValid || !traceExportIntervalValid) {
      return state(
        "claude-code",
        "conflict",
        ["invalid_existing_configuration"],
        snapshot,
        restoration ? "managed_drifted" : localTirionShape ? "adoptable_local" : "unmanaged"
      );
    }
    if (!restoration && localTirionShape) {
      const reasonCodes: ProviderConfigurationStateV1["reasonCodes"] = ["local_tirion_exporter_unclaimed"];
      if (!headersMatch) {
        reasonCodes.unshift("stale_managed_agent_token");
        return state("claude-code", "conflict", reasonCodes, snapshot, "adoptable_local");
      }
      if (!snapshot.logsEnabled) reasonCodes.push("logs_missing");
      if (!snapshot.tracesEnabled) reasonCodes.push("traces_missing");
      if (!claudeEnhancedTelemetryEnabled(env)) reasonCodes.push("enhanced_traces_disabled");
      if (!hookShape.lifecycleHooksConfigured) reasonCodes.push("hooks_disabled");
      if (!snapshot.toolDetailsEnabled) reasonCodes.push("tool_details_disabled");
      if (!traceBatchDelayOptimized) reasonCodes.push("trace_batch_delay_unoptimized");
      if (!traceExportIntervalOptimized) reasonCodes.push("trace_export_interval_unoptimized");
      return state(
        "claude-code",
        reasonCodes.length === 1 ? "configured" : snapshot.logsEnabled ? "partial" : "not_configured",
        reasonCodes,
        snapshot,
        "adoptable_local"
      );
    }
    if (restoration && !hasManagedFootprint && !snapshot.logsEnabled && !snapshot.tracesEnabled) {
      return state(
        "claude-code",
        "conflict",
        ["managed_configuration_drifted"],
        snapshot,
        "managed_drifted"
      );
    }
    if (restoration && transportMatches && !headersMatch && (snapshot.logsEnabled || snapshot.tracesEnabled)) {
      return state(
        "claude-code",
        "conflict",
        ["stale_managed_agent_token"],
        snapshot,
        "managed_stale_authority"
      );
    }
    if (restoration && !hooksLocallyEnabled) {
      return state(
        "claude-code",
        "conflict",
        ["hooks_disabled"],
        snapshot,
        "managed_drifted"
      );
    }
    if (restoration && (hasConflictShape || hasManagedFootprint || snapshot.logsEnabled || snapshot.tracesEnabled || headersMatch)) {
      const profile = claudeRestoreProfile(restoration);
      const profileRequiresEnhancedTraces = profile >= 2;
      const cadenceReasonCodes: ProviderConfigurationStateV1["reasonCodes"] = [];
      if (profile >= 3 && !traceBatchDelayOptimized) {
        cadenceReasonCodes.push("trace_batch_delay_unoptimized");
      }
      if (profile >= 4 && !traceExportIntervalOptimized) {
        cadenceReasonCodes.push("trace_export_interval_unoptimized");
      }
      if (cadenceReasonCodes.length > 0) {
        return state(
          "claude-code",
          "conflict",
          cadenceReasonCodes,
          snapshot,
          "managed_drifted"
        );
      }
      if (
        hasConflictShape
        || !headersMatch
        || !snapshot.logsEnabled
        || (profileRequiresEnhancedTraces
          ? !snapshot.tracesEnabled
          : !claudeTraceTransportConfigured(env, otlpBaseUrl))
        || (profileRequiresEnhancedTraces && env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA !== "1")
        || !claudeHookEventsConfigured(
          current.value.hooks,
          otlpBaseUrl,
          authToken,
          claudeMeasurementHookEvents(claudeOwnedHookEvents(restoration))
        )
        || !claudeConfiguredContentGatesMatch(env, restoration)
      ) {
        return state(
          "claude-code",
          "conflict",
          ["managed_configuration_drifted"],
          snapshot,
          "managed_drifted"
        );
      }
    }
    if (hasConflictShape || (!headersMatch && hasExporterAuthorityFootprint)) {
      return state(
        "claude-code",
        "conflict",
        [headersMatch ? "foreign_exporter_present" : "existing_exporter_conflict"],
        snapshot,
        headersMatch ? "foreign_managed" : "foreign_managed"
      );
    }
    const reasonCodes: ProviderConfigurationStateV1["reasonCodes"] = [];
    if (!snapshot.logsEnabled) reasonCodes.push("logs_missing");
    if (!snapshot.tracesEnabled) reasonCodes.push("traces_missing");
    if (!claudeEnhancedTelemetryEnabled(env)) reasonCodes.push("enhanced_traces_disabled");
    if (!hookShape.lifecycleHooksConfigured) reasonCodes.push("hooks_disabled");
    if (!snapshot.toolDetailsEnabled) reasonCodes.push("tool_details_disabled");
    if (!traceBatchDelayOptimized) reasonCodes.push("trace_batch_delay_unoptimized");
    if (!traceExportIntervalOptimized) reasonCodes.push("trace_export_interval_unoptimized");
    return state(
      "claude-code",
      reasonCodes.length === 0 ? "configured" : snapshot.logsEnabled ? "partial" : "not_configured",
      reasonCodes,
      snapshot,
      restoration ? "managed_current" : "unmanaged"
    );
  }

  private codexStatus(otlpBaseUrl: string, authToken?: string): ProviderConfigurationStateV1 {
    const restoration = this.restoreState().codex;
    const current = readToml(this.paths.codexConfigPath);
    if (!current.ok) {
      return state("codex", "conflict", ["invalid_existing_configuration"], undefined, "invalid");
    }
    const otel = current.value.otel == null ? {} : asTomlTable(current.value.otel);
    const features = current.value.features == null ? {} : asTomlTable(current.value.features);
    if (!otel || !features) {
      return state("codex", "conflict", ["invalid_existing_configuration"], undefined, "invalid");
    }
    const desiredExporter = codexDesiredExporter(otlpBaseUrl, authToken);
    const desiredTraceExporter = codexDesiredTraceExporter(otlpBaseUrl, authToken);
    const desiredMetricsExporter = codexDesiredMetricsExporter(otlpBaseUrl, authToken);
    const hookShape = codexHookShape(current.value.hooks, this.paths.codexHookRelayPath, otlpBaseUrl, authToken);
    const snapshot = {
      promptCaptureEnabled: otel.log_user_prompt === true,
      logsEnabled: JSON.stringify(otel.exporter) === JSON.stringify(desiredExporter),
      tracesEnabled: JSON.stringify(otel.trace_exporter) === JSON.stringify(desiredTraceExporter)
        && JSON.stringify(otel.metrics_exporter) === JSON.stringify(desiredMetricsExporter),
      toolDetailsEnabled: features.hooks === true && hookShape.toolHooksConfigured,
      toolContentEnabled: features.hooks === true && hookShape.toolHooksConfigured,
      responseContentEnabled: false,
    };
    const exporterShape = codexExporterShape(otel.exporter, `${otlpBaseUrl}/v1/logs`, authToken);
    const traceExporterShape = codexExporterShape(otel.trace_exporter, `${otlpBaseUrl}/v1/traces`, authToken);
    const metricsExporterShape = codexExporterShape(otel.metrics_exporter, `${otlpBaseUrl}/v1/metrics`, authToken);
    const localTirionShape = endpointMatches(otel.exporter, `${otlpBaseUrl}/v1/logs`)
      && endpointMatches(otel.trace_exporter, `${otlpBaseUrl}/v1/traces`)
      && (otel.metrics_exporter == null || endpointMatches(otel.metrics_exporter, `${otlpBaseUrl}/v1/metrics`));
    if (!restoration && (localTirionShape || isStaleLocalTirionExporterPair(otel.exporter, otel.trace_exporter, otel.metrics_exporter))) {
      const reasonCodes: ProviderConfigurationStateV1["reasonCodes"] = ["local_tirion_exporter_unclaimed"];
      if (!exporterShape.matchesHeaders || !traceExporterShape.matchesHeaders || (otel.metrics_exporter != null && !metricsExporterShape.matchesHeaders)) {
        reasonCodes.unshift("stale_managed_agent_token");
        return state("codex", "conflict", reasonCodes, snapshot, "adoptable_local");
      }
      if (!snapshot.logsEnabled) reasonCodes.push("logs_missing");
      if (!snapshot.tracesEnabled) reasonCodes.push("traces_missing");
      if (!snapshot.toolDetailsEnabled) reasonCodes.push("tool_details_disabled");
      if (!snapshot.toolContentEnabled) reasonCodes.push("tool_content_disabled");
      return state(
        "codex",
        reasonCodes.length === 1 ? "configured" : snapshot.logsEnabled ? "partial" : "not_configured",
        reasonCodes,
        snapshot,
        "adoptable_local"
      );
    }
    if (restoration && otel.exporter == null && otel.trace_exporter == null && otel.metrics_exporter == null && otel.log_user_prompt == null) {
      return state(
        "codex",
        "conflict",
        ["managed_configuration_drifted"],
        snapshot,
        "managed_drifted"
      );
    }
    if (restoration && exporterShape.matchesEndpoint && traceExporterShape.matchesEndpoint && metricsExporterShape.matchesEndpoint && (!exporterShape.matchesHeaders || !traceExporterShape.matchesHeaders || !metricsExporterShape.matchesHeaders)) {
      return state(
        "codex",
        "conflict",
        ["stale_managed_agent_token"],
        snapshot,
        "managed_stale_authority"
      );
    }
    if (restoration && (
      otel.exporter != null
      || otel.trace_exporter != null
      || otel.metrics_exporter != null
      || otel.log_user_prompt != null
    ) && (
      !snapshot.logsEnabled
      || !snapshot.tracesEnabled
      || snapshot.promptCaptureEnabled !== (restoration.configuredPromptCapture === true)
      || features.hooks !== true
      || snapshot.toolDetailsEnabled !== (restoration.configuredToolHookCapture === true)
      || (restoration.configuredPromptHookCapture === true && !hookShape.promptHooksConfigured)
    )) {
      return state(
        "codex",
        "conflict",
        ["managed_configuration_drifted"],
        snapshot,
        "managed_drifted"
      );
    }
    if (
      (otel.exporter != null && !snapshot.logsEnabled)
      || (otel.trace_exporter != null && !snapshot.tracesEnabled)
      || (otel.metrics_exporter != null && !snapshot.tracesEnabled)
    ) {
      return state("codex", "conflict", ["foreign_exporter_present"], snapshot, "foreign_managed");
    }
    const reasonCodes: ProviderConfigurationStateV1["reasonCodes"] = [];
    if (!snapshot.logsEnabled) reasonCodes.push("logs_missing");
    if (!snapshot.tracesEnabled) reasonCodes.push("traces_missing");
    if (!snapshot.toolDetailsEnabled) reasonCodes.push("tool_details_disabled");
    if (!snapshot.toolContentEnabled) reasonCodes.push("tool_content_disabled");
    return state(
      "codex",
      reasonCodes.length === 0 ? "configured" : snapshot.logsEnabled ? "partial" : "not_configured",
      reasonCodes,
      snapshot,
      restoration ? "managed_current" : "unmanaged"
    );
  }

  private cursorStatus(otlpBaseUrl: string, authToken?: string): ProviderConfigurationStateV1 {
    const restoration = this.restoreState().cursor;
    const current = readJsonObject(this.paths.cursorHooksPath);
    if (!current.ok || (current.value.hooks != null && !isRecord(current.value.hooks))) {
      return state("cursor", "conflict", ["invalid_existing_configuration"], undefined, "invalid");
    }
    const hookShape = cursorHookShape(current.value, this.paths.cursorHookRelayPath, otlpBaseUrl);
    const localTirionShape = hookShape.localTirionShape || isStaleCursorHookShape(current.value, this.paths.cursorHookRelayPath);
    const snapshot = {
      promptCaptureEnabled: false,
      logsEnabled: hookShape.lifecycleHooksConfigured,
      tracesEnabled: hookShape.lifecycleHooksConfigured,
      toolDetailsEnabled: hookShape.activityHooksConfigured,
      toolContentEnabled: false,
      responseContentEnabled: false
    };
    const hasHeaderMismatch = localTirionShape && !cursorManagedHookCommands(current.value, this.paths.cursorHookRelayPath, `${otlpBaseUrl}/v1/provider-hooks/cursor`, authToken)
      .every((command) => command.matchesAuth);
    if (!restoration && localTirionShape) {
      const reasonCodes: ProviderConfigurationStateV1["reasonCodes"] = ["local_tirion_exporter_unclaimed"];
      if (hasHeaderMismatch) {
        reasonCodes.unshift("stale_managed_agent_token");
        return state("cursor", "conflict", reasonCodes, snapshot, "adoptable_local");
      }
      if (!snapshot.logsEnabled) reasonCodes.push("logs_missing");
      if (!snapshot.tracesEnabled) reasonCodes.push("traces_missing");
      if (!snapshot.toolDetailsEnabled) reasonCodes.push("tool_details_disabled");
      return state(
        "cursor",
        reasonCodes.length === 1 ? "configured" : snapshot.logsEnabled ? "partial" : "not_configured",
        reasonCodes,
        snapshot,
        "adoptable_local"
      );
    }
    if (restoration && !hookShape.lifecycleHooksConfigured && !hookShape.activityHooksConfigured) {
      return state(
        "cursor",
        "conflict",
        ["managed_configuration_drifted"],
        snapshot,
        "managed_drifted"
      );
    }
    if (restoration && localTirionShape && hasHeaderMismatch) {
      return state(
        "cursor",
        "conflict",
        ["stale_managed_agent_token"],
        snapshot,
        "managed_stale_authority"
      );
    }
    if (restoration && (
      !hookShape.lifecycleHooksConfigured
      || snapshot.toolDetailsEnabled !== (restoration.configuredToolHookCapture === true)
    )) {
      return state(
        "cursor",
        "conflict",
        ["managed_configuration_drifted"],
        snapshot,
        "managed_drifted"
      );
    }
    const reasonCodes: ProviderConfigurationStateV1["reasonCodes"] = [];
    if (!snapshot.logsEnabled) reasonCodes.push("logs_missing");
    if (!snapshot.tracesEnabled) reasonCodes.push("traces_missing");
    if (!snapshot.toolDetailsEnabled) reasonCodes.push("tool_details_disabled");
    return state(
      "cursor",
      reasonCodes.length === 0 ? "configured" : snapshot.logsEnabled ? "partial" : "not_configured",
      reasonCodes,
      snapshot,
      restoration ? "managed_current" : "unmanaged"
    );
  }
}

const CLAUDE_MANAGED_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
  "OTEL_LOGS_EXPORTER",
  "OTEL_TRACES_EXPORTER",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_TRACES_EXPORT_INTERVAL",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_RAW_API_BODIES"
] as const;

type ClaudeManagedKey = typeof CLAUDE_MANAGED_KEYS[number];
type ClaudeBooleanRestoreValue = "absent" | "0" | "1";
type ClaudeExporterRestoreValue = "absent" | "console" | "otlp" | "console,otlp" | "otlp,console";
type ClaudeTraceBatchDelayRestoreValue = "absent" | string;
type ClaudeTraceExportIntervalRestoreValue = "absent" | string;
type ClaudeRestoreProfileVersion = 1 | 2 | 3 | 4 | 5;
type ClaudeManagedHookEvent =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "StopFailure"
  | "SessionEnd"
  | "SubagentStart"
  | "SubagentStop";

const CLAUDE_TRACE_BATCH_DELAY_MILLIS = "250";
// Claude Code documents this provider-native trace export cadence separately
// from the generic OpenTelemetry BatchSpanProcessor delay. Keep both at the
// same safe cadence because older Claude builds can still expose the generic
// processor path, but readiness must include the native control.
const CLAUDE_TRACE_EXPORT_INTERVAL_MILLIS = "250";
const CLAUDE_CURRENT_RESTORE_PROFILE: ClaudeRestoreProfileVersion = 5;
const CLAUDE_PRE_TRACE_EXPORT_INTERVAL_MANAGED_KEYS = CLAUDE_MANAGED_KEYS.filter((key) =>
  key !== "OTEL_TRACES_EXPORT_INTERVAL"
);
const CLAUDE_PRE_BATCH_DELAY_MANAGED_KEYS = CLAUDE_PRE_TRACE_EXPORT_INTERVAL_MANAGED_KEYS.filter((key) =>
  key !== "OTEL_BSP_SCHEDULE_DELAY"
);
const CLAUDE_LEGACY_MANAGED_KEYS = CLAUDE_PRE_BATCH_DELAY_MANAGED_KEYS.filter((key) =>
  key !== "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"
  && key !== "OTEL_LOG_ASSISTANT_RESPONSES"
);
const CLAUDE_LEGACY_LIFECYCLE_HOOK_EVENTS: ClaudeManagedHookEvent[] = [
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop"
];
// Profiles through v4 predate the explicit Claude SessionEnd hook. Keep this
// list separate so a malformed historical restore record without its owned
// hook list cannot cause restore to remove a SessionEnd handler it never
// installed.
const CLAUDE_PRE_SESSION_END_LIFECYCLE_HOOK_EVENTS: ClaudeManagedHookEvent[] = [
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop"
];
const CLAUDE_DIAGNOSTIC_HOOK_EVENTS: ClaudeManagedHookEvent[] = ["SessionEnd"];
const CLAUDE_LIFECYCLE_HOOK_EVENTS: ClaudeManagedHookEvent[] = [
  ...CLAUDE_PRE_SESSION_END_LIFECYCLE_HOOK_EVENTS,
  ...CLAUDE_DIAGNOSTIC_HOOK_EVENTS
];
const CLAUDE_TOOL_HOOK_EVENTS: ClaudeManagedHookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure"
];
const CLAUDE_ALL_HOOK_EVENTS: ClaudeManagedHookEvent[] = [
  ...CLAUDE_LIFECYCLE_HOOK_EVENTS,
  ...CLAUDE_TOOL_HOOK_EVENTS
];

type ProviderRestoreState = {
  filePresent: boolean;
  containerPresent: boolean;
  adoptedWithoutBaseline?: boolean;
  claudeProfileVersion?: ClaudeRestoreProfileVersion;
  claudeOwnedHookEvents?: ClaudeManagedHookEvent[];
  claudePreservedHookEvents?: ClaudeManagedHookEvent[];
  presentKeys?: ClaudeManagedKey[];
  previousExporter?: ClaudeExporterRestoreValue;
  previousTraceExporter?: ClaudeExporterRestoreValue;
  previousTraceBatchDelay?: ClaudeTraceBatchDelayRestoreValue;
  previousTraceExportInterval?: ClaudeTraceExportIntervalRestoreValue;
  exporterPresent?: boolean;
  traceExporterPresent?: boolean;
  metricsExporterPresent?: boolean;
  logUserPrompt?: "absent" | "false" | "true";
  configuredPromptCapture?: boolean;
  configuredToolDetails?: boolean;
  configuredToolContent?: boolean;
  configuredResponseContent?: boolean;
  configuredToolHookCapture?: boolean;
  configuredPromptHookCapture?: boolean;
  previousTelemetryEnabled?: ClaudeBooleanRestoreValue;
  previousEnhancedTelemetry?: ClaudeBooleanRestoreValue;
  previousPromptCapture?: ClaudeBooleanRestoreValue;
  previousToolDetails?: ClaudeBooleanRestoreValue;
  previousToolContent?: ClaudeBooleanRestoreValue;
  previousAssistantResponses?: ClaudeBooleanRestoreValue;
  previousResponseContent?: ClaudeBooleanRestoreValue;
  featuresContainerPresent?: boolean;
  hooksFeature?: "absent" | "false" | "true";
  versionPresent?: boolean;
};

type RestoreState = Partial<Record<ConfigurableProvider, ProviderRestoreState>>;

function claudeBooleanRestoreValue(value: string | undefined): ClaudeBooleanRestoreValue {
  return value === "0" || value === "1" ? value : "absent";
}

function claudeExporterRestoreValue(value: string | undefined): ClaudeExporterRestoreValue {
  return value === "console"
    || value === "otlp"
    || value === "console,otlp"
    || value === "otlp,console"
    ? value
    : "absent";
}

function claudeTraceBatchDelayIsValid(value: string | undefined): boolean {
  return value == null || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)));
}

function claudeTraceBatchDelayRestoreValue(value: string | undefined): ClaudeTraceBatchDelayRestoreValue {
  return value != null && claudeTraceBatchDelayIsValid(value) ? value : "absent";
}

function claudeTraceExportIntervalIsValid(value: string | undefined): boolean {
  return value == null || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)));
}

function claudeTraceExportIntervalRestoreValue(value: string | undefined): ClaudeTraceExportIntervalRestoreValue {
  return value != null && claudeTraceExportIntervalIsValid(value) ? value : "absent";
}

function claudeRestoreProfile(restoration: ProviderRestoreState): ClaudeRestoreProfileVersion {
  if (restoration.claudeProfileVersion != null) return restoration.claudeProfileVersion;
  return restoration.previousTraceExportInterval != null
    ? 4
    : restoration.previousTraceBatchDelay != null
    ? 3
    : restoration.previousEnhancedTelemetry != null
    || restoration.previousAssistantResponses != null
    || restoration.claudeOwnedHookEvents?.includes("StopFailure") === true
    ? 2
    : 1;
}

function claudeOwnedKeys(restoration: ProviderRestoreState): readonly ClaudeManagedKey[] {
  const profile = claudeRestoreProfile(restoration);
  return profile === 1
    ? CLAUDE_LEGACY_MANAGED_KEYS
    : profile === 2
      ? CLAUDE_PRE_BATCH_DELAY_MANAGED_KEYS
      : profile === 3
        ? CLAUDE_PRE_TRACE_EXPORT_INTERVAL_MANAGED_KEYS
        : CLAUDE_MANAGED_KEYS;
}

function uniqueClaudeManagedKeys(keys: readonly ClaudeManagedKey[]): ClaudeManagedKey[] {
  return CLAUDE_MANAGED_KEYS.filter((key) => keys.includes(key));
}

function claudeConfiguredHookEvents(captureTools: boolean): ClaudeManagedHookEvent[] {
  return captureTools
    ? [...CLAUDE_LIFECYCLE_HOOK_EVENTS, ...CLAUDE_TOOL_HOOK_EVENTS]
    : [...CLAUDE_LIFECYCLE_HOOK_EVENTS];
}

function claudeOwnedHookEvents(restoration: ProviderRestoreState): ClaudeManagedHookEvent[] {
  if (restoration.claudeOwnedHookEvents) return [...restoration.claudeOwnedHookEvents];
  const profile = claudeRestoreProfile(restoration);
  const lifecycle = profile === 1
    ? CLAUDE_LEGACY_LIFECYCLE_HOOK_EVENTS
    : profile <= 4
      ? CLAUDE_PRE_SESSION_END_LIFECYCLE_HOOK_EVENTS
      : CLAUDE_LIFECYCLE_HOOK_EVENTS;
  return restoration.configuredToolHookCapture === false
    ? [...lifecycle]
    : [...lifecycle, ...CLAUDE_TOOL_HOOK_EVENTS];
}

function claudeMeasurementHookEvents(events: readonly ClaudeManagedHookEvent[]): ClaudeManagedHookEvent[] {
  return events.filter((eventName) => !CLAUDE_DIAGNOSTIC_HOOK_EVENTS.includes(eventName));
}

function claudePreservedHookEvents(restoration: ProviderRestoreState | undefined): ClaudeManagedHookEvent[] {
  return restoration?.claudePreservedHookEvents ? [...restoration.claudePreservedHookEvents] : [];
}

type ClaudeBooleanRestoreField =
  | "previousTelemetryEnabled"
  | "previousPromptCapture"
  | "previousToolDetails"
  | "previousToolContent"
  | "previousResponseContent";

function claudeLegacyBooleanBaseline(
  existing: ProviderRestoreState,
  current: ProviderRestoreState,
  key: ClaudeManagedKey,
  field: ClaudeBooleanRestoreField
): ClaudeBooleanRestoreValue {
  return existing.presentKeys?.includes(key) === true ? current[field] ?? "absent" : "absent";
}

function claudePreviousBooleanValue(
  restoration: ProviderRestoreState,
  key: ClaudeManagedKey
): ClaudeBooleanRestoreValue | undefined {
  if (key === "CLAUDE_CODE_ENABLE_TELEMETRY") return restoration.previousTelemetryEnabled;
  if (key === "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA") return restoration.previousEnhancedTelemetry;
  if (key === "OTEL_LOG_USER_PROMPTS") return restoration.previousPromptCapture;
  if (key === "OTEL_LOG_TOOL_DETAILS") return restoration.previousToolDetails;
  if (key === "OTEL_LOG_TOOL_CONTENT") return restoration.previousToolContent;
  if (key === "OTEL_LOG_ASSISTANT_RESPONSES") return restoration.previousAssistantResponses;
  if (key === "OTEL_LOG_RAW_API_BODIES") return restoration.previousResponseContent;
  return undefined;
}

function claudePreviousManagedValue(
  restoration: ProviderRestoreState,
  key: ClaudeManagedKey
): ClaudeBooleanRestoreValue
  | ClaudeExporterRestoreValue
  | ClaudeTraceBatchDelayRestoreValue
  | ClaudeTraceExportIntervalRestoreValue
  | undefined {
  if (key === "OTEL_LOGS_EXPORTER") return restoration.previousExporter;
  if (key === "OTEL_TRACES_EXPORTER") return restoration.previousTraceExporter;
  if (key === "OTEL_BSP_SCHEDULE_DELAY") return restoration.previousTraceBatchDelay;
  if (key === "OTEL_TRACES_EXPORT_INTERVAL") return restoration.previousTraceExportInterval;
  return claudePreviousBooleanValue(restoration, key);
}

function claudeConfiguredExporterValue(previous: ClaudeExporterRestoreValue | undefined): string {
  if (previous === "console") return "console,otlp";
  if (previous === "otlp" || previous === "console,otlp" || previous === "otlp,console") return previous;
  return "otlp";
}

function claudeDesiredValues(
  otlpBaseUrl: string,
  authToken: string | undefined,
  previousExporter: ProviderRestoreState["previousExporter"],
  previousTraceExporter: ProviderRestoreState["previousTraceExporter"],
  capturePrompts: boolean,
  captureToolDetails: boolean,
  captureToolContent: boolean,
  captureResponseContent: boolean
): Record<ClaudeManagedKey, string | undefined> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_LOGS_EXPORTER: claudeConfiguredExporterValue(previousExporter),
    OTEL_TRACES_EXPORTER: claudeConfiguredExporterValue(previousTraceExporter),
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${otlpBaseUrl}/v1/logs`,
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${otlpBaseUrl}/v1/traces`,
    OTEL_EXPORTER_OTLP_HEADERS: authToken ? `Authorization=Bearer ${authToken}` : undefined,
    OTEL_BSP_SCHEDULE_DELAY: CLAUDE_TRACE_BATCH_DELAY_MILLIS,
    OTEL_TRACES_EXPORT_INTERVAL: CLAUDE_TRACE_EXPORT_INTERVAL_MILLIS,
    OTEL_LOG_USER_PROMPTS: capturePrompts ? "1" : "0",
    OTEL_LOG_TOOL_DETAILS: captureToolDetails ? "1" : "0",
    OTEL_LOG_TOOL_CONTENT: captureToolContent ? "1" : "0",
    OTEL_LOG_ASSISTANT_RESPONSES: captureResponseContent ? "1" : "0",
    OTEL_LOG_RAW_API_BODIES: captureResponseContent ? "1" : "0"
  };
}

function codexDesiredExporter(otlpBaseUrl: string, authToken?: string): TomlTable {
  return {
    "otlp-http": {
      endpoint: `${otlpBaseUrl}/v1/logs`,
      protocol: "json",
      ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {})
    }
  };
}

function codexDesiredTraceExporter(otlpBaseUrl: string, authToken?: string): TomlTable {
  return {
    "otlp-http": {
      endpoint: `${otlpBaseUrl}/v1/traces`,
      protocol: "json",
      ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {})
    }
  };
}

function codexDesiredMetricsExporter(otlpBaseUrl: string, authToken?: string): TomlTable {
  return {
    "otlp-http": {
      endpoint: `${otlpBaseUrl}/v1/metrics`,
      protocol: "json",
      ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {})
    }
  };
}

function codexHooksFeatureState(value: unknown): "absent" | "false" | "true" {
  return value === true ? "true" : value === false ? "false" : "absent";
}

function writeOrRemoveConfiguration(
  path: string,
  value: Record<string, unknown> | TomlTable,
  filePresent: boolean,
  format: "json" | "toml"
): void {
  if (!filePresent && Object.keys(value).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const content = format === "json" ? `${JSON.stringify(value, null, 2)}\n` : stringify(value as TomlTable);
  writePrivateFileAtomic(path, content);
}

function parseRestoreState(value: unknown): RestoreState {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "claude-code" && key !== "codex" && key !== "cursor")) {
    throw new Error("invalid restore state");
  }
  const state: RestoreState = {};
  for (const provider of ["claude-code", "codex", "cursor"] as const) {
    const record = value[provider];
    if (record == null) {
      continue;
    }
    if (!isRecord(record) || typeof record.filePresent !== "boolean" || typeof record.containerPresent !== "boolean") {
      throw new Error("invalid restore state");
    }
    if (record.adoptedWithoutBaseline != null && typeof record.adoptedWithoutBaseline !== "boolean") {
      throw new Error("invalid restore state");
    }
    if (
      record.claudeProfileVersion != null
      && record.claudeProfileVersion !== 1
      && record.claudeProfileVersion !== 2
      && record.claudeProfileVersion !== 3
      && record.claudeProfileVersion !== 4
      && record.claudeProfileVersion !== 5
    ) {
      throw new Error("invalid restore state");
    }
    for (const key of ["claudeOwnedHookEvents", "claudePreservedHookEvents"] as const) {
      if (
        record[key] != null
        && (!Array.isArray(record[key]) || record[key].some((eventName) => !CLAUDE_ALL_HOOK_EVENTS.includes(eventName as ClaudeManagedHookEvent)))
      ) {
        throw new Error("invalid restore state");
      }
    }
    if (record.versionPresent != null && typeof record.versionPresent !== "boolean") {
      throw new Error("invalid restore state");
    }
    if (record.featuresContainerPresent != null && typeof record.featuresContainerPresent !== "boolean") {
      throw new Error("invalid restore state");
    }
    if (record.hooksFeature != null && !["absent", "false", "true"].includes(record.hooksFeature as string)) {
      throw new Error("invalid restore state");
    }
    if (record.configuredPromptCapture != null && typeof record.configuredPromptCapture !== "boolean") {
      throw new Error("invalid restore state");
    }
    for (const key of ["configuredToolDetails", "configuredToolContent", "configuredResponseContent"] as const) {
      if (record[key] != null && typeof record[key] !== "boolean") {
        throw new Error("invalid restore state");
      }
    }
    for (const key of ["configuredToolHookCapture", "configuredPromptHookCapture"] as const) {
      if (record[key] != null && typeof record[key] !== "boolean") {
        throw new Error("invalid restore state");
      }
    }
    for (const key of [
      "previousTelemetryEnabled",
      "previousEnhancedTelemetry",
      "previousPromptCapture",
      "previousToolDetails",
      "previousToolContent",
      "previousAssistantResponses",
      "previousResponseContent"
    ] as const) {
      if (record[key] != null && !["absent", "0", "1"].includes(record[key] as string)) {
        throw new Error("invalid restore state");
      }
    }
    if (provider === "claude-code") {
      const explicitClaudeProfile = record.claudeProfileVersion as ClaudeRestoreProfileVersion | undefined;
      const effectiveClaudeProfile = explicitClaudeProfile
        ?? (record.previousTraceExportInterval != null
          ? 4
          : record.previousTraceBatchDelay != null
            ? 3
            : record.previousEnhancedTelemetry != null
              || record.previousAssistantResponses != null
              || (record.claudeOwnedHookEvents as unknown[])?.includes("StopFailure") === true
              ? 2
              : 1);
      if (
        !Array.isArray(record.presentKeys)
        || record.presentKeys.some((key) => !CLAUDE_MANAGED_KEYS.includes(key as ClaudeManagedKey))
        || !["absent", "console", "otlp", "console,otlp", "otlp,console"].includes(record.previousExporter as string)
        || !["absent", "console", "otlp", "console,otlp", "otlp,console"].includes((record.previousTraceExporter ?? "absent") as string)
        || (record.previousTraceBatchDelay != null
          && record.previousTraceBatchDelay !== "absent"
          && (typeof record.previousTraceBatchDelay !== "string" || !claudeTraceBatchDelayIsValid(record.previousTraceBatchDelay)))
        || (record.previousTraceExportInterval != null
          && record.previousTraceExportInterval !== "absent"
          && (typeof record.previousTraceExportInterval !== "string" || !claudeTraceExportIntervalIsValid(record.previousTraceExportInterval)))
        || (explicitClaudeProfile != null
          && explicitClaudeProfile < 4
          && record.previousTraceExportInterval != null)
        || (effectiveClaudeProfile >= 3
          && record.previousTraceBatchDelay == null)
        || (effectiveClaudeProfile >= 4 && record.previousTraceExportInterval == null)
      ) {
        throw new Error("invalid restore state");
      }
      state[provider] = {
        filePresent: record.filePresent,
        containerPresent: record.containerPresent,
        adoptedWithoutBaseline: record.adoptedWithoutBaseline === true,
        claudeProfileVersion: record.claudeProfileVersion as ClaudeRestoreProfileVersion | undefined,
        claudeOwnedHookEvents: record.claudeOwnedHookEvents as ClaudeManagedHookEvent[] | undefined,
        claudePreservedHookEvents: record.claudePreservedHookEvents as ClaudeManagedHookEvent[] | undefined,
        presentKeys: record.presentKeys as ClaudeManagedKey[],
        previousExporter: record.previousExporter as ClaudeExporterRestoreValue,
        previousTraceExporter: (record.previousTraceExporter ?? "absent") as ClaudeExporterRestoreValue,
        previousTraceBatchDelay: record.previousTraceBatchDelay as ClaudeTraceBatchDelayRestoreValue | undefined,
        previousTraceExportInterval: record.previousTraceExportInterval as ClaudeTraceExportIntervalRestoreValue | undefined,
        configuredPromptCapture: record.configuredPromptCapture === true,
        configuredToolDetails: record.configuredToolDetails !== false,
        configuredToolContent: record.configuredToolContent === true,
        configuredResponseContent: record.configuredResponseContent === true,
        configuredToolHookCapture: record.configuredToolHookCapture !== false,
        previousTelemetryEnabled: record.previousTelemetryEnabled as ClaudeBooleanRestoreValue | undefined,
        previousEnhancedTelemetry: record.previousEnhancedTelemetry as ClaudeBooleanRestoreValue | undefined,
        previousPromptCapture: record.previousPromptCapture as ClaudeBooleanRestoreValue | undefined,
        previousToolDetails: record.previousToolDetails as ClaudeBooleanRestoreValue | undefined,
        previousToolContent: record.previousToolContent as ClaudeBooleanRestoreValue | undefined,
        previousAssistantResponses: record.previousAssistantResponses as ClaudeBooleanRestoreValue | undefined,
        previousResponseContent: record.previousResponseContent as ClaudeBooleanRestoreValue | undefined
      };
    } else if (provider === "codex") {
      if (
        !["absent", "false", "true"].includes(record.logUserPrompt as string)
        || (record.exporterPresent != null && typeof record.exporterPresent !== "boolean")
        || (record.traceExporterPresent != null && typeof record.traceExporterPresent !== "boolean")
        || (record.metricsExporterPresent != null && typeof record.metricsExporterPresent !== "boolean")
      ) {
        throw new Error("invalid restore state");
      }
      state[provider] = {
        filePresent: record.filePresent,
        containerPresent: record.containerPresent,
        adoptedWithoutBaseline: record.adoptedWithoutBaseline === true,
        exporterPresent: record.exporterPresent === true,
        traceExporterPresent: record.traceExporterPresent === true,
        metricsExporterPresent: record.metricsExporterPresent === true,
        logUserPrompt: record.logUserPrompt as "absent" | "false" | "true",
        configuredPromptCapture: record.configuredPromptCapture === true,
        configuredToolHookCapture: record.configuredToolHookCapture !== false,
        configuredPromptHookCapture: record.configuredPromptHookCapture === true,
        featuresContainerPresent: record.featuresContainerPresent === true,
        hooksFeature: (record.hooksFeature ?? "absent") as "absent" | "false" | "true"
      };
    } else {
      state[provider] = {
        filePresent: record.filePresent,
        containerPresent: record.containerPresent,
        adoptedWithoutBaseline: record.adoptedWithoutBaseline === true,
        versionPresent: record.versionPresent === true,
        configuredPromptCapture: false,
        configuredToolHookCapture: record.configuredToolHookCapture === true
      };
    }
  }
  return state;
}

function result(
  provider: ConfigurableProvider,
  status: ProviderConfigurationV1["status"],
  reason: ProviderConfigurationV1["reasonCodes"][number],
  claudeEnv?: Partial<Record<ClaudeManagedKey, string | undefined>>,
  overrides?: Partial<ConfigurationSnapshot>,
  ownershipState: ProviderConfigurationOwnershipState = status === "unavailable"
    ? "unavailable"
    : status === "not_managed"
      ? "unmanaged"
      : status === "conflict"
        ? "foreign_managed"
        : "managed_current"
): ProviderConfigurationV1 {
  const snapshot = claudeEnv
    ? {
        promptCaptureEnabled: claudeEnv.OTEL_LOG_USER_PROMPTS === "1",
        logsEnabled: claudeEnv.CLAUDE_CODE_ENABLE_TELEMETRY === "1",
        tracesEnabled: claudeEnv.CLAUDE_CODE_ENABLE_TELEMETRY === "1"
          && claudeEnv.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA === "1",
        toolDetailsEnabled: claudeEnv.OTEL_LOG_TOOL_DETAILS === "1",
        toolContentEnabled: claudeEnv.OTEL_LOG_TOOL_CONTENT === "1",
        responseContentEnabled: claudeAssistantResponsesEnabled(claudeEnv)
          || claudeEnv.OTEL_LOG_RAW_API_BODIES === "1"
      }
    : {
        promptCaptureEnabled: overrides?.promptCaptureEnabled ?? false,
        logsEnabled: overrides?.logsEnabled ?? false,
        tracesEnabled: overrides?.tracesEnabled ?? false,
        toolDetailsEnabled: overrides?.toolDetailsEnabled ?? false,
        toolContentEnabled: overrides?.toolContentEnabled ?? false,
        responseContentEnabled: overrides?.responseContentEnabled ?? false
      };
  const capability = capabilitySnapshot(provider);
  return {
    schemaVersion: 1,
    provider,
    status,
    profileVersion: provider === "claude-code"
      ? "claude-code-otel-logs-traces-v2"
      : provider === "codex" ? "codex-otel-logs-traces-v1" : "cursor-hooks-v1",
    ownershipState,
    promptCaptureEnabled: snapshot.promptCaptureEnabled,
    logsEnabled: snapshot.logsEnabled,
    tracesEnabled: snapshot.tracesEnabled,
    toolDetailsSupported: capability.toolDetailsSupported,
    toolDetailsEnabled: snapshot.toolDetailsEnabled,
    toolContentSupported: capability.toolContentSupported,
    toolContentEnabled: snapshot.toolContentEnabled,
    responseContentSupported: capability.responseContentSupported,
    responseContentEnabled: snapshot.responseContentEnabled,
    restartRequired: status === "configured" || status === "restored",
    reasonCodes: [reason]
  };
}

function state(
  provider: ConfigurableProvider,
  configurationState: ProviderConfigurationStateV1["configurationState"],
  reasonCodes: ProviderConfigurationStateV1["reasonCodes"],
  snapshot?: Partial<ConfigurationSnapshot>,
  ownershipState: ProviderConfigurationOwnershipState = configurationState === "unavailable" ? "unavailable" : "unmanaged"
): ProviderConfigurationStateV1 {
  const capability = capabilitySnapshot(provider);
  return {
    schemaVersion: 1,
    provider,
    profileVersion: provider === "claude-code"
      ? "claude-code-otel-logs-traces-v2"
      : provider === "codex" ? "codex-otel-logs-traces-v1" : "cursor-hooks-v1",
    configurationState,
    ownershipState,
    promptCaptureEnabled: snapshot?.promptCaptureEnabled ?? false,
    logsEnabled: snapshot?.logsEnabled ?? false,
    tracesEnabled: snapshot?.tracesEnabled ?? false,
    toolDetailsSupported: capability.toolDetailsSupported,
    toolDetailsEnabled: snapshot?.toolDetailsEnabled ?? false,
    toolContentSupported: capability.toolContentSupported,
    toolContentEnabled: snapshot?.toolContentEnabled ?? false,
    responseContentSupported: capability.responseContentSupported,
    responseContentEnabled: snapshot?.responseContentEnabled ?? false,
    reasonCodes
  };
}

function unavailableState(provider: ConfigurableProvider): ProviderConfigurationStateV1 {
  return state(provider, "unavailable", ["source_configuration_unavailable"], undefined, "unavailable");
}

function capabilitySnapshot(provider: ConfigurableProvider): ProviderCapabilitySnapshot {
  if (provider === "claude-code") {
    return {
      toolDetailsSupported: true,
      toolContentSupported: true,
      responseContentSupported: true,
    };
  }
  if (provider === "codex") {
    return {
      toolDetailsSupported: true,
      toolContentSupported: true,
      responseContentSupported: false,
    };
  }
  return {
    toolDetailsSupported: true,
    toolContentSupported: false,
    responseContentSupported: false,
  };
}

function isManagedBooleanValueAllowed(key: ClaudeManagedKey, value: string): boolean {
  if (key === "OTEL_LOG_RAW_API_BODIES") {
    return value === "0" || value === "1";
  }
  return value === "0" || value === "1";
}

function foreignEndpoint(existing: string | undefined, expected: string): boolean {
  return Boolean(existing && existing !== expected);
}

function claudeState(env: Record<string, string>, otlpBaseUrl: string): ConfigurationSnapshot & { logsEnabled: boolean } {
  const logsExporters = exporterList(env.OTEL_LOGS_EXPORTER) ?? [];
  const tracesExporters = exporterList(env.OTEL_TRACES_EXPORTER) ?? [];
  const telemetryEnabled = env.CLAUDE_CODE_ENABLE_TELEMETRY === "1";
  return {
    promptCaptureEnabled: env.OTEL_LOG_USER_PROMPTS === "1",
    logsEnabled: telemetryEnabled
      && logsExporters.includes("otlp")
      && env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL === "http/json"
      && env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === `${otlpBaseUrl}/v1/logs`,
    tracesEnabled: telemetryEnabled
      && claudeEnhancedTelemetryEnabled(env)
      && tracesExporters.includes("otlp")
      && env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL === "http/json"
      && env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === `${otlpBaseUrl}/v1/traces`,
    toolDetailsEnabled: env.OTEL_LOG_TOOL_DETAILS === "1",
    toolContentEnabled: env.OTEL_LOG_TOOL_CONTENT === "1",
    responseContentEnabled: claudeAssistantResponsesEnabled(env)
      || env.OTEL_LOG_RAW_API_BODIES === "1"
  };
}

function claudeEnhancedTelemetryEnabled(env: Record<string, string>): boolean {
  return env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA === "1"
    || env.ENABLE_ENHANCED_TELEMETRY_BETA === "1";
}

function claudeAssistantResponsesEnabled(
  env: Partial<Record<ClaudeManagedKey, string | undefined>>
): boolean {
  return (env.OTEL_LOG_ASSISTANT_RESPONSES ?? env.OTEL_LOG_USER_PROMPTS) === "1";
}

function claudeConfiguredContentGatesMatch(
  env: Record<string, string>,
  restoration: ProviderRestoreState
): boolean {
  const promptCapture = restoration.configuredPromptCapture === true ? "1" : "0";
  const toolDetails = restoration.configuredToolDetails !== false ? "1" : "0";
  const toolContent = restoration.configuredToolContent === true ? "1" : "0";
  const responseContent = restoration.configuredResponseContent === true ? "1" : "0";
  return env.OTEL_LOG_USER_PROMPTS === promptCapture
    && env.OTEL_LOG_TOOL_DETAILS === toolDetails
    && env.OTEL_LOG_TOOL_CONTENT === toolContent
    && (claudeRestoreProfile(restoration) === 1 || env.OTEL_LOG_ASSISTANT_RESPONSES === responseContent)
    && env.OTEL_LOG_RAW_API_BODIES === responseContent;
}

function claudeTraceTransportConfigured(env: Record<string, string>, otlpBaseUrl: string): boolean {
  return (exporterList(env.OTEL_TRACES_EXPORTER) ?? []).includes("otlp")
    && env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL === "http/json"
    && env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === `${otlpBaseUrl}/v1/traces`;
}

function codexExporterShape(value: unknown, expectedEndpoint: string, expectedAuthToken?: string): {
  matchesEndpoint: boolean;
  matchesHeaders: boolean;
} {
  if (!isRecord(value)) {
    return { matchesEndpoint: false, matchesHeaders: false };
  }
  const http = value["otlp-http"];
  if (!isRecord(http) || typeof http.endpoint !== "string") {
    return { matchesEndpoint: false, matchesHeaders: false };
  }
  const headers = http.headers;
  const authorization = isRecord(headers) && typeof headers.Authorization === "string"
    ? headers.Authorization
    : undefined;
  const expectedAuthorization = expectedAuthToken ? `Bearer ${expectedAuthToken}` : undefined;
  return {
    matchesEndpoint: http.endpoint === expectedEndpoint,
    matchesHeaders: authorization === expectedAuthorization
  };
}

function endpointMatches(value: unknown, expectedEndpoint: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const http = value["otlp-http"];
  return isRecord(http) && http.endpoint === expectedEndpoint && http.protocol === "json";
}

// Detects a Tirion-owned exporter that has a stale localhost port. Used to reclaim
// the exporter when no restore state exists (e.g. after clear-agent-data purged it).
function isStaleLocalTirionExporterPair(
  logsExporter: unknown,
  tracesExporter: unknown,
  metricsExporter?: unknown
): boolean {
  const hasLocalOtlpEndpoint = (value: unknown, path: string): boolean => {
    if (!isRecord(value)) return false;
    const http = value["otlp-http"];
    if (!isRecord(http) || typeof http.endpoint !== "string" || http.protocol !== "json") return false;
    try {
      const url = new URL(http.endpoint);
      return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.pathname === path;
    } catch {
      return false;
    }
  };
  return hasLocalOtlpEndpoint(logsExporter, "/v1/logs")
    && hasLocalOtlpEndpoint(tracesExporter, "/v1/traces")
    && (metricsExporter == null || hasLocalOtlpEndpoint(metricsExporter, "/v1/metrics"));
}

function codexExporterMatchesForRestore(
  actual: unknown,
  desired: TomlTable,
  allowHeaderMismatch: boolean
): boolean {
  if (!isRecord(actual) || !isRecord(desired)) {
    return false;
  }
  const actualHttp = actual["otlp-http"];
  const desiredHttp = desired["otlp-http"];
  if (!isRecord(actualHttp) || !isRecord(desiredHttp)) {
    return false;
  }
  const actualProtocol = actualHttp.protocol;
  const desiredProtocol = desiredHttp.protocol;
  const actualEndpoint = actualHttp.endpoint;
  const desiredEndpoint = desiredHttp.endpoint;
  if (actualProtocol !== desiredProtocol || actualEndpoint !== desiredEndpoint) {
    return false;
  }
  if (allowHeaderMismatch) {
    return true;
  }
  return JSON.stringify(actualHttp.headers) === JSON.stringify(desiredHttp.headers);
}

function desiredHookCapture(
  requestedToolDetails: boolean | undefined,
  requestedToolContent: boolean | undefined,
  fallback: boolean
): boolean {
  return requestedToolDetails ?? requestedToolContent ?? fallback;
}

function mergeClaudeConfiguration(
  current: Record<string, unknown>,
  env: Record<string, string | undefined>,
  hooks: Record<string, unknown> | undefined
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...current,
    env
  };
  if (hooks && Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return next;
}

function claudeLocalHookPolicyAllows(settings: Record<string, unknown>, expectedUrl: string): boolean {
  if (settings.disableAllHooks === true) return false;
  if (settings.allowedHttpHookUrls == null) return true;
  if (!Array.isArray(settings.allowedHttpHookUrls)) return false;
  return settings.allowedHttpHookUrls.some((value) =>
    typeof value === "string" && wildcardMatches(value, expectedUrl)
  );
}

function wildcardMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function claudeHooksValue(
  currentHooks: unknown,
  otlpBaseUrl: string,
  authToken: string | undefined,
  enabled: boolean,
  preservedEvents: ClaudeManagedHookEvent[] = []
): Record<string, unknown> | undefined {
  const desiredEvents = new Set(claudeConfiguredHookEvents(enabled));
  const preserved = new Set(preservedEvents);
  const eventsToReplace = CLAUDE_ALL_HOOK_EVENTS.filter((eventName) =>
    !preserved.has(eventName)
    || (desiredEvents.has(eventName) && !claudeHookEventConfigured(currentHooks, otlpBaseUrl, authToken, eventName))
  );
  const hooks = removeClaudeHooks(currentHooks, eventsToReplace) ?? {};
  for (const eventName of desiredEvents) {
    if (claudeHookEventConfigured(hooks, otlpBaseUrl, authToken, eventName)) continue;
    hooks[eventName] = [
      ...eventHookGroups(hooks[eventName]),
      claudeManagedHookGroup(eventName, otlpBaseUrl, authToken)
    ];
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function removeClaudeHooks(
  currentHooks: unknown,
  events: readonly ClaudeManagedHookEvent[] = CLAUDE_ALL_HOOK_EVENTS
): Record<string, unknown> | undefined {
  const hooks = isRecord(currentHooks) ? { ...currentHooks } : {};
  for (const eventName of events) {
    const remainingGroups = eventHookGroups(hooks[eventName]).flatMap((group) => {
      if (!Array.isArray(group.hooks)) return [group];
      const remainingHandlers = group.hooks.filter((handler) =>
        !isRecord(handler) || !isClaudeManagedHookHandler(handler)
      );
      if (remainingHandlers.length === group.hooks.length) return [group];
      return remainingHandlers.length > 0 ? [{ ...group, hooks: remainingHandlers }] : [];
    });
    if (remainingGroups.length > 0) {
      hooks[eventName] = remainingGroups;
    } else {
      delete hooks[eventName];
    }
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function claudeHookShape(
  currentHooks: unknown,
  otlpBaseUrl: string,
  authToken?: string
): {
  lifecycleHooksConfigured: boolean;
  toolHooksConfigured: boolean;
} {
  const lifecycleHooksConfigured = claudeHookEventsConfigured(
    currentHooks,
    otlpBaseUrl,
    authToken,
    CLAUDE_PRE_SESSION_END_LIFECYCLE_HOOK_EVENTS
  );
  const toolHooksConfigured = claudeHookEventsConfigured(
    currentHooks,
    otlpBaseUrl,
    authToken,
    CLAUDE_TOOL_HOOK_EVENTS
  );
  return {
    lifecycleHooksConfigured,
    toolHooksConfigured
  };
}

function claudeManagedHookGroup(
  eventName: ClaudeManagedHookEvent,
  otlpBaseUrl: string,
  authToken: string | undefined
): Record<string, unknown> {
  const headers: Record<string, string> = {
    "X-Tirion-Hook-Surface": "claude-code",
    "X-Tirion-Hook-Event": eventName
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return {
    matcher: "*",
    hooks: [{
      type: "http",
      url: `${otlpBaseUrl}/v1/provider-hooks/claude-code`,
      timeout: 10,
      headers
    }]
  };
}

function isExactClaudeManagedHookGroup(
  group: Record<string, unknown>,
  expectedUrl: string,
  eventName: ClaudeManagedHookEvent,
  authToken?: string,
  authorizationOverride?: string
): boolean {
  if (group.matcher !== "*" || Object.keys(group).some((key) => key !== "matcher" && key !== "hooks")) return false;
  if (!Array.isArray(group.hooks) || group.hooks.length !== 1 || !isRecord(group.hooks[0])) return false;
  return isExactClaudeManagedHookHandler(
    group.hooks[0],
    expectedUrl,
    eventName,
    authToken,
    authorizationOverride
  );
}

function isExactClaudeManagedHookHandler(
  handler: Record<string, unknown>,
  expectedUrl: string,
  eventName: ClaudeManagedHookEvent,
  authToken?: string,
  authorizationOverride?: string
): boolean {
  if (
    handler.type !== "http"
    || handler.url !== expectedUrl
    || handler.timeout !== 10
    || Object.keys(handler).some((key) => !["type", "url", "timeout", "headers"].includes(key))
  ) {
    return false;
  }
  const headers = asStringRecord(handler.headers);
  if (!headers) return false;
  const expectedHeaders: Record<string, string> = {
    "X-Tirion-Hook-Surface": "claude-code",
    "X-Tirion-Hook-Event": eventName
  };
  const authorization = authorizationOverride ?? (authToken ? `Bearer ${authToken}` : undefined);
  if (authorization) expectedHeaders.Authorization = authorization;
  return sameStringRecord(headers, expectedHeaders);
}

function isClaudeManagedHookGroup(group: Record<string, unknown>, expectedUrl?: string): boolean {
  const handlers = Array.isArray(group.hooks) ? group.hooks.filter(isRecord) : [];
  return handlers.some((handler) => isClaudeManagedHookHandler(handler, expectedUrl));
}

function isClaudeManagedHookHandler(handler: Record<string, unknown>, expectedUrl?: string): boolean {
  return handler.type === "http"
    && typeof handler.url === "string"
    && (expectedUrl == null || handler.url === expectedUrl)
    && isRecord(handler.headers)
    && handler.headers["X-Tirion-Hook-Surface"] === "claude-code";
}

function claudeHookEventConfigured(
  currentHooks: unknown,
  otlpBaseUrl: string,
  authToken: string | undefined,
  eventName: ClaudeManagedHookEvent,
  authorizationOverride?: string
): boolean {
  const hooks = isRecord(currentHooks) ? currentHooks : {};
  const groups = eventHookGroups(hooks[eventName]);
  const managedHandlerCount = groups.reduce((count, group) =>
    count + (Array.isArray(group.hooks)
      ? group.hooks.filter((handler) => isRecord(handler) && isClaudeManagedHookHandler(handler)).length
      : 0), 0);
  return managedHandlerCount === 1 && groups.some((group) =>
    isExactClaudeManagedHookGroup(
      group,
      `${otlpBaseUrl}/v1/provider-hooks/claude-code`,
      eventName,
      authToken,
      authorizationOverride
    )
  );
}

function claudeHookEventsConfigured(
  currentHooks: unknown,
  otlpBaseUrl: string,
  authToken: string | undefined,
  events: readonly ClaudeManagedHookEvent[],
  authorizationOverride?: string
): boolean {
  return events.every((eventName) =>
    claudeHookEventConfigured(currentHooks, otlpBaseUrl, authToken, eventName, authorizationOverride)
  );
}

function claudeHookEventsRestorable(
  currentHooks: unknown,
  otlpBaseUrl: string,
  authToken: string | undefined,
  events: readonly ClaudeManagedHookEvent[],
  authorizationOverride?: string
): boolean {
  const hooks = isRecord(currentHooks) ? currentHooks : {};
  const expectedUrl = `${otlpBaseUrl}/v1/provider-hooks/claude-code`;
  return events.every((eventName) => {
    const groups = eventHookGroups(hooks[eventName]);
    const managedHandlers = groups.flatMap((group) =>
      Array.isArray(group.hooks)
        ? group.hooks.filter((handler): handler is Record<string, unknown> =>
            isRecord(handler) && isClaudeManagedHookHandler(handler)
          )
        : []
    );
    return managedHandlers.length === 1 && groups.some((group) =>
      group.matcher === "*"
      && Object.keys(group).every((key) => key === "matcher" || key === "hooks")
      && Array.isArray(group.hooks)
      && group.hooks.some((handler) =>
        isRecord(handler)
        && isExactClaudeManagedHookHandler(
          handler,
          expectedUrl,
          eventName,
          authToken,
          authorizationOverride
        )
      )
    );
  });
}

function claudeManagedHookEventsPresent(currentHooks: unknown): ClaudeManagedHookEvent[] {
  const hooks = isRecord(currentHooks) ? currentHooks : {};
  return CLAUDE_ALL_HOOK_EVENTS.filter((eventName) =>
    eventHookGroups(hooks[eventName]).some((group) => isClaudeManagedHookGroup(group))
  );
}

function claudePreexistingTirionHooksExact(
  currentHooks: unknown,
  otlpBaseUrl: string,
  authToken?: string
): boolean {
  if (!isRecord(currentHooks)) return true;
  return Object.entries(currentHooks).every(([eventName, value]) => {
    const hasManagedHandler = eventHookGroups(value).some((group) => isClaudeManagedHookGroup(group));
    if (!hasManagedHandler) return true;
    if (!CLAUDE_ALL_HOOK_EVENTS.includes(eventName as ClaudeManagedHookEvent)) return false;
    return claudeHookEventConfigured(
      currentHooks,
      otlpBaseUrl,
      authToken,
      eventName as ClaudeManagedHookEvent
    );
  });
}

function claudeManagedAuthorityChangeIsReversible(
  restoration: ProviderRestoreState,
  currentHooks: unknown,
  otlpBaseUrl: string,
  authToken: string | undefined,
  currentHeaders: string | undefined,
  desiredHeaders: string | undefined
): boolean {
  if (
    restoration.presentKeys?.includes("OTEL_EXPORTER_OTLP_HEADERS") === true
    && currentHeaders !== desiredHeaders
  ) {
    return false;
  }
  return claudePreservedHookEvents(restoration).every((eventName) =>
    claudeHookEventConfigured(currentHooks, otlpBaseUrl, authToken, eventName)
  );
}

function uniqueClaudeHookEvents(events: readonly ClaudeManagedHookEvent[]): ClaudeManagedHookEvent[] {
  return CLAUDE_ALL_HOOK_EVENTS.filter((eventName) => events.includes(eventName));
}

function claudeHookAuthorizationFromOtlpHeaders(value: string | undefined): string | undefined {
  const prefix = "Authorization=Bearer ";
  return value?.startsWith(prefix) === true && !value.slice(prefix.length).includes(",")
    ? `Bearer ${value.slice(prefix.length)}`
    : undefined;
}

function claudeManagedHookAuthorizationsUniform(
  currentHooks: unknown,
  events: readonly ClaudeManagedHookEvent[],
  expectedAuthorization: string
): boolean {
  const hooks = isRecord(currentHooks) ? currentHooks : {};
  return events.every((eventName) => {
    const managedHandlers = eventHookGroups(hooks[eventName]).flatMap((group) =>
      Array.isArray(group.hooks)
        ? group.hooks.filter((handler): handler is Record<string, unknown> =>
            isRecord(handler) && isClaudeManagedHookHandler(handler)
          )
        : []
    );
    return managedHandlers.length > 0 && managedHandlers.every((handler) =>
      isRecord(handler.headers) && handler.headers.Authorization === expectedAuthorization
    );
  });
}

function codexHooksValue(
  currentHooks: unknown,
  relayPath: string,
  otlpBaseUrl: string,
  authToken: string | undefined,
  capturePrompts: boolean,
  captureTools: boolean
): TomlTable | undefined {
  const hooks = isRecord(currentHooks) ? { ...currentHooks } : {};
  for (const eventName of CODEX_MANAGED_HOOK_EVENTS) {
    const command = codexHookRelayCommand(
      relayPath,
      `${otlpBaseUrl}/v1/provider-hooks/codex`,
      authToken,
      eventName
    );
    const lifecycle = (CODEX_LIFECYCLE_HOOK_EVENTS as readonly string[]).includes(eventName);
    const activity = (CODEX_ACTIVITY_HOOK_EVENTS as readonly string[]).includes(eventName);
    const desired = lifecycle && capturePrompts
      ? { hooks: [{ type: "command", command, timeout: 10 }] }
      : activity && captureTools
        ? { matcher: ".*", hooks: [{ type: "command", command, timeout: 10 }] }
        : undefined;
    const groups = upsertCodexManagedHookGroup(hooks[eventName], desired, command);
    if (groups.length > 0) {
      hooks[eventName] = groups;
    } else {
      delete hooks[eventName];
    }
  }
  return Object.keys(hooks).length > 0 ? hooks as TomlTable : undefined;
}

const CODEX_LIFECYCLE_HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop"
] as const;

const CODEX_ACTIVITY_HOOK_EVENTS = ["PostToolUse"] as const;
const CODEX_MANAGED_HOOK_EVENTS = [
  ...CODEX_LIFECYCLE_HOOK_EVENTS,
  ...CODEX_ACTIVITY_HOOK_EVENTS,
  "PostToolUseFailure"
] as const;

function removeCodexHooks(currentHooks: unknown): Record<string, unknown> | undefined {
  const hooks = isRecord(currentHooks) ? { ...currentHooks } : {};
  for (const eventName of CODEX_MANAGED_HOOK_EVENTS) {
    const remaining = eventHookGroups(hooks[eventName]).filter((group) => !isCodexManagedHookGroup(group));
    if (remaining.length > 0) {
      hooks[eventName] = remaining;
    } else {
      delete hooks[eventName];
    }
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function codexHookShape(
  currentHooks: unknown,
  relayPath: string,
  otlpBaseUrl: string,
  authToken?: string,
  allowStaleAuth = false
): {
  promptHooksConfigured: boolean;
  toolHooksConfigured: boolean;
  localTirionShape: boolean;
} {
  const hooks = isRecord(currentHooks) ? currentHooks : {};
  const expectedUrl = `${otlpBaseUrl}/v1/provider-hooks/codex`;
  const relayScriptPresent = existsSync(relayPath);
  const managedEventConfigured = (eventName: string) => eventHookGroups(hooks[eventName]).some((group) =>
    allowStaleAuth
      ? isCodexManagedHookGroup(group, relayPath, expectedUrl)
      : isExactCodexManagedHookGroup(
        group,
        codexHookRelayCommand(relayPath, expectedUrl, authToken, eventName)
      )
  );
  const promptHooksConfigured = relayScriptPresent
    && CODEX_LIFECYCLE_HOOK_EVENTS.every(managedEventConfigured);
  const toolHooksConfigured = relayScriptPresent
    && CODEX_ACTIVITY_HOOK_EVENTS.every(managedEventConfigured);
  return {
    promptHooksConfigured,
    toolHooksConfigured,
    localTirionShape: promptHooksConfigured || toolHooksConfigured
  };
}

function upsertCodexManagedHookGroup(
  current: unknown,
  desired: Record<string, unknown> | undefined,
  expectedCommand: string
): Record<string, unknown>[] {
  const groups = eventHookGroups(current);
  let preserved = false;
  const next = groups.flatMap((group) => {
    if (!isCodexManagedHookGroup(group)) {
      return [group];
    }
    if (desired && !preserved && isExactCodexManagedHookGroup(group, expectedCommand)) {
      preserved = true;
      return [group];
    }
    return [];
  });
  if (desired && !preserved) {
    next.push(desired);
  }
  return next;
}

function isExactCodexManagedHookGroup(group: Record<string, unknown>, expectedCommand: string): boolean {
  const handlers = Array.isArray(group.hooks) ? group.hooks.filter(isRecord) : [];
  return handlers.some((handler) =>
    handler.type === "command"
    && handler.command === expectedCommand
    && handler.timeout === 10);
}

function isCodexManagedHookGroup(
  group: Record<string, unknown>,
  relayPath?: string,
  expectedUrl?: string
): boolean {
  const handlers = Array.isArray(group.hooks) ? group.hooks.filter(isRecord) : [];
  return handlers.some((handler) =>
    handler.type === "command"
    && typeof handler.command === "string"
    && handler.command.includes("codex-hook-relay.cjs")
    && (relayPath == null || handler.command.includes(relayPath))
    && (expectedUrl == null || handler.command.includes(expectedUrl)));
}

function codexHookRelayCommand(
  relayPath: string,
  url: string,
  authToken: string | undefined,
  eventName: string
): string {
  return [
    shellQuote(process.execPath),
    shellQuote(relayPath),
    shellQuote(url),
    shellQuote(authToken ?? ""),
    shellQuote(eventName)
  ].join(" ");
}

function codexHookRelayScript(): string {
  return [
    "\"use strict\";",
    "const http = require(\"node:http\");",
    "const https = require(\"node:https\");",
    "const { URL } = require(\"node:url\");",
    "",
    "async function main() {",
    "  const [urlString, authToken, configuredEventName] = process.argv.slice(2);",
    "  if (!urlString) {",
    "    return;",
    "  }",
    "  const chunks = [];",
    "  for await (const chunk of process.stdin) {",
    "    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));",
    "  }",
    "  const body = withHookContext(Buffer.concat(chunks), configuredEventName);",
    "  await post(urlString, body, authToken || \"\").catch(() => undefined);",
    "}",
    "",
    "function withHookContext(body, configuredEventName) {",
    "  try {",
    "    const parsed = JSON.parse(body.toString(\"utf8\"));",
    "    if (!isRecord(parsed)) {",
    "      return body;",
    "    }",
    "    const payload = { ...parsed };",
    "    if (!hasText(payload.hook_event_name) && hasText(configuredEventName)) {",
    "      payload.hook_event_name = configuredEventName;",
    "    }",
    "    if (!hasText(payload.cwd)) {",
    "      payload.cwd = process.cwd();",
    "    }",
    "    return Buffer.from(JSON.stringify(payload));",
    "  } catch {",
    "    return body;",
    "  }",
    "}",
    "",
    "function isRecord(value) {",
    "  return typeof value === \"object\" && value !== null && !Array.isArray(value);",
    "}",
    "",
    "function hasText(value) {",
    "  return typeof value === \"string\" && value.trim() !== \"\";",
    "}",
    "",
    "function post(urlString, body, authToken) {",
    "  const target = new URL(urlString);",
    "  const transport = target.protocol === \"https:\" ? https : http;",
    "  return new Promise((resolve) => {",
    "    const request = transport.request({",
    "      protocol: target.protocol,",
    "      hostname: target.hostname,",
    "      port: target.port || (target.protocol === \"https:\" ? 443 : 80),",
    "      path: `${target.pathname}${target.search}`,",
    "      method: \"POST\",",
    "      headers: {",
    "        \"content-type\": \"application/json\",",
    "        \"content-length\": body.length,",
    "        ...(authToken ? { authorization: `Bearer ${authToken}` } : {})",
    "      }",
    "    }, (response) => {",
    "      response.resume();",
    "      response.on(\"end\", resolve);",
    "    });",
    "    request.on(\"error\", resolve);",
    "    request.end(body);",
    "  });",
    "}",
    "",
    "main().catch(() => undefined);"
  ].join("\n") + "\n";
}

const CURSOR_LIFECYCLE_HOOK_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "stop",
  "sessionEnd",
  "preCompact"
] as const;

const CURSOR_ACTIVITY_HOOK_EVENTS = [
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "afterAgentThought",
  "afterFileEdit"
] as const;

function cursorHooksValue(
  current: Record<string, unknown>,
  relayPath: string,
  otlpBaseUrl: string,
  authToken: string | undefined,
  captureActivity: boolean
): Record<string, unknown> {
  const hooks = removeCursorHooks(current) ?? {};
  for (const eventName of CURSOR_LIFECYCLE_HOOK_EVENTS) {
    const command = cursorHookRelayCommand(
      relayPath,
      `${otlpBaseUrl}/v1/provider-hooks/cursor`,
      authToken,
      eventName
    );
    hooks[eventName] = [
      ...eventHookGroups(hooks[eventName]),
      { command }
    ];
  }
  if (captureActivity) {
    for (const eventName of CURSOR_ACTIVITY_HOOK_EVENTS) {
      const command = cursorHookRelayCommand(
        relayPath,
        `${otlpBaseUrl}/v1/provider-hooks/cursor`,
        authToken,
        eventName
      );
      hooks[eventName] = [
        ...eventHookGroups(hooks[eventName]),
        { command }
      ];
    }
  }
  return hooks;
}

function removeCursorHooks(current: unknown): Record<string, unknown> | undefined {
  const container = isRecord(current) && isRecord(current.hooks) ? current.hooks : isRecord(current) ? current : {};
  const hooks = { ...container };
  for (const eventName of [...CURSOR_LIFECYCLE_HOOK_EVENTS, ...CURSOR_ACTIVITY_HOOK_EVENTS]) {
    const remaining = eventHookGroups(hooks[eventName]).filter((group) => !isCursorManagedHookGroup(group));
    if (remaining.length > 0) {
      hooks[eventName] = remaining;
    } else {
      delete hooks[eventName];
    }
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function cursorHookShape(current: Record<string, unknown>, relayPath: string, otlpBaseUrl: string): {
  lifecycleHooksConfigured: boolean;
  activityHooksConfigured: boolean;
  localTirionShape: boolean;
} {
  const hooks = isRecord(current.hooks) ? current.hooks : {};
  const expectedUrl = `${otlpBaseUrl}/v1/provider-hooks/cursor`;
  const relayScriptPresent = existsSync(relayPath);
  const hasManagedHook = (eventName: string) => relayScriptPresent && eventHookGroups(hooks[eventName]).some((group) =>
    isCursorManagedHookGroup(group, relayPath, expectedUrl)
  );
  const lifecycleHooksConfigured = CURSOR_LIFECYCLE_HOOK_EVENTS.every(hasManagedHook);
  const activityHooksConfigured = CURSOR_ACTIVITY_HOOK_EVENTS.every(hasManagedHook);
  return {
    lifecycleHooksConfigured,
    activityHooksConfigured,
    localTirionShape: lifecycleHooksConfigured || activityHooksConfigured
  };
}

function cursorManagedHookCommands(
  current: Record<string, unknown>,
  relayPath: string,
  expectedUrl: string,
  authToken: string | undefined
): { command: string; matchesAuth: boolean }[] {
  const hooks = isRecord(current.hooks) ? current.hooks : {};
  return [...CURSOR_LIFECYCLE_HOOK_EVENTS, ...CURSOR_ACTIVITY_HOOK_EVENTS]
    .flatMap((eventName) => eventHookGroups(hooks[eventName]).flatMap((group) => {
      const command = typeof group.command === "string" ? group.command : undefined;
      return command && isCursorManagedCommand(command, relayPath, expectedUrl)
        ? [{
            command,
            matchesAuth: command === cursorHookRelayCommand(relayPath, expectedUrl, authToken, eventName)
          }]
        : [];
    }));
}

function isStaleCursorHookShape(current: Record<string, unknown>, relayPath: string): boolean {
  const hooks = isRecord(current.hooks) ? current.hooks : {};
  return [...CURSOR_LIFECYCLE_HOOK_EVENTS, ...CURSOR_ACTIVITY_HOOK_EVENTS].some((eventName) =>
    eventHookGroups(hooks[eventName]).some((group) => {
      const command = typeof group.command === "string" ? group.command : undefined;
      return Boolean(command && isCursorManagedCommand(command, relayPath));
    })
  );
}

function isCursorManagedHookGroup(
  group: Record<string, unknown>,
  relayPath?: string,
  expectedUrl?: string
): boolean {
  const command = typeof group.command === "string" ? group.command : undefined;
  return Boolean(command && isCursorManagedCommand(command, relayPath, expectedUrl));
}

function isCursorManagedCommand(command: string, relayPath?: string, expectedUrl?: string): boolean {
  return command.includes("cursor-hook-relay.cjs")
    && (relayPath == null || command.includes(relayPath))
    && (expectedUrl == null || command.includes(expectedUrl));
}

function cursorHookRelayCommand(
  relayPath: string,
  url: string,
  authToken: string | undefined,
  eventName: string
): string {
  return codexHookRelayCommand(relayPath, url, authToken, eventName);
}

function relayScriptRequired(captureTools: boolean, capturePrompts: boolean): boolean {
  return captureTools || capturePrompts;
}

function privateFileMatches(path: string, expected: string): boolean {
  try {
    return readFileSync(path, "utf8") === expected;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function eventHookGroups(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readJsonObject(path: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (!existsSync(path)) {
    return { ok: true, value: {} };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function readToml(path: string): { ok: true; value: TomlTable } | { ok: false } {
  if (!existsSync(path)) {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: parse(readFileSync(path, "utf8")) };
  } catch {
    return { ok: false };
  }
}

function exporterList(value: string | undefined): string[] | undefined {
  if (value == null || value.trim() === "") {
    return [];
  }
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value as Record<string, string>;
}

function asTomlTable(value: unknown): TomlTable | undefined {
  return isRecord(value) ? value as TomlTable : undefined;
}

function sameStringRecord(left: Record<string, string>, right: Record<string, string | undefined>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left[key] === right[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
