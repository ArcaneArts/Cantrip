import {
  cantripOsPowerStatusSchema,
  cantripOsPowerWorkerCommandSchema,
  cantripOsPowerObservationSchema,
  type CantripOsPowerCreate,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import {
  powerSummary,
  type PowerOperationRow,
} from "../db/repository/cantrip-os-power.js";
import { CantripOsPlacementError } from "../db/repository/cantrip-os-error.js";

export class CantripOsPowerCoordinator {
  constructor(
    private readonly repository: Pick<
      ServerRepository,
      "cantripOs" | "getWorker"
    >,
    private readonly bridge: Pick<WorkerCommandBus, "request">,
    private readonly serverId: string,
  ) {}
  async status(ownerId: string, instanceId: string) {
    const context = await this.repository.cantripOs.power.context(
      ownerId,
      instanceId,
    );
    const { instance, target } = context;
    const summary = this.repository.cantripOs.power.targetSummary(context);
    if (!target || instance.transport.kind !== "docker")
      return cantripOsPowerStatusSchema.parse({
        target: null,
        observation: null,
        error:
          instance.transport.kind === "ssh"
            ? "SSH attachment does not provide a powered-off machine control path."
            : "No verified local Docker power target is recorded for this attachment.",
      });
    try {
      if (!(await this.repository.getWorker(ownerId, instance.workerId)))
        throw new Error("Owning Worker is unavailable.");
      const command = cantripOsPowerWorkerCommandSchema.parse({
        type: "cantrip-os.power.status",
        scope: {
          ownerId,
          serverId: this.serverId,
          workerId: instance.workerId,
          instanceId,
          guestInstanceId: instance.guestInstanceId,
          attachmentGeneration: instance.attachmentGeneration,
          runtimeGeneration: target.runtimeGeneration,
        },
        transport: instance.transport,
        powerTarget: {
          kind: "docker",
          generation: target.generation,
          containerId: target.containerId,
        },
      });
      const observation = cantripOsPowerObservationSchema.parse(
        await this.bridge.request(instance.workerId, command, { ownerId }),
      );
      if (observation.containerId !== target.containerId)
        throw new Error("Power status came from another container.");
      const { containerId: _id, ...publicState } = observation;
      return cantripOsPowerStatusSchema.parse({
        target: summary,
        observation: publicState,
        error: null,
      });
    } catch {
      return cantripOsPowerStatusSchema.parse({
        target: summary,
        observation: null,
        error:
          "The power carrier could not be observed. Check Worker diagnostics.",
      });
    }
  }
  async create(
    ownerId: string,
    instanceId: string,
    input: CantripOsPowerCreate,
  ) {
    const admitted = await this.repository.cantripOs.power.admit(
      ownerId,
      instanceId,
      this.serverId,
      input,
    );
    const row = admitted.created
      ? admitted.row
      : await this.repository.cantripOs.power.beginObservation(
          ownerId,
          instanceId,
          input.operationId,
        );
    return this.dispatch(ownerId, row, admitted.created);
  }
  async observe(ownerId: string, instanceId: string, operationId: string) {
    return this.dispatch(
      ownerId,
      await this.repository.cantripOs.power.beginObservation(
        ownerId,
        instanceId,
        operationId,
      ),
      false,
    );
  }
  async get(ownerId: string, instanceId: string, operationId: string) {
    const row = await this.repository.cantripOs.power.get(
      ownerId,
      instanceId,
      operationId,
    );
    if (!row) throw new CantripOsPlacementError("Power operation not found.");
    return powerSummary(row);
  }
  private async dispatch(
    ownerId: string,
    row: PowerOperationRow,
    execute: boolean,
  ) {
    try {
      if (!(await this.repository.getWorker(ownerId, row.workerId)))
        throw new Error("Owning Worker is unavailable.");
      const command = cantripOsPowerWorkerCommandSchema.parse({
        ...row.command,
        mode: execute ? "execute" : "observe",
      });
      const result = await this.bridge.request(row.workerId, command, {
        ownerId,
        timeoutMs: 180_000,
      });
      if (result === null)
        return powerSummary(
          await this.repository.cantripOs.power.unknown(ownerId, row),
        );
      return powerSummary(
        await this.repository.cantripOs.power.record(ownerId, row, result),
      );
    } catch {
      return powerSummary(
        await this.repository.cantripOs.power.unknown(ownerId, row),
      );
    }
  }
}
