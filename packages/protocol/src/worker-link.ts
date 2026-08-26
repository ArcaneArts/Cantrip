import { z } from "zod";

import {
  TUNNEL_DATA_PLANE_MAX_HEADER_BYTES,
  TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES,
} from "./tunnel-data-plane.js";

export const WORKER_LINK_PROTOCOL_VERSION = 1;
export const WORKER_LINK_MAX_HEADER_BYTES = 8 * 1_024;
export const WORKER_LINK_MAX_PAYLOAD_BYTES =
  8 + TUNNEL_DATA_PLANE_MAX_HEADER_BYTES + TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES;
export const WORKER_LINK_MAX_CREDIT_BYTES = 8 * 1_024 * 1_024;
export const WORKER_LINK_MAX_CHANNELS_PER_GRANT = 64;
export const WORKER_LINK_MAX_GRANTS_PER_SESSION = 128;
export const WORKER_LINK_MAX_TELEMETRY_SAMPLES = 128;

const FRAME_MAGIC = new Uint8Array([0x43, 0x57, 0x4c, 0x4b]);

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const generationSchema = z.number().int().positive().safe();
const sequenceSchema = z.number().int().nonnegative().safe();
const timestampSchema = z.string().datetime();
const counterSchema = z.number().int().nonnegative().safe();
const creditSchema = z
  .number()
  .int()
  .positive()
  .max(WORKER_LINK_MAX_CREDIT_BYTES);

export const workerLinkRouteSchema = z.enum(["local", "lan", "wan", "relay"]);

export const workerLinkOperationalRouteSchema = z.enum(["local", "relay"]);

export const workerLinkQosLaneSchema = z.enum([
  "events",
  "interactive",
  "stream",
  "realtime",
  "bulk",
]);

export const workerLinkChannelKindSchema = z.enum([
  "reliable-stream",
  "event-subscription",
  "datagram",
]);

export const workerLinkResourceKindSchema = z.enum([
  "terminal",
  "tunnel",
  "project-share",
  "code",
  "browser",
  "remote-desktop",
  "observations",
]);

export const workerLinkGrantOperationSchema = z.enum([
  "stream:open",
  "stream:read",
  "stream:write",
  "stream:half-close",
  "events:subscribe",
  "datagram:send",
]);

export const workerLinkRevokeReasonSchema = z.enum([
  "released",
  "account-session-ended",
  "resource-stopped",
  "resource-deleted",
  "worker-disconnected",
  "worker-generation-changed",
  "server-generation-changed",
  "lease-expired",
  "server-shutdown",
  "worker-shutdown",
  "protocol-violation",
]);

export const workerLinkFallbackReasonSchema = z.enum([
  "local-unsupported",
  "local-unavailable",
  "local-identity-mismatch",
  "local-capability-expired",
  "local-capability-rejected",
  "local-connect-timeout",
  "local-disconnected",
  "policy-relay-only",
  "route-replaced",
]);

export const workerLinkLeaseSchema = z
  .object({
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    absoluteExpiresAt: timestampSchema,
  })
  .strict()
  .superRefine((lease, context) => {
    const issuedAt = Date.parse(lease.issuedAt);
    const expiresAt = Date.parse(lease.expiresAt);
    const absoluteExpiresAt = Date.parse(lease.absoluteExpiresAt);
    if (expiresAt <= issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Lease expiry must be later than issuance.",
      });
    }
    if (absoluteExpiresAt < expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["absoluteExpiresAt"],
        message: "Absolute expiry cannot precede lease expiry.",
      });
    }
  });

export const workerLinkSessionIdentitySchema = z
  .object({
    serverId: idSchema,
    serverGeneration: idSchema,
    ownerId: idSchema,
    accountSessionId: idSchema,
    clientInstanceId: idSchema,
    workerId: idSchema,
    workerProcessGeneration: idSchema,
  })
  .strict();

export const workerLinkRoutePolicySchema = z
  .object({
    priority: z
      .tuple([
        z.literal("local"),
        z.literal("lan"),
        z.literal("wan"),
        z.literal("relay"),
      ])
      .readonly(),
    enabled: z
      .array(workerLinkRouteSchema)
      .min(1)
      .max(workerLinkRouteSchema.options.length)
      .refine((routes) => new Set(routes).size === routes.length, {
        message: "Enabled routes must be unique.",
      }),
  })
  .strict();

