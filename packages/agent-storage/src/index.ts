import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  ClientCapability,
  ClientKind,
  ClientSummaryV1,
  OwnershipState,
  ProductionRunV1,
  ProductionUsageEpochV1,
  QueryOccurrenceV1,
  RepositoryScopeV1,
  SafeActivityAtomV1,
  SafeObservationV1,
  SafeUsageAtomV1,
  ShadowRunV1,
  SourceCapabilityV1
} from "@tirion/agent-contract";

export type EncryptedRepositoryScope = {
  scope: RepositoryScopeV1;
  locatorCiphertext: string;
  locatorIv: string;
  locatorTag: string;
};

export type AgentDocumentCollection =
  | "construct_state"
  | "repository_snapshot"
  | "workspace_evidence"
  | "work_episode"
  | "query_attribution"
  | "completed_run_tracking"
  | "completed_run_tracking_state"
  | "execution_node_atom"
  | "execution_tree_snapshot"
  | "webhook_outbox"
  | "webhook_delivery_state"
  | "budget_config"
  | "budget_warning"
  | "diagnostic_event"
  | "journal_state"
  | "prompt_capture_config"
  | "provider_source_config";

export type AgentDocument = {
  key: string;
  sortAt: string;
  value: unknown;
};

export type WorkspaceEvidenceDocumentQuery = {
  queryId?: string;
  repoKey?: string;
  status?: string;
};

export type WorkEpisodeDocumentQuery = {
  episodeId?: string;
  repoKey?: string;
  commitHash?: string;
  status?: string;
  queryId?: string;
  runId?: string;
  chatSessionId?: string;
  range?: { from: string; to: string };
  limit?: number;
};

export type AttributionDocumentSummary = {
  workspaceEvidence: {
    totalCount: number;
    statusCounts: Record<string, number>;
  };
  workEpisodes: {
    totalCount: number;
    statusCounts: Record<string, number>;
    unboundCount: number;
  };
};

export type AttributionDocumentSanitizationResult = {
  workspaceEvidenceSanitized: number;
  workEpisodesSanitized: number;
};

export type WebhookOutboxStatusSnapshot<T = unknown> = {
  pendingCount: number;
  retryCount: number;
  blockedCount: number;
  deliveredCount: number;
  oldestQueuedAt?: string;
  lastDeliveredAt?: string;
  lastErrorCode?: string;
  activeEntries: Array<Omit<AgentDocument, "value"> & { value: T }>;
};

export type WebhookLifecycleDocumentIdentity = {
  runId?: string;
  traceId?: string;
  sessionId?: string;
};

export type SafeObservationRetentionResult = {
  removedByAge: number;
  removedByOverflow: number;
  retainedCount: number;
};

export type ExecutionNodeRetentionResult = {
  removedByAge: number;
  removedByOverflow: number;
  retainedCount: number;
};

export type StorageCompactionResult = {
  compacted: boolean;
  pageCountBefore: number;
  freePageCountBefore: number;
  pageCountAfter: number;
  freePageCountAfter: number;
};

