import { z } from "zod";

import {
  decodeJsonMessage,
  encodeJsonMessage,
  type JsonMessageDecodeResult,
} from "./json-message.js";
import {
  codeSettingsProfileIdSchema,
  codeSettingsResolutionSchema,
  codeSettingsWorkerStatusSchema,
} from "./code-settings.js";
import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  eliteRevealConfigSchema,
} from "./elite.js";

export * from "./json-message.js";

export * from "./communication-content.js";
export * from "./model-configuration.js";
export * from "./attachment-content.js";
export * from "./explorer.js";
export * from "./surface-stream.js";
export * from "./repository-operation.js";
export * from "./endpoint-content.js";
export * from "./workflow-content.js";
export * from "./customization-content.js";
export * from "./tunnel-content.js";
export * from "./client-control-content.js";
export * from "./code-settings.js";
export * from "./resource-usage.js";
export * from "./elite.js";

import { endpointContentOpaqueSchema } from "./endpoint-content.js";
import {
  customizationContentScopeSchema,
  protectedCustomizationRequestSchema,
} from "./customization-content.js";
import {
  protectedTunnelContentRecordSchema,
  tunnelContentErrorCodeSchema,
  tunnelPublicDestinationEndpointSchema,
  tunnelPublicSourceEndpointSchema,
} from "./tunnel-content.js";

import {
  chatPlanOpaqueStateSchema,
  chatMessageOpaqueContentSchema,
  chatMessageOpaqueSummarySchema,
  encryptedInteractionResponseContentSchema,
  interactionProtectedClassificationSchema,
  interactionRequestOpaqueContentSchema,
  interactionResponseOpaqueContentSchema,
  queuedPromptOpaqueContentSchema,
} from "./communication-content.js";
import { modelConfigurationSchema } from "./model-configuration.js";
import {
  attachmentChunkOpaqueSchema,
  attachmentProtectedMetadataSchema,
  chatAttachmentKindSchema,
  chatAttachmentListSchema,
  chatAttachmentOpaqueListSchema,
  chatAttachmentOpaqueSummarySchema,
  chatAttachmentSourceSchema,
  chatAttachmentSummarySchema,
} from "./attachment-content.js";
import {
  explorerDirectoryCommitsSchema,
  explorerDirectoryCommitEntrySchema,
  explorerDirectorySchema,
  explorerEntryDeleteSchema,
  explorerEntryMutationResultSchema,
  explorerEntryNameSchema,
  explorerEntryRenameSchema,
  explorerEntrySchema,
  explorerFileSchema,
  explorerFileWriteSchema,
  explorerLastCommitSchema,
  explorerMediaFileChunkSchema,
  explorerMediaFileSchema,
  explorerMediaKindSchema,
} from "./explorer.js";
import {
  standaloneChatFileOperationIntentSchema,
  surfaceStreamOpaqueSchema,
  surfaceStreamWireRequestSchema,
} from "./surface-stream.js";
import {
  repositoryOperationOpaqueSchema,
  repositoryOperationWireRequestSchema,
  repositoryRoutingHandleSchema,
} from "./repository-operation.js";
import {
  runConfigurationCapabilitiesWorkerCommandSchema,
  runConfigurationDefinitionChangeNotificationSchema,
  runConfigurationDeleteResponseSchema,
  runConfigurationDetectWorkerCommandSchema,
  runConfigurationDetectResponseSchema,
  runConfigurationDeleteWorkerCommandSchema,
  runConfigurationFlutterDevicesWorkerCommandSchema,
  runConfigurationGetResponseSchema,
  runConfigurationGetWorkerCommandSchema,
  runConfigurationListResponseSchema,
  runConfigurationListWorkerCommandSchema,
  runConfigurationPathsWorkerCommandSchema,
  runConfigurationValidateWorkerCommandSchema,
  runConfigurationWriteResponseSchema,
  runConfigurationWriteWorkerCommandSchema,
} from "./run-configuration-operations.js";
import {
  runConfigurationRuntimeOperationResultSchema,
  runConfigurationRuntimeOutputSchema,
  runConfigurationRuntimeOutputWorkerCommandSchema,
  runConfigurationRuntimeReconcileWorkerCommandSchema,
  runConfigurationRuntimeRestartWorkerCommandSchema,
  runConfigurationRuntimeStatusResultSchema,
  runConfigurationRuntimeStartWorkerCommandSchema,
  runConfigurationRuntimeStatusWorkerCommandSchema,
  runConfigurationRuntimeStopWorkerCommandSchema,
  runConfigurationRuntimeWorkerNotificationSchema,
} from "./run-configuration-runtime.js";
import {
  runConfigurationFileSchema,
  runConfigurationIdSchema,
  runConfigurationProviderKindSchema,
  runConfigurationRevisionSchema,
  runConfigurationSecretReferenceSchema,
} from "./run-configuration-definitions.js";
import {
  runConfigurationSecretSetResultSchema,
  runConfigurationSecretValueContentSchema,
} from "./run-configuration-secrets.js";

import {
  directBrokerAdvertisementSchema,
  directCapabilityPrepareCommandSchema,
  directCapabilityRenewCommandSchema,
  directCapabilityRevokeCommandSchema,
  unavailableDirectBroker,
} from "./direct-data-plane.js";

export * from "./direct-data-plane.js";

import { tunnelDataPlaneCloseCodeSchema } from "./tunnel-data-plane.js";
import {
  workerLinkGrantInstallCommandSchema,
  workerLinkGrantRenewCommandSchema,
  workerLinkGrantRevokeCommandSchema,
  workerLinkIdentityResolveCommandSchema,
  workerLinkPeerCandidateNotificationSchema,
  workerLinkPeerSessionInstallCommandSchema,
  workerLinkPeerSessionRenewCommandSchema,
  workerLinkPeerSessionRevokeCommandSchema,
  workerLinkPeerSignalCommandSchema,
  workerLinkPeerSignalNotificationSchema,
  workerLinkSessionInstallCommandSchema,
  workerLinkSessionRenewCommandSchema,
  workerLinkSessionRouteCommandSchema,
  workerLinkSessionRevokeCommandSchema,
} from "./worker-link.js";

export * from "./tunnel-data-plane.js";
export * from "./worker-link.js";

import { clientControlResultStatusSchema } from "./live.js";

export * from "./live.js";

export * from "./policies.js";

export * from "./tasks.js";

export * from "./task-scheduling.js";

export * from "./audiences.js";

export * from "./encryption.js";
export * from "./protected-secrets.js";
export * from "./run-configuration-secrets.js";

export * from "./private-labels.js";
export * from "./surface-private-state.js";

import {
  effectivePolicyWireListSchema,
  policyCliListResultSchema,
  policyCliReadResultSchema,
  policyKeySchema,
  standalonePolicyWireListSchema,
} from "./policies.js";
import {
  taskGoalSyncContextSchema,
  taskGoalObjectiveOpaqueSnapshotSchema,
  taskGoalWorkerResultSchema,
  taskMessageOpaqueContentSchema,
  taskMessageOpaqueSummarySchema,
  taskMessageRelayResultSchema,
  taskOpaqueContentSchema,
  taskOpaqueSummarySchema,
  taskOperationPrepareRequestSchema,
  taskOperationRelayGoalSchema,
  taskOperationRelayRequestSchema,
} from "./tasks.js";
import {
  taskDispatchWorkerLeaseSchema,
  taskPrioritySchema,
} from "./task-scheduling.js";
import {
  encryptedPayloadEnvelopeSchema,
  encryptionKeyBytesSchema,
  unavailableWorkerEncryptionStatus,
  workerEncryptionRefreshRequestSchema,
  workerEncryptionStatusSchema,
} from "./encryption.js";
import {
  mcpServerOpaqueRuntimeSchema,
  providerCredentialProtectedContentSchema,
  providerCredentialPublicMetadataSchema,
  protectedProviderCredentialSchema,
  protectedSecretEnvelopeSchema,
} from "./protected-secrets.js";
import { resourceAudienceSchema } from "./audiences.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import {
  browserPrivateStateOpaqueSchema,
  explorerPrivateStateOpaqueSchema,
  remoteDesktopPrivateInventoryOpaqueSchema,
  remoteDesktopPrivateStateOpaqueSchema,
  terminalPrivateStateOpaqueSchema,
} from "./surface-private-state.js";

import { projectAutomationOpaqueContentSchema } from "./automations.js";
import {
  protectedWorkflowGateDecisionRequestSchema,
  protectedWorkflowNodeExecutionRequestSchema,
  protectedWorkflowTriggerPrepareRequestSchema,
  workflowJsonObjectSchema,
  workflowNodeExecutionResultSchema,
  workflowRepositoryDocumentSchema,
} from "./workflows.js";

import {
  remoteSurfaceProtocolVersionSchema,
  remoteSurfaceKindSchema,
  remoteSurfaceTransportSchema,
  remoteSurfaceStatusSchema,
  remoteSurfaceChannelSchema,
  remoteSurfaceCapabilitiesSchema,
  codeCapabilitiesSchema,
  unavailableCodeCapabilities,
  remoteSurfaceWebRtcConfigurationSchema,
  defaultRemoteSurfaceCapabilities,
  NATIVE_SUBAGENT_PROTOCOL_VERSION,
  codexRuntimeReportSchema,
  unprobedCodexRuntimeReport,
} from "./runtime-capabilities.js";

export {
  remoteSurfaceProtocolVersionSchema,
  remoteSurfaceKindSchema,
  remoteSurfaceTransportSchema,
  remoteSurfaceIceTransportPolicySchema,
  remoteSurfaceStatusSchema,
  remoteSurfaceChannelSchema,
  remoteSurfaceCapabilitiesSchema,
  codeTransportSchema,
  codeSharedTransportProtocolVersionSchema,
  codeCapabilitiesSchema,
  unavailableCodeCapabilities,
  remoteSurfaceIceServerSchema,
  remoteSurfaceWebRtcConfigurationSchema,
  remoteSurfaceWebRtcSignalSchema,
  codexRuntimeMethodStateSchema,
  codexRuntimeFeatureStageSchema,
  codexRuntimeFeatureSchema,
  NATIVE_SUBAGENT_PROTOCOL_VERSION,
  nativeSubagentRuntimeCapabilitySchema,
  nativeSubagentCapabilityCompatible,
  unavailableNativeSubagentRuntimeCapability,
  codexRuntimeReportSchema,
  unprobedCodexRuntimeReport,
} from "./runtime-capabilities.js";

export type {
  RemoteSurfaceKind,
  RemoteSurfaceTransport,
  RemoteSurfaceStatus,
  RemoteSurfaceChannel,
  RemoteSurfaceCapabilities,
  RemoteSurfaceIceServer,
  RemoteSurfaceWebRtcConfiguration,
  RemoteSurfaceWebRtcSignal,
  CodeTransport,
  CodeSharedTransportProtocolVersion,
  CodeCapabilities,
  CodexRuntimeMethodState,
  CodexRuntimeFeatureStage,
  CodexRuntimeFeature,
  NativeSubagentRuntimeCapability,
  CodexRuntimeReport,
} from "./runtime-capabilities.js";

import { databaseEngineSchema } from "./protocol-core.js";

export {
  protocolVersionSchema,
  cantripVersionSchema,
  databaseEngineSchema,
  deploymentModeSchema,
  bootstrapModeSchema,
  authModeSchema,
  authenticationStateSchema,
  userRoleSchema,
  userSummarySchema,
  accountRegistrationSchema,
  accountLicenseWhitelistEntrySchema,
  accountLicenseWhitelistCreateSchema,
  accountAdminSummarySchema,
  authLoginSchema,
  authReauthenticationSchema,
  authReauthenticationResultSchema,
  authSessionSchema,
  authSessionStateSchema,
  mobileSignInGrantCreateResultSchema,
  mobileSignInGrantExchangeSchema,
  mobileSignInQrPayloadSchema,
  authLogoutAllResultSchema,
  accountSessionSummarySchema,
  accountSessionListSchema,
  auditEventSchema,
  auditEventListSchema,
  auditEventQuerySchema,
  serverBootstrapSchema,
  desktopUpdateActiveWorkSummarySchema,
} from "./protocol-core.js";

export type {
  DatabaseEngine,
  DeploymentMode,
  BootstrapMode,
  AuthMode,
  AuthenticationState,
  UserRole,
  UserSummary,
  AccountSessionSummary,
  AuditEvent,
  AuditEventList,
  AuditEventQuery,
  AccountRegistration,
  AccountLicenseWhitelistEntry,
  AccountLicenseWhitelistCreate,
  AccountAdminSummary,
  AuthLogin,
  AuthReauthentication,
  AuthReauthenticationResult,
  AuthSession,
  AuthSessionState,
  MobileSignInGrantCreateResult,
  MobileSignInGrantExchange,
  MobileSignInQrPayload,
  AuthLogoutAllResult,
  ServerBootstrap,
  DesktopUpdateActiveWorkSummary,
  CantripVersion,
} from "./protocol-core.js";

import {
  managedWebRuntimeActionRequestSchema,
  codeGraphProjectStatusSchema,
} from "./worker-capabilities.js";

export {
  projectReplicaCapabilitiesSchema,
  unavailableProjectReplicaCapabilities,
  managedFolderCapabilitiesSchema,
  unavailableManagedFolderCapabilities,
  standaloneChatScratchCapabilitiesSchema,
  standaloneChatFileCapabilitiesSchema,
  standaloneChatCapabilitiesSchema,
  unavailableStandaloneChatCapabilities,
  codeGraphRuntimeStateSchema,
  codeGraphProjectStateSchema,
  codeGraphProjectCountsSchema,
  codeGraphWorkerStatusSchema,
  unavailableCodeGraphWorkerStatus,
  managedWebRuntimeComponentSchema,
  managedWebRuntimePlatformSchema,
  managedWebRuntimeArchitectureSchema,
  managedWebRuntimeArchiveFormatSchema,
  managedWebRuntimeArtifactSchema,
  managedWebRuntimeReleaseManifestSchema,
  managedWebRuntimeStateSchema,
  managedWebRuntimeProgressPhaseSchema,
  managedWebRuntimeProgressSchema,
  managedWebRuntimeFailureCategorySchema,
  managedWebRuntimeFailureSchema,
  managedWebRuntimeStatusSchema,
  managedWebRuntimeCapabilitiesSchema,
  managedWebRuntimeActionSchema,
  managedWebRuntimeActionRequestSchema,
  managedWebRuntimeActionResultSchema,
  unavailableManagedWebRuntimeCapabilities,
  codeGraphJobSchema,
  codeGraphProjectStatusSchema,
  codeGraphActionAcknowledgementSchema,
} from "./worker-capabilities.js";

export type {
  ProjectReplicaCapabilities,
  ManagedFolderCapabilities,
  StandaloneChatScratchCapabilities,
  StandaloneChatFileCapabilities,
  StandaloneChatCapabilities,
  CodeGraphWorkerStatus,
  ManagedWebRuntimeComponent,
  ManagedWebRuntimeArtifact,
  ManagedWebRuntimeReleaseManifest,
  ManagedWebRuntimeProgress,
  ManagedWebRuntimeFailure,
  ManagedWebRuntimeStatus,
  ManagedWebRuntimeCapabilities,
  ManagedWebRuntimeAction,
  ManagedWebRuntimeActionRequest,
  ManagedWebRuntimeActionResult,
  CodeGraphProjectStatus,
  CodeGraphActionAcknowledgement,
} from "./worker-capabilities.js";

import { workerCredentialSecretSchema } from "./workers.js";

export {
  workerHeartbeatSchema,
  workerSummarySchema,
  workerListSchema,
  workerManagementSourceSchema,
  workerManagementSummarySchema,
  workerManagementListSchema,
  workerUpdateSchema,
  workerRestartAcknowledgementSchema,
  workerRestartResultSchema,
  workerCredentialScopeSchema,
  workerCredentialScopes,
  workerEnrollmentCodeCreateSchema,
  workerEnrollmentCodeResultSchema,
  workerEnrollmentCodeStatusSchema,
  workerCredentialSummarySchema,
  workerCredentialListSchema,
  workerEnrollmentExchangeSchema,
  workerEnrollmentResultSchema,
  workerCredentialRotateSchema,
  workerCredentialRotateResultSchema,
} from "./workers.js";

export type {
  WorkerHeartbeat,
  WorkerSummary,
  WorkerManagementSource,
  WorkerManagementSummary,
  WorkerUpdate,
  WorkerRestartResult,
  WorkerCredentialScope,
  WorkerEnrollmentCodeCreate,
  WorkerEnrollmentCodeResult,
  WorkerEnrollmentCodeStatus,
  WorkerCredentialSummary,
  WorkerEnrollmentExchange,
  WorkerEnrollmentResult,
  WorkerCredentialRotate,
  WorkerCredentialRotateResult,
} from "./workers.js";

export {
  skillSummarySchema,
  skillListSchema,
  customizationCapabilitySchema,
  nativeSubagentCustomizationCapabilitySchema,
  codexCustomizationCapabilitiesSchema,
  codexSkillInventoryItemSchema,
  codexInventoryErrorSchema,
  codexHookInventoryItemSchema,
  codexMcpToolSchema,
  codexMcpResourceSchema,
  codexMcpResourceTemplateSchema,
  codexMcpServerSchema,
  codexCustomizationInventorySchema,
  codexExternalImportItemTypeSchema,
  codexExternalImportPreviewItemSchema,
  codexExternalImportPreviewSchema,
  codexMcpResourceContentSchema,
  codexMcpResourceReadSchema,
  codexMcpResourceReadRequestSchema,
  codexSkillConfigUpdateSchema,
  codexSkillConfigResultSchema,
  codexSkillRootsUpdateSchema,
  codexSkillRootsResultSchema,
  skillSettingsLocationSchema,
  skillSettingsItemSchema,
  skillSettingsErrorSchema,
  skillSettingsInventorySchema,
  skillSettingsFileSchema,
  skillSettingsDocumentSchema,
  skillSettingsContextSchema,
  skillAudienceSummarySchema,
  skillAudienceListSchema,
  skillAudienceContextSchema,
  skillAudienceUpdateSchema,
  skillSettingsFileRequestSchema,
  skillSettingsFileUpdateSchema,
  skillSettingsDeleteRequestSchema,
  skillSettingsMutationResultSchema,
  codexMcpOauthStartSchema,
  codexMcpOauthStartResultSchema,
  codexMcpOauthStatusSchema,
  codexMcpReloadResultSchema,
  codexMcpReloadRequestSchema,
  codexExternalImportApplySchema,
  codexExternalImportFailureSchema,
  codexExternalImportTypeResultSchema,
  codexExternalImportStatusSchema,
  mentionedSkillNames,
} from "./customization.js";

export type {
  SkillSummary,
  CustomizationCapability,
  CodexCustomizationCapabilities,
  CodexSkillInventoryItem,
  CodexHookInventoryItem,
  CodexMcpServer,
  CodexCustomizationInventory,
  CodexExternalImportPreviewItem,
  CodexExternalImportPreview,
  CodexMcpResourceRead,
  CodexMcpResourceReadRequest,
  CodexSkillConfigUpdate,
  CodexSkillConfigResult,
  CodexSkillRootsUpdate,
  CodexSkillRootsResult,
  SkillSettingsLocation,
  SkillSettingsItem,
  SkillSettingsInventory,
  SkillSettingsFile,
  SkillSettingsDocument,
  SkillSettingsContext,
  SkillSettingsFileRequest,
  SkillSettingsFileUpdate,
  SkillSettingsDeleteRequest,
  SkillSettingsMutationResult,
  SkillAudienceSummary,
  SkillAudienceContext,
  SkillAudienceUpdate,
  CodexMcpOauthStart,
  CodexMcpOauthStartResult,
  CodexMcpOauthStatus,
  CodexMcpReloadResult,
  CodexExternalImportApply,
  CodexExternalImportTypeResult,
  CodexExternalImportStatus,
} from "./customization.js";

export {
  operationalProbeSchema,
  serverOperationalStatsSchema,
  systemHealthSchema,
} from "./operational-health.js";

export type { SystemHealth, OperationalProbe } from "./operational-health.js";

