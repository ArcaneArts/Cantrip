import { randomUUID } from "node:crypto";

import { normalizeResponsesBaseUrl } from "@cantrip/protocol";
import type {
  BrowserCreate,
  BrowserSummary,
  BrowserUpdate,
  ChatCreate,
  ChatExecutionLaneSummary,
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
  ModelRouteSummary,
  OrderedIds,
  QueuedPrompt,
  QueuedPromptCreate,
  QueuedPromptOrder,
  QueuedPromptUpdate,
  RemoteSurfaceCreate,
  RemoteSurfaceStatus,
  RemoteSurfaceSummary,
  RemoteSurfaceUpdate,
  ProjectCloneResult,
  ProjectSummary,
  ProjectWorktreeSummary,
  ProjectViewCreate,
  ProjectViewSummary,
  ProjectViewUpdate,
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
export const DEFAULT_MODEL_ROUTE_ID = "00000000-0000-0000-0000-000000000021";
const SERVER_ID_STATE_KEY = "server-id";
const ONLINE_WINDOW_MS = 15_000;

type RepositoryDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type ProjectRow = typeof schema.projects.$inferSelect;
type ProjectSourceRow = typeof schema.projectSources.$inferSelect;
type ProjectWorktreeRow = typeof schema.projectWorktrees.$inferSelect;

export interface ChatExecutionContext {
  chatId: string;
  cwd: string;
  status: ChatSummary["status"];
  modelId: string | null;
  modelRouteId: string | null;
  threadId: string | null;
  workerId: string;
  worktreeId: string;
}

export interface TerminalExecutionContext {
  cwd: string;
  linkedChatId: string | null;
  status: TerminalSummary["status"];
  terminalId: string;
  workerId: string;
  worktreeId: string;
}

export interface ProjectRemovalContext {
  cwd: string | null;
  setupStatus: ProjectSummary["setupStatus"];
  terminalIds: string[];
  workerId: string | null;
}

export interface GithubProjectExecutionContext {
  nameWithOwner: string;
  url: string;
  workerId: string;
}

export interface ExplorerExecutionContext {
  explorerId: string;
  root: string;
  workerId: string;
}

export interface RemoteSurfaceExecutionContext {
  surface: RemoteSurfaceSummary;
  workerId: string;
}

export interface ModelRuntime {
  routeId: string;
  model: {
    id: string;
    routeId: string;
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
    setupStatus: project.setupStatus as ProjectSummary["setupStatus"],
    setupError: project.setupError,
    worktreePolicy: project.worktreePolicy as ProjectSummary["worktreePolicy"],
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

function toProjectWorktreeSummary(
  worktree: ProjectWorktreeRow,
  projectId: string,
): ProjectWorktreeSummary {
  return {
    id: worktree.id,
    projectSourceId: worktree.projectSourceId,
    projectId,
    workerId: worktree.workerId,
    name: worktree.name,
    path: worktree.absolutePath,
    displayPath: worktree.displayPath,
    isPrimary: worktree.isPrimary,
    isDefault: worktree.isDefault,
    origin: worktree.origin as ProjectWorktreeSummary["origin"],
    lifecycleState:
      worktree.lifecycleState as ProjectWorktreeSummary["lifecycleState"],
    branch: worktree.branch,
    head: worktree.head,
    detached: worktree.detached,
    locked: worktree.locked,
    lockReason: worktree.lockReason,
    lastScannedAt: worktree.lastScannedAt
      ? toISOString(worktree.lastScannedAt)
      : null,
    createdAt: toISOString(worktree.createdAt),
    updatedAt: toISOString(worktree.updatedAt),
  };
}

function toChatExecutionLaneSummary(
  lane: typeof schema.chatExecutionLanes.$inferSelect,
): ChatExecutionLaneSummary {
  return {
    id: lane.id,
    chatId: lane.chatId,
    worktreeId: lane.worktreeId,
    workerId: lane.workerId,
    acquiringActor:
      lane.acquiringActor as ChatExecutionLaneSummary["acquiringActor"],
    purpose: lane.purpose,
    state: lane.state as ChatExecutionLaneSummary["state"],
    baseRevision: lane.baseRevision,
    startingHead: lane.startingHead,
    runtimeSessionId: lane.runtimeSessionId,
    codexThreadId: lane.codexThreadId,
    createdAt: toISOString(lane.createdAt),
    activatedAt: lane.activatedAt ? toISOString(lane.activatedAt) : null,
    releasedAt: lane.releasedAt ? toISOString(lane.releasedAt) : null,
    updatedAt: toISOString(lane.updatedAt),
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
    activeWorktreeId: chat.activeWorktreeId,
    worktreeMode: chat.worktreeMode as ChatSummary["worktreeMode"],
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
    worktreeId: terminal.worktreeId,
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
    worktreeId: explorer.worktreeId,
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

function toProjectViewSummary(
  view: typeof schema.projectViews.$inferSelect,
): ProjectViewSummary {
  return {
    id: view.id,
    projectId: view.projectId,
    title: view.title,
    kind: view.kind as ProjectViewSummary["kind"],
    worktreeId: view.worktreeId,
    position: view.position,
    createdAt: toISOString(view.createdAt),
    updatedAt: toISOString(view.updatedAt),
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
    remoteSurfaces: worker.remoteSurfaceCapabilities,
    startedAt: toISOString(worker.startedAt),
    lastSeenAt: toISOString(worker.lastSeenAt),
    online: Date.now() - worker.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
  };
}

function toRemoteSurfaceSummary(
  surface: typeof schema.remoteSurfaces.$inferSelect,
): RemoteSurfaceSummary {
  return {
    id: surface.id,
    projectId: surface.projectId,
    workerId: surface.workerId,
    kind: surface.kind as RemoteSurfaceSummary["kind"],
    title: surface.title,
    status: surface.status as RemoteSurfaceSummary["status"],
    preferredTransport:
      surface.preferredTransport as RemoteSurfaceSummary["preferredTransport"],
    configuration: surface.configuration,
    lastError: surface.lastError,
    lastConnectedAt: surface.lastConnectedAt
      ? toISOString(surface.lastConnectedAt)
      : null,
    createdAt: toISOString(surface.createdAt),
    updatedAt: toISOString(surface.updatedAt),
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

function toModelRouteSummary(
  route: typeof schema.modelRoutes.$inferSelect,
  providerName: string,
): ModelRouteSummary {
  return {
    id: route.id,
    providerId: route.providerId,
    providerName,
    modelName: route.modelName,
    position: route.position,
    enabled: route.enabled,
    reasoningEffort:
      route.reasoningEffort as ModelRouteSummary["reasoningEffort"],
  };
}

function toModelSummary(
  model: typeof schema.modelProfiles.$inferSelect,
  routes: ModelRouteSummary[],
): ModelProfileSummary {
  return {
    id: model.id,
    name: model.name,
    reasoningEffort:
      model.reasoningEffort as ModelProfileSummary["reasoningEffort"],
    routingPolicy: "priority",
    routes,
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
    worktreeId: message.worktreeId,
    executionLaneId: message.executionLaneId,
    sequence: message.sequence,
    role: message.role as ChatMessage["role"],
    content: message.content,
    modelId: message.modelId,
    modelRouteId: message.modelRouteId,
    providerId: message.providerId,
    providerName: message.providerName,
    providerModelName: message.providerModelName,
    createdAt: toISOString(message.createdAt),
  };
}

function toQueuedPrompt(
  prompt: typeof schema.queuedPrompts.$inferSelect,
): QueuedPrompt {
  return {
    id: prompt.id,
    chatId: prompt.chatId,
    text: prompt.text,
    modelId: prompt.modelId,
    position: prompt.position,
    frozen: prompt.frozen,
    createdAt: toISOString(prompt.createdAt),
    updatedAt: toISOString(prompt.updatedAt),
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
        name: modelName,
      })
      .onConflictDoNothing({ target: schema.modelProfiles.id });
    await this.database
      .insert(schema.modelRoutes)
      .values({
        id: DEFAULT_MODEL_ROUTE_ID,
        modelId: DEFAULT_MODEL_ID,
        providerId: DEFAULT_OLLAMA_PROVIDER_ID,
        modelName,
        position: 0,
      })
      .onConflictDoNothing({ target: schema.modelRoutes.id });
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
    const [settingsRows, providerRows, modelRows, routeRows] =
      await Promise.all([
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
          .select()
          .from(schema.modelProfiles)
          .where(eq(schema.modelProfiles.ownerId, ownerId))
          .orderBy(asc(schema.modelProfiles.name)),
        this.database
          .select({
            route: schema.modelRoutes,
            providerName: schema.modelProviders.name,
          })
          .from(schema.modelRoutes)
          .innerJoin(
            schema.modelProfiles,
            eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
          )
          .innerJoin(
            schema.modelProviders,
            eq(schema.modelProviders.id, schema.modelRoutes.providerId),
          )
          .where(eq(schema.modelProfiles.ownerId, ownerId))
          .orderBy(asc(schema.modelRoutes.position)),
      ]);
    const settings = firstOrThrow(settingsRows, "loading user settings");
    return {
      preferences: {
        theme: settings.theme as ThemePreference,
        highContrast: settings.highContrast,
        defaultModelId: settings.defaultModelId,
      },
      providers: providerRows.map(toProviderSummary),
      models: modelRows.map((model) =>
        toModelSummary(
          model,
          routeRows
            .filter(({ route }) => route.modelId === model.id)
            .map(({ route, providerName }) =>
              toModelRouteSummary(route, providerName),
            ),
        ),
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
    if (provider) {
      const routes = await this.database
        .select({ id: schema.modelRoutes.id })
        .from(schema.modelRoutes)
        .where(eq(schema.modelRoutes.providerId, providerId));
      for (const route of routes) {
        await this.database
          .update(schema.chatRuntimeSessions)
          .set({
            codexThreadId: null,
            status: "detached",
            updatedAt: new Date(),
          })
          .where(eq(schema.chatRuntimeSessions.modelRouteId, route.id));
      }
    }
    return provider ? toProviderSummary(provider) : null;
  }

  async createModelProfile(
    ownerId: string,
    input: ModelProfileCreate,
  ): Promise<ModelProfileSummary | null> {
    const providers = await this.database
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(eq(schema.modelProviders.ownerId, ownerId));
    const providerIds = new Set(providers.map(({ id }) => id));
    if (input.routes.some((route) => !providerIds.has(route.providerId))) {
      return null;
    }
    const modelId = randomUUID();
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.modelProfiles).values({
        id: modelId,
        ownerId,
        name: input.name,
        reasoningEffort: input.reasoningEffort ?? null,
      });
      await transaction.insert(schema.modelRoutes).values(
        input.routes.map((route, position) => ({
          id: randomUUID(),
          modelId,
          providerId: route.providerId,
          modelName: route.modelName,
          position,
          enabled: route.enabled,
          reasoningEffort: route.reasoningEffort ?? null,
        })),
      );
    });
    return (
      (await this.getSettings(ownerId)).models.find(
        (model) => model.id === modelId,
      ) ?? null
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
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(eq(schema.modelProviders.ownerId, ownerId));
    const providerIds = new Set(providers.map(({ id }) => id));
    if (input.routes.some((route) => !providerIds.has(route.providerId))) {
      return null;
    }
    const models = await this.database
      .select({
        id: schema.modelProfiles.id,
        reasoningEffort: schema.modelProfiles.reasoningEffort,
      })
      .from(schema.modelProfiles)
      .where(
        and(
          eq(schema.modelProfiles.id, modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!models[0]) return null;
    const existingRoutes = await this.database
      .select()
      .from(schema.modelRoutes)
      .where(eq(schema.modelRoutes.modelId, modelId));
    const existingRouteIds = new Set(existingRoutes.map(({ id }) => id));
    const suppliedRouteIds = input.routes.flatMap((route) =>
      route.id ? [route.id] : [],
    );
    if (
      new Set(suppliedRouteIds).size !== suppliedRouteIds.length ||
      suppliedRouteIds.some((id) => !existingRouteIds.has(id))
    ) {
      return null;
    }
    const existingRouteById = new Map(
      existingRoutes.map((route) => [route.id, route]),
    );
    const profileReasoningChanged =
      models[0].reasoningEffort !== (input.reasoningEffort ?? null);
    const invalidatedRouteIds = new Set(
      existingRoutes.flatMap((route) => {
        const inputRoute = input.routes.find(
          (candidate) => candidate.id === route.id,
        );
        if (!inputRoute) return [route.id];
        const runtimeConfigurationChanged =
          route.providerId !== inputRoute.providerId ||
          route.modelName !== inputRoute.modelName ||
          route.reasoningEffort !== (inputRoute.reasoningEffort ?? null) ||
          (profileReasoningChanged && route.reasoningEffort === null);
        return runtimeConfigurationChanged ? [route.id] : [];
      }),
    );

    await this.database.transaction(async (transaction) => {
      await transaction
        .update(schema.modelProfiles)
        .set({
          name: input.name,
          reasoningEffort: input.reasoningEffort ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.modelProfiles.id, modelId));
      for (const routeId of invalidatedRouteIds) {
        await transaction
          .update(schema.chatRuntimeSessions)
          .set({
            codexThreadId: null,
            status: "detached",
            updatedAt: new Date(),
          })
          .where(eq(schema.chatRuntimeSessions.modelRouteId, routeId));
      }
      const removedRouteIds = [...existingRouteById.keys()].filter(
        (id) => !suppliedRouteIds.includes(id),
      );
      for (const routeId of removedRouteIds) {
        await transaction
          .delete(schema.modelRoutes)
          .where(eq(schema.modelRoutes.id, routeId));
      }
      await transaction
        .update(schema.modelRoutes)
        .set({ position: sql`${schema.modelRoutes.position} + 1000` })
        .where(eq(schema.modelRoutes.modelId, modelId));
      for (const [position, route] of input.routes.entries()) {
        if (route.id) {
          await transaction
            .update(schema.modelRoutes)
            .set({
              providerId: route.providerId,
              modelName: route.modelName,
              position,
              enabled: route.enabled,
              reasoningEffort: route.reasoningEffort ?? null,
              updatedAt: new Date(),
            })
            .where(eq(schema.modelRoutes.id, route.id));
        } else {
          await transaction.insert(schema.modelRoutes).values({
            id: randomUUID(),
            modelId,
            providerId: route.providerId,
            modelName: route.modelName,
            position,
            enabled: route.enabled,
            reasoningEffort: route.reasoningEffort ?? null,
          });
        }
      }
    });
    return (
      (await this.getSettings(ownerId)).models.find(
        (model) => model.id === modelId,
      ) ?? null
    );
  }

  async getModelRuntime(
    ownerId: string,
    modelId: string,
    routeId?: string,
  ): Promise<ModelRuntime | null> {
    return (await this.getModelRuntimes(ownerId, modelId, routeId))[0] ?? null;
  }

  async getModelRuntimeByRoute(
    ownerId: string,
    routeId: string,
  ): Promise<ModelRuntime | null> {
    return (
      (await this.getModelRuntimes(ownerId, undefined, routeId, true))[0] ??
      null
    );
  }

  async getModelRuntimes(
    ownerId: string,
    modelId?: string,
    routeId?: string,
    includeDisabled = false,
  ): Promise<ModelRuntime[]> {
    const rows = await this.database
      .select({
        model: schema.modelProfiles,
        route: schema.modelRoutes,
        provider: schema.modelProviders,
      })
      .from(schema.modelProfiles)
      .innerJoin(
        schema.modelRoutes,
        eq(schema.modelRoutes.modelId, schema.modelProfiles.id),
      )
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.modelProfiles.ownerId, ownerId),
          ...(!includeDisabled ? [eq(schema.modelRoutes.enabled, true)] : []),
          ...(modelId ? [eq(schema.modelProfiles.id, modelId)] : []),
          ...(routeId ? [eq(schema.modelRoutes.id, routeId)] : []),
        ),
      )
      .orderBy(asc(schema.modelRoutes.position));
    return rows.map((row) => ({
      routeId: row.route.id,
      model: {
        id: row.model.id,
        routeId: row.route.id,
        name: row.route.modelName,
        reasoningEffort: (row.route.reasoningEffort ??
          row.model.reasoningEffort) as ModelProfileSummary["reasoningEffort"],
      },
      provider: {
        id: row.provider.id,
        name: row.provider.name,
        kind: row.provider.kind as ModelProviderSummary["kind"],
        baseUrl: row.provider.baseUrl,
        apiKey: row.provider.apiKey,
      },
    }));
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
        remoteSurfaceCapabilities: heartbeat.remoteSurfaces,
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
          remoteSurfaceCapabilities: heartbeat.remoteSurfaces,
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
        workerId: schema.projectWorktrees.workerId,
        cwd: schema.projectWorktrees.absolutePath,
        worktreeId: schema.projectWorktrees.id,
      })
      .from(schema.projects)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.projectSourceId, schema.projectSources.id),
          eq(schema.projectWorktrees.isDefault, true),
        ),
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

  async listProjectWorktrees(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWorktreeSummary[]> {
    const rows = await this.database
      .select({
        projectId: schema.projects.id,
        worktree: schema.projectWorktrees,
      })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectSources.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.projects.id, projectId))
      .orderBy(
        desc(schema.projectWorktrees.isPrimary),
        asc(schema.projectWorktrees.name),
      );
    return rows.map(({ projectId: id, worktree }) =>
      toProjectWorktreeSummary(worktree, id),
    );
  }

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

  async getGithubProjectExecutionContext(
    ownerId: string,
    projectId: string,
  ): Promise<GithubProjectExecutionContext | null> {
    const rows = await this.database
      .select({
        nameWithOwner: schema.projects.githubRepositoryFullName,
        url: schema.projects.githubRepositoryUrl,
        workerId: schema.projectSources.workerId,
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
    const row = rows[0];
    return row?.nameWithOwner && row.url
      ? {
          nameWithOwner: row.nameWithOwner,
          url: row.url,
          workerId: row.workerId,
        }
      : null;
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
  ): Promise<ProjectSummary> {
    const project = await this.database.transaction(async (transaction) => {
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
          setupStatus: "cloning",
          setupError: null,
          githubRepositoryId: input.repositoryId,
          githubRepositoryFullName: input.nameWithOwner,
          githubRepositoryUrl: input.url,
        })
        .returning();
      return firstOrThrow(projectResult, "creating a GitHub project");
    });
    return toProjectSummary(project);
  }

  async completeGithubProjectSetup(
    ownerId: string,
    projectId: string,
    workerId: string,
    clone: ProjectCloneResult,
  ): Promise<ProjectSummary | null> {
    return this.database.transaction(async (transaction) => {
      const projectRows = await transaction
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!projectRows[0]) return null;
      const sourceResult = await transaction
        .insert(schema.projectSources)
        .values({
          id: randomUUID(),
          projectId,
          workerId,
          absolutePath: clone.path,
          displayPath: clone.displayPath,
        })
        .returning();
      const source = firstOrThrow(sourceResult, "recording a project source");
      await transaction.insert(schema.projectWorktrees).values({
        id: randomUUID(),
        projectSourceId: source.id,
        workerId,
        name: "Primary",
        absolutePath: clone.path,
        displayPath: clone.displayPath,
        isPrimary: true,
        isDefault: true,
        origin: "cantrip",
        lifecycleState: "ready",
      });
      const projectResult = await transaction
        .update(schema.projects)
        .set({
          setupStatus: "ready",
          setupError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.projects.id, projectId))
        .returning();
      return toProjectSummary(
        firstOrThrow(projectResult, "completing project setup"),
        source,
      );
    });
  }

  async failGithubProjectSetup(
    ownerId: string,
    projectId: string,
    error: string,
  ): Promise<boolean> {
    const result = await this.database
      .update(schema.projects)
      .set({
        setupStatus: "failed",
        setupError: error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .returning({ id: schema.projects.id });
    return Boolean(result[0]);
  }

  async getProjectRemovalContext(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectRemovalContext | null> {
    const rows = await this.database
      .select({
        projectId: schema.projects.id,
        setupStatus: schema.projects.setupStatus,
        workerId: schema.projectSources.workerId,
        cwd: schema.projectSources.absolutePath,
      })
      .from(schema.projects)
      .leftJoin(
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
    const project = rows[0];
    if (!project) return null;
    const terminals = await this.database
      .select({ id: schema.terminals.id })
      .from(schema.terminals)
      .where(eq(schema.terminals.projectId, projectId));
    return {
      cwd: project.cwd,
      setupStatus: project.setupStatus as ProjectSummary["setupStatus"],
      terminalIds: terminals.map(({ id }) => id),
      workerId: project.workerId,
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
      .select({
        source: schema.projectSources,
        worktree: schema.projectWorktrees,
      })
      .from(schema.projects)
      .innerJoin(
        schema.projectSources,
        eq(schema.projectSources.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.projectSourceId, schema.projectSources.id),
          eq(schema.projectWorktrees.isDefault, true),
        ),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const source = projectRows[0]?.source;
    const worktree = projectRows[0]?.worktree;
    if (!source || !worktree) {
      return null;
    }

    const [lastChats, lastTerminals, lastExplorers, lastBrowsers, lastViews] =
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
        this.database
          .select({ position: schema.projectViews.position })
          .from(schema.projectViews)
          .where(eq(schema.projectViews.projectId, projectId))
          .orderBy(desc(schema.projectViews.position))
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
            lastViews[0]?.position ?? -1,
          ) + 1,
        activeWorkerId: source.workerId,
        activeWorktreeId: worktree.id,
      })
      .returning();
    const chat = firstOrThrow(result, "creating a chat");
    await this.database.insert(schema.chatRuntimeSessions).values({
      id: randomUUID(),
      chatId: chat.id,
      workerId: source.workerId,
      worktreeId: worktree.id,
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
    const source = await this.getProjectSource(ownerId, projectId);
    if (!source) return null;

    const [lastChats, lastTerminals, lastExplorers, lastBrowsers, lastViews] =
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
        this.database
          .select({ position: schema.projectViews.position })
          .from(schema.projectViews)
          .where(eq(schema.projectViews.projectId, projectId))
          .orderBy(desc(schema.projectViews.position))
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
            lastViews[0]?.position ?? -1,
          ) + 1,
        activeWorkerId: source.workerId,
        worktreeId: source.worktreeId,
      })
      .returning();
    return toTerminalSummary(firstOrThrow(result, "creating a terminal"));
  }

  async getOrCreateChatConsole(
    ownerId: string,
    chatId: string,
  ): Promise<TerminalSummary | null> {
    const rows = await this.database
      .select({ chat: schema.chats, worktree: schema.projectWorktrees })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
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
        activeWorkerId: row.worktree.workerId,
        worktreeId: row.chat.activeWorktreeId,
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
    const [lastChats, lastTerminals, lastExplorers, lastBrowsers, lastViews] =
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
        this.database
          .select({ position: schema.projectViews.position })
          .from(schema.projectViews)
          .where(eq(schema.projectViews.projectId, projectId))
          .orderBy(desc(schema.projectViews.position))
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
            lastViews[0]?.position ?? -1,
          ) + 1,
        activeWorkerId: source.workerId,
        worktreeId: source.worktreeId,
      })
      .returning();
    return toExplorerSummary(firstOrThrow(result, "creating an explorer"));
  }

  async getExplorerExecutionContext(
    ownerId: string,
    explorerId: string,
  ): Promise<ExplorerExecutionContext | null> {
    const rows = await this.database
      .select({
        explorer: schema.explorers,
        worktree: schema.projectWorktrees,
      })
      .from(schema.explorers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.explorers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.explorers.worktreeId),
      )
      .where(eq(schema.explorers.id, explorerId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          explorerId: row.explorer.id,
          root: row.worktree.absolutePath,
          workerId: row.worktree.workerId,
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
    const [lastChats, lastTerminals, lastExplorers, lastBrowsers, lastViews] =
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
        this.database
          .select({ position: schema.projectViews.position })
          .from(schema.projectViews)
          .where(eq(schema.projectViews.projectId, projectId))
          .orderBy(desc(schema.projectViews.position))
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
            lastViews[0]?.position ?? -1,
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

  async listRemoteSurfaces(
    ownerId: string,
    projectId: string,
  ): Promise<RemoteSurfaceSummary[]> {
    const rows = await this.database
      .select({ surface: schema.remoteSurfaces })
      .from(schema.remoteSurfaces)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.remoteSurfaces.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.remoteSurfaces.projectId, projectId))
      .orderBy(
        asc(schema.remoteSurfaces.createdAt),
        asc(schema.remoteSurfaces.id),
      );
    return rows.map(({ surface }) => toRemoteSurfaceSummary(surface));
  }

  async createRemoteSurface(
    ownerId: string,
    projectId: string,
    input: RemoteSurfaceCreate,
  ): Promise<RemoteSurfaceSummary | null> {
    const [projectRows, workerRows] = await Promise.all([
      this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1),
      this.database
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, ownerId),
          ),
        )
        .limit(1),
    ]);
    if (!projectRows[0] || !workerRows[0]) return null;
    const result = await this.database
      .insert(schema.remoteSurfaces)
      .values({
        id: randomUUID(),
        projectId,
        workerId: input.workerId,
        kind: input.configuration.kind,
        title: input.title,
        configuration: input.configuration,
      })
      .returning();
    return toRemoteSurfaceSummary(
      firstOrThrow(result, "creating a Remote Surface"),
    );
  }

  async getRemoteSurfaceExecutionContext(
    ownerId: string,
    surfaceId: string,
  ): Promise<RemoteSurfaceExecutionContext | null> {
    const rows = await this.database
      .select({ surface: schema.remoteSurfaces })
      .from(schema.remoteSurfaces)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.remoteSurfaces.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.remoteSurfaces.workerId),
          eq(schema.workers.ownerId, ownerId),
        ),
      )
      .where(eq(schema.remoteSurfaces.id, surfaceId))
      .limit(1);
    const surface = rows[0]?.surface;
    return surface
      ? { surface: toRemoteSurfaceSummary(surface), workerId: surface.workerId }
      : null;
  }

  async updateRemoteSurface(
    ownerId: string,
    surfaceId: string,
    input: RemoteSurfaceUpdate,
  ): Promise<RemoteSurfaceSummary | null> {
    const context = await this.getRemoteSurfaceExecutionContext(
      ownerId,
      surfaceId,
    );
    if (
      !context ||
      (input.configuration && input.configuration.kind !== context.surface.kind)
    ) {
      return null;
    }
    const result = await this.database
      .update(schema.remoteSurfaces)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(schema.remoteSurfaces.id, surfaceId))
      .returning();
    return result[0] ? toRemoteSurfaceSummary(result[0]) : null;
  }

  async setRemoteSurfaceStatus(
    surfaceId: string,
    status: RemoteSurfaceStatus,
    lastError: string | null = null,
  ): Promise<void> {
    await this.database
      .update(schema.remoteSurfaces)
      .set({
        status,
        lastError,
        lastConnectedAt: status === "active" ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(schema.remoteSurfaces.id, surfaceId));
  }

  async resetTransientRemoteSurfaceStatuses(): Promise<void> {
    await this.database.execute(sql`
      update ${schema.remoteSurfaces}
      set status = 'idle', last_error = null, updated_at = now()
      where status in ('connecting', 'active', 'offline')
    `);
  }

  async deleteRemoteSurface(
    ownerId: string,
    surfaceId: string,
  ): Promise<RemoteSurfaceExecutionContext | null> {
    const context = await this.getRemoteSurfaceExecutionContext(
      ownerId,
      surfaceId,
    );
    if (!context) return null;
    await this.database
      .delete(schema.remoteSurfaces)
      .where(eq(schema.remoteSurfaces.id, surfaceId));
    return context;
  }

  async listProjectViews(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectViewSummary[]> {
    const rows = await this.database
      .select({ view: schema.projectViews })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.projectViews.projectId, projectId))
      .orderBy(
        asc(schema.projectViews.position),
        asc(schema.projectViews.createdAt),
      );
    return rows.map(({ view }) => toProjectViewSummary(view));
  }

  async createProjectView(
    ownerId: string,
    projectId: string,
    input: ProjectViewCreate,
  ): Promise<ProjectViewSummary | null> {
    const source = await this.getProjectSource(ownerId, projectId);
    if (!source) return null;
    const [lastChats, lastTerminals, lastExplorers, lastBrowsers, lastViews] =
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
        this.database
          .select({ position: schema.projectViews.position })
          .from(schema.projectViews)
          .where(eq(schema.projectViews.projectId, projectId))
          .orderBy(desc(schema.projectViews.position))
          .limit(1),
      ]);
    const result = await this.database
      .insert(schema.projectViews)
      .values({
        id: randomUUID(),
        projectId,
        title: input.title,
        kind: input.kind,
        worktreeId: input.kind === "history" ? source.worktreeId : null,
        position:
          Math.max(
            lastChats[0]?.position ?? -1,
            lastTerminals[0]?.position ?? -1,
            lastExplorers[0]?.position ?? -1,
            lastBrowsers[0]?.position ?? -1,
            lastViews[0]?.position ?? -1,
          ) + 1,
      })
      .returning();
    return toProjectViewSummary(
      firstOrThrow(result, "creating a project view"),
    );
  }

  async updateProjectView(
    ownerId: string,
    viewId: string,
    input: ProjectViewUpdate,
  ): Promise<ProjectViewSummary | null> {
    if (!(await this.projectViewIsOwnedBy(ownerId, viewId))) return null;
    const result = await this.database
      .update(schema.projectViews)
      .set({ title: input.title, updatedAt: new Date() })
      .where(eq(schema.projectViews.id, viewId))
      .returning();
    return result[0] ? toProjectViewSummary(result[0]) : null;
  }

  async deleteProjectView(ownerId: string, viewId: string): Promise<boolean> {
    if (!(await this.projectViewIsOwnedBy(ownerId, viewId))) return false;
    const result = await this.database
      .delete(schema.projectViews)
      .where(eq(schema.projectViews.id, viewId))
      .returning({ id: schema.projectViews.id });
    return result.length === 1;
  }

  private async projectViewIsOwnedBy(
    ownerId: string,
    viewId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.projectViews.id })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.projectViews.id, viewId))
      .limit(1);
    return rows.length === 1;
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
      .select({
        terminal: schema.terminals,
        worktree: schema.projectWorktrees,
      })
      .from(schema.terminals)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.terminals.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.terminals.worktreeId),
      )
      .where(eq(schema.terminals.id, terminalId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          terminalId: row.terminal.id,
          workerId: row.worktree.workerId,
          worktreeId: row.worktree.id,
          cwd: row.worktree.absolutePath,
          linkedChatId: row.terminal.linkedChatId,
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
      const [lastChats, lastTerminals, lastExplorers, lastBrowsers, lastViews] =
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
          transaction
            .select({ position: schema.projectViews.position })
            .from(schema.projectViews)
            .where(eq(schema.projectViews.projectId, row.chat.projectId))
            .orderBy(desc(schema.projectViews.position))
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
              lastViews[0]?.position ?? -1,
            ) + 1,
          activeWorkerId: row.source.workerId,
          activeWorktreeId: row.chat.activeWorktreeId,
          worktreeMode: row.chat.worktreeMode,
          modelId: row.chat.modelId,
        })
        .returning();
      const fork = firstOrThrow(chatResult, "forking a chat");
      await transaction.insert(schema.chatRuntimeSessions).values({
        id: randomUUID(),
        chatId: fork.id,
        workerId: row.source.workerId,
        worktreeId: row.chat.activeWorktreeId,
      });
      if (sourceMessages.length > 0) {
        await transaction.insert(schema.chatMessages).values(
          sourceMessages.map((message) => ({
            id: randomUUID(),
            chatId: fork.id,
            worktreeId: message.worktreeId,
            executionLaneId: null,
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
    const [chatRows, terminalRows, explorerRows, browserRows, viewRows] =
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
        this.database
          .select({ id: schema.projectViews.id })
          .from(schema.projectViews)
          .innerJoin(
            schema.projects,
            and(
              eq(schema.projects.id, projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .where(eq(schema.projectViews.projectId, projectId)),
      ]);
    const expected = new Set([
      ...chatRows.map(({ id }) => `chat:${id}`),
      ...terminalRows.map(({ id }) => `terminal:${id}`),
      ...explorerRows.map(({ id }) => `explorer:${id}`),
      ...browserRows.map(({ id }) => `browser:${id}`),
      ...viewRows.map(({ id }) => `view:${id}`),
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
        } else if (kind === "browser") {
          await transaction
            .update(schema.browsers)
            .set({ position })
            .where(eq(schema.browsers.id, id));
        } else {
          await transaction
            .update(schema.projectViews)
            .set({ position })
            .where(eq(schema.projectViews.id, id));
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
      .where(eq(schema.chats.id, chatId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      chatId: row.chat.id,
      cwd: row.worktree.absolutePath,
      modelId: row.chat.modelId,
      modelRouteId: row.runtime?.modelRouteId ?? null,
      status: row.chat.status as ChatSummary["status"],
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.worktree.workerId,
      worktreeId: row.worktree.id,
    };
  }

  async updateChatRuntime(
    chatId: string,
    workerId: string,
    worktreeId: string,
    threadId: string | null,
    modelRouteId: string,
    status = "ready",
  ): Promise<void> {
    await this.database
      .insert(schema.chatRuntimeSessions)
      .values({
        id: randomUUID(),
        chatId,
        workerId,
        worktreeId,
        codexThreadId: threadId,
        modelRouteId,
        status,
      })
      .onConflictDoUpdate({
        target: [
          schema.chatRuntimeSessions.chatId,
          schema.chatRuntimeSessions.workerId,
          schema.chatRuntimeSessions.worktreeId,
        ],
        set: {
          codexThreadId: threadId,
          modelRouteId,
          status,
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
  ): Promise<QueuedPrompt | null> {
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
    if (!chat[0]) return null;

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
        modelId,
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
  ): Promise<QueuedPrompt | null> {
    const owned = await this.database
      .select({ id: schema.queuedPrompts.id })
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
    if (!owned[0]) return null;
    const result = await this.database
      .update(schema.queuedPrompts)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(schema.queuedPrompts.id, promptId))
      .returning();
    return result[0] ? toQueuedPrompt(result[0]) : null;
  }

  async deleteQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<QueuedPrompt | null> {
    const owned = await this.database
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
    if (!owned[0]) return null;
    await this.database
      .delete(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.id, promptId));
    return toQueuedPrompt(owned[0].prompt);
  }

  async reorderQueuedPrompts(
    ownerId: string,
    chatId: string,
    input: QueuedPromptOrder,
  ): Promise<boolean> {
    const prompts = await this.listQueuedPrompts(ownerId, chatId);
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

  async appendMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate,
  ): Promise<ChatMessage | null> {
    const chat = await this.database
      .select({
        id: schema.chats.id,
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
      .where(eq(schema.chats.id, chatId))
      .limit(1);
    if (!chat[0]) {
      return null;
    }

    const activeLanes = await this.database
      .select({ id: schema.chatExecutionLanes.id })
      .from(schema.chatExecutionLanes)
      .where(
        and(
          eq(schema.chatExecutionLanes.chatId, chatId),
          eq(schema.chatExecutionLanes.worktreeId, chat[0].worktreeId),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .limit(1);

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
        worktreeId: chat[0].worktreeId,
        executionLaneId: activeLanes[0]?.id ?? null,
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

  async setMessageModelRoute(
    messageId: string,
    modelId: string,
    runtime: ModelRuntime,
  ): Promise<void> {
    await this.database
      .update(schema.chatMessages)
      .set({
        modelId,
        modelRouteId: runtime.routeId,
        providerId: runtime.provider.id,
        providerName: runtime.provider.name,
        providerModelName: runtime.model.name,
      })
      .where(eq(schema.chatMessages.id, messageId));
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
