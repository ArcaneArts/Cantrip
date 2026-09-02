import type {
  AgentInteractionRequest,
  AgentInteractionRequestCreate,
  AgentInteractionRequestQuery,
  AgentInteractionResolutionCreate,
  AgentInteractionRequestWire,
  EncryptedAgentInteractionRequest,
  EncryptedAgentInteractionRequestCreate,
  EncryptedAgentInteractionResolutionCreate,
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
  ExplorerWireSummary,
  ModelConfiguration,
  EncryptedChatPlanWireState,
  PlanMode,
  OrderedIds,
  QueuedPrompt,
  QueuedPromptCreate,
  QueuedPromptOrder,
  QueuedPromptUpdate,
  ReasoningEffort,
  TerminalWireSummary,
  TaskMessageOpaqueContent,
  TaskMessageOpaqueSummary,
  ChatMessageOpaqueContent,
  ChatMessageOpaqueSummary,
  ChatComposerDraftOpaqueState,
  EncryptedChatComposerDraftWireState,
  EncryptedQueuedPrompt,
  QueuedPromptOpaqueContent,
} from "@cantrip/protocol";
import {
  type AttachmentProtectedMetadata,
  type ChatAttachmentOpaqueSummary,
} from "@cantrip/protocol/attachment-content";
import { CodeSettingsRepository } from "./code-settings.js";
import type { SecretVault } from "../security/secret-vault.js";
import { AccountResourceUsageRepository } from "./account-resource-usage.js";
import { DesktopUpdateStateRepository } from "./repository/desktop-update-state.js";
import * as schema from "./schema.js";
import { ChatImportJobRepository } from "./chat-import-jobs.js";
import { ChatRelocationJobRepository } from "./chat-relocation-jobs.js";
import { ProjectAutomationRepository } from "./project-automations.js";
import { AccountRepository } from "./repository/accounts.js";
import { ProviderAccountRepository } from "./repository/provider-accounts.js";
import { ProviderCatalogRepository } from "./repository/provider-catalog.js";
import {
  ModelRepository,
  type ModelRuntime,
} from "./repository/model-runtime.js";
import { WorkerRepository } from "./repository/workers.js";
import { TunnelRepository } from "./repository/tunnels.js";
import { McpRepository } from "./repository/mcp.js";
import { ProjectRepository } from "./repository/projects.js";
import { ProjectLifecycleRepository } from "./repository/project-lifecycle.js";
import { PlacementRepository } from "./repository/placement.js";
import { ExecutionTargetRepository } from "./repository/execution-targets.js";
import { WorktreeStateRepository } from "./repository/worktree-state.js";
import { RunConfigurationStateRepository } from "./repository/run-configuration-state.js";
import { WorktreeLifecycleRepository } from "./repository/worktree-lifecycle.js";
import {
  ChatExecutionLaneRepository,
  type ChatExecutionContext,
} from "./repository/chat-execution-lanes.js";
import { ChatCatalogRepository } from "./repository/chat-catalog.js";
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
import { SettingsRepository } from "./repository/settings.js";
import { TerminalRepository } from "./repository/terminals.js";
import { ExplorerRepository } from "./repository/explorers.js";
import { CodeSurfaceRepository } from "./repository/code-surfaces.js";
import { BrowserRepository } from "./repository/browsers.js";
import { RemoteSurfaceRepository } from "./repository/remote-surfaces.js";
import { ProjectViewRepository } from "./repository/project-views.js";
import { TelemetryRepository } from "./repository/telemetry.js";
import { toISOString, type RepositoryDatabase } from "./repository/database.js";
import { ProjectFolderSetupJobRepository } from "./project-folder-setup-jobs.js";
import { StandaloneChatRootJobRepository } from "./standalone-chat-root-jobs.js";
import { ProjectGithubConversionJobRepository } from "./project-github-conversion-jobs.js";
import { EncryptionRegistryRepository } from "./encryption-registry.js";
import { PolicyRepository } from "./policies.js";
import { ProjectReplicaJobRepository } from "./project-replica-jobs.js";
import { TaskRepository } from "./tasks.js";
import { TaskSchedulingRepository } from "./task-scheduling.js";
import { TaskDispatchRepository } from "./task-dispatch.js";
import { WorkflowRunRepository } from "./workflow-runs.js";
import { WorkflowRepository } from "./workflows.js";
import { WorkflowTriggerRepository } from "./workflow-triggers.js";
import { ProjectTabLayoutRepository } from "./tab-layouts.js";
import { WorkspaceRepositoryDiscoveryJobRepository } from "./workspace-repository-discovery-jobs.js";
import { ProjectExecutionRepositoryFacade } from "./repository-facade-project-execution.js";

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
export {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_ROUTE_ID,
  DEFAULT_OLLAMA_PROVIDER_ID,
} from "./repository/settings.js";
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

