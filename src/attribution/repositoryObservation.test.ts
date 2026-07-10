import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultPrivacyGuard } from "../privacy/privacyGuard";
import { JsonRepositoryObservationStore } from "../storage/repositoryObservationStore";
import { DiagnosticEvent, RepositoryObservationEvent } from "../types";
import { AttributionHasher } from "./fingerprints";
import { GitCli } from "./gitCli";
import { DefaultRepositoryObservation } from "./repositoryObservation";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

describe("DefaultRepositoryObservation", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("creates an epoch at installation HEAD and never imports that commit", async () => {
    const { repoDir, storageDir, observation } = await setup();
    const installationHead = await gitOutput(repoDir, ["rev-parse", "HEAD"]);

    await observation.start();

    const [epoch] = await observation.listEpochs();
    expect(epoch.initialHead).toBe(installationHead);
    expect(epoch.cursorHead).toBe(installationHead);
    expect(await observation.listCandidates()).toEqual([]);
    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("can defer the initial scan without delaying observer startup", async () => {
    const { repoDir, storageDir } = await setup();
    const cli = new BlockingSecondHeadGitCli(new AttributionHasher("test-salt"));
    const observation = new DefaultRepositoryObservation(
      [repoDir],
      cli,
      new JsonRepositoryObservationStore(storageDir, new DefaultPrivacyGuard()),
      () => undefined,
      60_000
    );

    const startResult = await Promise.race([
      observation.start({ deferInitialScan: true }).then(() => "started" as const),
      wait(100).then(() => "timed_out" as const)
    ]);

    expect(startResult).toBe("started");
    await waitUntil(() => cli.blocked, 500);
    expect(cli.blocked).toBe(true);
    cli.releaseBlockedHead();
    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("persists a commit candidate before advancing the epoch cursor", async () => {
    const { repoDir, storageDir, observation } = await setup();
    await observation.start();
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "agent result\n", "utf8");
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "new"]);
    const head = await gitOutput(repoDir, ["rev-parse", "HEAD"]);

    await observation.scanOnce();

    const [candidate] = await observation.listCandidates();
    const [epoch] = await observation.listEpochs();
    expect(candidate).toMatchObject({
      commitHash: head,
      decision: "pending_evidence",
      transitionKind: "fast_forward"
    });
    expect(candidate.artifactStates[0].stateKey).toBeDefined();
    expect(epoch.cursorHead).toBe(head);
    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("does not advance the checked-out ref cursor when HEAD changes during ref scanning", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-racing-repo-observation-"));
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-racing-repo-observation-storage-"));
    tempDirs.push(repoDir, storageDir);
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "tirion@example.test"]);
    await git(repoDir, ["config", "user.name", "Tirion Test"]);
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "initial\n", "utf8");
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "initial"]);
    const initialHead = await gitOutput(repoDir, ["rev-parse", "HEAD"]);
    const cli = new RacingGitCli(new AttributionHasher("test-salt"));
    const observation = new DefaultRepositoryObservation(
      [repoDir],
      cli,
      new JsonRepositoryObservationStore(storageDir, new DefaultPrivacyGuard()),
      () => undefined,
      60_000
    );
    await observation.start();

    cli.commitDuringNextRefScan(async () => {
      await fs.writeFile(path.join(repoDir, "tracked.txt"), "committed during ref scan\n", "utf8");
      await git(repoDir, ["add", "tracked.txt"]);
      await git(repoDir, ["commit", "-m", "racing commit"]);
    });
    await observation.scanOnce();

    const racedHead = await gitOutput(repoDir, ["rev-parse", "HEAD"]);
    expect((await observation.listEpochs())[0]).toMatchObject({
      cursorHead: initialHead,
      refHeads: expect.objectContaining({ [(await observation.listEpochs())[0].cursorRefKey!]: initialHead })
    });
    expect((await observation.listCandidates()).some((candidate) => candidate.commitHash === racedHead)).toBe(false);

    await observation.scanOnce();

    expect((await observation.listCandidates()).some((candidate) => candidate.commitHash === racedHead)).toBe(true);
    expect((await observation.listEpochs())[0].cursorHead).toBe(racedHead);
    await observation.stop();
  });

  it("recovers a commit made while observation was stopped", async () => {
    const setupState = await setup();
    await setupState.observation.start();
    await setupState.observation.stop();
    await fs.writeFile(path.join(setupState.repoDir, "tracked.txt"), "offline commit\n", "utf8");
    await git(setupState.repoDir, ["add", "tracked.txt"]);
    await git(setupState.repoDir, ["commit", "-m", "offline"]);
    const head = await gitOutput(setupState.repoDir, ["rev-parse", "HEAD"]);
    const restarted = new DefaultRepositoryObservation(
      [setupState.repoDir],
      setupState.cli,
      new JsonRepositoryObservationStore(setupState.storageDir, new DefaultPrivacyGuard()),
      () => undefined,
      60_000
    );

    await restarted.start();

    expect((await restarted.listCandidates())[0].commitHash).toBe(head);
    await restarted.stop();
    await fs.rm(setupState.storageDir, { recursive: true, force: true });
  });

  it("classifies branch switching without creating a rewrite candidate", async () => {
    const { repoDir, storageDir, observation } = await setup();
    await observation.start();
    await git(repoDir, ["checkout", "-b", "other"]);

    await observation.scanOnce();

    expect(await observation.listCandidates()).toEqual([]);
    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("observes a commit made before the first scan after switching branches", async () => {
    const { repoDir, storageDir, observation } = await setup();
    await git(repoDir, ["branch", "other"]);
    await observation.start();
    await git(repoDir, ["checkout", "other"]);
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "branch commit\n", "utf8");
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "branch commit"]);
    const head = await gitOutput(repoDir, ["rev-parse", "HEAD"]);

    await observation.scanOnce();

    expect((await observation.listCandidates()).some((candidate) =>
      candidate.commitHash === head && candidate.transitionKind === "fast_forward"
    )).toBe(true);
    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("observes the first root commit created after an empty-repository epoch", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-empty-repo-observation-"));
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-empty-repo-observation-storage-"));
    tempDirs.push(repoDir);
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "tirion@example.test"]);
    await git(repoDir, ["config", "user.name", "Tirion Test"]);
    const cli = new GitCli(new AttributionHasher("test-salt"));
    const observation = new DefaultRepositoryObservation(
      [repoDir],
      cli,
      new JsonRepositoryObservationStore(storageDir, new DefaultPrivacyGuard()),
      () => undefined,
      60_000
    );
    await observation.start();
    const [initialEpoch] = await observation.listEpochs();
    expect(initialEpoch.initialHead).toBeUndefined();

    await fs.writeFile(path.join(repoDir, "root.txt"), "root commit\n", "utf8");
    await git(repoDir, ["add", "root.txt"]);
    await git(repoDir, ["commit", "-m", "root"]);
    const head = await gitOutput(repoDir, ["rev-parse", "HEAD"]);
    await observation.scanOnce();

    const [candidate] = await observation.listCandidates();
    const [epoch] = await observation.listEpochs();
    expect(candidate).toMatchObject({
      epochId: initialEpoch.epochId,
      commitHash: head,
      transitionKind: "fast_forward",
      reasonCodes: ["root_commit_observed_after_epoch"]
    });
    expect(epoch.cursorHead).toBe(head);
    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("observes commits made on a non-checked-out local ref", async () => {
    const { repoDir, storageDir, observation } = await setup();
    const initialBranch = await gitOutput(repoDir, ["branch", "--show-current"]);
    await git(repoDir, ["branch", "other"]);
    await observation.start();

    await git(repoDir, ["checkout", "other"]);
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "other branch\n", "utf8");
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "other branch commit"]);
    const otherHead = await gitOutput(repoDir, ["rev-parse", "HEAD"]);
    await git(repoDir, ["checkout", initialBranch]);
    await observation.scanOnce();

    expect((await observation.listCandidates()).some((candidate) =>
      candidate.commitHash === otherHead && candidate.transitionKind === "fast_forward"
    )).toBe(true);

    await git(repoDir, ["checkout", "other"]);
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "rewritten other branch\n", "utf8");
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "--amend", "-m", "rewritten other branch commit"]);
    const rewrittenHead = await gitOutput(repoDir, ["rev-parse", "HEAD"]);
    await git(repoDir, ["checkout", initialBranch]);
    await observation.scanOnce();

    expect((await observation.listCandidates()).some((candidate) =>
      candidate.commitHash === rewrittenHead && candidate.transitionKind === "non_fast_forward_ref_update"
    )).toBe(true);
    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("does not advance over a checked-out head change when the initial ref was unavailable", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-ref-recovery-repo-observation-"));
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-ref-recovery-repo-observation-storage-"));
    tempDirs.push(repoDir, storageDir);
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "tirion@example.test"]);
    await git(repoDir, ["config", "user.name", "Tirion Test"]);
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "initial\n", "utf8");
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "initial"]);
    const cli = new InitiallyMissingRefGitCli(new AttributionHasher("test-salt"));
    const observation = new DefaultRepositoryObservation(
      [repoDir],
      cli,
      new JsonRepositoryObservationStore(storageDir, new DefaultPrivacyGuard()),
      () => undefined,
      60_000
    );
    await observation.start();
    expect((await observation.listEpochs())[0].cursorRefKey).toBeUndefined();
    cli.restoreRefReads();

    await fs.writeFile(path.join(repoDir, "tracked.txt"), "agent result\n", "utf8");
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "new"]);
    const head = await gitOutput(repoDir, ["rev-parse", "HEAD"]);

    await observation.scanOnce();

    const [candidate] = await observation.listCandidates();
    expect(candidate).toMatchObject({
      commitHash: head,
      transitionKind: "fast_forward"
    });
    expect((await observation.listEpochs())[0].cursorHead).toBe(head);
    await observation.stop();
  });

  it("classifies deletion of a non-checked-out local ref without superseding HEAD", async () => {
    const { repoDir, storageDir, observation } = await setup();
    await git(repoDir, ["branch", "other"]);
    const events: RepositoryObservationEvent[] = [];
    observation.onObservation((event) => { events.push(event); });
    await observation.start();

    await git(repoDir, ["branch", "-D", "other"]);
    await observation.scanOnce();

    expect(events.some((event) => event.kind === "transition" && event.transitionKind === "ref_deleted")).toBe(true);
    expect(await observation.listCandidates()).toEqual([]);
    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("captures a short-lived dirty file during an active observation window", async () => {
    const { repoDir, storageDir, observation } = await setup();
    const events: RepositoryObservationEvent[] = [];
    observation.onObservation((event) => { events.push(event); });
    await observation.start();

    observation.requestActiveObservationWindow(400, 25);
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "transient dirty state\n", "utf8");
    await wait(200);
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "transient"]);
    const head = await gitOutput(repoDir, ["rev-parse", "HEAD"]);
    await observation.refresh();
    await wait(150);

    const candidate = (await observation.listCandidates()).find((item) => item.commitHash === head);
    expect(candidate).toBeDefined();
    expect(events.some((event) =>
      event.kind === "snapshot"
      && event.snapshot.dirty
      && event.snapshot.artifactStates.length > 0
    )).toBe(true);

    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("keeps polling for the full active observation window after an initially clean scan", async () => {
    const { repoDir, storageDir, observation } = await setup();
    const events: RepositoryObservationEvent[] = [];
    observation.onObservation((event) => { events.push(event); });
    await observation.start();

    observation.requestActiveObservationWindow(800, 25);
    await wait(100);
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "changed after clean active scan\n", "utf8");
    await wait(150);
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "active window"]);
    await wait(300);

    expect(events.some((event) =>
      event.kind === "snapshot"
      && event.snapshot.dirty
      && event.snapshot.artifactStates.length > 0
    )).toBe(true);

    await observation.stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("queues an explicit refresh that arrives during an in-flight scan", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-queued-refresh-observation-"));
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-queued-refresh-observation-storage-"));
    tempDirs.push(repoDir, storageDir);
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "tirion@example.test"]);
    await git(repoDir, ["config", "user.name", "Tirion Test"]);
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "initial\n", "utf8");
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "initial"]);
    const cli = new SlowSnapshotGitCli(new AttributionHasher("test-salt"));
    const events: RepositoryObservationEvent[] = [];
    const diagnostics: DiagnosticEvent[] = [];
    const observation = new DefaultRepositoryObservation(
      [repoDir],
      cli,
      new JsonRepositoryObservationStore(storageDir, new DefaultPrivacyGuard()),
      (event) => diagnostics.push(event),
      60_000
    );
    observation.onObservation((event) => { events.push(event); });
    await observation.start();

    cli.delayNextSnapshot(200);
    const inflightScan = observation.scanOnce();
    await wait(50);
    await fs.writeFile(path.join(repoDir, "live.txt"), "queued refresh dirty state\n", "utf8");
    await observation.refresh();
    await inflightScan;

    expect(events.some((event) =>
      event.kind === "snapshot"
      && event.snapshot.dirty
      && event.snapshot.artifactStates.some((artifact) => artifact.changeKind === "added")
    )).toBe(true);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "constructLifecycle",
        construct: "RepositoryObservation",
        operation: "scan",
        state: "queued",
        reason: "repository_scan_queued_while_inflight"
      }),
      expect.objectContaining({
        kind: "constructLifecycle",
        construct: "RepositoryObservation",
        operation: "scan",
        state: "requeued",
        reason: "repository_scan_draining_queued_requests"
      })
    ]));

    await observation.stop();
  });

  it("coalesces a refresh storm during an in-flight scan into one diagnostic queue event", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-refresh-storm-observation-"));
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-refresh-storm-observation-storage-"));
    tempDirs.push(repoDir, storageDir);
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "tirion@example.test"]);
    await git(repoDir, ["config", "user.name", "Tirion Test"]);
    await fs.writeFile(path.join(repoDir, "tracked.txt"), "initial\n", "utf8");
    await git(repoDir, ["add", "tracked.txt"]);
    await git(repoDir, ["commit", "-m", "initial"]);
    const cli = new SlowSnapshotGitCli(new AttributionHasher("test-salt"));
    const diagnostics: DiagnosticEvent[] = [];
    const observation = new DefaultRepositoryObservation(
      [repoDir],
      cli,
      new JsonRepositoryObservationStore(storageDir, new DefaultPrivacyGuard()),
      (event) => diagnostics.push(event),
      60_000
    );
    await observation.start();

    cli.delayNextSnapshot(200);
    const inflightScan = observation.scanOnce();
    await wait(50);
    await Promise.all(Array.from({ length: 10 }, () => observation.refresh()));
    await inflightScan;

    const queued = diagnostics.filter((event) =>
      event.kind === "constructLifecycle" &&
      event.construct === "RepositoryObservation" &&
      event.operation === "scan" &&
      event.reason === "repository_scan_queued_while_inflight"
    );
    const requeued = diagnostics.filter((event) =>
      event.kind === "constructLifecycle" &&
      event.construct === "RepositoryObservation" &&
      event.operation === "scan" &&
      event.reason === "repository_scan_draining_queued_requests"
    );
    expect(queued).toHaveLength(1);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toMatchObject({
      details: {
        queuedRequestCount: 10
      }
    });

    await observation.stop();
  });
});

