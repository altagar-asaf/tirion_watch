import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { parentPort } from "node:worker_threads";
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
import type {
  AgentDocument,
  AgentDocumentCollection,
  EncryptedRepositoryScope,
  SafeObservationRetentionResult
} from "./index";

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

type DatabaseSyncConstructor = new (location: string, options?: Record<string, unknown>) => SqliteDatabase;

let db: SqliteDatabase | undefined;
let openedDatabasePath: string | undefined;

parentPort?.on("message", (message: WorkerRequest) => {
  try {
    const result = handle(message.command, message.payload);
    parentPort?.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    parentPort?.postMessage({ id: message.id, ok: false, error: safeWorkerError(error) });
  }
});

function safeWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return ["invalid_request", "storage_unavailable", "ownership_conflict"].includes(message)
    ? message
    : "storage_unavailable";
}

function handle(command: WorkerCommandName, payload: unknown): unknown {
  switch (command) {
    case "open":
      return open(asRecord(payload).databasePath as string);
    case "initialize":
      return initialize(asInitializeInput(payload));
    case "metadata":
      return metadata();
    case "transitionOwnership":
      return transitionOwnership(asOwnershipTransitionInput(payload));
    case "issueClient":
      return issueClient(asIssueClientInput(payload));
    case "authenticateClient":
      return authenticateClient(asAuthInput(payload));
    case "listClients":
      return listClients();
    case "revokeClient":
      return revokeClient(asRevokeInput(payload));
    case "integrityCheck":
      return integrityCheck();
    case "backupTo":
      return backupTo(String(asRecord(payload).path));
    case "upsertSource":
      return upsertSource(asSourceInput(payload));
    case "listSources":
      return listSources();
    case "lastSourceObservationAt":
      return lastSourceObservationAt(String(asRecord(payload).sourceId));
    case "appendSafeObservation":
      return appendSafeObservation(asObservationInput(payload));
    case "safeObservationCount":
      return safeObservationCount();
    case "applySafeObservationRetention":
      return applySafeObservationRetention(
        String(asRecord(payload).retainAfter),
        Number(asRecord(payload).maxObservations)
      );
    case "listSafeUsageAtoms":
      return listSafeUsageAtoms();
    case "listSafeUsageAtomsSince":
      return listSafeUsageAtomsSince(String(asRecord(payload).startedAt));
    case "listSafeActivityAtoms":
      return listSafeActivityAtoms();
    case "listSafeActivityAtomsSince":
      return listSafeActivityAtomsSince(String(asRecord(payload).startedAt));
    case "listQueryOccurrences":
      return listQueryOccurrences();
    case "listQueryOccurrencesSince":
      return listQueryOccurrencesSince(String(asRecord(payload).startedAt));
    case "applyQueryOccurrenceRetention":
      return applyQueryOccurrenceRetention(String(asRecord(payload).retainAfter));
    case "clearQueryOccurrences":
      return clearQueryOccurrences();
    case "replaceShadowRuns":
      return replaceShadowRuns(asShadowRunsInput(payload));
    case "listShadowRuns":
      return listShadowRuns();
    case "clearShadowState":
      return clearShadowState();
    case "beginProductionUsageEpoch":
      return beginProductionUsageEpoch(String(asRecord(payload).startedAt));
    case "productionUsageEpoch":
      return productionUsageEpoch();
    case "replaceProductionRuns":
      return replaceProductionRuns(asProductionRunsInput(payload));
    case "listProductionRuns":
      return listProductionRuns();
    case "clearProductionRuns":
      return clearProductionRuns();
    case "upsertRepositoryScope":
      return upsertRepositoryScope(asRepositoryScopeInput(payload));
    case "listRepositoryScopes":
      return listRepositoryScopes();
    case "removeRepositoryScope":
      return removeRepositoryScope(String(asRecord(payload).scopeId));
    case "upsertRepositoryEpoch":
      return upsertRepositoryEpoch(asRecord(payload).epoch);
    case "persistRepositoryCandidatesAndAdvance":
      return persistRepositoryCandidatesAndAdvance(asRecord(payload).epoch, asArray(asRecord(payload).candidates));
    case "updateRepositoryCandidate":
      return upsertRepositoryCandidate(asRecord(payload).candidate);
    case "listRepositoryEpochs":
      return listRepositoryEpochs();
    case "listRepositoryCandidates":
      return listRepositoryCandidates();
    case "applyRepositoryCandidateRetention":
      return applyRepositoryCandidateRetention(String(asRecord(payload).retainAfter));
    case "clearRepositoryObservation":
      return clearRepositoryObservation();
    case "upsertAgentDocument":
      return upsertAgentDocument(asAgentDocumentInput(payload));
    case "replaceAgentDocuments":
      return replaceAgentDocuments(asAgentDocumentsInput(payload));
    case "listAgentDocuments":
      return listAgentDocuments(asAgentDocumentCollection(payload));
    case "trimAgentDocuments":
      return trimAgentDocuments(asAgentDocumentCollection(payload), Number(asRecord(payload).maxDocuments));
    case "removeAgentDocument":
      return removeAgentDocument(asAgentDocumentCollection(payload), requiredText(asRecord(payload).key));
    case "clearAgentDocuments":
      return clearAgentDocuments(asAgentDocumentCollection(payload));
    case "clearAllAgentData":
      return clearAllAgentData(String(asRecord(payload).now));
    case "close":
      db?.close();
      db = undefined;
      openedDatabasePath = undefined;
      return undefined;
  }
}

