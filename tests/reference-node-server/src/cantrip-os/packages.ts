import {
  cantripOsPackageStatusSchema,
  cantripOsPackageWorkerCommandSchema,
  type CantripOsPackageCreate,
  type CantripOsPackageControl,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import {
  packageScope,
  packageStatus,
  packageSummary,
  type PackageOperationRow,
} from "../db/repository/cantrip-os-packages.js";
import { CantripOsPlacementError } from "../db/repository/cantrip-os-error.js";

export class CantripOsPackageCoordinator {
  constructor(
    private readonly repository: Pick<
      ServerRepository,
      "cantripOs" | "getWorker"
    >,
    private readonly bridge: Pick<WorkerCommandBus, "request">,
    private readonly serverId: string,
  ) {}
  async status(ownerId: string, instanceId: string) {
    const context = await this.repository.cantripOs.packages.beginStatus(
      ownerId,
      instanceId,
    );
    try {
      if (
        !(await this.repository.getWorker(ownerId, context.instance.workerId))
      )
        throw new Error("Owning Worker is unavailable.");
      const command = cantripOsPackageWorkerCommandSchema.parse({
        type: "cantrip-os.packages.status",
        scope: packageScope(context.instance, this.serverId),
        transport: context.instance.transport,
        target: context.target.catalog?.target,
      });
      const raw = await this.bridge.request(
        context.instance.workerId,
        command,
        { ownerId, timeoutMs: 180_000 },
      );
      const target = await this.repository.cantripOs.packages.recordTarget(
        ownerId,
        context,
        raw,
      );
      return packageStatus(context.instance, target);
    } catch {
      return cantripOsPackageStatusSchema.parse({
        target: null,
        installed: [],
        available: [],
        unavailable: 0,
        error:
          "Package status could not be observed. Check the owning Worker's Docker/SSH connection; no installation was dispatched.",
      });
    }
  }
  async create(
    ownerId: string,
    instanceId: string,
    input: CantripOsPackageCreate,
  ) {
    const admitted = await this.repository.cantripOs.packages.admit(
      ownerId,
      instanceId,
      this.serverId,
      input,
    );
    const row = admitted.created
      ? admitted.row
      : await this.repository.cantripOs.packages.beginObservation(
          ownerId,
          instanceId,
          input.operationId,
        );
    return this.dispatch(
      ownerId,
      row,
      admitted.created ? "execute" : "observe",
    );
  }
  async observe(ownerId: string, instanceId: string, operationId: string) {
    return this.dispatch(
      ownerId,
      await this.repository.cantripOs.packages.beginObservation(
        ownerId,
        instanceId,
        operationId,
      ),
      "observe",
    );
  }
  async control(
    ownerId: string,
    instanceId: string,
    operationId: string,
    mode: "continue" | "abandon",
    input: CantripOsPackageControl,
  ) {
    return this.dispatch(
      ownerId,
      await this.repository.cantripOs.packages.beginObservation(
        ownerId,
        instanceId,
        operationId,
        input,
      ),
      mode,
    );
  }
  async get(ownerId: string, instanceId: string, operationId: string) {
    const row = await this.repository.cantripOs.packages.get(
      ownerId,
      instanceId,
      operationId,
    );
    if (!row) throw new CantripOsPlacementError("Package operation not found.");
    return packageSummary(row);
  }
  private async dispatch(
    ownerId: string,
    row: PackageOperationRow,
    mode: "execute" | "observe" | "continue" | "abandon",
  ) {
    if (row.state === "ready" || row.state === "failed")
      return packageSummary(row);
    try {
      if (!(await this.repository.getWorker(ownerId, row.workerId)))
        throw new Error("Owning Worker is unavailable.");
      const command = cantripOsPackageWorkerCommandSchema.parse({
        ...row.command,
        mode,
      });
      const result = await this.bridge.request(row.workerId, command, {
        ownerId,
        timeoutMs: 180_000,
      });
      return packageSummary(
        await this.repository.cantripOs.packages.record(ownerId, row, result),
      );
    } catch {
      return packageSummary(
        await this.repository.cantripOs.packages.unknown(ownerId, row),
      );
    }
  }
}
