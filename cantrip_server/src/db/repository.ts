import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_PERMISSION_PROFILE_ID,
  archivedChatWireSummarySchema,
  archivedStandaloneChatWireSummarySchema,
  encryptedAgentInteractionRequestSchema,
  agentInteractionRequestSchema,
  chatMessageOpaqueContentSchema,
  chatMessageOpaqueSummarySchema,
  chatWireSummarySchema,
  contextualChatWireSummarySchema,
  standaloneChatWireSummarySchema,
  encryptedChatComposerDraftWireStateSchema,
  chatComposerDraftOpaqueStateSchema,
  chatPlanOpaqueStateSchema,
  encryptedChatPlanWireStateSchema,
  encryptedQueuedPromptSchema,
  modelConfigurationSchema,
  queuedPromptOpaqueContentSchema,
  taskMessageOpaqueContentSchema,
  taskMessageOpaqueSummarySchema,
} from "@cantrip/protocol";
import type {
  RunConfigurationRuntime,
  RunConfigurationRuntimeFailure,
  RunConfigurationRuntimeObservationApplyResult,
  RunConfigurationRuntimeOperation,
  RunConfigurationRuntimeOperationRecord,
  RunConfigurationRuntimeOperationResult,
  RunConfigurationRuntimeWorkerIdentity,
  RunConfigurationRuntimeWorkerObservation,
} from "@cantrip/protocol/run-configuration-runtime";
import {
  runConfigurationProtectedSecretListSchema,
  runConfigurationSecretSetRequestSchema,
  runConfigurationSecretSetResultSchema,
  runConfigurationSecretSummaryListSchema,
  type RunConfigurationProtectedSecret,
  type RunConfigurationSecretSetResult,
  type RunConfigurationSecretSummary,
} from "@cantrip/protocol/run-configuration-secrets";
import type {
  AppDestination,
  AppDestinationUpdate,
  AgentInteractionRequest,
  AgentInteractionRequestCreate,
  AgentInteractionRequestPayload,
  AgentInteractionRequestQuery,
  AgentInteractionResolutionCreate,
  AgentInteractionResponse,
  AgentInteractionRequestWire,
  EncryptedAgentInteractionRequest,
  EncryptedAgentInteractionRequestCreate,
  EncryptedAgentInteractionResolutionCreate,
  ArchivedChatWireSummary,
  AccountLicenseWhitelistEntry,
  AccountSessionSummary,
  AuditEvent,
  AuditEventList,
  AuditEventQuery,
  BrowserWireSummary,
  EncryptedBrowserCreate,
  EncryptedBrowserUpdate,
  EncryptedChatCreate,
  EncryptedStandaloneChatCreate,
  ChatExperience,
  ChatExecutionLaneSummary,
  ContextualChatExecutionLaneSummary,
  EncryptedChatFork,
  ChatModelUpdate,
  ChatPlanOpaqueState,
  ChatMessage,
  ChatMessageCreate,
  ChatMessagePageInfo,
  ChatMessagePageQuery,
  ChatWireSummary,
  ContextualChatWireSummary,
  StandaloneChatWireSummary,
  StandaloneChatRootStatus,
  ArchivedStandaloneChatWireSummary,
  StandaloneChatRootJobSummary,
  ChatModelConfigurationUpdate,
  EncryptedChatUpdate,
  ChatWorktreeUpdate,
  CodeCapabilities,
  CodeEditorBuild,
  CodeRuntimeStatus,
  CodeSessionSummary,
  EncryptedCodeTabCreate,
  CodeTabWireSummary,
  AgentTimeSummary,
  DetailedTokenUsageTotals,
  EncryptedCodeTabUpdate,
  DesktopUpdateActiveWorkSummary,
  EncryptedExplorerCreate,
  EncryptedExplorerPin,
  EncryptedExplorerViewStateUpdate,
  EncryptedExplorerWorktreeUpdate,
  ExplorerWireSummary,
  EncryptedExplorerUpdate,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  ExecutionTargetWireCatalog,
  ExecutionTargetResolution,
  EncryptedGithubProjectCreate,
  EncryptedManagedFolderProjectCreate,
  GitManagedOperationContext,
  GitManagedOperationRecord,
  GitManagedOperationWorkerState,
  ModelProfileCreate,
  ModelProfileSummary,
  ModelProfileUpdate,
  ModelConfiguration,
  EncryptedMcpServerCreate,
  EncryptedMcpServerUpdate,
  McpServerOpaqueRuntime,
  McpServerWireSummary,
  EncryptedModelProviderAccountCreate,
  EncryptedModelProviderAccountUpdate,
  ModelProviderAccountWireSummary,
  EncryptedModelProviderCreate,
  ProviderCatalogSyncState,
  ProviderModelAvailability,
  ProviderModelCatalogEntry,
  ProviderModelCatalogResult,
  ModelProviderSummary,
  ModelProviderWireSummary,
  EncryptedModelProviderUpdate,
  ModelRouteSummary,
  EncryptedChatPlanWireState,
  PlanMode,
  PrivateDisplayLabelOpaque,
  OrderedIds,
  QueuedPrompt,
  QueuedPromptCreate,
  QueuedPromptOrder,
  QueuedPromptUpdate,
  ReasoningEffort,
  RemoteDesktopWireSummary,
  RemoteSurfaceCapabilities,
  ResourceAudience,
  EncryptedRemoteSurfaceCreate,
  RemoteSurfaceStatus,
  RemoteSurfaceWireSummary,
  SurfacePrivateStateOpaque,
  EncryptedRemoteSurfaceUpdate,
  ProjectCloneResult,
  ProjectFolderSetupJobSummary,
  ProjectReplicaSummary,
  ProjectWireSummary,
  ProjectTokenUsage,
  ProviderTelemetryWireAnalytics,
  ProviderTelemetryDeleteResult,
  ProviderTelemetryExport,
  EncryptedProjectWorkspaceCreate,
  EncryptedProjectWorkspaceUpdate,
  ProjectWorkspaceWireList,
  ProjectWorkspaceWireSummary,
  ProjectWorktreePolicyUpdate,
  ProjectWorktreeSummary,
  EncryptedProjectViewCreate,
  ProjectViewWireSummary,
  EncryptedProjectViewUpdate,
  SettingsBundleWire,
  EncryptedTerminalCreate,
  EncryptedTerminalServiceConfiguration,
  TerminalServiceRuntimeConfiguration,
  TerminalWireSummary,
  EncryptedTerminalUpdate,
  EncryptedTaskCreate,
  TaskWireCreateResult,
  TaskOpaqueSummary,
  TaskMessageOpaqueContent,
  TaskMessageOpaqueSummary,
  ChatMessageOpaqueContent,
  ChatMessageOpaqueSummary,
  ChatComposerDraftOpaqueState,
  EncryptedChatComposerDraftWireState,
  EncryptedQueuedPrompt,
  QueuedPromptOpaqueContent,
  ThemePreference,
  TunnelAttachmentWireSummary,
  TunnelDestinationEndpoint,
  TunnelManagedRegistration,
  TunnelSourceEndpoint,
  TunnelWireSummary,
  TunnelUserWireCreate,
  TunnelUserWireUpdate,
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
  type ProtectedTunnelContentRecord,
  type TunnelContentErrorCode,
  type TunnelPublicDestinationEndpoint,
  type TunnelPublicSourceEndpoint,
} from "@cantrip/protocol/tunnel-content";
import {
  chatAttachmentOpaqueSummarySchema,
  type AttachmentProtectedMetadata,
  type ChatAttachmentOpaqueSummary,
} from "@cantrip/protocol/attachment-content";
import type {
  ProtectedProviderCredential,
  ProtectedSecretEnvelope,
  ProviderCredentialPublicMetadata,
} from "@cantrip/protocol/protected-secrets";
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

import {
  CHAT_MESSAGE_PAGE_BOUNDARY_MAX,
  selectChatMessagePageWindow,
} from "./chat-message-pagination.js";
import { CodeSettingsRepository } from "./code-settings.js";
import type { QuotaTokenAnalytics } from "../analytics/quota-token.js";
import type { SecretVault } from "../security/secret-vault.js";
import { AccountResourceUsageRepository } from "./account-resource-usage.js";
import * as schema from "./schema.js";
import { ChatImportJobRepository } from "./chat-import-jobs.js";
import { ChatRelocationJobRepository } from "./chat-relocation-jobs.js";
import {
  acquireChatLogicalBranchLease,
  LogicalBranchLeaseConflictError,
  releaseChatLogicalBranchLease,
} from "./logical-branch-leases.js";
import { ProjectAutomationRepository } from "./project-automations.js";
import {
  AccountRepository,
  type AccountCredentialRecord,
  type ActiveUserSession,
  type AuditEventCreate,
  type UserSessionRow,
} from "./repository/accounts.js";
import {
  ProviderAccountRepository,
  ProviderCredentialIdentityConflictError,
  ProviderCredentialRevisionConflictError,
  toProviderAccountSummary,
  type ModelProviderAccountRuntime,
  type ProviderAccountCredentialMigrationRecord,
  type ProviderAccountCredentialRecord,
  type ProviderAccountCredentialSignOutRecord,
  type ProviderAccountCredentialState,
} from "./repository/provider-accounts.js";
import {
  ProviderCatalogRepository,
  toProviderSummary,
  type ModelProviderCatalogRuntime,
  type ModelProviderCatalogTarget,
  type ModelProviderRefreshTarget,
  type ProviderModelCatalogWrite,
} from "./repository/provider-catalog.js";
import {
  ModelRepository,
  toModelRouteSummary,
  toModelSummary,
  type ModelRuntime,
} from "./repository/model-runtime.js";
import {
  WorkerRepository,
  toWorkerSummary,
  type ActiveWorkerCredential,
  type WorkerEnrollmentProvision,
  type WorkerManagementRecord,
} from "./repository/workers.js";
import {
  TunnelRepository,
  type DesktopTunnelAttachmentLeaseChange,
  type DesktopTunnelAttachmentStopFence,
  type TunnelAttachmentAuthorization,
} from "./repository/tunnels.js";
import { McpRepository } from "./repository/mcp.js";
import {
  ProjectRepository,
  ProjectWorkspaceInvariantError,
  toProjectWireSummary,
  toProjectWorktreeSummary,
  type ProjectWorkspaceRow,
  type ProjectWorktreeExecutionContext,
} from "./repository/projects.js";
import {
  ExecutionPlacementUnavailableError,
  PlacementRepository,
} from "./repository/placement.js";
import {
  ExecutionTargetRepository,
  type ExecutionTargetSelectorResult,
  type FocusedExecutionTargetResourceKind,
} from "./repository/execution-targets.js";
import {
  WorktreeStateRepository,
  observedWorktreeLifecycle,
  type ProjectWorktreeObservationContext,
  type ProjectWorktreeStatusRecord,
} from "./repository/worktree-state.js";
import {
  TelemetryRepository,
  ZERO_AGENT_TIME,
  ZERO_TOKEN_USAGE,
  tokenUsageTotals,
  type AgentTimeAnalytics,
  type ModelBehaviorObservationInput,
  type ProviderQuotaObservationInput,
  type QuotaTokenAnalyticsQuery,
  type TokenUsageRecordInput,
} from "./repository/telemetry.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
  type RepositoryTransaction,
} from "./repository/database.js";
import { ProjectFolderSetupJobRepository } from "./project-folder-setup-jobs.js";
import { StandaloneChatRootJobRepository } from "./standalone-chat-root-jobs.js";
import { ProjectGithubConversionJobRepository } from "./project-github-conversion-jobs.js";
import { EncryptionRegistryRepository } from "./encryption-registry.js";
import { PolicyRepository } from "./policies.js";
import { ProjectReplicaJobRepository } from "./project-replica-jobs.js";
import {
  TaskRepository,
  taskOpaqueColumns,
  toTaskOpaqueSummary,
} from "./tasks.js";
import { TaskSchedulingRepository } from "./task-scheduling.js";
import { TaskDispatchRepository } from "./task-dispatch.js";
import { WorkflowRunRepository } from "./workflow-runs.js";
import { WorkflowRepository } from "./workflows.js";
import { WorkflowTriggerRepository } from "./workflow-triggers.js";
import {
  attachProjectTab,
  detachProjectTab,
  projectTabKey,
  ProjectTabLayoutRepository,
} from "./tab-layouts.js";

export type { RepositoryDatabase } from "./repository/database.js";
export {
  LOCAL_USER_ID,
  type AccountCredentialRecord,
  type ActiveUserSession,
  type AuditEventCreate,
} from "./repository/accounts.js";
export {
  ProviderCredentialIdentityConflictError,
  ProviderCredentialRevisionConflictError,
  type ModelProviderAccountRuntime,
  type ProviderAccountCredentialMigrationRecord,
  type ProviderAccountCredentialRecord,
  type ProviderAccountCredentialSignOutRecord,
  type ProviderAccountCredentialState,
} from "./repository/provider-accounts.js";
export type {
  ModelProviderCatalogRuntime,
  ModelProviderCatalogTarget,
  ModelProviderRefreshTarget,
  ProviderModelCatalogWrite,
} from "./repository/provider-catalog.js";
export type { ModelRuntime } from "./repository/model-runtime.js";
export {
  WORKER_ONLINE_WINDOW_MS,
  WorkerEnrollmentError,
  type ActiveWorkerCredential,
  type WorkerEnrollmentProvision,
  type WorkerManagementRecord,
} from "./repository/workers.js";
export {
  TunnelManagementError,
  type DesktopTunnelAttachmentLeaseChange,
  type DesktopTunnelAttachmentStopFence,
  type TunnelAttachmentAuthorization,
} from "./repository/tunnels.js";
export {
  ManagedMcpServerInvariantError,
  McpServerWorkerBindingError,
} from "./repository/mcp.js";
export {
  ProjectWorkspaceInvariantError,
  type ProjectWorktreeExecutionContext,
} from "./repository/projects.js";
export {
  ExecutionPlacementUnavailableError,
  workerIsOnlineForPlacement,
} from "./repository/placement.js";
export type {
  ProjectWorktreeObservationContext,
  ProjectWorktreeStatusRecord,
} from "./repository/worktree-state.js";
export type {
  ModelBehaviorObservationInput,
  ProviderQuotaObservationInput,
  QuotaTokenAnalyticsQuery,
  TokenUsageRecordInput,
} from "./repository/telemetry.js";

export const DEFAULT_OLLAMA_PROVIDER_ID =
  "00000000-0000-0000-0000-000000000010";
export const DEFAULT_MODEL_ID = "00000000-0000-0000-0000-000000000020";
export const DEFAULT_MODEL_ROUTE_ID = "00000000-0000-0000-0000-000000000021";
export const ARCHIVED_CHAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
type RunConfigurationRuntimeRow =
  typeof schema.runConfigurationRuntimes.$inferSelect;
type RunConfigurationRuntimeOperationRow =
  typeof schema.runConfigurationRuntimeOperations.$inferSelect;
type RunConfigurationSecretRow =
  typeof schema.runConfigurationSecrets.$inferSelect;
type RunConfigurationSecretOperationRow =
  typeof schema.runConfigurationSecretOperations.$inferSelect;

interface RunConfigurationRuntimeOperationRequestBase {
  operationId: string;
  projectId: string;
  configurationId: string;
  worktreeId: string;
  workerId: string;
}

export type RunConfigurationRuntimeOperationRequest =
  | (RunConfigurationRuntimeOperationRequestBase & {
      operation: Extract<RunConfigurationRuntimeOperation, "start" | "restart">;
      definitionRevision: string;
      codexEnvironmentRevision: string | null;
    })
  | (RunConfigurationRuntimeOperationRequestBase & {
      operation: Extract<RunConfigurationRuntimeOperation, "stop">;
      definitionRevision: null;
      codexEnvironmentRevision: null;
    });

interface ChatExecutionContextBase {
  automationPaused: boolean;
  chatId: string;
  cwd: string;
  experience: ChatWireSummary["experience"];
  defaultPermissionProfileId?: UserSettings["defaultPermissionProfileId"];
  executionLaneId: string | null;
  isPrimary: boolean;
  status: ChatWireSummary["status"];
  modelId: string | null;
  reasoningEffort: ReasoningEffort | null;
  modelConfiguration: ModelConfiguration;
  modelRouteId: string | null;
  providerAccountId: string | null;
  permissionProfileId: string | null;
  planMode: PlanMode;
  threadId: string | null;
  workerId: string;
}

export interface ProjectChatExecutionContext extends ChatExecutionContextBase {
  contextKind: "project";
  projectId: string;
  rootKind: ProjectWorktreeSummary["rootKind"];
  scratchRootId: null;
  worktreeId: string;
  worktreeMode: ChatWireSummary["worktreeMode"];
  worktreePolicy: WorktreePolicy;
}

export interface StandaloneChatExecutionContext extends ChatExecutionContextBase {
  contextKind: "standalone";
  projectId: null;
  rootKind: null;
  scratchRootStatus: StandaloneChatRootStatus;
  scratchRootId: string;
  worktreeId: null;
  worktreeMode: null;
  worktreePolicy: null;
}

export type ChatExecutionContext =
  ProjectChatExecutionContext | StandaloneChatExecutionContext;

export interface ChatLiveRouting {
  experience: ChatWireSummary["experience"];
  projectId: string | null;
}

export interface ChatAttachmentRecord extends ChatAttachmentOpaqueSummary {
  workerId: string;
}

export function toChatAttachmentOpaqueSummary(
  attachment: ChatAttachmentRecord,
): ChatAttachmentOpaqueSummary {
  return chatAttachmentOpaqueSummarySchema.parse({
    id: attachment.id,
    chatId: attachment.chatId,
    sizeBytes: attachment.sizeBytes,
    status: attachment.status,
    protectedMetadata: attachment.protectedMetadata,
    createdAt: attachment.createdAt,
  });
}

export class ExecutionLaneConflictError extends Error {}
export class StandaloneChatPlacementUnavailableError extends Error {}
export class SurfacePrivateStateConflictError extends Error {}
export class AgentInteractionConflictError extends Error {}
export class CodeCapabilityUnavailableError extends Error {}
class StaleCodeSessionRuntimeError extends Error {}

export interface TerminalExecutionContext {
  kind: TerminalWireSummary["kind"];
  linkedChatId: string | null;
  projectId: string;
  rootKind: ProjectWorktreeSummary["rootKind"];
  serviceEnabled: boolean;
  stateProtection: TerminalWireSummary["stateProtection"];
  status: TerminalWireSummary["status"];
  terminalId: string;
  workerId: string;
  worktreePath: string;
  worktreeId: string;
  runConfigurationId: string | null;
  runConfigurationRuntimeId: string | null;
}

export interface ProjectRemovalContext {
  convertedManagedFolderSource: {
    localFilesDeleted: boolean;
    projectSourceId: string;
    workerId: string;
  } | null;
  folderManagement: ProjectWireSummary["folderManagement"];
  originKind: ProjectWireSummary["originKind"];
  preferredWorkerId: string | null;
  replicas: Array<{
    cwd: string;
    id: string;
    workerId: string;
  }>;
  remoteSurfaces: Array<{ id: string; workerId: string }>;
  setupStatus: ProjectWireSummary["setupStatus"];
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

export interface WorktreeRemovalBlockers {
  activeChatIds: string[];
  activeLeaseChatIds: string[];
  boundCodeTabIds: string[];
  runningTerminalIds: string[];
  workflowLeaseIds: string[];
}

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

export type ChatExecutionRecoveryContext =
  | ChatExecutionLaneContext
  | {
      chat: StandaloneChatWireSummary;
      lane: ContextualChatExecutionLaneSummary & {
        contextKind: "standalone";
      };
      root: {
        id: string;
        pathHandle: string;
        workerId: string;
      };
    };

export interface ChatExecutionLaneContext {
  chat: ChatWireSummary;
  lane: ChatExecutionLaneSummary;
  sourcePath: string;
  worktree: ProjectWorktreeSummary;
}

export interface ChatExecutionLaneReleaseResult {
  chat: ChatWireSummary;
  lane: ChatExecutionLaneSummary;
  returnedToPrimary: boolean;
}

export interface ChatWorktreeTransitionResult {
  chat: ChatWireSummary;
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
  codeTab: CodeTabWireSummary;
  cwd: string;
  workerId: string;
  worktreeId: string;
  worktreeName: string;
}

export interface RemoteSurfaceExecutionContext {
  remoteSurfaceCapabilities: RemoteSurfaceCapabilities;
  surface: RemoteSurfaceWireSummary;
  workerId: string;
}

function chatIsExecuting(status: ChatWireSummary["status"]): boolean {
  return status === "running" || status === "waiting-for-approval";
}

function toRunConfigurationRuntime(
  runtime: RunConfigurationRuntimeRow,
): RunConfigurationRuntime {
  return {
    id: runtime.id,
    projectId: runtime.projectId,
    configurationId: runtime.configurationId,
    worktreeId: runtime.worktreeId,
    workerId: runtime.workerId,
    terminalId: runtime.terminalId,
    definitionRevision: runtime.definitionRevision,
    codexEnvironmentRevision: runtime.codexEnvironmentRevision,
    generation: runtime.generation,
    requestedOperationId: runtime.requestedOperationId,
    state: runtime.state,
    startedAt: runtime.startedAt ? toISOString(runtime.startedAt) : null,
    endedAt: runtime.endedAt ? toISOString(runtime.endedAt) : null,
    exitCode: runtime.exitCode,
    signal: runtime.signal,
    failure: runtime.failure,
    createdAt: toISOString(runtime.createdAt),
    updatedAt: toISOString(runtime.updatedAt),
  };
}

function toRunConfigurationRuntimeOperation(
  operation: RunConfigurationRuntimeOperationRow,
): RunConfigurationRuntimeOperationRecord {
  return {
    id: operation.id,
    projectId: operation.projectId,
    configurationId: operation.configurationId,
    worktreeId: operation.worktreeId,
    runtimeId: operation.runtimeId,
    workerId: operation.workerId,
    operation: operation.operation,
    outcome: operation.outcome,
    generation: operation.generation,
    definitionRevision: operation.definitionRevision,
    codexEnvironmentRevision: operation.codexEnvironmentRevision,
    createdAt: toISOString(operation.createdAt),
  };
}

function toRunConfigurationSecretSummary(
  secret: RunConfigurationSecretRow,
): RunConfigurationSecretSummary {
  return {
    reference: secret.reference,
    available: true,
    revision: secret.revision,
    updatedAt: toISOString(secret.updatedAt),
  };
}

function toRunConfigurationProtectedSecret(
  secret: RunConfigurationSecretRow,
): RunConfigurationProtectedSecret {
  return {
    reference: secret.reference,
    revision: secret.revision,
    protectedValue: secret.protectedValue,
  };
}

function requiredProjectChatProjectId(projectId: string | null): string {
  if (!projectId) {
    throw new Error("Project Chat operation received a standalone Chat.");
  }
  return projectId;
}

function requiredProjectChatWorktreeId(worktreeId: string | null): string {
  if (!worktreeId) {
    throw new Error("Project Chat operation is missing its worktree.");
  }
  return worktreeId;
}

function runConfigurationSecretValueDigest(
  protectedValue: ProtectedSecretEnvelope,
): string {
  return createHash("sha256")
    .update(JSON.stringify(protectedValue))
    .digest("hex");
}

function replayedRunConfigurationSecretSetResult(
  operation: RunConfigurationSecretOperationRow,
): RunConfigurationSecretSetResult {
  if (operation.revision === null) {
    throw new Error("The Run configuration secret operation is incomplete.");
  }
  return runConfigurationSecretSetResultSchema.parse({
    operationId: operation.id,
    projectId: operation.projectId,
    replayed: true,
    secret: {
      reference: operation.reference,
      available: true,
      revision: operation.revision,
      updatedAt: toISOString(operation.createdAt),
    },
  });
}

function toChatExecutionLaneSummary(
  lane: typeof schema.chatExecutionLanes.$inferSelect,
): ChatExecutionLaneSummary {
  if (!lane.worktreeId) {
    throw new Error(
      "Standalone execution lanes are unavailable until standalone execution is enabled.",
    );
  }
  const common = {
    id: lane.id,
    chatId: lane.chatId,
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
  return {
    ...common,
    contextKind: "project",
    worktreeId: lane.worktreeId,
    scratchRootId: null,
  };
}

function toContextualChatExecutionLaneSummary(
  lane: typeof schema.chatExecutionLanes.$inferSelect,
): ContextualChatExecutionLaneSummary {
  if (lane.worktreeId) {
    return {
      ...toChatExecutionLaneSummary(lane),
      contextKind: "project",
      scratchRootId: null,
    };
  }
  if (!lane.scratchRootId) {
    throw new Error("Execution lane has no execution root.");
  }
  return {
    id: lane.id,
    chatId: lane.chatId,
    workerId: lane.workerId,
    acquiringActor:
      lane.acquiringActor as ContextualChatExecutionLaneSummary["acquiringActor"],
    exclusive: lane.exclusive,
    purpose: lane.purpose,
    state: lane.state as ContextualChatExecutionLaneSummary["state"],
    baseRevision: lane.baseRevision,
    startingHead: lane.startingHead,
    runtimeSessionId: lane.runtimeSessionId,
    codexThreadId: lane.codexThreadId,
    transitionKind:
      lane.transitionKind as ContextualChatExecutionLaneSummary["transitionKind"],
    createdAt: toISOString(lane.createdAt),
    activatedAt: lane.activatedAt ? toISOString(lane.activatedAt) : null,
    releasedAt: lane.releasedAt ? toISOString(lane.releasedAt) : null,
    updatedAt: toISOString(lane.updatedAt),
    contextKind: "standalone",
    worktreeId: null,
    scratchRootId: lane.scratchRootId,
  };
}

function toChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
): ChatWireSummary {
  return chatWireSummarySchema.parse({
    id: chat.id,
    contextKind: chat.contextKind,
    projectId: chat.projectId,
    titleProtection: chat.protectedLabel,
    experience: chat.experience as ChatWireSummary["experience"],
    position: chat.position,
    status: chat.status as ChatWireSummary["status"],
    activeWorkerId: chat.activeWorkerId,
    activeWorktreeId: chat.activeWorktreeId,
    activeScratchRootId: chat.activeScratchRootId,
    placementRevision: chat.placementRevision,
    worktreeMode: chat.worktreeMode as ChatWireSummary["worktreeMode"],
    modelId: chat.modelId,
    reasoningEffort: chat.reasoningEffort,
    customSubagentModel: chat.customSubagentModel,
    subagentModelId: chat.subagentModelId,
    subagentReasoningEffort: chat.subagentReasoningEffort,
    permissionProfileId: chat.permissionProfileId,
    planMode: chat.planMode as ChatWireSummary["planMode"],
    hasPendingPlanQuestion: chat.hasPendingPlanQuestion,
    hasUnreadCompletion: chat.hasUnreadCompletion,
    automationPaused: chat.automationPaused,
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  });
}

function toStandaloneChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
): StandaloneChatWireSummary {
  return standaloneChatWireSummarySchema.parse({
    id: chat.id,
    contextKind: "standalone",
    projectId: null,
    titleProtection: chat.protectedLabel,
    experience: "agent",
    position: chat.position,
    status: chat.status,
    activeWorkerId: chat.activeWorkerId,
    activeWorktreeId: null,
    activeScratchRootId: chat.activeScratchRootId,
    placementRevision: chat.placementRevision,
    worktreeMode: null,
    modelId: chat.modelId,
    reasoningEffort: chat.reasoningEffort,
    customSubagentModel: false,
    subagentModelId: null,
    subagentReasoningEffort: null,
    permissionProfileId: chat.permissionProfileId,
    planMode: "default",
    hasPendingPlanQuestion: false,
    hasUnreadCompletion: chat.hasUnreadCompletion,
    automationPaused: chat.automationPaused,
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  });
}

function toContextualChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
): ContextualChatWireSummary {
  return contextualChatWireSummarySchema.parse(
    chat.contextKind === "standalone"
      ? toStandaloneChatWireSummary(chat)
      : toChatWireSummary(chat),
  );
}

function chatModelConfiguration(
  chat: Pick<
    typeof schema.chats.$inferSelect,
    | "modelId"
    | "reasoningEffort"
    | "customSubagentModel"
    | "subagentModelId"
    | "subagentReasoningEffort"
  >,
): ModelConfiguration {
  return modelConfigurationSchema.parse({
    modelId: chat.modelId,
    reasoningEffort: chat.reasoningEffort,
    customSubagentModel: chat.customSubagentModel,
    subagentModelId: chat.subagentModelId,
    subagentReasoningEffort: chat.subagentReasoningEffort,
  });
}

function toArchivedChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
  messageCount: number,
): ArchivedChatWireSummary {
  if (!chat.archivedAt) {
    throw new Error("Cannot summarize an active chat as archived.");
  }
  return archivedChatWireSummarySchema.parse({
    id: chat.id,
    contextKind: chat.contextKind,
    projectId: chat.projectId,
    titleProtection: chat.protectedLabel,
    experience: chat.experience as ArchivedChatWireSummary["experience"],
    messageCount,
    archivedAt: toISOString(chat.archivedAt),
    expiresAt: new Date(
      chat.archivedAt.getTime() + ARCHIVED_CHAT_RETENTION_MS,
    ).toISOString(),
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  });
}

function toArchivedStandaloneChatWireSummary(
  chat: typeof schema.chats.$inferSelect,
  messageCount: number,
): ArchivedStandaloneChatWireSummary {
  if (!chat.archivedAt) {
    throw new Error("Cannot summarize an active Chat as archived.");
  }
  return archivedStandaloneChatWireSummarySchema.parse({
    id: chat.id,
    contextKind: "standalone",
    projectId: null,
    titleProtection: chat.protectedLabel,
    experience: "agent",
    messageCount,
    archivedAt: toISOString(chat.archivedAt),
    expiresAt: new Date(
      chat.archivedAt.getTime() + ARCHIVED_CHAT_RETENTION_MS,
    ).toISOString(),
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  });
}

function toTerminalWireSummary(
  terminal: typeof schema.terminals.$inferSelect,
): TerminalWireSummary {
  return {
    id: terminal.id,
    projectId: terminal.projectId,
    kind: terminal.kind,
    titleProtection: terminal.protectedLabel,
    position: terminal.position,
    status: terminal.status as TerminalWireSummary["status"],
    activeWorkerId: terminal.activeWorkerId,
    worktreeId: terminal.worktreeId,
    linkedChatId: terminal.linkedChatId,
    runConfigurationId: terminal.runConfigurationId,
    runConfigurationRuntimeId: terminal.runConfigurationRuntimeId,
    serviceEnabled: terminal.serviceEnabled,
    stateProtection: terminal.protectedState,
    createdAt: toISOString(terminal.createdAt),
    updatedAt: toISOString(terminal.updatedAt),
  };
}

function toExplorerWireSummary(
  explorer: typeof schema.explorers.$inferSelect,
): ExplorerWireSummary {
  return {
    id: explorer.id,
    projectId: explorer.projectId,
    titleProtection: explorer.protectedLabel,
    position: explorer.position,
    activeWorkerId: explorer.activeWorkerId,
    worktreeId: explorer.worktreeId,
    stateProtection: explorer.protectedState,
    fileMode: explorer.fileMode as ExplorerWireSummary["fileMode"],
    createdAt: toISOString(explorer.createdAt),
    updatedAt: toISOString(explorer.updatedAt),
  };
}

function toBrowserWireSummary(
  browser: typeof schema.browsers.$inferSelect,
  workerId: string | null = null,
): BrowserWireSummary {
  return {
    id: browser.id,
    projectId: browser.projectId,
    titleProtection: browser.protectedLabel,
    position: browser.position,
    stateProtection: browser.protectedState,
    stateRevision: browser.stateRevision,
    workerId,
    createdAt: toISOString(browser.createdAt),
    updatedAt: toISOString(browser.updatedAt),
  };
}

function toProjectViewWireSummary(
  view: typeof schema.projectViews.$inferSelect,
): ProjectViewWireSummary {
  return {
    id: view.id,
    projectId: view.projectId,
    titleProtection: view.protectedLabel,
    kind: view.kind as ProjectViewWireSummary["kind"],
    worktreeId: view.worktreeId,
    position: view.position,
    createdAt: toISOString(view.createdAt),
    updatedAt: toISOString(view.updatedAt),
  };
}

