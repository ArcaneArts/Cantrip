import { z } from "zod";

const configuredModelIdSchema = z.string().trim().min(1).max(200);
const configuredReasoningEffortSchema = z.string().trim().min(1).max(80);

/**
 * Durable model configuration shared by account defaults, chats, and queued
 * turns. A null root model preserves the pre-configuration state of accounts
 * that do not have an available model yet.
 */
export const modelConfigurationSchema = z
  .object({
    modelId: configuredModelIdSchema.nullable(),
    reasoningEffort: configuredReasoningEffortSchema.nullable().default(null),
    customSubagentModel: z.boolean().default(false),
    subagentModelId: configuredModelIdSchema.nullable().default(null),
    subagentReasoningEffort: configuredReasoningEffortSchema
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.customSubagentModel && !configuration.subagentModelId) {
      context.addIssue({
        code: "custom",
        message: "A custom subagent model must be selected.",
        path: ["subagentModelId"],
      });
    }
  });

export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;

export const modelConfigurationFailureCodeSchema = z.enum([
  "worker-offline",
  "worker-subagents-unavailable",
  "chat-runtime-active",
  "root-model-unavailable",
  "subagent-model-unavailable",
  "root-reasoning-unsupported",
  "subagent-reasoning-unsupported",
  "provider-route-incompatible",
]);

export const modelConfigurationFieldSchema = z.enum([
  "modelId",
  "reasoningEffort",
  "customSubagentModel",
  "subagentModelId",
  "subagentReasoningEffort",
]);

export const modelConfigurationFailureSchema = z
  .object({
    error: z.string().min(1).max(4_000),
    code: modelConfigurationFailureCodeSchema,
    field: modelConfigurationFieldSchema.nullable(),
    retryable: z.boolean(),
  })
  .strict();

export type ModelConfigurationFailureCode = z.infer<
  typeof modelConfigurationFailureCodeSchema
>;
export type ModelConfigurationFailure = z.infer<
  typeof modelConfigurationFailureSchema
>;

export const EMPTY_MODEL_CONFIGURATION: ModelConfiguration = {
  modelId: null,
  reasoningEffort: null,
  customSubagentModel: false,
  subagentModelId: null,
  subagentReasoningEffort: null,
};

export function effectiveSubagentModelConfiguration(
  configuration: ModelConfiguration,
): Pick<ModelConfiguration, "modelId" | "reasoningEffort"> {
  return configuration.customSubagentModel
    ? {
        modelId: configuration.subagentModelId,
        reasoningEffort: configuration.subagentReasoningEffort,
      }
    : {
        modelId: configuration.modelId,
        reasoningEffort: configuration.reasoningEffort,
      };
}
