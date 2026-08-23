import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  TUNNEL_DATA_PLANE_AUTH_TAG_BYTES,
  type TunnelDataFrameProtection,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import {
  tunnelDataProtectionConfigurationSchema,
  type TunnelDataProtectionConfiguration,
} from "@cantrip/protocol/tunnel-content";

type DataHeader = Extract<TunnelDataPlaneFrameHeader, { kind: "data" }>;

function associatedData(
  header: DataHeader,
  protection: TunnelDataFrameProtection,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      header.protocolVersion,
      header.tunnelId,
      header.attachmentId,
      header.sourceEndpointId,
      header.destinationEndpointId,
      header.connectionId,
      header.sequence,
      header.kind,
      header.direction,
      protection.formatVersion,
      protection.algorithm,
      protection.keyRevision,
      protection.nonce,
    ]),
    "utf8",
  );
}

function keyBytes(configuration: TunnelDataProtectionConfiguration): Buffer {
  const parsed = tunnelDataProtectionConfigurationSchema.parse(configuration);
  const key = Buffer.from(parsed.key, "base64url");
  if (key.byteLength !== 32) {
    key.fill(0);
    throw new Error("Tunnel data protection key is invalid.");
  }
  return key;
}

export function sealTunnelDataFrame(
  configuration: TunnelDataProtectionConfiguration,
  header: DataHeader,
  plaintext: Uint8Array,
): { header: DataHeader; payload: Uint8Array } {
  const nonce = randomBytes(12);
  const protection: TunnelDataFrameProtection = {
    formatVersion: 1,
    algorithm: "AES-256-GCM",
    keyRevision: configuration.keyRevision,
    nonce: nonce.toString("base64url"),
  };
  const key = keyBytes(configuration);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(associatedData(header, protection));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      header: { ...header, protection },
      payload: ciphertext,
    };
  } finally {
    key.fill(0);
    nonce.fill(0);
  }
}

export function openTunnelDataFrame(
  configuration: TunnelDataProtectionConfiguration,
  header: DataHeader,
  payload: Uint8Array,
): Uint8Array {
  const protection = header.protection;
  if (
    !protection ||
    protection.keyRevision !== configuration.keyRevision ||
    payload.byteLength <= TUNNEL_DATA_PLANE_AUTH_TAG_BYTES
  ) {
    throw new Error("Tunnel data protection metadata is invalid.");
  }
  const nonce = Buffer.from(protection.nonce, "base64url");
  const key = keyBytes(configuration);
  const ciphertext = Buffer.from(
    payload.subarray(0, -TUNNEL_DATA_PLANE_AUTH_TAG_BYTES),
  );
  const tag = Buffer.from(payload.subarray(-TUNNEL_DATA_PLANE_AUTH_TAG_BYTES));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(associatedData(header, protection));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    key.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    tag.fill(0);
  }
}
