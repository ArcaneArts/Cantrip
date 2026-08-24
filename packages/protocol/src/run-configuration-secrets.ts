import { z } from "zod";

import { runConfigurationSecretReferenceSchema } from "./run-configuration-definitions.js";
import { protectedSecretEnvelopeSchema } from "./protected-secrets.js";

export const RUN_CONFIGURATION_SECRET_VALUE_CHARACTERS_LIMIT = 16 * 1_024;
export const RUN_CONFIGURATION_SECRET_PROTECTED_CONTENT_BYTES_LIMIT =
  64 * 1_024 + 128;
export const RUN_CONFIGURATION_SECRET_LIST_LIMIT = 256;

const runConfigurationSecretOperationIdSchema = z.string().uuid();

export const runConfigurationSecretProtectedValueSchema =
  protectedSecretEnvelopeSchema.refine(
    ({ envelope }) =>
      envelope.ciphertext.length <=
      Math.ceil(
        ((RUN_CONFIGURATION_SECRET_PROTECTED_CONTENT_BYTES_LIMIT + 16) * 4) / 3,
      ),
    "Encrypted Run configuration secret exceeds its byte limit.",
  );

export function runConfigurationSecretProtectionRowId(input: {
  projectId: string;
  reference: string;
}): string {
  return JSON.stringify([
    z.string().uuid().parse(input.projectId),
    runConfigurationSecretReferenceSchema.parse(input.reference),
  ]);
}

export const runConfigurationSecretValueContentSchema = z
  .object({
    version: z.literal(1),
    value: z
      .string()
      .min(1)
      .max(RUN_CONFIGURATION_SECRET_VALUE_CHARACTERS_LIMIT)
      .refine((value) => !value.includes("\0"), {
        message: "Secret values cannot contain NUL characters.",
      }),
  })
  .strict();

export const runConfigurationSecretSummarySchema = z
  .object({
    reference: runConfigurationSecretReferenceSchema,
    available: z.boolean(),
    revision: z.number().int().positive().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.available !==
      (summary.revision !== null && summary.updatedAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Available Run configuration secrets require revision metadata.",
      });
    }
  });

export const runConfigurationSecretSummaryListSchema = z
  .array(runConfigurationSecretSummarySchema)
  .max(RUN_CONFIGURATION_SECRET_LIST_LIMIT)
  .superRefine((secrets, context) => {
    const references = new Set<string>();
    secrets.forEach((secret, index) => {
      if (references.has(secret.reference)) {
        context.addIssue({
          code: "custom",
          message: "Secret summary references must be unique.",
          path: [index, "reference"],
        });
      }
      references.add(secret.reference);
    });
  });

export const runConfigurationProtectedSecretSchema = z
  .object({
    reference: runConfigurationSecretReferenceSchema,
    revision: z.number().int().positive(),
    protectedValue: runConfigurationSecretProtectedValueSchema,
  })
  .strict();

export const runConfigurationProtectedSecretListSchema = z
  .array(runConfigurationProtectedSecretSchema)
  .max(RUN_CONFIGURATION_SECRET_LIST_LIMIT)
  .superRefine((secrets, context) => {
    const references = new Set<string>();
    secrets.forEach((secret, index) => {
      if (references.has(secret.reference)) {
        context.addIssue({
          code: "custom",
          message: "Protected secret references must be unique.",
          path: [index, "reference"],
        });
      }
      references.add(secret.reference);
    });
  });

export const runConfigurationSecretListResultSchema = z
  .object({
    projectId: z.string().uuid(),
    secrets: runConfigurationSecretSummaryListSchema,
  })
  .strict();

export const runConfigurationSecretSetRequestSchema = z
  .object({
    operationId: runConfigurationSecretOperationIdSchema,
    reference: runConfigurationSecretReferenceSchema,
    protectedValue: runConfigurationSecretProtectedValueSchema,
  })
  .strict();

export const runConfigurationSecretSetResultSchema = z
  .object({
    operationId: runConfigurationSecretOperationIdSchema,
    projectId: z.string().uuid(),
    replayed: z.boolean(),
    secret: runConfigurationSecretSummarySchema.safeExtend({
      available: z.literal(true),
      revision: z.number().int().positive(),
      updatedAt: z.iso.datetime(),
    }),
  })
  .strict();

export type RunConfigurationSecretValueContent = z.infer<
  typeof runConfigurationSecretValueContentSchema
>;
export type RunConfigurationSecretSummary = z.infer<
  typeof runConfigurationSecretSummarySchema
>;
export type RunConfigurationProtectedSecret = z.infer<
  typeof runConfigurationProtectedSecretSchema
>;
export type RunConfigurationSecretSetRequest = z.infer<
  typeof runConfigurationSecretSetRequestSchema
>;
export type RunConfigurationSecretSetResult = z.infer<
  typeof runConfigurationSecretSetResultSchema
>;
