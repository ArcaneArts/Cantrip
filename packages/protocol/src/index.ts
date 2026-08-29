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

export const chatMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export const agentMessagePhaseSchema = z.enum(["commentary", "final_answer"]);
export const workerObservationEventIdentitySchema = z
  .object({
    operationId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200).nullable(),
    messageId: z.string().min(1).max(200).nullable(),
    sequence: z.number().int().nonnegative().safe(),
  })
  .strict();
export const agentActivityStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "declined",
]);
export const agentCommandOutputLimitBytes = 256 * 1_024;
export const agentFilePreviewLimitCharacters = 8_192;
export const agentActivityRawRequestLimitBytes = 64 * 1_024;
export const agentActivityRawResponseLimitBytes = 256 * 1_024;

function encodedTextLimitSchema(limit: number) {
  return z.string().superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength <= limit) return;
    context.addIssue({
      code: "custom",
      message: `Raw capture text may contain at most ${limit} encoded bytes.`,
    });
  });
}

const agentActivityRawDocumentBaseShape = {
  mediaType: z.string().min(1).max(200),
  originalBytes: z.number().int().nonnegative().safe(),
  truncated: z.boolean(),
  digest: z.string().min(1).max(200).nullable().optional(),
  omittedReason: z.string().min(1).max(500).nullable().optional(),
};

export const agentActivityRawRequestDocumentSchema = z.object({
  ...agentActivityRawDocumentBaseShape,
  text: encodedTextLimitSchema(agentActivityRawRequestLimitBytes).nullable(),
});

export const agentActivityRawResponseDocumentSchema = z.object({
  ...agentActivityRawDocumentBaseShape,
  text: encodedTextLimitSchema(agentActivityRawResponseLimitBytes).nullable(),
});

export const agentActivityRawEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  request: agentActivityRawRequestDocumentSchema.nullable(),
  response: agentActivityRawResponseDocumentSchema.nullable(),
  metadata: z
    .record(z.string().min(1).max(100), z.string().max(4_000))
    .refine((value) => Object.keys(value).length <= 32, {
      message: "Raw capture metadata may contain at most 32 entries.",
    }),
});

const agentActivityTimestampSchema = z.number().int().nonnegative().safe();
const agentCommandOutputSchema = z.string().superRefine((value, context) => {
  const size = new TextEncoder().encode(value).byteLength;
  if (size <= agentCommandOutputLimitBytes) return;
  context.addIssue({
    code: "custom",
    message: `Agent command output may contain at most ${agentCommandOutputLimitBytes} encoded bytes.`,
  });
});
export const codexEventCorrelationSchema = z.object({
  sourceMethod: z.string().min(1).max(200),
  diagnosticId: z.string().min(1).max(200).nullable(),
  threadId: z.string().min(1).max(200).nullable(),
  turnId: z.string().min(1).max(200).nullable(),
  itemId: z.string().min(1).max(200).nullable(),
});

export const agentScopeSchema = z
  .object({
    agentThreadId: z.string().min(1).max(200),
    rootThreadId: z.string().min(1).max(200),
    parentThreadId: z.string().min(1).max(200).nullable(),
    rootTurnId: z.string().min(1).max(200),
    agentPath: z.array(z.string().min(1).max(200)).max(32),
    nickname: z.string().min(1).max(200).nullable(),
    role: z.string().min(1).max(500).nullable(),
    depth: z.number().int().nonnegative().max(32),
    isRoot: z.boolean(),
  })
  .strict();

export const agentCommunicationKindSchema = z.enum([
  "spawned",
  "messageSent",
  "followupSent",
  "waiting",
  "statusChanged",
  "interrupted",
  "returned",
  "failed",
]);

const agentActivityBaseShape = {
  id: z.string().min(1),
  status: agentActivityStatusSchema,
  startedAtMs: agentActivityTimestampSchema.optional(),
  updatedAtMs: agentActivityTimestampSchema.optional(),
  completedAtMs: agentActivityTimestampSchema.nullable().optional(),
  correlation: codexEventCorrelationSchema.nullable().optional(),
  agentScope: agentScopeSchema.optional(),
  raw: agentActivityRawEnvelopeSchema.optional(),
};

export const agentTokenUsageSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
});

const rateLimitWindowSchema = z.object({
  usedPercent: z.number().min(0),
  windowDurationMins: z.number().int().nonnegative().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
});

export const agentActivitySchema = z.discriminatedUnion("type", [
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("instructionContext"),
    provenance: z.enum(["exact", "assembled", "unavailable"]),
    text: z.string().max(agentActivityRawRequestLimitBytes).nullable(),
    sources: z.array(z.string().min(1).max(500)).max(100),
    model: z.string().max(200).nullable(),
    provider: z.string().max(200).nullable(),
    reasoningEffort: z.string().max(100).nullable(),
    collaborationMode: z.string().max(100).nullable(),
    permissionProfile: z.string().max(200).nullable(),
    runtimeVersion: z.string().max(100).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("command"),
    command: z.string().min(1),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    output: z.string().nullable(),
    outputTail: agentCommandOutputSchema.nullable().optional(),
    outputTruncated: z.boolean().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("fileChange"),
    changes: z.array(
      z.object({
        path: z.string().min(1),
        kind: z.enum(["add", "delete", "update"]),
        latestLine: z
          .string()
          .max(agentFilePreviewLimitCharacters)
          .nullable()
          .optional(),
        diffPreview: z
          .string()
          .max(agentFilePreviewLimitCharacters)
          .nullable()
          .optional(),
        lastActivityAtMs: agentActivityTimestampSchema.optional(),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("worktree"),
    operation: z.string().min(1),
    summary: z.string().min(1),
    worktreeId: z.string().min(1).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("plan"),
    text: z.string(),
    explanation: z.string().nullable(),
    steps: z.array(
      z.object({
        step: z.string().min(1),
        status: z.enum(["pending", "inProgress", "completed"]),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("reasoning"),
    summary: z.array(z.string().min(1)).max(100),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("mcpToolCall"),
    server: z.string().min(1),
    tool: z.string().min(1),
    query: z.string().max(4_000).nullable().optional(),
    resultText: z.string().max(20_000).nullable().optional(),
    error: z.string().nullable(),
    errorCode: z.string().min(1).max(200).nullable().optional(),
    retryable: z.boolean().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("dynamicToolCall"),
    namespace: z.string().min(1).nullable(),
    tool: z.string().min(1),
    success: z.boolean().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("collabToolCall"),
    tool: z.string().min(1),
    senderThreadId: z.string().min(1),
    receiverThreadIds: z.array(z.string().min(1)).max(100),
    prompt: z.string().nullable(),
    model: z.string().nullable(),
    agentStates: z.array(
      z.object({
        threadId: z.string().min(1),
        status: z.string().min(1),
        message: z.string().nullable(),
      }),
    ),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("subAgent"),
    kind: z.enum(["started", "interacted", "interrupted"]),
    agentThreadId: z.string().min(1),
    agentPath: z.string().min(1),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("agentCommunication"),
    kind: agentCommunicationKindSchema,
    senderThreadId: z.string().min(1).max(200),
    receiverThreadIds: z.array(z.string().min(1).max(200)).max(100),
    message: z.string().max(100_000).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("webSearch"),
    query: z.string(),
    action: z.string().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("imageView"),
    path: z.string().min(1),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("reviewMode"),
    state: z.enum(["entered", "exited"]),
    review: z.string(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("contextCompaction"),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("notice"),
    level: z.enum(["warning", "error"]),
    message: z.string().min(1),
    details: z.string().nullable(),
    willRetry: z.boolean().nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("usage"),
    total: agentTokenUsageSchema,
    last: agentTokenUsageSchema,
    modelContextWindow: z.number().int().positive().nullable(),
    contextUsedPercent: z.number().min(0).nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("rateLimit"),
    limitId: z.string().nullable().default(null),
    limitName: z.string().nullable(),
    planType: z.string().nullable(),
    reachedType: z.string().nullable(),
    primary: rateLimitWindowSchema.nullable(),
    secondary: rateLimitWindowSchema.nullable(),
  }),
  z.object({
    ...agentActivityBaseShape,
    type: z.literal("turnSummary"),
    durationMs: z.number().int().nonnegative().nullable(),
    startedAt: z.number().int().nonnegative().nullable(),
    completedAt: z.number().int().nonnegative().nullable(),
  }),
]);
export const chatMessageContentSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("text"),
      text: z.string().min(1),
      phase: agentMessagePhaseSchema.nullable().optional(),
      streaming: z.boolean().optional(),
      correlation: codexEventCorrelationSchema.nullable().optional(),
      agentScope: agentScopeSchema.optional(),
      sourceEvent: workerObservationEventIdentitySchema.optional(),
    }),
    z.object({
      type: z.literal("activity"),
      activity: agentActivitySchema,
      sourceEvent: workerObservationEventIdentitySchema.optional(),
    }),
    z.object({
      type: z.literal("attachment"),
      attachment: chatAttachmentSummarySchema,
    }),
  ]),
);

export const chatTurnModeSchema = z.enum(["default", "plan", "goal"]);

export const chatComposerDraftSchema = z
  .object({
    text: z.string().max(100_000),
    mode: chatTurnModeSchema,
    reasoningEffort: reasoningEffortSchema.nullable(),
  })
  .strict();

export const chatMessageCreateSchema = z.object({
  role: chatMessageRoleSchema,
  content: chatMessageContentSchema.min(1),
  mode: chatTurnModeSchema.optional(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const chatMessageSchema = chatMessageCreateSchema
  .omit({ idempotencyKey: true })
  .extend({
    id: z.string().min(1),
    chatId: z.string().min(1),
    contextKind: chatContextKindSchema.default("project"),
    worktreeId: z.string().min(1).nullable(),
    scratchRootId: z.string().min(1).nullable().default(null),
    executionLaneId: z.string().min(1).nullable(),
    sequence: z.number().int().positive(),
    mode: chatTurnModeSchema.default("default"),
    reasoningEffort: reasoningEffortSchema.nullable().default(null),
    modelId: z.string().min(1).nullable(),
    modelRouteId: z.string().min(1).nullable(),
    providerId: z.string().min(1).nullable(),
    providerName: z.string().min(1).nullable(),
    providerModelName: z.string().min(1).nullable(),
    appliedReasoningEffort: reasoningEffortSchema.nullable().default(null),
    reasoningAdjusted: z.boolean().default(false),
    createdAt: z.string().datetime(),
  })
  .superRefine((message, context) => {
    if (
      (message.contextKind === "project" &&
        message.worktreeId !== null &&
        message.scratchRootId === null) ||
      (message.contextKind === "standalone" &&
        message.worktreeId === null &&
        message.scratchRootId !== null)
    ) {
      return;
    }
    context.addIssue({
      code: "custom",
      message: "Chat message execution root is invalid.",
      path: ["contextKind"],
    });
  });

export const chatRelocationStateSchema = z.enum([
  "queued",
  "waiting-for-idle",
  "validating",
  "preparing-replica",
  "transferring-attachments",
  "hydrating-runtime",
  "ready-to-commit",
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
]);

export const chatRelocationErrorCodeSchema = z.enum([
  "target-not-found",
  "target-mismatch",
  "worker-offline",
  "capability-missing",
  "replica-not-ready",
  "worktree-dirty",
  "revision-diverged",
  "attachment-unavailable",
  "runtime-incompatible",
  "stale-attempt",
  "policy-denied",
  "worker-error",
]);

export const chatRelocationErrorSchema = z.object({
  code: chatRelocationErrorCodeSchema,
  message: z.string().min(1).max(4_000),
  retryable: z.boolean(),
});

export const chatRelocationJobErrorSchema = chatRelocationErrorSchema.omit({
  message: true,
});

export const chatRelocationProgressStageSchema = z.enum([
  "queued",
  "waiting-for-idle",
  "recovering",
  "validating",
  "preparing-replica",
  "transferring-attachments",
  "hydrating-runtime",
  "ready-to-commit",
  "blocked",
  "failed",
  "succeeded",
  "cancelled",
]);

export const chatRelocationProgressSchema = z.object({
  stage: chatRelocationProgressStageSchema,
  percent: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),
});

export const chatRelocationContextMessageSchema = z.object({
  sequence: z.number().int().positive(),
  role: chatMessageRoleSchema,
  mode: chatTurnModeSchema,
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  content: chatMessageContentSchema,
  createdAt: z.string().datetime(),
});

export const taskRelocationContextMessageSchema =
  taskMessageOpaqueSummarySchema;

export const chatRelocationAttachmentAvailabilitySchema = z.object({
  attachment: chatAttachmentOpaqueSummarySchema,
  sourceWorkerId: z.string().min(1).max(200),
  availableWorkerIds: z.array(z.string().min(1).max(200)).max(1_000),
});

export const chatRelocationContextPayloadSchema = z.union([
  z.object({
    version: z.literal(1),
    kind: z.literal("visible").default("visible"),
    messages: z.array(chatRelocationContextMessageSchema).max(100_000),
    attachments: z.array(chatRelocationAttachmentAvailabilitySchema).max(2_000),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("task-encrypted"),
    messages: z.array(taskRelocationContextMessageSchema).max(100_000),
    attachments: z.array(chatRelocationAttachmentAvailabilitySchema).max(2_000),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("chat-encrypted"),
    messages: z.array(chatMessageOpaqueSummarySchema).max(100_000),
    attachments: z.array(chatRelocationAttachmentAvailabilitySchema).max(2_000),
  }),
]);

export const chatRelocationSnapshotSummarySchema = z.object({
  id: z.string().uuid(),
  chatId: z.string().min(1),
  sourcePlacement: executionPlacementSchema,
  throughSequence: z.number().int().nonnegative(),
  transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  messageCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  modelId: z.string().min(1).nullable(),
  modelRouteId: z.string().min(1).nullable(),
  permissionProfileId: z.string().min(1).max(200).nullable(),
  requiredRevision: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{40,64}$/u),
  createdAt: z.string().datetime(),
});

export const chatRelocationHydrationBeginResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("upload") }),
    z.object({
      status: z.literal("hydrated"),
      threadId: z.string().min(1),
    }),
  ],
);

export const chatRelocationHydrationResultSchema = z.object({
  snapshotId: z.string().uuid(),
  transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  threadId: z.string().min(1),
  reused: z.boolean(),
});

export const chatRelocationJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  chatId: z.string().min(1),
  state: chatRelocationStateSchema,
  stateRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
  sourcePlacement: executionPlacementSchema,
  sourcePlacementRevision: z.number().int().positive(),
  targetPlacement: executionPlacementSchema,
  contextSnapshotId: z.string().uuid(),
  targetRuntimeThreadId: z.string().min(1).nullable(),
  targetModelRouteId: z.string().min(1).nullable(),
  targetProviderAccountId: z.string().min(1).nullable().default(null),
  attempt: z.number().int().nonnegative(),
  progress: chatRelocationProgressSchema,
  error: chatRelocationJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  cancellationUnsafeAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const chatRelocationJobListSchema = z
  .array(chatRelocationJobSummarySchema)
  .max(1_000);

export const chatRelocationCreateSchema = z.object({
  target: executionTargetSchema,
  approved: z.literal(true),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const chatRelocationJobRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const chatRelocationJobCancelSchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const chatExecutionLaneActorSchema = z.enum(["agent", "user"]);
export const chatExecutionLaneStateSchema = z.enum([
  "active",
  "suspended",
  "delivering",
  "released",
]);
const chatExecutionLaneSummaryBaseSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  workerId: z.string().min(1),
  acquiringActor: chatExecutionLaneActorSchema,
  exclusive: z.boolean(),
  purpose: z.string().min(1).nullable(),
  state: chatExecutionLaneStateSchema,
  baseRevision: z.string().min(1).nullable(),
  startingHead: z.string().min(1).nullable(),
  runtimeSessionId: z.string().min(1).nullable(),
  codexThreadId: z.string().min(1).nullable(),
  transitionKind: z.enum(["switch", "release"]).nullable(),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  releasedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export const projectChatExecutionLaneSummarySchema =
  chatExecutionLaneSummaryBaseSchema.extend({
    contextKind: z.literal("project").default("project"),
    worktreeId: z.string().min(1),
    scratchRootId: z.null().default(null),
  });

export const standaloneChatExecutionLaneSummarySchema =
  chatExecutionLaneSummaryBaseSchema.extend({
    contextKind: z.literal("standalone"),
    worktreeId: z.null(),
    scratchRootId: z.string().min(1),
  });

export const contextualChatExecutionLaneSummarySchema = z.union([
  projectChatExecutionLaneSummarySchema,
  standaloneChatExecutionLaneSummarySchema,
]);

export const chatExecutionLaneSummarySchema =
  chatExecutionLaneSummaryBaseSchema.extend({
    contextKind: z.literal("project").optional(),
    worktreeId: z.string().min(1),
    scratchRootId: z.null().optional(),
  });

export const chatExecutionLaneListSchema = z.array(
  chatExecutionLaneSummarySchema,
);

export const chatExecutionLaneReleaseSchema = z.object({
  allowDirty: z.boolean().default(false),
  returnToPrimary: z.boolean().default(true),
});

export const agentInteractionRequestKindSchema = z.enum([
  "commandExecution",
  "fileChange",
  "permissions",
  "userInput",
  "mcpElicitation",
]);

export const agentInteractionRequestStatusSchema = z.enum([
  "pending",
  "resolved",
  "expired",
  "interrupted",
]);

export const agentInteractionProvenanceSchema = z.object({
  chatId: z.string().min(1).nullable(),
  threadId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  itemId: z.string().min(1).nullable(),
  executionLaneId: z.string().min(1).nullable(),
  workflowRunId: z.string().min(1).nullable(),
  workflowNodeId: z.string().min(1).nullable(),
  workerId: z.string().min(1),
});

export const agentInteractionRequestPayloadSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("commandExecution"),
      startedAtMs: z.number().int().nonnegative(),
      approvalId: z.string().min(1).nullable(),
      environmentId: z.string().min(1).nullable(),
      reason: z.string().nullable(),
      command: z.string().nullable(),
      cwd: z.string().nullable(),
      commandActions: z.json().nullable().optional(),
      networkApprovalContext: z
        .object({
          host: z.string().min(1),
          protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
        })
        .nullable(),
      additionalPermissions: z.json().nullable(),
      proposedExecpolicyAmendment: z.array(z.string()).nullable(),
      proposedNetworkPolicyAmendments: z
        .array(
          z.object({
            host: z.string().min(1),
            action: z.enum(["allow", "deny"]),
          }),
        )
        .nullable(),
      availableDecisions: z
        .array(
          z.enum([
            "accept",
            "acceptForSession",
            "acceptWithExecpolicyAmendment",
            "applyNetworkPolicyAmendment",
            "decline",
            "cancel",
          ]),
        )
        .nullable(),
    }),
    z.object({
      kind: z.literal("fileChange"),
      startedAtMs: z.number().int().nonnegative(),
      reason: z.string().nullable(),
      grantRoot: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("permissions"),
      startedAtMs: z.number().int().nonnegative(),
      environmentId: z.string().min(1).nullable(),
      cwd: z.string().min(1),
      reason: z.string().nullable(),
      requestedPermissions: z.json(),
    }),
    z.object({
      kind: z.literal("userInput"),
      questions: z
        .array(
          z.object({
            id: z.string().min(1),
            header: z.string().min(1),
            question: z.string().min(1),
            isOther: z.boolean(),
            isSecret: z.boolean(),
            options: z
              .array(
                z.object({
                  label: z.string().min(1),
                  description: z.string(),
                }),
              )
              .nullable(),
          }),
        )
        .min(1)
        .max(3),
      autoResolutionMs: z.number().int().nonnegative().nullable(),
    }),
    z.object({
      kind: z.literal("mcpElicitation"),
      serverName: z.string().min(1),
      mode: z.enum(["form", "openai/form", "url"]),
      message: z.string().min(1),
      requestedSchema: z.json().nullable(),
      url: z.url().nullable(),
      elicitationId: z.string().min(1).nullable(),
      metadata: z.json().nullable(),
    }),
  ],
);

export const agentInteractionResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commandExecution"),
    decision: z.enum([
      "accept",
      "acceptForSession",
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment",
      "decline",
      "cancel",
    ]),
    execpolicyAmendment: z.array(z.string()).nullable().default(null),
    networkPolicyAmendment: z
      .object({
        host: z.string().min(1),
        action: z.enum(["allow", "deny"]),
      })
      .nullable()
      .default(null),
  }),
  z.object({
    kind: z.literal("fileChange"),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  }),
  z.object({
    kind: z.literal("permissions"),
    permissions: z.json(),
    scope: z.enum(["turn", "session"]),
    strictAutoReview: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("userInput"),
    answers: z.record(
      z.string().min(1),
      z.object({ answers: z.array(z.string()).min(1) }),
    ),
  }),
  z.object({
    kind: z.literal("mcpElicitation"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.json().nullable(),
    metadata: z.json().nullable().default(null),
  }),
]);

function fitsAgentInteractionStorageLimit(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= 1_000_000;
  } catch {
    return false;
  }
}

export const agentInteractionRequestCreateSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    projectId: z.string().min(1).nullable(),
    provenance: agentInteractionProvenanceSchema,
    payload: agentInteractionRequestPayloadSchema,
    expiresAt: z.string().datetime().nullable(),
  })
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Agent interaction request exceeds the 1 MB storage limit.",
  });

export const agentInteractionResolutionCreateSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    response: agentInteractionResponseSchema,
  })
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Agent interaction response exceeds the 1 MB storage limit.",
  });

export const encryptedAgentInteractionRequestCreateSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    projectId: z.string().min(1).nullable(),
    provenance: agentInteractionProvenanceSchema,
    ...interactionRequestOpaqueContentSchema.shape,
    expiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Protected agent interaction request exceeds the storage limit.",
  });

export const encryptedAgentInteractionResolutionCreateSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    ...interactionResponseOpaqueContentSchema.shape,
  })
  .strict()
  .refine(fitsAgentInteractionStorageLimit, {
    message: "Protected agent interaction response exceeds the storage limit.",
  });

export const agentInteractionRuntimeRequestSchema = z.object({
  requestKey: z.string().min(1).max(200),
  threadId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  itemId: z.string().min(1).nullable(),
  payload: agentInteractionRequestPayloadSchema,
  expiresAt: z.string().datetime(),
});

