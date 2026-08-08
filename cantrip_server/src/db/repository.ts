import { randomUUID } from "node:crypto";

import {
  agentInteractionRequestSchema,
  normalizeResponsesBaseUrl,
} from "@cantrip/protocol";
import type {
  AgentInteractionRequest,
  AgentInteractionRequestCreate,
  AgentInteractionRequestPayload,
  AgentInteractionRequestQuery,
  AgentInteractionResolutionCreate,
  AgentInteractionResponse,
  BrowserCreate,
  BrowserSummary,
  BrowserUpdate,
  ChatCreate,
  ChatExecutionLaneSummary,
  ChatFork,
  ChatModelUpdate,
  ChatPlanState,
  ChatMessage,
  ChatMessageCreate,
  ChatSummary,
  ChatUpdate,
  ChatWorktreeUpdate,
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
  PendingPlanQuestion,
  PlanMode,
  PlanStep,
  OrderedIds,
  QueuedPrompt,
  QueuedPromptCreate,
  QueuedPromptOrder,
  QueuedPromptUpdate,
  RemoteDesktopSummary,
  RemoteSurfaceCapabilities,
  RemoteSurfaceCreate,
  RemoteSurfaceStatus,
  RemoteSurfaceSummary,
  RemoteSurfaceUpdate,
  ProjectCloneResult,
  ProjectSummary,
  ProjectWorktreePolicyUpdate,
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
  WorkerWorktreeSummary,
  WorktreeInventory,
  WorktreePolicy,
  WorktreeSelection,
} from "@cantrip/protocol";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
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
  automationPaused: boolean;
  chatId: string;
  cwd: string;
  executionLaneId: string | null;
  isPrimary: boolean;
  status: ChatSummary["status"];
  modelId: string | null;
  modelRouteId: string | null;
  planMode: PlanMode;
  pendingPlanQuestion: PendingPlanQuestion | null;
  projectId: string;
  threadId: string | null;
  workerId: string;
  worktreeId: string;
  worktreeMode: ChatSummary["worktreeMode"];
  worktreePolicy: WorktreePolicy;
}

export class ExecutionLaneConflictError extends Error {}
export class AgentInteractionConflictError extends Error {}

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
  remoteSurfaces: RemoteSurfaceSummary[];
  setupStatus: ProjectSummary["setupStatus"];
  terminalIds: string[];
  workerId: string | null;
}

export interface GithubProjectExecutionContext {
  nameWithOwner: string;
  url: string;
  workerId: string;
}

export interface ProjectWorktreeExecutionContext {
  projectId: string;
  projectSourceId: string;
  sourcePath: string;
  workerId: string;
  worktree: ProjectWorktreeSummary;
}

export interface WorktreeRemovalBlockers {
  activeChatIds: string[];
  activeLeaseChatIds: string[];
  runningTerminalIds: string[];
}

export interface ChatExecutionAttribution {
  executionLaneId: string;
  worktreeId: string;
}

export interface ChatExecutionLaneContext {
  chat: ChatSummary;
  lane: ChatExecutionLaneSummary;
  sourcePath: string;
  worktree: ProjectWorktreeSummary;
}

export interface ChatExecutionLaneReleaseResult {
  chat: ChatSummary;
  lane: ChatExecutionLaneSummary;
  returnedToPrimary: boolean;
}

export interface ChatWorktreeTransitionResult {
  chat: ChatSummary;
  fromWorktreeId: string;
  lane: ChatExecutionLaneSummary;
  transitionKind: "switch" | "release";
  worktree: ProjectWorktreeSummary;
}

export interface ExplorerExecutionContext {
  explorerId: string;
  root: string;
  workerId: string;
}

export interface RemoteSurfaceExecutionContext {
  remoteSurfaceCapabilities: RemoteSurfaceCapabilities;
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

function chatIsExecuting(status: ChatSummary["status"]): boolean {
  return status === "running" || status === "waiting-for-approval";
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
    planMode: chat.planMode as ChatSummary["planMode"],
    hasPendingPlanQuestion: chat.pendingPlanQuestion !== null,
    automationPaused: chat.automationPaused,
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
    codexRuntime: worker.codexRuntime,
    remoteSurfaces: worker.remoteSurfaceCapabilities,
    startedAt: toISOString(worker.startedAt),
    lastSeenAt: toISOString(worker.lastSeenAt),
    online: Date.now() - worker.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
  };
}

function toAgentInteractionRequest(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): AgentInteractionRequest {
  return agentInteractionRequestSchema.parse({
    id: request.id,
    requestKey: request.requestKey,
    projectId: request.projectId,
    provenance: {
      chatId: request.chatId,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      executionLaneId: request.executionLaneId,
      workflowRunId: request.workflowRunId,
      workflowNodeId: request.workflowNodeId,
      workerId: request.workerId,
    },
    payload: request.payload,
    status: request.status,
    response: request.response,
    resolvedByUserId: request.resolvedByUserId,
    expiresAt: request.expiresAt ? toISOString(request.expiresAt) : null,
    resolvedAt: request.resolvedAt ? toISOString(request.resolvedAt) : null,
    createdAt: toISOString(request.createdAt),
    updatedAt: toISOString(request.updatedAt),
  });
}

function agentInteractionResponseForStorage(
  payload: AgentInteractionRequestPayload,
  response: AgentInteractionResponse,
): AgentInteractionResponse {
  if (payload.kind !== "userInput" || response.kind !== "userInput") {
    return response;
  }
  const secretQuestionIds = new Set(
    payload.questions
      .filter((question) => question.isSecret)
      .map((question) => question.id),
  );
  return {
    ...response,
    answers: Object.fromEntries(
      Object.entries(response.answers).map(([questionId, answer]) => [
        questionId,
        secretQuestionIds.has(questionId)
          ? { answers: ["[redacted]"] }
          : answer,
      ]),
    ),
  };
}

