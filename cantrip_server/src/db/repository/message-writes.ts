import { randomUUID } from "node:crypto";

import {
  chatMessageOpaqueContentSchema,
  taskMessageOpaqueContentSchema,
} from "@cantrip/protocol";
import type {
  ChatMessage,
  ChatMessageCreate,
  ChatMessageOpaqueContent,
  ChatMessageOpaqueSummary,
  ReasoningEffort,
  TaskMessageOpaqueContent,
  TaskMessageOpaqueSummary,
} from "@cantrip/protocol";
import { and, eq, exists, isNotNull, isNull } from "drizzle-orm";

import * as schema from "../schema.js";
import { requiredProjectChatWorktreeId } from "./chat-execution-lanes.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";
import type { ModelRuntime } from "./model-runtime.js";
import {
  toChatMessage,
  toEncryptedChatMessage,
  toTaskMessage,
} from "./message-mappers.js";

export type ChatExecutionAttribution =
  | {
      contextKind?: "project";
      executionLaneId: string;
      scratchRootId?: null;
      worktreeId: string;
    }
  | {
      contextKind: "standalone";
      executionLaneId: string;
      scratchRootId: string;
      worktreeId: null;
    };

interface MessageWriteRepositoryCollaborators {
  appendMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessage | null>;
  appendEncryptedMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessageOpaqueSummary | null>;
  appendTaskMessage(
    ownerId: string,
    chatId: string,
    input: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<TaskMessageOpaqueSummary | null>;
  getMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<ChatMessage | null>;
  getEncryptedMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<ChatMessageOpaqueSummary | null>;
  getTaskMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<TaskMessageOpaqueSummary | null>;
}

export class MessageWriteRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: MessageWriteRepositoryCollaborators,
  ) {}

  async appendMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessage | null> {
    if (attribution?.contextKind === "standalone") {
      throw new Error("Standalone Chat messages must use protected content.");
    }
    const chat = await this.database
      .select({
        id: schema.chats.id,
        experience: schema.chats.experience,
        worktreeId: schema.chats.activeWorktreeId,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    if (!chat[0] || chat[0].experience !== "agent") {
      return null;
    }
    const worktreeId = requiredProjectChatWorktreeId(chat[0].worktreeId);

    const activeLanes = attribution
      ? await this.database
          .select({
            id: schema.chatExecutionLanes.id,
            worktreeId: schema.chatExecutionLanes.worktreeId,
          })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.id, attribution.executionLaneId),
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, attribution.worktreeId),
            ),
          )
          .limit(1)
      : await this.database
          .select({
            id: schema.chatExecutionLanes.id,
            worktreeId: schema.chatExecutionLanes.worktreeId,
          })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, worktreeId),
              eq(schema.chatExecutionLanes.state, "active"),
            ),
          )
          .limit(1);
    if (attribution && !activeLanes[0]) return null;

    if (input.idempotencyKey) {
      const existing = await this.database
        .select()
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            eq(schema.chatMessages.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        return toChatMessage(existing[0]);
      }
    }

    const result = await this.database
      .insert(schema.chatMessages)
      .values({
        id: randomUUID(),
        chatId,
        worktreeId: attribution?.worktreeId ?? worktreeId,
        executionLaneId: activeLanes[0]?.id ?? null,
        role: input.role,
        mode: input.mode ?? "default",
        content: input.content,
        reasoningEffort: input.reasoningEffort ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();
    const message = firstOrThrow(result, "appending a chat message");
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toChatMessage(message);
  }

  async appendEncryptedMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessageOpaqueSummary | null> {
    const message = chatMessageOpaqueContentSchema.parse(input);
    const chat = await this.database
      .select({
        contextKind: schema.chats.contextKind,
        experience: schema.chats.experience,
        worktreeId: schema.chats.activeWorktreeId,
        scratchRootId: schema.chats.activeScratchRootId,
      })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    if (!chat[0] || chat[0].experience !== "agent") return null;
    const worktreeId = chat[0].worktreeId;
    const scratchRootId = chat[0].scratchRootId;
    if ((worktreeId === null) === (scratchRootId === null)) {
      throw new Error("Chat has an invalid execution root.");
    }
    const activeLanes = attribution
      ? await this.database
          .select({ id: schema.chatExecutionLanes.id })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.id, attribution.executionLaneId),
              eq(schema.chatExecutionLanes.chatId, chatId),
              attribution.contextKind === "standalone"
                ? eq(
                    schema.chatExecutionLanes.scratchRootId,
                    attribution.scratchRootId,
                  )
                : eq(
                    schema.chatExecutionLanes.worktreeId,
                    attribution.worktreeId,
                  ),
            ),
          )
          .limit(1)
      : await this.database
          .select({ id: schema.chatExecutionLanes.id })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              worktreeId
                ? eq(schema.chatExecutionLanes.worktreeId, worktreeId)
                : eq(schema.chatExecutionLanes.scratchRootId, scratchRootId!),
              eq(schema.chatExecutionLanes.state, "active"),
            ),
          )
          .limit(1);
    if (attribution && !activeLanes[0]) return null;
    const existing = await this.database
      .select()
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, message.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (
        existing[0].id !== message.id ||
        existing[0].role !== message.classification.role ||
        existing[0].mode !== message.classification.mode ||
        existing[0].reasoningEffort !== message.reasoningEffort ||
        JSON.stringify(existing[0].attachmentIds) !==
          JSON.stringify(message.classification.attachmentIds) ||
        JSON.stringify(existing[0].protectedContent) !==
          JSON.stringify(message.protectedContent)
      ) {
        throw new Error(
          "Encrypted chat message idempotency metadata is inconsistent.",
        );
      }
      return toEncryptedChatMessage(existing[0]);
    }
    const result = await this.database
      .insert(schema.chatMessages)
      .values({
        id: message.id,
        chatId,
        worktreeId: attribution?.worktreeId ?? worktreeId,
        scratchRootId: attribution
          ? (attribution.scratchRootId ?? null)
          : scratchRootId,
        executionLaneId: activeLanes[0]?.id ?? null,
        role: message.classification.role,
        mode: message.classification.mode,
        content: null,
        protectedContent: message.protectedContent,
        attachmentIds: message.classification.attachmentIds,
        taskProtectedContent: null,
        reasoningEffort: message.reasoningEffort,
        idempotencyKey: message.idempotencyKey,
      })
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toEncryptedChatMessage(
      firstOrThrow(result, "appending an encrypted chat message"),
    );
  }

  async upsertEncryptedMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessageOpaqueSummary | null> {
    const message = chatMessageOpaqueContentSchema.parse(input);
    const existing =
      await this.collaborators.getEncryptedMessageByIdempotencyKey(
        ownerId,
        chatId,
        message.idempotencyKey,
      );
    if (!existing) {
      return this.collaborators.appendEncryptedMessage(
        ownerId,
        chatId,
        message,
        attribution,
      );
    }
    if (existing.id !== message.id) {
      throw new Error("Encrypted chat message update targets another row.");
    }
    const result = await this.database
      .update(schema.chatMessages)
      .set({
        role: message.classification.role,
        mode: message.classification.mode,
        protectedContent: message.protectedContent,
        attachmentIds: message.classification.attachmentIds,
        reasoningEffort: message.reasoningEffort,
      })
      .where(eq(schema.chatMessages.id, message.id))
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toEncryptedChatMessage(
      firstOrThrow(result, "updating an encrypted chat message"),
    );
  }

  async getEncryptedMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<ChatMessageOpaqueSummary | null> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toEncryptedChatMessage(rows[0].message) : null;
  }

  async setEncryptedMessageModelRoute(
    ownerId: string,
    messageId: string,
    modelId: string,
    runtime: ModelRuntime,
    reasoning: {
      appliedReasoningEffort: ReasoningEffort | null;
      reasoningAdjusted: boolean;
    } = { appliedReasoningEffort: null, reasoningAdjusted: false },
  ): Promise<ChatMessageOpaqueSummary | null> {
    const rows = await this.database
      .update(schema.chatMessages)
      .set({
        modelId,
        modelRouteId: runtime.routeId,
        providerId: runtime.provider.id,
        providerName: runtime.provider.name,
        providerModelName: runtime.model.name,
        appliedReasoningEffort: reasoning.appliedReasoningEffort,
        reasoningAdjusted: reasoning.reasoningAdjusted,
      })
      .where(
        and(
          eq(schema.chatMessages.id, messageId),
          isNotNull(schema.chatMessages.protectedContent),
          exists(
            this.database
              .select({ id: schema.chats.id })
              .from(schema.chats)
              .where(
                and(
                  eq(schema.chats.id, schema.chatMessages.chatId),
                  eq(schema.chats.ownerId, ownerId),
                ),
              ),
          ),
        ),
      )
      .returning();
    return rows[0] ? toEncryptedChatMessage(rows[0]) : null;
  }

  async appendTaskMessage(
    ownerId: string,
    chatId: string,
    input: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<TaskMessageOpaqueSummary | null> {
    if (attribution?.contextKind === "standalone") {
      throw new Error("Standalone Chats do not support Task messages.");
    }
    const message = taskMessageOpaqueContentSchema.parse(input);
    const chat = await this.database
      .select({
        id: schema.chats.id,
        experience: schema.chats.experience,
        worktreeId: schema.chats.activeWorktreeId,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    if (!chat[0] || chat[0].experience !== "task") return null;
    const worktreeId = requiredProjectChatWorktreeId(chat[0].worktreeId);

    const activeLanes = attribution
      ? await this.database
          .select({
            id: schema.chatExecutionLanes.id,
            worktreeId: schema.chatExecutionLanes.worktreeId,
          })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.id, attribution.executionLaneId),
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, attribution.worktreeId),
            ),
          )
          .limit(1)
      : await this.database
          .select({
            id: schema.chatExecutionLanes.id,
            worktreeId: schema.chatExecutionLanes.worktreeId,
          })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, worktreeId),
              eq(schema.chatExecutionLanes.state, "active"),
            ),
          )
          .limit(1);
    if (attribution && !activeLanes[0]) return null;

    const existing = await this.database
      .select()
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, message.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (
        existing[0].id !== message.id ||
        existing[0].role !== message.classification.role ||
        existing[0].mode !== message.classification.mode ||
        existing[0].reasoningEffort !== message.reasoningEffort ||
        JSON.stringify(existing[0].taskAttachmentIds) !==
          JSON.stringify(message.classification.attachmentIds) ||
        JSON.stringify(existing[0].taskProtectedContent) !==
          JSON.stringify(message.protectedContent)
      ) {
        throw new Error(
          "Encrypted Task message idempotency metadata is inconsistent.",
        );
      }
      return toTaskMessage(existing[0]);
    }

    const result = await this.database
      .insert(schema.chatMessages)
      .values({
        id: message.id,
        chatId,
        worktreeId: attribution?.worktreeId ?? worktreeId,
        executionLaneId: activeLanes[0]?.id ?? null,
        role: message.classification.role,
        mode: message.classification.mode,
        content: null,
        taskProtectedContent: message.protectedContent,
        taskAttachmentIds: message.classification.attachmentIds,
        reasoningEffort: message.reasoningEffort,
        idempotencyKey: message.idempotencyKey,
      })
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toTaskMessage(firstOrThrow(result, "appending a Task message"));
  }

  async upsertTaskMessage(
    ownerId: string,
    chatId: string,
    input: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<TaskMessageOpaqueSummary | null> {
    const message = taskMessageOpaqueContentSchema.parse(input);
    const existing = await this.collaborators.getTaskMessageByIdempotencyKey(
      ownerId,
      chatId,
      message.idempotencyKey,
    );
    if (!existing) {
      return this.collaborators.appendTaskMessage(
        ownerId,
        chatId,
        message,
        attribution,
      );
    }
    if (existing.id !== message.id) {
      throw new Error("Encrypted Task message update targets another row.");
    }
    const result = await this.database
      .update(schema.chatMessages)
      .set({
        role: message.classification.role,
        mode: message.classification.mode,
        taskProtectedContent: message.protectedContent,
        taskAttachmentIds: message.classification.attachmentIds,
        reasoningEffort: message.reasoningEffort,
      })
      .where(eq(schema.chatMessages.id, message.id))
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toTaskMessage(
      firstOrThrow(result, "updating an encrypted Task message"),
    );
  }

  async setTaskMessageModelRoute(
    ownerId: string,
    messageId: string,
    modelId: string,
    runtime: ModelRuntime,
    reasoning: {
      appliedReasoningEffort: ReasoningEffort | null;
      reasoningAdjusted: boolean;
    } = { appliedReasoningEffort: null, reasoningAdjusted: false },
  ): Promise<TaskMessageOpaqueSummary | null> {
    const rows = await this.database
      .update(schema.chatMessages)
      .set({
        modelId,
        modelRouteId: runtime.routeId,
        providerId: runtime.provider.id,
        providerName: runtime.provider.name,
        providerModelName: runtime.model.name,
        appliedReasoningEffort: reasoning.appliedReasoningEffort,
        reasoningAdjusted: reasoning.reasoningAdjusted,
      })
      .where(
        and(
          eq(schema.chatMessages.id, messageId),
          isNotNull(schema.chatMessages.taskProtectedContent),
          exists(
            this.database
              .select({ id: schema.chats.id })
              .from(schema.chats)
              .innerJoin(
                schema.projects,
                and(
                  eq(schema.projects.id, schema.chats.projectId),
                  eq(schema.projects.ownerId, ownerId),
                ),
              )
              .where(eq(schema.chats.id, schema.chatMessages.chatId)),
          ),
        ),
      )
      .returning();
    return rows[0] ? toTaskMessage(rows[0]) : null;
  }

  async getTaskMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<TaskMessageOpaqueSummary | null> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "task"),
        ),
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
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toTaskMessage(rows[0].message) : null;
  }

  async setMessageModelRoute(
    ownerId: string,
    messageId: string,
    modelId: string,
    runtime: ModelRuntime,
    reasoning: {
      appliedReasoningEffort: ReasoningEffort | null;
      reasoningAdjusted: boolean;
    } = { appliedReasoningEffort: null, reasoningAdjusted: false },
  ): Promise<ChatMessage | null> {
    const rows = await this.database
      .update(schema.chatMessages)
      .set({
        modelId,
        modelRouteId: runtime.routeId,
        providerId: runtime.provider.id,
        providerName: runtime.provider.name,
        providerModelName: runtime.model.name,
        appliedReasoningEffort: reasoning.appliedReasoningEffort,
        reasoningAdjusted: reasoning.reasoningAdjusted,
      })
      .where(
        and(
          eq(schema.chatMessages.id, messageId),
          isNotNull(schema.chatMessages.content),
          exists(
            this.database
              .select({ id: schema.chats.id })
              .from(schema.chats)
              .innerJoin(
                schema.projects,
                and(
                  eq(schema.projects.id, schema.chats.projectId),
                  eq(schema.projects.ownerId, ownerId),
                ),
              )
              .where(eq(schema.chats.id, schema.chatMessages.chatId)),
          ),
        ),
      )
      .returning();
    return rows[0] ? toChatMessage(rows[0]) : null;
  }

  async upsertMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate & { idempotencyKey: string },
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessage | null> {
    const existing = await this.collaborators.getMessageByIdempotencyKey(
      ownerId,
      chatId,
      input.idempotencyKey,
    );
    if (!existing) {
      return this.collaborators.appendMessage(
        ownerId,
        chatId,
        input,
        attribution,
      );
    }

    const result = await this.database
      .update(schema.chatMessages)
      .set({
        role: input.role,
        mode: input.mode ?? existing.mode,
        content: input.content,
        reasoningEffort:
          input.reasoningEffort !== undefined
            ? input.reasoningEffort
            : existing.reasoningEffort,
      })
      .where(eq(schema.chatMessages.id, existing.id))
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toChatMessage(firstOrThrow(result, "updating a chat message"));
  }

  async getMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<ChatMessage | null> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
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
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toChatMessage(rows[0].message) : null;
  }
}
