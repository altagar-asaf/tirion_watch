import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExecutionNodeAtomV1,
  ProductionRunV1,
  SafeObservationV1
} from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { ExternalWebhookDispatchService } from "./externalWebhookDispatch";
import { AgentVerifiedAttributionService } from "./productionRunAttribution";
import { AgentRepositoryObservationService } from "./repositoryObservationService";
import { RepositoryScopeManagement } from "./repositoryScopeManagement";

const roots: string[] = [];
const storages: AgentStorageClient[] = [];
const repositories: AgentRepositoryObservationService[] = [];
const attributions: AgentVerifiedAttributionService[] = [];
const dispatchers: ExternalWebhookDispatchService[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((service) => service.stop()));
  await Promise.all(attributions.splice(0).map((service) => service.stop()));
  await Promise.all(repositories.splice(0).map((service) => service.stop()));
  await Promise.all(storages.splice(0).map((storage) => storage.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Claude native-rejection connected external egress", () => {
  it("retracts a delivered causal file and supersedes its delivered commit through real attribution", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-claude-native-egress-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    let now = Date.now();
    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    storages.push(storage);
    const metadata = await storage.initialize({
      now: new Date(now).toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    await storage.beginProductionUsageEpoch(new Date(now).toISOString());
    const scopes = new RepositoryScopeManagement(storage, join(root, "repository-locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date(now - 1_000).toISOString());
    const repositoryObservation = new AgentRepositoryObservationService(
      storage,
      scopes,
      join(root, "attribution-hmac.key"),
      60_000
    );
    repositories.push(repositoryObservation);
    await repositoryObservation.start();
    await repositoryObservation.refresh();

    const baseline = (await repositoryObservation.listSnapshots()).at(-1)!;
    const resolved = await repositoryObservation.resolveWorkspaceEvidence(repository, ["src/causal.ts"]);
    expect(resolved).toBeDefined();
    const repoKey = resolved!.repositoryKey;
    const artifactKey = resolved!.artifactKeys[0]!;
    now = Math.max(now, Date.parse(baseline.observedAt) + 1);
    const startedAt = new Date(now).toISOString();
    mkdirSync(join(repository, "src"));
    writeFileSync(join(repository, "src", "causal.ts"), "export const causal = true;\n");
    now = Math.max(now + 1, Date.now());
    const completedAt = new Date(now).toISOString();
    const queryId = "qry_connected_native_rejection";
    const invocationId = "invocation_connected_native_rejection";
    const successfulWrite: ExecutionNodeAtomV1 = {
      schemaVersion: 1,
      nodeId: "node_connected_successful_write",
      queryId,
      sessionId: "ses_connected_native_rejection",
      repositoryKey: repoKey,
      requestId: "req_connected_successful_write",
      invocationId,
      provider: "claude-code",
      runtime: "claude-code",
      signal: "hooks",
      nodeKind: "tool",
      name: "Write",
      toolName: "Write",
      outcome: "success",
      startedAt,
      endedAt: completedAt,
      artifactKeys: [artifactKey],
      artifactEvidence: "provider_write_hook"
    };
    await storage.upsertAgentDocument("execution_node_atom", {
      key: successfulWrite.nodeId,
      sortAt: completedAt,
      value: successfulWrite
    });
    await repositoryObservation.refresh();

    const attribution = new AgentVerifiedAttributionService(
      storage,
      repositoryObservation,
      () => undefined,
      () => now
    );
    attributions.push(attribution);
    await attribution.start();

    const received: ReceivedWebhookMetadata[] = [];
    const receiver = createServer((request, response) => {
      collectWebhookMetadata(request).then((event) => {
        received.push(event);
        response.statusCode = 200;
        response.end("ok");
      }).catch(() => {
        response.statusCode = 400;
        response.end("invalid");
      });
    });
    servers.push(receiver);
    await listen(receiver);
    const address = receiver.address() as AddressInfo;
    const dispatcher = new ExternalWebhookDispatchService(
      storage,
      { configurationPath: join(root, "webhook-config.json") },
      attribution,
      repositoryObservation,
      () => now,
      () => undefined,
      metadata.installationId,
      { runEndedGraceMs: 1 }
    );
    dispatchers.push(dispatcher);
    await dispatcher.start();
    await dispatcher.configureUrl({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/hooks` });

    // The V1 terminal must originate from retained live sources. A durable
    // completed-run projection alone cannot later prune a direct successful
    // Write when its exact native decision arrives.
    const promptObservation = claudePromptObservation({
      queryId,
      sessionId: successfulWrite.sessionId,
      repositoryKey: repoKey,
      observedAt: startedAt
    });
    await dispatcher.observeSafeObservation(promptObservation);
    await waitUntil(() => received.some((event) => event.eventType === "run.start" && event.runId));
    const start = received.find((event) => event.eventType === "run.start" && event.runId)!;
    const run: ProductionRunV1 = {
      schemaVersion: 1,
      production: true,
      runId: start.runId!,
      correlationId: queryId,
      queryId,
      sessionId: successfulWrite.sessionId,
      repositoryKey: repoKey,
      provider: "claude-code",
      runtime: "claude-code",
      model: "claude-test",
      authority: "turn",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 15,
      estimatedNanoUsd: 50_000,
      pricingVersion: "test",
      billingContext: "anthropic-direct",
      costCoverage: "complete",
      evidenceGrade: "estimated_usage_cost_unattributed",
      startedAt,
      endedAt: completedAt,
      warnings: []
    };
    await storage.replaceProductionRuns([run]);
    await attribution.observeProductionRuns([run]);
    await waitUntil(async () => (await attribution.listWorkspaceEvidence()).some((evidence) =>
      evidence.queryId === queryId
      && evidence.causalWriteArtifacts?.some((proof) =>
        proof.artifactKey === artifactKey && proof.executionNodeId === successfulWrite.nodeId
      )
    ));

    await dispatcher.observeSafeObservation(claudeSuccessfulWriteObservation(successfulWrite));
    now = Date.parse(completedAt);
    await dispatcher.observeSafeObservation(claudeCompletionObservation(promptObservation, completedAt));
    now += 2;
    await dispatcher.retryNow();
    await waitUntil(() => received.some((event) => event.eventType === "run.ended" && event.version === 1));

    const terminalV1 = received.find((event) => event.eventType === "run.ended" && event.version === 1)!;
    expect(terminalV1.filesChanged).toEqual(["src/causal.ts"]);

    execFileSync("git", ["-C", repository, "add", "src/causal.ts"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "causal write"]);
    await repositoryObservation.refresh();
    await attribution.observeProductionRuns([run]);
    await waitUntil(async () => (await attribution.listCommitAttributions()).some((summary) => summary.decision === "reportable"));
    await dispatcher.reconcileCommitEvents();
    now += 10_000;
    await dispatcher.retryNow();
    await waitUntil(() => received.some((event) => event.eventType === "commit.attributed" && event.version === 1));

    const commitV1 = received.find((event) => event.eventType === "commit.attributed" && event.version === 1)!;
    expect(commitV1.state).toBe("active");
    expect(commitV1.runIds).toEqual([run.runId]);
    // Commit reconciliation may improve the completed lifecycle between the
    // live V1 and the commit delivery. The native correction must advance
    // whichever active terminal the receiver has actually observed.
    const terminalBeforeDecision = received
      .filter((event) => event.eventType === "run.ended" && event.runId === run.runId)
      .at(-1)!;
    expect(terminalBeforeDecision.filesChanged).toEqual(["src/causal.ts"]);

    // A source that began after the terminal is not a correction authority,
    // even when it exactly matches the completed Write and arrives while all
    // of the live/durable state is still retained.
    const postBoundaryAt = new Date(Date.parse(completedAt) + 1).toISOString();
    const postBoundaryDecision: ExecutionNodeAtomV1 = {
      schemaVersion: 1,
      nodeId: "node_connected_post_boundary_native_rejection",
      queryId,
      sessionId: successfulWrite.sessionId,
      repositoryKey: repoKey,
      requestId: "req_connected_post_boundary_native_decision",
      invocationId,
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      nodeKind: "tool",
      name: "Write",
      toolName: "Write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      startedAt: postBoundaryAt
    };
    await storage.upsertAgentDocument("execution_node_atom", {
      key: postBoundaryDecision.nodeId,
      sortAt: postBoundaryDecision.startedAt!,
      value: postBoundaryDecision
    });
    const postBoundaryObservation = claudeNativeDecisionObservation({
      observationId: "obs_connected_post_boundary_native_rejection",
      activityId: "act_connected_post_boundary_native_rejection",
      decision: postBoundaryDecision,
      observedAt: new Date(Date.parse(postBoundaryAt) + 1).toISOString()
    });
    await attribution.observeSafeObservation(postBoundaryObservation);
    await waitUntil(async () => (await attribution.listWorkspaceEvidence()).some((evidence) =>
      evidence.queryId === queryId
      && evidence.causalWriteArtifacts?.some((proof) =>
        proof.artifactKey === artifactKey && proof.executionNodeId === successfulWrite.nodeId
      )
      && !evidence.nativeRejectedCausalWriteArtifacts?.some((proof) =>
        proof.artifactKey === artifactKey && proof.executionNodeId === successfulWrite.nodeId
      )
    ));
    const terminalCountBeforePostBoundaryObservation = received
      .filter((event) => event.eventType === "run.ended" && event.runId === run.runId)
      .length;
    await dispatcher.observeSafeObservation(postBoundaryObservation);
    await dispatcher.retryNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(received.filter((event) =>
      event.eventType === "run.ended" && event.runId === run.runId
    )).toHaveLength(terminalCountBeforePostBoundaryObservation);

    // This native decision arrives after V1 and commit V1 too, but its source
    // time is at the terminal boundary. Its later receipt may therefore make
    // the bounded correction, unlike the post-boundary source above.
    const decisionAt = completedAt;
    const decision: ExecutionNodeAtomV1 = {
      schemaVersion: 1,
      nodeId: "node_connected_native_rejection",
      queryId,
      sessionId: successfulWrite.sessionId,
      repositoryKey: repoKey,
      requestId: "req_connected_native_decision",
      invocationId,
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      nodeKind: "tool",
      name: "Write",
      toolName: "Write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      startedAt: decisionAt
    };
    await storage.upsertAgentDocument("execution_node_atom", {
      key: decision.nodeId,
      sortAt: decision.startedAt!,
      value: decision
    });
    const decisionObservation = claudeNativeDecisionObservation({
      observationId: "obs_connected_native_rejection",
      activityId: "act_connected_native_rejection",
      decision,
      observedAt: new Date(Date.parse(postBoundaryAt) + 2).toISOString()
    });
    await attribution.observeSafeObservation(decisionObservation);
    await waitUntil(async () => (await attribution.listWorkspaceEvidence()).some((evidence) =>
      evidence.queryId === queryId
      && evidence.causalWriteArtifacts?.length === 0
      && evidence.nativeRejectedCausalWriteArtifacts?.some((proof) =>
        proof.artifactKey === artifactKey && proof.executionNodeId === successfulWrite.nodeId
      )
    ));

    await dispatcher.observeSafeObservation(decisionObservation);
    await dispatcher.retryNow();
    await waitUntil(() => received.some((event) =>
      event.eventType === "run.ended"
      && event.runId === run.runId
      && event.version === terminalBeforeDecision.version! + 1
      && event.filesChanged?.length === 0
    ));
    const terminalCorrection = received.find((event) =>
      event.eventType === "run.ended"
      && event.runId === run.runId
      && event.version === terminalBeforeDecision.version! + 1
      && event.filesChanged?.length === 0
    )!;
    expect(terminalCorrection.filesChanged).toEqual([]);
    expect(terminalCorrection.eventId).not.toBe(terminalBeforeDecision.eventId);

    await dispatcher.reconcileCommitEvents();
    now += 10_000;
    await dispatcher.retryNow();
    await waitUntil(() => received.some((event) =>
      event.eventType === "commit.attributed"
      && event.eventId === commitV1.eventId
      && event.version > commitV1.version
    ));
    const commitV2 = received.find((event) =>
      event.eventType === "commit.attributed"
      && event.eventId === commitV1.eventId
      && event.version > commitV1.version
    )!;
    expect(commitV2).toMatchObject({
      state: "superseded",
      runIds: [],
      traceIds: [],
      estimatedNanoUsd: 0,
      costCoverage: "unavailable"
    });
  });
});

type ReceivedWebhookMetadata = {
  eventType?: string;
  eventId?: string;
  runId?: string;
  version?: number;
  state?: string;
  filesChanged?: string[];
  runIds?: string[];
  traceIds?: string[];
  estimatedNanoUsd?: number;
  costCoverage?: string;
};

function collectWebhookMetadata(request: IncomingMessage): Promise<ReceivedWebhookMetadata> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        resolve({
          eventType: typeof body.eventType === "string" ? body.eventType : undefined,
          eventId: typeof body.eventId === "string" ? body.eventId : undefined,
          runId: typeof body.runId === "string" ? body.runId : undefined,
          version: typeof body.version === "number" ? body.version : undefined,
          state: typeof body.state === "string" ? body.state : undefined,
          filesChanged: stringArray(body.filesChanged),
          runIds: stringArray(body.runIds),
          traceIds: stringArray(body.traceIds),
          estimatedNanoUsd: typeof body.estimatedNanoUsd === "number" ? body.estimatedNanoUsd : undefined,
          costCoverage: typeof body.costCoverage === "string" ? body.costCoverage : undefined
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function claudePromptObservation(input: {
  queryId: string;
  sessionId: string;
  repositoryKey: string;
  observedAt: string;
}): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_connected_prompt_${input.queryId}`,
    sourceId: "hook_claude_code_lifecycle",
    provider: "claude-code",
    runtime: "claude-code",
    signal: "logs",
    profileVersion: "claude-code-hooks-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    repositoryKey: input.repositoryKey,
    queryOccurrences: [{
      schemaVersion: 1,
      queryId: input.queryId,
      sessionId: input.sessionId,
      repositoryKey: input.repositoryKey,
      provider: "claude-code",
      runtime: "claude-code",
      startedAt: input.observedAt,
      promptState: "disabled",
      evidence: "submission_hook"
    }],
    executionNodes: [{
      schemaVersion: 1,
      nodeId: `node_connected_prompt_${input.queryId}`,
      queryId: input.queryId,
      sessionId: input.sessionId,
      repositoryKey: input.repositoryKey,
      requestId: `req_connected_prompt_${input.queryId}`,
      provider: "claude-code",
      runtime: "claude-code",
      signal: "hooks",
      nodeKind: "prompt",
      name: "Prompt",
      outcome: "success",
      startedAt: input.observedAt
    }],
    usageAtoms: []
  };
}

function claudeSuccessfulWriteObservation(write: ExecutionNodeAtomV1): SafeObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `obs_connected_write_${write.nodeId}`,
    sourceId: "hook_claude_code_tools",
    provider: "claude-code",
    runtime: "claude-code",
    signal: "logs",
    profileVersion: "claude-code-hooks-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt: write.endedAt ?? write.startedAt!,
    repositoryKey: write.repositoryKey,
    activityAtoms: [{
      schemaVersion: 1,
      activityId: `act_connected_write_${write.nodeId}`,
      queryId: write.queryId,
      sessionId: write.sessionId,
      repositoryKey: write.repositoryKey,
      requestId: write.requestId,
      invocationId: write.invocationId,
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "success",
      evidenceBasis: "tool_hook",
      evidenceSourceId: "hook_claude_code_tools",
      startedAt: write.startedAt,
      endedAt: write.endedAt
    }],
    executionNodes: [write],
    usageAtoms: []
  };
}

function claudeNativeDecisionObservation(input: {
  observationId: string;
  activityId: string;
  decision: ExecutionNodeAtomV1;
  observedAt: string;
}): SafeObservationV1 {
  const { decision } = input;
  return {
    schemaVersion: 1,
    observationId: input.observationId,
    sourceId: "otlp_claude_code_logs",
    provider: "claude-code",
    runtime: "claude-code",
    signal: "logs",
    profileVersion: "claude-code-otlp-logs-v1",
    resourceCount: 1,
    recordCount: 1,
    observedAt: input.observedAt,
    repositoryKey: decision.repositoryKey,
    activityAtoms: [{
      schemaVersion: 1,
      activityId: input.activityId,
      queryId: decision.queryId,
      sessionId: decision.sessionId,
      repositoryKey: decision.repositoryKey,
      requestId: `${decision.requestId}_activity`,
      invocationId: decision.invocationId,
      provider: "claude-code",
      runtime: "claude-code",
      kind: "tool",
      name: "Write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      evidenceBasis: "otel_event",
      evidenceSourceId: "otlp_claude_code_logs",
      startedAt: decision.startedAt
    }],
    executionNodes: [decision],
    usageAtoms: []
  };
}

function claudeCompletionObservation(prompt: SafeObservationV1, completedAt: string): SafeObservationV1 {
  return {
    ...prompt,
    observationId: `${prompt.observationId}_completed`,
    observedAt: completedAt,
    queryOccurrences: (prompt.queryOccurrences ?? []).map((occurrence) => ({
      ...occurrence,
      completedAt,
      completionEvidence: "stop_hook"
    })),
    executionNodes: [],
    activityAtoms: [],
    usageAtoms: []
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
