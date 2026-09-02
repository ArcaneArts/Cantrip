import {
  clearSensitiveBytes,
  computeBlindLookupTag,
  deriveLookupKey,
  encodeBase64Url,
  randomBytes,
} from "@cantrip/crypto";
import {
  CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
  accountAdminSummarySchema,
  accountLicenseWhitelistCreateSchema,
  accountLicenseWhitelistEntrySchema,
  accountLiveTrafficQuerySchema,
  accountLiveTrafficSchema,
  accountRegistrationSchema,
  accountSessionListSchema,
  accountResourceUsageHistoryQuerySchema,
  accountResourceUsageHistorySchema,
  accountResourceUsageSchema,
  appDestinationSchema,
  appDestinationUpdateSchema,
  authLoginSchema,
  mobileSignInGrantCreateResultSchema,
  mobileSignInGrantExchangeSchema,
  authLogoutAllResultSchema,
  authSessionSchema,
  authSessionStateSchema,
  agentInteractionRequestWireListSchema,
  agentInteractionRequestWireSchema,
  agentInteractionResolutionCreateSchema,
  archivedChatCleanupResultSchema,
  archivedChatWireListSchema,
  archivedStandaloneChatWireSummarySchema,
  browserWireListSchema,
  browserServiceFleetDiscoverySchema,
  browserServiceListSchema,
  browserWireSummarySchema,
  browserTunnelRequestSchema,
  browserTunnelWireRequestSchema,
  agentThreadSyncSchema,
  chatWireListSchema,
  chatGoalClearSchema,
  chatGoalCreateSchema,
  chatGoalResponseSchema,
  chatGoalWireResponseSchema,
  chatGoalUpdateSchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  chatMessageListSchema,
  chatMessageWirePageSchema,
  chatMessageSchema,
  chatMessageWireListSchema,
  chatWireSummarySchema,
  contextualChatWireSummarySchema,
  chatModelConfigurationUpdateSchema,
  encryptedChatComposerDraftUpdateSchema,
  encryptedChatComposerDraftWireStateSchema,
  chatCompactAcceptedSchema,
  chatImportCreateSchema,
  chatImportJobListSchema,
  chatImportJobRetrySchema,
  chatImportJobSummarySchema,
  chatInterruptAcceptedSchema,
  chatPlanAcceptedSchema,
  chatPlanAnswerSchema,
  encryptedChatPlanWireStateSchema,
  projectTaskWorkloadOpaqueSchema,
  chatPlanUpdateSchema,
  chatRelocationCreateSchema,
  chatRelocationJobCancelSchema,
  chatRelocationJobListSchema,
  chatRelocationJobRetrySchema,
  chatRelocationJobSummarySchema,
  chatPauseStateSchema,
  chatPauseUpdateSchema,
  chatPermissionProfileStateSchema,
  chatPermissionProfileUpdateSchema,
  chatPromptSteerResultSchema,
  encryptedChatPromptSteerResultSchema,
  chatPromptSubmitResultSchema,
  encryptedChatPromptSubmitResultSchema,
  encryptedChatTurnCreateSchema,
  encryptedStandaloneChatCreateSchema,
  encryptedQueuedPromptListSchema,
  encryptedQueuedPromptSchema,
  chatReasoningStateSchema,
  chatReasoningUpdateSchema,
  chatRuntimeSelectionSchema,
  codeProtectedAttachmentCreateSchema,
  codeProtectedAttachmentIntentSchema,
  codeProtectedAttachmentWireSchema,
  codeSharedAttachmentWireSchema,
  explorerCodeSessionAttachmentCreateSchema,
  codeSettingsResolveRequestSchema,
  codeSettingsSynchronizeRequestSchema,
  codeSettingsWorkbenchAttachmentCreateSchema,
  codeSettingsWorkbenchAttachmentWireSchema,
  codeSettingsWorkerStatusSchema,
  codeRuntimeStatusSchema,
  codeGraphActionAcknowledgementSchema,
  codeGraphProjectStatusSchema,
  codeSaveAllResultSchema,
  codeTabWireListSchema,
  codeTabWireSummarySchema,
  codexCustomizationInventorySchema,
  codexExternalImportApplySchema,
  codexExternalImportPreviewSchema,
  codexExternalImportStatusSchema,
  codexMcpOauthStartResultSchema,
  codexMcpOauthStartSchema,
  codexMcpOauthStatusSchema,
  codexMcpReloadRequestSchema,
  codexMcpReloadResultSchema,
  codexMcpResourceReadRequestSchema,
  codexMcpResourceReadSchema,
  codexSkillConfigResultSchema,
  codexSkillConfigUpdateSchema,
  codexSkillRootsResultSchema,
  codexSkillRootsUpdateSchema,
  explorerDirectoryCommitsSchema,
  explorerDirectoryCreateSchema,
  explorerDirectorySchema,
  explorerEntryDeleteSchema,
  explorerEntrySchema,
  explorerEntryMutationResultSchema,
  explorerEntryRenameSchema,
  explorerFileSchema,
  explorerFileWriteSchema,
  explorerWireListSchema,
  explorerWireSummarySchema,
  explorerCodeProtectedAttachmentCreateSchema,
  explorerViewStateUpdateSchema,
  executionPlacementResolutionSchema,
  executionPlacementResolveRequestSchema,
  executionTargetWireCatalogSchema,
  executionTargetResolutionSchema,
  executionTargetResolveRequestSchema,
  githubAuthStatusSchema,
  githubIssueDetailSchema,
  githubIssueListSchema,
  githubPullRequestCreateResultSchema,
  githubPullRequestCheckoutPreparedSchema,
  githubPullRequestCheckoutResultSchema,
  githubPullRequestDetailSchema,
  githubPullRequestLifecyclePreviewSchema,
  githubReleaseListSchema,
  githubReleaseSummarySchema,
  githubRepositoryCreateSchema,
  githubRepositoryListSchema,
  githubRepositoryOwnerListSchema,
  githubRepositorySchema,
  gitActionResultSchema,
  gitAgentDraftCreateSchema,
  gitAgentDraftResultSchema,
  gitBranchActionPreviewSchema,
  gitBranchListSchema,
  gitBranchMutationResultSchema,
  gitCommitActionPreviewSchema,
  gitCommitActionResultSchema,
  gitConflictDetailSchema,
  gitConflictListSchema,
  gitConflictResolutionPreviewSchema,
  gitConflictResolutionResultSchema,
  gitManagedOperationPreviewSchema,
  gitManagedOperationResponseSchema,
  gitCommitDetailSchema,
  gitCommitSearchResultSchema,
  gitSignatureSchema,
  gitComparisonSchema,
  gitFileDiffSchema,
  gitFileHistorySchema,
  gitBlameSchema,
  gitForcePushPreviewSchema,
  gitGraphCommitOverlayRequestSchema,
  gitGraphCommitOverlaySchema,
  gitGraphMetricsSchema,
  gitGraphRequestSchema,
  gitGraphSnapshotSchema,
  gitHistorySchema,
  gitLfsActionPreviewSchema,
  gitLfsMutationResultSchema,
  gitLfsStatusSchema,
  gitPartialPatchPreviewSchema,
  gitStashActionPreviewSchema,
  gitStashFileDiffSchema,
  gitStashListSchema,
  gitStashMutationResultSchema,
  gitSubmoduleActionPreviewSchema,
  gitSubmoduleListSchema,
  gitSubmoduleMutationResultSchema,
  gitRevisionFileDiffSchema,
  gitRevisionCandidateListSchema,
  gitRemoteActionPreviewSchema,
  gitRemoteListSchema,
  gitRemoteMutationResultSchema,
  gitRecoveryCandidateListSchema,
  gitRecoveryPreviewSchema,
  gitRecoveryResultSchema,
  gitStatusSchema,
  gitTagActionPreviewSchema,
  gitTagDetailSchema,
  gitTagListSchema,
  gitTagMutationResultSchema,
  modelProfileCreateSchema,
  modelProfileSummarySchema,
  modelProfileUpdateSchema,
  modelProviderAccountCreateSchema,
  modelProviderAccountListSchema,
  modelProviderAccountSummarySchema,
  modelProviderAccountUpdateSchema,
  providerConnectionTestResultSchema,
  providerModelCatalogResultSchema,
  providerQuotaSnapshotSchema,
  providerRateLimitResetConsumeResultSchema,
  modelProviderSummarySchema,
  encryptedManagedFolderProjectCreateSchema,
  mcpServerCopySchema,
  mcpServerDiscoveryResultSchema,
  managedWebRuntimeActionRequestSchema,
  managedWebRuntimeActionResultSchema,
  orderedIdsSchema,
  effectivePolicyWireListSchema,
  encryptedPolicyBootstrapSchema,
  policyAssignmentWireListSchema,
  policyAssignmentUpdateSchema,
  policyCreateSchema,
  policyDeleteSchema,
  policyFromTemplateCreateSchema,
  policyOrderUpdateSchema,
  policyWireDetailSchema,
  policyWireListSchema,
  policyTemplateResetSchema,
  policyUpdateSchema,
  POLICY_BOOTSTRAP_VERSION,
  projectWireListSchema,
  projectExternalChatDiscoverySchema,
  projectExportCreateSchema,
  projectExportPreviewRequestSchema,
  projectExportPreviewSchema,
  projectExportResultSchema,
  projectFolderSetupJobSummarySchema,
  projectFolderSetupRetrySchema,
  projectGithubConversionJobSummarySchema,
  projectGithubConversionRepositorySchema,
  projectGithubConversionPreflightRequestSchema,
  projectGithubConversionPreflightResultSchema,
  projectGithubConversionRetrySchema,
  projectGithubConversionStartSchema,
  projectGithubRoutingRepositorySchema,
  encryptedProjectGithubConversionPreflightRequestSchema,
  encryptedProjectGithubConversionStartSchema,
  projectPreferredWorkerUpdateSchema,
  projectReplicaJobListSchema,
  projectReplicaJobSummarySchema,
  projectReplicaLinkRepairResultSchema,
  projectReplicaListSchema,
  encryptedProjectReplicaPlacementRequestSchema,
  encryptedProjectReplicaProvisionCreateSchema,
  encryptedProjectReplicaRemoveCreateSchema,
  encryptedProjectReplicaSynchronizeCreateSchema,
  projectRepositoryStatsSchema,
  projectTokenUsageSchema,
  providerTelemetryAnalyticsSchema,
  providerTelemetryDeleteResultSchema,
  providerTelemetryExportSchema,
  projectShareAttachmentSchema,
  projectShareAttachmentWireSchema,
  projectShareTunnelCreateSchema,
  type ProjectSummary,
  projectWireSummarySchema,
  encryptedAttachedProjectWorkspaceCreateResultSchema,
  encryptedProjectWorkspaceCreateSchema,
  encryptedProjectWorkspaceUpdateSchema,
  projectWorkspaceWireListSchema,
  projectWorkspaceWireSummarySchema,
  workspaceRepositoryDiscoverySnapshotSchema,
  workspaceRepositoryDiscoveryStartSchema,
  workspaceRepositoryImportStartSchema,
  projectTabLayoutWireSummarySchema,
  projectWorktreeCreateSchema,
  projectWorktreeListSchema,
  serviceLogReadResultSchema,
  projectWorktreeSummarySchema,
  projectViewWireListSchema,
  projectViewWireSummarySchema,
  queuedPromptListSchema,
  queuedPromptSchema,
  directAttachmentTicketSchema,
  workerLinkLeaseSchema,
  workerLinkDirectActivationSchema,
  workerLinkObservationGrantRequestSchema,
  workerLinkPeerMailboxReadRequestSchema,
  workerLinkPeerMailboxSchema,
  workerLinkPeerSessionOpenRequestSchema,
  workerLinkPeerSessionDescriptorSchema,
  workerLinkPeerSignalBatchSchema,
  workerLinkRemoteSurfaceGrantRequestSchema,
  workerLinkResourceGrantSchema,
  workerLinkRouteUpdateRequestSchema,
  workerLinkSessionOpenRequestSchema,
  workerLinkSessionSchema,
  workerLinkTelemetryBatchSchema,
  workerLinkTerminalGrantRequestSchema,
  workerLinkTunnelGrantRequestSchema,
  workerLinkTunnelGrantSchema,
  type WorkerLinkPeerMailboxReadRequest,
  type WorkerLinkPeerSignalEnvelope,
  type WorkerLinkRoute,
  type WorkerLinkTelemetrySample,
  directTransportTelemetrySchema,
  remoteDesktopWireListSchema,
  remoteDesktopFleetWireSchema,
  remoteDesktopWireSummarySchema,
  serverBootstrapSchema,
  settingsBundleSchema,
  scriptCommandListSchema,
  protectedScriptCommandListSchema,
  skillListSchema,
  skillAudienceListSchema,
  skillAudienceSummarySchema,
  skillAudienceUpdateSchema,
  skillSettingsContextSchema,
  skillSettingsConfigResultSchema,
  skillSettingsConfigUpdateSchema,
  skillSettingsDeleteRequestSchema,
  skillSettingsDocumentSchema,
  skillSettingsFileRequestSchema,
  skillSettingsFileUpdateSchema,
  skillSettingsInventorySchema,
  skillSettingsMutationResultSchema,
  standaloneChatWireSummarySchema,
  standaloneChatShareAttachmentSchema,
  standaloneChatShareAttachmentWireSchema,
  type StandaloneChatSummary,
  systemHealthSchema,
  tabGroupMemberMoveSchema,
  tabGroupMemberOrderSchema,
  tabGroupOrderSchema,
  encryptedTabGroupUpdateSchema,
  tabGroupUpdateSchema,
  taskWireCreateResultSchema,
  taskImplementationDashboardSchema,
  taskImplementationOpaqueDashboardSchema,
  terminalWireListSchema,
  terminalWireSummarySchema,
  terminalServiceConfigurationSchema,
  tunnelAttachmentCreateResultSchema,
  tunnelAttachmentCreateSchema,
  tunnelUserWireCreateSchema,
  tunnelUserWireUpdateSchema,
  tunnelWireListSchema,
  tunnelWireSummarySchema,
  tunnelUserCreateSchema,
  tunnelUserUpdateSchema,
  worktreeStatusResultSchema,
  workerCredentialListSchema,
  workerCredentialRotateResultSchema,
  workerCredentialRotateSchema,
  workerEnrollmentCodeCreateSchema,
  workerEnrollmentCodeResultSchema,
  workerEnrollmentCodeStatusSchema,
  workerListSchema,
  workerManagementListSchema,
  workerEncryptionRefreshRequestSchema,
  workerEncryptionRefreshResultSchema,
  workerRestartResultSchema,
  workerSummarySchema,
  workerUpdateSchema,
} from "@cantrip/protocol";
import {
  attachmentDownloadOpaqueSchema,
  attachmentUploadOpaqueSchema,
  chatAttachmentOpaqueListSchema,
  chatAttachmentOpaqueSummarySchema,
} from "@cantrip/protocol/attachment-content";
import {
  projectTaskPauseStateSchema,
  projectTaskPauseUpdateSchema,
  taskWorkerCreateSchema,
  taskWorkerDeleteSchema,
  taskWorkerListSchema,
  taskWorkerOrderUpdateSchema,
  taskWorkerSummarySchema,
  taskWorkerUpdateSchema,
  type TaskWorkerCreate,
  type TaskWorkerOrderUpdate,
  type TaskWorkerUpdate,
  type ProjectTaskPauseUpdate,
} from "@cantrip/protocol/task-scheduling";
import {
  explorerOperationRequestContentSchema,
  explorerOperationResultContentSchema,
  standaloneChatFileOperationRequestContentSchema,
  standaloneChatFileOperationResultContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
  type ExplorerOperationRequestContent,
  type ExplorerOperationResultContent,
  type StandaloneChatFileDownloadKind,
  type StandaloneChatFileOperationIntent,
  type StandaloneChatFileOperationRequestContent,
  type StandaloneChatFileOperationResultContent,
} from "@cantrip/protocol/surface-stream";
import {
  repositoryOperationAccess,
  repositoryMetadataResultSchema,
  repositoryMetadataValuesSchema,
  repositoryRoutingHandleSchema,
  repositoryOperationOutcomeContentSchema,
  repositoryOperationRequestContentSchema,
  repositoryOperationWireResponseSchema,
  workspaceRootAttachmentSchema,
  type RepositoryMetadataValues,
  type RepositoryOperationType,
} from "@cantrip/protocol/repository-operation";
import type {
  AccountLiveTrafficQuery,
  AccountResourceUsageHistoryQuery,
  AccountRegistration,
  AuthLogin,
  MobileSignInGrantExchange,
  AgentInteractionRequestStatus,
  AgentInteractionResolutionCreate,
  ChatWorktreeUpdate,
  ChatAttachmentSummary,
  ChatAttachmentKind,
  ChatAttachmentSource,
  ChatGoalCreate,
  ChatGoalUpdate,
  ChatComposerDraft,
  ChatImportCreate,
  ChatPlanAnswer,
  ChatPlanUpdate,
  ChatRelocationCreate,
  ChatRelocationJobCancel,
  ChatRelocationJobRetry,
  ChatTurnMode,
  EncryptedQueuedPrompt,
  CodeAppearance,
  CodeSharedAttachmentWire,
  CodeSettingsResolution,
  CodeThemeMode,
  CodexExternalImportApply,
  CodexMcpOauthStart,
  CodexMcpResourceReadRequest,
  CodexSkillConfigUpdate,
  CodexSkillRootsUpdate,
  ExplorerViewStateUpdate,
  GitAction,
  GitAgentDraftCreate,
  GitBranchAction,
  GitCommitAction,
  GitCommitSearchQuery,
  GitConflictResolutionRequest,
  GitManagedOperationAction,
  GitLfsAction,
  GitDiffScope,
  GitGraphCommitOverlayRequest,
  GitGraphRequest,
  GitPartialPatchRequest,
  GitRemoteAction,
  GitRecoveryAction,
  GitRecoveryApply,
  GitStashAction,
  GitStashCreate,
  GitSubmoduleAction,
  GitTagAction,
  GithubIssueKind,
  GithubIssueCreate,
  GithubIssueState,
  GithubPullRequestCreate,
  GithubPullRequestLifecycleAction,
  GithubPullRequestLifecycleApply,
  GithubPullRequestReviewAction,
  GithubReleaseCreate,
  EncryptedGithubProjectCreate,
  GithubRepositoryCreate,
  EncryptedManagedFolderProjectCreate,
  ModelProfileCreate,
  ModelConfiguration,
  ModelProfileSummary,
  ModelProfileUpdate,
  ModelProviderCreate,
  ModelProviderSummary,
  ModelProviderAccountCreate,
  ModelProviderAccountUpdate,
  ModelProviderUpdate,
  PolicyCreate,
  PolicyAssignmentUpdate,
  PolicyFromTemplateCreate,
  PolicyOrderUpdate,
  PolicyTemplateReset,
  PolicyUpdate,
  McpServerConfiguration,
  McpServerCopy,
  EncryptedMcpServerCreate,
  ProjectViewKind,
  ProjectReplicaJobCancel,
  ProjectReplicaJobRetry,
  ProjectReplicaProvisionCreate,
  ProjectReplicaRemoveCreate,
  ProjectReplicaSynchronizeCreate,
  WorkspaceRepositoryDiscoveryStart,
  WorkspaceRepositoryImportStart,
  ExecutionPlacementResolveRequest,
  ExecutionTarget,
  ExecutionTargetResolveRequest,
  ProjectPreferredWorkerUpdate,
  ProjectExportCreate,
  ProjectExportPreviewRequest,
  ProjectGithubConversionRepository,
  ProjectGithubRoutingRepository,
  ProjectGithubConversionPreflightRequest,
  ProjectGithubConversionStart,
  EncryptedProjectWorkspaceCreate,
  EncryptedProjectWorkspaceName,
  EncryptedProjectWorkspaceUpdate,
  ProjectWorktreeCreate,
  ProjectWorktreeSummary,
  RemoteDesktopSummary,
  RemoteDesktopTarget,
  ReasoningEffort,
  ResourceAudience,
  SkillSettingsContext,
  SkillSettingsConfigUpdate,
  SkillSettingsDeleteRequest,
  SkillSettingsFileRequest,
  SkillSettingsFileUpdate,
  SkillAudienceUpdate,
  TerminalServiceConfiguration,
  TerminalSummary,
  TaskDraftUpdate,
  TaskOperationStart,
  TaskContinuationStart,
  TaskPlanUpdate,
  TunnelAttachmentCreate,
  BrowserTunnelRequest,
  BrowserSummary,
  AppDestinationUpdate,
  TunnelUserCreate,
  TunnelUserUpdate,
  UserSettingsUpdate,
  ExplorerFileWrite,
  ExplorerDirectoryCreate,
  ExplorerEntry,
  ExplorerEntryDelete,
  ExplorerEntryMutationResult,
  ExplorerEntryRename,
  WorktreePolicy,
  WorkerCredentialRotate,
  WorkerEncryptionRefreshRequest,
  WorkerEncryptionStatus,
  WorkerEnrollmentCodeCreate,
  WorkerSummary,
  WorkerUpdate,
  WorktreeStatusResult,
  ServiceLogLevel,
} from "@cantrip/protocol";
import {
  CantripApiError,
  post,
  request,
  requestResponse,
  withQuery,
} from "@/lib/api-client";
import {
  CHAT_MESSAGE_DECRYPT_CONCURRENCY,
  mapWithConcurrency,
  type ChatMessagePage,
} from "@/lib/chat-message-history";
import { getActiveServerUrl } from "@/lib/server-connections";
import { chatTitleEncryption } from "@/lib/chat-title-encryption";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import {
  INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE,
  isVisibleProjectCodeTab,
} from "@/lib/code-tab-visibility";
import {
  openSurfaceStreamContent,
  protectSurfaceStreamContent,
} from "@/lib/surface-stream-encryption";
import {
  createInitialTaskOpaqueContent,
  openTaskOpaqueSummary,
  prepareTaskDraftPersistence,
  prepareTaskPlanPersistence,
} from "@/lib/task-persistence-encryption";
import {
  openTaskGoalOpaqueSnapshot,
  openTaskMessageOpaqueSummary,
} from "@/lib/task-message-encryption";
import {
  createEncryptedChatTurn,
  openChatMessageOpaqueSummary,
  openQueuedPromptOpaqueSummary,
  replaceEncryptedQueuedPrompt,
} from "@/lib/chat-message-encryption";
import {
  openChatComposerDraft,
  protectChatComposerDraft,
} from "@/lib/chat-composer-draft-encryption";
import {
  createEncryptedAgentInteractionResponse,
  openEncryptedAgentInteractionRequest,
} from "@/lib/interaction-encryption";
import { openEncryptedChatPlanWireState } from "@/lib/chat-plan-encryption";
import {
  openAttachmentDownload,
  openAttachmentOpaqueList,
  openAttachmentOpaqueSummary,
  protectAttachmentUpload,
} from "@/lib/attachment-encryption";
import {
  openEffectivePolicyWireList,
  openPolicyAssignmentWireList,
  openPolicyWireDetail,
  openPolicyWireList,
  protectPolicyCreate,
  protectPolicyUpdate,
} from "@/lib/policy-encryption";
import {
  openMcpServerWireList,
  openMcpServerWireSummary,
  openDiscoveredMcpServerCreate,
  openModelProviderAccountWireList,
  openModelProviderAccountWireSummary,
  openModelProviderWireSummary,
  openModelProviderWireList,
  openSettingsBundleWire,
  protectMcpServerCreate,
  protectMcpServerUpdate,
  protectModelProviderAccountCreate,
  protectModelProviderAccountUpdate,
  protectModelProviderCreate,
  protectModelProviderUpdate,
} from "@/lib/protected-secrets";
import { openProviderTelemetryWireAnalytics } from "@/lib/provider-telemetry";
import {
  getPackagedPolicyTemplate,
  listPackagedPolicyTemplates,
} from "@/lib/policy-templates";
import {
  clientSessionIdentityMatches,
  getClientSession,
  getClientSessionIdentitySnapshot,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import { authorizeWorkerEncryption } from "@/lib/worker-encryption-grants";
import {
  openRepositoryOperationContent,
  protectRepositoryOperationContent,
} from "@/lib/repository-operation-encryption";
import { ensureRepositoryWorkerEncryption } from "@/lib/repository-worker-encryption";
import { ensureEndpointContentWorkerEncryption } from "@/lib/endpoint-content-worker-encryption";
import {
  customizationContentScopeSchema,
  type CustomizationContentOperation,
  type CustomizationContentScope,
} from "@cantrip/protocol/customization-content";
import {
  openCustomizationResponse,
  protectCustomizationRequest,
} from "@/lib/customization-content-encryption";
import { ShortLivedRequestCache } from "@/lib/short-lived-request-cache";
import { TunnelWorkerReadinessRequestCache } from "@/lib/tunnel-worker-readiness-cache";
import {
  createTunnelDataProtection,
  openTunnelContentRecord,
  openTunnelSummary,
  protectTunnelContentRecord,
} from "@/lib/tunnel-content-encryption";
import { createBoundedResource } from "@/lib/bounded-resource-creation";
import { recoverStaleProjectShareState } from "@/lib/project-share-recovery";

export { CantripApiError };
export * from "@/lib/workflow-api";

export async function getSystemHealth() {
  return systemHealthSchema.parse(await request("/api/health"));
}

export async function getServerBootstrap() {
  return serverBootstrapSchema.parse(
    await request("/api/bootstrap", {
      signal: AbortSignal.timeout(10_000),
    }),
  );
}

export async function getAuthSession() {
  return authSessionStateSchema.parse(
    await request("/api/auth/session", {
      signal: AbortSignal.timeout(10_000),
    }),
  );
}

export async function getAccountSessions() {
  return accountSessionListSchema.parse(await request("/api/account/sessions"));
}

export async function getAccountResourceUsage() {
  return accountResourceUsageSchema.parse(
    await request("/api/account/resource-usage"),
  );
}

export async function getAccountResourceUsageHistory(
  input: AccountResourceUsageHistoryQuery,
) {
  const query = accountResourceUsageHistoryQuerySchema.parse(input);
  return accountResourceUsageHistorySchema.parse(
    await request(
      `/api/account/resource-usage/history?${new URLSearchParams(query).toString()}`,
    ),
  );
}

export async function getAccountLiveTraffic(
  input: AccountLiveTrafficQuery = {},
  signal?: AbortSignal,
) {
  const query = accountLiveTrafficQuerySchema.parse(input);
  const suffix = new URLSearchParams(query).toString();
  return accountLiveTrafficSchema.parse(
    await request(`/api/account/live-traffic${suffix ? `?${suffix}` : ""}`, {
      signal,
    }),
  );
}

export async function login(input: AuthLogin) {
  return authSessionSchema.parse(
    await post("/api/auth/login", authLoginSchema.parse(input)),
  );
}

export async function createMobileSignInGrant() {
  return mobileSignInGrantCreateResultSchema.parse(
    await post("/api/auth/mobile-sign-in/grants", {}),
  );
}

export async function exchangeMobileSignInGrant(
  serverUrl: string,
  input: MobileSignInGrantExchange,
) {
  return authSessionSchema.parse(
    await request(`${serverUrl}/api/auth/mobile-sign-in/exchange`, {
      method: "POST",
      body: JSON.stringify(mobileSignInGrantExchangeSchema.parse(input)),
    }),
  );
}

export async function registerAccount(
  input: AccountRegistration,
  bootstrapToken?: string,
) {
  return authSessionSchema.parse(
    await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(accountRegistrationSchema.parse(input)),
      headers: bootstrapToken
        ? { "x-cantrip-bootstrap-token": bootstrapToken }
        : undefined,
    }),
  );
}

