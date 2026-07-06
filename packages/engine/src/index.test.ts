import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEngineHostBoundary, EngineRuntimePorts } from "./index";

describe("engine host boundary", () => {
  it("can be instantiated without a VS Code runtime", () => {
    const record = vi.fn();
    const ports = {
      clock: { now: () => new Date("2026-06-08T00:00:00.000Z"), setInterval: vi.fn(), setTimeout: vi.fn() },
      atomicStorage: { read: vi.fn(), write: vi.fn(), remove: vi.fn() },
      secretStorage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      diagnostics: { record },
      config: { get: vi.fn() },
      sources: { list: vi.fn() },
      repositoryScopes: { list: vi.fn() },
      lifecycle: { onStart: vi.fn(), onStop: vi.fn() }
    } as unknown as EngineRuntimePorts;

    expect(createEngineHostBoundary(ports).runtimeKind).toBe("host-boundary");
  });

  it("does not import vscode", () => {
    const sourceDir = join(__dirname);
    for (const file of readdirSync(sourceDir).filter((entry) => entry.endsWith(".ts"))) {
      expect(readFileSync(join(sourceDir, file), "utf8")).not.toMatch(/from\s+["']vscode["']|require\(["']vscode["']\)/);
    }
  });
});
