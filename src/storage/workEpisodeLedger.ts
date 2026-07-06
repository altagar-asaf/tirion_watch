import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AgenticWorkEpisode,
  PrivacyGuard,
  WorkEpisodeLedger,
  WorkEpisodeQuery
} from "../types";

export class JsonlWorkEpisodeLedger implements WorkEpisodeLedger {
  private readonly episodesPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private loadPromise?: Promise<number>;
  private episodes = new Map<string, AgenticWorkEpisode>();

  constructor(
    storageDir: string,
    private readonly privacyGuard: PrivacyGuard,
    private readonly now: () => number = Date.now
  ) {
    this.episodesPath = path.join(storageDir, "work-episodes.jsonl");
  }

  get filePath(): string {
    return this.episodesPath;
  }

  async initialize(): Promise<number> {
    return this.ensureLoaded();
  }

  async upsertEpisode(episode: AgenticWorkEpisode): Promise<void> {
    const privacy = this.privacyGuard.validateAttribution(episode);
    if (!privacy.ok) {
      throw new Error(`Work episode privacy violation: ${privacy.violations.join(", ")}`);
    }

    await this.enqueueWrite(async () => {
      await this.ensureLoaded();
      const next = normalizeEpisode(episode);
      const existing = this.episodes.get(next.episodeId);
      if (existing && JSON.stringify(existing) === JSON.stringify(next)) {
        return;
      }
      this.episodes.set(next.episodeId, next);
      await this.writeAll();
    });
  }

  async listEpisodes(query: WorkEpisodeQuery = {}): Promise<AgenticWorkEpisode[]> {
    await this.ensureLoaded();
    const filtered = [...this.episodes.values()]
      .filter((episode) => matchesQuery(episode, query))
      .sort((a, b) => b.lastAgentActivityAt.localeCompare(a.lastAgentActivityAt))
      .map((episode) => structuredClone(episode));
    return typeof query.limit === "number" ? filtered.slice(0, query.limit) : filtered;
  }

  async applyRetention(retentionDays = 180, retainedQueryIds?: Set<string>): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return 0;
    }

    return this.enqueueWrite(async () => {
      await this.ensureLoaded();
      const cutoff = this.now() - retentionDays * 24 * 60 * 60 * 1000;
      const retained = [...this.episodes.values()].filter((episode) =>
        retainedQueryIds
          ? episode.queryIds.some((queryId) => retainedQueryIds.has(queryId))
          : new Date(episode.lastAgentActivityAt).getTime() >= cutoff
      );
      const removed = this.episodes.size - retained.length;
      if (removed > 0) {
        this.episodes = new Map(retained.map((episode) => [episode.episodeId, episode]));
        await this.writeAll();
      }
      return removed;
    });
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureLoaded();
      this.episodes.clear();
      await this.writeAll();
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private ensureLoaded(): Promise<number> {
    this.loadPromise ??= this.loadAndCompact();
    return this.loadPromise;
  }

  private async loadAndCompact(): Promise<number> {
    const stored = await this.readStoredEpisodes();
    const compacted = compactEpisodes(stored);
    this.episodes = new Map(compacted.episodes.map((episode) => [episode.episodeId, episode]));
    if (compacted.removed > 0) {
      await this.writeAll();
    }
    return compacted.removed;
  }

  private async readStoredEpisodes(): Promise<AgenticWorkEpisode[]> {
    let content = "";
    try {
      content = await fs.readFile(this.episodesPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    return content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return isEpisode(parsed) ? [normalizeEpisode(parsed)] : [];
        } catch {
          return [];
        }
      });
  }

  private async writeAll(): Promise<void> {
    await writeEpisodes(this.episodesPath, [...this.episodes.values()], this.privacyGuard);
  }
}

function normalizeEpisode(episode: AgenticWorkEpisode): AgenticWorkEpisode {
  return {
    ...episode,
    repoKeys: uniqueStrings(episode.repoKeys ?? (episode.repoKey ? [episode.repoKey] : [])),
    epochIds: uniqueStrings(episode.epochIds ?? []),
    queryIds: uniqueStrings(episode.queryIds),
    runIds: uniqueStrings(episode.runIds),
    evidence: episode.evidence.map((evidence) => ({
      ...evidence,
      runIds: uniqueStrings(evidence.runIds),
      baselineReasons: uniqueStrings(evidence.baselineReasons),
      artifactKeys: uniqueStrings(evidence.artifactKeys)
    })),
    confidenceReasons: episode.confidenceReasons ? uniqueStrings(episode.confidenceReasons) : undefined
  };
}

