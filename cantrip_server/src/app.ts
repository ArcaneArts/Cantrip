import { randomBytes, randomUUID } from "node:crypto";
import {
  encryptedBrowserUpdateSchema,
  chatMessageCreateSchema,
  chatMessageListSchema,
  chatPromptSteerResultSchema,
  chatPromptSubmitResultSchema,
  chatTurnCreateSchema,
  explorerCodeAttachmentCreateSchema,
  gitManagedOperationWorkerStateSchema,
  gitRelativePathSchema,
  orderedIdsSchema,
  queuedPromptCreateSchema,
  queuedPromptListSchema,
  queuedPromptSchema,
  queuedPromptUpdateSchema,
  tunnelWireSummarySchema,
} from "@cantrip/protocol";
import { endpointContentOpaqueSchema } from "@cantrip/protocol/endpoint-content";
import type { GitOperationObservationState } from "@cantrip/protocol";
import { cantripVersion } from "@cantrip/version";

import { installRequestPrincipal } from "./auth/principal.js";
import { hashSecret, UserSessionService } from "./auth/service.js";
import {
  ChatThreadChangeReconciler,
  type ChatThreadChangeNotification,
} from "./chats/thread-change-reconciliation.js";
import {
  ChatTurnOutcomeRecoveryScheduler,
  chatTurnOutcomeRecoveryKey,
} from "./chats/turn-outcome-recovery.js";
import {
  type CodeAttachmentRootIdentity,
  CodeTunnelBroker,
} from "./code/tunnel.js";
import { ProjectShareTunnelBroker } from "./project-shares/tunnel.js";
import { requireProjectCapability } from "./projects/capabilities.js";
import {
  SurfacePrivateStateConflictError,
  LOCAL_USER_ID,
  ProjectWorkspaceInvariantError,
  type ChatLiveRouting,
  type ModelRuntime,
  type TunnelAttachmentAuthorization,
} from "./db/repository.js";
import { prepareRuntimesForReasoning } from "./models/reasoning.js";
import {
  WorkflowTriggerConflictError,
  WorkflowTriggerRateLimitError,
} from "./db/workflow-triggers.js";
import { WorkerUnavailableError } from "./workers/bridge.js";
import { RemoteSurfaceRelay } from "./remote-surfaces/relay.js";
import { WorktreeCreateMutationError } from "./worktrees/coordinator.js";
import { errorMessage, invalidBody } from "./http/request-helpers.js";
import {
  createAuditAppender,
  installMutationAuditHook,
} from "./app/http/audit.js";
import { installAuthenticationGuard } from "./app/http/auth-guard.js";
import { installBandwidthHooks } from "./app/http/bandwidth-hooks.js";
import { installApplicationErrorHandler } from "./app/http/error-handler.js";
import { createApplicationOwnerContext } from "./app/http/owner-context.js";
import { createRequestLimits } from "./app/http/request-limits.js";
import {
  installProjectContextGuards,
  installRemovedPlaintextRouteGuard,
} from "./app/http/route-guards.js";
import { createApplicationServer } from "./app/http/server.js";
import { installTransportSecurity } from "./app/http/transport-security.js";
import { installRemovedWorkflowGenerationRoute } from "./app/routes/api-meta-and-removed-routes.js";
import { installBrowserServiceDiscoveryRoutes } from "./app/routes/browser-service-discovery.js";
import {
  installBrowserListRoute,
  installBrowserManagementRoutes,
} from "./app/routes/browser-management.js";
import { installAgentInteractionRoutes } from "./app/routes/agent-interactions.js";
import { installChatRelocationRoutes } from "./app/routes/chat-relocations.js";
import { installPolicyRoutes } from "./app/routes/policies.js";
import { installProjectAutomationRoutes } from "./app/routes/project-automations.js";
import { installProjectCatalogAndPlacementRoutes } from "./app/routes/project-catalog-and-placement.js";
import {
  installCodeTabManagementRoutes,
  installCodeTabSessionListRoute,
} from "./app/routes/code-tab-management.js";
import { installChatBasicRoutes } from "./app/routes/chat-basic-routes.js";
import { installProjectChatCatalogRoutes } from "./app/routes/chat-catalogs.js";
import { installChatArchiveLifecycleRoutes } from "./app/routes/chat-archive-lifecycle.js";
import { installChatForkRoute } from "./app/routes/chat-forks.js";
import { installChatExecutionControlRoutes } from "./app/routes/chat-execution-control.js";
import { installChatAutomationPauseRoute } from "./app/routes/chat-automation-pause.js";
import { installChatPlanRoutes } from "./app/routes/chat-plan.js";
import { installChatGoalRoutes } from "./app/routes/chat-goals.js";
import { installChatCustomizationRoutes } from "./app/routes/chat-customizations.js";
import {
  installChatMessageCreateRoute,
  installChatSyncAndMessageReadRoutes,
} from "./app/routes/chat-messages-and-sync.js";
import { installChatAttachmentRoutes } from "./app/routes/chat-attachments.js";
import { installChatRuntimeConfigurationRoutes } from "./app/routes/chat-runtime-configuration.js";
import { installChatQueueRoutes } from "./app/routes/chat-queue.js";
import { installChatTurnSubmissionRoutes } from "./app/routes/chat-turn-submission.js";
import { installChatImportRoutes } from "./app/routes/chat-imports.js";
import { installInternalWorkerAutomationRoutes } from "./app/routes/internal-worker-automations.js";
import { installInternalAgentToolRoutes } from "./app/routes/internal-agent-tools.js";
import { installInternalWorkerHttpControlRoutes } from "./app/routes/internal-worker-http-control.js";
import { installInternalWorkerWebsocketRoute } from "./app/routes/internal-worker-websocket.js";
import { installLiveRoute } from "./app/routes/live.js";
import { installWorkerEnrollmentRoute } from "./app/routes/worker-enrollment.js";
import { installChatWorktreeAndExecutionLaneRoutes } from "./app/routes/chat-worktree-and-execution-lanes.js";
import {
  installCodeTabRuntimeReadRoute,
  installCodeTabWorkerControlRoutes,
} from "./app/routes/code-tab-worker-controls.js";
import {
  installCodeTabDeleteRoute,
  installCodeTabProtectedAttachmentRoutes,
  installCodeTabWorktreeRoute,
} from "./app/routes/code-tab-attachments.js";
import { installProjectExportRoutes } from "./app/routes/project-exports.js";
import { installProjectExternalChatHistoryRoute } from "./app/routes/project-external-chat-history.js";
import { installGithubRepositoryCatalogRoutes } from "./app/routes/github-repository-catalog.js";
import { installProjectFolderSetupRoutes } from "./app/routes/project-folder-setup.js";
import { installProjectGitActionAndHistoryRoutes } from "./app/routes/project-git-actions-and-history.js";
import { installProjectGitStatusAndActionRoutes } from "./app/routes/project-git-status-and-actions.js";
import { installProjectGithubContentRoutes } from "./app/routes/project-github-content.js";
import { installProjectGithubConversionRoutes } from "./app/routes/project-github-conversion.js";
import { installProjectGithubImportRoute } from "./app/routes/project-github-import.js";
import { installProjectMcpServerRoutes } from "./app/routes/project-mcp-servers.js";
import { installProviderAccountAuthRoutes } from "./app/routes/provider-account-auth.js";
import { installProjectNetworkShareRoutes } from "./app/routes/project-network-shares.js";
import { installProjectRemovalRoute } from "./app/routes/project-removal.js";
import { installProjectReplicaRoutes } from "./app/routes/project-replicas.js";
import { installProjectViewRoutes } from "./app/routes/project-views.js";
import {
  installExplorerBasicManagementRoutes,
  installExplorerListRoute,
  installExplorerViewStateRoute,
} from "./app/routes/explorer-management.js";
import {
  installExplorerDeleteRoute,
  installExplorerOperationRoute,
  installExplorerWorktreeRoute,
} from "./app/routes/explorer-runtime.js";
import { installExplorerProtectedCodeAttachmentRoute } from "./app/routes/explorer-protected-code-attachments.js";
import { installSharedCodeSessionAttachmentRoutes } from "./app/routes/shared-code-session-attachments.js";
import { installTerminalDirectAttachmentRoute } from "./app/routes/terminal-direct-attachments.js";
import { installTerminalRelayWebSocketRoute } from "./app/routes/terminal-relay-websocket.js";
import { installWorkerLinkObservationGrantRoute } from "./app/routes/worker-link-observation-grants.js";
import { installWorkerLinkRemoteSurfaceGrantRoute } from "./app/routes/worker-link-remote-surface-grants.js";
import { installWorkerLinkTerminalGrantRoute } from "./app/routes/worker-link-terminal-grants.js";
import { installWorkerLinkTunnelAttachmentGrantRoute } from "./app/routes/worker-link-tunnel-attachment-grants.js";
import { installRemoteDesktopReadRoutes } from "./app/routes/remote-desktop-read.js";
import { installRemoteDesktopManagementRoutes } from "./app/routes/remote-desktop-management.js";
import { installRemoteSurfaceManagementRoutes } from "./app/routes/remote-surface-management.js";
import { installRemoteSurfaceConnectionRoute } from "./app/routes/remote-surface-connection.js";
import {
  installProjectInsightRoutes,
  installProjectOrderRoute,
  installProjectPreferenceRoutes,
} from "./app/routes/project-settings-and-insights.js";
import { installProjectWorkspaceRoutes } from "./app/routes/project-workspaces.js";
import { installProjectWorktreeStatusRoute } from "./app/routes/project-worktree-status.js";
import { installProjectWorktreeRoutes } from "./app/routes/project-worktrees.js";
import { installProjectWorktreeGitCommitActionRoutes } from "./app/routes/project-worktree-git-commit-actions.js";
import { installProjectWorktreeGitCommitSignatureRoute } from "./app/routes/project-worktree-git-commit-signature.js";
import { installProjectWorktreeGitHistoryAndGraphRoutes } from "./app/routes/project-worktree-git-history-and-graph.js";
import { installProjectWorktreeGitInspectionAndRecoveryRoutes } from "./app/routes/project-worktree-git-inspection-and-recovery.js";
import { installProjectWorktreeGitManagedOperationRoutes } from "./app/routes/project-worktree-git-managed-operations.js";
import { installProjectWorktreeGitPublishingRoutes } from "./app/routes/project-worktree-git-publishing.js";
import { installProjectWorktreeGitResourceRoutes } from "./app/routes/project-worktree-git-resources.js";
import { installProjectWorktreeGitRevisionAndPatchRoutes } from "./app/routes/project-worktree-git-revisions-and-patches.js";
import { installProjectWorktreeGitStashRoutes } from "./app/routes/project-worktree-git-stashes.js";
import { installProjectWorktreePullRequestRoutes } from "./app/routes/project-worktree-pull-requests.js";
import { installRunConfigurationSecretRoutes } from "./app/routes/run-configuration-secrets.js";
import { installTabLayoutRoutes } from "./app/routes/tab-layouts.js";
import {
  installTerminalCreateRoute,
  installTerminalListRoute,
  installTerminalManagementRoutes,
} from "./app/routes/terminal-management.js";
import {
  installChatLinkedConsoleRoute,
  installProtectedScriptCommandRoutes,
  installTerminalWorktreeLifecycleRoutes,
} from "./app/routes/terminal-context.js";
import { installWorkflowDefinitionRoutes } from "./app/routes/workflow-definitions.js";
import { installWorkflowRunRoutes } from "./app/routes/workflow-runs.js";
import { installWorkflowTriggerDeliveryRoutes } from "./app/routes/workflow-trigger-delivery.js";
import { installWorkflowTriggerManagementRoutes } from "./app/routes/workflow-trigger-management.js";
import { CliCommandRequestError } from "./agent-tools/errors.js";
import { encodedFrameBytes } from "./account-usage/frame-bandwidth.js";
import { WorkerLinkCoordinator } from "./worker-links/coordinator.js";
import { WorkerLinkRelay } from "./worker-links/relay.js";
import { WorkerLinkService } from "./worker-links/service.js";
import { isAccountProviderKind } from "./models/account-provider.js";
import { persistProviderQuotaSnapshot } from "./models/provider-quota.js";
import type { BuildAppOptions } from "./app/options.js";
import { createAgentOperationRuntime } from "./app/runtime/agent-operation-runtime.js";
import { createApplicationServiceFoundation } from "./app/runtime/application-service-foundation.js";
import { createBackgroundJobRuntime } from "./app/runtime/background-job-runtime.js";
import { createChatRecoveryRuntime } from "./app/runtime/chat-recovery-runtime.js";
import { createChatThreadSyncRuntime } from "./app/runtime/chat-thread-sync-runtime.js";
import { createChatTurnRuntime } from "./app/runtime/chat-turn-runtime.js";
import { createCliOperationRuntime } from "./app/runtime/cli-operation-runtime.js";
import { createDirectAttachmentRuntime } from "./app/runtime/direct-attachment-runtime.js";
import { createLiveInfrastructureRuntime } from "./app/runtime/live-infrastructure-runtime.js";
import { createLiveMutationRuntime } from "./app/runtime/live-mutation-runtime.js";
import { createInteractiveSurfaceRuntime } from "./app/runtime/interactive-surface-runtime.js";
import { createModelRoutingRuntime } from "./app/runtime/model-routing-runtime.js";
import { createTaskGoalRuntime } from "./app/runtime/task-goal-runtime.js";
import { createSessionSocketRuntime } from "./app/runtime/session-socket-runtime.js";
import {
  createRunConfigurationRuntime,
  type ExecutionOperationContext,
} from "./app/runtime/run-configuration-runtime.js";
import { installSettingsRouteRuntime } from "./app/runtime/settings-routes.js";
import { installTaskRouteRuntime } from "./app/runtime/task-routes.js";
import { createTunnelControlPlaneRuntime } from "./app/runtime/tunnel-control-plane-runtime.js";
import { createWorkerNotificationRuntime } from "./app/runtime/worker-notification-runtime.js";
import { createWorkerObservationPublicationRuntime } from "./app/runtime/worker-observation-publication-runtime.js";
import { createWorkflowSchedulingRuntime } from "./app/runtime/workflow-scheduling-runtime.js";
import {
  AGENT_INTERACTION_EXPIRY_SWEEP_MS,
  ATTACHMENT_CHUNK_BYTES,
  FINITE_WORKER_COMMAND_TIMEOUT_MS,
  WORKFLOW_GATE_EXPIRY_SWEEP_MS,
} from "./app/shared/constants.js";
import { ProviderAccountReconnectRequiredError } from "./app/shared/errors.js";
import { installMutationLiveInvalidationHook } from "./app/http/mutation-live-invalidation.js";
import { installCoreInfrastructureRoutes } from "./app/routes/core-infrastructure-registry.js";

