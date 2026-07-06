import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PrivacyGuard, QueryWorkEvidence, WorkspaceEvidenceLedger } from "../types";

export class JsonlWorkspaceEvidenceLedger implements WorkspaceEvidenceLedger {
  private readonly evidencePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private loadPromise?: Promise<void>;
  private evidence = new Map<string, QueryWorkEvidence>();

  constructor(
    storageDir: string,
    private readonly privacyGuard: PrivacyGuard
  ) {
    this.evidencePath = path.join(storageDir, "workspace-evidence.jsonl");
  }

  async upsertEvidence(evidence: QueryWorkEvidence): Promise<void> {
    const privacy = this.privacyGuard.validateAttribution(evidence);
    if (!privacy.ok) {
      throw new Error(`Workspace evidence privacy violation: ${privacy.violations.join(", ")}`);
    }
    await this.enqueueWrite(async () => {
      await this.ensureLoaded();
      this.evidence.set(evidenceKey(evidence.queryId, evidence.repoKey), normalizeEvidence(evidence));
      await this.writeAll();
    });
  }

  async listEvidence(query: { queryId?: string; repoKey?: string; status?: QueryWorkEvidence["status"] } = {}): Promise<QueryWorkEvidence[]> {
    await this.ensureLoaded();
    return [...this.evidence.values()]
      .filter((item) => !query.queryId || item.queryId === query.queryId)
      .filter((item) => !query.repoKey || item.repoKey === query.repoKey)
      .filter((item) => !query.status || item.status === query.status)
      .map((item) => structuredClone(item));
  }

  async removeEvidence(queryId: string, repoKey: string): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureLoaded();
      if (this.evidence.delete(evidenceKey(queryId, repoKey))) {
        await this.writeAll();
      }
    });
  }

  async applyRetention(retainedQueryIds: Set<string>): Promise<number> {
    return this.enqueueWrite(async () => {
      await this.ensureLoaded();
      const retained = [...this.evidence.values()].filter((item) => retainedQueryIds.has(item.queryId));
      const removed = this.evidence.size - retained.length;
      if (removed > 0) {
        this.evidence = new Map(retained.map((item) => [evidenceKey(item.queryId, item.repoKey), item]));
        await this.writeAll();
      }
      return removed;
    });
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureLoaded();
      this.evidence.clear();
      await this.writeAll();
    });
  }

  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    let content = "";
    try {
      content = await fs.readFile(this.evidencePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    for (const line of content.split(/\r?\n/).filter((item) => item.trim() !== "")) {
      try {
        const parsed = JSON.parse(line);
        if (isEvidence(parsed)) {
          const normalized = normalizeEvidence(parsed);
          this.evidence.set(evidenceKey(normalized.queryId, normalized.repoKey), normalized);
        }
      } catch {
        // Ignore malformed legacy lines and preserve the remaining evidence.
      }
    }
  }

  private async writeAll(): Promise<void> {
    const records = [...this.evidence.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const evidence of records) {
      const privacy = this.privacyGuard.validateAttribution(evidence);
      if (!privacy.ok) {
        throw new Error(`Workspace evidence privacy violation: ${privacy.violations.join(", ")}`);
      }
    }
    await fs.mkdir(path.dirname(this.evidencePath), { recursive: true });
    const tempPath = `${this.evidencePath}.tmp`;
    await fs.writeFile(tempPath, records.map((item) => JSON.stringify(item)).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");
    await fs.rename(tempPath, this.evidencePath);
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeEvidence(evidence: QueryWorkEvidence): QueryWorkEvidence {
  return {
    ...evidence,
    runIds: uniqueStrings(evidence.runIds),
    baselineReasons: uniqueStrings(evidence.baselineReasons),
    artifactKeys: uniqueStrings(evidence.artifactKeys),
    baselineArtifactStates: evidence.baselineArtifactStates?.map((item) => ({ ...item })),
    artifactStates: evidence.artifactStates?.map((item) => ({ ...item }))
  };
}

function isEvidence(value: unknown): value is QueryWorkEvidence {
  return isRecord(value)
    && typeof value.queryId === "string"
    && Array.isArray(value.runIds)
    && typeof value.repoKey === "string"
    && typeof value.startedAt === "string"
    && typeof value.baselineTrusted === "boolean"
    && Array.isArray(value.baselineReasons)
    && typeof value.dirtyAtStart === "boolean"
    && typeof value.observedChangeCount === "number"
    && Array.isArray(value.artifactKeys);
}

function evidenceKey(queryId: string, repoKey: string): string {
  return `${queryId}:${repoKey}`;
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
