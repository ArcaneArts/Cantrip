import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  cantripOsBackupOperationResultSchema,
  cantripOsBackupWorkerCommandSchema,
  type CantripOsBackupWorkerCommand,
} from "@cantrip/protocol/cantrip-os-backup-operations";
import type { CantripOsController } from "./controller.js";
import type { OsOperationRecord } from "./operations.js";
import type { BackupKeyAccess } from "./private-backup-file.js";
import { OsExecutorDeliveryError } from "./connection.js";
import { captureWorkspace } from "./backup-capture.js";
import { restoreWorkspace, rollbackWorkspace } from "./backup-restore.js";
import { protectBackupResult } from "./backup-result.js";
import {
  assertBackupAccount,
  backupCheckpointSchema,
  backupPorts,
  backupReceiptSchema,
  clearBackupStaging,
  privateBackupRequest,
  type BackupContext,
  type BackupPorts,
  type MutableBackupCommand,
} from "./backup-context.js";

/** Server-admitted, Worker-owned jobs. Recovery uses the retained admission and
 * actual guest/file receipts; it never creates a missing capture or reuploads an
 * uncertain receive. Explicit continuation activates only a known received job. */
export class CantripOsBackupManager {
  constructor(
    private readonly directory: string,
    private readonly workerId: string,
    private readonly controller: CantripOsController,
    private readonly keys: BackupKeyAccess,
    private readonly ports: BackupPorts = backupPorts,
  ) {}

  private context(
    record: OsOperationRecord,
    save: () => Promise<void>,
    mode: BackupContext["mode"],
  ): BackupContext {
    const checkpoint = backupCheckpointSchema.parse(record.checkpoint);
    const command = checkpoint.command;
    if (
      command.type === "cantrip-os.backup.observe" ||
      command.operationId !== record.operationId ||
      command.type !== record.command ||
      !isDeepStrictEqual(command.scope, record.scope) ||
      createHash("sha256")
        .update(JSON.stringify([command.type, command]))
        .digest("hex") !== record.admissionFingerprint
    )
      throw new Error("Stored backup admission has changed or is incomplete.");
    record.checkpoint = checkpoint;
    return {
      directory: this.directory,
      command,
      keys: this.keys,
      ports: this.ports,
      record,
      checkpoint,
      save,
      mode,
      assertCurrent: () =>
        this.controller.assertAdministrativeScope(
          command.transport,
          command.scope,
        ),
    };
  }

  private run(ctx: BackupContext) {
    switch (ctx.command.type) {
      case "cantrip-os.backup.capture":
        return captureWorkspace(ctx);
      case "cantrip-os.backup.restore":
        return restoreWorkspace(ctx);
      case "cantrip-os.backup.rollback":
        return rollbackWorkspace(ctx);
    }
  }

  private async result(
    action: "capture" | "restore" | "rollback",
    operationId: string,
    record: OsOperationRecord | null,
  ) {
    const receipt = record?.receipt
      ? backupReceiptSchema.parse(record.receipt)
      : null;
    const checkpoint = record?.checkpoint
      ? backupCheckpointSchema.parse(record.checkpoint)
      : null;
    if (receipt && receipt.action !== action)
      throw new Error("The backup result belongs to another action.");
    let protectedResult = receipt?.protectedResult ?? null;
    if (!protectedResult && record?.error) {
      try {
        protectedResult = await protectBackupResult(
          this.keys,
          record.scope,
          operationId,
          {
            action: "error",
            operationAction: action,
            message: record.error.slice(0, 8192),
          },
        );
      } catch {
        // Unavailable/revoked keys cannot erase an already recorded outcome.
        // Keep the redacted state observable without disclosing diagnostics.
      }
    }
    return cantripOsBackupOperationResultSchema.parse({
      operationId,
      action,
      state: record?.state ?? "unknown",
      phase: checkpoint?.phase ?? "recovery-required",
      startedAt: record?.startedAt ?? null,
      updatedAt: record?.updatedAt ?? new Date().toISOString(),
      protectedResult,
      error:
        record?.state === "ready" || record?.state === "running"
          ? null
          : "The backup operation is incomplete. Observe or recover its saved admission; uncertain mutations were not replayed.",
    });
  }

  async handle(raw: CantripOsBackupWorkerCommand) {
    const command = cantripOsBackupWorkerCommandSchema.parse(raw);
    if (command.scope.workerId !== this.workerId)
      throw new Error("The backup belongs to a different Worker.");
    assertBackupAccount(this.keys, command.scope);
    if (command.type === "cantrip-os.backup.observe") {
      const original = await this.controller.operations.inspect(
        command.scope,
        command.operationId,
      );
      if (
        original &&
        original.command !== `cantrip-os.backup.${command.action}`
      )
        throw new Error("The backup operation action changed.");
      const record = await this.controller.operations.reconcile(
        command.scope,
        command.operationId,
        async (record, save) => {
          await this.run(this.context(record, save, command.mode));
        },
      );
      return this.result(command.action, command.operationId, record);
    }
    await privateBackupRequest({ command, keys: this.keys });
    const action = command.type.slice("cantrip-os.backup.".length) as
      "capture" | "restore" | "rollback";
    const record = await this.controller.operations.execute(
      command.scope,
      command.operationId,
      command.type,
      command,
      async (record, save) => {
        const ctx = this.context(record, save, "new");
        try {
          const receipt = await this.run(ctx);
          if (!receipt)
            throw new OsExecutorDeliveryError(
              "Guest operation did not return a completed receipt.",
            );
          return receipt;
        } catch (error) {
          if (!["admitted", "verifying"].includes(ctx.checkpoint.phase)) {
            const unknown = new OsExecutorDeliveryError(
              "The admitted guest operation requires observation or recovery: " +
                (error instanceof Error ? error.message : "unknown failure"),
            );
            unknown.cause = error;
            throw unknown;
          }
          if (ctx.command.type === "cantrip-os.backup.restore") {
            try {
              await clearBackupStaging(ctx);
            } catch {
              throw new Error(
                (error instanceof Error
                  ? error.message
                  : "Restore verification failed.") +
                  " Worker restore staging cleanup could not be confirmed.",
                { cause: error },
              );
            }
          }
          throw error;
        }
      },
      { version: 1, command, phase: "admitted" },
    );
    return this.result(action, command.operationId, record);
  }
}
