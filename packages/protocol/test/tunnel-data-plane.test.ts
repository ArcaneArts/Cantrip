import { describe, expect, it } from "vitest";

import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  isForwardableCodeWebSocketCloseCode,
  isTunnelDataPlaneFrame,
  TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
  TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES,
  type TunnelDataPlaneFrameHeader,
} from "../src/index.js";

const base = {
  protocolVersion: 1 as const,
  tunnelId: "tunnel-1",
  attachmentId: "attachment-1",
  sourceEndpointId: "desktop-a",
  destinationEndpointId: "worker-b",
  connectionId: "connection-1",
  sequence: 0,
};

describe("generic tunnel data plane protocol", () => {
  it("rejects reserved WebSocket close codes before forwarding", () => {
    expect(isForwardableCodeWebSocketCloseCode(1_000)).toBe(true);
    expect(isForwardableCodeWebSocketCloseCode(1_006)).toBe(false);
    expect(isForwardableCodeWebSocketCloseCode(3_001)).toBe(true);
    expect(isForwardableCodeWebSocketCloseCode(4_999)).toBe(true);
    expect(isForwardableCodeWebSocketCloseCode(5_000)).toBe(false);
  });

  it("round-trips bounded binary data", () => {
    const header: TunnelDataPlaneFrameHeader = {
      ...base,
      kind: "data",
      direction: "source-to-destination",
    };
    const payload = new Uint8Array([0, 1, 2, 255]);
    const encoded = encodeTunnelDataPlaneFrame(header, payload);

    expect(isTunnelDataPlaneFrame(encoded)).toBe(true);
    const decoded = decodeTunnelDataPlaneFrame(encoded);
    expect(decoded.header).toEqual(header);
    expect(decoded.payload).toEqual(payload);
  });

  it("round-trips protected data metadata without opening ciphertext", () => {
    const header: TunnelDataPlaneFrameHeader = {
      ...base,
      kind: "data",
      direction: "source-to-destination",
      protection: {
        formatVersion: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 2,
        nonce: "n".repeat(16),
      },
    };
    const ciphertext = new Uint8Array(17).fill(9);
    const decoded = decodeTunnelDataPlaneFrame(
      encodeTunnelDataPlaneFrame(header, ciphertext),
    );
    expect(decoded).toEqual({ header, payload: ciphertext });
    expect(() =>
      encodeTunnelDataPlaneFrame(header, new Uint8Array(16)),
    ).toThrow(/authentication tag/i);
  });

  it("models open, connect, acceptance, credit, half-close, and close", () => {
    const frames: TunnelDataPlaneFrameHeader[] = [
      { ...base, kind: "open", initialCreditBytes: 256 * 1_024 },
      {
        ...base,
        kind: "connect",
        target: { kind: "tcp", host: "127.0.0.1", port: 5173 },
        initialCreditBytes: 256 * 1_024,
      },
      { ...base, kind: "accepted", initialCreditBytes: 256 * 1_024 },
      {
        ...base,
        kind: "credit",
        direction: "destination-to-source",
        bytes: 64 * 1_024,
      },
      {
        ...base,
        kind: "half-close",
        direction: "source-to-destination",
      },
      { ...base, kind: "close", code: "normal" },
    ];
    for (const header of frames) {
      expect(
        decodeTunnelDataPlaneFrame(
          encodeTunnelDataPlaneFrame(header, new Uint8Array()),
        ).header,
      ).toEqual(header);
    }
  });

  it("round-trips coarse protected target rejection categories", () => {
    for (const code of [
      "protected-target-invalid",
      "protected-record-unavailable",
      "protected-endpoint-unavailable",
    ] as const) {
      const header: TunnelDataPlaneFrameHeader = {
        ...base,
        kind: "rejected",
        code,
      };
      expect(
        decodeTunnelDataPlaneFrame(
          encodeTunnelDataPlaneFrame(header, new Uint8Array()),
        ).header,
      ).toEqual(header);
    }
  });

  it("rejects unsafe targets, invalid credit, malformed lengths, and payload misuse", () => {
    expect(() =>
      encodeTunnelDataPlaneFrame(
        {
          ...base,
          connectionId: "connection\0collision",
          kind: "open",
          initialCreditBytes: 1,
        },
        new Uint8Array(),
      ),
    ).toThrow();
    expect(() =>
      encodeTunnelDataPlaneFrame(
        {
          ...base,
          kind: "connect",
          target: { kind: "tcp", host: "0.0.0.0", port: 80 } as never,
          initialCreditBytes: 1,
        },
        new Uint8Array(),
      ),
    ).toThrow();
    expect(() =>
      encodeTunnelDataPlaneFrame(
        {
          ...base,
          kind: "open",
          initialCreditBytes: TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES + 1,
        },
        new Uint8Array(),
      ),
    ).toThrow();
    expect(() =>
      encodeTunnelDataPlaneFrame(
        { ...base, kind: "open", initialCreditBytes: 1 },
        new Uint8Array([1]),
      ),
    ).toThrow(/control frames/i);
    expect(() =>
      encodeTunnelDataPlaneFrame(
        {
          ...base,
          kind: "data",
          direction: "source-to-destination",
        },
        new Uint8Array(TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES + 1),
      ),
    ).toThrow(/payload exceeds/i);

    const encoded = encodeTunnelDataPlaneFrame(
      { ...base, kind: "open", initialCreditBytes: 1 },
      new Uint8Array(),
    );
    new DataView(encoded.buffer).setUint32(4, 0xffff_ffff, false);
    expect(() => decodeTunnelDataPlaneFrame(encoded)).toThrow(/length/i);
  });
});
