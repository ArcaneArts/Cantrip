import { readNativeHistoryAttachmentReferences } from "./native-history-attachment-references.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  chatMessageOpaqueContentSchema,
  nativeCommandSessionSchema,
  nativeHistoryItemMappingSchema,
  nativeHistoryResolveSchema,
  type NativeHistoryBinding,
  type NativeHistoryItemMapping,
  type NativeHistoryResolve,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import {
  NativeHistoryError,
  type NativeHistoryBindingRepository,
} from "./native-history-bindings.js";
import { nativeHistoryPayloadDigest } from "./native-history-digest.js";
import { findObservedNativeInputTurn } from "./native-command-turns.js";
import { findNativeHistoryOutputAlias } from "./native-history-output-alias.js";
import { findNativeHistoryQueueAlias } from "./native-history-queue-alias.js";
import { resolveObservedNativeInput } from "./native-history-input-provenance.js";

type RequestItem = NativeHistoryResolve["items"][number];
type Row = typeof schema.nativeHistoryItems.$inferSelect;
function mapped(
  row: Pick<
    Row,
    | "key"
    | "threadId"
    | "turnId"
    | "itemId"
    | "component"
    | "identityKind"
    | "messageId"
    | "idempotencyKey"
    | "preservedInput"
  >,
): NativeHistoryItemMapping {
  return nativeHistoryItemMappingSchema.parse({
    key: row.key,
    identity: {
      threadId: row.threadId,
      turnId: row.turnId,
      itemId: row.itemId,
      component: row.component,
      identityKind: row.identityKind,
    },
    messageId: row.messageId,
    idempotencyKey: row.idempotencyKey,
    preservedInput: row.preservedInput,
  });
}

export function nativeHistoryItemKey(
  chatId: string,
  identity: RequestItem["identity"],
): string {
  return nativeHistoryPayloadDigest([
    "native-history-item-v1",
    chatId,
    identity,
  ]);
}

async function commandInput(
  tx: RepositoryTransaction,
  ownerId: string,
  binding: NativeHistoryBinding,
  item: RequestItem,
) {
  if (item.association.kind !== "command-input") return null;
  const association = item.association;
  if (item.identity.component !== "user")
    throw new NativeHistoryError("input-alias-component-mismatch");
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
        // Historical attribution may come from a previous worker. The exact
        // owner/chat/thread/turn is checked; no execution permission is granted.
        eq(schema.nativeCommands.chatId, binding.chatId),
      ),
    );
  if (
    !command ||
    !command.logicalClientMessageId ||
    (command.kind !== "start" && command.method !== "turn/steer")
  )
    throw new NativeHistoryError("input-command-not-bound");
  if (
    command.method === "turn/steer" &&
    (command.status !== "applied" ||
      !command.protectedResult ||
      !command.resultDigest)
  )
    throw new NativeHistoryError("input-command-unacknowledged");
  const session = nativeCommandSessionSchema.parse(command.identity);
  if (
    session.threadId !== binding.threadId ||
    session.chatId !== binding.chatId
  )
    throw new NativeHistoryError("input-command-thread-mismatch");
  const turn = await findObservedNativeInputTurn(tx, command);
  if (!turn) throw new NativeHistoryError("input-command-turn-unobserved");
  if (
    turn.threadId !== binding.threadId ||
    turn.turnId !== item.identity.turnId ||
    turn.chatId !== binding.chatId ||
    turn.runtimeGeneration !== session.runtimeGeneration
  )
    throw new NativeHistoryError("input-command-turn-mismatch");
  // The prefix is not authority: it is checked only after the exact admitted
  // command and observed native turn establish which GUI input belongs here.
  if (
    association.clientUserMessageId !==
    `cantrip:${command.logicalClientMessageId}`
  )
    throw new NativeHistoryError("input-client-id-mismatch");
  const [message] = await tx
    .select()
    .from(schema.chatMessages)
    .where(
      and(
        eq(schema.chatMessages.id, command.logicalClientMessageId),
        eq(schema.chatMessages.chatId, binding.chatId),
      ),
    );
  if (
    !message ||
    message.role !== "user" ||
    !message.protectedContent ||
    !message.idempotencyKey
  )
    throw new NativeHistoryError("input-message-unavailable");
  return chatMessageOpaqueContentSchema.parse({
    id: message.id,
    idempotencyKey: message.idempotencyKey,
    classification: {
      role: message.role,
      mode: message.mode,
      attachmentIds: message.attachmentIds,
    },
    protectedContent: message.protectedContent,
    reasoningEffort: message.reasoningEffort,
  });
}

