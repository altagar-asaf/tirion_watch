import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import {
  ADMIN_CAPABILITIES,
  AGENT_DATABASE_SCHEMA_VERSION,
  AgentConstructStateV1,
  AgentDiagnosticEventCode,
  AgentBudgetSnapshotV1,
  AgentCommitAttributionV1,
  AgentWebhookStatusV1,
  AgentDiagnosticsV1,
  AgentHistoricalReconciliationStatusV1,
  ExecutionRunListV1,
  ExecutionRunTreeResponseV1,
  AgentRollbackInfoV1,
  AgentDoctorV1,
  AgentEventKind,
  AgentEventV1,
  AgentLogResponseV1,
  AgentStatusV1,
  AgentSupportBundleV1,
  AgentUpgradePreparationV1,
  AgentVersionV1,
  ClientCapability,
  ClientKind,
  ClientSummaryV1,
  ConfigurableProvider,
  CopilotSpanDbConfigurationV1,
  errorResponse,
  HandshakeResponseV1,
  negotiateProtocol,
  OwnershipReadinessV1,
  OwnershipState,
  ownershipManifestFor,
  PairClientResponseV1,
  ProviderConfigurationRequestV1,
  ProviderSourceStatusV1,
  parseCopilotSpanDbConfigurationV1,
  parseHandshakeRequestV1,
  parsePairClientRequestV1,
  parseSourceCapabilityV1,
  publicOwnershipMarkerFor,
  RepositoryActivationRequestV1,
  RepositoryActivationV1,
  ProductionRunV1,
  SafeObservationV1,
  SafeErrorCode,
  SourceCapabilityV1,
  SourceTestResultV1,
  SupportedProvider,
  WebhookBearerTokenConfigurationV1,
  WebhookSenderConfigurationV1,
  WebhookSecretConfigurationV1,
  WebhookUrlConfigurationV1
} from "@tirion/agent-contract";
import { AgentMetadata, AgentStorageClient } from "@tirion/agent-storage";
import { isClosedAuthoritativeRunBoundaryAtom } from "@tirion/engine";
import {
  type CommitAttributionChange,
  constructLifecycleDetails,
  constructLifecycleMessage,
  type DiagnosticEvent
} from "@tirion/engine/production";
import {
  acquireExclusiveLock,
  AgentPaths,
  ensurePrivateDirectory,
  ExclusiveLock,
  resolveAgentPaths,
  writePrivateFileAtomic,
  writePublicOwnershipMarker
} from "@tirion/platform";
import { OtlpIngress } from "./otlpIngress";
import { CopilotSpanDbIngress } from "./copilotSpanDbIngress";
import { ShadowUsageService } from "./shadowUsageService";
import { ProductionUsageService } from "./productionUsageService";
import { ExecutionEvidenceService } from "./executionEvidenceService";
import { RepositoryScopeManagement } from "./repositoryScopeManagement";
import {
  AgentRepositoryObservationService,
  MAX_REPOSITORY_SNAPSHOT_ARTIFACT_STATES
} from "./repositoryObservationService";
import { AgentVerifiedAttributionService } from "./productionRunAttribution";
import { AgentBudgetWarningsService, parseAgentBudgetThresholds } from "./budgetWarningsService";
import { AgentDiagnosticsService } from "./diagnosticsService";
import { ExternalWebhookDispatchService } from "./externalWebhookDispatch";
import {
  type CodexHookReadinessProbe,
  resolveSourceConfigurationPaths,
  SourceConfigurationPaths,
  SourceConfigurationService
} from "./sourceConfiguration";
import { RuntimeWorkScheduler, type RuntimeWorkKey } from "./runtimeWorkScheduler";

export const AGENT_VERSION = String(require("../package.json").version);
export const DATABASE_SCHEMA_VERSION = AGENT_DATABASE_SCHEMA_VERSION;
export const CONTROL_BODY_LIMIT_BYTES = 64 * 1024;
export const LEGACY_ENGINE_LEASE_TTL_MS = 20_000;
export const LEGACY_ENGINE_OBSERVATION_WINDOW_MS = 30_000;
export const SAFE_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const SAFE_JOURNAL_MAX_OBSERVATIONS = 10_000;
export const SAFE_EXECUTION_NODE_MAX_DOCUMENTS = 50_000;
export const WORKSPACE_LEASE_TTL_MS = 60_000;
export const WORKSPACE_LEASE_SWEEP_MS = 15_000;
export const PRODUCT_RETENTION_DAYS = 180;
export const PRODUCT_RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;
export const USAGE_RECONCILIATION_SWEEP_MS = 30_000;
export const LIVE_USAGE_PROJECTION_QUIET_MS = 5_000;
export const LIVE_TERMINAL_USAGE_PROJECTION_RETENTION_MS = 15_000;
export const LIVE_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
export const DIAGNOSTIC_REFRESH_WAIT_MS = 100;
export const USAGE_PROJECTION_READ_WAIT_MS = 250;
export const LIVE_REPOSITORY_OBSERVATION_WINDOW_MS = 30_000;
export const LIVE_REPOSITORY_OBSERVATION_POLL_MS = 500;

export type AgentRuntimeOptions = {
  paths?: AgentPaths;
  now?: () => Date;
  otlpPort?: number | false;
  sourceConfigurationPaths?: SourceConfigurationPaths;
  codexHookReadinessProbe?: CodexHookReadinessProbe;
  initialOwnershipState?: OwnershipState;
  otlpAuthToken?: string | false;
  otlpMaxRequestsPerSecond?: number;
  usageProjectionQuietMs?: number;
};

type PendingWebhookLifecycleProjection = {
  run: ProductionRunV1;
  priority: boolean;
  sequence: number;
  queuedAtMs: number;
};

type FullOwnerBootstrapState = "not_required" | "deferred" | "running" | "ready" | "failed";
type RuntimeWarmupState = "starting" | "ready" | "failed";
const CONFIGURABLE_PROVIDERS = ["claude-code", "codex", "cursor"] as const satisfies readonly ConfigurableProvider[];
const MEASUREMENT_PROVIDERS = ["claude-code", "codex", "cursor", "github-copilot"] as const satisfies readonly SupportedProvider[];

type TelemetryIngressLifecycleState = {
  acceptedCount: number;
  rejectedCount: number;
  lastAcceptedAt?: string;
  lastAcceptedProvider?: string;
  lastAcceptedSignal?: string;
  lastAcceptedSourceId?: string;
  lastRejectedAt?: string;
  lastRejectedReason?: string;
  lastRejectedSignal?: string;
};

export class AgentRuntime {
  private readonly paths: AgentPaths;
  private readonly now: () => Date;
  private server?: Server;
  private storage?: AgentStorageClient;
  private lock?: ExclusiveLock;
  private metadata?: AgentMetadata;
  private startedAt?: string;
  private bootstrapToken?: string;
  private otlp?: OtlpIngress;
  private copilotSpanDb?: CopilotSpanDbIngress;
  private shadowUsage?: ShadowUsageService;
  private productionUsage?: ProductionUsageService;
  private executionEvidence?: ExecutionEvidenceService;
  private repositoryScopes?: RepositoryScopeManagement;
  private repositoryObservation?: AgentRepositoryObservationService;
  private verifiedAttribution?: AgentVerifiedAttributionService;
  private verifiedAttributionStart?: Promise<void>;
  private verifiedAttributionReady = false;
  private webhookDispatch?: ExternalWebhookDispatchService;
  private attributionSyncUnsubscribe?: () => void;
  private workspaceEvidenceSyncUnsubscribe?: () => void;
  private budgetWarnings?: AgentBudgetWarningsService;
  private diagnostics?: AgentDiagnosticsService;
  private readonly sourceConfiguration: SourceConfigurationService;
  private readonly legacyEngineLeases = new Map<string, number>();
  private readonly otlpPort: number | false;
  private readonly initialOwnershipState: OwnershipState;
  private readonly configuredOtlpAuthToken?: string | false;
  private readonly otlpMaxRequestsPerSecond?: number;
  private otlpAuthToken?: string;
  private health: AgentStatusV1["health"] = "starting";
  private runtimeWarmupState: RuntimeWarmupState = "starting";
  private runtimeWarmupLastErrorCode?: SafeErrorCode;
  private runtimeWarmup?: Promise<void>;
  private runtimeWarmupCancelled = false;
  private fullOwnerBootstrapState: FullOwnerBootstrapState = "not_required";
  private fullOwnerBootstrapLastErrorCode?: SafeErrorCode;
  private fullOwnerBootstrap?: Promise<void>;
  private fullOwnerBootstrapCancelled = false;
  private stopPromise?: Promise<void>;
  private eventSequence = 0;
  private readonly events: AgentEventV1[] = [];
  private readonly eventSubscribers = new Set<ServerResponse>();
  private telemetryIngressLifecycle: TelemetryIngressLifecycleState = {
    acceptedCount: 0,
    rejectedCount: 0
  };
  private workspaceLeaseSweep?: NodeJS.Timeout;
  private productRetentionSweep?: NodeJS.Timeout;
  private usageReconciliationSweep?: NodeJS.Timeout;
  private usageProjectionTimer?: NodeJS.Timeout;
  private lastLiveMeasurementAtMs?: number;
  private usageRebuildRunning = false;
  private usageRebuildRequested = false;
  private productRetentionQueue: Promise<void> = Promise.resolve();
  private repositoryRefreshQueue: Promise<void> = Promise.resolve();
  private usageRebuildQueue: Promise<ProductionRunV1[]> = Promise.resolve([]);
  private readonly runtimeWork = new RuntimeWorkScheduler();
  private readonly usageProjectionQuietMs: number;
  private pendingPriorityLiveWebhookObservations: SafeObservationV1[] = [];
  private pendingLiveWebhookObservations: SafeObservationV1[] = [];
  private pendingWorkspaceEvidenceObservations: SafeObservationV1[] = [];
  private readonly terminalUsageProjectionTimers = new Map<string, NodeJS.Timeout>();
  private readonly recentTerminalUsageSessions = new Map<string, {
    queryId: string;
    expiresAt: number;
    authorityTriggered: boolean;
  }>();
  private readonly pendingPriorityWebhookLifecycleProjectionRuns = new Map<string, PendingWebhookLifecycleProjection>();
  private readonly pendingHistoricalWebhookLifecycleProjectionRuns = new Map<string, PendingWebhookLifecycleProjection>();
  private webhookLifecycleProjectionSequence = 0;
  private webhookLifecycleProjectionInFlight = 0;
  private pendingWebhookLifecycleCommitReconcile = false;
  private historicalWebhookLifecycleProjectionScheduled = false;

