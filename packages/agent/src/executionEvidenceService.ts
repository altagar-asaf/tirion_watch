import type {
  ExecutionNodeAtomV1,
  ExecutionRunListV1,
  ExecutionRunTreeResponseV1,
  ExecutionTreeSnapshotV1,
  OwnershipState
} from "@tirion/agent-contract";
import { AgentStorageClient } from "@tirion/agent-storage";
import { DefaultExecutionTreeProjection } from "@tirion/engine";
import { ProductionUsageService } from "./productionUsageService";

export class ExecutionEvidenceService {
  private readonly projection = new DefaultExecutionTreeProjection();

  constructor(
    private readonly storage: AgentStorageClient,
    private readonly productionUsage: ProductionUsageService
  ) {}

  async listRuns(owner: OwnershipState, limit?: number): Promise<ExecutionRunListV1> {
    const trees = await this.snapshots(owner);
    return {
      schemaVersion: 1,
      runs: (limit == null ? this.projection.summaries(trees) : this.projection.summaries(trees).slice(0, Math.max(0, limit)))
    };
  }

  async tree(owner: OwnershipState, runId: string): Promise<ExecutionRunTreeResponseV1 | undefined> {
    const trees = await this.snapshots(owner);
    const tree = trees.find((item) => item.runId === runId);
    if (!tree) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      run: this.projection.summaries([tree])[0],
      tree
    };
  }

  async snapshots(owner: OwnershipState): Promise<ExecutionTreeSnapshotV1[]> {
    const runs = await this.productionUsage.runs(owner);
    const documents = await this.storage.listAgentDocuments<ExecutionNodeAtomV1>("execution_node_atom");
    return this.projection.project(
      runs,
      documents.map((document) => document.value)
    );
  }
}