export type { BuildAppOptions } from "./app/options.js";
export { mutationLiveResources } from "./app/shared/live-resources.js";

export async function buildApp({
  config,
  codeTunnel: providedCodeTunnel,
  database,
  logger = true,
  projectShareTunnel: providedProjectShareTunnel,
  providerCatalogService: providedProviderCatalogService,
  providerCredentialMigrations: providedProviderCredentialMigrations,
  relayQuotas: providedRelayQuotas,
  coordinator,
  workerBridge,
}: BuildAppOptions) {
  const {
    app,
    encryptedAttachmentUploadLimitBytes,
    uploadLimitBytes,
    websocketMaxPayloadBytes,
  } = createApplicationServer(config, logger);
  const repository = database.repository;
  const requireProjectWorktrees = async (projectId: string) => {
    const project = await repository.getProject(
      applicationOwnerId(),
      projectId,
    );
    if (project) requireProjectCapability(project, "worktrees");
    return project;
  };
  const requireProjectRelocation = async (projectId: string) => {
    const project = await repository.getProject(
      applicationOwnerId(),
      projectId,
    );
    if (project) requireProjectCapability(project, "relocation");
    return project;
  };
  const applicationServiceFoundation = createApplicationServiceFoundation({
    app,
    applicationOwnerId: () => applicationOwnerId(),
    config,
    coordinator,
    providedProviderCatalogService,
    providedProviderCredentialMigrations,
    providedRelayQuotas,
    repository,
    workerBridge,
  });
  const {
    accountUsageMeter,
    bridge,
    chatGptCatalogService,
    coordinationStats,
    grokCatalogService,
    licenseWhitelistConfigured,
    licenseWhitelistEnabled,
    normalizedAdminEmail,
    ollamaCatalogService,
    openRouterRuntimeCatalogs,
    operationalMetrics,
    providerAccountLifecycle,
    providerCatalogService,
    providerCredentialMigrations,
    rawBridge,
    relayQuotas,
    zaiCatalogService,
  } = applicationServiceFoundation;
  const directAttachmentRuntime = createDirectAttachmentRuntime({
    bridge,
    repository,
  });
  const { directAttachments } = directAttachmentRuntime;
  const revokedWorkerCredentialIds = new Set<string>();
  const codeTunnel = providedCodeTunnel ?? new CodeTunnelBroker(bridge);
  const projectShareTunnel =
    providedProjectShareTunnel ?? new ProjectShareTunnelBroker(bridge);
  const surfaceRelay = new RemoteSurfaceRelay(
    bridge,
    (ownerId, workerId, bytes) =>
      relayQuotas.consumeRelay(ownerId, workerId, bytes),
    accountUsageMeter,
  );
  const applicationOwnerContext = createApplicationOwnerContext(
    config.authMode,
  );
  const { applicationOwnerId, runAsOwner } = applicationOwnerContext;
  const workerOwnerId = (workerId: string): Promise<string | null> =>
    repository.getWorkerOwnerId(workerId);
  const serverInstanceId = config.serverInstanceId ?? "local-single-instance";
  const serverControlPlaneGeneration = randomUUID();
  const schedulerLeaseTtlMs = config.schedulerLeaseTtlMs ?? 120_000;
  const liveInfrastructureRuntime = createLiveInfrastructureRuntime({
    accountUsageMeter,
    app,
    applicationOwnerId,
    config,
    coordinator,
    repository,
    runAsOwner,
    serverInstanceId,
    setPublishAccountResourceUsageChange:
      applicationServiceFoundation.setPublishAccountResourceUsageChange,
  });
  const {
    isLivePublishingEnabled,
    liveHub,
    publishLiveInvalidation,
    publishProjectTokenUsageChange,
    storageReconciler,
    taskLiveInvalidationRouter,
    usageHistoryMaintenance,
  } = liveInfrastructureRuntime;
  const tunnelControlPlaneRuntime = createTunnelControlPlaneRuntime({
    accountUsageMeter,
    app,
    bridge,
    codeTunnel,
    directAttachments,
    projectShareTunnel,
    publishLiveInvalidation,
    relayQuotas,
    repository,
    runAsOwner,
    setPublishDirectTunnelLeaseChange:
      directAttachmentRuntime.setPublishDirectTunnelLeaseChange,
  });
  const { publishTunnelRuntimeChange, revokeManagedFileShare, tunnelRuntime } =
    tunnelControlPlaneRuntime;
  const chatTurnOutcomeRecoveryScheduler =
    new ChatTurnOutcomeRecoveryScheduler();
  const chatThreadChangeReconciler = new ChatThreadChangeReconciler(
    (error, key) => {
      app.log.warn(
        { err: error, observationKey: key },
        "Could not reconcile an observed Codex thread change",
      );
    },
  );
  let reconcileObservedChatThread: (
    chatId: string,
    workerId: string,
    threadId: string,
    changes: ChatThreadChangeNotification["changes"],
  ) => Promise<void> = async () => undefined;
  const cancelChatTurnOutcomeRecovery = (
    workerId: string,
    chatId: string,
    clientMessageId: string,
  ): void => {
    const key = chatTurnOutcomeRecoveryKey(workerId, chatId, clientMessageId);
    chatTurnOutcomeRecoveryScheduler.settle(key);
  };
  const {
    activeProviderAuthObservation,
    activeProviderAuthObservations,
    gitOperationRequestRuntime,
    publishCodeGraphStatus,
    publishGitConflicts,
    publishGitOperation,
    publishProviderAuthStatus,
    recordLiveWorktreeStatus,
    removeProviderAuthObservations,
  } = createWorkerObservationPublicationRuntime({
    app,
    applicationOwnerId,
    isLivePublishingEnabled,
    liveHub,
    publishLiveInvalidation,
    repository,
  });
  const workerNotificationRuntime = createWorkerNotificationRuntime({
    activeProviderAuthObservations,
    app,
    applicationOwnerId,
    bridge,
    chatThreadChangeReconciler,
    chatTurnOutcomeRecoveryScheduler,
    loadProviderCatalog: (...args) => loadProviderCatalog(...args),
    providerCredentialMigrations,
    publishCodeGraphStatus,
    publishGitConflicts,
    publishGitOperation,
    publishLiveInvalidation,
    publishProviderAuthStatus,
    reconcileObservedChatThread: (...args) =>
      reconcileObservedChatThread(...args),
    recordLiveWorktreeStatus,
    recoverChatTurnOutcome: (...args) => recoverChatTurnOutcome(...args),
    repository,
    resolveAccountAuthTarget: (...args) => resolveAccountAuthTarget(...args),
    runAsOwner,
    serverId: () => serverId,
    updateTerminalStatus: (...args) => updateTerminalStatus(...args),
    worktreeCoordinator: {
      serialize: (projectId, operation) =>
        worktreeCoordinator.serialize(projectId, operation),
    },
  });
  const {
    ensureWorkerNotificationSubscription,
    reconcileRunConfigurationRuntimesForWorker,
    scheduleProjectWorktreeObservation,
    scheduleWorkerWorktreeObservation,
  } = workerNotificationRuntime;
  const {
    appendLiveChatMessage,
    appendLiveEncryptedChatMessage,
    appendLiveTaskMessage,
    deleteLiveQueuedPrompt,
    expireLiveAgentInteractionRequests,
    interruptLiveAgentInteractionRequests,
    publishChatInvalidation,
    publishChatSummary,
    publishChatTurnBoundary,
    publishInferenceProgress,
    publishProjectAutomationChange,
    publishWorkflowDefinitionChange,
    publishWorkflowTriggerChange,
    recordLiveAgentInteractionRequest,
    recordLiveEncryptedAgentInteractionRequest,
    reorderLiveQueuedPrompts,
    resolveLiveAgentInteractionRequest,
    resolveLiveEncryptedAgentInteractionRequest,
    setLiveChatMessageModelRoute,
    setLiveEncryptedChatMessageModelRoute,
    setLiveTaskMessageModelRoute,
    taskMessageServerStub,
    terminalizeLiveAgentInteractionRequest,
    updateLiveChatPlanMode,
    updateLiveEncryptedChatPlanState,
    upsertLiveChatMessage,
    upsertLiveEncryptedChatMessage,
    upsertLiveTaskMessage,
  } = createLiveMutationRuntime({
    app,
    applicationOwnerId,
    bridge,
    liveHub,
    livePublishingEnabled: isLivePublishingEnabled,
    publishLiveInvalidation,
    publishWorkflowRunChange: (change) => publishWorkflowRunChange(change),
    repository,
    taskLiveInvalidationRouter,
  });
  const {
    chatImportJobExecutor,
    chatRelocationJobExecutor,
    projectFolderSetupJobExecutor,
    projectGithubConversionJobExecutor,
    projectReplicaJobExecutor,
    publishChatImportChange,
    publishChatRelocationChange,
    publishProjectFolderSetupChange,
    publishProjectGithubConversionChange,
    publishProjectReplicaJobChange,
    publishStandaloneChatRootJobChange,
    publishWorkflowRunChange,
    standaloneChatRootJobExecutor,
    workflowExecutor,
    worktreeCoordinator,
  } = createBackgroundJobRuntime({
    app,
    applicationOwnerId,
    bridge,
    liveHub,
    livePublishingEnabled: isLivePublishingEnabled,
    publishLiveInvalidation,
    repository,
    runAsOwner,
    scheduleProjectWorktreeObservation,
    scheduleWorkerWorktreeObservation,
  });
  if (
    config.deploymentMode === "hosted" &&
    config.authMode === "accounts" &&
    !licenseWhitelistConfigured &&
    !config.publicRegistration &&
    !config.adminBootstrapToken &&
    (await repository.countAccountUsers()) === 0
  ) {
    throw new Error(
      "A new hosted account server with public registration disabled requires CANTRIP_ADMIN_BOOTSTRAP_TOKEN.",
    );
  }
  if (
    config.authMode === "accounts" &&
    licenseWhitelistEnabled &&
    !normalizedAdminEmail
  ) {
    throw new Error(
      "Account license whitelisting requires a configured administrator email.",
    );
  }
  const [serverId, localUser] = await Promise.all([
    repository.getOrCreateServerId(),
    config.authMode === "accounts"
      ? Promise.resolve(null)
      : repository.ensureLocalIdentity(),
  ]);
  const workerLinks = new WorkerLinkService(
    new WorkerLinkCoordinator(bridge, {
      peerConfiguration: config.workerLinkPeer,
      serverId,
      serverGeneration: serverControlPlaneGeneration,
    }),
    coordinator,
  );
  const workerLinkRelay = new WorkerLinkRelay(bridge, {
    acquireRemoteSurface: (ownerId, workerId) =>
      relayQuotas.acquireRemoteSurface(ownerId, workerId),
    consumeRelayBytes: (ownerId, workerId, bytes) =>
      relayQuotas.consumeRelay(ownerId, workerId, bytes),
    ...(config.workerLinkPeer?.laneLimits
      ? { laneLimits: config.workerLinkPeer.laneLimits }
      : {}),
    usageRecorder: accountUsageMeter,
  });
  const unsubscribeWorkerLinkRelayRevocations =
    workerLinks.subscribeRelayRevocations((scope) => {
      switch (scope.kind) {
        case "session":
          workerLinkRelay.revokeSession(scope.sessionId);
          return;
        case "account-session":
          workerLinkRelay.revokeAccountSession(scope.accountSessionId);
          return;
        case "owner":
          workerLinkRelay.revokeOwner(scope.ownerId);
      }
    });
  const authorizedCodeAttachmentRootIdentity = (
    authorization: Pick<
      TunnelAttachmentAuthorization,
      "destination" | "origin" | "ownerId" | "protectedRecord" | "tunnelId"
    >,
    authSessionId: string | null,
  ): CodeAttachmentRootIdentity | null => {
    if (authorization.origin !== "code") return null;
    return {
      authSessionId,
      ownerId: authorization.ownerId,
      protectedKeyRevision:
        authorization.protectedRecord.protectedContent.keyRevision,
      rootAttachmentId: authorization.tunnelId,
      serverId,
      tunnelId: authorization.tunnelId,
      workerId: authorization.destination.workerId,
    };
  };
  const acquireAuthorizedCodeAttachmentRootLease = (
    authorization: Pick<
      TunnelAttachmentAuthorization,
      "destination" | "origin" | "ownerId" | "protectedRecord" | "tunnelId"
    >,
    authSessionId: string | null,
  ) => {
    const identity = authorizedCodeAttachmentRootIdentity(
      authorization,
      authSessionId,
    );
    if (!identity) return { lease: null, managed: false } as const;
    const acquired = codeTunnel.acquireAttachmentRootLease(identity);
    return acquired.managed
      ? acquired
      : ({ lease: null, managed: true } as const);
  };
  if (localUser) {
    await repository.ensureAccountConfiguration(LOCAL_USER_ID);
    await repository.ensureBrowserRemoteSurfaces(LOCAL_USER_ID);
  }
  const recoverGlobalStartupState =
    !coordinator || coordinator.stats().instanceCount <= 1;
  if (recoverGlobalStartupState) {
    await repository.resetTransientRemoteSurfaceStatuses();
    await repository.resetTransientTunnelAttachments();
    await repository.resetInterruptedChatExecutions();
    await repository.tasks.reconcileInterruptedOperations();
  } else {
    app.log.info(
      { coordinationInstances: coordinator.stats().instanceCount },
      "Preserving peer-owned transient state during rolling server startup",
    );
  }
  await projectReplicaJobExecutor.recoverAfterRestart(!coordinator);
  projectReplicaJobExecutor.queueAvailable();
  projectReplicaJobExecutor.startRecoverySweep();
  await projectFolderSetupJobExecutor.recoverAfterRestart(!coordinator);
  projectFolderSetupJobExecutor.queueAvailable();
  projectFolderSetupJobExecutor.startRecoverySweep();
  await standaloneChatRootJobExecutor.recoverAfterRestart(!coordinator);
  standaloneChatRootJobExecutor.queueAvailable();
  standaloneChatRootJobExecutor.startRecoverySweep();
  await projectGithubConversionJobExecutor.recoverAfterRestart(!coordinator);
  projectGithubConversionJobExecutor.queueAvailable();
  projectGithubConversionJobExecutor.startRecoverySweep();
  await chatRelocationJobExecutor.recoverAfterRestart(!coordinator);
  chatRelocationJobExecutor.queueAvailable();
  chatRelocationJobExecutor.startRecoverySweep();
  await chatImportJobExecutor.recoverAfterRestart(!coordinator);
  chatImportJobExecutor.queueAvailable();
  chatImportJobExecutor.startRecoverySweep();
  await workflowExecutor.recoverAfterRestart(recoverGlobalStartupState);
  workflowExecutor.startRecoverySweep();
  await workflowExecutor.expireGates();
  void workflowExecutor.queueAvailableRuns().catch((error) => {
    app.log.error({ err: error }, "Could not resume queued workflow runs");
  });

  await installTransportSecurity(app, config, websocketMaxPayloadBytes);

  const sessionService = new UserSessionService(repository, config);
  const requestLimits = createRequestLimits(config);
  const { authRateLimiter, accountWebsockets, pendingWorkerHandshakes } =
    requestLimits;
  if (config.authMode === "none") {
    installRequestPrincipal(app, { authMode: "none", localUser: localUser! });
  } else {
    installRequestPrincipal(app, {
      authMode: config.authMode,
      resolve: (request) => sessionService.resolvePrincipal(request),
    });
  }

  installBandwidthHooks(app, accountUsageMeter);
  applicationOwnerContext.installRequestHook(app);

  const appendAudit = createAuditAppender(repository);
  installMutationAuditHook(app, appendAudit);

  installAuthenticationGuard(app, config, sessionService);

  installRemovedPlaintextRouteGuard(app);

  requestLimits.installHooks(app);

  installProjectContextGuards(app, repository, applicationOwnerId);

  installApplicationErrorHandler(app, sessionService);

  const sessionSocketRuntime = createSessionSocketRuntime({
    accountWebsockets,
    publishLiveInvalidation,
    repository,
    runAsOwner,
  });
  const {
    closeSessionSockets,
    registerAccountSocket,
    registerAuthenticatedSocket,
    registerSessionSocket,
    sessionSockets,
  } = sessionSocketRuntime;

  installLiveRoute(app, {
    config,
    liveHub,
    registerAccountSocket,
    registerSessionSocket,
    repository,
  });

  installMutationLiveInvalidationHook(app, {
    publishChatInvalidation,
    publishLiveInvalidation,
  });

  const routeCooldowns = new Map<string, number>();
  const runtimeCooldownKey = (runtime: ModelRuntime): string =>
    isAccountProviderKind(runtime.provider.kind) && runtime.provider.accountId
      ? `${runtime.routeId}:account:${runtime.provider.accountId}`
      : runtime.routeId;
  const interactiveSurfaceRuntime = createInteractiveSurfaceRuntime({
    bridge,
    codeTunnel,
    directAttachments,
    publishLiveInvalidation,
    repository,
    runAsOwner,
    serverId,
  });
  const {
    applyBrowserUpdate,
    codeTabWorkerRuntime,
    publishWorkerPresence,
    scheduleWorkerOfflineInvalidation,
    surfaceAttachmentCounts,
    synchronizeTerminalServicesForWorker,
    terminalServiceRuntime,
    updateCodeSessionRuntime,
    updateRemoteSurfaceStatus,
    updateTerminalStatus,
    workerPresenceFingerprints,
  } = interactiveSurfaceRuntime;
  const workflowSchedulingRuntime = createWorkflowSchedulingRuntime({
    app,
    applicationOwnerId,
    bridge,
    operationalMetrics,
    publishWorkflowRunChange,
    publishWorkflowTriggerChange,
    repository,
    runAsOwner,
    schedulerLeaseTtlMs,
    serverInstanceId,
    workflowExecutor,
  });
  const { deliverWorkflowTrigger } = workflowSchedulingRuntime;

  const agentInteractionExpiryTimer = setInterval(() => {
    void expireLiveAgentInteractionRequests().catch((error) => {
      app.log.error(
        { err: error },
        "Failed to expire pending agent interaction requests",
      );
    });
  }, AGENT_INTERACTION_EXPIRY_SWEEP_MS);
  agentInteractionExpiryTimer.unref();
  const workflowGateExpiryTimer = setInterval(() => {
    void workflowExecutor.expireGates().catch((error) => {
      app.log.error({ err: error }, "Could not expire workflow gates");
    });
  }, WORKFLOW_GATE_EXPIRY_SWEEP_MS);
  workflowGateExpiryTimer.unref();

  const agentOperationRuntime = createAgentOperationRuntime({
    applicationOwnerId,
    applyBrowserUpdate,
    bridge,
    deleteRunConfigurationDefinition: (...args) =>
      deleteRunConfigurationDefinition(...args),
    detectRunConfigurationDefinitions: (...args) =>
      detectRunConfigurationDefinitions(...args),
    getRunConfigurationDefinition: (...args) =>
      getRunConfigurationDefinition(...args),
    listRunConfigurationDefinitions: (...args) =>
      listRunConfigurationDefinitions(...args),
    liveHub,
    operateRunConfigurationRuntime: (...args) =>
      operateRunConfigurationRuntime(...args),
    publishLiveInvalidation,
    queryRunConfigurationRuntimeStatus: (...args) =>
      queryRunConfigurationRuntimeStatus(...args),
    readRunConfigurationRuntimeOutput: (...args) =>
      readRunConfigurationRuntimeOutput(...args),
    repository,
    resolvePrimaryRunConfigurationSource: (...args) =>
      resolvePrimaryRunConfigurationSource(...args),
    resolveRunConfigurationRuntimeTarget: (...args) =>
      resolveRunConfigurationRuntimeTarget(...args),
    retireRunConfigurationRuntimes: (...args) =>
      retireRunConfigurationRuntimes(...args),
    serverId,
    updateTerminalStatus,
    worktreeCoordinator,
    writeRunConfigurationDefinition: (...args) =>
      writeRunConfigurationDefinition(...args),
  });
  const { agentOperationExecutor, chatOperationContext } =
    agentOperationRuntime;

  const runConfigurationRuntime = createRunConfigurationRuntime({
    appendAudit,
    applicationOwnerId,
    bridge,
    ensureWorkerNotificationSubscription,
    publishLiveInvalidation,
    repository,
    serverId,
    updateTerminalStatus,
    worktreeCoordinator,
  });
  const {
    deleteRunConfigurationDefinition,
    detectRunConfigurationDefinitions,
    getRunConfigurationDefinition,
    listRunConfigurationDefinitions,
    operateRunConfigurationRuntime,
    queryRunConfigurationRuntimeStatus,
    readRunConfigurationRuntimeOutput,
    resolveAppRunContext,
    resolvePrimaryRunConfigurationSource,
    resolveRunConfigurationRuntimeTarget,
    retireRunConfigurationRuntimes,
    sendRunApiFailure,
    writeRunConfigurationDefinition,
  } = runConfigurationRuntime;

  const cliOperationRuntime = createCliOperationRuntime({
    agentOperationExecutor,
    applicationOwnerId,
    bridge,
    chatOperationContext,
    deleteRunConfigurationDefinition,
    detectRunConfigurationDefinitions,
    getRunConfigurationDefinition,
    listRunConfigurationDefinitions,
    liveHub,
    operateRunConfigurationRuntime,
    publishLiveInvalidation,
    queryRunConfigurationRuntimeStatus,
    readRunConfigurationRuntimeOutput,
    repository,
    resolveRunConfigurationRuntimeTarget,
    writeRunConfigurationDefinition,
  });
  const { cliCommandIsMutation, executeCliCommand } = cliOperationRuntime;
  const modelRoutingRuntime = createModelRoutingRuntime({
    app,
    applicationOwnerId,
    bridge,
    openRouterRuntimeCatalogs,
    publishProjectTokenUsageChange,
    repository,
    routeCooldowns,
    runtimeCooldownKey,
  });
  const {
    availableModelRuntimes,
    captureRuntimeQuota,
    chatCustomizationScope,
    checkedCustomizationRequest,
    checkedCustomizationResponse,
    configuredRoutePairsForDefaults,
    customizationScopesMatch,
    reasoningStateForContext,
    recordRuntimeModelBehavior,
    recordRuntimeTokenUsage,
    resolveModelId,
    routePairsForConfiguration,
    runtimeCanResumeContext,
    runtimeForContext,
    scheduleRuntimeQuotaSamples,
    sendModelConfigurationResolutionFailure,
    settingsContextFromCustomizationScope,
    settingsCustomizationScope,
    skillSettingsTarget,
  } = modelRoutingRuntime;

  const {
    continuePendingWorktreeTransition,
    dispatchNextQueuedPrompt,
    notifyCodeAgentState,
    prepareCodeEditorsForTurn,
    recoverChatTurnOutcome,
    resolvePromptAttachments,
    resumePendingWorktreeTransitionsForWorker,
  } = createChatRecoveryRuntime({
    app,
    appendLiveChatMessage,
    appendLiveEncryptedChatMessage,
    appendLiveTaskMessage,
    applicationOwnerId,
    availableModelRuntimes,
    beginTurn: (...args) => beginTurn(...args),
    bridge,
    deleteLiveQueuedPrompt,
    failTaskGoalLaunch: (...args) => failTaskGoalLaunch(...args),
    interruptLiveAgentInteractionRequests,
    launchPreparedTaskGoal: (...args) => launchPreparedTaskGoal(...args),
    publishChatInvalidation,
    publishChatTurnBoundary,
    queueTaskScheduleTick: () => queueTaskScheduleTick(),
    repository,
    resolveModelId,
    runAsOwner,
    upsertLiveChatMessage,
  });

  const { beginTurn } = createChatTurnRuntime({
    app,
    applicationOwnerId,
    appendLiveChatMessage,
    appendLiveEncryptedChatMessage,
    appendLiveTaskMessage,
    bridge,
    cancelChatTurnOutcomeRecovery,
    captureRuntimeQuota,
    continuePendingWorktreeTransition,
    dispatchNextQueuedPrompt,
    interruptLiveAgentInteractionRequests,
    notifyCodeAgentState,
    prepareCodeEditorsForTurn,
    publishChatSummary,
    publishChatTurnBoundary,
    publishInferenceProgress,
    recordLiveAgentInteractionRequest,
    recordLiveEncryptedAgentInteractionRequest,
    recordRuntimeModelBehavior,
    recordRuntimeTokenUsage,
    repository,
    resolveModelId,
    resolvePromptAttachments,
    routeCooldowns,
    routePairsForConfiguration,
    runAsOwner,
    runtimeCanResumeContext,
    runtimeCooldownKey,
    scheduleRuntimeQuotaSamples,
    setLiveChatMessageModelRoute,
    setLiveEncryptedChatMessageModelRoute,
    setLiveTaskMessageModelRoute,
    taskMessageServerStub,
    terminalizeLiveAgentInteractionRequest,
    updateLiveChatPlanMode,
    updateLiveEncryptedChatPlanState,
    upsertLiveChatMessage,
    upsertLiveEncryptedChatMessage,
    upsertLiveTaskMessage,
  });

  const taskGoalRuntime = createTaskGoalRuntime({
    app,
    applicationOwnerId,
    beginTurn,
    bridge,
    continuePendingWorktreeTransition,
    dispatchNextQueuedPrompt,
    publishChatInvalidation,
    queueTaskScheduleTick: () => queueTaskScheduleTick(),
    repository,
    resolveModelId,
    resolvePromptAttachments,
    routePairsForConfiguration,
    runtimeCanResumeContext,
    runtimeForContext,
  });
  const {
    failTaskGoalLaunch,
    launchPreparedTaskGoal,
    readEncryptedTaskGoal,
    reconcileTaskGoalDispatch,
    releaseTaskGoalLease,
    retainTaskGoalLease,
    resumeChatAutomation,
    scheduledTaskGoalTurnOptions,
    startGoalTurn,
    taskContentFromSummary,
    taskDispatchCycleLease,
    taskGoalDispatchLease,
  } = taskGoalRuntime;

  installCoreInfrastructureRoutes(app, {
    accountUsageMeter,
    acquireAuthorizedCodeAttachmentRootLease,
    appendAudit,
    applicationOwnerId,
    authRateLimiter,
    authorizedCodeAttachmentRootIdentity,
    availableModelRuntimes,
    bridge,
    closeSessionSockets,
    codeTunnel,
    config,
    coordinationStats,
    coordinator,
    database,
    directAttachments,
    licenseWhitelistConfigured,
    licenseWhitelistEnabled,
    liveHub,
    localUser,
    markCredentialRevoked: (credentialId) => {
      revokedWorkerCredentialIds.add(credentialId);
    },
    normalizedAdminEmail,
    operationalMetrics,
    publishChatSummary,
    publishLiveInvalidation,
    publishTunnelRuntimeChange,
    publishWorkerAvailability: (workerId) =>
      publishLiveInvalidation("worker-availability", { entityId: workerId }),
    recordRuntimeTokenUsage,
    registerAccountSocket,
    registerAuthenticatedSocket,
    registerSessionSocket,
    relayQuotas,
    repository,
    runAsOwner,
    serverId,
    sessionService,
    sessionSockets,
    standaloneChatRootJobExecutor,
    storageReconciler,
    synchronizeTerminalServicesForWorker,
    tunnelRuntime,
    usageHistoryMaintenance,
    workerLinkRelay,
    workerLinks,
    worktreeCoordinator,
  });

  runConfigurationRuntime.installAppRuntimeRoutes(app);

  installAgentInteractionRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
    resolveLiveAgentInteractionRequest,
    resolveLiveEncryptedAgentInteractionRequest,
    runtimeForContext,
    workflowExecutor,
  });

  const { prepareProviderAccountSignOut, resolveAccountAuthTarget } =
    installProviderAccountAuthRoutes(app, {
      activeProviderAuthObservation,
      activeProviderAuthObservations,
      applicationOwnerId,
      bridge,
      loadProviderCatalog: (...args) => loadProviderCatalog(...args),
      providerAccountLifecycle,
      providerCredentialMigrations,
      publishLiveInvalidation,
      publishProviderAuthStatus,
      removeProviderAuthObservations,
      repository,
    });
  const settingsRouteRuntime = installSettingsRouteRuntime(app, {
    applicationOwnerId,
    bridge,
    chatGptCatalogService,
    checkedCustomizationRequest,
    checkedCustomizationResponse,
    codeTunnel,
    configuredRoutePairsForDefaults,
    customizationScopesMatch,
    grokCatalogService,
    ollamaCatalogService,
    openRouterRuntimeCatalogs,
    prepareProviderAccountSignOut,
    providerAccountLifecycle,
    providerCatalogService,
    publishLiveInvalidation,
    repository,
    resolveAccountAuthTarget,
    sendModelConfigurationResolutionFailure,
    serverId,
    settingsContextFromCustomizationScope,
    settingsCustomizationScope,
    skillSettingsTarget,
    zaiCatalogService,
  });
  const {
    catalogWorkers,
    loadProviderCatalog,
    refreshWorkerScopedCatalogs,
    workerCatalogRefreshTimer,
  } = settingsRouteRuntime;

  installGithubRepositoryCatalogRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
  });

  installProjectCatalogAndPlacementRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
  });

  installProjectReplicaRoutes(app, {
    applicationOwnerId,
    bridge,
    publishProjectReplicaJobChange,
    queueProjectReplicaJobs: () => projectReplicaJobExecutor.queueAvailable(),
    repository,
  });

  installChatRelocationRoutes(app, {
    applicationOwnerId,
    isWorkerConnected: (workerId) => bridge.isConnected(workerId),
    publishChatRelocationChange,
    queueChatRelocationJobs: () => chatRelocationJobExecutor.queueAvailable(),
    repository,
    requireProjectRelocation,
  });

  installProjectAutomationRoutes(app, {
    applicationOwnerId,
    publishProjectAutomationChange,
    repository,
  });

  installProjectMcpServerRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
  });

  installProjectWorkspaceRoutes(app, {
    applicationOwnerId,
    repository,
  });

  installWorkflowTriggerManagementRoutes(app, {
    applicationOwnerId,
    publishWorkflowTriggerChange,
    repository,
  });

  installWorkflowTriggerDeliveryRoutes(app, {
    applicationOwnerId,
    deliverWorkflowTrigger,
    repository,
    runAsOwner,
  });

  installRemovedWorkflowGenerationRoute(app);

  installProjectWorktreePullRequestRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
    worktreeCoordinator,
  });

  installProjectWorktreeGitInspectionAndRecoveryRoutes(app, {
    applicationOwnerId,
    bridge,
    publishGitOperation,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    worktreeCoordinator,
  });

  installWorkflowDefinitionRoutes(app, {
    applicationOwnerId,
    publishWorkflowDefinitionChange,
    repository,
  });

  installWorkflowRunRoutes(app, {
    applicationOwnerId,
    publishWorkflowRunChange,
    repository,
    workflowExecutor,
    worktreeCoordinator,
  });

  installProjectNetworkShareRoutes(app, {
    applicationOwnerId,
    directAttachments,
    projectShareTunnel,
    repository,
    tunnelRuntime,
  });

  installProjectPreferenceRoutes(app, {
    applicationOwnerId,
    repository,
  });

  installProjectWorktreeRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
    retireRunConfigurationRuntimes,
    worktreeCoordinator,
  });

  installProjectWorktreeStatusRoute(app, {
    applicationOwnerId,
    bridge,
    recordLiveWorktreeStatus,
    repository,
  });

  installProjectWorktreeGitHistoryAndGraphRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
  });

  installProjectWorktreeGitCommitActionRoutes(app, {
    applicationOwnerId,
    bridge,
    publishGitOperation,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    scheduleWorkerWorktreeObservation,
    worktreeCoordinator,
  });

  installProjectWorktreeGitManagedOperationRoutes(app, {
    applicationOwnerId,
    bridge,
    gitOperationRequestRuntime,
    publishGitOperation,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    scheduleProjectWorktreeObservation,
    scheduleWorkerWorktreeObservation,
    worktreeCoordinator,
  });

  installProjectWorktreeGitRevisionAndPatchRoutes(app, {
    applicationOwnerId,
    bridge,
    recordLiveWorktreeStatus,
    repository,
    worktreeCoordinator,
  });

  installProjectWorktreeGitStashRoutes(app, {
    applicationOwnerId,
    bridge,
    publishGitOperation,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    scheduleWorkerWorktreeObservation,
    worktreeCoordinator,
  });

  installProjectWorktreeGitResourceRoutes(app, {
    applicationOwnerId,
    bridge,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    worktreeCoordinator,
  });

  installProjectWorktreeGitPublishingRoutes(app, {
    applicationOwnerId,
    bridge,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    scheduleProjectWorktreeObservation,
    worktreeCoordinator,
  });

  installProjectGitActionAndHistoryRoutes(app, {
    applicationOwnerId,
    bridge,
    recordLiveWorktreeStatus,
    repository,
    worktreeCoordinator,
  });

  installProjectInsightRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
  });

  installProjectGithubContentRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
    worktreeCoordinator,
  });

  installProjectGitStatusAndActionRoutes(app, {
    applicationOwnerId,
    bridge,
    recordLiveWorktreeStatus,
    repository,
  });

  installProjectOrderRoute(app, {
    applicationOwnerId,
    repository,
  });

  installProjectRemovalRoute(app, {
    applicationOwnerId,
    bridge,
    projectShareTunnel,
    repository,
    retireRunConfigurationRuntimes,
    workerLinks,
    worktreeCoordinator,
  });

  installProjectFolderSetupRoutes(app, {
    applicationOwnerId,
    publishProjectFolderSetupChange,
    queueProjectFolderSetupJobs: () =>
      projectFolderSetupJobExecutor.queueAvailable(),
    repository,
  });

  installProjectGithubConversionRoutes(app, {
    applicationOwnerId,
    bridge,
    publishProjectGithubConversionChange,
    queueProjectGithubConversionJobs: () =>
      projectGithubConversionJobExecutor.queueAvailable(),
    repository,
  });

  installProjectGithubImportRoute(app, {
    applicationOwnerId,
    publishProjectReplicaJobChange,
    queueProjectReplicaJobs: () => projectReplicaJobExecutor.queueAvailable(),
    repository,
  });

  installProjectChatCatalogRoutes(app, {
    applicationOwnerId,
    bridge,
    publishStandaloneChatRootJobChange,
    repository,
    standaloneChatRootJobExecutor,
  });

  const taskRouteRuntime = installTaskRouteRuntime(app, {
    appendLiveTaskMessage,
    applicationOwnerId,
    availableModelRuntimes,
    beginTurn,
    bridge,
    failTaskGoalLaunch,
    launchPreparedTaskGoal,
    publishChatInvalidation,
    publishChatSummary,
    publishLiveInvalidation,
    readEncryptedTaskGoal,
    releaseTaskGoalLease,
    repository,
    resolveModelId,
    retainTaskGoalLease,
    resumeChatAutomation,
    routePairsForConfiguration,
    runAsOwner,
    runtimeCanResumeContext,
    runtimeForContext,
    scheduledTaskGoalTurnOptions,
    sendModelConfigurationResolutionFailure,
    serverId,
    serverInstanceId,
    taskDispatchCycleLease,
  });
  const { queueTaskScheduleTick, taskScheduleTimer } = taskRouteRuntime;
  const terminalContextRouteDependencies = {
    applicationOwnerId,
    bridge,
    directAttachments,
    repository,
    requireProjectWorktrees,
    resolveAppRunContext,
    resolveModelId,
    runtimeCanResumeContext,
    runtimeForContext,
    sendRunApiFailure,
    serverId,
    workerLinks,
  };
  installChatLinkedConsoleRoute(app, terminalContextRouteDependencies);

  installTerminalListRoute(app, {
    applicationOwnerId,
    repository,
  });

  installRunConfigurationSecretRoutes(app, {
    appendAudit,
    applicationOwnerId,
    publishRunConfigurationInvalidation: (projectId) =>
      publishLiveInvalidation("run-configuration", {
        entityId: null,
        projectId,
      }),
    repository,
    sendRunApiFailure,
  });

  runConfigurationRuntime.installProjectRoutes(app);

  installTerminalCreateRoute(app, {
    applicationOwnerId,
    repository,
    runtime: terminalServiceRuntime,
  });

  installProtectedScriptCommandRoutes(app, terminalContextRouteDependencies);

  installTerminalManagementRoutes(app, {
    applicationOwnerId,
    repository,
    runtime: terminalServiceRuntime,
  });

  installTerminalWorktreeLifecycleRoutes(app, terminalContextRouteDependencies);

  installExplorerListRoute(app, {
    applicationOwnerId,
    repository,
  });

  installCodeTabManagementRoutes(app, {
    applicationOwnerId,
    repository,
    runtime: {
      isWorkerConnected: (workerId) => bridge.isConnected(workerId),
    },
  });

  const codeTabAttachmentRouteDependencies = {
    applicationOwnerId,
    bridge,
    codeTunnel,
    directAttachments,
    repository,
    requireProjectWorktrees,
    serverId,
    updateCodeSessionRuntime,
  };
  installCodeTabWorktreeRoute(app, codeTabAttachmentRouteDependencies);

  installCodeTabSessionListRoute(app, {
    applicationOwnerId,
    repository,
  });

  installCodeTabRuntimeReadRoute(app, {
    applicationOwnerId,
    repository,
    runtime: codeTabWorkerRuntime,
  });

  installCodeTabProtectedAttachmentRoutes(
    app,
    codeTabAttachmentRouteDependencies,
  );

  installCodeTabWorkerControlRoutes(app, {
    applicationOwnerId,
    repository,
    runtime: codeTabWorkerRuntime,
  });

  installCodeTabDeleteRoute(app, codeTabAttachmentRouteDependencies);

  installBrowserListRoute(app, {
    applicationOwnerId,
    repository,
  });

  installProjectExportRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
  });

  installProjectExternalChatHistoryRoute(app, {
    applicationOwnerId,
    bridge,
    repository,
  });

  installBrowserServiceDiscoveryRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
  });

  installBrowserManagementRoutes(app, {
    applicationOwnerId,
    applyBrowserUpdate,
    bridge,
    repository,
    tunnelRuntime,
    workerLinks,
  });

  installRemoteDesktopReadRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
    serverId,
  });

  installRemoteDesktopManagementRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
    serverId,
    updateRemoteSurfaceStatus,
  });

  installRemoteSurfaceManagementRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
    updateRemoteSurfaceStatus,
    workerLinks,
  });

  installRemoteSurfaceConnectionRoute(app, {
    accountUsageMeter,
    bridge,
    config,
    registerAuthenticatedSocket,
    registerSessionSocket,
    relayQuotas,
    repository,
    serverId,
    surfaceAttachmentCounts,
    surfaceRelay,
    updateRemoteSurfaceStatus,
  });

  installProjectViewRoutes(app, {
    applicationOwnerId,
    bridge,
    repository,
    requireProjectWorktrees,
    workerLinks,
  });

  installExplorerBasicManagementRoutes(app, {
    applicationOwnerId,
    repository,
    runtime: {
      isWorkerConnected: (workerId) => bridge.isConnected(workerId),
    },
  });

  installExplorerWorktreeRoute(app, {
    applicationOwnerId,
    lifecycle: codeTunnel,
    repository,
    requireProjectWorktrees,
  });

  installExplorerViewStateRoute(app, {
    applicationOwnerId,
    repository,
  });

  installExplorerDeleteRoute(app, {
    applicationOwnerId,
    lifecycle: codeTunnel,
    repository,
  });

  installExplorerProtectedCodeAttachmentRoute(app, {
    applicationOwnerId,
    bridge,
    codeTunnel,
    repository,
    serverId,
  });

  installSharedCodeSessionAttachmentRoutes(app, {
    bridge,
    codeTunnel,
    relayCoordinationEnabled: Boolean(coordinator),
    repository,
    serverId,
  });

  installExplorerOperationRoute(app, {
    applicationOwnerId,
    bridge,
    repository,
    serverId,
  });

  installWorkerLinkObservationGrantRoute(app, {
    bridge,
    repository,
    workerLinks,
  });

  installWorkerLinkTunnelAttachmentGrantRoute(app, {
    bridge,
    directAttachments,
    publishTunnelRuntimeChange,
    repository,
    workerLinks,
  });

  installWorkerLinkRemoteSurfaceGrantRoute(app, {
    bridge,
    repository,
    serverId,
    updateRemoteSurfaceStatus,
    workerLinks,
  });

  installWorkerLinkTerminalGrantRoute(app, {
    bridge,
    repository,
    runtimeForContext,
    serverId,
    updateTerminalStatus,
    workerLinks,
  });

  installTerminalDirectAttachmentRoute(app, {
    bridge,
    directAttachments,
    repository,
    runtimeForContext,
    serverId,
    updateTerminalStatus,
  });

  installTerminalRelayWebSocketRoute(app, {
    appOrigins: config.appOrigins,
    bridge,
    registerAuthenticatedSocket,
    registerSessionSocket,
    repository,
    runtimeForContext,
    serverId,
    updateTerminalStatus,
    usageRecorder: accountUsageMeter,
  });

  installTabLayoutRoutes(app, { applicationOwnerId, repository });

  installChatBasicRoutes(app, {
    applicationOwnerId,
    bridge,
    publishChatFilesChange: (chatId) =>
      publishLiveInvalidation("chat-files", { chatId }),
    publishChatSummary,
    repository,
    serverId,
  });

  installChatWorktreeAndExecutionLaneRoutes(app, {
    appendLiveChatMessage,
    applicationOwnerId,
    bridge,
    repository,
    requireProjectWorktrees,
  });

  installChatArchiveLifecycleRoutes(app, {
    applicationOwnerId,
    bridge,
    publishChatSummary,
    queueStandaloneChatRootJobs: () =>
      standaloneChatRootJobExecutor.queueAvailable(),
    repository,
    revokeManagedFileShare,
  });

  installChatForkRoute(app, {
    applicationOwnerId,
    bridge,
    publishChatSummary,
    queueStandaloneChatRootJobs: () =>
      standaloneChatRootJobExecutor.queueAvailable(),
    repository,
  });

  installChatExecutionControlRoutes(app, {
    applicationOwnerId,
    bridge,
    interruptLiveAgentInteractionRequests,
    repository,
    runtimeForContext,
  });

  installChatAutomationPauseRoute(app, {
    applicationOwnerId,
    bridge,
    publishChatSummary,
    repository,
    resumeChatAutomation,
  });

  installChatPlanRoutes(app, {
    applicationOwnerId,
    availableModelRuntimes,
    bridge,
    repository,
    resolveModelId,
    runtimeCanResumeContext,
    runtimeForContext,
    updateLiveChatPlanMode,
  });

  installChatGoalRoutes(app, {
    applicationOwnerId,
    beginTurn,
    bridge,
    readEncryptedTaskGoal,
    reconcileTaskGoalDispatch,
    repository,
    resolveModelId,
    retainTaskGoalLease,
    runtimeForContext,
    scheduledTaskGoalTurnOptions,
    startGoalTurn,
    taskContentFromSummary,
    taskGoalDispatchLease,
  });

  const chatThreadSyncRuntime = createChatThreadSyncRuntime({
    applicationOwnerId,
    bridge,
    continuePendingWorktreeTransition,
    dispatchNextQueuedPrompt,
    publishChatInvalidation,
    publishChatSummary,
    recordRuntimeTokenUsage,
    repository,
    runtimeForContext,
    upsertLiveChatMessage,
  });
  const { reconcileChatThread } = chatThreadSyncRuntime;
  reconcileObservedChatThread =
    chatThreadSyncRuntime.reconcileObservedChatThread;

  installChatSyncAndMessageReadRoutes(app, {
    applicationOwnerId,
    bridge,
    reconcileChatThread,
    repository,
    runtimeForContext,
  });

  installChatCustomizationRoutes(app, {
    applicationOwnerId,
    bridge,
    chatCustomizationScope,
    checkedCustomizationResponse,
    customizationScopesMatch,
    publishChatInvalidation,
    repository,
    runtimeForContext,
    serverId,
  });

  installChatMessageCreateRoute(app, {
    applicationOwnerId,
    appendLiveEncryptedChatMessage,
    repository,
  });

  installChatAttachmentRoutes(app, {
    applicationOwnerId,
    bridge,
    encryptedAttachmentUploadLimitBytes,
    relayQuotas,
    repository,
    uploadLimitBytes,
  });

  installChatRuntimeConfigurationRoutes(app, {
    applicationOwnerId,
    availableModelRuntimes,
    bridge,
    reasoningStateForContext,
    repository,
    resolveModelId,
    routePairsForConfiguration,
    runtimeForContext,
    sendModelConfigurationResolutionFailure,
  });

  installChatQueueRoutes(app, {
    appendLiveEncryptedChatMessage,
    applicationOwnerId,
    beginTurn,
    bridge,
    deleteLiveQueuedPrompt,
    dispatchNextQueuedPrompt,
    reorderLiveQueuedPrompts,
    repository,
    resolveModelId,
    resolvePromptAttachments,
    runtimeForContext,
    sendModelConfigurationResolutionFailure,
  });

  installChatTurnSubmissionRoutes(app, {
    applicationOwnerId,
    beginTurn,
    bridge,
    repository,
    resolveModelId,
    resolvePromptAttachments,
    runtimeForContext,
    sendModelConfigurationResolutionFailure,
  });

  installWorkerEnrollmentRoute(app, {
    appendAudit,
    bridge,
    publishLiveInvalidation,
    publishWorkerPresence,
    repository,
    revokedWorkerCredentialIds,
    scheduleWorkerOfflineInvalidation,
    workerPresenceFingerprints,
  });

  installInternalWorkerAutomationRoutes(app, {
    beginTurn,
    bridge,
    config,
    dispatchNextQueuedPrompt,
    publishChatInvalidation,
    publishProjectAutomationChange,
    repository,
    resolveModelId,
    runAsOwner,
    schedulerLeaseTtlMs,
    serverInstanceId,
  });

  installInternalAgentToolRoutes(app, {
    appendAudit,
    cliCommandIsMutation,
    config,
    executeAgentOperation: (context, request) =>
      agentOperationExecutor.execute(chatOperationContext(context), request),
    executeCliCommand,
    repository,
    runAsOwner,
  });

  installInternalWorkerHttpControlRoutes(app, {
    codeTunnel,
    config,
    publishWorkerPresence,
    repository,
    resumePendingWorktreeTransitionsForWorker,
    scheduleWorkerOfflineInvalidation,
    serverId,
    workflowExecutor,
  });

  installInternalWorkerWebsocketRoute(app, {
    bridge,
    catalogWorkers,
    chatImportJobExecutor,
    chatRelocationJobExecutor,
    config,
    ensureWorkerNotificationSubscription,
    pendingWorkerHandshakes,
    projectFolderSetupJobExecutor,
    projectGithubConversionJobExecutor,
    projectReplicaJobExecutor,
    providerCredentialMigrations,
    publishLiveInvalidation,
    reconcileRunConfigurationRuntimesForWorker,
    refreshWorkerScopedCatalogs,
    repository,
    resumePendingWorktreeTransitionsForWorker,
    revokedWorkerCredentialIds,
    runAsOwner,
    scheduleWorkerWorktreeObservation,
    serverControlPlaneGeneration,
    standaloneChatRootJobExecutor,
    synchronizeTerminalServicesForWorker,
    workflowExecutor,
  });

  installProjectWorktreeGitCommitSignatureRoute(app, {
    applicationOwnerId,
    bridge,
    repository,
  });

  installChatImportRoutes(app, {
    applicationOwnerId,
    bridge,
    chatImportJobExecutor,
    publishChatImportChange,
    repository,
  });

  installPolicyRoutes(app, { applicationOwnerId, repository });

  app.addHook("onClose", async () => {
    liveInfrastructureRuntime.stopPublishing();
    sessionSocketRuntime.stopValidation();
    tunnelControlPlaneRuntime.stopExpirySweep();
    closeSessionSockets(() => true, "Server is shutting down");
    clearInterval(agentInteractionExpiryTimer);
    clearInterval(workflowGateExpiryTimer);
    workflowSchedulingRuntime.close();
    clearInterval(taskScheduleTimer);
    taskGoalRuntime.close();
    clearInterval(workerCatalogRefreshTimer);
    modelRoutingRuntime.close();
    liveInfrastructureRuntime.closeProjectTokenUsageInvalidations();
    workerNotificationRuntime.close();
    chatTurnOutcomeRecoveryScheduler.clear();
    chatThreadChangeReconciler.clear();
    interactiveSurfaceRuntime.close();
    projectReplicaJobExecutor.stop();
    projectFolderSetupJobExecutor.stop();
    standaloneChatRootJobExecutor.stop();
    projectGithubConversionJobExecutor.stop();
    chatRelocationJobExecutor.stop();
    chatImportJobExecutor.stop();
    workflowExecutor.stop();
    await usageHistoryMaintenance.close();
    await storageReconciler.close();
    app.log.info(
      { live: liveHub.stats() },
      "Application live transport stopped",
    );
    liveHub.close();
    let codeTunnelCloseError: unknown;
    try {
      await codeTunnel.close();
    } catch (error) {
      codeTunnelCloseError = error;
      app.log.error(
        { err: error },
        "Cantrip Code attachment cleanup failed during shutdown",
      );
    }
    await projectShareTunnel.close();
    tunnelRuntime.close();
    await directAttachments.close();
    unsubscribeWorkerLinkRelayRevocations();
    workerLinkRelay.close();
    await workerLinks.close();
    await bridge.close();
    await accountUsageMeter.close();
    liveInfrastructureRuntime.closeAccountResourceUsageInvalidations();
    await coordinator?.close();
    await workflowSchedulingRuntime.waitForIdle();
    await taskRouteRuntime.waitForActiveTaskScheduleTick();
    await projectReplicaJobExecutor.drain();
    await projectFolderSetupJobExecutor.drain();
    await standaloneChatRootJobExecutor.drain();
    await projectGithubConversionJobExecutor.drain();
    await chatRelocationJobExecutor.drain();
    await chatImportJobExecutor.drain();
    await workflowExecutor.drain();
    await database.close();
    if (codeTunnelCloseError) throw codeTunnelCloseError;
  });

  return app;
}
