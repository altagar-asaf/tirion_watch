import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { AGENT_DATABASE_SCHEMA_VERSION } from "@tirion/agent-contract";

export type DistributionCommandOptions = {
  cwd?: string;
};

export type DistributionCommandRunner = (
  command: string,
  args: string[],
  options?: DistributionCommandOptions
) => string;

export type MacOsDistributionOptions = {
  workspaceRoot: string;
  outputDir: string;
  nodeRuntimePath: string;
  version: string;
  signingIdentity?: string;
  notaryProfile?: string;
  unsignedDevelopment?: boolean;
  runner?: DistributionCommandRunner;
  platform?: NodeJS.Platform;
};

export type MacOsDistributionResult = {
  packagePath: string;
  payloadRoot: string;
  manifestPath: string;
  birthCertificatePath: string;
  signed: boolean;
  notarized: boolean;
};

const PACKAGE_NAMES = [
  "agent",
  "agent-contract",
  "agent-storage",
  "engine",
  "platform",
  "tirionctl"
] as const;

export function buildMacOsDistribution(options: MacOsDistributionOptions): MacOsDistributionResult {
  const runner = options.runner ?? run;
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("macos_required");
  }
  if (!options.unsignedDevelopment && (!options.signingIdentity || !options.notaryProfile)) {
    throw new Error("signing_configuration_required");
  }
  const agentVersion = packageVersion(options.workspaceRoot, "agent");
  if (agentVersion !== options.version) {
    throw new Error("release_version_mismatch");
  }
  const runtimeVersion = runner(options.nodeRuntimePath, ["--version"]).trim();
  if (!/^v24\./.test(runtimeVersion)) {
    throw new Error("node_24_runtime_required");
  }

  const stagingRoot = join(options.outputDir, "staging");
  const payloadRoot = join(stagingRoot, "payload");
  const scriptsRoot = join(stagingRoot, "scripts");
  const installRoot = join(payloadRoot, "Applications", "Tirion");
  const appNodeModules = join(installRoot, "app", "node_modules");
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(join(installRoot, "runtime"), { recursive: true, mode: 0o755 });
  mkdirSync(join(appNodeModules, "@tirion"), { recursive: true, mode: 0o755 });
  cpSync(options.nodeRuntimePath, join(installRoot, "runtime", "node"));
  chmodSync(join(installRoot, "runtime", "node"), 0o755);

  for (const packageName of PACKAGE_NAMES) {
    copyRuntimePackage(options.workspaceRoot, packageName, join(appNodeModules, "@tirion", packageName));
  }
  copyDependency(options.workspaceRoot, "smol-toml", appNodeModules);
  writeEntrypoint(join(installRoot, "bin", "tirion-agent"), "../runtime/node", "../app/node_modules/@tirion/agent/dist/main.js");
  writeEntrypoint(join(installRoot, "bin", "tirionctl"), "../runtime/node", "../app/node_modules/@tirion/tirionctl/dist/main.js");
  copyBinary(join(options.workspaceRoot, "packages", "tirion-tui", "tirion-tui"), join(installRoot, "bin", "tirion-tui"));
  writeAbsoluteLauncher(join(payloadRoot, "usr", "local", "bin", "tirion-agent"), "/Applications/Tirion/bin/tirion-agent");
  writeAbsoluteLauncher(join(payloadRoot, "usr", "local", "bin", "tirionctl"), "/Applications/Tirion/bin/tirionctl");
  writeAbsoluteLauncher(join(payloadRoot, "usr", "local", "bin", "tirion-tui"), "/Applications/Tirion/bin/tirion-tui");
  writeServiceTemplate(join(installRoot, "service", "dev.tirion.agent.plist.template"));
  writePostInstallScript(join(scriptsRoot, "postinstall"));
  copyReleaseDocument(options.workspaceRoot, "README.md", join(installRoot, "support", "README.md"));
  copyReleaseDocument(
    options.workspaceRoot,
    "agent-installation-and-operations.md",
    join(installRoot, "support", "agent-installation-and-operations.md")
  );
  writeJson(join(installRoot, "privacy-support-metadata.json"), {
    schemaVersion: 1,
    supportBundleCommand: "tirionctl support-bundle",
    forbiddenContent: ["raw telemetry", "prompts", "responses", "tool arguments", "tool results", "file content", "repository locators", "credentials"],
    costLanguage: "estimated"
  });

  const birthCertificatePath = join(installRoot, "birth-certificate.json");
  writeJson(birthCertificatePath, {
    schemaVersion: 1,
    product: "Tirion Agent",
    agentVersion,
    protocolVersion: "1.0",
    databaseSchemaVersion: AGENT_DATABASE_SCHEMA_VERSION,
    runtimeVersion,
    ownershipDefault: "agent_full_owner",
    artifact: {
      packageIdentifier: "dev.tirion.agent",
      signingIdentity: options.unsignedDevelopment ? "unsigned-development" : options.signingIdentity,
      notarization: options.unsignedDevelopment ? "not-performed" : "required-and-verified"
    },
    migrationSupportWindow: {
      minimumDatabaseSchemaVersion: 1,
      maximumDatabaseSchemaVersion: AGENT_DATABASE_SCHEMA_VERSION,
      legacyExtensionHistoryMigration: "unsupported"
    },
    privacyProfiles: [
      "copilot-otlp-logs-v1",
      "copilot-otlp-traces-v1",
      "claude-code-otel-logs-v1",
      "claude-code-enhanced-traces-beta-v1",
      "codex-otel-logs-v1",
      "codex-otel-traces-v1",
      "cursor-hooks-v1",
      "cursor-otlp-logs-v1",
      "cursor-otlp-traces-v1",
    ],
    providers: {
      "github-copilot": "detailed-local-telemetry-required",
      "claude-code": "verified-otlp-surfaces",
      "codex": "verified-trace-only-surfaces",
      "cursor": "evidence-gated",
      "visual-studio-copilot": "unsupported-for-verified-commit-cost"
    },
    supported: { os: ["macOS"], executionEnvironment: "one-agent-per-user-per-environment" },
    knownEvidenceLimitations: [
      "temporal_proximity_is_not_verified_commit_cost",
      "claude_and_codex_direct_cost_requires_verified_billing_context",
      "cursor_evidence_gated",
      "visual_studio_copilot_verified_commit_cost_unsupported",
      "remote_environments_require_environment_local_agent"
    ]
  });
  const manifestPath = join(installRoot, "release-manifest.json");
  writeJson(manifestPath, {
    schemaVersion: 1,
    algorithm: "sha256",
    files: hashesUnder(payloadRoot, manifestPath)
  });
  runner("xattr", ["-cr", stagingRoot]);

  mkdirSync(options.outputDir, { recursive: true, mode: 0o755 });
  const componentPath = join(options.outputDir, `Tirion-${options.version}-component.pkg`);
  rmSync(componentPath, { force: true });
  runner("pkgbuild", [
    "--root",
    payloadRoot,
    "--identifier",
    "dev.tirion.agent",
    "--version",
    options.version,
    "--scripts",
    scriptsRoot,
    "--filter",
    "(^|/)\\.svn(/|$)",
    "--filter",
    "(^|/)CVS(/|$)",
    "--filter",
    "(^|/)\\.DS_Store$",
    "--filter",
    "(^|/)\\._[^/]+$",
    componentPath
  ]);
  scrubComponentPackage(runner, componentPath, payloadRoot, scriptsRoot, join(stagingRoot, "scrubbed-component"));
  assertPackagePayloadSafe(runner, componentPath);
  assertPackageArchiveSafe(runner, componentPath, join(stagingRoot, "expanded-component"));
  if (options.unsignedDevelopment) {
    return {
      packagePath: componentPath,
      payloadRoot,
      manifestPath,
      birthCertificatePath,
      signed: false,
      notarized: false
    };
  }

  const packagePath = join(options.outputDir, `Tirion-${options.version}.pkg`);
  rmSync(packagePath, { force: true });
  runner("productsign", ["--sign", options.signingIdentity!, componentPath, packagePath]);
  runner("xcrun", ["notarytool", "submit", packagePath, "--keychain-profile", options.notaryProfile!, "--wait"]);
  runner("xcrun", ["stapler", "staple", packagePath]);
  runner("xcrun", ["stapler", "validate", packagePath]);
  const signature = runner("pkgutil", ["--check-signature", packagePath]);
  if (!signature.includes(options.signingIdentity!)) {
    throw new Error("signed_artifact_identity_mismatch");
  }
  return {
    packagePath,
    payloadRoot,
    manifestPath,
    birthCertificatePath,
    signed: true,
    notarized: true
  };
}

