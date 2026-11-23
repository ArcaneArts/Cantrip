import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";
import type { TunnelDataProtectionConfiguration } from "@cantrip/protocol/tunnel-content";
import { describe, expect, it } from "vitest";

import {
  openTunnelDataFrame,
  sealTunnelDataFrame,
} from "./tunnel-data-protection.js";

const configuration: TunnelDataProtectionConfiguration = {
  formatVersion: 1,
  algorithm: "AES-256-GCM",
  keyRevision: 3,
  key: Buffer.alloc(32, 7).toString("base64url"),
};

const header: Extract<TunnelDataPlaneFrameHeader, { kind: "data" }> = {
  protocolVersion: 1,
  tunnelId: "tunnel-1",
  attachmentId: "attachment-1",
  sourceEndpointId: "desktop-1",
  destinationEndpointId: "worker-1",
  connectionId: "connection-1",
  sequence: 4,
  kind: "data",
  direction: "source-to-destination",
};

describe("tunnel data protection", () => {
  it("authenticates ciphertext to its full route and sequence", () => {
    const plaintext = Buffer.from("GET /private HTTP/1.1\r\n\r\n");
    const sealed = sealTunnelDataFrame(configuration, header, plaintext);

    expect(sealed.payload).not.toEqual(plaintext);
    expect(
      openTunnelDataFrame(configuration, sealed.header, sealed.payload),
    ).toEqual(plaintext);
    expect(() =>
      openTunnelDataFrame(
        configuration,
        { ...sealed.header, sequence: sealed.header.sequence + 1 },
        sealed.payload,
      ),
    ).toThrow();
    const tampered = sealed.payload.slice();
    tampered[0] = tampered[0]! ^ 1;
    expect(() =>
      openTunnelDataFrame(configuration, sealed.header, tampered),
    ).toThrow();
  });

  it("opens the shared Rust/Node AES-GCM vector", () => {
    const vectorHeader = {
      ...header,
      tunnelId: "tunnel",
      attachmentId: "attachment",
      sourceEndpointId: "desktop:one:attachment",
      destinationEndpointId: "worker:one",
      connectionId: "connection",
      protection: {
        formatVersion: 1 as const,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 3,
        nonce: "CQkJCQkJCQkJCQkJ",
      },
    };
    expect(
      openTunnelDataFrame(
        configuration,
        vectorHeader,
        Buffer.from(
          "RPfr583dsxTOFqJVg8rBpqDVEKBB_3Ez7M0m4OcZVNhpfMk",
          "base64url",
        ),
      ),
    ).toEqual(Buffer.from("cross-runtime bytes"));
  });
});
