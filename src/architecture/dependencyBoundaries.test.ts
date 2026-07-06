import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");

describe("agent-first dependency boundaries", () => {
  it("keeps engine and agent contracts independent of VS Code", () => {
    for (const directory of ["packages/engine/src", "packages/agent-contract/src"]) {
      for (const file of sourceFiles(join(root, directory))) {
        expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["']vscode["']|require\(["']vscode["']\)/);
      }
    }
  });

  it("keeps clients out of agent persistence implementations", () => {
    for (const file of sourceFiles(join(root, "packages/tirionctl/src"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@tirion\/agent-storage|packages\/agent-storage|src\/storage/);
    }
  });

  it("keeps production clients out of agent runtime implementations", () => {
    for (const file of sourceFiles(join(root, "packages/tirionctl/src")).filter((path) => !path.endsWith(".test.ts"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@tirion\/agent(?:["'/])|packages\/agent(?:["'/])/);
    }
  });

  it("keeps the extension out of agent engine and persistence implementations", () => {
    for (const file of sourceFiles(join(root, "src")).filter((path) => !path.includes("/architecture/"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@tirion\/(?:engine|agent-storage)|packages\/(?:engine|agent-storage)/);
    }
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") ? [path] : [];
  });
}
