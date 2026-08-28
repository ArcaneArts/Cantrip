import { randomBytes, randomUUID } from "node:crypto";
import {
  agentThreadSyncSchema,
  agentInteractionAcceptedSchema,
  agentInteractionRequestWireListSchema,
  agentInteractionRequestQuerySchema,
  agentInteractionRequestWireSchema,
  agentInteractionResolutionWireCreateSchema,
  appLiveEventPayloadSchema,
  encryptedBrowserUpdateSchema,
  codeAttachmentCreateSchema,
  codeProtectedAttachmentCreateSchema,
  codeProtectedAttachmentIntentSchema,
  codeProtectedAttachmentWireSchema,
  codeProbeResultSchema,
  codeRuntimeStatusSchema,
  codeTabWireSummarySchema,
  providerAuthLiveStatusSchema,
  archivedChatCleanupResultSchema,
  archivedChatWireListSchema,
  encryptedChatCreateSchema,
  encryptedStandaloneChatCreateSchema,
  chatWireListSchema,
  chatMessageCreateSchema,
  chatMessageListSchema,
  chatPromptSteerResultSchema,
  chatPromptSubmitResultSchema,
  chatWireSummarySchema,
  standaloneChatWireSummarySchema,
  archivedStandaloneChatWireSummarySchema,
  chatTurnCreateSchema,
  explorerCodeAttachmentCreateSchema,
  gitConflictListSchema,
  gitManagedOperationResponseSchema,
  gitManagedOperationWorkerStateSchema,
  gitRelativePathSchema,
  gitStatusSchema,
  orderedIdsSchema,
  queuedPromptCreateSchema,
  queuedPromptListSchema,
  queuedPromptSchema,
  queuedPromptUpdateSchema,
  remoteSurfaceAttachResultSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceViewportSchema,
  tunnelWireSummarySchema,
  worktreeSelectionSchema,
} from "@cantrip/protocol";
import { endpointContentOpaqueSchema } from "@cantrip/protocol/endpoint-content";
import {
  codeSettingsProfileIdSchema,
  codeSettingsRevisionConflictSchema,
  codeSettingsStoredProfileSchema,
  codeSettingsUploadSchema,
} from "@cantrip/protocol/code-settings";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  AppLiveResource,
  AppLiveScope,
  EncryptedBrowserUpdate,
  CodeGraphProjectStatus,
  CodeRuntimeStatus,
  GitStatus,
  GitConflictList,
  GitManagedOperationRecord,
  GitOperationObservationState,
  ProviderAuthLiveStatus,
  WorkerSummary,
  WorktreeStatusResult,
} from "@cantrip/protocol";
import { cantripVersion } from "@cantrip/version";

import {
  authenticatedPrincipal,
  installRequestPrincipal,
  principalOwnerId,
} from "./auth/principal.js";
import {
  hashSecret,
  normalizeAccountEmail,
  UserSessionService,
} from "./auth/service.js";
import { scopedCodeProfileId } from "./chats/execution-helpers.js";
import { canonicalMessagesFromThreadSync } from "./chats/thread-sync.js";
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
import { TunnelRuntimeManager } from "./tunnels/runtime.js";
import { TunnelStreamBroker } from "./tunnels/broker.js";
import {
  AgentInteractionConflictError,
  ExecutionLaneConflictError,
  ExecutionPlacementUnavailableError,
  StandaloneChatPlacementUnavailableError,
  SurfacePrivateStateConflictError,
  ARCHIVED_CHAT_RETENTION_MS,
  LOCAL_USER_ID,
  ProjectWorkspaceInvariantError,
  WORKER_ONLINE_WINDOW_MS,
  type ChatExecutionContext,
  type ChatExecutionAttribution,
  type ChatLiveRouting,
  type ModelRuntime,
  type TunnelAttachmentAuthorization,
} from "./db/repository.js";
import { prepareRuntimesForReasoning } from "./models/reasoning.js";
import { CodeSettingsRevisionConflictError } from "./db/code-settings.js";
import {
  WorkflowTriggerConflictError,
  WorkflowTriggerRateLimitError,
} from "./db/workflow-triggers.js";
import { WorkerBridge, WorkerUnavailableError } from "./workers/bridge.js";
import { workerPresenceFingerprint } from "./workers/presence.js";
import { authenticateWorkerRequest } from "./workers/credentials.js";
import { RemoteSurfaceRelay } from "./remote-surfaces/relay.js";
import { createRemoteSurfaceWebRtcConfiguration } from "./remote-surfaces/webrtc.js";
import { WorktreeCreateMutationError } from "./worktrees/coordinator.js";
import { errorMessage, invalidBody } from "./http/request-helpers.js";
import {
  createAuditAppender,
  installMutationAuditHook,
} from "./app/http/audit.js";
import { installAuthenticationGuard } from "./app/http/auth-guard.js";
import { installBandwidthHooks } from "./app/http/bandwidth-hooks.js";
import { installApplicationErrorHandler } from "./app/http/error-handler.js";
import { installOperationalHooks } from "./app/http/operational-hooks.js";
import { createApplicationOwnerContext } from "./app/http/owner-context.js";
import { createRequestLimits } from "./app/http/request-limits.js";
import {
  installProjectContextGuards,
  installRemovedPlaintextRouteGuard,
} from "./app/http/route-guards.js";
import { createApplicationServer } from "./app/http/server.js";
import { installTransportSecurity } from "./app/http/transport-security.js";
import { installBrowserServiceDiscoveryRoutes } from "./app/routes/browser-service-discovery.js";
import {
  installBrowserListRoute,
  installBrowserManagementRoutes,
} from "./app/routes/browser-management.js";
import { installChatRelocationRoutes } from "./app/routes/chat-relocations.js";
import { installInternalProviderCredentialRoutes } from "./app/routes/internal-provider-credentials.js";
import { installPolicyRoutes } from "./app/routes/policies.js";
import { installProjectAutomationRoutes } from "./app/routes/project-automations.js";
import { installProjectCatalogAndPlacementRoutes } from "./app/routes/project-catalog-and-placement.js";
import {
  installCodeTabManagementRoutes,
  installCodeTabSessionListRoute,
} from "./app/routes/code-tab-management.js";
import { installChatBasicRoutes } from "./app/routes/chat-basic-routes.js";
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
import { installAuthSessionRoutes } from "./app/routes/auth-sessions.js";
import { installAccountSecurityRoutes } from "./app/routes/account-security.js";
import { installSystemStatusRoutes } from "./app/routes/system-status.js";
import { installWorkerMaintenanceRoutes } from "./app/routes/worker-maintenance.js";
import { installInternalWorkerAutomationRoutes } from "./app/routes/internal-worker-automations.js";
import { installInternalAgentToolRoutes } from "./app/routes/internal-agent-tools.js";
import { installInternalWorkerHttpControlRoutes } from "./app/routes/internal-worker-http-control.js";
import { installInternalWorkerWebsocketRoute } from "./app/routes/internal-worker-websocket.js";
import { installWorkerEnrollmentRoute } from "./app/routes/worker-enrollment.js";
import { installChatWorktreeAndExecutionLaneRoutes } from "./app/routes/chat-worktree-and-execution-lanes.js";
import {
  installCodeTabRuntimeReadRoute,
  installCodeTabWorkerControlRoutes,
  type CodeTabWorkerRuntime,
} from "./app/routes/code-tab-worker-controls.js";
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
import { installWorkerLinkSessionRoutes } from "./app/routes/worker-link-sessions.js";
import { installWorkerLinkTerminalGrantRoute } from "./app/routes/worker-link-terminal-grants.js";
import { installWorkerLinkTunnelAttachmentGrantRoute } from "./app/routes/worker-link-tunnel-attachment-grants.js";
import { installRemoteDesktopReadRoutes } from "./app/routes/remote-desktop-read.js";
import { installRemoteDesktopManagementRoutes } from "./app/routes/remote-desktop-management.js";
import { installRemoteSurfaceManagementRoutes } from "./app/routes/remote-surface-management.js";
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
import { installRepositoryOperationRoutes } from "./app/routes/repository-operations.js";
import { installWorkerLogRoutes } from "./app/routes/worker-logs.js";
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
import { installDirectAttachmentControlRoutes } from "./app/routes/direct-attachment-control.js";
import {
  installTunnelListRoute,
  installTunnelMutationRoutes,
  installTunnelReadAndCreateRoutes,
} from "./app/routes/tunnel-management.js";
import { installTunnelAttachmentRoutes } from "./app/routes/tunnel-attachments.js";
import { installWorkerCatalogRoutes } from "./app/routes/worker-catalog.js";
import { installWorkerCredentialRoutes } from "./app/routes/worker-credentials.js";
import { installWorkerEnrollmentCodeRoutes } from "./app/routes/worker-enrollment-codes.js";
import { installWorkerManagementRoutes } from "./app/routes/worker-management.js";
import { installWorkflowDefinitionRoutes } from "./app/routes/workflow-definitions.js";
import { installWorkflowRunRoutes } from "./app/routes/workflow-runs.js";
import { installWorkflowTriggerDeliveryRoutes } from "./app/routes/workflow-trigger-delivery.js";
import { installWorkflowTriggerManagementRoutes } from "./app/routes/workflow-trigger-management.js";
import {
  sendWorkerConflictFailure,
  sendWorkerRequestFailure,
} from "./http/worker-request-failures.js";
import { AppLiveHub } from "./live/hub.js";
import { CoalescedInvalidations } from "./live/coalesced-invalidations.js";
import { TaskLiveInvalidationRouter } from "./live/task-live-routing.js";
import { CliCommandRequestError } from "./agent-tools/errors.js";
import { serverLogger } from "./logger.js";
import { StorageReconciliationService } from "./account-usage/storage-reconciler.js";
import { AccountUsageMeter } from "./account-usage/bandwidth-meter.js";
import { AccountUsageHistoryMaintenanceService } from "./account-usage/history-maintenance.js";
import {
  encodedFrameBytes,
  recordEncodedFrame,
} from "./account-usage/frame-bandwidth.js";
import { RelayQuotaManager } from "./operations/relay-quotas.js";
import { LimitedWorkerCommandBus } from "./workers/limited-command-bus.js";
import { MeteredWorkerCommandBus } from "./workers/metered-command-bus.js";
import { DirectAttachmentCoordinator } from "./direct-attachments/coordinator.js";
import { WorkerLinkCoordinator } from "./worker-links/coordinator.js";
import { WorkerLinkRelay } from "./worker-links/relay.js";
import { WorkerLinkService } from "./worker-links/service.js";
import { OpenRouterCatalogService } from "./models/openrouter-catalog.js";
import { OpenRouterRuntimeCatalogHydrator } from "./models/openrouter-runtime-catalog.js";
import { OllamaCatalogService } from "./models/ollama-catalog.js";
import { ChatGptCatalogService } from "./models/chatgpt-catalog.js";
import { GrokCatalogService } from "./models/grok-catalog.js";
import { ZaiCatalogService } from "./models/zai-catalog.js";
import { ProviderCredentialMigrationCoordinator } from "./models/provider-credential-migrations.js";
import { ProviderAccountLifecycleService } from "./models/provider-account-lifecycle.js";
import { isAccountProviderKind } from "./models/account-provider.js";
import { persistProviderQuotaSnapshot } from "./models/provider-quota.js";
import type { BuildAppOptions } from "./app/options.js";
import { createAgentOperationRuntime } from "./app/runtime/agent-operation-runtime.js";
import { createBackgroundJobRuntime } from "./app/runtime/background-job-runtime.js";
import { createChatRecoveryRuntime } from "./app/runtime/chat-recovery-runtime.js";
import { createChatTurnRuntime } from "./app/runtime/chat-turn-runtime.js";
import { createCliOperationRuntime } from "./app/runtime/cli-operation-runtime.js";
import { createLiveMutationRuntime } from "./app/runtime/live-mutation-runtime.js";
import { createModelRoutingRuntime } from "./app/runtime/model-routing-runtime.js";
import { createTaskGoalRuntime } from "./app/runtime/task-goal-runtime.js";
import {
  createRunConfigurationRuntime,
  type ExecutionOperationContext,
} from "./app/runtime/run-configuration-runtime.js";
import { installSettingsRouteRuntime } from "./app/runtime/settings-routes.js";
import { installTaskRouteRuntime } from "./app/runtime/task-routes.js";
import { createWorkerNotificationRuntime } from "./app/runtime/worker-notification-runtime.js";
import { createWorkflowSchedulingRuntime } from "./app/runtime/workflow-scheduling-runtime.js";
import {
  ACCOUNT_RESOURCE_USAGE_LIVE_COALESCE_MS,
  ACCOUNT_RESOURCE_USAGE_LIVE_TIMER_LIMIT,
  AGENT_INTERACTION_EXPIRY_SWEEP_MS,
  ATTACHMENT_CHUNK_BYTES,
  FINITE_WORKER_COMMAND_TIMEOUT_MS,
  PROJECT_TOKEN_USAGE_LIVE_COALESCE_MS,
  PROJECT_TOKEN_USAGE_LIVE_TIMER_LIMIT,
  TUNNEL_ATTACHMENT_EXPIRY_SWEEP_MS,
  WORKFLOW_GATE_EXPIRY_SWEEP_MS,
} from "./app/shared/constants.js";
import { ProviderAccountReconnectRequiredError } from "./app/shared/errors.js";
import {
  mutationChatLiveResources,
  mutationLiveResources,
} from "./app/shared/live-resources.js";

