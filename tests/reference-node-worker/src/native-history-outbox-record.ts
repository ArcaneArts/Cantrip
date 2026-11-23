import { createHash } from "node:crypto";
import { z } from "zod";
import { encryptedPayloadEnvelopeSchema } from "@cantrip/protocol/encryption";

export const historyDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const historySequenceSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const nativeHistoryOutboxRecordSchema = z
  .object({
    version: z.literal(1),
    streamId: z.string().uuid(),
    sequence: historySequenceSchema,
    recordId: z.string().uuid(),
    previousDigest: historyDigestSchema.nullable(),
    envelope: encryptedPayloadEnvelopeSchema,
    digest: historyDigestSchema,
  })
  .strict();
export type NativeHistoryOutboxRecord = z.infer<
  typeof nativeHistoryOutboxRecordSchema
>;
export const nativeHistoryJournalHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
