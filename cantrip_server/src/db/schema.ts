import type {
  AgentInteractionRequestPayload,
  AgentInteractionResponse,
  ChatAttachmentKind,
  ChatAttachmentSource,
  ChatAttachmentSummary,
  ChatImportError,
  ChatImportProgress,
  ChatImportState,
  ChatMessageContent,
  ChatRelocationContextPayload,
  ChatRelocationErrorCode,
  ChatRelocationProgress,
  ChatRelocationState,
  ChatTurnMode,
  CodeCapabilities,
  CodexRuntimeReport,
  DirectBrokerAdvertisement,
  GitManagedOperationState,
  GitManagedOperationType,
  GitInteractiveRebaseTodoAction,
  ManagedFolderCapabilities,
  MobileProjectTabConfigurations,
  ModelReasoningEffortOption,
  PendingPlanQuestion,
  PlanStep,
  ProjectOriginKind,
  ProjectFolderSetupJobError,
  ProjectFolderSetupJobState,
  ProjectReplicaCapabilities,
  ProjectReplicaJobErrorCode,
  ProjectReplicaJobKind,
  ProjectReplicaJobProgress,
  ProjectReplicaJobState,
  ProjectRootKind,
  ProjectSourceKind,
  RemoteSurfaceCapabilities,
  RemoteSurfaceConfiguration,
  ExecutionPlacement,
  ExternalChatSourceKind,
  ExternalChatTranscriptMetadata,
  TunnelDestinationEndpoint,
  TunnelSourceEndpoint,
  WorktreeStatusResult,
} from "@cantrip/protocol";
import type {
  TaskLastError,
  TaskOperationKind,
  TaskPlanAuthorship,
  TaskPlanningRoundStatus,
  TaskQuestion,
  TaskQuestionAnswer,
  TaskStableState,
  TaskState,
} from "@cantrip/protocol/tasks";
import type {
  ProjectAutomationCondition,
  ProjectAutomationSchedule,
} from "@cantrip/protocol/automations";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const unprobedCodexRuntimeReport = {
  adapter: "app-server",
  compatibility: "missing",
  version: null,
  testedRange: ">=0.147.0 <0.148.0",
  initialize: null,
  methods: {},
  features: [],
  degradedReasons: ["This worker has not reported runtime compatibility."],
} satisfies CodexRuntimeReport;

const unavailableCodeCapabilities = {
  available: false,
  version: null,
  upstreamRevision: null,
  patchset: 0,
  transport: "web-proxy",
  maxSessions: 1,
  reason: "This worker has not reported Cantrip Code capability.",
} satisfies CodeCapabilities;

const unavailableProjectReplicaCapabilities = {
  provision: false,
  synchronize: false,
  remove: false,
  exactRevision: false,
} satisfies ProjectReplicaCapabilities;

const unavailableManagedFolderCapabilities = {
  create: false,
  remove: false,
} satisfies ManagedFolderCapabilities;

const unavailableDirectBroker = {
  available: false,
} satisfies DirectBrokerAdvertisement;

export const systemState = pgTable("system_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    displayName: text("display_name").notNull(),
    email: text("email").unique(),
    normalizedEmail: text("normalized_email"),
    passwordHash: text("password_hash"),
    passwordChangedAt: timestamp("password_changed_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_normalized_email_unique")
      .on(table.normalizedEmail)
      .where(sql`${table.normalizedEmail} IS NOT NULL`),
    check("users_kind_check", sql`${table.kind} IN ('anonymous', 'account')`),
    check(
      "users_role_check",
      sql`${table.role} IN ('owner', 'admin', 'member')`,
    ),
    check("users_status_check", sql`${table.status} IN ('active', 'disabled')`),
    check(
      "users_account_email_check",
      sql`${table.kind} <> 'account' OR ${table.normalizedEmail} IS NOT NULL`,
    ),
  ],
);

export const accountLicenseWhitelist = pgTable(
  "account_license_whitelist",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    addedByUserId: text("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("account_license_whitelist_normalized_email_unique").on(
      table.normalizedEmail,
    ),
    index("account_license_whitelist_created_at_index").on(table.createdAt),
  ],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    authMethod: text("auth_method").notNull(),
    label: text("label"),
    userAgentHash: text("user_agent_hash"),
    ipAddressHash: text("ip_address_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_unique").on(table.tokenHash),
    index("user_sessions_user_active_index").on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
    ),
    check(
      "user_sessions_auth_method_check",
      sql`${table.authMethod} IN ('password', 'account-password', 'mobile-qr')`,
    ),
  ],
);

export const mobileSignInGrants = pgTable(
  "mobile_sign_in_grants",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBySessionId: text("created_by_session_id").references(
      () => userSessions.id,
      { onDelete: "set null" },
    ),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mobile_sign_in_grants_hash_unique").on(table.codeHash),
    index("mobile_sign_in_grants_owner_expiry_index").on(
      table.ownerId,
      table.expiresAt,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ownerId: text("owner_id"),
    actorUserId: text("actor_user_id"),
    actorSessionId: text("actor_session_id"),
    action: text("action").notNull(),
    result: text("result").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    requestId: text("request_id"),
    ipAddressHash: text("ip_address_hash"),
    userAgentHash: text("user_agent_hash"),
    metadata: jsonb("metadata")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_events_owner_cursor_index").on(table.ownerId, table.id),
    index("audit_events_action_cursor_index").on(table.action, table.id),
    index("audit_events_occurred_at_index").on(table.occurredAt),
    check(
      "audit_events_result_check",
      sql`${table.result} IN ('succeeded', 'failed', 'denied')`,
    ),
  ],
);

export const workerEnrollmentCodes = pgTable(
  "worker_enrollment_codes",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBySessionId: text("created_by_session_id").references(
      () => userSessions.id,
      { onDelete: "set null" },
    ),
    codeHash: text("code_hash").notNull(),
    label: text("label"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("worker_enrollment_codes_hash_unique").on(table.codeHash),
    index("worker_enrollment_codes_owner_expiry_index").on(
      table.ownerId,
      table.expiresAt,
    ),
  ],
);

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
    /** @deprecated Read only during the encrypted-secret data migration. */
    apiKey: text("api_key"),
    apiKeyEnvelope: text("api_key_envelope"),
    weeklyUsageReservePercent: integer("weekly_usage_reserve_percent")
      .notNull()
      .default(3),
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
    uniqueIndex("model_providers_owner_chatgpt_unique")
      .on(table.ownerId)
      .where(sql`${table.kind} = 'chatgpt'`),
    uniqueIndex("model_providers_owner_grok_unique")
      .on(table.ownerId)
      .where(sql`${table.kind} = 'grok'`),
    check(
      "model_providers_weekly_usage_reserve_percent_check",
      sql`${table.weeklyUsageReservePercent} BETWEEN 0 AND 100`,
    ),
  ],
);

export const modelProviderAccounts = pgTable(
  "model_provider_accounts",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    email: text("email"),
    planType: text("plan_type"),
    position: integer("position").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Existing ChatGPT providers can retain their provider-keyed Codex home
     * while the pooled-account migration moves them without losing auth.
     */
    credentialHomeKey: text("credential_home_key").notNull(),
    credentialEnvelope: text("credential_envelope"),
    credentialRevision: integer("credential_revision").notNull().default(0),
    credentialState: text("credential_state").notNull().default("signed-out"),
    credentialSubject: text("credential_subject"),
    credentialExpiresAt: timestamp("credential_expires_at", {
      withTimezone: true,
    }),
    credentialUpdatedAt: timestamp("credential_updated_at", {
      withTimezone: true,
    }),
    credentialRefreshLeaseId: text("credential_refresh_lease_id"),
    credentialRefreshLeaseExpiresAt: timestamp(
      "credential_refresh_lease_expires_at",
      { withTimezone: true },
    ),
    credentialLastRefreshAt: timestamp("credential_last_refresh_at", {
      withTimezone: true,
    }),
    credentialLastRefreshError: text("credential_last_refresh_error"),
    weeklyUsageUsedBasisPoints: integer("weekly_usage_used_basis_points"),
    weeklyUsageResetsAt: timestamp("weekly_usage_resets_at", {
      withTimezone: true,
    }),
    weeklyUsageObservedAt: timestamp("weekly_usage_observed_at", {
      withTimezone: true,
    }),
    authLastSyncedAt: timestamp("auth_last_synced_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_provider_accounts_provider_position_unique").on(
      table.providerId,
      table.position,
    ),
    uniqueIndex("model_provider_accounts_provider_home_unique").on(
      table.providerId,
      table.credentialHomeKey,
    ),
    check(
      "model_provider_accounts_credential_state_check",
      sql`${table.credentialState} IN ('signed-out', 'migration-needed', 'signed-in', 'reauth-required', 'conflict')`,
    ),
    check(
      "model_provider_accounts_credential_revision_check",
      sql`${table.credentialRevision} >= 0`,
    ),
    check(
      "model_provider_accounts_usage_check",
      sql`${table.weeklyUsageUsedBasisPoints} IS NULL OR ${table.weeklyUsageUsedBasisPoints} BETWEEN 0 AND 10000`,
    ),
    check(
      "model_provider_accounts_refresh_lease_pair_check",
      sql`(${table.credentialRefreshLeaseId} IS NULL) = (${table.credentialRefreshLeaseExpiresAt} IS NULL)`,
    ),
  ],
);

