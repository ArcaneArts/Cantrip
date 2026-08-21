import {
  decodeRemoteSurfaceProtectedPayload,
  encodeRemoteSurfaceProtectedPayload,
  REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT,
  remoteSurfaceStreamContextSchema,
  type RemoteSurfaceStreamContext,
} from "@cantrip/protocol/remote-surface-stream";
import {
  encryptionAssociatedDataSchema,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  clearSensitiveBytes,
  decodeBase64Url,
  encodeBase64Url,
} from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import {
  CantripDecryptionError,
  decryptPayload,
  encryptPayload,
} from "./payload.js";

const component = "surface-private-state" as const;
const formatVersion = 1 as const;
const encoder = new TextEncoder();

function serverBinding(serverId: string): string {
  return encodeBase64Url(sha256(encoder.encode(serverId)));
}

export function remoteSurfaceStreamAssociatedData(input: {
  ownerId: string;
  context: RemoteSurfaceStreamContext;
  keyRevision: number;
}): EncryptionAssociatedData {
  const context = remoteSurfaceStreamContextSchema.parse(input.context);
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table: `protocol:remote-${context.surfaceKind}-stream`,
    rowId: JSON.stringify([
      serverBinding(context.serverId),
      context.surfaceId,
      context.attachmentId,
      context.direction,
      context.channel,
      context.sequence,
    ]),
    field: "protected_remote_surface_payload",
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export async function encryptRemoteSurfaceStreamPayload(input: {
  ownerId: string;
  context: RemoteSurfaceStreamContext;
  keyRevision: number;
  componentKey: Uint8Array;
  plaintext: Uint8Array;
}): Promise<Uint8Array> {
  const context = remoteSurfaceStreamContextSchema.parse(input.context);
  if (
    input.plaintext.byteLength > REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT
  ) {
    throw new Error("Remote Surface stream content is too large.");
  }
  const associatedData = remoteSurfaceStreamAssociatedData({
    ownerId: input.ownerId,
    context,
    keyRevision: input.keyRevision,
  });
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
  try {
    const envelope = await encryptPayload({
      key: fieldKey,
      plaintext: input.plaintext,
      associatedData,
    });
    return encodeRemoteSurfaceProtectedPayload({
      formatVersion,
      keyRevision: input.keyRevision,
      nonce: decodeBase64Url(envelope.nonce),
      ciphertext: decodeBase64Url(envelope.ciphertext),
    });
  } finally {
    clearSensitiveBytes(fieldKey);
  }
}

export async function decryptRemoteSurfaceStreamPayload(input: {
  ownerId: string;
  context: RemoteSurfaceStreamContext;
  keyRevision: number;
  componentKey: Uint8Array;
  protectedPayload: Uint8Array;
}): Promise<Uint8Array> {
  try {
    const context = remoteSurfaceStreamContextSchema.parse(input.context);
    const protectedPayload = decodeRemoteSurfaceProtectedPayload(
      input.protectedPayload,
    );
    if (protectedPayload.keyRevision !== input.keyRevision) {
      throw new CantripDecryptionError();
    }
    const associatedData = remoteSurfaceStreamAssociatedData({
      ownerId: input.ownerId,
      context,
      keyRevision: input.keyRevision,
    });
    const fieldKey = deriveFieldKey({
      componentKey: input.componentKey,
      ownerId: input.ownerId,
      component,
      table: associatedData.table,
      field: associatedData.field,
      keyRevision: input.keyRevision,
    });
    try {
      const plaintext = await decryptPayload({
        key: fieldKey,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: input.keyRevision,
          nonce: encodeBase64Url(protectedPayload.nonce),
          ciphertext: encodeBase64Url(protectedPayload.ciphertext),
        },
        associatedData,
      });
      if (
        plaintext.byteLength > REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT
      ) {
        clearSensitiveBytes(plaintext);
        throw new CantripDecryptionError();
      }
      return plaintext;
    } finally {
      clearSensitiveBytes(fieldKey);
    }
  } catch {
    throw new CantripDecryptionError();
  }
}