export const encryptedAgentInteractionRuntimeRequestSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    threadId: z.string().min(1),
    turnId: z.string().min(1).nullable(),
    itemId: z.string().min(1).nullable(),
    ...interactionRequestOpaqueContentSchema.shape,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const agentInteractionAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const agentInteractionRequestSchema = z
  .object({
    id: z.string().min(1),
    requestKey: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    provenance: agentInteractionProvenanceSchema,
    payload: agentInteractionRequestPayloadSchema,
    status: agentInteractionRequestStatusSchema,
    response: agentInteractionResponseSchema.nullable(),
    resolvedByUserId: z.string().min(1).nullable(),
    expiresAt: z.string().datetime().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((request, context) => {
    if (request.response && request.response.kind !== request.payload.kind) {
      context.addIssue({
        code: "custom",
        path: ["response", "kind"],
        message: "Response kind must match request kind.",
      });
    }
    const terminalWithoutResponse =
      request.status === "expired" || request.status === "interrupted";
    if (request.status === "pending") {
      if (request.response || request.resolvedByUserId || request.resolvedAt) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Pending requests cannot contain resolution data.",
        });
      }
    } else if (request.status === "resolved") {
      if (
        !request.response ||
        !request.resolvedByUserId ||
        !request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Resolved requests require response and resolution data.",
        });
      }
    } else if (
      terminalWithoutResponse &&
      (request.response || request.resolvedByUserId || !request.resolvedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Expired and interrupted requests require a terminal timestamp without a response.",
      });
    }
  });

export const agentInteractionRequestListSchema = z.array(
  agentInteractionRequestSchema,
);

export const encryptedAgentInteractionRequestSchema = z
  .object({
    id: z.string().min(1),
    requestKey: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    provenance: agentInteractionProvenanceSchema,
    classification: interactionProtectedClassificationSchema,
    protectedPayload:
      interactionRequestOpaqueContentSchema.shape.protectedPayload,
    status: agentInteractionRequestStatusSchema,
    protectedResponse: encryptedInteractionResponseContentSchema.nullable(),
    resolvedByUserId: z.string().min(1).nullable(),
    expiresAt: z.string().datetime().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.status === "pending") {
      if (
        request.protectedResponse ||
        request.resolvedByUserId ||
        request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Pending requests cannot contain resolution data.",
        });
      }
      return;
    }
    if (request.status === "resolved") {
      if (
        !request.protectedResponse ||
        !request.resolvedByUserId ||
        !request.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "Resolved requests require protected resolution data.",
        });
      }
      return;
    }
    if (
      request.protectedResponse ||
      request.resolvedByUserId ||
      !request.resolvedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Expired and interrupted requests require a terminal timestamp without a response.",
      });
    }
  });

export const agentInteractionRequestWireSchema = z.union([
  agentInteractionRequestSchema,
  encryptedAgentInteractionRequestSchema,
]);

export const agentInteractionRequestWireListSchema = z.array(
  agentInteractionRequestWireSchema,
);

export const agentInteractionResolutionWireCreateSchema = z.union([
  agentInteractionResolutionCreateSchema,
  encryptedAgentInteractionResolutionCreateSchema,
]);

export const agentInteractionRequestQuerySchema = z.object({
  chatId: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  status: agentInteractionRequestStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const cantripCliArgumentsSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((arguments_) => Object.keys(arguments_).length <= 20, {
    message: "Cantrip CLI commands accept at most 20 arguments.",
  });

export const cantripAgentOperationNameSchema = z.enum([
  "context.get",
  "tool.help",
  "policy.list",
  "policy.read",
  "target.list",
  "target.inspect",
  "run-configuration.list",
  "run-configuration.get",
  "run-configuration.detect",
  "run-configuration.create",
  "run-configuration.update",
  "run-configuration.delete",
  "run-configuration.start",
  "run-configuration.restart",
  "run-configuration.stop",
  "run-configuration.status",
  "run-configuration.read-output",
  "run-configuration.secret-set",
  "worktree.list",
  "worktree.status",
  "worktree.create",
  "worktree.acquire",
  "worktree.switch",
  "worktree.release",
  "worktree.remove",
  "explorer.list",
  "explorer.read",
  "explorer.write",
  "terminal.read",
  "terminal.send",
  "terminal.restart",
  "web.search",
  "web.read",
  "web.session.snapshot",
  "web.session.open",
  "web.session.click",
  "web.session.type",
  "web.session.close",
  "browser.services",
  "browser.open",
  "client.notify",
  "client.focus-project",
  "client.focus-surface",
  "client.show-interaction",
]);

export const CANTRIP_MCP_READ_OPERATIONS = [
  "context.get",
  "tool.help",
  "policy.list",
  "policy.read",
  "target.list",
  "target.inspect",
  "run-configuration.list",
  "run-configuration.get",
  "run-configuration.detect",
  "run-configuration.status",
  "run-configuration.read-output",
  "worktree.list",
  "worktree.status",
  "explorer.list",
  "explorer.read",
  "terminal.read",
  "web.search",
  "web.read",
  "web.session.snapshot",
  "browser.services",
] as const satisfies readonly z.infer<typeof cantripAgentOperationNameSchema>[];

export const CANTRIP_MCP_READ_TOOL_NAMES = [
  "context_get",
  "tool_help",
  "policy_list",
  "policy_read",
  "target_list",
  "target_inspect",
  "run_configuration_list",
  "run_configuration_get",
  "run_configuration_detect",
  "run_configuration_status",
  "run_configuration_read_output",
  "worktree_list",
  "worktree_status",
  "explorer_list",
  "explorer_read",
  "terminal_read",
  "web_search",
  "web_read",
  "web_session_snapshot",
  "browser_services",
] as const;

export const CANTRIP_MCP_WORKER_MUTATION_OPERATIONS = [
  "run-configuration.create",
  "run-configuration.update",
  "run-configuration.delete",
  "run-configuration.start",
  "run-configuration.restart",
  "run-configuration.stop",
  "run-configuration.secret-set",
  "worktree.create",
  "worktree.switch",
  "worktree.release",
  "worktree.remove",
  "explorer.write",
  "terminal.send",
  "terminal.restart",
  "web.session.open",
  "web.session.click",
  "web.session.type",
  "web.session.close",
  "browser.open",
] as const satisfies readonly z.infer<typeof cantripAgentOperationNameSchema>[];

export const CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS = [
  "client.notify",
  "client.focus-project",
  "client.focus-surface",
  "client.show-interaction",
] as const satisfies readonly z.infer<typeof cantripAgentOperationNameSchema>[];

export const CANTRIP_MCP_MUTATION_OPERATIONS = [
  ...CANTRIP_MCP_WORKER_MUTATION_OPERATIONS,
  ...CANTRIP_MCP_CLIENT_CONTROL_OPERATIONS,
] as const;

export const CANTRIP_MCP_MUTATION_TOOL_NAMES = [
  "run_configuration_create",
  "run_configuration_update",
  "run_configuration_delete",
  "run_configuration_start",
  "run_configuration_restart",
  "run_configuration_stop",
  "run_configuration_secret_set",
  "worktree_create",
  "worktree_switch",
  "worktree_release",
  "worktree_remove",
  "explorer_write",
  "terminal_send",
  "terminal_restart",
  "web_session_open",
  "web_session_click",
  "web_session_type",
  "web_session_close",
  "browser_navigate",
  "client_notify",
  "client_focus_project",
  "client_focus_surface",
  "client_show_interaction",
] as const;

export const CANTRIP_MCP_OPERATIONS = [
  ...CANTRIP_MCP_READ_OPERATIONS,
  ...CANTRIP_MCP_MUTATION_OPERATIONS,
] as const;

export const CANTRIP_MCP_TOOL_NAMES = [
  ...CANTRIP_MCP_READ_TOOL_NAMES,
  ...CANTRIP_MCP_MUTATION_TOOL_NAMES,
] as const;

export const cantripMcpToolNameSchema = z.enum(CANTRIP_MCP_TOOL_NAMES);

export function cantripMcpToolNamesForOperations(
  operations: readonly z.infer<typeof cantripAgentOperationNameSchema>[],
): Array<(typeof CANTRIP_MCP_TOOL_NAMES)[number]> {
  const allowed = new Set<string>(operations);
  return CANTRIP_MCP_OPERATIONS.flatMap((operation, index) =>
    allowed.has(operation) ? [CANTRIP_MCP_TOOL_NAMES[index]!] : [],
  );
}

export function isCantripMcpMutationOperation(
  operation: z.infer<typeof cantripAgentOperationNameSchema>,
): boolean {
  return (CANTRIP_MCP_MUTATION_OPERATIONS as readonly string[]).includes(
    operation,
  );
}

export function cantripMcpOperationsForPermissionProfile(
  permissionProfileId: string,
): readonly z.infer<typeof cantripAgentOperationNameSchema>[] {
  return permissionProfileId === ":read-only"
    ? CANTRIP_MCP_READ_OPERATIONS.filter(
        (operation) => operation !== "web.session.snapshot",
      )
    : CANTRIP_MCP_OPERATIONS;
}

export const cantripAgentOperationArgumentsSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((arguments_) => Object.keys(arguments_).length <= 32, {
    message: "Cantrip agent operations accept at most 32 arguments.",
  });

export const cantripAgentOperationRequestSchema = z
  .object({
    operation: cantripAgentOperationNameSchema,
    arguments: cantripAgentOperationArgumentsSchema,
  })
  .strict();

const cantripMcpBindingBaseFields = {
  bindingId: z.string().uuid(),
  ownerId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200),
  executionLaneId: z.string().min(1).max(200),
  workerId: z.string().min(1).max(200),
  permissionProfileId: permissionProfileIdSchema,
  allowedOperations: z
    .array(cantripAgentOperationNameSchema)
    .min(1)
    .max(cantripAgentOperationNameSchema.options.length)
    .refine((operations) => new Set(operations).size === operations.length, {
      message: "Cantrip MCP binding operations must be unique.",
    }),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
};

const cantripMcpProjectBindingSchema = z
  .object({
    ...cantripMcpBindingBaseFields,
    contextKind: z.literal("project"),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema,
    scratchRootId: z.null(),
  })
  .strict();

const cantripMcpStandaloneBindingSchema = z
  .object({
    ...cantripMcpBindingBaseFields,
    contextKind: z.literal("standalone"),
    projectId: z.null(),
    worktreeId: z.null(),
    rootKind: z.null(),
    scratchRootId: z.string().min(1).max(200),
  })
  .strict();

export const cantripMcpBindingSchema = z
  .discriminatedUnion("contextKind", [
    cantripMcpProjectBindingSchema,
    cantripMcpStandaloneBindingSchema,
  ])
  .superRefine((binding, context) => {
    const issuedAt = Date.parse(binding.issuedAt);
    const expiresAt = Date.parse(binding.expiresAt);
    if (expiresAt <= issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Cantrip MCP bindings must expire after they are issued.",
      });
    }
    if (expiresAt - issuedAt > 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Cantrip MCP bindings cannot live longer than 24 hours.",
      });
    }
  });

export const cantripMcpConnectionDocumentSchema = z
  .object({
    protocolVersion: z.literal(1),
    endpoint: z.url(),
    bindingId: z.string().uuid(),
    credential: z.string().min(32).max(512),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const cantripMcpBrokerOperationRequestSchema = z
  .object({
    bindingId: z.string().uuid(),
    request: cantripAgentOperationRequestSchema,
  })
  .strict();

export const workerCantripMcpOperationCallSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    binding: cantripMcpBindingSchema,
    request: cantripAgentOperationRequestSchema,
  })
  .strict();

const compatibleCantripMcpBindingBaseFields = {
  ...cantripMcpBindingBaseFields,
  canonicalRoot: z.string().min(1).max(8_192).optional(),
  allowedOperations: z.array(z.string().min(1).max(100)).min(1).max(100),
};

const compatibleCantripMcpBindingSchema = z.union([
  z.object({
    ...compatibleCantripMcpBindingBaseFields,
    contextKind: z.literal("project").optional(),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    rootKind: projectRootKindSchema,
    scratchRootId: z.null().optional(),
  }),
  z.object({
    ...compatibleCantripMcpBindingBaseFields,
    contextKind: z.literal("standalone"),
    projectId: z.null(),
    worktreeId: z.null(),
    rootKind: z.null(),
    scratchRootId: z.string().min(1).max(200),
  }),
]);

/**
 * Accepts both the current binding and the legacy binding used during rolling
 * worker/server upgrades. Unknown binding claims never grant authority: they
 * are discarded, and only locally known operation names survive normalization.
 */
export const compatibleWorkerCantripMcpOperationCallSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    binding: compatibleCantripMcpBindingSchema,
    request: cantripAgentOperationRequestSchema,
  })
  .strict()
  .transform(({ binding, ...call }) => {
    const {
      canonicalRoot: _legacyCanonicalRoot,
      allowedOperations,
      ...currentBinding
    } = binding;
    return {
      ...call,
      binding: {
        ...currentBinding,
        contextKind: currentBinding.contextKind ?? "project",
        scratchRootId: currentBinding.scratchRootId ?? null,
        allowedOperations: allowedOperations.filter(
          (operation) =>
            cantripAgentOperationNameSchema.safeParse(operation).success,
        ),
      },
    };
  })
  .pipe(workerCantripMcpOperationCallSchema);

export const CANTRIP_MCP_BINDING_PROTOCOL_VERSIONS = [1, 2] as const;

export const workerCantripMcpCapabilitiesQuerySchema = z
  .object({
    workerId: z.string().min(1).max(200),
  })
  .strict();

export const workerCantripMcpServerCapabilitiesSchema = z
  .object({
    bindingProtocolVersions: z
      .array(z.number().int().min(1).max(100))
      .min(1)
      .max(10)
      .refine((versions) => new Set(versions).size === versions.length, {
        message: "Cantrip MCP binding protocol versions must be unique.",
      }),
    operations: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(100)
      .refine((operations) => new Set(operations).size === operations.length, {
        message: "Cantrip MCP server operations must be unique.",
      }),
  })
  .strict();

export const cantripAgentOperationResultSchema = z.object({
  summary: z.string().min(1).max(2_000),
  target: executionTargetSchema.nullable().default(null),
  worktreeId: z.string().min(1).nullable().default(null),
  continuationScheduled: z.boolean().default(false),
  mutated: z.boolean().default(false),
  data: z.unknown().optional(),
});

const cantripMcpReadResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: executionTargetSchema.nullable().default(null),
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.literal(false).default(false),
  })
  .strict();

export const cantripMcpContextGetInputSchema = z.object({}).strict();
export const cantripMcpToolHelpInputSchema = z
  .object({ tool: cantripMcpToolNameSchema })
  .strict();
export const cantripMcpBindingStaleClaimSchema = z.enum([
  "context-kind",
  "chat",
  "project",
  "scratch-root",
  "worker",
  "execution-lane",
  "worktree",
  "root-kind",
  "permission-profile",
  "chat-status",
]);
export const cantripMcpBindingReadinessSchema = z
  .object({
    status: z.enum(["ready", "read-only", "refresh-required"]),
    mutationReady: z.boolean(),
    staleClaims: z.array(cantripMcpBindingStaleClaimSchema).max(10),
    recoveryInstruction: z.string().min(1).max(500).nullable(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const cantripMcpPolicyListInputSchema = z.object({}).strict();
export const cantripMcpPolicyReadInputSchema = z
  .object({ key: policyKeySchema })
  .strict();
export const cantripMcpTargetListInputSchema = z
  .object({
    kind: executionTargetResourceKindSchema.optional(),
    cursor: z.number().int().min(0).max(1_999).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const cantripMcpTargetInspectInputSchema = z
  .object({ target: executionTargetSchema })
  .strict();
export const cantripMcpRunConfigurationListInputSchema = z.object({}).strict();
export const cantripMcpRunConfigurationGetInputSchema = z
  .object({ configurationId: runConfigurationIdSchema })
  .strict();
export const cantripMcpRunConfigurationDetectInputSchema = z
  .object({ provider: runConfigurationProviderKindSchema.optional() })
  .strict();
export const cantripMcpRunConfigurationCreateInputSchema = z
  .object({
    operationId: z.string().uuid(),
    document: runConfigurationFileSchema,
  })
  .strict();
export const cantripMcpRunConfigurationUpdateInputSchema = z
  .object({
    operationId: z.string().uuid(),
    configurationId: runConfigurationIdSchema,
    expectedRevision: runConfigurationRevisionSchema,
    document: runConfigurationFileSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.configurationId !== input.document.id) {
      context.addIssue({
        code: "custom",
        message: "The requested and document configuration IDs must match.",
        path: ["document", "id"],
      });
    }
  });
export const cantripMcpRunConfigurationDeleteInputSchema = z
  .object({
    operationId: z.string().uuid(),
    configurationId: runConfigurationIdSchema,
    expectedRevision: runConfigurationRevisionSchema,
  })
  .strict();
const cantripMcpRunConfigurationTargetInputFields = {
  operationId: z.string().uuid(),
  configurationId: runConfigurationIdSchema,
  worktreeId: z.string().min(1).max(200).nullable().default(null),
};
export const cantripMcpRunConfigurationStartInputSchema = z
  .object(cantripMcpRunConfigurationTargetInputFields)
  .strict();
export const cantripMcpRunConfigurationRestartInputSchema = z
  .object(cantripMcpRunConfigurationTargetInputFields)
  .strict();
export const cantripMcpRunConfigurationStopInputSchema = z
  .object(cantripMcpRunConfigurationTargetInputFields)
  .strict();
export const cantripMcpRunConfigurationStatusInputSchema = z
  .object({
    configurationId: runConfigurationIdSchema.nullable().default(null),
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    limit: z.number().int().positive().max(256).default(256),
  })
  .strict();
export const cantripMcpRunConfigurationReadOutputInputSchema = z
  .object({
    ...cantripMcpRunConfigurationTargetInputFields,
    tail: z.number().int().positive().max(100_000).default(10_000),
  })
  .strict();
export const cantripMcpRunConfigurationSecretSetInputSchema = z
  .object({
    operationId: z.string().uuid(),
    reference: runConfigurationSecretReferenceSchema,
    value: runConfigurationSecretValueContentSchema.shape.value,
  })
  .strict();
export const cantripMcpWorktreeListInputSchema = z
  .object({
    cursor: z.number().int().min(0).max(1_999).default(0),
    limit: z.number().int().min(1).max(200).default(100),
    includeLeaseHistory: z.boolean().default(false),
  })
  .strict();
export const cantripMcpWorktreeStatusInputSchema = z
  .object({
    target: z
      .object({
        kind: z.literal("worktree"),
        projectId: z.string().min(1).max(200),
        worktreeId: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    fileLimit: z.number().int().min(1).max(2_000).default(500),
    branchLimit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

const cantripMcpSurfaceTargetSchema = <
  Kind extends "browser" | "explorer" | "terminal",
>(
  kind: Kind,
) =>
  z
    .object({
      kind: z.literal("surface"),
      projectId: z.string().min(1).max(200),
      surfaceKind: z.literal(kind),
      surfaceId: z.string().min(1).max(200),
    })
    .strict();

export const cantripMcpExplorerListInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    path: z.string().max(8_192).default(""),
    cursor: z.number().int().min(0).max(999).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const cantripMcpExplorerReadInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    path: z.string().min(1).max(8_192),
    maxChars: z.number().int().min(1).max(200_000).default(100_000),
  })
  .strict();
export const cantripMcpTerminalReadInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    maxChars: z.number().int().min(1).max(100_000).default(20_000),
  })
  .strict();
const cantripWebDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u,
    "Domains must be hostnames without a scheme or path.",
  )
  .overwrite((value) => value.toLowerCase());
export const cantripMcpWebSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    count: z.number().int().min(1).max(20).default(10),
    page: z.number().int().min(1).max(5).default(1),
    freshness: z.enum(["day", "month", "year"]).optional(),
    language: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)
      .optional(),
    category: z.enum(["general", "news", "science", "it"]).default("general"),
    safeSearch: z.enum(["off", "moderate", "strict"]).default("moderate"),
    includeDomains: z.array(cantripWebDomainSchema).max(10).default([]),
    excludeDomains: z.array(cantripWebDomainSchema).max(10).default([]),
  })
  .strict()
  .superRefine((input, context) => {
    const included = new Set(input.includeDomains);
    for (const [index, domain] of input.excludeDomains.entries()) {
      if (included.has(domain)) {
        context.addIssue({
          code: "custom",
          message: "A domain cannot be both included and excluded.",
          path: ["excludeDomains", index],
        });
      }
    }
  });
export const cantripMcpWebReadInputSchema = z
  .object({
    url: z.url().max(8_192).optional(),
    searchResultId: z
      .string()
      .regex(/^wsr_[A-Za-z0-9_-]{32}$/u)
      .optional(),
    cursor: z
      .string()
      .regex(/^wrc_[A-Za-z0-9_-]{32}$/u)
      .optional(),
    maxChars: z.number().int().min(1_000).max(100_000).default(20_000),
    render: z.enum(["never", "auto", "always"]).default("auto"),
  })
  .strict()
  .superRefine((input, context) => {
    const initialSources =
      Number(Boolean(input.url)) + Number(Boolean(input.searchResultId));
    if (input.cursor ? initialSources !== 0 : initialSources !== 1) {
      context.addIssue({
        code: "custom",
        message: input.cursor
          ? "A continuation cursor cannot be combined with a URL or search result ID."
          : "Provide exactly one of url or searchResultId.",
        path: input.cursor ? ["cursor"] : [],
      });
    }
  });
const cantripWebSessionIdSchema = z.string().regex(/^wss_[A-Za-z0-9_-]{32}$/u);
const cantripWebElementRefSchema = z.string().regex(/^wer_[A-Za-z0-9_-]{32}$/u);
export const cantripMcpWebSessionOpenInputSchema = z
  .object({
    url: z.url().max(8_192),
    sessionId: cantripWebSessionIdSchema.optional(),
    browserTarget: cantripMcpSurfaceTargetSchema("browser").optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.sessionId && input.browserTarget) {
      context.addIssue({
        code: "custom",
        message: "A resumed session already has a fixed profile target.",
        path: ["browserTarget"],
      });
    }
  });
export const cantripMcpWebSessionSnapshotInputSchema = z
  .object({
    sessionId: cantripWebSessionIdSchema,
    maxChars: z.number().int().min(1_000).max(50_000).default(20_000),
  })
  .strict();
export const cantripMcpWebSessionClickInputSchema = z
  .object({
    sessionId: cantripWebSessionIdSchema,
    elementRef: cantripWebElementRefSchema,
  })
  .strict();
export const cantripMcpWebSessionTypeInputSchema = z
  .object({
    sessionId: cantripWebSessionIdSchema,
    elementRef: cantripWebElementRefSchema,
    text: z.string().max(4_000),
    submit: z.boolean().default(false),
  })
  .strict();
export const cantripMcpWebSessionCloseInputSchema = z
  .object({ sessionId: cantripWebSessionIdSchema })
  .strict();