export const modelProviderAccountWorkers = pgTable(
  "model_provider_account_workers",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => modelProviderAccounts.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    authState: text("auth_state").notNull().default("unknown"),
    weeklyUsageUsedBasisPoints: integer("weekly_usage_used_basis_points"),
    weeklyUsageResetsAt: timestamp("weekly_usage_resets_at", {
      withTimezone: true,
    }),
    weeklyUsageObservedAt: timestamp("weekly_usage_observed_at", {
      withTimezone: true,
    }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.workerId] }),
    index("model_provider_account_workers_worker_index").on(table.workerId),
    check(
      "model_provider_account_workers_auth_state_check",
      sql`${table.authState} IN ('unknown', 'signed-out', 'signed-in', 'failed')`,
    ),
    check(
      "model_provider_account_workers_usage_check",
      sql`${table.weeklyUsageUsedBasisPoints} IS NULL OR ${table.weeklyUsageUsedBasisPoints} BETWEEN 0 AND 10000`,
    ),
  ],
);

/**
 * Append-only meter readings reported by account-backed model providers.
 *
 * Provider, account, worker, and execution identifiers are deliberately stored
 * as historical dimensions instead of foreign keys. Removing a live provider,
 * account, worker, or chat must not erase or rewrite the measurements that were
 * observed while it existed. Deleting the owning Cantrip user still removes the
 * ledger for privacy.
 */
export const providerQuotaObservations = pgTable(
  "provider_quota_observations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    observationBatchKey: text("observation_batch_key").notNull(),
    providerId: text("provider_id").notNull(),
    providerName: text("provider_name").notNull(),
    providerKind: text("provider_kind").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    providerAccountLabel: text("provider_account_label").notNull(),
    workerId: text("worker_id"),
    workerName: text("worker_name"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    usedPercentMicros: integer("used_percent_micros").notNull(),
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    windowDurationMinutes: integer("window_duration_minutes"),
    limitId: text("limit_id"),
    limitName: text("limit_name"),
    windowKind: text("window_kind").notNull(),
    planType: text("plan_type"),
    reachedType: text("reached_type"),
    observationTrigger: text("observation_trigger").notNull(),
    isWeeklyProjection: boolean("is_weekly_projection")
      .notNull()
      .default(false),
    chatId: text("chat_id"),
    turnId: text("turn_id"),
    executionAttemptId: text("execution_attempt_id"),
    workerVersion: text("worker_version"),
    serverVersion: text("server_version"),
    codexVersion: text("codex_version"),
    sanitizedRawPayload: jsonb("sanitized_raw_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => [
    uniqueIndex("provider_quota_observations_owner_event_unique").on(
      table.ownerId,
      table.eventKey,
    ),
    index("provider_quota_observations_account_time_index").on(
      table.providerAccountId,
      table.observedAt,
    ),
    index("provider_quota_observations_provider_time_index").on(
      table.providerId,
      table.observedAt,
    ),
    index("provider_quota_observations_reset_window_index").on(
      table.providerAccountId,
      table.limitId,
      table.windowKind,
      table.resetsAt,
    ),
    index("provider_quota_observations_turn_index").on(
      table.chatId,
      table.turnId,
    ),
    index("provider_quota_observations_worker_time_index").on(
      table.workerId,
      table.observedAt,
    ),
    check(
      "provider_quota_observations_used_percent_check",
      sql`${table.usedPercentMicros} BETWEEN 0 AND 100000000`,
    ),
    check(
      "provider_quota_observations_window_duration_check",
      sql`${table.windowDurationMinutes} IS NULL OR ${table.windowDurationMinutes} >= 0`,
    ),
  ],
);

export const providerModels = pgTable(
  "provider_models",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    nativeModelId: text("native_model_id").notNull(),
    canonicalModelId: text("canonical_model_id"),
    displayName: text("display_name").notNull(),
    description: text("description"),
    contextWindow: integer("context_window"),
    maxOutputTokens: integer("max_output_tokens"),
    inputModalities: jsonb("input_modalities")
      .$type<string[]>()
      .notNull()
      .default(["text"]),
    outputModalities: jsonb("output_modalities")
      .$type<string[]>()
      .notNull()
      .default(["text"]),
    supportsTools: boolean("supports_tools"),
    supportsParallelTools: boolean("supports_parallel_tools"),
    supportsStructuredOutput: boolean("supports_structured_output"),
    supportsVision: boolean("supports_vision"),
    supportsReasoning: boolean("supports_reasoning"),
    supportedReasoningEfforts: jsonb("supported_reasoning_efforts")
      .$type<ModelReasoningEffortOption[]>()
      .notNull()
      .default([]),
    defaultReasoningEffort: text("default_reasoning_effort"),
    reasoningMandatory: boolean("reasoning_mandatory"),
    family: text("family"),
    parameterSize: text("parameter_size"),
    quantization: text("quantization"),
    digest: text("digest"),
    metadataSource: text("metadata_source").notNull(),
    matchConfidenceBasisPoints: integer("match_confidence_basis_points"),
    hidden: boolean("hidden").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    rawMetadata: jsonb("raw_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_models_provider_native_unique").on(
      table.providerId,
      table.nativeModelId,
    ),
    index("provider_models_canonical_index").on(table.canonicalModelId),
    check(
      "provider_models_metadata_source_check",
      sql`${table.metadataSource} IN ('ollama', 'openrouter', 'codex', 'grok', 'zai', 'compatible-api', 'manual')`,
    ),
    check(
      "provider_models_context_window_check",
      sql`${table.contextWindow} IS NULL OR ${table.contextWindow} > 0`,
    ),
    check(
      "provider_models_max_output_tokens_check",
      sql`${table.maxOutputTokens} IS NULL OR ${table.maxOutputTokens} > 0`,
    ),
    check(
      "provider_models_match_confidence_check",
      sql`${table.matchConfidenceBasisPoints} IS NULL OR ${table.matchConfidenceBasisPoints} BETWEEN 0 AND 10000`,
    ),
  ],
);

export const providerModelCatalogSnapshots = pgTable(
  "provider_model_catalog_snapshots",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    providerName: text("provider_name").notNull(),
    providerAccountId: text("provider_account_id"),
    workerId: text("worker_id"),
    availabilityScope: text("availability_scope").notNull(),
    nativeModelId: text("native_model_id").notNull(),
    canonicalModelId: text("canonical_model_id"),
    metadataSource: text("metadata_source").notNull(),
    metadataHash: text("metadata_hash").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_model_catalog_snapshots_version_unique").on(
      table.ownerId,
      table.providerId,
      table.availabilityScope,
      table.nativeModelId,
      table.metadataHash,
    ),
    index("provider_model_catalog_snapshots_model_time_index").on(
      table.ownerId,
      table.providerId,
      table.nativeModelId,
      table.observedAt,
    ),
    index("provider_model_catalog_snapshots_hash_index").on(table.metadataHash),
  ],
);

export const providerModelAvailability = pgTable(
  "provider_model_availability",
  {
    id: text("id").primaryKey(),
    providerModelId: text("provider_model_id")
      .notNull()
      .references(() => providerModels.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    workerId: text("worker_id").references(() => workers.id, {
      onDelete: "cascade",
    }),
    providerAccountId: text("provider_account_id").references(
      () => modelProviderAccounts.id,
      { onDelete: "cascade" },
    ),
    state: text("state").notNull().default("available"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_model_availability_model_scope_unique").on(
      table.providerModelId,
      table.scopeKey,
    ),
    index("provider_model_availability_worker_index").on(table.workerId),
    index("provider_model_availability_account_index").on(
      table.providerAccountId,
    ),
    check(
      "provider_model_availability_state_check",
      sql`${table.state} IN ('available', 'unavailable', 'stale')`,
    ),
  ],
);

export const providerCatalogSyncStates = pgTable(
  "provider_catalog_sync_states",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    workerId: text("worker_id").references(() => workers.id, {
      onDelete: "cascade",
    }),
    providerAccountId: text("provider_account_id").references(
      () => modelProviderAccounts.id,
      { onDelete: "cascade" },
    ),
    status: text("status").notNull().default("idle"),
    error: text("error"),
    etag: text("etag"),
    refreshStartedAt: timestamp("refresh_started_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_catalog_sync_states_provider_scope_unique").on(
      table.providerId,
      table.scopeKey,
    ),
    check(
      "provider_catalog_sync_states_status_check",
      sql`${table.status} IN ('idle', 'refreshing', 'current', 'stale', 'failed')`,
    ),
  ],
);

export const providerModelSuppressions = pgTable(
  "provider_model_suppressions",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerModelId: text("provider_model_id")
      .notNull()
      .references(() => providerModels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.providerModelId] })],
);

