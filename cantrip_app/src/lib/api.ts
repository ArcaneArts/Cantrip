import {
  accountAdminSummarySchema,
  accountLicenseWhitelistCreateSchema,
  accountLicenseWhitelistEntrySchema,
  accountRegistrationSchema,
  accountSessionListSchema,
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
  browserWireListSchema,
  browserServiceFleetDiscoverySchema,
  browserServiceListSchema,
  browserWireSummarySchema,
  browserTunnelRequestSchema,
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
  chatMessageSchema,
  chatMessageWireListSchema,
  chatWireSummarySchema,
  chatCompactAcceptedSchema,
  chatImportCreateSchema,
  chatImportJobListSchema,
  chatImportJobRetrySchema,
  chatImportJobSummarySchema,
  chatInterruptAcceptedSchema,
  chatPlanAcceptedSchema,
  chatPlanAnswerSchema,
  encryptedChatPlanWireStateSchema,
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
  encryptedQueuedPromptListSchema,
  encryptedQueuedPromptSchema,
  chatReasoningStateSchema,
  chatReasoningUpdateSchema,
  codeAttachmentSchema,
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
  codexMcpReloadResultSchema,
  codexMcpResourceReadRequestSchema,
  codexMcpResourceReadSchema,
  codexSkillConfigResultSchema,
  codexSkillConfigUpdateSchema,
  codexSkillRootsResultSchema,
  codexSkillRootsUpdateSchema,
  explorerDirectoryCommitsSchema,
  explorerDirectorySchema,
  explorerFileSchema,
  explorerFileWriteSchema,
  explorerWireListSchema,
  explorerWireSummarySchema,
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
  modelProviderSummarySchema,
  encryptedManagedFolderProjectCreateSchema,
  mcpServerCopySchema,
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
  policyTemplateDetailSchema,
  policyTemplateListSchema,
  policyTemplateResetSchema,
  policyUpdateSchema,
  POLICY_BOOTSTRAP_VERSION,
  projectWireListSchema,
  projectExternalChatDiscoverySchema,
  projectFolderSetupJobSummarySchema,
  projectFolderSetupRetrySchema,
  projectGithubConversionJobSummarySchema,
  projectGithubConversionPreflightRequestSchema,
  projectGithubConversionPreflightResultSchema,
  projectGithubConversionRetrySchema,
  projectGithubConversionStartSchema,
  projectPreferredWorkerUpdateSchema,
  projectReplicaJobListSchema,
  projectReplicaJobSummarySchema,
  projectReplicaListSchema,
  projectReplicaSummarySchema,
  projectRepositoryStatsSchema,
  projectTokenUsageSchema,
  providerTelemetryAnalyticsSchema,
  providerTelemetryDeleteResultSchema,
  providerTelemetryExportSchema,
  projectShareAttachmentSchema,
  projectShareDirectCreateSchema,
  projectWireSummarySchema,
  encryptedProjectWorkspaceCreateSchema,
  encryptedProjectWorkspaceUpdateSchema,
  projectWorkspaceWireListSchema,
  projectWorkspaceWireSummarySchema,
  projectTabLayoutWireSummarySchema,
  projectWorktreeListSchema,
  serviceLogReadResultSchema,
  projectWorktreeSummarySchema,
  projectViewWireListSchema,
  projectViewWireSummarySchema,
  queuedPromptListSchema,
  queuedPromptSchema,
  directAttachmentTicketSchema,
  directTransportTelemetrySchema,
  directTunnelTicketSchema,
  remoteDesktopWireListSchema,
  remoteDesktopFleetWireSchema,
  remoteDesktopWireSummarySchema,
  serverBootstrapSchema,
  settingsBundleSchema,
  scriptCommandListSchema,
  skillListSchema,
  skillSettingsContextSchema,
  skillSettingsDeleteRequestSchema,
  skillSettingsDocumentSchema,
  skillSettingsFileRequestSchema,
  skillSettingsFileUpdateSchema,
  skillSettingsInventorySchema,
  skillSettingsMutationResultSchema,
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
  tunnelDirectActivationSchema,
  tunnelListSchema,
  tunnelSummarySchema,
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
import type {
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
  ChatImportCreate,
  ChatPlanAnswer,
  ChatPlanUpdate,
  ChatRelocationCreate,
  ChatRelocationJobCancel,
  ChatRelocationJobRetry,
  ChatTurnMode,
  EncryptedQueuedPrompt,
  CodeAppearance,
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
  ModelProfileUpdate,
  ModelProviderCreate,
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
  ProjectViewKind,
  ProjectReplicaJobCancel,
  ProjectReplicaJobRetry,
  ProjectReplicaProvisionCreate,
  ProjectReplicaRemoveCreate,
  ProjectReplicaSynchronizeCreate,
  ExecutionPlacementResolveRequest,
  ExecutionTarget,
  ExecutionTargetResolveRequest,
  ProjectPreferredWorkerUpdate,
  ProjectGithubConversionPreflightRequest,
  ProjectGithubConversionStart,
  EncryptedProjectWorkspaceCreate,
  EncryptedProjectWorkspaceUpdate,
  ProjectWorktreeCreate,
  RemoteDesktopSummary,
  RemoteDesktopTarget,
  ReasoningEffort,
  SkillSettingsContext,
  SkillSettingsDeleteRequest,
  SkillSettingsFileRequest,
  SkillSettingsFileUpdate,
  TerminalServiceConfiguration,
  TerminalSummary,
  TaskDraftUpdate,
  TaskOperationStart,
  TaskContinuationStart,
  TaskPlanUpdate,
  TunnelAttachmentCreate,
  BrowserTunnelRequest,
  BrowserSummary,
  TunnelUserCreate,
  TunnelUserUpdate,
  UserSettingsUpdate,
  ExplorerFileWrite,
  WorktreePolicy,
  WorkerCredentialRotate,
  WorkerEncryptionRefreshRequest,
  WorkerEnrollmentCodeCreate,
  WorkerUpdate,
  ServiceLogLevel,
} from "@cantrip/protocol";
import {
  CantripApiError,
  post,
  request,
  requestResponse,
  withQuery,
} from "@/lib/api-client";
import { getActiveServerUrl } from "@/lib/server-connections";
import { chatTitleEncryption } from "@/lib/chat-title-encryption";
import { surfaceTitleEncryption } from "@/lib/surface-title-encryption";
import {
  createInitialTaskOpaqueContent,
  openTaskOpaqueSummary,
  prepareTaskDraftPersistence,
  prepareTaskEncryptedOperation,
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
  protectMcpServerCreate,
  protectMcpServerUpdate,
  protectModelProviderCreate,
  protectModelProviderUpdate,
} from "@/lib/protected-secrets";
import { getClientSession } from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import { authorizeWorkerEncryption } from "@/lib/worker-encryption-grants";

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

export async function deleteDirectAttachment(
  capabilityId: string,
): Promise<void> {
  await request(`/api/direct-attachments/${encodeURIComponent(capabilityId)}`, {
    method: "DELETE",
  });
}

export async function recordDirectAttachmentTelemetry(
  capabilityId: string,
  telemetry: Parameters<typeof directTransportTelemetrySchema.parse>[0],
): Promise<void> {
  await post(
    `/api/direct-attachments/${encodeURIComponent(capabilityId)}/telemetry`,
    directTransportTelemetrySchema.parse(telemetry),
  );
}

export async function getTunnels(projectId?: string) {
  return tunnelListSchema.parse(
    await request(
      projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/tunnels`
        : "/api/tunnels",
    ),
  );
}

export async function createTunnel(input: TunnelUserCreate) {
  return tunnelSummarySchema.parse(
    await post("/api/tunnels", tunnelUserCreateSchema.parse(input)),
  );
}

export async function updateTunnel(tunnelId: string, input: TunnelUserUpdate) {
  return tunnelSummarySchema.parse(
    await request(`/api/tunnels/${encodeURIComponent(tunnelId)}`, {
      method: "PATCH",
      body: JSON.stringify(tunnelUserUpdateSchema.parse(input)),
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
) {
  return tunnelAttachmentCreateResultSchema.parse(
    await post(
      `/api/tunnels/${encodeURIComponent(tunnelId)}/attachments`,
      tunnelAttachmentCreateSchema.parse(input),
    ),
  );
}

export async function deleteTunnelAttachment(
  attachmentId: string,
): Promise<void> {
  await request(`/api/tunnel-attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}

export async function createDirectTunnelAttachment(attachmentId: string) {
  return directTunnelTicketSchema.parse(
    await post(
      `/api/tunnel-attachments/${encodeURIComponent(attachmentId)}/direct`,
      {},
    ),
  );
}

export async function activateDirectTunnelAttachment(
  attachmentId: string,
  input: { capabilityId: string; localPort: number },
): Promise<void> {
  await post(
    `/api/tunnel-attachments/${encodeURIComponent(attachmentId)}/direct-activate`,
    tunnelDirectActivationSchema.parse(input),
  );
}

export async function getWorkerManagement() {
  return workerManagementListSchema.parse(
    await request("/api/workers/management"),
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

export async function getSettings() {
  return settingsBundleSchema.parse(await request("/api/settings"));
}

export async function updateSettings(input: UserSettingsUpdate) {
  return settingsBundleSchema.parse(
    await request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function getPolicyTemplates() {
  return policyTemplateListSchema.parse(await request("/api/policy-templates"));
}

export async function getPolicyTemplate(templateKey: string) {
  return policyTemplateDetailSchema.parse(
    await request(`/api/policy-templates/${encodeURIComponent(templateKey)}`),
  );
}

export async function getPolicies() {
  let wire = policyWireListSchema.parse(await request("/api/policies"));
  if (wire.bootstrapVersion < POLICY_BOOTSTRAP_VERSION) {
    const templates = await Promise.all(
      (await getPolicyTemplates()).map(({ templateKey }) =>
        getPolicyTemplate(templateKey),
      ),
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

export async function createGlobalMcpServer(input: McpServerConfiguration) {
  return openMcpServerWireSummary(
    await post(
      "/api/settings/mcp-servers",
      await protectMcpServerCreate(input),
    ),
  );
}

export async function updateGlobalMcpServer(
  serverId: string,
  input: McpServerConfiguration,
) {
  return openMcpServerWireSummary(
    await request(`/api/settings/mcp-servers/${encodeURIComponent(serverId)}`, {
      method: "PUT",
      body: JSON.stringify(await protectMcpServerUpdate(serverId, input)),
    }),
  );
}

export async function deleteGlobalMcpServer(serverId: string) {
  await request(`/api/settings/mcp-servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
  });
}

export async function createModelProvider(input: ModelProviderCreate) {
  return modelProviderSummarySchema.parse(
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
  return modelProviderAccountListSchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts`,
    ),
  );
}

export async function createModelProviderAccount(
  providerId: string,
  input: ModelProviderAccountCreate,
) {
  return modelProviderAccountSummarySchema.parse(
    await post(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts`,
      modelProviderAccountCreateSchema.parse(input),
    ),
  );
}

export async function updateModelProviderAccount(
  providerId: string,
  accountId: string,
  input: ModelProviderAccountUpdate,
) {
  return modelProviderAccountSummarySchema.parse(
    await request(
      `/api/settings/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(modelProviderAccountUpdateSchema.parse(input)),
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
  return modelProviderSummarySchema.parse(
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
  return githubAuthStatusSchema.parse(
    await request(
      `/api/github/status?workerId=${encodeURIComponent(workerId)}`,
    ),
  );
}

export async function getGithubRepositories(workerId: string) {
  return githubRepositoryListSchema.parse(
    await request(
      `/api/github/repositories?workerId=${encodeURIComponent(workerId)}`,
    ),
  );
}

export async function getGithubRepositoryOwners(workerId: string) {
  return githubRepositoryOwnerListSchema.parse(
    await request(
      `/api/github/repository-owners?workerId=${encodeURIComponent(workerId)}`,
    ),
  );
}

export async function createGithubRepository(
  workerId: string,
  input: GithubRepositoryCreate,
) {
  return githubRepositorySchema.parse(
    await post(
      `/api/github/repositories?workerId=${encodeURIComponent(workerId)}`,
      githubRepositoryCreateSchema.parse(input),
    ),
  );
}

export async function getCachedGithubRepositories(
  workerId: string,
  login: string,
) {
  return githubRepositoryListSchema.parse(
    await request(
      `/api/github/repositories/cache?workerId=${encodeURIComponent(workerId)}&login=${encodeURIComponent(login)}`,
    ),
  );
}

export async function getProjectWireList() {
  return projectWireListSchema.parse(await request("/api/projects"));
}

export async function getProjectMcpServers(projectId: string) {
  return openMcpServerWireList(
    await request(`/api/projects/${encodeURIComponent(projectId)}/mcp-servers`),
  );
}

export async function createProjectMcpServer(
  projectId: string,
  input: McpServerConfiguration,
) {
  return openMcpServerWireSummary(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      await protectMcpServerCreate(input),
    ),
  );
}

export async function updateProjectMcpServer(
  projectId: string,
  serverId: string,
  input: McpServerConfiguration,
) {
  return openMcpServerWireSummary(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}`,
      {
        method: "PUT",
        body: JSON.stringify(await protectMcpServerUpdate(serverId, input)),
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
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...configuration
  } = source;
  return createProjectMcpServer(projectId, configuration);
}

export async function createProjectNetworkShare(projectId: string) {
  return projectShareAttachmentSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/network-shares`,
      {},
    ),
  );
}

export async function deleteProjectNetworkShare(attachmentId: string) {
  await request(`/api/project-shares/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}

export async function createDirectProjectNetworkShare(
  attachmentId: string,
  clientId: string,
) {
  return directTunnelTicketSchema.parse(
    await post(
      `/api/project-shares/${encodeURIComponent(attachmentId)}/direct`,
      projectShareDirectCreateSchema.parse({ clientId }),
    ),
  );
}

export async function createDirectTerminalAttachment(
  terminalId: string,
  clientId: string,
) {
  return directTunnelTicketSchema.parse(
    await post(
      `/api/terminals/${encodeURIComponent(terminalId)}/direct`,
      projectShareDirectCreateSchema.parse({ clientId }),
    ),
  );
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

export async function getProjectWorktrees(projectId: string) {
  return projectWorktreeListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/worktrees`),
  );
}

export async function getProjectWorktreeStatus(
  projectId: string,
  worktreeId: string,
) {
  return worktreeStatusResultSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/status`,
    ),
  );
}

export async function getProjectWorktreeFileDiff(
  projectId: string,
  worktreeId: string,
  path: string,
  scope: GitDiffScope,
) {
  return gitFileDiffSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/diff?path=${encodeURIComponent(path)}&scope=${scope}`,
    ),
  );
}

export async function createProjectWorktree(
  projectId: string,
  input: ProjectWorktreeCreate,
) {
  return projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
      input,
    ),
  );
}

export async function reconcileProjectWorktrees(projectId: string) {
  return projectWorktreeListSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/reconcile`,
      {},
    ),
  );
}

export async function getProjectWorktreeHistory(
  projectId: string,
  worktreeId: string,
  cursor = 0,
) {
  return gitHistorySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/history?cursor=${cursor}&limit=100`,
    ),
  );
}

function projectWorktreeGraphUrl(
  projectId: string,
  worktreeId: string,
  resource: "metrics" | "snapshot",
  input: Partial<GitGraphRequest> = {},
): string {
  const parsed = gitGraphRequestSchema.parse(input);
  const search = new URLSearchParams({
    includeBlame: String(parsed.includeBlame),
    maxNodes: String(parsed.maxNodes),
    revision: parsed.revision,
  });
  if (parsed.rootPath) search.set("rootPath", parsed.rootPath);
  return `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/graph/${resource}?${search.toString()}`;
}

export async function getProjectWorktreeGraphSnapshot(
  projectId: string,
  worktreeId: string,
  input: Partial<GitGraphRequest> = {},
) {
  return gitGraphSnapshotSchema.parse(
    await request(
      projectWorktreeGraphUrl(projectId, worktreeId, "snapshot", input),
    ),
  );
}

export async function getProjectWorktreeGraphMetrics(
  projectId: string,
  worktreeId: string,
  input: Partial<GitGraphRequest> = {},
) {
  return gitGraphMetricsSchema.parse(
    await request(
      projectWorktreeGraphUrl(projectId, worktreeId, "metrics", input),
    ),
  );
}

export async function getProjectWorktreeGraphCommitOverlay(
  projectId: string,
  worktreeId: string,
  input: GitGraphCommitOverlayRequest,
) {
  const parsed = gitGraphCommitOverlayRequestSchema.parse(input);
  const search = new URLSearchParams();
  if (parsed.rootPath) search.set("rootPath", parsed.rootPath);
  const query = search.size ? `?${search.toString()}` : "";
  return gitGraphCommitOverlaySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/graph/commits/${encodeURIComponent(parsed.revision)}${query}`,
    ),
  );
}

export async function getProjectWorktreeFileHistory(
  projectId: string,
  worktreeId: string,
  path: string,
  revision = "HEAD",
  cursor = 0,
) {
  const search = new URLSearchParams({
    path,
    revision,
    cursor: String(cursor),
    limit: "100",
  });
  return gitFileHistorySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/files/history?${search.toString()}`,
    ),
  );
}

