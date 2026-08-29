import { randomUUID } from "node:crypto";

import {
  chatComposerDraftOpaqueStateSchema,
  encryptedChatComposerDraftWireStateSchema,
} from "@cantrip/protocol";
import type {
  ChatComposerDraftOpaqueState,
  ChatWireSummary,
  ChatWorktreeUpdate,
  ContextualChatWireSummary,
  EncryptedChatComposerDraftWireState,
  EncryptedChatUpdate,
} from "@cantrip/protocol";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  ExecutionLaneConflictError,
  chatIsExecuting,
  requiredProjectChatProjectId,
} from "./chat-execution-lanes.js";
import {
  toChatWireSummary,
  toContextualChatWireSummary,
} from "./chat-mappers.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";
import type { ProjectWorktreeExecutionContext } from "./projects.js";

export interface ChatStateRepositoryCollaborators {
  getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null>;
}

export class ChatStateRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ChatStateRepositoryCollaborators,
  ) {}

  async updateChat(
    ownerId: string,
    chatId: string,
    input: EncryptedChatUpdate,
  ): Promise<ContextualChatWireSummary | null> {
    const owned = await this.database
      .select({ id: schema.chats.id })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    if (!owned[0]) return null;
    const result = await this.database
      .update(schema.chats)
      .set({ protectedLabel: input.titleProtection, updatedAt: new Date() })
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .returning();
    return result[0] ? toContextualChatWireSummary(result[0]) : null;
  }

  async getChatComposerDraftWireState(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedChatComposerDraftWireState | null> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    const chat = rows[0]?.chat;
    return chat
      ? encryptedChatComposerDraftWireStateSchema.parse({
          chatId: chat.id,
          state: chat.protectedComposerDraft,
          updatedAt: chat.composerDraftUpdatedAt
            ? toISOString(chat.composerDraftUpdatedAt)
            : null,
        })
      : null;
  }

  async updateChatComposerDraft(
    ownerId: string,
    chatId: string,
    state: ChatComposerDraftOpaqueState | null,
  ): Promise<EncryptedChatComposerDraftWireState | null> {
    const parsed = state
      ? chatComposerDraftOpaqueStateSchema.parse(state)
      : null;
    const updatedAt = new Date();
    const rows = await this.database
      .update(schema.chats)
      .set({
        protectedComposerDraft: parsed,
        composerDraftUpdatedAt: updatedAt,
      })
      .where(
        and(
          eq(schema.chats.id, chatId),
          isNull(schema.chats.archivedAt),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .returning({ id: schema.chats.id });
    return rows[0]
      ? encryptedChatComposerDraftWireStateSchema.parse({
          chatId: rows[0].id,
          state: parsed,
          updatedAt: toISOString(updatedAt),
        })
      : null;
  }

  async setChatAutomationPaused(
    ownerId: string,
    chatId: string,
    paused: boolean,
  ): Promise<ContextualChatWireSummary | null> {
    const rows = await this.database
      .update(schema.chats)
      .set({ automationPaused: paused, updatedAt: new Date() })
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .returning();
    return rows[0] ? toContextualChatWireSummary(rows[0]) : null;
  }

  async updateChatWorktree(
    ownerId: string,
    chatId: string,
    input: ChatWorktreeUpdate,
  ): Promise<ChatWireSummary | null> {
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
      .where(eq(schema.chats.id, chatId))
      .limit(1);
    const chat = rows[0]?.chat;
    if (!chat) return null;
    const projectId = requiredProjectChatProjectId(chat.projectId);
    const target = await this.collaborators.getProjectWorktreeContext(
      ownerId,
      projectId,
      input.worktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;

    const changingWorktree = chat.activeWorktreeId !== target.worktree.id;
    if (
      changingWorktree &&
      chat.activeWorkerId !== null &&
      chat.activeWorkerId !== target.workerId
    ) {
      throw new ExecutionLaneConflictError(
        "Moving a chat to another worker requires a durable relocation.",
      );
    }
    if (
      changingWorktree &&
      chatIsExecuting(chat.status as ChatWireSummary["status"])
    ) {
      throw new ExecutionLaneConflictError(
        "Wait for the active chat turn before switching worktrees.",
      );
    }
    if (changingWorktree) {
      const [activeLanes, reservations, consoles] = await Promise.all([
        this.database
          .select({ id: schema.chatExecutionLanes.id })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.state, "active"),
            ),
          ),
        this.database
          .select({ chatId: schema.chatExecutionLanes.chatId })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.worktreeId, target.worktree.id),
              eq(schema.chatExecutionLanes.exclusive, true),
              ne(schema.chatExecutionLanes.state, "released"),
            ),
          ),
        this.database
          .select({ terminal: schema.terminals })
          .from(schema.terminals)
          .where(eq(schema.terminals.linkedChatId, chatId)),
      ]);
      if (activeLanes.length > 0) {
        throw new ExecutionLaneConflictError(
          "Finish the active chat execution before switching worktrees.",
        );
      }
      const owner = reservations.find(
        ({ chatId: ownerId }) => ownerId !== chatId,
      );
      if (owner) {
        throw new ExecutionLaneConflictError(
          `Worktree is exclusively leased to chat ${owner.chatId}.`,
        );
      }
      if (consoles.some(({ terminal }) => terminal.status === "running")) {
        throw new ExecutionLaneConflictError(
          "Stop the linked Codex console before switching worktrees.",
        );
      }
    }

    return this.database.transaction(async (transaction) => {
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
      const runtime = firstOrThrow(runtimes, "selecting a worktree runtime");
      const existingLanes = await transaction
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
      if (!existingLanes[0]) {
        await transaction.insert(schema.chatExecutionLanes).values({
          id: randomUUID(),
          chatId,
          worktreeId: target.worktree.id,
          workerId: target.workerId,
          acquiringActor: "user",
          exclusive: !target.worktree.isPrimary,
          purpose: "Selected by user",
          state: "suspended",
          startingHead: target.worktree.head,
          runtimeSessionId: runtime.id,
          codexThreadId: runtime.codexThreadId,
        });
      } else {
        await transaction
          .update(schema.chatExecutionLanes)
          .set({
            runtimeSessionId: runtime.id,
            codexThreadId: runtime.codexThreadId,
            updatedAt: new Date(),
          })
          .where(eq(schema.chatExecutionLanes.id, existingLanes[0].id));
      }
      if (changingWorktree) {
        await transaction
          .update(schema.terminals)
          .set({
            activeWorkerId: target.workerId,
            worktreeId: target.worktree.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.terminals.linkedChatId, chatId));
      }
      const updated = await transaction
        .update(schema.chats)
        .set({
          activeWorkerId: target.workerId,
          activeWorktreeId: target.worktree.id,
          ...(changingWorktree
            ? {
                placementRevision: sql`${schema.chats.placementRevision} + 1`,
              }
            : {}),
          worktreeMode: input.mode,
          updatedAt: new Date(),
        })
        .where(eq(schema.chats.id, chatId))
        .returning();
      return updated[0] ? toChatWireSummary(updated[0]) : null;
    });
  }
}
