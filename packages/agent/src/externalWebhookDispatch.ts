import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, isAbsolute } from "node:path";
import type {
  AgentWebhookConfigurationV1,
  AgentWebhookDeliveryItemV1,
  AgentWebhookStatusV1,
  CommitAttributedWebhookEventV1,
  CostEstimateBasis,
  ProductionRunV1,
  QueryOccurrenceV1,
  RunBreakdownV1,
  RunContextFootprintV1,
  RunEndedWebhookEventV1,
  RunLifecycleActivityWebhookV1,
  RunStartedWebhookEventV1,
  RunUpdatedWebhookEventV1,
  SafeActivityAtomV1,
  SafeObservationV1,
  SafeUsageAtomV1,
  WebhookCoverageV1,
  WebhookEvidenceV1,
  WebhookBearerTokenConfigurationV1,
  WebhookEventTypeV1,
  WebhookEventV1,
  WebhookRepositoryV1,
  WebhookSenderConfigurationV1,
  WebhookSenderProfileV1,
  WebhookSenderV1,
  WebhookSecretConfigurationV1,
  WebhookUrlConfigurationV1
} from "@tirion/agent-contract";
import type { AgentStorageClient } from "@tirion/agent-storage";
import { DefaultProductionUsagePipeline } from "@tirion/engine";
import {
  type AgenticWorkEpisode,
  DefaultPrivacyGuard,
  type CommitAttributionSummary,
  type CommitPublicationSnapshot,
  type DiagnosticEvent
} from "@tirion/engine/production";
import { writePrivateFileAtomic } from "@tirion/platform";
import type { AgentVerifiedAttributionService } from "./productionRunAttribution";
import type { AgentRepositoryObservationService } from "./repositoryObservationService";

const RETRY_INTERVAL_MS = 30_000;
const MAX_RETRY_DELAY_MS = 10 * 60 * 1000;
// Grace window after run completion to allow async file writes (e.g. Codex apply_patch)
// to complete before the first webhook delivery. The reprocessing mechanism replaces the
// outbox entry with correct filesChanged once evidence arrives; this delay prevents an
// early empty-filesChanged delivery from racing ahead.
const RUN_ENDED_GRACE_MS = 15_000;
// Grace window for commit.attributed to allow all episode claims (which fire in rapid
// succession as each episode is attributed) to settle before delivery. This also ensures
// the runIds are fully populated from all contributing runs before the event fires.
const COMMIT_ATTRIBUTED_GRACE_MS = 4_000;
const LIVE_UPDATE_USAGE_PIPELINE = new DefaultProductionUsagePipeline();

type StoredWebhookConfiguration = {
  schemaVersion: 1;
  url?: string;
  bearerToken?: string;
  hmacSecret?: string;
  sender?: WebhookSenderProfileV1;
  runEndedEnabled?: boolean;
};

type WebhookOutboxEntry = {
  schemaVersion: 1;
  key: string;
  event: WebhookEventV1;
  eventType: WebhookEventTypeV1;
  subjectId: string;
  payloadHash: string;
  deliveryState: AgentWebhookDeliveryItemV1["deliveryState"];
  attempts: number;
  queuedAt: string;
  firstAttemptAt?: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  nextAttemptAt?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
};

type WebhookSubjectState = {
  schemaVersion: 1;
  subjectId: string;
  eventType: WebhookEventTypeV1;
  payloadHash: string;
  eventId: string;
  version?: number;
  deliveredAt?: string;
  filesChangedCount?: number;
  updatedAt: string;
};

type WebhookConfigPaths = {
  configurationPath: string;
};

type RunLifecycleProjection = {
  subjectRunId: string;
  started: RunStartedWebhookEventV1;
  updated: RunUpdatedWebhookEventV1;
  ended: RunEndedWebhookEventV1;
  allowFilesChangedAfterReadOnly: boolean;
};

type LiveLifecycleSubject = {
  subjectRunId: string;
  sessionId: string;
  queryIds: string[];
  startedAt: string;
  lastObservedAt: string;
  repository: WebhookRepositoryV1;
  provider: SafeObservationV1["provider"];
  runtime: string;
};

type LiveStartedProjection = {
  queryId: string;
  event: RunStartedWebhookEventV1;
};

type LiveUpdatedProjection = {
  queryId: string;
  event: RunUpdatedWebhookEventV1;
};

type RunEndedWebhookEventDraft = Omit<RunEndedWebhookEventV1, "eventId" | "version"> & {
  eventId?: string;
  version?: number;
};

type QueueEventOptions = {
  allowFilesChangedAfterReadOnly?: boolean;
};

type RunTokenTotals = Pick<
  RunUpdatedWebhookEventV1,
  "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "reasoningOutputTokens" | "totalTokens"
>;

type LiveRunUpdateCost = Pick<
  RunUpdatedWebhookEventV1,
  "estimatedNanoUsd" | "costEstimateBasis" | "costCoverage"
> & {
  usageValueNanoUsd?: number;
};

export class ExternalWebhookDispatchService {
  private readonly privacy = new DefaultPrivacyGuard();
  private readonly configuration: FileWebhookConfigurationStore;
  private readonly outbox: SqliteWebhookOutbox;
  private readonly subjects: SqliteWebhookSubjectStateStore;
  private retryTimer?: NodeJS.Timeout;
  private running = false;
  private deliveryRunning = false;
  private deliveryRerunRequested = false;
  private deliveryRerunForce = false;
  private readonly liveRunStarts = new Map<string, string>();
  private readonly liveRunRepositories = new Map<string, WebhookRepositoryV1>();
  private readonly liveRunUpdates = new Map<string, RunUpdatedWebhookEventV1>();
  private readonly liveRunSubjects = new Map<string, LiveLifecycleSubject>();
  private readonly liveQuerySubjects = new Map<string, string>();
  private readonly liveSessionSubjects = new Map<string, string>();

  constructor(
    storage: AgentStorageClient,
    paths: WebhookConfigPaths,
    private readonly attribution: AgentVerifiedAttributionService,
    private readonly repositories: AgentRepositoryObservationService,
    private readonly now: () => number = Date.now,
    private readonly recordEvent: (event: DiagnosticEvent) => void = () => undefined,
    private readonly installationId = "installation_local"
  ) {
    this.configuration = new FileWebhookConfigurationStore(paths.configurationPath);
    this.outbox = new SqliteWebhookOutbox(storage, this.privacy);
    this.subjects = new SqliteWebhookSubjectStateStore(storage);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleRetry();
    void this.reconcileCommitEvents().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    while (this.deliveryRunning) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async status(): Promise<AgentWebhookStatusV1> {
    const configuration = this.configuration.read();
    const entries = await this.outbox.list();
    const queued = entries.filter((entry) => entry.deliveryState === "pending" || entry.deliveryState === "retry");
    const blocked = entries.filter((entry) => entry.deliveryState === "blocked");
    const delivered = entries.filter((entry) => entry.deliveryState === "delivered");
    return {
      ...configuration,
      queuedCount: queued.length,
      blockedCount: blocked.length,
      deliveredCount: delivered.length,
      oldestQueuedAt: queued.map((entry) => entry.queuedAt).sort().at(0),
      maxQueueAgeMs: queued.length > 0
        ? Math.max(...queued.map((entry) => queueAgeMs(entry, this.now()) ?? 0))
        : undefined,
      lastDeliveredAt: delivered.map((entry) => entry.deliveredAt ?? entry.updatedAt).sort().at(-1),
      lastErrorCode: [...entries]
        .filter((entry) => typeof entry.lastErrorCode === "string")
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .at(-1)?.lastErrorCode,
      ...(blocked.length > 0 ? { blockedItems: blocked.map(statusItemFromEntry) } : {}),
      ...(queued.length > 0 ? { queuedItems: queued.map(statusItemFromEntry) } : {})
    };
  }

  async configureUrl(input: WebhookUrlConfigurationV1): Promise<AgentWebhookStatusV1> {
    this.configuration.setUrl(input);
    await this.recordStatusChange("webhook_url_configured");
    return await this.status();
  }

  async setBearerToken(input: WebhookBearerTokenConfigurationV1): Promise<AgentWebhookStatusV1> {
    this.configuration.setBearerToken(input);
    await this.recordStatusChange("webhook_bearer_token_configured");
    return await this.status();
  }

  async clearBearerToken(): Promise<AgentWebhookStatusV1> {
    this.configuration.clearBearerToken();
    await this.recordStatusChange("webhook_bearer_token_cleared");
    return await this.status();
  }

  async setHmacSecret(input: WebhookSecretConfigurationV1): Promise<AgentWebhookStatusV1> {
    this.configuration.setHmacSecret(input);
    await this.recordStatusChange("webhook_hmac_secret_configured");
    return await this.status();
  }

  async configureSender(input: WebhookSenderConfigurationV1): Promise<AgentWebhookStatusV1> {
    this.configuration.setSender(input);
    await this.recordStatusChange("webhook_sender_configured");
    return await this.status();
  }

  async clearSender(): Promise<AgentWebhookStatusV1> {
    this.configuration.clearSender();
    await this.recordStatusChange("webhook_sender_cleared");
    return await this.status();
  }

  async clearHmacSecret(): Promise<AgentWebhookStatusV1> {
    this.configuration.clearHmacSecret();
    await this.recordStatusChange("webhook_hmac_secret_cleared");
    return await this.status();
  }

  async setRunEndedEnabled(enabled: boolean): Promise<AgentWebhookStatusV1> {
    this.configuration.setRunEndedEnabled(enabled);
    await this.recordStatusChange(enabled ? "webhook_runs_enabled" : "webhook_runs_disabled");
    return await this.status();
  }

  async retryNow(): Promise<AgentWebhookStatusV1> {
    await this.processDueEntries(true);
    await this.recordStatusChange("webhook_retry_requested");
    return await this.status();
  }

  async test(): Promise<{ schemaVersion: 1; eventId: string; queued: boolean }> {
    const at = new Date(this.now()).toISOString();
    const runId = `run_test_${randomUUID().replace(/-/g, "")}`;
    const evidence = webhookEvidence("prompt_hook", "tirionctl-test", at, false, "test");
    const coverage = webhookCoverage("final", "none", "unavailable");
    const sender = this.webhookSender();
    const event: RunEndedWebhookEventV1 = {
      schemaVersion: 1,
      eventType: "run.ended",
      eventId: eventIdFor("run.ended", runId),
      runId,
      sessionId: `ses_test_${runId.slice(9, 17)}`,
      traceIds: [`trace_test_${runId.slice(9, 17)}`],
      sender,
      repository: {
        repoKey: "repo_test",
        owner: "local",
        name: "test",
        fullName: "local/test"
      },
      codingHarness: "codex",
      runtime: "tirionctl-test",
      startedAt: at,
      evidence,
      coverage,
      endedAt: at,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      llmModels: [],
      filesChanged: [],
      estimatedNanoUsd: 0,
      costEstimateBasis: "unavailable",
      costCoverage: "unavailable",
      state: "completed"
    };
    const queued = await this.queueRunEndedEvent(event, `run.ended:${runId}`);
    return {
      schemaVersion: 1,
      eventId: event.eventId,
      queued
    };
  }

  async observeCompletedRuns(runs: ProductionRunV1[]): Promise<void> {
    for (const run of runs.filter((candidate) => candidate.endedAt && candidate.endedAt >= candidate.startedAt)) {
      const events = await this.projectRunLifecycleEvents(run);
      if (!events) {
        continue;
      }
      await this.queueEvent(events.started, `run.start:${events.subjectRunId}`);
      await this.queueEvent(events.updated, `run.update:${events.subjectRunId}`);
      await this.queueRunEndedEvent(events.ended, `run.ended:${events.subjectRunId}`, {
        allowFilesChangedAfterReadOnly: events.allowFilesChangedAfterReadOnly
      });
    }
    await this.processDueEntries();
  }

  async observeSafeObservation(observation: SafeObservationV1): Promise<void> {
    const repository = await this.bindLiveObservationToRepository(observation);
    if (!repository) {
      return;
    }
    const sender = this.webhookSender();
    let queued = false;
    await this.rememberLiveOccurrences(observation, repository);
    const startedEvents = projectLiveRunStartedEvents(observation, repository, sender);
    for (const projection of startedEvents) {
      const subject = await this.liveSubjectForQuery(observation, projection.queryId, repository);
      if (!subject) {
        continue;
      }
      const event = canonicalizeLiveStartedEvent(projection.event, projection.queryId, subject);
      this.liveRunStarts.set(event.runId, event.startedAt);
      this.liveRunRepositories.set(event.runId, event.repository);
      queued = (await this.queueEvent(event, `run.start:${event.runId}`)) || queued;
    }
    for (const projection of projectLiveRunUpdatedEvents(observation, repository, sender)) {
      const subject = await this.liveSubjectForQuery(observation, projection.queryId, repository);
      if (!subject) {
        this.recordQueueLifecycle(
          projection.event,
          `run.update:${projection.event.runId}`,
          "blocked",
          "run_update_waiting_for_start",
          {
            provider: observation.provider,
            sourceId: observation.sourceId
          }
        );
        continue;
      }
      let event = canonicalizeLiveUpdatedEvent(projection.event, projection.queryId, subject);
      const startedAt = this.liveRunStarts.get(event.runId);
      if (!startedAt) {
        this.recordQueueLifecycle(
          event,
          `run.update:${event.runId}`,
          "blocked",
          "run_update_waiting_for_start",
          {
            provider: observation.provider,
            sourceId: observation.sourceId
          }
        );
        continue;
      }
      if (startedAt && startedAt <= event.startedAt) {
        event.startedAt = startedAt;
      }
      event = this.mergeLiveRunUpdate(event);
      queued = (await this.queueEvent(event, `run.update:${event.runId}`)) || queued;
    }
    if (queued) {
      await this.processDueEntries();
    }
  }

  private async rememberLiveOccurrences(observation: SafeObservationV1, repository: WebhookRepositoryV1): Promise<void> {
    for (const occurrence of observation.queryOccurrences ?? []) {
      if (!isLiveLifecycleAnchorOccurrence(observation.provider, occurrence)) {
        continue;
      }
      await this.rememberLiveOccurrence(observation, occurrence, repository);
    }
  }

  private async rememberLiveOccurrence(
    observation: SafeObservationV1,
    occurrence: QueryOccurrenceV1,
    repository: WebhookRepositoryV1
  ): Promise<LiveLifecycleSubject> {
    const existingSubjectId = this.liveQuerySubjects.get(occurrence.queryId);
    const existingSubject = existingSubjectId ? this.liveRunSubjects.get(existingSubjectId) : undefined;
    if (existingSubject) {
      return this.upsertLiveSubject(existingSubject.subjectRunId, observation, occurrence, repository);
    }

    const activeSubjectId = this.liveSessionSubjects.get(occurrence.sessionId);
    const activeSubject = activeSubjectId ? this.liveRunSubjects.get(activeSubjectId) : undefined;
    const activeTerminal = activeSubject
      ? await this.deliveredRunEndedForSubject(activeSubject.subjectRunId)
      : undefined;
    const startsNewSubject = observation.provider !== "codex"
      || occurrence.evidence === "submission_hook"
      || occurrence.evidence === "provider_user_prompt_event"
      || occurrence.evidence === "provider_user_message_event"
      || !activeSubject
      || Boolean(activeTerminal);
    const subjectRunId = startsNewSubject ? runIdForQuery(occurrence.queryId) : activeSubject.subjectRunId;
    return this.upsertLiveSubject(subjectRunId, observation, occurrence, repository);
  }

  private async liveSubjectForQuery(
    observation: SafeObservationV1,
    queryId: string,
    repository: WebhookRepositoryV1
  ): Promise<LiveLifecycleSubject | undefined> {
    const existingSubjectId = this.liveQuerySubjects.get(queryId);
    const existingSubject = existingSubjectId ? this.liveRunSubjects.get(existingSubjectId) : undefined;
    if (existingSubject) {
      return existingSubject;
    }

    const sessionId = liveSessionId(observation, queryId);
    const activeSubjectId = this.liveSessionSubjects.get(sessionId);
    const activeSubject = activeSubjectId ? this.liveRunSubjects.get(activeSubjectId) : undefined;
    if (
      observation.provider === "codex"
      && activeSubject
      && !(await this.deliveredRunEndedForSubject(activeSubject.subjectRunId))
    ) {
      return this.extendLiveSubject(activeSubject, queryId, observation.observedAt, repository);
    }

    if (observation.provider === "codex") {
      const occurrence = await this.latestPromptOccurrenceForSession(observation.provider, sessionId, observation.observedAt);
      if (occurrence) {
        return this.upsertLiveSubject(runIdForQuery(occurrence.queryId), observation, {
          ...occurrence,
          queryId
        }, repository);
      }
    }

    return undefined;
  }

  private upsertLiveSubject(
    subjectRunId: string,
    observation: SafeObservationV1,
    occurrence: QueryOccurrenceV1,
    repository: WebhookRepositoryV1
  ): LiveLifecycleSubject {
    const existing = this.liveRunSubjects.get(subjectRunId);
    const subject: LiveLifecycleSubject = {
      subjectRunId,
      sessionId: occurrence.sessionId,
      queryIds: uniqueStrings([...(existing?.queryIds ?? []), occurrence.queryId]),
      startedAt: earliestIso([existing?.startedAt, occurrence.startedAt].filter((value): value is string => Boolean(value))),
      lastObservedAt: latestIso([existing?.lastObservedAt, observation.observedAt].filter((value): value is string => Boolean(value))),
      repository,
      provider: observation.provider,
      runtime: observation.runtime
    };
    this.liveRunSubjects.set(subjectRunId, subject);
    this.liveQuerySubjects.set(occurrence.queryId, subjectRunId);
    this.liveSessionSubjects.set(occurrence.sessionId, subjectRunId);
    this.liveRunStarts.set(subjectRunId, subject.startedAt);
    this.liveRunRepositories.set(subjectRunId, repository);
    return subject;
  }

  private extendLiveSubject(
    subject: LiveLifecycleSubject,
    queryId: string,
    observedAt: string,
    repository: WebhookRepositoryV1
  ): LiveLifecycleSubject {
    const next: LiveLifecycleSubject = {
      ...subject,
      queryIds: uniqueStrings([...subject.queryIds, queryId]),
      lastObservedAt: latestIso([subject.lastObservedAt, observedAt]),
      repository
    };
    this.liveRunSubjects.set(next.subjectRunId, next);
    this.liveQuerySubjects.set(queryId, next.subjectRunId);
    this.liveRunRepositories.set(next.subjectRunId, repository);
    return next;
  }

  private async latestPromptOccurrenceForSession(
    provider: SafeObservationV1["provider"],
    sessionId: string,
    observedAt: string
  ): Promise<QueryOccurrenceV1 | undefined> {
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs)) {
      return undefined;
    }
    const occurrences = (await this.outbox.storage.listQueryOccurrences())
      .filter((occurrence) =>
        occurrence.provider === provider
        && occurrence.sessionId === sessionId
        && isLiveLifecycleAnchorOccurrence(provider, occurrence)
        && isPromptStartOccurrence(occurrence)
        && Date.parse(occurrence.startedAt) <= observedMs
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    for (const occurrence of occurrences) {
      const subjectRunId = runIdForQuery(occurrence.queryId);
      if (!await this.deliveredRunEndedForSubject(subjectRunId)) {
        return occurrence;
      }
    }
    return undefined;
  }

