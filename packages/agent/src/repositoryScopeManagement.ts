import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type {
  RepositoryScopeStatusV1,
  RepositoryScopeV1,
  RepositoryWorkspaceLeaseV1
} from "@tirion/agent-contract";
import type { AgentStorageClient, EncryptedRepositoryScope } from "@tirion/agent-storage";
import { writePrivateFileAtomic } from "@tirion/platform";

export type RepositoryLocator = {
  scopeId: string;
  kind: RepositoryScopeV1["kind"];
  path: string;
};

export type PersistentRepositoryLocator = RepositoryLocator & {
  state: RepositoryScopeV1["state"];
};

export class RepositoryScopeManagement {
  private readonly key: Buffer;
  private readonly workspaceLeases = new Map<string, {
    lease: RepositoryWorkspaceLeaseV1;
    locator: RepositoryLocator;
  }>();

  constructor(
    private readonly storage: AgentStorageClient,
    keyPath: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.key = readOrCreateKey(keyPath);
  }

  async add(
    requestedPath: string,
    kind: RepositoryScopeV1["kind"],
    environmentId: string,
    now: string
  ): Promise<RepositoryScopeV1> {
    const path = canonicalScopePath(requestedPath, kind);
    for (const record of await this.storage.listRepositoryScopes()) {
      const locator = this.decrypt(record);
      if (locator.path === path && locator.kind === kind) {
        const nextLocator = stripLocatorProvider(locator);
        if (record.scope.state === "active") {
          const scope = stripScopeProvider(record.scope);
          if (scope !== record.scope || nextLocator !== locator) {
            await this.storage.upsertRepositoryScope({ ...this.encrypt(scope, nextLocator), scope });
          }
          return scope;
        }
        const scope = { ...stripScopeProvider(record.scope), state: "active" as const, updatedAt: now };
        await this.storage.upsertRepositoryScope({ ...this.encrypt(scope, nextLocator), scope });
        return scope;
      }
    }
    const scopeId = `scope_${randomUUID()}`;
    const scope: RepositoryScopeV1 = {
      schemaVersion: 1,
      scopeId,
      kind,
      label: basename(path) || "filesystem-root",
      state: "active",
      environmentId,
      addedAt: now,
      updatedAt: now
    };
    await this.storage.upsertRepositoryScope(this.encrypt(scope, { scopeId, kind, path }));
    return scope;
  }

  async list(): Promise<RepositoryScopeV1[]> {
    return (await this.storage.listRepositoryScopes()).map((record) => stripScopeProvider(record.scope));
  }

  async locator(scopeId: string): Promise<RepositoryLocator | undefined> {
    const record = (await this.storage.listRepositoryScopes()).find((item) => item.scope.scopeId === scopeId);
    return record ? stripLocatorProvider(this.decrypt(record)) : undefined;
  }

  async activeLocators(): Promise<RepositoryLocator[]> {
    this.pruneExpiredLeases();
    const persistent = (await this.storage.listRepositoryScopes())
      .filter((record) => record.scope.state === "active")
      .map((record) => stripLocatorProvider(this.decrypt(record)));
    const leases = [...this.workspaceLeases.values()].map((entry) => entry.locator);
    return uniqueLocators([...persistent, ...leases]);
  }

  async persistentLocators(): Promise<PersistentRepositoryLocator[]> {
    return (await this.storage.listRepositoryScopes()).map((record) => ({
      ...stripLocatorProvider(this.decrypt(record)),
      state: stripScopeProvider(record.scope).state
    }));
  }

  async allLocators(): Promise<RepositoryLocator[]> {
    this.pruneExpiredLeases();
    const persistent = (await this.storage.listRepositoryScopes()).map((record) => stripLocatorProvider(this.decrypt(record)));
    const leases = [...this.workspaceLeases.values()].map((entry) => entry.locator);
    return uniqueLocators([...persistent, ...leases]);
  }

  acquireWorkspaceLease(
    requestedPath: string,
    environmentId: string,
    ttlMs: number
  ): RepositoryWorkspaceLeaseV1 {
    const path = canonicalScopePath(requestedPath, "repository");
    const expiresAt = new Date(this.now().getTime() + validLeaseTtl(ttlMs)).toISOString();
    const existing = [...this.workspaceLeases.values()].find((entry) => entry.locator.path === path);
    if (existing) {
      existing.lease = { ...existing.lease, expiresAt };
      return existing.lease;
    }
    const leaseId = `lease_${randomUUID()}`;
    const lease: RepositoryWorkspaceLeaseV1 = {
      schemaVersion: 1,
      leaseId,
      label: basename(path) || "repository",
      environmentId,
      expiresAt
    };
    this.workspaceLeases.set(leaseId, {
      lease,
      locator: { scopeId: leaseId, kind: "repository", path }
    });
    return lease;
  }

  renewWorkspaceLease(leaseId: string, ttlMs: number): RepositoryWorkspaceLeaseV1 | undefined {
    this.pruneExpiredLeases();
    const entry = this.workspaceLeases.get(leaseId);
    if (!entry) {
      return undefined;
    }
    entry.lease = {
      ...entry.lease,
      expiresAt: new Date(this.now().getTime() + validLeaseTtl(ttlMs)).toISOString()
    };
    return entry.lease;
  }

