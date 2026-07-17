import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_MAJOR,
  agentOwnsUsage,
  hasExactNativePermissionRejectionForExecutionNode,
  sameExactSafeActivityIdentity,
  negotiateProtocol,
  ownershipManifestFor,
  parseHandshakeRequestV1,
  parsePairClientRequestV1,
  parseCopilotSpanDbConfigurationV1,
  parsePublicOwnershipMarkerV1,
  publicOwnershipMarkerFor,
  parseSourceCapabilityV1
} from "./index";

describe("agent contract", () => {
  it("keeps one production owner for every mutable store", () => {
    for (const state of ["extension_legacy", "agent_shadow", "agent_usage_owner", "agent_full_owner"] as const) {
      const manifest = ownershipManifestFor(state, "2026-06-08T00:00:00.000Z");
      expect(Object.values(manifest.owners).every((owner) => owner === "extension" || owner === "agent")).toBe(true);
    }
  });

  it("moves all product state to the agent only at full ownership", () => {
    const manifest = ownershipManifestFor("agent_full_owner", "2026-06-08T00:00:00.000Z");
    expect(new Set(Object.values(manifest.owners))).toEqual(new Set(["agent"]));
  });

  it("exposes only a strictly validated public ownership marker", () => {
    const marker = publicOwnershipMarkerFor("agent_usage_owner", "2026-06-08T00:00:00.000Z");
    expect(parsePublicOwnershipMarkerV1(marker)).toEqual(marker);
    expect(agentOwnsUsage(marker.state)).toBe(true);
    expect(agentOwnsUsage("agent_shadow")).toBe(false);
    expect(() => parsePublicOwnershipMarkerV1({ ...marker, installationId: "secret" })).toThrow(/invalid/i);
  });

  it("fails closed on major protocol mismatch", () => {
    expect(() => negotiateProtocol({ major: AGENT_PROTOCOL_MAJOR + 1, minor: 0 })).toThrow("protocol_major_mismatch");
  });

  it("rejects unknown and sensitive-looking handshake fields", () => {
    const request = handshake();
    expect(parseHandshakeRequestV1(request)).toMatchObject({ clientKind: "tirionctl" });
    expect(() => parseHandshakeRequestV1({ ...request, path: "/private/repo" })).toThrow(/unsupported fields/i);
  });

  it("strictly validates pairing requests", () => {
    expect(parsePairClientRequestV1({
      schemaVersion: 1,
      kind: "test",
      nonce: "nonce_12345678",
      capabilities: ["runtime:read", "runs:read"]
    })).toMatchObject({ kind: "test" });
  });

  it("rejects source locators from source capability records", () => {
    const capability = {
      schemaVersion: 1,
      sourceId: "source_12345678",
      sourceKind: "otlp-http-json",
      provider: "claude-code",
      runtime: "claude-code",
      environmentId: "environment_12345678",
      profileVersion: "claude-code-otlp-v1",
      granularity: ["request"],
      tokenDimensions: ["input", "output"],
      billingEvidence: ["model"],
      durability: "at_least_once",
      contentRisk: "content_expected",
      compatibility: "supported",
      evidenceGrade: "estimated_usage_cost_unattributed"
    } as const;
    expect(parseSourceCapabilityV1(capability)).toMatchObject({ provider: "claude-code" });
    expect(() => parseSourceCapabilityV1({ ...capability, path: "/private/source" })).toThrow(/unsupported fields/i);
  });

  it("strictly validates Copilot span DB configuration requests", () => {
    expect(parseCopilotSpanDbConfigurationV1({
      schemaVersion: 1,
      enabled: true,
      spanDbPath: "/tmp/agent-traces.db",
      captureContent: true,
      dbSpanExporter: true
    })).toMatchObject({ enabled: true, captureContent: true });
    expect(() => parseCopilotSpanDbConfigurationV1({
      schemaVersion: 1,
      enabled: true,
      captureContent: true,
      dbSpanExporter: true
    })).toThrow(/invalid/i);
  });

  it("matches native Claude permission rejection only to the exact opaque tool invocation", () => {
    const successfulWrite = {
      schemaVersion: 1 as const,
      nodeId: "node_successful_write",
      queryId: "qry_permission_conflict",
      // Hooks and OTLP use different request identities for the same tool use.
      requestId: "req_post_tool_use",
      invocationId: "invocation_shared_tool_use",
      provider: "claude-code" as const,
      runtime: "claude-code",
      nodeKind: "tool" as const,
      name: "Write",
      toolName: "Write",
      outcome: "success" as const,
      startedAt: "2026-07-14T12:00:00.000Z"
    };
    const nativeRejection = {
      ...successfulWrite,
      nodeId: "node_native_rejection",
      requestId: "req_otlp_decision",
      outcome: "rejected" as const,
      outcomeAuthority: "native_permission_decision" as const
    };

    expect(hasExactNativePermissionRejectionForExecutionNode(successfulWrite, [nativeRejection])).toBe(true);
    expect(hasExactNativePermissionRejectionForExecutionNode(successfulWrite, [{
      ...nativeRejection,
      invocationId: "invocation_separate_write"
    }])).toBe(false);
    expect(hasExactNativePermissionRejectionForExecutionNode(successfulWrite, [{
      ...nativeRejection,
      toolName: "Edit"
    }])).toBe(false);
    // An invocation ID on only one side must not silently fall back to an
    // otherwise equal request ID; that would recreate the cross-surface bug.
    expect(hasExactNativePermissionRejectionForExecutionNode(successfulWrite, [{
      ...nativeRejection,
      requestId: successfulWrite.requestId,
      invocationId: undefined
    }])).toBe(false);
    // Legacy node records without provider tool-use IDs retain their narrow
    // request-ID fallback only when neither side has invocation identity.
    expect(hasExactNativePermissionRejectionForExecutionNode({
      ...successfulWrite,
      invocationId: undefined,
      requestId: "req_legacy"
    }, [{
      ...nativeRejection,
      invocationId: undefined,
      requestId: "req_legacy"
    }])).toBe(true);
  });

  it("uses opaque invocation precedence for exact Claude activity identity", () => {
    const activity = {
      schemaVersion: 1 as const,
      activityId: "act_permission_identity",
      queryId: "qry_permission_identity",
      requestId: "req_reused_provider_request",
      invocationId: "invocation_actual_tool_use",
      provider: "claude-code" as const,
      runtime: "claude-code",
      kind: "tool" as const,
      name: "Write",
      outcome: "success" as const,
      startedAt: "2026-07-14T12:00:00.000Z"
    };
    expect(sameExactSafeActivityIdentity(activity, {
      ...activity,
      activityId: "act_native_same_invocation",
      requestId: "req_otlp_permission_decision",
      outcome: "rejected"
    })).toBe(true);
    expect(sameExactSafeActivityIdentity(activity, {
      ...activity,
      activityId: "act_other_tool_use_same_request",
      invocationId: "invocation_other_tool_use"
    })).toBe(false);
    expect(sameExactSafeActivityIdentity(activity, {
      ...activity,
      activityId: "act_partial_legacy_identity",
      invocationId: undefined
    })).toBe(false);
    expect(sameExactSafeActivityIdentity({
      ...activity,
      invocationId: undefined,
      requestId: "req_legacy_tool"
    }, {
      ...activity,
      activityId: "act_legacy_permission_identity",
      invocationId: undefined,
      requestId: "req_legacy_tool"
    })).toBe(true);
  });
});

function handshake() {
  return {
    schemaVersion: 1,
    clientKind: "tirionctl",
    clientVersion: "0.1.0",
    protocol: { major: AGENT_PROTOCOL_MAJOR, minor: 0 },
    eventSchemaVersions: [1],
    requestedCapabilities: ["runtime:read"]
  } as const;
}
