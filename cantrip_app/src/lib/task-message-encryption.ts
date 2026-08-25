import {
  clearSensitiveBytes,
  decryptTaskGoalObjective,
  decryptTaskMessageProtectedContent,
  encryptTaskMessageProtectedContent,
} from "@cantrip/crypto";
import {
  chatMessageContentSchema,
  chatMessageSchema,
  type ChatMessage,
  type ChatMessageCreate,
} from "@cantrip/protocol";
import {
  taskGoalObjectiveOpaqueSnapshotSchema,
  taskGoalSnapshotSchema,
  taskMessageOpaqueContentSchema,
  taskMessageOpaqueSummarySchema,
  type TaskGoalObjectiveOpaqueSnapshot,
  type TaskGoalSnapshot,
  type TaskMessageOpaqueContent,
} from "@cantrip/protocol/tasks";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

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

function attachmentIds(content: ChatMessageCreate["content"]): string[] {
  return content.flatMap((item) =>
    item.type === "attachment" ? [item.attachment.id] : [],
  );
}

export async function createTaskMessageOpaqueContent(
  input: {
    content: ChatMessageCreate["content"];
    idempotencyKey: string;
    messageId: string;
    mode: "default" | "goal" | "plan";
    reasoningEffort?: string | null;
    role: "assistant" | "system" | "user";
  },
  options: TrustedOptions = {},
): Promise<TaskMessageOpaqueContent> {
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "task-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  const content = chatMessageContentSchema.parse(input.content);
  const classification = {
    role: input.role,
    mode: input.mode,
    attachmentIds: attachmentIds(content),
  };
  try {
    return taskMessageOpaqueContentSchema.parse({
      id: input.messageId,
      classification,
      protectedContent: await encryptTaskMessageProtectedContent({
        ownerId: context.identity.ownerId,
        messageId: input.messageId,
        keyRevision: context.keyRevision,
        componentKey,
        content: { version: 1, classification, content },
      }),
      reasoningEffort: input.reasoningEffort ?? null,
      idempotencyKey: input.idempotencyKey,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function openTaskMessageOpaqueSummary(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<ChatMessage> {
  const message = taskMessageOpaqueSummarySchema.parse(raw);
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "task-content",
    identity: context.identity,
    keyRevision: message.protectedContent.keyRevision,
  });
  try {
    const opened = await decryptTaskMessageProtectedContent({
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
      id: message.id,
      chatId: message.chatId,
      contextKind: "project",
      worktreeId: message.worktreeId,
      scratchRootId: null,
      executionLaneId: message.executionLaneId,
      sequence: message.sequence,
      role: message.role,
      mode: message.mode,
      content: chatMessageContentSchema.parse(opened.content),
      modelId: message.modelId,
      modelRouteId: message.modelRouteId,
      providerId: message.providerId,
      providerName: message.providerName,
      providerModelName: message.providerModelName,
      reasoningEffort: message.reasoningEffort,
      appliedReasoningEffort: message.appliedReasoningEffort,
      reasoningAdjusted: message.reasoningAdjusted,
      createdAt: message.createdAt,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function openTaskGoalOpaqueSnapshot(
  raw: TaskGoalObjectiveOpaqueSnapshot,
  options: TrustedOptions = {},
): Promise<TaskGoalSnapshot> {
  const goal = taskGoalObjectiveOpaqueSnapshotSchema.parse(raw);
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "task-content",
    identity: context.identity,
    keyRevision: goal.protectedObjective.keyRevision,
  });
  try {
    const opened = await decryptTaskGoalObjective({
      ownerId: context.identity.ownerId,
      chatId: goal.chatId,
      threadId: goal.threadId,
      keyRevision: goal.protectedObjective.keyRevision,
      componentKey,
      encrypted: goal.protectedObjective,
      publicClassification: {
        chatId: goal.chatId,
        threadId: goal.threadId,
        status: goal.status,
      },
    });
    return taskGoalSnapshotSchema.parse({
      threadId: goal.threadId,
      objective: opened.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}
