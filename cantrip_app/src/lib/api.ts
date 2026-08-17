import {
  accountAdminSummarySchema,
  accountLicenseWhitelistCreateSchema,
  accountLicenseWhitelistEntrySchema,
  accountRegistrationSchema,
  authLoginSchema,
  mobileSignInGrantCreateResultSchema,
  mobileSignInGrantExchangeSchema,
  authLogoutAllResultSchema,
  authSessionSchema,
  authSessionStateSchema,
  agentInteractionRequestListSchema,
  agentInteractionRequestSchema,
  agentInteractionResolutionCreateSchema,
  archivedChatCleanupResultSchema,
  archivedChatListSchema,
  browserListSchema,
  browserServiceFleetDiscoverySchema,
  browserServiceListSchema,
  browserSummarySchema,
  browserTunnelRequestSchema,
  agentThreadSyncSchema,
  chatListSchema,
  chatAttachmentListSchema,
  chatAttachmentSummarySchema,
  chatGoalClearSchema,
  chatGoalCreateSchema,
  chatGoalResponseSchema,
  chatGoalUpdateSchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  chatMessageListSchema,
  chatSummarySchema,
  chatCompactAcceptedSchema,
  chatImportCreateSchema,
  chatImportJobListSchema,
  chatImportJobRetrySchema,
  chatImportJobSummarySchema,
  chatInterruptAcceptedSchema,
  chatPlanAcceptedSchema,
  chatPlanAnswerSchema,
  chatPlanStateSchema,
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
  chatPromptSubmitResultSchema,
  chatReasoningStateSchema,
  chatReasoningUpdateSchema,
  codeAttachmentSchema,
  codeRuntimeStatusSchema,
  codeSaveAllResultSchema,
  codeTabListSchema,
  codeTabSummarySchema,
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
  explorerListSchema,
  explorerSummarySchema,
  explorerViewStateUpdateSchema,
  executionPlacementResolutionSchema,
  executionPlacementResolveRequestSchema,
  executionTargetCatalogSchema,
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
  modelProviderCreateSchema,
  providerModelCatalogResultSchema,
  modelProviderSummarySchema,
  modelProviderUpdateSchema,
  mcpServerConfigurationSchema,
  mcpServerCopySchema,
  mcpServerListSchema,
  mcpServerSummarySchema,
  orderedIdsSchema,
  effectivePolicyListSchema,
  policyAssignmentListSchema,
  policyAssignmentUpdateSchema,
  policyCreateSchema,
  policyDeleteSchema,
  policyDetailSchema,
  policyFromTemplateCreateSchema,
  policyListSchema,
  policyOrderUpdateSchema,
  policyTemplateDetailSchema,
  policyTemplateListSchema,
  policyTemplateResetSchema,
  policyUpdateSchema,
  projectListSchema,
  projectExternalChatDiscoverySchema,
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
  projectSummarySchema,
  projectWorkspaceCreateSchema,
  projectWorkspaceListSchema,
  projectWorkspaceSummarySchema,
  projectWorkspaceUpdateSchema,
  projectTabLayoutSummarySchema,
  projectWorktreeListSchema,
  serviceLogReadResultSchema,
  projectWorktreeSummarySchema,
  projectViewListSchema,
  projectViewSummarySchema,
  queuedPromptListSchema,
  queuedPromptSchema,
  directAttachmentTicketSchema,
  directTransportTelemetrySchema,
  directTunnelTicketSchema,
  remoteDesktopListSchema,
  remoteDesktopFleetSchema,
  remoteDesktopSummarySchema,
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
  taskCreateResultSchema,
  taskContinuationStartSchema,
  taskDetailSchema,
  taskDraftUpdateSchema,
  taskOperationStartSchema,
  taskPlanUpdateSchema,
  terminalListSchema,
  terminalSummarySchema,
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
  workerSummarySchema,
  workerUpdateSchema,
} from "@cantrip/protocol";
import type {
  AccountRegistration,
  AuthLogin,
  MobileSignInGrantExchange,
  AgentInteractionRequestStatus,
  AgentInteractionResolutionCreate,
  ChatWorktreeUpdate,
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
  GitPartialPatchRequest,
  GitRemoteAction,
  GitRecoveryAction,
  GitRecoveryApply,
  GitStashAction,
  GitStashCreate,
  GitSubmoduleAction,
  GitTagAction,
  GithubIssueKind,
  GithubIssueState,
  GithubPullRequestCreate,
  GithubPullRequestLifecycleAction,
  GithubPullRequestLifecycleApply,
  GithubPullRequestReviewAction,
  GithubReleaseCreate,
  GithubProjectCreate,
  GithubRepositoryCreate,
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
  ProjectWorkspaceCreate,
  ProjectWorkspaceUpdate,
  ProjectWorktreeCreate,
  RemoteDesktopTarget,
  ReasoningEffort,
  SkillSettingsContext,
  SkillSettingsDeleteRequest,
  SkillSettingsFileRequest,
  SkillSettingsFileUpdate,
  TerminalServiceConfiguration,
  TaskDraftUpdate,
  TaskOperationStart,
  TaskContinuationStart,
  TaskPlanUpdate,
  TunnelAttachmentCreate,
  BrowserTunnelRequest,
  TunnelUserCreate,
  TunnelUserUpdate,
  UserSettingsUpdate,
  ExplorerFileWrite,
  WorktreePolicy,
  WorkerCredentialRotate,
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
  return policyListSchema.parse(await request("/api/policies"));
}

