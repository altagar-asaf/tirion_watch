import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AttributionEpoch,
  ObservedCommitCandidate,
  PrivacyGuard,
  RepositoryObservationStore
} from "../types";

type StoredRepositoryObservation = {
  schemaVersion: 2;
  epochs: AttributionEpoch[];
  candidates: ObservedCommitCandidate[];
};

export class JsonRepositoryObservationStore implements RepositoryObservationStore {
  private readonly storagePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private loadPromise?: Promise<void>;
  private epochs = new Map<string, AttributionEpoch>();
  private candidates = new Map<string, ObservedCommitCandidate>();
  private recoveredFromCorruption = false;

  constructor(
    storageDir: string,
    private readonly privacyGuard: PrivacyGuard
  ) {
    this.storagePath = path.join(storageDir, "repository-observation.json");
  }

  async initialize(): Promise<{ epochs: AttributionEpoch[]; candidates: ObservedCommitCandidate[]; recoveredFromCorruption: boolean }> {
    await this.ensureLoaded();
    return {
      epochs: await this.listEpochs(),
      candidates: await this.listCandidates(),
      recoveredFromCorruption: this.recoveredFromCorruption
    };
  }

  async upsertEpoch(epoch: AttributionEpoch): Promise<void> {
    await this.validate(epoch);
    await this.enqueueWrite(async () => {
      await this.ensureLoaded();
      this.epochs.set(epoch.repoKey, normalizeEpoch(epoch));
      await this.writeAll();
    });
  }

  async persistCandidatesAndAdvance(epoch: AttributionEpoch, candidates: ObservedCommitCandidate[]): Promise<void> {
    await this.validate(epoch);
    for (const candidate of candidates) {
      await this.validate(candidate);
    }
    await this.enqueueWrite(async () => {
      await this.ensureLoaded();
      for (const candidate of candidates) {
        this.candidates.set(candidate.candidateId, normalizeCandidate(candidate));
      }
      this.epochs.set(epoch.repoKey, normalizeEpoch(epoch));
      await this.writeAll();
    });
  }

  async updateCandidate(candidate: ObservedCommitCandidate): Promise<void> {
    await this.validate(candidate);
    await this.enqueueWrite(async () => {
      await this.ensureLoaded();
      this.candidates.set(candidate.candidateId, normalizeCandidate(candidate));
      await this.writeAll();
    });
  }

  async listEpochs(): Promise<AttributionEpoch[]> {
    await this.ensureLoaded();
    return [...this.epochs.values()].map((epoch) => structuredClone(epoch));
  }

  async listCandidates(): Promise<ObservedCommitCandidate[]> {
    await this.ensureLoaded();
    return [...this.candidates.values()]
      .sort((a, b) => a.observedSequence - b.observedSequence)
      .map((candidate) => structuredClone(candidate));
  }

  async applyCandidateRetention(retainAfter: string): Promise<number> {
    return this.enqueueWrite(async () => {
      await this.ensureLoaded();
      const retained = [...this.candidates.values()].filter((candidate) =>
        candidate.decision === "pending_evidence"
        || candidate.decision === "rewrite_pending"
        || candidate.observedAt >= retainAfter
      );
      const removed = this.candidates.size - retained.length;
      if (removed > 0) {
        this.candidates = new Map(retained.map((candidate) => [candidate.candidateId, candidate]));
        await this.writeAll();
      }
      return removed;
    });
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureLoaded();
      this.epochs.clear();
      this.candidates.clear();
      this.recoveredFromCorruption = false;
      await this.writeAll();
    });
  }

  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.storagePath, "utf8"));
      if (!isStoredRepositoryObservation(parsed)) {
        this.recoveredFromCorruption = true;
        return;
      }
      this.epochs = new Map(parsed.epochs.map((epoch) => [epoch.repoKey, normalizeEpoch(epoch)]));
      this.candidates = new Map(parsed.candidates.map((candidate) => [candidate.candidateId, normalizeCandidate(candidate)]));
    } catch (error) {
      if (!isNotFound(error)) {
        this.recoveredFromCorruption = true;
      }
    }
  }

  private async writeAll(): Promise<void> {
    const value: StoredRepositoryObservation = {
      schemaVersion: 2,
      epochs: [...this.epochs.values()].sort((a, b) => a.repoKey.localeCompare(b.repoKey)),
      candidates: [...this.candidates.values()].sort((a, b) => a.observedSequence - b.observedSequence)
    };
    if (!isStoredRepositoryObservation(value)) {
      throw new Error("Repository observation state is incomplete; refusing to advance the durable cursor.");
    }
    await this.validate(value);
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    const tempPath = `${this.storagePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value)}\n`, "utf8");
    await fs.rename(tempPath, this.storagePath);
  }

  private async validate(record: unknown): Promise<void> {
    const privacy = this.privacyGuard.validateAttribution(record);
    if (!privacy.ok) {
      throw new Error(`Repository observation privacy violation: ${privacy.violations.join(", ")}`);
    }
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeEpoch(epoch: AttributionEpoch): AttributionEpoch {
  return {
    ...epoch,
    refHeads: epoch.refHeads ? Object.fromEntries(Object.entries(epoch.refHeads).sort(([a], [b]) => a.localeCompare(b))) : undefined,
    nextSequence: Math.max(1, Math.floor(epoch.nextSequence))
  };
}

function normalizeCandidate(candidate: ObservedCommitCandidate): ObservedCommitCandidate {
  return {
    ...candidate,
    commitMessage: typeof candidate.commitMessage === "string" && candidate.commitMessage.trim() !== "" ? candidate.commitMessage.trim() : undefined,
    parentHashes: uniqueStrings(candidate.parentHashes),
    artifactStates: candidate.artifactStates.map((state) => ({ ...state })),
    reasonCodes: uniqueStrings(candidate.reasonCodes)
  };
}

function isStoredRepositoryObservation(value: unknown): value is StoredRepositoryObservation {
  return isRecord(value)
    && value.schemaVersion === 2
    && Array.isArray(value.epochs)
    && value.epochs.every(isEpoch)
    && Array.isArray(value.candidates)
    && value.candidates.every(isCandidate);
}

function isEpoch(value: unknown): value is AttributionEpoch {
  return isRecord(value)
    && typeof value.epochId === "string"
    && typeof value.repoKey === "string"
    && typeof value.startedAt === "string"
    && isRecord(value.refHeads)
    && Object.values(value.refHeads).every((head) => typeof head === "string")
    && typeof value.nextSequence === "number"
    && (value.status === "active" || value.status === "superseded");
}

function isCandidate(value: unknown): value is ObservedCommitCandidate {
  return isRecord(value)
    && typeof value.candidateId === "string"
    && typeof value.epochId === "string"
    && typeof value.repoKey === "string"
    && typeof value.commitHash === "string"
    && (value.commitMessage == null || typeof value.commitMessage === "string")
    && Array.isArray(value.parentHashes)
    && typeof value.observedAt === "string"
    && typeof value.observedSequence === "number"
    && Array.isArray(value.artifactStates)
    && typeof value.decision === "string"
    && Array.isArray(value.reasonCodes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}
