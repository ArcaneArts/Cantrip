import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  externalChatAttachmentReadResultSchema,
  externalChatAttachmentSchema,
  type ExternalChatAttachment,
  type ExternalChatAttachmentReadResult,
} from "@cantrip/protocol";

const MAX_ATTACHMENT_BYTES = 25 * 1_024 * 1_024;
export const MAX_EXTERNAL_CHAT_ATTACHMENT_BYTES = 100 * 1_024 * 1_024;
const STAGING_TTL_MS = 7 * 24 * 60 * 60_000;

export interface ExternalChatAttachmentCandidate {
  id: string;
  itemId: string;
  kind: "audio" | "image";
  path: string | null;
  remoteUrl: string | null;
}

interface StoredExternalChatAttachment {
  descriptor: ExternalChatAttachment;
  stagedAt: string;
}

function safeHash(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function threadSegment(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex");
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function safeFileName(candidate: string, kind: "audio" | "image"): string {
  const base = path
    .basename(candidate)
    .replace(/[\u0000-\u001f]/gu, "")
    .trim();
  return (base || `imported-${kind}`).slice(0, 200);
}

function detectMedia(
  bytes: Uint8Array,
): { kind: "audio" | "image"; mimeType: string } | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  const ascii = Buffer.from(bytes).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return { kind: "image", mimeType: "image/gif" };
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return { kind: "image", mimeType: "image/webp" };
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") {
    return { kind: "audio", mimeType: "audio/wav" };
  }
  if (ascii.startsWith("OggS")) {
    return { kind: "audio", mimeType: "audio/ogg" };
  }
  if (
    ascii.startsWith("ID3") ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  ) {
    return { kind: "audio", mimeType: "audio/mpeg" };
  }
  if (bytes.length >= 12 && ascii.slice(4, 8) === "ftyp") {
    return { kind: "audio", mimeType: "audio/mp4" };
  }
  return null;
}

function unavailable(
  candidate: ExternalChatAttachmentCandidate,
  status: "missing" | "unsafe" | "unsupported",
  warning: string,
  fileName = `imported-${candidate.kind}`,
): ExternalChatAttachment {
  return externalChatAttachmentSchema.parse({
    id: candidate.id,
    itemId: candidate.itemId,
    fileName,
    mimeType:
      candidate.kind === "image"
        ? "application/x-image"
        : "application/x-audio",
    sizeBytes: 0,
    kind: candidate.kind,
    status,
    sha256: null,
    warning,
  });
}

export class ExternalChatAttachmentStagingStore {
  readonly #root: string;

  constructor(managedDataDirectory: string) {
    this.#root = path.resolve(managedDataDirectory, "external-chat-imports");
  }

