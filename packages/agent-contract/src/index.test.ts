import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_MAJOR,
  agentOwnsUsage,
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