export async function getAccountAdminSummary() {
  return accountAdminSummarySchema.parse(await request("/api/admin/accounts"));
}

export async function addAccountLicenseWhitelistEntry(email: string) {
  return accountLicenseWhitelistEntrySchema.parse(
    await post(
      "/api/admin/license-whitelist",
      accountLicenseWhitelistCreateSchema.parse({ email }),
    ),
  );
}

export async function removeAccountLicenseWhitelistEntry(
  entryId: string,
): Promise<void> {
  await request(`/api/admin/license-whitelist/${encodeURIComponent(entryId)}`, {
    method: "DELETE",
  });
}

export async function logout(): Promise<void> {
  await post("/api/auth/logout", {});
}

export async function logoutAll() {
  return authLogoutAllResultSchema.parse(
    await post("/api/auth/logout-all", {}),
  );
}

export async function getWorkers() {
  return workerListSchema.parse(await request("/api/workers"));
}

export async function refreshWorkerEncryption(
  workerId: string,
  input: WorkerEncryptionRefreshRequest,
) {
  return workerEncryptionRefreshResultSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/encryption/refresh`,
      workerEncryptionRefreshRequestSchema.parse(input),
    ),
  );
}

export async function checkCodeGraphUpdate(workerId: string) {
  return codeGraphActionAcknowledgementSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/codegraph/update-check`,
      {},
    ),
  );
}

export async function runManagedWebRuntimeAction(
  workerId: string,
  input: import("@cantrip/protocol").ManagedWebRuntimeActionRequest,
) {
  return managedWebRuntimeActionResultSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/web-runtimes/actions`,
      managedWebRuntimeActionRequestSchema.parse(input),
    ),
  );
}

function codeGraphWorktreePath(projectId: string, worktreeId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/codegraph`;
}

export async function getCodeGraphWorktreeStatus(
  projectId: string,
  worktreeId: string,
) {
  return codeGraphProjectStatusSchema.parse(
    await request(codeGraphWorktreePath(projectId, worktreeId)),
  );
}

export async function requestCodeGraphWorktreeAction(
  projectId: string,
  worktreeId: string,
  action: "sync" | "rebuild",
) {
  return codeGraphActionAcknowledgementSchema.parse(
    await post(`${codeGraphWorktreePath(projectId, worktreeId)}/${action}`, {}),
  );
}

export async function getWorkerServiceLogs(
  workerId: string,
  options: {
    afterCursor?: number;
    beforeCursor?: number;
    limit?: number;
    minimumLevel?: ServiceLogLevel;
  } = {},
) {
  return serviceLogReadResultSchema.parse(
    await request(
      withQuery(`/api/workers/${encodeURIComponent(workerId)}/logs`, options),
    ),
  );
}

export async function createDirectWorkerProbe(workerId: string) {
  return directAttachmentTicketSchema.parse(
    await post(`/api/workers/${encodeURIComponent(workerId)}/direct-probe`, {}),
  );
}

export async function createWorkerLinkSession(
  workerId: string,
  clientInstanceId: string,
) {
  return workerLinkSessionSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/worker-link/sessions`,
      workerLinkSessionOpenRequestSchema.parse({ clientInstanceId }),
    ),
  );
}

export async function renewWorkerLinkSession(sessionId: string) {
  return workerLinkSessionSchema.parse(
    await post(`/api/worker-links/${encodeURIComponent(sessionId)}/renew`, {}),
  );
}

export async function updateWorkerLinkRoute(
  sessionId: string,
  preferredRoute: WorkerLinkRoute,
) {
  return workerLinkSessionSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/route`,
      workerLinkRouteUpdateRequestSchema.parse({ preferredRoute }),
    ),
  );
}

export async function recordWorkerLinkTelemetry(
  sessionId: string,
  routeGeneration: number,
  samples: WorkerLinkTelemetrySample[],
): Promise<void> {
  await post(
    `/api/worker-links/${encodeURIComponent(sessionId)}/telemetry`,
    workerLinkTelemetryBatchSchema.parse({ routeGeneration, samples }),
  );
}

export async function createWorkerLinkDirectTicket(sessionId: string) {
  return directAttachmentTicketSchema.parse(
    await post(`/api/worker-links/${encodeURIComponent(sessionId)}/direct`, {}),
  );
}

export async function activateWorkerLinkDirectTicket(
  sessionId: string,
  capabilityId: string,
): Promise<void> {
  await post(
    `/api/worker-links/${encodeURIComponent(sessionId)}/direct-activate`,
    workerLinkDirectActivationSchema.parse({ capabilityId }),
  );
}

export async function createWorkerLinkPeerSession(
  sessionId: string,
  routeGeneration: number,
  route: "lan" | "wan",
) {
  return workerLinkPeerSessionDescriptorSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/peers`,
      workerLinkPeerSessionOpenRequestSchema.parse({ routeGeneration, route }),
    ),
  );
}

export async function sendWorkerLinkPeerSignals(
  sessionId: string,
  peerSessionId: string,
  signals: WorkerLinkPeerSignalEnvelope[],
): Promise<void> {
  await post(
    `/api/worker-links/${encodeURIComponent(sessionId)}/peers/${encodeURIComponent(peerSessionId)}/signals`,
    workerLinkPeerSignalBatchSchema.parse({ signals }),
  );
}

export async function readWorkerLinkPeerMailbox(
  sessionId: string,
  peerSessionId: string,
  input: Partial<WorkerLinkPeerMailboxReadRequest> = {},
) {
  return workerLinkPeerMailboxSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/peers/${encodeURIComponent(peerSessionId)}/mailbox`,
      workerLinkPeerMailboxReadRequestSchema.parse(input),
    ),
  );
}

export async function deleteWorkerLinkPeerSession(
  sessionId: string,
  peerSessionId: string,
): Promise<void> {
  await request(
    `/api/worker-links/${encodeURIComponent(sessionId)}/peers/${encodeURIComponent(peerSessionId)}`,
    { method: "DELETE" },
  );
}

export async function createTerminalWorkerLinkGrant(
  sessionId: string,
  terminalId: string,
  operationId: string,
) {
  return workerLinkResourceGrantSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/grant`,
      workerLinkTerminalGrantRequestSchema.parse({ operationId }),
    ),
  );
}

export async function createRemoteSurfaceWorkerLinkGrant(
  sessionId: string,
  surfaceId: string,
  viewport: { width: number; height: number; devicePixelRatio: number },
) {
  return workerLinkResourceGrantSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/remote-surfaces/${encodeURIComponent(surfaceId)}/grant`,
      workerLinkRemoteSurfaceGrantRequestSchema.parse({ viewport }),
    ),
  );
}

export async function createWorkerObservationGrant(
  sessionId: string,
  topics: Array<"chat-progress" | "filesystem" | "worktree" | "runtime">,
) {
  return workerLinkResourceGrantSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/observations/grant`,
      workerLinkObservationGrantRequestSchema.parse({ topics }),
    ),
  );
}

export async function createTunnelWorkerLinkGrant(
  sessionId: string,
  attachmentId: string,
  input: { diagnosticTraceId?: string } = {},
) {
  return workerLinkTunnelGrantSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/tunnel-attachments/${encodeURIComponent(attachmentId)}/grant`,
      workerLinkTunnelGrantRequestSchema.parse(input),
    ),
  );
}

export async function renewWorkerLinkGrant(sessionId: string, grantId: string) {
  return workerLinkLeaseSchema.parse(
    await post(
      `/api/worker-links/${encodeURIComponent(sessionId)}/grants/${encodeURIComponent(grantId)}/renew`,
      {},
    ),
  );
}

export async function deleteWorkerLinkGrant(
  sessionId: string,
  grantId: string,
): Promise<void> {
  await request(
    `/api/worker-links/${encodeURIComponent(sessionId)}/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE" },
  );
}

export async function deleteWorkerLinkSession(
  sessionId: string,
): Promise<void> {
  await request(`/api/worker-links/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function deleteDirectAttachment(
  capabilityId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  await request(
    `${options.serverUrl ?? ""}/api/direct-attachments/${encodeURIComponent(capabilityId)}`,
    {
      method: "DELETE",
      signal: options.signal,
    },
    options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
  );
}

export async function recordDirectAttachmentTelemetry(
  capabilityId: string,
  telemetry: Parameters<typeof directTransportTelemetrySchema.parse>[0],
  options: { serverUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  await request(
    `${options.serverUrl ?? ""}/api/direct-attachments/${encodeURIComponent(capabilityId)}/telemetry`,
    {
      body: JSON.stringify(directTransportTelemetrySchema.parse(telemetry)),
      method: "POST",
      signal: options.signal,
    },
    options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
  );
}

export async function getTunnels(projectId?: string) {
  const tunnels = tunnelWireListSchema.parse(
    await request(
      projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/tunnels`
        : "/api/tunnels",
    ),
  );
  return Promise.all(tunnels.map((tunnel) => openTunnelSummary(tunnel)));
}

export async function getTunnelTransportConfiguration(
  tunnelId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
) {
  const wire = tunnelWireSummarySchema.parse(
    await request(
      `${options.serverUrl ?? ""}/api/tunnels/${encodeURIComponent(tunnelId)}`,
      {
        signal: options.signal,
      },
      options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
    ),
  );
  if (!wire.protectedRecord) {
    throw new Error("This tunnel does not have protected data-plane keys.");
  }
  const content = await openTunnelContentRecord({
    tunnelId,
    record: wire.protectedRecord,
    workerId: wire.destination.workerId,
  });
  return {
    dataProtection: { ...content.dataProtection },
    workerId: wire.destination.workerId,
  };
}

export async function getTunnelDataProtection(
  tunnelId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
) {
  return (await getTunnelTransportConfiguration(tunnelId, options))
    .dataProtection;
}

export async function createTunnel(input: TunnelUserCreate) {
  const parsed = tunnelUserCreateSchema.parse(input);
  await ensureTunnelWorker(parsed.destination.workerId);
  const id = crypto.randomUUID();
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: parsed.name,
      description: parsed.description,
      source: { kind: "desktop-loopback" },
      destination: parsed.destination,
      dataProtection: createTunnelDataProtection(),
    },
    operationId: id,
    revision: 1,
    tunnelId: id,
    workerId: parsed.destination.workerId,
  });
  return openTunnelSummary(
    await post(
      "/api/tunnels",
      tunnelUserWireCreateSchema.parse({
        id,
        projectId: parsed.projectId,
        protocolHint: parsed.protocolHint,
        destination: {
          kind: parsed.destination.kind,
          workerId: parsed.destination.workerId,
        },
        protectedRecord,
      }),
    ),
  );
}

export async function updateTunnel(tunnelId: string, input: TunnelUserUpdate) {
  const parsed = tunnelUserUpdateSchema.parse(input);
  const currentWire = tunnelWireSummarySchema.parse(
    await request(`/api/tunnels/${encodeURIComponent(tunnelId)}`),
  );
  if (
    !currentWire.protectedRecord ||
    currentWire.management !== "user-managed"
  ) {
    throw new Error("This tunnel does not have editable protected content.");
  }
  const currentContent = await openTunnelContentRecord({
    tunnelId,
    record: currentWire.protectedRecord,
    workerId: currentWire.destination.workerId,
  });
  const current = await openTunnelSummary(currentWire);
  const destination = parsed.destination ?? current.destination;
  if (destination.kind !== "worker-tcp") {
    throw new Error("User tunnels require a worker TCP destination.");
  }
  await ensureTunnelWorker(destination.workerId);
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: parsed.name ?? current.name,
      description:
        parsed.description === undefined
          ? current.description
          : parsed.description,
      source: current.source,
      destination,
      dataProtection: currentContent.dataProtection,
    },
    operationId: crypto.randomUUID(),
    revision: currentWire.protectedRecord.revision + 1,
    tunnelId,
    workerId: destination.workerId,
  });
  return openTunnelSummary(
    await request(`/api/tunnels/${encodeURIComponent(tunnelId)}`, {
      method: "PATCH",
      body: JSON.stringify(
        tunnelUserWireUpdateSchema.parse({
          ...(parsed.projectId === undefined
            ? {}
            : { projectId: parsed.projectId }),
          ...(parsed.protocolHint === undefined
            ? {}
            : { protocolHint: parsed.protocolHint }),
          ...(parsed.destination === undefined
            ? {}
            : {
                destination: {
                  kind: destination.kind,
                  workerId: destination.workerId,
                },
              }),
          protectedRecord,
        }),
      ),
    }),
  );
}

export async function deleteTunnel(tunnelId: string): Promise<void> {
  await request(`/api/tunnels/${encodeURIComponent(tunnelId)}`, {
    method: "DELETE",
  });
}

export async function createTunnelAttachment(
  tunnelId: string,
  input: TunnelAttachmentCreate,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
) {
  return tunnelAttachmentCreateResultSchema.parse(
    await request(
      `${options.serverUrl ?? ""}/api/tunnels/${encodeURIComponent(tunnelId)}/attachments`,
      {
        body: JSON.stringify(tunnelAttachmentCreateSchema.parse(input)),
        method: "POST",
        signal: options.signal,
      },
      options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
    ),
  );
}

export async function deleteTunnelAttachment(
  attachmentId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  await request(
    `${options.serverUrl ?? ""}/api/tunnel-attachments/${encodeURIComponent(attachmentId)}`,
    {
      method: "DELETE",
      signal: options.signal,
    },
    options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
  );
}

export async function renewTunnelAttachmentLease(
  attachmentId: string,
  options: { serverUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  await request(
    `${options.serverUrl ?? ""}/api/tunnel-attachments/${encodeURIComponent(attachmentId)}/lease`,
    {
      method: "POST",
      signal: options.signal,
    },
    options.serverUrl ? BOUND_API_REQUEST_BEHAVIOR : undefined,
  );
}

export async function getWorkerManagement() {
  const workers = workerManagementListSchema.parse(
    await request("/api/workers/management"),
  );
  return Promise.all(
    workers.map(async (worker) => ({
      ...worker,
      sources: await Promise.all(
        worker.sources.map(async (source) => {
          try {
            const resolved = await resolveWorkerRepositoryMetadata({
              workerId: worker.workerId,
              scopeId: source.projectId,
              values: {
                nameWithOwner: source.nameWithOwner,
                displayPath: source.displayPath,
              },
            });
            return {
              ...source,
              nameWithOwner:
                typeof resolved.values.nameWithOwner === "string"
                  ? resolved.values.nameWithOwner
                  : "Protected repository unavailable",
              displayPath:
                typeof resolved.values.displayPath === "string"
                  ? resolved.values.displayPath
                  : "Protected path unavailable",
            };
          } catch {
            return {
              ...source,
              nameWithOwner: "Protected repository unavailable",
              displayPath: "Protected path unavailable",
            };
          }
        }),
      ),
    })),
  );
}

export async function updateWorker(workerId: string, input: WorkerUpdate) {
  return workerSummarySchema.parse(
    await request(`/api/workers/${encodeURIComponent(workerId)}`, {
      method: "PATCH",
      body: JSON.stringify(workerUpdateSchema.parse(input)),
    }),
  );
}

export async function restartWorker(workerId: string) {
  return workerRestartResultSchema.parse(
    await post(`/api/workers/${encodeURIComponent(workerId)}/restart`, {}),
  );
}

export async function unlinkWorker(workerId: string) {
  await request(`/api/workers/${encodeURIComponent(workerId)}`, {
    method: "DELETE",
  });
}

export async function createWorkerEnrollmentCode(
  input: WorkerEnrollmentCodeCreate,
) {
  return workerEnrollmentCodeResultSchema.parse(
    await post(
      "/api/workers/enrollment-codes",
      workerEnrollmentCodeCreateSchema.parse(input),
    ),
  );
}

export async function getWorkerEnrollmentCodeStatus(enrollmentCodeId: string) {
  return workerEnrollmentCodeStatusSchema.parse(
    await request(
      `/api/workers/enrollment-codes/${encodeURIComponent(enrollmentCodeId)}`,
    ),
  );
}

export async function getWorkerCredentials(workerId: string) {
  return workerCredentialListSchema.parse(
    await request(`/api/workers/${encodeURIComponent(workerId)}/credentials`),
  );
}

export async function rotateWorkerCredential(
  workerId: string,
  input: WorkerCredentialRotate,
) {
  return workerCredentialRotateResultSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(workerId)}/credentials/rotate`,
      workerCredentialRotateSchema.parse(input),
    ),
  );
}

export async function revokeWorkerCredential(
  workerId: string,
  credentialId: string,
) {
  await request(
    `/api/workers/${encodeURIComponent(workerId)}/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
}

export async function getCodexAuthStatus(
  providerId: string,
  accountId?: string,
  workerId?: string,
) {
  const query = new URLSearchParams({ providerId });
  if (accountId) query.set("accountId", accountId);
  if (workerId) query.set("workerId", workerId);
  return codexAuthStatusSchema.parse(
    await request(`/api/codex/auth/status?${query.toString()}`),
  );
}

export async function startCodexDeviceLogin(
  workerId: string,
  providerId: string,
  accountId?: string,
) {
  const session = getClientSession();
  const snapshot = clientEncryption.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new Error("Encryption must be unlocked before provider sign-in.");
  }
  await authorizeWorkerEncryption({
    components: ["provider-credential", "mcp-secret"],
    identity: snapshot.identity,
    keyRevision: snapshot.masterKeyRevision,
    workerId,
  });
  await refreshWorkerEncryption(workerId, {
    component: "provider-credential",
    keyRevision: snapshot.masterKeyRevision,
  });
  return codexDeviceLoginSchema.parse(
    await post("/api/codex/auth/device-login", {
      workerId,
      providerId,
      accountId,
    }),
  );
}

export async function logoutCodex(
  providerId: string,
  accountId?: string,
  workerId?: string,
) {
  await post("/api/codex/auth/logout", { providerId, accountId, workerId });
}

export async function getProviderRateLimitResets(
  providerId: string,
  accountId: string,
  workerId: string,
) {
  const query = new URLSearchParams({ workerId });
  return providerQuotaSnapshotSchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/rate-limit-resets?${query.toString()}`,
    ),
  );
}

export async function consumeProviderRateLimitReset(
  providerId: string,
  accountId: string,
  input: {
    creditId?: string | null;
    idempotencyKey: string;
    workerId: string;
  },
) {
  return providerRateLimitResetConsumeResultSchema.parse(
    await post(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/rate-limit-resets/consume`,
      input,
    ),
  );
}

export async function getSettings() {
  return openSettingsBundleWire(await request("/api/settings"));
}

export async function updateSettings(input: UserSettingsUpdate) {
  return openSettingsBundleWire(
    await request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateAppDestination(input: AppDestinationUpdate) {
  return appDestinationSchema.parse(
    await request("/api/settings/destination", {
      method: "PATCH",
      body: JSON.stringify(appDestinationUpdateSchema.parse(input)),
    }),
  );
}

export async function getTaskWorkers() {
  return taskWorkerListSchema.parse(
    await request("/api/settings/task-workers"),
  );
}

export async function createTaskWorker(input: TaskWorkerCreate) {
  return taskWorkerSummarySchema.parse(
    await request("/api/settings/task-workers", {
      method: "POST",
      body: JSON.stringify(taskWorkerCreateSchema.parse(input)),
    }),
  );
}

export async function updateTaskWorker(
  taskWorkerId: string,
  input: TaskWorkerUpdate,
) {
  return taskWorkerSummarySchema.parse(
    await request(
      `/api/settings/task-workers/${encodeURIComponent(taskWorkerId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(taskWorkerUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function deleteTaskWorker(
  taskWorkerId: string,
  rowVersion: number,
): Promise<void> {
  await request(
    `/api/settings/task-workers/${encodeURIComponent(taskWorkerId)}`,
    {
      method: "DELETE",
      body: JSON.stringify(taskWorkerDeleteSchema.parse({ rowVersion })),
    },
  );
}

export async function reorderTaskWorkers(input: TaskWorkerOrderUpdate) {
  return taskWorkerListSchema.parse(
    await request("/api/settings/task-workers/order", {
      method: "PUT",
      body: JSON.stringify(taskWorkerOrderUpdateSchema.parse(input)),
    }),
  );
}

export async function getProjectTaskPauseState(projectId: string) {
  return projectTaskPauseStateSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/tasks/pause`),
  );
}

export async function getProjectTaskWorkload(projectId: string) {
  const opaque = projectTaskWorkloadOpaqueSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/workload`,
    ),
  );
  const items = await mapWithConcurrency(opaque.items, 6, async (item) => ({
    task: await openTaskOpaqueSummary(item.task),
    plan: await openEncryptedChatPlanWireState(item.task.chatId, item.plan),
    messages: chatMessageListSchema.parse(
      await mapWithConcurrency(
        item.messages,
        CHAT_MESSAGE_DECRYPT_CONCURRENCY,
        (message) => openTaskMessageOpaqueSummary(message),
      ),
    ),
  }));
  return { projectId: opaque.projectId, items };
}

export async function setProjectTaskPauseState(
  projectId: string,
  input: ProjectTaskPauseUpdate,
) {
  return projectTaskPauseStateSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/pause`,
      {
        method: "PATCH",
        body: JSON.stringify(projectTaskPauseUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function getPolicyTemplates() {
  return listPackagedPolicyTemplates();
}

export async function getPolicyTemplate(templateKey: string) {
  const template = getPackagedPolicyTemplate(templateKey);
  if (!template) {
    throw new Error(`Packaged policy template ${templateKey} is unavailable.`);
  }
  return template;
}

export async function getPolicies() {
  let wire = policyWireListSchema.parse(await request("/api/policies"));
  if (wire.bootstrapVersion < POLICY_BOOTSTRAP_VERSION) {
    const templates = await Promise.all(
      (await getPolicyTemplates())
        .filter(({ suggestedDefault }) => suggestedDefault)
        .map(({ templateKey }) => getPolicyTemplate(templateKey)),
    );
    const policies = await Promise.all(
      templates.map((template) =>
        protectPolicyCreate(
          {
            key: template.suggestedPolicyKey,
            name: template.name,
            summary: template.summary,
            bodyMarkdown: template.bodyMarkdown,
            enabled: template.suggestedEnabled,
            mandatory: template.suggestedMandatory,
            audience: "ide",
          },
          template.templateKey,
        ),
      ),
    );
    wire = policyWireListSchema.parse(
      await post(
        "/api/policies/bootstrap",
        encryptedPolicyBootstrapSchema.parse({
          expectedBootstrapVersion: wire.bootstrapVersion,
          policies,
        }),
      ),
    );
  }
  return openPolicyWireList(wire);
}

export async function getPolicy(policyId: string) {
  return openPolicyWireDetail(
    await request(`/api/policies/${encodeURIComponent(policyId)}`),
  );
}

export async function createPolicy(input: PolicyCreate) {
  return openPolicyWireDetail(
    policyWireDetailSchema.parse(
      await post(
        "/api/policies",
        await protectPolicyCreate(policyCreateSchema.parse(input)),
      ),
    ),
  );
}

export async function createPolicyFromTemplate(
  templateKey: string,
  input: PolicyFromTemplateCreate = {},
) {
  const overrides = policyFromTemplateCreateSchema.parse(input);
  const template = await getPolicyTemplate(templateKey);
  return openPolicyWireDetail(
    policyWireDetailSchema.parse(
      await post(
        "/api/policies",
        await protectPolicyCreate(
          policyCreateSchema.parse({
            key: overrides.key ?? template.suggestedPolicyKey,
            name: overrides.name ?? template.name,
            summary: overrides.summary ?? template.summary,
            bodyMarkdown: overrides.bodyMarkdown ?? template.bodyMarkdown,
            enabled: overrides.enabled ?? template.suggestedEnabled,
            mandatory: overrides.mandatory ?? template.suggestedMandatory,
            audience: overrides.audience ?? "ide",
          }),
          templateKey,
        ),
      ),
    ),
  );
}

export async function updatePolicy(policyId: string, input: PolicyUpdate) {
  const parsed = policyUpdateSchema.parse(input);
  const current = await getPolicy(policyId);
  return openPolicyWireDetail(
    policyWireDetailSchema.parse(
      await request(`/api/policies/${encodeURIComponent(policyId)}`, {
        method: "PATCH",
        body: JSON.stringify(
          await protectPolicyUpdate(policyId, current, parsed),
        ),
      }),
    ),
  );
}

export async function deletePolicy(policyId: string, rowVersion: number) {
  await request(`/api/policies/${encodeURIComponent(policyId)}`, {
    method: "DELETE",
    body: JSON.stringify(policyDeleteSchema.parse({ rowVersion })),
  });
}

export async function reorderPolicies(input: PolicyOrderUpdate) {
  return openPolicyWireList(
    await request("/api/policies/order", {
      method: "PATCH",
      body: JSON.stringify(policyOrderUpdateSchema.parse(input)),
    }),
  );
}

export async function resetPolicyFromTemplate(
  policyId: string,
  input: PolicyTemplateReset,
) {
  const reset = policyTemplateResetSchema.parse(input);
  const current = await getPolicy(policyId);
  if (!current.templateKey) {
    throw new Error("This policy was not created from a packaged template.");
  }
  const template = await getPolicyTemplate(current.templateKey);
  return updatePolicy(policyId, {
    rowVersion: reset.rowVersion,
    name: template.name,
    summary: template.summary,
    bodyMarkdown: template.bodyMarkdown,
    ...(reset.restoreDefaults
      ? {
          enabled: template.suggestedEnabled,
          mandatory: template.suggestedMandatory,
        }
      : {}),
  });
}

export async function getWorkspacePolicyAssignments(workspaceId: string) {
  return openPolicyAssignmentWireList(
    await request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/policies`,
    ),
  );
}

export async function updateWorkspacePolicyAssignments(
  workspaceId: string,
  input: PolicyAssignmentUpdate,
) {
  return openPolicyAssignmentWireList(
    await request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/policies`,
      {
        method: "PATCH",
        body: JSON.stringify(policyAssignmentUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function getProjectPolicyAssignments(projectId: string) {
  return openPolicyAssignmentWireList(
    await request(`/api/projects/${encodeURIComponent(projectId)}/policies`),
  );
}

export async function updateProjectPolicyAssignments(
  projectId: string,
  input: PolicyAssignmentUpdate,
) {
  return openPolicyAssignmentWireList(
    await request(`/api/projects/${encodeURIComponent(projectId)}/policies`, {
      method: "PATCH",
      body: JSON.stringify(policyAssignmentUpdateSchema.parse(input)),
    }),
  );
}

export async function getProjectEffectivePolicies(projectId: string) {
  return openEffectivePolicyWireList(
    effectivePolicyWireListSchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/effective-policies`,
      ),
    ),
  );
}

export async function getGlobalMcpServers() {
  return openMcpServerWireList(await request("/api/settings/mcp-servers"));
}

export async function discoverGlobalMcpServers(workerId: string) {
  const discovered = mcpServerDiscoveryResultSchema.parse(
    await request(
      `/api/settings/mcp-discovery/${encodeURIComponent(workerId)}`,
    ),
  );
  return {
    ...discovered,
    candidates: await Promise.all(
      discovered.candidates.map(async (candidate) => ({
        source: candidate.source,
        sourceScope: candidate.sourceScope,
        ...(await openDiscoveredMcpServerCreate(candidate.configuration)),
      })),
    ),
  };
}

export async function addGlobalDiscoveredMcpServer(
  input: EncryptedMcpServerCreate,
) {
  return openMcpServerWireSummary(
    await post("/api/settings/mcp-servers", input),
  );
}

export async function createGlobalMcpServer(
  input: McpServerConfiguration,
  workerId: string | null = null,
  audience: ResourceAudience = "ide",
) {
  return openMcpServerWireSummary(
    await post(
      "/api/settings/mcp-servers",
      await protectMcpServerCreate(input, workerId, {}, audience),
    ),
  );
}

export async function updateGlobalMcpServer(
  serverId: string,
  input: McpServerConfiguration,
  workerId: string | null = null,
  audience?: ResourceAudience,
) {
  return openMcpServerWireSummary(
    await request(`/api/settings/mcp-servers/${encodeURIComponent(serverId)}`, {
      method: "PUT",
      body: JSON.stringify(
        await protectMcpServerUpdate(serverId, input, workerId, {}, audience),
      ),
    }),
  );
}

export async function deleteGlobalMcpServer(serverId: string) {
  await request(`/api/settings/mcp-servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
  });
}

export async function createModelProvider(input: ModelProviderCreate) {
  return openModelProviderWireSummary(
    await post(
      "/api/settings/providers",
      await protectModelProviderCreate(input),
    ),
  );
}

export async function getProviderModelCatalog(
  providerId: string,
  workerId?: string | null,
) {
  const query = workerId ? `?workerId=${encodeURIComponent(workerId)}` : "";
  return providerModelCatalogResultSchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/catalog${query}`,
    ),
  );
}

export async function refreshProviderModelCatalog(
  providerId: string,
  workerId?: string | null,
) {
  const query = workerId ? `?workerId=${encodeURIComponent(workerId)}` : "";
  return providerModelCatalogResultSchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/catalog/refresh${query}`,
      { method: "POST" },
    ),
  );
}

export async function testModelProviderConnection(
  providerId: string,
  workerId?: string | null,
) {
  const query = workerId ? `?workerId=${encodeURIComponent(workerId)}` : "";
  return providerConnectionTestResultSchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/test${query}`,
      { method: "POST" },
    ),
  );
}