function open(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const DatabaseSync = loadDatabaseSync();
  db = new DatabaseSync(databasePath, { open: true });
  openedDatabasePath = databasePath;
  database().exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate();
}

function initialize(input: InitializeInput): AgentMetadataRow {
  const existing = readMetadata();
  const installationId = existing.installationId ?? `ins_${randomUUID()}`;
  const environmentId = existing.environmentId ?? `env_${randomUUID()}`;
  const createdAt = existing.createdAt ?? input.now;
  const record: AgentMetadataRow = {
    installationId,
    environmentId,
    schemaVersion: 9,
    ownershipState: (existing.ownershipState as OwnershipState | undefined) ?? input.ownershipState,
    protocolVersion: input.protocolVersion,
    createdAt,
    updatedAt: input.now
  };
  writeMetadata(record);
  return record;
}

function transitionOwnership(input: OwnershipTransitionInput): AgentMetadataRow | undefined {
  const current = metadata();
  if (current.ownershipState !== input.expected) {
    return undefined;
  }
  const statement = database().prepare(`
    UPDATE agent_metadata
    SET value = ?
    WHERE key = 'ownershipState' AND value = ?
  `);
  const result = statement.run(input.next, input.expected) as { changes?: number };
  if (result.changes === 0) {
    return undefined;
  }
  database().prepare("INSERT OR REPLACE INTO agent_metadata (key, value) VALUES ('updatedAt', ?)").run(input.now);
  return metadata();
}

function metadata(): AgentMetadataRow {
  const record = readMetadata();
  if (!record.installationId || !record.environmentId || !record.ownershipState) {
    throw new Error("storage_unavailable");
  }
  return {
    installationId: record.installationId,
    environmentId: record.environmentId,
    schemaVersion: Number(record.schemaVersion ?? 9),
    ownershipState: record.ownershipState as OwnershipState,
    protocolVersion: record.protocolVersion ?? "1.0",
    createdAt: record.createdAt ?? record.updatedAt ?? new Date(0).toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString()
  };
}

