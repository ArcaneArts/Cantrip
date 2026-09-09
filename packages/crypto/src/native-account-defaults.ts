import {
  encryptionAssociatedDataSchema,
  nativeAccountDefaultsContextSchema,
  nativeAccountDefaultsWriteSchema,
  nativeAccountDefaultsResultSchema,
  type NativeAccountDefaultsContext,
  type NativeAccountDefaultsWrite,
  type NativeAccountDefaultsResult,
  type EncryptedPayloadEnvelope,
} from "@cantrip/protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { clearSensitiveBytes } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import { decryptPayload, encryptPayload } from "./payload.js";

interface Key {
  ownerId: string;
  serverId: string;
  componentKey: Uint8Array;
  keyRevision: number;
  context: NativeAccountDefaultsContext;
}
const encoder = new TextEncoder();
function material(input: Key) {
  const context = nativeAccountDefaultsContextSchema.parse(input.context);
  const associatedData = encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component: "chat-content",
    table: "native-account-defaults",
    rowId: bytesToHex(
      sha256(
        encoder.encode(
          JSON.stringify([
            input.serverId,
            context.chatId,
            context.bindingId,
            context.operationId,
          ]),
        ),
      ),
    ),
    field: context.direction,
    formatVersion: 1,
    keyRevision: input.keyRevision,
  });
  return {
    associatedData,
    key: deriveFieldKey({
      componentKey: input.componentKey,
      ownerId: input.ownerId,
      component: associatedData.component,
      table: associatedData.table,
      field: associatedData.field,
      keyRevision: input.keyRevision,
    }),
  };
}
export async function encryptNativeAccountDefaults(
  input: Key & {
    value: NativeAccountDefaultsWrite | NativeAccountDefaultsResult;
  },
): Promise<EncryptedPayloadEnvelope> {
  const value = (
    input.context.direction === "request"
      ? nativeAccountDefaultsWriteSchema
      : nativeAccountDefaultsResultSchema
  ).parse(input.value);
  const plaintext = encoder.encode(JSON.stringify(value));
  const { key, associatedData } = material(input);
  try {
    return await encryptPayload({ key, associatedData, plaintext });
  } finally {
    clearSensitiveBytes(key);
    clearSensitiveBytes(plaintext);
  }
}
export async function decryptNativeAccountDefaults(
  input: Key & {
    envelope: EncryptedPayloadEnvelope;
    context: NativeAccountDefaultsContext & { direction: "request" };
  },
): Promise<NativeAccountDefaultsWrite>;
export async function decryptNativeAccountDefaults(
  input: Key & {
    envelope: EncryptedPayloadEnvelope;
    context: NativeAccountDefaultsContext & { direction: "response" };
  },
): Promise<NativeAccountDefaultsResult>;
export async function decryptNativeAccountDefaults(
  input: Key & { envelope: EncryptedPayloadEnvelope },
) {
  const { key, associatedData } = material(input);
  try {
    const plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: input.envelope,
    });
    try {
      return (
        input.context.direction === "request"
          ? nativeAccountDefaultsWriteSchema
          : nativeAccountDefaultsResultSchema
      ).parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
      );
    } finally {
      clearSensitiveBytes(plaintext);
    }
  } finally {
    clearSensitiveBytes(key);
  }
}