export async function listModelProviderAccounts(providerId: string) {
  return openModelProviderAccountWireList(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts`,
    ),
  );
}

export async function createModelProviderAccount(
  providerId: string,
  input: ModelProviderAccountCreate,
) {
  return openModelProviderAccountWireSummary(
    await post(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts`,
      await protectModelProviderAccountCreate(input),
    ),
  );
}

export async function updateModelProviderAccount(
  providerId: string,
  accountId: string,
  input: ModelProviderAccountUpdate,
) {
  return openModelProviderAccountWireSummary(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(
          await protectModelProviderAccountUpdate(accountId, input),
        ),
      },
    ),
  );
}

export async function reorderModelProviderAccounts(
  providerId: string,
  ids: string[],
) {
  await request(
    `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/order`,
    {
      method: "PATCH",
      body: JSON.stringify(orderedIdsSchema.parse({ ids })),
    },
  );
}

export async function deleteModelProviderAccount(
  providerId: string,
  accountId: string,
) {
  await request(
    `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  );
}

export async function deleteModelProvider(providerId: string) {
  await request(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
}

export async function updateModelProvider(
  providerId: string,
  input: ModelProviderUpdate,
) {
  return openModelProviderWireSummary(
    await request(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify(await protectModelProviderUpdate(providerId, input)),
    }),
  );
}

export async function createModelProfile(input: ModelProfileCreate) {
  return modelProfileSummarySchema.parse(
    await post("/api/settings/models", modelProfileCreateSchema.parse(input)),
  );
}

export async function getModelReasoningOptions(modelId: string) {
  return chatReasoningStateSchema.parse(
    await request(
      `/api/settings/models/${encodeURIComponent(modelId)}/reasoning`,
    ),
  );
}

export async function deleteModelProfile(modelId: string) {
  await request(`/api/settings/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
}

export async function updateModelProfile(
  modelId: string,
  input: ModelProfileUpdate,
) {
  return modelProfileSummarySchema.parse(
    await request(`/api/settings/models/${encodeURIComponent(modelId)}`, {
      method: "PATCH",
      body: JSON.stringify(modelProfileUpdateSchema.parse(input)),
    }),
  );
}

export async function getGithubStatus(workerId: string) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.auth.status",
    arguments: {},
    resultSchema: githubAuthStatusSchema,
  });
}

export async function getGithubRepositories(workerId: string) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.repositories.list",
    arguments: {},
    resultSchema: githubRepositoryListSchema,
  });
}

export async function getGithubRepositoryOwners(workerId: string) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.repository-owners.list",
    arguments: {},
    resultSchema: githubRepositoryOwnerListSchema,
  });
}

export async function createGithubRepository(
  workerId: string,
  input: GithubRepositoryCreate,
) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.repositories.create",
    arguments: { request: githubRepositoryCreateSchema.parse(input) },
    resultSchema: githubRepositorySchema,
  });
}

export async function getCachedGithubRepositories(
  workerId: string,
  login: string,
) {
  return runProtectedWorkerRepositoryOperation({
    workerId,
    scopeId: "github-catalog",
    type: "github.repositories.cached",
    arguments: { login },
    resultSchema: githubRepositoryListSchema,
  });
}

export async function getProjectWireList() {
  return projectWireListSchema.parse(await request("/api/projects"));
}

export async function getProjectMcpServers(projectId: string) {
  return openMcpServerWireList(
    await request(`/api/projects/${encodeURIComponent(projectId)}/mcp-servers`),
  );
}

export async function discoverProjectMcpServers(
  projectId: string,
  workerId: string,
) {
  const discovered = mcpServerDiscoveryResultSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-discovery/${encodeURIComponent(workerId)}`,
    ),
  );
  return {
    ...discovered,
    candidates: await Promise.all(
      discovered.candidates.map(async (candidate) => ({
        source: candidate.source,
        sourceScope: candidate.sourceScope,
        ...(await openDiscoveredMcpServerCreate(candidate.configuration)),
      })),
    ),
  };
}

export async function addProjectDiscoveredMcpServer(
  projectId: string,
  input: EncryptedMcpServerCreate,
) {
  return openMcpServerWireSummary(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      input,
    ),
  );
}

export async function createProjectMcpServer(
  projectId: string,
  input: McpServerConfiguration,
  workerId: string | null = null,
  audience: ResourceAudience = "ide",
) {
  return openMcpServerWireSummary(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      await protectMcpServerCreate(input, workerId, {}, audience),
    ),
  );
}

export async function updateProjectMcpServer(
  projectId: string,
  serverId: string,
  input: McpServerConfiguration,
  workerId: string | null = null,
  audience?: ResourceAudience,
) {
  return openMcpServerWireSummary(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}`,
      {
        method: "PUT",
        body: JSON.stringify(
          await protectMcpServerUpdate(serverId, input, workerId, {}, audience),
        ),
      },
    ),
  );
}

export async function deleteProjectMcpServer(
  projectId: string,
  serverId: string,
) {
  await request(
    `/api/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}`,
    { method: "DELETE" },
  );
}

export async function copyProjectMcpServer(
  projectId: string,
  input: McpServerCopy,
) {
  const copy = mcpServerCopySchema.parse(input);
  const source = (await getProjectMcpServers(copy.sourceProjectId)).find(
    ({ id }) => id === copy.sourceServerId,
  );
  if (!source) throw new Error("Source MCP server was not found.");
  const {
    id: _id,
    scope: _scope,
    projectId: _projectId,
    workerId: _workerId,
    audience,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...configuration
  } = source;
  return createProjectMcpServer(
    projectId,
    configuration,
    source.workerId,
    audience,
  );
}

async function currentProjectNetworkShare(projectId: string) {
  return tunnelWireListSchema
    .parse(await request("/api/tunnels"))
    .find(
      ({ origin, projectId: candidateProjectId }) =>
        origin === "project-share" && candidateProjectId === projectId,
    );
}

type ProjectNetworkShareTarget = Pick<
  ProjectWorktreeSummary,
  "id" | "path" | "workerId"
>;

async function createProjectNetworkShareAttempt(
  project: ProjectSummary,
  target?: ProjectNetworkShareTarget,
) {
  const source = target ?? project.source;
  if (!source) throw new Error("Project source is unavailable.");
  let existing = await currentProjectNetworkShare(project.id);
  if (existing && !existing.protectedRecord) {
    await deleteProjectNetworkShare(existing.id);
    existing = undefined;
  }
  const tunnelId = existing?.id ?? crypto.randomUUID();
  const existingContent = existing?.protectedRecord
    ? await openTunnelContentRecord({
        tunnelId,
        record: existing.protectedRecord,
        workerId: existing.destination.workerId,
      })
    : null;
  const tokenBytes = randomBytes(32);
  const usernameBytes = randomBytes(18);
  const passwordBytes = randomBytes(32);
  try {
    const publicBasePath = `/project-shares/${encodeBase64Url(tokenBytes)}`;
    const username = `cantrip-${encodeBase64Url(usernameBytes)}`;
    const password = encodeBase64Url(passwordBytes);
    const protectedRecord = await protectTunnelContentRecord({
      content: {
        name: "Project files",
        description: "Secure WebDAV access to this project's files.",
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-project-share",
          workerId: source.workerId,
          resourceId: tunnelId,
          root: source.path,
          publicBasePath,
          publicOrigin: "http://127.0.0.1",
          username,
          password,
          realm: "Cantrip Project Share",
        },
        dataProtection:
          existingContent?.dataProtection ?? createTunnelDataProtection(),
      },
      operationId: existing ? crypto.randomUUID() : tunnelId,
      revision: (existing?.protectedRecord?.revision ?? 0) + 1,
      tunnelId,
      workerId: source.workerId,
    });
    const wire = projectShareAttachmentWireSchema.parse(
      await post(
        `/api/projects/${encodeURIComponent(project.id)}/network-shares`,
        projectShareTunnelCreateSchema.parse({
          tunnelId,
          workerId: source.workerId,
          ...(target ? { worktreeId: target.id } : {}),
          protectedRecord,
        }),
      ),
    );
    if (wire.tunnelId !== tunnelId || wire.projectId !== project.id) {
      throw new Error("Project share response belongs to another tunnel.");
    }
    return projectShareAttachmentSchema.parse({
      attachmentId: wire.attachmentId,
      projectId: wire.projectId,
      protocol: wire.protocol,
      url: `http://127.0.0.1${publicBasePath}/`,
      username,
      password,
      realm: "Cantrip Project Share",
      expiresAt: wire.expiresAt,
      mountLeaseMs: wire.mountLeaseMs,
    });
  } finally {
    clearSensitiveBytes(tokenBytes);
    clearSensitiveBytes(usernameBytes);
    clearSensitiveBytes(passwordBytes);
  }
}

export async function createProjectNetworkShare(
  project: ProjectSummary,
  target?: ProjectNetworkShareTarget,
) {
  const source = target ?? project.source;
  if (!source) throw new Error("Project source is unavailable.");
  await ensureTunnelWorker(source.workerId);
  return recoverStaleProjectShareState({
    open: () => createProjectNetworkShareAttempt(project, target),
    revokeOrphan: async () => {
      const orphan = await currentProjectNetworkShare(project.id);
      if (orphan) await deleteProjectNetworkShare(orphan.id);
    },
  });
}

export async function createStandaloneChatNetworkShare(
  chat: StandaloneChatSummary,
) {
  const workerId = chat.activeWorkerId;
  const rootId = chat.activeScratchRootId;
  if (!workerId || !rootId) {
    throw new Error("Chat scratch placement is unavailable.");
  }
  await ensureTunnelWorker(workerId);
  const managedResourceId = `chat:${chat.id}`;
  let existing = tunnelWireListSchema
    .parse(await request("/api/tunnels"))
    .find(
      ({ origin, managedBy }) =>
        origin === "project-share" &&
        managedBy?.kind === "project-share" &&
        managedBy.id === managedResourceId,
    );
  let existingContent = existing?.protectedRecord
    ? await openTunnelContentRecord({
        tunnelId: existing.id,
        record: existing.protectedRecord,
        workerId: existing.destination.workerId,
      })
    : null;
  if (
    existing &&
    (!existingContent ||
      existingContent.destination.kind !== "worker-chat-share" ||
      existingContent.destination.chatId !== chat.id ||
      existingContent.destination.rootId !== rootId ||
      existingContent.destination.workerId !== workerId)
  ) {
    await deleteProjectNetworkShare(existing.id);
    existing = undefined;
    existingContent = null;
  }
  const tunnelId = existing?.id ?? crypto.randomUUID();
  const tokenBytes = randomBytes(32);
  const usernameBytes = randomBytes(18);
  const passwordBytes = randomBytes(32);
  try {
    const publicBasePath = `/project-shares/${encodeBase64Url(tokenBytes)}`;
    const username = `cantrip-${encodeBase64Url(usernameBytes)}`;
    const password = encodeBase64Url(passwordBytes);
    const protectedRecord = await protectTunnelContentRecord({
      content: {
        name: "Chat scratch files",
        description: "Secure WebDAV access to this Chat's scratch files.",
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-chat-share",
          workerId,
          resourceId: tunnelId,
          chatId: chat.id,
          rootId,
          publicBasePath,
          publicOrigin: "http://127.0.0.1",
          username,
          password,
          realm: "Cantrip Chat Share",
        },
        dataProtection:
          existingContent?.dataProtection ?? createTunnelDataProtection(),
      },
      operationId: existing ? crypto.randomUUID() : tunnelId,
      revision: (existing?.protectedRecord?.revision ?? 0) + 1,
      tunnelId,
      workerId,
    });
    const wire = standaloneChatShareAttachmentWireSchema.parse(
      await post(
        `/api/chats/${encodeURIComponent(chat.id)}/network-shares`,
        projectShareTunnelCreateSchema.parse({
          tunnelId,
          workerId,
          protectedRecord,
        }),
      ),
    );
    if (wire.tunnelId !== tunnelId || wire.chatId !== chat.id) {
      throw new Error("Chat share response belongs to another tunnel.");
    }
    return standaloneChatShareAttachmentSchema.parse({
      attachmentId: wire.attachmentId,
      chatId: wire.chatId,
      protocol: wire.protocol,
      url: `http://127.0.0.1${publicBasePath}/`,
      username,
      password,
      realm: "Cantrip Chat Share",
      expiresAt: wire.expiresAt,
      mountLeaseMs: wire.mountLeaseMs,
    });
  } finally {
    clearSensitiveBytes(tokenBytes);
    clearSensitiveBytes(usernameBytes);
    clearSensitiveBytes(passwordBytes);
  }
}

export async function deleteProjectNetworkShare(attachmentId: string) {
  await request(`/api/project-shares/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}

export async function getProjectWorkspaceWireList() {
  return projectWorkspaceWireListSchema.parse(await request("/api/workspaces"));
}

export async function createEncryptedProjectWorkspace(
  input: EncryptedProjectWorkspaceCreate,
) {
  return projectWorkspaceWireSummarySchema.parse(
    await post(
      "/api/workspaces",
      encryptedProjectWorkspaceCreateSchema.parse(input),
    ),
  );
}

export async function createEncryptedAttachedProjectWorkspace(input: {
  id: string;
  nameProtection: EncryptedProjectWorkspaceName;
  rootPath: string;
  workerId: string;
}) {
  const worker = (await getWorkers()).find(
    ({ workerId }) => workerId === input.workerId,
  );
  await ensureRepositoryWorkerEncryption({
    refresh: refreshWorkerEncryption,
    worker,
  });
  const operationId = crypto.randomUUID();
  const context = {
    projectId: input.id,
    worktreeId: input.workerId,
    operationId,
  };
  const protectedRequest = await protectRepositoryOperationContent({
    context: { ...context, direction: "request" },
    content: {
      type: "workspace.root.attach" as const,
      arguments: { rootPath: input.rootPath },
    },
    schema: repositoryOperationRequestContentSchema,
  });
  const result = encryptedAttachedProjectWorkspaceCreateResultSchema.parse(
    await post("/api/workspaces/attached", {
      id: input.id,
      nameProtection: input.nameProtection,
      storage: { kind: "attached", workerId: input.workerId },
      operationId,
      protectedRequest,
    }),
  );
  const outcome = await openRepositoryOperationContent({
    context: { ...context, direction: "response" },
    opaque: result.operation.protectedResponse,
    schema: repositoryOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new CantripApiError(outcome.error, 422);
  const attachment = workspaceRootAttachmentSchema.parse(outcome.result);
  if (
    !result.workspace ||
    result.workspace.storage.kind !== "attached" ||
    result.workspace.storage.rootPathHandle !== attachment.rootPathHandle ||
    result.workspace.storage.displayHandle !== attachment.displayHandle
  ) {
    throw new CantripApiError(
      "Attached workspace binding did not match the worker response.",
      502,
    );
  }
  return result.workspace;
}

export async function updateEncryptedProjectWorkspace(
  workspaceId: string,
  input: EncryptedProjectWorkspaceUpdate,
) {
  return projectWorkspaceWireSummarySchema.parse(
    await request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: "PATCH",
      body: JSON.stringify(encryptedProjectWorkspaceUpdateSchema.parse(input)),
    }),
  );
}

export async function deleteProjectWorkspace(workspaceId: string) {
  await request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "DELETE",
  });
}

export async function getWorkspaceRepositoryDiscovery(workspaceId: string) {
  return workspaceRepositoryDiscoverySnapshotSchema.parse(
    await request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repository-discovery`,
    ),
  );
}

export async function startWorkspaceRepositoryDiscovery(
  workspaceId: string,
  input: Partial<WorkspaceRepositoryDiscoveryStart> = {},
) {
  return workspaceRepositoryDiscoverySnapshotSchema.parse(
    await post(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repository-discovery`,
      workspaceRepositoryDiscoveryStartSchema.parse(input),
    ),
  );
}

export async function startWorkspaceRepositoryImports(
  workspaceId: string,
  input: WorkspaceRepositoryImportStart,
) {
  return workspaceRepositoryDiscoverySnapshotSchema.parse(
    await post(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repository-imports`,
      workspaceRepositoryImportStartSchema.parse(input),
    ),
  );
}

type RepositoryResultSchema<T> = { parse(value: unknown): T };

interface RepositoryOperationTarget {
  worker: WorkerSummary | undefined;
  worktree: ProjectWorktreeSummary;
}

const repositoryOperationTargetCache =
  new ShortLivedRequestCache<RepositoryOperationTarget>(2_000);
const repositoryWorkerReadinessCache =
  new ShortLivedRequestCache<WorkerEncryptionStatus>(5_000);
const runWorkerReadinessCache =
  new ShortLivedRequestCache<WorkerEncryptionStatus>(5_000);
const customizationWorkerReadinessCache =
  new ShortLivedRequestCache<WorkerEncryptionStatus>(5_000);
const tunnelWorkerReadinessCache = new TunnelWorkerReadinessRequestCache(5_000);
const chatCustomizationTargetCache =
  new ShortLivedRequestCache<CustomizationContentScope>(2_000);
const repositoryWorktreeStatusCache =
  new ShortLivedRequestCache<WorktreeStatusResult>(1_000);

function repositoryOperationCacheNamespace(): string {
  const session = getClientSession();
  return `${getActiveServerUrl()}\0${session?.user.id ?? "anonymous"}`;
}

function repositoryOperationTargetKey(input: {
  projectId: string;
  worktreeId?: string;
}): string {
  return `${repositoryOperationCacheNamespace()}\0${input.projectId}\0${input.worktreeId ?? "default"}`;
}

async function resolveRepositoryOperationTarget(input: {
  projectId: string;
  worktreeId?: string;
}): Promise<RepositoryOperationTarget> {
  const [worktrees, workers] = await Promise.all([
    getProjectWorktreeWireList(input.projectId),
    getWorkers(),
  ]);
  const worktree = input.worktreeId
    ? worktrees.find(({ id }) => id === input.worktreeId)
    : (worktrees.find(({ isPrimary }) => isPrimary) ??
      worktrees.find(({ isDefault }) => isDefault));
  if (!worktree || worktree.lifecycleState !== "ready") {
    throw new CantripApiError("Project worktree is unavailable.", 409);
  }
  return {
    worktree,
    worker: workers.find(({ workerId }) => workerId === worktree.workerId),
  };
}

async function ensureRepositoryOperationWorker(
  worker: WorkerSummary | undefined,
): Promise<WorkerEncryptionStatus> {
  const snapshot = clientEncryption.getSnapshot();
  const repositoryGrants = worker?.encryption.grants
    .filter(({ component }) => component === "repository-content")
    .map(({ keyRevision }) => keyRevision)
    .join(",");
  const key = `${repositoryOperationCacheNamespace()}\0${worker?.workerId ?? "missing"}\0${worker?.encryption.principalId ?? "none"}\0${worker?.encryption.state ?? "missing"}\0${repositoryGrants ?? "none"}\0${snapshot.masterKeyRevision ?? "locked"}`;
  return repositoryWorkerReadinessCache.get(key, () =>
    ensureRepositoryWorkerEncryption({
      refresh: refreshWorkerEncryption,
      worker,
    }),
  );
}

export async function ensureRunOperationWorker(input: {
  projectId: string;
  worktreeId?: string;
}) {
  const target = await repositoryOperationTargetCache.get(
    repositoryOperationTargetKey(input),
    () => resolveRepositoryOperationTarget(input),
  );
  const snapshot = clientEncryption.getSnapshot();
  const grants = target.worker?.encryption.grants
    .filter(({ component }) => component === "run-content")
    .map(({ keyRevision }) => keyRevision)
    .join(",");
  const key = `${repositoryOperationCacheNamespace()}\0${target.worker?.workerId ?? "missing"}\0${grants ?? "none"}\0${snapshot.masterKeyRevision ?? "locked"}`;
  await runWorkerReadinessCache.get(key, () =>
    ensureEndpointContentWorkerEncryption({
      domains: ["run-content"],
      worker: target.worker,
    }),
  );
  return target;
}

async function ensureCustomizationWorker(workerId: string) {
  const worker = (await getWorkers()).find(
    (candidate) => candidate.workerId === workerId,
  );
  const snapshot = clientEncryption.getSnapshot();
  const grants = worker?.encryption.grants
    .filter(({ component }) => component === "customization-content")
    .map(({ keyRevision }) => keyRevision)
    .join(",");
  const key = `${repositoryOperationCacheNamespace()}\0${workerId}\0${grants ?? "none"}\0${snapshot.masterKeyRevision ?? "locked"}`;
  await customizationWorkerReadinessCache.get(key, () =>
    ensureEndpointContentWorkerEncryption({
      domains: ["customization-content"],
      worker,
    }),
  );
}

async function ensureTunnelWorker(workerId: string) {
  const worker = (await getWorkers()).find(
    (candidate) => candidate.workerId === workerId,
  );
  const session = getClientSession();
  const snapshot = clientEncryption.getSnapshot();
  await tunnelWorkerReadinessCache.get(
    {
      activeServerUrl: getActiveServerUrl(),
      session,
      snapshot,
      workerEncryption: worker?.encryption,
      workerId,
    },
    () =>
      ensureEndpointContentWorkerEncryption({
        domains: ["tunnel-content"],
        worker,
      }),
  );
}

