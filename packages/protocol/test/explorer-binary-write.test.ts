import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  binaryWriteReceiptSchema,
  binaryWriteChunkSchema,
  explorerOperationRequestContentSchema,
  explorerOperationResultContentSchema,
  BINARY_WRITE_CHUNK_BYTES,
} from "../src/surface-stream.js";
it("carries binary save operations inside the protected file surface without increasing message limits", () => {
  const path = "world.nbt",
    uploadId = randomUUID(),
    version = "binary-v1:" + "a".repeat(64),
    sha256 = "b".repeat(64);
  for (const request of [
    { type: "explorer.binary.write.begin", path, uploadId, version },
    {
      type: "explorer.binary.write.chunk",
      path,
      uploadId,
      offset: 0,
      final: true,
      data: Buffer.from("bytes").toString("base64"),
    },
    { type: "explorer.binary.write.commit", path, uploadId, size: 5, sha256 },
    { type: "explorer.binary.write.status", path, uploadId },
    { type: "explorer.binary.write.abort", path, uploadId },
  ])
    expect(explorerOperationRequestContentSchema.parse(request)).toEqual(
      request,
    );
  const value = {
    path,
    uploadId,
    state: "committed",
    offset: 5,
    size: 5,
    sha256,
    version: "binary-sha256:" + sha256,
    error: null,
  };
  expect(
    explorerOperationResultContentSchema.parse({
      type: "explorer.binary.write",
      value,
    }),
  ).toEqual({ type: "explorer.binary.write", value });
  expect(
    binaryWriteReceiptSchema.safeParse({ ...value, version: null }).success,
  ).toBe(false);
  expect(
    binaryWriteChunkSchema.safeParse({
      type: "explorer.binary.write.chunk",
      path,
      uploadId,
      offset: 0,
      final: true,
      data: Buffer.alloc(BINARY_WRITE_CHUNK_BYTES + 4).toString("base64"),
    }).success,
  ).toBe(false);
});
