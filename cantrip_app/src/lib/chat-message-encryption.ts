import {
  clearSensitiveBytes,
  decryptChatMessageProtectedContent,
  decryptQueuedPromptProtectedContent,
  encryptChatMessageProtectedContent,
  encryptQueuedPromptProtectedContent,
} from "@cantrip/crypto";
import {
  chatMessageContentSchema,
  chatMessageSchema,
  encryptedQueuedPromptSchema,
  type ChatAttachmentSummary,
  type ChatMessage,
  type ChatTurnMode,
  type EncryptedChatTurnCreate,
  type EncryptedQueuedPrompt,
  type QueuedPrompt,
  type ReasoningEffort,
} from "@cantrip/protocol";
import {
  chatMessageOpaqueContentSchema,
  chatMessageOpaqueSummarySchema,
  queuedPromptOpaqueContentSchema,
} from "@cantrip/protocol/communication-content";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";
import { openAttachmentOpaqueList } from "./attachment-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

function encryptionContext(options: TrustedOptions) {
  const service = options.service ?? clientEncryption;
  const session = (options.session ?? getClientSession)();
  const snapshot = service.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );
  }
  return {
    identity: { ownerId: session.user.id, serverId: session.serverId },
    keyRevision: snapshot.masterKeyRevision,
    service,
  };
}

function messageContent(text: string, attachments: ChatAttachmentSummary[]) {
  return chatMessageContentSchema.parse([
    ...(text.trim() ? [{ type: "text" as const, text: text.trim() }] : []),
    ...attachments.map((attachment) => ({
      type: "attachment" as const,
      attachment,
    })),
  ]);
}

export async function createEncryptedChatTurn(
  input: {
    attachments: ChatAttachmentSummary[];
    idempotencyKey: string;
    messageId: string;
    mode: ChatTurnMode;
    modelId: string;
    promptId: string;
    reasoningEffort: ReasoningEffort | null;
    text: string;
  },
  options: TrustedOptions = {},
): Promise<EncryptedChatTurnCreate> {
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "chat-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  const attachmentIds = input.attachments.map(({ id }) => id);
  const messageClassification = {
    role: "user" as const,
    mode: input.mode,
    attachmentIds,
  };
  const promptClassification = { mode: input.mode, attachmentIds };
  try {
    const pendingMessage = chatMessageOpaqueContentSchema.parse({
      id: input.messageId,
      classification: messageClassification,
      protectedContent: await encryptChatMessageProtectedContent({
        ownerId: context.identity.ownerId,
        messageId: input.messageId,
        keyRevision: context.keyRevision,
        componentKey,
        content: {
          version: 1,
          classification: messageClassification,
          content: messageContent(input.text, input.attachments),
        },
      }),
      reasoningEffort: input.reasoningEffort,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      message: pendingMessage,
      queuedPrompt: queuedPromptOpaqueContentSchema.parse({
        id: input.promptId,
        classification: promptClassification,
        protectedContent: await encryptQueuedPromptProtectedContent({
          ownerId: context.identity.ownerId,
          promptId: input.promptId,
          keyRevision: context.keyRevision,
          componentKey,
          content: {
            version: 1,
            classification: promptClassification,
            text: input.text,
          },
        }),
        modelId: input.modelId,
        reasoningEffort: input.reasoningEffort,
        worktreeId: null,
        frozen: false,
        idempotencyKey: input.idempotencyKey,
        pendingMessage,
      }),
      modelId: input.modelId,
    };
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function openChatMessageOpaqueSummary(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<ChatMessage> {
  const message = chatMessageOpaqueSummarySchema.parse(raw);
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "chat-content",
    identity: context.identity,
    keyRevision: message.protectedContent.keyRevision,
  });
  try {
    const opened = await decryptChatMessageProtectedContent({
      ownerId: context.identity.ownerId,
      messageId: message.id,
      keyRevision: message.protectedContent.keyRevision,
      componentKey,
      encrypted: message.protectedContent,
      publicClassification: {
        role: message.role,
        mode: message.mode,
        attachmentIds: message.attachmentIds,
      },
    });
    return chatMessageSchema.parse({
      ...message,
      content: chatMessageContentSchema.parse(opened.content),
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function openQueuedPromptOpaqueSummary(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<QueuedPrompt> {
  const prompt = encryptedQueuedPromptSchema.parse(raw);
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "chat-content",
    identity: context.identity,
    keyRevision: prompt.protectedContent.keyRevision,
  });
  try {
    const opened = await decryptQueuedPromptProtectedContent({
      ownerId: context.identity.ownerId,
      promptId: prompt.id,
      keyRevision: prompt.protectedContent.keyRevision,
      componentKey,
      encrypted: prompt.protectedContent,
      publicClassification: prompt.classification,
    });
    return {
      id: prompt.id,
      chatId: prompt.chatId,
      text: opened.text,
      attachments: await openAttachmentOpaqueList(prompt.attachments, options),
      mode: prompt.classification.mode,
      modelId: prompt.modelId,
      reasoningEffort: prompt.reasoningEffort,
      worktreeId: prompt.worktreeId,
      position: prompt.position,
      frozen: prompt.frozen,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    };
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function replaceEncryptedQueuedPrompt(
  current: EncryptedQueuedPrompt,
  input: {
    attachments: ChatAttachmentSummary[];
    frozen: boolean;
    mode: ChatTurnMode;
    reasoningEffort: ReasoningEffort | null;
    text: string;
  },
  options: TrustedOptions = {},
) {
  const replacement = await createEncryptedChatTurn(
    {
      attachments: input.attachments,
      idempotencyKey: current.idempotencyKey,
      messageId: current.pendingMessage.id,
      mode: input.mode,
      modelId: current.modelId,
      promptId: current.id,
      reasoningEffort: input.reasoningEffort,
      text: input.text,
    },
    options,
  );
  return queuedPromptOpaqueContentSchema.parse({
    ...replacement.queuedPrompt,
    frozen: input.frozen,
    worktreeId: current.worktreeId,
  });
}
