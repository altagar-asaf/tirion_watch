import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { ArtifactStateEvidence } from "../types";
import { GitHubRepositoryIdentity } from "../types";
import { AttributionHasher } from "./fingerprints";

const execFileAsync = promisify(execFile);
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const READ_ONLY_GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
export const MAX_WORKTREE_SNAPSHOT_ARTIFACTS = 100;
const MAX_STATUS_ENTRY_STAT_CANDIDATES = MAX_WORKTREE_SNAPSHOT_ARTIFACTS * 4;
const STATUS_ENTRY_STAT_CONCURRENCY = 16;

export type GitRepository = {
  root: string;
  commonDir: string;
  repoKey: string;
};

export type GitDiscovery = {
  repositories: GitRepository[];
  skippedCount: number;
};

export type GitRefSnapshot = {
  refKey: string;
  head: string;
};

type StatusEntryStat = (path: string) => Promise<Stats>;

export type GitArtifactSnapshot = {
  identifier: string;
  previousIdentifier?: string;
  artifactKey: string;
  previousArtifactKey?: string;
  blobKey: string;
  worktreeStateKey?: string;
  indexStateKey?: string;
  addedLines: number;
  deletedLines: number;
  classification: "text" | "binary" | "deleted" | "unknown";
  changeKind: ArtifactStateEvidence["changeKind"];
};

export type GitWorktreeSnapshot = {
  repo: GitRepository;
  headCommit?: string;
  branch?: string;
  dirty: boolean;
  dirtyKnown: boolean;
  /** Whether every dirty artifact is represented in the bounded snapshot. */
  artifactCoverage: "complete" | "partial";
  capturedAt: string;
  artifacts: GitArtifactSnapshot[];
};

export type GitCommitSnapshot = {
  repo: GitRepository;
  commitHash: string;
  commitMessage: string;
  parentHashes: string[];
  committedAt: string;
  artifactKeys: string[];
  artifactStates: ArtifactStateEvidence[];
  addedLines: number;
  deletedLines: number;
  capturedAt: string;
};

export class GitCli {
  constructor(
    private readonly hasher: AttributionHasher,
    private readonly statusEntryStat: StatusEntryStat = async (filePath) => await fs.stat(filePath)
  ) {}

  async discoverRepositories(workspaceFolders: string[]): Promise<GitDiscovery> {
    const repositories = new Map<string, GitRepository>();
    let skippedCount = 0;

    for (const folder of workspaceFolders) {
      try {
        const root = await this.git(folder, ["rev-parse", "--show-toplevel"]);
        const commonDirRaw = await this.git(root, ["rev-parse", "--git-common-dir"]);
        const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(root, commonDirRaw);
        const repoKey = this.hasher.repoKey(root, commonDir);
        repositories.set(root, { root, commonDir, repoKey });
      } catch {
        skippedCount += 1;
      }
    }

    return { repositories: [...repositories.values()], skippedCount };
  }

  async snapshot(repo: GitRepository): Promise<GitWorktreeSnapshot> {
    const capturedAt = new Date().toISOString();
    const [headCommit, branch, statusOutput, numstatOutput] = await Promise.all([
      this.gitOptional(repo.root, ["rev-parse", "HEAD"]),
      this.gitOptional(repo.root, ["branch", "--show-current"]),
      this.gitOptional(repo.root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], true, false),
      this.gitOptional(repo.root, ["diff", "--numstat", "HEAD", "--"])
    ]);
    const changedEntries = parseStatusEntries(statusOutput ?? "");
    const prioritizedEntries = await prioritizeStatusEntries(repo.root, changedEntries, this.statusEntryStat);
    const statsByIdentifier = parseNumstat(numstatOutput ?? "");
    const artifacts: GitArtifactSnapshot[] = [];

    for (const entry of prioritizedEntries.slice(0, MAX_WORKTREE_SNAPSHOT_ARTIFACTS)) {
      artifacts.push(await this.artifactSnapshot(repo, entry, statsByIdentifier.get(normalizeGitIdentifier(entry.identifier))));
    }