export async function getProjectWorktreeFileBlame(
  projectId: string,
  worktreeId: string,
  path: string,
  revision = "HEAD",
  cursor = 0,
) {
  const search = new URLSearchParams({
    path,
    revision,
    cursor: String(cursor),
    limit: "200",
  });
  return gitBlameSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/files/blame?${search.toString()}`,
    ),
  );
}

export async function searchProjectWorktreeCommits(
  projectId: string,
  worktreeId: string,
  query: GitCommitSearchQuery,
  cursor = 0,
) {
  const search = new URLSearchParams({ cursor: String(cursor), limit: "100" });
  for (const [key, value] of Object.entries(query)) {
    if (value) search.set(key, value);
  }
  return gitCommitSearchResultSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/commits/search?${search.toString()}`,
    ),
  );
}

export async function getProjectWorktreeRecoveryCandidates(
  projectId: string,
  worktreeId: string,
  kind: "reflog" | "dangling",
  cursor = 0,
) {
  const search = new URLSearchParams({
    kind,
    cursor: String(cursor),
    limit: "100",
  });
  return gitRecoveryCandidateListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/recovery?${search.toString()}`,
    ),
  );
}

export async function previewProjectWorktreeRecovery(
  projectId: string,
  worktreeId: string,
  action: GitRecoveryAction,
) {
  return gitRecoveryPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/recovery/preview`,
      action,
    ),
  );
}

