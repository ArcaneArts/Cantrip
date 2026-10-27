import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decodeJsonMessage, encodeJsonMessage } from "./json-message.js";
import { decodeWorkerServerEnvelope } from "./worker-codecs.js";

describe("JSON message boundaries", () => {
  it("retains syntax, validation and normalized-value results", () => {
    const schema = z.object({ name: z.string().trim() });
    expect(decodeJsonMessage("{", schema)).toEqual({
      success: false,
      reason: "invalid-json",
    });
    expect(decodeJsonMessage('{"name":1}', schema)).toEqual({
      success: false,
      reason: "invalid-message",
      value: { name: 1 },
    });
    expect(
      decodeJsonMessage('{"name":" fixture ","extra":true}', schema),
    ).toEqual({
      success: true,
      data: { name: "fixture" },
    });
    expect(encodeJsonMessage({ name: " fixture " }, schema)).toBe(
      '{"name":"fixture"}',
    );
  });

  it("isolates an exception raised by a validator", () => {
    const schema = z.string().superRefine(() => {
      throw new Error("isolated validator failure");
    });
    expect(decodeJsonMessage('"fixture"', schema)).toEqual({
      success: false,
      reason: "invalid-message",
      value: "fixture",
    });
  });

  it("keeps recursive worker input from escaping the decoder and allows the next message", () => {
    const message = {
      kind: "event",
      requestId: "recursive-worker-input",
      event: {
        type: "agent.interaction.requested",
        request: {
          requestKey: "fixture",
          threadId: "fixture",
          turnId: null,
          itemId: null,
          payload: {
            kind: "permissions",
            startedAtMs: 1,
            environmentId: null,
            cwd: "/fixture",
            reason: null,
            requestedPermissions: null,
          },
          expiresAt: null,
        },
      },
    };
    const encoded = JSON.stringify(message).replace(
      '"requestedPermissions":null',
      '"requestedPermissions":' + "[".repeat(16384) + "0" + "]".repeat(16384),
    );
    // A future stack-safe schema can accept this valid JSON. Today's schema
    // may reject it; neither case may throw into the worker socket listener.
    expect(() => decodeWorkerServerEnvelope(encoded)).not.toThrow();
    expect(
      decodeWorkerServerEnvelope(
        '{"kind":"response","requestId":"next-message","ok":true,"result":1}',
      ),
    ).toEqual({
      success: true,
      data: {
        kind: "response",
        requestId: "next-message",
        ok: true,
        result: 1,
      },
    });
  });
});
