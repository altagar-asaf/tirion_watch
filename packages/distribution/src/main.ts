#!/usr/bin/env node
import { resolve } from "node:path";
import { buildMacOsDistribution } from "./index";

const workspaceRoot = resolve(process.env.TIRION_WORKSPACE_ROOT ?? process.cwd());
const version = process.env.TIRION_RELEASE_VERSION;
const nodeRuntimePath = process.env.TIRION_NODE_RUNTIME;
if (!version || !nodeRuntimePath) {
  process.stderr.write("TIRION_RELEASE_VERSION and TIRION_NODE_RUNTIME are required.\n");
  process.exitCode = 2;
} else {
  try {
    const result = buildMacOsDistribution({
      workspaceRoot,
      outputDir: resolve(process.env.TIRION_RELEASE_OUTPUT ?? `${workspaceRoot}/release`),
      nodeRuntimePath: resolve(nodeRuntimePath),
      version,
      signingIdentity: process.env.TIRION_MACOS_INSTALLER_IDENTITY,
      notaryProfile: process.env.TIRION_MACOS_NOTARY_PROFILE,
      unsignedDevelopment: process.env.TIRION_UNSIGNED_DEVELOPMENT === "1"
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "distribution_failed"}\n`);
    process.exitCode = 1;
  }
}