    return {
      repo,
      headCommit,
      branch,
      dirty: changedEntries.length > 0,
      dirtyKnown: statusOutput != null,
      artifactCoverage: artifacts.length === changedEntries.length ? "complete" : "partial",
      capturedAt,
      artifacts
    };
  }

  async commitDiff(repo: GitRepository, commitHash: string): Promise<GitCommitSnapshot | null> {
    const parentLine = await this.gitOptional(repo.root, ["show", "-s", "--format=%P", commitHash], true);
    if (parentLine == null) {
      return null;
    }

    const parentHashes = parentLine.trim() === "" ? [] : parentLine.trim().split(/\s+/);
    const base = parentHashes[0] ?? EMPTY_TREE_HASH;
    const [committedAtOutput, commitMessageOutput, nameOutput, numstatOutput] = await Promise.all([
      this.gitOptional(repo.root, ["show", "-s", "--format=%cI", commitHash]),
      this.gitOptional(repo.root, ["show", "-s", "--format=%s", commitHash]),
      this.gitOptional(repo.root, ["diff", "--name-status", "-z", "--find-renames", base, commitHash, "--"], false, false),
      this.gitOptional(repo.root, ["diff", "--numstat", base, commitHash, "--"])
    ]);
    if (committedAtOutput == null || commitMessageOutput == null || nameOutput == null || numstatOutput == null) {
      return null;
    }

    const changes = parseNameStatus(nameOutput);
    const stats = parseNumstat(numstatOutput);
    let addedLines = 0;
    let deletedLines = 0;
    for (const stat of stats.values()) {
      addedLines += stat.addedLines;
      deletedLines += stat.deletedLines;
    }

    const artifactStates: ArtifactStateEvidence[] = [];
    for (const change of changes) {
      const stat = stats.get(normalizeGitIdentifier(change.identifier));
      const rawOid = change.changeKind === "deleted"
        ? undefined
        : await this.gitOptional(repo.root, ["rev-parse", `${commitHash}:${change.identifier}`]);
      artifactStates.push({
        artifactKey: this.hasher.artifactKey(repo.repoKey, change.identifier),
        previousArtifactKey: change.previousIdentifier
          ? this.hasher.artifactKey(repo.repoKey, change.previousIdentifier)
          : undefined,
        stateKey: rawOid ? this.hasher.blobKey(rawOid) : undefined,
        changeKind: stat?.binary ? "binary" : change.changeKind,
        observedSequence: 0
      });
    }

    return {
      repo,
      commitHash,
      commitMessage: commitMessageOutput.trim(),
      parentHashes,
      committedAt: committedAtOutput,
      artifactKeys: uniqueStrings(artifactStates.map((state) => state.artifactKey)),
      artifactStates,
      addedLines,
      deletedLines,
      capturedAt: new Date().toISOString()
    };
  }

  async currentHead(repo: GitRepository): Promise<string | undefined> {
    return this.gitOptional(repo.root, ["rev-parse", "HEAD"]);
  }

  async commitMessage(repo: GitRepository, commitHash: string): Promise<string | undefined> {
    const message = await this.gitOptional(repo.root, ["show", "-s", "--format=%s", commitHash]);
    return message?.trim() || undefined;
  }

  async githubRepository(repo: GitRepository): Promise<GitHubRepositoryIdentity | undefined> {
    const output = await this.gitOptional(repo.root, ["config", "--get-regexp", "^remote\\..*\\.url$"], true);
    return resolveGitHubRepositoryIdentity(output ?? "");
  }

  async currentRefKey(repo: GitRepository): Promise<string | undefined> {
    const ref = await this.gitOptional(repo.root, ["symbolic-ref", "--quiet", "HEAD"]);
    return ref ? this.hasher.fingerprint(`ref:${repo.repoKey}:${ref}`) : undefined;
  }

  async listRefs(repo: GitRepository): Promise<GitRefSnapshot[]> {
    const output = await this.gitOptional(
      repo.root,
      ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"],
      true
    );
    if (output == null || output === "") {
      return [];
    }
    return output.split(/\r?\n/).flatMap((line) => {
      const [ref, head] = line.split("\0");
      return ref && head
        ? [{ refKey: this.hasher.fingerprint(`ref:${repo.repoKey}:${ref}`), head }]
        : [];
    });
  }

  async commitsBetween(repo: GitRepository, previousHead: string, currentHead: string): Promise<string[]> {
    const range = await this.gitOptional(repo.root, ["rev-list", "--reverse", `${previousHead}..${currentHead}`]);
    if (!range) {
      return currentHead === previousHead ? [] : [currentHead];
    }
    return range.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  async isAncestor(repo: GitRepository, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.gitOptional(repo.root, ["merge-base", "--is-ancestor", ancestor, descendant], true);
    return result != null;
  }

  private async artifactSnapshot(
    repo: GitRepository,
    entry: GitStatusEntry,
    stats?: { addedLines: number; deletedLines: number; binary: boolean }
  ): Promise<GitArtifactSnapshot> {
    const identifier = entry.identifier;
    const artifactKey = this.hasher.artifactKey(repo.repoKey, identifier);
    const previousArtifactKey = entry.previousIdentifier
      ? this.hasher.artifactKey(repo.repoKey, entry.previousIdentifier)
      : undefined;
    const absolute = path.resolve(repo.root, identifier);
    const stat = await fs.stat(absolute).catch(() => null);
    const rawIndexOid = await this.gitOptional(repo.root, ["ls-files", "-s", "--", identifier]);
    const indexOid = rawIndexOid?.split(/\s+/)[1];
    const indexStateKey = indexOid ? this.hasher.blobKey(indexOid) : undefined;
    if (!stat || !stat.isFile()) {
      return {
        identifier,
        previousIdentifier: entry.previousIdentifier,
        artifactKey,
        previousArtifactKey,
        blobKey: this.hasher.blobKey(`deleted:${artifactKey}`),
        indexStateKey,
        addedLines: stats?.addedLines ?? 0,
        deletedLines: stats?.deletedLines ?? 0,
        classification: "deleted",
        changeKind: "deleted"
      };
    }

    const rawWorktreeOid = await this.gitOptional(repo.root, ["hash-object", "--path", identifier, "--", identifier]);
    const worktreeStateKey = rawWorktreeOid ? this.hasher.blobKey(rawWorktreeOid) : undefined;
    const binary = await isBinaryFile(absolute);
    return {
      identifier,
      previousIdentifier: entry.previousIdentifier,
      artifactKey,
      previousArtifactKey,
      blobKey: worktreeStateKey ?? indexStateKey ?? this.hasher.blobKey(`unknown:${artifactKey}`),
      worktreeStateKey,
      indexStateKey,
      addedLines: stats?.addedLines ?? 0,
      deletedLines: stats?.deletedLines ?? 0,
      classification: binary ? "binary" : "text",
      changeKind: binary ? "binary" : entry.changeKind
    };
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: READ_ONLY_GIT_ENV,
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8"
    });
    return stdout.trim();
  }

  private async gitOptional(cwd: string, args: string[], allowEmptySuccess = false, trimOutput = true): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        env: READ_ONLY_GIT_ENV,
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8"
      });
      const output = trimOutput ? stdout.trim() : stdout;
      return output || allowEmptySuccess ? output : undefined;
    } catch {
      return undefined;
    }
  }
}

