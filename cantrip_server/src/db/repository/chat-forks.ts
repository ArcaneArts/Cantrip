import { randomUUID } from "node:crypto";

import type {
  ChatMessageOpaqueContent,
  ChatMessageOpaqueSummary,
  ChatWireSummary,
  EncryptedChatFork,
  EncryptedStandaloneChatCreate,
  StandaloneChatRootJobSummary,
  StandaloneChatWireSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import { attachProjectTab } from "../tab-layouts.js";
import {
  ExecutionLaneConflictError,
  requiredProjectChatProjectId,
  requiredProjectChatWorktreeId,
} from "./chat-execution-lanes.js";
import {
  toChatWireSummary,
  toStandaloneChatWireSummary,
} from "./chat-mappers.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";
import { toEncryptedChatMessage } from "./message-mappers.js";

export interface ChatForkRepositoryCollaborators {
  createStandaloneChat(
    ownerId: string,
    input: EncryptedStandaloneChatCreate,
    isWorkerConnected: (workerId: string) => boolean,
  ): Promise<{
    chat: StandaloneChatWireSummary;
    provisionJob: StandaloneChatRootJobSummary;
  }>;
}

export class ChatForkRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ChatForkRepositoryCollaborators,
  ) {}

  async forkChat(
    ownerId: string,
    chatId: string,
    input: EncryptedChatFork,
    protectMessages: (
      messages: ChatMessageOpaqueSummary[],
    ) => Promise<ChatMessageOpaqueContent[]>,
  ): Promise<ChatWireSummary | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ chat: schema.chats })
        .from(schema.chats)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(eq(schema.chats.id, chatId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const projectId = requiredProjectChatProjectId(row.chat.projectId);
      const activeWorktreeId = requiredProjectChatWorktreeId(
        row.chat.activeWorktreeId,
      );

      const targetRows = await transaction
        .select({ worktree: schema.projectWorktrees })
        .from(schema.projectWorktrees)
        .innerJoin(
          schema.projectSources,
          and(
            eq(
              schema.projectSources.id,
              schema.projectWorktrees.projectSourceId,
            ),
            eq(schema.projectSources.projectId, projectId),
          ),
        )
        .where(
          and(
            eq(
              schema.projectWorktrees.id,
              input.worktreeId ?? activeWorktreeId,
            ),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .limit(1);
      const target = targetRows[0]?.worktree;
      if (!target || target.lifecycleState !== "ready") return null;

      let throughSequence: number | null = null;
      if (input.messageId) {
        const selected = await transaction
          .select({ sequence: schema.chatMessages.sequence })
          .from(schema.chatMessages)
          .where(
            and(
              eq(schema.chatMessages.id, input.messageId),
              eq(schema.chatMessages.chatId, chatId),
            ),
          )
          .limit(1);
        if (!selected[0]) return null;
        throughSequence = selected[0].sequence;
      }
      const sourceMessages = await transaction
        .select()
        .from(schema.chatMessages)
        .where(
          throughSequence === null
            ? eq(schema.chatMessages.chatId, chatId)
            : and(
                eq(schema.chatMessages.chatId, chatId),
                lte(schema.chatMessages.sequence, throughSequence),
              ),
        )
        .orderBy(asc(schema.chatMessages.sequence));
      if (
        sourceMessages.some(
          (source) =>
            !source.protectedContent ||
            source.content !== null ||
            source.taskProtectedContent !== null,
        )
      ) {
        return null;
      }
      const protectedCopies = await protectMessages(
        sourceMessages.map(toEncryptedChatMessage),
      );
      if (
        protectedCopies.length !== sourceMessages.length ||
        protectedCopies.some((copy, index) => {
          const source = sourceMessages[index]!;
          return (
            copy.classification.role !== source.role ||
            copy.classification.mode !== source.mode ||
            JSON.stringify(copy.classification.attachmentIds) !==
              JSON.stringify(source.attachmentIds)
          );
        })
      ) {
        throw new Error(
          "The worker returned inconsistent encrypted fork messages.",
        );
      }
      const [
        lastChats,
        lastTerminals,
        lastExplorers,
        lastCodeTabs,
        lastBrowsers,
        lastViews,
      ] = await Promise.all([
        transaction
          .select({ position: schema.chats.position })
          .from(schema.chats)
          .where(eq(schema.chats.projectId, projectId))
          .orderBy(desc(schema.chats.position))
          .limit(1),
        transaction
          .select({ position: schema.terminals.position })
          .from(schema.terminals)
          .where(eq(schema.terminals.projectId, projectId))
          .orderBy(desc(schema.terminals.position))
          .limit(1),
        transaction
          .select({ position: schema.explorers.position })
          .from(schema.explorers)
          .where(eq(schema.explorers.projectId, projectId))
          .orderBy(desc(schema.explorers.position))
          .limit(1),
        transaction
          .select({ position: schema.codeTabs.position })
          .from(schema.codeTabs)
          .where(eq(schema.codeTabs.projectId, projectId))
          .orderBy(desc(schema.codeTabs.position))
          .limit(1),
        transaction
          .select({ position: schema.browsers.position })
          .from(schema.browsers)
          .where(eq(schema.browsers.projectId, projectId))
          .orderBy(desc(schema.browsers.position))
          .limit(1),
        transaction
          .select({ position: schema.projectViews.position })
          .from(schema.projectViews)
          .where(eq(schema.projectViews.projectId, projectId))
          .orderBy(desc(schema.projectViews.position))
          .limit(1),
      ]);
      const chatResult = await transaction
        .insert(schema.chats)
        .values({
          id: input.id,
          ownerId,
          contextKind: "project",
          projectId,
          protectedLabel: input.titleProtection,
          position:
            Math.max(
              lastChats[0]?.position ?? -1,
              lastTerminals[0]?.position ?? -1,
              lastExplorers[0]?.position ?? -1,
              lastCodeTabs[0]?.position ?? -1,
              lastBrowsers[0]?.position ?? -1,
              lastViews[0]?.position ?? -1,
            ) + 1,
          activeWorkerId: target.workerId,
          activeWorktreeId: target.id,
          worktreeMode: input.worktreeMode ?? row.chat.worktreeMode,
          modelId: row.chat.modelId,
          reasoningEffort: row.chat.reasoningEffort,
          customSubagentModel: row.chat.customSubagentModel,
          subagentModelId: row.chat.subagentModelId,
          subagentReasoningEffort: row.chat.subagentReasoningEffort,
          permissionProfileId: row.chat.permissionProfileId,
        })
        .returning();
      const fork = firstOrThrow(chatResult, "forking a chat");
      const runtimeSessionId = randomUUID();
      await transaction.insert(schema.chatRuntimeSessions).values({
        id: runtimeSessionId,
        chatId: fork.id,
        workerId: target.workerId,
        worktreeId: target.id,
      });
      await transaction.insert(schema.chatExecutionLanes).values({
        id: randomUUID(),
        chatId: fork.id,
        worktreeId: target.id,
        workerId: target.workerId,
        acquiringActor: "user",
        exclusive: !target.isPrimary,
        purpose: `Forked from ${row.chat.id}`,
        state: "suspended",
        startingHead: target.head,
        runtimeSessionId,
      });
      await attachProjectTab(transaction, {
        projectId,
        tabId: fork.id,
        tabKind: "chat",
      });
      if (sourceMessages.length > 0) {
        await transaction.insert(schema.chatMessages).values(
          sourceMessages.map((source, index) => {
            const message = protectedCopies[index]!;
            return {
              id: message.id,
              chatId: fork.id,
              worktreeId: target.id,
              executionLaneId: null,
              role: message.classification.role,
              mode: message.classification.mode,
              content: null,
              protectedContent: message.protectedContent,
              attachmentIds: message.classification.attachmentIds,
              modelId: source.modelId,
              modelRouteId: source.modelRouteId,
              providerId: source.providerId,
              providerName: source.providerName,
              providerModelName: source.providerModelName,
              reasoningEffort: message.reasoningEffort,
              appliedReasoningEffort: source.appliedReasoningEffort,
              reasoningAdjusted: source.reasoningAdjusted,
              idempotencyKey: message.idempotencyKey,
              createdAt: source.createdAt,
            };
          }),
        );
      }
      const forkBoundary = sourceMessages.at(-1)?.createdAt ?? new Date();
      const behaviorRows = await transaction
        .select({ id: schema.modelBehaviorObservations.id })
        .from(schema.modelBehaviorObservations)
        .where(
          and(
            eq(schema.modelBehaviorObservations.ownerId, ownerId),
            eq(schema.modelBehaviorObservations.chatId, chatId),
            lte(schema.modelBehaviorObservations.startedAt, forkBoundary),
          ),
        )
        .orderBy(desc(schema.modelBehaviorObservations.startedAt))
        .limit(1);
      if (behaviorRows[0]) {
        await transaction
          .update(schema.modelBehaviorObservations)
          .set({
            forkCount: sql`${schema.modelBehaviorObservations.forkCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(schema.modelBehaviorObservations.id, behaviorRows[0].id));
      }
      return toChatWireSummary(fork);
    });
  }

  async forkStandaloneChat(
    ownerId: string,
    chatId: string,
    input: EncryptedChatFork,
    isWorkerConnected: (workerId: string) => boolean,
    protectMessages: (
      messages: ChatMessageOpaqueSummary[],
    ) => Promise<ChatMessageOpaqueContent[]>,
  ): Promise<null | {
    chat: StandaloneChatWireSummary;
    provisionJob: StandaloneChatRootJobSummary;
  }> {
    if (input.worktreeId || input.worktreeMode) {
      throw new ExecutionLaneConflictError(
        "Standalone Chat forks do not accept worktree settings.",
      );
    }
    const sources = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    if (!sources[0]) return null;
    let throughSequence: number | null = null;
    if (input.messageId) {
      const selected = await this.database
        .select({ sequence: schema.chatMessages.sequence })
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.id, input.messageId),
            eq(schema.chatMessages.chatId, chatId),
          ),
        )
        .limit(1);
      if (!selected[0]) return null;
      throughSequence = selected[0].sequence;
    }
    const sourceMessages = await this.database
      .select()
      .from(schema.chatMessages)
      .where(
        throughSequence === null
          ? eq(schema.chatMessages.chatId, chatId)
          : and(
              eq(schema.chatMessages.chatId, chatId),
              lte(schema.chatMessages.sequence, throughSequence),
            ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    if (
      sourceMessages.some(
        (source) =>
          !source.protectedContent ||
          source.content !== null ||
          source.taskProtectedContent !== null,
      )
    ) {
      return null;
    }
    const protectedCopies = await protectMessages(
      sourceMessages.map(toEncryptedChatMessage),
    );
    if (protectedCopies.length !== sourceMessages.length) {
      throw new Error("The worker returned an incomplete encrypted fork.");
    }
    const created = await this.collaborators.createStandaloneChat(
      ownerId,
      { id: input.id, titleProtection: input.titleProtection },
      isWorkerConnected,
    );
    try {
      const forkRows = await this.database
        .update(schema.chats)
        .set({
          modelId: sources[0].chat.modelId,
          reasoningEffort: sources[0].chat.reasoningEffort,
          permissionProfileId: sources[0].chat.permissionProfileId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.chats.id, created.chat.id),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .returning();
      const fork = firstOrThrow(forkRows, "copying standalone Chat settings");
      if (sourceMessages.length > 0) {
        await this.database.insert(schema.chatMessages).values(
          sourceMessages.map((source, index) => {
            const message = protectedCopies[index]!;
            if (
              message.classification.role !== source.role ||
              message.classification.mode !== source.mode ||
              JSON.stringify(message.classification.attachmentIds) !==
                JSON.stringify(source.attachmentIds)
            ) {
              throw new Error(
                "The worker returned inconsistent encrypted fork messages.",
              );
            }
            return {
              id: message.id,
              chatId: created.chat.id,
              worktreeId: null,
              scratchRootId: created.chat.activeScratchRootId,
              executionLaneId: null,
              role: message.classification.role,
              mode: message.classification.mode,
              content: null,
              protectedContent: message.protectedContent,
              attachmentIds: message.classification.attachmentIds,
              modelId: source.modelId,
              modelRouteId: source.modelRouteId,
              providerId: source.providerId,
              providerName: source.providerName,
              providerModelName: source.providerModelName,
              reasoningEffort: message.reasoningEffort,
              appliedReasoningEffort: source.appliedReasoningEffort,
              reasoningAdjusted: source.reasoningAdjusted,
              idempotencyKey: message.idempotencyKey,
              createdAt: source.createdAt,
            };
          }),
        );
      }
      return { ...created, chat: toStandaloneChatWireSummary(fork) };
    } catch (error) {
      await this.database
        .delete(schema.chats)
        .where(
          and(
            eq(schema.chats.id, created.chat.id),
            eq(schema.chats.ownerId, ownerId),
          ),
        );
      throw error;
    }
  }
}
