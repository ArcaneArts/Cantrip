import { and, eq } from "drizzle-orm";
import {
  nativeCommandSessionSchema,
  type NativeHistoryBinding,
  type NativeHistoryResolve,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeHistoryError } from "./native-history-bindings.js";
import { findObservedNativeInputTurn } from "./native-command-turns.js";
import { retainManagedQueueInput } from "./managed-queue-input-snapshot.js";

export async function findNativeHistoryQueueAlias(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeHistoryBinding,
  item: NativeHistoryResolve["items"][number],
) {
  if (
    item.association.kind !== "queue-input" &&
    item.association.kind !== "queue-goal"
  )
    return null;
  const association = item.association;
  const [claim] = await tx
    .select()
    .from(schema.managedQueueClaims)
    .where(
      and(
        eq(schema.managedQueueClaims.id, association.claimId),
        eq(schema.managedQueueClaims.chatId, binding.chatId),
      ),
    );
  const operationId = claim?.awaitingGoal
    ? claim.goalOperationId
    : claim?.operationId;
  const operationGeneration = claim?.awaitingGoal
    ? claim.goalOperationGeneration
    : claim?.operationGeneration;
  if (
    !claim ||
    claim.status !== "consumed" ||
    claim.promptRevision !== association.promptRevision ||
    operationId !== association.operationId ||
    operationGeneration !== association.operationGeneration
  )
    throw new NativeHistoryError("queue-input-claim-mismatch");
  if (
    claim.awaitingGoal
      ? association.kind !== "queue-goal" ||
        item.identity.component !== "goal-request" ||
        item.identity.identityKind !== "canonical" ||
        item.identity.itemId !== claim.id
      : association.kind !== "queue-input" || item.identity.component !== "user"
  )
    throw new NativeHistoryError("queue-input-component-mismatch");
  const [command] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.operationId, association.operationId),
        eq(
          schema.nativeCommands.operationGeneration,
          association.operationGeneration,
        ),
        eq(schema.nativeCommands.ownerId, ownerId),
        eq(schema.nativeCommands.chatId, binding.chatId),
      ),
    );
  if (
    !command ||
    command.status !== "applied" ||
    !command.protectedResult ||
    !command.resultDigest
  )
    throw new NativeHistoryError("queue-input-command-unacknowledged");
  const session = nativeCommandSessionSchema.parse(command.identity);
  const turn = await findObservedNativeInputTurn(tx, command);
  if (
    !turn ||
    session.threadId !== binding.threadId ||
    session.chatId !== binding.chatId ||
    turn.chatId !== binding.chatId ||
    turn.threadId !== binding.threadId ||
    turn.turnId !== item.identity.turnId ||
    turn.runtimeGeneration !== session.runtimeGeneration ||
    (claim.nativeTurnId && claim.nativeTurnId !== turn.turnId)
  )
    throw new NativeHistoryError("queue-input-turn-mismatch");
  const [retained] = await tx
    .select()
    .from(schema.managedQueueInputSnapshots)
    .where(eq(schema.managedQueueInputSnapshots.claimId, claim.id));
  let snapshot = retained ?? null;
  if (!snapshot) {
    // Pre-upgrade claims can recover only while the exact original revision is
    // still present. A newer mutable queue draft is not historical evidence.
    const [prompt] = await tx
      .select()
      .from(schema.queuedPrompts)
      .where(
        and(
          eq(schema.queuedPrompts.id, claim.promptId),
          eq(schema.queuedPrompts.chatId, binding.chatId),
          eq(schema.queuedPrompts.revision, claim.promptRevision),
        ),
      );
    if (prompt) snapshot = await retainManagedQueueInput(tx, claim.id, prompt);
  }
  if (
    !snapshot ||
    snapshot.promptId !== claim.promptId ||
    snapshot.promptRevision !== claim.promptRevision
  )
    throw new NativeHistoryError("queue-input-revision-unavailable");
  const prompt = snapshot.protectedInput;
  if (
    prompt.pendingMessage.classification.role !== "user" ||
    (association.kind === "queue-input" &&
      association.clientUserMessageId !==
        (prompt.nativeClientUserMessageId ??
          `cantrip:${prompt.pendingMessage.id}`))
  )
    throw new NativeHistoryError("queue-input-client-id-mismatch");
  return prompt.pendingMessage;
}