  async reconcileCommitEvents(commitHash?: string): Promise<void> {
    const [summaries, snapshots, workEpisodes] = await Promise.all([
      this.attribution.listCommitAttributions(commitHash ? { commitHash } : {}),
      this.attribution.listCommitPublicationSnapshots(commitHash ? { commitHash } : {}),
      this.attribution.listWorkEpisodes()
    ]);
    const snapshotByCommit = new Map(snapshots.map((snapshot) => [commitSubject(snapshot.repoKey, snapshot.commitHash), snapshot]));
    const runsById = new Map((await this.productionRuns()).map((run) => [run.runId, run]));
    const atomsByQuery = groupAtomsByQuery(await this.safeUsageAtoms());
    const outboxEntries = await this.outbox.list();
    const subjectStates = await this.subjects.list();
    const deliveredWritingSubjectRunIds = writingRunIdsFromDeliveredLifecycle(outboxEntries, subjectStates);
    for (const summary of summaries) {
      const subjectId = commitSubject(summary.repoKey, summary.commitHash);
      const snapshot = snapshotByCommit.get(subjectId);
      if (!snapshot) {
        continue;
      }
      const repository = await this.describeRepository(summary.repoKey);
      const candidateRunIds = runIdsForCommit(summary, workEpisodes);
      const candidateRuns = candidateRunIds
        .map((runId) => runsById.get(runId))
        .filter((run): run is ProductionRunV1 => Boolean(run));
      const writingSubjectByProductionRunId = new Map<string, string>();
      for (const run of candidateRuns) {
        const queryId = run.queryId ?? run.correlationId;
        const artifactKeys = artifactKeysForCommitRun(workEpisodes, summary, run);
        const deliveredTerminal = await this.subjects.read(`run.ended:${run.runId}`);
        if (
          summary.inheritedQueryIds.includes(queryId)
          && deliveredTerminal
          && (deliveredTerminal.filesChangedCount ?? 0) === 0
        ) {
          continue;
        }
        if (artifactKeys.length === 0) {
          continue;
        }
        const events = await this.projectRunLifecycleEventsFromBinding(
          run,
          {
            repository,
            artifactKeys,
            artifactScope: "explicit"
          },
          workEpisodes
        );
        if (!events) {
          continue;
        }
        await this.queueEvent(events.started, `run.start:${events.subjectRunId}`);
        await this.queueEvent(events.updated, `run.update:${events.subjectRunId}`);
        const queuedEnded = await this.queueRunEndedEvent(events.ended, `run.ended:${events.subjectRunId}`, {
          allowFilesChangedAfterReadOnly: events.allowFilesChangedAfterReadOnly
        });
        if (
          (events.ended.filesChanged?.length ?? 0) > 0
          && (queuedEnded || deliveredWritingSubjectRunIds.has(events.subjectRunId))
        ) {
          writingSubjectByProductionRunId.set(run.runId, events.subjectRunId);
        }
      }
      if (writingSubjectByProductionRunId.size > 0) {
        await this.processDueEntries();
      }
      const filteredRunPairs = candidateRuns
        .map((run) => ({ run, subjectRunId: writingSubjectByProductionRunId.get(run.runId) }))
        .filter((item): item is { run: ProductionRunV1; subjectRunId: string } => Boolean(item.subjectRunId));
      if (filteredRunPairs.length === 0) {
        if (candidateRunIds.length > 0) {
          this.recordEvent({
            kind: "constructLifecycle",
            construct: "ExternalWebhookDispatch",
            operation: "projection",
            state: "blocked",
            reason: "commit_webhook_production_run_ids_unavailable",
            commitHash: summary.commitHash,
            repoKey: summary.repoKey,
            details: {
              candidateRunIdCount: candidateRunIds.length
            }
          });
        }
        continue;
      }
      const filteredRuns = filteredRunPairs.map((item) => item.run);
      const webhookRunIds = uniqueStrings(filteredRunPairs.map((item) => item.subjectRunId));
      const traceIdsByRunId = new Map(filteredRuns.map((run) => [run.runId, traceIdsForRun(run, atomsByQuery)]));
      const missingTraceRunCount = filteredRuns.filter((run) => (traceIdsByRunId.get(run.runId) ?? []).length === 0).length;
      if (missingTraceRunCount > 0) {
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "ExternalWebhookDispatch",
          operation: "projection",
          state: "blocked",
          reason: "commit_webhook_trace_ids_unavailable",
          commitHash: summary.commitHash,
          repoKey: summary.repoKey,
          details: {
            runIdCount: filteredRuns.length,
            missingTraceRunCount
          }
        });
        continue;
      }
      const traceIds = uniqueStrings(filteredRuns.flatMap((run) => traceIdsByRunId.get(run.runId) ?? []));
      const cost = attributedCommitCost(summary, snapshot);
      const next = await this.queueCommitEvent(
        { ...summary, runIds: webhookRunIds },
        snapshot,
        repository,
        traceIds,
        subjectId,
        {
          ...cost,
          usageValueNanoUsd: attributedCommitUsageValue(filteredRuns)
        }
      );
      if (!next) {
        continue;
      }
    }
    await this.processDueEntries();
  }

  async clear(): Promise<void> {
    await Promise.all([
      this.outbox.clear(),
      this.subjects.clear()
    ]);
  }

  async clearLocalAgentData(): Promise<void> {
    this.configuration.clear();
    await this.clear();
  }

  async applyRetention(retentionDays: number): Promise<void> {
    await this.outbox.applyRetention(retentionDays);
  }

  private async queueCommitEvent(
    summary: CommitAttributionSummary,
    snapshot: CommitPublicationSnapshot,
    repository: WebhookRepositoryV1,
    traceIds: string[],
    subjectId: string,
    cost: {
      estimatedNanoUsd: number;
      usageValueNanoUsd?: number;
      costCoverage: CommitAttributedWebhookEventV1["costCoverage"];
    }
  ): Promise<boolean> {
    const state = await this.subjects.read(subjectId);
      const basePayload = {
      schemaVersion: 1 as const,
      eventType: "commit.attributed" as const,
      sender: this.webhookSender(),
      repository,
      commitSha: snapshot.commitHash,
      ...commitMessagePayload(summary.commitMessage ?? snapshot.commitMessage),
      traceIds,
      runIds: uniqueStrings(summary.runIds),
      estimatedNanoUsd: cost.estimatedNanoUsd,
      ...(cost.usageValueNanoUsd != null ? { usageValueNanoUsd: cost.usageValueNanoUsd } : {}),
      costCoverage: cost.costCoverage,
      state: snapshot.state,
      firstVerifiedAt: snapshot.firstVerifiedAt,
      updatedAt: snapshot.updatedAt
    };
    const payloadHash = contentHash(basePayload);
    if (state?.payloadHash === payloadHash) {
      return false;
    }
    const version = Math.max(1, (state?.version ?? 0) + 1);
    const event: CommitAttributedWebhookEventV1 = {
      ...basePayload,
      // Stable eventId: all version updates share one outbox entry (last write wins before
      // grace period expires). This prevents N separate deliveries when N episodes are
      // claimed for the same commit in rapid succession.
      eventId: eventIdFor("commit.attributed", subjectId),
      version
    };
    await this.subjects.write({
      schemaVersion: 1,
      subjectId,
      eventType: "commit.attributed",
      payloadHash,
      eventId: event.eventId,
      version,
      updatedAt: new Date(this.now()).toISOString()
    });
    return await this.queueEvent(event, subjectId);
  }

  private async queueRunEndedEvent(
    baseEvent: RunEndedWebhookEventDraft,
    subjectId: string,
    options: QueueEventOptions = {}
  ): Promise<boolean> {
    const subjectState = await this.subjects.read(subjectId);
    const meaningHash = runEndedMeaningHash(baseEvent);
    if (subjectState?.payloadHash === meaningHash) {
      return false;
    }
    const stateEntry = subjectState?.eventId ? await this.outbox.read(subjectState.eventId) : undefined;
    const stateEntryPending = Boolean(stateEntry && !stateEntry.deliveredAt && stateEntry.deliveryState !== "delivered");
    const version = stateEntryPending
      ? Math.max(1, subjectState?.version ?? 1)
      : subjectState?.deliveredAt
        ? Math.max(1, (subjectState.version ?? 0) + 1)
        : Math.max(1, subjectState?.version ?? 1);
    const eventId = stateEntryPending && subjectState?.eventId
      ? subjectState.eventId
      : eventIdFor("run.ended", `${subjectId}|v${version}`);
    const event: RunEndedWebhookEventV1 = {
      ...baseEvent,
      eventId,
      version
    };
    const queued = await this.queueEvent(event, subjectId, options);
    if (!queued) {
      return false;
    }
    const now = new Date(this.now()).toISOString();
    await this.subjects.write({
      schemaVersion: 1,
      subjectId,
      eventType: "run.ended",
      payloadHash: meaningHash,
      eventId: event.eventId,
      version,
      deliveredAt: subjectState?.deliveredAt,
      filesChangedCount: subjectState?.filesChangedCount,
      updatedAt: now
    });
    return true;
  }

  private async queueEvent(
    event: WebhookEventV1,
    subjectId: string,
    options: QueueEventOptions = {}
  ): Promise<boolean> {
    const configuration = this.configuration.readStored();
    if (isRunWebhookEventType(event.eventType) && configuration.runEndedEnabled === false) {
      this.recordQueueLifecycle(event, subjectId, "blocked", "webhook_run_events_disabled");
      return false;
    }
    const privacy = this.privacy.validatePublication(event);
    if (!privacy.ok) {
      this.recordQueueLifecycle(
        event,
        subjectId,
        "blocked",
        "webhook_privacy_validation_failed",
        webhookValidationFailureDetails(event, privacy.violations)
      );
      return false;
    }
    const now = new Date(this.now()).toISOString();
    const payloadHash = contentHash(event);
    const subjectState = event.eventType === "run.ended"
      ? await this.subjects.read(subjectId)
      : undefined;
    const existing = await this.outbox.read(event.eventId);
    if (existing?.payloadHash === payloadHash) {
      return false;
    }
    if (event.eventType === "run.start" && await this.runEndedDeliveredForLifecycleSubject(event.eventType, subjectId)) {
      this.recordQueueLifecycle(event, subjectId, "suppressed", "run_start_after_run_ended_suppressed");
      return false;
    }
    if (event.eventType === "run.update" && await this.runEndedDeliveredForLifecycleSubject(event.eventType, subjectId)) {
      this.recordQueueLifecycle(event, subjectId, "suppressed", "run_update_after_run_ended_suppressed");
      return false;
    }
    if (existing?.deliveredAt && event.eventType === "run.start") {
      return false;
    }
    const newFilesLen = event.eventType === "run.ended"
      ? ((event as RunEndedWebhookEventV1).filesChanged ?? []).length
      : -1;
    if (
      event.eventType === "run.ended"
      && subjectState?.deliveredAt
      && (subjectState.filesChangedCount ?? 0) === 0
      && newFilesLen > 0
      && !options.allowFilesChangedAfterReadOnly
    ) {
      this.recordQueueLifecycle(event, subjectId, "blocked", "webhook_run_delivered_read_only_files_changed_without_write_activity");
      return false;
    }
    // Once a run.ended event has been delivered, only re-deliver if filesChanged improved.
    // This prevents spurious re-deliveries caused by advancing endedAt in each OTel batch.
    if (existing?.deliveredAt && event.eventType === "run.ended") {
      const existingLen = ((existing.event as RunEndedWebhookEventV1).filesChanged ?? []).length;
      if (newFilesLen <= existingLen) {
        return false;
      }
    }
    // For run.ended events with no file changes yet, hold delivery until either:
    // (a) a replacement arrives with filesChanged populated, or
    // (b) the grace window expires, at which point we deliver with filesChanged=[].
    // This prevents a premature empty-filesChanged delivery racing ahead of async file writes.
    const terminalQuiescenceAt = event.eventType === "run.ended"
      ? this.runEndedLiveQuiescenceAttemptAt(event, subjectId)
      : undefined;
    const nextAttemptAt = configuration.url
      ? (event.eventType === "run.ended"
          ? latestIsoOptional([
              existing?.nextAttemptAt,
              terminalQuiescenceAt,
              newFilesLen === 0 ? new Date(this.now() + RUN_ENDED_GRACE_MS).toISOString() : undefined
            ])
          : event.eventType === "commit.attributed"
            // Hold commit.attributed until the grace window expires so that all episode
            // claims (which fire in rapid succession) settle before the first delivery.
            ? (existing?.nextAttemptAt ?? new Date(this.now() + COMMIT_ATTRIBUTED_GRACE_MS).toISOString())
            : undefined)
      : existing?.nextAttemptAt;
    const entry: WebhookOutboxEntry = {
      schemaVersion: 1,
      key: event.eventId,
      event,
      eventType: event.eventType,
      subjectId,
      payloadHash,
      deliveryState: configuration.url ? "pending" : "blocked",
      attempts: existing?.attempts ?? 0,
      queuedAt: existing?.queuedAt ?? now,
      firstAttemptAt: existing?.firstAttemptAt,
      lastAttemptAt: existing?.lastAttemptAt,
      deliveredAt: existing?.deliveredAt,
      nextAttemptAt,
      lastErrorCode: configuration.url ? undefined : "webhook_url_missing",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.outbox.upsert(entry);
    this.recordQueueLifecycle(
      event,
      subjectId,
      entry.deliveryState,
      entry.deliveryState === "blocked" ? "webhook_event_blocked_missing_url" : "webhook_event_queued"
    );
    return true;
  }

  private async projectRunLifecycleEvents(run: ProductionRunV1): Promise<RunLifecycleProjection | undefined> {
    const binding = await this.bindRunToRepository(run);
    if (!binding || !run.endedAt) {
      return undefined;
    }
    // Codex sends multiple session_task.turn traces per `codex exec` invocation, each
    // building its own ProductionRunV1 with a unique runId and sessionId. The episode
    // tracker groups all runs from the same exec under one episodeId. Use that as the
    // outbox discriminator and aggregate the episode's usage so the single webhook
    // event remains economically accurate.
    const episodes = await this.attribution.listWorkEpisodes();
    return await this.projectRunLifecycleEventsFromBinding(run, binding, episodes);
  }

  private async projectRunLifecycleEventsFromBinding(
    run: ProductionRunV1,
    binding: {
      repository: WebhookRepositoryV1;
      artifactKeys: string[];
      artifactScope?: "explicit";
    },
    episodes: AgenticWorkEpisode[]
  ): Promise<RunLifecycleProjection | undefined> {
    if (!run.endedAt) {
      return undefined;
    }
    const episode = run.provider === "codex"
      ? episodes.find((ep) => ep.runIds.includes(run.runId))
      : undefined;
    const webhookRunId = await this.lifecycleSubjectRunIdFor(run, episode);
    const aggregateEpisode = Boolean(episode && this.shouldAggregateEpisodeLifecycle(episode, webhookRunId));
    const episodeRuns = aggregateEpisode && episode
      ? await this.runsForLifecycleSubject(episode, run, webhookRunId)
      : [run];
    const projectedRun = aggregateEpisode ? aggregateWebhookRun(run, episodeRuns) : run;
    const atomsByQuery = groupAtomsByQuery(await this.safeUsageAtoms());
    const traceIds = uniqueStrings(episodeRuns.flatMap((candidate) => traceIdsForRun(candidate, atomsByQuery)));
    const llmModels = uniqueStrings(projectedRun.models ?? (projectedRun.model ? [projectedRun.model] : []));
    const sessionId = episode?.chatSessionId ?? sessionIdForRun(projectedRun);
    const endedAt = projectedRun.endedAt ?? run.endedAt;
    const artifactKeys = binding.artifactScope === "explicit"
      ? binding.artifactKeys
      : await this.artifactKeysForLifecycleSubject(
          episode,
          binding.repository.repoKey,
          run,
          webhookRunId,
          aggregateEpisode,
          binding.artifactKeys
        );
    const filesChanged = await this.filesChangedFor(binding.repository.repoKey, artifactKeys);
    const evidence = evidenceForRun(projectedRun, "prompt_hook");
    const traceIdsForWebhook = traceIds.length > 0 ? traceIds : [`trace_${webhookRunId}`];
    const sender = this.webhookSender();
    const activity = activityForRun(projectedRun, endedAt, evidence);
    const activityCoverage = activityCoverageForRun(projectedRun, activity);
    const startedAt = this.liveRunStarts.get(webhookRunId) ?? this.liveRunStarts.get(run.runId) ?? projectedRun.startedAt;
    const updatedAt = updatedAtForLifecycle(startedAt, endedAt);
    const started: RunStartedWebhookEventV1 = {
      schemaVersion: 1,
      eventType: "run.start",
      eventId: eventIdFor("run.start", webhookRunId),
      runId: webhookRunId,
      sessionId,
      traceIds: traceIdsForWebhook,
      sender,
      repository: binding.repository,
      codingHarness: projectedRun.provider,
      runtime: projectedRun.runtime,
      startedAt,
      evidence,
      coverage: webhookCoverage("none", "none", projectedRun.costCoverage),
      sequence: 1,
      updatedAt: startedAt,
      state: "running",
      llmModels
    };
    const updated: RunUpdatedWebhookEventV1 = {
      schemaVersion: 1,
      eventType: "run.update",
      eventId: eventIdFor("run.update", webhookRunId),
      runId: webhookRunId,
      sessionId,
      traceIds: traceIdsForWebhook,
      sender,
      repository: binding.repository,
      codingHarness: projectedRun.provider,
      runtime: projectedRun.runtime,
      startedAt,
      evidence: activity[0]?.evidence ?? evidence,
      coverage: webhookCoverage(usageCoverageForUpdate(projectedRun), activityCoverage, projectedRun.costCoverage),
      sequence: 2,
      updatedAt,
      state: "settling",
      inputTokens: projectedRun.inputTokens,
      outputTokens: projectedRun.outputTokens,
      cacheReadInputTokens: projectedRun.cacheReadInputTokens,
      cacheCreationInputTokens: projectedRun.cacheCreationInputTokens,
      reasoningOutputTokens: projectedRun.reasoningOutputTokens,
      totalTokens: projectedRun.totalTokens,
      llmModels,
      estimatedNanoUsd: projectedRun.estimatedNanoUsd ?? 0,
      ...usageValueForWebhook(projectedRun),
      costEstimateBasis: normalizeCostEstimateBasis(projectedRun.costEstimateBasis),
      costCoverage: projectedRun.costCoverage,
      ...contextFootprintForWebhook(projectedRun.context, "complete_so_far"),
      activity
    };
    const ended: RunEndedWebhookEventV1 = {
      schemaVersion: 1,
      eventType: "run.ended",
      eventId: eventIdFor("run.ended", webhookRunId),
      runId: webhookRunId,
      sessionId,
      traceIds: traceIdsForWebhook,
      sender,
      repository: binding.repository,
      codingHarness: projectedRun.provider,
      runtime: projectedRun.runtime,
      startedAt,
      evidence: evidenceForRun(projectedRun, "stop_hook"),
      coverage: webhookCoverage("final", activityCoverage, projectedRun.costCoverage),
      endedAt,
      inputTokens: projectedRun.inputTokens,
      outputTokens: projectedRun.outputTokens,
      cacheReadInputTokens: projectedRun.cacheReadInputTokens,
      cacheCreationInputTokens: projectedRun.cacheCreationInputTokens,
      reasoningOutputTokens: projectedRun.reasoningOutputTokens,
      totalTokens: projectedRun.totalTokens,
      llmModels,
      filesChanged,
      estimatedNanoUsd: projectedRun.estimatedNanoUsd ?? 0,
      ...usageValueForWebhook(projectedRun),
      costEstimateBasis: normalizeCostEstimateBasis(projectedRun.costEstimateBasis),
      costCoverage: projectedRun.costCoverage,
      ...contextFootprintForWebhook(projectedRun.context, "final"),
      state: "completed"
    };
    const endedPrivacy = this.privacy.validatePublication(ended);
    if (!endedPrivacy.ok) {
      this.recordQueueLifecycle(
        ended,
        `run.ended:${webhookRunId}`,
        "blocked",
        "webhook_privacy_validation_failed",
        webhookValidationFailureDetails(ended, endedPrivacy.violations)
      );
      return undefined;
    }
    return {
      subjectRunId: webhookRunId,
      started,
      updated,
      ended,
      allowFilesChangedAfterReadOnly: hasWriteCapableActivity(activity)
    };
  }

  private shouldAggregateEpisodeLifecycle(episode: AgenticWorkEpisode, webhookRunId: string): boolean {
    return webhookRunId === episode.episodeId
      || episode.queryIds.some((queryId) => this.liveQuerySubjects.get(queryId) === webhookRunId);
  }

  private async artifactKeysForLifecycleSubject(
    episode: AgenticWorkEpisode | undefined,
    repoKey: string,
    run: ProductionRunV1,
    webhookRunId: string,
    aggregateEpisode: boolean,
    fallbackArtifactKeys: string[]
  ): Promise<string[]> {
    if (!episode) {
      return fallbackArtifactKeys;
    }
    if (!aggregateEpisode) {
      return artifactKeysForRun([episode], repoKey, run);
    }
    const scope = await this.lifecycleEvidenceScope(episode, run, webhookRunId);
    return artifactKeysForEvidenceScope(episode, repoKey, scope.queryIds, scope.runIds);
  }

  private async lifecycleEvidenceScope(
    episode: AgenticWorkEpisode,
    run: ProductionRunV1,
    webhookRunId: string
  ): Promise<{ queryIds: string[]; runIds: string[] }> {
    const liveSubject = this.liveRunSubjects.get(webhookRunId);
    if (liveSubject) {
      return evidenceScopeForQueryIds(episode, liveSubject.queryIds, run);
    }

    const outboxQueryIds = await this.lifecycleSubjectTraceQueryIds(episode, webhookRunId);
    if (outboxQueryIds.length > 0) {
      return evidenceScopeForQueryIds(episode, outboxQueryIds, run);
    }

    if (webhookRunId === episode.episodeId) {
      return {
        queryIds: uniqueStrings(episode.queryIds),
        runIds: uniqueStrings(episode.runIds)
      };
    }

    const queryIds = episode.queryIds.filter((queryId) => runIdForQuery(queryId) === webhookRunId);
    if (queryIds.length > 0) {
      return evidenceScopeForQueryIds(episode, queryIds, run);
    }

    return evidenceScopeForQueryIds(episode, [run.queryId ?? run.correlationId], run);
  }

  private async lifecycleSubjectTraceQueryIds(episode: AgenticWorkEpisode, webhookRunId: string): Promise<string[]> {
    const episodeQueryIds = new Set(episode.queryIds);
    const queryIds = new Set<string>();
    for (const entry of await this.outbox.list()) {
      const lifecycle = lifecycleSortKey(entry);
      if (!lifecycle || lifecycle.runSubject !== webhookRunId) {
        continue;
      }
      const event = entry.event;
      if (event.eventType !== "run.start" && event.eventType !== "run.update" && event.eventType !== "run.ended") {
        continue;
      }
      for (const traceId of event.traceIds) {
        if (episodeQueryIds.has(traceId)) {
          queryIds.add(traceId);
        }
      }
    }
    return [...queryIds].sort();
  }

  private async lifecycleSubjectRunIdFor(
    run: ProductionRunV1,
    episode: AgenticWorkEpisode | undefined
  ): Promise<string> {
    const liveSubjectRunId = await this.lifecycleSubjectRunIdFromRunTrace(run);
    if (!episode) {
      return liveSubjectRunId ?? run.runId;
    }
    const fallbackSubjectRunId = episode.runIds.length <= 1 ? run.runId : episode.episodeId;
    const subjectRunId = liveSubjectRunId
      ?? await this.lifecycleSubjectRunIdFromLiveEpisode(episode)
      ?? fallbackSubjectRunId;
    const terminalState = await this.subjects.read(`run.ended:${subjectRunId}`);
    const terminal = await this.runEndedForSubject(subjectRunId);
    if (!terminal) {
      const priorTerminal = await this.latestRunEndedForEpisodeSubjects(episode);
      if (priorTerminal && runStartsAfterTerminal(run, priorTerminal)) {
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "ExternalWebhookDispatch",
          operation: "projection",
          state: "fallback",
          reason: "codex_episode_terminal_subject_rotated_for_later_run",
          runId: run.runId,
          queryId: run.queryId ?? run.correlationId,
          sessionId: run.sessionId,
          episodeId: episode.episodeId,
          details: {
            terminalRunId: priorTerminal.runId,
            terminalEndedAt: priorTerminal.endedAt,
            nextSubjectId: run.runId
          }
        });
        return run.runId;
      }
      return subjectRunId;
    }
    const terminalSeparatesRun = terminalState?.deliveredAt
      ? runFallsAfterDeliveredTerminal(run, terminal)
      : runStartsAfterTerminal(run, terminal);
    if (!terminalSeparatesRun) {
      return subjectRunId;
    }
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ExternalWebhookDispatch",
      operation: "projection",
      state: "fallback",
      reason: "codex_episode_terminal_subject_rotated_for_later_run",
      runId: run.runId,
      queryId: run.queryId ?? run.correlationId,
      sessionId: run.sessionId,
      episodeId: episode.episodeId,
      details: {
        terminalRunId: terminal.runId,
        terminalEndedAt: terminal.endedAt,
        nextSubjectId: run.runId
      }
    });
    return run.runId;
  }

  private async lifecycleSubjectRunIdFromRunTrace(run: ProductionRunV1): Promise<string | undefined> {
    if (run.provider !== "codex") {
      return undefined;
    }
    const queryId = run.queryId ?? run.correlationId;
    const liveSubject = this.liveQuerySubjects.get(queryId);
    if (liveSubject) {
      return liveSubject;
    }
    const subjects = new Set<string>();
    for (const entry of await this.outbox.list()) {
      const lifecycle = lifecycleSortKey(entry);
      if (!lifecycle || (entry.eventType !== "run.start" && entry.eventType !== "run.update")) {
        continue;
      }
      const event = entry.event;
      if (
        (event.eventType === "run.start" || event.eventType === "run.update")
        && event.codingHarness === "codex"
        && event.traceIds.includes(queryId)
      ) {
        subjects.add(lifecycle.runSubject);
      }
    }
    return [...subjects].sort()[0];
  }

  private async deliveredRunEndedForEpisodeSubjects(episode: AgenticWorkEpisode): Promise<RunEndedWebhookEventV1 | undefined> {
    const terminals = await this.listRunEndedForEpisodeSubjects(episode, true);
    return terminals[0];
  }

  private async latestRunEndedForEpisodeSubjects(episode: AgenticWorkEpisode): Promise<RunEndedWebhookEventV1 | undefined> {
    const terminals = await this.listRunEndedForEpisodeSubjects(episode, false);
    return terminals[0];
  }

  private async listRunEndedForEpisodeSubjects(
    episode: AgenticWorkEpisode,
    deliveredOnly: boolean
  ): Promise<RunEndedWebhookEventV1[]> {
    const subjects = uniqueStrings([
      episode.episodeId,
      ...episode.runIds,
      ...episode.queryIds.map(runIdForQuery)
    ]);
    const terminals = (await Promise.all(subjects.map((subject) =>
      deliveredOnly ? this.deliveredRunEndedForSubject(subject) : this.runEndedForSubject(subject)
    )))
      .filter((event): event is RunEndedWebhookEventV1 => Boolean(event))
      .sort((left, right) => right.endedAt.localeCompare(left.endedAt));
    return terminals;
  }

  private async lifecycleSubjectRunIdFromLiveEpisode(episode: AgenticWorkEpisode): Promise<string | undefined> {
    for (const queryId of episode.queryIds) {
      const subjectRunId = this.liveQuerySubjects.get(queryId);
      if (subjectRunId) {
        return subjectRunId;
      }
    }
    const subjects = new Set<string>();
    for (const entry of await this.outbox.list()) {
      const lifecycle = lifecycleSortKey(entry);
      if (!lifecycle || (entry.eventType !== "run.start" && entry.eventType !== "run.update")) {
        continue;
      }
      const event = entry.event;
      if (event.eventType !== "run.start" && event.eventType !== "run.update") {
        continue;
      }
      if (
        event.codingHarness === "codex"
        && (
          (episode.chatSessionId != null && event.sessionId === episode.chatSessionId)
          || episode.queryIds.some((queryId) => event.traceIds.includes(queryId))
          || episode.runIds.includes(event.runId)
        )
      ) {
        subjects.add(lifecycle.runSubject);
      }
    }
    return [...subjects].sort()[0];
  }

  private async filesChangedFor(repoKey: string, artifactKeys: string[]): Promise<string[]> {
    let projectedPaths = this.repositories.relativePaths(repoKey, artifactKeys);
    if (projectedPaths.length === 0 && artifactKeys.length > 0) {
      await this.repositories.refresh();
      projectedPaths = this.repositories.relativePaths(repoKey, artifactKeys);
    }
    const filesChanged = safeRepoRelativePaths(projectedPaths);
    if (projectedPaths.length > filesChanged.length && filesChanged.length > 0) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "warning",
        reason: "webhook_changed_file_path_dropped",
        repoKey,
        details: {
          projectedPathCount: projectedPaths.length,
          acceptedPathCount: filesChanged.length,
          droppedPathCount: projectedPaths.length - filesChanged.length
        }
      });
    }
    return filesChanged.length > 0 || projectedPaths.length === 0
      ? filesChanged
      : projectedPaths;
  }

  private async runsForLifecycleSubject(
    episode: AgenticWorkEpisode,
    currentRun: ProductionRunV1,
    webhookRunId: string
  ): Promise<ProductionRunV1[]> {
    const scope = await this.lifecycleEvidenceScope(episode, currentRun, webhookRunId);
    const queryIds = new Set(scope.queryIds);
    const runIds = new Set(scope.runIds);
    const runsById = new Map((await this.productionRuns()).map((candidate) => [candidate.runId, candidate]));
    runsById.set(currentRun.runId, currentRun);
    const runs = uniqueStrings(episode.runIds)
      .map((runId) => runsById.get(runId))
      .filter((candidate): candidate is ProductionRunV1 => {
        if (!candidate?.endedAt) {
          return false;
        }
        return runIds.has(candidate.runId)
          || queryIds.has(candidate.queryId ?? candidate.correlationId);
      });
    return runs.length > 0 ? runs : [currentRun];
  }

  private async bindRunToRepository(run: ProductionRunV1): Promise<{
    repository: WebhookRepositoryV1;
    artifactKeys: string[];
  } | undefined> {
    const queryId = run.queryId ?? run.correlationId;
    const episodes = await this.attribution.listWorkEpisodes();
    const episode = episodes.find((candidate) =>
      candidate.runIds.includes(run.runId) || candidate.queryIds.includes(queryId));
    if (!episode) {
      const liveBinding = this.bindCompletedRunToLiveRepository(run);
      if (liveBinding) {
        return liveBinding;
      }
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "blocked",
        reason: "run_webhook_repository_binding_missing",
        runId: run.runId,
        queryId
      });
      return undefined;
    }
    const queryEvidenceRepoKeys = uniqueStrings(
      episode.evidence
        .filter((item) => item.queryId === queryId)
        .map((item) => item.repoKey)
    );
    const repoKeys = queryEvidenceRepoKeys.length > 0
      ? queryEvidenceRepoKeys
      : uniqueStrings(episode.repoKeys ?? []);
    if (repoKeys.length !== 1) {
      if (repoKeys.length === 0) {
        const liveBinding = this.bindCompletedRunToLiveRepository(run);
        if (liveBinding) {
          return liveBinding;
        }
      }
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "blocked",
        reason: repoKeys.length === 0
          ? "run_webhook_repository_binding_missing"
          : "run_webhook_repository_binding_ambiguous",
        runId: run.runId,
        queryId,
        details: {
          repoCount: repoKeys.length
        }
      });
      return undefined;
    }
    return {
      repository: await this.describeRepository(repoKeys[0]),
      artifactKeys: artifactKeysForRun([episode], repoKeys[0], run)
    };
  }

  private bindCompletedRunToLiveRepository(run: ProductionRunV1): {
    repository: WebhookRepositoryV1;
    artifactKeys: string[];
  } | undefined {
    const queryId = run.queryId ?? run.correlationId;
    const subjectRunId = this.liveQuerySubjects.get(queryId) ?? run.runId;
    const repository = this.liveRunRepositories.get(subjectRunId);
    if (!repository) {
      return undefined;
    }
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ExternalWebhookDispatch",
      operation: "projection",
      state: "fallback",
      reason: "run_webhook_repository_bound_from_live_start",
      runId: run.runId,
      queryId,
      repoKey: repository.repoKey
    });
    return {
      repository,
      artifactKeys: []
    };
  }

  private async bindLiveObservationToRepository(observation: SafeObservationV1): Promise<WebhookRepositoryV1 | undefined> {
    const repositories = await this.repositories.listRepositories();
    if (repositories.length !== 1) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "blocked",
        reason: repositories.length === 0
          ? "run_lifecycle_repository_binding_missing"
          : "run_lifecycle_repository_binding_ambiguous",
        details: {
          provider: observation.provider,
          sourceId: observation.sourceId,
          repositoryCount: repositories.length
        }
      });
      return undefined;
    }
    return await this.describeRepository(repositories[0].repoKey, repositories[0].root);
  }

  private async describeRepository(repoKey: string, repositoryRoot?: string): Promise<WebhookRepositoryV1> {
    const identity = await this.repositories.resolveGitHubRepository(repoKey);
    if (identity) {
      return {
        repoKey,
        owner: identity.owner,
        name: identity.repository,
        fullName: `${identity.owner}/${identity.repository}`
      };
    }
    const repository = repositoryRoot
      ? { root: repositoryRoot }
      : (await this.repositories.listRepositories()).find((candidate) => candidate.repoKey === repoKey);
    const name = repository ? basename(repository.root) || "repository" : "repository";
    return {
      repoKey,
      owner: "local",
      name,
      fullName: `local/${name}`
    };
  }

  private scheduleRetry(): void {
    if (!this.running) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      void this.processDueEntries()
        .catch(() => undefined)
        .finally(() => this.scheduleRetry());
    }, RETRY_INTERVAL_MS);
    this.retryTimer.unref?.();
  }

  private async processDueEntries(force = false): Promise<void> {
    if (this.deliveryRunning) {
      this.deliveryRerunRequested = true;
      this.deliveryRerunForce = this.deliveryRerunForce || force;
      return;
    }
    this.deliveryRunning = true;
    try {
      let currentForce = force;
      do {
        this.deliveryRerunRequested = false;
        currentForce = currentForce || this.deliveryRerunForce;
        this.deliveryRerunForce = false;
        const entries = await this.outbox.list();
        for (const entry of entries) {
          if (
            (entry.deliveryState === "pending" && (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= this.now()))
            || (entry.deliveryState === "retry" && (currentForce || !entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= this.now()))
            || (currentForce && entry.deliveryState === "blocked")
          ) {
            await this.deliver(entry);
          }
        }
        currentForce = false;
      } while (this.deliveryRerunRequested);
    } finally {
      this.deliveryRunning = false;
    }
  }

  private async deliver(entry: WebhookOutboxEntry): Promise<void> {
    const configuration = this.configuration.readStored();
    if (
      (entry.eventType === "run.start" || entry.eventType === "run.update")
      && await this.runEndedDeliveredForLifecycleSubject(entry.eventType, entry.subjectId)
    ) {
      const suppressedAt = new Date(this.now()).toISOString();
      await this.outbox.upsert({
        ...entry,
        deliveryState: "delivered",
        deliveredAt: entry.deliveredAt ?? suppressedAt,
        nextAttemptAt: undefined,
        lastErrorCode: undefined,
        updatedAt: suppressedAt
      });
      this.recordDeliveryLifecycle(
        entry,
        "suppressed",
        entry.eventType === "run.start"
          ? "run_start_after_run_ended_suppressed"
          : "run_update_after_run_ended_suppressed"
      );
      return;
    }
    const familyEnabled = isRunWebhookEventType(entry.eventType)
      ? configuration.runEndedEnabled !== false
      : true;
    if (!configuration.url) {
      await this.outbox.upsert(blockedEntry(entry, "webhook_url_missing", this.now()));
      this.recordDeliveryLifecycle(entry, "blocked", "webhook_delivery_blocked_missing_url");
      return;
    }
    if (!familyEnabled) {
      await this.outbox.upsert(blockedEntry(entry, "event_family_disabled", this.now()));
      this.recordDeliveryLifecycle(entry, "blocked", "webhook_delivery_blocked_family_disabled");
      return;
    }
    if (!this.privacy.validatePublication(entry.event).ok) {
      await this.outbox.upsert(blockedEntry(entry, "privacy_violation", this.now()));
      this.recordDeliveryLifecycle(entry, "blocked", "webhook_delivery_blocked_privacy_violation");
      return;
    }
    if (entry.event.eventType === "run.ended") {
      const quiescenceAt = this.runEndedLiveQuiescenceAttemptAt(entry.event, entry.subjectId);
      if (quiescenceAt && Date.parse(quiescenceAt) > this.now()) {
        await this.outbox.upsert({
          ...entry,
          deliveryState: "pending",
          nextAttemptAt: quiescenceAt,
          updatedAt: new Date(this.now()).toISOString()
        });
        this.recordDeliveryLifecycle(entry, "pending", "run_ended_waiting_for_live_quiescence", {
          nextAttemptAt: quiescenceAt
        });
        return;
      }
    }
    const attemptAt = new Date(this.now()).toISOString();
    const attempting: WebhookOutboxEntry = {
      ...entry,
      firstAttemptAt: entry.firstAttemptAt ?? attemptAt,
      lastAttemptAt: attemptAt,
      updatedAt: attemptAt
    };
    await this.outbox.upsert(attempting);
    this.recordDeliveryLifecycle(entry, "attempt_started", "webhook_delivery_attempt_started");
    try {
      const result = await postWebhook(configuration, entry.event, attemptAt);
      const deliveredAt = new Date(this.now()).toISOString();
      const delivered: WebhookOutboxEntry = {
        ...attempting,
        deliveryState: "delivered",
        deliveredAt,
        nextAttemptAt: undefined,
        lastErrorCode: undefined,
        updatedAt: deliveredAt
      };
      await this.outbox.upsert(delivered);
      await this.recordDeliveredSubject(delivered, deliveredAt);
      this.recordDeliveryLifecycle(entry, "delivered", "webhook_delivery_succeeded", {
        statusCode: result.statusCode
      });
    } catch (error) {
      const failure = asWebhookFailure(error);
      const attempts = attempting.attempts + 1;
      const updatedAt = new Date(this.now()).toISOString();
      const nextAttemptAt = failure.retryable
        ? new Date(this.now() + retryDelayMs(attempts)).toISOString()
        : undefined;
      const next: WebhookOutboxEntry = {
        ...attempting,
        deliveryState: failure.retryable ? "retry" : "blocked",
        attempts,
        nextAttemptAt,
        lastErrorCode: failure.code,
        updatedAt
      };
      await this.outbox.upsert(next);
      this.recordDeliveryLifecycle(
        entry,
        failure.retryable ? "retry_scheduled" : "blocked",
        failure.retryable ? "webhook_delivery_retry_scheduled" : "webhook_delivery_blocked",
        {
          attempts,
          lastErrorCode: failure.code,
          nextAttemptAt: nextAttemptAt ?? null
        }
      );
    }
  }

  private async productionRuns(): Promise<ProductionRunV1[]> {
    return await this.outbox.storage.listProductionRuns();
  }

  private async recordDeliveredSubject(entry: WebhookOutboxEntry, deliveredAt: string): Promise<void> {
    if (entry.event.eventType !== "run.ended") {
      return;
    }
    const event = entry.event;
    await this.recordRunEndedSubject(entry.subjectId, entry, event, deliveredAt);
    const publicSubjectId = `run.ended:${event.runId}`;
    if (publicSubjectId !== entry.subjectId) {
      await this.recordRunEndedSubject(publicSubjectId, entry, event, deliveredAt);
    }
  }

  private async recordRunEndedSubject(
    subjectId: string,
    entry: WebhookOutboxEntry,
    event: RunEndedWebhookEventV1,
    deliveredAt: string
  ): Promise<void> {
    const existing = await this.subjects.read(subjectId);
    await this.subjects.write({
      schemaVersion: 1,
      subjectId,
      eventType: entry.eventType,
      payloadHash: existing?.payloadHash ?? runEndedMeaningHash(event),
      eventId: event.eventId,
      version: event.version ?? existing?.version,
      deliveredAt,
      filesChangedCount: (event.filesChanged ?? []).length,
      updatedAt: deliveredAt
    });
  }

  private async runEndedDeliveredForLifecycleSubject(
    eventType: "run.start" | "run.update",
    subjectId: string
  ): Promise<boolean> {
    const runSubject = runSubjectFromLifecycleSubject(eventType, subjectId);
    if (!runSubject) {
      return false;
    }
    const terminal = await this.subjects.read(`run.ended:${runSubject}`);
    return Boolean(terminal?.deliveredAt);
  }

  private async deliveredRunEndedForSubject(runSubject: string): Promise<RunEndedWebhookEventV1 | undefined> {
    const terminal = await this.subjects.read(`run.ended:${runSubject}`);
    if (!terminal?.deliveredAt) {
      return undefined;
    }
    const entry = await this.outbox.read(terminal.eventId);
    return entry?.event.eventType === "run.ended" ? entry.event : undefined;
  }

  private async runEndedForSubject(runSubject: string): Promise<RunEndedWebhookEventV1 | undefined> {
    const terminal = await this.subjects.read(`run.ended:${runSubject}`);
    if (!terminal?.eventId) {
      return undefined;
    }
    const entry = await this.outbox.read(terminal.eventId);
    return entry?.event.eventType === "run.ended" ? entry.event : undefined;
  }

  private runEndedLiveQuiescenceAttemptAt(event: RunEndedWebhookEventV1, subjectId: string): string | undefined {
    const runSubject = runSubjectFromLifecycleSubject("run.ended", subjectId);
    const subject = runSubject ? this.liveRunSubjects.get(runSubject) : undefined;
    if (!subject) {
      return undefined;
    }
    const lastObservedMs = Date.parse(subject.lastObservedAt);
    const endedMs = Date.parse(event.endedAt);
    if (!Number.isFinite(lastObservedMs) || !Number.isFinite(endedMs)) {
      return undefined;
    }
    if (lastObservedMs <= endedMs && this.now() - lastObservedMs >= RUN_ENDED_GRACE_MS) {
      return undefined;
    }
    return new Date(Math.max(lastObservedMs + RUN_ENDED_GRACE_MS, this.now())).toISOString();
  }

  private async safeUsageAtoms(): Promise<SafeUsageAtomV1[]> {
    return await this.outbox.storage.listSafeUsageAtoms();
  }

  private mergeLiveRunUpdate(event: RunUpdatedWebhookEventV1): RunUpdatedWebhookEventV1 {
    const previous = this.liveRunUpdates.get(event.runId);
    const merged = previous ? mergeRunUpdatedWebhookEvents(previous, event) : event;
    const versioned = {
      ...merged,
      eventId: liveRunUpdateEventId(merged)
    };
    this.liveRunUpdates.set(event.runId, versioned);
    return versioned;
  }

  private webhookSender(): WebhookSenderV1 {
    return {
      installationId: this.installationId,
      ...this.configuration.readStored().sender
    };
  }

  private recordQueueLifecycle(
    event: WebhookEventV1,
    subjectId: string,
    state: string,
    reason: string,
    details: Record<string, string | number | boolean | null> = {}
  ): void {
    const identity = event.eventType === "commit.attributed"
      ? { commitHash: event.commitSha }
      : { runId: event.runId };
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ExternalWebhookDispatch",
      operation: "queue",
      state,
      reason,
      ...identity,
      details: {
        eventType: event.eventType,
        eventId: event.eventId,
        subjectId,
        ...details
      }
    });
  }

  private recordDeliveryLifecycle(
    entry: WebhookOutboxEntry,
    state: string,
    reason: string,
    details: Record<string, string | number | boolean | null> = {}
  ): void {
    const identity = entry.event.eventType === "commit.attributed"
      ? { commitHash: entry.event.commitSha }
      : { runId: entry.event.runId };
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ExternalWebhookDispatch",
      operation: "delivery",
      state,
      reason,
      ...identity,
      details: {
        eventType: entry.eventType,
        eventId: entry.event.eventId,
        subjectId: entry.subjectId,
        ...details
      }
    });
  }

  private async recordStatusChange(reason: string): Promise<void> {
    const status = await this.status();
    this.recordEvent({
      kind: "constructLifecycle",
      construct: "ExternalWebhookDispatch",
      operation: "status",
      state: "updated",
      reason,
      details: {
        queuedCount: status.queuedCount,
        blockedCount: status.blockedCount,
        deliveredCount: status.deliveredCount,
        runEndedEnabled: status.runEndedEnabled,
        commitAttributedEnabled: status.commitAttributedEnabled,
        urlConfigured: Boolean(status.url)
      }
    });
  }
}

