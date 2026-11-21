import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  cantripOsDesktopOperationResultSchema,
  cantripOsDesktopReceiptSchema,
  cantripOsDesktopWorkerCommandSchema,
  cantripOsGuestDesktopResultSchema,
  cantripOsGuestDesktopTargetSchema,
  type CantripOsDesktopWorkerCommand,
  type CantripOsDesktopScope,
  type CantripOsDesktopOperationResult,
  type CantripOsGuestDesktopTarget,
} from "@cantrip/protocol";
import { OsExecutorDeliveryError } from "./connection.js";
import { OsOperationStore, type OsOperationRecord } from "./operations.js";
import type { DesktopDriver } from "./desktop-driver.js";

type Operation = Extract<
  CantripOsDesktopWorkerCommand,
  { type: "cantrip-os.desktop.operation" }
>;
const admission = (command: Operation) => ({
  action: command.action,
  targetGeneration: command.targetGeneration,
  desktopTarget: command.desktopTarget,
  transport: command.transport,
});
function assertAccount(
  scope: CantripOsDesktopScope,
  target: CantripOsGuestDesktopTarget,
) {
  if (
    target.id !== scope.guestWorkspaceId ||
    target.user !== `ctw-${scope.guestWorkspaceId}` ||
    target.uid !== scope.uid ||
    target.gid !== scope.gid ||
    target.home !== scope.homeGuestPath ||
    (target.status === "running" && target.desktop_generation === null)
  )
    throw new Error(
      "The observed desktop does not match its admitted workspace.",
    );
}
function guestRequest(command: Operation) {
  const scope = command.scope;
  const scopeKey = createHash("sha256")
    .update(
      JSON.stringify([
        scope.serverId,
        scope.ownerId,
        scope.workerId,
        scope.instanceId,
        scope.guestInstanceId,
        scope.attachmentGeneration,
        scope.runtimeGeneration,
        scope.workspaceId,
        scope.guestWorkspaceId,
        scope.uid,
        scope.gid,
        scope.homeGuestPath,
        command.targetGeneration,
      ]),
    )
    .digest("hex");
  return {
    operation_id: command.operationId,
    action: command.action,
    scope_key: scopeKey,
    target: command.desktopTarget,
  };
}
function requestedState(
  command: Operation,
  actual: CantripOsGuestDesktopTarget,
) {
  const before = command.desktopTarget;
  if (
    !["id", "user", "uid", "gid", "home", "display"].every(
      (key) => Reflect.get(before, key) === Reflect.get(actual, key),
    )
  )
    return false;
  const sameGeneration =
    before.generation === actual.generation &&
    before.desktop_generation === actual.desktop_generation;
  if (command.action === "stop")
    return actual.status === "stopped" && sameGeneration;
  if (actual.status !== "running" || !actual.desktop_generation) return false;
  return command.action === "start" && before.status === "running"
    ? sameGeneration
    : actual.generation > before.generation &&
        actual.desktop_generation !== before.desktop_generation;
}
function guestResult(command: Operation, raw: unknown) {
  const result = cantripOsGuestDesktopResultSchema.parse(raw);
  if (!isDeepStrictEqual(result.request, guestRequest(command)))
    throw new Error("The desktop receipt belongs to another admission.");
  if (result.state === "ready") {
    if (
      result.error !== null ||
      !result.receipt ||
      !isDeepStrictEqual(result.receipt.before, command.desktopTarget) ||
      !requestedState(command, result.receipt.after)
    )
      throw new Error(
        "The desktop receipt does not prove its requested state.",
      );
  } else if (result.receipt !== null)
    throw new Error("The desktop result has a conflicting receipt.");
  return result;
}
function receipt(command: Operation, result: ReturnType<typeof guestResult>) {
  if (result.state !== "ready" || !result.receipt)
    throw new Error("Desktop completion is unavailable.");
  return cantripOsDesktopReceiptSchema.parse({
    targetGeneration: command.targetGeneration,
    before: result.receipt.before,
    after: result.receipt.after,
    completionEvidence: result.receipt.completion,
  });
}

/** The Server supplies immutable authority. The guest journal is the durable
 * desktop effect receipt; a restarted Worker observes it without another execute. */
