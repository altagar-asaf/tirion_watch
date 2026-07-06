import { randomUUID } from "node:crypto";
import type {
  AgentConstructStateV1,
  AgentDiagnosticEventCode,
  AgentDiagnosticDetailsV1,
  AgentDiagnosticEventV1,
  AgentDiagnosticsV1,
  AgentHealth,
  AgentWebhookStatusV1,
  OwnershipState,
  ProductionRunV1
} from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { DefaultPrivacyGuard, StateBackedCommitAttributionLedger, type QueryCostAttribution } from "@tirion/engine/production";
import { SafeStructuredLog } from "./safeStructuredLog";

const MAX_DIAGNOSTIC_EVENTS = 1000;

export class AgentDiagnosticsService {
  private readonly log?: SafeStructuredLog;

  constructor(private readonly storage: AgentStorageClient, logPath?: string) {
    this.log = logPath ? new SafeStructuredLog(logPath) : undefined;
  }

  async record(
    code: AgentDiagnosticEventCode,
    severity: AgentDiagnosticEventV1["severity"],
    at: string,
    options?: {
      message?: string;
      details?: AgentDiagnosticDetailsV1;
    }
  ): Promise<void> {
    const event: AgentDiagnosticEventV1 = {
      schemaVersion: 1,
      eventId: `diagnostic_${randomUUID()}`,
      code,
      severity,
      at,
      ...(options?.message ? { message: options.message } : {}),
      ...(options?.details && Object.keys(options.details).length > 0 ? { details: options.details } : {})
    };
    await this.storage.upsertAgentDocument("diagnostic_event", {
      key: event.eventId,
      sortAt: event.at,
      value: event
    });
    this.log?.append(event);
    await this.storage.trimAgentDocuments("diagnostic_event", MAX_DIAGNOSTIC_EVENTS);
  }

  async recordConstructState(state: AgentConstructStateV1): Promise<void> {
    await this.storage.upsertAgentDocument("construct_state", {
      key: state.construct,
      sortAt: state.updatedAt,
      value: state
    });
  }

  async snapshot(input: {
    health: AgentHealth;
    ownershipState: OwnershipState;
    webhook?: AgentWebhookStatusV1;
  }): Promise<AgentDiagnosticsV1> {
    const [sources, safeObservationCount, runs, scopes, attributions, warnings, journalState, constructStates, recentEvents] = await Promise.all([
      this.storage.listSources(),
      this.storage.safeObservationCount(),
      this.storage.listProductionRuns(),
      this.storage.listRepositoryScopes(),
      this.storage.listAgentDocuments<QueryCostAttribution>("query_attribution"),
      this.storage.listAgentDocuments("budget_warning"),
      this.storage.listAgentDocuments<{ pruned: number; overflow: number }>("journal_state"),
      this.constructStates(),
      this.events()
    ]);
    const journal = journalState.find((item) => item.key === "retention")?.value;
    const verifiedAttributionCount = await countVerifiedCommitAttributions(attributions.map((item) => item.value));
    return {
      schemaVersion: 1,
      health: input.health,
      ownershipState: input.ownershipState,
      executionEnvironment: "local",
      sourceCount: sources.length,
      safeObservationCount,
      journalPrunedCount: journal?.pruned ?? 0,
      journalOverflowCount: journal?.overflow ?? 0,
      productionRunCount: runs.length,
      pricedRunCount: runs.filter((run) => (run as ProductionRunV1).estimatedNanoUsd != null).length,
      unpricedRunCount: runs.filter((run) => (run as ProductionRunV1).estimatedNanoUsd == null).length,
      repositoryScopeCount: scopes.length,
      activeRepositoryScopeCount: scopes.filter((scope) => scope.scope.state === "active").length,
      verifiedAttributionCount,
      budgetWarningCount: warnings.length,
      webhook: input.webhook,
      constructStates,
      recentEvents
    };
  }

  async events(limit = MAX_DIAGNOSTIC_EVENTS): Promise<AgentDiagnosticEventV1[]> {
    const logged = this.log?.read(limit) ?? [];
    if (logged.length > 0) {
      return logged;
    }
    return (await this.storage.listAgentDocuments<AgentDiagnosticEventV1>("diagnostic_event"))
      .slice(0, Math.max(1, Math.min(limit, MAX_DIAGNOSTIC_EVENTS)))
      .map((item) => item.value);
  }

  async constructStates(): Promise<AgentConstructStateV1[]> {
    return (await this.storage.listAgentDocuments<AgentConstructStateV1>("construct_state"))
      .map((item) => item.value)
      .sort((a, b) => a.construct.localeCompare(b.construct));
  }

  clearDurableLog(): void {
    this.log?.clear();
  }
}

async function countVerifiedCommitAttributions(attributions: QueryCostAttribution[]): Promise<number> {
  const ledger = new StateBackedCommitAttributionLedger(
    async () => attributions,
    async () => undefined,
    new DefaultPrivacyGuard()
  );
  return (await ledger.listCommitAttributions({})).length;
}
