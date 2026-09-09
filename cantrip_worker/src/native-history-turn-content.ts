import { createHash } from "node:crypto";
import { z } from "zod";
import {
  clearSensitiveBytes,
  decryptPayload,
  deriveFieldKey,
  encryptPayload,
} from "@cantrip/crypto";
import {
  encryptionAssociatedDataSchema,
  nativeHistoryTurnSchema,
  type NativeHistoryBinding,
  type NativeHistoryTurn,
} from "@cantrip/protocol";
import type { NativeHistoryEncryptionService } from "./native-history-content.js";
import type { CodexNativeHistorySnapshot } from "./codex/native-history.js";
import { nativeHistoryUsageForTurn } from "./native-history-usage.js";

type Binding = Pick<
  NativeHistoryBinding,
  "id" | "chatId" | "workerId" | "threadId"
>;
type Header = Omit<NativeHistoryTurn, "metadata">;

function material(
  service: NativeHistoryEncryptionService,
  binding: Binding,
  turn: Header,
  keyRevision?: number,
) {
  if (binding.threadId !== turn.threadId)
    throw new Error(
      "Native turn metadata belongs to a different history binding.",
    );
  const component = service.componentKey("chat-content", keyRevision);
  try {
    const associatedData = encryptionAssociatedDataSchema.parse({
      ownerId: service.ownerId(),
      component: "chat-content",
      table: "native-history-turns",
      // Include public attribution and revision so relabeling ciphertext as a
      // different thread, terminal state, timestamp or revision is detectable.
      rowId: createHash("sha256")
        .update(
          JSON.stringify([
            service.serverIdentity(),
            binding.workerId,
            binding.chatId,
            binding.id,
            turn.threadId,
            turn.turnId,
            turn.revision,
            turn.ordinal,
            turn.status,
            turn.startedAtMs,
            turn.completedAtMs,
            // Omission keeps the exact legacy AAD; new analytics cannot be
            // removed, inserted or modified without invalidating the envelope.
            ...(turn.usage === undefined ? [] : [turn.usage]),
          ]),
        )
        .digest("hex"),
      field: "metadata",
      formatVersion: 1,
      keyRevision: component.keyRevision,
    });
    return {
      associatedData,
      key: deriveFieldKey({
        componentKey: component.key,
        ownerId: associatedData.ownerId,
        component: associatedData.component,
        table: associatedData.table,
        field: associatedData.field,
        keyRevision: component.keyRevision,
      }),
    };
  } finally {
    clearSensitiveBytes(component.key);
  }
}

/** Prepare one observed aggregate. Durable revision assignment/reconciliation is
 * owned by the projector; callers must journal the result before publishing it. */
export async function prepareNativeHistoryTurn(input: {
  service: NativeHistoryEncryptionService;
  binding: Binding;
  snapshot: CodexNativeHistorySnapshot;
  turnId: string;
  revision: number;
}): Promise<NativeHistoryTurn> {
  if (input.snapshot.thread.id !== input.binding.threadId)
    throw new Error("Native history belongs to a different binding.");
  const ordinal = input.snapshot.thread.turns.findIndex(
    (turn) => turn.id === input.turnId,
  );
  const source = input.snapshot.thread.turns[ordinal];
  if (!source)
    throw new Error("Native history does not contain the requested turn.");
  const evidence =
    input.snapshot.history?.turns.find(
      (turn) => turn.turnId === input.turnId,
    ) ?? null;
  const { items: _items, ...nativeTurn } = source;
  const content = z.json().parse({
    version: 1,
    nativeTurn,
    // Parent/fork references are observations, not verified alias authority.
    parentThreadId: input.snapshot.thread.parentThreadId ?? null,
    forkedFromId: input.snapshot.thread.forkedFromId ?? null,
    history: evidence,
  });
  const header = nativeHistoryTurnSchema.omit({ metadata: true }).parse({
    threadId: input.binding.threadId,
    turnId: input.turnId,
    revision: input.revision,
    ordinal,
    status: source.status,
    // Pinned Turn.startedAt/completedAt are Unix seconds; item evidence uses ms.
    startedAtMs: source.startedAt == null ? null : source.startedAt * 1_000,
    completedAtMs:
      source.completedAt == null ? null : source.completedAt * 1_000,
    usage: nativeHistoryUsageForTurn(
      input.binding.threadId,
      input.turnId,
      evidence,
    ),
  });
  return protectNativeHistoryTurnMetadata({
    service: input.service,
    binding: input.binding,
    header,
    content,
  });
}

/** Seal an already reconciled aggregate without synthesizing a native snapshot. */
export async function protectNativeHistoryTurnMetadata(input: {
  service: NativeHistoryEncryptionService;
  binding: Binding;
  header: Header;
  content: unknown;
}): Promise<NativeHistoryTurn> {
  const header = nativeHistoryTurnSchema
    .omit({ metadata: true })
    .parse(input.header);
  const content = z.json().parse(input.content);
  const { key, associatedData } = material(
    input.service,
    input.binding,
    header,
  );
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new TextEncoder().encode(JSON.stringify(content));
    const metadata = await encryptPayload({ key, plaintext, associatedData });
    return nativeHistoryTurnSchema.parse({ ...header, metadata });
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(key);
  }
}

export async function openNativeHistoryTurn(input: {
  service: NativeHistoryEncryptionService;
  binding: Binding;
  turn: NativeHistoryTurn;
}): Promise<z.infer<ReturnType<typeof z.json>>> {
  const turn = nativeHistoryTurnSchema.parse(input.turn);
  const { key, associatedData } = material(
    input.service,
    input.binding,
    turn,
    turn.metadata.keyRevision,
  );
  try {
    const plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: turn.metadata,
    });
    try {
      return z
        .json()
        .parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
          ),
        );
    } finally {
      clearSensitiveBytes(plaintext);
    }
  } finally {
    clearSensitiveBytes(key);
  }
}
