import {
  REPOSITORY_OPERATION_PROTECTED_CONTENT_BYTES_LIMIT,
  repositoryOperationContextSchema,
  repositoryOperationOpaqueSchema,
  type RepositoryOperationContext,
  type RepositoryOperationOpaque,
} from "@cantrip/protocol/repository-operation";
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

const component = "repository-content" as const;
const formatVersion = 1 as const;
const encoder = new TextEncoder();

function serverBinding(serverId: string): string {
  return encodeBase64Url(sha256(encoder.encode(serverId)));
}

export function repositoryOperationAssociatedData(input: {
  ownerId: string;
  context: RepositoryOperationContext;
  keyRevision: number;
}): EncryptionAssociatedData {
  const context = repositoryOperationContextSchema.parse(input.context);
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table: "protocol:repository-operation",
    rowId: JSON.stringify([
      serverBinding(context.serverId),
      context.projectId,
      context.worktreeId,
      context.operationId,
      context.direction,
    ]),
    field: "protected_repository_operation",
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

export async function encryptRepositoryOperationPayload(input: {
  ownerId: string;
  context: RepositoryOperationContext;
  keyRevision: number;
  componentKey: Uint8Array;
  plaintext: Uint8Array;
}): Promise<RepositoryOperationOpaque> {
  const context = repositoryOperationContextSchema.parse(input.context);
  if (
    input.plaintext.byteLength >
    REPOSITORY_OPERATION_PROTECTED_CONTENT_BYTES_LIMIT
  ) {
    throw new Error("Protected repository operation content is too large.");
  }
  const associatedData = repositoryOperationAssociatedData({
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
    return repositoryOperationOpaqueSchema.parse({
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

export async function decryptRepositoryOperationPayload(input: {
  ownerId: string;
  context: RepositoryOperationContext;
  keyRevision: number;
  componentKey: Uint8Array;
  opaque: RepositoryOperationOpaque;
}): Promise<Uint8Array> {
  try {
    const context = repositoryOperationContextSchema.parse(input.context);
    const opaque = repositoryOperationOpaqueSchema.parse(input.opaque);
    if (
      opaque.formatVersion !== formatVersion ||
      opaque.keyRevision !== input.keyRevision ||
      opaque.envelope.keyRevision !== input.keyRevision
    ) {
      throw new CantripDecryptionError();
    }
    const associatedData = repositoryOperationAssociatedData({
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
      if (
        plaintext.byteLength >
        REPOSITORY_OPERATION_PROTECTED_CONTENT_BYTES_LIMIT
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