export const modelProfiles = pgTable("model_profiles", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  canonicalModelId: text("canonical_model_id"),
  defaultReasoningEffort: text("default_reasoning_effort"),
  discoveryManaged: boolean("discovery_managed").notNull().default(false),
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
    providerModelId: text("provider_model_id").references(
      () => providerModels.id,
      { onDelete: "set null" },
    ),
    modelName: text("model_name").notNull(),
    position: integer("position").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    discoveryManaged: boolean("discovery_managed").notNull().default(false),
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

export const userSettings = pgTable(
  "user_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    theme: text("theme").notNull().default("system"),
    highContrast: boolean("high_contrast").notNull().default(false),
    proMode: boolean("pro_mode").notNull().default(false),
    proModeOpacity: integer("pro_mode_opacity").notNull().default(80),
    sidebarWidth: integer("sidebar_width").notNull().default(288),
    desktopFrameRate: integer("desktop_frame_rate").notNull().default(30),
    desktopStreamQuality: text("desktop_stream_quality")
      .notNull()
      .default("adaptive"),
    defaultModelId: text("default_model_id").references(
      () => modelProfiles.id,
      {
        onDelete: "set null",
      },
    ),
    defaultPermissionProfileId: text("default_permission_profile_id")
      .notNull()
      .default(":workspace"),
    defaultWorkerId: text("default_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    automaticReplicaProvisioning: boolean("automatic_replica_provisioning")
      .notNull()
      .default(false),
    automaticReplicaSynchronization: text("automatic_replica_synchronization")
      .notNull()
      .default("off"),
    mobileProjectTabConfigurations: jsonb("mobile_project_tab_configurations")
      .$type<MobileProjectTabConfigurations>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "user_settings_pro_mode_opacity_check",
      sql`${table.proModeOpacity} BETWEEN 0 AND 100`,
    ),
    check(
      "user_settings_replica_synchronization_check",
      sql`${table.automaticReplicaSynchronization} IN ('off', 'verify-only', 'fast-forward-primary')`,
    ),
    check(
      "user_settings_default_permission_profile_check",
      sql`${table.defaultPermissionProfileId} IN (':read-only', ':workspace', ':danger-full-access', ':yolo')`,
    ),
  ],
);