async function setup() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-repo-observation-"));
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "tirion-repo-observation-storage-"));
  tempDirs.push(repoDir);
  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.email", "tirion@example.test"]);
  await git(repoDir, ["config", "user.name", "Tirion Test"]);
  await fs.writeFile(path.join(repoDir, "tracked.txt"), "initial\n", "utf8");
  await git(repoDir, ["add", "tracked.txt"]);
  await git(repoDir, ["commit", "-m", "initial"]);
  const cli = new GitCli(new AttributionHasher("test-salt"));
  const store = new JsonRepositoryObservationStore(storageDir, new DefaultPrivacyGuard());
  const observation = new DefaultRepositoryObservation([repoDir], cli, store, () => undefined, 60_000);
  return { repoDir, storageDir, cli, observation };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await wait(10);
  }
}

class RacingGitCli extends GitCli {
  private onNextRefScan?: () => Promise<void>;

  commitDuringNextRefScan(operation: () => Promise<void>): void {
    this.onNextRefScan = operation;
  }

  override async listRefs(repo: Parameters<GitCli["listRefs"]>[0]): ReturnType<GitCli["listRefs"]> {
    const operation = this.onNextRefScan;
    this.onNextRefScan = undefined;
    await operation?.();
    return await super.listRefs(repo);
  }
}

