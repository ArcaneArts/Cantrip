import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import {
  TEXT_PREVIEW_BYTES_LIMIT,
  TEXT_PREVIEW_PAGE_BYTES,
  TEXT_PREVIEW_PAGE_LINES,
  explorerTextPreviewPageSchema,
} from "@cantrip/protocol/surface-stream";
import { decodeEditableFileText } from "./editable-file-text.js";

export class TextPreviewRequiredError extends Error {
  constructor() {
    super("Open this large file as a read-only text preview.");
  }
}

// Preview revisions are stat identities, deliberately separate from editable
// content hashes. Reading another page must not hash the entire file again.
function previewVersion(stat: BigIntStats): string {
  return createHash("sha256")
    .update(
      [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"),
    )
    .digest("hex");
}

export async function readTextPreviewPage(
  targetPath: string,
  relativePath: string,
  offset: number,
  expectedVersion?: string,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (offset > 0 && !expectedVersion)
  )
    throw new Error("Invalid text preview offset or revision.");
  const file = await open(
    targetPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile())
      throw new Error("This file type is not available for preview.");
    if (before.size > BigInt(TEXT_PREVIEW_BYTES_LIMIT))
      throw new Error("Text previews are limited to 10 MB.");
    const size = Number(before.size);
    const version = previewVersion(before);
    if (expectedVersion && expectedVersion !== version)
      throw new Error(
        "The file changed while previewing. Refresh to load its latest contents.",
      );
    if (offset > size)
      throw new Error("Text preview offset is beyond the file.");
    const bytes = Buffer.alloc(
      Math.min(TEXT_PREVIEW_PAGE_BYTES, size - offset),
    );
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(
        bytes,
        length,
        bytes.length - length,
        offset + length,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (
      length !== bytes.length ||
      previewVersion(await file.stat({ bigint: true })) !== version
    )
      throw new Error(
        "The file changed while previewing. Refresh to load its latest contents.",
      );
    // Stop at a line boundary when possible. Long lines still make progress,
    // without cutting a multibyte UTF-8 character between encrypted pages.
    let lines = 0;
    for (let i = 0; i < length; i++) {
      if (bytes[i] !== 10 && bytes[i] !== 13) continue;
      if (bytes[i] === 13 && bytes[i + 1] === 10) i++;
      if (++lines === TEXT_PREVIEW_PAGE_LINES) {
        length = i + 1;
        break;
      }
    }
    if (offset + length < size && length > 0) {
      let start = length - 1;
      while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
      const lead = bytes[start]!;
      const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (start + width > length) length = start;
    }
    const content = decodeEditableFileText(bytes.subarray(0, length));
    return explorerTextPreviewPageSchema.parse({
      path: relativePath,
      content,
      size,
      offset,
      nextOffset: offset + length,
      eof: offset + length === size,
      version,
    });
  } finally {
    await file.close();
  }
}