export const policyOwnerStates = pgTable(
  "policy_owner_states",
  {
    ownerId: text("owner_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    bootstrapVersion: integer("bootstrap_version").notNull().default(0),
    collectionVersion: integer("collection_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "policy_owner_states_bootstrap_version_check",
      sql`${table.bootstrapVersion} >= 0`,
    ),
    check(
      "policy_owner_states_collection_version_check",
      sql`${table.collectionVersion} >= 1`,
    ),
  ],
);

export const policies = pgTable(
  "policies",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    mandatory: boolean("mandatory").notNull().default(false),
    position: integer("position").notNull().default(0),
    templateKey: text("template_key"),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("policies_owner_key_unique").on(table.ownerId, table.key),
    index("policies_owner_position_index").on(
      table.ownerId,
      table.position,
      table.key,
    ),
    check(
      "policies_key_length_check",
      sql`length(${table.key}) BETWEEN 1 AND 80`,
    ),
    check(
      "policies_key_format_check",
      sql`${table.key} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      "policies_name_length_check",
      sql`length(btrim(${table.name})) BETWEEN 1 AND 120`,
    ),
    check(
      "policies_summary_length_check",
      sql`length(btrim(${table.summary})) BETWEEN 1 AND 1000`,
    ),
    check(
      "policies_body_length_check",
      sql`length(${table.bodyMarkdown}) BETWEEN 1 AND 100000`,
    ),
    check("policies_position_check", sql`${table.position} >= 0`),
    check("policies_row_version_check", sql`${table.rowVersion} >= 1`),
  ],
);

export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  displayName: text("display_name"),
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
      iceTransportPolicies: ["relay"],
      maxSessions: 4,
    }),
  directBrokerAdvertisement: jsonb("direct_broker_advertisement")
    .$type<DirectBrokerAdvertisement>()
    .notNull()
    .default(unavailableDirectBroker),
  codeCapabilities: jsonb("code_capabilities")
    .$type<CodeCapabilities>()
    .notNull()
    .default(unavailableCodeCapabilities),
  projectReplicaCapabilities: jsonb("project_replica_capabilities")
    .$type<ProjectReplicaCapabilities>()
    .notNull()
    .default(unavailableProjectReplicaCapabilities),
  managedFolderCapabilities: jsonb("managed_folder_capabilities")
    .$type<ManagedFolderCapabilities>()
    .notNull()
    .default(unavailableManagedFolderCapabilities),
  chatRelocationCapability: boolean("chat_relocation_capability")
    .notNull()
    .default(false),
  externalCodexHistoryCapability: boolean("external_codex_history_capability")
    .notNull()
    .default(false),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workerCredentials = pgTable(
  "worker_credentials",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    secretHash: text("secret_hash").notNull(),
    label: text("label"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    replacesCredentialId: text("replaces_credential_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("worker_credentials_secret_hash_unique").on(table.secretHash),
    index("worker_credentials_owner_worker_index").on(
      table.ownerId,
      table.workerId,
    ),
    index("worker_credentials_worker_active_index").on(
      table.workerId,
      table.revokedAt,
    ),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    originKind: text("origin_kind")
      .$type<ProjectOriginKind>()
      .notNull()
      .default("github"),
    setupStatus: text("setup_status").notNull().default("ready"),
    setupError: text("setup_error"),
    worktreePolicy: text("worktree_policy").notNull().default("agent-managed"),
    preferredWorkerId: text("preferred_worker_id").references(
      () => workers.id,
      { onDelete: "set null" },
    ),
    tabLayoutRevision: integer("tab_layout_revision").notNull().default(0),
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
    check(
      "projects_origin_kind_check",
      sql`${table.originKind} IN ('github', 'managed-folder')`,
    ),
    check(
      "projects_managed_folder_identity_check",
      sql`${table.originKind} <> 'managed-folder' OR (${table.githubRepositoryId} IS NULL AND ${table.githubRepositoryFullName} IS NULL AND ${table.githubRepositoryUrl} IS NULL AND ${table.worktreePolicy} = 'direct')`,
    ),
  ],
);

export const tunnels = pgTable(
  "tunnels",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    origin: text("origin").notNull(),
    management: text("management").notNull(),
    protocolHint: text("protocol_hint").notNull(),
    sourceEndpoint: jsonb("source_endpoint")
      .$type<TunnelSourceEndpoint>()
      .notNull(),
    sourceWorkerId: text("source_worker_id").references(() => workers.id, {
      onDelete: "cascade",
    }),
    destinationEndpoint: jsonb("destination_endpoint")
      .$type<TunnelDestinationEndpoint>()
      .notNull(),
    destinationWorkerId: text("destination_worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    managedByKind: text("managed_by_kind"),
    managedById: text("managed_by_id"),
    desiredState: text("desired_state").notNull().default("stopped"),
    status: text("status").notNull().default("stopped"),
    lastError: text("last_error"),
    activeConnectionCount: integer("active_connection_count")
      .notNull()
      .default(0),
    bytesFromSource: bigint("bytes_from_source", { mode: "number" })
      .notNull()
      .default(0),
    bytesToSource: bigint("bytes_to_source", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("tunnels_owner_position_index").on(table.ownerId, table.position),
    index("tunnels_owner_project_index").on(
      table.ownerId,
      table.projectId,
      table.position,
    ),
    index("tunnels_destination_worker_index").on(table.destinationWorkerId),
    uniqueIndex("tunnels_managed_resource_unique")
      .on(table.ownerId, table.managedByKind, table.managedById)
      .where(sql`${table.managedByKind} IS NOT NULL`),
    check(
      "tunnels_origin_check",
      sql`${table.origin} IN ('user', 'browser', 'project-share', 'code', 'workflow', 'system')`,
    ),
    check(
      "tunnels_management_check",
      sql`${table.management} IN ('user-managed', 'managed-durable', 'managed-ephemeral')`,
    ),
    check(
      "tunnels_protocol_hint_check",
      sql`${table.protocolHint} IN ('tcp', 'http', 'https', 'http-websocket', 'https-websocket', 'webdav')`,
    ),
    check(
      "tunnels_desired_state_check",
      sql`${table.desiredState} IN ('stopped', 'started')`,
    ),
    check(
      "tunnels_status_check",
      sql`${table.status} IN ('stopped', 'starting', 'active', 'offline', 'degraded', 'stopping', 'failed')`,
    ),
    check(
      "tunnels_managed_resource_check",
      sql`(${table.management} = 'user-managed' AND ${table.origin} = 'user' AND ${table.managedByKind} IS NULL AND ${table.managedById} IS NULL) OR (${table.management} <> 'user-managed' AND ${table.origin} <> 'user' AND ${table.origin} = ${table.managedByKind} AND ${table.managedById} IS NOT NULL)`,
    ),
    check(
      "tunnels_source_worker_check",
      sql`(${table.sourceEndpoint}->>'kind' = 'worker-listener' AND ${table.sourceWorkerId} IS NOT NULL) OR (${table.sourceEndpoint}->>'kind' <> 'worker-listener' AND ${table.sourceWorkerId} IS NULL)`,
    ),
    check(
      "tunnels_active_connections_check",
      sql`${table.activeConnectionCount} >= 0`,
    ),
    check(
      "tunnels_bytes_from_source_check",
      sql`${table.bytesFromSource} >= 0`,
    ),
    check("tunnels_bytes_to_source_check", sql`${table.bytesToSource} >= 0`),
  ],
);

export const tunnelAttachments = pgTable(
  "tunnel_attachments",
  {
    id: text("id").primaryKey(),
    tunnelId: text("tunnel_id")
      .notNull()
      .references(() => tunnels.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    clientId: text("client_id"),
    localHost: text("local_host"),
    localPort: integer("local_port"),
    secretHash: text("secret_hash"),
    status: text("status").notNull().default("starting"),
    activeConnectionCount: integer("active_connection_count")
      .notNull()
      .default(0),
    bytesFromSource: bigint("bytes_from_source", { mode: "number" })
      .notNull()
      .default(0),
    bytesToSource: bigint("bytes_to_source", { mode: "number" })
      .notNull()
      .default(0),
    lastError: text("last_error"),
    secretExpiresAt: timestamp("secret_expires_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("tunnel_attachments_tunnel_status_index").on(
      table.tunnelId,
      table.status,
    ),
    uniqueIndex("tunnel_attachments_tunnel_client_unique")
      .on(table.tunnelId, table.clientId)
      .where(sql`${table.clientId} IS NOT NULL`),
    uniqueIndex("tunnel_attachments_secret_hash_unique")
      .on(table.secretHash)
      .where(sql`${table.secretHash} IS NOT NULL`),
    check(
      "tunnel_attachments_kind_check",
      sql`${table.kind} IN ('desktop-loopback', 'server-relay')`,
    ),
    check(
      "tunnel_attachments_status_check",
      sql`${table.status} IN ('stopped', 'starting', 'active', 'offline', 'degraded', 'stopping', 'failed')`,
    ),
    check(
      "tunnel_attachments_local_endpoint_check",
      sql`(${table.kind} = 'desktop-loopback' AND ${table.clientId} IS NOT NULL AND ((${table.localHost} IS NULL AND ${table.localPort} IS NULL) OR (${table.localHost} IN ('127.0.0.1', 'localhost', '::1') AND ${table.localPort} BETWEEN 1 AND 65535))) OR (${table.kind} = 'server-relay' AND ${table.clientId} IS NULL AND ${table.localHost} IS NULL AND ${table.localPort} IS NULL)`,
    ),
    check(
      "tunnel_attachments_active_connections_check",
      sql`${table.activeConnectionCount} >= 0`,
    ),
    check(
      "tunnel_attachments_bytes_from_source_check",
      sql`${table.bytesFromSource} >= 0`,
    ),
    check(
      "tunnel_attachments_bytes_to_source_check",
      sql`${table.bytesToSource} >= 0`,
    ),
  ],
);

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    transport: text("transport").notNull(),
    command: text("command"),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    url: text("url"),
    environment: jsonb("environment")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    environmentEnvelope: text("environment_envelope"),
    headers: jsonb("headers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    headersEnvelope: text("headers_envelope"),
    environmentHeaders: jsonb("environment_headers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    bearerTokenEnvironmentVariable: text("bearer_token_environment_variable"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_servers_owner_global_name_unique")
      .on(table.ownerId, table.name)
      .where(sql`${table.projectId} IS NULL`),
    uniqueIndex("mcp_servers_project_name_unique")
      .on(table.projectId, table.name)
      .where(sql`${table.projectId} IS NOT NULL`),
    index("mcp_servers_owner_scope_index").on(table.ownerId, table.projectId),
    check(
      "mcp_servers_transport_check",
      sql`${table.transport} IN ('stdio', 'http')`,
    ),
    check(
      "mcp_servers_transport_configuration_check",
      sql`(${table.transport} = 'stdio' AND ${table.command} IS NOT NULL AND ${table.url} IS NULL) OR (${table.transport} = 'http' AND ${table.command} IS NULL AND ${table.url} IS NOT NULL)`,
    ),
  ],
);

export const projectWorkspaces = pgTable(
  "project_workspaces",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_workspaces_owner_name_unique").on(
      table.ownerId,
      table.name,
    ),
    uniqueIndex("project_workspaces_owner_default_unique")
      .on(table.ownerId)
      .where(sql`${table.isDefault} = true`),
    index("project_workspaces_owner_position_index").on(
      table.ownerId,
      table.position,
    ),
  ],
);

export const projectWorkspaceMemberships = pgTable(
  "project_workspace_memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.projectId] }),
    index("project_workspace_memberships_project_index").on(table.projectId),
  ],
);

export const projectPolicyAssignments = pgTable(
  "project_policy_assignments",
  {
    policyId: text("policy_id")
      .notNull()
      .references(() => policies.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.policyId, table.projectId] }),
    index("project_policy_assignments_project_index").on(table.projectId),
  ],
);

export const workspacePolicyAssignments = pgTable(
  "workspace_policy_assignments",
  {
    policyId: text("policy_id")
      .notNull()
      .references(() => policies.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.policyId, table.workspaceId] }),
    index("workspace_policy_assignments_workspace_index").on(table.workspaceId),
  ],
);

export const tabGroups = pgTable(
  "tab_groups",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title"),
    position: integer("position").notNull().default(0),
    anchorTabKey: text("anchor_tab_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("tab_groups_id_project_unique").on(table.id, table.projectId),
    index("tab_groups_project_position_index").on(
      table.projectId,
      table.position,
    ),
  ],
);

export const tabGroupMembers = pgTable(
  "tab_group_members",
  {
    tabKey: text("tab_key").primaryKey(),
    groupId: text("group_id").notNull(),
    projectId: text("project_id").notNull(),
    tabKind: text("tab_kind").notNull(),
    tabId: text("tab_id").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.groupId, table.projectId],
      foreignColumns: [tabGroups.id, tabGroups.projectId],
      name: "tab_group_members_group_project_fk",
    }).onDelete("cascade"),
    uniqueIndex("tab_group_members_surface_unique").on(
      table.tabKind,
      table.tabId,
    ),
    index("tab_group_members_group_position_index").on(
      table.groupId,
      table.position,
    ),
    check(
      "tab_group_members_kind_check",
      sql`${table.tabKind} IN ('chat', 'terminal', 'explorer', 'browser', 'code', 'history', 'issues', 'remote-desktop')`,
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
    sourceKind: text("source_kind")
      .$type<ProjectSourceKind>()
      .notNull()
      .default("git"),
    absolutePath: text("absolute_path").notNull(),
    displayPath: text("display_path").notNull(),
    repositoryFingerprint: text("repository_fingerprint"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_sources_project_worker_unique")
      .on(table.projectId, table.workerId)
      .where(sql`${table.removedAt} IS NULL`),
    check(
      "project_sources_source_kind_check",
      sql`${table.sourceKind} IN ('git', 'folder')`,
    ),
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
    rootKind: text("root_kind")
      .$type<ProjectRootKind>()
      .notNull()
      .default("git-worktree"),
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
    statusSnapshot: jsonb("status_snapshot").$type<WorktreeStatusResult>(),
    statusObservedAt: timestamp("status_observed_at", { withTimezone: true }),
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
    check(
      "project_worktrees_root_kind_check",
      sql`${table.rootKind} IN ('git-worktree', 'folder-root')`,
    ),
    check(
      "project_worktrees_folder_root_shape_check",
      sql`${table.rootKind} <> 'folder-root' OR (${table.isPrimary} = true AND ${table.isDefault} = true AND ${table.origin} = 'cantrip' AND ${table.branch} IS NULL AND ${table.head} IS NULL AND ${table.detached} = false)`,
    ),
  ],
);

export const projectFolderSetupJobs = pgTable(
  "project_folder_setup_jobs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    state: text("state").$type<ProjectFolderSetupJobState>().notNull(),
    stateRevision: integer("state_revision").notNull().default(1),
    attempt: integer("attempt").notNull().default(0),
    commandId: text("command_id"),
    lastErrorCode:
      text("last_error_code").$type<ProjectFolderSetupJobError["code"]>(),
    lastErrorMessage: text("last_error_message"),
    errorRetryable: boolean("error_retryable"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_folder_setup_jobs_project_unique").on(table.projectId),
    uniqueIndex("project_folder_setup_jobs_command_unique")
      .on(table.commandId)
      .where(sql`${table.commandId} IS NOT NULL`),
    index("project_folder_setup_jobs_dispatch_index").on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    index("project_folder_setup_jobs_worker_state_index").on(
      table.workerId,
      table.state,
    ),
    check(
      "project_folder_setup_jobs_state_check",
      sql`${table.state} IN ('queued', 'running', 'blocked', 'succeeded', 'failed')`,
    ),
    check(
      "project_folder_setup_jobs_revision_check",
      sql`${table.stateRevision} > 0`,
    ),
    check(
      "project_folder_setup_jobs_attempt_check",
      sql`${table.attempt} >= 0`,
    ),
    check(
      "project_folder_setup_jobs_error_shape_check",
      sql`(${table.lastErrorCode} IS NULL AND ${table.lastErrorMessage} IS NULL AND ${table.errorRetryable} IS NULL) OR (${table.lastErrorCode} IS NOT NULL AND ${table.lastErrorMessage} IS NOT NULL AND ${table.errorRetryable} IS NOT NULL)`,
    ),
  ],
);

export const projectReplicaJobs = pgTable(
  "project_replica_jobs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    projectReplicaId: text("project_replica_id").references(
      () => projectSources.id,
      { onDelete: "set null" },
    ),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ProjectReplicaJobKind>().notNull(),
    state: text("state").$type<ProjectReplicaJobState>().notNull(),
    stateRevision: integer("state_revision").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadFingerprint: text("payload_fingerprint").notNull(),
    repository: text("repository").notNull(),
    expectedRevision: text("expected_revision"),
    resolvedRevision: text("resolved_revision"),
    synchronizationPolicy: text("synchronization_policy"),
    deleteLocalFiles: boolean("delete_local_files"),
    attempt: integer("attempt").notNull().default(0),
    commandId: text("command_id"),
    progress: jsonb("progress").$type<ProjectReplicaJobProgress>().notNull(),
    lastErrorCode: text("last_error_code").$type<ProjectReplicaJobErrorCode>(),
    lastErrorMessage: text("last_error_message"),
    errorRetryable: boolean("error_retryable"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    cancellationUnsafeAt: timestamp("cancellation_unsafe_at", {
      withTimezone: true,
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_replica_jobs_owner_idempotency_unique").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    uniqueIndex("project_replica_jobs_command_unique")
      .on(table.commandId)
      .where(sql`${table.commandId} IS NOT NULL`),
    uniqueIndex("project_replica_jobs_active_target_unique")
      .on(table.projectId, table.workerId, table.kind)
      .where(sql`${table.state} IN ('queued', 'running', 'blocked')`),
    index("project_replica_jobs_dispatch_index").on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    index("project_replica_jobs_project_created_index").on(
      table.projectId,
      table.createdAt,
    ),
    check(
      "project_replica_jobs_kind_check",
      sql`${table.kind} IN ('provision', 'synchronize', 'remove')`,
    ),
    check(
      "project_replica_jobs_state_check",
      sql`${table.state} IN ('queued', 'running', 'blocked', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "project_replica_jobs_revision_check",
      sql`${table.stateRevision} > 0`,
    ),
    check("project_replica_jobs_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "project_replica_jobs_error_shape_check",
      sql`(${table.lastErrorCode} IS NULL AND ${table.lastErrorMessage} IS NULL AND ${table.errorRetryable} IS NULL) OR (${table.lastErrorCode} IS NOT NULL AND ${table.lastErrorMessage} IS NOT NULL AND ${table.errorRetryable} IS NOT NULL)`,
    ),
  ],
);

export const gitOperations = pgTable(
  "git_operations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => projectWorktrees.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    type: text("type").$type<GitManagedOperationType>().notNull(),
    state: text("state").$type<GitManagedOperationState>().notNull(),
    originalHead: text("original_head").notNull(),
    currentHead: text("current_head").notNull(),
    sourceRef: text("source_ref"),
    sourceRevision: text("source_revision"),
    targetRef: text("target_ref"),
    targetRevision: text("target_revision").notNull(),
    pendingCommits: jsonb("pending_commits")
      .$type<string[]>()
      .notNull()
      .default([]),
    currentStep: integer("current_step").notNull().default(0),
    totalSteps: integer("total_steps").notNull().default(1),
    conflictedPaths: jsonb("conflicted_paths")
      .$type<string[]>()
      .notNull()
      .default([]),
    output: text("output").notNull().default(""),
    checkpointRef: text("checkpoint_ref"),
    pausedAction: text("paused_action").$type<GitInteractiveRebaseTodoAction>(),
    error: text("error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("git_operations_project_worktree_updated_index").on(
      table.projectId,
      table.worktreeId,
      table.updatedAt,
    ),
    uniqueIndex("git_operations_worktree_active_unique")
      .on(table.worktreeId)
      .where(
        sql`${table.state} in ('queued', 'running', 'conflicted', 'awaiting-user-action')`,
      ),
  ],
);