/** Reserves canonical message identities before worker encryption. This is not
 * a content commit and does not advance any ingestion or execution checkpoint. */
export class NativeHistoryItemRepository {
  constructor(private readonly bindings: NativeHistoryBindingRepository) {}

  async resolve(
    ownerId: string,
    raw: NativeHistoryResolve,
  ): Promise<NativeHistoryItemMapping[]> {
    const input = nativeHistoryResolveSchema.parse(raw);
    return this.bindings.withBinding(
      ownerId,
      input.workerId,
      input.chatId,
      input.bindingId,
      async (tx, binding) => {
        const result: NativeHistoryItemMapping[] = [];
        for (const rawItem of input.items) {
          const item = structuredClone(rawItem);
          if (item.identity.threadId !== binding.threadId)
            throw new NativeHistoryError("item-thread-mismatch");
          // Neither runtime, worker incarnation nor input origin changes this key.
          const key = nativeHistoryItemKey(binding.chatId, item.identity);
          const [existing] = await tx
            .select()
            .from(schema.nativeHistoryItems)
            .where(eq(schema.nativeHistoryItems.key, key));
          if (
            item.association.kind === "existing" ||
            ((item.association.kind === "observed-input" ||
              item.association.kind === "observed-output" ||
              item.association.kind === "output") &&
              existing)
          ) {
            if (!existing || existing.chatId !== binding.chatId)
              throw new NativeHistoryError("item-not-reserved", 404);
            result.push(mapped(existing));
            continue;
          }
          if (item.association.kind === "observed-input")
            item.association = await resolveObservedNativeInput(
              tx,
              ownerId,
              binding,
              item,
            );
          const preservedInput =
            (await commandInput(tx, ownerId, binding, item)) ??
            (await findNativeHistoryQueueAlias(tx, ownerId, binding, item));
          const output = await findNativeHistoryOutputAlias(
            tx,
            ownerId,
            binding,
            item,
          );
          if (output?.claimedKey && output.claimedKey !== key)
            throw new NativeHistoryError("output-alias-already-claimed");
          const outputOperationId = output?.operationId ?? null;
          const aliasOperationId =
            item.association.kind === "command-input" ||
            item.association.kind === "queue-input" ||
            item.association.kind === "queue-goal"
              ? item.association.operationId
              : null;
          const aliasClaimId =
            item.association.kind === "queue-input" ||
            item.association.kind === "queue-goal"
              ? item.association.claimId
              : null;
          if (existing) {
            if (
              existing.chatId !== binding.chatId ||
              existing.aliasOperationId !== aliasOperationId ||
              existing.aliasClaimId !== aliasClaimId ||
              existing.outputOperationId !== outputOperationId
            )
              throw new NativeHistoryError("item-association-conflict");
            result.push(mapped(existing));
            continue;
          }
          if (aliasOperationId) {
            const [claimed] = await tx
              .select()
              .from(schema.nativeHistoryItems)
              .where(
                eq(
                  schema.nativeHistoryItems.aliasOperationId,
                  aliasOperationId,
                ),
              );
            if (claimed)
              throw new NativeHistoryError("input-alias-already-claimed");
          }
          const saved = {
            key,
            chatId: binding.chatId,
            ...item.identity,
            messageId: preservedInput?.id ?? output?.message.id ?? randomUUID(),
            idempotencyKey:
              preservedInput?.idempotencyKey ??
              output?.message.idempotencyKey ??
              `native-history:${key}`,
            aliasOperationId,
            outputOperationId,
            aliasClaimId,
            preservedInput,
          };
          await tx.insert(schema.nativeHistoryItems).values(saved);
          result.push(mapped(saved));
        }
        const attachments = await readNativeHistoryAttachmentReferences(
          tx,
          binding.chatId,
          result.map((item) => item.messageId),
        );
        return result.map((item) => {
          const references = attachments.get(item.messageId);
          return references?.length
            ? { ...item, attachments: references }
            : item;
        });
      },
    );
  }
}
