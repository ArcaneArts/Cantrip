import { createHash, createHmac, randomUUID } from "node:crypto";
import { clearSensitiveBytes } from "@cantrip/crypto";
import type {
  ChatAttachmentOpaqueSummary,
  ChatAttachmentSummary,
} from "@cantrip/protocol";
import {
  AttachmentStore,
  MAX_ATTACHMENT_CHUNK_BYTES,
  safeAttachmentFileName,
} from "./attachment-store.js";
import { protectWorkerAttachmentMetadata } from "./attachment-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import type { NativeQueueUserInput } from "./managed-queue-input.js";

export interface ManagedQueueAttachmentMapping {
  id: string;
  index: number;
}

/** Store portable native media through the same worker attachment path as GUI uploads. */
export async function projectManagedQueueMedia(options: {
  input: NativeQueueUserInput[];
  chatId: string;
  promptId: string;
  operationId: string;
  encryption: WorkerEncryptionService;
  store?: AttachmentStore;
  representedIndices?: ReadonlySet<number>;
  fileNames?: ReadonlyMap<number, string>;
}): Promise<{
  attachments: ChatAttachmentOpaqueSummary[];
  summaries: ChatAttachmentSummary[];
  attachmentMap: ManagedQueueAttachmentMapping[];
}> {
  const attachments: ChatAttachmentOpaqueSummary[] = [];
  const summaries: ChatAttachmentSummary[] = [];
  const attachmentMap: ManagedQueueAttachmentMapping[] = [];
  for (const [index, item] of options.input.entries()) {
    if (options.representedIndices?.has(index)) continue;
    if (item.type !== "image" && item.type !== "audio") continue;
    // External URLs remain in the exact native input. Reading a remote resource
    // here would change its authorization/fetch semantics; only supplied bytes
    // become owned downloadable attachments.
    if (!item.url.startsWith("data:")) continue;
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(
      item.url,
    );
    if (!match)
      throw new Error("Queued inline media must contain a base64 data URL.");
    if (!options.store)
      throw new Error("The managed queue attachment store is unavailable.");
    const bytes = Buffer.from(match[2]!, "base64");
    const mimeType = match[1]!;
    // Changed bytes must never overwrite a previously accepted attachment when
    // an operation ID is reused. A keyed content identity prevents both that
    // overwrite and offline guessing of private media from public identifiers.
    const material = options.encryption.componentKey("attachment-content");
    let identity: string;
    try {
      identity = createHmac("sha256", material.key)
        .update(
          JSON.stringify([
            "managed-queue-media",
            options.encryption.serverIdentity(),
            options.encryption.ownerId(),
            options.chatId,
            options.promptId,
            options.operationId,
            index,
            mimeType,
            options.fileNames?.get(index) ?? null,
          ]),
        )
        .update(bytes)
        .digest("hex");
    } finally {
      clearSensitiveBytes(material.key);
    }
    const attachmentId = `queue-${identity}`;
    const fileName = safeAttachmentFileName(
      options.fileNames?.get(index) ??
        `queued-${item.type}-${index + 1}.${({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg" } as Record<string, string>)[mimeType] ?? "bin"}`,
    );
    const uploadId = randomUUID();
    try {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await options.store.begin(
        options.chatId,
        attachmentId,
        fileName,
        bytes.length,
        uploadId,
        sha256,
      );
      const chunks = Math.max(
        1,
        Math.ceil(bytes.length / MAX_ATTACHMENT_CHUNK_BYTES),
      );
      for (let sequence = 0; sequence < chunks; sequence++) {
        await options.store.append(
          options.chatId,
          attachmentId,
          sequence,
          bytes.subarray(
            sequence * MAX_ATTACHMENT_CHUNK_BYTES,
            (sequence + 1) * MAX_ATTACHMENT_CHUNK_BYTES,
          ),
          uploadId,
          sequence === chunks - 1,
        );
      }
      await options.store.complete(options.chatId, attachmentId, uploadId);
      const createdAt = new Date().toISOString();
      const summary: ChatAttachmentSummary = {
        id: attachmentId,
        chatId: options.chatId,
        fileName,
        mimeType,
        sizeBytes: bytes.length,
        kind: item.type,
        source: "file",
        status: "ready",
        previewText: null,
        createdAt,
      };
      summaries.push(summary);
      attachments.push({
        id: attachmentId,
        chatId: options.chatId,
        sizeBytes: bytes.length,
        status: "ready",
        createdAt,
        protectedMetadata: await protectWorkerAttachmentMetadata({
          chatId: options.chatId,
          attachmentId,
          service: options.encryption,
          content: {
            version: 1,
            fileName,
            mimeType,
            kind: item.type,
            source: "file",
            previewText: null,
            sha256,
            error: null,
          },
        }),
      });
      attachmentMap.push({ id: attachmentId, index });
    } catch (error) {
      try {
        await options.store.abort(options.chatId, attachmentId, uploadId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Queued media upload failed and its temporary upload could not be removed.",
        );
      }
      throw error;
    } finally {
      bytes.fill(0);
    }
  }
  return { attachments, summaries, attachmentMap };
}
