import { randomUUID } from "node:crypto";

import {
  DEFAULT_PERMISSION_PROFILE_ID,
  type ChatExecutionLaneSummary,
  type ChatWireSummary,
  type ContextualChatExecutionLaneSummary,
  type ModelConfiguration,
  type PlanMode,
  type ProjectWorktreeSummary,
  type ReasoningEffort,
  type StandaloneChatRootStatus,
  type StandaloneChatWireSummary,
  type UserSettings,
  type WorktreePolicy,
} from "@cantrip/protocol";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";

import {
  acquireChatLogicalBranchLease,
  LogicalBranchLeaseConflictError,
  releaseChatLogicalBranchLease,
} from "../logical-branch-leases.js";
import * as schema from "../schema.js";
import { projectChatExecutionLock } from "./chat-execution-lock.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";
import {
  chatModelConfiguration,
  toChatWireSummary,
  toStandaloneChatWireSummary,
} from "./chat-mappers.js";
import {
  toProjectWorktreeSummary,
  type ProjectWorktreeExecutionContext,
} from "./projects.js";

interface ChatExecutionContextBase {
  automationPaused: boolean;
  chatId: string;
  /** Filled by getChatExecutionContext; optional for older execution adapters. */
  computerUseAuthorityGeneration?: number;
  cwd: string;
  experience: ChatWireSummary["experience"];
  defaultPermissionProfileId?: UserSettings["defaultPermissionProfileId"];
  executionLaneId: string | null;
  isPrimary: boolean;
  status: ChatWireSummary["status"];
  modelId: string | null;
  reasoningEffort: ReasoningEffort | null;
  modelConfiguration: ModelConfiguration;
  modelRouteId: string | null;
  providerAccountId: string | null;
  permissionProfileId: string | null;
  planMode: PlanMode;
  threadId: string | null;
  workerId: string;
}

export interface ProjectChatExecutionContext extends ChatExecutionContextBase {
  contextKind: "project";
  projectId: string;
  rootKind: ProjectWorktreeSummary["rootKind"];
  scratchRootId: null;
  worktreeId: string;
  worktreeMode: ChatWireSummary["worktreeMode"];
  worktreePolicy: WorktreePolicy;
}

export interface StandaloneChatExecutionContext extends ChatExecutionContextBase {
  contextKind: "standalone";
  projectId: null;
  rootKind: null;
  scratchRootStatus: StandaloneChatRootStatus;
  scratchRootId: string;
  worktreeId: null;
  worktreeMode: null;
  worktreePolicy: null;
}

export type ChatExecutionContext =
  ProjectChatExecutionContext | StandaloneChatExecutionContext;

export type ChatExecutionRecoveryContext =
  | ChatExecutionLaneContext
  | {
      chat: StandaloneChatWireSummary;
      lane: ContextualChatExecutionLaneSummary & {
        contextKind: "standalone";
      };
      root: {
        id: string;
        pathHandle: string;
        workerId: string;
      };
    };

export interface ChatExecutionLaneContext {
  chat: ChatWireSummary;
  lane: ChatExecutionLaneSummary;
  sourcePath: string;
  worktree: ProjectWorktreeSummary;
}

export interface ChatExecutionLaneReleaseResult {
  chat: ChatWireSummary;
  lane: ChatExecutionLaneSummary;
  returnedToPrimary: boolean;
}

export interface ChatWorktreeTransitionResult {
  chat: ChatWireSummary;
  fromWorktreeId: string;
  lane: ChatExecutionLaneSummary;
  transitionKind: "switch" | "release";
  worktree: ProjectWorktreeSummary;
}

export class ExecutionLaneConflictError extends Error {}

