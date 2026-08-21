import {
  clearSensitiveBytes,
  decryptAttachmentChunk,
  decryptAttachmentMetadata,
  encryptAttachmentChunk,
  encryptAttachmentMetadata,
} from "@cantrip/crypto";
import {
  chatAttachmentOpaqueSummarySchema,
  chatAttachmentSummarySchema,
  type AttachmentChunkOpaque,
  type AttachmentMetadataProtectedContent,
  type AttachmentProtectedMetadata,
  type AttachmentStreamDirection,
  type ChatAttachmentOpaqueSummary,
  type ChatAttachmentSummary,
} from "@cantrip/protocol/attachment-content";

import type { WorkerEncryptionService } from "./worker-encryption.js";

function component(input: {
  service: WorkerEncryptionService;
  keyRevision: number;
}) {
  const material = input.service.componentKey("attachment-content");
  if (material.keyRevision !== input.keyRevision) {
    clearSensitiveBytes(material.key);
    throw new Error("The attachment encryption key revision is unavailable.");
  }
  return material;
}

export async function openWorkerAttachmentMetadata(input: {
  chatId: string;
  attachmentId: string;
  protectedMetadata: AttachmentProtectedMetadata;
  service: WorkerEncryptionService;
}): Promise<AttachmentMetadataProtectedContent> {
  const material = component({
    service: input.service,
    keyRevision: input.protectedMetadata.keyRevision,
  });
  try {
    return await decryptAttachmentMetadata({
      ownerId: input.service.ownerId(),
      chatId: input.chatId,
      attachmentId: input.attachmentId,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      encrypted: input.protectedMetadata,
    });
  } finally {
    clearSensitiveBytes(material.key);
  }
}

export async function openWorkerAttachment(
  raw: unknown,
  service: WorkerEncryptionService,
): Promise<ChatAttachmentSummary & { sha256: string }> {
  const attachment = chatAttachmentOpaqueSummarySchema.parse(raw);
  const metadata = await openWorkerAttachmentMetadata({
    chatId: attachment.chatId,
    attachmentId: attachment.id,
    protectedMetadata: attachment.protectedMetadata,
    service,
  });
  if (
    (attachment.status === "ready" && metadata.error !== null) ||
    (attachment.status === "failed" && metadata.error === null)
  ) {
    throw new Error("Attachment status and protected metadata do not agree.");
  }
  return {
    ...chatAttachmentSummarySchema.parse({
      id: attachment.id,
      chatId: attachment.chatId,
      fileName: metadata.fileName,
      mimeType: metadata.mimeType,
      sizeBytes: attachment.sizeBytes,
      kind: metadata.kind,
      source: metadata.source,
      status: attachment.status,
      previewText: metadata.error ?? metadata.previewText,
      createdAt: attachment.createdAt,
    }),
    sha256: metadata.sha256,
  };
}

export async function openWorkerAttachments(
  attachments: ChatAttachmentOpaqueSummary[],
  service: WorkerEncryptionService,
) {
  return Promise.all(
    attachments.map((attachment) => openWorkerAttachment(attachment, service)),
  );
}

export async function openWorkerAttachmentChunk(input: {
  chatId: string;
  attachmentId: string;
  operationId: string;
  direction: AttachmentStreamDirection;
  chunk: AttachmentChunkOpaque;
  service: WorkerEncryptionService;
}): Promise<Uint8Array> {
  const material = component({
    service: input.service,
    keyRevision: input.chunk.envelope.keyRevision,
  });
  try {
    return await decryptAttachmentChunk({
      ownerId: input.service.ownerId(),
      chatId: input.chatId,
      attachmentId: input.attachmentId,
      operationId: input.operationId,
      direction: input.direction,
      sequence: input.chunk.sequence,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      encrypted: input.chunk,
    });
  } finally {
    clearSensitiveBytes(material.key);
  }
}

export async function protectWorkerAttachmentChunk(input: {
  chatId: string;
  attachmentId: string;
  operationId: string;
  direction: AttachmentStreamDirection;
  sequence: number;
  eof: boolean;
  bytes: Uint8Array;
  service: WorkerEncryptionService;
}): Promise<AttachmentChunkOpaque> {
  const material = input.service.componentKey("attachment-content");
  try {
    return await encryptAttachmentChunk({
      ownerId: input.service.ownerId(),
      chatId: input.chatId,
      attachmentId: input.attachmentId,
      operationId: input.operationId,
      direction: input.direction,
      sequence: input.sequence,
      eof: input.eof,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      plaintext: input.bytes,
    });
  } finally {
    clearSensitiveBytes(material.key);
  }
}

export async function protectWorkerAttachmentMetadata(input: {
  chatId: string;
  attachmentId: string;
  content: AttachmentMetadataProtectedContent;
  service: WorkerEncryptionService;
}): Promise<AttachmentProtectedMetadata> {
  const material = input.service.componentKey("attachment-content");
  try {
    return await encryptAttachmentMetadata({
      ownerId: input.service.ownerId(),
      chatId: input.chatId,
      attachmentId: input.attachmentId,
      keyRevision: material.keyRevision,
      componentKey: material.key,
      content: input.content,
    });
  } finally {
    clearSensitiveBytes(material.key);
  }
}
