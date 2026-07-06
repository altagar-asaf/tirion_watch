import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { macOsLaunchAgent, resolveAgentPaths, writeMacOsLaunchAgent } from "@tirion/platform";
import { AGENT_DATABASE_SCHEMA_VERSION } from "@tirion/agent-contract";
import type {
  AgentCommitAttributionV1,
  AgentDoctorV1,
  AgentHistoricalReconciliationStatusV1,
  RepositoryActivationV1,
  RepositoryScopeV1,
  AgentStatusV1,
  AgentVersionV1,
  ProductionRunV1
} from "@tirion/agent-contract";
import { renderDashboard } from "./dashboard";

const CLI_VERSION = String(require("../package.json").version);

export type CliIo = {
  env: NodeJS.ProcessEnv;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  cwd?: string;
  confirm?(prompt: string): Promise<boolean> | boolean;
  platform?: NodeJS.Platform;
  serviceDefinition?: ReturnType<typeof macOsLaunchAgent>;
  execFile?(command: string, args: string[]): string | void;
  packagedInstallRoot?: string;
  waitForHealthy?(): Promise<Record<string, unknown>>;
  inspectPackage?(packagePath: string): InstallerBirthCertificate;
};

type InstallerBirthCertificate = {
  agentVersion: string;
  databaseSchemaVersion: number;
  artifact: {
    packageIdentifier: string;
    signingIdentity: string;
    notarization: string;
  };
  migrationSupportWindow: {
    minimumDatabaseSchemaVersion: number;
    maximumDatabaseSchemaVersion: number;
    legacyExtensionHistoryMigration: string;
  };
};

export async function runTirionCtl(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.stdout.write(helpText());
        return 0;
      case "init":
        return await initialize(io);
      case "version":
      case "--version":
      case "-v":
        await printVersion(io);
        return 0;
      case "status":
        io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", "/v1/status"))}\n`);
        return 0;
      case "health":
        return await health(io);
      case "doctor":
        return await doctor(io);
      case "support-bundle":
        io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", "/v1/support-bundle", undefined, bootstrap(io)))}\n`);
        return 0;
      case "diagnostics":
        io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", "/v1/diagnostics", undefined, bootstrap(io)))}\n`);
        return 0;
      case "logs":
        io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", `/v1/logs${limitQuery(rest)}`, undefined, bootstrap(io)))}\n`);
        return 0;
      case "budget":
        return await budget(rest, io);
      case "service":
        return service(rest, io);
      case "start":
        return await start(io);
      case "stop":
        return await stop(io);
      case "restart":
        return await restart(io);
      case "repair":
        return await repair(io);
      case "upgrade":
        return await upgrade(rest, io);
      case "rollback":
        return await rollback(rest, io);
      case "uninstall":
        return await uninstall(rest, io);
      case "sources":
        return await sources(rest, io);
      case "runs": {
        const prefix = await usagePrefix(io);
        const path = rest.includes("--current") && prefix === "/v1" ? "/v1/current-runs" : `${prefix}/runs`;
        io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", `${path}${limitQuery(rest)}`, undefined, bootstrap(io)))}\n`);
        return 0;
      }
      case "totals":
        io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", `${await usagePrefix(io)}/totals`, undefined, bootstrap(io)))}\n`);
        return 0;
      case "export":
        io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", `${await usagePrefix(io)}/export?format=${rest.includes("--csv") ? "csv" : "json"}`, undefined, bootstrap(io)))}\n`);
        return 0;
      case "clear-history":
        io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/clear-history", undefined, bootstrap(io)))}\n`);
        return 0;
      case "clear-agent-data":
        return await clearAgentData(rest, io);
      case "shadow":
        return await shadow(rest, io);
      case "ownership":
        return await ownership(rest, io);
      case "configure":
        return await configure(rest, io);
      case "repo":
        return await repositories(rest, io);
      case "attribution":
        return await attribution(rest, io);
      case "webhook":
        return await webhook(rest, io);
      case "report":
        return await statusReport(rest, io);
      case "dashboard":
        return await dashboard(rest, io);
      case "app":
        return await app(rest, io);
      case "sync":
      case "publishing":
      case "accounting":
      case "execution":
        return removedBackendSurface(command, io);
      default:
        io.stderr.write(`Unknown tirionctl command: ${command}\n`);
        io.stdout.write(helpText());
        return 2;
    }
  } catch (error) {
    io.stderr.write(`${safeMessage(error)}\n`);
    return 1;
  }
}

async function app(args: string[], io: CliIo): Promise<number> {
  if (args.length > 0) {
    io.stderr.write("Use 'tirionctl app'.\n");
    return 2;
  }
  const binary = resolveTuiBinary(io);
  if (!binary) {
    io.stderr.write("Tirion TUI is not installed. Build it with `npm run tui:build` or reinstall Tirion.\n");
    return 2;
  }
  await ensureAgentReachableForApp(io);
  executeInteractive(io, binary, []);
  return 0;
}

async function ensureAgentReachableForApp(io: CliIo): Promise<void> {
  const status = await agentRequest(io, "GET", "/v1/status").catch(() => undefined);
  if (status) {
    return;
  }
  if (currentPlatform(io) === "darwin") {
    service(["install"], { ...io, stdout: { write: () => undefined } });
    await waitForHealthy(io);
    return;
  }
  await startAgentProcess(io);
}

async function budget(args: string[], io: CliIo): Promise<number> {
  const [subcommand] = args;
  if (subcommand === "status") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", "/v1/budgets", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "set") {
    const values = [
      optionInteger(args, "--run-tokens"),
      optionInteger(args, "--run-estimated-nano-usd"),
      optionInteger(args, "--daily-estimated-nano-usd"),
      optionInteger(args, "--monthly-estimated-nano-usd")
    ];
    if (values.some((value) => value == null)) {
      io.stderr.write("Budget thresholds require all four positive integer options.\n");
      return 2;
    }
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/budgets/thresholds", {
      schemaVersion: 1,
      runTokens: values[0],
      runEstimatedNanoUsd: values[1],
      dailyEstimatedNanoUsd: values[2],
      monthlyEstimatedNanoUsd: values[3]
    }, bootstrap(io)))}\n`);
    return 0;
  }
  io.stderr.write("Use 'tirionctl budget status' or 'tirionctl budget set' with all threshold options.\n");
  return 2;
}

function removedBackendSurface(command: string, io: CliIo): number {
  io.stderr.write(
    `The local-only Tirion build removed '${command}' because backend publishing, accounting, and execution sync are no longer part of the product.\n`
  );
  return 2;
}

async function attribution(args: string[], io: CliIo): Promise<number> {
  const [subcommand] = args;
  if (subcommand === "list") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", `/v1/attributions${limitQuery(args.slice(1))}`, undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "export") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", `/v1/attributions/export?format=${args.includes("--csv") ? "csv" : "json"}`, undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "reconcile") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/attributions/reconcile", undefined, bootstrap(io)) as AgentHistoricalReconciliationStatusV1)}\n`);
    return 0;
  }
  io.stderr.write("Use 'tirionctl attribution list [--limit N]', 'tirionctl attribution export [--csv]', or 'tirionctl attribution reconcile'.\n");
  return 2;
}

async function webhook(args: string[], io: CliIo): Promise<number> {
  const [subcommand, value] = args;
  if (subcommand === "status") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", "/v1/webhook/status", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "set-url" && value) {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/webhook/url", {
      schemaVersion: 1,
      url: value
    }, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "set-token" && value) {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/webhook/token", {
      schemaVersion: 1,
      token: value
    }, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "clear-token") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "DELETE", "/v1/webhook/token", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "set-secret" && value) {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/webhook/secret", {
      schemaVersion: 1,
      secret: value
    }, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "clear-secret") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "DELETE", "/v1/webhook/secret", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "set-sender") {
    const sender = {
      ...(optionValue(args, "--name") ? { name: optionValue(args, "--name") } : {}),
      ...(optionValue(args, "--team") ? { team: optionValue(args, "--team") } : {}),
      ...(optionValue(args, "--image-url") ? { imageUrl: optionValue(args, "--image-url") } : {})
    };
    if (Object.keys(sender).length === 0) {
      io.stderr.write("Use 'tirionctl webhook set-sender --name <name> [--team <team>] [--image-url <url>]'.\n");
      return 2;
    }
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/webhook/sender", {
      schemaVersion: 1,
      sender
    }, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "clear-sender") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "DELETE", "/v1/webhook/sender", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "enable-runs") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/webhook/runs/enable", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "disable-runs") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/webhook/runs/disable", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "test") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/webhook/test", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "retry") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/webhook/retry", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  io.stderr.write("Use 'tirionctl webhook status|set-url <url>|set-token <token>|clear-token|set-secret <secret>|clear-secret|set-sender --name <name> [--team <team>] [--image-url <url>]|clear-sender|enable-runs|disable-runs|test|retry'.\n");
  return 2;
}

