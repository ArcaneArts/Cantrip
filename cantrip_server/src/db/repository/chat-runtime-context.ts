import { randomUUID } from "node:crypto";

import {
  DEFAULT_PERMISSION_PROFILE_ID,
  type ChatWireSummary,
  type ContextualChatWireSummary,
  type PlanMode,
  type StandaloneChatRootStatus,
  type UserSettings,
  type WorktreePolicy,
} from "@cantrip/protocol";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  requiredProjectChatProjectId,
  type ChatExecutionContext,
  type StandaloneChatExecutionContext,
} from "./chat-execution-lanes.js";
import {
  chatModelConfiguration,
  toContextualChatWireSummary,
} from "./chat-mappers.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";

export interface ChatRuntimeContextRepositoryCollaborators {
  getChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionContext | null>;
}

export class ChatRuntimeContextRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ChatRuntimeContextRepositoryCollaborators,
  ) {}

  async getChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionContext | null> {
    const identities = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (identities[0]?.contextKind === "standalone") {
      return this.getStandaloneChatExecutionContext(ownerId, chatId);
    }
    const rows = await this.database
      .select({
        chat: schema.chats,
        lane: schema.chatExecutionLanes,
        project: schema.projects,
        settings: schema.userSettings,
        worktree: schema.projectWorktrees,
        runtime: schema.chatRuntimeSessions,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.userSettings,
        eq(schema.userSettings.userId, schema.projects.ownerId),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
      )
      .leftJoin(
        schema.chatRuntimeSessions,
        and(
          eq(schema.chatRuntimeSessions.chatId, schema.chats.id),
          eq(
            schema.chatRuntimeSessions.workerId,
            schema.projectWorktrees.workerId,
          ),
          eq(schema.chatRuntimeSessions.worktreeId, schema.projectWorktrees.id),
        ),
      )
      .leftJoin(
        schema.chatExecutionLanes,
        and(
          eq(schema.chatExecutionLanes.chatId, schema.chats.id),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    const projectId = requiredProjectChatProjectId(row.chat.projectId);
    return {
      contextKind: "project",
      automationPaused: row.chat.automationPaused,
      chatId: row.chat.id,
      computerUseAuthorityGeneration: row.chat.computerUseAuthorityGeneration,
      cwd: row.worktree.absolutePath,
      experience: row.chat.experience as ChatWireSummary["experience"],
      defaultPermissionProfileId:
        (row.settings?.defaultPermissionProfileId as
          UserSettings["defaultPermissionProfileId"] | undefined) ??
        DEFAULT_PERMISSION_PROFILE_ID,
      executionLaneId: row.lane?.id ?? null,
      isPrimary: row.worktree.isPrimary,
      modelId: row.chat.modelId,
      reasoningEffort: row.chat.reasoningEffort,
      modelConfiguration: chatModelConfiguration(row.chat),
      modelRouteId: row.runtime?.modelRouteId ?? null,
      providerAccountId: row.runtime?.providerAccountId ?? null,
      permissionProfileId: row.chat.permissionProfileId,
      planMode: row.chat.planMode as PlanMode,
      projectId,
      rootKind: row.worktree.rootKind,
      scratchRootId: null,
      status: row.chat.status as ChatWireSummary["status"],
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.worktree.workerId,
      worktreeId: row.worktree.id,
      worktreeMode: row.chat.worktreeMode as ChatWireSummary["worktreeMode"],
      worktreePolicy: row.project.worktreePolicy as WorktreePolicy,
    };
  }

  private async getStandaloneChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<StandaloneChatExecutionContext | null> {
    const rows = await this.database
      .select({
        chat: schema.chats,
        lane: schema.chatExecutionLanes,
        root: schema.standaloneChatRoots,
        runtime: schema.chatRuntimeSessions,
        settings: schema.userSettings,
      })
      .from(schema.chats)
      .innerJoin(
        schema.standaloneChatRoots,
        and(
          eq(schema.standaloneChatRoots.id, schema.chats.activeScratchRootId),
          eq(schema.standaloneChatRoots.chatId, schema.chats.id),
          eq(schema.standaloneChatRoots.ownerId, schema.chats.ownerId),
          eq(schema.standaloneChatRoots.workerId, schema.chats.activeWorkerId),
        ),
      )
      .leftJoin(
        schema.chatRuntimeSessions,
        and(
          eq(schema.chatRuntimeSessions.chatId, schema.chats.id),
          eq(
            schema.chatRuntimeSessions.workerId,
            schema.standaloneChatRoots.workerId,
          ),
          eq(
            schema.chatRuntimeSessions.scratchRootId,
            schema.standaloneChatRoots.id,
          ),
        ),
      )
      .leftJoin(
        schema.chatExecutionLanes,
        and(
          eq(schema.chatExecutionLanes.chatId, schema.chats.id),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .leftJoin(
        schema.userSettings,
        eq(schema.userSettings.userId, schema.chats.ownerId),
      )
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      contextKind: "standalone",
      automationPaused: row.chat.automationPaused,
      chatId,
      computerUseAuthorityGeneration: row.chat.computerUseAuthorityGeneration,
      cwd: row.root.protectedPathHandle ?? "standalone-root-unavailable",
      experience: "agent",
      defaultPermissionProfileId:
        (row.settings?.defaultChatPermissionProfileId as
          UserSettings["defaultChatPermissionProfileId"] | undefined) ??
        DEFAULT_PERMISSION_PROFILE_ID,
      executionLaneId: row.lane?.id ?? null,
      isPrimary: true,
      status:
        row.root.status === "ready"
          ? (row.chat.status as ChatWireSummary["status"])
          : row.root.status === "failed"
            ? "failed"
            : "offline",
      modelId: row.chat.modelId,
      reasoningEffort: row.chat.reasoningEffort,
      modelConfiguration: chatModelConfiguration(row.chat),
      modelRouteId: row.runtime?.modelRouteId ?? null,
      providerAccountId: row.runtime?.providerAccountId ?? null,
      permissionProfileId: row.chat.permissionProfileId,
      planMode: "default",
      projectId: null,
      rootKind: null,
      scratchRootStatus: row.root.status as StandaloneChatRootStatus,
      scratchRootId: row.root.id,
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.root.workerId,
      worktreeId: null,
      worktreeMode: null,
      worktreePolicy: null,
    };
  }

  async listChatExecutionContextsByThreadId(
    ownerId: string,
    workerId: string,
    threadId: string,
  ): Promise<ChatExecutionContext[]> {
    const rows = await this.database
      .select({ chatId: schema.chatRuntimeSessions.chatId })
      .from(schema.chatRuntimeSessions)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatRuntimeSessions.chatId),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatRuntimeSessions.workerId, workerId),
          eq(schema.chatRuntimeSessions.codexThreadId, threadId),
          isNull(schema.chats.archivedAt),
        ),
      );
    const contexts = await Promise.all(
      [...new Set(rows.map(({ chatId }) => chatId))].map((chatId) =>
        this.collaborators.getChatExecutionContext(ownerId, chatId),
      ),
    );
    return contexts.filter(
      (context): context is ChatExecutionContext =>
        context !== null &&
        context.workerId === workerId &&
        context.threadId === threadId,
    );
  }

  async updateChatRuntime(
    chatId: string,
    workerId: string,
    worktreeId: string | null,
    threadId: string | null,
    modelRouteId: string,
    status = "ready",
    providerAccountId?: string | null,
    scratchRootId: string | null = null,
  ): Promise<void> {
    if ((worktreeId === null) === (scratchRootId === null)) {
      throw new Error("Chat runtime requires exactly one execution root.");
    }
    const rows = await this.database
      .insert(schema.chatRuntimeSessions)
      .values({
        id: randomUUID(),
        chatId,
        workerId,
        worktreeId,
        scratchRootId,
        codexThreadId: threadId,
        modelRouteId,
        providerAccountId: providerAccountId ?? null,
        status,
      })
      .onConflictDoUpdate({
        target: worktreeId
          ? [
              schema.chatRuntimeSessions.chatId,
              schema.chatRuntimeSessions.workerId,
              schema.chatRuntimeSessions.worktreeId,
            ]
          : [
              schema.chatRuntimeSessions.chatId,
              schema.chatRuntimeSessions.workerId,
              schema.chatRuntimeSessions.scratchRootId,
            ],
        targetWhere: worktreeId
          ? isNotNull(schema.chatRuntimeSessions.worktreeId)
          : isNotNull(schema.chatRuntimeSessions.scratchRootId),
        set: {
          codexThreadId: threadId,
          modelRouteId,
          ...(providerAccountId === undefined ? {} : { providerAccountId }),
          status,
          updatedAt: new Date(),
        },
      })
      .returning();
    const runtime = firstOrThrow(rows, "updating a chat runtime");
    await this.database
      .update(schema.chatExecutionLanes)
      .set({
        runtimeSessionId: runtime.id,
        codexThreadId: threadId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.chatExecutionLanes.chatId, chatId),
          eq(schema.chatExecutionLanes.workerId, workerId),
          worktreeId
            ? eq(schema.chatExecutionLanes.worktreeId, worktreeId)
            : eq(schema.chatExecutionLanes.scratchRootId, scratchRootId!),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      );
  }

  async setChatStatus(
    chatId: string,
    status: ChatWireSummary["status"],
  ): Promise<void> {
    await this.database
      .update(schema.chats)
      .set({
        status,
        ...(status === "idle" || status === "failed"
          ? {
              hasUnreadCompletion: sql<boolean>`case
                  when ${schema.chats.status} in ('running', 'waiting-for-approval')
                    then true
                  else ${schema.chats.hasUnreadCompletion}
                end`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId));
  }

  async acknowledgeChatCompletion(
    ownerId: string,
    chatId: string,
  ): Promise<ContextualChatWireSummary | null> {
    const rows = await this.database
      .update(schema.chats)
      .set({ hasUnreadCompletion: false })
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .returning();
    return rows[0] ? toContextualChatWireSummary(rows[0]) : null;
  }
}
