import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionNodeAtomV1, ProductionRunV1, SafeObservationV1 } from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import {
  AgentProductionRunAttribution,
  AgentVerifiedAttributionService,
  productionRunForAttribution
} from "./productionRunAttribution";
import { AgentRepositoryObservationService } from "./repositoryObservationService";
import { RepositoryScopeManagement } from "./repositoryScopeManagement";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("agent production run attribution foundation", () => {
  it("hands provider query and session identities to provider-neutral attribution", () => {
    const adapted = productionRunForAttribution({
      ...run("2026-06-08T00:00:00.000Z", "2026-06-08T00:00:01.000Z"),
      correlationId: "qry_legacy_alias",
      queryId: "qry_prompt",
      sessionId: "ses_thread",
      repositoryKey: "repo_bound",
      promptState: "captured",
      promptText: "private initiating prompt"
    });
    expect(adapted).toMatchObject({
      traceId: "qry_legacy_alias",
      queryId: "qry_prompt",
      chatSessionId: "ses_thread",
      repoKey: "repo_bound"
    });
    expect(JSON.stringify(adapted)).not.toContain("private initiating prompt");
  });

  it("reconstructs durable workspace evidence from snapshots surrounding a headless run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-run-evidence-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date(Date.now() - 5_000).toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    const baselineAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(join(repository, "agent-change.txt"), "change\n");
    await repositories.refresh();
    const endedAt = new Date().toISOString();

    const attribution = new AgentProductionRunAttribution(storage, repositories);
    await attribution.start();
    let evidenceBoundCount = 0;
    attribution.onWorkspaceEvidenceBound(async () => {
      evidenceBoundCount += 1;
    });
    await attribution.observeProductionRuns([{ ...run(baselineAt, endedAt), endedAt: undefined }]);
    expect(await attribution.listEvidence()).toEqual([]);
    await attribution.observeProductionRuns([run(baselineAt, endedAt)]);
    expect(evidenceBoundCount).toBe(1);
    expect(await attribution.listEvidence()).toEqual([
      expect.objectContaining({
        queryId: "correlation_12345678",
        baselineTrusted: true,
        observedChangeCount: 1,
        status: "completed"
      })
    ]);
    expect((await attribution.listEvidence())[0]?.causalArtifactKeys ?? []).toEqual([]);
    expect(await attribution.listEpisodes()).toEqual([
      expect.objectContaining({
        queryIds: ["correlation_12345678"],
        repoKeys: [expect.stringMatching(/^[a-f0-9]{64}$/)]
      })
    ]);
    await attribution.stop();
    await repositories.stop();
    await storage.close();

    const reopened = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    await reopened.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    expect(await reopened.listAgentDocuments("workspace_evidence")).toHaveLength(1);
    expect(await reopened.listAgentDocuments("work_episode")).toHaveLength(1);
    await reopened.close();
  });

  it("persists exact provider writes as opaque causal artifact evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-causal-write-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    await repositories.refresh();
    const baseline = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baseline.observedAt) + 1).toISOString();
    const resolved = await repositories.resolveWorkspaceEvidence(repository, ["src/causal-write.ts"]);
    const rejected = await repositories.resolveWorkspaceEvidence(repository, ["src/rejected-write.ts"]);
    expect(resolved).toMatchObject({
      repositoryKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifactKeys: [expect.stringMatching(/^[a-f0-9]{64}$/)]
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    mkdirSync(join(repository, "src"));
    writeFileSync(join(repository, "src", "causal-write.ts"), "causal\n");
    const observedAt = new Date().toISOString();
    const completed = {
      ...run(startedAt, observedAt),
      repositoryKey: resolved!.repositoryKey
    };
    await storage.upsertSource({
      schemaVersion: 1,
      sourceId: "hook_codex_tools",
      sourceKind: "provider-hook",
      provider: "codex",
      runtime: "codex",
      environmentId: metadata.environmentId,
      profileVersion: "codex-hooks-v1",
      granularity: ["event"],
      tokenDimensions: [],
      billingEvidence: [],
      durability: "at_least_once",
      contentRisk: "metadata_only",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    }, observedAt);
    await storage.appendSafeObservation({
      schemaVersion: 1,
      observationId: "obs_causal_write",
      sourceId: "hook_codex_tools",
      provider: "codex",
      runtime: "codex",
      signal: "logs",
      profileVersion: "codex-hooks-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt,
      repositoryKey: resolved!.repositoryKey,
      executionNodes: [{
        schemaVersion: 1,
        nodeId: "node_causal_write",
        queryId: completed.correlationId,
        repositoryKey: resolved!.repositoryKey,
        provider: "codex",
        runtime: "codex",
        nodeKind: "tool",
        name: "Write",
        toolName: "Write",
        outcome: "success",
        startedAt: observedAt,
        endedAt: observedAt,
        artifactKeys: resolved!.artifactKeys,
        artifactEvidence: "provider_write_hook"
      }, {
        schemaVersion: 1,
        nodeId: "node_rejected_write",
        queryId: completed.correlationId,
        repositoryKey: resolved!.repositoryKey,
        provider: "codex",
        runtime: "codex",
        nodeKind: "tool",
        name: "Write",
        toolName: "Write",
        outcome: "rejected",
        startedAt: observedAt,
        endedAt: observedAt,
        artifactKeys: rejected!.artifactKeys,
        artifactEvidence: "provider_write_hook"
      }],
      usageAtoms: []
    });
    await repositories.refresh();
    const attribution = new AgentProductionRunAttribution(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);

    const evidence = await attribution.listEvidence();
    expect(evidence).toEqual([expect.objectContaining({
      queryId: completed.correlationId,
      repoKey: resolved!.repositoryKey,
      causalArtifactKeys: resolved!.artifactKeys,
      causalWriteArtifacts: [{
        artifactKey: resolved!.artifactKeys[0],
        executionNodeId: "node_causal_write"
      }]
    })]);
    expect(evidence[0]?.causalWriteArtifacts?.map((item) => item.artifactKey)).not.toContain(rejected!.artifactKeys[0]);
    expect(JSON.stringify(evidence)).not.toContain("causal-write.ts");

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("does not create causal proof or commit authority from a generic Claude Write conflicted by its exact native rejection", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-rejected-write-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    await repositories.refresh();
    const baseline = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baseline.observedAt) + 1).toISOString();
    const endedAt = new Date(Date.parse(startedAt) + 1).toISOString();
    const resolved = await repositories.resolveWorkspaceEvidence(repository, ["rejected-write.ts"]);
    expect(resolved).toMatchObject({
      repositoryKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifactKeys: [expect.stringMatching(/^[a-f0-9]{64}$/)]
    });
    const completed = {
      ...run(startedAt, endedAt),
      runId: "run_rejected_claude_write",
      correlationId: "qry_rejected_claude_write",
      queryId: "qry_rejected_claude_write",
      provider: "claude-code" as const,
      runtime: "claude-code",
      repositoryKey: resolved!.repositoryKey
    };
    await storage.replaceProductionRuns([completed]);
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "node_successful_unrelated_claude_write",
      sortAt: startedAt,
      value: {
        schemaVersion: 1,
        nodeId: "node_successful_unrelated_claude_write",
        queryId: completed.queryId,
        repositoryKey: resolved!.repositoryKey,
        requestId: "req_conflicted_claude_write",
        provider: "claude-code",
        runtime: "claude-code",
        signal: "logs",
        nodeKind: "tool",
        name: "Write",
        toolName: "Write",
        outcome: "success",
        startedAt,
        artifactKeys: resolved!.artifactKeys,
        artifactEvidence: "provider_write_hook"
      } satisfies ExecutionNodeAtomV1
    });
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "node_rejected_claude_write",
      sortAt: startedAt,
      value: {
        schemaVersion: 1,
        nodeId: "node_rejected_claude_write",
        queryId: completed.queryId,
        repositoryKey: resolved!.repositoryKey,
        requestId: "req_conflicted_claude_write",
        provider: "claude-code",
        runtime: "claude-code",
        signal: "logs",
        nodeKind: "tool",
        name: "Write",
        toolName: "Write",
        outcome: "rejected",
        outcomeAuthority: "native_permission_decision",
        startedAt
      } satisfies ExecutionNodeAtomV1
    });

    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);

    const evidence = await attribution.listWorkspaceEvidence();
    expect(evidence).toEqual([expect.objectContaining({
      causalWriteArtifactsComplete: true,
      causalWriteArtifacts: [],
      nativeRejectedCausalWriteArtifacts: [{
        artifactKey: resolved!.artifactKeys[0],
        executionNodeId: "node_successful_unrelated_claude_write"
      }]
    })]);
    expect(evidence.flatMap((item) => item.causalArtifactKeys ?? [])).not.toContain(resolved!.artifactKeys[0]);

    writeFileSync(join(repository, "rejected-write.ts"), "not written by the rejected tool\n");
    execFileSync("git", ["-C", repository, "add", "rejected-write.ts"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "rejected write"]);
    await repositories.refresh();

    expect(await repositories.requireObservation().listCandidates()).toEqual([
      expect.objectContaining({ decision: "pending_evidence" })
    ]);
    expect(await attribution.listCommitAttributions()).toEqual([]);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("retracts only the exact durable causal pair when a Claude native decision arrives after success", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-late-native-rejection-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    await repositories.refresh();
    const baseline = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baseline.observedAt) + 1).toISOString();
    const rejected = await repositories.resolveWorkspaceEvidence(repository, ["src/rejected.ts"]);
    const independent = await repositories.resolveWorkspaceEvidence(repository, ["src/independent.ts"]);
    expect(rejected?.repositoryKey).toBe(independent?.repositoryKey);
    mkdirSync(join(repository, "src"));
    writeFileSync(join(repository, "src", "rejected.ts"), "rejected later\n");
    writeFileSync(join(repository, "src", "independent.ts"), "independent\n");
    const observedAt = new Date().toISOString();
    const queryId = "qry_late_native_durable";
    const completed = {
      ...run(startedAt, observedAt),
      runId: "run_late_native_durable",
      correlationId: queryId,
      queryId,
      provider: "claude-code" as const,
      runtime: "claude-code",
      repositoryKey: rejected!.repositoryKey
    };
    await storage.replaceProductionRuns([completed]);
    const successfulRejected: ExecutionNodeAtomV1 = {
      schemaVersion: 1,
      nodeId: "node_late_native_rejected_write",
      queryId,
      repositoryKey: rejected!.repositoryKey,
      requestId: "req_hook_late_native_rejected",
      invocationId: "invocation_late_native_rejected",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      nodeKind: "tool",
      name: "Write",
      toolName: "Write",
      outcome: "success",
      startedAt: observedAt,
      artifactKeys: rejected!.artifactKeys,
      artifactEvidence: "provider_write_hook"
    };
    const successfulIndependent: ExecutionNodeAtomV1 = {
      ...successfulRejected,
      nodeId: "node_late_native_independent_write",
      requestId: "req_hook_late_native_independent",
      invocationId: "invocation_late_native_independent",
      artifactKeys: independent!.artifactKeys
    };
    await storage.upsertAgentDocument("execution_node_atom", {
      key: successfulRejected.nodeId,
      sortAt: observedAt,
      value: successfulRejected
    });
    await storage.upsertAgentDocument("execution_node_atom", {
      key: successfulIndependent.nodeId,
      sortAt: observedAt,
      value: successfulIndependent
    });
    await repositories.refresh();

    const attribution = new AgentProductionRunAttribution(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);
    expect((await attribution.listEvidence())[0]?.causalWriteArtifacts).toEqual(expect.arrayContaining([
      { artifactKey: rejected!.artifactKeys[0], executionNodeId: successfulRejected.nodeId },
      { artifactKey: independent!.artifactKeys[0], executionNodeId: successfulIndependent.nodeId }
    ]));

    const decision: ExecutionNodeAtomV1 = {
      ...successfulRejected,
      nodeId: "node_late_native_permission_decision",
      requestId: "req_otlp_late_native_rejected",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      artifactKeys: undefined,
      artifactEvidence: undefined
    };
    await storage.upsertAgentDocument("execution_node_atom", {
      key: decision.nodeId,
      sortAt: new Date(Date.parse(observedAt) + 1).toISOString(),
      value: decision
    });
    await attribution.observeSafeObservation({
      schemaVersion: 1,
      observationId: "obs_late_native_permission_decision",
      sourceId: "otlp_claude_code_logs",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-otlp-logs-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: new Date(Date.parse(observedAt) + 1).toISOString(),
      executionNodes: [decision],
      usageAtoms: []
    });

    const [evidence] = await attribution.listEvidence();
    expect(evidence).toMatchObject({
      causalWriteArtifactsComplete: true,
      causalWriteArtifacts: [{
        artifactKey: independent!.artifactKeys[0],
        executionNodeId: successfulIndependent.nodeId
      }],
      nativeRejectedCausalWriteArtifacts: [{
        artifactKey: rejected!.artifactKeys[0],
        executionNodeId: successfulRejected.nodeId
      }]
    });
    const [episode] = await attribution.listEpisodes({ queryId });
    expect(episode?.evidence[0]).toMatchObject({
      causalWriteArtifactsComplete: true,
      causalWriteArtifacts: [{
        artifactKey: independent!.artifactKeys[0],
        executionNodeId: successfulIndependent.nodeId
      }],
      nativeRejectedCausalWriteArtifacts: [{
        artifactKey: rejected!.artifactKeys[0],
        executionNodeId: successfulRejected.nodeId
      }]
    });

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("ignores an exact Claude native rejection that began after the completed-run boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-post-boundary-native-rejection-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    await repositories.refresh();
    const baseline = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baseline.observedAt) + 1).toISOString();
    const completedAt = new Date(Date.parse(startedAt) + 1).toISOString();
    const postBoundaryAt = new Date(Date.parse(completedAt) + 1).toISOString();
    const resolved = await repositories.resolveWorkspaceEvidence(repository, ["src/post-boundary.ts"]);
    expect(resolved).toMatchObject({
      repositoryKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifactKeys: [expect.stringMatching(/^[a-f0-9]{64}$/)]
    });
    mkdirSync(join(repository, "src"));
    writeFileSync(join(repository, "src", "post-boundary.ts"), "successful write\n");
    const queryId = "qry_post_boundary_native_rejection";
    const completed = {
      ...run(startedAt, completedAt),
      runId: "run_post_boundary_native_rejection",
      correlationId: queryId,
      queryId,
      provider: "claude-code" as const,
      runtime: "claude-code",
      repositoryKey: resolved!.repositoryKey
    };
    await storage.replaceProductionRuns([completed]);
    const successfulWrite: ExecutionNodeAtomV1 = {
      schemaVersion: 1,
      nodeId: "node_post_boundary_successful_write",
      queryId,
      repositoryKey: resolved!.repositoryKey,
      requestId: "req_hook_post_boundary_write",
      invocationId: "invocation_post_boundary_write",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      nodeKind: "tool",
      name: "Write",
      toolName: "Write",
      outcome: "success",
      startedAt: completedAt,
      artifactKeys: resolved!.artifactKeys,
      artifactEvidence: "provider_write_hook"
    };
    await storage.upsertAgentDocument("execution_node_atom", {
      key: successfulWrite.nodeId,
      sortAt: completedAt,
      value: successfulWrite
    });
    await repositories.refresh();

    const attribution = new AgentProductionRunAttribution(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);
    expect((await attribution.listEvidence())[0]).toMatchObject({
      causalWriteArtifacts: [{
        artifactKey: resolved!.artifactKeys[0],
        executionNodeId: successfulWrite.nodeId
      }]
    });

    const postBoundaryDecision: ExecutionNodeAtomV1 = {
      ...successfulWrite,
      nodeId: "node_post_boundary_native_permission_decision",
      requestId: "req_otlp_post_boundary_write",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      startedAt: postBoundaryAt,
      artifactKeys: undefined,
      artifactEvidence: undefined
    };
    await storage.upsertAgentDocument("execution_node_atom", {
      key: postBoundaryDecision.nodeId,
      sortAt: postBoundaryAt,
      value: postBoundaryDecision
    });
    await attribution.observeSafeObservation({
      schemaVersion: 1,
      observationId: "obs_post_boundary_native_permission_decision",
      sourceId: "otlp_claude_code_logs",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-otlp-logs-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: postBoundaryAt,
      executionNodes: [postBoundaryDecision],
      usageAtoms: []
    });

    const [evidence] = await attribution.listEvidence();
    expect(evidence).toMatchObject({
      causalWriteArtifactsComplete: true,
      causalWriteArtifacts: [{
        artifactKey: resolved!.artifactKeys[0],
        executionNodeId: successfulWrite.nodeId
      }]
    });
    expect(evidence?.nativeRejectedCausalWriteArtifacts ?? []).toEqual([]);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("defers a decision received before terminal evidence until the completed boundary is known", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-decision-before-terminal-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    await repositories.refresh();
    const baseline = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baseline.observedAt) + 1).toISOString();
    const writeAt = new Date(Date.parse(startedAt) + 1).toISOString();
    const completedAt = new Date(Date.parse(writeAt) + 1).toISOString();
    const postBoundaryAt = new Date(Date.parse(completedAt) + 1).toISOString();
    const resolved = await repositories.resolveWorkspaceEvidence(repository, ["src/decision-before-terminal.ts"]);
    expect(resolved).toBeDefined();
    mkdirSync(join(repository, "src"));
    writeFileSync(join(repository, "src", "decision-before-terminal.ts"), "successful write\n");
    const queryId = "qry_decision_before_terminal";
    const active = {
      ...run(startedAt, completedAt),
      runId: "run_decision_before_terminal",
      correlationId: queryId,
      queryId,
      sessionId: "ses_decision_before_terminal",
      provider: "claude-code" as const,
      runtime: "claude-code",
      repositoryKey: resolved!.repositoryKey,
      endedAt: undefined
    };
    const successfulWrite: ExecutionNodeAtomV1 = {
      schemaVersion: 1,
      nodeId: "node_decision_before_terminal_successful_write",
      queryId,
      sessionId: active.sessionId,
      repositoryKey: resolved!.repositoryKey,
      requestId: "req_hook_decision_before_terminal",
      invocationId: "invocation_decision_before_terminal",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      nodeKind: "tool",
      name: "Write",
      toolName: "Write",
      outcome: "success",
      startedAt: writeAt,
      artifactKeys: resolved!.artifactKeys,
      artifactEvidence: "provider_write_hook"
    };
    await storage.upsertAgentDocument("execution_node_atom", {
      key: successfulWrite.nodeId,
      sortAt: successfulWrite.startedAt,
      value: successfulWrite
    });
    await repositories.refresh();

    const attribution = new AgentProductionRunAttribution(storage, repositories);
    await attribution.start();
    const startObservation: SafeObservationV1 = {
      schemaVersion: 1,
      observationId: "obs_decision_before_terminal_start",
      sourceId: "hook_claude_code_lifecycle",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-hooks-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: startedAt,
      repositoryKey: resolved!.repositoryKey,
      queryOccurrences: [{
        schemaVersion: 1,
        queryId,
        sessionId: active.sessionId,
        repositoryKey: resolved!.repositoryKey,
        provider: "claude-code",
        runtime: "claude-code",
        startedAt,
        promptState: "captured",
        evidence: "submission_hook"
      }],
      usageAtoms: []
    };
    await attribution.observeSafeObservation(startObservation);
    await attribution.observeRun(productionRunForAttribution(active));
    expect((await attribution.listEvidence())[0]).toMatchObject({
      causalWriteArtifacts: [{
        artifactKey: resolved!.artifactKeys[0],
        executionNodeId: successfulWrite.nodeId
      }]
    });

    const postBoundaryDecision: ExecutionNodeAtomV1 = {
      ...successfulWrite,
      nodeId: "node_decision_before_terminal_post_boundary_rejection",
      requestId: "req_otlp_decision_before_terminal",
      outcome: "rejected",
      outcomeAuthority: "native_permission_decision",
      startedAt: postBoundaryAt,
      artifactKeys: undefined,
      artifactEvidence: undefined
    };
    await storage.upsertAgentDocument("execution_node_atom", {
      key: postBoundaryDecision.nodeId,
      sortAt: postBoundaryAt,
      value: postBoundaryDecision
    });
    await attribution.observeSafeObservation({
      schemaVersion: 1,
      observationId: "obs_decision_before_terminal_rejection",
      sourceId: "otlp_claude_code_logs",
      provider: "claude-code",
      runtime: "claude-code",
      signal: "logs",
      profileVersion: "claude-code-otlp-logs-v1",
      resourceCount: 1,
      recordCount: 1,
      observedAt: postBoundaryAt,
      executionNodes: [postBoundaryDecision],
      usageAtoms: []
    });
    let [evidence] = await attribution.listEvidence();
    expect(evidence).toMatchObject({
      causalWriteArtifacts: [{
        artifactKey: resolved!.artifactKeys[0],
        executionNodeId: successfulWrite.nodeId
      }]
    });
    expect(evidence.nativeRejectedCausalWriteArtifacts ?? []).toEqual([]);

    await attribution.observeSafeObservation({
      ...startObservation,
      observationId: "obs_decision_before_terminal_completed",
      observedAt: completedAt,
      queryOccurrences: startObservation.queryOccurrences?.map((occurrence) => ({
        ...occurrence,
        completedAt,
        completionEvidence: "stop_hook" as const
      }))
    });
    [evidence] = await attribution.listEvidence();
    expect(evidence).toMatchObject({
      causalWriteArtifacts: [{
        artifactKey: resolved!.artifactKeys[0],
        executionNodeId: successfulWrite.nodeId
      }]
    });
    expect(evidence.nativeRejectedCausalWriteArtifacts ?? []).toEqual([]);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("caps reconstructed workspace evidence at the next run start", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-run-boundary-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    await repositories.refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const firstStartedAt = new Date().toISOString();
    writeFileSync(join(repository, "first.txt"), "first run\n");
    await repositories.refresh();
    const firstEndedAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const secondStartedAt = new Date().toISOString();
    writeFileSync(join(repository, "second.txt"), "second run\n");
    await repositories.refresh();
    const secondEndedAt = new Date().toISOString();

    const first = {
      ...run(firstStartedAt, firstEndedAt),
      runId: "run_first_boundary",
      correlationId: "qry_first_boundary",
      queryId: "qry_first_boundary",
      sessionId: "ses_boundary"
    };
    const second = {
      ...run(secondStartedAt, secondEndedAt),
      runId: "run_second_boundary",
      correlationId: "qry_second_boundary",
      queryId: "qry_second_boundary",
      sessionId: "ses_boundary"
    };

    const attribution = new AgentProductionRunAttribution(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([first, second]);

    const evidence = await attribution.listEvidence();
    const firstEvidence = evidence.find((item) => item.queryId === "qry_first_boundary");
    const secondEvidence = evidence.find((item) => item.queryId === "qry_second_boundary");
    expect(firstEvidence).toBeDefined();
    expect(secondEvidence).toBeDefined();
    const repoKey = firstEvidence!.repoKey;
    expect(firstEvidence!.artifactKeys).toContain(repositories.artifactKey(repoKey, "first.txt"));
    expect(firstEvidence!.artifactKeys).not.toContain(repositories.artifactKey(repoKey, "second.txt"));
    expect(secondEvidence!.artifactKeys).toContain(repositories.artifactKey(repoKey, "second.txt"));

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("uses live safe observations to close older settling evidence before the next prompt writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-live-boundary-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    await repositories.refresh();

    const attribution = new AgentProductionRunAttribution(storage, repositories);
    await attribution.start();

    const firstStartedAt = new Date().toISOString();
    const firstActive = {
      ...run(firstStartedAt, new Date(Date.parse(firstStartedAt) + 500).toISOString()),
      runId: "run_first_live_boundary",
      correlationId: "qry_first_live_boundary",
      queryId: "qry_first_live_boundary",
      sessionId: "ses_live_boundary",
      endedAt: undefined
    };
    await attribution.observeRun(productionRunForAttribution(firstActive));

    writeFileSync(join(repository, "first-live.txt"), "first live\n");
    await repositories.refresh();
    const firstCompleted = {
      ...firstActive,
      endedAt: new Date().toISOString()
    };
    await attribution.observeRunCompleted(productionRunForAttribution(firstCompleted));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const secondStartedAt = new Date().toISOString();
    const second = {
      ...run(secondStartedAt, new Date(Date.parse(secondStartedAt) + 500).toISOString()),
      runId: "run_second_live_boundary",
      correlationId: "qry_second_live_boundary",
      queryId: "qry_second_live_boundary",
      sessionId: "ses_live_boundary"
    };
    await attribution.observeSafeObservation(safeObservation(second, secondStartedAt));
    writeFileSync(join(repository, "second-live.txt"), "second live\n");
    await repositories.refresh();

    const evidence = await attribution.listEvidence();
    const firstEvidence = evidence.find((item) => item.queryId === "qry_first_live_boundary");
    const secondEvidence = evidence.find((item) => item.queryId === "qry_second_live_boundary");
    expect(firstEvidence).toBeDefined();
    expect(secondEvidence).toBeDefined();
    const repoKey = firstEvidence!.repoKey;
    expect(firstEvidence!.artifactKeys).toContain(repositories.artifactKey(repoKey, "first-live.txt"));
    expect(firstEvidence!.artifactKeys).not.toContain(repositories.artifactKey(repoKey, "second-live.txt"));
    expect(secondEvidence!.artifactKeys).toContain(repositories.artifactKey(repoKey, "second-live.txt"));

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("signals attribution reconciliation when live workspace evidence finishes binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-evidence-handoff-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    const attribution = new AgentProductionRunAttribution(storage, repositories);
    await attribution.start();
    let evidenceBound = false;
    attribution.onWorkspaceEvidenceBound(async () => {
      evidenceBound = true;
    });
    const active = run(new Date().toISOString(), new Date().toISOString());
    await attribution.observeRun(productionRunForAttribution({ ...active, endedAt: undefined }));

    writeFileSync(join(repository, "live.txt"), "live evidence\n");
    await repositories.refresh();
    await waitUntil(() => evidenceBound);

    expect(evidenceBound).toBe(true);
    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("binds live execution Edit evidence to the edited repository before run completion in a multi-repository session", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-live-edit-binding-"));
    roots.push(root);
    const repositoryA = join(root, "repo-a");
    const repositoryB = join(root, "repo-b");
    for (const repository of [repositoryA, repositoryB]) {
      execFileSync("git", ["init", repository]);
      execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
      writeFileSync(join(repository, "edited.ts"), "export const value = 0;\n");
      execFileSync("git", ["-C", repository, "add", "."]);
      execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
    }

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repositoryA, "repository", metadata.environmentId, new Date().toISOString());
    await scopes.add(repositoryB, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();

    const live = run(new Date().toISOString(), new Date(Date.now() + 5_000).toISOString());
    writeFileSync(join(repositoryA, "edited.ts"), "export const value = 1;\n");
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "live-edit-node",
      sortAt: live.startedAt,
      value: editNode(live, repositoryA)
    });

    const attribution = new AgentProductionRunAttribution(storage, repositories);
    await attribution.start();
    await attribution.observeRun(productionRunForAttribution({ ...live, endedAt: undefined }));

    await waitUntil(async () =>
      (await attribution.listEpisodes()).some((episode) =>
        episode.queryIds.includes(live.queryId ?? live.correlationId)
        && episode.repoKeys.length === 1
        && episode.evidence.length === 1
        && episode.evidence[0].repoKey === episode.repoKeys[0]
        && episode.evidence[0].observedChangeCount > 0
      )
    );

    expect(await attribution.listEpisodes()).toEqual([
      expect.objectContaining({
        queryIds: [live.queryId ?? live.correlationId],
        repoKeys: [expect.stringMatching(/^[a-f0-9]{64}$/)],
        evidence: [expect.objectContaining({
          observedChangeCount: 1
        })]
      })
    ]);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("allocates estimated query cost only after exact committed content continuity", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-verified-attribution-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();

    const startedAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(join(repository, "verified.txt"), "verified state\n");
    await repositories.refresh();
    const completed = run(startedAt, new Date().toISOString());
    await storage.replaceProductionRuns([completed]);
    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);
    expect(await attribution.listCommitAttributions()).toEqual([]);

    execFileSync("git", ["-C", repository, "add", "verified.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "verified"]);
    await repositories.refresh();
    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        allocatedNanoUsd: 100_000,
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["correlation_12345678"],
        providerCosts: [
          { provider: "codex", queryCount: 1, allocatedNanoUsd: 100_000, allocatedUsd: 0.0001, allocatedAiCredits: 0.01 }
        ]
      })
    ]);
    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("preserves provider attribution when a completed Claude run has cost but no model name", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-provider-fallback-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();

    const startedAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(join(repository, "provider-fallback.txt"), "verified state\n");
    await repositories.refresh();
    const completed = {
      ...run(startedAt, new Date().toISOString()),
      provider: "claude-code" as const,
      runtime: "claude-code",
      model: undefined,
      modelProvider: "anthropic" as const,
      modelProviderBasis: "model_name_rule" as const,
      modelProviderClassificationVersion: "model-provider-rules-2026-06-15",
      authority: "request" as const,
      estimatedNanoUsd: 616_918_900,
      pricingVersion: "provider-reported-v1",
      billingContext: "unknown" as const,
    };
    await storage.replaceProductionRuns([completed]);
    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);

    execFileSync("git", ["-C", repository, "add", "provider-fallback.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "provider fallback"]);
    await repositories.refresh();

    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        allocatedNanoUsd: 616_918_900,
        providerCosts: [
          {
            provider: "claude-code",
            queryCount: 1,
            allocatedNanoUsd: 616_918_900,
            allocatedUsd: 0.6169189,
            allocatedAiCredits: 61.69189
          }
        ]
      })
    ]);
    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("reconstructs verified attribution when completed-run reconciliation starts after the commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-delayed-reconciliation-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();

    const startedAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(join(repository, "delayed.txt"), "verified before reconciliation\n");
    await repositories.refresh();
    const completed = run(startedAt, new Date().toISOString());
    await storage.replaceProductionRuns([completed]);

    execFileSync("git", ["-C", repository, "add", "delayed.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "delayed reconciliation"]);
    await repositories.refresh();

    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);

    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        commitHash: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        allocatedNanoUsd: 100_000,
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["correlation_12345678"]
      })
    ]);
    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("defers historical completed runs until explicit reconciliation is requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-live-first-deferred-history-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    const baselineSnapshot = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baselineSnapshot.observedAt) + 1_000).toISOString();
    const endedAt = new Date(Date.parse(startedAt) + 5_000).toISOString();
    const completed = run(startedAt, endedAt);
    await storage.replaceProductionRuns([completed]);
    writeFileSync(join(repository, "deferred.txt"), "deferred history\n");
    execFileSync("git", ["-C", repository, "add", "deferred.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "deferred"]);
    await repositories.refresh();

    const cutoffAt = new Date(Date.parse(endedAt) + 60_000).toISOString();
    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.prepareLiveProcessing(cutoffAt);
    expect(await attribution.observeCompletedRunsIncrementally([completed])).toMatchObject({
      processedCount: 0,
      deferredCount: 1
    });
    expect(await attribution.listCommitAttributions()).toEqual([]);
    expect(await attribution.historicalStatus([completed])).toMatchObject({
      processedCompletedRunCount: 0,
      deferredCompletedRunCount: 1
    });

    await attribution.observeProductionRuns([completed]);
    expect(await attribution.historicalStatus([completed])).toMatchObject({
      processedCompletedRunCount: 1,
      deferredCompletedRunCount: 0
    });
    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("captures live workspace evidence for an in-flight headless run before commit attribution", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-live-attribution-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();

    const startedAt = new Date().toISOString();
    const completed = run(startedAt, new Date(Date.parse(startedAt) + 5_000).toISOString());
    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeCurrentRuns([{
      ...completed,
      startedAt: new Date(Date.parse(startedAt) - 5 * 60 * 60 * 1000).toISOString(),
      endedAt: undefined
    }]);
    expect(await storage.listAgentDocuments("workspace_evidence")).toEqual([]);
    await attribution.observeCurrentRuns([{ ...completed, endedAt: undefined }]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(join(repository, "live.txt"), "live state\n");
    await repositories.refresh();

    await storage.replaceProductionRuns([completed]);
    await attribution.observeProductionRuns([completed]);
    execFileSync("git", ["-C", repository, "add", "live.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "live"]);
    await repositories.refresh();

    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        commitHash: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        allocatedNanoUsd: 100_000,
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["correlation_12345678"]
      })
    ]);
    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("does not let prompt-unavailable runs open workspace attribution windows", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-unavailable-run-attribution-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();

    const startedAt = new Date().toISOString();
    const uncorrelated = {
      ...run(startedAt, new Date(Date.parse(startedAt) + 5_000).toISOString()),
      runId: "run_prompt_unavailable",
      correlationId: "qry_prompt_unavailable",
      promptState: "unavailable" as const
    };
    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeCurrentRuns([{ ...uncorrelated, endedAt: undefined }]);

    writeFileSync(join(repository, "should-not-bind.txt"), "this change belongs to no proven run\n");
    await repositories.refresh();
    expect(await storage.listAgentDocuments("workspace_evidence")).toEqual([]);

    expect(await attribution.observeCompletedRunsIncrementally([uncorrelated])).toMatchObject({
      processedCount: 0,
      deferredCount: 1
    });
    expect((await storage.listAgentDocuments<{ outcome?: string }>("completed_run_tracking"))[0]?.value.outcome)
      .toBe("identity_deferred");
    expect(await attribution.observeCompletedRunsIncrementally([uncorrelated])).toMatchObject({
      processedCount: 0,
      deferredCount: 1
    });
    expect(await storage.listAgentDocuments("completed_run_tracking")).toHaveLength(1);

    expect(await attribution.observeCompletedRunsIncrementally([{
      ...uncorrelated,
      promptState: "disabled"
    }])).toMatchObject({
      processedCount: 1,
      deferredCount: 0
    });
    expect((await storage.listAgentDocuments<{ outcome?: string }>("completed_run_tracking"))[0]?.value.outcome)
      .toBe("processed");
    expect(await storage.listAgentDocuments("workspace_evidence")).toHaveLength(1);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("attributes a commit when workspace changes first appear after the completed run is observed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-post-completion-live-attribution-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();

    const baselineSnapshot = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baselineSnapshot.observedAt) + 25).toISOString();
    const completed = run(startedAt, new Date(Date.parse(startedAt) + 25).toISOString());
    await storage.replaceProductionRuns([completed]);
    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await attribution.observeCompletedRunsIncrementally([completed]);
    expect(await attribution.listCommitAttributions()).toEqual([]);

    const effectiveQueryId = completed.queryId ?? completed.correlationId;
    writeFileSync(join(repository, "post-complete.txt"), "captured after completion\n");
    await repositories.refresh();
    await waitUntil(async () =>
      (await storage.listAgentDocuments("workspace_evidence")).some((document) =>
        document.key.startsWith(`${effectiveQueryId}:`)
        && document.value.observedChangeCount > 0
      )
    );
    await waitUntil(async () =>
      (await storage.listAgentDocuments("work_episode")).some((document) =>
        document.value.queryIds.includes(effectiveQueryId)
        && document.value.repoKeys.length > 0
        && document.value.evidence.length > 0
      )
    );

    execFileSync("git", ["-C", repository, "add", "post-complete.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "post completion"]);
    await repositories.refresh();
    await waitUntil(async () => (await attribution.listCommitAttributions()).length === 1);

    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        commitHash: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        allocatedNanoUsd: 100_000,
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["correlation_12345678"]
      })
    ]);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("reprocesses a completed run when its completion advances and captures later workspace evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-advanced-completion-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();

    const startedAt = new Date().toISOString();
    const firstCompleted = {
      ...run(startedAt, new Date(Date.parse(startedAt) + 25).toISOString()),
      runId: "run_advanced_completion",
      correlationId: "qry_advanced_completion"
    };
    const advancedCompleted = {
      ...firstCompleted,
      endedAt: new Date(Date.parse(startedAt) + 5_000).toISOString()
    };

    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeCompletedRunsIncrementally([firstCompleted]);
    expect(
      (await storage.listAgentDocuments<{ completedAt: string }>("completed_run_tracking"))[0]?.value.completedAt
    ).toBe(firstCompleted.endedAt);

    writeFileSync(join(repository, "advanced.txt"), "advanced completion evidence\n");
    await repositories.refresh();
    await attribution.observeCompletedRunsIncrementally([advancedCompleted]);

    execFileSync("git", ["-C", repository, "add", "advanced.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "advanced completion"]);
    await repositories.refresh();

    await waitUntil(async () => (await attribution.listCommitAttributions()).length === 1);
    expect(
      (await storage.listAgentDocuments<{ completedAt: string }>("completed_run_tracking"))[0]?.value.completedAt
    ).toBe(advancedCompleted.endedAt);
    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        commitHash: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["qry_advanced_completion"]
      })
    ]);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("attributes a commit from a short-lived dirty state observed during an active run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-transient-attribution-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: new Date().toISOString(),
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, new Date().toISOString());
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();

    const startedAt = new Date().toISOString();
    const completed = run(startedAt, new Date(Date.parse(startedAt) + 5_000).toISOString());
    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeCurrentRuns([{ ...completed, endedAt: undefined }]);

    writeFileSync(join(repository, "live.txt"), "transient dirty state\n");
    await new Promise((resolve) => setTimeout(resolve, 350));
    execFileSync("git", ["-C", repository, "add", "live.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "transient"]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await repositories.refresh();

    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        commitHash: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        allocatedNanoUsd: undefined,
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["correlation_12345678"]
      })
    ]);

    await storage.replaceProductionRuns([completed]);
    await attribution.observeProductionRuns([completed]);

    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        commitHash: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        allocatedNanoUsd: 100_000,
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["correlation_12345678"]
      })
    ]);
    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("reconstructs exact commit continuity from execution Write evidence when snapshots miss the dirty worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-execution-write-attribution-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, "2026-06-08T00:00:01.000Z");
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    const baselineSnapshot = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baselineSnapshot.observedAt) + 1).toISOString();
    const completed = run(startedAt, new Date(Date.parse(startedAt) + 5_000).toISOString());
    const writeEvidence = await repositories.resolveWorkspaceEvidence(repository, ["generated.ts"]);
    expect(writeEvidence).toBeDefined();
    await storage.replaceProductionRuns([completed]);
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "write-node",
      sortAt: completed.startedAt,
      value: {
        ...writeNode(completed, repository),
        repositoryKey: writeEvidence!.repositoryKey,
        artifactKeys: writeEvidence!.artifactKeys,
        artifactEvidence: "provider_tool_event"
      }
    });

    writeFileSync(join(repository, "generated.ts"), "export const generated = 1;\n");
    execFileSync("git", ["-C", repository, "add", "generated.ts"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "generated"]);
    await repositories.refresh();

    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);
    expect(await storage.listAgentDocuments("execution_node_atom")).toHaveLength(1);
    expect(await repositories.listRepositories()).toHaveLength(1);
    expect(await repositories.listSnapshots()).toHaveLength(2);
    expect(await storage.listRepositoryCandidates()).toEqual([
      expect.objectContaining({
        decision: "reportable"
      })
    ]);

    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        commitHash: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        allocatedNanoUsd: 100_000,
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["correlation_12345678"]
      })
    ]);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("reconstructs exact commit continuity from execution Edit evidence when snapshots miss the dirty worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-execution-edit-attribution-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "edited.ts"), "export const value = 0;\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, "2026-06-08T00:00:01.000Z");
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    const baselineSnapshot = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baselineSnapshot.observedAt) + 1).toISOString();
    const completed = run(startedAt, new Date(Date.parse(startedAt) + 5_000).toISOString());
    const editEvidence = await repositories.resolveWorkspaceEvidence(repository, ["edited.ts"]);
    expect(editEvidence).toBeDefined();
    await storage.replaceProductionRuns([completed]);
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "edit-node",
      sortAt: completed.startedAt,
      value: {
        ...editNode(completed, repository),
        repositoryKey: editEvidence!.repositoryKey,
        artifactKeys: editEvidence!.artifactKeys,
        artifactEvidence: "provider_tool_event"
      }
    });

    writeFileSync(join(repository, "edited.ts"), "export const value = 1;\n");
    execFileSync("git", ["-C", repository, "add", "edited.ts"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "edited"]);
    await repositories.refresh();

    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);

    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        commitHash: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        allocatedNanoUsd: 100_000,
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["correlation_12345678"]
      })
    ]);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });

  it("uses the final on-disk file state for execution Write evidence instead of a truncated payload snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-execution-write-disk-state-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
    const metadata = await storage.initialize({
      now: "2026-06-08T00:00:00.000Z",
      ownershipState: "agent_full_owner",
      protocolVersion: "1.0"
    });
    const scopes = new RepositoryScopeManagement(storage, join(root, "locator.key"));
    await scopes.add(repository, "repository", metadata.environmentId, "2026-06-08T00:00:01.000Z");
    const repositories = new AgentRepositoryObservationService(storage, scopes, join(root, "hmac.key"), 60_000);
    await repositories.start();
    const baselineSnapshot = (await repositories.listSnapshots()).at(-1)!;
    const startedAt = new Date(Date.parse(baselineSnapshot.observedAt) + 1).toISOString();
    const completed = run(startedAt, new Date(Date.parse(startedAt) + 5_000).toISOString());
    const writeEvidence = await repositories.resolveWorkspaceEvidence(repository, ["generated.ts"]);
    expect(writeEvidence).toBeDefined();
    await storage.replaceProductionRuns([completed]);
    await storage.upsertAgentDocument("execution_node_atom", {
      key: "write-node-truncated",
      sortAt: completed.startedAt,
      value: {
        ...writeNode(completed, repository, "truncated provider payload"),
        repositoryKey: writeEvidence!.repositoryKey,
        artifactKeys: writeEvidence!.artifactKeys,
        artifactEvidence: "provider_tool_event"
      }
    });

    writeFileSync(join(repository, "generated.ts"), "export const generated = 1;\n");
    execFileSync("git", ["-C", repository, "add", "generated.ts"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "generated"]);
    await repositories.refresh();

    const attribution = new AgentVerifiedAttributionService(storage, repositories);
    await attribution.start();
    await attribution.observeProductionRuns([completed]);

    expect(await attribution.listCommitAttributions()).toEqual([
      expect.objectContaining({
        commitHash: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        allocatedNanoUsd: 100_000,
        decision: "reportable",
        proofKinds: ["exact_content_state"],
        queryIds: ["correlation_12345678"]
      })
    ]);

    await attribution.stop();
    await repositories.stop();
    await storage.close();
  });
});

