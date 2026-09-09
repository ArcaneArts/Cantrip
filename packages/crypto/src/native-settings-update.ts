import {
  encryptionAssociatedDataSchema,
  nativeSettingsPatchSchema,
  nativeSettingsUpdateContextSchema,
  type EncryptedPayloadEnvelope,
  type NativeSettingsPatch,
  type NativeSettingsUpdateContext,
} from "@cantrip/protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { clearSensitiveBytes } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import { decryptPayload, encryptPayload } from "./payload.js";

interface PatchKey {
  ownerId: string;
  serverId: string;
  componentKey: Uint8Array;
  keyRevision: number;
  context: NativeSettingsUpdateContext;
}

const encoder = new TextEncoder();

function material(input: PatchKey) {
  const context = nativeSettingsUpdateContextSchema.parse(input.context);
  const associatedData = encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component: "chat-content",
    // An explicit command must not authenticate as an observed snapshot.
    table: "native-settings-update",
    rowId: bytesToHex(
      sha256(
        encoder.encode(
          JSON.stringify([
            input.serverId,
            context.chatId,
            context.operationId,
            context.bindingId,
          ]),
        ),
      ),
    ),
    field: "patch",
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

/** Encrypt only explicitly selected fields. The caller retains ownership of
 * componentKey; each operation owns and clears its derived key and JSON bytes. */
export async function encryptNativeSettingsPatch(
  input: PatchKey & { patch: NativeSettingsPatch },
): Promise<EncryptedPayloadEnvelope> {
  const patch = nativeSettingsPatchSchema.parse(input.patch);
  const plaintext = encoder.encode(JSON.stringify(patch));
  try {
    const { key, associatedData } = material(input);
    try {
      return await encryptPayload({ key, plaintext, associatedData });
    } finally {
      clearSensitiveBytes(key);
    }
  } finally {
    clearSensitiveBytes(plaintext);
  }
}

export async function decryptNativeSettingsPatch(
  input: PatchKey & { envelope: EncryptedPayloadEnvelope },
): Promise<NativeSettingsPatch> {
  const { key, associatedData } = material(input);
  try {
    const plaintext = await decryptPayload({
      key,
      associatedData,
      envelope: input.envelope,
    });
    try {
      return nativeSettingsPatchSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
      );
    } finally {
      clearSensitiveBytes(plaintext);
    }
  } finally {
    clearSensitiveBytes(key);
  }
}
