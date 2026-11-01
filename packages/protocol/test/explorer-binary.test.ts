import { expect, it } from "vitest";
import {
  BINARY_FILE_PAGE_BYTES,
  explorerOperationRequestContentSchema,
  explorerOperationResultContentSchema,
  SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT,
} from "../src/surface-stream.js";
const version = "binary-v1:" + "a".repeat(64);
const request = {
  type: "explorer.binary.read",
  path: "data.nbt",
  offset: 0,
  limit: 256 * 1024,
};
it("admits bounded binary reads without text file-size restrictions", () => {
  expect(explorerOperationRequestContentSchema.parse(request)).toEqual(request);
  const page = {
    type: "explorer.binary",
    value: {
      path: "data.nbt",
      offset: 1024 ** 3,
      nextOffset: 1024 ** 3 + 1,
      size: 2 * 1024 ** 3,
      eof: false,
      version,
      data: "AA==",
    },
  };
  expect(explorerOperationResultContentSchema.parse(page)).toEqual(page);
  expect(BINARY_FILE_PAGE_BYTES).toBeLessThan(
    SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT,
  );
});
it.each([
  { offset: -1 },
  { limit: 0 },
  { limit: BINARY_FILE_PAGE_BYTES + 1 },
  { offset: 1 },
  { offset: Number.MAX_SAFE_INTEGER + 1 },
  { version: "wrong-version" },
])("rejects malformed binary requests %j", (patch) => {
  expect(
    explorerOperationRequestContentSchema.safeParse({ ...request, ...patch })
      .success,
  ).toBe(false);
});
it.each([
  { data: "bad" },
  { nextOffset: 3 },
  { size: 0 },
  { eof: false },
  { data: "", nextOffset: 0 },
])("rejects inconsistent binary replies %j", (patch) => {
  const page = {
    path: "data.nbt",
    offset: 0,
    nextOffset: 1,
    size: 1,
    eof: true,
    version,
    data: "AA==",
    ...patch,
  };
  expect(
    explorerOperationResultContentSchema.safeParse({
      type: "explorer.binary",
      value: page,
    }).success,
  ).toBe(false);
});