async function dashboard(args: string[], io: CliIo): Promise<number> {
  const prefix = await usagePrefix(io);
  const [attributionsResult, runsResult] = await Promise.all([
    agentRequest(io, "GET", `/v1/attributions${limitQuery(args)}`, undefined, bootstrap(io)),
    agentRequest(io, "GET", `${prefix}/runs${limitQuery(args)}`, undefined, bootstrap(io))
  ]);
  const attributions = (attributionsResult.attributions ?? []) as AgentCommitAttributionV1[];
  const runs = (runsResult.runs ?? []) as ProductionRunV1[];
  io.stdout.write(renderDashboard(attributions, runs));
  return 0;
}

type RequestOutcome = {
  ok: true;
  value: Record<string, unknown>;
} | {
  ok: false;
  error: string;
};

type HealthReport = {
  schemaVersion: 1;
  overall: "healthy" | "degraded" | "blocked";
  agent: Record<string, unknown>;
  sources: Record<string, unknown>;
  repositories: Record<string, unknown>;
  webhook: Record<string, unknown>;
  budgets: Record<string, unknown>;
  issues: string[];
  actions: string[];
};

type LifecycleFollowUp = {
  health: HealthReport;
  repositories: RepositoryScopeV1[] | undefined;
};

export function deriveHealthOverall(options: {
  blocked: boolean;
  operationalIssueCount: number;
}): HealthReport["overall"] {
  if (options.blocked) {
    return "blocked";
  }
  return options.operationalIssueCount > 0 ? "degraded" : "healthy";
}

async function health(io: CliIo): Promise<number> {
  const report = await buildHealthReport(io);
  io.stdout.write(`${JSON.stringify(report)}\n`);
  return report.overall === "healthy" ? 0 : 1;
}

async function statusReport(args: string[], io: CliIo): Promise<number> {
  const timestamp = new Date().toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const outputPath = optionValue(args, "--output") ?? join(homedir(), `tirion-report-${safeTimestamp}.json`);

  const healthReport = await buildHealthReport(io);

  const logContents = {
    schemaVersion: 1,
    timestamp,
    webhookStatus: healthReport.webhook,
    health: healthReport
  };

  writeFileSync(outputPath, JSON.stringify(logContents, null, 2));
  io.stdout.write(`${JSON.stringify({ schemaVersion: 1, reportPath: outputPath, timestamp })}\n`);
  return 0;
}