  constructor(options: AgentRuntimeOptions = {}) {
    this.paths = options.paths ?? resolveAgentPaths();
    this.now = options.now ?? (() => new Date());
    this.otlpPort = options.otlpPort ?? Number(process.env.TIRION_AGENT_OTLP_PORT ?? 4318);
    this.sourceConfiguration = new SourceConfigurationService(
      options.sourceConfigurationPaths ?? resolveSourceConfigurationPaths(
        `${this.paths.stateDir}/source-configuration-restore.json`
      ),
      options.codexHookReadinessProbe
    );
    this.initialOwnershipState = options.initialOwnershipState ?? "agent_full_owner";
    this.configuredOtlpAuthToken = options.otlpAuthToken;
    this.otlpMaxRequestsPerSecond = options.otlpMaxRequestsPerSecond;
    this.usageProjectionQuietMs = Number.isFinite(options.usageProjectionQuietMs)
      ? Math.max(0, options.usageProjectionQuietMs ?? 0)
      : LIVE_USAGE_PROJECTION_QUIET_MS;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    ensurePrivateDirectory(this.paths.stateDir);
    ensurePrivateDirectory(dirnameOf(this.paths.socketPath));
    this.lock = acquireExclusiveLock(this.paths.lockPath);
    try {
      rmSync(this.paths.socketPath, { force: true });
      this.bootstrapToken = readOrCreateBootstrapToken(this.paths.bootstrapTokenPath);
      this.otlpAuthToken = this.configuredOtlpAuthToken === false
        ? undefined
        : this.configuredOtlpAuthToken ?? readOrCreateBootstrapToken(this.paths.otlpTokenPath ?? `${this.paths.stateDir}/otlp.token`);
      this.storage = new AgentStorageClient({ databasePath: this.paths.databasePath });
      this.metadata = await this.storage.initialize({
        now: this.now().toISOString(),
        ownershipState: this.initialOwnershipState,
        protocolVersion: "1.0"
      });
      this.runtimeWarmupCancelled = false;
      this.runtimeWarmup = undefined;
      this.runtimeWarmupState = "starting";
      this.runtimeWarmupLastErrorCode = undefined;
      this.fullOwnerBootstrapCancelled = false;
      this.fullOwnerBootstrap = undefined;
      this.fullOwnerBootstrapState = this.metadata.ownershipState === "agent_full_owner" ? "deferred" : "not_required";
      this.fullOwnerBootstrapLastErrorCode = undefined;
      this.telemetryIngressLifecycle = {
        acceptedCount: 0,
        rejectedCount: 0
      };
      this.writeOwnershipMarker(this.metadata.ownershipState, this.metadata.updatedAt);
      this.shadowUsage = new ShadowUsageService(this.storage, this.now);
      this.productionUsage = new ProductionUsageService(this.storage, this.now);
      this.executionEvidence = new ExecutionEvidenceService(this.storage, this.productionUsage);
      this.budgetWarnings = new AgentBudgetWarningsService(this.storage);
      this.diagnostics = new AgentDiagnosticsService(this.storage, this.paths.logPath ?? `${this.paths.stateDir}/agent.log.jsonl`);
      // Bound raw execution evidence before any full-owner startup work can read it.
      await this.applyStartupExecutionEvidenceBound();
      this.repositoryScopes = new RepositoryScopeManagement(
        this.storage,
        this.paths.repositoryLocatorKeyPath,
        this.now
      );
      this.repositoryObservation = new AgentRepositoryObservationService(
        this.storage,
        this.repositoryScopes,
        this.paths.attributionHmacKeyPath,
        2_000,
        (event) => this.recordLivePipelineEvent(event)
      );
      this.startedAt = this.now().toISOString();
      this.server = createServer((request, response) => void this.route(request, response));
      await listen(this.server, this.paths.socketPath);
      chmodSync(this.paths.socketPath, 0o600);
      this.workspaceLeaseSweep = setInterval(
        () => void this.expireWorkspaceLeases().catch(() => undefined),
        WORKSPACE_LEASE_SWEEP_MS
      );
      this.workspaceLeaseSweep.unref?.();
      if (this.metadata.ownershipState === "agent_usage_owner" || this.metadata.ownershipState === "agent_full_owner") {
        if (!await this.storage.productionUsageEpoch()) {
          await this.productionUsage.startCleanEpoch(this.now().toISOString());
        }
      }
      if (this.metadata.ownershipState === "agent_full_owner") {
        await this.startFullOwnerCoreServices({ includeCurrentRuns: false });
      }
      this.productRetentionSweep = setInterval(
        () => void this.applyProductRetention().catch(() => undefined),
        PRODUCT_RETENTION_SWEEP_MS
      );
      this.productRetentionSweep.unref?.();
      this.usageReconciliationSweep = setInterval(
        () => void this.runPeriodicUsageMaintenance().catch(() => undefined),
        USAGE_RECONCILIATION_SWEEP_MS
      );
      this.usageReconciliationSweep.unref?.();
      if (this.otlpPort !== false) {
        this.otlp = new OtlpIngress(
          this.storage,
          this.metadata.environmentId,
          this.otlpPort,
          this.now,
          async (observation) => {
            this.scheduleLiveIngestProcessing(observation);
          },
          (event) => this.recordTelemetryIngressEvent(event),
          this.otlpAuthToken,
          this.otlpMaxRequestsPerSecond,
          async (workspacePath, artifactPaths) => await this.repositoryObservation?.resolveWorkspaceEvidence(
            workspacePath,
            artifactPaths
          )
        );
        for (const provider of MEASUREMENT_PROVIDERS) {
          this.otlp.setPromptCapture(provider, await this.promptCaptureEnabled(provider));
        }
        await this.otlp.start();
      }
      this.copilotSpanDb = new CopilotSpanDbIngress(
        this.storage,
        this.metadata.environmentId,
        this.now,
        async (observation) => {
          this.scheduleLiveIngestProcessing(observation);
        },
        (event) => this.recordTelemetryIngressEvent(event),
        async (workspacePath, artifactPaths) => await this.repositoryObservation?.resolveWorkspaceEvidence(
          workspacePath,
          artifactPaths
        )
      );
      this.copilotSpanDb.setPromptCapture(await this.promptCaptureEnabled("github-copilot"));
      await this.copilotSpanDb.configure(await this.readCopilotSpanDbConfiguration());
      this.health = "healthy";
      await this.requireDiagnostics().record("runtime_started", "info", this.now().toISOString());
      this.emitEvent("health_changed");
      this.beginRuntimeWarmup();
    } catch (error) {
      await this.closeResources();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    if (!this.server && !this.storage && !this.lock) {
      return;
    }
    this.health = "stopping";
    this.emitEvent("health_changed");
    this.stopPromise = this.closeResources().finally(() => {
      this.stopPromise = undefined;
    });
    await this.stopPromise;
  }

  socketPath(): string {
    return this.paths.socketPath;
  }

  otlpAddress(): { host: "127.0.0.1"; port: number } | undefined {
    return this.otlp?.address();
  }

  bootstrapCredential(): string {
    if (!this.bootstrapToken) {
      throw new Error("agent_unavailable");
    }
    return this.bootstrapToken;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    try {
      const method = request.method ?? "GET";
      const path = request.url?.split("?")[0] ?? "/";

      if (method === "GET" && path === "/v1/health") {
        return send(response, 200, { schemaVersion: 1, health: this.health });
      }
      if (method === "GET" && path === "/v1/status") {
        return send(response, 200, this.status());
      }
      if (method === "GET" && path === "/v1/version") {
        return send(response, 200, this.version());
      }
      if (method === "GET" && path === "/v1/ownership/public") {
        const metadata = this.requireMetadata();
        return send(response, 200, publicOwnershipMarkerFor(metadata.ownershipState, metadata.updatedAt));
      }
      if (method === "POST" && path === "/v1/legacy-engine-lease/heartbeat") {
        const sessionId = parseLegacyEngineLeaseSession(await readJsonBody(request));
        const metadata = this.requireMetadata();
        if (metadata.ownershipState === "agent_usage_owner" || metadata.ownershipState === "agent_full_owner") {
          return sendError(response, 409, "ownership_conflict");
        }
        const expiresAt = this.now().getTime() + LEGACY_ENGINE_LEASE_TTL_MS;
        this.legacyEngineLeases.set(sessionId, expiresAt);
        return send(response, 200, { schemaVersion: 1, sessionId, expiresAt: new Date(expiresAt).toISOString() });
      }
      if (method === "POST" && path === "/v1/legacy-engine-lease/release") {
        const sessionId = parseLegacyEngineLeaseSession(await readJsonBody(request));
        this.legacyEngineLeases.delete(sessionId);
        return send(response, 200, { schemaVersion: 1, released: true });
      }
      if (method === "GET" && path === "/v1/ownership") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        const metadata = this.requireMetadata();
        return send(response, 200, ownershipManifestFor(metadata.ownershipState, metadata.updatedAt));
      }
      if (method === "GET" && path === "/v1/ownership/readiness") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, this.ownershipReadiness());
      }
      if (method === "POST" && path === "/v1/ownership/transition") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:control")) {
          return sendError(response, 403, "authorization_denied");
        }
        const target = parseOwnershipTarget(await readJsonBody(request));
        const readiness = this.ownershipReadiness().transitions.find((transition) => transition.target === target);
        if (!readiness?.ready) {
          return sendError(response, 409, "unsupported_capability");
        }
        const current = this.requireMetadata();
        const transitionAt = this.now().toISOString();
        if (target === "agent_usage_owner") {
          await this.requireProductionUsage().startCleanEpoch(transitionAt);
        }
        this.writeOwnershipMarker(target, transitionAt);
        const updated = await this.requireStorage().transitionOwnership({
          expected: current.ownershipState,
          next: target,
          now: transitionAt
        });
        if (!updated) {
          return sendError(response, 409, "ownership_conflict");
        }
        this.metadata = updated;
        this.writeOwnershipMarker(updated.ownershipState, updated.updatedAt);
        if (updated.ownershipState === "agent_usage_owner" || updated.ownershipState === "agent_full_owner") {
          const runs = await this.requireProductionUsage().rebuild(updated.ownershipState);
          await this.requireBudgetWarnings().rebuild(runs);
        }
        if (updated.ownershipState === "agent_full_owner") {
          await this.repositoryObservation?.start();
          await this.startVerifiedAttribution();
        }
        await this.requireDiagnostics().record("ownership_transitioned", "info", transitionAt);
        this.emitEvent("ownership_changed");
        return send(response, 200, ownershipManifestFor(updated.ownershipState, updated.updatedAt));
      }
      if (method === "GET" && path === "/v1/sources") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "sources:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, { schemaVersion: 1, sources: await this.requireStorage().listSources() });
      }
      if (method === "POST" && path === "/v1/sources/register") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "sources:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const capability = parseSourceCapabilityV1(await readJsonBody(request));
        if (!isApprovedExternalSourceCapability(capability, this.requireMetadata().environmentId)) {
          return sendError(response, 409, "unsupported_capability");
        }
        await this.requireStorage().upsertSource(capability, this.now().toISOString());
        return send(response, 201, capability);
      }
      if (method === "POST" && path === "/v1/provider-sources/github-copilot/span-db") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "sources:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const configuration = parseCopilotSpanDbConfigurationV1(await readJsonBody(request));
        await this.configureCopilotSpanDbSource(configuration);
        return send(response, 200, configuration);
      }
      const sourceTestMatch = method === "GET" ? /^\/v1\/sources\/([A-Za-z0-9_-]+)\/test$/.exec(path) : null;
      if (sourceTestMatch) {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "sources:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        const capability = (await this.requireStorage().listSources()).find((item) => item.sourceId === sourceTestMatch[1]);
        if (!capability || capability.environmentId !== this.requireMetadata().environmentId) {
          return sendError(response, 404, "invalid_request");
        }
        const lastObservedAt = await this.requireStorage().lastSourceObservationAt(capability.sourceId);
        const result: SourceTestResultV1 = {
          schemaVersion: 1,
          sourceId: capability.sourceId,
          registered: true,
          environmentMatch: true,
          runtimeObserved: Boolean(lastObservedAt),
          lastObservedAt,
          compatibility: capability.compatibility,
          evidenceGrade: capability.evidenceGrade
        };
        return send(response, 200, result);
      }
      if (method === "GET" && path === "/v1/repositories") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, { schemaVersion: 1, scopes: await this.requireRepositoryScopes().list() });
      }
      if (method === "POST" && path === "/v1/repositories/activate") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:manage") || !hasCapability(auth, "sources:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const result: RepositoryActivationV1 = await this.activateRepositoryMeasurement(
          parseRepositoryActivationRequest(await readJsonBody(request))
        );
        return send(response, 200, result);
      }
      if (method === "POST" && path === "/v1/repositories") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const enrollment = parseRepositoryEnrollment(await readJsonBody(request));
        const metadata = this.requireMetadata();
        const scope = await this.requireRepositoryScopes().add(
          enrollment.path,
          enrollment.kind,
          metadata.environmentId,
          this.now().toISOString()
        );
        this.scheduleRepositoryObservationRefresh();
        await this.requireDiagnostics().record("repository_scopes_changed", "info", this.now().toISOString());
        this.emitEvent("repository_changed");
        return send(response, 201, scope);
      }
      if (method === "GET" && path === "/v1/repository-leases") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, {
          schemaVersion: 1,
          leases: this.requireRepositoryScopes().listWorkspaceLeases()
        });
      }
      if (method === "POST" && path === "/v1/repository-leases") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const lease = this.requireRepositoryScopes().acquireWorkspaceLease(
          parseWorkspaceLeaseRequest(await readJsonBody(request)),
          this.requireMetadata().environmentId,
          WORKSPACE_LEASE_TTL_MS
        );
        this.scheduleRepositoryObservationRefresh();
        await this.requireDiagnostics().record("repository_scopes_changed", "info", this.now().toISOString());
        this.emitEvent("repository_changed");
        return send(response, 201, lease);
      }
      const repositoryLeaseAction = /^(?:\/v1\/repository-leases\/)(lease_[A-Za-z0-9_-]+)(?:\/heartbeat)?$/.exec(path);
      if (repositoryLeaseAction && method === "POST" && path.endsWith("/heartbeat")) {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const lease = this.requireRepositoryScopes().renewWorkspaceLease(
          repositoryLeaseAction[1],
          WORKSPACE_LEASE_TTL_MS
        );
        return lease ? send(response, 200, lease) : sendError(response, 404, "invalid_request");
      }
      if (repositoryLeaseAction && method === "DELETE" && !path.endsWith("/heartbeat")) {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const removed = this.requireRepositoryScopes().releaseWorkspaceLease(repositoryLeaseAction[1]);
        if (removed) {
          this.scheduleRepositoryObservationRefresh();
          await this.requireDiagnostics().record("repository_scopes_changed", "info", this.now().toISOString());
          this.emitEvent("repository_changed");
        }
        return send(response, removed ? 200 : 404, { schemaVersion: 1, removed });
      }
      const repositoryAction = /^(?:\/v1\/repositories\/)(scope_[A-Za-z0-9_-]+)(?:\/(pause|resume))?$/.exec(path);
      if (repositoryAction && method === "GET") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        const status = await this.requireRepositoryScopes().status(repositoryAction[1]);
        return status ? send(response, 200, status) : sendError(response, 404, "invalid_request");
      }
      if (repositoryAction && method === "DELETE") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const removed = await this.requireRepositoryScopes().remove(repositoryAction[1]);
        if (removed) {
          this.scheduleRepositoryObservationRefresh();
          await this.requireDiagnostics().record("repository_scopes_changed", "info", this.now().toISOString());
          this.emitEvent("repository_changed");
        }
        return send(response, removed ? 200 : 404, { schemaVersion: 1, removed });
      }
      if (repositoryAction?.[2] && method === "POST") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "repositories:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const scope = await this.requireRepositoryScopes().setState(
          repositoryAction[1],
          repositoryAction[2] === "pause" ? "paused" : "active",
          this.now().toISOString()
        );
        if (scope) {
          this.scheduleRepositoryObservationRefresh();
          await this.requireDiagnostics().record("repository_scopes_changed", "info", this.now().toISOString());
          this.emitEvent("repository_changed");
        }
        return scope ? send(response, 200, scope) : sendError(response, 404, "invalid_request");
      }
      const configureMatch = method === "POST" ? /^\/v1\/configure\/(claude-code|codex|cursor)$/.exec(path) : null;
      if (configureMatch) {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "sources:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const address = this.otlp?.address();
        if (!address) {
          return sendError(response, 409, "unsupported_capability");
        }
        const provider = configureMatch[1] as ConfigurableProvider;
        return send(
          response,
          200,
          await this.configureProviderSource(
            provider,
            `http://${address.host}:${address.port}`,
            parseProviderConfigurationRequest(await readOptionalJsonBody(request))
          )
        );
      }
      const restoreConfigurationMatch = method === "POST"
        ? /^\/v1\/configure\/(claude-code|codex|cursor)\/restore$/.exec(path)
        : null;
      if (restoreConfigurationMatch) {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "sources:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const address = this.otlp?.address();
        if (!address) {
          return sendError(response, 409, "unsupported_capability");
        }
        return send(
          response,
          200,
          this.sourceConfiguration.restore(
            restoreConfigurationMatch[1] as ConfigurableProvider,
            `http://${address.host}:${address.port}`,
            this.otlpAuthToken
          )
        );
      }
      if (method === "GET" && path === "/v1/shadow/runs") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runs:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        await this.waitForRuntimeWork("usage_projection", USAGE_PROJECTION_READ_WAIT_MS);
        const limit = boundedLimit(request.url);
        return send(response, 200, { schemaVersion: 1, shadow: true, runs: await this.requireShadowUsage().runs(limit) });
      }
      if (method === "GET" && path === "/v1/shadow/totals") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runs:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        await this.waitForRuntimeWork("usage_projection", USAGE_PROJECTION_READ_WAIT_MS);
        return send(response, 200, await this.requireShadowUsage().totals());
      }
      if (method === "GET" && path === "/v1/shadow/export") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runs:export")) {
          return sendError(response, 403, "authorization_denied");
        }
        await this.waitForRuntimeWork("usage_projection", USAGE_PROJECTION_READ_WAIT_MS);
        const format = request.url?.includes("format=csv") ? "csv" : "json";
        return send(response, 200, await this.requireShadowUsage().export(format));
      }
      if (method === "GET" && path === "/v1/runs") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runs:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        await this.waitForRuntimeWork("usage_projection", USAGE_PROJECTION_READ_WAIT_MS);
        const owner = this.requireMetadata().ownershipState;
        return send(response, 200, { schemaVersion: 1, production: true, runs: await this.requireProductionUsage().runs(owner, boundedLimit(request.url)) });
      }
      if (method === "GET" && path === "/v1/execution/runs") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "execution:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        await this.waitForRuntimeWork("usage_projection", USAGE_PROJECTION_READ_WAIT_MS);
        const owner = this.requireMetadata().ownershipState;
        const body: ExecutionRunListV1 = await this.requireExecutionEvidence().listRuns(owner, boundedLimit(request.url));
        return send(response, 200, body);
      }
      const executionTreeMatch = method === "GET"
        ? /^\/v1\/execution\/runs\/(run_[A-Za-z0-9]+)\/tree$/.exec(path)
        : null;
      if (executionTreeMatch) {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "execution:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        await this.waitForRuntimeWork("usage_projection", USAGE_PROJECTION_READ_WAIT_MS);
        const owner = this.requireMetadata().ownershipState;
        const body: ExecutionRunTreeResponseV1 | undefined = await this.requireExecutionEvidence().tree(owner, executionTreeMatch[1]);
        return body ? send(response, 200, body) : sendError(response, 404, "invalid_request");
      }
      if (method === "GET" && path === "/v1/current-runs") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runs:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        await this.waitForRuntimeWork("usage_projection", USAGE_PROJECTION_READ_WAIT_MS);
        const owner = this.requireMetadata().ownershipState;
        return send(response, 200, {
          schemaVersion: 1,
          production: true,
          current: true,
          runs: await this.requireProductionUsage().currentRuns(owner, boundedLimit(request.url))
        });
      }
      if (method === "GET" && path === "/v1/totals") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runs:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        await this.waitForRuntimeWork("usage_projection", USAGE_PROJECTION_READ_WAIT_MS);
        return send(response, 200, await this.requireProductionUsage().totals(this.requireMetadata().ownershipState));
      }
      if (method === "GET" && path === "/v1/budgets") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runs:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireBudgetWarnings().snapshot());
      }
      if (method === "POST" && path === "/v1/budgets/thresholds") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:control")) {
          return sendError(response, 403, "authorization_denied");
        }
        const owner = this.requireMetadata().ownershipState;
        const runs = owner === "agent_usage_owner" || owner === "agent_full_owner"
          ? await this.requireProductionUsage().runs(owner)
          : [];
        const result: AgentBudgetSnapshotV1 = await this.requireBudgetWarnings().configure(
          parseAgentBudgetThresholds(await readJsonBody(request)),
          runs
        );
        return send(response, 200, result);
      }
      if (method === "GET" && path === "/v1/export") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runs:export")) {
          return sendError(response, 403, "authorization_denied");
        }
        await this.waitForRuntimeWork("usage_projection", USAGE_PROJECTION_READ_WAIT_MS);
        const format = request.url?.includes("format=csv") ? "csv" : "json";
        return send(response, 200, await this.requireProductionUsage().export(this.requireMetadata().ownershipState, format));
      }
      if (method === "GET" && path === "/v1/attributions") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "attribution:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        const attributions = await this.requireVerifiedAttribution().listCommitAttributions({ limit: boundedLimit(request.url) });
        return send(response, 200, {
          schemaVersion: 1,
          attributions: attributions.map(publicAttribution)
        });
      }
      if (method === "GET" && path === "/v1/attributions/export") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "attribution:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        const format = request.url?.includes("format=csv") ? "csv" : "json";
        const result = await this.requireVerifiedAttribution().export(format);
        return send(response, 200, { schemaVersion: 1, ...result });
      }
      if (method === "POST" && path === "/v1/attributions/reconcile") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:control")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.reconcileHistoricalAttributionNow());
      }
      if (method === "GET" && path === "/v1/webhook/status") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.webhookStatus());
      }
      if (method === "POST" && path === "/v1/webhook/url") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().configureUrl(parseWebhookUrlConfiguration(await readJsonBody(request))));
      }
      if (method === "POST" && path === "/v1/webhook/token") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().setBearerToken(parseWebhookTokenConfiguration(await readJsonBody(request))));
      }
      if (method === "DELETE" && path === "/v1/webhook/token") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().clearBearerToken());
      }
      if (method === "POST" && path === "/v1/webhook/secret") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().setHmacSecret(parseWebhookSecretConfiguration(await readJsonBody(request))));
      }
      if (method === "DELETE" && path === "/v1/webhook/secret") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().clearHmacSecret());
      }
      if (method === "POST" && path === "/v1/webhook/sender") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().configureSender(parseWebhookSenderConfiguration(await readJsonBody(request))));
      }
      if (method === "DELETE" && path === "/v1/webhook/sender") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().clearSender());
      }
      if (method === "POST" && path === "/v1/webhook/runs/enable") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().setRunEndedEnabled(true));
      }
      if (method === "POST" && path === "/v1/webhook/runs/disable") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().setRunEndedEnabled(false));
      }
      if (method === "POST" && path === "/v1/webhook/test") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().test());
      }
      if (method === "POST" && path === "/v1/webhook/retry") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "webhooks:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireWebhookDispatch().retryNow());
      }
      if (method === "POST" && path === "/v1/clear-history") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:control")) {
          return sendError(response, 403, "authorization_denied");
        }
        const owner = this.requireMetadata().ownershipState;
        if (owner === "agent_full_owner") {
          await this.requireVerifiedAttribution().reset();
        }
        await this.requireProductionUsage().clear(owner, this.now().toISOString());
        await this.requireStorage().clearQueryOccurrences();
        await this.requireBudgetWarnings().clearWarnings();
        await this.requireDiagnostics().record("production_history_cleared", "info", this.now().toISOString());
        this.emitEvent("usage_changed");
        this.emitEvent("warnings_changed");
        this.emitEvent("attribution_changed");
        return send(response, 200, { schemaVersion: 1, production: true, cleared: true });
      }
      if (method === "POST" && path === "/v1/clear-agent-data") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:control")) {
          return sendError(response, 403, "authorization_denied");
        }
        parseClearAgentDataRequest(await readJsonBody(request));
        await this.clearLocalAgentData();
        return send(response, 200, { schemaVersion: 1, local: { cleared: true } });
      }
      if (method === "POST" && path === "/v1/maintenance/prepare-upgrade") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:control")) {
          return sendError(response, 403, "authorization_denied");
        }
        if (await this.requireStorage().integrityCheck() !== "ok") {
          return sendError(response, 500, "storage_unavailable");
        }
        const preparedAt = this.now().toISOString();
        await this.requireStorage().backupTo(preUpgradeBackupPath(this.paths));
        const result: AgentUpgradePreparationV1 = {
          schemaVersion: 1,
          backupAvailable: true,
          databaseSchemaVersion: this.requireMetadata().schemaVersion,
          preparedAt
        };
        writePrivateFileAtomic(
          preUpgradeMetadataPath(this.paths),
          `${JSON.stringify({
            schemaVersion: 1,
            backupAvailable: true,
            agentVersion: AGENT_VERSION,
            databaseSchemaVersion: this.requireMetadata().schemaVersion,
            preparedAt
          } satisfies AgentRollbackInfoV1)}\n`
        );
        return send(response, 200, result);
      }
      if (method === "GET" && path === "/v1/maintenance/rollback-info") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:control")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, readRollbackInfo(this.paths));
      }
      if (method === "POST" && path === "/v1/shadow/compare") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runs:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.requireShadowUsage().compare(parseExpectedTotals(await readJsonBody(request))));
      }
      if (method === "GET" && path === "/v1/doctor") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "diagnostics:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.doctor());
      }
      if (method === "GET" && path === "/v1/diagnostics") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "diagnostics:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.diagnosticSnapshot());
      }
      if (method === "GET" && path === "/v1/logs") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "diagnostics:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        const result: AgentLogResponseV1 = {
          schemaVersion: 1,
          events: await this.requireDiagnostics().events(boundedLimit(request.url) ?? 100)
        };
        return send(response, 200, result);
      }
      if (method === "GET" && path === "/v1/events") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        this.openEventStream(request, response);
        return;
      }
      if (method === "GET" && path === "/v1/support-bundle") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "diagnostics:read")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, await this.supportBundle());
      }
      if (method === "POST" && path === "/v1/handshake") {
        const auth = await this.authenticate(request);
        if (!auth) {
          return sendError(response, 401, "authentication_required");
        }
        const body = parseHandshakeRequestV1(await readJsonBody(request));
        const metadata = this.requireMetadata();
        if (body.environmentId && body.environmentId !== metadata.environmentId) {
          return sendError(response, 409, "unsupported_capability");
        }
        let protocol;
        try {
          protocol = negotiateProtocol(body.protocol);
        } catch {
          return sendError(response, 409, "protocol_major_mismatch");
        }
        const enabled = body.requestedCapabilities.filter((capability) => auth.capabilities.includes(capability));
        if (enabled.length !== body.requestedCapabilities.length) {
          return sendError(response, 403, "unsupported_capability");
        }
        const handshake: HandshakeResponseV1 = {
          schemaVersion: 1,
          protocol,
          agentVersion: AGENT_VERSION,
          runtimeVersion: process.version,
          environmentId: metadata.environmentId,
          installationId: metadata.installationId,
          ownershipState: metadata.ownershipState,
          enabledCapabilities: enabled,
          warnings: [],
          readOnly: false,
          degraded: this.health !== "healthy"
        };
        return send(response, 200, handshake);
      }
      if (method === "POST" && path === "/v1/clients/pair") {
        if (!this.isBootstrapRequest(request)) {
          return sendError(response, 403, "authorization_denied");
        }
        const body = parsePairClientRequestV1(await readJsonBody(request));
        const allowed = allowedCapabilitiesFor(body.kind);
        if (body.capabilities.some((capability) => !allowed.includes(capability))) {
          return sendError(response, 403, "unsupported_capability");
        }
        const credential = randomBytes(32).toString("base64url");
        const client = await this.requireStorage().issueClient({
          kind: body.kind,
          credentialHash: hashCredential(credential),
          capabilities: body.capabilities,
          now: this.now().toISOString()
        });
        const result: PairClientResponseV1 = { schemaVersion: 1, client, credential, nonce: body.nonce };
        return send(response, 201, result);
      }
      if (method === "GET" && path === "/v1/clients") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "clients:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        return send(response, 200, { schemaVersion: 1, clients: await this.requireStorage().listClients() });
      }
      const revokeMatch = method === "POST" ? /^\/v1\/clients\/([A-Za-z0-9_-]+)\/revoke$/.exec(path) : null;
      if (revokeMatch) {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "clients:manage")) {
          return sendError(response, 403, "authorization_denied");
        }
        const revoked = await this.requireStorage().revokeClient({ clientId: revokeMatch[1], now: this.now().toISOString() });
        return send(response, revoked ? 200 : 404, { schemaVersion: 1, revoked });
      }
      if (method === "POST" && path === "/v1/stop") {
        const auth = await this.authenticate(request);
        if (!hasCapability(auth, "runtime:control")) {
          return sendError(response, 403, "authorization_denied");
        }
        send(response, 202, { schemaVersion: 1, stopping: true });
        setImmediate(() => void this.stop());
        return;
      }
      return sendError(response, 404, "invalid_request");
    } catch (error) {
      const code = safeErrorCode(error);
      const status = code === "invalid_request"
        ? 400
        : code === "unsupported_capability" || code === "ownership_conflict"
          ? 409
          : 500;
      return sendError(response, status, code);
    }
  }

  private status(): AgentStatusV1 {
    const metadata = this.requireMetadata();
    return {
      schemaVersion: 1,
      health: this.health,
      agentVersion: AGENT_VERSION,
      runtimeVersion: process.version,
      installationId: metadata.installationId,
      environmentId: metadata.environmentId,
      ownershipState: metadata.ownershipState,
      protocol: { major: 1, minor: 0 },
      databaseSchemaVersion: metadata.schemaVersion,
      startedAt: this.startedAt ?? this.now().toISOString(),
      pid: process.pid,
      runtimeWarmupState: this.runtimeWarmupState,
      ...(this.runtimeWarmupLastErrorCode ? { runtimeWarmupLastErrorCode: this.runtimeWarmupLastErrorCode } : {}),
      ...(this.fullOwnerBootstrapState !== "not_required"
        ? {
            fullOwnerBootstrapState: this.fullOwnerBootstrapState,
            historicalReconciliationState: this.fullOwnerBootstrapState,
            ...(this.fullOwnerBootstrapLastErrorCode
              ? {
                  fullOwnerBootstrapLastErrorCode: this.fullOwnerBootstrapLastErrorCode,
                  historicalReconciliationLastErrorCode: this.fullOwnerBootstrapLastErrorCode
                }
              : {})
          }
        : {}),
      otlp: this.otlp ? { ...this.otlp.address(), paths: ["/v1/traces", "/v1/logs", "/v1/metrics"] } : undefined
    };
  }

  private version(): AgentVersionV1 {
    return {
      schemaVersion: 1,
      agentVersion: AGENT_VERSION,
      runtimeVersion: process.version,
      protocol: { major: 1, minor: 0 },
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION
    };
  }

  private async doctor(): Promise<AgentDoctorV1> {
    const metadata = this.requireMetadata();
    const [diagnostics, sources, scopes, historical] = await Promise.all([
      this.diagnosticSnapshot(),
      this.requireStorage().listSources(),
      this.requireRepositoryScopes().list(),
      metadata.ownershipState === "agent_full_owner"
        ? this.requireVerifiedAttribution().historicalStatus(await this.requireProductionUsage().runs("agent_full_owner"))
        : Promise.resolve({
            historicalCutoffAt: undefined,
            processedCompletedRunCount: 0,
            deferredCompletedRunCount: 0
          })
    ]);
    const scopeStatuses = await Promise.all(scopes.map((scope) => this.requireRepositoryScopes().status(scope.scopeId)));
    const sourceStatusProviders: readonly SupportedProvider[] = this.otlp ? MEASUREMENT_PROVIDERS : ["github-copilot"];
    const sourceStatuses = await Promise.all(sourceStatusProviders.map(async (provider) =>
      await this.providerSourceStatus(provider, this.otlp ? `http://${this.otlp.address().host}:${this.otlp.address().port}` : "")
    ));
    return {
      schemaVersion: 1,
      health: this.health,
      ownershipState: metadata.ownershipState,
      databaseIntegrity: await this.requireStorage().integrityCheck().catch(() => "unavailable" as const),
      checks: {
        singleOwner: Boolean(this.lock),
        storageWorker: Boolean(this.storage),
        protocolCompatible: metadata.protocolVersion === "1.0",
        privateStateDirectory: hasNoGroupOrOtherPermissions(this.paths.stateDir),
        privateControlSocket: hasNoGroupOrOtherPermissions(this.paths.socketPath)
      },
      facts: {
        sourceCount: sources.length,
        sourceProviders: [...new Set(sources.map((source) => source.provider))]
          .filter((provider): provider is SupportedProvider =>
            provider === "github-copilot" || provider === "claude-code" || provider === "codex" || provider === "cursor"),
        sourceStatuses,
        productionRunCount: diagnostics.productionRunCount,
        unpricedRunCount: diagnostics.unpricedRunCount,
        repositoryScopeCount: diagnostics.repositoryScopeCount,
        activeRepositoryScopeCount: diagnostics.activeRepositoryScopeCount,
        unavailableRepositoryScopeCount: scopeStatuses.filter((status) => status?.health === "unavailable").length,
        pausedRepositoryScopeCount: scopeStatuses.filter((status) => status?.health === "paused").length,
        workspaceLeaseCount: this.requireRepositoryScopes().listWorkspaceLeases().length,
        verifiedAttributionCount: diagnostics.verifiedAttributionCount,
        budgetWarningCount: diagnostics.budgetWarningCount,
        journalOverflowCount: diagnostics.journalOverflowCount,
        runtimeWarmupState: this.runtimeWarmupState,
        ...(this.runtimeWarmupLastErrorCode ? { runtimeWarmupLastErrorCode: this.runtimeWarmupLastErrorCode } : {}),
        fullOwnerBootstrapState: this.fullOwnerBootstrapState,
        ...(this.fullOwnerBootstrapLastErrorCode ? { fullOwnerBootstrapLastErrorCode: this.fullOwnerBootstrapLastErrorCode } : {}),
        historicalReconciliationState: this.fullOwnerBootstrapState,
        ...(this.fullOwnerBootstrapLastErrorCode
          ? { historicalReconciliationLastErrorCode: this.fullOwnerBootstrapLastErrorCode }
          : {}),
        ...(historical.historicalCutoffAt ? { historicalCutoffAt: historical.historicalCutoffAt } : {}),
        processedCompletedRunCount: historical.processedCompletedRunCount,
        deferredCompletedRunCount: historical.deferredCompletedRunCount
      }
    };
  }

  private async supportBundle(): Promise<AgentSupportBundleV1> {
    const status = this.status();
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      version: this.version(),
      status: {
        schemaVersion: status.schemaVersion,
        health: status.health,
        agentVersion: status.agentVersion,
        runtimeVersion: status.runtimeVersion,
        ownershipState: status.ownershipState,
        protocol: status.protocol,
        databaseSchemaVersion: status.databaseSchemaVersion,
        startedAt: status.startedAt,
        ...(status.runtimeWarmupState ? { runtimeWarmupState: status.runtimeWarmupState } : {}),
        ...(status.runtimeWarmupLastErrorCode ? { runtimeWarmupLastErrorCode: status.runtimeWarmupLastErrorCode } : {}),
        ...(status.fullOwnerBootstrapState ? { fullOwnerBootstrapState: status.fullOwnerBootstrapState } : {}),
        ...(status.fullOwnerBootstrapLastErrorCode ? { fullOwnerBootstrapLastErrorCode: status.fullOwnerBootstrapLastErrorCode } : {}),
        ...(status.historicalReconciliationState
          ? { historicalReconciliationState: status.historicalReconciliationState }
          : {}),
        ...(status.historicalReconciliationLastErrorCode
          ? { historicalReconciliationLastErrorCode: status.historicalReconciliationLastErrorCode }
          : {})
      },
      doctor: await this.doctor(),
      diagnostics: await this.diagnosticSnapshot()
    };
  }

  private ownershipReadiness(): OwnershipReadinessV1 {
    const current = this.requireMetadata().ownershipState;
    const now = this.now().getTime();
    for (const [sessionId, expiresAt] of this.legacyEngineLeases) {
      if (expiresAt <= now) {
        this.legacyEngineLeases.delete(sessionId);
      }
    }
    const activeLegacyLease = this.legacyEngineLeases.size > 0;
    const observationWindowActive = this.startedAt != null
      && now - new Date(this.startedAt).getTime() < LEGACY_ENGINE_OBSERVATION_WINDOW_MS;
    const targets: OwnershipState[] = ["extension_legacy", "agent_shadow", "agent_usage_owner", "agent_full_owner"];
    return {
      schemaVersion: 1,
      current,
      transitions: targets.map((target) => {
        if (target === current) {
          return { target, ready: true, reasonCodes: ["already_current"] as const };
        }
        if (current === "extension_legacy" && target === "agent_shadow") {
          return { target, ready: Boolean(this.shadowUsage), reasonCodes: ["shadow_pipeline_ready"] as const };
        }
        if (target === "agent_usage_owner") {
          const ready = !activeLegacyLease && !observationWindowActive
          return {
            target,
            ready,
            reasonCodes: ready
              ? ["production_usage_pipeline_ready", "extension_usage_consumer_ready", "legacy_engine_drained"] as const
              : [
                  ...(activeLegacyLease ? ["legacy_engine_lease_active" as const] : []),
                  ...(observationWindowActive ? ["legacy_engine_observation_window_active" as const] : [])
                ]
          };
        }
        if (target === "agent_full_owner") {
          if (current === "agent_usage_owner") {
            return {
              target,
              ready: true,
              reasonCodes: ["repository_attribution_ready", "extension_engine_removed"] as const
            };
          }
          return {
            target,
            ready: false,
            reasonCodes: ["unsupported_transition"] as const
          };
        }
        return { target, ready: false, reasonCodes: ["unsupported_transition"] as const };
      })
    };
  }

  private async authenticate(request: IncomingMessage): Promise<AuthContext | undefined> {
    if (this.isBootstrapRequest(request)) {
      return { capabilities: [...ADMIN_CAPABILITIES] };
    }
    const credential = bearerCredential(request);
    if (!credential) {
      return undefined;
    }
    const client = await this.requireStorage().authenticateClient({
      credentialHash: hashCredential(credential),
      now: this.now().toISOString()
    });
    return client && !client.revokedAt ? { client, capabilities: client.capabilities } : undefined;
  }

  private openEventStream(request: IncomingMessage, response: ServerResponse): void {
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    const after = eventSequenceAfter(request.url);
    for (const event of this.events.filter((item) => item.sequence > after).reverse()) {
      if (!response.write(serverEvent(event))) {
        response.end();
        return;
      }
    }
    this.eventSubscribers.add(response);
    request.once("close", () => this.eventSubscribers.delete(response));
  }

  private emitEvent(kind: AgentEventKind): void {
    const event: AgentEventV1 = {
      schemaVersion: 1,
      eventId: `event_${++this.eventSequence}`,
      sequence: this.eventSequence,
      kind,
      at: this.now().toISOString()
    };
    this.events.unshift(event);
    this.events.splice(100);
    for (const response of this.eventSubscribers) {
      if (response.destroyed || !response.write(serverEvent(event))) {
        response.end();
        this.eventSubscribers.delete(response);
      }
    }
  }

  private isBootstrapRequest(request: IncomingMessage): boolean {
    const credential = bearerCredential(request);
    return Boolean(credential && this.bootstrapToken && timingSafeTextEqual(credential, this.bootstrapToken));
  }

  private requireStorage(): AgentStorageClient {
    if (!this.storage) {
      throw new Error("storage_unavailable");
    }
    return this.storage;
  }

  private requireMetadata(): AgentMetadata {
    if (!this.metadata) {
      throw new Error("agent_unavailable");
    }
    return this.metadata;
  }

  private requireShadowUsage(): ShadowUsageService {
    if (!this.shadowUsage) {
      throw new Error("agent_unavailable");
    }
    return this.shadowUsage;
  }

  private requireProductionUsage(): ProductionUsageService {
    if (!this.productionUsage) {
      throw new Error("agent_unavailable");
    }
    return this.productionUsage;
  }

  private requireExecutionEvidence(): ExecutionEvidenceService {
    if (!this.executionEvidence) {
      throw new Error("storage_unavailable");
    }
    return this.executionEvidence;
  }

  private requireRepositoryScopes(): RepositoryScopeManagement {
    if (!this.repositoryScopes) {
      throw new Error("agent_unavailable");
    }
    return this.repositoryScopes;
  }

  private requireVerifiedAttribution(): AgentVerifiedAttributionService {
    if (!this.verifiedAttribution || this.requireMetadata().ownershipState !== "agent_full_owner") {
      throw new Error("unsupported_capability");
    }
    return this.verifiedAttribution;
  }

  private requireBrowserOtlpBaseUrl(): string {
    const address = this.otlp?.address();
    if (!address) {
      throw new Error("unsupported_capability");
    }
    return `http://${address.host}:${address.port}`;
  }

  private async providerSourceStatus(
    provider: SupportedProvider,
    otlpBaseUrl: string,
    cwd = process.cwd()
  ): Promise<ProviderSourceStatusV1> {
    if (provider === "github-copilot") {
      return await this.copilotProviderSourceStatus();
    }
    const configuration = this.sourceConfiguration.status(provider, otlpBaseUrl, this.otlpAuthToken);
    const codexHookReadiness = provider === "codex" && configuration.configurationState === "configured"
      ? await this.sourceConfiguration.codexHookReadiness(cwd, otlpBaseUrl)
      : undefined;
    const hookReadinessReason = codexHookReadiness === "review_required"
      ? "hook_trust_required" as const
      : codexHookReadiness === "disabled"
        ? "hooks_disabled" as const
        : codexHookReadiness === "unavailable"
          ? "hook_trust_status_unavailable" as const
          : undefined;
    const configurationState = codexHookReadiness === "review_required" || codexHookReadiness === "disabled"
      ? "partial" as const
      : configuration.configurationState;
    const sources = (await this.requireStorage().listSources())
      .filter((source) => source.provider === provider && (
        source.sourceKind === "otlp-http-json"
        || (provider === "cursor" && source.sourceKind === "provider-hook-command-json")
      ));
    const lastReceiptAt = maxIsoString(await Promise.all(sources.map(async (source) =>
      await this.requireStorage().lastSourceObservationAt(source.sourceId)
    )));
    const measurementReady = configuration.logsEnabled && configuration.tracesEnabled && configurationState === "configured";
    const reasonCodes: ProviderSourceStatusV1["reasonCodes"] = [...configuration.reasonCodes];
    if (hookReadinessReason && !reasonCodes.includes(hookReadinessReason)) {
      reasonCodes.push(hookReadinessReason);
    }
    if (!lastReceiptAt && measurementReady) {
      reasonCodes.push("no_recent_receipt");
    }
    return {
      schemaVersion: 1,
      provider,
      profileVersion: configuration.profileVersion,
      configurationState,
      ownershipState: configuration.ownershipState,
      promptCaptureEnabled: configuration.promptCaptureEnabled,
      logsEnabled: configuration.logsEnabled,
      tracesEnabled: configuration.tracesEnabled,
      toolDetailsSupported: configuration.toolDetailsSupported,
      toolDetailsEnabled: configuration.toolDetailsEnabled
        && codexHookReadiness !== "review_required"
        && codexHookReadiness !== "disabled",
      toolContentSupported: configuration.toolContentSupported,
      toolContentEnabled: configuration.toolContentEnabled,
      responseContentSupported: configuration.responseContentSupported,
      responseContentEnabled: configuration.responseContentEnabled,
      ...(lastReceiptAt ? { lastReceiptAt } : {}),
      measurementState: !measurementReady ? "unavailable" : lastReceiptAt ? "complete" : "awaiting_receipts",
      reasonCodes
    };
  }

  private async copilotProviderSourceStatus(): Promise<ProviderSourceStatusV1> {
    const [configuration, allSources] = await Promise.all([
      this.readCopilotSpanDbConfiguration(),
      this.requireStorage().listSources()
    ]);
    const sources = allSources.filter((source) =>
      source.provider === "github-copilot"
      && source.runtime === "github-copilot"
      && (
        source.sourceId === "otlp_github_copilot_logs"
        || source.sourceId === "otlp_github_copilot_traces"
        || source.sourceId === "span_db_github_copilot_logs"
        || source.sourceId === "span_db_github_copilot_traces"
      )
    );
    const lastReceiptAt = maxIsoString(await Promise.all(sources.map(async (source) =>
      await this.requireStorage().lastSourceObservationAt(source.sourceId)
    )));
    const spanDbConfigured = Boolean(configuration?.enabled && configuration.spanDbPath);
    const logsEnabled = spanDbConfigured || sources.some((source) =>
      source.sourceId === "otlp_github_copilot_logs" || source.sourceId === "span_db_github_copilot_logs");
    const tracesEnabled = spanDbConfigured || sources.some((source) =>
      source.sourceId === "otlp_github_copilot_traces" || source.sourceId === "span_db_github_copilot_traces");
    const configurationState = logsEnabled && tracesEnabled
      ? "configured"
      : logsEnabled || tracesEnabled
        ? "partial"
        : "not_configured";
    const reasonCodes: ProviderSourceStatusV1["reasonCodes"] = [];
    if (!logsEnabled) {
      reasonCodes.push("logs_missing");
    }
    if (!tracesEnabled) {
      reasonCodes.push("traces_missing");
    }
    if (!lastReceiptAt && logsEnabled && tracesEnabled) {
      reasonCodes.push("no_recent_receipt");
    }
    return {
      schemaVersion: 1,
      provider: "github-copilot",
      profileVersion: spanDbConfigured ? "copilot-span-db-traces-v1" : "copilot-otlp-traces-v1",
      configurationState,
      ownershipState: spanDbConfigured ? "managed_current" : "unmanaged",
      promptCaptureEnabled: await this.promptCaptureEnabled("github-copilot"),
      logsEnabled,
      tracesEnabled,
      toolDetailsSupported: false,
      toolDetailsEnabled: false,
      toolContentSupported: false,
      toolContentEnabled: false,
      responseContentSupported: false,
      responseContentEnabled: false,
      ...(lastReceiptAt ? { lastReceiptAt } : {}),
      measurementState: lastReceiptAt ? "complete" : logsEnabled && tracesEnabled ? "awaiting_receipts" : "unavailable",
      reasonCodes
    };
  }

  private selectActivationProvider(
    requested: RepositoryActivationRequestV1["provider"],
    statuses: ProviderSourceStatusV1[]
  ): SupportedProvider {
    if (requested && requested !== "auto") {
      return requested;
    }
    const ranked = [...statuses].sort((left, right) =>
      providerActivationScore(right) - providerActivationScore(left)
      || (right.lastReceiptAt ?? "").localeCompare(left.lastReceiptAt ?? "")
      || left.provider.localeCompare(right.provider)
    );
    return ranked[0]?.provider ?? "codex";
  }

  private async activateRepositoryMeasurement(request: RepositoryActivationRequestV1): Promise<RepositoryActivationV1> {
    const activatedAt = this.now().toISOString();
    const otlpAddress = this.otlp?.address();
    const otlpBaseUrl = otlpAddress ? `http://${otlpAddress.host}:${otlpAddress.port}` : undefined;
    const statusProviders: readonly SupportedProvider[] = otlpBaseUrl
      ? MEASUREMENT_PROVIDERS
      : ["github-copilot"];
    const statusesBefore = await Promise.all(statusProviders.map(async (provider) =>
      await this.providerSourceStatus(provider, otlpBaseUrl ?? "", request.path)
    ));
    const provider = this.selectActivationProvider(request.provider, statusesBefore);
    if (provider !== "github-copilot" && !otlpBaseUrl) {
      throw new Error("unsupported_capability");
    }
    const repositoryScope = await this.requireRepositoryScopes().add(
      request.path,
      "repository",
      this.requireMetadata().environmentId,
      activatedAt
    );
    this.scheduleRepositoryObservationRefresh();
    await this.requireDiagnostics().record("repository_scopes_changed", "info", activatedAt);
    this.emitEvent("repository_changed");

    let configurationResult: RepositoryActivationV1["configurationResult"];
    let sourceStatus = statusesBefore.find((status) => status.provider === provider)
      ?? await this.providerSourceStatus(provider, otlpBaseUrl ?? "");
    const ownershipNeedsRepair = sourceStatus.ownershipState === "managed_stale_authority"
      || sourceStatus.ownershipState === "managed_drifted"
      || sourceStatus.ownershipState === "adoptable_local";
    const measurementNeedsConfiguration = !sourceStatus.logsEnabled || !sourceStatus.tracesEnabled;
    const trustNeedsUserAction = sourceStatus.reasonCodes.includes("hook_trust_required")
      || sourceStatus.reasonCodes.includes("hooks_disabled");
    const configurationShapeNeedsRepair = sourceStatus.configurationState === "not_configured"
      || (sourceStatus.configurationState === "partial" && !trustNeedsUserAction);
    if (provider !== "github-copilot" && (ownershipNeedsRepair || measurementNeedsConfiguration || configurationShapeNeedsRepair)) {
      if (!otlpBaseUrl) {
        throw new Error("unsupported_capability");
      }
      configurationResult = await this.configureProviderSource(provider, otlpBaseUrl, {
        schemaVersion: 1,
        ...(request.capturePrompts != null ? { capturePrompts: request.capturePrompts } : {}),
        ...(request.captureToolDetails != null ? { captureToolDetails: request.captureToolDetails } : {}),
        ...(request.captureToolContent != null ? { captureToolContent: request.captureToolContent } : {}),
        ...(request.captureResponseContent != null ? { captureResponseContent: request.captureResponseContent } : {})
      }, request.path);
      sourceStatus = await this.providerSourceStatus(provider, otlpBaseUrl, request.path);
    }

    const reasonCodes: RepositoryActivationV1["reasonCodes"] = ["repository_scope_active"];
    if (request.provider == null || request.provider === "auto") {
      reasonCodes.push("provider_auto_selected");
    }
    if (configurationResult?.status === "configured") {
      reasonCodes.push("provider_configuration_applied");
    }
    if (sourceStatus.logsEnabled && sourceStatus.tracesEnabled && sourceStatus.configurationState === "configured") {
      reasonCodes.push("provider_configuration_ready");
    }
    if (sourceStatus.measurementState === "awaiting_receipts") {
      reasonCodes.push("telemetry_receipts_pending");
    }
    if (sourceStatus.ownershipState === "managed_stale_authority") {
      reasonCodes.push("stale_managed_agent_token");
    }
    if (sourceStatus.ownershipState === "managed_drifted") {
      reasonCodes.push("managed_provider_configuration_drifted");
    }
    if (sourceStatus.ownershipState === "foreign_managed") {
      reasonCodes.push("foreign_provider_configuration");
    }
    if (sourceStatus.ownershipState === "unavailable") {
      reasonCodes.push("source_configuration_unavailable");
    }
    for (const reason of ["hook_trust_required", "hooks_disabled", "hook_trust_status_unavailable"] as const) {
      if (sourceStatus.reasonCodes.includes(reason)) {
        reasonCodes.push(reason);
      }
    }
    const activationState = sourceStatus.ownershipState === "foreign_managed"
      || sourceStatus.ownershipState === "managed_drifted"
      || sourceStatus.configurationState === "conflict"
      || sourceStatus.configurationState === "unavailable"
      ? "blocked"
      : sourceStatus.logsEnabled && sourceStatus.tracesEnabled && sourceStatus.configurationState === "configured"
        ? "ready"
        : "attention_required";

    this.recordLivePipelineEvent({
      kind: "constructLifecycle",
      construct: "MeasurementActivation",
      operation: "repository_activation",
      state: activationState,
      reason: activationState === "ready"
        ? "measurement_activation_ready"
        : activationState === "blocked"
          ? "measurement_activation_blocked"
          : "measurement_activation_attention_required",
      details: {
        provider,
        repositoryScopeId: repositoryScope.scopeId,
        sourceOwnershipState: sourceStatus.ownershipState,
        sourceConfigurationState: sourceStatus.configurationState,
        measurementState: sourceStatus.measurementState,
        restartRequired: configurationResult?.restartRequired ?? false
      }
    });

    return {
      schemaVersion: 1,
      activationState,
      repositoryScope,
      provider,
      sourceStatus,
      ...(configurationResult ? { configurationResult } : {}),
      restartRequired: configurationResult?.restartRequired ?? false,
      reasonCodes
    };
  }

  private async configureProviderSource(
    provider: ConfigurableProvider,
    otlpBaseUrl: string,
    request: ProviderConfigurationRequestV1,
    cwd = process.cwd()
  ) {
    let result = this.sourceConfiguration.configure(provider, otlpBaseUrl, this.otlpAuthToken, request);
    if (provider === "codex" && (result.status === "configured" || result.status === "already_configured")) {
      const readiness = await this.sourceConfiguration.codexHookReadiness(cwd, otlpBaseUrl);
      const reason = readiness === "review_required"
        ? "hook_trust_required" as const
        : readiness === "disabled"
          ? "hooks_disabled" as const
          : readiness === "unavailable"
            ? "hook_trust_status_unavailable" as const
            : undefined;
      if (reason && !result.reasonCodes.includes(reason)) {
        result = { ...result, reasonCodes: [...result.reasonCodes, reason] };
      }
    }
    if (result.status === "configured" || result.status === "already_configured") {
      await this.setPromptCapture(provider, result.promptCaptureEnabled);
    }
    return result;
  }

  private async configureCopilotSpanDbSource(configuration: CopilotSpanDbConfigurationV1): Promise<void> {
    const at = this.now().toISOString();
    if (!configuration.enabled || !configuration.spanDbPath) {
      await this.requireStorage().removeAgentDocument("provider_source_config", "github-copilot-span-db");
      await this.copilotSpanDb?.configure(undefined);
      return;
    }
    await this.requireStorage().upsertAgentDocument("provider_source_config", {
      key: "github-copilot-span-db",
      sortAt: at,
      value: configuration
    });
    await this.copilotSpanDb?.configure(configuration);
  }

  private async readCopilotSpanDbConfiguration(): Promise<CopilotSpanDbConfigurationV1 | undefined> {
    const document = (await this.requireStorage().listAgentDocuments<CopilotSpanDbConfigurationV1>("provider_source_config"))
      .find((item) => item.key === "github-copilot-span-db");
    const value = document?.value;
    return value?.enabled && value.spanDbPath ? value : undefined;
  }

  private requireWebhookDispatch(): ExternalWebhookDispatchService {
    if (!this.webhookDispatch || this.requireMetadata().ownershipState !== "agent_full_owner") {
      throw new Error("unsupported_capability");
    }
    return this.webhookDispatch;
  }

  private requireBudgetWarnings(): AgentBudgetWarningsService {
    if (!this.budgetWarnings) {
      throw new Error("agent_unavailable");
    }
    return this.budgetWarnings;
  }

  private requireDiagnostics(): AgentDiagnosticsService {
    if (!this.diagnostics) {
      throw new Error("agent_unavailable");
    }
    return this.diagnostics;
  }

  private recordLivePipelineEvent(event: DiagnosticEvent): void {
    if (!this.diagnostics) {
      return;
    }
    const mapped = mapLivePipelineEvent(event, this.now().toISOString());
    if (!mapped) {
      return;
    }
    void this.diagnostics.record(
      mapped.code as AgentDiagnosticEventCode,
      mapped.severity,
      mapped.at,
      mapped.message || mapped.details
        ? {
            ...(mapped.message ? { message: mapped.message } : {}),
            ...(mapped.details ? { details: mapped.details } : {})
          }
        : undefined
    ).catch(() => undefined);
  }

  private recordTelemetryIngressEvent(event: DiagnosticEvent): void {
    if (event.kind === "constructLifecycle" && event.construct === "TelemetryIngress") {
      const at = this.now().toISOString();
      if (event.state === "accepted" || event.state === "deduplicated") {
        this.telemetryIngressLifecycle = {
          ...this.telemetryIngressLifecycle,
          acceptedCount: this.telemetryIngressLifecycle.acceptedCount + 1,
          lastAcceptedAt: at,
          lastAcceptedProvider: typeof event.details?.provider === "string" ? event.details.provider : undefined,
          lastAcceptedSignal: typeof event.details?.signal === "string" ? event.details.signal : undefined,
          lastAcceptedSourceId: typeof event.details?.sourceId === "string" ? event.details.sourceId : undefined
        };
      } else if (event.state === "rejected" || event.state === "rate_limited") {
        this.telemetryIngressLifecycle = {
          ...this.telemetryIngressLifecycle,
          rejectedCount: this.telemetryIngressLifecycle.rejectedCount + 1,
          lastRejectedAt: at,
          lastRejectedReason: event.reason,
          lastRejectedSignal: typeof event.details?.signal === "string" ? event.details.signal : undefined
        };
      }
    }
    this.recordLivePipelineEvent(event);
  }

  private handleVerifiedAttributionChange(change: CommitAttributionChange): void {
    if (change.kind === "candidate_changed") {
      return;
    }
    this.emitEvent("attribution_changed");
    void this.webhookDispatch?.reconcileCommitEvents(change.commitHash).catch(() => undefined);
    this.emitEvent("webhook_changed");
  }

  private handleWorkspaceEvidenceBound(evidence: import("@tirion/engine/production").QueryWorkEvidence[]): void {
    const queryIds = new Set(evidence.map((item) => item.queryId));
    this.runtimeWork.enqueue("webhook_evidence_projection", async () => {
      if (this.requireMetadata().ownershipState !== "agent_full_owner") {
        return;
      }
      const runs = (await this.requireProductionUsage().runs("agent_full_owner"))
        .filter((run) => queryIds.has(run.queryId ?? run.correlationId));
      this.scheduleWebhookLifecycleProjection(runs, { reconcileCommitEvents: true });
    });
  }

  private writeOwnershipMarker(state: OwnershipState, updatedAt: string): void {
    writePublicOwnershipMarker(this.paths.ownershipMarkerPath, publicOwnershipMarkerFor(state, updatedAt));
  }

  private async refreshRepositoryObservationIfOwned(): Promise<void> {
    if (this.requireMetadata().ownershipState === "agent_full_owner") {
      this.attributionSyncUnsubscribe?.();
      this.attributionSyncUnsubscribe = undefined;
      this.workspaceEvidenceSyncUnsubscribe?.();
      this.workspaceEvidenceSyncUnsubscribe = undefined;
      await this.verifiedAttribution?.stop();
      this.verifiedAttribution = undefined;
      this.verifiedAttributionReady = false;
      await this.repositoryObservation?.restart();
      await this.startVerifiedAttribution();
    }
  }

  private scheduleRepositoryObservationRefresh(): void {
    this.repositoryRefreshQueue = this.repositoryRefreshQueue
      .then(() => this.refreshRepositoryObservationIfOwned())
      .catch(async () => {
        await this.requireDiagnostics().record("repository_scopes_changed", "warning", this.now().toISOString());
      });
  }

  private async expireWorkspaceLeases(): Promise<void> {
    if (!this.repositoryScopes || this.repositoryScopes.pruneExpiredLeases() === 0) {
      return;
    }
    await this.refreshRepositoryObservationIfOwned();
    await this.requireDiagnostics().record("repository_scopes_changed", "info", this.now().toISOString());
    this.emitEvent("repository_changed");
  }

  private async startFullOwnerCoreServices(options: { includeCurrentRuns?: boolean } = {}): Promise<void> {
    const includeCurrentRuns = options.includeCurrentRuns !== false;
    await this.repositoryObservation?.start({ background: true });
    if (!this.verifiedAttribution) {
      const attribution = new AgentVerifiedAttributionService(
        this.requireStorage(),
        this.repositoryObservation!,
        (event) => this.recordLivePipelineEvent(event),
        () => this.now().getTime()
      );
      this.verifiedAttribution = attribution;
      this.verifiedAttributionReady = false;
      if (!this.webhookDispatch) {
        await this.startWebhookDispatch();
      }
      this.verifiedAttributionStart = attribution.start()
        .then(() => {
          if (this.verifiedAttribution === attribution) {
            this.verifiedAttributionReady = true;
            this.scheduleLiveIngestProcessing();
          }
        })
        .catch((error) => {
          if (this.verifiedAttribution === attribution) {
            this.verifiedAttributionReady = false;
          }
          throw error;
        });
      void this.verifiedAttributionStart.catch(() => undefined);
      await attribution.prepareLiveProcessing(this.liveRecoveryCutoffAt());
    }
    if (includeCurrentRuns) {
      await this.requireVerifiedAttributionStarted();
      await this.verifiedAttribution!.observeCurrentRuns(
        await this.requireProductionUsage().currentRuns("agent_full_owner")
      );
    }
    this.attributionSyncUnsubscribe?.();
    this.attributionSyncUnsubscribe = this.requireVerifiedAttribution().onDidChange((change) => this.handleVerifiedAttributionChange(change));
    this.workspaceEvidenceSyncUnsubscribe?.();
    this.workspaceEvidenceSyncUnsubscribe = this.requireVerifiedAttribution().onWorkspaceEvidenceBound(async (evidence) => {
      this.handleWorkspaceEvidenceBound(evidence);
    });
    if (!this.webhookDispatch) {
      await this.startWebhookDispatch();
    }
  }

  private beginRuntimeWarmup(): void {
    this.runtimeWarmup = this.performRuntimeWarmup()
      .then(async () => {
        if (!this.shouldContinueRuntimeWarmup()) {
          return;
        }
        this.runtimeWarmupState = "ready";
        this.runtimeWarmupLastErrorCode = undefined;
        await this.requireDiagnostics().record("runtime_warmup_changed", "info", this.now().toISOString());
      })
      .catch(async (error) => {
        if (!this.shouldContinueRuntimeWarmup()) {
          return;
        }
        this.runtimeWarmupState = "failed";
        this.runtimeWarmupLastErrorCode = safeErrorCode(error);
        this.health = "degraded";
        await this.requireDiagnostics().record("runtime_warmup_changed", "warning", this.now().toISOString());
        this.emitEvent("health_changed");
      });
  }

  private async performRuntimeWarmup(): Promise<void> {
    await this.queueUsageRebuild();
    if (!this.shouldContinueRuntimeWarmup()) {
      return;
    }
    await this.applySafeJournalRetention();
    if (!this.shouldContinueRuntimeWarmup()) {
      return;
    }
    await this.applyProductRetention();
  }

  private shouldContinueRuntimeWarmup(): boolean {
    return !this.runtimeWarmupCancelled && Boolean(this.storage);
  }

  private async requireVerifiedAttributionStarted(): Promise<AgentVerifiedAttributionService> {
    const attribution = this.requireVerifiedAttribution();
    const start = this.verifiedAttributionStart;
    if (start) {
      await start;
      if (this.verifiedAttributionStart === start) {
        this.verifiedAttributionStart = undefined;
        this.verifiedAttributionReady = true;
      }
    }
    return attribution;
  }

  private beginFullOwnerBootstrap(productionRuns: ProductionRunV1[]): void {
    this.fullOwnerBootstrapState = "running";
    this.fullOwnerBootstrapLastErrorCode = undefined;
    this.fullOwnerBootstrap = this.reconcileHistoricalFullOwnerState(productionRuns)
      .then(async () => {
        if (this.fullOwnerBootstrapCancelled) {
          return;
        }
        this.fullOwnerBootstrapState = "ready";
        this.fullOwnerBootstrapLastErrorCode = undefined;
        await this.requireDiagnostics().record("historical_reconciliation_changed", "info", this.now().toISOString());
        this.emitEvent("attribution_changed");
        this.emitEvent("repository_changed");
        this.emitEvent("webhook_changed");
      })
      .catch(async (error) => {
        if (this.fullOwnerBootstrapCancelled) {
          return;
        }
        this.fullOwnerBootstrapState = "failed";
        this.fullOwnerBootstrapLastErrorCode = safeErrorCode(error);
        this.health = "degraded";
        await this.requireDiagnostics().record("historical_reconciliation_changed", "warning", this.now().toISOString());
        this.emitEvent("health_changed");
      });
  }

  private async reconcileHistoricalFullOwnerState(productionRuns: ProductionRunV1[]): Promise<void> {
    if (!this.shouldContinueFullOwnerBootstrap()) {
      return;
    }
    await this.requireVerifiedAttribution().observeProductionRuns(productionRuns);
    if (!this.shouldContinueFullOwnerBootstrap()) {
      return;
    }
    // Durable outbox recovery and the bounded live-recovery rebuild already own
    // lifecycle replay. Full attribution bootstrap must not re-project every
    // historical run and contend with fresh terminal corrections.
    this.scheduleWebhookLifecycleProjection([], {
      reconcileCommitEvents: true,
      priority: false
    });
  }

  private shouldContinueFullOwnerBootstrap(): boolean {
    return !this.fullOwnerBootstrapCancelled && Boolean(this.storage);
  }

  private liveRecoveryCutoffAt(): string {
    return new Date(this.now().getTime() - LIVE_RECOVERY_WINDOW_MS).toISOString();
  }

  private async reconcileHistoricalAttributionNow(): Promise<AgentHistoricalReconciliationStatusV1> {
    if (this.requireMetadata().ownershipState !== "agent_full_owner") {
      throw new Error("unsupported_capability");
    }
    await this.requireVerifiedAttributionStarted();
    if (this.fullOwnerBootstrapState === "running" && this.fullOwnerBootstrap) {
      await this.fullOwnerBootstrap;
      return await this.historicalReconciliationStatus();
    }
    this.beginFullOwnerBootstrap(await this.requireProductionUsage().runs("agent_full_owner"));
    await this.fullOwnerBootstrap;
    return await this.historicalReconciliationStatus();
  }

  private async historicalReconciliationStatus(): Promise<AgentHistoricalReconciliationStatusV1> {
    if (this.requireMetadata().ownershipState !== "agent_full_owner") {
      return {
        schemaVersion: 1,
        state: "not_required",
        liveFirst: true,
        historicalSecond: true,
        processedCompletedRunCount: 0,
        deferredCompletedRunCount: 0
      };
    }
    const historical = await this.requireVerifiedAttribution().historicalStatus(
      await this.requireProductionUsage().runs("agent_full_owner")
    );
    return {
      schemaVersion: 1,
      state: this.fullOwnerBootstrapState,
      liveFirst: true,
      historicalSecond: true,
      ...(historical.historicalCutoffAt ? { historicalCutoffAt: historical.historicalCutoffAt } : {}),
      processedCompletedRunCount: historical.processedCompletedRunCount,
      deferredCompletedRunCount: historical.deferredCompletedRunCount,
      ...(this.fullOwnerBootstrapLastErrorCode ? { lastErrorCode: this.fullOwnerBootstrapLastErrorCode } : {})
    };
  }

  private async startVerifiedAttribution(): Promise<void> {
    this.fullOwnerBootstrapCancelled = false;
    this.fullOwnerBootstrapState = "deferred";
    this.fullOwnerBootstrapLastErrorCode = undefined;
    await this.startFullOwnerCoreServices();
  }

  private async startWebhookDispatch(): Promise<void> {
    this.webhookDispatch = new ExternalWebhookDispatchService(
      this.requireStorage(),
      {
        configurationPath: `${this.paths.stateDir}/webhook-config.json`
      },
      this.requireVerifiedAttribution(),
      this.repositoryObservation!,
      () => this.now().getTime(),
      (event) => this.recordLivePipelineEvent(event),
      this.requireMetadata().installationId
    );
    await this.webhookDispatch.start();
  }

  private async clearLocalAgentData(): Promise<void> {
    const clearedAt = this.now().toISOString();
    const owner = this.requireMetadata().ownershipState;
    const otlpBaseUrl = this.otlp ? `http://${this.otlp.address().host}:${this.otlp.address().port}` : undefined;
    this.attributionSyncUnsubscribe?.();
    this.attributionSyncUnsubscribe = undefined;
    this.workspaceEvidenceSyncUnsubscribe?.();
    this.workspaceEvidenceSyncUnsubscribe = undefined;
    await this.webhookDispatch?.clearLocalAgentData().catch(() => undefined);
    await this.webhookDispatch?.stop().catch(() => undefined);
    this.webhookDispatch = undefined;
    await this.verifiedAttribution?.stop().catch(() => undefined);
    this.verifiedAttribution = undefined;
    this.verifiedAttributionStart = undefined;
    await this.repositoryObservation?.stop().catch(() => undefined);
    this.repositoryObservation = undefined;
    this.legacyEngineLeases.clear();
    if (otlpBaseUrl) {
      for (const provider of CONFIGURABLE_PROVIDERS) {
        try {
          this.sourceConfiguration.restore(provider, otlpBaseUrl, this.otlpAuthToken);
        } catch {
          // Reset still clears agent state even if a local provider file cannot be restored.
        }
      }
    }

    await this.requireStorage().clearAllAgentData(clearedAt);
    this.requireDiagnostics().clearDurableLog();
    purgeLocalAgentArtifacts(this.paths);
    this.telemetryIngressLifecycle = {
      acceptedCount: 0,
      rejectedCount: 0
    };
    this.metadata = await this.requireStorage().metadata();
    this.writeOwnershipMarker(this.metadata.ownershipState, this.metadata.updatedAt);

    this.repositoryScopes = new RepositoryScopeManagement(
      this.requireStorage(),
      this.paths.repositoryLocatorKeyPath,
      this.now
    );
    this.repositoryObservation = new AgentRepositoryObservationService(
      this.requireStorage(),
      this.repositoryScopes,
      this.paths.attributionHmacKeyPath,
      2_000,
      (event) => this.recordLivePipelineEvent(event)
    );
    await this.requireShadowUsage().rebuild();
    if (owner === "agent_usage_owner" || owner === "agent_full_owner") {
      await this.requireProductionUsage().startCleanEpoch(clearedAt);
      await this.requireBudgetWarnings().rebuild([]);
    }
    if (owner === "agent_full_owner") {
      await this.repositoryObservation.start();
      await this.startVerifiedAttribution();
    }
    await this.requireDiagnostics().record("agent_data_cleared", "info", clearedAt);
    this.emitEvent("usage_changed");
    this.emitEvent("warnings_changed");
    this.emitEvent("attribution_changed");
    this.emitEvent("webhook_changed");
    this.emitEvent("repository_changed");
  }

  private async webhookStatus(): Promise<AgentWebhookStatusV1> {
    if (this.webhookDispatch) {
      return await this.webhookDispatch.status();
    }
    return {
      schemaVersion: 1,
      sender: {},
      runEndedEnabled: true,
      commitAttributedEnabled: true,
      bearerTokenConfigured: false,
      hmacSecretConfigured: false,
      queuedCount: 0,
      blockedCount: 0,
      deliveredCount: 0
    };
  }

  private async diagnosticSnapshot(): Promise<AgentDiagnosticsV1> {
    this.scheduleDiagnosticRefresh();
    await this.waitForRuntimeWork("diagnostics_refresh", DIAGNOSTIC_REFRESH_WAIT_MS);
    return await this.requireDiagnostics().snapshot({
      health: this.health,
      ownershipState: this.requireMetadata().ownershipState,
      webhook: await this.webhookDispatch?.status().catch(() => undefined)
    });
  }

  private scheduleDiagnosticRefresh(): void {
    this.runtimeWork.enqueue("diagnostics_refresh", async () => {
      await this.refreshConstructStates();
    });
  }

  private async waitForRuntimeWork(key: RuntimeWorkKey, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) {
      return;
    }
    if (key === "usage_projection" && this.usageProjectionTimer) {
      clearTimeout(this.usageProjectionTimer);
      this.usageProjectionTimer = undefined;
      this.enqueueUsageProjection();
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.runtimeWork.drainKey(key),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  private async refreshConstructStates(): Promise<void> {
    const diagnostics = this.requireDiagnostics();
    const refreshedAt = this.now().toISOString();
    const constructStates = await this.collectConstructStates(refreshedAt);
    for (const state of constructStates) {
      await diagnostics.recordConstructState(state);
    }
  }

  private async collectConstructStates(updatedAt: string): Promise<AgentConstructStateV1[]> {
    const metadata = this.requireMetadata();
    const storage = this.requireStorage();
    const repositoryObservation = this.repositoryObservation;
    const telemetryBaseUrl = this.otlp ? `http://${this.otlp.address().host}:${this.otlp.address().port}` : undefined;
    const repositoryCandidates = safeCollect(async () => repositoryObservation?.requireObservation().listCandidates() ?? []);
    const [webhook, snapshots, candidates, attributions, attributionSummary, sources, repositoryScopes, safeObservationCount, recentEvents] = await Promise.all([
      this.webhookDispatch?.status().catch(() => undefined),
      safeCollect(async () => repositoryObservation?.listSnapshots() ?? []),
      repositoryCandidates,
      storage.listAgentDocuments("query_attribution").catch(() => []),
      storage.attributionDocumentSummary().catch(() => undefined),
      storage.listSources().catch(() => []),
      storage.listRepositoryScopes().catch(() => []),
      storage.safeObservationCount().catch(() => 0),
      this.requireDiagnostics().events(20).catch(() => [])
    ]);
    const queryAttributions = attributions.map((item) => item.value as {
      status?: string;
      allocations?: unknown[];
      queryId?: string;
    });
    const latestSnapshotAt = snapshots.at(-1)?.observedAt;
    const candidateCounts = countBy(candidates, (candidate) => candidate.decision);
    const attributionCounts = countBy(queryAttributions, (attribution) => attribution.status ?? "unknown");
    const evidenceCounts = attributionSummary?.workspaceEvidence.statusCounts ?? {};
    const episodeCounts = attributionSummary?.workEpisodes.statusCounts ?? {};
    const evidenceCount = attributionSummary?.workspaceEvidence.totalCount ?? 0;
    const episodeCount = attributionSummary?.workEpisodes.totalCount ?? 0;
    const unboundEpisodeCount = attributionSummary?.workEpisodes.unboundCount ?? 0;
    const telemetryStatusProviders: readonly SupportedProvider[] = telemetryBaseUrl ? MEASUREMENT_PROVIDERS : ["github-copilot"];
    const telemetrySourceStatuses = await Promise.all(telemetryStatusProviders.map((provider) =>
      this.providerSourceStatus(provider, telemetryBaseUrl ?? "")
    ));
    const telemetryConfigurationAvailable = Boolean(telemetryBaseUrl)
      || telemetrySourceStatuses.some((status) =>
        status.provider === "github-copilot" && status.configurationState !== "not_configured");
    const activeRepositoryCount = repositoryScopes.filter((record) =>
      record.scope.kind === "repository" && record.scope.state === "active").length;
    const telemetryConfiguredCount = telemetrySourceStatuses.filter((status) => status.configurationState === "configured").length;
    const telemetryPartialCount = telemetrySourceStatuses.filter((status) => status.configurationState === "partial").length;
    const telemetryConflictCount = telemetrySourceStatuses.filter((status) => status.configurationState === "conflict").length;
    const states: AgentConstructStateV1[] = [
      {
        schemaVersion: 1,
        construct: "AgentRuntimeControl",
        state: this.health,
        health: this.health === "healthy" ? "healthy" : this.health === "degraded" ? "degraded" : "blocked",
        updatedAt,
        reason: this.runtimeWarmupState === "failed"
          ? this.runtimeWarmupLastErrorCode ?? "runtime_warmup_failed"
          : this.fullOwnerBootstrapState === "failed"
            ? this.fullOwnerBootstrapLastErrorCode ?? "historical_reconciliation_failed"
            : undefined,
        details: {
          ownershipState: metadata.ownershipState,
          runtimeWarmupState: this.runtimeWarmupState,
          fullOwnerBootstrapState: this.fullOwnerBootstrapState,
          startedAt: this.startedAt ?? updatedAt
        }
      },
      {
        schemaVersion: 1,
        construct: "TelemetrySourceConfiguration",
        state: !telemetryConfigurationAvailable
          ? "unavailable"
          : telemetryConflictCount > 0
            ? "conflict"
            : telemetryPartialCount > 0
              ? "partial"
              : telemetryConfiguredCount > 0
                ? "configured"
                : "not_configured",
        health: !telemetryConfigurationAvailable
          ? "blocked"
          : telemetryConflictCount > 0
            ? "degraded"
            : "healthy",
        updatedAt,
        reason: !telemetryConfigurationAvailable
          ? "telemetry_source_not_available"
          : telemetryConflictCount > 0
            ? "existing_exporter_conflict"
            : undefined,
        details: {
          configuredProviderCount: telemetryConfiguredCount,
          partialProviderCount: telemetryPartialCount,
          conflictProviderCount: telemetryConflictCount,
          claudeCodeState: telemetrySourceStatuses.find((status) => status.provider === "claude-code")?.configurationState ?? "unavailable",
          claudeCodeTracesEnabled: telemetrySourceStatuses.find((status) => status.provider === "claude-code")?.tracesEnabled ?? false,
          codexState: telemetrySourceStatuses.find((status) => status.provider === "codex")?.configurationState ?? "unavailable",
          codexTracesEnabled: telemetrySourceStatuses.find((status) => status.provider === "codex")?.tracesEnabled ?? false,
          cursorState: telemetrySourceStatuses.find((status) => status.provider === "cursor")?.configurationState ?? "unavailable",
          cursorTracesEnabled: telemetrySourceStatuses.find((status) => status.provider === "cursor")?.tracesEnabled ?? false,
          githubCopilotState: telemetrySourceStatuses.find((status) => status.provider === "github-copilot")?.configurationState ?? "unavailable",
          githubCopilotTracesEnabled: telemetrySourceStatuses.find((status) => status.provider === "github-copilot")?.tracesEnabled ?? false
        }
      },
      {
        schemaVersion: 1,
        construct: "TelemetryIngress",
        state: !this.otlp
          ? "stopped"
          : safeObservationCount > 0 || this.telemetryIngressLifecycle.acceptedCount > 0
            ? "observing"
            : this.telemetryIngressLifecycle.rejectedCount > 0
              ? "rejecting_receipts"
              : "awaiting_receipts",
        health: !this.otlp
          ? "blocked"
          : this.telemetryIngressLifecycle.rejectedCount > 0 && safeObservationCount === 0
            ? "degraded"
            : "healthy",
        updatedAt,
        reason: !this.otlp
          ? "otlp_ingress_not_running"
          : this.telemetryIngressLifecycle.rejectedCount > 0 && safeObservationCount === 0
            ? this.telemetryIngressLifecycle.lastRejectedReason ?? "otlp_request_rejected"
            : safeObservationCount === 0
              ? "no_receipts_observed"
              : undefined,
        details: {
          sourceCount: sources.length,
          safeObservationCount,
          acceptedReceiptCount: this.telemetryIngressLifecycle.acceptedCount,
          rejectedRequestCount: this.telemetryIngressLifecycle.rejectedCount,
          lastAcceptedAt: this.telemetryIngressLifecycle.lastAcceptedAt ?? null,
          lastAcceptedProvider: this.telemetryIngressLifecycle.lastAcceptedProvider ?? null,
          lastAcceptedSignal: this.telemetryIngressLifecycle.lastAcceptedSignal ?? null,
          lastAcceptedSourceId: this.telemetryIngressLifecycle.lastAcceptedSourceId ?? null,
          lastRejectedAt: this.telemetryIngressLifecycle.lastRejectedAt ?? null,
          lastRejectedReason: this.telemetryIngressLifecycle.lastRejectedReason ?? null,
          lastRejectedSignal: this.telemetryIngressLifecycle.lastRejectedSignal ?? null
        }
      },
      {
        schemaVersion: 1,
        construct: "MeasurementActivation",
        state: activeRepositoryCount === 0
          ? "idle"
          : telemetrySourceStatuses.some((status) => status.logsEnabled && status.tracesEnabled && status.ownershipState !== "foreign_managed")
            ? "ready"
            : telemetryConflictCount > 0
              ? "blocked"
              : "awaiting_source",
        health: activeRepositoryCount === 0
          ? "healthy"
          : telemetryConflictCount > 0
            ? "degraded"
            : "healthy",
        updatedAt,
        reason: activeRepositoryCount === 0
          ? undefined
          : telemetryConflictCount > 0
            ? "measurement_activation_blocked"
            : telemetryConfiguredCount === 0 && telemetryPartialCount === 0
              ? "source_configuration_required"
              : undefined,
        details: {
          activeRepositoryCount,
          configuredProviderCount: telemetryConfiguredCount,
          partialProviderCount: telemetryPartialCount,
          conflictProviderCount: telemetryConflictCount
        }
      },
      {
        schemaVersion: 1,
        construct: "RepositoryObservation",
        state: this.repositoryObservation?.running() ? "observing" : "stopped",
        health: this.repositoryObservation?.running() ? "healthy" : "blocked",
        updatedAt,
        reason: !this.repositoryObservation?.running() ? "repository_observer_not_running" : undefined,
        details: {
          snapshotCount: snapshots.length,
          latestSnapshotAt: latestSnapshotAt ?? null,
          pendingEvidenceCandidates: candidateCounts.pending_evidence ?? 0,
          reportableCandidates: candidateCounts.reportable ?? 0,
          rewritePendingCandidates: candidateCounts.rewrite_pending ?? 0
        }
      },
      {
        schemaVersion: 1,
        construct: "WorkspaceChangeTracker",
        state: evidenceCount > 0 ? "tracking" : "idle",
        health: "healthy",
        updatedAt,
        details: {
          evidenceCount,
          activeEvidenceCount: evidenceCounts.active ?? 0,
          settlingEvidenceCount: evidenceCounts.settling ?? 0,
          completedEvidenceCount: evidenceCounts.completed ?? 0
        }
      },
      {
        schemaVersion: 1,
        construct: "AgenticWorkEpisode",
        state: episodeCount > 0 ? "tracking" : "idle",
        health: "healthy",
        updatedAt,
        details: {
          episodeCount,
          openEpisodeCount: episodeCounts.open ?? 0,
          claimedEpisodeCount: episodeCounts.claimed ?? 0,
          staleEpisodeCount: episodeCounts.stale ?? 0,
          expiredEpisodeCount: episodeCounts.expired ?? 0,
          unboundEpisodeCount
        }
      },
      {
        schemaVersion: 1,
        construct: "GitAttribution",
        state: candidateCounts.pending_evidence ? "pending_evidence" : "reconciled",
        health: candidateCounts.pending_evidence ? "degraded" : "healthy",
        updatedAt,
        reason: candidateCounts.pending_evidence ? "pending_commit_candidates_waiting_for_evidence" : undefined,
        details: {
          queryAttributionCount: queryAttributions.length,
          attributedQueryCount: attributionCounts.attributed ?? 0,
          pendingEvidenceQueryCount: attributionCounts.pending_evidence ?? 0,
          unattributedQueryCount: attributionCounts.unattributed ?? 0,
          expiredQueryCount: attributionCounts.expired ?? 0,
          pendingCandidateCount: candidateCounts.pending_evidence ?? 0,
          reportableCandidateCount: candidateCounts.reportable ?? 0
        }
      },
      {
        schemaVersion: 1,
        construct: "Diagnostics",
        state: "recording",
        health: "healthy",
        updatedAt,
        details: {
          logChannel: "agent.log.jsonl",
          recentEventCount: recentEvents.length,
          newestEventCode: recentEvents[0]?.code ?? null,
          newestEventAt: recentEvents[0]?.at ?? null
        }
      }
    ];
    if (webhook) {
      states.push({
        schemaVersion: 1,
        construct: "ExternalWebhookDispatch",
        state: webhook.url
          ? webhook.blockedCount > 0
            ? "blocked"
            : webhook.queuedCount > 0
              ? "draining_queue"
              : "ready"
          : "not_configured",
        health: webhook.blockedCount > 0 ? "degraded" : "healthy",
        updatedAt,
        reason: webhook.lastErrorCode,
        details: {
          urlConfigured: Boolean(webhook.url),
          runEndedEnabled: webhook.runEndedEnabled,
          commitAttributedEnabled: webhook.commitAttributedEnabled,
          queuedCount: webhook.queuedCount,
          blockedCount: webhook.blockedCount,
          deliveredCount: webhook.deliveredCount,
          oldestQueuedAt: webhook.oldestQueuedAt ?? null,
          maxQueueAgeMs: webhook.maxQueueAgeMs ?? null,
          lastDeliveredAt: webhook.lastDeliveredAt ?? null
        }
      });
    }
    return states;
  }

  private async applySafeJournalRetention(): Promise<void> {
    const storage = this.requireStorage();
    const retainAfter = new Date(this.now().getTime() - SAFE_JOURNAL_RETENTION_MS).toISOString();
    const [result, executionNodes] = await Promise.all([
      storage.applySafeObservationRetention(retainAfter, SAFE_JOURNAL_MAX_OBSERVATIONS),
      storage.applyExecutionNodeRetention(retainAfter, SAFE_EXECUTION_NODE_MAX_DOCUMENTS)
    ]);
    const at = this.now().toISOString();
    if (result.removedByAge > 0 || result.removedByOverflow > 0) {
      const existing = (await storage.listAgentDocuments<{ pruned: number; overflow: number }>("journal_state"))
        .find((item) => item.key === "retention")?.value;
      await storage.upsertAgentDocument("journal_state", {
        key: "retention",
        sortAt: at,
        value: {
          pruned: (existing?.pruned ?? 0) + result.removedByAge,
          overflow: (existing?.overflow ?? 0) + result.removedByOverflow
        }
      });
      await this.requireDiagnostics().record("safe_journal_pruned", "info", at);
    }
    if (executionNodes.removedByAge > 0 || executionNodes.removedByOverflow > 0) {
      await this.requireDiagnostics().record("execution_node_evidence_pruned", "info", at, {
        details: {
          removedByAge: executionNodes.removedByAge,
          removedByOverflow: executionNodes.removedByOverflow,
          retainedCount: executionNodes.retainedCount
        }
      });
    }
  }

  private async applyStartupExecutionEvidenceBound(): Promise<void> {
    const storage = this.requireStorage();
    const [result, removedLegacySnapshots, sanitizedAttributionDocuments] = await Promise.all([
      storage.applyExecutionNodeRetention(new Date(0).toISOString(), SAFE_EXECUTION_NODE_MAX_DOCUMENTS),
      storage.pruneRepositorySnapshotDocuments(MAX_REPOSITORY_SNAPSHOT_ARTIFACT_STATES),
      storage.sanitizeOversizedAttributionDocuments(MAX_REPOSITORY_SNAPSHOT_ARTIFACT_STATES)
    ]);
    const compacted = await storage.compactIfFragmented();
    const at = this.now().toISOString();
    if (result.removedByOverflow > 0) {
      await this.requireDiagnostics().record("execution_node_evidence_pruned", "info", at, {
        details: {
          removedByAge: result.removedByAge,
          removedByOverflow: result.removedByOverflow,
          retainedCount: result.retainedCount
        }
      });
    }
    if (!compacted.compacted) {
      if (sanitizedAttributionDocuments.workspaceEvidenceSanitized > 0 || sanitizedAttributionDocuments.workEpisodesSanitized > 0) {
        await this.requireDiagnostics().record("attribution_evidence_sanitized", "warning", at, {
          details: {
            workspaceEvidenceSanitized: sanitizedAttributionDocuments.workspaceEvidenceSanitized,
            workEpisodesSanitized: sanitizedAttributionDocuments.workEpisodesSanitized,
            maxArtifactStates: MAX_REPOSITORY_SNAPSHOT_ARTIFACT_STATES
          }
        });
      }
      return;
    }
    if (sanitizedAttributionDocuments.workspaceEvidenceSanitized > 0 || sanitizedAttributionDocuments.workEpisodesSanitized > 0) {
      await this.requireDiagnostics().record("attribution_evidence_sanitized", "warning", at, {
        details: {
          workspaceEvidenceSanitized: sanitizedAttributionDocuments.workspaceEvidenceSanitized,
          workEpisodesSanitized: sanitizedAttributionDocuments.workEpisodesSanitized,
          maxArtifactStates: MAX_REPOSITORY_SNAPSHOT_ARTIFACT_STATES
        }
      });
    }
    await this.requireDiagnostics().record("storage_compacted", "info", at, {
      details: {
        pageCountBefore: compacted.pageCountBefore,
        freePageCountBefore: compacted.freePageCountBefore,
        pageCountAfter: compacted.pageCountAfter,
        freePageCountAfter: compacted.freePageCountAfter,
        removedExecutionNodeCount: result.removedByAge + result.removedByOverflow,
        removedRepositorySnapshotCount: removedLegacySnapshots
      }
    });
  }

  private scheduleLiveIngestProcessing(observation?: SafeObservationV1): void {
    const hasMeasurementEvidence = !observation || hasLiveMeasurementEvidence(observation);
    if (observation && hasMeasurementEvidence) {
      this.lastLiveMeasurementAtMs = this.now().getTime();
      this.scheduleTerminalUsageProjection(observation);
    }
    if (observation && hasMeasurementEvidence && this.metadata?.ownershipState === "agent_full_owner") {
      const queue = hasPriorityLiveLifecycleEvidence(observation)
        ? this.pendingPriorityLiveWebhookObservations
        : this.pendingLiveWebhookObservations;
      queue.push(observation);
      this.runtimeWork.enqueue("webhook_live_projection", async () => {
        await this.drainLiveWebhookProjection();
      });
      if ((observation.queryOccurrences?.length ?? 0) > 0) {
        this.pendingWorkspaceEvidenceObservations.push(observation);
        if (hasRepositoryObservationDemand(observation)) {
          this.repositoryObservation?.requestActiveObservationWindow(
            LIVE_REPOSITORY_OBSERVATION_WINDOW_MS,
            LIVE_REPOSITORY_OBSERVATION_POLL_MS
          );
        }
        this.runtimeWork.enqueue("workspace_evidence_projection", async () => {
          await this.drainLiveWorkspaceEvidenceProjection();
        });
      }
    }
    if (!hasMeasurementEvidence) {
      return;
    }
    if (observation) {
      this.scheduleUsageProjectionAfterQuietPeriod();
      return;
    }
    this.enqueueUsageProjection();
  }

  private enqueueUsageProjection(): void {
    this.runtimeWork.enqueue("usage_projection", async () => {
      await this.queueUsageRebuild().catch(() => []);
    });
  }

  private scheduleTerminalUsageProjection(observation: SafeObservationV1): void {
    const now = this.now().getTime();
    for (const [sessionId, state] of this.recentTerminalUsageSessions) {
      if (state.expiresAt <= now) {
        this.recentTerminalUsageSessions.delete(sessionId);
      }
    }
    for (const occurrence of observation.queryOccurrences ?? []) {
      if (!isExplicitTerminalOccurrence(occurrence)) {
        continue;
      }
      const completedAt = Date.parse(occurrence.completedAt);
      const dueAt = Math.max(now, Number.isFinite(completedAt) ? completedAt + this.usageProjectionQuietMs : now);
      const existingSession = this.recentTerminalUsageSessions.get(occurrence.sessionId);
      this.recentTerminalUsageSessions.set(occurrence.sessionId, {
        queryId: occurrence.queryId,
        expiresAt: Math.max(
          existingSession?.expiresAt ?? 0,
          dueAt + LIVE_TERMINAL_USAGE_PROJECTION_RETENTION_MS
        ),
        authorityTriggered: existingSession?.authorityTriggered ?? false
      });
      if (this.terminalUsageProjectionTimers.has(occurrence.queryId)) {
        continue;
      }
      const timer = setTimeout(() => {
        this.terminalUsageProjectionTimers.delete(occurrence.queryId);
        this.enqueueTerminalUsageProjection(occurrence.queryId);
      }, Math.max(0, dueAt - now));
      timer.unref?.();
      this.terminalUsageProjectionTimers.set(occurrence.queryId, timer);
    }
    for (const atom of observation.usageAtoms.filter(isClosedAuthoritativeRunBoundaryAtom)) {
      if (!atom.sessionId) {
        continue;
      }
      const terminal = this.recentTerminalUsageSessions.get(atom.sessionId);
      if (!terminal || terminal.expiresAt <= now || terminal.authorityTriggered) {
        continue;
      }
      terminal.authorityTriggered = true;
      this.enqueueTerminalUsageProjection(terminal.queryId);
    }
  }

  private enqueueTerminalUsageProjection(queryId: string): void {
    const owner = this.metadata?.ownershipState;
    if (owner !== "agent_usage_owner" && owner !== "agent_full_owner") {
      this.enqueueUsageProjection();
      return;
    }
    this.runtimeWork.enqueue(`terminal_usage_projection:${queryId}`, async () => {
      const startedAtMs = Date.now();
      try {
        const runs = await this.requireProductionUsage().projectCompletedQuery(owner, queryId);
        if (owner === "agent_full_owner" && runs.length > 0) {
          this.scheduleWebhookLifecycleProjection(runs, { reconcileCommitEvents: true, priority: true });
        }
        if (runs.length > 0) {
          this.emitEvent("usage_changed");
          this.emitEvent("webhook_changed");
        }
        this.recordLivePipelineEvent({
          kind: "constructLifecycle",
          construct: "UsageProjection",
          operation: "terminal_projection",
          state: "completed",
          reason: "query_scoped_terminal_projection_completed",
          queryId,
          details: {
            projectedRunCount: runs.length,
            durationMs: Date.now() - startedAtMs
          }
        });
      } catch (error) {
        this.recordLivePipelineEvent({
          kind: "constructLifecycle",
          construct: "UsageProjection",
          operation: "terminal_projection",
          state: "failed",
          reason: "query_scoped_terminal_projection_failed",
          severity: "warning",
          queryId,
          details: {
            errorCode: safeErrorCode(error),
            durationMs: Date.now() - startedAtMs
          }
        });
      }
    });
  }

  private scheduleUsageProjectionAfterQuietPeriod(): void {
    if (this.usageProjectionTimer) {
      clearTimeout(this.usageProjectionTimer);
      this.usageProjectionTimer = undefined;
    }
    const delayMs = this.remainingUsageProjectionQuietMs();
    if (delayMs <= 0) {
      this.enqueueUsageProjection();
      return;
    }
    this.usageProjectionTimer = setTimeout(() => {
      this.usageProjectionTimer = undefined;
      this.scheduleUsageProjectionAfterQuietPeriod();
    }, delayMs);
    this.usageProjectionTimer.unref?.();
  }

  private remainingUsageProjectionQuietMs(): number {
    if (this.lastLiveMeasurementAtMs == null) {
      return 0;
    }
    return Math.max(0, this.lastLiveMeasurementAtMs + this.usageProjectionQuietMs - this.now().getTime());
  }

  private async drainLiveWebhookProjection(): Promise<void> {
    if (this.metadata?.ownershipState !== "agent_full_owner" || !this.webhookDispatch) {
      this.pendingPriorityLiveWebhookObservations = [];
      this.pendingLiveWebhookObservations = [];
      return;
    }
    let projected = false;
    for (;;) {
      const observation = this.pendingPriorityLiveWebhookObservations.shift()
        ?? this.pendingLiveWebhookObservations.shift();
      if (!observation) {
        break;
      }
      await this.webhookDispatch.observeSafeObservation(observation).catch(() => undefined);
      projected = true;
    }
    if (projected) {
      this.emitEvent("webhook_changed");
    }
  }

  private async drainLiveWorkspaceEvidenceProjection(): Promise<void> {
    const observations = this.pendingWorkspaceEvidenceObservations.splice(0);
    if (this.metadata?.ownershipState !== "agent_full_owner" || !this.verifiedAttribution) {
      return;
    }
    for (const observation of observations) {
      await this.verifiedAttribution.observeSafeObservation(observation).catch(() => undefined);
    }
  }

  private async runPeriodicUsageMaintenance(): Promise<void> {
    if (this.remainingUsageProjectionQuietMs() > 0) {
      this.scheduleUsageProjectionAfterQuietPeriod();
      return;
    }
    await this.queueUsageRebuild().catch(() => []);
    await this.applySafeJournalRetention().catch(() => undefined);
  }

  private queueUsageRebuild(): Promise<ProductionRunV1[]> {
    this.usageRebuildRequested = true;
    if (this.usageRebuildRunning) {
      return this.usageRebuildQueue;
    }
    const operation = this.runQueuedUsageRebuilds();
    this.usageRebuildQueue = operation;
    return operation;
  }

  private async runQueuedUsageRebuilds(): Promise<ProductionRunV1[]> {
    this.usageRebuildRunning = true;
    let runs: ProductionRunV1[] = [];
    try {
      do {
        this.usageRebuildRequested = false;
        runs = await this.rebuildUsageProducts();
      } while (this.usageRebuildRequested);
      return runs;
    } finally {
      this.usageRebuildRunning = false;
    }
  }

  private async rebuildUsageProducts(): Promise<ProductionRunV1[]> {
    await this.requireShadowUsage().rebuild();
    const owner = this.requireMetadata().ownershipState;
    if (owner !== "agent_usage_owner" && owner !== "agent_full_owner") {
      return [];
    }
    const previousRuns = await this.requireProductionUsage().runs(owner).catch(() => []);
    const previousCompletedSignatures = new Map(previousRuns
      .filter(isCompletedProductionRun)
      .map((run) => [run.runId, productionRunProjectionSignature(run)]));
    const runs = await this.requireProductionUsage().rebuild(owner);
    await this.requireBudgetWarnings().rebuild(runs);
    const rebuiltAt = this.now().toISOString();
    let processedCount = 0;
    let deferredCount = 0;
    this.emitEvent("usage_changed");
    this.emitEvent("warnings_changed");
    if (owner === "agent_full_owner") {
      const completedRuns = runs.filter(isCompletedProductionRun);
      const historicalProjectionAlreadyScheduled = this.historicalWebhookLifecycleProjectionScheduled;
      const completedRunsForLifecycleProjection = historicalProjectionAlreadyScheduled
        ? completedRuns.filter((run) => previousCompletedSignatures.get(run.runId) !== productionRunProjectionSignature(run))
        : completedRuns.filter((run) => run.endedAt != null && run.endedAt >= this.liveRecoveryCutoffAt());
      this.historicalWebhookLifecycleProjectionScheduled = true;
      if (completedRunsForLifecycleProjection.length > 0) {
        this.scheduleWebhookLifecycleProjection(completedRunsForLifecycleProjection, {
          reconcileCommitEvents: true,
          priority: historicalProjectionAlreadyScheduled
        });
      }
      const attribution = this.verifiedAttributionReady ? this.verifiedAttribution : undefined;
      if (!attribution) {
        deferredCount = completedRuns.length;
      } else {
        await attribution.observeCurrentRuns(
          await this.requireProductionUsage().currentRuns(owner)
        );
        const incremental = await attribution.observeCompletedRunsIncrementally(runs);
        processedCount = incremental.processedCount;
        deferredCount = incremental.deferredCount;
        if (incremental.processedCount > 0 && incremental.processedRuns.length > 0) {
          this.scheduleWebhookLifecycleProjection(incremental.processedRuns, {
            reconcileCommitEvents: true
          });
        }
        if (incremental.processedCount > 0) {
          this.scheduleWebhookLifecycleProjection([], {
            reconcileCommitEvents: true
          });
          this.emitEvent("attribution_changed");
          this.emitEvent("webhook_changed");
        }
      }
    }
    await this.requireDiagnostics().record("production_usage_rebuilt", "info", rebuiltAt, {
      message: "Production usage rebuild completed.",
      details: {
        ownershipState: owner,
        productionRunCount: runs.length,
        processedCompletedRunCount: processedCount,
        deferredCompletedRunCount: deferredCount
      }
    });
    return runs;
  }

  private scheduleWebhookLifecycleProjection(
    runs: ProductionRunV1[],
    options: { reconcileCommitEvents?: boolean; priority?: boolean } = {}
  ): void {
    const priority = options.priority !== false;
    for (const run of runs.filter(isCompletedProductionRun)) {
      const existingPriority = this.pendingPriorityWebhookLifecycleProjectionRuns.get(run.runId);
      if (!priority && existingPriority) {
        continue;
      }
      if (priority) {
        this.pendingHistoricalWebhookLifecycleProjectionRuns.delete(run.runId);
      }
      const target = priority
        ? this.pendingPriorityWebhookLifecycleProjectionRuns
        : this.pendingHistoricalWebhookLifecycleProjectionRuns;
      target.set(run.runId, {
        run,
        priority,
        sequence: ++this.webhookLifecycleProjectionSequence,
        queuedAtMs: Date.now()
      });
    }
    this.pendingWebhookLifecycleCommitReconcile ||= options.reconcileCommitEvents !== false;
    const pendingRunCount = this.pendingPriorityWebhookLifecycleProjectionRuns.size
      + this.pendingHistoricalWebhookLifecycleProjectionRuns.size;
    if (pendingRunCount === 0 && !this.pendingWebhookLifecycleCommitReconcile) {
      return;
    }
    const lane = priority
      ? "webhook_lifecycle_priority_projection"
      : "webhook_lifecycle_projection";
    this.runtimeWork.enqueue(lane, async () => {
      await this.drainWebhookLifecycleProjection(priority);
    });
  }

  private async drainWebhookLifecycleProjection(priority: boolean): Promise<void> {
    if (this.requireMetadata().ownershipState !== "agent_full_owner" || !this.webhookDispatch) {
      this.pendingPriorityWebhookLifecycleProjectionRuns.clear();
      this.pendingHistoricalWebhookLifecycleProjectionRuns.clear();
      this.pendingWebhookLifecycleCommitReconcile = false;
      return;
    }
    const pendingRuns = priority
      ? this.pendingPriorityWebhookLifecycleProjectionRuns
      : this.pendingHistoricalWebhookLifecycleProjectionRuns;
    const pending = [...pendingRuns.values()]
      .sort(comparePendingWebhookLifecycleProjection);
    const next = pending[0];
    if (next) {
      pendingRuns.delete(next.run.runId);
      this.webhookLifecycleProjectionInFlight += 1;
    }
    let projected = false;
    const projectionStartedAtMs = Date.now();
    try {
      if (next) {
        this.recordLivePipelineEvent({
          kind: "constructLifecycle",
          construct: "ExternalWebhookDispatch",
          operation: "projection",
          state: "started",
          reason: "webhook_lifecycle_projection_started",
          runId: next.run.runId,
          queryId: next.run.queryId ?? next.run.correlationId,
          details: {
            priority,
            queueLatencyMs: projectionStartedAtMs - next.queuedAtMs
          }
        });
        await this.webhookDispatch.observeCompletedRuns([next.run]);
        projected = true;
        this.recordLivePipelineEvent({
          kind: "constructLifecycle",
          construct: "ExternalWebhookDispatch",
          operation: "projection",
          state: "completed",
          reason: "webhook_lifecycle_projection_completed",
          runId: next.run.runId,
          queryId: next.run.queryId ?? next.run.correlationId,
          details: {
            priority,
            queueLatencyMs: projectionStartedAtMs - next.queuedAtMs,
            durationMs: Date.now() - projectionStartedAtMs
          }
        });
      }
    } catch (error) {
      this.recordLivePipelineEvent({
        kind: "constructLifecycle",
        construct: "ExternalWebhookDispatch",
        operation: "projection",
        state: "failed",
        reason: "webhook_lifecycle_projection_failed",
        severity: "warning",
        details: {
          errorCode: safeErrorCode(error),
          pendingRunCount: this.pendingPriorityWebhookLifecycleProjectionRuns.size
            + this.pendingHistoricalWebhookLifecycleProjectionRuns.size,
          batchRunCount: next ? 1 : 0,
          priority
        }
      });
    } finally {
      if (next) {
        this.webhookLifecycleProjectionInFlight -= 1;
      }
    }
    const reconcileCommitEvents = this.pendingWebhookLifecycleCommitReconcile
      && this.pendingPriorityWebhookLifecycleProjectionRuns.size === 0
      && this.pendingHistoricalWebhookLifecycleProjectionRuns.size === 0
      && this.webhookLifecycleProjectionInFlight === 0;
    if (reconcileCommitEvents) {
      this.pendingWebhookLifecycleCommitReconcile = false;
      this.scheduleWebhookCommitReconciliation();
    }
    if (projected || reconcileCommitEvents) {
      this.emitEvent("webhook_changed");
    }
    if (pendingRuns.size > 0) {
      const lane = priority
        ? "webhook_lifecycle_priority_projection"
        : "webhook_lifecycle_projection";
      this.runtimeWork.enqueue(lane, async () => {
        await this.drainWebhookLifecycleProjection(priority);
      });
    }
  }

  private scheduleWebhookCommitReconciliation(): void {
    this.runtimeWork.enqueue("webhook_commit_projection", async () => {
      if (this.requireMetadata().ownershipState !== "agent_full_owner" || !this.webhookDispatch) {
        return;
      }
      await this.webhookDispatch.reconcileCommitEvents().catch(() => undefined);
      this.emitEvent("webhook_changed");
    });
  }

  private async promptCaptureEnabled(provider: SupportedProvider): Promise<boolean> {
    const document = (await this.requireStorage().listAgentDocuments<{ enabled: boolean }>("prompt_capture_config"))
      .find((item) => item.key === provider);
    return document?.value.enabled === true;
  }

  private async setPromptCapture(provider: SupportedProvider, enabled: boolean): Promise<void> {
    const at = this.now().toISOString();
    await this.requireStorage().upsertAgentDocument("prompt_capture_config", {
      key: provider,
      sortAt: at,
      value: { enabled }
    });
    this.otlp?.setPromptCapture(provider, enabled);
    if (provider === "github-copilot") {
      this.copilotSpanDb?.setPromptCapture(enabled);
    }
  }

  private async applyProductRetention(): Promise<void> {
    const operation = this.productRetentionQueue.then(async () => {
      const owner = this.requireMetadata().ownershipState;
      const now = this.now();
      const snapshotRetainAfter = new Date(now.getTime() - SAFE_JOURNAL_RETENTION_MS).toISOString();
      await this.repositoryObservation?.applyRetention(snapshotRetainAfter);
      await this.webhookDispatch?.applyRetention(PRODUCT_RETENTION_DAYS);
      if (owner !== "agent_usage_owner" && owner !== "agent_full_owner") {
        return;
      }
      const runs = await this.requireProductionUsage().applyRetention(owner, PRODUCT_RETENTION_DAYS, now);
      await this.requireStorage().applyQueryOccurrenceRetention(
        new Date(now.getTime() - PRODUCT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
      );
      await this.requireBudgetWarnings().rebuild(runs);
      if (owner === "agent_full_owner") {
        const retainedQueryIds = new Set(runs.map((run) => run.queryId ?? run.correlationId));
        await this.verifiedAttribution?.applyRetention(PRODUCT_RETENTION_DAYS, retainedQueryIds);
      }
      await this.requireDiagnostics().record("product_retention_applied", "info", now.toISOString());
    });
    this.productRetentionQueue = operation.catch(() => undefined);
    return await operation;
  }

  private async closeResources(): Promise<void> {
    this.runtimeWarmupCancelled = true;
    this.fullOwnerBootstrapCancelled = true;
    this.verifiedAttributionStart = undefined;
    this.attributionSyncUnsubscribe?.();
    this.attributionSyncUnsubscribe = undefined;
    this.workspaceEvidenceSyncUnsubscribe?.();
    this.workspaceEvidenceSyncUnsubscribe = undefined;
    if (this.diagnostics && this.storage) {
      await this.diagnostics.record("runtime_stopping", "info", this.now().toISOString()).catch(() => undefined);
    }
    const server = this.server;
    this.server = undefined;
    for (const subscriber of this.eventSubscribers) {
      subscriber.end();
    }
    this.eventSubscribers.clear();
    if (this.workspaceLeaseSweep) {
      clearInterval(this.workspaceLeaseSweep);
      this.workspaceLeaseSweep = undefined;
    }
    if (this.productRetentionSweep) {
      clearInterval(this.productRetentionSweep);
      this.productRetentionSweep = undefined;
    }
    if (this.usageReconciliationSweep) {
      clearInterval(this.usageReconciliationSweep);
      this.usageReconciliationSweep = undefined;
    }
    if (this.usageProjectionTimer) {
      clearTimeout(this.usageProjectionTimer);
      this.usageProjectionTimer = undefined;
    }
    for (const timer of this.terminalUsageProjectionTimers.values()) {
      clearTimeout(timer);
    }
    this.terminalUsageProjectionTimers.clear();
    this.recentTerminalUsageSessions.clear();
    this.usageRebuildRequested = false;
    await this.productRetentionQueue.catch(() => undefined);
    await this.repositoryRefreshQueue.catch(() => undefined);
    if (server) {
      await closeServer(server);
    }
    if (this.otlp) {
      await this.otlp.stop().catch(() => undefined);
      this.otlp = undefined;
    }
    if (this.copilotSpanDb) {
      await this.copilotSpanDb.stop().catch(() => undefined);
      this.copilotSpanDb = undefined;
    }
    if (this.webhookDispatch) {
      await this.webhookDispatch.stop().catch(() => undefined);
      this.webhookDispatch = undefined;
    }
    if (this.verifiedAttribution) {
      await this.verifiedAttribution.stop().catch(() => undefined);
      this.verifiedAttribution = undefined;
      this.verifiedAttributionReady = false;
    }
    if (this.repositoryObservation) {
      await this.repositoryObservation.stop().catch(() => undefined);
      this.repositoryObservation = undefined;
    }
    if (this.storage) {
      await this.storage.close().catch(() => undefined);
      this.storage = undefined;
    }
    this.shadowUsage = undefined;
    this.productionUsage = undefined;
    this.budgetWarnings = undefined;
    this.diagnostics = undefined;
    this.repositoryScopes = undefined;
    this.lock?.release();
    this.lock = undefined;
    rmSync(this.paths.socketPath, { force: true });
  }
}

function purgeLocalAgentArtifacts(paths: AgentPaths): void {
  const logPath = paths.logPath ?? `${paths.stateDir}/agent.log.jsonl`;
  for (const candidate of [
    logPath,
    paths.ownershipMarkerPath,
    paths.repositoryLocatorKeyPath,
    paths.attributionHmacKeyPath,
    paths.preUpgradeBackupPath,
    paths.preUpgradeBackupPath ? `${paths.preUpgradeBackupPath}.json` : undefined,
    `${paths.stateDir}/source-configuration-restore.json`,
    `${paths.stateDir}/webhook-config.json`
  ]) {
    if (!candidate) {
      continue;
    }
    rmSync(candidate, { force: true });
  }
  for (const entry of readdirSync(paths.stateDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (
      entry.name.startsWith(`${logPath.split("/").at(-1) ?? "agent.log.jsonl"}.`)
      || entry.name.match(/^agent\.db\.pre-migration-\d+\.bak$/)
    ) {
      rmSync(`${paths.stateDir}/${entry.name}`, { force: true });
    }
  }
}

function mapLivePipelineEvent(
  event: DiagnosticEvent,
  at: string
): {
  code: "construct_lifecycle" | "live_pipeline_event";
  severity: "info" | "warning" | "error";
  at: string;
  message?: string;
  details?: Record<string, string | number | boolean | null>;
} | undefined {
  switch (event.kind) {
    case "constructLifecycle":
      return {
        code: "construct_lifecycle",
        severity: event.severity ?? "info",
        at,
        message: constructLifecycleMessage(event),
        details: constructLifecycleDetails(event)
      };
    case "repoDiscovery":
      return {
        code: "live_pipeline_event",
        severity: "info",
        at,
        message: "Repository discovery refreshed the live attribution surface.",
        details: {
          repoCount: event.repoCount,
          skippedCount: event.skippedCount
        }
      };
    case "attributionDecision":
      return {
        code: "live_pipeline_event",
        severity: event.status === "reportable" ? "info" : event.status === "skipped" ? "warning" : "info",
        at,
        message: `Attribution decision: ${event.reason}.`,
        details: {
          ...(event.queryId ? { queryId: event.queryId } : {}),
          ...(event.episodeId ? { episodeId: event.episodeId } : {}),
          ...(event.commitHash ? { commitHash: event.commitHash } : {}),
          status: event.status
        }
      };
    case "workspaceEvidence":
      return {
        code: "live_pipeline_event",
        severity: event.state === "settling_expired_no_changes" || event.state === "active_evidence_expired" ? "warning" : "info",
        at,
        message: `Workspace evidence: ${event.reason}.`,
        details: {
          ...(event.queryId ? { queryId: event.queryId } : {}),
          ...(event.repoKey ? { repoKey: event.repoKey } : {}),
          ...(event.commitHash ? { commitHash: event.commitHash } : {}),
          state: event.state,
          ...(event.snapshotCount != null ? { snapshotCount: event.snapshotCount } : {}),
          ...(event.observedChangeCount != null ? { observedChangeCount: event.observedChangeCount } : {}),
          ...(event.dirty != null ? { dirty: event.dirty } : {}),
          ...(event.headCommitAtStart ? { headCommitAtStart: event.headCommitAtStart } : {}),
          ...(event.observedSequence != null ? { observedSequence: event.observedSequence } : {})
        }
      };
    case "runCompleted":
      return {
        code: "live_pipeline_event",
        severity: "info",
        at,
        message: "A completed run entered the live attribution pipeline.",
        details: {
          runId: event.summary.runId,
          queryId: event.summary.queryId,
          tokenUsageSource: event.summary.tokenUsageSource,
          costCoverage: event.summary.costCoverage
        }
      };
    case "info":
      return {
        code: "live_pipeline_event",
        severity: "info",
        at,
        message: event.message
      };
    case "storage":
      return {
        code: "live_pipeline_event",
        severity: "warning",
        at,
        message: event.message
      };
    default:
      return undefined;
  }
}

export function restorePreUpgradeBackup(paths: AgentPaths = resolveAgentPaths()): void {
  const backupPath = preUpgradeBackupPath(paths);
  if (!existsSync(backupPath)) {
    throw new Error("storage_unavailable");
  }
  readRollbackInfo(paths);
  const lock = acquireExclusiveLock(paths.lockPath);
  try {
    rmSync(`${paths.databasePath}-wal`, { force: true });
    rmSync(`${paths.databasePath}-shm`, { force: true });
    copyFileSync(backupPath, paths.databasePath);
    chmodSync(paths.databasePath, 0o600);
  } finally {
    lock.release();
  }
}

function preUpgradeBackupPath(paths: AgentPaths): string {
  return paths.preUpgradeBackupPath ?? `${paths.stateDir}/pre-upgrade-agent.db`;
}

function preUpgradeMetadataPath(paths: AgentPaths): string {
  return `${preUpgradeBackupPath(paths)}.json`;
}

function readRollbackInfo(paths: AgentPaths): AgentRollbackInfoV1 {
  if (!existsSync(preUpgradeBackupPath(paths)) || !existsSync(preUpgradeMetadataPath(paths))) {
    throw new Error("storage_unavailable");
  }
  try {
    const value = JSON.parse(readFileSync(preUpgradeMetadataPath(paths), "utf8")) as AgentRollbackInfoV1;
    if (
      value.schemaVersion !== 1
      || value.backupAvailable !== true
      || typeof value.agentVersion !== "string"
      || !/^\d+\.\d+\.\d+$/.test(value.agentVersion)
      || !Number.isSafeInteger(value.databaseSchemaVersion)
      || !Number.isFinite(Date.parse(value.preparedAt))
    ) {
      throw new Error("invalid");
    }
    return value;
  } catch {
    throw new Error("storage_unavailable");
  }
}

function publicAttribution(summary: import("@tirion/engine/production").CommitAttributionSummary): AgentCommitAttributionV1 {
  return {
    schemaVersion: 1,
    commitHash: summary.commitHash,
    repoKey: summary.repoKey,
    queryIds: summary.queryIds,
    runIds: summary.runIds,
    attributedQueryCount: summary.linkedQueryCount,
    estimatedNanoUsd: summary.allocatedNanoUsd,
    providerCosts: summary.providerCosts.map((providerCost) => ({
      provider: providerCost.provider,
      queryCount: providerCost.queryCount,
      estimatedNanoUsd: providerCost.allocatedNanoUsd
    })),
    costCoverage: summary.coverage,
    decision: summary.decision === "reportable" ? "reportable" : "superseded",
    proofKinds: summary.proofKinds,
    status: summary.status,
    createdAt: summary.createdAt
  };
}

function commitHashQuery(url?: string): string | undefined {
  const raw = new URL(url ?? "/", "http://local").searchParams.get("commitHash");
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(normalized) ? normalized : undefined;
}

type AuthContext = {
  client?: ClientSummaryV1;
  capabilities: ClientCapability[];
};

function hasCapability(auth: AuthContext | undefined, capability: ClientCapability): boolean {
  return Boolean(auth?.capabilities.includes(capability));
}

function allowedCapabilitiesFor(_kind: ClientKind): readonly ClientCapability[] {
  return ADMIN_CAPABILITIES;
}

function hashCredential(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftHash = hashCredential(left);
  const rightHash = hashCredential(right);
  return leftHash === rightHash;
}

function bearerCredential(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > CONTROL_BODY_LIMIT_BYTES) {
      throw new Error("invalid_request");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_request");
  }
}

async function readOptionalJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > CONTROL_BODY_LIMIT_BYTES) {
      throw new Error("invalid_request");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_request");
  }
}

