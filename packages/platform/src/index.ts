import { chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parsePublicOwnershipMarkerV1,
  PublicOwnershipMarkerV1
} from "@tirion/agent-contract";

export type AgentPaths = {
  stateDir: string;
  databasePath: string;
  lockPath: string;
  bootstrapTokenPath: string;
  otlpTokenPath?: string;
  ownershipMarkerPath: string;
  repositoryLocatorKeyPath: string;
  attributionHmacKeyPath: string;
  preUpgradeBackupPath?: string;
  logPath?: string;
  socketPath: string;
};

export function resolveAgentPaths(environment: NodeJS.ProcessEnv = process.env): AgentPaths {
  const stateDir = environment.TIRION_AGENT_STATE_DIR
    ?? (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Tirion", "agent")
      : join(homedir(), ".local", "state", "tirion", "agent"));
  const runtimeDir = environment.TIRION_AGENT_RUNTIME_DIR ?? join(tmpdir(), `tirion-${process.getuid?.() ?? "user"}`);
  return {
    stateDir,
    databasePath: join(stateDir, "agent.db"),
    lockPath: join(stateDir, "agent.lock"),
    bootstrapTokenPath: join(stateDir, "bootstrap.token"),
    otlpTokenPath: join(stateDir, "otlp.token"),
    ownershipMarkerPath: join(stateDir, "ownership.json"),
    repositoryLocatorKeyPath: join(stateDir, "repository-locator.key"),
    attributionHmacKeyPath: join(stateDir, "attribution-hmac.key"),
    preUpgradeBackupPath: join(stateDir, "pre-upgrade-agent.db"),
    logPath: join(stateDir, "agent.log.jsonl"),
    socketPath: environment.TIRION_AGENT_SOCKET ?? join(runtimeDir, "agent.sock")
  };
}

export function readPublicOwnershipMarker(path: string): PublicOwnershipMarkerV1 | undefined {
  try {
    return parsePublicOwnershipMarkerV1(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

export function writePublicOwnershipMarker(path: string, marker: PublicOwnershipMarkerV1): void {
  const validated = parsePublicOwnershipMarkerV1(marker);
  writePrivateFileAtomic(path, `${JSON.stringify(validated)}\n`);
}

export function writePrivateFileAtomic(path: string, content: string): void {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export type ExclusiveLock = {
  release(): void;
};

export function acquireExclusiveLock(path: string): ExclusiveLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd = openExclusive(path);
  writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8" });
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      closeSync(fd);
      rmSync(path, { force: true });
    }
  };
}

function openExclusive(path: string): number {
  try {
    return openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if (!isFileExistsError(error) || lockOwnerMayBeLive(path)) {
      throw new Error("ownership_conflict");
    }
    rmSync(path, { force: true });
    try {
      return openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch {
      throw new Error("ownership_conflict");
    }
  }
}

function lockOwnerMayBeLive(path: string): boolean {
  try {
    const text = readFileSync(path, "utf8").trim();
    const pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return true;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !isNoSuchProcessError(error);
    }
  } catch {
    return true;
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export type MacOsLaunchAgent = {
  label: "dev.tirion.agent";
  plistPath: string;
  content: string;
};

export function macOsLaunchAgent(
  agentEntry: string,
  nodeEntry = process.execPath,
  _environment: NodeJS.ProcessEnv = process.env
): MacOsLaunchAgent {
  const label = "dev.tirion.agent";
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const content = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    `  <key>Label</key><string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(nodeEntry)}</string>`,
    `    <string>${xmlEscape(agentEntry)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>ProcessType</key><string>Background</string>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
  return { label, plistPath, content };
}

export function writeMacOsLaunchAgent(definition: MacOsLaunchAgent): void {
  ensurePrivateDirectory(dirname(definition.plistPath));
  writeFileSync(definition.plistPath, definition.content, { encoding: "utf8", mode: 0o600 });
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