import {
  modelProviderKindSchema,
  providerWeeklyUsageSchema,
  providerAuthStatusObservationSchema,
  reasoningEffortSchema,
  modelReasoningEffortOptionSchema,
  providerModelCatalogEntrySchema,
  detailedTokenUsageTotalsSchema,
  agentTimeSummarySchema,
} from "./providers.js";

export {
  modelProviderKindSchema,
  ZAI_CODING_PLAN_BASE_URL,
  isZaiCodingPlanBaseUrl,
  providerWeeklyUsageSchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  providerAuthLifecycleStateSchema,
  providerAuthFailureCodeSchema,
  providerAuthSafeStatusSchema,
  providerAuthStatusObservationSchema,
  providerAuthLiveStatusSchema,
  providerAccessTokenLeaseRequestSchema,
  providerAccessTokenLeaseSchema,
  providerLegacyCredentialSchema,
  providerLegacyCredentialCaptureResultSchema,
  providerLegacyCredentialPurgeResultSchema,
  normalizeResponsesBaseUrl,
  reasoningEffortSchema,
  modelReasoningEffortOptionSchema,
  providerModelMetadataSourceSchema,
  providerModelCatalogEntrySchema,
  providerModelAvailabilityStateSchema,
  providerModelAvailabilitySchema,
  providerCatalogSyncStatusSchema,
  providerCatalogSyncStateSchema,
  providerModelCatalogResultSchema,
  providerConnectionTestStageSchema,
  providerConnectionTestResultSchema,
  workerProviderConnectionTestResultSchema,
  modelProviderAccountWorkerSchema,
  providerCredentialStateSchema,
  PROVIDER_REAUTH_REQUIRED_ERROR_CODE,
  PROVIDER_REAUTH_REQUIRED_MESSAGE,
  modelProviderAccountSummarySchema,
  modelProviderAccountListSchema,
  modelProviderAccountCreateSchema,
  modelProviderAccountUpdateSchema,
  encryptedModelProviderAccountCreateSchema,
  encryptedModelProviderAccountUpdateSchema,
  modelProviderAccountWireSummarySchema,
  modelProviderAccountWireListSchema,
  tokenUsageTotalsSchema,
  detailedTokenUsageTotalsSchema,
  agentTimeSummarySchema,
  modelProviderCreateSchema,
  modelProviderUpdateSchema,
  encryptedModelProviderCreateSchema,
  encryptedModelProviderUpdateSchema,
  modelProviderSummarySchema,
  modelProviderListSchema,
  modelProviderWireSummarySchema,
  modelProviderWireListSchema,
  modelRouteInputSchema,
  modelRouteSummarySchema,
  modelProfileCreateSchema,
  modelProfileUpdateSchema,
  modelProfileSummarySchema,
  modelProfileListSchema,
} from "./providers.js";

export type {
  ModelProviderKind,
  ProviderWeeklyUsage,
  CodexAuthStatus,
  CodexDeviceLogin,
  ProviderAuthFailureCode,
  ProviderAuthLifecycleState,
  ProviderAuthLiveStatus,
  ProviderAuthSafeStatus,
  ProviderAuthStatusObservation,
  ProviderAccessTokenLeaseRequest,
  ProviderAccessTokenLease,
  ProviderLegacyCredential,
  ProviderLegacyCredentialCaptureResult,
  ProviderLegacyCredentialPurgeResult,
  ReasoningEffort,
  ModelReasoningEffortOption,
  ProviderModelMetadataSource,
  ProviderModelCatalogEntry,
  ProviderModelAvailability,
  ProviderModelAvailabilityState,
  ProviderCatalogSyncState,
  ProviderCatalogSyncStatus,
  ProviderModelCatalogResult,
  ProviderConnectionTestStage,
  ProviderConnectionTestResult,
  WorkerProviderConnectionTestResult,
  ModelProviderAccountWorker,
  ModelProviderAccountSummary,
  ModelProviderAccountCreate,
  ModelProviderAccountUpdate,
  EncryptedModelProviderAccountCreate,
  EncryptedModelProviderAccountUpdate,
  ModelProviderAccountWireSummary,
  TokenUsageTotals,
  DetailedTokenUsageTotals,
  AgentTimeSummary,
  ModelProviderCreate,
  ModelProviderUpdate,
  EncryptedModelProviderCreate,
  EncryptedModelProviderUpdate,
  ModelProviderSummary,
  ModelProviderWireSummary,
  ModelRouteInput,
  ModelRouteSummary,
  ModelProfileCreate,
  ModelProfileUpdate,
  ModelProfileSummary,
} from "./providers.js";

export {
  MCP_SECRET_MASK,
  MANAGED_CODEGRAPH_MCP_NAME,
  MANAGED_CANTRIP_MCP_NAME,
  isManagedCodeGraphMcpName,
  isManagedCantripMcpName,
  isManagedMcpName,
  mcpServerNameSchema,
  mcpServerStdioConfigurationSchema,
  mcpServerHttpConfigurationSchema,
  mcpServerConfigurationSchema,
  encryptedMcpServerCreateSchema,
  encryptedMcpServerUpdateSchema,
  mcpServerDiscoverySourceSchema,
  mcpServerDiscoveryScopeSchema,
  mcpServerDiscoveryCandidateSchema,
  mcpServerDiscoveryIssueSchema,
  mcpServerDiscoveryResultSchema,
  mcpServerScopeSchema,
  mcpServerSummarySchema,
  mcpServerListSchema,
  mcpServerWireSummarySchema,
  mcpServerWireListSchema,
  mcpServerCopySchema,
} from "./mcp-configurations.js";

export type {
  McpServerConfiguration,
  McpServerScope,
  McpServerSummary,
  EncryptedMcpServerCreate,
  EncryptedMcpServerUpdate,
  McpServerDiscoverySource,
  McpServerDiscoveryScope,
  McpServerDiscoveryCandidate,
  McpServerDiscoveryIssue,
  McpServerDiscoveryResult,
  McpServerWireSummary,
  McpServerCopy,
} from "./mcp-configurations.js";

import { DEFAULT_PERMISSION_PROFILE_ID } from "./settings.js";

export {
  themePreferenceSchema,
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  sidebarWidthPreferenceSchema,
  mobileProjectTabConfigurationsSchema,
  DEFAULT_PERMISSION_PROFILE_ID,
  configurablePermissionProfileIdSchema,
  userSettingsSchema,
  userSettingsUpdateSchema,
  appModeSchema,
  appDestinationSchema,
  appDestinationUpdateSchema,
  settingsBundleSchema,
  settingsBundleWireSchema,
} from "./settings.js";

export type {
  ThemePreference,
  MobileProjectTabConfigurations,
  UserSettings,
  UserSettingsUpdate,
  AppMode,
  AppDestination,
  AppDestinationUpdate,
  SettingsBundle,
  SettingsBundleWire,
} from "./settings.js";

import {
  githubRepositorySchema,
  githubRepositoryCreateSchema,
  githubIssueStateSchema,
  githubIssueKindSchema,
  githubIssueCreateSchema,
  githubIssueCommentCreateSchema,
  githubPullRequestCreateSchema,
  githubPullRequestReviewSubmitSchema,
  githubPullRequestInlineCommentCreateSchema,
  githubPullRequestLifecycleActionSchema,
  githubPullRequestLifecycleApplySchema,
  githubReleaseCreateSchema,
} from "./github.js";

export {
  githubAuthStatusSchema,
  githubRepositorySchema,
  githubRepositoryListSchema,
  githubRepositoryOwnerSchema,
  githubRepositoryOwnerListSchema,
  githubRepositoryVisibilitySchema,
  githubRepositoryCreateSchema,
  githubIssueStateSchema,
  githubIssueKindSchema,
  githubIssueLabelSchema,
  githubIssueSummarySchema,
  githubIssueListSchema,
  githubIssueCommentSchema,
  githubIssueDetailSchema,
  githubIssueCreateSchema,
  githubIssueCommentCreateSchema,
  githubIssueCloseSchema,
  githubPullRequestCreateSchema,
  githubPullRequestSummarySchema,
  githubPullRequestListSchema,
  githubPullRequestCreateResultSchema,
  githubPullRequestCommitSchema,
  githubPullRequestFileSchema,
  githubPullRequestCheckSchema,
  githubPullRequestReviewSchema,
  githubPullRequestReviewCommentSchema,
  githubPullRequestReviewThreadSchema,
  githubPullRequestReviewSubmitSchema,
  githubPullRequestInlineCommentCreateSchema,
  githubPullRequestReviewActionSchema,
  githubPullRequestLifecycleActionSchema,
  githubPullRequestLifecyclePreviewSchema,
  githubPullRequestLifecycleApplySchema,
  githubPullRequestCheckoutPreparedSchema,
  githubPullRequestDetailSchema,
  githubReleaseSummarySchema,
  githubReleaseListSchema,
  githubReleaseCreateSchema,
} from "./github.js";

export type {
  GithubAuthStatus,
  GithubRepository,
  GithubRepositoryOwner,
  GithubRepositoryVisibility,
  GithubRepositoryCreate,
  GithubIssueState,
  GithubIssueKind,
  GithubIssueSummary,
  GithubIssueList,
  GithubPullRequestList,
  GithubIssueComment,
  GithubIssueDetail,
  GithubIssueCreate,
  GithubPullRequestCreate,
  GithubPullRequestSummary,
  GithubPullRequestCreateResult,
  GithubPullRequestCommit,
  GithubPullRequestFile,
  GithubPullRequestCheck,
  GithubPullRequestReview,
  GithubPullRequestReviewComment,
  GithubPullRequestReviewThread,
  GithubPullRequestReviewSubmit,
  GithubPullRequestInlineCommentCreate,
  GithubPullRequestReviewAction,
  GithubPullRequestLifecycleAction,
  GithubPullRequestLifecyclePreview,
  GithubPullRequestLifecycleApply,
  GithubPullRequestCheckoutPrepared,
  GithubPullRequestDetail,
  GithubReleaseSummary,
  GithubReleaseList,
  GithubReleaseCreate,
} from "./github.js";

import { projectRootKindSchema } from "./project-foundation.js";

export {
  projectOriginKindSchema,
  projectFolderManagementSchema,
  projectSourceKindSchema,
  projectRootKindSchema,
  projectCapabilitiesSchema,
  projectCapabilitySchema,
  projectCapabilityUnavailableErrorSchema,
  projectCapabilitiesForOriginKind,
} from "./project-foundation.js";

export type {
  ProjectOriginKind,
  ProjectFolderManagement,
  ProjectSourceKind,
  ProjectRootKind,
  ProjectCapabilities,
  ProjectCapability,
  ProjectCapabilityUnavailableError,
} from "./project-foundation.js";

import {
  projectGithubConversionRepositorySchema,
  projectGithubRoutingRepositorySchema,
  projectGithubWireRepositorySchema,
  projectReplicaPlacementRequestSchema,
  projectReplicaPlacementResultSchema,
  projectReplicaJobErrorSchema,
  projectReplicaJobProgressEventSchema,
  gitObjectRevisionSchema,
  projectReplicaSynchronizationPolicySchema,
} from "./projects.js";

export {
  projectGithubConversionRepositorySchema,
  projectGithubRoutingRepositorySchema,
  projectGithubWireRepositorySchema,
  projectReplicaPlacementModeSchema,
  projectReplicaPlacementRequestSchema,
  encryptedProjectReplicaPlacementRequestSchema,
  projectReplicaMaterializationSchema,
  projectReplicaOwnershipKindSchema,
  projectReplicaPlacementResultSchema,
  githubProjectCreateSchema,
  encryptedGithubProjectCreateSchema,
  managedFolderProjectCreateSchema,
  encryptedManagedFolderProjectCreateSchema,
  projectWorkspaceCreateSchema,
  projectWorkspaceUpdateSchema,
  encryptedProjectWorkspaceNameSchema,
  systemDefaultProjectWorkspaceNameSchema,
  projectWorkspaceWireSummarySchema,
  projectWorkspaceWireListSchema,
  encryptedProjectWorkspaceCreateSchema,
  encryptedProjectWorkspaceUpdateSchema,
  projectWorkspaceSummarySchema,
  projectWorkspaceListSchema,
  projectSourceSummarySchema,
  projectReplicaSummarySchema,
  projectReplicaListSchema,
  projectReplicaJobKindSchema,
  projectReplicaJobStateSchema,
  projectReplicaJobErrorCodeSchema,
  projectReplicaJobErrorSchema,
  projectReplicaJobProgressStageSchema,
  projectReplicaJobProgressSchema,
  projectReplicaJobProgressEventSchema,
  projectReplicaJobSummarySchema,
  projectReplicaJobListSchema,
  projectReplicaProvisionCreateSchema,
  encryptedProjectReplicaProvisionCreateSchema,
  projectReplicaSynchronizationPolicySchema,
  projectReplicaSynchronizeCreateSchema,
  encryptedProjectReplicaSynchronizeCreateSchema,
  projectReplicaRemoveCreateSchema,
  encryptedProjectReplicaRemoveCreateSchema,
  projectReplicaJobRetrySchema,
  projectReplicaJobCancelSchema,
  projectSetupStatusSchema,
  projectSummarySchema,
  projectWireSummarySchema,
  projectListSchema,
  projectWireListSchema,
  projectPreferredWorkerUpdateSchema,
} from "./projects.js";

export type {
  ProjectReplicaPlacementMode,
  ProjectReplicaPlacementRequest,
  EncryptedProjectReplicaPlacementRequest,
  ProjectReplicaMaterialization,
  ProjectReplicaOwnershipKind,
  ProjectReplicaPlacementResult,
  ProjectSummary,
  ProjectWireSummary,
  ProjectPreferredWorkerUpdate,
  ProjectReplicaSummary,
  ProjectReplicaJobKind,
  ProjectReplicaJobState,
  ProjectReplicaJobErrorCode,
  ProjectReplicaJobError,
  ProjectReplicaJobProgress,
  ProjectReplicaJobProgressEvent,
  ProjectReplicaJobSummary,
  ProjectReplicaProvisionCreate,
  EncryptedProjectReplicaProvisionCreate,
  ProjectReplicaSynchronizationPolicy,
  ProjectReplicaSynchronizeCreate,
  EncryptedProjectReplicaSynchronizeCreate,
  ProjectReplicaRemoveCreate,
  EncryptedProjectReplicaRemoveCreate,
  ProjectReplicaJobRetry,
  ProjectReplicaJobCancel,
  ProjectWorkspaceCreate,
  ProjectWorkspaceUpdate,
  ProjectWorkspaceSummary,
  EncryptedProjectWorkspaceName,
  ProjectWorkspaceWireSummary,
  ProjectWorkspaceWireList,
  EncryptedProjectWorkspaceCreate,
  EncryptedProjectWorkspaceUpdate,
  GithubProjectCreate,
  EncryptedGithubProjectCreate,
  ManagedFolderProjectCreate,
  EncryptedManagedFolderProjectCreate,
  ProjectGithubConversionRepository,
  ProjectGithubRoutingRepository,
} from "./projects.js";

import {
  executionResourceIdSchema,
  executionPlacementSchema,
  executionTargetSchema,
  executionTargetResourceKindSchema,
  executionTargetResolutionSchema,
  executionTargetDescriptorSchema,
} from "./execution-targets.js";

export {
  executionSurfaceKindSchema,
  executionPlacementSchema,
  executionTargetSchema,
  executionPlacementSelectionSchema,
  executionPlacementResolveRequestSchema,
  executionPlacementResolutionSchema,
  executionTargetResourceKindSchema,
  executionTargetAvailabilitySchema,
  executionTargetResolutionSchema,
  executionTargetResolveRequestSchema,
  executionTargetDescriptorSchema,
  executionTargetWireDescriptorSchema,
  executionTargetCatalogSchema,
  executionTargetWireCatalogSchema,
} from "./execution-targets.js";

export type {
  ExecutionSurfaceKind,
  ExecutionPlacement,
  ExecutionTarget,
  ExecutionPlacementSelection,
  ExecutionPlacementResolveRequest,
  ExecutionPlacementResolution,
  ExecutionTargetResourceKind,
  ExecutionTargetAvailability,
  ExecutionTargetResolution,
  ExecutionTargetResolveRequest,
  ExecutionTargetDescriptor,
  ExecutionTargetWireDescriptor,
  ExecutionTargetCatalog,
  ExecutionTargetWireCatalog,
} from "./execution-targets.js";

import {
  worktreePolicySchema,
  projectWorktreeSummarySchema,
} from "./worktrees.js";

export {
  worktreePolicySchema,
  worktreeOriginSchema,
  worktreeLifecycleStateSchema,
  projectWorktreeSummarySchema,
  projectWorktreeListSchema,
  githubPullRequestCheckoutResultSchema,
} from "./worktrees.js";

export type {
  WorktreePolicy,
  WorktreeOrigin,
  WorktreeLifecycleState,
  ProjectWorktreeSummary,
  GithubPullRequestCheckoutResult,
} from "./worktrees.js";

import { tunnelResourceIdSchema } from "./tunnels.js";

export {
  tunnelOriginSchema,
  tunnelManagementSchema,
  tunnelProtocolHintSchema,
  tunnelDesiredStateSchema,
  tunnelStatusSchema,
  tunnelWorkerHostSchema,
  tunnelSourceEndpointSchema,
  tunnelDestinationEndpointSchema,
  tunnelManagedResourceSchema,
  tunnelUserCreateSchema,
  tunnelUserUpdateSchema,
  tunnelUserWireCreateSchema,
  tunnelUserWireUpdateSchema,
  tunnelManagedRegistrationSchema,
  tunnelAttachmentKindSchema,
  tunnelAttachmentSummarySchema,
  tunnelAttachmentWireSummarySchema,
  tunnelAttachmentCreateSchema,
  tunnelAttachmentCreateResultSchema,
  tunnelDirectActivationSchema,
  tunnelAttachmentInitializeSchema,
  tunnelAttachmentReadySchema,
  tunnelActionCapabilitiesSchema,
  tunnelSummarySchema,
  tunnelListSchema,
  tunnelWireSummarySchema,
  tunnelWireListSchema,
} from "./tunnels.js";

export type {
  TunnelOrigin,
  TunnelManagement,
  TunnelProtocolHint,
  TunnelDesiredState,
  TunnelStatus,
  TunnelSourceEndpoint,
  TunnelDestinationEndpoint,
  TunnelManagedResource,
  TunnelUserCreate,
  TunnelUserUpdate,
  TunnelUserWireCreate,
  TunnelUserWireUpdate,
  TunnelAttachmentCreate,
  TunnelAttachmentCreateResult,
  TunnelAttachmentInitialize,
  TunnelAttachmentReady,
  TunnelManagedRegistration,
  TunnelAttachmentKind,
  TunnelAttachmentSummary,
  TunnelAttachmentWireSummary,
  TunnelActionCapabilities,
  TunnelSummary,
  TunnelWireSummary,
} from "./tunnels.js";

export {
  projectGitRepositoryStatsSchema,
  projectFolderStatsSchema,
  projectRepositoryStatsSchema,
  projectTokenUsageDaySchema,
  projectTokenUsageBreakdownSchema,
  projectTokenUsageSchema,
  telemetryValueStatisticsSchema,
  telemetryQuotaReadingSchema,
  telemetryQuotaReadingWireSchema,
  telemetryBreakdownSchema,
  telemetryBreakdownWireSchema,
  modelBehaviorSummarySchema,
  modelBehaviorBreakdownSchema,
  modelBehaviorDaySchema,
  telemetryChangeMetricSchema,
  telemetryChangePointSchema,
  telemetryChangePointWireSchema,
  providerTelemetryAnalyticsSchema,
  providerTelemetryWireAnalyticsSchema,
  providerTelemetryExportSchema,
  providerTelemetryDeleteResultSchema,
} from "./telemetry.js";