export async function getPolicy(policyId: string) {
  return policyDetailSchema.parse(
    await request(`/api/policies/${encodeURIComponent(policyId)}`),
  );
}

export async function createPolicy(input: PolicyCreate) {
  return policyDetailSchema.parse(
    await post("/api/policies", policyCreateSchema.parse(input)),
  );
}

export async function createPolicyFromTemplate(
  templateKey: string,
  input: PolicyFromTemplateCreate = {},
) {
  return policyDetailSchema.parse(
    await post(
      `/api/policies/from-template/${encodeURIComponent(templateKey)}`,
      policyFromTemplateCreateSchema.parse(input),
    ),
  );
}

export async function updatePolicy(policyId: string, input: PolicyUpdate) {
  return policyDetailSchema.parse(
    await request(`/api/policies/${encodeURIComponent(policyId)}`, {
      method: "PATCH",
      body: JSON.stringify(policyUpdateSchema.parse(input)),
    }),
  );
}

export async function deletePolicy(policyId: string, rowVersion: number) {
  await request(`/api/policies/${encodeURIComponent(policyId)}`, {
    method: "DELETE",
    body: JSON.stringify(policyDeleteSchema.parse({ rowVersion })),
  });
}

export async function reorderPolicies(input: PolicyOrderUpdate) {
  return policyListSchema.parse(
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
  return policyDetailSchema.parse(
    await post(
      `/api/policies/${encodeURIComponent(policyId)}/reset-template`,
      policyTemplateResetSchema.parse(input),
    ),
  );
}

export async function getWorkspacePolicyAssignments(workspaceId: string) {
  return policyAssignmentListSchema.parse(
    await request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/policies`,
    ),
  );
}

export async function updateWorkspacePolicyAssignments(
  workspaceId: string,
  input: PolicyAssignmentUpdate,
) {
  return policyAssignmentListSchema.parse(
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
  return policyAssignmentListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/policies`),
  );
}

export async function updateProjectPolicyAssignments(
  projectId: string,
  input: PolicyAssignmentUpdate,
) {
  return policyAssignmentListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/policies`, {
      method: "PATCH",
      body: JSON.stringify(policyAssignmentUpdateSchema.parse(input)),
    }),
  );
}

export async function getProjectEffectivePolicies(projectId: string) {
  return effectivePolicyListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/effective-policies`,
    ),
  );
}

export async function getGlobalMcpServers() {
  return mcpServerListSchema.parse(await request("/api/settings/mcp-servers"));
}

export async function createGlobalMcpServer(input: McpServerConfiguration) {
  return mcpServerSummarySchema.parse(
    await post(
      "/api/settings/mcp-servers",
      mcpServerConfigurationSchema.parse(input),
    ),
  );
}

