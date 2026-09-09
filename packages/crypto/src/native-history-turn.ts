import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  encryptionAssociatedDataSchema,
  nativeHistoryTurnSchema,
  type NativeHistoryTurn,
} from "@cantrip/protocol";
import { clearSensitiveBytes } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import { decryptPayload } from "./payload.js";

/** Browser-compatible decoder for the existing worker turn archive format.
 * Public scope, lifecycle, timestamps and revision are authenticated by AEAD. */
export async function decryptNativeHistoryTurn(input: {
  ownerId: string;
  serverId: string;
  componentKey: Uint8Array;
  chatId: string;
  bindingId: string;
  workerId: string;
  turn: NativeHistoryTurn;
}): Promise<unknown> {
  const turn = nativeHistoryTurnSchema.parse(input.turn);
  const keyRevision = turn.metadata.keyRevision;
  const associatedData = encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component: "chat-content",
    table: "native-history-turns",
    rowId: bytesToHex(
      sha256(
        new TextEncoder().encode(
          JSON.stringify([
            input.serverId,
            input.workerId,
            input.chatId,
            input.bindingId,
            turn.threadId,
            turn.turnId,
            turn.revision,
            turn.ordinal,
            turn.status,
            turn.startedAtMs,
            turn.completedAtMs,
            ...(turn.usage === undefined ? [] : [turn.usage]),
            ...(turn.modelAttribution === undefined
              ? []
              : [{ modelAttribution: turn.modelAttribution }]),
          ]),
        ),
      ),
    ),
    field: "metadata",
    formatVersion: 1,
    keyRevision,
  });
  const key = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component: associatedData.component,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision,
  });
  try {
    const plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: turn.metadata,
    });
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      );
    } finally {
      clearSensitiveBytes(plaintext);
    }
  } finally {
    clearSensitiveBytes(key);
  }
}