export const cantripMcpBrowserServicesInputSchema = z
  .object({ target: cantripMcpSurfaceTargetSchema("browser") })
  .strict();

const cantripMcpWorktreeTargetSchema = z
  .object({
    kind: z.literal("worktree"),
    projectId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
  })
  .strict();

export const cantripMcpWorktreeCreateInputSchema = z.discriminatedUnion(
  "intent",
  [
    z
      .object({
        intent: z.literal("newBranch"),
        name: z.string().trim().min(1).max(200),
        branch: z.string().trim().min(1).max(255),
        baseRevision: z
          .string()
          .trim()
          .min(1)
          .max(1_024)
          .optional()
          .describe(
            "Optional starting revision; matches CLI --base-revision (legacy alias --from).",
          ),
      })
      .strict(),
    z
      .object({
        intent: z.literal("existingBranch"),
        name: z.string().trim().min(1).max(200),
        branch: z.string().trim().min(1).max(255),
      })
      .strict(),
    z
      .object({
        intent: z.literal("detached"),
        name: z.string().trim().min(1).max(200),
        baseRevision: z
          .string()
          .trim()
          .min(1)
          .max(1_024)
          .describe(
            "Required detached revision; CLI expresses this variant with --detach.",
          ),
      })
      .strict(),
  ],
);
export const cantripMcpWorktreeSwitchInputSchema = z
  .object({
    target: cantripMcpWorktreeTargetSchema,
    purpose: z.string().trim().min(1).max(500),
  })
  .strict();
export const cantripMcpWorktreeReleaseInputSchema = z
  .object({ purpose: z.string().trim().min(1).max(500) })
  .strict();
export const cantripMcpWorktreeRemoveInputSchema = z
  .object({ target: cantripMcpWorktreeTargetSchema })
  .strict();
export const cantripMcpExplorerWriteInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    path: explorerFileWriteSchema.shape.path,
    content: z.string().max(200_000),
    version: explorerFileWriteSchema.shape.version,
  })
  .strict();
export const cantripMcpTerminalSendInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z.string().max(100_000),
  })
  .strict();
export const cantripMcpTerminalRestartInputSchema = z
  .object({ target: cantripMcpSurfaceTargetSchema("terminal") })
  .strict();
export const cantripMcpBrowserNavigateInputSchema = z
  .object({
    target: cantripMcpSurfaceTargetSchema("browser"),
    url: browserHttpUrlSchema,
  })
  .strict();
export const cantripMcpClientNotifyInputSchema = z
  .object({
    level: z.enum(["info", "warning", "error"]).default("info"),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();
export const cantripMcpClientFocusProjectInputSchema = z.object({}).strict();
export const cantripMcpClientSurfaceTargetSchema = z.discriminatedUnion(
  "surfaceKind",
  [
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("chat"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("terminal"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("explorer"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("code"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("browser"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
  ],
);
export const cantripMcpClientFocusSurfaceInputSchema = z
  .object({ target: cantripMcpClientSurfaceTargetSchema })
  .strict();
export const cantripMcpClientShowInteractionInputSchema = z
  .object({ interactionId: z.string().min(1).max(200) })
  .strict();

export const cantripMcpContextGetResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: z
      .object({
        worker: z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().min(1).max(200),
            online: z.boolean(),
          })
          .strict(),
        context: z
          .object({
            chatId: z.string().min(1).max(200).nullable(),
            executionLaneId: z.string().min(1).max(200).nullable(),
            permissionProfileId: permissionProfileIdSchema.nullable(),
            projectId: z.string().min(1).max(200),
            rootKind: projectRootKindSchema,
            terminalId: z.string().min(1).max(200).nullable(),
            workerId: z.string().min(1).max(200),
            worktreeId: z.string().min(1).max(200),
            worktreeMode: z.enum(["agent-managed", "pinned"]).nullable(),
          })
          .strict(),
        binding: cantripMcpBindingReadinessSchema,
      })
      .strict(),
  });
export const cantripMcpToolHelpResultSchema = cantripMcpReadResultBaseSchema
  .extend({
    target: z.null().default(null),
    data: z
      .object({
        tool: cantripMcpToolNameSchema,
        inputSchema: z.record(z.string(), z.unknown()),
        examples: z.array(z.record(z.string(), z.unknown())).max(3),
        notes: z.array(z.string().min(1).max(500)).max(8),
      })
      .strict(),
  })
  .strict();
export const cantripMcpPolicyListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: policyCliListResultSchema,
  });
export const cantripMcpPolicyReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: policyCliReadResultSchema,
  });
export const cantripMcpTargetListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: z
      .object({
        projectId: z.string().min(1).max(200),
        targets: z.array(executionTargetDescriptorSchema).max(200),
        cursor: z.number().int().min(0).max(1_999),
        nextCursor: z.number().int().positive().max(2_000).nullable(),
        total: z.number().int().nonnegative().max(2_000),
        truncated: z.boolean(),
      })
      .strict(),
  });
export const cantripMcpTargetInspectResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: executionTargetSchema,
    data: executionTargetResolutionSchema
      .extend({
        stateRevision: z.number().int().positive().nullable(),
      })
      .strict(),
  });
const cantripMcpRunConfigurationProjectTargetSchema = z
  .object({
    kind: z.literal("project"),
    projectId: z.string().min(1).max(200),
  })
  .strict();
const cantripMcpRunConfigurationResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: cantripMcpRunConfigurationProjectTargetSchema,
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.boolean(),
  })
  .strict();
const cantripMcpRunConfigurationReadResultBaseSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    mutated: z.literal(false).default(false),
  });
export const cantripMcpRunConfigurationListResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationListResponseSchema
      .extend({
        runtimes: runConfigurationRuntimeStatusResultSchema.shape.runtimes,
      })
      .strict(),
  });
export const cantripMcpRunConfigurationGetResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationGetResponseSchema,
  });
export const cantripMcpRunConfigurationDetectResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationDetectResponseSchema,
  });
export const cantripMcpRunConfigurationStatusResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    data: runConfigurationRuntimeStatusResultSchema,
  });
export const cantripMcpRunConfigurationReadOutputResultSchema =
  cantripMcpRunConfigurationReadResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationRuntimeOutputSchema,
  });
export const cantripMcpRunConfigurationCreateResultSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationWriteResponseSchema,
  });
export const cantripMcpRunConfigurationUpdateResultSchema =
  cantripMcpRunConfigurationCreateResultSchema;
export const cantripMcpRunConfigurationDeleteResultSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    worktreeId: z.string().min(1).max(200),
    mutated: z.literal(true),
    data: runConfigurationDeleteResponseSchema,
  });
const cantripMcpRunConfigurationLifecycleResultSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: runConfigurationRuntimeOperationResultSchema,
  });
export const cantripMcpRunConfigurationStartResultSchema =
  cantripMcpRunConfigurationLifecycleResultSchema;
export const cantripMcpRunConfigurationRestartResultSchema =
  cantripMcpRunConfigurationLifecycleResultSchema;
export const cantripMcpRunConfigurationStopResultSchema =
  cantripMcpRunConfigurationLifecycleResultSchema;
export const cantripMcpRunConfigurationSecretSetResultSchema =
  cantripMcpRunConfigurationResultBaseSchema.extend({
    worktreeId: z.null().default(null),
    data: runConfigurationSecretSetResultSchema,
  });

export const cantripMcpWorktreeSummarySchema = projectWorktreeSummarySchema
  .omit({ path: true, displayPath: true })
  .strict();
export const cantripMcpWorktreeListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z.null().default(null),
    data: z
      .object({
        currentWorktreeId: z.string().min(1).max(200),
        worktrees: z.array(cantripMcpWorktreeSummarySchema).max(200),
        leases: z.array(chatExecutionLaneSummarySchema).max(1_000),
        cursor: z.number().int().min(0).max(1_999),
        nextCursor: z.number().int().positive().max(2_000).nullable(),
        total: z.number().int().nonnegative().max(2_000),
        truncated: z.boolean(),
      })
      .strict(),
  });
export const cantripMcpExplorerListResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    data: z
      .object({
        path: z.string().max(8_192),
        entries: z.array(explorerEntrySchema).max(200),
        cursor: z.number().int().min(0).max(999),
        nextCursor: z.number().int().positive().max(1_000).nullable(),
        total: z.number().int().nonnegative().max(1_000),
        truncated: z.boolean(),
      })
      .strict(),
  });
export const cantripMcpExplorerReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    data: explorerFileSchema.extend({
      content: z.string().max(200_000),
      truncated: z.boolean(),
    }),
  });
export const cantripMcpTerminalReadResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z
      .object({
        status: z.enum(["running", "restarting", "exited", "not-running"]),
        data: z.string().max(100_000),
        truncated: z.boolean(),
        exitCode: z.number().int().nullable(),
      })
      .strict(),
  });
const cantripWebSearchResultRowSchema = z
  .object({
    id: z.string().regex(/^wsr_[A-Za-z0-9_-]{32}$/u),
    title: z.string().max(1_000),
    url: z.url().max(8_192),
    snippet: z.string().max(4_000),
    engines: z.array(z.string().min(1).max(100)).max(10),
    publishedAt: z.iso.datetime().nullable(),
  })
  .strict();
export const cantripMcpWebSearchResultSchema = cantripMcpReadResultBaseSchema
  .extend({
    target: z.null().default(null),
    data: z
      .object({
        query: z.string().max(500),
        results: z.array(cantripWebSearchResultRowSchema).max(20),
        diagnostics: z
          .array(
            z
              .object({
                engine: z.string().min(1).max(100),
                category: z.enum([
                  "captcha",
                  "rate-limited",
                  "timeout",
                  "unavailable",
                  "unknown",
                ]),
                message: z.string().min(1).max(500),
              })
              .strict(),
          )
          .max(10),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const cantripMcpWebReadResultSchema = cantripMcpReadResultBaseSchema
  .extend({
    target: z.null().default(null),
    data: z
      .object({
        url: z.url().max(8_192),
        title: z.string().max(1_000),
        content: z.string().max(100_000),
        method: z.enum(["static", "plain-text", "rendered"]),
        retrievedAt: z.iso.datetime(),
        cursor: z
          .string()
          .regex(/^wrc_[A-Za-z0-9_-]{32}$/u)
          .nullable(),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
const cantripWebSessionStateSchema = z
  .object({
    sessionId: cantripWebSessionIdSchema,
    url: z.url().max(8_192),
    title: z.string().max(1_000),
    generation: z.number().int().positive(),
    persistent: z.boolean(),
  })
  .strict();
const cantripMcpWebSessionMutationResultBaseSchema =
  cantripMcpReadResultBaseSchema
    .extend({
      target: z.null().default(null),
      mutated: z.literal(true),
    })
    .strict();
export const cantripMcpWebSessionOpenResultSchema =
  cantripMcpWebSessionMutationResultBaseSchema.extend({
    data: cantripWebSessionStateSchema,
  });
export const cantripMcpWebSessionSnapshotResultSchema =
  cantripMcpReadResultBaseSchema
    .extend({
      target: z.null().default(null),
      data: cantripWebSessionStateSchema
        .extend({
          snapshot: z.string().max(50_000),
          elements: z
            .array(
              z
                .object({
                  ref: cantripWebElementRefSchema,
                  description: z.string().min(1).max(1_000),
                })
                .strict(),
            )
            .max(100),
          truncated: z.boolean(),
        })
        .strict(),
    })
    .strict();
export const cantripMcpWebSessionActionResultSchema =
  cantripMcpWebSessionMutationResultBaseSchema.extend({
    data: cantripWebSessionStateSchema,
  });
export const cantripMcpWebSessionCloseResultSchema =
  cantripMcpWebSessionMutationResultBaseSchema.extend({
    data: z
      .object({ sessionId: cantripWebSessionIdSchema, closed: z.literal(true) })
      .strict(),
  });
export const cantripMcpBrowserServicesResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("browser"),
    data: browserServiceListSchema,
  });

const cantripMcpMutationResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: executionTargetSchema,
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.literal(true),
  })
  .strict();
const cantripMcpContinuationResultBaseSchema =
  cantripMcpMutationResultBaseSchema.extend({
    continuationScheduled: z.literal(true),
  });
const cantripMcpTransitionDataSchema = z
  .object({
    lane: z
      .object({
        id: z.string().min(1).max(200),
        state: chatExecutionLaneStateSchema,
        transitionKind: z.enum(["switch", "release"]),
      })
      .strict(),
    worktree: cantripMcpWorktreeSummarySchema,
  })
  .strict();

export const cantripMcpWorktreeCreateResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: z.object({ worktree: cantripMcpWorktreeSummarySchema }).strict(),
  });
export const cantripMcpWorktreeSwitchResultSchema =
  cantripMcpContinuationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: cantripMcpTransitionDataSchema,
  });
export const cantripMcpWorktreeReleaseResultSchema =
  cantripMcpContinuationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: cantripMcpTransitionDataSchema,
  });
export const cantripMcpWorktreeRemoveResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpWorktreeTargetSchema,
    worktreeId: z.string().min(1).max(200),
    data: z
      .object({
        removedWorktreeId: z.string().min(1).max(200),
        branchRetained: z.literal(true),
      })
      .strict(),
  });
export const cantripMcpExplorerWriteResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("explorer"),
    data: explorerFileSchema.omit({ content: true }).strict(),
  });
export const cantripMcpTerminalSendResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z.object({ accepted: z.literal(true) }).strict(),
  });
export const cantripMcpTerminalRestartResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("terminal"),
    data: z.object({ status: z.literal("running") }).strict(),
  });
export const cantripMcpBrowserNavigateResultSchema =
  cantripMcpMutationResultBaseSchema.extend({
    target: cantripMcpSurfaceTargetSchema("browser"),
    data: z
      .object({
        url: browserHttpUrlSchema,
        stateRevision: z.number().int().positive().safe(),
      })
      .strict(),
  });

const cantripMcpClientControlDataSchema = z
  .object({
    correlationId: z.string().uuid(),
    status: clientControlResultStatusSchema,
  })
  .strict();
const cantripMcpClientControlResultBaseSchema = z
  .object({
    summary: z.string().min(1).max(2_000),
    target: executionTargetSchema,
    worktreeId: z.string().min(1).max(200).nullable().default(null),
    continuationScheduled: z.literal(false).default(false),
    mutated: z.boolean(),
    data: cantripMcpClientControlDataSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.mutated === (result.data.status === "applied")) return;
    context.addIssue({
      code: "custom",
      path: ["mutated"],
      message: "Client-control mutation state must match its applied status.",
    });
  });
export const cantripMcpClientNotifyResultSchema =
  cantripMcpClientControlResultBaseSchema.safeExtend({
    target: z
      .object({
        kind: z.literal("project"),
        projectId: z.string().min(1).max(200),
      })
      .strict(),
  });
export const cantripMcpClientFocusProjectResultSchema =
  cantripMcpClientNotifyResultSchema;
export const cantripMcpClientFocusSurfaceResultSchema =
  cantripMcpClientControlResultBaseSchema.safeExtend({
    target: cantripMcpClientSurfaceTargetSchema,
  });
export const cantripMcpClientShowInteractionResultSchema =
  cantripMcpClientControlResultBaseSchema.safeExtend({
    target: z
      .object({
        kind: z.literal("surface"),
        projectId: z.string().min(1).max(200),
        surfaceKind: z.literal("chat"),
        surfaceId: z.string().min(1).max(200),
      })
      .strict(),
  });

// The human CLI is a compatibility adapter over the same operation result
// contract used by worker-owned agent transports.
export const cantripCliCommandResultSchema = cantripAgentOperationResultSchema;

export const cantripCliCommandNameSchema = z.enum([
  "status",
  "policy.list",
  "policy.read",
  "worktree.list",
  "worktree.create",
  "worktree.switch",
  "worktree.status",
  "worktree.release",
  "worktree.remove",
  "target.list",
  "target.show",
  "run.list",
  "run.show",
  "run.detect",
  "run.create",
  "run.update",
  "run.delete",
  "run.start",
  "run.restart",
  "run.status",
  "run.logs",
  "run.stop",
  "run.secret-set",
  "target.resolve-browser",
  "target.resolve-explorer",
  "target.resolve-terminal",
  "explorer.list",
  "explorer.read",
  "explorer.write",
  "terminal.read",
  "terminal.send",
  "terminal.restart",
  "browser.services",
  "browser.create",
  "browser.open",
]);

export const cantripCliContextSchema = z
  .object({
    codexThreadId: z.string().min(1).max(200).nullable().default(null),
    terminalId: z.string().min(1).max(200).nullable().default(null),
    cwd: z.string().min(1).max(8_192).nullable().default(null),
    selection: z.enum(["auto", "cwd", "lane"]).default("auto"),
  })
  .strict();

export const cantripCliCommandRequestSchema = z
  .object({
    command: cantripCliCommandNameSchema,
    context: cantripCliContextSchema,
    arguments: cantripCliArgumentsSchema,
  })
  .strict();

export const workerCliCommandCallSchema = cantripCliCommandRequestSchema
  .extend({
    chatContext: z
      .object({
        chatId: z.string().min(1).max(200),
        executionLaneId: z.string().min(1).max(200),
      })
      .strict()
      .nullable()
      .default(null),
    requestId: z.string().min(1).max(200),
    workerId: z.string().min(1).max(200),
  })
  .strict();

export const chatMessageListSchema = z.array(chatMessageSchema);

export const CHAT_MESSAGE_PAGE_DEFAULT_LIMIT = 150;
export const CHAT_MESSAGE_PAGE_MAX_LIMIT = 200;
export const CHAT_MESSAGE_PAGE_BOUNDARY_MAX = 500;

export const chatMessagePageQuerySchema = z
  .object({
    beforeSequence: z.coerce.number().int().positive().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CHAT_MESSAGE_PAGE_MAX_LIMIT)
      .default(CHAT_MESSAGE_PAGE_DEFAULT_LIMIT),
  })
  .strict();

export const chatMessagePageInfoSchema = z
  .object({
    hasMore: z.boolean(),
    nextBeforeSequence: z.number().int().positive().nullable(),
    oldestSequence: z.number().int().positive().nullable(),
    newestSequence: z.number().int().positive().nullable(),
    startsAtUserTurn: z.boolean(),
  })
  .strict();

export const chatMessageWireListSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task-encrypted"),
      messages: z.array(taskMessageOpaqueSummarySchema).max(100_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat-encrypted"),
      messages: z.array(chatMessageOpaqueSummarySchema).max(100_000),
    })
    .strict(),
]);

export const chatMessageWirePageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task-encrypted"),
      messages: z
        .array(taskMessageOpaqueSummarySchema)
        .max(CHAT_MESSAGE_PAGE_BOUNDARY_MAX),
      page: chatMessagePageInfoSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat-encrypted"),
      messages: z
        .array(chatMessageOpaqueSummarySchema)
        .max(CHAT_MESSAGE_PAGE_BOUNDARY_MAX),
      page: chatMessagePageInfoSchema,
    })
    .strict(),
]);

export const encryptedQueuedPromptSchema = queuedPromptOpaqueContentSchema
  .extend({
    chatId: z.string().min(1).max(200),
    attachments: chatAttachmentOpaqueListSchema.default([]),
    position: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const encryptedQueuedPromptListSchema = z
  .array(encryptedQueuedPromptSchema)
  .max(1_000);

export const encryptedChatTurnCreateSchema = z
  .object({
    message: chatMessageOpaqueContentSchema,
    queuedPrompt: queuedPromptOpaqueContentSchema,
    modelId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      JSON.stringify(value.message) !==
      JSON.stringify(value.queuedPrompt.pendingMessage)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The queued prompt must carry the submitted encrypted message.",
        path: ["queuedPrompt", "pendingMessage"],
      });
    }
    if (
      value.modelId !== undefined &&
      value.modelId !== value.queuedPrompt.modelId
    ) {
      context.addIssue({
        code: "custom",
        message: "The queued prompt model must match the submitted model.",
        path: ["queuedPrompt", "modelId"],
      });
    }
  });

export const projectAutomationProtectedDispatchResultSchema = z
  .object({
    allowed: z.boolean(),
    protectedTurn: encryptedChatTurnCreateSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.allowed !== Boolean(value.protectedTurn)) {
      context.addIssue({
        code: "custom",
        message: "Allowed automation dispatches require a protected turn.",
        path: ["protectedTurn"],
      });
    }
  });

export const encryptedQueuedPromptUpdateSchema = z
  .object({ prompt: queuedPromptOpaqueContentSchema })
  .strict();

export const encryptedChatPromptSubmitResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("started"),
        message: chatMessageOpaqueSummarySchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("queued"),
        prompt: encryptedQueuedPromptSchema,
      })
      .strict(),
  ],
);

export const chatTurnCreateSchema = z
  .object({
    text: z.string().trim().max(100_000).default(""),
    attachmentIds: z.array(z.string().min(1)).max(20).default([]),
    mode: chatTurnModeSchema.default("default"),
    idempotencyKey: z.string().min(1).max(200),
    modelId: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
  })
  .refine(
    ({ attachmentIds, text }) => text.length > 0 || attachmentIds.length > 0,
    { message: "A prompt needs text or at least one attachment." },
  )
  .refine(({ mode, text }) => mode !== "goal" || text.length > 0, {
    message: "Goal mode needs a text objective.",
  });

export const queuedPromptSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  text: z.string().trim().max(100_000),
  attachments: chatAttachmentListSchema.default([]),
  mode: chatTurnModeSchema.default("default"),
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  customSubagentModel: z.boolean().default(false),
  subagentModelId: z.string().min(1).nullable().default(null),
  subagentReasoningEffort: reasoningEffortSchema.nullable().default(null),
  worktreeId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative(),
  frozen: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const queuedPromptListSchema = z.array(queuedPromptSchema);

export const queuedPromptCreateSchema = chatTurnCreateSchema.extend({
  frozen: z.boolean().default(false),
  worktreeId: z.string().min(1).nullable().default(null),
});

