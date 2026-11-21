import {
  nativeHistoryItemIdentitySchema,
  nativeHistoryPreparedBatchSchema,
  type NativeHistoryBinding,
  type NativeHistoryItemMapping,
  type NativeHistoryPreparedBatch,
} from "@cantrip/protocol";
import type { NativeHistoryRenderedItem } from "./native-history-render.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import { protectChatMessage } from "./chat-message-encryption.js";
import { protectNativeHistoryItemEvidence } from "./native-history-item-content.js";

type PreparedItem = NativeHistoryPreparedBatch["items"][number];

/** Prepare after canonical identity reservation. The transaction/outbox owner
 * must stage the returned ciphertext once and retry those exact bytes; this
 * helper neither sends a batch nor consumes a source record. */
export async function prepareNativeHistoryRenderedItem(input: {
  service: WorkerEncryptionService;
  binding: Pick<
    NativeHistoryBinding,
    "id" | "chatId" | "workerId" | "threadId"
  >;
  rendered: NativeHistoryRenderedItem;
  mapping: NativeHistoryItemMapping;
  revision: number;
  order: PreparedItem["order"];
  attachments: PreparedItem["attachments"];
}): Promise<PreparedItem> {
  const identity = nativeHistoryItemIdentitySchema.parse(
    input.rendered.identity,
  );
  const mapped = nativeHistoryItemIdentitySchema.parse(input.mapping.identity);
  if (JSON.stringify(identity) !== JSON.stringify(mapped))
    throw new Error(
      "Native history preparation received an unrelated item mapping.",
    );
  const evidence = await protectNativeHistoryItemEvidence({
    service: input.service,
    binding: input.binding,
    identity,
    revision: input.revision,
    source: input.rendered.source,
  });
  const message =
    input.mapping.preservedInput ??
    (await protectChatMessage({
      id: input.mapping.messageId,
      service: input.service,
      message: {
        ...input.rendered.message,
        idempotencyKey: input.mapping.idempotencyKey,
      },
    }));
  if (
    message.id !== input.mapping.messageId ||
    message.idempotencyKey !== input.mapping.idempotencyKey
  )
    throw new Error(
      "Preserved native input does not match its canonical message mapping.",
    );
  return nativeHistoryPreparedBatchSchema.parse({
    items: [
      {
        identity,
        revision: input.revision,
        state: input.rendered.source.lifecycle,
        order: input.order,
        attachments: input.attachments,
        message,
        evidence,
      },
    ],
    turns: [],
  }).items[0]!;
}