export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    experience: text("experience").notNull().default("agent"),
    position: integer("position").notNull().default(0),
    status: text("status").notNull().default("idle"),
    activeWorkerId: text("active_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    activeWorktreeId: text("active_worktree_id")
      .notNull()
      .references(() => projectWorktrees.id, { onDelete: "restrict" }),
    placementRevision: integer("placement_revision").notNull().default(1),
    worktreeMode: text("worktree_mode").notNull().default("agent-managed"),
    modelId: text("model_id").references(() => modelProfiles.id, {
      onDelete: "restrict",
    }),
    reasoningEffort: text("reasoning_effort"),
    permissionProfileId: text("permission_profile_id"),
    automationPaused: boolean("automation_paused").notNull().default(false),
    planMode: text("plan_mode").notNull().default("default"),
    planExplanation: text("plan_explanation"),
    planSteps: jsonb("plan_steps").$type<PlanStep[]>().notNull().default([]),
    pendingPlanQuestion: jsonb(
      "pending_plan_question",
    ).$type<PendingPlanQuestion | null>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chats_project_archived_index").on(table.projectId, table.archivedAt),
    check(
      "chats_experience_check",
      sql`${table.experience} IN ('agent', 'task')`,
    ),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    chatId: text("chat_id")
      .primaryKey()
      .references(() => chats.id, { onDelete: "cascade" }),
    state: text("state").$type<TaskState>().notNull().default("draft"),
    stableStateBeforeFailure: text(
      "stable_state_before_failure",
    ).$type<TaskStableState>(),
    activeOperationId: text("active_operation_id"),
    activeOperationKind: text(
      "active_operation_kind",
    ).$type<TaskOperationKind>(),
    briefMarkdown: text("brief_markdown").notNull().default(""),
    draftAttachmentIds: jsonb("draft_attachment_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    planMarkdown: text("plan_markdown"),
    planAuthorship: text("plan_authorship")
      .$type<TaskPlanAuthorship>()
      .notNull()
      .default("agent"),
    currentQuestions: jsonb("current_questions")
      .$type<TaskQuestion[]>()
      .notNull()
      .default([]),
    currentAnswers: jsonb("current_answers")
      .$type<TaskQuestionAnswer[]>()
      .notNull()
      .default([]),
    additionalDirection: text("additional_direction").notNull().default(""),
    finalPlanMarkdown: text("final_plan_markdown"),
    goalPrompt: text("goal_prompt"),
    planningRound: integer("planning_round").notNull().default(0),
    implementationStartedAt: timestamp("implementation_started_at", {
      withTimezone: true,
    }),
    lastError: jsonb("last_error").$type<TaskLastError>(),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("tasks_active_operation_unique")
      .on(table.activeOperationId)
      .where(sql`${table.activeOperationId} IS NOT NULL`),
    check(
      "tasks_state_check",
      sql`${table.state} IN ('draft', 'planning', 'review', 'finalizing', 'implementing', 'paused', 'blocked', 'complete', 'failed')`,
    ),
    check(
      "tasks_stable_failure_state_check",
      sql`${table.stableStateBeforeFailure} IS NULL OR ${table.stableStateBeforeFailure} IN ('draft', 'review')`,
    ),
    check(
      "tasks_active_operation_kind_check",
      sql`${table.activeOperationKind} IS NULL OR ${table.activeOperationKind} IN ('initial-plan', 'continue-plan', 'finalize')`,
    ),
    check(
      "tasks_active_operation_pair_check",
      sql`(${table.activeOperationId} IS NULL) = (${table.activeOperationKind} IS NULL)`,
    ),
    check(
      "tasks_plan_authorship_check",
      sql`${table.planAuthorship} IN ('agent', 'user-edited', 'mixed')`,
    ),
    check(
      "tasks_brief_length_check",
      sql`length(${table.briefMarkdown}) <= 100000`,
    ),
    check(
      "tasks_plan_length_check",
      sql`${table.planMarkdown} IS NULL OR length(${table.planMarkdown}) BETWEEN 1 AND 100000`,
    ),
    check(
      "tasks_final_plan_length_check",
      sql`${table.finalPlanMarkdown} IS NULL OR length(${table.finalPlanMarkdown}) BETWEEN 1 AND 100000`,
    ),
    check(
      "tasks_goal_prompt_length_check",
      sql`${table.goalPrompt} IS NULL OR length(${table.goalPrompt}) BETWEEN 1 AND 100000`,
    ),
    check(
      "tasks_direction_length_check",
      sql`length(${table.additionalDirection}) <= 10000`,
    ),
    check("tasks_planning_round_check", sql`${table.planningRound} >= 0`),
    check("tasks_row_version_check", sql`${table.rowVersion} >= 1`),
  ],
);

export const taskPlanningRounds = pgTable(
  "task_planning_rounds",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => tasks.chatId, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").$type<TaskOperationKind>().notNull(),
    status: text("status")
      .$type<TaskPlanningRoundStatus>()
      .notNull()
      .default("running"),
    inputBriefMarkdown: text("input_brief_markdown").notNull(),
    inputPlanMarkdown: text("input_plan_markdown"),
    inputQuestions: jsonb("input_questions")
      .$type<TaskQuestion[]>()
      .notNull()
      .default([]),
    inputAnswers: jsonb("input_answers")
      .$type<TaskQuestionAnswer[]>()
      .notNull()
      .default([]),
    additionalDirection: text("additional_direction").notNull().default(""),
    outputPlanMarkdown: text("output_plan_markdown"),
    outputQuestions: jsonb("output_questions")
      .$type<TaskQuestion[]>()
      .notNull()
      .default([]),
    outputGoalPrompt: text("output_goal_prompt"),
    userMessageId: text("user_message_id").references(() => chatMessages.id, {
      onDelete: "set null",
    }),
    assistantMessageId: text("assistant_message_id").references(
      () => chatMessages.id,
      { onDelete: "set null" },
    ),
    executionLaneId: text("execution_lane_id").references(
      () => chatExecutionLanes.id,
      { onDelete: "set null" },
    ),
    turnId: text("turn_id"),
    error: jsonb("error").$type<TaskLastError>(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("task_planning_rounds_chat_ordinal_unique").on(
      table.chatId,
      table.ordinal,
    ),
    index("task_planning_rounds_chat_started_index").on(
      table.chatId,
      table.startedAt,
    ),
    check("task_planning_rounds_ordinal_check", sql`${table.ordinal} >= 0`),
    check(
      "task_planning_rounds_kind_check",
      sql`${table.kind} IN ('initial-plan', 'continue-plan', 'finalize')`,
    ),
    check(
      "task_planning_rounds_status_check",
      sql`${table.status} IN ('running', 'completed', 'failed', 'interrupted')`,
    ),
    check(
      "task_planning_rounds_input_brief_length_check",
      sql`length(${table.inputBriefMarkdown}) <= 100000`,
    ),
    check(
      "task_planning_rounds_input_plan_length_check",
      sql`${table.inputPlanMarkdown} IS NULL OR length(${table.inputPlanMarkdown}) <= 100000`,
    ),
    check(
      "task_planning_rounds_output_plan_length_check",
      sql`${table.outputPlanMarkdown} IS NULL OR length(${table.outputPlanMarkdown}) <= 100000`,
    ),
    check(
      "task_planning_rounds_goal_prompt_length_check",
      sql`${table.outputGoalPrompt} IS NULL OR length(${table.outputGoalPrompt}) <= 100000`,
    ),
    check(
      "task_planning_rounds_direction_length_check",
      sql`length(${table.additionalDirection}) <= 10000`,
    ),
  ],
);