export const queuedPromptUpdateSchema = z
  .object({
    text: z.string().trim().max(100_000).optional(),
    attachmentIds: z.array(z.string().min(1)).max(20).optional(),
    mode: chatTurnModeSchema.optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    frozen: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.text !== undefined ||
      value.attachmentIds !== undefined ||
      value.mode !== undefined ||
      value.reasoningEffort !== undefined ||
      value.frozen !== undefined,
    { message: "At least one queued prompt field is required." },
  );

export const queuedPromptOrderSchema = z.object({
  ids: z.array(z.string().min(1)).max(1_000),
});

export const chatModelUpdateSchema = z.object({
  modelId: z.string().min(1),
});

export const chatModelConfigurationUpdateSchema =
  modelConfigurationSchema.refine(
    (configuration) => configuration.modelId !== null,
    {
      message: "A root model must be selected.",
      path: ["modelId"],
    },
  );

export const chatRuntimeSelectionSchema = z.object({
  modelRouteId: z.string().min(1).nullable(),
  providerAccountId: z.string().min(1).nullable(),
});

export const chatReasoningOptionSchema = modelReasoningEffortOptionSchema;

export const chatReasoningStateSchema = z.object({
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable(),
  options: z.array(chatReasoningOptionSchema).max(32),
  reasoningMandatory: z.boolean(),
  incompleteMetadata: z.boolean(),
});

export const chatReasoningUpdateSchema = z.object({
  reasoningEffort: reasoningEffortSchema.nullable(),
});

export const chatTurnAcceptedSchema = z.object({
  accepted: z.literal(true),
  message: chatMessageSchema,
});

export const chatPromptSubmitResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started"), message: chatMessageSchema }),
  z.object({ status: z.literal("queued"), prompt: queuedPromptSchema }),
]);

export const chatPromptSteerResultSchema = z.object({
  steered: z.literal(true),
  message: chatMessageSchema,
});

export const encryptedChatPromptSteerResultSchema = z
  .object({
    steered: z.literal(true),
    message: chatMessageOpaqueSummarySchema,
  })
  .strict();

export const chatCompactAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const chatInterruptAcceptedSchema = z.object({
  interrupted: z.boolean(),
});

export const chatTurnRollbackAcceptedSchema = z.object({
  rolledBack: z.literal(true),
});

export const chatPauseUpdateSchema = z.object({
  paused: z.boolean(),
});

export const chatPauseStateSchema = z.object({
  paused: z.boolean(),
});

export const chatPauseRuntimeStateSchema = z
  .object({
    paused: z.boolean(),
    active: z
      .object({
        threadId: z.string().min(1).max(500),
        turnId: z.string().min(1).max(500),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const threadGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export const threadGoalSchema = z.object({
  threadId: z.string().min(1),
  objective: z.string().min(1),
  status: threadGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const chatGoalResponseSchema = z.object({
  goal: threadGoalSchema.nullable(),
});

export const chatGoalWireResponseSchema = z.union([
  z
    .object({
      kind: z.literal("task-encrypted"),
      goal: taskGoalObjectiveOpaqueSnapshotSchema.nullable(),
    })
    .strict(),
  chatGoalResponseSchema,
]);

export const chatGoalCreateSchema = z.object({
  objective: z.string().trim().min(1).max(100_000),
  tokenBudget: z.number().int().positive().nullable().optional(),
});

export const chatGoalUpdateSchema = z.object({
  status: z.enum(["active", "paused"]),
});

export const chatGoalClearSchema = z.object({
  cleared: z.boolean(),
});

export const planModeSchema = z.enum(["default", "plan"]);

export const planStepSchema = z.object({
  step: z.string().min(1),
  status: z.enum(["pending", "inProgress", "completed"]),
});

export const planQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
});

export const planQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(planQuestionOptionSchema).min(1).nullable(),
});

export const pendingPlanQuestionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  questions: z.array(planQuestionSchema).min(1).max(3),
  createdAt: z.string().datetime(),
});

export const chatPlanStateSchema = z.object({
  mode: planModeSchema,
  explanation: z.string().nullable(),
  steps: z.array(planStepSchema),
  question: pendingPlanQuestionSchema.nullable(),
});

export const encryptedChatPlanWireStateSchema = z
  .object({
    kind: z.literal("chat-encrypted"),
    chatId: z.string().min(1).max(200),
    mode: planModeSchema,
    hasQuestion: z.boolean(),
    state: chatPlanOpaqueStateSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.state &&
      value.state.classification.hasQuestion !== value.hasQuestion
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted plan question metadata is inconsistent.",
        path: ["state", "classification", "hasQuestion"],
      });
    }
    if (!value.state && value.hasQuestion) {
      context.addIssue({
        code: "custom",
        message: "Pending encrypted plans require protected state.",
        path: ["state"],
      });
    }
  });

export const projectTaskWorkloadOpaqueItemSchema = z
  .object({
    task: taskOpaqueSummarySchema,
    plan: encryptedChatPlanWireStateSchema,
    messages: z
      .array(taskMessageOpaqueSummarySchema)
      .max(CHAT_MESSAGE_PAGE_BOUNDARY_MAX),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.plan.chatId !== value.task.chatId ||
      value.messages.some((message) => message.chatId !== value.task.chatId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Task workload material must belong to the same Task Chat.",
      });
    }
  });

export const projectTaskWorkloadOpaqueSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    items: z.array(projectTaskWorkloadOpaqueItemSchema).max(10_000),
  })
  .strict();

export const chatPlanUpdateSchema = z.object({ mode: planModeSchema });

export const chatPlanAnswerSchema = z.object({
  answers: z.record(
    z.string().min(1),
    z.array(z.string().trim().min(1).max(10_000)).min(1).max(16),
  ),
});

export const chatPlanAcceptedSchema = z.object({
  accepted: z.literal(true),
  requestKey: z.string().min(1).optional(),
});

export const githubWorkerRepositorySchema = githubRepositorySchema.omit({
  imported: true,
});

export const githubWorkerRepositoryListSchema = z.array(
  githubWorkerRepositorySchema,
);

export const projectCloneResultSchema = z.object({
  path: z.string().min(1),
  displayPath: z.string().min(1),
  reused: z.boolean().default(false),
  updated: z.boolean().default(false),
  warning: z.string().min(1).nullable().default(null),
  worktreePolicy: worktreePolicySchema.nullable().optional(),
});

export const managedFolderMaterializeReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  reused: z.boolean(),
});

export const managedFolderDeleteResultSchema = z.object({
  deleted: z.boolean(),
});

export const projectFolderSetupJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
]);

export const projectFolderSetupJobErrorSchema = z.object({
  code: z.enum([
    "worker-offline",
    "capability-missing",
    "materialization-failed",
  ]),
  retryable: z.boolean(),
});

export const projectFolderSetupJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workerId: z.string().min(1),
  state: projectFolderSetupJobStateSchema,
  stateRevision: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  error: projectFolderSetupJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const projectFolderSetupRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const projectGithubConversionErrorSchema = z.object({
  code: z.enum([
    "worker-offline",
    "capability-missing",
    "project-not-ready",
    "transition-active",
    "repository-collision",
    "github-auth-required",
    "repository-unavailable",
    "repository-not-empty",
    "local-git-ambiguous",
    "preflight-changed",
    "initial-commit-required",
    "git-initialization-failed",
    "commit-failed",
    "push-failed",
    "reconciliation-failed",
  ]),
  message: z.string().min(1).max(4_000),
  retryable: z.boolean(),
});

export const projectGithubConversionJobErrorSchema =
  projectGithubConversionErrorSchema.omit({ message: true });

const projectGithubConversionPreflightBaseSchema = z.object({
  projectId: z.string().uuid(),
  repository: projectGithubWireRepositorySchema,
});

export const projectGithubConversionPreflightReadySchema =
  projectGithubConversionPreflightBaseSchema.extend({
    status: z.literal("ready"),
    confirmationToken: z.string().regex(/^[0-9a-f]{64}$/u),
    localState: z.enum(["not-initialized", "unborn", "committed"]),
    branch: z.string().min(1).max(255).nullable(),
    head: gitObjectRevisionSchema.nullable(),
    dirty: z.boolean(),
    originUrl: z.string().min(1).max(8_192).nullable(),
    requiresInitialCommit: z.boolean(),
    warnings: z.array(z.string().min(1).max(1_000)).max(20),
  });

export const projectGithubConversionPreflightBlockedSchema =
  projectGithubConversionPreflightBaseSchema.extend({
    status: z.literal("blocked"),
    error: projectGithubConversionErrorSchema,
  });

export const projectGithubConversionPreflightResultSchema =
  z.discriminatedUnion("status", [
    projectGithubConversionPreflightReadySchema,
    projectGithubConversionPreflightBlockedSchema,
  ]);

export const projectGithubConversionPreflightRequestSchema = z.object({
  repository: projectGithubConversionRepositorySchema,
});

export const encryptedProjectGithubConversionPreflightRequestSchema = z
  .object({
    repository: projectGithubRoutingRepositorySchema,
    repositoryBlindIndex: encryptionKeyBytesSchema,
  })
  .strict();

export const projectGithubConversionStartSchema = z.object({
  repository: projectGithubConversionRepositorySchema,
  confirmationToken:
    projectGithubConversionPreflightReadySchema.shape.confirmationToken,
  initialCommit: z
    .object({
      message: z.string().trim().min(1).max(1_000),
    })
    .nullable()
    .default(null),
});

export const encryptedProjectGithubConversionStartSchema =
  projectGithubConversionStartSchema
    .omit({ repository: true, initialCommit: true })
    .extend({
      repository: projectGithubRoutingRepositorySchema,
      repositoryBlindIndex: encryptionKeyBytesSchema,
      initialCommit: z
        .object({ message: repositoryRoutingHandleSchema })
        .nullable(),
    })
    .strict();

export const projectGithubConversionJobStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
]);

export const projectGithubConversionJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workerId: z.string().min(1),
  repository: projectGithubWireRepositorySchema,
  state: projectGithubConversionJobStateSchema,
  stateRevision: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  initialCommitRequested: z.boolean(),
  error: projectGithubConversionJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const projectGithubConversionRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const projectGithubConversionReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  repository: projectGithubWireRepositorySchema,
  path: z.string().min(1),
  displayPath: z.string().min(1),
  repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  branch: z.string().min(1).max(255),
  head: gitObjectRevisionSchema,
  worktreePolicy: worktreePolicySchema,
});

export const projectGithubConversionBlockedSchema = z.object({
  status: z.literal("blocked"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  error: projectGithubConversionJobErrorSchema,
});

export const projectGithubConversionExecutionResultSchema =
  z.discriminatedUnion("status", [
    projectGithubConversionReadySchema,
    projectGithubConversionBlockedSchema,
  ]);

export const projectReplicaProvisionBlockedSchema = z.object({
  status: z.literal("blocked"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  error: projectReplicaJobErrorSchema,
});

export const projectReplicaProvisionReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  displayPath: z.string().min(1),
  repositoryFingerprint: z.string().min(1),
  resolvedRevision: gitObjectRevisionSchema.nullable(),
  branch: z.string().min(1).nullable(),
  reused: z.boolean(),
  placement: projectReplicaPlacementResultSchema.nullable().default(null),
  worktreePolicy: worktreePolicySchema.nullable().optional(),
});

export const projectReplicaProvisionResultSchema = z.discriminatedUnion(
  "status",
  [projectReplicaProvisionBlockedSchema, projectReplicaProvisionReadySchema],
);

export const projectReplicaSynchronizeReadySchema = z.object({
  status: z.literal("ready"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  previousRevision: gitObjectRevisionSchema,
  resolvedRevision: gitObjectRevisionSchema,
  branch: z.string().min(1).nullable(),
  changed: z.boolean(),
});

export const projectReplicaSynchronizeResultSchema = z.discriminatedUnion(
  "status",
  [projectReplicaProvisionBlockedSchema, projectReplicaSynchronizeReadySchema],
);

export const projectReplicaRemoveReadySchema = z.object({
  status: z.literal("removed"),
  jobId: z.string().uuid(),
  attempt: z.number().int().positive(),
  path: z.string().min(1),
  localFilesDeleted: z.boolean(),
  linkRemoved: z.boolean().default(false),
  ownershipReleased: z.boolean().default(false),
  warning: z.string().min(1).max(1_000).nullable().default(null),
});

export const projectReplicaRemoveResultSchema = z.discriminatedUnion("status", [
  projectReplicaProvisionBlockedSchema,
  projectReplicaRemoveReadySchema,
]);

export const projectReplicaLinkRepairReadySchema = z.object({
  status: z.literal("ready"),
  projectId: z.string().uuid(),
  path: z.string().min(1).max(8_192),
  linkPath: z.string().min(1).max(8_192),
  repaired: z.boolean(),
});

export const projectReplicaLinkRepairBlockedSchema = z.object({
  status: z.literal("blocked"),
  error: projectReplicaJobErrorSchema,
});

export const projectReplicaLinkRepairResultSchema = z.discriminatedUnion(
  "status",
  [projectReplicaLinkRepairReadySchema, projectReplicaLinkRepairBlockedSchema],
);

export const projectRemoveSchema = z.object({
  deleteLocalFiles: z.boolean().default(false),
});

export const gitRefSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["head", "local", "remote", "tag"]),
  current: z.boolean(),
});

export const gitCommitSchema = z.object({
  hash: z.string().min(1),
  shortHash: z.string().min(1),
  parents: z.array(z.string().min(1)),
  subject: z.string(),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime({ offset: true }),
  refs: z.array(gitRefSchema),
  isHead: z.boolean(),
});

export const gitCommitPersonSchema = z.object({
  name: z.string().min(1),
  email: z.string(),
  date: z.string().datetime({ offset: true }),
});

export const gitSignatureSchema = z.object({
  status: z.enum([
    "unsigned",
    "valid",
    "valid-unknown",
    "invalid",
    "expired",
    "revoked",
    "unverifiable",
  ]),
  signer: z.string().nullable(),
  key: z.string().nullable(),
  fingerprint: z.string().nullable(),
  format: z.enum(["gpg", "ssh", "x509", "unknown"]).nullable().default(null),
  verification: z
    .enum([
      "available",
      "missing-key",
      "missing-config",
      "missing-tool",
      "error",
      "not-applicable",
    ])
    .default("not-applicable"),
  verificationMessage: z.string().max(10_000).nullable().default(null),
});

export const gitAgentDraftTaskSchema = z.enum([
  "summarize-changes",
  "draft-commit-message",
  "draft-pr-description",
  "review-commit-range",
  "explain-conflicts",
  "summarize-failed-checks",
]);

const gitAgentRevisionSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) => !value.startsWith("-") && !/[\0\r\n]/u.test(value),
    "Expected a safe Git revision.",
  );

export const gitAgentDraftCreateSchema = z
  .object({
    task: gitAgentDraftTaskSchema,
    modelId: z.string().min(1).max(200).optional(),
    instructions: z.string().trim().max(2_000).nullable().default(null),
    baseRevision: gitAgentRevisionSchema.nullable().default(null),
    headRevision: gitAgentRevisionSchema.nullable().default(null),
    pullRequestNumber: z.number().int().positive().nullable().default(null),
  })
  .superRefine((value, context) => {
    if (
      ["draft-pr-description", "review-commit-range"].includes(value.task) &&
      (!value.baseRevision || !value.headRevision)
    ) {
      context.addIssue({
        code: "custom",
        message: "This task requires both base and head revisions.",
      });
    }
    if (value.task === "summarize-failed-checks" && !value.pullRequestNumber) {
      context.addIssue({
        code: "custom",
        message: "This task requires a pull request number.",
      });
    }
  });

export const gitAgentDraftModelOutputSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
});

export const gitAgentDraftResultSchema = z.object({
  generationId: z.string().min(1).max(200),
  task: gitAgentDraftTaskSchema,
  text: z.string().trim().min(1).max(100_000),
  modelId: z.string().min(1).max(200),
  modelName: z.string().min(1).max(500),
  providerName: z.string().min(1).max(200),
  worktreeId: z.string().min(1).max(200),
  generatedAt: z.iso.datetime(),
});

export const gitRelativePathSchema = repositoryRelativePathSchema;

export const gitCommitFileSchema = z.object({
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  status: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "type-changed",
    "unmerged",
    "unknown",
  ]),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});

export const gitCommitDetailSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  message: z.string().max(1_000_000),
  messageTruncated: z.boolean(),
  parents: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).max(64),
  children: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).max(10_000),
  parentIndex: z.number().int().nonnegative().nullable(),
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  author: gitCommitPersonSchema,
  committer: gitCommitPersonSchema,
  signature: gitSignatureSchema.nullable(),
  refs: z.array(gitRefSchema).max(10_000),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const gitRevisionFileDiffSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  baseRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
  binary: z.boolean(),
});

export const gitRevisionCandidateSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  name: z.string().min(1).max(1_024),
  kind: z.enum(["head", "local", "remote", "tag", "worktree"]),
  current: z.boolean(),
  worktreeId: z.string().min(1).nullable(),
  worktreeName: z.string().min(1).nullable(),
});

export const gitRevisionCandidateListSchema = z
  .array(gitRevisionCandidateSchema)
  .max(20_000);

export const gitComparisonModeSchema = z.enum(["direct", "merge-base"]);

export const gitComparisonCommitSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  authorName: z.string().min(1),
  authoredAt: z.string().datetime({ offset: true }),
});

export const gitComparisonSchema = z.object({
  mode: gitComparisonModeSchema,
  left: z.string().regex(/^[0-9a-f]{40,64}$/u),
  right: z.string().regex(/^[0-9a-f]{40,64}$/u),
  mergeBase: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  diffBase: z.string().regex(/^[0-9a-f]{40,64}$/u),
  leftAhead: z.number().int().nonnegative(),
  rightAhead: z.number().int().nonnegative(),
  leftCommits: z.array(gitComparisonCommitSchema).max(100),
  rightCommits: z.array(gitComparisonCommitSchema).max(100),
  leftCommitsTruncated: z.boolean(),
  rightCommitsTruncated: z.boolean(),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const gitHistorySchema = z.object({
  branch: z.string(),
  head: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
  commits: z.array(gitCommitSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitFileHistoryEntrySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  subject: z.string(),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime({ offset: true }),
});

export const gitFileHistorySchema = z.object({
  path: gitRelativePathSchema,
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  commits: z.array(gitFileHistoryEntrySchema).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitBlameRangeSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortCommit: z.string().min(1).max(64),
  authorName: z.string().min(1),
  authorEmail: z.string(),
  authoredAt: z.string().datetime(),
  summary: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  lines: z.array(z.string()).min(1).max(501),
});

export const gitBlameSchema = z.object({
  path: gitRelativePathSchema,
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  ranges: z.array(gitBlameRangeSchema).max(501),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitGraphNodeKindSchema = z.enum([
  "directory",
  "file",
  "symlink",
  "submodule",
]);

export const gitGraphMetricStateSchema = z.enum([
  "pending",
  "ready",
  "deferred",
  "unavailable",
]);

export const gitGraphAnalysisStateSchema = z.object({
  structure: z.literal("ready"),
  lines: gitGraphMetricStateSchema,
  history: gitGraphMetricStateSchema,
  blame: gitGraphMetricStateSchema,
});

const gitGraphNodeIdSchema = z.string().min(1).max(4_200);

export const gitGraphNodeSchema = z.object({
  id: gitGraphNodeIdSchema,
  path: gitRelativePathSchema.nullable(),
  parentId: gitGraphNodeIdSchema.nullable(),
  name: z.string().min(1).max(4_096),
  kind: gitGraphNodeKindSchema,
  objectId: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  extension: z.string().max(200).nullable(),
  language: z.string().max(200).nullable(),
});

export const gitGraphSnapshotSchema = z.object({
  analyzerVersion: z.number().int().positive(),
  revision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  branch: z.string().nullable(),
  rootPath: gitRelativePathSchema.nullable(),
  rootId: gitGraphNodeIdSchema,
  nodes: z.array(gitGraphNodeSchema).min(1).max(100_000),
  totalNodes: z.number().int().positive(),
  truncated: z.boolean(),
  analyzedAt: z.iso.datetime(),
  analysis: gitGraphAnalysisStateSchema,
});

export const gitGraphNodeMetricsSchema = z.object({
  nodeId: gitGraphNodeIdSchema,
  path: gitRelativePathSchema.nullable(),
  lineCount: z.number().int().nonnegative().nullable(),
  binary: z.boolean().nullable(),
  commitTouches: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  churn: z.number().int().nonnegative(),
  binaryCommitTouches: z.number().int().nonnegative(),
  firstChangedAt: z.string().datetime({ offset: true }).nullable(),
  lastChangedAt: z.string().datetime({ offset: true }).nullable(),
  dominantAuthorName: z.string().max(500).nullable(),
  dominantAuthorEmail: z.string().max(1_000).nullable(),
  dominantAuthorShare: z.number().min(0).max(1).nullable(),
  averageBlameAgeDays: z.number().nonnegative().nullable(),
});

export const gitGraphMetricsSchema = z.object({
  analyzerVersion: z.number().int().positive(),
  revision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  rootPath: gitRelativePathSchema.nullable(),
  historyScope: z.enum(["current-branch", "none"]),
  renameAware: z.boolean(),
  blameCoverage: z
    .object({
      analyzedFiles: z.number().int().nonnegative(),
      totalFiles: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .nullable()
    .default(null),
  nodes: z.array(gitGraphNodeMetricsSchema).min(1).max(100_000),
  analyzedAt: z.iso.datetime(),
  analysis: gitGraphAnalysisStateSchema,
});

export const gitGraphRequestSchema = z.object({
  revision: gitAgentRevisionSchema.default("HEAD"),
  rootPath: gitRelativePathSchema.nullable().default(null),
  maxNodes: z.number().int().min(1).max(100_000).default(100_000),
  includeBlame: z.boolean().default(false),
});

export const gitGraphCommitOverlayRequestSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  rootPath: gitRelativePathSchema.nullable().default(null),
});

export const gitGraphCommitOverlayNodeSchema = z.object({
  path: gitRelativePathSchema,
  originalPath: gitRelativePathSchema.nullable(),
  status: gitCommitFileSchema.shape.status,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  weight: z.number().int().nonnegative(),
  binary: z.boolean(),
  ghost: z.boolean(),
});

export const gitGraphCommitOverlaySchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  baseRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  rootPath: gitRelativePathSchema.nullable(),
  nodes: z.array(gitGraphCommitOverlayNodeSchema).max(100_000),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const gitSearchDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const gitCommitSearchQuerySchema = z
  .object({
    message: z.string().trim().min(1).max(1_000).nullable().default(null),
    author: z.string().trim().min(1).max(1_000).nullable().default(null),
    hash: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{4,64}$/u)
      .nullable()
      .default(null),
    dateFrom: gitSearchDateSchema.nullable().default(null),
    dateTo: gitSearchDateSchema.nullable().default(null),
    path: gitRelativePathSchema.nullable().default(null),
    branch: z.string().trim().min(1).max(1_024).nullable().default(null),
    tag: z.string().trim().min(1).max(1_024).nullable().default(null),
  })
  .superRefine((query, context) => {
    if (query.branch && query.tag) {
      context.addIssue({
        code: "custom",
        path: ["tag"],
        message: "Search can target a branch or tag, not both.",
      });
    }
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      context.addIssue({
        code: "custom",
        path: ["dateTo"],
        message: "Search end date cannot precede its start date.",
      });
    }
    if (!Object.values(query).some(Boolean)) {
      context.addIssue({
        code: "custom",
        message: "At least one commit search filter is required.",
      });
    }
  });

export const gitCommitSearchResultSchema = z.object({
  query: gitCommitSearchQuerySchema,
  commits: z.array(gitCommitSchema).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitRecoveryCandidateSchema = z.object({
  kind: z.enum(["reflog", "dangling"]),
  selector: z.string().min(1).max(1_024),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(1).max(64),
  action: z.string().min(1).max(100),
  subject: z.string().max(10_000),
  explanation: z.string().min(1).max(10_000),
  actorName: z.string().max(1_000).nullable(),
  actorEmail: z.string().max(1_000).nullable(),
  occurredAt: z.string().datetime({ offset: true }).nullable(),
});

export const gitRecoveryCandidateListSchema = z.object({
  kind: z.enum(["reflog", "dangling"]),
  entries: z.array(gitRecoveryCandidateSchema).max(100),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const gitRecoveryActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("createBranch"),
    branch: z.lazy(() => gitBranchNameInputSchema),
    target: z.lazy(() => gitRevisionInputSchema),
  }),
  z.object({
    type: z.literal("restoreBranch"),
    branch: z.lazy(() => gitBranchNameInputSchema),
    target: z.lazy(() => gitRevisionInputSchema),
  }),
  z.object({
    type: z.literal("reset"),
    mode: z.enum(["soft", "mixed", "hard"]),
    target: z.lazy(() => gitRevisionInputSchema),
  }),
]);

export const gitRecoveryPreviewSchema = z.object({
  action: gitRecoveryActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
  confirmation: z.string().min(1).max(1_000),
  targetRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
  currentHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
  branchBefore: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  commitsRemoved: z.array(gitComparisonCommitSchema).max(200),
  commitsRemovedTruncated: z.boolean(),
  files: z.array(gitCommitFileSchema).max(100_000),
  filesTruncated: z.boolean(),
  status: z.lazy(() => gitStatusSchema),
});

export const gitRecoveryApplySchema = z.object({
  action: gitRecoveryActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  confirmation: z.string().min(1).max(1_000),
});

export const gitRecoveryResultSchema = z.object({
  action: gitRecoveryActionSchema,
  output: z.string().max(1_000_000),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  headBefore: z.string().regex(/^[0-9a-f]{40,64}$/u),
  headAfter: z.string().regex(/^[0-9a-f]{40,64}$/u),
  status: z.lazy(() => gitStatusSchema),
});

export const gitFileChangeSchema = z.object({
  path: z.string().min(1),
  originalPath: z.string().min(1).nullable(),
  indexStatus: z.string().length(1),
  worktreeStatus: z.string().length(1),
  staged: z.boolean(),
  unstaged: z.boolean(),
});

export const gitBranchSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["local", "remote"]),
  current: z.boolean(),
  hash: z.string().min(1),
  upstream: z.string().min(1).nullable(),
});