export interface ChatExecutionLaneRepositoryCollaborators {
  getChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionContext | null>;
  getChatExecutionLaneContext(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<ChatExecutionLaneContext | null>;
  getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null>;
}

export function chatIsExecuting(status: ChatWireSummary["status"]): boolean {
  return status === "running" || status === "waiting-for-approval";
}

export function requiredProjectChatProjectId(projectId: string | null): string {
  if (!projectId) {
    throw new Error("Project Chat operation received a standalone Chat.");
  }
  return projectId;
}

export function requiredProjectChatWorktreeId(
  worktreeId: string | null,
): string {
  if (!worktreeId) {
    throw new Error("Project Chat operation is missing its worktree.");
  }
  return worktreeId;
}

export function toChatExecutionLaneSummary(
  lane: typeof schema.chatExecutionLanes.$inferSelect,
): ChatExecutionLaneSummary {
  if (!lane.worktreeId) {
    throw new Error(
      "Standalone execution lanes are unavailable until standalone execution is enabled.",
    );
  }
  const common = {
    id: lane.id,
    chatId: lane.chatId,
    workerId: lane.workerId,
    acquiringActor:
      lane.acquiringActor as ChatExecutionLaneSummary["acquiringActor"],
    exclusive: lane.exclusive,
    purpose: lane.purpose,
    state: lane.state as ChatExecutionLaneSummary["state"],
    baseRevision: lane.baseRevision,
    startingHead: lane.startingHead,
    runtimeSessionId: lane.runtimeSessionId,
    codexThreadId: lane.codexThreadId,
    transitionKind:
      lane.transitionKind as ChatExecutionLaneSummary["transitionKind"],
    createdAt: toISOString(lane.createdAt),
    activatedAt: lane.activatedAt ? toISOString(lane.activatedAt) : null,
    releasedAt: lane.releasedAt ? toISOString(lane.releasedAt) : null,
    updatedAt: toISOString(lane.updatedAt),
  };
  return {
    ...common,
    contextKind: "project",
    worktreeId: lane.worktreeId,
    scratchRootId: null,
  };
}

function toContextualChatExecutionLaneSummary(
  lane: typeof schema.chatExecutionLanes.$inferSelect,
): ContextualChatExecutionLaneSummary {
  if (lane.worktreeId) {
    return {
      ...toChatExecutionLaneSummary(lane),
      contextKind: "project",
      scratchRootId: null,
    };
  }
  if (!lane.scratchRootId) {
    throw new Error("Execution lane has no execution root.");
  }
  return {
    id: lane.id,
    chatId: lane.chatId,
    workerId: lane.workerId,
    acquiringActor:
      lane.acquiringActor as ContextualChatExecutionLaneSummary["acquiringActor"],
    exclusive: lane.exclusive,
    purpose: lane.purpose,
    state: lane.state as ContextualChatExecutionLaneSummary["state"],
    baseRevision: lane.baseRevision,
    startingHead: lane.startingHead,
    runtimeSessionId: lane.runtimeSessionId,
    codexThreadId: lane.codexThreadId,
    transitionKind:
      lane.transitionKind as ContextualChatExecutionLaneSummary["transitionKind"],
    createdAt: toISOString(lane.createdAt),
    activatedAt: lane.activatedAt ? toISOString(lane.activatedAt) : null,
    releasedAt: lane.releasedAt ? toISOString(lane.releasedAt) : null,
    updatedAt: toISOString(lane.updatedAt),
    contextKind: "standalone",
    worktreeId: null,
    scratchRootId: lane.scratchRootId,
  };
}

export class ChatExecutionLaneRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ChatExecutionLaneRepositoryCollaborators,
  ) {}

  async listChatExecutionLanes(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionLaneSummary[]> {
    const rows = await this.database
      .select({ lane: schema.chatExecutionLanes })
      .from(schema.chatExecutionLanes)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatExecutionLanes.chatId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatExecutionLanes.chatId, chatId))
      .orderBy(desc(schema.chatExecutionLanes.createdAt));
    return rows.map(({ lane }) => toChatExecutionLaneSummary(lane));
  }

  async listProjectExecutionLanes(
    ownerId: string,
    projectId: string,
    options: { includeHistory?: boolean } = {},
  ): Promise<ChatExecutionLaneSummary[]> {
    const rows = await this.database
      .select({ lane: schema.chatExecutionLanes })
      .from(schema.chatExecutionLanes)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatExecutionLanes.chatId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        options.includeHistory
          ? eq(schema.chats.projectId, projectId)
          : and(
              eq(schema.chats.projectId, projectId),
              ne(schema.chatExecutionLanes.state, "released"),
            ),
      )
      .orderBy(desc(schema.chatExecutionLanes.updatedAt));
    return rows.map(({ lane }) => toChatExecutionLaneSummary(lane));
  }

  async resetInterruptedChatExecutions(): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(schema.agentInteractionRequests)
        .set({ status: "interrupted", resolvedAt: now, updatedAt: now })
        .where(eq(schema.agentInteractionRequests.status, "pending"));
      const interruptedPrimaryLanes = await transaction
        .select({ id: schema.chatExecutionLanes.id })
        .from(schema.chatExecutionLanes)
        .innerJoin(
          schema.projectWorktrees,
          eq(schema.projectWorktrees.id, schema.chatExecutionLanes.worktreeId),
        )
        .where(
          and(
            eq(schema.chatExecutionLanes.state, "active"),
            eq(schema.projectWorktrees.isPrimary, true),
          ),
        );
      await transaction
        .update(schema.chatExecutionLanes)
        .set({ state: "suspended", updatedAt: now })
        .where(eq(schema.chatExecutionLanes.state, "active"));
      for (const lane of interruptedPrimaryLanes) {
        await releaseChatLogicalBranchLease(transaction, lane.id);
      }
      await transaction
        .update(schema.chats)
        .set({
          status: "failed",
          hasUnreadCompletion: true,
          updatedAt: now,
        })
        .where(
          and(
            inArray(schema.chats.status, ["running", "waiting-for-approval"]),
            eq(schema.chats.automationPaused, false),
          ),
        );
      await transaction
        .update(schema.chats)
        .set({ status: "idle", hasUnreadCompletion: true, updatedAt: now })
        .where(
          and(
            inArray(schema.chats.status, ["running", "waiting-for-approval"]),
            eq(schema.chats.automationPaused, true),
          ),
        );
      await transaction
        .update(schema.chatRuntimeSessions)
        .set({ status: "detached", updatedAt: now })
        .where(
          inArray(schema.chatRuntimeSessions.status, ["starting", "running"]),
        );
    });
  }

  async startChatExecutionLane(
    ownerId: string,
    chatId: string,
    acquiringActor: ChatExecutionLaneSummary["acquiringActor"],
    purpose: string,
  ): Promise<ChatExecutionContext | null> {
    const identities = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (identities[0]?.contextKind === "standalone") {
      return this.startStandaloneChatExecutionLane(
        ownerId,
        chatId,
        acquiringActor,
        purpose,
      );
    }
    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(projectChatExecutionLock(ownerId, chatId));
        const rows = await transaction
          .select({
            chat: schema.chats,
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
              eq(
                schema.chatRuntimeSessions.worktreeId,
                schema.projectWorktrees.id,
              ),
            ),
          )
          .where(eq(schema.chats.id, chatId))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        const projectId = requiredProjectChatProjectId(row.chat.projectId);
        if (row.worktree.lifecycleState !== "ready") {
          throw new ExecutionLaneConflictError(
            "The selected worktree is not ready for execution.",
          );
        }
        if (row.chat.automationPaused) {
          throw new ExecutionLaneConflictError(
            "Chat automation is paused. Resume the chat before starting another turn.",
          );
        }
        const activeRelocations = await transaction
          .select({ id: schema.chatRelocationJobs.id })
          .from(schema.chatRelocationJobs)
          .where(
            and(
              eq(schema.chatRelocationJobs.chatId, chatId),
              inArray(schema.chatRelocationJobs.state, [
                "queued",
                "waiting-for-idle",
                "validating",
                "preparing-replica",
                "transferring-attachments",
                "hydrating-runtime",
                "ready-to-commit",
                "blocked",
              ]),
            ),
          )
          .limit(1);
        if (activeRelocations[0]) {
          throw new ExecutionLaneConflictError(
            "Chat relocation is active. Cancel it before starting another turn on the source placement.",
          );
        }
        const incompleteImports = await transaction
          .select({ state: schema.chatImportJobs.state })
          .from(schema.chatImportJobs)
          .where(
            and(
              eq(schema.chatImportJobs.chatId, chatId),
              notInArray(schema.chatImportJobs.state, [
                "succeeded",
                "cancelled",
              ]),
            ),
          )
          .limit(1);
        if (incompleteImports[0]) {
          throw new ExecutionLaneConflictError(
            "This imported chat must finish runtime hydration before it can continue.",
          );
        }

        const claimed = await transaction
          .update(schema.chats)
          .set({ status: "running", updatedAt: new Date() })
          .where(
            and(
              eq(schema.chats.id, chatId),
              notInArray(schema.chats.status, [
                "running",
                "waiting-for-approval",
              ]),
            ),
          )
          .returning({ id: schema.chats.id });
        if (!claimed[0]) {
          throw new ExecutionLaneConflictError(
            "This chat already has an active execution.",
          );
        }

        let runtime = row.runtime;
        if (!runtime) {
          const inserted = await transaction
            .insert(schema.chatRuntimeSessions)
            .values({
              id: randomUUID(),
              chatId,
              workerId: row.worktree.workerId,
              worktreeId: row.worktree.id,
            })
            .returning();
          runtime = firstOrThrow(inserted, "creating an execution runtime");
        }

        const existing = await transaction
          .select()
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, row.worktree.id),
              ne(schema.chatExecutionLanes.state, "released"),
            ),
          )
          .orderBy(desc(schema.chatExecutionLanes.createdAt))
          .limit(1);
        const now = new Date();
        let lane: typeof schema.chatExecutionLanes.$inferSelect;
        if (existing[0]) {
          const activated = await transaction
            .update(schema.chatExecutionLanes)
            .set({
              acquiringActor,
              exclusive: !row.worktree.isPrimary,
              purpose,
              state: "active",
              activatedAt: now,
              releasedAt: null,
              runtimeSessionId: runtime.id,
              codexThreadId: runtime.codexThreadId,
              updatedAt: now,
            })
            .where(eq(schema.chatExecutionLanes.id, existing[0].id))
            .returning();
          lane = firstOrThrow(activated, "activating an execution lane");
        } else {
          const inserted = await transaction
            .insert(schema.chatExecutionLanes)
            .values({
              id: randomUUID(),
              chatId,
              worktreeId: row.worktree.id,
              workerId: row.worktree.workerId,
              acquiringActor,
              exclusive: !row.worktree.isPrimary,
              purpose,
              state: "active",
              startingHead: row.worktree.head,
              runtimeSessionId: runtime.id,
              codexThreadId: runtime.codexThreadId,
              activatedAt: now,
            })
            .returning();
          lane = firstOrThrow(inserted, "creating an execution lane");
        }
        await acquireChatLogicalBranchLease(transaction, {
          branchName: row.worktree.branch,
          chatId,
          detached: row.worktree.detached,
          laneId: lane.id,
          projectId,
          workerId: row.worktree.workerId,
          worktreeId: row.worktree.id,
        });
        return {
          contextKind: "project",
          automationPaused: row.chat.automationPaused,
          computerUseAuthorityGeneration:
            row.chat.computerUseAuthorityGeneration,
          chatId,
          cwd: row.worktree.absolutePath,
          experience: row.chat.experience as ChatWireSummary["experience"],
          defaultPermissionProfileId:
            (row.settings?.defaultPermissionProfileId as
              UserSettings["defaultPermissionProfileId"] | undefined) ??
            DEFAULT_PERMISSION_PROFILE_ID,
          executionLaneId: lane.id,
          isPrimary: row.worktree.isPrimary,
          status: "running",
          modelId: row.chat.modelId,
          reasoningEffort: row.chat.reasoningEffort,
          modelConfiguration: chatModelConfiguration(row.chat),
          modelRouteId: runtime.modelRouteId,
          providerAccountId: runtime.providerAccountId,
          permissionProfileId: row.chat.permissionProfileId,
          planMode: row.chat.planMode as PlanMode,
          projectId,
          rootKind: row.worktree.rootKind,
          scratchRootId: null,
          threadId: runtime.codexThreadId,
          workerId: row.worktree.workerId,
          worktreeId: row.worktree.id,
          worktreeMode: row.chat
            .worktreeMode as ChatWireSummary["worktreeMode"],
          worktreePolicy: row.project.worktreePolicy as WorktreePolicy,
        };
      });
    } catch (error) {
      if (error instanceof ExecutionLaneConflictError) throw error;
      if (error instanceof LogicalBranchLeaseConflictError) {
        throw new ExecutionLaneConflictError(error.message);
      }
      if (
        /unique|duplicate/i.test(error instanceof Error ? error.message : "")
      ) {
        throw new ExecutionLaneConflictError(
          "The worktree is already leased by another chat.",
        );
      }
      throw error;
    }
  }

  private async startStandaloneChatExecutionLane(
    ownerId: string,
    chatId: string,
    acquiringActor: ChatExecutionLaneSummary["acquiringActor"],
    purpose: string,
  ): Promise<StandaloneChatExecutionContext | null> {
    return this.database.transaction(async (transaction) => {
      const locked = await transaction
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "standalone"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked[0]) return null;
      const rows = await transaction
        .select({
          chat: schema.chats,
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
            eq(
              schema.standaloneChatRoots.workerId,
              schema.chats.activeWorkerId,
            ),
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
          schema.userSettings,
          eq(schema.userSettings.userId, schema.chats.ownerId),
        )
        .where(eq(schema.chats.id, chatId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      if (row.root.status !== "ready" || !row.root.protectedPathHandle) {
        throw new ExecutionLaneConflictError(
          row.root.status === "provisioning"
            ? "The standalone Chat scratch root is still provisioning."
            : "The standalone Chat scratch root is unavailable.",
        );
      }
      if (chatIsExecuting(row.chat.status as ChatWireSummary["status"])) {
        throw new ExecutionLaneConflictError(
          "This Chat already has an active execution.",
        );
      }
      const claimed = await transaction
        .update(schema.chats)
        .set({ status: "running", updatedAt: new Date() })
        .where(
          and(
            eq(schema.chats.id, chatId),
            notInArray(schema.chats.status, [
              "running",
              "waiting-for-approval",
            ]),
          ),
        )
        .returning({ id: schema.chats.id });
      if (!claimed[0]) {
        throw new ExecutionLaneConflictError(
          "This Chat already has an active execution.",
        );
      }
      let runtime = row.runtime;
      if (!runtime) {
        runtime = firstOrThrow(
          await transaction
            .insert(schema.chatRuntimeSessions)
            .values({
              id: randomUUID(),
              chatId,
              workerId: row.root.workerId,
              worktreeId: null,
              scratchRootId: row.root.id,
            })
            .returning(),
          "creating a standalone Chat runtime",
        );
      }
      const existing = await transaction
        .select()
        .from(schema.chatExecutionLanes)
        .where(
          and(
            eq(schema.chatExecutionLanes.chatId, chatId),
            eq(schema.chatExecutionLanes.scratchRootId, row.root.id),
            ne(schema.chatExecutionLanes.state, "released"),
          ),
        )
        .orderBy(desc(schema.chatExecutionLanes.createdAt))
        .limit(1);
      const now = new Date();
      const lane = existing[0]
        ? firstOrThrow(
            await transaction
              .update(schema.chatExecutionLanes)
              .set({
                acquiringActor,
                exclusive: false,
                purpose,
                state: "active",
                activatedAt: now,
                releasedAt: null,
                runtimeSessionId: runtime.id,
                codexThreadId: runtime.codexThreadId,
                updatedAt: now,
              })
              .where(eq(schema.chatExecutionLanes.id, existing[0].id))
              .returning(),
            "activating a standalone Chat execution lane",
          )
        : firstOrThrow(
            await transaction
              .insert(schema.chatExecutionLanes)
              .values({
                id: randomUUID(),
                chatId,
                worktreeId: null,
                scratchRootId: row.root.id,
                workerId: row.root.workerId,
                acquiringActor,
                exclusive: false,
                purpose,
                state: "active",
                runtimeSessionId: runtime.id,
                codexThreadId: runtime.codexThreadId,
                activatedAt: now,
              })
              .returning(),
            "creating a standalone Chat execution lane",
          );
      return {
        contextKind: "standalone",
        automationPaused: false,
        computerUseAuthorityGeneration: row.chat.computerUseAuthorityGeneration,
        chatId,
        cwd: row.root.protectedPathHandle,
        experience: "agent",
        defaultPermissionProfileId:
          (row.settings?.defaultChatPermissionProfileId as
            UserSettings["defaultChatPermissionProfileId"] | undefined) ??
          DEFAULT_PERMISSION_PROFILE_ID,
        executionLaneId: lane.id,
        isPrimary: true,
        status: "running",
        modelId: row.chat.modelId,
        reasoningEffort: row.chat.reasoningEffort,
        modelConfiguration: chatModelConfiguration(row.chat),
        modelRouteId: runtime.modelRouteId,
        providerAccountId: runtime.providerAccountId,
        permissionProfileId: row.chat.permissionProfileId,
        planMode: "default",
        projectId: null,
        rootKind: null,
        scratchRootStatus: "ready",
        scratchRootId: row.root.id,
        threadId: runtime.codexThreadId,
        workerId: row.root.workerId,
        worktreeId: null,
        worktreeMode: null,
        worktreePolicy: null,
      };
    });
  }

  async finishChatExecutionLane(
    chatId: string,
    laneId: string,
    status: ChatWireSummary["status"],
  ): Promise<boolean> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const laneRows = await transaction
        .select({
          lane: schema.chatExecutionLanes,
          isPrimary: schema.projectWorktrees.isPrimary,
        })
        .from(schema.chatExecutionLanes)
        .leftJoin(
          schema.projectWorktrees,
          eq(schema.projectWorktrees.id, schema.chatExecutionLanes.worktreeId),
        )
        .where(
          and(
            eq(schema.chatExecutionLanes.id, laneId),
            eq(schema.chatExecutionLanes.chatId, chatId),
          ),
        )
        .limit(1);
      const suspended = await transaction
        .update(schema.chatExecutionLanes)
        .set({ state: "suspended", updatedAt: now })
        .where(
          and(
            eq(schema.chatExecutionLanes.id, laneId),
            eq(schema.chatExecutionLanes.chatId, chatId),
            eq(schema.chatExecutionLanes.state, "active"),
          ),
        )
        .returning({ id: schema.chatExecutionLanes.id });
      if (suspended[0] && laneRows[0]?.isPrimary) {
        await releaseChatLogicalBranchLease(transaction, laneId);
      }
      if (!suspended[0]) return false;
      await transaction
        .update(schema.chats)
        .set({
          status,
          ...(status === "idle" || status === "failed"
            ? { hasUnreadCompletion: true }
            : {}),
          updatedAt: now,
        })
        .where(eq(schema.chats.id, chatId));
      return true;
    });
  }

  async updateChatExecutionLaneRuntime(
    chatId: string,
    laneId: string,
    threadId: string | null,
    status: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const lanes = await transaction
        .update(schema.chatExecutionLanes)
        .set({ codexThreadId: threadId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.chatExecutionLanes.id, laneId),
            eq(schema.chatExecutionLanes.chatId, chatId),
          ),
        )
        .returning({
          runtimeSessionId: schema.chatExecutionLanes.runtimeSessionId,
        });
      const runtimeSessionId = lanes[0]?.runtimeSessionId;
      if (!runtimeSessionId) return false;
      await transaction
        .update(schema.chatRuntimeSessions)
        .set({ codexThreadId: threadId, status, updatedAt: new Date() })
        .where(eq(schema.chatRuntimeSessions.id, runtimeSessionId));
      return true;
    });
  }

  async getChatExecutionLaneContext(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<ChatExecutionLaneContext | null> {
    const rows = await this.database
      .select({
        chat: schema.chats,
        lane: schema.chatExecutionLanes,
        sourcePath: schema.projectSources.absolutePath,
        worktree: schema.projectWorktrees,
      })
      .from(schema.chatExecutionLanes)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatExecutionLanes.chatId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.chatExecutionLanes.worktreeId),
      )
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
      .where(
        and(
          eq(schema.chatExecutionLanes.id, laneId),
          eq(schema.chatExecutionLanes.chatId, chatId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      chat: toChatWireSummary(row.chat),
      lane: toChatExecutionLaneSummary(row.lane),
      sourcePath: row.sourcePath,
      worktree: toProjectWorktreeSummary(
        row.worktree,
        requiredProjectChatProjectId(row.chat.projectId),
      ),
    };
  }

  async getChatExecutionRecoveryContext(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<ChatExecutionRecoveryContext | null> {
    const project = await this.collaborators.getChatExecutionLaneContext(
      ownerId,
      chatId,
      laneId,
    );
    if (project) return project;
    const rows = await this.database
      .select({
        chat: schema.chats,
        lane: schema.chatExecutionLanes,
        root: schema.standaloneChatRoots,
      })
      .from(schema.chatExecutionLanes)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatExecutionLanes.chatId),
      )
      .innerJoin(
        schema.standaloneChatRoots,
        eq(
          schema.standaloneChatRoots.id,
          schema.chatExecutionLanes.scratchRootId,
        ),
      )
      .where(
        and(
          eq(schema.chatExecutionLanes.id, laneId),
          eq(schema.chatExecutionLanes.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.root.protectedPathHandle) return null;
    const lane = toContextualChatExecutionLaneSummary(row.lane);
    if (lane.contextKind !== "standalone") return null;
    return {
      chat: toStandaloneChatWireSummary(row.chat),
      lane,
      root: {
        id: row.root.id,
        pathHandle: row.root.protectedPathHandle,
        workerId: row.root.workerId,
      },
    };
  }

  async releaseChatExecutionLane(
    ownerId: string,
    chatId: string,
    laneId: string,
    returnToPrimary: boolean,
  ): Promise<ChatExecutionLaneReleaseResult | null> {
    const context = await this.collaborators.getChatExecutionLaneContext(
      ownerId,
      chatId,
      laneId,
    );
    if (!context) return null;
    if (
      chatIsExecuting(context.chat.status) ||
      context.lane.state === "active"
    ) {
      throw new ExecutionLaneConflictError(
        "Finish the active chat execution before releasing its lane.",
      );
    }
    const consoles = await this.database
      .select({ status: schema.terminals.status })
      .from(schema.terminals)
      .where(eq(schema.terminals.linkedChatId, chatId));
    if (consoles.some(({ status }) => status === "running")) {
      throw new ExecutionLaneConflictError(
        "Stop the linked Codex console before releasing its lane.",
      );
    }

    return this.database.transaction(async (transaction) => {
      const releasedRows = await transaction
        .update(schema.chatExecutionLanes)
        .set({
          state: "released",
          releasedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.chatExecutionLanes.id, laneId),
            ne(schema.chatExecutionLanes.state, "released"),
          ),
        )
        .returning();
      const released = releasedRows[0] ?? null;
      if (!released) {
        return {
          chat: context.chat,
          lane: context.lane,
          returnedToPrimary: false,
        };
      }
      await releaseChatLogicalBranchLease(transaction, laneId);

      let returnedToPrimary = false;
      if (
        returnToPrimary &&
        !context.worktree.isPrimary &&
        context.chat.activeWorktreeId === context.worktree.id
      ) {
        const primaryRows = await transaction
          .select({ worktree: schema.projectWorktrees })
          .from(schema.projectWorktrees)
          .innerJoin(
            schema.projectSources,
            and(
              eq(
                schema.projectSources.id,
                schema.projectWorktrees.projectSourceId,
              ),
              eq(schema.projectSources.projectId, context.chat.projectId),
            ),
          )
          .where(
            and(
              eq(schema.projectWorktrees.isPrimary, true),
              eq(schema.projectSources.workerId, context.lane.workerId),
              isNull(schema.projectSources.removedAt),
            ),
          )
          .limit(1);
        const primary = primaryRows[0]?.worktree;
        if (!primary || primary.lifecycleState !== "ready") {
          throw new ExecutionLaneConflictError(
            "Primary is not ready, so this lane cannot be released safely.",
          );
        }
        await transaction
          .insert(schema.chatRuntimeSessions)
          .values({
            id: randomUUID(),
            chatId,
            workerId: primary.workerId,
            worktreeId: primary.id,
          })
          .onConflictDoNothing({
            target: [
              schema.chatRuntimeSessions.chatId,
              schema.chatRuntimeSessions.workerId,
              schema.chatRuntimeSessions.worktreeId,
            ],
          });
        const runtimes = await transaction
          .select()
          .from(schema.chatRuntimeSessions)
          .where(
            and(
              eq(schema.chatRuntimeSessions.chatId, chatId),
              eq(schema.chatRuntimeSessions.workerId, primary.workerId),
              eq(schema.chatRuntimeSessions.worktreeId, primary.id),
            ),
          )
          .limit(1);
        const runtime = firstOrThrow(runtimes, "selecting the Primary runtime");
        const primaryLane = await transaction
          .select({ id: schema.chatExecutionLanes.id })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, primary.id),
              ne(schema.chatExecutionLanes.state, "released"),
            ),
          )
          .limit(1);
        if (!primaryLane[0]) {
          await transaction.insert(schema.chatExecutionLanes).values({
            id: randomUUID(),
            chatId,
            worktreeId: primary.id,
            workerId: primary.workerId,
            acquiringActor: "user",
            exclusive: false,
            purpose: "Returned to Primary after lane release",
            state: "suspended",
            startingHead: primary.head,
            runtimeSessionId: runtime.id,
            codexThreadId: runtime.codexThreadId,
          });
        }
        await transaction
          .update(schema.terminals)
          .set({
            activeWorkerId: primary.workerId,
            worktreeId: primary.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.terminals.linkedChatId, chatId));
        await transaction
          .update(schema.chats)
          .set({
            activeWorkerId: primary.workerId,
            activeWorktreeId: primary.id,
            placementRevision: sql`${schema.chats.placementRevision} + 1`,
            worktreeMode: "agent-managed",
            updatedAt: new Date(),
          })
          .where(eq(schema.chats.id, chatId));
        returnedToPrimary = true;
      }
      const chats = await transaction
        .select()
        .from(schema.chats)
        .where(eq(schema.chats.id, chatId))
        .limit(1);
      return {
        chat: toChatWireSummary(
          firstOrThrow(chats, "selecting a released chat"),
        ),
        lane: toChatExecutionLaneSummary(released),
        returnedToPrimary,
      };
    });
  }

  async scheduleChatWorktreeTransition(
    ownerId: string,
    chatId: string,
    expectedExecutionLaneId: string,
    targetWorktreeId: string,
    transitionKind: "switch" | "release",
    purpose: string,
  ): Promise<ChatExecutionLaneContext | null> {
    const current = await this.collaborators.getChatExecutionContext(
      ownerId,
      chatId,
    );
    if (!current) return null;
    if (current.contextKind !== "project") {
      throw new ExecutionLaneConflictError(
        "Standalone Chats do not support worktree transitions.",
      );
    }
    if (current.worktreeMode === "pinned") {
      throw new ExecutionLaneConflictError(
        "This chat is pinned. Return it to Agent managed before allowing autonomous worktree transitions.",
      );
    }
    if (
      !chatIsExecuting(current.status) ||
      current.executionLaneId !== expectedExecutionLaneId
    ) {
      throw new ExecutionLaneConflictError(
        "The originating execution lane is no longer active.",
      );
    }
    if (current.worktreeId === targetWorktreeId) {
      throw new ExecutionLaneConflictError(
        transitionKind === "release"
          ? "The chat is already running in Primary."
          : "The chat is already running in that worktree.",
      );
    }
    const target = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      current.projectId,
      targetWorktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;
    if (target.workerId !== current.workerId) {
      throw new ExecutionLaneConflictError(
        "Moving a chat to another worker requires a durable relocation.",
      );
    }
    if (transitionKind === "release" && !target.worktree.isPrimary) {
      throw new ExecutionLaneConflictError(
        "A release transition must return the chat to Primary.",
      );
    }
    const linkedConsoles = await this.database
      .select({ status: schema.terminals.status })
      .from(schema.terminals)
      .where(eq(schema.terminals.linkedChatId, chatId));
    if (linkedConsoles.some(({ status }) => status === "running")) {
      throw new ExecutionLaneConflictError(
        "Stop the linked Codex console before changing worktrees.",
      );
    }

    try {
      const laneId = await this.database.transaction(async (transaction) => {
        await transaction
          .update(schema.chatExecutionLanes)
          .set({
            state: "suspended",
            transitionKind: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.state, "delivering"),
            ),
          );
        await transaction
          .insert(schema.chatRuntimeSessions)
          .values({
            id: randomUUID(),
            chatId,
            workerId: target.workerId,
            worktreeId: target.worktree.id,
          })
          .onConflictDoNothing({
            target: [
              schema.chatRuntimeSessions.chatId,
              schema.chatRuntimeSessions.workerId,
              schema.chatRuntimeSessions.worktreeId,
            ],
          });
        const runtimes = await transaction
          .select()
          .from(schema.chatRuntimeSessions)
          .where(
            and(
              eq(schema.chatRuntimeSessions.chatId, chatId),
              eq(schema.chatRuntimeSessions.workerId, target.workerId),
              eq(schema.chatRuntimeSessions.worktreeId, target.worktree.id),
            ),
          )
          .limit(1);
        const runtime = firstOrThrow(
          runtimes,
          "selecting a transition runtime",
        );
        const existing = await transaction
          .select()
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, target.worktree.id),
              ne(schema.chatExecutionLanes.state, "released"),
            ),
          )
          .orderBy(desc(schema.chatExecutionLanes.createdAt))
          .limit(1);
        if (existing[0]) {
          await transaction
            .update(schema.chatExecutionLanes)
            .set({
              acquiringActor: "agent",
              exclusive: !target.worktree.isPrimary,
              purpose,
              state: "delivering",
              transitionKind,
              runtimeSessionId: runtime.id,
              codexThreadId: runtime.codexThreadId,
              updatedAt: new Date(),
            })
            .where(eq(schema.chatExecutionLanes.id, existing[0].id));
          await acquireChatLogicalBranchLease(transaction, {
            branchName: target.worktree.branch,
            chatId,
            detached: target.worktree.detached,
            laneId: existing[0].id,
            projectId: current.projectId,
            workerId: target.workerId,
            worktreeId: target.worktree.id,
          });
          return existing[0].id;
        }
        const inserted = await transaction
          .insert(schema.chatExecutionLanes)
          .values({
            id: randomUUID(),
            chatId,
            worktreeId: target.worktree.id,
            workerId: target.workerId,
            acquiringActor: "agent",
            exclusive: !target.worktree.isPrimary,
            purpose,
            state: "delivering",
            transitionKind,
            startingHead: target.worktree.head,
            runtimeSessionId: runtime.id,
            codexThreadId: runtime.codexThreadId,
          })
          .returning({ id: schema.chatExecutionLanes.id });
        const insertedLane = firstOrThrow(
          inserted,
          "scheduling a worktree transition",
        );
        await acquireChatLogicalBranchLease(transaction, {
          branchName: target.worktree.branch,
          chatId,
          detached: target.worktree.detached,
          laneId: insertedLane.id,
          projectId: current.projectId,
          workerId: target.workerId,
          worktreeId: target.worktree.id,
        });
        return insertedLane.id;
      });
      return this.collaborators.getChatExecutionLaneContext(
        ownerId,
        chatId,
        laneId,
      );
    } catch (error) {
      if (error instanceof ExecutionLaneConflictError) throw error;
      if (error instanceof LogicalBranchLeaseConflictError) {
        throw new ExecutionLaneConflictError(error.message);
      }
      if (
        /unique|duplicate/i.test(error instanceof Error ? error.message : "")
      ) {
        throw new ExecutionLaneConflictError(
          "The target worktree is already leased by another chat.",
        );
      }
      throw error;
    }
  }

  async getPendingChatWorktreeTransition(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionLaneContext | null> {
    const rows = await this.database
      .select({ id: schema.chatExecutionLanes.id })
      .from(schema.chatExecutionLanes)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatExecutionLanes.chatId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.chatExecutionLanes.chatId, chatId),
          eq(schema.chatExecutionLanes.state, "delivering"),
        ),
      )
      .limit(1);
    return rows[0]
      ? this.collaborators.getChatExecutionLaneContext(
          ownerId,
          chatId,
          rows[0].id,
        )
      : null;
  }

  async listPendingWorktreeTransitionChatIds(
    ownerId: string,
    workerId: string,
  ): Promise<string[]> {
    const rows = await this.database
      .select({ chatId: schema.chatExecutionLanes.chatId })
      .from(schema.chatExecutionLanes)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatExecutionLanes.chatId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.chatExecutionLanes.workerId, workerId),
          eq(schema.chatExecutionLanes.state, "delivering"),
        ),
      );
    return rows.map(({ chatId }) => chatId);
  }

  async cancelChatWorktreeTransition(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<boolean> {
    const context = await this.collaborators.getChatExecutionLaneContext(
      ownerId,
      chatId,
      laneId,
    );
    if (!context || context.lane.state !== "delivering") return false;
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(schema.chatExecutionLanes)
        .set({
          state: "suspended",
          transitionKind: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.chatExecutionLanes.id, laneId))
        .returning({ id: schema.chatExecutionLanes.id });
      if (rows[0] && context.worktree.isPrimary) {
        await releaseChatLogicalBranchLease(transaction, laneId);
      }
      return rows.length === 1;
    });
  }

  async applyChatWorktreeTransition(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<ChatWorktreeTransitionResult | null> {
    const pending = await this.collaborators.getChatExecutionLaneContext(
      ownerId,
      chatId,
      laneId,
    );
    if (!pending || pending.lane.state !== "delivering") return null;
    const transitionKind = pending.lane.transitionKind;
    if (!transitionKind) return null;
    if (pending.worktree.lifecycleState !== "ready") {
      throw new ExecutionLaneConflictError(
        "The target worktree is no longer ready for execution.",
      );
    }
    if (pending.worktree.workerId !== pending.chat.activeWorkerId) {
      throw new ExecutionLaneConflictError(
        "Moving a chat to another worker requires a durable relocation.",
      );
    }
    if (chatIsExecuting(pending.chat.status)) {
      throw new ExecutionLaneConflictError(
        "Finish the active turn before applying its worktree transition.",
      );
    }
    const fromWorktreeId = pending.chat.activeWorktreeId;
    return this.database.transaction(async (transaction) => {
      if (transitionKind === "release") {
        const releasedLanes = await transaction
          .update(schema.chatExecutionLanes)
          .set({
            state: "released",
            releasedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, fromWorktreeId),
              ne(schema.chatExecutionLanes.state, "released"),
            ),
          )
          .returning({ id: schema.chatExecutionLanes.id });
        for (const releasedLane of releasedLanes) {
          await releaseChatLogicalBranchLease(transaction, releasedLane.id);
        }
      }
      const lanes = await transaction
        .update(schema.chatExecutionLanes)
        .set({
          state: "suspended",
          transitionKind: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.chatExecutionLanes.id, laneId),
            eq(schema.chatExecutionLanes.state, "delivering"),
          ),
        )
        .returning();
      const lane = firstOrThrow(lanes, "applying a worktree transition");
      if (pending.worktree.isPrimary) {
        await releaseChatLogicalBranchLease(transaction, lane.id);
      }
      await transaction
        .update(schema.terminals)
        .set({
          activeWorkerId: pending.worktree.workerId,
          worktreeId: pending.worktree.id,
          updatedAt: new Date(),
        })
        .where(eq(schema.terminals.linkedChatId, chatId));
      const chats = await transaction
        .update(schema.chats)
        .set({
          activeWorkerId: pending.worktree.workerId,
          activeWorktreeId: pending.worktree.id,
          placementRevision: sql`${schema.chats.placementRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.chats.id, chatId))
        .returning();
      return {
        chat: toChatWireSummary(
          firstOrThrow(chats, "switching chat worktrees"),
        ),
        fromWorktreeId,
        lane: toChatExecutionLaneSummary(lane),
        transitionKind,
        worktree: pending.worktree,
      };
    });
  }
}