export type { BuildAppOptions } from "./app/options.js";
export { mutationLiveResources };

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
  const providerCatalogService =
    providedProviderCatalogService ?? new OpenRouterCatalogService(repository);
  const openRouterRuntimeCatalogs = new OpenRouterRuntimeCatalogHydrator(
    async (providerId) => {
      try {
        return Boolean(
          await providerCatalogService.getProviderCatalog(
            applicationOwnerId(),
            providerId,
            false,
          ),
        );
      } catch (error) {
        app.log.warn(
          { err: error, providerId },
          "Unable to hydrate OpenRouter model metadata",
        );
        return false;
      }
    },
  );
  const licenseWhitelistConfigured =
    config.licenseWhitelistEnabled !== undefined;
  const licenseWhitelistEnabled = config.licenseWhitelistEnabled === true;
  const normalizedAdminEmail = config.adminEmail
    ? normalizeAccountEmail(config.adminEmail)
    : null;
  const operationalMetrics = installOperationalHooks(app);
  const relayQuotas = providedRelayQuotas ?? new RelayQuotaManager(config);
  let publishAccountResourceUsageChange = (_ownerId: string): void => undefined;
  const accountUsageMeter = new AccountUsageMeter(
    repository.accountResourceUsage,
    serverLogger,
    {
      flushIntervalMs: config.bandwidthUsageFlushIntervalMs,
      flushThresholdBytes: config.bandwidthUsageFlushThresholdBytes,
      maxBufferedEntries: config.bandwidthUsageMaxBufferedEntries,
      meterId: `${config.serverInstanceId ?? "local-single-instance"}:${randomUUID()}`,
      onFlushed: (ownerIds) => {
        for (const ownerId of ownerIds)
          publishAccountResourceUsageChange(ownerId);
      },
    },
  );
  const rawBridge = workerBridge ?? new WorkerBridge();
  const coordinationStats = () =>
    coordinator?.stats() ?? {
      cachedWorkers: rawBridge.stats?.().connectedWorkers ?? 0,
      instanceCount: 1,
      maximumInstances: 1,
      receivedMessages: 0,
      rejectedMessages: 0,
      sentMessages: 0,
      shared: false,
    };
  const bridge = new LimitedWorkerCommandBus(
    new MeteredWorkerCommandBus(rawBridge, accountUsageMeter),
    {
      accountConcurrency: config.accountCommandConcurrency ?? 128,
      accountRatePerMinute: config.accountCommandRatePerMinute ?? 2_400,
      consumeRelayBytes: (ownerId, workerId, bytes) =>
        relayQuotas.consumeRelay(ownerId, workerId, bytes),
      resolveOwnerId: (workerId) => repository.getWorkerOwnerId(workerId),
      workerConcurrency: config.workerCommandConcurrency ?? 64,
      workerRatePerMinute: config.workerCommandRatePerMinute ?? 1_200,
    },
  );
  const ollamaCatalogService = new OllamaCatalogService(repository, bridge);
  const chatGptCatalogService = new ChatGptCatalogService(repository, bridge);
  const grokCatalogService = new GrokCatalogService(repository, bridge);
  const zaiCatalogService = new ZaiCatalogService(repository);
  const providerCredentialMigrations =
    providedProviderCredentialMigrations ??
    new ProviderCredentialMigrationCoordinator(repository, bridge, {
      purgeEnabledKinds: new Set(["chatgpt", "grok"]),
    });
  const providerAccountLifecycle = new ProviderAccountLifecycleService(
    repository,
    bridge,
    {
      invalidateCatalog: ({ accountId, kind, ownerId, providerId }) =>
        (kind === "grok"
          ? grokCatalogService
          : chatGptCatalogService
        ).markAccountUnavailable(ownerId, providerId, accountId),
      logger: app.log,
    },
  );
  let publishDirectTunnelLeaseChange: (change: {
    attachmentId: string;
    ownerId: string;
    projectId: string | null;
    tunnelId: string;
  }) => void = () => undefined;
  const directAttachments = new DirectAttachmentCoordinator(
    bridge,
    serverLogger,
    {
      onLeaseFinalized: async (event) => {
        if (event.mode !== "direct-tunnel" || event.resourceKind !== "tunnel") {
          return;
        }
        const changed = await repository.finalizeDesktopTunnelDirectLease(
          event.ownerId,
          event.attachmentId,
          event.capabilityId,
          new Date(event.leaseExpiresAt),
        );
        if (changed) publishDirectTunnelLeaseChange(changed);
      },
      onLeaseRenewed: async (event) => {
        if (event.mode !== "direct-tunnel" || event.resourceKind !== "tunnel") {
          return;
        }
        const changed = await repository.renewDesktopTunnelDirectLease(
          event.ownerId,
          event.attachmentId,
          event.capabilityId,
          new Date(event.leaseExpiresAt),
        );
        if (changed) publishDirectTunnelLeaseChange(changed);
      },
    },
  );
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
  const liveHub = new AppLiveHub({
    usageRecorder: accountUsageMeter,
    publishExternal: coordinator
      ? (publication) =>
          coordinator.publish({ kind: "live-publication", publication })
      : undefined,
  });
  const unsubscribeLiveCoordination = coordinator?.subscribe((message) => {
    if (message.kind === "live-publication") {
      liveHub.receiveExternal(message.publication);
    }
  });
  app.log.info(
    {
      instanceId: serverInstanceId,
      sharedCoordination: Boolean(coordinator),
    },
    "Server relay instance initialized",
  );
  let livePublishingEnabled = true;
  const publishLiveInvalidation = (
    resource: AppLiveResource,
    input: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    } = {},
  ): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: input.projectId
          ? { kind: "project", projectId: input.projectId }
          : input.chatId
            ? { kind: "chat", chatId: input.chatId }
            : { kind: "current-user" },
        resource,
        action: "invalidated",
        entityId: input.entityId ?? null,
        revision: null,
        payload: null,
      });
    } catch (error) {
      app.log.error(
        { err: error, resource },
        "Could not publish application live invalidation",
      );
    }
  };
  const taskLiveInvalidationRouter = new TaskLiveInvalidationRouter(
    (ownerId, chatId) => repository.getChatLiveRouting(ownerId, chatId),
    ({ entityId, ownerId, projectId, resource }) =>
      runAsOwner(ownerId, () =>
        publishLiveInvalidation(resource, { entityId, projectId }),
      ),
  );
  const projectTokenUsageLiveInvalidations = new CoalescedInvalidations<{
    ownerId: string;
    projectId: string;
  }>({
    delayMs: PROJECT_TOKEN_USAGE_LIVE_COALESCE_MS,
    limit: PROJECT_TOKEN_USAGE_LIVE_TIMER_LIMIT,
    publish: ({ ownerId, projectId }) =>
      runAsOwner(ownerId, () =>
        publishLiveInvalidation("project-token-usage", { projectId }),
      ),
  });
  const accountResourceUsageLiveInvalidations =
    new CoalescedInvalidations<string>({
      delayMs: ACCOUNT_RESOURCE_USAGE_LIVE_COALESCE_MS,
      limit: ACCOUNT_RESOURCE_USAGE_LIVE_TIMER_LIMIT,
      publish: (ownerId) =>
        runAsOwner(ownerId, () =>
          publishLiveInvalidation("account-resource-usage"),
        ),
    });
  publishAccountResourceUsageChange = (ownerId: string): void =>
    accountResourceUsageLiveInvalidations.schedule(ownerId, ownerId);
  const storageReconciler = new StorageReconciliationService(
    repository.accountResourceUsage,
    serverInstanceId,
    serverLogger,
    {
      intervalMs: config.storageReconciliationIntervalMs,
      onReconciled: ({ ownerIds }) => {
        for (const ownerId of ownerIds)
          publishAccountResourceUsageChange(ownerId);
      },
    },
  );
  const usageHistoryMaintenance = new AccountUsageHistoryMaintenanceService(
    repository.accountResourceUsage,
    serverInstanceId,
    serverLogger,
    {
      dailyRetentionDays: config.accountUsageDailyRetentionDays ?? 400,
      flushRetentionDays: config.accountUsageFlushRetentionDays ?? 7,
      hourlyRetentionDays: config.accountUsageHourlyRetentionDays ?? 30,
      intervalMs: config.accountUsageMaintenanceIntervalMs,
    },
  );
  app.addHook("onListen", () => {
    storageReconciler.start(false);
    usageHistoryMaintenance.start(false);
    void storageReconciler
      .reconcile()
      .finally(() => usageHistoryMaintenance.run());
  });
  const publishProjectTokenUsageChange = (
    ownerId: string,
    projectId: string,
    immediate: boolean,
  ): void => {
    const key = `${ownerId}:${projectId}`;
    projectTokenUsageLiveInvalidations.schedule(
      key,
      { ownerId, projectId },
      immediate,
    );
  };
  const publishTunnelRuntimeChange = (change: {
    attachmentId: string;
    ownerId: string;
    projectId: string | null;
    tunnelId: string;
  }): void => {
    runAsOwner(change.ownerId, () => {
      publishLiveInvalidation("tunnel", {
        entityId: change.tunnelId,
        projectId: change.projectId,
      });
    });
  };
  publishDirectTunnelLeaseChange = publishTunnelRuntimeChange;
  const tunnelStreamBroker = new TunnelStreamBroker({
    consumeRelayBytes: (ownerId, workerId, bytes) =>
      relayQuotas.consumeRelay(ownerId, workerId, bytes),
    onActivity: (tunnelId, attachmentId, authoritativeRootRequired) =>
      !authoritativeRootRequired ||
      codeTunnel.allowRelayAttachmentActivity(attachmentId, tunnelId),
  });
  const tunnelRuntime = new TunnelRuntimeManager(
    repository,
    bridge,
    publishTunnelRuntimeChange,
    tunnelStreamBroker,
    accountUsageMeter,
  );
  projectShareTunnel.configureControlPlane(
    repository,
    tunnelStreamBroker,
    publishTunnelRuntimeChange,
  );
  const revokeManagedFileShare = async (
    ownerId: string,
    managedResourceId: string,
  ): Promise<boolean> => {
    const tunnel = await repository.getManagedTunnel(ownerId, {
      kind: "project-share",
      id: managedResourceId,
    });
    if (!tunnel) return false;
    return directAttachments.mutateResource(
      ownerId,
      "tunnel",
      tunnel.id,
      async () => {
        await Promise.all(
          tunnel.attachments.map(({ id }) =>
            tunnelRuntime.revoke(ownerId, id, {
              preserveTunnelState: true,
            }),
          ),
        );
        return projectShareTunnel.revokeManagedResource(
          managedResourceId,
          ownerId,
        );
      },
    );
  };
  codeTunnel.configureControlPlane(
    repository,
    publishTunnelRuntimeChange,
    async (ownerId, tunnelId, reason, code) => {
      tunnelRuntime.closeTunnel(tunnelId, reason, code);
      await directAttachments.revokeResource(ownerId, "tunnel", tunnelId);
    },
  );
  const tunnelAttachmentExpiryTimer = setInterval(() => {
    void repository
      .expireDesktopTunnelDirectLeases()
      .then((expired) => {
        for (const attachment of expired) {
          publishTunnelRuntimeChange(attachment);
        }
      })
      .catch((error) => {
        app.log.error(
          { err: error },
          "Could not expire direct tunnel attachment leases",
        );
      });
    void repository
      .expireDesktopTunnelAttachments()
      .then((expired) => {
        for (const attachment of expired) {
          codeTunnel.releaseRelayAttachment(attachment.attachmentId);
          tunnelRuntime.closeActive(
            attachment.attachmentId,
            "Attachment expired",
            1008,
          );
          publishTunnelRuntimeChange(attachment);
        }
      })
      .catch((error) => {
        app.log.error({ err: error }, "Could not expire tunnel attachments");
      });
  }, TUNNEL_ATTACHMENT_EXPIRY_SWEEP_MS);
  tunnelAttachmentExpiryTimer.unref();
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
  const runningGitOperationRequests = new Set<string>();
  const gitOperationRequestRuntime = {
    isRequestRunning: (operationId: string): boolean =>
      runningGitOperationRequests.has(operationId),
    withRequestRunning: async <T>(
      operationId: string,
      request: () => Promise<T>,
    ): Promise<T> => {
      runningGitOperationRequests.add(operationId);
      try {
        return await request();
      } finally {
        runningGitOperationRequests.delete(operationId);
      }
    },
  };
  let gitLiveRevision = Date.now() * 1_000;
  let providerAuthLiveRevision = Date.now() * 1_000;
  const activeProviderAuthObservations = new Map<
    string,
    {
      accountId: string;
      expiresAt: number;
      lastSequence: number;
      ownerId: string;
      providerId: string;
      providerKind: "chatgpt" | "grok";
      startedAt: number;
      workerId: string;
    }
  >();
  const nextProviderAuthLiveRevision = (): number => {
    providerAuthLiveRevision = Math.max(
      providerAuthLiveRevision + 1,
      Date.now() * 1_000,
    );
    return providerAuthLiveRevision;
  };
  const publishProviderAuthStatus = (
    status: Omit<ProviderAuthLiveStatus, "revision">,
  ): ProviderAuthLiveStatus => {
    const payload = providerAuthLiveStatusSchema.parse({
      ...status,
      revision: nextProviderAuthLiveRevision(),
    });
    if (livePublishingEnabled) {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "current-user" },
        resource: "provider-auth",
        action: "status",
        entityId: payload.providerAccountId,
        revision: payload.revision,
        payload: appLiveEventPayloadSchema.parse(payload),
      });
    }
    return payload;
  };
  const activeProviderAuthObservation = (
    ownerId: string,
    providerId: string,
    accountId: string,
  ) =>
    [...activeProviderAuthObservations.entries()].find(
      ([, observation]) =>
        observation.ownerId === ownerId &&
        observation.providerId === providerId &&
        observation.accountId === accountId,
    ) ?? null;
  const removeProviderAuthObservations = (
    ownerId: string,
    providerId: string,
    accountId: string,
  ): void => {
    for (const [observationId, observation] of activeProviderAuthObservations) {
      if (
        observation.ownerId === ownerId &&
        observation.providerId === providerId &&
        observation.accountId === accountId
      ) {
        activeProviderAuthObservations.delete(observationId);
      }
    }
  };
  const nextGitLiveRevision = (): number => {
    gitLiveRevision = Math.max(gitLiveRevision + 1, Date.now() * 1_000);
    return gitLiveRevision;
  };
  const publishWorktreeStatus = (
    projectId: string,
    worktreeId: string,
    status: GitStatus,
  ): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "project", projectId },
        resource: "worktree-status",
        action: "updated",
        entityId: worktreeId,
        revision: null,
        payload: appLiveEventPayloadSchema.parse(gitStatusSchema.parse(status)),
      });
    } catch (error) {
      app.log.error(
        { err: error, projectId, worktreeId },
        "Could not publish worktree status",
      );
    }
  };
  const publishCodeGraphStatus = (
    status: CodeGraphProjectStatus,
    revision: number,
  ): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "project", projectId: status.projectId },
        resource: "codegraph-status",
        action: "updated",
        entityId: status.worktreeId,
        revision,
        payload: appLiveEventPayloadSchema.parse(status),
      });
    } catch (error) {
      app.log.error(
        {
          err: error,
          projectId: status.projectId,
          worktreeId: status.worktreeId,
        },
        "Could not publish CodeGraph status",
      );
    }
  };
  const publishGitOperation = (operation: GitManagedOperationRecord): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "project", projectId: operation.projectId },
        resource: "git-operation",
        action: "updated",
        entityId: operation.id,
        revision: nextGitLiveRevision(),
        payload: appLiveEventPayloadSchema.parse(
          gitManagedOperationResponseSchema.parse({ operation }),
        ),
      });
    } catch (error) {
      app.log.warn(
        {
          err: error,
          operationId: operation.id,
          projectId: operation.projectId,
        },
        "Could not publish exact Git operation state",
      );
      publishLiveInvalidation("git-operation", {
        entityId: operation.id,
        projectId: operation.projectId,
      });
    }
  };
  const publishGitConflicts = (
    projectId: string,
    worktreeId: string,
    conflicts: GitConflictList,
  ): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "project", projectId },
        resource: "git-conflict",
        action: "updated",
        entityId: worktreeId,
        revision: nextGitLiveRevision(),
        payload: appLiveEventPayloadSchema.parse(
          gitConflictListSchema.parse(conflicts),
        ),
      });
    } catch (error) {
      app.log.warn(
        { err: error, projectId, worktreeId },
        "Could not publish exact Git conflict summary",
      );
      publishLiveInvalidation("git-conflict", {
        entityId: worktreeId,
        projectId,
      });
    }
  };
  const recordLiveWorktreeStatus = async (
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ): Promise<void> => {
    const recorded = await repository.recordProjectWorktreeStatus(
      applicationOwnerId(),
      projectId,
      worktreeId,
      status,
    );
    if (!recorded) return;
    if (recorded.snapshotChanged) {
      publishWorktreeStatus(projectId, worktreeId, recorded.status.status);
    }
    if (recorded.metadataChanged) {
      publishLiveInvalidation("worktree", { entityId: worktreeId, projectId });
    }
  };
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
    livePublishingEnabled: () => livePublishingEnabled,
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
    livePublishingEnabled: () => livePublishingEnabled,
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
  const sessionSockets = new Map<
    string,
    {
      ownerId: string;
      sockets: Set<{ close(code?: number, reason?: string): void }>;
    }
  >();
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

  const publishAccountSessionChange = (
    ownerId: string,
    sessionId: string,
  ): void => {
    runAsOwner(ownerId, () =>
      publishLiveInvalidation("account-session", { entityId: sessionId }),
    );
  };
  const registerSessionSocket = (
    socket: {
      close(code?: number, reason?: string): void;
      on(event: "close", listener: () => void): void;
    },
    request: FastifyRequest,
  ): void => {
    const principal = authenticatedPrincipal(request);
    if (!principal.sessionId) return;
    const existing = sessionSockets.get(principal.sessionId);
    const entry = existing ?? {
      ownerId: principal.user.id,
      sockets: new Set(),
    };
    const wasConnected = entry.sockets.size > 0;
    entry.sockets.add(socket);
    sessionSockets.set(principal.sessionId, entry);
    if (!wasConnected) {
      publishAccountSessionChange(principal.user.id, principal.sessionId);
    }
    socket.on("close", () => {
      entry.sockets.delete(socket);
      if (entry.sockets.size === 0) {
        sessionSockets.delete(principal.sessionId!);
        publishAccountSessionChange(principal.user.id, principal.sessionId!);
      }
    });
  };
  const registerAccountSocket = (
    socket: {
      close(code?: number, reason?: string): void;
      on(event: "close", listener: () => void): void;
    },
    ownerId: string,
  ): boolean => {
    const release = accountWebsockets.acquire(ownerId);
    if (!release) {
      socket.close(1013, "Account WebSocket connection limit reached");
      return false;
    }
    socket.on("close", release);
    return true;
  };
  const registerAuthenticatedSocket = (
    socket: {
      close(code?: number, reason?: string): void;
      on(event: "close", listener: () => void): void;
    },
    request: FastifyRequest,
  ): boolean => {
    const principal = authenticatedPrincipal(request);
    return registerAccountSocket(socket, principal.user.id);
  };
  const closeSessionSockets = (
    matches: (sessionId: string, ownerId: string) => boolean,
    reason: string,
  ): void => {
    for (const [sessionId, entry] of [...sessionSockets]) {
      if (!matches(sessionId, entry.ownerId)) continue;
      sessionSockets.delete(sessionId);
      for (const socket of [...entry.sockets]) socket.close(1008, reason);
    }
  };
  const sessionSocketValidationTimer = setInterval(() => {
    for (const [sessionId, entry] of [...sessionSockets]) {
      void repository
        .isUserSessionActive(sessionId, entry.ownerId)
        .then((active) => {
          if (!active) {
            closeSessionSockets(
              (candidate) => candidate === sessionId,
              "Session is no longer active",
            );
          }
        })
        .catch(() => undefined);
    }
  }, 30_000);
  sessionSocketValidationTimer.unref();

  const authorizeLiveScope = async (
    ownerId: string,
    scope: AppLiveScope,
  ): Promise<boolean> => {
    switch (scope.kind) {
      case "current-user":
        return true;
      case "project":
        return (await repository.listProjects(ownerId)).some(
          (project) => project.id === scope.projectId,
        );
      case "chat":
        return Boolean(
          await repository.getChatExecutionContext(ownerId, scope.chatId),
        );
      case "workflow-run":
        return Boolean(
          await repository.workflowRuns.getRun(ownerId, scope.runId),
        );
    }
  };

  app.get("/api/live", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (!origin || !config.appOrigins.includes(origin)) {
      socket.close(1008, "Origin is not allowed");
      return;
    }
    if (request.principal.state !== "authenticated") {
      socket.close(1008, "Authentication is required");
      return;
    }
    const principal = authenticatedPrincipal(request);
    if (!registerAccountSocket(socket, principal.user.id)) return;
    registerSessionSocket(socket, request);
    liveHub.attach(socket, {
      ownerId: principal.user.id,
      sessionId: principal.sessionId,
      authorizeScope: (scope) => authorizeLiveScope(principal.user.id, scope),
      isActive: () =>
        principal.sessionId
          ? repository.isUserSessionActive(
              principal.sessionId,
              principal.user.id,
            )
          : true,
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    if (
      ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
      reply.statusCode >= 400
    ) {
      return;
    }
    const route = request.routeOptions.url ?? "";
    const repositoryAccess =
      request.body !== null &&
      typeof request.body === "object" &&
      "access" in request.body &&
      request.body.access === "read"
        ? "read"
        : "write";
    const resources = mutationLiveResources(route, repositoryAccess);
    const chatResources = mutationChatLiveResources(route);
    if (resources.length === 0 && chatResources.length === 0) return;
    const params = request.params as Record<string, unknown>;
    const projectId =
      typeof params.projectId === "string" ? params.projectId : null;
    const entityId = [
      params.configurationId,
      params.worktreeId,
      params.chatId,
      params.terminalId,
      params.explorerId,
      params.browserId,
      params.codeTabId,
      params.desktopId,
      params.surfaceId,
      params.viewId,
      params.workerId,
      params.policyId,
      params.workspaceId,
      params.tunnelId,
      params.attachmentId,
      params.projectId,
    ].find((value): value is string => typeof value === "string");
    for (const resource of resources) {
      publishLiveInvalidation(resource, {
        entityId:
          resource === "policy"
            ? typeof params.policyId === "string"
              ? params.policyId
              : null
            : entityId,
        projectId: resource === "policy" ? null : projectId,
      });
    }
    const chatId = typeof params.chatId === "string" ? params.chatId : null;
    if (chatId) {
      for (const resource of chatResources) {
        publishChatInvalidation(chatId, resource);
      }
    }
  });

  const routeCooldowns = new Map<string, number>();
  const runtimeCooldownKey = (runtime: ModelRuntime): string =>
    isAccountProviderKind(runtime.provider.kind) && runtime.provider.accountId
      ? `${runtime.routeId}:account:${runtime.provider.accountId}`
      : runtime.routeId;
  const surfaceAttachmentCounts = new Map<string, number>();
  const workerOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const workerPresenceFingerprints = new Map<string, string>();

  const publishWorkerPresence = (
    ownerId: string,
    worker: WorkerSummary,
  ): void => {
    runAsOwner(ownerId, () => {
      const fingerprint = workerPresenceFingerprint(worker);
      if (workerPresenceFingerprints.get(worker.workerId) === fingerprint)
        return;
      workerPresenceFingerprints.set(worker.workerId, fingerprint);
      publishLiveInvalidation("worker", { entityId: worker.workerId });
    });
  };
  const scheduleWorkerOfflineInvalidation = (
    ownerId: string,
    workerId: string,
  ): void => {
    const existing = workerOfflineTimers.get(workerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      workerOfflineTimers.delete(workerId);
      workerPresenceFingerprints.delete(workerId);
      runAsOwner(ownerId, () =>
        publishLiveInvalidation("worker-availability", { entityId: workerId }),
      );
    }, WORKER_ONLINE_WINDOW_MS + 50);
    timer.unref();
    workerOfflineTimers.set(workerId, timer);
  };
  const updateRemoteSurfaceStatus = async (
    surfaceId: string,
    status: Parameters<typeof repository.setRemoteSurfaceStatus>[1],
    error: string | null = null,
  ) => {
    const result = await repository.setRemoteSurfaceStatus(
      surfaceId,
      status,
      error,
    );
    publishLiveInvalidation("browser", { entityId: surfaceId });
    publishLiveInvalidation("remote-desktop", { entityId: surfaceId });
    publishLiveInvalidation("project-view", { entityId: surfaceId });
    return result;
  };
  const applyBrowserUpdate = async (
    ownerId: string,
    browserId: string,
    input: EncryptedBrowserUpdate,
    options: { expectedWorkerId?: string; requireOnline?: boolean } = {},
  ) => {
    const context = await repository.getRemoteSurfaceExecutionContext(
      ownerId,
      browserId,
    );
    if (
      !context ||
      context.surface.kind !== "browser" ||
      (options.expectedWorkerId &&
        context.workerId !== options.expectedWorkerId)
    ) {
      return null;
    }
    const browser = await repository.updateBrowser(ownerId, browserId, input);
    if (!browser || input.stateProtection === undefined) return browser;
    publishLiveInvalidation("browser", {
      entityId: browserId,
      projectId: browser.projectId,
    });
    const updatedContext = await repository.getRemoteSurfaceExecutionContext(
      ownerId,
      browserId,
    );
    if (
      !updatedContext ||
      updatedContext.workerId !== context.workerId ||
      updatedContext.surface.configuration.kind !== "browser"
    ) {
      throw new Error("Browser placement changed before configuration.");
    }
    if (!bridge.isConnected(context.workerId)) {
      await updateRemoteSurfaceStatus(
        browserId,
        "offline",
        "Worker is offline. The saved URL will be restored when it reconnects.",
      );
      if (options.requireOnline) {
        throw new WorkerUnavailableError("Browser worker is offline.");
      }
      return browser;
    }
    try {
      await bridge.request(
        context.workerId,
        {
          type: "surface.configure",
          surfaceId: browserId,
          serverId,
          configuration: updatedContext.surface.configuration,
          stateResource: "browser-row",
          stateRevision: updatedContext.surface.stateRevision,
          stateProtection: updatedContext.surface.stateProtection,
        },
        { timeoutMs: 20_000 },
      );
    } catch (error) {
      await updateRemoteSurfaceStatus(
        browserId,
        "error",
        "Browser private state could not be applied.",
      );
      if (options.requireOnline) throw error;
    }
    return browser;
  };
  const updateTerminalStatus = async (
    terminalId: string,
    status: Parameters<typeof repository.setTerminalStatus>[1],
  ) => {
    const result = await repository.setTerminalStatus(terminalId, status);
    publishLiveInvalidation("terminal", { entityId: terminalId });
    return result;
  };
  const synchronizeTerminalServicesForWorker = async (
    workerId: string,
  ): Promise<void> => {
    if (!bridge.isConnected(workerId)) return;
    const services = await repository.listTerminalServicesForWorker(
      workerId,
      serverId,
    );
    await bridge.request(
      workerId,
      { type: "terminal.services.reconcile", services },
      { timeoutMs: 30_000 },
    );
    await Promise.all(
      services.map(({ terminalId }) =>
        updateTerminalStatus(terminalId, "running"),
      ),
    );
  };
  const terminalServiceRuntime = {
    isWorkerConnected: (workerId: string): boolean =>
      bridge.isConnected(workerId),
    reconcileServicesForWorker: synchronizeTerminalServicesForWorker,
    recordStatus: updateTerminalStatus,
    restartService: async (
      workerId: string,
      terminalId: string,
    ): Promise<void> => {
      await bridge.request(
        workerId,
        { type: "terminal.service.restart", terminalId },
        { timeoutMs: 30_000 },
      );
    },
  };
  const updateCodeSessionRuntime = async (
    ...input: Parameters<typeof repository.updateCodeSessionRuntime>
  ) => {
    const result = await repository.updateCodeSessionRuntime(...input);
    publishLiveInvalidation("code-tab");
    return result;
  };
  const codeTabWorkerRuntime: CodeTabWorkerRuntime = {
    isWorkerConnected: (workerId) => bridge.isConnected(workerId),
    readStatus: (workerId, sessionId) =>
      bridge.request(workerId, { type: "code.status", sessionId }),
    saveAll: (workerId, sessionId) =>
      bridge.request(workerId, { type: "code.saveAll", sessionId }),
    stop: (workerId, sessionId) =>
      bridge.request(workerId, { type: "code.stop", sessionId }),
    setTheme: (workerId, sessionId, appearance) =>
      bridge.request(workerId, {
        type: "code.setTheme",
        sessionId,
        themeMode: "follow-cantrip",
        appearance,
      }),
    revokeTunnelSession: (sessionId) => codeTunnel.revokeSession(sessionId),
    revokeDirectSession: async (ownerId, sessionId) => {
      await directAttachments.revokeResource(ownerId, "code", sessionId);
    },
    recordSessionRuntime: updateCodeSessionRuntime,
  };
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

  app.get("/api", async () => ({
    name: "cantrip_server",
    version: "0.0.0",
  }));

  const rejectUnapprovedAuthOrigin = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): unknown | null => {
    const origin = request.headers.origin;
    if (origin && !config.appOrigins.includes(origin)) {
      return reply.code(403).send({ error: "Origin is not allowed." });
    }
    return null;
  };

  const consumeAuthAttempt = (
    request: FastifyRequest,
    scope: string,
    identity: string,
    reply: FastifyReply,
  ): unknown | null => {
    const retryAfter = authRateLimiter.consume(
      `${scope}:${request.ip}:${identity}`,
    );
    if (retryAfter === null) return null;
    reply.header("retry-after", String(retryAfter));
    return reply
      .code(429)
      .send({ error: "Too many authentication attempts. Try again later." });
  };

  const workerHasActiveCodeSettingsGrant = async (
    ownerId: string,
    workerId: string,
    keyRevision?: number,
  ): Promise<boolean> => {
    const principal =
      await repository.encryptionRegistry.findActiveWorkerPrincipal(
        ownerId,
        workerId,
      );
    if (!principal) return false;
    const result = await repository.encryptionRegistry.listActiveGrants(
      ownerId,
      principal.id,
    );
    return (
      result.status === "ok" &&
      result.grants.some(
        ({ component, keyRevision: grantedRevision }) =>
          component === "customization-content" &&
          (keyRevision === undefined || grantedRevision === keyRevision),
      )
    );
  };
  let registrationTail = Promise.resolve();
  const withRegistrationLock = async <T>(operation: () => Promise<T>) => {
    const predecessor = registrationTail;
    let release!: () => void;
    registrationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  app.get<{
    Params: { profileId: string; workerId: string };
  }>(
    "/api/internal/workers/:workerId/code-settings/profiles/:profileId",
    { logLevel: "warn" },
    async (request, reply) => {
      const profileId = codeSettingsProfileIdSchema.safeParse(
        request.params.profileId,
      );
      if (!profileId.success) {
        return reply.code(400).send(invalidBody(profileId.error.issues));
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        request.params.workerId,
        "worker:connect",
      );
      if (!workerAuth) return reply.code(401).send({ error: "Unauthorized" });
      const worker = await repository.getWorker(
        workerAuth.ownerId,
        request.params.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      const stored = await repository.codeSettings.get(
        workerAuth.ownerId,
        profileId.data,
      );
      if (
        !(await workerHasActiveCodeSettingsGrant(
          workerAuth.ownerId,
          request.params.workerId,
          stored?.record.protectedContent.keyRevision,
        ))
      ) {
        return reply.code(403).send({
          error: "Worker lacks Code settings encryption authorization.",
        });
      }
      reply.header("cache-control", "no-store");
      return stored
        ? reply.send(codeSettingsStoredProfileSchema.parse(stored))
        : reply
            .code(404)
            .send({ error: "Global Code settings are not initialized." });
    },
  );

  app.put<{
    Body: unknown;
    Params: { profileId: string; workerId: string };
  }>(
    "/api/internal/workers/:workerId/code-settings/profiles/:profileId",
    { logLevel: "warn" },
    async (request, reply) => {
      const profileId = codeSettingsProfileIdSchema.safeParse(
        request.params.profileId,
      );
      if (!profileId.success) {
        return reply.code(400).send(invalidBody(profileId.error.issues));
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        request.params.workerId,
        "worker:connect",
      );
      if (!workerAuth) return reply.code(401).send({ error: "Unauthorized" });
      const worker = await repository.getWorker(
        workerAuth.ownerId,
        request.params.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      const input = codeSettingsUploadSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      if (
        !(await workerHasActiveCodeSettingsGrant(
          workerAuth.ownerId,
          request.params.workerId,
          input.data.record.protectedContent.keyRevision,
        ))
      ) {
        return reply.code(403).send({
          error: "Worker lacks this Code settings encryption key revision.",
        });
      }
      try {
        const stored = await repository.codeSettings.compareAndSwap(
          workerAuth.ownerId,
          request.params.workerId,
          profileId.data,
          input.data,
        );
        runAsOwner(workerAuth.ownerId, () =>
          publishLiveInvalidation("settings", {
            entityId: `code:${profileId.data}`,
          }),
        );
        void repository
          .listWorkers(workerAuth.ownerId)
          .then(async (workers) =>
            Promise.all(
              workers
                .filter(
                  (worker) =>
                    worker.workerId !== request.params.workerId &&
                    bridge.isConnected(worker.workerId),
                )
                .map(async (worker) =>
                  (await workerHasActiveCodeSettingsGrant(
                    workerAuth.ownerId,
                    worker.workerId,
                    stored.profile.record.protectedContent.keyRevision,
                  ))
                    ? worker
                    : null,
                ),
            ),
          )
          .then((workers) =>
            Promise.allSettled(
              workers
                .filter((worker) => worker !== null)
                .map((worker) =>
                  bridge.request(
                    worker.workerId,
                    {
                      type: "code.settings.invalidate",
                      profileId: profileId.data,
                      revision: stored.profile.record.revision,
                    },
                    { ownerId: workerAuth.ownerId, timeoutMs: 20_000 },
                  ),
                ),
            ),
          )
          .catch((error) => {
            serverLogger.rateLimited(
              `code-settings-invalidation:${workerAuth.ownerId}`,
              "warn",
              "Code settings worker invalidation was not delivered",
              {
                event: "code.settings.invalidation-failed",
                subsystem: "code-settings",
                operation: "invalidate-workers",
                reasonCode: "delivery-failed",
                status: "degraded",
                error,
              },
            );
          });
        reply.header("cache-control", "no-store");
        return reply
          .code(stored.created ? 201 : 200)
          .send(codeSettingsStoredProfileSchema.parse(stored.profile));
      } catch (error) {
        if (error instanceof CodeSettingsRevisionConflictError) {
          return reply.code(409).send(
            codeSettingsRevisionConflictSchema.parse({
              code: "revision-conflict",
              profileId: profileId.data,
              currentRevision: error.currentRevision,
              error: error.message,
            }),
          );
        }
        throw error;
      }
    },
  );

  installInternalProviderCredentialRoutes(app, { config, repository });

  installAuthSessionRoutes(app, {
    appendAudit,
    closeSessionSockets,
    codeTunnel,
    config,
    consumeAuthAttempt,
    directAttachments,
    licenseWhitelistConfigured,
    licenseWhitelistEnabled,
    liveHub,
    localUser,
    normalizedAdminEmail,
    rejectUnapprovedAuthOrigin,
    repository,
    sessionService,
    withRegistrationLock,
    workerLinks,
  });

  installAccountSecurityRoutes(app, {
    appendAudit,
    codeTunnel,
    config,
    consumeAuthAttempt,
    licenseWhitelistEnabled,
    normalizedAdminEmail,
    repository,
    sessionSockets,
  });

  installSystemStatusRoutes(app, {
    accountUsageMeter,
    bridge,
    config,
    coordinationStats,
    coordinator,
    database,
    licenseWhitelistConfigured,
    licenseWhitelistEnabled,
    liveHub,
    operationalMetrics,
    relayQuotas,
    repository,
    serverId,
    storageReconciler,
    tunnelRuntime,
    usageHistoryMaintenance,
    workerLinkRelay,
  });

  installWorkerCatalogRoutes(app, { bridge, repository });

  installWorkerMaintenanceRoutes(app, {
    bridge,
    repository,
    synchronizeTerminalServicesForWorker,
  });

  installRepositoryOperationRoutes(app, {
    availableModelRuntimes,
    bridge,
    recordRuntimeTokenUsage,
    repository,
    serverId,
    worktreeCoordinator,
  });

  installWorkerLogRoutes(app, {
    accountUsageMeter,
    bridge,
    config,
    registerAuthenticatedSocket,
    registerSessionSocket,
    repository,
  });
  installWorkerLinkSessionRoutes(app, {
    bridge,
    config,
    directAttachments,
    operationalMetrics,
    registerAuthenticatedSocket,
    registerSessionSocket,
    repository,
    workerLinkRelay,
    workerLinks,
  });
  installDirectAttachmentControlRoutes(app, {
    directAttachments,
    operationalMetrics,
    repository,
  });

  installTunnelListRoute(app, { repository });

  app.get<{ Querystring: { context?: string } }>(
    "/api/chats",
    async (request, reply) => {
      if (request.query.context !== "standalone") {
        return reply.code(400).send({
          error: "Standalone Chat lists require context=standalone.",
        });
      }
      const chats = await repository.listStandaloneChats(applicationOwnerId());
      return reply.send(
        chats.map((chat) => standaloneChatWireSummarySchema.parse(chat)),
      );
    },
  );

  app.get<{ Querystring: { context?: string } }>(
    "/api/chats/archived",
    async (request, reply) => {
      if (request.query.context !== "standalone") {
        return reply.code(400).send({
          error: "Archived standalone Chat lists require context=standalone.",
        });
      }
      const chats =
        await repository.listArchivedStandaloneChats(applicationOwnerId());
      return reply.send(
        chats.map((chat) =>
          archivedStandaloneChatWireSummarySchema.parse(chat),
        ),
      );
    },
  );

  app.post("/api/chats", async (request, reply) => {
    const input = encryptedStandaloneChatCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const created = await repository.createStandaloneChat(
        applicationOwnerId(),
        input.data,
        (workerId) => bridge.isConnected(workerId),
      );
      publishChatSummary(created.chat.id, null);
      standaloneChatRootJobExecutor.queueAvailable();
      return reply
        .code(202)
        .send(standaloneChatWireSummarySchema.parse(created.chat));
    } catch (error) {
      if (error instanceof StandaloneChatPlacementUnavailableError) {
        return reply.code(409).send({
          code: "standalone-worker-unavailable",
          error: error.message,
        });
      }
      if (/unique|duplicate/i.test(errorMessage(error))) {
        return reply.code(409).send({ error: "Chat already exists." });
      }
      throw error;
    }
  });

  installTunnelReadAndCreateRoutes(app, { repository });

  installTunnelAttachmentRoutes(app, {
    accountUsageMeter,
    acquireAuthorizedCodeAttachmentRootLease,
    authorizedCodeAttachmentRootIdentity,
    codeTunnel,
    directAttachments,
    publishTunnelRuntimeChange,
    registerAccountSocket,
    repository,
    tunnelRuntime,
    workerLinks,
  });
  installTunnelMutationRoutes(app, { repository });

  installWorkerManagementRoutes(app, {
    bridge,
    config,
    markCredentialRevoked: (credentialId) => {
      revokedWorkerCredentialIds.add(credentialId);
    },
    publishWorkerAvailability: (workerId) =>
      publishLiveInvalidation("worker-availability", { entityId: workerId }),
    repository,
  });

  installWorkerEnrollmentCodeRoutes(app, { repository });

  installWorkerCredentialRoutes(app, {
    bridge,
    markCredentialRevoked: (credentialId) => {
      revokedWorkerCredentialIds.add(credentialId);
    },
    repository,
  });

  runConfigurationRuntime.installAppRuntimeRoutes(app);

  app.get<{
    Querystring: {
      chatId?: string;
      workflowRunId?: string;
      limit?: string;
      status?: string;
    };
  }>("/api/agent-requests", async (request, reply) => {
    const query = agentInteractionRequestQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidBody(query.error.issues));
    }
    const requests = await repository.listAgentInteractionRequests(
      applicationOwnerId(),
      query.data,
    );
    return reply.send(agentInteractionRequestWireListSchema.parse(requests));
  });

  app.get<{ Params: { requestId: string } }>(
    "/api/agent-requests/:requestId",
    async (request, reply) => {
      const interaction = await repository.getAgentInteractionRequest(
        applicationOwnerId(),
        request.params.requestId,
      );
      if (!interaction) {
        return reply.code(404).send({ error: "Agent request not found." });
      }
      return reply.send(agentInteractionRequestWireSchema.parse(interaction));
    },
  );

  app.post<{ Params: { requestId: string } }>(
    "/api/agent-requests/:requestId/respond",
    async (request, reply) => {
      const input = agentInteractionResolutionWireCreateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const protectedInput =
          "protectedResponse" in input.data ? input.data : null;
        const visibleInput = "response" in input.data ? input.data : null;
        const existing = protectedInput
          ? await repository.validateEncryptedAgentInteractionResolution(
              applicationOwnerId(),
              request.params.requestId,
              protectedInput,
            )
          : await repository.validateAgentInteractionResolution(
              applicationOwnerId(),
              request.params.requestId,
              visibleInput!,
            );
        if (!existing) {
          return reply.code(404).send({ error: "Agent request not found." });
        }
        if (existing.status !== "pending") {
          const replay = protectedInput
            ? await resolveLiveEncryptedAgentInteractionRequest(
                applicationOwnerId(),
                request.params.requestId,
                protectedInput,
              )
            : await resolveLiveAgentInteractionRequest(
                applicationOwnerId(),
                request.params.requestId,
                visibleInput!,
              );
          return reply.send(agentInteractionRequestWireSchema.parse(replay));
        }
        if (!existing.provenance.chatId) {
          if (!protectedInput || !("protectedPayload" in existing)) {
            return reply.code(409).send({
              error:
                "Protected workflow interactions require an encrypted response.",
            });
          }
          if (
            !existing.provenance.workflowRunId ||
            !existing.provenance.workflowNodeId
          ) {
            return reply.code(409).send({
              error: "The interaction has no active execution provenance.",
            });
          }
          try {
            await workflowExecutor.respondToEncryptedInteraction(
              applicationOwnerId(),
              existing,
              {
                classification: protectedInput.classification,
                protectedResponse: protectedInput.protectedResponse,
              },
            );
          } catch (error) {
            return sendWorkerConflictFailure(
              reply,
              error,
              `The workflow runtime no longer accepts this interaction: ${errorMessage(error)}`,
            );
          }
          try {
            const interaction =
              await resolveLiveEncryptedAgentInteractionRequest(
                applicationOwnerId(),
                request.params.requestId,
                protectedInput,
              );
            return reply.send(
              agentInteractionRequestWireSchema.parse(interaction),
            );
          } finally {
            workflowExecutor.finishInteractionResponse(existing.requestKey);
          }
        }
        const context = await repository.getChatExecutionContext(
          applicationOwnerId(),
          existing.provenance.chatId,
        );
        if (
          !context ||
          context.workerId !== existing.provenance.workerId ||
          context.executionLaneId !== existing.provenance.executionLaneId
        ) {
          return reply.code(409).send({
            error: "The interaction execution lane is no longer active.",
          });
        }
        if (!bridge.isConnected(context.workerId)) {
          return reply.code(503).send({ error: "Project worker is offline." });
        }
        const runtime = await runtimeForContext(context);
        if (!runtime) {
          return reply
            .code(409)
            .send({ error: "Selected model was not found." });
        }
        try {
          agentInteractionAcceptedSchema.parse(
            await bridge.request(
              context.workerId,
              protectedInput
                ? {
                    type: "agent.interaction.respond.protected",
                    executionProfile:
                      context.contextKind === "standalone"
                        ? "standalone-chat"
                        : "ide",
                    requestKey: existing.requestKey,
                    response: {
                      classification: protectedInput.classification,
                      protectedResponse: protectedInput.protectedResponse,
                    },
                    model: runtime.model,
                    provider: runtime.provider,
                  }
                : {
                    type: "agent.interaction.respond",
                    executionProfile:
                      context.contextKind === "standalone"
                        ? "standalone-chat"
                        : "ide",
                    requestKey: existing.requestKey,
                    response: visibleInput!.response,
                    model: runtime.model,
                    provider: runtime.provider,
                  },
              { timeoutMs: 30_000 },
            ),
          );
        } catch (error) {
          return sendWorkerConflictFailure(
            reply,
            error,
            `The runtime no longer accepts this interaction: ${errorMessage(error)}`,
          );
        }
        const interaction = protectedInput
          ? await resolveLiveEncryptedAgentInteractionRequest(
              applicationOwnerId(),
              request.params.requestId,
              protectedInput,
            )
          : await resolveLiveAgentInteractionRequest(
              applicationOwnerId(),
              request.params.requestId,
              visibleInput!,
            );
        return reply.send(agentInteractionRequestWireSchema.parse(interaction));
      } catch (error) {
        if (error instanceof WorkerUnavailableError) {
          return reply.code(503).send({ error: error.message });
        }
        if (error instanceof AgentInteractionConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

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

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/workflow-generation",
    async (_request, reply) =>
      reply.code(410).send({
        error:
          "This plaintext workflow generation path was removed pending the protected worker relay.",
      }),
  );

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

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/chats",
    async (request, reply) => {
      const chats = await repository.listChats(
        applicationOwnerId(),
        request.params.projectId,
      );
      return reply.send(chatWireListSchema.parse(chats));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/archived-chats",
    async (request, reply) => {
      const chats = await repository.listArchivedChats(
        applicationOwnerId(),
        request.params.projectId,
      );
      return reply.send(archivedChatWireListSchema.parse(chats));
    },
  );

  app.post("/api/chats/archives/cleanup", async (_request, reply) => {
    const ownerId = applicationOwnerId();
    const deleted = await repository.purgeExpiredArchivedChats(
      ownerId,
      new Date(Date.now() - ARCHIVED_CHAT_RETENTION_MS),
    );
    const standaloneJobs =
      await repository.standaloneChatRootJobs.purgeExpiredArchivedChats(
        ownerId,
      );
    for (const job of standaloneJobs) {
      publishStandaloneChatRootJobChange({ ownerId, job });
    }
    if (standaloneJobs.length > 0) {
      standaloneChatRootJobExecutor.queueAvailable();
    }
    return reply.send(
      archivedChatCleanupResultSchema.parse({
        deleted: deleted + standaloneJobs.length,
      }),
    );
  });

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/chats",
    async (request, reply) => {
      const input = encryptedChatCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const chat = await repository.createChat(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
          (workerId) => bridge.isConnected(workerId),
        );
        if (!chat) {
          return reply.code(404).send({ error: "Project source not found" });
        }
        return reply.code(201).send(chatWireSummarySchema.parse(chat));
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          if (error.code === "project-not-found") {
            return reply.code(404).send({ error: "Project source not found" });
          }
          return reply
            .code(409)
            .send({ code: error.code, error: error.message });
        }
        if (
          error instanceof ExecutionLaneConflictError ||
          /unique|duplicate/i.test(errorMessage(error))
        ) {
          return reply.code(409).send({
            error: "This worktree is already leased by another chat.",
          });
        }
        throw error;
      }
    },
  );

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

  app.patch<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/worktree",
    async (request, reply) => {
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getCodeTabExecutionContext(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      if (context) await requireProjectWorktrees(context.codeTab.projectId);
      try {
        const previousSessions =
          (await repository.listCodeSessions(
            applicationOwnerId(),
            request.params.codeTabId,
          )) ?? [];
        const codeTab = await repository.updateCodeTabWorktree(
          applicationOwnerId(),
          request.params.codeTabId,
          input.data,
        );
        if (codeTab) {
          const sessionsAfterUpdate =
            (await repository.listCodeSessions(
              applicationOwnerId(),
              request.params.codeTabId,
            )) ?? [];
          const staleSessionIds = new Set([
            ...previousSessions.map(({ id }) => id),
            ...sessionsAfterUpdate.map(({ id }) => id),
          ]);
          await Promise.all(
            [...staleSessionIds].map((sessionId) =>
              directAttachments.revokeResource(
                applicationOwnerId(),
                "code",
                sessionId,
              ),
            ),
          );
        }
        return codeTab
          ? reply.send(codeTabWireSummarySchema.parse(codeTab))
          : reply.code(404).send({ error: "Code tab or worktree not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  installCodeTabSessionListRoute(app, {
    applicationOwnerId,
    repository,
  });

  installCodeTabRuntimeReadRoute(app, {
    applicationOwnerId,
    repository,
    runtime: codeTabWorkerRuntime,
  });

  app.post<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/protected-attachment-intents",
    async (request, reply) => {
      const input = codeAttachmentCreateSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const context = await repository.getCodeTabExecutionContext(
        ownerId,
        request.params.codeTabId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Code tab not found." });
      }
      if (
        input.data.expectedWorkerId !== context.workerId ||
        input.data.expectedWorktreeId !== context.worktreeId
      ) {
        return reply.code(409).send({
          error: "The Code tab changed while its editor was opening.",
        });
      }
      if (!context.capabilities.available) {
        return reply.code(409).send({
          error:
            context.capabilities.reason ??
            "Cantrip Code is unavailable on this worker.",
        });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      let probe;
      try {
        probe = codeProbeResultSchema.parse(
          await bridge.request(context.workerId, { type: "code.probe" }),
        );
      } catch (error) {
        return reply.code(503).send({ error: errorMessage(error) });
      }
      if (!probe.capabilities.available || !probe.editorBuild) {
        return reply.code(409).send({
          error:
            probe.capabilities.reason ??
            "This worker has no compatible Cantrip Code build.",
        });
      }
      const session = await repository.getOrCreateCodeSession(
        ownerId,
        request.params.codeTabId,
        probe.editorBuild,
        randomUUID(),
      );
      if (!session) {
        return reply.code(409).send({
          error: "The Code tab changed while its editor was opening.",
        });
      }
      const openingContext = await repository.getCodeTabExecutionContext(
        ownerId,
        request.params.codeTabId,
      );
      if (
        !openingContext ||
        openingContext.workerId !== context.workerId ||
        openingContext.worktreeId !== context.worktreeId ||
        openingContext.cwd !== context.cwd ||
        openingContext.codeTab.profileId !== context.codeTab.profileId ||
        session.workerId !== openingContext.workerId ||
        session.worktreeId !== openingContext.worktreeId ||
        session.profileId !== openingContext.codeTab.profileId
      ) {
        await directAttachments.revokeResource(ownerId, "code", session.id);
        return reply.code(409).send({
          error: "The Code tab changed while its editor was opening.",
        });
      }
      let runtime: CodeRuntimeStatus | null = null;
      try {
        runtime = codeRuntimeStatusSchema.parse(
          await bridge.request(openingContext.workerId, {
            type: "code.open",
            sessionId: session.id,
            codeTabId: openingContext.codeTab.id,
            projectId: openingContext.codeTab.projectId,
            worktreeId: openingContext.worktreeId,
            worktreeName: openingContext.worktreeName,
            cwd: openingContext.cwd,
            profileId: scopedCodeProfileId(
              ownerId,
              openingContext.codeTab.profileId,
            ),
            themeMode: "follow-cantrip",
            appearance: input.data.appearance,
            presentation: "workbench",
          }),
        );
        const freshContext = await repository.getCodeTabExecutionContext(
          ownerId,
          request.params.codeTabId,
        );
        if (
          runtime.sessionId !== session.id ||
          !freshContext ||
          freshContext.workerId !== openingContext.workerId ||
          freshContext.worktreeId !== openingContext.worktreeId ||
          freshContext.cwd !== openingContext.cwd ||
          freshContext.codeTab.profileId !== openingContext.codeTab.profileId ||
          !(await updateCodeSessionRuntime(
            ownerId,
            openingContext.codeTab.id,
            session.id,
            runtime,
            true,
          ))
        ) {
          const rollbackStop =
            runtime.sessionId === session.id && runtime.sessionIncarnationId
              ? bridge
                  .request(
                    openingContext.workerId,
                    {
                      type: "code.stop",
                      sessionId: session.id,
                      expectedSessionIncarnationId:
                        runtime.sessionIncarnationId,
                    },
                    { timeoutMs: 5_000 },
                  )
                  .catch(() => undefined)
              : Promise.resolve();
          await Promise.all([
            rollbackStop,
            directAttachments.revokeResource(ownerId, "code", session.id),
          ]);
          return reply.code(409).send({
            error: "The Code tab changed while its editor was opening.",
          });
        }
      } catch (error) {
        const message = errorMessage(error);
        if (runtime?.sessionId === session.id && runtime.sessionIncarnationId) {
          void bridge
            .request(
              openingContext.workerId,
              {
                type: "code.stop",
                sessionId: session.id,
                expectedSessionIncarnationId: runtime.sessionIncarnationId,
              },
              { timeoutMs: 5_000 },
            )
            .catch(() => undefined);
        }
        const failedRuntime = codeRuntimeStatusSchema.parse({
          sessionId: session.id,
          status:
            error instanceof WorkerUnavailableError ? "offline" : "failed",
          editorBuild: probe.editorBuild,
          processInstanceId: null,
          bridgeConnected: false,
          dirtyEditors: [],
          workbench: {
            activeEditor: null,
            git: null,
            conflicts: [],
            savePolicy: "always",
            agentStatus: "idle",
          },
          startedAt: null,
          lastActivityAt: new Date().toISOString(),
          lastError: message,
        });
        await updateCodeSessionRuntime(
          ownerId,
          context.codeTab.id,
          session.id,
          failedRuntime,
        );
        return sendWorkerRequestFailure(reply, error, message);
      }
      if (!runtime) {
        return reply.code(502).send({ error: "Code editor did not start." });
      }
      return reply.code(201).send(
        codeProtectedAttachmentIntentSchema.parse({
          sessionId: session.id,
          runtime,
        }),
      );
    },
  );

  app.post<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/protected-attachments",
    async (request, reply) => {
      const input = codeProtectedAttachmentCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const authSessionId = authenticatedPrincipal(request).sessionId;
      const registrationLease = codeTunnel.acquireRegistrationLease({
        authSessionId,
        ownerId,
        sessionId: input.data.sessionId,
        tunnelId: input.data.tunnelId,
      });
      if (!registrationLease) {
        return reply.code(409).send({
          error: "The Code attachment lifecycle changed while attaching.",
        });
      }
      let registrationOwnership: "abort" | "binding" | "release" = "release";
      let registrationRuntime: CodeRuntimeStatus | null = null;
      let registrationWorkerId: string | null = null;
      let bindingAttachmentId: string | null = null;
      let retainBinding = false;
      try {
        const context = await repository.getCodeTabExecutionContext(
          ownerId,
          request.params.codeTabId,
        );
        if (!context) {
          return reply.code(404).send({ error: "Code tab not found." });
        }
        if (
          input.data.expectedWorkerId !== context.workerId ||
          input.data.expectedWorktreeId !== context.worktreeId
        ) {
          return reply.code(409).send({
            error: "The Code tab changed while its editor was attaching.",
          });
        }
        const session = (
          (await repository.listCodeSessions(ownerId, context.codeTab.id)) ?? []
        ).find((candidate) => candidate.id === input.data.sessionId);
        if (
          !session ||
          input.data.expectedWorkerId !== session.workerId ||
          input.data.expectedWorktreeId !== session.worktreeId ||
          session.workerId !== context.workerId ||
          session.worktreeId !== context.worktreeId ||
          session.profileId !== context.codeTab.profileId
        ) {
          return reply
            .code(409)
            .send({ error: "Code session is unavailable." });
        }
        if (!bridge.isConnected(context.workerId)) {
          return reply.code(503).send({ error: "Worker is offline." });
        }
        let runtime: CodeRuntimeStatus;
        try {
          registrationOwnership = "abort";
          registrationWorkerId = context.workerId;
          runtime = codeRuntimeStatusSchema.parse(
            await bridge.request(context.workerId, {
              type: "code.status",
              sessionId: session.id,
            }),
          );
          registrationRuntime = runtime;
        } catch (error) {
          return sendWorkerRequestFailure(reply, error);
        }
        const freshContext = await repository.getCodeTabExecutionContext(
          ownerId,
          request.params.codeTabId,
        );
        if (
          runtime.sessionId !== session.id ||
          !freshContext ||
          freshContext.workerId !== context.workerId ||
          freshContext.worktreeId !== context.worktreeId ||
          freshContext.cwd !== context.cwd ||
          freshContext.codeTab.profileId !== context.codeTab.profileId ||
          !codeTunnel.registrationLeaseIsActive(registrationLease)
        ) {
          return reply.code(409).send({
            error: "The Code tab changed while its editor was attaching.",
          });
        }
        const createdAttachment = await codeTunnel.createProtectedAttachment({
          authSessionId,
          codeTabId: context.codeTab.id,
          ownerId,
          projectId: context.codeTab.projectId,
          protectedRecord: input.data.protectedRecord,
          runtime,
          serverId,
          sessionId: session.id,
          tunnelId: input.data.tunnelId,
          workerId: context.workerId,
          worktreeId: context.worktreeId,
          worktreePath: context.cwd,
          registrationLease,
        });
        bindingAttachmentId = createdAttachment.attachmentId;
        registrationOwnership = "binding";
        const attachment =
          codeProtectedAttachmentWireSchema.parse(createdAttachment);
        const attachedContext = await repository.getCodeTabExecutionContext(
          ownerId,
          request.params.codeTabId,
        );
        if (
          !attachedContext ||
          attachedContext.workerId !== context.workerId ||
          attachedContext.worktreeId !== context.worktreeId ||
          attachedContext.cwd !== context.cwd ||
          attachedContext.codeTab.profileId !== context.codeTab.profileId ||
          !codeTunnel.attachmentRegistrationLeaseIsActive(
            attachment.attachmentId,
            registrationLease,
          )
        ) {
          return reply.code(409).send({
            error: "The Code tab changed while its editor was attaching.",
          });
        }
        const response = reply.code(201).send(attachment);
        retainBinding = true;
        return response;
      } catch (error) {
        return reply
          .code(
            codeTunnel.registrationLeaseIsActive(registrationLease) ? 503 : 409,
          )
          .send({ error: errorMessage(error) });
      } finally {
        if (registrationOwnership === "abort" && registrationWorkerId) {
          await codeTunnel.abortRegistrationSession({
            lease: registrationLease,
            runtime: registrationRuntime,
            workerId: registrationWorkerId,
          });
        } else {
          codeTunnel.releaseRegistrationLease(registrationLease);
          if (
            registrationOwnership === "binding" &&
            !retainBinding &&
            bindingAttachmentId
          ) {
            await codeTunnel.revokeAttachment(bindingAttachmentId, ownerId);
          }
        }
      }
    },
  );

  app.delete<{ Params: { attachmentId: string } }>(
    "/api/code-attachments/:attachmentId",
    async (request, reply) => {
      await codeTunnel.revokeAttachment(
        request.params.attachmentId,
        applicationOwnerId(),
      );
      await directAttachments.revokeAttachment(request.params.attachmentId);
      return reply.code(204).send();
    },
  );

  installCodeTabWorkerControlRoutes(app, {
    applicationOwnerId,
    repository,
    runtime: codeTabWorkerRuntime,
  });

  app.delete<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId",
    async (request, reply) => {
      const sessions = await repository.listCodeSessions(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      const context = await repository.deleteCodeTab(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      if (!context || !sessions) {
        return reply.code(404).send({ error: "Code tab not found." });
      }
      await Promise.all(
        sessions.map((session) => codeTunnel.revokeSession(session.id)),
      );
      await Promise.all(
        sessions.map((session) =>
          directAttachments.revokeResource(
            applicationOwnerId(),
            "code",
            session.id,
          ),
        ),
      );
      if (bridge.isConnected(context.workerId)) {
        await Promise.allSettled(
          sessions
            .filter((session) => session.status !== "stopped")
            .map((session) =>
              bridge.request(context.workerId, {
                type: "code.stop",
                sessionId: session.id,
              }),
            ),
        );
      }
      return reply.code(204).send();
    },
  );

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

  app.get<{
    Params: { surfaceId: string };
    Querystring: { width?: string; height?: string; devicePixelRatio?: string };
  }>(
    "/api/remote-surfaces/:surfaceId/connect",
    { websocket: true },
    (socket, request) => {
      if (
        !request.headers.origin ||
        !config.appOrigins.includes(request.headers.origin)
      ) {
        socket.close(1008, "Origin not allowed");
        return;
      }
      if (!registerAuthenticatedSocket(socket, request)) return;
      registerSessionSocket(socket, request);
      const ownerId = principalOwnerId(request);
      const viewport = remoteSurfaceViewportSchema.safeParse({
        width: Number(request.query.width ?? 1_280),
        height: Number(request.query.height ?? 720),
        devicePixelRatio: Number(request.query.devicePixelRatio ?? 1),
      });
      if (!viewport.success) {
        socket.close(1008, "Invalid viewport");
        return;
      }

      const attachmentId = randomUUID();
      let attached = false;
      let closed = false;
      let releaseSurfaceQuota: (() => void) | null = null;
      let surfaceId: string | null = null;
      let workerId: string | null = null;

      const send = (message: unknown) => {
        if (socket.readyState === 1) {
          const encoded = JSON.stringify(
            remoteSurfaceConnectionMessageSchema.parse(message),
          );
          socket.send(encoded);
          recordEncodedFrame(accountUsageMeter, {
            ownerId,
            direction: "egress",
            channel: "remote-surface-relay",
            data: encoded,
          });
        }
      };

      socket.on("close", () => {
        closed = true;
        releaseSurfaceQuota?.();
        releaseSurfaceQuota = null;
        if (!attached || !surfaceId || !workerId) return;
        attached = false;
        const remaining = Math.max(
          0,
          (surfaceAttachmentCounts.get(surfaceId) ?? 1) - 1,
        );
        if (remaining === 0) surfaceAttachmentCounts.delete(surfaceId);
        else surfaceAttachmentCounts.set(surfaceId, remaining);
        if (bridge.isConnected(workerId)) {
          void bridge
            .request(workerId, {
              type: "surface.detach",
              surfaceId,
              attachmentId,
            })
            .catch(() => undefined);
        }
        if (remaining === 0) {
          void updateRemoteSurfaceStatus(
            surfaceId,
            bridge.isConnected(workerId) ? "idle" : "offline",
            bridge.isConnected(workerId) ? null : "Worker is offline.",
          );
        }
      });

      void (async () => {
        const context = await repository.getRemoteSurfaceExecutionContext(
          ownerId,
          request.params.surfaceId,
        );
        if (!context) {
          send({
            type: "error",
            message: "Remote Surface not found.",
            recoverable: false,
          });
          socket.close(1008, "Remote Surface not found");
          return;
        }
        surfaceId = context.surface.id;
        workerId = context.workerId;
        try {
          releaseSurfaceQuota = relayQuotas.acquireRemoteSurface(
            ownerId,
            workerId,
          );
        } catch (error) {
          send({
            type: "error",
            message: errorMessage(error),
            recoverable: true,
          });
          socket.close(1013, "Remote Surface quota reached");
          return;
        }
        if (closed) {
          releaseSurfaceQuota();
          releaseSurfaceQuota = null;
          return;
        }
        const desktopStream =
          context.surface.kind === "desktop"
            ? await repository.getUserSettings(ownerId).then((preferences) => ({
                targetFps: preferences.desktopFrameRate,
                quality: preferences.desktopStreamQuality,
              }))
            : null;
        if (!bridge.isConnected(workerId)) {
          await updateRemoteSurfaceStatus(
            surfaceId,
            "offline",
            "Worker is offline.",
          );
          send({
            type: "error",
            message: "Worker is offline.",
            recoverable: true,
          });
          socket.close(1013, "Worker offline");
          return;
        }

        await updateRemoteSurfaceStatus(surfaceId, "connecting");
        const webRtcConfiguration =
          context.surface.preferredTransport === "webrtc" &&
          context.remoteSurfaceCapabilities.transports.includes("webrtc") &&
          config.remoteSurfaceWebRtc &&
          context.remoteSurfaceCapabilities.iceTransportPolicies.includes(
            config.remoteSurfaceWebRtc.iceTransportPolicy,
          )
            ? createRemoteSurfaceWebRtcConfiguration(
                config.remoteSurfaceWebRtc,
                ownerId,
              )
            : null;
        const cleanupRelay = surfaceRelay.bind(socket, {
          surfaceId,
          attachmentId,
          ownerId,
          workerId,
        });
        try {
          const result = remoteSurfaceAttachResultSchema.parse(
            await bridge.request(
              workerId,
              {
                type: "surface.attach",
                surfaceId,
                attachmentId,
                projectId: context.surface.projectId,
                serverId,
                configuration: context.surface.configuration,
                stateResource:
                  context.surface.kind === "browser"
                    ? context.surface.titleProtection.classification
                        .recordKind === "browser"
                      ? "browser-row"
                      : "browser-remote-surface"
                    : "remote-desktop-row",
                stateRevision: context.surface.stateRevision,
                stateProtection: context.surface.stateProtection,
                preferredTransport: context.surface.preferredTransport,
                webrtc: webRtcConfiguration,
                viewport: viewport.data,
                desktopStream,
              },
              { timeoutMs: 30_000 },
            ),
          );
          if (closed) {
            cleanupRelay();
            void bridge
              .request(workerId, {
                type: "surface.detach",
                surfaceId,
                attachmentId,
              })
              .catch(() => undefined);
            return;
          }
          attached = true;
          surfaceAttachmentCounts.set(
            surfaceId,
            (surfaceAttachmentCounts.get(surfaceId) ?? 0) + 1,
          );
          await updateRemoteSurfaceStatus(surfaceId, "active");
          send({
            type: "ready",
            surfaceId,
            attachmentId,
            transport: result.transport,
            webrtc: result.transport === "webrtc" ? webRtcConfiguration : null,
          });
        } catch (error) {
          cleanupRelay();
          const message =
            error instanceof WorkerUnavailableError
              ? "Worker is offline."
              : "Remote Surface could not be opened.";
          await updateRemoteSurfaceStatus(
            surfaceId,
            error instanceof WorkerUnavailableError ? "offline" : "error",
            message,
          );
          send({ type: "error", message, recoverable: true });
          socket.close(1013, "Remote Surface unavailable");
        }
      })();
    },
  );

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

  const reconcileChatThread = async (
    context: ChatExecutionContext,
    resolvedRuntime?: ModelRuntime,
  ) => {
    if (context.contextKind !== "project") {
      throw new Error(
        "Standalone Chats cannot synchronize with an external Codex console.",
      );
    }
    if (!context.threadId) {
      return agentThreadSyncSchema.parse({
        threadId: "unavailable",
        status: "idle",
        turns: [],
      });
    }
    if (!bridge.isConnected(context.workerId)) {
      throw new WorkerUnavailableError("Project worker is offline.");
    }
    const runtime = resolvedRuntime ?? (await runtimeForContext(context));
    if (!runtime) throw new Error("Selected model was not found.");
    const sync = agentThreadSyncSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.sync",
        executionProfile: "ide",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
      }),
    );
    let syncExecution = context;
    if (sync.status === "running" && !context.executionLaneId) {
      const acquired = await repository.startChatExecutionLane(
        applicationOwnerId(),
        context.chatId,
        "agent",
        "Linked Codex console turn",
      );
      if (acquired?.contextKind === "project") {
        syncExecution = acquired;
        publishChatSummary(acquired.chatId, acquired.projectId);
      }
    }
    const syncAttribution: ChatExecutionAttribution | undefined =
      syncExecution.executionLaneId
        ? {
            contextKind: "project",
            executionLaneId: syncExecution.executionLaneId,
            worktreeId: syncExecution.worktreeId,
            scratchRootId: null,
          }
        : undefined;
    const canonicalMessages = canonicalMessagesFromThreadSync(sync, {
      idempotencyPrefix: "codex-sync",
      interruptedMessage: "Turn interrupted in the Codex console.",
      failedMessage: "The Codex console turn failed.",
    });
    for (const entry of canonicalMessages) {
      if (entry.activity?.type === "usage") {
        const usageTurnId = entry.activity.correlation?.turnId ?? entry.turnId;
        await recordRuntimeTokenUsage(
          `chat:${context.chatId}:${usageTurnId}`,
          context.projectId,
          context.chatId,
          runtime,
          entry.activity.last,
          {
            workerId: context.workerId,
            turnId: usageTurnId,
            executionAttemptId: `console-sync:${context.chatId}:${usageTurnId}`,
            attemptKind: "console-sync",
            attemptStatus: sync.status === "running" ? "running" : "completed",
          },
        );
      }
      await upsertLiveChatMessage(
        applicationOwnerId(),
        context.chatId,
        entry.message,
        syncAttribution,
      );
    }
    if (sync.turns.length > 0) {
      if (syncExecution.executionLaneId && sync.status !== "running") {
        await repository.finishChatExecutionLane(
          context.chatId,
          syncExecution.executionLaneId,
          sync.status,
        );
      } else {
        await repository.setChatStatus(context.chatId, sync.status);
      }
      publishChatSummary(context.chatId, context.projectId);
      if (sync.status === "idle") {
        if (!(await continuePendingWorktreeTransition(context.chatId))) {
          void dispatchNextQueuedPrompt(context.chatId);
        }
      }
    }
    return sync;
  };

  reconcileObservedChatThread = async (chatId, workerId, threadId, changes) => {
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    if (
      !context ||
      context.experience !== "agent" ||
      context.workerId !== workerId ||
      context.threadId !== threadId
    ) {
      return;
    }
    await reconcileChatThread(context);
    if (changes.includes("goal")) {
      publishChatInvalidation(chatId, "chat-goal", null, context);
    }
    if (changes.includes("queue")) {
      publishChatInvalidation(chatId, "chat-queue");
    }
    if (changes.includes("plan")) {
      publishChatInvalidation(chatId, "chat-plan", null, context);
    }
  };

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
    livePublishingEnabled = false;
    unsubscribeLiveCoordination?.();
    clearInterval(sessionSocketValidationTimer);
    clearInterval(tunnelAttachmentExpiryTimer);
    closeSessionSockets(() => true, "Server is shutting down");
    clearInterval(agentInteractionExpiryTimer);
    clearInterval(workflowGateExpiryTimer);
    workflowSchedulingRuntime.close();
    clearInterval(taskScheduleTimer);
    taskGoalRuntime.close();
    clearInterval(workerCatalogRefreshTimer);
    modelRoutingRuntime.close();
    projectTokenUsageLiveInvalidations.close();
    workerNotificationRuntime.close();
    chatTurnOutcomeRecoveryScheduler.clear();
    chatThreadChangeReconciler.clear();
    for (const timer of workerOfflineTimers.values()) clearTimeout(timer);
    workerOfflineTimers.clear();
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
    accountResourceUsageLiveInvalidations.close();
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