export const gitStatusSchema = z.object({
  branch: z.string(),
  head: z.string().nullable(),
  upstream: z.string().min(1).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(gitFileChangeSchema),
  branches: z.array(gitBranchSchema),
});

export const gitDiffScopeSchema = z.enum(["unstaged", "staged"]);

export const gitFileDiffSchema = z.object({
  path: gitRelativePathSchema,
  scope: gitDiffScopeSchema,
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
});

export const gitPartialPatchOperationSchema = z.enum([
  "stage",
  "unstage",
  "discard",
]);

export const gitPartialPatchHunkSelectionSchema = z.object({
  hunkIndex: z.number().int().nonnegative(),
  lineIndexes: z.array(z.number().int().nonnegative()).max(100_000).nullable(),
});

export const gitPartialPatchRequestSchema = z.object({
  operation: gitPartialPatchOperationSchema,
  path: gitRelativePathSchema,
  hunks: z.array(gitPartialPatchHunkSelectionSchema).min(1).max(10_000),
});

export const gitPartialPatchPreviewSchema = z.object({
  operation: gitPartialPatchOperationSchema,
  path: gitRelativePathSchema,
  scope: gitDiffScopeSchema,
  patch: z.string().min(1).max(2_000_000),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  selectedHunks: z.number().int().positive(),
  selectedLines: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitPartialPatchApplySchema = z.object({
  request: gitPartialPatchRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitStashFileSchema = z.object({
  path: gitRelativePathSchema,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});

export const gitStashSummarySchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(7).max(64),
  message: z.string().max(10_000),
  createdAt: z.string().datetime({ offset: true }),
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  files: z.array(gitStashFileSchema).max(10_000),
  filesChanged: z.number().int().nonnegative(),
  filesTruncated: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  includesUntracked: z.boolean(),
});

export const gitStashListSchema = z.object({
  stashes: z.array(gitStashSummarySchema).max(10_000),
  truncated: z.boolean(),
});

export const gitStashCreateSchema = z
  .object({
    message: z.string().trim().min(1).max(10_000),
    includeStaged: z.boolean(),
    includeUnstaged: z.boolean(),
    includeUntracked: z.boolean(),
  })
  .superRefine((value, context) => {
    if (
      !value.includeStaged &&
      !value.includeUnstaged &&
      !value.includeUntracked
    ) {
      context.addIssue({
        code: "custom",
        message: "Select at least one change scope.",
      });
    }
    if (
      value.includeStaged &&
      !value.includeUnstaged &&
      value.includeUntracked
    ) {
      context.addIssue({
        code: "custom",
        message: "Git cannot combine staged-only and untracked stash scopes.",
      });
    }
  });

const gitStashIdentitySchema = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/u),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
});

export const gitBranchNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\0\r\n]+$/u);

export const gitStashActionSchema = z.discriminatedUnion("type", [
  gitStashIdentitySchema.extend({ type: z.literal("apply") }),
  gitStashIdentitySchema.extend({ type: z.literal("pop") }),
  gitStashIdentitySchema.extend({ type: z.literal("drop") }),
  z.object({ type: z.literal("clear") }),
  gitStashIdentitySchema.extend({
    type: z.literal("branch"),
    branch: gitBranchNameInputSchema,
  }),
]);

export const gitStashActionPreviewSchema = z.object({
  action: gitStashActionSchema,
  stashes: z.array(gitStashSummarySchema).min(1).max(10_000),
  destructive: z.boolean(),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitStashActionApplySchema = z.object({
  action: gitStashActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitStashMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  stash: gitStashSummarySchema.nullable(),
  conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
  operation: z
    .object({
      type: z.literal("stash"),
      state: z.literal("conflicted"),
      originalHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
      currentHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
      sourceRef: z.string().min(1).max(1_024),
      sourceRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
      targetRef: z.string().min(1).max(1_024).nullable(),
      targetRevision: z.string().regex(/^[0-9a-f]{40,64}$/u),
      pendingCommits: z.array(z.string().regex(/^[0-9a-f]{40,64}$/u)).length(1),
      currentStep: z.literal(1),
      totalSteps: z.literal(1),
      checkpointRef: z.string().min(1).max(1_024),
      conflictedPaths: z.array(gitRelativePathSchema).min(1).max(100_000),
    })
    .nullable()
    .default(null),
});

export const gitStashFileDiffSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  path: gitRelativePathSchema,
  patch: z.string().max(2_000_000),
  truncated: z.boolean(),
  binary: z.boolean(),
});

export const gitBranchCommitSummarySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  shortHash: z.string().min(7).max(64),
  subject: z.string().max(100_000),
  authorName: z.string().min(1).max(10_000),
  authoredAt: z.string().datetime({ offset: true }),
});

const gitBranchDisplayNameSchema = z.string().min(1).max(1_000);

export const gitManagedBranchSchema = z.object({
  name: gitBranchDisplayNameSchema,
  fullRef: z.string().min(1).max(1_000),
  kind: z.enum(["local", "remote"]),
  current: z.boolean(),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  upstream: z.string().min(1).max(1_000).nullable(),
  upstreamGone: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  mergedIntoHead: z.boolean().nullable(),
  remoteName: z.string().min(1).max(255).nullable(),
  remoteAvailable: z.boolean(),
  trackingLocalBranches: z.array(gitBranchDisplayNameSchema).max(10_000),
  worktree: z
    .object({
      label: z.string().min(1).max(1_000),
      current: z.boolean(),
    })
    .nullable(),
  lastCommit: gitBranchCommitSummarySchema,
});

export const gitPullStrategySchema = z.object({
  mode: z.enum(["fast-forward-only", "rebase", "merge", "unspecified"]),
  description: z.string().min(1).max(1_000),
});

export const gitBranchListSchema = z.object({
  currentBranch: gitBranchDisplayNameSchema.nullable(),
  head: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  detached: z.boolean(),
  defaultRemote: z.string().min(1).max(255).nullable(),
  remotes: z.array(z.string().min(1).max(255)).max(1_000),
  pullStrategy: gitPullStrategySchema,
  branches: z.array(gitManagedBranchSchema).max(20_000),
  truncated: z.boolean(),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitRemoteNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);
const gitRevisionInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitBranchActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    name: gitBranchNameInputSchema,
    startPoint: gitRevisionInputSchema.nullable(),
    checkout: z.boolean(),
  }),
  z.object({
    type: z.literal("switch"),
    name: gitBranchNameInputSchema,
    kind: z.enum(["local", "remote"]),
  }),
  z.object({
    type: z.literal("publish"),
    name: gitBranchNameInputSchema,
    remote: gitRemoteNameInputSchema,
  }),
  z.object({
    type: z.literal("rename"),
    name: gitBranchNameInputSchema,
    newName: gitBranchNameInputSchema,
  }),
  z.object({
    type: z.literal("deleteLocal"),
    name: gitBranchNameInputSchema,
    force: z.boolean(),
  }),
  z.object({
    type: z.literal("deleteRemote"),
    remote: gitRemoteNameInputSchema,
    name: gitBranchNameInputSchema,
  }),
  z.object({
    type: z.literal("setUpstream"),
    name: gitBranchNameInputSchema,
    upstream: z.string().trim().min(1).max(1_000).nullable(),
  }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema.nullable(),
    prune: z.boolean(),
  }),
]);

export const gitBranchActionPreviewSchema = z.object({
  action: gitBranchActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  branch: gitManagedBranchSchema.nullable(),
});

export const gitBranchActionApplySchema = z.object({
  action: gitBranchActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitBranchMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  branches: gitBranchListSchema,
});

export const gitRemoteSummarySchema = z.object({
  name: z.string().min(1).max(255),
  fetchUrl: z.string().min(1).max(8_192),
  fetchUrlRedacted: z.boolean(),
  pushUrl: z.string().min(1).max(8_192),
  pushUrlRedacted: z.boolean(),
  defaultFetch: z.boolean(),
  defaultPush: z.boolean(),
});

export const gitRemoteListSchema = z.object({
  remotes: z.array(gitRemoteSummarySchema).max(1_000),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitRemoteUrlInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitRemoteActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    name: gitRemoteNameInputSchema,
    fetchUrl: gitRemoteUrlInputSchema,
    pushUrl: gitRemoteUrlInputSchema.nullable(),
  }),
  z.object({
    type: z.literal("edit"),
    name: gitRemoteNameInputSchema,
    fetchUrl: gitRemoteUrlInputSchema,
    pushUrl: gitRemoteUrlInputSchema.nullable(),
  }),
  z.object({ type: z.literal("remove"), name: gitRemoteNameInputSchema }),
  z.object({
    type: z.literal("setDefaults"),
    fetchRemote: gitRemoteNameInputSchema.nullable(),
    pushRemote: gitRemoteNameInputSchema.nullable(),
  }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema,
    prune: z.boolean(),
  }),
]);

export const gitRemoteActionPreviewSchema = z.object({
  action: gitRemoteActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  remote: gitRemoteSummarySchema.nullable(),
});

export const gitRemoteActionApplySchema = z.object({
  action: gitRemoteActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitRemoteMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  remotes: gitRemoteListSchema,
});

export const gitSubmoduleSummarySchema = z.object({
  name: z.string().min(1).max(1_024),
  path: gitRelativePathSchema,
  url: z.string().min(1).max(8_192),
  branch: z.string().min(1).max(1_024).nullable(),
  expectedHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  currentHash: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .nullable(),
  initialized: z.boolean(),
  dirty: z.boolean(),
  nested: z.boolean(),
  state: z.enum(["clean", "uninitialized", "changed", "conflicted", "missing"]),
});

export const gitSubmoduleListSchema = z.object({
  submodules: z.array(gitSubmoduleSummarySchema).max(10_000),
  truncated: z.boolean(),
  generatedAt: z.string().datetime({ offset: true }),
});

export const gitSubmoduleActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("initialize"),
    path: gitRelativePathSchema.nullable(),
    recursive: z.boolean(),
  }),
  z.object({
    type: z.literal("update"),
    path: gitRelativePathSchema.nullable(),
    recursive: z.boolean(),
    remote: z.boolean(),
  }),
  z.object({
    type: z.literal("sync"),
    path: gitRelativePathSchema.nullable(),
    recursive: z.boolean(),
  }),
  z.object({
    type: z.literal("deinitialize"),
    path: gitRelativePathSchema,
    force: z.boolean(),
  }),
]);

export const gitSubmoduleActionPreviewSchema = z.object({
  action: gitSubmoduleActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  targets: z.array(gitSubmoduleSummarySchema).max(10_000),
});

export const gitSubmoduleActionApplySchema = z.object({
  action: gitSubmoduleActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitSubmoduleMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  submodules: gitSubmoduleListSchema,
});

export const gitLfsTrackedPatternSchema = z.object({
  pattern: z.string().min(1).max(4_096),
  source: gitRelativePathSchema,
});

export const gitLfsFileSchema = z.object({
  path: gitRelativePathSchema,
  oid: z.string().regex(/^[0-9a-f]{64}$/u),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checkedOut: z.boolean(),
  downloaded: z.boolean(),
  status: z.string().min(1).max(100).nullable(),
});

export const gitLfsLockSchema = z.object({
  id: z.string().min(1).max(1_024),
  path: gitRelativePathSchema,
  owner: z.string().min(1).max(1_024).nullable(),
  lockedAt: z.string().datetime({ offset: true }).nullable(),
  ours: z.boolean(),
});

export const gitLfsStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().min(1).max(1_024).nullable(),
  message: z.string().max(10_000).nullable(),
  patterns: z.array(gitLfsTrackedPatternSchema).max(10_000),
  files: z.array(gitLfsFileSchema).max(10_000),
  filesTruncated: z.boolean(),
  missingObjects: z.number().int().nonnegative().max(10_000),
  pendingPaths: z
    .array(
      z.object({
        path: gitRelativePathSchema,
        status: z.string().min(1).max(100),
      }),
    )
    .max(10_000),
  locks: z.array(gitLfsLockSchema).max(10_000),
  locksTruncated: z.boolean(),
  locksCached: z.boolean(),
  lockError: z.string().max(10_000).nullable(),
  generatedAt: z.string().datetime({ offset: true }),
});

const gitLfsPatternInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .regex(/^[^\0\r\n-][^\0\r\n]*$/u);

export const gitLfsActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("install") }),
  z.object({ type: z.literal("track"), pattern: gitLfsPatternInputSchema }),
  z.object({ type: z.literal("untrack"), pattern: gitLfsPatternInputSchema }),
  z.object({
    type: z.literal("fetch"),
    remote: gitRemoteNameInputSchema.nullable(),
    all: z.boolean(),
  }),
  z.object({
    type: z.literal("pull"),
    remote: gitRemoteNameInputSchema.nullable(),
  }),
  z.object({ type: z.literal("prune"), verifyRemote: z.boolean() }),
  z.object({ type: z.literal("refreshLocks") }),
  z.object({ type: z.literal("lock"), path: gitRelativePathSchema }),
  z.object({
    type: z.literal("unlock"),
    path: gitRelativePathSchema,
    force: z.boolean(),
  }),
]);

export const gitLfsActionPreviewSchema = z.object({
  action: gitLfsActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  status: gitLfsStatusSchema,
});

export const gitLfsActionApplySchema = z.object({
  action: gitLfsActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitLfsMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  lfs: gitLfsStatusSchema,
});

export const gitTagNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .regex(/^[^-\0\r\n][^\0\r\n]*$/u);

export const gitTagSummarySchema = z.object({
  name: z.string().min(1).max(1_000),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  targetHash: z.string().regex(/^[0-9a-f]{40,64}$/u),
  targetType: z.enum(["commit", "tree", "blob", "tag", "other"]),
  annotated: z.boolean(),
  subject: z.string().max(100_000),
  taggerName: z.string().min(1).max(10_000).nullable(),
  createdAt: z.string().datetime({ offset: true }).nullable(),
  signature: gitSignatureSchema,
  publishedRemotes: z.array(z.string().min(1).max(255)).max(1_000),
});

export const gitTagDetailSchema = gitTagSummarySchema.extend({
  message: z.string().max(1_000_000),
  messageTruncated: z.boolean(),
});

export const gitTagListSchema = z.object({
  tags: z.array(gitTagSummarySchema).max(10_000),
  truncated: z.boolean(),
  remoteChecks: z.array(
    z.object({
      remote: z.string().min(1).max(255),
      available: z.boolean(),
      error: z.string().max(1_000).nullable(),
    }),
  ),
  generatedAt: z.string().datetime({ offset: true }),
});

export const gitTagActionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("create"),
      name: gitTagNameInputSchema,
      target: gitRevisionInputSchema.nullable(),
      annotated: z.boolean(),
      message: z.string().trim().min(1).max(1_000_000).nullable(),
    }),
    z.object({
      type: z.literal("push"),
      name: gitTagNameInputSchema,
      remote: gitRemoteNameInputSchema,
    }),
    z.object({ type: z.literal("deleteLocal"), name: gitTagNameInputSchema }),
    z.object({
      type: z.literal("deleteRemote"),
      name: gitTagNameInputSchema,
      remote: gitRemoteNameInputSchema,
    }),
  ])
  .superRefine((action, context) => {
    if (action.type !== "create") return;
    if (action.annotated && !action.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Annotated tags require a message.",
      });
    }
    if (!action.annotated && action.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Lightweight tags do not have a tag message.",
      });
    }
  });

export const gitTagActionPreviewSchema = z.object({
  action: gitTagActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  tag: gitTagSummarySchema.nullable(),
});

export const gitTagActionApplySchema = z.object({
  action: gitTagActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitTagMutationResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  tags: gitTagListSchema,
});

const gitCommitHashInputSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);

export const gitCherryPickSelectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("commits"),
    revisions: z.array(gitCommitHashInputSchema).min(1).max(1_000),
  }),
  z.object({
    type: z.literal("range"),
    fromRevision: gitCommitHashInputSchema,
    toRevision: gitCommitHashInputSchema,
  }),
]);

export const gitCommitActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cherryPick"),
    selection: gitCherryPickSelectionSchema,
  }),
  z.object({
    type: z.literal("revert"),
    revision: gitCommitHashInputSchema,
    mainlineParent: z.number().int().positive().max(64).nullable(),
  }),
  z.object({
    type: z.literal("amend"),
    message: z.string().min(1).max(1_000_000).nullable(),
  }),
  z.object({
    type: z.literal("fixup"),
    revision: gitCommitHashInputSchema,
  }),
]);

export const gitOperationSummarySchema = z.object({
  type: z.enum(["cherry-pick", "revert"]),
  state: z.enum([
    "queued",
    "running",
    "conflicted",
    "awaiting-user-action",
    "completed",
    "failed",
    "aborted",
  ]),
  originalHead: gitCommitHashInputSchema,
  currentHead: gitCommitHashInputSchema,
  sourceRevisions: z.array(gitCommitHashInputSchema).max(1_000),
  currentStep: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive().max(1_000),
  conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
});

export const gitManagedOperationTypeSchema = z.enum([
  "merge",
  "rebase",
  "bisect",
  "cherry-pick",
  "revert",
  "stash",
]);

export const gitManagedOperationStateSchema = z.enum([
  "queued",
  "running",
  "conflicted",
  "awaiting-user-action",
  "completed",
  "failed",
  "aborted",
]);

export const gitInteractiveRebaseTodoActionSchema = z.enum([
  "pick",
  "reword",
  "edit",
  "squash",
  "fixup",
  "drop",
]);

export const gitInteractiveRebaseTodoItemSchema = z
  .object({
    action: gitInteractiveRebaseTodoActionSchema,
    revision: gitCommitHashInputSchema,
    message: z.string().trim().min(1).max(1_000_000).nullable().default(null),
  })
  .superRefine((item, context) => {
    if (item.action === "reword" && !item.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Reword steps require a replacement commit message.",
      });
    }
    if (item.action !== "reword" && item.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Only reword steps accept a replacement commit message.",
      });
    }
  });

export const gitMergeRebaseActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("merge"),
    sourceRef: gitRevisionInputSchema,
  }),
  z.object({
    type: z.literal("rebase"),
    sourceRef: gitRevisionInputSchema,
  }),
  z.object({
    type: z.literal("interactiveRebase"),
    upstreamRef: gitRevisionInputSchema,
    todo: z.array(gitInteractiveRebaseTodoItemSchema).max(10_000).default([]),
  }),
]);

export const gitBisectActionSchema = z.object({
  type: z.literal("bisect"),
  goodRef: gitRevisionInputSchema,
  badRef: gitRevisionInputSchema,
});

export const gitManagedOperationActionSchema = z.union([
  gitMergeRebaseActionSchema,
  gitBisectActionSchema,
]);

export const gitManagedOperationContextSchema = z.object({
  type: gitManagedOperationTypeSchema,
  originalHead: gitCommitHashInputSchema,
  sourceRef: z.string().min(1).max(1_024).nullable(),
  sourceRevision: gitCommitHashInputSchema.nullable(),
  targetRef: z.string().min(1).max(1_024).nullable(),
  targetRevision: gitCommitHashInputSchema,
  pendingCommits: z.array(gitCommitHashInputSchema).max(10_000),
  totalSteps: z.number().int().positive().max(10_000),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
});

export const gitManagedOperationWorkerStateSchema =
  gitManagedOperationContextSchema.extend({
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    pendingCommits: z.array(gitCommitHashInputSchema).max(10_000),
    conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
    output: z.string().max(1_000_000),
    status: gitStatusSchema,
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable().optional(),
  });

export const gitOperationObservationStateSchema = z
  .object({
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    totalSteps: z.number().int().positive().max(10_000),
    pendingCommitCount: z.number().int().nonnegative().max(10_000),
    conflictedPathCount: z.number().int().nonnegative().max(100_000),
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable(),
  })
  .strict();

