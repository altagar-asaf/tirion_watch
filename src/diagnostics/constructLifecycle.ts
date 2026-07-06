import type { AgentDiagnosticDetailsV1 } from "@tirion/agent-contract";
import type { DiagnosticEvent } from "../types";

type ConstructLifecycleEvent = Extract<DiagnosticEvent, { kind: "constructLifecycle" }>;

export function constructLifecycleMessage(event: ConstructLifecycleEvent): string {
  return `${event.construct}.${event.operation}: ${event.state} (${event.reason})`;
}

export function constructLifecycleDetails(event: ConstructLifecycleEvent): AgentDiagnosticDetailsV1 {
  return {
    construct: event.construct,
    operation: event.operation,
    state: event.state,
    reason: event.reason,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.queryId ? { queryId: event.queryId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.episodeId ? { episodeId: event.episodeId } : {}),
    ...(event.repoKey ? { repoKey: event.repoKey } : {}),
    ...(event.epochId ? { epochId: event.epochId } : {}),
    ...(event.commitHash ? { commitHash: event.commitHash } : {}),
    ...(event.publicationVersion != null ? { publicationVersion: event.publicationVersion } : {}),
    ...(event.batchId ? { batchId: event.batchId } : {}),
    ...(event.agentInstanceId ? { agentInstanceId: event.agentInstanceId } : {}),
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.details ?? {})
  };
}

export function formatConstructLifecycle(event: ConstructLifecycleEvent): string {
  const parts = [
    `${event.construct}.${event.operation}`,
    `state ${event.state}`,
    event.queryId ? `query ${event.queryId}` : undefined,
    event.sessionId ? `session ${event.sessionId}` : undefined,
    event.episodeId ? `episode ${event.episodeId}` : undefined,
    event.repoKey ? `repo ${event.repoKey}` : undefined,
    event.epochId ? `epoch ${event.epochId}` : undefined,
    event.commitHash ? `commit ${event.commitHash.slice(0, 12)}` : undefined,
    event.publicationVersion != null ? `version ${event.publicationVersion}` : undefined,
    event.batchId ? `batch ${event.batchId}` : undefined,
    event.correlationId ? `correlation ${event.correlationId}` : undefined,
    event.reason
  ].filter((part) => part != null);
  return parts.join("; ");
}