export type AgentMetadata = {
  installationId: string;
  environmentId: string;
  schemaVersion: number;
  ownershipState: OwnershipState;
  protocolVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentStorageOptions = {
  databasePath: string;
  workerPath?: string;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class AgentStorageClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  constructor(options: AgentStorageOptions) {
    this.worker = new Worker(options.workerPath ?? defaultWorkerPath());
    this.worker.on("message", (message: WorkerResponse) => this.handleMessage(message));
    this.worker.on("error", (error) => {
      for (const request of this.pending.values()) {
        request.reject(error);
      }
      this.pending.clear();
    });
    this.post("open", { databasePath: options.databasePath }).catch(() => undefined);
  }

  async initialize(input: {
    now: string;
    ownershipState: OwnershipState;
    protocolVersion: string;
  }): Promise<AgentMetadata> {
    return await this.post<AgentMetadata>("initialize", input);
  }

  async metadata(): Promise<AgentMetadata> {
    return await this.post<AgentMetadata>("metadata", {});
  }

  async transitionOwnership(input: {
    expected: OwnershipState;
    next: OwnershipState;
    now: string;
  }): Promise<AgentMetadata | undefined> {
    return await this.post<AgentMetadata | undefined>("transitionOwnership", input);
  }

  async issueClient(input: {
    kind: ClientKind;
    credentialHash: string;
    capabilities: ClientCapability[];
    now: string;
  }): Promise<ClientSummaryV1> {
    return await this.post<ClientSummaryV1>("issueClient", input);
  }

  async authenticateClient(input: { credentialHash: string; now: string }): Promise<ClientSummaryV1 | undefined> {
    return await this.post<ClientSummaryV1 | undefined>("authenticateClient", input);
  }

  async listClients(): Promise<ClientSummaryV1[]> {
    return await this.post<ClientSummaryV1[]>("listClients", {});
  }

  async revokeClient(input: { clientId: string; now: string }): Promise<boolean> {
    return await this.post<boolean>("revokeClient", input);
  }

  async integrityCheck(): Promise<"ok" | "failed"> {
    return await this.post<"ok" | "failed">("integrityCheck", {});
  }

  async backupTo(path: string): Promise<void> {
    await this.post("backupTo", { path });
  }

  async upsertSource(capability: SourceCapabilityV1, now: string): Promise<void> {
    await this.post("upsertSource", { capability, now });
  }

  async listSources(): Promise<SourceCapabilityV1[]> {
    return await this.post<SourceCapabilityV1[]>("listSources", {});
  }

  async lastSourceObservationAt(sourceId: string): Promise<string | undefined> {
    return await this.post<string | undefined>("lastSourceObservationAt", { sourceId });
  }

  async appendSafeObservation(observation: SafeObservationV1): Promise<boolean> {
    return await this.post<boolean>("appendSafeObservation", { observation });
  }

  async safeObservationCount(): Promise<number> {
    return await this.post<number>("safeObservationCount", {});
  }

  async applySafeObservationRetention(retainAfter: string, maxObservations: number): Promise<SafeObservationRetentionResult> {
    return await this.post<SafeObservationRetentionResult>("applySafeObservationRetention", { retainAfter, maxObservations });
  }

  async listSafeUsageAtoms(): Promise<SafeUsageAtomV1[]> {
    return await this.post<SafeUsageAtomV1[]>("listSafeUsageAtoms", {});
  }

  async listSafeUsageAtomsForQueryIds(queryIds: string[]): Promise<SafeUsageAtomV1[]> {
    return await this.post<SafeUsageAtomV1[]>("listSafeUsageAtomsForQueryIds", { queryIds });
  }

  async listSafeUsageAtomsSince(startedAt: string): Promise<SafeUsageAtomV1[]> {
    return await this.post<SafeUsageAtomV1[]>("listSafeUsageAtomsSince", { startedAt });
  }

  async listSafeActivityAtoms(): Promise<SafeActivityAtomV1[]> {
    return await this.post<SafeActivityAtomV1[]>("listSafeActivityAtoms", {});
  }

  async listSafeActivityAtomsForQueryIds(queryIds: string[]): Promise<SafeActivityAtomV1[]> {
    return await this.post<SafeActivityAtomV1[]>("listSafeActivityAtomsForQueryIds", { queryIds });
  }

  async listSafeActivityAtomsSince(startedAt: string): Promise<SafeActivityAtomV1[]> {
    return await this.post<SafeActivityAtomV1[]>("listSafeActivityAtomsSince", { startedAt });
  }

  async listQueryOccurrences(): Promise<QueryOccurrenceV1[]> {
    return await this.post<QueryOccurrenceV1[]>("listQueryOccurrences", {});
  }

  async readQueryOccurrence(queryId: string): Promise<QueryOccurrenceV1 | undefined> {
    return await this.post<QueryOccurrenceV1 | undefined>("readQueryOccurrence", { queryId });
  }

  async listQueryOccurrencesSince(startedAt: string): Promise<QueryOccurrenceV1[]> {
    return await this.post<QueryOccurrenceV1[]>("listQueryOccurrencesSince", { startedAt });
  }

  async applyQueryOccurrenceRetention(retainAfter: string): Promise<number> {
    return await this.post<number>("applyQueryOccurrenceRetention", { retainAfter });
  }

  async clearQueryOccurrences(): Promise<void> {
    await this.post("clearQueryOccurrences", {});
  }

  async replaceShadowRuns(runs: ShadowRunV1[]): Promise<void> {
    await this.post("replaceShadowRuns", { runs });
  }

  async listShadowRuns(): Promise<ShadowRunV1[]> {
    return await this.post<ShadowRunV1[]>("listShadowRuns", {});
  }

  async clearShadowState(): Promise<void> {
    await this.post("clearShadowState", {});
  }

  async beginProductionUsageEpoch(startedAt: string): Promise<ProductionUsageEpochV1> {
    return await this.post<ProductionUsageEpochV1>("beginProductionUsageEpoch", { startedAt });
  }

  async productionUsageEpoch(): Promise<ProductionUsageEpochV1 | undefined> {
    return await this.post<ProductionUsageEpochV1 | undefined>("productionUsageEpoch", {});
  }

  async replaceProductionRuns(runs: ProductionRunV1[]): Promise<void> {
    await this.post("replaceProductionRuns", { runs });
  }

  async upsertProductionRuns(runs: ProductionRunV1[]): Promise<void> {
    await this.post("upsertProductionRuns", { runs });
  }

  async applyProductionRunRetention(
    runs: ProductionRunV1[],
    retainAfter: string
  ): Promise<ProductionUsageEpochV1> {
    return await this.post<ProductionUsageEpochV1>("applyProductionRunRetention", { runs, retainAfter });
  }

  async listProductionRuns(): Promise<ProductionRunV1[]> {
    return await this.post<ProductionRunV1[]>("listProductionRuns", {});
  }

  async clearProductionRuns(): Promise<void> {
    await this.post("clearProductionRuns", {});
  }

  async upsertRepositoryScope(record: EncryptedRepositoryScope): Promise<void> {
    await this.post("upsertRepositoryScope", { record });
  }

  async listRepositoryScopes(): Promise<EncryptedRepositoryScope[]> {
    return await this.post<EncryptedRepositoryScope[]>("listRepositoryScopes", {});
  }

  async removeRepositoryScope(scopeId: string): Promise<boolean> {
    return await this.post<boolean>("removeRepositoryScope", { scopeId });
  }

  async upsertRepositoryEpoch(epoch: unknown): Promise<void> {
    await this.post("upsertRepositoryEpoch", { epoch });
  }

  async persistRepositoryCandidatesAndAdvance(epoch: unknown, candidates: unknown[]): Promise<void> {
    await this.post("persistRepositoryCandidatesAndAdvance", { epoch, candidates });
  }

  async updateRepositoryCandidate(candidate: unknown): Promise<void> {
    await this.post("updateRepositoryCandidate", { candidate });
  }

  async listRepositoryEpochs<T = unknown>(): Promise<T[]> {
    return await this.post<T[]>("listRepositoryEpochs", {});
  }

  async listRepositoryCandidates<T = unknown>(): Promise<T[]> {
    return await this.post<T[]>("listRepositoryCandidates", {});
  }

  async applyRepositoryCandidateRetention(retainAfter: string): Promise<number> {
    return await this.post<number>("applyRepositoryCandidateRetention", { retainAfter });
  }

  async clearRepositoryObservation(): Promise<void> {
    await this.post("clearRepositoryObservation", {});
  }

  async upsertAgentDocument(collection: AgentDocumentCollection, document: AgentDocument): Promise<void> {
    await this.post("upsertAgentDocument", { collection, document });
  }

  async replaceAgentDocuments(collection: AgentDocumentCollection, documents: AgentDocument[]): Promise<void> {
    await this.post("replaceAgentDocuments", { collection, documents });
  }

  async listAgentDocuments<T = unknown>(collection: AgentDocumentCollection): Promise<Array<Omit<AgentDocument, "value"> & { value: T }>> {
    return await this.post<Array<Omit<AgentDocument, "value"> & { value: T }>>("listAgentDocuments", { collection });
  }

  async listWorkspaceEvidenceDocuments<T = unknown>(
    query: WorkspaceEvidenceDocumentQuery = {}
  ): Promise<Array<Omit<AgentDocument, "value"> & { value: T }>> {
    return await this.post<Array<Omit<AgentDocument, "value"> & { value: T }>>("listWorkspaceEvidenceDocuments", { query });
  }

  async listWorkEpisodeDocuments<T = unknown>(
    query: WorkEpisodeDocumentQuery = {}
  ): Promise<Array<Omit<AgentDocument, "value"> & { value: T }>> {
    return await this.post<Array<Omit<AgentDocument, "value"> & { value: T }>>("listWorkEpisodeDocuments", { query });
  }

  async attributionDocumentSummary(): Promise<AttributionDocumentSummary> {
    return await this.post<AttributionDocumentSummary>("attributionDocumentSummary", {});
  }

  async sanitizeOversizedAttributionDocuments(maxArtifactStates: number): Promise<AttributionDocumentSanitizationResult> {
    return await this.post<AttributionDocumentSanitizationResult>("sanitizeOversizedAttributionDocuments", { maxArtifactStates });
  }

  async trimAgentDocuments(collection: AgentDocumentCollection, maxDocuments: number): Promise<number> {
    return await this.post<number>("trimAgentDocuments", { collection, maxDocuments });
  }

  async readAgentDocument<T = unknown>(collection: AgentDocumentCollection, key: string): Promise<(Omit<AgentDocument, "value"> & { value: T }) | undefined> {
    return await this.post<(Omit<AgentDocument, "value"> & { value: T }) | undefined>("readAgentDocument", { collection, key });
  }

  async listWebhookOutboxDueDocuments<T = unknown>(now: string, force = false): Promise<Array<Omit<AgentDocument, "value"> & { value: T }>> {
    return await this.post<Array<Omit<AgentDocument, "value"> & { value: T }>>("listWebhookOutboxDueDocuments", { now, force });
  }

  async webhookOutboxStatus<T = unknown>(): Promise<WebhookOutboxStatusSnapshot<T>> {
    return await this.post<WebhookOutboxStatusSnapshot<T>>("webhookOutboxStatus", {});
  }

  async listWebhookLifecycleDocuments<T = unknown>(
    identity: WebhookLifecycleDocumentIdentity
  ): Promise<Array<Omit<AgentDocument, "value"> & { value: T }>> {
    return await this.post<Array<Omit<AgentDocument, "value"> & { value: T }>>("listWebhookLifecycleDocuments", { identity });
  }

  async listDeliveredWritingLifecycleRunIds(): Promise<string[]> {
    return await this.post<string[]>("listDeliveredWritingLifecycleRunIds", {});
  }

  async nextWebhookOutboxAttemptAt(): Promise<string | undefined> {
    return await this.post<string | undefined>("nextWebhookOutboxAttemptAt", {});
  }

  async listExecutionNodeDocumentsForQuery<T = unknown>(queryId: string): Promise<Array<Omit<AgentDocument, "value"> & { value: T }>> {
    return await this.post<Array<Omit<AgentDocument, "value"> & { value: T }>>("listExecutionNodeDocumentsForQuery", { queryId });
  }

  async applyExecutionNodeRetention(retainAfter: string, maxNodes: number): Promise<ExecutionNodeRetentionResult> {
    return await this.post<ExecutionNodeRetentionResult>("applyExecutionNodeRetention", { retainAfter, maxNodes });
  }

  async compactIfFragmented(): Promise<StorageCompactionResult> {
    return await this.post<StorageCompactionResult>("compactIfFragmented", {});
  }

  async pruneRepositorySnapshotDocuments(maxArtifactStates: number): Promise<number> {
    return await this.post<number>("pruneRepositorySnapshotDocuments", { maxArtifactStates });
  }

  async removeAgentDocument(collection: AgentDocumentCollection, key: string): Promise<boolean> {
    return await this.post<boolean>("removeAgentDocument", { collection, key });
  }

  async clearAgentDocuments(collection: AgentDocumentCollection): Promise<void> {
    await this.post("clearAgentDocuments", { collection });
  }

  async clearAllAgentData(now: string): Promise<void> {
    await this.post("clearAllAgentData", { now });
  }

  async close(): Promise<void> {
    try {
      await this.post("close", {});
    } finally {
      await this.worker.terminate();
    }
  }

  private post<T = void>(command: WorkerCommandName, payload: unknown): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, command, payload } satisfies WorkerRequest);
    });
  }

  private handleMessage(message: WorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error));
    }
  }
}