class FileWebhookConfigurationStore {
  constructor(private readonly path: string) {}

  read(): AgentWebhookConfigurationV1 {
    const stored = this.readStored();
    return {
      schemaVersion: 1,
      url: stored.url,
      sender: stored.sender ?? {},
      runEndedEnabled: stored.runEndedEnabled !== false,
      commitAttributedEnabled: true,
      bearerTokenConfigured: typeof stored.bearerToken === "string" && stored.bearerToken !== "",
      hmacSecretConfigured: typeof stored.hmacSecret === "string" && stored.hmacSecret !== ""
    };
  }

  readStored(): StoredWebhookConfiguration {
    if (!existsSync(this.path)) {
      return { schemaVersion: 1, runEndedEnabled: true };
    }
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as StoredWebhookConfiguration;
      return {
        schemaVersion: 1,
        url: isWebhookUrl(value.url) ? value.url : undefined,
        bearerToken: typeof value.bearerToken === "string" && value.bearerToken.trim() !== "" ? value.bearerToken : undefined,
        hmacSecret: typeof value.hmacSecret === "string" && value.hmacSecret.trim() !== "" ? value.hmacSecret : undefined,
        sender: normalizeWebhookSenderProfile(value.sender),
        runEndedEnabled: value.runEndedEnabled !== false
      };
    } catch {
      return { schemaVersion: 1, runEndedEnabled: true };
    }
  }

  setUrl(input: WebhookUrlConfigurationV1): void {
    if (!isWebhookUrl(input.url)) {
      throw new Error("invalid_request");
    }
    const current = this.readStored();
    this.write({ ...current, url: input.url });
  }

  setBearerToken(input: WebhookBearerTokenConfigurationV1): void {
    if (typeof input.token !== "string" || input.token.trim() === "") {
      throw new Error("invalid_request");
    }
    const current = this.readStored();
    this.write({ ...current, bearerToken: input.token.trim() });
  }

  clearBearerToken(): void {
    const current = this.readStored();
    this.write({ ...current, bearerToken: undefined });
  }

  setHmacSecret(input: WebhookSecretConfigurationV1): void {
    if (typeof input.secret !== "string" || input.secret.trim() === "") {
      throw new Error("invalid_request");
    }
    const current = this.readStored();
    this.write({ ...current, hmacSecret: input.secret.trim() });
  }

  clearHmacSecret(): void {
    const current = this.readStored();
    this.write({ ...current, hmacSecret: undefined });
  }

  setSender(input: WebhookSenderConfigurationV1): void {
    const sender = normalizeWebhookSenderProfile(input.sender);
    if (!sender || Object.keys(sender).length === 0) {
      throw new Error("invalid_request");
    }
    const current = this.readStored();
    this.write({ ...current, sender });
  }

  clearSender(): void {
    const current = this.readStored();
    this.write({ ...current, sender: undefined });
  }

  setRunEndedEnabled(enabled: boolean): void {
    const current = this.readStored();
    this.write({ ...current, runEndedEnabled: enabled });
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }

  private write(next: StoredWebhookConfiguration): void {
    writePrivateFileAtomic(this.path, `${JSON.stringify({
      schemaVersion: 1,
      url: next.url,
      bearerToken: next.bearerToken,
      hmacSecret: next.hmacSecret,
      sender: next.sender,
      runEndedEnabled: next.runEndedEnabled !== false
    }, null, 2)}\n`);
  }
}

