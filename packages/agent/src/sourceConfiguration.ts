import { existsSync, readFileSync, rmSync } from "node:fs";
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

export class SourceConfigurationService {
  constructor(private readonly paths: SourceConfigurationPaths) {}

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
    const endpoint = `${otlpBaseUrl}/v1/logs`;
    const traceEndpoint = `${otlpBaseUrl}/v1/traces`;
    const existingEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    const existingTraceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const existingProtocol = env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL;
    const existingTraceProtocol = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    const desiredHeaders = authToken ? `Authorization=Bearer ${authToken}` : undefined;
    const existingHeaders = env.OTEL_EXPORTER_OTLP_HEADERS;
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
    const desiredPromptCapture = desiredClaudeBoolean(env.OTEL_LOG_USER_PROMPTS, options.capturePrompts, false);
    const desiredToolDetails = desiredClaudeBoolean(env.OTEL_LOG_TOOL_DETAILS, options.captureToolDetails, true);
    const desiredToolContent = desiredClaudeBoolean(env.OTEL_LOG_TOOL_CONTENT, options.captureToolContent, false);
    const desiredResponseContent = desiredClaudeBoolean(env.OTEL_LOG_RAW_API_BODIES, options.captureResponseContent, false);
    const desiredToolHookCapture = desiredHookCapture(options.captureToolDetails, options.captureToolContent, true);
    const managedBooleanKeys = [
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "OTEL_LOG_USER_PROMPTS",
      "OTEL_LOG_TOOL_DETAILS",
      "OTEL_LOG_TOOL_CONTENT",
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
      OTEL_LOGS_EXPORTER: [...new Set([...safeLogsExporters, "otlp"])].join(","),
      OTEL_TRACES_EXPORTER: [...new Set([...safeTracesExporters, "otlp"])].join(","),
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: traceEndpoint,
      OTEL_EXPORTER_OTLP_HEADERS: desiredHeaders,
      OTEL_LOG_USER_PROMPTS: desiredPromptCapture ? "1" : "0",
      OTEL_LOG_TOOL_DETAILS: desiredToolDetails ? "1" : "0",
      OTEL_LOG_TOOL_CONTENT: desiredToolContent ? "1" : "0",
      OTEL_LOG_RAW_API_BODIES: desiredResponseContent ? "1" : "0"
    };
    const desiredHooks = claudeHooksValue(current.value.hooks, otlpBaseUrl, authToken, desiredToolHookCapture);
    const next = mergeClaudeConfiguration(current.value, desiredEnv, desiredHooks);
    if (JSON.stringify(current.value) === JSON.stringify(next)) {
      if (localTirionConfig) {
        this.recordRestoreState("claude-code", {
          filePresent: existsSync(this.paths.claudeSettingsPath),
          containerPresent: current.value.env != null,
          adoptedWithoutBaseline: true,
          presentKeys: [],
          previousExporter: "absent",
          previousTraceExporter: "absent",
          configuredPromptCapture: desiredPromptCapture,
          configuredToolDetails: desiredToolDetails,
          configuredToolContent: desiredToolContent,
          configuredResponseContent: desiredResponseContent,
          configuredToolHookCapture: desiredToolHookCapture
        });
      }
      return result("claude-code", "already_configured", "already_configured", desiredEnv, undefined, currentStatus.ownershipState);
    }
    this.recordRestoreState("claude-code", localTirionConfig
      ? {
          filePresent: existsSync(this.paths.claudeSettingsPath),
          containerPresent: current.value.env != null,
          adoptedWithoutBaseline: true,
          presentKeys: [],
          previousExporter: "absent",
          previousTraceExporter: "absent",
          configuredPromptCapture: desiredPromptCapture,
          configuredToolDetails: desiredToolDetails,
          configuredToolContent: desiredToolContent,
          configuredResponseContent: desiredResponseContent,
          configuredToolHookCapture: desiredToolHookCapture
        }
      : {
          filePresent: existsSync(this.paths.claudeSettingsPath),
          containerPresent: current.value.env != null,
          presentKeys: CLAUDE_MANAGED_KEYS.filter((key) => env[key] != null),
          previousExporter: safeLogsExporters.includes("console") ? "console" : "absent",
          previousTraceExporter: safeTracesExporters.includes("console") ? "console" : "absent",
          configuredPromptCapture: desiredPromptCapture,
          configuredToolDetails: desiredToolDetails,
          configuredToolContent: desiredToolContent,
          configuredResponseContent: desiredResponseContent,
          configuredToolHookCapture: desiredToolHookCapture
        });
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
    if (!otel) {
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
    const relayScriptRequired = desiredToolHookCapture || desiredPromptHookCapture;
    const relayScriptMissing = relayScriptRequired && !existsSync(this.paths.codexHookRelayPath);
    const next = {
      ...current.value,
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
    if (JSON.stringify(current.value) === JSON.stringify(next) && !relayScriptMissing) {
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
          configuredPromptHookCapture: desiredPromptHookCapture
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
          configuredPromptHookCapture: desiredPromptHookCapture
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
          configuredPromptHookCapture: desiredPromptHookCapture
        });
    ensurePrivateDirectory(dirname(this.paths.codexConfigPath));
    if (relayScriptRequired) {
      ensurePrivateDirectory(dirname(this.paths.codexHookRelayPath));
      writePrivateFileAtomic(this.paths.codexHookRelayPath, codexHookRelayScript());
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
    const relayScriptMissing = !existsSync(this.paths.cursorHookRelayPath);
    const next = {
      ...current.value,
      version: current.value.version ?? 1,
      hooks: desiredHooks
    };
    if (JSON.stringify(current.value) === JSON.stringify(next) && !relayScriptMissing) {
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
    writePrivateFileAtomic(this.paths.cursorHookRelayPath, codexHookRelayScript());
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
    const changedKeys = restoration.adoptedWithoutBaseline
      ? [...CLAUDE_MANAGED_KEYS]
      : CLAUDE_MANAGED_KEYS.filter((key) =>
          !presentKeys.includes(key) || (key === "OTEL_LOGS_EXPORTER" && restoration.previousExporter === "console")
            || (key === "OTEL_TRACES_EXPORTER" && restoration.previousTraceExporter === "console")
        );
    if (restoration.adoptedWithoutBaseline) {
      if (ownership !== "managed_current" && ownership !== "managed_stale_authority") {
        return result("claude-code", "conflict", "restore_conflict", undefined, undefined, "managed_drifted");
      }
    } else if (changedKeys.some((key) =>
      key === "OTEL_EXPORTER_OTLP_HEADERS" && ownership === "managed_stale_authority"
        ? env[key] != null
        : env[key] !== desired[key])) {
      return result("claude-code", "conflict", "restore_conflict", undefined, undefined, "managed_drifted");
    }
    if (restoration.configuredToolHookCapture !== false && !claudeHookShape(current.value.hooks, otlpBaseUrl).localTirionShape) {
      return result("claude-code", "conflict", "restore_conflict", undefined, undefined, "managed_drifted");
    }
    const restoredEnv = { ...env };
    for (const key of changedKeys) {
      if (key === "OTEL_LOGS_EXPORTER" && restoration.previousExporter === "console") {
        restoredEnv[key] = "console";
      } else if (key === "OTEL_TRACES_EXPORTER" && restoration.previousTraceExporter === "console") {
        restoredEnv[key] = "console";
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
    const restoredHooks = removeClaudeHooks(current.value.hooks);
    if (restoredHooks && Object.keys(restoredHooks).length > 0) {
      restored.hooks = restoredHooks;
    } else {
      delete restored.hooks;
    }
    writeOrRemoveConfiguration(this.paths.claudeSettingsPath, restored, restoration.filePresent, "json");
    this.clearRestoreState("claude-code");
    return result("claude-code", "restored", "provider_restored", desired, undefined, "managed_current");
  }

  private restoreCodex(otlpBaseUrl: string, authToken?: string): ProviderConfigurationV1 {
    const restoration = this.restoreState().codex;
    if (!restoration) {
      return result("codex", "not_managed", "provider_not_managed", undefined, undefined, "unmanaged");
    }
    const ownership = this.codexStatus(otlpBaseUrl, authToken).ownershipState;
    const current = readToml(this.paths.codexConfigPath);
    const otel = current.ok && current.value.otel != null ? asTomlTable(current.value.otel) : current.ok ? {} : undefined;
    const desiredExporter = codexDesiredExporter(otlpBaseUrl, authToken);
    const desiredTraceExporter = codexDesiredTraceExporter(otlpBaseUrl, authToken);
    const desiredMetricsExporter = codexDesiredMetricsExporter(otlpBaseUrl, authToken);
    const codexHooks = current.ok
      ? codexHookShape(current.value.hooks, this.paths.codexHookRelayPath, otlpBaseUrl)
      : { promptHooksConfigured: false, toolHooksConfigured: false, localTirionShape: false };
    const restoreReady = restoration.adoptedWithoutBaseline
      ? ownership === "managed_current" || ownership === "managed_stale_authority"
      : current.ok
        && Boolean(otel)
        && codexExporterMatchesForRestore(otel!.exporter, desiredExporter, ownership === "managed_stale_authority")
        && codexExporterMatchesForRestore(otel!.trace_exporter, desiredTraceExporter, ownership === "managed_stale_authority")
        && codexExporterMatchesForRestore(otel!.metrics_exporter, desiredMetricsExporter, ownership === "managed_stale_authority")
        && otel!.log_user_prompt === (restoration.configuredPromptCapture ?? true)
        && ((restoration.configuredPromptHookCapture === true ? codexHooks.promptHooksConfigured : true)
          && (restoration.configuredToolHookCapture === true ? codexHooks.toolHooksConfigured : true));
    if (!current.ok || !otel || !restoreReady) {
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
      state[provider] = {
        ...state[provider],
        configuredPromptCapture: value.configuredPromptCapture,
        configuredToolDetails: value.configuredToolDetails,
        configuredToolContent: value.configuredToolContent,
        configuredResponseContent: value.configuredResponseContent,
        configuredToolHookCapture: value.configuredToolHookCapture,
        configuredPromptHookCapture: value.configuredPromptHookCapture
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
    const hookShape = claudeHookShape(current.value.hooks, otlpBaseUrl);
    const snapshot = {
      ...baseSnapshot,
      toolDetailsEnabled: baseSnapshot.toolDetailsEnabled && hookShape.toolHooksConfigured,
      toolContentEnabled: baseSnapshot.toolContentEnabled && hookShape.toolHooksConfigured
    };
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
    const hasConflictShape = !allowedLogsExporters
      || !allowedTracesExporters
      || !transportMatches;
    const localTirionShape = allowedLogsExporters
      && allowedTracesExporters
      && transportMatches
      && hasManagedFootprint
      && env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === `${otlpBaseUrl}/v1/logs`
      && env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === `${otlpBaseUrl}/v1/traces`;
    if (!restoration && localTirionShape) {
      const reasonCodes: ProviderConfigurationStateV1["reasonCodes"] = ["local_tirion_exporter_unclaimed"];
      if (!headersMatch) {
        reasonCodes.unshift("stale_managed_agent_token");
        return state("claude-code", "conflict", reasonCodes, snapshot, "adoptable_local");
      }
      if (!snapshot.logsEnabled) reasonCodes.push("logs_missing");
      if (!snapshot.tracesEnabled) reasonCodes.push("traces_missing");
      if (!snapshot.toolDetailsEnabled) reasonCodes.push("tool_details_disabled");
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
    if (restoration && (hasConflictShape || hasManagedFootprint || snapshot.logsEnabled || snapshot.tracesEnabled || headersMatch)) {
      if (
        hasConflictShape
        || !headersMatch
        || !snapshot.logsEnabled
        || !snapshot.tracesEnabled
        || hookShape.toolHooksConfigured !== (restoration.configuredToolHookCapture !== false)
        || snapshot.toolDetailsEnabled !== (restoration.configuredToolDetails !== false)
        || snapshot.toolContentEnabled !== (restoration.configuredToolContent === true)
        || snapshot.responseContentEnabled !== (restoration.configuredResponseContent === true)
        || snapshot.promptCaptureEnabled !== (restoration.configuredPromptCapture === true)
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
    if (hasConflictShape || (!headersMatch && hasManagedFootprint)) {
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
    if (!snapshot.toolDetailsEnabled) reasonCodes.push("tool_details_disabled");
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
    if (!otel) {
      return state("codex", "conflict", ["invalid_existing_configuration"], undefined, "invalid");
    }
    const desiredExporter = codexDesiredExporter(otlpBaseUrl, authToken);
    const desiredTraceExporter = codexDesiredTraceExporter(otlpBaseUrl, authToken);
    const desiredMetricsExporter = codexDesiredMetricsExporter(otlpBaseUrl, authToken);
    const hookShape = codexHookShape(current.value.hooks, this.paths.codexHookRelayPath, otlpBaseUrl);
    const snapshot = {
      promptCaptureEnabled: otel.log_user_prompt === true,
      logsEnabled: JSON.stringify(otel.exporter) === JSON.stringify(desiredExporter),
      tracesEnabled: JSON.stringify(otel.trace_exporter) === JSON.stringify(desiredTraceExporter)
        && JSON.stringify(otel.metrics_exporter) === JSON.stringify(desiredMetricsExporter),
      toolDetailsEnabled: hookShape.toolHooksConfigured,
      toolContentEnabled: hookShape.toolHooksConfigured,
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
] as const;

type ClaudeManagedKey = typeof CLAUDE_MANAGED_KEYS[number];

type ProviderRestoreState = {
  filePresent: boolean;
  containerPresent: boolean;
  adoptedWithoutBaseline?: boolean;
  presentKeys?: ClaudeManagedKey[];
  previousExporter?: "absent" | "console";
  previousTraceExporter?: "absent" | "console";
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
  versionPresent?: boolean;
};

type RestoreState = Partial<Record<ConfigurableProvider, ProviderRestoreState>>;

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
    OTEL_LOGS_EXPORTER: previousExporter === "console" ? "console,otlp" : "otlp",
    OTEL_TRACES_EXPORTER: previousTraceExporter === "console" ? "console,otlp" : "otlp",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${otlpBaseUrl}/v1/logs`,
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${otlpBaseUrl}/v1/traces`,
    OTEL_EXPORTER_OTLP_HEADERS: authToken ? `Authorization=Bearer ${authToken}` : undefined,
    OTEL_LOG_USER_PROMPTS: capturePrompts ? "1" : "0",
    OTEL_LOG_TOOL_DETAILS: captureToolDetails ? "1" : "0",
    OTEL_LOG_TOOL_CONTENT: captureToolContent ? "1" : "0",
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
    if (record.versionPresent != null && typeof record.versionPresent !== "boolean") {
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
    if (provider === "claude-code") {
      if (
        !Array.isArray(record.presentKeys)
        || record.presentKeys.some((key) => !CLAUDE_MANAGED_KEYS.includes(key as ClaudeManagedKey))
        || !["absent", "console"].includes(record.previousExporter as string)
        || !["absent", "console"].includes((record.previousTraceExporter ?? "absent") as string)
      ) {
        throw new Error("invalid restore state");
      }
      state[provider] = {
        filePresent: record.filePresent,
        containerPresent: record.containerPresent,
        adoptedWithoutBaseline: record.adoptedWithoutBaseline === true,
        presentKeys: record.presentKeys as ClaudeManagedKey[],
        previousExporter: record.previousExporter as "absent" | "console",
        previousTraceExporter: (record.previousTraceExporter ?? "absent") as "absent" | "console",
        configuredPromptCapture: record.configuredPromptCapture === true,
        configuredToolDetails: record.configuredToolDetails !== false,
        configuredToolContent: record.configuredToolContent === true,
        configuredResponseContent: record.configuredResponseContent === true,
        configuredToolHookCapture: record.configuredToolHookCapture !== false
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
        configuredPromptHookCapture: record.configuredPromptHookCapture === true
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
        logsEnabled: true,
        tracesEnabled: true,
        toolDetailsEnabled: claudeEnv.OTEL_LOG_TOOL_DETAILS === "1",
        toolContentEnabled: claudeEnv.OTEL_LOG_TOOL_CONTENT === "1",
        responseContentEnabled: claudeEnv.OTEL_LOG_RAW_API_BODIES === "1"
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
      ? "claude-code-otel-logs-traces-v1"
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
      ? "claude-code-otel-logs-traces-v1"
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

function desiredClaudeBoolean(current: string | undefined, requested: boolean | undefined, fallback: boolean): boolean {
  return requested ?? (current == null ? fallback : current !== "0");
}

function isManagedBooleanValueAllowed(key: ClaudeManagedKey, value: string): boolean {
  if (key === "CLAUDE_CODE_ENABLE_TELEMETRY") {
    return value === "1";
  }
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
  return {
    promptCaptureEnabled: env.OTEL_LOG_USER_PROMPTS === "1",
    logsEnabled: logsExporters.includes("otlp")
      && env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL === "http/json"
      && env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === `${otlpBaseUrl}/v1/logs`,
    tracesEnabled: tracesExporters.includes("otlp")
      && env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL === "http/json"
      && env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === `${otlpBaseUrl}/v1/traces`,
    toolDetailsEnabled: env.OTEL_LOG_TOOL_DETAILS === "1",
    toolContentEnabled: env.OTEL_LOG_TOOL_CONTENT === "1",
    responseContentEnabled: env.OTEL_LOG_RAW_API_BODIES === "1"
  };
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

function claudeHooksValue(
  currentHooks: unknown,
  otlpBaseUrl: string,
  authToken: string | undefined,
  enabled: boolean
): Record<string, unknown> | undefined {
  const hooks = removeClaudeHooks(currentHooks) ?? {};
  hooks.UserPromptSubmit = [
    ...eventHookGroups(hooks.UserPromptSubmit),
    claudeManagedHookGroup("UserPromptSubmit", otlpBaseUrl, authToken)
  ];
  hooks.Stop = [
    ...eventHookGroups(hooks.Stop),
    claudeManagedHookGroup("Stop", otlpBaseUrl, authToken)
  ];
  hooks.SubagentStop = [
    ...eventHookGroups(hooks.SubagentStop),
    claudeManagedHookGroup("SubagentStop", otlpBaseUrl, authToken)
  ];
  if (!enabled) {
    return hooks;
  }
  hooks.PreToolUse = [
    ...eventHookGroups(hooks.PreToolUse),
    claudeManagedHookGroup("PreToolUse", otlpBaseUrl, authToken)
  ];
  hooks.PostToolUse = [
    ...eventHookGroups(hooks.PostToolUse),
    claudeManagedHookGroup("PostToolUse", otlpBaseUrl, authToken)
  ];
  hooks.PostToolUseFailure = [
    ...eventHookGroups(hooks.PostToolUseFailure),
    claudeManagedHookGroup("PostToolUseFailure", otlpBaseUrl, authToken)
  ];
  return hooks;
}

function removeClaudeHooks(currentHooks: unknown): Record<string, unknown> | undefined {
  const hooks = isRecord(currentHooks) ? { ...currentHooks } : {};
  for (const eventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop"] as const) {
    const remaining = eventHookGroups(hooks[eventName]).filter((group) => !isClaudeManagedHookGroup(group));
    if (remaining.length > 0) {
      hooks[eventName] = remaining;
    } else {
      delete hooks[eventName];
    }
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function claudeHookShape(currentHooks: unknown, otlpBaseUrl: string): {
  toolHooksConfigured: boolean;
  localTirionShape: boolean;
} {
  const hooks = isRecord(currentHooks) ? currentHooks : {};
  const expectedUrl = `${otlpBaseUrl}/v1/provider-hooks/claude-code`;
  const userPromptSubmit = eventHookGroups(hooks.UserPromptSubmit).some((group) => isClaudeManagedHookGroup(group, expectedUrl));
  const stop = eventHookGroups(hooks.Stop).some((group) => isClaudeManagedHookGroup(group, expectedUrl));
  const subagentStop = eventHookGroups(hooks.SubagentStop).some((group) => isClaudeManagedHookGroup(group, expectedUrl));
  const postToolUse = eventHookGroups(hooks.PostToolUse).some((group) => isClaudeManagedHookGroup(group, expectedUrl));
  const postToolUseFailure = eventHookGroups(hooks.PostToolUseFailure).some((group) => isClaudeManagedHookGroup(group, expectedUrl));
  return {
    toolHooksConfigured: postToolUse && postToolUseFailure,
    localTirionShape: userPromptSubmit && stop && subagentStop && postToolUse && postToolUseFailure
  };
}

function claudeManagedHookGroup(
  eventName: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "Stop" | "SubagentStop",
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

function isClaudeManagedHookGroup(group: Record<string, unknown>, expectedUrl?: string): boolean {
  const handlers = Array.isArray(group.hooks) ? group.hooks.filter(isRecord) : [];
  return handlers.some((handler) =>
    handler.type === "http"
    && typeof handler.url === "string"
    && (expectedUrl == null || handler.url === expectedUrl)
    && isRecord(handler.headers)
    && handler.headers["X-Tirion-Hook-Surface"] === "claude-code");
}

function codexHooksValue(
  currentHooks: unknown,
  relayPath: string,
  otlpBaseUrl: string,
  authToken: string | undefined,
  capturePrompts: boolean,
  captureTools: boolean
): TomlTable | undefined {
  const hooks = removeCodexHooks(currentHooks) ?? {};
  const command = codexHookRelayCommand(relayPath, `${otlpBaseUrl}/v1/provider-hooks/codex`, authToken);
  if (capturePrompts) {
    hooks.UserPromptSubmit = [
      ...eventHookGroups(hooks.UserPromptSubmit),
      { hooks: [{ type: "command", command, timeout: 10 }] }
    ];
  }
  if (captureTools) {
    hooks.PostToolUse = [
      ...eventHookGroups(hooks.PostToolUse),
      { matcher: ".*", hooks: [{ type: "command", command, timeout: 10 }] }
    ];
  }
  return Object.keys(hooks).length > 0 ? hooks as TomlTable : undefined;
}

function removeCodexHooks(currentHooks: unknown): Record<string, unknown> | undefined {
  const hooks = isRecord(currentHooks) ? { ...currentHooks } : {};
  for (const eventName of ["UserPromptSubmit", "PostToolUse"] as const) {
    const remaining = eventHookGroups(hooks[eventName]).filter((group) => !isCodexManagedHookGroup(group));
    if (remaining.length > 0) {
      hooks[eventName] = remaining;
    } else {
      delete hooks[eventName];
    }
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function codexHookShape(currentHooks: unknown, relayPath: string, otlpBaseUrl: string): {
  promptHooksConfigured: boolean;
  toolHooksConfigured: boolean;
  localTirionShape: boolean;
} {
  const hooks = isRecord(currentHooks) ? currentHooks : {};
  const expectedUrl = `${otlpBaseUrl}/v1/provider-hooks/codex`;
  const relayScriptPresent = existsSync(relayPath);
  const promptHooksConfigured = relayScriptPresent && eventHookGroups(hooks.UserPromptSubmit).some((group) =>
    isCodexManagedHookGroup(group, relayPath, expectedUrl)
  );
  const toolHooksConfigured = relayScriptPresent && eventHookGroups(hooks.PostToolUse).some((group) =>
    isCodexManagedHookGroup(group, relayPath, expectedUrl)
  );
  return {
    promptHooksConfigured,
    toolHooksConfigured,
    localTirionShape: promptHooksConfigured || toolHooksConfigured
  };
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

function codexHookRelayCommand(relayPath: string, url: string, authToken: string | undefined): string {
  return [
    shellQuote(process.execPath),
    shellQuote(relayPath),
    shellQuote(url),
    shellQuote(authToken ?? "")
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
    "  const [urlString, authToken] = process.argv.slice(2);",
    "  if (!urlString) {",
    "    return;",
    "  }",
    "  const chunks = [];",
    "  for await (const chunk of process.stdin) {",
    "    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));",
    "  }",
    "  const body = Buffer.concat(chunks);",
    "  await post(urlString, body, authToken || \"\").catch(() => undefined);",
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
  const command = cursorHookRelayCommand(relayPath, `${otlpBaseUrl}/v1/provider-hooks/cursor`, authToken);
  for (const eventName of CURSOR_LIFECYCLE_HOOK_EVENTS) {
    hooks[eventName] = [
      ...eventHookGroups(hooks[eventName]),
      { command }
    ];
  }
  if (captureActivity) {
    for (const eventName of CURSOR_ACTIVITY_HOOK_EVENTS) {
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
  const expectedCommand = cursorHookRelayCommand(relayPath, expectedUrl, authToken);
  return [...CURSOR_LIFECYCLE_HOOK_EVENTS, ...CURSOR_ACTIVITY_HOOK_EVENTS]
    .flatMap((eventName) => eventHookGroups(hooks[eventName]))
    .flatMap((group) => {
      const command = typeof group.command === "string" ? group.command : undefined;
      return command && isCursorManagedCommand(command, relayPath, expectedUrl)
        ? [{ command, matchesAuth: command === expectedCommand }]
        : [];
    });
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

function cursorHookRelayCommand(relayPath: string, url: string, authToken: string | undefined): string {
  return codexHookRelayCommand(relayPath, url, authToken);
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
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
