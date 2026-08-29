import {
  chatPlanOpaqueStateSchema,
  encryptedChatPlanWireStateSchema,
} from "@cantrip/protocol";
import type {
  ChatModelConfigurationUpdate,
  ChatModelUpdate,
  ChatPlanOpaqueState,
  ChatWireSummary,
  ContextualChatWireSummary,
  EncryptedChatPlanWireState,
  ModelConfiguration,
  PlanMode,
  ReasoningEffort,
} from "@cantrip/protocol";
import { and, eq, inArray, isNull } from "drizzle-orm";

import * as schema from "../schema.js";
import { ExecutionLaneConflictError } from "./chat-execution-lanes.js";
import {
  chatModelConfiguration,
  toContextualChatWireSummary,
} from "./chat-mappers.js";
import { firstOrThrow, type RepositoryDatabase } from "./database.js";
import type { ModelRuntime } from "./model-runtime.js";

export interface ChatLiveRouting {
  experience: ChatWireSummary["experience"];
  projectId: string | null;
}

export interface ChatConfigurationRepositoryCollaborators {
  getChatPlanWireState(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedChatPlanWireState | null>;
  getModelRuntime(
    ownerId: string,
    modelId: string,
  ): Promise<ModelRuntime | null>;
}

export class ChatConfigurationRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ChatConfigurationRepositoryCollaborators,
  ) {}

  async setChatModel(
    ownerId: string,
    chatId: string,
    input: ChatModelUpdate,
    reasoningEffort?: ReasoningEffort | null,
  ): Promise<ContextualChatWireSummary | null> {
    const model = await this.collaborators.getModelRuntime(
      ownerId,
      input.modelId,
    );
    if (!model) {
      return null;
    }
    const chats = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    const chat = chats[0]?.chat;
    if (!chat) {
      return null;
    }
    const result = await this.database
      .update(schema.chats)
      .set({
        modelId: input.modelId,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId))
      .returning();
    return toContextualChatWireSummary(
      firstOrThrow(result, "selecting a chat model"),
    );
  }

  async getChatModelConfiguration(
    ownerId: string,
    chatId: string,
  ): Promise<ModelConfiguration | null> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    return rows[0] ? chatModelConfiguration(rows[0].chat) : null;
  }

  async setChatModelConfiguration(
    ownerId: string,
    chatId: string,
    input: ChatModelConfigurationUpdate,
  ): Promise<ContextualChatWireSummary | null> {
    if (!input.modelId) return null;

    const modelIds = [
      input.modelId,
      ...(input.subagentModelId ? [input.subagentModelId] : []),
    ];
    const ownedModels = await this.database
      .select({ id: schema.modelProfiles.id })
      .from(schema.modelProfiles)
      .where(
        and(
          eq(schema.modelProfiles.ownerId, ownerId),
          inArray(schema.modelProfiles.id, modelIds),
        ),
      );
    if (
      new Set(ownedModels.map(({ id }) => id)).size !== new Set(modelIds).size
    )
      return null;
    const chats = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (!chats[0]) return null;
    if (
      chats[0].contextKind === "standalone" &&
      (input.customSubagentModel ||
        input.subagentModelId !== null ||
        input.subagentReasoningEffort !== null)
    ) {
      throw new ExecutionLaneConflictError(
        "Standalone Chat does not support subagent configuration.",
      );
    }

    const result = await this.database
      .update(schema.chats)
      .set({
        modelId: input.modelId,
        reasoningEffort: input.reasoningEffort,
        customSubagentModel: input.customSubagentModel,
        subagentModelId: input.subagentModelId,
        subagentReasoningEffort: input.subagentReasoningEffort,
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .returning();
    return result[0] ? toContextualChatWireSummary(result[0]) : null;
  }

  async setChatReasoningEffort(
    ownerId: string,
    chatId: string,
    reasoningEffort: ReasoningEffort | null,
  ): Promise<ContextualChatWireSummary | null> {
    const result = await this.database
      .update(schema.chats)
      .set({ reasoningEffort, updatedAt: new Date() })
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .returning();
    return result[0] ? toContextualChatWireSummary(result[0]) : null;
  }

  async getModelReasoningDefault(
    ownerId: string,
    modelId: string,
  ): Promise<ReasoningEffort | null | undefined> {
    const rows = await this.database
      .select({
        defaultReasoningEffort: schema.modelProfiles.defaultReasoningEffort,
      })
      .from(schema.modelProfiles)
      .where(
        and(
          eq(schema.modelProfiles.id, modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0]?.defaultReasoningEffort ?? (rows[0] ? null : undefined);
  }

  async setChatReasoningEffortAndRememberDefault(
    ownerId: string,
    chatId: string,
    modelId: string,
    reasoningEffort: ReasoningEffort | null,
  ): Promise<ContextualChatWireSummary | null> {
    return this.database.transaction(async (transaction) => {
      const ownedModels = await transaction
        .select({ id: schema.modelProfiles.id })
        .from(schema.modelProfiles)
        .where(
          and(
            eq(schema.modelProfiles.id, modelId),
            eq(schema.modelProfiles.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!ownedModels[0]) return null;

      const result = await transaction
        .update(schema.chats)
        .set({
          modelId,
          reasoningEffort,
          updatedAt: new Date(),
        })
        .where(
          and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
        )
        .returning();
      if (!result[0]) return null;

      return toContextualChatWireSummary(result[0]);
    });
  }

  async setChatPermissionProfile(
    ownerId: string,
    chatId: string,
    permissionProfileId: string | null,
  ): Promise<ContextualChatWireSummary | null> {
    const chats = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (!chats[0]) return null;
    const result = await this.database
      .update(schema.chats)
      .set({ permissionProfileId, updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId))
      .returning();
    return result[0] ? toContextualChatWireSummary(result[0]) : null;
  }

  async getEncryptedChatPlanState(
    ownerId: string,
    chatId: string,
  ): Promise<ChatPlanOpaqueState | null> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    const chat = rows[0]?.chat;
    return chat?.protectedPlan
      ? chatPlanOpaqueStateSchema.parse(chat.protectedPlan)
      : null;
  }

  async getChatPlanWireState(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedChatPlanWireState | null> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    const chat = rows[0]?.chat;
    return chat
      ? encryptedChatPlanWireStateSchema.parse({
          kind: "chat-encrypted",
          chatId: chat.id,
          mode: chat.planMode,
          hasQuestion: chat.hasPendingPlanQuestion,
          state: chat.protectedPlan,
        })
      : null;
  }

  async updateChatPlanMode(
    ownerId: string,
    chatId: string,
    mode: PlanMode,
  ): Promise<EncryptedChatPlanWireState | null> {
    const current = await this.collaborators.getChatPlanWireState(
      ownerId,
      chatId,
    );
    if (!current) return null;
    const contexts = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (contexts[0]?.contextKind === "standalone" && mode !== "default") {
      throw new ExecutionLaneConflictError(
        "Standalone Chat supports only default conversation mode.",
      );
    }
    await this.database
      .update(schema.chats)
      .set({
        planMode: mode,
        ...(mode === "default"
          ? { protectedPlan: null, hasPendingPlanQuestion: false }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId));
    return this.collaborators.getChatPlanWireState(ownerId, chatId);
  }

  async updateEncryptedChatPlanState(
    chatId: string,
    state: ChatPlanOpaqueState,
  ): Promise<void> {
    const parsed = chatPlanOpaqueStateSchema.parse(state);
    await this.database
      .update(schema.chats)
      .set({
        protectedPlan: parsed,
        hasPendingPlanQuestion: parsed.classification.hasQuestion,
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId));
  }

  async getChatLiveRouting(
    ownerId: string,
    chatId: string,
  ): Promise<ChatLiveRouting | null> {
    const rows = await this.database
      .select({
        experience: schema.chats.experience,
        projectId: schema.chats.projectId,
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
    const row = rows[0];
    return row
      ? {
          experience: row.experience as ChatWireSummary["experience"],
          projectId: row.projectId,
        }
      : null;
  }
}