export async function updateGlobalMcpServer(
  serverId: string,
  input: McpServerConfiguration,
) {
  return mcpServerSummarySchema.parse(
    await request(`/api/settings/mcp-servers/${encodeURIComponent(serverId)}`, {
      method: "PUT",
      body: JSON.stringify(mcpServerConfigurationSchema.parse(input)),
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
      modelProviderCreateSchema.parse(input),
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
      body: JSON.stringify(modelProviderUpdateSchema.parse(input)),
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

export async function getProjects() {
  return projectListSchema.parse(await request("/api/projects"));
}

export async function getProjectMcpServers(projectId: string) {
  return mcpServerListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/mcp-servers`),
  );
}

export async function createProjectMcpServer(
  projectId: string,
  input: McpServerConfiguration,
) {
  return mcpServerSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      mcpServerConfigurationSchema.parse(input),
    ),
  );
}

export async function updateProjectMcpServer(
  projectId: string,
  serverId: string,
  input: McpServerConfiguration,
) {
  return mcpServerSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}`,
      {
        method: "PUT",
        body: JSON.stringify(mcpServerConfigurationSchema.parse(input)),
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
  return mcpServerSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers/copy`,
      mcpServerCopySchema.parse(input),
    ),
  );
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

export async function getProjectWorkspaces() {
  return projectWorkspaceListSchema.parse(await request("/api/workspaces"));
}

export async function createProjectWorkspace(input: ProjectWorkspaceCreate) {
  return projectWorkspaceSummarySchema.parse(
    await post("/api/workspaces", projectWorkspaceCreateSchema.parse(input)),
  );
}

export async function updateProjectWorkspace(
  workspaceId: string,
  input: ProjectWorkspaceUpdate,
) {
  return projectWorkspaceSummarySchema.parse(
    await request(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: "PATCH",
      body: JSON.stringify(projectWorkspaceUpdateSchema.parse(input)),
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
  return executionTargetCatalogSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/execution-targets`,
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

export async function createGithubProject(input: GithubProjectCreate) {
  return projectSummarySchema.parse(
    await post("/api/projects/from-github", input),
  );
}

export async function updateProjectWorktreePolicy(
  projectId: string,
  policy: WorktreePolicy,
) {
  return projectSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/worktree-policy`,
      {
        method: "PATCH",
        body: JSON.stringify({ policy }),
      },
    ),
  );
}

export async function updateProjectPreferredWorker(
  projectId: string,
  input: ProjectPreferredWorkerUpdate,
) {
  return projectSummarySchema.parse(
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
  return chatListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/chats`),
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
  return archivedChatListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/archived-chats`,
    ),
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
  return projectTabLayoutSummarySchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/tab-groups`),
  );
}

export async function reorderProjectTabGroups(
  projectId: string,
  revision: number,
  groupIds: string[],
) {
  return projectTabLayoutSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/tab-groups/order`,
      {
        method: "PATCH",
        body: JSON.stringify(tabGroupOrderSchema.parse({ revision, groupIds })),
      },
    ),
  );
}

export async function reorderProjectTabGroupMembers(
  projectId: string,
  groupId: string,
  revision: number,
  tabKeys: string[],
) {
  return projectTabLayoutSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/tab-groups/${encodeURIComponent(groupId)}/members/order`,
      {
        method: "PATCH",
        body: JSON.stringify(
          tabGroupMemberOrderSchema.parse({ revision, tabKeys }),
        ),
      },
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
  return projectTabLayoutSummarySchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/tab-groups/member`,
      {
        method: "PATCH",
        body: JSON.stringify(tabGroupMemberMoveSchema.parse(input)),
      },
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
  return chatSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/chats`, {
      title,
      ...(worktreeId ? { worktreeId } : {}),
      ...(worktreeMode ? { worktreeMode } : {}),
      ...(tabGroupId ? { tabGroupId } : {}),
      ...(target ? { target } : {}),
    }),
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
  return taskCreateResultSchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      title,
      ...(worktreeId ? { worktreeId } : {}),
      ...(worktreeMode ? { worktreeMode } : {}),
      ...(tabGroupId ? { tabGroupId } : {}),
      ...(target ? { target } : {}),
    }),
  );
}

export async function getTask(chatId: string) {
  return taskDetailSchema.parse(
    await request(`/api/tasks/${encodeURIComponent(chatId)}`),
  );
}

export async function getTaskAttachments(chatId: string) {
  return chatAttachmentListSchema.parse(
    await request(`/api/tasks/${encodeURIComponent(chatId)}/attachments`),
  );
}

export async function updateTaskDraft(chatId: string, input: TaskDraftUpdate) {
  return taskDetailSchema.parse(
    await request(`/api/tasks/${encodeURIComponent(chatId)}/draft`, {
      method: "PATCH",
      body: JSON.stringify(taskDraftUpdateSchema.parse(input)),
    }),
  );
}

