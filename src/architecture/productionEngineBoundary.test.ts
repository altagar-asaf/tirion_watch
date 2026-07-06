import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("production engine package boundary", () => {
  it("hosts the proven usage constructs without VS Code", async () => {
    const production = await import("@tirion/engine/production");
    expect(production.DefaultTelemetryNormalizer).toBeTypeOf("function");
    expect(production.DefaultPrivacyGuard).toBeTypeOf("function");
    expect(production.DefaultAgentRunAssembler).toBeTypeOf("function");
    expect(production.DefaultTokenMeasurement).toBeTypeOf("function");
    expect(production.DefaultBillingContextResolver).toBeTypeOf("function");
    expect(production.DefaultCostEstimation).toBeTypeOf("function");
    expect(production.warningsForRun).toBeTypeOf("function");
    expect(production.DefaultRepositoryObservation).toBeTypeOf("function");
    expect(production.DefaultWorkspaceChangeTracker).toBeTypeOf("function");
    expect(production.DefaultAgenticWorkEpisodeTracker).toBeTypeOf("function");
    expect(production.DefaultGitAttribution).toBeTypeOf("function");
    expect(production.StateBackedCommitAttributionLedger).toBeTypeOf("function");
  });

  it("compiles the hosted boundary without a vscode runtime dependency", () => {
    const hostedEntry = join(__dirname, "..", "..", "packages", "engine", "hosted-dist", "packages", "engine", "hosted", "index.js");
    expect(existsSync(hostedEntry)).toBe(true);
    expect(readFileSync(hostedEntry, "utf8")).not.toMatch(/require\(["']vscode["']\)/);
  });

  it("does not ship a VS Code composition root in the webhook-only branch", () => {
    expect(existsSync(join(__dirname, "..", "extension.ts"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("activationEvents");
    expect(manifest).not.toHaveProperty("contributes");
    expect(manifest).not.toHaveProperty("main", "./dist/extension.js");
  });
});