export const workerLinkSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    identity: workerLinkSessionIdentitySchema,
    lease: workerLinkLeaseSchema,
    routePolicy: workerLinkRoutePolicySchema,
    routeGeneration: generationSchema,
    preferredRoute: workerLinkRouteSchema,
  })
  .strict();

export const workerLinkResourceSchema = z
  .object({
    kind: workerLinkResourceKindSchema,
    resourceId: idSchema,
    attachmentId: idSchema.nullable(),
  })
  .strict();

const uniqueQosLanesSchema = z
  .array(workerLinkQosLaneSchema)
  .min(1)
  .max(workerLinkQosLaneSchema.options.length)
  .refine((lanes) => new Set(lanes).size === lanes.length, {
    message: "Grant lanes must be unique.",
  });
const uniqueOperationsSchema = z
  .array(workerLinkGrantOperationSchema)
  .min(1)
  .max(workerLinkGrantOperationSchema.options.length)
  .refine((operations) => new Set(operations).size === operations.length, {
    message: "Grant operations must be unique.",
  });

export const workerLinkGrantBindingSchema = z
  .object({
    grantId: z.string().uuid(),
    grantGeneration: generationSchema,
    sessionId: z.string().uuid(),
    identity: workerLinkSessionIdentitySchema,
    resource: workerLinkResourceSchema,
    lanes: uniqueQosLanesSchema,
    operations: uniqueOperationsSchema,
    maxChannels: z
      .number()
      .int()
      .positive()
      .max(WORKER_LINK_MAX_CHANNELS_PER_GRANT),
    lease: workerLinkLeaseSchema,
  })
  .strict();

export const workerLinkGrantTokenSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const workerLinkGrantTokenHashSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u);

export const workerLinkResourceGrantSchema = z
  .object({
    binding: workerLinkGrantBindingSchema,
    token: workerLinkGrantTokenSchema,
  })
  .strict();

export const installedWorkerLinkGrantSchema = z
  .object({
    binding: workerLinkGrantBindingSchema,
    tokenHash: workerLinkGrantTokenHashSchema,
  })
  .strict();

export const workerLinkRevocationSchema = z
  .object({
    reason: workerLinkRevokeReasonSchema,
    revokedAt: timestampSchema,
  })
  .strict();

export const workerLinkRouteStatusSchema = z
  .object({
    preferredRoute: workerLinkRouteSchema,
    effectiveRoute: workerLinkRouteSchema,
    routeGeneration: generationSchema,
    latencyMs: z.number().nonnegative().finite().max(300_000).nullable(),
    fallbackReason: workerLinkFallbackReasonSchema.nullable(),
    changedAt: timestampSchema,
  })
  .strict();

export const workerLinkChannelIdentitySchema = z
  .object({
    channelId: z.string().uuid(),
    connectionId: z.string().uuid(),
  })
  .strict();

export const workerLinkDirectionSchema = z.enum([
  "client-to-worker",
  "worker-to-client",
]);

export const workerLinkPayloadFormatSchema = z.enum([
  "raw",
  "tunnel-data-plane-v1",
]);

export const workerLinkChannelRejectCodeSchema = z.enum([
  "unauthorized",
  "grant-expired",
  "grant-revoked",
  "grant-replayed",
  "wrong-account-session",
  "wrong-worker-generation",
  "wrong-server-generation",
  "route-generation-stale",
  "unsupported-channel",
  "resource-unavailable",
  "limit-exceeded",
  "protocol-error",
]);

export const workerLinkChannelCloseCodeSchema = z.enum([
  "normal",
  "revoked",
  "route-replaced",
  "endpoint-disconnected",
  "idle-timeout",
  "lifetime-expired",
  "congested",
  "protocol-error",
]);

export const workerLinkChannelErrorCodeSchema = z.enum([
  "connection-failed",
  "io-error",
  "credit-exceeded",
  "sequence-invalid",
  "payload-invalid",
  "protocol-error",
]);

const frameBaseSchema = z
  .object({
    protocolVersion: z.literal(WORKER_LINK_PROTOCOL_VERSION),
    sessionId: z.string().uuid(),
    routeGeneration: generationSchema,
    effectiveRoute: workerLinkRouteSchema,
    channel: workerLinkChannelIdentitySchema,
    lane: workerLinkQosLaneSchema,
    sequence: sequenceSchema,
  })
  .strict();

