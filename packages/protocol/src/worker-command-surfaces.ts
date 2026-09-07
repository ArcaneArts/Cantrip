import { z } from "zod";
import {
  attachmentChunkOpaqueSchema,
  attachmentProtectedMetadataSchema,
  chatAttachmentSummarySchema,
} from "./attachment-content.js";
import {
  surfaceStreamOpaqueSchema,
  surfaceStreamWireRequestSchema,
} from "./surface-stream.js";
import { mcpServerOpaqueRuntimeSchema } from "./protected-secrets.js";
import {
  browserPrivateStateOpaqueSchema,
  remoteDesktopPrivateStateOpaqueSchema,
  terminalPrivateStateOpaqueSchema,
} from "./surface-private-state.js";
import {
  remoteSurfaceTransportSchema,
  remoteSurfaceWebRtcConfigurationSchema,
} from "./runtime-capabilities.js";
import { permissionProfileIdSchema } from "./permission-profiles.js";
import { terminalServiceRuntimeConfigurationSchema } from "./terminals.js";
import {
  remoteSurfaceConfigurationSchema,
  remoteSurfaceViewportSchema,
  desktopStreamSettingsSchema,
} from "./remote-surfaces.js";
import {
  workerRuntimeModelSchema,
  workerRuntimeProviderSchema,
} from "./worker-runtime-support.js";

export const workerSurfaceCommandSchemas = [
  z.object({
    type: z.literal("permission-profiles.list"),
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("attachment.upload.begin"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: z.enum(["upload", "relay"]),
    protectedMetadata: attachmentProtectedMetadataSchema,
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
  }),
  z.object({
    type: z.literal("attachment.upload.chunk"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: z.enum(["upload", "relay"]),
    chunk: attachmentChunkOpaqueSchema,
  }),
  z.object({
    type: z.literal("attachment.upload.complete"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("attachment.read"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: z.enum(["download", "relay"]),
    protectedMetadata: attachmentProtectedMetadataSchema,
    sequence: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(256 * 1_024),
  }),
  z.object({
    type: z.literal("attachment.delete"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
  }),
  z
    .object({
      type: z.literal("terminal.open"),
      terminalId: z.string().min(1),
      attachmentId: z.string().min(1),
      operationId: surfaceStreamWireRequestSchema.shape.operationId,
      serverId: z.string().min(1).max(255),
      worktreePath: z.string().min(1).max(8_192),
      stateProtection: terminalPrivateStateOpaqueSchema,
      cols: z.number().int().min(1).max(1_000),
      rows: z.number().int().min(1).max(1_000),
      outputMode: z.enum(["protected", "discard"]).optional(),
      launch: z.discriminatedUnion("type", [
        z.object({ type: z.literal("shell") }),
        z.object({
          type: z.literal("codex"),
          threadId: z.string().min(1).nullable(),
          model: workerRuntimeModelSchema,
          provider: workerRuntimeProviderSchema,
          permissionProfileId: permissionProfileIdSchema.optional(),
          mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).optional(),
        }),
      ]),
    })
    .strict(),
  z.object({
    type: z.literal("terminal.detach"),
    terminalId: z.string().min(1),
    attachmentId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("terminal.input"),
      terminalId: z.string().min(1),
      serverId: z.string().min(1).max(2_000),
      operationId: surfaceStreamWireRequestSchema.shape.operationId,
      sequence: surfaceStreamWireRequestSchema.shape.sequence,
      protectedData: surfaceStreamOpaqueSchema,
      complete: z.boolean().default(false),
    })
    .strict(),
  z.object({
    type: z.literal("terminal.resize"),
    terminalId: z.string().min(1),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
  z.object({
    type: z.literal("terminal.close"),
    terminalId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("terminal.snapshot"),
      terminalId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
    })
    .extend(surfaceStreamWireRequestSchema.shape)
    .strict(),
  z.object({
    type: z.literal("terminal.services.reconcile"),
    services: z.array(terminalServiceRuntimeConfigurationSchema).max(1_000),
  }),
  z.object({
    type: z.literal("terminal.service.restart"),
    terminalId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("surface.attach"),
      surfaceId: z.string().min(1),
      attachmentId: z.string().min(1),
      projectId: z.string().min(1),
      serverId: z.string().min(1).max(255),
      configuration: remoteSurfaceConfigurationSchema,
      stateResource: z
        .enum([
          "browser-row",
          "browser-remote-surface",
          "remote-desktop-row",
          "remote-desktop-surface",
        ])
        .nullable(),
      stateRevision: z.number().int().positive().safe().nullable(),
      stateProtection: z
        .union([
          browserPrivateStateOpaqueSchema,
          remoteDesktopPrivateStateOpaqueSchema,
        ])
        .nullable(),
      preferredTransport: remoteSurfaceTransportSchema,
      webrtc: remoteSurfaceWebRtcConfigurationSchema.nullable().default(null),
      viewport: remoteSurfaceViewportSchema,
      desktopStream: desktopStreamSettingsSchema.nullable().default(null),
    })
    .strict()
    .superRefine((command, context) => {
      const expectedRecordKind =
        command.configuration.kind === "browser"
          ? "browser-state"
          : "remote-desktop-state";
      const validResource =
        command.configuration.kind === "browser"
          ? command.stateResource === "browser-row" ||
            command.stateResource === "browser-remote-surface"
          : command.stateResource === "remote-desktop-row" ||
            command.stateResource === "remote-desktop-surface";
      if (
        command.stateProtection?.classification.recordKind !==
          expectedRecordKind ||
        command.stateRevision === null ||
        !validResource
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Surface commands require protected state matching their kind.",
          path: ["stateProtection"],
        });
      }
    }),
  z.object({
    type: z.literal("surface.detach"),
    surfaceId: z.string().min(1),
    attachmentId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("surface.configure"),
      surfaceId: z.string().min(1),
      serverId: z.string().min(1).max(255),
      configuration: remoteSurfaceConfigurationSchema,
      stateResource: z
        .enum([
          "browser-row",
          "browser-remote-surface",
          "remote-desktop-row",
          "remote-desktop-surface",
        ])
        .nullable(),
      stateRevision: z.number().int().positive().safe().nullable(),
      stateProtection: z
        .union([
          browserPrivateStateOpaqueSchema,
          remoteDesktopPrivateStateOpaqueSchema,
        ])
        .nullable(),
    })
    .strict()
    .superRefine((command, context) => {
      const expectedRecordKind =
        command.configuration.kind === "browser"
          ? "browser-state"
          : "remote-desktop-state";
      const validResource =
        command.configuration.kind === "browser"
          ? command.stateResource === "browser-row" ||
            command.stateResource === "browser-remote-surface"
          : command.stateResource === "remote-desktop-row" ||
            command.stateResource === "remote-desktop-surface";
      if (
        command.stateProtection?.classification.recordKind !==
          expectedRecordKind ||
        command.stateRevision === null ||
        !validResource
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Surface commands require protected state matching their kind.",
          path: ["stateProtection"],
        });
      }
    }),
  z.object({
    type: z.literal("surface.suspend"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.resume"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.close"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.desktop.probe"),
  }),
  z
    .object({
      type: z.literal("surface.desktop.targets"),
      serverId: z.string().min(1).max(255),
      operationId: z.string().uuid(),
      resourceId: z.string().min(1).max(200),
      limit: z.number().int().nonnegative().max(2_064),
    })
    .strict(),
  z.object({
    type: z.literal("model.provider.test"),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
] as const;
