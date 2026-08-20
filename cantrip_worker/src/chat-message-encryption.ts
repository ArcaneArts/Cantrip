import { randomUUID } from "node:crypto";

import {
  clearSensitiveBytes,
  decryptChatMessageProtectedContent,
  encryptChatMessageProtectedContent,
  encryptQueuedPromptProtectedContent,
} from "@cantrip/crypto";
import {
  agentTurnResultSchema,
  chatMessageContentSchema,
  chatMessageRelayResultSchema,
  encryptedChatTurnCreateSchema,
  type AgentActivity,
  type AgentTurnResult,
  type ChatMessage,
  type ChatMessageCreate,
  type ChatTurnMode,
  type NormalizedAgentMessage,
  type ReasoningEffort,
} from "@cantrip/protocol";
import {
  chatMessageOpaqueContentSchema,
  chatMessageOpaqueSummarySchema,
  queuedPromptOpaqueContentSchema,
  type ChatMessageOpaqueContent,
  type ChatMessageOpaqueSummary,
} from "@cantrip/protocol/communication-content";

import type { WorkerEncryptionService } from "./worker-encryption.js";

function activitySummary(activity: AgentActivity): string {
  if (activity.type === "usage") {
    return `[usage: ${activity.last.totalTokens} tokens]`;
  }
  if (activity.type === "rateLimit") {
    return `[rate limit: ${activity.primary?.usedPercent ?? "unknown"}% used]`;
  }
  return `[${activity.type}: ${JSON.stringify(activity)}]`;
}

