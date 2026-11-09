import { and, eq } from "drizzle-orm";
import type { NativeTurnRecoveryObservation } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import type { NativeCommandRepository } from "./native-commands.js";
import { nativeCommandContext } from "./native-command-context.js";
import { nativeCommandReceipt as receipt } from "./native-command-receipt.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import { NativeCommandError } from "./native-command-errors.js";

/** Terminal evidence from a replacement runtime settles only the captured writer. */
export class NativeCommandRecoveryRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly commands: Pick<
      NativeCommandRepository,
      "settle" | "controlContext"
    >,
  ) {}
  /** Capture the exact old writer before asking its worker to resume/read. */
  async recoveryContext(ownerId: string, chatId: string) {
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, chatId);
      const context = await nativeCommandContext(tx, ownerId, chatId);
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, chatId));
      if (
        !context ||
        !activation?.active ||
        !activation.nativeTurnId ||
        !activation.runtimeGeneration ||
        activation.executionLaneId !== context.executionLaneId
      )
        return null;
      const [operation] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(
          and(
            eq(schema.nativeCommands.operationId, activation.operationId),
            eq(schema.nativeCommands.ownerId, ownerId),
          ),
        );
      if (!operation || operation.kind !== "start") return null;
      return {
        receipt: receipt(operation),
        threadId: context.threadId,
        turnId: activation.nativeTurnId,
        runtimeGeneration: activation.runtimeGeneration,
      };
    });
  }

  /** A replacement runtime must actually read the old turn as terminal. A
   * disconnected socket, changed process ID, or empty history is insufficient. */
  async recoverExecution(
    ownerId: string,
    workerId: string,
    expected: NonNullable<
      Awaited<ReturnType<NativeCommandRecoveryRepository["recoveryContext"]>>
    >,
    observed: NativeTurnRecoveryObservation,
  ) {
    if (
      expected.threadId !== observed.threadId ||
      expected.turnId !== observed.turnId ||
      expected.runtimeGeneration === observed.runtimeGeneration ||
      !observed.status ||
      observed.status === "inProgress"
    )
      return false;
    try {
      await this.commands.settle(ownerId, {
        workerId,
        operationId: expected.receipt.operationId,
        operationGeneration: expected.receipt.operationGeneration,
        status: "applied",
        resultDigest: null,
        protectedResult: null,
        rejectionCode: null,
        executionComplete: true,
        executionStatus: observed.status === "failed" ? "failed" : "idle",
        reconciliation: {
          nativeTurnId: observed.turnId,
          runtimeGeneration: expected.runtimeGeneration,
        },
      });
      return true;
    } catch (error) {
      // Concurrent completion or a new turn owns its own lifecycle. Never
      // retire that successor using the captured activation's observation.
      if (
        error instanceof NativeCommandError &&
        error.code === "stale-native-evidence"
      )
        return false;
      if (
        error instanceof NativeCommandError &&
        error.code === "receipt-conflict"
      ) {
        const current = await this.commands.controlContext(
          ownerId,
          expected.receipt.chatId,
        );
        if (
          current.activationGeneration !== expected.receipt.activationGeneration
        )
          return false;
      }
      throw error;
    }
  }
}