function validateAgentInteractionResponse(
  payload: AgentInteractionRequestPayload,
  response: AgentInteractionResponse,
): void {
  if (payload.kind !== response.kind) {
    throw new AgentInteractionConflictError(
      "Response kind does not match the pending request.",
    );
  }
  if (payload.kind === "commandExecution") {
    if (response.kind !== "commandExecution") return;
    if (
      payload.availableDecisions &&
      !payload.availableDecisions.includes(response.decision)
    ) {
      throw new AgentInteractionConflictError(
        "Command response is not one of the available decisions.",
      );
    }
    if (
      response.decision === "acceptWithExecpolicyAmendment" &&
      !response.execpolicyAmendment
    ) {
      throw new AgentInteractionConflictError(
        "An execpolicy amendment is required for this decision.",
      );
    }
    if (
      response.decision === "applyNetworkPolicyAmendment" &&
      !response.networkPolicyAmendment
    ) {
      throw new AgentInteractionConflictError(
        "A network policy amendment is required for this decision.",
      );
    }
  }
  if (payload.kind === "userInput") {
    if (response.kind !== "userInput") return;
    const questionIds = new Set(
      payload.questions.map((question) => question.id),
    );
    const answerIds = Object.keys(response.answers);
    if (
      answerIds.length !== questionIds.size ||
      answerIds.some((questionId) => !questionIds.has(questionId))
    ) {
      throw new AgentInteractionConflictError(
        "User input responses must answer each requested question exactly once.",
      );
    }
  }
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

function toRemoteDesktopSummary(
  view: typeof schema.projectViews.$inferSelect,
  surface: typeof schema.remoteSurfaces.$inferSelect,
): RemoteDesktopSummary {
  if (surface.configuration.kind !== "desktop") {
    throw new Error("Remote Desktop is not backed by a desktop surface.");
  }
  return {
    id: view.id,
    projectId: view.projectId,
    title: view.title,
    position: view.position,
    workerId: surface.workerId,
    status: surface.status as RemoteDesktopSummary["status"],
    lastError: surface.lastError,
    createdAt: toISOString(view.createdAt),
    updatedAt: toISOString(
      view.updatedAt > surface.updatedAt ? view.updatedAt : surface.updatedAt,
    ),
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
    worktreeId: prompt.worktreeId,
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
        codexRuntime: heartbeat.codexRuntime,
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
          codexRuntime: heartbeat.codexRuntime,
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

  async updateProjectWorktreePolicy(
    ownerId: string,
    projectId: string,
    input: ProjectWorktreePolicyUpdate,
  ): Promise<ProjectSummary | null> {
    const rows = await this.database
      .update(schema.projects)
      .set({ worktreePolicy: input.policy, updatedAt: new Date() })
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .returning();
    if (!rows[0]) return null;
    const sources = await this.database
      .select()
      .from(schema.projectSources)
      .where(eq(schema.projectSources.projectId, projectId))
      .limit(1);
    return toProjectSummary(rows[0], sources[0] ?? null);
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
          eq(schema.projectWorktrees.isPrimary, true),
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

  async getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null> {
    const rows = await this.database
      .select({
        projectId: schema.projects.id,
        source: schema.projectSources,
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
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projectWorktrees.id, worktreeId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          projectId: row.projectId,
          projectSourceId: row.source.id,
          sourcePath: row.source.absolutePath,
          workerId: row.worktree.workerId,
          worktree: toProjectWorktreeSummary(row.worktree, row.projectId),
        }
      : null;
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

  async reconcileProjectWorktrees(
    ownerId: string,
    projectId: string,
    inventory: WorktreeInventory,
    created?: {
      id: string;
      name: string;
      origin: ProjectWorktreeSummary["origin"];
      path: string;
    },
  ): Promise<ProjectWorktreeSummary[] | null> {
    const ownedRows = await this.database
      .select({ source: schema.projectSources })
      .from(schema.projectSources)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectSources.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    const source = ownedRows[0]?.source;
    if (!source) return null;
    const observedPrimaries = inventory.worktrees.filter(
      ({ isPrimary }) => isPrimary,
    );
    if (
      observedPrimaries.length !== 1 ||
      observedPrimaries[0]?.path !== inventory.primaryPath
    ) {
      throw new Error("Worker inventory did not contain exactly one Primary.");
    }
    if (
      source.repositoryFingerprint &&
      source.repositoryFingerprint !== inventory.repositoryFingerprint
    ) {
      throw new Error(
        "Worker inventory belongs to a different Git common directory.",
      );
    }

    await this.database.transaction(async (transaction) => {
      const observedAt = new Date();
      const existing = await transaction
        .select()
        .from(schema.projectWorktrees)
        .where(eq(schema.projectWorktrees.projectSourceId, source.id));
      const primary = existing.find((item) => item.isPrimary);
      if (!primary) {
        throw new Error("Project source has no Primary worktree.");
      }

      await transaction
        .update(schema.projectSources)
        .set({
          absolutePath: inventory.primaryPath,
          repositoryFingerprint: inventory.repositoryFingerprint,
          updatedAt: observedAt,
        })
        .where(eq(schema.projectSources.id, source.id));

      const existingByPath = new Map(
        existing.map((item) => [item.absolutePath, item] as const),
      );
      const observedIds = new Set<string>();
      for (const observed of inventory.worktrees) {
        const matched = observed.isPrimary
          ? primary
          : existingByPath.get(observed.path);
        const id =
          matched?.id ??
          (created?.path === observed.path ? created.id : randomUUID());
        observedIds.add(id);
        const lifecycleState = observed.missing
          ? "missing"
          : observed.prunable
            ? "prunable"
            : "ready";
        const displayPath =
          matched?.displayPath ??
          (observed.isPrimary ? source.displayPath : observed.path);
        const values = {
          workerId: source.workerId,
          name:
            matched?.name ??
            (created?.path === observed.path
              ? created.name
              : (observed.branch ?? "External worktree")),
          absolutePath: observed.path,
          displayPath,
          isPrimary: observed.isPrimary,
          isDefault: matched?.isDefault ?? observed.isPrimary,
          origin:
            matched?.origin ??
            (created?.path === observed.path ? created.origin : "external"),
          lifecycleState,
          branch: observed.branch,
          head: observed.head,
          detached: observed.detached,
          locked: observed.locked,
          lockReason: observed.lockReason,
          lastScannedAt: observedAt,
          updatedAt: observedAt,
        };
        if (matched) {
          await transaction
            .update(schema.projectWorktrees)
            .set(values)
            .where(eq(schema.projectWorktrees.id, matched.id));
        } else {
          await transaction.insert(schema.projectWorktrees).values({
            id,
            projectSourceId: source.id,
            ...values,
          });
        }
      }

      for (const missing of existing) {
        if (!observedIds.has(missing.id) && !missing.isPrimary) {
          await transaction
            .update(schema.projectWorktrees)
            .set({
              lifecycleState: "missing",
              updatedAt: observedAt,
              lastScannedAt: observedAt,
            })
            .where(eq(schema.projectWorktrees.id, missing.id));
        }
      }
    });
    return this.listProjectWorktrees(ownerId, projectId);
  }

  async setProjectWorktreeLifecycle(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    lifecycleState: ProjectWorktreeSummary["lifecycleState"],
  ): Promise<ProjectWorktreeSummary | null> {
    const context = await this.getProjectWorktreeContext(
      ownerId,
      projectId,
      worktreeId,
    );
    if (!context) return null;
    const rows = await this.database
      .update(schema.projectWorktrees)
      .set({ lifecycleState, updatedAt: new Date() })
      .where(eq(schema.projectWorktrees.id, worktreeId))
      .returning();
    return rows[0] ? toProjectWorktreeSummary(rows[0], projectId) : null;
  }

  async observeProjectWorktree(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    observed: WorkerWorktreeSummary,
  ): Promise<ProjectWorktreeSummary | null> {
    const context = await this.getProjectWorktreeContext(
      ownerId,
      projectId,
      worktreeId,
    );
    if (!context) return null;
    if (context.worktree.path !== observed.path) {
      throw new Error("Worker status referred to a different worktree path.");
    }
    const now = new Date();
    const lifecycleState = observed.missing
      ? "missing"
      : observed.prunable
        ? "prunable"
        : "ready";
    const rows = await this.database
      .update(schema.projectWorktrees)
      .set({
        branch: observed.branch,
        detached: observed.detached,
        head: observed.head,
        lifecycleState,
        locked: observed.locked,
        lockReason: observed.lockReason,
        lastScannedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.projectWorktrees.id, worktreeId))
      .returning();
    return rows[0] ? toProjectWorktreeSummary(rows[0], projectId) : null;
  }

  async getWorktreeRemovalBlockers(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeRemovalBlockers | null> {
    const context = await this.getProjectWorktreeContext(
      ownerId,
      projectId,
      worktreeId,
    );
    if (!context) return null;
    const [chats, leases, terminals] = await Promise.all([
      this.database
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.activeWorktreeId, worktreeId),
            inArray(schema.chats.status, ["running", "waiting-for-approval"]),
          ),
        ),
      this.database
        .select({ chatId: schema.chatExecutionLanes.chatId })
        .from(schema.chatExecutionLanes)
        .where(
          and(
            eq(schema.chatExecutionLanes.worktreeId, worktreeId),
            ne(schema.chatExecutionLanes.state, "released"),
          ),
        ),
      this.database
        .select({ id: schema.terminals.id })
        .from(schema.terminals)
        .where(
          and(
            eq(schema.terminals.worktreeId, worktreeId),
            eq(schema.terminals.status, "running"),
          ),
        ),
    ]);
    return {
      activeChatIds: chats.map(({ id }) => id),
      activeLeaseChatIds: leases.map(({ chatId }) => chatId),
      runningTerminalIds: terminals.map(({ id }) => id),
    };
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

  async listProjectExecutionLanes(
    ownerId: string,
    projectId: string,
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
        and(
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
      await transaction
        .update(schema.chatExecutionLanes)
        .set({ state: "suspended", updatedAt: now })
        .where(eq(schema.chatExecutionLanes.state, "active"));
      await transaction
        .update(schema.chats)
        .set({ status: "failed", updatedAt: now })
        .where(
          inArray(schema.chats.status, ["running", "waiting-for-approval"]),
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
    try {
      return await this.database.transaction(async (transaction) => {
        const rows = await transaction
          .select({
            chat: schema.chats,
            project: schema.projects,
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
        return {
          automationPaused: row.chat.automationPaused,
          chatId,
          cwd: row.worktree.absolutePath,
          executionLaneId: lane.id,
          isPrimary: row.worktree.isPrimary,
          status: "running",
          modelId: row.chat.modelId,
          modelRouteId: runtime.modelRouteId,
          planMode: row.chat.planMode as PlanMode,
          pendingPlanQuestion: row.chat.pendingPlanQuestion,
          projectId: row.chat.projectId,
          threadId: runtime.codexThreadId,
          workerId: row.worktree.workerId,
          worktreeId: row.worktree.id,
          worktreeMode: row.chat.worktreeMode as ChatSummary["worktreeMode"],
          worktreePolicy: row.project.worktreePolicy as WorktreePolicy,
        };
      });
    } catch (error) {
      if (error instanceof ExecutionLaneConflictError) throw error;
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

  async finishChatExecutionLane(
    chatId: string,
    laneId: string,
    status: ChatSummary["status"],
  ): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(schema.chatExecutionLanes)
        .set({ state: "suspended", updatedAt: now })
        .where(
          and(
            eq(schema.chatExecutionLanes.id, laneId),
            eq(schema.chatExecutionLanes.chatId, chatId),
            eq(schema.chatExecutionLanes.state, "active"),
          ),
        );
      await transaction
        .update(schema.chats)
        .set({ status, updatedAt: now })
        .where(eq(schema.chats.id, chatId));
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
    return row
      ? {
          chat: toChatSummary(row.chat),
          lane: toChatExecutionLaneSummary(row.lane),
          sourcePath: row.sourcePath,
          worktree: toProjectWorktreeSummary(row.worktree, row.chat.projectId),
        }
      : null;
  }

  async releaseChatExecutionLane(
    ownerId: string,
    chatId: string,
    laneId: string,
    returnToPrimary: boolean,
  ): Promise<ChatExecutionLaneReleaseResult | null> {
    const context = await this.getChatExecutionLaneContext(
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
          .where(eq(schema.projectWorktrees.isPrimary, true))
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
        chat: toChatSummary(firstOrThrow(chats, "selecting a released chat")),
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
    const current = await this.getChatExecutionContext(ownerId, chatId);
    if (!current) return null;
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
    const target = await this.getProjectWorktreeContext(
      ownerId,
      current.projectId,
      targetWorktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;
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
        return firstOrThrow(inserted, "scheduling a worktree transition").id;
      });
      return this.getChatExecutionLaneContext(ownerId, chatId, laneId);
    } catch (error) {
      if (error instanceof ExecutionLaneConflictError) throw error;
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
      ? this.getChatExecutionLaneContext(ownerId, chatId, rows[0].id)
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
    const context = await this.getChatExecutionLaneContext(
      ownerId,
      chatId,
      laneId,
    );
    if (!context || context.lane.state !== "delivering") return false;
    const rows = await this.database
      .update(schema.chatExecutionLanes)
      .set({ state: "suspended", transitionKind: null, updatedAt: new Date() })
      .where(eq(schema.chatExecutionLanes.id, laneId))
      .returning({ id: schema.chatExecutionLanes.id });
    return rows.length === 1;
  }

  async applyChatWorktreeTransition(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<ChatWorktreeTransitionResult | null> {
    const pending = await this.getChatExecutionLaneContext(
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
    if (chatIsExecuting(pending.chat.status)) {
      throw new ExecutionLaneConflictError(
        "Finish the active turn before applying its worktree transition.",
      );
    }
    const fromWorktreeId = pending.chat.activeWorktreeId;
    return this.database.transaction(async (transaction) => {
      if (transitionKind === "release") {
        await transaction
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
          );
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
          updatedAt: new Date(),
        })
        .where(eq(schema.chats.id, chatId))
        .returning();
      return {
        chat: toChatSummary(firstOrThrow(chats, "switching chat worktrees")),
        fromWorktreeId,
        lane: toChatExecutionLaneSummary(lane),
        transitionKind,
        worktree: pending.worktree,
      };
    });
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
          worktreePolicy: clone.worktreePolicy ?? projectRows[0].worktreePolicy,
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
    const remoteSurfaces = await this.database
      .select({ surface: schema.remoteSurfaces })
      .from(schema.remoteSurfaces)
      .where(eq(schema.remoteSurfaces.projectId, projectId));
    return {
      cwd: project.cwd,
      remoteSurfaces: remoteSurfaces.map(({ surface }) =>
        toRemoteSurfaceSummary(surface),
      ),
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
    const selected = input.worktreeId
      ? await this.getProjectWorktreeContext(
          ownerId,
          projectId,
          input.worktreeId,
        )
      : null;
    const primary = input.worktreeId
      ? null
      : await this.getProjectSource(ownerId, projectId);
    const worktreeId = selected?.worktree.id ?? primary?.worktreeId;
    const workerId = selected?.workerId ?? primary?.workerId;
    const isPrimary = selected?.worktree.isPrimary ?? true;
    const startingHead = selected?.worktree.head ?? null;
    if (
      !worktreeId ||
      !workerId ||
      (selected && selected.worktree.lifecycleState !== "ready")
    ) {
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
    return this.database.transaction(async (transaction) => {
      const result = await transaction
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
          activeWorkerId: workerId,
          activeWorktreeId: worktreeId,
          worktreeMode: input.worktreeMode,
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
      return toChatSummary(chat);
    });
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
    const selected = input.worktreeId
      ? await this.getProjectWorktreeContext(
          ownerId,
          projectId,
          input.worktreeId,
        )
      : null;
    const source = input.worktreeId
      ? null
      : await this.getProjectSource(ownerId, projectId);
    const workerId = selected?.workerId ?? source?.workerId;
    const worktreeId = selected?.worktree.id ?? source?.worktreeId;
    if (
      !workerId ||
      !worktreeId ||
      (selected && selected.worktree.lifecycleState !== "ready")
    )
      return null;

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
        activeWorkerId: workerId,
        worktreeId,
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

  async updateTerminalWorktree(
    ownerId: string,
    terminalId: string,
    input: WorktreeSelection,
  ): Promise<TerminalSummary | null> {
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
      .where(eq(schema.terminals.id, terminalId))
      .limit(1);
    const terminal = rows[0]?.terminal;
    if (!terminal) return null;
    if (terminal.linkedChatId) {
      throw new Error(
        "Linked Codex consoles inherit their parent chat worktree.",
      );
    }
    if (terminal.status === "running") {
      throw new Error("Stop the terminal before changing its worktree.");
    }
    const target = await this.getProjectWorktreeContext(
      ownerId,
      terminal.projectId,
      input.worktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;
    const updated = await this.database
      .update(schema.terminals)
      .set({
        activeWorkerId: target.workerId,
        worktreeId: target.worktree.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.terminals.id, terminalId))
      .returning();
    return updated[0] ? toTerminalSummary(updated[0]) : null;
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
    const selected = input.worktreeId
      ? await this.getProjectWorktreeContext(
          ownerId,
          projectId,
          input.worktreeId,
        )
      : null;
    const source = input.worktreeId
      ? null
      : await this.getProjectSource(ownerId, projectId);
    const workerId = selected?.workerId ?? source?.workerId;
    const worktreeId = selected?.worktree.id ?? source?.worktreeId;
    if (
      !workerId ||
      !worktreeId ||
      (selected && selected.worktree.lifecycleState !== "ready")
    )
      return null;
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
        activeWorkerId: workerId,
        worktreeId,
      })
      .returning();
    return toExplorerSummary(firstOrThrow(result, "creating an explorer"));
  }

  async updateExplorerWorktree(
    ownerId: string,
    explorerId: string,
    input: WorktreeSelection,
  ): Promise<ExplorerSummary | null> {
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
      .where(eq(schema.explorers.id, explorerId))
      .limit(1);
    const explorer = rows[0]?.explorer;
    if (!explorer) return null;
    const target = await this.getProjectWorktreeContext(
      ownerId,
      explorer.projectId,
      input.worktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;
    const updated = await this.database
      .update(schema.explorers)
      .set({
        activeWorkerId: target.workerId,
        worktreeId: target.worktree.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.explorers.id, explorerId))
      .returning();
    return updated[0] ? toExplorerSummary(updated[0]) : null;
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
    return this.database.transaction(async (transaction) => {
      const browserId = randomUUID();
      const result = await transaction
        .insert(schema.browsers)
        .values({
          id: browserId,
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
      const browser = firstOrThrow(result, "creating a browser");
      await transaction.insert(schema.remoteSurfaces).values({
        id: browserId,
        projectId,
        workerId: source.workerId,
        kind: "browser",
        title: input.title,
        preferredTransport: "webrtc",
        configuration: {
          kind: "browser",
          initialUrl: browser.url,
          profileId: null,
        },
      });
      return toBrowserSummary(browser);
    });
  }

  async updateBrowser(
    ownerId: string,
    browserId: string,
    input: BrowserUpdate,
  ): Promise<BrowserSummary | null> {
    if (!(await this.browserIsOwnedBy(ownerId, browserId))) return null;
    const surface = await this.getRemoteSurfaceExecutionContext(
      ownerId,
      browserId,
    );
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .update(schema.browsers)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(schema.browsers.id, browserId))
        .returning();
      const browser = result[0];
      if (!browser) return null;
      await transaction
        .update(schema.remoteSurfaces)
        .set({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.url === undefined ||
          surface?.surface.configuration.kind !== "browser"
            ? {}
            : {
                configuration: {
                  ...surface.surface.configuration,
                  initialUrl: input.url,
                },
              }),
          updatedAt: new Date(),
        })
        .where(eq(schema.remoteSurfaces.id, browserId));
      return toBrowserSummary(browser);
    });
  }

  async deleteBrowser(ownerId: string, browserId: string): Promise<boolean> {
    if (!(await this.browserIsOwnedBy(ownerId, browserId))) return false;
    return this.database.transaction(async (transaction) => {
      await transaction
        .delete(schema.remoteSurfaces)
        .where(eq(schema.remoteSurfaces.id, browserId));
      const result = await transaction
        .delete(schema.browsers)
        .where(eq(schema.browsers.id, browserId))
        .returning({ id: schema.browsers.id });
      return result.length === 1;
    });
  }

  async ensureBrowserRemoteSurfaces(ownerId: string): Promise<void> {
    const rows = await this.database
      .select({
        browser: schema.browsers,
        workerId: schema.projectWorktrees.workerId,
        surfaceId: schema.remoteSurfaces.id,
      })
      .from(schema.browsers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.browsers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
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
      .leftJoin(
        schema.remoteSurfaces,
        eq(schema.remoteSurfaces.id, schema.browsers.id),
      )
      .where(isNull(schema.remoteSurfaces.id));
    if (rows.length === 0) return;
    await this.database.insert(schema.remoteSurfaces).values(
      rows.map(({ browser, workerId }) => ({
        id: browser.id,
        projectId: browser.projectId,
        workerId,
        kind: "browser",
        title: browser.title,
        preferredTransport: "webrtc",
        configuration: {
          kind: "browser" as const,
          initialUrl: browser.url,
          profileId: null,
        },
      })),
    );
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
      .select({
        surface: schema.remoteSurfaces,
        remoteSurfaceCapabilities: schema.workers.remoteSurfaceCapabilities,
      })
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
      ? {
          remoteSurfaceCapabilities: rows[0]!.remoteSurfaceCapabilities,
          surface: toRemoteSurfaceSummary(surface),
          workerId: surface.workerId,
        }
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

  async listRemoteDesktops(
    ownerId: string,
    projectId: string,
  ): Promise<RemoteDesktopSummary[]> {
    const rows = await this.database
      .select({ view: schema.projectViews, surface: schema.remoteSurfaces })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.remoteSurfaces,
        eq(schema.remoteSurfaces.id, schema.projectViews.id),
      )
      .where(
        and(
          eq(schema.projectViews.projectId, projectId),
          eq(schema.projectViews.kind, "remote-desktop"),
          eq(schema.remoteSurfaces.kind, "desktop"),
        ),
      )
      .orderBy(
        asc(schema.projectViews.position),
        asc(schema.projectViews.createdAt),
      );
    return rows.map(({ view, surface }) =>
      toRemoteDesktopSummary(view, surface),
    );
  }

  async getRemoteDesktop(
    ownerId: string,
    desktopId: string,
  ): Promise<RemoteDesktopSummary | null> {
    const rows = await this.database
      .select({ view: schema.projectViews, surface: schema.remoteSurfaces })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.remoteSurfaces,
        eq(schema.remoteSurfaces.id, schema.projectViews.id),
      )
      .where(
        and(
          eq(schema.projectViews.id, desktopId),
          eq(schema.projectViews.kind, "remote-desktop"),
          eq(schema.remoteSurfaces.kind, "desktop"),
        ),
      )
      .limit(1);
    return rows[0]
      ? toRemoteDesktopSummary(rows[0].view, rows[0].surface)
      : null;
  }

  async createRemoteDesktop(
    ownerId: string,
    projectId: string,
    desktopId: string,
    workerId: string,
  ): Promise<RemoteDesktopSummary | null> {
    const [
      projectRows,
      workerRows,
      lastChats,
      lastTerminals,
      lastExplorers,
      lastBrowsers,
      lastViews,
    ] = await Promise.all([
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
            eq(schema.workers.id, workerId),
            eq(schema.workers.ownerId, ownerId),
          ),
        )
        .limit(1),
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
    if (!projectRows[0] || !workerRows[0]) return null;
    const position =
      Math.max(
        lastChats[0]?.position ?? -1,
        lastTerminals[0]?.position ?? -1,
        lastExplorers[0]?.position ?? -1,
        lastBrowsers[0]?.position ?? -1,
        lastViews[0]?.position ?? -1,
      ) + 1;
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.projectViews).values({
        id: desktopId,
        projectId,
        title: "Remote Desktop",
        kind: "remote-desktop",
        worktreeId: null,
        position,
      });
      await transaction.insert(schema.remoteSurfaces).values({
        id: desktopId,
        projectId,
        workerId,
        kind: "desktop",
        title: "Remote Desktop",
        preferredTransport: "webrtc",
        configuration: {
          kind: "desktop",
        },
      });
    });
    return this.getRemoteDesktop(ownerId, desktopId);
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
    const selected =
      input.kind === "history" && input.worktreeId
        ? await this.getProjectWorktreeContext(
            ownerId,
            projectId,
            input.worktreeId,
          )
        : null;
    const source =
      input.kind === "history" && !input.worktreeId
        ? await this.getProjectSource(ownerId, projectId)
        : null;
    const worktreeId = selected?.worktree.id ?? source?.worktreeId ?? null;
    if (
      input.kind === "history" &&
      (!worktreeId ||
        (selected && selected.worktree.lifecycleState !== "ready"))
    )
      return null;
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
        worktreeId: input.kind === "history" ? worktreeId : null,
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
    const result = await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(schema.projectViews)
        .set({ title: input.title, updatedAt: new Date() })
        .where(eq(schema.projectViews.id, viewId))
        .returning();
      await transaction
        .update(schema.remoteSurfaces)
        .set({ title: input.title, updatedAt: new Date() })
        .where(eq(schema.remoteSurfaces.id, viewId));
      return updated;
    });
    return result[0] ? toProjectViewSummary(result[0]) : null;
  }

  async updateProjectViewWorktree(
    ownerId: string,
    viewId: string,
    input: WorktreeSelection,
  ): Promise<ProjectViewSummary | null> {
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
      .where(eq(schema.projectViews.id, viewId))
      .limit(1);
    const view = rows[0]?.view;
    if (!view) return null;
    if (view.kind !== "history") {
      throw new Error("This project view does not use worktrees.");
    }
    const target = await this.getProjectWorktreeContext(
      ownerId,
      view.projectId,
      input.worktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;
    const updated = await this.database
      .update(schema.projectViews)
      .set({ worktreeId: target.worktree.id, updatedAt: new Date() })
      .where(eq(schema.projectViews.id, viewId))
      .returning();
    return updated[0] ? toProjectViewSummary(updated[0]) : null;
  }

  async deleteProjectView(ownerId: string, viewId: string): Promise<boolean> {
    if (!(await this.projectViewIsOwnedBy(ownerId, viewId))) return false;
    const result = await this.database.transaction(async (transaction) => {
      await transaction
        .delete(schema.remoteSurfaces)
        .where(eq(schema.remoteSurfaces.id, viewId));
      return transaction
        .delete(schema.projectViews)
        .where(eq(schema.projectViews.id, viewId))
        .returning({ id: schema.projectViews.id });
    });
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

  async setChatAutomationPaused(
    ownerId: string,
    chatId: string,
    paused: boolean,
  ): Promise<ChatSummary | null> {
    const rows = await this.database
      .update(schema.chats)
      .set({ automationPaused: paused, updatedAt: new Date() })
      .where(
        and(
          eq(schema.chats.id, chatId),
          inArray(
            schema.chats.projectId,
            this.database
              .select({ id: schema.projects.id })
              .from(schema.projects)
              .where(eq(schema.projects.ownerId, ownerId)),
          ),
        ),
      )
      .returning();
    return rows[0] ? toChatSummary(rows[0]) : null;
  }

  async updateChatWorktree(
    ownerId: string,
    chatId: string,
    input: ChatWorktreeUpdate,
  ): Promise<ChatSummary | null> {
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
    const target = await this.getProjectWorktreeContext(
      ownerId,
      chat.projectId,
      input.worktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;

    const changingWorktree = chat.activeWorktreeId !== target.worktree.id;
    if (
      changingWorktree &&
      chatIsExecuting(chat.status as ChatSummary["status"])
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
          worktreeMode: input.mode,
          updatedAt: new Date(),
        })
        .where(eq(schema.chats.id, chatId))
        .returning();
      return updated[0] ? toChatSummary(updated[0]) : null;
    });
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
    if (chatIsExecuting(chat.status as ChatSummary["status"])) return "running";
    await this.database.delete(schema.chats).where(eq(schema.chats.id, chatId));
    return true;
  }

  async forkChat(
    ownerId: string,
    chatId: string,
    input: ChatFork,
  ): Promise<ChatSummary | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
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
      const row = rows[0];
      if (!row) return null;

      const targetRows = await transaction
        .select({ worktree: schema.projectWorktrees })
        .from(schema.projectWorktrees)
        .innerJoin(
          schema.projectSources,
          and(
            eq(
              schema.projectSources.id,
              schema.projectWorktrees.projectSourceId,
            ),
            eq(schema.projectSources.projectId, row.chat.projectId),
          ),
        )
        .where(
          eq(
            schema.projectWorktrees.id,
            input.worktreeId ?? row.chat.activeWorktreeId,
          ),
        )
        .limit(1);
      const target = targetRows[0]?.worktree;
      if (!target || target.lifecycleState !== "ready") return null;

      let throughSequence: number | null = null;
      if (input.messageId) {
        const selected = await transaction
          .select({ sequence: schema.chatMessages.sequence })
          .from(schema.chatMessages)
          .where(
            and(
              eq(schema.chatMessages.id, input.messageId),
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
          activeWorkerId: target.workerId,
          activeWorktreeId: target.id,
          worktreeMode: input.worktreeMode ?? row.chat.worktreeMode,
          modelId: row.chat.modelId,
        })
        .returning();
      const fork = firstOrThrow(chatResult, "forking a chat");
      const runtimeSessionId = randomUUID();
      await transaction.insert(schema.chatRuntimeSessions).values({
        id: runtimeSessionId,
        chatId: fork.id,
        workerId: target.workerId,
        worktreeId: target.id,
      });
      await transaction.insert(schema.chatExecutionLanes).values({
        id: randomUUID(),
        chatId: fork.id,
        worktreeId: target.id,
        workerId: target.workerId,
        acquiringActor: "user",
        exclusive: !target.isPrimary,
        purpose: `Forked from ${row.chat.id}`,
        state: "suspended",
        startingHead: target.head,
        runtimeSessionId,
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

  async getChatPlanState(
    ownerId: string,
    chatId: string,
  ): Promise<ChatPlanState | null> {
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
    return chat
      ? {
          mode: chat.planMode as PlanMode,
          explanation: chat.planExplanation,
          steps: chat.planSteps,
          question: chat.pendingPlanQuestion,
        }
      : null;
  }

  async updateChatPlanMode(
    ownerId: string,
    chatId: string,
    mode: PlanMode,
  ): Promise<ChatPlanState | null> {
    const current = await this.getChatPlanState(ownerId, chatId);
    if (!current) return null;
    await this.database
      .update(schema.chats)
      .set({
        planMode: mode,
        ...(mode === "default"
          ? { planExplanation: null, planSteps: [], pendingPlanQuestion: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId));
    return this.getChatPlanState(ownerId, chatId);
  }

  async updateChatPlanSnapshot(
    chatId: string,
    explanation: string | null,
    steps: PlanStep[],
  ): Promise<void> {
    await this.database
      .update(schema.chats)
      .set({
        planExplanation: explanation,
        planSteps: steps,
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId));
  }

  async setPendingPlanQuestion(
    chatId: string,
    question: PendingPlanQuestion | null,
  ): Promise<void> {
    await this.database
      .update(schema.chats)
      .set({ pendingPlanQuestion: question, updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
  }

  async getChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionContext | null> {
    const rows = await this.database
      .select({
        chat: schema.chats,
        lane: schema.chatExecutionLanes,
        project: schema.projects,
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
      .leftJoin(
        schema.chatExecutionLanes,
        and(
          eq(schema.chatExecutionLanes.chatId, schema.chats.id),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .where(eq(schema.chats.id, chatId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      automationPaused: row.chat.automationPaused,
      chatId: row.chat.id,
      cwd: row.worktree.absolutePath,
      executionLaneId: row.lane?.id ?? null,
      isPrimary: row.worktree.isPrimary,
      modelId: row.chat.modelId,
      modelRouteId: row.runtime?.modelRouteId ?? null,
      planMode: row.chat.planMode as PlanMode,
      pendingPlanQuestion: row.chat.pendingPlanQuestion,
      projectId: row.chat.projectId,
      status: row.chat.status as ChatSummary["status"],
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.worktree.workerId,
      worktreeId: row.worktree.id,
      worktreeMode: row.chat.worktreeMode as ChatSummary["worktreeMode"],
      worktreePolicy: row.project.worktreePolicy as WorktreePolicy,
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
    const rows = await this.database
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
          eq(schema.chatExecutionLanes.worktreeId, worktreeId),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      );
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

  async recordAgentInteractionRequest(
    input: AgentInteractionRequestCreate,
  ): Promise<AgentInteractionRequest> {
    const scopes = await this.database
      .select({ projectId: schema.projects.id })
      .from(schema.projects)
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, input.provenance.workerId),
          eq(schema.workers.ownerId, schema.projects.ownerId),
        ),
      )
      .where(eq(schema.projects.id, input.projectId))
      .limit(1);
    if (!scopes[0]) {
      throw new AgentInteractionConflictError(
        "Interaction worker does not belong to the project owner.",
      );
    }
    if (input.provenance.chatId) {
      const chats = await this.database
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.provenance.chatId),
            eq(schema.chats.projectId, input.projectId),
          ),
        )
        .limit(1);
      if (!chats[0]) {
        throw new AgentInteractionConflictError(
          "Interaction provenance does not match the project chat.",
        );
      }
    }

    const now = new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const expiredAtCreation = expiresAt !== null && expiresAt <= now;
    const rows = await this.database
      .insert(schema.agentInteractionRequests)
      .values({
        id: randomUUID(),
        requestKey: input.requestKey,
        projectId: input.projectId,
        chatId: input.provenance.chatId,
        workerId: input.provenance.workerId,
        executionLaneId: input.provenance.executionLaneId,
        threadId: input.provenance.threadId,
        turnId: input.provenance.turnId,
        itemId: input.provenance.itemId,
        workflowRunId: input.provenance.workflowRunId,
        workflowNodeId: input.provenance.workflowNodeId,
        kind: input.payload.kind,
        status: expiredAtCreation ? "expired" : "pending",
        payload: input.payload,
        expiresAt,
        resolvedAt: expiredAtCreation ? now : null,
      })
      .onConflictDoNothing({
        target: schema.agentInteractionRequests.requestKey,
      })
      .returning();
    const inserted = Boolean(rows[0]);
    let request = rows[0];
    if (!request) {
      const existing = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.requestKey, input.requestKey))
        .limit(1);
      request = firstOrThrow(existing, "reading an interaction request");
    }
    const normalized = toAgentInteractionRequest(request);
    if (
      !inserted &&
      (normalized.projectId !== input.projectId ||
        JSON.stringify(normalized.provenance) !==
          JSON.stringify(input.provenance) ||
        JSON.stringify(normalized.payload) !== JSON.stringify(input.payload) ||
        normalized.expiresAt !== (expiresAt?.toISOString() ?? null))
    ) {
      throw new AgentInteractionConflictError(
        "Interaction request key was reused with different request data.",
      );
    }
    if (input.provenance.chatId && request.status === "pending") {
      await this.database
        .update(schema.chats)
        .set({ status: "waiting-for-approval", updatedAt: new Date() })
        .where(eq(schema.chats.id, input.provenance.chatId));
    }
    return normalized;
  }

  async listAgentInteractionRequests(
    ownerId: string,
    query: AgentInteractionRequestQuery,
  ): Promise<AgentInteractionRequest[]> {
    await this.expireAgentInteractionRequests();
    const conditions = [eq(schema.projects.ownerId, ownerId)];
    if (query.chatId) {
      conditions.push(eq(schema.agentInteractionRequests.chatId, query.chatId));
    }
    if (query.status) {
      conditions.push(eq(schema.agentInteractionRequests.status, query.status));
    }
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.agentInteractionRequests.projectId),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.agentInteractionRequests.createdAt))
      .limit(query.limit);
    return rows.map(({ request }) => toAgentInteractionRequest(request));
  }

  async getAgentInteractionRequest(
    ownerId: string,
    requestId: string,
  ): Promise<AgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.agentInteractionRequests.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.agentInteractionRequests.id, requestId))
      .limit(1);
    return rows[0] ? toAgentInteractionRequest(rows[0].request) : null;
  }

  async resolveAgentInteractionRequest(
    ownerId: string,
    requestId: string,
    input: AgentInteractionResolutionCreate,
  ): Promise<AgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const existing = await this.getAgentInteractionRequest(ownerId, requestId);
    if (!existing) return null;
    validateAgentInteractionResponse(existing.payload, input.response);
    const storedResponse = agentInteractionResponseForStorage(
      existing.payload,
      input.response,
    );
    if (existing.status !== "pending") {
      const rows = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.id, requestId))
        .limit(1);
      const row = firstOrThrow(rows, "reading a resolved interaction request");
      if (
        row.resolutionIdempotencyKey === input.idempotencyKey &&
        JSON.stringify(row.response) === JSON.stringify(storedResponse)
      ) {
        return toAgentInteractionRequest(row);
      }
      throw new AgentInteractionConflictError(
        `Interaction request is already ${existing.status}.`,
      );
    }

    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({
        status: "resolved",
        response: storedResponse,
        resolutionIdempotencyKey: input.idempotencyKey,
        resolvedByUserId: ownerId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.agentInteractionRequests.id, requestId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new AgentInteractionConflictError(
        "Interaction request was resolved concurrently.",
      );
    }
    if (rows[0].chatId) {
      await this.restoreChatAfterInteractions(rows[0].chatId);
    }
    return toAgentInteractionRequest(rows[0]);
  }

  async expireAgentInteractionRequests(
    now = new Date(),
  ): Promise<AgentInteractionRequest[]> {
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status: "expired", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.status, "pending"),
          lte(schema.agentInteractionRequests.expiresAt, now),
        ),
      )
      .returning();
    const chatIds = new Set(
      rows.flatMap((request) => (request.chatId ? [request.chatId] : [])),
    );
    for (const chatId of chatIds) {
      await this.restoreChatAfterInteractions(chatId);
    }
    return rows.map(toAgentInteractionRequest);
  }

  async interruptAgentInteractionRequests(
    chatId: string,
  ): Promise<AgentInteractionRequest[]> {
    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status: "interrupted", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    return rows.map(toAgentInteractionRequest);
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
      .select({ id: schema.chats.id, projectId: schema.chats.projectId })
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
            eq(schema.projectSources.projectId, chat[0].projectId),
          ),
        )
        .where(
          and(
            eq(schema.projectWorktrees.id, input.worktreeId),
            eq(schema.projectWorktrees.lifecycleState, "ready"),
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
        modelId,
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
    attribution?: ChatExecutionAttribution,
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
              eq(schema.chatExecutionLanes.worktreeId, chat[0].worktreeId),
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
        worktreeId: attribution?.worktreeId ?? chat[0].worktreeId,
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
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessage | null> {
    const existing = await this.getMessageByIdempotencyKey(
      ownerId,
      chatId,
      input.idempotencyKey,
    );
    if (!existing) {
      return this.appendMessage(ownerId, chatId, input, attribution);
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

  private async restoreChatAfterInteractions(chatId: string): Promise<void> {
    const pending = await this.database
      .select({ id: schema.agentInteractionRequests.id })
      .from(schema.agentInteractionRequests)
      .where(
        and(
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (pending[0]) return;
    await this.database
      .update(schema.chats)
      .set({ status: "running", updatedAt: new Date() })
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.status, "waiting-for-approval"),
        ),
      );
  }
}