class SqliteWebhookOutbox {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly storage: AgentStorageClient,
    private readonly privacy: DefaultPrivacyGuard
  ) {}

  async list(): Promise<WebhookOutboxEntry[]> {
    return (await this.storage.listAgentDocuments<WebhookOutboxEntry>("webhook_outbox"))
      .map((document) => document.value)
      .sort(compareWebhookOutboxEntries);
  }

  async read(key: string): Promise<WebhookOutboxEntry | undefined> {
    return (await this.list()).find((entry) => entry.key === key);
  }

  async upsert(entry: WebhookOutboxEntry): Promise<void> {
    if (!this.privacy.validatePublication(entry.event).ok) {
      throw new Error("privacy_violation");
    }
    await this.enqueue(async () => {
      await this.storage.upsertAgentDocument("webhook_outbox", {
        key: entry.key,
        sortAt: entry.updatedAt,
        value: entry
      });
    });
  }

  async applyRetention(retentionDays: number): Promise<void> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return;
    }
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    await this.enqueue(async () => {
      const entries = await this.list();
      const retained = entries.filter((entry) =>
        entry.deliveryState !== "delivered" || Date.parse(entry.updatedAt) >= cutoff
      );
      await this.storage.replaceAgentDocuments("webhook_outbox", retained.map((entry) => ({
        key: entry.key,
        sortAt: entry.updatedAt,
        value: entry
      })));
    });
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      await this.storage.clearAgentDocuments("webhook_outbox");
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

