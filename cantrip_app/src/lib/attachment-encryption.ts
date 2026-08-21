import {
  attachmentContentDigest,
  clearSensitiveBytes,
  decryptAttachmentChunk,
  decryptAttachmentMetadata,
  encryptAttachmentChunk,
  encryptAttachmentMetadata,
} from "@cantrip/crypto";
import {
  ATTACHMENT_MAX_CHUNK_BYTES,
  attachmentDownloadOpaqueSchema,
  attachmentUploadOpaqueSchema,
  chatAttachmentOpaqueListSchema,
  chatAttachmentOpaqueSummarySchema,
  chatAttachmentSummarySchema,
  type AttachmentDownloadOpaque,
  type AttachmentUploadOpaque,
  type ChatAttachmentKind,
  type ChatAttachmentOpaqueSummary,
  type ChatAttachmentSource,
  type ChatAttachmentSummary,
} from "@cantrip/protocol/attachment-content";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

function encryptionContext(options: TrustedOptions) {
  const service = options.service ?? clientEncryption;
  const session = (options.session ?? getClientSession)();
  const snapshot = service.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );
  }
  return {
    componentKey: service.componentKey({
      component: "attachment-content",
      identity: snapshot.identity,
      keyRevision: snapshot.masterKeyRevision,
    }),
    keyRevision: snapshot.masterKeyRevision,
    ownerId: session.user.id,
  };
}

export async function protectAttachmentUpload(
  input: {
    attachmentId: string;
    operationId: string;
    chatId: string;
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
    kind: ChatAttachmentKind;
    source: ChatAttachmentSource;
    previewText: string | null;
  },
  options: TrustedOptions = {},
): Promise<AttachmentUploadOpaque> {
  const context = encryptionContext(options);
  try {
    const protectedMetadata = await encryptAttachmentMetadata({
      ownerId: context.ownerId,
      chatId: input.chatId,
      attachmentId: input.attachmentId,
      keyRevision: context.keyRevision,
      componentKey: context.componentKey,
      content: {
        version: 1,
        fileName: input.fileName,
        mimeType: input.mimeType,
        kind: input.kind,
        source: input.source,
        previewText: input.previewText,
        sha256: attachmentContentDigest(input.bytes),
        error: null,
      },
    });
    const chunks = [];
    const chunkCount = Math.max(
      1,
      Math.ceil(input.bytes.byteLength / ATTACHMENT_MAX_CHUNK_BYTES),
    );
    for (let sequence = 0; sequence < chunkCount; sequence += 1) {
      const offset = sequence * ATTACHMENT_MAX_CHUNK_BYTES;
      chunks.push(
        await encryptAttachmentChunk({
          ownerId: context.ownerId,
          chatId: input.chatId,
          attachmentId: input.attachmentId,
          operationId: input.operationId,
          direction: "upload",
          sequence,
          eof: sequence === chunkCount - 1,
          keyRevision: context.keyRevision,
          componentKey: context.componentKey,
          plaintext: input.bytes.subarray(
            offset,
            offset + ATTACHMENT_MAX_CHUNK_BYTES,
          ),
        }),
      );
    }
    return attachmentUploadOpaqueSchema.parse({
      attachmentId: input.attachmentId,
      operationId: input.operationId,
      sizeBytes: input.bytes.byteLength,
      protectedMetadata,
      chunks,
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function openAttachmentOpaqueSummary(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<ChatAttachmentSummary> {
  const attachment = chatAttachmentOpaqueSummarySchema.parse(raw);
  const context = encryptionContext(options);
  try {
    const metadata = await decryptAttachmentMetadata({
      ownerId: context.ownerId,
      chatId: attachment.chatId,
      attachmentId: attachment.id,
      keyRevision: attachment.protectedMetadata.keyRevision,
      componentKey: context.componentKey,
      encrypted: attachment.protectedMetadata,
    });
    if (
      (attachment.status === "ready" && metadata.error !== null) ||
      (attachment.status === "failed" && metadata.error === null)
    ) {
      throw new Error("Attachment status and protected metadata do not agree.");
    }
    return chatAttachmentSummarySchema.parse({
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
    });
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}

export async function openAttachmentOpaqueList(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<ChatAttachmentSummary[]> {
  return Promise.all(
    chatAttachmentOpaqueListSchema
      .parse(raw)
      .map((attachment) => openAttachmentOpaqueSummary(attachment, options)),
  );
}

async function protectedDigest(
  attachment: ChatAttachmentOpaqueSummary,
  context: ReturnType<typeof encryptionContext>,
): Promise<string> {
  return (
    await decryptAttachmentMetadata({
      ownerId: context.ownerId,
      chatId: attachment.chatId,
      attachmentId: attachment.id,
      keyRevision: attachment.protectedMetadata.keyRevision,
      componentKey: context.componentKey,
      encrypted: attachment.protectedMetadata,
    })
  ).sha256;
}

export async function openAttachmentDownload(
  attachmentRaw: ChatAttachmentSummary,
  downloadRaw: unknown,
  options: TrustedOptions = {},
): Promise<Uint8Array> {
  const attachmentSummary = chatAttachmentSummarySchema.parse(attachmentRaw);
  const download: AttachmentDownloadOpaque =
    attachmentDownloadOpaqueSchema.parse(downloadRaw);
  if (
    download.attachmentId !== attachmentSummary.id ||
    download.sizeBytes !== attachmentSummary.sizeBytes
  ) {
    throw new Error("Attachment download identity does not match.");
  }
  const attachment = chatAttachmentOpaqueSummarySchema.parse({
    id: attachmentSummary.id,
    chatId: attachmentSummary.chatId,
    sizeBytes: attachmentSummary.sizeBytes,
    status: attachmentSummary.status,
    protectedMetadata: download.protectedMetadata,
    createdAt: attachmentSummary.createdAt,
  });
  const context = encryptionContext(options);
  const bytes = new Uint8Array(download.sizeBytes);
  let offset = 0;
  try {
    for (const chunk of download.chunks) {
      const opened = await decryptAttachmentChunk({
        ownerId: context.ownerId,
        chatId: attachment.chatId,
        attachmentId: attachment.id,
        operationId: download.operationId,
        direction: "download",
        sequence: chunk.sequence,
        keyRevision: chunk.envelope.keyRevision,
        componentKey: context.componentKey,
        encrypted: chunk,
      });
      try {
        bytes.set(opened, offset);
        offset += opened.byteLength;
      } finally {
        clearSensitiveBytes(opened);
      }
    }
    if (
      offset !== bytes.byteLength ||
      attachmentContentDigest(bytes) !==
        (await protectedDigest(attachment, context))
    ) {
      throw new Error("Attachment content verification failed.");
    }
    return bytes;
  } catch (error) {
    clearSensitiveBytes(bytes);
    throw error;
  } finally {
    clearSensitiveBytes(context.componentKey);
  }
}
