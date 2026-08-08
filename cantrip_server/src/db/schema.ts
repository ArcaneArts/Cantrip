import type {
  AgentInteractionRequestPayload,
  AgentInteractionResponse,
  ChatAttachmentKind,
  ChatAttachmentSource,
  ChatAttachmentSummary,
  ChatMessageContent,
  ChatTurnMode,
  CodexRuntimeReport,
  PendingPlanQuestion,
  PlanStep,
  RemoteSurfaceCapabilities,
  RemoteSurfaceConfiguration,
} from "@cantrip/protocol";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const unprobedCodexRuntimeReport = {
  adapter: "app-server",
  compatibility: "missing",
  version: null,
  testedRange: ">=0.146.0 <0.147.0",
  initialize: null,
  methods: {},
  features: [],
  degradedReasons: ["This worker has not reported runtime compatibility."],
} satisfies CodexRuntimeReport;

export const systemState = pgTable("system_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  displayName: text("display_name").notNull(),
  email: text("email").unique(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const modelProviders = pgTable(
  "model_providers",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKey: text("api_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_providers_owner_name_unique").on(
      table.ownerId,
      table.name,
    ),
  ],
);

export const modelProfiles = pgTable("model_profiles", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  reasoningEffort: text("reasoning_effort"),
  routingPolicy: text("routing_policy").notNull().default("priority"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const modelRoutes = pgTable(
  "model_routes",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id")
      .notNull()
      .references(() => modelProfiles.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    modelName: text("model_name").notNull(),
    position: integer("position").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    reasoningEffort: text("reasoning_effort"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_routes_model_position_unique").on(
      table.modelId,
      table.position,
    ),
  ],
);

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: text("theme").notNull().default("system"),
  highContrast: boolean("high_contrast").notNull().default(false),
  desktopFrameRate: integer("desktop_frame_rate").notNull().default(30),
  desktopStreamQuality: text("desktop_stream_quality")
    .notNull()
    .default("adaptive"),
  defaultModelId: text("default_model_id").references(() => modelProfiles.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  architecture: text("architecture").notNull(),
  codexVersion: text("codex_version"),
  codexRuntime: jsonb("codex_runtime")
    .$type<CodexRuntimeReport>()
    .notNull()
    .default(unprobedCodexRuntimeReport),
  remoteSurfaceCapabilities: jsonb("remote_surface_capabilities")
    .$type<RemoteSurfaceCapabilities>()
    .notNull()
    .default({
      browser: false,
      desktop: false,
      transports: ["websocket"],
      maxSessions: 4,
    }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    setupStatus: text("setup_status").notNull().default("ready"),
    setupError: text("setup_error"),
    worktreePolicy: text("worktree_policy").notNull().default("agent-managed"),
    githubRepositoryId: text("github_repository_id"),
    githubRepositoryFullName: text("github_repository_full_name"),
    githubRepositoryUrl: text("github_repository_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("projects_owner_github_repository_unique").on(
      table.ownerId,
      table.githubRepositoryId,
    ),
  ],
);

export const projectSources = pgTable(
  "project_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    absolutePath: text("absolute_path").notNull(),
    displayPath: text("display_path").notNull(),
    repositoryFingerprint: text("repository_fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_sources_project_unique").on(table.projectId),
  ],
);

export const projectWorktrees = pgTable(
  "project_worktrees",
  {
    id: text("id").primaryKey(),
    projectSourceId: text("project_source_id")
      .notNull()
      .references(() => projectSources.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    absolutePath: text("absolute_path").notNull(),
    displayPath: text("display_path").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    origin: text("origin").notNull(),
    lifecycleState: text("lifecycle_state").notNull().default("creating"),
    branch: text("branch"),
    head: text("head"),
    detached: boolean("detached").notNull().default(false),
    locked: boolean("locked").notNull().default(false),
    lockReason: text("lock_reason"),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_worktrees_source_path_unique").on(
      table.projectSourceId,
      table.absolutePath,
    ),
    uniqueIndex("project_worktrees_source_primary_unique")
      .on(table.projectSourceId)
      .where(sql`${table.isPrimary} = true`),
    uniqueIndex("project_worktrees_source_default_unique")
      .on(table.projectSourceId)
      .where(sql`${table.isDefault} = true`),
  ],
);

export const chats = pgTable("chats", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  status: text("status").notNull().default("idle"),
  activeWorkerId: text("active_worker_id").references(() => workers.id, {
    onDelete: "set null",
  }),
  activeWorktreeId: text("active_worktree_id")
    .notNull()
    .references(() => projectWorktrees.id, { onDelete: "restrict" }),
  worktreeMode: text("worktree_mode").notNull().default("agent-managed"),
  modelId: text("model_id").references(() => modelProfiles.id, {
    onDelete: "restrict",
  }),
  permissionProfileId: text("permission_profile_id"),
  automationPaused: boolean("automation_paused").notNull().default(false),
  planMode: text("plan_mode").notNull().default("default"),
  planExplanation: text("plan_explanation"),
  planSteps: jsonb("plan_steps").$type<PlanStep[]>().notNull().default([]),
  pendingPlanQuestion: jsonb(
    "pending_plan_question",
  ).$type<PendingPlanQuestion | null>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const terminals = pgTable("terminals", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  status: text("status").notNull().default("idle"),
  activeWorkerId: text("active_worker_id")
    .notNull()
    .references(() => workers.id, { onDelete: "cascade" }),
  worktreeId: text("worktree_id")
    .notNull()
    .references(() => projectWorktrees.id, { onDelete: "restrict" }),
  linkedChatId: text("linked_chat_id")
    .unique()
    .references(() => chats.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const explorers = pgTable("explorers", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  activeWorkerId: text("active_worker_id")
    .notNull()
    .references(() => workers.id, { onDelete: "cascade" }),
  worktreeId: text("worktree_id")
    .notNull()
    .references(() => projectWorktrees.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const browsers = pgTable("browsers", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  position: integer("position").notNull().default(0),
  url: text("url").notNull().default("https://example.com/"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const remoteSurfaces = pgTable("remote_surfaces", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  workerId: text("worker_id")
    .notNull()
    .references(() => workers.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("idle"),
  preferredTransport: text("preferred_transport")
    .notNull()
    .default("websocket"),
  configuration: jsonb("configuration")
    .$type<RemoteSurfaceConfiguration>()
    .notNull(),
  lastError: text("last_error"),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const projectViews = pgTable("project_views", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  worktreeId: text("worktree_id").references(() => projectWorktrees.id, {
    onDelete: "restrict",
  }),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const chatRuntimeSessions = pgTable(
  "chat_runtime_sessions",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => projectWorktrees.id, { onDelete: "cascade" }),
    codexThreadId: text("codex_thread_id"),
    modelRouteId: text("model_route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("detached"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_runtime_sessions_chat_worker_worktree_unique").on(
      table.chatId,
      table.workerId,
      table.worktreeId,
    ),
  ],
);

export const chatExecutionLanes = pgTable(
  "chat_execution_lanes",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => projectWorktrees.id, { onDelete: "restrict" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    acquiringActor: text("acquiring_actor").notNull(),
    exclusive: boolean("exclusive").notNull().default(true),
    purpose: text("purpose"),
    state: text("state").notNull(),
    baseRevision: text("base_revision"),
    startingHead: text("starting_head"),
    runtimeSessionId: text("runtime_session_id").references(
      () => chatRuntimeSessions.id,
      { onDelete: "set null" },
    ),
    codexThreadId: text("codex_thread_id"),
    transitionKind: text("transition_kind"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_execution_lanes_chat_active_unique")
      .on(table.chatId)
      .where(sql`${table.state} = 'active'`),
    uniqueIndex("chat_execution_lanes_chat_delivering_unique")
      .on(table.chatId)
      .where(sql`${table.state} = 'delivering'`),
    uniqueIndex("chat_execution_lanes_worktree_reserved_unique")
      .on(table.worktreeId)
      .where(sql`${table.exclusive} = true AND ${table.state} <> 'released'`),
  ],
);

export const agentInteractionRequests = pgTable(
  "agent_interaction_requests",
  {
    id: text("id").primaryKey(),
    requestKey: text("request_key").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chatId: text("chat_id").references(() => chats.id, {
      onDelete: "cascade",
    }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    executionLaneId: text("execution_lane_id").references(
      () => chatExecutionLanes.id,
      { onDelete: "set null" },
    ),
    threadId: text("thread_id").notNull(),
    turnId: text("turn_id"),
    itemId: text("item_id"),
    workflowRunId: text("workflow_run_id"),
    workflowNodeId: text("workflow_node_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<AgentInteractionRequestPayload>().notNull(),
    response: jsonb("response").$type<AgentInteractionResponse>(),
    resolutionIdempotencyKey: text("resolution_idempotency_key"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_interaction_requests_request_key_unique").on(
      table.requestKey,
    ),
    index("agent_interaction_requests_chat_status_index").on(
      table.chatId,
      table.status,
    ),
    index("agent_interaction_requests_expiry_index").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => projectWorktrees.id, { onDelete: "restrict" }),
    executionLaneId: text("execution_lane_id").references(
      () => chatExecutionLanes.id,
      { onDelete: "set null" },
    ),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    role: text("role").notNull(),
    mode: text("mode").$type<ChatTurnMode>().notNull().default("default"),
    content: jsonb("content").$type<ChatMessageContent>().notNull(),
    modelId: text("model_id").references(() => modelProfiles.id, {
      onDelete: "set null",
    }),
    modelRouteId: text("model_route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").references(() => modelProviders.id, {
      onDelete: "set null",
    }),
    providerName: text("provider_name"),
    providerModelName: text("provider_model_name"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_messages_chat_idempotency_unique").on(
      table.chatId,
      table.idempotencyKey,
    ),
  ],
);

export const chatAttachments = pgTable(
  "chat_attachments",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    kind: text("kind").$type<ChatAttachmentKind>().notNull(),
    source: text("source").$type<ChatAttachmentSource>().notNull(),
    status: text("status").notNull().default("ready"),
    previewText: text("preview_text"),
    sha256: text("sha256").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chat_attachments_chat_created_index").on(
      table.chatId,
      table.createdAt,
    ),
    index("chat_attachments_worker_index").on(table.workerId),
  ],
);

export const queuedPrompts = pgTable(
  "queued_prompts",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    mode: text("mode").$type<ChatTurnMode>().notNull().default("default"),
    attachments: jsonb("attachments")
      .$type<ChatAttachmentSummary[]>()
      .notNull()
      .default([]),
    modelId: text("model_id")
      .notNull()
      .references(() => modelProfiles.id, { onDelete: "restrict" }),
    worktreeId: text("worktree_id").references(() => projectWorktrees.id, {
      onDelete: "restrict",
    }),
    position: integer("position").notNull().default(0),
    frozen: boolean("frozen").notNull().default(false),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("queued_prompts_chat_idempotency_unique").on(
      table.chatId,
      table.idempotencyKey,
    ),
  ],
);

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    scope: text("scope").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    source: text("source").notNull().default("cantrip"),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    trustState: text("trust_state").notNull().default("untrusted"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_definitions_personal_slug_unique")
      .on(table.ownerId, table.slug)
      .where(sql`${table.scope} = 'personal' AND ${table.projectId} IS NULL`),
    uniqueIndex("workflow_definitions_project_slug_unique")
      .on(table.projectId, table.slug)
      .where(
        sql`${table.scope} = 'project' AND ${table.projectId} IS NOT NULL`,
      ),
    index("workflow_definitions_owner_scope_index").on(
      table.ownerId,
      table.scope,
      table.archivedAt,
    ),
    index("workflow_definitions_project_index").on(
      table.projectId,
      table.archivedAt,
    ),
    check(
      "workflow_definitions_scope_check",
      sql`${table.scope} IN ('personal', 'project')`,
    ),
    check(
      "workflow_definitions_scope_project_check",
      sql`(${table.scope} = 'personal' AND ${table.projectId} IS NULL) OR (${table.scope} = 'project' AND ${table.projectId} IS NOT NULL)`,
    ),
    check(
      "workflow_definitions_trust_state_check",
      sql`${table.trustState} IN ('untrusted', 'trusted', 'modified', 'blocked')`,
    ),
  ],
);

export const workflowRevisions = pgTable(
  "workflow_revisions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    declaredInputs: jsonb("declared_inputs")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    declaredOutputs: jsonb("declared_outputs")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    defaults: jsonb("defaults")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    permissionRequirements: jsonb("permission_requirements")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    source: text("source").notNull(),
    provenance: jsonb("provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    trustState: text("trust_state").notNull().default("untrusted"),
    contentHash: text("content_hash").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_revisions_workflow_revision_unique").on(
      table.workflowId,
      table.revision,
    ),
    uniqueIndex("workflow_revisions_workflow_hash_unique").on(
      table.workflowId,
      table.contentHash,
    ),
    index("workflow_revisions_workflow_created_index").on(
      table.workflowId,
      table.createdAt,
    ),
    check("workflow_revisions_revision_check", sql`${table.revision} > 0`),
    check(
      "workflow_revisions_trust_state_check",
      sql`${table.trustState} IN ('untrusted', 'trusted', 'modified', 'blocked')`,
    ),
  ],
);

export const workflowRevisionNodes = pgTable(
  "workflow_revision_nodes",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => workflowRevisions.id, { onDelete: "cascade" }),
    nodeKey: text("node_key").notNull(),
    nodeType: text("node_type").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    configuration: jsonb("configuration")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    inputSchema: jsonb("input_schema")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    outputSchema: jsonb("output_schema")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    permissionRequirements: jsonb("permission_requirements")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    mutationMode: text("mutation_mode").notNull().default("read-only"),
    modelRouteId: text("model_route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    permissionProfileId: text("permission_profile_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_revision_nodes_key_unique").on(
      table.revisionId,
      table.nodeKey,
    ),
    uniqueIndex("workflow_revision_nodes_position_unique").on(
      table.revisionId,
      table.position,
    ),
    check(
      "workflow_revision_nodes_position_check",
      sql`${table.position} >= 0`,
    ),
    check(
      "workflow_revision_nodes_mutation_mode_check",
      sql`${table.mutationMode} IN ('read-only', 'write')`,
    ),
  ],
);

export const workflowRevisionEdges = pgTable(
  "workflow_revision_edges",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => workflowRevisions.id, { onDelete: "cascade" }),
    fromNodeId: text("from_node_id")
      .notNull()
      .references(() => workflowRevisionNodes.id, { onDelete: "cascade" }),
    toNodeId: text("to_node_id")
      .notNull()
      .references(() => workflowRevisionNodes.id, { onDelete: "cascade" }),
    sourceOutput: text("source_output"),
    targetInput: text("target_input"),
    condition: jsonb("condition").$type<Record<string, unknown>>(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("workflow_revision_edges_from_index").on(
      table.revisionId,
      table.fromNodeId,
      table.position,
    ),
    index("workflow_revision_edges_to_index").on(
      table.revisionId,
      table.toNodeId,
    ),
    check(
      "workflow_revision_edges_position_check",
      sql`${table.position} >= 0`,
    ),
    check(
      "workflow_revision_edges_not_self_check",
      sql`${table.fromNodeId} <> ${table.toNodeId}`,
    ),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "restrict" }),
    workflowRevisionId: text("workflow_revision_id")
      .notNull()
      .references(() => workflowRevisions.id, { onDelete: "restrict" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("queued"),
    triggerType: text("trigger_type").notNull().default("manual"),
    triggerId: text("trigger_id"),
    triggerProvenance: jsonb("trigger_provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    idempotencyKey: text("idempotency_key").notNull(),
    structuredInput: jsonb("structured_input").$type<unknown>().notNull(),
    structuredResult: jsonb("structured_result").$type<unknown>(),
    budget: jsonb("budget")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    measuredUsage: jsonb("measured_usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    permissionManifest: jsonb("permission_manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    selectedModelRouteId: text("selected_model_route_id").references(
      () => modelRoutes.id,
      { onDelete: "set null" },
    ),
    selectedPermissionProfileId: text("selected_permission_profile_id"),
    workerId: text("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    worktreeId: text("worktree_id").references(() => projectWorktrees.id, {
      onDelete: "set null",
    }),
    codexThreadId: text("codex_thread_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    pauseReason: text("pause_reason"),
    cancelReason: text("cancel_reason"),
    recoveryState: text("recovery_state").notNull().default("stable"),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_runs_owner_idempotency_unique").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    index("workflow_runs_workflow_created_index").on(
      table.workflowId,
      table.createdAt,
    ),
    index("workflow_runs_project_status_index").on(
      table.projectId,
      table.status,
      table.createdAt,
    ),
    index("workflow_runs_recovery_index").on(
      table.recoveryState,
      table.updatedAt,
    ),
    check(
      "workflow_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'waiting', 'paused', 'cancelling', 'cancelled', 'failed', 'completed', 'recovering')`,
    ),
    check(
      "workflow_runs_recovery_state_check",
      sql`${table.recoveryState} IN ('stable', 'pending', 'recovering', 'blocked')`,
    ),
  ],
);

export const workflowRunNodes = pgTable(
  "workflow_run_nodes",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    revisionNodeId: text("revision_node_id")
      .notNull()
      .references(() => workflowRevisionNodes.id, { onDelete: "restrict" }),
    nodeKey: text("node_key").notNull(),
    nodeType: text("node_type").notNull(),
    status: text("status").notNull().default("blocked"),
    dependencyState: jsonb("dependency_state")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    structuredInput: jsonb("structured_input").$type<unknown>().notNull(),
    structuredResult: jsonb("structured_result").$type<unknown>(),
    budget: jsonb("budget")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    measuredUsage: jsonb("measured_usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    permissionManifest: jsonb("permission_manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    workerId: text("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    worktreeId: text("worktree_id").references(() => projectWorktrees.id, {
      onDelete: "set null",
    }),
    modelRouteId: text("model_route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    permissionProfileId: text("permission_profile_id"),
    codexThreadId: text("codex_thread_id"),
    codexTurnId: text("codex_turn_id"),
    writeCapable: boolean("write_capable").notNull().default(false),
    executionLeaseKey: text("execution_lease_key"),
    attemptCount: integer("attempt_count").notNull().default(0),
    notBefore: timestamp("not_before", { withTimezone: true }),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    waitingAt: timestamp("waiting_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_run_nodes_key_unique").on(table.runId, table.nodeKey),
    uniqueIndex("workflow_run_nodes_revision_node_unique").on(
      table.runId,
      table.revisionNodeId,
    ),
    index("workflow_run_nodes_status_index").on(table.runId, table.status),
    index("workflow_run_nodes_worker_status_index").on(
      table.workerId,
      table.status,
    ),
    index("workflow_run_nodes_worktree_status_index").on(
      table.worktreeId,
      table.status,
    ),
    check(
      "workflow_run_nodes_status_check",
      sql`${table.status} IN ('blocked', 'ready', 'queued', 'running', 'waiting-for-approval', 'paused', 'cancelling', 'cancelled', 'failed', 'completed', 'retrying', 'recovering', 'skipped')`,
    ),
    check(
      "workflow_run_nodes_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

export const workflowRunNodeDependencies = pgTable(
  "workflow_run_node_dependencies",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    revisionEdgeId: text("revision_edge_id").references(
      () => workflowRevisionEdges.id,
      { onDelete: "set null" },
    ),
    fromNodeId: text("from_node_id")
      .notNull()
      .references(() => workflowRunNodes.id, { onDelete: "cascade" }),
    toNodeId: text("to_node_id")
      .notNull()
      .references(() => workflowRunNodes.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("blocked"),
    resultMapping: jsonb("result_mapping")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_run_node_dependencies_edge_unique").on(
      table.runId,
      table.fromNodeId,
      table.toNodeId,
    ),
    index("workflow_run_node_dependencies_target_index").on(
      table.runId,
      table.toNodeId,
      table.status,
    ),
    check(
      "workflow_run_node_dependencies_status_check",
      sql`${table.status} IN ('blocked', 'ready', 'satisfied', 'failed', 'skipped')`,
    ),
    check(
      "workflow_run_node_dependencies_not_self_check",
      sql`${table.fromNodeId} <> ${table.toNodeId}`,
    ),
  ],
);

export const workflowNodeAttempts = pgTable(
  "workflow_node_attempts",
  {
    id: text("id").primaryKey(),
    runNodeId: text("run_node_id")
      .notNull()
      .references(() => workflowRunNodes.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    structuredInput: jsonb("structured_input").$type<unknown>().notNull(),
    structuredResult: jsonb("structured_result").$type<unknown>(),
    measuredUsage: jsonb("measured_usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    workerId: text("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    worktreeId: text("worktree_id").references(() => projectWorktrees.id, {
      onDelete: "set null",
    }),
    modelRouteId: text("model_route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    permissionProfileId: text("permission_profile_id"),
    codexThreadId: text("codex_thread_id"),
    codexTurnId: text("codex_turn_id"),
    startingRevision: text("starting_revision"),
    endingRevision: text("ending_revision"),
    worktreeDirty: boolean("worktree_dirty"),
    producedChanges: jsonb("produced_changes")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_node_attempts_number_unique").on(
      table.runNodeId,
      table.attempt,
    ),
    uniqueIndex("workflow_node_attempts_idempotency_unique").on(
      table.runNodeId,
      table.idempotencyKey,
    ),
    index("workflow_node_attempts_recovery_index").on(
      table.status,
      table.heartbeatAt,
    ),
    check("workflow_node_attempts_attempt_check", sql`${table.attempt} > 0`),
    check(
      "workflow_node_attempts_status_check",
      sql`${table.status} IN ('queued', 'running', 'waiting-for-approval', 'cancelled', 'failed', 'completed', 'timed-out', 'interrupted', 'orphaned')`,
    ),
  ],
);

export const workflowRunEvents = pgTable(
  "workflow_run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    runNodeId: text("run_node_id").references(() => workflowRunNodes.id, {
      onDelete: "set null",
    }),
    attemptId: text("attempt_id").references(() => workflowNodeAttempts.id, {
      onDelete: "set null",
    }),
    sequence: integer("sequence").notNull(),
    eventKey: text("event_key").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_run_events_sequence_unique").on(
      table.runId,
      table.sequence,
    ),
    uniqueIndex("workflow_run_events_key_unique").on(
      table.runId,
      table.eventKey,
    ),
    index("workflow_run_events_node_created_index").on(
      table.runNodeId,
      table.createdAt,
    ),
    index("workflow_run_events_type_created_index").on(
      table.type,
      table.createdAt,
    ),
    check("workflow_run_events_sequence_check", sql`${table.sequence} >= 0`),
  ],
);

export const workflowApprovalGates = pgTable(
  "workflow_approval_gates",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    runNodeId: text("run_node_id").references(() => workflowRunNodes.id, {
      onDelete: "set null",
    }),
    gateKey: text("gate_key").notNull(),
    status: text("status").notNull().default("pending"),
    prompt: text("prompt").notNull(),
    permissionManifest: jsonb("permission_manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    interactionRequestId: text("interaction_request_id").references(
      () => agentInteractionRequests.id,
      { onDelete: "set null" },
    ),
    requestedByType: text("requested_by_type").notNull(),
    requestedById: text("requested_by_id"),
    decision: text("decision"),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decisionReason: text("decision_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_approval_gates_key_unique").on(
      table.runId,
      table.gateKey,
    ),
    uniqueIndex("workflow_approval_gates_interaction_unique").on(
      table.interactionRequestId,
    ),
    index("workflow_approval_gates_status_expiry_index").on(
      table.status,
      table.expiresAt,
    ),
    check(
      "workflow_approval_gates_status_check",
      sql`${table.status} IN ('pending', 'approved', 'denied', 'expired', 'cancelled')`,
    ),
    check(
      "workflow_approval_gates_decision_check",
      sql`${table.decision} IS NULL OR ${table.decision} IN ('approved', 'denied')`,
    ),
  ],
);
