import { z } from "zod";
import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const CANTRIP_OS_BACKUP_CHUNK_BYTES = 1_048_576;
export const CANTRIP_OS_BACKUP_METADATA_BYTES = 16 * 1_048_576;
export const CANTRIP_OS_BACKUP_END_BYTES = 4_096;

export const cantripOsBackupCryptoContextSchema = z
  .object({
    ownerId: z.string().min(1).max(200),
    serverId: z.string().min(1).max(2_000),
    backupId: z.string().uuid(),
  })
  .strict();

export const cantripOsBackupFrameSchema = z
  .object({
    kind: z.enum(["metadata", "chunk", "end"]),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict();

export const cantripOsBackupFileHeaderSchema = z
  .object({
    format: z.literal("CantripOS-private-backup"),
    version: z.literal(1),
    backupId: z.string().uuid(),
    keyRevision: encryptionKeyRevisionSchema,
    metadata: cantripOsBackupFrameSchema,
  })
  .strict();

export const cantripOsBackupArchiveMetadataSchema = z
  .object({
    version: z.literal(1),
    archiveBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
    manifest: z.record(z.string(), z.unknown()),
  })
  .strict();

export const cantripOsBackupEndSchema = cantripOsBackupArchiveMetadataSchema
  .omit({ version: true, manifest: true })
  .extend({
    chunks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type CantripOsBackupCryptoContext = z.infer<
  typeof cantripOsBackupCryptoContextSchema
>;
export type CantripOsBackupFrame = z.infer<typeof cantripOsBackupFrameSchema>;
export type CantripOsBackupArchiveMetadata = z.infer<
  typeof cantripOsBackupArchiveMetadataSchema
>;
