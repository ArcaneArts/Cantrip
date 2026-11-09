import {
  cantripOsDesktopStatusSchema,
  cantripOsDesktopWorkerCommandSchema,
  cantripOsGuestDesktopTargetSchema,
  type CantripOsDesktopCreate,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import {
  desktopSummary,
  desktopScope,
  type DesktopOperationRow,
} from "../db/repository/cantrip-os-desktop.js";
import { CantripOsPlacementError } from "../db/repository/cantrip-os-error.js";

export class CantripOsDesktopCoordinator {
  constructor(
    private readonly repository: Pick<
      ServerRepository,
      "cantripOs" | "getWorker"
    >,
    private readonly bridge: Pick<WorkerCommandBus, "request">,
    private readonly serverId: string,
  ) {}
  async status(ownerId: string, instanceId: string, workspaceId: string) {
    const context = await this.repository.cantripOs.desktop.context(
      ownerId,
      instanceId,
      workspaceId,
    );
    try {
      if (
        !(await this.repository.getWorker(ownerId, context.instance.workerId))
      )
        throw new Error("Owning Worker is unavailable.");
      const command = cantripOsDesktopWorkerCommandSchema.parse({
        type: "cantrip-os.desktop.status",
        scope: desktopScope(context, ownerId, this.serverId),
        transport: context.instance.transport,
      });
      const actual = cantripOsGuestDesktopTargetSchema.parse(
        await this.bridge.request(context.instance.workerId, command, {
          ownerId,
          timeoutMs: 180_000,
        }),
      );
      const target = await this.repository.cantripOs.desktop.recordTarget(
        ownerId,
        context,
        actual,
      );
      return cantripOsDesktopStatusSchema.parse({
        target: this.repository.cantripOs.desktop.targetSummary({
          ...context,
          target,
        }),
        observation: { status: actual.status },
        error: null,
      });
    } catch {
      return cantripOsDesktopStatusSchema.parse({
        target: null,
        observation: null,
        error:
          "The captured desktop could not be observed. Check recovery and Worker diagnostics; no operation was dispatched.",
      });
    }
  }
  async create(
    ownerId: string,
    instanceId: string,
    workspaceId: string,
    input: CantripOsDesktopCreate,
  ) {
    const admitted = await this.repository.cantripOs.desktop.admit(
      ownerId,
      instanceId,
      workspaceId,
      this.serverId,
      input,
    );
    const row = admitted.created
      ? admitted.row
      : await this.repository.cantripOs.desktop.beginObservation(
          ownerId,
          instanceId,
          workspaceId,
          input.operationId,
        );
    return this.dispatch(ownerId, row, admitted.created);
  }
  async observe(
    ownerId: string,
    instanceId: string,
    workspaceId: string,
    operationId: string,
  ) {
    return this.dispatch(
      ownerId,
      await this.repository.cantripOs.desktop.beginObservation(
        ownerId,
        instanceId,
        workspaceId,
        operationId,
      ),
      false,
    );
  }
  async get(
    ownerId: string,
    instanceId: string,
    workspaceId: string,
    operationId: string,
  ) {
    const row = await this.repository.cantripOs.desktop.get(
      ownerId,
      instanceId,
      workspaceId,
      operationId,
    );
    if (!row) throw new CantripOsPlacementError("Desktop operation not found.");
    return desktopSummary(row);
  }
  private async dispatch(
    ownerId: string,
    row: DesktopOperationRow,
    execute: boolean,
  ) {
    try {
      if (!(await this.repository.getWorker(ownerId, row.workerId)))
        throw new Error("Owning Worker is unavailable.");
      const command = cantripOsDesktopWorkerCommandSchema.parse({
        ...row.command,
        mode: execute ? "execute" : "observe",
      });
      const result = await this.bridge.request(row.workerId, command, {
        ownerId,
        timeoutMs: 180_000,
      });
      if (result === null)
        return desktopSummary(
          await this.repository.cantripOs.desktop.unknown(ownerId, row),
        );
      return desktopSummary(
        await this.repository.cantripOs.desktop.record(ownerId, row, result),
      );
    } catch {
      return desktopSummary(
        await this.repository.cantripOs.desktop.unknown(ownerId, row),
      );
    }
  }
}