function parseProviderConfigurationRequest(value: unknown): ProviderConfigurationRequestV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["capturePrompts", "captureToolDetails", "captureToolContent", "captureResponseContent"].includes(key))) {
    throw new Error("invalid_request");
  }
  for (const key of ["capturePrompts", "captureToolDetails", "captureToolContent", "captureResponseContent"] as const) {
    if (record[key] != null && typeof record[key] !== "boolean") {
      throw new Error("invalid_request");
    }
  }
  return {
    schemaVersion: 1,
    ...(record.capturePrompts != null ? { capturePrompts: record.capturePrompts as boolean } : {}),
    ...(record.captureToolDetails != null ? { captureToolDetails: record.captureToolDetails as boolean } : {}),
    ...(record.captureToolContent != null ? { captureToolContent: record.captureToolContent as boolean } : {}),
    ...(record.captureResponseContent != null ? { captureResponseContent: record.captureResponseContent as boolean } : {})
  };
}

function parseWebhookUrlConfiguration(value: unknown): WebhookUrlConfigurationV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "url"].includes(key))) {
    throw new Error("invalid_request");
  }
  if (typeof record.url !== "string" || record.url.trim() === "") {
    throw new Error("invalid_request");
  }
  return {
    schemaVersion: 1,
    url: record.url.trim()
  };
}