async function chatCustomizationTarget(chatId: string) {
  const scope = await chatCustomizationTargetCache.get(chatId, async () =>
    customizationContentScopeSchema.parse(
      await request(
        `/api/chats/${encodeURIComponent(chatId)}/customizations/target`,
      ),
    ),
  );
  if (scope.chatId !== chatId) {
    throw new Error("Customization target belongs to another chat.");
  }
  await ensureCustomizationWorker(scope.workerId);
  return scope;
}

async function runProtectedRepositoryOperation<T>(input: {
  agent?: boolean;
  arguments: Record<string, unknown>;
  modelId?: string;
  projectId: string;
  resultSchema: RepositoryResultSchema<T>;
  target?: RepositoryOperationTarget;
  type: RepositoryOperationType;
  worktreeId?: string;
}): Promise<T> {
  const targetKey = repositoryOperationTargetKey(input);
  if (input.target) repositoryOperationTargetCache.set(targetKey, input.target);
  const { worker, worktree } = input.target
    ? input.target
    : await repositoryOperationTargetCache.get(targetKey, () =>
        resolveRepositoryOperationTarget(input),
      );
  await ensureRepositoryOperationWorker(worker);
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectRepositoryOperationContent({
    context: {
      projectId: input.projectId,
      worktreeId: worktree.id,
      operationId,
      direction: "request",
    },
    content: {
      type: input.type,
      arguments: input.arguments,
    },
    schema: repositoryOperationRequestContentSchema,
  });
  let wire: ReturnType<typeof repositoryOperationWireResponseSchema.parse>;
  try {
    wire = repositoryOperationWireResponseSchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(input.projectId)}/worktrees/${encodeURIComponent(worktree.id)}/repository-operation`,
        {
          method: "POST",
          body: JSON.stringify({
            operationId,
            protectedRequest,
            access: repositoryOperationAccess(input.type),
            agent: input.agent ?? false,
            ...(input.modelId ? { modelId: input.modelId } : {}),
          }),
        },
      ),
    );
  } catch (error) {
    if (error instanceof CantripApiError && [404, 409].includes(error.status)) {
      repositoryOperationTargetCache.delete(targetKey);
    }
    throw error;
  }
  const outcome = await openRepositoryOperationContent({
    context: {
      projectId: input.projectId,
      worktreeId: worktree.id,
      operationId,
      direction: "response",
    },
    opaque: wire.protectedResponse,
    schema: repositoryOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new CantripApiError(outcome.error, 422);
  return input.resultSchema.parse(outcome.result);
}

function getProtectedWorktreeStatus(input: {
  projectId: string;
  target?: RepositoryOperationTarget;
  worktreeId: string;
}): Promise<WorktreeStatusResult> {
  const key = `${repositoryOperationCacheNamespace()}\0${input.projectId}\0${input.worktreeId}`;
  return repositoryWorktreeStatusCache.get(key, () =>
    runProtectedRepositoryOperation({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      target: input.target,
      type: "worktree.status",
      arguments: {},
      resultSchema: worktreeStatusResultSchema,
    }),
  );
}

async function runProtectedWorkerRepositoryOperation<T>(input: {
  arguments: Record<string, unknown>;
  resultSchema: RepositoryResultSchema<T>;
  scopeId: string;
  type: RepositoryOperationType;
  workerId: string;
}): Promise<T> {
  const worker = (await getWorkers()).find(
    ({ workerId }) => workerId === input.workerId,
  );
  await ensureRepositoryWorkerEncryption({
    refresh: refreshWorkerEncryption,
    worker,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectRepositoryOperationContent({
    context: {
      projectId: input.scopeId,
      worktreeId: input.workerId,
      operationId,
      direction: "request",
    },
    content: { type: input.type, arguments: input.arguments },
    schema: repositoryOperationRequestContentSchema,
  });
  const wire = repositoryOperationWireResponseSchema.parse(
    await post(
      `/api/workers/${encodeURIComponent(input.workerId)}/repository-operation`,
      {
        scopeId: input.scopeId,
        operationId,
        protectedRequest,
        access: repositoryOperationAccess(input.type),
      },
    ),
  );
  const outcome = await openRepositoryOperationContent({
    context: {
      projectId: input.scopeId,
      worktreeId: input.workerId,
      operationId,
      direction: "response",
    },
    opaque: wire.protectedResponse,
    schema: repositoryOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new CantripApiError(outcome.error, 422);
  return input.resultSchema.parse(outcome.result);
}

export async function registerWorkerRepositoryMetadata(input: {
  scopeId: string;
  values: RepositoryMetadataValues;
  workerId: string;
}) {
  return runProtectedWorkerRepositoryOperation({
    workerId: input.workerId,
    scopeId: input.scopeId,
    type: "repository.metadata.register",
    arguments: { values: repositoryMetadataValuesSchema.parse(input.values) },
    resultSchema: repositoryMetadataResultSchema,
  });
}

export async function resolveWorkerRepositoryMetadata(input: {
  scopeId: string;
  values: RepositoryMetadataValues;
  workerId: string;
}) {
  return runProtectedWorkerRepositoryOperation({
    workerId: input.workerId,
    scopeId: input.scopeId,
    type: "repository.metadata.resolve",
    arguments: { values: repositoryMetadataValuesSchema.parse(input.values) },
    resultSchema: repositoryMetadataResultSchema,
  });
}

function repositoryIdentityBlindIndex(repositoryId: string): string {
  const session = getClientSession();
  const snapshot = clientEncryption.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new Error("Encryption must be unlocked for this account.");
  }
  const componentKey = clientEncryption.componentKey({
    component: "repository-content",
    identity: snapshot.identity,
    keyRevision: snapshot.masterKeyRevision,
  });
  const lookupKey = deriveLookupKey({
    componentKey,
    ownerId: session.user.id,
    component: "repository-content",
    table: "projects",
    field: "github_repository_identity",
    keyRevision: snapshot.masterKeyRevision,
  });
  try {
    return computeBlindLookupTag(lookupKey, repositoryId);
  } finally {
    clearSensitiveBytes(lookupKey);
    clearSensitiveBytes(componentKey);
  }
}

export async function protectWorkerRepositoryIdentity(input: {
  projectId: string;
  repository: ProjectGithubConversionRepository;
  workerId: string;
}): Promise<{
  repository: ProjectGithubRoutingRepository;
  repositoryBlindIndex: string;
}> {
  const result = await registerWorkerRepositoryMetadata({
    workerId: input.workerId,
    scopeId: input.projectId,
    values: input.repository,
  });
  return {
    repository: projectGithubRoutingRepositorySchema.parse(result.values),
    repositoryBlindIndex: repositoryIdentityBlindIndex(
      input.repository.repositoryId,
    ),
  };
}

async function getProjectWorktreeWireList(projectId: string) {
  return projectWorktreeListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees`),
  );
}

export async function getProjectWorktrees(
  projectId: string,
  options: {
    onStatus?: (worktreeId: string, status: WorktreeStatusResult) => void;
  } = {},
) {
  const worktrees = await getProjectWorktreeWireList(projectId);
  const workers = await getWorkers();
  return Promise.all(
    worktrees.map(async (worktree) => {
      if (worktree.lifecycleState !== "ready") {
        return {
          ...worktree,
          name: worktree.isPrimary ? "Primary" : "Protected worktree",
          path: "Protected path unavailable",
          displayPath: "Protected path unavailable",
          branch: null,
          lockReason: null,
        };
      }
      try {
        const status = await getProtectedWorktreeStatus({
          projectId,
          worktreeId: worktree.id,
          target: {
            worktree,
            worker: workers.find(
              ({ workerId }) => workerId === worktree.workerId,
            ),
          },
        });
        options.onStatus?.(worktree.id, status);
        const privateState = status.worktree;
        const pathSegments = privateState.path.split(/[\\/]/u).filter(Boolean);
        return projectWorktreeSummarySchema.parse({
          ...worktree,
          name: worktree.isPrimary
            ? "Primary"
            : (pathSegments.at(-1) ?? "Worktree"),
          path: privateState.path,
          displayPath: privateState.path,
          branch: privateState.branch,
          head: privateState.head,
          detached: privateState.detached,
          locked: privateState.locked,
          lockReason: privateState.lockReason,
        });
      } catch {
        return projectWorktreeSummarySchema.parse({
          ...worktree,
          name: worktree.isPrimary ? "Primary" : "Protected worktree",
          path: "Protected path unavailable",
          displayPath: "Protected path unavailable",
          branch: null,
          lockReason: null,
        });
      }
    }),
  );
}

export async function getProjectWorktreeStatus(
  projectId: string,
  worktreeId: string,
) {
  return getProtectedWorktreeStatus({
    projectId,
    worktreeId,
  });
}

export async function getProjectWorktreeFileDiff(
  projectId: string,
  worktreeId: string,
  path: string,
  scope: GitDiffScope,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.diff",
    arguments: { path, scope },
    resultSchema: gitFileDiffSchema,
  });
}

export async function createProjectWorktree(
  projectId: string,
  input: ProjectWorktreeCreate,
) {
  const parsed = projectWorktreeCreateSchema.parse(input);
  const worktrees = await getProjectWorktreeWireList(projectId);
  const workerId =
    worktrees.find(({ isPrimary }) => isPrimary)?.workerId ??
    worktrees.find(({ isDefault }) => isDefault)?.workerId;
  if (!workerId)
    throw new CantripApiError("Project worker is unavailable.", 409);
  const protectedValues = await registerWorkerRepositoryMetadata({
    workerId,
    scopeId: projectId,
    values: {
      name: parsed.name,
      ...(parsed.mode.type === "detached"
        ? { revision: parsed.mode.revision }
        : {
            branch: parsed.mode.branch,
            ...(parsed.mode.type === "newBranch" && parsed.mode.startPoint
              ? { startPoint: parsed.mode.startPoint }
              : {}),
          }),
    },
  });
  const protectedInput = projectWorktreeCreateSchema.parse({
    name: protectedValues.values.name,
    mode:
      parsed.mode.type === "detached"
        ? {
            type: "detached",
            revision: protectedValues.values.revision,
          }
        : parsed.mode.type === "existingBranch"
          ? {
              type: "existingBranch",
              branch: protectedValues.values.branch,
            }
          : {
              type: "newBranch",
              branch: protectedValues.values.branch,
              startPoint: parsed.mode.startPoint
                ? protectedValues.values.startPoint
                : null,
            },
  });
  const wire = projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
      protectedInput,
    ),
  );
  return (
    (await getProjectWorktrees(projectId)).find(({ id }) => id === wire.id) ??
    projectWorktreeSummarySchema.parse({
      ...wire,
      name: "Protected worktree",
      path: "Protected path unavailable",
      displayPath: "Protected path unavailable",
      branch: null,
      lockReason: null,
    })
  );
}

export async function reconcileProjectWorktrees(projectId: string) {
  await post(
    `/api/projects/${encodeURIComponent(projectId)}/worktrees/reconcile`,
    {},
  );
  return getProjectWorktrees(projectId);
}

export async function getProjectWorktreeHistory(
  projectId: string,
  worktreeId: string,
  cursor = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.history",
    arguments: { cursor, limit: 100, revisions: [] },
    resultSchema: gitHistorySchema,
  });
}

export async function getProjectWorktreeGraphSnapshot(
  projectId: string,
  worktreeId: string,
  input: Partial<GitGraphRequest> = {},
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.graph.snapshot",
    arguments: gitGraphRequestSchema.parse(input),
    resultSchema: gitGraphSnapshotSchema,
  });
}

export async function getProjectWorktreeGraphMetrics(
  projectId: string,
  worktreeId: string,
  input: Partial<GitGraphRequest> = {},
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.graph.metrics",
    arguments: gitGraphRequestSchema.parse(input),
    resultSchema: gitGraphMetricsSchema,
  });
}

export async function getProjectWorktreeGraphCommitOverlay(
  projectId: string,
  worktreeId: string,
  input: GitGraphCommitOverlayRequest,
) {
  const parsed = gitGraphCommitOverlayRequestSchema.parse(input);
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.graph.commit-overlay",
    arguments: parsed,
    resultSchema: gitGraphCommitOverlaySchema,
  });
}

export async function getProjectWorktreeFileHistory(
  projectId: string,
  worktreeId: string,
  path: string,
  revision = "HEAD",
  cursor = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.file.history",
    arguments: { path, revision, cursor, limit: 100 },
    resultSchema: gitFileHistorySchema,
  });
}

export async function getProjectWorktreeFileBlame(
  projectId: string,
  worktreeId: string,
  path: string,
  revision = "HEAD",
  cursor = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.file.blame",
    arguments: { path, revision, cursor, limit: 200 },
    resultSchema: gitBlameSchema,
  });
}

export async function searchProjectWorktreeCommits(
  projectId: string,
  worktreeId: string,
  query: GitCommitSearchQuery,
  cursor = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.search",
    arguments: { query, cursor, limit: 100 },
    resultSchema: gitCommitSearchResultSchema,
  });
}

export async function getProjectWorktreeRecoveryCandidates(
  projectId: string,
  worktreeId: string,
  kind: "reflog" | "dangling",
  cursor = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.recovery.list",
    arguments: { kind, cursor, limit: 100 },
    resultSchema: gitRecoveryCandidateListSchema,
  });
}

export async function previewProjectWorktreeRecovery(
  projectId: string,
  worktreeId: string,
  action: GitRecoveryAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.recovery.preview",
    arguments: { action },
    resultSchema: gitRecoveryPreviewSchema,
  });
}

export async function applyProjectWorktreeRecovery(
  projectId: string,
  worktreeId: string,
  recovery: GitRecoveryApply,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.recovery.apply",
    arguments: { request: recovery },
    resultSchema: gitRecoveryResultSchema,
  });
}

export async function getProjectWorktreeCommit(
  projectId: string,
  worktreeId: string,
  revision: string,
  parentIndex = 0,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.get",
    arguments: { revision, parentIndex, revisions: [] },
    resultSchema: gitCommitDetailSchema,
  });
}

export async function getProjectWorktreeCommitSignature(
  projectId: string,
  worktreeId: string,
  revision: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.signature.get",
    arguments: { revision },
    resultSchema: gitSignatureSchema,
  });
}

export async function getProjectWorktreeRevisionCandidates(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.refs.list",
    arguments: {},
    resultSchema: gitRevisionCandidateListSchema,
  });
}

export async function getProjectWorktreeComparison(
  projectId: string,
  worktreeId: string,
  left: string,
  right: string,
  mode: "direct" | "merge-base",
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.compare",
    arguments: { left, right, mode },
    resultSchema: gitComparisonSchema,
  });
}

export async function getProjectWorktreeRevisionDiff(
  projectId: string,
  worktreeId: string,
  revision: string,
  baseRevision: string | null,
  path: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.revision.diff",
    arguments: { revision, baseRevision, path },
    resultSchema: gitRevisionFileDiffSchema,
  });
}

export async function runProjectWorktreeGitAction(
  projectId: string,
  worktreeId: string,
  action: GitAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.action",
    arguments: { action },
    resultSchema: gitActionResultSchema,
  });
}

export async function generateProjectWorktreeGitDraft(
  projectId: string,
  worktreeId: string,
  input: GitAgentDraftCreate,
) {
  const request = gitAgentDraftCreateSchema.parse(input);
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.agent.generate",
    arguments: request,
    agent: true,
    modelId: request.modelId,
    resultSchema: gitAgentDraftResultSchema,
  });
}

export async function previewProjectWorktreeGitForcePush(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.force-push.preview",
    arguments: {},
    resultSchema: gitForcePushPreviewSchema,
  });
}

export async function applyProjectWorktreeGitForcePush(
  projectId: string,
  worktreeId: string,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.force-push.apply",
    arguments: { token },
    resultSchema: gitActionResultSchema,
  });
}

export async function getProjectWorktreeBranches(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.branch.list",
    arguments: {},
    resultSchema: gitBranchListSchema,
  });
}

export async function previewProjectWorktreeBranchAction(
  projectId: string,
  worktreeId: string,
  action: GitBranchAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.branch.action.preview",
    arguments: { action },
    resultSchema: gitBranchActionPreviewSchema,
  });
}

export async function applyProjectWorktreeBranchAction(
  projectId: string,
  worktreeId: string,
  action: GitBranchAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.branch.action.apply",
    arguments: { action, token },
    resultSchema: gitBranchMutationResultSchema,
  });
}

export async function previewProjectWorktreeCommitAction(
  projectId: string,
  worktreeId: string,
  action: GitCommitAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.action.preview",
    arguments: { action },
    resultSchema: gitCommitActionPreviewSchema,
  });
}

export async function applyProjectWorktreeCommitAction(
  projectId: string,
  worktreeId: string,
  action: GitCommitAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.commit.action.apply",
    arguments: { action, token },
    resultSchema: gitCommitActionResultSchema,
  });
}

export async function getProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.current",
    arguments: {},
    resultSchema: gitManagedOperationResponseSchema,
  });
}

export async function previewProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  action: GitManagedOperationAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.preview",
    arguments: { action },
    resultSchema: gitManagedOperationPreviewSchema,
  });
}

export async function startProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  action: GitManagedOperationAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.start",
    arguments: { action, token },
    resultSchema: gitManagedOperationResponseSchema,
  });
}

export async function controlProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  operationId: string,
  action: "continue" | "skip" | "abort" | "good" | "bad" | "reset",
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.control",
    arguments: { operationId, action },
    resultSchema: gitManagedOperationResponseSchema,
  });
}

export async function amendProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  operationId: string,
  message: string | null,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.operation.amend",
    arguments: { operationId, message },
    resultSchema: gitManagedOperationResponseSchema,
  });
}

export async function getProjectWorktreeGitConflicts(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.conflicts.list",
    arguments: {},
    resultSchema: gitConflictListSchema,
  });
}

export async function getProjectWorktreeGitConflict(
  projectId: string,
  worktreeId: string,
  path: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.conflicts.get",
    arguments: { path },
    resultSchema: gitConflictDetailSchema,
  });
}

export async function previewProjectWorktreeGitConflictResolution(
  projectId: string,
  worktreeId: string,
  resolution: GitConflictResolutionRequest,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.conflicts.preview",
    arguments: { request: resolution },
    resultSchema: gitConflictResolutionPreviewSchema,
  });
}

export async function applyProjectWorktreeGitConflictResolution(
  projectId: string,
  worktreeId: string,
  resolution: GitConflictResolutionRequest,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.conflicts.apply",
    arguments: { request: resolution, token },
    resultSchema: gitConflictResolutionResultSchema,
  });
}

export async function getProjectWorktreeRemotes(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.remote.list",
    arguments: {},
    resultSchema: gitRemoteListSchema,
  });
}

export async function previewProjectWorktreeRemoteAction(
  projectId: string,
  worktreeId: string,
  action: GitRemoteAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.remote.action.preview",
    arguments: { action },
    resultSchema: gitRemoteActionPreviewSchema,
  });
}

export async function applyProjectWorktreeRemoteAction(
  projectId: string,
  worktreeId: string,
  action: GitRemoteAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.remote.action.apply",
    arguments: { action, token },
    resultSchema: gitRemoteMutationResultSchema,
  });
}

export async function getProjectWorktreeSubmodules(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.submodule.list",
    arguments: {},
    resultSchema: gitSubmoduleListSchema,
  });
}

export async function previewProjectWorktreeSubmoduleAction(
  projectId: string,
  worktreeId: string,
  action: GitSubmoduleAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.submodule.action.preview",
    arguments: { action },
    resultSchema: gitSubmoduleActionPreviewSchema,
  });
}

export async function applyProjectWorktreeSubmoduleAction(
  projectId: string,
  worktreeId: string,
  action: GitSubmoduleAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.submodule.action.apply",
    arguments: { action, token },
    resultSchema: gitSubmoduleMutationResultSchema,
  });
}

export async function getProjectWorktreeGitLfs(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.lfs.status",
    arguments: { refreshLocks: true },
    resultSchema: gitLfsStatusSchema,
  });
}

export async function previewProjectWorktreeGitLfsAction(
  projectId: string,
  worktreeId: string,
  action: GitLfsAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.lfs.action.preview",
    arguments: { action },
    resultSchema: gitLfsActionPreviewSchema,
  });
}

export async function applyProjectWorktreeGitLfsAction(
  projectId: string,
  worktreeId: string,
  action: GitLfsAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.lfs.action.apply",
    arguments: { action, token },
    resultSchema: gitLfsMutationResultSchema,
  });
}

export async function getProjectWorktreeTags(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.tag.list",
    arguments: {},
    resultSchema: gitTagListSchema,
  });
}

export async function getProjectWorktreeTag(
  projectId: string,
  worktreeId: string,
  name: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.tag.get",
    arguments: { name },
    resultSchema: gitTagDetailSchema,
  });
}

export async function previewProjectWorktreeTagAction(
  projectId: string,
  worktreeId: string,
  action: GitTagAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.tag.action.preview",
    arguments: { action },
    resultSchema: gitTagActionPreviewSchema,
  });
}

export async function applyProjectWorktreeTagAction(
  projectId: string,
  worktreeId: string,
  action: GitTagAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.tag.action.apply",
    arguments: { action, token },
    resultSchema: gitTagMutationResultSchema,
  });
}

export async function getProjectWorktreeGithubReleases(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.releases.list",
    arguments: {},
    resultSchema: githubReleaseListSchema,
  });
}

export async function getProjectWorktreeGithubRelease(
  projectId: string,
  worktreeId: string,
  releaseId: number,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.release.get",
    arguments: { releaseId },
    resultSchema: githubReleaseSummarySchema,
  });
}

export async function createProjectWorktreeGithubRelease(
  projectId: string,
  worktreeId: string,
  input: GithubReleaseCreate,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.release.create",
    arguments: { request: input },
    resultSchema: githubReleaseSummarySchema,
  });
}

export async function previewProjectWorktreePartialPatch(
  projectId: string,
  worktreeId: string,
  input: GitPartialPatchRequest,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.patch.preview",
    arguments: { request: input },
    resultSchema: gitPartialPatchPreviewSchema,
  });
}

export async function applyProjectWorktreePartialPatch(
  projectId: string,
  worktreeId: string,
  request: GitPartialPatchRequest,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.patch.apply",
    arguments: { request, token },
    resultSchema: gitActionResultSchema,
  });
}

export async function getProjectWorktreeStashes(
  projectId: string,
  worktreeId: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.list",
    arguments: {},
    resultSchema: gitStashListSchema,
  });
}

export async function createProjectWorktreeStash(
  projectId: string,
  worktreeId: string,
  input: GitStashCreate,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.create",
    arguments: { request: input },
    resultSchema: gitStashMutationResultSchema,
  });
}

export async function getProjectWorktreeStashFileDiff(
  projectId: string,
  worktreeId: string,
  hash: string,
  path: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.diff",
    arguments: { hash, path },
    resultSchema: gitStashFileDiffSchema,
  });
}

export async function previewProjectWorktreeStashAction(
  projectId: string,
  worktreeId: string,
  action: GitStashAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.action.preview",
    arguments: { action },
    resultSchema: gitStashActionPreviewSchema,
  });
}

export async function applyProjectWorktreeStashAction(
  projectId: string,
  worktreeId: string,
  action: GitStashAction,
  token: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "git.stash.action.apply",
    arguments: { action, token },
    resultSchema: gitStashMutationResultSchema,
  });
}

export async function lockProjectWorktree(
  projectId: string,
  worktreeId: string,
  reason: string | null,
) {
  const worktree = (await getProjectWorktreeWireList(projectId)).find(
    ({ id }) => id === worktreeId,
  );
  if (!worktree) throw new CantripApiError("Worktree not found.", 404);
  const protectedReason = reason
    ? await registerWorkerRepositoryMetadata({
        workerId: worktree.workerId,
        scopeId: projectId,
        values: { lockReason: reason },
      })
    : null;
  const wire = projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/lock`,
      { reason: protectedReason?.values.lockReason ?? null },
    ),
  );
  return (
    (await getProjectWorktrees(projectId)).find(({ id }) => id === wire.id) ??
    wire
  );
}

export async function unlockProjectWorktree(
  projectId: string,
  worktreeId: string,
) {
  const wire = projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/unlock`,
      {},
    ),
  );
  return (
    (await getProjectWorktrees(projectId)).find(({ id }) => id === wire.id) ??
    wire
  );
}

export async function pruneProjectWorktrees(
  projectId: string,
  allowExternal: boolean,
) {
  await post(`/api/projects/${encodeURIComponent(projectId)}/worktrees/prune`, {
    allowExternal,
  });
  return getProjectWorktrees(projectId);
}

export async function removeProjectWorktree(
  projectId: string,
  worktreeId: string,
  input: { allowExternal: boolean; force: boolean },
) {
  const wire = projectWorktreeSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}`,
      { method: "DELETE", body: JSON.stringify(input) },
    ),
  );
  return (
    (await getProjectWorktrees(projectId)).find(({ id }) => id === wire.id) ??
    projectWorktreeSummarySchema.parse({
      ...wire,
      name: "Protected worktree",
      path: "Protected path unavailable",
      displayPath: "Protected path unavailable",
      branch: null,
      lockReason: null,
    })
  );
}

export async function getGitHistory(projectId: string, cursor = 0) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "git.history",
    arguments: { cursor, limit: 100, revisions: [] },
    resultSchema: gitHistorySchema,
  });
}

export async function getProjectRepositoryStats(projectId: string) {
  return projectRepositoryStatsSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/repository-stats`,
    ),
  );
}