function matchesQuery(episode: AgenticWorkEpisode, query: WorkEpisodeQuery): boolean {
  if (query.episodeId && episode.episodeId !== query.episodeId) {
    return false;
  }
  if (query.repoKey && episode.repoKey !== query.repoKey && !(episode.repoKeys ?? []).includes(query.repoKey)) {
    return false;
  }
  if (query.commitHash && episode.claimedByCommitHash !== query.commitHash) {
    return false;
  }
  if (query.status && episode.status !== query.status) {
    return false;
  }
  if (query.range) {
    return episode.lastAgentActivityAt >= query.range.from && episode.lastAgentActivityAt <= query.range.to;
  }
  return true;
}

async function writeEpisodes(fileName: string, episodes: AgenticWorkEpisode[], privacyGuard: PrivacyGuard): Promise<void> {
  for (const episode of episodes) {
    const privacy = privacyGuard.validateAttribution(episode);
    if (!privacy.ok) {
      throw new Error(`Work episode privacy violation: ${privacy.violations.join(", ")}`);
    }
  }
  await fs.mkdir(path.dirname(fileName), { recursive: true });
  const tempPath = `${fileName}.tmp`;
  await fs.writeFile(tempPath, episodes.map((episode) => JSON.stringify(episode)).join("\n") + (episodes.length > 0 ? "\n" : ""), "utf8");
  await fs.rename(tempPath, fileName);
}

function isEpisode(value: unknown): value is AgenticWorkEpisode {
  return isRecord(value)
    && typeof value.episodeId === "string"
    && (value.repoKey == null || typeof value.repoKey === "string")
    && Array.isArray(value.queryIds)
    && Array.isArray(value.runIds)
    && typeof value.startedAt === "string"
    && typeof value.lastAgentActivityAt === "string"
    && typeof value.status === "string"
    && Array.isArray(value.evidence)
    && (value.confidence == null || typeof value.confidence === "string")
    && (value.confidenceReasons == null || Array.isArray(value.confidenceReasons));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}

function compactEpisodes(stored: AgenticWorkEpisode[]): { episodes: AgenticWorkEpisode[]; removed: number } {
  const groups = new Map<string, AgenticWorkEpisode[]>();
  for (const episode of stored.map(normalizeEpisode).sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const key = episodeGroupKey(episode);
    const clusters = groups.get(key) ?? [];
    const match = clusters.find((candidate) => shouldMergeEpisodes(candidate, episode));
    if (match) {
      const merged = mergeEpisodes(match, episode);
      clusters[clusters.indexOf(match)] = merged;
    } else {
      clusters.push(episode);
    }
    groups.set(key, clusters);
  }
  const episodes = [...groups.values()].flat();
  return { episodes, removed: stored.length - episodes.length };
}

function episodeGroupKey(episode: AgenticWorkEpisode): string {
  return [
    (episode.repoKeys ?? (episode.repoKey ? [episode.repoKey] : [])).join(",") || "repo-unbound",
    episode.chatSessionId ?? episode.queryIds.join(","),
    episode.headCommitAtStart ?? "head-unavailable"
  ].join(":");
}

function shouldMergeEpisodes(a: AgenticWorkEpisode, b: AgenticWorkEpisode): boolean {
  if (a.claimedByCommitHash && a.claimedByCommitHash === b.claimedByCommitHash) {
    return true;
  }
  if (intersects(a.queryIds, b.queryIds) || intersects(a.runIds, b.runIds)) {
    return true;
  }
  if (a.claimedByCommitHash || b.claimedByCommitHash || a.status === "claimed" || b.status === "claimed") {
    return false;
  }
  const gap = new Date(b.startedAt).getTime() - new Date(a.lastAgentActivityAt).getTime();
  return gap <= 4 * 60 * 60 * 1000;
}

