import { and, asc, eq, or } from "drizzle-orm";
import {
  nativeHistoryTurnReadRequestSchema,
  nativeHistoryTurnReadResponseSchema,
  type NativeHistoryTurnReadRequest,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { NativeHistoryError } from "./native-history-bindings.js";

/** Account-authorized archive read only. No worker, live binding or runtime is
 * required to inspect this owner's already committed encrypted turn history. */
export async function readChatNativeHistoryTurns(
  database: RepositoryDatabase,
  ownerId: string,
  chatId: string,
  raw: NativeHistoryTurnReadRequest,
) {
  const input = nativeHistoryTurnReadRequestSchema.parse(raw);
  return database.transaction(async (tx) => {
    const [chat] = await tx
      .select({ id: schema.chats.id })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      );
    if (!chat) throw new NativeHistoryError("chat-not-found", 404);
    if (!input.turns.length) return { chatId, turns: [] };
    const rows = await tx
      .select({
        bindingId: schema.nativeHistoryBindings.id,
        workerId: schema.nativeHistoryBindings.workerId,
        threadId: schema.nativeHistoryBindings.threadId,
        turn: schema.nativeHistoryTurns,
      })
      .from(schema.nativeHistoryTurns)
      .innerJoin(
        schema.nativeHistoryBindings,
        eq(
          schema.nativeHistoryBindings.id,
          schema.nativeHistoryTurns.bindingId,
        ),
      )
      .where(
        and(
          eq(schema.nativeHistoryBindings.ownerId, ownerId),
          eq(schema.nativeHistoryBindings.chatId, chatId),
          or(
            ...input.turns.map((turn) =>
              and(
                eq(schema.nativeHistoryBindings.threadId, turn.threadId),
                eq(schema.nativeHistoryTurns.turnId, turn.turnId),
              ),
            ),
          ),
        ),
      )
      .orderBy(
        asc(schema.nativeHistoryBindings.id),
        asc(schema.nativeHistoryTurns.turnId),
      );
    return nativeHistoryTurnReadResponseSchema.parse({
      chatId,
      turns: rows.map(({ bindingId, workerId, threadId, turn }) => ({
        bindingId,
        workerId,
        turn: {
          threadId,
          turnId: turn.turnId,
          revision: turn.revision,
          ordinal: turn.ordinal,
          status: turn.status,
          startedAtMs: turn.startedAtMs,
          completedAtMs: turn.completedAtMs,
          metadata: turn.metadata,
          ...(turn.usage == null ? {} : { usage: turn.usage }),
          ...(turn.modelAttribution == null
            ? {}
            : { modelAttribution: turn.modelAttribution }),
        },
      })),
    });
  });
}
