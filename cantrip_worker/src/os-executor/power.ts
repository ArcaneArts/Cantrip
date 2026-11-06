import { isDeepStrictEqual } from "node:util";
import {
  cantripOsPowerObservationSchema,
  cantripOsPowerOperationResultSchema,
  cantripOsPowerReceiptSchema,
  type CantripOsPowerWorkerCommand,
  type CantripOsPowerObservation,
} from "@cantrip/protocol";
import {
  LocalDocker,
  DockerDeliveryError,
  changeRetainedContainer,
  observeRetainedContainer,
  withInstanceLock,
  type RetainedContainerResult,
} from "@cantrip/os-host";
import { OsOperationStore, type OsOperationRecord } from "./operations.js";

type Operation = Extract<
  CantripOsPowerWorkerCommand,
  { type: "cantrip-os.power.operation" }
>;
type Engine = Pick<LocalDocker, "request" | "inspect">;
const admission = (command: Operation) => ({
  action: command.action,
  transport: command.transport,
  powerTarget: command.powerTarget,
});
function observation(raw: unknown) {
  return cantripOsPowerObservationSchema.strip().parse(raw);
}
function receipt(command: Operation, result: RetainedContainerResult) {
  if (
    result.operation.state !== "ready" ||
    !result.operation.before ||
    !result.operation.after
  )
    throw new Error("The retained transition has no verified receipt.");
  return cantripOsPowerReceiptSchema.parse({
    targetGeneration: command.powerTarget.generation,
    containerId: command.powerTarget.containerId,
    before: observation(result.operation.before),
    after: observation(result.operation.after),
    completionEvidence: result.operation.completionEvidence,
  });
}
export class CantripOsPowerManager {
  readonly operations: OsOperationStore;
  constructor(
    directory: string,
    private readonly workerId: string,
    private readonly engine: () => Promise<Engine> = () =>
      LocalDocker.current(),
  ) {
    this.operations = new OsOperationStore(directory);
  }
  private async current(engine: Engine, command: CantripOsPowerWorkerCommand) {
    const actual = await engine.inspect<{
      Id: string;
      State: {
        Running: boolean;
        Status: string;
        StartedAt: string;
        FinishedAt: string;
      };
    }>(command.transport.container);
    if (actual.Id !== command.powerTarget.containerId)
      throw new Error(
        "The retained Docker target was replaced. No replacement was selected.",
      );
    return observation({
      containerId: actual.Id,
      running: actual.State.Running,
      status: actual.State.Status,
      startedAt: actual.State.StartedAt,
      finishedAt: actual.State.FinishedAt,
    });
  }
  async handle(command: CantripOsPowerWorkerCommand) {
    if (command.scope.workerId !== this.workerId)
      throw new Error("Power command belongs to another Worker.");
    let engine: Engine | undefined;
    const carrier = async () => (engine ??= await this.engine());
    if (command.type === "cantrip-os.power.status")
      return this.current(await carrier(), command);
    return withInstanceLock(command.transport.container, async () => {
      let record: OsOperationRecord | null;
      if (command.mode === "execute") {
        record = await this.operations.execute(
          command.scope,
          command.operationId,
          command.type,
          admission(command),
          async (record, save, journalPath) => {
            record.checkpoint = {
              version: 1,
              admission: admission(command),
              journalPath,
            };
            await save();
            const result = await changeRetainedContainer(await carrier(), {
              operationId: command.operationId,
              action: command.action,
              container: command.transport.container,
              expectedContainerId: command.powerTarget.containerId,
              journalPath,
            });
            if (result.operation.state !== "ready") {
              const message =
                result.operation.error ??
                "The retained transition is not verified.";
              throw result.operation.state === "failed"
                ? new Error(message)
                : new DockerDeliveryError(message);
            }
            return receipt(command, result);
          },
          { version: 1, admission: admission(command) },
        );
      } else {
        const saved = await this.operations.inspect(
          command.scope,
          command.operationId,
        );
        if (!saved) return null;
        const checkpoint = saved.checkpoint as
          | { version: number; admission: unknown; journalPath?: string }
          | undefined;
        if (
          saved.command !== command.type ||
          checkpoint?.version !== 1 ||
          !isDeepStrictEqual(checkpoint.admission, admission(command))
        )
          throw new Error(
            "The saved power operation belongs to another admission.",
          );
        record = await this.operations.reconcile(
          command.scope,
          command.operationId,
          async (record) => {
            if (!checkpoint.journalPath) {
              record.error =
                "No retained carrier admission is available. No operation was replayed.";
              return;
            }
            const result = await observeRetainedContainer(await carrier(), {
              operationId: command.operationId,
              action: command.action,
              container: command.transport.container,
              expectedContainerId: command.powerTarget.containerId,
              journalPath: checkpoint.journalPath,
            });
            if (!result) {
              record.error =
                "The retained carrier journal is unavailable. No operation was replayed.";
              return;
            }
            if (result.operation.state === "ready") {
              record.state = "ready";
              record.receipt = receipt(command, result);
              record.error = null;
            } else if (result.operation.state === "failed") {
              record.state = "failed";
              record.error = result.operation.error;
            } else record.error = result.operation.error;
          },
        );
      }
      if (!record) return null;
      let current: CantripOsPowerObservation | null = null,
        observationError: string | null = null;
      try {
        current = await this.current(await carrier(), command);
      } catch {
        observationError = "The retained Docker target could not be observed.";
      }
      return cantripOsPowerOperationResultSchema.parse({
        operationId: command.operationId,
        action: command.action,
        state: record.state,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        error:
          record.state === "ready"
            ? null
            : record.error
              ? record.state === "unknown"
                ? "Power delivery is unknown; observe the original admission before continuing."
                : "The power operation failed. Inspect Worker diagnostics."
              : null,
        receipt:
          record.state === "ready"
            ? cantripOsPowerReceiptSchema.parse(record.receipt)
            : null,
        observation: current,
        observationError,
      });
    });
  }
}
