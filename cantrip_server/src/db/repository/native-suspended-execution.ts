import { eq } from "drizzle-orm";
import type { NativeCommandSession } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { readNativeCommand } from "./native-command-context.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import { NativeSuspensionRepository } from "./native-suspensions.js";

type Command = typeof schema.nativeCommands.$inferSelect;

/** Actual committed recovery state retains an unfinished execution. A closed
 * transport is not native terminal evidence and cannot settle this root. */
export async function retainedNativeSuspension(
  repository: NativeSuspensionRepository,
  ownerId: string,
  row: Command,
) {
  const state = await repository.read(ownerId, row.chatId);
  const identity = row.identity as NativeCommandSession;
  const proof = row.terminalEvidence as Record<string, unknown> | null;
  const terminalProof =
    proof?.kind === "terminal" &&
    typeof proof.terminalStatus === "string" &&
    ["completed", "failed", "interrupted"].includes(proof.terminalStatus) &&
    proof.nativeTurnId === state?.active?.turnId &&
    proof.runtimeGeneration === identity.runtimeGeneration;
  return state?.checkpoint &&
    state.active &&
    state.actor &&
    !terminalProof &&
    !["running", "stopped", "completed", "failed", "idle"].includes(
      state.phase,
    ) &&
    row.kind === "start" &&
    state.target.workerId === row.workerId &&
    state.target.originalOperationId === row.operationId &&
    state.target.executionLaneId === row.executionLaneId &&
    state.active.threadId === identity.threadId &&
    state.actor.runtimeGeneration === identity.runtimeGeneration
    ? state
    : null;
}

export class NativeSuspendedExecutionRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async read(
    ownerId: string,
    workerId: string,
    operationId: string,
    operationGeneration: string,
  ) {
    return this.database.transaction(async (tx) => {
      const captured = await readNativeCommand(
        tx,
        ownerId,
        workerId,
        operationId,
        operationGeneration,
      );
      await lockNativeCommandChat(tx, ownerId, captured.chatId);
      const row = await readNativeCommand(
        tx,
        ownerId,
        workerId,
        operationId,
        operationGeneration,
      );
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
      if (
        !activation?.active ||
        activation.workerId !== workerId ||
        activation.executionLaneId !== row.executionLaneId
      )
        return null;
      const [head] = await tx
        .select()
        .from(schema.nativeCommands)
        .where(eq(schema.nativeCommands.operationId, activation.operationId));
      if (
        !head ||
        head.ownerId !== ownerId ||
        head.workerId !== workerId ||
        head.chatId !== row.chatId ||
        head.activationGeneration !== activation.generation ||
        head.executionLaneId !== row.executionLaneId ||
        (head.operationId !== row.operationId &&
          !(
            row.logicalOperationId === row.operationId &&
            head.logicalOperationId === row.operationId
          ))
      )
        return null;
      return retainedNativeSuspension(
        new NativeSuspensionRepository(this.database).inTransaction(tx),
        ownerId,
        head,
      );
    });
  }
}
