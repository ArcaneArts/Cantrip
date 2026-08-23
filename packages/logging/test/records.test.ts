import { describe, expect, it } from "vitest";

import {
  minimizeServiceLogRecordInput,
  normalizeLogError,
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

  it("redacts the complete remotely readable credential boundary", () => {
    const sanitized = sanitizeLogContext({
      cookie: "session=private-cookie",
      credential: "provider-credential",
      csrfToken: "private-csrf",
      deviceCode: "private-device-code",
      enrollmentCode: "private-enrollment-code",
      oauthCode: "private-oauth-code",
      pairingCode: "private-pairing-code",
      privateKey: "private-key-material",
      refreshToken: "private-refresh-token",
      signedUrl: "https://download.test/artifact?signature=private",
      nested: {
        endpoint:
          "https://reader:password@example.test/path?access_token=private-access&view=all",
        error: Object.assign(
          new Error("Authorization: Bearer private-bearer"),
          {
            cause: new Error("password=private-password"),
            responseBody: "private provider body",
          },
        ),
        safe: "kept",
      },
    });
    const encoded = JSON.stringify(sanitized);
    for (const privateValue of [
      "private-cookie",
      "provider-credential",
      "private-csrf",
      "private-device-code",
      "private-enrollment-code",
      "private-oauth-code",
      "private-pairing-code",
      "private-key-material",
      "private-refresh-token",
      "signature=private",
      "reader:password",
      "private-access",
      "private-bearer",
      "private-password",
      "private provider body",
    ]) {
      expect(encoded).not.toContain(privateValue);
    }
    expect(sanitized).toMatchObject({ nested: { safe: "kept" } });
  });

  it("strips terminal control sequences while preserving readable text", () => {
    expect(sanitizeLogText("\u001b[31merror\u001b[0m\u0000 ok")).toBe(
      "error ok",
    );
  });

  it("normalizes errors without stacks, causes, or secret-bearing fields", () => {
    const error = Object.assign(new Error("oauthCode=private-value"), {
      code: "AUTH_FAILED",
      cause: { accessToken: "unsafe" },
    });
    expect(normalizeLogError(error)).toEqual({
      name: "Error",
      message: "oauthCode=[REDACTED]",
      code: "AUTH_FAILED",
    });
    expect(JSON.stringify(sanitizeLogContext({ error }))).not.toContain(
      "private-value",
    );
    expect(JSON.stringify(sanitizeLogContext({ error }))).not.toContain(
      "cause",
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
        expect.objectContaining({ cursor: 3, message: "worker.diagnostic" }),
        expect.objectContaining({ cursor: 4, message: "worker.diagnostic" }),
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
      records: [
        expect.objectContaining({ cursor: 2, message: "worker.diagnostic" }),
      ],
      nextCursor: 3,
      latestCursor: 3,
      hasMore: false,
    });
  });

  it("persists only event-coded operational metadata", () => {
    const buffer = new ServiceLogBuffer({
      maxBytes: 1_000,
      maxEntries: 10,
      maxRecordBytes: 1_000,
    });
    const record = buffer.append({
      ...baseRecord,
      message: "failed /Users/private/project with prompt secret-prompt-body",
      context: {
        event: "worker.command.failed",
        operation: "execute",
        requestId: "opaque-request-id",
        path: "/api/workers/command",
        extra: "provider-response-secret",
        error: new Error("raw-error-secret"),
      },
    });
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(
      1_000,
    );
    expect(record).toMatchObject({
      message: "worker.command.failed",
      context: {
        event: "worker.command.failed",
        operation: "execute",
        requestId: "opaque-request-id",
        path: "/api/workers/command",
        errorClass: "Error",
      },
    });
    expect(JSON.stringify(record)).not.toMatch(
      /private|secret-prompt-body|provider-response-secret|raw-error-secret/u,
    );

    const filesystemRecord = buffer.append({
      ...baseRecord,
      context: {
        event: "worker.command.failed",
        path: "/Users/private/project",
      },
    });
    expect(filesystemRecord.context).not.toHaveProperty("path");
  });

  it("persists only stable destination rejection codes", () => {
    const persisted = minimizeServiceLogRecordInput({
      ...baseRecord,
      context: {
        event: "direct_attachment.telemetry.recorded",
        lastDestinationRejectionCode: "protected-record-unavailable",
      },
    });
    expect(persisted.context).toMatchObject({
      lastDestinationRejectionCode: "protected-record-unavailable",
    });

    const nonProtected = minimizeServiceLogRecordInput({
      ...baseRecord,
      context: {
        event: "direct_attachment.telemetry.recorded",
        lastDestinationRejectionCode: "target-rejected",
      },
    });
    expect(nonProtected.context).toMatchObject({
      lastDestinationRejectionCode: "target-rejected",
    });

    const untrusted = minimizeServiceLogRecordInput({
      ...baseRecord,
      context: {
        event: "direct_attachment.telemetry.recorded",
        lastDestinationRejectionCode: "secret-bearing-arbitrary-value",
      },
    });
    expect(untrusted.context).not.toHaveProperty(
      "lastDestinationRejectionCode",
    );
  });
});