export const workerLinkFrameHeaderSchema = z.discriminatedUnion("kind", [
  frameBaseSchema.extend({
    kind: z.literal("open"),
    openNonce: z.string().uuid(),
    channelKind: workerLinkChannelKindSchema,
    grant: workerLinkResourceGrantSchema,
    initialCreditBytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("accept"),
    initialCreditBytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("reject"),
    code: workerLinkChannelRejectCodeSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("data"),
    direction: workerLinkDirectionSchema,
    payloadFormat: workerLinkPayloadFormatSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("credit"),
    direction: workerLinkDirectionSchema,
    bytes: creditSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("half-close"),
    direction: workerLinkDirectionSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("close"),
    code: workerLinkChannelCloseCodeSchema,
  }),
  frameBaseSchema.extend({
    kind: z.literal("error"),
    code: workerLinkChannelErrorCodeSchema,
  }),
]);

export const workerLinkSessionInstallCommandSchema = z
  .object({
    type: z.literal("worker-link.session.install"),
    session: workerLinkSessionSchema,
  })
  .strict();

export const workerLinkSessionRenewCommandSchema = z
  .object({
    type: z.literal("worker-link.session.renew"),
    sessionId: z.string().uuid(),
    lease: workerLinkLeaseSchema,
  })
  .strict();

export const workerLinkSessionRouteCommandSchema = z
  .object({
    type: z.literal("worker-link.session.route"),
    sessionId: z.string().uuid(),
    routeGeneration: generationSchema,
    preferredRoute: workerLinkOperationalRouteSchema,
  })
  .strict();

export const workerLinkSessionRevokeCommandSchema = z
  .object({
    type: z.literal("worker-link.session.revoke"),
    sessionId: z.string().uuid(),
    revocation: workerLinkRevocationSchema,
  })
  .strict();

export const workerLinkGrantInstallCommandSchema = z
  .object({
    type: z.literal("worker-link.grant.install"),
    sessionId: z.string().uuid(),
    grant: installedWorkerLinkGrantSchema,
  })
  .strict();

export const workerLinkGrantRenewCommandSchema = z
  .object({
    type: z.literal("worker-link.grant.renew"),
    sessionId: z.string().uuid(),
    grantId: z.string().uuid(),
    grantGeneration: generationSchema,
    lease: workerLinkLeaseSchema,
  })
  .strict();

export const workerLinkGrantRevokeCommandSchema = z
  .object({
    type: z.literal("worker-link.grant.revoke"),
    sessionId: z.string().uuid(),
    grantId: z.string().uuid(),
    grantGeneration: generationSchema,
    revocation: workerLinkRevocationSchema,
  })
  .strict();

export const workerLinkCoordinatorCommandSchema = z.discriminatedUnion("type", [
  workerLinkSessionInstallCommandSchema,
  workerLinkSessionRenewCommandSchema,
  workerLinkSessionRouteCommandSchema,
  workerLinkSessionRevokeCommandSchema,
  workerLinkGrantInstallCommandSchema,
  workerLinkGrantRenewCommandSchema,
  workerLinkGrantRevokeCommandSchema,
]);

export const workerLinkTelemetryEventSchema = z.enum([
  "session-opened",
  "session-closed",
  "channel-opened",
  "channel-closed",
  "channel-rejected",
  "channel-revoked",
  "bytes-sent",
  "bytes-received",
  "route-selected",
  "route-fallback",
  "reconnect-attempt",
  "queue-pressure",
]);

export const workerLinkTelemetryReasonSchema = z.enum([
  "none",
  ...workerLinkFallbackReasonSchema.options,
  ...workerLinkChannelRejectCodeSchema.options,
  ...workerLinkChannelCloseCodeSchema.options,
]);

export const workerLinkTelemetrySampleSchema = z
  .object({
    occurredAt: timestampSchema,
    event: workerLinkTelemetryEventSchema,
    route: workerLinkRouteSchema.nullable(),
    lane: workerLinkQosLaneSchema.nullable(),
    value: counterSchema,
    latencyMs: z.number().nonnegative().finite().max(300_000).nullable(),
    reason: workerLinkTelemetryReasonSchema,
  })
  .strict();

export const workerLinkTelemetryBatchSchema = z
  .object({
    routeGeneration: generationSchema,
    samples: z
      .array(workerLinkTelemetrySampleSchema)
      .min(1)
      .max(WORKER_LINK_MAX_TELEMETRY_SAMPLES),
  })
  .strict();