export type {
  ProjectRepositoryStats,
  ProjectGitRepositoryStats,
  ProjectFolderStats,
  ProjectTokenUsageDay,
  ProjectTokenUsageBreakdown,
  ProjectTokenUsage,
  TelemetryValueStatistics,
  TelemetryQuotaReading,
  TelemetryBreakdown,
  ModelBehaviorSummary,
  TelemetryChangeMetric,
  TelemetryChangePoint,
  ProviderTelemetryAnalytics,
  ProviderTelemetryWireAnalytics,
  ProviderTelemetryExport,
  ProviderTelemetryDeleteResult,
} from "./telemetry.js";

import {
  chatContextKindSchema,
  standaloneChatIdentitySchema,
  standaloneChatScratchReconciliationTargetSchema,
} from "./chats.js";

export {
  chatCreateSchema,
  encryptedChatCreateSchema,
  taskCreateSchema,
  encryptedTaskCreateSchema,
  chatUpdateSchema,
  encryptedChatUpdateSchema,
  chatForkSchema,
  encryptedChatForkSchema,
  orderedIdsSchema,
  chatContextKindSchema,
  projectChatExecutionRootSchema,
  standaloneChatExecutionRootSchema,
  chatExecutionRootSchema,
  standaloneChatRootStatusSchema,
  standaloneChatRootSummarySchema,
  standaloneChatIdentitySchema,
  standaloneChatCreateSchema,
  encryptedStandaloneChatCreateSchema,
  standaloneChatRootJobKindSchema,
  standaloneChatRootJobStateSchema,
  standaloneChatRootJobErrorSchema,
  standaloneChatRootJobSummarySchema,
  standaloneChatScratchProvisionResultSchema,
  standaloneChatScratchResolveResultSchema,
  standaloneChatScratchDeleteResultSchema,
  standaloneChatScratchArchiveResultSchema,
  standaloneChatScratchReconciliationTargetSchema,
  standaloneChatScratchReconciliationInventorySchema,
  standaloneChatScratchReconciliationResultSchema,
  projectChatSummarySchema,
  standaloneChatSummarySchema,
  contextualChatSummarySchema,
  chatSummarySchema,
  projectChatWireSummarySchema,
  standaloneChatWireSummarySchema,
  contextualChatWireSummarySchema,
  chatWireSummarySchema,
  taskCreateResultSchema,
  taskWireCreateResultSchema,
  chatListSchema,
  chatWireListSchema,
  archivedProjectChatSummarySchema,
  archivedStandaloneChatSummarySchema,
  contextualArchivedChatSummarySchema,
  archivedChatSummarySchema,
  archivedProjectChatWireSummarySchema,
  archivedStandaloneChatWireSummarySchema,
  contextualArchivedChatWireSummarySchema,
  archivedChatWireSummarySchema,
  archivedChatListSchema,
  archivedChatWireListSchema,
  archivedChatCleanupResultSchema,
} from "./chats.js";

export type {
  StandaloneChatRootJobKind,
  StandaloneChatRootJobState,
  StandaloneChatRootJobError,
  StandaloneChatRootJobSummary,
  StandaloneChatScratchProvisionResult,
  StandaloneChatScratchResolveResult,
  StandaloneChatScratchDeleteResult,
  StandaloneChatScratchArchiveResult,
  StandaloneChatScratchReconciliationTarget,
  StandaloneChatScratchReconciliationResult,
  ChatCreate,
  EncryptedChatCreate,
  StandaloneChatCreate,
  EncryptedStandaloneChatCreate,
  TaskCreate,
  EncryptedTaskCreate,
  TaskCreateResult,
  TaskWireCreateResult,
  ChatUpdate,
  EncryptedChatUpdate,
  ChatFork,
  EncryptedChatFork,
  OrderedIds,
  ChatContextKind,
  ProjectChatExecutionRoot,
  StandaloneChatExecutionRoot,
  ChatExecutionRoot,
  StandaloneChatRootStatus,
  StandaloneChatRootSummary,
  ProjectChatSummary,
  StandaloneChatSummary,
  ProjectChatWireSummary,
  StandaloneChatWireSummary,
  ContextualChatSummary,
  ContextualChatWireSummary,
  ChatSummary,
  ChatWireSummary,
  ArchivedChatSummary,
  ArchivedChatWireSummary,
  ArchivedStandaloneChatSummary,
  ArchivedStandaloneChatWireSummary,
  ArchivedChatCleanupResult,
} from "./chats.js";

import { permissionProfileIdSchema } from "./permission-profiles.js";

export {
  permissionProfileIdSchema,
  YOLO_PERMISSION_PROFILE_ID,
  permissionProfileSummarySchema,
  permissionProfileCapabilitySchema,
  chatPermissionProfileStateSchema,
  chatPermissionProfileUpdateSchema,
} from "./permission-profiles.js";

export type {
  PermissionProfileSummary,
  PermissionProfileCapability,
  ChatPermissionProfileState,
  ChatPermissionProfileUpdate,
} from "./permission-profiles.js";

import { repositoryRelativePathSchema } from "./repository-paths.js";

export { repositoryRelativePathSchema } from "./repository-paths.js";

import { terminalServiceRuntimeConfigurationSchema } from "./terminals.js";

export {
  terminalCreateSchema,
  encryptedTerminalCreateSchema,
  encryptedLinkedConsoleCreateSchema,
  terminalUpdateSchema,
  encryptedTerminalUpdateSchema,
  terminalServiceConfigurationSchema,
  encryptedTerminalServiceConfigurationSchema,
  terminalServiceRuntimeConfigurationSchema,
  terminalKindSchema,
  terminalSummarySchema,
  terminalWireSummarySchema,
  terminalListSchema,
  terminalWireListSchema,
  scriptCommandKindSchema,
  scriptCommandSchema,
  scriptCommandListSchema,
  protectedScriptCommandListSchema,
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  terminalOpenResultSchema,
  terminalSnapshotResultSchema,
} from "./terminals.js";

export type {
  TerminalCreate,
  EncryptedTerminalCreate,
  TerminalUpdate,
  EncryptedTerminalUpdate,
  TerminalServiceConfiguration,
  EncryptedTerminalServiceConfiguration,
  TerminalServiceRuntimeConfiguration,
  TerminalSummary,
  TerminalWireSummary,
  TerminalKind,
  ScriptCommandKind,
  ScriptCommand,
  TerminalClientMessage,
  TerminalServerMessage,
  TerminalOpenResult,
  TerminalSnapshotResult,
} from "./terminals.js";

export {
  explorerFileModeSchema,
  explorerCreateSchema,
  encryptedExplorerCreateSchema,
  explorerUpdateSchema,
  encryptedExplorerUpdateSchema,
  encryptedExplorerPinSchema,
  explorerViewStateUpdateSchema,
  encryptedExplorerViewStateUpdateSchema,
  encryptedExplorerWorktreeUpdateSchema,
  explorerSummarySchema,
  explorerWireSummarySchema,
  explorerListSchema,
  explorerWireListSchema,
} from "./explorer-surfaces.js";

export type {
  ExplorerCreate,
  EncryptedExplorerCreate,
  ExplorerUpdate,
  EncryptedExplorerUpdate,
  EncryptedExplorerPin,
  ExplorerFileMode,
  ExplorerViewStateUpdate,
  EncryptedExplorerViewStateUpdate,
  EncryptedExplorerWorktreeUpdate,
  ExplorerSummary,
  ExplorerWireSummary,
} from "./explorer-surfaces.js";

import {
  codeThemeModeSchema,
  codePresentationSchema,
  codeAppearanceSchema,
  codeTransportRouteAuthorizeCommandSchema,
  codeTransportRouteRevokeCommandSchema,
  codeTransportRevokeCommandSchema,
  projectSharePublicBasePathSchema,
  projectSharePublicOriginSchema,
} from "./code-surfaces.js";

export {
  codeThemeModeSchema,
  codePresentationSchema,
  codeAppearanceSchema,
  codeTabStatusSchema,
  codeSessionStatusSchema,
  codeTabCreateSchema,
  encryptedCodeTabCreateSchema,
  codeTabUpdateSchema,
  encryptedCodeTabUpdateSchema,
  codeTabSummarySchema,
  codeTabWireSummarySchema,
  codeTabListSchema,
  codeTabWireListSchema,
  codeEditorBuildSchema,
  codeProbeResultSchema,
  codeSessionSummarySchema,
  codeSessionListSchema,
  codeDirtyEditorSchema,
  codeSaveBeforeAgentTurnSchema,
  codeWorkbenchAgentStatusSchema,
  codeWorkbenchActiveEditorSchema,
  codeWorkbenchGitStateSchema,
  codeWorkbenchStateSchema,
  codeRuntimeStatusSchema,
  codeSettingsWorkbenchOpenResultSchema,
  codeSaveAllResultSchema,
  codeAgentTurnPreparationSessionSchema,
  codeAgentTurnPreparationResultSchema,
  codeAgentTurnNotificationResultSchema,
  codeAttachmentSchema,
  codeProtectedAttachmentWireSchema,
  codeProtectedAttachmentIntentSchema,
  codeSessionRouteGrantSchema,
  codeSessionRouteBasePath,
  parseCodeSessionRoutePath,
  codeTransportCandidateSchema,
  codeTransportWireSchema,
  codeSessionAttachmentWireSchema,
  codeSharedAttachmentWireSchema,
  codeTransportRouteAuthorizeCommandSchema,
  codeTransportRouteRevokeCommandSchema,
  codeTransportRevokeCommandSchema,
  codeTransportRouteAuthorizeResultSchema,
  codeTransportRouteRevokeResultSchema,
  codeTransportRevokeResultSchema,
  projectShareAttachmentSchema,
  projectShareTunnelCreateSchema,
  projectShareDirectCreateSchema,
  projectShareAttachmentWireSchema,
  standaloneChatShareAttachmentSchema,
  standaloneChatShareAttachmentWireSchema,
  projectSharePublicBasePathSchema,
  projectSharePublicOriginSchema,
  codeAttachmentCreateSchema,
  codeProtectedAttachmentCreateSchema,
  codeSessionAttachmentCreateSchema,
  explorerCodeSessionAttachmentCreateSchema,
  codeSettingsWorkbenchSessionAttachmentCreateSchema,
  codeSettingsWorkbenchSharedAttachmentWireSchema,
  explorerCodeProtectedAttachmentCreateSchema,
  codeSettingsWorkbenchAttachmentCreateSchema,
  codeSettingsWorkbenchAttachmentWireSchema,
  explorerCodeAttachmentCreateSchema,
  codeOpenFileResultSchema,
  codeOpenFileRequestSchema,
  codeOpenSettingsRequestSchema,
  codeOpenSettingsResultSchema,
  codeOpenExtensionsRequestSchema,
  codeOpenExtensionsResultSchema,
  codeInstallVsixResultSchema,
  codePresentationUpdateSchema,
  codeThemeUpdateSchema,
  isForwardableCodeWebSocketCloseCode,
  CODE_MAX_WEBSOCKET_MESSAGE_BYTES,
} from "./code-surfaces.js";

export type {
  CodeThemeMode,
  CodePresentation,
  CodeAppearance,
  CodeTabStatus,
  CodeSessionStatus,
  CodeTabCreate,
  EncryptedCodeTabCreate,
  CodeTabUpdate,
  EncryptedCodeTabUpdate,
  CodeTabSummary,
  CodeTabWireSummary,
  CodeEditorBuild,
  CodeProbeResult,
  CodeSessionSummary,
  CodeDirtyEditor,
  CodeSaveBeforeAgentTurn,
  CodeWorkbenchState,
  CodeRuntimeStatus,
  CodeSaveAllResult,
  CodeAgentTurnPreparationResult,
  CodeAgentTurnNotificationResult,
  CodeAttachment,
  CodeAttachmentCreate,
  CodeProtectedAttachmentWire,
  CodeProtectedAttachmentIntent,
  CodeProtectedAttachmentCreate,
  CodeTransportCandidate,
  CodeTransportWire,
  CodeSessionAttachmentCreate,
  ExplorerCodeSessionAttachmentCreate,
  CodeSettingsWorkbenchSessionAttachmentCreate,
  CodeSessionAttachmentWire,
  CodeSharedAttachmentWire,
  CodeSettingsWorkbenchSharedAttachmentWire,
  CodeTransportRouteAuthorizeCommand,
  CodeTransportRouteRevokeCommand,
  CodeTransportRevokeCommand,
  CodeTransportRouteAuthorizeResult,
  CodeTransportRouteRevokeResult,
  CodeTransportRevokeResult,
  CodeSettingsWorkbenchAttachmentCreate,
  CodeSettingsWorkbenchAttachmentWire,
  ExplorerCodeAttachmentCreate,
  ExplorerCodeProtectedAttachmentCreate,
  CodeOpenFileResult,
  CodeOpenFileRequest,
  CodeOpenSettingsResult,
  CodeOpenExtensionsResult,
  CodeInstallVsixResult,
  CodeSettingsWorkbenchOpenResult,
  CodePresentationUpdate,
  CodeThemeUpdate,
  ProjectShareAttachment,
  ProjectShareAttachmentWire,
  StandaloneChatShareAttachment,
  StandaloneChatShareAttachmentWire,
} from "./code-surfaces.js";

import {
  browserHttpUrlSchema,
  browserServiceListSchema,
} from "./browser-surfaces.js";

export {
  browserCreateSchema,
  encryptedBrowserCreateSchema,
  browserUpdateSchema,
  encryptedBrowserUpdateSchema,
  browserSummarySchema,
  browserWireSummarySchema,
  browserListSchema,
  browserWireListSchema,
  browserServiceProtocolSchema,
  browserServiceSchema,
  browserServiceListSchema,
  browserFleetServiceSchema,
  browserServiceDiscoveryWorkerStatusSchema,
  browserServiceDiscoveryErrorSchema,
  browserServiceDiscoveryWorkerResultSchema,
  browserServiceFleetDiscoverySchema,
  browserTunnelRequestSchema,
  browserTunnelWireRequestSchema,
} from "./browser-surfaces.js";

export type {
  BrowserCreate,
  EncryptedBrowserCreate,
  BrowserUpdate,
  EncryptedBrowserUpdate,
  BrowserSummary,
  BrowserWireSummary,
  BrowserServiceProtocol,
  BrowserService,
  BrowserFleetService,
  BrowserServiceDiscoveryWorkerStatus,
  BrowserServiceDiscoveryWorkerResult,
  BrowserServiceFleetDiscovery,
  BrowserTunnelRequest,
  BrowserTunnelWireRequest,
} from "./browser-surfaces.js";

export {
  remoteDesktopTargetSchema,
  remoteDesktopCreateSchema,
  encryptedRemoteDesktopCreateSchema,
  remoteDesktopMonitorSchema,
  remoteDesktopApplicationIconKeySchema,
  remoteDesktopWindowSchema,
  remoteDesktopTargetInventorySchema,
  encryptedRemoteDesktopUpdateSchema,
  remoteDesktopSummarySchema,
  remoteDesktopWireSummarySchema,
  remoteDesktopListSchema,
  remoteDesktopWireListSchema,
  remoteDesktopFleetWorkerStatusSchema,
  remoteDesktopFleetErrorSchema,
  remoteDesktopFleetWorkerSchema,
  remoteDesktopProtectedInventorySchema,
  remoteDesktopFleetWireWorkerSchema,
  remoteDesktopFleetSchema,
  remoteDesktopFleetWireSchema,
} from "./remote-desktops.js";

export type {
  RemoteDesktopCreate,
  EncryptedRemoteDesktopCreate,
  RemoteDesktopTarget,
  RemoteDesktopMonitor,
  RemoteDesktopWindow,
  RemoteDesktopTargetInventory,
  EncryptedRemoteDesktopUpdate,
  RemoteDesktopSummary,
  RemoteDesktopWireSummary,
  RemoteDesktopFleetWorkerStatus,
  RemoteDesktopFleetWorker,
  RemoteDesktopProtectedInventory,
  RemoteDesktopFleetWireWorker,
  RemoteDesktopFleet,
  RemoteDesktopFleetWire,
} from "./remote-desktops.js";

import {
  remoteSurfaceConfigurationSchema,
  remoteSurfaceViewportSchema,
  desktopStreamSettingsSchema,
} from "./remote-surfaces.js";

export {
  remoteSurfaceConfigurationSchema,
  remoteSurfaceCreateSchema,
  encryptedRemoteSurfaceCreateSchema,
  remoteSurfaceUpdateSchema,
  encryptedRemoteSurfaceUpdateSchema,
  remoteSurfaceSummarySchema,
  remoteSurfaceWireSummarySchema,
  remoteSurfaceListSchema,
  remoteSurfaceWireListSchema,
  remoteSurfaceViewportSchema,
  desktopStreamSettingsSchema,
  remoteSurfaceConnectionMessageSchema,
  remoteSurfaceAttachResultSchema,
  remoteSurfaceControlSchema,
  remoteDesktopProbeResultSchema,
  remoteDesktopApplicationIconSchema,
  remoteDesktopClientMessageSchema,
  remoteDesktopServerMessageSchema,
  remoteBrowserClientMessageSchema,
  remoteBrowserServerMessageSchema,
  remoteBrowserCursorMessageSchema,
  remoteBrowserClipboardMessageSchema,
  remoteSurfaceFrameHeaderSchema,
  REMOTE_SURFACE_MAX_HEADER_BYTES,
  REMOTE_SURFACE_MAX_PAYLOAD_BYTES,
  encodeRemoteSurfaceFrame,
  decodeRemoteSurfaceFrame,
} from "./remote-surfaces.js";

export type {
  RemoteDesktopApplicationIcon,
  RemoteSurfaceConfiguration,
  RemoteSurfaceCreate,
  EncryptedRemoteSurfaceCreate,
  RemoteSurfaceUpdate,
  EncryptedRemoteSurfaceUpdate,
  RemoteSurfaceSummary,
  RemoteSurfaceWireSummary,
  RemoteSurfaceViewport,
  DesktopStreamSettings,
  RemoteSurfaceConnectionMessage,
  RemoteSurfaceAttachResult,
  RemoteSurfaceControl,
  RemoteDesktopProbeResult,
  RemoteDesktopClientMessage,
  RemoteDesktopServerMessage,
  RemoteBrowserClientMessage,
  RemoteBrowserServerMessage,
  RemoteBrowserCursorMessage,
  RemoteBrowserClipboardMessage,
  RemoteSurfaceFrameHeader,
} from "./remote-surfaces.js";

export {
  projectViewKindSchema,
  projectViewCreateSchema,
  encryptedProjectViewCreateSchema,
  projectTabKindSchema,
  projectTabMemberSummarySchema,
  projectTabMemberWireSummarySchema,
  tabGroupSummarySchema,
  tabGroupWireSummarySchema,
  tabGroupUpdateSchema,
  encryptedTabGroupUpdateSchema,
  projectTabLayoutSummarySchema,
  projectTabLayoutWireSummarySchema,
  tabGroupOrderSchema,
  tabGroupMemberOrderSchema,
  tabGroupMemberMoveSchema,
  projectViewUpdateSchema,
  encryptedProjectViewUpdateSchema,
  projectViewSummarySchema,
  projectViewWireSummarySchema,
  projectViewListSchema,
  projectViewWireListSchema,
} from "./project-tabs.js";

export type {
  ProjectViewKind,
  ProjectViewCreate,
  EncryptedProjectViewCreate,
  ProjectViewUpdate,
  EncryptedProjectViewUpdate,
  ProjectViewSummary,
  ProjectViewWireSummary,
  ProjectTabKind,
  ProjectTabMemberSummary,
  ProjectTabMemberWireSummary,
  TabGroupSummary,
  TabGroupWireSummary,
  TabGroupUpdate,
  EncryptedTabGroupUpdate,
  ProjectTabLayoutSummary,
  ProjectTabLayoutWireSummary,
  TabGroupOrder,
  TabGroupMemberOrder,
  TabGroupMemberMove,
} from "./project-tabs.js";

export type {
  ChatExecutionLaneActor,
  ChatExecutionLaneState,
  ProjectChatExecutionLaneSummary,
  StandaloneChatExecutionLaneSummary,
  ContextualChatExecutionLaneSummary,
  ChatExecutionLaneSummary,
  ChatExecutionLaneRelease,
} from "./chat-execution-lanes.js";

