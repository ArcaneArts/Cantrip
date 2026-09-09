import { and, eq, or, sql } from "drizzle-orm";
import { nativeTurnModelAttributionSchema } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import { projectChatExecutionLock } from "./chat-execution-lock.js";
import type { TokenUsageRecordInput } from "./telemetry.js";

/** One analytics row per exact native turn, independent of the live input origin.
 * Attempt source keys remain aliases for late status/count finalization. A later
 * turn may reuse an attempt alias; callers must identify that turn to resolve it.
 */
export async function withNativeUsageIdentity(
  database: RepositoryDatabase,
  ownerId: string,
  input: TokenUsageRecordInput,
  write: (
    tx: RepositoryTransaction,
    input: TokenUsageRecordInput,
  ) => Promise<void>,
) {
  const capture =
    input.nativeModelAttribution === undefined
      ? undefined
      : nativeTurnModelAttributionSchema.parse(input.nativeModelAttribution);
  if (capture && capture.turnId !== input.turnId)
    throw new Error("Native usage attribution belongs to another turn.");
  if (capture && !input.chatId)
    throw new Error("Native usage requires its exact chat identity.");
  return database.transaction(async (tx) => {
    if (input.chatId) {
      // Same project -> chat order as history ingestion. Never hold this across
      // native input, inference or a worker request.
      await tx.execute(projectChatExecutionLock(ownerId, input.chatId));
      const [chat] = await tx
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .for("update");
      if (!chat)
        throw new Error("Token usage chat is not owned by this account.");
    }
    const sourceRows = await tx
      .select()
      .from(schema.tokenUsageRecords)
      .where(
        and(
          eq(schema.tokenUsageRecords.ownerId, ownerId),
          sql`${schema.tokenUsageRecords.chatId} IS NOT DISTINCT FROM ${input.chatId}`,
          or(
            eq(schema.tokenUsageRecords.sourceKey, input.sourceKey),
            sql`${schema.tokenUsageRecords.sourceAliases} @> ${JSON.stringify([input.sourceKey])}::jsonb`,
          ),
        ),
      );
    if (!capture) {
      const matching = input.turnId
        ? sourceRows.filter(
            (row) =>
              row.turnId === input.turnId ||
              (row.turnId === null && row.nativeModelAttribution === null),
          )
        : sourceRows;
      if (matching.length > 1)
        throw new Error(
          "Usage source alias identifies multiple native turns; specify the exact turn.",
        );
      if (!matching.length && sourceRows.length)
        throw new Error("Usage source alias belongs to another retained turn.");
      if (!matching.length) {
        const [elsewhere] = await tx
          .select({ chatId: schema.tokenUsageRecords.chatId })
          .from(schema.tokenUsageRecords)
          .where(
            and(
              eq(schema.tokenUsageRecords.ownerId, ownerId),
              eq(schema.tokenUsageRecords.sourceKey, input.sourceKey),
            ),
          );
        if (elsewhere && elsewhere.chatId !== input.chatId)
          throw new Error("Usage source key belongs to another chat.");
      }
      return write(tx, {
        ...input,
        sourceKey: matching[0]?.sourceKey ?? input.sourceKey,
      });
    }
    const canonical = `native-turn:${JSON.stringify([input.chatId, capture.threadId, capture.turnId])}`;
    if (
      input.sourceKey.startsWith("native-turn:") &&
      input.sourceKey !== canonical
    )
      throw new Error("Native usage source key belongs to another turn.");
    const [existing] = await tx
      .select()
      .from(schema.tokenUsageRecords)
      .where(
        and(
          eq(schema.tokenUsageRecords.ownerId, ownerId),
          eq(schema.tokenUsageRecords.sourceKey, canonical),
        ),
      );
    // Captures written before canonical source keys existed may have an alias
    // this observer has never seen. Find the retained exact turn independently
    // of the incoming live/recovery source name.
    const sameTurn = await tx
      .select()
      .from(schema.tokenUsageRecords)
      .where(
        and(
          eq(schema.tokenUsageRecords.ownerId, ownerId),
          eq(schema.tokenUsageRecords.chatId, input.chatId!),
          eq(schema.tokenUsageRecords.turnId, capture.turnId),
          sql`${schema.tokenUsageRecords.nativeModelAttribution}->>'threadId' = ${capture.threadId}`,
        ),
      );
    if (
      sameTurn.some((row) => existing && row.id !== existing.id) ||
      sameTurn.length > 1
    )
      throw new Error(
        "Multiple retained usage records claim the same native turn.",
      );
    const bootstrap = sourceRows.find(
      (row) =>
        row.nativeModelAttribution === null &&
        (row.turnId === null || row.turnId === capture.turnId),
    );
    const adopted = existing ?? sameTurn[0] ?? bootstrap;
    if (existing && bootstrap && existing.id !== bootstrap.id) {
      // A zero-count pending attempt may arrive before the captured observation.
      // Do not discard independently measured, uncorrelated usage.
      if (
        [
          bootstrap.inputTokens,
          bootstrap.outputTokens,
          bootstrap.cachedInputTokens,
          bootstrap.cacheWriteInputTokens,
          bootstrap.reasoningOutputTokens,
          bootstrap.reportedTotalTokens ?? 0,
        ].some((count) => count !== 0)
      )
        throw new Error(
          "Uncorrelated attempt usage cannot be merged into a native turn.",
        );
      await tx
        .delete(schema.tokenUsageRecords)
        .where(eq(schema.tokenUsageRecords.id, bootstrap.id));
    }
    const aliases = [
      ...new Set([
        ...(adopted?.sourceAliases ?? []),
        ...(bootstrap?.sourceAliases ?? []),
        ...(adopted && adopted.sourceKey !== canonical
          ? [adopted.sourceKey]
          : []),
        input.sourceKey,
      ]),
    ]
      .filter((alias) => alias !== canonical)
      .sort();
    if (adopted) {
      if (adopted.chatId !== input.chatId)
        throw new Error("Native usage key belongs to another chat.");
      await tx
        .update(schema.tokenUsageRecords)
        .set({ sourceKey: canonical, sourceAliases: aliases })
        .where(eq(schema.tokenUsageRecords.id, adopted.id));
    }
    await write(tx, { ...input, sourceKey: canonical });
    if (!adopted)
      await tx
        .update(schema.tokenUsageRecords)
        .set({ sourceAliases: aliases })
        .where(
          and(
            eq(schema.tokenUsageRecords.ownerId, ownerId),
            eq(schema.tokenUsageRecords.sourceKey, canonical),
          ),
        );
  });
}