export const terminals = pgTable("terminals", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  directoryPath: text("directory_path").notNull().default(""),
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
  serviceEnabled: boolean("service_enabled").notNull().default(false),
  serviceCommand: text("service_command").notNull().default(""),
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
  selectedPath: text("selected_path"),
  fileMode: text("file_mode").notNull().default("preview"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const codeTabs = pgTable(
  "code_tabs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    position: integer("position").notNull().default(0),
    activeWorkerId: text("active_worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => projectWorktrees.id, { onDelete: "restrict" }),
    profileId: text("profile_id").notNull().default("default"),
    themeMode: text("theme_mode").notNull().default("follow-cantrip"),
    status: text("status").notNull().default("idle"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("code_tabs_project_position_index").on(
      table.projectId,
      table.position,
    ),
    check(
      "code_tabs_theme_mode_check",
      sql`${table.themeMode} IN ('follow-cantrip', 'independent')`,
    ),
    check(
      "code_tabs_status_check",
      sql`${table.status} IN ('idle', 'starting', 'running', 'stopped', 'offline', 'failed')`,
    ),
  ],
);

export const codeSessions = pgTable(
  "code_sessions",
  {
    id: text("id").primaryKey(),
    codeTabId: text("code_tab_id")
      .notNull()
      .references(() => codeTabs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => projectWorktrees.id, { onDelete: "restrict" }),
    profileId: text("profile_id").notNull(),
    editorVersion: text("editor_version").notNull(),
    editorUpstreamRevision: text("editor_upstream_revision").notNull(),
    editorPatchset: integer("editor_patchset").notNull(),
    editorFingerprint: text("editor_fingerprint").notNull(),
    status: text("status").notNull().default("starting"),
    processInstanceId: text("process_instance_id"),
    lastAttachmentAt: timestamp("last_attachment_at", { withTimezone: true }),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("code_sessions_runtime_identity_unique").on(
      table.codeTabId,
      table.workerId,
      table.worktreeId,
      table.profileId,
      table.editorFingerprint,
    ),
    index("code_sessions_tab_status_index").on(table.codeTabId, table.status),
    check("code_sessions_patchset_check", sql`${table.editorPatchset} >= 0`),
    check(
      "code_sessions_status_check",
      sql`${table.status} IN ('starting', 'running', 'idle', 'stopping', 'stopped', 'offline', 'failed')`,
    ),
  ],
);

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
    providerAccountId: text("provider_account_id").references(
      () => modelProviderAccounts.id,
      { onDelete: "set null" },
    ),
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
    reasoningEffort: text("reasoning_effort"),
    appliedReasoningEffort: text("applied_reasoning_effort"),
    reasoningAdjusted: boolean("reasoning_adjusted").notNull().default(false),
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

export const tokenUsageRecords = pgTable(
  "token_usage_records",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    chatId: text("chat_id").references(() => chats.id, {
      onDelete: "set null",
    }),
    sourceKey: text("source_key").notNull(),
    modelId: text("model_id").references(() => modelProfiles.id, {
      onDelete: "set null",
    }),
    modelRouteId: text("model_route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").references(() => modelProviders.id, {
      onDelete: "set null",
    }),
    modelName: text("model_name").notNull(),
    providerName: text("provider_name").notNull(),
    providerModelName: text("provider_model_name").notNull(),
    providerAccountId: text("provider_account_id"),
    workerId: text("worker_id"),
    turnId: text("turn_id"),
    executionAttemptId: text("execution_attempt_id"),
    attemptKind: text("attempt_kind").notNull().default("turn"),
    attemptStatus: text("attempt_status").notNull().default("completed"),
    reasoningEffort: text("reasoning_effort"),
    workerVersion: text("worker_version"),
    serverVersion: text("server_version"),
    codexVersion: text("codex_version"),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    reasoningOutputTokens: bigint("reasoning_output_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    cacheWriteInputTokens: bigint("cache_write_input_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    visibleOutputTokens: bigint("visible_output_tokens", { mode: "number" }),
    reportedTotalTokens: bigint("reported_total_tokens", { mode: "number" }),
    usageSemantics: text("usage_semantics")
      .notNull()
      .default("provider-reported-v2"),
    sanitizedRawUsage: jsonb("sanitized_raw_usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("token_usage_records_owner_source_unique").on(
      table.ownerId,
      table.sourceKey,
    ),
    index("token_usage_records_project_created_index").on(
      table.projectId,
      table.createdAt,
    ),
    index("token_usage_records_owner_provider_index").on(
      table.ownerId,
      table.providerId,
    ),
    index("token_usage_records_owner_model_index").on(
      table.ownerId,
      table.modelId,
    ),
    index("token_usage_records_owner_account_time_index").on(
      table.ownerId,
      table.providerAccountId,
      table.startedAt,
    ),
    index("token_usage_records_worker_time_index").on(
      table.workerId,
      table.startedAt,
    ),
    index("token_usage_records_execution_attempt_index").on(
      table.executionAttemptId,
    ),
    index("token_usage_records_turn_index").on(table.chatId, table.turnId),
    check(
      "token_usage_records_nonnegative_check",
      sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.cachedInputTokens} >= 0 AND ${table.reasoningOutputTokens} >= 0 AND ${table.cacheWriteInputTokens} >= 0 AND (${table.visibleOutputTokens} IS NULL OR ${table.visibleOutputTokens} >= 0) AND (${table.reportedTotalTokens} IS NULL OR ${table.reportedTotalTokens} >= 0)`,
    ),
  ],
);

export const modelBehaviorObservations = pgTable(
  "model_behavior_observations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    chatId: text("chat_id").references(() => chats.id, {
      onDelete: "set null",
    }),
    modelId: text("model_id").references(() => modelProfiles.id, {
      onDelete: "set null",
    }),
    modelRouteId: text("model_route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").references(() => modelProviders.id, {
      onDelete: "set null",
    }),
    modelName: text("model_name").notNull(),
    providerName: text("provider_name").notNull(),
    providerModelName: text("provider_model_name").notNull(),
    providerAccountId: text("provider_account_id"),
    workerId: text("worker_id"),
    turnId: text("turn_id"),
    executionAttemptId: text("execution_attempt_id").notNull(),
    attemptKind: text("attempt_kind").notNull().default("chat-turn"),
    attemptStatus: text("attempt_status").notNull().default("running"),
    reasoningEffort: text("reasoning_effort"),
    routeAttemptIndex: integer("route_attempt_index").notNull().default(0),
    retryFailoverCount: integer("retry_failover_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    firstActivityAt: timestamp("first_activity_at", { withTimezone: true }),
    firstVisibleResponseAt: timestamp("first_visible_response_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    finalAnswerAppeared: boolean("final_answer_appeared")
      .notNull()
      .default(false),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    invalidToolCallCount: integer("invalid_tool_call_count")
      .notNull()
      .default(0),
    compactionCount: integer("compaction_count").notNull().default(0),
    approvalRequestCount: integer("approval_request_count")
      .notNull()
      .default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheWriteInputTokens: bigint("cache_write_input_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    reasoningOutputTokens: bigint("reasoning_output_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    modelContextWindow: bigint("model_context_window", { mode: "number" }),
    contextUsedPercentBasisPoints: integer("context_used_percent_basis_points"),
    filesChangedCount: integer("files_changed_count").notNull().default(0),
    testCommandCount: integer("test_command_count").notNull().default(0),
    testPassCount: integer("test_pass_count").notNull().default(0),
    testFailureCount: integer("test_failure_count").notNull().default(0),
    userInterrupted: boolean("user_interrupted").notNull().default(false),
    userRetryRegeneration: boolean("user_retry_regeneration"),
    immediateCorrectiveFollowup: boolean("immediate_corrective_followup")
      .notNull()
      .default(false),
    forkCount: integer("fork_count").notNull().default(0),
    copyCount: integer("copy_count"),
    ratingValue: integer("rating_value"),
    workerVersion: text("worker_version"),
    serverVersion: text("server_version"),
    codexVersion: text("codex_version"),
    signalAvailability: jsonb("signal_availability")
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_behavior_observations_owner_source_unique").on(
      table.ownerId,
      table.sourceKey,
    ),
    index("model_behavior_observations_account_time_index").on(
      table.ownerId,
      table.providerAccountId,
      table.startedAt,
    ),
    index("model_behavior_observations_model_time_index").on(
      table.ownerId,
      table.modelId,
      table.startedAt,
    ),
    index("model_behavior_observations_project_time_index").on(
      table.projectId,
      table.startedAt,
    ),
    index("model_behavior_observations_turn_index").on(
      table.chatId,
      table.turnId,
    ),
    index("model_behavior_observations_attempt_index").on(
      table.executionAttemptId,
    ),
    check(
      "model_behavior_observations_status_check",
      sql`${table.attemptStatus} IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')`,
    ),
    check(
      "model_behavior_observations_nonnegative_check",
      sql`${table.routeAttemptIndex} >= 0 AND ${table.retryFailoverCount} >= 0 AND ${table.toolCallCount} >= 0 AND ${table.invalidToolCallCount} >= 0 AND ${table.compactionCount} >= 0 AND ${table.approvalRequestCount} >= 0 AND ${table.inputTokens} >= 0 AND ${table.cachedInputTokens} >= 0 AND ${table.cacheWriteInputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.reasoningOutputTokens} >= 0 AND ${table.filesChangedCount} >= 0 AND ${table.testCommandCount} >= 0 AND ${table.testPassCount} >= 0 AND ${table.testFailureCount} >= 0 AND ${table.forkCount} >= 0`,
    ),
    check(
      "model_behavior_observations_context_percent_check",
      sql`${table.contextUsedPercentBasisPoints} IS NULL OR ${table.contextUsedPercentBasisPoints} >= 0`,
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

export const chatAttachmentReplicas = pgTable(
  "chat_attachment_replicas",
  {
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => chatAttachments.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("ready"),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.attachmentId, table.workerId] }),
    index("chat_attachment_replicas_worker_status_index").on(
      table.workerId,
      table.status,
    ),
    check(
      "chat_attachment_replicas_status_check",
      sql`${table.status} IN ('pending', 'ready', 'failed')`,
    ),
  ],
);

export const chatRelocationJobs = pgTable(
  "chat_relocation_jobs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    state: text("state").$type<ChatRelocationState>().notNull(),
    stateRevision: integer("state_revision").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadFingerprint: text("payload_fingerprint").notNull(),
    sourcePlacement: jsonb("source_placement")
      .$type<ExecutionPlacement>()
      .notNull(),
    sourcePlacementRevision: integer("source_placement_revision").notNull(),
    targetPlacement: jsonb("target_placement")
      .$type<ExecutionPlacement>()
      .notNull(),
    targetRuntimeThreadId: text("target_runtime_thread_id"),
    targetModelRouteId: text("target_model_route_id").references(
      () => modelRoutes.id,
      { onDelete: "set null" },
    ),
    targetProviderAccountId: text("target_provider_account_id").references(
      () => modelProviderAccounts.id,
      { onDelete: "set null" },
    ),
    attempt: integer("attempt").notNull().default(0),
    commandId: text("command_id"),
    progress: jsonb("progress").$type<ChatRelocationProgress>().notNull(),
    lastErrorCode: text("last_error_code").$type<ChatRelocationErrorCode>(),
    lastErrorMessage: text("last_error_message"),
    errorRetryable: boolean("error_retryable"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    cancellationUnsafeAt: timestamp("cancellation_unsafe_at", {
      withTimezone: true,
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_relocation_jobs_owner_idempotency_unique").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    uniqueIndex("chat_relocation_jobs_command_unique")
      .on(table.commandId)
      .where(sql`${table.commandId} IS NOT NULL`),
    uniqueIndex("chat_relocation_jobs_active_chat_unique")
      .on(table.chatId)
      .where(
        sql`${table.state} IN ('queued', 'waiting-for-idle', 'validating', 'preparing-replica', 'transferring-attachments', 'hydrating-runtime', 'ready-to-commit', 'blocked')`,
      ),
    index("chat_relocation_jobs_dispatch_index").on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    index("chat_relocation_jobs_chat_created_index").on(
      table.chatId,
      table.createdAt,
    ),
    check(
      "chat_relocation_jobs_state_check",
      sql`${table.state} IN ('queued', 'waiting-for-idle', 'validating', 'preparing-replica', 'transferring-attachments', 'hydrating-runtime', 'ready-to-commit', 'succeeded', 'blocked', 'failed', 'cancelled')`,
    ),
    check(
      "chat_relocation_jobs_revision_check",
      sql`${table.stateRevision} > 0 AND ${table.sourcePlacementRevision} > 0`,
    ),
    check("chat_relocation_jobs_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "chat_relocation_jobs_error_shape_check",
      sql`(${table.lastErrorCode} IS NULL AND ${table.lastErrorMessage} IS NULL AND ${table.errorRetryable} IS NULL) OR (${table.lastErrorCode} IS NOT NULL AND ${table.lastErrorMessage} IS NOT NULL AND ${table.errorRetryable} IS NOT NULL)`,
    ),
  ],
);

export const chatImportJobs = pgTable(
  "chat_import_jobs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chatId: text("chat_id").references(() => chats.id, {
      onDelete: "set null",
    }),
    sourceKind: text("source_kind").$type<ExternalChatSourceKind>().notNull(),
    sourceWorkerId: text("source_worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    sourceThreadId: text("source_thread_id").notNull(),
    targetPlacement: jsonb("target_placement")
      .$type<ExecutionPlacement>()
      .notNull(),
    managedThreadId: text("managed_thread_id"),
    targetModelRouteId: text("target_model_route_id").references(
      () => modelRoutes.id,
      { onDelete: "set null" },
    ),
    targetProviderAccountId: text("target_provider_account_id").references(
      () => modelProviderAccounts.id,
      { onDelete: "set null" },
    ),
    requestedModelId: text("requested_model_id").references(
      () => modelProfiles.id,
      { onDelete: "set null" },
    ),
    requestedPermissionProfileId: text("requested_permission_profile_id"),
    requestedPlanMode: text("requested_plan_mode").notNull().default("default"),
    state: text("state").$type<ChatImportState>().notNull(),
    stateRevision: integer("state_revision").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadFingerprint: text("payload_fingerprint").notNull(),
    attempt: integer("attempt").notNull().default(0),
    commandId: text("command_id"),
    progress: jsonb("progress").$type<ChatImportProgress>().notNull(),
    sourceMetadata:
      jsonb("source_metadata").$type<ExternalChatTranscriptMetadata>(),
    attachmentCount: integer("attachment_count").notNull().default(0),
    attachmentWarningCount: integer("attachment_warning_count")
      .notNull()
      .default(0),
    lastErrorCode: text("last_error_code").$type<ChatImportError["code"]>(),
    lastErrorMessage: text("last_error_message"),
    errorRetryable: boolean("error_retryable"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_import_jobs_owner_idempotency_unique").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    uniqueIndex("chat_import_jobs_source_thread_unique").on(
      table.ownerId,
      table.sourceKind,
      table.sourceWorkerId,
      table.sourceId,
      table.sourceThreadId,
    ),
    uniqueIndex("chat_import_jobs_command_unique")
      .on(table.commandId)
      .where(sql`${table.commandId} IS NOT NULL`),
    index("chat_import_jobs_dispatch_index").on(
      table.state,
      table.availableAt,
      table.createdAt,
    ),
    index("chat_import_jobs_project_created_index").on(
      table.projectId,
      table.createdAt,
    ),
    check(
      "chat_import_jobs_state_check",
      sql`${table.state} IN ('queued', 'reading', 'importing', 'awaiting-hydration', 'hydrating', 'succeeded', 'blocked', 'failed', 'cancelled')`,
    ),
    check("chat_import_jobs_revision_check", sql`${table.stateRevision} > 0`),
    check("chat_import_jobs_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "chat_import_jobs_error_shape_check",
      sql`(${table.lastErrorCode} IS NULL AND ${table.lastErrorMessage} IS NULL AND ${table.errorRetryable} IS NULL) OR (${table.lastErrorCode} IS NOT NULL AND ${table.lastErrorMessage} IS NOT NULL AND ${table.errorRetryable} IS NOT NULL)`,
    ),
  ],
);

export const chatRelocationSnapshots = pgTable(
  "chat_relocation_snapshots",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .unique()
      .references(() => chatRelocationJobs.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    sourcePlacement: jsonb("source_placement")
      .$type<ExecutionPlacement>()
      .notNull(),
    throughSequence: integer("through_sequence").notNull(),
    transcriptSha256: text("transcript_sha256").notNull(),
    payload: jsonb("payload").$type<ChatRelocationContextPayload>().notNull(),
    messageCount: integer("message_count").notNull(),
    attachmentCount: integer("attachment_count").notNull(),
    modelId: text("model_id").references(() => modelProfiles.id, {
      onDelete: "set null",
    }),
    modelRouteId: text("model_route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    permissionProfileId: text("permission_profile_id"),
    requiredRevision: text("required_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chat_relocation_snapshots_chat_created_index").on(
      table.chatId,
      table.createdAt,
    ),
    check(
      "chat_relocation_snapshots_counts_check",
      sql`${table.throughSequence} >= 0 AND ${table.messageCount} >= 0 AND ${table.attachmentCount} >= 0`,
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
    mode: text("mode").$type<ChatTurnMode>().notNull().default("default"),
    attachments: jsonb("attachments")
      .$type<ChatAttachmentSummary[]>()
      .notNull()
      .default([]),
    modelId: text("model_id")
      .notNull()
      .references(() => modelProfiles.id, { onDelete: "restrict" }),
    reasoningEffort: text("reasoning_effort"),
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

export const projectAutomations = pgTable(
  "project_automations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    schedule: jsonb("schedule").$type<ProjectAutomationSchedule>().notNull(),
    condition: jsonb("condition").$type<ProjectAutomationCondition>(),
    enabled: boolean("enabled").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status").notNull().default("idle"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("project_automations_project_index").on(
      table.ownerId,
      table.projectId,
      table.createdAt,
    ),
    index("project_automations_chat_index").on(table.chatId),
    index("project_automations_due_index").on(table.enabled, table.nextRunAt),
    check("project_automations_revision_check", sql`${table.revision} > 0`),
    check(
      "project_automations_status_check",
      sql`${table.lastStatus} IN ('idle', 'dispatching', 'started', 'queued', 'skipped', 'failed')`,
    ),
  ],
);

export const projectAutomationRuns = pgTable(
  "project_automation_runs",
  {
    id: text("id").primaryKey(),
    automationId: text("automation_id")
      .notNull()
      .references(() => projectAutomations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    workerId: text("worker_id").notNull(),
    automationRevision: integer("automation_revision").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("dispatching"),
    dispatchInstanceId: text("dispatch_instance_id").notNull(),
    leaseToken: text("lease_token").notNull(),
    fencingToken: integer("fencing_token").notNull().default(1),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(1),
    reasoningEffort: text("reasoning_effort"),
    errorMessage: text("error_message"),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_automation_runs_occurrence_unique").on(
      table.automationId,
      table.scheduledFor,
    ),
    index("project_automation_runs_recovery_index").on(
      table.status,
      table.leaseExpiresAt,
    ),
    index("project_automation_runs_owner_index").on(
      table.ownerId,
      table.createdAt,
    ),
    check(
      "project_automation_runs_status_check",
      sql`${table.status} IN ('dispatching', 'started', 'queued', 'skipped', 'failed')`,
    ),
    check(
      "project_automation_runs_fencing_token_check",
      sql`${table.fencingToken} > 0`,
    ),
    check(
      "project_automation_runs_attempt_count_check",
      sql`${table.attemptCount} > 0`,
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

export const workflowAutomationTriggers = pgTable(
  "workflow_automation_triggers",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    workflowRevisionId: text("workflow_revision_id")
      .notNull()
      .references(() => workflowRevisions.id, { onDelete: "restrict" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    configuration: jsonb("configuration")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    structuredInput: jsonb("structured_input")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    budget: jsonb("budget")
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
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lastRunId: text("last_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("workflow_automation_triggers_owner_index").on(
      table.ownerId,
      table.projectId,
      table.type,
    ),
    index("workflow_automation_triggers_due_index").on(
      table.enabled,
      table.type,
      table.nextRunAt,
    ),
    check(
      "workflow_automation_triggers_type_check",
      sql`${table.type} IN ('schedule', 'api', 'webhook', 'git', 'saved-command')`,
    ),
  ],
);

export const workflowTriggerDeliveries = pgTable(
  "workflow_trigger_deliveries",
  {
    id: text("id").primaryKey(),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => workflowAutomationTriggers.id, {
        onDelete: "cascade",
      }),
    runId: text("run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    triggerProvenance: jsonb("trigger_provenance")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    dispatchInstanceId: text("dispatch_instance_id"),
    leaseToken: text("lease_token"),
    fencingToken: integer("fencing_token").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_trigger_deliveries_idempotency_unique").on(
      table.triggerId,
      table.idempotencyKey,
    ),
    index("workflow_trigger_deliveries_trigger_created_index").on(
      table.triggerId,
      table.createdAt,
    ),
    check(
      "workflow_trigger_deliveries_status_check",
      sql`${table.status} IN ('pending', 'accepted', 'failed')`,
    ),
    check(
      "workflow_trigger_deliveries_fencing_token_check",
      sql`${table.fencingToken} >= 0`,
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

export const workflowRunNodeItems = pgTable(
  "workflow_run_node_items",
  {
    id: text("id").primaryKey(),
    runNodeId: text("run_node_id")
      .notNull()
      .references(() => workflowRunNodes.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    position: integer("position").notNull(),
    status: text("status").notNull().default("ready"),
    executionState: jsonb("execution_state")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ kind: "map" }),
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
    uniqueIndex("workflow_run_node_items_key_unique").on(
      table.runNodeId,
      table.itemKey,
    ),
    uniqueIndex("workflow_run_node_items_position_unique").on(
      table.runNodeId,
      table.position,
    ),
    index("workflow_run_node_items_status_index").on(
      table.runNodeId,
      table.status,
      table.position,
    ),
    check(
      "workflow_run_node_items_position_check",
      sql`${table.position} >= 0`,
    ),
    check(
      "workflow_run_node_items_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "workflow_run_node_items_status_check",
      sql`${table.status} IN ('ready', 'running', 'waiting-for-approval', 'cancelled', 'failed', 'completed', 'recovering', 'skipped')`,
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
    runNodeItemId: text("run_node_item_id").references(
      () => workflowRunNodeItems.id,
      { onDelete: "cascade" },
    ),
    executionUnitKey: text("execution_unit_key"),
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
    uniqueIndex("workflow_node_attempts_node_number_unique")
      .on(table.runNodeId, table.attempt)
      .where(sql`${table.runNodeItemId} IS NULL`),
    uniqueIndex("workflow_node_attempts_item_number_unique")
      .on(table.runNodeItemId, table.attempt)
      .where(sql`${table.runNodeItemId} IS NOT NULL`),
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

export const workflowWorktreeLeases = pgTable(
  "workflow_worktree_leases",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    runNodeId: text("run_node_id")
      .notNull()
      .references(() => workflowRunNodes.id, { onDelete: "cascade" }),
    runNodeItemId: text("run_node_item_id").references(
      () => workflowRunNodeItems.id,
      { onDelete: "cascade" },
    ),
    projectSourceId: text("project_source_id").references(
      () => projectSources.id,
      { onDelete: "set null" },
    ),
    workerId: text("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    requestedWorktreeId: text("requested_worktree_id").notNull(),
    worktreeId: text("worktree_id").references(() => projectWorktrees.id, {
      onDelete: "set null",
    }),
    leaseKey: text("lease_key").notNull(),
    state: text("state").notNull().default("allocating"),
    branchName: text("branch_name"),
    baseRevision: text("base_revision"),
    startingRevision: text("starting_revision"),
    endingRevision: text("ending_revision"),
    worktreeDirty: boolean("worktree_dirty"),
    producedChanges: jsonb("produced_changes")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    outcome: text("outcome"),
    pendingOutcome: text("pending_outcome"),
    pendingOutcomeRequest: jsonb("pending_outcome_request").$type<
      Record<string, unknown>
    >(),
    resolvedByActorType: text("resolved_by_actor_type"),
    resolvedByActorId: text("resolved_by_actor_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    checkpointedAt: timestamp("checkpointed_at", { withTimezone: true }),
    outcomeStartedAt: timestamp("outcome_started_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_worktree_leases_run_key_unique").on(
      table.runId,
      table.leaseKey,
    ),
    uniqueIndex("workflow_worktree_leases_requested_worktree_unique").on(
      table.requestedWorktreeId,
    ),
    uniqueIndex("workflow_worktree_leases_node_active_unique")
      .on(table.runNodeId)
      .where(
        sql`${table.runNodeItemId} IS NULL AND ${table.state} <> 'released'`,
      ),
    uniqueIndex("workflow_worktree_leases_item_active_unique")
      .on(table.runNodeItemId)
      .where(
        sql`${table.runNodeItemId} IS NOT NULL AND ${table.state} <> 'released'`,
      ),
    uniqueIndex("workflow_worktree_leases_worktree_active_unique")
      .on(table.worktreeId)
      .where(
        sql`${table.worktreeId} IS NOT NULL AND ${table.state} <> 'released'`,
      ),
    index("workflow_worktree_leases_run_state_index").on(
      table.runId,
      table.state,
      table.createdAt,
    ),
    index("workflow_worktree_leases_recovery_index").on(
      table.state,
      table.updatedAt,
    ),
    check(
      "workflow_worktree_leases_state_check",
      sql`${table.state} IN ('allocating', 'active', 'checkpointed', 'recovering', 'released', 'failed')`,
    ),
    check(
      "workflow_worktree_leases_outcome_check",
      sql`${table.outcome} IS NULL OR (${table.outcome} = 'kept' AND ${table.state} = 'checkpointed') OR (${table.outcome} IN ('delivered', 'discarded', 'released') AND ${table.state} = 'released')`,
    ),
    check(
      "workflow_worktree_leases_pending_outcome_check",
      sql`(${table.pendingOutcome} IS NULL AND ${table.pendingOutcomeRequest} IS NULL AND ${table.outcomeStartedAt} IS NULL) OR (${table.pendingOutcome} IN ('deliver', 'discard', 'release') AND ${table.pendingOutcomeRequest} IS NOT NULL AND ${table.outcomeStartedAt} IS NOT NULL AND ${table.state} = 'recovering')`,
    ),
  ],
);

export const projectBranchLeases = pgTable(
  "project_branch_leases",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branchName: text("branch_name").notNull(),
    chatExecutionLaneId: text("chat_execution_lane_id").references(
      () => chatExecutionLanes.id,
      { onDelete: "cascade" },
    ),
    workflowWorktreeLeaseId: text("workflow_worktree_lease_id").references(
      () => workflowWorktreeLeases.id,
      { onDelete: "cascade" },
    ),
    worktreeId: text("worktree_id").references(() => projectWorktrees.id, {
      onDelete: "set null",
    }),
    workerId: text("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    state: text("state").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_branch_leases_active_branch_unique")
      .on(table.projectId, table.branchName)
      .where(sql`${table.state} = 'active'`),
    uniqueIndex("project_branch_leases_chat_lane_unique").on(
      table.chatExecutionLaneId,
    ),
    uniqueIndex("project_branch_leases_workflow_lease_unique").on(
      table.workflowWorktreeLeaseId,
    ),
    index("project_branch_leases_project_state_index").on(
      table.projectId,
      table.state,
    ),
    check(
      "project_branch_leases_holder_check",
      sql`(${table.chatExecutionLaneId} IS NOT NULL AND ${table.workflowWorktreeLeaseId} IS NULL) OR (${table.chatExecutionLaneId} IS NULL AND ${table.workflowWorktreeLeaseId} IS NOT NULL)`,
    ),
    check(
      "project_branch_leases_state_check",
      sql`${table.state} IN ('active', 'released')`,
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
