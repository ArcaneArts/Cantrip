import {
  archivedChatWireSummarySchema,
  archivedStandaloneChatWireSummarySchema,
  chatWireSummarySchema,
  contextualChatWireSummarySchema,
  modelConfigurationSchema,
  standaloneChatWireSummarySchema,
} from "@cantrip/protocol";
import type {
  ArchivedChatWireSummary,
  ArchivedStandaloneChatWireSummary,
  ChatWireSummary,
  ContextualChatWireSummary,
  ModelConfiguration,
  StandaloneChatWireSummary,
} from "@cantrip/protocol";

import * as schema from "../schema.js";
import { toISOString } from "./database.js";

export const ARCHIVED_CHAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export function toChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
): ChatWireSummary {
  return chatWireSummarySchema.parse({
    id: chat.id,
    contextKind: chat.contextKind,
    projectId: chat.projectId,
    titleProtection: chat.protectedLabel,
    experience: chat.experience as ChatWireSummary["experience"],
    position: chat.position,
    status: chat.status as ChatWireSummary["status"],
    activeWorkerId: chat.activeWorkerId,
    activeWorktreeId: chat.activeWorktreeId,
    activeScratchRootId: chat.activeScratchRootId,
    placementRevision: chat.placementRevision,
    worktreeMode: chat.worktreeMode as ChatWireSummary["worktreeMode"],
    modelId: chat.modelId,
    reasoningEffort: chat.reasoningEffort,
    customSubagentModel: chat.customSubagentModel,
    subagentModelId: chat.subagentModelId,
    subagentReasoningEffort: chat.subagentReasoningEffort,
    permissionProfileId: chat.permissionProfileId,
    planMode: chat.planMode as ChatWireSummary["planMode"],
    hasPendingPlanQuestion: chat.hasPendingPlanQuestion,
    hasUnreadCompletion: chat.hasUnreadCompletion,
    automationPaused: chat.automationPaused,
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  });
}

export function toStandaloneChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
): StandaloneChatWireSummary {
  return standaloneChatWireSummarySchema.parse({
    id: chat.id,
    contextKind: "standalone",
    projectId: null,
    titleProtection: chat.protectedLabel,
    experience: "agent",
    position: chat.position,
    status: chat.status,
    activeWorkerId: chat.activeWorkerId,
    activeWorktreeId: null,
    activeScratchRootId: chat.activeScratchRootId,
    placementRevision: chat.placementRevision,
    worktreeMode: null,
    modelId: chat.modelId,
    reasoningEffort: chat.reasoningEffort,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
    permissionProfileId: chat.permissionProfileId,
    planMode: "default",
    hasPendingPlanQuestion: false,
    hasUnreadCompletion: chat.hasUnreadCompletion,
    automationPaused: chat.automationPaused,
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  });
}

export function toContextualChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
): ContextualChatWireSummary {
  return contextualChatWireSummarySchema.parse(
    chat.contextKind === "standalone"
      ? toStandaloneChatWireSummary(chat)
      : toChatWireSummary(chat),
  );
}

export function chatModelConfiguration(
  chat: Pick<
    typeof schema.chats.$inferSelect,
    | "modelId"
    | "reasoningEffort"
    | "customSubagentModel"
    | "subagentModelId"
    | "subagentReasoningEffort"
  >,
): ModelConfiguration {
  return modelConfigurationSchema.parse({
    modelId: chat.modelId,
    reasoningEffort: chat.reasoningEffort,
    customSubagentModel: chat.customSubagentModel,
    subagentModelId: chat.subagentModelId,
    subagentReasoningEffort: chat.subagentReasoningEffort,
  });
}

export function toArchivedChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
  messageCount: number,
): ArchivedChatWireSummary {
  if (!chat.archivedAt) {
    throw new Error("Cannot summarize an active chat as archived.");
  }
  return archivedChatWireSummarySchema.parse({
    id: chat.id,
    contextKind: chat.contextKind,
    projectId: chat.projectId,
    titleProtection: chat.protectedLabel,
    experience: chat.experience as ArchivedChatWireSummary["experience"],
    messageCount,
    archivedAt: toISOString(chat.archivedAt),
    expiresAt: new Date(
      chat.archivedAt.getTime() + ARCHIVED_CHAT_RETENTION_MS,
    ).toISOString(),
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  });
}

export function toArchivedStandaloneChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
  messageCount: number,
): ArchivedStandaloneChatWireSummary {
  if (!chat.archivedAt) {
    throw new Error("Cannot summarize an active Chat as archived.");
  }
  return archivedStandaloneChatWireSummarySchema.parse({
    id: chat.id,
    contextKind: "standalone",
    projectId: null,
    titleProtection: chat.protectedLabel,
    experience: "agent",
    messageCount,
    archivedAt: toISOString(chat.archivedAt),
    expiresAt: new Date(
      chat.archivedAt.getTime() + ARCHIVED_CHAT_RETENTION_MS,
    ).toISOString(),
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  });
}
