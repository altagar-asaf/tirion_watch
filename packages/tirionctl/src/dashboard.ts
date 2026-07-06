import type { AgentCommitAttributionV1, ProductionRunV1 } from "@tirion/agent-contract";

export function renderDashboard(attributions: AgentCommitAttributionV1[], runs: ProductionRunV1[]): string {
  const lines: string[] = [];

  const earliest = runs.map((r) => r.startedAt).sort()[0];
  lines.push(`Start at: ${earliest ? new Date(earliest).toLocaleString() : "no runs recorded"}`);
  lines.push("");
  lines.push("Commits by provider cost:");
  if (attributions.length === 0) {
    lines.push("  (none)");
  }
  for (const attribution of attributions) {
    const shortHash = attribution.commitHash.slice(0, 10);
    if (attribution.providerCosts.length === 0) {
      lines.push(`  ${shortHash}  ${attribution.repoKey}  (no cost data)`);
      continue;
    }
    const breakdown = attribution.providerCosts
      .map((cost) => `${cost.provider}: ${formatUsd(cost.estimatedNanoUsd)} (${cost.queryCount} ${cost.queryCount === 1 ? "query" : "queries"})`)
      .join(", ");
    lines.push(`  ${shortHash}  ${attribution.repoKey}  ${breakdown}`);
  }

  lines.push("");
  lines.push("Runs by provider:");
  const runsByProvider = groupRunsByProvider(runs);
  if (runsByProvider.length === 0) {
    lines.push("  (none)");
  }
  for (const group of runsByProvider) {
    const usageValue = group.usageValueNanoUsd == null ? "" : `, usage value ${formatUsd(group.usageValueNanoUsd)}`;
    lines.push(`  ${group.provider}: ${group.runCount} ${group.runCount === 1 ? "run" : "runs"}, estimated cost ${formatUsd(group.estimatedNanoUsd)}${usageValue}`);
  }

  return `${lines.join("\n")}\n`;
}

function groupRunsByProvider(runs: ProductionRunV1[]): Array<{ provider: string; runCount: number; estimatedNanoUsd?: number; usageValueNanoUsd?: number }> {
  const byProvider = new Map<string, { runCount: number; nanoUsd: Array<number | undefined>; usageValueNanoUsd: Array<number | undefined> }>();
  for (const run of runs) {
    const entry = byProvider.get(run.provider) ?? { runCount: 0, nanoUsd: [], usageValueNanoUsd: [] };
    entry.runCount += 1;
    entry.nanoUsd.push(run.estimatedNanoUsd);
    entry.usageValueNanoUsd.push(run.usageValueNanoUsd);
    byProvider.set(run.provider, entry);
  }
  return [...byProvider.entries()]
    .map(([provider, entry]) => ({
      provider,
      runCount: entry.runCount,
      estimatedNanoUsd: sumOptionalNanoUsd(entry.nanoUsd),
      usageValueNanoUsd: sumOptionalNanoUsd(entry.usageValueNanoUsd)
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function sumOptionalNanoUsd(values: Array<number | undefined>): number | undefined {
  const reported = values.filter((value): value is number => value != null);
  return reported.length > 0 ? reported.reduce((sum, value) => sum + value, 0) : undefined;
}

function formatUsd(nanoUsd?: number): string {
  if (nanoUsd === undefined) {
    return "n/a";
  }
  return `$${(nanoUsd / 1_000_000_000).toFixed(4)}`;
}
