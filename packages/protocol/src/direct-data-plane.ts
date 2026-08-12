import { z } from "zod";

export const directRouteStateSchema = z.enum([
  "probing",
  "local-direct",
  "relayed",
  "degraded",
  "failed",
]);

export const directResourceKindSchema = z.enum([
  "probe",
  "remote-surface",
  "tunnel",
  "project-share",
  "terminal",
  "code",
]);

export const directChannelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u);

export const unavailableDirectBroker = { available: false } as const;

export const availableDirectBrokerSchema = z.object({
  available: z.literal(true),
  protocol: z.literal("ws-v1"),
  loopbackHost: z.literal("127.0.0.1"),
  loopbackPort: z.number().int().min(1).max(65_535),
  instanceId: z.string().uuid(),
  publicKey: z.string().min(43).max(64),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const directBrokerAdvertisementSchema = z.discriminatedUnion(
  "available",
  [z.object({ available: z.literal(false) }), availableDirectBrokerSchema],
);

export const directCapabilityBindingSchema = z.object({
  capabilityId: z.string().uuid(),
  ownerId: z.string().min(1).max(200),
  authSessionId: z.string().min(1).max(200),
  workerId: z.string().min(1).max(200),
  resourceKind: directResourceKindSchema,
  resourceId: z.string().min(1).max(200),
  attachmentId: z.string().min(1).max(200),
  channels: z.array(directChannelSchema).min(1).max(16),
  expiresAt: z.string().datetime(),
  leaseExpiresAt: z.string().datetime(),
});

export const directCapabilitySecretSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const directCapabilityPrepareCommandSchema = z.object({
  type: z.literal("direct.capability.prepare"),
  binding: directCapabilityBindingSchema,
  secret: directCapabilitySecretSchema,
});

export const directCapabilityRevokeCommandSchema = z.object({
  type: z.literal("direct.capability.revoke"),
  capabilityId: directCapabilityBindingSchema.shape.capabilityId,
  reason: z.string().min(1).max(200),
});

export const directCapabilityRenewCommandSchema = z.object({
  type: z.literal("direct.capability.renew"),
  capabilityId: directCapabilityBindingSchema.shape.capabilityId,
  leaseExpiresAt: directCapabilityBindingSchema.shape.leaseExpiresAt,
});

export const directCapabilityPrepareResultSchema = z.object({
  capabilityId: directCapabilityBindingSchema.shape.capabilityId,
  accepted: z.literal(true),
});

export const directAttachmentTicketSchema = z.object({
  broker: availableDirectBrokerSchema,
  binding: directCapabilityBindingSchema,
  secret: directCapabilitySecretSchema,
});

export const directBrokerInitializeSchema = z.object({
  type: z.literal("initialize"),
  binding: directCapabilityBindingSchema,
  secret: directCapabilitySecretSchema,
  challenge: z
    .string()
    .min(43)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/u),
});

export const directBrokerReadySchema = z.object({
  type: z.literal("ready"),
  directSessionId: z.string().uuid(),
  brokerInstanceId: z.string().uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  challenge: directBrokerInitializeSchema.shape.challenge,
  signature: z
    .string()
    .min(86)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
  leaseExpiresAt: z.string().datetime(),
});

export const directProbeResultSchema = z.object({
  state: directRouteStateSchema,
  reason: z.string().min(1).max(500).nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  workerId: z.string().min(1).max(200),
  brokerInstanceId: z.string().uuid().nullable(),
});

export type DirectAttachmentTicket = z.infer<
  typeof directAttachmentTicketSchema
>;
export type DirectBrokerAdvertisement = z.infer<
  typeof directBrokerAdvertisementSchema
>;
export type DirectCapabilityBinding = z.infer<
  typeof directCapabilityBindingSchema
>;
export type DirectProbeResult = z.infer<typeof directProbeResultSchema>;
export type DirectResourceKind = z.infer<typeof directResourceKindSchema>;
export type DirectRouteState = z.infer<typeof directRouteStateSchema>;
