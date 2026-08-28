import type {
  ChatMessageOpaqueContent,
  ChatTurnCreate,
  ReasoningEffort,
} from "@cantrip/protocol";

import type {
  ChatExecutionContext,
  ModelRuntime,
} from "../../db/repository.js";

/** The subset of the application turn starter used by Chat HTTP routes. */
export type ChatTurnStarter = (
  context: ChatExecutionContext,
  input: Omit<ChatTurnCreate, "attachmentIds" | "mode"> & {
    attachmentIds?: string[];
    customSubagentModel?: boolean;
    mode?: ChatTurnCreate["mode"];
    subagentModelId?: string | null;
    subagentReasoningEffort?: ReasoningEffort | null;
  },
  options?: {
    encryptedChatMessages?: {
      userMessage: ChatMessageOpaqueContent;
      response: { id: string; idempotencyKey: string };
    };
    retryMessageId?: string;
    runtimes?: ModelRuntime[];
  },
) => Promise<unknown>;
