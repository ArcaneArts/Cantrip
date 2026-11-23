import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import {
  LOG_TAIL_PAGE_BYTES,
  explorerLogTailSchema,
  type LogTailCursor,
} from "@cantrip/protocol/surface-stream";
import { decodeEditableFileText } from "./editable-file-text.js";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const identity = (stat: BigIntStats) =>
  hash([stat.dev, stat.ino, stat.birthtimeNs].join(":"));
async function readRange(file: FileHandle, start: number, length: number) {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const chunk = await file.read(bytes, read, length - read, start + read);
    if (!chunk.bytesRead)
      throw new Error("The log changed during reading. Try again.");
    read += chunk.bytesRead;
  }
  return bytes;
}
async function anchor(file: FileHandle, offset: number) {
  const length = Math.min(64, offset);
  return hash(await readRange(file, offset - length, length));
}

/** Stateless, bounded tail reads. The cursor detects rotation and copy/truncate. */
export async function readLogTail(
  targetPath: string,
  path: string,
  cursor?: LogTailCursor,
) {
  const file = await open(
    targetPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("This log path is not a file.");
    const size = Number(before.size);
    if (!Number.isSafeInteger(size))
      throw new Error("The log is too large to address safely.");
    const id = identity(before);
    const continuing =
      cursor &&
      cursor.identity === id &&
      cursor.offset <= size &&
      size - cursor.offset <= LOG_TAIL_PAGE_BYTES &&
      (await anchor(file, cursor.offset)) === cursor.anchor;
    const start = continuing
      ? cursor.offset
      : Math.max(0, size - LOG_TAIL_PAGE_BYTES);
    const bytes = await readRange(file, start, size - start);
    let first = 0,
      last = bytes.length;
    if (!continuing && start > 0) {
      // A tail may start inside a UTF-8 character or an old partial line.
      while (first < last && (bytes[first]! & 0xc0) === 0x80) first++;
      const newline = bytes.indexOf(10, first);
      if (newline >= 0 && newline + 1 < last) first = newline + 1;
    }
    // Writers can be between bytes of a UTF-8 character. Retain those bytes
    // on disk for the next poll, rather than displaying replacement glyphs.
    if (last > first) {
      let lead = last - 1;
      while (lead > first && (bytes[lead]! & 0xc0) === 0x80) lead--;
      const byte = bytes[lead]!;
      const width =
        byte >= 0xf0 && byte <= 0xf4
          ? 4
          : byte >= 0xe0 && byte <= 0xef
            ? 3
            : byte >= 0xc2 && byte <= 0xdf
              ? 2
              : 1;
      if (lead + width > last) last = lead;
    }
    const content = decodeEditableFileText(bytes.subarray(first, last));
    const after = await file.stat({ bigint: true });
    if (
      after.size < BigInt(size) ||
      (after.size === before.size && after.mtimeNs !== before.mtimeNs)
    )
      throw new Error("The log changed during reading. Try again.");
    const offset = start + last;
    return explorerLogTailSchema.parse({
      path,
      content,
      startOffset: start + first,
      size,
      reset: !continuing,
      cursor: { offset, identity: id, anchor: await anchor(file, offset) },
    });
  } finally {
    await file.close();
  }
}
