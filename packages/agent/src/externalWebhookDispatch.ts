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
import {
  DefaultProductionUsagePipeline,
  isClosedAuthoritativeRunBoundaryAtom,
  preferredSafeActivities
} from "@tirion/engine";
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
const WEBHOOK_REQUEST_TIMEOUT_MS = 5_000;
// Keep first terminal delivery inside the five-second lifecycle target. Later workspace
// evidence can still improve the same run through a versioned run.ended event.
const RUN_ENDED_GRACE_MS = 3_000;
const LIVE_TERMINAL_CORRECTION_RETENTION_MS = 15_000;
const TERMINAL_ACTIVITY_CORRECTION_COALESCE_MS = 250;
// Grace window for commit.attributed to allow all episode claims (which fire in rapid
// succession as each episode is attributed) to settle before delivery. This also ensures
// the runIds are fully populated from all contributing runs before the event fires.
const COMMIT_ATTRIBUTED_GRACE_MS = 4_000;
const LIVE_USAGE_CORROBORATION_MS = 250;
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

type LiveRunSources = {
  usageAtoms: Map<string, SafeUsageAtomV1>;
  activityAtoms: Map<string, SafeActivityAtomV1>;
  executionNodes: Map<string, NonNullable<SafeObservationV1["executionNodes"]>[number]>;
};

type LiveTerminalAnchor = {
  queryId: string;
  completedAt: string;
  completionEvidence: NonNullable<QueryOccurrenceV1["completionEvidence"]>;
  profileVersion: string;
};

type LiveTerminalProjection = {
  subject: LiveLifecycleSubject;
  anchor: LiveTerminalAnchor;
};

type LiveObservationRoute = {
  observation: SafeObservationV1;
  repository: WebhookRepositoryV1;
};

type LiveRepositoryResolution =
  | { state: "bound"; repositoryKey: string }
  | { state: "missing" }
  | { state: "conflict" };

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