export async function startTaskPlanning(
  chatId: string,
  input: TaskOperationStart,
) {
  return taskDetailSchema.parse(
    await post(
      `/api/tasks/${encodeURIComponent(chatId)}/plan`,
      taskOperationStartSchema.parse(input),
    ),
  );
}

export async function updateTaskPlan(chatId: string, input: TaskPlanUpdate) {
  return taskDetailSchema.parse(
    await request(`/api/tasks/${encodeURIComponent(chatId)}/plan`, {
      method: "PATCH",
      body: JSON.stringify(taskPlanUpdateSchema.parse(input)),
    }),
  );
}

export async function continueTaskPlanning(
  chatId: string,
  input: TaskContinuationStart,
) {
  return taskDetailSchema.parse(
    await post(
      `/api/tasks/${encodeURIComponent(chatId)}/continue`,
      taskContinuationStartSchema.parse(input),
    ),
  );
}

export async function beginTaskImplementation(
  chatId: string,
  input: TaskContinuationStart,
) {
  return taskDetailSchema.parse(
    await post(
      `/api/tasks/${encodeURIComponent(chatId)}/begin-implementation`,
      taskContinuationStartSchema.parse(input),
    ),
  );
}

export async function retryTaskPlanning(
  chatId: string,
  input: TaskOperationStart,
) {
  return taskDetailSchema.parse(
    await post(
      `/api/tasks/${encodeURIComponent(chatId)}/retry`,
      taskOperationStartSchema.parse(input),
    ),
  );
}

export async function getTerminals(projectId: string) {
  return terminalListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/terminals`),
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
  return terminalSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/terminals`, {
      title,
      ...(worktreeId ? { worktreeId } : {}),
      ...(tabGroupId ? { tabGroupId } : {}),
      ...(target ? { target } : {}),
      ...(directoryPath ? { directoryPath } : {}),
    }),
  );
}

export async function updateTerminalWorktree(
  terminalId: string,
  worktreeId: string,
) {
  return terminalSummarySchema.parse(
    await request(`/api/terminals/${encodeURIComponent(terminalId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify({ worktreeId }),
    }),
  );
}

export async function renameTerminal(terminalId: string, title: string) {
  return terminalSummarySchema.parse(
    await request(`/api/terminals/${encodeURIComponent(terminalId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  );
}

export async function updateTerminalService(
  terminalId: string,
  service: TerminalServiceConfiguration,
) {
  return terminalSummarySchema.parse(
    await request(`/api/terminals/${encodeURIComponent(terminalId)}/service`, {
      method: "PUT",
      body: JSON.stringify(service),
    }),
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
  return explorerListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/explorers`),
  );
}

export async function createExplorer(
  projectId: string,
  title: string,
  worktreeId?: string,
  tabGroupId?: string,
  target?: ExecutionTarget,
) {
  return explorerSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/explorers`, {
      title,
      ...(worktreeId ? { worktreeId } : {}),
      ...(tabGroupId ? { tabGroupId } : {}),
      ...(target ? { target } : {}),
    }),
  );
}

export async function updateExplorerWorktree(
  explorerId: string,
  worktreeId: string,
) {
  return explorerSummarySchema.parse(
    await request(`/api/explorers/${encodeURIComponent(explorerId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify({ worktreeId }),
    }),
  );
}

export async function renameExplorer(explorerId: string, title: string) {
  return explorerSummarySchema.parse(
    await request(`/api/explorers/${encodeURIComponent(explorerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  );
}

export async function updateExplorerViewState(
  explorerId: string,
  input: ExplorerViewStateUpdate,
) {
  const parsed = explorerViewStateUpdateSchema.parse(input);
  return explorerSummarySchema.parse(
    await request(
      `/api/explorers/${encodeURIComponent(explorerId)}/view-state`,
      {
        method: "PATCH",
        body: JSON.stringify(parsed),
      },
    ),
  );
}

export async function deleteExplorer(explorerId: string) {
  await request(`/api/explorers/${encodeURIComponent(explorerId)}`, {
    method: "DELETE",
  });
}

export async function getBrowsers(projectId: string) {
  return browserListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/browsers`),
  );
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
  input: BrowserTunnelRequest,
) {
  return tunnelSummarySchema.parse(
    await post(
      `/api/browsers/${encodeURIComponent(browserId)}/tunnel`,
      browserTunnelRequestSchema.parse(input),
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
  return browserSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/browsers`, {
      title,
      ...(url ? { url } : {}),
      ...(tabGroupId ? { tabGroupId } : {}),
      ...(target ? { target } : {}),
    }),
  );
}

export async function updateBrowser(
  browserId: string,
  input: { title?: string; url?: string },
) {
  return browserSummarySchema.parse(
    await request(`/api/browsers/${encodeURIComponent(browserId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteBrowser(browserId: string) {
  await request(`/api/browsers/${encodeURIComponent(browserId)}`, {
    method: "DELETE",
  });
}

export async function getRemoteDesktops(projectId: string) {
  return remoteDesktopListSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/remote-desktops`,
    ),
  );
}

export async function getRemoteDesktopFleet(projectId: string) {
  return remoteDesktopFleetSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/remote-desktop-fleet`,
    ),
  );
}

export async function getRemoteDesktop(desktopId: string) {
  return remoteDesktopSummarySchema.parse(
    await request(`/api/remote-desktops/${encodeURIComponent(desktopId)}`),
  );
}

export async function createRemoteDesktop(
  projectId: string,
  tabGroupId?: string,
  target?: ExecutionTarget,
  desktopTarget?: RemoteDesktopTarget,
) {
  return remoteDesktopSummarySchema.parse(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/remote-desktops`,
      {
        ...(tabGroupId ? { tabGroupId } : {}),
        ...(target ? { target } : {}),
        ...(desktopTarget ? { desktopTarget } : {}),
      },
    ),
  );
}

export async function updateRemoteDesktopTarget(
  desktopId: string,
  target: RemoteDesktopTarget,
) {
  return remoteDesktopSummarySchema.parse(
    await request(`/api/remote-desktops/${encodeURIComponent(desktopId)}`, {
      method: "PATCH",
      body: JSON.stringify({ target }),
    }),
  );
}

export async function getProjectViews(projectId: string) {
  return projectViewListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/views`),
  );
}

export async function getCodeTabs(projectId: string) {
  return codeTabListSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/code-tabs`),
  );
}

