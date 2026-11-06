import type { cantripOsWorkspaceCreateSchema } from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import {
  workspaceOperationResult,
  type WorkspaceOperationRow,
} from "../db/repository/cantrip-os-workspace-operations.js";

export class CantripOsWorkspaceOperationCoordinator {
  constructor(
    private readonly repository: Pick<
      ServerRepository,
      "cantripOs" | "getWorker"
    >,
    private readonly bridge: Pick<WorkerCommandBus, "request">,
    private readonly serverId: string,
  ) {}
  async create(
    ownerId: string,
    instanceId: string,
    input: ReturnType<typeof cantripOsWorkspaceCreateSchema.parse>,
  ) {
    const admitted = await this.repository.cantripOs.workspaceOperations.admit(
      ownerId,
      instanceId,
      this.serverId,
      input,
    );
    const row = admitted.created
      ? admitted.row
      : await this.repository.cantripOs.workspaceOperations.beginObservation(
          ownerId,
          instanceId,
          input.operationId,
        );
    return this.dispatch(row, admitted.created);
  }
  async observe(ownerId: string, instanceId: string, operationId: string) {
    return this.dispatch(
      await this.repository.cantripOs.workspaceOperations.beginObservation(
        ownerId,
        instanceId,
        operationId,
      ),
      false,
    );
  }
  private async dispatch(row: WorkspaceOperationRow, execute: boolean) {
    if (["ready", "failed"].includes(row.state))
      return workspaceOperationResult(row);
    try {
      if (row.command.scope.serverId !== this.serverId)
        throw new Error("The operation belongs to another Server.");
      if (!(await this.repository.getWorker(row.ownerId, row.workerId)))
        throw new Error("Owning Worker is unavailable.");
      const result = await this.bridge.request(
        row.workerId,
        execute
          ? row.command
          : {
              type: "cantrip-os.operation.inspect",
              scope: row.command.scope,
              operationId: row.operationId,
            },
        { ownerId: row.ownerId, timeoutMs: 180_000 },
      );
      if (result !== null)
        return workspaceOperationResult(
          await this.repository.cantripOs.workspaceOperations.record(
            row,
            result,
          ),
        );
    } catch {
      // A lost reply can follow a successful create. Never send the mutation again.
    }
    return workspaceOperationResult(
      await this.repository.cantripOs.workspaceOperations.unknown(row),
    );
  }
}
