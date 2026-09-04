import { describe, expect, it } from "vitest";
import {
  CuaFrameDecoder,
  CUA_MAX_HEADER_BYTES,
  CUA_MAX_PAYLOAD_BYTES,
  encodeCuaFrame,
  type CuaFrame,
} from "./framing.js";
import { CuaProcessError } from "./errors.js";

const response = (requestId = 1): CuaFrame["header"] => ({
  version: 1,
  message: {
    kind: "response",
    requestId,
    result: { status: "ok", data: { image: true } },
  },
});
const event: CuaFrame["header"] = {
  version: 1,
  message: {
    kind: "event",
    sequence: 1,
    sessionId: "fixture",
    event: { kind: "cursorChanged" },
  },
};

function raw(header: unknown, payloadLength = 0): Buffer {
  const json = Buffer.isBuffer(header)
    ? header
    : Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(json.length, 0);
  prefix.writeUInt32BE(payloadLength, 4);
  return Buffer.concat([prefix, json]);
}

describe("CUA process framing", () => {
  it("preserves fragmented/coalesced frames and raw image bytes", () => {
    const payload = Buffer.from([0, 255, 10, 13, 123, 128]);
    const bytes = Buffer.concat([
      encodeCuaFrame(event),
      encodeCuaFrame(response(), payload),
      encodeCuaFrame(response(2)),
    ]);
    for (const size of [1, 3, 8, 31, bytes.length]) {
      const frames: CuaFrame[] = [];
      const decoder = new CuaFrameDecoder((frame) => frames.push(frame));
      for (let offset = 0; offset < bytes.length; offset += size)
        decoder.push(bytes.subarray(offset, offset + size));
      decoder.finish();
      expect(frames).toEqual([
        { header: event, payload: Buffer.alloc(0) },
        { header: response(), payload },
        { header: response(2), payload: Buffer.alloc(0) },
      ]);
      expect(decoder.bufferedBytes).toBe(0);
    }
  });

  it("rejects invalid prefix limits before any header or image allocation", () => {
    for (const [headerLength, payloadLength] of [
      [0, 0],
      [CUA_MAX_HEADER_BYTES + 1, 0],
      [12, CUA_MAX_PAYLOAD_BYTES + 1],
      [0xffffffff, 0xffffffff],
    ] as const) {
      const prefix = Buffer.alloc(8);
      prefix.writeUInt32BE(headerLength, 0);
      prefix.writeUInt32BE(payloadLength, 4);
      const decoder = new CuaFrameDecoder(() => {
        throw new Error("unexpected frame");
      });
      expect(() => decoder.push(prefix)).toThrow(CuaProcessError);
      expect(decoder.bufferedBytes).toBe(8);
    }
  });

  it("rejects wrong version, unknown fields, invalid IDs and payload on an event", () => {
    for (const header of [
      { ...response(), version: 2 },
      { ...response(), extra: true },
      response(0),
      response(Number.MAX_SAFE_INTEGER + 1),
      {
        version: 1,
        message: { kind: "response", requestId: 1, result: { status: "ok" } },
      },
      {
        version: 1,
        message: {
          kind: "response",
          requestId: 1,
          result: {
            status: "error",
            error: { code: "made-up", message: "private" },
          },
        },
      },
      event,
    ]) {
      const decoder = new CuaFrameDecoder(() => {
        throw new Error("unexpected frame");
      });
      expect(() => decoder.push(raw(header, CUA_MAX_PAYLOAD_BYTES))).toThrow(
        CuaProcessError,
      );
    }
  });

  it("rejects malformed UTF-8 and partial EOF without exposing incoming content", () => {
    const decoder = new CuaFrameDecoder(() => {});
    expect(() => decoder.push(raw(Buffer.from([255])))).toThrow(
      "invalid protocol message",
    );
    const bytes = encodeCuaFrame(response(), Buffer.from([1, 2, 3]));
    for (const length of [1, 7, 8, bytes.length - 1]) {
      const partial = new CuaFrameDecoder(() => {});
      partial.push(bytes.subarray(0, length));
      expect(() => partial.finish()).toThrow(CuaProcessError);
    }
  });

  it("rejects oversized outbound data and circular objects as not sent", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const operation of ["a".repeat(CUA_MAX_HEADER_BYTES), circular]) {
      try {
        encodeCuaFrame({
          version: 1,
          message: { kind: "request", requestId: 1, operation },
        });
        expect.fail("expected outbound rejection");
      } catch (error) {
        expect(error).toMatchObject({
          code: "invalid-request",
          outcome: "not-sent",
        });
      }
    }
  });
});
