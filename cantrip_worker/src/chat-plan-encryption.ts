import {
  clearSensitiveBytes,
  decryptChatPlanProtectedContent,
  encryptChatPlanProtectedContent,
} from "@cantrip/crypto";
import { chatPlanStateSchema, type ChatPlanState } from "@cantrip/protocol";
import {
  chatPlanOpaqueStateSchema,
  type ChatPlanOpaqueState,
} from "@cantrip/protocol/communication-content";

import type { WorkerEncryptionService } from "./worker-encryption.js";

export type PrivateChatPlanState = Pick<
  ChatPlanState,
  "explanation" | "steps" | "question"
>;

export async function protectChatPlanState(input: {
  chatId: string;
  service: WorkerEncryptionService;
  state: PrivateChatPlanState;
}): Promise<ChatPlanOpaqueState> {
  const component = input.service.componentKey("chat-content");
  const classification = { hasQuestion: Boolean(input.state.question) };
  try {
    return chatPlanOpaqueStateSchema.parse({
      classification,
      protectedContent: await encryptChatPlanProtectedContent({
        ownerId: input.service.ownerId(),
        chatId: input.chatId,
        keyRevision: component.keyRevision,
        componentKey: component.key,
        content: { version: 1, classification, ...input.state },
      }),
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function openChatPlanState(input: {
  chatId: string;
  protectedState: ChatPlanOpaqueState | null;
  service: WorkerEncryptionService;
}): Promise<PrivateChatPlanState> {
  if (!input.protectedState) {
    return { explanation: null, steps: [], question: null };
  }
  const state = chatPlanOpaqueStateSchema.parse(input.protectedState);
  const component = input.service.componentKey("chat-content");
  try {
    const opened = await decryptChatPlanProtectedContent({
      ownerId: input.service.ownerId(),
      chatId: input.chatId,
      keyRevision: state.protectedContent.keyRevision,
      componentKey: component.key,
      encrypted: state.protectedContent,
      publicClassification: state.classification,
    });
    const validated = chatPlanStateSchema.parse({ mode: "plan", ...opened });
    return {
      explanation: validated.explanation,
      steps: validated.steps,
      question: validated.question,
    };
  } finally {
    clearSensitiveBytes(component.key);
  }
}
