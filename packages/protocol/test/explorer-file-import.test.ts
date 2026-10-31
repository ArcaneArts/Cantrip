import { expect, it } from "vitest";
import {
  EXPLORER_FILE_IMPORT_CHUNK_BYTES,
  explorerOperationRequestContentSchema,
  explorerOperationResultContentSchema,
} from "../src/surface-stream.js";

const request = {
  type: "explorer.file.import",
  path: "images",
  name: "image.png",
  offset: 0,
  size: 4,
  data: "AP+ACg==",
  eof: true,
};
it("accepts bounded binary chunks, empty files, cancellation, and progress results", () => {
  expect(explorerOperationRequestContentSchema.parse(request)).toEqual(request);
  expect(
    explorerOperationRequestContentSchema.parse({
      ...request,
      name: "empty",
      size: 0,
      data: "",
    }),
  ).toMatchObject({ size: 0 });
  expect(
    explorerOperationRequestContentSchema.parse({
      type: "explorer.file.import.cancel",
    }),
  ).toEqual({ type: "explorer.file.import.cancel" });
  expect(
    explorerOperationResultContentSchema.parse({
      type: "explorer.file.imported",
      value: { offset: 4, entry: null },
    }),
  ).toMatchObject({ value: { offset: 4 } });
});
it.each([
  { name: "../outside" },
  { data: "invalid!" },
  { data: "YQ=" },
  { offset: -1 },
  { size: Number.MAX_SAFE_INTEGER + 1 },
  {
    data: Buffer.alloc(EXPLORER_FILE_IMPORT_CHUNK_BYTES + 3).toString("base64"),
  },
])("rejects invalid or oversized import chunks: %j", (change) => {
  expect(
    explorerOperationRequestContentSchema.safeParse({ ...request, ...change })
      .success,
  ).toBe(false);
});
