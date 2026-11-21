import { createHash } from "node:crypto";
import { constants, open } from "node:fs/promises";
import path from "node:path";
import {
  chatAttachmentOpaqueSummarySchema,
  type ChatAttachmentOpaqueSummary,
  type ChatMessageContent,
  type NativeHistoryBinding,
  type NativeHistoryItemIdentity,
} from "@cantrip/protocol";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "./attachment-store.js";
import { openWorkerAttachment } from "./attachment-encryption.js";
import { NativeHistoryAttachmentStore } from "./native-history-attachment-store.js";
import { nativeHistoryMediaParts } from "./native-history-media-parts.js";
import {
  readHistoryJson,
  ensureHistoryDirectory,
  serializeHistoryOperation,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";
import type {
  NativeHistoryStateItem,
  NativeHistoryStateTurn,
} from "./native-history-state.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/aiff": "aiff",
  "audio/webm": "webm",
};
const mimeTypes = Object.fromEntries(
  Object.entries(extensions).map(([mime, extension]) => [
    `.${extension}`,
    mime,
  ]),
);
mimeTypes[".jpeg"] = "image/jpeg";
mimeTypes[".tif"] = "image/tiff";

/** Read the opened source, bounded by the ordinary attachment budget. A FIFO or
 * device cannot hang a background history import; no separate existence probe. */
async function readMediaFile(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  const chunks: Buffer[] = [];
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Native media source is not a regular file.");
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(
        Math.min(64 * 1024, MAX_ATTACHMENT_BYTES + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > MAX_ATTACHMENT_BYTES)
        throw new Error("Native media exceeds the attachment size limit.");
    }
    return Buffer.concat(chunks);
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
    await handle.close();
  }
}

