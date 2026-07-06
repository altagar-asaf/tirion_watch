import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AgentStorageClient } from "@tirion/agent-storage";
import type { SupportedProvider } from "@tirion/agent-contract";
import {
  AttributionHasher,
  DefaultRepositoryObservation,
  GitCli,
  type GitRepository,
  type GitWorktreeSnapshot,
  type DiagnosticEvent,
  type RepositoryObservation
} from "@tirion/engine/production";
import { writePrivateFileAtomic } from "@tirion/platform";
import { RepositoryScopeManagement } from "./repositoryScopeManagement";
import { SqliteRepositoryObservationStore, SqliteRepositorySnapshotStore } from "./repositoryObservationStore";

export class AgentRepositoryObservationService {
  private observation?: RepositoryObservation;
  private snapshotUnsubscribe?: () => void;
  private readonly snapshots: SqliteRepositorySnapshotStore;
  private hasher?: AttributionHasher;
  private gitCli?: GitCli;
  private readonly artifactPathsByRepo = new Map<string, Map<string, string>>();

  constructor(
    private readonly storage: AgentStorageClient,
    private readonly scopes: RepositoryScopeManagement,
    private readonly hmacKeyPath: string,
    private readonly pollMs = 2_000,
    private readonly recordEvent: (event: DiagnosticEvent) => void = () => undefined
  ) {
    this.snapshots = new SqliteRepositorySnapshotStore(storage);
  }

  async start(): Promise<void> {
    if (this.observation) {
      return;
    }
    const locators = await this.scopes.activeLocators();
    const git = this.git();
    const observation = new DefaultRepositoryObservation(
      locators.map((locator) => locator.path),
      git,
      new SqliteRepositoryObservationStore(this.storage),
      this.recordEvent,
      this.pollMs,
      async (snapshot, observation) => {
        this.rememberArtifactPaths(observation.repoKey, snapshot);
      }
    );
    this.observation = observation;
    this.snapshotUnsubscribe = observation.onObservation(async (event) => {
      if (event.kind === "snapshot") {
        await this.snapshots.append(event.snapshot);
      }
    });
    await observation.start({ deferInitialScan: true });
  }

  async stop(): Promise<void> {
    const observation = this.observation;
    this.observation = undefined;
    await observation?.stop();
    this.snapshotUnsubscribe?.();
    this.snapshotUnsubscribe = undefined;
    this.artifactPathsByRepo.clear();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async refresh(): Promise<void> {
    await this.observation?.refresh();
  }

  requestActiveObservationWindow(durationMs: number, pollMs?: number): void {
    this.observation?.requestActiveObservationWindow(durationMs, pollMs);
  }

  running(): boolean {
    return Boolean(this.observation);
  }

  requireObservation(): RepositoryObservation {
    if (!this.observation) {
      throw new Error("unsupported_capability");
    }
    return this.observation;
  }

  async listSnapshots(_provider?: SupportedProvider) {
    const snapshots = await this.snapshots.list();
    return snapshots;
  }

  async listRepositories(_provider?: SupportedProvider): Promise<GitRepository[]> {
    const locators = await this.scopes.activeLocators();
    return (await this.git().discoverRepositories(locators.map((locator) => locator.path))).repositories;
  }

  async resolveGitHubRepository(repoKey: string) {
    const repository = (await this.listRepositories()).find((candidate) => candidate.repoKey === repoKey);
    return repository ? this.git().githubRepository(repository) : undefined;
  }

  artifactKey(repoKey: string, artifactIdentifier: string): string {
    return this.hasherForAttribution().artifactKey(repoKey, artifactIdentifier);
  }

  blobStateKey(rawBlobOid: string): string {
    return this.hasherForAttribution().blobKey(rawBlobOid);
  }

  relativePaths(repoKey: string, artifactKeys: string[]): string[] {
    const known = this.artifactPathsByRepo.get(repoKey);
    if (!known) {
      return [];
    }
    return [...new Set(artifactKeys
      .map((artifactKey) => known.get(artifactKey))
      .filter((value): value is string => typeof value === "string" && value.trim() !== ""))]
      .sort();
  }

  async applyRetention(retainAfter: string): Promise<number> {
    const [candidates, snapshots] = await Promise.all([
      this.observation?.applyRetention() ?? Promise.resolve(0),
      this.snapshots.applyRetention(retainAfter)
    ]);
    return candidates + snapshots;
  }

  private hasherForAttribution(): AttributionHasher {
    this.hasher ??= new AttributionHasher(readOrCreateSecret(this.hmacKeyPath));
    return this.hasher;
  }

  private git(): GitCli {
    this.gitCli ??= new GitCli(this.hasherForAttribution());
    return this.gitCli;
  }

  private rememberArtifactPaths(repoKey: string, snapshot: GitWorktreeSnapshot): void {
    const known = this.artifactPathsByRepo.get(repoKey) ?? new Map<string, string>();
    for (const artifact of snapshot.artifacts) {
      if (artifact.identifier.trim() !== "") {
        known.set(artifact.artifactKey, artifact.identifier.replace(/\\/g, "/"));
      }
      if (artifact.previousArtifactKey && artifact.previousIdentifier?.trim()) {
        known.set(artifact.previousArtifactKey, artifact.previousIdentifier.replace(/\\/g, "/"));
      }
    }
    this.artifactPathsByRepo.set(repoKey, known);
  }
}

function readOrCreateSecret(path: string): string {
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (value.length < 32) {
      throw new Error("storage_unavailable");
    }
    return value;
  }
  const value = randomBytes(32).toString("base64url");
  writePrivateFileAtomic(path, `${value}\n`);
  return value;
}