function run(startedAt: string, endedAt: string): ProductionRunV1 {
  return {
    schemaVersion: 1,
    production: true,
    runId: "run_12345678",
    correlationId: "correlation_12345678",
    provider: "codex",
    runtime: "codex",
    model: "gpt-5.4",
    authority: "turn",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 15,
    estimatedNanoUsd: 100_000,
    pricingVersion: "test",
    billingContext: "openai-direct",
    costCoverage: "complete",
    evidenceGrade: "estimated_usage_cost_unattributed",
    startedAt,
    endedAt,
    warnings: []
  };
}

function safeObservation(run: ProductionRunV1, observedAt: string): SafeObservationV1 {
  const queryId = run.queryId ?? run.correlationId;
  return {
    schemaVersion: 1,
    observationId: `obs_${queryId}`,
    sourceId: "test-source",
    provider: run.provider,
    runtime: run.runtime,
    signal: "logs",
    profileVersion: "test",
    resourceCount: 1,
    recordCount: 1,
    observedAt,
    queryOccurrences: [{
      schemaVersion: 1,
      queryId,
      sessionId: run.sessionId ?? `ses_${queryId}`,
      provider: run.provider,
      runtime: run.runtime,
      startedAt: run.startedAt,
      promptState: "captured",
      evidence: "provider_user_prompt_event"
    }],
    usageAtoms: []
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function writeNode(run: ProductionRunV1, repository: string, content = "export const generated = 1;\n"): ExecutionNodeAtomV1 {
  return {
    schemaVersion: 1,
    nodeId: "node-write",
    queryId: run.queryId ?? run.correlationId,
    sessionId: run.sessionId,
    provider: run.provider,
    runtime: run.runtime,
    signal: "logs",
    nodeKind: "tool",
    name: "Write",
    outcome: "success",
    startedAt: run.startedAt,
    endedAt: run.startedAt,
    durationMs: 1,
    toolName: "Write",
    contents: [{
      schemaVersion: 1,
      kind: "tool_input",
      visibility: "visible",
      text: JSON.stringify({
        file_path: join(repository, "generated.ts"),
        content
      }),
      preview: "{\"file_path\":\"generated.ts\"}"
    }]
  };
}

function editNode(run: ProductionRunV1, repository: string): ExecutionNodeAtomV1 {
  return {
    schemaVersion: 1,
    nodeId: "node-edit",
    queryId: run.queryId ?? run.correlationId,
    sessionId: run.sessionId,
    provider: run.provider,
    runtime: run.runtime,
    signal: "logs",
    nodeKind: "tool",
    name: "Edit",
    outcome: "success",
    startedAt: run.startedAt,
    endedAt: run.startedAt,
    durationMs: 1,
    toolName: "Edit",
    contents: [{
      schemaVersion: 1,
      kind: "tool_input",
      visibility: "visible",
      text: JSON.stringify({
        file_path: join(repository, "edited.ts"),
        old_string: "export const value = 0;\n",
        new_string: "export const value = 1;\n",
        replace_all: false
      }),
      preview: "{\"file_path\":\"edited.ts\"}"
    }]
  };
}
