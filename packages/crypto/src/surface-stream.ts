import {
  SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT,
  surfaceStreamContextSchema,
  surfaceStreamOpaqueSchema,
  type SurfaceStreamContext,
  type SurfaceStreamOpaque,
} from "@cantrip/protocol/surface-stream";
import {
  encryptionAssociatedDataSchema,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";
import { sha256 } from "@noble/hashes/sha2.js";

import { clearSensitiveBytes, encodeBase64Url } from "./bytes.js";
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

export function surfaceStreamAssociatedData(input: {
  ownerId: string;
  context: SurfaceStreamContext;
  keyRevision: number;
}): EncryptionAssociatedData {
  const context = surfaceStreamContextSchema.parse(input.context);
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table: `protocol:${context.surfaceKind}-stream`,
    rowId: JSON.stringify([
      serverBinding(context.serverId),
      context.surfaceId,
      context.operationId,
      context.direction,
      context.sequence,
    ]),
    field: "protected_surface_stream",
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export async function encryptSurfaceStreamPayload(input: {
  ownerId: string;
  context: SurfaceStreamContext;
  keyRevision: number;
  componentKey: Uint8Array;
  plaintext: Uint8Array;
}): Promise<SurfaceStreamOpaque> {
  const context = surfaceStreamContextSchema.parse(input.context);
  if (
    input.plaintext.byteLength > SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT
  ) {
    throw new Error("Protected surface stream content is too large.");
  }
  const associatedData = surfaceStreamAssociatedData({
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
    return surfaceStreamOpaqueSchema.parse({
      formatVersion,
      keyRevision: input.keyRevision,
      envelope: await encryptPayload({
        key: fieldKey,
        plaintext: input.plaintext,
        associatedData,
      }),
    });
  } finally {
    clearSensitiveBytes(fieldKey);
  }
}

export async function decryptSurfaceStreamPayload(input: {
  ownerId: string;
  context: SurfaceStreamContext;
  keyRevision: number;
  componentKey: Uint8Array;
  opaque: SurfaceStreamOpaque;
}): Promise<Uint8Array> {
  let context: SurfaceStreamContext;
  let opaque: SurfaceStreamOpaque;
  try {
    context = surfaceStreamContextSchema.parse(input.context);
    opaque = surfaceStreamOpaqueSchema.parse(input.opaque);
    if (
      opaque.formatVersion !== formatVersion ||
      opaque.keyRevision !== input.keyRevision ||
      opaque.envelope.keyRevision !== input.keyRevision
    ) {
      throw new CantripDecryptionError();
    }
  } catch {
    throw new CantripDecryptionError();
  }
  const associatedData = surfaceStreamAssociatedData({
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
      envelope: opaque.envelope,
      associatedData,
    });
    if (plaintext.byteLength > SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT) {
      clearSensitiveBytes(plaintext);
      throw new CantripDecryptionError();
    }
    return plaintext;
  } catch {
    throw new CantripDecryptionError();
  } finally {
    clearSensitiveBytes(fieldKey);
  }
}
