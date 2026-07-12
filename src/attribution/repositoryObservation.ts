import { randomUUID } from "node:crypto";
import {
  AttributionEpoch,
  DiagnosticEvent,
  ObservedCommitCandidate,
  RepositoryObservation,
  RepositoryObservationEvent,
  RepositoryObservationStore,
  RepositorySnapshotObservation,
  RepositoryTransitionKind
} from "../types";
import { GitCli, GitRefSnapshot, GitRepository, GitWorktreeSnapshot } from "./gitCli";

export class DefaultRepositoryObservation implements RepositoryObservation {
  private repositories: GitRepository[] = [];
  private epochs = new Map<string, AttributionEpoch>();
  private snapshots = new Map<string, RepositorySnapshotObservation>();
  private snapshotSignatures = new Map<string, string>();
  private handlers = new Set<(event: RepositoryObservationEvent) => void | Promise<void>>();
  private timer?: NodeJS.Timeout;
  private activeObservationUntil = 0;
  private activeObservationPollMs?: number;
  private activeObservationLogged = false;
  private running = false;
  private scanning = false;
  private scanPromise?: Promise<void>;
  private queuedScanRequests = 0;
  private queuedScanSince = 0;

  constructor(
    private readonly workspaceFolders: string[],
    private readonly git: GitCli,
    private readonly store: RepositoryObservationStore,
    private readonly recordEvent: (event: DiagnosticEvent) => void = () => undefined,
    private readonly pollMs = 2_000,
    private readonly onSnapshotObserved?: (
      snapshot: GitWorktreeSnapshot,
      observation: RepositorySnapshotObservation
    ) => void | Promise<void>
  ) {}

