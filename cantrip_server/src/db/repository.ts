import { randomUUID } from "node:crypto";

import type {
  ChatCreate,
  ChatModelUpdate,
  ChatMessage,
  ChatMessageCreate,
  ChatSummary,
  GithubProjectCreate,
  ModelProfileCreate,
  ModelProfileSummary,
  ModelProviderCreate,
  ModelProviderSummary,
  ProjectCloneResult,
  ProjectSummary,
  SettingsBundle,
  ThemePreference,
  UserSettingsUpdate,
  UserSummary,
  WorkerHeartbeat,
  WorkerSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

export const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_OLLAMA_PROVIDER_ID =
  "00000000-0000-0000-0000-000000000010";
export const DEFAULT_MODEL_ID = "00000000-0000-0000-0000-000000000020";
const SERVER_ID_STATE_KEY = "server-id";
const ONLINE_WINDOW_MS = 15_000;

type RepositoryDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type ProjectRow = typeof schema.projects.$inferSelect;
type ProjectSourceRow = typeof schema.projectSources.$inferSelect;

export interface ChatExecutionContext {
  chatId: string;
  cwd: string;
  status: ChatSummary["status"];
  modelId: string | null;
  modelLocked: boolean;
  threadId: string | null;
  workerId: string;
}

export interface ModelRuntime {
  model: {
    id: string;
    name: string;
    reasoningEffort: ModelProfileSummary["reasoningEffort"];
  };
  provider: {
    id: string;
    name: string;
    kind: ModelProviderSummary["kind"];
    baseUrl: string;
    apiKey: string | null;
  };
}

function toISOString(value: Date): string {
  return value.toISOString();
}

function firstOrThrow<T>(rows: T[], operation: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`Database returned no row after ${operation}.`);
  }
  return row;
}

function toProjectSummary(
  project: ProjectRow,
  source: ProjectSourceRow | null = null,
): ProjectSummary {
  const github =
    project.githubRepositoryId &&
    project.githubRepositoryFullName &&
    project.githubRepositoryUrl
      ? {
          repositoryId: project.githubRepositoryId,
          nameWithOwner: project.githubRepositoryFullName,
          url: project.githubRepositoryUrl,
        }
      : null;

  return {
    id: project.id,
    name: project.name,
    github,
    source: source
      ? {
          id: source.id,
          workerId: source.workerId,
          path: source.absolutePath,
          displayPath: source.displayPath,
        }
      : null,
    createdAt: toISOString(project.createdAt),
    updatedAt: toISOString(project.updatedAt),
  };
}

function toChatSummary(chat: typeof schema.chats.$inferSelect): ChatSummary {
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    status: chat.status as ChatSummary["status"],
    activeWorkerId: chat.activeWorkerId,
    modelId: chat.modelId,
    modelLocked: chat.modelLockedAt !== null,
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  };
}

function toWorkerSummary(
  worker: typeof schema.workers.$inferSelect,
): WorkerSummary {
  return {
    workerId: worker.id,
    name: worker.name,
    platform: worker.platform,
    architecture: worker.architecture,
    codexVersion: worker.codexVersion,
    startedAt: toISOString(worker.startedAt),
    lastSeenAt: toISOString(worker.lastSeenAt),
    online: Date.now() - worker.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
  };
}

function toProviderSummary(
  provider: typeof schema.modelProviders.$inferSelect,
): ModelProviderSummary {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind as ModelProviderSummary["kind"],
    baseUrl: provider.baseUrl,
    hasApiKey: provider.apiKey !== null,
    createdAt: toISOString(provider.createdAt),
    updatedAt: toISOString(provider.updatedAt),
  };
}

function toModelSummary(
  model: typeof schema.modelProfiles.$inferSelect,
  providerName: string,
): ModelProfileSummary {
  return {
    id: model.id,
    name: model.name,
    providerId: model.providerId,
    providerName,
    reasoningEffort:
      model.reasoningEffort as ModelProfileSummary["reasoningEffort"],
    createdAt: toISOString(model.createdAt),
    updatedAt: toISOString(model.updatedAt),
  };
}

function toChatMessage(
  message: typeof schema.chatMessages.$inferSelect,
): ChatMessage {
  return {
    id: message.id,
    chatId: message.chatId,
    sequence: message.sequence,
    role: message.role as ChatMessage["role"],
    content: message.content,
    createdAt: toISOString(message.createdAt),
  };
}

export class ServerRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async ensureLocalIdentity(): Promise<UserSummary> {
    const now = new Date();
    const result = await this.database
      .insert(schema.users)
      .values({
        id: LOCAL_USER_ID,
        kind: "anonymous",
        displayName: "Local User",
        email: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.users.id,
        set: { updatedAt: now },
      })
      .returning();
    const user = firstOrThrow(result, "ensuring the local user");

