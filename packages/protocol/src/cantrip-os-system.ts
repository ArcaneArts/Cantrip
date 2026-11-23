import { z } from "zod";
import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const CANTRIP_OS_SYSTEM_CHUNK_BYTES = 1_048_576;
export const CANTRIP_OS_SYSTEM_METADATA_BYTES = 16 * 1_048_576;
export const CANTRIP_OS_SYSTEM_END_BYTES = 4_096;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const cantripOsSystemCryptoContextSchema = z
  .object({
    ownerId: z.string().min(1).max(200),
    serverId: z.string().min(1).max(2_000),
    workerId: z.string().min(1).max(200),
    instanceId: z.uuid(),
    guestInstanceId: z.uuid(),
    attachmentGeneration: z.uuid(),
    targetGeneration: z.uuid(),
    operationId: z.uuid(),
    checkpointId: z.uuid(),
    containerId: digest,
  })
  .strict();

export const cantripOsSystemSnapshotSchema = z
  .object({
    format: z.literal("cantrip-os-private-system-image"),
    version: z.literal(1),
    imageId: image,
    requestSha256: digest,
    instanceId: z.uuid(),
    sourceContainerId: digest,
    sourceBaseImageId: image,
    architecture: z.string().min(1).max(200),
    os: z.literal("linux"),
    createdAt: z.string().min(1).max(200),
    size: count,
    evidence: z.enum(["acknowledged-and-verified", "observed-labeled-image"]),
    consistency: z.literal("stopped-container-filesystem"),
    containsPrivateIdentity: z.literal(true),
    identityPolicy: z.literal("same-instance-only"),
    runtimeHandlesRestored: z.literal(false),
    mounts: z
      .array(
        z
          .object({
            type: z.string().min(1).max(200),
            source: z.string().max(32_768).nullable(),
            destination: z.string().max(32_768),
            readOnly: z.boolean(),
            included: z.literal(false),
          })
          .strict(),
      )
      .max(4_096),
    regeneratedPaths: z.array(z.string().max(32_768)).max(100),
  })
  .strict();

export const cantripOsSystemManifestSchema = z
  .object({
    version: z.literal(1),
    snapshot: cantripOsSystemSnapshotSchema,
  })
  .strict();
export const cantripOsSystemFrameSchema = z
  .object({
    kind: z.enum(["manifest", "chunk", "end", "result"]),
    sequence: count,
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict();
export const cantripOsSystemFileHeaderSchema = z
  .object({
    format: z.literal("CantripOS-private-system"),
    version: z.literal(1),
    checkpointId: z.uuid(),
    streamId: z.uuid(),
    keyRevision: encryptionKeyRevisionSchema,
    manifest: cantripOsSystemFrameSchema,
  })
  .strict();
export const cantripOsSystemEndSchema = z
  .object({
    archiveBytes: count.positive(),
    archiveSha256: digest,
    manifestSha256: digest,
    chunks: count.positive(),
  })
  .strict();
export const cantripOsSystemArchiveReceiptSchema = cantripOsSystemEndSchema
  .extend({
    keyRevision: encryptionKeyRevisionSchema,
    streamId: z.uuid(),
  })
  .strict();
export const cantripOsSystemCaptureAdmissionSchema = z
  .object({
    context: cantripOsSystemCryptoContextSchema,
    container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
    resumeOriginal: z.boolean(),
  })
  .strict();
export const cantripOsSystemProtectedResultSchema = z
  .object({
    streamId: z.uuid(),
    keyRevision: encryptionKeyRevisionSchema,
    frame: cantripOsSystemFrameSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.frame.kind === "result" &&
      value.frame.sequence === 0 &&
      value.frame.envelope.keyRevision === value.keyRevision,
    "Invalid private system result frame",
  );
export const cantripOsSystemCaptureOutcomeSchema = z
  .object({
    operationId: z.uuid(),
    checkpointId: z.uuid(),
    state: z.enum(["running", "ready", "failed", "unknown"]),
    phase: z.string().min(1).max(200),
    protectedResult: cantripOsSystemProtectedResultSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => value.state !== "ready" || value.protectedResult !== null,
    "Completed system checkpoints require a protected receipt",
  );
export type CantripOsSystemCryptoContext = z.infer<
  typeof cantripOsSystemCryptoContextSchema
>;
export type CantripOsSystemManifest = z.infer<
  typeof cantripOsSystemManifestSchema
>;
export type CantripOsSystemFrame = z.infer<typeof cantripOsSystemFrameSchema>;
export type CantripOsSystemArchiveReceipt = z.infer<
  typeof cantripOsSystemArchiveReceiptSchema
>;
export type CantripOsSystemCaptureAdmission = z.infer<
  typeof cantripOsSystemCaptureAdmissionSchema
>;
export type CantripOsSystemCaptureOutcome = z.infer<
  typeof cantripOsSystemCaptureOutcomeSchema
>;