function parseWebhookTokenConfiguration(value: unknown): WebhookBearerTokenConfigurationV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "token"].includes(key))) {
    throw new Error("invalid_request");
  }
  if (typeof record.token !== "string" || record.token.trim() === "") {
    throw new Error("invalid_request");
  }
  return {
    schemaVersion: 1,
    token: record.token.trim()
  };
}

function parseWebhookSecretConfiguration(value: unknown): WebhookSecretConfigurationV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "secret"].includes(key))) {
    throw new Error("invalid_request");
  }
  if (typeof record.secret !== "string" || record.secret.trim() === "") {
    throw new Error("invalid_request");
  }
  return {
    schemaVersion: 1,
    secret: record.secret.trim()
  };
}

function parseWebhookSenderConfiguration(value: unknown): WebhookSenderConfigurationV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schemaVersion", "sender"].includes(key))) {
    throw new Error("invalid_request");
  }
  if (record.schemaVersion !== 1 || typeof record.sender !== "object" || record.sender === null || Array.isArray(record.sender)) {
    throw new Error("invalid_request");
  }
  const sender = record.sender as Record<string, unknown>;
  if (Object.keys(sender).some((key) => !["name", "team", "imageUrl"].includes(key))) {
    throw new Error("invalid_request");
  }
  const normalized: WebhookSenderConfigurationV1["sender"] = {};
  if (sender.name != null) {
    if (!isWebhookSenderText(sender.name)) {
      throw new Error("invalid_request");
    }
    normalized.name = sender.name.trim();
  }
  if (sender.team != null) {
    if (!isWebhookSenderText(sender.team)) {
      throw new Error("invalid_request");
    }
    normalized.team = sender.team.trim();
  }
  if (sender.imageUrl != null) {
    if (!isWebhookImageUrl(sender.imageUrl)) {
      throw new Error("invalid_request");
    }
    normalized.imageUrl = sender.imageUrl.trim();
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error("invalid_request");
  }
  return {
    schemaVersion: 1,
    sender: normalized
  };
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