export class ServerRepository extends ProjectExecutionRepositoryFacade {
  readonly accounts: AccountRepository;
  readonly accountResourceUsage: AccountResourceUsageRepository;
  readonly desktopUpdateState: DesktopUpdateStateRepository;
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
  readonly settings: SettingsRepository;
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
  readonly workspaceRepositoryDiscoveryJobs: WorkspaceRepositoryDiscoveryJobRepository;
  readonly standaloneChatRootJobs: StandaloneChatRootJobRepository;
  readonly projectGithubConversionJobs: ProjectGithubConversionJobRepository;
  readonly tabLayouts: ProjectTabLayoutRepository;
  readonly workflows: WorkflowRepository;
  readonly workflowRuns: WorkflowRunRepository;
  readonly workflowTriggers: WorkflowTriggerRepository;

  constructor(database: RepositoryDatabase, secretVault: SecretVault) {
    super();
    // Retained in the constructor while unrelated server-owned credentials
    // finish moving out of this repository. Provider and MCP payloads never
    // use this server key.
    void secretVault;
    this.accountResourceUsage = new AccountResourceUsageRepository(database);
    this.desktopUpdateState = new DesktopUpdateStateRepository(database);
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
        this.tabLayouts.nextProjectTabPosition(projectId),
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
        this.tabLayouts.nextProjectTabPosition(projectId),
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
        this.tabLayouts.nextProjectTabPosition(projectId),
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
        this.tabLayouts.nextProjectTabPosition(projectId),
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
        this.tabLayouts.nextProjectTabPosition(projectId),
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
        this.tabLayouts.nextProjectTabPosition(projectId),
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
    this.settings = new SettingsRepository(database, {
      getAgentTimeAnalytics: (ownerId) => this.getAgentTimeAnalytics(ownerId),
      getModelRuntime: (ownerId, modelId) =>
        this.getModelRuntime(ownerId, modelId),
      getSettings: (ownerId) => this.getSettings(ownerId),
      getUserSettings: (ownerId) => this.getUserSettings(ownerId),
      getWorker: (ownerId, workerId) => this.getWorker(ownerId, workerId),
    });
    this.projectViews = new ProjectViewRepository(database, {
      getProjectSource: (ownerId, projectId) =>
        this.getProjectSource(ownerId, projectId),
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
      nextProjectTabPosition: (projectId) =>
        this.tabLayouts.nextProjectTabPosition(projectId),
    });
    this.remoteSurfaces = new RemoteSurfaceRepository(database, {
      getRemoteDesktop: (ownerId, desktopId) =>
        this.getRemoteDesktop(ownerId, desktopId),
      getRemoteSurfaceExecutionContext: (ownerId, surfaceId) =>
        this.getRemoteSurfaceExecutionContext(ownerId, surfaceId),
      nextProjectTabPosition: (projectId) =>
        this.tabLayouts.nextProjectTabPosition(projectId),
    });
    this.browsers = new BrowserRepository(database, {
      getProjectSource: (ownerId, projectId) =>
        this.getProjectSource(ownerId, projectId),
      getRemoteSurfaceExecutionContext: (ownerId, surfaceId) =>
        this.getRemoteSurfaceExecutionContext(ownerId, surfaceId),
      nextProjectTabPosition: (projectId) =>
        this.tabLayouts.nextProjectTabPosition(projectId),
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
    this.workspaceRepositoryDiscoveryJobs =
      new WorkspaceRepositoryDiscoveryJobRepository(database);
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
      getProjectWorkspaceStorageContext: (ownerId, projectId) =>
        this.getProjectWorkspaceStorageContext(ownerId, projectId),
      listProjectReplicas: (ownerId, projectId) =>
        this.listProjectReplicas(ownerId, projectId),
    });
    this.workflows = new WorkflowRepository(database);
    this.workflowRuns = new WorkflowRunRepository(database);
    this.workflowTriggers = new WorkflowTriggerRepository(database);
    this.tabLayouts = new ProjectTabLayoutRepository(database);
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
    return this.tabLayouts.reorderProjects(ownerId, input);
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