export async function applyProjectWorktreeRecovery(
  projectId: string,
  worktreeId: string,
  recovery: GitRecoveryApply,
) {
  return gitRecoveryResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/recovery/apply`,
      recovery,
    ),
  );
}

export async function getProjectWorktreeCommit(
  projectId: string,
  worktreeId: string,
  revision: string,
  parentIndex = 0,
) {
  return gitCommitDetailSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/commits/${encodeURIComponent(revision)}?parent=${parentIndex}`,
    ),
  );
}

export async function getProjectWorktreeCommitSignature(
  projectId: string,
  worktreeId: string,
  revision: string,
) {
  return gitSignatureSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/commits/${encodeURIComponent(revision)}/signature`,
    ),
  );
}

export async function getProjectWorktreeRevisionCandidates(
  projectId: string,
  worktreeId: string,
) {
  return gitRevisionCandidateListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/refs`,
    ),
  );
}

export async function getProjectWorktreeComparison(
  projectId: string,
  worktreeId: string,
  left: string,
  right: string,
  mode: "direct" | "merge-base",
) {
  const search = new URLSearchParams({ left, right, mode });
  return gitComparisonSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/compare?${search.toString()}`,
    ),
  );
}

export async function getProjectWorktreeRevisionDiff(
  projectId: string,
  worktreeId: string,
  revision: string,
  baseRevision: string | null,
  path: string,
) {
  const search = new URLSearchParams({ path });
  if (baseRevision) search.set("base", baseRevision);
  return gitRevisionFileDiffSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/revisions/${encodeURIComponent(revision)}/diff?${search.toString()}`,
    ),
  );
}