export {
  chatExecutionLaneActorSchema,
  chatExecutionLaneStateSchema,
  projectChatExecutionLaneSummarySchema,
  standaloneChatExecutionLaneSummarySchema,
  contextualChatExecutionLaneSummarySchema,
  chatExecutionLaneSummarySchema,
  chatExecutionLaneListSchema,
  chatExecutionLaneReleaseSchema,
} from "./chat-execution-lanes.js";

export {
  cantripAgentOperationNameSchema,
  CANTRIP_MCP_READ_OPERATIONS,
  CANTRIP_MCP_READ_TOOL_NAMES,
  CANTRIP_MCP_WORKER_MUTATION_OPERATIONS,
  CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS,
  CANTRIP_MCP_MUTATION_OPERATIONS,
  CANTRIP_MCP_MUTATION_TOOL_NAMES,
  CANTRIP_MCP_OPERATIONS,
  CANTRIP_MCP_TOOL_NAMES,
  cantripMcpToolNameSchema,
  cantripMcpToolNamesForOperations,
  isCantripMcpMutationOperation,
  cantripMcpOperationsForPermissionProfile,
  cantripAgentOperationArgumentsSchema,
  cantripAgentOperationRequestSchema,
  cantripMcpBindingSchema,
  cantripMcpConnectionDocumentSchema,
  cantripMcpBrokerOperationRequestSchema,
  workerCantripMcpOperationCallSchema,
  compatibleWorkerCantripMcpOperationCallSchema,
  CANTRIP_MCP_BINDING_PROTOCOL_VERSIONS,
  workerCantripMcpCapabilitiesQuerySchema,
  workerCantripMcpServerCapabilitiesSchema,
  cantripAgentOperationResultSchema,
} from "./cantrip-mcp.js";

export type {
  CantripAgentOperationName,
  CantripAgentOperationRequest,
  CantripAgentOperationResult,
  CantripMcpBinding,
  CantripMcpConnectionDocument,
  CantripMcpBrokerOperationRequest,
  WorkerCantripMcpOperationCall,
} from "./cantrip-mcp.js";

import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";

export {
  cantripMcpContextGetInputSchema,
  cantripMcpToolHelpInputSchema,
  cantripMcpBindingStaleClaimSchema,
  cantripMcpBindingReadinessSchema,
  cantripMcpPolicyListInputSchema,
  cantripMcpPolicyReadInputSchema,
  cantripMcpTargetListInputSchema,
  cantripMcpTargetInspectInputSchema,
  cantripMcpRunConfigurationListInputSchema,
  cantripMcpRunConfigurationGetInputSchema,
  cantripMcpRunConfigurationDetectInputSchema,
  cantripMcpRunConfigurationCreateInputSchema,
  cantripMcpRunConfigurationUpdateInputSchema,
  cantripMcpRunConfigurationDeleteInputSchema,
  cantripMcpRunConfigurationStartInputSchema,
  cantripMcpRunConfigurationRestartInputSchema,
  cantripMcpRunConfigurationStopInputSchema,
  cantripMcpRunConfigurationStatusInputSchema,
  cantripMcpRunConfigurationReadOutputInputSchema,
  cantripMcpRunConfigurationSecretSetInputSchema,
  cantripMcpWorktreeListInputSchema,
  cantripMcpWorktreeStatusInputSchema,
  cantripMcpExplorerListInputSchema,
  cantripMcpExplorerReadInputSchema,
  cantripMcpTerminalReadInputSchema,
  cantripMcpWebSearchInputSchema,
  cantripMcpWebReadInputSchema,
  cantripMcpWebSessionOpenInputSchema,
  cantripMcpWebSessionSnapshotInputSchema,
  cantripMcpWebSessionClickInputSchema,
  cantripMcpWebSessionTypeInputSchema,
  cantripMcpWebSessionCloseInputSchema,
  cantripMcpBrowserServicesInputSchema,
  cantripMcpWorktreeCreateInputSchema,
  cantripMcpWorktreeSwitchInputSchema,
  cantripMcpWorktreeReleaseInputSchema,
  cantripMcpWorktreeRemoveInputSchema,
  cantripMcpExplorerWriteInputSchema,
  cantripMcpTerminalSendInputSchema,
  cantripMcpTerminalRestartInputSchema,
  cantripMcpBrowserNavigateInputSchema,
  cantripMcpClientNotifyInputSchema,
  cantripMcpClientFocusProjectInputSchema,
  cantripMcpClientSurfaceTargetSchema,
  cantripMcpClientFocusSurfaceInputSchema,
  cantripMcpClientShowInteractionInputSchema,
  cantripMcpContextGetResultSchema,
  cantripMcpToolHelpResultSchema,
  cantripMcpPolicyListResultSchema,
  cantripMcpPolicyReadResultSchema,
  cantripMcpTargetListResultSchema,
  cantripMcpTargetInspectResultSchema,
  cantripMcpRunConfigurationListResultSchema,
  cantripMcpRunConfigurationGetResultSchema,
  cantripMcpRunConfigurationDetectResultSchema,
  cantripMcpRunConfigurationStatusResultSchema,
  cantripMcpRunConfigurationReadOutputResultSchema,
  cantripMcpRunConfigurationCreateResultSchema,
  cantripMcpRunConfigurationUpdateResultSchema,
  cantripMcpRunConfigurationDeleteResultSchema,
  cantripMcpRunConfigurationStartResultSchema,
  cantripMcpRunConfigurationRestartResultSchema,
  cantripMcpRunConfigurationStopResultSchema,
  cantripMcpRunConfigurationSecretSetResultSchema,
  cantripMcpWorktreeSummarySchema,
  cantripMcpWorktreeListResultSchema,
  cantripMcpExplorerListResultSchema,
  cantripMcpExplorerReadResultSchema,
  cantripMcpTerminalReadResultSchema,
  cantripMcpWebSearchResultSchema,
  cantripMcpWebReadResultSchema,
  cantripMcpWebSessionOpenResultSchema,
  cantripMcpWebSessionSnapshotResultSchema,
  cantripMcpWebSessionActionResultSchema,
  cantripMcpWebSessionCloseResultSchema,
  cantripMcpBrowserServicesResultSchema,
  cantripMcpWorktreeCreateResultSchema,
  cantripMcpWorktreeSwitchResultSchema,
  cantripMcpWorktreeReleaseResultSchema,
  cantripMcpWorktreeRemoveResultSchema,
  cantripMcpExplorerWriteResultSchema,
  cantripMcpTerminalSendResultSchema,
  cantripMcpTerminalRestartResultSchema,
  cantripMcpBrowserNavigateResultSchema,
  cantripMcpClientNotifyResultSchema,
  cantripMcpClientFocusProjectResultSchema,
  cantripMcpClientFocusSurfaceResultSchema,
  cantripMcpClientShowInteractionResultSchema,
} from "./cantrip-mcp-tools.js";

export {
  cantripCliCommandResultSchema,
  cantripCliCommandNameSchema,
  cantripCliContextSchema,
  cantripCliCommandRequestSchema,
  workerCliCommandCallSchema,
} from "./cantrip-cli.js";

export type {
  CantripCliCommandName,
  CantripCliContext,
  CantripCliCommandRequest,
  WorkerCliCommandCall,
  CantripCliCommandResult,
} from "./cantrip-cli.js";

import {
  agentMessagePhaseSchema,
  workerObservationEventIdentitySchema,
  agentActivityTimestampSchema,
  codexEventCorrelationSchema,
  agentScopeSchema,
  agentTokenUsageSchema,
  agentActivitySchema,
} from "./agent-activity.js";

export {
  chatMessageRoleSchema,
  agentMessagePhaseSchema,
  workerObservationEventIdentitySchema,
  agentActivityStatusSchema,
  agentCommandOutputLimitBytes,
  agentFilePreviewLimitCharacters,
  agentActivityRawRequestLimitBytes,
  agentActivityRawResponseLimitBytes,
  agentActivityRawRequestDocumentSchema,
  agentActivityRawResponseDocumentSchema,
  agentActivityRawEnvelopeSchema,
  codexEventCorrelationSchema,
  agentScopeSchema,
  agentCommunicationKindSchema,
  agentTokenUsageSchema,
  agentActivitySchema,
} from "./agent-activity.js";

export type {
  AgentMessagePhase,
  CodexEventCorrelation,
  AgentScope,
  AgentCommunicationKind,
  AgentTokenUsage,
  AgentActivityRawEnvelope,
  AgentActivity,
  WorkerObservationEventIdentity,
} from "./agent-activity.js";

import {
  chatTurnModeSchema,
  chatMessageCreateSchema,
} from "./chat-messages.js";

export {
  chatMessageContentSchema,
  chatTurnModeSchema,
  chatComposerDraftSchema,
  chatMessageCreateSchema,
  chatMessageSchema,
} from "./chat-messages.js";

export type {
  ChatComposerDraft,
  ChatMessageContent,
  ChatMessageCreate,
  ChatMessage,
  ChatTurnMode,
} from "./chat-messages.js";

export {
  chatRelocationStateSchema,
  chatRelocationErrorCodeSchema,
  chatRelocationErrorSchema,
  chatRelocationJobErrorSchema,
  chatRelocationProgressStageSchema,
  chatRelocationProgressSchema,
  chatRelocationContextMessageSchema,
  taskRelocationContextMessageSchema,
  chatRelocationAttachmentAvailabilitySchema,
  chatRelocationContextPayloadSchema,
  chatRelocationSnapshotSummarySchema,
  chatRelocationHydrationBeginResultSchema,
  chatRelocationHydrationResultSchema,
  chatRelocationJobSummarySchema,
  chatRelocationJobListSchema,
  chatRelocationCreateSchema,
  chatRelocationJobRetrySchema,
  chatRelocationJobCancelSchema,
} from "./chat-relocation.js";

export type {
  ChatRelocationState,
  ChatRelocationErrorCode,
  ChatRelocationError,
  ChatRelocationJobError,
  ChatRelocationProgress,
  ChatRelocationContextMessage,
  ChatRelocationAttachmentAvailability,
  ChatRelocationContextPayload,
  ChatRelocationSnapshotSummary,
  ChatRelocationHydrationBeginResult,
  ChatRelocationHydrationResult,
  ChatRelocationJobSummary,
  ChatRelocationCreate,
  ChatRelocationJobRetry,
  ChatRelocationJobCancel,
} from "./chat-relocation.js";

import {
  agentInteractionResponseSchema,
  agentInteractionRuntimeRequestSchema,
  encryptedAgentInteractionRuntimeRequestSchema,
} from "./agent-interactions.js";

export {
  agentInteractionRequestKindSchema,
  agentInteractionRequestStatusSchema,
  agentInteractionProvenanceSchema,
  agentInteractionRequestPayloadSchema,
  agentInteractionResponseSchema,
  agentInteractionRequestCreateSchema,
  agentInteractionResolutionCreateSchema,
  encryptedAgentInteractionRequestCreateSchema,
  encryptedAgentInteractionResolutionCreateSchema,
  agentInteractionRuntimeRequestSchema,
  encryptedAgentInteractionRuntimeRequestSchema,
  agentInteractionAcceptedSchema,
  agentInteractionRequestSchema,
  agentInteractionRequestListSchema,
  encryptedAgentInteractionRequestSchema,
  agentInteractionRequestWireSchema,
  agentInteractionRequestWireListSchema,
  agentInteractionResolutionWireCreateSchema,
  agentInteractionRequestQuerySchema,
} from "./agent-interactions.js";

export type {
  AgentInteractionRequestKind,
  AgentInteractionRequestStatus,
  AgentInteractionProvenance,
  AgentInteractionRequestPayload,
  AgentInteractionResponse,
  AgentInteractionRequestCreate,
  AgentInteractionResolutionCreate,
  EncryptedAgentInteractionRequestCreate,
  EncryptedAgentInteractionResolutionCreate,
  AgentInteractionRuntimeRequest,
  EncryptedAgentInteractionRuntimeRequest,
  AgentInteractionAccepted,
  AgentInteractionRequest,
  EncryptedAgentInteractionRequest,
  AgentInteractionRequestWire,
  AgentInteractionResolutionWireCreate,
  AgentInteractionRequestQuery,
} from "./agent-interactions.js";

import {
  chatGoalCreateSchema,
  chatGoalUpdateSchema,
  planModeSchema,
  planStepSchema,
  pendingPlanQuestionSchema,
} from "./chat-runtime.js";

export {
  chatMessageListSchema,
  CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
  CHAT_MESSAGE_PAGE_MAX_LIMIT,
  CHAT_MESSAGE_PAGE_BOUNDARY_MAX,
  chatMessagePageQuerySchema,
  chatMessagePageInfoSchema,
  chatMessageWireListSchema,
  chatMessageWirePageSchema,
  encryptedQueuedPromptSchema,
  encryptedQueuedPromptListSchema,
  encryptedChatTurnCreateSchema,
  projectAutomationProtectedDispatchResultSchema,
  encryptedQueuedPromptUpdateSchema,
  encryptedChatPromptSubmitResultSchema,
  chatTurnCreateSchema,
  queuedPromptSchema,
  queuedPromptListSchema,
  queuedPromptCreateSchema,
  queuedPromptUpdateSchema,
  queuedPromptOrderSchema,
  chatModelUpdateSchema,
  chatModelConfigurationUpdateSchema,
  chatRuntimeSelectionSchema,
  chatReasoningOptionSchema,
  chatReasoningStateSchema,
  chatReasoningUpdateSchema,
  chatTurnAcceptedSchema,
  chatPromptSubmitResultSchema,
  chatPromptSteerResultSchema,
  encryptedChatPromptSteerResultSchema,
  chatCompactAcceptedSchema,
  chatInterruptAcceptedSchema,
  chatTurnRollbackAcceptedSchema,
  chatPauseUpdateSchema,
  chatPauseStateSchema,
  chatPauseRuntimeStateSchema,
  threadGoalStatusSchema,
  threadGoalSchema,
  chatGoalResponseSchema,
  chatGoalWireResponseSchema,
  chatGoalCreateSchema,
  chatGoalUpdateSchema,
  chatGoalClearSchema,
  planModeSchema,
  planStepSchema,
  planQuestionOptionSchema,
  planQuestionSchema,
  pendingPlanQuestionSchema,
  chatPlanStateSchema,
  encryptedChatPlanWireStateSchema,
  projectTaskWorkloadOpaqueItemSchema,
  projectTaskWorkloadOpaqueSchema,
  chatPlanUpdateSchema,
  chatPlanAnswerSchema,
  chatPlanAcceptedSchema,
} from "./chat-runtime.js";

export type {
  ChatMessagePageQuery,
  ChatMessagePageInfo,
  ChatMessageWirePage,
  EncryptedChatTurnCreate,
  EncryptedChatPromptSubmitResult,
  EncryptedQueuedPrompt,
  EncryptedQueuedPromptUpdate,
  ChatTurnCreate,
  QueuedPrompt,
  QueuedPromptCreate,
  QueuedPromptUpdate,
  QueuedPromptOrder,
  ChatModelUpdate,
  ChatModelConfigurationUpdate,
  ChatRuntimeSelection,
  ChatReasoningOption,
  ChatReasoningState,
  ChatReasoningUpdate,
  ChatCompactAccepted,
  ChatInterruptAccepted,
  ChatPauseUpdate,
  ChatPauseState,
  ChatPauseRuntimeState,
  ThreadGoalStatus,
  ThreadGoal,
  ChatGoalResponse,
  ChatGoalCreate,
  ChatGoalUpdate,
  ChatGoalClear,
  PlanMode,
  PlanStep,
  PlanQuestionOption,
  PlanQuestion,
  PendingPlanQuestion,
  ChatPlanState,
  EncryptedChatPlanWireState,
  ProjectTaskWorkloadOpaqueItem,
  ProjectTaskWorkloadOpaque,
  ChatPlanUpdate,
  ChatPlanAnswer,
  ChatPlanAccepted,
} from "./chat-runtime.js";

import {
  gitRelativePathSchema,
  gitComparisonModeSchema,
  gitGraphRequestSchema,
  gitGraphCommitOverlayRequestSchema,
  gitCommitSearchQuerySchema,
  gitRecoveryActionSchema,
  gitRecoveryApplySchema,
  gitStatusSchema,
  gitDiffScopeSchema,
  gitPartialPatchRequestSchema,
  gitPartialPatchApplySchema,
  gitStashCreateSchema,
  gitStashActionSchema,
  gitStashActionApplySchema,
  gitBranchActionSchema,
  gitBranchActionApplySchema,
  gitRemoteActionSchema,
  gitRemoteActionApplySchema,
  gitSubmoduleActionSchema,
  gitSubmoduleActionApplySchema,
  gitLfsActionSchema,
  gitLfsActionApplySchema,
  gitTagNameInputSchema,
  gitTagActionSchema,
  gitTagActionApplySchema,
} from "./git-contracts.js";

export {
  gitRefSchema,
  gitCommitSchema,
  gitCommitPersonSchema,
  gitSignatureSchema,
  gitAgentDraftTaskSchema,
  gitAgentDraftCreateSchema,
  gitAgentDraftModelOutputSchema,
  gitAgentDraftResultSchema,
  gitRelativePathSchema,
  gitCommitFileSchema,
  gitCommitDetailSchema,
  gitRevisionFileDiffSchema,
  gitRevisionCandidateSchema,
  gitRevisionCandidateListSchema,
  gitComparisonModeSchema,
  gitComparisonCommitSchema,
  gitComparisonSchema,
  gitHistorySchema,
  gitFileHistoryEntrySchema,
  gitFileHistorySchema,
  gitBlameRangeSchema,
  gitBlameSchema,
  gitGraphNodeKindSchema,
  gitGraphMetricStateSchema,
  gitGraphAnalysisStateSchema,
  gitGraphNodeSchema,
  gitGraphSnapshotSchema,
  gitGraphNodeMetricsSchema,
  gitGraphMetricsSchema,
  gitGraphRequestSchema,
  gitGraphCommitOverlayRequestSchema,
  gitGraphCommitOverlayNodeSchema,
  gitGraphCommitOverlaySchema,
  gitCommitSearchQuerySchema,
  gitCommitSearchResultSchema,
  gitRecoveryCandidateSchema,
  gitRecoveryCandidateListSchema,
  gitRecoveryActionSchema,
  gitRecoveryPreviewSchema,
  gitRecoveryApplySchema,
  gitRecoveryResultSchema,
  gitFileChangeSchema,
  gitBranchSchema,
  gitStatusSchema,
  gitDiffScopeSchema,
  gitFileDiffSchema,
  gitPartialPatchOperationSchema,
  gitPartialPatchHunkSelectionSchema,
  gitPartialPatchRequestSchema,
  gitPartialPatchPreviewSchema,
  gitPartialPatchApplySchema,
  gitStashFileSchema,
  gitStashSummarySchema,
  gitStashListSchema,
  gitStashCreateSchema,
  gitBranchNameInputSchema,
  gitStashActionSchema,
  gitStashActionPreviewSchema,
  gitStashActionApplySchema,
  gitStashMutationResultSchema,
  gitStashFileDiffSchema,
  gitBranchCommitSummarySchema,
  gitManagedBranchSchema,
  gitPullStrategySchema,
  gitBranchListSchema,
  gitBranchActionSchema,
  gitBranchActionPreviewSchema,
  gitBranchActionApplySchema,
  gitBranchMutationResultSchema,
  gitRemoteSummarySchema,
  gitRemoteListSchema,
  gitRemoteActionSchema,
  gitRemoteActionPreviewSchema,
  gitRemoteActionApplySchema,
  gitRemoteMutationResultSchema,
  gitSubmoduleSummarySchema,
  gitSubmoduleListSchema,
  gitSubmoduleActionSchema,
  gitSubmoduleActionPreviewSchema,
  gitSubmoduleActionApplySchema,
  gitSubmoduleMutationResultSchema,
  gitLfsTrackedPatternSchema,
  gitLfsFileSchema,
  gitLfsLockSchema,
  gitLfsStatusSchema,
  gitLfsActionSchema,
  gitLfsActionPreviewSchema,
  gitLfsActionApplySchema,
  gitLfsMutationResultSchema,
  gitTagNameInputSchema,
  gitTagSummarySchema,
  gitTagDetailSchema,
  gitTagListSchema,
  gitTagActionSchema,
  gitTagActionPreviewSchema,
  gitTagActionApplySchema,
  gitTagMutationResultSchema,
} from "./git-contracts.js";

