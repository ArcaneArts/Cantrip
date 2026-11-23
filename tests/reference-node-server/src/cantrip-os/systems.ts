import {
  cantripOsObservedInstanceSchema,
  cantripOsSystemStatusSchema,
  cantripOsSystemStatusResultSchema,
  cantripOsSystemWorkerCommandSchema,
  workerCommandSchema,
  type CantripOsSystemCreate,
  type CantripOsSystemControl,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import { WorkerCommandNotSentError } from "../workers/bridge.js";
import {
  systemScope,
  systemStatus,
  systemSummary,
  systemInstanceSummary,
  systemFail,
  type SystemOperationRow,
} from "../db/repository/cantrip-os-system-common.js";

export class CantripOsSystemCoordinator {
  constructor(
    private readonly repository: Pick<
      ServerRepository,
      "cantripOs" | "getWorker"
    >,
    private readonly bridge: Pick<WorkerCommandBus, "request">,
    private readonly serverId: string,
  ) {}
  async status(ownerId: string, instanceId: string) {
    const context = await this.repository.cantripOs.systems.beginStatus(
      ownerId,
      instanceId,
    );
    try {
      if (
        !(await this.repository.getWorker(ownerId, context.instance.workerId))
      )
        throw new Error("Owning Worker is unavailable.");
      const command = cantripOsSystemWorkerCommandSchema.parse({
        type: "cantrip-os.system.status",
        scope: systemScope(context.instance, this.serverId),
        transport: context.instance.transport,
        target: context.target.catalog?.target ?? undefined,
      });
      const value = await this.bridge.request(
        context.instance.workerId,
        command,
        { ownerId, timeoutMs: 180_000 },
      );
      const target = await this.repository.cantripOs.systems.recordTarget(
        ownerId,
        context,
        value,
      );
      return systemStatus(context.instance, target);
    } catch {
      return cantripOsSystemStatusSchema.parse({
        supported: context.instance.transport.kind === "docker",
        target: null,
        bases: [],
        error:
          "System status could not be observed. Check the owning Worker's Docker management connection; no system transition was dispatched.",
      });
    }
  }
  async create(
    ownerId: string,
    instanceId: string,
    input: CantripOsSystemCreate,
  ) {
    const { row, created } = await this.repository.cantripOs.systems.admit(
      ownerId,
      instanceId,
      this.serverId,
      input,
    );
    return this.dispatch(
      ownerId,
      created
        ? row
        : await this.repository.cantripOs.systems.beginObservation(
            ownerId,
            instanceId,
            row.operationId,
          ),
      created ? "execute" : "observe",
    );
  }
  async observe(ownerId: string, instanceId: string, operationId: string) {
    return this.dispatch(
      ownerId,
      await this.repository.cantripOs.systems.beginObservation(
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
    input: CantripOsSystemControl,
  ) {
    return this.dispatch(
      ownerId,
      await this.repository.cantripOs.systems.beginObservation(
        ownerId,
        instanceId,
        operationId,
        input,
      ),
      "continue",
    );
  }
  async get(ownerId: string, instanceId: string, operationId: string) {
    const row = await this.repository.cantripOs.systems.get(
      ownerId,
      instanceId,
      operationId,
    );
    if (!row) return systemFail("System operation not found.");
    return systemSummary(row);
  }
  private async dispatch(
    ownerId: string,
    row: SystemOperationRow,
    mode: "execute" | "observe" | "continue",
  ): Promise<ReturnType<typeof systemSummary>> {
    if (
      row.state === "ready" ||
      row.state === "failed" ||
      row.state === "rejected"
    )
      return systemSummary(row);
    try {
      if (!(await this.repository.getWorker(ownerId, row.workerId)))
        throw new WorkerCommandNotSentError("Owning Worker is unavailable.");
      const effectiveMode: "continue" | "observe" =
        mode === "observe" ? "observe" : "continue";
      if (mode !== "observe" && row.dispatchStage === "preparing") {
        const prepared = await this.bridge.request(
          row.workerId,
          cantripOsSystemWorkerCommandSchema.parse({
            ...row.command,
            mode: "prepare",
          }),
          { ownerId, timeoutMs: 180_000 },
        );
        row = await this.repository.cantripOs.systems.record(
          ownerId,
          row,
          prepared,
        );
        if (
          row.state === "ready" ||
          row.state === "failed" ||
          row.state === "rejected"
        )
          return systemSummary(row);
        const execution =
          await this.repository.cantripOs.systems.beginExecution(ownerId, row);
        row = execution.row;
        if (!execution.created) return this.dispatch(ownerId, row, "observe");
      }
      const command = cantripOsSystemWorkerCommandSchema.parse({
        ...row.command,
        mode: effectiveMode,
      });
      const result = await this.bridge.request(row.workerId, command, {
        ownerId,
        timeoutMs: 180_000,
      });
      return systemSummary(
        await this.repository.cantripOs.systems.record(ownerId, row, result),
      );
    } catch (error) {
      return systemSummary(
        await (mode !== "observe" &&
        row.dispatchStage === "preparing" &&
        error instanceof WorkerCommandNotSentError
          ? this.repository.cantripOs.systems.reject(ownerId, row)
          : this.repository.cantripOs.systems.unknown(ownerId, row)),
      );
    }
  }
  async abandon(
    ownerId: string,
    instanceId: string,
    operationId: string,
    input: CantripOsSystemControl,
  ) {
    const row = await this.repository.cantripOs.systems.beginObservation(
      ownerId,
      instanceId,
      operationId,
      input,
    );
    const closed = await this.repository.cantripOs.systems.reject(ownerId, row);
    if (closed.state !== "rejected")
      return systemFail(
        "System execution was already dispatched; observe its original outcome instead.",
      );
    return systemSummary(closed);
  }
  async recover(
    ownerId: string,
    instanceId: string,
    operationId: string,
    input: CantripOsSystemControl,
  ) {
    const context = await this.repository.cantripOs.systems.beginRecovery(
      ownerId,
      instanceId,
      operationId,
      input,
    );
    if (context.recovered) return systemInstanceSummary(context.instance);
    if (!(await this.repository.getWorker(ownerId, context.instance.workerId)))
      return systemFail("Owning Worker is unavailable.");
    const operation = context.operation,
      command = cantripOsSystemWorkerCommandSchema.parse({
        type: "cantrip-os.system.status",
        scope: systemScope(context.instance, this.serverId),
        transport: context.instance.transport,
        target: operation.command.target,
        recovery: {
          operationId: operation.operationId,
          scope: operation.command.scope,
          targetGeneration: operation.targetGeneration,
        },
      });
    let raw = cantripOsSystemStatusResultSchema.parse(
      await this.bridge.request(operation.workerId, command, {
        ownerId,
        timeoutMs: 180_000,
      }),
    );
    if (raw.enrollment) {
      // Inspect the exact completed physical root before assigning an unattached
      // guest. On a lost assignment reply, observation sees the same owned tuple;
      // no second enrollment is sent. Final raw discovery also checks canonical ID.
      if (
        raw.enrollment.containerId !== operation.result!.root!.targetContainerId
      )
        return systemFail(
          "The enrollment candidate differs from the completed physical root.",
        );
      const transport = {
        kind: "docker" as const,
        container: raw.enrollment.containerId,
      };
      const observed = cantripOsObservedInstanceSchema.parse(
        await this.bridge.request(
          operation.workerId,
          workerCommandSchema.parse({
            type: "cantrip-os.inspect",
            ownerId,
            workerId: operation.workerId,
            transport,
          }),
          { ownerId, timeoutMs: 180_000 },
        ),
      );
      if (observed.guestInstanceId !== raw.enrollment.guestInstanceId)
        return systemFail("The enrollment candidate's guest identity changed.");
      if (
        observed.attachment &&
        (observed.attachment.ownerId !== ownerId ||
          observed.attachment.workerId !== operation.workerId)
      )
        return systemFail(
          "The resulting system belongs to another attachment.",
        );
      if (!observed.attachment)
        await this.bridge.request(
          operation.workerId,
          workerCommandSchema.parse({
            type: "cantrip-os.attach",
            transport,
            scope: {
              ...systemScope(context.instance, this.serverId),
              guestInstanceId: observed.guestInstanceId,
              runtimeGeneration: observed.runtimeGeneration,
            },
          }),
          { ownerId, timeoutMs: 180_000 },
        );
      raw = cantripOsSystemStatusResultSchema.parse(
        await this.bridge.request(operation.workerId, command, {
          ownerId,
          timeoutMs: 180_000,
        }),
      );
    }
    const instance = await this.repository.cantripOs.systems.adopt(
      ownerId,
      context,
      raw,
    );
    return systemInstanceSummary(instance);
  }
}