  releaseWorkspaceLease(leaseId: string): boolean {
    return this.workspaceLeases.delete(leaseId);
  }

  listWorkspaceLeases(): RepositoryWorkspaceLeaseV1[] {
    this.pruneExpiredLeases();
    return [...this.workspaceLeases.values()].map((entry) => entry.lease);
  }

  pruneExpiredLeases(): number {
    const now = this.now().getTime();
    let removed = 0;
    for (const [leaseId, entry] of this.workspaceLeases) {
      if (Date.parse(entry.lease.expiresAt) <= now) {
        this.workspaceLeases.delete(leaseId);
        removed += 1;
      }
    }
    return removed;
  }

  async status(scopeId: string): Promise<RepositoryScopeStatusV1 | undefined> {
    const record = (await this.storage.listRepositoryScopes()).find((item) => item.scope.scopeId === scopeId);
    if (!record) {
      return undefined;
    }
    if (record.scope.state === "paused") {
      return { schemaVersion: 1, scope: stripScopeProvider(record.scope), health: "paused", reasonCodes: ["scope_paused"] };
    }
    const locator = this.decrypt(record);
    try {
      if (!statSync(locator.path).isDirectory()) {
        throw new Error("unavailable");
      }
      return { schemaVersion: 1, scope: stripScopeProvider(record.scope), health: "healthy", reasonCodes: [] };
    } catch {
      return { schemaVersion: 1, scope: stripScopeProvider(record.scope), health: "unavailable", reasonCodes: ["locator_unavailable"] };
    }
  }

  async setState(scopeId: string, state: RepositoryScopeV1["state"], now: string): Promise<RepositoryScopeV1 | undefined> {
    const record = (await this.storage.listRepositoryScopes()).find((item) => item.scope.scopeId === scopeId);
    if (!record) {
      return undefined;
    }
    const scope = { ...stripScopeProvider(record.scope), state, updatedAt: now };
    await this.storage.upsertRepositoryScope({ ...this.encrypt(scope, stripLocatorProvider(this.decrypt(record))), scope });
    return scope;
  }

  async remove(scopeId: string): Promise<boolean> {
    return await this.storage.removeRepositoryScope(scopeId);
  }

  private encrypt(scope: RepositoryScopeV1, locator: RepositoryLocator): EncryptedRepositoryScope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(scope.scopeId, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(locator), "utf8"), cipher.final()]);
    return {
      scope,
      locatorCiphertext: ciphertext.toString("base64"),
      locatorIv: iv.toString("base64"),
      locatorTag: cipher.getAuthTag().toString("base64")
    };
  }

  private decrypt(record: EncryptedRepositoryScope): RepositoryLocator {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.locatorIv, "base64"));
      decipher.setAAD(Buffer.from(record.scope.scopeId, "utf8"));
      decipher.setAuthTag(Buffer.from(record.locatorTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.locatorCiphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
      const locator = JSON.parse(plaintext) as RepositoryLocator;
      if (
        locator.scopeId !== record.scope.scopeId
        || locator.kind !== record.scope.kind
        || typeof locator.path !== "string"
        || locator.path.length === 0
      ) {
        throw new Error("invalid_locator");
      }
      return locator;
    } catch {
      throw new Error("storage_unavailable");
    }
  }
}

function stripScopeProvider(scope: RepositoryScopeV1): RepositoryScopeV1 {
  if (!("provider" in scope)) {
    return scope;
  }
  const { provider: _legacyProvider, ...providerNeutral } = scope;
  return providerNeutral;
}

function stripLocatorProvider(locator: RepositoryLocator & { provider?: unknown }): RepositoryLocator {
  if (!("provider" in locator)) {
    return locator;
  }
  const { provider: _legacyProvider, ...providerNeutral } = locator;
  return providerNeutral;
}

function uniqueLocators(locators: RepositoryLocator[]): RepositoryLocator[] {
  const seen = new Set<string>();
  return locators.filter((locator) => {
    if (seen.has(locator.path)) {
      return false;
    }
    seen.add(locator.path);
    return true;
  });
}

function validLeaseTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 5 * 60_000) {
    throw new Error("invalid_request");
  }
  return ttlMs;
}

function readOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length !== 32) {
      throw new Error("storage_unavailable");
    }
    return key;
  }
  const key = randomBytes(32);
  writePrivateFileAtomic(path, `${key.toString("base64")}\n`);
  return key;
}

function canonicalScopePath(requestedPath: string, kind: RepositoryScopeV1["kind"]): string {
  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.length > 10_000) {
    throw new Error("invalid_request");
  }
  let canonical = realpathSync(requestedPath);
  if (!statSync(canonical).isDirectory()) {
    throw new Error("invalid_request");
  }
  if (kind === "root" && canonical === realpathSync(homedir())) {
    throw new Error("invalid_request");
  }
  if (kind === "repository") {
    try {
      canonical = realpathSync(execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      }).trim());
    } catch {
      throw new Error("invalid_request");
    }
  }
  return canonical;
}
