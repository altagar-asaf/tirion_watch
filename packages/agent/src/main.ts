#!/usr/bin/env node
import { AgentRuntime, restorePreUpgradeBackup } from "./index";

async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") === "maintenance restore-pre-upgrade") {
    restorePreUpgradeBackup();
    return;
  }
  const agent = new AgentRuntime();
  const stop = () => void agent.stop().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await agent.start();
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`tirion-agent failed: ${message}\n`);
  process.exitCode = 1;
});