async function buildHealthReport(io: CliIo): Promise<HealthReport> {
  const checks: Record<string, unknown> = {
    bootstrapPresent: false,
    platform: currentPlatform(io),
    serviceRegistrationPresent: currentPlatform(io) === "darwin"
      ? existsSync(serviceDefinition(io).plistPath)
      : false,
    packagedInstallPresent: existsSync(join(io.packagedInstallRoot ?? "/Applications/Tirion", "bin", "tirion-agent")),
    stateDirectoryPresent: existsSync(resolveAgentPaths(io.env).stateDir)
  };

  let credential: string | undefined;
  try {
    credential = bootstrap(io);
    checks.bootstrapPresent = true;
  } catch {
    credential = undefined;
  }

  const [healthOutcome, statusOutcome, versionOutcome, doctorOutcome, sourcesOutcome, repositoriesOutcome, webhookOutcome, budgetsOutcome] = await Promise.all([
    requestOutcome(io, "GET", "/v1/health"),
    requestOutcome(io, "GET", "/v1/status"),
    credential ? requestOutcome(io, "GET", "/v1/version") : Promise.resolve({ ok: false as const, error: "authentication_required" }),
    credential ? requestOutcome(io, "GET", "/v1/doctor", undefined, credential) : Promise.resolve({ ok: false as const, error: "authentication_required" }),
    credential ? requestOutcome(io, "GET", "/v1/sources", undefined, credential) : Promise.resolve({ ok: false as const, error: "authentication_required" }),
    credential ? requestOutcome(io, "GET", "/v1/repositories", undefined, credential) : Promise.resolve({ ok: false as const, error: "authentication_required" }),
    credential ? requestOutcome(io, "GET", "/v1/webhook/status", undefined, credential) : Promise.resolve({ ok: false as const, error: "authentication_required" }),
    credential ? requestOutcome(io, "GET", "/v1/budgets", undefined, credential) : Promise.resolve({ ok: false as const, error: "authentication_required" })
  ]);

  const status = statusOutcome.ok ? statusOutcome.value as AgentStatusV1 : undefined;
  const version = versionOutcome.ok ? versionOutcome.value as AgentVersionV1 : undefined;
  const doctor = doctorOutcome.ok ? doctorOutcome.value as AgentDoctorV1 : undefined;
  const webhookStatus = webhookOutcome.ok ? webhookOutcome.value : undefined;

  const doctorChecks = doctor && isRecord(doctor.checks) ? doctor.checks : undefined;
  const doctorFacts = doctor && isRecord(doctor.facts) ? doctor.facts : undefined;
  const sourceStatuses = Array.isArray(doctorFacts?.sourceStatuses) ? doctorFacts.sourceStatuses : [];
  const configuredProviderCount = sourceStatuses.filter((item) =>
    isRecord(item)
    && (item.configurationState !== "not_configured" || item.ownershipState !== "unmanaged")).length;
  const warnings = budgetsOutcome.ok && Array.isArray(budgetsOutcome.value.warnings) ? budgetsOutcome.value.warnings : [];
  const runtimeWarmupState = doctorFacts && typeof doctorFacts["runtimeWarmupState"] === "string"
    ? doctorFacts["runtimeWarmupState"]
    : typeof status?.runtimeWarmupState === "string"
      ? status.runtimeWarmupState
      : undefined;
  const runtimeWarmupLastErrorCode = doctorFacts && typeof doctorFacts["runtimeWarmupLastErrorCode"] === "string"
    ? doctorFacts["runtimeWarmupLastErrorCode"]
    : typeof status?.runtimeWarmupLastErrorCode === "string"
      ? status.runtimeWarmupLastErrorCode
      : undefined;
  const historicalReconciliationState = doctorFacts && typeof doctorFacts["historicalReconciliationState"] === "string"
    ? doctorFacts["historicalReconciliationState"]
    : doctorFacts && typeof doctorFacts["fullOwnerBootstrapState"] === "string"
      ? doctorFacts["fullOwnerBootstrapState"]
      : typeof status?.historicalReconciliationState === "string"
        ? status.historicalReconciliationState
        : typeof status?.fullOwnerBootstrapState === "string"
          ? status.fullOwnerBootstrapState
          : undefined;
  const historicalReconciliationLastErrorCode = doctorFacts
    && typeof doctorFacts["historicalReconciliationLastErrorCode"] === "string"
    ? doctorFacts["historicalReconciliationLastErrorCode"]
    : doctorFacts && typeof doctorFacts["fullOwnerBootstrapLastErrorCode"] === "string"
      ? doctorFacts["fullOwnerBootstrapLastErrorCode"]
      : typeof status?.historicalReconciliationLastErrorCode === "string"
        ? status.historicalReconciliationLastErrorCode
        : typeof status?.fullOwnerBootstrapLastErrorCode === "string"
          ? status.fullOwnerBootstrapLastErrorCode
          : undefined;
  const historicalDeferredRunCount = doctorFacts && typeof doctorFacts["deferredCompletedRunCount"] === "number"
    ? doctorFacts["deferredCompletedRunCount"]
    : undefined;

  const issues: string[] = [];
  const actions: string[] = [];

  if (!statusOutcome.ok) {
    issues.push("Local agent is not reachable.");
    actions.push("Start the local agent with `tirionctl start` or repair it with `tirionctl repair`.");
  }
  if (!credential) {
    issues.push("Local bootstrap credential is missing.");
    actions.push("Recreate the local control bootstrap with `tirionctl init` or `tirionctl repair`.");
  }
  if (status?.health && status.health !== "healthy") {
    issues.push(`Local agent health is ${status.health}.`);
    actions.push("Inspect `tirionctl doctor` and `tirionctl logs` until the agent returns to `healthy`.");
  }
  if (runtimeWarmupState === "starting") {
    issues.push("Local runtime warmup is still rebuilding usage and retention state in the background.");
    actions.push("Wait for warmup to finish or inspect `tirionctl logs` if it remains in this state unexpectedly.");
  }
  if (runtimeWarmupState === "failed") {
    issues.push(`Local runtime warmup failed${runtimeWarmupLastErrorCode ? ` with ${runtimeWarmupLastErrorCode}` : ""}.`);
    actions.push("Inspect `tirionctl logs` and restart or repair the local agent before trusting local history and sync.");
  }
  if (doctor?.databaseIntegrity && doctor.databaseIntegrity !== "ok") {
    issues.push(`Agent database integrity is ${doctor.databaseIntegrity}.`);
    actions.push("Repair or restore the local agent state before relying on measurements or sync.");
  }
  if (doctorChecks) {
    for (const [name, value] of Object.entries(doctorChecks)) {
      if (value !== true) {
        issues.push(`Doctor check '${name}' is failing.`);
      }
    }
    if (Object.values(doctorChecks).some((value) => value !== true)) {
      actions.push("Fix the failing doctor checks or rerun `tirionctl repair`.");
    }
  }
  if (status?.ownershipState && status.ownershipState !== "agent_full_owner") {
    issues.push(`Ownership state is ${status.ownershipState}, so full repository monitoring and webhook dispatch are not active.`);
    actions.push("Transition the installation to `agent_full_owner` before expecting end-to-end repository monitoring and outbound webhooks.");
  }
  if (historicalReconciliationState === "running") {
    issues.push("Explicit historical reconciliation is running in the background.");
    actions.push("Wait for reconciliation to finish or inspect `tirionctl logs` if it stays in this state unexpectedly.");
  }
  if (historicalReconciliationState === "failed") {
    issues.push(`Historical reconciliation failed${historicalReconciliationLastErrorCode ? ` with ${historicalReconciliationLastErrorCode}` : ""}.`);
    actions.push("Inspect `tirionctl logs` and rerun `tirionctl attribution reconcile` before trusting deferred historical attribution.");
  }
  if (historicalReconciliationState === "deferred" && historicalDeferredRunCount && historicalDeferredRunCount > 0) {
    actions.push("Run `tirionctl attribution reconcile` when you want deferred historical runs reconciled and synced.");
  }
  if (configuredProviderCount === 0) {
    issues.push("No local provider source configurations are present.");
    actions.push("Activate the repository you want to measure with `tirionctl repo activate /absolute/path/to/repo`.");
  } else if (sourceStatuses.every((item) => isRecord(item) && typeof item.measurementState === "string" && item.measurementState !== "complete")) {
    issues.push("Local providers are configured but no telemetry source is being accepted yet.");
    actions.push("Inspect `tirionctl logs` for TelemetryIngress rejects, then run `tirionctl repo activate /absolute/path/to/repo` to repair local source ownership.");
  }
  if (sourceStatuses.some((item) => isRecord(item) && Array.isArray(item.reasonCodes) && item.reasonCodes.includes("no_recent_receipt"))) {
    issues.push("One or more configured sources have no recent telemetry receipt.");
    actions.push("Run `tirionctl repo activate /absolute/path/to/repo` to repair source ownership and then generate a fresh run.");
  }
  if (webhookStatus && !recordString(webhookStatus, "url")) {
    issues.push("Webhook URL is not configured.");
    actions.push("Set the local webhook destination with `tirionctl webhook set-url <url>`.");
  }
  if (webhookStatus && webhookStatus.runEndedEnabled === false) {
    issues.push("Run webhook events are disabled.");
    actions.push("Re-enable run delivery with `tirionctl webhook enable-runs`.");
  }
  if (webhookStatus && numberValue(webhookStatus, "blockedCount") && (numberValue(webhookStatus, "blockedCount") ?? 0) > 0) {
    const blockedCount = numberValue(webhookStatus, "blockedCount") ?? 0;
    issues.push(`${blockedCount} webhook delivery${blockedCount === 1 ? " is" : "ies are"} blocked.`);
    actions.push("Inspect `tirionctl logs` for webhook delivery failures, then run `tirionctl webhook retry` after fixing the destination.");
  }
  if (webhookStatus && numberValue(webhookStatus, "queuedCount") && (numberValue(webhookStatus, "queuedCount") ?? 0) > 0) {
    actions.push("Webhook deliveries are queued locally; wait for them to drain automatically or run `tirionctl webhook retry`.");
  }
  if (warnings.length > 0) {
    actions.push(`Review the ${warnings.length} active budget warnings and thresholds.`);
  }

  const overall = deriveHealthOverall({
    blocked: !statusOutcome.ok
    || !credential
    || status?.health === "starting"
    || status?.health === "stopping"
    || status?.health === "degraded"
    || doctor?.databaseIntegrity === "failed"
    || (doctorChecks != null && Object.values(doctorChecks).some((value) => value !== true)),
    operationalIssueCount: issues.length
  });

  return {
    schemaVersion: 1,
    overall,
    agent: {
      ...checks,
      reachable: statusOutcome.ok,
      health: healthOutcome.ok ? healthOutcome.value.health : status?.health,
      ...(status ? {
        ownershipState: status.ownershipState,
        agentVersion: status.agentVersion,
        runtimeVersion: status.runtimeVersion,
        environmentId: status.environmentId,
        startedAt: status.startedAt,
        ...(status.runtimeWarmupState ? { runtimeWarmupState: status.runtimeWarmupState } : {}),
        ...(status.runtimeWarmupLastErrorCode ? { runtimeWarmupLastErrorCode: status.runtimeWarmupLastErrorCode } : {}),
        ...(status.fullOwnerBootstrapState ? { fullOwnerBootstrapState: status.fullOwnerBootstrapState } : {}),
        ...(status.fullOwnerBootstrapLastErrorCode ? { fullOwnerBootstrapLastErrorCode: status.fullOwnerBootstrapLastErrorCode } : {}),
        ...(status.historicalReconciliationState
          ? { historicalReconciliationState: status.historicalReconciliationState }
          : {}),
        ...(status.historicalReconciliationLastErrorCode
          ? { historicalReconciliationLastErrorCode: status.historicalReconciliationLastErrorCode }
          : {})
      } : {}),
      ...(version ? {
        protocol: version.protocol,
        databaseSchemaVersion: version.databaseSchemaVersion
      } : {}),
      ...(doctor ? {
        databaseIntegrity: doctor.databaseIntegrity,
        doctorChecks: doctor.checks
      } : {}),
      ...(statusOutcome.ok ? {} : { error: statusOutcome.error })
    },
    sources: doctorFacts ? {
      count: numberValue(doctorFacts, "sourceCount") ?? 0,
      providerConfigurationCount: configuredProviderCount,
      providers: doctorFacts.sourceProviders,
      statuses: sourceStatuses
    } : requestSectionError(sourcesOutcome),
    repositories: repositoriesOutcome.ok || doctorFacts ? {
      scopeCount: doctorFacts ? numberValue(doctorFacts, "repositoryScopeCount") ?? 0 : arrayLength(repositoriesOutcome.ok ? repositoriesOutcome.value.scopes : undefined),
      activeScopeCount: doctorFacts ? numberValue(doctorFacts, "activeRepositoryScopeCount") ?? 0 : undefined,
      unavailableScopeCount: doctorFacts ? numberValue(doctorFacts, "unavailableRepositoryScopeCount") ?? 0 : undefined,
      pausedScopeCount: doctorFacts ? numberValue(doctorFacts, "pausedRepositoryScopeCount") ?? 0 : undefined,
      workspaceLeaseCount: doctorFacts ? numberValue(doctorFacts, "workspaceLeaseCount") ?? 0 : undefined
    } : requestSectionError(repositoriesOutcome),
    webhook: webhookStatus ?? requestSectionError(webhookOutcome),
    budgets: budgetsOutcome.ok ? { warningCount: warnings.length, warnings } : requestSectionError(budgetsOutcome),
    issues: uniqueMessages(issues),
    actions: uniqueMessages(actions)
  };
}

async function emitLifecycleFollowUp(
  io: CliIo,
  command: "start" | "restart",
  startedStatus: Record<string, unknown>
): Promise<void> {
  if (!shouldRenderLifecycleSummary(io)) {
    return;
  }
  const followUp = await collectLifecycleFollowUp(io, startedStatus);
  io.stderr.write(renderLifecycleSummary(command, startedStatus, followUp));
}

