import { and, eq, or } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { NativeCommandAdmission } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeCommandError } from "./native-command-errors.js";
import { queueStateChanged } from "./native-command-queue.js";
import { QueuedPromptRepository } from "./queued-prompts.js";

/** Preserve a direct terminal source in the same transaction as admission. */
export async function retainTerminalInput(
  tx: RepositoryTransaction,
  ownerId: string,
  row: typeof schema.nativeCommands.$inferSelect,
  input: NativeCommandAdmission,
) {
  if (!input.retainedInput) return;
  const { prompt, attachments } = input.retainedInput;
  if (
    row.origin !== "terminal" ||
    row.kind !== "start" ||
    row.method !== "turn/start" ||
    input.queueClaim ||
    input.intent.expectedTurnId ||
    prompt.pendingMessage.classification.role !== "user" ||
    prompt.executionMethod !== "turn/start" ||
    prompt.nativeAction !== "literal" ||
    !prompt.protectedNativeInput ||
    !prompt.nativeClientUserMessageId ||
    prompt.nativeClientUserMessageId !==
      input.intent.nativeClientUserMessageId ||
    attachments.some((item) => item.chatId !== row.chatId) ||
    !isDeepStrictEqual(
      prompt.classification.attachmentIds,
      attachments.map((item) => item.id),
    )
  )
    throw new NativeCommandError("invalid-terminal-input");
  const [existing] = await tx
    .select({ id: schema.queuedPrompts.id })
    .from(schema.queuedPrompts)
    .where(
      and(
        eq(schema.queuedPrompts.chatId, row.chatId),
        or(
          eq(schema.queuedPrompts.id, prompt.id),
          eq(schema.queuedPrompts.idempotencyKey, prompt.idempotencyKey),
        ),
      ),
    );
  if (existing) throw new NativeCommandError("terminal-input-conflict");
  const saved = await new QueuedPromptRepository(
    tx,
  ).createEncryptedQueuedPrompt(ownerId, row.chatId, prompt, attachments);
  if (
    !saved ||
    saved.id !== prompt.id ||
    saved.revision !== 0 ||
    !["pendingMessage", "protectedContent", "protectedNativeInput"].every(
      (field) =>
        isDeepStrictEqual(
          saved[field as keyof typeof saved],
          prompt[field as keyof typeof prompt],
        ),
    )
  )
    throw new NativeCommandError("terminal-input-conflict");
  await tx
    .insert(schema.managedQueueStates)
    .values({ chatId: row.chatId })
    .onConflictDoNothing();
  await tx.insert(schema.managedQueueClaims).values({
    id: `terminal:${prompt.id}`,
    chatId: row.chatId,
    promptId: prompt.id,
    promptRevision: 0,
    operationId: row.operationId,
    operationGeneration: row.operationGeneration,
    status: "accepted",
  });
  await tx
    .update(schema.queuedPrompts)
    .set({ state: "claimed", updatedAt: new Date() })
    .where(eq(schema.queuedPrompts.id, prompt.id));
  await queueStateChanged(tx, row.chatId);
}
