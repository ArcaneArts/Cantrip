import { clearSensitiveBytes, decryptWorkflowContent } from "@cantrip/crypto";
import {
  projectAutomationOpaqueContentSchema,
  projectAutomationProtectedConditionSchema,
  projectAutomationProtectedNameSchema,
  projectAutomationProtectedPromptSchema,
} from "@cantrip/protocol/automations";
import { projectAutomationProtectedDispatchResultSchema } from "@cantrip/protocol";
import type { ChatTurnMode, ReasoningEffort } from "@cantrip/protocol";

import { evaluateProjectAutomationCondition } from "./automation-conditions.js";
import { protectChatTurn } from "./chat-message-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export async function protectProjectAutomationDispatch(input: {
  automationId: string;
  content: unknown;
  cwd: string;
  repository: string | null;
  promptId: string;
  messageId: string;
  mode: ChatTurnMode;
  modelId: string;
  reasoningEffort: ReasoningEffort | null;
  idempotencyKey: string;
  service: WorkerEncryptionService;
  countOpenIssues(repository: string): Promise<number>;
}) {
  const content = projectAutomationOpaqueContentSchema.parse(input.content);
  const component = input.service.componentKey("workflow-content");
  const ownerId = input.service.ownerId();
  try {
    const [name, prompt, condition] = await Promise.all([
      decryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "project-automation",
          recordId: input.automationId,
          field: "name",
        },
        keyRevision: content.protectedName.keyRevision,
        componentKey: component.key,
        encrypted: content.protectedName,
        schema: projectAutomationProtectedNameSchema,
      }),
      decryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "project-automation",
          recordId: input.automationId,
          field: "prompt",
        },
        keyRevision: content.protectedPrompt.keyRevision,
        componentKey: component.key,
        encrypted: content.protectedPrompt,
        schema: projectAutomationProtectedPromptSchema,
      }),
      decryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "project-automation",
          recordId: input.automationId,
          field: "condition",
        },
        keyRevision: content.protectedCondition.keyRevision,
        componentKey: component.key,
        encrypted: content.protectedCondition,
        schema: projectAutomationProtectedConditionSchema,
      }),
    ]);
    void name;
    const allowed = condition.condition
      ? (
          await evaluateProjectAutomationCondition(
            condition.condition,
            input.cwd,
            input.repository,
            { countOpenIssues: input.countOpenIssues },
          )
        ).allowed
      : true;
    return projectAutomationProtectedDispatchResultSchema.parse({
      allowed,
      protectedTurn: allowed
        ? await protectChatTurn({
            idempotencyKey: input.idempotencyKey,
            messageId: input.messageId,
            mode: input.mode,
            modelId: input.modelId,
            promptId: input.promptId,
            reasoningEffort: input.reasoningEffort,
            service: input.service,
            text: prompt.prompt,
          })
        : null,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}