export async function getProjectTokenUsage(projectId: string) {
  return projectTokenUsageSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/token-usage`),
  );
}

export async function getProviderTelemetryAnalytics(input: {
  provider: ModelProviderSummary;
  models: readonly ModelProfileSummary[];
  providerAccountId?: string;
  modelId?: string;
  reasoningEffort?: string;
  projectId?: string;
  days?: number;
}) {
  const query = new URLSearchParams();
  query.set("providerId", input.provider.id);
  for (const [key, value] of Object.entries({
    providerAccountId: input.providerAccountId,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    projectId: input.projectId,
    days: input.days,
  })) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return openProviderTelemetryWireAnalytics(
    await request(`/api/analytics/provider-telemetry?${query.toString()}`),
    input.provider,
    input.models,
  );
}

export async function getProviderTelemetryExport(providerId: string) {
  return providerTelemetryExportSchema.parse(
    await request(
      `/api/analytics/provider-telemetry/${encodeURIComponent(providerId)}/export`,
    ),
  );
}

export async function deleteProviderTelemetryHistory(providerId: string) {
  return providerTelemetryDeleteResultSchema.parse(
    await request(
      `/api/analytics/provider-telemetry/${encodeURIComponent(providerId)}`,
      { method: "DELETE" },
    ),
  );
}

export async function createGithubPullRequest(
  projectId: string,
  worktreeId: string,
  request: GithubPullRequestCreate,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.create",
    arguments: { request },
    resultSchema: githubPullRequestCreateResultSchema,
  });
}

export async function getGithubPullRequest(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.get",
    arguments: { number: pullRequestNumber },
    resultSchema: githubPullRequestDetailSchema,
  });
}

export async function checkoutGithubPullRequest(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
) {
  const prepared = await runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.checkout.prepare",
    arguments: { number: pullRequestNumber },
    resultSchema: githubPullRequestCheckoutPreparedSchema,
  });
  const existing = (await getProjectWorktrees(projectId)).find(
    ({ branch }) => branch === prepared.branch,
  );
  if (existing) {
    return githubPullRequestCheckoutResultSchema.parse({
      pullRequest: prepared.pullRequest,
      worktree: existing,
      reused: true,
    });
  }
  const worktree = await createProjectWorktree(projectId, {
    name: prepared.name,
    mode: {
      type: "newBranch",
      branch: prepared.branch,
      startPoint: prepared.headSha,
    },
  });
  return githubPullRequestCheckoutResultSchema.parse({
    pullRequest: prepared.pullRequest,
    worktree,
    reused: false,
  });
}

export async function runGithubPullRequestReviewAction(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  action: GithubPullRequestReviewAction,
) {
  const operation =
    action.type === "comment"
      ? {
          type: "github.pull-request.comment" as const,
          arguments: { number: pullRequestNumber, body: action.body },
        }
      : action.type === "submit-review"
        ? {
            type: "github.pull-request.review.submit" as const,
            arguments: { number: pullRequestNumber, review: action.review },
          }
        : action.type === "inline-comment"
          ? {
              type: "github.pull-request.review.comment" as const,
              arguments: { number: pullRequestNumber, comment: action.comment },
            }
          : {
              type: "github.pull-request.review.reply" as const,
              arguments: {
                number: pullRequestNumber,
                commentId: action.commentId,
                body: action.body,
              },
            };
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    ...operation,
    resultSchema: githubPullRequestDetailSchema,
  });
}

export async function previewGithubPullRequestLifecycle(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  action: GithubPullRequestLifecycleAction,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.lifecycle.preview",
    arguments: { number: pullRequestNumber, action },
    resultSchema: githubPullRequestLifecyclePreviewSchema,
  });
}

export async function applyGithubPullRequestLifecycle(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  input: GithubPullRequestLifecycleApply,
) {
  return runProtectedRepositoryOperation({
    projectId,
    worktreeId,
    type: "github.pull-request.lifecycle.apply",
    arguments: { number: pullRequestNumber, request: input },
    resultSchema: githubPullRequestDetailSchema,
  });
}

export async function getGithubIssues(
  projectId: string,
  kind: GithubIssueKind,
  state: GithubIssueState,
  page = 1,
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issues.list",
    arguments: { kind, state, page, limit: 100 },
    resultSchema: githubIssueListSchema,
  });
}

export async function getGithubIssue(projectId: string, issueNumber: number) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issue.get",
    arguments: { number: issueNumber },
    resultSchema: githubIssueDetailSchema,
  });
}

export async function createGithubIssue(
  projectId: string,
  input: GithubIssueCreate,
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issue.create",
    arguments: { request: input },
    resultSchema: githubIssueDetailSchema,
  });
}

export async function commentOnGithubIssue(
  projectId: string,
  issueNumber: number,
  body: string,
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issue.comment",
    arguments: { number: issueNumber, body },
    resultSchema: githubIssueDetailSchema,
  });
}

export async function closeGithubIssue(
  projectId: string,
  issueNumber: number,
  comment: string | null,
) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "github.issue.close",
    arguments: { number: issueNumber, comment },
    resultSchema: githubIssueDetailSchema,
  });
}

export async function getGitStatus(projectId: string) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "git.status",
    arguments: {},
    resultSchema: gitStatusSchema,
  });
}

export async function runGitAction(projectId: string, action: GitAction) {
  return runProtectedRepositoryOperation({
    projectId,
    type: "git.action",
    arguments: { action },
    resultSchema: gitActionResultSchema,
  });
}

export async function removeProject(
  projectId: string,
  deleteLocalFiles: boolean,
) {
  await request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    body: JSON.stringify({ deleteLocalFiles }),
  });
}

export async function getProjectReplicas(projectId: string) {
  const replicas = projectReplicaListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/replicas`),
  );
  let worktrees: Awaited<ReturnType<typeof getProjectWorktrees>> = [];
  try {
    worktrees = await getProjectWorktrees(projectId);
  } catch {
    // Endpoint-only routing metadata remains unavailable while its worker is.
  }
  return projectReplicaListSchema.parse(
    replicas.map((replica) => {
      const worktree = replica.primaryWorktreeId
        ? worktrees.find(({ id }) => id === replica.primaryWorktreeId)
        : undefined;
      return {
        ...replica,
        path: worktree?.path ?? "Protected path unavailable",
        displayPath: worktree?.displayPath ?? "Protected path unavailable",
        branch: worktree?.branch ?? null,
      };
    }),
  );
}

export async function resolveProjectPlacement(
  projectId: string,
  input: ExecutionPlacementResolveRequest,
) {
  return executionPlacementResolutionSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/placement/resolve`,
      executionPlacementResolveRequestSchema.parse(input),
    ),
  );
}

export async function getProjectExecutionTargets(projectId: string) {
  return chatTitleEncryption.openExecutionTargetCatalog(
    executionTargetWireCatalogSchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/execution-targets`,
      ),
    ),
  );
}

export async function resolveExecutionTarget(
  projectId: string,
  input: ExecutionTargetResolveRequest,
) {
  return executionTargetResolutionSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/execution-targets/resolve`,
      executionTargetResolveRequestSchema.parse(input),
    ),
  );
}

export async function getProjectReplica(
  projectId: string,
  projectReplicaId: string,
) {
  const replica = (await getProjectReplicas(projectId)).find(
    ({ id }) => id === projectReplicaId,
  );
  if (!replica) throw new CantripApiError("Project replica not found.", 404);
  return replica;
}

async function projectRepositoryIdentity(
  projectId: string,
): Promise<ProjectGithubConversionRepository> {
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  if (!project?.github) {
    throw new CantripApiError("GitHub project not found.", 404);
  }
  if (
    !repositoryRoutingHandleSchema.safeParse(project.github.nameWithOwner)
      .success
  ) {
    return projectGithubConversionRepositorySchema.parse(project.github);
  }
  const workerId =
    project.source?.workerId ??
    project.preferredWorkerId ??
    project.replicas[0]?.workerId;
  if (!workerId)
    throw new CantripApiError("Project worker is unavailable.", 409);
  const resolved = await resolveWorkerRepositoryMetadata({
    workerId,
    scopeId: projectId,
    values: project.github,
  });
  return projectGithubConversionRepositorySchema.parse(resolved.values);
}

async function protectReplicaRepository(input: {
  projectId: string;
  repository?: ProjectGithubConversionRepository;
  workerId: string;
}) {
  const repository =
    input.repository ?? (await projectRepositoryIdentity(input.projectId));
  const protectedValues = await registerWorkerRepositoryMetadata({
    workerId: input.workerId,
    scopeId: input.projectId,
    values: { nameWithOwner: repository.nameWithOwner },
  });
  return repositoryRoutingHandleSchema.parse(
    protectedValues.values.nameWithOwner,
  );
}

async function protectReplicaPlacement(input: {
  placement: ProjectReplicaProvisionCreate["placement"];
  projectId: string;
  workerId: string;
}) {
  const placement = input.placement ?? { mode: "managed" as const };
  if (placement.mode === "managed") return placement;
  const protectedValues = await registerWorkerRepositoryMetadata({
    workerId: input.workerId,
    scopeId: input.projectId,
    values: { placementPath: placement.path },
  });
  return encryptedProjectReplicaPlacementRequestSchema.parse({
    mode: placement.mode,
    path: protectedValues.values.placementPath,
  });
}

async function openProjectReplicaJob(value: unknown) {
  const job = projectReplicaJobSummarySchema.parse(value);
  const protectedRepository = repositoryRoutingHandleSchema.safeParse(
    job.repository,
  ).success;
  if (!protectedRepository) return job;
  try {
    const resolved = await resolveWorkerRepositoryMetadata({
      workerId: job.workerId,
      scopeId: job.projectId,
      values: { nameWithOwner: job.repository },
    });
    return projectReplicaJobSummarySchema.parse({
      ...job,
      repository: resolved.values.nameWithOwner,
    });
  } catch {
    return projectReplicaJobSummarySchema.parse({
      ...job,
      repository: "Protected repository unavailable",
    });
  }
}

export async function createProjectReplica(
  projectId: string,
  input: ProjectReplicaProvisionCreate & {
    repository?: ProjectGithubConversionRepository;
  },
) {
  const { placement, repository, ...requestInput } = input;
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  if (!project) throw new CantripApiError("Project not found.", 404);
  const repositoryHandle = project.capabilities.github
    ? await protectReplicaRepository({
        projectId,
        workerId: input.workerId,
        repository,
      })
    : null;
  const protectedPlacement = await protectReplicaPlacement({
    placement,
    projectId,
    workerId: input.workerId,
  });
  return openProjectReplicaJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas`,
      encryptedProjectReplicaProvisionCreateSchema.parse({
        ...requestInput,
        placement: protectedPlacement,
        repository: repositoryHandle,
      }),
    ),
  );
}

export async function synchronizeProjectReplica(
  projectId: string,
  projectReplicaId: string,
  input: ProjectReplicaSynchronizeCreate & {
    repository?: ProjectGithubConversionRepository;
  },
) {
  const replica = (await getProjectWireList())
    .find(({ id }) => id === projectId)
    ?.replicas.find(({ id }) => id === projectReplicaId);
  if (!replica) throw new CantripApiError("Project replica not found.", 404);
  const { repository, ...requestInput } = input;
  const repositoryHandle = await protectReplicaRepository({
    projectId,
    workerId: replica.workerId,
    repository,
  });
  return openProjectReplicaJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas/${encodeURIComponent(projectReplicaId)}/synchronize`,
      encryptedProjectReplicaSynchronizeCreateSchema.parse({
        ...requestInput,
        repository: repositoryHandle,
      }),
    ),
  );
}

export async function removeProjectReplica(
  projectId: string,
  projectReplicaId: string,
  input: ProjectReplicaRemoveCreate & {
    repository?: ProjectGithubConversionRepository;
  },
) {
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  if (!project) throw new CantripApiError("Project not found.", 404);
  const replica = project.replicas.find(({ id }) => id === projectReplicaId);
  if (!replica) throw new CantripApiError("Project replica not found.", 404);
  const { repository, ...requestInput } = input;
  const repositoryHandle = project.capabilities.github
    ? await protectReplicaRepository({
        projectId,
        workerId: replica.workerId,
        repository,
      })
    : null;
  return openProjectReplicaJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas/${encodeURIComponent(projectReplicaId)}/remove`,
      encryptedProjectReplicaRemoveCreateSchema.parse({
        ...requestInput,
        repository: repositoryHandle,
      }),
    ),
  );
}

export async function repairProjectReplicaLink(
  projectId: string,
  projectReplicaId: string,
) {
  return projectReplicaLinkRepairResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas/${encodeURIComponent(projectReplicaId)}/repair-link`,
      {},
    ),
  );
}

export async function getProjectReplicaJobs(projectId: string) {
  const jobs = projectReplicaJobListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/replica-jobs`,
    ),
  );
  return Promise.all(jobs.map(openProjectReplicaJob));
}

export async function getProjectReplicaJob(jobId: string) {
  return openProjectReplicaJob(
    await request(`/api/project-replica-jobs/${encodeURIComponent(jobId)}`),
  );
}

export async function retryProjectReplicaJob(
  jobId: string,
  input: ProjectReplicaJobRetry,
) {
  return openProjectReplicaJob(
    await post(
      `/api/project-replica-jobs/${encodeURIComponent(jobId)}/retry`,
      input,
    ),
  );
}

export async function cancelProjectReplicaJob(
  jobId: string,
  input: ProjectReplicaJobCancel,
) {
  return openProjectReplicaJob(
    await post(
      `/api/project-replica-jobs/${encodeURIComponent(jobId)}/cancel`,
      input,
    ),
  );
}

export async function createEncryptedGithubProject(
  input: EncryptedGithubProjectCreate,
) {
  return projectWireSummarySchema.parse(
    await post("/api/projects/from-github", input),
  );
}

export async function createEncryptedManagedFolderProject(
  input: EncryptedManagedFolderProjectCreate,
) {
  return projectWireSummarySchema.parse(
    await post(
      "/api/projects/from-folder",
      encryptedManagedFolderProjectCreateSchema.parse(input),
    ),
  );
}

export async function getProjectFolderSetupJob(projectId: string) {
  return projectFolderSetupJobSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/folder-setup`,
    ),
  );
}

export async function retryProjectFolderSetup(
  projectId: string,
  stateRevision: number,
) {
  return projectFolderSetupJobSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/folder-setup/retry`,
      projectFolderSetupRetrySchema.parse({ stateRevision }),
    ),
  );
}

export async function preflightProjectGithubConversion(
  projectId: string,
  input: ProjectGithubConversionPreflightRequest,
) {
  const parsed = projectGithubConversionPreflightRequestSchema.parse(input);
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  const source = project?.source;
  const workerId = source?.workerId ?? project?.preferredWorkerId;
  if (!workerId)
    throw new CantripApiError("Project worker is unavailable.", 409);
  const protectedIdentity = await protectWorkerRepositoryIdentity({
    projectId,
    workerId,
    repository: parsed.repository,
  });
  const wire = projectGithubConversionPreflightResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github-conversion/preflight`,
      encryptedProjectGithubConversionPreflightRequestSchema.parse({
        repository: protectedIdentity.repository,
        repositoryBlindIndex: protectedIdentity.repositoryBlindIndex,
        ...(source
          ? { projectSourceId: source.id, workerId: source.workerId }
          : {}),
      }),
    ),
  );
  const privateValues: RepositoryMetadataValues =
    wire.status === "ready"
      ? {
          branch: wire.branch,
          originUrl: wire.originUrl,
          warnings: wire.warnings,
        }
      : { message: wire.error.message };
  const resolved = await resolveWorkerRepositoryMetadata({
    workerId,
    scopeId: projectId,
    values: privateValues,
  });
  return projectGithubConversionPreflightResultSchema.parse(
    wire.status === "ready"
      ? {
          ...wire,
          repository: parsed.repository,
          branch: resolved.values.branch,
          originUrl: resolved.values.originUrl,
          warnings: resolved.values.warnings,
        }
      : {
          ...wire,
          repository: parsed.repository,
          error: { ...wire.error, message: resolved.values.message },
        },
  );
}

export async function startProjectGithubConversion(
  projectId: string,
  input: ProjectGithubConversionStart,
) {
  const parsed = projectGithubConversionStartSchema.parse(input);
  const project = (await getProjectWireList()).find(
    ({ id }) => id === projectId,
  );
  const workerId =
    parsed.workerId ?? project?.source?.workerId ?? project?.preferredWorkerId;
  if (!workerId)
    throw new CantripApiError("Project worker is unavailable.", 409);
  const protectedIdentity = await protectWorkerRepositoryIdentity({
    projectId,
    workerId,
    repository: parsed.repository,
  });
  const protectedInitialCommit = parsed.initialCommit
    ? await registerWorkerRepositoryMetadata({
        workerId,
        scopeId: projectId,
        values: { message: parsed.initialCommit.message },
      })
    : null;
  return openProjectGithubConversionJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github-conversion`,
      encryptedProjectGithubConversionStartSchema.parse({
        repository: protectedIdentity.repository,
        repositoryBlindIndex: protectedIdentity.repositoryBlindIndex,
        ...(parsed.projectSourceId && parsed.workerId
          ? {
              projectSourceId: parsed.projectSourceId,
              workerId: parsed.workerId,
            }
          : {}),
        confirmationToken: parsed.confirmationToken,
        initialCommit: protectedInitialCommit
          ? { message: protectedInitialCommit.values.message }
          : null,
      }),
    ),
  );
}

async function openProjectGithubConversionJob(value: unknown) {
  const job = projectGithubConversionJobSummarySchema.parse(value);
  try {
    const resolved = await resolveWorkerRepositoryMetadata({
      workerId: job.workerId,
      scopeId: job.projectId,
      values: job.repository,
    });
    return projectGithubConversionJobSummarySchema.parse({
      ...job,
      repository: projectGithubConversionRepositorySchema.parse(
        resolved.values,
      ),
    });
  } catch {
    return projectGithubConversionJobSummarySchema.parse({
      ...job,
      repository: {
        repositoryId: "protected-unavailable",
        nameWithOwner: "protected/unavailable",
        url: "https://protected.invalid",
      },
    });
  }
}

export async function getProjectGithubConversion(projectId: string) {
  try {
    return openProjectGithubConversionJob(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/github-conversion`,
      ),
    );
  } catch (error) {
    if (error instanceof CantripApiError && error.status === 404) return null;
    throw error;
  }
}

export async function retryProjectGithubConversion(
  projectId: string,
  stateRevision: number,
) {
  return openProjectGithubConversionJob(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github-conversion/retry`,
      projectGithubConversionRetrySchema.parse({ stateRevision }),
    ),
  );
}

export async function updateProjectWorktreePolicyWire(
  projectId: string,
  policy: WorktreePolicy,
) {
  return projectWireSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktree-policy`,
      {
        method: "PATCH",
        body: JSON.stringify({ policy }),
      },
    ),
  );
}

export async function updateProjectPreferredWorkerWire(
  projectId: string,
  input: ProjectPreferredWorkerUpdate,
) {
  return projectWireSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/preferred-worker`,
      {
        method: "PATCH",
        body: JSON.stringify(projectPreferredWorkerUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function getChats(projectId: string) {
  return Promise.all(
    chatWireListSchema
      .parse(
        await request(`/api/projects/${encodeURIComponent(projectId)}/chats`),
      )
      .map((chat) => chatTitleEncryption.open(chat)),
  );
}

export async function getStandaloneChats() {
  return Promise.all(
    standaloneChatWireSummarySchema
      .array()
      .parse(await request("/api/chats?context=standalone"))
      .map((chat) => chatTitleEncryption.openStandalone(chat)),
  );
}

export async function getArchivedStandaloneChats() {
  return Promise.all(
    archivedStandaloneChatWireSummarySchema
      .array()
      .parse(await request("/api/chats/archived?context=standalone"))
      .map((chat) => chatTitleEncryption.openArchivedStandalone(chat)),
  );
}

export async function getExternalChatHistory(
  projectId: string,
  includeArchived = false,
) {
  const query = includeArchived ? "?includeArchived=true" : "";
  return projectExternalChatDiscoverySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/external-chat-history${query}`,
    ),
  );
}

export async function previewProjectExport(
  projectId: string,
  input: ProjectExportPreviewRequest,
) {
  return projectExportPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/exports/preview`,
      projectExportPreviewRequestSchema.parse(input),
    ),
  );
}

export async function createProjectExport(
  projectId: string,
  input: ProjectExportCreate,
) {
  return projectExportResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/exports`,
      projectExportCreateSchema.parse(input),
    ),
  );
}

export async function createChatImports(
  projectId: string,
  input: ChatImportCreate,
) {
  return chatImportJobListSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/chat-imports`,
      chatImportCreateSchema.parse(input),
    ),
  );
}

export async function getChatImports(projectId: string) {
  return chatImportJobListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/chat-imports`,
    ),
  );
}

export async function getChatImport(jobId: string) {
  return chatImportJobSummarySchema.parse(
    await request(`/api/chat-imports/${encodeURIComponent(jobId)}`),
  );
}

export async function retryChatImport(
  jobId: string,
  input: { stateRevision: number },
) {
  return chatImportJobSummarySchema.parse(
    await post(
      `/api/chat-imports/${encodeURIComponent(jobId)}/retry`,
      chatImportJobRetrySchema.parse(input),
    ),
  );
}

export async function getArchivedChats(projectId: string) {
  return Promise.all(
    archivedChatWireListSchema
      .parse(
        await request(
          `/api/projects/${encodeURIComponent(projectId)}/archived-chats`,
        ),
      )
      .map((chat) => chatTitleEncryption.openArchived(chat)),
  );
}

export async function cleanupArchivedChats() {
  return archivedChatCleanupResultSchema.parse(
    await post("/api/chats/archives/cleanup", {}),
  );
}

export async function createChatRelocation(
  chatId: string,
  input: ChatRelocationCreate,
) {
  return chatRelocationJobSummarySchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/relocations`,
      chatRelocationCreateSchema.parse(input),
    ),
  );
}

export async function getChatRelocations(chatId: string) {
  return chatRelocationJobListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/relocations`),
  );
}

export async function getChatRelocation(jobId: string) {
  return chatRelocationJobSummarySchema.parse(
    await request(`/api/chat-relocations/${encodeURIComponent(jobId)}`),
  );
}

export async function retryChatRelocation(
  jobId: string,
  input: ChatRelocationJobRetry,
) {
  return chatRelocationJobSummarySchema.parse(
    await post(
      `/api/chat-relocations/${encodeURIComponent(jobId)}/retry`,
      chatRelocationJobRetrySchema.parse(input),
    ),
  );
}

export async function cancelChatRelocation(
  jobId: string,
  input: ChatRelocationJobCancel,
) {
  return chatRelocationJobSummarySchema.parse(
    await post(
      `/api/chat-relocations/${encodeURIComponent(jobId)}/cancel`,
      chatRelocationJobCancelSchema.parse(input),
    ),
  );
}

export async function getProjectTabLayout(projectId: string) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/tab-groups`,
      ),
    ),
  );
}

export async function reorderProjectTabGroups(
  projectId: string,
  revision: number,
  groupIds: string[],
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/tab-groups/order`,
        {
          method: "PATCH",
          body: JSON.stringify(
            tabGroupOrderSchema.parse({ revision, groupIds }),
          ),
        },
      ),
    ),
  );
}

export async function updateProjectTabGroup(
  projectId: string,
  groupId: string,
  revision: number,
  title: string,
) {
  const input = tabGroupUpdateSchema.parse({ revision, title });
  const titleProtection = await chatTitleEncryption.protectTabGroup(
    groupId,
    input.title,
  );
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/tab-groups/${encodeURIComponent(groupId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            encryptedTabGroupUpdateSchema.parse({
              revision: input.revision,
              titleProtection,
            }),
          ),
        },
      ),
    ),
  );
}

export async function reorderProjectTabGroupMembers(
  projectId: string,
  groupId: string,
  revision: number,
  tabKeys: string[],
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/tab-groups/${encodeURIComponent(groupId)}/members/order`,
        {
          method: "PATCH",
          body: JSON.stringify(
            tabGroupMemberOrderSchema.parse({ revision, tabKeys }),
          ),
        },
      ),
    ),
  );
}

export async function moveProjectTabGroupMember(
  projectId: string,
  input: {
    revision: number;
    tabKey: string;
    targetGroupId: string | null;
    targetMemberPosition: number;
    targetGroupPosition?: number;
  },
) {
  return chatTitleEncryption.openTabLayout(
    projectTabLayoutWireSummarySchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/tab-groups/member`,
        {
          method: "PATCH",
          body: JSON.stringify(tabGroupMemberMoveSchema.parse(input)),
        },
      ),
    ),
  );
}

export async function createChat(
  projectId: string,
  title: string,
  worktreeId?: string,
  worktreeMode?: "agent-managed" | "pinned",
  tabGroupId?: string,
  target?: ExecutionTarget,
) {
  const id = crypto.randomUUID();
  return chatTitleEncryption.open(
    chatWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/chats`, {
        id,
        titleProtection: await chatTitleEncryption.protect(id, title),
        ...(worktreeId ? { worktreeId } : {}),
        ...(worktreeMode ? { worktreeMode } : {}),
        ...(tabGroupId ? { tabGroupId } : {}),
        ...(target ? { target } : {}),
      }),
    ),
  );
}

export async function createStandaloneChat(title = "New chat") {
  const id = crypto.randomUUID();
  return chatTitleEncryption.openStandalone(
    standaloneChatWireSummarySchema.parse(
      await post(
        "/api/chats",
        encryptedStandaloneChatCreateSchema.parse({
          id,
          titleProtection: await chatTitleEncryption.protect(id, title),
        }),
      ),
    ),
  );
}

export async function createTask(
  projectId: string,
  title: string,
  worktreeId?: string,
  worktreeMode?: "agent-managed" | "pinned",
  tabGroupId?: string,
  target?: ExecutionTarget,
) {
  const chatId = crypto.randomUUID();
  const task = await createInitialTaskOpaqueContent(chatId);
  const created = taskWireCreateResultSchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      chatId,
      planGoalEnabled: false,
      task,
      titleProtection: await chatTitleEncryption.protect(chatId, title),
      ...(worktreeId ? { worktreeId } : {}),
      ...(worktreeMode ? { worktreeMode } : {}),
      ...(tabGroupId ? { tabGroupId } : {}),
      ...(target ? { target } : {}),
    }),
  );
  return {
    chat: await chatTitleEncryption.open(created.chat),
    task: await openTaskOpaqueSummary(created.task),
  };
}

