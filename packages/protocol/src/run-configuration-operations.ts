import { z } from "zod";

import {
  runConfigurationDeleteRequestSchema,
  runConfigurationDeleteResultSchema,
  runConfigurationCodexEnvironmentSourceStatusSchema,
  runConfigurationDetectionCandidateSchema,
  runConfigurationDiagnosticSchema,
  runConfigurationIdSchema,
  runConfigurationProviderCapabilitySchema,
  runConfigurationProviderKindSchema,
  runConfigurationReadResultSchema,
  runConfigurationRepositoryChangeSchema,
  runConfigurationRepositoryInventorySchema,
  runConfigurationWriteRequestSchema,
  runConfigurationWriteResultSchema,
} from "./run-configuration-definitions.js";

export const runConfigurationOperationIdSchema = z.string().uuid();

const runConfigurationOperationContextFields = {
  operationId: runConfigurationOperationIdSchema,
  projectId: z.string().uuid(),
};

const runConfigurationWorkerContextFields = {
  ...runConfigurationOperationContextFields,
  sourcePath: z.string().min(1).max(8_192),
};

export const runConfigurationListWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.list"),
    ...runConfigurationWorkerContextFields,
  })
  .strict();

export const runConfigurationGetWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.get"),
    ...runConfigurationWorkerContextFields,
    configurationId: runConfigurationIdSchema,
  })
  .strict();

export const runConfigurationCapabilitiesWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.capabilities"),
    ...runConfigurationWorkerContextFields,
  })
  .strict();

export const runConfigurationDetectWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.detect"),
    ...runConfigurationWorkerContextFields,
    providerKind: runConfigurationProviderKindSchema.nullable().default(null),
  })
  .strict();

export const runConfigurationWriteWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.write"),
    ...runConfigurationWorkerContextFields,
    request: runConfigurationWriteRequestSchema,
  })
  .strict();

export const runConfigurationDeleteWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.delete"),
    ...runConfigurationWorkerContextFields,
    request: runConfigurationDeleteRequestSchema,
  })
  .strict();

export const runConfigurationDefinitionWorkerCommandSchemas = [
  runConfigurationListWorkerCommandSchema,
  runConfigurationGetWorkerCommandSchema,
  runConfigurationCapabilitiesWorkerCommandSchema,
  runConfigurationDetectWorkerCommandSchema,
  runConfigurationWriteWorkerCommandSchema,
  runConfigurationDeleteWorkerCommandSchema,
] as const;

export const runConfigurationListResponseSchema = z
  .object({
    operation: z.literal("list"),
    ...runConfigurationOperationContextFields,
    inventory: runConfigurationRepositoryInventorySchema,
  })
  .strict();

export const runConfigurationGetResponseSchema = z
  .object({
    operation: z.literal("get"),
    ...runConfigurationOperationContextFields,
    result: runConfigurationReadResultSchema,
    codexEnvironment: runConfigurationCodexEnvironmentSourceStatusSchema,
  })
  .strict();

const providerCapabilitiesSchema = z
  .array(runConfigurationProviderCapabilitySchema)
  .max(6)
  .superRefine((capabilities, context) => {
    const providers = new Set<string>();
    capabilities.forEach((capability, index) => {
      if (providers.has(capability.provider)) {
        context.addIssue({
          code: "custom",
          message: "Provider capabilities must be unique.",
          path: [index, "provider"],
        });
      }
      providers.add(capability.provider);
    });
  });

export const runConfigurationCapabilitiesResponseSchema = z
  .object({
    operation: z.literal("capabilities"),
    ...runConfigurationOperationContextFields,
    capabilities: providerCapabilitiesSchema,
  })
  .strict();

export const runConfigurationDetectResponseSchema = z
  .object({
    operation: z.literal("detect"),
    ...runConfigurationOperationContextFields,
    candidates: z.array(runConfigurationDetectionCandidateSchema).max(128),
    diagnostics: z.array(runConfigurationDiagnosticSchema).max(200),
  })
  .strict();

export const runConfigurationWriteResponseSchema = z
  .object({
    operation: z.literal("write"),
    ...runConfigurationOperationContextFields,
    result: runConfigurationWriteResultSchema,
  })
  .strict();

export const runConfigurationDeleteResponseSchema = z
  .object({
    operation: z.literal("delete"),
    ...runConfigurationOperationContextFields,
    result: runConfigurationDeleteResultSchema,
  })
  .strict();

export const runConfigurationOperationResponseSchema = z.discriminatedUnion(
  "operation",
  [
    runConfigurationListResponseSchema,
    runConfigurationGetResponseSchema,
    runConfigurationCapabilitiesResponseSchema,
    runConfigurationDetectResponseSchema,
    runConfigurationWriteResponseSchema,
    runConfigurationDeleteResponseSchema,
  ],
);

export const runConfigurationDefinitionChangeNotificationSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.changed"),
    projectId: z.string().uuid(),
    sourcePath: z.string().min(1).max(8_192),
    change: runConfigurationRepositoryChangeSchema,
  })
  .strict();

export const runConfigurationListQuerySchema = z
  .object({ operationId: runConfigurationOperationIdSchema })
  .strict();

export const runConfigurationDetectQuerySchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    provider: runConfigurationProviderKindSchema.optional(),
  })
  .strict();

export const runConfigurationApiWriteRequestSchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    expectedRevision: runConfigurationWriteRequestSchema.shape.expectedRevision,
    document: runConfigurationWriteRequestSchema.shape.document,
  })
  .strict();

export const runConfigurationApiDeleteRequestSchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    expectedRevision:
      runConfigurationDeleteRequestSchema.shape.expectedRevision,
  })
  .strict();

export type RunConfigurationDefinitionWorkerCommand = z.infer<
  (typeof runConfigurationDefinitionWorkerCommandSchemas)[number]
>;
export type RunConfigurationOperationResponse = z.infer<
  typeof runConfigurationOperationResponseSchema
>;
export type RunConfigurationDefinitionChangeNotification = z.infer<
  typeof runConfigurationDefinitionChangeNotificationSchema
>;
export type RunConfigurationApiWriteRequest = z.infer<
  typeof runConfigurationApiWriteRequestSchema
>;
export type RunConfigurationApiDeleteRequest = z.infer<
  typeof runConfigurationApiDeleteRequestSchema
>;
