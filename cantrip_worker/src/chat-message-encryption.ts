import { randomUUID } from "node:crypto";

import {
  clearSensitiveBytes,
  decryptChatMessageProtectedContent,
  encryptChatMessageProtectedContent,
} from "@cantrip/crypto";
import {
  agentTurnResultSchema,
  chatMessageContentSchema,
  chatMessageRelayResultSchema,
  type AgentActivity,
  type AgentTurnResult,
  type ChatMessage,
  type NormalizedAgentMessage,
} from "@cantrip/protocol";
import {
  chatMessageOpaqueContentSchema,
  chatMessageOpaqueSummarySchema,
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

async function protectMessage(input: {
  content: ReturnType<typeof chatMessageContentSchema.parse>;
  id: string;
  idempotencyKey: string;
  service: WorkerEncryptionService;
}): Promise<ChatMessageOpaqueContent> {
  const component = input.service.componentKey("chat-content");
  const ownerId = input.service.ownerId();
  const classification = {
    role: "assistant" as const,
    mode: "default" as const,
    attachmentIds: [] as string[],
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
        content: { version: 1, classification, content: input.content },
      }),
      reasoningEffort: null,
      idempotencyKey: input.idempotencyKey,
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
      message: await protectMessage({
        content: chatMessageContentSchema.parse([
          {
            type: "text",
            text: message.text,
            phase: message.phase,
            correlation: message.correlation,
          },
        ]),
        id: this.#id(key),
        idempotencyKey: key,
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
      message: await protectMessage({
        content: chatMessageContentSchema.parse([
          { type: "activity", activity },
        ]),
        id: this.#id(key),
        idempotencyKey: key,
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
      message: await protectMessage({
        content: chatMessageContentSchema.parse([
          { type: "text", text: input.text, phase: "final_answer" },
        ]),
        id: this.#id(key),
        idempotencyKey: key,
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
  const message = await protectMessage({
    content: chatMessageContentSchema.parse([
      {
        type: "text",
        text: result.text || "The agent completed without a message.",
        phase: "final_answer",
      },
    ]),
    id: input.messageId,
    idempotencyKey: input.idempotencyKey,
    service: input.service,
  });
  return agentTurnResultSchema.parse({
    ...result,
    text: "",
    structuredResult: chatMessageRelayResultSchema.parse({ message }),
  });
}
