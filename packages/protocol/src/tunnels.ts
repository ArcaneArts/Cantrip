import { z } from "zod";
import {
  protectedTunnelContentRecordSchema,
  tunnelContentErrorCodeSchema,
  tunnelPublicDestinationEndpointSchema,
  tunnelPublicSourceEndpointSchema,
} from "./tunnel-content.js";

export const tunnelResourceIdSchema = z.string().trim().min(1).max(200);
const tunnelNameSchema = z.string().trim().min(1).max(120);
const tunnelDescriptionSchema = z.string().trim().max(1_000).nullable();

export const tunnelOriginSchema = z.enum([
  "user",
  "browser",
  "project-share",
  "code",
  "workflow",
  "system",
]);

export const tunnelManagementSchema = z.enum([
  "user-managed",
  "managed-durable",
  "managed-ephemeral",
]);

export const tunnelProtocolHintSchema = z.enum([
  "tcp",
  "http",
  "https",
  "http-websocket",
  "https-websocket",
  "webdav",
]);

export const tunnelDesiredStateSchema = z.enum(["stopped", "started"]);

export const tunnelStatusSchema = z.enum([
  "stopped",
  "starting",
  "active",
  "offline",
  "degraded",
  "stopping",
  "failed",
]);

export const tunnelWorkerHostSchema = z.enum(["127.0.0.1", "localhost", "::1"]);

export const tunnelSourceEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("desktop-loopback") }).strict(),
  z
    .object({
      kind: z.literal("worker-listener"),
      workerId: tunnelResourceIdSchema,
      host: tunnelWorkerHostSchema,
      port: z.number().int().min(1).max(65_535),
    })
    .strict(),
]);

export const tunnelDestinationEndpointSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("worker-tcp"),
      workerId: tunnelResourceIdSchema,
      host: tunnelWorkerHostSchema,
      port: z.number().int().min(1).max(65_535),
    })
    .strict(),
  z
    .object({
      kind: z.literal("worker-adapter"),
      workerId: tunnelResourceIdSchema,
      adapter: z.enum(["code", "project-share"]),
      resourceId: tunnelResourceIdSchema,
    })
    .strict(),
]);

export const tunnelManagedResourceSchema = z
  .object({
    kind: z.enum(["browser", "code", "project-share", "workflow", "system"]),
    id: tunnelResourceIdSchema,
  })
  .strict();

