import { randomUUID } from "node:crypto";

import type {
  ArchivedChatWireSummary,
  ArchivedStandaloneChatWireSummary,
  BrowserWireSummary,
  ChatExecutionLaneSummary,
  ChatWireSummary,
  CodeEditorBuild,
  CodeRuntimeStatus,
  CodeSessionSummary,
  CodeTabWireSummary,
  EncryptedBrowserCreate,
  EncryptedBrowserUpdate,
  EncryptedChatCreate,
  EncryptedCodeTabCreate,
  EncryptedCodeTabUpdate,
  EncryptedExplorerCreate,
  EncryptedExplorerPin,
  EncryptedExplorerUpdate,
  EncryptedExplorerViewStateUpdate,
  EncryptedExplorerWorktreeUpdate,
  EncryptedGithubProjectCreate,
  EncryptedManagedFolderProjectCreate,
  EncryptedMcpServerCreate,
  EncryptedMcpServerUpdate,
  EncryptedProjectViewCreate,
  EncryptedProjectViewUpdate,
  EncryptedProjectWorkspaceCreate,
  EncryptedProjectWorkspaceUpdate,
  EncryptedRemoteSurfaceCreate,
  EncryptedRemoteSurfaceUpdate,
  EncryptedStandaloneChatCreate,
  EncryptedTaskCreate,
  EncryptedTerminalCreate,
  EncryptedTerminalServiceConfiguration,
  EncryptedTerminalUpdate,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  ExecutionTargetResolution,
  ExecutionTargetWireCatalog,
  ExplorerWireSummary,
  GitManagedOperationContext,
  GitManagedOperationRecord,
  GitManagedOperationWorkerState,
  McpServerOpaqueRuntime,
  McpServerWireSummary,
  PrivateDisplayLabelOpaque,
  ProjectCloneResult,
  ProjectFolderSetupJobSummary,
  ProjectReplicaSummary,
  ProjectViewWireSummary,
  ProjectWireSummary,
  ProjectWorkspaceWireList,
  ProjectWorkspaceWireSummary,
  ProjectWorkspaceStorageContext,
  ProjectWorktreePolicyUpdate,
  ProjectWorktreeSummary,
  RemoteDesktopWireSummary,
  RemoteSurfaceStatus,
  RemoteSurfaceWireSummary,
  ResourceAudience,
  StandaloneChatRootJobSummary,
  StandaloneChatWireSummary,
  SurfacePrivateStateOpaque,
  TaskWireCreateResult,
  TerminalServiceRuntimeConfiguration,
  TerminalWireSummary,
  TunnelDestinationEndpoint,
  TunnelManagedRegistration,
  TunnelSourceEndpoint,
  TunnelUserWireCreate,
  TunnelUserWireUpdate,
  TunnelWireSummary,
  WorkerWorktreeSummary,
  WorktreeInventory,
  WorktreeSelection,
  WorktreeStatusResult,
} from "@cantrip/protocol";
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
  ProtectedTunnelContentRecord,
  TunnelContentErrorCode,
  TunnelPublicDestinationEndpoint,
  TunnelPublicSourceEndpoint,
} from "@cantrip/protocol/tunnel-content";