async function prioritizeStatusEntries(
  root: string,
  entries: GitStatusEntry[],
  statFile: StatusEntryStat
): Promise<GitStatusEntry[]> {
  const candidates = boundedStatusEntryCandidates(entries);
  if (candidates.length <= MAX_WORKTREE_SNAPSHOT_ARTIFACTS) {
    return candidates;
  }
  const ranked = await mapConcurrent(candidates, STATUS_ENTRY_STAT_CONCURRENCY, async (entry, index) => {
    const absolute = path.resolve(root, entry.identifier);
    const stat = await statFile(absolute).catch(() => undefined);
    return {
      entry,
      index,
      mtimeMs: stat?.isFile() ? stat.mtimeMs : 0
    };
  });
  return ranked
    .sort((left, right) =>
      right.mtimeMs - left.mtimeMs
      || left.entry.identifier.localeCompare(right.entry.identifier)
      || left.index - right.index)
    .map((item) => item.entry);
}

function boundedStatusEntryCandidates(entries: GitStatusEntry[]): GitStatusEntry[] {
  if (entries.length <= MAX_STATUS_ENTRY_STAT_CANDIDATES) {
    return entries;
  }
  const direct: Array<{ entry: GitStatusEntry; index: number }> = [];
  const nested: Array<{ entry: GitStatusEntry; index: number }> = [];
  entries.forEach((entry, index) => {
    (entry.identifier.includes("/") ? nested : direct).push({ entry, index });
  });
  const directBudget = Math.min(direct.length, Math.ceil(MAX_STATUS_ENTRY_STAT_CANDIDATES / 2));
  const nestedBudget = Math.min(nested.length, MAX_STATUS_ENTRY_STAT_CANDIDATES - directBudget);
  const remainingBudget = MAX_STATUS_ENTRY_STAT_CANDIDATES - directBudget - nestedBudget;
  const directCount = Math.min(direct.length, directBudget + remainingBudget);
  const nestedCount = Math.min(nested.length, nestedBudget + Math.max(0, remainingBudget - (directCount - directBudget)));
  return [
    ...sampleStatusEntries(direct, directCount),
    ...sampleStatusEntries(nested, nestedCount)
  ]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.entry);
}

