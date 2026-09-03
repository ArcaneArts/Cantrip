import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";

export const PROJECT_AUTOMATION_CONTENT_PROTECTED_BYTES_LIMIT =
  4 * 1_024 * 1_024;

export const projectAutomationContentFieldSchema = z.enum([
  "name",
  "prompt",
  "condition",
]);

export const projectAutomationContentContextSchema = z
  .object({
    recordKind: z.literal("project-automation"),
    recordId: z.string().trim().min(1).max(500),
    field: projectAutomationContentFieldSchema,
  })
  .strict();

export const projectAutomationContentOpaqueSchema = z
  .object({
    formatVersion: z.literal(1),
    keyRevision: encryptionKeyRevisionSchema,
    envelope: encryptedPayloadEnvelopeSchema,
  })
  .strict()
  .refine(
    ({ envelope }) =>
      envelope.ciphertext.length <=
      Math.ceil(
        ((PROJECT_AUTOMATION_CONTENT_PROTECTED_BYTES_LIMIT + 16) * 4) / 3,
      ),
    "Encrypted project automation content exceeds its byte limit.",
  );

export type ProjectAutomationContentContext = z.infer<
  typeof projectAutomationContentContextSchema
>;
export type ProjectAutomationContentOpaque = z.infer<
  typeof projectAutomationContentOpaqueSchema
>;
