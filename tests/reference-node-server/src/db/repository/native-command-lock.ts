import { and, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { projectChatExecutionLock } from "./chat-execution-lock.js";
import { NativeCommandError } from "./native-command-errors.js";

/** All command and settings writers acquire project -> chat -> command locks. */
export async function lockNativeCommandChat(
  tx: RepositoryTransaction,
  ownerId: string,
  chatId: string,
): Promise<void> {
  await tx.execute(projectChatExecutionLock(ownerId, chatId));
  const [chat] = await tx
    .select({ id: schema.chats.id })
    .from(schema.chats)
    .where(and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)))
    .for("update")
    .limit(1);
  if (!chat)
    throw new NativeCommandError("chat-not-found", "Chat not found.", 404);
}
