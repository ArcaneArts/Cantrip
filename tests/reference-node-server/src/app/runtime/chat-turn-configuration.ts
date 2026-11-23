import { modelConfigurationSchema } from "@cantrip/protocol";
import type { ChatExecutionContext } from "../../db/repository.js";
import type { ChatTurnInput, ChatTurnOptions } from "./chat-turn-types.js";

export function validateChatTurnInput(
  context: ChatExecutionContext,
  input: ChatTurnInput,
  options: ChatTurnOptions,
) {
  if (
    context.contextKind === "standalone" &&
    ((input.mode !== undefined && input.mode !== "default") ||
      options.structuredResult ||
      options.encryptedTaskMessages ||
      options.taskDispatchLease)
  ) {
    throw new Error(
      "Standalone Chat supports only ordinary default-mode conversation turns.",
    );
  }
  if (
    options.structuredResult &&
    Boolean(options.structuredResult.outputSchema) ===
      Boolean(options.structuredResult.taskOperation)
  ) {
    throw new Error("Structured turns require exactly one result contract.");
  }
}

export function chatTurnModelConfiguration(
  context: ChatExecutionContext,
  input: ChatTurnInput,
  modelId: string,
) {
  const requestedReasoningEffort =
    input.reasoningEffort !== undefined
      ? input.reasoningEffort
      : context.reasoningEffort;
  const turnModelConfiguration = modelConfigurationSchema.parse({
    modelId,
    reasoningEffort: requestedReasoningEffort,
    customSubagentModel:
      context.contextKind === "standalone"
        ? false
        : (input.customSubagentModel ??
          context.modelConfiguration.customSubagentModel),
    subagentModelId:
      context.contextKind === "standalone"
        ? null
        : input.subagentModelId !== undefined
          ? input.subagentModelId
          : context.modelConfiguration.subagentModelId,
    subagentReasoningEffort:
      context.contextKind === "standalone"
        ? null
        : input.subagentReasoningEffort !== undefined
          ? input.subagentReasoningEffort
          : context.modelConfiguration.subagentReasoningEffort,
  });
  return { requestedReasoningEffort, turnModelConfiguration };
}
