import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  encryptionAssociatedDataSchema,
  type EncryptedPayloadEnvelope,
} from "@cantrip/protocol";
import { clearSensitiveBytes } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import { decryptPayload } from "./payload.js";

/** Opens the existing worker native-command-admission request format. Callers
 * validate the decrypted frame against their bound thread before using it. */
export async function decryptNativeCommandRequest(input: {
  ownerId: string;
  serverId: string;
  componentKey: Uint8Array;
  keyRevision: number;
  chatId: string;
  operationId: string;
  envelope: EncryptedPayloadEnvelope;
}): Promise<unknown> {
  const associatedData = encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component: "chat-content",
    table: "native-command-admission",
    rowId: bytesToHex(
      sha256(
        new TextEncoder().encode(
          JSON.stringify([input.serverId, input.chatId, input.operationId]),
        ),
      ),
    ),
    field: "request",
    formatVersion: 1,
    keyRevision: input.keyRevision,
  });
  const key = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component: associatedData.component,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
  try {
    const plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: input.envelope,
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
