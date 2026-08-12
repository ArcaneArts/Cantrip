import { describe, expect, it } from "vitest";

import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
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
      { ...base, kind: "close", code: "normal", message: null },
    ];
    for (const header of frames) {
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
