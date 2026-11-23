import { expect, it } from "vitest";
import {
  explorerOperationRequestContentSchema,
  explorerOperationResultContentSchema,
  LOG_TAIL_PAGE_BYTES,
} from "../src/surface-stream.js";
const cursor = { offset: 42, identity: "a".repeat(64), anchor: "b".repeat(64) };
it("validates incremental tail requests and bounded encrypted results", () => {
  expect(
    explorerOperationRequestContentSchema.parse({
      type: "explorer.file.tail",
      path: "server.log",
      cursor,
    }),
  ).toMatchObject({ cursor });
  const result = {
    type: "explorer.file.tail",
    value: {
      path: "server.log",
      content: "line",
      startOffset: 42,
      size: 46,
      reset: false,
      cursor: { ...cursor, offset: 46 },
    },
  };
  expect(explorerOperationResultContentSchema.parse(result)).toEqual(result);
  expect(
    explorerOperationResultContentSchema.safeParse({
      ...result,
      value: { ...result.value, content: "a".repeat(LOG_TAIL_PAGE_BYTES + 1) },
    }).success,
  ).toBe(false);
});
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid cursors: %s",
  (offset) => {
    expect(
      explorerOperationRequestContentSchema.safeParse({
        type: "explorer.file.tail",
        path: "server.log",
        cursor: { ...cursor, offset },
      }).success,
    ).toBe(false);
  },
);
it("rejects extra authority fields and incomplete cursor fingerprints", () => {
  expect(
    explorerOperationRequestContentSchema.safeParse({
      type: "explorer.file.tail",
      path: "server.log",
      root: "/elsewhere",
    }).success,
  ).toBe(false);
  expect(
    explorerOperationRequestContentSchema.safeParse({
      type: "explorer.file.tail",
      path: "server.log",
      cursor: { offset: 0 },
    }).success,
  ).toBe(false);
});
