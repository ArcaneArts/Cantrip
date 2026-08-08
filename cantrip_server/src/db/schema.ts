import type {
  ChatMessageContent,
  RemoteSurfaceCapabilities,
  RemoteSurfaceConfiguration,
} from "@cantrip/protocol";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
  remoteSurfaceCapabilities: jsonb("remote_surface_capabilities")
    .$type<RemoteSurfaceCapabilities>()
    .notNull()
    .default({
      browser: false,
      vnc: false,
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

export const queuedPrompts = pgTable(
  "queued_prompts",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
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