export async function runProjectWorktreeGitAction(
  projectId: string,
  worktreeId: string,
  action: GitAction,
) {
  return gitActionResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/actions`,
      action,
    ),
  );
}

export async function generateProjectWorktreeGitDraft(
  projectId: string,
  worktreeId: string,
  input: GitAgentDraftCreate,
) {
  return gitAgentDraftResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/agent/drafts`,
      gitAgentDraftCreateSchema.parse(input),
    ),
  );
}

export async function previewProjectWorktreeGitForcePush(
  projectId: string,
  worktreeId: string,
) {
  return gitForcePushPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/force-push/preview`,
      {},
    ),
  );
}

export async function applyProjectWorktreeGitForcePush(
  projectId: string,
  worktreeId: string,
  token: string,
) {
  return gitActionResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/force-push/apply`,
      { token },
    ),
  );
}

export async function getProjectWorktreeBranches(
  projectId: string,
  worktreeId: string,
) {
  return gitBranchListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/branches`,
    ),
  );
}

export async function previewProjectWorktreeBranchAction(
  projectId: string,
  worktreeId: string,
  action: GitBranchAction,
) {
  return gitBranchActionPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/branches/actions/preview`,
      action,
    ),
  );
}

export async function applyProjectWorktreeBranchAction(
  projectId: string,
  worktreeId: string,
  action: GitBranchAction,
  token: string,
) {
  return gitBranchMutationResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/branches/actions/apply`,
      { action, token },
    ),
  );
}

export async function previewProjectWorktreeCommitAction(
  projectId: string,
  worktreeId: string,
  action: GitCommitAction,
) {
  return gitCommitActionPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/commits/actions/preview`,
      action,
    ),
  );
}

export async function applyProjectWorktreeCommitAction(
  projectId: string,
  worktreeId: string,
  action: GitCommitAction,
  token: string,
) {
  return gitCommitActionResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/commits/actions/apply`,
      { action, token },
    ),
  );
}

export async function getProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
) {
  return gitManagedOperationResponseSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/operations/current`,
    ),
  );
}

export async function previewProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  action: GitManagedOperationAction,
) {
  return gitManagedOperationPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/operations/preview`,
      action,
    ),
  );
}

export async function startProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  action: GitManagedOperationAction,
  token: string,
) {
  return gitManagedOperationResponseSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/operations`,
      { action, token },
    ),
  );
}

export async function controlProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  operationId: string,
  action: "continue" | "skip" | "abort" | "good" | "bad" | "reset",
) {
  return gitManagedOperationResponseSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/operations/${encodeURIComponent(operationId)}/control`,
      { action },
    ),
  );
}

export async function amendProjectWorktreeGitOperation(
  projectId: string,
  worktreeId: string,
  operationId: string,
  message: string | null,
) {
  return gitManagedOperationResponseSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/operations/${encodeURIComponent(operationId)}/amend`,
      { message },
    ),
  );
}