function parseRepositoryActivationRequest(value: unknown): RepositoryActivationRequestV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => ![
    "schemaVersion",
    "path",
    "provider",
    "capturePrompts",
    "captureToolDetails",
    "captureToolContent",
    "captureResponseContent"
  ].includes(key))) {
    throw new Error("invalid_request");
  }
  if (typeof record.path !== "string" || record.path.trim().length === 0 || record.path.length > 10_000) {
    throw new Error("invalid_request");
  }
  if (record.provider != null && !["auto", "claude-code", "codex", "cursor", "github-copilot"].includes(String(record.provider))) {
    throw new Error("invalid_request");
  }
  for (const key of ["capturePrompts", "captureToolDetails", "captureToolContent", "captureResponseContent"] as const) {
    if (record[key] != null && typeof record[key] !== "boolean") {
      throw new Error("invalid_request");
    }
  }
  return {
    schemaVersion: 1,
    path: record.path.trim(),
    ...(record.provider != null ? { provider: record.provider as RepositoryActivationRequestV1["provider"] } : {}),
    ...(record.capturePrompts != null ? { capturePrompts: record.capturePrompts as boolean } : {}),
    ...(record.captureToolDetails != null ? { captureToolDetails: record.captureToolDetails as boolean } : {}),
    ...(record.captureToolContent != null ? { captureToolContent: record.captureToolContent as boolean } : {}),
    ...(record.captureResponseContent != null ? { captureResponseContent: record.captureResponseContent as boolean } : {})
  };
}

