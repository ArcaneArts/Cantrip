import {
  agentActivityRawEnvelopeSchema,
  agentActivityRawRequestLimitBytes,
  agentActivityRawResponseLimitBytes,
} from "@cantrip/protocol";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createAgentActivityRawEnvelope } from "../src/codex/raw-capture.js";

describe("protected agent activity raw capture", () => {
  it("redacts credential keys and recognizable token values", () => {
    const envelope = createAgentActivityRawEnvelope({
      request: {
        Authorization: "Bearer secret-value",
        nested: { api_key: "sk-supersecret123", query: "safe" },
      },
      response: "token=visible-secret safe-result",
      metadata: { cookie: "session=secret", requestId: "request-1" },
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("supersecret123");
    expect(serialized).not.toContain("visible-secret");
    expect(serialized).not.toContain("session=secret");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("safe-result");
    expect(agentActivityRawEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("enforces independent request and response byte limits", () => {
    const envelope = createAgentActivityRawEnvelope({
      request: "r".repeat(agentActivityRawRequestLimitBytes + 1_000),
      response: "s".repeat(agentActivityRawResponseLimitBytes + 1_000),
    });
    expect(envelope.request?.truncated).toBe(true);
    expect(envelope.response?.truncated).toBe(true);
    expect(
      new TextEncoder().encode(envelope.request?.text ?? "").byteLength,
    ).toBe(agentActivityRawRequestLimitBytes);
    expect(
      new TextEncoder().encode(envelope.response?.text ?? "").byteLength,
    ).toBe(agentActivityRawResponseLimitBytes);
  });

  it("omits binary bodies while retaining size and digest metadata", () => {
    const envelope = createAgentActivityRawEnvelope({
      response: new Uint8Array([1, 2, 3, 4]),
    });
    expect(envelope.response).toMatchObject({
      mediaType: "application/octet-stream",
      originalBytes: 4,
      text: null,
      truncated: false,
    });
    expect(envelope.response?.digest).toMatch(/^sha256:/u);
    expect(envelope.response?.omittedReason).toContain("Binary");
  });

  it.each(["request", "response"] as const)(
    "omits nested MCP images from %s without truncating useful text or mutating input",
    (direction) => {
      const data = "PRIVATE_IMAGE_SENTINEL".repeat(
        agentActivityRawResponseLimitBytes,
      );
      const image = Object.freeze({
        type: "image",
        mimeType: "image/png",
        data,
        _meta: { duplicate: data },
      });
      const value = {
        result: {
          content: [image, { type: "text", text: "snapshot complete" }],
          structuredContent: { snapshots: [image] },
        },
      };
      const envelope = createAgentActivityRawEnvelope({ [direction]: value });
      const document = envelope[direction];
      expect(document?.truncated).toBe(false);
      expect(document?.text).not.toContain("PRIVATE_IMAGE_SENTINEL");
      expect(document?.text).toContain("snapshot complete");
      const omitted = {
        type: "image",
        mimeType: "image/png",
        encodedBytes: Buffer.byteLength(data),
        omittedReason: "Image content is not embedded in trajectory capture.",
      };
      expect(JSON.parse(document?.text ?? "")).toEqual({
        result: {
          content: [omitted, { type: "text", text: "snapshot complete" }],
          structuredContent: { snapshots: [omitted] },
        },
      });
      expect(value.result.content[0]).toBe(image);
      expect(image.data).toBe(data);
      expect(image._meta.duplicate).toBe(data);
    },
  );

  it.each([
    { type: "image", mimeType: "image/png", data: "" },
    { type: "image", mimeType: "malformed-private-image", data: null },
    {
      type: "image",
      mimeType: { nested: "private-image" },
      data: { nested: "private-image" },
      extra: "private-image",
    },
  ])("omits empty or malformed image blocks: %j", (image) => {
    const original = structuredClone(image);
    const envelope = createAgentActivityRawEnvelope({ response: { image } });
    expect(envelope.response?.text).not.toContain("private-image");
    expect(envelope.response?.text).toContain("Image content is not embedded");
    expect(JSON.parse(envelope.response?.text ?? "").image).not.toHaveProperty(
      "data",
    );
    expect(image).toEqual(original);
  });

  it("preserves ordinary text and data even when they resemble base64", () => {
    const data = Buffer.from("ordinary text, not a typed image").toString(
      "base64",
    );
    const response = {
      content: [{ type: "text", text: data }],
      data,
      nested: { mimeType: "image/png", data },
    };
    const envelope = createAgentActivityRawEnvelope({ response });
    expect(JSON.parse(envelope.response?.text ?? "")).toEqual(response);
  });

  it.each([
    ["Buffer", Buffer.from([91, 92, 93]), [91, 92, 93]],
    ["Uint8Array", new Uint8Array([94, 95, 96]), [94, 95, 96]],
    ["ArrayBuffer", new Uint8Array([97, 98, 99]).buffer, [97, 98, 99]],
    [
      "DataView with offset",
      new DataView(new Uint8Array([100, 101, 102, 103]).buffer, 1, 2),
      [101, 102],
    ],
    [
      "typed array with offset",
      new Int8Array(new Uint8Array([104, 105, 106, 107]).buffer, 1, 2),
      [105, 106],
    ],
    ["empty typed array", new Uint8Array(), []],
  ] as const)(
    "omits nested %s using only its view bytes",
    (_kind, value, expected) => {
      const bytes = Buffer.from(expected);
      const response = { nested: [value] };
      const envelope = createAgentActivityRawEnvelope({ response });
      expect(JSON.parse(envelope.response?.text ?? "")).toEqual({
        nested: [
          {
            mediaType: "application/octet-stream",
            text: null,
            originalBytes: bytes.length,
            truncated: false,
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            omittedReason:
              "Binary content is not embedded in trajectory capture.",
          },
        ],
      });
      expect(response.nested[0]).toBe(value);
      const original =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      expect([...original]).toEqual([...expected]);
    },
  );

  it("retains circular-reference omission around image and binary values", () => {
    const response: Record<string, unknown> = {
      image: { type: "image", mimeType: "image/png", data: "private-image" },
      binary: new Uint8Array([1, 2, 3]),
    };
    response.self = response;
    const envelope = createAgentActivityRawEnvelope({ response });
    expect(envelope.response?.text).not.toContain("private-image");
    expect(envelope.response?.text).toContain("[OMITTED: circular reference]");
    expect(response.self).toBe(response);
  });
});
