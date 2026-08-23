import { z } from "zod";

import { protectedTunnelContentRecordSchema } from "./tunnel-content.js";

export const TUNNEL_DATA_PLANE_PROTOCOL_VERSION = 1;
export const TUNNEL_DATA_PLANE_MAX_HEADER_BYTES = 8 * 1_024;
export const TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES = 64 * 1_024;
export const TUNNEL_DATA_PLANE_AUTH_TAG_BYTES = 16;
export const TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES =
  TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES + TUNNEL_DATA_PLANE_AUTH_TAG_BYTES;
export const TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES = 8 * 1_024 * 1_024;

const FRAME_MAGIC = new Uint8Array([0x43, 0x54, 0x54, 0x4e]);
const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const sequenceSchema = z.number().int().nonnegative().safe();
const creditSchema = z
  .number()
  .int()
  .positive()
  .max(TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES);

export const tunnelDataFrameProtectionSchema = z
  .object({
    formatVersion: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    keyRevision: z.number().int().positive().safe(),
    nonce: z
      .string()
      .length(16)
      .regex(/^[A-Za-z0-9_-]{16}$/u),
  })
  .strict();

export const tunnelDataDirectionSchema = z.enum([
  "source-to-destination",
  "destination-to-source",
]);

export const tunnelDataPlaneCloseCodeSchema = z.enum([
  "normal",
  "revoked",
  "endpoint-disconnected",
  "idle-timeout",
  "lifetime-expired",
  "congested",
  "bandwidth-limit",
  "protocol-error",
]);

export const tunnelDataPlaneTargetSchema = z.union([
  z
    .object({
      kind: z.literal("protected-tunnel"),
      targetKind: z.literal("tcp"),
      recordId: idSchema,
      protectedRecord: protectedTunnelContentRecordSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tcp"),
      host: z.enum(["127.0.0.1", "localhost", "::1"]),
      port: z.number().int().min(1).max(65_535),
    })
    .strict(),
  z
    .object({
      kind: z.literal("adapter"),
      adapter: z.enum(["code", "project-share"]),
      resourceId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("adapter"),
      adapter: z.literal("terminal"),
      resourceId: idSchema,
      serverId: z.string().trim().min(1).max(2_000),
      managedRunId: z.string().uuid().nullable().optional(),
    })
    .strict()
    .refine(
      (target) =>
        target.managedRunId == null ||
        target.managedRunId === target.resourceId,
      {
        message: "Managed Run terminals must reuse the Run UUID.",
        path: ["managedRunId"],
      },
    ),
]);

const frameBaseSchema = z
  .object({
    protocolVersion: z.literal(TUNNEL_DATA_PLANE_PROTOCOL_VERSION),
    tunnelId: idSchema,
    attachmentId: idSchema,
    sourceEndpointId: idSchema,
    destinationEndpointId: idSchema,
    connectionId: idSchema,
    sequence: sequenceSchema,
  })
  .strict();

export const tunnelDataPlaneFrameHeaderSchema = z.discriminatedUnion("kind", [
  frameBaseSchema.extend({
    kind: z.literal("open"),
    initialCreditBytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("connect"),
    target: tunnelDataPlaneTargetSchema,
    initialCreditBytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("accepted"),
    initialCreditBytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("rejected"),
    code: z.enum([
      "target-unavailable",
      "target-rejected",
      "limit-exceeded",
      "unauthorized",
      "protocol-error",
      "congested",
    ]),
  }),
  frameBaseSchema.extend({
    kind: z.literal("data"),
    direction: tunnelDataDirectionSchema,
    protection: tunnelDataFrameProtectionSchema.optional(),
  }),
  frameBaseSchema.extend({
    kind: z.literal("credit"),
    direction: tunnelDataDirectionSchema,
    bytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("half-close"),
    direction: tunnelDataDirectionSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("close"),
    code: tunnelDataPlaneCloseCodeSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("error"),
    code: z.enum(["connection-failed", "io-error", "protocol-error"]),
  }),
]);

export function isTunnelDataPlaneFrame(frame: Uint8Array): boolean {
  return (
    frame.byteLength >= FRAME_MAGIC.byteLength &&
    FRAME_MAGIC.every((value, index) => frame[index] === value)
  );
}

function validatePayload(
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
): void {
  if (payload.byteLength > TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES) {
    throw new Error("Tunnel data payload exceeds the protocol limit.");
  }
  if (header.kind === "data" && payload.byteLength === 0) {
    throw new Error("Tunnel data frames require a payload.");
  }
  if (header.kind !== "data" && payload.byteLength !== 0) {
    throw new Error("Tunnel control frames cannot contain a payload.");
  }
  if (header.kind === "data") {
    const protectedFrame = header.protection !== undefined;
    if (
      protectedFrame &&
      payload.byteLength <= TUNNEL_DATA_PLANE_AUTH_TAG_BYTES
    ) {
      throw new Error(
        "Protected tunnel data requires ciphertext and an authentication tag.",
      );
    }
    if (
      !protectedFrame &&
      payload.byteLength > TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES
    ) {
      throw new Error("Plaintext tunnel data exceeds the protocol limit.");
    }
  }
}

export function encodeTunnelDataPlaneFrame(
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  const parsedHeader = tunnelDataPlaneFrameHeaderSchema.parse(header);
  validatePayload(parsedHeader, payload);
  const encodedHeader = new TextEncoder().encode(JSON.stringify(parsedHeader));
  if (encodedHeader.byteLength > TUNNEL_DATA_PLANE_MAX_HEADER_BYTES) {
    throw new Error("Tunnel data header exceeds the protocol limit.");
  }
  const frame = new Uint8Array(
    8 + encodedHeader.byteLength + payload.byteLength,
  );
  frame.set(FRAME_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, encodedHeader.byteLength, false);
  frame.set(encodedHeader, 8);
  frame.set(payload, 8 + encodedHeader.byteLength);
  return frame;
}

export function decodeTunnelDataPlaneFrame(frame: Uint8Array): {
  header: TunnelDataPlaneFrameHeader;
  payload: Uint8Array;
} {
  if (frame.byteLength < 8 || !isTunnelDataPlaneFrame(frame)) {
    throw new Error("Tunnel data frame has an invalid magic value.");
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(4, false);
  if (headerLength < 1 || headerLength > TUNNEL_DATA_PLANE_MAX_HEADER_BYTES) {
    throw new Error("Tunnel data frame header length is invalid.");
  }
  const payloadOffset = 8 + headerLength;
  if (payloadOffset > frame.byteLength) {
    throw new Error("Tunnel data frame header is truncated.");
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(
      new TextDecoder().decode(frame.subarray(8, payloadOffset)),
    );
  } catch {
    throw new Error("Tunnel data frame header is not valid JSON.");
  }
  const header = tunnelDataPlaneFrameHeaderSchema.parse(rawHeader);
  const payload = frame.subarray(payloadOffset);
  validatePayload(header, payload);
  return { header, payload };
}

export type TunnelDataDirection = z.infer<typeof tunnelDataDirectionSchema>;
export type TunnelDataFrameProtection = z.infer<
  typeof tunnelDataFrameProtectionSchema
>;
export type TunnelDataPlaneCloseCode = z.infer<
  typeof tunnelDataPlaneCloseCodeSchema
>;
export type TunnelDataPlaneTarget = z.infer<typeof tunnelDataPlaneTargetSchema>;
export type TunnelDataPlaneFrameHeader = z.infer<
  typeof tunnelDataPlaneFrameHeaderSchema
>;
