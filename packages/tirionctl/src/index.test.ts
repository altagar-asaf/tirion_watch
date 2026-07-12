import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "@tirion/agent";
import {
  deriveHealthOverall,
  runTirionCtl
} from "./index";
import type { AgentPaths } from "@tirion/platform";

const roots: string[] = [];
const agents: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.stop()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("tirionctl", () => {
  it("reports status for a running standalone agent", async () => {
    const { env } = await startAgent();
    const output = buffer();
    expect(await runTirionCtl(["status"], { env, stdout: output, stderr: buffer() })).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({ health: "healthy", ownershipState: "agent_shadow" });
  });

  it("exposes shadow runs without pretending they are production", async () => {
    const { env } = await startAgent();
    const output = buffer();
    expect(await runTirionCtl(["runs"], { env, stdout: output, stderr: buffer() })).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({ shadow: true, runs: [] });
    const totals = buffer();
    expect(await runTirionCtl(["totals"], { env, stdout: totals, stderr: buffer() })).toBe(0);
    expect(JSON.parse(totals.text())).toMatchObject({ shadow: true, runCount: 0 });
  });

  it("queries in-flight production runs separately from completed history", async () => {
    const { env } = await startAgent("agent_full_owner");
    const output = buffer();
    expect(await runTirionCtl(["runs", "--current"], { env, stdout: output, stderr: buffer() })).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({ production: true, current: true, runs: [] });
  });

  it("renders an empty commit and run dashboard for a fresh full-owner agent", async () => {
    const { env } = await startAgent("agent_full_owner");
    const output = buffer();
    expect(await runTirionCtl(["dashboard"], { env, stdout: output, stderr: buffer() })).toBe(0);
    expect(output.text()).toBe([
      "Start at: no runs recorded",
      "",
      "Commits by provider cost:",
      "  (none)",
      "",
      "Runs by provider:",
      "  (none)",
      ""
    ].join("\n"));
  });

  it("opens the terminal app through a resolved TUI binary when the agent is already reachable", async () => {
    const { env } = await startAgent();
    const root = mkdtempSync(join(tmpdir(), "tirionctl-app-"));
    roots.push(root);
    const tuiPath = join(root, "tirion-tui");
    writeFileSync(tuiPath, "#!/bin/sh\n", { mode: 0o755 });
    const executed: string[] = [];

    expect(await runTirionCtl(["app"], {
      env: { ...env, TIRION_TUI_PATH: tuiPath },
      stdout: buffer(),
      stderr: buffer(),
      execFile(command, args) {
        executed.push(`${command} ${args.join(" ")}`.trim());
      }
    })).toBe(0);

    expect(executed).toEqual([tuiPath]);
  });

  it("starts the agent before opening the terminal app when unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirionctl-app-start-"));
    roots.push(root);
    const tuiPath = join(root, "tirion-tui");
    const plistPath = join(root, "dev.tirion.agent.plist");
    writeFileSync(tuiPath, "#!/bin/sh\n", { mode: 0o755 });
    const calls: string[] = [];
    let healthyChecks = 0;
    const stdout = buffer();

    expect(await runTirionCtl(["app"], {
      env: {
        ...process.env,
        TIRION_TUI_PATH: tuiPath,
        TIRION_AGENT_STATE_DIR: join(root, "state"),
        TIRION_AGENT_SOCKET: join(root, "agent.sock")
      },
      stdout,
      stderr: buffer(),
      platform: "darwin" as const,
      serviceDefinition: {
        label: "dev.tirion.agent" as const,
        plistPath,
        content: "<plist></plist>\n"
      },
      execFile(command, args) {
        calls.push(`${command} ${args.join(" ")}`.trim());
      },
      async waitForHealthy() {
        healthyChecks += 1;
        return { health: "healthy", agentVersion: "0.1.6" };
      }
    })).toBe(0);

    expect(stdout.text()).toBe("");
    expect(healthyChecks).toBe(1);
    expect(existsSync(plistPath)).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([
      expect.stringContaining("launchctl bootstrap"),
      expect.stringContaining("launchctl kickstart -k")
    ]));
    expect(calls[calls.length - 1]).toBe(tuiPath);
  });

  it("emits a content-free support bundle", async () => {
    const { env } = await startAgent();
    const output = buffer();
    expect(await runTirionCtl(["support-bundle"], { env, stdout: output, stderr: buffer() })).toBe(0);
    const serialized = output.text();
    expect(serialized).not.toContain(String(env.TIRION_AGENT_STATE_DIR));
    expect(serialized).not.toContain("installationId");
  });

  it("reads agent-owned budget and diagnostics facts", async () => {
    const { env } = await startAgent();
    const budget = buffer();
    expect(await runTirionCtl(["budget", "status"], { env, stdout: budget, stderr: buffer() })).toBe(0);
    expect(JSON.parse(budget.text())).toMatchObject({
      thresholds: { schemaVersion: 1 },
      warnings: []
    });
    const diagnostics = buffer();
    expect(await runTirionCtl(["diagnostics"], { env, stdout: diagnostics, stderr: buffer() })).toBe(0);
    expect(JSON.parse(diagnostics.text())).toMatchObject({
      executionEnvironment: "local"
    });
    const doctor = buffer();
    expect(await runTirionCtl(["doctor"], { env, stdout: doctor, stderr: buffer() })).toBe(0);
    expect(JSON.parse(doctor.text())).toMatchObject({
      checks: {
        agentReachable: true,
        bootstrapPresent: true,
        agentDoctor: {
          databaseIntegrity: "ok",
          checks: { privateStateDirectory: true, privateControlSocket: true }
        }
      }
    });
  });

  it("configures a supported provider through the agent", async () => {
    const { env } = await startAgent();
    const output = buffer();
    expect(await runTirionCtl(["configure", "codex"], { env, stdout: output, stderr: buffer() })).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({
      provider: "codex",
      status: "configured",
      promptCaptureEnabled: false
    });
    const restored = buffer();
    expect(await runTirionCtl(["sources", "restore", "codex"], { env, stdout: restored, stderr: buffer() })).toBe(0);
    expect(JSON.parse(restored.text())).toMatchObject({ provider: "codex", status: "restored" });

    const disabled = buffer();
    expect(await runTirionCtl(["configure", "claude-code", "--no-capture-prompts"], {
      env,
      stdout: disabled,
      stderr: buffer()
    })).toBe(0);
    expect(JSON.parse(disabled.text())).toMatchObject({
      provider: "claude-code",
      status: "configured",
      promptCaptureEnabled: false
    });

    const spanDbRoot = mkdtempSync(join(tmpdir(), "tirionctl-copilot-span-db-"));
    roots.push(spanDbRoot);
    const spanDbPath = join(spanDbRoot, "agent-traces.db");
    const copilot = buffer();
    expect(await runTirionCtl(["configure", "github-copilot", "--span-db", spanDbPath], {
      env,
      stdout: copilot,
      stderr: buffer()
    })).toBe(0);
    expect(JSON.parse(copilot.text())).toMatchObject({
      enabled: true,
      spanDbPath,
      captureContent: false,
      dbSpanExporter: true
    });

    const copilotRestored = buffer();
    expect(await runTirionCtl(["configure", "restore", "github-copilot"], {
      env,
      stdout: copilotRestored,
      stderr: buffer()
    })).toBe(0);
    expect(JSON.parse(copilotRestored.text())).toMatchObject({
      enabled: false,
      captureContent: false,
      dbSpanExporter: false
    });
  });

  it("summarizes local readiness with health", async () => {
    const { env } = await startAgent("agent_full_owner");
    const output = buffer();
    expect(await runTirionCtl(["health"], { env, stdout: output, stderr: buffer() })).toBe(1);
    expect(JSON.parse(output.text())).toMatchObject({
      schemaVersion: 1,
      overall: "degraded",
      agent: {
        reachable: true,
        health: "healthy",
        ownershipState: "agent_full_owner",
        bootstrapPresent: true,
        databaseIntegrity: "ok"
      },
      repositories: {
        scopeCount: 0,
        activeScopeCount: 0
      },
      webhook: {
        runEndedEnabled: true,
        commitAttributedEnabled: true
      },
      issues: expect.arrayContaining([
        "No local provider source configurations are present."
      ])
    });
  });

  it("reports deferred historical reconciliation without surfacing unsupported capabilities", async () => {
    const paths = testPaths();
    const agent = new AgentRuntime({
      paths,
      otlpPort: 0,
      initialOwnershipState: "agent_full_owner",
      sourceConfigurationPaths: {
        claudeSettingsPath: join(paths.stateDir, "test-claude", "settings.json"),
        codexConfigPath: join(paths.stateDir, "test-codex", "config.toml"),
        restoreStatePath: join(paths.stateDir, "source-configuration-restore.json"),
        codexHookRelayPath: join(paths.stateDir, "codex-hook-relay.cjs"),
        cursorHooksPath: join(paths.stateDir, "test-cursor", "hooks.json"),
        cursorHookRelayPath: join(paths.stateDir, "cursor-hook-relay.cjs")
      }
    });
    agents.push(agent);
    await agent.start();
    const env = {
      ...process.env,
      TIRION_AGENT_STATE_DIR: paths.stateDir,
      TIRION_AGENT_SOCKET: paths.socketPath
    };
    const output = buffer();
    expect(await runTirionCtl(["health"], { env, stdout: output, stderr: buffer() })).toBe(1);
    expect(JSON.parse(output.text())).toMatchObject({
      schemaVersion: 1,
      overall: "degraded",
      agent: {
        reachable: true,
        health: "healthy",
        ownershipState: "agent_full_owner",
        fullOwnerBootstrapState: "deferred",
        historicalReconciliationState: "deferred"
      },
      repositories: {
        scopeCount: 0,
        activeScopeCount: 0
      },
      issues: expect.arrayContaining([
        "Local runtime warmup is still rebuilding usage and retention state in the background."
      ])
    });
    expect(output.text()).not.toContain("unsupported_capability");
  });

  it("reports background runtime warmup separately from agent startup failure", async () => {
    const paths = testPaths();
    const agent = new AgentRuntime({
      paths,
      otlpPort: 0,
      initialOwnershipState: "agent_usage_owner",
      sourceConfigurationPaths: {
        claudeSettingsPath: join(paths.stateDir, "test-claude", "settings.json"),
        codexConfigPath: join(paths.stateDir, "test-codex", "config.toml"),
        restoreStatePath: join(paths.stateDir, "source-configuration-restore.json"),
        codexHookRelayPath: join(paths.stateDir, "codex-hook-relay.cjs"),
        cursorHooksPath: join(paths.stateDir, "test-cursor", "hooks.json"),
        cursorHookRelayPath: join(paths.stateDir, "cursor-hook-relay.cjs")
      }
    });
    agents.push(agent);
    (agent as any).performRuntimeWarmup = async () => {
      await new Promise(() => undefined);
    };
    await agent.start();
    const env = {
      ...process.env,
      TIRION_AGENT_STATE_DIR: paths.stateDir,
      TIRION_AGENT_SOCKET: paths.socketPath
    };
    const output = buffer();
    expect(await runTirionCtl(["health"], { env, stdout: output, stderr: buffer() })).toBe(1);
    expect(JSON.parse(output.text())).toMatchObject({
      schemaVersion: 1,
      overall: "degraded",
      agent: {
        reachable: true,
        health: "healthy",
        ownershipState: "agent_usage_owner",
        runtimeWarmupState: "starting"
      },
      issues: expect.arrayContaining([
        "Local runtime warmup is still rebuilding usage and retention state in the background."
      ])
    });
  });

  it("does not surface removed backend sync sections during startup", async () => {
    const { env, agent } = await startAgent("agent_full_owner");
    (agent as any).accountingSync = undefined;
    (agent as any).executionSync = undefined;
    (agent as any).runtimeWarmupState = "starting";
    (agent as any).fullOwnerBootstrapState = "deferred";

    const output = buffer();
    expect(await runTirionCtl(["health"], { env, stdout: output, stderr: buffer() })).toBe(1);
    const report = JSON.parse(output.text()) as {
      issues: string[];
      actions: string[];
      accounting?: unknown;
      execution?: unknown;
    };
    expect(report.accounting).toBeUndefined();
    expect(report.execution).toBeUndefined();
    expect(report.issues).not.toContain("Accounting sync is pending.");
    expect(report.issues).not.toContain("Execution sync is pending.");
    expect(report.actions).not.toContain("Run `tirionctl sync` after backend authorization so accounting facts are accepted.");
    expect(report.actions).not.toContain("Run `tirionctl sync` after backend authorization so execution evidence is accepted.");
  });

  it("treats budget-free local health as healthy", () => {
    expect(deriveHealthOverall({
      blocked: false,
      operationalIssueCount: 0
    })).toBe("healthy");
  });

  it("rejects removed backend sync commands in the local-only CLI", async () => {
    const { env } = await startAgent("agent_full_owner");
    for (const command of ["sync", "publishing", "accounting", "execution"]) {
      const stderr = buffer();
      expect(await runTirionCtl([command], { env, stdout: buffer(), stderr })).toBe(2);
      expect(stderr.text()).toContain("local-only Tirion build");
    }
  });

  it("exposes explicit historical reconciliation through the CLI", async () => {
    const { env } = await startAgent("agent_full_owner");
    const output = buffer();
    expect(await runTirionCtl(["attribution", "reconcile"], { env, stdout: output, stderr: buffer() })).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({
      schemaVersion: 1,
      state: "ready",
      liveFirst: true,
      historicalSecond: true
    });
  });

  it("exposes webhook status through the CLI", async () => {
    const { env } = await startAgent("agent_full_owner");
    const output = buffer();
    expect(await runTirionCtl(["webhook", "status"], { env, stdout: output, stderr: buffer() })).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({
      schemaVersion: 1,
      runEndedEnabled: true,
      commitAttributedEnabled: true,
      queuedCount: 0,
      blockedCount: 0,
      deliveredCount: 0
    });
  });

  it("configures webhook sender details through the CLI", async () => {
    const { env } = await startAgent("agent_full_owner");
    const output = buffer();
    expect(await runTirionCtl([
      "webhook",
      "set-sender",
      "--name",
      "Ada Lovelace",
      "--team",
      "Platform",
      "--image-url",
      "https://example.com/ada.png"
    ], { env, stdout: output, stderr: buffer() })).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({
      schemaVersion: 1,
      sender: {
        name: "Ada Lovelace",
        team: "Platform",
        imageUrl: "https://example.com/ada.png"
      }
    });

    const cleared = buffer();
    expect(await runTirionCtl(["webhook", "clear-sender"], { env, stdout: cleared, stderr: buffer() })).toBe(0);
    expect(JSON.parse(cleared.text())).toMatchObject({
      schemaVersion: 1,
      sender: {}
    });
  });

  it("reads privacy-safe typed logs through the diagnostics API", async () => {
    const { env } = await startAgent();
    const output = buffer();
    expect(await runTirionCtl(["logs", "--limit", "1"], { env, stdout: output, stderr: buffer() })).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({
      schemaVersion: 1,
      events: [expect.objectContaining({ code: "runtime_started" })]
    });
  });

  it("enrolls and lists repository scopes without echoing paths", async () => {
    const { env } = await startAgent();
    const repository = mkdtempSync(join(tmpdir(), "tirionctl-repo-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    const added = buffer();
    expect(await runTirionCtl(["repo", "add", repository], { env, stdout: added, stderr: buffer() })).toBe(0);
    expect(added.text()).not.toContain(repository);
    const listed = buffer();
    expect(await runTirionCtl(["repo", "list"], { env, stdout: listed, stderr: buffer() })).toBe(0);
    expect(JSON.parse(listed.text()).scopes).toHaveLength(1);
  });

  it("starts repository watching from the current working directory", async () => {
    const { env } = await startAgent();
    const repository = mkdtempSync(join(tmpdir(), "tirionctl-watch-repo-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    const watched = buffer();
    expect(await runTirionCtl(["repo", "watch"], {
      env,
      cwd: repository,
      stdout: watched,
      stderr: buffer()
    })).toBe(0);
    expect(watched.text()).not.toContain(repository);
    expect(JSON.parse(watched.text())).toMatchObject({
      kind: "repository",
      state: "active"
    });
  });

  it("activates a Codex repository and reports the pending hook-trust precondition", async () => {
    const { env } = await startAgent();
    const repository = mkdtempSync(join(tmpdir(), "tirionctl-activate-repo-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    const activated = buffer();
    expect(await runTirionCtl(["repo", "activate", repository, "--provider", "codex"], {
      env,
      stdout: activated,
      stderr: buffer()
    })).toBe(0);
    const activation = JSON.parse(activated.text());
    expect(activation).toMatchObject({
      activationState: "attention_required",
      provider: "codex",
      reasonCodes: expect.arrayContaining(["hook_trust_required"]),
      repositoryScope: { kind: "repository", state: "active" },
      sourceStatus: {
        provider: "codex",
        configurationState: "partial",
        measurementState: "unavailable",
        ownershipState: "managed_current",
        logsEnabled: true,
        tracesEnabled: true
      }
    });
    expect(activation.repositoryScope).not.toHaveProperty("provider");
  });

  it("activates a GitHub Copilot repository after span DB source configuration", async () => {
    const { env } = await startAgent();
    const spanDbRoot = mkdtempSync(join(tmpdir(), "tirionctl-copilot-activate-span-db-"));
    roots.push(spanDbRoot);
    const spanDbPath = join(spanDbRoot, "agent-traces.db");
    const configured = buffer();
    expect(await runTirionCtl(["configure", "github-copilot", "--span-db", spanDbPath], {
      env,
      stdout: configured,
      stderr: buffer()
    })).toBe(0);

    const repository = mkdtempSync(join(tmpdir(), "tirionctl-activate-copilot-repo-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    const activated = buffer();
    expect(await runTirionCtl(["repo", "activate", repository, "--provider", "github-copilot"], {
      env,
      stdout: activated,
      stderr: buffer()
    })).toBe(0);

    const activation = JSON.parse(activated.text());
    expect(activation).toMatchObject({
      activationState: "ready",
      provider: "github-copilot",
      repositoryScope: { kind: "repository", state: "active" },
      sourceStatus: {
        provider: "github-copilot",
        configurationState: "configured",
        ownershipState: "managed_current",
        logsEnabled: true,
        tracesEnabled: true,
        measurementState: "awaiting_receipts"
      }
    });
    expect(activation.repositoryScope).not.toHaveProperty("provider");
    expect(activated.text()).not.toContain(repository);
    expect(activated.text()).not.toContain(spanDbPath);
  });

  it("scans a folder, confirms, and watches all repositories inside it", async () => {
    const { env } = await startAgent();
    const folder = mkdtempSync(join(tmpdir(), "tirionctl-watch-folder-"));
    roots.push(folder);
    const repoA = join(folder, "repo-a");
    const repoB = join(folder, "repo-b");
    execFileSync("mkdir", ["-p", repoA, repoB]);
    execFileSync("git", ["init", repoA]);
    execFileSync("git", ["init", repoB]);
    const watched = buffer();
    expect(await runTirionCtl(["repo", "watch", folder], {
      env,
      stdout: watched,
      stderr: buffer(),
      confirm: async (prompt) => {
        expect(prompt).toContain("2 repositories in folder - watch all?");
        return true;
      }
    })).toBe(0);
    expect(watched.text()).not.toContain(folder);
    expect(JSON.parse(watched.text())).toMatchObject({
      watched: 2,
      scopes: [
        expect.objectContaining({ kind: "repository", state: "active" }),
        expect.objectContaining({ kind: "repository", state: "active" })
      ]
    });
    const listed = buffer();
    expect(await runTirionCtl(["repo", "list"], { env, stdout: listed, stderr: buffer() })).toBe(0);
    expect(JSON.parse(listed.text()).scopes).toHaveLength(2);
  });

  it("does not watch scanned repositories when the user declines confirmation", async () => {
    const { env } = await startAgent();
    const folder = mkdtempSync(join(tmpdir(), "tirionctl-watch-decline-"));
    roots.push(folder);
    const repoA = join(folder, "repo-a");
    const repoB = join(folder, "repo-b");
    execFileSync("mkdir", ["-p", repoA, repoB]);
    execFileSync("git", ["init", repoA]);
    execFileSync("git", ["init", repoB]);
    const watched = buffer();
    expect(await runTirionCtl(["repo", "watch", folder], {
      env,
      stdout: watched,
      stderr: buffer(),
      confirm: async () => false
    })).toBe(0);
    expect(JSON.parse(watched.text())).toMatchObject({
      watched: 0,
      declined: true,
      repositoryCount: 2
    });
    const listed = buffer();
    expect(await runTirionCtl(["repo", "list"], { env, stdout: listed, stderr: buffer() })).toBe(0);
    expect(JSON.parse(listed.text()).scopes).toHaveLength(0);
  });

  it("approves a repository discovery root with a watch-oriented alias", async () => {
    const { env } = await startAgent();
    const root = mkdtempSync(join(tmpdir(), "tirionctl-watch-root-"));
    roots.push(root);
    const watched = buffer();
    expect(await runTirionCtl(["repo", "watch-root", root], {
      env,
      stdout: watched,
      stderr: buffer()
    })).toBe(0);
    expect(watched.text()).not.toContain(root);
    expect(JSON.parse(watched.text())).toMatchObject({
      kind: "root",
      state: "active"
    });
  });

  it("requires confirmation before clearing all local agent data", async () => {
    const { env } = await startAgent();
    const denied = buffer();
    expect(await runTirionCtl(["clear-agent-data"], { env, stdout: buffer(), stderr: denied })).toBe(2);
    expect(denied.text()).toContain("--confirm");

    const repository = mkdtempSync(join(tmpdir(), "tirionctl-clear-repo-"));
    roots.push(repository);
    execFileSync("git", ["init", repository]);
    expect(await runTirionCtl(["repo", "add", repository], { env, stdout: buffer(), stderr: buffer() })).toBe(0);
    writeFileSync(join(String(env.TIRION_AGENT_STATE_DIR), "source-configuration-restore.json"), "{\"schemaVersion\":1}\n");
    writeFileSync(join(String(env.TIRION_AGENT_STATE_DIR), "agent.db.pre-migration-7.bak"), "legacy backup");

    const cleared = buffer();
    expect(await runTirionCtl(["clear-agent-data", "--confirm"], { env, stdout: cleared, stderr: buffer() })).toBe(0);
    expect(JSON.parse(cleared.text())).toMatchObject({
      local: { cleared: true }
    });

    const listed = buffer();
    expect(await runTirionCtl(["repo", "list"], { env, stdout: listed, stderr: buffer() })).toBe(0);
    expect(JSON.parse(listed.text()).scopes).toHaveLength(0);
    expect(existsSync(join(String(env.TIRION_AGENT_STATE_DIR), "source-configuration-restore.json"))).toBe(false);
    expect(existsSync(join(String(env.TIRION_AGENT_STATE_DIR), "agent.db.pre-migration-7.bak"))).toBe(false);
    const logEvents = readFileSync(join(String(env.TIRION_AGENT_STATE_DIR), "agent.log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logEvents).toContainEqual(expect.objectContaining({
      code: "agent_data_cleared"
    }));
  });

  it("installs, repairs, and uninstalls the macOS LaunchAgent through the platform port", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirionctl-service-"));
    roots.push(root);
    const calls: string[] = [];
    const io = {
      env: {},
      stdout: buffer(),
      stderr: buffer(),
      platform: "darwin" as const,
      serviceDefinition: {
        label: "dev.tirion.agent" as const,
        plistPath: join(root, "dev.tirion.agent.plist"),
        content: "<plist></plist>\n"
      },
      execFile(command: string, args: string[]) {
        calls.push(`${command} ${args.join(" ")}`);
      },
      async waitForHealthy() {
        return { health: "healthy", agentVersion: "0.1.6" };
      }
    };
    expect(await runTirionCtl(["service", "install"], io)).toBe(0);
    expect(existsSync(io.serviceDefinition.plistPath)).toBe(true);
    expect(await runTirionCtl(["start"], io)).toBe(0);
    expect(await runTirionCtl(["restart"], io)).toBe(0);
    expect(await runTirionCtl(["stop"], io)).toBe(0);
    expect(existsSync(io.serviceDefinition.plistPath)).toBe(true);
    expect(await runTirionCtl(["repair"], io)).toBe(0);
    expect(await runTirionCtl(["service", "uninstall"], io)).toBe(0);
    expect(existsSync(io.serviceDefinition.plistPath)).toBe(false);
    expect(calls).toEqual(expect.arrayContaining([
      expect.stringContaining("launchctl bootstrap"),
      expect.stringContaining("launchctl kickstart -k"),
      expect.stringContaining("launchctl bootout")
    ]));
  });

  it("retries launchctl bootstrap when the previous instance is still tearing down", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirionctl-service-retry-"));
    roots.push(root);
    const calls: string[] = [];
    let bootstrapAttempts = 0;
    const io = {
      env: {},
      stdout: buffer(),
      stderr: buffer(),
      platform: "darwin" as const,
      serviceDefinition: {
        label: "dev.tirion.agent" as const,
        plistPath: join(root, "dev.tirion.agent.plist"),
        content: "<plist></plist>\n"
      },
      execFile(command: string, args: string[]) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args[0] === "bootstrap") {
          bootstrapAttempts += 1;
          if (bootstrapAttempts < 3) {
            throw new Error("Bootstrap failed: 5: Input/output error");
          }
        }
      },
      async waitForHealthy() {
        return { health: "healthy", agentVersion: "0.1.6" };
      }
    };
    expect(await runTirionCtl(["start"], io)).toBe(0);
    expect(bootstrapAttempts).toBe(3);
    expect(calls).toEqual(expect.arrayContaining([
      expect.stringContaining("launchctl kickstart -k")
    ]));
  });

  it("surfaces a persistent launchctl bootstrap failure as agent_unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirionctl-service-fail-"));
    roots.push(root);
    const stderr = buffer(true);
    const io = {
      env: {},
      stdout: buffer(),
      stderr,
      platform: "darwin" as const,
      serviceDefinition: {
        label: "dev.tirion.agent" as const,
        plistPath: join(root, "dev.tirion.agent.plist"),
        content: "<plist></plist>\n"
      },
      execFile(_command: string, args: string[]) {
        if (args[0] === "bootstrap") {
          throw new Error("Bootstrap failed: 5: Input/output error");
        }
      },
      async waitForHealthy() {
        return { health: "healthy", agentVersion: "0.1.6" };
      }
    };
    expect(await runTirionCtl(["start"], io)).toBe(1);
    expect(stderr.text()).toContain("agent_unavailable");
  }, 15_000);

  it("prints an interactive restart summary with repository guidance", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirionctl-restart-summary-"));
    roots.push(root);
    const stdout = buffer();
    const stderr = buffer(true);
    expect(await runTirionCtl(["restart"], {
      env: {
        TIRION_AGENT_STATE_DIR: join(root, "state"),
        TIRION_AGENT_SOCKET: join(root, "agent.sock")
      },
      stdout,
      stderr,
      platform: "darwin" as const,
      serviceDefinition: {
        label: "dev.tirion.agent" as const,
        plistPath: join(root, "dev.tirion.agent.plist"),
        content: "<plist></plist>\n"
      },
      execFile() {
        return undefined;
      },
      async waitForHealthy() {
        return {
          health: "healthy",
          ownershipState: "agent_full_owner",
          agentVersion: "0.1.6",
          runtimeWarmupState: "ready"
        };
      }
    })).toBe(0);
    expect(stderr.text()).toContain("Tirion agent restart summary");
    expect(stderr.text()).toContain("Activate a repository end to end: tirionctl repo activate /absolute/path/to/repo");
    expect(stderr.text()).toContain("Add a discovery root: tirionctl repo watch-root /absolute/path/to/repos");
    expect(stderr.text()).toContain("- Next:");
  });

  it("requires confirmation and a packaged root before removing installed binaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirionctl-full-uninstall-"));
    roots.push(root);
    const calls: string[] = [];
    const base = {
      env: { TIRION_AGENT_STATE_DIR: join(root, "state"), TIRION_AGENT_SOCKET: join(root, "agent.sock") },
      stdout: buffer(),
      stderr: buffer(),
      platform: "darwin" as const,
      packagedInstallRoot: "/Applications/Tirion",
      serviceDefinition: {
        label: "dev.tirion.agent" as const,
        plistPath: join(root, "dev.tirion.agent.plist"),
        content: "<plist></plist>\n"
      },
      execFile(command: string, args: string[]) {
        calls.push(`${command} ${args.join(" ")}`);
      }
    };
    expect(await runTirionCtl(["uninstall", "--remove-binaries"], base)).toBe(2);
    const output = buffer();
    expect(await runTirionCtl(["uninstall", "--remove-binaries", "--confirm"], { ...base, stdout: output })).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({ serviceUninstalled: true, binariesRemoved: true });
    expect(calls).toEqual(expect.arrayContaining([
      "sudo /bin/rm -rf /Applications/Tirion",
      "sudo /bin/rm -f /usr/local/bin/tirionctl /usr/local/bin/tirion-agent",
      "sudo /usr/sbin/pkgutil --forget dev.tirion.agent"
    ]));
  });

  it("orchestrates verified macOS upgrade and rollback without opening agent storage", async () => {
    const { env, agent } = await startAgent();
    const root = mkdtempSync(join(tmpdir(), "tirionctl-upgrade-"));
    roots.push(root);
    const packagePath = join(root, "Tirion.pkg");
    writeFileSync(packagePath, "signed package fixture");
    const calls: string[] = [];
    const io = {
      env,
      stdout: buffer(),
      stderr: buffer(),
      platform: "darwin" as const,
      serviceDefinition: {
        label: "dev.tirion.agent" as const,
        plistPath: join(root, "dev.tirion.agent.plist"),
        content: "<plist></plist>\n"
      },
      execFile(command: string, args: string[]) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "/usr/sbin/pkgutil" && args[0] === "--check-signature") {
          return "Status: signed by a certificate trusted by macOS\nDeveloper ID Installer: Tirion\n";
        }
      },
      async waitForHealthy() {
        return { health: "healthy", agentVersion: "0.1.7" };
      },
      inspectPackage() {
        return {
          agentVersion: "0.1.7",
          databaseSchemaVersion: 10,
          artifact: {
            packageIdentifier: "dev.tirion.agent",
            signingIdentity: "Developer ID Installer: Tirion",
            notarization: "required-and-verified"
          },
          migrationSupportWindow: {
            minimumDatabaseSchemaVersion: 1,
            maximumDatabaseSchemaVersion: 10,
            legacyExtensionHistoryMigration: "unsupported"
          }
        };
      }
    };
    expect(await runTirionCtl(["upgrade", "--package", packagePath], io)).toBe(2);
    expect(await runTirionCtl(["upgrade", "--package", packagePath, "--confirm"], {
      ...io,
      stderr: buffer(),
      inspectPackage: () => ({ ...io.inspectPackage(), agentVersion: "0.1.6" })
    })).toBe(1);
    expect(await runTirionCtl(["upgrade", "--package", packagePath, "--confirm"], {
      ...io,
      stderr: buffer(),
      execFile(command: string, args: string[]) {
        calls.push(`${command} ${args.join(" ")}`);
        return command === "/usr/sbin/pkgutil" && args[0] === "--check-signature"
          ? "Developer ID Installer: Different Publisher"
          : undefined;
      }
    })).toBe(1);
    const statusAfterSignerMismatch = buffer();
    expect(await runTirionCtl(["status"], { ...io, stdout: statusAfterSignerMismatch, stderr: buffer() })).toBe(0);
    expect(JSON.parse(statusAfterSignerMismatch.text())).toMatchObject({ health: "healthy", agentVersion: "0.1.6" });
    expect(await runTirionCtl(["upgrade", "--package", packagePath, "--confirm"], io)).toBe(0);
    await agent.stop();
    await agent.start();
    expect(await runTirionCtl(["rollback", "--package", packagePath, "--confirm"], {
      ...io,
      inspectPackage: () => ({ ...io.inspectPackage(), agentVersion: "0.1.6" })
    })).toBe(0);
    expect(calls).toEqual(expect.arrayContaining([
      `/usr/sbin/pkgutil --check-signature ${packagePath}`,
      `/usr/bin/xcrun stapler validate ${packagePath}`,
      `/usr/sbin/spctl --assess --type install ${packagePath}`,
      `sudo /usr/sbin/installer -pkg ${packagePath} -target /`,
      expect.stringContaining("maintenance restore-pre-upgrade")
    ]));
  });
});