export async function createCodeTab(
  projectId: string,
  title = "Code",
  worktreeId?: string,
  tabGroupId?: string,
  target?: ExecutionTarget,
) {
  return codeTabSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/code-tabs`, {
      title,
      ...(worktreeId ? { worktreeId } : {}),
      ...(tabGroupId ? { tabGroupId } : {}),
      ...(target ? { target } : {}),
    }),
  );
}

export async function updateCodeTab(
  codeTabId: string,
  input: { title?: string; themeMode?: CodeThemeMode },
) {
  return codeTabSummarySchema.parse(
    await request(`/api/code-tabs/${encodeURIComponent(codeTabId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateCodeTabWorktree(
  codeTabId: string,
  worktreeId: string,
) {
  return codeTabSummarySchema.parse(
    await request(`/api/code-tabs/${encodeURIComponent(codeTabId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify({ worktreeId }),
    }),
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
  return codeTabSummarySchema.parse(
    await post(`/api/code-tabs/${encodeURIComponent(codeTabId)}/theme`, {
      themeMode,
      appearance,
    }),
  );
}

export async function createProjectView(
  projectId: string,
  kind: ProjectViewKind,
  title: string,
  worktreeId?: string,
  tabGroupId?: string,
) {
  return projectViewSummarySchema.parse(
    await post(`/api/projects/${encodeURIComponent(projectId)}/views`, {
      kind,
      title,
      ...(worktreeId ? { worktreeId } : {}),
      ...(tabGroupId ? { tabGroupId } : {}),
    }),
  );
}

export async function updateProjectViewWorktree(
  viewId: string,
  worktreeId: string,
) {
  return projectViewSummarySchema.parse(
    await request(`/api/project-views/${encodeURIComponent(viewId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify({ worktreeId }),
    }),
  );
}

export async function renameProjectView(viewId: string, title: string) {
  return projectViewSummarySchema.parse(
    await request(`/api/project-views/${encodeURIComponent(viewId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
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
  return chatSummarySchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  );
}

export async function updateChatWorktree(
  chatId: string,
  input: ChatWorktreeUpdate,
) {
  return chatSummarySchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/worktree`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteChat(chatId: string) {
  await request(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
}

export async function restoreArchivedChat(chatId: string) {
  return chatSummarySchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/restore`, {}),
  );
}

export async function permanentlyDeleteArchivedChat(chatId: string) {
  await request(`/api/chats/${encodeURIComponent(chatId)}/permanent`, {
    method: "DELETE",
  });
}

export async function forkChat(chatId: string, messageId?: string) {
  return chatSummarySchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/fork`, {
      ...(messageId ? { messageId } : {}),
    }),
  );
}

export async function compactChat(chatId: string) {
  return chatCompactAcceptedSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/compact`, {}),
  );
}

export async function getChatGoal(chatId: string) {
  return chatGoalResponseSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/goal`),
  );
}

export async function createChatGoal(chatId: string, input: ChatGoalCreate) {
  return chatGoalResponseSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/goal`,
      chatGoalCreateSchema.parse(input),
    ),
  );
}

export async function updateChatGoal(chatId: string, input: ChatGoalUpdate) {
  return chatGoalResponseSchema.parse(
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
  return chatPlanStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/plan`),
  );
}

export async function updateChatPlan(chatId: string, input: ChatPlanUpdate) {
  return chatPlanStateSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/plan`, {
      method: "PATCH",
      body: JSON.stringify(chatPlanUpdateSchema.parse(input)),
    }),
  );
}

export async function answerChatPlan(chatId: string, input: ChatPlanAnswer) {
  return chatPlanAcceptedSchema.parse(
    await post(
      `/api/chats/${encodeURIComponent(chatId)}/plan/answer`,
      chatPlanAnswerSchema.parse(input),
    ),
  );
}

export async function syncChat(chatId: string) {
  return agentThreadSyncSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/sync`, {}),
  );
}

