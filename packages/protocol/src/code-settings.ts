import { z } from "zod";

import {
  endpointContentContextSchema,
  endpointContentOpaqueSchema,
} from "./endpoint-content.js";
import {
  type WorkflowJsonObject,
  workflowJsonObjectSchemaWithLimits,
} from "./workflows.js";

export const CODE_SETTINGS_PROFILE_ID = "default";
export const CODE_SETTINGS_OPERATION = "code-settings.record";

export const codeSettingsProfileIdSchema = z.literal(CODE_SETTINGS_PROFILE_ID);

const codeSettingsJsonObjectSchema = workflowJsonObjectSchemaWithLimits({
  maxBytes: 1_000_000,
  maxStringLength: 100_000,
});

export const codeSettingsReservedKeys = [
  "cantrip.appearance",
  "cantrip.bridgeToken",
  "cantrip.bridgeUrl",
  "cantrip.projectId",
  "cantrip.projectName",
  "cantrip.presentation",
  "cantrip.sessionId",
  "cantrip.workerId",
  "cantrip.workerName",
  "cantrip.worktreeId",
  "cantrip.worktreeName",
] as const;

const reservedKeys = new Set<string>(codeSettingsReservedKeys);

export const codeSettingsPayloadSchema = z
  .object({
    formatVersion: z.literal(1),
    settings: codeSettingsJsonObjectSchema,
  })
  .strict()
  .superRefine(({ settings }, context) => {
    for (const key of Object.keys(settings)) {
      if (!reservedKeys.has(key)) continue;
      context.addIssue({
        code: "custom",
        message: `${key} is managed by the Cantrip Code session.`,
        path: ["settings", key],
      });
    }
  });

export const protectedCodeSettingsRecordSchema = z
  .object({
    operationId: z.string().uuid(),
    revision: z.number().int().positive().safe(),
    protectedContent: endpointContentOpaqueSchema,
  })
  .strict()
  .refine(
    ({ protectedContent }) =>
      protectedContent.domain === "customization-content",
    "Code settings records require customization-content ciphertext.",
  );

export const codeSettingsStoredProfileSchema = z
  .object({
    profileId: codeSettingsProfileIdSchema,
    record: protectedCodeSettingsRecordSchema,
    updatedAt: z.string().datetime({ offset: true }),
    updatedByWorkerId: z.string().min(1).max(255).nullable(),
  })
  .strict();

export const codeSettingsPublicStatusSchema = z
  .object({
    profileId: codeSettingsProfileIdSchema,
    initialized: z.boolean(),
    revision: z.number().int().positive().safe().nullable(),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
    updatedByWorkerId: z.string().min(1).max(255).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasRevision = value.revision !== null;
    const hasUpdatedAt = value.updatedAt !== null;
    if (
      value.initialized !== hasRevision ||
      value.initialized !== hasUpdatedAt
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Code settings initialization and revision metadata must agree.",
      });
    }
  });

export const codeSettingsUploadSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative().safe().nullable(),
    record: protectedCodeSettingsRecordSchema,
  })
  .strict()
  .superRefine(({ expectedRevision, record }, context) => {
    const nextRevision = expectedRevision === null ? 1 : expectedRevision + 1;
    if (record.revision !== nextRevision) {
      context.addIssue({
        code: "custom",
        message: `The protected record revision must be ${nextRevision}.`,
        path: ["record", "revision"],
      });
    }
  });

export const codeSettingsRevisionConflictSchema = z
  .object({
    code: z.literal("revision-conflict"),
    profileId: codeSettingsProfileIdSchema,
    currentRevision: z.number().int().positive().safe().nullable(),
    error: z.string().min(1).max(500),
  })
  .strict();

export const codeSettingsInvalidationSchema = z
  .object({
    profileId: codeSettingsProfileIdSchema,
    revision: z.number().int().positive().safe(),
  })
  .strict();

export function codeSettingsScopeId(profileId: string): string {
  return JSON.stringify(["global-code-settings", profileId]);
}

export function codeSettingsContentContext(input: {
  operationId: string;
  profileId: string;
  revision: number;
  serverId: string;
}) {
  return endpointContentContextSchema.parse({
    domain: "customization-content",
    serverId: input.serverId,
    workerId: null,
    scopeId: codeSettingsScopeId(input.profileId),
    operationId: input.operationId,
    operation: CODE_SETTINGS_OPERATION,
    direction: "stored",
    sequence: input.revision,
  });
}

export type CodeSettingsPayload = z.infer<typeof codeSettingsPayloadSchema>;
export type CodeSettingsJsonObject = WorkflowJsonObject;
export type ProtectedCodeSettingsRecord = z.infer<
  typeof protectedCodeSettingsRecordSchema
>;
export type CodeSettingsStoredProfile = z.infer<
  typeof codeSettingsStoredProfileSchema
>;
export type CodeSettingsPublicStatus = z.infer<
  typeof codeSettingsPublicStatusSchema
>;
export type CodeSettingsUpload = z.infer<typeof codeSettingsUploadSchema>;
export type CodeSettingsRevisionConflict = z.infer<
  typeof codeSettingsRevisionConflictSchema
>;
export type CodeSettingsInvalidation = z.infer<
  typeof codeSettingsInvalidationSchema
>;
