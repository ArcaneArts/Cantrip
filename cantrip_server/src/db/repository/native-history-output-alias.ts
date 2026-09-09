import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  nativeCommandSessionSchema,
  type NativeHistoryBinding,
  type NativeHistoryResolve,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeHistoryError } from "./native-history-bindings.js";
import { findObservedNativeCommandTurn } from "./native-command-turns.js";

function outputRoot(
  binding: NativeHistoryBinding,
  item: NativeHistoryResolve["items"][number],
) {
  const ancestors = binding.ancestorThreadIds ?? [];
  const rootTurnId =
    item.association.kind === "output"
      ? item.association.rootTurnId
      : undefined;
  if (ancestors.length && !rootTurnId)
    throw new NativeHistoryError("child-output-root-turn-missing");
  if (!ancestors.length && rootTurnId && rootTurnId !== item.identity.turnId)
    throw new NativeHistoryError("root-output-turn-mismatch");
  return {
    threadId: ancestors[0] ?? binding.threadId,
    turnId: rootTurnId ?? item.identity.turnId,
  };
}

/** Recover exact historical root ownership, including pre-index terminal
 * receipts. The reading worker need not be the original executing worker. */
async function observedOutputCommand(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeHistoryBinding,
  item: NativeHistoryResolve["items"][number],
) {
  const root = outputRoot(binding, item);
  if (item.identity.identityKind !== "canonical")
    throw new NativeHistoryError("observed-output-identity-mismatch");
  const candidates = await tx
    .select({ command: schema.nativeCommands })
    .from(schema.nativeCommands)
    .leftJoin(
      schema.nativeCommandTurns,
      eq(
        schema.nativeCommandTurns.operationId,
        schema.nativeCommands.operationId,
      ),
    )
    .where(
      and(
        eq(schema.nativeCommands.ownerId, ownerId),
        eq(schema.nativeCommands.chatId, binding.chatId),
        eq(schema.nativeCommands.kind, "start"),
        sql`${schema.nativeCommands.identity} ->> 'threadId' = ${root.threadId}`,
        or(
          eq(schema.nativeCommandTurns.turnId, root.turnId),
          and(
            isNull(schema.nativeCommandTurns.operationId),
            sql`${schema.nativeCommands.terminalEvidence} ->> 'nativeTurnId' = ${root.turnId}`,
          ),
        ),
      ),
    );
  const matches: Array<typeof schema.nativeCommands.$inferSelect> = [];
  for (const { command } of candidates) {
    const session = nativeCommandSessionSchema.parse(command.identity);
    const turn = await findObservedNativeCommandTurn(tx, command, {
      backfill: false,
    });
    if (
      turn?.chatId === binding.chatId &&
      turn.threadId === root.threadId &&
      turn.turnId === root.turnId &&
      turn.runtimeGeneration === session.runtimeGeneration
    )
      matches.push(command);
  }
  if (matches.length !== 1)
    throw new NativeHistoryError(
      matches.length
        ? "output-provenance-ambiguous"
        : "output-provenance-unavailable",
    );
  return matches[0]!;
}

// Compatibility identity from EncryptedChatEventSealer, not a new namespace.
export function protectedEventId(chatId: string, key: string): string {
  const bytes = createHash("sha256")
    .update("cantrip:protected-agent-event\0")
    .update(chatId)
    .update("\0")
    .update(key)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Adopt an already published root output only after exact command/turn evidence.
 * Child, fallback and plaintext legacy aliases require their own provenance. */
export async function findNativeHistoryOutputAlias(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeHistoryBinding,
  item: NativeHistoryResolve["items"][number],
) {
  if (
    item.association.kind !== "command-output" &&
    item.association.kind !== "observed-output" &&
    item.association.kind !== "output"
  )
    return null;
  const prefix =
    item.identity.component === "assistant"
      ? "agent-message"
      : item.identity.component === "activity"
        ? "activity"
        : null;
  if (!prefix) throw new NativeHistoryError("output-alias-component-mismatch");
  if (
    item.association.kind === "output" &&
    item.identity.identityKind !== "canonical"
  )
    throw new NativeHistoryError("observed-output-identity-mismatch");
  const root = outputRoot(binding, item);
  const scopes = binding.ancestorThreadIds?.length
    ? [`${root.turnId}:${binding.threadId}`]
    : ["root", `${item.identity.turnId}:${binding.threadId}`];
  const keys = scopes.map(
    (scope) =>
      `${prefix}:${scope}:${item.identity.turnId}:${item.identity.itemId}`,
  );
  const matches = await tx
    .select()
    .from(schema.chatMessages)
    .where(
      and(
        eq(schema.chatMessages.chatId, binding.chatId),
        inArray(schema.chatMessages.idempotencyKey, keys),
      ),
    );
  // A new native output needs no GUI-command alias. Existing compatibility
  // messages still require exact historical command evidence before adoption.
  if (item.association.kind === "output" && !matches.length) return null;
  const command =
    item.association.kind !== "command-output"
      ? await observedOutputCommand(tx, ownerId, binding, item)
      : (
          await tx
            .select()
            .from(schema.nativeCommands)
            .where(
              and(
                eq(
                  schema.nativeCommands.operationId,
                  item.association.operationId,
                ),
                eq(
                  schema.nativeCommands.operationGeneration,
                  item.association.operationGeneration,
                ),
                eq(schema.nativeCommands.ownerId, ownerId),
                eq(schema.nativeCommands.chatId, binding.chatId),
              ),
            )
        )[0];
  if (!command || command.kind !== "start")
    throw new NativeHistoryError("output-command-not-bound");
  const session = nativeCommandSessionSchema.parse(command.identity);
  const turn = await findObservedNativeCommandTurn(tx, command);
  if (
    session.threadId !== root.threadId ||
    session.chatId !== binding.chatId ||
    !turn ||
    turn.chatId !== binding.chatId ||
    turn.threadId !== root.threadId ||
    turn.turnId !== root.turnId ||
    turn.runtimeGeneration !== session.runtimeGeneration
  )
    throw new NativeHistoryError("output-command-turn-mismatch");
  if (matches.length !== 1)
    throw new NativeHistoryError(
      matches.length ? "output-alias-ambiguous" : "output-message-unavailable",
    );
  const message = matches[0]!;
  if (
    message.role !== "assistant" ||
    !message.protectedContent ||
    !message.idempotencyKey ||
    message.id !== protectedEventId(binding.chatId, message.idempotencyKey)
  )
    throw new NativeHistoryError("output-message-identity-mismatch");
  const [claimed] = await tx
    .select({ key: schema.nativeHistoryItems.key })
    .from(schema.nativeHistoryItems)
    .where(
      and(
        eq(schema.nativeHistoryItems.chatId, binding.chatId),
        eq(schema.nativeHistoryItems.messageId, message.id),
      ),
    );
  return {
    message,
    operationId: command.operationId,
    claimedKey: claimed?.key ?? null,
  };
}