export const gitManagedOperationPreviewSchema = z.object({
  action: gitManagedOperationActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  context: gitManagedOperationContextSchema,
  commits: z.array(gitComparisonCommitSchema).max(10_000),
  files: z.array(gitCommitFileSchema).max(100_000),
  patch: z.string().max(2_000_000),
  patchTruncated: z.boolean(),
  wouldConflict: z.boolean(),
  todo: z.array(gitInteractiveRebaseTodoItemSchema).max(10_000).default([]),
  todoText: z.string().max(2_000_000).default(""),
  publishedRefs: z.array(z.string().min(1).max(1_024)).max(1_000).default([]),
});

export const gitManagedOperationStartSchema = z.object({
  action: gitManagedOperationActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitManagedOperationControlSchema = z.object({
  action: z.enum(["continue", "skip", "abort", "good", "bad", "reset"]),
});

export const gitManagedOperationAmendSchema = z.object({
  message: z.string().trim().min(1).max(1_000_000).nullable().default(null),
});

export const gitManagedOperationRecordSchema =
  gitManagedOperationContextSchema.extend({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    worktreeId: z.string().uuid(),
    workerId: z.string().min(1).max(255),
    state: gitManagedOperationStateSchema,
    currentHead: gitCommitHashInputSchema,
    currentStep: z.number().int().nonnegative().max(10_000),
    conflictedPaths: z.array(gitRelativePathSchema).max(100_000),
    output: z.string().max(1_000_000),
    error: z.string().max(1_000_000).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    pausedAction: gitInteractiveRebaseTodoActionSchema.nullable().optional(),
  });

export const gitManagedOperationResponseSchema = z.object({
  operation: gitManagedOperationRecordSchema.nullable(),
});

export const gitConflictKindSchema = z.enum([
  "both-modified",
  "both-added",
  "both-deleted",
  "added-by-ours",
  "added-by-theirs",
  "deleted-by-ours",
  "deleted-by-theirs",
  "unknown",
]);

export const gitConflictStageSchema = z.object({
  available: z.boolean(),
  oid: gitCommitHashInputSchema.nullable(),
  mode: z
    .string()
    .regex(/^[0-7]{6}$/u)
    .nullable(),
  size: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
  content: z.string().max(2_000_000).nullable(),
  truncated: z.boolean(),
});

export const gitConflictSummarySchema = z.object({
  path: gitRelativePathSchema,
  code: z.string().length(2),
  kind: gitConflictKindSchema,
  baseAvailable: z.boolean(),
  oursAvailable: z.boolean(),
  theirsAvailable: z.boolean(),
});

export const gitConflictListSchema = z.object({
  files: z.array(gitConflictSummarySchema).max(100_000),
  truncated: z.boolean(),
});

export const gitConflictDetailSchema = gitConflictSummarySchema.extend({
  base: gitConflictStageSchema,
  ours: gitConflictStageSchema,
  theirs: gitConflictStageSchema,
  result: z.object({
    exists: z.boolean(),
    oid: gitCommitHashInputSchema.nullable(),
    size: z.number().int().nonnegative().nullable(),
    binary: z.boolean(),
    content: z.string().max(2_000_000).nullable(),
    truncated: z.boolean(),
  }),
});

export const gitConflictResolutionStrategySchema = z.enum([
  "ours",
  "theirs",
  "both",
  "result",
  "manual",
  "delete",
]);

export const gitConflictResolutionRequestSchema = z
  .object({
    path: gitRelativePathSchema,
    strategy: gitConflictResolutionStrategySchema,
    content: z.string().max(2_000_000).nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.strategy === "manual" && value.content === null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Manual conflict resolution requires result content.",
      });
    }
    if (value.strategy !== "manual" && value.content !== null) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Only manual conflict resolution accepts result content.",
      });
    }
  });

export const gitConflictResolutionPreviewSchema = z.object({
  request: gitConflictResolutionRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  resultDeleted: z.boolean(),
  resultBinary: z.boolean(),
  resultContent: z.string().max(2_000_000).nullable(),
  warnings: z.array(z.string().max(1_000)).max(100),
});

export const gitConflictResolutionApplySchema = z.object({
  request: gitConflictResolutionRequestSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitConflictResolutionResultSchema = z.object({
  path: gitRelativePathSchema,
  resolved: z.boolean(),
  remainingPaths: z.array(gitRelativePathSchema).max(100_000),
  status: gitStatusSchema,
});

export const gitCommitActionPreviewSchema = z.object({
  action: gitCommitActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.boolean(),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().max(1_000)).max(100),
  resolvedRevisions: z.array(gitCommitHashInputSchema).max(1_000),
  commits: z.array(gitComparisonCommitSchema).max(1_000),
  files: z.array(gitFileChangeSchema).max(100_000),
  patch: z.string().max(2_000_000),
  patchTruncated: z.boolean(),
  wouldConflict: z.boolean(),
  checkpointRef: z.string().min(1).max(1_024).nullable(),
});

export const gitCommitActionApplySchema = z.object({
  action: gitCommitActionSchema,
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const gitCommitActionResultSchema = z.object({
  output: z.string().max(1_000_000),
  status: gitStatusSchema,
  headBefore: gitCommitHashInputSchema,
  headAfter: gitCommitHashInputSchema,
  checkpointRef: z.string().min(1).max(1_024).nullable(),
  operation: gitOperationSummarySchema.nullable(),
});

const gitPathsSchema = z.array(gitRelativePathSchema).min(1).max(1_000);
export const gitActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("unstage"), paths: gitPathsSchema }),
  z.object({ type: z.literal("discard"), paths: gitPathsSchema }),
  z.object({ type: z.literal("stageAll") }),
  z.object({ type: z.literal("unstageAll") }),
  z.object({ type: z.literal("discardAll") }),
  z.object({
    type: z.literal("commit"),
    message: z.string().trim().min(1).max(10_000),
    all: z.boolean().default(false),
  }),
  z.object({ type: z.literal("pull") }),
  z.object({ type: z.literal("push") }),
  z.object({
    type: z.literal("checkout"),
    branch: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("createBranch"),
    name: z.string().trim().min(1).max(255),
  }),
]);

export const gitActionResultSchema = z.object({
  status: gitStatusSchema,
  output: z.string(),
});

export const gitForcePushPreviewSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  destructive: z.literal(true),
  summary: z.string().min(1).max(10_000),
  warnings: z.array(z.string().min(1).max(1_000)).max(100),
  remote: gitRemoteNameInputSchema,
  localBranch: gitBranchNameInputSchema,
  remoteBranch: gitBranchNameInputSchema,
  localHead: gitCommitHashInputSchema,
  expectedRemoteHead: gitCommitHashInputSchema,
  localCommits: z.array(gitComparisonCommitSchema).max(200),
  localCommitCount: z.number().int().nonnegative(),
  localCommitsTruncated: z.boolean(),
  remoteCommits: z.array(gitComparisonCommitSchema).max(200),
  remoteCommitCount: z.number().int().positive(),
  remoteCommitsTruncated: z.boolean(),
});

export const gitForcePushApplySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const workerWorktreeSummarySchema = z.object({
  path: z.string().min(1),
  head: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  detached: z.boolean(),
  isPrimary: z.boolean(),
  managed: z.boolean(),
  locked: z.boolean(),
  lockReason: z.string().min(1).nullable(),
  prunable: z.boolean(),
  pruneReason: z.string().min(1).nullable(),
  missing: z.boolean(),
});

export const worktreeInventorySchema = z.object({
  sourcePath: z.string().min(1),
  primaryPath: z.string().min(1),
  gitCommonDir: z.string().min(1),
  managedRoot: z.string().min(1),
  repositoryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  worktrees: z.array(workerWorktreeSummarySchema),
});

export const worktreeCreateModeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("newBranch"),
    branch: z.string().trim().min(1).max(255),
    startPoint: z.string().trim().min(1).max(1_024).nullable().default(null),
  }),
  z.object({
    type: z.literal("existingBranch"),
    branch: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("detached"),
    revision: z.string().trim().min(1).max(1_024),
  }),
]);

export const worktreeCreateResultSchema = z.object({
  created: z.boolean(),
  worktree: workerWorktreeSummarySchema,
  inventory: worktreeInventorySchema,
});

export const worktreeCreateMutationOutcomeSchema = z.enum([
  "notStarted",
  "committed",
  "rolledBack",
  "partial",
]);

export const worktreeCreateMutationFailureSchema = z
  .object({
    code: z.enum([
      "worktree-create-not-started",
      "worktree-create-committed",
      "worktree-create-rolled-back",
      "worktree-create-partial",
    ]),
    error: z.string().min(1).max(2_000),
    mutation: z
      .object({
        outcome: worktreeCreateMutationOutcomeSchema,
        retryable: z.boolean(),
        target: z
          .object({
            kind: z.literal("worktree"),
            projectId: z.string().min(1).max(200),
            worktreeId: z.string().min(1).max(200),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((failure, context) => {
    const expectedCode = `worktree-create-${
      failure.mutation.outcome === "notStarted"
        ? "not-started"
        : failure.mutation.outcome === "rolledBack"
          ? "rolled-back"
          : failure.mutation.outcome
    }`;
    if (failure.code !== expectedCode) {
      context.addIssue({
        code: "custom",
        message: "Worktree mutation failure code must match its outcome.",
        path: ["code"],
      });
    }
    if (
      (failure.mutation.outcome === "notStarted") !==
      (failure.mutation.target === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Only a worktree mutation that did not start may omit its recovery target.",
        path: ["mutation", "target"],
      });
    }
  });

export const worktreeMutationResultSchema = z.object({
  worktree: workerWorktreeSummarySchema,
  inventory: worktreeInventorySchema,
});

export const worktreeRemoveResultSchema = z.object({
  removedPath: z.string().min(1),
  inventory: worktreeInventorySchema,
});

export const worktreePruneResultSchema = z.object({
  prunedPaths: z.array(z.string().min(1)),
  inventory: worktreeInventorySchema,
});

export const worktreeStatusResultSchema = z.object({
  worktree: workerWorktreeSummarySchema,
  status: gitStatusSchema,
});

const cantripMcpWorkerWorktreeSummarySchema = workerWorktreeSummarySchema
  .omit({ path: true })
  .strict();
const cantripMcpGitStatusSchema = gitStatusSchema.extend({
  files: gitStatusSchema.shape.files.max(2_000),
  branches: gitStatusSchema.shape.branches.max(500),
});
export const cantripMcpWorktreeStatusResultSchema =
  cantripMcpReadResultBaseSchema.extend({
    target: z
      .object({
        kind: z.literal("worktree"),
        projectId: z.string().min(1).max(200),
        worktreeId: z.string().min(1).max(200),
      })
      .strict(),
    data: z
      .object({
        worktree: cantripMcpWorkerWorktreeSummarySchema,
        status: cantripMcpGitStatusSchema,
        filesTruncated: z.boolean(),
        branchesTruncated: z.boolean(),
      })
      .strict(),
  });

export const worktreeObservationTargetSchema = z.object({
  projectId: z.string().uuid().optional(),
  worktreeId: z.string().min(1).max(200).optional(),
  sourcePath: z.string().min(1).max(8_192),
  worktreePath: z.string().min(1).max(8_192),
  operation: z
    .object({
      id: z.string().uuid(),
      context: gitManagedOperationContextSchema,
    })
    .strict()
    .nullable()
    .optional(),
});

export const worktreeObservationTargetsSchema = z
  .array(worktreeObservationTargetSchema)
  .max(128)
  .superRefine((targets, context) => {
    const keys = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const key = `${target.sourcePath}\0${target.worktreePath}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Worktree observation targets must be unique.",
          path: [index],
        });
      }
      keys.add(key);
    }
  });

export const codeGraphObservationTargetSchema = z.object({
  projectId: z.string().uuid(),
  worktreeId: z.string().min(1).max(200),
  rootKind: projectRootKindSchema,
  sourcePath: z.string().min(1).max(8_192),
  worktreePath: z.string().min(1).max(8_192),
});

export const codeGraphObservationTargetsSchema = z
  .array(codeGraphObservationTargetSchema)
  .max(128)
  .superRefine((targets, context) => {
    const keys = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const key = `${target.rootKind}\0${target.sourcePath}\0${target.worktreePath}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "CodeGraph observation targets must be unique.",
          path: [index],
        });
      }
      keys.add(key);
    }
  });

export const projectWorktreeCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mode: worktreeCreateModeSchema,
});

export const projectWorktreeLockSchema = z.object({
  reason: z.string().trim().min(1).max(1_000).nullable().default(null),
});

export const projectWorktreeRemoveSchema = z.object({
  force: z.boolean().default(false),
  allowExternal: z.boolean().default(false),
});

export const projectWorktreePruneSchema = z.object({
  allowExternal: z.boolean().default(false),
});

export const projectWorktreePolicyUpdateSchema = z.object({
  policy: worktreePolicySchema,
});

export const chatWorktreeUpdateSchema = z.object({
  worktreeId: z.string().min(1),
  mode: z.enum(["agent-managed", "pinned"]),
});

export const worktreeSelectionSchema = z.object({
  worktreeId: z.string().min(1),
});

export const agentTurnResultSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  text: z.string(),
  structuredResult: z.unknown().optional(),
  measuredUsage: agentTokenUsageSchema.nullable().optional(),
  status: z.literal("completed"),
});

export const agentTurnResultModeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visible") }),
  z.object({
    kind: z.literal("structured"),
    outputSchema: workflowJsonObjectSchema,
  }),
  z.object({
    kind: z.literal("task-encrypted"),
    operation: taskOperationRelayRequestSchema,
  }),
  z.object({
    kind: z.literal("task-message-encrypted"),
    messageId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal("chat-message-encrypted"),
    messageId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
  }),
]);

export const chatMessageRelayResultSchema = z
  .object({
    message: chatMessageOpaqueContentSchema.nullable(),
  })
  .strict();

export const normalizedAgentMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  phase: agentMessagePhaseSchema.nullable(),
  streaming: z.boolean().optional(),
  correlation: codexEventCorrelationSchema.nullable().optional(),
  agentScope: agentScopeSchema.optional(),
});

export const agentThreadSyncItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("userMessage"),
      id: z.string().min(1),
      text: z.string(),
      externalAttachmentIds: z.array(z.string().uuid()).max(20).default([]),
    })
    .refine(
      (item) =>
        item.text.trim().length > 0 || item.externalAttachmentIds.length > 0,
      { message: "User messages require text or an external attachment." },
    ),
  z.object({
    type: z.literal("agentMessage"),
    ...normalizedAgentMessageSchema.shape,
  }),
  z.object({
    type: z.literal("activity"),
    activity: agentActivitySchema,
  }),
]);

export const agentThreadSyncSchema = z.object({
  threadId: z.string().min(1),
  status: z.enum(["idle", "running", "failed"]),
  turns: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(["completed", "failed", "interrupted", "inProgress"]),
      startedAt: z.number().int().nonnegative().nullable(),
      completedAt: z.number().int().nonnegative().nullable(),
      durationMs: z.number().int().nonnegative().nullable(),
      items: z.array(agentThreadSyncItemSchema),
    }),
  ),
});

export const externalChatSourceKindSchema = z.enum(["chatgpt-codex"]);

export const externalChatSourceAvailabilitySchema = z.enum([
  "available",
  "unavailable",
  "incompatible",
]);

export const externalChatThreadStatusSchema = z.enum([
  "not-loaded",
  "idle",
  "system-error",
]);

export const chatImportStateSchema = z.enum([
  "queued",
  "reading",
  "importing",
  "awaiting-hydration",
  "hydrating",
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
]);

export const externalChatImportReferenceSchema = z.object({
  jobId: z.string().uuid(),
  projectId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200).nullable(),
  state: chatImportStateSchema,
});

export const externalChatThreadMatchSchema = z.object({
  kind: z.enum(["worktree-path", "replica-path", "git-origin"]),
  projectReplicaId: z.string().min(1).max(200),
  worktreeId: z.string().min(1).max(200).nullable(),
});

export const externalChatThreadMetadataSchema = z.object({
  sourceThreadId: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  preview: z.string().max(2_000),
  cwd: z.string().min(1).max(8_192),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.boolean(),
  source: z.enum(["cli", "vscode"]),
  status: externalChatThreadStatusSchema,
  modelProvider: z.string().min(1).max(200),
  cliVersion: z.string().max(100).nullable(),
  git: z
    .object({
      branch: z.string().max(1_000).nullable(),
      sha: z.string().max(200).nullable(),
      originUrl: z.string().max(4_000).nullable(),
    })
    .nullable(),
  match: externalChatThreadMatchSchema,
  existingImport: externalChatImportReferenceSchema.nullable().default(null),
});

export const externalChatSourceSchema = z.object({
  kind: externalChatSourceKindSchema,
  sourceId: z.string().regex(/^[0-9a-f]{64}$/u),
  name: z.string().min(1).max(200),
  platform: z.enum(["darwin", "win32"]),
  homeLabel: z.string().min(1).max(500),
  availability: externalChatSourceAvailabilitySchema,
  message: z.string().min(1).max(2_000).nullable(),
  runtimeVersion: z.string().max(100).nullable(),
  threads: z.array(externalChatThreadMetadataSchema).max(5_000),
  truncated: z.boolean(),
});

export const externalChatDiscoveryWorkerStatusSchema = z.enum([
  "ok",
  "offline",
  "unsupported",
  "timed-out",
  "error",
]);

export const externalChatDiscoveryWorkerSchema = z.object({
  workerId: z.string().min(1).max(200),
  workerName: z.string().min(1).max(200),
  platform: z.string().min(1).max(100),
  status: externalChatDiscoveryWorkerStatusSchema,
  sources: z.array(externalChatSourceSchema).max(8),
  error: z
    .object({
      code: z.enum([
        "worker-offline",
        "capability-missing",
        "worker-timeout",
        "worker-error",
      ]),
      message: z.string().min(1).max(2_000),
    })
    .nullable(),
});

export const projectExternalChatDiscoverySchema = z.object({
  projectId: z.string().min(1).max(200),
  observedAt: z.string().datetime(),
  partial: z.boolean(),
  truncated: z.boolean(),
  workers: z.array(externalChatDiscoveryWorkerSchema).max(64),
});

export const externalChatDiscoveryTargetSchema = z.object({
  projectReplicaId: z.string().min(1).max(200),
  path: z.string().min(1).max(8_192),
  repositoryFingerprint: z.string().min(1).max(500).nullable(),
  worktrees: z
    .array(
      z.object({
        worktreeId: z.string().min(1).max(200),
        path: z.string().min(1).max(8_192),
        isPrimary: z.boolean(),
      }),
    )
    .max(512),
});

export const externalChatDiscoveryWorkerResultSchema = z.object({
  sources: z.array(externalChatSourceSchema).max(8),
  truncated: z.boolean(),
});

export const externalChatTranscriptMetadataSchema =
  externalChatThreadMetadataSchema.omit({
    archived: true,
    existingImport: true,
    title: true,
  });

export const externalChatAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    sourceAttachmentId: z.string().regex(/^[0-9a-f]{64}$/u),
    itemId: z.string().min(1).max(500),
    sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
    status: z.enum(["available", "missing", "unsafe", "unsupported"]),
    protectedMetadata: attachmentProtectedMetadataSchema,
  })
  .superRefine((attachment, context) => {
    if (attachment.status === "available" && attachment.sizeBytes === 0) {
      context.addIssue({
        code: "custom",
        message: "Available external attachments cannot be empty.",
        path: ["sizeBytes"],
      });
    }
  });

export const externalChatTranscriptSchema = z
  .object({
    sourceId: externalChatSourceSchema.shape.sourceId,
    sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
    metadata: externalChatTranscriptMetadataSchema,
    titleProtection: privateDisplayLabelOpaqueSchema,
    sync: agentThreadSyncSchema,
    attachments: z.array(externalChatAttachmentSchema).max(20).default([]),
  })
  .superRefine((transcript, context) => {
    if (transcript.titleProtection.classification.recordKind !== "chat") {
      context.addIssue({
        code: "custom",
        message: "Imported title classification must be chat.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    const descriptors = new Map(
      transcript.attachments.map((attachment) => [attachment.id, attachment]),
    );
    if (descriptors.size !== transcript.attachments.length) {
      context.addIssue({
        code: "custom",
        message: "External attachment ids must be unique.",
        path: ["attachments"],
      });
    }
    const references = new Map<string, string>();
    for (const [turnIndex, turn] of transcript.sync.turns.entries()) {
      for (const [itemIndex, item] of turn.items.entries()) {
        if (item.type !== "userMessage") continue;
        for (const attachmentId of item.externalAttachmentIds) {
          if (references.has(attachmentId)) {
            context.addIssue({
              code: "custom",
              message: "An external attachment may be referenced only once.",
              path: [
                "sync",
                "turns",
                turnIndex,
                "items",
                itemIndex,
                "externalAttachmentIds",
              ],
            });
          }
          references.set(attachmentId, item.id);
        }
      }
    }
    for (const [
      attachmentIndex,
      attachment,
    ] of transcript.attachments.entries()) {
      if (references.get(attachment.id) !== attachment.itemId) {
        context.addIssue({
          code: "custom",
          message:
            "Every external attachment must reference its originating user message.",
          path: ["attachments", attachmentIndex, "itemId"],
        });
      }
    }
    for (const attachmentId of references.keys()) {
      if (!descriptors.has(attachmentId)) {
        context.addIssue({
          code: "custom",
          message: "External attachment references require a descriptor.",
          path: ["sync"],
        });
      }
    }
  });

export const externalChatReadWorkerResultSchema = z.object({
  transcript: externalChatTranscriptSchema,
});

export const externalChatAttachmentReadResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("available"),
      chunk: attachmentChunkOpaqueSchema,
      sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
    }),
    z.object({
      status: z.literal("unavailable"),
      reasonCode: z.enum(["missing", "changed", "invalid"]),
    }),
  ],
);

export const chatImportErrorSchema = z.object({
  code: z.enum([
    "worker-offline",
    "capability-missing",
    "source-not-found",
    "source-changed",
    "project-mismatch",
    "runtime-incompatible",
    "target-not-found",
    "stale-attempt",
    "worker-error",
  ]),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
});

export const chatImportJobErrorSchema = chatImportErrorSchema.omit({
  message: true,
});

export const chatImportProgressStageSchema = z.enum([
  "queued",
  "reading",
  "importing",
  "awaiting-hydration",
  "hydrating",
  "blocked",
  "failed",
  "succeeded",
]);

export const chatImportProgressSchema = z.object({
  stage: chatImportProgressStageSchema,
  percent: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),
});