export class CantripOsDesktopManager {
  readonly operations: OsOperationStore;
  constructor(
    directory: string,
    private readonly workerId: string,
    private readonly driver: DesktopDriver,
  ) {
    this.operations = new OsOperationStore(directory);
  }
  private async current(command: CantripOsDesktopWorkerCommand) {
    const target = cantripOsGuestDesktopTargetSchema.parse(
      await this.driver.run(command, [
        "desktop-target",
        command.scope.guestWorkspaceId,
      ]),
    );
    assertAccount(command.scope, target);
    return target;
  }
  private async observe(command: Operation) {
    const result = await this.driver.run(command, [
      "desktop-observe",
      JSON.stringify(guestRequest(command)),
    ]);
    return result === null ? null : guestResult(command, result);
  }
  async handle(
    input: Extract<
      CantripOsDesktopWorkerCommand,
      { type: "cantrip-os.desktop.status" }
    >,
  ): Promise<CantripOsGuestDesktopTarget>;
  async handle(
    input: Operation,
  ): Promise<CantripOsDesktopOperationResult | null>;
  async handle(
    input: CantripOsDesktopWorkerCommand,
  ): Promise<
    CantripOsGuestDesktopTarget | CantripOsDesktopOperationResult | null
  >;
  async handle(input: CantripOsDesktopWorkerCommand) {
    const command = cantripOsDesktopWorkerCommandSchema.parse(input);
    if (command.scope.workerId !== this.workerId)
      throw new Error("The desktop command belongs to another Worker.");
    if (command.type === "cantrip-os.desktop.status")
      return this.current(command);
    assertAccount(command.scope, command.desktopTarget);
    let record = await this.operations.inspect(
      command.scope,
      command.operationId,
    );
    if (record) {
      const checkpoint = record.checkpoint as
        { version: number; admission: unknown } | undefined;
      if (
        record.command !== command.type ||
        !isDeepStrictEqual(record.scope, command.scope) ||
        checkpoint?.version !== 1 ||
        !isDeepStrictEqual(checkpoint.admission, admission(command))
      )
        throw new Error(
          "The saved desktop operation belongs to another admission.",
        );
      if (!["ready", "failed"].includes(record.state)) {
        record = await this.operations.reconcile(
          command.scope,
          command.operationId,
          async (saved) => {
            const result = await this.observe(command);
            if (!result) {
              saved.error =
                "The guest desktop journal is unavailable. No operation was replayed.";
            } else if (result.state === "ready") {
              saved.state = "ready";
              saved.receipt = receipt(command, result);
              saved.error = null;
            } else if (result.state === "failed") {
              saved.state = "failed";
              saved.error = result.error;
            } else saved.error = result.error;
          },
        );
      }
    } else if (command.mode === "execute") {
      record = await this.operations.execute(
        command.scope,
        command.operationId,
        command.type,
        admission(command),
        async (saved, save) => {
          const hooks: NonNullable<Parameters<DesktopDriver["run"]>[2]> = {
            opened: async (binding, sessionId) => {
              saved.native = { binding, sessionId };
              await save();
            },
            prepared: async (processId, argv) => {
              saved.processes.push({ processId, argv });
              await save();
            },
          };
          const raw = await this.driver.run(
            command,
            ["desktop-execute", JSON.stringify(guestRequest(command))],
            hooks,
          );
          let result: ReturnType<typeof guestResult>;
          try {
            result = guestResult(command, raw);
          } catch (cause) {
            const error = new OsExecutorDeliveryError(
              "The desktop returned an unverified outcome; observe its original admission.",
            );
            error.cause = cause;
            throw error;
          }
          saved.checkpoint = {
            version: 1,
            admission: admission(command),
            guest: result,
          };
          await save();
          if (result.state !== "ready") {
            const message = result.error ?? "The desktop outcome is uncertain.";
            throw result.state === "failed"
              ? new Error(message)
              : new OsExecutorDeliveryError(message);
          }
          return receipt(command, result);
        },
        { version: 1, admission: admission(command) },
      );
    } else {
      // A missing local cache cannot authorize execute. The Server's original
      // command can still read its exact guest journal; no record is fabricated.
      const result = await this.observe(command);
      if (!result) return null;
      return cantripOsDesktopOperationResultSchema.parse({
        operationId: command.operationId,
        action: command.action,
        startedAt: result.started_at,
        updatedAt: result.updated_at,
        state:
          result.state === "ready"
            ? "ready"
            : result.state === "failed"
              ? "failed"
              : "unknown",
        error: result.state === "ready" ? null : result.error,
        receipt: result.state === "ready" ? receipt(command, result) : null,
        ...(await this.observation(command)),
      });
    }
    if (!record) return null;
    return this.result(command, record);
  }
  private async observation(command: CantripOsDesktopWorkerCommand) {
    try {
      return {
        observation: await this.current(command),
        observationError: null,
      };
    } catch {
      return {
        observation: null,
        observationError:
          "The captured desktop could not be observed. Its saved outcome remains separate.",
      };
    }
  }
  private async result(command: Operation, record: OsOperationRecord) {
    return cantripOsDesktopOperationResultSchema.parse({
      operationId: command.operationId,
      action: command.action,
      state: record.state,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      error:
        record.state === "ready"
          ? null
          : (record.error?.slice(0, 4000) ?? null),
      receipt:
        record.state === "ready"
          ? cantripOsDesktopReceiptSchema.parse(record.receipt)
          : null,
      ...(await this.observation(command)),
    });
  }
}
