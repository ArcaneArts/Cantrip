import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { workerLogger } from "./logger.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1_024 * 1_024;
export const MAX_ATTACHMENT_CHUNK_BYTES = 256 * 1_024;

interface PendingUpload {
  expectedSize: number;
  finalPath: string;
  nextChunkIndex: number;
  partPath: string;
  receivedSize: number;
}

export interface AttachmentUploadResult {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface AttachmentReadResult {
  bytes: Uint8Array;
  eof: boolean;
  sizeBytes: number;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function safeAttachmentFileName(value: string): string {
  const base = path.basename(value.replaceAll("\\", "/")).normalize("NFKC");
  const sanitized = base
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[^\p{L}\p{N}._()\[\] -]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .slice(0, 180);
  return sanitized || "attachment";
}

export class AttachmentStore {
  readonly #root: string;
  readonly #uploads = new Map<string, PendingUpload>();

  constructor(dataDirectory: string) {
    this.#root = path.resolve(dataDirectory, "attachments");
  }

  async begin(
    chatId: string,
    attachmentId: string,
    fileName: string,
    sizeBytes: number,
  ): Promise<void> {
    const startedAtMs = Date.now();
    this.validateSize(sizeBytes);
    const key = this.uploadKey(chatId, attachmentId);
    if (this.#uploads.has(key)) {
      throw new Error("This attachment upload is already active.");
    }
    const finalPath = this.attachmentPath(chatId, attachmentId, fileName);
    const directory = path.dirname(finalPath);
    const partPath = path.join(directory, ".uploading");
    await mkdir(directory, { recursive: true });
    await rm(partPath, { force: true });
    await writeFile(partPath, new Uint8Array());
    this.#uploads.set(key, {
      expectedSize: sizeBytes,
      finalPath,
      nextChunkIndex: 0,
      partPath,
      receivedSize: 0,
    });
    workerLogger.event("debug", "Attachment upload started", {
      event: "attachment.upload.started",
      subsystem: "attachments",
      operation: "upload",
      status: "started",
      chatId,
      attachmentId,
      durationMs: Date.now() - startedAtMs,
      counts: { bytesExpected: sizeBytes },
    });
  }

  async append(
    chatId: string,
    attachmentId: string,
    chunkIndex: number,
    bytes: Uint8Array,
  ): Promise<void> {
    if (
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      bytes.byteLength > MAX_ATTACHMENT_CHUNK_BYTES
    ) {
      throw new Error("Attachment chunk is invalid.");
    }
    const upload = this.#uploads.get(this.uploadKey(chatId, attachmentId));
    if (!upload) throw new Error("Attachment upload was not started.");
    if (chunkIndex !== upload.nextChunkIndex) {
      throw new Error(
        `Expected attachment chunk ${upload.nextChunkIndex}, received ${chunkIndex}.`,
      );
    }
    if (upload.receivedSize + bytes.byteLength > upload.expectedSize) {
      throw new Error("Attachment upload exceeds its declared size.");
    }
    await appendFile(upload.partPath, bytes);
    upload.nextChunkIndex += 1;
    upload.receivedSize += bytes.byteLength;
  }

  async complete(
    chatId: string,
    attachmentId: string,
  ): Promise<AttachmentUploadResult> {
    const key = this.uploadKey(chatId, attachmentId);
    const upload = this.#uploads.get(key);
    if (!upload) throw new Error("Attachment upload was not started.");
    if (upload.receivedSize !== upload.expectedSize) {
      throw new Error(
        `Attachment upload is incomplete (${upload.receivedSize}/${upload.expectedSize} bytes).`,
      );
    }
    const bytes = await readFile(upload.partPath);
    await rename(upload.partPath, upload.finalPath);
    this.#uploads.delete(key);
    const result = {
      path: upload.finalPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
    };
    workerLogger.event("info", "Attachment upload completed", {
      event: "attachment.upload.completed",
      subsystem: "attachments",
      operation: "upload",
      status: "completed",
      chatId,
      attachmentId,
      counts: {
        bytes: result.sizeBytes,
        chunks: upload.nextChunkIndex,
      },
    });
    return result;
  }

  async read(
    chatId: string,
    attachmentId: string,
    fileName: string,
    offset: number,
    limit: number,
  ): Promise<AttachmentReadResult> {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_ATTACHMENT_CHUNK_BYTES
    ) {
      throw new Error("Attachment read range is invalid.");
    }
    const filePath = this.attachmentPath(chatId, attachmentId, fileName);
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("Attachment is not a file.");
    const bytes = await readFile(filePath);
    const end = Math.min(bytes.byteLength, offset + limit);
    return {
      bytes: bytes.subarray(Math.min(offset, bytes.byteLength), end),
      eof: end >= bytes.byteLength,
      sizeBytes: bytes.byteLength,
    };
  }

  async remove(chatId: string, attachmentId: string): Promise<void> {
    const directory = this.attachmentDirectory(chatId, attachmentId);
    this.#uploads.delete(this.uploadKey(chatId, attachmentId));
    await rm(directory, { recursive: true, force: true });
    workerLogger.event("debug", "Attachment removed", {
      event: "attachment.removed",
      subsystem: "attachments",
      operation: "remove",
      status: "completed",
      chatId,
      attachmentId,
    });
  }

  resolve(chatId: string, attachmentId: string, fileName: string): string {
    return this.attachmentPath(chatId, attachmentId, fileName);
  }

  private attachmentDirectory(chatId: string, attachmentId: string): string {
    const directory = path.resolve(
      this.#root,
      safeSegment(chatId, "Chat id"),
      safeSegment(attachmentId, "Attachment id"),
    );
    if (!directory.startsWith(`${this.#root}${path.sep}`)) {
      throw new Error("Attachment path escapes the worker data directory.");
    }
    return directory;
  }

  private attachmentPath(
    chatId: string,
    attachmentId: string,
    fileName: string,
  ): string {
    return path.join(
      this.attachmentDirectory(chatId, attachmentId),
      safeAttachmentFileName(fileName),
    );
  }

  private uploadKey(chatId: string, attachmentId: string): string {
    return `${safeSegment(chatId, "Chat id")}:${safeSegment(attachmentId, "Attachment id")}`;
  }

  private validateSize(sizeBytes: number): void {
    if (
      !Number.isInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > MAX_ATTACHMENT_BYTES
    ) {
      throw new Error(
        `Attachment size must be between 0 and ${MAX_ATTACHMENT_BYTES} bytes.`,
      );
    }
  }
}