export async function getProjectWorktreeGitConflicts(
  projectId: string,
  worktreeId: string,
) {
  return gitConflictListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/conflicts`,
    ),
  );
}

export async function getProjectWorktreeGitConflict(
  projectId: string,
  worktreeId: string,
  path: string,
) {
  return gitConflictDetailSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/conflicts/detail?path=${encodeURIComponent(path)}`,
    ),
  );
}

export async function previewProjectWorktreeGitConflictResolution(
  projectId: string,
  worktreeId: string,
  resolution: GitConflictResolutionRequest,
) {
  return gitConflictResolutionPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/conflicts/preview`,
      resolution,
    ),
  );
}

export async function applyProjectWorktreeGitConflictResolution(
  projectId: string,
  worktreeId: string,
  resolution: GitConflictResolutionRequest,
  token: string,
) {
  return gitConflictResolutionResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/conflicts/apply`,
      { request: resolution, token },
    ),
  );
}

export async function getProjectWorktreeRemotes(
  projectId: string,
  worktreeId: string,
) {
  return gitRemoteListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/remotes`,
    ),
  );
}

export async function previewProjectWorktreeRemoteAction(
  projectId: string,
  worktreeId: string,
  action: GitRemoteAction,
) {
  return gitRemoteActionPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/remotes/actions/preview`,
      action,
    ),
  );
}

export async function applyProjectWorktreeRemoteAction(
  projectId: string,
  worktreeId: string,
  action: GitRemoteAction,
  token: string,
) {
  return gitRemoteMutationResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/remotes/actions/apply`,
      { action, token },
    ),
  );
}

export async function getProjectWorktreeSubmodules(
  projectId: string,
  worktreeId: string,
) {
  return gitSubmoduleListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/submodules`,
    ),
  );
}

export async function previewProjectWorktreeSubmoduleAction(
  projectId: string,
  worktreeId: string,
  action: GitSubmoduleAction,
) {
  return gitSubmoduleActionPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/submodules/actions/preview`,
      action,
    ),
  );
}

export async function applyProjectWorktreeSubmoduleAction(
  projectId: string,
  worktreeId: string,
  action: GitSubmoduleAction,
  token: string,
) {
  return gitSubmoduleMutationResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/submodules/actions/apply`,
      { action, token },
    ),
  );
}

export async function getProjectWorktreeGitLfs(
  projectId: string,
  worktreeId: string,
) {
  return gitLfsStatusSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/lfs`,
    ),
  );
}

export async function previewProjectWorktreeGitLfsAction(
  projectId: string,
  worktreeId: string,
  action: GitLfsAction,
) {
  return gitLfsActionPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/lfs/actions/preview`,
      action,
    ),
  );
}

export async function applyProjectWorktreeGitLfsAction(
  projectId: string,
  worktreeId: string,
  action: GitLfsAction,
  token: string,
) {
  return gitLfsMutationResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/lfs/actions/apply`,
      { action, token },
    ),
  );
}

export async function getProjectWorktreeTags(
  projectId: string,
  worktreeId: string,
) {
  return gitTagListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/tags`,
    ),
  );
}

export async function getProjectWorktreeTag(
  projectId: string,
  worktreeId: string,
  name: string,
) {
  return gitTagDetailSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/tags/${encodeURIComponent(name)}`,
    ),
  );
}

export async function previewProjectWorktreeTagAction(
  projectId: string,
  worktreeId: string,
  action: GitTagAction,
) {
  return gitTagActionPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/tags/actions/preview`,
      action,
    ),
  );
}

export async function applyProjectWorktreeTagAction(
  projectId: string,
  worktreeId: string,
  action: GitTagAction,
  token: string,
) {
  return gitTagMutationResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/tags/actions/apply`,
      { action, token },
    ),
  );
}

export async function getProjectWorktreeGithubReleases(
  projectId: string,
  worktreeId: string,
) {
  return githubReleaseListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/github/releases`,
    ),
  );
}

export async function getProjectWorktreeGithubRelease(
  projectId: string,
  worktreeId: string,
  releaseId: number,
) {
  return githubReleaseSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/github/releases/${releaseId}`,
    ),
  );
}

export async function createProjectWorktreeGithubRelease(
  projectId: string,
  worktreeId: string,
  input: GithubReleaseCreate,
) {
  return githubReleaseSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/github/releases`,
      input,
    ),
  );
}

export async function previewProjectWorktreePartialPatch(
  projectId: string,
  worktreeId: string,
  input: GitPartialPatchRequest,
) {
  return gitPartialPatchPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/patch/preview`,
      input,
    ),
  );
}

export async function applyProjectWorktreePartialPatch(
  projectId: string,
  worktreeId: string,
  request: GitPartialPatchRequest,
  token: string,
) {
  return gitActionResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/patch/apply`,
      { request, token },
    ),
  );
}

export async function getProjectWorktreeStashes(
  projectId: string,
  worktreeId: string,
) {
  return gitStashListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/stashes`,
    ),
  );
}

export async function createProjectWorktreeStash(
  projectId: string,
  worktreeId: string,
  input: GitStashCreate,
) {
  return gitStashMutationResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/stashes`,
      input,
    ),
  );
}

export async function getProjectWorktreeStashFileDiff(
  projectId: string,
  worktreeId: string,
  hash: string,
  path: string,
) {
  return gitStashFileDiffSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/stashes/${encodeURIComponent(hash)}/diff?path=${encodeURIComponent(path)}`,
    ),
  );
}

export async function previewProjectWorktreeStashAction(
  projectId: string,
  worktreeId: string,
  action: GitStashAction,
) {
  return gitStashActionPreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/stashes/actions/preview`,
      action,
    ),
  );
}

export async function applyProjectWorktreeStashAction(
  projectId: string,
  worktreeId: string,
  action: GitStashAction,
  token: string,
) {
  return gitStashMutationResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/git/stashes/actions/apply`,
      { action, token },
    ),
  );
}

export async function lockProjectWorktree(
  projectId: string,
  worktreeId: string,
  reason: string | null,
) {
  return projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/lock`,
      { reason },
    ),
  );
}