async function startAgent(initialOwnershipState: "agent_shadow" | "agent_full_owner" = "agent_shadow"): Promise<{
  env: NodeJS.ProcessEnv;
  agent: AgentRuntime;
}> {
  const paths = testPaths();
  const agent = new AgentRuntime({
    paths,
    otlpPort: 0,
    initialOwnershipState,
    sourceConfigurationPaths: {
      claudeSettingsPath: join(paths.stateDir, "test-claude", "settings.json"),
      codexConfigPath: join(paths.stateDir, "test-codex", "config.toml"),
      restoreStatePath: join(paths.stateDir, "source-configuration-restore.json"),
      codexHookRelayPath: join(paths.stateDir, "codex-hook-relay.cjs"),
      cursorHooksPath: join(paths.stateDir, "test-cursor", "hooks.json"),
      cursorHookRelayPath: join(paths.stateDir, "cursor-hook-relay.cjs")
    }
  });
  agents.push(agent);
  await agent.start();
  return {
    agent,
    env: {
      ...process.env,
      TIRION_AGENT_STATE_DIR: paths.stateDir,
      TIRION_AGENT_SOCKET: paths.socketPath
    }
  };
}

function testPaths(): AgentPaths {
  const root = mkdtempSync(join(tmpdir(), "tirionctl-"));
  roots.push(root);
  return {
    stateDir: root,
    databasePath: join(root, "agent.db"),
    lockPath: join(root, "agent.lock"),
    bootstrapTokenPath: join(root, "bootstrap.token"),
    ownershipMarkerPath: join(root, "ownership.json"),
    repositoryLocatorKeyPath: join(root, "repository-locator.key"),
    attributionHmacKeyPath: join(root, "attribution-hmac.key"),
    socketPath: join(root, "agent.sock")
  };
}

function buffer(isTTY = false) {
  let value = "";
  return {
    isTTY,
    write(text: string) {
      value += text;
    },
    text() {
      return value;
    }
  };
}