function inlineMedia(url: string, kind: "image" | "audio") {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(url);
  if (!match || !match[1]!.startsWith(`${kind}/`))
    throw new Error("Native inline media has an invalid data URL.");
  if (match[2]!.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
    throw new Error("Native media exceeds the attachment size limit.");
  const bytes = Buffer.from(match[2]!, "base64");
  if (
    bytes.length > MAX_ATTACHMENT_BYTES ||
    bytes.toString("base64") !== match[2]
  ) {
    bytes.fill(0);
    throw new Error(
      "Native inline media has invalid or oversized base64 bytes.",
    );
  }
  return { bytes, mimeType: match[1]! };
}

/** Use only after canonical identity resolution. GUI aliases are skipped. Native
 * outputs can supply inline bytes; only user inputs authorize local file reads.
 * External URLs never cause background requests. */
export function createNativeHistoryInputMaterializer(options: {
  directory: string;
  binding: NativeHistoryBinding;
  service: WorkerEncryptionService;
  files: AttachmentStore;
  store: NativeHistoryAttachmentStore;
  publishedAttachments?(
    identity: NativeHistoryItemIdentity,
  ): Promise<ChatAttachmentOpaqueSummary[]>;
}) {
  return async (
    item: NativeHistoryStateItem,
    turn: Omit<NativeHistoryStateTurn, "items">,
    context: { cwd: string },
    canonicalAttachments?: ChatAttachmentOpaqueSummary[],
  ) => {
    const inputParts = new Map<number, ChatMessageContent>();
    const attachments: ChatAttachmentOpaqueSummary[] = [];
    const parts = nativeHistoryMediaParts(item.body);
    if (!parts.length) return { inputParts, attachments };
    const identity: NativeHistoryItemIdentity = {
      threadId: options.binding.threadId,
      turnId: turn.id,
      itemId: item.id,
      identityKind: item.identityKind,
      component: item.body.type === "userMessage" ? "user" : "activity",
    };
    let published = canonicalAttachments;
    for (const [index, value] of parts.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (
        (value.type === "skill" || value.type === "mention") &&
        typeof value.name === "string" &&
        typeof value.path === "string"
      ) {
        inputParts.set(index, [
          {
            type: "text",
            text: `[${value.type === "skill" ? "Skill" : "Mention"}: ${value.name}] ${value.path}`,
          },
        ]);
        continue;
      }
      const kind =
        value.type === "image" || value.type === "localImage"
          ? "image"
          : value.type === "audio" || value.type === "localAudio"
            ? "audio"
            : null;
      if (!kind) continue;
      const local = value.type === "localImage" || value.type === "localAudio";
      if (
        !local &&
        typeof value.url === "string" &&
        !value.url.startsWith("data:")
      )
        continue;
      const sourceKey = hash(
        canonical([
          options.service.serverIdentity(),
          options.service.ownerId(),
          options.binding.chatId,
          options.binding.workerId,
          identity,
          index,
          value,
          local ? context.cwd : null,
        ]),
      );
      const manifest = path.join(options.directory, `${sourceKey}.json`);
      const result = await serializeHistoryOperation(manifest, async () => {
        await ensureHistoryDirectory(options.directory);
        let retained: ChatAttachmentOpaqueSummary | null = null;
        try {
          retained = chatAttachmentOpaqueSummarySchema.parse(
            await readHistoryJson(manifest),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const prior = retained
          ? await openWorkerAttachment(retained, options.service)
          : null;
        if (
          retained &&
          (retained.chatId !== options.binding.chatId ||
            retained.status !== "ready" ||
            prior!.kind !== kind)
        )
          throw new Error("Retained native media belongs to another source.");
        let bytes: Buffer | undefined;
        let mimeType = prior?.mimeType;
        let fileName = prior?.fileName;
        try {
          if (prior) {
            try {
              bytes = await readMediaFile(
                options.files.resolve(
                  options.binding.chatId,
                  prior.id,
                  prior.fileName,
                ),
              );
              if (hash(bytes) !== prior.sha256) {
                bytes.fill(0);
                bytes = undefined;
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
          if (!bytes) {
            if (local) {
              if (typeof value.path !== "string" || !value.path.length)
                throw new Error("Native local media has no source path.");
              if (!path.isAbsolute(value.path) && !path.isAbsolute(context.cwd))
                throw new Error(
                  "Relative native media requires its original working directory.",
                );
              const sourcePath = path.resolve(context.cwd, value.path);
              bytes = await readMediaFile(sourcePath);
              fileName ??= path.basename(sourcePath);
              mimeType ??=
                mimeTypes[path.extname(sourcePath).toLowerCase()] ??
                "application/octet-stream";
            } else {
              if (typeof value.url !== "string")
                throw new Error("Native inline media has no data URL.");
              const decoded = inlineMedia(value.url, kind);
              bytes = decoded.bytes;
              mimeType ??= decoded.mimeType;
              fileName ??= `native-${kind}-${index + 1}.${extensions[mimeType] ?? "bin"}`;
            }
          }
          if (
            prior &&
            (bytes.length !== prior.sizeBytes || hash(bytes) !== prior.sha256)
          )
            throw new Error(
              "The original native media bytes are unavailable; its source file changed.",
            );
          const input: Parameters<
            NativeHistoryAttachmentStore["materialize"]
          >[0] = {
            identity,
            partIndex: index,
            fileName: fileName!,
            mimeType: mimeType!,
            kind,
            bytes,
          };
          let materialized = await options.store.materialize(input);
          if (retained && materialized.attachment.id !== retained.id)
            throw new Error("Retained native media identity changed.");
          if (published || options.publishedAttachments) {
            published ??= await options.publishedAttachments!(identity);
            const descriptor = published.find(
              (entry) => entry.id === materialized.attachment.id,
            );
            if (descriptor)
              materialized = await options.store.materialize({
                ...input,
                publishedAttachment: descriptor,
              });
          }
          if (!retained)
            await writeImmutableHistoryFile(
              manifest,
              JSON.stringify(materialized.attachment),
            );
          const committed = chatAttachmentOpaqueSummarySchema.parse(
            await readHistoryJson(manifest),
          );
          if (
            committed.id !== materialized.attachment.id ||
            committed.chatId !== options.binding.chatId
          )
            throw new Error(
              "Concurrent native media import retained different source bytes.",
            );
          return materialized;
        } finally {
          bytes?.fill(0);
        }
      });
      inputParts.set(index, result.content);
      attachments.push(result.attachment);
    }
    return { inputParts, attachments };
  };
}