function defaultWorkerPath(): string {
  const local = join(__dirname, "worker.js");
  if (existsSync(local)) {
    return local;
  }
  return join(__dirname, "..", "dist", "worker.js");
}

type WorkerCommandName =
  | "open"
  | "initialize"
  | "metadata"
  | "transitionOwnership"
  | "issueClient"
  | "authenticateClient"
  | "listClients"
  | "revokeClient"
  | "integrityCheck"
  | "backupTo"
  | "upsertSource"
  | "listSources"
  | "lastSourceObservationAt"
  | "appendSafeObservation"
  | "safeObservationCount"
  | "applySafeObservationRetention"
  | "listSafeUsageAtoms"
  | "listSafeUsageAtomsForQueryIds"
  | "listSafeUsageAtomsSince"
  | "listSafeActivityAtoms"
  | "listSafeActivityAtomsForQueryIds"
  | "listSafeActivityAtomsSince"
  | "listQueryOccurrences"
  | "readQueryOccurrence"
  | "listQueryOccurrencesSince"
  | "applyQueryOccurrenceRetention"
  | "clearQueryOccurrences"
  | "replaceShadowRuns"
  | "listShadowRuns"
  | "clearShadowState"
  | "beginProductionUsageEpoch"
  | "productionUsageEpoch"
  | "replaceProductionRuns"
  | "upsertProductionRuns"
  | "applyProductionRunRetention"
  | "listProductionRuns"
  | "clearProductionRuns"
  | "upsertRepositoryScope"
  | "listRepositoryScopes"
  | "removeRepositoryScope"
  | "upsertRepositoryEpoch"
  | "persistRepositoryCandidatesAndAdvance"
  | "updateRepositoryCandidate"
  | "listRepositoryEpochs"
  | "listRepositoryCandidates"
  | "applyRepositoryCandidateRetention"
  | "clearRepositoryObservation"
  | "upsertAgentDocument"
  | "replaceAgentDocuments"
  | "listAgentDocuments"
  | "listWorkspaceEvidenceDocuments"
  | "listWorkEpisodeDocuments"
  | "attributionDocumentSummary"
  | "sanitizeOversizedAttributionDocuments"
  | "trimAgentDocuments"
  | "readAgentDocument"
  | "listWebhookOutboxDueDocuments"
  | "webhookOutboxStatus"
  | "listWebhookLifecycleDocuments"
  | "listDeliveredWritingLifecycleRunIds"
  | "nextWebhookOutboxAttemptAt"
  | "listExecutionNodeDocumentsForQuery"
  | "applyExecutionNodeRetention"
  | "compactIfFragmented"
  | "pruneRepositorySnapshotDocuments"
  | "removeAgentDocument"
  | "clearAgentDocuments"
  | "clearAllAgentData"
  | "close";

type WorkerRequest = {
  id: number;
  command: WorkerCommandName;
  payload: unknown;
};

type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
