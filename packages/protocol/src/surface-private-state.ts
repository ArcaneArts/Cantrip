import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionBytesSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const SURFACE_PRIVATE_STATE_PROTECTED_CONTENT_BYTES_LIMIT =
  4 * 1_024 * 1_024;

export const surfacePrivateStateRecordKindSchema = z.enum([
  "terminal-state",
  "explorer-state",
  "browser-state",
  "remote-desktop-state",
  "remote-desktop-inventory",
]);

export const surfacePrivateStateResourceSchema = z.enum([
  "terminal-row",
  "terminal-operation",
  "explorer-row",
  "explorer-operation",
  "browser-row",
  "browser-remote-surface",
  "browser-operation",
  "remote-desktop-row",
  "remote-desktop-surface",
  "remote-desktop-operation",
  "remote-desktop-inventory",
]);

export const surfacePrivateStateClassificationSchema = z
  .object({ recordKind: surfacePrivateStateRecordKindSchema })
  .strict();

export const terminalPrivateDirectorySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project-root") }).strict(),
  z
    .object({
      kind: z.literal("relative-path"),
      path: z
        .string()
        .min(1)
        .max(4_096)
        .refine(
          (value) =>
            !value.startsWith("/") &&
            !/^[A-Za-z]:[\\/]/u.test(value) &&
            !value.split(/[\\/]/u).includes("..") &&
            !value.includes("\0"),
          "Expected a safe repository-relative path.",
        ),
    })
    .strict(),
]);

export const terminalPrivateStateProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: z
      .object({ recordKind: z.literal("terminal-state") })
      .strict(),
    directory: terminalPrivateDirectorySchema,
    serviceCommand: z.string().max(100_000),
  })
  .strict();

export const explorerPrivateStateProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: z
      .object({ recordKind: z.literal("explorer-state") })
      .strict(),
    selectedPath: z.string().min(1).max(8_192).nullable(),
  })
  .strict();

const protectedHttpUrlSchema = z
  .url()
  .max(4_096)
  .refine((value) => /^https?:\/\//u.test(value), {
    message: "Protected browser URLs must use HTTP or HTTPS.",
  });

export const browserPrivateStateProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: z
      .object({ recordKind: z.literal("browser-state") })
      .strict(),
    revision: z.number().int().positive().safe(),
    url: protectedHttpUrlSchema,
  })
  .strict();

export const remoteDesktopPrivateTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("monitor"),
      id: z.string().min(1).max(200).nullable(),
      name: z.string().trim().min(1).max(500).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("window"),
      id: z.string().min(1).max(200).nullable(),
      application: z.string().trim().min(1).max(500),
      title: z.string().trim().min(1).max(1_000).nullable(),
    })
    .strict(),
]);

export const remoteDesktopPrivateStateProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: z
      .object({ recordKind: z.literal("remote-desktop-state") })
      .strict(),
    revision: z.number().int().positive().safe(),
    target: remoteDesktopPrivateTargetSchema,
  })
  .strict();

const remoteDesktopPrivateMonitorSchema = z
  .object({
    kind: z.literal("monitor"),
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(500),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    primary: z.boolean(),
  })
  .strict();

const remoteDesktopPrivateWindowSchema = z
  .object({
    kind: z.literal("window"),
    id: z.string().min(1).max(200),
    application: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(1_000),
    iconKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9:_-]+$/u)
      .nullable(),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    minimized: z.boolean(),
    focused: z.boolean(),
  })
  .strict();

export const remoteDesktopPrivateInventoryProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: z
      .object({ recordKind: z.literal("remote-desktop-inventory") })
      .strict(),
    monitors: z.array(remoteDesktopPrivateMonitorSchema).max(64),
    windows: z.array(remoteDesktopPrivateWindowSchema).max(2_000),
    requested: remoteDesktopPrivateTargetSchema.nullable().default(null),
    active: remoteDesktopPrivateTargetSchema.nullable().default(null),
    launchingApplication: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .nullable()
      .default(null),
    message: z.string().max(2_048).nullable().default(null),
  })
  .strict();

export const surfacePrivateStateProtectedContentSchema = z.union([
  terminalPrivateStateProtectedContentSchema,
  explorerPrivateStateProtectedContentSchema,
  browserPrivateStateProtectedContentSchema,
  remoteDesktopPrivateStateProtectedContentSchema,
  remoteDesktopPrivateInventoryProtectedContentSchema,
]);

const maximumCiphertextCharacters = Math.ceil(
  ((SURFACE_PRIVATE_STATE_PROTECTED_CONTENT_BYTES_LIMIT + 16) * 4) / 3,
);

export const encryptedSurfacePrivateStateSchema = z
  .object({
    formatVersion: z.literal(1),
    keyRevision: encryptionKeyRevisionSchema,
    envelope: encryptedPayloadEnvelopeSchema.extend({
      ciphertext: encryptionBytesSchema
        .min(22)
        .max(maximumCiphertextCharacters),
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.envelope.version !== value.formatVersion ||
      value.envelope.keyRevision !== value.keyRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "Protected surface-state envelope metadata must agree.",
        path: ["envelope"],
      });
    }
  });

export const surfacePrivateStateOpaqueSchema = z
  .object({
    classification: surfacePrivateStateClassificationSchema,
    protectedState: encryptedSurfacePrivateStateSchema,
  })
  .strict();

function opaqueFor(recordKind: SurfacePrivateStateRecordKind) {
  return surfacePrivateStateOpaqueSchema.refine(
    (value) => value.classification.recordKind === recordKind,
    {
      message: `Expected ${recordKind} protected state.`,
      path: ["classification", "recordKind"],
    },
  );
}

export const terminalPrivateStateOpaqueSchema = opaqueFor("terminal-state");
export const explorerPrivateStateOpaqueSchema = opaqueFor("explorer-state");
export const browserPrivateStateOpaqueSchema = opaqueFor("browser-state");
export const remoteDesktopPrivateStateOpaqueSchema = opaqueFor(
  "remote-desktop-state",
);
export const remoteDesktopPrivateInventoryOpaqueSchema = opaqueFor(
  "remote-desktop-inventory",
);

export const surfacePrivateStateContextSchema = z
  .object({
    serverId: z.string().min(1).max(255),
    resource: surfacePrivateStateResourceSchema,
    resourceId: z.string().min(1).max(200),
    operationId: z.string().min(1).max(200).nullable(),
    recordKind: surfacePrivateStateRecordKindSchema,
  })
  .strict();

export const surfacePrivateStateAvailabilitySchema = z.enum([
  "ready",
  "locked",
  "missing",
  "missing-grant",
  "revoked",
  "stale",
  "corrupt",
  "wrong-recipient",
  "unsupported",
]);

export type SurfacePrivateStateRecordKind = z.infer<
  typeof surfacePrivateStateRecordKindSchema
>;
export type SurfacePrivateStateResource = z.infer<
  typeof surfacePrivateStateResourceSchema
>;
export type SurfacePrivateStateClassification = z.infer<
  typeof surfacePrivateStateClassificationSchema
>;
export type SurfacePrivateStateProtectedContent = z.infer<
  typeof surfacePrivateStateProtectedContentSchema
>;
export type EncryptedSurfacePrivateState = z.infer<
  typeof encryptedSurfacePrivateStateSchema
>;
export type SurfacePrivateStateOpaque = z.infer<
  typeof surfacePrivateStateOpaqueSchema
>;
export type SurfacePrivateStateContext = z.infer<
  typeof surfacePrivateStateContextSchema
>;
export type SurfacePrivateStateAvailability = z.infer<
  typeof surfacePrivateStateAvailabilitySchema
>;
