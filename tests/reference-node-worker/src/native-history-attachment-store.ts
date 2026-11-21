import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  attachmentMetadataProtectedContentSchema,
  chatAttachmentOpaqueSummarySchema,
  chatAttachmentSummarySchema,
  nativeHistoryItemIdentitySchema,
  type NativeHistoryBinding,
  type NativeHistoryItemIdentity,
} from "@cantrip/protocol";
import {
  AttachmentStore,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_CHUNK_BYTES,
  safeAttachmentFileName,
} from "./attachment-store.js";
import {
  openWorkerAttachment,
  protectWorkerAttachmentMetadata,
} from "./attachment-encryption.js";
import {
  flushHistoryDirectory,
  ensureHistoryDirectory,
  readHistoryJson,
  serializeHistoryOperation,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function attachmentId(digest: string): string {
  // Existing attachment transfer endpoints use UUID identities.
  const bytes = Buffer.from(digest, "hex").subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Accepts bytes already authorized/materialized by the native input adapter.
 * Never follows paths or URLs from a native item. Ready metadata is returned only
 * after the actual attachment bytes and immutable opaque descriptor are flushed. */
export class NativeHistoryAttachmentStore {
  constructor(
    private readonly options: {
      directory: string;
      binding: NativeHistoryBinding;
      service: WorkerEncryptionService;
      attachments: AttachmentStore;
    },
  ) {}

  async materialize(input: {
    identity: NativeHistoryItemIdentity;
    partIndex: number;
    fileName: string;
    mimeType: string;
    kind: "audio" | "file" | "image" | "text";
    bytes: Uint8Array;
    /** Exact committed descriptor from an authenticated history archive. A new
     * worker must reuse this ciphertext instead of publishing fresh encryption. */
    publishedAttachment?: import("@cantrip/protocol").ChatAttachmentOpaqueSummary;
  }) {
    const identity = nativeHistoryItemIdentitySchema.parse(input.identity);
    const { binding, service, attachments } = this.options;
    if (
      identity.threadId !== binding.threadId ||
      !Number.isSafeInteger(input.partIndex) ||
      input.partIndex < 0
    )
      throw new Error(
        "Native attachment identity does not match its source binding.",
      );
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new Error("Native attachment exceeds the attachment size limit.");
    const bytes = Uint8Array.from(input.bytes);
    try {
      const sha256 = hash(bytes);
      const metadata = attachmentMetadataProtectedContentSchema.parse({
        version: 1,
        fileName: safeAttachmentFileName(input.fileName),
        mimeType: input.mimeType,
        kind: input.kind,
        source: "file",
        previewText: null,
        sha256,
        error: null,
      });
      const id = attachmentId(
        hash(
          JSON.stringify([
            "native-attachment-v1",
            service.serverIdentity(),
            service.ownerId(),
            binding.chatId,
            identity,
            input.partIndex,
            metadata,
          ]),
        ),
      );
      const validateDescriptor = async (raw: unknown) => {
        const descriptor = chatAttachmentOpaqueSummarySchema.parse(raw);
        const opened = await openWorkerAttachment(descriptor, service);
        if (
          descriptor.id !== id ||
          descriptor.chatId !== binding.chatId ||
          descriptor.status !== "ready" ||
          descriptor.sizeBytes !== bytes.byteLength ||
          opened.sha256 !== sha256 ||
          opened.fileName !== metadata.fileName ||
          opened.mimeType !== metadata.mimeType ||
          opened.kind !== metadata.kind ||
          opened.source !== "file"
        )
          throw new Error(
            "Native attachment metadata conflicts with its source.",
          );
        return descriptor;
      };
      const supplied = input.publishedAttachment
        ? await validateDescriptor(input.publishedAttachment)
        : null;
      const directory = path.resolve(
        this.options.directory,
        hash(
          JSON.stringify([
            service.serverIdentity(),
            service.ownerId(),
            binding.workerId,
            binding.chatId,
          ]),
        ),
        id,
      );
      return await serializeHistoryOperation(directory, async () => {
        await ensureHistoryDirectory(directory);
        const manifest = path.join(directory, "attachment.json");
        const publishedManifest = path.join(
          directory,
          "published-attachment.json",
        );
        const readDescriptor = async (file: string) => {
          try {
            return await validateDescriptor(await readHistoryJson(file));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return null;
          }
        };
        const published = await readDescriptor(publishedManifest);
        const local = await readDescriptor(manifest);
        if (supplied && published && !isDeepStrictEqual(supplied, published))
          throw new Error("Published native attachment metadata changed.");
        let saved = supplied ?? published ?? local;
        const file = attachments.resolve(binding.chatId, id, metadata.fileName);
        let verified = false;
        try {
          const stored = await readFile(file);
          try {
            verified =
              stored.byteLength === bytes.byteLength && hash(stored) === sha256;
          } finally {
            stored.fill(0);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!verified) {
          await ensureHistoryDirectory(path.dirname(file));
          const operationId = randomUUID();
          await attachments.begin(
            binding.chatId,
            id,
            metadata.fileName,
            bytes.byteLength,
            operationId,
            sha256,
          );
          try {
            const count = Math.max(
              1,
              Math.ceil(bytes.byteLength / MAX_ATTACHMENT_CHUNK_BYTES),
            );
            for (let index = 0; index < count; index++)
              await attachments.append(
                binding.chatId,
                id,
                index,
                bytes.subarray(
                  index * MAX_ATTACHMENT_CHUNK_BYTES,
                  (index + 1) * MAX_ATTACHMENT_CHUNK_BYTES,
                ),
                operationId,
                index === count - 1,
              );
            await attachments.complete(binding.chatId, id, operationId);
          } catch (error) {
            await attachments.abort(binding.chatId, id, operationId);
            throw error;
          }
        }
        const handle = await open(file, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await flushHistoryDirectory(path.dirname(file));
        if (!saved) {
          const prepared = chatAttachmentOpaqueSummarySchema.parse({
            id,
            chatId: binding.chatId,
            sizeBytes: bytes.byteLength,
            status: "ready",
            createdAt: new Date().toISOString(),
            protectedMetadata: await protectWorkerAttachmentMetadata({
              chatId: binding.chatId,
              attachmentId: id,
              content: metadata,
              service,
            }),
          });
          await writeImmutableHistoryFile(manifest, JSON.stringify(prepared));
          saved = chatAttachmentOpaqueSummarySchema.parse(
            await readHistoryJson(manifest),
          );
        }
        if (supplied && !published) {
          // Preserve the local precommit candidate for crash diagnostics. The
          // separate immutable committed descriptor wins on subsequent opens.
          await writeImmutableHistoryFile(
            publishedManifest,
            JSON.stringify(supplied),
          );
          saved = await validateDescriptor(
            await readHistoryJson(publishedManifest),
          );
          if (!isDeepStrictEqual(saved, supplied))
            throw new Error("Published native attachment metadata changed.");
        }
        saved = await validateDescriptor(saved);
        const opened = await openWorkerAttachment(saved, service);
        return {
          attachment: saved,
          content: [
            {
              type: "attachment" as const,
              attachment: chatAttachmentSummarySchema.parse(opened),
            },
          ],
        };
      });
    } finally {
      bytes.fill(0);
    }
  }
}