import type { BrowserRepository } from "./repository/browsers.js";
import type { ChatCatalogRepository } from "./repository/chat-catalog.js";
import type {
  ChatExecutionLaneRepository,
  ChatExecutionContext,
  ChatExecutionLaneContext,
  ChatExecutionLaneReleaseResult,
  ChatExecutionRecoveryContext,
  ChatWorktreeTransitionResult,
} from "./repository/chat-execution-lanes.js";
import type {
  CodeSurfaceRepository,
  CodeTabExecutionContext,
} from "./repository/code-surfaces.js";
import type {
  ExecutionTargetRepository,
  ExecutionTargetSelectorResult,
  FocusedExecutionTargetResourceKind,
} from "./repository/execution-targets.js";
import type {
  ExplorerRepository,
  ExplorerExecutionContext,
} from "./repository/explorers.js";
import type { McpRepository } from "./repository/mcp.js";
import type { PlacementRepository } from "./repository/placement.js";
import type {
  ProjectLifecycleRepository,
  GithubProjectExecutionContext,
  ProjectRemovalContext,
} from "./repository/project-lifecycle.js";
import type { ProjectViewRepository } from "./repository/project-views.js";
import type {
  ProjectRepository,
  ProjectSourceSelectionOptions,
  ProjectWorkspaceRow,
  ProjectWorktreeExecutionContext,
} from "./repository/projects.js";
import type {
  RemoteSurfaceRepository,
  RemoteSurfaceExecutionContext,
} from "./repository/remote-surfaces.js";
import type {
  RunConfigurationStateRepository,
  RunConfigurationRuntimeOperationRequest,
} from "./repository/run-configuration-state.js";
import type {
  TerminalRepository,
  TerminalExecutionContext,
} from "./repository/terminals.js";
import type {
  TunnelRepository,
  DesktopTunnelAttachmentLeaseChange,
  DesktopTunnelAttachmentStopFence,
  TunnelAttachmentAuthorization,
} from "./repository/tunnels.js";
import type {
  WorktreeLifecycleRepository,
  WorktreeRemovalBlockers,
} from "./repository/worktree-lifecycle.js";
import type {
  WorktreeStateRepository,
  ProjectObservationPathReconciliation,
  ProjectWorktreeObservationContext,
  ProjectWorktreeStatusRecord,
} from "./repository/worktree-state.js";
import { IdentityModelRepositoryFacade } from "./repository-facade-identity-model.js";

export abstract class ProjectExecutionRepositoryFacade extends IdentityModelRepositoryFacade {
  abstract readonly browsers: BrowserRepository;
  abstract readonly chatCatalog: ChatCatalogRepository;
  abstract readonly chatExecutionLanes: ChatExecutionLaneRepository;
  abstract readonly codeSurfaces: CodeSurfaceRepository;
  abstract readonly executionTargets: ExecutionTargetRepository;
  abstract readonly explorers: ExplorerRepository;
  abstract readonly mcp: McpRepository;
  abstract readonly placement: PlacementRepository;
  abstract readonly projectLifecycle: ProjectLifecycleRepository;
  abstract readonly projects: ProjectRepository;
  abstract readonly projectViews: ProjectViewRepository;
  abstract readonly remoteSurfaces: RemoteSurfaceRepository;
  abstract readonly runConfigurationState: RunConfigurationStateRepository;
  abstract readonly terminals: TerminalRepository;
  abstract readonly tunnels: TunnelRepository;
  abstract readonly worktreeLifecycle: WorktreeLifecycleRepository;
  abstract readonly worktreeState: WorktreeStateRepository;

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

  async getProjectWorkspaceStorageContext(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWorkspaceStorageContext | null> {
    return this.projects.getProjectWorkspaceStorageContext(ownerId, projectId);
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

  async createVerifiedAttachedProjectWorkspace(
    ownerId: string,
    input: EncryptedProjectWorkspaceCreate,
  ): Promise<ProjectWorkspaceWireSummary> {
    return this.projects.createVerifiedAttachedProjectWorkspace(ownerId, input);
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

  async getProjectSource(
    ownerId: string,
    projectId: string,
    options?: ProjectSourceSelectionOptions,
  ) {
    return this.projects.getProjectSource(ownerId, projectId, options);
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

  async reconcileWorkerProjectObservationPaths(
    ownerId: string,
    workerId: string,
    reconciliations: readonly ProjectObservationPathReconciliation[],
  ): Promise<number> {
    return this.worktreeState.reconcileWorkerProjectObservationPaths(
      ownerId,
      workerId,
      reconciliations,
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
  protected async browserIsOwnedBy(
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
}