function parseClearAgentDataRequest(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "schemaVersion")
    || record.schemaVersion !== 1
  ) {
    throw new Error("invalid_request");
  }
}

function readOrCreateBootstrapToken(path: string): string {
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return token;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, code: SafeErrorCode): void {
  send(response, status, errorResponse(code));
}

function safeErrorCode(error: unknown): SafeErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  const safe: SafeErrorCode[] = [
    "agent_unavailable",
    "agent_stopping",
    "authentication_required",
    "authorization_denied",
    "client_revoked",
    "invalid_request",
    "protocol_major_mismatch",
    "unsupported_capability",
    "ownership_conflict",
    "storage_unavailable",
    "internal_error"
  ];
  return safe.includes(message as SafeErrorCode) ? message as SafeErrorCode : "internal_error";
}

function isCompletedProductionRun(run: ProductionRunV1): boolean {
  return Boolean(run.endedAt && run.endedAt >= run.startedAt);
}

function productionRunProjectionSignature(run: ProductionRunV1): string {
  return createHash("sha256").update(JSON.stringify(run)).digest("hex");
}

function comparePendingWebhookLifecycleProjection(
  left: PendingWebhookLifecycleProjection,
  right: PendingWebhookLifecycleProjection
): number {
  if (left.priority !== right.priority) {
    return left.priority ? -1 : 1;
  }
  if (left.priority && left.sequence !== right.sequence) {
    return right.sequence - left.sequence;
  }
  return (right.run.endedAt ?? right.run.startedAt)
    .localeCompare(left.run.endedAt ?? left.run.startedAt);
}