  async start(options: { deferInitialScan?: boolean } = {}): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const stored = await this.store.initialize();
    const discovery = await this.git.discoverRepositories(this.workspaceFolders);
    this.repositories = discovery.repositories;
    this.recordEvent({ kind: "repoDiscovery", repoCount: this.repositories.length, skippedCount: discovery.skippedCount });
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "RepositoryObservation",
      operation: "observer",
      state: "started",
      reason: "repository_observer_started",
      details: {
        repoCount: this.repositories.length,
        skippedCount: discovery.skippedCount,
        pollMs: this.pollMs
      }
    });
    if (stored.recoveredFromCorruption) {
      this.recordEvent({
        kind: "attributionDecision",
        status: "skipped",
        reason: "repository_observation_corrupt_new_epoch"
      });
    }

    const storedEpochs = new Map(stored.epochs.filter((epoch) => epoch.status === "active").map((epoch) => [epoch.repoKey, epoch]));
    for (const repo of this.repositories) {
      const currentHead = await this.git.currentHead(repo);
      const currentRefKey = await this.git.currentRefKey(repo);
      const currentRefs = await this.git.listRefs(repo);
      const storedExisting = stored.recoveredFromCorruption ? undefined : storedEpochs.get(repo.repoKey);
      const existing = storedExisting?.refHeads ? storedExisting : undefined;
      const validEmptyRepoEpoch = existing && !existing.initialHead && !existing.cursorHead;
      const epoch = existing?.cursorHead || validEmptyRepoEpoch || !currentHead
        ? existing ?? createEpoch(repo.repoKey, currentHead, currentRefKey, currentRefs)
        : createEpoch(repo.repoKey, currentHead, currentRefKey, currentRefs);
      if (!existing || epoch.epochId !== existing.epochId) {
        await this.store.upsertEpoch(epoch);
        this.recordEvent({
          kind: "attributionDecision",
          status: "skipped",
          reason: storedExisting ? "repository_epoch_reset_missing_cursor" : "repository_epoch_created"
        });
      }
      this.epochs.set(repo.repoKey, epoch);
      await this.observeSnapshot(repo, epoch, true);
    }

    if (options.deferInitialScan) {
      void this.scanOnce()
        .catch(() => {
          this.recordEvent({
            kind: "constructLifecycle",
            construct: "RepositoryObservation",
            operation: "scan",
            state: "failed",
            reason: "repository_initial_scan_failed"
          });
        })
        .finally(() => {
          if (this.running) {
            this.scheduleNext();
          }
        });
      return;
    }
    await this.scanOnce();
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.scanPromise;
  }

  onObservation(handler: (event: RepositoryObservationEvent) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  requestActiveObservationWindow(durationMs: number, pollMs = Math.min(this.pollMs, 250)): void {
    const boundedDurationMs = Math.max(0, durationMs);
    if (boundedDurationMs === 0) {
      return;
    }
    this.activeObservationUntil = Math.max(this.activeObservationUntil, Date.now() + boundedDurationMs);
    this.activeObservationPollMs = this.activeObservationPollMs == null
      ? pollMs
      : Math.min(this.activeObservationPollMs, pollMs);
    this.activeObservationLogged = true;
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "RepositoryObservation",
      operation: "active_window",
      state: "requested",
      reason: "active_observation_window_requested",
      details: {
        durationMs: boundedDurationMs,
        pollMs,
        activeUntilMs: this.activeObservationUntil
      }
    });
    if (!this.running) {
      return;
    }
    this.reschedule(false);
  }

  async refresh(): Promise<void> {
    if (!this.running) {
      return;
    }
    await this.scanOnce();
  }

  currentSnapshots(): RepositorySnapshotObservation[] {
    return [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot));
  }

  listEpochs(): Promise<AttributionEpoch[]> {
    return this.store.listEpochs();
  }

  listCandidates(): Promise<ObservedCommitCandidate[]> {
    return this.store.listCandidates();
  }

  updateCandidate(candidate: ObservedCommitCandidate): Promise<void> {
    return this.store.updateCandidate(candidate);
  }

  applyRetention(): Promise<number> {
    return this.store.applyCandidateRetention(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  }

  async isAncestor(repoKey: string, ancestor: string, descendant: string): Promise<boolean> {
    const repo = this.repositories.find((item) => item.repoKey === repoKey);
    return repo ? this.git.isAncestor(repo, ancestor, descendant) : false;
  }

  async resolveCommitMessage(repoKey: string, commitHash: string): Promise<string | undefined> {
    const repo = this.repositories.find((item) => item.repoKey === repoKey);
    return repo ? this.git.commitMessage(repo, commitHash) : undefined;
  }

  async resolveGitHubRepository(repoKey: string) {
    const repo = this.repositories.find((item) => item.repoKey === repoKey);
    return repo ? this.git.githubRepository(repo) : undefined;
  }

  async reset(): Promise<void> {
    const restart = this.running;
    await this.stop();
    await this.store.clear();
    this.epochs.clear();
    this.snapshots.clear();
    this.snapshotSignatures.clear();
    if (restart) {
      await this.start();
    }
  }

  async scanOnce(): Promise<void> {
    if (this.scanPromise) {
      this.queuedScanRequests += 1;
      this.queuedScanSince ||= Date.now();
      if (this.queuedScanRequests === 1) {
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "RepositoryObservation",
          operation: "scan",
          state: "queued",
          reason: "repository_scan_queued_while_inflight",
          details: {
            queuedRequestCount: this.queuedScanRequests
          }
        });
      }
      await this.scanPromise;
      return;
    }
    const promise = (async () => {
      do {
        const queuedRequestCount = this.queuedScanRequests;
        const queuedDwellMs = this.queuedScanSince === 0 ? 0 : Math.max(0, Date.now() - this.queuedScanSince);
        this.queuedScanRequests = 0;
        this.queuedScanSince = 0;
        if (queuedRequestCount > 0) {
          this.recordEvent({
            kind: "constructLifecycle",
            construct: "RepositoryObservation",
            operation: "scan",
            state: "requeued",
            reason: "repository_scan_draining_queued_requests",
            details: {
              queuedRequestCount,
              queuedDwellMs
            }
          });
        }
        this.scanning = true;
        try {
          for (const repo of this.repositories) {
            await this.scanRepo(repo);
          }
        } finally {
          this.scanning = false;
        }
      }
      while (this.queuedScanRequests > 0);
    })();
    this.scanPromise = promise;
    try {
      await promise;
    } finally {
      if (this.scanPromise === promise) {
        this.scanPromise = undefined;
      }
    }
  }

  private async scanRepo(repo: GitRepository): Promise<void> {
    const epoch = this.epochs.get(repo.repoKey);
    if (!epoch) {
      return;
    }
    const currentHead = await this.git.currentHead(repo);
    const currentRefKey = await this.git.currentRefKey(repo);
    if (!currentHead) {
      await this.scanRefTransitions(repo, epoch, currentRefKey);
      await this.observeSnapshot(repo, epoch);
      return;
    }

    if (!epoch.cursorHead) {
      if (!epoch.initialHead) {
        const candidates = await this.candidatesForCommits(
          repo,
          epoch,
          [currentHead],
          currentRefKey,
          "fast_forward",
          "root_commit_observed_after_epoch"
        );
        const previousRefKey = epoch.cursorRefKey;
        epoch.cursorHead = currentHead;
        epoch.cursorRefKey = currentRefKey;
        if (currentRefKey) {
          epoch.refHeads = { ...(epoch.refHeads ?? {}), [currentRefKey]: currentHead };
        }
        await this.store.persistCandidatesAndAdvance(epoch, candidates);
        await this.emit({
          kind: "transition",
          repoKey: repo.repoKey,
          epochId: epoch.epochId,
          refKey: currentRefKey,
          previousRefKey,
          transitionKind: "fast_forward",
          observedAt: new Date().toISOString()
        });
        for (const candidate of candidates) {
          await this.emit({ kind: "commit_candidate", candidate });
        }
        await this.scanRefTransitions(repo, epoch, currentRefKey);
        await this.observeSnapshot(repo, epoch);
        return;
      }
      const reset = createEpoch(repo.repoKey, currentHead, currentRefKey, await this.git.listRefs(repo));
      this.epochs.set(repo.repoKey, reset);
      await this.store.upsertEpoch(reset);
      await this.observeSnapshot(repo, reset, true);
      return;
    }

    if (epoch.cursorHead !== currentHead || epoch.cursorRefKey !== currentRefKey) {
      const transitionKind = await this.classifyTransition(repo, epoch, currentHead, currentRefKey);
      const previousRefKey = epoch.cursorRefKey;
      const checkedOutRefHead = currentRefKey ? epoch.refHeads?.[currentRefKey] : undefined;
      let candidateTransitionKind = transitionKind === "branch_switch" && checkedOutRefHead && checkedOutRefHead !== currentHead
        ? await this.git.isAncestor(repo, checkedOutRefHead, currentHead)
          ? "fast_forward"
          : "non_fast_forward_ref_update"
        : transitionKind;
      const candidateBaseHead = transitionKind === "branch_switch" ? checkedOutRefHead : epoch.cursorHead;
      let commitHashes = candidateTransitionKind === "fast_forward" && candidateBaseHead
        ? await this.git.commitsBetween(repo, candidateBaseHead, currentHead)
        : candidateTransitionKind === "non_fast_forward_ref_update"
          ? [currentHead]
          : [];
      if (commitHashes.length === 0 && epoch.cursorHead !== currentHead) {
        candidateTransitionKind = await this.git.isAncestor(repo, epoch.cursorHead, currentHead)
          ? "fast_forward"
          : "non_fast_forward_ref_update";
        commitHashes = candidateTransitionKind === "fast_forward"
          ? await this.git.commitsBetween(repo, epoch.cursorHead, currentHead)
          : [currentHead];
      }
      const candidates = await this.candidatesForCommits(
        repo,
        epoch,
        commitHashes,
        currentRefKey,
        candidateTransitionKind,
        "commit_observed_after_epoch"
      );
      epoch.cursorHead = currentHead;
      epoch.cursorRefKey = currentRefKey;
      if (currentRefKey) {
        epoch.refHeads = { ...(epoch.refHeads ?? {}), [currentRefKey]: currentHead };
      }
      await this.store.persistCandidatesAndAdvance(epoch, candidates);
      await this.emit({
        kind: "transition",
        repoKey: repo.repoKey,
        epochId: epoch.epochId,
        refKey: currentRefKey,
        previousRefKey,
        transitionKind,
        observedAt: new Date().toISOString()
      });
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "RepositoryObservation",
        operation: "ref_transition",
        state: transitionKind,
        reason: "checked_out_ref_transition_observed",
        repoKey: repo.repoKey,
        epochId: epoch.epochId,
        commitHash: currentHead,
        details: {
          candidateCount: candidates.length,
          refKey: currentRefKey ?? null,
          previousRefKey: previousRefKey ?? null
        }
      });
      for (const candidate of candidates) {
        await this.emit({ kind: "commit_candidate", candidate });
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "RepositoryObservation",
          operation: "commit_candidate",
          state: "observed",
          reason: "commit_candidate_observed",
          repoKey: candidate.repoKey,
          epochId: candidate.epochId,
          commitHash: candidate.commitHash,
          details: {
            observedSequence: candidate.observedSequence,
            transitionKind: candidate.transitionKind,
            refKey: candidate.refKey ?? null
          }
        });
      }
      await this.scanRefTransitions(
        repo,
        epoch,
        currentRefKey
      );
      await this.observeSnapshot(repo, epoch);
      return;
    }
    await this.scanRefTransitions(repo, epoch, currentRefKey);
    await this.observeSnapshot(repo, epoch);
  }

  private async scanRefTransitions(repo: GitRepository, epoch: AttributionEpoch, skipRefKey?: string): Promise<void> {
    const previous = epoch.refHeads ?? {};
    const current = refHeadMap(await this.git.listRefs(repo));
    const refKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    for (const refKey of refKeys) {
      const previousHead = previous[refKey];
      const currentHead = current[refKey];
      if (previousHead === currentHead) {
        continue;
      }
      if (refKey === skipRefKey) {
        continue;
      }
      if (!currentHead) {
        delete previous[refKey];
        epoch.refHeads = { ...previous };
        await this.store.persistCandidatesAndAdvance(epoch, []);
        await this.emit({
          kind: "transition",
          repoKey: repo.repoKey,
          epochId: epoch.epochId,
          refKey,
          transitionKind: "ref_deleted",
          observedAt: new Date().toISOString()
        });
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "RepositoryObservation",
          operation: "ref_transition",
          state: "ref_deleted",
          reason: "ref_transition_observed",
          repoKey: repo.repoKey,
          epochId: epoch.epochId,
          details: {
            refKey
          }
        });
        continue;
      }
      if (!previousHead) {
        previous[refKey] = currentHead;
        epoch.refHeads = { ...previous };
        await this.store.persistCandidatesAndAdvance(epoch, []);
        await this.emit({
          kind: "transition",
          repoKey: repo.repoKey,
          epochId: epoch.epochId,
          refKey,
          transitionKind: "unknown",
          observedAt: new Date().toISOString()
        });
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "RepositoryObservation",
          operation: "ref_transition",
          state: "unknown",
          reason: "ref_transition_observed",
          repoKey: repo.repoKey,
          epochId: epoch.epochId,
          commitHash: currentHead,
          details: {
            refKey
          }
        });
        continue;
      }

      const transitionKind: RepositoryTransitionKind = await this.git.isAncestor(repo, previousHead, currentHead)
        ? "fast_forward"
        : "non_fast_forward_ref_update";
      const commitHashes = transitionKind === "fast_forward"
        ? await this.git.commitsBetween(repo, previousHead, currentHead)
        : [currentHead];
      const candidates = await this.candidatesForCommits(
        repo,
        epoch,
        commitHashes,
        refKey,
        transitionKind,
        "ref_commit_observed_after_epoch"
      );
      previous[refKey] = currentHead;
      epoch.refHeads = { ...previous };
      await this.store.persistCandidatesAndAdvance(epoch, candidates);
      await this.emit({
        kind: "transition",
        repoKey: repo.repoKey,
        epochId: epoch.epochId,
        refKey,
        transitionKind,
        observedAt: new Date().toISOString()
      });
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "RepositoryObservation",
        operation: "ref_transition",
        state: transitionKind,
        reason: "background_ref_transition_observed",
        repoKey: repo.repoKey,
        epochId: epoch.epochId,
        commitHash: currentHead,
        details: {
          candidateCount: candidates.length,
          refKey
        }
      });
      for (const candidate of candidates) {
        await this.emit({ kind: "commit_candidate", candidate });
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "RepositoryObservation",
          operation: "commit_candidate",
          state: "observed",
          reason: "commit_candidate_observed",
          repoKey: candidate.repoKey,
          epochId: candidate.epochId,
          commitHash: candidate.commitHash,
          details: {
            observedSequence: candidate.observedSequence,
            transitionKind: candidate.transitionKind,
            refKey: candidate.refKey ?? null
          }
        });
      }
    }
    const reconciled = { ...current };
    if (skipRefKey) {
      const checkedOutHead = previous[skipRefKey];
      if (checkedOutHead) {
        reconciled[skipRefKey] = checkedOutHead;
      } else {
        delete reconciled[skipRefKey];
      }
    }
    if (!sameRefHeads(epoch.refHeads ?? {}, reconciled)) {
      epoch.refHeads = reconciled;
      await this.store.upsertEpoch(epoch);
    }
  }

  private async candidatesForCommits(
    repo: GitRepository,
    epoch: AttributionEpoch,
    commitHashes: string[],
    refKey: string | undefined,
    transitionKind: RepositoryTransitionKind,
    reason: string
  ): Promise<ObservedCommitCandidate[]> {
    const candidates: ObservedCommitCandidate[] = [];
    for (const commitHash of commitHashes) {
      const commit = await this.git.commitDiff(repo, commitHash);
      if (!commit) {
        continue;
      }
      const observedSequence = epoch.nextSequence++;
      candidates.push({
        candidateId: `${epoch.epochId}:${refKey ?? "detached"}:${commitHash}`,
        epochId: epoch.epochId,
        repoKey: repo.repoKey,
        commitHash,
        commitMessage: commit.commitMessage,
        parentHashes: commit.parentHashes,
        refKey,
        observedAt: commit.capturedAt,
        committedAt: commit.committedAt,
        observedSequence,
        artifactStates: commit.artifactStates.map((state) => ({ ...state, observedSequence })),
        transitionKind,
        decision: "pending_evidence",
        reasonCodes: [reason]
      });
    }
    return candidates;
  }

  private async observeSnapshot(repo: GitRepository, epoch: AttributionEpoch, force = false): Promise<void> {
    try {
      const snapshot = await this.git.snapshot(repo);
      const signature = snapshotSignature(snapshot);
      if (!force && this.snapshotSignatures.get(repo.repoKey) === signature) {
        return;
      }
      const observedSequence = epoch.nextSequence++;
      const observation: RepositorySnapshotObservation = {
        epochId: epoch.epochId,
        repoKey: repo.repoKey,
        headCommit: snapshot.headCommit,
        refKey: await this.git.currentRefKey(repo),
        observedAt: snapshot.capturedAt,
        observedSequence,
        dirty: snapshot.dirty,
        dirtyKnown: snapshot.dirtyKnown,
        artifactCoverage: snapshot.artifactCoverage,
        artifactStates: snapshot.artifacts.map((artifact) => ({
          artifactKey: artifact.artifactKey,
          previousArtifactKey: artifact.previousArtifactKey,
          worktreeStateKey: artifact.worktreeStateKey,
          indexStateKey: artifact.indexStateKey,
          changeKind: artifact.changeKind,
          observedSequence
        }))
      };
      this.snapshotSignatures.set(repo.repoKey, signature);
      this.snapshots.set(repo.repoKey, observation);
      await this.store.upsertEpoch(epoch);
      await this.onSnapshotObserved?.(snapshot, observation);
      await this.emit({ kind: "snapshot", snapshot: observation });
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "RepositoryObservation",
        operation: "snapshot",
        state: "recorded",
        reason: force ? "repository_snapshot_recorded_forced" : "repository_snapshot_recorded",
        repoKey: repo.repoKey,
        epochId: epoch.epochId,
        commitHash: observation.headCommit,
        details: {
          observedSequence,
          dirty: observation.dirty,
          dirtyKnown: observation.dirtyKnown,
          artifactCoverage: observation.artifactCoverage ?? "complete",
          artifactCount: observation.artifactStates.length,
          refKey: observation.refKey ?? null
        }
      });
    } catch {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "RepositoryObservation",
        operation: "snapshot",
        state: "failed",
        reason: "repository_snapshot_failed",
        severity: "warning",
        repoKey: repo.repoKey,
        epochId: epoch.epochId
      });
      this.recordEvent({ kind: "attributionDecision", status: "skipped", reason: "repository_snapshot_failed" });
    }
  }

  private async classifyTransition(
    repo: GitRepository,
    epoch: AttributionEpoch,
    currentHead: string,
    currentRefKey: string | undefined
  ): Promise<RepositoryTransitionKind> {
    if (epoch.cursorRefKey !== currentRefKey) {
      return epoch.cursorRefKey && currentRefKey ? "branch_switch" : "detached_head_change";
    }
    return await this.git.isAncestor(repo, epoch.cursorHead!, currentHead)
      ? "fast_forward"
      : "non_fast_forward_ref_update";
  }

  private scheduleNext(): void {
    if (!this.running) {
      return;
    }
    const now = Date.now();
    if (this.activeObservationUntil <= now) {
      if (this.activeObservationLogged) {
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "RepositoryObservation",
          operation: "active_window",
          state: "expired",
          reason: "active_observation_window_expired"
        });
      }
      this.activeObservationUntil = 0;
      this.activeObservationPollMs = undefined;
      this.activeObservationLogged = false;
    }
    const delayMs = this.activeObservationUntil > now
      ? Math.max(10, Math.min(this.pollMs, this.activeObservationPollMs ?? this.pollMs))
      : this.pollMs;
    this.timer = setTimeout(() => {
      void this.scanOnce()
        .catch((error) => {
          this.recordEvent({
            kind: "info",
            message: `Repository observation scan failed and will retry: ${error instanceof Error ? error.message : String(error)}`
          });
        })
        .finally(() => this.scheduleNext());
    }, delayMs);
    this.timer.unref?.();
  }

  private reschedule(scanNow = false): void {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!scanNow) {
      this.scheduleNext();
      return;
    }
    void this.scanOnce()
      .catch((error) => {
        this.recordEvent({
          kind: "info",
          message: `Repository observation scan failed and will retry: ${error instanceof Error ? error.message : String(error)}`
        });
      })
      .finally(() => this.scheduleNext());
  }

  private async emit(event: RepositoryObservationEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}

function createEpoch(repoKey: string, head: string | undefined, refKey: string | undefined, refs: GitRefSnapshot[]): AttributionEpoch {
  return {
    epochId: randomUUID(),
    repoKey,
    startedAt: new Date().toISOString(),
    initialHead: head,
    cursorHead: head,
    cursorRefKey: refKey,
    refHeads: refHeadMap(refs),
    nextSequence: 1,
    status: "active"
  };
}

function refHeadMap(refs: GitRefSnapshot[]): Record<string, string> {
  return Object.fromEntries(refs.map((ref) => [ref.refKey, ref.head]));
}

function sameRefHeads(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length
    && aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

function snapshotSignature(snapshot: GitWorktreeSnapshot): string {
  return JSON.stringify({
    headCommit: snapshot.headCommit,
    branch: snapshot.branch,
    dirty: snapshot.dirty,
    dirtyKnown: snapshot.dirtyKnown,
    artifactCoverage: snapshot.artifactCoverage,
    artifacts: snapshot.artifacts.map((artifact) => [
      artifact.artifactKey,
      artifact.previousArtifactKey,
      artifact.worktreeStateKey,
      artifact.indexStateKey,
      artifact.changeKind
    ])
  });
}
