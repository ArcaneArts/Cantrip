import { describe, expect, it } from "vitest";

import {
  sanitizeLogContext,
  sanitizeLogText,
  ServiceLogBuffer,
} from "../src/index.js";

const baseRecord = {
  timestamp: "2026-08-16T12:00:00.000Z",
  system: "worker",
  level: "info" as const,
  message: "Ready",
};

describe("structured service logs", () => {
  it("redacts common credentials in fields, headers, tokens, and URLs", () => {
    expect(
      sanitizeLogContext({
        authorization: "Bearer very-secret-token",
        apiKey: "sk-secret-provider-value",
        nested: {
          password: "hunter2",
          safe: "kept",
        },
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", safe: "kept" },
    });
    expect(
      sanitizeLogText(
        "Authorization: Bearer abc123 https://example.com/path?token=secret&view=all sk-abcdefghijk",
      ),
    ).toBe(
      "Authorization: [REDACTED] https://example.com/path?token=%5BREDACTED%5D&view=all [REDACTED]",
    );
  });

  it("strips terminal control sequences while preserving readable text", () => {
    expect(sanitizeLogText("\u001b[31merror\u001b[0m\u0000 ok")).toBe(
      "error ok",
    );
  });

  it("bounds entries and reports when a reader cursor fell behind", () => {
    const buffer = new ServiceLogBuffer({ maxEntries: 2, maxBytes: 10_000 });
    buffer.append({ ...baseRecord, message: "one" });
    buffer.append({ ...baseRecord, message: "two" });
    buffer.append({ ...baseRecord, message: "three" });
    buffer.append({ ...baseRecord, message: "four" });

    expect(buffer.read({ afterCursor: 1 })).toMatchObject({
      records: [
        expect.objectContaining({ cursor: 3, message: "three" }),
        expect.objectContaining({ cursor: 4, message: "four" }),
      ],
      nextCursor: 4,
      oldestCursor: 3,
      latestCursor: 4,
      truncated: true,
    });
    expect(buffer.read({ afterCursor: 0 })).toMatchObject({
      oldestCursor: 3,
      truncated: false,
    });
  });

  it("advances cursors past filtered records without replaying them", () => {
    const buffer = new ServiceLogBuffer();
    buffer.append({ ...baseRecord, level: "debug", message: "hidden" });
    buffer.append({ ...baseRecord, level: "warn", message: "shown" });
    buffer.append({ ...baseRecord, level: "info", message: "also hidden" });

    expect(buffer.read({ minimumLevel: "warn" })).toMatchObject({
      records: [expect.objectContaining({ cursor: 2, message: "shown" })],
      nextCursor: 3,
      latestCursor: 3,
      hasMore: false,
    });
  });

  it("caps each serialized record independently", () => {
    const buffer = new ServiceLogBuffer({
      maxBytes: 1_000,
      maxEntries: 10,
      maxRecordBytes: 180,
    });
    const record = buffer.append({
      ...baseRecord,
      message: "x".repeat(1_000),
      context: { extra: "y".repeat(1_000) },
    });
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(180);
    expect(record.context).toBeUndefined();
    expect(record.message.endsWith("…")).toBe(true);
  });
});