export async function getTask(chatId: string) {
  return openTaskOpaqueSummary(
    await request(`/api/tasks/${encodeURIComponent(chatId)}`),
  );
}

export async function deleteTask(chatId: string) {
  await request(`/api/tasks/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
}

export async function getTaskImplementationDashboard(chatId: string) {
  const opaque = taskImplementationOpaqueDashboardSchema.parse(
    await request(`/api/tasks/${encodeURIComponent(chatId)}/dashboard`),
  );
  return taskImplementationDashboardSchema.parse({
    ...opaque,
    task: await openTaskOpaqueSummary(opaque.task),
    goal: opaque.goal ? await openTaskGoalOpaqueSnapshot(opaque.goal) : null,
  });
}

export async function getTaskAttachments(chatId: string) {
  return openAttachmentOpaqueList(
    chatAttachmentOpaqueListSchema.parse(
      await request(`/api/tasks/${encodeURIComponent(chatId)}/attachments`),
    ),
  );
}

function assertCurrentTaskVersion(
  currentVersion: number,
  expectedVersion: number,
) {
  if (currentVersion !== expectedVersion) {
    throw new CantripApiError(
      "The Task changed before this update was saved.",
      409,
    );
  }
}

export async function updateTaskDraft(chatId: string, input: TaskDraftUpdate) {
  const current = await getTask(chatId);
  assertCurrentTaskVersion(current.rowVersion, input.rowVersion);
  const mutation = await prepareTaskDraftPersistence(current, input);
  return openTaskOpaqueSummary(
    await request(`/api/tasks/${encodeURIComponent(chatId)}/draft`, {
      method: "PATCH",
      body: JSON.stringify(mutation),
    }),
  );
}

async function queueTaskOperation(
  chatId: string,
  path: "start" | "plan" | "continue" | "begin-implementation" | "retry",
  input: TaskOperationStart,
) {
  const current = await getTask(chatId);
  assertCurrentTaskVersion(current.rowVersion, input.rowVersion);
  return openTaskOpaqueSummary(
    await post(`/api/tasks/${encodeURIComponent(chatId)}/${path}`, {
      operationId: input.operationId,
      rowVersion: input.rowVersion,
    }),
  );
}

export async function startTaskPlanning(
  chatId: string,
  input: TaskOperationStart,
) {
  return queueTaskOperation(chatId, "plan", input);
}

export async function startTaskDirectly(
  chatId: string,
  input: TaskOperationStart,
) {
  return queueTaskOperation(chatId, "start", input);
}

export async function updateTaskPlan(chatId: string, input: TaskPlanUpdate) {
  const current = await getTask(chatId);
  assertCurrentTaskVersion(current.rowVersion, input.rowVersion);
  const mutation = await prepareTaskPlanPersistence(current, input);
  return openTaskOpaqueSummary(
    await request(`/api/tasks/${encodeURIComponent(chatId)}/plan`, {
      method: "PATCH",
      body: JSON.stringify(mutation),
    }),
  );
}

export async function continueTaskPlanning(
  chatId: string,
  input: TaskContinuationStart,
) {
  return queueTaskOperation(chatId, "continue", input);
}

export async function beginTaskImplementation(
  chatId: string,
  input: TaskContinuationStart,
) {
  return queueTaskOperation(chatId, "begin-implementation", input);
}

export async function retryTaskPlanning(
  chatId: string,
  input: TaskOperationStart,
) {
  return queueTaskOperation(chatId, "retry", input);
}

export async function getTerminals(projectId: string) {
  const terminals = terminalWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/terminals`),
  );
  return Promise.all(
    terminals.map((terminal) => surfaceTitleEncryption.openTerminal(terminal)),
  );
}

export async function getTerminalScriptCommands(
  terminalId: string,
  workerId: string,
) {
  const worker = (await getWorkers()).find(
    (candidate) => candidate.workerId === workerId,
  );
  await ensureRepositoryOperationWorker(worker);
  const operationId = crypto.randomUUID();
  const wire = protectedScriptCommandListSchema.parse(
    await request(
      `/api/terminals/${encodeURIComponent(terminalId)}/script-commands?operationId=${encodeURIComponent(operationId)}`,
    ),
  );
  return openRepositoryOperationContent({
    context: {
      projectId: wire.projectId,
      worktreeId: wire.worktreeId,
      operationId,
      direction: "response",
    },
    opaque: wire.protectedCommands,
    schema: scriptCommandListSchema,
  });
}

export async function getProjectScriptCommands(
  projectId: string,
  worktreeId?: string,
) {
  const target = await resolveRepositoryOperationTarget({
    projectId,
    worktreeId,
  });
  await ensureRepositoryOperationWorker(target.worker);
  const query = new URLSearchParams();
  const operationId = crypto.randomUUID();
  query.set("operationId", operationId);
  if (worktreeId) query.set("worktreeId", worktreeId);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const wire = protectedScriptCommandListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/script-commands${suffix}`,
    ),
  );
  return openRepositoryOperationContent({
    context: {
      projectId: wire.projectId,
      worktreeId: wire.worktreeId,
      operationId,
      direction: "response",
    },
    opaque: wire.protectedCommands,
    schema: scriptCommandListSchema,
  });
}

export function terminalCreatePlacement(
  worktreeId: string | undefined,
  target: ExecutionTarget | undefined,
) {
  return target ? { target } : worktreeId ? { worktreeId } : {};
}

export async function createTerminal(
  projectId: string,
  title: string,
  worktreeId?: string,
  tabGroupId?: string,
  target?: ExecutionTarget,
  directoryPath?: string,
) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "terminal",
  );
  const stateProtection = await surfaceTitleEncryption.protectTerminalState(
    id,
    directoryPath,
    "",
  );
  // Execution targets supersede the legacy worktree placement. Keeping this
  // normalization at the API boundary prevents callers from emitting the
  // mutually exclusive pair rejected by encryptedTerminalCreateSchema.
  const placement = terminalCreatePlacement(worktreeId, target);
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/terminals`, {
        id,
        titleProtection,
        stateProtection,
        ...placement,
        ...(tabGroupId ? { tabGroupId } : {}),
      }),
    ),
  );
}

export async function updateTerminalWorktree(
  terminalId: string,
  worktreeId: string,
) {
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await request(
        `/api/terminals/${encodeURIComponent(terminalId)}/worktree`,
        {
          method: "PATCH",
          body: JSON.stringify({ worktreeId }),
        },
      ),
    ),
  );
}

export async function renameTerminal(terminalId: string, title: string) {
  const titleProtection = await surfaceTitleEncryption.protect(
    terminalId,
    title,
    "terminal",
  );
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await request(`/api/terminals/${encodeURIComponent(terminalId)}`, {
        method: "PATCH",
        body: JSON.stringify({ titleProtection }),
      }),
    ),
  );
}

export async function updateTerminalService(
  terminal: TerminalSummary,
  service: TerminalServiceConfiguration,
) {
  const configuration = terminalServiceConfigurationSchema.parse(service);
  const stateProtection = await surfaceTitleEncryption.protectTerminalState(
    terminal.id,
    terminal.directoryPath,
    configuration.command,
  );
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await request(
        `/api/terminals/${encodeURIComponent(terminal.id)}/service`,
        {
          method: "PUT",
          body: JSON.stringify({
            enabled: configuration.enabled,
            stateProtection,
          }),
        },
      ),
    ),
  );
}

export async function restartTerminalService(terminalId: string) {
  await post(
    `/api/terminals/${encodeURIComponent(terminalId)}/service/restart`,
    {},
  );
}

export async function deleteTerminal(terminalId: string) {
  await request(`/api/terminals/${encodeURIComponent(terminalId)}`, {
    method: "DELETE",
  });
}

export async function getExplorers(projectId: string) {
  const explorers = explorerWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/explorers`),
  );
  return Promise.all(
    explorers.map((explorer) => surfaceTitleEncryption.openExplorer(explorer)),
  );
}

export async function createExplorer(
  projectId: string,
  title: string,
  worktreeId?: string,
  tabGroupId?: string,
  target?: ExecutionTarget,
  options: {
    attachToTabLayout?: boolean;
    id?: string;
    initialViewState?: ExplorerViewStateUpdate;
  } = {},
) {
  const id = options.id ?? crypto.randomUUID();
  const initialViewState = options.initialViewState
    ? explorerViewStateUpdateSchema.parse(options.initialViewState)
    : null;
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "explorer",
  );
  const stateProtection = await surfaceTitleEncryption.protectExplorerState(
    id,
    initialViewState?.selectedPath ?? null,
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/explorers`, {
        id,
        titleProtection,
        stateProtection,
        ...(worktreeId ? { worktreeId } : {}),
        ...(tabGroupId ? { tabGroupId } : {}),
        ...(target ? { target } : {}),
        ...(initialViewState ? { fileMode: initialViewState.fileMode } : {}),
        attachToTabLayout: options.attachToTabLayout ?? true,
      }),
    ),
  );
}

export async function pinExplorer(
  explorerId: string,
  title: string,
  viewState: ExplorerViewStateUpdate,
  tabGroupId?: string,
) {
  const state = explorerViewStateUpdateSchema.parse(viewState);
  const titleProtection = await surfaceTitleEncryption.protect(
    explorerId,
    title,
    "explorer",
  );
  const stateProtection = await surfaceTitleEncryption.protectExplorerState(
    explorerId,
    state.selectedPath,
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await post(`/api/explorers/${encodeURIComponent(explorerId)}/pin`, {
        titleProtection,
        stateProtection,
        fileMode: state.fileMode,
        ...(tabGroupId ? { tabGroupId } : {}),
      }),
    ),
  );
}

export async function updateExplorerWorktree(
  explorerId: string,
  worktreeId: string,
) {
  const stateProtection = await surfaceTitleEncryption.protectExplorerState(
    explorerId,
    null,
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await request(
        `/api/explorers/${encodeURIComponent(explorerId)}/worktree`,
        {
          method: "PATCH",
          body: JSON.stringify({ worktreeId, stateProtection }),
        },
      ),
    ),
  );
}

export async function renameExplorer(explorerId: string, title: string) {
  const titleProtection = await surfaceTitleEncryption.protect(
    explorerId,
    title,
    "explorer",
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await request(`/api/explorers/${encodeURIComponent(explorerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ titleProtection }),
      }),
    ),
  );
}

export async function updateExplorerViewState(
  explorerId: string,
  input: ExplorerViewStateUpdate,
) {
  const parsed = explorerViewStateUpdateSchema.parse(input);
  const stateProtection = await surfaceTitleEncryption.protectExplorerState(
    explorerId,
    parsed.selectedPath,
  );
  return surfaceTitleEncryption.openExplorer(
    explorerWireSummarySchema.parse(
      await request(
        `/api/explorers/${encodeURIComponent(explorerId)}/view-state`,
        {
          method: "PATCH",
          body: JSON.stringify({
            fileMode: parsed.fileMode,
            stateProtection,
          }),
        },
      ),
    ),
  );
}

export async function deleteExplorer(explorerId: string) {
  await request(`/api/explorers/${encodeURIComponent(explorerId)}`, {
    method: "DELETE",
  });
}

export async function getBrowsers(projectId: string) {
  const browsers = browserWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/browsers`),
  );
  const opened = await Promise.all(
    browsers.map((browser) => surfaceTitleEncryption.openBrowser(browser)),
  );
  for (const browser of opened) {
    browserStateRevisions.set(browser.id, browser.stateRevision);
  }
  return opened;
}

export async function getBrowserServices(browserId: string) {
  return browserServiceListSchema.parse(
    await request(`/api/browsers/${encodeURIComponent(browserId)}/services`),
  );
}

export async function getProjectBrowserServices(projectId: string) {
  return browserServiceFleetDiscoverySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/browser-services`,
    ),
  );
}

export async function ensureBrowserTunnel(
  browserId: string,
  input: { url: string; workerId?: string },
) {
  const url = new URL(input.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Local Browser tunnels require an uncredentialed HTTP or HTTPS URL.",
    );
  }
  const hostname = url.hostname.toLowerCase();
  const host =
    hostname === "127.0.0.1" || hostname === "0.0.0.0"
      ? "127.0.0.1"
      : hostname === "localhost"
        ? "localhost"
        : hostname === "::1" || hostname === "[::1]"
          ? "::1"
          : null;
  if (!host) {
    throw new Error(
      "Local Browser tunnels may only target a loopback service on the selected worker.",
    );
  }
  const route: BrowserTunnelRequest = {
    protocol: url.protocol === "https:" ? "https" : "http",
    host,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    ...(input.workerId ? { workerId: input.workerId } : {}),
  };
  const parsed = browserTunnelRequestSchema.parse(route);
  const existing = tunnelWireListSchema
    .parse(await request("/api/tunnels"))
    .find(
      ({ managedBy }) =>
        managedBy?.kind === "browser" && managedBy.id === browserId,
    );
  const workerId = parsed.workerId ?? existing?.destination.workerId;
  if (!workerId) {
    throw new Error(
      "A destination worker is required for this Browser tunnel.",
    );
  }
  await ensureTunnelWorker(workerId);
  const tunnelId = existing?.id ?? crypto.randomUUID();
  const existingContent = existing?.protectedRecord
    ? await openTunnelContentRecord({
        tunnelId,
        record: existing.protectedRecord,
        workerId: existing.destination.workerId,
      })
    : null;
  const destination = {
    kind: "worker-tcp" as const,
    workerId,
    host: parsed.host,
    port: parsed.port,
  };
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: `Browser tunnel · ${url.host}`.slice(0, 120),
      description: "Temporary local access created by the owning Browser tab.",
      source: { kind: "desktop-loopback" },
      destination,
      dataProtection:
        existingContent?.dataProtection ?? createTunnelDataProtection(),
    },
    operationId: crypto.randomUUID(),
    revision: (existing?.protectedRecord?.revision ?? 0) + 1,
    tunnelId,
    workerId,
  });
  return openTunnelSummary(
    await post(
      `/api/browsers/${encodeURIComponent(browserId)}/tunnel`,
      browserTunnelWireRequestSchema.parse({
        tunnelId,
        protocolHint:
          parsed.protocol === "https" ? "https-websocket" : "http-websocket",
        workerId,
        resetAttachments: Boolean(
          existingContent &&
          JSON.stringify(existingContent.destination) !==
            JSON.stringify(destination),
        ),
        protectedRecord,
      }),
    ),
  );
}

export async function createBrowser(
  projectId: string,
  title: string,
  tabGroupId?: string,
  target?: ExecutionTarget,
  url?: string,
) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "browser",
  );
  const stateProtection = await surfaceTitleEncryption.protectBrowserState(
    id,
    url ?? "https://example.com/",
    1,
  );
  const browser = await surfaceTitleEncryption.openBrowser(
    browserWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/browsers`, {
        id,
        titleProtection,
        stateProtection,
        ...(tabGroupId ? { tabGroupId } : {}),
        ...(target ? { target } : {}),
      }),
    ),
  );
  browserStateRevisions.set(browser.id, browser.stateRevision);
  return browser;
}

const browserStateRevisions = new Map<string, number>();
const browserUpdateChains = new Map<string, Promise<void>>();

export function updateBrowser(
  browserId: string,
  input: { title?: string; url?: string; stateRevision?: number },
) {
  let resolveResult!: (browser: BrowserSummary) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<BrowserSummary>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const previous = browserUpdateChains.get(browserId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const titleProtection = input.title
        ? await surfaceTitleEncryption.protect(
            browserId,
            input.title,
            "browser",
          )
        : undefined;
      const expectedStateRevision =
        browserStateRevisions.get(browserId) ?? input.stateRevision;
      if (input.url && !expectedStateRevision) {
        throw new Error("Browser state revision is unavailable.");
      }
      const stateProtection = input.url
        ? await surfaceTitleEncryption.protectBrowserState(
            browserId,
            input.url,
            expectedStateRevision! + 1,
          )
        : undefined;
      const browser = await surfaceTitleEncryption.openBrowser(
        browserWireSummarySchema.parse(
          await request(`/api/browsers/${encodeURIComponent(browserId)}`, {
            method: "PATCH",
            body: JSON.stringify({
              ...(titleProtection ? { titleProtection } : {}),
              ...(stateProtection
                ? { expectedStateRevision, stateProtection }
                : {}),
            }),
          }),
        ),
      );
      browserStateRevisions.set(browser.id, browser.stateRevision);
      resolveResult(browser);
    })
    .catch(rejectResult)
    .finally(() => {
      if (browserUpdateChains.get(browserId) === next) {
        browserUpdateChains.delete(browserId);
      }
    });
  browserUpdateChains.set(browserId, next);
  return result;
}

export async function deleteBrowser(browserId: string) {
  await request(`/api/browsers/${encodeURIComponent(browserId)}`, {
    method: "DELETE",
  });
  browserStateRevisions.delete(browserId);
  browserUpdateChains.delete(browserId);
}

export async function getRemoteDesktops(projectId: string) {
  const desktops = remoteDesktopWireListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/remote-desktops`,
    ),
  );
  const opened = await Promise.all(
    desktops.map((desktop) =>
      surfaceTitleEncryption.openRemoteDesktop(desktop),
    ),
  );
  for (const desktop of opened) {
    remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
  }
  return opened;
}

export async function getRemoteDesktopFleet(projectId: string) {
  const fleet = await surfaceTitleEncryption.openRemoteDesktopFleet(
    remoteDesktopFleetWireSchema.parse(
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/remote-desktop-fleet`,
      ),
    ),
  );
  for (const worker of fleet.workers) {
    for (const desktop of worker.desktops) {
      remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
    }
  }
  return fleet;
}

export async function getRemoteDesktop(desktopId: string) {
  const desktop = await surfaceTitleEncryption.openRemoteDesktop(
    remoteDesktopWireSummarySchema.parse(
      await request(`/api/remote-desktops/${encodeURIComponent(desktopId)}`),
    ),
  );
  remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
  return desktop;
}

const remoteDesktopStateRevisions = new Map<string, number>();
const remoteDesktopUpdateChains = new Map<string, Promise<void>>();

export async function createRemoteDesktop(
  projectId: string,
  tabGroupId?: string,
  target?: ExecutionTarget,
  desktopTarget?: RemoteDesktopTarget,
) {
  const id = crypto.randomUUID();
  const initialTarget = desktopTarget ?? {
    kind: "monitor" as const,
    id: null,
    name: null,
  };
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    "Remote Desktop",
    "project-view",
  );
  const stateProtection =
    await surfaceTitleEncryption.protectRemoteDesktopState(
      id,
      initialTarget,
      1,
    );
  const desktop = await surfaceTitleEncryption.openRemoteDesktop(
    remoteDesktopWireSummarySchema.parse(
      await post(
        `/api/projects/${encodeURIComponent(projectId)}/remote-desktops`,
        {
          id,
          stateProtection,
          titleProtection,
          ...(tabGroupId ? { tabGroupId } : {}),
          ...(target ? { target } : {}),
        },
      ),
    ),
  );
  remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
  return desktop;
}

export async function updateRemoteDesktopTarget(
  desktopId: string,
  target: RemoteDesktopTarget,
) {
  let resolveResult!: (desktop: RemoteDesktopSummary) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<RemoteDesktopSummary>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const previous =
    remoteDesktopUpdateChains.get(desktopId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const expectedStateRevision = remoteDesktopStateRevisions.get(desktopId);
      if (!expectedStateRevision) {
        throw new Error("Remote Desktop state revision is unavailable.");
      }
      const stateProtection =
        await surfaceTitleEncryption.protectRemoteDesktopState(
          desktopId,
          target,
          expectedStateRevision + 1,
        );
      const desktop = await surfaceTitleEncryption.openRemoteDesktop(
        remoteDesktopWireSummarySchema.parse(
          await request(
            `/api/remote-desktops/${encodeURIComponent(desktopId)}`,
            {
              method: "PATCH",
              body: JSON.stringify({ expectedStateRevision, stateProtection }),
            },
          ),
        ),
      );
      remoteDesktopStateRevisions.set(desktop.id, desktop.stateRevision);
      resolveResult(desktop);
    })
    .catch(rejectResult)
    .finally(() => {
      if (remoteDesktopUpdateChains.get(desktopId) === next) {
        remoteDesktopUpdateChains.delete(desktopId);
      }
    });
  remoteDesktopUpdateChains.set(desktopId, next);
  return result;
}

export async function getProjectViews(projectId: string) {
  const views = projectViewWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/views`),
  );
  return Promise.all(
    views.map((view) => surfaceTitleEncryption.openProjectView(view)),
  );
}

async function getOpenedCodeTabs(projectId: string) {
  const codeTabs = codeTabWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/code-tabs`),
  );
  return Promise.all(
    codeTabs.map((codeTab) => surfaceTitleEncryption.openCodeTab(codeTab)),
  );
}

export async function getCodeTabs(projectId: string) {
  return (await getOpenedCodeTabs(projectId)).filter((codeTab) =>
    isVisibleProjectCodeTab(codeTab.title),
  );
}

export async function getInternalExplorerEditorCodeTabs(projectId: string) {
  return (await getOpenedCodeTabs(projectId)).filter(
    (codeTab) => codeTab.title === INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE,
  );
}

export async function createCodeTab(
  projectId: string,
  title = "Code",
  worktreeId?: string,
  tabGroupId?: string,
  target?: ExecutionTarget,
) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "code-tab",
  );
  return surfaceTitleEncryption.openCodeTab(
    codeTabWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/code-tabs`, {
        id,
        titleProtection,
        ...(worktreeId ? { worktreeId } : {}),
        ...(tabGroupId ? { tabGroupId } : {}),
        ...(target ? { target } : {}),
      }),
    ),
  );
}

export async function updateCodeTab(
  codeTabId: string,
  input: { title?: string; themeMode?: CodeThemeMode },
) {
  const titleProtection = input.title
    ? await surfaceTitleEncryption.protect(codeTabId, input.title, "code-tab")
    : undefined;
  return surfaceTitleEncryption.openCodeTab(
    codeTabWireSummarySchema.parse(
      await request(`/api/code-tabs/${encodeURIComponent(codeTabId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(titleProtection ? { titleProtection } : {}),
          ...(input.themeMode ? { themeMode: input.themeMode } : {}),
        }),
      }),
    ),
  );
}

export async function updateCodeTabWorktree(
  codeTabId: string,
  worktreeId: string,
) {
  return surfaceTitleEncryption.openCodeTab(
    codeTabWireSummarySchema.parse(
      await request(
        `/api/code-tabs/${encodeURIComponent(codeTabId)}/worktree`,
        {
          method: "PATCH",
          body: JSON.stringify({ worktreeId }),
        },
      ),
    ),
  );
}

export async function deleteCodeTab(codeTabId: string) {
  await request(`/api/code-tabs/${encodeURIComponent(codeTabId)}`, {
    keepalive: true,
    method: "DELETE",
  });
}

const PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS = 10_000;
const PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS = 5_000;
const BOUND_API_REQUEST_BEHAVIOR = { allowCsrfRecovery: false } as const;

export interface BoundExplorerCodeSessionAttachment {
  attachment: CodeSharedAttachmentWire;
  binding: {
    identity: ClientSessionIdentitySnapshot;
    serverUrl: string;
  };
}

function captureCodeSessionApiBinding(): BoundExplorerCodeSessionAttachment["binding"] {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) {
    throw new Error("Cantrip Code requires an authenticated client session.");
  }
  const serverUrl = getActiveServerUrl();
  if (identity.serverUrl !== serverUrl) {
    throw new Error(
      "The Cantrip Code server identity changed while it was being captured.",
    );
  }
  return { identity, serverUrl };
}

export function explorerCodeSessionBindingCurrent(
  binding: BoundExplorerCodeSessionAttachment["binding"],
): boolean {
  return (
    getActiveServerUrl() === binding.serverUrl &&
    clientSessionIdentityMatches(binding.identity)
  );
}

export function assertCreatedExplorerCodeSessionIdentity(
  attachment: CodeSharedAttachmentWire,
  expected: {
    attachmentId: string;
    serverId: string;
    sessionId: string;
    workerId: string;
  },
): void {
  if (
    attachment.session.attachmentId !== expected.attachmentId ||
    attachment.session.sessionId !== expected.sessionId ||
    attachment.transport.workerId !== expected.workerId ||
    attachment.transport.serverId !== expected.serverId
  ) {
    throw new Error(
      "The shared Cantrip Code attachment changed logical identity.",
    );
  }
}

function assertExplorerCodeSessionBindingCurrent(
  binding: BoundExplorerCodeSessionAttachment["binding"],
): void {
  if (!explorerCodeSessionBindingCurrent(binding)) {
    throw new Error(
      "The Cantrip Code server or authentication identity changed while connecting.",
    );
  }
}

async function protectedSharedCodeTransportCandidate(input: {
  transportId: string;
  workerId: string;
}) {
  await ensureTunnelWorker(input.workerId);
  return {
    formatVersion: 2 as const,
    transportId: input.transportId,
    protectedRecord: await protectTunnelContentRecord({
      content: {
        name: "Cantrip Code",
        description: "Shared protected editor transport.",
        source: { kind: "desktop-loopback" },
        destination: sharedCodeTransportDestination(input),
        dataProtection: createTunnelDataProtection(),
      },
      operationId: input.transportId,
      revision: 1,
      tunnelId: input.transportId,
      workerId: input.workerId,
    }),
  };
}

export function sharedCodeTransportDestination(input: {
  transportId: string;
  workerId: string;
}) {
  return {
    kind: "worker-code-transport" as const,
    workerId: input.workerId,
    resourceId: input.transportId,
  };
}