type WebhookDispatchTimingOptions = {
  runEndedGraceMs?: number;
  requestTimeoutMs?: number;
  terminalActivityCorrectionCoalesceMs?: number;
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
  private retryTimerDueAt?: number;
  private running = false;
  private deliveryRunning = false;
  private deliveryRerunRequested = false;
  private deliveryRerunForce = false;
  private readonly liveRunStarts = new Map<string, string>();
  private readonly liveRunRepositories = new Map<string, WebhookRepositoryV1>();
  private readonly liveRunSources = new Map<string, LiveRunSources>();
  private readonly liveRunSubjects = new Map<string, LiveLifecycleSubject>();
  private readonly liveQuerySubjects = new Map<string, string>();
  private readonly liveSessionSubjects = new Map<string, string>();
  private readonly repositoryKeysByQuery = new Map<string, Set<string>>();
  private readonly repositoryKeysBySession = new Map<string, Set<string>>();
  private durableRepositoryHintsLoaded = false;
  private durableRepositoryHintsLoading?: Promise<void>;
  private readonly liveTerminalAnchors = new Map<string, LiveTerminalAnchor>();
  private readonly liveSubjectReleaseTimers = new Map<string, NodeJS.Timeout>();
  private readonly runEndedQueueTails = new Map<string, Promise<void>>();
  private readonly runEndedGraceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly terminalActivityCorrectionCoalesceMs: number;

  constructor(
    storage: AgentStorageClient,
    paths: WebhookConfigPaths,
    private readonly attribution: AgentVerifiedAttributionService,
    private readonly repositories: AgentRepositoryObservationService,
    private readonly now: () => number = Date.now,
    private readonly recordEvent: (event: DiagnosticEvent) => void = () => undefined,
    private readonly installationId = "installation_local",
    timing: WebhookDispatchTimingOptions = {}
  ) {
    this.configuration = new FileWebhookConfigurationStore(paths.configurationPath);
    this.outbox = new SqliteWebhookOutbox(storage, this.privacy);
    this.subjects = new SqliteWebhookSubjectStateStore(storage);
    this.runEndedGraceMs = positiveDurationMs(timing.runEndedGraceMs, RUN_ENDED_GRACE_MS);
    this.requestTimeoutMs = positiveDurationMs(timing.requestTimeoutMs, WEBHOOK_REQUEST_TIMEOUT_MS);
    this.terminalActivityCorrectionCoalesceMs = positiveDurationMs(
      timing.terminalActivityCorrectionCoalesceMs,
      TERMINAL_ACTIVITY_CORRECTION_COALESCE_MS
    );
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleRetry();
    void this.resumePendingDeliveries().catch(() => undefined);
    void this.reconcileCommitEvents().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retryTimerDueAt = undefined;
    }
    for (const timer of this.liveSubjectReleaseTimers.values()) {
      clearTimeout(timer);
    }
    this.liveSubjectReleaseTimers.clear();
    while (this.deliveryRunning) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async status(): Promise<AgentWebhookStatusV1> {
    const configuration = this.configuration.read();
    const snapshot = await this.outbox.status();
    const queued = snapshot.activeEntries.filter((entry) => entry.deliveryState === "pending" || entry.deliveryState === "retry");
    const blocked = snapshot.activeEntries.filter((entry) => entry.deliveryState === "blocked");
    const queuedCount = snapshot.pendingCount + snapshot.retryCount;
    return {
      ...configuration,
      queuedCount,
      blockedCount: snapshot.blockedCount,
      deliveredCount: snapshot.deliveredCount,
      oldestQueuedAt: snapshot.oldestQueuedAt,
      maxQueueAgeMs: queuedCount > 0 && snapshot.oldestQueuedAt
        ? Math.max(...queued.map((entry) => queueAgeMs(entry, this.now()) ?? 0))
        : undefined,
      lastDeliveredAt: snapshot.lastDeliveredAt,
      lastErrorCode: snapshot.lastErrorCode,
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
      activity: [],
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
      if (!await this.isCustomerVisibleCompletedRun(run)) {
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "ExternalWebhookDispatch",
          operation: "projection",
          state: "blocked",
          reason: "run_lifecycle_internal_harness_session",
          runId: run.runId,
          queryId: run.queryId ?? run.correlationId,
          details: { provider: run.provider }
        });
        continue;
      }
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
    const visibleObservation = await this.customerVisibleObservation(observation);
    const routes = await this.routeLiveObservation(visibleObservation);
    for (const route of routes) {
      await this.observeRepositoryBoundSafeObservation(route.observation, route.repository);
    }
  }

  private async observeRepositoryBoundSafeObservation(
    observation: SafeObservationV1,
    repository: WebhookRepositoryV1
  ): Promise<void> {
    this.rememberObservationRepositoryHints(observation, repository.repoKey);
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
    const terminalSubjects = new Map<string, LiveTerminalProjection>();
    for (const occurrence of (observation.queryOccurrences ?? []).filter(isExplicitLiveTerminalOccurrence)) {
      const subject = await this.liveSubjectForQuery(observation, occurrence.queryId, repository);
      if (
        !subject
        || runIdForQuery(occurrence.queryId) !== subject.subjectRunId
        || await this.deliveredRunEndedForSubject(subject.subjectRunId)
      ) {
        continue;
      }
      const anchor = this.rememberLiveTerminalAnchor(subject, occurrence, observation);
      terminalSubjects.set(subject.subjectRunId, { subject, anchor });
    }
    const updateSubjects = new Map<string, LiveLifecycleSubject>();
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
      const deliveredTerminal = await this.deliveredRunEndedForSubject(subject.subjectRunId);
      const isAuthoritativeRootCorrection = deliveredTerminal
        && observation.usageAtoms.some((atom) => {
          const queryId = atom.queryId ?? atom.correlationId;
          return queryId === projection.queryId
            && runIdForQuery(queryId) === subject.subjectRunId
            && isClosedAuthoritativeRunBoundaryAtom(atom);
        });
      if (deliveredTerminal && !isAuthoritativeRootCorrection) {
        this.recordQueueLifecycle(
          canonicalizeLiveUpdatedEvent(projection.event, projection.queryId, subject),
          `run.update:${subject.subjectRunId}`,
          "suppressed",
          "run_update_after_run_ended_suppressed"
        );
        continue;
      }
      this.accumulateLiveRunSources(subject, projection.queryId, observation);
      if (deliveredTerminal) {
        continue;
      }
      updateSubjects.set(subject.subjectRunId, subject);
      const terminalAnchor = this.liveTerminalAnchors.get(subject.subjectRunId);
      if (terminalAnchor) {
        terminalSubjects.set(subject.subjectRunId, { subject, anchor: terminalAnchor });
      }
    }
    for (const atom of observation.usageAtoms.filter(isClosedAuthoritativeRunBoundaryAtom)) {
      const queryId = atom.queryId ?? atom.correlationId;
      const subject = await this.liveSubjectForQuery(observation, queryId, repository);
      if (
        !subject
        || runIdForQuery(queryId) !== subject.subjectRunId
      ) {
        continue;
      }
      const anchor = this.rememberLiveTerminalAnchor(subject, {
        schemaVersion: 1,
        queryId,
        sessionId: subject.sessionId,
        provider: observation.provider,
        runtime: observation.runtime,
        startedAt: subject.startedAt,
        completedAt: atom.endedAt,
        completionEvidence: "closed_root_span",
        promptState: "disabled",
        evidence: "provider_root_span"
      }, observation);
      terminalSubjects.set(subject.subjectRunId, { subject, anchor });
    }
    for (const subject of updateSubjects.values()) {
      const accumulatedObservation = this.accumulatedLiveObservation(subject, observation);
      let event = projectLiveSubjectRunUpdatedEvent(accumulatedObservation, repository, sender, subject);
      if (!event) {
        continue;
      }
      const startedAt = await this.publicLiveStartedAt(event.runId);
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
      event.startedAt = startedAt;
      event.eventId = liveRunUpdateEventId(event);
      queued = (await this.queueEvent(event, `run.update:${event.runId}`)) || queued;
    }
    for (const { subject, anchor } of terminalSubjects.values()) {
      const terminal = await this.projectLiveRunEndedEvent(subject, anchor, observation, sender);
      if (!terminal) {
        continue;
      }
      if (!await this.publicLiveStartedAt(subject.subjectRunId)) {
        this.recordQueueLifecycle(
          terminal.event as RunEndedWebhookEventV1,
          `run.ended:${subject.subjectRunId}`,
          "blocked",
          "run_ended_waiting_for_start",
          {
            provider: observation.provider,
            sourceId: observation.sourceId
          }
        );
        continue;
      }
      queued = (await this.queueRunEndedEvent(terminal.event, `run.ended:${subject.subjectRunId}`, {
        allowFilesChangedAfterReadOnly: terminal.allowFilesChangedAfterReadOnly
      })) || queued;
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
      const linkedParentSubjectId = occurrence.parentSessionId
        ? this.liveSessionSubjects.get(occurrence.parentSessionId)
        : undefined;
      const linkedParentSubject = linkedParentSubjectId
        ? this.liveRunSubjects.get(linkedParentSubjectId)
        : undefined;
      if (
        linkedParentSubject
        && linkedParentSubject.subjectRunId !== existingSubject.subjectRunId
        && !(await this.deliveredRunEndedForSubject(linkedParentSubject.subjectRunId))
      ) {
        return this.reparentLiveSubject(existingSubject, linkedParentSubject, observation, occurrence);
      }
      return this.upsertLiveSubject(existingSubject.subjectRunId, observation, occurrence, repository);
    }

    const parentSubjectId = occurrence.parentSessionId
      ? this.liveSessionSubjects.get(occurrence.parentSessionId)
      : undefined;
    const activeSubjectId = parentSubjectId ?? this.liveSessionSubjects.get(occurrence.sessionId);
    const activeSubject = activeSubjectId ? this.liveRunSubjects.get(activeSubjectId) : undefined;
    const activeTerminal = activeSubject
      ? await this.deliveredRunEndedForSubject(activeSubject.subjectRunId)
      : undefined;
    const joinsLinkedChild = Boolean(
      activeSubject
      && (occurrence.parentSessionId || activeSubject.sessionId !== occurrence.sessionId)
      && !activeTerminal
    );
    const startsNewSubject = !joinsLinkedChild && (
      observation.provider !== "codex"
        || occurrence.evidence === "submission_hook"
        || occurrence.evidence === "provider_user_prompt_event"
        || occurrence.evidence === "provider_user_message_event"
        || !activeSubject
        || Boolean(activeTerminal)
    );
    const subjectRunId = startsNewSubject || !activeSubject
      ? runIdForQuery(occurrence.queryId)
      : activeSubject.subjectRunId;
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
      return this.extendLiveSubject(existingSubject, queryId, observation.observedAt, repository);
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
        const subject = await this.rememberLiveOccurrence(observation, occurrence, repository);
        return occurrence.queryId === queryId
          ? subject
          : this.extendLiveSubject(subject, queryId, observation.observedAt, repository);
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
      sessionId: existing?.sessionId ?? occurrence.sessionId,
      queryIds: uniqueStrings([...(existing?.queryIds ?? []), occurrence.queryId]),
      // The first accepted prompt anchor is the public lifecycle identity. Delayed
      // provider evidence may improve detail, but it must not rewind run.startedAt.
      startedAt: existing?.startedAt ?? occurrence.startedAt,
      lastObservedAt: latestIso([existing?.lastObservedAt, observation.observedAt].filter((value): value is string => Boolean(value))),
      repository,
      provider: observation.provider,
      runtime: observation.runtime
    };
    this.liveRunSubjects.set(subjectRunId, subject);
    this.liveQuerySubjects.set(occurrence.queryId, subjectRunId);
    this.liveSessionSubjects.set(subject.sessionId, subjectRunId);
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

  private reparentLiveSubject(
    child: LiveLifecycleSubject,
    parent: LiveLifecycleSubject,
    observation: SafeObservationV1,
    occurrence: QueryOccurrenceV1
  ): LiveLifecycleSubject {
    const merged: LiveLifecycleSubject = {
      ...parent,
      queryIds: uniqueStrings([...parent.queryIds, ...child.queryIds, occurrence.queryId]),
      lastObservedAt: latestIso([parent.lastObservedAt, child.lastObservedAt, observation.observedAt])
    };
    const childSources = this.liveRunSources.get(child.subjectRunId);
    const parentSources = this.liveRunSources.get(parent.subjectRunId);
    if (childSources || parentSources) {
      const mergedSources: LiveRunSources = parentSources ?? {
        usageAtoms: new Map<string, SafeUsageAtomV1>(),
        activityAtoms: new Map<string, SafeActivityAtomV1>(),
        executionNodes: new Map<string, NonNullable<SafeObservationV1["executionNodes"]>[number]>()
      };
      for (const [atomId, atom] of childSources?.usageAtoms ?? []) {
        mergedSources.usageAtoms.set(atomId, atom);
      }
      for (const [activityId, atom] of childSources?.activityAtoms ?? []) {
        mergedSources.activityAtoms.set(activityId, atom);
      }
      for (const [nodeId, node] of childSources?.executionNodes ?? []) {
        mergedSources.executionNodes.set(nodeId, node);
      }
      this.liveRunSources.set(parent.subjectRunId, mergedSources);
    }
    this.liveRunSources.delete(child.subjectRunId);
    this.liveRunSubjects.delete(child.subjectRunId);
    this.liveRunStarts.delete(child.subjectRunId);
    this.liveRunRepositories.delete(child.subjectRunId);
    this.liveTerminalAnchors.delete(child.subjectRunId);
    this.liveRunSubjects.set(parent.subjectRunId, merged);
    this.liveRunRepositories.set(parent.subjectRunId, parent.repository);
    for (const queryId of merged.queryIds) {
      this.liveQuerySubjects.set(queryId, parent.subjectRunId);
    }
    for (const [sessionId, subjectRunId] of this.liveSessionSubjects) {
      if (subjectRunId === child.subjectRunId) {
        this.liveSessionSubjects.set(sessionId, parent.subjectRunId);
      }
    }
    this.liveSessionSubjects.set(occurrence.sessionId, parent.subjectRunId);
    return merged;
  }

  private async publicLiveStartedAt(subjectRunId: string): Promise<string | undefined> {
    const start = await this.outbox.read(eventIdFor("run.start", subjectRunId));
    return start?.event.eventType === "run.start" ? start.event.startedAt : undefined;
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

  private accumulateLiveRunSources(
    subject: LiveLifecycleSubject,
    sourceQueryId: string,
    observation: SafeObservationV1
  ): void {
    const sources = this.liveRunSources.get(subject.subjectRunId) ?? {
      usageAtoms: new Map<string, SafeUsageAtomV1>(),
      activityAtoms: new Map<string, SafeActivityAtomV1>(),
      executionNodes: new Map<string, NonNullable<SafeObservationV1["executionNodes"]>[number]>()
    };
    for (const atom of observation.usageAtoms) {
      if (
        (atom.queryId ?? atom.correlationId) === sourceQueryId
        && liveSourceOverlapsSubject(atom, subject)
      ) {
        sources.usageAtoms.set(atom.atomId, canonicalLiveUsageAtom(atom, subject));
      }
    }
    for (const atom of observation.activityAtoms ?? []) {
      if (atom.queryId === sourceQueryId && liveSourceOverlapsSubject(atom, subject)) {
        sources.activityAtoms.set(atom.activityId, canonicalLiveActivityAtom(atom, subject));
        if (atom.kind === "subagent" && atom.childSessionId) {
          this.liveSessionSubjects.set(atom.childSessionId, subject.subjectRunId);
        }
      }
    }
    for (const node of observation.executionNodes ?? []) {
      if (
        node.queryId === sourceQueryId
        && node.nodeKind !== "prompt"
        && liveSourceOverlapsSubject(node, subject)
      ) {
        sources.executionNodes.set(node.nodeId, canonicalLiveExecutionNode(node, subject));
      }
    }
    this.liveRunSources.set(subject.subjectRunId, sources);
  }

  private rememberLiveTerminalAnchor(
    subject: LiveLifecycleSubject,
    occurrence: QueryOccurrenceV1,
    observation: SafeObservationV1
  ): LiveTerminalAnchor {
    const anchor: LiveTerminalAnchor = {
      queryId: occurrence.queryId,
      completedAt: occurrence.completedAt!,
      completionEvidence: occurrence.completionEvidence!,
      profileVersion: observation.profileVersion
    };
    const existing = this.liveTerminalAnchors.get(subject.subjectRunId);
    if (!existing || anchor.completedAt >= existing.completedAt) {
      this.liveTerminalAnchors.set(subject.subjectRunId, anchor);
      return anchor;
    }
    return existing;
  }

  private async projectLiveRunEndedEvent(
    subject: LiveLifecycleSubject,
    anchor: LiveTerminalAnchor,
    latestObservation: SafeObservationV1,
    sender: WebhookSenderV1
  ): Promise<{ event: RunEndedWebhookEventDraft; allowFilesChangedAfterReadOnly: boolean } | undefined> {
    if (Date.parse(anchor.completedAt) < Date.parse(subject.startedAt)) {
      return undefined;
    }
    const queryId = queryIdForRunId(subject.subjectRunId);
    const observation = this.accumulatedLiveObservation(subject, latestObservation);
    const update = projectLiveSubjectRunUpdatedEvent(observation, subject.repository, sender, subject);
    const sources = this.liveRunSources.get(subject.subjectRunId);
    const artifactKeys = uniqueStrings([
      ...(sources?.executionNodes.values() ?? [])
    ].flatMap((node) => node.artifactKeys ?? []));
    const filesChanged = await this.filesChangedFor(subject.repository.repoKey, artifactKeys);
    const activity = update?.activity ?? [];
    const cost = update
      ? {
          estimatedNanoUsd: update.estimatedNanoUsd,
          ...(typeof update.usageValueNanoUsd === "number" ? { usageValueNanoUsd: update.usageValueNanoUsd } : {}),
          costEstimateBasis: update.costEstimateBasis,
          costCoverage: update.costCoverage
        }
      : unavailableLiveRunUpdateCost();
    const usageCoverage = liveTerminalUsageCoverage(observation, update?.totalTokens ?? 0);
    return {
      event: {
        schemaVersion: 1,
        eventType: "run.ended",
        runId: subject.subjectRunId,
        sessionId: subject.sessionId,
        traceIds: uniqueStrings([
          ...liveTraceIds(observation, queryId),
          anchor.queryId,
          ...subject.queryIds
        ]),
        sender,
        repository: subject.repository,
        codingHarness: subject.provider,
        runtime: subject.runtime,
        startedAt: subject.startedAt,
        evidence: webhookEvidence(
          liveTerminalEvidenceBasis(anchor.completionEvidence, latestObservation.signal),
          anchor.queryId,
          anchor.completedAt,
          false,
          anchor.profileVersion
        ),
        coverage: webhookCoverage(
          usageCoverage,
          activity.length > 0 ? "partial" : "none",
          cost.costCoverage
        ),
        endedAt: anchor.completedAt,
        inputTokens: update?.inputTokens ?? 0,
        outputTokens: update?.outputTokens ?? 0,
        cacheReadInputTokens: update?.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: update?.cacheCreationInputTokens ?? 0,
        reasoningOutputTokens: update?.reasoningOutputTokens ?? 0,
        totalTokens: update?.totalTokens ?? 0,
        llmModels: update?.llmModels ?? [],
        filesChanged,
        ...cost,
        ...(update?.context ? { context: { ...update.context, coverage: usageCoverage } } : {}),
        activity,
        state: "completed"
      },
      allowFilesChangedAfterReadOnly: artifactKeys.length > 0 || hasWriteCapableActivity(activity)
    };
  }

  private accumulatedLiveObservation(
    subject: LiveLifecycleSubject,
    latest: SafeObservationV1
  ): SafeObservationV1 {
    const sources = this.liveRunSources.get(subject.subjectRunId);
    const usageAtoms = [...(sources?.usageAtoms.values() ?? [])];
    const activityAtoms = [...(sources?.activityAtoms.values() ?? [])];
    const executionNodes = [...(sources?.executionNodes.values() ?? [])];
    const observedAt = latestIso([
      subject.startedAt,
      ...usageAtoms.flatMap((atom) => [atom.endedAt, atom.startedAt]).filter((value): value is string => Boolean(value)),
      ...activityAtoms.flatMap((atom) => [atom.endedAt, atom.startedAt]).filter((value): value is string => Boolean(value)),
      ...executionNodes.flatMap((node) => [node.endedAt, node.startedAt]).filter((value): value is string => Boolean(value))
    ]);
    return {
      ...latest,
      observationId: `obs_live_${contentHash({ runId: subject.subjectRunId, observedAt }).slice(0, 32)}`,
      observedAt,
      queryOccurrences: [],
      usageAtoms,
      activityAtoms: preferredSafeActivities(activityAtoms),
      executionNodes
    };
  }

  async reconcileCommitEvents(commitHash?: string): Promise<void> {
    const [summaries, snapshots, workEpisodes] = await Promise.all([
      this.attribution.listCommitAttributions(commitHash ? { commitHash } : {}),
      this.attribution.listCommitPublicationSnapshots(commitHash ? { commitHash } : {}),
      this.attribution.listWorkEpisodes()
    ]);
    const snapshotByCommit = new Map(snapshots.map((snapshot) => [commitSubject(snapshot.repoKey, snapshot.commitHash), snapshot]));
    const runsById = new Map((await this.productionRuns()).map((run) => [run.runId, run]));
    const deliveredWritingSubjectRunIds = new Set(await this.outbox.deliveredWritingRunIds());
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
      const atomsByQuery = groupAtomsByQuery(await this.safeUsageAtomsForQueryIds(candidateRuns.map((run) =>
        run.queryId ?? run.correlationId
      )));
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
    return await this.withRunEndedSubjectLock(
      subjectId,
      () => this.queueRunEndedEventUnlocked(baseEvent, subjectId, options)
    );
  }

  private async withRunEndedSubjectLock<T>(subjectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runEndedQueueTails.get(subjectId) ?? Promise.resolve();
    const queued = previous.then(operation);
    const tail = queued.then(() => undefined, () => undefined);
    this.runEndedQueueTails.set(subjectId, tail);
    try {
      return await queued;
    } finally {
      if (this.runEndedQueueTails.get(subjectId) === tail) {
        this.runEndedQueueTails.delete(subjectId);
      }
    }
  }

  private async queueRunEndedEventUnlocked(
    baseEvent: RunEndedWebhookEventDraft,
    subjectId: string,
    options: QueueEventOptions
  ): Promise<boolean> {
    const normalizedBaseEvent = normalizeRunEndedDraft(baseEvent);
    const subjectState = await this.subjects.read(subjectId);
    const stateEntry = subjectState?.eventId ? await this.outbox.read(subjectState.eventId) : undefined;
    const previousEvent = stateEntry?.event.eventType === "run.ended" ? stateEntry.event : undefined;
    if (previousEvent && previousEvent.repository.repoKey !== normalizedBaseEvent.repository.repoKey) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "queue",
        state: "blocked",
        reason: "run_terminal_repository_identity_changed",
        runId: normalizedBaseEvent.runId,
        details: {
          previousRepoKey: previousEvent.repository.repoKey,
          nextRepoKey: normalizedBaseEvent.repository.repoKey
        }
      });
      return false;
    }
    const monotonicBaseEvent = previousEvent
      ? monotonicRunEndedRevision(previousEvent, normalizedBaseEvent)
      : normalizedBaseEvent;
    const meaningHash = runEndedMeaningHash(monotonicBaseEvent);
    if (subjectState?.payloadHash === meaningHash) {
      return false;
    }
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
      ...monotonicBaseEvent,
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
    if (existing?.deliveredAt && event.eventType === "run.update" && event.state === "settling") {
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
    // A changed authoritative terminal projection is a new version. Identical meaning
    // hashes are suppressed in queueRunEndedEvent; corrected usage, activity, timing,
    // model, cost, or workspace evidence must remain deliverable after version 1.
    // The terminal deadline is anchored to endedAt, never queue time. That one
    // grace window lets final usage and causal file evidence catch up without
    // making ingress or projection latency extend the customer-visible deadline.
    const terminalDeadlineAt = event.eventType === "run.ended"
      ? this.runEndedDeliveryDeadlineAt(event)
      : undefined;
    const terminalActivityCorrectionDeadlineAt = event.eventType === "run.ended"
      && subjectState?.deliveredAt
      && shouldCoalesceTerminalActivityCorrection(event)
      ? (existing?.nextAttemptAt
          ?? new Date(this.now() + this.terminalActivityCorrectionCoalesceMs).toISOString())
      : undefined;
    const settlingDeadlineAt = event.eventType === "run.update" && event.state === "settling"
      ? existing?.nextAttemptAt ?? this.runUpdateSettlingDeadlineAt(event)
      : undefined;
    const preservedRetryAt = existing?.deliveryState === "retry" ? existing.nextAttemptAt : undefined;
    const nextAttemptAt = configuration.url
      ? (event.eventType === "run.ended"
          ? latestIsoOptional([
              preservedRetryAt,
              terminalDeadlineAt,
              terminalActivityCorrectionDeadlineAt
            ])
          : event.eventType === "run.update" && event.state === "settling"
            ? latestIsoOptional([preservedRetryAt, settlingDeadlineAt])
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
    this.scheduleRetry(nextAttemptAt);
    this.recordQueueLifecycle(
      event,
      subjectId,
      entry.deliveryState,
      entry.deliveryState === "blocked" ? "webhook_event_blocked_missing_url" : "webhook_event_queued"
    );
    return true;
  }

  private async projectRunLifecycleEvents(run: ProductionRunV1): Promise<RunLifecycleProjection | undefined> {
    const queryId = run.queryId ?? run.correlationId;
    const byRun = await this.attribution.listWorkEpisodes({ runId: run.runId });
    const byQuery = byRun.some((episode) => episode.queryIds.includes(queryId))
      ? []
      : await this.attribution.listWorkEpisodes({ queryId });
    const episodes = [...new Map([...byRun, ...byQuery].map((episode) => [episode.episodeId, episode])).values()];
    const binding = await this.bindRunToRepository(run, episodes);
    if (!binding || !run.endedAt) {
      return undefined;
    }
    // Codex sends multiple session_task.turn traces per `codex exec` invocation, each
    // building its own ProductionRunV1 with a unique runId and sessionId. The episode
    // tracker groups all runs from the same exec under one episodeId. Use that as the
    // outbox discriminator and aggregate the episode's usage so the single webhook
    // event remains economically accurate.
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
    const projectedRun = aggregateEpisode ? aggregateWebhookRun(run, episodeRuns, webhookRunId) : run;
    const atomsByQuery = groupAtomsByQuery(await this.safeUsageAtomsForQueryIds(episodeRuns.map((candidate) =>
      candidate.queryId ?? candidate.correlationId
    )));
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
    const evidence = evidenceForRun(projectedRun, "usage_projection");
    const traceIdsForWebhook = traceIds.length > 0 ? traceIds : [`trace_${webhookRunId}`];
    const sender = this.webhookSender();
    const startedAt = await this.lifecycleStartedAtFor(webhookRunId, run.runId, projectedRun.startedAt);
    const updatedAt = latestIso([startedAt, endedAt]);
    const activity = activityForRun(projectedRun, endedAt, evidence).map((item) =>
      normalizeTerminalActivityBounds(item, startedAt, updatedAt)
    );
    const activityCoverage = activityCoverageForRun(projectedRun, activity);
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
    // Completed projections can briefly alternate between request slices and a
    // provider turn authority. Keep one replaceable settling slot until the fixed
    // terminal deadline; running updates remain content-addressed and immediate.
    updated.eventId = eventIdFor("run.update", `${webhookRunId}|settling`);
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
      evidence: evidenceForRun(projectedRun, "usage_projection"),
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
      activity,
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
    for (const entry of await this.outbox.lifecycle({ runId: webhookRunId })) {
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
    for (const entry of await this.outbox.lifecycle({ traceId: queryId })) {
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

  private async lifecycleStartedAtFor(
    subjectRunId: string,
    sourceRunId: string,
    fallback: string
  ): Promise<string> {
    const liveAnchor = this.liveRunStarts.get(subjectRunId) ?? this.liveRunStarts.get(sourceRunId);
    if (liveAnchor) {
      return liveAnchor;
    }
    const publishedStart = await this.outbox.read(eventIdFor("run.start", subjectRunId));
    if (publishedStart?.event.eventType === "run.start") {
      return publishedStart.event.startedAt;
    }
    const priorTerminal = await this.runEndedForSubject(subjectRunId);
    return priorTerminal?.startedAt ?? fallback;
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
    const entries = await Promise.all([
      ...(episode.chatSessionId ? [this.outbox.lifecycle({ sessionId: episode.chatSessionId })] : []),
      ...episode.queryIds.map((queryId) => this.outbox.lifecycle({ traceId: queryId })),
      ...episode.runIds.map((runId) => this.outbox.lifecycle({ runId }))
    ]);
    for (const entry of uniqueOutboxEntries(entries.flat())) {
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

  private async bindRunToRepository(run: ProductionRunV1, episodes: AgenticWorkEpisode[]): Promise<{
    repository: WebhookRepositoryV1;
    artifactKeys: string[];
  } | undefined> {
    const queryId = run.queryId ?? run.correlationId;
    const episode = episodes.find((candidate) =>
      candidate.runIds.includes(run.runId) || candidate.queryIds.includes(queryId));
    if (run.repositoryKey) {
      const repository = (await this.repositories.listRepositories())
        .find((candidate) => candidate.repoKey === run.repositoryKey);
      if (!repository) {
        this.recordEvent({
          kind: "constructLifecycle",
          construct: "ExternalWebhookDispatch",
          operation: "projection",
          state: "blocked",
          reason: "run_webhook_repository_binding_missing",
          runId: run.runId,
          queryId,
          repoKey: run.repositoryKey
        });
        return undefined;
      }
      return {
        repository: await this.describeRepository(repository.repoKey, repository.root),
        artifactKeys: episode ? artifactKeysForRun([episode], repository.repoKey, run) : []
      };
    }
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

  private async routeLiveObservation(observation: SafeObservationV1): Promise<LiveObservationRoute[]> {
    const repositories = await this.repositories.listRepositories();
    const repositoriesByKey = new Map(repositories.map((repository) => [repository.repoKey, repository]));
    if (observation.repositoryKey) {
      const repository = repositoriesByKey.get(observation.repositoryKey);
      if (repository) {
        this.rememberObservationRepositoryHints(observation, repository.repoKey);
        return [{
          observation,
          repository: await this.describeRepository(repository.repoKey, repository.root)
        }];
      }
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "blocked",
        reason: "run_lifecycle_repository_binding_missing",
        repoKey: observation.repositoryKey,
        details: {
          provider: observation.provider,
          sourceId: observation.sourceId,
          repositoryCount: repositories.length
        }
      });
      return [];
    }

    if (repositories.length === 1) {
      this.rememberObservationRepositoryHints(observation, repositories[0].repoKey);
      return [{
        observation: { ...observation, repositoryKey: repositories[0].repoKey },
        repository: await this.describeRepository(repositories[0].repoKey, repositories[0].root)
      }];
    }

    if (repositories.length === 0) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "blocked",
        reason: "run_lifecycle_repository_binding_missing",
        details: {
          provider: observation.provider,
          sourceId: observation.sourceId,
          repositoryCount: 0
        }
      });
      return [];
    }

    this.rememberObservationRepositoryHints(observation);
    try {
      await this.ensureDurableRepositoryHints();
    } catch {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "warning",
        reason: "run_lifecycle_durable_repository_hints_unavailable",
        details: {
          provider: observation.provider,
          sourceId: observation.sourceId,
          repositoryCount: repositories.length
        }
      });
    }

    const partitions = new Map<string, SafeObservationV1>();
    let missingRecordCount = 0;
    let conflictingRecordCount = 0;
    const partitionFor = (repositoryKey: string): SafeObservationV1 => {
      const existing = partitions.get(repositoryKey);
      if (existing) {
        return existing;
      }
      const partition: SafeObservationV1 = {
        ...observation,
        repositoryKey,
        queryOccurrences: [],
        activityAtoms: [],
        executionNodes: [],
        usageAtoms: []
      };
      partitions.set(repositoryKey, partition);
      return partition;
    };
    const routeRecord = (input: {
      provider: SafeObservationV1["provider"];
      queryId: string;
      sessionId?: string;
      parentSessionId?: string;
      repositoryKey?: string;
    }): string | undefined => {
      if (input.provider !== observation.provider) {
        conflictingRecordCount += 1;
        return undefined;
      }
      const resolution = this.resolveLiveRecordRepository(input);
      if (resolution.state === "conflict") {
        conflictingRecordCount += 1;
        return undefined;
      }
      if (resolution.state === "missing" || !repositoriesByKey.has(resolution.repositoryKey)) {
        missingRecordCount += 1;
        return undefined;
      }
      return resolution.repositoryKey;
    };

    for (const occurrence of observation.queryOccurrences ?? []) {
      const repositoryKey = routeRecord(occurrence);
      if (repositoryKey) {
        partitionFor(repositoryKey).queryOccurrences!.push(occurrence);
      }
    }
    for (const atom of observation.activityAtoms ?? []) {
      const repositoryKey = routeRecord(atom);
      if (repositoryKey) {
        partitionFor(repositoryKey).activityAtoms!.push(atom);
      }
    }
    for (const node of observation.executionNodes ?? []) {
      const repositoryKey = routeRecord(node);
      if (repositoryKey) {
        partitionFor(repositoryKey).executionNodes!.push(node);
      }
    }
    for (const atom of observation.usageAtoms) {
      const repositoryKey = routeRecord({
        ...atom,
        queryId: atom.queryId ?? atom.correlationId
      });
      if (repositoryKey) {
        partitionFor(repositoryKey).usageAtoms.push(atom);
      }
    }

    if (missingRecordCount > 0) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "blocked",
        reason: "run_lifecycle_record_repository_binding_missing",
        details: {
          provider: observation.provider,
          sourceId: observation.sourceId,
          recordCount: missingRecordCount,
          repositoryCount: repositories.length
        }
      });
    }
    if (conflictingRecordCount > 0) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "blocked",
        reason: "run_lifecycle_record_repository_binding_conflict",
        details: {
          provider: observation.provider,
          sourceId: observation.sourceId,
          recordCount: conflictingRecordCount,
          repositoryCount: repositories.length
        }
      });
    }
    if (partitions.size === 0) {
      this.recordEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "blocked",
        reason: "run_lifecycle_repository_binding_ambiguous",
        details: {
          provider: observation.provider,
          sourceId: observation.sourceId,
          repositoryCount: repositories.length
        }
      });
      return [];
    }

    return await Promise.all([...partitions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([repositoryKey, partition]) => {
        const repository = repositoriesByKey.get(repositoryKey)!;
        return {
          observation: partition,
          repository: await this.describeRepository(repository.repoKey, repository.root)
        };
      }));
  }

  private resolveLiveRecordRepository(input: {
    provider: SafeObservationV1["provider"];
    queryId: string;
    sessionId?: string;
    parentSessionId?: string;
    repositoryKey?: string;
  }): LiveRepositoryResolution {
    const queryKeys = new Set<string>();
    if (input.repositoryKey) {
      queryKeys.add(input.repositoryKey);
    }
    for (const repositoryKey of this.repositoryKeysByQuery.get(providerIdentityKey(input.provider, input.queryId)) ?? []) {
      queryKeys.add(repositoryKey);
    }
    const querySubjectId = this.liveQuerySubjects.get(input.queryId);
    const querySubject = querySubjectId ? this.liveRunSubjects.get(querySubjectId) : undefined;
    if (querySubject?.provider === input.provider) {
      queryKeys.add(querySubject.repository.repoKey);
    }
    if (queryKeys.size > 1) {
      return { state: "conflict" };
    }
    if (queryKeys.size === 1) {
      return { state: "bound", repositoryKey: [...queryKeys][0] };
    }

    const sessionKeys = new Set<string>();
    for (const sessionId of uniqueStrings([input.sessionId, input.parentSessionId]
      .filter((value): value is string => Boolean(value)))) {
      for (const repositoryKey of this.repositoryKeysBySession.get(providerIdentityKey(input.provider, sessionId)) ?? []) {
        sessionKeys.add(repositoryKey);
      }
      const sessionSubjectId = this.liveSessionSubjects.get(sessionId);
      const sessionSubject = sessionSubjectId ? this.liveRunSubjects.get(sessionSubjectId) : undefined;
      if (sessionSubject?.provider === input.provider) {
        sessionKeys.add(sessionSubject.repository.repoKey);
      }
    }
    if (sessionKeys.size > 1) {
      return { state: "conflict" };
    }
    return sessionKeys.size === 1
      ? { state: "bound", repositoryKey: [...sessionKeys][0] }
      : { state: "missing" };
  }

  private rememberObservationRepositoryHints(observation: SafeObservationV1, fallbackRepositoryKey?: string): void {
    const remember = (input: {
      provider: SafeObservationV1["provider"];
      queryId: string;
      sessionId?: string;
      parentSessionId?: string;
      repositoryKey?: string;
    }): void => {
      if (input.provider !== observation.provider) {
        return;
      }
      const repositoryKey = input.repositoryKey ?? fallbackRepositoryKey;
      if (!repositoryKey) {
        return;
      }
      addRepositoryHint(this.repositoryKeysByQuery, providerIdentityKey(input.provider, input.queryId), repositoryKey);
      for (const sessionId of uniqueStrings([input.sessionId, input.parentSessionId]
        .filter((value): value is string => Boolean(value)))) {
        addRepositoryHint(this.repositoryKeysBySession, providerIdentityKey(input.provider, sessionId), repositoryKey);
      }
    };
    for (const occurrence of observation.queryOccurrences ?? []) {
      remember(occurrence);
    }
    for (const atom of observation.activityAtoms ?? []) {
      remember(atom);
    }
    for (const node of observation.executionNodes ?? []) {
      remember(node);
    }
    for (const atom of observation.usageAtoms) {
      remember({ ...atom, queryId: atom.queryId ?? atom.correlationId });
    }
  }

  private async ensureDurableRepositoryHints(): Promise<void> {
    if (this.durableRepositoryHintsLoaded) {
      return;
    }
    if (!this.durableRepositoryHintsLoading) {
      this.durableRepositoryHintsLoading = (async () => {
        const occurrences = await this.outbox.storage.listQueryOccurrences();
        for (const occurrence of occurrences) {
          if (!occurrence.repositoryKey) {
            continue;
          }
          addRepositoryHint(
            this.repositoryKeysByQuery,
            providerIdentityKey(occurrence.provider, occurrence.queryId),
            occurrence.repositoryKey
          );
          for (const sessionId of uniqueStrings([occurrence.sessionId, occurrence.parentSessionId]
            .filter((value): value is string => Boolean(value)))) {
            addRepositoryHint(
              this.repositoryKeysBySession,
              providerIdentityKey(occurrence.provider, sessionId),
              occurrence.repositoryKey
            );
          }
        }
        this.durableRepositoryHintsLoaded = true;
      })().finally(() => {
        this.durableRepositoryHintsLoading = undefined;
      });
    }
    await this.durableRepositoryHintsLoading;
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

  private scheduleRetry(nextAttemptAt?: string): void {
    if (!this.running) {
      return;
    }
    const now = this.now();
    const requestedAt = nextAttemptAt ? Date.parse(nextAttemptAt) : Number.NaN;
    const dueAt = Number.isFinite(requestedAt)
      ? Math.min(now + RETRY_INTERVAL_MS, Math.max(now, requestedAt))
      : now + RETRY_INTERVAL_MS;
    if (this.retryTimer && this.retryTimerDueAt != null && this.retryTimerDueAt <= dueAt) {
      return;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryTimerDueAt = dueAt;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryTimerDueAt = undefined;
      void this.processDueEntries()
        .catch(() => undefined)
        .finally(() => {
          void this.scheduleNextPendingDelivery().catch(() => this.scheduleRetry());
        });
    }, Math.max(0, dueAt - this.now()));
    this.retryTimer.unref?.();
  }

  private async resumePendingDeliveries(): Promise<void> {
    await this.processDueEntries();
    await this.scheduleNextPendingDelivery();
  }

  private async scheduleNextPendingDelivery(): Promise<void> {
    this.scheduleRetry(await this.outbox.nextAttemptAt());
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
        const entries = await this.outbox.due(new Date(this.now()).toISOString(), currentForce);
        // Re-read priority after each ordinary delivery so a newly accepted start
        // cannot sit behind a stale snapshot of update traffic. A forced operator
        // retry still attempts its original snapshot once per row.
        const batch = currentForce ? entries : entries.slice(0, 1);
        for (const entry of batch) {
          await this.deliver(entry, currentForce);
        }
        if (!currentForce && entries.length > batch.length) {
          this.deliveryRerunRequested = true;
        }
        currentForce = false;
      } while (this.deliveryRerunRequested);
    } finally {
      this.deliveryRunning = false;
    }
  }

  private async deliver(entry: WebhookOutboxEntry, force = false): Promise<void> {
    if (entry.event.eventType === "run.ended") {
      await this.withRunEndedSubjectLock(entry.subjectId, async () => {
        // The outbox row may have been replaced while processDueEntries was waiting
        // for the subject lock. Deliver the current projection, never the stale copy.
        const current = await this.outbox.read(entry.event.eventId);
        if (!current || !outboxEntryDue(current, this.now(), force)) {
          return;
        }
        await this.deliverUnlocked(current);
      });
      return;
    }
    await this.deliverUnlocked(entry);
  }

  private async deliverUnlocked(entry: WebhookOutboxEntry): Promise<void> {
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
      const terminalDeadlineAt = this.runEndedDeliveryDeadlineAt(entry.event);
      if (terminalDeadlineAt && Date.parse(terminalDeadlineAt) > this.now()) {
        await this.outbox.upsert({
          ...entry,
          deliveryState: "pending",
          nextAttemptAt: terminalDeadlineAt,
          updatedAt: new Date(this.now()).toISOString()
        });
        this.scheduleRetry(terminalDeadlineAt);
        this.recordDeliveryLifecycle(entry, "pending", "run_ended_waiting_for_terminal_deadline", {
          nextAttemptAt: terminalDeadlineAt
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
      const result = await postWebhook(configuration, entry.event, attemptAt, this.requestTimeoutMs);
      const deliveredAtMs = this.now();
      const deliveredAt = new Date(deliveredAtMs).toISOString();
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
        statusCode: result.statusCode,
        queueLatencyMs: elapsedMs(entry.queuedAt, deliveredAtMs),
        observationLatencyMs: webhookObservationLatencyMs(entry.event, deliveredAtMs)
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
      this.scheduleRetry(nextAttemptAt);
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
    const deliveredVersion = event.version ?? 1;
    const existingVersion = existing?.version ?? 0;
    if (existing && existingVersion > deliveredVersion) {
      await this.subjects.write({
        ...existing,
        deliveredAt: existing.deliveredAt ?? deliveredAt,
        filesChangedCount: Math.max(existing.filesChangedCount ?? 0, (event.filesChanged ?? []).length),
        updatedAt: deliveredAt
      });
      this.finalizeLiveSubjectAfterDelivery(event);
      return;
    }
    await this.subjects.write({
      schemaVersion: 1,
      subjectId,
      eventType: entry.eventType,
      payloadHash: runEndedMeaningHash(event),
      eventId: event.eventId,
      version: deliveredVersion,
      deliveredAt,
      filesChangedCount: (event.filesChanged ?? []).length,
      updatedAt: deliveredAt
    });
    this.finalizeLiveSubjectAfterDelivery(event);
  }

  private finalizeLiveSubjectAfterDelivery(event: RunEndedWebhookEventV1): void {
    if (event.coverage.usageCoverage === "final") {
      this.releaseLiveSubject(event.runId);
      return;
    }
    const existing = this.liveSubjectReleaseTimers.get(event.runId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.liveSubjectReleaseTimers.delete(event.runId);
      this.releaseLiveSubject(event.runId);
    }, LIVE_TERMINAL_CORRECTION_RETENTION_MS);
    timer.unref();
    this.liveSubjectReleaseTimers.set(event.runId, timer);
  }

  private releaseLiveSubject(subjectRunId: string): void {
    const releaseTimer = this.liveSubjectReleaseTimers.get(subjectRunId);
    if (releaseTimer) {
      clearTimeout(releaseTimer);
      this.liveSubjectReleaseTimers.delete(subjectRunId);
    }
    this.liveRunStarts.delete(subjectRunId);
    this.liveRunRepositories.delete(subjectRunId);
    this.liveRunSources.delete(subjectRunId);
    this.liveRunSubjects.delete(subjectRunId);
    this.liveTerminalAnchors.delete(subjectRunId);
    for (const [queryId, mappedSubjectRunId] of this.liveQuerySubjects) {
      if (mappedSubjectRunId === subjectRunId) {
        this.liveQuerySubjects.delete(queryId);
      }
    }
    for (const [sessionId, mappedSubjectRunId] of this.liveSessionSubjects) {
      if (mappedSubjectRunId === subjectRunId) {
        this.liveSessionSubjects.delete(sessionId);
      }
    }
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

  private runEndedDeliveryDeadlineAt(event: RunEndedWebhookEventV1): string | undefined {
    const endedMs = Date.parse(event.endedAt);
    if (!Number.isFinite(endedMs)) {
      return undefined;
    }
    const deadlineMs = endedMs + this.runEndedGraceMs;
    if (deadlineMs <= this.now()) {
      return undefined;
    }
    return new Date(deadlineMs).toISOString();
  }

  private runUpdateSettlingDeadlineAt(event: RunUpdatedWebhookEventV1): string | undefined {
    const updatedMs = Date.parse(event.updatedAt);
    if (!Number.isFinite(updatedMs)) {
      return undefined;
    }
    const deadlineMs = updatedMs + this.runEndedGraceMs;
    return deadlineMs > this.now() ? new Date(deadlineMs).toISOString() : undefined;
  }

  private async safeUsageAtomsForQueryIds(queryIds: string[]): Promise<SafeUsageAtomV1[]> {
    return await this.outbox.storage.listSafeUsageAtomsForQueryIds(queryIds);
  }

  private async isCustomerVisibleCompletedRun(run: ProductionRunV1): Promise<boolean> {
    if (run.provider !== "codex") {
      return true;
    }
    const occurrence = await this.outbox.storage.readQueryOccurrence(run.queryId ?? run.correlationId);
    return occurrence?.lifecycleVisibility !== "internal";
  }

  private async customerVisibleObservation(observation: SafeObservationV1): Promise<SafeObservationV1> {
    if (observation.provider !== "codex") {
      return observation;
    }
    const queryIds = observationQueryIds(observation);
    const internalQueryIds = new Set((observation.queryOccurrences ?? [])
      .filter((occurrence) => occurrence.lifecycleVisibility === "internal")
      .map((occurrence) => occurrence.queryId));
    const durableOccurrences = await Promise.all(queryIds.map((queryId) =>
      this.outbox.storage.readQueryOccurrence(queryId)));
    for (const occurrence of durableOccurrences) {
      if (occurrence?.lifecycleVisibility === "internal") {
        internalQueryIds.add(occurrence.queryId);
      }
    }
    if (internalQueryIds.size === 0) {
      return observation;
    }
    return {
      ...observation,
      queryOccurrences: (observation.queryOccurrences ?? [])
        .filter((occurrence) => !internalQueryIds.has(occurrence.queryId)),
      activityAtoms: (observation.activityAtoms ?? [])
        .filter((atom) => !internalQueryIds.has(atom.queryId)),
      executionNodes: (observation.executionNodes ?? [])
        .filter((node) => !internalQueryIds.has(node.queryId)),
      usageAtoms: observation.usageAtoms
        .filter((atom) => !internalQueryIds.has(atom.queryId ?? atom.correlationId))
    };
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

  async status(): Promise<{
    pendingCount: number;
    retryCount: number;
    blockedCount: number;
    deliveredCount: number;
    oldestQueuedAt?: string;
    lastDeliveredAt?: string;
    lastErrorCode?: string;
    activeEntries: WebhookOutboxEntry[];
  }> {
    const snapshot = await this.storage.webhookOutboxStatus<WebhookOutboxEntry>();
    return {
      ...snapshot,
      activeEntries: snapshot.activeEntries
        .map((document) => document.value)
        .sort(compareWebhookOutboxEntries)
    };
  }

  async lifecycle(identity: { runId?: string; traceId?: string; sessionId?: string }): Promise<WebhookOutboxEntry[]> {
    return (await this.storage.listWebhookLifecycleDocuments<WebhookOutboxEntry>(identity))
      .map((document) => document.value)
      .sort(compareWebhookOutboxEntries);
  }

  async deliveredWritingRunIds(): Promise<string[]> {
    return await this.storage.listDeliveredWritingLifecycleRunIds();
  }

  async read(key: string): Promise<WebhookOutboxEntry | undefined> {
    return (await this.storage.readAgentDocument<WebhookOutboxEntry>("webhook_outbox", key))?.value;
  }

  async due(now: string, force: boolean): Promise<WebhookOutboxEntry[]> {
    return (await this.storage.listWebhookOutboxDueDocuments<WebhookOutboxEntry>(now, force))
      .map((document) => document.value)
      .sort(compareWebhookOutboxEntries);
  }

  async nextAttemptAt(): Promise<string | undefined> {
    return await this.storage.nextWebhookOutboxAttemptAt();
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
    return (await this.storage.readAgentDocument<WebhookSubjectState>("webhook_delivery_state", subjectId))?.value;
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

function outboxEntryDue(entry: WebhookOutboxEntry, now: number, force: boolean): boolean {
  const nextAttemptAt = entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : Number.NaN;
  const dueByTime = !Number.isFinite(nextAttemptAt) || nextAttemptAt <= now;
  return (entry.deliveryState === "pending" && dueByTime)
    || (entry.deliveryState === "retry" && (force || dueByTime))
    || (force && entry.deliveryState === "blocked");
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
  const priorityOrder = webhookDeliveryPriority(left) - webhookDeliveryPriority(right);
  if (priorityOrder !== 0) {
    return priorityOrder;
  }
  const updatedAtOrder = left.updatedAt.localeCompare(right.updatedAt);
  if (updatedAtOrder !== 0) {
    return updatedAtOrder;
  }
  return left.key.localeCompare(right.key);
}

function webhookDeliveryPriority(entry: WebhookOutboxEntry): number {
  if (entry.deliveryState === "delivered") {
    return 20;
  }
  const lifecycle = lifecycleSortKey(entry);
  if (lifecycle) {
    const eventPriority = entry.eventType === "run.start"
      ? 0
      : entry.eventType === "run.update"
        ? 1
        : 2;
    const statePriority = entry.deliveryState === "pending" && entry.attempts === 0
      ? 0
      : entry.deliveryState === "pending"
        ? 3
        : entry.deliveryState === "retry"
          ? 6
          : 9;
    return statePriority + eventPriority;
  }
  return entry.deliveryState === "pending" || entry.deliveryState === "retry" ? 12 : 13;
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

function elapsedMs(startedAt: string, now: number): number | null {
  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : null;
}

function webhookObservationLatencyMs(event: WebhookEventV1, now: number): number | null {
  return event.eventType === "commit.attributed" ? null : elapsedMs(event.evidence.observedAt, now);
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
  const observedAt = basis === "stop_hook" || basis === "usage_projection"
    ? (run.endedAt ?? run.startedAt)
    : run.startedAt;
  return webhookEvidence(
    basis,
    run.queryId ?? run.correlationId ?? run.runId,
    observedAt,
    basis === "usage_projection"
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

function activityForRun(
  run: ProductionRunV1,
  endedAt: string,
  runEvidence: WebhookEvidenceV1
): RunLifecycleActivityWebhookV1[] {
  const breakdown = conservingRunBreakdown(run);
  const indexByBreakdownId = new Map(breakdown.map((item, index) => [item.breakdownId, index]));
  return breakdown.map((item, index) => activityFromBreakdown(
    run,
    endedAt,
    item,
    index,
    runEvidence,
    item.parentBreakdownId
      ? breakdownActivityId(run, item.parentBreakdownId, indexByBreakdownId.get(item.parentBreakdownId))
      : undefined
  ));
}

function conservingRunBreakdown(run: ProductionRunV1): RunBreakdownV1[] {
  if ((run.breakdown?.length ?? 0) === 0) {
    return [{
      schemaVersion: 1,
      breakdownId: `brk_${contentHash({ runId: run.runId, kind: "run_usage" })}`,
      kind: "request",
      name: run.model ?? run.models?.[0] ?? "llm_request",
      count: Math.max(1, run.context?.observedLlmRequestCount ?? 1),
      failureCount: 0,
      totalDurationMs: durationMs(run.startedAt, run.endedAt ?? run.startedAt),
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadInputTokens: run.cacheReadInputTokens,
      cacheCreationInputTokens: run.cacheCreationInputTokens,
      reasoningOutputTokens: run.reasoningOutputTokens,
      totalTokens: run.inputTokens + run.outputTokens,
      attributionBasis: "unavailable",
      coverage: "unavailable"
    }];
  }

  const remaining = tokenTotalsForRun(run);
  const normalized = run.breakdown!.map((item) => {
    const usage = breakdownTokenTotals(item);
    if (!usage.present) {
      return item;
    }
    const conserves = usage.valid
      && usage.inputTokens <= remaining.inputTokens
      && usage.outputTokens <= remaining.outputTokens
      && usage.cacheReadInputTokens <= remaining.cacheReadInputTokens
      && usage.cacheCreationInputTokens <= remaining.cacheCreationInputTokens
      && usage.reasoningOutputTokens <= remaining.reasoningOutputTokens;
    if (!conserves) {
      return withoutBreakdownUsage(item);
    }
    remaining.inputTokens -= usage.inputTokens;
    remaining.outputTokens -= usage.outputTokens;
    remaining.cacheReadInputTokens -= usage.cacheReadInputTokens;
    remaining.cacheCreationInputTokens -= usage.cacheCreationInputTokens;
    remaining.reasoningOutputTokens -= usage.reasoningOutputTokens;
    remaining.totalTokens = remaining.inputTokens + remaining.outputTokens;
    return {
      ...item,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      totalTokens: usage.totalTokens
    };
  });
  if (!hasTokenUsage(remaining)) {
    return normalized;
  }
  const hasAttributedUsage = normalized.some((item) => hasTokenUsage(breakdownTokenTotals(item)));
  return [...normalized, {
    schemaVersion: 1,
    breakdownId: `brk_${contentHash({ runId: run.runId, kind: "unallocated" })}`,
    kind: "unallocated",
    name: "Unallocated run usage",
    count: 1,
    failureCount: 0,
    ...remaining,
    attributionBasis: "unavailable",
    coverage: hasAttributedUsage ? "partial" : "unavailable"
  }];
}

function activityFromBreakdown(
  run: ProductionRunV1,
  endedAt: string,
  breakdown: RunBreakdownV1,
  index: number,
  runEvidence: WebhookEvidenceV1,
  parentActivityId?: string
): RunLifecycleActivityWebhookV1 {
  const activityEndedAt = breakdown.totalDurationMs
    ? new Date(Math.min(Date.parse(endedAt), Date.parse(run.startedAt) + breakdown.totalDurationMs)).toISOString()
    : endedAt;
  return {
    activityId: breakdownActivityId(run, breakdown.breakdownId, index),
    ...(parentActivityId ? { parentActivityId } : {}),
    kind: webhookActivityKind(breakdown.kind),
    name: safeActivityName(breakdown.name || breakdown.kind),
    outcome: webhookActivityOutcome(breakdown),
    count: breakdown.count,
    failureCount: breakdown.failureCount,
    ...(breakdown.unknownCount != null ? { unknownCount: breakdown.unknownCount } : {}),
    startedAt: run.startedAt,
    endedAt: activityEndedAt,
    durationMs: breakdown.totalDurationMs,
    resultSizeBytes: breakdown.resultSizeBytes,
    providerReportedResultTokens: breakdown.providerReportedResultTokens,
    inputTokens: breakdown.inputTokens,
    outputTokens: breakdown.outputTokens,
    cacheReadInputTokens: breakdown.cacheReadInputTokens,
    cacheCreationInputTokens: breakdown.cacheCreationInputTokens,
    reasoningOutputTokens: breakdown.reasoningOutputTokens,
    totalTokens: breakdown.totalTokens,
    usageAttributionBasis: breakdown.attributionBasis,
    usageCoverage: breakdown.coverage,
    evidence: runEvidence
  };
}

function breakdownActivityId(run: ProductionRunV1, breakdownId: string, index?: number): string {
  return `activity_${contentHash({ runId: run.runId, breakdownId, index: index ?? -1 }).slice(0, 24)}`;
}

function webhookActivityOutcome(breakdown: RunBreakdownV1): RunLifecycleActivityWebhookV1["outcome"] {
  if (
    breakdown.kind === "unallocated"
    || ((breakdown.kind === "model" || breakdown.kind === "request") && breakdown.attributionBasis === "unavailable")
  ) {
    return "unknown";
  }
  const unknownCount = breakdown.unknownCount ?? 0;
  if (breakdown.failureCount === 0 && unknownCount === 0) {
    return "success";
  }
  return breakdown.failureCount >= breakdown.count && unknownCount === 0 ? "failure" : "unknown";
}

function breakdownTokenTotals(breakdown: RunBreakdownV1): RunTokenTotals & { present: boolean; valid: boolean } {
  const present = breakdown.inputTokens != null
    || breakdown.outputTokens != null
    || breakdown.cacheReadInputTokens != null
    || breakdown.cacheCreationInputTokens != null
    || breakdown.reasoningOutputTokens != null;
  const inputTokens = nonNegativeToken(breakdown.inputTokens);
  const outputTokens = nonNegativeToken(breakdown.outputTokens);
  const valid = [
    breakdown.inputTokens,
    breakdown.outputTokens,
    breakdown.cacheReadInputTokens,
    breakdown.cacheCreationInputTokens,
    breakdown.reasoningOutputTokens
  ].every((value) => value == null || isNonNegativeSafeInteger(value))
    && (breakdown.totalTokens == null
      || (isNonNegativeSafeInteger(breakdown.totalTokens) && breakdown.totalTokens === inputTokens + outputTokens));
  return {
    present,
    valid,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: nonNegativeToken(breakdown.cacheReadInputTokens),
    cacheCreationInputTokens: nonNegativeToken(breakdown.cacheCreationInputTokens),
    reasoningOutputTokens: nonNegativeToken(breakdown.reasoningOutputTokens),
    totalTokens: inputTokens + outputTokens
  };
}

function tokenTotalsForRun(run: ProductionRunV1): RunTokenTotals {
  return {
    inputTokens: nonNegativeToken(run.inputTokens),
    outputTokens: nonNegativeToken(run.outputTokens),
    cacheReadInputTokens: nonNegativeToken(run.cacheReadInputTokens),
    cacheCreationInputTokens: nonNegativeToken(run.cacheCreationInputTokens),
    reasoningOutputTokens: nonNegativeToken(run.reasoningOutputTokens),
    totalTokens: nonNegativeToken(run.inputTokens) + nonNegativeToken(run.outputTokens)
  };
}

function withoutBreakdownUsage(breakdown: RunBreakdownV1): RunBreakdownV1 {
  const {
    inputTokens: _inputTokens,
    outputTokens: _outputTokens,
    cacheReadInputTokens: _cacheReadInputTokens,
    cacheCreationInputTokens: _cacheCreationInputTokens,
    reasoningOutputTokens: _reasoningOutputTokens,
    totalTokens: _totalTokens,
    ...metadata
  } = breakdown;
  return {
    ...metadata,
    attributionBasis: breakdown.kind === "unallocated" ? "unavailable" : "activity_only",
    coverage: "unavailable"
  };
}

function hasTokenUsage(totals: RunTokenTotals): boolean {
  return totals.inputTokens > 0
    || totals.outputTokens > 0
    || totals.cacheReadInputTokens > 0
    || totals.cacheCreationInputTokens > 0
    || totals.reasoningOutputTokens > 0;
}

function nonNegativeToken(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
  if (occurrence.lifecycleVisibility === "internal") {
    return false;
  }
  if (provider === "codex") {
    return occurrence.evidence === "submission_hook";
  }
  if (provider === "github-copilot") {
    return occurrence.evidence === "provider_root_span" || occurrence.evidence === "provider_user_message_event";
  }
  return isPromptStartOccurrence(occurrence);
}

function isExplicitLiveTerminalOccurrence(
  occurrence: QueryOccurrenceV1
): occurrence is QueryOccurrenceV1 & {
  completedAt: string;
  completionEvidence: NonNullable<QueryOccurrenceV1["completionEvidence"]>;
} {
  return typeof occurrence.completedAt === "string"
    && occurrence.completedAt.trim() !== ""
    && occurrence.completionEvidence != null
    && occurrence.completionEvidence !== "inactivity";
}

function liveTerminalEvidenceBasis(
  completionEvidence: NonNullable<QueryOccurrenceV1["completionEvidence"]>,
  signal: SafeObservationV1["signal"]
): WebhookEvidenceV1["basis"] {
  switch (completionEvidence) {
    case "stop_hook":
      return "stop_hook";
    case "session_hook":
      return "session_hook";
    case "closed_root_span":
      return "root_span";
    case "provider_completed_event":
      return signal === "traces" ? "root_span" : "otel_event";
    case "inactivity":
      return "inactivity";
  }
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
    startedAt: subject.startedAt,
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

function projectLiveSubjectRunUpdatedEvent(
  observation: SafeObservationV1,
  repository: WebhookRepositoryV1,
  sender: WebhookSenderV1,
  subject: LiveLifecycleSubject
): RunUpdatedWebhookEventV1 | undefined {
  const corroboratedObservation = suppressCorroboratingLiveUsageDuplicates(observation);
  const subjectQueryIds = new Set(subject.queryIds);
  const events = projectLiveRunUpdatedEvents(corroboratedObservation, repository, sender)
    .filter((projection) => subjectQueryIds.has(projection.queryId))
    .map((projection) => projection.event)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.runId.localeCompare(right.runId));
  const latest = events.at(-1);
  if (!latest) {
    return undefined;
  }
  const activity = mergeLifecycleActivity([], events.flatMap((event) => event.activity));
  const tokenTotals = tokenTotalsFromLifecycleActivity(activity);
  const cost = aggregateLiveRunUpdateCost(events);
  let context = events[0]?.context;
  for (const event of events.slice(1)) {
    context = mergeRunUpdateContextFootprint(context, event.context, tokenTotals, activity);
  }
  return {
    ...latest,
    eventId: eventIdFor("run.update", subject.subjectRunId),
    runId: subject.subjectRunId,
    sessionId: subject.sessionId,
    traceIds: uniqueStrings(events.flatMap((event) => event.traceIds)),
    repository: subject.repository,
    codingHarness: subject.provider,
    runtime: subject.runtime,
    startedAt: subject.startedAt,
    coverage: webhookCoverage(
      tokenTotals.totalTokens > 0 ? "complete_so_far" : "none",
      activity.length > 0 ? "partial" : "none",
      cost.costCoverage
    ),
    sequence: 2,
    updatedAt: latestIso(events.map((event) => event.updatedAt)),
    state: "running",
    ...tokenTotals,
    llmModels: uniqueStrings(events.flatMap((event) => event.llmModels)),
    ...cost,
    ...(context ? { context } : {}),
    activity
  };
}

function liveTerminalUsageCoverage(
  observation: SafeObservationV1,
  totalTokens: number
): WebhookCoverageV1["usageCoverage"] {
  if (totalTokens <= 0) {
    return "none";
  }
  const corroborated = suppressCorroboratingLiveUsageDuplicates(observation);
  const usageByQuery = groupByQueryId(corroborated.usageAtoms);
  if (usageByQuery.size === 0) {
    return "complete_so_far";
  }
  return [...usageByQuery.values()].every((atoms) =>
    atoms.some(isClosedAuthoritativeRunBoundaryAtom)
  )
    ? "final"
    : "complete_so_far";
}

function suppressCorroboratingLiveUsageDuplicates(observation: SafeObservationV1): SafeObservationV1 {
  const requestEvidence = observation.usageAtoms.filter((atom) =>
    atom.authority === "request" || atom.authority === "model"
  );
  if (requestEvidence.length === 0) {
    return observation;
  }
  const duplicateAtomIds = new Set<string>();
  for (const atom of observation.usageAtoms) {
    if (atom.authority !== "event") {
      continue;
    }
    const candidates = requestEvidence.filter((candidate) =>
      corroboratesLiveUsageAtom(atom, candidate)
    );
    if (candidates.length === 1) {
      duplicateAtomIds.add(atom.atomId);
    }
  }
  if (duplicateAtomIds.size === 0) {
    return observation;
  }
  const usageByQuery = groupByQueryId(observation.usageAtoms);
  const fullyCorroboratedQueryIds = new Set<string>();
  for (const [queryId, atoms] of usageByQuery) {
    if (atoms.length > 0 && atoms.every((atom) => duplicateAtomIds.has(atom.atomId))) {
      fullyCorroboratedQueryIds.add(queryId);
    }
  }
  return {
    ...observation,
    usageAtoms: observation.usageAtoms.filter((atom) => !duplicateAtomIds.has(atom.atomId)),
    executionNodes: (observation.executionNodes ?? []).filter((node) =>
      node.nodeKind !== "llm_request" || !fullyCorroboratedQueryIds.has(node.queryId)
    )
  };
}

function corroboratesLiveUsageAtom(event: SafeUsageAtomV1, request: SafeUsageAtomV1): boolean {
  if (
    event.provider !== request.provider
    || event.signal === request.signal
    || event.sourceId === request.sourceId
    || (event.queryId ?? event.correlationId) === (request.queryId ?? request.correlationId)
    || event.billingContext !== request.billingContext
    || (event.model && request.model && event.model !== request.model)
  ) {
    return false;
  }
  const eventCompletedMs = Date.parse(event.endedAt ?? event.startedAt);
  const requestCompletedMs = Date.parse(request.endedAt ?? request.startedAt);
  if (
    !Number.isFinite(eventCompletedMs)
    || !Number.isFinite(requestCompletedMs)
    || Math.abs(eventCompletedMs - requestCompletedMs) > LIVE_USAGE_CORROBORATION_MS
  ) {
    return false;
  }
  return tokenDimensionsEqual(event, request);
}

function groupByQueryId(atoms: SafeUsageAtomV1[]): Map<string, SafeUsageAtomV1[]> {
  const grouped = new Map<string, SafeUsageAtomV1[]>();
  for (const atom of atoms) {
    const queryId = atom.queryId ?? atom.correlationId;
    grouped.set(queryId, [...(grouped.get(queryId) ?? []), atom]);
  }
  return grouped;
}

function tokenDimensionsEqual(left: SafeUsageAtomV1, right: SafeUsageAtomV1): boolean {
  return nonNegativeToken(left.inputTokens) === nonNegativeToken(right.inputTokens)
    && nonNegativeToken(left.outputTokens) === nonNegativeToken(right.outputTokens)
    && nonNegativeToken(left.cacheReadInputTokens) === nonNegativeToken(right.cacheReadInputTokens)
    && nonNegativeToken(left.cacheCreationInputTokens) === nonNegativeToken(right.cacheCreationInputTokens)
    && nonNegativeToken(left.reasoningOutputTokens) === nonNegativeToken(right.reasoningOutputTokens);
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

function observationQueryIds(observation: SafeObservationV1): string[] {
  return uniqueStrings([
    ...(observation.queryOccurrences ?? []).map((occurrence) => occurrence.queryId),
    ...observation.usageAtoms.map((atom) => atom.queryId ?? atom.correlationId),
    ...(observation.activityAtoms ?? []).map((atom) => atom.queryId),
    ...(observation.executionNodes ?? []).map((node) => node.queryId)
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
    // The first delivered lifecycle anchor is public identity. A later usage
    // projection can improve terminal facts, but never move the run's start.
    startedAt: previous.startedAt,
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

function aggregateLiveRunUpdateCost(events: RunUpdatedWebhookEventV1[]): LiveRunUpdateCost {
  const usageEvents = events.filter((event) => event.totalTokens > 0);
  const costs = usageEvents.map(liveRunUpdateCostFromEvent);
  const priced = costs.filter((cost) => cost.costCoverage !== "unavailable");
  if (priced.length === 0) {
    return unavailableLiveRunUpdateCost();
  }
  const bases = uniqueStrings(priced.map((cost) => cost.costEstimateBasis)
    .filter((basis) => basis !== "unavailable"));
  const usageValues = priced
    .map((cost) => cost.usageValueNanoUsd)
    .filter((value): value is number => typeof value === "number");
  return {
    estimatedNanoUsd: sumOptionalNumbers(priced.map((cost) => cost.estimatedNanoUsd)),
    ...(usageValues.length > 0 ? { usageValueNanoUsd: sumOptionalNumbers(usageValues) } : {}),
    costEstimateBasis: bases.length === 1
      ? bases[0] as CostEstimateBasis
      : "unavailable",
    costCoverage: priced.length === usageEvents.length
      && priced.every((cost) => cost.costCoverage === "complete")
      ? "complete"
      : "partial"
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
  return activity.reduce((count, item) =>
    count + (item.kind === "llm_request"
      && (
        (item.inputTokens ?? 0) > 0
        || (item.cacheReadInputTokens ?? 0) > 0
        || (item.cacheCreationInputTokens ?? 0) > 0
      )
      ? (item.count ?? 1)
      : 0), 0);
}

function liveRunUpdateEventId(event: RunUpdatedWebhookEventV1): string {
  const { eventId: _eventId, ...meaning } = event;
  return eventIdFor("run.update", contentHash(meaning));
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
    count: 1,
    failureCount: atom.outcome === "failure" || atom.outcome === "rejected" ? 1 : 0,
    unknownCount: atom.outcome === "unknown" ? 1 : 0,
    startedAt: atom.startedAt,
    endedAt: atom.endedAt,
    durationMs: atom.durationMs,
    resultSizeBytes: atom.resultSizeBytes,
    providerReportedResultTokens: atom.providerReportedResultTokens,
    usageAttributionBasis: "activity_only",
    usageCoverage: "unavailable",
    evidence: webhookEvidenceForActivityAtom(atom, observation)
  }));
  const llmNodes = executionNodes.filter((node) => node.nodeKind === "llm_request");
  const activityScopeId = liveActivityAuthorityScopeId(queryId, usageAtoms, llmNodes);
  if (llmNodes.length > 0 && usageAtoms.length > 0) {
    const llmNode = llmNodes[0];
    const requestCount = liveLlmRequestCount(usageAtoms, llmNodes);
    const failureCount = Math.min(
      requestCount,
      llmNodes.filter((node) => node.outcome === "failure" || node.outcome === "rejected").length
    );
    return conserveLiveActivityUsage([...fromActivities, {
      activityId: liveLlmActivityId(activityScopeId),
      kind: "llm_request",
      name: safeActivityName(uniqueStrings(llmNodes.flatMap((node) => node.model ? [node.model] : [])).at(0) ?? llmNode.name),
      outcome: failureCount === 0
        ? (llmNodes.every((node) => node.outcome === "success") ? "success" : "unknown")
        : failureCount === llmNodes.length
          ? "failure"
          : "unknown",
      count: requestCount,
      failureCount,
      startedAt: earliestIso(llmNodes.map((node) => node.startedAt)),
      endedAt: latestIso(llmNodes.flatMap((node) => [node.endedAt, node.startedAt]).filter((value): value is string => Boolean(value))),
      ...usageTokenTotals(usageAtoms, executionNodes),
      usageAttributionBasis: "provider_reported",
      usageCoverage: "complete",
      evidence: webhookEvidence("trace_span", llmNode.nodeId, observation.observedAt, false)
    }], usageTokenTotals(usageAtoms, executionNodes), queryId, observation, executionNodes, activityScopeId);
  }
  if (llmNodes.length > 0) {
    const llmNode = llmNodes[0];
    const requestCount = liveLlmRequestCount(usageAtoms, llmNodes);
    const failureCount = Math.min(
      requestCount,
      llmNodes.filter((node) => node.outcome === "failure" || node.outcome === "rejected").length
    );
    return conserveLiveActivityUsage([...fromActivities, {
      activityId: liveLlmActivityId(activityScopeId),
      kind: "llm_request",
      name: safeActivityName(uniqueStrings(llmNodes.flatMap((node) => node.model ? [node.model] : [])).at(0) ?? llmNode.name),
      outcome: failureCount === 0
        ? (llmNodes.every((node) => node.outcome === "success") ? "success" : "unknown")
        : failureCount === requestCount ? "failure" : "unknown",
      count: requestCount,
      failureCount,
      startedAt: earliestIso(llmNodes.map((node) => node.startedAt)),
      endedAt: latestIsoOptional(llmNodes.flatMap((node) => [node.endedAt, node.startedAt])),
      usageAttributionBasis: "provider_reported",
      usageCoverage: "complete",
      evidence: webhookEvidence("trace_span", llmNode.nodeId, observation.observedAt, false)
    }], usageTokenTotals(usageAtoms, executionNodes), queryId, observation, executionNodes, activityScopeId);
  }
  if (usageAtoms.length === 0) {
    return conserveLiveActivityUsage(
      fromActivities,
      usageTokenTotals(usageAtoms, executionNodes),
      queryId,
      observation,
      executionNodes,
      activityScopeId
    );
  }
  const totals = usageTokenTotals(usageAtoms, executionNodes);
  return conserveLiveActivityUsage([...fromActivities, {
    activityId: liveLlmActivityId(activityScopeId),
    kind: "llm_request",
    name: usageAtoms.find((atom) => atom.model)?.model ?? "llm_request",
    outcome: "unknown",
    count: Math.max(1, new Set(usageAtoms.map((atom) => atom.requestId ?? atom.atomId)).size),
    failureCount: 0,
    startedAt: earliestIso(usageAtoms.map((atom) => atom.startedAt)),
    endedAt: latestIso(usageAtoms.flatMap((atom) => [atom.endedAt, atom.startedAt]).filter((value): value is string => Boolean(value))),
    ...totals,
    usageAttributionBasis: "provider_reported",
    usageCoverage: "complete",
    evidence: webhookEvidence("provider_metric", queryId, observation.observedAt, false)
  }], totals, queryId, observation, executionNodes, activityScopeId);
}

function liveLlmRequestCount(
  usageAtoms: SafeUsageAtomV1[],
  llmNodes: NonNullable<SafeObservationV1["executionNodes"]>
): number {
  const requestAuthorities = usageAtoms.filter((atom) => atom.authority === "request" || atom.authority === "model");
  if (requestAuthorities.length > 0) {
    return Math.max(1, new Set(requestAuthorities.map((atom) => atom.requestId ?? atom.atomId)).size);
  }
  if (usageAtoms.length > 0) {
    return Math.max(1, new Set(usageAtoms.map((atom) => atom.requestId ?? atom.atomId)).size);
  }
  return Math.max(1, new Set(llmNodes.map((node) => node.requestId ?? node.nodeId)).size);
}

function conserveLiveActivityUsage(
  activity: RunLifecycleActivityWebhookV1[],
  totals: RunTokenTotals,
  queryId: string,
  observation: SafeObservationV1,
  executionNodes: NonNullable<SafeObservationV1["executionNodes"]>,
  activityScopeId: string
): RunLifecycleActivityWebhookV1[] {
  const allocated = tokenTotalsFromLifecycleActivity(activity);
  const overAllocated = allocated.inputTokens > totals.inputTokens
    || allocated.outputTokens > totals.outputTokens
    || allocated.cacheReadInputTokens > totals.cacheReadInputTokens
    || allocated.cacheCreationInputTokens > totals.cacheCreationInputTokens
    || allocated.reasoningOutputTokens > totals.reasoningOutputTokens;
  const normalized = overAllocated ? activity.map(withoutLifecycleActivityUsage) : activity;
  const normalizedAllocated = overAllocated ? tokenTotalsFromLifecycleActivity(normalized) : allocated;
  const remaining: RunTokenTotals = {
    inputTokens: Math.max(0, totals.inputTokens - normalizedAllocated.inputTokens),
    outputTokens: Math.max(0, totals.outputTokens - normalizedAllocated.outputTokens),
    cacheReadInputTokens: Math.max(0, totals.cacheReadInputTokens - normalizedAllocated.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(0, totals.cacheCreationInputTokens - normalizedAllocated.cacheCreationInputTokens),
    reasoningOutputTokens: Math.max(0, totals.reasoningOutputTokens - normalizedAllocated.reasoningOutputTokens),
    totalTokens: Math.max(0, totals.inputTokens - normalizedAllocated.inputTokens)
      + Math.max(0, totals.outputTokens - normalizedAllocated.outputTokens)
  };
  if (!hasTokenUsage(remaining)) {
    return normalized;
  }
  const startedAt = earliestIso([
    ...normalized.map((item) => item.startedAt),
    ...executionNodes.map((node) => node.startedAt),
    observation.observedAt
  ]);
  return [...normalized, {
    activityId: liveUnallocatedActivityId(activityScopeId),
    kind: "unknown",
    name: "Unallocated run usage",
    outcome: "unknown",
    count: 1,
    failureCount: 0,
    startedAt,
    endedAt: latestIso([
      ...normalized.flatMap((item) => [item.endedAt, item.startedAt]).filter((value): value is string => Boolean(value)),
      ...executionNodes.flatMap((node) => [node.endedAt, node.startedAt]).filter((value): value is string => Boolean(value)),
      observation.observedAt
    ]),
    ...remaining,
    usageAttributionBasis: "unavailable",
    usageCoverage: normalized.some(hasLiveActivityUsage) ? "partial" : "unavailable",
    evidence: webhookEvidence(
      observation.signal === "traces" ? "trace_span" : observation.signal === "metrics" ? "provider_metric" : "otel_event",
      queryId,
      observation.observedAt,
      false,
      observation.profileVersion
    )
  }];
}

function liveActivityAuthorityScopeId(
  queryId: string,
  usageAtoms: SafeUsageAtomV1[],
  executionNodes: NonNullable<SafeObservationV1["executionNodes"]>
): string {
  const usageSessions = uniqueStrings(usageAtoms.flatMap((atom) => atom.sessionId ? [atom.sessionId] : []));
  const nodeSessions = uniqueStrings(executionNodes.flatMap((node) => node.sessionId ? [node.sessionId] : []));
  const sessionId = usageSessions.length === 1
    ? usageSessions[0]
    : usageSessions.length === 0 && nodeSessions.length === 1
      ? nodeSessions[0]
      : undefined;
  return sessionId ? `${queryId}|${sessionId}` : queryId;
}

function liveLlmActivityId(activityScopeId: string): string {
  return `activity_${contentHash({ activityScopeId, kind: "llm_request" }).slice(0, 24)}`;
}

function liveUnallocatedActivityId(activityScopeId: string): string {
  return `activity_${contentHash({ activityScopeId, kind: "unallocated_live_usage" }).slice(0, 24)}`;
}

function withoutLifecycleActivityUsage(
  activity: RunLifecycleActivityWebhookV1
): RunLifecycleActivityWebhookV1 {
  const {
    inputTokens: _inputTokens,
    outputTokens: _outputTokens,
    cacheReadInputTokens: _cacheReadInputTokens,
    cacheCreationInputTokens: _cacheCreationInputTokens,
    reasoningOutputTokens: _reasoningOutputTokens,
    totalTokens: _totalTokens,
    ...metadata
  } = activity;
  return {
    ...metadata,
    usageAttributionBasis: activity.kind === "unknown" ? "unavailable" : "activity_only",
    usageCoverage: "unavailable"
  };
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
  if (usageAtoms.length > 0) {
    const projected = LIVE_UPDATE_USAGE_PIPELINE.project(
      usageAtoms,
      new Date(latestIso(usageAtoms.flatMap((atom) => [atom.endedAt, atom.startedAt]).filter((value): value is string => Boolean(value))))
    )[0];
    if (projected) {
      return tokenTotalsForRun(projected);
    }
  }
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
  if (usingUsageAtoms) {
    const projected = LIVE_UPDATE_USAGE_PIPELINE.project(
      usageAtoms,
      new Date(latestIso(usageAtoms.flatMap((atom) => [atom.endedAt, atom.startedAt]).filter((value): value is string => Boolean(value))))
    )[0];
    if (projected?.context) {
      return { ...projected.context, coverage };
    }
  }
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

function liveSourceOverlapsSubject(
  source: Pick<SafeUsageAtomV1, "startedAt" | "endedAt">,
  subject: LiveLifecycleSubject
): boolean {
  const subjectStart = Date.parse(subject.startedAt);
  const sourceEnd = Date.parse(source.endedAt ?? source.startedAt);
  return Number.isFinite(subjectStart) && Number.isFinite(sourceEnd) && sourceEnd >= subjectStart;
}

function canonicalLiveUsageAtom(atom: SafeUsageAtomV1, subject: LiveLifecycleSubject): SafeUsageAtomV1 {
  return {
    ...atom,
    startedAt: clampLiveSourceStart(atom.startedAt, subject.startedAt),
    endedAt: atom.endedAt ? clampLiveSourceStart(atom.endedAt, subject.startedAt) : undefined
  };
}

function canonicalLiveActivityAtom(atom: SafeActivityAtomV1, subject: LiveLifecycleSubject): SafeActivityAtomV1 {
  const startedAt = clampLiveSourceStart(atom.startedAt, subject.startedAt);
  const endedAt = atom.endedAt ? clampLiveSourceStart(atom.endedAt, startedAt) : undefined;
  return {
    ...atom,
    startedAt,
    endedAt,
    durationMs: endedAt ? durationMs(startedAt, endedAt) : atom.durationMs
  };
}

function canonicalLiveExecutionNode(
  node: NonNullable<SafeObservationV1["executionNodes"]>[number],
  subject: LiveLifecycleSubject
): NonNullable<SafeObservationV1["executionNodes"]>[number] {
  const startedAt = clampLiveSourceStart(node.startedAt, subject.startedAt);
  const endedAt = node.endedAt ? clampLiveSourceStart(node.endedAt, startedAt) : undefined;
  return {
    ...node,
    startedAt,
    endedAt,
    durationMs: endedAt ? durationMs(startedAt, endedAt) : node.durationMs
  };
}

function clampLiveSourceStart(value: string, lowerBound: string): string {
  return Date.parse(value) >= Date.parse(lowerBound) ? value : lowerBound;
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

function aggregateWebhookRun(
  currentRun: ProductionRunV1,
  runs: ProductionRunV1[],
  subjectRunId = currentRun.runId
): ProductionRunV1 {
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
  const inputTokens = ordered.reduce((sum, run) => sum + run.inputTokens, 0);
  const outputTokens = ordered.reduce((sum, run) => sum + run.outputTokens, 0);
  const cacheReadInputTokens = ordered.reduce((sum, run) => sum + run.cacheReadInputTokens, 0);
  const cacheCreationInputTokens = ordered.reduce((sum, run) => sum + run.cacheCreationInputTokens, 0);
  const reasoningOutputTokens = ordered.reduce((sum, run) => sum + run.reasoningOutputTokens, 0);
  return {
    ...currentRun,
    runId: subjectRunId,
    correlationId: subjectRunId,
    queryId: subjectRunId,
    startedAt: ordered[0].startedAt,
    endedAt: ordered.map((run) => run.endedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? currentRun.endedAt,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedNanoUsd,
    usageValueNanoUsd,
    costEstimateBasis: aggregateCostEstimateBasis(pricedRuns),
    costCoverage,
    toolCallCount: ordered.reduce((sum, run) => sum + (run.toolCallCount ?? 0), 0),
    breakdown: aggregateRunBreakdown(ordered, subjectRunId),
    ...(context ? { context } : {}),
    models: uniqueStrings(ordered.flatMap((run) => run.models ?? (run.model ? [run.model] : [])))
  };
}

function aggregateRunBreakdown(runs: ProductionRunV1[], subjectRunId: string): RunBreakdownV1[] {
  const grouped = new Map<string, RunBreakdownV1[]>();
  for (const run of runs) {
    for (const breakdown of conservingRunBreakdown(run)) {
      const key = `${breakdown.kind}:${breakdown.name}`;
      grouped.set(key, [...(grouped.get(key) ?? []), breakdown]);
    }
  }
  return [...grouped.entries()]
    .map(([key, group]): RunBreakdownV1 => {
      const inputTokens = group.reduce((sum, item) => sum + nonNegativeToken(item.inputTokens), 0);
      const outputTokens = group.reduce((sum, item) => sum + nonNegativeToken(item.outputTokens), 0);
      const cacheReadInputTokens = group.reduce((sum, item) => sum + nonNegativeToken(item.cacheReadInputTokens), 0);
      const cacheCreationInputTokens = group.reduce((sum, item) => sum + nonNegativeToken(item.cacheCreationInputTokens), 0);
      const reasoningOutputTokens = group.reduce((sum, item) => sum + nonNegativeToken(item.reasoningOutputTokens), 0);
      const hasUsage = group.some((item) => breakdownTokenTotals(item).present);
      const attributionBases = uniqueStrings(group.map((item) => item.attributionBasis));
      return {
        schemaVersion: 1,
        breakdownId: `brk_${contentHash({ subjectRunId, key })}`,
        kind: group[0].kind,
      name: group[0].name,
      count: group.reduce((sum, item) => sum + item.count, 0),
      failureCount: group.reduce((sum, item) => sum + item.failureCount, 0),
      ...(group.some((item) => item.unknownCount != null) ? {
        unknownCount: group.reduce((sum, item) => sum + (item.unknownCount ?? 0), 0)
      } : {}),
        ...sumOptionalBreakdownField(group, "totalDurationMs"),
        ...sumOptionalBreakdownField(group, "resultSizeBytes"),
        ...sumOptionalBreakdownField(group, "providerReportedResultTokens"),
        ...(hasUsage ? {
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens,
          reasoningOutputTokens,
          totalTokens: inputTokens + outputTokens
        } : {}),
        attributionBasis: attributionBases.length === 1
          ? attributionBases[0] as RunBreakdownV1["attributionBasis"]
          : "unavailable",
        coverage: aggregateBreakdownCoverage(group)
      };
    })
    .sort((left, right) =>
      left.kind === "unallocated"
        ? 1
        : right.kind === "unallocated"
          ? -1
          : right.count - left.count || left.name.localeCompare(right.name)
    );
}

function sumOptionalBreakdownField(
  breakdown: RunBreakdownV1[],
  field: "totalDurationMs" | "resultSizeBytes" | "providerReportedResultTokens"
): Partial<Pick<RunBreakdownV1, typeof field>> {
  const values = breakdown
    .map((item) => item[field])
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return values.length > 0 ? { [field]: values.reduce((sum, value) => sum + value, 0) } : {};
}

function aggregateBreakdownCoverage(group: RunBreakdownV1[]): RunBreakdownV1["coverage"] {
  if (group.every((item) => item.coverage === "complete")) {
    return "complete";
  }
  if (group.some((item) => item.coverage !== "unavailable" || hasTokenUsage(breakdownTokenTotals(item)))) {
    return "partial";
  }
  return "unavailable";
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

function normalizeRunEndedDraft(event: RunEndedWebhookEventDraft): RunEndedWebhookEventDraft {
  const startedAt = earliestIso([event.startedAt, event.endedAt]);
  const endedAt = latestIso([startedAt, event.endedAt]);
  const boundedActivity = (event.activity ?? []).map((activity) =>
    normalizeTerminalActivityBounds(activity, startedAt, endedAt)
  );
  const normalized: RunEndedWebhookEventDraft = {
    ...event,
    startedAt,
    endedAt,
    activity: boundedActivity
  };
  return {
    ...normalized,
    activity: conserveTerminalActivityUsage(normalized, boundedActivity)
  };
}

function monotonicRunEndedRevision(
  previous: RunEndedWebhookEventV1,
  next: RunEndedWebhookEventDraft
): RunEndedWebhookEventDraft {
  const preferredCost = preferredTerminalCost(previous, next);
  const preferredUsage = preferredTerminalUsage(previous, next);
  const coverage = mergeTerminalCoverage(previous.coverage, next.coverage);
  const preferredContext = preferredTerminalContext(previous.context, next.context);
  const merged: RunEndedWebhookEventDraft = {
    ...next,
    sessionId: preferredTerminalSessionId(previous.sessionId, next.sessionId),
    repository: repositoryIdentityScore(previous.repository) >= repositoryIdentityScore(next.repository)
      ? previous.repository
      : next.repository,
    startedAt: earliestIso([previous.startedAt, next.startedAt]),
    endedAt: latestIso([previous.endedAt, next.endedAt]),
    evidence: preferredWebhookEvidence(previous.evidence, next.evidence),
    coverage,
    inputTokens: preferredUsage.inputTokens,
    outputTokens: preferredUsage.outputTokens,
    cacheReadInputTokens: preferredUsage.cacheReadInputTokens,
    cacheCreationInputTokens: preferredUsage.cacheCreationInputTokens,
    reasoningOutputTokens: preferredUsage.reasoningOutputTokens,
    totalTokens: preferredUsage.inputTokens + preferredUsage.outputTokens,
    traceIds: uniqueStrings([...previous.traceIds, ...next.traceIds]),
    filesChanged: safeRepoRelativePaths([...previous.filesChanged, ...next.filesChanged]),
    llmModels: uniqueStrings([...previous.llmModels, ...next.llmModels]),
    estimatedNanoUsd: preferredCost.estimatedNanoUsd,
    usageValueNanoUsd: preferredCost.usageValueNanoUsd,
    costEstimateBasis: preferredCost.costEstimateBasis,
    costCoverage: preferredCost.costCoverage,
    // Context is optional. Never relabel a provisional footprint as final merely
    // because final usage arrived from another telemetry surface.
    context: preferredContext?.coverage === coverage.usageCoverage ? preferredContext : undefined,
    activity: mergeTerminalActivity(previous.activity ?? [], next.activity ?? [])
  };
  return normalizeRunEndedDraft(merged);
}

function preferredTerminalUsage(
  previous: RunEndedWebhookEventV1,
  next: RunEndedWebhookEventDraft
): RunEndedWebhookEventV1 | RunEndedWebhookEventDraft {
  if (next.endedAt !== previous.endedAt) {
    return next.endedAt > previous.endedAt ? next : previous;
  }
  return compareTerminalUsage(next, previous) > 0 ? next : previous;
}

function compareTerminalUsage(
  left: RunEndedWebhookEventDraft | RunEndedWebhookEventV1,
  right: RunEndedWebhookEventDraft | RunEndedWebhookEventV1
): number {
  const tuple = (event: RunEndedWebhookEventDraft | RunEndedWebhookEventV1): number[] => {
    const detailedUsageDimensions = [
      event.cacheReadInputTokens,
      event.cacheCreationInputTokens,
      event.reasoningOutputTokens
    ].filter((value) => value > 0).length;
    return [
      terminalUsageCoverageRank(event.coverage.usageCoverage),
      event.totalTokens,
      detailedUsageDimensions,
      event.cacheReadInputTokens + event.cacheCreationInputTokens + event.reasoningOutputTokens,
      event.cacheReadInputTokens,
      event.cacheCreationInputTokens,
      event.reasoningOutputTokens,
      event.inputTokens,
      event.outputTokens
    ];
  };
  const leftTuple = tuple(left);
  const rightTuple = tuple(right);
  for (let index = 0; index < leftTuple.length; index += 1) {
    if (leftTuple[index] !== rightTuple[index]) {
      return leftTuple[index] > rightTuple[index] ? 1 : -1;
    }
  }
  return 0;
}

function preferredTerminalSessionId(previous: string, next: string): string {
  const previousScore = terminalSessionIdScore(previous);
  const nextScore = terminalSessionIdScore(next);
  return nextScore > previousScore ? next : previous;
}

function terminalSessionIdScore(sessionId: string): number {
  return sessionId.startsWith("ses_")
    ? 3
    : sessionId.startsWith("qry_") || sessionId.startsWith("run_")
      ? 1
      : 2;
}

function preferredTerminalCost(
  previous: RunEndedWebhookEventV1,
  next: RunEndedWebhookEventDraft
): RunEndedWebhookEventV1 | RunEndedWebhookEventDraft {
  const previousScore = terminalCostScore(previous);
  const nextScore = terminalCostScore(next);
  if (nextScore !== previousScore) {
    return nextScore > previousScore ? next : previous;
  }
  const usageChanged = next.inputTokens !== previous.inputTokens
    || next.outputTokens !== previous.outputTokens
    || next.cacheReadInputTokens !== previous.cacheReadInputTokens
    || next.cacheCreationInputTokens !== previous.cacheCreationInputTokens
    || next.reasoningOutputTokens !== previous.reasoningOutputTokens;
  return usageChanged || next.endedAt > previous.endedAt ? next : previous;
}

function terminalCostScore(event: RunEndedWebhookEventDraft | RunEndedWebhookEventV1): number {
  return costCoverageRank(event.costCoverage) * 100
    + (event.usageValueNanoUsd != null ? 10 : 0)
    + (event.costEstimateBasis !== "unavailable" ? 4 : 0)
    + (event.estimatedNanoUsd > 0 ? 1 : 0);
}

function normalizeTerminalActivityBounds(
  activity: RunLifecycleActivityWebhookV1,
  runStartedAt: string,
  runEndedAt: string
): RunLifecycleActivityWebhookV1 {
  const startedAt = clampIso(activity.startedAt, runStartedAt, runEndedAt);
  const endedAt = activity.endedAt ? clampIso(activity.endedAt, startedAt, runEndedAt) : undefined;
  return {
    ...activity,
    startedAt,
    endedAt,
    durationMs: endedAt ? durationMs(startedAt, endedAt) : activity.durationMs
  };
}

function clampIso(value: string, lowerBound: string, upperBound: string): string {
  const valueMs = Date.parse(value);
  const lowerMs = Date.parse(lowerBound);
  const upperMs = Date.parse(upperBound);
  if (!Number.isFinite(valueMs) || !Number.isFinite(lowerMs) || !Number.isFinite(upperMs)) {
    return lowerBound;
  }
  return new Date(Math.min(Math.max(valueMs, lowerMs), upperMs)).toISOString();
}

function mergeTerminalActivity(
  previous: RunLifecycleActivityWebhookV1[],
  next: RunLifecycleActivityWebhookV1[]
): RunLifecycleActivityWebhookV1[] {
  // Final breakdown rows group the same safe observations that a provisional
  // terminal exposed individually. Replace that semantic slice before the ID
  // merge so terminal versions never add the two representations together.
  const previousAuthoritativeSemanticKeys = new Set(previous
    .filter((activity) => activity.evidence.basis === "usage_projection" && !isUnallocatedTerminalActivity(activity))
    .map(terminalActivitySemanticKey));
  const nextAuthoritativeSemanticKeys = new Set(next
    .filter((activity) => activity.evidence.basis === "usage_projection" && !isUnallocatedTerminalActivity(activity))
    .map(terminalActivitySemanticKey));
  const byIdentity = new Map<string, RunLifecycleActivityWebhookV1>();
  for (const activity of previous) {
    const semanticKey = terminalActivitySemanticKey(activity);
    if (
      nextAuthoritativeSemanticKeys.has(semanticKey)
      || (previousAuthoritativeSemanticKeys.has(semanticKey) && activity.evidence.basis !== "usage_projection")
    ) {
      continue;
    }
    byIdentity.set(terminalActivityIdentity(activity), activity);
  }
  for (const activity of next) {
    const semanticKey = terminalActivitySemanticKey(activity);
    if (
      previousAuthoritativeSemanticKeys.has(semanticKey)
      && !nextAuthoritativeSemanticKeys.has(semanticKey)
      && activity.evidence.basis !== "usage_projection"
    ) {
      continue;
    }
    const identity = terminalActivityIdentity(activity);
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, existing ? mergeTerminalActivityRow(existing, activity) : activity);
  }
  return reconcileTerminalSubagentAggregateUsage(previous, next, [...byIdentity.values()])
    .sort(compareLifecycleActivity);
}

function reconcileTerminalSubagentAggregateUsage(
  previous: RunLifecycleActivityWebhookV1[],
  next: RunLifecycleActivityWebhookV1[],
  activity: RunLifecycleActivityWebhookV1[]
): RunLifecycleActivityWebhookV1[] {
  const observedSubagents = groupTerminalSubagentsBySemanticKey([
    ...new Map([...previous, ...next]
      .filter((item) => item.kind === "subagent" && item.evidence.basis !== "usage_projection")
      .map((item) => [item.activityId, item])).values()
  ]);
  const authoritativeSubagents = groupTerminalSubagentsBySemanticKey(activity.filter((item) =>
    item.evidence.basis === "usage_projection"
  ));
  const previousAuthoritativeSubagents = groupTerminalSubagentsBySemanticKey(previous.filter((item) =>
    item.evidence.basis === "usage_projection"
  ));
  const parentAliases = new Map<string, string>();
  for (const [semanticKey, prior] of observedSubagents) {
    const authoritative = authoritativeSubagents.get(semanticKey) ?? [];
    if (
      authoritative.length === 1
      && prior.reduce((count, item) => count + (item.count ?? 1), 0) === (authoritative[0].count ?? 1)
    ) {
      for (const item of prior) {
        parentAliases.set(item.activityId, authoritative[0].activityId);
      }
    }
  }
  const remapped = activity.map((item) => {
    const parentActivityId = item.parentActivityId ? parentAliases.get(item.parentActivityId) : undefined;
    return parentActivityId ? { ...item, parentActivityId } : item;
  });
  const duplicateParents = new Map<string, string>();
  const residualUsageByActivityId = new Map<string, {
    usage: RunTokenTotals;
    consumedCount: number;
    consumedFailureCount: number;
  }>();
  const claimedLlmIds = new Set<string>();
  const verifiedSubagentIds = new Set<string>();
  const authoritativeUnallocated = activity.filter(isUnallocatedTerminalActivity);
  for (const [semanticKey, authoritative] of authoritativeSubagents) {
    const prior = observedSubagents.get(semanticKey) ?? [];
    if (authoritative.length !== 1) {
      continue;
    }
    const authoritativeSubagent = authoritative[0];
    const expectedChildCount = authoritativeSubagent.count ?? 1;
    const usageKey = terminalActivityUsageKey(authoritativeSubagent);
    if (!usageKey) {
      continue;
    }
    const previousAuthoritative = previousAuthoritativeSubagents.get(semanticKey) ?? [];
    const authoritativeUsageIsVerified = (
      (
        authoritativeSubagent.usageAttributionBasis === "trace_descendant"
        && authoritativeSubagent.usageCoverage === "complete"
      )
      || (
        previousAuthoritative.length === 1
        && previousAuthoritative[0].usageAttributionBasis === "trace_descendant"
        && previousAuthoritative[0].usageCoverage === "complete"
        && terminalActivityUsageKey(previousAuthoritative[0]) === usageKey
      )
    );
    if (authoritativeUsageIsVerified) {
      verifiedSubagentIds.add(authoritativeSubagent.activityId);
    }
    if (
      expectedChildCount < 1
      || prior.length !== expectedChildCount
      || prior.some((item) => (item.count ?? 1) !== 1)
    ) {
      continue;
    }
    const childUsage = lifecycleActivityTokenTotals(authoritativeSubagent);
    if (!childUsage.present || !childUsage.valid) {
      continue;
    }
    const candidates = remapped.filter((item) =>
      item.kind === "llm_request"
      && item.evidence.basis !== "usage_projection"
      && !claimedLlmIds.has(item.activityId)
      && (
        item.parentActivityId === authoritativeSubagent.activityId
        || (!item.parentActivityId && prior.some((subagent) => terminalSubagentLineageIsPlausible(subagent, item)))
      )
    );
    const linkedIds = new Set(candidates
      .filter((item) => item.parentActivityId === authoritativeSubagent.activityId)
      .map((item) => item.activityId));
    const exactChildren = uniqueTerminalActivityUsageSubset(
      candidates,
      expectedChildCount,
      childUsage,
      linkedIds
    );
    if (
      exactChildren
      && terminalSubagentLineageSetIsPlausible(prior, exactChildren, authoritativeSubagent.activityId)
    ) {
      for (const child of exactChildren) {
        duplicateParents.set(child.activityId, authoritativeSubagent.activityId);
        claimedLlmIds.add(child.activityId);
      }
      verifiedSubagentIds.add(authoritativeSubagent.activityId);
      continue;
    }
    const tokenlessChildren = candidates.filter((item) => !lifecycleActivityTokenTotals(item).present);
    if (
      authoritativeUsageIsVerified
      && tokenlessChildren.length === expectedChildCount
      && terminalSubagentLineageSetIsPlausible(prior, tokenlessChildren, authoritativeSubagent.activityId)
    ) {
      for (const child of tokenlessChildren) {
        duplicateParents.set(child.activityId, authoritativeSubagent.activityId);
        claimedLlmIds.add(child.activityId);
      }
      continue;
    }
    if (expectedChildCount !== 1 || authoritativeUnallocated.length !== 1) {
      continue;
    }
    const unallocatedUsage = lifecycleActivityTokenTotals(authoritativeUnallocated[0]);
    if (!unallocatedUsage.present || !unallocatedUsage.valid || tokenlessChildren.length !== 1) {
      continue;
    }
    const cumulativeParents = remapped.filter((item) =>
      item.kind === "llm_request"
      && item.evidence.basis !== "usage_projection"
      && !item.parentActivityId
      && !claimedLlmIds.has(item.activityId)
      && terminalActivityUsageEqualsSum(item, childUsage, unallocatedUsage)
    );
    if (cumulativeParents.length !== 1) {
      continue;
    }
    duplicateParents.set(tokenlessChildren[0].activityId, authoritativeSubagent.activityId);
    residualUsageByActivityId.set(cumulativeParents[0].activityId, {
      usage: {
        inputTokens: unallocatedUsage.inputTokens,
        outputTokens: unallocatedUsage.outputTokens,
        cacheReadInputTokens: unallocatedUsage.cacheReadInputTokens,
        cacheCreationInputTokens: unallocatedUsage.cacheCreationInputTokens,
        reasoningOutputTokens: unallocatedUsage.reasoningOutputTokens,
        totalTokens: unallocatedUsage.totalTokens
      },
      consumedCount: tokenlessChildren[0].count ?? 1,
      consumedFailureCount: tokenlessChildren[0].failureCount ?? 0
    });
    claimedLlmIds.add(tokenlessChildren[0].activityId);
    claimedLlmIds.add(cumulativeParents[0].activityId);
    verifiedSubagentIds.add(authoritativeSubagent.activityId);
  }
  let consumeAuthoritativeUnallocated = false;
  if (duplicateParents.size > 0 && authoritativeUnallocated.length === 1) {
    const unallocatedUsage = lifecycleActivityTokenTotals(authoritativeUnallocated[0]);
    const rootCandidates = remapped.filter((item) =>
      item.kind === "llm_request"
      && item.evidence.basis !== "usage_projection"
      && !item.parentActivityId
      && !claimedLlmIds.has(item.activityId)
      && !duplicateParents.has(item.activityId)
      && !residualUsageByActivityId.has(item.activityId)
    );
    if (unallocatedUsage.present && unallocatedUsage.valid && rootCandidates.length === 1) {
      residualUsageByActivityId.set(rootCandidates[0].activityId, {
        usage: {
          inputTokens: unallocatedUsage.inputTokens,
          outputTokens: unallocatedUsage.outputTokens,
          cacheReadInputTokens: unallocatedUsage.cacheReadInputTokens,
          cacheCreationInputTokens: unallocatedUsage.cacheCreationInputTokens,
          reasoningOutputTokens: unallocatedUsage.reasoningOutputTokens,
          totalTokens: unallocatedUsage.totalTokens
        },
        consumedCount: 0,
        consumedFailureCount: 0
      });
      consumeAuthoritativeUnallocated = true;
    }
  }
  return remapped.filter((item) =>
    !consumeAuthoritativeUnallocated || !isUnallocatedTerminalActivity(item)
  ).map((item) => {
    if (verifiedSubagentIds.has(item.activityId)) {
      return {
        ...item,
        usageAttributionBasis: "trace_descendant",
        usageCoverage: "complete"
      };
    }
    const parentActivityId = duplicateParents.get(item.activityId);
    if (parentActivityId) {
      return { ...withoutLifecycleActivityUsage(item), parentActivityId };
    }
    const residual = residualUsageByActivityId.get(item.activityId);
    if (!residual) {
      return item;
    }
    const count = Math.max(1, (item.count ?? 1) - residual.consumedCount);
    const failureCount = Math.min(
      count,
      Math.max(0, (item.failureCount ?? 0) - residual.consumedFailureCount)
    );
    return {
      ...item,
      count,
      failureCount,
      ...residual.usage
    };
  });
}

function groupTerminalSubagentsBySemanticKey(
  activity: RunLifecycleActivityWebhookV1[]
): Map<string, RunLifecycleActivityWebhookV1[]> {
  const grouped = new Map<string, RunLifecycleActivityWebhookV1[]>();
  for (const item of activity) {
    if (item.kind !== "subagent") {
      continue;
    }
    const key = terminalActivitySemanticKey(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function terminalSubagentLineageIsPlausible(
  subagent: RunLifecycleActivityWebhookV1,
  llmRequest: RunLifecycleActivityWebhookV1
): boolean {
  const subagentStartedMs = Date.parse(subagent.startedAt);
  const llmStartedMs = Date.parse(llmRequest.startedAt);
  return Number.isFinite(subagentStartedMs)
    && Number.isFinite(llmStartedMs)
    && Math.abs(subagentStartedMs - llmStartedMs) <= 15_000;
}

function terminalSubagentLineageSetIsPlausible(
  subagents: RunLifecycleActivityWebhookV1[],
  llmRequests: RunLifecycleActivityWebhookV1[],
  authoritativeActivityId: string
): boolean {
  return llmRequests.every((request) =>
    request.parentActivityId === authoritativeActivityId
    || subagents.some((subagent) => terminalSubagentLineageIsPlausible(subagent, request))
  ) && subagents.every((subagent) =>
    llmRequests.some((request) =>
      request.parentActivityId === authoritativeActivityId
      || terminalSubagentLineageIsPlausible(subagent, request)
    )
  );
}

function uniqueTerminalActivityUsageSubset(
  candidates: RunLifecycleActivityWebhookV1[],
  expectedCount: number,
  expectedUsage: RunTokenTotals,
  requiredActivityIds: Set<string>
): RunLifecycleActivityWebhookV1[] | undefined {
  const eligible = candidates
    .filter((candidate) => {
      const usage = lifecycleActivityTokenTotals(candidate);
      return usage.present && usage.valid;
    })
    .sort(compareLifecycleActivity);
  if (
    expectedCount < 1
    || expectedCount > 8
    || eligible.length < expectedCount
    || eligible.length > 16
    || requiredActivityIds.size > expectedCount
  ) {
    return undefined;
  }
  const matches: RunLifecycleActivityWebhookV1[][] = [];
  const visit = (
    index: number,
    selected: RunLifecycleActivityWebhookV1[],
    totals: RunTokenTotals
  ): void => {
    if (matches.length > 1 || selected.length > expectedCount) {
      return;
    }
    if (selected.length === expectedCount) {
      if (
        terminalTokenTotalsEqual(totals, expectedUsage)
        && [...requiredActivityIds].every((activityId) =>
          selected.some((candidate) => candidate.activityId === activityId)
        )
      ) {
        matches.push(selected);
      }
      return;
    }
    if (index >= eligible.length || selected.length + eligible.length - index < expectedCount) {
      return;
    }
    const candidate = eligible[index];
    const candidateUsage = lifecycleActivityTokenTotals(candidate);
    const withCandidate = addTerminalTokenTotals(totals, candidateUsage);
    if (!terminalTokenTotalsExceed(withCandidate, expectedUsage)) {
      visit(index + 1, [...selected, candidate], withCandidate);
    }
    if (!requiredActivityIds.has(candidate.activityId)) {
      visit(index + 1, selected, totals);
    }
  };
  visit(0, [], {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function addTerminalTokenTotals(left: RunTokenTotals, right: RunTokenTotals): RunTokenTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function terminalTokenTotalsEqual(left: RunTokenTotals, right: RunTokenTotals): boolean {
  return left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadInputTokens === right.cacheReadInputTokens
    && left.cacheCreationInputTokens === right.cacheCreationInputTokens
    && left.reasoningOutputTokens === right.reasoningOutputTokens
    && left.totalTokens === right.totalTokens;
}

function terminalTokenTotalsExceed(left: RunTokenTotals, right: RunTokenTotals): boolean {
  return left.inputTokens > right.inputTokens
    || left.outputTokens > right.outputTokens
    || left.cacheReadInputTokens > right.cacheReadInputTokens
    || left.cacheCreationInputTokens > right.cacheCreationInputTokens
    || left.reasoningOutputTokens > right.reasoningOutputTokens
    || left.totalTokens > right.totalTokens;
}

function terminalActivityUsageEqualsSum(
  activity: RunLifecycleActivityWebhookV1,
  left: RunTokenTotals,
  right: RunTokenTotals
): boolean {
  const usage = lifecycleActivityTokenTotals(activity);
  return usage.present
    && usage.valid
    && usage.inputTokens === left.inputTokens + right.inputTokens
    && usage.outputTokens === left.outputTokens + right.outputTokens
    && usage.cacheReadInputTokens === left.cacheReadInputTokens + right.cacheReadInputTokens
    && usage.cacheCreationInputTokens === left.cacheCreationInputTokens + right.cacheCreationInputTokens
    && usage.reasoningOutputTokens === left.reasoningOutputTokens + right.reasoningOutputTokens;
}

function terminalActivityUsageKey(activity: RunLifecycleActivityWebhookV1): string | undefined {
  const usage = lifecycleActivityTokenTotals(activity);
  return usage.present && usage.valid
    ? [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadInputTokens,
        usage.cacheCreationInputTokens,
        usage.reasoningOutputTokens
      ].join(":")
    : undefined;
}

function terminalActivitySemanticKey(activity: RunLifecycleActivityWebhookV1): string {
  return `${activity.kind}:${activity.name.trim().toLowerCase()}`;
}

function terminalActivityIdentity(activity: RunLifecycleActivityWebhookV1): string {
  return isUnallocatedTerminalActivity(activity) ? "unallocated_run_usage" : activity.activityId;
}

function mergeTerminalActivityRow(
  previous: RunLifecycleActivityWebhookV1,
  next: RunLifecycleActivityWebhookV1
): RunLifecycleActivityWebhookV1 {
  const startedAt = earliestIso([previous.startedAt, next.startedAt]);
  const endedAt = latestIsoOptional([previous.endedAt, next.endedAt]);
  return {
    ...previous,
    ...next,
    // Semantic aliases such as the unallocated-usage row can be projected with
    // different implementation IDs. Once published, keep the public identity stable
    // so alternating equivalent projections cannot churn terminal versions.
    activityId: previous.activityId,
    parentActivityId: next.parentActivityId ?? previous.parentActivityId,
    startedAt,
    endedAt,
    durationMs: endedAt ? durationMs(startedAt, endedAt) : next.durationMs ?? previous.durationMs,
    evidence: preferredWebhookEvidence(previous.evidence, next.evidence)
  };
}

function conserveTerminalActivityUsage(
  event: RunEndedWebhookEventDraft,
  activity: RunLifecycleActivityWebhookV1[]
): RunLifecycleActivityWebhookV1[] {
  const remaining = terminalEventTokenTotals(event);
  const result: RunLifecycleActivityWebhookV1[] = [];
  let unallocated: RunLifecycleActivityWebhookV1 | undefined;
  for (const item of activity.sort(compareLifecycleActivity)) {
    if (isUnallocatedTerminalActivity(item)) {
      unallocated = unallocated ? mergeTerminalActivityRow(unallocated, item) : item;
      continue;
    }
    const usage = lifecycleActivityTokenTotals(item);
    const fits = usage.valid
      && usage.inputTokens <= remaining.inputTokens
      && usage.outputTokens <= remaining.outputTokens
      && usage.cacheReadInputTokens <= remaining.cacheReadInputTokens
      && usage.cacheCreationInputTokens <= remaining.cacheCreationInputTokens
      && usage.reasoningOutputTokens <= remaining.reasoningOutputTokens;
    if (!usage.present || !fits) {
      result.push(usage.present ? withoutLifecycleActivityUsage(item) : item);
      continue;
    }
    remaining.inputTokens -= usage.inputTokens;
    remaining.outputTokens -= usage.outputTokens;
    remaining.cacheReadInputTokens -= usage.cacheReadInputTokens;
    remaining.cacheCreationInputTokens -= usage.cacheCreationInputTokens;
    remaining.reasoningOutputTokens -= usage.reasoningOutputTokens;
    remaining.totalTokens = remaining.inputTokens + remaining.outputTokens;
    result.push({
      ...item,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      totalTokens: usage.totalTokens
    });
  }
  if (hasTokenUsage(remaining)) {
    result.push({
      ...(unallocated ?? {
        activityId: `activity_${contentHash({ runId: event.runId, kind: "unallocated_terminal_usage" }).slice(0, 24)}`,
        kind: "unknown" as const,
        name: "Unallocated run usage",
        outcome: "unknown" as const,
        count: 1,
        failureCount: 0,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        evidence: event.evidence
      }),
      ...remaining,
      usageAttributionBasis: "unavailable",
      usageCoverage: result.some(hasLiveActivityUsage) ? "partial" : "unavailable"
    });
  }
  return result.sort(compareLifecycleActivity);
}

function isUnallocatedTerminalActivity(activity: RunLifecycleActivityWebhookV1): boolean {
  return activity.kind === "unknown" && activity.name === "Unallocated run usage";
}

function terminalEventTokenTotals(event: RunEndedWebhookEventDraft): RunTokenTotals {
  return {
    inputTokens: nonNegativeToken(event.inputTokens),
    outputTokens: nonNegativeToken(event.outputTokens),
    cacheReadInputTokens: nonNegativeToken(event.cacheReadInputTokens),
    cacheCreationInputTokens: nonNegativeToken(event.cacheCreationInputTokens),
    reasoningOutputTokens: nonNegativeToken(event.reasoningOutputTokens),
    totalTokens: nonNegativeToken(event.inputTokens) + nonNegativeToken(event.outputTokens)
  };
}

function lifecycleActivityTokenTotals(
  activity: RunLifecycleActivityWebhookV1
): RunTokenTotals & { present: boolean; valid: boolean } {
  const values = [
    activity.inputTokens,
    activity.outputTokens,
    activity.cacheReadInputTokens,
    activity.cacheCreationInputTokens,
    activity.reasoningOutputTokens
  ];
  const inputTokens = nonNegativeToken(activity.inputTokens);
  const outputTokens = nonNegativeToken(activity.outputTokens);
  return {
    present: values.some((value) => value != null) || activity.totalTokens != null,
    valid: values.every((value) => value == null || isNonNegativeSafeInteger(value))
      && (activity.totalTokens == null
        || (isNonNegativeSafeInteger(activity.totalTokens) && activity.totalTokens === inputTokens + outputTokens)),
    inputTokens,
    outputTokens,
    cacheReadInputTokens: nonNegativeToken(activity.cacheReadInputTokens),
    cacheCreationInputTokens: nonNegativeToken(activity.cacheCreationInputTokens),
    reasoningOutputTokens: nonNegativeToken(activity.reasoningOutputTokens),
    totalTokens: inputTokens + outputTokens
  };
}

function preferredWebhookEvidence(previous: WebhookEvidenceV1, next: WebhookEvidenceV1): WebhookEvidenceV1 {
  const previousScore = webhookEvidenceScore(previous);
  const nextScore = webhookEvidenceScore(next);
  if (nextScore !== previousScore) {
    return nextScore > previousScore ? next : previous;
  }
  return next.observedAt > previous.observedAt ? next : previous;
}

function webhookEvidenceScore(evidence: WebhookEvidenceV1): number {
  const basisRank: Record<WebhookEvidenceV1["basis"], number> = {
    prompt_hook: 6,
    session_hook: 6,
    tool_hook: 7,
    subagent_hook: 7,
    stop_hook: 8,
    root_span: 5,
    trace_span: 5,
    otel_event: 4,
    provider_metric: 4,
    span_db_replay: 4,
    usage_projection: 3,
    inactivity: 2
  };
  return basisRank[evidence.basis] * 10
    + (evidence.identityConfidence === "high" ? 4 : 0)
    + (evidence.timingConfidence === "high" ? 2 : 0)
    + (evidence.delayed ? 0 : 1);
}

function mergeTerminalCoverage(previous: WebhookCoverageV1, next: WebhookCoverageV1): WebhookCoverageV1 {
  return {
    usageCoverage: terminalUsageCoverageRank(next.usageCoverage) >= terminalUsageCoverageRank(previous.usageCoverage)
      ? next.usageCoverage
      : previous.usageCoverage,
    activityCoverage: terminalActivityCoverageRank(next.activityCoverage) >= terminalActivityCoverageRank(previous.activityCoverage)
      ? next.activityCoverage
      : previous.activityCoverage,
    costCoverage: costCoverageRank(next.costCoverage) >= costCoverageRank(previous.costCoverage)
      ? next.costCoverage
      : previous.costCoverage
  };
}

function preferredTerminalContext(
  previous: RunContextFootprintV1 | undefined,
  next: RunContextFootprintV1 | undefined
): RunContextFootprintV1 | undefined {
  if (!previous) return next;
  if (!next) return previous;
  const previousScore = terminalContextScore(previous);
  const nextScore = terminalContextScore(next);
  return nextScore > previousScore ? next : previous;
}

function terminalContextScore(context: RunContextFootprintV1): number {
  const coverageRank = context.coverage === "final" ? 3 : context.coverage === "complete_so_far" ? 2 : 1;
  const populatedDimensions = [
    context.initialInputContextTokens,
    context.latestInputContextTokens,
    context.peakInputContextTokens,
    context.contextGrowthInputTokens,
    context.contextGrowthRatio
  ].filter((value) => value != null).length;
  return coverageRank * 1_000_000
    + Math.min(context.observedLlmRequestCount, 100_000) * 10
    + populatedDimensions;
}

function terminalUsageCoverageRank(value: WebhookCoverageV1["usageCoverage"]): number {
  return value === "final" ? 4 : value === "complete_so_far" ? 3 : value === "partial" ? 2 : 1;
}

function terminalActivityCoverageRank(value: WebhookCoverageV1["activityCoverage"]): number {
  return value === "complete_for_reported_surface" ? 3 : value === "partial" ? 2 : 1;
}

function shouldCoalesceTerminalActivityCorrection(event: RunEndedWebhookEventV1): boolean {
  return (event.version ?? 1) > 1
    && event.coverage.usageCoverage === "final"
    && event.coverage.activityCoverage === "partial"
    && (event.activity ?? []).some((activity) =>
      activity.kind === "subagent" && activity.usageCoverage !== "complete");
}

function repositoryIdentityScore(repository: WebhookRepositoryV1): number {
  return Number(repository.name !== "repository") * 2
    + Number(repository.owner !== "local")
    + Number(repository.fullName !== "local/repository");
}

function commitSubject(repoKey: string, commitHash: string): string {
  return `commit.attributed:${repoKey}:${commitHash}`;
}

function commitMessagePayload(message?: string): { commitMessage?: string } {
  const normalized = message?.trim();
  return normalized ? { commitMessage: normalized.slice(0, 1000) } : {};
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJsonValue(value))).digest("hex");
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]));
  }
  return value;
}

function providerIdentityKey(provider: SafeObservationV1["provider"], identity: string): string {
  return `${provider}:${identity}`;
}

function addRepositoryHint(hints: Map<string, Set<string>>, identity: string, repositoryKey: string): void {
  hints.set(identity, new Set([...(hints.get(identity) ?? []), repositoryKey]));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}

function uniqueOutboxEntries(entries: WebhookOutboxEntry[]): WebhookOutboxEntry[] {
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()];
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
      .flatMap((evidence) => evidence.causalArtifactKeys ?? [])
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
    .flatMap((evidence) => evidence.causalArtifactKeys ?? []));
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

function positiveDurationMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
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
  attemptAt: string,
  requestTimeoutMs: number
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
    request.setTimeout(requestTimeoutMs, () => {
      reject({ code: "delivery_timeout", retryable: true });
      request.destroy();
    });
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