export type {
  GitRef,
  GitCommit,
  GitHistory,
  GitFileHistoryEntry,
  GitFileHistory,
  GitBlameRange,
  GitBlame,
  GitGraphNodeKind,
  GitGraphMetricState,
  GitGraphAnalysisState,
  GitGraphNode,
  GitGraphSnapshot,
  GitGraphNodeMetrics,
  GitGraphMetrics,
  GitGraphRequest,
  GitGraphCommitOverlayRequest,
  GitGraphCommitOverlayNode,
  GitGraphCommitOverlay,
  GitCommitSearchQuery,
  GitCommitSearchResult,
  GitRecoveryCandidate,
  GitRecoveryCandidateList,
  GitRecoveryAction,
  GitRecoveryPreview,
  GitRecoveryApply,
  GitRecoveryResult,
  GitCommitPerson,
  GitSignature,
  GitAgentDraftTask,
  GitAgentDraftCreate,
  GitAgentDraftResult,
  GitCommitFile,
  GitCommitDetail,
  GitRevisionFileDiff,
  GitRevisionCandidate,
  GitComparisonMode,
  GitComparisonCommit,
  GitComparison,
  GitFileChange,
  GitBranch,
  GitStatus,
  GitDiffScope,
  GitFileDiff,
  GitPartialPatchOperation,
  GitPartialPatchRequest,
  GitPartialPatchPreview,
  GitPartialPatchApply,
  GitStashFile,
  GitStashSummary,
  GitStashList,
  GitStashCreate,
  GitStashAction,
  GitStashActionPreview,
  GitStashActionApply,
  GitStashMutationResult,
  GitStashFileDiff,
  GitBranchCommitSummary,
  GitManagedBranch,
  GitPullStrategy,
  GitBranchList,
  GitBranchAction,
  GitBranchActionPreview,
  GitBranchActionApply,
  GitBranchMutationResult,
  GitRemoteSummary,
  GitRemoteList,
  GitRemoteAction,
  GitRemoteActionPreview,
  GitRemoteActionApply,
  GitRemoteMutationResult,
  GitSubmoduleSummary,
  GitSubmoduleList,
  GitSubmoduleAction,
  GitSubmoduleActionPreview,
  GitSubmoduleActionApply,
  GitSubmoduleMutationResult,
  GitLfsTrackedPattern,
  GitLfsFile,
  GitLfsLock,
  GitLfsStatus,
  GitLfsAction,
  GitLfsActionPreview,
  GitLfsActionApply,
  GitLfsMutationResult,
  GitTagSummary,
  GitTagDetail,
  GitTagList,
  GitTagAction,
  GitTagActionPreview,
  GitTagActionApply,
  GitTagMutationResult,
} from "./git-contracts.js";

import {
  gitCommitActionSchema,
  gitManagedOperationActionSchema,
  gitManagedOperationContextSchema,
  gitOperationObservationStateSchema,
  gitManagedOperationStartSchema,
  gitManagedOperationControlSchema,
  gitManagedOperationAmendSchema,
  gitConflictSummarySchema,
  gitConflictResolutionRequestSchema,
  gitConflictResolutionApplySchema,
  gitCommitActionApplySchema,
  gitActionSchema,
  gitForcePushApplySchema,
} from "./git-actions.js";

export {
  gitCherryPickSelectionSchema,
  gitCommitActionSchema,
  gitOperationSummarySchema,
  gitManagedOperationTypeSchema,
  gitManagedOperationStateSchema,
  gitInteractiveRebaseTodoActionSchema,
  gitInteractiveRebaseTodoItemSchema,
  gitMergeRebaseActionSchema,
  gitBisectActionSchema,
  gitManagedOperationActionSchema,
  gitManagedOperationContextSchema,
  gitManagedOperationWorkerStateSchema,
  gitOperationObservationStateSchema,
  gitManagedOperationPreviewSchema,
  gitManagedOperationStartSchema,
  gitManagedOperationControlSchema,
  gitManagedOperationAmendSchema,
  gitManagedOperationRecordSchema,
  gitManagedOperationResponseSchema,
  gitConflictKindSchema,
  gitConflictStageSchema,
  gitConflictSummarySchema,
  gitConflictListSchema,
  gitConflictDetailSchema,
  gitConflictResolutionStrategySchema,
  gitConflictResolutionRequestSchema,
  gitConflictResolutionPreviewSchema,
  gitConflictResolutionApplySchema,
  gitConflictResolutionResultSchema,
  gitCommitActionPreviewSchema,
  gitCommitActionApplySchema,
  gitCommitActionResultSchema,
  gitActionSchema,
  gitActionResultSchema,
  gitForcePushPreviewSchema,
  gitForcePushApplySchema,
} from "./git-actions.js";

export type {
  GitCherryPickSelection,
  GitCommitAction,
  GitOperationSummary,
  GitManagedOperationType,
  GitManagedOperationState,
  GitMergeRebaseAction,
  GitBisectAction,
  GitManagedOperationAction,
  GitInteractiveRebaseTodoAction,
  GitInteractiveRebaseTodoItem,
  GitManagedOperationContext,
  GitManagedOperationWorkerState,
  GitOperationObservationState,
  GitManagedOperationPreview,
  GitManagedOperationStart,
  GitManagedOperationControl,
  GitManagedOperationAmend,
  GitManagedOperationRecord,
  GitManagedOperationResponse,
  GitConflictKind,
  GitConflictStage,
  GitConflictSummary,
  GitConflictList,
  GitConflictDetail,
  GitConflictResolutionStrategy,
  GitConflictResolutionRequest,
  GitConflictResolutionPreview,
  GitConflictResolutionApply,
  GitConflictResolutionResult,
  GitCommitActionPreview,
  GitCommitActionApply,
  GitCommitActionResult,
  GitAction,
  GitActionResult,
  GitForcePushPreview,
  GitForcePushApply,
} from "./git-actions.js";

import {
  projectGithubConversionPreflightReadySchema,
  projectGithubConversionStartSchema,
} from "./project-provisioning.js";

export {
  githubWorkerRepositorySchema,
  githubWorkerRepositoryListSchema,
  projectCloneResultSchema,
  managedFolderMaterializeReadySchema,
  managedFolderDeleteResultSchema,
  projectFolderSetupJobStateSchema,
  projectFolderSetupJobErrorSchema,
  projectFolderSetupJobSummarySchema,
  projectFolderSetupRetrySchema,
  projectGithubConversionErrorSchema,
  projectGithubConversionJobErrorSchema,
  projectGithubConversionPreflightReadySchema,
  projectGithubConversionPreflightBlockedSchema,
  projectGithubConversionPreflightResultSchema,
  projectGithubConversionPreflightRequestSchema,
  encryptedProjectGithubConversionPreflightRequestSchema,
  projectGithubConversionStartSchema,
  encryptedProjectGithubConversionStartSchema,
  projectGithubConversionJobStateSchema,
  projectGithubConversionJobSummarySchema,
  projectGithubConversionRetrySchema,
  projectGithubConversionReadySchema,
  projectGithubConversionBlockedSchema,
  projectGithubConversionExecutionResultSchema,
  projectReplicaProvisionBlockedSchema,
  projectReplicaProvisionReadySchema,
  projectReplicaProvisionResultSchema,
  projectReplicaSynchronizeReadySchema,
  projectReplicaSynchronizeResultSchema,
  projectReplicaRemoveReadySchema,
  projectReplicaRemoveResultSchema,
  projectReplicaLinkRepairReadySchema,
  projectReplicaLinkRepairBlockedSchema,
  projectReplicaLinkRepairResultSchema,
  projectRemoveSchema,
} from "./project-provisioning.js";

export type {
  GithubWorkerRepository,
  ProjectCloneResult,
  ManagedFolderMaterializeReady,
  ManagedFolderDeleteResult,
  ProjectFolderSetupJobState,
  ProjectFolderSetupJobError,
  ProjectFolderSetupJobSummary,
  ProjectGithubConversionError,
  ProjectGithubConversionJobError,
  ProjectGithubConversionPreflightResult,
  ProjectGithubConversionPreflightReady,
  ProjectGithubConversionPreflightRequest,
  EncryptedProjectGithubConversionPreflightRequest,
  ProjectGithubConversionStart,
  EncryptedProjectGithubConversionStart,
  ProjectGithubConversionJobState,
  ProjectGithubConversionJobSummary,
  ProjectGithubConversionReady,
  ProjectGithubConversionExecutionResult,
  ProjectReplicaProvisionResult,
  ProjectReplicaSynchronizeResult,
  ProjectReplicaRemoveResult,
  ProjectReplicaLinkRepairResult,
  ProjectRemove,
} from "./project-provisioning.js";

import {
  worktreeInventorySchema,
  worktreeCreateModeSchema,
  worktreeStatusResultSchema,
  worktreeObservationTargetSchema,
  worktreeObservationTargetsSchema,
  codeGraphObservationTargetsSchema,
} from "./worker-worktrees.js";

export {
  workerWorktreeSummarySchema,
  worktreeInventorySchema,
  worktreeCreateModeSchema,
  worktreeCreateResultSchema,
  worktreeCreateMutationOutcomeSchema,
  worktreeCreateMutationFailureSchema,
  worktreeMutationResultSchema,
  worktreeRemoveResultSchema,
  worktreePruneResultSchema,
  worktreeStatusResultSchema,
  cantripMcpWorktreeStatusResultSchema,
  worktreeObservationTargetSchema,
  worktreeObservationTargetsSchema,
  codeGraphObservationTargetSchema,
  codeGraphObservationTargetsSchema,
  projectWorktreeCreateSchema,
  projectWorktreeLockSchema,
  projectWorktreeRemoveSchema,
  projectWorktreePruneSchema,
  projectWorktreePolicyUpdateSchema,
  chatWorktreeUpdateSchema,
  worktreeSelectionSchema,
} from "./worker-worktrees.js";

export type {
  WorkerWorktreeSummary,
  WorktreeInventory,
  WorktreeCreateMode,
  WorktreeCreateResult,
  WorktreeCreateMutationFailure,
  WorktreeCreateMutationOutcome,
  WorktreeMutationResult,
  WorktreeRemoveResult,
  WorktreePruneResult,
  WorktreeStatusResult,
  WorktreeObservationTarget,
  CodeGraphObservationTarget,
  ProjectWorktreeCreate,
  ProjectWorktreeLock,
  ProjectWorktreeRemove,
  ProjectWorktreePrune,
  ProjectWorktreePolicyUpdate,
  ChatWorktreeUpdate,
  WorktreeSelection,
} from "./worker-worktrees.js";

import {
  agentTurnResultSchema,
  agentTurnResultModeSchema,
  normalizedAgentMessageSchema,
} from "./agent-thread-sync.js";

export {
  agentTurnResultSchema,
  agentTurnResultModeSchema,
  chatMessageRelayResultSchema,
  normalizedAgentMessageSchema,
  agentThreadSyncItemSchema,
  agentThreadSyncSchema,
} from "./agent-thread-sync.js";

export type {
  AgentTurnResult,
  AgentTurnResultMode,
  NormalizedAgentMessage,
  AgentThreadSync,
  AgentThreadSyncItem,
} from "./agent-thread-sync.js";

import {
  externalChatSourceKindSchema,
  externalChatThreadMetadataSchema,
  externalChatSourceSchema,
  externalChatDiscoveryTargetSchema,
  externalChatAttachmentSchema,
} from "./external-chat-imports.js";

export {
  externalChatSourceKindSchema,
  externalChatSourceAvailabilitySchema,
  externalChatThreadStatusSchema,
  chatImportStateSchema,
  externalChatImportReferenceSchema,
  externalChatThreadMatchSchema,
  externalChatThreadMetadataSchema,
  externalChatSourceSchema,
  externalChatDiscoveryWorkerStatusSchema,
  externalChatDiscoveryWorkerSchema,
  projectExternalChatDiscoverySchema,
  externalChatDiscoveryTargetSchema,
  externalChatDiscoveryWorkerResultSchema,
  externalChatTranscriptMetadataSchema,
  externalChatAttachmentSchema,
  externalChatTranscriptSchema,
  externalChatReadWorkerResultSchema,
  externalChatAttachmentReadResultSchema,
  chatImportErrorSchema,
  chatImportJobErrorSchema,
  chatImportProgressStageSchema,
  chatImportProgressSchema,
  chatImportJobSummarySchema,
  chatImportJobListSchema,
  chatImportSelectionSchema,
  chatImportCreateSchema,
  chatImportJobRetrySchema,
} from "./external-chat-imports.js";

export type {
  ExternalChatSourceKind,
  ExternalChatSourceAvailability,
  ExternalChatThreadStatus,
  ExternalChatImportReference,
  ExternalChatThreadMatch,
  ExternalChatThreadMetadata,
  ExternalChatSource,
  ExternalChatDiscoveryWorker,
  ProjectExternalChatDiscovery,
  ExternalChatDiscoveryTarget,
  ExternalChatDiscoveryWorkerResult,
  ExternalChatTranscriptMetadata,
  ExternalChatTranscript,
  ExternalChatAttachment,
  ExternalChatAttachmentReadResult,
  ExternalChatReadWorkerResult,
  ChatImportState,
  ChatImportError,
  ChatImportJobError,
  ChatImportProgress,
  ChatImportJobSummary,
  ChatImportSelection,
  ChatImportCreate,
} from "./external-chat-imports.js";

import { projectExportTargetSchema } from "./project-exports.js";

export {
  PROJECT_EXPORT_MAX_CHATS,
  projectExportTargetSchema,
  projectExportMappingSchema,
  projectExportPreviewRequestSchema,
  projectExportTargetInspectionSchema,
  projectExportPreviewSchema,
  projectExportCreateSchema,
  projectExportChatResultSchema,
  projectExportItemOutcomeSchema,
  projectExportResultSchema,
  projectExportChatBeginResultSchema,
} from "./project-exports.js";

export type {
  ProjectExportTarget,
  ProjectExportMapping,
  ProjectExportPreviewRequest,
  ProjectExportTargetInspection,
  ProjectExportPreview,
  ProjectExportCreate,
  ProjectExportChatResult,
  ProjectExportItemOutcome,
  ProjectExportResult,
  ProjectExportChatBeginResult,
} from "./project-exports.js";

import {
  workerRuntimeModelSchema,
  workerRuntimeProviderSchema,
  workerChatAttachmentSchema,
  providerRateLimitResetConsumeInputSchema,
  serviceLogLevelSchema,
  workerLogStreamSubscriptionIdSchema,
  workerLogStreamBatchSchema,
} from "./worker-runtime-support.js";

export {
  workerChatAttachmentSchema,
  workerAttachmentUploadResultSchema,
  workerAttachmentReadResultSchema,
  workerProjectShareDescriptorSchema,
  workerProjectShareOpenResultSchema,
  ollamaModelInventoryItemSchema,
  ollamaModelInventorySchema,
  chatGptModelInventoryItemSchema,
  providerQuotaWindowObservationSchema,
  providerRateLimitResetCreditSchema,
  providerRateLimitResetCreditsSummarySchema,
  providerRateLimitResetConsumeOutcomeSchema,
  providerRateLimitResetConsumeInputSchema,
  providerRateLimitResetConsumeRequestSchema,
  providerQuotaSnapshotSchema,
  providerRateLimitResetConsumeResultSchema,
  chatGptModelInventorySchema,
  grokModelInventoryItemSchema,
  grokModelInventorySchema,
  serviceLogLevelSchema,
  serviceLogRecordSchema,
  serviceLogReadResultSchema,
  workerLogStreamSubscriptionIdSchema,
  workerLogStreamBatchSchema,
  workerLogStreamStartResultSchema,
  workerLogStreamRenewResultSchema,
  workerLogStreamServerMessageSchema,
  workerLogReadQuerySchema,
} from "./worker-runtime-support.js";

export type {
  WorkerChatAttachment,
  WorkerAttachmentUploadResult,
  WorkerAttachmentReadResult,
  WorkerProjectShareOpenResult,
  WorkerProjectShareDescriptor,
  OllamaModelInventoryItem,
  OllamaModelInventory,
  ChatGptModelInventoryItem,
  ChatGptModelInventory,
  ProviderQuotaSnapshot,
  ProviderQuotaWindowObservation,
  ProviderRateLimitResetCredit,
  ProviderRateLimitResetCreditsSummary,
  ProviderRateLimitResetConsumeInput,
  ProviderRateLimitResetConsumeRequest,
  ProviderRateLimitResetConsumeOutcome,
  ProviderRateLimitResetConsumeResult,
  GrokModelInventoryItem,
  GrokModelInventory,
  ServiceLogLevel,
  ServiceLogRecord,
  ServiceLogReadResult,
  WorkerLogReadQuery,
  WorkerLogStreamBatch,
  WorkerLogStreamServerMessage,
} from "./worker-runtime-support.js";

const workerRepositoryNameSchema = z.union([
  githubRepositorySchema.shape.nameWithOwner,
  repositoryRoutingHandleSchema,
]);

const customizationWorkerContentFields = {
  operationId: z.string().uuid(),
  serverId: z.string().min(1).max(2_000),
  scope: customizationContentScopeSchema,
};

const protectedCustomizationWorkerRequestFields = {
  ...customizationWorkerContentFields,
  protectedRequest: protectedCustomizationRequestSchema.shape.protectedRequest,
};

export const standaloneChatScratchProvisionCommandSchema = z
  .object({
    type: z.literal("chat.scratch.provision"),
    jobId: standaloneChatIdentitySchema,
    attempt: z.number().int().positive(),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
  })
  .strict();

export const standaloneChatScratchResolveCommandSchema = z
  .object({
    type: z.literal("chat.scratch.resolve"),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
  })
  .strict();

