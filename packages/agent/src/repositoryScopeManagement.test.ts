import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStorageClient } from "@tirion/agent-storage";
import { RepositoryScopeManagement } from "./repositoryScopeManagement";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("repository scope management", () => {
  it("stores locators encrypted and returns only opaque public scopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-repo-scope-"));
    roots.push(root);
    const repository = join(root, "sensitive-project-name");
    execFileSync("git", ["init", repository]);
    const databasePath = join(root, "agent.db");
    const storage = new AgentStorageClient({ databasePath });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_shadow",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "repository-locator.key"));
    await expect(scopes.add(homedir(), "root", metadata.environmentId, "2026-06-08T00:00:00.500Z"))
      .rejects.toThrow("invalid_request");
    const scope = await scopes.add(repository, "repository", metadata.environmentId, "2026-06-08T00:00:01.000Z");
    expect(scope).toMatchObject({ kind: "repository", state: "active", label: "sensitive-project-name" });
    expect(JSON.stringify(await scopes.list())).not.toContain(repository);
    const canonicalRepository = realpathSync(repository);
    expect(await scopes.locator(scope.scopeId)).toMatchObject({ path: canonicalRepository });
    expect(await scopes.setState(scope.scopeId, "paused", "2026-06-08T00:00:02.000Z")).toMatchObject({ state: "paused" });
    expect(await scopes.status(scope.scopeId)).toMatchObject({ health: "paused", reasonCodes: ["scope_paused"] });
    expect(await scopes.activeLocators()).toEqual([]);
    await storage.close();
    for (const path of [databasePath, `${databasePath}-wal`]) {
      if (existsSync(path)) {
        expect(readFileSync(path).includes(Buffer.from(canonicalRepository))).toBe(false);
      }
    }
  });

  it("normalizes legacy provider-pinned scopes back to provider-neutral repository identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-repo-scope-legacy-"));
    roots.push(root);
    const repository = join(root, "shared-project");
    execFileSync("git", ["init", repository]);
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_shadow",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "repository-locator.key"));
    const scope = await scopes.add(repository, "repository", metadata.environmentId, "2026-06-08T00:00:01.000Z");
    const [stored] = await storage.listRepositoryScopes();
    await storage.upsertRepositoryScope({
      ...stored,
      scope: { ...stored.scope, provider: "github-copilot" }
    });

    expect(await scopes.list()).toEqual([
      expect.not.objectContaining({ provider: expect.any(String) })
    ]);
    expect(await scopes.add(repository, "repository", metadata.environmentId, "2026-06-08T00:00:02.000Z"))
      .toEqual(expect.not.objectContaining({ provider: expect.any(String) }));
    expect(await scopes.status(scope.scopeId)).toMatchObject({
      scope: expect.not.objectContaining({ provider: expect.any(String) })
    });
    expect(await scopes.activeLocators()).toEqual([
      expect.objectContaining({ path: realpathSync(repository) })
    ]);
    await storage.close();
  });

  it("keeps temporary workspace leases in memory and expires them after missed heartbeats", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-repo-lease-"));
    roots.push(root);
    const repository = join(root, "temporary-project");
    execFileSync("git", ["init", repository]);
    const databasePath = join(root, "agent.db");
    const storage = new AgentStorageClient({ databasePath });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    let now = new Date("2026-06-08T00:00:00.000Z");
    const scopes = new RepositoryScopeManagement(
      storage,
      join(root, "repository-locator.key"),
      () => now
    );
    const lease = scopes.acquireWorkspaceLease(repository, metadata.environmentId, 60_000);
    expect(lease).toMatchObject({ label: "temporary-project", environmentId: metadata.environmentId });
    expect(await scopes.list()).toEqual([]);
    expect(scopes.listWorkspaceLeases()).toEqual([lease]);
    expect(await scopes.activeLocators()).toEqual([
      expect.objectContaining({ scopeId: lease.leaseId, path: realpathSync(repository) })
    ]);
    expect(scopes.renewWorkspaceLease(lease.leaseId, 60_000)?.expiresAt).toBe(lease.expiresAt);

    now = new Date("2026-06-08T00:01:01.000Z");
    expect(scopes.pruneExpiredLeases()).toBe(1);
    expect(scopes.listWorkspaceLeases()).toEqual([]);
    expect(await scopes.activeLocators()).toEqual([]);
    await storage.close();

    for (const path of [databasePath, `${databasePath}-wal`]) {
      if (existsSync(path)) {
        expect(readFileSync(path).includes(Buffer.from(realpathSync(repository)))).toBe(false);
      }
    }
  });
});