async function collectLifecycleFollowUp(io: CliIo, startedStatus: Record<string, unknown>): Promise<LifecycleFollowUp> {
  let credential: string | undefined;
  try {
    credential = bootstrap(io);
  } catch {
    credential = undefined;
  }

  if (!credential) {
    const health = minimalHealthReport(startedStatus);
    return {
      health,
      repositories: undefined
    };
  }

  const health = await buildHealthReport(io);
  const repositories = await listRepositoryScopes(io, credential);
  return { health, repositories };
}

async function listRepositoryScopes(io: CliIo, credential: string): Promise<RepositoryScopeV1[] | undefined> {
  const outcome = await requestOutcome(io, "GET", "/v1/repositories", undefined, credential);
  return outcome.ok && Array.isArray(outcome.value.scopes)
    ? outcome.value.scopes as RepositoryScopeV1[]
    : undefined;
}

function shouldRenderLifecycleSummary(io: CliIo): boolean {
  return Boolean(
    (io.stderr as { isTTY?: boolean }).isTTY
    || (io.stdout as { isTTY?: boolean }).isTTY
  );
}

function renderLifecycleSummary(
  command: "start" | "restart",
  startedStatus: Record<string, unknown>,
  followUp: LifecycleFollowUp
): string {
  const lines = [
    `Tirion agent ${command} summary`,
    `- Agent: ${summarizeAgentLine(startedStatus, followUp.health)}`,
    `- Webhook: ${summarizeWebhookLine(followUp.health.webhook)}`,
    `- Local readiness: ${followUp.health.overall}`,
    `- Repository coverage: ${summarizeRepositoryCoverage(followUp.health.repositories)}`,
    `- Watched repositories: ${summarizeScopes(followUp.repositories, "repository")}`,
    `- Approved roots: ${summarizeScopes(followUp.repositories, "root")}`,
    `- Sources: ${summarizeSources(followUp.health.sources)}`,
    ...lifecycleActionLines(followUp),
    ""
  ];
  return lines.join("\n");
}

function summarizeAgentLine(startedStatus: Record<string, unknown>, health: HealthReport): string {
  const agent = health.agent;
  const healthValue = recordString(agent, "health") ?? recordString(startedStatus, "health") ?? "unknown";
  const ownership = recordString(agent, "ownershipState") ?? recordString(startedStatus, "ownershipState");
  const version = recordString(agent, "agentVersion") ?? recordString(startedStatus, "agentVersion");
  const warmup = recordString(agent, "runtimeWarmupState") ?? recordString(startedStatus, "runtimeWarmupState");
  return [
    healthValue,
    ownership ? `ownership ${ownership}` : undefined,
    version ? `version ${version}` : undefined,
    warmup ? `warmup ${warmup}` : undefined
  ].filter((item): item is string => Boolean(item)).join("; ");
}

function summarizeWebhookLine(webhook: Record<string, unknown>): string {
  if (recordString(webhook, "error")) {
    return "unavailable";
  }
  const urlConfigured = Boolean(recordString(webhook, "url"));
  const runEndedEnabled = webhook.runEndedEnabled !== false;
  const queuedCount = numberValue(webhook, "queuedCount") ?? 0;
  const blockedCount = numberValue(webhook, "blockedCount") ?? 0;
  return [
    urlConfigured ? "configured" : "not configured",
    runEndedEnabled ? "run events enabled" : "run events disabled",
    "commit attribution always on",
    `queued ${queuedCount}`,
    `blocked ${blockedCount}`
  ].join("; ");
}

function summarizeRepositoryCoverage(repositories: Record<string, unknown>): string {
  if (recordString(repositories, "error")) {
    return "unavailable";
  }
  const scopeCount = numberValue(repositories, "scopeCount") ?? 0;
  const activeScopeCount = numberValue(repositories, "activeScopeCount") ?? 0;
  const unavailableScopeCount = numberValue(repositories, "unavailableScopeCount") ?? 0;
  const pausedScopeCount = numberValue(repositories, "pausedScopeCount") ?? 0;
  return `${activeScopeCount}/${scopeCount} active${unavailableScopeCount > 0 ? `; ${unavailableScopeCount} unavailable` : ""}${pausedScopeCount > 0 ? `; ${pausedScopeCount} paused` : ""}`;
}

function summarizeState(section: Record<string, unknown>, key: string): string {
  return recordString(section, key) ?? "unknown";
}

function summarizeScopes(scopes: RepositoryScopeV1[] | undefined, kind: RepositoryScopeV1["kind"]): string {
  if (!scopes) {
    return "unavailable";
  }
  const labels = scopes
    .filter((scope) => scope.kind === kind && scope.state === "active")
    .map((scope) => scope.label);
  return labels.length > 0 ? labels.join(", ") : "none";
}

function summarizeSources(sources: Record<string, unknown>): string {
  const providerConfigurationCount = numberValue(sources, "providerConfigurationCount");
  const statuses = Array.isArray(sources.statuses) ? sources.statuses : [];
  if (typeof providerConfigurationCount === "number") {
    const accepting = statuses.filter((status) => isRecord(status) && status.measurementState === "complete").length;
    const blocked = statuses.filter((status) =>
      isRecord(status)
      && (status.configurationState === "conflict" || status.configurationState === "unavailable")).length;
    return `${providerConfigurationCount} provider configs (${accepting} accepting receipts${blocked > 0 ? `, ${blocked} blocked` : ""})`;
  }
  const count = numberValue(sources, "count");
  return typeof count === "number" ? `${count} configured` : "unavailable";
}

function lifecycleActionLines(followUp: LifecycleFollowUp): string[] {
  const lines: string[] = [];
  const repositoryScopes = followUp.repositories ?? [];
  const hasWatchedRepository = repositoryScopes.some((scope) => scope.kind === "repository" && scope.state === "active");
  const hasRoot = repositoryScopes.some((scope) => scope.kind === "root" && scope.state === "active");
  if (!hasWatchedRepository) {
    lines.push("- Activate a repository end to end: tirionctl repo activate /absolute/path/to/repo");
  }
  if (!hasRoot) {
    lines.push("- Add a discovery root: tirionctl repo watch-root /absolute/path/to/repos");
  }
  for (const issue of followUp.health.issues.slice(0, 3)) {
    lines.push(`- Attention: ${issue}`);
  }
  for (const action of followUp.health.actions.slice(0, 3)) {
    lines.push(`- Next: ${action}`);
  }
  return lines;
}

function recordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function minimalHealthReport(startedStatus: Record<string, unknown>): HealthReport {
  return {
    schemaVersion: 1,
    overall: "blocked",
    agent: {
      reachable: true,
      health: recordString(startedStatus, "health") ?? "unknown",
      ...(recordString(startedStatus, "ownershipState")
        ? { ownershipState: recordString(startedStatus, "ownershipState") }
        : {}),
      ...(recordString(startedStatus, "agentVersion")
        ? { agentVersion: recordString(startedStatus, "agentVersion") }
        : {}),
      ...(recordString(startedStatus, "runtimeWarmupState")
        ? { runtimeWarmupState: recordString(startedStatus, "runtimeWarmupState") }
        : {})
    },
    sources: { error: "authentication_required" },
    repositories: { scopeCount: 0, activeScopeCount: 0 },
    webhook: { error: "authentication_required" },
    budgets: { error: "authentication_required" },
    issues: ["Local bootstrap credential is missing."],
    actions: ["Recreate the local control bootstrap with `tirionctl init` or `tirionctl repair`."]
  };
}

async function requestOutcome(
  io: CliIo,
  method: string,
  path: string,
  body?: unknown,
  credential?: string
): Promise<RequestOutcome> {
  try {
    return { ok: true, value: await agentRequest(io, method, path, body, credential) };
  } catch (error) {
    return { ok: false, error: safeMessage(error) };
  }
}

