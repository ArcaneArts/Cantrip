import {
  clearSensitiveBytes,
  decryptTaskProtectedContent,
} from "@cantrip/crypto";
import {
  labelingInstructions,
  normalizeGeneratedLabel,
  type WorkerCommand,
} from "@cantrip/protocol";
import { taskProtectedClassificationSchema } from "@cantrip/protocol/tasks";
import { openEncryptedChatTurn } from "./chat-message-encryption.js";
import { encodePrivateDisplayLabelForWorker } from "./private-label-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

type Command = Extract<WorkerCommand, { type: "label.generate" }>;

export async function generatePrivateLabel(
  command: Command,
  service: WorkerEncryptionService,
  infer: (instructions: string, input: string) => Promise<string>,
) {
  let text: string;
  if (command.input.kind === "message") {
    if (command.input.message.classification.role !== "user")
      throw new Error("Labels require a user request.");
    text = await openEncryptedChatTurn({
      prompt: command.input.message,
      history: [],
      service,
      threadId: null,
    });
  } else {
    const task = command.input.task;
    if (task.chatId !== command.chatId)
      throw new Error("Label input belongs to another Task.");
    const {
      state,
      stableStateBeforeFailure,
      activeOperationKind,
      planAuthorship,
      planningRound,
      hasPlan,
      hasQuestions,
      hasFinalPlan,
      hasGoalPrompt,
      lastError,
    } = task;
    const component = service.componentKey("task-content");
    try {
      const opened = await decryptTaskProtectedContent({
        ownerId: service.ownerId(),
        chatId: command.chatId,
        componentKey: component.key,
        keyRevision: component.keyRevision,
        encrypted: task.protectedContent,
        publicClassification: taskProtectedClassificationSchema.parse({
          state,
          stableStateBeforeFailure,
          activeOperationKind,
          planAuthorship,
          planningRound,
          hasPlan,
          hasQuestions,
          hasFinalPlan,
          hasGoalPrompt,
          lastError,
        }),
      });
      text = opened.briefMarkdown;
    } finally {
      clearSensitiveBytes(component.key);
    }
  }
  if (!text.trim()) return { titleProtection: null, emptyInput: true };
  const bounded = Array.from(text.trim()).slice(0, 4_000).join("");
  const title = normalizeGeneratedLabel(
    await infer(
      labelingInstructions(command.labelKind),
      JSON.stringify({ initialRequest: bounded }),
    ),
    command.labelKind,
  );
  if (!title) throw new Error("Labeler returned no usable title.");
  return {
    titleProtection: await encodePrivateDisplayLabelForWorker({
      label: title,
      ownerId: service.ownerId(),
      rowId: command.chatId,
      recordKind: "chat",
      service,
    }),
    emptyInput: false,
  };
}
