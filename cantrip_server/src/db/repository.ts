import { randomUUID } from "node:crypto";

import { DEFAULT_PERMISSION_PROFILE_ID } from "@cantrip/protocol";
import type {
  RunConfigurationRuntime,
  RunConfigurationRuntimeObservationApplyResult,
  RunConfigurationRuntimeOperationResult,
  RunConfigurationRuntimeWorkerIdentity,
  RunConfigurationRuntimeWorkerObservation,
} from "@cantrip/protocol/run-configuration-runtime";
import type {
  RunConfigurationProtectedSecret,
  RunConfigurationSecretSetResult,
  RunConfigurationSecretSummary,
} from "@cantrip/protocol/run-configuration-secrets";
import type {
  AppDestination,
  AppDestinationUpdate,
  AgentInteractionRequest,
  AgentInteractionRequestCreate,
  AgentInteractionRequestQuery,
  AgentInteractionResolutionCreate,
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
  type AttachmentProtectedMetadata,
  type ChatAttachmentOpaqueSummary,
} from "@cantrip/protocol/attachment-content";
import type {
  ProtectedProviderCredential,
  ProviderCredentialPublicMetadata,
} from "@cantrip/protocol/protected-secrets";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { CodeSettingsRepository } from "./code-settings.js";
import type { QuotaTokenAnalytics } from "../analytics/quota-token.js";
import type { SecretVault } from "../security/secret-vault.js";
import { AccountResourceUsageRepository } from "./account-resource-usage.js";
import * as schema from "./schema.js";
import { ChatImportJobRepository } from "./chat-import-jobs.js";
import { ChatRelocationJobRepository } from "./chat-relocation-jobs.js";
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
  toProjectWorktreeSummary,
  type ProjectWorkspaceRow,
  type ProjectWorktreeExecutionContext,
} from "./repository/projects.js";
import {
  ProjectLifecycleRepository,
  type GithubProjectExecutionContext,
  type ProjectRemovalContext,
} from "./repository/project-lifecycle.js";
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
  type ProjectWorktreeObservationContext,
  type ProjectWorktreeStatusRecord,
} from "./repository/worktree-state.js";
import {
  RunConfigurationStateRepository,
  type RunConfigurationRuntimeOperationRequest,
} from "./repository/run-configuration-state.js";
import {
  WorktreeLifecycleRepository,
  type WorktreeRemovalBlockers,
} from "./repository/worktree-lifecycle.js";
import {
  ChatExecutionLaneRepository,
  chatIsExecuting,
  type ChatExecutionContext,
  type ChatExecutionLaneContext,
  type ChatExecutionLaneReleaseResult,
  type ChatExecutionRecoveryContext,
  type ChatWorktreeTransitionResult,
  type ProjectChatExecutionContext,
  type StandaloneChatExecutionContext,
} from "./repository/chat-execution-lanes.js";
import {
  ChatCatalogRepository,
  StandaloneChatPlacementUnavailableError,
} from "./repository/chat-catalog.js";
import { ChatStateRepository } from "./repository/chat-state.js";
import { ChatArchiveLifecycleRepository } from "./repository/chat-archive-lifecycle.js";
import { ChatForkRepository } from "./repository/chat-forks.js";
import {
  ChatConfigurationRepository,
  type ChatLiveRouting,
} from "./repository/chat-configuration.js";
import { ChatRuntimeContextRepository } from "./repository/chat-runtime-context.js";
import { AgentInteractionRepository } from "./repository/agent-interactions.js";
import {
  ChatAttachmentRepository,
  type ChatAttachmentRecord,
} from "./repository/chat-attachments.js";
import { MessageQueryRepository } from "./repository/message-queries.js";
import { QueuedPromptRepository } from "./repository/queued-prompts.js";
import {
  MessageWriteRepository,
  type ChatExecutionAttribution,
} from "./repository/message-writes.js";
import {
  TerminalRepository,
  type TerminalExecutionContext,
} from "./repository/terminals.js";
import {
  ExplorerRepository,
  type ExplorerExecutionContext,
} from "./repository/explorers.js";
import {
  CodeCapabilityUnavailableError,
  CodeSurfaceRepository,
  type CodeTabExecutionContext,
} from "./repository/code-surfaces.js";
import { BrowserRepository } from "./repository/browsers.js";
import {
  RemoteSurfaceRepository,
  type RemoteSurfaceExecutionContext,
} from "./repository/remote-surfaces.js";
import { ProjectViewRepository } from "./repository/project-views.js";
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
import { ProjectTabLayoutRepository } from "./tab-layouts.js";

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
export type {
  GithubProjectExecutionContext,
  ProjectRemovalContext,
} from "./repository/project-lifecycle.js";
export {
  ExecutionPlacementUnavailableError,
  workerIsOnlineForPlacement,
} from "./repository/placement.js";
export type {
  ProjectWorktreeObservationContext,
  ProjectWorktreeStatusRecord,
} from "./repository/worktree-state.js";
export type { RunConfigurationRuntimeOperationRequest } from "./repository/run-configuration-state.js";
export type { WorktreeRemovalBlockers } from "./repository/worktree-lifecycle.js";
export {
  ExecutionLaneConflictError,
  type ChatExecutionContext,
  type ChatExecutionLaneContext,
  type ChatExecutionLaneReleaseResult,
  type ChatExecutionRecoveryContext,
  type ChatWorktreeTransitionResult,
  type ProjectChatExecutionContext,
  type StandaloneChatExecutionContext,
} from "./repository/chat-execution-lanes.js";
export { StandaloneChatPlacementUnavailableError } from "./repository/chat-catalog.js";
export { ARCHIVED_CHAT_RETENTION_MS } from "./repository/chat-mappers.js";
export type { ChatLiveRouting } from "./repository/chat-configuration.js";
export type { ChatExecutionAttribution } from "./repository/message-writes.js";
export { AgentInteractionConflictError } from "./repository/agent-interactions.js";
export {
  toChatAttachmentOpaqueSummary,
  type ChatAttachmentRecord,
} from "./repository/chat-attachments.js";
export type { TerminalExecutionContext } from "./repository/terminals.js";
export type { ExplorerExecutionContext } from "./repository/explorers.js";
export {
  CodeCapabilityUnavailableError,
  type CodeTabExecutionContext,
} from "./repository/code-surfaces.js";
export { SurfacePrivateStateConflictError } from "./repository/browsers.js";
export type { RemoteSurfaceExecutionContext } from "./repository/remote-surfaces.js";
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
  readonly projectLifecycle: ProjectLifecycleRepository;
  readonly placement: PlacementRepository;
  readonly executionTargets: ExecutionTargetRepository;
  readonly worktreeState: WorktreeStateRepository;
  readonly runConfigurationState: RunConfigurationStateRepository;
  readonly worktreeLifecycle: WorktreeLifecycleRepository;
  readonly chatExecutionLanes: ChatExecutionLaneRepository;
  readonly chatCatalog: ChatCatalogRepository;
  readonly chatState: ChatStateRepository;
  readonly chatArchiveLifecycle: ChatArchiveLifecycleRepository;
  readonly chatForks: ChatForkRepository;
  readonly chatConfiguration: ChatConfigurationRepository;
  readonly chatRuntimeContext: ChatRuntimeContextRepository;
  readonly agentInteractions: AgentInteractionRepository;
  readonly chatAttachments: ChatAttachmentRepository;
  readonly messageQueries: MessageQueryRepository;
  readonly queuedPrompts: QueuedPromptRepository;
  readonly messageWrites: MessageWriteRepository;
  readonly terminals: TerminalRepository;
  readonly explorers: ExplorerRepository;
  readonly codeSurfaces: CodeSurfaceRepository;
  readonly browsers: BrowserRepository;
  readonly remoteSurfaces: RemoteSurfaceRepository;
  readonly projectViews: ProjectViewRepository;
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
    this.runConfigurationState = new RunConfigurationStateRepository(database, {
      listRunConfigurationProtectedSecrets: (ownerId, projectId, references) =>
        this.listRunConfigurationProtectedSecrets(
          ownerId,
          projectId,
          references,
        ),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
    });
    this.worktreeLifecycle = new WorktreeLifecycleRepository(database, {
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
      listProjectWorktrees: (ownerId, projectId) =>
        this.listProjectWorktrees(ownerId, projectId),
    });
    this.chatExecutionLanes = new ChatExecutionLaneRepository(database, {
      getChatExecutionContext: (ownerId, chatId) =>
        this.getChatExecutionContext(ownerId, chatId),
      getChatExecutionLaneContext: (ownerId, chatId, laneId) =>
        this.getChatExecutionLaneContext(ownerId, chatId, laneId),
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
    });
    this.chatCatalog = new ChatCatalogRepository(database, {
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
      listWorkers: (ownerId) => this.listWorkers(ownerId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
      resolveProjectExecutionPlacement: (
        ownerId,
        projectId,
        surfaceKind,
        target,
        isWorkerConnected,
        allowOfflineExplicit,
      ) =>
        this.resolveProjectExecutionPlacement(
          ownerId,
          projectId,
          surfaceKind,
          target,
          isWorkerConnected,
          allowOfflineExplicit,
        ),
    });
    this.chatState = new ChatStateRepository(database, {
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
    });
    this.chatArchiveLifecycle = new ChatArchiveLifecycleRepository(database, {
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
    });
    this.chatForks = new ChatForkRepository(database, {
      createStandaloneChat: (ownerId, input, isWorkerConnected) =>
        this.createStandaloneChat(ownerId, input, isWorkerConnected),
    });
    this.chatConfiguration = new ChatConfigurationRepository(database, {
      getChatPlanWireState: (ownerId, chatId) =>
        this.getChatPlanWireState(ownerId, chatId),
      getModelRuntime: (ownerId, modelId) =>
        this.getModelRuntime(ownerId, modelId),
    });
    this.chatRuntimeContext = new ChatRuntimeContextRepository(database, {
      getChatExecutionContext: (ownerId, chatId) =>
        this.getChatExecutionContext(ownerId, chatId),
    });
    this.agentInteractions = new AgentInteractionRepository(database, {
      expireAgentInteractionRequests: (now) =>
        this.expireAgentInteractionRequests(now),
      getAgentInteractionRequest: (ownerId, requestId) =>
        this.getAgentInteractionRequest(ownerId, requestId),
    });
    this.chatAttachments = new ChatAttachmentRepository(database, {
      getChatAttachment: (ownerId, attachmentId) =>
        this.getChatAttachment(ownerId, attachmentId),
    });
    this.messageQueries = new MessageQueryRepository(database);
    this.queuedPrompts = new QueuedPromptRepository(database);
    this.messageWrites = new MessageWriteRepository(database, {
      appendMessage: (ownerId, chatId, input, attribution) =>
        this.appendMessage(ownerId, chatId, input, attribution),
      appendEncryptedMessage: (ownerId, chatId, input, attribution) =>
        this.appendEncryptedMessage(ownerId, chatId, input, attribution),
      appendTaskMessage: (ownerId, chatId, input, attribution) =>
        this.appendTaskMessage(ownerId, chatId, input, attribution),
      getMessageByIdempotencyKey: (ownerId, chatId, idempotencyKey) =>
        this.getMessageByIdempotencyKey(ownerId, chatId, idempotencyKey),
      getEncryptedMessageByIdempotencyKey: (ownerId, chatId, idempotencyKey) =>
        this.getEncryptedMessageByIdempotencyKey(
          ownerId,
          chatId,
          idempotencyKey,
        ),
      getTaskMessageByIdempotencyKey: (ownerId, chatId, idempotencyKey) =>
        this.getTaskMessageByIdempotencyKey(ownerId, chatId, idempotencyKey),
    });
    this.terminals = new TerminalRepository(database, {
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
      getTerminalExecutionContext: (ownerId, terminalId) =>
        this.getTerminalExecutionContext(ownerId, terminalId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
      resolveProjectExecutionPlacement: (
        ownerId,
        projectId,
        surfaceKind,
        target,
        isWorkerConnected,
        allowOfflineExplicit,
      ) =>
        this.resolveProjectExecutionPlacement(
          ownerId,
          projectId,
          surfaceKind,
          target,
          isWorkerConnected,
          allowOfflineExplicit,
        ),
      toTerminalWireSummary,
    });
    this.explorers = new ExplorerRepository(database, {
      getExplorerExecutionContext: (ownerId, explorerId) =>
        this.getExplorerExecutionContext(ownerId, explorerId),
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
      resolveProjectExecutionPlacement: (
        ownerId,
        projectId,
        surfaceKind,
        target,
        isWorkerConnected,
        allowOfflineExplicit,
      ) =>
        this.resolveProjectExecutionPlacement(
          ownerId,
          projectId,
          surfaceKind,
          target,
          isWorkerConnected,
          allowOfflineExplicit,
        ),
      toExplorerWireSummary,
    });
    this.codeSurfaces = new CodeSurfaceRepository(database, {
      getCodeTabExecutionContext: (ownerId, codeTabId) =>
        this.getCodeTabExecutionContext(ownerId, codeTabId),
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
      resolveProjectExecutionPlacement: (
        ownerId,
        projectId,
        surfaceKind,
        target,
        isWorkerConnected,
        allowOfflineExplicit,
      ) =>
        this.resolveProjectExecutionPlacement(
          ownerId,
          projectId,
          surfaceKind,
          target,
          isWorkerConnected,
          allowOfflineExplicit,
        ),
    });
    this.projectViews = new ProjectViewRepository(database, {
      getProjectSource: (ownerId, projectId) =>
        this.getProjectSource(ownerId, projectId),
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
    });
    this.remoteSurfaces = new RemoteSurfaceRepository(database, {
      getRemoteDesktop: (ownerId, desktopId) =>
        this.getRemoteDesktop(ownerId, desktopId),
      getRemoteSurfaceExecutionContext: (ownerId, surfaceId) =>
        this.getRemoteSurfaceExecutionContext(ownerId, surfaceId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
    });
    this.browsers = new BrowserRepository(database, {
      getProjectSource: (ownerId, projectId) =>
        this.getProjectSource(ownerId, projectId),
      getRemoteSurfaceExecutionContext: (ownerId, surfaceId) =>
        this.getRemoteSurfaceExecutionContext(ownerId, surfaceId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
      resolveProjectExecutionPlacement: (
        ownerId,
        projectId,
        surfaceKind,
        target,
        isWorkerConnected,
        allowOfflineExplicit,
      ) =>
        this.resolveProjectExecutionPlacement(
          ownerId,
          projectId,
          surfaceKind,
          target,
          isWorkerConnected,
          allowOfflineExplicit,
        ),
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
    this.projectLifecycle = new ProjectLifecycleRepository(database, {
      ensureDefaultProjectWorkspace: (ownerId) =>
        this.ensureDefaultProjectWorkspace(ownerId),
      getConvertedManagedFolderSource: (ownerId, projectId) =>
        this.projectGithubConversionJobs.convertedManagedFolderSource(
          ownerId,
          projectId,
        ),
      getProjectFolderSetupJob: (ownerId, projectId) =>
        this.projectFolderSetupJobs.get(ownerId, projectId),
      listProjectReplicas: (ownerId, projectId) =>
        this.listProjectReplicas(ownerId, projectId),
    });
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
    return this.runConfigurationState.listRunConfigurationSecretSummaries(
      ownerId,
      projectId,
    );
  }

  async getRunConfigurationSecretStatuses(
    ownerId: string,
    projectId: string,
    references: string[],
  ): Promise<RunConfigurationSecretSummary[]> {
    return this.runConfigurationState.getRunConfigurationSecretStatuses(
      ownerId,
      projectId,
      references,
    );
  }

  async listRunConfigurationProtectedSecrets(
    ownerId: string,
    projectId: string,
    references: string[],
  ): Promise<Array<RunConfigurationProtectedSecret & { updatedAt: string }>> {
    return this.runConfigurationState.listRunConfigurationProtectedSecrets(
      ownerId,
      projectId,
      references,
    );
  }

  async setRunConfigurationSecret(
    ownerId: string,
    projectId: string,
    raw: unknown,
  ): Promise<RunConfigurationSecretSetResult> {
    return this.runConfigurationState.setRunConfigurationSecret(
      ownerId,
      projectId,
      raw,
    );
  }

  async getRunConfigurationRuntimeOperationResult(
    ownerId: string,
    operationId: string,
  ): Promise<RunConfigurationRuntimeOperationResult | null> {
    return this.runConfigurationState.getRunConfigurationRuntimeOperationResult(
      ownerId,
      operationId,
    );
  }

  async requestRunConfigurationRuntimeOperation(
    ownerId: string,
    input: RunConfigurationRuntimeOperationRequest,
  ): Promise<RunConfigurationRuntimeOperationResult> {
    return this.runConfigurationState.requestRunConfigurationRuntimeOperation(
      ownerId,
      input,
    );
  }

  async getRunConfigurationRuntime(
    ownerId: string,
    projectId: string,
    configurationId: string,
    worktreeId: string,
  ): Promise<RunConfigurationRuntime | null> {
    return this.runConfigurationState.getRunConfigurationRuntime(
      ownerId,
      projectId,
      configurationId,
      worktreeId,
    );
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
    return this.runConfigurationState.listRunConfigurationRuntimes(
      ownerId,
      projectId,
      input,
    );
  }

  async deleteRunConfigurationRuntimes(
    ownerId: string,
    projectId: string,
    runtimeIds: readonly string[],
  ): Promise<number> {
    return this.runConfigurationState.deleteRunConfigurationRuntimes(
      ownerId,
      projectId,
      runtimeIds,
    );
  }

  async listActiveRunConfigurationRuntimeIdentitiesForWorker(
    ownerId: string,
    workerId: string,
  ): Promise<RunConfigurationRuntimeWorkerIdentity[]> {
    return this.runConfigurationState.listActiveRunConfigurationRuntimeIdentitiesForWorker(
      ownerId,
      workerId,
    );
  }

  async applyRunConfigurationRuntimeObservation(
    ownerId: string,
    workerId: string,
    observation: RunConfigurationRuntimeWorkerObservation,
  ): Promise<RunConfigurationRuntimeObservationApplyResult | null> {
    return this.runConfigurationState.applyRunConfigurationRuntimeObservation(
      ownerId,
      workerId,
      observation,
    );
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
    return this.worktreeLifecycle.reconcileProjectWorktrees(
      ownerId,
      projectId,
      workerId,
      inventory,
      created,
    );
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
    return this.worktreeLifecycle.rollbackProjectWorktreeCreation(
      ownerId,
      projectId,
      workerId,
      created,
    );
  }

  async setProjectWorktreeLifecycle(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    lifecycleState: ProjectWorktreeSummary["lifecycleState"],
  ): Promise<ProjectWorktreeSummary | null> {
    return this.worktreeLifecycle.setProjectWorktreeLifecycle(
      ownerId,
      projectId,
      worktreeId,
      lifecycleState,
    );
  }

  async observeProjectWorktree(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    observed: WorkerWorktreeSummary,
  ): Promise<ProjectWorktreeSummary | null> {
    return this.worktreeLifecycle.observeProjectWorktree(
      ownerId,
      projectId,
      worktreeId,
      observed,
    );
  }

  async getWorktreeRemovalBlockers(
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeRemovalBlockers | null> {
    return this.worktreeLifecycle.getWorktreeRemovalBlockers(
      ownerId,
      projectId,
      worktreeId,
    );
  }

  async listChatExecutionLanes(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionLaneSummary[]> {
    return this.chatExecutionLanes.listChatExecutionLanes(ownerId, chatId);
  }

  async listProjectExecutionLanes(
    ownerId: string,
    projectId: string,
    options: { includeHistory?: boolean } = {},
  ): Promise<ChatExecutionLaneSummary[]> {
    return this.chatExecutionLanes.listProjectExecutionLanes(
      ownerId,
      projectId,
      options,
    );
  }

  async resetInterruptedChatExecutions(): Promise<void> {
    return this.chatExecutionLanes.resetInterruptedChatExecutions();
  }

  async startChatExecutionLane(
    ownerId: string,
    chatId: string,
    acquiringActor: ChatExecutionLaneSummary["acquiringActor"],
    purpose: string,
  ): Promise<ChatExecutionContext | null> {
    return this.chatExecutionLanes.startChatExecutionLane(
      ownerId,
      chatId,
      acquiringActor,
      purpose,
    );
  }

  async finishChatExecutionLane(
    chatId: string,
    laneId: string,
    status: ChatWireSummary["status"],
  ): Promise<boolean> {
    return this.chatExecutionLanes.finishChatExecutionLane(
      chatId,
      laneId,
      status,
    );
  }

  async updateChatExecutionLaneRuntime(
    chatId: string,
    laneId: string,
    threadId: string | null,
    status: string,
  ): Promise<boolean> {
    return this.chatExecutionLanes.updateChatExecutionLaneRuntime(
      chatId,
      laneId,
      threadId,
      status,
    );
  }

  async getChatExecutionLaneContext(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<ChatExecutionLaneContext | null> {
    return this.chatExecutionLanes.getChatExecutionLaneContext(
      ownerId,
      chatId,
      laneId,
    );
  }

  async getChatExecutionRecoveryContext(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<ChatExecutionRecoveryContext | null> {
    return this.chatExecutionLanes.getChatExecutionRecoveryContext(
      ownerId,
      chatId,
      laneId,
    );
  }

  async releaseChatExecutionLane(
    ownerId: string,
    chatId: string,
    laneId: string,
    returnToPrimary: boolean,
  ): Promise<ChatExecutionLaneReleaseResult | null> {
    return this.chatExecutionLanes.releaseChatExecutionLane(
      ownerId,
      chatId,
      laneId,
      returnToPrimary,
    );
  }

  async scheduleChatWorktreeTransition(
    ownerId: string,
    chatId: string,
    expectedExecutionLaneId: string,
    targetWorktreeId: string,
    transitionKind: "switch" | "release",
    purpose: string,
  ): Promise<ChatExecutionLaneContext | null> {
    return this.chatExecutionLanes.scheduleChatWorktreeTransition(
      ownerId,
      chatId,
      expectedExecutionLaneId,
      targetWorktreeId,
      transitionKind,
      purpose,
    );
  }

  async getPendingChatWorktreeTransition(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionLaneContext | null> {
    return this.chatExecutionLanes.getPendingChatWorktreeTransition(
      ownerId,
      chatId,
    );
  }

  async listPendingWorktreeTransitionChatIds(
    ownerId: string,
    workerId: string,
  ): Promise<string[]> {
    return this.chatExecutionLanes.listPendingWorktreeTransitionChatIds(
      ownerId,
      workerId,
    );
  }

  async cancelChatWorktreeTransition(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<boolean> {
    return this.chatExecutionLanes.cancelChatWorktreeTransition(
      ownerId,
      chatId,
      laneId,
    );
  }

  async applyChatWorktreeTransition(
    ownerId: string,
    chatId: string,
    laneId: string,
  ): Promise<ChatWorktreeTransitionResult | null> {
    return this.chatExecutionLanes.applyChatWorktreeTransition(
      ownerId,
      chatId,
      laneId,
    );
  }
  async getGithubProjectExecutionContext(
    ownerId: string,
    projectId: string,
    workerId?: string,
  ): Promise<GithubProjectExecutionContext | null> {
    return this.projectLifecycle.getGithubProjectExecutionContext(
      ownerId,
      projectId,
      workerId,
    );
  }

  async hasGithubProject(ownerId: string, repositoryBlindIndex: string) {
    return this.projectLifecycle.hasGithubProject(
      ownerId,
      repositoryBlindIndex,
    );
  }

  async listGithubRepositoryIds(ownerId: string): Promise<Set<string>> {
    return this.projectLifecycle.listGithubRepositoryIds(ownerId);
  }

  async createGithubProject(
    ownerId: string,
    input: EncryptedGithubProjectCreate,
  ): Promise<ProjectWireSummary> {
    return this.projectLifecycle.createGithubProject(ownerId, input);
  }

  async createManagedFolderProject(
    ownerId: string,
    input: EncryptedManagedFolderProjectCreate,
  ): Promise<{
    job: ProjectFolderSetupJobSummary;
    project: ProjectWireSummary;
  }> {
    return this.projectLifecycle.createManagedFolderProject(ownerId, input);
  }

  async completeGithubProjectSetup(
    ownerId: string,
    projectId: string,
    workerId: string,
    clone: ProjectCloneResult,
  ): Promise<ProjectWireSummary | null> {
    return this.projectLifecycle.completeGithubProjectSetup(
      ownerId,
      projectId,
      workerId,
      clone,
    );
  }

  async getProjectRemovalContext(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectRemovalContext | null> {
    return this.projectLifecycle.getProjectRemovalContext(ownerId, projectId);
  }

  async deleteProject(ownerId: string, projectId: string): Promise<boolean> {
    return this.projectLifecycle.deleteProject(ownerId, projectId);
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
    return this.chatCatalog.listChats(ownerId, projectId);
  }

  async listArchivedChats(
    ownerId: string,
    projectId: string,
  ): Promise<ArchivedChatWireSummary[]> {
    return this.chatCatalog.listArchivedChats(ownerId, projectId);
  }

  async listStandaloneChats(
    ownerId: string,
  ): Promise<StandaloneChatWireSummary[]> {
    return this.chatCatalog.listStandaloneChats(ownerId);
  }

  async listArchivedStandaloneChats(
    ownerId: string,
  ): Promise<ArchivedStandaloneChatWireSummary[]> {
    return this.chatCatalog.listArchivedStandaloneChats(ownerId);
  }

  async createStandaloneChat(
    ownerId: string,
    input: EncryptedStandaloneChatCreate,
    isWorkerConnected: (workerId: string) => boolean,
  ): Promise<{
    chat: StandaloneChatWireSummary;
    provisionJob: StandaloneChatRootJobSummary;
  }> {
    return this.chatCatalog.createStandaloneChat(
      ownerId,
      input,
      isWorkerConnected,
    );
  }

  async createChat(
    ownerId: string,
    projectId: string,
    input: EncryptedChatCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ChatWireSummary | null> {
    return this.chatCatalog.createChat(
      ownerId,
      projectId,
      input,
      isWorkerConnected,
    );
  }

  async createTask(
    ownerId: string,
    projectId: string,
    input: EncryptedTaskCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<TaskWireCreateResult | null> {
    return this.chatCatalog.createTask(
      ownerId,
      projectId,
      input,
      isWorkerConnected,
    );
  }

  async listTerminals(
    ownerId: string,
    projectId: string,
  ): Promise<TerminalWireSummary[]> {
    return this.terminals.listTerminals(ownerId, projectId);
  }

  async createTerminal(
    ownerId: string,
    projectId: string,
    input: EncryptedTerminalCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<TerminalWireSummary | null> {
    return this.terminals.createTerminal(
      ownerId,
      projectId,
      input,
      isWorkerConnected,
    );
  }

  async getOrCreateChatConsole(
    ownerId: string,
    chatId: string,
    input: Pick<
      EncryptedTerminalCreate,
      "id" | "titleProtection" | "stateProtection"
    >,
  ): Promise<TerminalWireSummary | null> {
    return this.terminals.getOrCreateChatConsole(ownerId, chatId, input);
  }

  async updateTerminal(
    ownerId: string,
    terminalId: string,
    input: EncryptedTerminalUpdate,
  ): Promise<TerminalWireSummary | null> {
    return this.terminals.updateTerminal(ownerId, terminalId, input);
  }

  async updateTerminalService(
    ownerId: string,
    terminalId: string,
    input: EncryptedTerminalServiceConfiguration,
  ): Promise<TerminalWireSummary | null> {
    return this.terminals.updateTerminalService(ownerId, terminalId, input);
  }

  async listTerminalServicesForWorker(
    workerId: string,
    serverId: string,
  ): Promise<TerminalServiceRuntimeConfiguration[]> {
    return this.terminals.listTerminalServicesForWorker(workerId, serverId);
  }

  async updateTerminalWorktree(
    ownerId: string,
    terminalId: string,
    input: WorktreeSelection,
  ): Promise<TerminalWireSummary | null> {
    return this.terminals.updateTerminalWorktree(ownerId, terminalId, input);
  }

  async listExplorers(
    ownerId: string,
    projectId: string,
  ): Promise<ExplorerWireSummary[]> {
    return this.explorers.listExplorers(ownerId, projectId);
  }

  async createExplorer(
    ownerId: string,
    projectId: string,
    input: EncryptedExplorerCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExplorerWireSummary | null> {
    return this.explorers.createExplorer(
      ownerId,
      projectId,
      input,
      isWorkerConnected,
    );
  }

  async updateExplorerWorktree(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerWorktreeUpdate,
  ): Promise<ExplorerWireSummary | null> {
    return this.explorers.updateExplorerWorktree(ownerId, explorerId, input);
  }

  async getExplorerExecutionContext(
    ownerId: string,
    explorerId: string,
  ): Promise<ExplorerExecutionContext | null> {
    return this.explorers.getExplorerExecutionContext(ownerId, explorerId);
  }

  async updateExplorer(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerUpdate,
  ): Promise<ExplorerWireSummary | null> {
    return this.explorers.updateExplorer(ownerId, explorerId, input);
  }

  async pinExplorer(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerPin,
  ): Promise<ExplorerWireSummary | null> {
    return this.explorers.pinExplorer(ownerId, explorerId, input);
  }

  async updateExplorerViewState(
    ownerId: string,
    explorerId: string,
    input: EncryptedExplorerViewStateUpdate,
  ): Promise<ExplorerWireSummary | null> {
    return this.explorers.updateExplorerViewState(ownerId, explorerId, input);
  }

  async deleteExplorer(ownerId: string, explorerId: string): Promise<boolean> {
    return this.explorers.deleteExplorer(ownerId, explorerId);
  }

  async listCodeTabs(
    ownerId: string,
    projectId: string,
  ): Promise<CodeTabWireSummary[]> {
    return this.codeSurfaces.listCodeTabs(ownerId, projectId);
  }

  async createCodeTab(
    ownerId: string,
    projectId: string,
    input: EncryptedCodeTabCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<CodeTabWireSummary | null> {
    return this.codeSurfaces.createCodeTab(
      ownerId,
      projectId,
      input,
      isWorkerConnected,
    );
  }

  async getCodeTabExecutionContext(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeTabExecutionContext | null> {
    return this.codeSurfaces.getCodeTabExecutionContext(ownerId, codeTabId);
  }

  async updateCodeTab(
    ownerId: string,
    codeTabId: string,
    input: EncryptedCodeTabUpdate,
  ): Promise<CodeTabWireSummary | null> {
    return this.codeSurfaces.updateCodeTab(ownerId, codeTabId, input);
  }

  async updateCodeTabWorktree(
    ownerId: string,
    codeTabId: string,
    input: WorktreeSelection,
  ): Promise<CodeTabWireSummary | null> {
    return this.codeSurfaces.updateCodeTabWorktree(ownerId, codeTabId, input);
  }

  async deleteCodeTab(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeTabExecutionContext | null> {
    return this.codeSurfaces.deleteCodeTab(ownerId, codeTabId);
  }

  async listCodeSessions(
    ownerId: string,
    codeTabId: string,
  ): Promise<CodeSessionSummary[] | null> {
    return this.codeSurfaces.listCodeSessions(ownerId, codeTabId);
  }

  async getOrCreateCodeSession(
    ownerId: string,
    codeTabId: string,
    editorBuild: CodeEditorBuild,
    preferredSessionId: string = randomUUID(),
  ): Promise<CodeSessionSummary | null> {
    return this.codeSurfaces.getOrCreateCodeSession(
      ownerId,
      codeTabId,
      editorBuild,
      preferredSessionId,
    );
  }

  async updateCodeSessionRuntime(
    ownerId: string,
    codeTabId: string,
    sessionId: string,
    runtime: CodeRuntimeStatus,
    attached = false,
  ): Promise<CodeSessionSummary | null> {
    return this.codeSurfaces.updateCodeSessionRuntime(
      ownerId,
      codeTabId,
      sessionId,
      runtime,
      attached,
    );
  }

  async listBrowsers(
    ownerId: string,
    projectId: string,
  ): Promise<BrowserWireSummary[]> {
    return this.browsers.listBrowsers(ownerId, projectId);
  }

  async createBrowser(
    ownerId: string,
    projectId: string,
    input: EncryptedBrowserCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<BrowserWireSummary | null> {
    return this.browsers.createBrowser(
      ownerId,
      projectId,
      input,
      isWorkerConnected,
    );
  }

  async updateBrowser(
    ownerId: string,
    browserId: string,
    input: EncryptedBrowserUpdate,
  ): Promise<BrowserWireSummary | null> {
    return this.browsers.updateBrowser(ownerId, browserId, input);
  }

  async deleteBrowser(ownerId: string, browserId: string): Promise<boolean> {
    return this.browsers.deleteBrowser(ownerId, browserId);
  }

  async ensureBrowserRemoteSurfaces(ownerId: string): Promise<void> {
    return this.browsers.ensureBrowserRemoteSurfaces(ownerId);
  }

  async listRemoteSurfaces(
    ownerId: string,
    projectId: string,
  ): Promise<RemoteSurfaceWireSummary[]> {
    return this.remoteSurfaces.listRemoteSurfaces(ownerId, projectId);
  }

  async createRemoteSurface(
    ownerId: string,
    projectId: string,
    input: EncryptedRemoteSurfaceCreate,
  ): Promise<RemoteSurfaceWireSummary | null> {
    return this.remoteSurfaces.createRemoteSurface(ownerId, projectId, input);
  }

  async getRemoteSurfaceExecutionContext(
    ownerId: string,
    surfaceId: string,
  ): Promise<RemoteSurfaceExecutionContext | null> {
    return this.remoteSurfaces.getRemoteSurfaceExecutionContext(
      ownerId,
      surfaceId,
    );
  }

  async updateRemoteSurface(
    ownerId: string,
    surfaceId: string,
    input: EncryptedRemoteSurfaceUpdate,
  ): Promise<RemoteSurfaceWireSummary | null> {
    return this.remoteSurfaces.updateRemoteSurface(ownerId, surfaceId, input);
  }

  async setRemoteSurfaceStatus(
    surfaceId: string,
    status: RemoteSurfaceStatus,
    lastError: string | null = null,
  ): Promise<void> {
    return this.remoteSurfaces.setRemoteSurfaceStatus(
      surfaceId,
      status,
      lastError,
    );
  }

  async resetTransientRemoteSurfaceStatuses(): Promise<void> {
    return this.remoteSurfaces.resetTransientRemoteSurfaceStatuses();
  }

  async deleteRemoteSurface(
    ownerId: string,
    surfaceId: string,
  ): Promise<RemoteSurfaceExecutionContext | null> {
    return this.remoteSurfaces.deleteRemoteSurface(ownerId, surfaceId);
  }

  async listRemoteDesktops(
    ownerId: string,
    projectId: string,
  ): Promise<RemoteDesktopWireSummary[]> {
    return this.remoteSurfaces.listRemoteDesktops(ownerId, projectId);
  }

  async getRemoteDesktop(
    ownerId: string,
    desktopId: string,
  ): Promise<RemoteDesktopWireSummary | null> {
    return this.remoteSurfaces.getRemoteDesktop(ownerId, desktopId);
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
    return this.remoteSurfaces.createRemoteDesktop(
      ownerId,
      projectId,
      desktopId,
      titleProtection,
      workerId,
      stateProtection,
      tabGroupId,
    );
  }
  async listProjectViews(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectViewWireSummary[]> {
    return this.projectViews.listProjectViews(ownerId, projectId);
  }

  async getProjectViewProjectId(
    ownerId: string,
    viewId: string,
  ): Promise<string | null> {
    return this.projectViews.getProjectViewProjectId(ownerId, viewId);
  }

  async createProjectView(
    ownerId: string,
    projectId: string,
    input: EncryptedProjectViewCreate,
  ): Promise<ProjectViewWireSummary | null> {
    return this.projectViews.createProjectView(ownerId, projectId, input);
  }

  async updateProjectView(
    ownerId: string,
    viewId: string,
    input: EncryptedProjectViewUpdate,
  ): Promise<ProjectViewWireSummary | null> {
    return this.projectViews.updateProjectView(ownerId, viewId, input);
  }

  async updateProjectViewWorktree(
    ownerId: string,
    viewId: string,
    input: WorktreeSelection,
  ): Promise<ProjectViewWireSummary | null> {
    return this.projectViews.updateProjectViewWorktree(ownerId, viewId, input);
  }

  async deleteProjectView(ownerId: string, viewId: string): Promise<boolean> {
    return this.projectViews.deleteProjectView(ownerId, viewId);
  }
  private async browserIsOwnedBy(
    ownerId: string,
    browserId: string,
  ): Promise<boolean> {
    return this.browsers.browserIsOwnedBy(ownerId, browserId);
  }

  async deleteTerminal(
    ownerId: string,
    terminalId: string,
  ): Promise<TerminalExecutionContext | null> {
    return this.terminals.deleteTerminal(ownerId, terminalId);
  }

  async getTerminalExecutionContext(
    ownerId: string,
    terminalId: string,
  ): Promise<TerminalExecutionContext | null> {
    return this.terminals.getTerminalExecutionContext(ownerId, terminalId);
  }

  async setTerminalStatus(
    terminalId: string,
    status: TerminalWireSummary["status"],
  ): Promise<void> {
    return this.terminals.setTerminalStatus(terminalId, status);
  }

  async updateChat(
    ownerId: string,
    chatId: string,
    input: EncryptedChatUpdate,
  ): Promise<ContextualChatWireSummary | null> {
    return this.chatState.updateChat(ownerId, chatId, input);
  }

  async getChatComposerDraftWireState(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedChatComposerDraftWireState | null> {
    return this.chatState.getChatComposerDraftWireState(ownerId, chatId);
  }

  async updateChatComposerDraft(
    ownerId: string,
    chatId: string,
    state: ChatComposerDraftOpaqueState | null,
  ): Promise<EncryptedChatComposerDraftWireState | null> {
    return this.chatState.updateChatComposerDraft(ownerId, chatId, state);
  }

  async setChatAutomationPaused(
    ownerId: string,
    chatId: string,
    paused: boolean,
  ): Promise<ContextualChatWireSummary | null> {
    return this.chatState.setChatAutomationPaused(ownerId, chatId, paused);
  }

  async updateChatWorktree(
    ownerId: string,
    chatId: string,
    input: ChatWorktreeUpdate,
  ): Promise<ChatWireSummary | null> {
    return this.chatState.updateChatWorktree(ownerId, chatId, input);
  }
  async deleteChat(
    ownerId: string,
    chatId: string,
  ): Promise<false | "archived" | "deleted" | "running"> {
    return this.chatArchiveLifecycle.deleteChat(ownerId, chatId);
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
    return this.chatArchiveLifecycle.archiveStandaloneChat(ownerId, chatId);
  }

  async restoreStandaloneChat(
    ownerId: string,
    chatId: string,
  ): Promise<null | {
    chat: StandaloneChatWireSummary;
    rootId: string;
    workerId: string;
  }> {
    return this.chatArchiveLifecycle.restoreStandaloneChat(ownerId, chatId);
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
    return this.chatArchiveLifecycle.getStandaloneChatRootForDeletion(
      ownerId,
      chatId,
    );
  }

  async restoreArchivedChat(
    ownerId: string,
    chatId: string,
  ): Promise<ChatWireSummary | null> {
    return this.chatArchiveLifecycle.restoreArchivedChat(ownerId, chatId);
  }

  async permanentlyDeleteArchivedChat(
    ownerId: string,
    chatId: string,
  ): Promise<boolean> {
    return this.chatArchiveLifecycle.permanentlyDeleteArchivedChat(
      ownerId,
      chatId,
    );
  }

  async purgeExpiredArchivedChats(
    ownerId: string,
    cutoff: Date,
  ): Promise<number> {
    return this.chatArchiveLifecycle.purgeExpiredArchivedChats(ownerId, cutoff);
  }
  async forkChat(
    ownerId: string,
    chatId: string,
    input: EncryptedChatFork,
    protectMessages: (
      messages: ChatMessageOpaqueSummary[],
    ) => Promise<ChatMessageOpaqueContent[]>,
  ): Promise<ChatWireSummary | null> {
    return this.chatForks.forkChat(ownerId, chatId, input, protectMessages);
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
    return this.chatForks.forkStandaloneChat(
      ownerId,
      chatId,
      input,
      isWorkerConnected,
      protectMessages,
    );
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
    return this.chatConfiguration.setChatModel(
      ownerId,
      chatId,
      input,
      reasoningEffort,
    );
  }

  async getChatModelConfiguration(
    ownerId: string,
    chatId: string,
  ): Promise<ModelConfiguration | null> {
    return this.chatConfiguration.getChatModelConfiguration(ownerId, chatId);
  }

  async setChatModelConfiguration(
    ownerId: string,
    chatId: string,
    input: ChatModelConfigurationUpdate,
  ): Promise<ContextualChatWireSummary | null> {
    return this.chatConfiguration.setChatModelConfiguration(
      ownerId,
      chatId,
      input,
    );
  }

  async setChatReasoningEffort(
    ownerId: string,
    chatId: string,
    reasoningEffort: ReasoningEffort | null,
  ): Promise<ContextualChatWireSummary | null> {
    return this.chatConfiguration.setChatReasoningEffort(
      ownerId,
      chatId,
      reasoningEffort,
    );
  }

  async getModelReasoningDefault(
    ownerId: string,
    modelId: string,
  ): Promise<ReasoningEffort | null | undefined> {
    return this.chatConfiguration.getModelReasoningDefault(ownerId, modelId);
  }

  async setChatReasoningEffortAndRememberDefault(
    ownerId: string,
    chatId: string,
    modelId: string,
    reasoningEffort: ReasoningEffort | null,
  ): Promise<ContextualChatWireSummary | null> {
    return this.chatConfiguration.setChatReasoningEffortAndRememberDefault(
      ownerId,
      chatId,
      modelId,
      reasoningEffort,
    );
  }

  async setChatPermissionProfile(
    ownerId: string,
    chatId: string,
    permissionProfileId: string | null,
  ): Promise<ContextualChatWireSummary | null> {
    return this.chatConfiguration.setChatPermissionProfile(
      ownerId,
      chatId,
      permissionProfileId,
    );
  }

  async getEncryptedChatPlanState(
    ownerId: string,
    chatId: string,
  ): Promise<ChatPlanOpaqueState | null> {
    return this.chatConfiguration.getEncryptedChatPlanState(ownerId, chatId);
  }

  async getChatPlanWireState(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedChatPlanWireState | null> {
    return this.chatConfiguration.getChatPlanWireState(ownerId, chatId);
  }

  async updateChatPlanMode(
    ownerId: string,
    chatId: string,
    mode: PlanMode,
  ): Promise<EncryptedChatPlanWireState | null> {
    return this.chatConfiguration.updateChatPlanMode(ownerId, chatId, mode);
  }

  async updateEncryptedChatPlanState(
    chatId: string,
    state: ChatPlanOpaqueState,
  ): Promise<void> {
    return this.chatConfiguration.updateEncryptedChatPlanState(chatId, state);
  }

  async getChatLiveRouting(
    ownerId: string,
    chatId: string,
  ): Promise<ChatLiveRouting | null> {
    return this.chatConfiguration.getChatLiveRouting(ownerId, chatId);
  }
  async getChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<ChatExecutionContext | null> {
    return this.chatRuntimeContext.getChatExecutionContext(ownerId, chatId);
  }

  async listChatExecutionContextsByThreadId(
    ownerId: string,
    workerId: string,
    threadId: string,
  ): Promise<ChatExecutionContext[]> {
    return this.chatRuntimeContext.listChatExecutionContextsByThreadId(
      ownerId,
      workerId,
      threadId,
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
    return this.chatRuntimeContext.updateChatRuntime(
      chatId,
      workerId,
      worktreeId,
      threadId,
      modelRouteId,
      status,
      providerAccountId,
      scratchRootId,
    );
  }

  async setChatStatus(
    chatId: string,
    status: ChatWireSummary["status"],
  ): Promise<void> {
    return this.chatRuntimeContext.setChatStatus(chatId, status);
  }

  async acknowledgeChatCompletion(
    ownerId: string,
    chatId: string,
  ): Promise<ContextualChatWireSummary | null> {
    return this.chatRuntimeContext.acknowledgeChatCompletion(ownerId, chatId);
  }
  async recordAgentInteractionRequest(
    input: AgentInteractionRequestCreate,
  ): Promise<AgentInteractionRequest> {
    return this.agentInteractions.recordAgentInteractionRequest(input);
  }

  async recordEncryptedAgentInteractionRequest(
    input: EncryptedAgentInteractionRequestCreate,
  ): Promise<EncryptedAgentInteractionRequest> {
    return this.agentInteractions.recordEncryptedAgentInteractionRequest(input);
  }

  async listAgentInteractionRequests(
    ownerId: string,
    query: AgentInteractionRequestQuery,
  ): Promise<AgentInteractionRequestWire[]> {
    return this.agentInteractions.listAgentInteractionRequests(ownerId, query);
  }

  async getAgentInteractionRequest(
    ownerId: string,
    requestId: string,
  ): Promise<AgentInteractionRequestWire | null> {
    return this.agentInteractions.getAgentInteractionRequest(
      ownerId,
      requestId,
    );
  }

  async getAgentInteractionRequestByKey(
    ownerId: string,
    requestKey: string,
  ): Promise<AgentInteractionRequestWire | null> {
    return this.agentInteractions.getAgentInteractionRequestByKey(
      ownerId,
      requestKey,
    );
  }

  async resolveAgentInteractionRequest(
    ownerId: string,
    requestId: string,
    input: AgentInteractionResolutionCreate,
  ): Promise<AgentInteractionRequest | null> {
    return this.agentInteractions.resolveAgentInteractionRequest(
      ownerId,
      requestId,
      input,
    );
  }

  async validateAgentInteractionResolution(
    ownerId: string,
    requestId: string,
    input: AgentInteractionResolutionCreate,
  ): Promise<AgentInteractionRequest | null> {
    return this.agentInteractions.validateAgentInteractionResolution(
      ownerId,
      requestId,
      input,
    );
  }

  async resolveEncryptedAgentInteractionRequest(
    ownerId: string,
    requestId: string,
    input: EncryptedAgentInteractionResolutionCreate,
  ): Promise<EncryptedAgentInteractionRequest | null> {
    return this.agentInteractions.resolveEncryptedAgentInteractionRequest(
      ownerId,
      requestId,
      input,
    );
  }

  async validateEncryptedAgentInteractionResolution(
    ownerId: string,
    requestId: string,
    input: EncryptedAgentInteractionResolutionCreate,
  ): Promise<EncryptedAgentInteractionRequest | null> {
    return this.agentInteractions.validateEncryptedAgentInteractionResolution(
      ownerId,
      requestId,
      input,
    );
  }

  async expireAgentInteractionRequests(
    now = new Date(),
  ): Promise<AgentInteractionRequestWire[]> {
    return this.agentInteractions.expireAgentInteractionRequests(now);
  }

  async interruptAgentInteractionRequests(
    chatId: string,
  ): Promise<AgentInteractionRequestWire[]> {
    return this.agentInteractions.interruptAgentInteractionRequests(chatId);
  }

  async terminalizeAgentInteractionRequestFromWorker(
    requestKey: string,
    chatId: string,
    workerId: string,
    status: "expired" | "interrupted",
  ): Promise<AgentInteractionRequestWire | null> {
    return this.agentInteractions.terminalizeAgentInteractionRequestFromWorker(
      requestKey,
      chatId,
      workerId,
      status,
    );
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
    return this.chatAttachments.createChatAttachment(ownerId, chatId, input);
  }

  async getChatAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    return this.chatAttachments.getChatAttachment(ownerId, attachmentId);
  }

  async getChatAttachments(
    ownerId: string,
    chatId: string,
    attachmentIds: string[],
  ): Promise<ChatAttachmentRecord[]> {
    return this.chatAttachments.getChatAttachments(
      ownerId,
      chatId,
      attachmentIds,
    );
  }

  async getChatAttachmentReplicaWorkerIds(
    ownerId: string,
    attachmentId: string,
  ): Promise<string[]> {
    return this.chatAttachments.getChatAttachmentReplicaWorkerIds(
      ownerId,
      attachmentId,
    );
  }

  async deleteChatAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    return this.chatAttachments.deleteChatAttachment(ownerId, attachmentId);
  }

  async listMessages(ownerId: string, chatId: string): Promise<ChatMessage[]> {
    return this.messageQueries.listMessages(ownerId, chatId);
  }

  async listEncryptedMessages(
    ownerId: string,
    chatId: string,
  ): Promise<ChatMessageOpaqueSummary[]> {
    return this.messageQueries.listEncryptedMessages(ownerId, chatId);
  }

  async getLatestEncryptedUserMessage(
    ownerId: string,
    chatId: string,
  ): Promise<ChatMessageOpaqueSummary | null> {
    return this.messageQueries.getLatestEncryptedUserMessage(ownerId, chatId);
  }

  async trimLatestEncryptedTurn(
    ownerId: string,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.messageQueries.trimLatestEncryptedTurn(
      ownerId,
      chatId,
      messageId,
    );
  }

  async listEncryptedMessagePage(
    ownerId: string,
    chatId: string,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: ChatMessageOpaqueSummary[];
    page: ChatMessagePageInfo;
  }> {
    return this.messageQueries.listEncryptedMessagePage(ownerId, chatId, query);
  }

  async listAgentMessageWire(ownerId: string, chatId: string) {
    return this.messageQueries.listAgentMessageWire(ownerId, chatId);
  }

  async listTaskMessages(
    ownerId: string,
    chatId: string,
  ): Promise<TaskMessageOpaqueSummary[]> {
    return this.messageQueries.listTaskMessages(ownerId, chatId);
  }

  async listTaskMessagePage(
    ownerId: string,
    chatId: string,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: TaskMessageOpaqueSummary[];
    page: ChatMessagePageInfo;
  }> {
    return this.messageQueries.listTaskMessagePage(ownerId, chatId, query);
  }

  async listMessageHeaders(ownerId: string, chatId: string) {
    return this.messageQueries.listMessageHeaders(ownerId, chatId);
  }

  async listQueuedPrompts(
    ownerId: string,
    chatId: string,
  ): Promise<QueuedPrompt[]> {
    return this.queuedPrompts.listQueuedPrompts(ownerId, chatId);
  }

  async listEncryptedQueuedPrompts(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedQueuedPrompt[]> {
    return this.queuedPrompts.listEncryptedQueuedPrompts(ownerId, chatId);
  }

  async getEncryptedQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<EncryptedQueuedPrompt | null> {
    return this.queuedPrompts.getEncryptedQueuedPrompt(ownerId, promptId);
  }

  async createEncryptedQueuedPrompt(
    ownerId: string,
    chatId: string,
    input: QueuedPromptOpaqueContent,
    attachments: ChatAttachmentOpaqueSummary[],
  ): Promise<EncryptedQueuedPrompt | null> {
    return this.queuedPrompts.createEncryptedQueuedPrompt(
      ownerId,
      chatId,
      input,
      attachments,
    );
  }

  async replaceEncryptedQueuedPrompt(
    ownerId: string,
    promptId: string,
    input: QueuedPromptOpaqueContent,
    attachments: ChatAttachmentOpaqueSummary[],
  ): Promise<EncryptedQueuedPrompt | null> {
    return this.queuedPrompts.replaceEncryptedQueuedPrompt(
      ownerId,
      promptId,
      input,
      attachments,
    );
  }

  async getQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<QueuedPrompt | null> {
    return this.queuedPrompts.getQueuedPrompt(ownerId, promptId);
  }

  async createQueuedPrompt(
    ownerId: string,
    chatId: string,
    input: QueuedPromptCreate,
    modelId: string,
    attachments: ChatAttachmentOpaqueSummary[] = [],
  ): Promise<QueuedPrompt | null> {
    return this.queuedPrompts.createQueuedPrompt(
      ownerId,
      chatId,
      input,
      modelId,
      attachments,
    );
  }

  async updateQueuedPrompt(
    ownerId: string,
    promptId: string,
    input: QueuedPromptUpdate,
    attachments?: ChatAttachmentOpaqueSummary[],
  ): Promise<QueuedPrompt | null> {
    return this.queuedPrompts.updateQueuedPrompt(
      ownerId,
      promptId,
      input,
      attachments,
    );
  }

  async getQueuedPromptByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<QueuedPrompt | null> {
    return this.queuedPrompts.getQueuedPromptByIdempotencyKey(
      ownerId,
      chatId,
      idempotencyKey,
    );
  }

  async deleteQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<QueuedPrompt | EncryptedQueuedPrompt | null> {
    return this.queuedPrompts.deleteQueuedPrompt(ownerId, promptId);
  }

  async reorderQueuedPrompts(
    ownerId: string,
    chatId: string,
    input: QueuedPromptOrder,
  ): Promise<boolean> {
    return this.queuedPrompts.reorderQueuedPrompts(ownerId, chatId, input);
  }

  async appendMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessage | null> {
    return this.messageWrites.appendMessage(
      ownerId,
      chatId,
      input,
      attribution,
    );
  }

  async appendEncryptedMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessageOpaqueSummary | null> {
    return this.messageWrites.appendEncryptedMessage(
      ownerId,
      chatId,
      input,
      attribution,
    );
  }

  async upsertEncryptedMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessageOpaqueSummary | null> {
    return this.messageWrites.upsertEncryptedMessage(
      ownerId,
      chatId,
      input,
      attribution,
    );
  }

  async getEncryptedMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<ChatMessageOpaqueSummary | null> {
    return this.messageWrites.getEncryptedMessageByIdempotencyKey(
      ownerId,
      chatId,
      idempotencyKey,
    );
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
    return this.messageWrites.setEncryptedMessageModelRoute(
      ownerId,
      messageId,
      modelId,
      runtime,
      reasoning,
    );
  }

  async appendTaskMessage(
    ownerId: string,
    chatId: string,
    input: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<TaskMessageOpaqueSummary | null> {
    return this.messageWrites.appendTaskMessage(
      ownerId,
      chatId,
      input,
      attribution,
    );
  }

  async upsertTaskMessage(
    ownerId: string,
    chatId: string,
    input: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<TaskMessageOpaqueSummary | null> {
    return this.messageWrites.upsertTaskMessage(
      ownerId,
      chatId,
      input,
      attribution,
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
    return this.messageWrites.setTaskMessageModelRoute(
      ownerId,
      messageId,
      modelId,
      runtime,
      reasoning,
    );
  }

  async getTaskMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<TaskMessageOpaqueSummary | null> {
    return this.messageWrites.getTaskMessageByIdempotencyKey(
      ownerId,
      chatId,
      idempotencyKey,
    );
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
    return this.messageWrites.setMessageModelRoute(
      ownerId,
      messageId,
      modelId,
      runtime,
      reasoning,
    );
  }

  async upsertMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate & { idempotencyKey: string },
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessage | null> {
    return this.messageWrites.upsertMessage(
      ownerId,
      chatId,
      input,
      attribution,
    );
  }

  async getMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<ChatMessage | null> {
    return this.messageWrites.getMessageByIdempotencyKey(
      ownerId,
      chatId,
      idempotencyKey,
    );
  }
}