function issueClient(input: IssueClientInput): ClientSummaryV1 {
  const clientId = `cli_${randomUUID()}`;
  database().prepare(`
    INSERT INTO clients (client_id, kind, credential_hash, capabilities_json, issued_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(clientId, input.kind, input.credentialHash, JSON.stringify(input.capabilities), input.now);
  return rowToClient({
    client_id: clientId,
    kind: input.kind,
    capabilities_json: JSON.stringify(input.capabilities),
    issued_at: input.now,
    last_used_at: undefined,
    revoked_at: undefined
  });
}

function authenticateClient(input: AuthInput): ClientSummaryV1 | undefined {
  const row = database().prepare(`
    SELECT client_id, kind, capabilities_json, issued_at, last_used_at, revoked_at
    FROM clients
    WHERE credential_hash = ?
  `).get(input.credentialHash) as ClientRow | undefined;
  if (!row || row.revoked_at) {
    return undefined;
  }
  database().prepare("UPDATE clients SET last_used_at = ? WHERE client_id = ?").run(input.now, row.client_id);
  return rowToClient({ ...row, last_used_at: input.now });
}

function listClients(): ClientSummaryV1[] {
  return database().prepare(`
    SELECT client_id, kind, capabilities_json, issued_at, last_used_at, revoked_at
    FROM clients
    ORDER BY issued_at ASC
  `).all().map((row) => rowToClient(row as ClientRow));
}

function revokeClient(input: RevokeInput): boolean {
  const existing = database().prepare("SELECT client_id FROM clients WHERE client_id = ? AND revoked_at IS NULL").get(input.clientId);
  if (!existing) {
    return false;
  }
  database().prepare("UPDATE clients SET revoked_at = ? WHERE client_id = ?").run(input.now, input.clientId);
  return true;
}

function integrityCheck(): "ok" | "failed" {
  const rows = database().prepare("PRAGMA integrity_check").all() as Record<string, unknown>[];
  return rows.length === 1 && Object.values(rows[0])[0] === "ok" ? "ok" : "failed";
}

function backupTo(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  database().exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
}

function migrate(): void {
  const row = database().prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const current = Number(row ? Object.values(row)[0] : 0);
  if (current > 9) {
    throw new Error("storage_unavailable");
  }
  if (current === 0) {
    database().exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS agent_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        capabilities_json TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
  const afterInitial = current === 0 ? 1 : current;
  if (afterInitial === 1) {
    backupBeforeMigration(1);
    database().exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS source_registry (
        source_id TEXT PRIMARY KEY,
        capability_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS safe_observation_journal (
        observation_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_registry(source_id),
        provider TEXT NOT NULL,
        runtime TEXT NOT NULL,
        signal TEXT NOT NULL,
        profile_version TEXT NOT NULL,
        resource_count INTEGER NOT NULL,
        record_count INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        appended_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }
  const afterJournal = afterInitial === 1 ? 2 : afterInitial;
  if (afterJournal === 2) {
    backupBeforeMigration(2);
    database().exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS safe_usage_atoms (
        atom_id TEXT PRIMARY KEY,
        observation_id TEXT NOT NULL REFERENCES safe_observation_journal(observation_id) ON DELETE CASCADE,
        atom_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shadow_runs (
        run_id TEXT PRIMARY KEY,
        run_json TEXT NOT NULL
      );
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }
  const afterShadow = afterJournal === 2 ? 3 : afterJournal;
  if (afterShadow === 3) {
    backupBeforeMigration(3);
    database().exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS production_usage_epoch (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        epoch_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS production_runs (
        run_id TEXT PRIMARY KEY,
        run_json TEXT NOT NULL
      );
      PRAGMA user_version = 4;
      COMMIT;
    `);
  }
  const afterProduction = afterShadow === 3 ? 4 : afterShadow;
  if (afterProduction === 4) {
    backupBeforeMigration(4);
    database().exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS repository_scopes (
        scope_id TEXT PRIMARY KEY,
        public_json TEXT NOT NULL,
        locator_ciphertext TEXT NOT NULL,
        locator_iv TEXT NOT NULL,
        locator_tag TEXT NOT NULL
      );
      PRAGMA user_version = 5;
      COMMIT;
    `);
  }
  const afterScopes = afterProduction === 4 ? 5 : afterProduction;
  if (afterScopes === 5) {
    backupBeforeMigration(5);
    database().exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS repository_epochs (
        repo_key TEXT PRIMARY KEY,
        epoch_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repository_candidates (
        candidate_id TEXT PRIMARY KEY,
        observed_at TEXT NOT NULL,
        decision TEXT NOT NULL,
        candidate_json TEXT NOT NULL
      );
      PRAGMA user_version = 6;
      COMMIT;
    `);
  }
  const afterObservation = afterScopes === 5 ? 6 : afterScopes;
  if (afterObservation === 6) {
    backupBeforeMigration(6);
    database().exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS agent_documents (
        collection TEXT NOT NULL,
        document_key TEXT NOT NULL,
        sort_at TEXT NOT NULL,
        document_json TEXT NOT NULL,
        PRIMARY KEY (collection, document_key)
      );
      CREATE INDEX IF NOT EXISTS agent_documents_collection_sort
        ON agent_documents (collection, sort_at, document_key);
      PRAGMA user_version = 7;
      COMMIT;
    `);
  }
  const afterDocuments = afterObservation === 6 ? 7 : afterObservation;
  if (afterDocuments === 7) {
    backupBeforeMigration(7);
    database().exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS query_occurrences (
        query_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        occurrence_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS query_occurrences_started_at
        ON query_occurrences (started_at, query_id);
      PRAGMA user_version = 8;
      COMMIT;
    `);
  }
  const afterOccurrences = afterDocuments === 7 ? 8 : afterDocuments;
  if (afterOccurrences === 8) {
    backupBeforeMigration(8);
    database().exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS safe_activity_atoms (
        activity_id TEXT PRIMARY KEY,
        observation_id TEXT NOT NULL REFERENCES safe_observation_journal(observation_id) ON DELETE CASCADE,
        atom_json TEXT NOT NULL
      );
      PRAGMA user_version = 9;
      COMMIT;
    `);
  }
}

function backupBeforeMigration(fromVersion: number): void {
  if (!openedDatabasePath) {
    throw new Error("storage_unavailable");
  }
  const backupPath = `${openedDatabasePath}.pre-migration-${fromVersion}.bak`;
  if (!existsSync(backupPath)) {
    backupTo(backupPath);
  }
}

function upsertSource(input: SourceInput): void {
  database().prepare(`
    INSERT INTO source_registry (source_id, capability_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET capability_json = excluded.capability_json, updated_at = excluded.updated_at
  `).run(input.capability.sourceId, JSON.stringify(input.capability), input.now);
}

function listSources(): SourceCapabilityV1[] {
  return (database().prepare("SELECT capability_json FROM source_registry ORDER BY source_id").all() as { capability_json: string }[])
    .map((row) => JSON.parse(row.capability_json) as SourceCapabilityV1);
}

function lastSourceObservationAt(sourceId: string): string | undefined {
  return (database().prepare(`
    SELECT observed_at FROM safe_observation_journal
    WHERE source_id = ?
    ORDER BY observed_at DESC
    LIMIT 1
  `).get(sourceId) as { observed_at?: string } | undefined)?.observed_at;
}

function appendSafeObservation(input: ObservationInput): boolean {
  const observation = input.observation;
  database().exec("BEGIN IMMEDIATE");
  try {
    const result = database().prepare(`
      INSERT OR IGNORE INTO safe_observation_journal (
        observation_id, source_id, provider, runtime, signal, profile_version, resource_count, record_count, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.observationId,
      observation.sourceId,
      observation.provider,
      observation.runtime,
      observation.signal,
      observation.profileVersion,
      observation.resourceCount,
      observation.recordCount,
      observation.observedAt
    ) as { changes?: number };
    if (result.changes !== 0) {
      const statement = database().prepare(`
        INSERT INTO safe_usage_atoms (atom_id, observation_id, atom_json)
        VALUES (?, ?, ?)
        ON CONFLICT(atom_id) DO UPDATE SET
          observation_id = excluded.observation_id,
          atom_json = excluded.atom_json
      `);
      for (const atom of observation.usageAtoms) {
        statement.run(atom.atomId, observation.observationId, JSON.stringify(atom));
      }
      const activityStatement = database().prepare(`
        INSERT INTO safe_activity_atoms (activity_id, observation_id, atom_json)
        VALUES (?, ?, ?)
        ON CONFLICT(activity_id) DO UPDATE SET
          observation_id = excluded.observation_id,
          atom_json = excluded.atom_json
      `);
      for (const atom of observation.activityAtoms ?? []) {
        activityStatement.run(atom.activityId, observation.observationId, JSON.stringify(atom));
      }
      const executionNodeStatement = database().prepare(`
        INSERT INTO agent_documents (collection, document_key, sort_at, document_json)
        VALUES ('execution_node_atom', ?, ?, ?)
        ON CONFLICT(collection, document_key) DO UPDATE SET
          sort_at = excluded.sort_at,
          document_json = excluded.document_json
      `);
      for (const node of observation.executionNodes ?? []) {
        executionNodeStatement.run(node.nodeId, node.startedAt, JSON.stringify(node));
      }
      const occurrenceStatement = database().prepare(`
        INSERT INTO query_occurrences (query_id, started_at, occurrence_json)
        VALUES (?, ?, ?)
        ON CONFLICT(query_id) DO UPDATE SET
          started_at = excluded.started_at,
          occurrence_json = excluded.occurrence_json
      `);
      for (const occurrence of observation.queryOccurrences ?? []) {
        const existingRow = database().prepare(
          "SELECT occurrence_json FROM query_occurrences WHERE query_id = ?"
        ).get(occurrence.queryId) as { occurrence_json: string } | undefined;
        const existing = existingRow ? JSON.parse(existingRow.occurrence_json) as QueryOccurrenceV1 : undefined;
        const retained = preferredQueryOccurrence(existing, occurrence);
        occurrenceStatement.run(retained.queryId, retained.startedAt, JSON.stringify(retained));
      }
    }
    database().exec("COMMIT");
    return result.changes !== 0;
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}

function preferredQueryOccurrence(existing: QueryOccurrenceV1 | undefined, incoming: QueryOccurrenceV1): QueryOccurrenceV1 {
  if (!existing || incoming.promptState === "captured") {
    return incoming;
  }
  if (existing.promptState === "captured") {
    return existing;
  }
  if (incoming.promptState === "disabled") {
    return incoming;
  }
  return existing;
}

function safeObservationCount(): number {
  const row = database().prepare("SELECT COUNT(*) AS count FROM safe_observation_journal").get() as { count: number };
  return Number(row.count);
}

function applySafeObservationRetention(retainAfter: string, maxObservations: number): SafeObservationRetentionResult {
  if (!Number.isSafeInteger(maxObservations) || maxObservations <= 0) {
    throw new Error("invalid_request");
  }
  database().exec("BEGIN IMMEDIATE");
  try {
    const byAge = database().prepare(`
      DELETE FROM safe_observation_journal WHERE appended_at < ?
    `).run(retainAfter) as { changes?: number };
    const countAfterAge = safeObservationCount();
    const overflow = Math.max(0, countAfterAge - maxObservations);
    if (overflow > 0) {
      database().prepare(`
        DELETE FROM safe_observation_journal
        WHERE observation_id IN (
          SELECT observation_id
          FROM safe_observation_journal
          ORDER BY appended_at ASC, observation_id ASC
          LIMIT ?
        )
      `).run(overflow);
    }
    database().exec("COMMIT");
    return {
      removedByAge: Number(byAge.changes ?? 0),
      removedByOverflow: overflow,
      retainedCount: safeObservationCount()
    };
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}

function listSafeUsageAtoms(): SafeUsageAtomV1[] {
  return (database().prepare("SELECT atom_json FROM safe_usage_atoms ORDER BY atom_id").all() as { atom_json: string }[])
    .map((row) => JSON.parse(row.atom_json) as SafeUsageAtomV1);
}

function listSafeUsageAtomsSince(startedAt: string): SafeUsageAtomV1[] {
  return (database().prepare(`
    SELECT a.atom_json
    FROM safe_usage_atoms a
    JOIN safe_observation_journal o ON o.observation_id = a.observation_id
    WHERE o.appended_at >= ?
    ORDER BY a.atom_id
  `).all(startedAt) as { atom_json: string }[]).map((row) => JSON.parse(row.atom_json) as SafeUsageAtomV1);
}

function listSafeActivityAtoms(): SafeActivityAtomV1[] {
  return (database().prepare("SELECT atom_json FROM safe_activity_atoms ORDER BY activity_id").all() as { atom_json: string }[])
    .map((row) => JSON.parse(row.atom_json) as SafeActivityAtomV1);
}

function listSafeActivityAtomsSince(startedAt: string): SafeActivityAtomV1[] {
  return (database().prepare(`
    SELECT a.atom_json
    FROM safe_activity_atoms a
    JOIN safe_observation_journal o ON o.observation_id = a.observation_id
    WHERE o.appended_at >= ?
    ORDER BY a.activity_id
  `).all(startedAt) as { atom_json: string }[]).map((row) => JSON.parse(row.atom_json) as SafeActivityAtomV1);
}

function listQueryOccurrences(): QueryOccurrenceV1[] {
  return (database().prepare("SELECT occurrence_json FROM query_occurrences ORDER BY started_at, query_id").all() as { occurrence_json: string }[])
    .map((row) => JSON.parse(row.occurrence_json) as QueryOccurrenceV1);
}

function listQueryOccurrencesSince(startedAt: string): QueryOccurrenceV1[] {
  return (database().prepare(`
    SELECT occurrence_json FROM query_occurrences
    WHERE started_at >= ?
    ORDER BY started_at, query_id
  `).all(startedAt) as { occurrence_json: string }[]).map((row) => JSON.parse(row.occurrence_json) as QueryOccurrenceV1);
}

function applyQueryOccurrenceRetention(retainAfter: string): number {
  const result = database().prepare("DELETE FROM query_occurrences WHERE started_at < ?").run(retainAfter) as { changes?: number };
  return Number(result.changes ?? 0);
}

function clearQueryOccurrences(): void {
  database().exec("DELETE FROM query_occurrences");
}

function replaceShadowRuns(input: ShadowRunsInput): void {
  database().exec("BEGIN IMMEDIATE");
  try {
    database().exec("DELETE FROM shadow_runs");
    const statement = database().prepare("INSERT INTO shadow_runs (run_id, run_json) VALUES (?, ?)");
    for (const run of input.runs) {
      statement.run(run.runId, JSON.stringify(run));
    }
    database().exec("COMMIT");
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}

function listShadowRuns(): ShadowRunV1[] {
  return (database().prepare("SELECT run_json FROM shadow_runs ORDER BY run_id").all() as { run_json: string }[])
    .map((row) => JSON.parse(row.run_json) as ShadowRunV1)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function clearShadowState(): void {
  database().exec(`
    BEGIN IMMEDIATE;
    DELETE FROM shadow_runs;
    DELETE FROM safe_usage_atoms;
    DELETE FROM safe_activity_atoms;
    DELETE FROM safe_observation_journal;
    DELETE FROM query_occurrences;
    COMMIT;
  `);
}

function beginProductionUsageEpoch(startedAt: string): ProductionUsageEpochV1 {
  const epoch: ProductionUsageEpochV1 = {
    schemaVersion: 1,
    epochId: `usage_${randomUUID()}`,
    startedAt
  };
  database().exec("BEGIN IMMEDIATE");
  try {
    database().exec("DELETE FROM production_runs");
    database().prepare(`
      INSERT OR REPLACE INTO production_usage_epoch (singleton_id, epoch_id, started_at)
      VALUES (1, ?, ?)
    `).run(epoch.epochId, epoch.startedAt);
    database().exec("COMMIT");
    return epoch;
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}

function productionUsageEpoch(): ProductionUsageEpochV1 | undefined {
  const row = database().prepare("SELECT epoch_id, started_at FROM production_usage_epoch WHERE singleton_id = 1").get() as {
    epoch_id: string;
    started_at: string;
  } | undefined;
  return row ? { schemaVersion: 1, epochId: row.epoch_id, startedAt: row.started_at } : undefined;
}

function replaceProductionRuns(input: ProductionRunsInput): void {
  database().exec("BEGIN IMMEDIATE");
  try {
    database().exec("DELETE FROM production_runs");
    const statement = database().prepare("INSERT INTO production_runs (run_id, run_json) VALUES (?, ?)");
    for (const run of input.runs) {
      statement.run(run.runId, JSON.stringify(run));
    }
    database().exec("COMMIT");
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}

function listProductionRuns(): ProductionRunV1[] {
  return (database().prepare("SELECT run_json FROM production_runs ORDER BY run_id").all() as { run_json: string }[])
    .map((row) => JSON.parse(row.run_json) as ProductionRunV1)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function clearProductionRuns(): void {
  database().exec("DELETE FROM production_runs");
}

function upsertRepositoryScope(input: RepositoryScopeInput): void {
  const record = input.record;
  database().prepare(`
    INSERT INTO repository_scopes (scope_id, public_json, locator_ciphertext, locator_iv, locator_tag)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope_id) DO UPDATE SET
      public_json = excluded.public_json,
      locator_ciphertext = excluded.locator_ciphertext,
      locator_iv = excluded.locator_iv,
      locator_tag = excluded.locator_tag
  `).run(
    record.scope.scopeId,
    JSON.stringify(record.scope),
    record.locatorCiphertext,
    record.locatorIv,
    record.locatorTag
  );
}

function listRepositoryScopes(): EncryptedRepositoryScope[] {
  return (database().prepare(`
    SELECT public_json, locator_ciphertext, locator_iv, locator_tag
    FROM repository_scopes
    ORDER BY scope_id
  `).all() as RepositoryScopeRow[]).map((row) => ({
    scope: JSON.parse(row.public_json) as RepositoryScopeV1,
    locatorCiphertext: row.locator_ciphertext,
    locatorIv: row.locator_iv,
    locatorTag: row.locator_tag
  }));
}

function removeRepositoryScope(scopeId: string): boolean {
  const result = database().prepare("DELETE FROM repository_scopes WHERE scope_id = ?").run(scopeId) as { changes?: number };
  return result.changes !== 0;
}

function upsertRepositoryEpoch(epoch: unknown): void {
  const record = asRecord(epoch);
  const repoKey = requiredText(record.repoKey);
  database().prepare(`
    INSERT INTO repository_epochs (repo_key, epoch_json)
    VALUES (?, ?)
    ON CONFLICT(repo_key) DO UPDATE SET epoch_json = excluded.epoch_json
  `).run(repoKey, JSON.stringify(epoch));
}

function persistRepositoryCandidatesAndAdvance(epoch: unknown, candidates: unknown[]): void {
  database().exec("BEGIN IMMEDIATE");
  try {
    for (const candidate of candidates) {
      upsertRepositoryCandidate(candidate);
    }
    upsertRepositoryEpoch(epoch);
    database().exec("COMMIT");
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}

function upsertRepositoryCandidate(candidate: unknown): void {
  const record = asRecord(candidate);
  database().prepare(`
    INSERT INTO repository_candidates (candidate_id, observed_at, decision, candidate_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(candidate_id) DO UPDATE SET
      observed_at = excluded.observed_at,
      decision = excluded.decision,
      candidate_json = excluded.candidate_json
  `).run(
    requiredText(record.candidateId),
    requiredText(record.observedAt),
    requiredText(record.decision),
    JSON.stringify(candidate)
  );
}

function listRepositoryEpochs(): unknown[] {
  return (database().prepare("SELECT epoch_json FROM repository_epochs ORDER BY repo_key").all() as { epoch_json: string }[])
    .map((row) => JSON.parse(row.epoch_json));
}

function listRepositoryCandidates(): unknown[] {
  return (database().prepare("SELECT candidate_json FROM repository_candidates ORDER BY observed_at, candidate_id").all() as { candidate_json: string }[])
    .map((row) => JSON.parse(row.candidate_json));
}

function applyRepositoryCandidateRetention(retainAfter: string): number {
  const result = database().prepare(`
    DELETE FROM repository_candidates
    WHERE decision NOT IN ('pending_evidence', 'rewrite_pending')
      AND observed_at < ?
  `).run(retainAfter) as { changes?: number };
  return Number(result.changes ?? 0);
}

function clearRepositoryObservation(): void {
  database().exec(`
    BEGIN IMMEDIATE;
    DELETE FROM repository_candidates;
    DELETE FROM repository_epochs;
    COMMIT;
  `);
}

function upsertAgentDocument(input: AgentDocumentInput): void {
  database().prepare(`
    INSERT INTO agent_documents (collection, document_key, sort_at, document_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(collection, document_key) DO UPDATE SET
      sort_at = excluded.sort_at,
      document_json = excluded.document_json
  `).run(input.collection, input.document.key, input.document.sortAt, JSON.stringify(input.document.value));
}

function replaceAgentDocuments(input: AgentDocumentsInput): void {
  database().exec("BEGIN IMMEDIATE");
  try {
    database().prepare("DELETE FROM agent_documents WHERE collection = ?").run(input.collection);
    const statement = database().prepare(`
      INSERT INTO agent_documents (collection, document_key, sort_at, document_json)
      VALUES (?, ?, ?, ?)
    `);
    for (const document of input.documents) {
      statement.run(input.collection, document.key, document.sortAt, JSON.stringify(document.value));
    }
    database().exec("COMMIT");
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}

function listAgentDocuments(collection: AgentDocumentCollection): AgentDocument[] {
  return (database().prepare(`
    SELECT document_key, sort_at, document_json
    FROM agent_documents
    WHERE collection = ?
    ORDER BY sort_at DESC, document_key
  `).all(collection) as AgentDocumentRow[]).map((row) => ({
    key: row.document_key,
    sortAt: row.sort_at,
    value: JSON.parse(row.document_json)
  }));
}

function trimAgentDocuments(collection: AgentDocumentCollection, maxDocuments: number): number {
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments <= 0) {
    throw new Error("invalid_request");
  }
  const result = database().prepare(`
    DELETE FROM agent_documents
    WHERE rowid IN (
      SELECT rowid FROM agent_documents
      WHERE collection = ?
      ORDER BY sort_at DESC, document_key
      LIMIT -1 OFFSET ?
    )
  `).run(collection, maxDocuments) as { changes?: number };
  return Number(result.changes ?? 0);
}

function removeAgentDocument(collection: AgentDocumentCollection, key: string): boolean {
  const result = database().prepare(`
    DELETE FROM agent_documents WHERE collection = ? AND document_key = ?
  `).run(collection, key) as { changes?: number };
  return result.changes !== 0;
}

function clearAgentDocuments(collection: AgentDocumentCollection): void {
  database().prepare("DELETE FROM agent_documents WHERE collection = ?").run(collection);
}

function clearAllAgentData(now: string): void {
  database().exec("BEGIN IMMEDIATE");
  try {
    database().exec(`
      DELETE FROM clients;
      DELETE FROM safe_usage_atoms;
      DELETE FROM safe_activity_atoms;
      DELETE FROM safe_observation_journal;
      DELETE FROM source_registry;
      DELETE FROM query_occurrences;
      DELETE FROM shadow_runs;
      DELETE FROM production_runs;
      DELETE FROM production_usage_epoch;
      DELETE FROM repository_scopes;
      DELETE FROM repository_candidates;
      DELETE FROM repository_epochs;
      DELETE FROM agent_documents;
    `);
    database().prepare("INSERT OR REPLACE INTO agent_metadata (key, value) VALUES ('updatedAt', ?)").run(now);
    database().exec("COMMIT");
    database().exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}

function readMetadata(): Record<string, string> {
  const rows = database().prepare("SELECT key, value FROM agent_metadata").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function writeMetadata(record: AgentMetadataRow): void {
  const statement = database().prepare("INSERT OR REPLACE INTO agent_metadata (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(record)) {
    statement.run(key, String(value));
  }
}

function rowToClient(row: ClientRow): ClientSummaryV1 {
  return {
    schemaVersion: 1,
    clientId: row.client_id,
    kind: row.kind as ClientKind,
    capabilities: JSON.parse(row.capabilities_json) as ClientCapability[],
    issuedAt: row.issued_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}

function database(): SqliteDatabase {
  if (!db) {
    throw new Error("storage_unavailable");
  }
  return db;
}

function loadDatabaseSync(): DatabaseSyncConstructor {
  try {
    const sqlite = require("node:sqlite") as { DatabaseSync?: DatabaseSyncConstructor };
    if (!sqlite.DatabaseSync) {
      throw new Error("node:sqlite DatabaseSync is unavailable.");
    }
    return sqlite.DatabaseSync;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`node:sqlite unavailable for Tirion agent storage: ${message}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  return value;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 10_000) {
    throw new Error("invalid_request");
  }
  return value;
}

function asInitializeInput(value: unknown): InitializeInput {
  const record = asRecord(value);
  return {
    now: String(record.now),
    ownershipState: record.ownershipState as OwnershipState,
    protocolVersion: String(record.protocolVersion)
  };
}

function asOwnershipTransitionInput(value: unknown): OwnershipTransitionInput {
  const record = asRecord(value);
  return {
    expected: record.expected as OwnershipState,
    next: record.next as OwnershipState,
    now: String(record.now)
  };
}

function asIssueClientInput(value: unknown): IssueClientInput {
  const record = asRecord(value);
  return {
    kind: record.kind as ClientKind,
    credentialHash: String(record.credentialHash),
    capabilities: record.capabilities as ClientCapability[],
    now: String(record.now)
  };
}

function asAuthInput(value: unknown): AuthInput {
  const record = asRecord(value);
  return { credentialHash: String(record.credentialHash), now: String(record.now) };
}

function asRevokeInput(value: unknown): RevokeInput {
  const record = asRecord(value);
  return { clientId: String(record.clientId), now: String(record.now) };
}

function asSourceInput(value: unknown): SourceInput {
  const record = asRecord(value);
  return { capability: record.capability as SourceCapabilityV1, now: String(record.now) };
}

function asObservationInput(value: unknown): ObservationInput {
  const record = asRecord(value);
  return { observation: record.observation as SafeObservationV1 };
}

function asShadowRunsInput(value: unknown): ShadowRunsInput {
  const record = asRecord(value);
  return { runs: record.runs as ShadowRunV1[] };
}

function asProductionRunsInput(value: unknown): ProductionRunsInput {
  const record = asRecord(value);
  return { runs: record.runs as ProductionRunV1[] };
}

function asRepositoryScopeInput(value: unknown): RepositoryScopeInput {
  const record = asRecord(value);
  return { record: record.record as EncryptedRepositoryScope };
}

function asAgentDocumentCollection(value: unknown): AgentDocumentCollection {
  const collection = String(asRecord(value).collection);
  if (![
    "construct_state",
    "repository_snapshot",
    "workspace_evidence",
    "work_episode",
    "query_attribution",
    "completed_run_tracking",
    "completed_run_tracking_state",
    "execution_node_atom",
    "execution_tree_snapshot",
    "webhook_outbox",
    "webhook_delivery_state",
    "budget_config",
    "budget_warning",
    "diagnostic_event",
    "journal_state",
    "prompt_capture_config",
    "provider_source_config"
  ].includes(collection)) {
    throw new Error("invalid_request");
  }
  return collection as AgentDocumentCollection;
}

function asAgentDocumentInput(value: unknown): AgentDocumentInput {
  const record = asRecord(value);
  return {
    collection: asAgentDocumentCollection(value),
    document: asAgentDocument(record.document)
  };
}

function asAgentDocumentsInput(value: unknown): AgentDocumentsInput {
  const record = asRecord(value);
  return {
    collection: asAgentDocumentCollection(value),
    documents: asArray(record.documents).map(asAgentDocument)
  };
}

function asAgentDocument(value: unknown): AgentDocument {
  const record = asRecord(value);
  return {
    key: requiredText(record.key),
    sortAt: requiredText(record.sortAt),
    value: record.value
  };
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
  | "listSafeUsageAtomsSince"
  | "listSafeActivityAtoms"
  | "listSafeActivityAtomsSince"
  | "listQueryOccurrences"
  | "listQueryOccurrencesSince"
  | "applyQueryOccurrenceRetention"
  | "clearQueryOccurrences"
  | "replaceShadowRuns"
  | "listShadowRuns"
  | "clearShadowState"
  | "beginProductionUsageEpoch"
  | "productionUsageEpoch"
  | "replaceProductionRuns"
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
  | "trimAgentDocuments"
  | "removeAgentDocument"
  | "clearAgentDocuments"
  | "clearAllAgentData"
  | "close";

type WorkerRequest = {
  id: number;
  command: WorkerCommandName;
  payload: unknown;
};

type InitializeInput = {
  now: string;
  ownershipState: OwnershipState;
  protocolVersion: string;
};

type OwnershipTransitionInput = {
  expected: OwnershipState;
  next: OwnershipState;
  now: string;
};

type IssueClientInput = {
  kind: ClientKind;
  credentialHash: string;
  capabilities: ClientCapability[];
  now: string;
};

type AuthInput = {
  credentialHash: string;
  now: string;
};

type RevokeInput = {
  clientId: string;
  now: string;
};

type SourceInput = {
  capability: SourceCapabilityV1;
  now: string;
};

type ObservationInput = {
  observation: SafeObservationV1;
};

type ShadowRunsInput = {
  runs: ShadowRunV1[];
};

type ProductionRunsInput = {
  runs: ProductionRunV1[];
};

type RepositoryScopeInput = {
  record: EncryptedRepositoryScope;
};

type AgentDocumentInput = {
  collection: AgentDocumentCollection;
  document: AgentDocument;
};

type AgentDocumentsInput = {
  collection: AgentDocumentCollection;
  documents: AgentDocument[];
};

type AgentMetadataRow = {
  installationId: string;
  environmentId: string;
  schemaVersion: number;
  ownershipState: OwnershipState;
  protocolVersion: string;
  createdAt: string;
  updatedAt: string;
};

type ClientRow = {
  client_id: string;
  kind: string;
  capabilities_json: string;
  issued_at: string;
  last_used_at?: string;
  revoked_at?: string;
};

type RepositoryScopeRow = {
  public_json: string;
  locator_ciphertext: string;
  locator_iv: string;
  locator_tag: string;
};

type AgentDocumentRow = {
  document_key: string;
  sort_at: string;
  document_json: string;
};
