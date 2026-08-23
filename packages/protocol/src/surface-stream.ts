import { z } from "zod";

import {
  explorerDirectoryCommitsSchema,
  explorerDirectorySchema,
  explorerEntryDeleteSchema,
  explorerEntryMutationResultSchema,
  explorerEntryRenameSchema,
  explorerFileSchema,
  explorerFileWriteSchema,
  explorerMediaFileChunkSchema,
} from "./explorer.js";
import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT = 4 * 1024 * 1024;

export const surfaceStreamKindSchema = z.enum(["terminal", "explorer"]);
export const surfaceStreamDirectionSchema = z.enum([
  "request",
  "response",
  "input",
  "output",
]);

export const surfaceStreamContextSchema = z
  .object({
    serverId: z.string().min(1).max(2_000),
    surfaceKind: surfaceStreamKindSchema,
    surfaceId: z.string().min(1).max(200),
    operationId: z.string().min(1).max(200),
    direction: surfaceStreamDirectionSchema,
    sequence: z.number().int().nonnegative().safe(),
  })
  .strict();

export const surfaceStreamOpaqueSchema = z
  .object({
    formatVersion: z.literal(1),
    keyRevision: encryptionKeyRevisionSchema,
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict();

export const surfaceStreamWireRequestSchema = z
  .object({
    operationId: surfaceStreamContextSchema.shape.operationId,
    sequence: surfaceStreamContextSchema.shape.sequence,
    protectedRequest: surfaceStreamOpaqueSchema,
  })
  .strict();

export const surfaceStreamWireResponseSchema = z
  .object({
    operationId: surfaceStreamContextSchema.shape.operationId,
    sequence: surfaceStreamContextSchema.shape.sequence,
    protectedResponse: surfaceStreamOpaqueSchema,
  })
  .strict();

export const terminalInputContentSchema = z
  .object({ type: z.literal("terminal.input"), data: z.string().max(100_000) })
  .strict();

export const terminalOutputContentSchema = z
  .object({ type: z.literal("terminal.output"), data: z.string() })
  .strict();

export const terminalSnapshotRequestContentSchema = z
  .object({
    type: z.literal("terminal.snapshot"),
    maxChars: z.number().int().min(1).max(100_000),
  })
  .strict();

export const terminalSnapshotContentSchema = z
  .object({
    type: z.literal("terminal.snapshot"),
    terminalId: z.string().min(1).max(200),
    status: z.enum(["running", "restarting", "exited", "not-running"]),
    data: z.string().max(100_000),
    truncated: z.boolean(),
    exitCode: z.number().int().nullable(),
  })
  .strict();

export const explorerOperationRequestContentSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({ type: z.literal("explorer.directory.list"), path: z.string() })
      .strict(),
    z
      .object({
        type: z.literal("explorer.directory.commits"),
        path: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("explorer.file.read"),
        path: explorerFileWriteSchema.shape.path,
      })
      .strict(),
    z
      .object({
        type: z.literal("explorer.media.read"),
        path: explorerFileWriteSchema.shape.path,
        offset: z.number().int().nonnegative(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(256 * 1_024),
      })
      .strict(),
    z
      .object({ type: z.literal("explorer.file.write") })
      .extend(explorerFileWriteSchema.shape)
      .strict(),
    z
      .object({ type: z.literal("explorer.entry.rename") })
      .extend(explorerEntryRenameSchema.shape)
      .strict(),
    z
      .object({ type: z.literal("explorer.entry.delete") })
      .extend(explorerEntryDeleteSchema.shape)
      .strict(),
  ],
);

export const explorerOperationResultContentSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("explorer.directory.list"),
        value: explorerDirectorySchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("explorer.directory.commits"),
        value: explorerDirectoryCommitsSchema,
      })
      .strict(),
    z
      .object({ type: z.literal("explorer.file"), value: explorerFileSchema })
      .strict(),
    z
      .object({
        type: z.literal("explorer.media"),
        value: explorerMediaFileChunkSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("explorer.entry.mutated"),
        value: explorerEntryMutationResultSchema,
      })
      .strict(),
  ],
);

export const surfaceOperationOutcomeContentSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      result: z.union([
        explorerOperationResultContentSchema,
        terminalSnapshotContentSchema,
        z.object({ type: z.literal("terminal.input.accepted") }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1).max(2_000),
    })
    .strict(),
]);

export type ExplorerOperationRequestContent = z.infer<
  typeof explorerOperationRequestContentSchema
>;
export type ExplorerOperationResultContent = z.infer<
  typeof explorerOperationResultContentSchema
>;
export type SurfaceOperationOutcomeContent = z.infer<
  typeof surfaceOperationOutcomeContentSchema
>;
export type SurfaceStreamContext = z.infer<typeof surfaceStreamContextSchema>;
export type SurfaceStreamOpaque = z.infer<typeof surfaceStreamOpaqueSchema>;