function mergeEpisodes(a: AgenticWorkEpisode, b: AgenticWorkEpisode): AgenticWorkEpisode {
  const preferredId = a.claimedByCommitHash ? a.episodeId : b.claimedByCommitHash ? b.episodeId : a.episodeId;
  const claimedByCommitHash = a.claimedByCommitHash ?? b.claimedByCommitHash;
  return normalizeEpisode({
    ...a,
    episodeId: preferredId,
    repoKey: uniqueStrings([...(a.repoKeys ?? []), ...(b.repoKeys ?? [])]).length === 1
      ? uniqueStrings([...(a.repoKeys ?? []), ...(b.repoKeys ?? [])])[0]
      : undefined,
    repoKeys: uniqueStrings([...(a.repoKeys ?? []), ...(b.repoKeys ?? [])]),
    epochIds: uniqueStrings([...(a.epochIds ?? []), ...(b.epochIds ?? [])]),
    queryIds: uniqueStrings([...a.queryIds, ...b.queryIds]),
    runIds: uniqueStrings([...a.runIds, ...b.runIds]),
    startedAt: [a.startedAt, b.startedAt].sort()[0],
    lastAgentActivityAt: [a.lastAgentActivityAt, b.lastAgentActivityAt].sort().at(-1)!,
    lastObservedChangeAt: [a.lastObservedChangeAt, b.lastObservedChangeAt].filter(isDefined).sort().at(-1),
    status: claimedByCommitHash ? "claimed" : episodeStatusPriority(a.status) >= episodeStatusPriority(b.status) ? a.status : b.status,
    claimedByCommitHash,
    claimedAt: maxIsoOptional(a.claimedAt, b.claimedAt),
    evidence: mergeEvidence(a.evidence, b.evidence),
    decision: a.decision ?? b.decision,
    confidence: confidencePriority(a.confidence) >= confidencePriority(b.confidence) ? a.confidence : b.confidence,
    confidenceReasons: uniqueStrings([...(a.confidenceReasons ?? []), ...(b.confidenceReasons ?? [])])
  });
}

function mergeEvidence(a: AgenticWorkEpisode["evidence"], b: AgenticWorkEpisode["evidence"]): AgenticWorkEpisode["evidence"] {
  const byQueryRepo = new Map(a.map((item) => [evidenceKey(item), item]));
  for (const item of b) {
    const key = evidenceKey(item);
    const current = byQueryRepo.get(key);
    byQueryRepo.set(key, current ? {
      ...current,
      runIds: uniqueStrings([...current.runIds, ...item.runIds]),
      completedAt: [current.completedAt, item.completedAt].filter(isDefined).sort().at(-1),
      baselineTrusted: current.baselineTrusted && item.baselineTrusted,
      baselineReasons: uniqueStrings([...current.baselineReasons, ...item.baselineReasons]),
      dirtyAtStart: current.dirtyAtStart || item.dirtyAtStart,
      observedChangeCount: new Set([...current.artifactKeys, ...item.artifactKeys]).size,
      artifactKeys: uniqueStrings([...current.artifactKeys, ...item.artifactKeys]),
      artifactStates: mergeArtifactStates(current.artifactStates ?? [], item.artifactStates ?? []),
      addedLines: Math.max(current.addedLines, item.addedLines),
      deletedLines: Math.max(current.deletedLines, item.deletedLines),
      firstObservedAt: [current.firstObservedAt, item.firstObservedAt].filter(isDefined).sort()[0],
      lastObservedAt: [current.lastObservedAt, item.lastObservedAt].filter(isDefined).sort().at(-1)
    } : item);
  }
  return [...byQueryRepo.values()];
}

function evidenceKey(evidence: AgenticWorkEpisode["evidence"][number]): string {
  return `${evidence.queryId}:${evidence.repoKey}:${evidence.epochId ?? "legacy"}`;
}

function mergeArtifactStates(
  a: NonNullable<AgenticWorkEpisode["evidence"][number]["artifactStates"]>,
  b: NonNullable<AgenticWorkEpisode["evidence"][number]["artifactStates"]>
) {
  const states = new Map(a.map((state) => [state.artifactKey, state]));
  for (const state of b) {
    states.set(state.artifactKey, state);
  }
  return [...states.values()];
}

function episodeStatusPriority(status: AgenticWorkEpisode["status"]): number {
  return status === "claimed" ? 4 : status === "manual_review" ? 3 : status === "open" ? 2 : 1;
}

function confidencePriority(confidence: AgenticWorkEpisode["confidence"]): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function maxIsoOptional(a: string | undefined, b: string | undefined): string | undefined {
  return [a, b].filter(isDefined).sort().at(-1);
}

function intersects(a: string[], b: string[]): boolean {
  const values = new Set(a);
  return b.some((value) => values.has(value));
}

function isDefined<T>(value: T | undefined): value is T {
  return value != null;
}
