import { randomUUID } from "node:crypto";

import { normalizeResponsesBaseUrl } from "@cantrip/protocol";
import type {
  BrowserCreate,
  BrowserSummary,
  BrowserUpdate,
  ChatCreate,
  ChatModelUpdate,
  ChatMessage,
  ChatMessageCreate,
  ChatSummary,
  ChatUpdate,
  ExplorerCreate,
  ExplorerSummary,
  ExplorerUpdate,
  GithubProjectCreate,
  ModelProfileCreate,
  ModelProfileSummary,
  ModelProfileUpdate,
  ModelProviderCreate,
  ModelProviderSummary,
  ModelProviderUpdate,
  OrderedIds,
  ProjectCloneResult,
  ProjectSummary,
  SettingsBundle,
  TerminalCreate,
  TerminalSummary,
  TerminalUpdate,
  ThemePreference,
  UserSettingsUpdate,
  UserSummary,
  WorkerHeartbeat,
  WorkerSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
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
  threadId: string | null;
  workerId: string;
}

export interface TerminalExecutionContext {
  cwd: string;
  status: TerminalSummary["status"];
  terminalId: string;
  workerId: string;
}

export interface ProjectRemovalContext {
  cwd: string;
  terminalIds: string[];
  workerId: string;
}

export interface ExplorerExecutionContext {
  explorerId: string;
  root: string;
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
    position: project.position,
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
    position: chat.position,
    status: chat.status as ChatSummary["status"],
    activeWorkerId: chat.activeWorkerId,
    modelId: chat.modelId,
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  };
}

function toTerminalSummary(
  terminal: typeof schema.terminals.$inferSelect,
): TerminalSummary {
  return {
    id: terminal.id,
    projectId: terminal.projectId,
    title: terminal.title,
    position: terminal.position,
    status: terminal.status as TerminalSummary["status"],
    activeWorkerId: terminal.activeWorkerId,
    linkedChatId: terminal.linkedChatId,
    createdAt: toISOString(terminal.createdAt),
    updatedAt: toISOString(terminal.updatedAt),
  };
}

function toExplorerSummary(
  explorer: typeof schema.explorers.$inferSelect,
): ExplorerSummary {
  return {
    id: explorer.id,
    projectId: explorer.projectId,
    title: explorer.title,
    position: explorer.position,
    activeWorkerId: explorer.activeWorkerId,
    createdAt: toISOString(explorer.createdAt),
    updatedAt: toISOString(explorer.updatedAt),
  };
}