function requestSectionError(outcome: RequestOutcome): Record<string, unknown> {
  return outcome.ok ? outcome.value : { error: outcome.error };
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function uniqueMessages(values: string[]): string[] {
  return [...new Set(values)];
}

async function ownership(args: string[], io: CliIo): Promise<number> {
  const [subcommand, target] = args;
  if (subcommand === "status") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", "/v1/ownership", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "readiness") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", "/v1/ownership/readiness", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "transition" && ["agent_shadow", "agent_usage_owner", "agent_full_owner"].includes(target ?? "")) {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/ownership/transition", {
      target
    }, bootstrap(io)))}\n`);
    return 0;
  }
  io.stderr.write("Use 'tirionctl ownership status|readiness|transition <state>'.\n");
  return 2;
}

async function repositories(args: string[], io: CliIo): Promise<number> {
  const [subcommand, value] = args;
  if (subcommand === "activate") {
    return await activateRepository(value ?? io.cwd ?? process.cwd(), args.slice(1), io);
  }
  if (subcommand === "watch") {
    return await watchRepositories(value ?? io.cwd ?? process.cwd(), io);
  }
  if (
    subcommand === "watch-root"
    || ((subcommand === "add" || subcommand === "add-root") && value)
  ) {
    const path = value ?? io.cwd ?? process.cwd();
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/repositories", {
      schemaVersion: 1,
      path,
      kind: subcommand === "add-root" || subcommand === "watch-root" ? "root" : "repository"
    }, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "list") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", "/v1/repositories", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "status" && value) {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", `/v1/repositories/${encodeURIComponent(value)}`, undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if ((subcommand === "pause" || subcommand === "resume") && value) {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", `/v1/repositories/${encodeURIComponent(value)}/${subcommand}`, undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "remove" && value) {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "DELETE", `/v1/repositories/${encodeURIComponent(value)}`, undefined, bootstrap(io)))}\n`);
    return 0;
  }
  io.stderr.write("Use 'tirionctl repo activate <path> [--provider auto|claude-code|codex|cursor|github-copilot]|watch [path]|watch-root [path]|add <path>|add-root <path>|list|status|pause|resume|remove'.\n");
  return 2;
}

async function activateRepository(path: string, args: string[], io: CliIo): Promise<number> {
  const provider = optionValue(args, "--provider");
  if (provider && !["auto", "claude-code", "codex", "cursor", "github-copilot"].includes(provider)) {
    io.stderr.write("Use '--provider auto', '--provider claude-code', '--provider codex', '--provider cursor', or '--provider github-copilot'.\n");
    return 2;
  }
  const result = await agentRequest(io, "POST", "/v1/repositories/activate", {
    schemaVersion: 1,
    path,
    ...(provider ? { provider } : {})
  }, bootstrap(io)) as RepositoryActivationV1;
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return result.activationState === "blocked" ? 2 : 0;
}

async function watchRepositories(path: string, io: CliIo): Promise<number> {
  if (looksLikeGitRepository(path)) {
    io.stdout.write(`${JSON.stringify(await enrollScope(path, "repository", io))}\n`);
    return 0;
  }
  const repositories = discoverRepositoriesUnderRoot(path);
  if (repositories.length === 0) {
    io.stderr.write(`No Git repositories were found under ${path}.\n`);
    return 2;
  }
  if (repositories.length === 1) {
    io.stdout.write(`${JSON.stringify(await enrollScope(repositories[0], "repository", io))}\n`);
    return 0;
  }
  const confirmed = await confirm(io, `${repositories.length} repositories in folder - watch all? [y/N] `);
  if (!confirmed) {
    io.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      watched: 0,
      declined: true,
      repositoryCount: repositories.length
    })}\n`);
    return 0;
  }
  const scopes = [];
  for (const repository of repositories) {
    scopes.push(await enrollScope(repository, "repository", io));
  }
  io.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    watched: scopes.length,
    scopes
  })}\n`);
  return 0;
}

async function enrollScope(path: string, kind: "repository" | "root", io: CliIo): Promise<Record<string, unknown>> {
  return await agentRequest(io, "POST", "/v1/repositories", {
    schemaVersion: 1,
    path,
    kind
  }, bootstrap(io));
}

async function confirm(io: CliIo, prompt: string): Promise<boolean> {
  if (io.confirm) {
    return await io.confirm(prompt);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(prompt)).trim();
    return answer === "y" || answer === "Y";
  } finally {
    rl.close();
  }
}

const MAX_WATCH_SCAN_REPOSITORIES = 500;
const MAX_WATCH_SCAN_DEPTH = 6;
const WATCH_SCAN_SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

function discoverRepositoriesUnderRoot(root: string): string[] {
  const repositories: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0 && repositories.length < MAX_WATCH_SCAN_REPOSITORIES) {
    const current = queue.shift()!;
    if (seen.has(current.path)) {
      continue;
    }
    seen.add(current.path);
    if (!isDirectory(current.path)) {
      continue;
    }
    if (looksLikeGitRepository(current.path)) {
      repositories.push(current.path);
      continue;
    }
    if (current.depth >= MAX_WATCH_SCAN_DEPTH) {
      continue;
    }
    for (const entry of safeReadDirectories(current.path)) {
      if (WATCH_SCAN_SKIPPED_DIRECTORIES.has(entry)) {
        continue;
      }
      queue.push({ path: join(current.path, entry), depth: current.depth + 1 });
    }
  }

  return repositories;
}

function safeReadDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeGitRepository(path: string): boolean {
  try {
    return statSync(join(path, ".git")).isDirectory() || existsSync(join(path, ".git"));
  } catch {
    return false;
  }
}

async function configure(args: string[], io: CliIo): Promise<number> {
  const restoring = args[0] === "restore";
  const provider = restoring ? args[1] : args[0];
  if (provider === "github-copilot") {
    return await configureGithubCopilot(restoring ? args.slice(2) : args.slice(1), io, restoring);
  }
  if (provider !== "claude-code" && provider !== "codex" && provider !== "cursor") {
    io.stderr.write("Use 'tirionctl configure claude-code|codex|cursor|github-copilot' or 'tirionctl configure restore claude-code|codex|cursor|github-copilot'.\n");
    return 2;
  }
  if (args.includes("--no-capture-prompts") && args.includes("--capture-prompts")) {
    io.stderr.write("Choose either --capture-prompts or --no-capture-prompts.\n");
    return 2;
  }
  const capturePrompts = args.includes("--capture-prompts");
  const result = await restoreProviderConfiguration(provider, io, restoring, capturePrompts);
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === "conflict" || result.status === "unavailable" ? 2 : 0;
}

async function configureGithubCopilot(args: string[], io: CliIo, restoring: boolean): Promise<number> {
  if (restoring) {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/provider-sources/github-copilot/span-db", {
      schemaVersion: 1,
      enabled: false,
      captureContent: false,
      dbSpanExporter: false
    }, bootstrap(io)))}\n`);
    return 0;
  }
  const spanDbPath = optionValue(args, "--span-db");
  if (!spanDbPath || !isAbsolute(spanDbPath)) {
    io.stderr.write("Use 'tirionctl configure github-copilot --span-db /absolute/path/to/agent-traces.db'.\n");
    return 2;
  }
  if (args.includes("--capture-content") && args.includes("--no-capture-content")) {
    io.stderr.write("Choose either --capture-content or --no-capture-content.\n");
    return 2;
  }
  const captureContent = args.includes("--capture-content");
  io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/provider-sources/github-copilot/span-db", {
    schemaVersion: 1,
    enabled: true,
    spanDbPath,
    captureContent,
    dbSpanExporter: true
  }, bootstrap(io)))}\n`);
  return 0;
}

async function shadow(args: string[], io: CliIo): Promise<number> {
  if (args[0] !== "compare" || !args[1]) {
    io.stderr.write("Use 'tirionctl shadow compare <expected-totals-json>'.\n");
    return 2;
  }
  let expected: unknown;
  try {
    expected = JSON.parse(args[1]);
  } catch {
    io.stderr.write("Expected totals must be valid JSON.\n");
    return 2;
  }
  io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/shadow/compare", expected, bootstrap(io)))}\n`);
  return 0;
}

async function clearAgentData(args: string[], io: CliIo): Promise<number> {
  const allowed = new Set(["--confirm"]);
  const unknown = args.find((arg) => !allowed.has(arg));
  if (unknown) {
    io.stderr.write(`Unknown clear-agent-data option: ${unknown}\n`);
    return 2;
  }
  if (!args.includes("--confirm")) {
    io.stderr.write("Clearing all local agent data requires --confirm.\n");
    return 2;
  }
  io.stdout.write(`${JSON.stringify(await agentRequest(io, "POST", "/v1/clear-agent-data", {
    schemaVersion: 1
  }, bootstrap(io)))}\n`);
  return 0;
}

