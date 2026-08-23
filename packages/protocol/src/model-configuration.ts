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
