import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import {
  explorerBinaryPageSchema,
  explorerBinaryReadSchema,
} from "@cantrip/protocol/surface-stream";

export class BinaryFileChangedError extends Error {
  constructor() {
    super(
      "The file changed while reading. Reopen it to load its latest version.",
    );
  }
}
export function binaryFileVersion(stat: BigIntStats) {
  return (
    "binary-v1:" +
    createHash("sha256")
      .update(
        [
          stat.dev,
          stat.ino,
          stat.size,
          stat.mtimeNs,
          stat.ctimeNs,
          stat.birthtimeNs,
        ].join(":"),
      )
      .digest("hex")
  );
}
/** Every range owns/closes its handle. No snapshots or descriptors leak on disconnect. */
export async function readBinaryFilePage(
  targetPath: string,
  relativePath: string,
  offset: number,
  limit: number,
  expectedVersion?: string,
) {
  explorerBinaryReadSchema.parse({
    path: relativePath,
    offset,
    limit,
    version: expectedVersion,
  });
  const file = await open(
    targetPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile())
      throw new Error("Binary reading requires a regular file.");
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("The file exceeds supported byte addressing.");
    const size = Number(before.size),
      revision = binaryFileVersion(before);
    if (expectedVersion && expectedVersion !== revision)
      throw new BinaryFileChangedError();
    if (offset > size)
      throw new Error("Binary read offset is beyond the file.");
    const bytes = Buffer.alloc(Math.min(limit, size - offset));
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
      binaryFileVersion(await file.stat({ bigint: true })) !== revision
    )
      throw new BinaryFileChangedError();
    return explorerBinaryPageSchema.parse({
      path: relativePath,
      size,
      offset,
      nextOffset: offset + length,
      eof: offset + length === size,
      version: revision,
      data: bytes.toString("base64"),
    });
  } finally {
    await file.close();
  }
}
