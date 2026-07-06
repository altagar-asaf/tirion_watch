import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStorageClient } from "@tirion/agent-storage";
import { AgentRepositoryObservationService } from "./repositoryObservationService";
import { RepositoryScopeManagement } from "./repositoryScopeManagement";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("agent repository observation", () => {
  it("observes an enrolled repository and resumes from agent-owned SQLite state", async () => {
    const root = mkdtempSync(join(tmpdir(), "tirion-agent-observation-"));
    roots.push(root);
    const repository = join(root, "repo");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const fixture = await createFixture(root, repository);
    await fixture.service.start();
    writeFileSync(join(repository, "next.txt"), "next\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "next"]);
    await fixture.service.refresh();
    expect(await fixture.storage.listRepositoryCandidates()).toHaveLength(1);
    expect((await fixture.service.listSnapshots()).length).toBeGreaterThan(1);
    expect(await fixture.service.applyRetention("9999-01-01T00:00:00.000Z")).toBeGreaterThan(0);
    expect(await fixture.service.listSnapshots()).toHaveLength(1);
    await fixture.service.stop();
    await fixture.storage.close();

    const reopened = await createFixture(root, repository, false);
    await reopened.service.start();
    expect(await reopened.storage.listRepositoryCandidates()).toHaveLength(1);
    expect((await reopened.service.listSnapshots()).length).toBeGreaterThan(1);
    expect(await reopened.service.applyRetention("9999-01-01T00:00:00.000Z")).toBeGreaterThan(0);
    expect(await reopened.service.listSnapshots()).toHaveLength(1);
    await reopened.service.stop();
    await reopened.storage.close();
  });
});

async function createFixture(root: string, repository: string, enroll = true) {
  const storage = new AgentStorageClient({ databasePath: join(root, "agent.db") });
  const metadata = await storage.initialize({
    now: "2026-06-08T00:00:00.000Z",
    ownershipState: "agent_shadow",
    protocolVersion: "1.0"
  });
  const scopes = new RepositoryScopeManagement(storage, join(root, "repository-locator.key"));
  if (enroll) {
    await scopes.add(repository, "repository", metadata.environmentId, "2026-06-08T00:00:01.000Z");
  }
  return {
    storage,
    service: new AgentRepositoryObservationService(storage, scopes, join(root, "attribution-hmac.key"), 60_000)
  };
}