function toBrowserSummary(
  browser: typeof schema.browsers.$inferSelect,
): BrowserSummary {
  return {
    id: browser.id,
    projectId: browser.projectId,
    title: browser.title,
    position: browser.position,
    url: browser.url,
    createdAt: toISOString(browser.createdAt),
    updatedAt: toISOString(browser.updatedAt),
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
        highContrast: false,
        defaultModelId: DEFAULT_MODEL_ID,
      })
      .onConflictDoNothing({ target: schema.userSettings.userId });
    await this.database.execute(sql`
      update ${schema.chats}
      set model_id = ${DEFAULT_MODEL_ID}
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
        highContrast: settings.highContrast,
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
        baseUrl: normalizeResponsesBaseUrl(input.baseUrl),
        apiKey: input.apiKey ?? null,
      })
      .returning();
    return toProviderSummary(firstOrThrow(result, "creating a model provider"));
  }

  async getModelProvider(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toProviderSummary(rows[0]) : null;
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

  async updateModelProvider(
    ownerId: string,
    providerId: string,
    input: ModelProviderUpdate,
  ): Promise<ModelProviderSummary | null> {
    const result = await this.database
      .update(schema.modelProviders)
      .set({
        name: input.name,
        kind: input.kind,
        baseUrl: normalizeResponsesBaseUrl(input.baseUrl),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .returning();
    const provider = result[0];
    return provider ? toProviderSummary(provider) : null;
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

  async updateModelProfile(
    ownerId: string,
    modelId: string,
    input: ModelProfileUpdate,
  ): Promise<ModelProfileSummary | null> {
    const providers = await this.database
      .select({ name: schema.modelProviders.name })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, input.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    const provider = providers[0];
    if (!provider) return null;

    const result = await this.database
      .update(schema.modelProfiles)
      .set({
        name: input.name,
        providerId: input.providerId,
        reasoningEffort: input.reasoningEffort ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.modelProfiles.id, modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .returning();
    const model = result[0];
    return model ? toModelSummary(model, provider.name) : null;
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
      .orderBy(asc(schema.projects.position), asc(schema.projects.createdAt));
    return rows.map(({ project, source }) => toProjectSummary(project, source));
  }

  async getProjectSource(ownerId: string, projectId: string) {
    const rows = await this.database
      .select({
        workerId: schema.projectSources.workerId,
        cwd: schema.projectSources.absolutePath,
      })
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
    return rows[0] ?? null;
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
      const lastProjects = await transaction
        .select({ position: schema.projects.position })
        .from(schema.projects)
        .where(eq(schema.projects.ownerId, ownerId))
        .orderBy(desc(schema.projects.position))
        .limit(1);
      const projectResult = await transaction
        .insert(schema.projects)
        .values({
          id: randomUUID(),
          ownerId,
          name: input.nameWithOwner.split("/")[1] ?? input.nameWithOwner,
          position: (lastProjects[0]?.position ?? -1) + 1,
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

  async getProjectRemovalContext(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectRemovalContext | null> {
    const source = await this.getProjectSource(ownerId, projectId);
    if (!source) return null;
    const terminals = await this.database
      .select({ id: schema.terminals.id })
      .from(schema.terminals)
      .where(eq(schema.terminals.projectId, projectId));
    return {
      ...source,
      terminalIds: terminals.map(({ id }) => id),
    };
  }

  async deleteProject(ownerId: string, projectId: string): Promise<boolean> {
    const deleted = await this.database
      .delete(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .returning({ id: schema.projects.id });
    return deleted.length === 1;
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
      .orderBy(asc(schema.chats.position), asc(schema.chats.createdAt));
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

    const [lastChats, lastTerminals, lastExplorers, lastBrowsers] =
      await Promise.all([
        this.database
          .select({ position: schema.chats.position })
          .from(schema.chats)
          .where(eq(schema.chats.projectId, projectId))
          .orderBy(desc(schema.chats.position))
          .limit(1),
        this.database
          .select({ position: schema.explorers.position })
          .from(schema.explorers)
          .where(eq(schema.explorers.projectId, projectId))
          .orderBy(desc(schema.explorers.position))
          .limit(1),
        this.database
          .select({ position: schema.terminals.position })
          .from(schema.terminals)
          .where(eq(schema.terminals.projectId, projectId))
          .orderBy(desc(schema.terminals.position))
          .limit(1),
        this.database
          .select({ position: schema.browsers.position })
          .from(schema.browsers)
          .where(eq(schema.browsers.projectId, projectId))
          .orderBy(desc(schema.browsers.position))
          .limit(1),
      ]);
    const result = await this.database
      .insert(schema.chats)
      .values({
        id: randomUUID(),
        projectId,
        title: input.title,
        position:
          Math.max(
            lastChats[0]?.position ?? -1,
            lastTerminals[0]?.position ?? -1,
            lastExplorers[0]?.position ?? -1,
            lastBrowsers[0]?.position ?? -1,
          ) + 1,
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

  async listTerminals(
    ownerId: string,
    projectId: string,
  ): Promise<TerminalSummary[]> {
    const rows = await this.database
      .select({ terminal: schema.terminals })
      .from(schema.terminals)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.terminals.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.terminals.projectId, projectId))
      .orderBy(asc(schema.terminals.position), asc(schema.terminals.createdAt));
    return rows.map(({ terminal }) => toTerminalSummary(terminal));
  }

  async createTerminal(
    ownerId: string,
    projectId: string,
    input: TerminalCreate,
  ): Promise<TerminalSummary | null> {
    const rows = await this.database
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
    const source = rows[0]?.source;
    if (!source) return null;

    const [lastChats, lastTerminals, lastExplorers, lastBrowsers] =
      await Promise.all([
        this.database
          .select({ position: schema.chats.position })
          .from(schema.chats)
          .where(eq(schema.chats.projectId, projectId))
          .orderBy(desc(schema.chats.position))
          .limit(1),
        this.database
          .select({ position: schema.explorers.position })
          .from(schema.explorers)
          .where(eq(schema.explorers.projectId, projectId))
          .orderBy(desc(schema.explorers.position))
          .limit(1),
        this.database
          .select({ position: schema.terminals.position })
          .from(schema.terminals)
          .where(eq(schema.terminals.projectId, projectId))
          .orderBy(desc(schema.terminals.position))
          .limit(1),
        this.database
          .select({ position: schema.browsers.position })
          .from(schema.browsers)
          .where(eq(schema.browsers.projectId, projectId))
          .orderBy(desc(schema.browsers.position))
          .limit(1),
      ]);
    const result = await this.database
      .insert(schema.terminals)
      .values({
        id: randomUUID(),
        projectId,
        title: input.title,
        position:
          Math.max(
            lastChats[0]?.position ?? -1,
            lastTerminals[0]?.position ?? -1,
            lastExplorers[0]?.position ?? -1,
            lastBrowsers[0]?.position ?? -1,
          ) + 1,
        activeWorkerId: source.workerId,
      })
      .returning();
    return toTerminalSummary(firstOrThrow(result, "creating a terminal"));
  }

  async getOrCreateChatConsole(
    ownerId: string,
    chatId: string,
  ): Promise<TerminalSummary | null> {
    const rows = await this.database
      .select({ chat: schema.chats, source: schema.projectSources })
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
      .where(eq(schema.chats.id, chatId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const existing = await this.database
      .select()
      .from(schema.terminals)
      .where(eq(schema.terminals.linkedChatId, chatId))
      .limit(1);
    if (existing[0]) return toTerminalSummary(existing[0]);

    const result = await this.database
      .insert(schema.terminals)
      .values({
        id: randomUUID(),
        projectId: row.chat.projectId,
        title: "Codex console",
        position: row.chat.position,
        status: "running",
        activeWorkerId: row.source.workerId,
        linkedChatId: row.chat.id,
      })
      .returning();
    return toTerminalSummary(firstOrThrow(result, "creating a chat console"));
  }

  async updateTerminal(
    ownerId: string,
    terminalId: string,
    input: TerminalUpdate,
  ): Promise<TerminalSummary | null> {
    const owned = await this.getTerminalExecutionContext(ownerId, terminalId);
    if (!owned) return null;
    const result = await this.database
      .update(schema.terminals)
      .set({ title: input.title, updatedAt: new Date() })
      .where(eq(schema.terminals.id, terminalId))
      .returning();
    return result[0] ? toTerminalSummary(result[0]) : null;
  }

  async listExplorers(
    ownerId: string,
    projectId: string,
  ): Promise<ExplorerSummary[]> {
    const rows = await this.database
      .select({ explorer: schema.explorers })
      .from(schema.explorers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.explorers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.explorers.projectId, projectId))
      .orderBy(asc(schema.explorers.position), asc(schema.explorers.createdAt));
    return rows.map(({ explorer }) => toExplorerSummary(explorer));
  }

  async createExplorer(
    ownerId: string,
    projectId: string,
    input: ExplorerCreate,
  ): Promise<ExplorerSummary | null> {
    const source = await this.getProjectSource(ownerId, projectId);
    if (!source) return null;
    const [lastChats, lastTerminals, lastExplorers, lastBrowsers] =
      await Promise.all([
        this.database
          .select({ position: schema.chats.position })
          .from(schema.chats)
          .where(eq(schema.chats.projectId, projectId))
          .orderBy(desc(schema.chats.position))
          .limit(1),
        this.database
          .select({ position: schema.terminals.position })
          .from(schema.terminals)
          .where(eq(schema.terminals.projectId, projectId))
          .orderBy(desc(schema.terminals.position))
          .limit(1),
        this.database
          .select({ position: schema.explorers.position })
          .from(schema.explorers)
          .where(eq(schema.explorers.projectId, projectId))
          .orderBy(desc(schema.explorers.position))
          .limit(1),
        this.database
          .select({ position: schema.browsers.position })
          .from(schema.browsers)
          .where(eq(schema.browsers.projectId, projectId))
          .orderBy(desc(schema.browsers.position))
          .limit(1),
      ]);
    const result = await this.database
      .insert(schema.explorers)
      .values({
        id: randomUUID(),
        projectId,
        title: input.title,
        position:
          Math.max(
            lastChats[0]?.position ?? -1,
            lastTerminals[0]?.position ?? -1,
            lastExplorers[0]?.position ?? -1,
            lastBrowsers[0]?.position ?? -1,
          ) + 1,
        activeWorkerId: source.workerId,
      })
      .returning();
    return toExplorerSummary(firstOrThrow(result, "creating an explorer"));
  }

  async getExplorerExecutionContext(
    ownerId: string,
    explorerId: string,
  ): Promise<ExplorerExecutionContext | null> {
    const rows = await this.database
      .select({ explorer: schema.explorers, source: schema.projectSources })
      .from(schema.explorers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.explorers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.projectId, schema.projects.id),
      )
      .where(eq(schema.explorers.id, explorerId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          explorerId: row.explorer.id,
          root: row.source.absolutePath,
          workerId: row.explorer.activeWorkerId,
        }
      : null;
  }

  async updateExplorer(
    ownerId: string,
    explorerId: string,
    input: ExplorerUpdate,
  ): Promise<ExplorerSummary | null> {
    if (!(await this.getExplorerExecutionContext(ownerId, explorerId)))
      return null;
    const result = await this.database
      .update(schema.explorers)
      .set({ title: input.title, updatedAt: new Date() })
      .where(eq(schema.explorers.id, explorerId))
      .returning();
    return result[0] ? toExplorerSummary(result[0]) : null;
  }

  async deleteExplorer(ownerId: string, explorerId: string): Promise<boolean> {
    if (!(await this.getExplorerExecutionContext(ownerId, explorerId)))
      return false;
    const result = await this.database
      .delete(schema.explorers)
      .where(eq(schema.explorers.id, explorerId))
      .returning({ id: schema.explorers.id });
    return result.length === 1;
  }

  async listBrowsers(
    ownerId: string,
    projectId: string,
  ): Promise<BrowserSummary[]> {
    const rows = await this.database
      .select({ browser: schema.browsers })
      .from(schema.browsers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.browsers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.browsers.projectId, projectId))
      .orderBy(asc(schema.browsers.position), asc(schema.browsers.createdAt));
    return rows.map(({ browser }) => toBrowserSummary(browser));
  }

  async createBrowser(
    ownerId: string,
    projectId: string,
    input: BrowserCreate,
  ): Promise<BrowserSummary | null> {
    if (!(await this.getProjectSource(ownerId, projectId))) return null;
    const [lastChats, lastTerminals, lastExplorers, lastBrowsers] =
      await Promise.all([
        this.database
          .select({ position: schema.chats.position })
          .from(schema.chats)
          .where(eq(schema.chats.projectId, projectId))
          .orderBy(desc(schema.chats.position))
          .limit(1),
        this.database
          .select({ position: schema.terminals.position })
          .from(schema.terminals)
          .where(eq(schema.terminals.projectId, projectId))
          .orderBy(desc(schema.terminals.position))
          .limit(1),
        this.database
          .select({ position: schema.explorers.position })
          .from(schema.explorers)
          .where(eq(schema.explorers.projectId, projectId))
          .orderBy(desc(schema.explorers.position))
          .limit(1),
        this.database
          .select({ position: schema.browsers.position })
          .from(schema.browsers)
          .where(eq(schema.browsers.projectId, projectId))
          .orderBy(desc(schema.browsers.position))
          .limit(1),
      ]);
    const result = await this.database
      .insert(schema.browsers)
      .values({
        id: randomUUID(),
        projectId,
        title: input.title,
        position:
          Math.max(
            lastChats[0]?.position ?? -1,
            lastTerminals[0]?.position ?? -1,
            lastExplorers[0]?.position ?? -1,
            lastBrowsers[0]?.position ?? -1,
          ) + 1,
      })
      .returning();
    return toBrowserSummary(firstOrThrow(result, "creating a browser"));
  }

  async updateBrowser(
    ownerId: string,
    browserId: string,
    input: BrowserUpdate,
  ): Promise<BrowserSummary | null> {
    if (!(await this.browserIsOwnedBy(ownerId, browserId))) return null;
    const result = await this.database
      .update(schema.browsers)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(schema.browsers.id, browserId))
      .returning();
    return result[0] ? toBrowserSummary(result[0]) : null;
  }

  async deleteBrowser(ownerId: string, browserId: string): Promise<boolean> {
    if (!(await this.browserIsOwnedBy(ownerId, browserId))) return false;
    const result = await this.database
      .delete(schema.browsers)
      .where(eq(schema.browsers.id, browserId))
      .returning({ id: schema.browsers.id });
    return result.length === 1;
  }

  private async browserIsOwnedBy(
    ownerId: string,
    browserId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.browsers.id })
      .from(schema.browsers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.browsers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.browsers.id, browserId))
      .limit(1);
    return rows.length === 1;
  }

  async deleteTerminal(
    ownerId: string,
    terminalId: string,
  ): Promise<TerminalExecutionContext | null> {
    const context = await this.getTerminalExecutionContext(ownerId, terminalId);
    if (!context) return null;
    await this.database
      .delete(schema.terminals)
      .where(eq(schema.terminals.id, terminalId));
    return context;
  }

  async getTerminalExecutionContext(
    ownerId: string,
    terminalId: string,
  ): Promise<TerminalExecutionContext | null> {
    const rows = await this.database
      .select({ terminal: schema.terminals, source: schema.projectSources })
      .from(schema.terminals)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.terminals.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.projectId, schema.projects.id),
      )
      .where(eq(schema.terminals.id, terminalId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          terminalId: row.terminal.id,
          workerId: row.terminal.activeWorkerId,
          cwd: row.source.absolutePath,
          status: row.terminal.status as TerminalSummary["status"],
        }
      : null;
  }

  async setTerminalStatus(
    terminalId: string,
    status: TerminalSummary["status"],
  ): Promise<void> {
    await this.database
      .update(schema.terminals)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.terminals.id, terminalId));
  }

  async updateChat(
    ownerId: string,
    chatId: string,
    input: ChatUpdate,
  ): Promise<ChatSummary | null> {
    const owned = await this.database
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
    if (!owned[0]) return null;
    const result = await this.database
      .update(schema.chats)
      .set({ title: input.title, updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId))
      .returning();
    return result[0] ? toChatSummary(result[0]) : null;
  }

  async deleteChat(
    ownerId: string,
    chatId: string,
  ): Promise<boolean | "running"> {
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
    if (!chat) return false;
    if (chat.status === "running") return "running";
    await this.database.delete(schema.chats).where(eq(schema.chats.id, chatId));
    return true;
  }

  async forkChat(
    ownerId: string,
    chatId: string,
    messageId?: string,
  ): Promise<ChatSummary | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ chat: schema.chats, source: schema.projectSources })
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
        .where(eq(schema.chats.id, chatId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;

      let throughSequence: number | null = null;
      if (messageId) {
        const selected = await transaction
          .select({ sequence: schema.chatMessages.sequence })
          .from(schema.chatMessages)
          .where(
            and(
              eq(schema.chatMessages.id, messageId),
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
      const [lastChats, lastTerminals, lastExplorers, lastBrowsers] =
        await Promise.all([
          transaction
            .select({ position: schema.chats.position })
            .from(schema.chats)
            .where(eq(schema.chats.projectId, row.chat.projectId))
            .orderBy(desc(schema.chats.position))
            .limit(1),
          transaction
            .select({ position: schema.explorers.position })
            .from(schema.explorers)
            .where(eq(schema.explorers.projectId, row.chat.projectId))
            .orderBy(desc(schema.explorers.position))
            .limit(1),
          transaction
            .select({ position: schema.terminals.position })
            .from(schema.terminals)
            .where(eq(schema.terminals.projectId, row.chat.projectId))
            .orderBy(desc(schema.terminals.position))
            .limit(1),
          transaction
            .select({ position: schema.browsers.position })
            .from(schema.browsers)
            .where(eq(schema.browsers.projectId, row.chat.projectId))
            .orderBy(desc(schema.browsers.position))
            .limit(1),
        ]);
      const chatResult = await transaction
        .insert(schema.chats)
        .values({
          id: randomUUID(),
          projectId: row.chat.projectId,
          title: `${row.chat.title} (fork)`,
          position:
            Math.max(
              lastChats[0]?.position ?? -1,
              lastTerminals[0]?.position ?? -1,
              lastExplorers[0]?.position ?? -1,
              lastBrowsers[0]?.position ?? -1,
            ) + 1,
          activeWorkerId: row.source.workerId,
          modelId: row.chat.modelId,
        })
        .returning();
      const fork = firstOrThrow(chatResult, "forking a chat");
      await transaction.insert(schema.chatRuntimeSessions).values({
        id: randomUUID(),
        chatId: fork.id,
        workerId: row.source.workerId,
      });
      if (sourceMessages.length > 0) {
        await transaction.insert(schema.chatMessages).values(
          sourceMessages.map((message) => ({
            id: randomUUID(),
            chatId: fork.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          })),
        );
      }
      return toChatSummary(fork);
    });
  }

  async reorderProjects(ownerId: string, input: OrderedIds): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, ownerId));
    if (
      rows.length !== input.ids.length ||
      rows.some(({ id }) => !input.ids.includes(id))
    )
      return false;
    await this.database.transaction(async (transaction) => {
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.projects)
          .set({ position })
          .where(eq(schema.projects.id, id));
      }
    });
    return true;
  }

  async reorderProjectTabs(
    ownerId: string,
    projectId: string,
    input: OrderedIds,
  ): Promise<boolean> {
    const [chatRows, terminalRows, explorerRows, browserRows] =
      await Promise.all([
        this.database
          .select({ id: schema.chats.id })
          .from(schema.chats)
          .innerJoin(
            schema.projects,
            and(
              eq(schema.projects.id, projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .where(eq(schema.chats.projectId, projectId)),
        this.database
          .select({ id: schema.terminals.id })
          .from(schema.terminals)
          .innerJoin(
            schema.projects,
            and(
              eq(schema.projects.id, projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .where(
            and(
              eq(schema.terminals.projectId, projectId),
              isNull(schema.terminals.linkedChatId),
            ),
          ),
        this.database
          .select({ id: schema.explorers.id })
          .from(schema.explorers)
          .innerJoin(
            schema.projects,
            and(
              eq(schema.projects.id, projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .where(eq(schema.explorers.projectId, projectId)),
        this.database
          .select({ id: schema.browsers.id })
          .from(schema.browsers)
          .innerJoin(
            schema.projects,
            and(
              eq(schema.projects.id, projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .where(eq(schema.browsers.projectId, projectId)),
      ]);
    const expected = new Set([
      ...chatRows.map(({ id }) => `chat:${id}`),
      ...terminalRows.map(({ id }) => `terminal:${id}`),
      ...explorerRows.map(({ id }) => `explorer:${id}`),
      ...browserRows.map(({ id }) => `browser:${id}`),
    ]);
    if (
      expected.size !== input.ids.length ||
      input.ids.some((id) => !expected.has(id))
    ) {
      return false;
    }
    await this.database.transaction(async (transaction) => {
      for (const [position, taggedId] of input.ids.entries()) {
        const separator = taggedId.indexOf(":");
        const kind = taggedId.slice(0, separator);
        const id = taggedId.slice(separator + 1);
        if (kind === "chat") {
          await transaction
            .update(schema.chats)
            .set({ position })
            .where(eq(schema.chats.id, id));
        } else if (kind === "terminal") {
          await transaction
            .update(schema.terminals)
            .set({ position })
            .where(eq(schema.terminals.id, id));
        } else if (kind === "explorer") {
          await transaction
            .update(schema.explorers)
            .set({ position })
            .where(eq(schema.explorers.id, id));
        } else {
          await transaction
            .update(schema.browsers)
            .set({ position })
            .where(eq(schema.browsers.id, id));
        }
      }
    });
    return true;
  }

  async setChatModel(
    ownerId: string,
    chatId: string,
    input: ChatModelUpdate,
  ): Promise<ChatSummary | null> {
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
    const result = await this.database
      .update(schema.chats)
      .set({ modelId: input.modelId, updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId))
      .returning();
    return toChatSummary(firstOrThrow(result, "selecting a chat model"));
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