function continuationPrompt(messages: ChatMessage[], prompt: string): string {
  if (messages.length === 0) return prompt;
  const transcript = messages
    .slice(-100)
    .map((message) => {
      const content = message.content
        .flatMap((item) => {
          if (item.type === "text") return [item.text];
          if (item.type === "attachment") {
            return [
              `[attachment: ${item.attachment.fileName} (${item.attachment.mimeType})]`,
            ];
          }
          return [activitySummary(item.activity)];
        })
        .join("\n");
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
  return `Continue this existing Cantrip conversation. The encrypted endpoint history follows:\n\n${transcript}\n\nUSER: ${prompt}`;
}

async function openMessage(input: {
  componentKey: Uint8Array;
  message: ChatMessageOpaqueSummary | ChatMessageOpaqueContent;
  ownerId: string;
}) {
  const message = input.message;
  const publicClassification =
    "classification" in message
      ? message.classification
      : {
          role: message.role,
          mode: message.mode,
          attachmentIds: message.attachmentIds,
        };
  const opened = await decryptChatMessageProtectedContent({
    ownerId: input.ownerId,
    messageId: message.id,
    keyRevision: message.protectedContent.keyRevision,
    componentKey: input.componentKey,
    encrypted: message.protectedContent,
    publicClassification,
  });
  return chatMessageContentSchema.parse(opened.content);
}

function textFromContent(
  content: ReturnType<typeof chatMessageContentSchema.parse>,
) {
  return content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n\n")
    .trim();
}

export async function openEncryptedChatTurn(input: {
  history: ChatMessageOpaqueSummary[];
  prompt: ChatMessageOpaqueContent;
  service: WorkerEncryptionService;
  threadId: string | null;
}) {
  const ownerId = input.service.ownerId();
  const component = input.service.componentKey("chat-content");
  try {
    const promptContent = await openMessage({
      componentKey: component.key,
      message: chatMessageOpaqueContentSchema.parse(input.prompt),
      ownerId,
    });
    const prompt =
      textFromContent(promptContent) ||
      "Review the attached files and respond to the user.";
    if (input.threadId) return prompt;
    const history = await Promise.all(
      input.history.map(async (raw): Promise<ChatMessage> => {
        const message = chatMessageOpaqueSummarySchema.parse(raw);
        const content = await openMessage({
          componentKey: component.key,
          message,
          ownerId,
        });
        return {
          ...message,
          content,
        };
      }),
    );
    return continuationPrompt(history, prompt);
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function protectChatMessage(input: {
  id: string;
  message: ChatMessageCreate & { idempotencyKey: string };
  service: WorkerEncryptionService;
}): Promise<ChatMessageOpaqueContent> {
  const message = {
    ...input.message,
    content: chatMessageContentSchema.parse(input.message.content),
  };
  const component = input.service.componentKey("chat-content");
  const ownerId = input.service.ownerId();
  const classification = {
    role: message.role,
    mode: message.mode ?? "default",
    attachmentIds: message.content.flatMap((item) =>
      item.type === "attachment" ? [item.attachment.id] : [],
    ),
  };
  try {
    return chatMessageOpaqueContentSchema.parse({
      id: input.id,
      classification,
      protectedContent: await encryptChatMessageProtectedContent({
        ownerId,
        messageId: input.id,
        keyRevision: component.keyRevision,
        componentKey: component.key,
        content: { version: 1, classification, content: message.content },
      }),
      reasoningEffort: message.reasoningEffort ?? null,
      idempotencyKey: message.idempotencyKey,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function reprotectChatMessages(input: {
  messages: Array<{
    source: ChatMessageOpaqueSummary;
    id: string;
    idempotencyKey: string;
  }>;
  service: WorkerEncryptionService;
}): Promise<ChatMessageOpaqueContent[]> {
  const component = input.service.componentKey("chat-content");
  const ownerId = input.service.ownerId();
  try {
    return await Promise.all(
      input.messages.map(async ({ source: raw, id, idempotencyKey }) => {
        const source = chatMessageOpaqueSummarySchema.parse(raw);
        const classification = {
          role: source.role,
          mode: source.mode,
          attachmentIds: source.attachmentIds,
        };
        const content = await openMessage({
          componentKey: component.key,
          message: source,
          ownerId,
        });
        return chatMessageOpaqueContentSchema.parse({
          id,
          classification,
          protectedContent: await encryptChatMessageProtectedContent({
            ownerId,
            messageId: id,
            keyRevision: component.keyRevision,
            componentKey: component.key,
            content: { version: 1, classification, content },
          }),
          reasoningEffort: source.reasoningEffort,
          idempotencyKey,
        });
      }),
    );
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export async function protectChatTurn(input: {
  idempotencyKey: string;
  messageId: string;
  mode: ChatTurnMode;
  modelId: string;
  promptId: string;
  reasoningEffort: ReasoningEffort | null;
  service: WorkerEncryptionService;
  text: string;
}) {
  const pendingMessage = await protectChatMessage({
    id: input.messageId,
    message: {
      role: "user",
      mode: input.mode,
      content: [{ type: "text", text: input.text }],
      reasoningEffort: input.reasoningEffort,
      idempotencyKey: input.idempotencyKey,
    },
    service: input.service,
  });
  const component = input.service.componentKey("chat-content");
  const ownerId = input.service.ownerId();
  const classification = { mode: input.mode, attachmentIds: [] as string[] };
  try {
    const queuedPrompt = queuedPromptOpaqueContentSchema.parse({
      id: input.promptId,
      classification,
      protectedContent: await encryptQueuedPromptProtectedContent({
        ownerId,
        promptId: input.promptId,
        keyRevision: component.keyRevision,
        componentKey: component.key,
        content: { version: 1, classification, text: input.text },
      }),
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      worktreeId: null,
      frozen: false,
      idempotencyKey: input.idempotencyKey,
      pendingMessage,
    });
    return encryptedChatTurnCreateSchema.parse({
      message: pendingMessage,
      queuedPrompt,
      modelId: input.modelId,
    });
  } finally {
    clearSensitiveBytes(component.key);
  }
}

export class EncryptedChatEventSealer {
  readonly #ids = new Map<string, string>();
  readonly #service: WorkerEncryptionService;

  constructor(service: WorkerEncryptionService) {
    this.#service = service;
  }

  #id(key: string): string {
    const existing = this.#ids.get(key);
    if (existing) return existing;
    const created = randomUUID();
    this.#ids.set(key, created);
    return created;
  }

  async message(message: NormalizedAgentMessage) {
    const turnId = message.correlation?.turnId ?? null;
    const key = `agent-message:${turnId ?? "turn"}:${message.id}`;
    return {
      type: "agent.protected-message" as const,
      message: await protectChatMessage({
        id: this.#id(key),
        message: {
          role: "assistant",
          content: chatMessageContentSchema.parse([
            {
              type: "text",
              text: message.text,
              phase: message.phase,
              correlation: message.correlation,
            },
          ]),
          idempotencyKey: key,
        },
        service: this.#service,
      }),
      telemetry: { kind: "message" as const, phase: message.phase, turnId },
    };
  }

  async activity(activity: AgentActivity) {
    const turnId = activity.correlation?.turnId ?? null;
    const key =
      activity.type === "worktree"
        ? activity.id
        : `activity:${turnId ?? "turn"}:${activity.id}`;
    return {
      type: "agent.protected-message" as const,
      message: await protectChatMessage({
        id: this.#id(key),
        message: {
          role: "assistant",
          content: chatMessageContentSchema.parse([
            { type: "activity", activity },
          ]),
          idempotencyKey: key,
        },
        service: this.#service,
      }),
      telemetry: {
        kind: "activity" as const,
        activityType: activity.type,
        turnId,
      },
    };
  }

  async checkpoint(input: { text: string; turnId: string }) {
    const key = `goal-checkpoint:${input.turnId}`;
    return {
      type: "agent.protected-message" as const,
      message: await protectChatMessage({
        id: this.#id(key),
        message: {
          role: "assistant",
          content: chatMessageContentSchema.parse([
            { type: "text", text: input.text, phase: "final_answer" },
          ]),
          idempotencyKey: key,
        },
        service: this.#service,
      }),
      telemetry: { kind: "checkpoint" as const, turnId: input.turnId },
    };
  }
}

export async function encryptChatTurnResult(input: {
  idempotencyKey: string;
  messageId: string;
  result: AgentTurnResult;
  service: WorkerEncryptionService;
}): Promise<AgentTurnResult> {
  const result = agentTurnResultSchema.parse(input.result);
  const message = await protectChatMessage({
    id: input.messageId,
    message: {
      role: "assistant",
      content: chatMessageContentSchema.parse([
        {
          type: "text",
          text: result.text || "The agent completed without a message.",
          phase: "final_answer",
        },
      ]),
      idempotencyKey: input.idempotencyKey,
    },
    service: input.service,
  });
  return agentTurnResultSchema.parse({
    ...result,
    text: "",
    structuredResult: chatMessageRelayResultSchema.parse({ message }),
  });
}