class SqliteWebhookSubjectStateStore {
  constructor(private readonly storage: AgentStorageClient) {}

  async read(subjectId: string): Promise<WebhookSubjectState | undefined> {
    return (await this.storage.listAgentDocuments<WebhookSubjectState>("webhook_delivery_state"))
      .map((document) => document.value)
      .find((entry) => entry.subjectId === subjectId);
  }

  async list(): Promise<WebhookSubjectState[]> {
    return (await this.storage.listAgentDocuments<WebhookSubjectState>("webhook_delivery_state"))
      .map((document) => document.value);
  }

  async write(state: WebhookSubjectState): Promise<void> {
    await this.storage.upsertAgentDocument("webhook_delivery_state", {
      key: state.subjectId,
      sortAt: state.updatedAt,
      value: state
    });
  }

  async clear(): Promise<void> {
    await this.storage.clearAgentDocuments("webhook_delivery_state");
  }
}

function blockedEntry(
  entry: WebhookOutboxEntry,
  lastErrorCode: string,
  now: number
): WebhookOutboxEntry {
  return {
    ...entry,
    deliveryState: "blocked",
    lastErrorCode,
    nextAttemptAt: undefined,
    updatedAt: new Date(now).toISOString()
  };
}

function statusItemFromEntry(entry: WebhookOutboxEntry): AgentWebhookDeliveryItemV1 {
  return {
    schemaVersion: 1,
    eventId: entry.event.eventId,
    eventType: entry.eventType,
    subjectId: entry.subjectId,
    deliveryState: entry.deliveryState,
    attempts: entry.attempts,
    queuedAt: entry.queuedAt,
    firstAttemptAt: entry.firstAttemptAt,
    lastAttemptAt: entry.lastAttemptAt,
    deliveredAt: entry.deliveredAt,
    nextAttemptAt: entry.nextAttemptAt,
    lastErrorCode: entry.lastErrorCode,
    updatedAt: entry.updatedAt
  };
}

function compareWebhookOutboxEntries(left: WebhookOutboxEntry, right: WebhookOutboxEntry): number {
  const leftLifecycle = lifecycleSortKey(left);
  const rightLifecycle = lifecycleSortKey(right);
  if (leftLifecycle && rightLifecycle && leftLifecycle.runSubject === rightLifecycle.runSubject) {
    return leftLifecycle.order - rightLifecycle.order
      || left.updatedAt.localeCompare(right.updatedAt)
      || left.key.localeCompare(right.key);
  }
  const updatedAtOrder = left.updatedAt.localeCompare(right.updatedAt);
  if (updatedAtOrder !== 0) {
    return updatedAtOrder;
  }
  return left.key.localeCompare(right.key);
}

function lifecycleSortKey(entry: WebhookOutboxEntry): { runSubject: string; order: number } | undefined {
  if (entry.eventType === "run.start") {
    return { runSubject: entry.subjectId.slice("run.start:".length), order: 1 };
  }
  if (entry.eventType === "run.update") {
    return { runSubject: entry.subjectId.slice("run.update:".length), order: 2 };
  }
  if (entry.eventType === "run.ended") {
    return { runSubject: entry.subjectId.slice("run.ended:".length), order: 3 };
  }
  return undefined;
}

function runSubjectFromLifecycleSubject(
  eventType: "run.start" | "run.update" | "run.ended",
  subjectId: string
): string | undefined {
  const prefix = `${eventType}:`;
  return subjectId.startsWith(prefix) ? subjectId.slice(prefix.length) : undefined;
}

function runFallsAfterDeliveredTerminal(run: ProductionRunV1, terminal: RunEndedWebhookEventV1): boolean {
  if (terminal.runId === run.runId) {
    return false;
  }
  const terminalEndedAt = Date.parse(terminal.endedAt);
  if (!Number.isFinite(terminalEndedAt)) {
    return false;
  }
  const runStartedAt = Date.parse(run.startedAt);
  if (Number.isFinite(runStartedAt) && runStartedAt > terminalEndedAt) {
    return true;
  }
  const runEndedAt = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
  return Number.isFinite(runEndedAt) && runEndedAt > terminalEndedAt;
}

function runStartsAfterTerminal(run: ProductionRunV1, terminal: RunEndedWebhookEventV1): boolean {
  if (terminal.runId === run.runId) {
    return false;
  }
  const terminalEndedAt = Date.parse(terminal.endedAt);
  const runStartedAt = Date.parse(run.startedAt);
  return Number.isFinite(terminalEndedAt) && Number.isFinite(runStartedAt) && runStartedAt > terminalEndedAt;
}

function queueAgeMs(entry: Pick<WebhookOutboxEntry, "queuedAt">, now: number): number | undefined {
  const queuedAt = Date.parse(entry.queuedAt);
  return Number.isFinite(queuedAt) ? Math.max(0, now - queuedAt) : undefined;
}

function normalizeCostEstimateBasis(value?: CostEstimateBasis): CostEstimateBasis {
  return value ?? "unavailable";
}

function usageValueForWebhook(run: ProductionRunV1): { usageValueNanoUsd?: number } {
  return typeof run.usageValueNanoUsd === "number" ? { usageValueNanoUsd: run.usageValueNanoUsd } : {};
}

function isRunWebhookEventType(value: WebhookEventTypeV1): value is "run.start" | "run.update" | "run.ended" {
  return value === "run.start" || value === "run.update" || value === "run.ended";
}

function webhookEvidence(
  basis: WebhookEvidenceV1["basis"],
  sourceId: string,
  observedAt: string,
  delayed: boolean,
  profileVersion = "tirion-run-lifecycle-v1",
  confidence?: Pick<WebhookEvidenceV1, "identityConfidence" | "timingConfidence">
): WebhookEvidenceV1 {
  return {
    basis,
    sourceId,
    profileVersion,
    observedAt,
    delayed,
    identityConfidence: confidence?.identityConfidence ?? "high",
    timingConfidence: confidence?.timingConfidence ?? (delayed ? "medium" : "high")
  };
}

function evidenceForRun(run: ProductionRunV1, basis: WebhookEvidenceV1["basis"]): WebhookEvidenceV1 {
  const observedAt = basis === "stop_hook"
    ? (run.endedAt ?? run.startedAt)
    : run.startedAt;
  return webhookEvidence(
    basis,
    run.queryId ?? run.correlationId ?? run.runId,
    observedAt,
    false
  );
}

function webhookCoverage(
  usageCoverage: WebhookCoverageV1["usageCoverage"],
  activityCoverage: WebhookCoverageV1["activityCoverage"],
  costCoverage: WebhookCoverageV1["costCoverage"]
): WebhookCoverageV1 {
  return {
    usageCoverage,
    activityCoverage,
    costCoverage
  };
}

function contextFootprintForWebhook(
  context: RunContextFootprintV1 | undefined,
  coverage: RunContextFootprintV1["coverage"]
): { context: RunContextFootprintV1 } | {} {
  return context ? { context: { ...context, coverage } } : {};
}

function usageCoverageForUpdate(run: ProductionRunV1): WebhookCoverageV1["usageCoverage"] {
  return run.totalTokens > 0 ? "complete_so_far" : "none";
}

function activityCoverageForRun(
  run: ProductionRunV1,
  activity: RunLifecycleActivityWebhookV1[]
): WebhookCoverageV1["activityCoverage"] {
  if (activity.length === 0) {
    return "none";
  }
  return (run.breakdown?.length ?? 0) > 0 ? "complete_for_reported_surface" : "partial";
}

function updatedAtForLifecycle(startedAt: string, endedAt: string): string {
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) {
    return endedAt;
  }
  return new Date(Math.floor((startedMs + endedMs) / 2)).toISOString();
}

function activityForRun(
  run: ProductionRunV1,
  endedAt: string,
  runEvidence: WebhookEvidenceV1
): RunLifecycleActivityWebhookV1[] {
  const breakdown = (run.breakdown ?? []).filter((item) => item.kind !== "unallocated");
  if (breakdown.length === 0) {
    return [fallbackRunActivity(run, endedAt, runEvidence)];
  }
  return breakdown.map((item, index) => activityFromBreakdown(run, endedAt, item, index));
}

function fallbackRunActivity(
  run: ProductionRunV1,
  endedAt: string,
  evidence: WebhookEvidenceV1
): RunLifecycleActivityWebhookV1 {
  return {
    activityId: `activity_${contentHash({ runId: run.runId, kind: "llm_request" }).slice(0, 24)}`,
    kind: "llm_request",
    name: run.model ?? run.models?.[0] ?? "llm_request",
    outcome: "success",
    startedAt: run.startedAt,
    endedAt,
    durationMs: durationMs(run.startedAt, endedAt),
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadInputTokens: run.cacheReadInputTokens,
    cacheCreationInputTokens: run.cacheCreationInputTokens,
    reasoningOutputTokens: run.reasoningOutputTokens,
    totalTokens: run.totalTokens,
    evidence
  };
}