export const tunnelUserCreateSchema = z
  .object({
    name: tunnelNameSchema,
    description: tunnelDescriptionSchema.default(null),
    projectId: tunnelResourceIdSchema.nullable().default(null),
    protocolHint: tunnelProtocolHintSchema,
    destination: z
      .object({
        kind: z.literal("worker-tcp"),
        workerId: tunnelResourceIdSchema,
        host: tunnelWorkerHostSchema.default("127.0.0.1"),
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
  })
  .strict();

export const tunnelUserUpdateSchema = z
  .object({
    name: tunnelNameSchema.optional(),
    description: tunnelDescriptionSchema.optional(),
    projectId: tunnelResourceIdSchema.nullable().optional(),
    protocolHint: tunnelProtocolHintSchema.optional(),
    destination: tunnelUserCreateSchema.shape.destination.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one tunnel field is required.",
  });

export const tunnelUserWireCreateSchema = z
  .object({
    id: z.string().uuid(),
    projectId: tunnelResourceIdSchema.nullable().default(null),
    protocolHint: tunnelProtocolHintSchema,
    destination: tunnelPublicDestinationEndpointSchema.and(
      z.object({ kind: z.literal("worker-tcp") }).strict(),
    ),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict()
  .refine(({ id, protectedRecord }) => id === protectedRecord.operationId, {
    message: "A new tunnel record must use its tunnel id as operation id.",
    path: ["protectedRecord", "operationId"],
  })
  .refine(({ protectedRecord }) => protectedRecord.revision === 1, {
    message: "A new tunnel record must begin at revision one.",
    path: ["protectedRecord", "revision"],
  });

export const tunnelUserWireUpdateSchema = z
  .object({
    projectId: tunnelResourceIdSchema.nullable().optional(),
    protocolHint: tunnelProtocolHintSchema.optional(),
    destination: tunnelPublicDestinationEndpointSchema
      .and(z.object({ kind: z.literal("worker-tcp") }).strict())
      .optional(),
    protectedRecord: protectedTunnelContentRecordSchema,
  })
  .strict();

export const tunnelManagedRegistrationSchema = z
  .object({
    name: tunnelNameSchema,
    description: tunnelDescriptionSchema.default(null),
    projectId: tunnelResourceIdSchema.nullable().default(null),
    origin: tunnelOriginSchema.exclude(["user"]),
    management: tunnelManagementSchema.exclude(["user-managed"]),
    protocolHint: tunnelProtocolHintSchema,
    source: tunnelSourceEndpointSchema,
    destination: tunnelDestinationEndpointSchema,
    managedBy: tunnelManagedResourceSchema,
    desiredState: tunnelDesiredStateSchema.default("started"),
    status: tunnelStatusSchema.default("starting"),
  })
  .strict()
  .superRefine((tunnel, context) => {
    if (tunnel.origin !== tunnel.managedBy.kind) {
      context.addIssue({
        code: "custom",
        message: "A managed tunnel origin must match its owning resource.",
        path: ["managedBy", "kind"],
      });
    }
    if (
      tunnel.destination.kind === "worker-adapter" &&
      (tunnel.origin !== tunnel.destination.adapter ||
        tunnel.destination.resourceId !== tunnel.managedBy.id)
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker adapters must match the owning resource.",
        path: ["destination"],
      });
    }
  });

export const tunnelAttachmentKindSchema = z.enum(["desktop-loopback"]);

export const tunnelAttachmentSummarySchema = z
  .object({
    id: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    kind: tunnelAttachmentKindSchema,
    clientId: tunnelResourceIdSchema.nullable(),
    localHost: tunnelWorkerHostSchema.nullable(),
    localPort: z.number().int().min(1).max(65_535).nullable(),
    status: tunnelStatusSchema,
    activeConnectionCount: z.number().int().nonnegative(),
    bytesFromSource: z.number().int().nonnegative().safe(),
    bytesToSource: z.number().int().nonnegative().safe(),
    lastError: z.string().min(1).max(4_000).nullable(),
    expiresAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((attachment, context) => {
    const desktop = attachment.kind === "desktop-loopback";
    if (desktop !== (attachment.clientId !== null)) {
      context.addIssue({
        code: "custom",
        message: "Desktop attachments require a client identity.",
        path: ["clientId"],
      });
    }
    if (!desktop && attachment.localHost !== null) {
      context.addIssue({
        code: "custom",
        message: "Server relay attachments cannot expose a local host.",
        path: ["localHost"],
      });
    }
    if (!desktop && attachment.localPort !== null) {
      context.addIssue({
        code: "custom",
        message: "Server relay attachments cannot expose a local port.",
        path: ["localPort"],
      });
    }
    if ((attachment.localHost === null) !== (attachment.localPort === null)) {
      context.addIssue({
        code: "custom",
        message: "A local attachment host and port must be reported together.",
        path: ["localPort"],
      });
    }
  });

export const tunnelAttachmentWireSummarySchema = z
  .object({
    id: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    kind: tunnelAttachmentKindSchema,
    clientId: tunnelResourceIdSchema.nullable(),
    status: tunnelStatusSchema,
    errorCode: tunnelContentErrorCodeSchema.nullable(),
    activeConnectionCount: z.number().int().nonnegative(),
    bytesFromSource: z.number().int().nonnegative().safe(),
    bytesToSource: z.number().int().nonnegative().safe(),
    expiresAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const tunnelAttachmentCreateSchema = z
  .object({
    clientId: tunnelResourceIdSchema,
  })
  .strict();

export const tunnelAttachmentCreateResultSchema = z
  .object({
    attachmentId: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    secret: z.string().min(32).max(512),
    connectPath: z.string().startsWith("/api/tunnel-attachments/"),
    secretExpiresAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const tunnelDirectActivationSchema = z
  .object({
    capabilityId: z.string().uuid(),
  })
  .strict();

export const tunnelAttachmentInitializeSchema = z
  .object({
    type: z.literal("initialize"),
    clientId: tunnelResourceIdSchema,
    diagnosticTraceId: z.string().uuid().optional(),
  })
  .strict();

export const tunnelAttachmentReadySchema = z
  .object({
    type: z.literal("ready"),
    attachmentId: tunnelResourceIdSchema,
    tunnelId: tunnelResourceIdSchema,
    sourceEndpointId: tunnelResourceIdSchema,
    destinationEndpointId: tunnelResourceIdSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const tunnelActionCapabilitiesSchema = z
  .object({
    canEdit: z.boolean(),
    canDelete: z.boolean(),
    canStart: z.boolean(),
    canStop: z.boolean(),
    canAttach: z.boolean(),
    canOpenOwner: z.boolean(),
  })
  .strict();

export const tunnelSummarySchema = z
  .object({
    id: tunnelResourceIdSchema,
    name: tunnelNameSchema,
    description: tunnelDescriptionSchema,
    projectId: tunnelResourceIdSchema.nullable(),
    position: z.number().int().nonnegative(),
    origin: tunnelOriginSchema,
    management: tunnelManagementSchema,
    protocolHint: tunnelProtocolHintSchema,
    source: tunnelSourceEndpointSchema,
    destination: tunnelDestinationEndpointSchema,
    managedBy: tunnelManagedResourceSchema.nullable(),
    desiredState: tunnelDesiredStateSchema,
    status: tunnelStatusSchema,
    lastError: z.string().min(1).max(4_000).nullable(),
    activeConnectionCount: z.number().int().nonnegative(),
    bytesFromSource: z.number().int().nonnegative().safe(),
    bytesToSource: z.number().int().nonnegative().safe(),
    attachments: z.array(tunnelAttachmentSummarySchema).max(128),
    capabilities: tunnelActionCapabilitiesSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((tunnel, context) => {
    const userManaged = tunnel.management === "user-managed";
    if (userManaged !== (tunnel.origin === "user")) {
      context.addIssue({
        code: "custom",
        message: "Only user-origin tunnels may be user managed.",
        path: ["management"],
      });
    }
    if (userManaged !== (tunnel.managedBy === null)) {
      context.addIssue({
        code: "custom",
        message: "Managed tunnels require an owning resource.",
        path: ["managedBy"],
      });
    }
  });

export const tunnelListSchema = z.array(tunnelSummarySchema).max(10_000);

export const tunnelWireSummarySchema = z
  .object({
    id: tunnelResourceIdSchema,
    projectId: tunnelResourceIdSchema.nullable(),
    position: z.number().int().nonnegative(),
    origin: tunnelOriginSchema,
    management: tunnelManagementSchema,
    protocolHint: tunnelProtocolHintSchema,
    source: tunnelPublicSourceEndpointSchema,
    destination: tunnelPublicDestinationEndpointSchema,
    managedBy: tunnelManagedResourceSchema.nullable(),
    desiredState: tunnelDesiredStateSchema,
    status: tunnelStatusSchema,
    errorCode: tunnelContentErrorCodeSchema.nullable(),
    activeConnectionCount: z.number().int().nonnegative(),
    bytesFromSource: z.number().int().nonnegative().safe(),
    bytesToSource: z.number().int().nonnegative().safe(),
    attachments: z.array(tunnelAttachmentWireSummarySchema).max(128),
    capabilities: tunnelActionCapabilitiesSchema,
    protectedRecord: protectedTunnelContentRecordSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const tunnelWireListSchema = z
  .array(tunnelWireSummarySchema)
  .max(10_000);

export type TunnelOrigin = z.infer<typeof tunnelOriginSchema>;
export type TunnelManagement = z.infer<typeof tunnelManagementSchema>;
export type TunnelProtocolHint = z.infer<typeof tunnelProtocolHintSchema>;
export type TunnelDesiredState = z.infer<typeof tunnelDesiredStateSchema>;
export type TunnelStatus = z.infer<typeof tunnelStatusSchema>;
export type TunnelSourceEndpoint = z.infer<typeof tunnelSourceEndpointSchema>;
export type TunnelDestinationEndpoint = z.infer<
  typeof tunnelDestinationEndpointSchema
>;
export type TunnelManagedResource = z.infer<typeof tunnelManagedResourceSchema>;
export type TunnelUserCreate = z.infer<typeof tunnelUserCreateSchema>;
export type TunnelUserUpdate = z.infer<typeof tunnelUserUpdateSchema>;
export type TunnelUserWireCreate = z.infer<typeof tunnelUserWireCreateSchema>;
export type TunnelUserWireUpdate = z.infer<typeof tunnelUserWireUpdateSchema>;
export type TunnelAttachmentCreate = z.infer<
  typeof tunnelAttachmentCreateSchema
>;
export type TunnelAttachmentCreateResult = z.infer<
  typeof tunnelAttachmentCreateResultSchema
>;
export type TunnelAttachmentInitialize = z.infer<
  typeof tunnelAttachmentInitializeSchema
>;
export type TunnelAttachmentReady = z.infer<typeof tunnelAttachmentReadySchema>;
export type TunnelManagedRegistration = z.infer<
  typeof tunnelManagedRegistrationSchema
>;
export type TunnelAttachmentKind = z.infer<typeof tunnelAttachmentKindSchema>;
export type TunnelAttachmentSummary = z.infer<
  typeof tunnelAttachmentSummarySchema
>;
export type TunnelAttachmentWireSummary = z.infer<
  typeof tunnelAttachmentWireSummarySchema
>;
export type TunnelActionCapabilities = z.infer<
  typeof tunnelActionCapabilitiesSchema
>;
export type TunnelSummary = z.infer<typeof tunnelSummarySchema>;
export type TunnelWireSummary = z.infer<typeof tunnelWireSummarySchema>;