async function sources(args: string[], io: CliIo): Promise<number> {
  const [subcommand, provider] = args;
  if (subcommand === "list") {
    io.stdout.write(`${JSON.stringify(await agentRequest(io, "GET", "/v1/sources", undefined, bootstrap(io)))}\n`);
    return 0;
  }
  if (subcommand === "test" && provider) {
    io.stdout.write(`${JSON.stringify(await agentRequest(
      io,
      "GET",
      `/v1/sources/${encodeURIComponent(provider)}/test`,
      undefined,
      bootstrap(io)
    ))}\n`);
    return 0;
  }
  if ((subcommand === "restore" || subcommand === "remove") && (provider === "claude-code" || provider === "codex" || provider === "cursor")) {
    const result = await restoreProviderConfiguration(provider, io, true);
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "conflict" || result.status === "unavailable" ? 2 : 0;
  }
  io.stderr.write("Use 'tirionctl sources list|test <source-id>' or 'tirionctl sources restore|remove claude-code|codex|cursor'.\n");
  return 2;
}

async function restoreProviderConfiguration(
  provider: "claude-code" | "codex" | "cursor",
  io: CliIo,
  restoring: boolean,
  capturePrompts = false
): Promise<Record<string, unknown>> {
  return await agentRequest(
    io,
    "POST",
    restoring ? `/v1/configure/${provider}/restore` : `/v1/configure/${provider}`,
    restoring ? undefined : { capturePrompts },
    bootstrap(io)
  );
}

async function usagePrefix(io: CliIo): Promise<"/v1" | "/v1/shadow"> {
  const ownership = await agentRequest(io, "GET", "/v1/ownership", undefined, bootstrap(io));
  return ownership.state === "agent_usage_owner" || ownership.state === "agent_full_owner" ? "/v1" : "/v1/shadow";
}

async function printVersion(io: CliIo): Promise<void> {
  const version = await agentRequest(io, "GET", "/v1/version").catch(() => ({
    schemaVersion: 1,
    agentVersion: CLI_VERSION,
    runtimeVersion: process.version,
    protocol: { major: 1, minor: 0 },
    databaseSchemaVersion: AGENT_DATABASE_SCHEMA_VERSION,
    agentReachable: false
  }));
  io.stdout.write(`${JSON.stringify(version)}\n`);
}

async function doctor(io: CliIo): Promise<number> {
  const checks: Record<string, unknown> = {
    agentReachable: false,
    statusReadable: false,
    versionReadable: false,
    bootstrapPresent: false
  };
  try {
    await agentRequest(io, "GET", "/v1/health");
    checks.agentReachable = true;
    await agentRequest(io, "GET", "/v1/status");
    checks.statusReadable = true;
    await agentRequest(io, "GET", "/v1/version");
    checks.versionReadable = true;
    const agentDoctor = await agentRequest(io, "GET", "/v1/doctor", undefined, bootstrap(io));
    checks.agentDoctor = agentDoctor;
  } catch {
    // Doctor reports booleans instead of leaking transport internals.
  }
  try {
    bootstrap(io);
    checks.bootstrapPresent = true;
  } catch {
    checks.bootstrapPresent = false;
  }
  checks.platform = currentPlatform(io);
  checks.serviceRegistrationPresent = currentPlatform(io) === "darwin"
    ? existsSync(serviceDefinition(io).plistPath)
    : false;
  checks.packagedInstallPresent = existsSync(join(io.packagedInstallRoot ?? "/Applications/Tirion", "bin", "tirion-agent"));
  checks.stateDirectoryPresent = existsSync(resolveAgentPaths(io.env).stateDir);
  io.stdout.write(`${JSON.stringify({ schemaVersion: 1, checks })}\n`);
  const agentDoctor = isRecord(checks.agentDoctor) ? checks.agentDoctor : undefined;
  const doctorChecks = agentDoctor && isRecord(agentDoctor.checks) ? agentDoctor.checks : undefined;
  return checks.agentReachable
    && agentDoctor?.health === "healthy"
    && agentDoctor.databaseIntegrity === "ok"
    && doctorChecks?.singleOwner === true
    && doctorChecks.storageWorker === true
    && doctorChecks.protocolCompatible === true
    && doctorChecks.privateStateDirectory === true
    && doctorChecks.privateControlSocket === true
    ? 0
    : 1;
}

function service(args: string[], io: CliIo): number {
  const [subcommand] = args;
  if (currentPlatform(io) !== "darwin") {
    io.stderr.write("Per-user service installation is currently supported on macOS only.\n");
    return 2;
  }
  const definition = serviceDefinition(io);
  if (subcommand === "install") {
    writeMacOsLaunchAgent(definition);
    registerMacOsService(definition, io);
    io.stdout.write(`${jsonLine({ service: definition.label, installed: true, registered: true })}\n`);
    return 0;
  }
  if (subcommand === "uninstall") {
    bootoutMacOsService(definition.label, io);
    rmSync(definition.plistPath, { force: true });
    io.stdout.write(`${jsonLine({ service: definition.label, installed: false })}\n`);
    return 0;
  }
  io.stderr.write("Use 'tirionctl service install' or 'tirionctl service uninstall'.\n");
  return 2;
}

async function repair(io: CliIo): Promise<number> {
  if (currentPlatform(io) === "darwin") {
    service(["install"], { ...io, stdout: { write: () => undefined } });
    io.stdout.write(`${jsonLine({ repaired: true, status: await waitForHealthy(io) })}\n`);
    return 0;
  }
  await stopAgentBestEffort(io);
  return start(io);
}

async function initialize(io: CliIo): Promise<number> {
  if (currentPlatform(io) === "darwin") {
    service(["install"], { ...io, stdout: { write: () => undefined } });
    io.stdout.write(`${jsonLine({ initialized: true, status: await waitForHealthy(io) })}\n`);
    return 0;
  }
  return await start(io);
}

async function stop(io: CliIo): Promise<number> {
  await stopAgentBestEffort(io);
  if (currentPlatform(io) === "darwin") {
    const definition = serviceDefinition(io);
    bootoutMacOsService(definition.label, io);
  }
  io.stdout.write(`${jsonLine({ stopped: true, serviceRegistered: currentPlatform(io) !== "darwin" })}\n`);
  return 0;
}

async function restart(io: CliIo): Promise<number> {
  let startedStatus: Record<string, unknown>;
  if (currentPlatform(io) === "darwin") {
    restartMacOsService(serviceDefinition(io), io);
    startedStatus = await waitForHealthy(io);
  } else {
    await stopAgentBestEffort(io);
    startedStatus = await startAgentProcess(io);
  }
  io.stdout.write(`${JSON.stringify(startedStatus)}\n`);
  await emitLifecycleFollowUp(io, "restart", startedStatus);
  return 0;
}

async function upgrade(args: string[], io: CliIo): Promise<number> {
  const packagePath = requiredConfirmedPackage(args, io);
  if (!packagePath) {
    return 2;
  }
  const signature = validateSignedInstaller(packagePath, io);
  const before = await agentRequest(io, "GET", "/v1/version");
  const certificate = inspectInstaller(packagePath, io);
  validateInstallerIdentity(certificate, signature);
  validateUpgradeCompatibility(certificate, before);
  const preparation = await agentRequest(io, "POST", "/v1/maintenance/prepare-upgrade", undefined, bootstrap(io));
  await stopAgentBestEffort(io);
  if (currentPlatform(io) === "darwin") {
    service(["uninstall"], { ...io, stdout: { write: () => undefined } });
  }
  await waitForStopped(io);
  installPackage(packagePath, io);
  if (currentPlatform(io) === "darwin") {
    service(["install"], { ...io, stdout: { write: () => undefined } });
  }
  const after = await waitForHealthy(io);
  io.stdout.write(`${jsonLine({
    upgraded: true,
    previousAgentVersion: before.agentVersion,
    agentVersion: after.agentVersion,
    backupPrepared: preparation.backupAvailable === true
  })}\n`);
  return 0;
}

async function rollback(args: string[], io: CliIo): Promise<number> {
  const packagePath = requiredConfirmedPackage(args, io);
  if (!packagePath) {
    return 2;
  }
  const signature = validateSignedInstaller(packagePath, io);
  const current = await agentRequest(io, "GET", "/v1/version");
  const rollbackInfo = await agentRequest(io, "GET", "/v1/maintenance/rollback-info", undefined, bootstrap(io));
  const certificate = inspectInstaller(packagePath, io);
  validateInstallerIdentity(certificate, signature);
  validateRollbackCompatibility(certificate, current, rollbackInfo);
  await stopAgentBestEffort(io);
  if (currentPlatform(io) === "darwin") {
    service(["uninstall"], { ...io, stdout: { write: () => undefined } });
  }
  await waitForStopped(io);
  execute(io, process.execPath, [agentEntry(io), "maintenance", "restore-pre-upgrade"]);
  installPackage(packagePath, io);
  if (currentPlatform(io) === "darwin") {
    service(["install"], { ...io, stdout: { write: () => undefined } });
  }
  const status = await waitForHealthy(io);
  io.stdout.write(`${jsonLine({ rolledBack: true, agentVersion: status.agentVersion, databaseRestored: true })}\n`);
  return 0;
}