export const chatImportJobSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200).nullable(),
  sourceKind: externalChatSourceKindSchema,
  sourceWorkerId: z.string().min(1).max(200),
  sourceId: externalChatSourceSchema.shape.sourceId,
  sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
  targetPlacement: executionPlacementSchema,
  managedThreadId: z.string().min(1).max(500).nullable(),
  targetModelRouteId: z.string().min(1).max(200).nullable(),
  targetProviderAccountId: z.string().min(1).max(200).nullable(),
  state: chatImportStateSchema,
  stateRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(200),
  attempt: z.number().int().nonnegative(),
  progress: chatImportProgressSchema,
  error: chatImportJobErrorSchema.nullable(),
  sourceMetadata: externalChatTranscriptMetadataSchema.nullable(),
  attachmentCount: z.number().int().nonnegative(),
  attachmentWarningCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export const chatImportJobListSchema = z
  .array(chatImportJobSummarySchema)
  .max(1_000);

export const chatImportSelectionSchema = z.object({
  sourceKind: externalChatSourceKindSchema,
  sourceWorkerId: z.string().min(1).max(200),
  sourceId: externalChatSourceSchema.shape.sourceId,
  sourceThreadId: externalChatThreadMetadataSchema.shape.sourceThreadId,
  idempotencyKey: z.string().min(1).max(200),
  target: executionTargetSchema.optional(),
  modelId: z.string().min(1).max(200).nullable().default(null),
  modelRouteId: z.string().min(1).max(200).nullable().default(null),
  providerAccountId: z.string().min(1).max(200).nullable().default(null),
  permissionProfileId: z.string().min(1).max(200).nullable().default(null),
  planMode: planModeSchema.default("default"),
});

export const chatImportCreateSchema = z.object({
  imports: z.array(chatImportSelectionSchema).min(1).max(50),
});

export const chatImportJobRetrySchema = z.object({
  stateRevision: z.number().int().positive(),
});

export const PROJECT_EXPORT_MAX_CHATS = 20;

export const projectExportTargetSchema = z
  .object({
    kind: z.literal("codex-local"),
  })
  .strict();

export const projectExportMappingSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
    description: z.string().min(1).max(1_000),
  })
  .strict();

export const projectExportPreviewRequestSchema = z
  .object({
    target: projectExportTargetSchema,
    worktreeId: z.string().min(1).max(200),
  })
  .strict();

export const projectExportTargetInspectionSchema = z
  .object({
    target: projectExportTargetSchema,
    available: z.boolean(),
    destinationLabel: z.string().min(1).max(500).nullable(),
    message: z.string().min(1).max(2_000).nullable(),
    platform: z.string().min(1).max(100),
  })
  .strict();

export const projectExportPreviewSchema = z
  .object({
    target: projectExportTargetSchema,
    targetLabel: z.string().min(1).max(200),
    available: z.boolean(),
    destinationLabel: z.string().min(1).max(500).nullable(),
    message: z.string().min(1).max(2_000).nullable(),
    worker: z
      .object({
        workerId: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
        platform: z.string().min(1).max(100),
      })
      .strict(),
    worktree: z
      .object({
        worktreeId: z.string().min(1).max(200),
        name: z.string().min(1).max(500),
        displayPath: z.string().min(1).max(8_192),
      })
      .strict(),
    maxChats: z.number().int().min(1).max(PROJECT_EXPORT_MAX_CHATS),
    supportedChatExperiences: z.array(z.enum(["agent", "task"])).max(2),
    preserves: z.array(projectExportMappingSchema).max(32),
    flattens: z.array(projectExportMappingSchema).max(32),
  })
  .strict();

export const projectExportCreateSchema = z
  .object({
    operationId: z.string().uuid(),
    target: projectExportTargetSchema,
    worktreeId: z.string().min(1).max(200),
    chatIds: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(PROJECT_EXPORT_MAX_CHATS),
  })
  .strict()
  .refine((input) => new Set(input.chatIds).size === input.chatIds.length, {
    message: "Project export chat ids must be unique.",
    path: ["chatIds"],
  });

export const projectExportChatResultSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    threadId: z.string().min(1).max(500),
    destinationLabel: z.string().min(1).max(500),
    messageCount: z.number().int().nonnegative(),
    reused: z.boolean(),
  })
  .strict();

export const projectExportItemOutcomeSchema = z.discriminatedUnion("status", [
  projectExportChatResultSchema.extend({ status: z.literal("exported") }),
  z
    .object({
      status: z.literal("failed"),
      chatId: z.string().min(1).max(200),
      code: z.enum([
        "target-unavailable",
        "encryption-unavailable",
        "runtime-incompatible",
        "worker-error",
      ]),
      message: z.string().min(1).max(2_000),
    })
    .strict(),
]);

export const projectExportResultSchema = z
  .object({
    operationId: z.string().uuid(),
    target: projectExportTargetSchema,
    workerId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    outcomes: z
      .array(projectExportItemOutcomeSchema)
      .min(1)
      .max(PROJECT_EXPORT_MAX_CHATS),
  })
  .strict();

export const projectExportChatBeginResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("upload") }).strict(),
    projectExportChatResultSchema
      .omit({ reused: true })
      .extend({ status: z.literal("exported"), reused: z.literal(true) })
      .strict(),
  ],
);

const workerRuntimeModelSchema = z.object({
  id: z.string().min(1),
  routeId: z.string().min(1),
  name: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable(),
  catalog: providerModelCatalogEntrySchema
    .pick({
      nativeModelId: true,
      displayName: true,
      description: true,
      contextWindow: true,
      maxOutputTokens: true,
      inputModalities: true,
      outputModalities: true,
      supportsTools: true,
      supportsParallelTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsReasoning: true,
      supportedReasoningEfforts: true,
      defaultReasoningEffort: true,
      reasoningMandatory: true,
      metadataSource: true,
    })
    .nullable()
    .optional(),
});

const workerRuntimeProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: modelProviderKindSchema,
  baseUrl: z.url(),
  protectedApiKey: protectedSecretEnvelopeSchema.nullable().default(null),
  accountId: z.string().min(1).nullable().default(null),
  credentialHomeKey: z.string().min(1).max(500).nullable().default(null),
});

export const workerChatAttachmentSchema = chatAttachmentOpaqueSummarySchema;

export const workerAttachmentUploadResultSchema = z.object({
  sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
  verified: z.literal(true),
});

export const workerAttachmentReadResultSchema = z.object({
  chunk: attachmentChunkOpaqueSchema,
  sizeBytes: chatAttachmentSummarySchema.shape.sizeBytes,
});

export const workerProjectShareDescriptorSchema = z
  .object({
    shareId: z.string().min(1).max(200),
    protocol: z.literal("webdav"),
    publicBasePath: projectSharePublicBasePathSchema,
    publicOrigin: projectSharePublicOriginSchema,
    loopbackHost: z.literal("127.0.0.1"),
    loopbackPort: z.number().int().min(1).max(65_535),
    username: z.string().min(1).max(128),
    password: z.string().min(24).max(256),
    realm: z.string().min(1).max(200),
  })
  .strict();

export const workerProjectShareOpenResultSchema = z
  .object({
    accepted: z.literal(true),
    shareId: z.string().min(1).max(200),
  })
  .strict();

export const ollamaModelInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(500),
  modifiedAt: z.string().datetime().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  digest: z.string().trim().min(1).max(500).nullable(),
  family: z.string().trim().min(1).max(500).nullable(),
  families: z.array(z.string().trim().min(1).max(500)).max(32),
  parameterSize: z.string().trim().min(1).max(100).nullable(),
  quantization: z.string().trim().min(1).max(100).nullable(),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(64),
  modelInfo: z.record(z.string(), z.unknown()),
});

export const ollamaModelInventorySchema = z.object({
  models: z.array(ollamaModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
});

export const chatGptModelInventoryItemSchema = z.object({
  id: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500),
  description: z.string().max(20_000),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  inputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  supportedReasoningEfforts: z
    .array(
      z.object({
        reasoningEffort: reasoningEffortSchema,
        description: z.string().max(500),
      }),
    )
    .max(32),
  defaultReasoningEffort: reasoningEffortSchema,
  modelSpecialty: z.string().max(500).nullable(),
  supportsPersonality: z.boolean(),
  upgrade: z.string().max(500).nullable(),
  upgradeInfo: z.record(z.string(), z.unknown()).nullable(),
  availabilityNux: z.record(z.string(), z.unknown()).nullable(),
  additionalSpeedTiers: z.array(z.string().max(100)).max(32),
  serviceTiers: z
    .array(
      z.object({
        id: z.string().max(100),
        name: z.string().max(200),
        description: z.string().max(2_000),
      }),
    )
    .max(32),
  defaultServiceTier: z.string().max(100).nullable(),
});

export const providerQuotaWindowObservationSchema = z.object({
  limitId: z.string().max(500).nullable(),
  limitName: z.string().max(500).nullable(),
  planType: z.string().max(500).nullable(),
  reachedType: z.string().max(500).nullable(),
  windowKind: z.enum(["primary", "secondary"]),
  usedPercent: z.number().min(0).max(100),
  windowDurationMinutes: z.number().int().nonnegative().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
  isWeeklyProjection: z.boolean(),
  rawPayload: z.record(z.string(), z.unknown()).default({}),
});

export const providerRateLimitResetCreditSchema = z.object({
  id: z.string().trim().min(1).max(1_000),
  resetType: z.enum(["codexRateLimits", "unknown"]),
  status: z.enum(["available", "redeeming", "redeemed", "unknown"]),
  grantedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  title: z.string().max(1_000).nullable(),
  description: z.string().max(4_000).nullable(),
});

export const providerRateLimitResetCreditsSummarySchema = z.object({
  availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  credits: z.array(providerRateLimitResetCreditSchema).max(100).nullable(),
});

export const providerRateLimitResetConsumeOutcomeSchema = z.enum([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);

export const providerRateLimitResetConsumeInputSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    creditId: z.string().trim().min(1).max(1_000).nullable().optional(),
  })
  .strict();

export const providerRateLimitResetConsumeRequestSchema =
  providerRateLimitResetConsumeInputSchema
    .extend({ workerId: z.string().min(1).max(500) })
    .strict();

export const providerQuotaSnapshotSchema = z.object({
  snapshotId: z.string().min(1).max(200),
  observedAt: z.string().datetime(),
  workerVersion: z.string().max(200).nullable(),
  codexVersion: z.string().max(500).nullable(),
  windows: z.array(providerQuotaWindowObservationSchema).max(500),
  rateLimitResetCredits: providerRateLimitResetCreditsSummarySchema
    .nullable()
    .default(null),
});

export const providerRateLimitResetConsumeResultSchema = z.object({
  outcome: providerRateLimitResetConsumeOutcomeSchema,
  quotaSnapshot: providerQuotaSnapshotSchema.nullable(),
});

export const chatGptModelInventorySchema = z.object({
  models: z.array(chatGptModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
  weeklyUsage: providerWeeklyUsageSchema.nullable().default(null),
  quotaSnapshot: providerQuotaSnapshotSchema.nullable().default(null),
});

export const grokModelInventoryItemSchema = z.object({
  id: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).nullable(),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  inputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  outputModalities: z.array(z.string().trim().min(1).max(80)).max(32),
  supportedReasoningEfforts: z.array(modelReasoningEffortOptionSchema).max(32),
  defaultReasoningEffort: reasoningEffortSchema.nullable(),
  supportsReasoning: z.boolean(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  rawMetadata: z.record(z.string(), z.unknown()),
});

export const grokModelInventorySchema = z.object({
  models: z.array(grokModelInventoryItemSchema).max(1_000),
  observedAt: z.string().datetime(),
  weeklyUsage: providerWeeklyUsageSchema.nullable().default(null),
  quotaSnapshot: providerQuotaSnapshotSchema.nullable().default(null),
});

export const serviceLogLevelSchema = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

export const serviceLogRecordSchema = z.object({
  cursor: z.number().int().positive(),
  timestamp: z.string().datetime(),
  system: z.string().trim().min(1).max(100),
  level: serviceLogLevelSchema,
  message: z.string().max(16_384),
  context: z.unknown().optional(),
});

export const serviceLogReadResultSchema = z.object({
  records: z.array(serviceLogRecordSchema).max(500),
  nextCursor: z.number().int().nonnegative(),
  oldestCursor: z.number().int().positive().nullable(),
  latestCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  truncated: z.boolean(),
});

export const workerLogStreamSubscriptionIdSchema = z.string().uuid();

export const workerLogStreamBatchSchema = z
  .object({
    records: z.array(serviceLogRecordSchema).max(200),
    nextCursor: z.number().int().nonnegative(),
    oldestCursor: z.number().int().positive().nullable(),
    latestCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const workerLogStreamStartResultSchema = z
  .object({
    accepted: z.literal(true),
    latestCursor: z.number().int().nonnegative(),
  })
  .strict();

export const workerLogStreamRenewResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const workerLogStreamServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      subscriptionId: workerLogStreamSubscriptionIdSchema,
      nextCursor: z.number().int().nonnegative(),
    })
    .strict(),
  workerLogStreamBatchSchema.extend({ type: z.literal("batch") }).strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.enum([
        "authorization-failed",
        "invalid-request",
        "worker-offline",
        "stream-unavailable",
      ]),
      message: z.string().min(1).max(500),
      retryable: z.boolean(),
    })
    .strict(),
]);

export const workerLogReadQuerySchema = z
  .object({
    afterCursor: z.coerce.number().int().nonnegative().default(0),
    beforeCursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    minimumLevel: serviceLogLevelSchema.default("trace"),
  })
  .strict();

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

export type GithubWorkerRepository = z.infer<
  typeof githubWorkerRepositorySchema
>;
export type ProjectCloneResult = z.infer<typeof projectCloneResultSchema>;
export type ManagedFolderMaterializeReady = z.infer<
  typeof managedFolderMaterializeReadySchema
>;
export type ManagedFolderDeleteResult = z.infer<
  typeof managedFolderDeleteResultSchema
>;

export type ProjectFolderSetupJobState = z.infer<
  typeof projectFolderSetupJobStateSchema
>;
export type ProjectFolderSetupJobError = z.infer<
  typeof projectFolderSetupJobErrorSchema
>;
export type ProjectFolderSetupJobSummary = z.infer<
  typeof projectFolderSetupJobSummarySchema
>;
export type ProjectGithubConversionError = z.infer<
  typeof projectGithubConversionErrorSchema
>;
export type ProjectGithubConversionJobError = z.infer<
  typeof projectGithubConversionJobErrorSchema
>;
export type ProjectGithubConversionPreflightResult = z.infer<
  typeof projectGithubConversionPreflightResultSchema
>;
export type ProjectGithubConversionPreflightReady = z.infer<
  typeof projectGithubConversionPreflightReadySchema
>;
export type ProjectGithubConversionPreflightRequest = z.infer<
  typeof projectGithubConversionPreflightRequestSchema
>;
export type EncryptedProjectGithubConversionPreflightRequest = z.infer<
  typeof encryptedProjectGithubConversionPreflightRequestSchema
>;
export type ProjectGithubConversionStart = z.infer<
  typeof projectGithubConversionStartSchema
>;
export type EncryptedProjectGithubConversionStart = z.infer<
  typeof encryptedProjectGithubConversionStartSchema
>;
export type ProjectGithubConversionJobState = z.infer<
  typeof projectGithubConversionJobStateSchema
>;
export type ProjectGithubConversionJobSummary = z.infer<
  typeof projectGithubConversionJobSummarySchema
>;
export type ProjectGithubConversionReady = z.infer<
  typeof projectGithubConversionReadySchema
>;
export type ProjectGithubConversionExecutionResult = z.infer<
  typeof projectGithubConversionExecutionResultSchema
>;
export type ProjectReplicaProvisionResult = z.infer<
  typeof projectReplicaProvisionResultSchema
>;
export type ProjectReplicaSynchronizeResult = z.infer<
  typeof projectReplicaSynchronizeResultSchema
>;
export type ProjectReplicaRemoveResult = z.infer<
  typeof projectReplicaRemoveResultSchema
>;
export type ProjectReplicaLinkRepairResult = z.infer<
  typeof projectReplicaLinkRepairResultSchema
>;
export type ProjectRemove = z.infer<typeof projectRemoveSchema>;
export type GitRef = z.infer<typeof gitRefSchema>;
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitHistory = z.infer<typeof gitHistorySchema>;
export type GitFileHistoryEntry = z.infer<typeof gitFileHistoryEntrySchema>;
export type GitFileHistory = z.infer<typeof gitFileHistorySchema>;
export type GitBlameRange = z.infer<typeof gitBlameRangeSchema>;
export type GitBlame = z.infer<typeof gitBlameSchema>;
export type GitGraphNodeKind = z.infer<typeof gitGraphNodeKindSchema>;
export type GitGraphMetricState = z.infer<typeof gitGraphMetricStateSchema>;
export type GitGraphAnalysisState = z.infer<typeof gitGraphAnalysisStateSchema>;
export type GitGraphNode = z.infer<typeof gitGraphNodeSchema>;
export type GitGraphSnapshot = z.infer<typeof gitGraphSnapshotSchema>;
export type GitGraphNodeMetrics = z.infer<typeof gitGraphNodeMetricsSchema>;
export type GitGraphMetrics = z.infer<typeof gitGraphMetricsSchema>;
export type GitGraphRequest = z.infer<typeof gitGraphRequestSchema>;
export type GitGraphCommitOverlayRequest = z.infer<
  typeof gitGraphCommitOverlayRequestSchema
>;
export type GitGraphCommitOverlayNode = z.infer<
  typeof gitGraphCommitOverlayNodeSchema
>;
export type GitGraphCommitOverlay = z.infer<typeof gitGraphCommitOverlaySchema>;
export type GitCommitSearchQuery = z.infer<typeof gitCommitSearchQuerySchema>;
export type GitCommitSearchResult = z.infer<typeof gitCommitSearchResultSchema>;
export type GitRecoveryCandidate = z.infer<typeof gitRecoveryCandidateSchema>;
export type GitRecoveryCandidateList = z.infer<
  typeof gitRecoveryCandidateListSchema
>;
export type GitRecoveryAction = z.infer<typeof gitRecoveryActionSchema>;
export type GitRecoveryPreview = z.infer<typeof gitRecoveryPreviewSchema>;
export type GitRecoveryApply = z.infer<typeof gitRecoveryApplySchema>;
export type GitRecoveryResult = z.infer<typeof gitRecoveryResultSchema>;
export type GitCommitPerson = z.infer<typeof gitCommitPersonSchema>;
export type GitSignature = z.infer<typeof gitSignatureSchema>;
export type GitAgentDraftTask = z.infer<typeof gitAgentDraftTaskSchema>;
export type GitAgentDraftCreate = z.infer<typeof gitAgentDraftCreateSchema>;
export type GitAgentDraftResult = z.infer<typeof gitAgentDraftResultSchema>;
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetail = z.infer<typeof gitCommitDetailSchema>;
export type GitRevisionFileDiff = z.infer<typeof gitRevisionFileDiffSchema>;
export type GitRevisionCandidate = z.infer<typeof gitRevisionCandidateSchema>;
export type GitComparisonMode = z.infer<typeof gitComparisonModeSchema>;
export type GitComparisonCommit = z.infer<typeof gitComparisonCommitSchema>;
export type GitComparison = z.infer<typeof gitComparisonSchema>;
export type GitFileChange = z.infer<typeof gitFileChangeSchema>;
export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitDiffScope = z.infer<typeof gitDiffScopeSchema>;
export type GitFileDiff = z.infer<typeof gitFileDiffSchema>;
export type GitPartialPatchOperation = z.infer<
  typeof gitPartialPatchOperationSchema
>;
export type GitPartialPatchRequest = z.infer<
  typeof gitPartialPatchRequestSchema
>;
export type GitPartialPatchPreview = z.infer<
  typeof gitPartialPatchPreviewSchema
>;
export type GitPartialPatchApply = z.infer<typeof gitPartialPatchApplySchema>;
export type GitStashFile = z.infer<typeof gitStashFileSchema>;
export type GitStashSummary = z.infer<typeof gitStashSummarySchema>;
export type GitStashList = z.infer<typeof gitStashListSchema>;
export type GitStashCreate = z.infer<typeof gitStashCreateSchema>;
export type GitStashAction = z.infer<typeof gitStashActionSchema>;
export type GitStashActionPreview = z.infer<typeof gitStashActionPreviewSchema>;
export type GitStashActionApply = z.infer<typeof gitStashActionApplySchema>;
export type GitStashMutationResult = z.infer<
  typeof gitStashMutationResultSchema
>;
export type GitStashFileDiff = z.infer<typeof gitStashFileDiffSchema>;
export type GitBranchCommitSummary = z.infer<
  typeof gitBranchCommitSummarySchema
>;
export type GitManagedBranch = z.infer<typeof gitManagedBranchSchema>;
export type GitPullStrategy = z.infer<typeof gitPullStrategySchema>;
export type GitBranchList = z.infer<typeof gitBranchListSchema>;
export type GitBranchAction = z.infer<typeof gitBranchActionSchema>;
export type GitBranchActionPreview = z.infer<
  typeof gitBranchActionPreviewSchema
>;
export type GitBranchActionApply = z.infer<typeof gitBranchActionApplySchema>;
export type GitBranchMutationResult = z.infer<
  typeof gitBranchMutationResultSchema
>;
export type GitRemoteSummary = z.infer<typeof gitRemoteSummarySchema>;
export type GitRemoteList = z.infer<typeof gitRemoteListSchema>;
export type GitRemoteAction = z.infer<typeof gitRemoteActionSchema>;
export type GitRemoteActionPreview = z.infer<
  typeof gitRemoteActionPreviewSchema
>;
export type GitRemoteActionApply = z.infer<typeof gitRemoteActionApplySchema>;
export type GitRemoteMutationResult = z.infer<
  typeof gitRemoteMutationResultSchema
>;
export type GitSubmoduleSummary = z.infer<typeof gitSubmoduleSummarySchema>;
export type GitSubmoduleList = z.infer<typeof gitSubmoduleListSchema>;
export type GitSubmoduleAction = z.infer<typeof gitSubmoduleActionSchema>;
export type GitSubmoduleActionPreview = z.infer<
  typeof gitSubmoduleActionPreviewSchema
>;
export type GitSubmoduleActionApply = z.infer<
  typeof gitSubmoduleActionApplySchema
>;
export type GitSubmoduleMutationResult = z.infer<
  typeof gitSubmoduleMutationResultSchema