export async function createChatConsole(chatId: string) {
  return terminalSummarySchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/console`, {}),
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
  return agentInteractionRequestListSchema.parse(
    await request(`/api/agent-requests${suffix}`),
  );
}

export async function respondToAgentInteractionRequest(
  requestId: string,
  input: AgentInteractionResolutionCreate,
) {
  return agentInteractionRequestSchema.parse(
    await post(
      `/api/agent-requests/${encodeURIComponent(requestId)}/respond`,
      agentInteractionResolutionCreateSchema.parse(input),
    ),
  );
}

export async function reorderProjects(ids: string[]) {
  await request("/api/projects/order", {
    method: "PATCH",
    body: JSON.stringify(orderedIdsSchema.parse({ ids })),
  });
}

export async function getMessages(chatId: string) {
  return chatMessageListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/messages`),
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
  return chatSummarySchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/model`, {
      method: "PATCH",
      body: JSON.stringify({ modelId }),
    }),
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
  attachmentIds: string[] = [],
  mode: ChatTurnMode = "default",
  reasoningEffort: ReasoningEffort | null = null,
) {
  return chatPromptSubmitResultSchema.parse(
    await post(`/api/chats/${encodeURIComponent(chatId)}/turns`, {
      text,
      attachmentIds,
      mode,
      modelId,
      reasoningEffort,
      idempotencyKey: crypto.randomUUID(),
    }),
  );
}

export async function getQueuedPrompts(chatId: string) {
  return queuedPromptListSchema.parse(
    await request(`/api/chats/${encodeURIComponent(chatId)}/queue`),
  );
}

export async function updateQueuedPrompt(
  promptId: string,
  input: {
    attachmentIds?: string[];
    text?: string;
    mode?: ChatTurnMode;
    reasoningEffort?: ReasoningEffort | null;
    frozen?: boolean;
  },
) {
  return queuedPromptSchema.parse(
    await request(`/api/queued-prompts/${encodeURIComponent(promptId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function uploadChatAttachment(
  chatId: string,
  file: File,
  kind: ChatAttachmentKind,
  source: ChatAttachmentSource,
) {
  const response = await requestResponse(
    `/api/chats/${encodeURIComponent(chatId)}/attachments`,
    {
      method: "POST",
      body: file,
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/octet-stream",
        "x-cantrip-attachment-kind": kind,
        "x-cantrip-attachment-source": source,
        "x-cantrip-file-name": encodeURIComponent(file.name),
        "x-cantrip-mime-type": file.type || "application/octet-stream",
      },
    },
  );
  return chatAttachmentSummarySchema.parse(await response.json());
}

export async function deleteChatAttachment(attachmentId: string) {
  await request(`/api/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
}

export function chatAttachmentContentUrl(attachmentId: string): string {
  return `${getActiveServerUrl()}/api/attachments/${encodeURIComponent(attachmentId)}/content`;
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
  return chatPromptSteerResultSchema.parse(
    await post(`/api/queued-prompts/${encodeURIComponent(promptId)}/steer`, {}),
  );
}