function requiredConfirmedPackage(args: string[], io: CliIo): string | undefined {
  if (currentPlatform(io) !== "darwin") {
    io.stderr.write("Signed-package upgrade and rollback are currently supported on macOS only.\n");
    return undefined;
  }
  const packagePath = optionValue(args, "--package");
  if (!packagePath || !args.includes("--confirm")) {
    io.stderr.write("A signed absolute --package <path> and --confirm are required.\n");
    return undefined;
  }
  if (!isAbsolute(packagePath) || !packagePath.endsWith(".pkg") || !existsSync(packagePath) || !statSync(packagePath).isFile()) {
    io.stderr.write("The signed installer package is invalid.\n");
    return undefined;
  }
  return packagePath;
}

function validateSignedInstaller(packagePath: string, io: CliIo): string {
  const signature = capture(io, "/usr/sbin/pkgutil", ["--check-signature", packagePath]);
  if (!signature.includes("Developer ID Installer:")) {
    throw new Error("invalid_request");
  }
  execute(io, "/usr/bin/xcrun", ["stapler", "validate", packagePath]);
  execute(io, "/usr/sbin/spctl", ["--assess", "--type", "install", packagePath]);
  return signature;
}

function inspectInstaller(packagePath: string, io: CliIo): InstallerBirthCertificate {
  if (io.inspectPackage) {
    return io.inspectPackage(packagePath);
  }
  const expanded = mkdtempSync(join(tmpdir(), "tirion-installer-inspection-"));
  try {
    execute(io, "/usr/sbin/pkgutil", ["--expand-full", packagePath, expanded]);
    const certificatePath = findNamedFile(expanded, "birth-certificate.json");
    if (!certificatePath) {
      throw new Error("invalid_request");
    }
    return parseInstallerBirthCertificate(JSON.parse(readFileSync(certificatePath, "utf8")));
  } finally {
    rmSync(expanded, { recursive: true, force: true });
  }
}

function findNamedFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findNamedFile(path, name);
      if (nested) {
        return nested;
      }
    } else if (entry.name === name) {
      return path;
    }
  }
  return undefined;
}

function parseInstallerBirthCertificate(value: unknown): InstallerBirthCertificate {
  if (!isRecord(value) || !isRecord(value.artifact) || !isRecord(value.migrationSupportWindow)) {
    throw new Error("invalid_request");
  }
  const certificate = value as InstallerBirthCertificate;
  if (
    typeof certificate.agentVersion !== "string"
    || !Number.isSafeInteger(certificate.databaseSchemaVersion)
    || certificate.artifact.packageIdentifier !== "dev.tirion.agent"
    || typeof certificate.artifact.signingIdentity !== "string"
    || !certificate.artifact.signingIdentity.startsWith("Developer ID Installer:")
    || certificate.artifact.notarization !== "required-and-verified"
    || !Number.isSafeInteger(certificate.migrationSupportWindow.minimumDatabaseSchemaVersion)
    || !Number.isSafeInteger(certificate.migrationSupportWindow.maximumDatabaseSchemaVersion)
    || certificate.migrationSupportWindow.legacyExtensionHistoryMigration !== "unsupported"
  ) {
    throw new Error("invalid_request");
  }
  return certificate;
}

function validateInstallerIdentity(certificate: InstallerBirthCertificate, signature: string): void {
  if (!signature.includes(certificate.artifact.signingIdentity)) {
    throw new Error("invalid_request");
  }
}

function validateUpgradeCompatibility(certificate: InstallerBirthCertificate, current: Record<string, unknown>): void {
  const currentVersion = typeof current.agentVersion === "string" ? current.agentVersion : "";
  const currentSchema = Number(current.databaseSchemaVersion);
  if (
    compareVersions(certificate.agentVersion, currentVersion) <= 0
    || !Number.isSafeInteger(currentSchema)
    || currentSchema < certificate.migrationSupportWindow.minimumDatabaseSchemaVersion
    || currentSchema > certificate.migrationSupportWindow.maximumDatabaseSchemaVersion
    || certificate.databaseSchemaVersion < currentSchema
  ) {
    throw new Error("unsupported_capability");
  }
}

function validateRollbackCompatibility(
  certificate: InstallerBirthCertificate,
  current: Record<string, unknown>,
  rollbackInfo: Record<string, unknown>
): void {
  const currentVersion = typeof current.agentVersion === "string" ? current.agentVersion : "";
  const backupVersion = typeof rollbackInfo.agentVersion === "string" ? rollbackInfo.agentVersion : "";
  const backupSchema = Number(rollbackInfo.databaseSchemaVersion);
  if (
    rollbackInfo.backupAvailable !== true
    || compareVersions(certificate.agentVersion, currentVersion) > 0
    || certificate.agentVersion !== backupVersion
    || !Number.isSafeInteger(backupSchema)
    || backupSchema < certificate.migrationSupportWindow.minimumDatabaseSchemaVersion
    || backupSchema > certificate.migrationSupportWindow.maximumDatabaseSchemaVersion
    || certificate.databaseSchemaVersion < backupSchema
  ) {
    throw new Error("unsupported_capability");
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : undefined;
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) {
    throw new Error("invalid_request");
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function installPackage(packagePath: string, io: CliIo): void {
  executeInteractive(io, "sudo", ["/usr/sbin/installer", "-pkg", packagePath, "-target", "/"]);
}

async function waitForHealthy(io: CliIo): Promise<Record<string, unknown>> {
  if (io.waitForHealthy) {
    return await io.waitForHealthy();
  }
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const status = await agentRequest(io, "GET", "/v1/status").catch(() => undefined);
    if (status?.health === "healthy") {
      return status;
    }
    await delay(100);
  }
  throw new Error("agent_unavailable");
}

async function waitForStopped(io: CliIo): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!await agentRequest(io, "GET", "/v1/status").then(() => true).catch(() => false)) {
      return;
    }
    await delay(100);
  }
  throw new Error("ownership_conflict");
}

async function start(io: CliIo): Promise<number> {
  if (currentPlatform(io) === "darwin") {
    service(["install"], { ...io, stdout: { write: () => undefined } });
    const status = await waitForHealthy(io);
    io.stdout.write(`${JSON.stringify(status)}\n`);
    await emitLifecycleFollowUp(io, "start", status);
    return 0;
  }
  const status = await startAgentProcess(io);
  io.stdout.write(`${JSON.stringify(status)}\n`);
  await emitLifecycleFollowUp(io, "start", status);
  return 0;
}

async function startAgentProcess(io: CliIo): Promise<Record<string, unknown>> {
  const entry = agentEntry(io);
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: io.env
  });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100);
    const status = await agentRequest(io, "GET", "/v1/status").catch(() => undefined);
    if (status) {
      return status;
    }
  }
  io.stderr.write("tirion-agent did not become reachable.\n");
  throw new Error("agent_unavailable");
}

function agentEntry(io: CliIo): string {
  return io.env.TIRION_AGENT_ENTRY ?? join(__dirname, "..", "..", "agent", "dist", "main.js");
}

function serviceDefinition(io: CliIo): ReturnType<typeof macOsLaunchAgent> {
  return io.serviceDefinition ?? macOsLaunchAgent(agentEntry(io), process.execPath, io.env);
}

async function uninstall(args: string[], io: CliIo): Promise<number> {
  const purge = args.includes("--purge");
  const removeBinaries = args.includes("--remove-binaries");
  if ((purge || removeBinaries) && !args.includes("--confirm")) {
    io.stderr.write("Refusing destructive uninstall operation without --confirm.\n");
    return 2;
  }
  const providerRestoration = await restoreProvidersBestEffort(io);
  await stopAgentBestEffort(io);
  if (currentPlatform(io) === "darwin") {
    service(["uninstall"], { ...io, stdout: { write: () => undefined } });
  }
  if (purge) {
    rmSync(resolveAgentPaths(io.env).stateDir, { recursive: true, force: true });
  }
  const binariesRemoved = removeBinaries ? removePackagedBinaries(io) : false;
  io.stdout.write(`${jsonLine({
    serviceUninstalled: true,
    binariesRemoved,
    dataPreserved: !purge,
    providerRestoration
  })}\n`);
  return 0;
}

