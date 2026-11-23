import { expect, it } from "vitest";
import {
  explorerOperationRequestContentSchema,
  explorerOperationResultContentSchema,
  surfaceOperationOutcomeContentSchema,
  TEXT_PREVIEW_BYTES_LIMIT,
  TEXT_PREVIEW_PAGE_BYTES,
} from "../src/surface-stream.js";
const page = {
  path: "large.rs",
  content: "text",
  offset: 0,
  nextOffset: 4,
  size: TEXT_PREVIEW_BYTES_LIMIT,
  eof: false,
  version: "a".repeat(64),
};
it("validates bounded read-only page requests and results on the existing encrypted stream", () => {
  expect(
    explorerOperationRequestContentSchema.parse({
      type: "explorer.file.preview",
      path: page.path,
      offset: 0,
    }),
  ).toEqual({ type: "explorer.file.preview", path: page.path, offset: 0 });
  expect(
    explorerOperationResultContentSchema.parse({
      type: "explorer.file.preview",
      value: page,
    }).value,
  ).toEqual(page);
  expect(
    surfaceOperationOutcomeContentSchema.parse({
      ok: false,
      error: "Large file",
      code: "text-preview-required",
    }),
  ).toMatchObject({ code: "text-preview-required" });
});
it.each([-1, 1.5, TEXT_PREVIEW_BYTES_LIMIT + 1])(
  "rejects invalid offsets: %s",
  (offset) => {
    expect(
      explorerOperationRequestContentSchema.safeParse({
        type: "explorer.file.preview",
        path: page.path,
        offset,
      }).success,
    ).toBe(false);
  },
);
it("rejects oversized content and unknown request fields", () => {
  expect(
    explorerOperationResultContentSchema.safeParse({
      type: "explorer.file.preview",
      value: { ...page, content: "a".repeat(TEXT_PREVIEW_PAGE_BYTES + 1) },
    }).success,
  ).toBe(false);
  expect(
    explorerOperationRequestContentSchema.safeParse({
      type: "explorer.file.preview",
      path: page.path,
      offset: 0,
      root: "/other",
    }).success,
  ).toBe(false);
});