function hasLiveMeasurementEvidence(observation: SafeObservationV1): boolean {
  return (observation.queryOccurrences?.length ?? 0) > 0
    || (observation.activityAtoms?.length ?? 0) > 0
    || (observation.executionNodes?.length ?? 0) > 0
    || observation.usageAtoms.length > 0;
}

function hasPriorityLiveLifecycleEvidence(observation: SafeObservationV1): boolean {
  return Boolean(observation.queryOccurrences?.some((occurrence) =>
    occurrence.lifecycleVisibility !== "internal"));
}

function isExplicitTerminalOccurrence(
  occurrence: NonNullable<SafeObservationV1["queryOccurrences"]>[number]
): occurrence is NonNullable<SafeObservationV1["queryOccurrences"]>[number] & { completedAt: string } {
  return typeof occurrence.completedAt === "string"
    && occurrence.completedAt.trim() !== ""
    && occurrence.lifecycleVisibility !== "internal"
    && occurrence.completionEvidence != null
    && occurrence.completionEvidence !== "inactivity";
}

function hasRepositoryObservationDemand(observation: SafeObservationV1): boolean {
  const hasCustomerEvidence = Boolean(observation.queryOccurrences?.some((occurrence) =>
    occurrence.lifecycleVisibility !== "internal"))
    || (observation.activityAtoms?.length ?? 0) > 0
    || (observation.executionNodes?.length ?? 0) > 0
    || observation.usageAtoms.length > 0;
  return hasCustomerEvidence && (Boolean(observation.repositoryKey)
    || Boolean(observation.queryOccurrences?.some((occurrence) =>
      occurrence.lifecycleVisibility !== "internal" && occurrence.repositoryKey)));
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? "." : path.slice(0, index);
}