export const standaloneChatScratchArchiveCommandSchema = z
  .object({
    type: z.literal("chat.scratch.archive"),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
    archivedAt: z.string().datetime(),
    archiveExpiresAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (command) =>
      Date.parse(command.archiveExpiresAt) > Date.parse(command.archivedAt),
    { message: "Archive expiry must be later than the archive timestamp." },
  );

export const standaloneChatScratchRestoreCommandSchema = z
  .object({
    type: z.literal("chat.scratch.restore"),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
  })
  .strict();

export const standaloneChatScratchDeleteCommandSchema = z
  .object({
    type: z.literal("chat.scratch.delete"),
    jobId: standaloneChatIdentitySchema,
    attempt: z.number().int().positive(),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
  })
  .strict();

export const standaloneChatScratchReconcileCommandSchema = z
  .object({
    type: z.literal("chat.scratch.reconcile"),
    roots: z.array(standaloneChatScratchReconciliationTargetSchema).max(10_000),
  })
  .strict();

export const standaloneChatFileOperationCommandSchema = z
  .object({
    type: z.literal("chat.scratch.files.operation"),
    rootId: standaloneChatIdentitySchema,
    chatId: standaloneChatIdentitySchema,
    serverId: z.string().min(1).max(2_000),
    root: z.string().min(1).max(32_768),
    intent: standaloneChatFileOperationIntentSchema,
  })
  .extend(surfaceStreamWireRequestSchema.shape)
  .strict();

export const workerCommandSchema = z.discriminatedUnion("type", [
  directCapabilityPrepareCommandSchema,
  directCapabilityRevokeCommandSchema,
  directCapabilityRenewCommandSchema,
  workerLinkSessionInstallCommandSchema,
  workerLinkSessionRenewCommandSchema,
  workerLinkSessionRouteCommandSchema,
  workerLinkSessionRevokeCommandSchema,
  workerLinkGrantInstallCommandSchema,
  workerLinkGrantRenewCommandSchema,
  workerLinkGrantRevokeCommandSchema,
  workerLinkIdentityResolveCommandSchema,
  workerLinkPeerSessionInstallCommandSchema,
  workerLinkPeerSessionRenewCommandSchema,
  workerLinkPeerSessionRevokeCommandSchema,
  workerLinkPeerSignalCommandSchema,
  standaloneChatScratchProvisionCommandSchema,
  standaloneChatScratchResolveCommandSchema,
  standaloneChatScratchArchiveCommandSchema,
  standaloneChatScratchRestoreCommandSchema,
  standaloneChatScratchDeleteCommandSchema,
  standaloneChatScratchReconcileCommandSchema,
  standaloneChatFileOperationCommandSchema,
  z.object({ type: z.literal("worker.version") }),
  z.object({ type: z.literal("worker.restart") }),
  managedWebRuntimeActionRequestSchema.extend({
    type: z.literal("web-runtime.action"),
  }),
  workerEncryptionRefreshRequestSchema.extend({
    type: z.literal("worker.encryption.refresh"),
  }),
  z
    .object({
      type: z.literal("code.settings.synchronize"),
      initializeIfMissing: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("code.settings.invalidate"),
      profileId: codeSettingsProfileIdSchema,
      revision: z.number().int().positive().safe(),
    })
    .strict(),
  z.object({ type: z.literal("code.settings.status") }).strict(),
  z
    .object({
      type: z.literal("code.settings.resolve"),
      resolution: codeSettingsResolutionSchema,
    })
    .strict(),
  z.object({
    type: z.literal("diagnostics.logs.read"),
    afterCursor: z.number().int().nonnegative().default(0),
    beforeCursor: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(500).default(200),
    minimumLevel: serviceLogLevelSchema.default("trace"),
  }),
  z
    .object({
      type: z.literal("diagnostics.logs.stream.start"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
      afterCursor: z.number().int().nonnegative(),
      minimumLevel: serviceLogLevelSchema,
      leaseMs: z.number().int().min(10_000).max(300_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("diagnostics.logs.stream.renew"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
      leaseMs: z.number().int().min(10_000).max(300_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("diagnostics.logs.stream.stop"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
    })
    .strict(),
  z.object({
    type: z.literal("worker.credential.rotate"),
    credential: workerCredentialSecretSchema,
  }),
  z.object({
    type: z.literal("model.ollama.catalog"),
    provider: workerRuntimeProviderSchema.extend({ kind: z.literal("ollama") }),
  }),
  z.object({
    type: z.literal("model.chatgpt.catalog"),
    provider: workerRuntimeProviderSchema.extend({
      kind: z.literal("chatgpt"),
      accountId: z.string().min(1),
      credentialHomeKey: z.string().min(1).max(500),
    }),
  }),
  z.object({
    type: z.literal("model.grok.catalog"),
    provider: workerRuntimeProviderSchema.extend({
      kind: z.literal("grok"),
      accountId: z.string().min(1),
      credentialHomeKey: z.string().min(1).max(500),
    }),
  }),
  z.object({
    type: z.literal("provider.quota.read"),
    provider: workerRuntimeProviderSchema.extend({
      kind: z.enum(["chatgpt", "grok"]),
      accountId: z.string().min(1),
      credentialHomeKey: z.string().min(1).max(500),
    }),
  }),
  z.object({
    type: z.literal("provider.rate-limit-reset.consume"),
    provider: workerRuntimeProviderSchema.extend({
      kind: z.literal("chatgpt"),
      accountId: z.string().min(1),
      credentialHomeKey: z.string().min(1).max(500),
    }),
    idempotencyKey:
      providerRateLimitResetConsumeInputSchema.shape.idempotencyKey,
    creditId: providerRateLimitResetConsumeInputSchema.shape.creditId,
  }),
  z.object({
    type: z.literal("codex.auth.status"),
    providerId: z.string().min(1),
    providerKind: z.enum(["chatgpt", "grok"]).default("chatgpt"),
    credentialHomeKey: z.string().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal("codex.auth.login.start"),
    providerId: z.string().min(1),
    providerAccountId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]).default("chatgpt"),
    credentialHomeKey: z.string().min(1).max(500).optional(),
    observationId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("codex.auth.logout"),
    providerId: z.string().min(1),
    providerAccountId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]).default("chatgpt"),
    credentialHomeKey: z.string().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal("provider.auth.legacy.capture"),
    providerId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]),
    providerAccountId: z.string().min(1).max(512),
    credentialHomeKey: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal("provider.auth.legacy.purge"),
    providerId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]),
    providerAccountId: z.string().min(1).max(512),
    credentialHomeKey: z.string().min(1).max(500),
    expectedSubjectBlindIndex: encryptionKeyBytesSchema,
    serverCredentialRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("provider.auth.account.clear"),
    providerId: z.string().min(1).max(512),
    providerKind: z.enum(["chatgpt", "grok"]),
    providerAccountId: z.string().min(1).max(512),
    credentialHomeKey: z.string().min(1).max(500),
  }),
  z.object({ type: z.literal("github.auth.status") }),
  z.object({
    type: z.literal("github.repositories.cached"),
    login: z.string().min(1),
  }),
  z.object({ type: z.literal("github.repositories.list") }),
  z.object({ type: z.literal("github.repository-owners.list") }),
  z.object({
    type: z.literal("github.repositories.create"),
    request: githubRepositoryCreateSchema,
  }),
  z.object({
    type: z.literal("automation.dispatch.protect"),
    automationId: z.string().uuid(),
    content: projectAutomationOpaqueContentSchema,
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema.nullable(),
    promptId: z.string().uuid(),
    messageId: z.string().uuid(),
    mode: chatTurnModeSchema,
    modelId: z.string().min(1).max(200),
    reasoningEffort: reasoningEffortSchema.nullable(),
    customSubagentModel: z.boolean().optional(),
    subagentModelId: z.string().min(1).max(200).nullable().optional(),
    subagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("github.issues.list"),
    repository: workerRepositoryNameSchema,
    kind: githubIssueKindSchema.default("issue"),
    state: githubIssueStateSchema,
    page: z.number().int().positive().default(1),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("github.issue.get"),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.issue.create"),
    repository: workerRepositoryNameSchema,
    request: githubIssueCreateSchema,
  }),
  z.object({
    type: z.literal("github.issue.comment"),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    body: z.string().trim().min(1).max(65_536),
  }),
  z.object({
    type: z.literal("github.issue.close"),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    comment: z.string().trim().min(1).max(65_536).nullable(),
  }),
  z.object({
    type: z.literal("github.pull-request.create"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    request: githubPullRequestCreateSchema,
  }),
  z.object({
    type: z.literal("github.pull-requests.list"),
    repository: workerRepositoryNameSchema,
    state: githubIssueStateSchema,
    page: z.number().int().positive().default(1),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("github.pull-request.get"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.pull-request.comment"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    body: githubIssueCommentCreateSchema.shape.body,
  }),
  z.object({
    type: z.literal("github.pull-request.review.submit"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    review: githubPullRequestReviewSubmitSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.review.comment"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    comment: githubPullRequestInlineCommentCreateSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.review.reply"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    commentId: z.number().int().positive(),
    body: githubIssueCommentCreateSchema.shape.body,
  }),
  z.object({
    type: z.literal("github.pull-request.lifecycle.preview"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    action: githubPullRequestLifecycleActionSchema,
  }),
  z.object({
    type: z.literal("github.pull-request.lifecycle.apply"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
    request: githubPullRequestLifecycleApplySchema,
  }),
  z.object({
    type: z.literal("github.pull-request.checkout.prepare"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    number: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.releases.list"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
  }),
  z.object({
    type: z.literal("github.release.get"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    releaseId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("github.release.create"),
    cwd: z.string().min(1).max(8_192),
    repository: workerRepositoryNameSchema,
    request: githubReleaseCreateSchema,
  }),
  z.object({
    type: z.literal("project.clone"),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
  }),
  z.object({
    type: z.literal("project.folder.materialize"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid(),
    existingPath: z.string().trim().min(1).max(8_192).optional(),
  }),
  z.object({
    type: z.literal("project.folder.delete"),
    projectId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("project.folder-conversion.preflight"),
    projectId: z.string().uuid(),
    repository: projectGithubWireRepositorySchema,
  }),
  z.object({
    type: z.literal("project.folder-conversion.execute"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid(),
    repository: projectGithubWireRepositorySchema,
    confirmationToken:
      projectGithubConversionPreflightReadySchema.shape.confirmationToken,
    initialCommit: projectGithubConversionStartSchema.shape.initialCommit,
  }),
  z.object({
    type: z.literal("project.replica.provision"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid().optional(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    placement: projectReplicaPlacementRequestSchema.optional(),
    expectedRevision: gitObjectRevisionSchema.nullable(),
  }),
  z.object({
    type: z.literal("project.replica.synchronize"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid().optional(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    sourcePath: z.string().min(1).max(8_192),
    placement: projectReplicaPlacementResultSchema.optional(),
    repositoryFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    expectedRevision: gitObjectRevisionSchema,
    policy: projectReplicaSynchronizationPolicySchema,
  }),
  z.object({
    type: z.literal("project.replica.remove"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    projectId: z.string().uuid().optional(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    sourcePath: z.string().min(1).max(8_192),
    placement: projectReplicaPlacementResultSchema.optional(),
    repositoryFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    deleteLocalFiles: z.boolean(),
  }),
  z.object({
    type: z.literal("project.replica.link.repair"),
    projectId: z.string().uuid(),
    repository: z.object({
      nameWithOwner: workerRepositoryNameSchema,
    }),
    sourcePath: z.string().min(1).max(8_192),
    linkPath: z.string().min(1).max(8_192),
    repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.object({
    type: z.literal("project.files.delete"),
    path: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("project.script-commands"),
      operationId: z.string().uuid(),
      terminalId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(255),
      worktreePath: z.string().min(1).max(8_192),
      stateProtection: terminalPrivateStateOpaqueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("project.script-commands.inspect"),
      operationId: z.string().uuid(),
      projectId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
      sourcePath: z.string().min(1).max(8_192),
    })
    .strict(),
  runConfigurationListWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.list"),
  }),
  runConfigurationGetWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.get"),
  }),
  runConfigurationCapabilitiesWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.capabilities"),
  }),
  runConfigurationDetectWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.detect"),
  }),
  runConfigurationPathsWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.paths"),
  }),
  runConfigurationFlutterDevicesWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.flutter-devices"),
  }),
  runConfigurationValidateWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.validate"),
  }),
  runConfigurationWriteWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.write"),
  }),
  runConfigurationDeleteWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-definitions.delete"),
  }),
  runConfigurationRuntimeStartWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.start"),
  }),
  runConfigurationRuntimeRestartWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.restart"),
  }),
  runConfigurationRuntimeStopWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.stop"),
  }),
  runConfigurationRuntimeStatusWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.status"),
  }),
  runConfigurationRuntimeOutputWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.output"),
  }),
  runConfigurationRuntimeReconcileWorkerCommandSchema.extend({
    type: z.literal("project.run-configuration-runtime.reconcile"),
  }),
  z.object({
    type: z.literal("project.repository-stats"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("project.folder-stats"),
    root: z.string().min(1).max(8_192),
  }),
  z
    .object({
      type: z.literal("project.export.target.inspect"),
      target: projectExportTargetSchema,
      cwd: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.export.chat.begin"),
      operationId: z.string().uuid(),
      target: projectExportTargetSchema,
      chatId: z.string().min(1).max(200),
      cwd: z.string().min(1).max(8_192),
      titleProtection: privateDisplayLabelOpaqueSchema,
      transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      sizeBytes: z
        .number()
        .int()
        .nonnegative()
        .max(256 * 1_024 * 1_024),
    })
    .strict()
    .refine(
      (command) => command.titleProtection.classification.recordKind === "chat",
      {
        message: "Project export title protection must be a chat label.",
        path: ["titleProtection"],
      },
    ),
  z
    .object({
      type: z.literal("project.export.chat.chunk"),
      operationId: z.string().uuid(),
      chatId: z.string().min(1).max(200),
      chunkIndex: z.number().int().nonnegative(),
      data: z.string().max(400_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("project.export.chat.complete"),
      operationId: z.string().uuid(),
      chatId: z.string().min(1).max(200),
    })
    .strict(),
  z.object({
    type: z.literal("external.chat-history.discover"),
    includeArchived: z.boolean().default(false),
    targets: z.array(externalChatDiscoveryTargetSchema).min(1).max(64),
  }),
  z.object({
    type: z.literal("external.chat-history.read"),
    ownerId: z.string().min(1).max(200),
    chatId: z.string().uuid(),
    sourceKind: externalChatSourceKindSchema,
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
    targets: z.array(externalChatDiscoveryTargetSchema).min(1).max(64),
  }),
  z.object({
    type: z.literal("external.chat-history.attachment.read"),
    ownerId: z.string().min(1).max(200),
    chatId: z.string().uuid(),
    sourceKind: externalChatSourceKindSchema,
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
    attachmentId: externalChatAttachmentSchema.shape.sourceAttachmentId,
    targetAttachmentId: externalChatAttachmentSchema.shape.id,
    operationId: z.string().uuid(),
    sequence: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(256 * 1_024),
  }),
  z.object({
    type: z.literal("external.chat-history.attachments.release"),
    sourceKind: externalChatSourceKindSchema,
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
  }),
  z.object({ type: z.literal("browser.services.discover") }),
  z
    .object({
      type: z.literal("mcp.configurations.discover"),
      projectRoot: z.string().min(1).max(8_192).nullable().default(null),
    })
    .strict(),
  z.object({
    type: z.literal("project.share.open"),
    shareId: z.string().min(1).max(200),
    protectedRecord: protectedTunnelContentRecordSchema,
    standaloneRoot: z
      .object({
        chatId: z.string().uuid(),
        rootId: z.string().uuid(),
      })
      .strict()
      .nullable()
      .default(null),
  }),
  z.object({
    type: z.literal("project.share.close"),
    shareId: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("git.history"),
    cwd: z.string().min(1),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
    revisions: z
      .array(z.string().regex(/^[0-9a-f]{40,64}$/u))
      .max(500)
      .default([]),
  }),
  z
    .object({
      type: z.literal("git.graph.snapshot"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitGraphRequestSchema.shape),
  z
    .object({
      type: z.literal("git.graph.metrics"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitGraphRequestSchema.shape),
  z
    .object({
      type: z.literal("git.graph.commit-overlay"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitGraphCommitOverlayRequestSchema.shape),
  z.object({
    type: z.literal("git.file.history"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
    revision: z.string().trim().min(1).max(1_024).default("HEAD"),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("git.file.blame"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
    revision: z.string().trim().min(1).max(1_024).default("HEAD"),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  z.object({
    type: z.literal("git.commit.search"),
    cwd: z.string().min(1).max(8_192),
    query: gitCommitSearchQuerySchema,
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("git.recovery.list"),
    cwd: z.string().min(1).max(8_192),
    kind: z.enum(["reflog", "dangling"]),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  z.object({
    type: z.literal("git.recovery.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitRecoveryActionSchema,
  }),
  z.object({
    type: z.literal("git.recovery.apply"),
    cwd: z.string().min(1).max(8_192),
    request: gitRecoveryApplySchema,
  }),
  z.object({
    type: z.literal("git.commit.get"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
    parentIndex: z.number().int().nonnegative().default(0),
    revisions: z
      .array(z.string().regex(/^[0-9a-f]{40,64}$/u))
      .max(500)
      .default([]),
  }),
  z.object({
    type: z.literal("git.commit.signature.get"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  }),
  z.object({
    type: z.literal("git.refs.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.compare"),
    cwd: z.string().min(1).max(8_192),
    left: z.string().regex(/^[0-9a-f]{40,64}$/u),
    right: z.string().regex(/^[0-9a-f]{40,64}$/u),
    mode: gitComparisonModeSchema,
  }),
  z.object({
    type: z.literal("git.revision.diff"),
    cwd: z.string().min(1).max(8_192),
    revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
    baseRevision: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/u)
      .nullable(),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.status"),
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("git.diff"),
    cwd: z.string().min(1),
    path: gitRelativePathSchema,
    scope: gitDiffScopeSchema,
  }),
  z.object({
    type: z.literal("git.patch.preview"),
    cwd: z.string().min(1).max(8_192),
    request: gitPartialPatchRequestSchema,
  }),
  z
    .object({
      type: z.literal("git.patch.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitPartialPatchApplySchema.shape),
  z.object({
    type: z.literal("git.stash.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.stash.create"),
    cwd: z.string().min(1).max(8_192),
    request: gitStashCreateSchema,
  }),
  z.object({
    type: z.literal("git.stash.diff"),
    cwd: z.string().min(1).max(8_192),
    hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.stash.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitStashActionSchema,
  }),
  z
    .object({
      type: z.literal("git.stash.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitStashActionApplySchema.shape),
  z.object({
    type: z.literal("git.branch.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.branch.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitBranchActionSchema,
  }),
  z
    .object({
      type: z.literal("git.branch.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitBranchActionApplySchema.shape),
  z.object({
    type: z.literal("git.remote.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.remote.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitRemoteActionSchema,
  }),
  z
    .object({
      type: z.literal("git.remote.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitRemoteActionApplySchema.shape),
  z.object({
    type: z.literal("git.submodule.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.submodule.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitSubmoduleActionSchema,
  }),
  z
    .object({
      type: z.literal("git.submodule.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitSubmoduleActionApplySchema.shape),
  z.object({
    type: z.literal("git.lfs.status"),
    cwd: z.string().min(1).max(8_192),
    refreshLocks: z.boolean(),
  }),
  z.object({
    type: z.literal("git.lfs.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitLfsActionSchema,
  }),
  z
    .object({
      type: z.literal("git.lfs.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitLfsActionApplySchema.shape),
  z.object({
    type: z.literal("git.tag.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.tag.get"),
    cwd: z.string().min(1).max(8_192),
    name: gitTagNameInputSchema,
  }),
  z.object({
    type: z.literal("git.tag.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitTagActionSchema,
  }),
  z
    .object({
      type: z.literal("git.tag.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitTagActionApplySchema.shape),
  z.object({
    type: z.literal("git.commit.action.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitCommitActionSchema,
  }),
  z
    .object({
      type: z.literal("git.commit.action.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitCommitActionApplySchema.shape),
  z.object({
    type: z.literal("git.operation.preview"),
    cwd: z.string().min(1).max(8_192),
    action: gitManagedOperationActionSchema,
  }),
  z
    .object({
      type: z.literal("git.operation.start"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitManagedOperationStartSchema.shape),
  z.object({
    type: z.literal("git.operation.inspect"),
    cwd: z.string().min(1).max(8_192),
    context: gitManagedOperationContextSchema,
  }),
  z.object({
    type: z.literal("git.operation.control"),
    cwd: z.string().min(1).max(8_192),
    context: gitManagedOperationContextSchema,
    action: gitManagedOperationControlSchema.shape.action,
  }),
  z
    .object({
      type: z.literal("git.operation.amend"),
      cwd: z.string().min(1).max(8_192),
      context: gitManagedOperationContextSchema,
    })
    .extend(gitManagedOperationAmendSchema.shape),
  z.object({
    type: z.literal("git.conflicts.list"),
    cwd: z.string().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("git.conflicts.get"),
    cwd: z.string().min(1).max(8_192),
    path: gitRelativePathSchema,
  }),
  z.object({
    type: z.literal("git.conflicts.preview"),
    cwd: z.string().min(1).max(8_192),
    request: gitConflictResolutionRequestSchema,
  }),
  z
    .object({
      type: z.literal("git.conflicts.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitConflictResolutionApplySchema.shape),
  z.object({
    type: z.literal("git.action"),
    cwd: z.string().min(1),
    action: gitActionSchema,
  }),
  z.object({
    type: z.literal("git.force-push.preview"),
    cwd: z.string().min(1).max(8_192),
  }),
  z
    .object({
      type: z.literal("git.force-push.apply"),
      cwd: z.string().min(1).max(8_192),
    })
    .extend(gitForcePushApplySchema.shape),
  z
    .object({
      type: z.literal("repository.operation"),
      serverId: z.string().min(1).max(2_000),
      projectId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      cwd: z.string().min(1).max(8_192),
      sourcePath: z.string().min(1).max(8_192),
      repository: workerRepositoryNameSchema.nullable(),
      agentRuntimes: z
        .array(
          z
            .object({
              routeId: z.string().min(1).max(200),
              model: workerRuntimeModelSchema,
              provider: workerRuntimeProviderSchema,
            })
            .strict(),
        )
        .max(20)
        .default([]),
      mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
    })
    .extend(repositoryOperationWireRequestSchema.shape)
    .strict(),
  z.object({
    type: z.literal("worktree.list"),
    sourcePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.reconcile"),
    sourcePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.create"),
    sourcePath: z.string().min(1),
    worktreeId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    mode: worktreeCreateModeSchema,
  }),
  z.object({
    type: z.literal("worktree.remove"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
    force: z.boolean().default(false),
    allowExternal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("worktree.lock"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
    reason: z.string().trim().min(1).max(1_000).nullable().default(null),
  }),
  z.object({
    type: z.literal("worktree.unlock"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.prune"),
    sourcePath: z.string().min(1),
    allowExternal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("worktree.status"),
    sourcePath: z.string().min(1),
    worktreePath: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.observation.configure"),
    targets: worktreeObservationTargetsSchema,
    codegraphTargets: codeGraphObservationTargetsSchema.optional(),
  }),
  z.object({
    type: z.literal("codegraph.status"),
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema.optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
    worktreePath: z.string().min(1).max(8_192).optional(),
  }),
  z.object({
    type: z.literal("codegraph.sync"),
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema.optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
    worktreePath: z.string().min(1).max(8_192).optional(),
  }),
  z.object({
    type: z.literal("codegraph.rebuild"),
    projectId: z.string().uuid(),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema.optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
    worktreePath: z.string().min(1).max(8_192).optional(),
  }),
  z.object({ type: z.literal("codegraph.update.check") }),
  z
    .object({
      type: z.literal("explorer.operation"),
      explorerId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
      root: z.string().min(1),
    })
    .extend(surfaceStreamWireRequestSchema.shape)
    .strict(),
  z.object({ type: z.literal("code.probe") }),
  codeTransportRouteAuthorizeCommandSchema,
  codeTransportRouteRevokeCommandSchema,
  codeTransportRevokeCommandSchema,
  z.object({
    type: z.literal("code.settings.workbench.open"),
    sessionId: z.string().uuid(),
    profileId: z.string().min(1).max(200),
    appearance: codeAppearanceSchema,
  }),
  z.object({
    type: z.literal("code.open"),
    sessionId: z.string().min(1),
    codeTabId: z.string().min(1),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    worktreeName: z.string().trim().min(1).max(200).optional(),
    cwd: z.string().min(1),
    profileId: z.string().min(1).max(200),
    initialFile: repositoryRelativePathSchema.optional(),
    themeMode: codeThemeModeSchema,
    appearance: codeAppearanceSchema,
    presentation: codePresentationSchema.default("workbench"),
  }),
  z.object({
    type: z.literal("code.status"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.stop"),
    sessionId: z.string().min(1),
    expectedSessionIncarnationId: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal("code.endpoint.revoke"),
    tunnelId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("code.saveAll"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.openFile"),
    sessionId: z.string().min(1),
    path: repositoryRelativePathSchema,
  }),
  z.object({
    type: z.literal("code.getDirtyEditors"),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.setTheme"),
    sessionId: z.string().min(1),
    themeMode: codeThemeModeSchema,
    appearance: codeAppearanceSchema,
  }),
  z.object({
    type: z.literal("code.prepareAgentTurn"),
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("code.agentTurnState"),
    cwd: z.string().min(1),
    phase: z.enum(["started", "completed", "failed"]),
    paths: z.array(z.string().min(1).max(8_192)).max(5_000).default([]),
  }),
  z.object({
    type: z.literal("skills.list"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("skills.settings.list"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("skills.settings.read"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("skills.settings.write"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("skills.settings.delete"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1).max(8_192).nullable(),
    providerId: z.string().min(1).max(200),
    providerKind: modelProviderKindSchema,
  }),
  z.object({
    type: z.literal("customization.inventory.read"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    forceReload: z.boolean().default(false),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.preview"),
    ...customizationWorkerContentFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.resource.read"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.skill.configure"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.skill-roots.set"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.oauth.start"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.oauth.status"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.mcp.reload"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.apply"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("customization.external.status"),
    ...protectedCustomizationWorkerRequestFields,
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("permission-profiles.list"),
    cwd: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("attachment.upload.begin"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: z.enum(["upload", "relay"]),
    protectedMetadata: attachmentProtectedMetadataSchema,
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
  }),
  z.object({
    type: z.literal("attachment.upload.chunk"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: z.enum(["upload", "relay"]),
    chunk: attachmentChunkOpaqueSchema,
  }),
  z.object({
    type: z.literal("attachment.upload.complete"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("attachment.read"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    direction: z.enum(["download", "relay"]),
    protectedMetadata: attachmentProtectedMetadataSchema,
    sequence: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(256 * 1_024),
  }),
  z.object({
    type: z.literal("attachment.delete"),
    chatId: z.string().min(1).max(200),
    attachmentId: z.string().min(1).max(200),
  }),
  z
    .object({
      type: z.literal("terminal.open"),
      terminalId: z.string().min(1),
      attachmentId: z.string().min(1),
      operationId: surfaceStreamWireRequestSchema.shape.operationId,
      serverId: z.string().min(1).max(255),
      worktreePath: z.string().min(1).max(8_192),
      stateProtection: terminalPrivateStateOpaqueSchema,
      cols: z.number().int().min(1).max(1_000),
      rows: z.number().int().min(1).max(1_000),
      outputMode: z.enum(["protected", "discard"]).optional(),
      launch: z.discriminatedUnion("type", [
        z.object({ type: z.literal("shell") }),
        z.object({
          type: z.literal("codex"),
          threadId: z.string().min(1).nullable(),
          model: workerRuntimeModelSchema,
          provider: workerRuntimeProviderSchema,
          permissionProfileId: permissionProfileIdSchema.optional(),
          mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).optional(),
        }),
      ]),
    })
    .strict(),
  z.object({
    type: z.literal("terminal.detach"),
    terminalId: z.string().min(1),
    attachmentId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("terminal.input"),
      terminalId: z.string().min(1),
      serverId: z.string().min(1).max(2_000),
      operationId: surfaceStreamWireRequestSchema.shape.operationId,
      sequence: surfaceStreamWireRequestSchema.shape.sequence,
      protectedData: surfaceStreamOpaqueSchema,
      complete: z.boolean().default(false),
    })
    .strict(),
  z.object({
    type: z.literal("terminal.resize"),
    terminalId: z.string().min(1),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
  z.object({
    type: z.literal("terminal.close"),
    terminalId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("terminal.snapshot"),
      terminalId: z.string().min(1).max(200),
      serverId: z.string().min(1).max(2_000),
    })
    .extend(surfaceStreamWireRequestSchema.shape)
    .strict(),
  z.object({
    type: z.literal("terminal.services.reconcile"),
    services: z.array(terminalServiceRuntimeConfigurationSchema).max(1_000),
  }),
  z.object({
    type: z.literal("terminal.service.restart"),
    terminalId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("surface.attach"),
      surfaceId: z.string().min(1),
      attachmentId: z.string().min(1),
      projectId: z.string().min(1),
      serverId: z.string().min(1).max(255),
      configuration: remoteSurfaceConfigurationSchema,
      stateResource: z
        .enum([
          "browser-row",
          "browser-remote-surface",
          "remote-desktop-row",
          "remote-desktop-surface",
        ])
        .nullable(),
      stateRevision: z.number().int().positive().safe().nullable(),
      stateProtection: z
        .union([
          browserPrivateStateOpaqueSchema,
          remoteDesktopPrivateStateOpaqueSchema,
        ])
        .nullable(),
      preferredTransport: remoteSurfaceTransportSchema,
      webrtc: remoteSurfaceWebRtcConfigurationSchema.nullable().default(null),
      viewport: remoteSurfaceViewportSchema,
      desktopStream: desktopStreamSettingsSchema.nullable().default(null),
    })
    .strict()
    .superRefine((command, context) => {
      const expectedRecordKind =
        command.configuration.kind === "browser"
          ? "browser-state"
          : "remote-desktop-state";
      const validResource =
        command.configuration.kind === "browser"
          ? command.stateResource === "browser-row" ||
            command.stateResource === "browser-remote-surface"
          : command.stateResource === "remote-desktop-row" ||
            command.stateResource === "remote-desktop-surface";
      if (
        command.stateProtection?.classification.recordKind !==
          expectedRecordKind ||
        command.stateRevision === null ||
        !validResource
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Surface commands require protected state matching their kind.",
          path: ["stateProtection"],
        });
      }
    }),
  z.object({
    type: z.literal("surface.detach"),
    surfaceId: z.string().min(1),
    attachmentId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("surface.configure"),
      surfaceId: z.string().min(1),
      serverId: z.string().min(1).max(255),
      configuration: remoteSurfaceConfigurationSchema,
      stateResource: z
        .enum([
          "browser-row",
          "browser-remote-surface",
          "remote-desktop-row",
          "remote-desktop-surface",
        ])
        .nullable(),
      stateRevision: z.number().int().positive().safe().nullable(),
      stateProtection: z
        .union([
          browserPrivateStateOpaqueSchema,
          remoteDesktopPrivateStateOpaqueSchema,
        ])
        .nullable(),
    })
    .strict()
    .superRefine((command, context) => {
      const expectedRecordKind =
        command.configuration.kind === "browser"
          ? "browser-state"
          : "remote-desktop-state";
      const validResource =
        command.configuration.kind === "browser"
          ? command.stateResource === "browser-row" ||
            command.stateResource === "browser-remote-surface"
          : command.stateResource === "remote-desktop-row" ||
            command.stateResource === "remote-desktop-surface";
      if (
        command.stateProtection?.classification.recordKind !==
          expectedRecordKind ||
        command.stateRevision === null ||
        !validResource
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Surface commands require protected state matching their kind.",
          path: ["stateProtection"],
        });
      }
    }),
  z.object({
    type: z.literal("surface.suspend"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.resume"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.close"),
    surfaceId: z.string().min(1),
  }),
  z.object({
    type: z.literal("surface.desktop.probe"),
  }),
  z
    .object({
      type: z.literal("surface.desktop.targets"),
      serverId: z.string().min(1).max(255),
      operationId: z.string().uuid(),
      resourceId: z.string().min(1).max(200),
      limit: z.number().int().nonnegative().max(2_064),
    })
    .strict(),
  z.object({
    type: z.literal("model.provider.test"),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.message.protect"),
    message: chatMessageCreateSchema
      .extend({
        id: z.string().uuid(),
        idempotencyKey: z.string().min(1).max(200),
      })
      .strict(),
    attachments: chatAttachmentOpaqueListSchema.default([]),
  }),
  taskOperationPrepareRequestSchema.extend({
    type: z.literal("task.operation.prepare"),
  }),
  z.object({
    type: z.literal("chat.messages.protect"),
    messages: z
      .array(
        chatMessageCreateSchema
          .extend({
            id: z.string().uuid(),
            idempotencyKey: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(100_000),
    attachments: chatAttachmentOpaqueListSchema.default([]),
  }),
  z.object({
    type: z.literal("chat.messages.reprotect"),
    messages: z
      .array(
        z
          .object({
            source: chatMessageOpaqueSummarySchema,
            id: z.string().uuid(),
            idempotencyKey: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(100_000),
  }),
  z.object({
    type: z.literal("chat.turn.protect"),
    promptId: z.string().uuid(),
    messageId: z.string().uuid(),
    text: z.string().trim().min(1).max(100_000),
    mode: chatTurnModeSchema,
    modelId: z.string().min(1).max(200),
    reasoningEffort: reasoningEffortSchema.nullable(),
    customSubagentModel: z.boolean().optional(),
    subagentModelId: z.string().min(1).max(200).nullable().optional(),
    subagentReasoningEffort: reasoningEffortSchema.nullable().optional(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z
    .object({
      type: z.literal("chat.turn"),
      executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
      contextKind: chatContextKindSchema.default("project"),
      chatId: z.string().min(1),
      clientMessageId: z.string().min(1),
      executionLaneId: z.string().min(1),
      worktreeId: z.string().min(1).nullable(),
      scratchRootId: z.string().min(1).nullable().default(null),
      rootKind: projectRootKindSchema.nullable().default("git-worktree"),
      cwd: z.string().min(1),
      isPrimary: z.boolean(),
      worktreeMode: z.enum(["agent-managed", "pinned"]).nullable(),
      worktreePolicy: worktreePolicySchema.nullable(),
      policyProjectId: z.string().min(1).max(200).nullable(),
      policies: effectivePolicyWireListSchema.default({ policies: [] }),
      standalonePolicies: standalonePolicyWireListSchema.default({
        policies: [],
      }),
      threadId: z.string().min(1).nullable(),
      prompt: z.string().min(1).optional(),
      protectedPrompt: chatMessageOpaqueContentSchema.optional(),
      protectedHistory: z
        .array(chatMessageOpaqueSummarySchema)
        .max(100_000)
        .default([]),
      protectedPlan: chatPlanOpaqueStateSchema.nullable().default(null),
      attachments: z.array(workerChatAttachmentSchema).max(20).default([]),
      skillNames: z.array(z.string().min(1)).max(64).default([]),
      chatSkillAudienceKeys: z
        .array(encryptionKeyBytesSchema)
        .max(5_000)
        .default([]),
      model: workerRuntimeModelSchema,
      provider: workerRuntimeProviderSchema,
      subagentDefaults: z
        .object({
          model: workerRuntimeModelSchema,
          provider: workerRuntimeProviderSchema,
        })
        .strict()
        .nullable()
        .optional(),
      subagentProtocolVersion: z
        .literal(NATIVE_SUBAGENT_PROTOCOL_VERSION)
        .optional(),
      permissionProfileId: permissionProfileIdSchema,
      planMode: planModeSchema,
      mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
      automationPaused: z.boolean().default(false),
      resultMode: agentTurnResultModeSchema.default({ kind: "visible" }),
      taskDispatchLease: taskDispatchWorkerLeaseSchema.optional(),
    })
    .superRefine((command, context) => {
      const projectShape =
        command.executionProfile === "ide" &&
        command.contextKind === "project" &&
        command.worktreeId !== null &&
        command.scratchRootId === null &&
        command.rootKind !== null &&
        command.worktreeMode !== null &&
        command.worktreePolicy !== null &&
        command.policyProjectId !== null;
      const standaloneShape =
        command.executionProfile === "standalone-chat" &&
        command.contextKind === "standalone" &&
        command.worktreeId === null &&
        command.scratchRootId !== null &&
        command.rootKind === null &&
        command.isPrimary &&
        command.worktreeMode === null &&
        command.worktreePolicy === null &&
        command.policyProjectId === null &&
        command.planMode === "default" &&
        command.automationPaused === false &&
        command.subagentDefaults == null &&
        command.subagentProtocolVersion === undefined &&
        command.taskDispatchLease === undefined;
      if (!projectShape && !standaloneShape) {
        context.addIssue({
          code: "custom",
          message:
            "Chat turn execution profile does not match its execution root and capabilities.",
          path: ["executionProfile"],
        });
      }
      if (
        command.executionProfile === "ide" &&
        (command.standalonePolicies.policies.length > 0 ||
          command.chatSkillAudienceKeys.length > 0)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "IDE chat turns cannot receive standalone Policy bodies or Chat Skill audiences.",
          path: ["standalonePolicies"],
        });
      }
      if (Boolean(command.prompt) === Boolean(command.protectedPrompt)) {
        context.addIssue({
          code: "custom",
          message:
            "Chat turns require exactly one visible or protected prompt.",
          path: ["protectedPrompt"],
        });
      }
      if (
        command.protectedPrompt &&
        command.resultMode.kind !== "chat-message-encrypted"
      ) {
        context.addIssue({
          code: "custom",
          message: "Protected chat prompts require protected chat results.",
          path: ["resultMode"],
        });
      }
      if (
        command.taskDispatchLease &&
        command.resultMode.kind !== "task-encrypted" &&
        command.resultMode.kind !== "task-message-encrypted"
      ) {
        context.addIssue({
          code: "custom",
          message: "Task dispatch leases are only valid for Task turns.",
          path: ["taskDispatchLease"],
        });
      }
    }),
  protectedWorkflowNodeExecutionRequestSchema.extend({
    type: z.literal("workflow.node.execute"),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  protectedWorkflowGateDecisionRequestSchema.extend({
    type: z.literal("workflow.gate.decide.protected"),
  }),
  protectedWorkflowTriggerPrepareRequestSchema.extend({
    type: z.literal("workflow.trigger.prepare.protected"),
  }),
  z.object({
    type: z.literal("workflow.definition.generate"),
    generationId: z.string().min(1).max(200),
    cwd: z.string().trim().min(1).max(8_192),
    prompt: z.string().trim().min(1).max(100_000),
    developerInstructions: z.string().trim().min(1).max(100_000),
    outputSchema: workflowJsonObjectSchema,
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(15 * 60 * 1_000),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  z.object({
    type: z.literal("workflow.repository.scan"),
    cwd: z.string().trim().min(1).max(8_192),
  }),
  z.object({
    type: z.literal("workflow.repository.write"),
    cwd: z.string().trim().min(1).max(8_192),
    document: workflowRepositoryDocumentSchema,
    overwrite: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("workflow.node.interrupt"),
    workflowRunId: z.string().min(1).max(200),
    runNodeId: z.string().min(1).max(200),
    attemptId: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.pause.set"),
    chatId: z.string().min(1),
    paused: z.boolean(),
  }),
  z.object({
    type: z.literal("chat.compact"),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.interrupt"),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    chatId: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.turn.rollback"),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    chatId: z.string().min(1),
    clientMessageId: z.string().min(1).max(200),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.goal.get"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    taskContext: taskGoalSyncContextSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.goal.create"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    objective: z.union([
      chatGoalCreateSchema.shape.objective,
      taskOperationRelayGoalSchema,
    ]),
    tokenBudget: chatGoalCreateSchema.shape.tokenBudget,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    taskContext: taskGoalSyncContextSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.goal.update"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    status: chatGoalUpdateSchema.shape.status,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    taskContext: taskGoalSyncContextSchema.optional(),
  }),
  z.object({
    type: z.literal("chat.goal.clear"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.thread.ensure"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    planMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  z.object({
    type: z.literal("chat.relocation.hydration.begin"),
    chatId: z.string().min(1).max(200),
    snapshotId: z.string().uuid(),
    transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1_024 * 1_024),
    cwd: z.string().min(1).max(8_192),
    requiredSkillNames: z.array(z.string().min(1).max(200)).max(64).default([]),
    planMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
    mcpServers: z.array(mcpServerOpaqueRuntimeSchema).max(200).default([]),
  }),
  z.object({
    type: z.literal("chat.relocation.hydration.chunk"),
    snapshotId: z.string().uuid(),
    chunkIndex: z.number().int().nonnegative(),
    data: z.string().max(400_000),
  }),
  z.object({
    type: z.literal("chat.relocation.hydration.complete"),
    snapshotId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("chat.relocation.thread.release"),
    threadId: z.string().min(1).nullable(),
    discard: z.boolean().default(false),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("chat.plan.get"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    fallbackMode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("chat.plan.set"),
    cwd: z.string().min(1),
    threadId: z.string().min(1).nullable(),
    mode: planModeSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
    permissionProfileId: permissionProfileIdSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.respond"),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    requestKey: z.string().min(1).max(200),
    response: agentInteractionResponseSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.respond.protected"),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    requestKey: z.string().min(1).max(200),
    response: interactionResponseOpaqueContentSchema,
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.cancel"),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    requestKey: z.string().min(1).max(200),
    reason: z.string().min(1).max(4_000),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
  z
    .object({
      type: z.literal("chat.steer"),
      executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
      chatId: z.string().min(1),
      threadId: z.string().min(1).nullable(),
      prompt: z.string().trim().min(1).max(100_000).optional(),
      protectedPrompt: chatMessageOpaqueContentSchema.optional(),
      attachments: z.array(workerChatAttachmentSchema).max(20).default([]),
      model: workerRuntimeModelSchema,
      provider: workerRuntimeProviderSchema,
    })
    .superRefine((command, context) => {
      if (Boolean(command.prompt) === Boolean(command.protectedPrompt)) {
        context.addIssue({
          code: "custom",
          message:
            "Chat steering requires exactly one visible or protected prompt.",
          path: ["protectedPrompt"],
        });
      }
    }),
  z.object({
    type: z.literal("chat.sync"),
    executionProfile: z.enum(["ide", "standalone-chat"]).default("ide"),
    chatId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1),
    model: workerRuntimeModelSchema,
    provider: workerRuntimeProviderSchema,
  }),
]);

export const workerRequestEnvelopeSchema = z.object({
  kind: z.literal("request"),
  requestId: z.string().min(1),
  command: workerCommandSchema,
});

export const WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL = "cantrip-worker-legacy";
export const WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL =
  "cantrip-worker-auth-ready-v1";
export const WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL =
  "cantrip-worker-auth-ready-v2";
export const WORKER_WEBSOCKET_SUBPROTOCOLS = [
  WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
  WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
  WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL,
] as const;

const workerConnectionEnvelopeV1Schema = z
  .object({
    kind: z.literal("connection"),
    state: z.enum(["pending", "ready"]),
    protocolVersion: z.literal(1),
    connectionGeneration: z.string().uuid(),
  })
  .strict();

const workerConnectionEnvelopeV2Schema = z
  .object({
    kind: z.literal("connection"),
    state: z.enum(["pending", "ready"]),
    protocolVersion: z.literal(2),
    connectionGeneration: z.string().uuid(),
    serverControlPlaneGeneration: z.string().uuid(),
  })
  .strict();

export const workerConnectionEnvelopeSchema = z.discriminatedUnion(
  "protocolVersion",
  [workerConnectionEnvelopeV1Schema, workerConnectionEnvelopeV2Schema],
);

export const workerResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.literal(false),
    error: z.object({ message: z.string().min(1) }),
  }),
]);

const protectedAgentEventTelemetrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    phase: agentMessagePhaseSchema.nullable(),
    streaming: z.boolean().optional(),
    turnId: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("activity"),
    activityType: z.string().min(1).max(100),
    turnId: z.string().min(1).nullable(),
    agentRuntime: z
      .object({
        agentThreadId: z.string().min(1).max(200),
        isRoot: z.boolean(),
        startedAtMs: agentActivityTimestampSchema.nullable(),
        completedAtMs: agentActivityTimestampSchema.nullable(),
        status: z.enum(["running", "completed", "failed"]),
      })
      .strict()
      .nullable()
      .optional(),
  }),
  z.object({
    kind: z.literal("usage"),
    usage: agentTokenUsageSchema,
    modelContextWindow: z.number().int().positive().nullable(),
    contextUsedPercent: z.number().min(0).nullable(),
    turnId: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("checkpoint"),
    turnId: z.string().min(1),
  }),
]);

export const inferenceProgressPhaseSchema = z.enum([
  "queued",
  "loading",
  "prefill",
  "generating",
]);

export const inferenceProgressPrecisionSchema = z.enum([
  "exact",
  "estimated",
  "indeterminate",
]);

export const inferenceProgressSourceSchema = z.enum([
  "provider-stream",
  "provider-observer",
  "provider-metrics",
  "worker-estimate",
]);

export const inferenceProgressSnapshotSchema = z
  .object({
    kind: z.literal("progress"),
    requestId: z.string().trim().min(1).max(200),
    cycle: z.number().int().positive().safe(),
    sequence: z.number().int().nonnegative().safe(),
    phase: inferenceProgressPhaseSchema,
    fractionComplete: z.number().min(0).max(1).nullable(),
    completedTokens: z.number().int().nonnegative().safe().nullable(),
    totalTokens: z.number().int().positive().safe().nullable(),
    precision: inferenceProgressPrecisionSchema,
    source: inferenceProgressSourceSchema,
    startedAt: z.iso.datetime(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((progress, context) => {
    if (
      progress.precision === "indeterminate" &&
      progress.fractionComplete !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Indeterminate progress cannot include a completed fraction.",
        path: ["precision"],
      });
    }
    if (
      progress.precision !== "indeterminate" &&
      progress.fractionComplete === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Determinate progress requires a completed fraction.",
        path: ["precision"],
      });
    }
    if (progress.totalTokens !== null && progress.completedTokens === null) {
      context.addIssue({
        code: "custom",
        message: "A total token count requires a completed token count.",
        path: ["totalTokens"],
      });
    }
    if (
      progress.completedTokens !== null &&
      progress.totalTokens !== null &&
      progress.completedTokens > progress.totalTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "Completed tokens cannot exceed total tokens.",
        path: ["completedTokens"],
      });
    }
    if (Date.parse(progress.startedAt) > Date.parse(progress.observedAt)) {
      context.addIssue({
        code: "custom",
        message: "Inference progress cannot be observed before it starts.",
        path: ["startedAt"],
      });
    }
  });

export const inferenceProgressUpdateSchema = z.discriminatedUnion("kind", [
  inferenceProgressSnapshotSchema,
  z
    .object({
      kind: z.literal("clear"),
      requestId: z.string().trim().min(1).max(200),
      cycle: z.number().int().positive().safe(),
      sequence: z.number().int().nonnegative().safe(),
      observedAt: z.iso.datetime(),
    })
    .strict(),
]);

export const workerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("project.replica.progress"),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    progress: projectReplicaJobProgressEventSchema,
  }),
  z.object({
    type: z.literal("agent.activity"),
    activity: agentActivitySchema,
  }),
  z.object({
    type: z.literal("agent.message"),
    message: normalizedAgentMessageSchema,
  }),
  z
    .object({
      type: z.literal("agent.inference-progress"),
      progress: inferenceProgressUpdateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("agent.protected-message"),
      message: chatMessageOpaqueContentSchema,
      telemetry: protectedAgentEventTelemetrySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("agent.protected-task-message"),
      message: taskMessageOpaqueContentSchema,
      telemetry: protectedAgentEventTelemetrySchema,
    })
    .strict(),
  z.object({ type: z.literal("terminal.ready") }),
  z.object({
    type: z.literal("agent.checkpoint"),
    turnId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("agent.plan.updated"),
    turnId: z.string().min(1),
    explanation: z.string().nullable(),
    steps: z.array(planStepSchema),
  }),
  z.object({
    type: z.literal("agent.plan.question"),
    question: pendingPlanQuestionSchema,
  }),
  z.object({
    type: z.literal("agent.plan.question-resolved"),
    questionId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("agent.plan.protected"),
      turnId: z.string().min(1).nullable(),
      state: chatPlanOpaqueStateSchema,
    })
    .strict(),
  z.object({
    type: z.literal("agent.interaction.requested"),
    request: agentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.requested.protected"),
    request: encryptedAgentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("agent.interaction.cleared"),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("agent.interaction.expired"),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("workflow.node.activity"),
    attemptId: z.string().min(1).max(200),
    activity: agentActivitySchema,
  }),
  z.object({
    type: z.literal("workflow.node.message"),
    attemptId: z.string().min(1).max(200),
    message: normalizedAgentMessageSchema,
  }),
  z.object({
    type: z.literal("workflow.node.plan.updated"),
    attemptId: z.string().min(1).max(200),
    turnId: z.string().min(1),
    explanation: z.string().nullable(),
    steps: z.array(planStepSchema),
  }),
  z.object({
    type: z.literal("workflow.node.interaction.requested"),
    attemptId: z.string().min(1).max(200),
    request: agentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("workflow.node.interaction.requested.protected"),
    attemptId: z.string().min(1).max(200),
    request: encryptedAgentInteractionRuntimeRequestSchema,
  }),
  z.object({
    type: z.literal("workflow.node.interaction.cleared"),
    attemptId: z.string().min(1).max(200),
    requestKey: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("workflow.node.interaction.expired"),
    attemptId: z.string().min(1).max(200),
    requestKey: z.string().min(1).max(200),
  }),
  z
    .object({
      type: z.literal("terminal.output"),
      operationId: surfaceStreamWireRequestSchema.shape.operationId,
      sequence: surfaceStreamWireRequestSchema.shape.sequence,
      protectedData: surfaceStreamOpaqueSchema,
    })
    .strict(),
]);

export const workerEventEnvelopeSchema = z.object({
  kind: z.literal("event"),
  requestId: z.string().min(1),
  event: workerEventSchema,
});

export const workerNotificationSchema = z.discriminatedUnion("type", [
  workerLinkPeerSignalNotificationSchema,
  workerLinkPeerCandidateNotificationSchema,
  z
    .object({
      type: z.literal("chat.turn.outcome"),
      chatId: z.string().min(1),
      clientMessageId: z.string().min(1),
      executionLaneId: z.string().min(1),
      contextKind: chatContextKindSchema.default("project"),
      worktreeId: z.string().min(1).nullable(),
      scratchRootId: z.string().min(1).nullable().default(null),
      taskDispatchFence: taskDispatchWorkerLeaseSchema
        .omit({ leaseExpiresAt: true })
        .optional(),
      outcome: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          result: agentTurnResultSchema,
        }),
        z.object({
          ok: z.literal(false),
          error: z.string().min(1),
        }),
      ]),
    })
    .superRefine((notification, context) => {
      if (
        (notification.contextKind === "project" &&
          notification.worktreeId !== null &&
          notification.scratchRootId === null) ||
        (notification.contextKind === "standalone" &&
          notification.worktreeId === null &&
          notification.scratchRootId !== null)
      ) {
        return;
      }
      context.addIssue({
        code: "custom",
        message: "Chat turn outcome execution root is invalid.",
        path: ["contextKind"],
      });
    }),
  z
    .object({
      type: z.literal("chat.thread.changed"),
      threadId: z.string().min(1).max(200),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      changes: z
        .array(z.enum(["turn", "goal", "queue", "plan"]))
        .min(1)
        .max(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal.runtime.observed"),
      terminalId: z.string().min(1).max(200),
      workerProcessGeneration: z.string().min(1).max(200),
      status: z.literal("exited"),
      exitCode: z.number().int(),
      signal: z.number().int().nullable(),
    })
    .strict(),
  workerLogStreamBatchSchema
    .extend({
      type: z.literal("diagnostics.logs.observed"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
    })
    .strict(),
  z.object({
    type: z.literal("worktree.inventory.observed"),
    projectId: worktreeObservationTargetSchema.shape.projectId,
    sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
    inventory: worktreeInventorySchema,
  }),
  z.object({
    type: z.literal("worktree.status.observed"),
    projectId: worktreeObservationTargetSchema.shape.projectId,
    worktreeId: worktreeObservationTargetSchema.shape.worktreeId,
    sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
    worktreePath: worktreeObservationTargetSchema.shape.worktreePath,
    result: worktreeStatusResultSchema,
  }),
  z
    .object({
      type: z.literal("worktree.filesystem.changed"),
      projectId: worktreeObservationTargetSchema.shape.projectId,
      worktreeId: worktreeObservationTargetSchema.shape.worktreeId,
      sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
      worktreePath: worktreeObservationTargetSchema.shape.worktreePath,
    })
    .strict(),
  z
    .object({
      type: z.literal("git.operation.observed"),
      projectId: z.string().uuid(),
      worktreeId: z.string().min(1).max(200),
      operationId: z.string().uuid(),
      sourcePath: worktreeObservationTargetSchema.shape.sourcePath,
      worktreePath: worktreeObservationTargetSchema.shape.worktreePath,
      fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
      observedAt: z.string().datetime({ offset: true }),
      state: gitOperationObservationStateSchema,
      conflicts: z
        .object({
          files: z.array(gitConflictSummarySchema).max(2_000),
          truncated: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("codegraph.status.observed"),
      status: codeGraphProjectStatusSchema,
    })
    .strict(),
  runConfigurationRuntimeWorkerNotificationSchema,
  runConfigurationDefinitionChangeNotificationSchema,
  providerAuthStatusObservationSchema,
]);

const directWorkerEventTypes = new Set<WorkerEvent["type"]>([
  "agent.activity",
  "agent.inference-progress",
  "agent.message",
  "agent.protected-message",
  "agent.protected-task-message",
]);

const directWorkerNotificationTopics = new Map<
  WorkerNotification["type"],
  "filesystem" | "runtime" | "worktree"
>([
  ["worktree.filesystem.changed", "filesystem"],
  ["worktree.inventory.observed", "worktree"],
  ["worktree.status.observed", "worktree"],
  ["git.operation.observed", "worktree"],
  ["terminal.runtime.observed", "runtime"],
  ["codegraph.status.observed", "runtime"],
  ["project.run-configuration-runtime.observed", "runtime"],
  ["project.run-configuration-definitions.changed", "runtime"],
]);

export function workerEventIsProvisional(event: WorkerEvent): boolean {
  if (!directWorkerEventTypes.has(event.type)) return false;
  if (event.type === "agent.message") {
    return (
      event.message.streaming === true || event.message.phase === "commentary"
    );
  }
  if (
    event.type === "agent.protected-message" ||
    event.type === "agent.protected-task-message"
  ) {
    return (
      event.telemetry.kind === "activity" ||
      event.telemetry.kind === "usage" ||
      (event.telemetry.kind === "message" &&
        (event.telemetry.streaming === true ||
          event.telemetry.phase === "commentary"))
    );
  }
  return true;
}

export const workerObservationPayloadSchema = z.discriminatedUnion("topic", [
  z
    .object({
      topic: z.literal("chat-progress"),
      chatId: z.string().min(1).max(200),
      clientMessageId: z.string().min(1).max(200),
      executionLaneId: z.string().min(1).max(200),
      contextKind: chatContextKindSchema,
      worktreeId: z.string().min(1).max(200).nullable(),
      scratchRootId: z.string().min(1).max(200).nullable(),
      event: workerEventSchema,
    })
    .strict()
    .superRefine((payload, context) => {
      if (
        (payload.contextKind === "project" &&
          payload.worktreeId !== null &&
          payload.scratchRootId === null) ||
        (payload.contextKind === "standalone" &&
          payload.worktreeId === null &&
          payload.scratchRootId !== null)
      ) {
        // The observation retains the exact execution root needed to render a
        // provisional message before the server publishes its durable row.
      } else {
        context.addIssue({
          code: "custom",
          path: ["contextKind"],
          message: "The observation execution root is invalid.",
        });
      }
      if (!workerEventIsProvisional(payload.event)) {
        context.addIssue({
          code: "custom",
          path: ["event"],
          message:
            "Final messages, outcomes, approvals, and durable worker events cannot use the provisional observation channel.",
        });
      }
    }),
  z
    .object({
      topic: z.enum(["filesystem", "worktree", "runtime"]),
      notification: workerNotificationSchema,
    })
    .strict()
    .superRefine((payload, context) => {
      if (
        directWorkerNotificationTopics.get(payload.notification.type) !==
        payload.topic
      ) {
        context.addIssue({
          code: "custom",
          path: ["notification"],
          message:
            "This worker notification is not authorized for the selected provisional observation topic.",
        });
      }
    }),
]);

export const workerObservationEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    subscriptionId: z.string().uuid(),
    continuitySequence: z.number().int().nonnegative().safe(),
    observedAt: z.iso.datetime(),
    identity: workerObservationEventIdentitySchema,
    payload: workerObservationPayloadSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(envelope)).byteLength >
      512 * 1_024
    ) {
      context.addIssue({
        code: "custom",
        message: "Worker observation envelopes may contain at most 512 KiB.",
      });
    }
  });

export const workerNotificationEnvelopeSchema = z.object({
  kind: z.literal("notification"),
  notification: workerNotificationSchema,
});

export const workerServerEnvelopeSchema = z.union([
  workerResponseEnvelopeSchema,
  workerEventEnvelopeSchema,
  workerNotificationEnvelopeSchema,
]);

export type ExplorerEntry = z.infer<typeof explorerEntrySchema>;
export type ExplorerEntryName = z.infer<typeof explorerEntryNameSchema>;
export type ExplorerEntryRename = z.infer<typeof explorerEntryRenameSchema>;
export type ExplorerEntryDelete = z.infer<typeof explorerEntryDeleteSchema>;
export type ExplorerEntryMutationResult = z.infer<
  typeof explorerEntryMutationResultSchema
>;
export type ExplorerDirectory = z.infer<typeof explorerDirectorySchema>;
export type ExplorerLastCommit = z.infer<typeof explorerLastCommitSchema>;
export type ExplorerDirectoryCommitEntry = z.infer<
  typeof explorerDirectoryCommitEntrySchema
>;
export type ExplorerDirectoryCommits = z.infer<
  typeof explorerDirectoryCommitsSchema
>;
export type ExplorerFile = z.infer<typeof explorerFileSchema>;
export type ExplorerMediaKind = z.infer<typeof explorerMediaKindSchema>;
export type ExplorerMediaFile = z.infer<typeof explorerMediaFileSchema>;
export type ExplorerMediaFileChunk = z.infer<
  typeof explorerMediaFileChunkSchema
>;
export type ExplorerFileWrite = z.infer<typeof explorerFileWriteSchema>;

export type ChatAttachmentKind = z.infer<typeof chatAttachmentKindSchema>;
export type ChatAttachmentSource = z.infer<typeof chatAttachmentSourceSchema>;
export type ChatAttachmentSummary = z.infer<typeof chatAttachmentSummarySchema>;

export type WorkflowNodeExecutionWorkerResult = z.infer<
  typeof workflowNodeExecutionResultSchema
>;

export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;

export type WorkerObservationPayload = z.infer<
  typeof workerObservationPayloadSchema
>;
export type WorkerObservationEnvelope = z.infer<
  typeof workerObservationEnvelopeSchema
>;
export type InferenceProgressPhase = z.infer<
  typeof inferenceProgressPhaseSchema
>;
export type InferenceProgressPrecision = z.infer<
  typeof inferenceProgressPrecisionSchema
>;
export type InferenceProgressSource = z.infer<
  typeof inferenceProgressSourceSchema
>;
export type InferenceProgressSnapshot = z.infer<
  typeof inferenceProgressSnapshotSchema
>;
export type InferenceProgressUpdate = z.infer<
  typeof inferenceProgressUpdateSchema
>;
export type WorkerRequestEnvelope = z.infer<typeof workerRequestEnvelopeSchema>;
export type WorkerConnectionEnvelope = z.infer<
  typeof workerConnectionEnvelopeSchema
>;
export type WorkerResponseEnvelope = z.infer<
  typeof workerResponseEnvelopeSchema
>;
export type WorkerEventEnvelope = z.infer<typeof workerEventEnvelopeSchema>;
export type WorkerNotification = z.infer<typeof workerNotificationSchema>;
export type WorkerNotificationEnvelope = z.infer<
  typeof workerNotificationEnvelopeSchema
>;
export type WorkerServerEnvelope = z.infer<typeof workerServerEnvelopeSchema>;

export function decodeWorkerRequestEnvelope(
  encoded: string,
): JsonMessageDecodeResult<WorkerRequestEnvelope> {
  return decodeJsonMessage(encoded, workerRequestEnvelopeSchema);
}

export function decodeWorkerConnectionEnvelope(
  encoded: string,
): JsonMessageDecodeResult<WorkerConnectionEnvelope> {
  return decodeJsonMessage(encoded, workerConnectionEnvelopeSchema);
}

export function decodeWorkerServerEnvelope(
  encoded: string,
): JsonMessageDecodeResult<WorkerServerEnvelope> {
  return decodeJsonMessage(encoded, workerServerEnvelopeSchema);
}

export function encodeWorkerRequestEnvelope(
  envelope: WorkerRequestEnvelope,
): string {
  return encodeJsonMessage(envelope, workerRequestEnvelopeSchema);
}

export function encodeWorkerConnectionEnvelope(
  envelope: WorkerConnectionEnvelope,
): string {
  return encodeJsonMessage(envelope, workerConnectionEnvelopeSchema);
}

export function encodeWorkerServerEnvelope(
  envelope: WorkerServerEnvelope,
): string {
  return encodeJsonMessage(envelope, workerServerEnvelopeSchema);
}