async function protectedCodeAttachmentInput(input: {
  appearance: CodeAppearance;
  expectedWorktreeId?: string;
  sessionId: string;
  tunnelId: string;
  workerId: string;
}) {
  await ensureTunnelWorker(input.workerId);
  const protectedRecord = await protectTunnelContentRecord({
    content: {
      name: "Cantrip Code",
      description: "Protected editor access for this Code surface.",
      source: { kind: "desktop-loopback" },
      destination: {
        kind: "worker-code",
        workerId: input.workerId,
        resourceId: input.tunnelId,
        sessionId: input.sessionId,
      },
      dataProtection: createTunnelDataProtection(),
    },
    operationId: input.tunnelId,
    revision: 1,
    tunnelId: input.tunnelId,
    workerId: input.workerId,
  });
  return {
    appearance: input.appearance,
    expectedWorkerId: input.workerId,
    ...(input.expectedWorktreeId
      ? { expectedWorktreeId: input.expectedWorktreeId }
      : {}),
    protectedRecord,
    sessionId: input.sessionId,
    tunnelId: input.tunnelId,
  };
}

export async function createProtectedCodeSettingsAttachment(
  workerId: string,
  appearance: CodeAppearance,
) {
  const tunnelId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  return createBoundedResource({
    create: async (signal) => {
      // A fresh worker can register its encryption principal before it has any
      // account component grants. Settings is a global surface, so authorize
      // customization on demand like the other settings flows do.
      await ensureCustomizationWorker(workerId);
      const input = await protectedCodeAttachmentInput({
        appearance,
        sessionId,
        tunnelId,
        workerId,
      });
      return codeSettingsWorkbenchAttachmentWireSchema.parse(
        await request("/api/settings/code/protected-code-attachments", {
          body: JSON.stringify(
            codeSettingsWorkbenchAttachmentCreateSchema.parse(input),
          ),
          method: "POST",
          signal,
        }),
      );
    },
    createTimeoutMs: PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS,
    resourceId: tunnelId,
    rollback: (attachmentId, signal) =>
      releaseCodeAttachment(attachmentId, { signal }),
    rollbackTimeoutMs: PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS,
  });
}

export async function getCodeSettingsWorkerStatus(workerId: string) {
  return codeSettingsWorkerStatusSchema.parse(
    await request(
      `/api/settings/code/workers/${encodeURIComponent(workerId)}/status`,
    ),
  );
}

export async function resolveCodeSettingsWorker(
  workerId: string,
  resolution: CodeSettingsResolution,
) {
  return codeSettingsWorkerStatusSchema.parse(
    await post(
      `/api/settings/code/workers/${encodeURIComponent(workerId)}/resolve`,
      codeSettingsResolveRequestSchema.parse({ resolution }),
    ),
  );
}

export async function synchronizeCodeSettingsWorker(workerId: string) {
  return codeSettingsWorkerStatusSchema.parse(
    await post(
      `/api/settings/code/workers/${encodeURIComponent(workerId)}/synchronize`,
      codeSettingsSynchronizeRequestSchema.parse({
        initializeIfMissing: false,
      }),
    ),
  );
}

export async function createProtectedCodeAttachment(
  codeTabId: string,
  workerId: string,
  worktreeId: string,
  appearance: CodeAppearance,
) {
  const tunnelId = crypto.randomUUID();
  return createBoundedResource({
    create: async (signal) => {
      const intent = codeProtectedAttachmentIntentSchema.parse(
        await request(
          `/api/code-tabs/${encodeURIComponent(codeTabId)}/protected-attachment-intents`,
          {
            body: JSON.stringify({
              appearance,
              expectedWorkerId: workerId,
              expectedWorktreeId: worktreeId,
            }),
            method: "POST",
            signal,
          },
        ),
      );
      const input = await protectedCodeAttachmentInput({
        appearance,
        expectedWorktreeId: worktreeId,
        sessionId: intent.sessionId,
        tunnelId,
        workerId,
      });
      const wire = codeProtectedAttachmentWireSchema.parse(
        await request(
          `/api/code-tabs/${encodeURIComponent(codeTabId)}/protected-attachments`,
          {
            body: JSON.stringify(
              codeProtectedAttachmentCreateSchema.parse(input),
            ),
            method: "POST",
            signal,
          },
        ),
      );
      if (wire.sessionId !== intent.sessionId) {
        throw new Error("Protected Code attachment changed runtime sessions.");
      }
      return wire;
    },
    createTimeoutMs: PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS,
    resourceId: tunnelId,
    rollback: (attachmentId, signal) =>
      releaseCodeAttachment(attachmentId, { signal }),
    rollbackTimeoutMs: PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS,
  });
}

export async function createProtectedExplorerCodeAttachment(
  explorerId: string,
  relativePath: string | null,
  workerId: string,
  worktreeId: string,
  appearance: CodeAppearance,
) {
  const tunnelId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  return createBoundedResource({
    create: async (signal) => {
      const input = await protectedCodeAttachmentInput({
        appearance,
        expectedWorktreeId: worktreeId,
        sessionId,
        tunnelId,
        workerId,
      });
      return codeProtectedAttachmentWireSchema.parse(
        await request(
          `/api/explorers/${encodeURIComponent(explorerId)}/protected-code-attachments`,
          {
            body: JSON.stringify(
              explorerCodeProtectedAttachmentCreateSchema.parse({
                ...input,
                ...(relativePath ? { path: relativePath } : {}),
              }),
            ),
            method: "POST",
            signal,
          },
        ),
      );
    },
    createTimeoutMs: PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS,
    resourceId: tunnelId,
    rollback: (attachmentId, signal) =>
      releaseCodeAttachment(attachmentId, { signal }),
    rollbackTimeoutMs: PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS,
  });
}

export async function createProtectedExplorerCodeSessionAttachment(
  explorerId: string,
  relativePath: string | null,
  workerId: string,
  worktreeId: string,
  appearance: CodeAppearance,
): Promise<BoundExplorerCodeSessionAttachment> {
  const binding = captureCodeSessionApiBinding();
  const attachmentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const transportId = crypto.randomUUID();
  return createBoundedResource({
    create: async (signal) => {
      assertExplorerCodeSessionBindingCurrent(binding);
      const transport = await protectedSharedCodeTransportCandidate({
        transportId,
        workerId,
      });
      assertExplorerCodeSessionBindingCurrent(binding);
      const attachment = codeSharedAttachmentWireSchema.parse(
        await request(
          `${binding.serverUrl}/api/explorers/${encodeURIComponent(explorerId)}/code-session-attachments`,
          {
            body: JSON.stringify(
              explorerCodeSessionAttachmentCreateSchema.parse({
                appearance,
                attachmentId,
                expectedWorkerId: workerId,
                expectedWorktreeId: worktreeId,
                formatVersion: 2,
                ...(relativePath ? { path: relativePath } : {}),
                sessionId,
                transport,
              }),
            ),
            method: "POST",
            signal,
          },
          BOUND_API_REQUEST_BEHAVIOR,
        ),
      );
      // The candidate transport id is intentionally not an expected response
      // identity. The server returns the already-active root when another tab
      // wins acquisition for the same security identity.
      assertCreatedExplorerCodeSessionIdentity(attachment, {
        attachmentId,
        serverId: binding.identity.serverId,
        sessionId,
        workerId,
      });
      assertExplorerCodeSessionBindingCurrent(binding);
      return { attachment, binding };
    },
    createTimeoutMs: PROTECTED_CODE_ATTACHMENT_CREATE_TIMEOUT_MS,
    resourceId: attachmentId,
    rollback: (resourceId, signal) =>
      releaseProtectedExplorerCodeSessionAttachmentId(resourceId, binding, {
        signal,
      }),
    rollbackTimeoutMs: PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS,
  });
}

async function releaseProtectedExplorerCodeSessionAttachmentId(
  attachmentId: string,
  binding: BoundExplorerCodeSessionAttachment["binding"],
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!explorerCodeSessionBindingCurrent(binding)) return;
  await request(
    `${binding.serverUrl}/api/code-session-attachments/${encodeURIComponent(attachmentId)}`,
    {
      keepalive: true,
      method: "DELETE",
      signal:
        options.signal ??
        AbortSignal.timeout(PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS),
    },
    BOUND_API_REQUEST_BEHAVIOR,
  );
}

export async function releaseProtectedExplorerCodeSessionAttachment(
  owned: BoundExplorerCodeSessionAttachment,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await releaseProtectedExplorerCodeSessionAttachmentId(
    owned.attachment.session.attachmentId,
    owned.binding,
    options,
  );
}

export function assertRenewedExplorerCodeSessionIdentity(
  previous: CodeSharedAttachmentWire,
  renewed: CodeSharedAttachmentWire,
  bindingServerId: string,
): void {
  if (
    renewed.session.attachmentId !== previous.session.attachmentId ||
    renewed.session.sessionId !== previous.session.sessionId ||
    renewed.session.routeGrant !== previous.session.routeGrant ||
    renewed.session.runtime.sessionIncarnationId !==
      previous.session.runtime.sessionIncarnationId ||
    renewed.transport.transportId !== previous.transport.transportId ||
    renewed.transport.tunnelId !== previous.transport.tunnelId ||
    renewed.transport.workerId !== previous.transport.workerId ||
    renewed.transport.securityScopeId !== previous.transport.securityScopeId ||
    renewed.transport.serverId !== previous.transport.serverId ||
    renewed.transport.serverId !== bindingServerId ||
    renewed.transport.serverControlPlaneGeneration !==
      previous.transport.serverControlPlaneGeneration ||
    renewed.transport.protectedKeyRevision !==
      previous.transport.protectedKeyRevision ||
    renewed.transport.workerProcessGeneration !==
      previous.transport.workerProcessGeneration
  ) {
    throw new Error("The shared Cantrip Code session lease changed identity.");
  }
}

export async function renewProtectedExplorerCodeSessionAttachment(
  owned: BoundExplorerCodeSessionAttachment,
  options: { signal?: AbortSignal } = {},
): Promise<BoundExplorerCodeSessionAttachment> {
  assertExplorerCodeSessionBindingCurrent(owned.binding);
  const attachment = codeSharedAttachmentWireSchema.parse(
    await request(
      `${owned.binding.serverUrl}/api/code-session-attachments/${encodeURIComponent(owned.attachment.session.attachmentId)}/lease`,
      {
        method: "POST",
        signal: options.signal,
      },
      BOUND_API_REQUEST_BEHAVIOR,
    ),
  );
  assertRenewedExplorerCodeSessionIdentity(
    owned.attachment,
    attachment,
    owned.binding.identity.serverId,
  );
  assertExplorerCodeSessionBindingCurrent(owned.binding);
  // The bound object is the local ownership key used by the native lease
  // registry. Refresh it in place so renewal cannot orphan that exact lease
  // behind a structurally equivalent replacement object.
  owned.attachment = attachment;
  return owned;
}

export async function getCodeRuntime(codeTabId: string, sessionId: string) {
  return codeRuntimeStatusSchema.parse(
    await request(
      `/api/code-tabs/${encodeURIComponent(codeTabId)}/sessions/${encodeURIComponent(sessionId)}/runtime`,
    ),
  );
}

export async function releaseCodeAttachment(
  attachmentId: string,
  options: { signal?: AbortSignal } = {},
) {
  await request(`/api/code-attachments/${encodeURIComponent(attachmentId)}`, {
    keepalive: true,
    method: "DELETE",
    signal:
      options.signal ??
      AbortSignal.timeout(PROTECTED_CODE_ATTACHMENT_ROLLBACK_TIMEOUT_MS),
  });
}

export async function saveAllCodeTab(codeTabId: string) {
  return codeSaveAllResultSchema.parse(
    await post(`/api/code-tabs/${encodeURIComponent(codeTabId)}/save-all`, {}),
  );
}

export async function stopCodeTab(codeTabId: string) {
  const result = await post(
    `/api/code-tabs/${encodeURIComponent(codeTabId)}/stop`,
    {},
  );
  return result === null ? null : codeRuntimeStatusSchema.parse(result);
}

export async function setCodeTabTheme(
  codeTabId: string,
  themeMode: CodeThemeMode,
  appearance: CodeAppearance,
) {
  return surfaceTitleEncryption.openCodeTab(
    codeTabWireSummarySchema.parse(
      await post(`/api/code-tabs/${encodeURIComponent(codeTabId)}/theme`, {
        themeMode,
        appearance,
      }),
    ),
  );
}

export async function createProjectView(
  projectId: string,
  kind: ProjectViewKind,
  title: string,
  worktreeId?: string,
  tabGroupId?: string,
) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "project-view",
  );
  return surfaceTitleEncryption.openProjectView(
    projectViewWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/views`, {
        id,
        titleProtection,
        kind,
        ...(worktreeId ? { worktreeId } : {}),
        ...(tabGroupId ? { tabGroupId } : {}),
      }),
    ),
  );
}

export async function updateProjectViewWorktree(
  viewId: string,
  worktreeId: string,
) {
  return surfaceTitleEncryption.openProjectView(
    projectViewWireSummarySchema.parse(
      await request(
        `/api/project-views/${encodeURIComponent(viewId)}/worktree`,
        {
          method: "PATCH",
          body: JSON.stringify({ worktreeId }),
        },
      ),
    ),
  );
}

export async function renameProjectView(viewId: string, title: string) {
  const titleProtection = await surfaceTitleEncryption.protect(
    viewId,
    title,
    "project-view",
  );
  return surfaceTitleEncryption.openProjectView(
    projectViewWireSummarySchema.parse(
      await request(`/api/project-views/${encodeURIComponent(viewId)}`, {
        method: "PATCH",
        body: JSON.stringify({ titleProtection }),
      }),
    ),
  );
}

export async function deleteProjectView(viewId: string) {
  await request(`/api/project-views/${encodeURIComponent(viewId)}`, {
    method: "DELETE",
  });
}

async function executeStandaloneChatFileOperation(
  chatId: string,
  intent: StandaloneChatFileOperationIntent,
  content: StandaloneChatFileOperationRequestContent,
  operationId = crypto.randomUUID(),
  sequence = 0,
): Promise<StandaloneChatFileOperationResultContent> {
  const protectedRequest = await protectSurfaceStreamContent({
    context: {
      surfaceKind: "chat-files",
      surfaceId: chatId,
      operationId,
      direction: "request",
      sequence,
    },
    content: standaloneChatFileOperationRequestContentSchema.parse(content),
    schema: standaloneChatFileOperationRequestContentSchema,
  });
  const wire = surfaceStreamWireResponseSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/files/operation`, {
      method: "POST",
      body: JSON.stringify({
        intent,
        operationId,
        sequence,
        protectedRequest,
      }),
    }),
  );
  if (wire.operationId !== operationId || wire.sequence !== sequence) {
    throw new Error("Chat files returned a stale protected operation.");
  }
  const outcome = await openSurfaceStreamContent({
    context: {
      surfaceKind: "chat-files",
      surfaceId: chatId,
      operationId,
      direction: "response",
      sequence,
    },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return standaloneChatFileOperationResultContentSchema.parse(outcome.result);
}

export async function getStandaloneChatFileDirectory(
  chatId: string,
  path: string,
) {
  const result = await executeStandaloneChatFileOperation(chatId, "list", {
    type: "chat-files.directory.list",
    path,
  });
  if (result.type !== "chat-files.directory.list") {
    throw new Error("Chat files returned an unexpected directory result.");
  }
  return explorerDirectorySchema.parse(result.value);
}

export async function getStandaloneChatFile(chatId: string, path: string) {
  const result = await executeStandaloneChatFileOperation(chatId, "read", {
    type: "chat-files.file.read",
    path,
  });
  if (result.type !== "chat-files.file") {
    throw new Error("Chat files returned an unexpected file result.");
  }
  return explorerFileSchema.parse(result.value);
}

export async function resolveStandaloneChatFilePath(
  chatId: string,
  reference: string,
) {
  const result = await executeStandaloneChatFileOperation(chatId, "read", {
    type: "chat-files.path.resolve",
    reference,
  });
  if (result.type !== "chat-files.path.resolved") {
    throw new Error("Chat files returned an unexpected path result.");
  }
  return result.path;
}

export async function loadStandaloneChatFileMedia(
  chatId: string,
  path: string,
): Promise<Blob> {
  const operationId = crypto.randomUUID();
  const parts: BlobPart[] = [];
  let offset = 0;
  let sequence = 0;
  let expected:
    | { kind: string; mimeType: string; modifiedAt: string; size: number }
    | undefined;
  for (;;) {
    const result = await executeStandaloneChatFileOperation(
      chatId,
      "read",
      {
        type: "chat-files.media.read",
        path,
        offset,
        limit: 256 * 1_024,
      },
      operationId,
      sequence,
    );
    if (result.type !== "chat-files.media") {
      throw new Error("Chat files returned an unexpected media result.");
    }
    const chunk = result.value;
    if (chunk.path !== path || chunk.offset !== offset) {
      throw new Error("Chat files returned stale protected media content.");
    }
    const metadata = {
      kind: chunk.kind,
      mimeType: chunk.mimeType,
      modifiedAt: chunk.modifiedAt,
      size: chunk.size,
    };
    if (expected && JSON.stringify(expected) !== JSON.stringify(metadata)) {
      throw new Error("Chat media changed while it was loading.");
    }
    expected ??= metadata;
    const bytes = decodeExplorerMediaBytes(chunk.data);
    if (offset + bytes.byteLength > chunk.size) {
      throw new Error("Chat files returned oversized protected media content.");
    }
    parts.push(new Uint8Array(bytes).buffer as ArrayBuffer);
    offset += bytes.byteLength;
    sequence += 1;
    if (chunk.eof) {
      if (offset !== chunk.size) {
        throw new Error(
          "Chat files returned incomplete protected media content.",
        );
      }
      return new Blob(parts, { type: chunk.mimeType });
    }
    if (bytes.byteLength === 0) {
      throw new Error("Chat media stream stopped progressing.");
    }
  }
}

export async function saveStandaloneChatFile(
  chatId: string,
  input: { path: string; content: string; version: string },
) {
  const result = await executeStandaloneChatFileOperation(chatId, "write", {
    type: "chat-files.file.write",
    ...explorerFileWriteSchema.parse(input),
  });
  if (result.type !== "chat-files.file") {
    throw new Error("Chat files returned an unexpected saved file result.");
  }
  return explorerFileSchema.parse(result.value);
}

export async function deleteStandaloneChatFileEntry(
  chatId: string,
  input: { path: string; recursive: boolean },
) {
  const result = await executeStandaloneChatFileOperation(chatId, "remove", {
    type: "chat-files.entry.delete",
    ...input,
  });
  if (result.type !== "chat-files.entry.mutated") {
    throw new Error("Chat files returned an unexpected delete result.");
  }
  return explorerEntryMutationResultSchema.parse(result.value);
}

export async function downloadStandaloneChatFiles(
  chatId: string,
  input: { kind: StandaloneChatFileDownloadKind; path: string },
): Promise<{ blob: Blob; fileName: string }> {
  const operationId = crypto.randomUUID();
  const intent = input.kind === "file" ? "download" : "archive";
  let sequence = 0;
  const preparedResult = await executeStandaloneChatFileOperation(
    chatId,
    intent,
    { type: "chat-files.download.prepare", ...input },
    operationId,
    sequence,
  );
  if (preparedResult.type !== "chat-files.download.prepared") {
    throw new Error("Chat files returned an unexpected download result.");
  }
  const prepared = preparedResult.value;
  const parts: BlobPart[] = [];
  let offset = 0;
  try {
    for (;;) {
      sequence += 1;
      const result = await executeStandaloneChatFileOperation(
        chatId,
        intent,
        {
          type: "chat-files.download.read",
          downloadId: prepared.downloadId,
          offset,
          limit: 256 * 1_024,
        },
        operationId,
        sequence,
      );
      if (result.type !== "chat-files.download.chunk") {
        throw new Error("Chat files returned an unexpected download chunk.");
      }
      const chunk = result.value;
      if (chunk.downloadId !== prepared.downloadId || chunk.offset !== offset) {
        throw new Error(
          "Chat files returned a stale protected download chunk.",
        );
      }
      const bytes = decodeExplorerMediaBytes(chunk.data);
      if (offset + bytes.byteLength > prepared.size) {
        throw new Error("Chat files returned an oversized protected download.");
      }
      parts.push(new Uint8Array(bytes).buffer as ArrayBuffer);
      offset += bytes.byteLength;
      if (chunk.eof) {
        if (offset !== prepared.size) {
          throw new Error(
            "Chat files returned an incomplete protected download.",
          );
        }
        return {
          blob: new Blob(parts, { type: prepared.mimeType }),
          fileName: prepared.fileName,
        };
      }
      if (bytes.byteLength === 0) {
        throw new Error("Chat file download stopped progressing.");
      }
    }
  } catch (error) {
    await executeStandaloneChatFileOperation(
      chatId,
      intent,
      {
        type: "chat-files.download.cancel",
        downloadId: prepared.downloadId,
      },
      operationId,
      sequence + 1,
    ).catch(() => undefined);
    throw error;
  }
}

async function executeExplorerOperation(
  explorerId: string,
  content: ExplorerOperationRequestContent,
  operationId = crypto.randomUUID(),
  sequence = 0,
): Promise<ExplorerOperationResultContent> {
  const protectedRequest = await protectSurfaceStreamContent({
    context: {
      surfaceKind: "explorer",
      surfaceId: explorerId,
      operationId,
      direction: "request",
      sequence,
    },
    content,
    schema: explorerOperationRequestContentSchema,
  });
  const wire = surfaceStreamWireResponseSchema.parse(
    await request(
      `/api/explorers/${encodeURIComponent(explorerId)}/operation`,
      {
        method: "POST",
        body: JSON.stringify({ operationId, sequence, protectedRequest }),
      },
    ),
  );
  if (wire.operationId !== operationId || wire.sequence !== sequence) {
    throw new Error("Explorer returned a stale protected operation.");
  }
  const outcome = await openSurfaceStreamContent({
    context: {
      surfaceKind: "explorer",
      surfaceId: explorerId,
      operationId,
      direction: "response",
      sequence,
    },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return explorerOperationResultContentSchema.parse(outcome.result);
}

export async function getExplorerDirectory(explorerId: string, path: string) {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.directory.list",
    path,
  });
  if (result.type !== "explorer.directory.list") {
    throw new Error("Explorer returned an unexpected directory result.");
  }
  return explorerDirectorySchema.parse(result.value);
}

export async function getExplorerDirectoryCommits(
  explorerId: string,
  path: string,
) {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.directory.commits",
    path,
  });
  if (result.type !== "explorer.directory.commits") {
    throw new Error("Explorer returned unexpected commit metadata.");
  }
  return explorerDirectoryCommitsSchema.parse(result.value);
}

export async function getExplorerFile(explorerId: string, path: string) {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.file.read",
    path,
  });
  if (result.type !== "explorer.file") {
    throw new Error("Explorer returned an unexpected file result.");
  }
  return explorerFileSchema.parse(result.value);
}

function decodeExplorerMediaBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function loadExplorerMedia(
  explorerId: string,
  path: string,
): Promise<Blob> {
  const operationId = crypto.randomUUID();
  const parts: BlobPart[] = [];
  let offset = 0;
  let sequence = 0;
  let expected:
    | { kind: string; mimeType: string; modifiedAt: string; size: number }
    | undefined;
  for (;;) {
    const result = await executeExplorerOperation(
      explorerId,
      {
        type: "explorer.media.read",
        path,
        offset,
        limit: 256 * 1_024,
      },
      operationId,
      sequence,
    );
    if (result.type !== "explorer.media") {
      throw new Error("Explorer returned an unexpected media result.");
    }
    const chunk = result.value;
    if (chunk.path !== path || chunk.offset !== offset) {
      throw new Error("Explorer returned stale protected media content.");
    }
    const metadata = {
      kind: chunk.kind,
      mimeType: chunk.mimeType,
      modifiedAt: chunk.modifiedAt,
      size: chunk.size,
    };
    if (expected && JSON.stringify(expected) !== JSON.stringify(metadata)) {
      throw new Error("Explorer media changed while it was loading.");
    }
    expected ??= metadata;
    const bytes = decodeExplorerMediaBytes(chunk.data);
    if (offset + bytes.byteLength > chunk.size) {
      throw new Error("Explorer returned oversized protected media content.");
    }
    parts.push(new Uint8Array(bytes).buffer as ArrayBuffer);
    offset += bytes.byteLength;
    sequence += 1;
    if (chunk.eof) {
      if (offset !== chunk.size) {
        throw new Error(
          "Explorer returned incomplete protected media content.",
        );
      }
      return new Blob(parts, { type: chunk.mimeType });
    }
    if (bytes.byteLength === 0) {
      throw new Error("Explorer protected media stream stopped progressing.");
    }
  }
}

export async function saveExplorerFile(
  explorerId: string,
  input: ExplorerFileWrite,
) {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.file.write",
    ...explorerFileWriteSchema.parse(input),
  });
  if (result.type !== "explorer.file") {
    throw new Error("Explorer returned an unexpected saved file result.");
  }
  return explorerFileSchema.parse(result.value);
}

export async function createExplorerDirectory(
  explorerId: string,
  input: ExplorerDirectoryCreate,
): Promise<ExplorerEntry> {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.directory.create",
    ...explorerDirectoryCreateSchema.parse(input),
  });
  if (result.type !== "explorer.directory.created") {
    throw new Error("Explorer returned an unexpected created folder result.");
  }
  return explorerEntrySchema.parse(result.value);
}

export async function renameExplorerEntry(
  explorerId: string,
  input: ExplorerEntryRename,
): Promise<ExplorerEntryMutationResult> {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.entry.rename",
    ...explorerEntryRenameSchema.parse(input),
  });
  if (result.type !== "explorer.entry.mutated") {
    throw new Error("Explorer returned an unexpected rename result.");
  }
  return explorerEntryMutationResultSchema.parse(result.value);
}

export async function deleteExplorerEntry(
  explorerId: string,
  input: ExplorerEntryDelete,
): Promise<ExplorerEntryMutationResult> {
  const result = await executeExplorerOperation(explorerId, {
    type: "explorer.entry.delete",
    ...explorerEntryDeleteSchema.parse(input),
  });
  if (result.type !== "explorer.entry.mutated") {
    throw new Error("Explorer returned an unexpected delete result.");
  }
  return explorerEntryMutationResultSchema.parse(result.value);
}