function activityFromBreakdown(
  run: ProductionRunV1,
  endedAt: string,
  breakdown: RunBreakdownV1,
  index: number
): RunLifecycleActivityWebhookV1 {
  const activityEndedAt = breakdown.totalDurationMs
    ? new Date(Math.min(Date.parse(endedAt), Date.parse(run.startedAt) + breakdown.totalDurationMs)).toISOString()
    : endedAt;
  return {
    activityId: `activity_${contentHash({ runId: run.runId, breakdownId: breakdown.breakdownId, index }).slice(0, 24)}`,
    kind: webhookActivityKind(breakdown.kind),
    name: safeActivityName(breakdown.name || breakdown.kind),
    outcome: breakdown.failureCount > 0 && breakdown.failureCount >= breakdown.count ? "failure" : "success",
    startedAt: run.startedAt,
    endedAt: activityEndedAt,
    durationMs: breakdown.totalDurationMs,
    inputTokens: breakdown.inputTokens,
    outputTokens: breakdown.outputTokens,
    cacheReadInputTokens: breakdown.cacheReadInputTokens,
    cacheCreationInputTokens: breakdown.cacheCreationInputTokens,
    reasoningOutputTokens: breakdown.reasoningOutputTokens,
    totalTokens: breakdown.totalTokens,
    evidence: webhookEvidence(
      breakdown.attributionBasis === "provider_reported" ? "provider_metric" : "trace_span",
      breakdown.breakdownId,
      run.startedAt,
      breakdown.attributionBasis !== "provider_reported"
    )
  };
}

function webhookActivityKind(kind: RunBreakdownV1["kind"]): RunLifecycleActivityWebhookV1["kind"] {
  if (kind === "model" || kind === "request") {
    return "llm_request";
  }
  if (kind === "tool" || kind === "subagent" || kind === "skill" || kind === "mcp") {
    return kind;
  }
  return "unknown";
}

function safeActivityName(value: string): string {
  const normalized = value.replace(/[\r\n\t]/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 200) : "unknown";
}

function durationMs(startedAt: string, endedAt: string): number | undefined {
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) {
    return undefined;
  }
  return endedMs - startedMs;
}

function projectLiveRunStartedEvents(
  observation: SafeObservationV1,
  repository: WebhookRepositoryV1,
  sender: WebhookSenderV1
): LiveStartedProjection[] {
  return (observation.queryOccurrences ?? [])
    .filter((occurrence) => isLiveLifecycleAnchorOccurrence(observation.provider, occurrence))
    .map((occurrence) => {
      const runId = runIdForQuery(occurrence.queryId);
      const evidenceBasis = liveStartEvidenceBasis(observation, occurrence.evidence);
      return {
        queryId: occurrence.queryId,
        event: {
          schemaVersion: 1,
          eventType: "run.start",
          eventId: eventIdFor("run.start", runId),
          runId,
          sessionId: occurrence.sessionId,
          traceIds: liveTraceIds(observation, occurrence.queryId),
          sender,
          repository,
          codingHarness: observation.provider,
          runtime: observation.runtime,
          startedAt: occurrence.startedAt,
          evidence: webhookEvidence(evidenceBasis, occurrence.queryId, occurrence.startedAt, evidenceBasis === "span_db_replay", observation.profileVersion),
          coverage: webhookCoverage("none", "none", "unavailable"),
          sequence: 1,
          updatedAt: occurrence.startedAt,
          state: "running",
          llmModels: []
        }
      };
    });
}

function isLiveLifecycleAnchorOccurrence(
  provider: SafeObservationV1["provider"],
  occurrence: QueryOccurrenceV1
): boolean {
  if (provider === "codex") {
    return occurrence.evidence === "submission_hook";
  }
  if (provider === "github-copilot") {
    return occurrence.evidence === "provider_root_span" || occurrence.evidence === "provider_user_message_event";
  }
  return isPromptStartOccurrence(occurrence);
}

function liveStartEvidenceBasis(
  observation: SafeObservationV1,
  occurrenceEvidence: NonNullable<SafeObservationV1["queryOccurrences"]>[number]["evidence"]
): WebhookEvidenceV1["basis"] {
  if (observation.sourceId.startsWith("span_db_") || observation.profileVersion.startsWith("copilot-span-db-")) {
    return "span_db_replay";
  }
  if (occurrenceEvidence === "provider_root_span") {
    return "root_span";
  }
  if (occurrenceEvidence === "submission_hook") {
    return "prompt_hook";
  }
  return observation.signal === "traces" ? "root_span" : "otel_event";
}

function isPromptStartOccurrence(occurrence: QueryOccurrenceV1): boolean {
  return occurrence.evidence === "submission_hook"
    || occurrence.evidence === "provider_user_prompt_event"
    || occurrence.evidence === "provider_user_message_event"
    || occurrence.evidence === "provider_prompt_id";
}

function canonicalizeLiveStartedEvent(
  event: RunStartedWebhookEventV1,
  queryId: string,
  subject: LiveLifecycleSubject
): RunStartedWebhookEventV1 {
  return {
    ...event,
    eventId: eventIdFor("run.start", subject.subjectRunId),
    runId: subject.subjectRunId,
    sessionId: subject.sessionId,
    traceIds: uniqueStrings([...event.traceIds, queryId, ...subject.queryIds]),
    repository: subject.repository,
    startedAt: subject.startedAt,
    updatedAt: subject.startedAt
  };
}

function canonicalizeLiveUpdatedEvent(
  event: RunUpdatedWebhookEventV1,
  queryId: string,
  subject: LiveLifecycleSubject
): RunUpdatedWebhookEventV1 {
  return {
    ...event,
    runId: subject.subjectRunId,
    sessionId: subject.sessionId,
    traceIds: uniqueStrings([...event.traceIds, queryId, ...subject.queryIds]),
    repository: subject.repository,
    startedAt: earliestIso([subject.startedAt, event.startedAt]),
    updatedAt: latestIso([subject.lastObservedAt, event.updatedAt])
  };
}

function projectLiveRunUpdatedEvents(
  observation: SafeObservationV1,
  repository: WebhookRepositoryV1,
  sender: WebhookSenderV1
): LiveUpdatedProjection[] {
  const queryIds = liveUpdateQueryIds(observation);
  return queryIds.flatMap((queryId) => {
    const usageAtoms = observation.usageAtoms.filter((atom) => (atom.queryId ?? atom.correlationId) === queryId);
    const activityAtoms = (observation.activityAtoms ?? []).filter((atom) => atom.queryId === queryId);
    const executionNodes = (observation.executionNodes ?? []).filter((node) =>
      node.queryId === queryId && node.nodeKind !== "prompt"
    );
    const activity = liveWebhookActivity(queryId, observation, activityAtoms, usageAtoms, executionNodes);
    if (activity.length === 0) {
      return [];
    }
    const tokenTotals = usageTokenTotals(usageAtoms, executionNodes);
    const context = contextFootprintFromLiveSources(
      usageAtoms,
      executionNodes,
      tokenTotals,
      tokenTotals.inputTokens > 0 ? "complete_so_far" : "none"
    );
    const startedAt = earliestIso([
      ...usageAtoms.map((atom) => atom.startedAt),
      ...activityAtoms.map((atom) => atom.startedAt),
      ...executionNodes.map((node) => node.startedAt),
      observation.observedAt
    ]);
    const updatedAt = latestIso([
      ...usageAtoms.flatMap((atom) => [atom.endedAt, atom.startedAt]).filter((value): value is string => Boolean(value)),
      ...activityAtoms.flatMap((atom) => [atom.endedAt, atom.startedAt]).filter((value): value is string => Boolean(value)),
      ...executionNodes.flatMap((node) => [node.endedAt, node.startedAt]).filter((value): value is string => Boolean(value)),
      observation.observedAt
    ]);
    const cost = liveRunUpdateCostFromUsageAtoms(usageAtoms, updatedAt);
    const runId = runIdForQuery(queryId);
    const sessionId = liveSessionId(observation, queryId);
    return [{
      queryId,
      event: {
        schemaVersion: 1,
        eventType: "run.update",
        eventId: eventIdFor("run.update", runId),
        runId,
        sessionId,
        traceIds: liveTraceIds(observation, queryId),
        sender,
        repository,
        codingHarness: observation.provider,
        runtime: observation.runtime,
        startedAt,
        evidence: activity[0].evidence,
        coverage: webhookCoverage(
          tokenTotals.totalTokens > 0 ? "complete_so_far" : "none",
          "partial",
          cost.costCoverage
        ),
        sequence: 2,
        updatedAt,
        state: "running",
        ...tokenTotals,
        llmModels: uniqueStrings([
          ...usageAtoms.flatMap((atom) => atom.model ? [atom.model] : []),
          ...executionNodes.flatMap((node) => node.model ? [node.model] : [])
        ]),
        ...cost,
        ...(context ? { context } : {}),
        activity
      }
    }];
  });
}

function liveUpdateQueryIds(observation: SafeObservationV1): string[] {
  return uniqueStrings([
    ...observation.usageAtoms.map((atom) => atom.queryId ?? atom.correlationId),
    ...(observation.activityAtoms ?? []).map((atom) => atom.queryId),
    ...(observation.executionNodes ?? [])
      .filter((node) => node.nodeKind !== "prompt")
      .map((node) => node.queryId)
  ]);
}

function mergeRunUpdatedWebhookEvents(
  previous: RunUpdatedWebhookEventV1,
  next: RunUpdatedWebhookEventV1
): RunUpdatedWebhookEventV1 {
  const activity = mergeLifecycleActivity(previous.activity, next.activity);
  const tokenTotals = tokenTotalsFromLifecycleActivity(activity);
  const context = mergeRunUpdateContextFootprint(previous.context, next.context, tokenTotals, activity);
  const merged: RunUpdatedWebhookEventV1 = {
    ...next,
    startedAt: earliestIso([previous.startedAt, next.startedAt]),
    traceIds: uniqueStrings([...previous.traceIds, ...next.traceIds]),
    evidence: next.evidence,
    coverage: next.coverage,
    updatedAt: latestIso([previous.updatedAt, next.updatedAt]),
    ...tokenTotals,
    llmModels: uniqueStrings([...previous.llmModels, ...next.llmModels]),
    ...(context ? { context } : {}),
    activity
  };
  const activityCost = liveRunUpdateCostFromMergedActivity(merged);
  return applyLiveRunUpdateCost(
    merged,
    activityCost.costCoverage !== "unavailable"
      ? activityCost
      : preferredLiveRunUpdateCost(previous, next)
  );
}

function liveRunUpdateCostFromUsageAtoms(
  usageAtoms: SafeUsageAtomV1[],
  nowIso: string
): LiveRunUpdateCost {
  if (usageAtoms.length === 0) {
    return unavailableLiveRunUpdateCost();
  }
  return liveRunUpdateCostFromProjectedRun(
    LIVE_UPDATE_USAGE_PIPELINE.project(usageAtoms, new Date(nowIso))[0]
  );
}

function liveRunUpdateCostFromMergedActivity(event: RunUpdatedWebhookEventV1): LiveRunUpdateCost {
  if (event.codingHarness !== "cursor") {
    return unavailableLiveRunUpdateCost();
  }
  const queryId = queryIdForRunId(event.runId);
  const atoms: SafeUsageAtomV1[] = event.activity
    .filter((activity) => activity.kind === "llm_request" && hasLiveActivityUsage(activity))
    .map((activity) => ({
      schemaVersion: 1,
      atomId: `atom_live_${contentHash({
        runId: event.runId,
        activityId: activity.activityId,
        evidenceSourceId: activity.evidence.sourceId
      }).slice(0, 24)}`,
      correlationId: queryId,
      queryId,
      sessionId: event.sessionId,
      requestId: activity.evidence.sourceId,
      owningActivityId: activity.activityId,
      signal: "metrics",
      sourceId: activity.evidence.sourceId,
      profileVersion: activity.evidence.profileVersion,
      provider: event.codingHarness,
      runtime: event.runtime,
      kind: "usage",
      authority: "event",
      billingContext: "cursor",
      model: liveActivityModel(activity, event.llmModels),
      inputTokens: activity.inputTokens,
      outputTokens: activity.outputTokens,
      cacheReadInputTokens: activity.cacheReadInputTokens,
      cacheCreationInputTokens: activity.cacheCreationInputTokens,
      reasoningOutputTokens: activity.reasoningOutputTokens,
      startedAt: activity.startedAt,
      endedAt: activity.endedAt
    }));
  if (atoms.length === 0) {
    return unavailableLiveRunUpdateCost();
  }
  return liveRunUpdateCostFromProjectedRun(
    LIVE_UPDATE_USAGE_PIPELINE.project(atoms, new Date(event.updatedAt))[0]
  );
}

function liveRunUpdateCostFromProjectedRun(run: ProductionRunV1 | undefined): LiveRunUpdateCost {
  if (!run || typeof run.estimatedNanoUsd !== "number") {
    return unavailableLiveRunUpdateCost();
  }
  return {
    estimatedNanoUsd: run.estimatedNanoUsd,
    ...(typeof run.usageValueNanoUsd === "number" ? { usageValueNanoUsd: run.usageValueNanoUsd } : {}),
    costEstimateBasis: normalizeCostEstimateBasis(run.costEstimateBasis),
    costCoverage: run.costCoverage
  };
}

function unavailableLiveRunUpdateCost(): LiveRunUpdateCost {
  return {
    estimatedNanoUsd: 0,
    costEstimateBasis: "unavailable",
    costCoverage: "unavailable"
  };
}

function applyLiveRunUpdateCost(
  event: RunUpdatedWebhookEventV1,
  cost: LiveRunUpdateCost
): RunUpdatedWebhookEventV1 {
  const { usageValueNanoUsd: _usageValueNanoUsd, ...withoutUsageValue } = event;
  return {
    ...withoutUsageValue,
    coverage: {
      ...event.coverage,
      costCoverage: cost.costCoverage
    },
    estimatedNanoUsd: cost.estimatedNanoUsd,
    ...(typeof cost.usageValueNanoUsd === "number" ? { usageValueNanoUsd: cost.usageValueNanoUsd } : {}),
    costEstimateBasis: cost.costEstimateBasis,
    costCoverage: cost.costCoverage
  };
}

function preferredLiveRunUpdateCost(
  previous: RunUpdatedWebhookEventV1,
  next: RunUpdatedWebhookEventV1
): LiveRunUpdateCost {
  const previousCost = liveRunUpdateCostFromEvent(previous);
  const nextCost = liveRunUpdateCostFromEvent(next);
  return costCoverageRank(nextCost.costCoverage) >= costCoverageRank(previousCost.costCoverage)
    ? nextCost
    : previousCost;
}

function liveRunUpdateCostFromEvent(event: RunUpdatedWebhookEventV1): LiveRunUpdateCost {
  return {
    estimatedNanoUsd: event.estimatedNanoUsd,
    ...(typeof event.usageValueNanoUsd === "number" ? { usageValueNanoUsd: event.usageValueNanoUsd } : {}),
    costEstimateBasis: normalizeCostEstimateBasis(event.costEstimateBasis),
    costCoverage: event.costCoverage
  };
}

function costCoverageRank(costCoverage: LiveRunUpdateCost["costCoverage"]): number {
  switch (costCoverage) {
    case "complete":
      return 3;
    case "partial":
      return 2;
    case "unavailable":
    default:
      return 1;
  }
}

function hasLiveActivityUsage(activity: RunLifecycleActivityWebhookV1): boolean {
  return (activity.inputTokens ?? 0) > 0
    || (activity.outputTokens ?? 0) > 0
    || (activity.cacheReadInputTokens ?? 0) > 0
    || (activity.cacheCreationInputTokens ?? 0) > 0
    || (activity.reasoningOutputTokens ?? 0) > 0;
}

function liveActivityModel(activity: RunLifecycleActivityWebhookV1, llmModels: string[]): string | undefined {
  if (activity.name && activity.name !== "llm_request" && activity.name !== "unknown") {
    return activity.name;
  }
  return llmModels.length === 1 ? llmModels[0] : undefined;
}

function queryIdForRunId(runId: string): string {
  return runId.startsWith("run_") ? `qry_${runId.slice(4)}` : `qry_${contentHash(runId).slice(0, 32)}`;
}

