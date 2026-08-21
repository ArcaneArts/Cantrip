import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from "node:crypto";

import {
  clearSensitiveBytes,
  deriveFieldKey,
  encodeAssociatedData,
  remoteSurfaceStreamAssociatedData,
} from "@cantrip/crypto";
import {
  decodeRemoteSurfaceProtectedPayload,
  encodeRemoteSurfaceProtectedPayload,
  REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT,
  remoteSurfaceStreamContextSchema,
  type RemoteSurfaceStreamContext,
} from "@cantrip/protocol/remote-surface-stream";

import {
  WorkerEncryptionError,
  type WorkerEncryptionService,
} from "./worker-encryption.js";

const component = "surface-private-state" as const;

function componentKey(input: {
  keyRevision?: number;
  service: WorkerEncryptionService;
}): { key: Uint8Array; keyRevision: number; ownerId: string } {
  try {
    const material = input.service.componentKey(component);
    if (
      input.keyRevision !== undefined &&
      input.keyRevision !== material.keyRevision
    ) {
      clearSensitiveBytes(material.key);
      throw new Error("Protected Remote Surface content uses a stale key.");
    }
    return { ...material, ownerId: input.service.ownerId() };
  } catch (error) {
    if (error instanceof WorkerEncryptionError) {
      throw new Error("Remote Surface stream encryption is unavailable.");
    }
    throw error;
  }
}

function fieldMaterial(input: {
  context: RemoteSurfaceStreamContext;
  keyRevision: number;
  componentKey: Uint8Array;
  ownerId: string;
}) {
  const associatedData = remoteSurfaceStreamAssociatedData({
    ownerId: input.ownerId,
    context: input.context,
    keyRevision: input.keyRevision,
  });
  return {
    associatedData,
    fieldKey: deriveFieldKey({
      componentKey: input.componentKey,
      ownerId: input.ownerId,
      component,
      table: associatedData.table,
      field: associatedData.field,
      keyRevision: input.keyRevision,
    }),
  };
}

export function protectWorkerRemoteSurfaceStreamPayload(input: {
  context: RemoteSurfaceStreamContext;
  payload: Uint8Array;
  service: WorkerEncryptionService;
}): Uint8Array {
  const context = remoteSurfaceStreamContextSchema.parse(input.context);
  if (
    input.payload.byteLength > REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT
  ) {
    throw new Error("Remote Surface stream content is too large.");
  }
  const material = componentKey({ service: input.service });
  const { associatedData, fieldKey } = fieldMaterial({
    context,
    keyRevision: material.keyRevision,
    componentKey: material.key,
    ownerId: material.ownerId,
  });
  const nonce = nodeRandomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", fieldKey, nonce);
    cipher.setAAD(Buffer.from(encodeAssociatedData(associatedData)));
    const ciphertext = Buffer.concat([
      cipher.update(input.payload),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return encodeRemoteSurfaceProtectedPayload({
      formatVersion: 1,
      keyRevision: material.keyRevision,
      nonce,
      ciphertext,
    });
  } finally {
    clearSensitiveBytes(nonce);
    clearSensitiveBytes(fieldKey);
    clearSensitiveBytes(material.key);
  }
}

export function openWorkerRemoteSurfaceStreamPayload(input: {
  context: RemoteSurfaceStreamContext;
  protectedPayload: Uint8Array;
  service: WorkerEncryptionService;
}): Uint8Array {
  let material:
    { key: Uint8Array; keyRevision: number; ownerId: string } | undefined;
  let fieldKey: Uint8Array | undefined;
  try {
    const context = remoteSurfaceStreamContextSchema.parse(input.context);
    const protectedPayload = decodeRemoteSurfaceProtectedPayload(
      input.protectedPayload,
    );
    material = componentKey({
      keyRevision: protectedPayload.keyRevision,
      service: input.service,
    });
    const derived = fieldMaterial({
      context,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      ownerId: material.ownerId,
    });
    fieldKey = derived.fieldKey;
    const ciphertext = protectedPayload.ciphertext;
    const tagOffset = ciphertext.byteLength - 16;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      fieldKey,
      protectedPayload.nonce,
    );
    decipher.setAAD(Buffer.from(encodeAssociatedData(derived.associatedData)));
    decipher.setAuthTag(ciphertext.subarray(tagOffset));
    const plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, tagOffset)),
      decipher.final(),
    ]);
    if (plaintext.byteLength > REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT) {
      clearSensitiveBytes(plaintext);
      throw new Error("Protected Remote Surface content is too large.");
    }
    return plaintext;
  } catch {
    throw new Error(
      "Protected Remote Surface content could not be authenticated.",
    );
  } finally {
    if (fieldKey) clearSensitiveBytes(fieldKey);
    if (material) clearSensitiveBytes(material.key);
  }
}
