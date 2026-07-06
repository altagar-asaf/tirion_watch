import type { AgentStorageClient } from "@tirion/agent-storage";
import {
  DefaultPrivacyGuard,
  type AttributionEpoch,
  type ObservedCommitCandidate,
  type PrivacyGuard,
  type RepositoryObservationStore
} from "@tirion/engine/production";

export class SqliteRepositoryObservationStore implements RepositoryObservationStore {
  private readonly privacy: PrivacyGuard = new DefaultPrivacyGuard();

  constructor(private readonly storage: AgentStorageClient) {}

  async initialize(): Promise<{
    epochs: AttributionEpoch[];
    candidates: ObservedCommitCandidate[];
    recoveredFromCorruption: boolean;
  }> {
    return {
      epochs: await this.listEpochs(),
      candidates: await this.listCandidates(),
      recoveredFromCorruption: false
    };
  }

  async upsertEpoch(epoch: AttributionEpoch): Promise<void> {
    this.validate(epoch);
    await this.storage.upsertRepositoryEpoch(epoch);
  }

  async persistCandidatesAndAdvance(epoch: AttributionEpoch, candidates: ObservedCommitCandidate[]): Promise<void> {
    this.validate(epoch);
    candidates.forEach((candidate) => this.validate(candidate));
    await this.storage.persistRepositoryCandidatesAndAdvance(epoch, candidates);
  }

  async updateCandidate(candidate: ObservedCommitCandidate): Promise<void> {
    this.validate(candidate);
    await this.storage.updateRepositoryCandidate(candidate);
  }

  listEpochs(): Promise<AttributionEpoch[]> {
    return this.storage.listRepositoryEpochs<AttributionEpoch>();
  }

  listCandidates(): Promise<ObservedCommitCandidate[]> {
    return this.storage.listRepositoryCandidates<ObservedCommitCandidate>();
  }

  applyCandidateRetention(retainAfter: string): Promise<number> {
    return this.storage.applyRepositoryCandidateRetention(retainAfter);
  }

  clear(): Promise<void> {
    return Promise.all([
      this.storage.clearRepositoryObservation(),
      this.storage.clearAgentDocuments("repository_snapshot")
    ]).then(() => undefined);
  }

  private validate(value: unknown): void {
    const result = this.privacy.validateAttribution(value);
    if (!result.ok) {
      throw new Error("privacy_violation");
    }
  }
}

export class SqliteRepositorySnapshotStore {
  private readonly privacy: PrivacyGuard = new DefaultPrivacyGuard();

  constructor(private readonly storage: AgentStorageClient) {}

  async append(snapshot: import("@tirion/engine/production").RepositorySnapshotObservation): Promise<void> {
    this.validate(snapshot);
    await this.storage.upsertAgentDocument("repository_snapshot", {
      key: `${snapshot.repoKey}:${String(snapshot.observedSequence).padStart(16, "0")}`,
      sortAt: snapshot.observedAt,
      value: snapshot
    });
  }

  async list(): Promise<import("@tirion/engine/production").RepositorySnapshotObservation[]> {
    return (await this.storage.listAgentDocuments<import("@tirion/engine/production").RepositorySnapshotObservation>("repository_snapshot"))
      .map((document) => document.value)
      .sort((a, b) => a.observedSequence - b.observedSequence);
  }

  async applyRetention(retainAfter: string): Promise<number> {
    const documents = await this.storage.listAgentDocuments<import("@tirion/engine/production").RepositorySnapshotObservation>("repository_snapshot");
    const retained = documents.filter((document) => document.value.observedAt >= retainAfter);
    const latestBaselines = new Map<string, (typeof documents)[number]>();
    for (const document of documents.filter((candidate) => candidate.value.observedAt < retainAfter)) {
      const key = `${document.value.repoKey}:${document.value.epochId}`;
      const existing = latestBaselines.get(key);
      if (!existing || existing.value.observedSequence < document.value.observedSequence) {
        latestBaselines.set(key, document);
      }
    }
    const next = [...latestBaselines.values(), ...retained];
    const removed = documents.length - next.length;
    if (removed > 0) {
      await this.storage.replaceAgentDocuments("repository_snapshot", next);
    }
    return removed;
  }

  async clear(): Promise<void> {
    await this.storage.clearAgentDocuments("repository_snapshot");
  }

  private validate(value: unknown): void {
    const result = this.privacy.validateAttribution(value);
    if (!result.ok) {
      throw new Error("privacy_violation");
    }
  }
}
