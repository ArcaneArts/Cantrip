import { randomUUID } from "node:crypto";

import {
  encryptedQueuedPromptSchema,
  queuedPromptOpaqueContentSchema,
} from "@cantrip/protocol";
import type {
  EncryptedQueuedPrompt,
  QueuedPrompt,
  QueuedPromptCreate,
  QueuedPromptOpaqueContent,
  QueuedPromptOrder,
  QueuedPromptUpdate,
} from "@cantrip/protocol";
import type { ChatAttachmentOpaqueSummary } from "@cantrip/protocol/attachment-content";
import { and, asc, desc, eq, exists, isNull } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  ExecutionLaneConflictError,
  requiredProjectChatProjectId,
} from "./chat-execution-lanes.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

function toQueuedPrompt(
  prompt: typeof schema.queuedPrompts.$inferSelect,
): QueuedPrompt {
  if (prompt.text === null) {
    throw new Error("Encrypted queued prompts require the opaque mapper.");
  }
  return {
    id: prompt.id,
    chatId: prompt.chatId,
    text: prompt.text,
    mode: prompt.mode,
    attachments: [],
    modelId: prompt.modelId,
    reasoningEffort: prompt.reasoningEffort,
    customSubagentModel: prompt.customSubagentModel,
    subagentModelId: prompt.subagentModelId,
    subagentReasoningEffort: prompt.subagentReasoningEffort,
    worktreeId: prompt.worktreeId,
    position: prompt.position,
    frozen: prompt.frozen,
    createdAt: toISOString(prompt.createdAt),
    updatedAt: toISOString(prompt.updatedAt),
  };
}

function toEncryptedQueuedPrompt(
  prompt: typeof schema.queuedPrompts.$inferSelect,
): EncryptedQueuedPrompt {
  if (!prompt.opaqueContent || prompt.text !== null) {
    throw new Error("Visible queued prompts require the plaintext mapper.");
  }
  return encryptedQueuedPromptSchema.parse({
    ...prompt.opaqueContent,
    chatId: prompt.chatId,
    attachments: prompt.attachments,
    position: prompt.position,
    createdAt: toISOString(prompt.createdAt),
    updatedAt: toISOString(prompt.updatedAt),
  });
}

