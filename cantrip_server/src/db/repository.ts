import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_PERMISSION_PROFILE_ID,
  MCP_SECRET_MASK,
  agentInteractionRequestSchema,
  isManagedCodeGraphMcpName,
  normalizeResponsesBaseUrl,
  projectCapabilitiesForOriginKind,
  unavailableCodeCapabilities,
  unavailableCodeGraphWorkerStatus,
  unavailableManagedFolderCapabilities,
  unavailableProjectReplicaCapabilities,
  unavailableWorkerEncryptionStatus,
} from "@cantrip/protocol";
import type {
  AgentInteractionRequest,
  AgentInteractionRequestCreate,
  AgentInteractionRequestPayload,
  AgentInteractionRequestQuery,
  AgentInteractionResolutionCreate,
  AgentInteractionResponse,
  ArchivedChatSummary,
  AccountLicenseWhitelistEntry,
  AccountSessionSummary,
  AuditEvent,
  AuditEventList,
  AuditEventQuery,
  BrowserCreate,
  BrowserSummary,
  BrowserUpdate,
  ChatAttachmentKind,
  ChatAttachmentSource,
  ChatAttachmentSummary,
  ChatCreate,
  ChatExperience,
  ChatExecutionLaneSummary,
  ChatFork,
  ChatModelUpdate,
  ChatPlanState,
  ChatMessage,
  ChatMessageCreate,
  ChatSummary,
  ChatUpdate,
  ChatWorktreeUpdate,
  CodeCapabilities,
  CodeEditorBuild,
  CodeRuntimeStatus,
  CodeSessionSummary,
  CodeTabCreate,
  CodeTabSummary,
  DetailedTokenUsageTotals,
  CodeTabUpdate,
  DesktopUpdateActiveWorkSummary,
  ExplorerCreate,
  ExplorerViewStateUpdate,
  ExplorerSummary,
  ExplorerUpdate,
  ExecutionPlacement,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  ExecutionTargetCatalog,
  ExecutionTargetResolution,
  GithubProjectCreate,
  ManagedFolderProjectCreate,
  GitManagedOperationContext,
  GitManagedOperationRecord,
  GitManagedOperationWorkerState,
  ModelProfileCreate,
  ModelProfileSummary,
  ModelProfileUpdate,
  McpServerConfiguration,
  McpServerSummary,
  ModelProviderAccountCreate,
  ModelProviderAccountSummary,
  ModelProviderAccountUpdate,
  ModelProviderCreate,
  ProviderCatalogSyncState,
  ProviderModelAvailability,
  ProviderModelCatalogEntry,
  ProviderModelCatalogResult,
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
  ReasoningEffort,
  RemoteDesktopSummary,
  RemoteDesktopTarget,
  RemoteSurfaceCapabilities,
  RemoteSurfaceCreate,
  RemoteSurfaceStatus,
  RemoteSurfaceSummary,
  RemoteSurfaceUpdate,
  ProjectCloneResult,
  ProjectFolderSetupJobSummary,
  ProjectReplicaSummary,
  ProjectSummary,
  ProjectTokenUsage,
  ProviderTelemetryAnalytics,
  ProviderTelemetryDeleteResult,
  ProviderTelemetryExport,
  EncryptedProjectWorkspaceCreate,
  EncryptedProjectWorkspaceUpdate,
  ProjectWorkspaceCreate,
  ProjectWorkspaceSummary,
  ProjectWorkspaceUpdate,
  ProjectWorkspaceWireList,
  ProjectWorkspaceWireSummary,
  ProjectWorktreePolicyUpdate,
  ProjectWorktreeSummary,
  ProjectViewCreate,
  ProjectViewSummary,
  ProjectViewUpdate,
  SettingsBundle,
  TerminalCreate,
  TerminalServiceConfiguration,
  TerminalServiceRuntimeConfiguration,
  TerminalSummary,
  TerminalUpdate,
  TaskCreate,
  TaskCreateResult,
  TaskDetail,
  ThemePreference,
  TunnelAttachmentSummary,
  TunnelDestinationEndpoint,
  TunnelManagedRegistration,
  TunnelSourceEndpoint,
  TunnelSummary,
  TunnelUserCreate,
  TunnelUserUpdate,
  TokenUsageTotals,
  UserSettings,
  UserSettingsUpdate,
  UserSummary,
  WorkerCredentialScope,
  WorkerCredentialSummary,
  WorkerEnrollmentCodeStatus,
  WorkerHeartbeat,
  WorkerManagementSource,
  WorkerSummary,
  WorkerWorktreeSummary,
  WorktreeInventory,
  WorktreePolicy,
  WorktreeSelection,
  WorktreeStatusResult,
} from "@cantrip/protocol";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import {
  buildExecutionTargetCatalog,
  executionTargetAvailability,
  type ExecutionTargetCapability,
} from "../execution-targets/catalog.js";
import {
  deriveQuotaTokenAnalytics,
  quotaValueStatistics,
  type QuotaTokenAnalytics,
} from "../analytics/quota-token.js";
import {
  groupModelBehavior,
  sumDetailedTokenUsage,
  summarizeModelBehavior,
} from "../analytics/telemetry-dashboard.js";
import { detectTelemetryChanges } from "../analytics/telemetry-change-detection.js";
import {
  enrichCatalogFromExactOpenRouterMatch,
  exactOpenRouterAliases,
} from "../models/catalog-enrichment.js";
import {
  accountProviderLabel,
  defaultAccountLabel,
  isAccountProviderKind,
} from "../models/account-provider.js";
import {
  parseProviderCredential,
  providerCredentialSubject,
  redactProviderCredential,
  serializeProviderCredential,
  type ProviderCredential,
  type RedactedProviderCredential,
} from "../models/provider-credentials.js";
import { sampleProviderTelemetryQuotaHistory } from "../models/provider-telemetry.js";
import {
  mcpServerSecretContext,
  modelProviderAccountSecretContext,
  modelProviderSecretContext,
  type SecretVault,
} from "../security/secret-vault.js";
import * as schema from "./schema.js";
import { ChatImportJobRepository } from "./chat-import-jobs.js";
import { ChatRelocationJobRepository } from "./chat-relocation-jobs.js";
import {
  acquireChatLogicalBranchLease,
  LogicalBranchLeaseConflictError,
  releaseChatLogicalBranchLease,
} from "./logical-branch-leases.js";
import { ProjectAutomationRepository } from "./project-automations.js";
import { ProjectFolderSetupJobRepository } from "./project-folder-setup-jobs.js";
import { ProjectGithubConversionJobRepository } from "./project-github-conversion-jobs.js";
import { EncryptionRegistryRepository } from "./encryption-registry.js";
import { PolicyRepository } from "./policies.js";
import { ProjectReplicaJobRepository } from "./project-replica-jobs.js";
import { TaskRepository, toTaskDetail } from "./tasks.js";
import { WorkflowRunRepository } from "./workflow-runs.js";
import { WorkflowRepository } from "./workflows.js";
import { WorkflowTriggerRepository } from "./workflow-triggers.js";
import {
  attachProjectTab,
  detachProjectTab,
  projectTabKey,
  ProjectTabLayoutRepository,
} from "./tab-layouts.js";

function terminalWorkingDirectory(
  sourceRoot: string,
  directoryPath: string,
): string {
  if (!directoryPath) return sourceRoot;
  const root = sourceRoot.replace(/[\\/]+$/u, "") || sourceRoot;
  return `${root}/${directoryPath.replaceAll("\\", "/")}`;
}

export const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_OLLAMA_PROVIDER_ID =
  "00000000-0000-0000-0000-000000000010";
export const DEFAULT_MODEL_ID = "00000000-0000-0000-0000-000000000020";
export const DEFAULT_MODEL_ROUTE_ID = "00000000-0000-0000-0000-000000000021";
export const ARCHIVED_CHAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const SERVER_ID_STATE_KEY = "server-id";
export const WORKER_ONLINE_WINDOW_MS = 30_000;

export interface ModelProviderCatalogRuntime {
  id: string;
  ownerId: string;
  kind: ModelProviderSummary["kind"];
  baseUrl: string;
  apiKey: string | null;
}

export interface ProviderModelCatalogWrite {
  nativeModelId: string;
  canonicalModelId: string | null;
  displayName: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportsTools: boolean | null;
  supportsParallelTools: boolean | null;
  supportsStructuredOutput: boolean | null;
  supportsVision: boolean | null;
  supportsReasoning: boolean | null;
  supportedReasoningEfforts: ProviderModelCatalogEntry["supportedReasoningEfforts"];
  defaultReasoningEffort: string | null;
  reasoningMandatory: boolean | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  digest: string | null;
  metadataSource: ProviderModelCatalogEntry["metadataSource"];
  matchConfidenceBasisPoints: number | null;
  hidden?: boolean;
  isDefault?: boolean;
  rawMetadata: Record<string, unknown>;
}

export type RepositoryDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type ProjectRow = typeof schema.projects.$inferSelect;
type ProjectSourceRow = typeof schema.projectSources.$inferSelect;
type ProjectWorktreeRow = typeof schema.projectWorktrees.$inferSelect;
type WorkerRow = typeof schema.workers.$inferSelect;
type McpServerRow = typeof schema.mcpServers.$inferSelect;
type GitOperationRow = typeof schema.gitOperations.$inferSelect;
type ProjectWorkspaceRow = typeof schema.projectWorkspaces.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;
type UserSessionRow = typeof schema.userSessions.$inferSelect;
type AuditEventRow = typeof schema.auditEvents.$inferSelect;
type AccountLicenseWhitelistRow =
  typeof schema.accountLicenseWhitelist.$inferSelect;
type WorkerCredentialRow = typeof schema.workerCredentials.$inferSelect;
type TunnelRow = typeof schema.tunnels.$inferSelect;
type TunnelAttachmentRow = typeof schema.tunnelAttachments.$inferSelect;

export interface AccountCredentialRecord {
  passwordHash: string;
  user: UserSummary;
}

export interface ActiveUserSession {
  authMethod: "password" | "account-password" | "mobile-qr";
  csrfTokenHash: string;
  expiresAt: Date;
  id: string;
  user: UserSummary;
}

export interface AuditEventCreate {
  action: string;
  actorSessionId: string | null;
  actorUserId: string | null;
  ipAddressHash: string | null;
  metadata?: Record<string, string>;
  ownerId: string | null;
  requestId: string | null;
  resourceId: string | null;
  resourceType: string;
  result: AuditEvent["result"];
  userAgentHash: string | null;
}

export interface ActiveWorkerCredential {
  id: string;
  ownerId: string;
  scopes: WorkerCredentialScope[];
  workerId: string;
}

export interface WorkerEnrollmentProvision {
  credential: WorkerCredentialSummary;
  ownerId: string;
  replacedWorkerId: string | null;
  revokedCredentialIds: string[];
  worker: WorkerSummary;
}

export interface WorkerManagementRecord {
  activeCredentialCount: number;
  credentialCount: number;
  runtimeName: string;
  sources: WorkerManagementSource[];
  worker: WorkerSummary;
}

export interface ChatExecutionContext {
  automationPaused: boolean;
  chatId: string;
  cwd: string;
  experience: ChatSummary["experience"];
  defaultPermissionProfileId?: UserSettings["defaultPermissionProfileId"];
  executionLaneId: string | null;
  isPrimary: boolean;
  status: ChatSummary["status"];
  modelId: string | null;
  reasoningEffort: ReasoningEffort | null;
  modelRouteId: string | null;
  providerAccountId: string | null;
  permissionProfileId: string | null;
  planMode: PlanMode;
  pendingPlanQuestion: PendingPlanQuestion | null;
  projectId: string;
  rootKind: ProjectWorktreeSummary["rootKind"];
  threadId: string | null;
  workerId: string;
  worktreeId: string;
  worktreeMode: ChatSummary["worktreeMode"];
  worktreePolicy: WorktreePolicy;
}

export interface ChatAttachmentRecord extends ChatAttachmentSummary {
  sha256: string;
  workerId: string;
}

export class ExecutionLaneConflictError extends Error {}
export class ExecutionPlacementUnavailableError extends Error {
  constructor(
    readonly code:
      | "capability-unavailable"
      | "no-compatible-placement"
      | "project-not-found"
      | "replica-unavailable"
      | "target-mismatch"
      | "target-not-found"
      | "worker-offline"
      | "worktree-unavailable",
    message: string,
  ) {
    super(message);
  }
}
export class AgentInteractionConflictError extends Error {}
export class CodeCapabilityUnavailableError extends Error {}
export class ProjectWorkspaceInvariantError extends Error {}
export class WorkerEnrollmentError extends Error {}
export class TunnelManagementError extends Error {}
export class ManagedMcpServerInvariantError extends Error {}

function assertUserManagedMcpServerName(name: string): void {
  if (isManagedCodeGraphMcpName(name)) {
    throw new ManagedMcpServerInvariantError(
      "CodeGraph is managed by Cantrip and cannot be configured or removed.",
    );
  }
}

export interface TunnelAttachmentAuthorization {
  attachmentId: string;
  clientId: string;
  destination: Extract<TunnelDestinationEndpoint, { kind: "worker-tcp" }>;
  expiresAt: Date;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}

export interface TerminalExecutionContext {
  cwd: string;
  linkedChatId: string | null;
  projectId: string;
  rootKind: ProjectWorktreeSummary["rootKind"];
  service: TerminalServiceConfiguration;
  status: TerminalSummary["status"];
  terminalId: string;
  workerId: string;
  worktreeId: string;
}

export interface ProjectRemovalContext {
  convertedManagedFolderSource: {
    localFilesDeleted: boolean;
    projectSourceId: string;
    workerId: string;
  } | null;
  folderManagement: ProjectSummary["folderManagement"];
  originKind: ProjectSummary["originKind"];
  preferredWorkerId: string | null;
  replicas: Array<{
    cwd: string;
    id: string;
    workerId: string;
  }>;
  remoteSurfaces: RemoteSurfaceSummary[];
  setupStatus: ProjectSummary["setupStatus"];
  terminals: Array<{
    id: string;
    workerId: string;
  }>;
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

export interface ProjectWorktreeObservationContext {
  projectId: string;
  rootKind: ProjectWorktreeSummary["rootKind"];
  sourcePath: string;
  workerId: string;
  worktreeId: string;
  worktreePath: string;
}

export interface ProjectWorktreeStatusRecord {
  metadataChanged: boolean;
  snapshotChanged: boolean;
  status: WorktreeStatusResult;
  worktree: ProjectWorktreeSummary;
}

export interface WorktreeRemovalBlockers {
  activeChatIds: string[];
  activeLeaseChatIds: string[];
  boundCodeTabIds: string[];
  runningTerminalIds: string[];
  workflowLeaseIds: string[];
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
  projectId: string;
  root: string;
  workerId: string;
  worktreeId: string;
}

export interface CodeTabExecutionContext {
  capabilities: CodeCapabilities;
  codeTab: CodeTabSummary;
  cwd: string;
  projectName: string;
  workerId: string;
  worktreeId: string;
  worktreeName: string;
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
    profileName: string;
    routeId: string;
    name: string;
    reasoningEffort: ReasoningEffort | null;
    providerModelId: string | null;
    catalog: ProviderModelCatalogEntry | null;
  };
  provider: {
    id: string;
    name: string;
    kind: ModelProviderSummary["kind"];
    baseUrl: string;
    apiKey: string | null;
    accountId: string | null;
    credentialHomeKey: string | null;
    weeklyUsageReservePercent: number;
  };
}

export interface ModelProviderAccountRuntime {
  accountId: string;
  credentialState: ModelProviderAccountSummary["credentialState"];
  credentialHomeKey: string;
  enabled: boolean;
  label: string;
  legacyWorkerAuthenticated: boolean;
  modelAvailability: ProviderModelAvailability["state"] | null;
  position: number;
  weeklyUsageUsedPercent: number | null;
}

export type ProviderAccountCredentialState =
  | "signed-out"
  | "migration-needed"
  | "signed-in"
  | "reauth-required"
  | "conflict";

export type ProviderCredentialRefreshFailure =
  | "Provider credential refresh failed."
  | "Provider credential requires sign-in."
  | "Provider credential identity changed during refresh.";

/** Internal secret-bearing record. Never return this object from an API. */
export interface ProviderAccountCredentialRecord {
  accountId: string;
  credential: ProviderCredential;
  metadata: RedactedProviderCredential;
  providerId: string;
  revision: number;
  state: ProviderAccountCredentialState;
  updatedAt: string | null;
}

export interface ProviderAccountCredentialSignOutRecord {
  credential: ProviderCredential | null;
  revision: number;
}

export interface ProviderAccountCredentialMigrationRecord {
  accountId: string;
  credentialHomeKey: string;
  providerId: string;
  providerKind: "chatgpt" | "grok";
  revision: number;
  state: ProviderAccountCredentialState;
  subject: string | null;
}

export class ProviderCredentialIdentityConflictError extends Error {
  constructor() {
    super("The provider account identity does not match the stored identity.");
    this.name = "ProviderCredentialIdentityConflictError";
  }
}

export class ProviderCredentialRevisionConflictError extends Error {
  constructor() {
    super("The provider account credential changed before it could be saved.");
    this.name = "ProviderCredentialRevisionConflictError";
  }
}

export interface TokenUsageRecordInput {
  sourceKey: string;
  projectId: string | null;
  chatId: string | null;
  modelRouteId: string;
  modelName: string;
  providerName: string;
  providerModelName: string;
  providerAccountId?: string | null;
  workerId?: string | null;
  turnId?: string | null;
  executionAttemptId?: string | null;
  attemptKind?: string;
  attemptStatus?:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "compacted";
  reasoningEffort?: ReasoningEffort | null;
  workerVersion?: string | null;
  serverVersion?: string | null;
  codexVersion?: string | null;
  startedAt?: Date;
  completedAt?: Date | null;
  finalizedAt?: Date | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    cacheWriteInputTokens?: number;
    visibleOutputTokens?: number | null;
    sanitizedRawUsage?: Record<string, unknown>;
  };
}

export interface ModelBehaviorObservationInput {
  sourceKey: string;
  projectId: string | null;
  chatId: string | null;
  modelRouteId: string;
  modelName: string;
  providerName: string;
  providerModelName: string;
  providerAccountId?: string | null;
  workerId?: string | null;
  turnId?: string | null;
  executionAttemptId: string;
  attemptKind?: string;
  attemptStatus:
    "running" | "completed" | "failed" | "cancelled" | "interrupted";
  reasoningEffort?: ReasoningEffort | null;
  routeAttemptIndex?: number;
  retryFailoverCount?: number;
  startedAt?: Date;
  firstActivityAt?: Date | null;
  firstVisibleResponseAt?: Date | null;
  completedAt?: Date | null;
  finalizedAt?: Date | null;
  durationMs?: number | null;
  finalAnswerAppeared?: boolean;
  toolCallCount?: number;
  invalidToolCallCount?: number;
  compactionCount?: number;
  approvalRequestCount?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  modelContextWindow?: number | null;
  contextUsedPercent?: number | null;
  filesChangedCount?: number;
  testCommandCount?: number;
  testPassCount?: number;
  testFailureCount?: number;
  userInterrupted?: boolean;
  userRetryRegeneration?: boolean | null;
  immediateCorrectiveFollowup?: boolean;
  workerVersion?: string | null;
  serverVersion?: string | null;
  codexVersion?: string | null;
  signalAvailability?: Record<string, boolean>;
}

export interface QuotaTokenAnalyticsQuery {
  providerId?: string;
  providerAccountId?: string;
  modelId?: string;
  reasoningEffort?: string;
  projectId?: string;
  from?: Date;
  to?: Date;
}

export interface ProviderQuotaObservationInput {
  eventKey: string;
  observationBatchKey: string;
  providerId: string;
  providerAccountId: string;
  workerId: string | null;
  observedAt: Date;
  usedPercent: number;
  resetsAt: Date | null;
  windowDurationMinutes: number | null;
  limitId: string | null;
  limitName: string | null;
  windowKind: string;
  planType: string | null;
  reachedType: string | null;
  observationTrigger: string;
  isWeeklyProjection: boolean;
  chatId: string | null;
  turnId: string | null;
  executionAttemptId: string | null;
  workerVersion: string | null;
  serverVersion: string | null;
  codexVersion: string | null;
  sanitizedRawPayload: Record<string, unknown>;
}

const ZERO_TOKEN_USAGE: TokenUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

function tokenUsageTotals(
  inputTokens: number,
  outputTokens: number,
): TokenUsageTotals {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function detailedTokenUsageTotals(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number,
  reasoningOutputTokens: number,
): DetailedTokenUsageTotals {
  return {
    ...tokenUsageTotals(inputTokens, outputTokens),
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningOutputTokens,
  };
}

function toISOString(value: Date): string {
  return value.toISOString();
}

function toWorkerCredentialSummary(
  credential: WorkerCredentialRow,
  now = new Date(),
): WorkerCredentialSummary {
  return {
    id: credential.id,
    workerId: credential.workerId,
    label: credential.label,
    scopes: credential.scopes as WorkerCredentialScope[],
    createdAt: toISOString(credential.createdAt),
    expiresAt: credential.expiresAt?.toISOString() ?? null,
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
    revokedAt: credential.revokedAt?.toISOString() ?? null,
    revokedReason: credential.revokedReason,
    active:
      credential.revokedAt === null &&
      (credential.expiresAt === null || credential.expiresAt > now),
  };
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

const CATALOG_SENSITIVE_METADATA_KEY =
  /^(?:api[-_]?key|authorization|cookie|set-cookie|password|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|credential|headers?)$/iu;

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !CATALOG_SENSITIVE_METADATA_KEY.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function catalogMetadataSnapshot(model: ProviderModelCatalogWrite) {
  const metadata = stableJsonValue(model) as Record<string, unknown>;
  return {
    metadata,
    metadataHash: createHash("sha256")
      .update(JSON.stringify(metadata))
      .digest("hex"),
  };
}

function toUserSummary(user: UserRow): UserSummary {
  return {
    id: user.id,
    kind: user.kind as UserSummary["kind"],
    displayName: user.displayName,
    email: user.email,
    role: user.role as UserSummary["role"],
  };
}

function toAccountLicenseWhitelistEntry(
  entry: AccountLicenseWhitelistRow,
  registered: boolean,
): AccountLicenseWhitelistEntry {
  return {
    id: entry.id,
    email: entry.email,
    registered,
    createdAt: toISOString(entry.createdAt),
  };
}

function toAuditEvent(event: AuditEventRow): AuditEvent {
  return {
    id: event.id,
    ownerId: event.ownerId,
    actor: {
      userId: event.actorUserId,
      sessionId: event.actorSessionId,
    },
    action: event.action,
    result: event.result as AuditEvent["result"],
    resource: {
      type: event.resourceType,
      id: event.resourceId,
    },
    requestId: event.requestId,
    metadata: event.metadata,
    occurredAt: toISOString(event.occurredAt),
  };
}

function toProjectSummary(
  project: ProjectRow,
  replicas: ProjectReplicaSummary[] = [],
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
    originKind: project.originKind,
    folderManagement: project.folderManagement,
    capabilities: projectCapabilitiesForOriginKind(project.originKind),
    setupStatus: project.setupStatus as ProjectSummary["setupStatus"],
    setupError: project.setupError,
    worktreePolicy: project.worktreePolicy as ProjectSummary["worktreePolicy"],
    preferredWorkerId: project.preferredWorkerId,
    github,
    source: replicas[0]
      ? {
          id: replicas[0].id,
          sourceKind: replicas[0].sourceKind,
          workerId: replicas[0].workerId,
          path: replicas[0].path,
          displayPath: replicas[0].displayPath,
        }
      : null,
    replicas,
    createdAt: toISOString(project.createdAt),
    updatedAt: toISOString(project.updatedAt),
  };
}

function toTunnelAttachmentSummary(
  attachment: TunnelAttachmentRow,
): TunnelAttachmentSummary {
  return {
    id: attachment.id,
    tunnelId: attachment.tunnelId,
    kind: attachment.kind as TunnelAttachmentSummary["kind"],
    clientId: attachment.clientId,
    localHost: attachment.localHost as TunnelAttachmentSummary["localHost"],
    localPort: attachment.localPort,
    status: attachment.status as TunnelAttachmentSummary["status"],
    activeConnectionCount: attachment.activeConnectionCount,
    bytesFromSource: attachment.bytesFromSource,
    bytesToSource: attachment.bytesToSource,
    lastError: attachment.lastError,
    expiresAt: attachment.expiresAt?.toISOString() ?? null,
    lastSeenAt: attachment.lastSeenAt?.toISOString() ?? null,
    createdAt: attachment.createdAt.toISOString(),
    updatedAt: attachment.updatedAt.toISOString(),
  };
}

function tunnelCapabilities(
  tunnel: TunnelRow,
  attachments: TunnelAttachmentSummary[],
): TunnelSummary["capabilities"] {
  const userManaged = tunnel.management === "user-managed";
  if (!userManaged) {
    const browserDesktopAttachment =
      tunnel.origin === "browser" &&
      tunnel.management === "managed-ephemeral" &&
      tunnel.sourceEndpoint.kind === "desktop-loopback";
    return {
      canEdit: false,
      canDelete: false,
      canStart: false,
      canStop: false,
      canAttach: browserDesktopAttachment && tunnel.status !== "stopping",
      canOpenOwner: tunnel.managedByKind !== null,
    };
  }
  const attached = attachments.some(
    ({ status }) => status !== "stopped" && status !== "failed",
  );
  const stopped = tunnel.status === "stopped" || tunnel.status === "failed";
  return {
    canEdit: stopped && !attached,
    canDelete: stopped && !attached,
    canStart: stopped && !attached,
    canStop: attached || (!stopped && tunnel.status !== "stopping"),
    canAttach: tunnel.status !== "stopping",
    canOpenOwner: false,
  };
}

function toTunnelSummary(
  tunnel: TunnelRow,
  attachmentRows: TunnelAttachmentRow[] = [],
): TunnelSummary {
  const attachments = attachmentRows.map(toTunnelAttachmentSummary);
  return {
    id: tunnel.id,
    name: tunnel.name,
    description: tunnel.description,
    projectId: tunnel.projectId,
    position: tunnel.position,
    origin: tunnel.origin as TunnelSummary["origin"],
    management: tunnel.management as TunnelSummary["management"],
    protocolHint: tunnel.protocolHint as TunnelSummary["protocolHint"],
    source: tunnel.sourceEndpoint,
    destination: tunnel.destinationEndpoint,
    managedBy:
      tunnel.managedByKind && tunnel.managedById
        ? {
            kind: tunnel.managedByKind as NonNullable<
              TunnelSummary["managedBy"]
            >["kind"],
            id: tunnel.managedById,
          }
        : null,
    desiredState: tunnel.desiredState as TunnelSummary["desiredState"],
    status: tunnel.status as TunnelSummary["status"],
    lastError: tunnel.lastError,
    activeConnectionCount: tunnel.activeConnectionCount,
    bytesFromSource: tunnel.bytesFromSource,
    bytesToSource: tunnel.bytesToSource,
    attachments,
    capabilities: tunnelCapabilities(tunnel, attachments),
    createdAt: tunnel.createdAt.toISOString(),
    updatedAt: tunnel.updatedAt.toISOString(),
  };
}

function sourceWorkerId(source: TunnelSourceEndpoint): string | null {
  return source.kind === "worker-listener" ? source.workerId : null;
}

function destinationWorkerId(destination: TunnelDestinationEndpoint): string {
  return destination.workerId;
}

function toProjectReplicaSummary(
  source: ProjectSourceRow,
  worker: WorkerRow,
  worktrees: ProjectWorktreeRow[],
): ProjectReplicaSummary {
  const primary = worktrees.find((worktree) => worktree.isPrimary) ?? null;
  const observedStatus = primary?.statusSnapshot?.status ?? null;
  const workerSummary = toWorkerSummary(worker);
  return {
    id: source.id,
    projectId: source.projectId,
    sourceKind: source.sourceKind,
    workerId: source.workerId,
    workerName: workerSummary.name,
    workerOnline: workerSummary.online,
    path: source.absolutePath,
    displayPath: source.displayPath,
    repositoryFingerprint: source.repositoryFingerprint,
    primaryWorktreeId: primary?.id ?? null,
    branch: observedStatus?.branch ?? primary?.branch ?? null,
    head: observedStatus?.head ?? primary?.head ?? null,
    dirty: observedStatus ? observedStatus.files.length > 0 : null,
    ready: primary?.lifecycleState === "ready",
    worktreeCount: worktrees.length,
    lastObservedAt: primary?.statusObservedAt
      ? toISOString(primary.statusObservedAt)
      : null,
    createdAt: toISOString(source.createdAt),
    updatedAt: toISOString(source.updatedAt),
  };
}

function parseMcpSecretMap(
  secretVault: SecretVault,
  server: McpServerRow,
  field: "environment" | "headers",
): Record<string, string> {
  const envelope =
    field === "environment"
      ? server.environmentEnvelope
      : server.headersEnvelope;
  const legacy = field === "environment" ? server.environment : server.headers;
  const encrypted = envelope
    ? JSON.parse(
        secretVault.decrypt(
          envelope,
          mcpServerSecretContext(server.ownerId, server.id, field),
        ),
      )
    : {};
  if (
    !encrypted ||
    typeof encrypted !== "object" ||
    Array.isArray(encrypted) ||
    Object.keys(encrypted).length > 100 ||
    Object.entries(encrypted).some(
      ([key, value]) =>
        !key ||
        key.length > 256 ||
        typeof value !== "string" ||
        value.length > 65_536,
    )
  ) {
    throw new Error("Encrypted MCP server configuration is malformed.");
  }
  return {
    ...(encrypted as Record<string, string>),
    ...legacy,
  };
}

function maskMcpSecretMap(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(values).map((key) => [key, MCP_SECRET_MASK]),
  );
}

function toMcpServerSummary(
  server: McpServerRow,
  secretVault: SecretVault,
): McpServerSummary {
  const metadata = {
    id: server.id,
    scope: server.projectId ? ("project" as const) : ("global" as const),
    projectId: server.projectId,
    createdAt: toISOString(server.createdAt),
    updatedAt: toISOString(server.updatedAt),
  };
  if (server.transport === "stdio") {
    return {
      ...metadata,
      name: server.name,
      transport: "stdio",
      command: server.command!,
      args: server.args,
      environment: maskMcpSecretMap(
        parseMcpSecretMap(secretVault, server, "environment"),
      ),
      enabled: server.enabled,
    };
  }
  return {
    ...metadata,
    name: server.name,
    transport: "http",
    url: server.url!,
    bearerTokenEnvironmentVariable: server.bearerTokenEnvironmentVariable,
    headers: maskMcpSecretMap(
      parseMcpSecretMap(secretVault, server, "headers"),
    ),
    environmentHeaders: server.environmentHeaders,
    enabled: server.enabled,
  };
}

function toMcpServerRuntimeConfiguration(
  server: McpServerRow,
  secretVault: SecretVault,
): McpServerConfiguration {
  if (server.transport === "stdio") {
    return {
      name: server.name,
      transport: "stdio",
      command: server.command!,
      args: server.args,
      environment: parseMcpSecretMap(secretVault, server, "environment"),
      enabled: server.enabled,
    };
  }
  return {
    name: server.name,
    transport: "http",
    url: server.url!,
    bearerTokenEnvironmentVariable: server.bearerTokenEnvironmentVariable,
    headers: parseMcpSecretMap(secretVault, server, "headers"),
    environmentHeaders: server.environmentHeaders,
    enabled: server.enabled,
  };
}

function resolveMcpSecretInput(
  input: Record<string, string>,
  existing: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (value !== MCP_SECRET_MASK) return [key, value];
      if (!(key in existing)) {
        throw new Error(
          `MCP secret placeholder for ${key} does not reference an existing value.`,
        );
      }
      return [key, existing[key]!];
    }),
  );
}

function encryptMcpSecretMap(
  secretVault: SecretVault,
  ownerId: string,
  serverId: string,
  field: "environment" | "headers",
  values: Record<string, string>,
): string | null {
  return Object.keys(values).length === 0
    ? null
    : secretVault.encrypt(
        JSON.stringify(values),
        mcpServerSecretContext(ownerId, serverId, field),
      );
}

function mcpServerValues(
  input: McpServerConfiguration,
  ownerId: string,
  serverId: string,
  secretVault: SecretVault,
  existing: McpServerRow | null = null,
) {
  const existingEnvironment = existing
    ? parseMcpSecretMap(secretVault, existing, "environment")
    : {};
  const existingHeaders = existing
    ? parseMcpSecretMap(secretVault, existing, "headers")
    : {};
  if (input.transport === "stdio") {
    const environment = resolveMcpSecretInput(
      input.environment,
      existingEnvironment,
    );
    return {
      name: input.name,
      transport: input.transport,
      command: input.command,
      args: input.args,
      url: null,
      environment: {},
      environmentEnvelope: encryptMcpSecretMap(
        secretVault,
        ownerId,
        serverId,
        "environment",
        environment,
      ),
      headers: {},
      headersEnvelope: null,
      environmentHeaders: {},
      bearerTokenEnvironmentVariable: null,
      enabled: input.enabled,
    };
  }
  const headers = resolveMcpSecretInput(input.headers, existingHeaders);
  return {
    name: input.name,
    transport: input.transport,
    command: null,
    args: [],
    url: input.url,
    environment: {},
    environmentEnvelope: null,
    headers: {},
    headersEnvelope: encryptMcpSecretMap(
      secretVault,
      ownerId,
      serverId,
      "headers",
      headers,
    ),
    environmentHeaders: input.environmentHeaders,
    bearerTokenEnvironmentVariable: input.bearerTokenEnvironmentVariable,
    enabled: input.enabled,
  };
}

function toProjectWorkspaceSummary(
  workspace: ProjectWorkspaceRow,
  projectIds: string[],
): ProjectWorkspaceSummary {
  if (workspace.name === null) {
    throw new ProjectWorkspaceInvariantError(
      "Encrypted workspace names must be decrypted by the client.",
    );
  }
  return {
    id: workspace.id,
    name: workspace.name,
    position: workspace.position,
    isDefault: workspace.isDefault,
    projectIds,
    revision: workspace.revision,
    createdAt: toISOString(workspace.createdAt),
    updatedAt: toISOString(workspace.updatedAt),
  };
}

