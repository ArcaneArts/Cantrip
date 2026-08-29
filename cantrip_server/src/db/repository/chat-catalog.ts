import { randomUUID } from "node:crypto";

import type {
  ArchivedChatWireSummary,
  ArchivedStandaloneChatWireSummary,
  ChatExperience,
  ChatWireSummary,
  EncryptedChatCreate,
  EncryptedStandaloneChatCreate,
  EncryptedTaskCreate,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  StandaloneChatRootJobSummary,
  StandaloneChatWireSummary,
  TaskOpaqueSummary,
  TaskWireCreateResult,
  WorkerSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import { taskOpaqueColumns, toTaskOpaqueSummary } from "../tasks.js";
import { attachProjectTab } from "../tab-layouts.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";
import {
  toArchivedChatWireSummary,
  toArchivedStandaloneChatWireSummary,
  toChatWireSummary,
  toStandaloneChatWireSummary,
} from "./chat-mappers.js";
import type { ProjectWorktreeExecutionContext } from "./projects.js";

export class StandaloneChatPlacementUnavailableError extends Error {}

export interface ChatCatalogRepositoryCollaborators {
  getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null>;
  listWorkers(ownerId: string): Promise<WorkerSummary[]>;
  nextProjectTabPosition(projectId: string): Promise<number>;
  resolveProjectExecutionPlacement(
    ownerId: string,
    projectId: string,
    surfaceKind: ExecutionSurfaceKind,
    target?: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowOfflineExplicit?: boolean,
  ): Promise<ExecutionPlacementResolution>;
}

export class ChatCatalogRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ChatCatalogRepositoryCollaborators,
  ) {}

  async listChats(
    ownerId: string,
    projectId: string,
  ): Promise<ChatWireSummary[]> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.chats.projectId, projectId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .orderBy(asc(schema.chats.position), asc(schema.chats.createdAt));
    return rows.map(({ chat }) => toChatWireSummary(chat));
  }

  async listArchivedChats(
    ownerId: string,
    projectId: string,
  ): Promise<ArchivedChatWireSummary[]> {
    const rows = await this.database
      .select({
        chat: schema.chats,
        messageCount: sql<number>`(
          select count(*)::int
          from ${schema.chatMessages}
          where ${schema.chatMessages.chatId} = ${schema.chats.id}
        )`,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.chats.projectId, projectId),
          isNotNull(schema.chats.archivedAt),
        ),
      )
      .orderBy(desc(schema.chats.archivedAt));
    return rows.map(({ chat, messageCount }) =>
      toArchivedChatWireSummary(chat, messageCount),
    );
  }

  async listStandaloneChats(
    ownerId: string,
  ): Promise<StandaloneChatWireSummary[]> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .orderBy(asc(schema.chats.position), asc(schema.chats.createdAt));
    return rows.map(({ chat }) => toStandaloneChatWireSummary(chat));
  }

  async listArchivedStandaloneChats(
    ownerId: string,
  ): Promise<ArchivedStandaloneChatWireSummary[]> {
    const rows = await this.database
      .select({
        chat: schema.chats,
        messageCount: sql<number>`(
          select count(*)::int
          from ${schema.chatMessages}
          where ${schema.chatMessages.chatId} = ${schema.chats.id}
        )`,
      })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNotNull(schema.chats.archivedAt),
        ),
      )
      .orderBy(desc(schema.chats.archivedAt));
    return rows.map(({ chat, messageCount }) =>
      toArchivedStandaloneChatWireSummary(chat, messageCount),
    );
  }

  async createStandaloneChat(
    ownerId: string,
    input: EncryptedStandaloneChatCreate,
    isWorkerConnected: (workerId: string) => boolean,
  ): Promise<{
    chat: StandaloneChatWireSummary;
    provisionJob: StandaloneChatRootJobSummary;
  }> {
    const settings = firstOrThrow(
      await this.database
        .select()
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, ownerId))
        .limit(1),
      "loading standalone Chat defaults",
    );
    const workers = await this.collaborators.listWorkers(ownerId);
    const compatible = workers
      .filter(
        (worker) =>
          isWorkerConnected(worker.workerId) &&
          worker.standaloneChat.scratch.provision &&
          worker.standaloneChat.scratch.resolve &&
          worker.standaloneChat.scratch.archive &&
          worker.standaloneChat.scratch.restore &&
          worker.standaloneChat.scratch.remove &&
          worker.standaloneChat.scratch.reconcile &&
          worker.standaloneChat.scratch.routingHandles,
      )
      .sort((left, right) => left.workerId.localeCompare(right.workerId));
    const worker =
      compatible.find(
        (candidate) => candidate.workerId === settings.defaultWorkerId,
      ) ?? compatible[0];
    if (!worker) {
      throw new StandaloneChatPlacementUnavailableError(
        "New Chat requires a compatible online worker with standalone scratch support.",
      );
    }
    const inheritedModelId =
      settings.defaultChatModelId ?? settings.defaultModelId;
    const inheritedReasoningEffort =
      settings.defaultChatReasoningEffort ?? settings.defaultReasoningEffort;
    const last = await this.database
      .select({ position: schema.chats.position })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
        ),
      )
      .orderBy(desc(schema.chats.position))
      .limit(1);
    const rootId = randomUUID();
    const runtimeSessionId = randomUUID();
    const provisionJobId = randomUUID();
    return this.database.transaction(async (transaction) => {
      const chat = firstOrThrow(
        await transaction
          .insert(schema.chats)
          .values({
            id: input.id,
            ownerId,
            contextKind: "standalone",
            projectId: null,
            protectedLabel: input.titleProtection,
            experience: "agent",
            position: (last[0]?.position ?? -1) + 1,
            activeWorkerId: worker.workerId,
            activeWorktreeId: null,
            activeScratchRootId: rootId,
            worktreeMode: null,
            modelId: inheritedModelId,
            reasoningEffort: inheritedReasoningEffort,
            customSubagentModel: false,
            subagentModelId: null,
            subagentReasoningEffort: null,
            permissionProfileId: settings.defaultChatPermissionProfileId,
            automationPaused: false,
            planMode: "default",
            protectedPlan: null,
            hasPendingPlanQuestion: false,
          })
          .returning(),
        "creating a standalone Chat",
      );
      await transaction.insert(schema.standaloneChatRoots).values({
        id: rootId,
        chatId: chat.id,
        ownerId,
        workerId: worker.workerId,
        protectedPathHandle: null,
        status: "provisioning",
      });
      await transaction.insert(schema.chatRuntimeSessions).values({
        id: runtimeSessionId,
        chatId: chat.id,
        workerId: worker.workerId,
        worktreeId: null,
        scratchRootId: rootId,
      });
      await transaction.insert(schema.chatExecutionLanes).values({
        id: randomUUID(),
        chatId: chat.id,
        worktreeId: null,
        scratchRootId: rootId,
        workerId: worker.workerId,
        acquiringActor: "user",
        exclusive: false,
        purpose: "Initial standalone Chat scratch root",
        state: "suspended",
        runtimeSessionId,
      });
      const provisionJob = firstOrThrow(
        await transaction
          .insert(schema.standaloneChatRootJobs)
          .values({
            id: provisionJobId,
            ownerId,
            rootId,
            chatId: chat.id,
            workerId: worker.workerId,
            kind: "provision",
            state: "queued",
          })
          .returning(),
        "queueing standalone Chat scratch provisioning",
      );
      return {
        chat: toStandaloneChatWireSummary(chat),
        provisionJob: {
          id: provisionJob.id,
          rootId: provisionJob.rootId,
          chatId: provisionJob.chatId,
          workerId: provisionJob.workerId,
          kind: provisionJob.kind,
          state: provisionJob.state,
          stateRevision: provisionJob.stateRevision,
          attempt: provisionJob.attempt,
          error: null,
          createdAt: toISOString(provisionJob.createdAt),
          updatedAt: toISOString(provisionJob.updatedAt),
          startedAt: null,
          completedAt: null,
        },
      };
    });
  }

  async createChat(
    ownerId: string,
    projectId: string,
    input: EncryptedChatCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ChatWireSummary | null> {
    const created = await this.createChatExperience(
      ownerId,
      projectId,
      input,
      "agent",
      isWorkerConnected,
    );
    return created?.chat ?? null;
  }

  async createTask(
    ownerId: string,
    projectId: string,
    input: EncryptedTaskCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<TaskWireCreateResult | null> {
    const created = await this.createChatExperience(
      ownerId,
      projectId,
      input,
      "task",
      isWorkerConnected,
    );
    if (!created) return null;
    if (!created.task) {
      throw new Error("Task-backed Chat creation omitted its Task record.");
    }
    return { chat: created.chat, task: created.task };
  }

  private async createChatExperience(
    ownerId: string,
    projectId: string,
    input: EncryptedChatCreate | EncryptedTaskCreate,
    experience: ChatExperience,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<{ chat: ChatWireSummary; task: TaskOpaqueSummary | null } | null> {
    const target =
      input.target ??
      (input.worktreeId
        ? ({
            kind: "worktree",
            projectId,
            worktreeId: input.worktreeId,
          } as const)
        : undefined);
    const { placement } =
      await this.collaborators.resolveProjectExecutionPlacement(
        ownerId,
        projectId,
        "chat",
        target,
        isWorkerConnected,
      );
    const selected = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      projectId,
      placement.worktreeId!,
    );
    if (!selected) return null;
    const worktreeId = selected.worktree.id;
    const workerId = selected.workerId;
    const isPrimary = selected.worktree.isPrimary;
    const startingHead = selected.worktree.head;
    const defaultSettings = firstOrThrow(
      await this.database
        .select({
          modelId: schema.userSettings.defaultModelId,
          reasoningEffort: schema.userSettings.defaultReasoningEffort,
          customSubagentModel: schema.userSettings.defaultCustomSubagentModel,
          subagentModelId: schema.userSettings.defaultSubagentModelId,
          subagentReasoningEffort:
            schema.userSettings.defaultSubagentReasoningEffort,
        })
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, ownerId))
        .limit(1),
      "loading default chat model configuration",
    );

    const position = await this.collaborators.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const chatId =
        experience === "task"
          ? (input as EncryptedTaskCreate).chatId
          : (input as EncryptedChatCreate).id;
      const result = await transaction
        .insert(schema.chats)
        .values({
          id: chatId,
          ownerId,
          contextKind: "project",
          projectId,
          protectedLabel: input.titleProtection,
          experience,
          position,
          activeWorkerId: workerId,
          activeWorktreeId: worktreeId,
          worktreeMode: input.worktreeMode,
          modelId: defaultSettings.modelId,
          reasoningEffort: defaultSettings.reasoningEffort,
          customSubagentModel: defaultSettings.customSubagentModel,
          subagentModelId: defaultSettings.subagentModelId,
          subagentReasoningEffort: defaultSettings.subagentReasoningEffort,
        })
        .returning();
      const chat = firstOrThrow(result, "creating a chat");
      const runtimeSessionId = randomUUID();
      await transaction.insert(schema.chatRuntimeSessions).values({
        id: runtimeSessionId,
        chatId: chat.id,
        workerId,
        worktreeId,
      });
      await transaction.insert(schema.chatExecutionLanes).values({
        id: randomUUID(),
        chatId: chat.id,
        worktreeId,
        workerId,
        acquiringActor: "user",
        exclusive: !isPrimary,
        purpose: "Initial chat worktree",
        state: "suspended",
        startingHead,
        runtimeSessionId,
      });
      if (experience !== "task") {
        await attachProjectTab(transaction, {
          projectId,
          tabGroupId: input.tabGroupId,
          tabId: chat.id,
          tabKind: "chat",
        });
      }
      const task =
        experience === "task"
          ? firstOrThrow(
              await transaction
                .insert(schema.tasks)
                .values({
                  chatId: chat.id,
                  planGoalEnabled: (input as EncryptedTaskCreate)
                    .planGoalEnabled,
                  priority: (input as EncryptedTaskCreate).priority,
                  requestedTaskWorkerId: (input as EncryptedTaskCreate)
                    .requestedTaskWorkerId,
                  ...taskOpaqueColumns((input as EncryptedTaskCreate).task),
                })
                .returning(),
              "creating a Task record",
            )
          : null;
      return {
        chat: toChatWireSummary(chat),
        task: task ? toTaskOpaqueSummary(task) : null,
      };
    });
  }
}
