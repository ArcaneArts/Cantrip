import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionBytesSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const PRIVATE_DISPLAY_LABEL_LIMIT = 1_000;
export const PRIVATE_DISPLAY_LABEL_PROTECTED_CONTENT_BYTES_LIMIT = 4 * 1_024;

export const privateDisplayLabelRecordKindSchema = z.enum([
  "project",
  "chat",
  "terminal",
  "explorer",
  "code-tab",
  "browser",
  "remote-surface",
  "project-view",
  "tab-group",
]);

export const privateDisplayLabelClassificationSchema = z
  .object({ recordKind: privateDisplayLabelRecordKindSchema })
  .strict();

export const privateDisplayLabelProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: privateDisplayLabelClassificationSchema,
    label: z.string().min(1).max(PRIVATE_DISPLAY_LABEL_LIMIT),
  })
  .strict();

const maximumCiphertextCharacters = Math.ceil(
  ((PRIVATE_DISPLAY_LABEL_PROTECTED_CONTENT_BYTES_LIMIT + 16) * 4) / 3,
);

export const encryptedPrivateDisplayLabelSchema = z
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
        message:
          "Protected display-label envelope metadata must match its outer metadata.",
        path: ["envelope"],
      });
    }
  });

export const privateDisplayLabelOpaqueSchema = z
  .object({
    classification: privateDisplayLabelClassificationSchema,
    protectedLabel: encryptedPrivateDisplayLabelSchema,
  })
  .strict();

export const privateDisplayLabelAvailabilitySchema = z.enum([
  "ready",
  "locked",
  "missing",
  "revoked",
  "stale",
  "corrupt",
  "unsupported",
]);

export type PrivateDisplayLabelRecordKind = z.infer<
  typeof privateDisplayLabelRecordKindSchema
>;
export type PrivateDisplayLabelClassification = z.infer<
  typeof privateDisplayLabelClassificationSchema
>;
export type PrivateDisplayLabelProtectedContent = z.infer<
  typeof privateDisplayLabelProtectedContentSchema
>;
export type EncryptedPrivateDisplayLabel = z.infer<
  typeof encryptedPrivateDisplayLabelSchema
>;
export type PrivateDisplayLabelOpaque = z.infer<
  typeof privateDisplayLabelOpaqueSchema
>;
export type PrivateDisplayLabelAvailability = z.infer<
  typeof privateDisplayLabelAvailabilitySchema
>;