function validatePayload(
  header: WorkerLinkFrameHeader,
  payload: Uint8Array,
): void {
  if (payload.byteLength > WORKER_LINK_MAX_PAYLOAD_BYTES) {
    throw new Error("WorkerLink payload exceeds the protocol limit.");
  }
  if (header.kind === "data" && payload.byteLength === 0) {
    throw new Error("WorkerLink data frames require a payload.");
  }
  if (header.kind !== "data" && payload.byteLength !== 0) {
    throw new Error("WorkerLink control frames cannot contain a payload.");
  }
}

export function isWorkerLinkFrame(frame: Uint8Array): boolean {
  return (
    frame.byteLength >= FRAME_MAGIC.byteLength &&
    FRAME_MAGIC.every((value, index) => frame[index] === value)
  );
}

export function encodeWorkerLinkFrame(
  header: WorkerLinkFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  const parsedHeader = workerLinkFrameHeaderSchema.parse(header);
  validatePayload(parsedHeader, payload);
  const encodedHeader = new TextEncoder().encode(JSON.stringify(parsedHeader));
  if (encodedHeader.byteLength > WORKER_LINK_MAX_HEADER_BYTES) {
    throw new Error("WorkerLink header exceeds the protocol limit.");
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

export function decodeWorkerLinkFrame(frame: Uint8Array): {
  header: WorkerLinkFrameHeader;
  payload: Uint8Array;
} {
  if (frame.byteLength < 8 || !isWorkerLinkFrame(frame)) {
    throw new Error("WorkerLink frame has an invalid magic value.");
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(4, false);
  if (headerLength < 1 || headerLength > WORKER_LINK_MAX_HEADER_BYTES) {
    throw new Error("WorkerLink frame header length is invalid.");
  }
  const payloadOffset = 8 + headerLength;
  if (payloadOffset > frame.byteLength) {
    throw new Error("WorkerLink frame header is truncated.");
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(
      new TextDecoder().decode(frame.subarray(8, payloadOffset)),
    );
  } catch {
    throw new Error("WorkerLink frame header is not valid JSON.");
  }
  const header = workerLinkFrameHeaderSchema.parse(rawHeader);
  const payload = frame.subarray(payloadOffset);
  validatePayload(header, payload);
  return { header, payload };
}

export type WorkerLinkRoute = z.infer<typeof workerLinkRouteSchema>;
export type WorkerLinkOperationalRoute = z.infer<
  typeof workerLinkOperationalRouteSchema
>;
export type WorkerLinkQosLane = z.infer<typeof workerLinkQosLaneSchema>;
export type WorkerLinkChannelKind = z.infer<typeof workerLinkChannelKindSchema>;
export type WorkerLinkResourceKind = z.infer<
  typeof workerLinkResourceKindSchema
>;
export type WorkerLinkGrantOperation = z.infer<
  typeof workerLinkGrantOperationSchema
>;
export type WorkerLinkRevokeReason = z.infer<
  typeof workerLinkRevokeReasonSchema
>;
export type WorkerLinkLease = z.infer<typeof workerLinkLeaseSchema>;
export type WorkerLinkSessionIdentity = z.infer<
  typeof workerLinkSessionIdentitySchema
>;
export type WorkerLinkSession = z.infer<typeof workerLinkSessionSchema>;
export type WorkerLinkGrantBinding = z.infer<
  typeof workerLinkGrantBindingSchema
>;
export type WorkerLinkResourceGrant = z.infer<
  typeof workerLinkResourceGrantSchema
>;
export type InstalledWorkerLinkGrant = z.infer<
  typeof installedWorkerLinkGrantSchema
>;
export type WorkerLinkRouteStatus = z.infer<typeof workerLinkRouteStatusSchema>;
export type WorkerLinkChannelIdentity = z.infer<
  typeof workerLinkChannelIdentitySchema
>;
export type WorkerLinkFrameHeader = z.infer<typeof workerLinkFrameHeaderSchema>;
export type WorkerLinkChannelRejectCode = z.infer<
  typeof workerLinkChannelRejectCodeSchema
>;
export type WorkerLinkChannelCloseCode = z.infer<
  typeof workerLinkChannelCloseCodeSchema
>;
export type WorkerLinkChannelErrorCode = z.infer<
  typeof workerLinkChannelErrorCodeSchema
>;
export type WorkerLinkCoordinatorCommand = z.infer<
  typeof workerLinkCoordinatorCommandSchema
>;
export type WorkerLinkTelemetrySample = z.infer<
  typeof workerLinkTelemetrySampleSchema
>;