function toProjectWorkspaceWireSummary(
  workspace: ProjectWorkspaceRow,
  projectIds: string[],
): ProjectWorkspaceWireSummary {
  if (
    workspace.name === null &&
    (workspace.nameFormatVersion !== 1 ||
      workspace.nameKeyRevision === null ||
      workspace.nameBlindIndex === null ||
      workspace.nameEnvelope === null ||
      workspace.nameEnvelope.keyRevision !== workspace.nameKeyRevision)
  ) {
    throw new ProjectWorkspaceInvariantError(
      "Encrypted workspace name metadata is incomplete.",
    );
  }
  const nameProtection: ProjectWorkspaceWireSummary["nameProtection"] =
    workspace.name === null
      ? {
          state: "encrypted",
          formatVersion: 1,
          keyRevision: workspace.nameKeyRevision!,
          blindIndex: workspace.nameBlindIndex!,
          envelope: workspace.nameEnvelope!,
        }
      : { state: "legacy", plaintext: workspace.name };
  return {
    id: workspace.id,
    nameProtection,
    position: workspace.position,
    isDefault: workspace.isDefault,
    projectIds,
    revision: workspace.revision,
    createdAt: toISOString(workspace.createdAt),
    updatedAt: toISOString(workspace.updatedAt),
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
    rootKind: worktree.rootKind,
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

function toGitManagedOperationRecord(
  operation: GitOperationRow,
): GitManagedOperationRecord {
  return {
    id: operation.id,
    projectId: operation.projectId,
    worktreeId: operation.worktreeId,
    workerId: operation.workerId,
    type: operation.type,
    state: operation.state,
    originalHead: operation.originalHead,
    currentHead: operation.currentHead,
    sourceRef: operation.sourceRef,
    sourceRevision: operation.sourceRevision,
    targetRef: operation.targetRef,
    targetRevision: operation.targetRevision,
    pendingCommits: operation.pendingCommits,
    currentStep: operation.currentStep,
    totalSteps: operation.totalSteps,
    conflictedPaths: operation.conflictedPaths,
    output: operation.output,
    checkpointRef: operation.checkpointRef,
    pausedAction: operation.pausedAction,
    error: operation.error,
    createdAt: toISOString(operation.createdAt),
    updatedAt: toISOString(operation.updatedAt),
    completedAt: operation.completedAt
      ? toISOString(operation.completedAt)
      : null,
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
    experience: chat.experience as ChatSummary["experience"],
    position: chat.position,
    status: chat.status as ChatSummary["status"],
    activeWorkerId: chat.activeWorkerId,
    activeWorktreeId: chat.activeWorktreeId,
    placementRevision: chat.placementRevision,
    worktreeMode: chat.worktreeMode as ChatSummary["worktreeMode"],
    modelId: chat.modelId,
    reasoningEffort: chat.reasoningEffort,
    permissionProfileId: chat.permissionProfileId,
    planMode: chat.planMode as ChatSummary["planMode"],
    hasPendingPlanQuestion: chat.pendingPlanQuestion !== null,
    automationPaused: chat.automationPaused,
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  };
}

function toArchivedChatSummary(
  chat: typeof schema.chats.$inferSelect,
  messageCount: number,
): ArchivedChatSummary {
  if (!chat.archivedAt) {
    throw new Error("Cannot summarize an active chat as archived.");
  }
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    experience: chat.experience as ArchivedChatSummary["experience"],
    messageCount,
    archivedAt: toISOString(chat.archivedAt),
    expiresAt: new Date(
      chat.archivedAt.getTime() + ARCHIVED_CHAT_RETENTION_MS,
    ).toISOString(),
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
    service: {
      enabled: terminal.serviceEnabled,
      command: terminal.serviceCommand,
    },
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
    selectedPath: explorer.selectedPath,
    fileMode: explorer.fileMode as ExplorerSummary["fileMode"],
    createdAt: toISOString(explorer.createdAt),
    updatedAt: toISOString(explorer.updatedAt),
  };
}

function toBrowserSummary(
  browser: typeof schema.browsers.$inferSelect,
  workerId: string | null = null,
): BrowserSummary {
  return {
    id: browser.id,
    projectId: browser.projectId,
    title: browser.title,
    position: browser.position,
    url: browser.url,
    workerId,
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

function toCodeTabSummary(
  codeTab: typeof schema.codeTabs.$inferSelect,
): CodeTabSummary {
  return {
    id: codeTab.id,
    projectId: codeTab.projectId,
    title: codeTab.title,
    position: codeTab.position,
    activeWorkerId: codeTab.activeWorkerId,
    worktreeId: codeTab.worktreeId,
    profileId: codeTab.profileId,
    themeMode: codeTab.themeMode as CodeTabSummary["themeMode"],
    status: codeTab.status as CodeTabSummary["status"],
    lastError: codeTab.lastError,
    createdAt: toISOString(codeTab.createdAt),
    updatedAt: toISOString(codeTab.updatedAt),
  };
}

function toCodeSessionSummary(
  session: typeof schema.codeSessions.$inferSelect,
): CodeSessionSummary {
  return {
    id: session.id,
    codeTabId: session.codeTabId,
    projectId: session.projectId,
    workerId: session.workerId,
    worktreeId: session.worktreeId,
    profileId: session.profileId,
    editorBuild: {
      version: session.editorVersion,
      upstreamRevision: session.editorUpstreamRevision,
      patchset: session.editorPatchset,
      fingerprint: session.editorFingerprint,
    },
    status: session.status as CodeSessionSummary["status"],
    processInstanceId: session.processInstanceId,
    lastAttachmentAt: session.lastAttachmentAt
      ? toISOString(session.lastAttachmentAt)
      : null,
    lastStartedAt: session.lastStartedAt
      ? toISOString(session.lastStartedAt)
      : null,
    stoppedAt: session.stoppedAt ? toISOString(session.stoppedAt) : null,
    lastError: session.lastError,
    createdAt: toISOString(session.createdAt),
    updatedAt: toISOString(session.updatedAt),
  };
}

function toWorkerSummary(
  worker: typeof schema.workers.$inferSelect,
): WorkerSummary {
  return {
    workerId: worker.id,
    name: worker.displayName ?? worker.name,
    platform: worker.platform,
    architecture: worker.architecture,
    codexVersion: worker.codexVersion,
    codexRuntime: worker.codexRuntime,
    remoteSurfaces: worker.remoteSurfaceCapabilities,
    directBroker: worker.directBrokerAdvertisement,
    code: worker.codeCapabilities,
    codegraph: worker.codegraphStatus,
    encryption: worker.encryptionStatus,
    projectReplicas: worker.projectReplicaCapabilities,
    managedFolders: worker.managedFolderCapabilities,
    chatRelocation: worker.chatRelocationCapability,
    externalCodexHistory: worker.externalCodexHistoryCapability,
    startedAt: toISOString(worker.startedAt),
    lastSeenAt: toISOString(worker.lastSeenAt),
    online: Date.now() - worker.lastSeenAt.getTime() <= WORKER_ONLINE_WINDOW_MS,
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
  if (payload.kind === "permissions") {
    if (response.kind !== "permissions") return;
    if (
      !jsonPermissionSubset(response.permissions, payload.requestedPermissions)
    ) {
      throw new AgentInteractionConflictError(
        "Granted permissions must be a subset of the requested permissions.",
      );
    }
  }
}

function jsonPermissionSubset(granted: unknown, requested: unknown): boolean {
  if (Array.isArray(granted)) {
    if (!Array.isArray(requested)) return false;
    return granted.every((candidate) =>
      requested.some(
        (allowed) => JSON.stringify(candidate) === JSON.stringify(allowed),
      ),
    );
  }
  if (granted && typeof granted === "object") {
    if (
      !requested ||
      typeof requested !== "object" ||
      Array.isArray(requested)
    ) {
      return false;
    }
    const requestedRecord = requested as Record<string, unknown>;
    return Object.entries(granted).every(
      ([key, value]) =>
        key in requestedRecord &&
        jsonPermissionSubset(value, requestedRecord[key]),
    );
  }
  return Object.is(granted, requested);
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
    target: surface.configuration.target ?? {
      kind: "monitor",
      id: null,
      name: null,
    },
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
  tokenUsage: TokenUsageTotals = ZERO_TOKEN_USAGE,
  accounts: ModelProviderAccountSummary[] = [],
): ModelProviderSummary {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind as ModelProviderSummary["kind"],
    baseUrl: provider.baseUrl,
    hasApiKey: provider.apiKeyEnvelope !== null || provider.apiKey !== null,
    weeklyUsageReservePercent: provider.weeklyUsageReservePercent,
    accounts,
    tokenUsage,
    createdAt: toISOString(provider.createdAt),
    updatedAt: toISOString(provider.updatedAt),
  };
}

function toProviderAccountSummary(
  account: typeof schema.modelProviderAccounts.$inferSelect,
  workerBindings: Array<
    typeof schema.modelProviderAccountWorkers.$inferSelect
  > = [],
): ModelProviderAccountSummary {
  return {
    id: account.id,
    providerId: account.providerId,
    label: account.label,
    email: account.email,
    planType: account.planType,
    position: account.position,
    enabled: account.enabled,
    credentialState:
      account.credentialState as ModelProviderAccountSummary["credentialState"],
    weeklyUsageUsedPercent:
      account.weeklyUsageUsedBasisPoints === null
        ? null
        : account.weeklyUsageUsedBasisPoints / 100,
    weeklyUsageResetsAt: account.weeklyUsageResetsAt
      ? toISOString(account.weeklyUsageResetsAt)
      : null,
    authLastSyncedAt: account.authLastSyncedAt
      ? toISOString(account.authLastSyncedAt)
      : null,
    workerBindings: workerBindings.map((binding) => ({
      workerId: binding.workerId,
      authState:
        binding.authState as ModelProviderAccountSummary["workerBindings"][number]["authState"],
      weeklyUsageUsedPercent:
        binding.weeklyUsageUsedBasisPoints === null
          ? null
          : binding.weeklyUsageUsedBasisPoints / 100,
      weeklyUsageResetsAt: binding.weeklyUsageResetsAt
        ? toISOString(binding.weeklyUsageResetsAt)
        : null,
      lastSyncedAt: binding.lastSyncedAt
        ? toISOString(binding.lastSyncedAt)
        : null,
    })),
    createdAt: toISOString(account.createdAt),
    updatedAt: toISOString(account.updatedAt),
  };
}

function toProviderModelCatalogEntry(
  model: typeof schema.providerModels.$inferSelect,
): ProviderModelCatalogEntry {
  return {
    id: model.id,
    providerId: model.providerId,
    nativeModelId: model.nativeModelId,
    canonicalModelId: model.canonicalModelId,
    displayName: model.displayName,
    description: model.description,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    supportsTools: model.supportsTools,
    supportsParallelTools: model.supportsParallelTools,
    supportsStructuredOutput: model.supportsStructuredOutput,
    supportsVision: model.supportsVision,
    supportsReasoning: model.supportsReasoning,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    reasoningMandatory: model.reasoningMandatory,
    family: model.family,
    parameterSize: model.parameterSize,
    quantization: model.quantization,
    digest: model.digest,
    metadataSource:
      model.metadataSource as ProviderModelCatalogEntry["metadataSource"],
    matchConfidence:
      model.matchConfidenceBasisPoints === null
        ? null
        : model.matchConfidenceBasisPoints / 10_000,
    hidden: model.hidden,
    isDefault: model.isDefault,
    lastSeenAt: toISOString(model.lastSeenAt),
    createdAt: toISOString(model.createdAt),
    updatedAt: toISOString(model.updatedAt),
  };
}

function toProviderModelAvailability(
  availability: typeof schema.providerModelAvailability.$inferSelect,
): ProviderModelAvailability {
  return {
    id: availability.id,
    providerModelId: availability.providerModelId,
    scopeKey: availability.scopeKey,
    workerId: availability.workerId,
    providerAccountId: availability.providerAccountId,
    state: availability.state as ProviderModelAvailability["state"],
    lastSeenAt: toISOString(availability.lastSeenAt),
    updatedAt: toISOString(availability.updatedAt),
  };
}

function toProviderCatalogSyncState(
  state: typeof schema.providerCatalogSyncStates.$inferSelect,
): ProviderCatalogSyncState {
  return {
    id: state.id,
    providerId: state.providerId,
    scopeKey: state.scopeKey,
    workerId: state.workerId,
    providerAccountId: state.providerAccountId,
    status: state.status as ProviderCatalogSyncState["status"],
    error: state.error,
    etag: state.etag,
    refreshStartedAt: state.refreshStartedAt
      ? toISOString(state.refreshStartedAt)
      : null,
    lastSuccessAt: state.lastSuccessAt
      ? toISOString(state.lastSuccessAt)
      : null,
    updatedAt: toISOString(state.updatedAt),
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
    providerModelId: route.providerModelId,
    modelName: route.modelName,
    position: route.position,
    enabled: route.enabled,
    discoveryManaged: route.discoveryManaged,
  };
}

function toModelSummary(
  model: typeof schema.modelProfiles.$inferSelect,
  routes: ModelRouteSummary[],
  tokenUsage: TokenUsageTotals = ZERO_TOKEN_USAGE,
): ModelProfileSummary {
  return {
    id: model.id,
    name: model.name,
    canonicalModelId: model.canonicalModelId,
    defaultReasoningEffort: model.defaultReasoningEffort,
    discoveryManaged: model.discoveryManaged,
    routingPolicy: "priority",
    routes,
    tokenUsage,
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
    mode: message.mode,
    content: message.content,
    modelId: message.modelId,
    modelRouteId: message.modelRouteId,
    providerId: message.providerId,
    providerName: message.providerName,
    providerModelName: message.providerModelName,
    reasoningEffort: message.reasoningEffort,
    appliedReasoningEffort: message.appliedReasoningEffort,
    reasoningAdjusted: message.reasoningAdjusted,
    createdAt: toISOString(message.createdAt),
  };
}

function toChatAttachment(
  attachment: typeof schema.chatAttachments.$inferSelect,
): ChatAttachmentRecord {
  return {
    id: attachment.id,
    chatId: attachment.chatId,
    workerId: attachment.workerId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    source: attachment.source,
    status: attachment.status as ChatAttachmentSummary["status"],
    previewText: attachment.previewText,
    sha256: attachment.sha256,
    createdAt: toISOString(attachment.createdAt),
  };
}

function toQueuedPrompt(
  prompt: typeof schema.queuedPrompts.$inferSelect,
): QueuedPrompt {
  return {
    id: prompt.id,
    chatId: prompt.chatId,
    text: prompt.text,
    mode: prompt.mode,
    attachments: prompt.attachments,
    modelId: prompt.modelId,
    reasoningEffort: prompt.reasoningEffort,
    worktreeId: prompt.worktreeId,
    position: prompt.position,
    frozen: prompt.frozen,
    createdAt: toISOString(prompt.createdAt),
    updatedAt: toISOString(prompt.updatedAt),
  };
}

export class ServerRepository {
  readonly chatImportJobs: ChatImportJobRepository;
  readonly chatRelocationJobs: ChatRelocationJobRepository;
  readonly encryptionRegistry: EncryptionRegistryRepository;
  readonly projectAutomations: ProjectAutomationRepository;
  readonly policies: PolicyRepository;
  readonly tasks: TaskRepository;
  readonly projectReplicaJobs: ProjectReplicaJobRepository;
  readonly projectFolderSetupJobs: ProjectFolderSetupJobRepository;
  readonly projectGithubConversionJobs: ProjectGithubConversionJobRepository;
  readonly tabLayouts: ProjectTabLayoutRepository;
  readonly workflows: WorkflowRepository;
  readonly workflowRuns: WorkflowRunRepository;
  readonly workflowTriggers: WorkflowTriggerRepository;

  constructor(
    private readonly database: RepositoryDatabase,
    private readonly secretVault: SecretVault,
  ) {
    this.chatImportJobs = new ChatImportJobRepository(database);
    this.chatRelocationJobs = new ChatRelocationJobRepository(database);
    this.encryptionRegistry = new EncryptionRegistryRepository(database);
    this.projectAutomations = new ProjectAutomationRepository(database);
    this.policies = new PolicyRepository(database);
    this.tasks = new TaskRepository(database);
    this.projectReplicaJobs = new ProjectReplicaJobRepository(database);
    this.projectFolderSetupJobs = new ProjectFolderSetupJobRepository(database);
    this.projectGithubConversionJobs = new ProjectGithubConversionJobRepository(
      database,
    );
    this.workflows = new WorkflowRepository(database);
    this.workflowRuns = new WorkflowRunRepository(database);
    this.workflowTriggers = new WorkflowTriggerRepository(database);
    this.tabLayouts = new ProjectTabLayoutRepository(database);
  }

  async migrateProviderSecrets(): Promise<void> {
    const providers = await this.database.select().from(schema.modelProviders);
    for (const provider of providers) {
      const context = modelProviderSecretContext(provider.ownerId, provider.id);
      if (provider.apiKeyEnvelope) {
        const plaintext = this.secretVault.decrypt(
          provider.apiKeyEnvelope,
          context,
        );
        const needsRotation = this.secretVault.needsRotation(
          provider.apiKeyEnvelope,
        );
        if (!provider.apiKey && !needsRotation) continue;
        await this.database
          .update(schema.modelProviders)
          .set({
            apiKey: null,
            updatedAt: new Date(),
            ...(needsRotation
              ? {
                  apiKeyEnvelope: this.secretVault.encrypt(plaintext, context),
                }
              : {}),
          })
          .where(eq(schema.modelProviders.id, provider.id));
        continue;
      }
      if (provider.apiKey) {
        await this.database
          .update(schema.modelProviders)
          .set({
            apiKey: null,
            apiKeyEnvelope: this.secretVault.encrypt(provider.apiKey, context),
            updatedAt: new Date(),
          })
          .where(eq(schema.modelProviders.id, provider.id));
      }
    }
  }

  async migrateProviderAccountCredentialSecrets(): Promise<void> {
    const rows = await this.database
      .select({
        account: schema.modelProviderAccounts,
        kind: schema.modelProviders.kind,
        ownerId: schema.modelProviders.ownerId,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
      )
      .where(isNotNull(schema.modelProviderAccounts.credentialEnvelope));

    for (const { account, kind, ownerId } of rows) {
      if (!isAccountProviderKind(kind) || !account.credentialEnvelope) {
        throw new Error(
          "Stored provider account credential has an invalid provider kind.",
        );
      }
      const context = modelProviderAccountSecretContext(
        ownerId,
        account.providerId,
        account.id,
        kind,
      );
      const credential = parseProviderCredential(
        this.secretVault.decrypt(account.credentialEnvelope, context),
        kind,
      );
      const subject = providerCredentialSubject(credential);
      if (account.credentialSubject && account.credentialSubject !== subject) {
        throw new ProviderCredentialIdentityConflictError();
      }
      const needsRotation = this.secretVault.needsRotation(
        account.credentialEnvelope,
      );
      if (
        !needsRotation &&
        account.credentialSubject === subject &&
        account.email === credential.email &&
        account.planType === credential.planType &&
        (account.credentialExpiresAt?.getTime() ?? null) ===
          credential.expiresAt
      ) {
        continue;
      }
      await this.database
        .update(schema.modelProviderAccounts)
        .set({
          credentialSubject: subject,
          credentialExpiresAt: credential.expiresAt
            ? new Date(credential.expiresAt)
            : null,
          email: credential.email,
          planType: credential.planType,
          ...(needsRotation
            ? {
                credentialEnvelope: this.secretVault.encrypt(
                  serializeProviderCredential(credential),
                  context,
                ),
              }
            : {}),
        })
        .where(eq(schema.modelProviderAccounts.id, account.id));
    }
  }

  async migrateMcpServerSecrets(): Promise<void> {
    const servers = await this.database.select().from(schema.mcpServers);
    for (const server of servers) {
      const environment = parseMcpSecretMap(
        this.secretVault,
        server,
        "environment",
      );
      const headers = parseMcpSecretMap(this.secretVault, server, "headers");
      const environmentNeedsRotation = Boolean(
        server.environmentEnvelope &&
        this.secretVault.needsRotation(server.environmentEnvelope),
      );
      const headersNeedRotation = Boolean(
        server.headersEnvelope &&
        this.secretVault.needsRotation(server.headersEnvelope),
      );
      if (
        Object.keys(server.environment).length === 0 &&
        Object.keys(server.headers).length === 0 &&
        !environmentNeedsRotation &&
        !headersNeedRotation
      ) {
        continue;
      }
      await this.database
        .update(schema.mcpServers)
        .set({
          environment: {},
          environmentEnvelope: encryptMcpSecretMap(
            this.secretVault,
            server.ownerId,
            server.id,
            "environment",
            environment,
          ),
          headers: {},
          headersEnvelope: encryptMcpSecretMap(
            this.secretVault,
            server.ownerId,
            server.id,
            "headers",
            headers,
          ),
          updatedAt: new Date(),
        })
        .where(eq(schema.mcpServers.id, server.id));
    }
  }

  async ensureLocalIdentity(): Promise<UserSummary> {
    const now = new Date();
    const result = await this.database
      .insert(schema.users)
      .values({
        id: LOCAL_USER_ID,
        kind: "anonymous",
        role: "owner",
        status: "active",
        displayName: "Local User",
        email: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.users.id,
        set: { role: "owner", status: "active", updatedAt: now },
      })
      .returning();
    const user = firstOrThrow(result, "ensuring the local user");
    await this.ensureDefaultProjectWorkspace(user.id);

    return {
      id: user.id,
      kind: "anonymous",
      displayName: user.displayName,
      email: user.email,
      role: "owner",
    };
  }

  async countAccountUsers(): Promise<number> {
    const rows = await this.database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(eq(schema.users.kind, "account"));
    return rows[0]?.count ?? 0;
  }

  async desktopUpdateActiveWork(
    ownerId: string,
  ): Promise<DesktopUpdateActiveWorkSummary> {
    const count = sql<number>`count(*)::int`;
    const [
      activeChats,
      queuedPrompts,
      terminalServices,
      workflowRuns,
      projectReplicaJobs,
      chatRelocationJobs,
      chatImportJobs,
      projectAutomationRuns,
      gitOperations,
    ] = await Promise.all([
      this.database
        .select({ count })
        .from(schema.chats)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(
          and(
            isNull(schema.chats.archivedAt),
            inArray(schema.chats.status, ["running", "waiting-for-approval"]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.queuedPrompts)
        .innerJoin(
          schema.chats,
          eq(schema.chats.id, schema.queuedPrompts.chatId),
        )
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.terminals)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.terminals.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(eq(schema.terminals.serviceEnabled, true)),
      this.database
        .select({ count })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "queued",
              "running",
              "waiting",
              "cancelling",
              "recovering",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.projectReplicaJobs)
        .where(
          and(
            eq(schema.projectReplicaJobs.ownerId, ownerId),
            inArray(schema.projectReplicaJobs.state, [
              "queued",
              "running",
              "blocked",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.chatRelocationJobs)
        .where(
          and(
            eq(schema.chatRelocationJobs.ownerId, ownerId),
            inArray(schema.chatRelocationJobs.state, [
              "queued",
              "waiting-for-idle",
              "validating",
              "preparing-replica",
              "transferring-attachments",
              "hydrating-runtime",
              "ready-to-commit",
              "blocked",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.chatImportJobs)
        .where(
          and(
            eq(schema.chatImportJobs.ownerId, ownerId),
            inArray(schema.chatImportJobs.state, [
              "queued",
              "reading",
              "importing",
              "awaiting-hydration",
              "hydrating",
              "blocked",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.projectAutomationRuns)
        .where(
          and(
            eq(schema.projectAutomationRuns.ownerId, ownerId),
            inArray(schema.projectAutomationRuns.status, [
              "dispatching",
              "started",
              "queued",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.gitOperations)
        .where(
          and(
            eq(schema.gitOperations.ownerId, ownerId),
            inArray(schema.gitOperations.state, [
              "queued",
              "running",
              "conflicted",
              "awaiting-user-action",
            ]),
          ),
        ),
    ]);

    const maximum = 4_294_967_295;
    const value = (rows: Array<{ count: number }>) =>
      Math.min(maximum, rows[0]?.count ?? 0);
    const backgroundJobs =
      value(workflowRuns) +
      value(projectReplicaJobs) +
      value(chatRelocationJobs) +
      value(chatImportJobs) +
      value(projectAutomationRuns) +
      value(gitOperations);
    return {
      activeChats: value(activeChats),
      queuedPrompts: value(queuedPrompts),
      terminalServices: value(terminalServices),
      backgroundJobs: Math.min(maximum, backgroundJobs),
    };
  }

  async accountEmailIsWhitelisted(normalizedEmail: string): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.accountLicenseWhitelist.id })
      .from(schema.accountLicenseWhitelist)
      .where(
        eq(schema.accountLicenseWhitelist.normalizedEmail, normalizedEmail),
      )
      .limit(1);
    return Boolean(rows[0]);
  }

  async listAccountLicenseWhitelist(): Promise<AccountLicenseWhitelistEntry[]> {
    const rows = await this.database
      .select({
        entry: schema.accountLicenseWhitelist,
        registeredUserId: schema.users.id,
      })
      .from(schema.accountLicenseWhitelist)
      .leftJoin(
        schema.users,
        and(
          eq(schema.users.kind, "account"),
          eq(
            schema.users.normalizedEmail,
            schema.accountLicenseWhitelist.normalizedEmail,
          ),
        ),
      )
      .orderBy(
        asc(schema.accountLicenseWhitelist.createdAt),
        asc(schema.accountLicenseWhitelist.email),
      );
    return rows.map(({ entry, registeredUserId }) =>
      toAccountLicenseWhitelistEntry(entry, Boolean(registeredUserId)),
    );
  }

  async createAccountLicenseWhitelistEntry(input: {
    addedByUserId: string;
    email: string;
    normalizedEmail: string;
  }): Promise<AccountLicenseWhitelistEntry | null> {
    const rows = await this.database
      .insert(schema.accountLicenseWhitelist)
      .values({
        id: randomUUID(),
        email: input.email,
        normalizedEmail: input.normalizedEmail,
        addedByUserId: input.addedByUserId,
      })
      .onConflictDoNothing({
        target: schema.accountLicenseWhitelist.normalizedEmail,
      })
      .returning();
    const entry = rows[0];
    return entry ? toAccountLicenseWhitelistEntry(entry, false) : null;
  }

  async deleteAccountLicenseWhitelistEntry(id: string): Promise<boolean> {
    const rows = await this.database
      .delete(schema.accountLicenseWhitelist)
      .where(eq(schema.accountLicenseWhitelist.id, id))
      .returning({ id: schema.accountLicenseWhitelist.id });
    return Boolean(rows[0]);
  }

  async createAccount(input: {
    displayName: string;
    email: string;
    normalizedEmail: string;
    passwordHash: string;
    role: UserSummary["role"];
  }): Promise<UserSummary> {
    const now = new Date();
    const rows = await this.database
      .insert(schema.users)
      .values({
        id: randomUUID(),
        kind: "account",
        role: input.role,
        status: "active",
        displayName: input.displayName,
        email: input.email,
        normalizedEmail: input.normalizedEmail,
        passwordHash: input.passwordHash,
        passwordChangedAt: now,
        updatedAt: now,
      })
      .returning();
    const user = firstOrThrow(rows, "creating an account");
    await this.ensureDefaultProjectWorkspace(user.id);
    await this.policies.ensureBootstrap(user.id);
    return toUserSummary(user);
  }

  async findAccountCredential(
    normalizedEmail: string,
  ): Promise<AccountCredentialRecord | null> {
    const rows = await this.database
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.kind, "account"),
          eq(schema.users.normalizedEmail, normalizedEmail),
          eq(schema.users.status, "active"),
        ),
      )
      .limit(1);
    const user = rows[0];
    if (!user?.passwordHash) return null;
    return { passwordHash: user.passwordHash, user: toUserSummary(user) };
  }

  async findAccountCredentialById(
    ownerId: string,
  ): Promise<AccountCredentialRecord | null> {
    const rows = await this.database
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, ownerId),
          eq(schema.users.kind, "account"),
          eq(schema.users.status, "active"),
        ),
      )
      .limit(1);
    const user = rows[0];
    if (!user?.passwordHash) return null;
    return { passwordHash: user.passwordHash, user: toUserSummary(user) };
  }

  async createUserSession(input: {
    authMethod: ActiveUserSession["authMethod"];
    csrfTokenHash: string;
    expiresAt: Date;
    ipAddressHash: string | null;
    label: string | null;
    tokenHash: string;
    userAgentHash: string | null;
    userId: string;
  }): Promise<UserSessionRow> {
    const rows = await this.database
      .insert(schema.userSessions)
      .values({ id: randomUUID(), ...input })
      .returning();
    return firstOrThrow(rows, "creating a user session");
  }

  async getActiveUserSession(
    tokenHash: string,
  ): Promise<ActiveUserSession | null> {
    const rows = await this.database
      .select({ session: schema.userSessions, user: schema.users })
      .from(schema.userSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
      .where(
        and(
          eq(schema.userSessions.tokenHash, tokenHash),
          isNull(schema.userSessions.revokedAt),
          gt(schema.userSessions.expiresAt, new Date()),
          eq(schema.users.status, "active"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      authMethod: row.session.authMethod as ActiveUserSession["authMethod"],
      csrfTokenHash: row.session.csrfTokenHash,
      expiresAt: row.session.expiresAt,
      id: row.session.id,
      user: toUserSummary(row.user),
    };
  }

  async createMobileSignInGrant(input: {
    codeHash: string;
    createdBySessionId: string;
    expiresAt: Date;
    ownerId: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.insert(schema.mobileSignInGrants).values({
      id,
      ownerId: input.ownerId,
      createdBySessionId: input.createdBySessionId,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
    });
    return id;
  }

  async consumeMobileSignInGrant(
    codeHash: string,
  ): Promise<UserSummary | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const grants = await transaction
        .select()
        .from(schema.mobileSignInGrants)
        .where(
          and(
            eq(schema.mobileSignInGrants.codeHash, codeHash),
            isNull(schema.mobileSignInGrants.consumedAt),
            gt(schema.mobileSignInGrants.expiresAt, now),
          ),
        )
        .for("update")
        .limit(1);
      const grant = grants[0];
      if (!grant) return null;

      const creatingSessions = grant.createdBySessionId
        ? await transaction
            .select({ id: schema.userSessions.id })
            .from(schema.userSessions)
            .where(
              and(
                eq(schema.userSessions.id, grant.createdBySessionId),
                eq(schema.userSessions.userId, grant.ownerId),
                isNull(schema.userSessions.revokedAt),
                gt(schema.userSessions.expiresAt, now),
              ),
            )
            .limit(1)
        : [];
      if (!creatingSessions[0]) return null;

      const consumed = await transaction
        .update(schema.mobileSignInGrants)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.mobileSignInGrants.id, grant.id),
            isNull(schema.mobileSignInGrants.consumedAt),
          ),
        )
        .returning({ id: schema.mobileSignInGrants.id });
      if (!consumed[0]) return null;

      const users = await transaction
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.id, grant.ownerId),
            eq(schema.users.status, "active"),
          ),
        )
        .limit(1);
      return users[0] ? toUserSummary(users[0]) : null;
    });
  }

  async pruneMobileSignInGrants(before: Date): Promise<void> {
    await this.database
      .delete(schema.mobileSignInGrants)
      .where(lt(schema.mobileSignInGrants.expiresAt, before));
  }

  async isUserSessionActive(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.userSessions.id })
      .from(schema.userSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
      .where(
        and(
          eq(schema.userSessions.id, sessionId),
          eq(schema.userSessions.userId, userId),
          isNull(schema.userSessions.revokedAt),
          gt(schema.userSessions.expiresAt, new Date()),
          eq(schema.users.status, "active"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async rotateSessionCsrfToken(
    sessionId: string,
    csrfTokenHash: string,
  ): Promise<boolean> {
    const rows = await this.database
      .update(schema.userSessions)
      .set({ csrfTokenHash, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.userSessions.id, sessionId),
          isNull(schema.userSessions.revokedAt),
        ),
      )
      .returning({ id: schema.userSessions.id });
    return rows.length > 0;
  }

  async revokeUserSession(sessionId: string, reason: string): Promise<boolean> {
    const now = new Date();
    const rows = await this.database
      .update(schema.userSessions)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(
        and(
          eq(schema.userSessions.id, sessionId),
          isNull(schema.userSessions.revokedAt),
        ),
      )
      .returning({ id: schema.userSessions.id });
    return rows.length > 0;
  }

  async revokeAllUserSessions(userId: string, reason: string): Promise<number> {
    const now = new Date();
    const rows = await this.database
      .update(schema.userSessions)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(
        and(
          eq(schema.userSessions.userId, userId),
          isNull(schema.userSessions.revokedAt),
        ),
      )
      .returning({ id: schema.userSessions.id });
    return rows.length;
  }

  async listUserSessions(
    userId: string,
    currentSessionId: string | null,
  ): Promise<AccountSessionSummary[]> {
    const rows = await this.database
      .select()
      .from(schema.userSessions)
      .where(
        and(
          eq(schema.userSessions.userId, userId),
          isNull(schema.userSessions.revokedAt),
          gt(schema.userSessions.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(schema.userSessions.lastSeenAt))
      .limit(1_000);
    return rows.map((session) => ({
      id: session.id,
      authMethod: session.authMethod as AccountSessionSummary["authMethod"],
      label: session.label,
      current: session.id === currentSessionId,
      connected: false,
      createdAt: toISOString(session.createdAt),
      lastSeenAt: toISOString(session.lastSeenAt),
      expiresAt: toISOString(session.expiresAt),
    }));
  }

  async appendAuditEvent(input: AuditEventCreate): Promise<AuditEvent> {
    const rows = await this.database
      .insert(schema.auditEvents)
      .values(input)
      .returning();
    return toAuditEvent(firstOrThrow(rows, "appending an audit event"));
  }

  async listAuditEvents(
    query: AuditEventQuery,
    ownerId?: string,
  ): Promise<AuditEventList> {
    const filters = [
      ...(ownerId ? [eq(schema.auditEvents.ownerId, ownerId)] : []),
      ...(query.before ? [lt(schema.auditEvents.id, query.before)] : []),
    ];
    const rows = await this.database
      .select()
      .from(schema.auditEvents)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.auditEvents.id))
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(toAuditEvent);
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
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
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: DEFAULT_MODEL_ID,
        defaultPermissionProfileId: DEFAULT_PERMISSION_PROFILE_ID,
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

  async ensureAccountConfiguration(ownerId: string): Promise<void> {
    await this.database
      .insert(schema.userSettings)
      .values({
        userId: ownerId,
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
        defaultPermissionProfileId: DEFAULT_PERMISSION_PROFILE_ID,
      })
      .onConflictDoNothing({ target: schema.userSettings.userId });
  }

  async getSettings(ownerId: string): Promise<SettingsBundle> {
    const [
      settingsRows,
      providerRows,
      providerAccountRows,
      providerAccountWorkerRows,
      modelRows,
      routeRows,
      providerUsageRows,
      modelUsageRows,
    ] = await Promise.all([
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
        .select({ account: schema.modelProviderAccounts })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          and(
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
            eq(schema.modelProviders.ownerId, ownerId),
          ),
        )
        .orderBy(asc(schema.modelProviderAccounts.position)),
      this.database
        .select({ binding: schema.modelProviderAccountWorkers })
        .from(schema.modelProviderAccountWorkers)
        .innerJoin(
          schema.modelProviderAccounts,
          eq(
            schema.modelProviderAccounts.id,
            schema.modelProviderAccountWorkers.accountId,
          ),
        )
        .innerJoin(
          schema.modelProviders,
          and(
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
            eq(schema.modelProviders.ownerId, ownerId),
          ),
        ),
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
      this.database
        .select({
          id: schema.tokenUsageRecords.providerId,
          inputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.inputTokens}), 0)`.mapWith(
              Number,
            ),
          outputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.outputTokens}), 0)`.mapWith(
              Number,
            ),
        })
        .from(schema.tokenUsageRecords)
        .where(eq(schema.tokenUsageRecords.ownerId, ownerId))
        .groupBy(schema.tokenUsageRecords.providerId),
      this.database
        .select({
          id: schema.tokenUsageRecords.modelId,
          inputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.inputTokens}), 0)`.mapWith(
              Number,
            ),
          outputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.outputTokens}), 0)`.mapWith(
              Number,
            ),
        })
        .from(schema.tokenUsageRecords)
        .where(eq(schema.tokenUsageRecords.ownerId, ownerId))
        .groupBy(schema.tokenUsageRecords.modelId),
    ]);
    const settings = firstOrThrow(settingsRows, "loading user settings");
    const providerUsage = new Map(
      providerUsageRows.flatMap((row) =>
        row.id
          ? [[row.id, tokenUsageTotals(row.inputTokens, row.outputTokens)]]
          : [],
      ),
    );
    const modelUsage = new Map(
      modelUsageRows.flatMap((row) =>
        row.id
          ? [[row.id, tokenUsageTotals(row.inputTokens, row.outputTokens)]]
          : [],
      ),
    );
    return {
      preferences: {
        theme: settings.theme as ThemePreference,
        highContrast: settings.highContrast,
        proMode: settings.proMode,
        proModeOpacity: settings.proModeOpacity,
        sidebarWidth: settings.sidebarWidth,
        desktopFrameRate:
          settings.desktopFrameRate as UserSettings["desktopFrameRate"],
        desktopStreamQuality:
          settings.desktopStreamQuality as UserSettings["desktopStreamQuality"],
        defaultModelId: settings.defaultModelId,
        defaultPermissionProfileId:
          settings.defaultPermissionProfileId as UserSettings["defaultPermissionProfileId"],
        defaultWorkerId: settings.defaultWorkerId,
        automaticReplicaProvisioning: settings.automaticReplicaProvisioning,
        automaticReplicaSynchronization:
          settings.automaticReplicaSynchronization as UserSettings["automaticReplicaSynchronization"],
        mobileProjectTabConfigurations: settings.mobileProjectTabConfigurations,
      },
      providers: providerRows.map((provider) =>
        toProviderSummary(
          provider,
          providerUsage.get(provider.id),
          providerAccountRows
            .filter(({ account }) => account.providerId === provider.id)
            .map(({ account }) =>
              toProviderAccountSummary(
                account,
                providerAccountWorkerRows
                  .filter(({ binding }) => binding.accountId === account.id)
                  .map(({ binding }) => binding),
              ),
            ),
        ),
      ),
      models: modelRows.map((model) =>
        toModelSummary(
          model,
          routeRows
            .filter(({ route }) => route.modelId === model.id)
            .map(({ route, providerName }) =>
              toModelRouteSummary(route, providerName),
            ),
          modelUsage.get(model.id),
        ),
      ),
    };
  }

  async recordTokenUsage(
    ownerId: string,
    input: TokenUsageRecordInput,
  ): Promise<void> {
    const routeRows = await this.database
      .select({
        modelId: schema.modelProfiles.id,
        modelName: schema.modelProfiles.name,
        modelRouteId: schema.modelRoutes.id,
        providerId: schema.modelProviders.id,
        providerName: schema.modelProviders.name,
        providerModelName: schema.modelRoutes.modelName,
      })
      .from(schema.modelRoutes)
      .innerJoin(
        schema.modelProfiles,
        and(
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .where(eq(schema.modelRoutes.id, input.modelRouteId))
      .limit(1);
    const route = routeRows[0];
    const exactCount = (value: number | undefined): number =>
      Math.max(0, Math.round(value ?? 0));
    const usage = input.usage;
    const inputTokens = exactCount(usage?.inputTokens);
    const outputTokens = exactCount(usage?.outputTokens);
    const cachedInputTokens = exactCount(usage?.cachedInputTokens);
    const reasoningOutputTokens = exactCount(usage?.reasoningOutputTokens);
    const cacheWriteInputTokens = exactCount(usage?.cacheWriteInputTokens);
    const visibleOutputTokens =
      typeof usage?.visibleOutputTokens === "number"
        ? exactCount(usage.visibleOutputTokens)
        : null;
    const reportedTotalTokens = usage ? exactCount(usage.totalTokens) : null;
    const sanitizedRawUsage =
      usage?.sanitizedRawUsage ??
      (usage
        ? {
            inputTokens,
            outputTokens,
            totalTokens: reportedTotalTokens,
            cachedInputTokens,
            reasoningOutputTokens,
            cacheWriteInputTokens,
            visibleOutputTokens,
          }
        : {});
    const updatedAt = new Date();
    const attemptStatus = input.attemptStatus ?? "completed";
    const completedAt =
      input.completedAt ?? (attemptStatus === "running" ? null : updatedAt);
    const finalizedAt =
      input.finalizedAt ?? (attemptStatus === "running" ? null : updatedAt);
    await this.database
      .insert(schema.tokenUsageRecords)
      .values({
        id: randomUUID(),
        ownerId,
        projectId: input.projectId,
        chatId: input.chatId,
        sourceKey: input.sourceKey,
        modelId: route?.modelId ?? null,
        modelRouteId: route?.modelRouteId ?? null,
        providerId: route?.providerId ?? null,
        modelName: route?.modelName ?? input.modelName,
        providerName: route?.providerName ?? input.providerName,
        providerModelName: route?.providerModelName ?? input.providerModelName,
        providerAccountId: input.providerAccountId ?? null,
        workerId: input.workerId ?? null,
        turnId: input.turnId ?? null,
        executionAttemptId: input.executionAttemptId ?? null,
        attemptKind: input.attemptKind ?? "turn",
        attemptStatus,
        reasoningEffort: input.reasoningEffort ?? null,
        workerVersion: input.workerVersion ?? null,
        serverVersion: input.serverVersion ?? null,
        codexVersion: input.codexVersion ?? null,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningOutputTokens,
        cacheWriteInputTokens,
        visibleOutputTokens,
        reportedTotalTokens,
        usageSemantics: "provider-reported-v2",
        sanitizedRawUsage,
        startedAt: input.startedAt ?? updatedAt,
        completedAt,
        finalizedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.tokenUsageRecords.ownerId,
          schema.tokenUsageRecords.sourceKey,
        ],
        set: {
          projectId: input.projectId,
          chatId: input.chatId,
          modelId: route?.modelId ?? null,
          modelRouteId: route?.modelRouteId ?? null,
          providerId: route?.providerId ?? null,
          modelName: route?.modelName ?? input.modelName,
          providerName: route?.providerName ?? input.providerName,
          providerModelName:
            route?.providerModelName ?? input.providerModelName,
          providerAccountId: input.providerAccountId ?? null,
          workerId: input.workerId ?? null,
          turnId: input.turnId ?? null,
          executionAttemptId: input.executionAttemptId ?? null,
          attemptKind: input.attemptKind ?? "turn",
          attemptStatus,
          reasoningEffort: input.reasoningEffort ?? null,
          workerVersion: input.workerVersion ?? null,
          serverVersion: input.serverVersion ?? null,
          codexVersion: input.codexVersion ?? null,
          ...(usage
            ? {
                inputTokens,
                outputTokens,
                cachedInputTokens,
                reasoningOutputTokens,
                cacheWriteInputTokens,
                visibleOutputTokens,
                reportedTotalTokens,
                usageSemantics: "provider-reported-v2",
                sanitizedRawUsage,
              }
            : {}),
          ...(input.completedAt !== undefined
            ? { completedAt: input.completedAt }
            : {}),
          ...(input.finalizedAt !== undefined
            ? { finalizedAt: input.finalizedAt }
            : {}),
          updatedAt,
        },
      });
  }

  async recordModelBehaviorObservation(
    ownerId: string,
    input: ModelBehaviorObservationInput,
  ): Promise<void> {
    const routeRows = await this.database
      .select({
        modelId: schema.modelProfiles.id,
        modelName: schema.modelProfiles.name,
        modelRouteId: schema.modelRoutes.id,
        providerId: schema.modelProviders.id,
        providerName: schema.modelProviders.name,
        providerModelName: schema.modelRoutes.modelName,
      })
      .from(schema.modelRoutes)
      .innerJoin(
        schema.modelProfiles,
        and(
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .where(eq(schema.modelRoutes.id, input.modelRouteId))
      .limit(1);
    const route = routeRows[0];
    const count = (value: number | undefined): number =>
      Math.max(0, Math.round(value ?? 0));
    const nullableCount = (value: number | null | undefined): number | null =>
      typeof value === "number" ? count(value) : null;
    const contextUsedPercentBasisPoints =
      typeof input.contextUsedPercent === "number"
        ? Math.max(0, Math.round(input.contextUsedPercent * 100))
        : null;
    const updatedAt = new Date();
    const values = {
      projectId: input.projectId,
      chatId: input.chatId,
      modelId: route?.modelId ?? null,
      modelRouteId: route?.modelRouteId ?? null,
      providerId: route?.providerId ?? null,
      modelName: route?.modelName ?? input.modelName,
      providerName: route?.providerName ?? input.providerName,
      providerModelName: route?.providerModelName ?? input.providerModelName,
      providerAccountId: input.providerAccountId ?? null,
      workerId: input.workerId ?? null,
      turnId: input.turnId ?? null,
      executionAttemptId: input.executionAttemptId,
      attemptKind: input.attemptKind ?? "chat-turn",
      attemptStatus: input.attemptStatus,
      reasoningEffort: input.reasoningEffort ?? null,
      routeAttemptIndex: count(input.routeAttemptIndex),
      retryFailoverCount: count(input.retryFailoverCount),
      firstActivityAt: input.firstActivityAt ?? null,
      firstVisibleResponseAt: input.firstVisibleResponseAt ?? null,
      completedAt: input.completedAt ?? null,
      finalizedAt: input.finalizedAt ?? null,
      durationMs: nullableCount(input.durationMs),
      finalAnswerAppeared: input.finalAnswerAppeared ?? false,
      toolCallCount: count(input.toolCallCount),
      invalidToolCallCount: count(input.invalidToolCallCount),
      compactionCount: count(input.compactionCount),
      approvalRequestCount: count(input.approvalRequestCount),
      inputTokens: count(input.inputTokens),
      cachedInputTokens: count(input.cachedInputTokens),
      cacheWriteInputTokens: count(input.cacheWriteInputTokens),
      outputTokens: count(input.outputTokens),
      reasoningOutputTokens: count(input.reasoningOutputTokens),
      modelContextWindow: nullableCount(input.modelContextWindow),
      contextUsedPercentBasisPoints,
      filesChangedCount: count(input.filesChangedCount),
      testCommandCount: count(input.testCommandCount),
      testPassCount: count(input.testPassCount),
      testFailureCount: count(input.testFailureCount),
      userInterrupted: input.userInterrupted ?? false,
      userRetryRegeneration: input.userRetryRegeneration ?? null,
      immediateCorrectiveFollowup: input.immediateCorrectiveFollowup ?? false,
      workerVersion: input.workerVersion ?? null,
      serverVersion: input.serverVersion ?? null,
      codexVersion: input.codexVersion ?? null,
      signalAvailability: input.signalAvailability ?? {},
      updatedAt,
    };
    await this.database
      .insert(schema.modelBehaviorObservations)
      .values({
        id: randomUUID(),
        ownerId,
        sourceKey: input.sourceKey,
        startedAt: input.startedAt ?? updatedAt,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          schema.modelBehaviorObservations.ownerId,
          schema.modelBehaviorObservations.sourceKey,
        ],
        set: values,
      });
  }

  async getProjectTokenUsage(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectTokenUsage | null> {
    const projects = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!projects[0]) return null;

    const now = new Date();
    const rangeStart = new Date(now);
    rangeStart.setUTCHours(0, 0, 0, 0);
    rangeStart.setUTCDate(rangeStart.getUTCDate() - 364);
    const rangeEnd = new Date(now);
    rangeEnd.setUTCHours(0, 0, 0, 0);
    const filter = and(
      eq(schema.tokenUsageRecords.ownerId, ownerId),
      eq(schema.tokenUsageRecords.projectId, projectId),
    );
    const sumInput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.inputTokens}), 0)`.mapWith(
        Number,
      );
    const sumOutput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.outputTokens}), 0)`.mapWith(
        Number,
      );
    const sumCachedInput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.cachedInputTokens}), 0)`.mapWith(
        Number,
      );
    const sumCacheWriteInput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.cacheWriteInputTokens}), 0)`.mapWith(
        Number,
      );
    const sumReasoningOutput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.reasoningOutputTokens}), 0)`.mapWith(
        Number,
      );
    const tokenSums = {
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cachedInputTokens: sumCachedInput,
      cacheWriteInputTokens: sumCacheWriteInput,
      reasoningOutputTokens: sumReasoningOutput,
    };
    const day = sql<string>`to_char(${schema.tokenUsageRecords.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const [totalRows, dailyRows, providerRows, modelRows] = await Promise.all([
      this.database
        .select(tokenSums)
        .from(schema.tokenUsageRecords)
        .where(filter),
      this.database
        .select({
          date: day,
          ...tokenSums,
        })
        .from(schema.tokenUsageRecords)
        .where(and(filter, gte(schema.tokenUsageRecords.startedAt, rangeStart)))
        .groupBy(day)
        .orderBy(day),
      this.database
        .select({
          id: schema.tokenUsageRecords.providerId,
          name: schema.tokenUsageRecords.providerName,
          ...tokenSums,
        })
        .from(schema.tokenUsageRecords)
        .where(filter)
        .groupBy(
          schema.tokenUsageRecords.providerId,
          schema.tokenUsageRecords.providerName,
        ),
      this.database
        .select({
          id: schema.tokenUsageRecords.modelId,
          name: schema.tokenUsageRecords.modelName,
          ...tokenSums,
        })
        .from(schema.tokenUsageRecords)
        .where(filter)
        .groupBy(
          schema.tokenUsageRecords.modelId,
          schema.tokenUsageRecords.modelName,
        ),
    ]);
    const mergeBreakdowns = (
      rows: Array<{
        id: string | null;
        name: string;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        cacheWriteInputTokens: number;
        reasoningOutputTokens: number;
      }>,
    ) => {
      const merged = new Map<
        string,
        {
          id: string | null;
          name: string;
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number;
          cacheWriteInputTokens: number;
          reasoningOutputTokens: number;
        }
      >();
      for (const row of rows) {
        const key = row.id ?? `deleted:${row.name}`;
        const existing = merged.get(key);
        merged.set(key, {
          id: row.id,
          name: row.name,
          inputTokens: (existing?.inputTokens ?? 0) + row.inputTokens,
          outputTokens: (existing?.outputTokens ?? 0) + row.outputTokens,
          cachedInputTokens:
            (existing?.cachedInputTokens ?? 0) + row.cachedInputTokens,
          cacheWriteInputTokens:
            (existing?.cacheWriteInputTokens ?? 0) + row.cacheWriteInputTokens,
          reasoningOutputTokens:
            (existing?.reasoningOutputTokens ?? 0) + row.reasoningOutputTokens,
        });
      }
      return [...merged.values()]
        .map((row) => ({
          id: row.id,
          name: row.name,
          ...detailedTokenUsageTotals(
            row.inputTokens,
            row.outputTokens,
            row.cachedInputTokens,
            row.cacheWriteInputTokens,
            row.reasoningOutputTokens,
          ),
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens);
    };
    const totalRow = totalRows[0] ?? {
      ...ZERO_TOKEN_USAGE,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    };
    return {
      total: detailedTokenUsageTotals(
        totalRow.inputTokens,
        totalRow.outputTokens,
        totalRow.cachedInputTokens,
        totalRow.cacheWriteInputTokens,
        totalRow.reasoningOutputTokens,
      ),
      daily: dailyRows.map((row) => ({
        date: row.date,
        ...detailedTokenUsageTotals(
          row.inputTokens,
          row.outputTokens,
          row.cachedInputTokens,
          row.cacheWriteInputTokens,
          row.reasoningOutputTokens,
        ),
      })),
      providers: mergeBreakdowns(providerRows),
      models: mergeBreakdowns(modelRows),
      range: {
        start: rangeStart.toISOString().slice(0, 10),
        end: rangeEnd.toISOString().slice(0, 10),
      },
    };
  }

  async getUserSettings(ownerId: string): Promise<UserSettings> {
    const rows = await this.database
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, ownerId))
      .limit(1);
    const settings = firstOrThrow(rows, "loading user settings");
    return {
      theme: settings.theme as ThemePreference,
      highContrast: settings.highContrast,
      proMode: settings.proMode,
      proModeOpacity: settings.proModeOpacity,
      sidebarWidth: settings.sidebarWidth,
      desktopFrameRate:
        settings.desktopFrameRate as UserSettings["desktopFrameRate"],
      desktopStreamQuality:
        settings.desktopStreamQuality as UserSettings["desktopStreamQuality"],
      defaultModelId: settings.defaultModelId,
      defaultPermissionProfileId:
        settings.defaultPermissionProfileId as UserSettings["defaultPermissionProfileId"],
      defaultWorkerId: settings.defaultWorkerId,
      automaticReplicaProvisioning: settings.automaticReplicaProvisioning,
      automaticReplicaSynchronization:
        settings.automaticReplicaSynchronization as UserSettings["automaticReplicaSynchronization"],
      mobileProjectTabConfigurations: settings.mobileProjectTabConfigurations,
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
    if (
      input.defaultWorkerId &&
      !(await this.getWorker(ownerId, input.defaultWorkerId))
    ) {
      return null;
    }
    const { mobileProjectTabConfigurations, ...scalarSettings } = input;
    await this.database
      .update(schema.userSettings)
      .set({
        ...scalarSettings,
        ...(mobileProjectTabConfigurations
          ? {
              mobileProjectTabConfigurations: sql`${schema.userSettings.mobileProjectTabConfigurations} || ${JSON.stringify(mobileProjectTabConfigurations)}::jsonb`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.userSettings.userId, ownerId));
    return this.getSettings(ownerId);
  }

  async createModelProvider(
    ownerId: string,
    input: ModelProviderCreate,
  ): Promise<ModelProviderSummary> {
    const id = randomUUID();
    return this.database.transaction(async (transaction) => {
      if (isAccountProviderKind(input.kind)) {
        const existing = await transaction
          .select({ id: schema.modelProviders.id })
          .from(schema.modelProviders)
          .where(
            and(
              eq(schema.modelProviders.ownerId, ownerId),
              eq(schema.modelProviders.kind, input.kind),
            ),
          )
          .limit(1);
        if (existing[0]) {
          throw new Error(
            `A ${accountProviderLabel(input.kind)} provider already exists. Add another sign-in to that provider instead.`,
          );
        }
      }
      const result = await transaction
        .insert(schema.modelProviders)
        .values({
          id,
          ownerId,
          name: input.name,
          kind: input.kind,
          baseUrl: normalizeResponsesBaseUrl(input.baseUrl),
          weeklyUsageReservePercent: input.weeklyUsageReservePercent ?? 3,
          apiKey: null,
          apiKeyEnvelope: input.apiKey
            ? this.secretVault.encrypt(
                input.apiKey,
                modelProviderSecretContext(ownerId, id),
              )
            : null,
        })
        .returning();
      const provider = firstOrThrow(result, "creating a model provider");
      if (!isAccountProviderKind(input.kind))
        return toProviderSummary(provider);
      const accountRows = await transaction
        .insert(schema.modelProviderAccounts)
        .values({
          id: randomUUID(),
          providerId: id,
          label: defaultAccountLabel(input.kind),
          position: 0,
          credentialHomeKey: id,
        })
        .returning();
      return toProviderSummary(provider, ZERO_TOKEN_USAGE, [
        toProviderAccountSummary(
          firstOrThrow(
            accountRows,
            `creating a ${accountProviderLabel(input.kind)} account`,
          ),
        ),
      ]);
    });
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

  async listModelProviderAccounts(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderAccountSummary[] | null> {
    const provider = await this.database
      .select({
        id: schema.modelProviders.id,
        kind: schema.modelProviders.kind,
      })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!provider[0] || !isAccountProviderKind(provider[0].kind)) return null;
    const [accounts, bindings] = await Promise.all([
      this.database
        .select()
        .from(schema.modelProviderAccounts)
        .where(eq(schema.modelProviderAccounts.providerId, providerId))
        .orderBy(asc(schema.modelProviderAccounts.position)),
      this.database
        .select({ binding: schema.modelProviderAccountWorkers })
        .from(schema.modelProviderAccountWorkers)
        .innerJoin(
          schema.modelProviderAccounts,
          and(
            eq(
              schema.modelProviderAccounts.id,
              schema.modelProviderAccountWorkers.accountId,
            ),
            eq(schema.modelProviderAccounts.providerId, providerId),
          ),
        ),
    ]);
    return accounts.map((account) =>
      toProviderAccountSummary(
        account,
        bindings
          .filter(({ binding }) => binding.accountId === account.id)
          .map(({ binding }) => binding),
      ),
    );
  }

  async getModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialRecord | null> {
    const rows = await this.database
      .select({
        account: schema.modelProviderAccounts,
        kind: schema.modelProviders.kind,
        ownerId: schema.modelProviders.ownerId,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
      )
      .where(
        and(
          eq(schema.modelProviderAccounts.id, accountId),
          eq(schema.modelProviderAccounts.providerId, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
          inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.account.credentialEnvelope || !isAccountProviderKind(row.kind)) {
      return null;
    }
    const credential = parseProviderCredential(
      this.secretVault.decrypt(
        row.account.credentialEnvelope,
        modelProviderAccountSecretContext(
          row.ownerId,
          providerId,
          accountId,
          row.kind,
        ),
      ),
      row.kind,
    );
    const subject = providerCredentialSubject(credential);
    if (
      row.account.credentialSubject &&
      row.account.credentialSubject !== subject
    ) {
      throw new ProviderCredentialIdentityConflictError();
    }
    return {
      accountId,
      credential,
      metadata: redactProviderCredential(credential),
      providerId,
      revision: row.account.credentialRevision,
      state: row.account.credentialState as ProviderAccountCredentialState,
      updatedAt: row.account.credentialUpdatedAt
        ? toISOString(row.account.credentialUpdatedAt)
        : null,
    };
  }

  async listModelProviderAccountCredentialMigrations(
    ownerId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord[]> {
    const rows = await this.database
      .select({
        accountId: schema.modelProviderAccounts.id,
        credentialHomeKey: schema.modelProviderAccounts.credentialHomeKey,
        providerId: schema.modelProviderAccounts.providerId,
        providerKind: schema.modelProviders.kind,
        revision: schema.modelProviderAccounts.credentialRevision,
        state: schema.modelProviderAccounts.credentialState,
        subject: schema.modelProviderAccounts.credentialSubject,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
      )
      .where(
        and(
          eq(schema.modelProviders.ownerId, ownerId),
          inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          inArray(schema.modelProviderAccounts.credentialState, [
            "migration-needed",
            "signed-in",
          ]),
        ),
      )
      .orderBy(
        asc(schema.modelProviders.createdAt),
        asc(schema.modelProviderAccounts.position),
      );
    return rows.flatMap((row) =>
      isAccountProviderKind(row.providerKind) &&
      (row.state === "migration-needed" || row.state === "signed-in")
        ? [
            {
              ...row,
              providerKind: row.providerKind,
              state: row.state,
            },
          ]
        : [],
    );
  }

  async getModelProviderAccountCredentialMigration(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord | null> {
    const rows = await this.database
      .select({
        accountId: schema.modelProviderAccounts.id,
        credentialHomeKey: schema.modelProviderAccounts.credentialHomeKey,
        providerId: schema.modelProviderAccounts.providerId,
        providerKind: schema.modelProviders.kind,
        revision: schema.modelProviderAccounts.credentialRevision,
        state: schema.modelProviderAccounts.credentialState,
        subject: schema.modelProviderAccounts.credentialSubject,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
      )
      .where(
        and(
          eq(schema.modelProviders.ownerId, ownerId),
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviderAccounts.id, accountId),
          inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || !isAccountProviderKind(row.providerKind)) return null;
    return {
      ...row,
      providerKind: row.providerKind,
      state: row.state as ProviderAccountCredentialState,
    };
  }

  async storeModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: ProviderCredential,
    expectedRevision?: number,
    refreshLeaseId?: string,
  ): Promise<ProviderAccountCredentialRecord | null> {
    if (refreshLeaseId && expectedRevision === undefined) {
      throw new Error("A credential revision is required for refresh writes.");
    }
    const credential = parseProviderCredential(input, input.kind);
    const subject = providerCredentialSubject(credential);
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          account: schema.modelProviderAccounts,
          kind: schema.modelProviders.kind,
        })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
        )
        .where(
          and(
            eq(schema.modelProviderAccounts.id, accountId),
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(schema.modelProviders.ownerId, ownerId),
            inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row || !isAccountProviderKind(row.kind)) return null;
      if (row.kind !== credential.kind) {
        throw new ProviderCredentialIdentityConflictError();
      }
      if (
        row.account.credentialSubject &&
        row.account.credentialSubject !== subject
      ) {
        throw new ProviderCredentialIdentityConflictError();
      }
      if (
        expectedRevision !== undefined &&
        row.account.credentialRevision !== expectedRevision
      ) {
        throw new ProviderCredentialRevisionConflictError();
      }

      const revision = row.account.credentialRevision + 1;
      const updatedAt = new Date();
      const updated = await transaction
        .update(schema.modelProviderAccounts)
        .set({
          credentialEnvelope: this.secretVault.encrypt(
            serializeProviderCredential(credential),
            modelProviderAccountSecretContext(
              ownerId,
              providerId,
              accountId,
              row.kind,
            ),
          ),
          credentialRevision: revision,
          credentialState: "signed-in",
          credentialSubject: subject,
          credentialExpiresAt: credential.expiresAt
            ? new Date(credential.expiresAt)
            : null,
          credentialUpdatedAt: updatedAt,
          credentialLastRefreshError: null,
          ...(refreshLeaseId
            ? {
                credentialLastRefreshAt: updatedAt,
                credentialRefreshLeaseId: null,
                credentialRefreshLeaseExpiresAt: null,
              }
            : {}),
          email: credential.email,
          planType: credential.planType,
          authLastSyncedAt: updatedAt,
          updatedAt,
        })
        .where(
          and(
            eq(schema.modelProviderAccounts.id, accountId),
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(
              schema.modelProviderAccounts.credentialRevision,
              row.account.credentialRevision,
            ),
            ...(refreshLeaseId
              ? [
                  eq(
                    schema.modelProviderAccounts.credentialRefreshLeaseId,
                    refreshLeaseId,
                  ),
                ]
              : []),
          ),
        )
        .returning({
          revision: schema.modelProviderAccounts.credentialRevision,
        });
      if (!updated[0]) throw new ProviderCredentialRevisionConflictError();
      return {
        accountId,
        credential,
        metadata: redactProviderCredential(credential),
        providerId,
        revision,
        state: "signed-in",
        updatedAt: toISOString(updatedAt),
      };
    });
  }

  async tryAcquireModelProviderAccountRefreshLease(input: {
    accountId: string;
    expectedRevision: number;
    leaseExpiresAt: Date;
    leaseId: string;
    now: Date;
    ownerId: string;
    providerId: string;
  }): Promise<boolean> {
    const rows = await this.database
      .update(schema.modelProviderAccounts)
      .set({
        credentialRefreshLeaseId: input.leaseId,
        credentialRefreshLeaseExpiresAt: input.leaseExpiresAt,
      })
      .where(
        and(
          eq(schema.modelProviderAccounts.id, input.accountId),
          eq(schema.modelProviderAccounts.providerId, input.providerId),
          eq(
            schema.modelProviderAccounts.credentialRevision,
            input.expectedRevision,
          ),
          eq(schema.modelProviderAccounts.credentialState, "signed-in"),
          isNotNull(schema.modelProviderAccounts.credentialEnvelope),
          or(
            isNull(schema.modelProviderAccounts.credentialRefreshLeaseId),
            lte(
              schema.modelProviderAccounts.credentialRefreshLeaseExpiresAt,
              input.now,
            ),
          ),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, input.providerId),
                  eq(schema.modelProviders.ownerId, input.ownerId),
                  inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.modelProviderAccounts.id });
    return Boolean(rows[0]);
  }

  async releaseModelProviderAccountRefreshLease(input: {
    accountId: string;
    error: ProviderCredentialRefreshFailure;
    leaseId: string;
    ownerId: string;
    providerId: string;
    state?: Extract<
      ProviderAccountCredentialState,
      "signed-in" | "reauth-required" | "conflict"
    >;
  }): Promise<boolean> {
    const now = new Date();
    const rows = await this.database
      .update(schema.modelProviderAccounts)
      .set({
        credentialLastRefreshAt: now,
        credentialLastRefreshError: input.error,
        credentialRefreshLeaseId: null,
        credentialRefreshLeaseExpiresAt: null,
        ...(input.state ? { credentialState: input.state } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.modelProviderAccounts.id, input.accountId),
          eq(schema.modelProviderAccounts.providerId, input.providerId),
          eq(
            schema.modelProviderAccounts.credentialRefreshLeaseId,
            input.leaseId,
          ),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, input.providerId),
                  eq(schema.modelProviders.ownerId, input.ownerId),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.modelProviderAccounts.id });
    return Boolean(rows[0]);
  }

  async updateModelProviderAccountCredentialState(input: {
    accountId: string;
    expectedRevision: number;
    ownerId: string;
    providerId: string;
    state: Extract<
      ProviderAccountCredentialState,
      "reauth-required" | "conflict"
    >;
  }): Promise<boolean> {
    const rows = await this.database
      .update(schema.modelProviderAccounts)
      .set({ credentialState: input.state, updatedAt: new Date() })
      .where(
        and(
          eq(schema.modelProviderAccounts.id, input.accountId),
          eq(schema.modelProviderAccounts.providerId, input.providerId),
          eq(
            schema.modelProviderAccounts.credentialRevision,
            input.expectedRevision,
          ),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, input.providerId),
                  eq(schema.modelProviders.ownerId, input.ownerId),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.modelProviderAccounts.id });
    return Boolean(rows[0]);
  }

  async clearModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    return Boolean(
      await this.takeModelProviderAccountCredentialForSignOut(
        ownerId,
        providerId,
        accountId,
        expectedRevision,
      ),
    );
  }

  async takeModelProviderAccountCredentialForSignOut(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<ProviderAccountCredentialSignOutRecord | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          account: schema.modelProviderAccounts,
          kind: schema.modelProviders.kind,
          ownerId: schema.modelProviders.ownerId,
        })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
        )
        .where(
          and(
            eq(schema.modelProviderAccounts.id, accountId),
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(schema.modelProviders.ownerId, ownerId),
            inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          ),
        )
        .limit(1)
        .for("update");
      const row = rows[0];
      if (!row || !isAccountProviderKind(row.kind)) return null;
      if (
        expectedRevision !== undefined &&
        row.account.credentialRevision !== expectedRevision
      ) {
        throw new ProviderCredentialRevisionConflictError();
      }
      let credential: ProviderCredential | null = null;
      if (row.account.credentialEnvelope) {
        try {
          const parsed = parseProviderCredential(
            this.secretVault.decrypt(
              row.account.credentialEnvelope,
              modelProviderAccountSecretContext(
                row.ownerId,
                providerId,
                accountId,
                row.kind,
              ),
            ),
            row.kind,
          );
          if (
            !row.account.credentialSubject ||
            row.account.credentialSubject === providerCredentialSubject(parsed)
          ) {
            credential = parsed;
          }
        } catch {
          // Sign-out still clears an unreadable envelope; it just cannot revoke it.
        }
      }
      const now = new Date();
      const updated = await transaction
        .update(schema.modelProviderAccounts)
        .set({
          credentialEnvelope: null,
          credentialRevision: row.account.credentialRevision + 1,
          credentialState: "signed-out",
          credentialSubject: null,
          credentialExpiresAt: null,
          credentialUpdatedAt: now,
          credentialRefreshLeaseId: null,
          credentialRefreshLeaseExpiresAt: null,
          credentialLastRefreshError: null,
          email: null,
          planType: null,
          weeklyUsageUsedBasisPoints: null,
          weeklyUsageResetsAt: null,
          authLastSyncedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.modelProviderAccounts.id, accountId),
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(
              schema.modelProviderAccounts.credentialRevision,
              row.account.credentialRevision,
            ),
          ),
        )
        .returning({ id: schema.modelProviderAccounts.id });
      if (!updated[0]) throw new ProviderCredentialRevisionConflictError();
      await transaction
        .update(schema.modelProviderAccountWorkers)
        .set({
          authState: "signed-out",
          weeklyUsageUsedBasisPoints: null,
          weeklyUsageResetsAt: null,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.modelProviderAccountWorkers.accountId, accountId));
      return { credential, revision: row.account.credentialRevision + 1 };
    });
  }

  async createModelProviderAccount(
    ownerId: string,
    providerId: string,
    input: ModelProviderAccountCreate,
  ): Promise<ModelProviderAccountSummary | null> {
    return this.database.transaction(async (transaction) => {
      const provider = await transaction
        .select({ kind: schema.modelProviders.kind })
        .from(schema.modelProviders)
        .where(
          and(
            eq(schema.modelProviders.id, providerId),
            eq(schema.modelProviders.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!provider[0] || !isAccountProviderKind(provider[0].kind)) return null;
      const positions = await transaction
        .select({ position: schema.modelProviderAccounts.position })
        .from(schema.modelProviderAccounts)
        .where(eq(schema.modelProviderAccounts.providerId, providerId))
        .orderBy(desc(schema.modelProviderAccounts.position))
        .limit(1);
      const accountId = randomUUID();
      const rows = await transaction
        .insert(schema.modelProviderAccounts)
        .values({
          id: accountId,
          providerId,
          label: input.label,
          position: (positions[0]?.position ?? -1) + 1,
          credentialHomeKey: accountId,
        })
        .returning();
      return toProviderAccountSummary(
        firstOrThrow(
          rows,
          `creating a ${accountProviderLabel(provider[0].kind)} account`,
        ),
      );
    });
  }

  async updateModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: ModelProviderAccountUpdate,
  ): Promise<ModelProviderAccountSummary | null> {
    const rows = await this.database
      .update(schema.modelProviderAccounts)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(schema.modelProviderAccounts.id, accountId),
          eq(schema.modelProviderAccounts.providerId, providerId),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, providerId),
                  eq(schema.modelProviders.ownerId, ownerId),
                  inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
                ),
              ),
          ),
        ),
      )
      .returning();
    return rows[0] ? toProviderAccountSummary(rows[0]) : null;
  }

  async reorderModelProviderAccounts(
    ownerId: string,
    providerId: string,
    input: OrderedIds,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const accounts = await transaction
        .select({
          id: schema.modelProviderAccounts.id,
          position: schema.modelProviderAccounts.position,
        })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
        )
        .where(
          and(
            eq(schema.modelProviderAccounts.providerId, providerId),
            eq(schema.modelProviders.ownerId, ownerId),
            inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          ),
        );
      if (
        accounts.length !== input.ids.length ||
        accounts.some(({ id }) => !input.ids.includes(id))
      ) {
        return false;
      }
      const updatedAt = new Date();
      const temporaryOffset =
        Math.max(
          accounts.length - 1,
          ...accounts.map(({ position }) => position),
        ) + 1;
      // Vacate the unique provider/position range before assigning the final
      // order so swaps never collide midway through the transaction.
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.modelProviderAccounts)
          .set({ position: temporaryOffset + position, updatedAt })
          .where(
            and(
              eq(schema.modelProviderAccounts.id, id),
              eq(schema.modelProviderAccounts.providerId, providerId),
            ),
          );
      }
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.modelProviderAccounts)
          .set({ position, updatedAt })
          .where(
            and(
              eq(schema.modelProviderAccounts.id, id),
              eq(schema.modelProviderAccounts.providerId, providerId),
            ),
          );
      }
      return true;
    });
  }

  async deleteModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .delete(schema.modelProviderAccounts)
      .where(
        and(
          eq(schema.modelProviderAccounts.id, accountId),
          eq(schema.modelProviderAccounts.providerId, providerId),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, providerId),
                  eq(schema.modelProviders.ownerId, ownerId),
                  inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.modelProviderAccounts.id });
    return Boolean(rows[0]);
  }

  async getModelProviderAccountRuntime(
    ownerId: string,
    providerId: string,
    accountId?: string,
  ): Promise<{
    accountId: string;
    credentialHomeKey: string;
  } | null> {
    const filters = [
      eq(schema.modelProviderAccounts.providerId, providerId),
      eq(schema.modelProviders.ownerId, ownerId),
      inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
      ...(accountId
        ? [eq(schema.modelProviderAccounts.id, accountId)]
        : [eq(schema.modelProviderAccounts.enabled, true)]),
    ];
    const rows = await this.database
      .select({
        accountId: schema.modelProviderAccounts.id,
        credentialHomeKey: schema.modelProviderAccounts.credentialHomeKey,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        eq(schema.modelProviders.id, schema.modelProviderAccounts.providerId),
      )
      .where(and(...filters))
      .orderBy(asc(schema.modelProviderAccounts.position))
      .limit(1);
    return rows[0] ?? null;
  }

  async recordModelProviderAccountStatus(
    accountId: string,
    workerId: string,
    status: {
      authenticated: boolean;
      email: string | null;
      planType: string | null;
      weeklyUsage: { usedPercent: number; resetsAt: number | null } | null;
    },
  ): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(schema.modelProviderAccounts)
        .set({
          ...(status.authenticated
            ? { email: status.email, planType: status.planType }
            : {}),
          ...(status.weeklyUsage
            ? {
                weeklyUsageUsedBasisPoints: Math.round(
                  status.weeklyUsage.usedPercent * 100,
                ),
                weeklyUsageResetsAt: status.weeklyUsage.resetsAt
                  ? new Date(status.weeklyUsage.resetsAt * 1_000)
                  : null,
                weeklyUsageObservedAt: now,
              }
            : {}),
          authLastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.modelProviderAccounts.id, accountId));
      await transaction
        .insert(schema.modelProviderAccountWorkers)
        .values({
          accountId,
          workerId,
          authState: status.authenticated ? "signed-in" : "signed-out",
          weeklyUsageUsedBasisPoints: status.weeklyUsage
            ? Math.round(status.weeklyUsage.usedPercent * 100)
            : null,
          weeklyUsageResetsAt: status.weeklyUsage?.resetsAt
            ? new Date(status.weeklyUsage.resetsAt * 1_000)
            : null,
          weeklyUsageObservedAt: status.weeklyUsage ? now : null,
          lastSyncedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.modelProviderAccountWorkers.accountId,
            schema.modelProviderAccountWorkers.workerId,
          ],
          set: {
            authState: status.authenticated ? "signed-in" : "signed-out",
            weeklyUsageUsedBasisPoints: status.weeklyUsage
              ? Math.round(status.weeklyUsage.usedPercent * 100)
              : null,
            weeklyUsageResetsAt: status.weeklyUsage?.resetsAt
              ? new Date(status.weeklyUsage.resetsAt * 1_000)
              : null,
            ...(status.weeklyUsage ? { weeklyUsageObservedAt: now } : {}),
            lastSyncedAt: now,
            lastError: null,
            updatedAt: now,
          },
        });
    });
  }

  async recordModelProviderAccountUsage(input: {
    accountId: string;
    ownerId: string;
    planType: string | null;
    providerId: string;
    resetsAt: number | null;
    usedPercent: number;
  }): Promise<boolean> {
    if (!Number.isFinite(input.usedPercent)) return false;
    const now = new Date();
    const rows = await this.database
      .update(schema.modelProviderAccounts)
      .set({
        ...(input.planType ? { planType: input.planType } : {}),
        weeklyUsageUsedBasisPoints: Math.round(
          Math.min(100, Math.max(0, input.usedPercent)) * 100,
        ),
        weeklyUsageResetsAt: input.resetsAt
          ? new Date(input.resetsAt * 1_000)
          : null,
        weeklyUsageObservedAt: now,
        authLastSyncedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.modelProviderAccounts.id, input.accountId),
          eq(schema.modelProviderAccounts.providerId, input.providerId),
          exists(
            this.database
              .select({ id: schema.modelProviders.id })
              .from(schema.modelProviders)
              .where(
                and(
                  eq(schema.modelProviders.id, input.providerId),
                  eq(schema.modelProviders.ownerId, input.ownerId),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.modelProviderAccounts.id });
    return Boolean(rows[0]);
  }

  /**
   * Appends one immutable quota-window reading and, when requested, advances
   * the account's cached weekly projection. Re-delivery of the same event is
   * idempotent, while independent identical observations remain distinct.
   */
  async recordProviderQuotaObservation(
    ownerId: string,
    input: ProviderQuotaObservationInput,
  ): Promise<boolean> {
    if (
      !Number.isFinite(input.usedPercent) ||
      input.usedPercent < 0 ||
      input.usedPercent > 100 ||
      Number.isNaN(input.observedAt.getTime()) ||
      (input.windowDurationMinutes !== null &&
        (!Number.isInteger(input.windowDurationMinutes) ||
          input.windowDurationMinutes < 0))
    ) {
      return false;
    }
    const accountRows = await this.database
      .select({
        accountLabel: schema.modelProviderAccounts.label,
        providerKind: schema.modelProviders.kind,
        providerName: schema.modelProviders.name,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, input.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.modelProviderAccounts.id, input.providerAccountId),
          eq(schema.modelProviderAccounts.providerId, input.providerId),
        ),
      )
      .limit(1);
    const account = accountRows[0];
    if (!account) return false;

    let workerName: string | null = null;
    if (input.workerId) {
      const workerRows = await this.database
        .select({ name: schema.workers.name })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!workerRows[0]) return false;
      workerName = workerRows[0].name;
    }

    return this.database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(schema.providerQuotaObservations)
        .values({
          id: randomUUID(),
          ownerId,
          eventKey: input.eventKey,
          observationBatchKey: input.observationBatchKey,
          providerId: input.providerId,
          providerName: account.providerName,
          providerKind: account.providerKind,
          providerAccountId: input.providerAccountId,
          providerAccountLabel: account.accountLabel,
          workerId: input.workerId,
          workerName,
          observedAt: input.observedAt,
          usedPercentMicros: Math.round(input.usedPercent * 1_000_000),
          resetsAt: input.resetsAt,
          windowDurationMinutes: input.windowDurationMinutes,
          limitId: input.limitId,
          limitName: input.limitName,
          windowKind: input.windowKind,
          planType: input.planType,
          reachedType: input.reachedType,
          observationTrigger: input.observationTrigger,
          isWeeklyProjection: input.isWeeklyProjection,
          chatId: input.chatId,
          turnId: input.turnId,
          executionAttemptId: input.executionAttemptId,
          workerVersion: input.workerVersion,
          serverVersion: input.serverVersion,
          codexVersion: input.codexVersion,
          sanitizedRawPayload: input.sanitizedRawPayload,
        })
        .onConflictDoNothing({
          target: [
            schema.providerQuotaObservations.ownerId,
            schema.providerQuotaObservations.eventKey,
          ],
        })
        .returning({ id: schema.providerQuotaObservations.id });
      if (!inserted[0]) return false;
      if (!input.isWeeklyProjection) return true;

      const projection = {
        ...(input.planType ? { planType: input.planType } : {}),
        weeklyUsageUsedBasisPoints: Math.round(input.usedPercent * 100),
        weeklyUsageResetsAt: input.resetsAt,
        weeklyUsageObservedAt: input.observedAt,
        updatedAt: new Date(),
      };
      await transaction
        .update(schema.modelProviderAccounts)
        .set(projection)
        .where(
          and(
            eq(schema.modelProviderAccounts.id, input.providerAccountId),
            or(
              isNull(schema.modelProviderAccounts.weeklyUsageObservedAt),
              lte(
                schema.modelProviderAccounts.weeklyUsageObservedAt,
                input.observedAt,
              ),
            ),
          ),
        );
      if (input.workerId) {
        await transaction
          .update(schema.modelProviderAccountWorkers)
          .set({
            weeklyUsageUsedBasisPoints: projection.weeklyUsageUsedBasisPoints,
            weeklyUsageResetsAt: projection.weeklyUsageResetsAt,
            weeklyUsageObservedAt: projection.weeklyUsageObservedAt,
            updatedAt: projection.updatedAt,
          })
          .where(
            and(
              eq(
                schema.modelProviderAccountWorkers.accountId,
                input.providerAccountId,
              ),
              eq(schema.modelProviderAccountWorkers.workerId, input.workerId),
              or(
                isNull(
                  schema.modelProviderAccountWorkers.weeklyUsageObservedAt,
                ),
                lte(
                  schema.modelProviderAccountWorkers.weeklyUsageObservedAt,
                  input.observedAt,
                ),
              ),
            ),
          );
      }
      return true;
    });
  }

  async getQuotaTokenAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<QuotaTokenAnalytics> {
    const quotaFilters = [
      eq(schema.providerQuotaObservations.ownerId, ownerId),
      ...(query.providerId
        ? [eq(schema.providerQuotaObservations.providerId, query.providerId)]
        : []),
      ...(query.providerAccountId
        ? [
            eq(
              schema.providerQuotaObservations.providerAccountId,
              query.providerAccountId,
            ),
          ]
        : []),
      ...(query.to
        ? [lte(schema.providerQuotaObservations.observedAt, query.to)]
        : []),
    ];
    const tokenFilters = [
      eq(schema.tokenUsageRecords.ownerId, ownerId),
      ...(query.providerId
        ? [eq(schema.tokenUsageRecords.providerId, query.providerId)]
        : []),
      ...(query.providerAccountId
        ? [
            eq(
              schema.tokenUsageRecords.providerAccountId,
              query.providerAccountId,
            ),
          ]
        : []),
      ...(query.modelId
        ? [eq(schema.tokenUsageRecords.modelId, query.modelId)]
        : []),
      ...(query.reasoningEffort
        ? [eq(schema.tokenUsageRecords.reasoningEffort, query.reasoningEffort)]
        : []),
      ...(query.projectId
        ? [eq(schema.tokenUsageRecords.projectId, query.projectId)]
        : []),
      ...(query.from
        ? [gte(schema.tokenUsageRecords.startedAt, query.from)]
        : []),
      ...(query.to ? [lte(schema.tokenUsageRecords.startedAt, query.to)] : []),
    ];
    const [quotaRows, tokenRows] = await Promise.all([
      this.database
        .select()
        .from(schema.providerQuotaObservations)
        .where(and(...quotaFilters))
        .orderBy(asc(schema.providerQuotaObservations.observedAt)),
      this.database
        .select()
        .from(schema.tokenUsageRecords)
        .where(and(...tokenFilters))
        .orderBy(asc(schema.tokenUsageRecords.startedAt)),
    ]);
    const readings = quotaRows.map((row) => ({
      id: row.id,
      providerId: row.providerId,
      providerAccountId: row.providerAccountId,
      limitId: row.limitId,
      limitName: row.limitName,
      windowKind: row.windowKind,
      windowDurationMinutes: row.windowDurationMinutes,
      resetsAt: row.resetsAt,
      observedAt: row.observedAt,
      receivedAt: row.receivedAt,
      usedPercent: row.usedPercentMicros / 1_000_000,
    }));
    const rangedReadings = query.from
      ? [
          ...new Map(
            readings
              .filter((reading) => reading.observedAt >= query.from!)
              .flatMap((reading) => {
                const prior = readings
                  .filter(
                    (candidate) =>
                      candidate.providerAccountId ===
                        reading.providerAccountId &&
                      candidate.limitId === reading.limitId &&
                      candidate.windowKind === reading.windowKind &&
                      candidate.resetsAt?.getTime() ===
                        reading.resetsAt?.getTime() &&
                      candidate.observedAt < query.from!,
                  )
                  .at(-1);
                return [prior, reading].filter(
                  (candidate): candidate is (typeof readings)[number] =>
                    Boolean(candidate),
                );
              })
              .map((reading) => [reading.id, reading]),
          ).values(),
        ]
      : readings;
    return deriveQuotaTokenAnalytics(
      rangedReadings,
      tokenRows.map((row) => ({
        id: row.id,
        providerId: row.providerId,
        providerAccountId: row.providerAccountId,
        modelId: row.modelId,
        modelName: row.modelName,
        reasoningEffort: row.reasoningEffort,
        projectId: row.projectId,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        finalizedAt: row.finalizedAt,
        attemptStatus: row.attemptStatus,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens,
        outputTokens: row.outputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        visibleOutputTokens: row.visibleOutputTokens,
        reportedTotalTokens: row.reportedTotalTokens,
      })),
      query.to ?? new Date(),
    );
  }

  async getProviderTelemetryAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<ProviderTelemetryAnalytics> {
    const from = query.from ?? new Date(Date.now() - 364 * 86_400_000);
    const to = query.to ?? new Date();
    const scopedQuery = { ...query, from, to };
    const tokenFilters = [
      eq(schema.tokenUsageRecords.ownerId, ownerId),
      ...(query.providerId
        ? [eq(schema.tokenUsageRecords.providerId, query.providerId)]
        : []),
      ...(query.providerAccountId
        ? [
            eq(
              schema.tokenUsageRecords.providerAccountId,
              query.providerAccountId,
            ),
          ]
        : []),
      ...(query.modelId
        ? [eq(schema.tokenUsageRecords.modelId, query.modelId)]
        : []),
      ...(query.reasoningEffort
        ? [eq(schema.tokenUsageRecords.reasoningEffort, query.reasoningEffort)]
        : []),
      ...(query.projectId
        ? [eq(schema.tokenUsageRecords.projectId, query.projectId)]
        : []),
      gte(schema.tokenUsageRecords.startedAt, from),
      lte(schema.tokenUsageRecords.startedAt, to),
    ];
    const behaviorFilters = [
      eq(schema.modelBehaviorObservations.ownerId, ownerId),
      ...(query.providerId
        ? [eq(schema.modelBehaviorObservations.providerId, query.providerId)]
        : []),
      ...(query.providerAccountId
        ? [
            eq(
              schema.modelBehaviorObservations.providerAccountId,
              query.providerAccountId,
            ),
          ]
        : []),
      ...(query.modelId
        ? [eq(schema.modelBehaviorObservations.modelId, query.modelId)]
        : []),
      ...(query.reasoningEffort
        ? [
            eq(
              schema.modelBehaviorObservations.reasoningEffort,
              query.reasoningEffort,
            ),
          ]
        : []),
      ...(query.projectId
        ? [eq(schema.modelBehaviorObservations.projectId, query.projectId)]
        : []),
      gte(schema.modelBehaviorObservations.startedAt, from),
      lte(schema.modelBehaviorObservations.startedAt, to),
    ];
    const [quota, tokenRows, behaviorRows, currentAccounts, quotaLabels] =
      await Promise.all([
        this.getQuotaTokenAnalytics(ownerId, scopedQuery),
        this.database
          .select()
          .from(schema.tokenUsageRecords)
          .where(and(...tokenFilters))
          .orderBy(asc(schema.tokenUsageRecords.startedAt)),
        this.database
          .select()
          .from(schema.modelBehaviorObservations)
          .where(and(...behaviorFilters))
          .orderBy(asc(schema.modelBehaviorObservations.startedAt)),
        this.database
          .select({
            id: schema.modelProviderAccounts.id,
            providerId: schema.modelProviderAccounts.providerId,
            providerName: schema.modelProviders.name,
            label: schema.modelProviderAccounts.label,
          })
          .from(schema.modelProviderAccounts)
          .innerJoin(
            schema.modelProviders,
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
          )
          .where(
            and(
              eq(schema.modelProviders.ownerId, ownerId),
              ...(query.providerId
                ? [eq(schema.modelProviders.id, query.providerId)]
                : []),
            ),
          ),
        this.database
          .select({
            providerId: schema.providerQuotaObservations.providerId,
            providerName: schema.providerQuotaObservations.providerName,
            accountId: schema.providerQuotaObservations.providerAccountId,
            accountLabel: schema.providerQuotaObservations.providerAccountLabel,
          })
          .from(schema.providerQuotaObservations)
          .where(
            and(
              eq(schema.providerQuotaObservations.ownerId, ownerId),
              ...(query.providerId
                ? [
                    eq(
                      schema.providerQuotaObservations.providerId,
                      query.providerId,
                    ),
                  ]
                : []),
            ),
          ),
      ]);

    const accountById = new Map(
      currentAccounts.map((account) => [account.id, account] as const),
    );
    for (const historical of quotaLabels) {
      if (accountById.has(historical.accountId)) continue;
      accountById.set(historical.accountId, {
        id: historical.accountId,
        providerId: historical.providerId,
        providerName: historical.providerName,
        label: historical.accountLabel,
      });
    }
    const modelLabelById = new Map<string, string>();
    for (const row of [...tokenRows, ...behaviorRows]) {
      if (row.modelId) modelLabelById.set(row.modelId, row.modelName);
    }

    const quotaHistory = quota.readings.map((reading) => {
      const account = accountById.get(reading.providerAccountId);
      return {
        id: reading.id,
        providerId: reading.providerId,
        providerName: account?.providerName ?? reading.providerId,
        providerAccountId: reading.providerAccountId,
        providerAccountLabel: account?.label ?? reading.providerAccountId,
        limitName: reading.limitName ?? reading.windowKind,
        windowKind: reading.windowKind,
        usedPercent: reading.usedPercent,
        remainingPercent: Math.max(0, 100 - reading.usedPercent),
        resetsAt: reading.resetsAt?.toISOString() ?? null,
        observedAt: reading.observedAt.toISOString(),
      };
    });
    const currentQuotaByBucket = new Map<
      string,
      (typeof quotaHistory)[number]
    >();
    for (const reading of quotaHistory) {
      currentQuotaByBucket.set(
        [
          reading.providerId,
          reading.providerAccountId,
          reading.limitName,
          reading.windowKind,
        ].join(":"),
        reading,
      );
    }

    const dailyTokens = new Map<string, typeof tokenRows>();
    for (const row of tokenRows) {
      const date = row.startedAt.toISOString().slice(0, 10);
      dailyTokens.set(date, [...(dailyTokens.get(date) ?? []), row]);
    }
    const detailedBreakdown = (
      entries: typeof quota.breakdowns.model,
      labels: ReadonlyMap<string, string> = new Map(),
    ) =>
      entries.map((entry) => ({
        key: entry.key,
        label: labels.get(entry.key) ?? entry.key,
        sampleCount: entry.sampleCount,
        highConfidenceSamples: entry.highConfidenceSamples,
        unattributedSamples: entry.unattributedSamples,
        tokens: detailedTokenUsageTotals(
          entry.totals.inputTokens,
          entry.totals.outputTokens,
          entry.totals.cachedInputTokens,
          entry.totals.cacheWriteInputTokens,
          entry.totals.reasoningOutputTokens,
        ),
        effectiveTokensPer100Percent: entry.effectiveTokensPer100Percent,
      }));

    const behaviorBreakdown = <Row extends (typeof behaviorRows)[number]>(
      rows: Row[],
      keyFor: (row: Row) => string,
      labelFor: (key: string) => string,
    ) =>
      [...groupModelBehavior(rows, keyFor).entries()]
        .map(([key, summary]) => ({ key, label: labelFor(key), ...summary }))
        .sort((left, right) => right.attemptCount - left.attemptCount);
    const dailyBehavior = behaviorBreakdown(
      behaviorRows,
      (row) => row.startedAt.toISOString().slice(0, 10),
      (key) => key,
    ).map(({ key: _key, label: date, ...summary }) => ({ date, ...summary }));
    const accountLabels = new Map(
      [...accountById.values()].map((account) => [account.id, account.label]),
    );
    const accountBreakdownLabels = new Map(
      [...accountById.values()].map((account) => [account.id, account.label]),
    );
    const changePoints = detectTelemetryChanges(
      quota.movementSamples,
      behaviorRows,
    ).map((change) => ({
      ...change,
      providerAccountLabel: change.providerAccountId
        ? (accountLabels.get(change.providerAccountId) ??
          change.providerAccountId)
        : null,
      modelLabel: change.modelId
        ? (modelLabelById.get(change.modelId) ?? change.modelId)
        : null,
    }));
    const estimates = quota.movementSamples;
    const attributableEstimates = estimates.filter(
      ({ unattributed }) => !unattributed,
    );
    const resetBoundaries = new Map<
      string,
      { providerAccountId: string; resetsAt: string; firstObservedAt: string }
    >();
    for (const reading of quotaHistory) {
      if (!reading.resetsAt) continue;
      const key = `${reading.providerAccountId}:${reading.resetsAt}`;
      const current = resetBoundaries.get(key);
      if (!current || reading.observedAt < current.firstObservedAt) {
        resetBoundaries.set(key, {
          providerAccountId: reading.providerAccountId,
          resetsAt: reading.resetsAt,
          firstObservedAt: reading.observedAt,
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      range: { from: from.toISOString(), to: to.toISOString() },
      accounts: [...accountById.values()].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
      currentQuota: [...currentQuotaByBucket.values()].sort((left, right) =>
        right.observedAt.localeCompare(left.observedAt),
      ),
      quotaHistory: sampleProviderTelemetryQuotaHistory(quotaHistory),
      resetBoundaries: [...resetBoundaries.values()].sort((left, right) =>
        left.resetsAt.localeCompare(right.resetsAt),
      ),
      tokens: {
        total: sumDetailedTokenUsage(tokenRows),
        daily: [...dailyTokens.entries()]
          .map(([date, rows]) => ({ date, ...sumDetailedTokenUsage(rows) }))
          .sort((left, right) => left.date.localeCompare(right.date)),
      },
      estimates: {
        sampleCount: estimates.length,
        highConfidenceSamples: estimates.filter(
          ({ confidence }) => confidence === "high",
        ).length,
        unattributedSamples: estimates.filter(
          ({ unattributed }) => unattributed,
        ).length,
        tokensPerPercent: quotaValueStatistics(
          attributableEstimates.map(
            ({ tokensPerPercent }) => tokensPerPercent.comparableTokens,
          ),
        ),
        effectiveTokensPer100Percent: quotaValueStatistics(
          attributableEstimates.map(
            ({ effectiveTokensPer100Percent }) => effectiveTokensPer100Percent,
          ),
        ),
      },
      comparisons: {
        rolling7Days: quota.rolling7Days,
        rolling30Days: quota.rolling30Days,
        monthOverMonth: quota.monthOverMonth,
      },
      breakdowns: {
        accounts: detailedBreakdown(
          quota.breakdowns.account,
          accountBreakdownLabels,
        ),
        models: detailedBreakdown(quota.breakdowns.model, modelLabelById),
        reasoningEfforts: detailedBreakdown(quota.breakdowns.reasoningEffort),
        months: detailedBreakdown(quota.breakdowns.month),
      },
      behavior: {
        total: summarizeModelBehavior(behaviorRows),
        daily: dailyBehavior,
        accounts: behaviorBreakdown(
          behaviorRows,
          (row) => row.providerAccountId ?? "unattributed",
          (key) => accountLabels.get(key) ?? key,
        ),
        models: behaviorBreakdown(
          behaviorRows,
          (row) => row.modelId ?? `deleted:${row.modelName}`,
          (key) => modelLabelById.get(key) ?? key.replace(/^deleted:/u, ""),
        ),
        reasoningEfforts: behaviorBreakdown(
          behaviorRows,
          (row) => row.reasoningEffort ?? "provider-default",
          (key) => key,
        ),
      },
      changePoints,
    };
  }

  async exportProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryExport | null> {
    const providerRows = await this.database
      .select({
        id: schema.modelProviders.id,
        name: schema.modelProviders.name,
      })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.ownerId, ownerId),
          eq(schema.modelProviders.id, providerId),
        ),
      )
      .limit(1);
    const provider = providerRows[0];
    if (!provider) return null;

    const [quotaRows, tokenRows, behaviorRows, catalogRows] = await Promise.all(
      [
        this.database
          .select()
          .from(schema.providerQuotaObservations)
          .where(
            and(
              eq(schema.providerQuotaObservations.ownerId, ownerId),
              eq(schema.providerQuotaObservations.providerId, providerId),
            ),
          )
          .orderBy(asc(schema.providerQuotaObservations.observedAt)),
        this.database
          .select()
          .from(schema.tokenUsageRecords)
          .where(
            and(
              eq(schema.tokenUsageRecords.ownerId, ownerId),
              eq(schema.tokenUsageRecords.providerId, providerId),
            ),
          )
          .orderBy(asc(schema.tokenUsageRecords.startedAt)),
        this.database
          .select()
          .from(schema.modelBehaviorObservations)
          .where(
            and(
              eq(schema.modelBehaviorObservations.ownerId, ownerId),
              eq(schema.modelBehaviorObservations.providerId, providerId),
            ),
          )
          .orderBy(asc(schema.modelBehaviorObservations.startedAt)),
        this.database
          .select()
          .from(schema.providerModelCatalogSnapshots)
          .where(
            and(
              eq(schema.providerModelCatalogSnapshots.ownerId, ownerId),
              eq(schema.providerModelCatalogSnapshots.providerId, providerId),
            ),
          )
          .orderBy(asc(schema.providerModelCatalogSnapshots.observedAt)),
      ],
    );

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      provider,
      privacy: {
        includesMessageContent: false,
        rawPayloadsSanitized: true,
        retention: "owner-controlled-indefinite",
      },
      quotaObservations: quotaRows.map((row) => ({
        id: row.id,
        eventKey: row.eventKey,
        observationBatchKey: row.observationBatchKey,
        providerAccountId: row.providerAccountId,
        providerAccountLabel: row.providerAccountLabel,
        workerId: row.workerId,
        observedAt: row.observedAt.toISOString(),
        receivedAt: row.receivedAt.toISOString(),
        usedPercent: row.usedPercentMicros / 1_000_000,
        resetsAt: row.resetsAt?.toISOString() ?? null,
        windowDurationMinutes: row.windowDurationMinutes,
        limitId: row.limitId,
        limitName: row.limitName,
        windowKind: row.windowKind,
        planType: row.planType,
        reachedType: row.reachedType,
        observationTrigger: row.observationTrigger,
        chatId: row.chatId,
        turnId: row.turnId,
        executionAttemptId: row.executionAttemptId,
        workerVersion: row.workerVersion,
        serverVersion: row.serverVersion,
        codexVersion: row.codexVersion,
        sanitizedRawPayload: row.sanitizedRawPayload,
      })),
      tokenUsage: tokenRows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        chatId: row.chatId,
        sourceKey: row.sourceKey,
        modelId: row.modelId,
        modelRouteId: row.modelRouteId,
        modelName: row.modelName,
        providerModelName: row.providerModelName,
        providerAccountId: row.providerAccountId,
        workerId: row.workerId,
        turnId: row.turnId,
        executionAttemptId: row.executionAttemptId,
        attemptKind: row.attemptKind,
        attemptStatus: row.attemptStatus,
        reasoningEffort: row.reasoningEffort,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens,
        outputTokens: row.outputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        visibleOutputTokens: row.visibleOutputTokens,
        reportedTotalTokens: row.reportedTotalTokens,
        usageSemantics: row.usageSemantics,
        sanitizedRawUsage: row.sanitizedRawUsage,
        startedAt: row.startedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        finalizedAt: row.finalizedAt?.toISOString() ?? null,
        workerVersion: row.workerVersion,
        serverVersion: row.serverVersion,
        codexVersion: row.codexVersion,
      })),
      modelBehavior: behaviorRows.map((row) => ({
        id: row.id,
        sourceKey: row.sourceKey,
        projectId: row.projectId,
        chatId: row.chatId,
        modelId: row.modelId,
        modelRouteId: row.modelRouteId,
        modelName: row.modelName,
        providerModelName: row.providerModelName,
        providerAccountId: row.providerAccountId,
        workerId: row.workerId,
        turnId: row.turnId,
        executionAttemptId: row.executionAttemptId,
        attemptStatus: row.attemptStatus,
        reasoningEffort: row.reasoningEffort,
        startedAt: row.startedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        finalizedAt: row.finalizedAt?.toISOString() ?? null,
        durationMs: row.durationMs,
        finalAnswerAppeared: row.finalAnswerAppeared,
        toolCallCount: row.toolCallCount,
        invalidToolCallCount: row.invalidToolCallCount,
        retryFailoverCount: row.retryFailoverCount,
        compactionCount: row.compactionCount,
        approvalRequestCount: row.approvalRequestCount,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens,
        outputTokens: row.outputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        filesChangedCount: row.filesChangedCount,
        testCommandCount: row.testCommandCount,
        testPassCount: row.testPassCount,
        testFailureCount: row.testFailureCount,
        userInterrupted: row.userInterrupted,
        userRetryRegeneration: row.userRetryRegeneration,
        immediateCorrectiveFollowup: row.immediateCorrectiveFollowup,
        forkCount: row.forkCount,
        copyCount: row.copyCount,
        ratingValue: row.ratingValue,
        workerVersion: row.workerVersion,
        serverVersion: row.serverVersion,
        codexVersion: row.codexVersion,
        signalAvailability: row.signalAvailability,
      })),
      modelCatalogSnapshots: catalogRows.map((row) => ({
        id: row.id,
        providerAccountId: row.providerAccountId,
        workerId: row.workerId,
        availabilityScope: row.availabilityScope,
        nativeModelId: row.nativeModelId,
        canonicalModelId: row.canonicalModelId,
        metadataSource: row.metadataSource,
        metadataHash: row.metadataHash,
        metadata: row.metadata,
        observedAt: row.observedAt.toISOString(),
      })),
    };
  }

  async deleteProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryDeleteResult | null> {
    const provider = await this.database
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.ownerId, ownerId),
          eq(schema.modelProviders.id, providerId),
        ),
      )
      .limit(1);
    if (!provider[0]) return null;

    return this.database.transaction(async (transaction) => {
      const quotaObservations = await transaction
        .delete(schema.providerQuotaObservations)
        .where(
          and(
            eq(schema.providerQuotaObservations.ownerId, ownerId),
            eq(schema.providerQuotaObservations.providerId, providerId),
          ),
        )
        .returning({ id: schema.providerQuotaObservations.id });
      const tokenUsage = await transaction
        .delete(schema.tokenUsageRecords)
        .where(
          and(
            eq(schema.tokenUsageRecords.ownerId, ownerId),
            eq(schema.tokenUsageRecords.providerId, providerId),
          ),
        )
        .returning({ id: schema.tokenUsageRecords.id });
      const modelBehavior = await transaction
        .delete(schema.modelBehaviorObservations)
        .where(
          and(
            eq(schema.modelBehaviorObservations.ownerId, ownerId),
            eq(schema.modelBehaviorObservations.providerId, providerId),
          ),
        )
        .returning({ id: schema.modelBehaviorObservations.id });
      const modelCatalogSnapshots = await transaction
        .delete(schema.providerModelCatalogSnapshots)
        .where(
          and(
            eq(schema.providerModelCatalogSnapshots.ownerId, ownerId),
            eq(schema.providerModelCatalogSnapshots.providerId, providerId),
          ),
        )
        .returning({ id: schema.providerModelCatalogSnapshots.id });
      return {
        providerId,
        deleted: {
          quotaObservations: quotaObservations.length,
          tokenUsage: tokenUsage.length,
          modelBehavior: modelBehavior.length,
          modelCatalogSnapshots: modelCatalogSnapshots.length,
        },
      };
    });
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
    const current = await this.getModelProvider(ownerId, providerId);
    if (!current) return null;
    if (current.kind !== input.kind) {
      throw new Error(
        "Provider type cannot be changed. Create a new provider instead.",
      );
    }
    const result = await this.database
      .update(schema.modelProviders)
      .set({
        name: input.name,
        kind: input.kind,
        baseUrl: normalizeResponsesBaseUrl(input.baseUrl),
        ...(input.weeklyUsageReservePercent === undefined
          ? {}
          : {
              weeklyUsageReservePercent: input.weeklyUsageReservePercent,
            }),
        ...(input.apiKey === undefined
          ? {}
          : input.apiKey === null
            ? { apiKey: null, apiKeyEnvelope: null }
            : {
                apiKey: null,
                apiKeyEnvelope: this.secretVault.encrypt(
                  input.apiKey,
                  modelProviderSecretContext(ownerId, providerId),
                ),
              }),
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

  async getModelProviderCatalogRuntime(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderCatalogRuntime | null> {
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
    const provider = rows[0];
    if (!provider) return null;
    return {
      id: provider.id,
      ownerId: provider.ownerId,
      kind: provider.kind as ModelProviderSummary["kind"],
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKeyEnvelope
        ? this.secretVault.decrypt(
            provider.apiKeyEnvelope,
            modelProviderSecretContext(provider.ownerId, provider.id),
          )
        : provider.apiKey,
    };
  }

  async setProviderCatalogSyncState(
    providerId: string,
    input: {
      scopeKey: string;
      status: ProviderCatalogSyncState["status"];
      error?: string | null;
      etag?: string | null;
      refreshStartedAt?: Date | null;
      lastSuccessAt?: Date | null;
      workerId?: string | null;
      providerAccountId?: string | null;
    },
  ): Promise<void> {
    const now = new Date();
    await this.database
      .insert(schema.providerCatalogSyncStates)
      .values({
        id: randomUUID(),
        providerId,
        scopeKey: input.scopeKey,
        status: input.status,
        error: input.error ?? null,
        etag: input.etag ?? null,
        refreshStartedAt: input.refreshStartedAt ?? null,
        lastSuccessAt: input.lastSuccessAt ?? null,
        workerId: input.workerId ?? null,
        providerAccountId: input.providerAccountId ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.providerCatalogSyncStates.providerId,
          schema.providerCatalogSyncStates.scopeKey,
        ],
        set: {
          status: input.status,
          ...(input.error === undefined ? {} : { error: input.error }),
          ...(input.etag === undefined ? {} : { etag: input.etag }),
          ...(input.refreshStartedAt === undefined
            ? {}
            : { refreshStartedAt: input.refreshStartedAt }),
          ...(input.lastSuccessAt === undefined
            ? {}
            : { lastSuccessAt: input.lastSuccessAt }),
          ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
          ...(input.providerAccountId === undefined
            ? {}
            : { providerAccountId: input.providerAccountId }),
          updatedAt: now,
        },
      });
  }

  async reconcileProviderModelCatalog(
    ownerId: string,
    providerId: string,
    input: {
      models: ProviderModelCatalogWrite[];
      availabilityScope: string;
      availableNativeModelIds: ReadonlySet<string>;
      autoCreateLogicalModels?: boolean;
      autoCreateNativeModelIds?: ReadonlySet<string>;
      availabilityWorkerId?: string | null;
      availabilityProviderAccountId?: string | null;
      defaultNativeModelId?: string | null;
    },
  ): Promise<boolean> {
    const provider = await this.database
      .select({
        id: schema.modelProviders.id,
        name: schema.modelProviders.name,
      })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!provider[0]) return false;

    const now = new Date();
    await this.database.transaction(async (transaction) => {
      if (input.models.length > 0) {
        await transaction
          .insert(schema.providerModelCatalogSnapshots)
          .values(
            input.models.map((model) => {
              const snapshot = catalogMetadataSnapshot(model);
              return {
                id: randomUUID(),
                ownerId,
                providerId,
                providerName: provider[0]!.name,
                providerAccountId: input.availabilityProviderAccountId ?? null,
                workerId: input.availabilityWorkerId ?? null,
                availabilityScope: input.availabilityScope,
                nativeModelId: model.nativeModelId,
                canonicalModelId: model.canonicalModelId,
                metadataSource: model.metadataSource,
                metadataHash: snapshot.metadataHash,
                metadata: snapshot.metadata,
                observedAt: now,
              };
            }),
          )
          .onConflictDoNothing();
        await transaction
          .insert(schema.providerModels)
          .values(
            input.models.map((model) => ({
              id: randomUUID(),
              providerId,
              ...model,
              lastSeenAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [
              schema.providerModels.providerId,
              schema.providerModels.nativeModelId,
            ],
            set: {
              canonicalModelId: sql`excluded.canonical_model_id`,
              displayName: sql`excluded.display_name`,
              description: sql`excluded.description`,
              contextWindow: sql`excluded.context_window`,
              maxOutputTokens: sql`excluded.max_output_tokens`,
              inputModalities: sql`excluded.input_modalities`,
              outputModalities: sql`excluded.output_modalities`,
              supportsTools: sql`excluded.supports_tools`,
              supportsParallelTools: sql`excluded.supports_parallel_tools`,
              supportsStructuredOutput: sql`excluded.supports_structured_output`,
              supportsVision: sql`excluded.supports_vision`,
              supportsReasoning: sql`excluded.supports_reasoning`,
              supportedReasoningEfforts: sql`excluded.supported_reasoning_efforts`,
              defaultReasoningEffort: sql`excluded.default_reasoning_effort`,
              reasoningMandatory: sql`excluded.reasoning_mandatory`,
              family: sql`excluded.family`,
              parameterSize: sql`excluded.parameter_size`,
              quantization: sql`excluded.quantization`,
              digest: sql`excluded.digest`,
              metadataSource: sql`excluded.metadata_source`,
              matchConfidenceBasisPoints: sql`excluded.match_confidence_basis_points`,
              hidden: sql`excluded.hidden`,
              isDefault: sql`excluded.is_default`,
              rawMetadata: sql`excluded.raw_metadata`,
              lastSeenAt: now,
              updatedAt: now,
            },
          });
      }

      const providerModelRows = await transaction
        .select({
          id: schema.providerModels.id,
          nativeModelId: schema.providerModels.nativeModelId,
        })
        .from(schema.providerModels)
        .where(eq(schema.providerModels.providerId, providerId));
      if (providerModelRows.length === 0) return;

      for (const model of providerModelRows) {
        if (!input.availableNativeModelIds.has(model.nativeModelId)) continue;
        await transaction
          .update(schema.modelRoutes)
          .set({ providerModelId: model.id, updatedAt: now })
          .where(
            and(
              eq(schema.modelRoutes.providerId, providerId),
              eq(schema.modelRoutes.modelName, model.nativeModelId),
              isNull(schema.modelRoutes.providerModelId),
            ),
          );
      }

      await transaction
        .insert(schema.providerModelAvailability)
        .values(
          providerModelRows.map((model) => ({
            id: randomUUID(),
            providerModelId: model.id,
            scopeKey: input.availabilityScope,
            workerId: input.availabilityWorkerId ?? null,
            providerAccountId: input.availabilityProviderAccountId ?? null,
            state: input.availableNativeModelIds.has(model.nativeModelId)
              ? "available"
              : "unavailable",
            lastSeenAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            schema.providerModelAvailability.providerModelId,
            schema.providerModelAvailability.scopeKey,
          ],
          set: {
            state: sql`excluded.state`,
            workerId: sql`excluded.worker_id`,
            providerAccountId: sql`excluded.provider_account_id`,
            lastSeenAt: now,
            updatedAt: now,
          },
        });

      if (input.autoCreateLogicalModels) {
        const [suppressions, existingRoutes] = await Promise.all([
          transaction
            .select({
              providerModelId: schema.providerModelSuppressions.providerModelId,
            })
            .from(schema.providerModelSuppressions)
            .where(eq(schema.providerModelSuppressions.ownerId, ownerId)),
          transaction
            .select({ modelName: schema.modelRoutes.modelName })
            .from(schema.modelRoutes)
            .innerJoin(
              schema.modelProfiles,
              and(
                eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
                eq(schema.modelProfiles.ownerId, ownerId),
              ),
            )
            .where(eq(schema.modelRoutes.providerId, providerId)),
        ]);
        const suppressed = new Set(
          suppressions.map(({ providerModelId }) => providerModelId),
        );
        const routedNames = new Set(
          existingRoutes.map(({ modelName }) => modelName),
        );
        const catalogByName = new Map(
          input.models.map((model) => [model.nativeModelId, model]),
        );
        const discovered = providerModelRows.filter(
          (model) =>
            (
              input.autoCreateNativeModelIds ?? input.availableNativeModelIds
            ).has(model.nativeModelId) &&
            !suppressed.has(model.id) &&
            !routedNames.has(model.nativeModelId),
        );
        for (const model of discovered) {
          const profileId = `discovered:model:${model.id}`;
          const routeId = `discovered:route:${model.id}`;
          await transaction
            .insert(schema.modelProfiles)
            .values({
              id: profileId,
              ownerId,
              name: model.nativeModelId,
              canonicalModelId:
                catalogByName.get(model.nativeModelId)?.canonicalModelId ??
                null,
              discoveryManaged: true,
            })
            .onConflictDoNothing({ target: schema.modelProfiles.id });
          await transaction
            .insert(schema.modelRoutes)
            .values({
              id: routeId,
              modelId: profileId,
              providerId,
              providerModelId: model.id,
              modelName: model.nativeModelId,
              position: 0,
              enabled: true,
              discoveryManaged: true,
            })
            .onConflictDoNothing({ target: schema.modelRoutes.id });
        }
        if (input.defaultNativeModelId) {
          const defaultRoutes = await transaction
            .select({ modelId: schema.modelRoutes.modelId })
            .from(schema.modelRoutes)
            .innerJoin(
              schema.providerModels,
              and(
                eq(
                  schema.providerModels.id,
                  schema.modelRoutes.providerModelId,
                ),
                eq(schema.providerModels.providerId, providerId),
                eq(
                  schema.providerModels.nativeModelId,
                  input.defaultNativeModelId,
                ),
              ),
            )
            .limit(1);
          if (defaultRoutes[0]) {
            await transaction
              .update(schema.userSettings)
              .set({ defaultModelId: defaultRoutes[0].modelId, updatedAt: now })
              .where(
                and(
                  eq(schema.userSettings.userId, ownerId),
                  isNull(schema.userSettings.defaultModelId),
                ),
              );
          }
        }
      }
    });
    return true;
  }

  async getProviderModelCatalog(
    ownerId: string,
    providerId: string,
    servedStale = false,
  ): Promise<ProviderModelCatalogResult | null> {
    const provider = await this.database
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!provider[0]) return null;

    const [models, availability, syncStates] = await Promise.all([
      this.database
        .select()
        .from(schema.providerModels)
        .where(eq(schema.providerModels.providerId, providerId))
        .orderBy(asc(schema.providerModels.displayName)),
      this.database
        .select({ availability: schema.providerModelAvailability })
        .from(schema.providerModelAvailability)
        .innerJoin(
          schema.providerModels,
          and(
            eq(
              schema.providerModels.id,
              schema.providerModelAvailability.providerModelId,
            ),
            eq(schema.providerModels.providerId, providerId),
          ),
        ),
      this.database
        .select()
        .from(schema.providerCatalogSyncStates)
        .where(eq(schema.providerCatalogSyncStates.providerId, providerId))
        .orderBy(asc(schema.providerCatalogSyncStates.scopeKey)),
    ]);
    return {
      providerId,
      models: models.map(toProviderModelCatalogEntry),
      availability: availability.map(({ availability: row }) =>
        toProviderModelAvailability(row),
      ),
      syncStates: syncStates.map(toProviderCatalogSyncState),
      servedStale,
    };
  }

  async listProviderModelAvailability(
    ownerId: string,
    providerId: string,
    providerModelId: string,
  ): Promise<ProviderModelAvailability[]> {
    const rows = await this.database
      .select({ availability: schema.providerModelAvailability })
      .from(schema.providerModelAvailability)
      .innerJoin(
        schema.providerModels,
        and(
          eq(
            schema.providerModels.id,
            schema.providerModelAvailability.providerModelId,
          ),
          eq(schema.providerModels.id, providerModelId),
          eq(schema.providerModels.providerId, providerId),
        ),
      )
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.providerModels.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      );
    return rows.map(({ availability }) =>
      toProviderModelAvailability(availability),
    );
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
      });
      await transaction.insert(schema.modelRoutes).values(
        input.routes.map((route, position) => ({
          id: randomUUID(),
          modelId,
          providerId: route.providerId,
          modelName: route.modelName,
          position,
          enabled: route.enabled,
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
    return this.database.transaction(async (transaction) => {
      const managedRoutes = await transaction
        .select({ providerModelId: schema.modelRoutes.providerModelId })
        .from(schema.modelRoutes)
        .innerJoin(
          schema.modelProfiles,
          and(
            eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
            eq(schema.modelProfiles.ownerId, ownerId),
            eq(schema.modelProfiles.discoveryManaged, true),
          ),
        )
        .where(eq(schema.modelRoutes.modelId, modelId));
      const providerModelIds = managedRoutes.flatMap(({ providerModelId }) =>
        providerModelId ? [providerModelId] : [],
      );
      if (providerModelIds.length > 0) {
        await transaction
          .insert(schema.providerModelSuppressions)
          .values(
            providerModelIds.map((providerModelId) => ({
              ownerId,
              providerModelId,
            })),
          )
          .onConflictDoNothing();
      }
      const result = await transaction
        .delete(schema.modelProfiles)
        .where(
          and(
            eq(schema.modelProfiles.id, modelId),
            eq(schema.modelProfiles.ownerId, ownerId),
          ),
        )
        .returning({ id: schema.modelProfiles.id });
      return Boolean(result[0]);
    });
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
      .select({ id: schema.modelProfiles.id })
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
    const invalidatedRouteIds = new Set(
      existingRoutes.flatMap((route) => {
        const inputRoute = input.routes.find(
          (candidate) => candidate.id === route.id,
        );
        if (!inputRoute) return [route.id];
        const runtimeConfigurationChanged =
          route.providerId !== inputRoute.providerId ||
          route.modelName !== inputRoute.modelName;
        return runtimeConfigurationChanged ? [route.id] : [];
      }),
    );

    await this.database.transaction(async (transaction) => {
      await transaction
        .update(schema.modelProfiles)
        .set({
          name: input.name,
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
        providerModel: schema.providerModels,
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
      .leftJoin(
        schema.providerModels,
        and(
          eq(schema.providerModels.providerId, schema.modelRoutes.providerId),
          or(
            eq(schema.providerModels.id, schema.modelRoutes.providerModelId),
            and(
              isNull(schema.modelRoutes.providerModelId),
              eq(
                schema.providerModels.nativeModelId,
                schema.modelRoutes.modelName,
              ),
            ),
          ),
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
    const catalogRows = rows.flatMap((row) =>
      row.providerModel
        ? [
            {
              catalog: toProviderModelCatalogEntry(row.providerModel),
              providerKind: row.provider.kind as ModelProviderSummary["kind"],
            },
          ]
        : [],
    );
    const aliases = [
      ...new Set(
        catalogRows.flatMap(({ catalog, providerKind }) => [
          ...exactOpenRouterAliases(catalog, providerKind),
        ]),
      ),
    ];
    const enrichmentRows = aliases.length
      ? await this.database
          .select({
            model: schema.providerModels,
            provider: schema.modelProviders,
          })
          .from(schema.providerModels)
          .innerJoin(
            schema.modelProviders,
            and(
              eq(schema.modelProviders.id, schema.providerModels.providerId),
              eq(schema.modelProviders.ownerId, ownerId),
              eq(schema.modelProviders.kind, "openai-compatible"),
            ),
          )
          .where(
            or(
              inArray(schema.providerModels.nativeModelId, aliases),
              inArray(schema.providerModels.canonicalModelId, aliases),
            ),
          )
      : [];
    const openRouterCatalog = enrichmentRows.flatMap((row) => {
      try {
        const hostname = new URL(row.provider.baseUrl).hostname.toLowerCase();
        if (
          hostname !== "openrouter.ai" &&
          !hostname.endsWith(".openrouter.ai")
        ) {
          return [];
        }
      } catch {
        return [];
      }
      return [toProviderModelCatalogEntry(row.model)];
    });

    return rows.map((row) => ({
      routeId: row.route.id,
      model: {
        id: row.model.id,
        profileName: row.model.name,
        routeId: row.route.id,
        name: row.route.modelName,
        reasoningEffort: null,
        providerModelId:
          row.route.providerModelId ?? row.providerModel?.id ?? null,
        catalog: row.providerModel
          ? enrichCatalogFromExactOpenRouterMatch(
              toProviderModelCatalogEntry(row.providerModel),
              row.provider.kind as ModelProviderSummary["kind"],
              openRouterCatalog,
            )
          : null,
      },
      provider: {
        id: row.provider.id,
        name: row.provider.name,
        kind: row.provider.kind as ModelProviderSummary["kind"],
        baseUrl: row.provider.baseUrl,
        apiKey: row.provider.apiKeyEnvelope
          ? this.secretVault.decrypt(
              row.provider.apiKeyEnvelope,
              modelProviderSecretContext(row.provider.ownerId, row.provider.id),
            )
          : null,
        accountId: null,
        credentialHomeKey: null,
        weeklyUsageReservePercent: row.provider.weeklyUsageReservePercent,
      },
    }));
  }

  async listModelProviderAccountRuntimes(
    ownerId: string,
    providerId: string,
    workerId: string,
    providerModelId: string | null,
  ): Promise<ModelProviderAccountRuntime[]> {
    const [accounts, availability] = await Promise.all([
      this.database
        .select({
          account: schema.modelProviderAccounts,
          binding: schema.modelProviderAccountWorkers,
        })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          and(
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
            eq(schema.modelProviders.ownerId, ownerId),
            inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          ),
        )
        .leftJoin(
          schema.modelProviderAccountWorkers,
          and(
            eq(
              schema.modelProviderAccountWorkers.accountId,
              schema.modelProviderAccounts.id,
            ),
            eq(schema.modelProviderAccountWorkers.workerId, workerId),
          ),
        )
        .where(eq(schema.modelProviderAccounts.providerId, providerId))
        .orderBy(asc(schema.modelProviderAccounts.position)),
      providerModelId
        ? this.database
            .select({
              providerAccountId:
                schema.providerModelAvailability.providerAccountId,
              state: schema.providerModelAvailability.state,
              workerId: schema.providerModelAvailability.workerId,
            })
            .from(schema.providerModelAvailability)
            .where(
              and(
                eq(
                  schema.providerModelAvailability.providerModelId,
                  providerModelId,
                ),
                or(
                  isNull(schema.providerModelAvailability.workerId),
                  eq(schema.providerModelAvailability.workerId, workerId),
                ),
              ),
            )
        : Promise.resolve([]),
    ]);
    const availabilityByAccount = new Map<
      string,
      { state: ProviderModelAvailability["state"]; workerId: string | null }
    >();
    for (const row of availability) {
      if (!row.providerAccountId) continue;
      const current = availabilityByAccount.get(row.providerAccountId);
      if (!current || row.workerId === null) {
        availabilityByAccount.set(row.providerAccountId, {
          state: row.state as ProviderModelAvailability["state"],
          workerId: row.workerId,
        });
      }
    }
    return accounts.map(({ account, binding }) => ({
      accountId: account.id,
      credentialState:
        account.credentialState as ModelProviderAccountRuntime["credentialState"],
      credentialHomeKey: account.credentialHomeKey,
      enabled: account.enabled,
      label: account.label,
      legacyWorkerAuthenticated: binding?.authState === "signed-in",
      modelAvailability: availabilityByAccount.get(account.id)?.state ?? null,
      position: account.position,
      weeklyUsageUsedPercent:
        account.weeklyUsageUsedBasisPoints === null
          ? null
          : account.weeklyUsageUsedBasisPoints / 100,
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

  async createWorkerEnrollmentCode(input: {
    codeHash: string;
    createdBySessionId: string | null;
    expiresAt: Date;
    label: string | null;
    ownerId: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.insert(schema.workerEnrollmentCodes).values({
      id,
      ownerId: input.ownerId,
      createdBySessionId: input.createdBySessionId,
      codeHash: input.codeHash,
      label: input.label,
      expiresAt: input.expiresAt,
    });
    return id;
  }

  async findReusableWorkerId(
    ownerId: string,
    candidateWorkerIds: readonly string[],
  ): Promise<string | null> {
    const candidates = [...new Set(candidateWorkerIds)].slice(0, 64);
    if (candidates.length === 0) return null;

    const activeSourceCount = sql<number>`count(${schema.projectSources.id})`;
    const rows = await this.database
      .select({
        id: schema.workers.id,
        sourceCount: activeSourceCount,
      })
      .from(schema.workers)
      .leftJoin(
        schema.projectSources,
        and(
          eq(schema.projectSources.workerId, schema.workers.id),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .where(
        and(
          eq(schema.workers.ownerId, ownerId),
          inArray(schema.workers.id, candidates),
          sql`${schema.workers.unlinkedAt} IS NOT NULL`,
        ),
      )
      .groupBy(schema.workers.id, schema.workers.lastSeenAt)
      .orderBy(desc(activeSourceCount), desc(schema.workers.lastSeenAt))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async getWorkerEnrollmentCodeStatus(
    ownerId: string,
    enrollmentCodeId: string,
  ): Promise<WorkerEnrollmentCodeStatus | null> {
    const rows = await this.database
      .select()
      .from(schema.workerEnrollmentCodes)
      .where(
        and(
          eq(schema.workerEnrollmentCodes.id, enrollmentCodeId),
          eq(schema.workerEnrollmentCodes.ownerId, ownerId),
        ),
      )
      .limit(1);
    const code = rows[0];
    if (!code) return null;
    return {
      id: code.id,
      label: code.label,
      expiresAt: toISOString(code.expiresAt),
      status: code.consumedAt
        ? "paired"
        : code.expiresAt.getTime() <= Date.now()
          ? "expired"
          : "pending",
    };
  }

  async exchangeWorkerEnrollmentCode(input: {
    codeHash: string;
    credentialHash: string;
    credentialId: string;
    heartbeat: WorkerHeartbeat;
    replacement: { workerId: string; credentialHash: string } | null;
    scopes: WorkerCredentialScope[];
  }): Promise<WorkerEnrollmentProvision> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const codes = await transaction
        .select()
        .from(schema.workerEnrollmentCodes)
        .where(
          and(
            eq(schema.workerEnrollmentCodes.codeHash, input.codeHash),
            isNull(schema.workerEnrollmentCodes.consumedAt),
            gt(schema.workerEnrollmentCodes.expiresAt, now),
          ),
        )
        .for("update")
        .limit(1);
      const code = codes[0];
      if (!code) {
        throw new WorkerEnrollmentError(
          "This worker link code is invalid, expired, or already used.",
        );
      }

      if (input.replacement?.workerId === input.heartbeat.workerId) {
        throw new WorkerEnrollmentError(
          "A worker cannot replace its own identity during enrollment.",
        );
      }
      let revokedCredentialIds: string[] = [];
      if (input.replacement) {
        const replacementCredentials = await transaction
          .select()
          .from(schema.workerCredentials)
          .where(
            and(
              eq(schema.workerCredentials.workerId, input.replacement.workerId),
              eq(
                schema.workerCredentials.secretHash,
                input.replacement.credentialHash,
              ),
              isNull(schema.workerCredentials.revokedAt),
              or(
                isNull(schema.workerCredentials.expiresAt),
                gt(schema.workerCredentials.expiresAt, now),
              ),
            ),
          )
          .for("update")
          .limit(1);
        const replacementCredential = replacementCredentials[0];
        if (!replacementCredential) {
          throw new WorkerEnrollmentError(
            "The previous worker credential could not authorize reassignment.",
          );
        }
        const replacementWorkers = await transaction
          .select()
          .from(schema.workers)
          .where(eq(schema.workers.id, input.replacement.workerId))
          .for("update")
          .limit(1);
        const replacementWorker = replacementWorkers[0];
        if (
          !replacementWorker ||
          replacementWorker.ownerId !== replacementCredential.ownerId
        ) {
          throw new WorkerEnrollmentError(
            "The previous worker identity and credential do not match.",
          );
        }
        const revokedRows = await transaction
          .update(schema.workerCredentials)
          .set({
            revokedAt: now,
            revokedReason: "Worker reassigned to another account.",
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.workerCredentials.workerId, input.replacement.workerId),
              isNull(schema.workerCredentials.revokedAt),
            ),
          )
          .returning({ id: schema.workerCredentials.id });
        revokedCredentialIds = revokedRows.map(({ id }) => id);
        await transaction
          .update(schema.workers)
          .set({ unlinkedAt: now, updatedAt: now })
          .where(eq(schema.workers.id, input.replacement.workerId));
      }

      const existingWorkers = await transaction
        .select()
        .from(schema.workers)
        .where(eq(schema.workers.id, input.heartbeat.workerId))
        .for("update")
        .limit(1);
      const existingWorker = existingWorkers[0];
      if (existingWorker && existingWorker.ownerId !== code.ownerId) {
        throw new WorkerEnrollmentError(
          "This worker identity is already owned by another account.",
        );
      }
      if (existingWorker) {
        const activeCredentials = await transaction
          .select({ id: schema.workerCredentials.id })
          .from(schema.workerCredentials)
          .where(
            and(
              eq(schema.workerCredentials.workerId, input.heartbeat.workerId),
              isNull(schema.workerCredentials.revokedAt),
              or(
                isNull(schema.workerCredentials.expiresAt),
                gt(schema.workerCredentials.expiresAt, now),
              ),
            ),
          )
          .limit(1);
        if (activeCredentials[0]) {
          throw new WorkerEnrollmentError(
            "This worker identity is already enrolled. Rotate its credential instead.",
          );
        }
      }

      const consumed = await transaction
        .update(schema.workerEnrollmentCodes)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.workerEnrollmentCodes.id, code.id),
            isNull(schema.workerEnrollmentCodes.consumedAt),
          ),
        )
        .returning({ id: schema.workerEnrollmentCodes.id });
      if (!consumed[0]) {
        throw new WorkerEnrollmentError(
          "This worker link code was already used.",
        );
      }

      const workerValues = {
        name: input.heartbeat.name,
        platform: input.heartbeat.platform,
        architecture: input.heartbeat.architecture,
        codexVersion: input.heartbeat.codexVersion,
        codexRuntime: input.heartbeat.codexRuntime,
        remoteSurfaceCapabilities: input.heartbeat.remoteSurfaces,
        directBrokerAdvertisement: input.heartbeat.directBroker,
        codeCapabilities: input.heartbeat.code ?? unavailableCodeCapabilities,
        codegraphStatus:
          input.heartbeat.codegraph ?? unavailableCodeGraphWorkerStatus,
        encryptionStatus:
          input.heartbeat.encryption ?? unavailableWorkerEncryptionStatus,
        projectReplicaCapabilities:
          input.heartbeat.projectReplicas ??
          unavailableProjectReplicaCapabilities,
        managedFolderCapabilities:
          input.heartbeat.managedFolders ??
          unavailableManagedFolderCapabilities,
        chatRelocationCapability: input.heartbeat.chatRelocation ?? false,
        externalCodexHistoryCapability:
          input.heartbeat.externalCodexHistory ?? false,
        startedAt: new Date(input.heartbeat.startedAt),
        lastSeenAt: now,
        unlinkedAt: null,
        updatedAt: now,
      };
      const workerRows = existingWorker
        ? await transaction
            .update(schema.workers)
            .set(workerValues)
            .where(
              and(
                eq(schema.workers.id, input.heartbeat.workerId),
                eq(schema.workers.ownerId, code.ownerId),
              ),
            )
            .returning()
        : await transaction
            .insert(schema.workers)
            .values({
              id: input.heartbeat.workerId,
              ownerId: code.ownerId,
              ...workerValues,
            })
            .returning();
      const credentialRows = await transaction
        .insert(schema.workerCredentials)
        .values({
          id: input.credentialId,
          ownerId: code.ownerId,
          workerId: input.heartbeat.workerId,
          secretHash: input.credentialHash,
          label: code.label,
          scopes: input.scopes,
          lastUsedAt: now,
        })
        .returning();
      return {
        ownerId: code.ownerId,
        replacedWorkerId: input.replacement?.workerId ?? null,
        revokedCredentialIds,
        worker: toWorkerSummary(firstOrThrow(workerRows, "enrolling a worker")),
        credential: toWorkerCredentialSummary(
          firstOrThrow(credentialRows, "creating a worker credential"),
          now,
        ),
      };
    });
  }

  async authenticateWorkerCredential(
    secretHash: string,
    workerId: string,
    requiredScope: WorkerCredentialScope,
  ): Promise<ActiveWorkerCredential | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.workerCredentials)
        .where(
          and(
            eq(schema.workerCredentials.secretHash, secretHash),
            eq(schema.workerCredentials.workerId, workerId),
            isNull(schema.workerCredentials.revokedAt),
            or(
              isNull(schema.workerCredentials.expiresAt),
              gt(schema.workerCredentials.expiresAt, now),
            ),
          ),
        )
        .for("update")
        .limit(1);
      const credential = rows[0];
      if (!credential) return null;
      const scopes = credential.scopes as WorkerCredentialScope[];
      if (!scopes.includes(requiredScope)) return null;
      await transaction
        .update(schema.workerCredentials)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(schema.workerCredentials.id, credential.id));
      return {
        id: credential.id,
        ownerId: credential.ownerId,
        scopes,
        workerId: credential.workerId,
      };
    });
  }

  async listWorkerCredentials(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerCredentialSummary[] | null> {
    if (!(await this.getWorker(ownerId, workerId))) return null;
    const rows = await this.database
      .select()
      .from(schema.workerCredentials)
      .where(
        and(
          eq(schema.workerCredentials.ownerId, ownerId),
          eq(schema.workerCredentials.workerId, workerId),
        ),
      )
      .orderBy(desc(schema.workerCredentials.createdAt));
    return rows.map((row) => toWorkerCredentialSummary(row));
  }

  async rotateWorkerCredential(input: {
    credentialHash: string;
    credentialId: string;
    label: string | null;
    ownerId: string;
    scopes: WorkerCredentialScope[];
    workerId: string;
  }): Promise<WorkerCredentialSummary | null> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const workers = await transaction
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, input.ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!workers[0]) return null;
      const active = await transaction
        .select({ id: schema.workerCredentials.id })
        .from(schema.workerCredentials)
        .where(
          and(
            eq(schema.workerCredentials.ownerId, input.ownerId),
            eq(schema.workerCredentials.workerId, input.workerId),
            isNull(schema.workerCredentials.revokedAt),
          ),
        )
        .orderBy(desc(schema.workerCredentials.createdAt));
      if (!active[0]) {
        throw new WorkerEnrollmentError(
          "Development bootstrap workers do not have rotatable credentials.",
        );
      }
      await transaction
        .update(schema.workerCredentials)
        .set({
          revokedAt: now,
          revokedReason: "rotated",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workerCredentials.ownerId, input.ownerId),
            eq(schema.workerCredentials.workerId, input.workerId),
            isNull(schema.workerCredentials.revokedAt),
          ),
        );
      const created = await transaction
        .insert(schema.workerCredentials)
        .values({
          id: input.credentialId,
          ownerId: input.ownerId,
          workerId: input.workerId,
          secretHash: input.credentialHash,
          label: input.label,
          scopes: input.scopes,
          replacesCredentialId: active[0]?.id ?? null,
        })
        .returning();
      return toWorkerCredentialSummary(
        firstOrThrow(created, "rotating a worker credential"),
        now,
      );
    });
  }

  async revokeWorkerCredential(
    ownerId: string,
    workerId: string,
    credentialId: string,
    reason = "revoked by owner",
  ): Promise<WorkerCredentialSummary | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.workerCredentials)
      .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(
        and(
          eq(schema.workerCredentials.id, credentialId),
          eq(schema.workerCredentials.workerId, workerId),
          eq(schema.workerCredentials.ownerId, ownerId),
          isNull(schema.workerCredentials.revokedAt),
        ),
      )
      .returning();
    return rows[0] ? toWorkerCredentialSummary(rows[0], now) : null;
  }

  async recordWorker(
    ownerId: string,
    heartbeat: WorkerHeartbeat,
  ): Promise<WorkerSummary> {
    const now = new Date();
    const values = {
      name: heartbeat.name,
      platform: heartbeat.platform,
      architecture: heartbeat.architecture,
      codexVersion: heartbeat.codexVersion,
      codexRuntime: heartbeat.codexRuntime,
      remoteSurfaceCapabilities: heartbeat.remoteSurfaces,
      directBrokerAdvertisement: heartbeat.directBroker,
      codeCapabilities: heartbeat.code ?? unavailableCodeCapabilities,
      codegraphStatus: heartbeat.codegraph ?? unavailableCodeGraphWorkerStatus,
      encryptionStatus:
        heartbeat.encryption ?? unavailableWorkerEncryptionStatus,
      projectReplicaCapabilities:
        heartbeat.projectReplicas ?? unavailableProjectReplicaCapabilities,
      managedFolderCapabilities:
        heartbeat.managedFolders ?? unavailableManagedFolderCapabilities,
      chatRelocationCapability: heartbeat.chatRelocation ?? false,
      externalCodexHistoryCapability: heartbeat.externalCodexHistory ?? false,
      startedAt: new Date(heartbeat.startedAt),
      lastSeenAt: now,
      unlinkedAt: null,
      updatedAt: now,
    };
    let result = await this.database
      .update(schema.workers)
      .set(values)
      .where(
        and(
          eq(schema.workers.id, heartbeat.workerId),
          eq(schema.workers.ownerId, ownerId),
        ),
      )
      .returning();
    if (!result[0]) {
      try {
        result = await this.database
          .insert(schema.workers)
          .values({ id: heartbeat.workerId, ownerId, ...values })
          .returning();
      } catch (error) {
        const currentOwnerId = await this.getWorkerOwnerId(heartbeat.workerId);
        if (currentOwnerId && currentOwnerId !== ownerId) {
          throw new WorkerEnrollmentError(
            "This worker identity belongs to another account.",
          );
        }
        if (currentOwnerId === ownerId) {
          result = await this.database
            .update(schema.workers)
            .set(values)
            .where(
              and(
                eq(schema.workers.id, heartbeat.workerId),
                eq(schema.workers.ownerId, ownerId),
              ),
            )
            .returning();
        } else {
          throw error;
        }
      }
    }
    return toWorkerSummary(
      firstOrThrow(result, "recording a worker heartbeat"),
    );
  }

  async listWorkers(ownerId: string): Promise<WorkerSummary[]> {
    const rows = await this.database
      .select()
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .orderBy(asc(schema.workers.name));
    return rows.map(toWorkerSummary);
  }

  async getWorker(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.id, workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toWorkerSummary(rows[0]) : null;
  }

  async listWorkerManagement(
    ownerId: string,
  ): Promise<WorkerManagementRecord[]> {
    const rows = await this.database
      .select()
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .orderBy(asc(schema.workers.name));
    return Promise.all(
      rows.map(async (worker) => {
        const [credentials, sources] = await Promise.all([
          this.database
            .select({ revokedAt: schema.workerCredentials.revokedAt })
            .from(schema.workerCredentials)
            .where(
              and(
                eq(schema.workerCredentials.ownerId, ownerId),
                eq(schema.workerCredentials.workerId, worker.id),
              ),
            ),
          this.database
            .select({
              projectReplicaId: schema.projectSources.id,
              projectId: schema.projects.id,
              nameWithOwner: sql<string>`coalesce(${schema.projects.githubRepositoryFullName}, ${schema.projects.name})`,
              displayPath: schema.projectSources.displayPath,
            })
            .from(schema.projectSources)
            .innerJoin(
              schema.projects,
              eq(schema.projects.id, schema.projectSources.projectId),
            )
            .where(
              and(
                eq(schema.projectSources.workerId, worker.id),
                eq(schema.projects.ownerId, ownerId),
                isNull(schema.projectSources.removedAt),
              ),
            )
            .orderBy(asc(schema.projects.githubRepositoryFullName)),
        ]);
        return {
          activeCredentialCount: credentials.filter(
            ({ revokedAt }) => !revokedAt,
          ).length,
          credentialCount: credentials.length,
          runtimeName: worker.name,
          sources,
          worker: toWorkerSummary(worker),
        };
      }),
    );
  }

  async updateWorkerDisplayName(
    ownerId: string,
    workerId: string,
    name: string,
  ): Promise<WorkerSummary | null> {
    const rows = await this.database
      .update(schema.workers)
      .set({ displayName: name, updatedAt: new Date() })
      .where(
        and(
          eq(schema.workers.id, workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .returning();
    return rows[0] ? toWorkerSummary(rows[0]) : null;
  }

  async unlinkWorker(ownerId: string, workerId: string): Promise<boolean> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const workers = await transaction
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, workerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!workers[0]) return false;
      await transaction
        .update(schema.workerCredentials)
        .set({
          revokedAt: now,
          revokedReason: "worker unlinked by owner",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workerCredentials.ownerId, ownerId),
            eq(schema.workerCredentials.workerId, workerId),
            isNull(schema.workerCredentials.revokedAt),
          ),
        );
      const unlinked = await transaction
        .update(schema.workers)
        .set({ unlinkedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.workers.id, workerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .returning({ id: schema.workers.id });
      return Boolean(unlinked[0]);
    });
  }

  async getWorkerOwnerId(workerId: string): Promise<string | null> {
    const rows = await this.database
      .select({ ownerId: schema.workers.ownerId })
      .from(schema.workers)
      .where(eq(schema.workers.id, workerId))
      .limit(1);
    return rows[0]?.ownerId ?? null;
  }

  async onlineWorkerCount(ownerId: string): Promise<number> {
    const workers = await this.listWorkers(ownerId);
    return workers.filter((worker) => worker.online).length;
  }

  private async tunnelReferencesAreOwned(
    ownerId: string,
    projectId: string | null,
    source: TunnelSourceEndpoint,
    destination: TunnelDestinationEndpoint,
  ): Promise<boolean> {
    const workerIds = [
      ...new Set(
        [sourceWorkerId(source), destinationWorkerId(destination)].filter(
          (workerId): workerId is string => workerId !== null,
        ),
      ),
    ];
    const [projectRows, workerRows] = await Promise.all([
      projectId
        ? this.database
            .select({
              id: schema.projects.id,
              originKind: schema.projects.originKind,
              preferredWorkerId: schema.projects.preferredWorkerId,
            })
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.id, projectId),
                eq(schema.projects.ownerId, ownerId),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      this.database
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
            inArray(schema.workers.id, workerIds),
          ),
        ),
    ]);
    const project = projectRows[0];
    if (projectId && !project) return false;
    if (
      project?.originKind === "managed-folder" &&
      workerIds.some((workerId) => workerId !== project.preferredWorkerId)
    ) {
      throw new TunnelManagementError(
        "This worker-managed folder is bound to its owning worker.",
      );
    }
    return workerRows.length === workerIds.length;
  }

  private async nextTunnelPosition(ownerId: string): Promise<number> {
    const rows = await this.database
      .select({ position: schema.tunnels.position })
      .from(schema.tunnels)
      .where(eq(schema.tunnels.ownerId, ownerId))
      .orderBy(desc(schema.tunnels.position))
      .limit(1);
    return (rows[0]?.position ?? -1) + 1;
  }

  async listTunnels(
    ownerId: string,
    projectId?: string,
  ): Promise<TunnelSummary[]> {
    const tunnelRows = await this.database
      .select()
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.ownerId, ownerId),
          projectId ? eq(schema.tunnels.projectId, projectId) : undefined,
        ),
      )
      .orderBy(asc(schema.tunnels.position), asc(schema.tunnels.createdAt));
    if (tunnelRows.length === 0) return [];
    const attachmentRows = await this.database
      .select()
      .from(schema.tunnelAttachments)
      .where(
        inArray(
          schema.tunnelAttachments.tunnelId,
          tunnelRows.map(({ id }) => id),
        ),
      )
      .orderBy(
        asc(schema.tunnelAttachments.createdAt),
        asc(schema.tunnelAttachments.id),
      );
    const attachmentsByTunnel = new Map<string, TunnelAttachmentRow[]>();
    for (const attachment of attachmentRows) {
      const attachments = attachmentsByTunnel.get(attachment.tunnelId) ?? [];
      attachments.push(attachment);
      attachmentsByTunnel.set(attachment.tunnelId, attachments);
    }
    return tunnelRows.map((tunnel) =>
      toTunnelSummary(tunnel, attachmentsByTunnel.get(tunnel.id)),
    );
  }

  async getTunnel(
    ownerId: string,
    tunnelId: string,
  ): Promise<TunnelSummary | null> {
    const tunnelRows = await this.database
      .select()
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
        ),
      )
      .limit(1);
    const tunnel = tunnelRows[0];
    if (!tunnel) return null;
    const attachments = await this.database
      .select()
      .from(schema.tunnelAttachments)
      .where(eq(schema.tunnelAttachments.tunnelId, tunnel.id))
      .orderBy(
        asc(schema.tunnelAttachments.createdAt),
        asc(schema.tunnelAttachments.id),
      );
    return toTunnelSummary(tunnel, attachments);
  }

  async createUserTunnel(
    ownerId: string,
    input: TunnelUserCreate,
  ): Promise<TunnelSummary | null> {
    const source = { kind: "desktop-loopback" as const };
    if (
      !(await this.tunnelReferencesAreOwned(
        ownerId,
        input.projectId,
        source,
        input.destination,
      ))
    ) {
      return null;
    }
    const rows = await this.database
      .insert(schema.tunnels)
      .values({
        id: randomUUID(),
        ownerId,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        position: await this.nextTunnelPosition(ownerId),
        origin: "user",
        management: "user-managed",
        protocolHint: input.protocolHint,
        sourceEndpoint: source,
        sourceWorkerId: null,
        destinationEndpoint: input.destination,
        destinationWorkerId: input.destination.workerId,
        managedByKind: null,
        managedById: null,
        desiredState: "stopped",
        status: "stopped",
      })
      .returning();
    return toTunnelSummary(firstOrThrow(rows, "creating a tunnel"));
  }

  async updateUserTunnel(
    ownerId: string,
    tunnelId: string,
    input: TunnelUserUpdate,
  ): Promise<TunnelSummary | null> {
    const existingRows = await this.database
      .select()
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return null;
    if (existing.management !== "user-managed") {
      throw new TunnelManagementError(
        "Managed tunnels are controlled by their owning feature.",
      );
    }
    const activeAttachments = await this.database
      .select({ id: schema.tunnelAttachments.id })
      .from(schema.tunnelAttachments)
      .where(
        and(
          eq(schema.tunnelAttachments.tunnelId, tunnelId),
          notInArray(schema.tunnelAttachments.status, ["stopped", "failed"]),
        ),
      )
      .limit(1);
    if (activeAttachments.length > 0) {
      throw new TunnelManagementError(
        "Stop every tunnel attachment before editing this tunnel.",
      );
    }
    const projectId =
      input.projectId === undefined ? existing.projectId : input.projectId;
    const destination = input.destination ?? existing.destinationEndpoint;
    if (
      !(await this.tunnelReferencesAreOwned(
        ownerId,
        projectId,
        existing.sourceEndpoint,
        destination,
      ))
    ) {
      return null;
    }
    const rows = await this.database
      .update(schema.tunnels)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.projectId === undefined ? {} : { projectId }),
        ...(input.protocolHint === undefined
          ? {}
          : { protocolHint: input.protocolHint }),
        ...(input.destination === undefined
          ? {}
          : {
              destinationEndpoint: destination,
              destinationWorkerId: destination.workerId,
            }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
          eq(schema.tunnels.management, "user-managed"),
        ),
      )
      .returning();
    return rows[0] ? this.getTunnel(ownerId, rows[0].id) : null;
  }

  async deleteUserTunnel(ownerId: string, tunnelId: string): Promise<boolean> {
    const existingRows = await this.database
      .select({ management: schema.tunnels.management })
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return false;
    if (existing.management !== "user-managed") {
      throw new TunnelManagementError(
        "Managed tunnels are controlled by their owning feature.",
      );
    }
    const activeAttachments = await this.database
      .select({ id: schema.tunnelAttachments.id })
      .from(schema.tunnelAttachments)
      .where(
        and(
          eq(schema.tunnelAttachments.tunnelId, tunnelId),
          notInArray(schema.tunnelAttachments.status, ["stopped", "failed"]),
        ),
      )
      .limit(1);
    if (activeAttachments.length > 0) {
      throw new TunnelManagementError(
        "Stop every tunnel attachment before deleting this tunnel.",
      );
    }
    const rows = await this.database
      .delete(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
          eq(schema.tunnels.management, "user-managed"),
        ),
      )
      .returning({ id: schema.tunnels.id });
    return rows.length === 1;
  }

  async registerManagedTunnel(
    ownerId: string,
    input: TunnelManagedRegistration,
  ): Promise<TunnelSummary | null> {
    if (
      !(await this.tunnelReferencesAreOwned(
        ownerId,
        input.projectId,
        input.source,
        input.destination,
      ))
    ) {
      return null;
    }
    const existingRows = await this.database
      .select({ id: schema.tunnels.id })
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.ownerId, ownerId),
          eq(schema.tunnels.managedByKind, input.managedBy.kind),
          eq(schema.tunnels.managedById, input.managedBy.id),
        ),
      )
      .limit(1);
    const values = {
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      origin: input.origin,
      management: input.management,
      protocolHint: input.protocolHint,
      sourceEndpoint: input.source,
      sourceWorkerId: sourceWorkerId(input.source),
      destinationEndpoint: input.destination,
      destinationWorkerId: destinationWorkerId(input.destination),
      managedByKind: input.managedBy.kind,
      managedById: input.managedBy.id,
      desiredState: input.desiredState,
      status: input.status,
      lastError: null,
      updatedAt: new Date(),
    };
    if (existingRows[0]) {
      await this.database
        .update(schema.tunnels)
        .set(values)
        .where(eq(schema.tunnels.id, existingRows[0].id));
      return this.getTunnel(ownerId, existingRows[0].id);
    }
    const id = randomUUID();
    await this.database.insert(schema.tunnels).values({
      id,
      ownerId,
      position: await this.nextTunnelPosition(ownerId),
      ...values,
    });
    return this.getTunnel(ownerId, id);
  }

  async getManagedTunnel(
    ownerId: string,
    managedBy: NonNullable<TunnelSummary["managedBy"]>,
  ): Promise<TunnelSummary | null> {
    const rows = await this.database
      .select({ id: schema.tunnels.id })
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.ownerId, ownerId),
          ne(schema.tunnels.management, "user-managed"),
          eq(schema.tunnels.managedByKind, managedBy.kind),
          eq(schema.tunnels.managedById, managedBy.id),
        ),
      )
      .limit(1);
    return rows[0] ? this.getTunnel(ownerId, rows[0].id) : null;
  }

  async removeManagedTunnel(
    ownerId: string,
    managedBy: NonNullable<TunnelSummary["managedBy"]>,
  ): Promise<boolean> {
    const rows = await this.database
      .delete(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.ownerId, ownerId),
          ne(schema.tunnels.management, "user-managed"),
          eq(schema.tunnels.managedByKind, managedBy.kind),
          eq(schema.tunnels.managedById, managedBy.id),
        ),
      )
      .returning({ id: schema.tunnels.id });
    return rows.length === 1;
  }

  async createDesktopTunnelAttachment(
    ownerId: string,
    tunnelId: string,
    input: {
      clientId: string;
      expiresAt: Date;
      secretExpiresAt: Date;
      secretHash: string;
    },
  ): Promise<{ attachmentId: string; projectId: string | null } | null> {
    return this.database.transaction(async (transaction) => {
      const tunnels = await transaction
        .select({
          id: schema.tunnels.id,
          management: schema.tunnels.management,
          origin: schema.tunnels.origin,
          projectId: schema.tunnels.projectId,
          sourceEndpoint: schema.tunnels.sourceEndpoint,
        })
        .from(schema.tunnels)
        .where(
          and(
            eq(schema.tunnels.id, tunnelId),
            eq(schema.tunnels.ownerId, ownerId),
          ),
        )
        .limit(1);
      const tunnel = tunnels[0];
      if (
        !tunnel ||
        !(
          tunnel.management === "user-managed" ||
          (tunnel.management === "managed-ephemeral" &&
            tunnel.origin === "browser" &&
            tunnel.sourceEndpoint.kind === "desktop-loopback")
        ) ||
        tunnel.sourceEndpoint.kind !== "desktop-loopback"
      ) {
        return null;
      }
      const existing = await transaction
        .select({ id: schema.tunnelAttachments.id })
        .from(schema.tunnelAttachments)
        .where(
          and(
            eq(schema.tunnelAttachments.tunnelId, tunnelId),
            eq(schema.tunnelAttachments.clientId, input.clientId),
          ),
        )
        .limit(1);
      const now = new Date();
      const attachmentId = existing[0]?.id ?? randomUUID();
      const values = {
        activeConnectionCount: 0,
        expiresAt: input.expiresAt,
        lastError: null,
        lastSeenAt: null,
        localHost: null,
        localPort: null,
        secretExpiresAt: input.secretExpiresAt,
        secretHash: input.secretHash,
        status: "starting",
        updatedAt: now,
      } as const;
      if (existing[0]) {
        await transaction
          .update(schema.tunnelAttachments)
          .set(values)
          .where(eq(schema.tunnelAttachments.id, attachmentId));
      } else {
        await transaction.insert(schema.tunnelAttachments).values({
          id: attachmentId,
          tunnelId,
          kind: "desktop-loopback",
          clientId: input.clientId,
          ...values,
        });
      }
      await transaction
        .update(schema.tunnels)
        .set({
          desiredState: "started",
          lastError: null,
          status: "starting",
          updatedAt: now,
        })
        .where(eq(schema.tunnels.id, tunnelId));
      return { attachmentId, projectId: tunnel.projectId };
    });
  }

  async createManagedServerRelayAttachment(
    ownerId: string,
    tunnelId: string,
    attachmentId: string,
    expiresAt: Date,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const tunnels = await transaction
        .select({
          id: schema.tunnels.id,
          sourceEndpoint: schema.tunnels.sourceEndpoint,
        })
        .from(schema.tunnels)
        .where(
          and(
            eq(schema.tunnels.id, tunnelId),
            eq(schema.tunnels.ownerId, ownerId),
            ne(schema.tunnels.management, "user-managed"),
          ),
        )
        .limit(1);
      if (!tunnels[0] || tunnels[0].sourceEndpoint.kind !== "server-http") {
        return false;
      }
      const now = new Date();
      await transaction
        .insert(schema.tunnelAttachments)
        .values({
          id: attachmentId,
          tunnelId,
          kind: "server-relay",
          clientId: null,
          localHost: null,
          localPort: null,
          status: "active",
          expiresAt,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: schema.tunnelAttachments.id,
          set: {
            activeConnectionCount: 0,
            bytesFromSource: 0,
            bytesToSource: 0,
            expiresAt,
            lastError: null,
            lastSeenAt: now,
            status: "active",
            updatedAt: now,
          },
        });
      await transaction
        .update(schema.tunnels)
        .set({
          desiredState: "started",
          lastError: null,
          status: "active",
          updatedAt: now,
        })
        .where(eq(schema.tunnels.id, tunnelId));
      return true;
    });
  }

  async touchManagedServerRelay(
    ownerId: string,
    attachmentId: string,
    input: {
      activeConnectionDelta?: number;
      bytesFromSource?: number;
      bytesToSource?: number;
      expiresAt?: Date;
    } = {},
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const now = new Date();
      const connectionDelta = input.activeConnectionDelta ?? 0;
      const bytesFromSource = input.bytesFromSource ?? 0;
      const bytesToSource = input.bytesToSource ?? 0;
      const owned = await transaction
        .select({ tunnelId: schema.tunnelAttachments.tunnelId })
        .from(schema.tunnelAttachments)
        .innerJoin(
          schema.tunnels,
          eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
        )
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnelAttachments.kind, "server-relay"),
            eq(schema.tunnelAttachments.status, "active"),
            eq(schema.tunnels.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!owned[0]) return;
      await transaction
        .update(schema.tunnelAttachments)
        .set({
          activeConnectionCount: sql<number>`greatest(0, ${schema.tunnelAttachments.activeConnectionCount} + ${connectionDelta})`,
          bytesFromSource: sql<number>`${schema.tunnelAttachments.bytesFromSource} + ${bytesFromSource}`,
          bytesToSource: sql<number>`${schema.tunnelAttachments.bytesToSource} + ${bytesToSource}`,
          expiresAt: input.expiresAt,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnelAttachments.tunnelId, owned[0].tunnelId),
            eq(schema.tunnelAttachments.kind, "server-relay"),
            eq(schema.tunnelAttachments.status, "active"),
          ),
        );
      await transaction
        .update(schema.tunnels)
        .set({
          activeConnectionCount: sql<number>`greatest(0, ${schema.tunnels.activeConnectionCount} + ${connectionDelta})`,
          bytesFromSource: sql<number>`${schema.tunnels.bytesFromSource} + ${bytesFromSource}`,
          bytesToSource: sql<number>`${schema.tunnels.bytesToSource} + ${bytesToSource}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tunnels.id, owned[0].tunnelId),
            eq(schema.tunnels.ownerId, ownerId),
          ),
        );
    });
  }

  async removeManagedServerRelayAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<{
    projectId: string | null;
    tunnelId: string;
    tunnelRemoved: boolean;
  } | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          activeConnectionCount: schema.tunnelAttachments.activeConnectionCount,
          management: schema.tunnels.management,
          projectId: schema.tunnels.projectId,
          tunnelId: schema.tunnels.id,
        })
        .from(schema.tunnelAttachments)
        .innerJoin(
          schema.tunnels,
          eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
        )
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnelAttachments.kind, "server-relay"),
            eq(schema.tunnels.ownerId, ownerId),
            ne(schema.tunnels.management, "user-managed"),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      await transaction
        .delete(schema.tunnelAttachments)
        .where(eq(schema.tunnelAttachments.id, attachmentId));
      const remaining = await transaction
        .select({ id: schema.tunnelAttachments.id })
        .from(schema.tunnelAttachments)
        .where(eq(schema.tunnelAttachments.tunnelId, row.tunnelId))
        .limit(1);
      const tunnelRemoved =
        remaining.length === 0 && row.management === "managed-ephemeral";
      if (tunnelRemoved) {
        await transaction
          .delete(schema.tunnels)
          .where(
            and(
              eq(schema.tunnels.id, row.tunnelId),
              eq(schema.tunnels.ownerId, ownerId),
            ),
          );
      } else {
        await transaction
          .update(schema.tunnels)
          .set({
            activeConnectionCount: sql<number>`greatest(0, ${schema.tunnels.activeConnectionCount} - ${row.activeConnectionCount})`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.tunnels.id, row.tunnelId),
              eq(schema.tunnels.ownerId, ownerId),
            ),
          );
      }
      return {
        projectId: row.projectId,
        tunnelId: row.tunnelId,
        tunnelRemoved,
      };
    });
  }

  async authorizeDesktopTunnelAttachment(
    attachmentId: string,
    secretHash: string,
  ): Promise<TunnelAttachmentAuthorization | null> {
    const now = new Date();
    const rows = await this.database
      .select({ attachment: schema.tunnelAttachments, tunnel: schema.tunnels })
      .from(schema.tunnelAttachments)
      .innerJoin(
        schema.tunnels,
        eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
      )
      .where(
        and(
          eq(schema.tunnelAttachments.id, attachmentId),
          eq(schema.tunnelAttachments.kind, "desktop-loopback"),
          eq(schema.tunnelAttachments.secretHash, secretHash),
          gt(schema.tunnelAttachments.secretExpiresAt, now),
          gt(schema.tunnelAttachments.expiresAt, now),
          ne(schema.tunnelAttachments.status, "stopped"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (
      !row?.attachment.clientId ||
      row.tunnel.sourceEndpoint.kind !== "desktop-loopback" ||
      row.tunnel.destinationEndpoint.kind !== "worker-tcp"
    ) {
      return null;
    }
    return {
      attachmentId,
      clientId: row.attachment.clientId,
      destination: row.tunnel.destinationEndpoint,
      expiresAt: row.attachment.expiresAt!,
      ownerId: row.tunnel.ownerId,
      projectId: row.tunnel.projectId,
      tunnelId: row.tunnel.id,
    };
  }

  async getDesktopTunnelAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<TunnelAttachmentAuthorization | null> {
    const now = new Date();
    const rows = await this.database
      .select({ attachment: schema.tunnelAttachments, tunnel: schema.tunnels })
      .from(schema.tunnelAttachments)
      .innerJoin(
        schema.tunnels,
        eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
      )
      .where(
        and(
          eq(schema.tunnelAttachments.id, attachmentId),
          eq(schema.tunnelAttachments.kind, "desktop-loopback"),
          eq(schema.tunnels.ownerId, ownerId),
          gt(schema.tunnelAttachments.expiresAt, now),
          ne(schema.tunnelAttachments.status, "stopped"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (
      !row?.attachment.clientId ||
      !row.attachment.expiresAt ||
      row.tunnel.sourceEndpoint.kind !== "desktop-loopback" ||
      row.tunnel.destinationEndpoint.kind !== "worker-tcp"
    ) {
      return null;
    }
    return {
      attachmentId,
      clientId: row.attachment.clientId,
      destination: row.tunnel.destinationEndpoint,
      expiresAt: row.attachment.expiresAt,
      ownerId: row.tunnel.ownerId,
      projectId: row.tunnel.projectId,
      tunnelId: row.tunnel.id,
    };
  }

  async activateDesktopTunnelAttachment(
    attachmentId: string,
    clientId: string,
    localPort: number,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      const attachments = await transaction
        .update(schema.tunnelAttachments)
        .set({
          lastError: null,
          lastSeenAt: now,
          localHost: "127.0.0.1",
          localPort,
          status: "active",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnelAttachments.clientId, clientId),
            ne(schema.tunnelAttachments.status, "stopped"),
            gt(schema.tunnelAttachments.expiresAt, now),
          ),
        )
        .returning({ tunnelId: schema.tunnelAttachments.tunnelId });
      if (!attachments[0]) return false;
      await transaction
        .update(schema.tunnels)
        .set({
          desiredState: "started",
          lastError: null,
          status: "active",
          updatedAt: now,
        })
        .where(eq(schema.tunnels.id, attachments[0].tunnelId));
      return true;
    });
  }

  async touchDesktopTunnelAttachment(attachmentId: string): Promise<void> {
    await this.database
      .update(schema.tunnelAttachments)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.tunnelAttachments.id, attachmentId),
          eq(schema.tunnelAttachments.status, "active"),
        ),
      );
  }

  async markDesktopTunnelAttachmentOffline(
    attachmentId: string,
  ): Promise<void> {
    const now = new Date();
    const rows = await this.database
      .update(schema.tunnelAttachments)
      .set({
        activeConnectionCount: 0,
        lastError: "Desktop client disconnected.",
        status: "offline",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.tunnelAttachments.id, attachmentId),
          ne(schema.tunnelAttachments.status, "stopped"),
          gt(schema.tunnelAttachments.expiresAt, now),
        ),
      )
      .returning({ tunnelId: schema.tunnelAttachments.tunnelId });
    if (!rows[0]) return;
    await this.database
      .update(schema.tunnels)
      .set({
        activeConnectionCount: 0,
        lastError: "Desktop client disconnected.",
        status: "offline",
        updatedAt: now,
      })
      .where(eq(schema.tunnels.id, rows[0].tunnelId));
  }

  async stopDesktopTunnelAttachment(
    ownerId: string,
    attachmentId: string,
    error: string | null = null,
  ): Promise<{ projectId: string | null; tunnelId: string } | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          projectId: schema.tunnels.projectId,
          tunnelId: schema.tunnels.id,
        })
        .from(schema.tunnelAttachments)
        .innerJoin(
          schema.tunnels,
          eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
        )
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnels.ownerId, ownerId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const now = new Date();
      await transaction
        .update(schema.tunnelAttachments)
        .set({
          activeConnectionCount: 0,
          lastError: error,
          secretExpiresAt: null,
          secretHash: null,
          status: error ? "failed" : "stopped",
          updatedAt: now,
        })
        .where(eq(schema.tunnelAttachments.id, attachmentId));
      const remaining = await transaction
        .select({ id: schema.tunnelAttachments.id })
        .from(schema.tunnelAttachments)
        .where(
          and(
            eq(schema.tunnelAttachments.tunnelId, row.tunnelId),
            ne(schema.tunnelAttachments.id, attachmentId),
            notInArray(schema.tunnelAttachments.status, ["stopped", "failed"]),
          ),
        )
        .limit(1);
      if (remaining.length === 0) {
        await transaction
          .update(schema.tunnels)
          .set({
            activeConnectionCount: 0,
            desiredState: "stopped",
            lastError: error,
            status: error ? "failed" : "stopped",
            updatedAt: now,
          })
          .where(eq(schema.tunnels.id, row.tunnelId));
      }
      return row;
    });
  }

  async resetTransientTunnelAttachments(): Promise<void> {
    const now = new Date();
    await this.database
      .update(schema.tunnelAttachments)
      .set({
        activeConnectionCount: 0,
        lastError: "The server restarted.",
        secretExpiresAt: null,
        secretHash: null,
        status: "offline",
        updatedAt: now,
      })
      .where(
        inArray(schema.tunnelAttachments.status, [
          "starting",
          "active",
          "degraded",
          "stopping",
        ]),
      );
    await this.database
      .update(schema.tunnels)
      .set({
        activeConnectionCount: 0,
        lastError: "The server restarted.",
        status: "offline",
        updatedAt: now,
      })
      .where(
        inArray(schema.tunnels.status, [
          "starting",
          "active",
          "degraded",
          "stopping",
        ]),
      );
    await this.database
      .delete(schema.tunnels)
      .where(
        and(
          inArray(schema.tunnels.origin, ["code", "project-share"]),
          eq(schema.tunnels.management, "managed-ephemeral"),
        ),
      );
  }

  async expireDesktopTunnelAttachments(now = new Date()): Promise<
    Array<{
      attachmentId: string;
      ownerId: string;
      projectId: string | null;
      tunnelId: string;
    }>
  > {
    const expired = await this.database
      .select({
        attachmentId: schema.tunnelAttachments.id,
        ownerId: schema.tunnels.ownerId,
        projectId: schema.tunnels.projectId,
        tunnelId: schema.tunnels.id,
      })
      .from(schema.tunnelAttachments)
      .innerJoin(
        schema.tunnels,
        eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
      )
      .where(
        and(
          lte(schema.tunnelAttachments.expiresAt, now),
          notInArray(schema.tunnelAttachments.status, ["stopped", "failed"]),
        ),
      );
    const stopped = [] as typeof expired;
    for (const attachment of expired) {
      if (
        await this.stopDesktopTunnelAttachment(
          attachment.ownerId,
          attachment.attachmentId,
          "Tunnel attachment expired.",
        )
      ) {
        stopped.push(attachment);
      }
    }
    return stopped;
  }

  private async projectReplicasByProject(
    ownerId: string,
    projectIds: string[],
  ): Promise<Map<string, ProjectReplicaSummary[]>> {
    const replicasByProject = new Map<string, ProjectReplicaSummary[]>();
    for (const projectId of projectIds) replicasByProject.set(projectId, []);
    if (projectIds.length === 0) return replicasByProject;

    const sourceRows = await this.database
      .select({ source: schema.projectSources, worker: schema.workers })
      .from(schema.projectSources)
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.projectSources.projectId),
      )
      .innerJoin(
        schema.workers,
        eq(schema.workers.id, schema.projectSources.workerId),
      )
      .where(
        and(
          eq(schema.projects.ownerId, ownerId),
          inArray(schema.projectSources.projectId, projectIds),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(
        asc(schema.projectSources.createdAt),
        asc(schema.projectSources.id),
      );
    if (sourceRows.length === 0) return replicasByProject;

    const sourceIds = sourceRows.map(({ source }) => source.id);
    const worktrees = await this.database
      .select()
      .from(schema.projectWorktrees)
      .where(inArray(schema.projectWorktrees.projectSourceId, sourceIds))
      .orderBy(
        desc(schema.projectWorktrees.isPrimary),
        asc(schema.projectWorktrees.createdAt),
      );
    const worktreesBySource = new Map<string, ProjectWorktreeRow[]>();
    for (const worktree of worktrees) {
      const entries = worktreesBySource.get(worktree.projectSourceId) ?? [];
      entries.push(worktree);
      worktreesBySource.set(worktree.projectSourceId, entries);
    }
    for (const { source, worker } of sourceRows) {
      const replicas = replicasByProject.get(source.projectId);
      if (!replicas) continue;
      replicas.push(
        toProjectReplicaSummary(
          source,
          worker,
          worktreesBySource.get(source.id) ?? [],
        ),
      );
    }
    for (const replicas of replicasByProject.values()) {
      replicas.sort(
        (left, right) =>
          Number(right.ready) - Number(left.ready) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    }
    return replicasByProject;
  }

  async listProjects(ownerId: string): Promise<ProjectSummary[]> {
    const projects = await this.database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, ownerId))
      .orderBy(asc(schema.projects.position), asc(schema.projects.createdAt));
    const replicasByProject = await this.projectReplicasByProject(
      ownerId,
      projects.map(({ id }) => id),
    );
    return projects.map((project) =>
      toProjectSummary(project, replicasByProject.get(project.id) ?? []),
    );
  }

  async getProject(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectSummary | null> {
    const projects = await this.database
      .select()
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const project = projects[0];
    if (!project) return null;
    return toProjectSummary(
      project,
      (await this.listProjectReplicas(ownerId, projectId)) ?? [],
    );
  }

  async listMcpServers(
    ownerId: string,
    projectId: string | null,
  ): Promise<McpServerSummary[] | null> {
    if (projectId) {
      const project = await this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!project[0]) return null;
    }
    const rows = await this.database
      .select()
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.ownerId, ownerId),
          projectId
            ? eq(schema.mcpServers.projectId, projectId)
            : isNull(schema.mcpServers.projectId),
        ),
      )
      .orderBy(asc(schema.mcpServers.name), asc(schema.mcpServers.createdAt));
    return rows
      .filter((row) => !isManagedCodeGraphMcpName(row.name))
      .map((row) => toMcpServerSummary(row, this.secretVault));
  }

  async listEffectiveMcpServers(
    ownerId: string,
    projectId: string | null,
  ): Promise<McpServerConfiguration[]> {
    const rows = await this.database
      .select()
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.ownerId, ownerId),
          or(
            isNull(schema.mcpServers.projectId),
            ...(projectId ? [eq(schema.mcpServers.projectId, projectId)] : []),
          ),
        ),
      )
      .orderBy(asc(schema.mcpServers.name), asc(schema.mcpServers.createdAt));
    const effective = new Map<string, McpServerRow>();
    for (const row of rows) {
      if (isManagedCodeGraphMcpName(row.name)) continue;
      const current = effective.get(row.name);
      if (!current || (projectId && row.projectId === projectId)) {
        effective.set(row.name, row);
      }
    }
    return [...effective.values()].map((row) =>
      toMcpServerRuntimeConfiguration(row, this.secretVault),
    );
  }

  async createMcpServer(
    ownerId: string,
    projectId: string | null,
    input: McpServerConfiguration,
  ): Promise<McpServerSummary | null> {
    assertUserManagedMcpServerName(input.name);
    if (projectId) {
      const project = await this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!project[0]) return null;
    }
    const id = randomUUID();
    const rows = await this.database
      .insert(schema.mcpServers)
      .values({
        id,
        ownerId,
        projectId,
        ...mcpServerValues(input, ownerId, id, this.secretVault),
      })
      .returning();
    return toMcpServerSummary(
      firstOrThrow(rows, "creating an MCP server"),
      this.secretVault,
    );
  }

  async updateMcpServer(
    ownerId: string,
    projectId: string | null,
    serverId: string,
    input: McpServerConfiguration,
  ): Promise<McpServerSummary | null> {
    assertUserManagedMcpServerName(input.name);
    const existingRows = await this.database
      .select()
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.id, serverId),
          eq(schema.mcpServers.ownerId, ownerId),
          projectId
            ? eq(schema.mcpServers.projectId, projectId)
            : isNull(schema.mcpServers.projectId),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return null;
    assertUserManagedMcpServerName(existing.name);
    const rows = await this.database
      .update(schema.mcpServers)
      .set({
        ...mcpServerValues(
          input,
          ownerId,
          serverId,
          this.secretVault,
          existing,
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.mcpServers.id, serverId),
          eq(schema.mcpServers.ownerId, ownerId),
          projectId
            ? eq(schema.mcpServers.projectId, projectId)
            : isNull(schema.mcpServers.projectId),
        ),
      )
      .returning();
    return rows[0] ? toMcpServerSummary(rows[0], this.secretVault) : null;
  }

  async deleteMcpServer(
    ownerId: string,
    projectId: string | null,
    serverId: string,
  ): Promise<boolean> {
    const existingRows = await this.database
      .select({ name: schema.mcpServers.name })
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.id, serverId),
          eq(schema.mcpServers.ownerId, ownerId),
          projectId
            ? eq(schema.mcpServers.projectId, projectId)
            : isNull(schema.mcpServers.projectId),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return false;
    assertUserManagedMcpServerName(existing.name);
    const rows = await this.database
      .delete(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.id, serverId),
          eq(schema.mcpServers.ownerId, ownerId),
          projectId
            ? eq(schema.mcpServers.projectId, projectId)
            : isNull(schema.mcpServers.projectId),
        ),
      )
      .returning({ id: schema.mcpServers.id });
    return rows.length > 0;
  }

  async copyProjectMcpServer(
    ownerId: string,
    targetProjectId: string,
    sourceProjectId: string,
    sourceServerId: string,
  ): Promise<McpServerSummary | null> {
    const [target, source] = await Promise.all([
      this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, targetProjectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1),
      this.database
        .select({ server: schema.mcpServers })
        .from(schema.mcpServers)
        .innerJoin(
          schema.projects,
          eq(schema.projects.id, schema.mcpServers.projectId),
        )
        .where(
          and(
            eq(schema.mcpServers.id, sourceServerId),
            eq(schema.mcpServers.projectId, sourceProjectId),
            eq(schema.mcpServers.ownerId, ownerId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1),
    ]);
    if (!target[0] || !source[0]) return null;
    assertUserManagedMcpServerName(source[0].server.name);
    const configuration = toMcpServerRuntimeConfiguration(
      source[0].server,
      this.secretVault,
    );
    return this.createMcpServer(ownerId, targetProjectId, configuration);
  }

  async ensureDefaultProjectWorkspace(
    ownerId: string,
  ): Promise<ProjectWorkspaceRow> {
    const defaultId = `workspace:default:${ownerId}`;
    let rows = await this.database
      .select()
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.ownerId, ownerId),
          eq(schema.projectWorkspaces.isDefault, true),
        ),
      )
      .limit(1);
    if (rows[0]) return rows[0];
    const profiles = await this.database
      .select({
        activeMasterKeyRevision:
          schema.accountEncryptionProfiles.activeMasterKeyRevision,
      })
      .from(schema.accountEncryptionProfiles)
      .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
      .limit(1);
    if (profiles[0]) {
      throw new ProjectWorkspaceInvariantError(
        "An initialized encryption profile cannot create a plaintext default workspace.",
      );
    }
    await this.database
      .insert(schema.projectWorkspaces)
      .values({
        id: defaultId,
        ownerId,
        name: "Default",
        position: 0,
        isDefault: true,
      })
      .onConflictDoNothing();
    rows = await this.database
      .select()
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.ownerId, ownerId),
          eq(schema.projectWorkspaces.isDefault, true),
        ),
      )
      .limit(1);
    return firstOrThrow(rows, "ensuring the default workspace");
  }

  async listProjectWorkspaces(
    ownerId: string,
  ): Promise<ProjectWorkspaceSummary[]> {
    await this.ensureDefaultProjectWorkspace(ownerId);
    const [workspaces, memberships] = await Promise.all([
      this.database
        .select()
        .from(schema.projectWorkspaces)
        .where(eq(schema.projectWorkspaces.ownerId, ownerId))
        .orderBy(
          asc(schema.projectWorkspaces.position),
          asc(schema.projectWorkspaces.createdAt),
        ),
      this.database
        .select({
          workspaceId: schema.projectWorkspaceMemberships.workspaceId,
          projectId: schema.projectWorkspaceMemberships.projectId,
        })
        .from(schema.projectWorkspaceMemberships)
        .innerJoin(
          schema.projectWorkspaces,
          eq(
            schema.projectWorkspaces.id,
            schema.projectWorkspaceMemberships.workspaceId,
          ),
        )
        .where(eq(schema.projectWorkspaces.ownerId, ownerId)),
    ]);
    const projectIds = new Map<string, string[]>();
    for (const membership of memberships) {
      const current = projectIds.get(membership.workspaceId) ?? [];
      current.push(membership.projectId);
      projectIds.set(membership.workspaceId, current);
    }
    return workspaces.map((workspace) =>
      toProjectWorkspaceSummary(workspace, projectIds.get(workspace.id) ?? []),
    );
  }

  async listProjectWorkspaceWire(
    ownerId: string,
  ): Promise<ProjectWorkspaceWireList> {
    await this.ensureDefaultProjectWorkspace(ownerId);
    const [workspaces, memberships] = await Promise.all([
      this.database
        .select()
        .from(schema.projectWorkspaces)
        .where(eq(schema.projectWorkspaces.ownerId, ownerId))
        .orderBy(
          asc(schema.projectWorkspaces.position),
          asc(schema.projectWorkspaces.createdAt),
        ),
      this.database
        .select({
          workspaceId: schema.projectWorkspaceMemberships.workspaceId,
          projectId: schema.projectWorkspaceMemberships.projectId,
        })
        .from(schema.projectWorkspaceMemberships)
        .innerJoin(
          schema.projectWorkspaces,
          eq(
            schema.projectWorkspaces.id,
            schema.projectWorkspaceMemberships.workspaceId,
          ),
        )
        .where(eq(schema.projectWorkspaces.ownerId, ownerId)),
    ]);
    const projectIds = new Map<string, string[]>();
    for (const membership of memberships) {
      const current = projectIds.get(membership.workspaceId) ?? [];
      current.push(membership.projectId);
      projectIds.set(membership.workspaceId, current);
    }
    const summaries = workspaces.map((workspace) =>
      toProjectWorkspaceWireSummary(
        workspace,
        projectIds.get(workspace.id) ?? [],
      ),
    );
    return {
      workspaces: summaries,
      legacyCount: summaries.filter(
        ({ nameProtection }) => nameProtection.state === "legacy",
      ).length,
    };
  }

  async createEncryptedProjectWorkspace(
    ownerId: string,
    input: EncryptedProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceWireSummary> {
    await this.ensureDefaultProjectWorkspace(ownerId);
    const profiles = await this.database
      .select({
        activeMasterKeyRevision:
          schema.accountEncryptionProfiles.activeMasterKeyRevision,
      })
      .from(schema.accountEncryptionProfiles)
      .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
      .limit(1);
    if (!profiles[0]) {
      throw new ProjectWorkspaceInvariantError(
        "Workspace encryption must be initialized before creating a workspace.",
      );
    }
    if (
      input.nameProtection.keyRevision !== profiles[0].activeMasterKeyRevision
    ) {
      throw new ProjectWorkspaceInvariantError(
        "Workspace encryption key revision is not active.",
      );
    }
    const last = await this.database
      .select({ position: schema.projectWorkspaces.position })
      .from(schema.projectWorkspaces)
      .where(eq(schema.projectWorkspaces.ownerId, ownerId))
      .orderBy(desc(schema.projectWorkspaces.position))
      .limit(1);
    const rows = await this.database
      .insert(schema.projectWorkspaces)
      .values({
        id: input.id,
        ownerId,
        name: null,
        nameEnvelope: input.nameProtection.envelope,
        nameBlindIndex: input.nameProtection.blindIndex,
        nameFormatVersion: input.nameProtection.formatVersion,
        nameKeyRevision: input.nameProtection.keyRevision,
        position: (last[0]?.position ?? -1) + 1,
        isDefault: false,
      })
      .returning();
    return toProjectWorkspaceWireSummary(
      firstOrThrow(rows, "creating an encrypted project workspace"),
      [],
    );
  }

  async createProjectWorkspace(
    ownerId: string,
    input: ProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceSummary> {
    await this.ensureDefaultProjectWorkspace(ownerId);
    const profiles = await this.database
      .select({ ownerId: schema.accountEncryptionProfiles.ownerId })
      .from(schema.accountEncryptionProfiles)
      .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
      .limit(1);
    if (profiles[0]) {
      throw new ProjectWorkspaceInvariantError(
        "Initialized accounts cannot write plaintext workspace names.",
      );
    }
    const last = await this.database
      .select({ position: schema.projectWorkspaces.position })
      .from(schema.projectWorkspaces)
      .where(eq(schema.projectWorkspaces.ownerId, ownerId))
      .orderBy(desc(schema.projectWorkspaces.position))
      .limit(1);
    const rows = await this.database
      .insert(schema.projectWorkspaces)
      .values({
        id: randomUUID(),
        ownerId,
        name: input.name,
        position: (last[0]?.position ?? -1) + 1,
        isDefault: false,
      })
      .returning();
    return toProjectWorkspaceSummary(
      firstOrThrow(rows, "creating a project workspace"),
      [],
    );
  }

  async updateProjectWorkspace(
    ownerId: string,
    workspaceId: string,
    input: ProjectWorkspaceUpdate,
  ): Promise<ProjectWorkspaceSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.id, workspaceId),
          eq(schema.projectWorkspaces.ownerId, ownerId),
        ),
      )
      .limit(1);
    const workspace = rows[0];
    if (!workspace) return null;
    if (input.name !== undefined) {
      const profiles = await this.database
        .select({ ownerId: schema.accountEncryptionProfiles.ownerId })
        .from(schema.accountEncryptionProfiles)
        .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
        .limit(1);
      if (profiles[0]) {
        throw new ProjectWorkspaceInvariantError(
          "Initialized accounts cannot write plaintext workspace names.",
        );
      }
    }
    const projectIds = input.projectIds
      ? [...new Set(input.projectIds)]
      : undefined;
    if (projectIds) {
      const ownedProjects = projectIds.length
        ? await this.database
            .select({ id: schema.projects.id })
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.ownerId, ownerId),
                inArray(schema.projects.id, projectIds),
              ),
            )
        : [];
      if (ownedProjects.length !== projectIds.length) {
        throw new ProjectWorkspaceInvariantError(
          "Workspace membership contained an unknown project.",
        );
      }
    }
    await this.database.transaction(async (transaction) => {
      const updatedAt = new Date();
      if (input.isDefault) {
        await transaction
          .update(schema.projectWorkspaces)
          .set({ isDefault: false, updatedAt })
          .where(
            and(
              eq(schema.projectWorkspaces.ownerId, ownerId),
              eq(schema.projectWorkspaces.isDefault, true),
            ),
          );
      }
      await transaction
        .update(schema.projectWorkspaces)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.isDefault ? { isDefault: true } : {}),
          revision: sql`${schema.projectWorkspaces.revision} + 1`,
          updatedAt,
        })
        .where(
          and(
            eq(schema.projectWorkspaces.id, workspaceId),
            eq(schema.projectWorkspaces.ownerId, ownerId),
          ),
        );
      if (projectIds !== undefined) {
        await transaction
          .delete(schema.projectWorkspaceMemberships)
          .where(
            eq(schema.projectWorkspaceMemberships.workspaceId, workspaceId),
          );
        if (projectIds.length) {
          await transaction
            .insert(schema.projectWorkspaceMemberships)
            .values(
              projectIds.map((projectId) => ({ workspaceId, projectId })),
            );
        }
      }
    });
    return (await this.listProjectWorkspaces(ownerId)).find(
      ({ id }) => id === workspaceId,
    )!;
  }

  async updateEncryptedProjectWorkspace(
    ownerId: string,
    workspaceId: string,
    input: EncryptedProjectWorkspaceUpdate,
  ): Promise<ProjectWorkspaceWireSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.id, workspaceId),
          eq(schema.projectWorkspaces.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!rows[0]) return null;
    if (input.nameProtection) {
      const profiles = await this.database
        .select({
          activeMasterKeyRevision:
            schema.accountEncryptionProfiles.activeMasterKeyRevision,
        })
        .from(schema.accountEncryptionProfiles)
        .where(eq(schema.accountEncryptionProfiles.ownerId, ownerId))
        .limit(1);
      if (
        !profiles[0] ||
        input.nameProtection.keyRevision !== profiles[0].activeMasterKeyRevision
      ) {
        throw new ProjectWorkspaceInvariantError(
          "Workspace encryption key revision is not active.",
        );
      }
    }
    const projectIds = input.projectIds
      ? [...new Set(input.projectIds)]
      : undefined;
    if (projectIds) {
      const ownedProjects = projectIds.length
        ? await this.database
            .select({ id: schema.projects.id })
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.ownerId, ownerId),
                inArray(schema.projects.id, projectIds),
              ),
            )
        : [];
      if (ownedProjects.length !== projectIds.length) {
        throw new ProjectWorkspaceInvariantError(
          "Workspace membership contained an unknown project.",
        );
      }
    }
    await this.database.transaction(async (transaction) => {
      const updatedAt = new Date();
      if (input.isDefault) {
        await transaction
          .update(schema.projectWorkspaces)
          .set({
            isDefault: false,
            revision: sql`${schema.projectWorkspaces.revision} + 1`,
            updatedAt,
          })
          .where(
            and(
              eq(schema.projectWorkspaces.ownerId, ownerId),
              eq(schema.projectWorkspaces.isDefault, true),
              sql`${schema.projectWorkspaces.id} <> ${workspaceId}`,
            ),
          );
      }
      const updated = await transaction
        .update(schema.projectWorkspaces)
        .set({
          ...(input.nameProtection
            ? {
                name: null,
                nameEnvelope: input.nameProtection.envelope,
                nameBlindIndex: input.nameProtection.blindIndex,
                nameFormatVersion: input.nameProtection.formatVersion,
                nameKeyRevision: input.nameProtection.keyRevision,
              }
            : {}),
          ...(input.isDefault ? { isDefault: true } : {}),
          revision: sql`${schema.projectWorkspaces.revision} + 1`,
          updatedAt,
        })
        .where(
          and(
            eq(schema.projectWorkspaces.id, workspaceId),
            eq(schema.projectWorkspaces.ownerId, ownerId),
            eq(schema.projectWorkspaces.revision, input.expectedRevision),
          ),
        )
        .returning({ id: schema.projectWorkspaces.id });
      if (!updated[0]) {
        throw new ProjectWorkspaceInvariantError(
          "Workspace revision changed before the update could be saved.",
        );
      }
      if (projectIds !== undefined) {
        await transaction
          .delete(schema.projectWorkspaceMemberships)
          .where(
            eq(schema.projectWorkspaceMemberships.workspaceId, workspaceId),
          );
        if (projectIds.length) {
          await transaction
            .insert(schema.projectWorkspaceMemberships)
            .values(
              projectIds.map((projectId) => ({ workspaceId, projectId })),
            );
        }
      }
    });
    return (await this.listProjectWorkspaceWire(ownerId)).workspaces.find(
      ({ id }) => id === workspaceId,
    )!;
  }

  async deleteProjectWorkspace(
    ownerId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ isDefault: schema.projectWorkspaces.isDefault })
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.id, workspaceId),
          eq(schema.projectWorkspaces.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!rows[0]) return false;
    if (rows[0].isDefault) {
      throw new ProjectWorkspaceInvariantError(
        "The Default workspace cannot be deleted.",
      );
    }
    await this.database
      .delete(schema.projectWorkspaces)
      .where(eq(schema.projectWorkspaces.id, workspaceId));
    return true;
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
    return toProjectSummary(
      rows[0],
      (await this.listProjectReplicas(ownerId, projectId)) ?? [],
    );
  }

  async updateProjectPreferredWorker(
    ownerId: string,
    projectId: string,
    workerId: string | null,
  ): Promise<ProjectSummary | null> {
    if (workerId && !(await this.getWorker(ownerId, workerId))) {
      return null;
    }
    const rows = await this.database
      .update(schema.projects)
      .set({ preferredWorkerId: workerId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .returning();
    if (!rows[0]) return null;
    return toProjectSummary(
      rows[0],
      (await this.listProjectReplicas(ownerId, projectId)) ?? [],
    );
  }

  async listProjectReplicas(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectReplicaSummary[] | null> {
    const ownedProjects = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!ownedProjects[0]) return null;
    return (
      (await this.projectReplicasByProject(ownerId, [projectId])).get(
        projectId,
      ) ?? []
    );
  }

  async getProjectReplica(
    ownerId: string,
    projectId: string,
    projectReplicaId: string,
  ): Promise<ProjectReplicaSummary | null> {
    const replicas = await this.listProjectReplicas(ownerId, projectId);
    return replicas?.find((replica) => replica.id === projectReplicaId) ?? null;
  }

  async getProjectSource(ownerId: string, projectId: string) {
    const rows = await this.database
      .select({
        projectReplicaId: schema.projectSources.id,
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
          isNull(schema.projectSources.removedAt),
          eq(schema.projectWorktrees.lifecycleState, "ready"),
        ),
      )
      .orderBy(
        desc(sql<boolean>`${schema.projectWorktrees.lifecycleState} = 'ready'`),
        asc(schema.projectSources.createdAt),
        asc(schema.projectSources.id),
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
          isNull(schema.projectSources.removedAt),
          eq(schema.projectWorktrees.lifecycleState, "ready"),
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

  async resolveProjectExecutionPlacement(
    ownerId: string,
    projectId: string,
    surfaceKind: ExecutionSurfaceKind,
    target?: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowOfflineExplicit = false,
  ): Promise<ExecutionPlacementResolution> {
    const projectRows = await this.database
      .select({
        id: schema.projects.id,
        originKind: schema.projects.originKind,
        preferredWorkerId: schema.projects.preferredWorkerId,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const project = projectRows[0];
    if (!project) {
      throw new ExecutionPlacementUnavailableError(
        "project-not-found",
        "Project not found.",
      );
    }
    if (target && target.projectId !== projectId) {
      throw new ExecutionPlacementUnavailableError(
        "target-mismatch",
        "The execution target belongs to a different project.",
      );
    }
    if (target?.kind === "surface") {
      throw new ExecutionPlacementUnavailableError(
        "target-mismatch",
        "A new surface cannot use an existing surface as its placement target.",
      );
    }

    const [settingsRows, workers, replicaRows] = await Promise.all([
      this.database
        .select({ defaultWorkerId: schema.userSettings.defaultWorkerId })
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, ownerId))
        .limit(1),
      this.database
        .select()
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .orderBy(asc(schema.workers.id)),
      this.database
        .select({
          source: schema.projectSources,
          worktree: schema.projectWorktrees,
        })
        .from(schema.projectSources)
        .leftJoin(
          schema.projectWorktrees,
          eq(schema.projectWorktrees.projectSourceId, schema.projectSources.id),
        )
        .where(
          and(
            eq(schema.projectSources.projectId, projectId),
            isNull(schema.projectSources.removedAt),
          ),
        ),
    ]);
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const folderProject = project.originKind === "managed-folder";
    const owningWorkerId = folderProject
      ? (project.preferredWorkerId ??
        replicaRows.find(({ source }) => source.sourceKind === "folder")?.source
          .workerId ??
        null)
      : null;
    const requiresExecutionRoot =
      folderProject ||
      surfaceKind === "chat" ||
      surfaceKind === "terminal" ||
      surfaceKind === "explorer" ||
      surfaceKind === "code";
    const workerSupportsSurface = (worker: WorkerRow): boolean => {
      if (surfaceKind === "code") return worker.codeCapabilities.available;
      if (surfaceKind === "browser") {
        return worker.remoteSurfaceCapabilities.browser;
      }
      if (surfaceKind === "remote-desktop") {
        return worker.remoteSurfaceCapabilities.desktop;
      }
      return true;
    };
    const sourceForWorker = (workerId: string) =>
      replicaRows.find(({ source }) => source.workerId === workerId)?.source ??
      null;
    const readyWorktreesForSource = (sourceId: string) =>
      replicaRows
        .flatMap(({ source, worktree }) =>
          source.id === sourceId &&
          worktree &&
          worktree.workerId === source.workerId &&
          worktree.lifecycleState === "ready"
            ? [worktree]
            : [],
        )
        .sort(
          (left, right) =>
            Number(right.isDefault) - Number(left.isDefault) ||
            Number(right.isPrimary) - Number(left.isPrimary) ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        );

    const placementForWorker = (
      workerId: string,
      selection: ExecutionPlacementResolution["selection"],
      explicitSourceId?: string,
      explicitWorktreeId?: string,
      strict = false,
    ): ExecutionPlacementResolution | null => {
      if (owningWorkerId !== null && workerId !== owningWorkerId) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "target-mismatch",
          "This worker-managed folder is bound to its owning worker.",
        );
      }
      const worker = workerById.get(workerId);
      if (!worker) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected worker is not linked to this account.",
        );
      }
      const offlineAllowed = strict && allowOfflineExplicit;
      if (
        !offlineAllowed &&
        Date.now() - worker.lastSeenAt.getTime() > WORKER_ONLINE_WINDOW_MS
      ) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "worker-offline",
          `Worker ${worker.displayName ?? worker.name} is offline.`,
        );
      }
      if (
        !offlineAllowed &&
        isWorkerConnected &&
        !isWorkerConnected(worker.id)
      ) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "worker-offline",
          `Worker ${worker.displayName ?? worker.name} is offline.`,
        );
      }
      if (!workerSupportsSurface(worker)) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "capability-unavailable",
          `Worker ${worker.displayName ?? worker.name} does not support ${surfaceKind}.`,
        );
      }
      const source = explicitSourceId
        ? (replicaRows.find(({ source }) => source.id === explicitSourceId)
            ?.source ?? null)
        : sourceForWorker(workerId);
      if (explicitSourceId && (!source || source.workerId !== workerId)) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected replica is not active on this worker.",
        );
      }
      if (!requiresExecutionRoot) {
        return {
          placement: {
            projectId,
            workerId,
            projectReplicaId: explicitSourceId ?? null,
            worktreeId: explicitWorktreeId ?? null,
            surface: null,
          },
          selection,
        };
      }
      if (!source) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "replica-unavailable",
          folderProject
            ? "The worker-managed folder has not finished preparing its execution root."
            : "The selected worker does not have an active project replica.",
        );
      }
      const worktrees = readyWorktreesForSource(source.id);
      const worktree = explicitWorktreeId
        ? worktrees.find(({ id }) => id === explicitWorktreeId)
        : worktrees[0];
      if (!worktree) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "worktree-unavailable",
          folderProject
            ? "The worker-managed folder execution root is not ready."
            : explicitWorktreeId
              ? "The selected worktree is not ready on this project replica."
              : "The selected project replica has no ready worktree.",
        );
      }
      return {
        placement: {
          projectId,
          workerId,
          projectReplicaId: source.id,
          worktreeId: worktree.id,
          surface: null,
        },
        selection,
      };
    };

    if (target && target.kind !== "project") {
      if (target.kind === "worker") {
        return placementForWorker(
          target.workerId,
          "explicit",
          undefined,
          undefined,
          true,
        )!;
      }
      if (target.kind === "replica") {
        const source = replicaRows.find(
          ({ source }) => source.id === target.projectReplicaId,
        )?.source;
        if (!source) {
          throw new ExecutionPlacementUnavailableError(
            "target-not-found",
            "The selected project replica was not found.",
          );
        }
        return placementForWorker(
          source.workerId,
          "explicit",
          source.id,
          undefined,
          true,
        )!;
      }
      const row = replicaRows.find(
        ({ worktree }) => worktree?.id === target.worktreeId,
      );
      if (!row?.worktree) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected worktree was not found.",
        );
      }
      if (row.worktree.workerId !== row.source.workerId) {
        throw new ExecutionPlacementUnavailableError(
          "target-mismatch",
          "The selected worktree and project replica belong to different workers.",
        );
      }
      if (row.worktree.lifecycleState !== "ready") {
        throw new ExecutionPlacementUnavailableError(
          "worktree-unavailable",
          "The selected worktree is not ready.",
        );
      }
      return placementForWorker(
        row.worktree.workerId,
        "explicit",
        row.source.id,
        row.worktree.id,
        true,
      )!;
    }

    const preferredCandidates: Array<{
      selection: ExecutionPlacementResolution["selection"];
      workerId: string | null;
    }> = folderProject
      ? [
          {
            workerId: owningWorkerId,
            selection: "project-preference",
          },
        ]
      : [
          {
            workerId: project.preferredWorkerId,
            selection: "project-preference",
          },
          {
            workerId: settingsRows[0]?.defaultWorkerId ?? null,
            selection: "default-worker",
          },
        ];
    const visited = new Set<string>();
    for (const candidate of preferredCandidates) {
      if (!candidate.workerId || visited.has(candidate.workerId)) continue;
      visited.add(candidate.workerId);
      const placement = placementForWorker(
        candidate.workerId,
        candidate.selection,
        undefined,
        undefined,
        folderProject,
      );
      if (placement) return placement;
    }
    for (const worker of folderProject ? [] : workers) {
      if (visited.has(worker.id)) continue;
      const placement = placementForWorker(worker.id, "fallback");
      if (placement) return placement;
    }
    throw new ExecutionPlacementUnavailableError(
      "no-compatible-placement",
      `No online worker has a compatible ${surfaceKind} placement for this project.`,
    );
  }

  async resolveExecutionTarget(
    ownerId: string,
    projectId: string,
    target: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowUnavailable = false,
  ): Promise<ExecutionTargetResolution> {
    if (target.projectId !== projectId) {
      throw new ExecutionPlacementUnavailableError(
        "target-mismatch",
        "The execution target belongs to a different project.",
      );
    }
    const replicas = await this.listProjectReplicas(ownerId, projectId);
    if (!replicas) {
      throw new ExecutionPlacementUnavailableError(
        "project-not-found",
        "Project not found.",
      );
    }
    const project = await this.getProject(ownerId, projectId);
    if (!project) {
      throw new ExecutionPlacementUnavailableError(
        "project-not-found",
        "Project not found.",
      );
    }

    let placement: ExecutionPlacement;
    let capability: ExecutionTargetCapability = null;
    let resourceUnavailableCode:
      "replica-unavailable" | "worktree-unavailable" | null = null;
    let resourceUnavailableReason: string | null = null;
    const placementForWorktree = async (
      worktreeId: string,
      workerId: string,
      surface: ExecutionPlacement["surface"],
    ): Promise<ExecutionPlacement> => {
      const worktree = (
        await this.listProjectWorktrees(ownerId, projectId)
      ).find(({ id }) => id === worktreeId);
      if (!worktree) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The target worktree was not found in this project.",
        );
      }
      if (worktree.workerId !== workerId) {
        throw new ExecutionPlacementUnavailableError(
          "target-mismatch",
          "The target resource and worktree belong to different workers.",
        );
      }
      if (worktree.lifecycleState !== "ready") {
        resourceUnavailableCode = "worktree-unavailable";
        resourceUnavailableReason = `Worktree ${worktree.name} is ${worktree.lifecycleState}.`;
      }
      return {
        projectId,
        workerId,
        projectReplicaId: worktree.projectSourceId,
        worktreeId,
        surface,
      };
    };

    if (target.kind === "project") {
      placement = (
        await this.resolveProjectExecutionPlacement(
          ownerId,
          projectId,
          "terminal",
          target,
          isWorkerConnected,
          allowUnavailable,
        )
      ).placement;
    } else if (target.kind === "worker") {
      const worker = await this.getWorker(ownerId, target.workerId);
      if (!worker) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected worker is not linked to this account.",
        );
      }
      const replica = replicas.find(
        ({ workerId }) => workerId === target.workerId,
      );
      const primary = replica?.primaryWorktreeId
        ? await this.getProjectWorktreeContext(
            ownerId,
            projectId,
            replica.primaryWorktreeId,
          )
        : null;
      placement = {
        projectId,
        workerId: target.workerId,
        projectReplicaId: replica?.id ?? null,
        worktreeId: primary?.worktree.id ?? null,
        surface: null,
      };
    } else if (target.kind === "replica") {
      const replica = replicas.find(({ id }) => id === target.projectReplicaId);
      if (!replica) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected project replica was not found.",
        );
      }
      const primary = replica.primaryWorktreeId
        ? await this.getProjectWorktreeContext(
            ownerId,
            projectId,
            replica.primaryWorktreeId,
          )
        : null;
      if (!replica.ready || !primary) {
        resourceUnavailableCode = "replica-unavailable";
        resourceUnavailableReason = `The project replica on ${replica.workerName} is not ready.`;
      }
      placement = {
        projectId,
        workerId: replica.workerId,
        projectReplicaId: replica.id,
        worktreeId: primary?.worktree.id ?? null,
        surface: null,
      };
    } else if (target.kind === "worktree") {
      const worktree = (
        await this.listProjectWorktrees(ownerId, projectId)
      ).find(({ id }) => id === target.worktreeId);
      if (!worktree) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected worktree was not found.",
        );
      }
      if (worktree.lifecycleState !== "ready") {
        resourceUnavailableCode = "worktree-unavailable";
        resourceUnavailableReason = `Worktree ${worktree.name} is ${worktree.lifecycleState}.`;
      }
      placement = {
        projectId,
        workerId: worktree.workerId,
        projectReplicaId: worktree.projectSourceId,
        worktreeId: worktree.id,
        surface: null,
      };
    } else {
      const surface = {
        kind: target.surfaceKind,
        id: target.surfaceId,
      } as const;
      switch (target.surfaceKind) {
        case "chat": {
          const context = await this.getChatExecutionContext(
            ownerId,
            target.surfaceId,
          );
          if (!context || context.projectId !== projectId) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              "The selected chat was not found.",
            );
          }
          placement = await placementForWorktree(
            context.worktreeId,
            context.workerId,
            surface,
          );
          break;
        }
        case "terminal": {
          const context = await this.getTerminalExecutionContext(
            ownerId,
            target.surfaceId,
          );
          if (!context || context.projectId !== projectId) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              "The selected terminal was not found.",
            );
          }
          placement = await placementForWorktree(
            context.worktreeId,
            context.workerId,
            surface,
          );
          break;
        }
        case "explorer": {
          const context = await this.getExplorerExecutionContext(
            ownerId,
            target.surfaceId,
          );
          if (!context || context.projectId !== projectId) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              "The selected Explorer was not found.",
            );
          }
          placement = await placementForWorktree(
            context.worktreeId,
            context.workerId,
            surface,
          );
          break;
        }
        case "code": {
          const context = await this.getCodeTabExecutionContext(
            ownerId,
            target.surfaceId,
          );
          if (!context || context.codeTab.projectId !== projectId) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              "The selected Code tab was not found.",
            );
          }
          placement = await placementForWorktree(
            context.worktreeId,
            context.workerId,
            surface,
          );
          capability = "code";
          break;
        }
        case "browser":
        case "remote-desktop":
        case "remote-surface": {
          const [context, concreteSurfaceExists] = await Promise.all([
            this.getRemoteSurfaceExecutionContext(ownerId, target.surfaceId),
            target.surfaceKind === "browser"
              ? this.browserIsOwnedBy(ownerId, target.surfaceId)
              : target.surfaceKind === "remote-desktop"
                ? this.getRemoteDesktop(ownerId, target.surfaceId).then(
                    (desktop) => desktop?.projectId === projectId,
                  )
                : Promise.resolve(true),
          ]);
          const expectedKind =
            target.surfaceKind === "browser"
              ? "browser"
              : target.surfaceKind === "remote-desktop"
                ? "desktop"
                : null;
          if (
            !context ||
            !concreteSurfaceExists ||
            context.surface.projectId !== projectId ||
            (expectedKind !== null && context.surface.kind !== expectedKind)
          ) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              `The selected ${target.surfaceKind} was not found.`,
            );
          }
          placement = {
            projectId,
            workerId: context.workerId,
            projectReplicaId: null,
            worktreeId: null,
            surface,
          };
          capability =
            context.surface.kind === "browser" ? "browser" : "desktop";
          break;
        }
      }
    }

    if (
      project.originKind === "managed-folder" &&
      placement.workerId !==
        (project.preferredWorkerId ?? project.source?.workerId)
    ) {
      throw new ExecutionPlacementUnavailableError(
        "target-mismatch",
        "This worker-managed folder is bound to its owning worker.",
      );
    }

    const worker = await this.getWorker(ownerId, placement.workerId);
    if (!worker) {
      throw new ExecutionPlacementUnavailableError(
        "target-not-found",
        "The target worker is not linked to this account.",
      );
    }
    if (!allowUnavailable && resourceUnavailableCode) {
      throw new ExecutionPlacementUnavailableError(
        resourceUnavailableCode,
        resourceUnavailableReason!,
      );
    }
    let availability = executionTargetAvailability(
      worker,
      capability,
      isWorkerConnected,
    );
    if (!allowUnavailable && availability.availability !== "available") {
      throw new ExecutionPlacementUnavailableError(
        availability.availability === "worker-offline"
          ? "worker-offline"
          : "capability-unavailable",
        availability.unavailableReason!,
      );
    }
    if (
      availability.availability === "available" &&
      resourceUnavailableReason
    ) {
      availability = {
        availability: "resource-unavailable",
        online: true,
        unavailableReason: resourceUnavailableReason,
      };
    }
    return {
      target,
      placement,
      worker: {
        workerId: worker.workerId,
        name: worker.name,
        online: availability.online,
      },
      availability: availability.availability,
      unavailableReason: availability.unavailableReason,
    };
  }

  async listProjectExecutionTargets(
    ownerId: string,
    projectId: string,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExecutionTargetCatalog | null> {
    const [
      project,
      replicas,
      workers,
      worktrees,
      chats,
      terminals,
      explorers,
      codeTabs,
      browsers,
      desktops,
      remoteSurfaces,
    ] = await Promise.all([
      this.getProject(ownerId, projectId),
      this.listProjectReplicas(ownerId, projectId),
      this.listWorkers(ownerId),
      this.listProjectWorktrees(ownerId, projectId),
      this.listChats(ownerId, projectId),
      this.listTerminals(ownerId, projectId),
      this.listExplorers(ownerId, projectId),
      this.listCodeTabs(ownerId, projectId),
      this.listBrowsers(ownerId, projectId),
      this.listRemoteDesktops(ownerId, projectId),
      this.listRemoteSurfaces(ownerId, projectId),
    ]);
    if (!project || !replicas) return null;
    const folderProject = project.originKind === "managed-folder";
    const owningWorkerId =
      project.preferredWorkerId ?? project.source?.workerId ?? null;
    const catalog = buildExecutionTargetCatalog({
      browsers,
      chats,
      codeTabs,
      desktops,
      explorers,
      isWorkerConnected,
      projectId,
      remoteSurfaces,
      replicas,
      terminals,
      workers: folderProject
        ? workers.filter(({ workerId }) => workerId === owningWorkerId)
        : workers,
      worktrees,
    });
    return folderProject
      ? {
          ...catalog,
          targets: catalog.targets.filter(
            ({ resourceKind }) =>
              resourceKind !== "replica" && resourceKind !== "worktree",
          ),
        }
      : catalog;
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
      .where(
        and(
          eq(schema.projects.id, projectId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(
        desc(schema.projectWorktrees.isPrimary),
        asc(schema.projectWorktrees.name),
      );
    return rows.map(({ projectId: id, worktree }) =>
      toProjectWorktreeSummary(worktree, id),
    );
  }

  async listWorkerWorktreeObservationTargets(
    ownerId: string,
    workerId: string,
    limit = 128,
  ): Promise<ProjectWorktreeObservationContext[]> {
    return this.database
      .select({
        projectId: schema.projects.id,
        rootKind: schema.projectWorktrees.rootKind,
        sourcePath: schema.projectSources.absolutePath,
        workerId: schema.projectWorktrees.workerId,
        worktreeId: schema.projectWorktrees.id,
        worktreePath: schema.projectWorktrees.absolutePath,
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
          eq(schema.projectWorktrees.workerId, workerId),
          eq(schema.projectSources.sourceKind, "git"),
          eq(schema.projectWorktrees.rootKind, "git-worktree"),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(asc(schema.projectWorktrees.createdAt))
      .limit(Math.min(128, Math.max(1, limit)));
  }

  async listWorkerExecutionRootContexts(
    ownerId: string,
    workerId: string,
    limit = 128,
  ): Promise<ProjectWorktreeObservationContext[]> {
    return this.database
      .select({
        projectId: schema.projects.id,
        rootKind: schema.projectWorktrees.rootKind,
        sourcePath: schema.projectSources.absolutePath,
        workerId: schema.projectWorktrees.workerId,
        worktreeId: schema.projectWorktrees.id,
        worktreePath: schema.projectWorktrees.absolutePath,
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
          eq(schema.projectWorktrees.workerId, workerId),
          eq(schema.projectWorktrees.lifecycleState, "ready"),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(asc(schema.projectWorktrees.createdAt))
      .limit(Math.min(128, Math.max(1, limit)));
  }

  async getProjectWorktreeObservationContext(
    ownerId: string,
    workerId: string,
    sourcePath: string,
    worktreePath: string,
  ): Promise<ProjectWorktreeObservationContext | null> {
    const rows = await this.database
      .select({
        projectId: schema.projects.id,
        rootKind: schema.projectWorktrees.rootKind,
        sourcePath: schema.projectSources.absolutePath,
        workerId: schema.projectWorktrees.workerId,
        worktreeId: schema.projectWorktrees.id,
        worktreePath: schema.projectWorktrees.absolutePath,
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
          eq(schema.projectWorktrees.workerId, workerId),
          eq(schema.projectSources.sourceKind, "git"),
          eq(schema.projectWorktrees.rootKind, "git-worktree"),
          eq(schema.projectSources.absolutePath, sourcePath),
          eq(schema.projectWorktrees.absolutePath, worktreePath),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getProjectWorktreeStatusSnapshot(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeStatusResult | null> {
    const rows = await this.database
      .select({ status: schema.projectWorktrees.statusSnapshot })
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
          isNull(schema.projectSources.removedAt),
        ),
      )
      .limit(1);
    return rows[0]?.status ?? null;
  }

  async recordProjectWorktreeStatus(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ): Promise<ProjectWorktreeStatusRecord | null> {
    const context = await this.getProjectWorktreeContext(
      ownerId,
      projectId,
      worktreeId,
    );
    if (!context) return null;
    if (context.worktree.path !== status.worktree.path) {
      throw new Error("Worker status referred to a different worktree path.");
    }
    const currentRows = await this.database
      .select()
      .from(schema.projectWorktrees)
      .where(eq(schema.projectWorktrees.id, worktreeId))
      .limit(1);
    const current = currentRows[0];
    if (!current) return null;
    const lifecycleState = status.worktree.missing
      ? "missing"
      : status.worktree.prunable
        ? "prunable"
        : "ready";
    const metadataChanged =
      current.branch !== status.worktree.branch ||
      current.detached !== status.worktree.detached ||
      current.head !== status.worktree.head ||
      current.lifecycleState !== lifecycleState ||
      current.locked !== status.worktree.locked ||
      current.lockReason !== status.worktree.lockReason;
    const snapshotChanged =
      JSON.stringify(current.statusSnapshot) !== JSON.stringify(status);
    if (!metadataChanged && !snapshotChanged) {
      return {
        metadataChanged,
        snapshotChanged,
        status,
        worktree: context.worktree,
      };
    }
    const now = new Date();
    const rows = await this.database
      .update(schema.projectWorktrees)
      .set({
        branch: status.worktree.branch,
        detached: status.worktree.detached,
        head: status.worktree.head,
        lifecycleState,
        locked: status.worktree.locked,
        lockReason: status.worktree.lockReason,
        lastScannedAt: now,
        statusObservedAt: now,
        statusSnapshot: status,
        updatedAt: now,
      })
      .where(eq(schema.projectWorktrees.id, worktreeId))
      .returning();
    return rows[0]
      ? {
          metadataChanged,
          snapshotChanged,
          status,
          worktree: toProjectWorktreeSummary(rows[0], projectId),
        }
      : null;
  }

  async createGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    workerId: string,
    context: GitManagedOperationContext,
  ): Promise<GitManagedOperationRecord> {
    const existing = await this.getActiveGitOperation(
      ownerId,
      projectId,
      worktreeId,
    );
    if (existing) {
      throw new Error(
        `This worktree already has an active ${existing.type} operation.`,
      );
    }
    const rows = await this.database
      .insert(schema.gitOperations)
      .values({
        id: randomUUID(),
        ownerId,
        projectId,
        worktreeId,
        workerId,
        type: context.type,
        state: "queued",
        originalHead: context.originalHead,
        currentHead: context.originalHead,
        sourceRef: context.sourceRef,
        sourceRevision: context.sourceRevision,
        targetRef: context.targetRef,
        targetRevision: context.targetRevision,
        pendingCommits: context.pendingCommits,
        currentStep: 0,
        totalSteps: context.totalSteps,
        conflictedPaths: [],
        output: "",
        checkpointRef: context.checkpointRef,
        pausedAction: null,
      })
      .returning();
    return toGitManagedOperationRecord(
      firstOrThrow(rows, "creating Git operation"),
    );
  }

  async getActiveGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<GitManagedOperationRecord | null> {
    const rows = await this.database
      .select({ operation: schema.gitOperations })
      .from(schema.gitOperations)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.gitOperations.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.gitOperations.projectId, projectId),
          eq(schema.gitOperations.worktreeId, worktreeId),
          inArray(schema.gitOperations.state, [
            "queued",
            "running",
            "conflicted",
            "awaiting-user-action",
          ]),
        ),
      )
      .orderBy(desc(schema.gitOperations.updatedAt))
      .limit(1);
    return rows[0] ? toGitManagedOperationRecord(rows[0].operation) : null;
  }

  async markGitOperationRunning(
    operationId: string,
  ): Promise<GitManagedOperationRecord | null> {
    const rows = await this.database
      .update(schema.gitOperations)
      .set({ state: "running", updatedAt: new Date() })
      .where(
        and(
          eq(schema.gitOperations.id, operationId),
          eq(schema.gitOperations.state, "queued"),
        ),
      )
      .returning();
    return rows[0] ? toGitManagedOperationRecord(rows[0]) : null;
  }

  async getGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
  ): Promise<GitManagedOperationRecord | null> {
    const rows = await this.database
      .select({ operation: schema.gitOperations })
      .from(schema.gitOperations)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.gitOperations.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.gitOperations.id, operationId),
          eq(schema.gitOperations.projectId, projectId),
          eq(schema.gitOperations.worktreeId, worktreeId),
        ),
      )
      .limit(1);
    return rows[0] ? toGitManagedOperationRecord(rows[0].operation) : null;
  }

  async getLatestGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<GitManagedOperationRecord | null> {
    const rows = await this.database
      .select({ operation: schema.gitOperations })
      .from(schema.gitOperations)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.gitOperations.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.gitOperations.projectId, projectId),
          eq(schema.gitOperations.worktreeId, worktreeId),
        ),
      )
      .orderBy(desc(schema.gitOperations.updatedAt))
      .limit(1);
    return rows[0] ? toGitManagedOperationRecord(rows[0].operation) : null;
  }

  async updateGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
    state: GitManagedOperationWorkerState,
  ): Promise<GitManagedOperationRecord | null> {
    const current = await this.getGitOperation(
      ownerId,
      projectId,
      worktreeId,
      operationId,
    );
    if (!current) return null;
    if (
      current.type !== state.type ||
      current.originalHead !== state.originalHead ||
      current.sourceRef !== state.sourceRef ||
      current.sourceRevision !== state.sourceRevision ||
      current.targetRef !== state.targetRef ||
      current.targetRevision !== state.targetRevision ||
      current.checkpointRef !== state.checkpointRef
    ) {
      throw new Error(
        "Worker operation state does not match its durable record.",
      );
    }
    const terminal = ["completed", "failed", "aborted"].includes(state.state);
    const output = [current.output, state.output]
      .filter(Boolean)
      .join("\n")
      .slice(-1_000_000);
    const rows = await this.database
      .update(schema.gitOperations)
      .set({
        state: state.state,
        currentHead: state.currentHead,
        pendingCommits: state.pendingCommits,
        currentStep: state.currentStep,
        totalSteps: state.totalSteps,
        conflictedPaths: state.conflictedPaths,
        output,
        pausedAction: state.pausedAction ?? null,
        error: null,
        completedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.gitOperations.id, operationId))
      .returning();
    return rows[0] ? toGitManagedOperationRecord(rows[0]) : null;
  }

  async failGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
    error: string,
  ): Promise<GitManagedOperationRecord | null> {
    const current = await this.getGitOperation(
      ownerId,
      projectId,
      worktreeId,
      operationId,
    );
    if (!current) return null;
    const rows = await this.database
      .update(schema.gitOperations)
      .set({
        state: "failed",
        error: error.slice(0, 1_000_000),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.gitOperations.id, operationId))
      .returning();
    return rows[0] ? toGitManagedOperationRecord(rows[0]) : null;
  }

  async reconcileProjectWorktrees(
    ownerId: string,
    projectId: string,
    workerId: string,
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
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projectSources.workerId, workerId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .limit(1);
    const source = ownedRows[0]?.source;
    if (!source) return null;
    if (source.sourceKind !== "git") {
      throw new Error(
        "Git worktree reconciliation is unavailable for folder sources.",
      );
    }
    if (source.absolutePath !== inventory.sourcePath) {
      throw new Error("Worker inventory referred to a different replica path.");
    }
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
    const [chats, leases, terminals, codeTabs, workflowLeases] =
      await Promise.all([
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
        this.database
          .select({ id: schema.codeTabs.id })
          .from(schema.codeTabs)
          .where(eq(schema.codeTabs.worktreeId, worktreeId)),
        this.database
          .select({ id: schema.workflowWorktreeLeases.id })
          .from(schema.workflowWorktreeLeases)
          .where(
            and(
              or(
                eq(schema.workflowWorktreeLeases.worktreeId, worktreeId),
                eq(
                  schema.workflowWorktreeLeases.requestedWorktreeId,
                  worktreeId,
                ),
              ),
              ne(schema.workflowWorktreeLeases.state, "released"),
            ),
          ),
      ]);
    return {
      activeChatIds: chats.map(({ id }) => id),
      activeLeaseChatIds: leases.map(({ chatId }) => chatId),
      boundCodeTabIds: codeTabs.map(({ id }) => id),
      runningTerminalIds: terminals.map(({ id }) => id),
      workflowLeaseIds: workflowLeases.map(({ id }) => id),
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
      const interruptedPrimaryLanes = await transaction
        .select({ id: schema.chatExecutionLanes.id })
        .from(schema.chatExecutionLanes)
        .innerJoin(
          schema.projectWorktrees,
          eq(schema.projectWorktrees.id, schema.chatExecutionLanes.worktreeId),
        )
        .where(
          and(
            eq(schema.chatExecutionLanes.state, "active"),
            eq(schema.projectWorktrees.isPrimary, true),
          ),
        );
      await transaction
        .update(schema.chatExecutionLanes)
        .set({ state: "suspended", updatedAt: now })
        .where(eq(schema.chatExecutionLanes.state, "active"));
      for (const lane of interruptedPrimaryLanes) {
        await releaseChatLogicalBranchLease(transaction, lane.id);
      }
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
        await transaction
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
          .for("update");
        const rows = await transaction
          .select({
            chat: schema.chats,
            project: schema.projects,
            settings: schema.userSettings,
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
          .leftJoin(
            schema.userSettings,
            eq(schema.userSettings.userId, schema.projects.ownerId),
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
        const activeRelocations = await transaction
          .select({ id: schema.chatRelocationJobs.id })
          .from(schema.chatRelocationJobs)
          .where(
            and(
              eq(schema.chatRelocationJobs.chatId, chatId),
              inArray(schema.chatRelocationJobs.state, [
                "queued",
                "waiting-for-idle",
                "validating",
                "preparing-replica",
                "transferring-attachments",
                "hydrating-runtime",
                "ready-to-commit",
                "blocked",
              ]),
            ),
          )
          .limit(1);
        if (activeRelocations[0]) {
          throw new ExecutionLaneConflictError(
            "Chat relocation is active. Cancel it before starting another turn on the source placement.",
          );
        }
        const incompleteImports = await transaction
          .select({ state: schema.chatImportJobs.state })
          .from(schema.chatImportJobs)
          .where(
            and(
              eq(schema.chatImportJobs.chatId, chatId),
              notInArray(schema.chatImportJobs.state, [
                "succeeded",
                "cancelled",
              ]),
            ),
          )
          .limit(1);
        if (incompleteImports[0]) {
          throw new ExecutionLaneConflictError(
            "This imported chat must finish runtime hydration before it can continue.",
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
        await acquireChatLogicalBranchLease(transaction, {
          branchName: row.worktree.branch,
          chatId,
          detached: row.worktree.detached,
          laneId: lane.id,
          projectId: row.chat.projectId,
          workerId: row.worktree.workerId,
          worktreeId: row.worktree.id,
        });
        return {
          automationPaused: row.chat.automationPaused,
          chatId,
          cwd: row.worktree.absolutePath,
          experience: row.chat.experience as ChatSummary["experience"],
          defaultPermissionProfileId:
            (row.settings?.defaultPermissionProfileId as
              UserSettings["defaultPermissionProfileId"] | undefined) ??
            DEFAULT_PERMISSION_PROFILE_ID,
          executionLaneId: lane.id,
          isPrimary: row.worktree.isPrimary,
          status: "running",
          modelId: row.chat.modelId,
          reasoningEffort: row.chat.reasoningEffort,
          modelRouteId: runtime.modelRouteId,
          providerAccountId: runtime.providerAccountId,
          permissionProfileId: row.chat.permissionProfileId,
          planMode: row.chat.planMode as PlanMode,
          pendingPlanQuestion: row.chat.pendingPlanQuestion,
          projectId: row.chat.projectId,
          rootKind: row.worktree.rootKind,
          threadId: runtime.codexThreadId,
          workerId: row.worktree.workerId,
          worktreeId: row.worktree.id,
          worktreeMode: row.chat.worktreeMode as ChatSummary["worktreeMode"],
          worktreePolicy: row.project.worktreePolicy as WorktreePolicy,
        };
      });
    } catch (error) {
      if (error instanceof ExecutionLaneConflictError) throw error;
      if (error instanceof LogicalBranchLeaseConflictError) {
        throw new ExecutionLaneConflictError(error.message);
      }
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
  ): Promise<boolean> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const laneRows = await transaction
        .select({
          lane: schema.chatExecutionLanes,
          isPrimary: schema.projectWorktrees.isPrimary,
        })
        .from(schema.chatExecutionLanes)
        .innerJoin(
          schema.projectWorktrees,
          eq(schema.projectWorktrees.id, schema.chatExecutionLanes.worktreeId),
        )
        .where(
          and(
            eq(schema.chatExecutionLanes.id, laneId),
            eq(schema.chatExecutionLanes.chatId, chatId),
          ),
        )
        .limit(1);
      const suspended = await transaction
        .update(schema.chatExecutionLanes)
        .set({ state: "suspended", updatedAt: now })
        .where(
          and(
            eq(schema.chatExecutionLanes.id, laneId),
            eq(schema.chatExecutionLanes.chatId, chatId),
            eq(schema.chatExecutionLanes.state, "active"),
          ),
        )
        .returning({ id: schema.chatExecutionLanes.id });
      if (suspended[0] && laneRows[0]?.isPrimary) {
        await releaseChatLogicalBranchLease(transaction, laneId);
      }
      if (!suspended[0]) return false;
      await transaction
        .update(schema.chats)
        .set({ status, updatedAt: now })
        .where(eq(schema.chats.id, chatId));
      return true;
    });
  }

  async updateChatExecutionLaneRuntime(
    chatId: string,
    laneId: string,
    threadId: string | null,
    status: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const lanes = await transaction
        .update(schema.chatExecutionLanes)
        .set({ codexThreadId: threadId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.chatExecutionLanes.id, laneId),
            eq(schema.chatExecutionLanes.chatId, chatId),
          ),
        )
        .returning({
          runtimeSessionId: schema.chatExecutionLanes.runtimeSessionId,
        });
      const runtimeSessionId = lanes[0]?.runtimeSessionId;
      if (!runtimeSessionId) return false;
      await transaction
        .update(schema.chatRuntimeSessions)
        .set({ codexThreadId: threadId, status, updatedAt: new Date() })
        .where(eq(schema.chatRuntimeSessions.id, runtimeSessionId));
      return true;
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
      await releaseChatLogicalBranchLease(transaction, laneId);

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
          .where(
            and(
              eq(schema.projectWorktrees.isPrimary, true),
              eq(schema.projectSources.workerId, context.lane.workerId),
              isNull(schema.projectSources.removedAt),
            ),
          )
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
            placementRevision: sql`${schema.chats.placementRevision} + 1`,
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
    if (target.workerId !== current.workerId) {
      throw new ExecutionLaneConflictError(
        "Moving a chat to another worker requires a durable relocation.",
      );
    }
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
          await acquireChatLogicalBranchLease(transaction, {
            branchName: target.worktree.branch,
            chatId,
            detached: target.worktree.detached,
            laneId: existing[0].id,
            projectId: current.projectId,
            workerId: target.workerId,
            worktreeId: target.worktree.id,
          });
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
        const insertedLane = firstOrThrow(
          inserted,
          "scheduling a worktree transition",
        );
        await acquireChatLogicalBranchLease(transaction, {
          branchName: target.worktree.branch,
          chatId,
          detached: target.worktree.detached,
          laneId: insertedLane.id,
          projectId: current.projectId,
          workerId: target.workerId,
          worktreeId: target.worktree.id,
        });
        return insertedLane.id;
      });
      return this.getChatExecutionLaneContext(ownerId, chatId, laneId);
    } catch (error) {
      if (error instanceof ExecutionLaneConflictError) throw error;
      if (error instanceof LogicalBranchLeaseConflictError) {
        throw new ExecutionLaneConflictError(error.message);
      }
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
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(schema.chatExecutionLanes)
        .set({
          state: "suspended",
          transitionKind: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.chatExecutionLanes.id, laneId))
        .returning({ id: schema.chatExecutionLanes.id });
      if (rows[0] && context.worktree.isPrimary) {
        await releaseChatLogicalBranchLease(transaction, laneId);
      }
      return rows.length === 1;
    });
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
    if (pending.worktree.workerId !== pending.chat.activeWorkerId) {
      throw new ExecutionLaneConflictError(
        "Moving a chat to another worker requires a durable relocation.",
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
        const releasedLanes = await transaction
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
          )
          .returning({ id: schema.chatExecutionLanes.id });
        for (const releasedLane of releasedLanes) {
          await releaseChatLogicalBranchLease(transaction, releasedLane.id);
        }
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
      if (pending.worktree.isPrimary) {
        await releaseChatLogicalBranchLease(transaction, lane.id);
      }
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
          placementRevision: sql`${schema.chats.placementRevision} + 1`,
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
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    const source = row ? await this.getProjectSource(ownerId, projectId) : null;
    return row?.nameWithOwner && row.url && source
      ? {
          nameWithOwner: row.nameWithOwner,
          url: row.url,
          workerId: source.workerId,
        }
      : null;
  }

  async hasGithubProject(ownerId: string, repositoryId: string) {
    const [projects, conversions] = await Promise.all([
      this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.ownerId, ownerId),
            eq(schema.projects.githubRepositoryId, repositoryId),
          ),
        )
        .limit(1),
      this.database
        .select({ id: schema.projectGithubConversionJobs.id })
        .from(schema.projectGithubConversionJobs)
        .where(
          and(
            eq(schema.projectGithubConversionJobs.ownerId, ownerId),
            eq(schema.projectGithubConversionJobs.repositoryId, repositoryId),
            inArray(schema.projectGithubConversionJobs.state, [
              "queued",
              "running",
              "blocked",
            ]),
          ),
        )
        .limit(1),
    ]);
    return Boolean(projects[0] || conversions[0]);
  }

  async listGithubRepositoryIds(ownerId: string): Promise<Set<string>> {
    const [rows, conversions] = await Promise.all([
      this.database
        .select({ repositoryId: schema.projects.githubRepositoryId })
        .from(schema.projects)
        .where(eq(schema.projects.ownerId, ownerId)),
      this.database
        .select({
          repositoryId: schema.projectGithubConversionJobs.repositoryId,
        })
        .from(schema.projectGithubConversionJobs)
        .where(
          and(
            eq(schema.projectGithubConversionJobs.ownerId, ownerId),
            inArray(schema.projectGithubConversionJobs.state, [
              "queued",
              "running",
              "blocked",
            ]),
          ),
        ),
    ]);
    return new Set([
      ...rows.flatMap(({ repositoryId }) =>
        repositoryId === null ? [] : [repositoryId],
      ),
      ...conversions.map(({ repositoryId }) => repositoryId),
    ]);
  }

  async createGithubProject(
    ownerId: string,
    input: GithubProjectCreate,
  ): Promise<ProjectSummary> {
    const defaultWorkspace = await this.ensureDefaultProjectWorkspace(ownerId);
    const workspaceIds = [
      ...new Set(input.workspaceIds ?? [defaultWorkspace.id]),
    ];
    const ownedWorkspaces = await this.database
      .select({ id: schema.projectWorkspaces.id })
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.ownerId, ownerId),
          inArray(schema.projectWorkspaces.id, workspaceIds),
        ),
      );
    if (ownedWorkspaces.length !== workspaceIds.length) {
      throw new ProjectWorkspaceInvariantError(
        "Project import referenced an unknown workspace.",
      );
    }
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
          originKind: "github",
          setupStatus: "cloning",
          setupError: null,
          githubRepositoryId: input.repositoryId,
          githubRepositoryFullName: input.nameWithOwner,
          githubRepositoryUrl: input.url,
        })
        .returning();
      const created = firstOrThrow(projectResult, "creating a GitHub project");
      await transaction.insert(schema.projectWorkspaceMemberships).values(
        workspaceIds.map((workspaceId) => ({
          workspaceId,
          projectId: created.id,
        })),
      );
      return created;
    });
    return toProjectSummary(project);
  }

  async createManagedFolderProject(
    ownerId: string,
    input: ManagedFolderProjectCreate,
  ): Promise<{
    job: ProjectFolderSetupJobSummary;
    project: ProjectSummary;
  }> {
    const defaultWorkspace = await this.ensureDefaultProjectWorkspace(ownerId);
    const workspaceIds = [
      ...new Set(input.workspaceIds ?? [defaultWorkspace.id]),
    ];
    const ownedWorkspaces = await this.database
      .select({ id: schema.projectWorkspaces.id })
      .from(schema.projectWorkspaces)
      .where(
        and(
          eq(schema.projectWorkspaces.ownerId, ownerId),
          inArray(schema.projectWorkspaces.id, workspaceIds),
        ),
      );
    if (ownedWorkspaces.length !== workspaceIds.length) {
      throw new ProjectWorkspaceInvariantError(
        "Folder project creation referenced an unknown workspace.",
      );
    }
    const projectId = randomUUID();
    const jobId = randomUUID();
    const project = await this.database.transaction(async (transaction) => {
      const workers = await transaction
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .limit(1);
      if (!workers[0]) {
        throw new ProjectWorkspaceInvariantError("Worker not found.");
      }
      const lastProjects = await transaction
        .select({ position: schema.projects.position })
        .from(schema.projects)
        .where(eq(schema.projects.ownerId, ownerId))
        .orderBy(desc(schema.projects.position))
        .limit(1);
      const projectRows = await transaction
        .insert(schema.projects)
        .values({
          id: projectId,
          ownerId,
          name: input.name,
          position: (lastProjects[0]?.position ?? -1) + 1,
          originKind: "managed-folder",
          folderManagement: input.existingPath ? "external" : "managed",
          setupStatus: "preparing",
          setupError: null,
          worktreePolicy: "direct",
          preferredWorkerId: input.workerId,
          githubRepositoryId: null,
          githubRepositoryFullName: null,
          githubRepositoryUrl: null,
        })
        .returning();
      await transaction
        .insert(schema.projectWorkspaceMemberships)
        .values(
          workspaceIds.map((workspaceId) => ({ workspaceId, projectId })),
        );
      await transaction.insert(schema.projectFolderSetupJobs).values({
        id: jobId,
        ownerId,
        projectId,
        workerId: input.workerId,
        requestedPath: input.existingPath ?? null,
        state: "queued",
      });
      return firstOrThrow(projectRows, "creating a folder project");
    });
    const job = await this.projectFolderSetupJobs.get(ownerId, projectId);
    if (!job) throw new Error("Folder setup job was not created.");
    return { job, project: toProjectSummary(project) };
  }

  async completeGithubProjectSetup(
    ownerId: string,
    projectId: string,
    workerId: string,
    clone: ProjectCloneResult,
  ): Promise<ProjectSummary | null> {
    const completed = await this.database.transaction(async (transaction) => {
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
          sourceKind: "git",
          absolutePath: clone.path,
          displayPath: clone.displayPath,
        })
        .returning();
      const source = firstOrThrow(sourceResult, "recording a project source");
      await transaction.insert(schema.projectWorktrees).values({
        id: randomUUID(),
        projectSourceId: source.id,
        workerId,
        rootKind: "git-worktree",
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
      return firstOrThrow(projectResult, "completing project setup");
    });
    return completed
      ? toProjectSummary(
          completed,
          (await this.listProjectReplicas(ownerId, projectId)) ?? [],
        )
      : null;
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
        folderManagement: schema.projects.folderManagement,
        originKind: schema.projects.originKind,
        preferredWorkerId: schema.projects.preferredWorkerId,
        projectId: schema.projects.id,
        setupStatus: schema.projects.setupStatus,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const project = rows[0];
    if (!project) return null;
    const convertedManagedFolderSource =
      project.originKind === "github"
        ? await this.projectGithubConversionJobs.convertedManagedFolderSource(
            ownerId,
            projectId,
          )
        : null;
    const replicas = await this.database
      .select({
        cwd: schema.projectSources.absolutePath,
        id: schema.projectSources.id,
        workerId: schema.projectSources.workerId,
      })
      .from(schema.projectSources)
      .where(
        and(
          eq(schema.projectSources.projectId, projectId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .orderBy(
        asc(schema.projectSources.createdAt),
        asc(schema.projectSources.id),
      );
    const terminals = await this.database
      .select({
        id: schema.terminals.id,
        workerId: schema.terminals.activeWorkerId,
      })
      .from(schema.terminals)
      .where(eq(schema.terminals.projectId, projectId));
    const remoteSurfaces = await this.database
      .select({ surface: schema.remoteSurfaces })
      .from(schema.remoteSurfaces)
      .where(eq(schema.remoteSurfaces.projectId, projectId));
    return {
      convertedManagedFolderSource,
      folderManagement: project.folderManagement,
      originKind: project.originKind,
      preferredWorkerId: project.preferredWorkerId,
      replicas,
      remoteSurfaces: remoteSurfaces.map(({ surface }) =>
        toRemoteSurfaceSummary(surface),
      ),
      setupStatus: project.setupStatus as ProjectSummary["setupStatus"],
      terminals,
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
    if (deleted.length !== 1) return false;
    await this.database
      .update(schema.userSettings)
      .set({
        mobileProjectTabConfigurations: sql`${schema.userSettings.mobileProjectTabConfigurations} - ${projectId}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.userSettings.userId, ownerId));
    return true;
  }

  private async nextProjectTabPosition(projectId: string): Promise<number> {
    const positions = await Promise.all([
      this.database
        .select({ position: schema.chats.position })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.projectId, projectId),
            isNull(schema.chats.archivedAt),
          ),
        )
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
        .select({ position: schema.codeTabs.position })
        .from(schema.codeTabs)
        .where(eq(schema.codeTabs.projectId, projectId))
        .orderBy(desc(schema.codeTabs.position))
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
    return Math.max(...positions.map((rows) => rows[0]?.position ?? -1)) + 1;
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
      .where(
        and(
          eq(schema.chats.projectId, projectId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .orderBy(asc(schema.chats.position), asc(schema.chats.createdAt));
    return rows.map(({ chat }) => toChatSummary(chat));
  }

  async listArchivedChats(
    ownerId: string,
    projectId: string,
  ): Promise<ArchivedChatSummary[]> {
    const rows = await this.database
      .select({
        chat: schema.chats,
        messageCount: sql<number>`(
          select count(*)::int
          from ${schema.chatMessages}
          where ${schema.chatMessages.chatId} = ${schema.chats.id}
        )`,
      })
      .from(schema.chats)
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
          isNotNull(schema.chats.archivedAt),
        ),
      )
      .orderBy(desc(schema.chats.archivedAt));
    return rows.map(({ chat, messageCount }) =>
      toArchivedChatSummary(chat, messageCount),
    );
  }

  async createChat(
    ownerId: string,
    projectId: string,
    input: ChatCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ChatSummary | null> {
    const created = await this.createChatExperience(
      ownerId,
      projectId,
      input,
      "agent",
      isWorkerConnected,
    );
    return created?.chat ?? null;
  }

  async createTask(
    ownerId: string,
    projectId: string,
    input: TaskCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<TaskCreateResult | null> {
    const created = await this.createChatExperience(
      ownerId,
      projectId,
      input,
      "task",
      isWorkerConnected,
    );
    if (!created) return null;
    if (!created.task) {
      throw new Error("Task-backed Chat creation omitted its Task record.");
    }
    return { chat: created.chat, task: created.task };
  }

  private async createChatExperience(
    ownerId: string,
    projectId: string,
    input: ChatCreate | TaskCreate,
    experience: ChatExperience,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<{ chat: ChatSummary; task: TaskDetail | null } | null> {
    const target =
      input.target ??
      (input.worktreeId
        ? ({
            kind: "worktree",
            projectId,
            worktreeId: input.worktreeId,
          } as const)
        : undefined);
    const { placement } = await this.resolveProjectExecutionPlacement(
      ownerId,
      projectId,
      "chat",
      target,
      isWorkerConnected,
    );
    const selected = await this.getProjectWorktreeContext(
      ownerId,
      projectId,
      placement.worktreeId!,
    );
    if (!selected) return null;
    const worktreeId = selected.worktree.id;
    const workerId = selected.workerId;
    const isPrimary = selected.worktree.isPrimary;
    const startingHead = selected.worktree.head;

    const position = await this.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .insert(schema.chats)
        .values({
          id: randomUUID(),
          projectId,
          title: input.title,
          experience,
          position,
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
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId: input.tabGroupId,
        tabId: chat.id,
        tabKind: "chat",
      });
      const task =
        experience === "task"
          ? firstOrThrow(
              await transaction
                .insert(schema.tasks)
                .values({ chatId: chat.id })
                .returning(),
              "creating a Task record",
            )
          : null;
      return {
        chat: toChatSummary(chat),
        task: task ? toTaskDetail(task) : null,
      };
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
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<TerminalSummary | null> {
    const target =
      input.target ??
      (input.worktreeId
        ? ({
            kind: "worktree",
            projectId,
            worktreeId: input.worktreeId,
          } as const)
        : undefined);
    const { placement } = await this.resolveProjectExecutionPlacement(
      ownerId,
      projectId,
      "terminal",
      target,
      isWorkerConnected,
    );
    const workerId = placement.workerId;
    const worktreeId = placement.worktreeId!;

    const position = await this.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .insert(schema.terminals)
        .values({
          id: randomUUID(),
          projectId,
          title: input.title,
          directoryPath: input.directoryPath ?? "",
          position,
          activeWorkerId: workerId,
          worktreeId,
        })
        .returning();
      const terminal = firstOrThrow(result, "creating a terminal");
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId: input.tabGroupId,
        tabId: terminal.id,
        tabKind: "terminal",
      });
      return toTerminalSummary(terminal);
    });
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
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
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

  async updateTerminalService(
    ownerId: string,
    terminalId: string,
    input: TerminalServiceConfiguration,
  ): Promise<TerminalSummary | null> {
    const owned = await this.getTerminalExecutionContext(ownerId, terminalId);
    if (!owned) return null;
    if (owned.linkedChatId) {
      throw new Error("Linked Codex consoles cannot run terminal services.");
    }
    const result = await this.database
      .update(schema.terminals)
      .set({
        serviceEnabled: input.enabled,
        serviceCommand: input.command,
        updatedAt: new Date(),
      })
      .where(eq(schema.terminals.id, terminalId))
      .returning();
    return result[0] ? toTerminalSummary(result[0]) : null;
  }

  async listTerminalServicesForWorker(
    workerId: string,
  ): Promise<TerminalServiceRuntimeConfiguration[]> {
    const rows = await this.database
      .select({
        terminal: schema.terminals,
        worktree: schema.projectWorktrees,
      })
      .from(schema.terminals)
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.terminals.worktreeId),
      )
      .where(
        and(
          eq(schema.projectWorktrees.workerId, workerId),
          eq(schema.terminals.serviceEnabled, true),
        ),
      );
    return rows.map(({ terminal, worktree }) => ({
      terminalId: terminal.id,
      cwd: terminalWorkingDirectory(
        worktree.absolutePath,
        terminal.directoryPath,
      ),
      command: terminal.serviceCommand,
    }));
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
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExplorerSummary | null> {
    const target =
      input.target ??
      (input.worktreeId
        ? ({
            kind: "worktree",
            projectId,
            worktreeId: input.worktreeId,
          } as const)
        : undefined);
    const { placement } = await this.resolveProjectExecutionPlacement(
      ownerId,
      projectId,
      "explorer",
      target,
      isWorkerConnected,
    );
    const workerId = placement.workerId;
    const worktreeId = placement.worktreeId!;
    const position = await this.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .insert(schema.explorers)
        .values({
          id: randomUUID(),
          projectId,
          title: input.title,
          position,
          activeWorkerId: workerId,
          worktreeId,
        })
        .returning();
      const explorer = firstOrThrow(result, "creating an explorer");
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId: input.tabGroupId,
        tabId: explorer.id,
        tabKind: "explorer",
      });
      return toExplorerSummary(explorer);
    });
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
        selectedPath: null,
        fileMode: "preview",
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
          projectId: row.explorer.projectId,
          root: row.worktree.absolutePath,
          workerId: row.explorer.activeWorkerId,
          worktreeId: row.worktree.id,
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

  async updateExplorerViewState(
    ownerId: string,
    explorerId: string,
    input: ExplorerViewStateUpdate,
  ): Promise<ExplorerSummary | null> {
    if (!(await this.getExplorerExecutionContext(ownerId, explorerId))) {
      return null;
    }
    const result = await this.database
      .update(schema.explorers)
      .set({
        selectedPath: input.selectedPath,
        fileMode: input.fileMode,
        updatedAt: new Date(),
      })
      .where(eq(schema.explorers.id, explorerId))
      .returning();
    return result[0] ? toExplorerSummary(result[0]) : null;
  }

  async deleteExplorer(ownerId: string, explorerId: string): Promise<boolean> {
    const context = await this.getExplorerExecutionContext(ownerId, explorerId);
    if (!context) return false;
    return this.database.transaction(async (transaction) => {
      await detachProjectTab(
        transaction,
        context.projectId,
        projectTabKey("explorer", explorerId),
      );
      const result = await transaction
        .delete(schema.explorers)
        .where(eq(schema.explorers.id, explorerId))
        .returning({ id: schema.explorers.id });
      return result.length === 1;
    });
  }

  async listCodeTabs(
    ownerId: string,
    projectId: string,
  ): Promise<CodeTabSummary[]> {
    const rows = await this.database
      .select({ codeTab: schema.codeTabs })
      .from(schema.codeTabs)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.codeTabs.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.codeTabs.projectId, projectId))
      .orderBy(asc(schema.codeTabs.position), asc(schema.codeTabs.createdAt));
    return rows.map(({ codeTab }) => toCodeTabSummary(codeTab));
  }

  async createCodeTab(
    ownerId: string,
    projectId: string,
    input: CodeTabCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<CodeTabSummary | null> {
    const target =
      input.target ??
      (input.worktreeId
        ? ({
            kind: "worktree",
            projectId,
            worktreeId: input.worktreeId,
          } as const)
        : undefined);
    const { placement } = await this.resolveProjectExecutionPlacement(
      ownerId,
      projectId,
      "code",
      target,
      isWorkerConnected,
    );
    const workerId = placement.workerId;
    const worktreeId = placement.worktreeId!;
    const workerRows = await this.database
      .select({ codeCapabilities: schema.workers.codeCapabilities })
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.id, workerId),
          eq(schema.workers.ownerId, ownerId),
        ),
      )
      .limit(1);
    const capabilities = workerRows[0]?.codeCapabilities;
    if (!capabilities?.available) {
      throw new CodeCapabilityUnavailableError(
        capabilities?.reason ?? "Cantrip Code is unavailable on this worker.",
      );
    }
    const position = await this.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .insert(schema.codeTabs)
        .values({
          id: randomUUID(),
          projectId,
          title: input.title,
          position,
          activeWorkerId: workerId,
          worktreeId,
          profileId: input.profileId,
          themeMode: input.themeMode,
        })
        .returning();
      const codeTab = firstOrThrow(result, "creating a Code tab");
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId: input.tabGroupId,
        tabId: codeTab.id,
        tabKind: "code",
      });
      return toCodeTabSummary(codeTab);
    });
  }

  async getCodeTabExecutionContext(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeTabExecutionContext | null> {
    const rows = await this.database
      .select({
        codeTab: schema.codeTabs,
        projectName: schema.projects.name,
        worktree: schema.projectWorktrees,
        codeCapabilities: schema.workers.codeCapabilities,
      })
      .from(schema.codeTabs)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.codeTabs.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.codeTabs.worktreeId),
      )
      .innerJoin(
        schema.workers,
        eq(schema.workers.id, schema.codeTabs.activeWorkerId),
      )
      .where(eq(schema.codeTabs.id, codeTabId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          capabilities: row.codeCapabilities,
          codeTab: toCodeTabSummary(row.codeTab),
          cwd: row.worktree.absolutePath,
          projectName: row.projectName,
          workerId: row.codeTab.activeWorkerId,
          worktreeId: row.worktree.id,
          worktreeName: row.worktree.name,
        }
      : null;
  }

  async updateCodeTab(
    ownerId: string,
    codeTabId: string,
    input: CodeTabUpdate,
  ): Promise<CodeTabSummary | null> {
    if (!(await this.getCodeTabExecutionContext(ownerId, codeTabId))) {
      return null;
    }
    const result = await this.database
      .update(schema.codeTabs)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(schema.codeTabs.id, codeTabId))
      .returning();
    return result[0] ? toCodeTabSummary(result[0]) : null;
  }

  async updateCodeTabWorktree(
    ownerId: string,
    codeTabId: string,
    input: WorktreeSelection,
  ): Promise<CodeTabSummary | null> {
    const context = await this.getCodeTabExecutionContext(ownerId, codeTabId);
    if (!context) return null;
    if (
      context.codeTab.status === "starting" ||
      context.codeTab.status === "running"
    ) {
      throw new Error("Stop Cantrip Code before changing its worktree.");
    }
    const target = await this.getProjectWorktreeContext(
      ownerId,
      context.codeTab.projectId,
      input.worktreeId,
    );
    if (!target || target.worktree.lifecycleState !== "ready") return null;
    const result = await this.database
      .update(schema.codeTabs)
      .set({
        activeWorkerId: target.workerId,
        worktreeId: target.worktree.id,
        status: "idle",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.codeTabs.id, codeTabId))
      .returning();
    return result[0] ? toCodeTabSummary(result[0]) : null;
  }

  async deleteCodeTab(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeTabExecutionContext | null> {
    const context = await this.getCodeTabExecutionContext(ownerId, codeTabId);
    if (!context) return null;
    await this.database.transaction(async (transaction) => {
      await detachProjectTab(
        transaction,
        context.codeTab.projectId,
        projectTabKey("code", codeTabId),
      );
      await transaction
        .delete(schema.codeTabs)
        .where(eq(schema.codeTabs.id, codeTabId));
    });
    return context;
  }

  async listCodeSessions(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeSessionSummary[] | null> {
    if (!(await this.getCodeTabExecutionContext(ownerId, codeTabId))) {
      return null;
    }
    const rows = await this.database
      .select()
      .from(schema.codeSessions)
      .where(eq(schema.codeSessions.codeTabId, codeTabId))
      .orderBy(
        desc(schema.codeSessions.updatedAt),
        desc(schema.codeSessions.createdAt),
      );
    return rows.map(toCodeSessionSummary);
  }

  async getOrCreateCodeSession(
    ownerId: string,
    codeTabId: string,
    editorBuild: CodeEditorBuild,
    preferredSessionId = randomUUID(),
  ): Promise<CodeSessionSummary | null> {
    const context = await this.getCodeTabExecutionContext(ownerId, codeTabId);
    if (!context) return null;
    const existing = await this.database
      .select()
      .from(schema.codeSessions)
      .where(
        and(
          eq(schema.codeSessions.codeTabId, codeTabId),
          eq(schema.codeSessions.workerId, context.workerId),
          eq(schema.codeSessions.worktreeId, context.worktreeId),
          eq(schema.codeSessions.profileId, context.codeTab.profileId),
          eq(schema.codeSessions.editorFingerprint, editorBuild.fingerprint),
        ),
      )
      .limit(1);
    if (existing[0]) return toCodeSessionSummary(existing[0]);
    const inserted = await this.database
      .insert(schema.codeSessions)
      .values({
        id: preferredSessionId,
        codeTabId,
        projectId: context.codeTab.projectId,
        workerId: context.workerId,
        worktreeId: context.worktreeId,
        profileId: context.codeTab.profileId,
        editorVersion: editorBuild.version,
        editorUpstreamRevision: editorBuild.upstreamRevision,
        editorPatchset: editorBuild.patchset,
        editorFingerprint: editorBuild.fingerprint,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return toCodeSessionSummary(inserted[0]);
    const raced = await this.database
      .select()
      .from(schema.codeSessions)
      .where(
        and(
          eq(schema.codeSessions.codeTabId, codeTabId),
          eq(schema.codeSessions.workerId, context.workerId),
          eq(schema.codeSessions.worktreeId, context.worktreeId),
          eq(schema.codeSessions.profileId, context.codeTab.profileId),
          eq(schema.codeSessions.editorFingerprint, editorBuild.fingerprint),
        ),
      )
      .limit(1);
    return raced[0] ? toCodeSessionSummary(raced[0]) : null;
  }

  async updateCodeSessionRuntime(
    ownerId: string,
    codeTabId: string,
    sessionId: string,
    runtime: CodeRuntimeStatus,
    attached = false,
  ): Promise<CodeSessionSummary | null> {
    const context = await this.getCodeTabExecutionContext(ownerId, codeTabId);
    if (!context || runtime.sessionId !== sessionId) return null;
    const tabStatus: CodeTabSummary["status"] =
      runtime.status === "starting"
        ? "starting"
        : runtime.status === "running" || runtime.status === "idle"
          ? "running"
          : runtime.status === "offline"
            ? "offline"
            : runtime.status === "failed"
              ? "failed"
              : "stopped";
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(schema.codeSessions)
        .set({
          status: runtime.status,
          processInstanceId: runtime.processInstanceId,
          ...(attached ? { lastAttachmentAt: new Date() } : {}),
          ...(runtime.startedAt
            ? { lastStartedAt: new Date(runtime.startedAt) }
            : {}),
          stoppedAt: runtime.status === "stopped" ? new Date() : null,
          lastError: runtime.lastError,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.codeSessions.id, sessionId),
            eq(schema.codeSessions.codeTabId, codeTabId),
            eq(schema.codeSessions.workerId, context.workerId),
            eq(
              schema.codeSessions.editorFingerprint,
              runtime.editorBuild.fingerprint,
            ),
          ),
        )
        .returning();
      const session = rows[0];
      if (!session) return null;
      await transaction
        .update(schema.codeTabs)
        .set({
          status: tabStatus,
          lastError: runtime.lastError,
          updatedAt: new Date(),
        })
        .where(eq(schema.codeTabs.id, codeTabId));
      return toCodeSessionSummary(session);
    });
  }

  async listBrowsers(
    ownerId: string,
    projectId: string,
  ): Promise<BrowserSummary[]> {
    const rows = await this.database
      .select({
        browser: schema.browsers,
        workerId: schema.remoteSurfaces.workerId,
      })
      .from(schema.browsers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.browsers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.remoteSurfaces,
        eq(schema.remoteSurfaces.id, schema.browsers.id),
      )
      .where(eq(schema.browsers.projectId, projectId))
      .orderBy(asc(schema.browsers.position), asc(schema.browsers.createdAt));
    return rows.map(({ browser, workerId }) =>
      toBrowserSummary(browser, workerId),
    );
  }

  async createBrowser(
    ownerId: string,
    projectId: string,
    input: BrowserCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<BrowserSummary | null> {
    const { placement } = await this.resolveProjectExecutionPlacement(
      ownerId,
      projectId,
      "browser",
      input.target,
      isWorkerConnected,
    );
    const position = await this.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const browserId = randomUUID();
      const result = await transaction
        .insert(schema.browsers)
        .values({
          id: browserId,
          projectId,
          title: input.title,
          position,
          ...(input.url ? { url: input.url } : {}),
        })
        .returning();
      const browser = firstOrThrow(result, "creating a browser");
      await transaction.insert(schema.remoteSurfaces).values({
        id: browserId,
        projectId,
        workerId: placement.workerId,
        kind: "browser",
        title: input.title,
        preferredTransport: "webrtc",
        configuration: {
          kind: "browser",
          initialUrl: browser.url,
          profileId: null,
        },
      });
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId: input.tabGroupId,
        tabId: browser.id,
        tabKind: "browser",
      });
      return toBrowserSummary(browser, placement.workerId);
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
      return toBrowserSummary(browser, surface?.workerId ?? null);
    });
  }

  async deleteBrowser(ownerId: string, browserId: string): Promise<boolean> {
    const context = await this.getRemoteSurfaceExecutionContext(
      ownerId,
      browserId,
    );
    if (!context || context.surface.kind !== "browser") return false;
    return this.database.transaction(async (transaction) => {
      await detachProjectTab(
        transaction,
        context.surface.projectId,
        projectTabKey("browser", browserId),
      );
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
      .leftJoin(
        schema.remoteSurfaces,
        eq(schema.remoteSurfaces.id, schema.browsers.id),
      )
      .where(isNull(schema.remoteSurfaces.id));
    if (rows.length === 0) return;
    const values = (
      await Promise.all(
        rows.map(async ({ browser }) => ({
          browser,
          source: await this.getProjectSource(ownerId, browser.projectId),
        })),
      )
    ).flatMap(({ browser, source }) =>
      source ? [{ browser, workerId: source.workerId }] : [],
    );
    if (values.length === 0) return;
    await this.database
      .insert(schema.remoteSurfaces)
      .values(
        values.map(({ browser, workerId }) => ({
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
      )
      .onConflictDoNothing();
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
    tabGroupId?: string,
    target: RemoteDesktopTarget = { kind: "monitor", id: null, name: null },
  ): Promise<RemoteDesktopSummary | null> {
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
            eq(schema.workers.id, workerId),
            eq(schema.workers.ownerId, ownerId),
          ),
        )
        .limit(1),
    ]);
    if (!projectRows[0] || !workerRows[0]) return null;
    const position = await this.nextProjectTabPosition(projectId);
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
          target,
        },
      });
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId,
        tabId: desktopId,
        tabKind: "remote-desktop",
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

  async getProjectViewProjectId(
    ownerId: string,
    viewId: string,
  ): Promise<string | null> {
    const rows = await this.database
      .select({ projectId: schema.projectViews.projectId })
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
    return rows[0]?.projectId ?? null;
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
    const position = await this.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .insert(schema.projectViews)
        .values({
          id: randomUUID(),
          projectId,
          title: input.title,
          kind: input.kind,
          worktreeId: input.kind === "history" ? worktreeId : null,
          position,
        })
        .returning();
      const view = firstOrThrow(result, "creating a project view");
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId: input.tabGroupId,
        tabId: view.id,
        tabKind: input.kind,
      });
      return toProjectViewSummary(view);
    });
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
    if (!view) return false;
    const result = await this.database.transaction(async (transaction) => {
      await detachProjectTab(
        transaction,
        view.projectId,
        projectTabKey(view.kind as ProjectViewSummary["kind"], viewId),
      );
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
    await this.database.transaction(async (transaction) => {
      await detachProjectTab(
        transaction,
        context.projectId,
        projectTabKey("terminal", terminalId),
      );
      await transaction
        .delete(schema.terminals)
        .where(eq(schema.terminals.id, terminalId));
    });
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
          projectId: row.terminal.projectId,
          rootKind: row.worktree.rootKind,
          workerId: row.terminal.activeWorkerId,
          worktreeId: row.worktree.id,
          cwd: terminalWorkingDirectory(
            row.worktree.absolutePath,
            row.terminal.directoryPath,
          ),
          linkedChatId: row.terminal.linkedChatId,
          service: {
            enabled: row.terminal.serviceEnabled,
            command: row.terminal.serviceCommand,
          },
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
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    if (!owned[0]) return null;
    const result = await this.database
      .update(schema.chats)
      .set({ title: input.title, updatedAt: new Date() })
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
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
      chat.activeWorkerId !== null &&
      chat.activeWorkerId !== target.workerId
    ) {
      throw new ExecutionLaneConflictError(
        "Moving a chat to another worker requires a durable relocation.",
      );
    }
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
          ...(changingWorktree
            ? {
                placementRevision: sql`${schema.chats.placementRevision} + 1`,
              }
            : {}),
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
  ): Promise<false | "archived" | "deleted" | "running"> {
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
    if (!chat || chat.archivedAt) return false;
    if (chatIsExecuting(chat.status as ChatSummary["status"])) return "running";
    return this.database.transaction(async (transaction) => {
      const messages = await transaction
        .select({ id: schema.chatMessages.id })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.chatId, chatId))
        .limit(1);
      await detachProjectTab(
        transaction,
        chat.projectId,
        projectTabKey("chat", chatId),
      );
      if (messages[0]) {
        await transaction
          .update(schema.chats)
          .set({
            archivedAt: new Date(),
            automationPaused: true,
            status: "idle",
            updatedAt: new Date(),
          })
          .where(eq(schema.chats.id, chatId));
        return "archived";
      }
      await transaction.delete(schema.chats).where(eq(schema.chats.id, chatId));
      return "deleted";
    });
  }

  async restoreArchivedChat(
    ownerId: string,
    chatId: string,
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
      .where(
        and(eq(schema.chats.id, chatId), isNotNull(schema.chats.archivedAt)),
      )
      .limit(1);
    const chat = rows[0]?.chat;
    if (!chat) return null;
    const position = await this.nextProjectTabPosition(chat.projectId);
    return this.database.transaction(async (transaction) => {
      const restored = await transaction
        .update(schema.chats)
        .set({ archivedAt: null, position, updatedAt: new Date() })
        .where(eq(schema.chats.id, chatId))
        .returning();
      await attachProjectTab(transaction, {
        projectId: chat.projectId,
        tabId: chatId,
        tabKind: "chat",
      });
      return toChatSummary(firstOrThrow(restored, "restoring a chat"));
    });
  }

  async permanentlyDeleteArchivedChat(
    ownerId: string,
    chatId: string,
  ): Promise<boolean> {
    const deleted = await this.database
      .delete(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          isNotNull(schema.chats.archivedAt),
          inArray(
            schema.chats.projectId,
            this.database
              .select({ id: schema.projects.id })
              .from(schema.projects)
              .where(eq(schema.projects.ownerId, ownerId)),
          ),
        ),
      )
      .returning({ id: schema.chats.id });
    return deleted.length > 0;
  }

  async purgeExpiredArchivedChats(
    ownerId: string,
    cutoff: Date,
  ): Promise<number> {
    const deleted = await this.database
      .delete(schema.chats)
      .where(
        and(
          isNotNull(schema.chats.archivedAt),
          lte(schema.chats.archivedAt, cutoff),
          inArray(
            schema.chats.projectId,
            this.database
              .select({ id: schema.projects.id })
              .from(schema.projects)
              .where(eq(schema.projects.ownerId, ownerId)),
          ),
        ),
      )
      .returning({ id: schema.chats.id });
    return deleted.length;
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
          and(
            eq(
              schema.projectWorktrees.id,
              input.worktreeId ?? row.chat.activeWorktreeId,
            ),
            isNull(schema.projectSources.removedAt),
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
      const [
        lastChats,
        lastTerminals,
        lastExplorers,
        lastCodeTabs,
        lastBrowsers,
        lastViews,
      ] = await Promise.all([
        transaction
          .select({ position: schema.chats.position })
          .from(schema.chats)
          .where(eq(schema.chats.projectId, row.chat.projectId))
          .orderBy(desc(schema.chats.position))
          .limit(1),
        transaction
          .select({ position: schema.terminals.position })
          .from(schema.terminals)
          .where(eq(schema.terminals.projectId, row.chat.projectId))
          .orderBy(desc(schema.terminals.position))
          .limit(1),
        transaction
          .select({ position: schema.explorers.position })
          .from(schema.explorers)
          .where(eq(schema.explorers.projectId, row.chat.projectId))
          .orderBy(desc(schema.explorers.position))
          .limit(1),
        transaction
          .select({ position: schema.codeTabs.position })
          .from(schema.codeTabs)
          .where(eq(schema.codeTabs.projectId, row.chat.projectId))
          .orderBy(desc(schema.codeTabs.position))
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
              lastCodeTabs[0]?.position ?? -1,
              lastBrowsers[0]?.position ?? -1,
              lastViews[0]?.position ?? -1,
            ) + 1,
          activeWorkerId: target.workerId,
          activeWorktreeId: target.id,
          worktreeMode: input.worktreeMode ?? row.chat.worktreeMode,
          modelId: row.chat.modelId,
          reasoningEffort: row.chat.reasoningEffort,
          permissionProfileId: row.chat.permissionProfileId,
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
      await attachProjectTab(transaction, {
        projectId: row.chat.projectId,
        tabId: fork.id,
        tabKind: "chat",
      });
      if (sourceMessages.length > 0) {
        await transaction.insert(schema.chatMessages).values(
          sourceMessages.map((message) => ({
            id: randomUUID(),
            chatId: fork.id,
            worktreeId: message.worktreeId,
            executionLaneId: null,
            role: message.role,
            mode: message.mode,
            content: message.content,
            modelId: message.modelId,
            modelRouteId: message.modelRouteId,
            providerId: message.providerId,
            providerName: message.providerName,
            providerModelName: message.providerModelName,
            reasoningEffort: message.reasoningEffort,
            appliedReasoningEffort: message.appliedReasoningEffort,
            reasoningAdjusted: message.reasoningAdjusted,
            createdAt: message.createdAt,
          })),
        );
      }
      const forkBoundary = sourceMessages.at(-1)?.createdAt ?? new Date();
      const behaviorRows = await transaction
        .select({ id: schema.modelBehaviorObservations.id })
        .from(schema.modelBehaviorObservations)
        .where(
          and(
            eq(schema.modelBehaviorObservations.ownerId, ownerId),
            eq(schema.modelBehaviorObservations.chatId, chatId),
            lte(schema.modelBehaviorObservations.startedAt, forkBoundary),
          ),
        )
        .orderBy(desc(schema.modelBehaviorObservations.startedAt))
        .limit(1);
      if (behaviorRows[0]) {
        await transaction
          .update(schema.modelBehaviorObservations)
          .set({
            forkCount: sql`${schema.modelBehaviorObservations.forkCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(schema.modelBehaviorObservations.id, behaviorRows[0].id));
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

  async setChatModel(
    ownerId: string,
    chatId: string,
    input: ChatModelUpdate,
    reasoningEffort?: ReasoningEffort | null,
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
      .set({
        modelId: input.modelId,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId))
      .returning();
    return toChatSummary(firstOrThrow(result, "selecting a chat model"));
  }

  async setChatReasoningEffort(
    ownerId: string,
    chatId: string,
    reasoningEffort: ReasoningEffort | null,
  ): Promise<ChatSummary | null> {
    const result = await this.database
      .update(schema.chats)
      .set({ reasoningEffort, updatedAt: new Date() })
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
    return result[0] ? toChatSummary(result[0]) : null;
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
  ): Promise<ChatSummary | null> {
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
          and(
            eq(schema.chats.id, chatId),
            inArray(
              schema.chats.projectId,
              transaction
                .select({ id: schema.projects.id })
                .from(schema.projects)
                .where(eq(schema.projects.ownerId, ownerId)),
            ),
          ),
        )
        .returning();
      if (!result[0]) return null;

      await transaction
        .update(schema.modelProfiles)
        .set({ defaultReasoningEffort: reasoningEffort, updatedAt: new Date() })
        .where(eq(schema.modelProfiles.id, modelId));
      return toChatSummary(result[0]);
    });
  }

  async setChatPermissionProfile(
    ownerId: string,
    chatId: string,
    permissionProfileId: string | null,
  ): Promise<ChatSummary | null> {
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
    if (!chats[0]) return null;
    const result = await this.database
      .update(schema.chats)
      .set({ permissionProfileId, updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId))
      .returning();
    return result[0] ? toChatSummary(result[0]) : null;
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
        settings: schema.userSettings,
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
      .leftJoin(
        schema.userSettings,
        eq(schema.userSettings.userId, schema.projects.ownerId),
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
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      automationPaused: row.chat.automationPaused,
      chatId: row.chat.id,
      cwd: row.worktree.absolutePath,
      experience: row.chat.experience as ChatSummary["experience"],
      defaultPermissionProfileId:
        (row.settings?.defaultPermissionProfileId as
          UserSettings["defaultPermissionProfileId"] | undefined) ??
        DEFAULT_PERMISSION_PROFILE_ID,
      executionLaneId: row.lane?.id ?? null,
      isPrimary: row.worktree.isPrimary,
      modelId: row.chat.modelId,
      reasoningEffort: row.chat.reasoningEffort,
      modelRouteId: row.runtime?.modelRouteId ?? null,
      providerAccountId: row.runtime?.providerAccountId ?? null,
      permissionProfileId: row.chat.permissionProfileId,
      planMode: row.chat.planMode as PlanMode,
      pendingPlanQuestion: row.chat.pendingPlanQuestion,
      projectId: row.chat.projectId,
      rootKind: row.worktree.rootKind,
      status: row.chat.status as ChatSummary["status"],
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.worktree.workerId,
      worktreeId: row.worktree.id,
      worktreeMode: row.chat.worktreeMode as ChatSummary["worktreeMode"],
      worktreePolicy: row.project.worktreePolicy as WorktreePolicy,
    };
  }

  async listChatExecutionContextsByThreadId(
    ownerId: string,
    workerId: string,
    threadId: string,
  ): Promise<ChatExecutionContext[]> {
    const rows = await this.database
      .select({ chatId: schema.chatRuntimeSessions.chatId })
      .from(schema.chatRuntimeSessions)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatRuntimeSessions.chatId),
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
          eq(schema.chatRuntimeSessions.workerId, workerId),
          eq(schema.chatRuntimeSessions.codexThreadId, threadId),
          isNull(schema.chats.archivedAt),
        ),
      );
    const contexts = await Promise.all(
      [...new Set(rows.map(({ chatId }) => chatId))].map((chatId) =>
        this.getChatExecutionContext(ownerId, chatId),
      ),
    );
    return contexts.filter(
      (context): context is ChatExecutionContext =>
        context !== null &&
        context.workerId === workerId &&
        context.threadId === threadId,
    );
  }

  async updateChatRuntime(
    chatId: string,
    workerId: string,
    worktreeId: string,
    threadId: string | null,
    modelRouteId: string,
    status = "ready",
    providerAccountId?: string | null,
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
        providerAccountId: providerAccountId ?? null,
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
          ...(providerAccountId === undefined ? {} : { providerAccountId }),
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

  async getAgentInteractionRequestByKey(
    ownerId: string,
    requestKey: string,
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
      .where(eq(schema.agentInteractionRequests.requestKey, requestKey))
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

  async validateAgentInteractionResolution(
    ownerId: string,
    requestId: string,
    input: AgentInteractionResolutionCreate,
  ): Promise<AgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const existing = await this.getAgentInteractionRequest(ownerId, requestId);
    if (!existing) return null;
    validateAgentInteractionResponse(existing.payload, input.response);
    return existing;
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

  async terminalizeAgentInteractionRequestFromWorker(
    requestKey: string,
    chatId: string,
    workerId: string,
    status: "expired" | "interrupted",
  ): Promise<AgentInteractionRequest | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.requestKey, requestKey),
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(schema.agentInteractionRequests.workerId, workerId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    if (!rows[0]) return null;
    await this.restoreChatAfterInteractions(chatId);
    return toAgentInteractionRequest(rows[0]);
  }

  async createChatAttachment(
    ownerId: string,
    chatId: string,
    input: {
      fileName: string;
      id: string;
      kind: ChatAttachmentKind;
      mimeType: string;
      previewText: string | null;
      sha256: string;
      sizeBytes: number;
      source: ChatAttachmentSource;
      workerId: string;
    },
  ): Promise<ChatAttachmentRecord | null> {
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
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    if (!owned[0]) return null;
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .insert(schema.chatAttachments)
        .values({
          ...input,
          chatId,
          status: "ready",
        })
        .returning();
      const attachment = firstOrThrow(rows, "creating an attachment");
      await transaction.insert(schema.chatAttachmentReplicas).values({
        attachmentId: attachment.id,
        workerId: input.workerId,
        status: "ready",
      });
      return toChatAttachment(attachment);
    });
  }

  async getChatAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const rows = await this.database
      .select({ attachment: schema.chatAttachments })
      .from(schema.chatAttachments)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatAttachments.chatId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatAttachments.id, attachmentId))
      .limit(1);
    return rows[0] ? toChatAttachment(rows[0].attachment) : null;
  }

  async getChatAttachments(
    ownerId: string,
    chatId: string,
    attachmentIds: string[],
  ): Promise<ChatAttachmentRecord[]> {
    if (attachmentIds.length === 0) return [];
    const rows = await this.database
      .select({ attachment: schema.chatAttachments })
      .from(schema.chatAttachments)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatAttachments.chatId),
          eq(schema.chats.id, chatId),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(inArray(schema.chatAttachments.id, attachmentIds));
    const byId = new Map(
      rows.map(({ attachment }) => [
        attachment.id,
        toChatAttachment(attachment),
      ]),
    );
    return attachmentIds.flatMap((id) => {
      const attachment = byId.get(id);
      return attachment ? [attachment] : [];
    });
  }

  async deleteChatAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const attachment = await this.getChatAttachment(ownerId, attachmentId);
    if (!attachment) return null;
    await this.database
      .delete(schema.chatAttachments)
      .where(eq(schema.chatAttachments.id, attachmentId));
    return attachment;
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
    attachments: ChatAttachmentSummary[] = [],
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
    attachments?: ChatAttachmentSummary[],
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
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
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