function hasNoGroupOrOtherPermissions(path: string): boolean {
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function boundedLimit(url?: string): number | undefined {
  if (!url) {
    return undefined;
  }
  const raw = new URL(url, "http://local").searchParams.get("limit");
  if (raw == null) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : undefined;
}

function providerActivationScore(status: ProviderSourceStatusV1): number {
  switch (status.ownershipState) {
    case "adoptable_local":
      return 6;
    case "managed_current":
      return 5;
    case "managed_stale_authority":
      return 4;
    case "managed_drifted":
      return 3;
    case "unmanaged":
      return status.logsEnabled && status.tracesEnabled ? 2 : 1;
    default:
      return 0;
  }
}

function maxIsoString(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => right.localeCompare(left))[0];
}

function eventSequenceAfter(url?: string): number {
  if (!url) {
    return 0;
  }
  const value = Number(new URL(url, "http://local").searchParams.get("after") ?? "0");
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function serverEvent(event: AgentEventV1): string {
  return `id: ${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function safeCollect<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch {
    return [];
  }
}

function countBy<T>(values: T[], keyOf: (value: T) => string | undefined): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = keyOf(value);
    if (!key) {
      return counts;
    }
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function syncConstructState(
  construct: string,
  state: string,
  updatedAt: string,
  reason: string | undefined,
  details: Record<string, string | number | boolean | null>
): AgentConstructStateV1 {
  return {
    schemaVersion: 1,
    construct,
    state,
    health: state === "reconciled" ? "healthy" : state === "pending" ? "degraded" : "blocked",
    updatedAt,
    ...(reason ? { reason } : {}),
    details
  };
}

function parseExpectedTotals(value: unknown): {
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedNanoUsd: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  const keys = ["runCount", "inputTokens", "outputTokens", "totalTokens", "estimatedNanoUsd"];
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new Error("invalid_request");
  }
  const parsed = Object.fromEntries(keys.map((key) => [key, Number(record[key])])) as ReturnType<typeof parseExpectedTotals>;
  if (Object.values(parsed).some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error("invalid_request");
  }
  return parsed;
}

function parseOwnershipTarget(value: unknown): OwnershipState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !["extension_legacy", "agent_shadow", "agent_usage_owner", "agent_full_owner"].includes(String(record.target))) {
    throw new Error("invalid_request");
  }
  return record.target as OwnershipState;
}

function parseLegacyEngineLeaseSession(value: unknown): string {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).some((key) => !["schemaVersion", "sessionId"].includes(key))
    || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || typeof (value as { sessionId?: unknown }).sessionId !== "string"
    || !/^legacy_[A-Za-z0-9_-]{16,200}$/.test((value as { sessionId: string }).sessionId)
  ) {
    throw new Error("invalid_request");
  }
  return (value as { sessionId: string }).sessionId;
}

function isApprovedExternalSourceCapability(capability: SourceCapabilityV1, environmentId: string): boolean {
  if (capability.environmentId !== environmentId || capability.provider !== capability.runtime) {
    return false;
  }
  if (capability.provider === "github-copilot") {
    return (
      capability.sourceId === "otlp_github_copilot_logs"
      && capability.sourceKind === "otlp-http-json"
      && capability.profileVersion === "copilot-otlp-logs-v1"
    ) || (
      capability.sourceId === "otlp_github_copilot_traces"
      && capability.sourceKind === "otlp-http-json"
      && capability.profileVersion === "copilot-otlp-traces-v1"
    );
  }
  if (capability.provider === "cursor") {
    return (
      capability.sourceId === "otlp_cursor_logs"
      && capability.sourceKind === "otlp-http-json"
      && capability.profileVersion === "cursor-otlp-logs-v1"
    ) || (
      capability.sourceId === "otlp_cursor_traces"
      && capability.sourceKind === "otlp-http-json"
      && capability.profileVersion === "cursor-otlp-traces-v1"
    );
  }
  return false;
}

function parseRepositoryEnrollment(value: unknown): { path: string; kind: "repository" | "root" } {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).some((key) => !["schemaVersion", "path", "kind"].includes(key))
    || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || typeof (value as { path?: unknown }).path !== "string"
    || !["repository", "root"].includes(String((value as { kind?: unknown }).kind))
  ) {
    throw new Error("invalid_request");
  }
  return value as { path: string; kind: "repository" | "root" };
}

function parseWorkspaceLeaseRequest(value: unknown): string {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).some((key) => !["schemaVersion", "path"].includes(key))
    || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || typeof (value as { path?: unknown }).path !== "string"
  ) {
    throw new Error("invalid_request");
  }
  return (value as { path: string }).path;
}