>;
export type GitLfsTrackedPattern = z.infer<typeof gitLfsTrackedPatternSchema>;
export type GitLfsFile = z.infer<typeof gitLfsFileSchema>;
export type GitLfsLock = z.infer<typeof gitLfsLockSchema>;
export type GitLfsStatus = z.infer<typeof gitLfsStatusSchema>;
export type GitLfsAction = z.infer<typeof gitLfsActionSchema>;
export type GitLfsActionPreview = z.infer<typeof gitLfsActionPreviewSchema>;
export type GitLfsActionApply = z.infer<typeof gitLfsActionApplySchema>;
export type GitLfsMutationResult = z.infer<typeof gitLfsMutationResultSchema>;
export type GitTagSummary = z.infer<typeof gitTagSummarySchema>;
export type GitTagDetail = z.infer<typeof gitTagDetailSchema>;
export type GitTagList = z.infer<typeof gitTagListSchema>;
export type GitTagAction = z.infer<typeof gitTagActionSchema>;
export type GitTagActionPreview = z.infer<typeof gitTagActionPreviewSchema>;
export type GitTagActionApply = z.infer<typeof gitTagActionApplySchema>;
export type GitTagMutationResult = z.infer<typeof gitTagMutationResultSchema>;
export type GitCherryPickSelection = z.infer<
  typeof gitCherryPickSelectionSchema
>;
export type GitCommitAction = z.infer<typeof gitCommitActionSchema>;
export type GitOperationSummary = z.infer<typeof gitOperationSummarySchema>;
export type GitManagedOperationType = z.infer<
  typeof gitManagedOperationTypeSchema
>;
export type GitManagedOperationState = z.infer<
  typeof gitManagedOperationStateSchema
>;
export type GitMergeRebaseAction = z.infer<typeof gitMergeRebaseActionSchema>;
export type GitBisectAction = z.infer<typeof gitBisectActionSchema>;
export type GitManagedOperationAction = z.infer<
  typeof gitManagedOperationActionSchema
>;
export type GitInteractiveRebaseTodoAction = z.infer<
  typeof gitInteractiveRebaseTodoActionSchema
>;
export type GitInteractiveRebaseTodoItem = z.infer<
  typeof gitInteractiveRebaseTodoItemSchema
>;
export type GitManagedOperationContext = z.infer<
  typeof gitManagedOperationContextSchema
>;
export type GitManagedOperationWorkerState = z.infer<
  typeof gitManagedOperationWorkerStateSchema
>;
export type GitOperationObservationState = z.infer<
  typeof gitOperationObservationStateSchema
>;
export type GitManagedOperationPreview = z.infer<
  typeof gitManagedOperationPreviewSchema
>;
export type GitManagedOperationStart = z.infer<
  typeof gitManagedOperationStartSchema
>;
export type GitManagedOperationControl = z.infer<
  typeof gitManagedOperationControlSchema
>;
export type GitManagedOperationAmend = z.infer<
  typeof gitManagedOperationAmendSchema
>;
export type GitManagedOperationRecord = z.infer<
  typeof gitManagedOperationRecordSchema
>;
export type GitManagedOperationResponse = z.infer<
  typeof gitManagedOperationResponseSchema
>;
export type GitConflictKind = z.infer<typeof gitConflictKindSchema>;
export type GitConflictStage = z.infer<typeof gitConflictStageSchema>;
export type GitConflictSummary = z.infer<typeof gitConflictSummarySchema>;
export type GitConflictList = z.infer<typeof gitConflictListSchema>;
export type GitConflictDetail = z.infer<typeof gitConflictDetailSchema>;
export type GitConflictResolutionStrategy = z.infer<
  typeof gitConflictResolutionStrategySchema
>;
export type GitConflictResolutionRequest = z.infer<
  typeof gitConflictResolutionRequestSchema
>;
export type GitConflictResolutionPreview = z.infer<
  typeof gitConflictResolutionPreviewSchema
>;
export type GitConflictResolutionApply = z.infer<
  typeof gitConflictResolutionApplySchema
>;
export type GitConflictResolutionResult = z.infer<
  typeof gitConflictResolutionResultSchema
>;
export type GitCommitActionPreview = z.infer<
  typeof gitCommitActionPreviewSchema
>;
export type GitCommitActionApply = z.infer<typeof gitCommitActionApplySchema>;
export type GitCommitActionResult = z.infer<typeof gitCommitActionResultSchema>;
export type GitAction = z.infer<typeof gitActionSchema>;
export type GitActionResult = z.infer<typeof gitActionResultSchema>;
export type GitForcePushPreview = z.infer<typeof gitForcePushPreviewSchema>;
export type GitForcePushApply = z.infer<typeof gitForcePushApplySchema>;
export type WorkerWorktreeSummary = z.infer<typeof workerWorktreeSummarySchema>;
export type WorktreeInventory = z.infer<typeof worktreeInventorySchema>;
export type WorktreeCreateMode = z.infer<typeof worktreeCreateModeSchema>;
export type WorktreeCreateResult = z.infer<typeof worktreeCreateResultSchema>;
export type WorktreeCreateMutationFailure = z.infer<
  typeof worktreeCreateMutationFailureSchema
>;
export type WorktreeCreateMutationOutcome = z.infer<
  typeof worktreeCreateMutationOutcomeSchema
>;
export type WorktreeMutationResult = z.infer<
  typeof worktreeMutationResultSchema
>;
export type WorktreeRemoveResult = z.infer<typeof worktreeRemoveResultSchema>;
export type WorktreePruneResult = z.infer<typeof worktreePruneResultSchema>;
export type WorktreeStatusResult = z.infer<typeof worktreeStatusResultSchema>;
export type WorktreeObservationTarget = z.infer<
  typeof worktreeObservationTargetSchema
>;
export type CodeGraphObservationTarget = z.infer<
  typeof codeGraphObservationTargetSchema
>;
export type ProjectWorktreeCreate = z.infer<typeof projectWorktreeCreateSchema>;
export type ProjectWorktreeLock = z.infer<typeof projectWorktreeLockSchema>;
export type ProjectWorktreeRemove = z.infer<typeof projectWorktreeRemoveSchema>;
export type ProjectWorktreePrune = z.infer<typeof projectWorktreePruneSchema>;
export type ProjectWorktreePolicyUpdate = z.infer<
  typeof projectWorktreePolicyUpdateSchema
>;
export type ChatWorktreeUpdate = z.infer<typeof chatWorktreeUpdateSchema>;
export type WorktreeSelection = z.infer<typeof worktreeSelectionSchema>;

export type ChatComposerDraft = z.infer<typeof chatComposerDraftSchema>;

export type ChatRelocationState = z.infer<typeof chatRelocationStateSchema>;
export type ChatRelocationErrorCode = z.infer<
  typeof chatRelocationErrorCodeSchema
>;
export type ChatRelocationError = z.infer<typeof chatRelocationErrorSchema>;
export type ChatRelocationJobError = z.infer<
  typeof chatRelocationJobErrorSchema
>;
export type ChatRelocationProgress = z.infer<
  typeof chatRelocationProgressSchema
>;
export type ChatRelocationContextMessage = z.infer<
  typeof chatRelocationContextMessageSchema
>;
export type ChatRelocationAttachmentAvailability = z.infer<
  typeof chatRelocationAttachmentAvailabilitySchema
>;
export type ChatRelocationContextPayload = z.infer<
  typeof chatRelocationContextPayloadSchema
>;
export type ChatRelocationSnapshotSummary = z.infer<
  typeof chatRelocationSnapshotSummarySchema
>;
export type ChatRelocationHydrationBeginResult = z.infer<
  typeof chatRelocationHydrationBeginResultSchema
>;
export type ChatRelocationHydrationResult = z.infer<
  typeof chatRelocationHydrationResultSchema
>;
export type ChatRelocationJobSummary = z.infer<
  typeof chatRelocationJobSummarySchema
>;
export type ChatRelocationCreate = z.infer<typeof chatRelocationCreateSchema>;
export type ChatRelocationJobRetry = z.infer<
  typeof chatRelocationJobRetrySchema
>;
export type ChatRelocationJobCancel = z.infer<
  typeof chatRelocationJobCancelSchema
>;

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

export type AgentMessagePhase = z.infer<typeof agentMessagePhaseSchema>;
export type CodexEventCorrelation = z.infer<typeof codexEventCorrelationSchema>;
export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentCommunicationKind = z.infer<
  typeof agentCommunicationKindSchema
>;
export type ChatMessageContent = z.infer<typeof chatMessageContentSchema>;
export type ChatMessageCreate = z.infer<typeof chatMessageCreateSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatMessagePageQuery = z.infer<typeof chatMessagePageQuerySchema>;
export type ChatMessagePageInfo = z.infer<typeof chatMessagePageInfoSchema>;
export type ChatMessageWirePage = z.infer<typeof chatMessageWirePageSchema>;
export type EncryptedChatTurnCreate = z.infer<
  typeof encryptedChatTurnCreateSchema
>;
export type EncryptedChatPromptSubmitResult = z.infer<
  typeof encryptedChatPromptSubmitResultSchema
>;
export type EncryptedQueuedPrompt = z.infer<typeof encryptedQueuedPromptSchema>;
export type EncryptedQueuedPromptUpdate = z.infer<
  typeof encryptedQueuedPromptUpdateSchema
>;
export type ChatAttachmentKind = z.infer<typeof chatAttachmentKindSchema>;
export type ChatAttachmentSource = z.infer<typeof chatAttachmentSourceSchema>;
export type ChatAttachmentSummary = z.infer<typeof chatAttachmentSummarySchema>;
export type ChatExecutionLaneActor = z.infer<
  typeof chatExecutionLaneActorSchema
>;
export type ChatExecutionLaneState = z.infer<
  typeof chatExecutionLaneStateSchema
>;
export type ProjectChatExecutionLaneSummary = z.infer<
  typeof projectChatExecutionLaneSummarySchema
>;
export type StandaloneChatExecutionLaneSummary = z.infer<
  typeof standaloneChatExecutionLaneSummarySchema
>;
export type ContextualChatExecutionLaneSummary = z.infer<
  typeof contextualChatExecutionLaneSummarySchema
>;
export type ChatExecutionLaneSummary = z.infer<
  typeof chatExecutionLaneSummarySchema
>;
export type ChatExecutionLaneRelease = z.infer<
  typeof chatExecutionLaneReleaseSchema
>;
export type AgentInteractionRequestKind = z.infer<
  typeof agentInteractionRequestKindSchema
>;
export type AgentInteractionRequestStatus = z.infer<
  typeof agentInteractionRequestStatusSchema
>;
export type AgentInteractionProvenance = z.infer<
  typeof agentInteractionProvenanceSchema
>;
export type AgentInteractionRequestPayload = z.infer<
  typeof agentInteractionRequestPayloadSchema
>;
export type AgentInteractionResponse = z.infer<
  typeof agentInteractionResponseSchema
>;
export type AgentInteractionRequestCreate = z.infer<
  typeof agentInteractionRequestCreateSchema
>;
export type AgentInteractionResolutionCreate = z.infer<
  typeof agentInteractionResolutionCreateSchema
>;
export type EncryptedAgentInteractionRequestCreate = z.infer<
  typeof encryptedAgentInteractionRequestCreateSchema
>;
export type EncryptedAgentInteractionResolutionCreate = z.infer<
  typeof encryptedAgentInteractionResolutionCreateSchema
>;
export type AgentInteractionRuntimeRequest = z.infer<
  typeof agentInteractionRuntimeRequestSchema
>;
export type EncryptedAgentInteractionRuntimeRequest = z.infer<
  typeof encryptedAgentInteractionRuntimeRequestSchema
>;
export type AgentInteractionAccepted = z.infer<
  typeof agentInteractionAcceptedSchema
>;
export type AgentInteractionRequest = z.infer<
  typeof agentInteractionRequestSchema
>;
export type EncryptedAgentInteractionRequest = z.infer<
  typeof encryptedAgentInteractionRequestSchema
>;
export type AgentInteractionRequestWire = z.infer<
  typeof agentInteractionRequestWireSchema
>;
export type AgentInteractionResolutionWireCreate = z.infer<
  typeof agentInteractionResolutionWireCreateSchema
>;
export type AgentInteractionRequestQuery = z.infer<
  typeof agentInteractionRequestQuerySchema
>;
export type CantripAgentOperationName = z.infer<
  typeof cantripAgentOperationNameSchema
>;
export type CantripAgentOperationRequest = z.infer<
  typeof cantripAgentOperationRequestSchema
>;
export type CantripAgentOperationResult = z.infer<
  typeof cantripAgentOperationResultSchema
>;
export type CantripMcpBinding = z.infer<typeof cantripMcpBindingSchema>;
export type CantripMcpConnectionDocument = z.infer<
  typeof cantripMcpConnectionDocumentSchema
>;
export type CantripMcpBrokerOperationRequest = z.infer<
  typeof cantripMcpBrokerOperationRequestSchema
>;
export type WorkerCantripMcpOperationCall = z.infer<
  typeof workerCantripMcpOperationCallSchema
>;
export type CantripCliCommandName = z.infer<typeof cantripCliCommandNameSchema>;
export type CantripCliContext = z.infer<typeof cantripCliContextSchema>;
export type CantripCliCommandRequest = z.infer<
  typeof cantripCliCommandRequestSchema
>;
export type WorkerCliCommandCall = z.infer<typeof workerCliCommandCallSchema>;
export type CantripCliCommandResult = z.infer<
  typeof cantripCliCommandResultSchema
>;
export type ChatTurnCreate = z.infer<typeof chatTurnCreateSchema>;
export type ChatTurnMode = z.infer<typeof chatTurnModeSchema>;
export type QueuedPrompt = z.infer<typeof queuedPromptSchema>;
export type QueuedPromptCreate = z.infer<typeof queuedPromptCreateSchema>;
export type QueuedPromptUpdate = z.infer<typeof queuedPromptUpdateSchema>;
export type QueuedPromptOrder = z.infer<typeof queuedPromptOrderSchema>;
export type ChatModelUpdate = z.infer<typeof chatModelUpdateSchema>;
export type ChatModelConfigurationUpdate = z.infer<
  typeof chatModelConfigurationUpdateSchema
>;
export type ChatRuntimeSelection = z.infer<typeof chatRuntimeSelectionSchema>;
export type ChatReasoningOption = z.infer<typeof chatReasoningOptionSchema>;
export type ChatReasoningState = z.infer<typeof chatReasoningStateSchema>;
export type ChatReasoningUpdate = z.infer<typeof chatReasoningUpdateSchema>;
export type ChatCompactAccepted = z.infer<typeof chatCompactAcceptedSchema>;
export type ChatInterruptAccepted = z.infer<typeof chatInterruptAcceptedSchema>;
export type ChatPauseUpdate = z.infer<typeof chatPauseUpdateSchema>;
export type ChatPauseState = z.infer<typeof chatPauseStateSchema>;
export type ChatPauseRuntimeState = z.infer<typeof chatPauseRuntimeStateSchema>;
export type ThreadGoalStatus = z.infer<typeof threadGoalStatusSchema>;
export type ThreadGoal = z.infer<typeof threadGoalSchema>;
export type ChatGoalResponse = z.infer<typeof chatGoalResponseSchema>;
export type ChatGoalCreate = z.infer<typeof chatGoalCreateSchema>;
export type ChatGoalUpdate = z.infer<typeof chatGoalUpdateSchema>;
export type ChatGoalClear = z.infer<typeof chatGoalClearSchema>;
export type PlanMode = z.infer<typeof planModeSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanQuestionOption = z.infer<typeof planQuestionOptionSchema>;
export type PlanQuestion = z.infer<typeof planQuestionSchema>;
export type PendingPlanQuestion = z.infer<typeof pendingPlanQuestionSchema>;
export type ChatPlanState = z.infer<typeof chatPlanStateSchema>;
export type EncryptedChatPlanWireState = z.infer<
  typeof encryptedChatPlanWireStateSchema
>;
export type ProjectTaskWorkloadOpaqueItem = z.infer<
  typeof projectTaskWorkloadOpaqueItemSchema
>;
export type ProjectTaskWorkloadOpaque = z.infer<
  typeof projectTaskWorkloadOpaqueSchema
>;
export type ChatPlanUpdate = z.infer<typeof chatPlanUpdateSchema>;
export type ChatPlanAnswer = z.infer<typeof chatPlanAnswerSchema>;
export type ChatPlanAccepted = z.infer<typeof chatPlanAcceptedSchema>;
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
export type AgentTurnResultMode = z.infer<typeof agentTurnResultModeSchema>;
export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>;
export type WorkflowNodeExecutionWorkerResult = z.infer<
  typeof workflowNodeExecutionResultSchema
>;
export type AgentActivityRawEnvelope = z.infer<
  typeof agentActivityRawEnvelopeSchema
>;
export type AgentActivity = z.infer<typeof agentActivitySchema>;
export type NormalizedAgentMessage = z.infer<
  typeof normalizedAgentMessageSchema
>;
export type AgentThreadSync = z.infer<typeof agentThreadSyncSchema>;
export type AgentThreadSyncItem = z.infer<typeof agentThreadSyncItemSchema>;
export type ExternalChatSourceKind = z.infer<
  typeof externalChatSourceKindSchema
>;
export type ExternalChatSourceAvailability = z.infer<
  typeof externalChatSourceAvailabilitySchema
>;
export type ExternalChatThreadStatus = z.infer<
  typeof externalChatThreadStatusSchema
>;
export type ExternalChatImportReference = z.infer<
  typeof externalChatImportReferenceSchema
>;
export type ExternalChatThreadMatch = z.infer<
  typeof externalChatThreadMatchSchema
>;
export type ExternalChatThreadMetadata = z.infer<
  typeof externalChatThreadMetadataSchema
>;
export type ExternalChatSource = z.infer<typeof externalChatSourceSchema>;
export type ExternalChatDiscoveryWorker = z.infer<
  typeof externalChatDiscoveryWorkerSchema
>;
export type ProjectExternalChatDiscovery = z.infer<
  typeof projectExternalChatDiscoverySchema
>;
export type ExternalChatDiscoveryTarget = z.infer<
  typeof externalChatDiscoveryTargetSchema
>;
export type ExternalChatDiscoveryWorkerResult = z.infer<
  typeof externalChatDiscoveryWorkerResultSchema
>;
export type ExternalChatTranscriptMetadata = z.infer<
  typeof externalChatTranscriptMetadataSchema
>;
export type ExternalChatTranscript = z.infer<
  typeof externalChatTranscriptSchema
>;
export type ExternalChatAttachment = z.infer<
  typeof externalChatAttachmentSchema
>;
export type ExternalChatAttachmentReadResult = z.infer<
  typeof externalChatAttachmentReadResultSchema
>;
export type ExternalChatReadWorkerResult = z.infer<
  typeof externalChatReadWorkerResultSchema
>;
export type ChatImportState = z.infer<typeof chatImportStateSchema>;
export type ChatImportError = z.infer<typeof chatImportErrorSchema>;
export type ChatImportJobError = z.infer<typeof chatImportJobErrorSchema>;
export type ChatImportProgress = z.infer<typeof chatImportProgressSchema>;
export type ChatImportJobSummary = z.infer<typeof chatImportJobSummarySchema>;
export type ChatImportSelection = z.infer<typeof chatImportSelectionSchema>;
export type ChatImportCreate = z.infer<typeof chatImportCreateSchema>;
export type ProjectExportTarget = z.infer<typeof projectExportTargetSchema>;
export type ProjectExportMapping = z.infer<typeof projectExportMappingSchema>;
export type ProjectExportPreviewRequest = z.infer<
  typeof projectExportPreviewRequestSchema
>;
export type ProjectExportTargetInspection = z.infer<
  typeof projectExportTargetInspectionSchema
>;
export type ProjectExportPreview = z.infer<typeof projectExportPreviewSchema>;
export type ProjectExportCreate = z.infer<typeof projectExportCreateSchema>;
export type ProjectExportChatResult = z.infer<
  typeof projectExportChatResultSchema
>;
export type ProjectExportItemOutcome = z.infer<
  typeof projectExportItemOutcomeSchema
>;
export type ProjectExportResult = z.infer<typeof projectExportResultSchema>;
export type ProjectExportChatBeginResult = z.infer<
  typeof projectExportChatBeginResultSchema
>;
export type WorkerChatAttachment = z.infer<typeof workerChatAttachmentSchema>;
export type WorkerAttachmentUploadResult = z.infer<
  typeof workerAttachmentUploadResultSchema
>;
export type WorkerAttachmentReadResult = z.infer<
  typeof workerAttachmentReadResultSchema
>;
export type WorkerProjectShareOpenResult = z.infer<
  typeof workerProjectShareOpenResultSchema
>;
export type WorkerProjectShareDescriptor = z.infer<
  typeof workerProjectShareDescriptorSchema
>;
export type OllamaModelInventoryItem = z.infer<
  typeof ollamaModelInventoryItemSchema
>;
export type OllamaModelInventory = z.infer<typeof ollamaModelInventorySchema>;
export type ChatGptModelInventoryItem = z.infer<
  typeof chatGptModelInventoryItemSchema
>;
export type ChatGptModelInventory = z.infer<typeof chatGptModelInventorySchema>;
export type ProviderQuotaSnapshot = z.infer<typeof providerQuotaSnapshotSchema>;
export type ProviderQuotaWindowObservation = z.infer<
  typeof providerQuotaWindowObservationSchema
>;
export type ProviderRateLimitResetCredit = z.infer<
  typeof providerRateLimitResetCreditSchema
>;
export type ProviderRateLimitResetCreditsSummary = z.infer<
  typeof providerRateLimitResetCreditsSummarySchema
>;
export type ProviderRateLimitResetConsumeInput = z.infer<
  typeof providerRateLimitResetConsumeInputSchema
>;
export type ProviderRateLimitResetConsumeRequest = z.infer<
  typeof providerRateLimitResetConsumeRequestSchema
>;
export type ProviderRateLimitResetConsumeOutcome = z.infer<
  typeof providerRateLimitResetConsumeOutcomeSchema
>;
export type ProviderRateLimitResetConsumeResult = z.infer<
  typeof providerRateLimitResetConsumeResultSchema
>;
export type GrokModelInventoryItem = z.infer<
  typeof grokModelInventoryItemSchema
>;
export type GrokModelInventory = z.infer<typeof grokModelInventorySchema>;
export type ServiceLogLevel = z.infer<typeof serviceLogLevelSchema>;
export type ServiceLogRecord = z.infer<typeof serviceLogRecordSchema>;
export type ServiceLogReadResult = z.infer<typeof serviceLogReadResultSchema>;
export type WorkerLogReadQuery = z.infer<typeof workerLogReadQuerySchema>;
export type WorkerLogStreamBatch = z.infer<typeof workerLogStreamBatchSchema>;
export type WorkerLogStreamServerMessage = z.infer<
  typeof workerLogStreamServerMessageSchema
>;
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type WorkerObservationEventIdentity = z.infer<
  typeof workerObservationEventIdentitySchema
>;
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