async function restoreProvidersBestEffort(io: CliIo): Promise<{
  restored: string[];
  notManaged: string[];
  conflicts: string[];
  unavailable: boolean;
}> {
  const summary = { restored: [] as string[], notManaged: [] as string[], conflicts: [] as string[], unavailable: false };
  for (const provider of ["claude-code", "codex", "cursor"] as const) {
    try {
      const result = await restoreProviderConfiguration(provider, io, true);
      if (result.status === "restored") {
        summary.restored.push(provider);
      } else if (result.status === "not_managed") {
        summary.notManaged.push(provider);
      } else {
        summary.conflicts.push(provider);
      }
    } catch {
      summary.unavailable = true;
    }
  }
  return summary;
}

async function stopAgentBestEffort(io: CliIo): Promise<void> {
  let credential: string | undefined;
  try {
    credential = bootstrap(io);
  } catch {
    // An absent bootstrap credential means the agent is already unavailable
    // or this installation is incomplete; lifecycle cleanup must still work.
  }
  await agentRequest(io, "POST", "/v1/stop", undefined, credential).catch(() => undefined);
}

function removePackagedBinaries(io: CliIo): boolean {
  const installRoot = io.packagedInstallRoot ?? detectedPackagedInstallRoot(io);
  if (!installRoot) {
    throw new Error("unsupported_capability");
  }
  executeInteractive(io, "sudo", ["/bin/rm", "-rf", installRoot]);
  executeInteractive(io, "sudo", ["/bin/rm", "-f", "/usr/local/bin/tirionctl", "/usr/local/bin/tirion-agent"]);
  executeInteractive(io, "sudo", ["/usr/sbin/pkgutil", "--forget", "dev.tirion.agent"]);
  return true;
}

function detectedPackagedInstallRoot(io: CliIo): string | undefined {
  const expected = "/Applications/Tirion";
  return agentEntry(io).startsWith(`${expected}/`)
    ? expected
    : undefined;
}

function registerMacOsService(definition: ReturnType<typeof macOsLaunchAgent>, io: CliIo): void {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  bootoutMacOsService(definition.label, io);
  bootstrapMacOsService(domain, definition, io);
  execute(io, "launchctl", ["kickstart", "-k", `${domain}/${definition.label}`]);
}

function bootstrapMacOsService(domain: string, definition: ReturnType<typeof macOsLaunchAgent>, io: CliIo): void {
  // `launchctl bootstrap` fails with a transient "Input/output error" (errno 5)
  // when the previous instance is still tearing down after `bootout`. Re-clear
  // the job and retry with a short settle so `tirionctl start`/`restart` are
  // not flaky across rapid stop/start cycles.
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      execute(io, "launchctl", ["bootstrap", domain, definition.plistPath]);
      return;
    } catch (error) {
      lastError = error;
      bootoutMacOsService(definition.label, io);
      sleepSync(200);
    }
  }
  throw lastError ?? new Error("agent_unavailable");
}

function restartMacOsService(definition: ReturnType<typeof macOsLaunchAgent>, io: CliIo): void {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  try {
    execute(io, "launchctl", ["kickstart", "-k", `${domain}/${definition.label}`]);
  } catch {
    writeMacOsLaunchAgent(definition);
    registerMacOsService(definition, io);
  }
}

function bootoutMacOsService(label: string, io: CliIo): void {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  try {
    execute(io, "launchctl", ["bootout", `${domain}/${label}`]);
  } catch {
    // A missing service is already unregistered.
  }
}

function execute(io: CliIo, command: string, args: string[]): void {
  if (io.execFile) {
    io.execFile(command, args);
    return;
  }
  execFileSync(command, args, { stdio: "ignore" });
}

function capture(io: CliIo, command: string, args: string[]): string {
  if (io.execFile) {
    return String(io.execFile(command, args) ?? "");
  }
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function executeInteractive(io: CliIo, command: string, args: string[]): void {
  if (io.execFile) {
    io.execFile(command, args);
    return;
  }
  execFileSync(command, args, { stdio: "inherit" });
}

function resolveTuiBinary(io: CliIo): string | undefined {
  const override = io.env.TIRION_TUI_PATH;
  if (override) {
    return executableFile(override) ? override : undefined;
  }
  const candidates = [
    join(io.packagedInstallRoot ?? "/Applications/Tirion", "bin", "tirion-tui"),
    join(__dirname, "..", "..", "tirion-tui", "tirion-tui"),
    join(io.cwd ?? process.cwd(), "packages", "tirion-tui", "tirion-tui")
  ];
  return candidates.find(executableFile) ?? findExecutableOnPath("tirion-tui", io.env);
}

function executableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findExecutableOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (executableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function currentPlatform(io: CliIo): NodeJS.Platform {
  return io.platform ?? process.platform;
}

async function agentRequest(io: CliIo, method: string, path: string, body?: unknown, credential?: string): Promise<Record<string, unknown>> {
  const encoded = body == null ? undefined : Buffer.from(JSON.stringify(body));
  const socketPath = resolveAgentPaths(io.env).socketPath;
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
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(typeof parsed.error === "string" ? parsed.error : "agent_unavailable"));
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", () => reject(new Error("agent_unavailable")));
    if (encoded) {
      req.write(encoded);
    }
    req.end();
  });
}

function bootstrap(io: CliIo): string {
  return readFileSync(resolveAgentPaths(io.env).bootstrapTokenPath, "utf8").trim();
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function optionInteger(args: string[], option: string): number | undefined {
  const value = Number(optionValue(args, option));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function limitQuery(args: string[]): string {
  const raw = optionValue(args, "--limit");
  return raw ? `?limit=${encodeURIComponent(raw)}` : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe = new Set([
    "agent_unavailable",
    "authentication_required",
    "authorization_denied",
    "client_revoked",
    "invalid_request",
    "protocol_major_mismatch",
    "unsupported_capability",
    "ownership_conflict",
    "storage_unavailable",
    "internal_error"
  ]);
  return safe.has(message) ? message : "agent_unavailable";
}

function jsonLine(value: unknown): string {
  return JSON.stringify({ schemaVersion: 1, ...value as Record<string, unknown> });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function helpText(): string {
  return [
    "tirionctl commands:",
    "  init",
    "  status",
    "  health",
    "  doctor",
    "  diagnostics",
    "  logs [--limit N]",
    "  support-bundle",
    "  app",
    "  version",
    "  start | stop | restart | repair",
    "  upgrade --package <signed.pkg> --confirm",
    "  rollback --package <previous-signed.pkg> --confirm",
    "  service install | service uninstall",
    "  sources list | sources test <source-id> | sources restore|remove claude-code|codex|cursor",
    "  configure claude-code|codex|cursor [--capture-prompts|--no-capture-prompts] | configure github-copilot --span-db <path>",
    "  configure restore claude-code|codex|cursor|github-copilot",
    "  repo activate <path> [--provider auto|claude-code|codex|cursor|github-copilot] | repo watch [path] | repo watch-root [path] | repo add <path> | repo add-root <path> | repo list",
    "  repo status|pause|resume|remove <scope-id>",
    "  attribution list [--limit N] | attribution export [--csv] | attribution reconcile",
    "  webhook status | webhook set-url <url> | webhook set-token <token> | webhook clear-token | webhook set-secret <secret> | webhook clear-secret",
    "  webhook set-sender --name <name> [--team <team>] [--image-url <url>] | webhook clear-sender",
    "  webhook enable-runs | webhook disable-runs | webhook test | webhook retry",
    "  dashboard [--limit N]",
    "  report [--output <path>]",
    "  budget status",
    "  budget set --run-tokens N --run-estimated-nano-usd N --daily-estimated-nano-usd N --monthly-estimated-nano-usd N",
    "  runs [--current] [--limit N] | totals | export [--csv]",
    "  clear-history",
    "  clear-agent-data --confirm",
    "  shadow compare <expected-totals-json>",
    "  ownership status | ownership readiness | ownership transition <state>",
    "  uninstall [--purge --confirm] [--remove-binaries --confirm]",
    ""
  ].join("\n");
}

function defaultIo(): CliIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr
  };
}