export async function unlockProjectWorktree(
  projectId: string,
  worktreeId: string,
) {
  return projectWorktreeSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/unlock`,
      {},
    ),
  );
}

export async function pruneProjectWorktrees(
  projectId: string,
  allowExternal: boolean,
) {
  return projectWorktreeListSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/prune`,
      { allowExternal },
    ),
  );
}

export async function removeProjectWorktree(
  projectId: string,
  worktreeId: string,
  input: { allowExternal: boolean; force: boolean },
) {
  return projectWorktreeSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}`,
      { method: "DELETE", body: JSON.stringify(input) },
    ),
  );
}

export async function getGitHistory(projectId: string, cursor = 0) {
  return gitHistorySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/git/history?limit=100&cursor=${cursor}`,
    ),
  );
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
  providerId?: string;
  providerAccountId?: string;
  modelId?: string;
  reasoningEffort?: string;
  projectId?: string;
  days?: number;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return providerTelemetryAnalyticsSchema.parse(
    await request(`/api/analytics/provider-telemetry?${query.toString()}`),
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
  return githubPullRequestCreateResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/github/pull-requests`,
      request,
    ),
  );
}

export async function getGithubPullRequest(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
) {
  return githubPullRequestDetailSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/github/pull-requests/${pullRequestNumber}`,
    ),
  );
}

export async function checkoutGithubPullRequest(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
) {
  return githubPullRequestCheckoutResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/github/pull-requests/${pullRequestNumber}/checkout`,
      {},
    ),
  );
}

export async function runGithubPullRequestReviewAction(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  action: GithubPullRequestReviewAction,
) {
  return githubPullRequestDetailSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/github/pull-requests/${pullRequestNumber}/actions`,
      action,
    ),
  );
}

export async function previewGithubPullRequestLifecycle(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  action: GithubPullRequestLifecycleAction,
) {
  return githubPullRequestLifecyclePreviewSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/github/pull-requests/${pullRequestNumber}/lifecycle/preview`,
      action,
    ),
  );
}

export async function applyGithubPullRequestLifecycle(
  projectId: string,
  worktreeId: string,
  pullRequestNumber: number,
  input: GithubPullRequestLifecycleApply,
) {
  return githubPullRequestDetailSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktreeId)}/github/pull-requests/${pullRequestNumber}/lifecycle/apply`,
      input,
    ),
  );
}

export async function getGithubIssues(
  projectId: string,
  kind: GithubIssueKind,
  state: GithubIssueState,
  page = 1,
) {
  return githubIssueListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues?kind=${encodeURIComponent(kind)}&state=${encodeURIComponent(state)}&page=${page}&limit=100`,
    ),
  );
}

export async function getGithubIssue(projectId: string, issueNumber: number) {
  return githubIssueDetailSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues/${issueNumber}`,
    ),
  );
}

export async function createGithubIssue(
  projectId: string,
  input: GithubIssueCreate,
) {
  return githubIssueDetailSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues`,
      input,
    ),
  );
}

export async function commentOnGithubIssue(
  projectId: string,
  issueNumber: number,
  body: string,
) {
  return githubIssueDetailSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues/${issueNumber}/comments`,
      { body },
    ),
  );
}

export async function closeGithubIssue(
  projectId: string,
  issueNumber: number,
  comment: string | null,
) {
  return githubIssueDetailSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github/issues/${issueNumber}/close`,
      { comment },
    ),
  );
}

export async function getGitStatus(projectId: string) {
  return gitStatusSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/git/status`),
  );
}

export async function runGitAction(projectId: string, action: GitAction) {
  return gitActionResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/git/actions`,
      action,
    ),
  );
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
  return projectReplicaListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/replicas`),
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
  return projectReplicaSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/replicas/${encodeURIComponent(projectReplicaId)}`,
    ),
  );
}

export async function createProjectReplica(
  projectId: string,
  input: ProjectReplicaProvisionCreate,
) {
  return projectReplicaJobSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas`,
      input,
    ),
  );
}

export async function synchronizeProjectReplica(
  projectId: string,
  projectReplicaId: string,
  input: ProjectReplicaSynchronizeCreate,
) {
  return projectReplicaJobSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas/${encodeURIComponent(projectReplicaId)}/synchronize`,
      input,
    ),
  );
}

export async function removeProjectReplica(
  projectId: string,
  projectReplicaId: string,
  input: ProjectReplicaRemoveCreate,
) {
  return projectReplicaJobSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/replicas/${encodeURIComponent(projectReplicaId)}/remove`,
      input,
    ),
  );
}

export async function getProjectReplicaJobs(projectId: string) {
  return projectReplicaJobListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/replica-jobs`,
    ),
  );
}

export async function getProjectReplicaJob(jobId: string) {
  return projectReplicaJobSummarySchema.parse(
    await request(`/api/project-replica-jobs/${encodeURIComponent(jobId)}`),
  );
}

export async function retryProjectReplicaJob(
  jobId: string,
  input: ProjectReplicaJobRetry,
) {
  return projectReplicaJobSummarySchema.parse(
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
  return projectReplicaJobSummarySchema.parse(
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
  return projectGithubConversionPreflightResultSchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github-conversion/preflight`,
      projectGithubConversionPreflightRequestSchema.parse(input),
    ),
  );
}

