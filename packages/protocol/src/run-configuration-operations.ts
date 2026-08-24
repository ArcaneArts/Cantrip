import { z } from "zod";

import {
  RUN_CONFIGURATION_MAX_FILES,
  runConfigurationDeleteRequestSchema,
  runConfigurationDeleteResultSchema,
  runConfigurationCodexEnvironmentSourceStatusSchema,
  runConfigurationDetectionCandidateSchema,
  runConfigurationDiagnosticSchema,
  runConfigurationFileSchema,
  runConfigurationFlutterDocumentSchema,
  runConfigurationIdSchema,
  runConfigurationPlatformSchema,
  runConfigurationPathPurposeSchema,
  runConfigurationPathSuggestionSchema,
  runConfigurationProviderCapabilitySchema,
  runConfigurationProviderValidationSchema,
  runConfigurationProviderKindSchema,
  runConfigurationReadResultSchema,
  runConfigurationRepositoryChangeSchema,
  runConfigurationRepositoryInventorySchema,
  runConfigurationWriteRequestSchema,
  runConfigurationWriteResultSchema,
} from "./run-configuration-definitions.js";
import { runConfigurationSecretSummaryListSchema } from "./run-configuration-secrets.js";

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

export const runConfigurationPathSearchQuerySchema = z
  .string()
  .max(256)
  .refine((value) => !value.includes("\0"), "Queries cannot contain NULs.");

export const runConfigurationPathsWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.paths"),
    ...runConfigurationWorkerContextFields,
    purpose: runConfigurationPathPurposeSchema,
    query: runConfigurationPathSearchQuerySchema,
  })
  .strict();

export const runConfigurationFlutterDeviceSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(256),
    supported: z.boolean(),
    emulator: z.boolean(),
    targetPlatform: z.string().trim().min(1).max(256).nullable(),
  })
  .strict();

export const runConfigurationFlutterDevicesWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.flutter-devices"),
    ...runConfigurationWorkerContextFields,
    document: runConfigurationFlutterDocumentSchema,
  })
  .strict();

export const runConfigurationValidateWorkerCommandSchema = z
  .object({
    type: z.literal("project.run-configuration-definitions.validate"),
    ...runConfigurationWorkerContextFields,
    document: runConfigurationFileSchema,
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
  runConfigurationPathsWorkerCommandSchema,
  runConfigurationFlutterDevicesWorkerCommandSchema,
  runConfigurationValidateWorkerCommandSchema,
  runConfigurationWriteWorkerCommandSchema,
  runConfigurationDeleteWorkerCommandSchema,
] as const;

export const runConfigurationListResponseSchema = z
  .object({
    operation: z.literal("list"),
    ...runConfigurationOperationContextFields,
    inventory: runConfigurationRepositoryInventorySchema,
    validations: z
      .array(runConfigurationProviderValidationSchema)
      .max(RUN_CONFIGURATION_MAX_FILES),
  })
  .strict()
  .superRefine((response, context) => {
    const ready = new Map(
      response.inventory.entries.flatMap((entry) =>
        entry.status === "ready" && entry.id && entry.document
          ? [[entry.id, entry.document.provider] as const]
          : [],
      ),
    );
    const seen = new Set<string>();
    response.validations.forEach((validation, index) => {
      if (seen.has(validation.configurationId)) {
        context.addIssue({
          code: "custom",
          message: "Run configuration list validations must be unique.",
          path: ["validations", index, "configurationId"],
        });
      }
      seen.add(validation.configurationId);
      const provider = ready.get(validation.configurationId);
      if (provider === undefined || provider !== validation.provider) {
        context.addIssue({
          code: "custom",
          message:
            "Run configuration list validation does not match a ready definition.",
          path: ["validations", index],
        });
      }
    });
    for (const configurationId of ready.keys()) {
      if (!seen.has(configurationId)) {
        context.addIssue({
          code: "custom",
          message:
            "Every ready Run configuration must include provider validation.",
          path: ["validations"],
        });
      }
    }
  });

export const runConfigurationGetResponseSchema = z
  .object({
    operation: z.literal("get"),
    ...runConfigurationOperationContextFields,
    result: runConfigurationReadResultSchema,
    codexEnvironment: runConfigurationCodexEnvironmentSourceStatusSchema,
    secretReferences: runConfigurationSecretSummaryListSchema,
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

export const runConfigurationPathsResponseSchema = z
  .object({
    operation: z.literal("paths"),
    ...runConfigurationOperationContextFields,
    purpose: runConfigurationPathPurposeSchema,
    query: runConfigurationPathSearchQuerySchema,
    suggestions: z.array(runConfigurationPathSuggestionSchema).max(100),
    truncated: z.boolean(),
  })
  .strict();

export const runConfigurationFlutterDevicesResponseSchema = z
  .object({
    operation: z.literal("flutter-devices"),
    ...runConfigurationOperationContextFields,
    configurationId: runConfigurationIdSchema,
    platform: runConfigurationPlatformSchema,
    devices: z.array(runConfigurationFlutterDeviceSchema).max(256),
    diagnostics: z.array(runConfigurationDiagnosticSchema).max(200),
  })
  .strict();

export const runConfigurationValidateResponseSchema = z
  .object({
    operation: z.literal("validate"),
    ...runConfigurationOperationContextFields,
    validation: runConfigurationProviderValidationSchema,
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
    runConfigurationPathsResponseSchema,
    runConfigurationFlutterDevicesResponseSchema,
    runConfigurationValidateResponseSchema,
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

export const runConfigurationPathsQuerySchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    purpose: runConfigurationPathPurposeSchema,
    query: runConfigurationPathSearchQuerySchema.default(""),
  })
  .strict();

export const runConfigurationApiValidateRequestSchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    document: runConfigurationFileSchema,
  })
  .strict();

export const runConfigurationApiFlutterDevicesRequestSchema = z
  .object({
    operationId: runConfigurationOperationIdSchema,
    document: runConfigurationFlutterDocumentSchema,
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
export type RunConfigurationFlutterDevice = z.infer<
  typeof runConfigurationFlutterDeviceSchema
>;
export type RunConfigurationFlutterDevicesResponse = z.infer<
  typeof runConfigurationFlutterDevicesResponseSchema
>;
export type RunConfigurationDefinitionChangeNotification = z.infer<
  typeof runConfigurationDefinitionChangeNotificationSchema
>;
export type RunConfigurationApiWriteRequest = z.infer<
  typeof runConfigurationApiWriteRequestSchema
>;
export type RunConfigurationApiValidateRequest = z.infer<
  typeof runConfigurationApiValidateRequestSchema
>;
export type RunConfigurationApiFlutterDevicesRequest = z.infer<
  typeof runConfigurationApiFlutterDevicesRequestSchema
>;
export type RunConfigurationApiDeleteRequest = z.infer<
  typeof runConfigurationApiDeleteRequestSchema
>;
