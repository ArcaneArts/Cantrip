import { and, eq } from "drizzle-orm";
import {
  nativeCommandSessionSchema,
  nativeCommandAdmissionSchema,
  nativeCommandSettlementSchema,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeCommandError } from "./native-command-errors.js";

const historicalTerminalEvidence =
  nativeCommandSettlementSchema.shape.reconciliation.unwrap();

/** A restored observer sees the original native turn through a fresh
 * transport. Derive that observation from its server-stamped source without
 * inserting another canonical history owner for the same native turn. */
async function restoredObservation(
  tx: RepositoryTransaction,
  command: typeof schema.nativeCommands.$inferSelect,
) {
  if (
    !command.intent ||
    typeof command.intent !== "object" ||
    !("restoredSuspension" in command.intent)
  )
    return undefined;
  const intent = nativeCommandAdmissionSchema.shape.intent.parse(
    command.intent,
  );
  const restored = intent.restoredSuspension;
  if (!restored) return undefined;
  const session = nativeCommandSessionSchema.parse(command.identity);
  const [source] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.operationId, restored.source.operationId),
        eq(
          schema.nativeCommands.operationGeneration,
          restored.source.operationGeneration,
        ),
        eq(schema.nativeCommands.ownerId, command.ownerId),
        eq(schema.nativeCommands.workerId, command.workerId),
        eq(schema.nativeCommands.chatId, command.chatId),
      ),
    );
  const [canonical] = await tx
    .select()
    .from(schema.nativeCommandTurns)
    .where(
      eq(schema.nativeCommandTurns.operationId, restored.source.operationId),
    );
  const original = source && nativeCommandSessionSchema.parse(source.identity);
  if (
    !source ||
    !original ||
    !canonical ||
    command.kind !== "start" ||
    command.method !== "thread/resume" ||
    !command.previousOperationId ||
    !session.runtimeGeneration ||
    source.kind !== "start" ||
    source.logicalOperationId !== command.logicalOperationId ||
    source.executionLaneId !== command.executionLaneId ||
    canonical.chatId !== command.chatId ||
    canonical.threadId !== session.threadId ||
    canonical.threadId !== restored.checkpoint.threadId ||
    canonical.turnId !== restored.checkpoint.turnId ||
    original.threadId !== canonical.threadId ||
    canonical.runtimeGeneration !== original.runtimeGeneration
  )
    throw new NativeCommandError("native-restoration-provenance-mismatch");
  return {
    operationId: command.operationId,
    chatId: command.chatId,
    threadId: canonical.threadId,
    turnId: canonical.turnId,
    runtimeGeneration: session.runtimeGeneration,
  };
}

/** Upgrade recovery uses an already committed terminal receipt, never the
 * current activation's proposed turn ID. Caller holds the owning chat lock. */
export async function findObservedNativeCommandTurn(
  tx: RepositoryTransaction,
  command: typeof schema.nativeCommands.$inferSelect,
  options: { backfill?: boolean } = {},
) {
  const restored = await restoredObservation(tx, command);
  if (restored)
    return command.status === "applied" &&
      command.resultDigest &&
      command.protectedResult
      ? restored
      : undefined;
  const find = async () => {
    const [row] = await tx
      .select()
      .from(schema.nativeCommandTurns)
      .where(eq(schema.nativeCommandTurns.operationId, command.operationId));
    return row;
  };
  const existing = await find();
  if (existing) return existing;
  if (
    command.kind !== "start" ||
    command.status !== "applied" ||
    !command.executionCompletedAt
  )
    return undefined;
  const raw = command.terminalEvidence;
  if (
    !raw ||
    typeof raw !== "object" ||
    !("kind" in raw) ||
    (raw.kind !== "terminal" && raw.kind !== "native-terminal")
  )
    return undefined;
  const evidence = historicalTerminalEvidence.safeParse({
    nativeTurnId: "nativeTurnId" in raw ? raw.nativeTurnId : undefined,
    runtimeGeneration:
      "runtimeGeneration" in raw ? raw.runtimeGeneration : undefined,
  });
  const session = nativeCommandSessionSchema.safeParse(command.identity);
  if (
    !evidence.success ||
    !session.success ||
    !session.data.threadId ||
    session.data.runtimeGeneration !== evidence.data.runtimeGeneration
  )
    return undefined;
  // Candidate selection must compare all receipts before inserting a unique
  // native-turn owner. Otherwise conflicting old receipts surface as a database
  // constraint failure before the caller can report ambiguous provenance.
  if (options.backfill === false)
    return {
      operationId: command.operationId,
      chatId: command.chatId,
      threadId: session.data.threadId,
      turnId: evidence.data.nativeTurnId,
      runtimeGeneration: evidence.data.runtimeGeneration,
    };
  await rememberNativeCommandTurn(tx, command, evidence.data);
  return find();
}

/** Caller has verified the actual native evidence against its exact activation.
 * Run in that same admission/settlement transaction; never from a proposed ID. */
export async function rememberNativeCommandTurn(
  tx: RepositoryTransaction,
  command: typeof schema.nativeCommands.$inferSelect,
  evidence: { nativeTurnId: string; runtimeGeneration: string },
): Promise<void> {
  const session = nativeCommandSessionSchema.parse(command.identity);
  if (
    command.kind !== "start" ||
    !session.threadId ||
    session.runtimeGeneration !== evidence.runtimeGeneration
  )
    throw new NativeCommandError("native-turn-association-mismatch");
  const restored = await restoredObservation(tx, command);
  if (restored) {
    if (
      restored.turnId !== evidence.nativeTurnId ||
      restored.runtimeGeneration !== evidence.runtimeGeneration
    )
      throw new NativeCommandError("native-turn-association-conflict");
    return;
  }
  const saved = {
    operationId: command.operationId,
    chatId: command.chatId,
    threadId: session.threadId,
    turnId: evidence.nativeTurnId,
    runtimeGeneration: evidence.runtimeGeneration,
  };
  const [existing] = await tx
    .select()
    .from(schema.nativeCommandTurns)
    .where(eq(schema.nativeCommandTurns.operationId, command.operationId));
  if (existing) {
    if (
      existing.chatId !== saved.chatId ||
      existing.threadId !== saved.threadId ||
      existing.turnId !== saved.turnId ||
      existing.runtimeGeneration !== saved.runtimeGeneration
    )
      throw new NativeCommandError("native-turn-association-conflict");
    return;
  }
  await tx.insert(schema.nativeCommandTurns).values(saved);
}

/** A steer belongs to an already observed root activation; it must not create a
 * second root-turn ownership record or depend on the current activation. */
export async function findObservedNativeInputTurn(
  tx: RepositoryTransaction,
  command: typeof schema.nativeCommands.$inferSelect,
) {
  if (command.kind === "start")
    return findObservedNativeCommandTurn(tx, command);
  if (command.method !== "turn/steer" || !command.activationGeneration)
    return undefined;
  const intent = nativeCommandAdmissionSchema.shape.intent.parse(
    command.intent,
  );
  if (!intent.expectedTurnId) return undefined;
  const [root] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.chatId, command.chatId),
        eq(schema.nativeCommands.ownerId, command.ownerId),
        eq(schema.nativeCommands.workerId, command.workerId),
        eq(
          schema.nativeCommands.activationGeneration,
          command.activationGeneration,
        ),
        eq(schema.nativeCommands.kind, "start"),
      ),
    );
  if (!root) return undefined;
  const turn = await findObservedNativeCommandTurn(tx, root);
  return turn?.turnId === intent.expectedTurnId ? turn : undefined;
}
