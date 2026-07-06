import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AttributionHasher } from "./fingerprints";
import { GitCli, parseGitHubRemote, resolveGitHubRepositoryIdentity } from "./gitCli";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

describe("GitCli", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("treats an empty successful Git status as a known clean baseline", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-git-cli-"));
    tempDirs.push(dir);
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "tirion@example.test"]);
    await git(dir, ["config", "user.name", "Tirion Test"]);
    await fs.writeFile(path.join(dir, "tracked.txt"), "clean\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-m", "initial"]);

    const cli = new GitCli(new AttributionHasher("test-salt"));
    const discovery = await cli.discoverRepositories([dir]);
    const snapshot = await cli.snapshot(discovery.repositories[0]);

    expect(snapshot).toMatchObject({
      dirty: false,
      dirtyKnown: true,
      artifacts: []
    });
  });

  it("uses the same canonical state key for staged work and the resulting commit", async () => {
    const dir = await repository();
    const cli = new GitCli(new AttributionHasher("test-salt"));
    const [repo] = (await cli.discoverRepositories([dir])).repositories;
    await fs.writeFile(path.join(dir, "tracked.txt"), "agent result\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);

    const snapshot = await cli.snapshot(repo);
    await git(dir, ["commit", "-m", "agent change"]);
    const commit = await cli.commitDiff(repo, (await gitOutput(dir, ["rev-parse", "HEAD"])).trim());

    expect(commit?.commitMessage).toBe("agent change");
    expect(snapshot.artifacts[0].indexStateKey).toBeDefined();
    expect(commit?.artifactStates[0].stateKey).toBe(snapshot.artifacts[0].indexStateKey);
  });

  it("distinguishes staged state from later manual worktree edits", async () => {
    const dir = await repository();
    const cli = new GitCli(new AttributionHasher("test-salt"));
    const [repo] = (await cli.discoverRepositories([dir])).repositories;
    await fs.writeFile(path.join(dir, "tracked.txt"), "agent result\n", "utf8");
    await git(dir, ["add", "tracked.txt"]);
    await fs.writeFile(path.join(dir, "tracked.txt"), "manual follow-up\n", "utf8");

    const snapshot = await cli.snapshot(repo);
    await git(dir, ["commit", "-m", "staged agent state"]);
    const commit = await cli.commitDiff(repo, (await gitOutput(dir, ["rev-parse", "HEAD"])).trim());

    expect(snapshot.artifacts[0].worktreeStateKey).not.toBe(snapshot.artifacts[0].indexStateKey);
    expect(commit?.artifactStates[0].stateKey).toBe(snapshot.artifacts[0].indexStateKey);
    expect(commit?.artifactStates[0].stateKey).not.toBe(snapshot.artifacts[0].worktreeStateKey);
  });

  it("preserves tracked modification paths from porcelain status output", async () => {
    const dir = await repository();
    const cli = new GitCli(new AttributionHasher("test-salt"));
    const [repo] = (await cli.discoverRepositories([dir])).repositories;
    await fs.writeFile(path.join(dir, "tracked.txt"), "modified\n", "utf8");

    const snapshot = await cli.snapshot(repo);

    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({
        artifactKey: new AttributionHasher("test-salt").artifactKey(repo.repoKey, "tracked.txt"),
        changeKind: "modified",
        classification: "text"
      })
    ]);
  });

  it("reports untracked files inside new directories instead of directory placeholders", async () => {
    const dir = await repository();
    const cli = new GitCli(new AttributionHasher("test-salt"));
    const [repo] = (await cli.discoverRepositories([dir])).repositories;
    await fs.mkdir(path.join(dir, "docs"));
    await fs.writeFile(path.join(dir, "docs", "claude-notes.md"), "new notes\n", "utf8");

    const snapshot = await cli.snapshot(repo);

    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({
        identifier: "docs/claude-notes.md",
        artifactKey: new AttributionHasher("test-salt").artifactKey(repo.repoKey, "docs/claude-notes.md"),
        changeKind: "added",
        classification: "text"
      })
    ]);
  });

  it("classifies committed deletions without persisting a state key", async () => {
    const dir = await repository();
    const cli = new GitCli(new AttributionHasher("test-salt"));
    const [repo] = (await cli.discoverRepositories([dir])).repositories;
    await fs.rm(path.join(dir, "tracked.txt"));
    await git(dir, ["add", "-u"]);
    await git(dir, ["commit", "-m", "delete"]);

    const commit = await cli.commitDiff(repo, (await gitOutput(dir, ["rev-parse", "HEAD"])).trim());

    expect(commit?.artifactStates[0]).toMatchObject({ changeKind: "deleted", stateKey: undefined });
  });

  it("preserves privacy-safe rename continuity", async () => {
    const dir = await repository();
    const cli = new GitCli(new AttributionHasher("test-salt"));
    const [repo] = (await cli.discoverRepositories([dir])).repositories;
    await git(dir, ["mv", "tracked.txt", "renamed.txt"]);
    const snapshot = await cli.snapshot(repo);
    await git(dir, ["commit", "-m", "rename"]);
    const commit = await cli.commitDiff(repo, (await gitOutput(dir, ["rev-parse", "HEAD"])).trim());

    expect(snapshot.artifacts[0].changeKind).toBe("renamed");
    expect(snapshot.artifacts[0].previousArtifactKey).toBeDefined();
    expect(commit?.artifactStates[0]).toMatchObject({
      changeKind: "renamed",
      previousArtifactKey: snapshot.artifacts[0].previousArtifactKey,
      artifactKey: snapshot.artifacts[0].artifactKey
    });
  });

  it("classifies committed binary blob states", async () => {
    const dir = await repository();
    const cli = new GitCli(new AttributionHasher("test-salt"));
    const [repo] = (await cli.discoverRepositories([dir])).repositories;
    await fs.writeFile(path.join(dir, "asset.bin"), Buffer.from([0, 1, 2, 3]));
    await git(dir, ["add", "asset.bin"]);
    await git(dir, ["commit", "-m", "binary"]);

    const commit = await cli.commitDiff(repo, (await gitOutput(dir, ["rev-parse", "HEAD"])).trim());

    expect(commit?.artifactStates[0]).toMatchObject({ changeKind: "binary" });
    expect(commit?.artifactStates[0].stateKey).toBeDefined();
  });

  it("parses privacy-safe GitHub.com repository identities from remotes", () => {
    expect(parseGitHubRemote("https://github.com/tirion/extension.git")).toEqual({
      host: "github.com",
      owner: "tirion",
      repository: "extension"
    });
    expect(parseGitHubRemote("git@github.com:tirion/extension.git")).toEqual({
      host: "github.com",
      owner: "tirion",
      repository: "extension"
    });
    expect(parseGitHubRemote("ssh://git@github.com/tirion/extension.git")).toEqual({
      host: "github.com",
      owner: "tirion",
      repository: "extension"
    });
    expect(parseGitHubRemote("https://ghe.example.com/tirion/extension.git")).toBeUndefined();
    expect(parseGitHubRemote("not-a-remote")).toBeUndefined();
  });

  it("prefers origin and rejects ambiguous non-origin GitHub remotes", () => {
    expect(resolveGitHubRepositoryIdentity([
      "remote.upstream.url https://github.com/elsewhere/project.git",
      "remote.origin.url https://github.com/tirion/extension.git"
    ].join("\n"))).toMatchObject({ owner: "tirion", repository: "extension" });

    expect(resolveGitHubRepositoryIdentity([
      "remote.a.url https://github.com/tirion/extension.git",
      "remote.b.url https://github.com/other/extension.git"
    ].join("\n"))).toBeUndefined();
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout;
}

async function repository(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-git-cli-"));
  tempDirs.push(dir);
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "tirion@example.test"]);
  await git(dir, ["config", "user.name", "Tirion Test"]);
  await fs.writeFile(path.join(dir, "tracked.txt"), "initial\n", "utf8");
  await git(dir, ["add", "tracked.txt"]);
  await git(dir, ["commit", "-m", "initial"]);
  return dir;
}