async function openContextualChat(raw: unknown) {
  const chat = contextualChatWireSummarySchema.parse(raw);
  return chat.contextKind === "standalone"
    ? chatTitleEncryption.openStandalone(chat)
    : chatTitleEncryption.open(chat);
}

export async function renameChat(chatId: string, title: string) {
  return openContextualChat(
    await request(`/api/chats/${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        titleProtection: await chatTitleEncryption.protect(chatId, title),
      }),
    }),
  );
}

export async function acknowledgeChatCompletion(chatId: string) {
  return openContextualChat(
    await post(`/api/chats/${encodeURIComponent(chatId)}/completion/read`, {}),
  );
}

export async function updateChatWorktree(
  chatId: string,
  input: ChatWorktreeUpdate,
) {
  return chatTitleEncryption.open(
    chatWireSummarySchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/worktree`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    ),
  );
}

export async function deleteChat(chatId: string) {
  await request(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
}

export async function restoreArchivedChat(chatId: string) {
  return openContextualChat(
    await post(`/api/chats/${encodeURIComponent(chatId)}/restore`, {}),
  );
}

export async function permanentlyDeleteArchivedChat(chatId: string) {
  await request(`/api/chats/${encodeURIComponent(chatId)}/permanent`, {
    method: "DELETE",
  });
}

export async function forkChat(
  chatId: string,
  sourceTitle: string,
  messageId?: string,
) {
  const id = crypto.randomUUID();
  return openContextualChat(
    await post(`/api/chats/${encodeURIComponent(chatId)}/fork`, {
      id,
      titleProtection: await chatTitleEncryption.protect(
        id,
        `${sourceTitle} (fork)`,
      ),
      ...(messageId ? { messageId } : {}),
    }),
  );
}

export async function compactChat(chatId: string) {
  return chatCompactAcceptedSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/compact`, {}),
  );
}

async function openChatGoalWireResponse(raw: unknown) {
  const response = chatGoalWireResponseSchema.parse(raw);
  return chatGoalResponseSchema.parse({
    goal:
      "kind" in response && response.kind === "task-encrypted" && response.goal
        ? await openTaskGoalOpaqueSnapshot(response.goal)
        : response.goal,
  });
}

export async function getChatGoal(chatId: string) {
  return openChatGoalWireResponse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal`),
  );
}

export async function createChatGoal(chatId: string, input: ChatGoalCreate) {
  return openChatGoalWireResponse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/goal`,
      chatGoalCreateSchema.parse(input),
    ),
  );
}

export async function updateChatGoal(chatId: string, input: ChatGoalUpdate) {
  return openChatGoalWireResponse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal`, {
      method: "PATCH",
      body: JSON.stringify(chatGoalUpdateSchema.parse(input)),
    }),
  );
}

export async function clearChatGoal(chatId: string) {
  return chatGoalClearSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal`, {
      method: "DELETE",
    }),
  );
}

export async function getChatPlan(chatId: string) {
  return openEncryptedChatPlanWireState(
    chatId,
    encryptedChatPlanWireStateSchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/plan`),
    ),
  );
}

export async function updateChatPlan(chatId: string, input: ChatPlanUpdate) {
  return openEncryptedChatPlanWireState(
    chatId,
    encryptedChatPlanWireStateSchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/plan`, {
        method: "PATCH",
        body: JSON.stringify(chatPlanUpdateSchema.parse(input)),
      }),
    ),
  );
}

export async function answerChatPlan(chatId: string, input: ChatPlanAnswer) {
  const answer = chatPlanAnswerSchema.parse(input);
  const plan = await getChatPlan(chatId);
  if (!plan.question) {
    throw new Error("This chat has no pending Plan Mode question.");
  }
  const expectedIds = new Set(
    plan.question.questions.map((question) => question.id),
  );
  const answerIds = Object.keys(answer.answers);
  if (
    answerIds.length !== expectedIds.size ||
    answerIds.some((id) => !expectedIds.has(id))
  ) {
    throw new Error("Answer every pending Plan Mode question once.");
  }

  const requests = await getAgentInteractionRequests({
    chatId,
    status: "pending",
  });
  const pending = requests.find(
    (request) =>
      request.requestKey === plan.question?.id &&
      request.payload.kind === "userInput",
  );
  if (!pending) {
    throw new Error("The pending Plan Mode question is no longer available.");
  }
  await respondToAgentInteractionRequest(pending.id, {
    idempotencyKey: crypto.randomUUID(),
    response: {
      kind: "userInput",
      answers: Object.fromEntries(
        Object.entries(answer.answers).map(([id, answers]) => [
          id,
          { answers },
        ]),
      ),
    },
  });
  return chatPlanAcceptedSchema.parse({
    accepted: true,
    requestKey: pending.requestKey,
  });
}

export async function syncChat(chatId: string) {
  return agentThreadSyncSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/sync`, {}),
  );
}

export async function createChatConsole(chatId: string) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    "Console",
    "terminal",
  );
  const stateProtection = await surfaceTitleEncryption.protectTerminalState(
    id,
    null,
    "",
  );
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await post(`/api/chats/${encodeURIComponent(chatId)}/console`, {
        id,
        titleProtection,
        stateProtection,
      }),
    ),
  );
}

export async function interruptChat(chatId: string) {
  return chatInterruptAcceptedSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/interrupt`, {}),
  );
}

export async function setChatPaused(chatId: string, paused: boolean) {
  return chatPauseStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/pause`, {
      method: "PATCH",
      body: JSON.stringify(chatPauseUpdateSchema.parse({ paused })),
    }),
  );
}

export async function getChatPermissionProfiles(chatId: string) {
  return chatPermissionProfileStateSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/permission-profiles`,
    ),
  );
}

export async function updateChatPermissionProfile(
  chatId: string,
  id: string | null,
) {
  return chatPermissionProfileStateSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/permission-profile`,
      {
        method: "PATCH",
        body: JSON.stringify(chatPermissionProfileUpdateSchema.parse({ id })),
      },
    ),
  );
}

export async function getAgentInteractionRequests(
  input: {
    chatId?: string;
    workflowRunId?: string;
    status?: AgentInteractionRequestStatus;
    limit?: number;
  } = {},
) {
  const query = new URLSearchParams();
  if (input.chatId) query.set("chatId", input.chatId);
  if (input.workflowRunId) query.set("workflowRunId", input.workflowRunId);
  if (input.status) query.set("status", input.status);
  if (input.limit) query.set("limit", String(input.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const requests = agentInteractionRequestWireListSchema.parse(
    await request(`/api/agent-requests${suffix}`),
  );
  return Promise.all(
    requests.map((request) =>
      "protectedPayload" in request
        ? openEncryptedAgentInteractionRequest(request)
        : request,
    ),
  );
}

export async function respondToAgentInteractionRequest(
  requestId: string,
  input: AgentInteractionResolutionCreate,
) {
  const path = `/api/agent-requests/${encodeURIComponent(requestId)}`;
  const current = agentInteractionRequestWireSchema.parse(await request(path));
  const response = agentInteractionRequestWireSchema.parse(
    await post(
      `${path}/respond`,
      "protectedPayload" in current
        ? await createEncryptedAgentInteractionResponse(current, input)
        : agentInteractionResolutionCreateSchema.parse(input),
    ),
  );
  return "protectedPayload" in response
    ? openEncryptedAgentInteractionRequest(response)
    : response;
}

export async function reorderProjects(ids: string[]) {
  await request("/api/projects/order", {
    method: "PATCH",
    body: JSON.stringify(orderedIdsSchema.parse({ ids })),
  });
}

export async function getMessages(chatId: string) {
  const response = chatMessageWireListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/messages`),
  );
  return chatMessageListSchema.parse(
    await Promise.all(
      response.messages.map((message) =>
        response.kind === "task-encrypted"
          ? openTaskMessageOpaqueSummary(message)
          : openChatMessageOpaqueSummary(message),
      ),
    ),
  );
}

export async function getMessagePage(
  chatId: string,
  options: {
    beforeSequence?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ChatMessagePage> {
  const response = chatMessageWirePageSchema.parse(
    await request(
      withQuery(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        beforeSequence: options.beforeSequence,
        limit: options.limit ?? CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
      }),
      { signal: options.signal },
    ),
  );
  const messages =
    response.kind === "task-encrypted"
      ? await mapWithConcurrency(
          response.messages,
          CHAT_MESSAGE_DECRYPT_CONCURRENCY,
          (message) => openTaskMessageOpaqueSummary(message),
        )
      : await mapWithConcurrency(
          response.messages,
          CHAT_MESSAGE_DECRYPT_CONCURRENCY,
          (message) => openChatMessageOpaqueSummary(message),
        );
  return {
    messages: chatMessageListSchema.parse(messages),
    page: response.page,
  };
}

async function readProtectedChatCustomization<T>(input: {
  chatId: string;
  operation: CustomizationContentOperation;
  path: string;
  query?: Record<string, string | boolean | undefined>;
  schema: { parse(value: unknown): T };
}) {
  const scope = await chatCustomizationTarget(input.chatId);
  const operationId = crypto.randomUUID();
  return openCustomizationResponse({
    raw: await request(withQuery(input.path, { ...input.query, operationId })),
    operationId,
    operation: input.operation,
    expectedScope: scope,
    schema: input.schema,
  });
}

async function mutateProtectedChatCustomization<Request, Response>(input: {
  chatId: string;
  operation: CustomizationContentOperation;
  path: string;
  method: "DELETE" | "PATCH" | "POST" | "PUT";
  request: Request;
  requestSchema: { parse(value: unknown): Request };
  responseSchema: { parse(value: unknown): Response };
}) {
  const scope = await chatCustomizationTarget(input.chatId);
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: input.operation,
    content: input.request,
    schema: input.requestSchema,
  });
  return openCustomizationResponse({
    raw: await request(input.path, {
      method: input.method,
      body: JSON.stringify(protectedRequest),
    }),
    operationId,
    operation: input.operation,
    expectedScope: scope,
    schema: input.responseSchema,
  });
}

export async function getSkills(chatId: string) {
  return readProtectedChatCustomization({
    chatId,
    operation: "skills.list",
    path: `/api/chats/${encodeURIComponent(chatId)}/skills`,
    schema: skillListSchema,
  });
}

export async function getSettingsSkills(input: SkillSettingsContext) {
  const parsed = skillSettingsContextSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const [inventory, audiences] = await Promise.all([
    openCustomizationResponse({
      raw: await request(
        withQuery("/api/skills", {
          operationId,
          workerId: parsed.workerId,
          providerId: parsed.providerId,
          projectId: parsed.projectId ?? undefined,
        }),
      ),
      operationId,
      operation: "skills.settings.list",
      expectedScope: scope,
      schema: skillSettingsInventorySchema,
    }),
    request(
      withQuery("/api/skill-audiences", {
        workerId: parsed.workerId,
        providerId: parsed.providerId,
      }),
    ).then((value) => skillAudienceListSchema.parse(value)),
  ]);
  const byKey = new Map(
    audiences.map(({ audienceKey, audience }) => [audienceKey, audience]),
  );
  return {
    ...inventory,
    project: inventory.project.map((skill) => ({
      ...skill,
      audience: byKey.get(skill.audienceKey) ?? "ide",
    })),
    global: inventory.global.map((skill) => ({
      ...skill,
      audience: byKey.get(skill.audienceKey) ?? "ide",
    })),
  };
}

export async function updateSettingsSkillAudience(input: SkillAudienceUpdate) {
  return skillAudienceSummarySchema.parse(
    await request("/api/skill-audiences", {
      method: "PATCH",
      body: JSON.stringify(skillAudienceUpdateSchema.parse(input)),
    }),
  );
}

export async function readSettingsSkill(input: SkillSettingsFileRequest) {
  const parsed = skillSettingsFileRequestSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: "skills.settings.read",
    content: { skillId: parsed.skillId, file: parsed.file },
    schema: skillSettingsFileRequestSchema.pick({ skillId: true, file: true }),
  });
  return openCustomizationResponse({
    raw: await post("/api/skills/read", protectedRequest),
    operationId,
    operation: "skills.settings.read",
    expectedScope: scope,
    schema: skillSettingsDocumentSchema,
  });
}

export async function updateSettingsSkillFile(input: SkillSettingsFileUpdate) {
  const parsed = skillSettingsFileUpdateSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: "skills.settings.write",
    content: {
      skillId: parsed.skillId,
      file: parsed.file,
      content: parsed.content,
    },
    schema: skillSettingsFileUpdateSchema.pick({
      skillId: true,
      file: true,
      content: true,
    }),
  });
  return openCustomizationResponse({
    raw: await request("/api/skills/file", {
      method: "PUT",
      body: JSON.stringify(protectedRequest),
    }),
    operationId,
    operation: "skills.settings.write",
    expectedScope: scope,
    schema: skillSettingsMutationResultSchema,
  });
}

export async function deleteSettingsSkill(input: SkillSettingsDeleteRequest) {
  const parsed = skillSettingsDeleteRequestSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: "skills.settings.delete",
    content: { skillId: parsed.skillId },
    schema: skillSettingsDeleteRequestSchema.pick({ skillId: true }),
  });
  return openCustomizationResponse({
    raw: await request("/api/skills", {
      method: "DELETE",
      body: JSON.stringify(protectedRequest),
    }),
    operationId,
    operation: "skills.settings.delete",
    expectedScope: scope,
    schema: skillSettingsMutationResultSchema,
  });
}

export async function configureSettingsSkill(input: SkillSettingsConfigUpdate) {
  const parsed = skillSettingsConfigUpdateSchema.parse(input);
  await ensureCustomizationWorker(parsed.workerId);
  const scope = customizationContentScopeSchema.parse({
    workerId: parsed.workerId,
    projectId: parsed.projectId,
    chatId: null,
    providerId: parsed.providerId,
  });
  const operationId = crypto.randomUUID();
  const protectedRequest = await protectCustomizationRequest({
    scope,
    operationId,
    operation: "skills.settings.configure",
    content: { skillId: parsed.skillId, enabled: parsed.enabled },
    schema: skillSettingsConfigUpdateSchema.pick({
      skillId: true,
      enabled: true,
    }),
  });
  return openCustomizationResponse({
    raw: await request("/api/skills/configuration", {
      method: "PATCH",
      body: JSON.stringify(protectedRequest),
    }),
    operationId,
    operation: "skills.settings.configure",
    expectedScope: scope,
    schema: skillSettingsConfigResultSchema,
  });
}

export async function getChatCustomizations(chatId: string, refresh = false) {
  return readProtectedChatCustomization({
    chatId,
    operation: "customization.inventory.read",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations`,
    query: { refresh: refresh || undefined },
    schema: codexCustomizationInventorySchema,
  });
}

export async function getChatExternalImportPreview(chatId: string) {
  return readProtectedChatCustomization({
    chatId,
    operation: "customization.external.preview",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/external-preview`,
    schema: codexExternalImportPreviewSchema,
  });
}

export async function readChatMcpResource(
  chatId: string,
  input: CodexMcpResourceReadRequest,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.mcp.resource.read",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-resource`,
    method: "POST",
    request: codexMcpResourceReadRequestSchema.parse(input),
    requestSchema: codexMcpResourceReadRequestSchema,
    responseSchema: codexMcpResourceReadSchema,
  });
}

export async function configureChatSkill(
  chatId: string,
  input: CodexSkillConfigUpdate,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.skill.configure",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/skill`,
    method: "PATCH",
    request: codexSkillConfigUpdateSchema.parse(input),
    requestSchema: codexSkillConfigUpdateSchema,
    responseSchema: codexSkillConfigResultSchema,
  });
}

export async function setChatSkillRoots(
  chatId: string,
  input: CodexSkillRootsUpdate,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.skill-roots.set",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/skill-roots`,
    method: "PUT",
    request: codexSkillRootsUpdateSchema.parse(input),
    requestSchema: codexSkillRootsUpdateSchema,
    responseSchema: codexSkillRootsResultSchema,
  });
}

export async function startChatMcpOauth(
  chatId: string,
  input: CodexMcpOauthStart,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.mcp.oauth.start",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-oauth`,
    method: "POST",
    request: codexMcpOauthStartSchema.parse(input),
    requestSchema: codexMcpOauthStartSchema,
    responseSchema: codexMcpOauthStartResultSchema,
  });
}

export async function getChatMcpOauthStatus(chatId: string, server: string) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.mcp.oauth.status",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-oauth/status`,
    method: "POST",
    request: codexMcpOauthStartSchema.parse({ server }),
    requestSchema: codexMcpOauthStartSchema,
    responseSchema: codexMcpOauthStatusSchema,
  });
}

export async function reloadChatMcpServers(chatId: string) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.mcp.reload",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-reload`,
    method: "POST",
    request: codexMcpReloadRequestSchema.parse({}),
    requestSchema: codexMcpReloadRequestSchema,
    responseSchema: codexMcpReloadResultSchema,
  });
}

export async function applyChatExternalImport(
  chatId: string,
  input: CodexExternalImportApply,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.external.apply",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/external-import`,
    method: "POST",
    request: codexExternalImportApplySchema.parse(input),
    requestSchema: codexExternalImportApplySchema,
    responseSchema: codexExternalImportStatusSchema,
  });
}

export async function getChatExternalImportStatus(
  chatId: string,
  importId: string,
) {
  return mutateProtectedChatCustomization({
    chatId,
    operation: "customization.external.status",
    path: `/api/chats/${encodeURIComponent(chatId)}/customizations/external-import/status`,
    method: "POST",
    request: codexExternalImportStatusSchema.pick({ importId: true }).parse({
      importId,
    }),
    requestSchema: codexExternalImportStatusSchema.pick({ importId: true }),
    responseSchema: codexExternalImportStatusSchema,
  });
}

export async function updateChatModel(chatId: string, modelId: string) {
  return chatTitleEncryption.open(
    chatWireSummarySchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/model`, {
        method: "PATCH",
        body: JSON.stringify({ modelId }),
      }),
    ),
  );
}

export async function updateChatModelConfiguration(
  chatId: string,
  configuration: ModelConfiguration,
) {
  return openContextualChat(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/model-configuration`,
      {
        method: "PATCH",
        body: JSON.stringify(
          chatModelConfigurationUpdateSchema.parse(configuration),
        ),
      },
    ),
  );
}

export async function getChatReasoning(chatId: string, modelId?: string) {
  return chatReasoningStateSchema.parse(
    await request(
      withQuery(`/api/chats/${encodeURIComponent(chatId)}/reasoning`, {
        modelId,
      }),
    ),
  );
}

export async function getChatRuntimeSelection(chatId: string) {
  return chatRuntimeSelectionSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/runtime-selection`),
  );
}

export async function updateChatReasoning(
  chatId: string,
  reasoningEffort: ReasoningEffort | null,
) {
  return chatReasoningStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/reasoning`, {
      method: "PATCH",
      body: JSON.stringify(
        chatReasoningUpdateSchema.parse({ reasoningEffort }),
      ),
    }),
  );
}

export async function startTurn(
  chatId: string,
  text: string,
  configuration: ModelConfiguration,
  attachments: ChatAttachmentSummary[] = [],
  mode: ChatTurnMode = "default",
) {
  if (!configuration.modelId) throw new Error("Choose a model first.");
  await getPolicies();
  const idempotencyKey = crypto.randomUUID();
  const input = await createEncryptedChatTurn({
    attachments,
    idempotencyKey,
    messageId: crypto.randomUUID(),
    mode,
    modelId: configuration.modelId,
    promptId: crypto.randomUUID(),
    reasoningEffort: configuration.reasoningEffort,
    customSubagentModel: configuration.customSubagentModel,
    subagentModelId: configuration.subagentModelId,
    subagentReasoningEffort: configuration.subagentReasoningEffort,
    text,
  });
  const result = encryptedChatPromptSubmitResultSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/turns`,
      encryptedChatTurnCreateSchema.parse(input),
    ),
  );
  return result.status === "started"
    ? {
        status: "started" as const,
        message: await openChatMessageOpaqueSummary(result.message),
      }
    : {
        status: "queued" as const,
        prompt: await openQueuedPromptOpaqueSummary(result.prompt),
      };
}

export async function retryChatTurn(
  chatId: string,
  messageId: string,
  text: string,
  configuration: ModelConfiguration,
  attachments: ChatAttachmentSummary[] = [],
  mode: ChatTurnMode = "default",
) {
  if (!configuration.modelId) throw new Error("Choose a model first.");
  await getPolicies();
  const idempotencyKey = crypto.randomUUID();
  const input = await createEncryptedChatTurn({
    attachments,
    idempotencyKey,
    messageId: crypto.randomUUID(),
    mode,
    modelId: configuration.modelId,
    promptId: crypto.randomUUID(),
    reasoningEffort: configuration.reasoningEffort,
    customSubagentModel: configuration.customSubagentModel,
    subagentModelId: configuration.subagentModelId,
    subagentReasoningEffort: configuration.subagentReasoningEffort,
    text,
  });
  const result = encryptedChatPromptSubmitResultSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(messageId)}/retry`,
      encryptedChatTurnCreateSchema.parse(input),
    ),
  );
  if (result.status !== "started") {
    throw new Error("An edited message cannot be queued.");
  }
  return {
    status: "started" as const,
    message: await openChatMessageOpaqueSummary(result.message),
  };
}

export async function getChatComposerDraft(chatId: string) {
  return openChatComposerDraft(
    chatId,
    encryptedChatComposerDraftWireStateSchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}/composer-draft`),
    ),
  );
}

export async function saveChatComposerDraft(
  chatId: string,
  draft: ChatComposerDraft | null,
) {
  const state = draft ? await protectChatComposerDraft(chatId, draft) : null;
  const wire = encryptedChatComposerDraftWireStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/composer-draft`, {
      method: "PUT",
      body: JSON.stringify(
        encryptedChatComposerDraftUpdateSchema.parse({ state }),
      ),
    }),
  );
  return openChatComposerDraft(chatId, wire);
}

export async function getQueuedPrompts(chatId: string) {
  const prompts = encryptedQueuedPromptListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/queue`),
  );
  return queuedPromptListSchema.parse(
    await Promise.all(
      prompts.map((prompt) => openQueuedPromptOpaqueSummary(prompt)),
    ),
  );
}

export async function updateQueuedPrompt(
  chatId: string,
  promptId: string,
  input: {
    attachments?: ChatAttachmentSummary[];
    text?: string;
    mode?: ChatTurnMode;
    reasoningEffort?: ReasoningEffort | null;
    frozen?: boolean;
  },
) {
  const current = encryptedQueuedPromptListSchema
    .parse(await request(`/api/chats/${encodeURIComponent(chatId)}/queue`))
    .find((prompt) => prompt.id === promptId);
  if (!current) throw new Error("Queued prompt not found.");
  const opened = await openQueuedPromptOpaqueSummary(current);
  const replacement = await replaceEncryptedQueuedPrompt(current, {
    attachments: input.attachments ?? opened.attachments,
    text: input.text ?? opened.text,
    mode: input.mode ?? opened.mode,
    reasoningEffort:
      input.reasoningEffort !== undefined
        ? input.reasoningEffort
        : opened.reasoningEffort,
    frozen: input.frozen ?? opened.frozen,
  });
  return openQueuedPromptOpaqueSummary(
    encryptedQueuedPromptSchema.parse(
      await request(`/api/queued-prompts/${encodeURIComponent(promptId)}`, {
        method: "PATCH",
        body: JSON.stringify({ prompt: replacement }),
      }),
    ),
  );
}

export async function uploadChatAttachment(
  chatId: string,
  file: File,
  kind: ChatAttachmentKind,
  source: ChatAttachmentSource,
) {
  const attachmentId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const previewText =
      kind === "text"
        ? new TextDecoder("utf-8", { fatal: false })
            .decode(bytes.subarray(0, 16_000))
            .slice(0, 8_000)
        : null;
    const upload = await protectAttachmentUpload({
      attachmentId,
      operationId,
      chatId,
      bytes,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      kind,
      source,
      previewText,
    });
    const response = await requestResponse(
      `/api/chats/${encodeURIComponent(chatId)}/attachments`,
      {
        method: "POST",
        body: JSON.stringify(attachmentUploadOpaqueSchema.parse(upload)),
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/octet-stream",
        },
      },
    );
    return openAttachmentOpaqueSummary(
      chatAttachmentOpaqueSummarySchema.parse(await response.json()),
    );
  } finally {
    bytes.fill(0);
  }
}

export async function deleteChatAttachment(attachmentId: string) {
  await request(`/api/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}

export function chatAttachmentContentUrl(attachmentId: string): string {
  return `${getActiveServerUrl()}/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}

export async function loadChatAttachmentContent(
  attachment: ChatAttachmentSummary,
): Promise<Blob> {
  const operationId = crypto.randomUUID();
  const download = attachmentDownloadOpaqueSchema.parse(
    await request(
      `/api/attachments/${encodeURIComponent(attachment.id)}/content?operationId=${encodeURIComponent(operationId)}`,
    ),
  );
  const bytes = await openAttachmentDownload(attachment, download);
  try {
    return new Blob([bytes.slice().buffer as ArrayBuffer], {
      type: attachment.mimeType,
    });
  } finally {
    bytes.fill(0);
  }
}

export async function deleteQueuedPrompt(promptId: string) {
  await request(`/api/queued-prompts/${encodeURIComponent(promptId)}`, {
    method: "DELETE",
  });
}

export async function reorderQueuedPrompts(chatId: string, ids: string[]) {
  await request(`/api/chats/${encodeURIComponent(chatId)}/queue/order`, {
    method: "PATCH",
    body: JSON.stringify({ ids }),
  });
}

export async function steerQueuedPrompt(promptId: string) {
  const result = encryptedChatPromptSteerResultSchema.parse(
    await post(`/api/queued-prompts/${encodeURIComponent(promptId)}/steer`, {}),
  );
  return chatPromptSteerResultSchema.parse({
    steered: true,
    message: await openChatMessageOpaqueSummary(result.message),
  });
}