  async stage(
    sourceId: string,
    sourceThreadId: string,
    candidate: ExternalChatAttachmentCandidate,
    allowedRoots: string[],
    remainingBytes: number,
  ): Promise<ExternalChatAttachment> {
    if (candidate.remoteUrl) {
      let remoteFileName = `imported-${candidate.kind}`;
      try {
        remoteFileName = safeFileName(
          new URL(candidate.remoteUrl).pathname,
          candidate.kind,
        );
      } catch {
        // The reference remains a visible unsupported placeholder.
      }
      return unavailable(
        candidate,
        "unsupported",
        "Remote media references are not downloaded during import.",
        remoteFileName,
      );
    }
    if (!candidate.path) {
      return unavailable(
        candidate,
        "missing",
        "The original attachment path is unavailable.",
      );
    }
    const fileName = safeFileName(candidate.path, candidate.kind);
    let canonicalPath: string;
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      canonicalPath = await realpath(candidate.path);
      fileStat = await stat(canonicalPath);
    } catch {
      return unavailable(
        candidate,
        "missing",
        "The original attachment file no longer exists.",
        fileName,
      );
    }
    const canonicalRoots = await Promise.all(
      [...allowedRoots, tmpdir()].map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return path.resolve(root);
        }
      }),
    );
    if (!canonicalRoots.some((root) => pathContains(root, canonicalPath))) {
      return unavailable(
        candidate,
        "unsafe",
        "The attachment is outside the project and temporary-file boundaries allowed for import.",
        fileName,
      );
    }
    if (!fileStat.isFile()) {
      return unavailable(
        candidate,
        "unsafe",
        "The attachment is not a regular file.",
        fileName,
      );
    }
    if (
      typeof process.getuid === "function" &&
      typeof fileStat.uid === "number" &&
      fileStat.uid !== process.getuid()
    ) {
      return unavailable(
        candidate,
        "unsafe",
        "The attachment is not owned by the worker user.",
        fileName,
      );
    }
    if (
      fileStat.size > MAX_ATTACHMENT_BYTES ||
      fileStat.size > remainingBytes
    ) {
      return unavailable(
        candidate,
        "unsafe",
        fileStat.size > MAX_ATTACHMENT_BYTES
          ? "The attachment exceeds Cantrip's 25 MB file limit."
          : "The chat's attachments exceed Cantrip's 100 MB import limit.",
        fileName,
      );
    }

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(
        canonicalPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size !== fileStat.size) {
        return unavailable(
          candidate,
          "unsafe",
          "The attachment changed while it was being validated.",
          fileName,
        );
      }
      const bytes = await handle.readFile();
      const detected = detectMedia(bytes.subarray(0, 16));
      if (!detected || detected.kind !== candidate.kind) {
        return unavailable(
          candidate,
          "unsupported",
          `The attachment content is not a supported ${candidate.kind} format.`,
          fileName,
        );
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const directory = this.attachmentDirectory(
        sourceId,
        sourceThreadId,
        candidate.id,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const contentPath = path.join(directory, "content");
      const temporaryPath = path.join(
        directory,
        `.content-${randomUUID()}.tmp`,
      );
      await writeFile(temporaryPath, bytes, { mode: 0o600 });
      await rename(temporaryPath, contentPath);
      const descriptor = externalChatAttachmentSchema.parse({
        id: candidate.id,
        itemId: candidate.itemId,
        fileName,
        mimeType: detected.mimeType,
        sizeBytes: bytes.byteLength,
        kind: candidate.kind,
        status: "available",
        sha256,
        warning: null,
      });
      await writeFile(
        path.join(directory, "metadata.json"),
        `${JSON.stringify({ descriptor, stagedAt: new Date().toISOString() } satisfies StoredExternalChatAttachment)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return descriptor;
    } catch {
      return unavailable(
        candidate,
        "missing",
        "The attachment could not be read from its original location.",
        fileName,
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async read(
    sourceId: string,
    sourceThreadId: string,
    attachmentId: string,
    offset: number,
    limit: number,
  ): Promise<ExternalChatAttachmentReadResult> {
    try {
      const directory = this.attachmentDirectory(
        sourceId,
        sourceThreadId,
        attachmentId,
      );
      const stored = JSON.parse(
        await readFile(path.join(directory, "metadata.json"), "utf8"),
      ) as StoredExternalChatAttachment;
      const descriptor = externalChatAttachmentSchema.parse(stored.descriptor);
      if (descriptor.status !== "available" || !descriptor.sha256) {
        throw new Error("The staged attachment is unavailable.");
      }
      const handle = await open(
        path.join(directory, "content"),
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      try {
        const contentStat = await handle.stat();
        if (
          !contentStat.isFile() ||
          contentStat.size !== descriptor.sizeBytes
        ) {
          throw new Error("The staged attachment size changed.");
        }
        const expectedBytes = Math.min(
          limit,
          Math.max(descriptor.sizeBytes - offset, 0),
        );
        const bytes = Buffer.allocUnsafe(expectedBytes);
        const { bytesRead } = await handle.read(
          bytes,
          0,
          expectedBytes,
          offset,
        );
        if (bytesRead !== expectedBytes) {
          throw new Error("The staged attachment was truncated.");
        }
        return externalChatAttachmentReadResultSchema.parse({
          status: "available",
          data: bytes.toString("base64"),
          eof: offset + bytesRead >= descriptor.sizeBytes,
          sizeBytes: descriptor.sizeBytes,
          sha256: descriptor.sha256,
        });
      } finally {
        await handle.close();
      }
    } catch {
      return externalChatAttachmentReadResultSchema.parse({
        status: "unavailable",
        warning:
          "The staged attachment is no longer available on the source worker.",
      });
    }
  }

  async release(sourceId: string, sourceThreadId: string): Promise<void> {
    await rm(this.threadDirectory(sourceId, sourceThreadId), {
      recursive: true,
      force: true,
    });
  }

  async cleanupExpired(now = Date.now()): Promise<void> {
    let sources: string[];
    try {
      sources = await readdir(this.#root);
    } catch {
      return;
    }
    for (const source of sources) {
      const sourceDirectory = path.join(this.#root, source);
      let threads: string[];
      try {
        threads = await readdir(sourceDirectory);
      } catch {
        continue;
      }
      for (const thread of threads) {
        const directory = path.join(sourceDirectory, thread);
        try {
          if (now - (await stat(directory)).mtimeMs > STAGING_TTL_MS) {
            await rm(directory, { recursive: true, force: true });
          }
        } catch {
          // A concurrent release may remove staging while cleanup is running.
        }
      }
    }
  }

  private threadDirectory(sourceId: string, sourceThreadId: string): string {
    return path.join(
      this.#root,
      safeHash(sourceId, "External source id"),
      threadSegment(sourceThreadId),
    );
  }

  private attachmentDirectory(
    sourceId: string,
    sourceThreadId: string,
    attachmentId: string,
  ): string {
    return path.join(
      this.threadDirectory(sourceId, sourceThreadId),
      safeHash(attachmentId, "External attachment id"),
    );
  }
}
