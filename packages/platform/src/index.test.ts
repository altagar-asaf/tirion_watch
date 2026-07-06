import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireExclusiveLock,
  ensurePrivateDirectory,
  macOsLaunchAgent,
  readPublicOwnershipMarker,
  resolveAgentPaths,
  writePublicOwnershipMarker
} from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("platform lifecycle", () => {
  it("uses explicit isolated paths", () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-platform-"));
    roots.push(root);
    expect(resolveAgentPaths({ TIRION_AGENT_STATE_DIR: root, TIRION_AGENT_SOCKET: join(root, "socket") })).toMatchObject({
      stateDir: root,
      socketPath: join(root, "socket")
    });
  });

  it("fails closed when a second owner acquires the lock", () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-lock-"));
    roots.push(root);
    const path = join(root, "agent.lock");
    const lock = acquireExclusiveLock(path);
    expect(() => acquireExclusiveLock(path)).toThrow("ownership_conflict");
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("recovers a lock left by a process that no longer exists", () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-stale-lock-"));
    roots.push(root);
    const path = join(root, "agent.lock");
    writeFileSync(path, "2147483647\n");
    const lock = acquireExclusiveLock(path);
    expect(readFileSync(path, "utf8")).toBe(`${process.pid}\n`);
    lock.release();
  });

  it("repairs existing private-directory permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-private-dir-"));
    roots.push(root);
    chmodSync(root, 0o755);
    ensurePrivateDirectory(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("atomically writes and strictly reads the public ownership marker", () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-marker-"));
    roots.push(root);
    const path = join(root, "ownership.json");
    const marker = { schemaVersion: 1, state: "agent_usage_owner", updatedAt: "2026-06-08T00:00:00.000Z" } as const;
    writePublicOwnershipMarker(path, marker);
    expect(readPublicOwnershipMarker(path)).toEqual(marker);
    expect(readFileSync(path, "utf8")).not.toContain("installation");
    writeFileSync(path, JSON.stringify({ ...marker, path: "/private/repo" }));
    expect(readPublicOwnershipMarker(path)).toBeUndefined();
  });

  it("renders a launch agent with escaped executable paths", () => {
    const definition = macOsLaunchAgent(
      "/Applications/Tirion & Agent/agent.js",
      "/Applications/Tirion/node"
    );
    expect(definition.label).toBe("dev.tirion.agent");
    expect(definition.content).toContain("/Applications/Tirion &amp; Agent/agent.js");
    expect(definition.content).toContain("<key>RunAtLoad</key><true/>");
    expect(definition.content).not.toContain("TIRION_BACKEND_URL");
  });
});
