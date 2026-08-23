import {
  ENDPOINT_CONTENT_PROTECTED_BYTES_LIMIT,
  endpointContentContextSchema,
  endpointContentOpaqueSchema,
  type EndpointContentContext,
  type EndpointContentOpaque,
} from "@cantrip/protocol/endpoint-content";
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

const formatVersion = 1 as const;
const encoder = new TextEncoder();

function serverBinding(serverId: string): string {
  return encodeBase64Url(sha256(encoder.encode(serverId)));
}

export function endpointContentAssociatedData(input: {
  ownerId: string;
  context: EndpointContentContext;
  keyRevision: number;
}): EncryptionAssociatedData {
  const context = endpointContentContextSchema.parse(input.context);
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component: context.domain,
    table: `protocol:${context.domain}`,
    rowId: JSON.stringify([
      serverBinding(context.serverId),
      context.workerId,
      context.scopeId,
      context.operationId,
      context.operation,
      context.direction,
      context.sequence,
    ]),
    field: "protected_endpoint_content",
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export async function encryptEndpointContentPayload(input: {
  ownerId: string;
  context: EndpointContentContext;
  keyRevision: number;
  componentKey: Uint8Array;
  plaintext: Uint8Array;
}): Promise<EndpointContentOpaque> {
  const context = endpointContentContextSchema.parse(input.context);
  if (input.plaintext.byteLength > ENDPOINT_CONTENT_PROTECTED_BYTES_LIMIT) {
    throw new Error("Protected endpoint content is too large.");
  }
  const associatedData = endpointContentAssociatedData({
    ownerId: input.ownerId,
    context,
    keyRevision: input.keyRevision,
  });
  const fieldKey = deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component: context.domain,
    table: associatedData.table,
    field: associatedData.field,
    keyRevision: input.keyRevision,
  });
  try {
    return endpointContentOpaqueSchema.parse({
      formatVersion,
      domain: context.domain,
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

export async function decryptEndpointContentPayload(input: {
  ownerId: string;
  context: EndpointContentContext;
  keyRevision: number;
  componentKey: Uint8Array;
  opaque: EndpointContentOpaque;
}): Promise<Uint8Array> {
  try {
    const context = endpointContentContextSchema.parse(input.context);
    const opaque = endpointContentOpaqueSchema.parse(input.opaque);
    if (
      opaque.formatVersion !== formatVersion ||
      opaque.domain !== context.domain ||
      opaque.keyRevision !== input.keyRevision ||
      opaque.envelope.keyRevision !== input.keyRevision
    ) {
      throw new CantripDecryptionError();
    }
    const associatedData = endpointContentAssociatedData({
      ownerId: input.ownerId,
      context,
      keyRevision: input.keyRevision,
    });
    const fieldKey = deriveFieldKey({
      componentKey: input.componentKey,
      ownerId: input.ownerId,
      component: context.domain,
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
      if (plaintext.byteLength > ENDPOINT_CONTENT_PROTECTED_BYTES_LIMIT) {
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