export async function startProjectGithubConversion(
  projectId: string,
  input: ProjectGithubConversionStart,
) {
  return projectGithubConversionJobSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/github-conversion`,
      projectGithubConversionStartSchema.parse(input),
    ),
  );
}

export async function getProjectGithubConversion(projectId: string) {
  try {
    return projectGithubConversionJobSummarySchema.parse(
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
  return projectGithubConversionJobSummarySchema.parse(
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

async function sendEncryptedTaskOperation(
  chatId: string,
  path: "plan" | "continue" | "begin-implementation" | "retry",
  input: TaskOperationStart | TaskContinuationStart,
  kind: "initial-plan" | "continue-plan" | "finalize",
) {
  await getPolicies();
  const current = await getTask(chatId);
  assertCurrentTaskVersion(current.rowVersion, input.rowVersion);
  const operation = await prepareTaskEncryptedOperation(current, {
    kind,
    operationId: input.operationId,
    rowVersion: input.rowVersion,
    ...(path === "continue" || path === "begin-implementation"
      ? {
          answers: (input as TaskContinuationStart).answers,
          additionalDirection: (input as TaskContinuationStart)
            .additionalDirection,
        }
      : {}),
  });
  return openTaskOpaqueSummary(
    await post(`/api/tasks/${encodeURIComponent(chatId)}/${path}`, operation),
  );
}

export async function startTaskPlanning(
  chatId: string,
  input: TaskOperationStart,
) {
  return sendEncryptedTaskOperation(chatId, "plan", input, "initial-plan");
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
  return sendEncryptedTaskOperation(chatId, "continue", input, "continue-plan");
}

export async function beginTaskImplementation(
  chatId: string,
  input: TaskContinuationStart,
) {
  return sendEncryptedTaskOperation(
    chatId,
    "begin-implementation",
    input,
    "finalize",
  );
}

export async function retryTaskPlanning(
  chatId: string,
  input: TaskOperationStart,
) {
  const current = await getTask(chatId);
  assertCurrentTaskVersion(current.rowVersion, input.rowVersion);
  const kind = current.lastError?.operationKind;
  if (!kind || kind === "implementation") {
    throw new Error("This Task has no encrypted planning operation to retry.");
  }
  const operation = await prepareTaskEncryptedOperation(current, {
    kind,
    operationId: input.operationId,
    rowVersion: input.rowVersion,
  });
  return openTaskOpaqueSummary(
    await post(`/api/tasks/${encodeURIComponent(chatId)}/retry`, operation),
  );
}

export async function getTerminals(projectId: string) {
  const terminals = terminalWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/terminals`),
  );
  return Promise.all(
    terminals.map((terminal) => surfaceTitleEncryption.openTerminal(terminal)),
  );
}