function toCodeTabWireSummary(
  codeTab: typeof schema.codeTabs.$inferSelect,
): CodeTabWireSummary {
  return {
    id: codeTab.id,
    projectId: codeTab.projectId,
    titleProtection: codeTab.protectedLabel,
    position: codeTab.position,
    activeWorkerId: codeTab.activeWorkerId,
    worktreeId: codeTab.worktreeId,
    profileId: codeTab.profileId,
    themeMode: codeTab.themeMode as CodeTabWireSummary["themeMode"],
    status: codeTab.status as CodeTabWireSummary["status"],
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

function agentInteractionRequestBase(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): Omit<AgentInteractionRequest, "payload" | "response"> {
  return {
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
    status: request.status,
    resolvedByUserId: request.resolvedByUserId,
    expiresAt: request.expiresAt ? toISOString(request.expiresAt) : null,
    resolvedAt: request.resolvedAt ? toISOString(request.resolvedAt) : null,
    createdAt: toISOString(request.createdAt),
    updatedAt: toISOString(request.updatedAt),
  } as Omit<AgentInteractionRequest, "payload" | "response">;
}

function toAgentInteractionRequestWire(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): AgentInteractionRequestWire {
  const base = agentInteractionRequestBase(request);
  if (request.protectedPayload) {
    if (request.payload || request.response) {
      throw new Error("An interaction row mixes visible and protected data.");
    }
    return encryptedAgentInteractionRequestSchema.parse({
      ...base,
      classification: { kind: request.kind },
      protectedPayload: request.protectedPayload,
      protectedResponse: request.protectedResponse,
    });
  }
  if (!request.payload || request.protectedResponse) {
    throw new Error("An interaction row has incomplete protected data.");
  }
  return agentInteractionRequestSchema.parse({
    ...base,
    payload: request.payload,
    response: request.response,
  });
}

function toAgentInteractionRequest(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): AgentInteractionRequest {
  return agentInteractionRequestSchema.parse(
    toAgentInteractionRequestWire(request),
  );
}

function toEncryptedAgentInteractionRequest(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): EncryptedAgentInteractionRequest {
  return encryptedAgentInteractionRequestSchema.parse(
    toAgentInteractionRequestWire(request),
  );
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

function toRemoteSurfaceWireSummary(
  surface: typeof schema.remoteSurfaces.$inferSelect,
  titleProtection: PrivateDisplayLabelOpaque | null = surface.protectedLabel,
  stateProtection = surface.protectedState,
  stateRevision = surface.stateRevision,
): RemoteSurfaceWireSummary {
  if (!titleProtection) {
    throw new Error("Remote Surface is missing its canonical protected label.");
  }
  if (!stateProtection || !stateRevision) {
    throw new Error("Remote Surface is missing its canonical protected state.");
  }
  return {
    id: surface.id,
    projectId: surface.projectId,
    workerId: surface.workerId,
    kind: surface.kind as RemoteSurfaceWireSummary["kind"],
    titleProtection,
    status: surface.status as RemoteSurfaceWireSummary["status"],
    preferredTransport:
      surface.preferredTransport as RemoteSurfaceWireSummary["preferredTransport"],
    configuration: surface.configuration,
    stateProtection,
    stateRevision,
    lastError: surface.lastError,
    lastConnectedAt: surface.lastConnectedAt
      ? toISOString(surface.lastConnectedAt)
      : null,
    createdAt: toISOString(surface.createdAt),
    updatedAt: toISOString(surface.updatedAt),
  };
}

function toRemoteDesktopWireSummary(
  view: typeof schema.projectViews.$inferSelect,
  surface: typeof schema.remoteSurfaces.$inferSelect,
): RemoteDesktopWireSummary {
  if (surface.configuration.kind !== "desktop") {
    throw new Error("Remote Desktop is not backed by a desktop surface.");
  }
  if (!surface.protectedState || !surface.stateRevision) {
    throw new Error("Remote Desktop is missing its protected target state.");
  }
  return {
    id: view.id,
    projectId: view.projectId,
    titleProtection: view.protectedLabel,
    position: view.position,
    workerId: surface.workerId,
    stateProtection: surface.protectedState,
    stateRevision: surface.stateRevision,
    status: surface.status as RemoteDesktopWireSummary["status"],
    lastError: surface.lastError,
    createdAt: toISOString(view.createdAt),
    updatedAt: toISOString(
      view.updatedAt > surface.updatedAt ? view.updatedAt : surface.updatedAt,
    ),
  };
}

function toChatMessage(
  message: typeof schema.chatMessages.$inferSelect,
): ChatMessage {
  if (!message.content || message.taskProtectedContent) {
    throw new Error("Encrypted Task messages require the opaque mapper.");
  }
  return {
    id: message.id,
    chatId: message.chatId,
    contextKind: message.scratchRootId ? "standalone" : "project",
    worktreeId: message.worktreeId,
    scratchRootId: message.scratchRootId,
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

function toEncryptedChatMessage(
  message: typeof schema.chatMessages.$inferSelect,
): ChatMessageOpaqueSummary {
  if (
    !message.protectedContent ||
    message.content ||
    message.taskProtectedContent
  ) {
    throw new Error("Visible or Task messages require a different mapper.");
  }
  return chatMessageOpaqueSummarySchema.parse({
    id: message.id,
    chatId: message.chatId,
    contextKind: message.scratchRootId ? "standalone" : "project",
    worktreeId: message.worktreeId,
    scratchRootId: message.scratchRootId,
    executionLaneId: message.executionLaneId,
    sequence: message.sequence,
    role: message.role,
    mode: message.mode,
    attachmentIds: message.attachmentIds,
    protectedContent: message.protectedContent,
    modelId: message.modelId,
    modelRouteId: message.modelRouteId,
    providerId: message.providerId,
    providerName: message.providerName,
    providerModelName: message.providerModelName,
    reasoningEffort: message.reasoningEffort,
    appliedReasoningEffort: message.appliedReasoningEffort,
    reasoningAdjusted: message.reasoningAdjusted,
    idempotencyKey: message.idempotencyKey,
    createdAt: toISOString(message.createdAt),
  });
}

function toTaskMessage(
  message: typeof schema.chatMessages.$inferSelect,
): TaskMessageOpaqueSummary {
  if (!message.taskProtectedContent || message.content) {
    throw new Error("Visible chat messages require the plaintext mapper.");
  }
  if (!message.worktreeId || message.scratchRootId) {
    throw new Error("Task messages require a project worktree.");
  }
  return taskMessageOpaqueSummarySchema.parse({
    id: message.id,
    chatId: message.chatId,
    worktreeId: message.worktreeId,
    executionLaneId: message.executionLaneId,
    sequence: message.sequence,
    role: message.role,
    mode: message.mode,
    attachmentIds: message.taskAttachmentIds,
    protectedContent: message.taskProtectedContent,
    modelId: message.modelId,
    modelRouteId: message.modelRouteId,
    providerId: message.providerId,
    providerName: message.providerName,
    providerModelName: message.providerModelName,
    reasoningEffort: message.reasoningEffort,
    appliedReasoningEffort: message.appliedReasoningEffort,
    reasoningAdjusted: message.reasoningAdjusted,
    idempotencyKey: message.idempotencyKey,
    createdAt: toISOString(message.createdAt),
  });
}

function toChatAttachment(
  attachment: typeof schema.chatAttachments.$inferSelect,
): ChatAttachmentRecord {
  return {
    ...chatAttachmentOpaqueSummarySchema.parse({
      id: attachment.id,
      chatId: attachment.chatId,
      sizeBytes: attachment.sizeBytes,
      status: attachment.status,
      protectedMetadata: attachment.protectedMetadata,
      createdAt: toISOString(attachment.createdAt),
    }),
    workerId: attachment.workerId,
  };
}

function toQueuedPrompt(
  prompt: typeof schema.queuedPrompts.$inferSelect,
): QueuedPrompt {
  if (prompt.text === null) {
    throw new Error("Encrypted queued prompts require the opaque mapper.");
  }
  return {
    id: prompt.id,
    chatId: prompt.chatId,
    text: prompt.text,
    mode: prompt.mode,
    attachments: [],
    modelId: prompt.modelId,
    reasoningEffort: prompt.reasoningEffort,
    customSubagentModel: prompt.customSubagentModel,
    subagentModelId: prompt.subagentModelId,
    subagentReasoningEffort: prompt.subagentReasoningEffort,
    worktreeId: prompt.worktreeId,
    position: prompt.position,
    frozen: prompt.frozen,
    createdAt: toISOString(prompt.createdAt),
    updatedAt: toISOString(prompt.updatedAt),
  };
}

function toEncryptedQueuedPrompt(
  prompt: typeof schema.queuedPrompts.$inferSelect,
): EncryptedQueuedPrompt {
  if (!prompt.opaqueContent || prompt.text !== null) {
    throw new Error("Visible queued prompts require the plaintext mapper.");
  }
  return encryptedQueuedPromptSchema.parse({
    ...prompt.opaqueContent,
    chatId: prompt.chatId,
    attachments: prompt.attachments,
    position: prompt.position,
    createdAt: toISOString(prompt.createdAt),
    updatedAt: toISOString(prompt.updatedAt),
  });
}

export class ServerRepository {
  readonly accounts: AccountRepository;
  readonly accountResourceUsage: AccountResourceUsageRepository;
  readonly providerAccounts: ProviderAccountRepository;
  readonly providerCatalog: ProviderCatalogRepository;
  readonly models: ModelRepository;
  readonly workers: WorkerRepository;
  readonly tunnels: TunnelRepository;
  readonly mcp: McpRepository;
  readonly projects: ProjectRepository;
  readonly placement: PlacementRepository;
  readonly executionTargets: ExecutionTargetRepository;
  readonly worktreeState: WorktreeStateRepository;
  readonly telemetry: TelemetryRepository;
  readonly chatImportJobs: ChatImportJobRepository;
  readonly chatRelocationJobs: ChatRelocationJobRepository;
  readonly encryptionRegistry: EncryptionRegistryRepository;
  readonly codeSettings: CodeSettingsRepository;
  readonly projectAutomations: ProjectAutomationRepository;
  readonly policies: PolicyRepository;
  readonly tasks: TaskRepository;
  readonly taskDispatch: TaskDispatchRepository;
  readonly taskScheduling: TaskSchedulingRepository;
  readonly projectReplicaJobs: ProjectReplicaJobRepository;
  readonly projectFolderSetupJobs: ProjectFolderSetupJobRepository;
  readonly standaloneChatRootJobs: StandaloneChatRootJobRepository;
  readonly projectGithubConversionJobs: ProjectGithubConversionJobRepository;
  readonly tabLayouts: ProjectTabLayoutRepository;
  readonly workflows: WorkflowRepository;
  readonly workflowRuns: WorkflowRunRepository;
  readonly workflowTriggers: WorkflowTriggerRepository;

  constructor(
    private readonly database: RepositoryDatabase,
    secretVault: SecretVault,
  ) {
    // Retained in the constructor while unrelated server-owned credentials
    // finish moving out of this repository. Provider and MCP payloads never
    // use this server key.
    void secretVault;
    this.accountResourceUsage = new AccountResourceUsageRepository(database);
    this.providerAccounts = new ProviderAccountRepository(database);
    this.providerCatalog = new ProviderCatalogRepository(database);
    this.models = new ModelRepository(database, {
      readSettings: (ownerId) => this.getSettings(ownerId),
    });
    this.workers = new WorkerRepository(database);
    this.tunnels = new TunnelRepository(database, {
      getTunnel: (ownerId, tunnelId) => this.getTunnel(ownerId, tunnelId),
      stopDesktopTunnelAttachment: (
        ownerId,
        attachmentId,
        errorCode,
        preserveTunnelState,
        expected,
      ) =>
        this.stopDesktopTunnelAttachment(
          ownerId,
          attachmentId,
          errorCode,
          preserveTunnelState,
          expected,
        ),
    });
    this.mcp = new McpRepository(database, {
      getModelProvider: (ownerId, providerId) =>
        this.getModelProvider(ownerId, providerId),
      getWorker: (ownerId, workerId) => this.getWorker(ownerId, workerId),
    });
    this.projects = new ProjectRepository(database, {
      ensureDefaultProjectWorkspace: (ownerId) =>
        this.ensureDefaultProjectWorkspace(ownerId),
      getWorker: (ownerId, workerId) => this.getWorker(ownerId, workerId),
      listProjectReplicas: (ownerId, projectId) =>
        this.listProjectReplicas(ownerId, projectId),
      listProjectWorkspaceWire: (ownerId) =>
        this.listProjectWorkspaceWire(ownerId),
    });
    this.placement = new PlacementRepository(database);
    this.executionTargets = new ExecutionTargetRepository(
      database,
      this,
      (ownerId, browserId) => this.browserIsOwnedBy(ownerId, browserId),
    );
    this.worktreeState = new WorktreeStateRepository(database, {
      getActiveGitOperation: (ownerId, projectId, worktreeId) =>
        this.getActiveGitOperation(ownerId, projectId, worktreeId),
      getGitOperation: (ownerId, projectId, worktreeId, operationId) =>
        this.getGitOperation(ownerId, projectId, worktreeId, operationId),
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
    });
    this.telemetry = new TelemetryRepository(database);
    this.chatImportJobs = new ChatImportJobRepository(database);
    this.chatRelocationJobs = new ChatRelocationJobRepository(database);
    this.encryptionRegistry = new EncryptionRegistryRepository(database);
    this.codeSettings = new CodeSettingsRepository(database);
    this.projectAutomations = new ProjectAutomationRepository(database);
    this.policies = new PolicyRepository(database);
    this.accounts = new AccountRepository(database, {
      ensureDefaultProjectWorkspace: (ownerId) =>
        this.ensureDefaultProjectWorkspace(ownerId),
      ensureOwnerPolicyState: (ownerId) =>
        this.policies.ensureOwnerState(ownerId),
    });
    this.tasks = new TaskRepository(database);
    this.taskDispatch = new TaskDispatchRepository(database);
    this.taskScheduling = new TaskSchedulingRepository(database);
    this.projectReplicaJobs = new ProjectReplicaJobRepository(database);
    this.projectFolderSetupJobs = new ProjectFolderSetupJobRepository(database);
    this.standaloneChatRootJobs = new StandaloneChatRootJobRepository(database);
    this.projectGithubConversionJobs = new ProjectGithubConversionJobRepository(
      database,
    );
    this.workflows = new WorkflowRepository(database);
    this.workflowRuns = new WorkflowRunRepository(database);
    this.workflowTriggers = new WorkflowTriggerRepository(database);
    this.tabLayouts = new ProjectTabLayoutRepository(database);
  }

  async migrateProviderSecrets(): Promise<void> {
    // Pre-release migration 0119 removes every server-readable predecessor.
  }

  async migrateProviderAccountCredentialSecrets(): Promise<void> {
    // Pre-release migration 0119 signs legacy accounts out.
  }

  async migrateMcpServerSecrets(): Promise<void> {
    // Pre-release migration 0119 deletes legacy MCP rows.
  }

  async ensureLocalIdentity(): Promise<UserSummary> {
    return this.accounts.ensureLocalIdentity();
  }

  async countAccountUsers(): Promise<number> {
    return this.accounts.countAccountUsers();
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
      runConfigurationRuntimes,
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
      this.database
        .select({ count })
        .from(schema.runConfigurationRuntimes)
        .where(
          and(
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            inArray(schema.runConfigurationRuntimes.state, [
              "starting",
              "running",
              "stopping",
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
      value(gitOperations) +
      value(runConfigurationRuntimes);
    return {
      activeChats: value(activeChats),
      queuedPrompts: value(queuedPrompts),
      terminalServices: value(terminalServices),
      backgroundJobs: Math.min(maximum, backgroundJobs),
    };
  }

  async accountEmailIsWhitelisted(normalizedEmail: string): Promise<boolean> {
    return this.accounts.accountEmailIsWhitelisted(normalizedEmail);
  }

  async listAccountLicenseWhitelist(): Promise<AccountLicenseWhitelistEntry[]> {
    return this.accounts.listAccountLicenseWhitelist();
  }

  async createAccountLicenseWhitelistEntry(input: {
    addedByUserId: string;
    email: string;
    normalizedEmail: string;
  }): Promise<AccountLicenseWhitelistEntry | null> {
    return this.accounts.createAccountLicenseWhitelistEntry(input);
  }

  async deleteAccountLicenseWhitelistEntry(id: string): Promise<boolean> {
    return this.accounts.deleteAccountLicenseWhitelistEntry(id);
  }

  async createAccount(input: {
    displayName: string;
    email: string;
    normalizedEmail: string;
    passwordHash: string;
    role: UserSummary["role"];
  }): Promise<UserSummary> {
    return this.accounts.createAccount(input);
  }

  async findAccountCredential(
    normalizedEmail: string,
  ): Promise<AccountCredentialRecord | null> {
    return this.accounts.findAccountCredential(normalizedEmail);
  }

  async findAccountCredentialById(
    ownerId: string,
  ): Promise<AccountCredentialRecord | null> {
    return this.accounts.findAccountCredentialById(ownerId);
  }

  async createUserSession(input: {
    authMethod: ActiveUserSession["authMethod"];
    csrfTokenHash: string;
    expiresAt: Date;
    label: string | null;
    tokenHash: string;
    userId: string;
  }): Promise<UserSessionRow> {
    return this.accounts.createUserSession(input);
  }

  async getActiveUserSession(
    tokenHash: string,
  ): Promise<ActiveUserSession | null> {
    return this.accounts.getActiveUserSession(tokenHash);
  }

  async createMobileSignInGrant(input: {
    codeHash: string;
    createdBySessionId: string;
    expiresAt: Date;
    ownerId: string;
  }): Promise<string> {
    return this.accounts.createMobileSignInGrant(input);
  }

  async consumeMobileSignInGrant(
    codeHash: string,
  ): Promise<UserSummary | null> {
    return this.accounts.consumeMobileSignInGrant(codeHash);
  }

  async pruneMobileSignInGrants(before: Date): Promise<void> {
    return this.accounts.pruneMobileSignInGrants(before);
  }

  async isUserSessionActive(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    return this.accounts.isUserSessionActive(sessionId, userId);
  }

  async rotateSessionCsrfToken(
    sessionId: string,
    csrfTokenHash: string,
  ): Promise<boolean> {
    return this.accounts.rotateSessionCsrfToken(sessionId, csrfTokenHash);
  }

  async revokeUserSession(sessionId: string, reason: string): Promise<boolean> {
    return this.accounts.revokeUserSession(sessionId, reason);
  }

  async revokeAllUserSessions(userId: string, reason: string): Promise<number> {
    return this.accounts.revokeAllUserSessions(userId, reason);
  }

  async listUserSessions(
    userId: string,
    currentSessionId: string | null,
  ): Promise<AccountSessionSummary[]> {
    return this.accounts.listUserSessions(userId, currentSessionId);
  }

  async appendAuditEvent(input: AuditEventCreate): Promise<AuditEvent> {
    return this.accounts.appendAuditEvent(input);
  }

  async listAuditEvents(
    query: AuditEventQuery,
    ownerId?: string,
  ): Promise<AuditEventList> {
    return this.accounts.listAuditEvents(query, ownerId);
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

  async getSettings(ownerId: string): Promise<SettingsBundleWire> {
    const [
      preferences,
      providerRows,
      providerAccountRows,
      providerAccountWorkerRows,
      modelRows,
      routeRows,
      providerUsageRows,
      modelUsageRows,
      agentTime,
    ] = await Promise.all([
      this.getUserSettings(ownerId),
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
      this.getAgentTimeAnalytics(ownerId),
    ]);
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
      preferences,
      providers: providerRows.map((provider) =>
        toProviderSummary(
          provider,
          providerUsage.get(provider.id),
          agentTime.providers.get(provider.id),
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
          agentTime.models.get(model.id),
        ),
      ),
    };
  }

  async getAgentTimeAnalytics(
    ownerId: string,
    projectId?: string,
    now = new Date(),
  ): Promise<AgentTimeAnalytics> {
    return this.telemetry.getAgentTimeAnalytics(ownerId, projectId, now);
  }

  async recordTokenUsage(
    ownerId: string,
    input: TokenUsageRecordInput,
  ): Promise<void> {
    return this.telemetry.recordTokenUsage(ownerId, input);
  }

  async recordModelBehaviorObservation(
    ownerId: string,
    input: ModelBehaviorObservationInput,
  ): Promise<void> {
    return this.telemetry.recordModelBehaviorObservation(ownerId, input);
  }

  async getProjectTokenUsage(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectTokenUsage | null> {
    return this.telemetry.getProjectTokenUsage(ownerId, projectId);
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
      eliteMode: settings.eliteMode,
      eliteRevealConfig: settings.eliteRevealConfig,
      sidebarWidth: settings.sidebarWidth,
      desktopFrameRate:
        settings.desktopFrameRate as UserSettings["desktopFrameRate"],
      desktopStreamQuality:
        settings.desktopStreamQuality as UserSettings["desktopStreamQuality"],
      defaultModelId: settings.defaultModelId,
      defaultReasoningEffort: settings.defaultReasoningEffort,
      defaultCustomSubagentModel: settings.defaultCustomSubagentModel,
      defaultSubagentModelId: settings.defaultSubagentModelId,
      defaultSubagentReasoningEffort: settings.defaultSubagentReasoningEffort,
      defaultPermissionProfileId:
        settings.defaultPermissionProfileId as UserSettings["defaultPermissionProfileId"],
      defaultChatModelId: settings.defaultChatModelId,
      defaultChatReasoningEffort: settings.defaultChatReasoningEffort,
      defaultChatPermissionProfileId:
        settings.defaultChatPermissionProfileId as UserSettings["defaultChatPermissionProfileId"],
      defaultWorkerId: settings.defaultWorkerId,
      lastAppMode: settings.lastAppMode as UserSettings["lastAppMode"],
      lastIdeProjectId: settings.lastIdeProjectId,
      lastIdeWorkspaceId: settings.lastIdeWorkspaceId,
      lastStandaloneChatId: settings.lastStandaloneChatId,
      destinationRevision: settings.destinationRevision,
      automaticReplicaProvisioning: settings.automaticReplicaProvisioning,
      automaticReplicaSynchronization:
        settings.automaticReplicaSynchronization as UserSettings["automaticReplicaSynchronization"],
      mobileProjectTabConfigurations: settings.mobileProjectTabConfigurations,
    };
  }

  async updateAppDestination(
    ownerId: string,
    input: AppDestinationUpdate,
  ): Promise<AppDestination | null> {
    if (input.lastIdeProjectId) {
      const projects = await this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, input.lastIdeProjectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!projects[0]) return null;
    }
    if (input.lastIdeWorkspaceId) {
      const workspaces = await this.database
        .select({ id: schema.projectWorkspaces.id })
        .from(schema.projectWorkspaces)
        .where(
          and(
            eq(schema.projectWorkspaces.id, input.lastIdeWorkspaceId),
            eq(schema.projectWorkspaces.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!workspaces[0]) return null;
    }
    if (input.lastStandaloneChatId) {
      const chats = await this.database
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.lastStandaloneChatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "standalone"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .limit(1);
      if (!chats[0]) return null;
    }

    const rows = await this.database
      .update(schema.userSettings)
      .set({
        ...(input.lastAppMode !== undefined
          ? { lastAppMode: input.lastAppMode }
          : {}),
        ...(input.lastIdeProjectId !== undefined
          ? { lastIdeProjectId: input.lastIdeProjectId }
          : {}),
        ...(input.lastIdeWorkspaceId !== undefined
          ? { lastIdeWorkspaceId: input.lastIdeWorkspaceId }
          : {}),
        ...(input.lastStandaloneChatId !== undefined
          ? { lastStandaloneChatId: input.lastStandaloneChatId }
          : {}),
        destinationRevision: sql`${schema.userSettings.destinationRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.userSettings.userId, ownerId),
          eq(schema.userSettings.destinationRevision, input.expectedRevision),
        ),
      )
      .returning({
        lastAppMode: schema.userSettings.lastAppMode,
        lastIdeProjectId: schema.userSettings.lastIdeProjectId,
        lastIdeWorkspaceId: schema.userSettings.lastIdeWorkspaceId,
        lastStandaloneChatId: schema.userSettings.lastStandaloneChatId,
        revision: schema.userSettings.destinationRevision,
      });
    const destination = rows[0];
    return destination
      ? {
          lastAppMode: destination.lastAppMode as AppDestination["lastAppMode"],
          lastIdeProjectId: destination.lastIdeProjectId,
          lastIdeWorkspaceId: destination.lastIdeWorkspaceId,
          lastStandaloneChatId: destination.lastStandaloneChatId,
          revision: destination.revision,
        }
      : null;
  }

  async updateSettings(
    ownerId: string,
    input: UserSettingsUpdate,
  ): Promise<SettingsBundleWire | null> {
    if (input.defaultModelId) {
      const model = await this.getModelRuntime(ownerId, input.defaultModelId);
      if (!model) {
        return null;
      }
    }
    if (input.defaultChatModelId) {
      const model = await this.getModelRuntime(
        ownerId,
        input.defaultChatModelId,
      );
      if (!model) {
        return null;
      }
    }
    if (input.defaultSubagentModelId) {
      const model = await this.getModelRuntime(
        ownerId,
        input.defaultSubagentModelId,
      );
      if (!model) {
        return null;
      }
    }
    if (
      input.defaultCustomSubagentModel !== undefined ||
      input.defaultSubagentModelId !== undefined
    ) {
      const current = await this.getUserSettings(ownerId);
      const customSubagentModel =
        input.defaultCustomSubagentModel ?? current.defaultCustomSubagentModel;
      const subagentModelId =
        input.defaultSubagentModelId !== undefined
          ? input.defaultSubagentModelId
          : current.defaultSubagentModelId;
      if (customSubagentModel && !subagentModelId) return null;
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
    input: EncryptedModelProviderCreate,
  ): Promise<ModelProviderWireSummary> {
    return this.providerCatalog.createModelProvider(ownerId, input);
  }

  async getModelProvider(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderWireSummary | null> {
    return this.providerCatalog.getModelProvider(ownerId, providerId);
  }

  async hasModelRoutesForProvider(
    ownerId: string,
    providerId: string,
  ): Promise<boolean> {
    return this.providerCatalog.hasModelRoutesForProvider(ownerId, providerId);
  }
  async listModelProviderAccounts(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderAccountWireSummary[] | null> {
    return this.providerAccounts.listModelProviderAccounts(ownerId, providerId);
  }

  async getModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialRecord | null> {
    return this.providerAccounts.getModelProviderAccountCredential(
      ownerId,
      providerId,
      accountId,
    );
  }

  async listModelProviderAccountCredentialMigrations(
    ownerId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord[]> {
    return this.providerAccounts.listModelProviderAccountCredentialMigrations(
      ownerId,
    );
  }

  async getModelProviderAccountCredentialMigration(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord | null> {
    return this.providerAccounts.getModelProviderAccountCredentialMigration(
      ownerId,
      providerId,
      accountId,
    );
  }

  async storeModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: ProtectedProviderCredential,
    metadata: ProviderCredentialPublicMetadata,
    expectedRevision?: number,
  ): Promise<ProviderAccountCredentialRecord | null> {
    return this.providerAccounts.storeModelProviderAccountCredential(
      ownerId,
      providerId,
      accountId,
      input,
      metadata,
      expectedRevision,
    );
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
    return this.providerAccounts.updateModelProviderAccountCredentialState(
      input,
    );
  }

  async clearModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    return this.providerAccounts.clearModelProviderAccountCredential(
      ownerId,
      providerId,
      accountId,
      expectedRevision,
    );
  }

  async takeModelProviderAccountCredentialForSignOut(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<ProviderAccountCredentialSignOutRecord | null> {
    return this.providerAccounts.takeModelProviderAccountCredentialForSignOut(
      ownerId,
      providerId,
      accountId,
      expectedRevision,
    );
  }

  async createModelProviderAccount(
    ownerId: string,
    providerId: string,
    input: EncryptedModelProviderAccountCreate,
  ): Promise<ModelProviderAccountWireSummary | null> {
    return this.providerAccounts.createModelProviderAccount(
      ownerId,
      providerId,
      input,
    );
  }

  async updateModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: EncryptedModelProviderAccountUpdate,
  ): Promise<ModelProviderAccountWireSummary | null> {
    return this.providerAccounts.updateModelProviderAccount(
      ownerId,
      providerId,
      accountId,
      input,
    );
  }

  async reorderModelProviderAccounts(
    ownerId: string,
    providerId: string,
    input: OrderedIds,
  ): Promise<boolean> {
    return this.providerAccounts.reorderModelProviderAccounts(
      ownerId,
      providerId,
      input,
    );
  }

  async deleteModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    return this.providerAccounts.deleteModelProviderAccount(
      ownerId,
      providerId,
      accountId,
    );
  }

  async getModelProviderAccountRuntime(
    ownerId: string,
    providerId: string,
    accountId?: string,
  ): Promise<{
    accountId: string;
    credentialHomeKey: string;
  } | null> {
    return this.providerAccounts.getModelProviderAccountRuntime(
      ownerId,
      providerId,
      accountId,
    );
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
    return this.providerAccounts.recordModelProviderAccountStatus(
      accountId,
      workerId,
      status,
    );
  }

  async recordModelProviderAccountUsage(input: {
    accountId: string;
    ownerId: string;
    planType: string | null;
    providerId: string;
    resetsAt: number | null;
    usedPercent: number;
  }): Promise<boolean> {
    return this.providerAccounts.recordModelProviderAccountUsage(input);
  }

  async recordProviderQuotaObservation(
    ownerId: string,
    input: ProviderQuotaObservationInput,
  ): Promise<boolean> {
    return this.telemetry.recordProviderQuotaObservation(ownerId, input);
  }

  async getQuotaTokenAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<QuotaTokenAnalytics> {
    return this.telemetry.getQuotaTokenAnalytics(ownerId, query);
  }

  async getProviderTelemetryAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<ProviderTelemetryWireAnalytics> {
    return this.telemetry.getProviderTelemetryAnalytics(ownerId, query);
  }

  async exportProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryExport | null> {
    return this.telemetry.exportProviderTelemetry(ownerId, providerId);
  }

  async deleteProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryDeleteResult | null> {
    return this.telemetry.deleteProviderTelemetry(ownerId, providerId);
  }
  async deleteModelProvider(ownerId: string, providerId: string) {
    return this.providerCatalog.deleteModelProvider(ownerId, providerId);
  }

  async updateModelProvider(
    ownerId: string,
    providerId: string,
    input: EncryptedModelProviderUpdate,
  ): Promise<ModelProviderWireSummary | null> {
    return this.providerCatalog.updateModelProvider(ownerId, providerId, input);
  }

  async getModelProviderCatalogRuntime(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderCatalogRuntime | null> {
    return this.providerCatalog.getModelProviderCatalogRuntime(
      ownerId,
      providerId,
    );
  }

  async listModelProviderCatalogTargets(
    ownerId: string,
  ): Promise<ModelProviderCatalogTarget[]> {
    return this.providerCatalog.listModelProviderCatalogTargets(ownerId);
  }

  async listModelProviderRefreshTargets(
    ownerId: string,
  ): Promise<ModelProviderRefreshTarget[]> {
    return this.providerCatalog.listModelProviderRefreshTargets(ownerId);
  }

  async setProviderCatalogSyncState(
    providerId: string,
    input: {
      scopeKey: string;
      status: ProviderCatalogSyncState["status"];
      errorCode?: string | null;
      etag?: string | null;
      refreshStartedAt?: Date | null;
      lastSuccessAt?: Date | null;
      workerId?: string | null;
      providerAccountId?: string | null;
    },
  ): Promise<void> {
    return this.providerCatalog.setProviderCatalogSyncState(providerId, input);
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
    return this.providerCatalog.reconcileProviderModelCatalog(
      ownerId,
      providerId,
      input,
    );
  }

  async getProviderModelCatalog(
    ownerId: string,
    providerId: string,
    servedStale = false,
  ): Promise<ProviderModelCatalogResult | null> {
    return this.providerCatalog.getProviderModelCatalog(
      ownerId,
      providerId,
      servedStale,
    );
  }

  async listProviderModelAvailability(
    ownerId: string,
    providerId: string,
    providerModelId: string,
  ): Promise<ProviderModelAvailability[]> {
    return this.providerCatalog.listProviderModelAvailability(
      ownerId,
      providerId,
      providerModelId,
    );
  }
  async createModelProfile(
    ownerId: string,
    input: ModelProfileCreate,
  ): Promise<ModelProfileSummary | null> {
    return this.models.createModelProfile(ownerId, input);
  }

  async deleteModelProfile(ownerId: string, modelId: string) {
    return this.models.deleteModelProfile(ownerId, modelId);
  }

  async updateModelProfile(
    ownerId: string,
    modelId: string,
    input: ModelProfileUpdate,
  ): Promise<ModelProfileSummary | null> {
    return this.models.updateModelProfile(ownerId, modelId, input);
  }

  async getModelRuntime(
    ownerId: string,
    modelId: string,
    routeId?: string,
  ): Promise<ModelRuntime | null> {
    return this.models.getModelRuntime(ownerId, modelId, routeId);
  }

  async getModelRuntimeByRoute(
    ownerId: string,
    routeId: string,
  ): Promise<ModelRuntime | null> {
    return this.models.getModelRuntimeByRoute(ownerId, routeId);
  }

  async getModelRuntimes(
    ownerId: string,
    modelId?: string,
    routeId?: string,
    includeDisabled = false,
  ): Promise<ModelRuntime[]> {
    return this.models.getModelRuntimes(
      ownerId,
      modelId,
      routeId,
      includeDisabled,
    );
  }

  async listModelProviderAccountRuntimes(
    ownerId: string,
    providerId: string,
    workerId: string,
    providerModelId: string | null,
  ): Promise<ModelProviderAccountRuntime[]> {
    return this.models.listModelProviderAccountRuntimes(
      ownerId,
      providerId,
      workerId,
      providerModelId,
    );
  }
  async getOrCreateServerId(): Promise<string> {
    return this.workers.getOrCreateServerId();
  }

  async createWorkerEnrollmentCode(input: {
    codeHash: string;
    createdBySessionId: string | null;
    expiresAt: Date;
    label: string | null;
    ownerId: string;
  }): Promise<string> {
    return this.workers.createWorkerEnrollmentCode(input);
  }

  async findReusableWorkerId(
    ownerId: string,
    candidateWorkerIds: readonly string[],
  ): Promise<string | null> {
    return this.workers.findReusableWorkerId(ownerId, candidateWorkerIds);
  }

  async getWorkerEnrollmentCodeStatus(
    ownerId: string,
    enrollmentCodeId: string,
  ): Promise<WorkerEnrollmentCodeStatus | null> {
    return this.workers.getWorkerEnrollmentCodeStatus(
      ownerId,
      enrollmentCodeId,
    );
  }

  async exchangeWorkerEnrollmentCode(input: {
    codeHash: string;
    credentialHash: string;
    credentialId: string;
    heartbeat: WorkerHeartbeat;
    replacement: { workerId: string; credentialHash: string } | null;
    scopes: WorkerCredentialScope[];
  }): Promise<WorkerEnrollmentProvision> {
    return this.workers.exchangeWorkerEnrollmentCode(input);
  }

  async authenticateWorkerCredential(
    secretHash: string,
    workerId: string,
    requiredScope: WorkerCredentialScope,
  ): Promise<ActiveWorkerCredential | null> {
    return this.workers.authenticateWorkerCredential(
      secretHash,
      workerId,
      requiredScope,
    );
  }

  async listWorkerCredentials(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerCredentialSummary[] | null> {
    return this.workers.listWorkerCredentials(ownerId, workerId);
  }

  async rotateWorkerCredential(input: {
    credentialHash: string;
    credentialId: string;
    label: string | null;
    ownerId: string;
    scopes: WorkerCredentialScope[];
    workerId: string;
  }): Promise<WorkerCredentialSummary | null> {
    return this.workers.rotateWorkerCredential(input);
  }

  async revokeWorkerCredential(
    ownerId: string,
    workerId: string,
    credentialId: string,
    reason = "revoked by owner",
  ): Promise<WorkerCredentialSummary | null> {
    return this.workers.revokeWorkerCredential(
      ownerId,
      workerId,
      credentialId,
      reason,
    );
  }

  async recordWorker(
    ownerId: string,
    heartbeat: WorkerHeartbeat,
  ): Promise<WorkerSummary> {
    return this.workers.recordWorker(ownerId, heartbeat);
  }

  async listWorkers(ownerId: string): Promise<WorkerSummary[]> {
    return this.workers.listWorkers(ownerId);
  }

  async getWorker(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerSummary | null> {
    return this.workers.getWorker(ownerId, workerId);
  }

  async listWorkerManagement(
    ownerId: string,
  ): Promise<WorkerManagementRecord[]> {
    return this.workers.listWorkerManagement(ownerId);
  }

  async updateWorkerDisplayName(
    ownerId: string,
    workerId: string,
    name: string,
  ): Promise<WorkerSummary | null> {
    return this.workers.updateWorkerDisplayName(ownerId, workerId, name);
  }

  async unlinkWorker(ownerId: string, workerId: string): Promise<boolean> {
    return this.workers.unlinkWorker(ownerId, workerId);
  }

  async getWorkerOwnerId(workerId: string): Promise<string | null> {
    return this.workers.getWorkerOwnerId(workerId);
  }

  async onlineWorkerCount(ownerId: string): Promise<number> {
    return this.workers.onlineWorkerCount(ownerId);
  }
  async listTunnels(
    ownerId: string,
    projectId?: string,
  ): Promise<TunnelWireSummary[]> {
    return this.tunnels.listTunnels(ownerId, projectId);
  }

  async getTunnel(
    ownerId: string,
    tunnelId: string,
  ): Promise<TunnelWireSummary | null> {
    return this.tunnels.getTunnel(ownerId, tunnelId);
  }

  async createUserTunnel(
    ownerId: string,
    input: TunnelUserWireCreate,
  ): Promise<TunnelWireSummary | null> {
    return this.tunnels.createUserTunnel(ownerId, input);
  }

  async updateUserTunnel(
    ownerId: string,
    tunnelId: string,
    input: TunnelUserWireUpdate,
  ): Promise<TunnelWireSummary | null> {
    return this.tunnels.updateUserTunnel(ownerId, tunnelId, input);
  }

  async deleteUserTunnel(ownerId: string, tunnelId: string): Promise<boolean> {
    return this.tunnels.deleteUserTunnel(ownerId, tunnelId);
  }

  async registerManagedTunnel(
    ownerId: string,
    input: Omit<TunnelManagedRegistration, "source" | "destination"> & {
      source: TunnelSourceEndpoint | TunnelPublicSourceEndpoint;
      destination: TunnelDestinationEndpoint | TunnelPublicDestinationEndpoint;
    },
    protectedInput?: {
      id?: string;
      protectedRecord: ProtectedTunnelContentRecord;
    },
  ): Promise<TunnelWireSummary | null> {
    return this.tunnels.registerManagedTunnel(ownerId, input, protectedInput);
  }

  async getManagedTunnel(
    ownerId: string,
    managedBy: NonNullable<TunnelWireSummary["managedBy"]>,
  ): Promise<TunnelWireSummary | null> {
    return this.tunnels.getManagedTunnel(ownerId, managedBy);
  }

  async removeManagedTunnel(
    ownerId: string,
    managedBy: NonNullable<TunnelWireSummary["managedBy"]>,
  ): Promise<boolean> {
    return this.tunnels.removeManagedTunnel(ownerId, managedBy);
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
  ): Promise<{
    attachmentId: string;
    expiresAt: Date;
    projectId: string | null;
    secretExpiresAt: Date;
  } | null> {
    return this.tunnels.createDesktopTunnelAttachment(ownerId, tunnelId, input);
  }

  async authorizeDesktopTunnelAttachment(
    attachmentId: string,
    secretHash: string,
  ): Promise<TunnelAttachmentAuthorization | null> {
    return this.tunnels.authorizeDesktopTunnelAttachment(
      attachmentId,
      secretHash,
    );
  }

  async getDesktopTunnelAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<TunnelAttachmentAuthorization | null> {
    return this.tunnels.getDesktopTunnelAttachment(ownerId, attachmentId);
  }

  async activateDesktopTunnelAttachment(
    attachmentId: string,
    clientId: string,
    secretExpiresAt: Date,
  ): Promise<Date | null> {
    return this.tunnels.activateDesktopTunnelAttachment(
      attachmentId,
      clientId,
      secretExpiresAt,
    );
  }

  async markDesktopTunnelAttachmentOffline(
    attachmentId: string,
    secretExpiresAt: Date,
    activatedAt: Date,
  ): Promise<boolean> {
    return this.tunnels.markDesktopTunnelAttachmentOffline(
      attachmentId,
      secretExpiresAt,
      activatedAt,
    );
  }

  async activateDesktopTunnelDirectLease(
    ownerId: string,
    attachmentId: string,
    capabilityId: string,
    leaseExpiresAt: Date,
    secretExpiresAt: Date,
  ): Promise<DesktopTunnelAttachmentLeaseChange | null> {
    return this.tunnels.activateDesktopTunnelDirectLease(
      ownerId,
      attachmentId,
      capabilityId,
      leaseExpiresAt,
      secretExpiresAt,
    );
  }

  async renewDesktopTunnelDirectLease(
    ownerId: string,
    attachmentId: string,
    capabilityId: string,
    leaseExpiresAt: Date,
  ): Promise<DesktopTunnelAttachmentLeaseChange | null> {
    return this.tunnels.renewDesktopTunnelDirectLease(
      ownerId,
      attachmentId,
      capabilityId,
      leaseExpiresAt,
    );
  }

  async finalizeDesktopTunnelDirectLease(
    ownerId: string,
    attachmentId: string,
    capabilityId: string,
    leaseExpiresAt: Date,
  ): Promise<DesktopTunnelAttachmentLeaseChange | null> {
    return this.tunnels.finalizeDesktopTunnelDirectLease(
      ownerId,
      attachmentId,
      capabilityId,
      leaseExpiresAt,
    );
  }

  async expireDesktopTunnelDirectLeases(
    now = new Date(),
  ): Promise<DesktopTunnelAttachmentLeaseChange[]> {
    return this.tunnels.expireDesktopTunnelDirectLeases(now);
  }

  async stopDesktopTunnelAttachment(
    ownerId: string,
    attachmentId: string,
    errorCode: TunnelContentErrorCode | null = null,
    preserveTunnelState = false,
    expected?: DesktopTunnelAttachmentStopFence,
  ): Promise<{ projectId: string | null; tunnelId: string } | null> {
    return this.tunnels.stopDesktopTunnelAttachment(
      ownerId,
      attachmentId,
      errorCode,
      preserveTunnelState,
      expected,
    );
  }

  async resetTransientTunnelAttachments(): Promise<void> {
    return this.tunnels.resetTransientTunnelAttachments();
  }

  async expireDesktopTunnelAttachments(now = new Date()): Promise<
    Array<{
      attachmentId: string;
      ownerId: string;
      projectId: string | null;
      tunnelId: string;
    }>
  > {
    return this.tunnels.expireDesktopTunnelAttachments(now);
  }
  async listProjects(ownerId: string): Promise<ProjectWireSummary[]> {
    return this.projects.listProjects(ownerId);
  }

  async getProject(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWireSummary | null> {
    return this.projects.getProject(ownerId, projectId);
  }
  async listMcpServers(
    ownerId: string,
    projectId: string | null,
  ): Promise<McpServerWireSummary[] | null> {
    return this.mcp.listMcpServers(ownerId, projectId);
  }

  async listEffectiveMcpServers(
    ownerId: string,
    projectId: string | null,
    workerId: string,
    audience: Exclude<ResourceAudience, "both"> = "ide",
  ): Promise<McpServerOpaqueRuntime[]> {
    return this.mcp.listEffectiveMcpServers(
      ownerId,
      projectId,
      workerId,
      audience,
    );
  }

  async createMcpServer(
    ownerId: string,
    projectId: string | null,
    input: EncryptedMcpServerCreate,
  ): Promise<McpServerWireSummary | null> {
    return this.mcp.createMcpServer(ownerId, projectId, input);
  }

  async updateMcpServer(
    ownerId: string,
    projectId: string | null,
    serverId: string,
    input: EncryptedMcpServerUpdate,
  ): Promise<McpServerWireSummary | null> {
    return this.mcp.updateMcpServer(ownerId, projectId, serverId, input);
  }

  async deleteMcpServer(
    ownerId: string,
    projectId: string | null,
    serverId: string,
  ): Promise<boolean> {
    return this.mcp.deleteMcpServer(ownerId, projectId, serverId);
  }

  async listSkillAudiences(
    ownerId: string,
    workerId: string,
    providerId: string,
  ): Promise<Array<{
    audienceKey: string;
    audience: ResourceAudience;
  }> | null> {
    return this.mcp.listSkillAudiences(ownerId, workerId, providerId);
  }

  async updateSkillAudience(
    ownerId: string,
    input: {
      audienceKey: string;
      audience: ResourceAudience;
      providerId: string;
      workerId: string;
    },
  ): Promise<{ audienceKey: string; audience: ResourceAudience } | null> {
    return this.mcp.updateSkillAudience(ownerId, input);
  }

  async listChatSkillAudienceKeys(
    ownerId: string,
    workerId: string,
    providerId: string,
  ): Promise<string[]> {
    return this.mcp.listChatSkillAudienceKeys(ownerId, workerId, providerId);
  }
  async ensureDefaultProjectWorkspace(
    ownerId: string,
  ): Promise<ProjectWorkspaceRow> {
    return this.projects.ensureDefaultProjectWorkspace(ownerId);
  }

  async listProjectWorkspaceWire(
    ownerId: string,
  ): Promise<ProjectWorkspaceWireList> {
    return this.projects.listProjectWorkspaceWire(ownerId);
  }

  async createEncryptedProjectWorkspace(
    ownerId: string,
    input: EncryptedProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceWireSummary> {
    return this.projects.createEncryptedProjectWorkspace(ownerId, input);
  }

  async updateEncryptedProjectWorkspace(
    ownerId: string,
    workspaceId: string,
    input: EncryptedProjectWorkspaceUpdate,
  ): Promise<ProjectWorkspaceWireSummary | null> {
    return this.projects.updateEncryptedProjectWorkspace(
      ownerId,
      workspaceId,
      input,
    );
  }

  async deleteProjectWorkspace(
    ownerId: string,
    workspaceId: string,
  ): Promise<boolean> {
    return this.projects.deleteProjectWorkspace(ownerId, workspaceId);
  }

  async updateProjectWorktreePolicy(
    ownerId: string,
    projectId: string,
    input: ProjectWorktreePolicyUpdate,
  ): Promise<ProjectWireSummary | null> {
    return this.projects.updateProjectWorktreePolicy(ownerId, projectId, input);
  }

  async updateProjectPreferredWorker(
    ownerId: string,
    projectId: string,
    workerId: string | null,
  ): Promise<ProjectWireSummary | null> {
    return this.projects.updateProjectPreferredWorker(
      ownerId,
      projectId,
      workerId,
    );
  }

  async listProjectReplicas(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectReplicaSummary[] | null> {
    return this.projects.listProjectReplicas(ownerId, projectId);
  }

  async getProjectReplica(
    ownerId: string,
    projectId: string,
    projectReplicaId: string,
  ): Promise<ProjectReplicaSummary | null> {
    return this.projects.getProjectReplica(
      ownerId,
      projectId,
      projectReplicaId,
    );
  }

  async getProjectSource(ownerId: string, projectId: string) {
    return this.projects.getProjectSource(ownerId, projectId);
  }

  async getProjectWorktreeContext(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<ProjectWorktreeExecutionContext | null> {
    return this.projects.getProjectWorktreeContext(
      ownerId,
      projectId,
      worktreeId,
    );
  }
  async resolveProjectExecutionPlacement(
    ownerId: string,
    projectId: string,
    surfaceKind: ExecutionSurfaceKind,
    target?: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowOfflineExplicit = false,
  ): Promise<ExecutionPlacementResolution> {
    return this.placement.resolveProjectExecutionPlacement(
      ownerId,
      projectId,
      surfaceKind,
      target,
      isWorkerConnected,
      allowOfflineExplicit,
    );
  }

  async resolveExecutionTarget(
    ownerId: string,
    projectId: string,
    target: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowUnavailable = false,
  ): Promise<ExecutionTargetResolution> {
    return this.executionTargets.resolveExecutionTarget(
      ownerId,
      projectId,
      target,
      isWorkerConnected,
      allowUnavailable,
    );
  }

  async resolveExecutionTargetSelector(
    ownerId: string,
    projectId: string,
    resourceKind: FocusedExecutionTargetResourceKind | null,
    selector: string | null,
    context: {
      terminalId: string | null;
      workerId: string;
      worktreeId: string;
    },
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExecutionTargetSelectorResult | null> {
    return this.executionTargets.resolveExecutionTargetSelector(
      ownerId,
      projectId,
      resourceKind,
      selector,
      context,
      isWorkerConnected,
    );
  }

  async listProjectExecutionTargets(
    ownerId: string,
    projectId: string,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExecutionTargetWireCatalog | null> {
    return this.executionTargets.listProjectExecutionTargets(
      ownerId,
      projectId,
      isWorkerConnected,
    );
  }

  async listProjectWorktrees(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWorktreeSummary[]> {
    return this.worktreeState.listProjectWorktrees(ownerId, projectId);
  }

  async listWorkerWorktreeObservationTargets(
    ownerId: string,
    workerId: string,
    limit = 128,
  ): Promise<ProjectWorktreeObservationContext[]> {
    return this.worktreeState.listWorkerWorktreeObservationTargets(
      ownerId,
      workerId,
      limit,
    );
  }

  async listWorkerExecutionRootContexts(
    ownerId: string,
    workerId: string,
    limit = 128,
  ): Promise<ProjectWorktreeObservationContext[]> {
    return this.worktreeState.listWorkerExecutionRootContexts(
      ownerId,
      workerId,
      limit,
    );
  }

  async getProjectWorktreeObservationContext(
    ownerId: string,
    workerId: string,
    sourcePath: string,
    worktreePath: string,
  ): Promise<ProjectWorktreeObservationContext | null> {
    return this.worktreeState.getProjectWorktreeObservationContext(
      ownerId,
      workerId,
      sourcePath,
      worktreePath,
    );
  }

  async getProjectWorktreeStatusSnapshot(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeStatusResult | null> {
    return this.worktreeState.getProjectWorktreeStatusSnapshot(
      ownerId,
      projectId,
      worktreeId,
    );
  }

  async recordProjectWorktreeStatus(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ): Promise<ProjectWorktreeStatusRecord | null> {
    return this.worktreeState.recordProjectWorktreeStatus(
      ownerId,
      projectId,
      worktreeId,
      status,
    );
  }

  async createGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    workerId: string,
    context: GitManagedOperationContext,
  ): Promise<GitManagedOperationRecord> {
    return this.worktreeState.createGitOperation(
      ownerId,
      projectId,
      worktreeId,
      workerId,
      context,
    );
  }

  async getActiveGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<GitManagedOperationRecord | null> {
    return this.worktreeState.getActiveGitOperation(
      ownerId,
      projectId,
      worktreeId,
    );
  }

  async markGitOperationRunning(
    operationId: string,
  ): Promise<GitManagedOperationRecord | null> {
    return this.worktreeState.markGitOperationRunning(operationId);
  }

  async getGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
  ): Promise<GitManagedOperationRecord | null> {
    return this.worktreeState.getGitOperation(
      ownerId,
      projectId,
      worktreeId,
      operationId,
    );
  }

  async getLatestGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<GitManagedOperationRecord | null> {
    return this.worktreeState.getLatestGitOperation(
      ownerId,
      projectId,
      worktreeId,
    );
  }

  async updateGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
    state: GitManagedOperationWorkerState,
  ): Promise<GitManagedOperationRecord | null> {
    return this.worktreeState.updateGitOperation(
      ownerId,
      projectId,
      worktreeId,
      operationId,
      state,
    );
  }

  async failGitOperation(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    operationId: string,
    error: string,
  ): Promise<GitManagedOperationRecord | null> {
    return this.worktreeState.failGitOperation(
      ownerId,
      projectId,
      worktreeId,
      operationId,
      error,
    );
  }

  async listRunConfigurationSecretSummaries(
    ownerId: string,
    projectId: string,
  ): Promise<RunConfigurationSecretSummary[]> {
    const rows = await this.database
      .select({ secret: schema.runConfigurationSecrets })
      .from(schema.runConfigurationSecrets)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.runConfigurationSecrets.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.runConfigurationSecrets.projectId, projectId))
      .orderBy(asc(schema.runConfigurationSecrets.reference))
      .limit(256);
    return runConfigurationSecretSummaryListSchema.parse(
      rows.map(({ secret }) => toRunConfigurationSecretSummary(secret)),
    );
  }

  async getRunConfigurationSecretStatuses(
    ownerId: string,
    projectId: string,
    references: string[],
  ): Promise<RunConfigurationSecretSummary[]> {
    const ordered = [...new Set(references)].slice(0, 256);
    if (ordered.length === 0) return [];
    const records = await this.listRunConfigurationProtectedSecrets(
      ownerId,
      projectId,
      ordered,
    );
    const byReference = new Map(
      records.map((record) => [record.reference, record]),
    );
    return runConfigurationSecretSummaryListSchema.parse(
      ordered.map((reference) => {
        const record = byReference.get(reference);
        return record
          ? {
              reference,
              available: true,
              revision: record.revision,
              updatedAt: record.updatedAt,
            }
          : {
              reference,
              available: false,
              revision: null,
              updatedAt: null,
            };
      }),
    );
  }

  async listRunConfigurationProtectedSecrets(
    ownerId: string,
    projectId: string,
    references: string[],
  ): Promise<Array<RunConfigurationProtectedSecret & { updatedAt: string }>> {
    const unique = [...new Set(references)].slice(0, 256);
    if (unique.length === 0) return [];
    const rows = await this.database
      .select({ secret: schema.runConfigurationSecrets })
      .from(schema.runConfigurationSecrets)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.runConfigurationSecrets.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.runConfigurationSecrets.projectId, projectId),
          inArray(schema.runConfigurationSecrets.reference, unique),
        ),
      )
      .orderBy(asc(schema.runConfigurationSecrets.reference));
    const protectedSecrets = runConfigurationProtectedSecretListSchema.parse(
      rows.map(({ secret }) => toRunConfigurationProtectedSecret(secret)),
    );
    const updatedAt = new Map(
      rows.map(({ secret }) => [
        secret.reference,
        toISOString(secret.updatedAt),
      ]),
    );
    return protectedSecrets.map((secret) => ({
      ...secret,
      updatedAt: updatedAt.get(secret.reference)!,
    }));
  }

  async setRunConfigurationSecret(
    ownerId: string,
    projectId: string,
    raw: unknown,
  ): Promise<RunConfigurationSecretSetResult> {
    const request = runConfigurationSecretSetRequestSchema.parse(raw);
    const digest = runConfigurationSecretValueDigest(request.protectedValue);
    return this.database.transaction(async (transaction) => {
      const replay = (
        operation: RunConfigurationSecretOperationRow,
      ): RunConfigurationSecretSetResult => {
        if (
          operation.ownerId !== ownerId ||
          operation.projectId !== projectId ||
          operation.reference !== request.reference ||
          operation.protectedValueDigest !== digest
        ) {
          throw new Error(
            "The Run configuration secret operation identity is already in use.",
          );
        }
        return replayedRunConfigurationSecretSetResult(operation);
      };

      const existingOperations = await transaction
        .select()
        .from(schema.runConfigurationSecretOperations)
        .where(
          eq(schema.runConfigurationSecretOperations.id, request.operationId),
        )
        .limit(1);
      if (existingOperations[0]) return replay(existingOperations[0]);

      const now = new Date();
      const claimed = await transaction
        .insert(schema.runConfigurationSecretOperations)
        .values({
          id: request.operationId,
          ownerId,
          projectId,
          reference: request.reference,
          revision: null,
          protectedValueDigest: digest,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: schema.runConfigurationSecretOperations.id,
        })
        .returning();
      if (!claimed[0]) {
        const raced = await transaction
          .select()
          .from(schema.runConfigurationSecretOperations)
          .where(
            eq(schema.runConfigurationSecretOperations.id, request.operationId),
          )
          .limit(1);
        if (!raced[0]) {
          throw new Error(
            "Could not recover the Run configuration secret operation.",
          );
        }
        return replay(raced[0]);
      }

      const projects = await transaction
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!projects[0]) {
        throw new Error("The Run configuration secret project was not found.");
      }

      const secrets = await transaction
        .insert(schema.runConfigurationSecrets)
        .values({
          id: randomUUID(),
          ownerId,
          projectId,
          reference: request.reference,
          protectedValue: request.protectedValue,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.runConfigurationSecrets.projectId,
            schema.runConfigurationSecrets.reference,
          ],
          set: {
            ownerId,
            protectedValue: request.protectedValue,
            revision: sql`${schema.runConfigurationSecrets.revision} + 1`,
            updatedAt: now,
          },
        })
        .returning();
      const secret = secrets[0];
      if (!secret) {
        throw new Error("Could not store the Run configuration secret.");
      }
      const completed = await transaction
        .update(schema.runConfigurationSecretOperations)
        .set({ revision: secret.revision })
        .where(
          and(
            eq(schema.runConfigurationSecretOperations.id, request.operationId),
            isNull(schema.runConfigurationSecretOperations.revision),
          ),
        )
        .returning();
      if (!completed[0]) {
        throw new Error(
          "Could not complete the Run configuration secret operation.",
        );
      }
      return runConfigurationSecretSetResultSchema.parse({
        operationId: request.operationId,
        projectId,
        replayed: false,
        secret: toRunConfigurationSecretSummary(secret),
      });
    });
  }

  async getRunConfigurationRuntimeOperationResult(
    ownerId: string,
    operationId: string,
  ): Promise<RunConfigurationRuntimeOperationResult | null> {
    const rows = await this.database
      .select({ operation: schema.runConfigurationRuntimeOperations })
      .from(schema.runConfigurationRuntimeOperations)
      .where(
        and(
          eq(schema.runConfigurationRuntimeOperations.id, operationId),
          eq(schema.runConfigurationRuntimeOperations.ownerId, ownerId),
        ),
      )
      .limit(1);
    const operation = rows[0]?.operation;
    if (!operation) return null;
    const runtimeRows = operation.runtimeId
      ? await this.database
          .select({ runtime: schema.runConfigurationRuntimes })
          .from(schema.runConfigurationRuntimes)
          .where(
            and(
              eq(schema.runConfigurationRuntimes.id, operation.runtimeId),
              eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            ),
          )
          .limit(1)
      : [];
    return {
      operation: toRunConfigurationRuntimeOperation(operation),
      replayed: true,
      runtime: runtimeRows[0]
        ? toRunConfigurationRuntime(runtimeRows[0].runtime)
        : null,
    };
  }

  async requestRunConfigurationRuntimeOperation(
    ownerId: string,
    input: RunConfigurationRuntimeOperationRequest,
  ): Promise<RunConfigurationRuntimeOperationResult> {
    const terminalPosition = await this.nextProjectTabPosition(input.projectId);
    return this.database.transaction(async (transaction) => {
      const operationRows = await transaction
        .select()
        .from(schema.runConfigurationRuntimeOperations)
        .where(
          eq(schema.runConfigurationRuntimeOperations.id, input.operationId),
        )
        .limit(1);

      const replay = async (
        row: RunConfigurationRuntimeOperationRow,
      ): Promise<RunConfigurationRuntimeOperationResult> => {
        if (
          row.ownerId !== ownerId ||
          row.projectId !== input.projectId ||
          row.configurationId !== input.configurationId ||
          row.worktreeId !== input.worktreeId ||
          row.workerId !== input.workerId ||
          row.operation !== input.operation ||
          row.definitionRevision !== input.definitionRevision ||
          row.codexEnvironmentRevision !== input.codexEnvironmentRevision
        ) {
          throw new Error(
            "The Run configuration operation identity is already in use.",
          );
        }
        const runtimeRows = row.runtimeId
          ? await transaction
              .select()
              .from(schema.runConfigurationRuntimes)
              .where(
                and(
                  eq(schema.runConfigurationRuntimes.id, row.runtimeId),
                  eq(schema.runConfigurationRuntimes.ownerId, ownerId),
                ),
              )
              .limit(1)
          : [];
        return {
          operation: toRunConfigurationRuntimeOperation(row),
          replayed: true,
          runtime: runtimeRows[0]
            ? toRunConfigurationRuntime(runtimeRows[0])
            : null,
        };
      };

      if (operationRows[0]) return replay(operationRows[0]);

      const placements = await transaction
        .select({ workerId: schema.projectWorktrees.workerId })
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
            eq(schema.projects.id, input.projectId),
            eq(schema.projectWorktrees.id, input.worktreeId),
            eq(schema.projectWorktrees.workerId, input.workerId),
            eq(schema.projectWorktrees.lifecycleState, "ready"),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .limit(1);
      if (!placements[0]) {
        throw new Error(
          "The Run configuration target worktree is not available on that worker.",
        );
      }

      let runtimeRows = await transaction
        .select()
        .from(schema.runConfigurationRuntimes)
        .where(
          and(
            eq(schema.runConfigurationRuntimes.projectId, input.projectId),
            eq(
              schema.runConfigurationRuntimes.configurationId,
              input.configurationId,
            ),
            eq(schema.runConfigurationRuntimes.worktreeId, input.worktreeId),
          ),
        )
        .limit(1)
        .for("update");

      if (!runtimeRows[0] && input.operation === "start") {
        await transaction
          .insert(schema.runConfigurationRuntimes)
          .values({
            id: randomUUID(),
            ownerId,
            projectId: input.projectId,
            configurationId: input.configurationId,
            worktreeId: input.worktreeId,
            workerId: input.workerId,
            definitionRevision: input.definitionRevision,
            codexEnvironmentRevision: input.codexEnvironmentRevision,
            generation: 0,
            requestedOperationId: input.operationId,
            state: "idle",
          })
          .onConflictDoNothing({
            target: [
              schema.runConfigurationRuntimes.projectId,
              schema.runConfigurationRuntimes.configurationId,
              schema.runConfigurationRuntimes.worktreeId,
            ],
          });
        runtimeRows = await transaction
          .select()
          .from(schema.runConfigurationRuntimes)
          .where(
            and(
              eq(schema.runConfigurationRuntimes.projectId, input.projectId),
              eq(
                schema.runConfigurationRuntimes.configurationId,
                input.configurationId,
              ),
              eq(schema.runConfigurationRuntimes.worktreeId, input.worktreeId),
            ),
          )
          .limit(1)
          .for("update");
      }

      const racedOperationRows = await transaction
        .select()
        .from(schema.runConfigurationRuntimeOperations)
        .where(
          eq(schema.runConfigurationRuntimeOperations.id, input.operationId),
        )
        .limit(1);
      if (racedOperationRows[0]) return replay(racedOperationRows[0]);

      let current = runtimeRows[0];
      let outcome: RunConfigurationRuntimeOperationRecord["outcome"];
      let generation = current?.generation ?? 0;
      if (!current) {
        outcome = "not-active";
      } else if (
        input.operation === "start" &&
        ["starting", "running", "restarting", "stopping"].includes(
          current.state,
        )
      ) {
        outcome = "already-active";
      } else if (input.operation === "restart") {
        if (
          ["starting", "running", "restarting", "stopping"].includes(
            current.state,
          )
        ) {
          outcome = "accepted";
          generation += 1;
        } else {
          outcome = "not-active";
        }
      } else if (input.operation === "stop") {
        if (current.state === "stopping") {
          outcome = "already-stopping";
        } else if (
          ["starting", "running", "restarting"].includes(current.state)
        ) {
          outcome = "accepted";
        } else {
          outcome = "not-active";
        }
      } else {
        outcome = "accepted";
        generation += 1;
      }

      if (
        current &&
        ["starting", "running", "restarting", "stopping"].includes(
          current.state,
        ) &&
        current.workerId !== input.workerId
      ) {
        throw new Error(
          "The active Run configuration runtime belongs to another worker.",
        );
      }

      if (current && outcome === "accepted" && current.terminalId === null) {
        const terminalId = current.id;
        const insertedTerminals = await transaction
          .insert(schema.terminals)
          .values({
            id: terminalId,
            projectId: input.projectId,
            kind: "run-configuration",
            protectedLabel: null,
            protectedState: null,
            position: terminalPosition,
            status: "running",
            activeWorkerId: input.workerId,
            worktreeId: input.worktreeId,
            linkedChatId: null,
            runConfigurationId: input.configurationId,
            runConfigurationRuntimeId: current.id,
            serviceEnabled: false,
          })
          .onConflictDoNothing({ target: schema.terminals.id })
          .returning();
        const terminalRows = insertedTerminals[0]
          ? insertedTerminals
          : await transaction
              .select()
              .from(schema.terminals)
              .where(eq(schema.terminals.id, terminalId))
              .limit(1);
        const terminal = terminalRows[0];
        if (
          !terminal ||
          terminal.projectId !== input.projectId ||
          terminal.kind !== "run-configuration" ||
          terminal.activeWorkerId !== input.workerId ||
          terminal.worktreeId !== input.worktreeId ||
          terminal.runConfigurationId !== input.configurationId ||
          terminal.runConfigurationRuntimeId !== current.id
        ) {
          throw new Error(
            "The Run configuration terminal identity belongs to another surface.",
          );
        }
        const boundRows = await transaction
          .update(schema.runConfigurationRuntimes)
          .set({ terminalId, updatedAt: new Date() })
          .where(
            and(
              eq(schema.runConfigurationRuntimes.id, current.id),
              eq(schema.runConfigurationRuntimes.ownerId, ownerId),
              isNull(schema.runConfigurationRuntimes.terminalId),
            ),
          )
          .returning();
        if (!boundRows[0]) {
          throw new Error("Could not bind the Run configuration terminal.");
        }
        current = boundRows[0];
        if (insertedTerminals[0]) {
          await attachProjectTab(transaction, {
            projectId: input.projectId,
            tabId: terminalId,
            tabKind: "terminal",
          });
        }
      }

      const insertedOperations = await transaction
        .insert(schema.runConfigurationRuntimeOperations)
        .values({
          id: input.operationId,
          ownerId,
          projectId: input.projectId,
          configurationId: input.configurationId,
          worktreeId: input.worktreeId,
          runtimeId: current?.id ?? null,
          workerId: input.workerId,
          operation: input.operation,
          outcome,
          generation,
          definitionRevision: input.definitionRevision,
          codexEnvironmentRevision: input.codexEnvironmentRevision,
        })
        .onConflictDoNothing({
          target: schema.runConfigurationRuntimeOperations.id,
        })
        .returning();
      if (!insertedOperations[0]) {
        const raced = await transaction
          .select()
          .from(schema.runConfigurationRuntimeOperations)
          .where(
            eq(schema.runConfigurationRuntimeOperations.id, input.operationId),
          )
          .limit(1);
        if (!raced[0]) {
          throw new Error("Could not recover the Run configuration operation.");
        }
        return replay(raced[0]);
      }

      let updated = current;
      if (current && outcome === "accepted") {
        const nextState =
          input.operation === "start"
            ? "starting"
            : input.operation === "restart"
              ? "restarting"
              : "stopping";
        const launch = input.operation !== "stop";
        const updatedRows = await transaction
          .update(schema.runConfigurationRuntimes)
          .set({
            workerId: input.workerId,
            definitionRevision: launch
              ? input.definitionRevision
              : current.definitionRevision,
            codexEnvironmentRevision: launch
              ? input.codexEnvironmentRevision
              : current.codexEnvironmentRevision,
            generation,
            requestedOperationId: input.operationId,
            state: nextState,
            startedAt: launch ? null : current.startedAt,
            endedAt: null,
            exitCode: launch ? null : current.exitCode,
            signal: launch ? null : current.signal,
            failure: launch ? null : current.failure,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.runConfigurationRuntimes.id, current.id),
              eq(schema.runConfigurationRuntimes.ownerId, ownerId),
              eq(
                schema.runConfigurationRuntimes.generation,
                current.generation,
              ),
              eq(schema.runConfigurationRuntimes.state, current.state),
            ),
          )
          .returning();
        if (!updatedRows[0]) {
          throw new Error(
            "The Run configuration runtime changed during the operation.",
          );
        }
        updated = updatedRows[0];
      }

      return {
        operation: toRunConfigurationRuntimeOperation(insertedOperations[0]),
        replayed: false,
        runtime: updated ? toRunConfigurationRuntime(updated) : null,
      };
    });
  }

  async getRunConfigurationRuntime(
    ownerId: string,
    projectId: string,
    configurationId: string,
    worktreeId: string,
  ): Promise<RunConfigurationRuntime | null> {
    const rows = await this.database
      .select({ runtime: schema.runConfigurationRuntimes })
      .from(schema.runConfigurationRuntimes)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.runConfigurationRuntimes.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.runConfigurationRuntimes.projectId, projectId),
          eq(schema.runConfigurationRuntimes.configurationId, configurationId),
          eq(schema.runConfigurationRuntimes.worktreeId, worktreeId),
        ),
      )
      .limit(1);
    return rows[0] ? toRunConfigurationRuntime(rows[0].runtime) : null;
  }

  async listRunConfigurationRuntimes(
    ownerId: string,
    projectId: string,
    input: {
      configurationId?: string;
      worktreeId?: string;
      limit?: number;
    } = {},
  ): Promise<RunConfigurationRuntime[]> {
    const rows = await this.database
      .select({ runtime: schema.runConfigurationRuntimes })
      .from(schema.runConfigurationRuntimes)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.runConfigurationRuntimes.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.runConfigurationRuntimes.projectId, projectId),
          input.configurationId
            ? eq(
                schema.runConfigurationRuntimes.configurationId,
                input.configurationId,
              )
            : undefined,
          input.worktreeId
            ? eq(schema.runConfigurationRuntimes.worktreeId, input.worktreeId)
            : undefined,
        ),
      )
      .orderBy(
        desc(
          sql<boolean>`${schema.runConfigurationRuntimes.state} IN ('starting', 'running', 'restarting', 'stopping')`,
        ),
        desc(schema.runConfigurationRuntimes.updatedAt),
        asc(schema.runConfigurationRuntimes.configurationId),
      )
      .limit(Math.min(256, Math.max(1, input.limit ?? 256)));
    return rows.map(({ runtime }) => toRunConfigurationRuntime(runtime));
  }

  async deleteRunConfigurationRuntimes(
    ownerId: string,
    projectId: string,
    runtimeIds: readonly string[],
  ): Promise<number> {
    if (runtimeIds.length === 0) return 0;
    const rows = await this.database
      .delete(schema.runConfigurationRuntimes)
      .where(
        and(
          eq(schema.runConfigurationRuntimes.ownerId, ownerId),
          eq(schema.runConfigurationRuntimes.projectId, projectId),
          inArray(schema.runConfigurationRuntimes.id, [...runtimeIds]),
          sql`${schema.runConfigurationRuntimes.state} NOT IN ('starting', 'running', 'restarting', 'stopping')`,
        ),
      )
      .returning({ id: schema.runConfigurationRuntimes.id });
    return rows.length;
  }

  async listActiveRunConfigurationRuntimeIdentitiesForWorker(
    ownerId: string,
    workerId: string,
  ): Promise<RunConfigurationRuntimeWorkerIdentity[]> {
    const rows = await this.database
      .select({ runtime: schema.runConfigurationRuntimes })
      .from(schema.runConfigurationRuntimes)
      .where(
        and(
          eq(schema.runConfigurationRuntimes.ownerId, ownerId),
          eq(schema.runConfigurationRuntimes.workerId, workerId),
          inArray(schema.runConfigurationRuntimes.state, [
            "starting",
            "running",
            "restarting",
            "stopping",
          ]),
        ),
      )
      .orderBy(asc(schema.runConfigurationRuntimes.createdAt))
      .limit(256);
    return rows.map(({ runtime }) => ({
      runtimeId: runtime.id,
      projectId: runtime.projectId,
      configurationId: runtime.configurationId,
      worktreeId: runtime.worktreeId,
      workerId: runtime.workerId,
      definitionRevision: runtime.definitionRevision,
      codexEnvironmentRevision: runtime.codexEnvironmentRevision,
      generation: runtime.generation,
      operationId: runtime.requestedOperationId,
      terminalId: runtime.terminalId,
    }));
  }

  async applyRunConfigurationRuntimeObservation(
    ownerId: string,
    workerId: string,
    observation: RunConfigurationRuntimeWorkerObservation,
  ): Promise<RunConfigurationRuntimeObservationApplyResult | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.runConfigurationRuntimes)
        .where(
          and(
            eq(schema.runConfigurationRuntimes.id, observation.runtimeId),
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
          ),
        )
        .limit(1)
        .for("update");
      const current = rows[0];
      if (!current || current.workerId !== workerId) return null;
      if (
        current.projectId !== observation.projectId ||
        current.configurationId !== observation.configurationId ||
        current.worktreeId !== observation.worktreeId ||
        current.definitionRevision !== observation.definitionRevision ||
        current.codexEnvironmentRevision !==
          observation.codexEnvironmentRevision ||
        current.terminalId !== observation.terminalId
      ) {
        throw new Error(
          "Worker Run configuration state does not match its durable identity.",
        );
      }
      const runtime = () => toRunConfigurationRuntime(current);
      if (observation.generation < current.generation) {
        return {
          applied: false,
          reason: "stale-generation",
          runtime: runtime(),
        };
      }
      if (observation.generation > current.generation) {
        throw new Error(
          "Worker Run configuration generation is ahead of durable state.",
        );
      }
      if (observation.operationId !== current.requestedOperationId) {
        return {
          applied: false,
          reason: "stale-operation",
          runtime: runtime(),
        };
      }
      if (observation.state === current.state) {
        return { applied: false, reason: "unchanged", runtime: runtime() };
      }

      const allowed: Record<
        RunConfigurationRuntime["state"],
        RunConfigurationRuntime["state"][]
      > = {
        idle: [],
        starting: ["running", "stopping", "exited", "failed", "lost"],
        running: ["stopping", "exited", "failed", "lost"],
        restarting: [
          "starting",
          "running",
          "stopping",
          "exited",
          "failed",
          "lost",
        ],
        stopping: ["idle", "exited", "failed", "lost"],
        exited: [],
        failed: [],
        lost: [],
      };
      if (!allowed[current.state].includes(observation.state)) {
        return {
          applied: false,
          reason: "invalid-transition",
          runtime: runtime(),
        };
      }

      const updatedRows = await transaction
        .update(schema.runConfigurationRuntimes)
        .set({
          state: observation.state,
          startedAt: observation.startedAt
            ? new Date(observation.startedAt)
            : current.startedAt,
          endedAt: observation.endedAt ? new Date(observation.endedAt) : null,
          exitCode: observation.exitCode,
          signal: observation.signal,
          failure: observation.failure,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.runConfigurationRuntimes.id, current.id),
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            eq(schema.runConfigurationRuntimes.generation, current.generation),
            eq(
              schema.runConfigurationRuntimes.requestedOperationId,
              current.requestedOperationId,
            ),
            eq(schema.runConfigurationRuntimes.state, current.state),
          ),
        )
        .returning();
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(
          "The Run configuration runtime changed during its observation.",
        );
      }
      return {
        applied: true,
        reason: "applied",
        runtime: toRunConfigurationRuntime(updated),
      };
    });
  }

  async reconcileProjectWorktrees(
    ownerId: string,
    projectId: string,
    workerId: string,
    inventory: WorktreeInventory,
    created?: {
      id: string;
      lifecycleState?: ProjectWorktreeSummary["lifecycleState"];
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
    const observedPrimaries = inventory.worktrees.filter(
      ({ isPrimary }) => isPrimary,
    );
    if (observedPrimaries.length !== 1) {
      throw new Error("Worker inventory did not contain exactly one Primary.");
    }
    const observedPrimary = observedPrimaries[0]!;
    // Protected repository paths are deliberately scoped by result field.
    // `source.absolutePath` and `observedPrimary.path` both originate from the
    // canonical `path` field, while `sourcePath` and `primaryPath` use distinct
    // routing handles even when they identify the same worker-local directory.
    if (source.absolutePath !== observedPrimary.path) {
      throw new Error("Worker inventory referred to a different replica path.");
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
          absolutePath: observedPrimary.path,
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
        const lifecycleState = observedWorktreeLifecycle(
          matched
            ? (matched.lifecycleState as ProjectWorktreeSummary["lifecycleState"])
            : created?.path === observed.path
              ? (created.lifecycleState ?? null)
              : null,
          observed,
        );
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

  async rollbackProjectWorktreeCreation(
    ownerId: string,
    projectId: string,
    workerId: string,
    created: {
      id: string;
      origin: ProjectWorktreeSummary["origin"];
      path: string;
    },
  ): Promise<boolean> {
    if (created.origin !== "agent" && created.origin !== "cantrip") {
      return false;
    }
    const sources = await this.database
      .select({ id: schema.projectSources.id })
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
    const sourceId = sources[0]?.id;
    if (!sourceId) return false;

    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(schema.projectWorktrees)
        .where(eq(schema.projectWorktrees.id, created.id))
        .limit(1);
      const row = rows[0];
      if (!row) return true;
      if (
        row.projectSourceId !== sourceId ||
        row.workerId !== workerId ||
        row.absolutePath !== created.path ||
        row.isPrimary ||
        row.origin !== created.origin
      ) {
        return false;
      }
      const deleted = await transaction
        .delete(schema.projectWorktrees)
        .where(
          and(
            eq(schema.projectWorktrees.id, created.id),
            eq(schema.projectWorktrees.projectSourceId, sourceId),
            eq(schema.projectWorktrees.workerId, workerId),
            eq(schema.projectWorktrees.absolutePath, created.path),
            eq(schema.projectWorktrees.isPrimary, false),
            eq(schema.projectWorktrees.origin, created.origin),
          ),
        )
        .returning({ id: schema.projectWorktrees.id });
      return deleted.length === 1;
    });
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
    const lifecycleState = observedWorktreeLifecycle(
      context.worktree.lifecycleState,
      observed,
    );
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
              ne(schema.terminals.kind, "run-configuration"),
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
    options: { includeHistory?: boolean } = {},
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
        options.includeHistory
          ? eq(schema.chats.projectId, projectId)
          : and(
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
        .set({
          status: "failed",
          hasUnreadCompletion: true,
          updatedAt: now,
        })
        .where(
          and(
            inArray(schema.chats.status, ["running", "waiting-for-approval"]),
            eq(schema.chats.automationPaused, false),
          ),
        );
      await transaction
        .update(schema.chats)
        .set({ status: "idle", hasUnreadCompletion: true, updatedAt: now })
        .where(
          and(
            inArray(schema.chats.status, ["running", "waiting-for-approval"]),
            eq(schema.chats.automationPaused, true),
          ),
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
    const identities = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (identities[0]?.contextKind === "standalone") {
      return this.startStandaloneChatExecutionLane(
        ownerId,
        chatId,
        acquiringActor,
        purpose,
      );
    }
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
        const projectId = requiredProjectChatProjectId(row.chat.projectId);
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
          projectId,
          workerId: row.worktree.workerId,
          worktreeId: row.worktree.id,
        });
        return {
          contextKind: "project",
          automationPaused: row.chat.automationPaused,
          chatId,
          cwd: row.worktree.absolutePath,
          experience: row.chat.experience as ChatWireSummary["experience"],
          defaultPermissionProfileId:
            (row.settings?.defaultPermissionProfileId as
              UserSettings["defaultPermissionProfileId"] | undefined) ??
            DEFAULT_PERMISSION_PROFILE_ID,
          executionLaneId: lane.id,
          isPrimary: row.worktree.isPrimary,
          status: "running",
          modelId: row.chat.modelId,
          reasoningEffort: row.chat.reasoningEffort,
          modelConfiguration: chatModelConfiguration(row.chat),
          modelRouteId: runtime.modelRouteId,
          providerAccountId: runtime.providerAccountId,
          permissionProfileId: row.chat.permissionProfileId,
          planMode: row.chat.planMode as PlanMode,
          projectId,
          rootKind: row.worktree.rootKind,
          scratchRootId: null,
          threadId: runtime.codexThreadId,
          workerId: row.worktree.workerId,
          worktreeId: row.worktree.id,
          worktreeMode: row.chat
            .worktreeMode as ChatWireSummary["worktreeMode"],
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

  private async startStandaloneChatExecutionLane(
    ownerId: string,
    chatId: string,
    acquiringActor: ChatExecutionLaneSummary["acquiringActor"],
    purpose: string,
  ): Promise<StandaloneChatExecutionContext | null> {
    return this.database.transaction(async (transaction) => {
      const locked = await transaction
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "standalone"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked[0]) return null;
      const rows = await transaction
        .select({
          chat: schema.chats,
          root: schema.standaloneChatRoots,
          runtime: schema.chatRuntimeSessions,
          settings: schema.userSettings,
        })
        .from(schema.chats)
        .innerJoin(
          schema.standaloneChatRoots,
          and(
            eq(schema.standaloneChatRoots.id, schema.chats.activeScratchRootId),
            eq(schema.standaloneChatRoots.chatId, schema.chats.id),
            eq(schema.standaloneChatRoots.ownerId, schema.chats.ownerId),
            eq(
              schema.standaloneChatRoots.workerId,
              schema.chats.activeWorkerId,
            ),
          ),
        )
        .leftJoin(
          schema.chatRuntimeSessions,
          and(
            eq(schema.chatRuntimeSessions.chatId, schema.chats.id),
            eq(
              schema.chatRuntimeSessions.workerId,
              schema.standaloneChatRoots.workerId,
            ),
            eq(
              schema.chatRuntimeSessions.scratchRootId,
              schema.standaloneChatRoots.id,
            ),
          ),
        )
        .leftJoin(
          schema.userSettings,
          eq(schema.userSettings.userId, schema.chats.ownerId),
        )
        .where(eq(schema.chats.id, chatId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      if (row.root.status !== "ready" || !row.root.protectedPathHandle) {
        throw new ExecutionLaneConflictError(
          row.root.status === "provisioning"
            ? "The standalone Chat scratch root is still provisioning."
            : "The standalone Chat scratch root is unavailable.",
        );
      }
      if (chatIsExecuting(row.chat.status as ChatWireSummary["status"])) {
        throw new ExecutionLaneConflictError(
          "This Chat already has an active execution.",
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
          "This Chat already has an active execution.",
        );
      }
      let runtime = row.runtime;
      if (!runtime) {
        runtime = firstOrThrow(
          await transaction
            .insert(schema.chatRuntimeSessions)
            .values({
              id: randomUUID(),
              chatId,
              workerId: row.root.workerId,
              worktreeId: null,
              scratchRootId: row.root.id,
            })
            .returning(),
          "creating a standalone Chat runtime",
        );
      }
      const existing = await transaction
        .select()
        .from(schema.chatExecutionLanes)
        .where(
          and(
            eq(schema.chatExecutionLanes.chatId, chatId),
            eq(schema.chatExecutionLanes.scratchRootId, row.root.id),
            ne(schema.chatExecutionLanes.state, "released"),
          ),
        )
        .orderBy(desc(schema.chatExecutionLanes.createdAt))
        .limit(1);
      const now = new Date();
      const lane = existing[0]
        ? firstOrThrow(
            await transaction
              .update(schema.chatExecutionLanes)
              .set({
                acquiringActor,
                exclusive: false,
                purpose,
                state: "active",
                activatedAt: now,
                releasedAt: null,
                runtimeSessionId: runtime.id,
                codexThreadId: runtime.codexThreadId,
                updatedAt: now,
              })
              .where(eq(schema.chatExecutionLanes.id, existing[0].id))
              .returning(),
            "activating a standalone Chat execution lane",
          )
        : firstOrThrow(
            await transaction
              .insert(schema.chatExecutionLanes)
              .values({
                id: randomUUID(),
                chatId,
                worktreeId: null,
                scratchRootId: row.root.id,
                workerId: row.root.workerId,
                acquiringActor,
                exclusive: false,
                purpose,
                state: "active",
                runtimeSessionId: runtime.id,
                codexThreadId: runtime.codexThreadId,
                activatedAt: now,
              })
              .returning(),
            "creating a standalone Chat execution lane",
          );
      return {
        contextKind: "standalone",
        automationPaused: false,
        chatId,
        cwd: row.root.protectedPathHandle,
        experience: "agent",
        defaultPermissionProfileId:
          (row.settings?.defaultChatPermissionProfileId as
            UserSettings["defaultChatPermissionProfileId"] | undefined) ??
          DEFAULT_PERMISSION_PROFILE_ID,
        executionLaneId: lane.id,
        isPrimary: true,
        status: "running",
        modelId: row.chat.modelId,
        reasoningEffort: row.chat.reasoningEffort,
        modelConfiguration: chatModelConfiguration(row.chat),
        modelRouteId: runtime.modelRouteId,
        providerAccountId: runtime.providerAccountId,
        permissionProfileId: row.chat.permissionProfileId,
        planMode: "default",
        projectId: null,
        rootKind: null,
        scratchRootStatus: "ready",
        scratchRootId: row.root.id,
        threadId: runtime.codexThreadId,
        workerId: row.root.workerId,
        worktreeId: null,
        worktreeMode: null,
        worktreePolicy: null,
      };
    });
  }

  async finishChatExecutionLane(
    chatId: string,
    laneId: string,
    status: ChatWireSummary["status"],
  ): Promise<boolean> {
    const now = new Date();
    return this.database.transaction(async (transaction) => {
      const laneRows = await transaction
        .select({
          lane: schema.chatExecutionLanes,
          isPrimary: schema.projectWorktrees.isPrimary,
        })
        .from(schema.chatExecutionLanes)
        .leftJoin(
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
        .set({
          status,
          ...(status === "idle" || status === "failed"
            ? { hasUnreadCompletion: true }
            : {}),
          updatedAt: now,
        })
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
    if (!row) return null;
    return {
      chat: toChatWireSummary(row.chat),
      lane: toChatExecutionLaneSummary(row.lane),
      sourcePath: row.sourcePath,
      worktree: toProjectWorktreeSummary(
        row.worktree,
        requiredProjectChatProjectId(row.chat.projectId),
      ),
    };
  }

  async getChatExecutionRecoveryContext(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<ChatExecutionRecoveryContext | null> {
    const project = await this.getChatExecutionLaneContext(
      ownerId,
      chatId,
      laneId,
    );
    if (project) return project;
    const rows = await this.database
      .select({
        chat: schema.chats,
        lane: schema.chatExecutionLanes,
        root: schema.standaloneChatRoots,
      })
      .from(schema.chatExecutionLanes)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatExecutionLanes.chatId),
      )
      .innerJoin(
        schema.standaloneChatRoots,
        eq(
          schema.standaloneChatRoots.id,
          schema.chatExecutionLanes.scratchRootId,
        ),
      )
      .where(
        and(
          eq(schema.chatExecutionLanes.id, laneId),
          eq(schema.chatExecutionLanes.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.root.protectedPathHandle) return null;
    const lane = toContextualChatExecutionLaneSummary(row.lane);
    if (lane.contextKind !== "standalone") return null;
    return {
      chat: toStandaloneChatWireSummary(row.chat),
      lane,
      root: {
        id: row.root.id,
        pathHandle: row.root.protectedPathHandle,
        workerId: row.root.workerId,
      },
    };
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
        chat: toChatWireSummary(
          firstOrThrow(chats, "selecting a released chat"),
        ),
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
    if (current.contextKind !== "project") {
      throw new ExecutionLaneConflictError(
        "Standalone Chats do not support worktree transitions.",
      );
    }
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
        chat: toChatWireSummary(
          firstOrThrow(chats, "switching chat worktrees"),
        ),
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
    workerId?: string,
  ): Promise<GithubProjectExecutionContext | null> {
    const rows = await this.database
      .select({
        nameWithOwner: schema.projects.githubRepositoryFullName,
        url: schema.projects.githubRepositoryUrl,
        projectReplicaId: schema.projectSources.id,
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
          isNull(schema.projectSources.removedAt),
          workerId ? eq(schema.projectSources.workerId, workerId) : undefined,
        ),
      )
      .orderBy(asc(schema.projectSources.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row?.nameWithOwner || !row.url) return null;
    const provision = await this.database
      .select({ repository: schema.projectReplicaJobs.repository })
      .from(schema.projectReplicaJobs)
      .where(
        and(
          eq(schema.projectReplicaJobs.ownerId, ownerId),
          eq(schema.projectReplicaJobs.projectId, projectId),
          eq(schema.projectReplicaJobs.projectReplicaId, row.projectReplicaId),
          eq(schema.projectReplicaJobs.workerId, row.workerId),
          eq(schema.projectReplicaJobs.kind, "provision"),
          eq(schema.projectReplicaJobs.state, "succeeded"),
        ),
      )
      .orderBy(desc(schema.projectReplicaJobs.completedAt))
      .limit(1);
    return {
      nameWithOwner: provision[0]?.repository ?? row.nameWithOwner,
      url: row.url,
      workerId: row.workerId,
    };
  }

  async hasGithubProject(ownerId: string, repositoryBlindIndex: string) {
    const [projects, conversions] = await Promise.all([
      this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.ownerId, ownerId),
            eq(
              schema.projects.githubRepositoryBlindIndex,
              repositoryBlindIndex,
            ),
          ),
        )
        .limit(1),
      this.database
        .select({ id: schema.projectGithubConversionJobs.id })
        .from(schema.projectGithubConversionJobs)
        .where(
          and(
            eq(schema.projectGithubConversionJobs.ownerId, ownerId),
            eq(
              schema.projectGithubConversionJobs.repositoryBlindIndex,
              repositoryBlindIndex,
            ),
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
        .select({
          repositoryId: schema.projects.githubRepositoryBlindIndex,
        })
        .from(schema.projects)
        .where(eq(schema.projects.ownerId, ownerId)),
      this.database
        .select({
          repositoryId: schema.projectGithubConversionJobs.repositoryBlindIndex,
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
    input: EncryptedGithubProjectCreate,
  ): Promise<ProjectWireSummary> {
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
          id: input.id,
          ownerId,
          protectedLabel: input.nameProtection,
          position: (lastProjects[0]?.position ?? -1) + 1,
          originKind: "github",
          setupStatus: "cloning",
          setupError: null,
          preferredWorkerId: input.workerId,
          githubRepositoryBlindIndex: input.repositoryBlindIndex,
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
    return toProjectWireSummary(project);
  }

  async createManagedFolderProject(
    ownerId: string,
    input: EncryptedManagedFolderProjectCreate,
  ): Promise<{
    job: ProjectFolderSetupJobSummary;
    project: ProjectWireSummary;
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
    const projectId = input.id;
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
          protectedLabel: input.nameProtection,
          position: (lastProjects[0]?.position ?? -1) + 1,
          originKind: "managed-folder",
          folderManagement: input.existingPath ? "external" : "managed",
          setupStatus: "preparing",
          setupError: null,
          worktreePolicy: "direct",
          preferredWorkerId: input.workerId,
          githubRepositoryBlindIndex: null,
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
    return { job, project: toProjectWireSummary(project) };
  }

  async completeGithubProjectSetup(
    ownerId: string,
    projectId: string,
    workerId: string,
    clone: ProjectCloneResult,
  ): Promise<ProjectWireSummary | null> {
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
      ? toProjectWireSummary(
          completed,
          (await this.listProjectReplicas(ownerId, projectId)) ?? [],
        )
      : null;
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
      remoteSurfaces: remoteSurfaces.map(({ surface }) => ({
        id: surface.id,
        workerId: surface.workerId,
      })),
      setupStatus: project.setupStatus as ProjectWireSummary["setupStatus"],
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

  async listChats(
    ownerId: string,
    projectId: string,
  ): Promise<ChatWireSummary[]> {
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
    return rows.map(({ chat }) => toChatWireSummary(chat));
  }

  async listArchivedChats(
    ownerId: string,
    projectId: string,
  ): Promise<ArchivedChatWireSummary[]> {
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
      toArchivedChatWireSummary(chat, messageCount),
    );
  }

  async listStandaloneChats(
    ownerId: string,
  ): Promise<StandaloneChatWireSummary[]> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .orderBy(asc(schema.chats.position), asc(schema.chats.createdAt));
    return rows.map(({ chat }) => toStandaloneChatWireSummary(chat));
  }

  async listArchivedStandaloneChats(
    ownerId: string,
  ): Promise<ArchivedStandaloneChatWireSummary[]> {
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
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNotNull(schema.chats.archivedAt),
        ),
      )
      .orderBy(desc(schema.chats.archivedAt));
    return rows.map(({ chat, messageCount }) =>
      toArchivedStandaloneChatWireSummary(chat, messageCount),
    );
  }

  async createStandaloneChat(
    ownerId: string,
    input: EncryptedStandaloneChatCreate,
    isWorkerConnected: (workerId: string) => boolean,
  ): Promise<{
    chat: StandaloneChatWireSummary;
    provisionJob: StandaloneChatRootJobSummary;
  }> {
    const settings = firstOrThrow(
      await this.database
        .select()
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, ownerId))
        .limit(1),
      "loading standalone Chat defaults",
    );
    const workers = await this.listWorkers(ownerId);
    const compatible = workers
      .filter(
        (worker) =>
          isWorkerConnected(worker.workerId) &&
          worker.standaloneChat.scratch.provision &&
          worker.standaloneChat.scratch.resolve &&
          worker.standaloneChat.scratch.archive &&
          worker.standaloneChat.scratch.restore &&
          worker.standaloneChat.scratch.remove &&
          worker.standaloneChat.scratch.reconcile &&
          worker.standaloneChat.scratch.routingHandles,
      )
      .sort((left, right) => left.workerId.localeCompare(right.workerId));
    const worker =
      compatible.find(
        (candidate) => candidate.workerId === settings.defaultWorkerId,
      ) ?? compatible[0];
    if (!worker) {
      throw new StandaloneChatPlacementUnavailableError(
        "New Chat requires a compatible online worker with standalone scratch support.",
      );
    }
    const inheritedModelId =
      settings.defaultChatModelId ?? settings.defaultModelId;
    const inheritedReasoningEffort =
      settings.defaultChatReasoningEffort ?? settings.defaultReasoningEffort;
    const last = await this.database
      .select({ position: schema.chats.position })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
        ),
      )
      .orderBy(desc(schema.chats.position))
      .limit(1);
    const rootId = randomUUID();
    const runtimeSessionId = randomUUID();
    const provisionJobId = randomUUID();
    return this.database.transaction(async (transaction) => {
      const chat = firstOrThrow(
        await transaction
          .insert(schema.chats)
          .values({
            id: input.id,
            ownerId,
            contextKind: "standalone",
            projectId: null,
            protectedLabel: input.titleProtection,
            experience: "agent",
            position: (last[0]?.position ?? -1) + 1,
            activeWorkerId: worker.workerId,
            activeWorktreeId: null,
            activeScratchRootId: rootId,
            worktreeMode: null,
            modelId: inheritedModelId,
            reasoningEffort: inheritedReasoningEffort,
            customSubagentModel: false,
            subagentModelId: null,
            subagentReasoningEffort: null,
            permissionProfileId: settings.defaultChatPermissionProfileId,
            automationPaused: false,
            planMode: "default",
            protectedPlan: null,
            hasPendingPlanQuestion: false,
          })
          .returning(),
        "creating a standalone Chat",
      );
      await transaction.insert(schema.standaloneChatRoots).values({
        id: rootId,
        chatId: chat.id,
        ownerId,
        workerId: worker.workerId,
        protectedPathHandle: null,
        status: "provisioning",
      });
      await transaction.insert(schema.chatRuntimeSessions).values({
        id: runtimeSessionId,
        chatId: chat.id,
        workerId: worker.workerId,
        worktreeId: null,
        scratchRootId: rootId,
      });
      await transaction.insert(schema.chatExecutionLanes).values({
        id: randomUUID(),
        chatId: chat.id,
        worktreeId: null,
        scratchRootId: rootId,
        workerId: worker.workerId,
        acquiringActor: "user",
        exclusive: false,
        purpose: "Initial standalone Chat scratch root",
        state: "suspended",
        runtimeSessionId,
      });
      const provisionJob = firstOrThrow(
        await transaction
          .insert(schema.standaloneChatRootJobs)
          .values({
            id: provisionJobId,
            ownerId,
            rootId,
            chatId: chat.id,
            workerId: worker.workerId,
            kind: "provision",
            state: "queued",
          })
          .returning(),
        "queueing standalone Chat scratch provisioning",
      );
      return {
        chat: toStandaloneChatWireSummary(chat),
        provisionJob: {
          id: provisionJob.id,
          rootId: provisionJob.rootId,
          chatId: provisionJob.chatId,
          workerId: provisionJob.workerId,
          kind: provisionJob.kind,
          state: provisionJob.state,
          stateRevision: provisionJob.stateRevision,
          attempt: provisionJob.attempt,
          error: null,
          createdAt: toISOString(provisionJob.createdAt),
          updatedAt: toISOString(provisionJob.updatedAt),
          startedAt: null,
          completedAt: null,
        },
      };
    });
  }

  async createChat(
    ownerId: string,
    projectId: string,
    input: EncryptedChatCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ChatWireSummary | null> {
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
    input: EncryptedTaskCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<TaskWireCreateResult | null> {
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
    input: EncryptedChatCreate | EncryptedTaskCreate,
    experience: ChatExperience,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<{ chat: ChatWireSummary; task: TaskOpaqueSummary | null } | null> {
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
    const defaultSettings = firstOrThrow(
      await this.database
        .select({
          modelId: schema.userSettings.defaultModelId,
          reasoningEffort: schema.userSettings.defaultReasoningEffort,
          customSubagentModel: schema.userSettings.defaultCustomSubagentModel,
          subagentModelId: schema.userSettings.defaultSubagentModelId,
          subagentReasoningEffort:
            schema.userSettings.defaultSubagentReasoningEffort,
        })
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, ownerId))
        .limit(1),
      "loading default chat model configuration",
    );

    const position = await this.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const chatId =
        experience === "task"
          ? (input as EncryptedTaskCreate).chatId
          : (input as EncryptedChatCreate).id;
      const result = await transaction
        .insert(schema.chats)
        .values({
          id: chatId,
          ownerId,
          contextKind: "project",
          projectId,
          protectedLabel: input.titleProtection,
          experience,
          position,
          activeWorkerId: workerId,
          activeWorktreeId: worktreeId,
          worktreeMode: input.worktreeMode,
          modelId: defaultSettings.modelId,
          reasoningEffort: defaultSettings.reasoningEffort,
          customSubagentModel: defaultSettings.customSubagentModel,
          subagentModelId: defaultSettings.subagentModelId,
          subagentReasoningEffort: defaultSettings.subagentReasoningEffort,
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
      if (experience !== "task") {
        await attachProjectTab(transaction, {
          projectId,
          tabGroupId: input.tabGroupId,
          tabId: chat.id,
          tabKind: "chat",
        });
      }
      const task =
        experience === "task"
          ? firstOrThrow(
              await transaction
                .insert(schema.tasks)
                .values({
                  chatId: chat.id,
                  planGoalEnabled: (input as EncryptedTaskCreate)
                    .planGoalEnabled,
                  priority: (input as EncryptedTaskCreate).priority,
                  requestedTaskWorkerId: (input as EncryptedTaskCreate)
                    .requestedTaskWorkerId,
                  ...taskOpaqueColumns((input as EncryptedTaskCreate).task),
                })
                .returning(),
              "creating a Task record",
            )
          : null;
      return {
        chat: toChatWireSummary(chat),
        task: task ? toTaskOpaqueSummary(task) : null,
      };
    });
  }

  async listTerminals(
    ownerId: string,
    projectId: string,
  ): Promise<TerminalWireSummary[]> {
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
    return rows.map(({ terminal }) => toTerminalWireSummary(terminal));
  }

  async createTerminal(
    ownerId: string,
    projectId: string,
    input: EncryptedTerminalCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<TerminalWireSummary | null> {
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
          id: input.id,
          projectId,
          protectedLabel: input.titleProtection,
          protectedState: input.stateProtection,
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
      return toTerminalWireSummary(terminal);
    });
  }

  async getOrCreateChatConsole(
    ownerId: string,
    chatId: string,
    input: Pick<
      EncryptedTerminalCreate,
      "id" | "titleProtection" | "stateProtection"
    >,
  ): Promise<TerminalWireSummary | null> {
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
    const projectId = requiredProjectChatProjectId(row.chat.projectId);
    const worktreeId = requiredProjectChatWorktreeId(row.chat.activeWorktreeId);

    const existing = await this.database
      .select()
      .from(schema.terminals)
      .where(eq(schema.terminals.linkedChatId, chatId))
      .limit(1);
    if (existing[0]) return toTerminalWireSummary(existing[0]);

    const result = await this.database
      .insert(schema.terminals)
      .values({
        id: input.id,
        projectId,
        protectedLabel: input.titleProtection,
        protectedState: input.stateProtection,
        position: row.chat.position,
        status: "running",
        activeWorkerId: row.worktree.workerId,
        worktreeId,
        linkedChatId: row.chat.id,
        kind: "chat-console",
      })
      .returning();
    return toTerminalWireSummary(
      firstOrThrow(result, "creating a chat console"),
    );
  }

  async updateTerminal(
    ownerId: string,
    terminalId: string,
    input: EncryptedTerminalUpdate,
  ): Promise<TerminalWireSummary | null> {
    const owned = await this.getTerminalExecutionContext(ownerId, terminalId);
    if (!owned) return null;
    if (owned.kind === "run-configuration") {
      throw new Error(
        "Run configuration terminal titles come from their shared definition.",
      );
    }
    const result = await this.database
      .update(schema.terminals)
      .set({ protectedLabel: input.titleProtection, updatedAt: new Date() })
      .where(eq(schema.terminals.id, terminalId))
      .returning();
    return result[0] ? toTerminalWireSummary(result[0]) : null;
  }

  async updateTerminalService(
    ownerId: string,
    terminalId: string,
    input: EncryptedTerminalServiceConfiguration,
  ): Promise<TerminalWireSummary | null> {
    const owned = await this.getTerminalExecutionContext(ownerId, terminalId);
    if (!owned) return null;
    if (owned.kind === "run-configuration") {
      throw new Error(
        "Run configuration terminals are controlled by their runtime.",
      );
    }
    if (owned.linkedChatId) {
      throw new Error("Linked Codex consoles cannot run terminal services.");
    }
    const result = await this.database
      .update(schema.terminals)
      .set({
        serviceEnabled: input.enabled,
        protectedState: input.stateProtection,
        updatedAt: new Date(),
      })
      .where(eq(schema.terminals.id, terminalId))
      .returning();
    return result[0] ? toTerminalWireSummary(result[0]) : null;
  }

  async listTerminalServicesForWorker(
    workerId: string,
    serverId: string,
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
    return rows.map(({ terminal, worktree }) => {
      if (!terminal.protectedState) {
        throw new Error("Terminal service protection is unavailable.");
      }
      return {
        terminalId: terminal.id,
        serverId,
        worktreePath: worktree.absolutePath,
        stateProtection: terminal.protectedState,
      };
    });
  }

  async updateTerminalWorktree(
    ownerId: string,
    terminalId: string,
    input: WorktreeSelection,
  ): Promise<TerminalWireSummary | null> {
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
    if (terminal.kind === "run-configuration") {
      throw new Error("Run configuration terminals cannot change worktrees.");
    }
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
    return updated[0] ? toTerminalWireSummary(updated[0]) : null;
  }

  async listExplorers(
    ownerId: string,
    projectId: string,
  ): Promise<ExplorerWireSummary[]> {
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
    return rows.map(({ explorer }) => toExplorerWireSummary(explorer));
  }

  async createExplorer(
    ownerId: string,
    projectId: string,
    input: EncryptedExplorerCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExplorerWireSummary | null> {
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
          id: input.id,
          projectId,
          protectedLabel: input.titleProtection,
          protectedState: input.stateProtection,
          position,
          activeWorkerId: workerId,
          worktreeId,
          fileMode: input.fileMode ?? "preview",
        })
        .returning();
      const explorer = firstOrThrow(result, "creating an explorer");
      if (input.attachToTabLayout !== false) {
        await attachProjectTab(transaction, {
          projectId,
          tabGroupId: input.tabGroupId,
          tabId: explorer.id,
          tabKind: "explorer",
        });
      }
      return toExplorerWireSummary(explorer);
    });
  }

  async updateExplorerWorktree(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerWorktreeUpdate,
  ): Promise<ExplorerWireSummary | null> {
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
        protectedState: input.stateProtection,
        fileMode: "preview",
        updatedAt: new Date(),
      })
      .where(eq(schema.explorers.id, explorerId))
      .returning();
    return updated[0] ? toExplorerWireSummary(updated[0]) : null;
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
    input: EncryptedExplorerUpdate,
  ): Promise<ExplorerWireSummary | null> {
    if (!(await this.getExplorerExecutionContext(ownerId, explorerId)))
      return null;
    const result = await this.database
      .update(schema.explorers)
      .set({ protectedLabel: input.titleProtection, updatedAt: new Date() })
      .where(eq(schema.explorers.id, explorerId))
      .returning();
    return result[0] ? toExplorerWireSummary(result[0]) : null;
  }

  async pinExplorer(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerPin,
  ): Promise<ExplorerWireSummary | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
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
        .limit(1)
        .for("update");
      const explorer = rows[0]?.explorer;
      if (!explorer) return null;

      const tabKey = projectTabKey("explorer", explorerId);
      const existingMembers = await transaction
        .select({ tabKey: schema.tabGroupMembers.tabKey })
        .from(schema.tabGroupMembers)
        .where(
          and(
            eq(schema.tabGroupMembers.projectId, explorer.projectId),
            eq(schema.tabGroupMembers.tabKey, tabKey),
          ),
        )
        .limit(1);
      if (existingMembers[0]) {
        // The operation is retry-safe, but it must never repurpose an
        // Explorer that is already a tab.
        return toExplorerWireSummary(explorer);
      }

      const updatedRows = await transaction
        .update(schema.explorers)
        .set({
          protectedLabel: input.titleProtection,
          protectedState: input.stateProtection,
          fileMode: input.fileMode,
          updatedAt: new Date(),
        })
        .where(eq(schema.explorers.id, explorerId))
        .returning();
      const updated = firstOrThrow(updatedRows, "pinning an explorer");
      await attachProjectTab(transaction, {
        projectId: explorer.projectId,
        tabGroupId: input.tabGroupId,
        tabId: explorerId,
        tabKind: "explorer",
      });

      return toExplorerWireSummary(updated);
    });
  }

  async updateExplorerViewState(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerViewStateUpdate,
  ): Promise<ExplorerWireSummary | null> {
    if (!(await this.getExplorerExecutionContext(ownerId, explorerId))) {
      return null;
    }
    const result = await this.database
      .update(schema.explorers)
      .set({
        protectedState: input.stateProtection,
        fileMode: input.fileMode,
        updatedAt: new Date(),
      })
      .where(eq(schema.explorers.id, explorerId))
      .returning();
    return result[0] ? toExplorerWireSummary(result[0]) : null;
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
  ): Promise<CodeTabWireSummary[]> {
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
    return rows.map(({ codeTab }) => toCodeTabWireSummary(codeTab));
  }

  async createCodeTab(
    ownerId: string,
    projectId: string,
    input: EncryptedCodeTabCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<CodeTabWireSummary | null> {
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
          id: input.id,
          projectId,
          protectedLabel: input.titleProtection,
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
      return toCodeTabWireSummary(codeTab);
    });
  }

  async getCodeTabExecutionContext(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeTabExecutionContext | null> {
    const rows = await this.database
      .select({
        codeTab: schema.codeTabs,
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
          codeTab: toCodeTabWireSummary(row.codeTab),
          cwd: row.worktree.absolutePath,
          workerId: row.codeTab.activeWorkerId,
          worktreeId: row.worktree.id,
          worktreeName: row.worktree.name,
        }
      : null;
  }

  async updateCodeTab(
    ownerId: string,
    codeTabId: string,
    input: EncryptedCodeTabUpdate,
  ): Promise<CodeTabWireSummary | null> {
    if (!(await this.getCodeTabExecutionContext(ownerId, codeTabId))) {
      return null;
    }
    const result = await this.database
      .update(schema.codeTabs)
      .set({
        ...(input.titleProtection
          ? { protectedLabel: input.titleProtection }
          : {}),
        ...(input.themeMode ? { themeMode: input.themeMode } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.codeTabs.id, codeTabId))
      .returning();
    return result[0] ? toCodeTabWireSummary(result[0]) : null;
  }

  async updateCodeTabWorktree(
    ownerId: string,
    codeTabId: string,
    input: WorktreeSelection,
  ): Promise<CodeTabWireSummary | null> {
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
      .where(
        and(
          eq(schema.codeTabs.id, codeTabId),
          eq(schema.codeTabs.activeWorkerId, context.workerId),
          eq(schema.codeTabs.worktreeId, context.worktreeId),
          eq(schema.codeTabs.profileId, context.codeTab.profileId),
          notInArray(schema.codeTabs.status, ["starting", "running"]),
        ),
      )
      .returning();
    return result[0] ? toCodeTabWireSummary(result[0]) : null;
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
    preferredSessionId: string = randomUUID(),
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
    const tabStatus: CodeTabWireSummary["status"] =
      runtime.status === "starting"
        ? "starting"
        : runtime.status === "running" || runtime.status === "idle"
          ? "running"
          : runtime.status === "offline"
            ? "offline"
            : runtime.status === "failed"
              ? "failed"
              : "stopped";
    try {
      return await this.database.transaction(async (transaction) => {
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
              eq(schema.codeSessions.worktreeId, context.worktreeId),
              eq(schema.codeSessions.profileId, context.codeTab.profileId),
              eq(
                schema.codeSessions.editorFingerprint,
                runtime.editorBuild.fingerprint,
              ),
            ),
          )
          .returning();
        const session = rows[0];
        if (!session) return null;
        const tabs = await transaction
          .update(schema.codeTabs)
          .set({
            status: tabStatus,
            lastError: runtime.lastError,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.codeTabs.id, codeTabId),
              eq(schema.codeTabs.activeWorkerId, context.workerId),
              eq(schema.codeTabs.worktreeId, context.worktreeId),
              eq(schema.codeTabs.profileId, context.codeTab.profileId),
            ),
          )
          .returning({ id: schema.codeTabs.id });
        if (!tabs[0]) throw new StaleCodeSessionRuntimeError();
        return toCodeSessionSummary(session);
      });
    } catch (error) {
      if (error instanceof StaleCodeSessionRuntimeError) return null;
      throw error;
    }
  }

  async listBrowsers(
    ownerId: string,
    projectId: string,
  ): Promise<BrowserWireSummary[]> {
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
      toBrowserWireSummary(browser, workerId),
    );
  }

  async createBrowser(
    ownerId: string,
    projectId: string,
    input: EncryptedBrowserCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<BrowserWireSummary | null> {
    const { placement } = await this.resolveProjectExecutionPlacement(
      ownerId,
      projectId,
      "browser",
      input.target,
      isWorkerConnected,
    );
    const position = await this.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const browserId = input.id;
      const result = await transaction
        .insert(schema.browsers)
        .values({
          id: browserId,
          projectId,
          protectedLabel: input.titleProtection,
          protectedState: input.stateProtection,
          stateRevision: 1,
          position,
        })
        .returning();
      const browser = firstOrThrow(result, "creating a browser");
      await transaction.insert(schema.remoteSurfaces).values({
        id: browserId,
        projectId,
        workerId: placement.workerId,
        kind: "browser",
        preferredTransport: "webrtc",
        configuration: {
          kind: "browser",
          profileId: null,
        },
      });
      await attachProjectTab(transaction, {
        projectId,
        tabGroupId: input.tabGroupId,
        tabId: browser.id,
        tabKind: "browser",
      });
      return toBrowserWireSummary(browser, placement.workerId);
    });
  }

  async updateBrowser(
    ownerId: string,
    browserId: string,
    input: EncryptedBrowserUpdate,
  ): Promise<BrowserWireSummary | null> {
    if (!(await this.browserIsOwnedBy(ownerId, browserId))) return null;
    const surface = await this.getRemoteSurfaceExecutionContext(
      ownerId,
      browserId,
    );
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .update(schema.browsers)
        .set({
          ...(input.titleProtection
            ? { protectedLabel: input.titleProtection }
            : {}),
          ...(input.stateProtection
            ? {
                protectedState: input.stateProtection,
                stateRevision: input.expectedStateRevision! + 1,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.browsers.id, browserId),
            ...(input.expectedStateRevision === undefined
              ? []
              : [
                  eq(
                    schema.browsers.stateRevision,
                    input.expectedStateRevision,
                  ),
                ]),
          ),
        )
        .returning();
      const browser = result[0];
      if (!browser) {
        if (input.expectedStateRevision === undefined) return null;
        throw new SurfacePrivateStateConflictError(
          "Browser private state changed before this update.",
        );
      }
      await transaction
        .update(schema.remoteSurfaces)
        .set({ updatedAt: new Date() })
        .where(eq(schema.remoteSurfaces.id, browserId));
      return toBrowserWireSummary(browser, surface?.workerId ?? null);
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
          preferredTransport: "webrtc",
          configuration: {
            kind: "browser" as const,
            profileId: null,
          },
        })),
      )
      .onConflictDoNothing();
  }

  async listRemoteSurfaces(
    ownerId: string,
    projectId: string,
  ): Promise<RemoteSurfaceWireSummary[]> {
    const rows = await this.database
      .select({
        surface: schema.remoteSurfaces,
        browserLabel: schema.browsers.protectedLabel,
        browserState: schema.browsers.protectedState,
        browserStateRevision: schema.browsers.stateRevision,
        viewLabel: schema.projectViews.protectedLabel,
      })
      .from(schema.remoteSurfaces)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.remoteSurfaces.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.browsers,
        eq(schema.browsers.id, schema.remoteSurfaces.id),
      )
      .leftJoin(
        schema.projectViews,
        eq(schema.projectViews.id, schema.remoteSurfaces.id),
      )
      .where(eq(schema.remoteSurfaces.projectId, projectId))
      .orderBy(
        asc(schema.remoteSurfaces.createdAt),
        asc(schema.remoteSurfaces.id),
      );
    return rows.map(
      ({
        surface,
        browserLabel,
        browserState,
        browserStateRevision,
        viewLabel,
      }) =>
        toRemoteSurfaceWireSummary(
          surface,
          surface.protectedLabel ?? browserLabel ?? viewLabel,
          browserState ?? surface.protectedState,
          browserStateRevision ?? surface.stateRevision,
        ),
    );
  }

  async createRemoteSurface(
    ownerId: string,
    projectId: string,
    input: EncryptedRemoteSurfaceCreate,
  ): Promise<RemoteSurfaceWireSummary | null> {
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
        id: input.id,
        projectId,
        workerId: input.workerId,
        kind: input.configuration.kind,
        protectedLabel: input.titleProtection,
        protectedState: input.stateProtection ?? null,
        stateRevision: input.stateProtection ? 1 : null,
        configuration: input.configuration,
      })
      .returning();
    return toRemoteSurfaceWireSummary(
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
        browserLabel: schema.browsers.protectedLabel,
        browserState: schema.browsers.protectedState,
        browserStateRevision: schema.browsers.stateRevision,
        viewLabel: schema.projectViews.protectedLabel,
      })
      .from(schema.remoteSurfaces)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.remoteSurfaces.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.browsers,
        eq(schema.browsers.id, schema.remoteSurfaces.id),
      )
      .leftJoin(
        schema.projectViews,
        eq(schema.projectViews.id, schema.remoteSurfaces.id),
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
          surface: toRemoteSurfaceWireSummary(
            surface,
            surface.protectedLabel ??
              rows[0]!.browserLabel ??
              rows[0]!.viewLabel,
            rows[0]!.browserState ?? surface.protectedState,
            rows[0]!.browserStateRevision ?? surface.stateRevision,
          ),
          workerId: surface.workerId,
        }
      : null;
  }

  async updateRemoteSurface(
    ownerId: string,
    surfaceId: string,
    input: EncryptedRemoteSurfaceUpdate,
  ): Promise<RemoteSurfaceWireSummary | null> {
    const context = await this.getRemoteSurfaceExecutionContext(
      ownerId,
      surfaceId,
    );
    if (
      !context ||
      (input.configuration &&
        input.configuration.kind !== context.surface.kind) ||
      (input.stateProtection &&
        input.stateProtection.classification.recordKind !==
          (context.surface.kind === "browser"
            ? "browser-state"
            : "remote-desktop-state")) ||
      (input.titleProtection &&
        context.surface.titleProtection.classification.recordKind !==
          "remote-surface")
    ) {
      return null;
    }
    const result = await this.database
      .update(schema.remoteSurfaces)
      .set({
        ...(input.titleProtection
          ? { protectedLabel: input.titleProtection }
          : {}),
        ...(input.configuration ? { configuration: input.configuration } : {}),
        ...(input.stateProtection
          ? {
              protectedState: input.stateProtection,
              stateRevision: input.expectedStateRevision! + 1,
            }
          : {}),
        ...(input.preferredTransport
          ? { preferredTransport: input.preferredTransport }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.remoteSurfaces.id, surfaceId),
          ...(input.expectedStateRevision === undefined
            ? []
            : [
                eq(
                  schema.remoteSurfaces.stateRevision,
                  input.expectedStateRevision,
                ),
              ]),
        ),
      )
      .returning();
    if (!result[0] && input.expectedStateRevision !== undefined) {
      throw new SurfacePrivateStateConflictError(
        "Remote Surface private state changed before this update.",
      );
    }
    return result[0]
      ? toRemoteSurfaceWireSummary(
          result[0],
          result[0].protectedLabel ?? context.surface.titleProtection,
        )
      : null;
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
  ): Promise<RemoteDesktopWireSummary[]> {
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
      toRemoteDesktopWireSummary(view, surface),
    );
  }

  async getRemoteDesktop(
    ownerId: string,
    desktopId: string,
  ): Promise<RemoteDesktopWireSummary | null> {
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
      ? toRemoteDesktopWireSummary(rows[0].view, rows[0].surface)
      : null;
  }

  async createRemoteDesktop(
    ownerId: string,
    projectId: string,
    desktopId: string,
    titleProtection: PrivateDisplayLabelOpaque,
    workerId: string,
    stateProtection: SurfacePrivateStateOpaque,
    tabGroupId?: string,
  ): Promise<RemoteDesktopWireSummary | null> {
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
        protectedLabel: titleProtection,
        kind: "remote-desktop",
        worktreeId: null,
        position,
      });
      await transaction.insert(schema.remoteSurfaces).values({
        id: desktopId,
        projectId,
        workerId,
        kind: "desktop",
        preferredTransport: "webrtc",
        configuration: { kind: "desktop" },
        protectedState: stateProtection,
        stateRevision: 1,
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
  ): Promise<ProjectViewWireSummary[]> {
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
    return rows.map(({ view }) => toProjectViewWireSummary(view));
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
    input: EncryptedProjectViewCreate,
  ): Promise<ProjectViewWireSummary | null> {
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
          id: input.id,
          projectId,
          protectedLabel: input.titleProtection,
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
      return toProjectViewWireSummary(view);
    });
  }

  async updateProjectView(
    ownerId: string,
    viewId: string,
    input: EncryptedProjectViewUpdate,
  ): Promise<ProjectViewWireSummary | null> {
    if (!(await this.projectViewIsOwnedBy(ownerId, viewId))) return null;
    const result = await this.database
      .update(schema.projectViews)
      .set({ protectedLabel: input.titleProtection, updatedAt: new Date() })
      .where(eq(schema.projectViews.id, viewId))
      .returning();
    return result[0] ? toProjectViewWireSummary(result[0]) : null;
  }

  async updateProjectViewWorktree(
    ownerId: string,
    viewId: string,
    input: WorktreeSelection,
  ): Promise<ProjectViewWireSummary | null> {
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
    return updated[0] ? toProjectViewWireSummary(updated[0]) : null;
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
        projectTabKey(view.kind as ProjectViewWireSummary["kind"], viewId),
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
    if (context.kind === "run-configuration") {
      const active = await this.database
        .select({ state: schema.runConfigurationRuntimes.state })
        .from(schema.runConfigurationRuntimes)
        .where(
          and(
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            eq(schema.runConfigurationRuntimes.terminalId, terminalId),
            sql`${schema.runConfigurationRuntimes.state} IN ('starting', 'running', 'restarting', 'stopping')`,
          ),
        )
        .limit(1);
      if (active[0]) {
        throw new Error(
          "Stop the active Run configuration before closing its terminal.",
        );
      }
    }
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(schema.runConfigurationRuntimes)
        .set({ terminalId: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            eq(schema.runConfigurationRuntimes.terminalId, terminalId),
          ),
        );
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
          kind: row.terminal.kind,
          rootKind: row.worktree.rootKind,
          workerId: row.terminal.activeWorkerId,
          worktreeId: row.worktree.id,
          worktreePath: row.worktree.absolutePath,
          linkedChatId: row.terminal.linkedChatId,
          runConfigurationId: row.terminal.runConfigurationId,
          runConfigurationRuntimeId: row.terminal.runConfigurationRuntimeId,
          serviceEnabled: row.terminal.serviceEnabled,
          stateProtection: row.terminal.protectedState,
          status: row.terminal.status as TerminalWireSummary["status"],
        }
      : null;
  }

  async setTerminalStatus(
    terminalId: string,
    status: TerminalWireSummary["status"],
  ): Promise<void> {
    await this.database
      .update(schema.terminals)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.terminals.id, terminalId));
  }

  async updateChat(
    ownerId: string,
    chatId: string,
    input: EncryptedChatUpdate,
  ): Promise<ContextualChatWireSummary | null> {
    const owned = await this.database
      .select({ id: schema.chats.id })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    if (!owned[0]) return null;
    const result = await this.database
      .update(schema.chats)
      .set({ protectedLabel: input.titleProtection, updatedAt: new Date() })
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .returning();
    return result[0] ? toContextualChatWireSummary(result[0]) : null;
  }

  async getChatComposerDraftWireState(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedChatComposerDraftWireState | null> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    const chat = rows[0]?.chat;
    return chat
      ? encryptedChatComposerDraftWireStateSchema.parse({
          chatId: chat.id,
          state: chat.protectedComposerDraft,
          updatedAt: chat.composerDraftUpdatedAt
            ? toISOString(chat.composerDraftUpdatedAt)
            : null,
        })
      : null;
  }

  async updateChatComposerDraft(
    ownerId: string,
    chatId: string,
    state: ChatComposerDraftOpaqueState | null,
  ): Promise<EncryptedChatComposerDraftWireState | null> {
    const parsed = state
      ? chatComposerDraftOpaqueStateSchema.parse(state)
      : null;
    const updatedAt = new Date();
    const rows = await this.database
      .update(schema.chats)
      .set({
        protectedComposerDraft: parsed,
        composerDraftUpdatedAt: updatedAt,
      })
      .where(
        and(
          eq(schema.chats.id, chatId),
          isNull(schema.chats.archivedAt),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .returning({ id: schema.chats.id });
    return rows[0]
      ? encryptedChatComposerDraftWireStateSchema.parse({
          chatId: rows[0].id,
          state: parsed,
          updatedAt: toISOString(updatedAt),
        })
      : null;
  }

  async setChatAutomationPaused(
    ownerId: string,
    chatId: string,
    paused: boolean,
  ): Promise<ContextualChatWireSummary | null> {
    const rows = await this.database
      .update(schema.chats)
      .set({ automationPaused: paused, updatedAt: new Date() })
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .returning();
    return rows[0] ? toContextualChatWireSummary(rows[0]) : null;
  }

  async updateChatWorktree(
    ownerId: string,
    chatId: string,
    input: ChatWorktreeUpdate,
  ): Promise<ChatWireSummary | null> {
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
    const projectId = requiredProjectChatProjectId(chat.projectId);
    const target = await this.getProjectWorktreeContext(
      ownerId,
      projectId,
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
      chatIsExecuting(chat.status as ChatWireSummary["status"])
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
      return updated[0] ? toChatWireSummary(updated[0]) : null;
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
    const projectId = requiredProjectChatProjectId(chat.projectId);
    if (chatIsExecuting(chat.status as ChatWireSummary["status"]))
      return "running";
    return this.database.transaction(async (transaction) => {
      const messages = await transaction
        .select({ id: schema.chatMessages.id })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.chatId, chatId))
        .limit(1);
      await detachProjectTab(
        transaction,
        projectId,
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

  async archiveStandaloneChat(
    ownerId: string,
    chatId: string,
  ): Promise<
    | false
    | "running"
    | {
        archivedAt: string;
        archiveExpiresAt: string;
        chat: ArchivedStandaloneChatWireSummary;
        rootId: string;
        workerId: string;
      }
  > {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ chat: schema.chats, root: schema.standaloneChatRoots })
        .from(schema.chats)
        .innerJoin(
          schema.standaloneChatRoots,
          and(
            eq(schema.standaloneChatRoots.id, schema.chats.activeScratchRootId),
            eq(schema.standaloneChatRoots.chatId, schema.chats.id),
          ),
        )
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "standalone"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return false;
      if (chatIsExecuting(row.chat.status as ChatWireSummary["status"])) {
        return "running";
      }
      const archivedAt = new Date();
      const archiveExpiresAt = new Date(
        archivedAt.getTime() + ARCHIVED_CHAT_RETENTION_MS,
      );
      const chat = firstOrThrow(
        await transaction
          .update(schema.chats)
          .set({ archivedAt, status: "idle", updatedAt: archivedAt })
          .where(eq(schema.chats.id, chatId))
          .returning(),
        "archiving a standalone Chat",
      );
      await transaction
        .update(schema.standaloneChatRoots)
        .set({ archivedAt, archiveExpiresAt, updatedAt: archivedAt })
        .where(eq(schema.standaloneChatRoots.id, row.root.id));
      const messageCount = Number(
        (
          await transaction
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.chatId, chatId))
        )[0]?.count ?? 0,
      );
      return {
        archivedAt: toISOString(archivedAt),
        archiveExpiresAt: toISOString(archiveExpiresAt),
        chat: toArchivedStandaloneChatWireSummary(chat, messageCount),
        rootId: row.root.id,
        workerId: row.root.workerId,
      };
    });
  }

  async restoreStandaloneChat(
    ownerId: string,
    chatId: string,
  ): Promise<null | {
    chat: StandaloneChatWireSummary;
    rootId: string;
    workerId: string;
  }> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ chat: schema.chats, root: schema.standaloneChatRoots })
        .from(schema.chats)
        .innerJoin(
          schema.standaloneChatRoots,
          eq(schema.standaloneChatRoots.id, schema.chats.activeScratchRootId),
        )
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "standalone"),
            isNotNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const restored = firstOrThrow(
        await transaction
          .update(schema.chats)
          .set({ archivedAt: null, updatedAt: new Date() })
          .where(eq(schema.chats.id, chatId))
          .returning(),
        "restoring a standalone Chat",
      );
      await transaction
        .update(schema.standaloneChatRoots)
        .set({
          archivedAt: null,
          archiveExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.standaloneChatRoots.id, row.root.id));
      return {
        chat: toStandaloneChatWireSummary(restored),
        rootId: row.root.id,
        workerId: row.root.workerId,
      };
    });
  }

  async getStandaloneChatRootForDeletion(
    ownerId: string,
    chatId: string,
  ): Promise<{
    chatId: string;
    ownerId: string;
    rootId: string;
    workerId: string;
  } | null> {
    const rows = await this.database
      .select({
        chatId: schema.standaloneChatRoots.chatId,
        ownerId: schema.standaloneChatRoots.ownerId,
        rootId: schema.standaloneChatRoots.id,
        workerId: schema.standaloneChatRoots.workerId,
      })
      .from(schema.standaloneChatRoots)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.standaloneChatRoots.chatId),
      )
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNotNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async restoreArchivedChat(
    ownerId: string,
    chatId: string,
  ): Promise<ChatWireSummary | null> {
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
    const projectId = requiredProjectChatProjectId(chat.projectId);
    const position = await this.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const restored = await transaction
        .update(schema.chats)
        .set({ archivedAt: null, position, updatedAt: new Date() })
        .where(eq(schema.chats.id, chatId))
        .returning();
      if (chat.experience !== "task") {
        await attachProjectTab(transaction, {
          projectId,
          tabId: chatId,
          tabKind: "chat",
        });
      }
      return toChatWireSummary(firstOrThrow(restored, "restoring a chat"));
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
    input: EncryptedChatFork,
    protectMessages: (
      messages: ChatMessageOpaqueSummary[],
    ) => Promise<ChatMessageOpaqueContent[]>,
  ): Promise<ChatWireSummary | null> {
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
      const projectId = requiredProjectChatProjectId(row.chat.projectId);
      const activeWorktreeId = requiredProjectChatWorktreeId(
        row.chat.activeWorktreeId,
      );

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
            eq(schema.projectSources.projectId, projectId),
          ),
        )
        .where(
          and(
            eq(
              schema.projectWorktrees.id,
              input.worktreeId ?? activeWorktreeId,
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
      if (
        sourceMessages.some(
          (source) =>
            !source.protectedContent ||
            source.content !== null ||
            source.taskProtectedContent !== null,
        )
      ) {
        return null;
      }
      const protectedCopies = await protectMessages(
        sourceMessages.map(toEncryptedChatMessage),
      );
      if (
        protectedCopies.length !== sourceMessages.length ||
        protectedCopies.some((copy, index) => {
          const source = sourceMessages[index]!;
          return (
            copy.classification.role !== source.role ||
            copy.classification.mode !== source.mode ||
            JSON.stringify(copy.classification.attachmentIds) !==
              JSON.stringify(source.attachmentIds)
          );
        })
      ) {
        throw new Error(
          "The worker returned inconsistent encrypted fork messages.",
        );
      }
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
          .where(eq(schema.chats.projectId, projectId))
          .orderBy(desc(schema.chats.position))
          .limit(1),
        transaction
          .select({ position: schema.terminals.position })
          .from(schema.terminals)
          .where(eq(schema.terminals.projectId, projectId))
          .orderBy(desc(schema.terminals.position))
          .limit(1),
        transaction
          .select({ position: schema.explorers.position })
          .from(schema.explorers)
          .where(eq(schema.explorers.projectId, projectId))
          .orderBy(desc(schema.explorers.position))
          .limit(1),
        transaction
          .select({ position: schema.codeTabs.position })
          .from(schema.codeTabs)
          .where(eq(schema.codeTabs.projectId, projectId))
          .orderBy(desc(schema.codeTabs.position))
          .limit(1),
        transaction
          .select({ position: schema.browsers.position })
          .from(schema.browsers)
          .where(eq(schema.browsers.projectId, projectId))
          .orderBy(desc(schema.browsers.position))
          .limit(1),
        transaction
          .select({ position: schema.projectViews.position })
          .from(schema.projectViews)
          .where(eq(schema.projectViews.projectId, projectId))
          .orderBy(desc(schema.projectViews.position))
          .limit(1),
      ]);
      const chatResult = await transaction
        .insert(schema.chats)
        .values({
          id: input.id,
          ownerId,
          contextKind: "project",
          projectId,
          protectedLabel: input.titleProtection,
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
          customSubagentModel: row.chat.customSubagentModel,
          subagentModelId: row.chat.subagentModelId,
          subagentReasoningEffort: row.chat.subagentReasoningEffort,
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
        projectId,
        tabId: fork.id,
        tabKind: "chat",
      });
      if (sourceMessages.length > 0) {
        await transaction.insert(schema.chatMessages).values(
          sourceMessages.map((source, index) => {
            const message = protectedCopies[index]!;
            return {
              id: message.id,
              chatId: fork.id,
              worktreeId: target.id,
              executionLaneId: null,
              role: message.classification.role,
              mode: message.classification.mode,
              content: null,
              protectedContent: message.protectedContent,
              attachmentIds: message.classification.attachmentIds,
              modelId: source.modelId,
              modelRouteId: source.modelRouteId,
              providerId: source.providerId,
              providerName: source.providerName,
              providerModelName: source.providerModelName,
              reasoningEffort: message.reasoningEffort,
              appliedReasoningEffort: source.appliedReasoningEffort,
              reasoningAdjusted: source.reasoningAdjusted,
              idempotencyKey: message.idempotencyKey,
              createdAt: source.createdAt,
            };
          }),
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
      return toChatWireSummary(fork);
    });
  }

  async forkStandaloneChat(
    ownerId: string,
    chatId: string,
    input: EncryptedChatFork,
    isWorkerConnected: (workerId: string) => boolean,
    protectMessages: (
      messages: ChatMessageOpaqueSummary[],
    ) => Promise<ChatMessageOpaqueContent[]>,
  ): Promise<null | {
    chat: StandaloneChatWireSummary;
    provisionJob: StandaloneChatRootJobSummary;
  }> {
    if (input.worktreeId || input.worktreeMode) {
      throw new ExecutionLaneConflictError(
        "Standalone Chat forks do not accept worktree settings.",
      );
    }
    const sources = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    if (!sources[0]) return null;
    let throughSequence: number | null = null;
    if (input.messageId) {
      const selected = await this.database
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
    const sourceMessages = await this.database
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
    if (
      sourceMessages.some(
        (source) =>
          !source.protectedContent ||
          source.content !== null ||
          source.taskProtectedContent !== null,
      )
    ) {
      return null;
    }
    const protectedCopies = await protectMessages(
      sourceMessages.map(toEncryptedChatMessage),
    );
    if (protectedCopies.length !== sourceMessages.length) {
      throw new Error("The worker returned an incomplete encrypted fork.");
    }
    const created = await this.createStandaloneChat(
      ownerId,
      { id: input.id, titleProtection: input.titleProtection },
      isWorkerConnected,
    );
    try {
      const forkRows = await this.database
        .update(schema.chats)
        .set({
          modelId: sources[0].chat.modelId,
          reasoningEffort: sources[0].chat.reasoningEffort,
          permissionProfileId: sources[0].chat.permissionProfileId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.chats.id, created.chat.id),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .returning();
      const fork = firstOrThrow(forkRows, "copying standalone Chat settings");
      if (sourceMessages.length > 0) {
        await this.database.insert(schema.chatMessages).values(
          sourceMessages.map((source, index) => {
            const message = protectedCopies[index]!;
            if (
              message.classification.role !== source.role ||
              message.classification.mode !== source.mode ||
              JSON.stringify(message.classification.attachmentIds) !==
                JSON.stringify(source.attachmentIds)
            ) {
              throw new Error(
                "The worker returned inconsistent encrypted fork messages.",
              );
            }
            return {
              id: message.id,
              chatId: created.chat.id,
              worktreeId: null,
              scratchRootId: created.chat.activeScratchRootId,
              executionLaneId: null,
              role: message.classification.role,
              mode: message.classification.mode,
              content: null,
              protectedContent: message.protectedContent,
              attachmentIds: message.classification.attachmentIds,
              modelId: source.modelId,
              modelRouteId: source.modelRouteId,
              providerId: source.providerId,
              providerName: source.providerName,
              providerModelName: source.providerModelName,
              reasoningEffort: message.reasoningEffort,
              appliedReasoningEffort: source.appliedReasoningEffort,
              reasoningAdjusted: source.reasoningAdjusted,
              idempotencyKey: message.idempotencyKey,
              createdAt: source.createdAt,
            };
          }),
        );
      }
      return { ...created, chat: toStandaloneChatWireSummary(fork) };
    } catch (error) {
      await this.database
        .delete(schema.chats)
        .where(
          and(
            eq(schema.chats.id, created.chat.id),
            eq(schema.chats.ownerId, ownerId),
          ),
        );
      throw error;
    }
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
  ): Promise<ContextualChatWireSummary | null> {
    const model = await this.getModelRuntime(ownerId, input.modelId);
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
    const current = await this.getChatPlanWireState(ownerId, chatId);
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
    return this.getChatPlanWireState(ownerId, chatId);
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

  async getChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionContext | null> {
    const identities = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (identities[0]?.contextKind === "standalone") {
      return this.getStandaloneChatExecutionContext(ownerId, chatId);
    }
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
    const projectId = requiredProjectChatProjectId(row.chat.projectId);
    return {
      contextKind: "project",
      automationPaused: row.chat.automationPaused,
      chatId: row.chat.id,
      cwd: row.worktree.absolutePath,
      experience: row.chat.experience as ChatWireSummary["experience"],
      defaultPermissionProfileId:
        (row.settings?.defaultPermissionProfileId as
          UserSettings["defaultPermissionProfileId"] | undefined) ??
        DEFAULT_PERMISSION_PROFILE_ID,
      executionLaneId: row.lane?.id ?? null,
      isPrimary: row.worktree.isPrimary,
      modelId: row.chat.modelId,
      reasoningEffort: row.chat.reasoningEffort,
      modelConfiguration: chatModelConfiguration(row.chat),
      modelRouteId: row.runtime?.modelRouteId ?? null,
      providerAccountId: row.runtime?.providerAccountId ?? null,
      permissionProfileId: row.chat.permissionProfileId,
      planMode: row.chat.planMode as PlanMode,
      projectId,
      rootKind: row.worktree.rootKind,
      scratchRootId: null,
      status: row.chat.status as ChatWireSummary["status"],
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.worktree.workerId,
      worktreeId: row.worktree.id,
      worktreeMode: row.chat.worktreeMode as ChatWireSummary["worktreeMode"],
      worktreePolicy: row.project.worktreePolicy as WorktreePolicy,
    };
  }

  private async getStandaloneChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<StandaloneChatExecutionContext | null> {
    const rows = await this.database
      .select({
        chat: schema.chats,
        lane: schema.chatExecutionLanes,
        root: schema.standaloneChatRoots,
        runtime: schema.chatRuntimeSessions,
        settings: schema.userSettings,
      })
      .from(schema.chats)
      .innerJoin(
        schema.standaloneChatRoots,
        and(
          eq(schema.standaloneChatRoots.id, schema.chats.activeScratchRootId),
          eq(schema.standaloneChatRoots.chatId, schema.chats.id),
          eq(schema.standaloneChatRoots.ownerId, schema.chats.ownerId),
          eq(schema.standaloneChatRoots.workerId, schema.chats.activeWorkerId),
        ),
      )
      .leftJoin(
        schema.chatRuntimeSessions,
        and(
          eq(schema.chatRuntimeSessions.chatId, schema.chats.id),
          eq(
            schema.chatRuntimeSessions.workerId,
            schema.standaloneChatRoots.workerId,
          ),
          eq(
            schema.chatRuntimeSessions.scratchRootId,
            schema.standaloneChatRoots.id,
          ),
        ),
      )
      .leftJoin(
        schema.chatExecutionLanes,
        and(
          eq(schema.chatExecutionLanes.chatId, schema.chats.id),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .leftJoin(
        schema.userSettings,
        eq(schema.userSettings.userId, schema.chats.ownerId),
      )
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      contextKind: "standalone",
      automationPaused: row.chat.automationPaused,
      chatId,
      cwd: row.root.protectedPathHandle ?? "standalone-root-unavailable",
      experience: "agent",
      defaultPermissionProfileId:
        (row.settings?.defaultChatPermissionProfileId as
          UserSettings["defaultChatPermissionProfileId"] | undefined) ??
        DEFAULT_PERMISSION_PROFILE_ID,
      executionLaneId: row.lane?.id ?? null,
      isPrimary: true,
      status:
        row.root.status === "ready"
          ? (row.chat.status as ChatWireSummary["status"])
          : row.root.status === "failed"
            ? "failed"
            : "offline",
      modelId: row.chat.modelId,
      reasoningEffort: row.chat.reasoningEffort,
      modelConfiguration: chatModelConfiguration(row.chat),
      modelRouteId: row.runtime?.modelRouteId ?? null,
      providerAccountId: row.runtime?.providerAccountId ?? null,
      permissionProfileId: row.chat.permissionProfileId,
      planMode: "default",
      projectId: null,
      rootKind: null,
      scratchRootStatus: row.root.status as StandaloneChatRootStatus,
      scratchRootId: row.root.id,
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.root.workerId,
      worktreeId: null,
      worktreeMode: null,
      worktreePolicy: null,
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
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
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
    worktreeId: string | null,
    threadId: string | null,
    modelRouteId: string,
    status = "ready",
    providerAccountId?: string | null,
    scratchRootId: string | null = null,
  ): Promise<void> {
    if ((worktreeId === null) === (scratchRootId === null)) {
      throw new Error("Chat runtime requires exactly one execution root.");
    }
    const rows = await this.database
      .insert(schema.chatRuntimeSessions)
      .values({
        id: randomUUID(),
        chatId,
        workerId,
        worktreeId,
        scratchRootId,
        codexThreadId: threadId,
        modelRouteId,
        providerAccountId: providerAccountId ?? null,
        status,
      })
      .onConflictDoUpdate({
        target: worktreeId
          ? [
              schema.chatRuntimeSessions.chatId,
              schema.chatRuntimeSessions.workerId,
              schema.chatRuntimeSessions.worktreeId,
            ]
          : [
              schema.chatRuntimeSessions.chatId,
              schema.chatRuntimeSessions.workerId,
              schema.chatRuntimeSessions.scratchRootId,
            ],
        targetWhere: worktreeId
          ? isNotNull(schema.chatRuntimeSessions.worktreeId)
          : isNotNull(schema.chatRuntimeSessions.scratchRootId),
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
          worktreeId
            ? eq(schema.chatExecutionLanes.worktreeId, worktreeId)
            : eq(schema.chatExecutionLanes.scratchRootId, scratchRootId!),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      );
  }

  async setChatStatus(
    chatId: string,
    status: ChatWireSummary["status"],
  ): Promise<void> {
    await this.database
      .update(schema.chats)
      .set({
        status,
        ...(status === "idle" || status === "failed"
          ? {
              hasUnreadCompletion: sql<boolean>`case
                  when ${schema.chats.status} in ('running', 'waiting-for-approval')
                    then true
                  else ${schema.chats.hasUnreadCompletion}
                end`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId));
  }

  async acknowledgeChatCompletion(
    ownerId: string,
    chatId: string,
  ): Promise<ContextualChatWireSummary | null> {
    const rows = await this.database
      .update(schema.chats)
      .set({ hasUnreadCompletion: false })
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .returning();
    return rows[0] ? toContextualChatWireSummary(rows[0]) : null;
  }

  private async resolveAgentInteractionOwner(input: {
    projectId: string | null;
    provenance: { chatId: string | null; workerId: string };
  }): Promise<string> {
    if (input.provenance.chatId) {
      const rows = await this.database
        .select({ ownerId: schema.chats.ownerId })
        .from(schema.chats)
        .innerJoin(
          schema.workers,
          and(
            eq(schema.workers.id, input.provenance.workerId),
            eq(schema.workers.ownerId, schema.chats.ownerId),
          ),
        )
        .where(eq(schema.chats.id, input.provenance.chatId))
        .limit(1);
      if (rows[0]) return rows[0].ownerId;
    } else if (input.projectId) {
      const rows = await this.database
        .select({ ownerId: schema.projects.ownerId })
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
      if (rows[0]) return rows[0].ownerId;
    }
    throw new AgentInteractionConflictError(
      "Interaction worker does not belong to the owning Chat or project.",
    );
  }

  async recordAgentInteractionRequest(
    input: AgentInteractionRequestCreate,
  ): Promise<AgentInteractionRequest> {
    const ownerId = await this.resolveAgentInteractionOwner(input);
    if (input.provenance.chatId) {
      const chats = await this.database
        .select({ id: schema.chats.id, projectId: schema.chats.projectId })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.provenance.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!chats[0] || chats[0].projectId !== input.projectId) {
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
        ownerId,
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

  async recordEncryptedAgentInteractionRequest(
    input: EncryptedAgentInteractionRequestCreate,
  ): Promise<EncryptedAgentInteractionRequest> {
    const ownerId = await this.resolveAgentInteractionOwner(input);
    if (input.provenance.chatId) {
      const chats = await this.database
        .select({ id: schema.chats.id, projectId: schema.chats.projectId })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.provenance.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!chats[0] || chats[0].projectId !== input.projectId) {
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
        ownerId,
        projectId: input.projectId,
        chatId: input.provenance.chatId,
        workerId: input.provenance.workerId,
        executionLaneId: input.provenance.executionLaneId,
        threadId: input.provenance.threadId,
        turnId: input.provenance.turnId,
        itemId: input.provenance.itemId,
        workflowRunId: input.provenance.workflowRunId,
        workflowNodeId: input.provenance.workflowNodeId,
        kind: input.classification.kind,
        status: expiredAtCreation ? "expired" : "pending",
        protectedPayload: input.protectedPayload,
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
      request = firstOrThrow(
        existing,
        "reading a protected interaction request",
      );
    }
    const normalized = toEncryptedAgentInteractionRequest(request);
    if (
      !inserted &&
      (normalized.projectId !== input.projectId ||
        JSON.stringify(normalized.provenance) !==
          JSON.stringify(input.provenance) ||
        JSON.stringify(normalized.classification) !==
          JSON.stringify(input.classification) ||
        JSON.stringify(normalized.protectedPayload) !==
          JSON.stringify(input.protectedPayload) ||
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
  ): Promise<AgentInteractionRequestWire[]> {
    await this.expireAgentInteractionRequests();
    const conditions = [eq(schema.agentInteractionRequests.ownerId, ownerId)];
    if (query.chatId) {
      conditions.push(eq(schema.agentInteractionRequests.chatId, query.chatId));
    }
    if (query.workflowRunId) {
      conditions.push(
        eq(schema.agentInteractionRequests.workflowRunId, query.workflowRunId),
      );
    }
    if (query.status) {
      conditions.push(eq(schema.agentInteractionRequests.status, query.status));
    }
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .where(and(...conditions))
      .orderBy(desc(schema.agentInteractionRequests.createdAt))
      .limit(query.limit);
    return rows.map(({ request }) => toAgentInteractionRequestWire(request));
  }

  async getAgentInteractionRequest(
    ownerId: string,
    requestId: string,
  ): Promise<AgentInteractionRequestWire | null> {
    await this.expireAgentInteractionRequests();
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .where(
        and(
          eq(schema.agentInteractionRequests.id, requestId),
          eq(schema.agentInteractionRequests.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toAgentInteractionRequestWire(rows[0].request) : null;
  }

  async getAgentInteractionRequestByKey(
    ownerId: string,
    requestKey: string,
  ): Promise<AgentInteractionRequestWire | null> {
    await this.expireAgentInteractionRequests();
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .where(
        and(
          eq(schema.agentInteractionRequests.requestKey, requestKey),
          eq(schema.agentInteractionRequests.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toAgentInteractionRequestWire(rows[0].request) : null;
  }

  async resolveAgentInteractionRequest(
    ownerId: string,
    requestId: string,
    input: AgentInteractionResolutionCreate,
  ): Promise<AgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const existing = await this.getAgentInteractionRequest(ownerId, requestId);
    if (!existing) return null;
    if (!("payload" in existing)) {
      throw new AgentInteractionConflictError(
        "Protected interaction requests require a protected response.",
      );
    }
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
    if (!("payload" in existing)) {
      throw new AgentInteractionConflictError(
        "Protected interaction requests require a protected response.",
      );
    }
    validateAgentInteractionResponse(existing.payload, input.response);
    return existing;
  }

  async resolveEncryptedAgentInteractionRequest(
    ownerId: string,
    requestId: string,
    input: EncryptedAgentInteractionResolutionCreate,
  ): Promise<EncryptedAgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const existing = await this.getAgentInteractionRequest(ownerId, requestId);
    if (!existing) return null;
    if (!("protectedPayload" in existing)) {
      throw new AgentInteractionConflictError(
        "Visible interaction requests require a visible response.",
      );
    }
    if (existing.classification.kind !== input.classification.kind) {
      throw new AgentInteractionConflictError(
        "Response kind does not match the pending request.",
      );
    }
    if (existing.status !== "pending") {
      const rows = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.id, requestId))
        .limit(1);
      const row = firstOrThrow(
        rows,
        "reading a resolved protected interaction request",
      );
      if (row.resolutionIdempotencyKey === input.idempotencyKey) {
        return toEncryptedAgentInteractionRequest(row);
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
        protectedResponse: input.protectedResponse,
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
    return toEncryptedAgentInteractionRequest(rows[0]);
  }

  async validateEncryptedAgentInteractionResolution(
    ownerId: string,
    requestId: string,
    input: EncryptedAgentInteractionResolutionCreate,
  ): Promise<EncryptedAgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const existing = await this.getAgentInteractionRequest(ownerId, requestId);
    if (!existing) return null;
    if (!("protectedPayload" in existing)) {
      throw new AgentInteractionConflictError(
        "Visible interaction requests require a visible response.",
      );
    }
    if (existing.classification.kind !== input.classification.kind) {
      throw new AgentInteractionConflictError(
        "Response kind does not match the pending request.",
      );
    }
    return existing;
  }

  async expireAgentInteractionRequests(
    now = new Date(),
  ): Promise<AgentInteractionRequestWire[]> {
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
    return rows.map(toAgentInteractionRequestWire);
  }

  async interruptAgentInteractionRequests(
    chatId: string,
  ): Promise<AgentInteractionRequestWire[]> {
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
    return rows.map(toAgentInteractionRequestWire);
  }

  async terminalizeAgentInteractionRequestFromWorker(
    requestKey: string,
    chatId: string,
    workerId: string,
    status: "expired" | "interrupted",
  ): Promise<AgentInteractionRequestWire | null> {
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
    return toAgentInteractionRequestWire(rows[0]);
  }

  async createChatAttachment(
    ownerId: string,
    chatId: string,
    input: {
      id: string;
      protectedMetadata: AttachmentProtectedMetadata;
      sizeBytes: number;
      workerId: string;
    },
  ): Promise<ChatAttachmentRecord | null> {
    const owned = await this.database
      .select({ id: schema.chats.id })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          isNull(schema.chats.archivedAt),
        ),
      )
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
      .where(
        and(
          eq(schema.chatAttachments.id, attachmentId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
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
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          inArray(schema.chatAttachments.id, attachmentIds),
        ),
      );
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

  async getChatAttachmentReplicaWorkerIds(
    ownerId: string,
    attachmentId: string,
  ): Promise<string[]> {
    const rows = await this.database
      .select({ workerId: schema.chatAttachmentReplicas.workerId })
      .from(schema.chatAttachmentReplicas)
      .innerJoin(
        schema.chatAttachments,
        eq(
          schema.chatAttachments.id,
          schema.chatAttachmentReplicas.attachmentId,
        ),
      )
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatAttachments.chatId),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatAttachmentReplicas.attachmentId, attachmentId),
          eq(schema.chatAttachmentReplicas.status, "ready"),
        ),
      );
    return [...new Set(rows.map(({ workerId }) => workerId))];
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
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toChatMessage(message));
  }

  async listEncryptedMessages(
    ownerId: string,
    chatId: string,
  ): Promise<ChatMessageOpaqueSummary[]> {
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
          isNotNull(schema.chatMessages.protectedContent),
        ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toEncryptedChatMessage(message));
  }

  async getLatestEncryptedUserMessage(
    ownerId: string,
    chatId: string,
  ): Promise<ChatMessageOpaqueSummary | null> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.role, "user"),
          isNotNull(schema.chatMessages.protectedContent),
        ),
      )
      .orderBy(desc(schema.chatMessages.sequence))
      .limit(1);
    return rows[0] ? toEncryptedChatMessage(rows[0].message) : null;
  }

  async trimLatestEncryptedTurn(
    ownerId: string,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const chats = await transaction
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.experience, "agent"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!chats[0]) return false;
      const messages = await transaction
        .select({
          id: schema.chatMessages.id,
          sequence: schema.chatMessages.sequence,
        })
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            eq(schema.chatMessages.role, "user"),
            isNotNull(schema.chatMessages.protectedContent),
          ),
        )
        .orderBy(desc(schema.chatMessages.sequence))
        .limit(1);
      const latest = messages[0];
      if (!latest || latest.id !== messageId) return false;
      await transaction
        .delete(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            gte(schema.chatMessages.sequence, latest.sequence),
          ),
        );
      await transaction
        .update(schema.chats)
        .set({
          protectedPlan: null,
          hasPendingPlanQuestion: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.chats.id, chatId));
      return true;
    });
  }

  private async listOpaqueMessagePageRows(
    ownerId: string,
    chatId: string,
    experience: ChatExperience,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: (typeof schema.chatMessages.$inferSelect)[];
    page: ChatMessagePageInfo;
  }> {
    const protectedColumn =
      experience === "task"
        ? schema.chatMessages.taskProtectedContent
        : schema.chatMessages.protectedContent;
    const cursorCondition = query.beforeSequence
      ? lt(schema.chatMessages.sequence, query.beforeSequence)
      : undefined;
    const headers = await this.database
      .select({
        role: schema.chatMessages.role,
        sequence: schema.chatMessages.sequence,
      })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, experience),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          isNotNull(protectedColumn),
          cursorCondition,
        ),
      )
      .orderBy(desc(schema.chatMessages.sequence))
      .limit(CHAT_MESSAGE_PAGE_BOUNDARY_MAX + 1);

    if (headers.length === 0) {
      return {
        messages: [],
        page: {
          hasMore: false,
          nextBeforeSequence: null,
          oldestSequence: null,
          newestSequence: null,
          startsAtUserTurn: true,
        },
      };
    }

    const window = selectChatMessagePageWindow(headers, query.limit);
    const selectedHeaders = window.selected;
    const selectedSequences = selectedHeaders.map(({ sequence }) => sequence);
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, experience),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          isNotNull(protectedColumn),
          inArray(schema.chatMessages.sequence, selectedSequences),
        ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    const oldestSequence = selectedHeaders.at(-1)?.sequence ?? null;
    return {
      messages: rows.map(({ message }) => message),
      page: {
        hasMore: window.hasMore,
        nextBeforeSequence: window.hasMore ? oldestSequence : null,
        oldestSequence,
        newestSequence: selectedHeaders[0]?.sequence ?? null,
        startsAtUserTurn: window.startsAtUserTurn,
      },
    };
  }

  async listEncryptedMessagePage(
    ownerId: string,
    chatId: string,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: ChatMessageOpaqueSummary[];
    page: ChatMessagePageInfo;
  }> {
    const result = await this.listOpaqueMessagePageRows(
      ownerId,
      chatId,
      "agent",
      query,
    );
    return {
      messages: result.messages.map(toEncryptedChatMessage),
      page: result.page,
    };
  }

  async listAgentMessageWire(ownerId: string, chatId: string) {
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
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) =>
      message.protectedContent
        ? toEncryptedChatMessage(message)
        : toChatMessage(message),
    );
  }

  async listTaskMessages(
    ownerId: string,
    chatId: string,
  ): Promise<TaskMessageOpaqueSummary[]> {
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
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toTaskMessage(message));
  }

  async listTaskMessagePage(
    ownerId: string,
    chatId: string,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: TaskMessageOpaqueSummary[];
    page: ChatMessagePageInfo;
  }> {
    const result = await this.listOpaqueMessagePageRows(
      ownerId,
      chatId,
      "task",
      query,
    );
    return {
      messages: result.messages.map(toTaskMessage),
      page: result.page,
    };
  }

  async listMessageHeaders(ownerId: string, chatId: string) {
    const rows = await this.database
      .select({
        id: schema.chatMessages.id,
        executionLaneId: schema.chatMessages.executionLaneId,
        role: schema.chatMessages.role,
        createdAt: schema.chatMessages.createdAt,
      })
      .from(schema.chatMessages)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.chatMessages.chatId))
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map((row) => ({
      ...row,
      role: row.role as "assistant" | "system" | "user",
      createdAt: toISOString(row.createdAt),
    }));
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

  async listEncryptedQueuedPrompts(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedQueuedPrompt[]> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .orderBy(
        asc(schema.queuedPrompts.position),
        asc(schema.queuedPrompts.createdAt),
      );
    return rows.map(({ prompt }) => toEncryptedQueuedPrompt(prompt));
  }

  async getEncryptedQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<EncryptedQueuedPrompt | null> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toEncryptedQueuedPrompt(rows[0].prompt) : null;
  }

  async createEncryptedQueuedPrompt(
    ownerId: string,
    chatId: string,
    input: QueuedPromptOpaqueContent,
    attachments: ChatAttachmentOpaqueSummary[],
  ): Promise<EncryptedQueuedPrompt | null> {
    const prompt = queuedPromptOpaqueContentSchema.parse(input);
    const chat = await this.database
      .select({
        contextKind: schema.chats.contextKind,
        experience: schema.chats.experience,
      })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (!chat[0] || chat[0].experience !== "agent") return null;
    if (
      chat[0].contextKind === "standalone" &&
      (prompt.classification.mode !== "default" ||
        prompt.worktreeId !== null ||
        prompt.customSubagentModel ||
        prompt.subagentModelId !== null ||
        prompt.subagentReasoningEffort !== null)
    ) {
      throw new ExecutionLaneConflictError(
        "Standalone Chat queued prompts must use default mode without worktree or subagent settings.",
      );
    }
    const existing = await this.database
      .select()
      .from(schema.queuedPrompts)
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.queuedPrompts.idempotencyKey, prompt.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return toEncryptedQueuedPrompt(existing[0]);
    const last = await this.database
      .select({ position: schema.queuedPrompts.position })
      .from(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.chatId, chatId))
      .orderBy(desc(schema.queuedPrompts.position))
      .limit(1);
    const result = await this.database
      .insert(schema.queuedPrompts)
      .values({
        id: prompt.id,
        chatId,
        text: null,
        opaqueContent: prompt,
        mode: prompt.classification.mode,
        attachments,
        modelId: prompt.modelId,
        reasoningEffort: prompt.reasoningEffort,
        customSubagentModel: prompt.customSubagentModel,
        subagentModelId: prompt.subagentModelId,
        subagentReasoningEffort: prompt.subagentReasoningEffort,
        worktreeId: prompt.worktreeId,
        position: (last[0]?.position ?? -1) + 1,
        frozen: prompt.frozen,
        idempotencyKey: prompt.idempotencyKey,
      })
      .returning();
    return toEncryptedQueuedPrompt(firstOrThrow(result, "queueing a prompt"));
  }

  async replaceEncryptedQueuedPrompt(
    ownerId: string,
    promptId: string,
    input: QueuedPromptOpaqueContent,
    attachments: ChatAttachmentOpaqueSummary[],
  ): Promise<EncryptedQueuedPrompt | null> {
    const prompt = queuedPromptOpaqueContentSchema.parse(input);
    if (prompt.id !== promptId) return null;
    const contexts = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!contexts[0]) return null;
    if (
      contexts[0].contextKind === "standalone" &&
      (prompt.classification.mode !== "default" ||
        prompt.worktreeId !== null ||
        prompt.customSubagentModel ||
        prompt.subagentModelId !== null ||
        prompt.subagentReasoningEffort !== null)
    ) {
      throw new ExecutionLaneConflictError(
        "Standalone Chat queued prompts must use default mode without worktree or subagent settings.",
      );
    }
    const result = await this.database
      .update(schema.queuedPrompts)
      .set({
        opaqueContent: prompt,
        mode: prompt.classification.mode,
        attachments,
        reasoningEffort: prompt.reasoningEffort,
        customSubagentModel: prompt.customSubagentModel,
        subagentModelId: prompt.subagentModelId,
        subagentReasoningEffort: prompt.subagentReasoningEffort,
        worktreeId: prompt.worktreeId,
        frozen: prompt.frozen,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          exists(
            this.database
              .select({ id: schema.chats.id })
              .from(schema.chats)
              .where(
                and(
                  eq(schema.chats.id, schema.queuedPrompts.chatId),
                  eq(schema.chats.ownerId, ownerId),
                ),
              ),
          ),
        ),
      )
      .returning();
    return result[0] ? toEncryptedQueuedPrompt(result[0]) : null;
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
    attachments: ChatAttachmentOpaqueSummary[] = [],
  ): Promise<QueuedPrompt | null> {
    const chat = await this.database
      .select({
        experience: schema.chats.experience,
        id: schema.chats.id,
        projectId: schema.chats.projectId,
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
    if (!chat[0] || chat[0].experience !== "agent") return null;
    const projectId = requiredProjectChatProjectId(chat[0].projectId);
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
            eq(schema.projectSources.projectId, projectId),
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
    attachments?: ChatAttachmentOpaqueSummary[],
  ): Promise<QueuedPrompt | null> {
    const owned = await this.database
      .select({
        experience: schema.chats.experience,
        id: schema.queuedPrompts.id,
      })
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
    if (!owned[0] || owned[0].experience !== "agent") return null;
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
  ): Promise<QueuedPrompt | EncryptedQueuedPrompt | null> {
    const owned = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!owned[0]) return null;
    await this.database
      .delete(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.id, promptId));
    return owned[0].prompt.opaqueContent
      ? toEncryptedQueuedPrompt(owned[0].prompt)
      : toQueuedPrompt(owned[0].prompt);
  }

  async reorderQueuedPrompts(
    ownerId: string,
    chatId: string,
    input: QueuedPromptOrder,
  ): Promise<boolean> {
    const prompts = await this.database
      .select({ id: schema.queuedPrompts.id })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      );
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
    const existing = await this.getEncryptedMessageByIdempotencyKey(
      ownerId,
      chatId,
      message.idempotencyKey,
    );
    if (!existing) {
      return this.appendEncryptedMessage(ownerId, chatId, message, attribution);
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
    const existing = await this.getTaskMessageByIdempotencyKey(
      ownerId,
      chatId,
      message.idempotencyKey,
    );
    if (!existing) {
      return this.appendTaskMessage(ownerId, chatId, message, attribution);
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