function sampleStatusEntries<T>(entries: T[], count: number): T[] {
  if (count >= entries.length) {
    return entries;
  }
  if (count <= 0 || entries.length === 0) {
    return [];
  }
  if (count === 1) {
    return [entries[0]];
  }
  return Array.from({ length: count }, (_, index) => {
    const selected = Math.floor(index * (entries.length - 1) / (count - 1));
    return entries[selected];
  });
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function resolveGitHubRepositoryIdentity(configOutput: string): GitHubRepositoryIdentity | undefined {
  const identities = configOutput.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^remote\.([^.]+)\.url\s+(.+)$/);
    const identity = match ? parseGitHubRemote(match[2].trim()) : undefined;
    return identity ? [{ remote: match![1], identity }] : [];
  });
  const origin = identities.find((item) => item.remote === "origin");
  if (origin) {
    return origin.identity;
  }
  const unique = new Map(identities.map((item) => [`${item.identity.owner}/${item.identity.repository}`.toLowerCase(), item.identity]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

export function parseGitHubRemote(remoteUrl: string): GitHubRepositoryIdentity | undefined {
  const scp = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (scp) {
    return githubIdentity(scp[1], scp[2]);
  }
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }
    const parts = parsed.pathname.replace(/^\/|\/$/g, "").split("/");
    return parts.length === 2 ? githubIdentity(parts[0], parts[1].replace(/\.git$/i, "")) : undefined;
  } catch {
    return undefined;
  }
}

function githubIdentity(owner: string, repository: string): GitHubRepositoryIdentity | undefined {
  return /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(repository)
    ? { host: "github.com", owner, repository }
    : undefined;
}

type GitStatusEntry = {
  identifier: string;
  previousIdentifier?: string;
  changeKind: ArtifactStateEvidence["changeKind"];
};

function parseStatusEntries(output: string): GitStatusEntry[] {
  const entries = output.split("\0").filter(Boolean);
  const parsed: GitStatusEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const identifier = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const previousIdentifier = entries[index + 1];
      if (identifier && previousIdentifier) {
        parsed.push({ identifier, previousIdentifier, changeKind: "renamed" });
        index += 1;
        continue;
      }
    }
    if (identifier) {
      parsed.push({ identifier, changeKind: changeKindFromStatus(status) });
    }
  }

  return parsed;
}

function parseNameStatus(output: string): GitStatusEntry[] {
  const entries = output.split("\0").filter(Boolean);
  const parsed: GitStatusEntry[] = [];
  for (let index = 0; index < entries.length;) {
    const status = entries[index++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousIdentifier = entries[index++];
      const identifier = entries[index++];
      if (identifier && previousIdentifier) {
        parsed.push({ identifier, previousIdentifier, changeKind: "renamed" });
      }
      continue;
    }
    const identifier = entries[index++];
    if (identifier) {
      parsed.push({ identifier, changeKind: changeKindFromStatus(status) });
    }
  }
  return parsed;
}

function changeKindFromStatus(status: string): ArtifactStateEvidence["changeKind"] {
  if (status.includes("D")) {
    return "deleted";
  }
  if (status.includes("A") || status === "??") {
    return "added";
  }
  if (status.includes("R") || status.includes("C")) {
    return "renamed";
  }
  return "modified";
}

function parseNumstat(output: string): Map<string, { addedLines: number; deletedLines: number; binary: boolean }> {
  const stats = new Map<string, { addedLines: number; deletedLines: number; binary: boolean }>();
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const [addedRaw, deletedRaw, identifierRaw] = line.split("\t");
    if (!identifierRaw) {
      continue;
    }
    const identifier = normalizeGitIdentifier(identifierRaw);
    stats.set(identifier, {
      addedLines: parseNumstatNumber(addedRaw),
      deletedLines: parseNumstatNumber(deletedRaw),
      binary: addedRaw === "-" || deletedRaw === "-"
    });
  }
  return stats;
}

function parseNumstatNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeGitIdentifier(value: string): string {
  return value.replace(/\\/g, "/");
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8_000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}