export async function getTerminalScriptCommands(terminalId: string) {
  return scriptCommandListSchema.parse(
    await request(
      `/api/terminals/${encodeURIComponent(terminalId)}/script-commands`,
    ),
  );
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
  return surfaceTitleEncryption.openTerminal(
    terminalWireSummarySchema.parse(
      await post(`/api/projects/${encodeURIComponent(projectId)}/terminals`, {
        id,
        titleProtection,
        stateProtection,
        ...(worktreeId ? { worktreeId } : {}),
        ...(tabGroupId ? { tabGroupId } : {}),
        ...(target ? { target } : {}),
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
) {
  const id = crypto.randomUUID();
  const titleProtection = await surfaceTitleEncryption.protect(
    id,
    title,
    "explorer",
  );
  const stateProtection = await surfaceTitleEncryption.protectExplorerState(
    id,
    null,
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
  return tunnelSummarySchema.parse(
    await post(
      `/api/browsers/${encodeURIComponent(browserId)}/tunnel`,
      browserTunnelRequestSchema.parse(route),
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

export async function getCodeTabs(projectId: string) {
  const codeTabs = codeTabWireListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/code-tabs`),
  );
  return Promise.all(
    codeTabs.map((codeTab) => surfaceTitleEncryption.openCodeTab(codeTab)),
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
    method: "DELETE",
  });
}

export async function createCodeAttachment(
  codeTabId: string,
  appearance: CodeAppearance,
) {
  return codeAttachmentSchema.parse(
    await post(`/api/code-tabs/${encodeURIComponent(codeTabId)}/attachments`, {
      appearance,
    }),
  );
}

export async function getCodeRuntime(codeTabId: string, sessionId: string) {
  return codeRuntimeStatusSchema.parse(
    await request(
      `/api/code-tabs/${encodeURIComponent(codeTabId)}/sessions/${encodeURIComponent(sessionId)}/runtime`,
    ),
  );
}

export async function releaseCodeAttachment(attachmentId: string) {
  await request(`/api/code-attachments/${encodeURIComponent(attachmentId)}`, {
    keepalive: true,
    method: "DELETE",
  });
}

export async function createDirectCodeAttachment(
  attachmentId: string,
  clientId: string,
) {
  return directTunnelTicketSchema.parse(
    await post(
      `/api/code-attachments/${encodeURIComponent(attachmentId)}/direct`,
      projectShareDirectCreateSchema.parse({ clientId }),
    ),
  );
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

export async function getExplorerDirectory(explorerId: string, path: string) {
  return explorerDirectorySchema.parse(
    await request(
      `/api/explorers/${encodeURIComponent(explorerId)}/directory?path=${encodeURIComponent(path)}`,
    ),
  );
}

export async function getExplorerDirectoryCommits(
  explorerId: string,
  path: string,
) {
  return explorerDirectoryCommitsSchema.parse(
    await request(
      `/api/explorers/${encodeURIComponent(explorerId)}/directory/commits?path=${encodeURIComponent(path)}`,
    ),
  );
}

export async function getExplorerFile(explorerId: string, path: string) {
  return explorerFileSchema.parse(
    await request(
      `/api/explorers/${encodeURIComponent(explorerId)}/file?path=${encodeURIComponent(path)}`,
    ),
  );
}

export function explorerMediaContentUrl(
  explorerId: string,
  path: string,
  revision = 0,
): string {
  return `${getActiveServerUrl()}/api/explorers/${encodeURIComponent(explorerId)}/media?path=${encodeURIComponent(path)}&revision=${revision}`;
}

export async function saveExplorerFile(
  explorerId: string,
  input: ExplorerFileWrite,
) {
  return explorerFileSchema.parse(
    await request(`/api/explorers/${encodeURIComponent(explorerId)}/file`, {
      method: "PUT",
      body: JSON.stringify(explorerFileWriteSchema.parse(input)),
    }),
  );
}

export function terminalWebSocketUrl(terminalId: string): string {
  const serverUrl = getActiveServerUrl();
  const url = new URL(
    `/api/terminals/${encodeURIComponent(terminalId)}/connect`,
    serverUrl || window.location.origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function remoteSurfaceWebSocketUrl(
  surfaceId: string,
  viewport: { width: number; height: number; devicePixelRatio: number },
): string {
  const serverUrl = getActiveServerUrl();
  const url = new URL(
    `/api/remote-surfaces/${encodeURIComponent(surfaceId)}/connect`,
    serverUrl || window.location.origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("width", String(viewport.width));
  url.searchParams.set("height", String(viewport.height));
  url.searchParams.set("devicePixelRatio", String(viewport.devicePixelRatio));
  return url.toString();
}

export async function renameChat(chatId: string, title: string) {
  return chatTitleEncryption.open(
    chatWireSummarySchema.parse(
      await request(`/api/chats/${encodeURIComponent(chatId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          titleProtection: await chatTitleEncryption.protect(chatId, title),
        }),
      }),
    ),
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
  return chatTitleEncryption.open(
    chatWireSummarySchema.parse(
      await post(`/api/chats/${encodeURIComponent(chatId)}/restore`, {}),
    ),
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
  return chatTitleEncryption.open(
    chatWireSummarySchema.parse(
      await post(`/api/chats/${encodeURIComponent(chatId)}/fork`, {
        id,
        titleProtection: await chatTitleEncryption.protect(
          id,
          `${sourceTitle} (fork)`,
        ),
        ...(messageId ? { messageId } : {}),
      }),
    ),
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
    status?: AgentInteractionRequestStatus;
    limit?: number;
  } = {},
) {
  const query = new URLSearchParams();
  if (input.chatId) query.set("chatId", input.chatId);
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

export async function getSkills(chatId: string) {
  return skillListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/skills`),
  );
}

export async function getSettingsSkills(input: SkillSettingsContext) {
  const parsed = skillSettingsContextSchema.parse(input);
  return skillSettingsInventorySchema.parse(
    await request(
      withQuery("/api/skills", {
        workerId: parsed.workerId,
        providerId: parsed.providerId,
        projectId: parsed.projectId ?? undefined,
      }),
    ),
  );
}

export async function readSettingsSkill(input: SkillSettingsFileRequest) {
  return skillSettingsDocumentSchema.parse(
    await post("/api/skills/read", skillSettingsFileRequestSchema.parse(input)),
  );
}

export async function updateSettingsSkillFile(input: SkillSettingsFileUpdate) {
  return skillSettingsMutationResultSchema.parse(
    await request("/api/skills/file", {
      method: "PUT",
      body: JSON.stringify(skillSettingsFileUpdateSchema.parse(input)),
    }),
  );
}

export async function deleteSettingsSkill(input: SkillSettingsDeleteRequest) {
  return skillSettingsMutationResultSchema.parse(
    await request("/api/skills", {
      method: "DELETE",
      body: JSON.stringify(skillSettingsDeleteRequestSchema.parse(input)),
    }),
  );
}

export async function getChatCustomizations(chatId: string, refresh = false) {
  const query = refresh ? "?refresh=true" : "";
  return codexCustomizationInventorySchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations${query}`,
    ),
  );
}

export async function getChatExternalImportPreview(chatId: string) {
  return codexExternalImportPreviewSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/external-preview`,
    ),
  );
}

export async function readChatMcpResource(
  chatId: string,
  input: CodexMcpResourceReadRequest,
) {
  return codexMcpResourceReadSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-resource`,
      codexMcpResourceReadRequestSchema.parse(input),
    ),
  );
}

export async function configureChatSkill(
  chatId: string,
  input: CodexSkillConfigUpdate,
) {
  return codexSkillConfigResultSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/skill`,
      {
        method: "PATCH",
        body: JSON.stringify(codexSkillConfigUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function setChatSkillRoots(
  chatId: string,
  input: CodexSkillRootsUpdate,
) {
  return codexSkillRootsResultSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/skill-roots`,
      {
        method: "PUT",
        body: JSON.stringify(codexSkillRootsUpdateSchema.parse(input)),
      },
    ),
  );
}

export async function startChatMcpOauth(
  chatId: string,
  input: CodexMcpOauthStart,
) {
  return codexMcpOauthStartResultSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-oauth`,
      codexMcpOauthStartSchema.parse(input),
    ),
  );
}

export async function getChatMcpOauthStatus(chatId: string, server: string) {
  return codexMcpOauthStatusSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-oauth/status?server=${encodeURIComponent(server)}`,
    ),
  );
}

export async function reloadChatMcpServers(chatId: string) {
  return codexMcpReloadResultSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/mcp-reload`,
      {},
    ),
  );
}

export async function applyChatExternalImport(
  chatId: string,
  input: CodexExternalImportApply,
) {
  return codexExternalImportStatusSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/external-import`,
      codexExternalImportApplySchema.parse(input),
    ),
  );
}

export async function getChatExternalImportStatus(
  chatId: string,
  importId: string,
) {
  return codexExternalImportStatusSchema.parse(
    await request(
      `/api/chats/${encodeURIComponent(chatId)}/customizations/external-import/status?importId=${encodeURIComponent(importId)}`,
    ),
  );
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

export async function getChatReasoning(chatId: string) {
  return chatReasoningStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/reasoning`),
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
  modelId: string,
  attachments: ChatAttachmentSummary[] = [],
  mode: ChatTurnMode = "default",
  reasoningEffort: ReasoningEffort | null = null,
) {
  await getPolicies();
  const idempotencyKey = crypto.randomUUID();
  const input = await createEncryptedChatTurn({
    attachments,
    idempotencyKey,
    messageId: crypto.randomUUID(),
    mode,
    modelId,
    promptId: crypto.randomUUID(),
    reasoningEffort,
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
