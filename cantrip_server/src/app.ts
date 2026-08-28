import { randomBytes, randomUUID } from "node:crypto";
import {
  agentThreadSyncSchema,
  agentTurnResultSchema,
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
  codeAgentTurnNotificationResultSchema,
  codeAgentTurnPreparationResultSchema,
  codeProbeResultSchema,
  codeRuntimeStatusSchema,
  codeTabWireSummarySchema,
  providerAuthLiveStatusSchema,
  archivedChatCleanupResultSchema,
  archivedChatWireListSchema,
  chatGoalResponseSchema,
  chatTurnRollbackAcceptedSchema,
  encryptedChatCreateSchema,
  encryptedStandaloneChatCreateSchema,
  chatWireListSchema,
  chatMessageCreateSchema,
  chatMessageOpaqueContentSchema,
  chatMessageListSchema,
  chatMessageSchema,
  chatMessageRelayResultSchema,
  chatPromptSteerResultSchema,
  chatPromptSubmitResultSchema,
  modelConfigurationFailureSchema,
  modelConfigurationSchema,
  nativeSubagentCapabilityCompatible,
  NATIVE_SUBAGENT_PROTOCOL_VERSION,
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
  taskDispatchWorkerLeaseSchema,
  type TaskDispatchCycleSummary,
  type TaskDispatchWorkerLease,
  mentionedSkillNames,
  orderedIdsSchema,
  queuedPromptCreateSchema,
  queuedPromptListSchema,
  queuedPromptSchema,
  queuedPromptUpdateSchema,
  remoteSurfaceAttachResultSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceViewportSchema,
  protectedScriptCommandListSchema,
  skillSettingsContextSchema,
  encryptedLinkedConsoleCreateSchema,
  terminalWireSummarySchema,
  tunnelWireSummarySchema,
  workerEventIsProvisional,
  worktreeSelectionSchema,
  worktreeStatusResultSchema,
} from "@cantrip/protocol";
import { repositoryOperationOpaqueSchema } from "@cantrip/protocol/repository-operation";
import {
  endpointContentContextSchema,
  endpointContentOpaqueSchema,
} from "@cantrip/protocol/endpoint-content";
import {
  customizationContentScopeSchema,
  protectedCustomizationRequestSchema,
  protectedCustomizationResponseSchema,
  type CustomizationContentOperation,
  type CustomizationContentScope,
} from "@cantrip/protocol/customization-content";
import {
  codeSettingsProfileIdSchema,
  codeSettingsRevisionConflictSchema,
  codeSettingsStoredProfileSchema,
  codeSettingsUploadSchema,
} from "@cantrip/protocol/code-settings";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  AgentTurnResult,
  AppLiveResource,
  InferenceProgressUpdate,
  AppLiveScope,
  EncryptedBrowserUpdate,
  ChatMessage,
  ChatMessageOpaqueContent,
  ChatMessageOpaqueSummary,
  ChatTurnCreate,
  CodeGraphProjectStatus,
  CodeRuntimeStatus,
  GitStatus,
  GitConflictList,
  GitManagedOperationRecord,
  GitOperationObservationState,
  ProviderQuotaSnapshot,
  ProviderAuthLiveStatus,
  ModelConfiguration,
  ReasoningEffort,
  WorkerNotification,
  WorkerEvent,
  WorkerObservationEventIdentity,
  WorkerSummary,
  WorktreeStatusResult,
} from "@cantrip/protocol";
import {
  protectedWorkflowTriggerPrepareResultSchema,
  workflowTriggerDeliveryWireResultSchema,
  workflowTriggerProvenanceSchema,
} from "@cantrip/protocol/workflows";
import type { WorkflowJsonObject } from "@cantrip/protocol/workflows";
import type { WorkflowContentOpaque } from "@cantrip/protocol/workflow-content";
import {
  taskGoalWorkerResultSchema,
  taskMessageOpaqueSummarySchema,
  taskMessageRelayResultSchema,
  type TaskOperationRelayGoal,
  type TaskOperationRelayRequest,
  type TaskOperationRelayResult,
  type TaskMessageOpaqueContent,
  type TaskMessageOpaqueSummary,
  type TaskOpaqueSummary,
} from "@cantrip/protocol/tasks";
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
import {
  canFailOverRoute,
  chatIsExecuting,
  continuationPrompt,
  effectivePermissionProfile,
  scopedCodeProfileId,
} from "./chats/execution-helpers.js";
import { canonicalMessagesFromThreadSync } from "./chats/thread-sync.js";
import {
  ChatThreadChangeReconciler,
  type ChatThreadChangeNotification,
} from "./chats/thread-change-reconciliation.js";
import {
  ChatTurnOutcomeRecoveryScheduler,
  chatTurnOutcomeRecoveryKey,
  outcomeBelongsToLatestLaneTurn,
  shouldRecoverChatTurnOutcome,
} from "./chats/turn-outcome-recovery.js";
import {
  type CodeAttachmentRootIdentity,
  CodeTunnelBroker,
} from "./code/tunnel.js";
import { ProjectShareTunnelBroker } from "./project-shares/tunnel.js";
import { requireProjectCapability } from "./projects/capabilities.js";
import { TunnelRuntimeManager } from "./tunnels/runtime.js";
import { TunnelStreamBroker } from "./tunnels/broker.js";
import { ModelBehaviorTracker } from "./analytics/model-behavior.js";
import {
  TASK_DISPATCH_LEASE_MS,
  TaskDispatchConflictError,
} from "./db/task-dispatch.js";
import {
  parseTaskOperationRelayResult,
  taskOperationRelayTurnFields,
} from "./tasks/encrypted-relay.js";
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
  toChatAttachmentOpaqueSummary,
} from "./db/repository.js";
import {
  prepareRuntimesForReasoning,
  reasoningStateForRuntimes,
} from "./models/reasoning.js";
import {
  ModelConfigurationResolutionError,
  modelConfigurationFailure,
  resolveModelRoutePairs,
  type ResolvedModelRoutePair,
} from "./models/subagent-routing.js";
import { CodeSettingsRevisionConflictError } from "./db/code-settings.js";
import {
  WorkflowTriggerConflictError,
  WorkflowTriggerRateLimitError,
  type WorkflowScheduleDispatchLease,
  type WorkflowTriggerClaim,
} from "./db/workflow-triggers.js";
import { WorkerBridge, WorkerUnavailableError } from "./workers/bridge.js";
import { workerPresenceFingerprint } from "./workers/presence.js";
import { authenticateWorkerRequest } from "./workers/credentials.js";
import { RemoteSurfaceRelay } from "./remote-surfaces/relay.js";
import { createRemoteSurfaceWebRtcConfiguration } from "./remote-surfaces/webrtc.js";
import { triggerDeliveryIdempotencyKey } from "./workflows/trigger-helpers.js";
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
import {
  isTaskWorkloadLiveResource,
  TaskLiveInvalidationRouter,
} from "./live/task-live-routing.js";
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
import { resolveAccountProviderRuntimes } from "./models/chatgpt-account-routing.js";
import { isAccountProviderKind } from "./models/account-provider.js";
import {
  persistProviderQuotaSnapshot,
  persistProviderRateLimitActivity,
  readAndPersistProviderQuotaSnapshot,
} from "./models/provider-quota.js";
import { evaluateModelRouteAvailability } from "./models/model-route-availability.js";
import type { BuildAppOptions } from "./app/options.js";
import { createAgentOperationRuntime } from "./app/runtime/agent-operation-runtime.js";
import { createBackgroundJobRuntime } from "./app/runtime/background-job-runtime.js";
import { createCliOperationRuntime } from "./app/runtime/cli-operation-runtime.js";
import {
  createRunConfigurationRuntime,
  type ExecutionOperationContext,
} from "./app/runtime/run-configuration-runtime.js";
import { installSettingsRouteRuntime } from "./app/runtime/settings-routes.js";
import { installTaskRouteRuntime } from "./app/runtime/task-routes.js";
import { createWorkerNotificationRuntime } from "./app/runtime/worker-notification-runtime.js";
import {
  ACCOUNT_RESOURCE_USAGE_LIVE_COALESCE_MS,
  ACCOUNT_RESOURCE_USAGE_LIVE_TIMER_LIMIT,
  AGENT_INTERACTION_EXPIRY_SWEEP_MS,
  ATTACHMENT_CHUNK_BYTES,
  FINITE_WORKER_COMMAND_TIMEOUT_MS,
  GOAL_RESUME_PROMPT,
  PROJECT_TOKEN_USAGE_LIVE_COALESCE_MS,
  PROJECT_TOKEN_USAGE_LIVE_TIMER_LIMIT,
  ROUTE_FAILURE_COOLDOWN_MS,
  STREAMING_WORKER_COMMAND_TIMEOUT_MS,
  TUNNEL_ATTACHMENT_EXPIRY_SWEEP_MS,
  WORKFLOW_GATE_EXPIRY_SWEEP_MS,
  WORKFLOW_SCHEDULE_POLL_MS,
} from "./app/shared/constants.js";
import {
  ProviderAccountReconnectRequiredError,
  ScheduleDispatchLeaseLostError,
  SkillSettingsRequestError,
} from "./app/shared/errors.js";
import {
  mutationChatLiveResources,
  mutationLiveResources,
  type ChatLiveResource,
} from "./app/shared/live-resources.js";
import {
  createStreamedFinalTracker,
  hasFinal,
  recordFinal,
} from "./app/shared/streamed-final-tracker.js";
import {
  workerObservationMessageId,
  workerObservationTurnId,
} from "./app/shared/worker-observations.js";

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
  const publishWorkflowDefinitionChange = (workflowId: string): void => {
    publishLiveInvalidation("workflow-definition", { entityId: workflowId });
  };
  const publishProjectAutomationChange = (
    projectId: string,
    automationId: string,
  ): void => {
    publishLiveInvalidation("project-automation", {
      entityId: automationId,
      projectId,
    });
  };
  const publishWorkflowTriggerChange = (
    triggerId: string,
    projectId: string,
  ): void => {
    publishLiveInvalidation("workflow-trigger", {
      entityId: triggerId,
      projectId,
    });
  };
  const publishChatInvalidation = (
    chatId: string,
    resource: ChatLiveResource,
    entityId: string | null = null,
    routing?: ChatLiveRouting,
  ): void => {
    if (!livePublishingEnabled) return;
    const ownerId = applicationOwnerId();
    try {
      liveHub.publish({
        ownerId,
        scope: { kind: "chat", chatId },
        resource,
        action: "invalidated",
        entityId,
        revision: null,
        payload: null,
      });
    } catch (error) {
      app.log.error(
        { chatId, err: error, resource },
        "Could not publish chat live invalidation",
      );
    }
    if (isTaskWorkloadLiveResource(resource)) {
      void taskLiveInvalidationRouter
        .route({ chatId, entityId, ownerId, resource, routing })
        .catch((error) => {
          app.log.warn(
            { chatId, err: error, resource },
            "Could not publish Task workload invalidation",
          );
        });
    }
  };
  const publishChatMessage = (message: ChatMessage): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "chat", chatId: message.chatId },
        resource: "chat-message",
        action: "updated",
        entityId: message.id,
        revision: message.sequence,
        payload: appLiveEventPayloadSchema.parse(
          chatMessageSchema.parse(message),
        ),
      });
    } catch (error) {
      app.log.error(
        { chatId: message.chatId, err: error, messageId: message.id },
        "Could not publish persisted chat message",
      );
    }
  };
  const publishInferenceProgress = (
    chatId: string,
    progress: InferenceProgressUpdate,
  ): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "chat", chatId },
        resource: "inference-progress",
        action: progress.kind === "clear" ? "deleted" : "updated",
        entityId: progress.requestId,
        revision: progress.sequence,
        payload:
          progress.kind === "clear"
            ? null
            : appLiveEventPayloadSchema.parse(progress),
      });
    } catch (error) {
      app.log.error(
        { chatId, err: error, requestId: progress.requestId },
        "Could not publish inference progress",
      );
    }
  };
  const publishTaskMessage = (
    message: TaskMessageOpaqueSummary,
    routing?: ChatLiveRouting,
  ): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "chat", chatId: message.chatId },
        resource: "chat-message",
        action: "updated",
        entityId: message.id,
        revision: message.sequence,
        payload: appLiveEventPayloadSchema.parse(
          taskMessageOpaqueSummarySchema.parse(message),
        ),
      });
    } catch (error) {
      app.log.error(
        { chatId: message.chatId, err: error, messageId: message.id },
        "Could not publish encrypted Task message",
      );
    }
    publishChatInvalidation(message.chatId, "task", message.id, routing);
  };
  const publishEncryptedChatMessage = (
    message: ChatMessageOpaqueSummary,
  ): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "chat", chatId: message.chatId },
        resource: "chat-message",
        action: "updated",
        entityId: message.id,
        revision: message.sequence,
        payload: appLiveEventPayloadSchema.parse(message),
      });
    } catch (error) {
      app.log.error(
        { chatId: message.chatId, err: error, messageId: message.id },
        "Could not publish encrypted chat message",
      );
    }
  };
  const appendLiveChatMessage = async (
    ...input: Parameters<typeof repository.appendMessage>
  ): Promise<ChatMessageOpaqueSummary | null> => {
    const [ownerId, chatId, content, attribution] = input;
    if (!content.idempotencyKey) {
      throw new Error("Encrypted chat messages require an idempotency key.");
    }
    const existing = await repository.getEncryptedMessageByIdempotencyKey(
      ownerId,
      chatId,
      content.idempotencyKey,
    );
    if (existing) return existing;
    const context = await repository.getChatExecutionContext(ownerId, chatId);
    if (!context || context.experience !== "agent") return null;
    if (!bridge.isConnected(context.workerId)) {
      throw new WorkerUnavailableError("Project worker is offline.");
    }
    const protectedMessage = chatMessageOpaqueContentSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.message.protect",
        message: {
          ...content,
          id: randomUUID(),
          idempotencyKey: content.idempotencyKey,
        },
        attachments: [],
      }),
    );
    const message = await repository.appendEncryptedMessage(
      ownerId,
      chatId,
      protectedMessage,
      attribution,
    );
    if (message) publishEncryptedChatMessage(message);
    return message;
  };
  const upsertLiveChatMessage = async (
    ...input: Parameters<typeof repository.upsertMessage>
  ): Promise<ChatMessageOpaqueSummary | null> => {
    const [ownerId, chatId, content, attribution] = input;
    const existing = await repository.getEncryptedMessageByIdempotencyKey(
      ownerId,
      chatId,
      content.idempotencyKey,
    );
    const context = await repository.getChatExecutionContext(ownerId, chatId);
    if (!context || context.experience !== "agent") return null;
    if (!bridge.isConnected(context.workerId)) {
      throw new WorkerUnavailableError("Project worker is offline.");
    }
    const protectedMessage = chatMessageOpaqueContentSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.message.protect",
        message: {
          ...content,
          id: existing?.id ?? randomUUID(),
          idempotencyKey: content.idempotencyKey,
        },
        attachments: [],
      }),
    );
    const message = await repository.upsertEncryptedMessage(
      ownerId,
      chatId,
      protectedMessage,
      attribution,
    );
    if (message) publishEncryptedChatMessage(message);
    return message;
  };
  const setLiveChatMessageModelRoute = async (
    ...input: Parameters<typeof repository.setMessageModelRoute>
  ): ReturnType<typeof repository.setMessageModelRoute> => {
    const message = await repository.setMessageModelRoute(...input);
    if (message) publishChatMessage(message);
    return message;
  };
  const appendLiveTaskMessage = async (
    ownerId: string,
    chatId: string,
    message: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
    routing?: ChatLiveRouting,
  ) => {
    const saved = await repository.appendTaskMessage(
      ownerId,
      chatId,
      message,
      attribution,
    );
    if (saved) publishTaskMessage(saved, routing);
    return saved;
  };
  const upsertLiveTaskMessage = async (
    ownerId: string,
    chatId: string,
    message: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
    routing?: ChatLiveRouting,
  ) => {
    const saved = await repository.upsertTaskMessage(
      ownerId,
      chatId,
      message,
      attribution,
    );
    if (saved) publishTaskMessage(saved, routing);
    return saved;
  };
  const setLiveTaskMessageModelRoute = async (
    ownerId: string,
    messageId: string,
    modelId: string,
    runtime: ModelRuntime,
    reasoning?: {
      appliedReasoningEffort: ReasoningEffort | null;
      reasoningAdjusted: boolean;
    },
    routing?: ChatLiveRouting,
  ) => {
    const message = await repository.setTaskMessageModelRoute(
      ownerId,
      messageId,
      modelId,
      runtime,
      reasoning,
    );
    if (message) publishTaskMessage(message, routing);
    return message;
  };
  const appendLiveEncryptedChatMessage = async (
    ownerId: string,
    chatId: string,
    message: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ) => {
    const saved = await repository.appendEncryptedMessage(
      ownerId,
      chatId,
      message,
      attribution,
    );
    if (saved) publishEncryptedChatMessage(saved);
    return saved;
  };
  const upsertLiveEncryptedChatMessage = async (
    ownerId: string,
    chatId: string,
    message: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ) => {
    const saved = await repository.upsertEncryptedMessage(
      ownerId,
      chatId,
      message,
      attribution,
    );
    if (saved) publishEncryptedChatMessage(saved);
    return saved;
  };
  const setLiveEncryptedChatMessageModelRoute = async (
    ...input: Parameters<typeof repository.setEncryptedMessageModelRoute>
  ) => {
    const message = await repository.setEncryptedMessageModelRoute(...input);
    if (message) publishEncryptedChatMessage(message);
    return message;
  };
  const taskMessageServerStub = (
    message: TaskMessageOpaqueSummary | ChatMessageOpaqueSummary,
  ): ChatMessage => ({
    id: message.id,
    chatId: message.chatId,
    contextKind: "scratchRootId" in message ? message.contextKind : "project",
    worktreeId: message.worktreeId,
    scratchRootId: "scratchRootId" in message ? message.scratchRootId : null,
    executionLaneId: message.executionLaneId,
    sequence: message.sequence,
    role: message.role,
    mode: message.mode,
    content: [],
    modelId: message.modelId,
    modelRouteId: message.modelRouteId,
    providerId: message.providerId,
    providerName: message.providerName,
    providerModelName: message.providerModelName,
    reasoningEffort: message.reasoningEffort,
    appliedReasoningEffort: message.appliedReasoningEffort,
    reasoningAdjusted: message.reasoningAdjusted,
    createdAt: message.createdAt,
  });
  const publishChatSummary = (
    chatId: string,
    projectId: string | null,
  ): void => {
    if (projectId) {
      publishLiveInvalidation("chat", { entityId: chatId, projectId });
    } else {
      publishLiveInvalidation("chat", { entityId: chatId });
    }
  };
  const publishChatTurnBoundary = (
    chatId: string,
    projectId: string | null,
    routing?: ChatLiveRouting,
  ): void => {
    publishChatSummary(chatId, projectId);
    publishChatInvalidation(chatId, "chat");
    publishChatInvalidation(chatId, "chat-goal", null, routing);
    publishChatInvalidation(chatId, "chat-plan", null, routing);
  };
  const recordLiveAgentInteractionRequest = async (
    ...input: Parameters<typeof repository.recordAgentInteractionRequest>
  ): ReturnType<typeof repository.recordAgentInteractionRequest> => {
    const interaction = await repository.recordAgentInteractionRequest(
      ...input,
    );
    if (interaction.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    return interaction;
  };
  const recordLiveEncryptedAgentInteractionRequest = async (
    ...input: Parameters<
      typeof repository.recordEncryptedAgentInteractionRequest
    >
  ): ReturnType<typeof repository.recordEncryptedAgentInteractionRequest> => {
    const interaction = await repository.recordEncryptedAgentInteractionRequest(
      ...input,
    );
    if (interaction.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    return interaction;
  };
  const resolveLiveAgentInteractionRequest = async (
    ...input: Parameters<typeof repository.resolveAgentInteractionRequest>
  ): ReturnType<typeof repository.resolveAgentInteractionRequest> => {
    const interaction = await repository.resolveAgentInteractionRequest(
      ...input,
    );
    if (interaction?.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    if (interaction?.provenance.workflowRunId) {
      publishWorkflowRunChange({
        projectId: interaction.projectId,
        resource: "workflow-gate",
        revision: null,
        runId: interaction.provenance.workflowRunId,
      });
    }
    return interaction;
  };
  const resolveLiveEncryptedAgentInteractionRequest = async (
    ...input: Parameters<
      typeof repository.resolveEncryptedAgentInteractionRequest
    >
  ): ReturnType<typeof repository.resolveEncryptedAgentInteractionRequest> => {
    const interaction =
      await repository.resolveEncryptedAgentInteractionRequest(...input);
    if (interaction?.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    if (interaction?.provenance.workflowRunId) {
      publishWorkflowRunChange({
        projectId: interaction.projectId,
        resource: "workflow-gate",
        revision: null,
        runId: interaction.provenance.workflowRunId,
      });
    }
    return interaction;
  };
  const terminalizeLiveAgentInteractionRequest = async (
    ...input: Parameters<
      typeof repository.terminalizeAgentInteractionRequestFromWorker
    >
  ): ReturnType<
    typeof repository.terminalizeAgentInteractionRequestFromWorker
  > => {
    const interaction =
      await repository.terminalizeAgentInteractionRequestFromWorker(...input);
    if (interaction?.provenance.chatId) {
      publishChatInvalidation(
        interaction.provenance.chatId,
        "agent-interaction",
        interaction.id,
      );
      publishChatSummary(interaction.provenance.chatId, interaction.projectId);
    }
    return interaction;
  };
  const interruptLiveAgentInteractionRequests = async (
    ...input: Parameters<typeof repository.interruptAgentInteractionRequests>
  ): ReturnType<typeof repository.interruptAgentInteractionRequests> => {
    const interactions = await repository.interruptAgentInteractionRequests(
      ...input,
    );
    const chatId = input[0];
    publishChatInvalidation(chatId, "agent-interaction");
    const projectId = interactions[0]?.projectId;
    if (projectId) publishChatSummary(chatId, projectId);
    return interactions;
  };
  const expireLiveAgentInteractionRequests = async (
    ...input: Parameters<typeof repository.expireAgentInteractionRequests>
  ): ReturnType<typeof repository.expireAgentInteractionRequests> => {
    const interactions = await repository.expireAgentInteractionRequests(
      ...input,
    );
    const chats = new Map<string, string | null>();
    const workflowRuns = new Map<string, string>();
    for (const interaction of interactions) {
      if (interaction.provenance.chatId) {
        chats.set(interaction.provenance.chatId, interaction.projectId);
      }
      if (interaction.provenance.workflowRunId) {
        if (!interaction.projectId) continue;
        workflowRuns.set(
          interaction.provenance.workflowRunId,
          interaction.projectId,
        );
      }
    }
    for (const [chatId, projectId] of chats) {
      publishChatInvalidation(chatId, "agent-interaction");
      publishChatSummary(chatId, projectId);
    }
    for (const [runId, projectId] of workflowRuns) {
      publishWorkflowRunChange({
        projectId,
        resource: "workflow-gate",
        revision: null,
        runId,
      });
    }
    return interactions;
  };
  const updateLiveChatPlanMode = async (
    ...input: Parameters<typeof repository.updateChatPlanMode>
  ): ReturnType<typeof repository.updateChatPlanMode> => {
    const state = await repository.updateChatPlanMode(...input);
    if (state) publishChatInvalidation(input[1], "chat-plan");
    return state;
  };
  const updateLiveEncryptedChatPlanState = async (
    ...input: Parameters<typeof repository.updateEncryptedChatPlanState>
  ): ReturnType<typeof repository.updateEncryptedChatPlanState> => {
    const result = await repository.updateEncryptedChatPlanState(...input);
    publishChatInvalidation(input[0], "chat-plan");
    return result;
  };
  const deleteLiveQueuedPrompt = async (
    ...input: Parameters<typeof repository.deleteQueuedPrompt>
  ): ReturnType<typeof repository.deleteQueuedPrompt> => {
    const prompt = await repository.deleteQueuedPrompt(...input);
    if (prompt) publishChatInvalidation(prompt.chatId, "chat-queue", prompt.id);
    return prompt;
  };
  const reorderLiveQueuedPrompts = async (
    ...input: Parameters<typeof repository.reorderQueuedPrompts>
  ): ReturnType<typeof repository.reorderQueuedPrompts> => {
    const reordered = await repository.reorderQueuedPrompts(...input);
    if (reordered) publishChatInvalidation(input[1], "chat-queue");
    return reordered;
  };
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

  const dispatchingChats = new Set<string>();
  const pendingQueueDispatches = new Set<string>();
  const progressingWorktreeTransitions = new Set<string>();
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
  const advanceLiveWorkflowSchedule = async (
    triggerId: string,
    projectId: string,
    expected: Date,
    next: Date,
    lastErrorCode: string | null = null,
  ): Promise<boolean> => {
    const advanced = await repository.workflowTriggers.advanceSchedule(
      applicationOwnerId(),
      triggerId,
      expected,
      next,
      lastErrorCode,
    );
    if (advanced) publishWorkflowTriggerChange(triggerId, projectId);
    return advanced;
  };

  const deliverWorkflowTrigger = async ({
    actorId,
    actorType,
    allowOfflineQueue,
    allowedType,
    idempotencyKey,
    preclaimed,
    protectedPayload,
    triggerId,
  }: {
    actorId: string | null;
    actorType: "user" | "api" | "schedule" | "webhook" | "git";
    allowOfflineQueue: boolean;
    allowedType: "api" | "schedule" | "webhook" | "git" | "saved-command";
    idempotencyKey: string;
    preclaimed?: {
      claim: Extract<WorkflowTriggerClaim, { kind: "claimed" | "replay" }>;
      lease: WorkflowScheduleDispatchLease;
    };
    protectedPayload: WorkflowContentOpaque | null;
    triggerId: string;
  }) => {
    const context =
      preclaimed?.claim.context ??
      (await repository.workflowTriggers.getDeliveryContext(
        applicationOwnerId(),
        triggerId,
      ));
    if (!context || context.trigger.type !== allowedType) {
      throw new WorkflowTriggerConflictError(
        "Workflow trigger not found for this delivery route.",
      );
    }
    const source = await repository.getProjectSource(
      applicationOwnerId(),
      context.trigger.projectId,
    );
    if (!source) {
      throw new WorkflowTriggerConflictError(
        "Workflow trigger project source is unavailable.",
      );
    }
    if (!bridge.isConnected(source.workerId)) {
      throw new WorkerUnavailableError("Project worker is offline.");
    }
    const deliveredAt = new Date().toISOString();
    const provenance = preclaimed
      ? preclaimed.claim.delivery.trigger
      : workflowTriggerProvenanceSchema.parse({
          type: context.trigger.type,
          sourceId: context.trigger.id,
          actorType,
          actorId,
          deliveredAt,
          metadata: {},
        });
    const claim =
      preclaimed?.claim ??
      (await repository.workflowTriggers.claimDelivery(
        applicationOwnerId(),
        triggerId,
        idempotencyKey,
        provenance,
        protectedPayload,
      ));
    if (!claim || claim.kind === "disabled") {
      throw new WorkflowTriggerConflictError(
        "Workflow trigger is disabled or unavailable.",
      );
    }
    if (claim.kind === "replay" && claim.delivery.status === "failed") {
      throw new WorkflowTriggerConflictError(
        `Workflow trigger delivery failed (${claim.delivery.errorCode ?? "delivery-failed"}).`,
      );
    }
    if (claim.kind === "replay" && claim.delivery.runId) {
      const existingRun = await repository.workflowRuns.getRun(
        applicationOwnerId(),
        claim.delivery.runId,
      );
      if (existingRun) {
        return workflowTriggerDeliveryWireResultSchema.parse({
          delivery: claim.delivery,
          run: existingRun,
          replayed: true,
        });
      }
    }
    try {
      const runId = randomUUID();
      const prepared = protectedWorkflowTriggerPrepareResultSchema.parse(
        await bridge.request(source.workerId, {
          type: "workflow.trigger.prepare.protected",
          triggerId,
          workflowRunId: runId,
          triggerType: context.trigger.type,
          publicConfiguration: context.trigger.publicConfiguration,
          protectedConfiguration: context.trigger.protectedConfiguration,
          protectedBaseInput: context.trigger.protectedInput,
          deliveryOperationId: claim.delivery.protectedPayload
            ? claim.delivery.idempotencyKey
            : null,
          protectedDeliveryPayload: claim.delivery.protectedPayload,
        }),
      );
      if (prepared.status === "rejected") {
        throw new WorkflowTriggerConflictError(
          `Protected workflow trigger was rejected (${prepared.code}).`,
        );
      }
      const runResult = await repository.workflowRuns.createRun(
        applicationOwnerId(),
        {
          id: runId,
          workflowRevisionId: context.trigger.workflowRevisionId,
          projectId: context.trigger.projectId,
          protectedInput: prepared.protectedRunInput,
          budget: context.trigger.budget,
          permissionManifest: context.trigger.permissionManifest,
          selectedModelRouteId: context.trigger.selectedModelRouteId,
          selectedPermissionProfileId:
            context.trigger.selectedPermissionProfileId,
          trigger: provenance,
          idempotencyKey: triggerDeliveryIdempotencyKey(
            triggerId,
            idempotencyKey,
          ),
        },
      );
      if (!runResult) {
        throw new WorkflowTriggerConflictError(
          "Workflow trigger revision or project is unavailable.",
        );
      }
      const delivery = await repository.workflowTriggers.acceptDelivery(
        applicationOwnerId(),
        claim.delivery.id,
        triggerId,
        runResult.run.run.id,
        preclaimed?.lease,
      );
      if (!delivery) {
        throw new ScheduleDispatchLeaseLostError(
          "The schedule dispatch lease expired before completion.",
        );
      }
      publishWorkflowTriggerChange(triggerId, context.trigger.projectId);
      publishWorkflowRunChange({
        projectId: runResult.run.run.projectId,
        resource: "workflow-run",
        revision: null,
        runId: runResult.run.run.id,
      });
      workflowExecutor.queueRun(runResult.run.run.id, applicationOwnerId());
      return workflowTriggerDeliveryWireResultSchema.parse({
        delivery,
        run: runResult.run,
        replayed: claim.kind === "replay" || !runResult.created,
      });
    } catch (error) {
      if (
        allowOfflineQueue &&
        preclaimed &&
        error instanceof WorkerUnavailableError
      ) {
        throw error;
      }
      const failed = await repository.workflowTriggers.failDelivery(
        applicationOwnerId(),
        claim.delivery.id,
        triggerId,
        "workflow-trigger-delivery-failed",
        preclaimed?.lease,
      );
      if (preclaimed && !failed) {
        throw new ScheduleDispatchLeaseLostError(
          "The schedule dispatch lease expired before failure was recorded.",
        );
      }
      publishWorkflowTriggerChange(triggerId, context.trigger.projectId);
      throw error;
    }
  };

  let scheduleTickRunning = false;
  let activeScheduleTick: Promise<void> | null = null;
  const deliverDueSchedules = async () => {
    if (scheduleTickRunning) return;
    scheduleTickRunning = true;
    const scanStartedAt = performance.now();
    let dispatchFailures = 0;
    let dispatches = 0;
    let dueOccurrences = 0;
    let leaseContentions = 0;
    let leaseRecoveries = 0;
    let maximumLagMs = 0;
    let scanFailed = true;
    try {
      const now = new Date();
      const due = await repository.workflowTriggers.listDueSchedules(now);
      dueOccurrences = due.length;
      for (const candidate of due) {
        const publicConfiguration = candidate.trigger.publicConfiguration;
        if (
          candidate.trigger.type !== "schedule" ||
          publicConfiguration.type !== "schedule" ||
          !candidate.row.nextRunAt
        ) {
          continue;
        }
        const trigger = candidate.trigger;
        const expected = candidate.row.nextRunAt;
        maximumLagMs = Math.max(
          maximumLagMs,
          now.getTime() - expected.getTime(),
        );
        await runAsOwner(trigger.ownerId, async () => {
          const configuration = publicConfiguration;
          const intervalMs = configuration.intervalSeconds * 1_000;
          const provenance = workflowTriggerProvenanceSchema.parse({
            type: "schedule",
            sourceId: trigger.id,
            actorType: "schedule",
            actorId: null,
            deliveredAt: now.toISOString(),
            metadata: {},
          });
          const occurrence =
            await repository.workflowTriggers.claimScheduleOccurrence(
              trigger.ownerId,
              trigger.id,
              expected,
              provenance,
              serverInstanceId,
              schedulerLeaseTtlMs,
              now,
            );
          if (!occurrence) return;
          if (occurrence.kind === "busy") {
            leaseContentions += 1;
            return;
          }
          if (occurrence.kind === "disabled") return;
          if (occurrence.kind === "completed") {
            if (occurrence.delivery.status === "accepted") {
              if (occurrence.delivery.runId) {
                workflowExecutor.queueRun(
                  occurrence.delivery.runId,
                  trigger.ownerId,
                );
              }
              await advanceLiveWorkflowSchedule(
                trigger.id,
                trigger.projectId,
                expected,
                new Date(Date.now() + intervalMs),
              );
            } else {
              await advanceLiveWorkflowSchedule(
                trigger.id,
                trigger.projectId,
                expected,
                new Date(Date.now() + Math.min(intervalMs, 30_000)),
                occurrence.delivery.errorCode ?? "schedule-delivery-failed",
              );
            }
            return;
          }
          if (occurrence.lease.fencingToken > 1) leaseRecoveries += 1;
          const failClaimedOccurrence = async (code: string, next: Date) => {
            const failed = await repository.workflowTriggers.failDelivery(
              trigger.ownerId,
              occurrence.claim.delivery.id,
              trigger.id,
              code,
              occurrence.lease,
            );
            if (failed) {
              await advanceLiveWorkflowSchedule(
                trigger.id,
                trigger.projectId,
                expected,
                next,
                code,
              );
            }
          };
          if (
            configuration.catchUpPolicy === "skip" &&
            now.getTime() - expected.getTime() > intervalMs
          ) {
            await failClaimedOccurrence(
              "schedule-overdue-skipped",
              new Date(now.getTime() + intervalMs),
            );
            return;
          }
          const source = await repository.getProjectSource(
            applicationOwnerId(),
            trigger.projectId,
          );
          if (!source || !bridge.isConnected(source.workerId)) {
            if (configuration.offlinePolicy === "pause") {
              await failClaimedOccurrence(
                "schedule-worker-offline",
                new Date(now.getTime() + Math.min(intervalMs, 30_000)),
              );
            }
            return;
          }
          try {
            await deliverWorkflowTrigger({
              actorId: null,
              actorType: "schedule",
              allowOfflineQueue: configuration.offlinePolicy === "queue",
              allowedType: "schedule",
              idempotencyKey: expected.toISOString(),
              preclaimed: occurrence,
              protectedPayload: null,
              triggerId: trigger.id,
            });
            dispatches += 1;
            await advanceLiveWorkflowSchedule(
              trigger.id,
              trigger.projectId,
              expected,
              new Date(Date.now() + intervalMs),
            );
          } catch (error) {
            if (error instanceof ScheduleDispatchLeaseLostError) {
              app.log.info(
                { workflowTriggerId: trigger.id },
                "Scheduled workflow dispatch lease was fenced",
              );
              return;
            }
            if (
              error instanceof WorkerUnavailableError &&
              configuration.offlinePolicy === "queue"
            ) {
              return;
            }
            dispatchFailures += 1;
            app.log.warn(
              { err: error, workflowTriggerId: trigger.id },
              "Scheduled workflow delivery failed",
            );
            await advanceLiveWorkflowSchedule(
              trigger.id,
              trigger.projectId,
              expected,
              new Date(Date.now() + Math.min(intervalMs, 30_000)),
              "schedule-delivery-failed",
            );
          }
        });
      }
      scanFailed = false;
    } finally {
      scheduleTickRunning = false;
      const durationMs = performance.now() - scanStartedAt;
      operationalMetrics.recordSchedulerScan({
        dispatchFailures,
        dispatches,
        dueOccurrences,
        durationMs,
        failed: scanFailed,
        leaseContentions,
        leaseRecoveries,
        maximumLagMs,
      });
      if (dueOccurrences > 0 || dispatchFailures > 0 || scanFailed) {
        app.log[scanFailed || dispatchFailures > 0 ? "warn" : "info"](
          {
            event: "workflow.schedule.scan_completed",
            subsystem: "workflow-scheduler",
            operation: "scan",
            status: scanFailed
              ? "failed"
              : dispatchFailures > 0
                ? "degraded"
                : "completed",
            durationMs,
            counts: {
              dueOccurrences,
              dispatches,
              dispatchFailures,
              leaseContentions,
              leaseRecoveries,
            },
            maximumLagMs,
          },
          "Workflow schedule scan completed",
        );
      }
    }
  };

  const queueScheduleTick = () => {
    if (activeScheduleTick) return;
    activeScheduleTick = deliverDueSchedules()
      .catch((error) => {
        app.log.error({ err: error }, "Workflow schedule scan failed");
      })
      .finally(() => {
        activeScheduleTick = null;
      });
  };

  const workflowScheduleTimer = setInterval(() => {
    queueScheduleTick();
  }, WORKFLOW_SCHEDULE_POLL_MS);
  workflowScheduleTimer.unref();
  queueScheduleTick();

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
  const resolveModelId = async (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ): Promise<string> => {
    const defaultModelId = context.modelId
      ? null
      : (await repository.getUserSettings(applicationOwnerId())).defaultModelId;
    const modelId = requestedModelId ?? context.modelId ?? defaultModelId;
    if (!modelId) {
      throw new Error(
        "Choose a model or configure a default model in Settings.",
      );
    }
    return modelId;
  };

  const availableModelRuntimes = async (
    context: { providerAccountId?: string | null; workerId: string },
    modelId: string,
  ): Promise<ModelRuntime[]> => {
    let runtimes = await repository.getModelRuntimes(
      applicationOwnerId(),
      modelId,
    );
    if (await openRouterRuntimeCatalogs.hydrate(runtimes)) {
      // Catalog reconciliation binds legacy name-only routes and supplies the
      // reasoning/capability metadata used by both the composer and Codex.
      runtimes = await repository.getModelRuntimes(
        applicationOwnerId(),
        modelId,
      );
    }
    if (!runtimes.length) {
      throw new Error("The selected model has no enabled provider routes.");
    }
    const now = Date.now();
    const available: ModelRuntime[] = [];
    const unavailable: string[] = [];
    for (const runtime of runtimes) {
      if (!isAccountProviderKind(runtime.provider.kind)) {
        const catalogAvailability = runtime.model.providerModelId
          ? await repository.listProviderModelAvailability(
              applicationOwnerId(),
              runtime.provider.id,
              runtime.model.providerModelId,
            )
          : [];
        const eligibility = evaluateModelRouteAvailability(
          runtime,
          catalogAvailability,
          context.workerId,
        );
        if (!eligibility.available) {
          unavailable.push(
            `${runtime.provider.name}: ${eligibility.reason ?? "model unavailable"}`,
          );
          continue;
        }
        const cooldownUntil =
          routeCooldowns.get(runtimeCooldownKey(runtime)) ?? 0;
        if (cooldownUntil > now) {
          unavailable.push(`${runtime.provider.name} is cooling down`);
          continue;
        }
        available.push(runtime);
        continue;
      }

      const accountRouting = await resolveAccountProviderRuntimes({
        ownerId: applicationOwnerId(),
        preferredAccountId: context.providerAccountId,
        repository,
        runtime,
        workerId: context.workerId,
      });
      unavailable.push(...accountRouting.unavailable);
      for (const accountRuntime of accountRouting.runtimes) {
        const cooldownUntil =
          routeCooldowns.get(runtimeCooldownKey(accountRuntime)) ?? 0;
        if (cooldownUntil > now) {
          unavailable.push(`${runtime.provider.name} account is cooling down`);
          continue;
        }
        available.push(accountRuntime);
      }
    }
    if (!available.length) {
      serverLogger.rateLimited(
        `provider-routing-unavailable:${context.workerId}:${context.providerAccountId ?? "automatic"}`,
        "warn",
        "No provider route is currently available",
        {
          event: "provider.routing.unavailable",
          subsystem: "provider-routing",
          operation: "resolve-routes",
          reasonCode: "no-eligible-routes",
          status: "unavailable",
          workerId: context.workerId,
          counts: {
            configuredRoutes: runtimes.length,
            unavailableRoutes: unavailable.length,
          },
        },
        { summaryEvery: 10, windowMs: 60_000 },
      );
      throw new Error(
        `No provider route is currently available${unavailable.length ? `: ${unavailable.join("; ")}` : "."}`,
      );
    }
    serverLogger.sampled(
      `provider-routing-resolved:${context.workerId}`,
      20,
      "debug",
      "Provider routes resolved",
      {
        event: "provider.routing.resolved",
        subsystem: "provider-routing",
        operation: "resolve-routes",
        status: "ready",
        workerId: context.workerId,
        counts: {
          configuredRoutes: runtimes.length,
          availableRoutes: available.length,
          unavailableRoutes: unavailable.length,
        },
      },
    );
    return available;
  };

  const routePairsForConfiguration = async (
    context: ChatExecutionContext,
    configuration: ModelConfiguration,
    rootRuntimes?: ModelRuntime[],
  ): Promise<ResolvedModelRoutePair[]> => {
    if (!bridge.isConnected(context.workerId)) {
      return resolveModelRoutePairs({
        configuration,
        rootRuntimes: [],
        workerConnected: false,
      });
    }
    if (!configuration.modelId) {
      return resolveModelRoutePairs({ configuration, rootRuntimes: [] });
    }
    if (configuration.customSubagentModel) {
      const worker = await repository.getWorker(
        applicationOwnerId(),
        context.workerId,
      );
      if (
        !worker ||
        !nativeSubagentCapabilityCompatible(worker.codexRuntime.nativeSubagents)
      ) {
        const capability = worker?.codexRuntime.nativeSubagents;
        throw new ModelConfigurationResolutionError({
          code: "worker-subagents-unavailable",
          error:
            capability?.available === true &&
            capability.protocolVersion !== null
              ? `The selected worker reports native subagent protocol ${capability.protocolVersion}, but this server supports protocol ${NATIVE_SUBAGENT_PROTOCOL_VERSION}.`
              : (capability?.reason ??
                "The selected worker does not support native subagents."),
          field: "customSubagentModel",
          retryable: false,
        });
      }
    }

    let availableRoots: ModelRuntime[];
    try {
      availableRoots =
        rootRuntimes ??
        (await availableModelRuntimes(context, configuration.modelId));
    } catch (error) {
      throw new ModelConfigurationResolutionError({
        code: "root-model-unavailable",
        error: errorMessage(error),
        field: "modelId",
        retryable: true,
      });
    }

    let availableSubagents: ModelRuntime[] | undefined;
    if (configuration.customSubagentModel) {
      if (!configuration.subagentModelId) {
        availableSubagents = [];
      } else {
        try {
          availableSubagents = await availableModelRuntimes(
            { ...context, providerAccountId: null },
            configuration.subagentModelId,
          );
        } catch (error) {
          throw new ModelConfigurationResolutionError({
            code: "subagent-model-unavailable",
            error: errorMessage(error),
            field: "subagentModelId",
            retryable: true,
          });
        }
      }
    }
    return resolveModelRoutePairs({
      configuration,
      rootRuntimes: availableRoots,
      subagentRuntimes: availableSubagents,
    });
  };

  const configuredRoutePairsForDefaults = async (
    configuration: ModelConfiguration,
  ): Promise<ResolvedModelRoutePair[]> => {
    if (!configuration.modelId) {
      return configuration.customSubagentModel
        ? resolveModelRoutePairs({ configuration, rootRuntimes: [] })
        : [];
    }
    const [rootRuntimes, subagentRuntimes] = await Promise.all([
      repository.getModelRuntimes(applicationOwnerId(), configuration.modelId),
      configuration.customSubagentModel && configuration.subagentModelId
        ? repository.getModelRuntimes(
            applicationOwnerId(),
            configuration.subagentModelId,
          )
        : Promise.resolve(undefined),
    ]);
    return resolveModelRoutePairs({
      configuration,
      rootRuntimes,
      subagentRuntimes,
    });
  };

  const sendModelConfigurationResolutionFailure = (
    reply: FastifyReply,
    error: unknown,
  ) => {
    const failure = modelConfigurationFailure(error);
    if (!failure) return null;
    return reply
      .code(failure.code === "worker-offline" ? 503 : 409)
      .send(modelConfigurationFailureSchema.parse(failure));
  };

  const runtimeForContext = async (
    context: ChatExecutionContext,
  ): Promise<ModelRuntime | null> => {
    if (context.modelRouteId) {
      const active = await repository.getModelRuntimeByRoute(
        applicationOwnerId(),
        context.modelRouteId,
      );
      if (active) {
        const selected = (
          await availableModelRuntimes(context, active.model.id)
        ).find((runtime) => runtime.routeId === active.routeId);
        return selected
          ? prepareRuntimesForReasoning([selected], context.reasoningEffort)[0]!
              .runtime
          : null;
      }
    }
    const modelId = await resolveModelId(context);
    const runtimes = await availableModelRuntimes(context, modelId);
    return (
      prepareRuntimesForReasoning(runtimes, context.reasoningEffort)[0]
        ?.runtime ?? null
    );
  };

  const reasoningStateForContext = async (
    context: ChatExecutionContext,
    requestedModelId?: string,
    requestedReasoningEffort: ReasoningEffort | null = context.reasoningEffort,
  ) => {
    const modelId = requestedModelId ?? (await resolveModelId(context));
    return reasoningStateForRuntimes(
      modelId,
      requestedReasoningEffort,
      await availableModelRuntimes(context, modelId),
    );
  };

  const runtimeCanResumeContext = (
    context: ChatExecutionContext,
    runtime: ModelRuntime,
  ): boolean =>
    runtime.routeId === context.modelRouteId &&
    runtime.provider.accountId === context.providerAccountId;

  const recordRuntimeTokenUsage = async (
    sourceKey: string,
    projectId: string | null,
    chatId: string | null,
    runtime: ModelRuntime,
    usage:
      | {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          cachedInputTokens?: number;
          reasoningOutputTokens?: number;
          cacheWriteInputTokens?: number;
        }
      | undefined,
    attribution: {
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
      startedAt?: Date;
      completedAt?: Date | null;
      finalizedAt?: Date | null;
      codexVersion?: string | null;
    } = {},
  ): Promise<void> => {
    try {
      const ownerId = applicationOwnerId();
      await repository.recordTokenUsage(ownerId, {
        sourceKey,
        projectId,
        chatId,
        modelRouteId: runtime.routeId,
        providerAccountId: runtime.provider.accountId,
        workerId: attribution.workerId,
        turnId: attribution.turnId,
        executionAttemptId: attribution.executionAttemptId,
        attemptKind: attribution.attemptKind,
        attemptStatus: attribution.attemptStatus,
        reasoningEffort: runtime.model.reasoningEffort,
        workerVersion: null,
        serverVersion: cantripVersion.version,
        codexVersion: attribution.codexVersion,
        startedAt: attribution.startedAt,
        completedAt: attribution.completedAt,
        finalizedAt: attribution.finalizedAt,
        usage,
      });
      if (projectId) {
        publishProjectTokenUsageChange(
          ownerId,
          projectId,
          attribution.attemptStatus !== undefined &&
            attribution.attemptStatus !== "running",
        );
      }
    } catch (error) {
      app.log.warn(
        { err: error, sourceKey },
        "Unable to persist token usage analytics",
      );
    }
  };

  const recordRuntimeModelBehavior = async (
    sourceKey: string,
    execution: ChatExecutionContext,
    runtime: ModelRuntime,
    tracker: ModelBehaviorTracker,
    attribution: {
      executionAttemptId: string;
      attemptStatus:
        "running" | "completed" | "failed" | "cancelled" | "interrupted";
      routeAttemptIndex: number;
      retryFailoverCount: number;
      startedAt: Date;
      completedAt?: Date | null;
      finalizedAt?: Date | null;
      durationMs?: number | null;
      turnId?: string | null;
      userInterrupted?: boolean;
      userRetryRegeneration?: boolean;
      immediateCorrectiveFollowup?: boolean;
      codexVersion?: string | null;
    },
  ): Promise<void> => {
    try {
      await repository.recordModelBehaviorObservation(applicationOwnerId(), {
        sourceKey,
        projectId: execution.projectId,
        chatId: execution.chatId,
        modelRouteId: runtime.routeId,
        providerAccountId: runtime.provider.accountId,
        workerId: execution.workerId,
        executionAttemptId: attribution.executionAttemptId,
        attemptKind: "chat-turn",
        attemptStatus: attribution.attemptStatus,
        reasoningEffort: runtime.model.reasoningEffort,
        routeAttemptIndex: attribution.routeAttemptIndex,
        retryFailoverCount: attribution.retryFailoverCount,
        startedAt: attribution.startedAt,
        completedAt: attribution.completedAt,
        finalizedAt: attribution.finalizedAt,
        durationMs: attribution.durationMs,
        turnId: attribution.turnId,
        userInterrupted: attribution.userInterrupted,
        userRetryRegeneration: attribution.userRetryRegeneration,
        immediateCorrectiveFollowup: attribution.immediateCorrectiveFollowup,
        workerVersion: null,
        serverVersion: cantripVersion.version,
        codexVersion: attribution.codexVersion,
        signalAvailability: {
          fork: true,
          copy: false,
          rating: false,
          userRetryRegeneration: true,
          immediateCorrectiveFollowup: true,
        },
        ...tracker.snapshot(),
      });
    } catch (error) {
      app.log.warn(
        { err: error, sourceKey },
        "Unable to persist model behavior analytics",
      );
    }
  };

  const quotaObservationTimers = new Set<NodeJS.Timeout>();
  const quotaResetObservationKeys = new Set<string>();
  const captureRuntimeQuota = (
    runtime: ModelRuntime,
    execution: ChatExecutionContext,
    trigger: string,
    executionAttemptId: string,
    turnId: string | null = null,
  ): void => {
    if (
      !runtime.provider.accountId ||
      !runtime.provider.credentialHomeKey ||
      !isAccountProviderKind(runtime.provider.kind)
    ) {
      return;
    }
    const accountId = runtime.provider.accountId;
    void readAndPersistProviderQuotaSnapshot(repository, bridge, {
      ownerId: applicationOwnerId(),
      providerId: runtime.provider.id,
      accountId,
      accountPlanType: null,
      workerId: execution.workerId,
      trigger,
      chatId: execution.chatId,
      turnId,
      executionAttemptId,
      provider: {
        name: runtime.provider.name,
        kind: runtime.provider.kind,
        baseUrl: runtime.provider.baseUrl,
        credentialHomeKey: runtime.provider.credentialHomeKey,
      },
    })
      .then(({ snapshot }) => {
        scheduleKnownResetQuotaSamples(
          runtime,
          execution,
          executionAttemptId,
          turnId,
          snapshot,
        );
      })
      .catch((error) => {
        app.log.debug(
          {
            err: error,
            providerId: runtime.provider.id,
            providerAccountId: accountId,
            trigger,
            workerId: execution.workerId,
          },
          "Provider quota sample unavailable",
        );
      });
  };

  function scheduleKnownResetQuotaSamples(
    runtime: ModelRuntime,
    execution: ChatExecutionContext,
    executionAttemptId: string,
    turnId: string | null,
    snapshot: ProviderQuotaSnapshot,
  ): void {
    if (!runtime.provider.accountId) return;
    const now = Date.now();
    for (const window of snapshot.windows) {
      if (window.resetsAt === null) continue;
      const resetAtMs = window.resetsAt * 1_000;
      for (const phase of [
        { name: "before", atMs: resetAtMs - 5_000 },
        { name: "after", atMs: resetAtMs + 2_000 },
      ]) {
        const delayMs = phase.atMs - now;
        if (delayMs <= 0 || delayMs > 2_147_000_000) continue;
        const key = `${runtime.provider.accountId}:${window.limitId ?? "unknown"}:${window.windowKind}:${window.resetsAt}:${phase.name}`;
        if (quotaResetObservationKeys.has(key)) continue;
        quotaResetObservationKeys.add(key);
        const timer = setTimeout(() => {
          quotaObservationTimers.delete(timer);
          quotaResetObservationKeys.delete(key);
          captureRuntimeQuota(
            runtime,
            execution,
            `reset-window-${phase.name}`,
            executionAttemptId,
            turnId,
          );
        }, delayMs);
        timer.unref();
        quotaObservationTimers.add(timer);
      }
    }
  }

  const scheduleRuntimeQuotaSamples = (
    runtime: ModelRuntime,
    execution: ChatExecutionContext,
    executionAttemptId: string,
    turnId: string | null,
  ): void => {
    captureRuntimeQuota(
      runtime,
      execution,
      "turn-completed",
      executionAttemptId,
      turnId,
    );
    for (const delayMs of [5_000, 15_000, 45_000]) {
      const timer = setTimeout(() => {
        quotaObservationTimers.delete(timer);
        captureRuntimeQuota(
          runtime,
          execution,
          `turn-completed-plus-${delayMs / 1_000}s`,
          executionAttemptId,
          turnId,
        );
      }, delayMs);
      timer.unref();
      quotaObservationTimers.add(timer);
    }
  };

  const skillSettingsTarget = async (input: {
    projectId: string | null;
    providerId: string;
    workerId: string;
  }) => {
    const provider = await repository.getModelProvider(
      applicationOwnerId(),
      input.providerId,
    );
    if (!provider) {
      throw new SkillSettingsRequestError(404, "Model provider not found.");
    }
    const source = input.projectId
      ? await repository.getProjectSource(applicationOwnerId(), input.projectId)
      : null;
    if (input.projectId && !source) {
      throw new SkillSettingsRequestError(404, "Project source not found.");
    }
    if (source && source.workerId !== input.workerId) {
      throw new SkillSettingsRequestError(
        409,
        "The selected project belongs to a different worker.",
      );
    }
    const workerId = source?.workerId ?? input.workerId;
    if (
      !source &&
      !(await repository.getWorker(applicationOwnerId(), workerId))
    ) {
      throw new SkillSettingsRequestError(404, "Worker not found.");
    }
    if (!bridge.isConnected(workerId)) {
      throw new SkillSettingsRequestError(503, "Selected worker is offline.");
    }
    return {
      cwd: source?.cwd ?? null,
      workerId,
      providerId: provider.id,
      providerKind: provider.kind,
    };
  };

  const settingsCustomizationScope = (input: {
    projectId: string | null;
    providerId: string;
    workerId: string;
  }) =>
    customizationContentScopeSchema.parse({
      workerId: input.workerId,
      projectId: input.projectId,
      chatId: null,
      providerId: input.providerId,
    });

  const settingsContextFromCustomizationScope = (
    scope: CustomizationContentScope,
  ) => {
    if (scope.chatId !== null || scope.providerId === null) {
      throw new Error("Protected skill settings scope is invalid.");
    }
    return skillSettingsContextSchema.parse({
      workerId: scope.workerId,
      projectId: scope.projectId,
      providerId: scope.providerId,
    });
  };

  const chatCustomizationScope = (
    context: ChatExecutionContext,
    runtime: ModelRuntime,
  ) =>
    customizationContentScopeSchema.parse({
      workerId: context.workerId,
      projectId: context.projectId,
      chatId: context.chatId,
      providerId: runtime.provider.id,
    });

  const customizationScopesMatch = (
    left: CustomizationContentScope,
    right: CustomizationContentScope,
  ) => JSON.stringify(left) === JSON.stringify(right);

  const checkedCustomizationResponse = (input: {
    raw: unknown;
    operationId: string;
    operation: CustomizationContentOperation;
    scope: CustomizationContentScope;
  }) => {
    const wire = protectedCustomizationResponseSchema.parse(input.raw);
    if (
      wire.operationId !== input.operationId ||
      wire.operation !== input.operation ||
      !customizationScopesMatch(wire.scope, input.scope)
    ) {
      throw new Error(
        "Protected customization response targets another operation.",
      );
    }
    return wire;
  };

  const checkedCustomizationRequest = (input: {
    raw: unknown;
    operation: CustomizationContentOperation;
  }) => {
    const wire = protectedCustomizationRequestSchema.parse(input.raw);
    if (wire.operation !== input.operation) {
      throw new Error(
        "Protected customization request targets another operation.",
      );
    }
    return wire;
  };

  const continuePendingWorktreeTransition = async (
    chatId: string,
  ): Promise<boolean> => {
    if (progressingWorktreeTransitions.has(chatId)) return true;
    progressingWorktreeTransitions.add(chatId);
    try {
      const pending = await repository.getPendingChatWorktreeTransition(
        applicationOwnerId(),
        chatId,
      );
      if (!pending) return false;
      const current = await repository.getChatExecutionContext(
        applicationOwnerId(),
        chatId,
      );
      if (!current || chatIsExecuting(current.status)) return true;
      if (current.contextKind !== "project") return false;
      if (current.automationPaused) return true;
      if (!bridge.isConnected(pending.worktree.workerId)) return true;

      try {
        const modelId = await resolveModelId(current);
        await availableModelRuntimes(current, modelId);
      } catch (error) {
        app.log.error(
          { chatId, err: error },
          "Could not prepare a pending worktree continuation",
        );
        return true;
      }

      if (pending.lane.transitionKind === "release") {
        const source = await repository.getProjectWorktreeContext(
          applicationOwnerId(),
          current.projectId,
          current.worktreeId,
        );
        if (!source) return true;
        try {
          const status = worktreeStatusResultSchema.parse(
            await bridge.request(source.workerId, {
              type: "worktree.status",
              sourcePath: source.sourcePath,
              worktreePath: source.worktree.path,
            }),
          );
          if (status.status.files.length > 0) {
            await repository.cancelChatWorktreeTransition(
              applicationOwnerId(),
              chatId,
              pending.lane.id,
            );
            await appendLiveChatMessage(applicationOwnerId(), chatId, {
              role: "system",
              content: [
                {
                  type: "text",
                  text: "Worktree release was cancelled because new uncommitted changes appeared before the turn finished.",
                },
              ],
              idempotencyKey: `transition-cancelled:${pending.lane.id}`,
            });
            return false;
          }
        } catch (error) {
          app.log.error(
            { chatId, err: error },
            "Could not verify a pending worktree release",
          );
          return true;
        }
      }
      const applied = await repository.applyChatWorktreeTransition(
        applicationOwnerId(),
        chatId,
        pending.lane.id,
      );
      if (!applied) return true;
      const next = await repository.getChatExecutionContext(
        applicationOwnerId(),
        chatId,
      );
      if (!next) return true;
      const transitionText =
        applied.transitionKind === "release"
          ? `Returned to Primary after releasing the previous worktree. Continue the user's request from this checkout.`
          : `Continued in ${applied.worktree.name}${applied.worktree.branch ? ` (${applied.worktree.branch})` : ""}. Continue the user's request from this checkout.`;
      try {
        await beginTurn(
          next,
          {
            text: transitionText,
            idempotencyKey: `worktree-continuation:${pending.lane.id}`,
          },
          {
            acquiringActor: "agent",
            messageRole: "system",
            purpose: `Controlled ${applied.transitionKind} continuation`,
          },
        );
      } catch (error) {
        app.log.error(
          { chatId, err: error },
          "Could not start a worktree continuation",
        );
        await appendLiveChatMessage(
          applicationOwnerId(),
          chatId,
          {
            role: "system",
            content: [
              {
                type: "text",
                text: `The chat moved to ${applied.worktree.name}, but its automatic continuation could not start: ${errorMessage(error)}`,
              },
            ],
            idempotencyKey: `worktree-continuation-error:${pending.lane.id}`,
          },
          {
            executionLaneId: pending.lane.id,
            worktreeId: applied.worktree.id,
          },
        );
      }
      return true;
    } finally {
      progressingWorktreeTransitions.delete(chatId);
    }
  };

  const resumePendingWorktreeTransitionsForWorker = async (
    ownerId: string,
    workerId: string,
  ): Promise<void> => {
    if (!bridge.isConnected(workerId)) return;
    const chatIds = await repository.listPendingWorktreeTransitionChatIds(
      ownerId,
      workerId,
    );
    await Promise.allSettled(
      chatIds.map(async (chatId) => {
        try {
          await runAsOwner(ownerId, () =>
            continuePendingWorktreeTransition(chatId),
          );
        } catch (error) {
          app.log.error(
            { chatId, err: error, workerId },
            "Could not recover a pending worktree transition",
          );
        }
      }),
    );
  };

  const resolvePromptAttachments = async (
    context: ChatExecutionContext,
    attachmentIds: string[],
  ) => {
    const attachments = await repository.getChatAttachments(
      applicationOwnerId(),
      context.chatId,
      attachmentIds,
    );
    if (attachments.length !== attachmentIds.length) {
      throw new Error("One or more attachments are unavailable.");
    }
    if (attachments.some(({ workerId }) => workerId !== context.workerId)) {
      throw new Error("Attachments belong to another worker.");
    }
    return attachments;
  };

  const prepareCodeEditorsForTurn = async (
    context: ChatExecutionContext,
  ): Promise<void> => {
    const result = codeAgentTurnPreparationResultSchema.parse(
      await bridge.request(context.workerId, {
        type: "code.prepareAgentTurn",
        cwd: context.cwd,
      }),
    );
    if (result.prepared) return;
    const blocked = result.sessions.filter((session) => !session.allowed);
    const files = [
      ...new Set(
        blocked.flatMap((session) =>
          session.dirtyEditors.map(
            (editor) => editor.relativePath ?? editor.uri,
          ),
        ),
      ),
    ];
    const reason =
      blocked.find((session) => session.reason)?.reason ??
      "Cantrip Code could not establish a saved-file boundary.";
    throw new Error(
      `${reason}${files.length ? ` Dirty editors: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` and ${files.length - 10} more` : ""}.` : ""}`,
    );
  };

  const notifyCodeAgentState = async (
    context: Pick<ChatExecutionContext, "chatId" | "cwd" | "workerId">,
    phase: "started" | "completed" | "failed",
    paths: Iterable<string> = [],
  ): Promise<void> => {
    try {
      codeAgentTurnNotificationResultSchema.parse(
        await bridge.request(context.workerId, {
          type: "code.agentTurnState",
          cwd: context.cwd,
          phase,
          paths: [...paths].slice(0, 5_000),
        }),
      );
    } catch (error) {
      app.log.warn(
        { chatId: context.chatId, err: error, phase },
        "Could not synchronize the agent turn with Cantrip Code",
      );
    }
  };

  const dispatchNextQueuedPrompt = async (chatId: string): Promise<void> => {
    if (dispatchingChats.has(chatId)) {
      pendingQueueDispatches.add(chatId);
      return;
    }
    dispatchingChats.add(chatId);
    try {
      let context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        chatId,
      );
      if (
        !context ||
        context.automationPaused ||
        chatIsExecuting(context.status)
      )
        return;
      const prompt = (
        await repository.listEncryptedQueuedPrompts(
          applicationOwnerId(),
          chatId,
        )
      ).find((candidate) => !candidate.frozen);
      if (!prompt) return;
      app.log.info(
        {
          event: "chat.queue.dispatching",
          subsystem: "chat-queue",
          operation: "dispatch-prompt",
          status: "dispatching",
          chatId,
          requestId: prompt.id,
        },
        "Queued prompt is being dispatched",
      );
      if (
        context.contextKind === "project" &&
        prompt.worktreeId &&
        prompt.worktreeId !== context.worktreeId
      ) {
        await repository.updateChatWorktree(applicationOwnerId(), chatId, {
          worktreeId: prompt.worktreeId,
          mode: context.worktreeMode,
        });
        context = await repository.getChatExecutionContext(
          applicationOwnerId(),
          chatId,
        );
        if (!context) return;
      }
      await beginTurn(
        context,
        {
          text: "Encrypted queued prompt.",
          attachmentIds: prompt.classification.attachmentIds,
          mode: prompt.classification.mode,
          modelId: prompt.modelId,
          reasoningEffort: prompt.reasoningEffort,
          customSubagentModel: prompt.customSubagentModel,
          subagentModelId: prompt.subagentModelId,
          subagentReasoningEffort: prompt.subagentReasoningEffort,
          idempotencyKey: prompt.pendingMessage.idempotencyKey,
        },
        {
          encryptedChatMessages: {
            userMessage: prompt.pendingMessage,
            response: {
              id: randomUUID(),
              idempotencyKey: `assistant:${prompt.pendingMessage.id}`,
            },
          },
        },
      );
      await deleteLiveQueuedPrompt(applicationOwnerId(), prompt.id);
    } catch (error) {
      app.log.error(
        {
          event: "chat.queue.dispatch-failed",
          subsystem: "chat-queue",
          operation: "dispatch-prompt",
          reasonCode: "dispatch-failed",
          status: "failed",
          chatId,
          err: error,
        },
        "Queued prompt dispatch failed",
      );
    } finally {
      dispatchingChats.delete(chatId);
      if (pendingQueueDispatches.delete(chatId)) {
        void dispatchNextQueuedPrompt(chatId);
      }
    }
  };

  async function recoverChatTurnOutcome(
    ownerId: string,
    workerId: string,
    notification: Extract<WorkerNotification, { type: "chat.turn.outcome" }>,
  ): Promise<void> {
    const laneContext = await repository.getChatExecutionRecoveryContext(
      ownerId,
      notification.chatId,
      notification.executionLaneId,
    );
    if (
      !laneContext ||
      !shouldRecoverChatTurnOutcome(
        {
          ...laneContext.lane,
          scratchRootId: laneContext.lane.scratchRootId ?? null,
        },
        workerId,
        notification.worktreeId,
        notification.scratchRootId,
      )
    ) {
      app.log.warn(
        {
          chatId: notification.chatId,
          clientMessageId: notification.clientMessageId,
          executionLaneId: notification.executionLaneId,
          workerId,
        },
        "Ignored an agent turn outcome outside its execution lane",
      );
      return;
    }

    const messages = await repository.listMessageHeaders(
      ownerId,
      notification.chatId,
    );
    if (
      !outcomeBelongsToLatestLaneTurn(
        messages,
        notification.executionLaneId,
        notification.clientMessageId,
      )
    ) {
      app.log.warn(
        {
          chatId: notification.chatId,
          clientMessageId: notification.clientMessageId,
          executionLaneId: notification.executionLaneId,
          workerId,
        },
        "Ignored a stale agent turn outcome after the execution lane advanced",
      );
      return;
    }

    const attribution: ChatExecutionAttribution =
      notification.contextKind === "standalone"
        ? {
            contextKind: "standalone",
            executionLaneId: notification.executionLaneId,
            worktreeId: null,
            scratchRootId: notification.scratchRootId!,
          }
        : {
            contextKind: "project",
            executionLaneId: notification.executionLaneId,
            worktreeId: notification.worktreeId!,
            scratchRootId: null,
          };
    const taskOperation =
      notification.contextKind === "project"
        ? await repository.tasks.getOperationContext(
            ownerId,
            notification.chatId,
            {
              executionLaneId: notification.executionLaneId,
              userMessageId: notification.clientMessageId,
            },
          )
        : null;
    const taskDispatchFence = notification.taskDispatchFence;
    if (taskDispatchFence) {
      if (
        !taskOperation ||
        taskOperation.round.id !== taskDispatchFence.operationId
      ) {
        app.log.warn(
          {
            chatId: notification.chatId,
            cycleId: taskDispatchFence.cycleId,
            operationId: taskDispatchFence.operationId,
          },
          "Ignored a Task outcome without its claimed operation",
        );
        return;
      }
      try {
        await repository.taskDispatch.heartbeat(taskDispatchFence);
      } catch (error) {
        if (error instanceof TaskDispatchConflictError) {
          app.log.warn(
            {
              chatId: notification.chatId,
              cycleId: taskDispatchFence.cycleId,
              operationId: taskDispatchFence.operationId,
            },
            "Ignored a stale fenced Task outcome",
          );
          return;
        }
        throw error;
      }
    }
    let recoveredOutcomeOk = notification.outcome.ok;
    let recoveredFinalizationOperationId: string | null = null;
    if (taskOperation) {
      if (notification.outcome.ok) {
        try {
          const relayResult = parseTaskOperationRelayResult(
            notification.outcome.result.structuredResult,
            taskOperation.relayRequest,
          );
          await repository.tasks.completeOperation(
            ownerId,
            notification.chatId,
            taskOperation.round.id,
            relayResult,
            notification.outcome.result.turnId ?? null,
          );
          if (taskOperation.round.kind === "finalize") {
            recoveredFinalizationOperationId = taskOperation.round.id;
          }
          const assistantMessage = await appendLiveTaskMessage(
            ownerId,
            notification.chatId,
            relayResult.assistantMessage,
            attribution,
            laneContext.chat,
          );
          if (!assistantMessage) {
            throw new Error("Task Chat was not found.");
          }
          await repository.tasks.attachOperationAssistantMessage(
            ownerId,
            notification.chatId,
            taskOperation.round.id,
            assistantMessage.id,
          );
          publishChatInvalidation(
            notification.chatId,
            "task",
            null,
            laneContext.chat,
          );
        } catch (error) {
          recoveredOutcomeOk = false;
          await repository.tasks.failOperation(
            ownerId,
            notification.chatId,
            taskOperation.round.id,
          );
          publishChatInvalidation(
            notification.chatId,
            "task",
            null,
            laneContext.chat,
          );
        }
      } else {
        recoveredOutcomeOk = false;
        await repository.tasks.failOperation(
          ownerId,
          notification.chatId,
          taskOperation.round.id,
        );
        publishChatInvalidation(
          notification.chatId,
          "task",
          null,
          laneContext.chat,
        );
      }
    }
    if (taskDispatchFence) {
      try {
        await repository.taskDispatch.settle(
          taskDispatchFence,
          recoveredOutcomeOk ? "succeeded" : "failed",
        );
      } catch (error) {
        if (!(error instanceof TaskDispatchConflictError)) throw error;
      }
      queueTaskScheduleTick();
    }
    const assistantKey = `assistant:${notification.clientMessageId}`;
    const errorKey = `error:${notification.clientMessageId}`;
    const taskChat =
      notification.contextKind === "project" &&
      laneContext.chat.experience === "task";
    const existingAssistant = taskChat
      ? null
      : await repository.getEncryptedMessageByIdempotencyKey(
          ownerId,
          notification.chatId,
          assistantKey,
        );
    const existingError = taskChat
      ? null
      : await repository.getEncryptedMessageByIdempotencyKey(
          ownerId,
          notification.chatId,
          errorKey,
        );

    if (notification.outcome.ok) {
      await repository.updateChatExecutionLaneRuntime(
        notification.chatId,
        notification.executionLaneId,
        notification.outcome.result.threadId,
        "ready",
      );
      if (taskChat && !taskOperation) {
        try {
          const encrypted = taskMessageRelayResultSchema.parse(
            notification.outcome.result.structuredResult,
          );
          await appendLiveTaskMessage(
            ownerId,
            notification.chatId,
            encrypted.message,
            attribution,
            laneContext.chat,
          );
        } catch {
          recoveredOutcomeOk = false;
        }
      } else if (
        notification.contextKind === "standalone" &&
        !existingAssistant
      ) {
        const encrypted = chatMessageRelayResultSchema.parse(
          notification.outcome.result.structuredResult,
        );
        if (!encrypted.message) {
          throw new Error("Standalone Chat outcome omitted protected content.");
        }
        await appendLiveEncryptedChatMessage(
          ownerId,
          notification.chatId,
          encrypted.message,
          attribution,
        );
      } else if (!taskOperation && !existingAssistant) {
        await upsertLiveChatMessage(
          ownerId,
          notification.chatId,
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text:
                  notification.outcome.result.text ||
                  "The agent completed without a message.",
                phase: "final_answer",
              },
            ],
            idempotencyKey: existingError ? errorKey : assistantKey,
          },
          attribution,
        );
      }
    } else if (
      notification.contextKind === "project" &&
      !taskChat &&
      !taskOperation &&
      !existingAssistant
    ) {
      await repository.updateChatExecutionLaneRuntime(
        notification.chatId,
        notification.executionLaneId,
        laneContext.lane.codexThreadId,
        "ready",
      );
      await upsertLiveChatMessage(
        ownerId,
        notification.chatId,
        {
          role: "system",
          content: [
            {
              type: "text",
              text: `Agent failed: ${notification.outcome.error}`,
            },
          ],
          idempotencyKey: errorKey,
        },
        attribution,
      );
    }

    await interruptLiveAgentInteractionRequests(notification.chatId);
    const finished = await repository.finishChatExecutionLane(
      notification.chatId,
      notification.executionLaneId,
      recoveredOutcomeOk ? "idle" : "failed",
    );
    let recoveredFailedStatus = false;
    if (!finished && notification.outcome.ok) {
      const current = await repository.getChatExecutionContext(
        ownerId,
        notification.chatId,
      );
      if (current?.status === "failed" && !current.executionLaneId) {
        await repository.setChatStatus(notification.chatId, "idle");
        recoveredFailedStatus = true;
      }
    }
    if (notification.contextKind === "project" && "worktree" in laneContext) {
      await notifyCodeAgentState(
        {
          chatId: notification.chatId,
          cwd: laneContext.worktree.path,
          workerId,
        },
        recoveredOutcomeOk ? "completed" : "failed",
      );
    }
    publishChatTurnBoundary(
      notification.chatId,
      laneContext.chat.projectId,
      laneContext.chat,
    );
    if (recoveredFinalizationOperationId && recoveredOutcomeOk) {
      try {
        await launchPreparedTaskGoal(
          notification.chatId,
          recoveredFinalizationOperationId,
        );
      } catch (error) {
        await failTaskGoalLaunch(
          notification.chatId,
          recoveredFinalizationOperationId,
          error,
        );
      }
    }
    app.log.info(
      {
        event: "chat.turn.outcome-recovered",
        subsystem: "chat-execution",
        operation: "recover-outcome",
        status: recoveredOutcomeOk ? "completed" : "failed",
        chatId: notification.chatId,
        clientMessageId: notification.clientMessageId,
        executionLaneId: notification.executionLaneId,
        outcome: notification.outcome.ok ? "completed" : "failed",
        ...(notification.outcome.ok
          ? {
              responseCharacterCount: notification.outcome.result.text.length,
              threadId: notification.outcome.result.threadId,
              turnId: notification.outcome.result.turnId,
            }
          : { reasonCode: "worker-reported-failure" }),
        workerId,
      },
      "Recovered agent turn outcome from worker",
    );
    if (finished || recoveredFailedStatus) {
      if (
        notification.contextKind === "standalone" ||
        !(await continuePendingWorktreeTransition(notification.chatId))
      ) {
        void dispatchNextQueuedPrompt(notification.chatId);
      }
    }
  }

  async function beginTurn(
    context: ChatExecutionContext,
    input: Omit<ChatTurnCreate, "attachmentIds" | "mode"> & {
      attachmentIds?: string[];
      customSubagentModel?: boolean;
      mode?: ChatTurnCreate["mode"];
      subagentModelId?: string | null;
      subagentReasoningEffort?: ReasoningEffort | null;
    },
    options: {
      acquiringActor?: "agent" | "user";
      encryptedTaskMessages?: {
        userMessage: TaskMessageOpaqueContent;
        response?: { id: string; idempotencyKey: string };
      };
      encryptedChatMessages?: {
        userMessage: ChatMessageOpaqueContent;
        response: { id: string; idempotencyKey: string };
      };
      messageRole?: "system" | "user";
      purpose?: string;
      retryMessageId?: string;
      runtimes?: ModelRuntime[];
      structuredResult?: {
        outputSchema?: WorkflowJsonObject;
        taskOperation?: TaskOperationRelayRequest;
        afterCompleted?(input: {
          attribution: ChatExecutionAttribution;
          execution: ChatExecutionContext;
          result: AgentTurnResult;
          userMessage: ChatMessage;
        }): Promise<void>;
        onCompleted(input: {
          attribution: ChatExecutionAttribution;
          execution: ChatExecutionContext;
          result: AgentTurnResult;
          userMessage: ChatMessage;
        }): Promise<void>;
        onFailed(input: {
          error: unknown;
          execution: ChatExecutionContext;
          userMessage: ChatMessage;
        }): Promise<void>;
      };
      afterTurnCompleted?(input: {
        attribution: ChatExecutionAttribution;
        execution: ChatExecutionContext;
        result: AgentTurnResult;
        userMessage: ChatMessage;
      }): Promise<void>;
      afterTurnFailed?(input: {
        error: unknown;
        execution: ChatExecutionContext;
        userMessage: ChatMessage;
      }): Promise<void>;
      workerPrompt?: string;
      taskDispatchLease?: TaskDispatchWorkerLease;
    } = {},
  ): Promise<ChatMessage> {
    const turnStartedAtMs = Date.now();
    const ownerId = applicationOwnerId();
    if (
      context.contextKind === "standalone" &&
      ((input.mode !== undefined && input.mode !== "default") ||
        options.structuredResult ||
        options.encryptedTaskMessages ||
        options.taskDispatchLease)
    ) {
      throw new Error(
        "Standalone Chat supports only ordinary default-mode conversation turns.",
      );
    }
    if (
      options.structuredResult &&
      Boolean(options.structuredResult.outputSchema) ===
        Boolean(options.structuredResult.taskOperation)
    ) {
      throw new Error("Structured turns require exactly one result contract.");
    }
    const encryptedTaskRelay = options.structuredResult?.taskOperation
      ? taskOperationRelayTurnFields(options.structuredResult.taskOperation)
      : null;
    const directTaskOperation =
      options.structuredResult?.taskOperation?.classification.kind === "direct";
    const encryptedTaskMessages = options.encryptedTaskMessages ?? null;
    let encryptedChatMessages = options.encryptedChatMessages ?? null;
    const modelId = await resolveModelId(context, input.modelId);
    const requestedReasoningEffort =
      input.reasoningEffort !== undefined
        ? input.reasoningEffort
        : context.reasoningEffort;
    const turnModelConfiguration = modelConfigurationSchema.parse({
      modelId,
      reasoningEffort: requestedReasoningEffort,
      customSubagentModel:
        context.contextKind === "standalone"
          ? false
          : (input.customSubagentModel ??
            context.modelConfiguration.customSubagentModel),
      subagentModelId:
        context.contextKind === "standalone"
          ? null
          : input.subagentModelId !== undefined
            ? input.subagentModelId
            : context.modelConfiguration.subagentModelId,
      subagentReasoningEffort:
        context.contextKind === "standalone"
          ? null
          : input.subagentReasoningEffort !== undefined
            ? input.subagentReasoningEffort
            : context.modelConfiguration.subagentReasoningEffort,
    });
    const routePairs = await routePairsForConfiguration(
      context,
      turnModelConfiguration,
      options.runtimes,
    );
    const preparedRuntimes = routePairs.map(({ root }) => root);
    const runtimes = preparedRuntimes.map(({ runtime }) => runtime);
    const attachments = await resolvePromptAttachments(
      context,
      input.attachmentIds ?? [],
    );
    const turnMode = input.mode ?? "default";
    const turnPlanMode = turnMode === "plan" ? "plan" : "default";
    if (
      context.experience === "agent" &&
      !encryptedChatMessages &&
      !options.structuredResult
    ) {
      const userMessage = chatMessageOpaqueContentSchema.parse(
        await bridge.request(context.workerId, {
          type: "chat.message.protect",
          message: {
            id: randomUUID(),
            role: options.messageRole ?? "user",
            mode: turnMode,
            reasoningEffort: requestedReasoningEffort,
            content: [
              ...(input.text
                ? [{ type: "text" as const, text: input.text }]
                : []),
              ...attachments.map((attachment) => ({
                type: "attachment" as const,
                attachment: {
                  id: attachment.id,
                  chatId: attachment.chatId,
                  fileName: "Protected attachment",
                  mimeType: "application/octet-stream",
                  sizeBytes: attachment.sizeBytes,
                  kind: "file" as const,
                  source: "file" as const,
                  status: attachment.status,
                  previewText: null,
                  createdAt: attachment.createdAt,
                },
              })),
            ],
            idempotencyKey: input.idempotencyKey,
          },
          attachments: attachments.map((attachment) =>
            toChatAttachmentOpaqueSummary(attachment),
          ),
        }),
      );
      encryptedChatMessages = {
        userMessage,
        response: {
          id: randomUUID(),
          idempotencyKey: `assistant:${userMessage.id}`,
        },
      };
    }
    const effectivePolicies =
      context.contextKind === "project"
        ? await repository.policies.resolveEffective(ownerId, context.projectId)
        : { policies: [] };
    const standalonePolicies =
      context.contextKind === "standalone"
        ? await repository.policies.resolveStandalone(ownerId)
        : { policies: [] };
    if (context.contextKind === "project" && !effectivePolicies) {
      throw new Error("The chat project is no longer available.");
    }
    if (
      context.contextKind === "project" &&
      (!options.structuredResult || directTaskOperation)
    ) {
      await prepareCodeEditorsForTurn(context);
    }
    const mcpServers =
      options.structuredResult && !directTaskOperation
        ? []
        : await repository.listEffectiveMcpServers(
            ownerId,
            context.contextKind === "project" ? context.projectId : null,
            context.workerId,
            context.contextKind === "project" ? "ide" : "chat",
          );
    const execution = await repository.startChatExecutionLane(
      ownerId,
      context.chatId,
      options.acquiringActor ?? "user",
      options.purpose ?? "Chat turn",
    );
    if (!execution || !execution.executionLaneId) {
      throw new Error("Chat execution lane could not be acquired.");
    }
    publishChatSummary(execution.chatId, execution.projectId);
    const executionLaneId = execution.executionLaneId;
    const attribution: ChatExecutionAttribution =
      execution.contextKind === "project"
        ? {
            contextKind: "project",
            executionLaneId,
            worktreeId: execution.worktreeId,
            scratchRootId: null,
          }
        : {
            contextKind: "standalone",
            executionLaneId,
            worktreeId: null,
            scratchRootId: execution.scratchRootId,
          };
    let priorMessages: ChatMessage[] = [];
    let protectedHistory: ChatMessageOpaqueSummary[] = [];
    let protectedPlan = null;
    let userMessage: ChatMessage;
    let immediateCorrectiveFollowup = false;
    try {
      if (options.retryMessageId) {
        const retryRuntime = runtimes[0]!;
        if (
          !execution.threadId ||
          !runtimeCanResumeContext(execution, retryRuntime)
        ) {
          throw new Error(
            "The original Codex runtime is unavailable for this message.",
          );
        }
        const rollback = chatTurnRollbackAcceptedSchema.parse(
          await bridge.request(execution.workerId, {
            type: "chat.turn.rollback",
            executionProfile:
              execution.contextKind === "standalone"
                ? "standalone-chat"
                : "ide",
            chatId: execution.chatId,
            clientMessageId: options.retryMessageId,
            cwd: execution.cwd,
            threadId: execution.threadId,
            model: retryRuntime.model,
            provider: retryRuntime.provider,
            permissionProfileId:
              effectivePermissionProfile(execution).effectiveId,
          }),
        );
        if (!rollback.rolledBack) {
          throw new Error("The previous Codex turn could not be rolled back.");
        }
        const trimmed = await repository.trimLatestEncryptedTurn(
          ownerId,
          execution.chatId,
          options.retryMessageId,
        );
        if (!trimmed) {
          throw new Error(
            "Only the latest user message can be edited and sent again.",
          );
        }
      }
      await updateLiveChatPlanMode(ownerId, execution.chatId, turnPlanMode);
      const priorHeaders = await repository.listMessageHeaders(
        ownerId,
        execution.chatId,
      );
      for (let index = priorHeaders.length - 1; index >= 0; index -= 1) {
        const message = priorHeaders[index]!;
        if (message.role !== "assistant") continue;
        const elapsedMs = turnStartedAtMs - Date.parse(message.createdAt);
        immediateCorrectiveFollowup =
          Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 120_000;
        break;
      }
      if (encryptedChatMessages) {
        protectedHistory = await repository.listEncryptedMessages(
          ownerId,
          execution.chatId,
        );
        protectedPlan = await repository.getEncryptedChatPlanState(
          ownerId,
          execution.chatId,
        );
        const appended = await appendLiveEncryptedChatMessage(
          ownerId,
          execution.chatId,
          encryptedChatMessages.userMessage,
          attribution,
        );
        if (!appended) throw new Error("Encrypted Chat not found.");
        userMessage = taskMessageServerStub(appended);
        await setLiveEncryptedChatMessageModelRoute(
          ownerId,
          userMessage.id,
          modelId,
          runtimes[0]!,
          {
            appliedReasoningEffort: preparedRuntimes[0]!.appliedReasoningEffort,
            reasoningAdjusted: preparedRuntimes[0]!.adjusted,
          },
        );
      } else if (encryptedTaskMessages) {
        const appended = await appendLiveTaskMessage(
          ownerId,
          execution.chatId,
          encryptedTaskMessages.userMessage,
          attribution,
          execution,
        );
        if (!appended) throw new Error("Encrypted Task Chat not found.");
        userMessage = taskMessageServerStub(appended);
        await setLiveTaskMessageModelRoute(
          ownerId,
          userMessage.id,
          modelId,
          runtimes[0]!,
          {
            appliedReasoningEffort: preparedRuntimes[0]!.appliedReasoningEffort,
            reasoningAdjusted: preparedRuntimes[0]!.adjusted,
          },
          execution,
        );
      } else {
        throw new Error("Chat turn content was not encrypted.");
      }
      app.log.info(
        {
          event: "chat.turn.accepted",
          subsystem: "chat-execution",
          operation: "turn",
          status: "accepted",
          chatId: execution.chatId,
          clientMessageId: userMessage.id,
          executionLaneId,
          modelId,
          providerAccountId: runtimes[0]!.provider.accountId,
          providerId: runtimes[0]!.provider.id,
          workerId: execution.workerId,
          projectId: execution.projectId,
        },
        "Agent turn accepted",
      );
      if (options.taskDispatchLease) {
        await repository.taskDispatch.markRunning(options.taskDispatchLease);
      }
    } catch (error) {
      await repository.finishChatExecutionLane(
        execution.chatId,
        executionLaneId,
        "failed",
      );
      publishChatSummary(execution.chatId, execution.projectId);
      throw error;
    }

    const attributedWorker = await repository.getWorker(
      ownerId,
      execution.workerId,
    );
    void runAsOwner(ownerId, async () => {
      let anyActivity = false;
      let workerObservationSequence = 0;
      const observationIdentity = (
        event: WorkerEvent,
      ): WorkerObservationEventIdentity => {
        const sequence =
          event.type === "agent.inference-progress"
            ? event.progress.sequence
            : workerObservationSequence;
        if (
          event.type !== "agent.inference-progress" &&
          workerEventIsProvisional(event)
        ) {
          workerObservationSequence += 1;
        }
        return {
          operationId: userMessage.id,
          turnId: workerObservationTurnId(event),
          messageId: workerObservationMessageId(event),
          sequence,
        };
      };
      const changedPaths = new Set<string>();
      const taskDispatchHeartbeat = options.taskDispatchLease
        ? setInterval(
            () => {
              void repository.taskDispatch
                .heartbeat(options.taskDispatchLease!)
                .catch((error) => {
                  if (error instanceof TaskDispatchConflictError) return;
                  app.log.warn(
                    { chatId: execution.chatId, err: error },
                    "Could not renew the Task dispatch lease",
                  );
                });
            },
            Math.floor(TASK_DISPATCH_LEASE_MS / 3),
          )
        : null;
      taskDispatchHeartbeat?.unref();
      try {
        if (execution.contextKind === "project") {
          await notifyCodeAgentState(execution, "started");
        }
        for (const [index, runtime] of runtimes.entries()) {
          const executionAttemptId = `${userMessage.id}:${runtime.routeId}:${index}`;
          const tokenUsageSourceKey = `chat-attempt:${executionAttemptId}`;
          const behaviorSourceKey = `chat-attempt:${executionAttemptId}`;
          const behaviorTracker = new ModelBehaviorTracker();
          const attemptStartedAt = new Date();
          let quotaFollowupsScheduled = false;
          const attemptStartedAtMs = Date.now();
          let behaviorTurnId: string | null = null;
          const preparedReasoning = preparedRuntimes[index]!;
          const subagentRuntime = routePairs[index]!.subagent?.runtime ?? null;
          const recordChildAgentTime = async (
            telemetry:
              | {
                  agentThreadId: string;
                  completedAtMs: number | null;
                  isRoot: boolean;
                  startedAtMs: number | null;
                  status: "running" | "completed" | "failed";
                }
              | null
              | undefined,
            childTurnId: string | null,
          ) => {
            if (!telemetry || telemetry.isRoot || !childTurnId) return;
            const childExecutionAttemptId = `${executionAttemptId}:subagent:${telemetry.agentThreadId}:${childTurnId}`;
            const dateFromTelemetry = (value: number | null) => {
              if (value === null) return undefined;
              const date = new Date(value);
              return Number.isNaN(date.getTime()) ? undefined : date;
            };
            const startedAt = dateFromTelemetry(telemetry.startedAtMs);
            const completedAt =
              telemetry.status === "running"
                ? null
                : (dateFromTelemetry(telemetry.completedAtMs) ?? new Date());
            await recordRuntimeTokenUsage(
              `chat-subagent:${childExecutionAttemptId}`,
              execution.projectId,
              execution.chatId,
              subagentRuntime ?? runtime,
              undefined,
              {
                workerId: execution.workerId,
                turnId: childTurnId,
                executionAttemptId: childExecutionAttemptId,
                attemptKind: "subagent-turn",
                attemptStatus: telemetry.status,
                startedAt,
                completedAt,
                finalizedAt: completedAt,
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
          };
          let attemptActivity = false;
          const canResume = runtimeCanResumeContext(execution, runtime);
          const threadId = canResume ? execution.threadId : null;
          const finals = createStreamedFinalTracker();
          const requestedPrompt =
            encryptedTaskRelay?.prompt ??
            options.workerPrompt ??
            (input.text ||
              "Review the attached files and respond to the user.");
          const workerPrompt = encryptedTaskRelay
            ? encryptedTaskRelay.prompt
            : threadId
              ? requestedPrompt
              : continuationPrompt(priorMessages, requestedPrompt);
          if (index > 0) {
            const setRoute = encryptedChatMessages
              ? setLiveEncryptedChatMessageModelRoute
              : encryptedTaskMessages
                ? setLiveTaskMessageModelRoute
                : setLiveChatMessageModelRoute;
            await setRoute(ownerId, userMessage.id, modelId, runtime, {
              appliedReasoningEffort: preparedReasoning.appliedReasoningEffort,
              reasoningAdjusted: preparedReasoning.adjusted,
            });
          }
          if (
            !encryptedTaskMessages &&
            !encryptedChatMessages &&
            preparedReasoning.adjusted &&
            requestedReasoningEffort
          ) {
            await appendLiveChatMessage(
              ownerId,
              execution.chatId,
              {
                role: "system",
                content: [
                  {
                    type: "activity",
                    activity: {
                      id: `reasoning-adjustment:${userMessage.id}:${runtime.routeId}`,
                      type: "notice",
                      status: "completed",
                      level: "warning",
                      message: `${runtime.provider.name} does not advertise ${requestedReasoningEffort} reasoning for ${runtime.model.name}; this attempt uses the provider default.`,
                      details: null,
                      willRetry: null,
                    },
                  },
                ],
                idempotencyKey: `reasoning-adjustment:${userMessage.id}:${runtime.routeId}:${runtime.provider.accountId ?? "provider"}`,
              },
              attribution,
            );
          }
          await repository.updateChatRuntime(
            execution.chatId,
            execution.workerId,
            execution.worktreeId,
            threadId,
            runtime.routeId,
            "starting",
            runtime.provider.accountId,
            execution.scratchRootId,
          );
          captureRuntimeQuota(
            runtime,
            execution,
            index > 0 &&
              runtimes[index - 1]?.provider.accountId !==
                runtime.provider.accountId
              ? "account-switch"
              : "turn-starting",
            executionAttemptId,
          );
          await recordRuntimeTokenUsage(
            tokenUsageSourceKey,
            execution.projectId,
            execution.chatId,
            runtime,
            undefined,
            {
              workerId: execution.workerId,
              executionAttemptId,
              attemptKind: "chat-turn",
              attemptStatus: "running",
              startedAt: attemptStartedAt,
              codexVersion: attributedWorker?.codexVersion ?? null,
            },
          );
          await recordRuntimeModelBehavior(
            behaviorSourceKey,
            execution,
            runtime,
            behaviorTracker,
            {
              executionAttemptId,
              attemptStatus: "running",
              routeAttemptIndex: index,
              retryFailoverCount: index,
              startedAt: attemptStartedAt,
              immediateCorrectiveFollowup,
              userRetryRegeneration: Boolean(options.retryMessageId),
              codexVersion: attributedWorker?.codexVersion ?? null,
            },
          );
          try {
            app.log.debug(
              {
                event: "chat.turn.route-dispatched",
                subsystem: "chat-execution",
                operation: "turn",
                status: "dispatching",
                chatId: execution.chatId,
                projectId: execution.projectId,
                workerId: execution.workerId,
                requestId: userMessage.id,
                runId: executionLaneId,
                attempt: index + 1,
                counts: { candidateRoutes: runtimes.length },
                providerId: runtime.provider.id,
                providerAccountId: runtime.provider.accountId,
                routeId: runtime.routeId,
              },
              "Agent turn route dispatched",
            );
            const rawResult = await bridge.request(
              execution.workerId,
              {
                type: "chat.turn",
                executionProfile:
                  execution.contextKind === "standalone"
                    ? "standalone-chat"
                    : "ide",
                contextKind: execution.contextKind,
                chatId: execution.chatId,
                clientMessageId: userMessage.id,
                cwd: execution.cwd,
                executionLaneId,
                worktreeId: execution.worktreeId,
                scratchRootId: execution.scratchRootId,
                rootKind: execution.rootKind,
                threadId,
                isPrimary: execution.isPrimary,
                worktreeMode: execution.worktreeMode,
                worktreePolicy: execution.worktreePolicy,
                policyProjectId: execution.projectId,
                policies: effectivePolicies ?? { policies: [] },
                standalonePolicies,
                ...(encryptedChatMessages
                  ? {
                      protectedPrompt: encryptedChatMessages.userMessage,
                      protectedHistory,
                      protectedPlan,
                    }
                  : {
                      prompt: workerPrompt,
                      protectedHistory: [],
                      protectedPlan: null,
                    }),
                attachments: attachments.map((attachment) =>
                  toChatAttachmentOpaqueSummary(attachment),
                ),
                skillNames:
                  execution.contextKind === "standalone" ||
                  options.structuredResult ||
                  encryptedChatMessages
                    ? []
                    : mentionedSkillNames(input.text),
                chatSkillAudienceKeys:
                  execution.contextKind === "standalone"
                    ? await repository.listChatSkillAudienceKeys(
                        ownerId,
                        execution.workerId,
                        runtime.provider.id,
                      )
                    : [],
                model: runtime.model,
                provider: runtime.provider,
                subagentDefaults:
                  execution.contextKind === "project" && subagentRuntime
                    ? {
                        model: subagentRuntime.model,
                        provider: subagentRuntime.provider,
                      }
                    : null,
                ...(execution.contextKind === "project" &&
                attributedWorker &&
                nativeSubagentCapabilityCompatible(
                  attributedWorker.codexRuntime.nativeSubagents,
                )
                  ? {
                      subagentProtocolVersion: NATIVE_SUBAGENT_PROTOCOL_VERSION,
                    }
                  : {}),
                permissionProfileId:
                  effectivePermissionProfile(execution).effectiveId,
                planMode: turnPlanMode,
                mcpServers,
                automationPaused: execution.automationPaused,
                resultMode: options.structuredResult
                  ? (encryptedTaskRelay?.resultMode ?? {
                      kind: "structured" as const,
                      outputSchema: options.structuredResult.outputSchema!,
                    })
                  : encryptedTaskMessages?.response
                    ? {
                        kind: "task-message-encrypted" as const,
                        messageId: encryptedTaskMessages.response.id,
                        idempotencyKey:
                          encryptedTaskMessages.response.idempotencyKey,
                      }
                    : encryptedChatMessages
                      ? {
                          kind: "chat-message-encrypted" as const,
                          messageId: encryptedChatMessages.response.id,
                          idempotencyKey:
                            encryptedChatMessages.response.idempotencyKey,
                        }
                      : { kind: "visible" },
                taskDispatchLease: options.taskDispatchLease,
              },
              {
                timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
                onEvent: (event) =>
                  runAsOwner(ownerId, async () => {
                    const observedAt = new Date();
                    const sourceEvent = observationIdentity(event);
                    behaviorTracker.markActivity(observedAt);
                    attemptActivity = true;
                    anyActivity = true;
                    if (execution.contextKind === "standalone") {
                      const protectedAgentRuntime =
                        (event.type === "agent.protected-message" ||
                          event.type === "agent.protected-task-message") &&
                        event.telemetry.kind === "activity"
                          ? event.telemetry.agentRuntime
                          : null;
                      const visibleAgentScope =
                        event.type === "agent.activity"
                          ? event.activity.agentScope
                          : null;
                      if (
                        (protectedAgentRuntime &&
                          !protectedAgentRuntime.isRoot) ||
                        (visibleAgentScope && !visibleAgentScope.isRoot)
                      ) {
                        throw new Error(
                          "Standalone Chat runtime emitted child-agent lifecycle activity.",
                        );
                      }
                    }
                    if (event.type === "agent.inference-progress") {
                      if (event.progress.requestId !== userMessage.id) return;
                      publishInferenceProgress(
                        execution.chatId,
                        event.progress,
                      );
                      return;
                    }
                    if (event.type === "agent.interaction.requested") {
                      if (encryptedChatMessages) {
                        try {
                          await bridge.request(execution.workerId, {
                            type: "agent.interaction.cancel",
                            executionProfile:
                              execution.contextKind === "standalone"
                                ? "standalone-chat"
                                : "ide",
                            requestKey: event.request.requestKey,
                            reason:
                              "Encrypted chat interactions must use the protected contract.",
                            model: runtime.model,
                            provider: runtime.provider,
                          });
                        } catch {
                          // The turn failure below remains fail closed.
                        }
                        throw new Error(
                          "The worker emitted a visible interaction for an encrypted chat turn.",
                        );
                      }
                      behaviorTurnId = event.request.turnId ?? behaviorTurnId;
                      behaviorTracker.markApproval(
                        event.request.requestKey,
                        observedAt,
                      );
                      try {
                        await recordLiveAgentInteractionRequest({
                          requestKey: event.request.requestKey,
                          projectId: execution.projectId,
                          provenance: {
                            chatId: execution.chatId,
                            threadId: event.request.threadId,
                            turnId: event.request.turnId,
                            itemId: event.request.itemId,
                            executionLaneId,
                            workflowRunId: null,
                            workflowNodeId: null,
                            workerId: execution.workerId,
                          },
                          payload: event.request.payload,
                          expiresAt: event.request.expiresAt,
                        });
                      } catch (error) {
                        try {
                          await bridge.request(execution.workerId, {
                            type: "agent.interaction.cancel",
                            executionProfile:
                              execution.contextKind === "standalone"
                                ? "standalone-chat"
                                : "ide",
                            requestKey: event.request.requestKey,
                            reason:
                              "Cantrip could not persist the interaction safely.",
                            model: runtime.model,
                            provider: runtime.provider,
                          });
                        } catch {
                          // The turn failure below remains fail closed.
                        }
                        throw error;
                      }
                      return;
                    }
                    if (
                      event.type === "agent.interaction.requested.protected"
                    ) {
                      behaviorTurnId = event.request.turnId ?? behaviorTurnId;
                      behaviorTracker.markApproval(
                        event.request.requestKey,
                        observedAt,
                      );
                      try {
                        await recordLiveEncryptedAgentInteractionRequest({
                          requestKey: event.request.requestKey,
                          projectId: execution.projectId,
                          provenance: {
                            chatId: execution.chatId,
                            threadId: event.request.threadId,
                            turnId: event.request.turnId,
                            itemId: event.request.itemId,
                            executionLaneId,
                            workflowRunId: null,
                            workflowNodeId: null,
                            workerId: execution.workerId,
                          },
                          classification: event.request.classification,
                          protectedPayload: event.request.protectedPayload,
                          expiresAt: event.request.expiresAt,
                        });
                      } catch (error) {
                        try {
                          await bridge.request(execution.workerId, {
                            type: "agent.interaction.cancel",
                            executionProfile:
                              execution.contextKind === "standalone"
                                ? "standalone-chat"
                                : "ide",
                            requestKey: event.request.requestKey,
                            reason:
                              "Cantrip could not persist the protected interaction safely.",
                            model: runtime.model,
                            provider: runtime.provider,
                          });
                        } catch {
                          // The turn failure below remains fail closed.
                        }
                        throw error;
                      }
                      return;
                    }
                    if (
                      event.type === "agent.interaction.cleared" ||
                      event.type === "agent.interaction.expired"
                    ) {
                      await terminalizeLiveAgentInteractionRequest(
                        event.requestKey,
                        execution.chatId,
                        execution.workerId,
                        event.type === "agent.interaction.expired"
                          ? "expired"
                          : "interrupted",
                      );
                      return;
                    }
                    if (event.type === "agent.protected-task-message") {
                      if (!encryptedTaskRelay && !encryptedTaskMessages) {
                        throw new Error(
                          "Received a protected Task event for a non-Task turn.",
                        );
                      }
                      behaviorTurnId = event.telemetry.turnId ?? behaviorTurnId;
                      if (event.telemetry.kind === "activity") {
                        await recordChildAgentTime(
                          event.telemetry.agentRuntime,
                          event.telemetry.turnId,
                        );
                      }
                      if (event.telemetry.kind === "message") {
                        const completedFinal =
                          event.telemetry.phase !== "commentary" &&
                          !event.telemetry.streaming;
                        behaviorTracker.markVisibleResponse(
                          completedFinal,
                          observedAt,
                        );
                        if (completedFinal) {
                          recordFinal(
                            finals,
                            event.telemetry.turnId,
                            event.message.id,
                          );
                        }
                      } else if (event.telemetry.kind === "usage") {
                        behaviorTracker.observeUsage(
                          {
                            inputTokens: event.telemetry.usage.inputTokens,
                            cachedInputTokens:
                              event.telemetry.usage.cachedInputTokens,
                            cacheWriteInputTokens:
                              event.telemetry.usage.cacheWriteInputTokens,
                            outputTokens: event.telemetry.usage.outputTokens,
                            reasoningOutputTokens:
                              event.telemetry.usage.reasoningOutputTokens,
                            modelContextWindow:
                              event.telemetry.modelContextWindow,
                            contextUsedPercent:
                              event.telemetry.contextUsedPercent,
                          },
                          observedAt,
                        );
                        await recordRuntimeTokenUsage(
                          tokenUsageSourceKey,
                          execution.projectId,
                          execution.chatId,
                          runtime,
                          event.telemetry.usage,
                          {
                            workerId: execution.workerId,
                            turnId:
                              event.telemetry.turnId ??
                              behaviorTurnId ??
                              event.message.id,
                            executionAttemptId,
                            attemptKind: "chat-turn",
                            attemptStatus: "running",
                            codexVersion:
                              attributedWorker?.codexVersion ?? null,
                          },
                        );
                      } else if (event.telemetry.kind === "activity") {
                        behaviorTracker.markActivity(observedAt);
                      }
                      const saved = await upsertLiveTaskMessage(
                        ownerId,
                        execution.chatId,
                        event.message,
                        attribution,
                        execution,
                      );
                      if (!saved) {
                        throw new Error("Encrypted Task message was rejected.");
                      }
                      return;
                    }
                    if (event.type === "agent.protected-message") {
                      behaviorTurnId = event.telemetry.turnId ?? behaviorTurnId;
                      if (event.telemetry.kind === "activity") {
                        await recordChildAgentTime(
                          event.telemetry.agentRuntime,
                          event.telemetry.turnId,
                        );
                      }
                      if (event.telemetry.kind === "message") {
                        const completedFinal =
                          event.telemetry.phase !== "commentary" &&
                          !event.telemetry.streaming;
                        behaviorTracker.markVisibleResponse(
                          completedFinal,
                          observedAt,
                        );
                        if (completedFinal) {
                          recordFinal(
                            finals,
                            event.telemetry.turnId,
                            event.message.id,
                          );
                        }
                      } else if (event.telemetry.kind === "usage") {
                        behaviorTracker.observeUsage(
                          {
                            inputTokens: event.telemetry.usage.inputTokens,
                            cachedInputTokens:
                              event.telemetry.usage.cachedInputTokens,
                            cacheWriteInputTokens:
                              event.telemetry.usage.cacheWriteInputTokens,
                            outputTokens: event.telemetry.usage.outputTokens,
                            reasoningOutputTokens:
                              event.telemetry.usage.reasoningOutputTokens,
                            modelContextWindow:
                              event.telemetry.modelContextWindow,
                            contextUsedPercent:
                              event.telemetry.contextUsedPercent,
                          },
                          observedAt,
                        );
                        await recordRuntimeTokenUsage(
                          tokenUsageSourceKey,
                          execution.projectId,
                          execution.chatId,
                          runtime,
                          event.telemetry.usage,
                          {
                            workerId: execution.workerId,
                            turnId:
                              event.telemetry.turnId ??
                              behaviorTurnId ??
                              event.message.id,
                            executionAttemptId,
                            attemptKind: "chat-turn",
                            attemptStatus: "running",
                            codexVersion:
                              attributedWorker?.codexVersion ?? null,
                          },
                        );
                      } else if (event.telemetry.kind === "activity") {
                        behaviorTracker.markActivity(observedAt);
                      } else {
                        behaviorTracker.markVisibleResponse(true, observedAt);
                        recordFinal(
                          finals,
                          event.telemetry.turnId,
                          event.message.id,
                        );
                      }
                      const saved = await upsertLiveEncryptedChatMessage(
                        ownerId,
                        execution.chatId,
                        event.message,
                        attribution,
                      );
                      if (!saved) {
                        throw new Error("Encrypted Chat message was rejected.");
                      }
                      return;
                    }
                    if (event.type === "agent.message") {
                      const turnId = event.message.correlation?.turnId;
                      behaviorTurnId = turnId ?? behaviorTurnId;
                      const completedFinal =
                        event.message.phase !== "commentary" &&
                        !event.message.streaming;
                      if (event.message.text.trim()) {
                        behaviorTracker.markVisibleResponse(
                          completedFinal,
                          observedAt,
                        );
                      }
                      if (
                        options.structuredResult &&
                        event.message.phase !== "commentary"
                      ) {
                        return;
                      }
                      await upsertLiveChatMessage(
                        ownerId,
                        execution.chatId,
                        {
                          role: "assistant",
                          content: [
                            {
                              type: "text",
                              text: event.message.text,
                              phase: event.message.phase,
                              ...(event.message.streaming
                                ? { streaming: true }
                                : {}),
                              correlation: event.message.correlation,
                              sourceEvent,
                            },
                          ],
                          idempotencyKey: `agent-message:${turnId ?? userMessage.id}:${event.message.id}`,
                        },
                        attribution,
                      );
                      if (completedFinal) {
                        recordFinal(finals, turnId, event.message.text);
                      }
                      return;
                    }
                    if (event.type === "agent.checkpoint") {
                      if (options.structuredResult) return;
                      if (!event.text.trim()) return;
                      if (finals.turnIds.has(event.turnId)) return;
                      behaviorTurnId = event.turnId;
                      behaviorTracker.markVisibleResponse(true, observedAt);
                      await upsertLiveChatMessage(
                        ownerId,
                        execution.chatId,
                        {
                          role: "assistant",
                          content: [
                            {
                              type: "text",
                              text: event.text,
                              phase: "final_answer",
                            },
                          ],
                          idempotencyKey: `goal-checkpoint:${userMessage.id}:${event.turnId}`,
                        },
                        attribution,
                      );
                      return;
                    }
                    if (event.type === "agent.plan.protected") {
                      if (!encryptedChatMessages) {
                        throw new Error(
                          "Received protected Plan Mode state for a non-chat-encrypted turn.",
                        );
                      }
                      await updateLiveEncryptedChatPlanState(
                        execution.chatId,
                        event.state,
                      );
                      return;
                    }
                    if (event.type === "agent.plan.updated") {
                      throw new Error(
                        "Worker emitted plaintext Plan Mode state.",
                      );
                    }
                    if (event.type === "agent.plan.question") {
                      throw new Error(
                        "Worker emitted a plaintext Plan Mode question.",
                      );
                    }
                    if (event.type === "agent.plan.question-resolved") {
                      throw new Error(
                        "Worker emitted a plaintext Plan Mode resolution.",
                      );
                    }
                    if (event.type !== "agent.activity") return;
                    behaviorTurnId =
                      event.activity.correlation?.turnId ?? behaviorTurnId;
                    if (
                      event.activity.type === "turnSummary" &&
                      event.activity.agentScope
                    ) {
                      await recordChildAgentTime(
                        {
                          agentThreadId:
                            event.activity.agentScope.agentThreadId,
                          isRoot: event.activity.agentScope.isRoot,
                          startedAtMs:
                            event.activity.startedAt === null
                              ? null
                              : event.activity.startedAt * 1_000,
                          completedAtMs:
                            event.activity.completedAt === null
                              ? null
                              : event.activity.completedAt * 1_000,
                          status:
                            event.activity.status === "running"
                              ? "running"
                              : event.activity.status === "completed"
                                ? "completed"
                                : "failed",
                        },
                        event.activity.correlation?.turnId ?? null,
                      );
                    }
                    behaviorTracker.observeActivity(event.activity, observedAt);
                    if (event.activity.type === "usage") {
                      const usageTurnId =
                        event.activity.correlation?.turnId ?? event.activity.id;
                      await recordRuntimeTokenUsage(
                        tokenUsageSourceKey,
                        execution.projectId,
                        execution.chatId,
                        runtime,
                        event.activity.last,
                        {
                          workerId: execution.workerId,
                          turnId: usageTurnId,
                          executionAttemptId,
                          attemptKind: "chat-turn",
                          attemptStatus: "running",
                          codexVersion: attributedWorker?.codexVersion ?? null,
                        },
                      );
                    }
                    if (
                      event.activity.type === "rateLimit" &&
                      runtime.provider.accountId
                    ) {
                      await persistProviderRateLimitActivity(
                        repository,
                        {
                          ownerId,
                          providerId: runtime.provider.id,
                          accountId: runtime.provider.accountId,
                          accountPlanType: event.activity.planType,
                          workerId: execution.workerId,
                          trigger: "live-rate-limit-update",
                          chatId: execution.chatId,
                          turnId: event.activity.correlation?.turnId ?? null,
                          executionAttemptId,
                        },
                        event.activity,
                      ).catch((error) => {
                        app.log.warn(
                          {
                            accountId: runtime.provider.accountId,
                            err: error,
                            providerId: runtime.provider.id,
                          },
                          "Unable to persist provider quota observation",
                        );
                      });
                    }
                    if (event.activity.type === "fileChange") {
                      for (const change of event.activity.changes) {
                        changedPaths.add(change.path);
                      }
                    }
                    await upsertLiveChatMessage(
                      ownerId,
                      execution.chatId,
                      {
                        role: "assistant",
                        content: [
                          {
                            type: "activity",
                            activity: event.activity,
                            sourceEvent,
                          },
                        ],
                        idempotencyKey:
                          event.activity.type === "worktree"
                            ? event.activity.id
                            : `activity:${userMessage.id}:${event.activity.id}`,
                      },
                      attribution,
                    );
                  }),
              },
            );
            cancelChatTurnOutcomeRecovery(
              execution.workerId,
              execution.chatId,
              userMessage.id,
            );
            const result = agentTurnResultSchema.parse(rawResult);
            const completedAt = new Date();
            behaviorTurnId = result.turnId ?? behaviorTurnId;
            if (result.text.trim()) {
              behaviorTracker.markVisibleResponse(true, completedAt);
            }
            await recordRuntimeTokenUsage(
              tokenUsageSourceKey,
              execution.projectId,
              execution.chatId,
              runtime,
              result.measuredUsage ?? undefined,
              {
                workerId: execution.workerId,
                turnId: result.turnId ?? null,
                executionAttemptId,
                attemptKind: "chat-turn",
                attemptStatus: "completed",
                completedAt,
                finalizedAt: completedAt,
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
            await recordRuntimeModelBehavior(
              behaviorSourceKey,
              execution,
              runtime,
              behaviorTracker,
              {
                executionAttemptId,
                attemptStatus: "completed",
                routeAttemptIndex: index,
                retryFailoverCount: index,
                startedAt: attemptStartedAt,
                completedAt,
                finalizedAt: completedAt,
                durationMs: completedAt.getTime() - attemptStartedAtMs,
                turnId: behaviorTurnId,
                immediateCorrectiveFollowup,
                userRetryRegeneration: Boolean(options.retryMessageId),
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
            scheduleRuntimeQuotaSamples(
              runtime,
              execution,
              executionAttemptId,
              result.turnId ?? null,
            );
            quotaFollowupsScheduled = true;
            if (execution.contextKind === "project") {
              await notifyCodeAgentState(execution, "completed", changedPaths);
            }
            routeCooldowns.delete(runtimeCooldownKey(runtime));
            await repository.updateChatRuntime(
              execution.chatId,
              execution.workerId,
              execution.worktreeId,
              result.threadId,
              runtime.routeId,
              "ready",
              runtime.provider.accountId,
              execution.scratchRootId,
            );
            if (options.structuredResult) {
              await options.structuredResult.onCompleted({
                attribution,
                execution,
                result,
                userMessage,
              });
            } else if (encryptedTaskMessages?.response) {
              const encryptedResult = taskMessageRelayResultSchema.parse(
                result.structuredResult,
              );
              if (
                encryptedResult.message.id !==
                  encryptedTaskMessages.response.id ||
                encryptedResult.message.idempotencyKey !==
                  encryptedTaskMessages.response.idempotencyKey
              ) {
                throw new Error(
                  "The encrypted Task message result metadata is invalid.",
                );
              }
              if (!hasFinal(finals, result.turnId, result.text)) {
                const assistant = await appendLiveTaskMessage(
                  ownerId,
                  execution.chatId,
                  encryptedResult.message,
                  attribution,
                  execution,
                );
                if (!assistant) {
                  throw new Error("Encrypted Task Chat not found.");
                }
                await setLiveTaskMessageModelRoute(
                  ownerId,
                  assistant.id,
                  modelId,
                  runtime,
                  undefined,
                  execution,
                );
              }
            } else if (encryptedChatMessages) {
              const encryptedResult = chatMessageRelayResultSchema.parse(
                result.structuredResult,
              );
              if (
                !encryptedResult.message ||
                encryptedResult.message.id !==
                  encryptedChatMessages.response.id ||
                encryptedResult.message.idempotencyKey !==
                  encryptedChatMessages.response.idempotencyKey
              ) {
                throw new Error(
                  "The encrypted chat message result metadata is invalid.",
                );
              }
              if (!hasFinal(finals, result.turnId, result.text)) {
                const assistant = await appendLiveEncryptedChatMessage(
                  ownerId,
                  execution.chatId,
                  encryptedResult.message,
                  attribution,
                );
                if (!assistant) throw new Error("Encrypted Chat not found.");
                await setLiveEncryptedChatMessageModelRoute(
                  ownerId,
                  assistant.id,
                  modelId,
                  runtime,
                );
              }
            } else if (!hasFinal(finals, result.turnId, result.text)) {
              await appendLiveChatMessage(
                ownerId,
                execution.chatId,
                {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text:
                        result.text || "The agent completed without a message.",
                      phase: "final_answer",
                    },
                  ],
                  idempotencyKey: `assistant:${userMessage.id}`,
                },
                attribution,
              );
            }
            await interruptLiveAgentInteractionRequests(execution.chatId);
            const finished = await repository.finishChatExecutionLane(
              execution.chatId,
              executionLaneId,
              "idle",
            );
            publishChatTurnBoundary(
              execution.chatId,
              execution.projectId,
              execution,
            );
            if (options.structuredResult?.afterCompleted) {
              try {
                await options.structuredResult.afterCompleted({
                  attribution,
                  execution,
                  result,
                  userMessage,
                });
              } catch (error) {
                app.log.error(
                  {
                    chatId: execution.chatId,
                    err: encryptedTaskMessages
                      ? new Error("Encrypted Task post-processing failed.")
                      : error,
                  },
                  "Task post-processing failed after its structured turn completed",
                );
              }
            }
            if (options.afterTurnCompleted) {
              try {
                await options.afterTurnCompleted({
                  attribution,
                  execution,
                  result,
                  userMessage,
                });
              } catch (error) {
                app.log.error(
                  { chatId: execution.chatId, err: error },
                  "Task post-processing failed after its turn completed",
                );
              }
            }
            if (
              finished &&
              (execution.contextKind === "standalone" ||
                !(await continuePendingWorktreeTransition(execution.chatId)))
            ) {
              void dispatchNextQueuedPrompt(execution.chatId);
            }
            app.log.info(
              {
                event: "chat.turn.completed",
                subsystem: "chat-execution",
                operation: "turn",
                status: "completed",
                chatId: execution.chatId,
                projectId: execution.projectId,
                workerId: execution.workerId,
                requestId: userMessage.id,
                runId: executionLaneId,
                turnId: result.turnId,
                durationMs: Date.now() - turnStartedAtMs,
                counts: {
                  changedPaths: changedPaths.size,
                  responseCharacters: result.text.length,
                },
                providerId: runtime.provider.id,
                providerAccountId: runtime.provider.accountId,
                routeId: runtime.routeId,
              },
              "Agent turn completed",
            );
            return;
          } catch (error) {
            const failedAt = new Date();
            const failureText = errorMessage(error).toLowerCase();
            const attemptStatus = failureText.includes("interrupt")
              ? "interrupted"
              : failureText.includes("cancel")
                ? "cancelled"
                : "failed";
            const canRetry =
              !attemptActivity &&
              canFailOverRoute(error) &&
              index < runtimes.length - 1;
            await recordRuntimeTokenUsage(
              tokenUsageSourceKey,
              execution.projectId,
              execution.chatId,
              runtime,
              undefined,
              {
                workerId: execution.workerId,
                turnId: behaviorTurnId,
                executionAttemptId,
                attemptKind: "chat-turn",
                attemptStatus,
                completedAt: failedAt,
                finalizedAt: failedAt,
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
            await recordRuntimeModelBehavior(
              behaviorSourceKey,
              execution,
              runtime,
              behaviorTracker,
              {
                executionAttemptId,
                attemptStatus,
                routeAttemptIndex: index,
                retryFailoverCount: index + (canRetry ? 1 : 0),
                startedAt: attemptStartedAt,
                completedAt: failedAt,
                finalizedAt: failedAt,
                durationMs: failedAt.getTime() - attemptStartedAtMs,
                turnId: behaviorTurnId,
                userInterrupted:
                  attemptStatus === "interrupted" ||
                  attemptStatus === "cancelled",
                immediateCorrectiveFollowup,
                userRetryRegeneration: Boolean(options.retryMessageId),
                codexVersion: attributedWorker?.codexVersion ?? null,
              },
            );
            if (!quotaFollowupsScheduled) {
              scheduleRuntimeQuotaSamples(
                runtime,
                execution,
                executionAttemptId,
                null,
              );
              quotaFollowupsScheduled = true;
            }
            if (!canRetry) throw error;
            routeCooldowns.set(
              runtimeCooldownKey(runtime),
              Date.now() + ROUTE_FAILURE_COOLDOWN_MS,
            );
            app.log.warn(
              {
                event: "chat.turn.route-failed-over",
                subsystem: "chat-execution",
                operation: "turn",
                status: "retrying",
                reasonCode: "route-failed-before-activity",
                chatId: execution.chatId,
                err: encryptedTaskMessages
                  ? new Error("Encrypted Task route failed.")
                  : error,
                providerId: runtime.provider.id,
                providerAccountId: runtime.provider.accountId,
                routeId: runtime.routeId,
                projectId: execution.projectId,
                workerId: execution.workerId,
                requestId: userMessage.id,
                runId: executionLaneId,
                durationMs: Date.now() - attemptStartedAtMs,
                attempt: index + 1,
              },
              "Provider route failed before activity; trying the next route",
            );
          }
        }
      } catch (error: unknown) {
        if (options.structuredResult) {
          try {
            await options.structuredResult.onFailed({
              error,
              execution,
              userMessage,
            });
          } catch (taskError) {
            app.log.error(
              { chatId: execution.chatId, err: taskError },
              "Could not persist a failed Task planning operation",
            );
          }
        }
        if (execution.contextKind === "project") {
          await notifyCodeAgentState(execution, "failed", changedPaths);
        }
        if (!anyActivity && execution.modelRouteId) {
          await repository.updateChatRuntime(
            execution.chatId,
            execution.workerId,
            execution.worktreeId,
            execution.threadId,
            execution.modelRouteId,
            "ready",
            execution.providerAccountId,
            execution.scratchRootId,
          );
        }
        const interrupted = /interrupted/i.test(errorMessage(error));
        app.log.error(
          {
            event: interrupted ? "chat.turn.interrupted" : "chat.turn.failed",
            subsystem: "chat-execution",
            operation: "turn",
            status: interrupted ? "interrupted" : "failed",
            reasonCode: interrupted ? "interrupted" : "execution-failed",
            chatId: execution.chatId,
            projectId: execution.projectId,
            workerId: execution.workerId,
            requestId: userMessage.id,
            runId: executionLaneId,
            durationMs: Date.now() - turnStartedAtMs,
            err: encryptedTaskMessages
              ? new Error("Encrypted Task turn failed.")
              : error,
          },
          "Agent turn failed",
        );
        if (!encryptedTaskMessages && !encryptedChatMessages) {
          await appendLiveChatMessage(
            ownerId,
            execution.chatId,
            {
              role: "system",
              content: [
                {
                  type: "text",
                  text: interrupted
                    ? "Turn interrupted."
                    : `Agent failed: ${errorMessage(error)}`,
                },
              ],
              idempotencyKey: `error:${userMessage.id}`,
            },
            attribution,
          );
        }
        await interruptLiveAgentInteractionRequests(execution.chatId);
        const finished = await repository.finishChatExecutionLane(
          execution.chatId,
          executionLaneId,
          interrupted ? "idle" : "failed",
        );
        cancelChatTurnOutcomeRecovery(
          execution.workerId,
          execution.chatId,
          userMessage.id,
        );
        publishChatTurnBoundary(
          execution.chatId,
          execution.projectId,
          execution,
        );
        if (options.afterTurnFailed) {
          try {
            await options.afterTurnFailed({ error, execution, userMessage });
          } catch (taskError) {
            app.log.error(
              { chatId: execution.chatId, err: taskError },
              "Task post-processing failed after its turn failed",
            );
          }
        }
        if (
          finished &&
          (execution.contextKind === "standalone" ||
            !(await continuePendingWorktreeTransition(execution.chatId)))
        ) {
          void dispatchNextQueuedPrompt(execution.chatId);
        }
      } finally {
        if (taskDispatchHeartbeat) clearInterval(taskDispatchHeartbeat);
      }
    });

    const firstRuntime = runtimes[0]!;
    return {
      ...userMessage,
      modelId,
      modelRouteId: firstRuntime.routeId,
      providerId: firstRuntime.provider.id,
      providerName: firstRuntime.provider.name,
      providerModelName: firstRuntime.model.name,
      reasoningEffort: requestedReasoningEffort,
      appliedReasoningEffort: preparedRuntimes[0]!.appliedReasoningEffort,
      reasoningAdjusted: preparedRuntimes[0]!.adjusted,
    };
  }

  async function startEncryptedTaskGoal(
    context: ChatExecutionContext,
    objective: TaskOperationRelayGoal,
    task: TaskOperationRelayResult["task"],
    idempotencyKey: string,
    options: {
      afterTurnCompleted?(input: {
        attribution: ChatExecutionAttribution;
        execution: ChatExecutionContext;
        result: AgentTurnResult;
        userMessage: ChatMessage;
      }): Promise<void>;
      afterTurnFailed?(input: {
        error: unknown;
        execution: ChatExecutionContext;
        userMessage: ChatMessage;
      }): Promise<void>;
      beforeTurn?(): Promise<void>;
      modelConfiguration?: ModelConfiguration;
      runtimes?: ModelRuntime[];
      taskDispatchLease?: TaskDispatchWorkerLease;
    } = {},
  ): Promise<void> {
    const modelId = await resolveModelId(
      context,
      options.modelConfiguration?.modelId ?? undefined,
    );
    const modelConfiguration = modelConfigurationSchema.parse({
      ...(options.modelConfiguration ?? context.modelConfiguration),
      modelId,
    });
    const routePairs = await routePairsForConfiguration(
      context,
      modelConfiguration,
      options.runtimes,
    );
    const runtime = routePairs[0]!.root.runtime;
    const result = taskGoalWorkerResultSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.goal.create",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: runtimeCanResumeContext(context, runtime)
          ? context.threadId
          : null,
        objective,
        tokenBudget: null,
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
        taskContext: {
          task,
          automationPaused: context.automationPaused,
          chatStatus: context.status,
          message: null,
        },
      }),
    );
    if (result.goal?.chatId !== context.chatId) {
      throw new Error("The encrypted Goal belongs to another Task.");
    }
    if (!result.goal) throw new Error("Codex did not create the Task Goal.");
    await repository.updateChatRuntime(
      context.chatId,
      context.workerId,
      context.worktreeId,
      result.goal.threadId,
      runtime.routeId,
      "ready",
      runtime.provider.accountId,
    );
    const updated = await repository.getChatExecutionContext(
      applicationOwnerId(),
      context.chatId,
    );
    if (!updated) throw new Error("Task Chat source not found.");
    await options.beforeTurn?.();
    await beginTurn(
      updated,
      {
        text: "Begin the active encrypted Task Goal.",
        mode: "goal",
        modelId,
        reasoningEffort: modelConfiguration.reasoningEffort,
        customSubagentModel: modelConfiguration.customSubagentModel,
        subagentModelId: modelConfiguration.subagentModelId,
        subagentReasoningEffort: modelConfiguration.subagentReasoningEffort,
        idempotencyKey,
      },
      {
        afterTurnCompleted: options.afterTurnCompleted,
        afterTurnFailed: options.afterTurnFailed,
        purpose: "Task implementation Goal",
        encryptedTaskMessages: {
          userMessage: objective.startMessage,
          response: {
            id: randomUUID(),
            idempotencyKey: `assistant:${objective.startMessage.id}`,
          },
        },
        workerPrompt:
          "Begin the active Task Goal and follow its encrypted objective.",
        runtimes: [runtime],
        taskDispatchLease: options.taskDispatchLease,
      },
    );
  }

  async function launchPreparedTaskGoal(
    chatId: string,
    operationId: string,
    options: Parameters<typeof startEncryptedTaskGoal>[4] = {},
  ) {
    const ownerId = applicationOwnerId();
    const taskOperation = await repository.tasks.getOperationContext(
      ownerId,
      chatId,
      { operationId },
    );
    if (
      !taskOperation ||
      taskOperation.round.kind !== "finalize" ||
      !taskOperation.relayResult?.goal
    ) {
      throw new Error("The finalized Task objective is not available.");
    }
    const goalStartKey = `task-goal:${operationId}`;
    const existingMessage = await repository.getTaskMessageByIdempotencyKey(
      ownerId,
      chatId,
      goalStartKey,
    );
    let completed: Awaited<
      ReturnType<typeof repository.tasks.completeFinalizationOperation>
    > = null;
    const completeFinalization = async () => {
      completed = await repository.tasks.completeFinalizationOperation(
        ownerId,
        chatId,
        operationId,
      );
      if (!completed) throw new Error("Task finalization was not found.");
      publishChatInvalidation(chatId, "task");
    };
    if (!existingMessage) {
      const context = await repository.getChatExecutionContext(ownerId, chatId);
      if (!context || context.experience !== "task") {
        throw new Error("Task Chat source not found.");
      }
      await startEncryptedTaskGoal(
        context,
        taskOperation.relayResult.goal,
        taskOperation.relayResult.task,
        goalStartKey,
        { ...options, beforeTurn: completeFinalization },
      );
    } else {
      await completeFinalization();
    }
    if (!completed) {
      completed = await repository.tasks.getOperationContext(ownerId, chatId, {
        operationId,
      });
    }
    if (!completed) throw new Error("Task finalization was not found.");
    return completed.task;
  }

  async function failTaskGoalLaunch(
    chatId: string,
    operationId: string,
    error: unknown,
  ): Promise<void> {
    await repository.tasks.failOperation(
      applicationOwnerId(),
      chatId,
      operationId,
    );
    publishChatInvalidation(chatId, "task");
  }

  async function startGoalTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
    options: {
      idempotencyKey?: string;
      purpose?: string;
      tokenBudget?: number | null;
    } = {},
  ) {
    if (!input.text) throw new Error("Goal mode needs a text objective.");
    await resolvePromptAttachments(context, input.attachmentIds);
    const modelId = await resolveModelId(context, input.modelId);
    const requestedReasoningEffort =
      input.reasoningEffort !== undefined
        ? input.reasoningEffort
        : context.reasoningEffort;
    const routePairs = await routePairsForConfiguration(
      context,
      modelConfigurationSchema.parse({
        ...context.modelConfiguration,
        modelId,
        reasoningEffort: requestedReasoningEffort,
      }),
    );
    const runtime = routePairs[0]!.root.runtime;
    const result = chatGoalResponseSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.goal.create",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: runtimeCanResumeContext(context, runtime)
          ? context.threadId
          : null,
        objective: input.text,
        tokenBudget: options.tokenBudget ?? null,
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
      }),
    );
    if (!result.goal) throw new Error("Codex did not create the goal.");
    publishChatInvalidation(context.chatId, "chat-goal", null, context);
    await repository.updateChatRuntime(
      context.chatId,
      context.workerId,
      context.worktreeId,
      result.goal.threadId,
      runtime.routeId,
      "ready",
      runtime.provider.accountId,
    );
    const updatedContext = await repository.getChatExecutionContext(
      applicationOwnerId(),
      context.chatId,
    );
    if (!updatedContext) throw new Error("Chat source not found.");
    const message = await beginTurn(
      updatedContext,
      {
        ...input,
        idempotencyKey: options.idempotencyKey ?? input.idempotencyKey,
        modelId,
        mode: "goal",
      },
      { purpose: options.purpose ?? "Codex goal", runtimes: [runtime] },
    );
    return { goal: result, message };
  }

  async function beginGoalTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
  ): Promise<ChatMessage> {
    return (await startGoalTurn(context, input)).message;
  }

  function beginPromptTurn(
    context: ChatExecutionContext,
    input: ChatTurnCreate,
  ): Promise<ChatMessage> {
    return input.mode === "goal"
      ? beginGoalTurn(context, input)
      : beginTurn(context, input);
  }

  const taskContentFromSummary = (task: TaskOpaqueSummary) => ({
    classification: {
      state: task.state,
      stableStateBeforeFailure: task.stableStateBeforeFailure,
      activeOperationKind: task.activeOperationKind,
      planAuthorship: task.planAuthorship,
      planningRound: task.planningRound,
      hasPlan: task.hasPlan,
      hasQuestions: task.hasQuestions,
      hasFinalPlan: task.hasFinalPlan,
      hasGoalPrompt: task.hasGoalPrompt,
      lastError: task.lastError,
    },
    protectedContent: task.protectedContent,
  });

  const retainedTaskGoalLeases = new Map<
    string,
    { lease: TaskDispatchWorkerLease; timer: ReturnType<typeof setInterval> }
  >();

  const taskDispatchCycleLease = (
    dispatch: TaskDispatchCycleSummary | null,
  ): TaskDispatchWorkerLease | null => {
    if (
      !dispatch ||
      !["claimed", "running"].includes(dispatch.state) ||
      !dispatch.leaseOwner ||
      !dispatch.leaseExpiresAt
    ) {
      return null;
    }
    return taskDispatchWorkerLeaseSchema.parse({
      cycleId: dispatch.id,
      operationId: dispatch.operationId,
      leaseOwner: dispatch.leaseOwner,
      leaseExpiresAt: dispatch.leaseExpiresAt,
      fencingToken: dispatch.fencingToken,
    });
  };

  const taskGoalDispatchLease = (
    task: TaskOpaqueSummary,
  ): TaskDispatchWorkerLease | null =>
    task.dispatch?.operationKind === "finalize"
      ? taskDispatchCycleLease(task.dispatch)
      : null;

  const releaseTaskGoalLease = (cycleId: string) => {
    const retained = retainedTaskGoalLeases.get(cycleId);
    if (!retained) return;
    clearInterval(retained.timer);
    retainedTaskGoalLeases.delete(cycleId);
  };

  const retainTaskGoalLease = async (lease: TaskDispatchWorkerLease) => {
    const retained = retainedTaskGoalLeases.get(lease.cycleId);
    if (
      retained?.lease.fencingToken === lease.fencingToken &&
      retained.lease.leaseOwner === lease.leaseOwner
    ) {
      return;
    }
    releaseTaskGoalLease(lease.cycleId);
    await repository.taskDispatch.heartbeat(lease);
    const timer = setInterval(
      () => {
        void repository.taskDispatch.heartbeat(lease).catch((error) => {
          releaseTaskGoalLease(lease.cycleId);
          if (!(error instanceof TaskDispatchConflictError)) {
            app.log.warn(
              { cycleId: lease.cycleId, err: error },
              "Could not retain the Task Goal dispatch lease",
            );
          }
        });
      },
      Math.floor(TASK_DISPATCH_LEASE_MS / 3),
    );
    timer.unref();
    retainedTaskGoalLeases.set(lease.cycleId, { lease, timer });
  };

  const reconcileTaskGoalDispatch = async (
    source: TaskOpaqueSummary,
    state: TaskOpaqueSummary["state"],
  ) => {
    const lease = taskGoalDispatchLease(source);
    if (!lease) return;
    if (state === "implementing") {
      await retainTaskGoalLease(lease);
      return;
    }
    if (!["paused", "blocked", "complete", "failed"].includes(state)) return;
    releaseTaskGoalLease(lease.cycleId);
    try {
      await repository.taskDispatch.heartbeat(lease);
      await repository.taskDispatch.settle(
        lease,
        state === "failed" ? "failed" : "succeeded",
      );
    } catch (error) {
      if (!(error instanceof TaskDispatchConflictError)) throw error;
    }
    publishChatInvalidation(source.chatId, "task");
    queueTaskScheduleTick();
  };

  const readEncryptedTaskGoal = async (
    context: ChatExecutionContext,
    task: TaskOpaqueSummary,
    message: {
      id: string;
      idempotencyKey: string;
      kind: "resume" | "start";
    } | null = null,
  ) => {
    if (!context.threadId) {
      return { goal: null, message: null, task };
    }
    const runtime = await runtimeForContext(context);
    if (!runtime) throw new Error("Selected model was not found.");
    const result = taskGoalWorkerResultSchema.parse(
      await bridge.request(context.workerId, {
        type: "chat.goal.get",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
        taskContext: {
          task: taskContentFromSummary(task),
          automationPaused: context.automationPaused,
          chatStatus: context.status,
          message,
        },
      }),
    );
    if (
      result.goal?.chatId !== context.chatId ||
      (message &&
        (result.message?.id !== message.id ||
          result.message.idempotencyKey !== message.idempotencyKey))
    ) {
      throw new Error("Encrypted Goal metadata is invalid.");
    }
    const synchronized = await repository.tasks.syncImplementationState(
      applicationOwnerId(),
      context.chatId,
      { rowVersion: task.rowVersion, task: result.task },
    );
    if (synchronized && synchronized.rowVersion !== task.rowVersion) {
      publishChatInvalidation(context.chatId, "task", null, context);
    }
    const nextTask = synchronized ?? task;
    await reconcileTaskGoalDispatch(task, nextTask.state);
    return { ...result, task: nextTask };
  };

  const synchronizeScheduledTaskGoal = async (
    chatId: string,
    lease: TaskDispatchWorkerLease,
    turnFailed: boolean,
  ) => {
    const context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    const task = await repository.tasks.get(applicationOwnerId(), chatId);
    if (!context || context.experience !== "task" || !task) return;
    try {
      await readEncryptedTaskGoal(context, task);
    } catch (error) {
      if (!turnFailed) throw error;
      releaseTaskGoalLease(lease.cycleId);
      try {
        await repository.taskDispatch.heartbeat(lease);
        await repository.taskDispatch.settle(lease, "failed");
      } catch (dispatchError) {
        if (!(dispatchError instanceof TaskDispatchConflictError)) {
          throw dispatchError;
        }
      }
      publishChatInvalidation(chatId, "task", null, context);
      queueTaskScheduleTick();
    }
  };

  const scheduledTaskGoalTurnOptions = (lease: TaskDispatchWorkerLease) => ({
    async afterTurnCompleted({
      execution,
    }: {
      execution: ChatExecutionContext;
    }) {
      await synchronizeScheduledTaskGoal(execution.chatId, lease, false);
    },
    async afterTurnFailed({ execution }: { execution: ChatExecutionContext }) {
      await synchronizeScheduledTaskGoal(execution.chatId, lease, true);
    },
    taskDispatchLease: lease,
  });

  const resumeChatAutomation = async (chatId: string): Promise<void> => {
    let context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    if (
      !context ||
      context.automationPaused ||
      chatIsExecuting(context.status) ||
      !bridge.isConnected(context.workerId)
    ) {
      return;
    }
    if (await continuePendingWorktreeTransition(chatId)) return;
    context = await repository.getChatExecutionContext(
      applicationOwnerId(),
      chatId,
    );
    if (
      !context ||
      context.automationPaused ||
      chatIsExecuting(context.status)
    ) {
      return;
    }
    if (context.threadId) {
      const runtime = await runtimeForContext(context);
      if (!runtime) throw new Error("Selected model was not found.");
      if (context.experience === "task") {
        const task = await repository.tasks.get(
          applicationOwnerId(),
          context.chatId,
        );
        if (!task) return;
        const messageId = randomUUID();
        const idempotencyKey = `task-goal-resume:${messageId}`;
        const result = await readEncryptedTaskGoal(context, task, {
          id: messageId,
          idempotencyKey,
          kind: "resume",
        });
        if (result.goal?.status === "active" && result.message) {
          const dispatchLease = taskGoalDispatchLease(task);
          if (dispatchLease) await retainTaskGoalLease(dispatchLease);
          const dispatchConfiguration = task.dispatch?.modelConfiguration;
          const modelId =
            dispatchConfiguration?.modelId ?? (await resolveModelId(context));
          await beginTurn(
            context,
            {
              text: "Resume the active encrypted Task Goal.",
              mode: "goal",
              modelId,
              reasoningEffort: dispatchConfiguration?.reasoningEffort,
              customSubagentModel: dispatchConfiguration?.customSubagentModel,
              subagentModelId: dispatchConfiguration?.subagentModelId,
              subagentReasoningEffort:
                dispatchConfiguration?.subagentReasoningEffort,
              idempotencyKey,
            },
            {
              acquiringActor: "agent",
              encryptedTaskMessages: {
                userMessage: result.message,
                response: {
                  id: randomUUID(),
                  idempotencyKey: `assistant:${result.message.id}`,
                },
              },
              purpose: "Resume encrypted Task Goal",
              runtimes: [runtime],
              workerPrompt: GOAL_RESUME_PROMPT,
              ...(dispatchLease
                ? scheduledTaskGoalTurnOptions(dispatchLease)
                : {}),
            },
          );
          return;
        }
        return;
      }
      const result = chatGoalResponseSchema.parse(
        await bridge.request(context.workerId, {
          type: "chat.goal.get",
          chatId: context.chatId,
          cwd: context.cwd,
          threadId: context.threadId,
          model: runtime.model,
          provider: runtime.provider,
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        }),
      );
      if (result.goal?.status === "active") {
        const modelId = await resolveModelId(context);
        await beginTurn(
          context,
          {
            text: `Resume goal: ${result.goal.objective}`,
            mode: "goal",
            modelId,
            idempotencyKey: `chat-resume:${result.goal.updatedAt}:${randomUUID()}`,
          },
          {
            acquiringActor: "agent",
            purpose: "Resume paused Codex goal",
            runtimes: [runtime],
            workerPrompt: GOAL_RESUME_PROMPT,
          },
        );
        return;
      }
    }
    await dispatchNextQueuedPrompt(chatId);
  };

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
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/console",
    async (request, reply) => {
      const input = encryptedLinkedConsoleCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      let context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.experience === "task") {
        return reply.code(409).send({
          error: "Encrypted Task console state stays on its authorized worker.",
        });
      }
      const modelId = await resolveModelId(context);
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply
          .code(409)
          .send({ error: "No provider route is currently available." });
      }
      if (!context.threadId || !runtimeCanResumeContext(context, runtime)) {
        if (!bridge.isConnected(context.workerId)) {
          return reply.code(503).send({ error: "Project worker is offline." });
        }
        try {
          const mcpServers = await repository.listEffectiveMcpServers(
            applicationOwnerId(),
            context.projectId,
            context.workerId,
          );
          const result = (await bridge.request(context.workerId, {
            type: "chat.thread.ensure",
            cwd: context.cwd,
            threadId: null,
            planMode: context.planMode,
            model: runtime.model,
            provider: runtime.provider,
            permissionProfileId:
              effectivePermissionProfile(context).effectiveId,
            mcpServers,
          })) as { threadId?: unknown };
          if (typeof result.threadId !== "string" || !result.threadId) {
            throw new Error("Codex did not return a console thread.");
          }
          await repository.setChatModel(applicationOwnerId(), context.chatId, {
            modelId,
          });
          await repository.updateChatRuntime(
            context.chatId,
            context.workerId,
            context.worktreeId,
            result.threadId,
            runtime.routeId,
            "ready",
            runtime.provider.accountId,
          );
          const updated = await repository.getChatExecutionContext(
            applicationOwnerId(),
            context.chatId,
          );
          if (!updated) throw new Error("Chat source not found.");
          context = updated;
        } catch (error) {
          return sendWorkerConflictFailure(reply, error);
        }
      }
      const terminal = await repository.getOrCreateChatConsole(
        applicationOwnerId(),
        context.chatId,
        input.data,
      );
      return terminal
        ? reply.code(201).send(terminalWireSummarySchema.parse(terminal))
        : reply.code(404).send({ error: "Chat source not found." });
    },
  );

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

  app.get<{
    Params: { terminalId: string };
    Querystring: { operationId?: string };
  }>("/api/terminals/:terminalId/script-commands", async (request, reply) => {
    const operationId =
      endpointContentContextSchema.shape.operationId.safeParse(
        request.query.operationId,
      );
    if (!operationId.success) {
      return reply
        .code(400)
        .send({ error: "A valid operationId is required." });
    }
    const context = await repository.getTerminalExecutionContext(
      applicationOwnerId(),
      request.params.terminalId,
    );
    if (!context) {
      return reply.code(404).send({ error: "Terminal not found." });
    }
    if (context.kind === "run-configuration" || !context.stateProtection) {
      return reply.code(409).send({
        error:
          "Run configuration terminals do not expose interactive terminal commands.",
      });
    }
    if (!bridge.isConnected(context.workerId)) {
      return reply.code(503).send({ error: "Project worker is offline." });
    }
    try {
      const protectedCommands = repositoryOperationOpaqueSchema.parse(
        await bridge.request(
          context.workerId,
          {
            type: "project.script-commands",
            operationId: operationId.data,
            terminalId: context.terminalId,
            serverId,
            worktreePath: context.worktreePath,
            stateProtection: context.stateProtection,
          },
          { timeoutMs: 30_000 },
        ),
      );
      return reply.send(
        protectedScriptCommandListSchema.parse({
          operationId: operationId.data,
          projectId: context.terminalId,
          worktreeId: context.terminalId,
          protectedCommands,
        }),
      );
    } catch (error) {
      return sendWorkerRequestFailure(reply, error);
    }
  });

  app.get<{
    Params: { projectId: string };
    Querystring: { operationId?: string; worktreeId?: string };
  }>("/api/projects/:projectId/script-commands", async (request, reply) => {
    const operationId =
      endpointContentContextSchema.shape.operationId.safeParse(
        request.query.operationId,
      );
    if (!operationId.success) {
      return reply
        .code(400)
        .send({ error: "A valid operationId is required." });
    }
    try {
      const context = await resolveAppRunContext(
        request.params.projectId,
        request.query.worktreeId,
      );
      const worktree = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        context.worktreeId,
      );
      if (!worktree || worktree.workerId !== context.workerId) {
        throw new ExecutionLaneConflictError(
          "The script command worktree placement changed before discovery.",
        );
      }
      const protectedCommands = repositoryOperationOpaqueSchema.parse(
        await bridge.request(
          context.workerId,
          {
            type: "project.script-commands.inspect",
            operationId: operationId.data,
            projectId: request.params.projectId,
            worktreeId: context.worktreeId,
            serverId,
            sourcePath: worktree.worktree.path,
          },
          { timeoutMs: 30_000 },
        ),
      );
      return reply.send(
        protectedScriptCommandListSchema.parse({
          operationId: operationId.data,
          projectId: request.params.projectId,
          worktreeId: context.worktreeId,
          protectedCommands,
        }),
      );
    } catch (error) {
      return sendRunApiFailure(reply, error);
    }
  });

  installTerminalManagementRoutes(app, {
    applicationOwnerId,
    repository,
    runtime: terminalServiceRuntime,
  });

  app.patch<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId/worktree",
    async (request, reply) => {
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      try {
        return await directAttachments.mutateResource(
          ownerId,
          "terminal",
          request.params.terminalId,
          async () => {
            await workerLinks.revokeResource(
              ownerId,
              "terminal",
              request.params.terminalId,
              "resource-stopped",
            );
            const context = await repository.getTerminalExecutionContext(
              ownerId,
              request.params.terminalId,
            );
            if (context?.kind === "run-configuration") {
              return reply.code(409).send({
                error: "Run configuration terminals cannot change worktrees.",
              });
            }
            if (context) await requireProjectWorktrees(context.projectId);
            const terminal = await repository.updateTerminalWorktree(
              ownerId,
              request.params.terminalId,
              input.data,
            );
            return terminal
              ? reply.send(terminalWireSummarySchema.parse(terminal))
              : reply
                  .code(404)
                  .send({ error: "Terminal or worktree not found." });
          },
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      try {
        return await directAttachments.mutateResource(
          ownerId,
          "terminal",
          request.params.terminalId,
          async () => {
            await workerLinks.revokeResource(
              ownerId,
              "terminal",
              request.params.terminalId,
              "resource-deleted",
            );
            const context = await repository.deleteTerminal(
              ownerId,
              request.params.terminalId,
            );
            if (!context) {
              return reply.code(404).send({ error: "Terminal not found." });
            }
            if (bridge.isConnected(context.workerId)) {
              await bridge
                .request(
                  context.workerId,
                  {
                    type: "terminal.close",
                    terminalId: context.terminalId,
                  },
                  { ownerId, timeoutMs: 5_000 },
                )
                .catch((error: unknown) =>
                  app.log.warn(
                    { err: error, terminalId: context.terminalId },
                    "Could not close deleted terminal",
                  ),
                );
            }
            return reply.code(204).send();
          },
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

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
    clearInterval(workflowScheduleTimer);
    clearInterval(taskScheduleTimer);
    for (const { timer } of retainedTaskGoalLeases.values()) {
      clearInterval(timer);
    }
    retainedTaskGoalLeases.clear();
    clearInterval(workerCatalogRefreshTimer);
    for (const timer of quotaObservationTimers) clearTimeout(timer);
    quotaObservationTimers.clear();
    quotaResetObservationKeys.clear();
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
    await activeScheduleTick;
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
