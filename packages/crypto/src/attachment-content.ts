import {
  ATTACHMENT_MAX_CHUNK_BYTES,
  ATTACHMENT_METADATA_BYTES_LIMIT,
  attachmentChunkOpaqueSchema,
  attachmentMetadataProtectedContentSchema,
  attachmentProtectedMetadataSchema,
  type AttachmentChunkOpaque,
  type AttachmentMetadataProtectedContent,
  type AttachmentProtectedMetadata,
  type AttachmentStreamDirection,
} from "@cantrip/protocol/attachment-content";
import {
  encryptionAssociatedDataSchema,
  type EncryptionAssociatedData,
} from "@cantrip/protocol/encryption";
import { sha256 } from "@noble/hashes/sha2.js";

import { clearSensitiveBytes } from "./bytes.js";
import { deriveFieldKey } from "./kdf.js";
import {
  CantripDecryptionError,
  decryptPayload,
  encryptPayload,
} from "./payload.js";

const component = "attachment-content" as const;
const formatVersion = 1 as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function attachmentContentDigest(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function metadataAssociatedData(input: {
  ownerId: string;
  chatId: string;
  attachmentId: string;
  keyRevision: number;
}): EncryptionAssociatedData {
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table: "chat_attachments",
    rowId: JSON.stringify([input.chatId, input.attachmentId]),
    field: "protected_metadata",
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

function chunkAssociatedData(input: {
  ownerId: string;
  chatId: string;
  attachmentId: string;
  operationId: string;
  direction: AttachmentStreamDirection;
  sequence: number;
  plaintextBytes: number;
  eof: boolean;
  keyRevision: number;
}): EncryptionAssociatedData {
  return encryptionAssociatedDataSchema.parse({
    ownerId: input.ownerId,
    component,
    table: "protocol:attachment-stream",
    rowId: JSON.stringify([
      input.chatId,
      input.attachmentId,
      input.operationId,
      input.direction,
      input.sequence,
      input.plaintextBytes,
      input.eof,
    ]),
    field: "protected_chunk",
    formatVersion,
    keyRevision: input.keyRevision,
  });
}

function fieldKey(input: {
  componentKey: Uint8Array;
  ownerId: string;
  table: string;
  field: string;
  keyRevision: number;
}): Uint8Array {
  return deriveFieldKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component,
    table: input.table,
    field: input.field,
    keyRevision: input.keyRevision,
  });
}

export async function encryptAttachmentMetadata(input: {
  ownerId: string;
  chatId: string;
  attachmentId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  content: AttachmentMetadataProtectedContent;
}): Promise<AttachmentProtectedMetadata> {
  const content = attachmentMetadataProtectedContentSchema.parse(input.content);
  const plaintext = encoder.encode(JSON.stringify(content));
  if (plaintext.byteLength > ATTACHMENT_METADATA_BYTES_LIMIT) {
    clearSensitiveBytes(plaintext);
    throw new Error("Protected attachment metadata exceeds its byte limit.");
  }
  const aad = metadataAssociatedData(input);
  const key = fieldKey({
    ...input,
    table: aad.table,
    field: aad.field,
  });
  try {
    return attachmentProtectedMetadataSchema.parse({
      formatVersion,
      keyRevision: input.keyRevision,
      envelope: await encryptPayload({
        key,
        plaintext,
        associatedData: aad,
      }),
    });
  } finally {
    clearSensitiveBytes(key);
    clearSensitiveBytes(plaintext);
  }
}

export async function decryptAttachmentMetadata(input: {
  ownerId: string;
  chatId: string;
  attachmentId: string;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: AttachmentProtectedMetadata;
}): Promise<AttachmentMetadataProtectedContent> {
  let encrypted: AttachmentProtectedMetadata;
  try {
    encrypted = attachmentProtectedMetadataSchema.parse(input.encrypted);
    if (encrypted.keyRevision !== input.keyRevision) {
      throw new CantripDecryptionError();
    }
  } catch {
    throw new CantripDecryptionError();
  }
  const aad = metadataAssociatedData(input);
  const key = fieldKey({
    ...input,
    table: aad.table,
    field: aad.field,
  });
  let plaintext: Uint8Array | null = null;
  try {
    plaintext = await decryptPayload({
      key,
      envelope: encrypted.envelope,
      associatedData: aad,
    });
    if (plaintext.byteLength > ATTACHMENT_METADATA_BYTES_LIMIT) {
      throw new CantripDecryptionError();
    }
    return attachmentMetadataProtectedContentSchema.parse(
      JSON.parse(decoder.decode(plaintext)),
    );
  } catch {
    throw new CantripDecryptionError();
  } finally {
    if (plaintext) clearSensitiveBytes(plaintext);
    clearSensitiveBytes(key);
  }
}

export async function encryptAttachmentChunk(input: {
  ownerId: string;
  chatId: string;
  attachmentId: string;
  operationId: string;
  direction: AttachmentStreamDirection;
  sequence: number;
  eof: boolean;
  keyRevision: number;
  componentKey: Uint8Array;
  plaintext: Uint8Array;
}): Promise<AttachmentChunkOpaque> {
  if (input.plaintext.byteLength > ATTACHMENT_MAX_CHUNK_BYTES) {
    throw new Error("Attachment chunk exceeds its byte limit.");
  }
  const aad = chunkAssociatedData({
    ...input,
    plaintextBytes: input.plaintext.byteLength,
  });
  const key = fieldKey({
    ...input,
    table: aad.table,
    field: aad.field,
  });
  try {
    return attachmentChunkOpaqueSchema.parse({
      sequence: input.sequence,
      plaintextBytes: input.plaintext.byteLength,
      eof: input.eof,
      envelope: await encryptPayload({
        key,
        plaintext: input.plaintext,
        associatedData: aad,
      }),
    });
  } finally {
    clearSensitiveBytes(key);
  }
}

export async function decryptAttachmentChunk(input: {
  ownerId: string;
  chatId: string;
  attachmentId: string;
  operationId: string;
  direction: AttachmentStreamDirection;
  sequence: number;
  keyRevision: number;
  componentKey: Uint8Array;
  encrypted: AttachmentChunkOpaque;
}): Promise<Uint8Array> {
  let encrypted: AttachmentChunkOpaque;
  try {
    encrypted = attachmentChunkOpaqueSchema.parse(input.encrypted);
    if (
      encrypted.sequence !== input.sequence ||
      encrypted.envelope.keyRevision !== input.keyRevision
    ) {
      throw new CantripDecryptionError();
    }
  } catch {
    throw new CantripDecryptionError();
  }
  const aad = chunkAssociatedData({
    ownerId: input.ownerId,
    chatId: input.chatId,
    attachmentId: input.attachmentId,
    operationId: input.operationId,
    direction: input.direction,
    sequence: input.sequence,
    plaintextBytes: encrypted.plaintextBytes,
    eof: encrypted.eof,
    keyRevision: input.keyRevision,
  });
  const key = fieldKey({
    ...input,
    table: aad.table,
    field: aad.field,
  });
  try {
    const plaintext = await decryptPayload({
      key,
      envelope: encrypted.envelope,
      associatedData: aad,
    });
    if (
      plaintext.byteLength !== encrypted.plaintextBytes ||
      plaintext.byteLength > ATTACHMENT_MAX_CHUNK_BYTES
    ) {
      clearSensitiveBytes(plaintext);
      throw new CantripDecryptionError();
    }
    return plaintext;
  } catch {
    throw new CantripDecryptionError();
  } finally {
    clearSensitiveBytes(key);
  }
}