function mergeLifecycleActivity(
  previous: RunLifecycleActivityWebhookV1[],
  next: RunLifecycleActivityWebhookV1[]
): RunLifecycleActivityWebhookV1[] {
  const byId = new Map<string, RunLifecycleActivityWebhookV1>();
  for (const activity of [...previous, ...next]) {
    byId.set(activity.activityId, activity);
  }
  return [...byId.values()].sort(compareLifecycleActivity);
}

function compareLifecycleActivity(
  left: RunLifecycleActivityWebhookV1,
  right: RunLifecycleActivityWebhookV1
): number {
  return left.startedAt.localeCompare(right.startedAt)
    || (left.endedAt ?? "").localeCompare(right.endedAt ?? "")
    || left.activityId.localeCompare(right.activityId);
}

function hasWriteCapableActivity(activity: RunLifecycleActivityWebhookV1[]): boolean {
  return activity.some((item) => {
    if (item.kind !== "tool") {
      return false;
    }
    const name = item.name.toLowerCase();
    return name === "write"
      || name === "edit"
      || name === "multiedit"
      || name === "apply_patch"
      || name === "patch"
      || name.includes("write")
      || name.includes("edit");
  });
}

function tokenTotalsFromLifecycleActivity(activity: RunLifecycleActivityWebhookV1[]): RunTokenTotals {
  const inputTokens = sumOptionalNumbers(activity.map((item) => item.inputTokens));
  const outputTokens = sumOptionalNumbers(activity.map((item) => item.outputTokens));
  const cacheReadInputTokens = sumOptionalNumbers(activity.map((item) => item.cacheReadInputTokens));
  const cacheCreationInputTokens = sumOptionalNumbers(activity.map((item) => item.cacheCreationInputTokens));
  const reasoningOutputTokens = sumOptionalNumbers(activity.map((item) => item.reasoningOutputTokens));
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens
  };
}

function mergeRunUpdateContextFootprint(
  previous: RunContextFootprintV1 | undefined,
  next: RunContextFootprintV1 | undefined,
  totals: RunTokenTotals,
  activity: RunLifecycleActivityWebhookV1[]
): RunContextFootprintV1 | undefined {
  if (!previous && !next) {
    return undefined;
  }
  const initialInputContextTokens = previous?.initialInputContextTokens ?? next?.initialInputContextTokens;
  const latestInputContextTokens = next?.latestInputContextTokens ?? previous?.latestInputContextTokens;
  const peakCandidates = [
    previous?.peakInputContextTokens,
    next?.peakInputContextTokens,
    latestInputContextTokens,
    initialInputContextTokens
  ].filter((value): value is number => typeof value === "number");
  const peakInputContextTokens = peakCandidates.length > 0 ? Math.max(...peakCandidates) : undefined;
  const observedLlmRequestCount = Math.max(
    observedLlmRequestActivityCount(activity),
    previous?.observedLlmRequestCount ?? 0,
    next?.observedLlmRequestCount ?? 0
  );
  const contextGrowthInputTokens = initialInputContextTokens != null && peakInputContextTokens != null
    ? Math.max(0, peakInputContextTokens - initialInputContextTokens)
    : undefined;
  const basisCandidates = uniqueStrings([previous?.basis, next?.basis].filter((value): value is RunContextFootprintV1["basis"] => Boolean(value)));
  return {
    schemaVersion: 1,
    accumulatedInputTokens: totals.inputTokens + totals.cacheReadInputTokens + totals.cacheCreationInputTokens,
    ...(initialInputContextTokens != null ? { initialInputContextTokens } : {}),
    ...(latestInputContextTokens != null ? { latestInputContextTokens } : {}),
    ...(peakInputContextTokens != null ? { peakInputContextTokens } : {}),
    cacheReadInputTokens: totals.cacheReadInputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    observedLlmRequestCount,
    ...(contextGrowthInputTokens != null ? { contextGrowthInputTokens } : {}),
    ...(initialInputContextTokens && peakInputContextTokens != null ? { contextGrowthRatio: peakInputContextTokens / initialInputContextTokens } : {}),
    basis: basisCandidates.length === 1 ? basisCandidates[0] as RunContextFootprintV1["basis"] : "derived_from_usage_atoms",
    coverage: next?.coverage ?? previous?.coverage ?? "complete_so_far"
  };
}

function observedLlmRequestActivityCount(activity: RunLifecycleActivityWebhookV1[]): number {
  return activity.filter((item) =>
    item.kind === "llm_request"
    && (
      (item.inputTokens ?? 0) > 0
      || (item.cacheReadInputTokens ?? 0) > 0
      || (item.cacheCreationInputTokens ?? 0) > 0
    )
  ).length;
}

function liveRunUpdateEventId(event: RunUpdatedWebhookEventV1): string {
  return eventIdFor("run.update", `${event.runId}|${event.updatedAt}|${event.activity.map((item) => item.activityId).join(",")}`);
}

function liveSessionId(observation: SafeObservationV1, queryId: string): string {
  const candidates = [
    ...(observation.queryOccurrences ?? [])
      .filter((occurrence) => occurrence.queryId === queryId)
      .map((occurrence) => occurrence.sessionId),
    ...observation.usageAtoms
      .filter((atom) => (atom.queryId ?? atom.correlationId) === queryId)
      .map((atom) => atom.sessionId),
    ...(observation.activityAtoms ?? [])
      .filter((atom) => atom.queryId === queryId)
      .map((atom) => atom.sessionId),
    ...(observation.executionNodes ?? [])
      .filter((node) => node.queryId === queryId)
      .map((node) => node.sessionId)
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? queryId;
}

function liveWebhookActivity(
  queryId: string,
  observation: SafeObservationV1,
  activityAtoms: SafeActivityAtomV1[],
  usageAtoms: SafeUsageAtomV1[],
  executionNodes: NonNullable<SafeObservationV1["executionNodes"]>
): RunLifecycleActivityWebhookV1[] {
  const fromActivities = activityAtoms.map((atom): RunLifecycleActivityWebhookV1 => ({
    activityId: atom.activityId,
    kind: atom.kind,
    name: atom.name,
    outcome: atom.outcome,
    startedAt: atom.startedAt,
    endedAt: atom.endedAt,
    durationMs: atom.durationMs,
    evidence: webhookEvidenceForActivityAtom(atom, observation)
  }));
  if (fromActivities.length > 0) {
    return fromActivities;
  }
  const llmNode = executionNodes.find((node) => node.nodeKind === "llm_request");
  if (llmNode) {
    return [{
      activityId: `activity_${contentHash({ queryId, nodeId: llmNode.nodeId }).slice(0, 24)}`,
      kind: "llm_request",
      name: safeActivityName(llmNode.model ?? llmNode.name),
      outcome: llmNode.outcome,
      startedAt: llmNode.startedAt,
      endedAt: llmNode.endedAt,
      durationMs: llmNode.durationMs,
      inputTokens: llmNode.inputTokens,
      outputTokens: llmNode.outputTokens,
      cacheReadInputTokens: llmNode.cacheReadInputTokens,
      cacheCreationInputTokens: llmNode.cacheCreationInputTokens,
      reasoningOutputTokens: llmNode.reasoningOutputTokens,
      totalTokens: (llmNode.inputTokens ?? 0) + (llmNode.outputTokens ?? 0),
      evidence: webhookEvidence("trace_span", llmNode.nodeId, observation.observedAt, false)
    }];
  }
  if (usageAtoms.length === 0) {
    return [];
  }
  const totals = usageTokenTotals(usageAtoms, executionNodes);
  return [{
    activityId: `activity_${contentHash({ queryId, sourceId: observation.sourceId, observedAt: observation.observedAt }).slice(0, 24)}`,
    kind: "llm_request",
    name: usageAtoms.find((atom) => atom.model)?.model ?? "llm_request",
    outcome: "unknown",
    startedAt: earliestIso(usageAtoms.map((atom) => atom.startedAt)),
    endedAt: latestIso(usageAtoms.flatMap((atom) => [atom.endedAt, atom.startedAt]).filter((value): value is string => Boolean(value))),
    ...totals,
    evidence: webhookEvidence("provider_metric", queryId, observation.observedAt, false)
  }];
}

function webhookEvidenceForActivityAtom(
  atom: SafeActivityAtomV1,
  observation: SafeObservationV1
): WebhookEvidenceV1 {
  const basis = atom.evidenceBasis
    ?? (observation.sourceId.includes("_hooks") ? "tool_hook" : observation.signal === "metrics" ? "provider_metric" : observation.signal === "traces" ? "trace_span" : "otel_event");
  return webhookEvidence(
    basis,
    atom.evidenceSourceId ?? atom.activityId,
    observation.observedAt,
    false,
    atom.evidenceProfileVersion ?? observation.profileVersion,
    {
      identityConfidence: atom.identityConfidence ?? "high",
      timingConfidence: atom.timingConfidence ?? (basis === "provider_metric" ? "medium" : "high")
    }
  );
}

function usageTokenTotals(
  usageAtoms: SafeUsageAtomV1[],
  executionNodes: NonNullable<SafeObservationV1["executionNodes"]>
): RunTokenTotals {
  const sources = usageAtoms.length > 0
    ? usageAtoms
    : executionNodes;
  const inputTokens = sumOptionalNumbers(sources.map((item) => item.inputTokens));
  const outputTokens = sumOptionalNumbers(sources.map((item) => item.outputTokens));
  const cacheReadInputTokens = sumOptionalNumbers(sources.map((item) => item.cacheReadInputTokens));
  const cacheCreationInputTokens = sumOptionalNumbers(sources.map((item) => item.cacheCreationInputTokens));
  const reasoningOutputTokens = sumOptionalNumbers(sources.map((item) => item.reasoningOutputTokens));
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens
  };
}

function contextFootprintFromLiveSources(
  usageAtoms: SafeUsageAtomV1[],
  executionNodes: NonNullable<SafeObservationV1["executionNodes"]>,
  totals: RunTokenTotals,
  coverage: RunContextFootprintV1["coverage"]
): RunContextFootprintV1 | undefined {
  const usingUsageAtoms = usageAtoms.length > 0;
  const sources = usingUsageAtoms
    ? usageAtoms
    : executionNodes;
  const requests = sources
    .filter(hasReportedInputContext)
    .sort(compareContextSources);
  if (requests.length === 0) {
    return undefined;
  }
  const inputFootprints = requests.map(inputContextFootprint);
  const initialInputContextTokens = inputFootprints[0];
  const latestInputContextTokens = inputFootprints.at(-1)!;
  const peakInputContextTokens = Math.max(...inputFootprints);
  const contextGrowthInputTokens = Math.max(0, peakInputContextTokens - initialInputContextTokens);
  return {
    schemaVersion: 1,
    accumulatedInputTokens: totals.inputTokens + totals.cacheReadInputTokens + totals.cacheCreationInputTokens,
    initialInputContextTokens,
    latestInputContextTokens,
    peakInputContextTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    observedLlmRequestCount: requests.length,
    contextGrowthInputTokens,
    ...(initialInputContextTokens > 0 ? { contextGrowthRatio: peakInputContextTokens / initialInputContextTokens } : {}),
    basis: usingUsageAtoms ? "derived_from_usage_atoms" : "derived_from_execution_nodes",
    coverage
  };
}

function compareContextSources(
  left: SafeUsageAtomV1 | NonNullable<SafeObservationV1["executionNodes"]>[number],
  right: SafeUsageAtomV1 | NonNullable<SafeObservationV1["executionNodes"]>[number]
): number {
  return left.startedAt.localeCompare(right.startedAt)
    || (left.endedAt ?? "").localeCompare(right.endedAt ?? "")
    || (left.requestId ?? "").localeCompare(right.requestId ?? "")
    || contextSourceId(left).localeCompare(contextSourceId(right));
}

function contextSourceId(source: SafeUsageAtomV1 | NonNullable<SafeObservationV1["executionNodes"]>[number]): string {
  return "atomId" in source ? source.atomId : source.nodeId;
}

function inputContextFootprint(source: SafeUsageAtomV1 | NonNullable<SafeObservationV1["executionNodes"]>[number]): number {
  return (source.inputTokens ?? 0)
    + (source.cacheReadInputTokens ?? 0)
    + (source.cacheCreationInputTokens ?? 0);
}

function hasReportedInputContext(source: SafeUsageAtomV1 | NonNullable<SafeObservationV1["executionNodes"]>[number]): boolean {
  return isNonNegativeSafeInteger(source.inputTokens)
    || isNonNegativeSafeInteger(source.cacheReadInputTokens)
    || isNonNegativeSafeInteger(source.cacheCreationInputTokens);
}

function liveTraceIds(observation: SafeObservationV1, queryId: string): string[] {
  return uniqueStrings([
    queryId,
    ...observation.usageAtoms
      .filter((atom) => (atom.queryId ?? atom.correlationId) === queryId)
      .flatMap((atom) => atom.requestId ? [atom.requestId] : []),
    ...(observation.executionNodes ?? [])
      .filter((node) => node.queryId === queryId)
      .flatMap((node) => node.requestId ? [node.requestId] : [])
  ]);
}

function runIdForQuery(queryId: string): string {
  return queryId.startsWith("qry_") ? `run_${queryId.slice(4)}` : `run_${contentHash(queryId).slice(0, 32)}`;
}

function sessionIdForRun(run: ProductionRunV1): string {
  return run.sessionId ?? run.queryId ?? run.correlationId ?? run.runId;
}

function earliestIso(values: string[]): string {
  return values.filter((value) => Number.isFinite(Date.parse(value))).sort()[0] ?? new Date(0).toISOString();
}

function latestIso(values: string[]): string {
  return values.filter((value) => Number.isFinite(Date.parse(value))).sort().at(-1) ?? new Date(0).toISOString();
}

function latestIsoOptional(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value))).sort().at(-1);
}

function sumOptionalNumbers(values: Array<number | undefined>): number {
  return values.reduce<number>((sum, value) => sum + (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0), 0);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function aggregateWebhookRun(currentRun: ProductionRunV1, runs: ProductionRunV1[]): ProductionRunV1 {
  const completed = runs.filter((run) => run.endedAt && run.endedAt >= run.startedAt);
  if (completed.length <= 1) {
    return currentRun;
  }
  const ordered = [...completed].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt) || left.runId.localeCompare(right.runId)
  );
  const pricedRuns = ordered.filter((run) =>
    typeof run.estimatedNanoUsd === "number" && run.costCoverage !== "unavailable"
  );
  const estimatedNanoUsd = pricedRuns.length > 0
    ? pricedRuns.reduce((sum, run) => sum + (run.estimatedNanoUsd ?? 0), 0)
    : undefined;
  const usageValueNanoUsd = ordered.every((run) => typeof run.usageValueNanoUsd === "number")
    ? ordered.reduce((sum, run) => sum + (run.usageValueNanoUsd ?? 0), 0)
    : undefined;
  const completeCost = pricedRuns.length === ordered.length && ordered.every((run) => run.costCoverage === "complete");
  const costCoverage = completeCost ? "complete" : pricedRuns.length > 0 ? "partial" : "unavailable";
  const context = aggregateRunContextFootprint(ordered);
  return {
    ...currentRun,
    startedAt: ordered[0].startedAt,
    endedAt: ordered.map((run) => run.endedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? currentRun.endedAt,
    inputTokens: ordered.reduce((sum, run) => sum + run.inputTokens, 0),
    outputTokens: ordered.reduce((sum, run) => sum + run.outputTokens, 0),
    cacheReadInputTokens: ordered.reduce((sum, run) => sum + run.cacheReadInputTokens, 0),
    cacheCreationInputTokens: ordered.reduce((sum, run) => sum + run.cacheCreationInputTokens, 0),
    reasoningOutputTokens: ordered.reduce((sum, run) => sum + run.reasoningOutputTokens, 0),
    totalTokens: ordered.reduce((sum, run) => sum + run.totalTokens, 0),
    estimatedNanoUsd,
    usageValueNanoUsd,
    costEstimateBasis: aggregateCostEstimateBasis(pricedRuns),
    costCoverage,
    ...(context ? { context } : {}),
    models: uniqueStrings(ordered.flatMap((run) => run.models ?? (run.model ? [run.model] : [])))
  };
}

