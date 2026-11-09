import {
  cantripOsBackupOperationResultSchema,
  cantripOsBackupPageSchema,
  cantripOsBackupSummarySchema,
  type CantripOsBackupAdmission,
  type CantripOsBackupListQuery,
  type cantripOsBackupRecoverySchema,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import type { BackupOperationRow } from "../db/repository/cantrip-os-backups.js";
import { CantripOsPlacementError } from "../db/repository/cantrip-os-error.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

export class CantripOsBackups {
  constructor(
    private readonly repository: Pick<ServerRepository, "cantripOs">,
    private readonly bridge: Pick<WorkerCommandBus, "request"> &
      Partial<Pick<WorkerCommandBus, "isConnected">>,
    private readonly serverId: string,
  ) {}
  private summary(row: BackupOperationRow) {
    const workerConnected = this.bridge.isConnected?.(row.workerId) ?? false;
    return cantripOsBackupSummarySchema.parse({
      operationId: row.operationId,
      action: row.action,
      instanceId: row.instanceId,
      workspaceId: row.workspaceId,
      workerId: row.workerId,
      backupId: row.backupId,
      restoreOperationId: row.restoreOperationId,
      protectedRequest: row.request.protectedRequest,
      result: row.result,
      workerConnected,
      archiveAvailability:
        row.action === "capture"
          ? workerConnected
            ? "not-checked"
            : "worker-offline"
          : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  async list(
    ownerId: string,
    query: CantripOsBackupListQuery,
    capturesOnly: boolean,
  ) {
    const page = await this.repository.cantripOs.backups.list(
      ownerId,
      query,
      capturesOnly,
    );
    return cantripOsBackupPageSchema.parse({
      ...page,
      items: page.items.map((row) => this.summary(row)),
    });
  }
  async get(ownerId: string, id: string) {
    const row = await this.repository.cantripOs.backups.get(ownerId, id);
    if (!row) throw new CantripOsPlacementError("Backup operation not found.");
    return this.summary(row);
  }
  async admit(
    ownerId: string,
    instanceId: string,
    input: CantripOsBackupAdmission,
  ) {
    const { row, created } = await this.repository.cantripOs.backups.admit(
      ownerId,
      instanceId,
      this.serverId,
      input,
    );
    return this.dispatch(ownerId, row.operationId, created ? "new" : "observe");
  }
  async recover(
    ownerId: string,
    id: string,
    input: ReturnType<typeof cantripOsBackupRecoverySchema.parse>,
  ) {
    return this.dispatch(
      ownerId,
      id,
      input.mode,
      input.mode === "continue" ? input : undefined,
    );
  }
  private async dispatch(
    ownerId: string,
    id: string,
    mode: "new" | "observe" | "recover" | "continue",
    continuation?: Extract<
      ReturnType<typeof cantripOsBackupRecoverySchema.parse>,
      { mode: "continue" }
    >,
  ) {
    const row = await this.repository.cantripOs.backups.beginObservation(
      ownerId,
      id,
      continuation ? { ...continuation, serverId: this.serverId } : undefined,
    );
    let result;
    try {
      result = cantripOsBackupOperationResultSchema.parse(
        await this.bridge.request(
          row.workerId,
          mode === "new"
            ? row.command
            : {
                type: "cantrip-os.backup.observe",
                operationId: id,
                scope: row.command.scope,
                action: row.action,
                mode,
                ...(mode === "continue"
                  ? { continuationScope: row.continuationScope! }
                  : {}),
              },
          { ownerId, timeoutMs: null },
        ),
      );
      if (result.operationId !== id || result.action !== row.action)
        throw new Error("The backup response was misrouted.");
    } catch {
      const at = new Date().toISOString();
      result = cantripOsBackupOperationResultSchema.parse({
        operationId: id,
        action: row.action,
        state: "unknown",
        phase: "recovery-required",
        protectedResult: null,
        startedAt: row.createdAt.toISOString(),
        updatedAt: at,
        error:
          "Backup delivery is uncertain. Observe the original admission; its mutation was not replayed.",
      });
    }
    return this.summary(
      await this.repository.cantripOs.backups.record(ownerId, row, result),
    );
  }
}