class InitiallyMissingRefGitCli extends GitCli {
  private missingRefReads = true;

  restoreRefReads(): void {
    this.missingRefReads = false;
  }

  override async currentRefKey(repo: Parameters<GitCli["currentRefKey"]>[0]): ReturnType<GitCli["currentRefKey"]> {
    if (this.missingRefReads) {
      return undefined;
    }
    return await super.currentRefKey(repo);
  }
}

class SlowSnapshotGitCli extends GitCli {
  private nextSnapshotDelayMs = 0;

  delayNextSnapshot(delayMs: number): void {
    this.nextSnapshotDelayMs = delayMs;
  }

  override async snapshot(repo: Parameters<GitCli["snapshot"]>[0]): ReturnType<GitCli["snapshot"]> {
    if (this.nextSnapshotDelayMs > 0) {
      const delayMs = this.nextSnapshotDelayMs;
      this.nextSnapshotDelayMs = 0;
      await wait(delayMs);
    }
    return await super.snapshot(repo);
  }
}

class BlockingSecondHeadGitCli extends GitCli {
  private currentHeadCalls = 0;
  private releaseHead?: () => void;
  blocked = false;

  releaseBlockedHead(): void {
    this.releaseHead?.();
  }

  override async currentHead(repo: Parameters<GitCli["currentHead"]>[0]): ReturnType<GitCli["currentHead"]> {
    this.currentHeadCalls += 1;
    if (this.currentHeadCalls >= 2) {
      this.blocked = true;
      await new Promise<void>((resolve) => {
        this.releaseHead = resolve;
      });
    }
    return await super.currentHead(repo);
  }
}
