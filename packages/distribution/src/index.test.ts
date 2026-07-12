import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMacOsDistribution } from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("macOS distribution", () => {
  it("builds a self-contained signed and notarized payload with a birth certificate", () => {
    const workspaceRoot = fakeWorkspace("1.2.3");
    const outputDir = join(workspaceRoot, "release");
    const nodeRuntimePath = join(workspaceRoot, "node-24");
    writeFileSync(nodeRuntimePath, "runtime", { mode: 0o755 });
    const commands: string[] = [];
    const result = buildMacOsDistribution({
      workspaceRoot,
      outputDir,
      nodeRuntimePath,
      version: "1.2.3",
      signingIdentity: "Developer ID Installer: Tirion",
      notaryProfile: "tirion-notary",
      platform: "darwin",
      runner(command, args) {
        commands.push(`${command} ${args.join(" ")}`);
        if (command === nodeRuntimePath) {
          return "v24.11.0\n";
        }
        if (command === "pkgutil" && args[0] === "--expand") {
          mkdirSync(args[2], { recursive: true });
        }
        return command === "pkgutil" && args[0] === "--check-signature"
          ? "Developer ID Installer: Tirion"
          : "";
      }
    });
    expect(result).toMatchObject({ signed: true, notarized: true });
    expect(commands).toEqual(expect.arrayContaining([
      expect.stringContaining("xattr -cr"),
      expect.stringContaining("pkgbuild --root"),
      expect.stringContaining("--scripts"),
      expect.stringContaining("--filter"),
      expect.stringContaining("bsdtar --no-xattrs"),
      expect.stringContaining("mkbom"),
      expect.stringContaining("xar --distribution"),
      expect.stringContaining("pkgutil --payload-files"),
      expect.stringContaining("pkgutil --expand"),
      expect.stringContaining("productsign --sign Developer ID Installer: Tirion"),
      expect.stringContaining("xcrun notarytool submit"),
      expect.stringContaining("xcrun stapler staple"),
      expect.stringContaining("xcrun stapler validate"),
      expect.stringContaining("pkgutil --check-signature")
    ]));
    expect(JSON.parse(readFileSync(result.birthCertificatePath, "utf8"))).toMatchObject({
      runtimeVersion: "v24.11.0",
      ownershipDefault: "agent_full_owner",
      databaseSchemaVersion: 10,
      artifact: {
        packageIdentifier: "dev.tirion.agent",
        signingIdentity: "Developer ID Installer: Tirion",
        notarization: "required-and-verified"
      },
      migrationSupportWindow: {
        minimumDatabaseSchemaVersion: 1,
        maximumDatabaseSchemaVersion: 10,
        legacyExtensionHistoryMigration: "unsupported"
      }
    });
    expect(readFileSync(join(outputDir, "staging", "scripts", "postinstall"), "utf8")).toContain("tirionctl init");
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).files).toHaveProperty("Applications/Tirion/runtime/node");
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).files).toHaveProperty("Applications/Tirion/bin/tirion-tui");
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).files).toHaveProperty("Applications/Tirion/privacy-support-metadata.json");
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).files).toHaveProperty("usr/local/bin/tirionctl");
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).files).toHaveProperty("usr/local/bin/tirion-tui");
  });

  it("fails closed without Node 24 or production signing configuration", () => {
    const workspaceRoot = fakeWorkspace("1.0.0");
    const nodeRuntimePath = join(workspaceRoot, "node");
    writeFileSync(nodeRuntimePath, "runtime");
    expect(() => buildMacOsDistribution({
      workspaceRoot,
      outputDir: join(workspaceRoot, "release"),
      nodeRuntimePath,
      version: "1.0.0",
      platform: "darwin",
      runner: () => "v24.11.0"
    })).toThrow("signing_configuration_required");
    expect(() => buildMacOsDistribution({
      workspaceRoot,
      outputDir: join(workspaceRoot, "release"),
      nodeRuntimePath,
      version: "1.0.0",
      signingIdentity: "identity",
      notaryProfile: "profile",
      platform: "darwin",
      runner: () => "v25.0.0"
    })).toThrow("node_24_runtime_required");
  });

  it("inspects unsigned development artifacts before returning them", () => {
    const workspaceRoot = fakeWorkspace("1.0.0");
    const outputDir = join(workspaceRoot, "release");
    const nodeRuntimePath = join(workspaceRoot, "node");
    writeFileSync(nodeRuntimePath, "runtime");
    const commands: string[] = [];
    const result = buildMacOsDistribution({
      workspaceRoot,
      outputDir,
      nodeRuntimePath,
      version: "1.0.0",
      unsignedDevelopment: true,
      platform: "darwin",
      runner(command, args) {
        commands.push(`${command} ${args.join(" ")}`);
        if (command === nodeRuntimePath) {
          return "v24.11.0";
        }
        if (command === "pkgutil" && args[0] === "--expand") {
          mkdirSync(args[2], { recursive: true });
        }
        return "";
      }
    });
    expect(result).toMatchObject({ signed: false, notarized: false });
    expect(commands).toEqual(expect.arrayContaining([
      expect.stringContaining("pkgutil --payload-files"),
      expect.stringContaining("pkgutil --expand")
    ]));
  });

  it("fails closed before signing a package containing AppleDouble metadata", () => {
    const workspaceRoot = fakeWorkspace("1.0.0");
    const nodeRuntimePath = join(workspaceRoot, "node");
    writeFileSync(nodeRuntimePath, "runtime");
    expect(() => buildMacOsDistribution({
      workspaceRoot,
      outputDir: join(workspaceRoot, "release"),
      nodeRuntimePath,
      version: "1.0.0",
      signingIdentity: "identity",
      notaryProfile: "profile",
      platform: "darwin",
      runner(command, args) {
        if (command === nodeRuntimePath) {
          return "v24.11.0";
        }
        if (command === "pkgutil" && args[0] === "--payload-files") {
          return "./Applications/Tirion/._birth-certificate.json\n";
        }
        return "";
      }
    })).toThrow("package_metadata_entries_forbidden");
  });
});

function fakeWorkspace(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "tirion-distribution-"));
  roots.push(root);
  for (const packageName of [
    "agent",
    "agent-contract",
    "agent-storage",
    "engine",
    "platform",
    "tirionctl"
  ]) {
    const packageRoot = join(root, "packages", packageName);
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: `@tirion/${packageName}`, version, main: "dist/index.js" }));
    writeFileSync(join(packageRoot, "dist", "index.js"), "module.exports = {};\n");
  }
  mkdirSync(join(root, "packages", "tirion-tui"), { recursive: true });
  writeFileSync(join(root, "packages", "tirion-tui", "tirion-tui"), "tui", { mode: 0o755 });
  mkdirSync(join(root, "node_modules", "smol-toml"), { recursive: true });
  writeFileSync(join(root, "node_modules", "smol-toml", "package.json"), JSON.stringify({ name: "smol-toml" }));
  writeFileSync(join(root, "README.md"), "# Tirion\n");
  writeFileSync(join(root, "agent-installation-and-operations.md"), "# Operations\n");
  return root;
}