function aggregateRunContextFootprint(runs: ProductionRunV1[]): RunContextFootprintV1 | undefined {
  const contexts = runs.flatMap((run) => run.context ? [run.context] : []);
  if (contexts.length === 0) {
    return undefined;
  }
  const first = contexts.find((context) => context.initialInputContextTokens != null);
  const latest = [...contexts].reverse().find((context) => context.latestInputContextTokens != null);
  const peakCandidates = contexts.flatMap((context) =>
    context.peakInputContextTokens != null ? [context.peakInputContextTokens] : []
  );
  const initialInputContextTokens = first?.initialInputContextTokens;
  const latestInputContextTokens = latest?.latestInputContextTokens;
  const peakInputContextTokens = peakCandidates.length > 0 ? Math.max(...peakCandidates) : undefined;
  const contextGrowthInputTokens = initialInputContextTokens != null && peakInputContextTokens != null
    ? Math.max(0, peakInputContextTokens - initialInputContextTokens)
    : undefined;
  const bases = uniqueStrings(contexts.map((context) => context.basis));
  const coverage = contexts.length === runs.length ? "final" : "partial";
  return {
    schemaVersion: 1,
    accumulatedInputTokens: runs.reduce((sum, run) =>
      sum + run.inputTokens + run.cacheReadInputTokens + run.cacheCreationInputTokens, 0),
    ...(initialInputContextTokens != null ? { initialInputContextTokens } : {}),
    ...(latestInputContextTokens != null ? { latestInputContextTokens } : {}),
    ...(peakInputContextTokens != null ? { peakInputContextTokens } : {}),
    cacheReadInputTokens: runs.reduce((sum, run) => sum + run.cacheReadInputTokens, 0),
    cacheCreationInputTokens: runs.reduce((sum, run) => sum + run.cacheCreationInputTokens, 0),
    observedLlmRequestCount: contexts.reduce((sum, context) => sum + context.observedLlmRequestCount, 0),
    ...(contextGrowthInputTokens != null ? { contextGrowthInputTokens } : {}),
    ...(initialInputContextTokens && peakInputContextTokens != null ? { contextGrowthRatio: peakInputContextTokens / initialInputContextTokens } : {}),
    basis: bases.length === 1 ? bases[0] as RunContextFootprintV1["basis"] : "derived_from_usage_atoms",
    coverage
  };
}

function aggregateCostEstimateBasis(runs: ProductionRunV1[]): CostEstimateBasis {
  const bases = uniqueStrings(runs.map((run) => normalizeCostEstimateBasis(run.costEstimateBasis)));
  return bases.length === 1 ? bases[0] as CostEstimateBasis : "unavailable";
}

function eventIdFor(eventType: WebhookEventTypeV1, subject: string): string {
  return `evt_${createHash("sha256").update(`${eventType}|${subject}`).digest("hex").slice(0, 32)}`;
}

function runEndedMeaningHash(event: RunEndedWebhookEventDraft | RunEndedWebhookEventV1): string {
  const { eventId: _eventId, version: _version, ...meaning } = event;
  return contentHash(meaning);
}

function commitSubject(repoKey: string, commitHash: string): string {
  return `commit.attributed:${repoKey}:${commitHash}`;
}

function commitMessagePayload(message?: string): { commitMessage?: string } {
  const normalized = message?.trim();
  return normalized ? { commitMessage: normalized.slice(0, 1000) } : {};
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}

function safeRepoRelativePaths(values: string[]): string[] {
  return uniqueStrings(values
    .map((value) => value.replace(/\\/g, "/"))
    .filter(isWebhookRepoRelativePath));
}

function webhookValidationFailureDetails(
  event: WebhookEventV1,
  violations: string[]
): Record<string, string | number | boolean | null> {
  const details: Record<string, string | number | boolean | null> = {
    violationCount: violations.length,
    violationSummary: violations.slice(0, 3).join("; ").slice(0, 300)
  };
  if (event.eventType === "run.ended") {
    const invalidFiles = event.filesChanged.filter((filePath) => !isWebhookRepoRelativePath(filePath));
    const normalizedInvalidFiles = invalidFiles.map((filePath) => filePath.replace(/\\/g, "/"));
    details.filesChangedCount = event.filesChanged.length;
    details.invalidFilesChangedCount = invalidFiles.length;
    details.hasAbsoluteFilesChangedPath = invalidFiles.some((filePath) =>
      filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath) || isAbsolute(filePath)
    );
    details.hasParentTraversalFilesChangedPath = normalizedInvalidFiles.some((filePath) =>
      filePath === ".." || filePath.startsWith("../") || filePath.includes("/../")
    );
    details.hasEmptyOrDotFilesChangedPath = invalidFiles.some((filePath) =>
      filePath.trim() === "" || filePath.replace(/\\/g, "/").split("/").some((segment) => segment === "" || segment === ".")
    );
    details.invalidTraceIdCount = event.traceIds.filter((traceId) => !isWebhookOpaqueString(traceId)).length;
    details.invalidModelCount = event.llmModels.filter((model) => !isWebhookBoundedString(model)).length;
    details.endedBeforeStarted = event.endedAt < event.startedAt;
  }
  return details;
}

function isWebhookRepoRelativePath(value: string): boolean {
  if (value.trim() === "" || value.length > 1000 || /[\r\n\t]/.test(value)) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.startsWith("/")
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized === ".."
    || /^[A-Za-z]:[\\/]/.test(value)
    || isAbsolute(value)
  ) {
    return false;
  }
  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isWebhookOpaqueString(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\r\n\t]/.test(value);
}

function isWebhookBoundedString(value: string): boolean {
  return value.length <= 200 && !/[\r\n\t]/.test(value);
}

function writingRunIdsFromDeliveredLifecycle(
  outboxEntries: WebhookOutboxEntry[],
  subjectStates: WebhookSubjectState[] = []
): Set<string> {
  const runIds = new Set<string>();
  const projectedWritingState = new Map<string, boolean>();
  for (const state of subjectStates) {
    if (state.eventType !== "run.ended" || !state.deliveredAt) {
      continue;
    }
    const runId = runIdFromRunEndedSubject(state.subjectId);
    if (!runId) {
      continue;
    }
    projectedWritingState.set(runId, (state.filesChangedCount ?? 0) > 0);
  }
  for (const entry of outboxEntries) {
    if (entry.eventType !== "run.ended") {
      continue;
    }
    const event = entry.event as RunEndedWebhookEventV1;
    if (event.runId.trim() === "") {
      continue;
    }
    const writes = (event.filesChanged?.length ?? 0) > 0;
    if (projectedWritingState.get(event.runId) === false) {
      continue;
    }
    if (writes) {
      projectedWritingState.set(event.runId, true);
      continue;
    }
    if (entry.deliveredAt || entry.deliveryState === "delivered") {
      projectedWritingState.set(event.runId, projectedWritingState.get(event.runId) ?? false);
    }
  }
  for (const [runId, writes] of projectedWritingState) {
    if (writes) {
      runIds.add(runId);
    }
  }
  return runIds;
}

function runIdFromRunEndedSubject(subjectId: string): string | undefined {
  return subjectId.startsWith("run.ended:") ? subjectId.slice("run.ended:".length) : undefined;
}

function runIdsForCommit(
  summary: CommitAttributionSummary,
  workEpisodes: AgenticWorkEpisode[]
): string[] {
  const claimedRunIds = workEpisodes
    .flatMap((episode) => commitEvidenceItemsForEpisode(episode, summary)
      .flatMap((evidence) => evidence.runIds ?? []));
  return uniqueStrings([...summary.runIds, ...claimedRunIds]);
}

function artifactKeysForCommitRun(
  workEpisodes: AgenticWorkEpisode[],
  summary: CommitAttributionSummary,
  run: ProductionRunV1
): string[] {
  const queryId = run.queryId ?? run.correlationId;
  return uniqueStrings(workEpisodes
    .flatMap((episode) => commitEvidenceItemsForEpisode(episode, summary))
    .filter((evidence) =>
      evidence.queryId === queryId || (evidence.runIds ?? []).includes(run.runId)
    )
    .flatMap((evidence) => evidence.artifactKeys ?? []));
}

function commitEvidenceItemsForEpisode(
  episode: AgenticWorkEpisode,
  summary: CommitAttributionSummary
): AgenticWorkEpisode["evidence"] {
  if (
    episode.claimedByCommitHash
    && episode.claimedByCommitHash !== summary.commitHash
  ) {
    return [];
  }
  const repoKeys = episode.repoKeys ?? (episode.repoKey ? [episode.repoKey] : []);
  if (!repoKeys.includes(summary.repoKey)) {
    return [];
  }
  const commitQueryIds = commitQueryIdSet(summary);
  const commitRunIds = new Set(summary.runIds);
  return (episode.evidence ?? []).filter((evidence) =>
    evidence.repoKey === summary.repoKey
    && (
      commitQueryIds.size === 0
      || commitQueryIds.has(evidence.queryId)
      || (evidence.runIds ?? []).some((runId) => commitRunIds.has(runId))
    )
  );
}

function commitQueryIdSet(summary: CommitAttributionSummary): Set<string> {
  const queryIds = uniqueStrings([
    ...summary.queryIds,
    ...summary.anchorQueryIds,
    ...summary.inheritedQueryIds
  ]);
  return new Set(queryIds);
}

function artifactKeysForRun(
  workEpisodes: AgenticWorkEpisode[],
  repoKey: string,
  run: ProductionRunV1
): string[] {
  const queryId = run.queryId ?? run.correlationId;
  return uniqueStrings(workEpisodes.flatMap((episode) =>
    (episode.evidence ?? [])
      .filter((evidence) =>
        evidence.repoKey === repoKey
        && (evidence.queryId === queryId || (evidence.runIds ?? []).includes(run.runId))
      )
      .flatMap((evidence) => evidence.artifactKeys ?? [])
  ));
}

function evidenceScopeForQueryIds(
  episode: AgenticWorkEpisode,
  queryIds: string[],
  currentRun: ProductionRunV1
): { queryIds: string[]; runIds: string[] } {
  const scopedQueryIds = uniqueStrings(queryIds.filter((queryId) => episode.queryIds.includes(queryId)));
  const queryIdSet = new Set(scopedQueryIds);
  const currentQueryId = currentRun.queryId ?? currentRun.correlationId;
  const runIds = uniqueStrings([
    ...(queryIdSet.has(currentQueryId) ? [currentRun.runId] : []),
    ...episode.evidence
      .filter((evidence) => queryIdSet.has(evidence.queryId))
      .flatMap((evidence) => evidence.runIds ?? [])
  ]);
  return { queryIds: scopedQueryIds, runIds };
}

function artifactKeysForEvidenceScope(
  episode: AgenticWorkEpisode,
  repoKey: string,
  queryIds: string[],
  runIds: string[]
): string[] {
  const queryIdSet = new Set(queryIds);
  const runIdSet = new Set(runIds);
  return uniqueStrings((episode.evidence ?? [])
    .filter((evidence) =>
      evidence.repoKey === repoKey
      && (
        queryIdSet.has(evidence.queryId)
        || (evidence.runIds ?? []).some((runId) => runIdSet.has(runId))
      )
    )
    .flatMap((evidence) => evidence.artifactKeys ?? []));
}

function attributedCommitCost(
  summary: CommitAttributionSummary,
  snapshot: CommitPublicationSnapshot
): { estimatedNanoUsd: number; costCoverage: CommitAttributedWebhookEventV1["costCoverage"] } {
  const estimatedNanoUsd = snapshot.allocatedNanoUsd ?? summary.allocatedNanoUsd;
  if (typeof estimatedNanoUsd !== "number") {
    return { estimatedNanoUsd: 0, costCoverage: "unavailable" };
  }
  return {
    estimatedNanoUsd,
    costCoverage: snapshot.coverage
  };
}

function attributedCommitUsageValue(runs: ProductionRunV1[]): number | undefined {
  if (runs.length === 0 || !runs.every((run) => typeof run.usageValueNanoUsd === "number")) {
    return undefined;
  }
  return runs.reduce((sum, run) => sum + (run.usageValueNanoUsd ?? 0), 0);
}

function isWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeWebhookSenderProfile(value: unknown): WebhookSenderProfileV1 | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sender: WebhookSenderProfileV1 = {};
  if (isWebhookSenderText(value.name)) {
    sender.name = value.name.trim();
  }
  if (isWebhookSenderText(value.team)) {
    sender.team = value.team.trim();
  }
  if (isWebhookImageUrl(value.imageUrl)) {
    sender.imageUrl = value.imageUrl.trim();
  }
  return Object.keys(sender).length > 0 ? sender : undefined;
}

function isWebhookSenderText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 200
    && !/[\r\n\t]/.test(value);
}

function isWebhookImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_000 || /[\r\n\t]/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, RETRY_INTERVAL_MS * Math.max(1, attempts));
}

function asWebhookFailure(error: unknown): { code: string; retryable: boolean } {
  if (isWebhookFailure(error)) {
    return error;
  }
  return { code: "network_error", retryable: true };
}

function isWebhookFailure(value: unknown): value is { code: string; retryable: boolean } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { code?: unknown }).code === "string"
    && typeof (value as { retryable?: unknown }).retryable === "boolean";
}

async function postWebhook(
  configuration: StoredWebhookConfiguration,
  event: WebhookEventV1,
  attemptAt: string
): Promise<{ statusCode: number }> {
  const payload = JSON.stringify(event);
  const target = new URL(configuration.url!);
  const timestamp = String(Math.floor(Date.parse(attemptAt) / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "user-agent": "tirion-agent/oss-local",
    "x-tirion-event-id": event.eventId,
    "idempotency-key": event.eventId
  };
  if (configuration.bearerToken) {
    headers.authorization = `Bearer ${configuration.bearerToken}`;
  }
  if (configuration.hmacSecret) {
    headers["x-tirion-timestamp"] = timestamp;
    headers["x-tirion-signature-256"] = `sha256=${createHmac("sha256", configuration.hmacSecret)
      .update(`${timestamp}.${payload}`)
      .digest("hex")}`;
  }
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const statusCode = await new Promise<number>((resolve, reject) => {
    const request = send({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers
    }, (response) => {
      const code = response.statusCode ?? 0;
      response.resume();
      response.on("end", () => {
        if ((code >= 200 && code < 300) || code === 409) {
          resolve(code);
          return;
        }
        if (code === 408 || code === 425 || code === 429 || code >= 500) {
          reject({ code: "delivery_failed", retryable: true });
          return;
        }
        reject({ code: `http_${code}`, retryable: false });
      });
    });
    request.once("error", () => reject({ code: "network_error", retryable: true }));
    request.end(payload);
  });
  return { statusCode };
}

function groupAtomsByQuery(atoms: SafeUsageAtomV1[]): Map<string, SafeUsageAtomV1[]> {
  const grouped = new Map<string, SafeUsageAtomV1[]>();
  for (const atom of atoms) {
    const queryId = atom.queryId ?? atom.correlationId;
    grouped.set(queryId, [...(grouped.get(queryId) ?? []), atom]);
  }
  return grouped;
}

function traceIdsForRun(
  run: ProductionRunV1,
  atomsByQuery: Map<string, SafeUsageAtomV1[]>
): string[] {
  const queryId = run.queryId ?? run.correlationId;
  const atoms = atomsByQuery.get(queryId) ?? [];
  return uniqueStrings([
    run.correlationId,
    ...atoms.flatMap((atom) => [atom.queryId, atom.requestId]).filter((value): value is string => typeof value === "string")
  ]);
}
