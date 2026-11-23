import {
  chatMessageOpaqueSummarySchema,
  taskMessageOpaqueSummarySchema,
} from "@cantrip/protocol";
import type {
  ChatMessage,
  ChatMessageOpaqueSummary,
  TaskMessageOpaqueSummary,
} from "@cantrip/protocol";

import * as schema from "../schema.js";
import { toISOString } from "./database.js";

export function toChatMessage(
  message: typeof schema.chatMessages.$inferSelect,
): ChatMessage {
  if (!message.content || message.taskProtectedContent) {
    throw new Error("Encrypted Task messages require the opaque mapper.");
  }
  return {
    id: message.id,
    chatId: message.chatId,
    contextKind: message.scratchRootId ? "standalone" : "project",
    worktreeId: message.worktreeId,
    scratchRootId: message.scratchRootId,
    executionLaneId: message.executionLaneId,
    sequence: message.sequence,
    role: message.role as ChatMessage["role"],
    mode: message.mode,
    content: message.content,
    modelId: message.modelId,
    modelRouteId: message.modelRouteId,
    providerId: message.providerId,
    providerName: message.providerName,
    providerModelName: message.providerModelName,
    reasoningEffort: message.reasoningEffort,
    appliedReasoningEffort: message.appliedReasoningEffort,
    reasoningAdjusted: message.reasoningAdjusted,
    createdAt: toISOString(message.createdAt),
  };
}

export function toEncryptedChatMessage(
  message: typeof schema.chatMessages.$inferSelect,
): ChatMessageOpaqueSummary {
  if (
    !message.protectedContent ||
    message.content ||
    message.taskProtectedContent
  ) {
    throw new Error("Visible or Task messages require a different mapper.");
  }
  return chatMessageOpaqueSummarySchema.parse({
    id: message.id,
    chatId: message.chatId,
    contextKind: message.scratchRootId ? "standalone" : "project",
    worktreeId: message.worktreeId,
    scratchRootId: message.scratchRootId,
    executionLaneId: message.executionLaneId,
    sequence: message.sequence,
    role: message.role,
    mode: message.mode,
    attachmentIds: message.attachmentIds,
    protectedContent: message.protectedContent,
    modelId: message.modelId,
    modelRouteId: message.modelRouteId,
    providerId: message.providerId,
    providerName: message.providerName,
    providerModelName: message.providerModelName,
    reasoningEffort: message.reasoningEffort,
    appliedReasoningEffort: message.appliedReasoningEffort,
    reasoningAdjusted: message.reasoningAdjusted,
    idempotencyKey: message.idempotencyKey,
    createdAt: toISOString(message.createdAt),
  });
}

export function toTaskMessage(
  message: typeof schema.chatMessages.$inferSelect,
): TaskMessageOpaqueSummary {
  if (!message.taskProtectedContent || message.content) {
    throw new Error("Visible chat messages require the plaintext mapper.");
  }
  if (!message.worktreeId || message.scratchRootId) {
    throw new Error("Task messages require a project worktree.");
  }
  return taskMessageOpaqueSummarySchema.parse({
    id: message.id,
    chatId: message.chatId,
    worktreeId: message.worktreeId,
    executionLaneId: message.executionLaneId,
    sequence: message.sequence,
    role: message.role,
    mode: message.mode,
    attachmentIds: message.taskAttachmentIds,
    protectedContent: message.taskProtectedContent,
    modelId: message.modelId,
    modelRouteId: message.modelRouteId,
    providerId: message.providerId,
    providerName: message.providerName,
    providerModelName: message.providerModelName,
    reasoningEffort: message.reasoningEffort,
    appliedReasoningEffort: message.appliedReasoningEffort,
    reasoningAdjusted: message.reasoningAdjusted,
    idempotencyKey: message.idempotencyKey,
    createdAt: toISOString(message.createdAt),
  });
}