export class QueuedPromptRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async listQueuedPrompts(
    ownerId: string,
    chatId: string,
  ): Promise<QueuedPrompt[]> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.queuedPrompts.chatId, chatId))
      .orderBy(
        asc(schema.queuedPrompts.position),
        asc(schema.queuedPrompts.createdAt),
      );
    return rows.map(({ prompt }) => toQueuedPrompt(prompt));
  }

  async listEncryptedQueuedPrompts(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedQueuedPrompt[]> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .orderBy(
        asc(schema.queuedPrompts.position),
        asc(schema.queuedPrompts.createdAt),
      );
    return rows.map(({ prompt }) => toEncryptedQueuedPrompt(prompt));
  }

  async getEncryptedQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<EncryptedQueuedPrompt | null> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toEncryptedQueuedPrompt(rows[0].prompt) : null;
  }

  async createEncryptedQueuedPrompt(
    ownerId: string,
    chatId: string,
    input: QueuedPromptOpaqueContent,
    attachments: ChatAttachmentOpaqueSummary[],
  ): Promise<EncryptedQueuedPrompt | null> {
    const prompt = queuedPromptOpaqueContentSchema.parse(input);
    const chat = await this.database
      .select({
        contextKind: schema.chats.contextKind,
        experience: schema.chats.experience,
      })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (!chat[0] || chat[0].experience !== "agent") return null;
    if (
      chat[0].contextKind === "standalone" &&
      (prompt.classification.mode !== "default" ||
        prompt.worktreeId !== null ||
        prompt.customSubagentModel ||
        prompt.subagentModelId !== null ||
        prompt.subagentReasoningEffort !== null)
    ) {
      throw new ExecutionLaneConflictError(
        "Standalone Chat queued prompts must use default mode without worktree or subagent settings.",
      );
    }
    const existing = await this.database
      .select()
      .from(schema.queuedPrompts)
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.queuedPrompts.idempotencyKey, prompt.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return toEncryptedQueuedPrompt(existing[0]);
    const last = await this.database
      .select({ position: schema.queuedPrompts.position })
      .from(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.chatId, chatId))
      .orderBy(desc(schema.queuedPrompts.position))
      .limit(1);
    const result = await this.database
      .insert(schema.queuedPrompts)
      .values({
        id: prompt.id,
        chatId,
        text: null,
        opaqueContent: prompt,
        mode: prompt.classification.mode,
        attachments,
        modelId: prompt.modelId,
        reasoningEffort: prompt.reasoningEffort,
        customSubagentModel: prompt.customSubagentModel,
        subagentModelId: prompt.subagentModelId,
        subagentReasoningEffort: prompt.subagentReasoningEffort,
        worktreeId: prompt.worktreeId,
        position: (last[0]?.position ?? -1) + 1,
        frozen: prompt.frozen,
        idempotencyKey: prompt.idempotencyKey,
      })
      .returning();
    return toEncryptedQueuedPrompt(firstOrThrow(result, "queueing a prompt"));
  }

  async replaceEncryptedQueuedPrompt(
    ownerId: string,
    promptId: string,
    input: QueuedPromptOpaqueContent,
    attachments: ChatAttachmentOpaqueSummary[],
  ): Promise<EncryptedQueuedPrompt | null> {
    const prompt = queuedPromptOpaqueContentSchema.parse(input);
    if (prompt.id !== promptId) return null;
    const contexts = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!contexts[0]) return null;
    if (
      contexts[0].contextKind === "standalone" &&
      (prompt.classification.mode !== "default" ||
        prompt.worktreeId !== null ||
        prompt.customSubagentModel ||
        prompt.subagentModelId !== null ||
        prompt.subagentReasoningEffort !== null)
    ) {
      throw new ExecutionLaneConflictError(
        "Standalone Chat queued prompts must use default mode without worktree or subagent settings.",
      );
    }
    const result = await this.database
      .update(schema.queuedPrompts)
      .set({
        opaqueContent: prompt,
        mode: prompt.classification.mode,
        attachments,
        reasoningEffort: prompt.reasoningEffort,
        customSubagentModel: prompt.customSubagentModel,
        subagentModelId: prompt.subagentModelId,
        subagentReasoningEffort: prompt.subagentReasoningEffort,
        worktreeId: prompt.worktreeId,
        frozen: prompt.frozen,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          exists(
            this.database
              .select({ id: schema.chats.id })
              .from(schema.chats)
              .where(
                and(
                  eq(schema.chats.id, schema.queuedPrompts.chatId),
                  eq(schema.chats.ownerId, ownerId),
                ),
              ),
          ),
        ),
      )
      .returning();
    return result[0] ? toEncryptedQueuedPrompt(result[0]) : null;
  }

  async getQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<QueuedPrompt | null> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.queuedPrompts.id, promptId))
      .limit(1);
    return rows[0] ? toQueuedPrompt(rows[0].prompt) : null;
  }

  async createQueuedPrompt(
    ownerId: string,
    chatId: string,
    input: QueuedPromptCreate,
    modelId: string,
    attachments: ChatAttachmentOpaqueSummary[] = [],
  ): Promise<QueuedPrompt | null> {
    const chat = await this.database
      .select({
        experience: schema.chats.experience,
        id: schema.chats.id,
        projectId: schema.chats.projectId,
      })
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
    if (!chat[0] || chat[0].experience !== "agent") return null;
    const projectId = requiredProjectChatProjectId(chat[0].projectId);
    if (input.worktreeId) {
      const target = await this.database
        .select({ id: schema.projectWorktrees.id })
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
            eq(schema.projectWorktrees.id, input.worktreeId),
            eq(schema.projectWorktrees.lifecycleState, "ready"),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .limit(1);
      if (!target[0]) return null;
    }

    const existing = await this.database
      .select()
      .from(schema.queuedPrompts)
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.queuedPrompts.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return toQueuedPrompt(existing[0]);

    const last = await this.database
      .select({ position: schema.queuedPrompts.position })
      .from(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.chatId, chatId))
      .orderBy(desc(schema.queuedPrompts.position))
      .limit(1);
    const result = await this.database
      .insert(schema.queuedPrompts)
      .values({
        id: randomUUID(),
        chatId,
        text: input.text,
        mode: input.mode,
        attachments,
        modelId,
        reasoningEffort: input.reasoningEffort ?? null,
        worktreeId: input.worktreeId,
        position: (last[0]?.position ?? -1) + 1,
        frozen: input.frozen,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    return toQueuedPrompt(firstOrThrow(result, "queueing a prompt"));
  }

  async updateQueuedPrompt(
    ownerId: string,
    promptId: string,
    input: QueuedPromptUpdate,
    attachments?: ChatAttachmentOpaqueSummary[],
  ): Promise<QueuedPrompt | null> {
    const owned = await this.database
      .select({
        experience: schema.chats.experience,
        id: schema.queuedPrompts.id,
      })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.queuedPrompts.id, promptId))
      .limit(1);
    if (!owned[0] || owned[0].experience !== "agent") return null;
    const result = await this.database
      .update(schema.queuedPrompts)
      .set({
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.reasoningEffort !== undefined
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
        ...(input.frozen !== undefined ? { frozen: input.frozen } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.queuedPrompts.id, promptId))
      .returning();
    return result[0] ? toQueuedPrompt(result[0]) : null;
  }

  async getQueuedPromptByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<QueuedPrompt | null> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.queuedPrompts.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toQueuedPrompt(rows[0].prompt) : null;
  }

  async deleteQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<QueuedPrompt | EncryptedQueuedPrompt | null> {
    const owned = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!owned[0]) return null;
    await this.database
      .delete(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.id, promptId));
    return owned[0].prompt.opaqueContent
      ? toEncryptedQueuedPrompt(owned[0].prompt)
      : toQueuedPrompt(owned[0].prompt);
  }

  async reorderQueuedPrompts(
    ownerId: string,
    chatId: string,
    input: QueuedPromptOrder,
  ): Promise<boolean> {
    const prompts = await this.database
      .select({ id: schema.queuedPrompts.id })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      );
    if (
      prompts.length !== input.ids.length ||
      prompts.some(({ id }) => !input.ids.includes(id))
    ) {
      return false;
    }
    await this.database.transaction(async (transaction) => {
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.queuedPrompts)
          .set({ position, updatedAt: new Date() })
          .where(eq(schema.queuedPrompts.id, id));
      }
    });
    return true;
  }
}