function copyRuntimePackage(workspaceRoot: string, packageName: string, destination: string): void {
  const source = join(workspaceRoot, "packages", packageName);
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const required of ["package.json", "dist"]) {
    const path = join(source, required);
    if (!existsSync(path)) {
      throw new Error(`missing_build_artifact:${packageName}/${required}`);
    }
    cpSync(path, join(destination, required), { recursive: true, dereference: true });
  }
  const hosted = join(source, "hosted-dist");
  if (existsSync(hosted)) {
    cpSync(hosted, join(destination, "hosted-dist"), { recursive: true, dereference: true });
  }
}

function packageVersion(workspaceRoot: string, packageName: string): string {
  const value = JSON.parse(readFileSync(join(workspaceRoot, "packages", packageName, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error(`invalid_package_version:${packageName}`);
  }
  return value.version;
}

function copyDependency(workspaceRoot: string, dependency: string, destinationNodeModules: string): void {
  const source = join(workspaceRoot, "node_modules", dependency);
  if (!existsSync(source)) {
    throw new Error(`missing_runtime_dependency:${dependency}`);
  }
  cpSync(source, join(destinationNodeModules, dependency), { recursive: true, dereference: true });
}

function copyBinary(source: string, destination: string): void {
  if (!existsSync(source)) {
    throw new Error(`missing_binary:${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  cpSync(source, destination);
  chmodSync(destination, 0o755);
}

function writeEntrypoint(path: string, runtime: string, entry: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, [
    "#!/bin/sh",
    "set -eu",
    "ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"",
    `exec "$ROOT/${runtime}" "$ROOT/${entry}" "$@"`,
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

function writeAbsoluteLauncher(path: string, target: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, `#!/bin/sh\nset -eu\nexec "${target}" "$@"\n`, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

function writeServiceTemplate(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key><string>dev.tirion.agent</string>",
    "  <key>ProgramArguments</key>",
    "  <array><string>__TIRION_NODE__</string><string>__TIRION_AGENT_ENTRY__</string></array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o644 });
}

function writePostInstallScript(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, [
    "#!/bin/sh",
    "set -eu",
    "CONSOLE_USER=\"$(/usr/bin/stat -f '%Su' /dev/console)\"",
    "case \"$CONSOLE_USER\" in",
    "  \"\"|root|loginwindow) exit 0 ;;",
    "esac",
    "CONSOLE_UID=\"$(/usr/bin/id -u \"$CONSOLE_USER\")\"",
    "/bin/launchctl asuser \"$CONSOLE_UID\" /usr/bin/sudo -u \"$CONSOLE_USER\" /Applications/Tirion/bin/tirionctl init >/dev/null",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

function copyReleaseDocument(workspaceRoot: string, name: string, destination: string): void {
  const source = join(workspaceRoot, name);
  if (!existsSync(source)) {
    throw new Error(`missing_release_document:${name}`);
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  cpSync(source, destination);
}

function hashesUnder(root: string, excludedPath: string): Record<string, string> {
  return Object.fromEntries(walk(root)
    .filter((path) => path !== excludedPath)
    .map((path) => [
      relative(root, path),
      createHash("sha256").update(readFileSync(path)).digest("hex")
    ]));
}

function walk(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  }).sort();
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
}

function assertPackagePayloadSafe(runner: DistributionCommandRunner, packagePath: string): void {
  const entries = runner("pkgutil", ["--payload-files", packagePath]).split(/\r?\n/).filter(Boolean);
  if (entries.some((entry) => /(?:^|\/)\._/.test(entry))) {
    throw new Error("package_metadata_entries_forbidden");
  }
}

function assertPackageArchiveSafe(
  runner: DistributionCommandRunner,
  packagePath: string,
  expandedPath: string
): void {
  rmSync(expandedPath, { recursive: true, force: true });
  runner("pkgutil", ["--expand", packagePath, expandedPath]);
  if (!existsSync(expandedPath)) {
    throw new Error("package_inspection_failed");
  }
  try {
    if (walk(expandedPath).some((path) => path.split("/").at(-1)?.startsWith("._"))) {
      throw new Error("package_metadata_entries_forbidden");
    }
  } finally {
    rmSync(expandedPath, { recursive: true, force: true });
  }
}

function scrubComponentPackage(
  runner: DistributionCommandRunner,
  componentPath: string,
  payloadRoot: string,
  scriptsRoot: string,
  expandedPath: string
): void {
  rmSync(expandedPath, { recursive: true, force: true });
  mkdirSync(expandedPath, { recursive: true, mode: 0o755 });
  try {
    runner("xar", ["-xf", componentPath, "-C", expandedPath]);
    runner("bsdtar", ["--no-xattrs", "--format", "cpio", "-czf", join(expandedPath, "Payload"), "."], { cwd: payloadRoot });
    runner("bsdtar", ["--no-xattrs", "--format", "cpio", "-czf", join(expandedPath, "Scripts"), "."], { cwd: scriptsRoot });
    runner("mkbom", [payloadRoot, join(expandedPath, "Bom")]);
    rewritePayloadSummary(join(expandedPath, "PackageInfo"), payloadRoot);
    rmSync(componentPath, { force: true });
    runner("xar", [
      "--distribution",
      "--compression",
      "none",
      "-cf",
      componentPath,
      "Bom",
      "Payload",
      "Scripts",
      "PackageInfo"
    ], { cwd: expandedPath });
  } finally {
    rmSync(expandedPath, { recursive: true, force: true });
  }
}

function rewritePayloadSummary(packageInfoPath: string, payloadRoot: string): void {
  if (!existsSync(packageInfoPath)) {
    return;
  }
  const current = readFileSync(packageInfoPath, "utf8");
  const summary = `<payload numberOfFiles="${entryCount(payloadRoot)}" installKBytes="${payloadInstallKBytes(payloadRoot)}"/>`;
  const updated = current.replace(/<payload numberOfFiles="\d+" installKBytes="\d+"\/>/, summary);
  if (updated === current) {
    throw new Error("package_inspection_failed");
  }
  writeFileSync(packageInfoPath, updated, "utf8");
}

function entryCount(root: string): number {
  return 1 + readdirSync(root).reduce((count, name) => {
    const path = join(root, name);
    return count + 1 + (statSync(path).isDirectory() ? entryCount(path) - 1 : 0);
  }, 0);
}

function payloadInstallKBytes(root: string): number {
  const bytes = walk(root).reduce((total, path) => total + statSync(path).size, 0);
  return Math.ceil(bytes / 1024);
}

function run(command: string, args: string[], options?: DistributionCommandOptions): string {
  return execFileSync(command, args, {
    cwd: options?.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