    return {
      id: user.id,
      kind: "anonymous",
      displayName: user.displayName,
      email: user.email,
    };
  }

  async ensureDefaultModelConfiguration(
    ownerId: string,
    modelName: string,
    ollamaBaseUrl: string,
  ): Promise<void> {
    await this.database
      .insert(schema.modelProviders)
      .values({
        id: DEFAULT_OLLAMA_PROVIDER_ID,
        ownerId,
        name: "Ollama",
        kind: "ollama",
        baseUrl: ollamaBaseUrl,
      })
      .onConflictDoNothing({ target: schema.modelProviders.id });
    await this.database
      .insert(schema.modelProfiles)
      .values({
        id: DEFAULT_MODEL_ID,
        ownerId,
        providerId: DEFAULT_OLLAMA_PROVIDER_ID,
        name: modelName,
      })
      .onConflictDoNothing({ target: schema.modelProfiles.id });
    await this.database
      .insert(schema.userSettings)
      .values({
        userId: ownerId,
        theme: "system",
        defaultModelId: DEFAULT_MODEL_ID,
      })
      .onConflictDoNothing({ target: schema.userSettings.userId });
    await this.database.execute(sql`
      update ${schema.chats}
      set model_id = ${DEFAULT_MODEL_ID}, model_locked_at = now()
      where model_id is null
        and exists (
          select 1 from ${schema.chatMessages}
          where ${schema.chatMessages.chatId} = ${schema.chats.id}
            and ${schema.chatMessages.role} = 'user'
        )
    `);
  }

  async getSettings(ownerId: string): Promise<SettingsBundle> {
    const [settingsRows, providerRows, modelRows] = await Promise.all([
      this.database
        .select()
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, ownerId))
        .limit(1),
      this.database
        .select()
        .from(schema.modelProviders)
        .where(eq(schema.modelProviders.ownerId, ownerId))
        .orderBy(asc(schema.modelProviders.name)),
      this.database
        .select({
          model: schema.modelProfiles,
          providerName: schema.modelProviders.name,
        })
        .from(schema.modelProfiles)
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelProfiles.providerId),
        )
        .where(eq(schema.modelProfiles.ownerId, ownerId))
        .orderBy(asc(schema.modelProfiles.name)),
    ]);
    const settings = firstOrThrow(settingsRows, "loading user settings");
    return {
      preferences: {
        theme: settings.theme as ThemePreference,
        defaultModelId: settings.defaultModelId,
      },
      providers: providerRows.map(toProviderSummary),
      models: modelRows.map(({ model, providerName }) =>
        toModelSummary(model, providerName),
      ),
    };
  }

  async updateSettings(
    ownerId: string,
    input: UserSettingsUpdate,
  ): Promise<SettingsBundle | null> {
    if (input.defaultModelId) {
      const model = await this.getModelRuntime(ownerId, input.defaultModelId);
      if (!model) {
        return null;
      }
    }
    await this.database
      .update(schema.userSettings)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(schema.userSettings.userId, ownerId));
    return this.getSettings(ownerId);
  }

  async createModelProvider(
    ownerId: string,
    input: ModelProviderCreate,
  ): Promise<ModelProviderSummary> {
    const result = await this.database
      .insert(schema.modelProviders)
      .values({
        id: randomUUID(),
        ownerId,
        name: input.name,
        kind: input.kind,
        baseUrl: input.baseUrl.replace(/\/$/, ""),
        apiKey: input.apiKey ?? null,
      })
      .returning();
    return toProviderSummary(firstOrThrow(result, "creating a model provider"));
  }

  async deleteModelProvider(ownerId: string, providerId: string) {
    const result = await this.database
      .delete(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .returning({ id: schema.modelProviders.id });
    return Boolean(result[0]);
  }

  async createModelProfile(
    ownerId: string,
    input: ModelProfileCreate,
  ): Promise<ModelProfileSummary | null> {
    const providers = await this.database
      .select()
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, input.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    const provider = providers[0];
    if (!provider) {
      return null;
    }
    const result = await this.database
      .insert(schema.modelProfiles)
      .values({
        id: randomUUID(),
        ownerId,
        providerId: input.providerId,
        name: input.name,
        reasoningEffort: input.reasoningEffort ?? null,
      })
      .returning();
    return toModelSummary(
      firstOrThrow(result, "creating a model profile"),
      provider.name,
    );
  }

  async deleteModelProfile(ownerId: string, modelId: string) {
    const result = await this.database
      .delete(schema.modelProfiles)
      .where(
        and(
          eq(schema.modelProfiles.id, modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .returning({ id: schema.modelProfiles.id });
    return Boolean(result[0]);
  }

  async getModelRuntime(
    ownerId: string,
    modelId: string,
  ): Promise<ModelRuntime | null> {
    const rows = await this.database
      .select({
        model: schema.modelProfiles,
        provider: schema.modelProviders,
      })
      .from(schema.modelProfiles)
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.modelProfiles.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.modelProfiles.id, modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      model: {
        id: row.model.id,
        name: row.model.name,
        reasoningEffort: row.model
          .reasoningEffort as ModelProfileSummary["reasoningEffort"],
      },
      provider: {
        id: row.provider.id,
        name: row.provider.name,
        kind: row.provider.kind as ModelProviderSummary["kind"],
        baseUrl: row.provider.baseUrl,
        apiKey: row.provider.apiKey,
      },
    };
  }

  async getOrCreateServerId(): Promise<string> {
    const existing = await this.database
      .select()
      .from(schema.systemState)
      .where(eq(schema.systemState.key, SERVER_ID_STATE_KEY))
      .limit(1);
    const existingId = (existing[0]?.value as { id?: unknown } | undefined)?.id;

    if (typeof existingId === "string" && existingId.length > 0) {
      return existingId;
    }

    const id = randomUUID();
    await this.database
      .insert(schema.systemState)
      .values({ key: SERVER_ID_STATE_KEY, value: { id } })
      .onConflictDoUpdate({
        target: schema.systemState.key,
        set: { value: { id }, updatedAt: new Date() },
      });
    return id;
  }

  async recordWorker(heartbeat: WorkerHeartbeat): Promise<WorkerSummary> {
    const now = new Date();
    const result = await this.database
      .insert(schema.workers)
      .values({
        id: heartbeat.workerId,
        ownerId: LOCAL_USER_ID,
        name: heartbeat.name,
        platform: heartbeat.platform,
        architecture: heartbeat.architecture,
        codexVersion: heartbeat.codexVersion,
        startedAt: new Date(heartbeat.startedAt),
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.workers.id,
        set: {
          name: heartbeat.name,
          platform: heartbeat.platform,
          architecture: heartbeat.architecture,
          codexVersion: heartbeat.codexVersion,
          startedAt: new Date(heartbeat.startedAt),
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .returning();
    return toWorkerSummary(
      firstOrThrow(result, "recording a worker heartbeat"),
    );
  }

  async listWorkers(ownerId: string): Promise<WorkerSummary[]> {
    const rows = await this.database
      .select()
      .from(schema.workers)
      .where(eq(schema.workers.ownerId, ownerId))
      .orderBy(asc(schema.workers.name));
    return rows.map(toWorkerSummary);
  }

  async onlineWorkerCount(ownerId: string): Promise<number> {
    const workers = await this.listWorkers(ownerId);
    return workers.filter((worker) => worker.online).length;
  }

  async listProjects(ownerId: string): Promise<ProjectSummary[]> {
    const rows = await this.database
      .select({ project: schema.projects, source: schema.projectSources })
      .from(schema.projects)
      .leftJoin(
        schema.projectSources,
        eq(schema.projectSources.projectId, schema.projects.id),
      )
      .where(eq(schema.projects.ownerId, ownerId))
      .orderBy(desc(schema.projects.updatedAt));
    return rows.map(({ project, source }) => toProjectSummary(project, source));
  }

  async hasGithubProject(ownerId: string, repositoryId: string) {
    const rows = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.ownerId, ownerId),
          eq(schema.projects.githubRepositoryId, repositoryId),
        ),
      )
      .limit(1);
    return Boolean(rows[0]);
  }

  async listGithubRepositoryIds(ownerId: string): Promise<Set<string>> {
    const rows = await this.database
      .select({ repositoryId: schema.projects.githubRepositoryId })
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, ownerId));
    return new Set(
      rows.flatMap(({ repositoryId }) =>
        repositoryId === null ? [] : [repositoryId],
      ),
    );
  }

  async createGithubProject(
    ownerId: string,
    input: GithubProjectCreate,
    clone: ProjectCloneResult,
  ): Promise<ProjectSummary> {
    return this.database.transaction(async (transaction) => {
      const projectResult = await transaction
        .insert(schema.projects)
        .values({
          id: randomUUID(),
          ownerId,
          name: input.nameWithOwner.split("/")[1] ?? input.nameWithOwner,
          githubRepositoryId: input.repositoryId,
          githubRepositoryFullName: input.nameWithOwner,
          githubRepositoryUrl: input.url,
        })
        .returning();
      const project = firstOrThrow(projectResult, "creating a GitHub project");

      const sourceResult = await transaction
        .insert(schema.projectSources)
        .values({
          id: randomUUID(),
          projectId: project.id,
          workerId: input.workerId,
          absolutePath: clone.path,
          displayPath: clone.displayPath,
        })
        .returning();
      const source = firstOrThrow(sourceResult, "recording a project source");
      return toProjectSummary(project, source);
    });
  }

  async listChats(ownerId: string, projectId: string): Promise<ChatSummary[]> {
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
      .where(eq(schema.chats.projectId, projectId))
      .orderBy(desc(schema.chats.updatedAt));
    return rows.map(({ chat }) => toChatSummary(chat));
  }

  async createChat(
    ownerId: string,
    projectId: string,
    input: ChatCreate,
  ): Promise<ChatSummary | null> {
    const projectRows = await this.database
      .select({ source: schema.projectSources })
      .from(schema.projects)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const source = projectRows[0]?.source;
    if (!source) {
      return null;
    }

    const result = await this.database
      .insert(schema.chats)
      .values({
        id: randomUUID(),
        projectId,
        title: input.title,
        activeWorkerId: source.workerId,
      })
      .returning();
    const chat = firstOrThrow(result, "creating a chat");
    await this.database.insert(schema.chatRuntimeSessions).values({
      id: randomUUID(),
      chatId: chat.id,
      workerId: source.workerId,
    });
    return toChatSummary(chat);
  }

  async setChatModel(
    ownerId: string,
    chatId: string,
    input: ChatModelUpdate,
  ): Promise<ChatSummary | "locked" | null> {
    const model = await this.getModelRuntime(ownerId, input.modelId);
    if (!model) {
      return null;
    }
    const chats = await this.database
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
    const chat = chats[0]?.chat;
    if (!chat) {
      return null;
    }
    if (chat.modelLockedAt) {
      return "locked";
    }
    const result = await this.database
      .update(schema.chats)
      .set({ modelId: input.modelId, updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId))
      .returning();
    return toChatSummary(firstOrThrow(result, "selecting a chat model"));
  }

  async lockChatModel(chatId: string, modelId: string): Promise<void> {
    await this.database
      .update(schema.chats)
      .set({
        modelId,
        modelLockedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId));
  }

  async getChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionContext | null> {
    const rows = await this.database
      .select({
        chat: schema.chats,
        source: schema.projectSources,
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
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.projectId, schema.projects.id),
      )
      .leftJoin(
        schema.chatRuntimeSessions,
        and(
          eq(schema.chatRuntimeSessions.chatId, schema.chats.id),
          eq(
            schema.chatRuntimeSessions.workerId,
            schema.projectSources.workerId,
          ),
        ),
      )
      .where(eq(schema.chats.id, chatId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      chatId: row.chat.id,
      cwd: row.source.absolutePath,
      modelId: row.chat.modelId,
      modelLocked: row.chat.modelLockedAt !== null,
      status: row.chat.status as ChatSummary["status"],
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.source.workerId,
    };
  }

  async updateChatRuntime(
    chatId: string,
    workerId: string,
    threadId: string,
  ): Promise<void> {
    await this.database
      .insert(schema.chatRuntimeSessions)
      .values({
        id: randomUUID(),
        chatId,
        workerId,
        codexThreadId: threadId,
        status: "ready",
      })
      .onConflictDoUpdate({
        target: [
          schema.chatRuntimeSessions.chatId,
          schema.chatRuntimeSessions.workerId,
        ],
        set: {
          codexThreadId: threadId,
          status: "ready",
          updatedAt: new Date(),
        },
      });
  }

  async setChatStatus(
    chatId: string,
    status: ChatSummary["status"],
  ): Promise<void> {
    await this.database
      .update(schema.chats)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
  }

  async listMessages(ownerId: string, chatId: string): Promise<ChatMessage[]> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.chatMessages.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toChatMessage(message));
  }

  async appendMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate,
  ): Promise<ChatMessage | null> {
    const chat = await this.database
      .select({ id: schema.chats.id })
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
    if (!chat[0]) {
      return null;
    }

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
        role: input.role,
        content: input.content,
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

  async upsertMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate & { idempotencyKey: string },
  ): Promise<ChatMessage | null> {
    const existing = await this.getMessageByIdempotencyKey(
      ownerId,
      chatId,
      input.idempotencyKey,
    );
    if (!existing) {
      return this.appendMessage(ownerId, chatId, input);
    }

    const result = await this.database
      .update(schema.chatMessages)
      .set({ role: input.role, content: input.content })
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
      .innerJoin(schema.chats, eq(schema.chats.id, schema.chatMessages.chatId))
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
