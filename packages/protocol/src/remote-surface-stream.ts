import { z } from "zod";

import { encryptionKeyRevisionSchema } from "./encryption.js";

export const REMOTE_SURFACE_PROTECTED_PAYLOAD_HEADER_BYTES = 21;
export const REMOTE_SURFACE_PROTECTED_TAG_BYTES = 16;
export const REMOTE_SURFACE_PROTECTED_OVERHEAD_BYTES =
  REMOTE_SURFACE_PROTECTED_PAYLOAD_HEADER_BYTES +
  REMOTE_SURFACE_PROTECTED_TAG_BYTES;
export const REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT =
  4 * 1_024 * 1_024 - REMOTE_SURFACE_PROTECTED_OVERHEAD_BYTES;

export const remoteSurfaceStreamKindSchema = z.enum(["browser", "desktop"]);
export const remoteSurfaceStreamDirectionSchema = z.enum([
  "client-to-worker",
  "worker-to-client",
]);
export const remoteSurfaceStreamChannelSchema = z.enum([
  "control",
  "frame",
  "cursor",
  "clipboard",
  "webrtc-signal",
]);
export const remoteSurfaceStreamContextSchema = z
  .object({
    serverId: z.string().min(1).max(2_000),
    surfaceKind: remoteSurfaceStreamKindSchema,
    surfaceId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    direction: remoteSurfaceStreamDirectionSchema,
    channel: remoteSurfaceStreamChannelSchema,
    sequence: z.number().int().nonnegative().safe(),
  })
  .strict();

export interface RemoteSurfaceProtectedPayload {
  formatVersion: 1;
  keyRevision: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function encodeRemoteSurfaceProtectedPayload(
  input: RemoteSurfaceProtectedPayload,
): Uint8Array {
  if (input.formatVersion !== 1) {
    throw new Error("Remote Surface protected payload version is unsupported.");
  }
  const keyRevision = encryptionKeyRevisionSchema.parse(input.keyRevision);
  if (input.nonce.byteLength !== 12) {
    throw new Error("Remote Surface protected payload nonce is invalid.");
  }
  if (input.ciphertext.byteLength < REMOTE_SURFACE_PROTECTED_TAG_BYTES) {
    throw new Error("Remote Surface protected payload ciphertext is invalid.");
  }
  const plaintextBytes =
    input.ciphertext.byteLength - REMOTE_SURFACE_PROTECTED_TAG_BYTES;
  if (plaintextBytes > REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT) {
    throw new Error("Remote Surface protected payload is too large.");
  }
  const output = new Uint8Array(
    REMOTE_SURFACE_PROTECTED_PAYLOAD_HEADER_BYTES + input.ciphertext.byteLength,
  );
  output[0] = input.formatVersion;
  new DataView(output.buffer).setBigUint64(1, BigInt(keyRevision), false);
  output.set(input.nonce, 9);
  output.set(input.ciphertext, REMOTE_SURFACE_PROTECTED_PAYLOAD_HEADER_BYTES);
  return output;
}

export function decodeRemoteSurfaceProtectedPayload(
  payload: Uint8Array,
): RemoteSurfaceProtectedPayload {
  if (
    payload.byteLength <
    REMOTE_SURFACE_PROTECTED_PAYLOAD_HEADER_BYTES +
      REMOTE_SURFACE_PROTECTED_TAG_BYTES
  ) {
    throw new Error("Remote Surface protected payload is truncated.");
  }
  if (payload[0] !== 1) {
    throw new Error("Remote Surface protected payload version is unsupported.");
  }
  const revisionValue = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getBigUint64(1, false);
  if (revisionValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Remote Surface protected payload revision is invalid.");
  }
  const keyRevision = encryptionKeyRevisionSchema.parse(Number(revisionValue));
  const ciphertext = payload.subarray(
    REMOTE_SURFACE_PROTECTED_PAYLOAD_HEADER_BYTES,
  );
  if (
    ciphertext.byteLength - REMOTE_SURFACE_PROTECTED_TAG_BYTES >
    REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT
  ) {
    throw new Error("Remote Surface protected payload is too large.");
  }
  return {
    formatVersion: 1,
    keyRevision,
    nonce: payload.subarray(9, REMOTE_SURFACE_PROTECTED_PAYLOAD_HEADER_BYTES),
    ciphertext,
  };
}

export type RemoteSurfaceStreamContext = z.infer<
  typeof remoteSurfaceStreamContextSchema
>;
export type RemoteSurfaceStreamKind = z.infer<
  typeof remoteSurfaceStreamKindSchema
>;
