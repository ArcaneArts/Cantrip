import { randomUUID } from "node:crypto";

import {
  DEFAULT_PERMISSION_PROFILE_ID,
  encryptedAgentInteractionRequestSchema,
  agentInteractionRequestSchema,
  chatMessageOpaqueContentSchema,
  encryptedQueuedPromptSchema,
  queuedPromptOpaqueContentSchema,
  taskMessageOpaqueContentSchema,
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
  AppDestination,
  AppDestinationUpdate,
  AgentInteractionRequest,
  AgentInteractionRequestCreate,
  AgentInteractionRequestPayload,
  AgentInteractionRequestQuery,
  AgentInteractionResolutionCreate,
  AgentInteractionResponse,
  AgentInteractionRequestWire,
  EncryptedAgentInteractionRequest,
  EncryptedAgentInteractionRequestCreate,
  EncryptedAgentInteractionResolutionCreate,
  ArchivedChatWireSummary,
  AccountLicenseWhitelistEntry,
  AccountSessionSummary,
  AuditEvent,
  AuditEventList,
  AuditEventQuery,
  BrowserWireSummary,
  EncryptedBrowserCreate,
  EncryptedBrowserUpdate,
  EncryptedChatCreate,
  EncryptedStandaloneChatCreate,
  ChatExperience,
  ChatExecutionLaneSummary,
  ContextualChatExecutionLaneSummary,
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
  StandaloneChatRootStatus,
  ArchivedStandaloneChatWireSummary,
  StandaloneChatRootJobSummary,
  ChatModelConfigurationUpdate,
  EncryptedChatUpdate,
  ChatWorktreeUpdate,
  CodeCapabilities,
  CodeEditorBuild,
  CodeRuntimeStatus,
  CodeSessionSummary,
  EncryptedCodeTabCreate,
  CodeTabWireSummary,
  AgentTimeSummary,
  DetailedTokenUsageTotals,
  EncryptedCodeTabUpdate,
  DesktopUpdateActiveWorkSummary,
  EncryptedExplorerCreate,
  EncryptedExplorerPin,
  EncryptedExplorerViewStateUpdate,
  EncryptedExplorerWorktreeUpdate,
  ExplorerWireSummary,
  EncryptedExplorerUpdate,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  ExecutionTargetWireCatalog,
  ExecutionTargetResolution,
  EncryptedGithubProjectCreate,
  EncryptedManagedFolderProjectCreate,
  GitManagedOperationContext,
  GitManagedOperationRecord,
  GitManagedOperationWorkerState,
  ModelProfileCreate,
  ModelProfileSummary,
  ModelProfileUpdate,
  ModelConfiguration,
  EncryptedMcpServerCreate,
  EncryptedMcpServerUpdate,
  McpServerOpaqueRuntime,
  McpServerWireSummary,
  EncryptedModelProviderAccountCreate,
  EncryptedModelProviderAccountUpdate,
  ModelProviderAccountWireSummary,
  EncryptedModelProviderCreate,
  ProviderCatalogSyncState,
  ProviderModelAvailability,
  ProviderModelCatalogEntry,
  ProviderModelCatalogResult,
  ModelProviderSummary,
  ModelProviderWireSummary,
  EncryptedModelProviderUpdate,
  ModelRouteSummary,
  EncryptedChatPlanWireState,
  PlanMode,
  PrivateDisplayLabelOpaque,
  OrderedIds,
  QueuedPrompt,
  QueuedPromptCreate,
  QueuedPromptOrder,
  QueuedPromptUpdate,
  ReasoningEffort,
  RemoteDesktopWireSummary,
  ResourceAudience,
  EncryptedRemoteSurfaceCreate,
  RemoteSurfaceStatus,
  RemoteSurfaceWireSummary,
  SurfacePrivateStateOpaque,
  EncryptedRemoteSurfaceUpdate,
  ProjectCloneResult,
  ProjectFolderSetupJobSummary,
  ProjectReplicaSummary,
  ProjectWireSummary,
  ProjectTokenUsage,
  ProviderTelemetryWireAnalytics,
  ProviderTelemetryDeleteResult,
  ProviderTelemetryExport,
  EncryptedProjectWorkspaceCreate,
  EncryptedProjectWorkspaceUpdate,
  ProjectWorkspaceWireList,
  ProjectWorkspaceWireSummary,
  ProjectWorktreePolicyUpdate,
  ProjectWorktreeSummary,
  EncryptedProjectViewCreate,
  ProjectViewWireSummary,
  EncryptedProjectViewUpdate,
  SettingsBundleWire,
  EncryptedTerminalCreate,
  EncryptedTerminalServiceConfiguration,
  TerminalServiceRuntimeConfiguration,
  TerminalWireSummary,
  EncryptedTerminalUpdate,
  EncryptedTaskCreate,
  TaskWireCreateResult,
  TaskOpaqueSummary,
  TaskMessageOpaqueContent,
  TaskMessageOpaqueSummary,
  ChatMessageOpaqueContent,
  ChatMessageOpaqueSummary,
  ChatComposerDraftOpaqueState,
  EncryptedChatComposerDraftWireState,
  EncryptedQueuedPrompt,
  QueuedPromptOpaqueContent,
  ThemePreference,
  TunnelAttachmentWireSummary,
  TunnelDestinationEndpoint,
  TunnelManagedRegistration,
  TunnelSourceEndpoint,
  TunnelWireSummary,
  TunnelUserWireCreate,
  TunnelUserWireUpdate,
  TokenUsageTotals,
  UserSettings,
  UserSettingsUpdate,
  UserSummary,
  WorkerCredentialScope,
  WorkerCredentialSummary,
  WorkerEnrollmentCodeStatus,
  WorkerHeartbeat,
  WorkerManagementSource,
  WorkerSummary,
  WorkerWorktreeSummary,
  WorktreeInventory,
  WorktreePolicy,
  WorktreeSelection,
  WorktreeStatusResult,
} from "@cantrip/protocol";
import {
  type ProtectedTunnelContentRecord,
  type TunnelContentErrorCode,
  type TunnelPublicDestinationEndpoint,
  type TunnelPublicSourceEndpoint,
} from "@cantrip/protocol/tunnel-content";
import {
  chatAttachmentOpaqueSummarySchema,
  type AttachmentProtectedMetadata,
  type ChatAttachmentOpaqueSummary,
} from "@cantrip/protocol/attachment-content";
import type {
  ProtectedProviderCredential,
  ProviderCredentialPublicMetadata,
} from "@cantrip/protocol/protected-secrets";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import {
  CHAT_MESSAGE_PAGE_BOUNDARY_MAX,
  selectChatMessagePageWindow,
} from "./chat-message-pagination.js";
import { CodeSettingsRepository } from "./code-settings.js";
import type { QuotaTokenAnalytics } from "../analytics/quota-token.js";
import type { SecretVault } from "../security/secret-vault.js";
import { AccountResourceUsageRepository } from "./account-resource-usage.js";
import * as schema from "./schema.js";
import { ChatImportJobRepository } from "./chat-import-jobs.js";
import { ChatRelocationJobRepository } from "./chat-relocation-jobs.js";
import { ProjectAutomationRepository } from "./project-automations.js";
import {
  AccountRepository,
  type AccountCredentialRecord,
  type ActiveUserSession,
  type AuditEventCreate,
  type UserSessionRow,
} from "./repository/accounts.js";
import {
  ProviderAccountRepository,
  ProviderCredentialIdentityConflictError,
  ProviderCredentialRevisionConflictError,
  toProviderAccountSummary,
  type ModelProviderAccountRuntime,
  type ProviderAccountCredentialMigrationRecord,
  type ProviderAccountCredentialRecord,
  type ProviderAccountCredentialSignOutRecord,
  type ProviderAccountCredentialState,
} from "./repository/provider-accounts.js";
import {
  ProviderCatalogRepository,
  toProviderSummary,
  type ModelProviderCatalogRuntime,
  type ModelProviderCatalogTarget,
  type ModelProviderRefreshTarget,
  type ProviderModelCatalogWrite,
} from "./repository/provider-catalog.js";
import {
  ModelRepository,
  toModelRouteSummary,
  toModelSummary,
  type ModelRuntime,
} from "./repository/model-runtime.js";
import {
  WorkerRepository,
  toWorkerSummary,
  type ActiveWorkerCredential,
  type WorkerEnrollmentProvision,
  type WorkerManagementRecord,
} from "./repository/workers.js";
import {
  TunnelRepository,
  type DesktopTunnelAttachmentLeaseChange,
  type DesktopTunnelAttachmentStopFence,
  type TunnelAttachmentAuthorization,
} from "./repository/tunnels.js";
import { McpRepository } from "./repository/mcp.js";
import {
  ProjectRepository,
  toProjectWorktreeSummary,
  type ProjectWorkspaceRow,
  type ProjectWorktreeExecutionContext,
} from "./repository/projects.js";
import {
  ProjectLifecycleRepository,
  type GithubProjectExecutionContext,
  type ProjectRemovalContext,
} from "./repository/project-lifecycle.js";
import {
  ExecutionPlacementUnavailableError,
  PlacementRepository,
} from "./repository/placement.js";
import {
  ExecutionTargetRepository,
  type ExecutionTargetSelectorResult,
  type FocusedExecutionTargetResourceKind,
} from "./repository/execution-targets.js";
import {
  WorktreeStateRepository,
  type ProjectWorktreeObservationContext,
  type ProjectWorktreeStatusRecord,
} from "./repository/worktree-state.js";
import {
  RunConfigurationStateRepository,
  type RunConfigurationRuntimeOperationRequest,
} from "./repository/run-configuration-state.js";
import {
  WorktreeLifecycleRepository,
  type WorktreeRemovalBlockers,
} from "./repository/worktree-lifecycle.js";
import {
  ChatExecutionLaneRepository,
  ExecutionLaneConflictError,
  chatIsExecuting,
  requiredProjectChatProjectId,
  requiredProjectChatWorktreeId,
  type ChatExecutionContext,
  type ChatExecutionLaneContext,
  type ChatExecutionLaneReleaseResult,
  type ChatExecutionRecoveryContext,
  type ChatWorktreeTransitionResult,
  type ProjectChatExecutionContext,
  type StandaloneChatExecutionContext,
} from "./repository/chat-execution-lanes.js";
import {
  ChatCatalogRepository,
  StandaloneChatPlacementUnavailableError,
} from "./repository/chat-catalog.js";
import {
  chatModelConfiguration,
  toContextualChatWireSummary,
} from "./repository/chat-mappers.js";
import { ChatStateRepository } from "./repository/chat-state.js";
import { ChatArchiveLifecycleRepository } from "./repository/chat-archive-lifecycle.js";
import { ChatForkRepository } from "./repository/chat-forks.js";
import {
  ChatConfigurationRepository,
  type ChatLiveRouting,
} from "./repository/chat-configuration.js";
import {
  toChatMessage,
  toEncryptedChatMessage,
  toTaskMessage,
} from "./repository/message-mappers.js";
import {
  TerminalRepository,
  type TerminalExecutionContext,
} from "./repository/terminals.js";
import {
  ExplorerRepository,
  type ExplorerExecutionContext,
} from "./repository/explorers.js";
import {
  CodeCapabilityUnavailableError,
  CodeSurfaceRepository,
  type CodeTabExecutionContext,
} from "./repository/code-surfaces.js";
import { BrowserRepository } from "./repository/browsers.js";
import {
  RemoteSurfaceRepository,
  type RemoteSurfaceExecutionContext,
} from "./repository/remote-surfaces.js";
import { ProjectViewRepository } from "./repository/project-views.js";
import {
  TelemetryRepository,
  ZERO_AGENT_TIME,
  ZERO_TOKEN_USAGE,
  tokenUsageTotals,
  type AgentTimeAnalytics,
  type ModelBehaviorObservationInput,
  type ProviderQuotaObservationInput,
  type QuotaTokenAnalyticsQuery,
  type TokenUsageRecordInput,
} from "./repository/telemetry.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
  type RepositoryTransaction,
} from "./repository/database.js";
import { ProjectFolderSetupJobRepository } from "./project-folder-setup-jobs.js";
import { StandaloneChatRootJobRepository } from "./standalone-chat-root-jobs.js";
import { ProjectGithubConversionJobRepository } from "./project-github-conversion-jobs.js";
import { EncryptionRegistryRepository } from "./encryption-registry.js";
import { PolicyRepository } from "./policies.js";
import { ProjectReplicaJobRepository } from "./project-replica-jobs.js";
import {
  TaskRepository,
  taskOpaqueColumns,
  toTaskOpaqueSummary,
} from "./tasks.js";
import { TaskSchedulingRepository } from "./task-scheduling.js";
import { TaskDispatchRepository } from "./task-dispatch.js";
import { WorkflowRunRepository } from "./workflow-runs.js";
import { WorkflowRepository } from "./workflows.js";
import { WorkflowTriggerRepository } from "./workflow-triggers.js";
import { ProjectTabLayoutRepository } from "./tab-layouts.js";

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

export const DEFAULT_OLLAMA_PROVIDER_ID =
  "00000000-0000-0000-0000-000000000010";
export const DEFAULT_MODEL_ID = "00000000-0000-0000-0000-000000000020";
export const DEFAULT_MODEL_ROUTE_ID = "00000000-0000-0000-0000-000000000021";
export interface ChatAttachmentRecord extends ChatAttachmentOpaqueSummary {
  workerId: string;
}

export function toChatAttachmentOpaqueSummary(
  attachment: ChatAttachmentRecord,
): ChatAttachmentOpaqueSummary {
  return chatAttachmentOpaqueSummarySchema.parse({
    id: attachment.id,
    chatId: attachment.chatId,
    sizeBytes: attachment.sizeBytes,
    status: attachment.status,
    protectedMetadata: attachment.protectedMetadata,
    createdAt: attachment.createdAt,
  });
}

export class AgentInteractionConflictError extends Error {}

export type ChatExecutionAttribution =
  | {
      contextKind?: "project";
      executionLaneId: string;
      scratchRootId?: null;
      worktreeId: string;
    }
  | {
      contextKind: "standalone";
      executionLaneId: string;
      scratchRootId: string;
      worktreeId: null;
    };

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

function agentInteractionRequestBase(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): Omit<AgentInteractionRequest, "payload" | "response"> {
  return {
    id: request.id,
    requestKey: request.requestKey,
    projectId: request.projectId,
    provenance: {
      chatId: request.chatId,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      executionLaneId: request.executionLaneId,
      workflowRunId: request.workflowRunId,
      workflowNodeId: request.workflowNodeId,
      workerId: request.workerId,
    },
    status: request.status,
    resolvedByUserId: request.resolvedByUserId,
    expiresAt: request.expiresAt ? toISOString(request.expiresAt) : null,
    resolvedAt: request.resolvedAt ? toISOString(request.resolvedAt) : null,
    createdAt: toISOString(request.createdAt),
    updatedAt: toISOString(request.updatedAt),
  } as Omit<AgentInteractionRequest, "payload" | "response">;
}

function toAgentInteractionRequestWire(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): AgentInteractionRequestWire {
  const base = agentInteractionRequestBase(request);
  if (request.protectedPayload) {
    if (request.payload || request.response) {
      throw new Error("An interaction row mixes visible and protected data.");
    }
    return encryptedAgentInteractionRequestSchema.parse({
      ...base,
      classification: { kind: request.kind },
      protectedPayload: request.protectedPayload,
      protectedResponse: request.protectedResponse,
    });
  }
  if (!request.payload || request.protectedResponse) {
    throw new Error("An interaction row has incomplete protected data.");
  }
  return agentInteractionRequestSchema.parse({
    ...base,
    payload: request.payload,
    response: request.response,
  });
}

function toAgentInteractionRequest(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): AgentInteractionRequest {
  return agentInteractionRequestSchema.parse(
    toAgentInteractionRequestWire(request),
  );
}

function toEncryptedAgentInteractionRequest(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): EncryptedAgentInteractionRequest {
  return encryptedAgentInteractionRequestSchema.parse(
    toAgentInteractionRequestWire(request),
  );
}

function agentInteractionResponseForStorage(
  payload: AgentInteractionRequestPayload,
  response: AgentInteractionResponse,
): AgentInteractionResponse {
  if (payload.kind !== "userInput" || response.kind !== "userInput") {
    return response;
  }
  const secretQuestionIds = new Set(
    payload.questions
      .filter((question) => question.isSecret)
      .map((question) => question.id),
  );
  return {
    ...response,
    answers: Object.fromEntries(
      Object.entries(response.answers).map(([questionId, answer]) => [
        questionId,
        secretQuestionIds.has(questionId)
          ? { answers: ["[redacted]"] }
          : answer,
      ]),
    ),
  };
}

function validateAgentInteractionResponse(
  payload: AgentInteractionRequestPayload,
  response: AgentInteractionResponse,
): void {
  if (payload.kind !== response.kind) {
    throw new AgentInteractionConflictError(
      "Response kind does not match the pending request.",
    );
  }
  if (payload.kind === "commandExecution") {
    if (response.kind !== "commandExecution") return;
    if (
      payload.availableDecisions &&
      !payload.availableDecisions.includes(response.decision)
    ) {
      throw new AgentInteractionConflictError(
        "Command response is not one of the available decisions.",
      );
    }
    if (
      response.decision === "acceptWithExecpolicyAmendment" &&
      !response.execpolicyAmendment
    ) {
      throw new AgentInteractionConflictError(
        "An execpolicy amendment is required for this decision.",
      );
    }
    if (
      response.decision === "applyNetworkPolicyAmendment" &&
      !response.networkPolicyAmendment
    ) {
      throw new AgentInteractionConflictError(
        "A network policy amendment is required for this decision.",
      );
    }
  }
  if (payload.kind === "userInput") {
    if (response.kind !== "userInput") return;
    const questionIds = new Set(
      payload.questions.map((question) => question.id),
    );
    const answerIds = Object.keys(response.answers);
    if (
      answerIds.length !== questionIds.size ||
      answerIds.some((questionId) => !questionIds.has(questionId))
    ) {
      throw new AgentInteractionConflictError(
        "User input responses must answer each requested question exactly once.",
      );
    }
  }
  if (payload.kind === "permissions") {
    if (response.kind !== "permissions") return;
    if (
      !jsonPermissionSubset(response.permissions, payload.requestedPermissions)
    ) {
      throw new AgentInteractionConflictError(
        "Granted permissions must be a subset of the requested permissions.",
      );
    }
  }
}

function jsonPermissionSubset(granted: unknown, requested: unknown): boolean {
  if (Array.isArray(granted)) {
    if (!Array.isArray(requested)) return false;
    return granted.every((candidate) =>
      requested.some(
        (allowed) => JSON.stringify(candidate) === JSON.stringify(allowed),
      ),
    );
  }
  if (granted && typeof granted === "object") {
    if (
      !requested ||
      typeof requested !== "object" ||
      Array.isArray(requested)
    ) {
      return false;
    }
    const requestedRecord = requested as Record<string, unknown>;
    return Object.entries(granted).every(
      ([key, value]) =>
        key in requestedRecord &&
        jsonPermissionSubset(value, requestedRecord[key]),
    );
  }
  return Object.is(granted, requested);
}

function toChatAttachment(
  attachment: typeof schema.chatAttachments.$inferSelect,
): ChatAttachmentRecord {
  return {
    ...chatAttachmentOpaqueSummarySchema.parse({
      id: attachment.id,
      chatId: attachment.chatId,
      sizeBytes: attachment.sizeBytes,
      status: attachment.status,
      protectedMetadata: attachment.protectedMetadata,
      createdAt: toISOString(attachment.createdAt),
    }),
    workerId: attachment.workerId,
  };
}

function toQueuedPrompt(
  prompt: typeof schema.queuedPrompts.$inferSelect,
): QueuedPrompt {
  if (prompt.text === null) {
    throw new Error("Encrypted queued prompts require the opaque mapper.");
  }
  return {
    id: prompt.id,
    chatId: prompt.chatId,
    text: prompt.text,
    mode: prompt.mode,
    attachments: [],
    modelId: prompt.modelId,
    reasoningEffort: prompt.reasoningEffort,
    customSubagentModel: prompt.customSubagentModel,
    subagentModelId: prompt.subagentModelId,
    subagentReasoningEffort: prompt.subagentReasoningEffort,
    worktreeId: prompt.worktreeId,
    position: prompt.position,
    frozen: prompt.frozen,
    createdAt: toISOString(prompt.createdAt),
    updatedAt: toISOString(prompt.updatedAt),
  };
}

function toEncryptedQueuedPrompt(
  prompt: typeof schema.queuedPrompts.$inferSelect,
): EncryptedQueuedPrompt {
  if (!prompt.opaqueContent || prompt.text !== null) {
    throw new Error("Visible queued prompts require the plaintext mapper.");
  }
  return encryptedQueuedPromptSchema.parse({
    ...prompt.opaqueContent,
    chatId: prompt.chatId,
    attachments: prompt.attachments,
    position: prompt.position,
    createdAt: toISOString(prompt.createdAt),
    updatedAt: toISOString(prompt.updatedAt),
  });
}

export class ServerRepository {
  readonly accounts: AccountRepository;
  readonly accountResourceUsage: AccountResourceUsageRepository;
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
  readonly standaloneChatRootJobs: StandaloneChatRootJobRepository;
  readonly projectGithubConversionJobs: ProjectGithubConversionJobRepository;
  readonly tabLayouts: ProjectTabLayoutRepository;
  readonly workflows: WorkflowRepository;
  readonly workflowRuns: WorkflowRunRepository;
  readonly workflowTriggers: WorkflowTriggerRepository;

  constructor(
    private readonly database: RepositoryDatabase,
    secretVault: SecretVault,
  ) {
    // Retained in the constructor while unrelated server-owned credentials
    // finish moving out of this repository. Provider and MCP payloads never
    // use this server key.
    void secretVault;
    this.accountResourceUsage = new AccountResourceUsageRepository(database);
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
        this.nextProjectTabPosition(projectId),
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
        this.nextProjectTabPosition(projectId),
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
        this.nextProjectTabPosition(projectId),
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
    this.terminals = new TerminalRepository(database, {
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
      getTerminalExecutionContext: (ownerId, terminalId) =>
        this.getTerminalExecutionContext(ownerId, terminalId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
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
        this.nextProjectTabPosition(projectId),
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
        this.nextProjectTabPosition(projectId),
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
    this.projectViews = new ProjectViewRepository(database, {
      getProjectSource: (ownerId, projectId) =>
        this.getProjectSource(ownerId, projectId),
      getProjectWorktreeContext: (ownerId, projectId, worktreeId) =>
        this.getProjectWorktreeContext(ownerId, projectId, worktreeId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
    });
    this.remoteSurfaces = new RemoteSurfaceRepository(database, {
      getRemoteDesktop: (ownerId, desktopId) =>
        this.getRemoteDesktop(ownerId, desktopId),
      getRemoteSurfaceExecutionContext: (ownerId, surfaceId) =>
        this.getRemoteSurfaceExecutionContext(ownerId, surfaceId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
    });
    this.browsers = new BrowserRepository(database, {
      getProjectSource: (ownerId, projectId) =>
        this.getProjectSource(ownerId, projectId),
      getRemoteSurfaceExecutionContext: (ownerId, surfaceId) =>
        this.getRemoteSurfaceExecutionContext(ownerId, surfaceId),
      nextProjectTabPosition: (projectId) =>
        this.nextProjectTabPosition(projectId),
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
      listProjectReplicas: (ownerId, projectId) =>
        this.listProjectReplicas(ownerId, projectId),
    });
    this.workflows = new WorkflowRepository(database);
    this.workflowRuns = new WorkflowRunRepository(database);
    this.workflowTriggers = new WorkflowTriggerRepository(database);
    this.tabLayouts = new ProjectTabLayoutRepository(database);
  }

  async migrateProviderSecrets(): Promise<void> {
    // Pre-release migration 0119 removes every server-readable predecessor.
  }

  async migrateProviderAccountCredentialSecrets(): Promise<void> {
    // Pre-release migration 0119 signs legacy accounts out.
  }

  async migrateMcpServerSecrets(): Promise<void> {
    // Pre-release migration 0119 deletes legacy MCP rows.
  }

  async ensureLocalIdentity(): Promise<UserSummary> {
    return this.accounts.ensureLocalIdentity();
  }

  async countAccountUsers(): Promise<number> {
    return this.accounts.countAccountUsers();
  }

  async desktopUpdateActiveWork(
    ownerId: string,
  ): Promise<DesktopUpdateActiveWorkSummary> {
    const count = sql<number>`count(*)::int`;
    const [
      activeChats,
      queuedPrompts,
      terminalServices,
      workflowRuns,
      projectReplicaJobs,
      chatRelocationJobs,
      chatImportJobs,
      projectAutomationRuns,
      gitOperations,
      runConfigurationRuntimes,
    ] = await Promise.all([
      this.database
        .select({ count })
        .from(schema.chats)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(
          and(
            isNull(schema.chats.archivedAt),
            inArray(schema.chats.status, ["running", "waiting-for-approval"]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.queuedPrompts)
        .innerJoin(
          schema.chats,
          eq(schema.chats.id, schema.queuedPrompts.chatId),
        )
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.terminals)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.terminals.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .where(eq(schema.terminals.serviceEnabled, true)),
      this.database
        .select({ count })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.ownerId, ownerId),
            inArray(schema.workflowRuns.status, [
              "queued",
              "running",
              "waiting",
              "cancelling",
              "recovering",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.projectReplicaJobs)
        .where(
          and(
            eq(schema.projectReplicaJobs.ownerId, ownerId),
            inArray(schema.projectReplicaJobs.state, [
              "queued",
              "running",
              "blocked",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.chatRelocationJobs)
        .where(
          and(
            eq(schema.chatRelocationJobs.ownerId, ownerId),
            inArray(schema.chatRelocationJobs.state, [
              "queued",
              "waiting-for-idle",
              "validating",
              "preparing-replica",
              "transferring-attachments",
              "hydrating-runtime",
              "ready-to-commit",
              "blocked",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.chatImportJobs)
        .where(
          and(
            eq(schema.chatImportJobs.ownerId, ownerId),
            inArray(schema.chatImportJobs.state, [
              "queued",
              "reading",
              "importing",
              "awaiting-hydration",
              "hydrating",
              "blocked",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.projectAutomationRuns)
        .where(
          and(
            eq(schema.projectAutomationRuns.ownerId, ownerId),
            inArray(schema.projectAutomationRuns.status, [
              "dispatching",
              "started",
              "queued",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.gitOperations)
        .where(
          and(
            eq(schema.gitOperations.ownerId, ownerId),
            inArray(schema.gitOperations.state, [
              "queued",
              "running",
              "conflicted",
              "awaiting-user-action",
            ]),
          ),
        ),
      this.database
        .select({ count })
        .from(schema.runConfigurationRuntimes)
        .where(
          and(
            eq(schema.runConfigurationRuntimes.ownerId, ownerId),
            inArray(schema.runConfigurationRuntimes.state, [
              "starting",
              "running",
              "stopping",
            ]),
          ),
        ),
    ]);

    const maximum = 4_294_967_295;
    const value = (rows: Array<{ count: number }>) =>
      Math.min(maximum, rows[0]?.count ?? 0);
    const backgroundJobs =
      value(workflowRuns) +
      value(projectReplicaJobs) +
      value(chatRelocationJobs) +
      value(chatImportJobs) +
      value(projectAutomationRuns) +
      value(gitOperations) +
      value(runConfigurationRuntimes);
    return {
      activeChats: value(activeChats),
      queuedPrompts: value(queuedPrompts),
      terminalServices: value(terminalServices),
      backgroundJobs: Math.min(maximum, backgroundJobs),
    };
  }

  async accountEmailIsWhitelisted(normalizedEmail: string): Promise<boolean> {
    return this.accounts.accountEmailIsWhitelisted(normalizedEmail);
  }

  async listAccountLicenseWhitelist(): Promise<AccountLicenseWhitelistEntry[]> {
    return this.accounts.listAccountLicenseWhitelist();
  }

  async createAccountLicenseWhitelistEntry(input: {
    addedByUserId: string;
    email: string;
    normalizedEmail: string;
  }): Promise<AccountLicenseWhitelistEntry | null> {
    return this.accounts.createAccountLicenseWhitelistEntry(input);
  }

  async deleteAccountLicenseWhitelistEntry(id: string): Promise<boolean> {
    return this.accounts.deleteAccountLicenseWhitelistEntry(id);
  }

  async createAccount(input: {
    displayName: string;
    email: string;
    normalizedEmail: string;
    passwordHash: string;
    role: UserSummary["role"];
  }): Promise<UserSummary> {
    return this.accounts.createAccount(input);
  }

  async findAccountCredential(
    normalizedEmail: string,
  ): Promise<AccountCredentialRecord | null> {
    return this.accounts.findAccountCredential(normalizedEmail);
  }

  async findAccountCredentialById(
    ownerId: string,
  ): Promise<AccountCredentialRecord | null> {
    return this.accounts.findAccountCredentialById(ownerId);
  }

  async createUserSession(input: {
    authMethod: ActiveUserSession["authMethod"];
    csrfTokenHash: string;
    expiresAt: Date;
    label: string | null;
    tokenHash: string;
    userId: string;
  }): Promise<UserSessionRow> {
    return this.accounts.createUserSession(input);
  }

  async getActiveUserSession(
    tokenHash: string,
  ): Promise<ActiveUserSession | null> {
    return this.accounts.getActiveUserSession(tokenHash);
  }

  async createMobileSignInGrant(input: {
    codeHash: string;
    createdBySessionId: string;
    expiresAt: Date;
    ownerId: string;
  }): Promise<string> {
    return this.accounts.createMobileSignInGrant(input);
  }

  async consumeMobileSignInGrant(
    codeHash: string,
  ): Promise<UserSummary | null> {
    return this.accounts.consumeMobileSignInGrant(codeHash);
  }

  async pruneMobileSignInGrants(before: Date): Promise<void> {
    return this.accounts.pruneMobileSignInGrants(before);
  }

  async isUserSessionActive(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    return this.accounts.isUserSessionActive(sessionId, userId);
  }

  async rotateSessionCsrfToken(
    sessionId: string,
    csrfTokenHash: string,
  ): Promise<boolean> {
    return this.accounts.rotateSessionCsrfToken(sessionId, csrfTokenHash);
  }

  async revokeUserSession(sessionId: string, reason: string): Promise<boolean> {
    return this.accounts.revokeUserSession(sessionId, reason);
  }

  async revokeAllUserSessions(userId: string, reason: string): Promise<number> {
    return this.accounts.revokeAllUserSessions(userId, reason);
  }

  async listUserSessions(
    userId: string,
    currentSessionId: string | null,
  ): Promise<AccountSessionSummary[]> {
    return this.accounts.listUserSessions(userId, currentSessionId);
  }

  async appendAuditEvent(input: AuditEventCreate): Promise<AuditEvent> {
    return this.accounts.appendAuditEvent(input);
  }

  async listAuditEvents(
    query: AuditEventQuery,
    ownerId?: string,
  ): Promise<AuditEventList> {
    return this.accounts.listAuditEvents(query, ownerId);
  }

  async ensureDefaultModelConfiguration(
    ownerId: string,
    modelName: string,
    ollamaBaseUrl: string,
  ): Promise<void> {
    await this.database
      .insert(schema.modelProviders)
      .values({
        id: DEFAULT_OLLAMA_PROVIDER_ID,
        ownerId,
        name: "Ollama",
        kind: "ollama",
        baseUrl: ollamaBaseUrl,
      })
      .onConflictDoNothing({ target: schema.modelProviders.id });
    await this.database
      .insert(schema.modelProfiles)
      .values({
        id: DEFAULT_MODEL_ID,
        ownerId,
        name: modelName,
      })
      .onConflictDoNothing({ target: schema.modelProfiles.id });
    await this.database
      .insert(schema.modelRoutes)
      .values({
        id: DEFAULT_MODEL_ROUTE_ID,
        modelId: DEFAULT_MODEL_ID,
        providerId: DEFAULT_OLLAMA_PROVIDER_ID,
        modelName,
        position: 0,
      })
      .onConflictDoNothing({ target: schema.modelRoutes.id });
    await this.database
      .insert(schema.userSettings)
      .values({
        userId: ownerId,
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: DEFAULT_MODEL_ID,
        defaultPermissionProfileId: DEFAULT_PERMISSION_PROFILE_ID,
      })
      .onConflictDoNothing({ target: schema.userSettings.userId });
    await this.database.execute(sql`
      update ${schema.chats}
      set model_id = ${DEFAULT_MODEL_ID}
      where model_id is null
        and exists (
          select 1 from ${schema.chatMessages}
          where ${schema.chatMessages.chatId} = ${schema.chats.id}
            and ${schema.chatMessages.role} = 'user'
        )
    `);
  }

  async ensureAccountConfiguration(ownerId: string): Promise<void> {
    await this.database
      .insert(schema.userSettings)
      .values({
        userId: ownerId,
        theme: "system",
        highContrast: false,
        proMode: false,
        proModeOpacity: 80,
        sidebarWidth: 288,
        desktopFrameRate: 30,
        desktopStreamQuality: "adaptive",
        defaultModelId: null,
        defaultPermissionProfileId: DEFAULT_PERMISSION_PROFILE_ID,
      })
      .onConflictDoNothing({ target: schema.userSettings.userId });
  }

  async getSettings(ownerId: string): Promise<SettingsBundleWire> {
    const [
      preferences,
      providerRows,
      providerAccountRows,
      providerAccountWorkerRows,
      modelRows,
      routeRows,
      providerUsageRows,
      modelUsageRows,
      agentTime,
    ] = await Promise.all([
      this.getUserSettings(ownerId),
      this.database
        .select()
        .from(schema.modelProviders)
        .where(eq(schema.modelProviders.ownerId, ownerId))
        .orderBy(asc(schema.modelProviders.name)),
      this.database
        .select({ account: schema.modelProviderAccounts })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          and(
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
            eq(schema.modelProviders.ownerId, ownerId),
          ),
        )
        .orderBy(asc(schema.modelProviderAccounts.position)),
      this.database
        .select({ binding: schema.modelProviderAccountWorkers })
        .from(schema.modelProviderAccountWorkers)
        .innerJoin(
          schema.modelProviderAccounts,
          eq(
            schema.modelProviderAccounts.id,
            schema.modelProviderAccountWorkers.accountId,
          ),
        )
        .innerJoin(
          schema.modelProviders,
          and(
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
            eq(schema.modelProviders.ownerId, ownerId),
          ),
        ),
      this.database
        .select()
        .from(schema.modelProfiles)
        .where(eq(schema.modelProfiles.ownerId, ownerId))
        .orderBy(asc(schema.modelProfiles.name)),
      this.database
        .select({
          route: schema.modelRoutes,
          providerName: schema.modelProviders.name,
        })
        .from(schema.modelRoutes)
        .innerJoin(
          schema.modelProfiles,
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
        )
        .innerJoin(
          schema.modelProviders,
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
        )
        .where(eq(schema.modelProfiles.ownerId, ownerId))
        .orderBy(asc(schema.modelRoutes.position)),
      this.database
        .select({
          id: schema.tokenUsageRecords.providerId,
          inputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.inputTokens}), 0)`.mapWith(
              Number,
            ),
          outputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.outputTokens}), 0)`.mapWith(
              Number,
            ),
        })
        .from(schema.tokenUsageRecords)
        .where(eq(schema.tokenUsageRecords.ownerId, ownerId))
        .groupBy(schema.tokenUsageRecords.providerId),
      this.database
        .select({
          id: schema.tokenUsageRecords.modelId,
          inputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.inputTokens}), 0)`.mapWith(
              Number,
            ),
          outputTokens:
            sql<number>`coalesce(sum(${schema.tokenUsageRecords.outputTokens}), 0)`.mapWith(
              Number,
            ),
        })
        .from(schema.tokenUsageRecords)
        .where(eq(schema.tokenUsageRecords.ownerId, ownerId))
        .groupBy(schema.tokenUsageRecords.modelId),
      this.getAgentTimeAnalytics(ownerId),
    ]);
    const providerUsage = new Map(
      providerUsageRows.flatMap((row) =>
        row.id
          ? [[row.id, tokenUsageTotals(row.inputTokens, row.outputTokens)]]
          : [],
      ),
    );
    const modelUsage = new Map(
      modelUsageRows.flatMap((row) =>
        row.id
          ? [[row.id, tokenUsageTotals(row.inputTokens, row.outputTokens)]]
          : [],
      ),
    );
    return {
      preferences,
      providers: providerRows.map((provider) =>
        toProviderSummary(
          provider,
          providerUsage.get(provider.id),
          agentTime.providers.get(provider.id),
          providerAccountRows
            .filter(({ account }) => account.providerId === provider.id)
            .map(({ account }) =>
              toProviderAccountSummary(
                account,
                providerAccountWorkerRows
                  .filter(({ binding }) => binding.accountId === account.id)
                  .map(({ binding }) => binding),
              ),
            ),
        ),
      ),
      models: modelRows.map((model) =>
        toModelSummary(
          model,
          routeRows
            .filter(({ route }) => route.modelId === model.id)
            .map(({ route, providerName }) =>
              toModelRouteSummary(route, providerName),
            ),
          modelUsage.get(model.id),
          agentTime.models.get(model.id),
        ),
      ),
    };
  }

  async getAgentTimeAnalytics(
    ownerId: string,
    projectId?: string,
    now = new Date(),
  ): Promise<AgentTimeAnalytics> {
    return this.telemetry.getAgentTimeAnalytics(ownerId, projectId, now);
  }

  async recordTokenUsage(
    ownerId: string,
    input: TokenUsageRecordInput,
  ): Promise<void> {
    return this.telemetry.recordTokenUsage(ownerId, input);
  }

  async recordModelBehaviorObservation(
    ownerId: string,
    input: ModelBehaviorObservationInput,
  ): Promise<void> {
    return this.telemetry.recordModelBehaviorObservation(ownerId, input);
  }

  async getProjectTokenUsage(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectTokenUsage | null> {
    return this.telemetry.getProjectTokenUsage(ownerId, projectId);
  }
  async getUserSettings(ownerId: string): Promise<UserSettings> {
    const rows = await this.database
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, ownerId))
      .limit(1);
    const settings = firstOrThrow(rows, "loading user settings");
    return {
      theme: settings.theme as ThemePreference,
      highContrast: settings.highContrast,
      proMode: settings.proMode,
      proModeOpacity: settings.proModeOpacity,
      eliteMode: settings.eliteMode,
      eliteRevealConfig: settings.eliteRevealConfig,
      sidebarWidth: settings.sidebarWidth,
      desktopFrameRate:
        settings.desktopFrameRate as UserSettings["desktopFrameRate"],
      desktopStreamQuality:
        settings.desktopStreamQuality as UserSettings["desktopStreamQuality"],
      defaultModelId: settings.defaultModelId,
      defaultReasoningEffort: settings.defaultReasoningEffort,
      defaultCustomSubagentModel: settings.defaultCustomSubagentModel,
      defaultSubagentModelId: settings.defaultSubagentModelId,
      defaultSubagentReasoningEffort: settings.defaultSubagentReasoningEffort,
      defaultPermissionProfileId:
        settings.defaultPermissionProfileId as UserSettings["defaultPermissionProfileId"],
      defaultChatModelId: settings.defaultChatModelId,
      defaultChatReasoningEffort: settings.defaultChatReasoningEffort,
      defaultChatPermissionProfileId:
        settings.defaultChatPermissionProfileId as UserSettings["defaultChatPermissionProfileId"],
      defaultWorkerId: settings.defaultWorkerId,
      lastAppMode: settings.lastAppMode as UserSettings["lastAppMode"],
      lastIdeProjectId: settings.lastIdeProjectId,
      lastIdeWorkspaceId: settings.lastIdeWorkspaceId,
      lastStandaloneChatId: settings.lastStandaloneChatId,
      destinationRevision: settings.destinationRevision,
      automaticReplicaProvisioning: settings.automaticReplicaProvisioning,
      automaticReplicaSynchronization:
        settings.automaticReplicaSynchronization as UserSettings["automaticReplicaSynchronization"],
      mobileProjectTabConfigurations: settings.mobileProjectTabConfigurations,
    };
  }

  async updateAppDestination(
    ownerId: string,
    input: AppDestinationUpdate,
  ): Promise<AppDestination | null> {
    if (input.lastIdeProjectId) {
      const projects = await this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, input.lastIdeProjectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!projects[0]) return null;
    }
    if (input.lastIdeWorkspaceId) {
      const workspaces = await this.database
        .select({ id: schema.projectWorkspaces.id })
        .from(schema.projectWorkspaces)
        .where(
          and(
            eq(schema.projectWorkspaces.id, input.lastIdeWorkspaceId),
            eq(schema.projectWorkspaces.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!workspaces[0]) return null;
    }
    if (input.lastStandaloneChatId) {
      const chats = await this.database
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.lastStandaloneChatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.contextKind, "standalone"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .limit(1);
      if (!chats[0]) return null;
    }

    const rows = await this.database
      .update(schema.userSettings)
      .set({
        ...(input.lastAppMode !== undefined
          ? { lastAppMode: input.lastAppMode }
          : {}),
        ...(input.lastIdeProjectId !== undefined
          ? { lastIdeProjectId: input.lastIdeProjectId }
          : {}),
        ...(input.lastIdeWorkspaceId !== undefined
          ? { lastIdeWorkspaceId: input.lastIdeWorkspaceId }
          : {}),
        ...(input.lastStandaloneChatId !== undefined
          ? { lastStandaloneChatId: input.lastStandaloneChatId }
          : {}),
        destinationRevision: sql`${schema.userSettings.destinationRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.userSettings.userId, ownerId),
          eq(schema.userSettings.destinationRevision, input.expectedRevision),
        ),
      )
      .returning({
        lastAppMode: schema.userSettings.lastAppMode,
        lastIdeProjectId: schema.userSettings.lastIdeProjectId,
        lastIdeWorkspaceId: schema.userSettings.lastIdeWorkspaceId,
        lastStandaloneChatId: schema.userSettings.lastStandaloneChatId,
        revision: schema.userSettings.destinationRevision,
      });
    const destination = rows[0];
    return destination
      ? {
          lastAppMode: destination.lastAppMode as AppDestination["lastAppMode"],
          lastIdeProjectId: destination.lastIdeProjectId,
          lastIdeWorkspaceId: destination.lastIdeWorkspaceId,
          lastStandaloneChatId: destination.lastStandaloneChatId,
          revision: destination.revision,
        }
      : null;
  }

  async updateSettings(
    ownerId: string,
    input: UserSettingsUpdate,
  ): Promise<SettingsBundleWire | null> {
    if (input.defaultModelId) {
      const model = await this.getModelRuntime(ownerId, input.defaultModelId);
      if (!model) {
        return null;
      }
    }
    if (input.defaultChatModelId) {
      const model = await this.getModelRuntime(
        ownerId,
        input.defaultChatModelId,
      );
      if (!model) {
        return null;
      }
    }
    if (input.defaultSubagentModelId) {
      const model = await this.getModelRuntime(
        ownerId,
        input.defaultSubagentModelId,
      );
      if (!model) {
        return null;
      }
    }
    if (
      input.defaultCustomSubagentModel !== undefined ||
      input.defaultSubagentModelId !== undefined
    ) {
      const current = await this.getUserSettings(ownerId);
      const customSubagentModel =
        input.defaultCustomSubagentModel ?? current.defaultCustomSubagentModel;
      const subagentModelId =
        input.defaultSubagentModelId !== undefined
          ? input.defaultSubagentModelId
          : current.defaultSubagentModelId;
      if (customSubagentModel && !subagentModelId) return null;
    }
    if (
      input.defaultWorkerId &&
      !(await this.getWorker(ownerId, input.defaultWorkerId))
    ) {
      return null;
    }
    const { mobileProjectTabConfigurations, ...scalarSettings } = input;
    await this.database
      .update(schema.userSettings)
      .set({
        ...scalarSettings,
        ...(mobileProjectTabConfigurations
          ? {
              mobileProjectTabConfigurations: sql`${schema.userSettings.mobileProjectTabConfigurations} || ${JSON.stringify(mobileProjectTabConfigurations)}::jsonb`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.userSettings.userId, ownerId));
    return this.getSettings(ownerId);
  }

  async createModelProvider(
    ownerId: string,
    input: EncryptedModelProviderCreate,
  ): Promise<ModelProviderWireSummary> {
    return this.providerCatalog.createModelProvider(ownerId, input);
  }

  async getModelProvider(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderWireSummary | null> {
    return this.providerCatalog.getModelProvider(ownerId, providerId);
  }

  async hasModelRoutesForProvider(
    ownerId: string,
    providerId: string,
  ): Promise<boolean> {
    return this.providerCatalog.hasModelRoutesForProvider(ownerId, providerId);
  }
  async listModelProviderAccounts(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderAccountWireSummary[] | null> {
    return this.providerAccounts.listModelProviderAccounts(ownerId, providerId);
  }

  async getModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialRecord | null> {
    return this.providerAccounts.getModelProviderAccountCredential(
      ownerId,
      providerId,
      accountId,
    );
  }

  async listModelProviderAccountCredentialMigrations(
    ownerId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord[]> {
    return this.providerAccounts.listModelProviderAccountCredentialMigrations(
      ownerId,
    );
  }

  async getModelProviderAccountCredentialMigration(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<ProviderAccountCredentialMigrationRecord | null> {
    return this.providerAccounts.getModelProviderAccountCredentialMigration(
      ownerId,
      providerId,
      accountId,
    );
  }

  async storeModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: ProtectedProviderCredential,
    metadata: ProviderCredentialPublicMetadata,
    expectedRevision?: number,
  ): Promise<ProviderAccountCredentialRecord | null> {
    return this.providerAccounts.storeModelProviderAccountCredential(
      ownerId,
      providerId,
      accountId,
      input,
      metadata,
      expectedRevision,
    );
  }

  async updateModelProviderAccountCredentialState(input: {
    accountId: string;
    expectedRevision: number;
    ownerId: string;
    providerId: string;
    state: Extract<
      ProviderAccountCredentialState,
      "reauth-required" | "conflict"
    >;
  }): Promise<boolean> {
    return this.providerAccounts.updateModelProviderAccountCredentialState(
      input,
    );
  }

  async clearModelProviderAccountCredential(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    return this.providerAccounts.clearModelProviderAccountCredential(
      ownerId,
      providerId,
      accountId,
      expectedRevision,
    );
  }

  async takeModelProviderAccountCredentialForSignOut(
    ownerId: string,
    providerId: string,
    accountId: string,
    expectedRevision?: number,
  ): Promise<ProviderAccountCredentialSignOutRecord | null> {
    return this.providerAccounts.takeModelProviderAccountCredentialForSignOut(
      ownerId,
      providerId,
      accountId,
      expectedRevision,
    );
  }

  async createModelProviderAccount(
    ownerId: string,
    providerId: string,
    input: EncryptedModelProviderAccountCreate,
  ): Promise<ModelProviderAccountWireSummary | null> {
    return this.providerAccounts.createModelProviderAccount(
      ownerId,
      providerId,
      input,
    );
  }

  async updateModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
    input: EncryptedModelProviderAccountUpdate,
  ): Promise<ModelProviderAccountWireSummary | null> {
    return this.providerAccounts.updateModelProviderAccount(
      ownerId,
      providerId,
      accountId,
      input,
    );
  }

  async reorderModelProviderAccounts(
    ownerId: string,
    providerId: string,
    input: OrderedIds,
  ): Promise<boolean> {
    return this.providerAccounts.reorderModelProviderAccounts(
      ownerId,
      providerId,
      input,
    );
  }

  async deleteModelProviderAccount(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    return this.providerAccounts.deleteModelProviderAccount(
      ownerId,
      providerId,
      accountId,
    );
  }

  async getModelProviderAccountRuntime(
    ownerId: string,
    providerId: string,
    accountId?: string,
  ): Promise<{
    accountId: string;
    credentialHomeKey: string;
  } | null> {
    return this.providerAccounts.getModelProviderAccountRuntime(
      ownerId,
      providerId,
      accountId,
    );
  }

  async recordModelProviderAccountStatus(
    accountId: string,
    workerId: string,
    status: {
      authenticated: boolean;
      email: string | null;
      planType: string | null;
      weeklyUsage: { usedPercent: number; resetsAt: number | null } | null;
    },
  ): Promise<void> {
    return this.providerAccounts.recordModelProviderAccountStatus(
      accountId,
      workerId,
      status,
    );
  }

  async recordModelProviderAccountUsage(input: {
    accountId: string;
    ownerId: string;
    planType: string | null;
    providerId: string;
    resetsAt: number | null;
    usedPercent: number;
  }): Promise<boolean> {
    return this.providerAccounts.recordModelProviderAccountUsage(input);
  }

  async recordProviderQuotaObservation(
    ownerId: string,
    input: ProviderQuotaObservationInput,
  ): Promise<boolean> {
    return this.telemetry.recordProviderQuotaObservation(ownerId, input);
  }

  async getQuotaTokenAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<QuotaTokenAnalytics> {
    return this.telemetry.getQuotaTokenAnalytics(ownerId, query);
  }

  async getProviderTelemetryAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<ProviderTelemetryWireAnalytics> {
    return this.telemetry.getProviderTelemetryAnalytics(ownerId, query);
  }

  async exportProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryExport | null> {
    return this.telemetry.exportProviderTelemetry(ownerId, providerId);
  }

  async deleteProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryDeleteResult | null> {
    return this.telemetry.deleteProviderTelemetry(ownerId, providerId);
  }
  async deleteModelProvider(ownerId: string, providerId: string) {
    return this.providerCatalog.deleteModelProvider(ownerId, providerId);
  }

  async updateModelProvider(
    ownerId: string,
    providerId: string,
    input: EncryptedModelProviderUpdate,
  ): Promise<ModelProviderWireSummary | null> {
    return this.providerCatalog.updateModelProvider(ownerId, providerId, input);
  }

  async getModelProviderCatalogRuntime(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderCatalogRuntime | null> {
    return this.providerCatalog.getModelProviderCatalogRuntime(
      ownerId,
      providerId,
    );
  }

  async listModelProviderCatalogTargets(
    ownerId: string,
  ): Promise<ModelProviderCatalogTarget[]> {
    return this.providerCatalog.listModelProviderCatalogTargets(ownerId);
  }

  async listModelProviderRefreshTargets(
    ownerId: string,
  ): Promise<ModelProviderRefreshTarget[]> {
    return this.providerCatalog.listModelProviderRefreshTargets(ownerId);
  }

  async setProviderCatalogSyncState(
    providerId: string,
    input: {
      scopeKey: string;
      status: ProviderCatalogSyncState["status"];
      errorCode?: string | null;
      etag?: string | null;
      refreshStartedAt?: Date | null;
      lastSuccessAt?: Date | null;
      workerId?: string | null;
      providerAccountId?: string | null;
    },
  ): Promise<void> {
    return this.providerCatalog.setProviderCatalogSyncState(providerId, input);
  }

  async reconcileProviderModelCatalog(
    ownerId: string,
    providerId: string,
    input: {
      models: ProviderModelCatalogWrite[];
      availabilityScope: string;
      availableNativeModelIds: ReadonlySet<string>;
      autoCreateLogicalModels?: boolean;
      autoCreateNativeModelIds?: ReadonlySet<string>;
      availabilityWorkerId?: string | null;
      availabilityProviderAccountId?: string | null;
      defaultNativeModelId?: string | null;
    },
  ): Promise<boolean> {
    return this.providerCatalog.reconcileProviderModelCatalog(
      ownerId,
      providerId,
      input,
    );
  }

  async getProviderModelCatalog(
    ownerId: string,
    providerId: string,
    servedStale = false,
  ): Promise<ProviderModelCatalogResult | null> {
    return this.providerCatalog.getProviderModelCatalog(
      ownerId,
      providerId,
      servedStale,
    );
  }

  async listProviderModelAvailability(
    ownerId: string,
    providerId: string,
    providerModelId: string,
  ): Promise<ProviderModelAvailability[]> {
    return this.providerCatalog.listProviderModelAvailability(
      ownerId,
      providerId,
      providerModelId,
    );
  }
  async createModelProfile(
    ownerId: string,
    input: ModelProfileCreate,
  ): Promise<ModelProfileSummary | null> {
    return this.models.createModelProfile(ownerId, input);
  }

  async deleteModelProfile(ownerId: string, modelId: string) {
    return this.models.deleteModelProfile(ownerId, modelId);
  }

  async updateModelProfile(
    ownerId: string,
    modelId: string,
    input: ModelProfileUpdate,
  ): Promise<ModelProfileSummary | null> {
    return this.models.updateModelProfile(ownerId, modelId, input);
  }

  async getModelRuntime(
    ownerId: string,
    modelId: string,
    routeId?: string,
  ): Promise<ModelRuntime | null> {
    return this.models.getModelRuntime(ownerId, modelId, routeId);
  }

  async getModelRuntimeByRoute(
    ownerId: string,
    routeId: string,
  ): Promise<ModelRuntime | null> {
    return this.models.getModelRuntimeByRoute(ownerId, routeId);
  }

  async getModelRuntimes(
    ownerId: string,
    modelId?: string,
    routeId?: string,
    includeDisabled = false,
  ): Promise<ModelRuntime[]> {
    return this.models.getModelRuntimes(
      ownerId,
      modelId,
      routeId,
      includeDisabled,
    );
  }

  async listModelProviderAccountRuntimes(
    ownerId: string,
    providerId: string,
    workerId: string,
    providerModelId: string | null,
  ): Promise<ModelProviderAccountRuntime[]> {
    return this.models.listModelProviderAccountRuntimes(
      ownerId,
      providerId,
      workerId,
      providerModelId,
    );
  }
  async getOrCreateServerId(): Promise<string> {
    return this.workers.getOrCreateServerId();
  }

  async createWorkerEnrollmentCode(input: {
    codeHash: string;
    createdBySessionId: string | null;
    expiresAt: Date;
    label: string | null;
    ownerId: string;
  }): Promise<string> {
    return this.workers.createWorkerEnrollmentCode(input);
  }

  async findReusableWorkerId(
    ownerId: string,
    candidateWorkerIds: readonly string[],
  ): Promise<string | null> {
    return this.workers.findReusableWorkerId(ownerId, candidateWorkerIds);
  }

  async getWorkerEnrollmentCodeStatus(
    ownerId: string,
    enrollmentCodeId: string,
  ): Promise<WorkerEnrollmentCodeStatus | null> {
    return this.workers.getWorkerEnrollmentCodeStatus(
      ownerId,
      enrollmentCodeId,
    );
  }

  async exchangeWorkerEnrollmentCode(input: {
    codeHash: string;
    credentialHash: string;
    credentialId: string;
    heartbeat: WorkerHeartbeat;
    replacement: { workerId: string; credentialHash: string } | null;
    scopes: WorkerCredentialScope[];
  }): Promise<WorkerEnrollmentProvision> {
    return this.workers.exchangeWorkerEnrollmentCode(input);
  }

  async authenticateWorkerCredential(
    secretHash: string,
    workerId: string,
    requiredScope: WorkerCredentialScope,
  ): Promise<ActiveWorkerCredential | null> {
    return this.workers.authenticateWorkerCredential(
      secretHash,
      workerId,
      requiredScope,
    );
  }

  async listWorkerCredentials(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerCredentialSummary[] | null> {
    return this.workers.listWorkerCredentials(ownerId, workerId);
  }

  async rotateWorkerCredential(input: {
    credentialHash: string;
    credentialId: string;
    label: string | null;
    ownerId: string;
    scopes: WorkerCredentialScope[];
    workerId: string;
  }): Promise<WorkerCredentialSummary | null> {
    return this.workers.rotateWorkerCredential(input);
  }

  async revokeWorkerCredential(
    ownerId: string,
    workerId: string,
    credentialId: string,
    reason = "revoked by owner",
  ): Promise<WorkerCredentialSummary | null> {
    return this.workers.revokeWorkerCredential(
      ownerId,
      workerId,
      credentialId,
      reason,
    );
  }

  async recordWorker(
    ownerId: string,
    heartbeat: WorkerHeartbeat,
  ): Promise<WorkerSummary> {
    return this.workers.recordWorker(ownerId, heartbeat);
  }

  async listWorkers(ownerId: string): Promise<WorkerSummary[]> {
    return this.workers.listWorkers(ownerId);
  }

  async getWorker(
    ownerId: string,
    workerId: string,
  ): Promise<WorkerSummary | null> {
    return this.workers.getWorker(ownerId, workerId);
  }

  async listWorkerManagement(
    ownerId: string,
  ): Promise<WorkerManagementRecord[]> {
    return this.workers.listWorkerManagement(ownerId);
  }

  async updateWorkerDisplayName(
    ownerId: string,
    workerId: string,
    name: string,
  ): Promise<WorkerSummary | null> {
    return this.workers.updateWorkerDisplayName(ownerId, workerId, name);
  }

  async unlinkWorker(ownerId: string, workerId: string): Promise<boolean> {
    return this.workers.unlinkWorker(ownerId, workerId);
  }

  async getWorkerOwnerId(workerId: string): Promise<string | null> {
    return this.workers.getWorkerOwnerId(workerId);
  }

  async onlineWorkerCount(ownerId: string): Promise<number> {
    return this.workers.onlineWorkerCount(ownerId);
  }
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

  async getProjectSource(ownerId: string, projectId: string) {
    return this.projects.getProjectSource(ownerId, projectId);
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

  private async nextProjectTabPosition(projectId: string): Promise<number> {
    const positions = await Promise.all([
      this.database
        .select({ position: schema.chats.position })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.projectId, projectId),
            isNull(schema.chats.archivedAt),
          ),
        )
        .orderBy(desc(schema.chats.position))
        .limit(1),
      this.database
        .select({ position: schema.terminals.position })
        .from(schema.terminals)
        .where(eq(schema.terminals.projectId, projectId))
        .orderBy(desc(schema.terminals.position))
        .limit(1),
      this.database
        .select({ position: schema.explorers.position })
        .from(schema.explorers)
        .where(eq(schema.explorers.projectId, projectId))
        .orderBy(desc(schema.explorers.position))
        .limit(1),
      this.database
        .select({ position: schema.codeTabs.position })
        .from(schema.codeTabs)
        .where(eq(schema.codeTabs.projectId, projectId))
        .orderBy(desc(schema.codeTabs.position))
        .limit(1),
      this.database
        .select({ position: schema.browsers.position })
        .from(schema.browsers)
        .where(eq(schema.browsers.projectId, projectId))
        .orderBy(desc(schema.browsers.position))
        .limit(1),
      this.database
        .select({ position: schema.projectViews.position })
        .from(schema.projectViews)
        .where(eq(schema.projectViews.projectId, projectId))
        .orderBy(desc(schema.projectViews.position))
        .limit(1),
    ]);
    return Math.max(...positions.map((rows) => rows[0]?.position ?? -1)) + 1;
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
  private async browserIsOwnedBy(
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
    const rows = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, ownerId));
    if (
      rows.length !== input.ids.length ||
      rows.some(({ id }) => !input.ids.includes(id))
    )
      return false;
    await this.database.transaction(async (transaction) => {
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.projects)
          .set({ position })
          .where(eq(schema.projects.id, id));
      }
    });
    return true;
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
    const identities = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (identities[0]?.contextKind === "standalone") {
      return this.getStandaloneChatExecutionContext(ownerId, chatId);
    }
    const rows = await this.database
      .select({
        chat: schema.chats,
        lane: schema.chatExecutionLanes,
        project: schema.projects,
        settings: schema.userSettings,
        worktree: schema.projectWorktrees,
        runtime: schema.chatRuntimeSessions,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.userSettings,
        eq(schema.userSettings.userId, schema.projects.ownerId),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
      )
      .leftJoin(
        schema.chatRuntimeSessions,
        and(
          eq(schema.chatRuntimeSessions.chatId, schema.chats.id),
          eq(
            schema.chatRuntimeSessions.workerId,
            schema.projectWorktrees.workerId,
          ),
          eq(schema.chatRuntimeSessions.worktreeId, schema.projectWorktrees.id),
        ),
      )
      .leftJoin(
        schema.chatExecutionLanes,
        and(
          eq(schema.chatExecutionLanes.chatId, schema.chats.id),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    const projectId = requiredProjectChatProjectId(row.chat.projectId);
    return {
      contextKind: "project",
      automationPaused: row.chat.automationPaused,
      chatId: row.chat.id,
      cwd: row.worktree.absolutePath,
      experience: row.chat.experience as ChatWireSummary["experience"],
      defaultPermissionProfileId:
        (row.settings?.defaultPermissionProfileId as
          UserSettings["defaultPermissionProfileId"] | undefined) ??
        DEFAULT_PERMISSION_PROFILE_ID,
      executionLaneId: row.lane?.id ?? null,
      isPrimary: row.worktree.isPrimary,
      modelId: row.chat.modelId,
      reasoningEffort: row.chat.reasoningEffort,
      modelConfiguration: chatModelConfiguration(row.chat),
      modelRouteId: row.runtime?.modelRouteId ?? null,
      providerAccountId: row.runtime?.providerAccountId ?? null,
      permissionProfileId: row.chat.permissionProfileId,
      planMode: row.chat.planMode as PlanMode,
      projectId,
      rootKind: row.worktree.rootKind,
      scratchRootId: null,
      status: row.chat.status as ChatWireSummary["status"],
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.worktree.workerId,
      worktreeId: row.worktree.id,
      worktreeMode: row.chat.worktreeMode as ChatWireSummary["worktreeMode"],
      worktreePolicy: row.project.worktreePolicy as WorktreePolicy,
    };
  }

  private async getStandaloneChatExecutionContext(
    ownerId: string,
    chatId: string,
  ): Promise<StandaloneChatExecutionContext | null> {
    const rows = await this.database
      .select({
        chat: schema.chats,
        lane: schema.chatExecutionLanes,
        root: schema.standaloneChatRoots,
        runtime: schema.chatRuntimeSessions,
        settings: schema.userSettings,
      })
      .from(schema.chats)
      .innerJoin(
        schema.standaloneChatRoots,
        and(
          eq(schema.standaloneChatRoots.id, schema.chats.activeScratchRootId),
          eq(schema.standaloneChatRoots.chatId, schema.chats.id),
          eq(schema.standaloneChatRoots.ownerId, schema.chats.ownerId),
          eq(schema.standaloneChatRoots.workerId, schema.chats.activeWorkerId),
        ),
      )
      .leftJoin(
        schema.chatRuntimeSessions,
        and(
          eq(schema.chatRuntimeSessions.chatId, schema.chats.id),
          eq(
            schema.chatRuntimeSessions.workerId,
            schema.standaloneChatRoots.workerId,
          ),
          eq(
            schema.chatRuntimeSessions.scratchRootId,
            schema.standaloneChatRoots.id,
          ),
        ),
      )
      .leftJoin(
        schema.chatExecutionLanes,
        and(
          eq(schema.chatExecutionLanes.chatId, schema.chats.id),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .leftJoin(
        schema.userSettings,
        eq(schema.userSettings.userId, schema.chats.ownerId),
      )
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chats.contextKind, "standalone"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      contextKind: "standalone",
      automationPaused: row.chat.automationPaused,
      chatId,
      cwd: row.root.protectedPathHandle ?? "standalone-root-unavailable",
      experience: "agent",
      defaultPermissionProfileId:
        (row.settings?.defaultChatPermissionProfileId as
          UserSettings["defaultChatPermissionProfileId"] | undefined) ??
        DEFAULT_PERMISSION_PROFILE_ID,
      executionLaneId: row.lane?.id ?? null,
      isPrimary: true,
      status:
        row.root.status === "ready"
          ? (row.chat.status as ChatWireSummary["status"])
          : row.root.status === "failed"
            ? "failed"
            : "offline",
      modelId: row.chat.modelId,
      reasoningEffort: row.chat.reasoningEffort,
      modelConfiguration: chatModelConfiguration(row.chat),
      modelRouteId: row.runtime?.modelRouteId ?? null,
      providerAccountId: row.runtime?.providerAccountId ?? null,
      permissionProfileId: row.chat.permissionProfileId,
      planMode: "default",
      projectId: null,
      rootKind: null,
      scratchRootStatus: row.root.status as StandaloneChatRootStatus,
      scratchRootId: row.root.id,
      threadId: row.runtime?.codexThreadId ?? null,
      workerId: row.root.workerId,
      worktreeId: null,
      worktreeMode: null,
      worktreePolicy: null,
    };
  }

  async listChatExecutionContextsByThreadId(
    ownerId: string,
    workerId: string,
    threadId: string,
  ): Promise<ChatExecutionContext[]> {
    const rows = await this.database
      .select({ chatId: schema.chatRuntimeSessions.chatId })
      .from(schema.chatRuntimeSessions)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatRuntimeSessions.chatId),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatRuntimeSessions.workerId, workerId),
          eq(schema.chatRuntimeSessions.codexThreadId, threadId),
          isNull(schema.chats.archivedAt),
        ),
      );
    const contexts = await Promise.all(
      [...new Set(rows.map(({ chatId }) => chatId))].map((chatId) =>
        this.getChatExecutionContext(ownerId, chatId),
      ),
    );
    return contexts.filter(
      (context): context is ChatExecutionContext =>
        context !== null &&
        context.workerId === workerId &&
        context.threadId === threadId,
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
    if ((worktreeId === null) === (scratchRootId === null)) {
      throw new Error("Chat runtime requires exactly one execution root.");
    }
    const rows = await this.database
      .insert(schema.chatRuntimeSessions)
      .values({
        id: randomUUID(),
        chatId,
        workerId,
        worktreeId,
        scratchRootId,
        codexThreadId: threadId,
        modelRouteId,
        providerAccountId: providerAccountId ?? null,
        status,
      })
      .onConflictDoUpdate({
        target: worktreeId
          ? [
              schema.chatRuntimeSessions.chatId,
              schema.chatRuntimeSessions.workerId,
              schema.chatRuntimeSessions.worktreeId,
            ]
          : [
              schema.chatRuntimeSessions.chatId,
              schema.chatRuntimeSessions.workerId,
              schema.chatRuntimeSessions.scratchRootId,
            ],
        targetWhere: worktreeId
          ? isNotNull(schema.chatRuntimeSessions.worktreeId)
          : isNotNull(schema.chatRuntimeSessions.scratchRootId),
        set: {
          codexThreadId: threadId,
          modelRouteId,
          ...(providerAccountId === undefined ? {} : { providerAccountId }),
          status,
          updatedAt: new Date(),
        },
      })
      .returning();
    const runtime = firstOrThrow(rows, "updating a chat runtime");
    await this.database
      .update(schema.chatExecutionLanes)
      .set({
        runtimeSessionId: runtime.id,
        codexThreadId: threadId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.chatExecutionLanes.chatId, chatId),
          eq(schema.chatExecutionLanes.workerId, workerId),
          worktreeId
            ? eq(schema.chatExecutionLanes.worktreeId, worktreeId)
            : eq(schema.chatExecutionLanes.scratchRootId, scratchRootId!),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      );
  }

  async setChatStatus(
    chatId: string,
    status: ChatWireSummary["status"],
  ): Promise<void> {
    await this.database
      .update(schema.chats)
      .set({
        status,
        ...(status === "idle" || status === "failed"
          ? {
              hasUnreadCompletion: sql<boolean>`case
                  when ${schema.chats.status} in ('running', 'waiting-for-approval')
                    then true
                  else ${schema.chats.hasUnreadCompletion}
                end`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.chats.id, chatId));
  }

  async acknowledgeChatCompletion(
    ownerId: string,
    chatId: string,
  ): Promise<ContextualChatWireSummary | null> {
    const rows = await this.database
      .update(schema.chats)
      .set({ hasUnreadCompletion: false })
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .returning();
    return rows[0] ? toContextualChatWireSummary(rows[0]) : null;
  }

  private async resolveAgentInteractionOwner(input: {
    projectId: string | null;
    provenance: { chatId: string | null; workerId: string };
  }): Promise<string> {
    if (input.provenance.chatId) {
      const rows = await this.database
        .select({ ownerId: schema.chats.ownerId })
        .from(schema.chats)
        .innerJoin(
          schema.workers,
          and(
            eq(schema.workers.id, input.provenance.workerId),
            eq(schema.workers.ownerId, schema.chats.ownerId),
          ),
        )
        .where(eq(schema.chats.id, input.provenance.chatId))
        .limit(1);
      if (rows[0]) return rows[0].ownerId;
    } else if (input.projectId) {
      const rows = await this.database
        .select({ ownerId: schema.projects.ownerId })
        .from(schema.projects)
        .innerJoin(
          schema.workers,
          and(
            eq(schema.workers.id, input.provenance.workerId),
            eq(schema.workers.ownerId, schema.projects.ownerId),
          ),
        )
        .where(eq(schema.projects.id, input.projectId))
        .limit(1);
      if (rows[0]) return rows[0].ownerId;
    }
    throw new AgentInteractionConflictError(
      "Interaction worker does not belong to the owning Chat or project.",
    );
  }

  async recordAgentInteractionRequest(
    input: AgentInteractionRequestCreate,
  ): Promise<AgentInteractionRequest> {
    const ownerId = await this.resolveAgentInteractionOwner(input);
    if (input.provenance.chatId) {
      const chats = await this.database
        .select({ id: schema.chats.id, projectId: schema.chats.projectId })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.provenance.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!chats[0] || chats[0].projectId !== input.projectId) {
        throw new AgentInteractionConflictError(
          "Interaction provenance does not match the project chat.",
        );
      }
    }

    const now = new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const expiredAtCreation = expiresAt !== null && expiresAt <= now;
    const rows = await this.database
      .insert(schema.agentInteractionRequests)
      .values({
        id: randomUUID(),
        requestKey: input.requestKey,
        ownerId,
        projectId: input.projectId,
        chatId: input.provenance.chatId,
        workerId: input.provenance.workerId,
        executionLaneId: input.provenance.executionLaneId,
        threadId: input.provenance.threadId,
        turnId: input.provenance.turnId,
        itemId: input.provenance.itemId,
        workflowRunId: input.provenance.workflowRunId,
        workflowNodeId: input.provenance.workflowNodeId,
        kind: input.payload.kind,
        status: expiredAtCreation ? "expired" : "pending",
        payload: input.payload,
        expiresAt,
        resolvedAt: expiredAtCreation ? now : null,
      })
      .onConflictDoNothing({
        target: schema.agentInteractionRequests.requestKey,
      })
      .returning();
    const inserted = Boolean(rows[0]);
    let request = rows[0];
    if (!request) {
      const existing = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.requestKey, input.requestKey))
        .limit(1);
      request = firstOrThrow(existing, "reading an interaction request");
    }
    const normalized = toAgentInteractionRequest(request);
    if (
      !inserted &&
      (normalized.projectId !== input.projectId ||
        JSON.stringify(normalized.provenance) !==
          JSON.stringify(input.provenance) ||
        JSON.stringify(normalized.payload) !== JSON.stringify(input.payload) ||
        normalized.expiresAt !== (expiresAt?.toISOString() ?? null))
    ) {
      throw new AgentInteractionConflictError(
        "Interaction request key was reused with different request data.",
      );
    }
    if (input.provenance.chatId && request.status === "pending") {
      await this.database
        .update(schema.chats)
        .set({ status: "waiting-for-approval", updatedAt: new Date() })
        .where(eq(schema.chats.id, input.provenance.chatId));
    }
    return normalized;
  }

  async recordEncryptedAgentInteractionRequest(
    input: EncryptedAgentInteractionRequestCreate,
  ): Promise<EncryptedAgentInteractionRequest> {
    const ownerId = await this.resolveAgentInteractionOwner(input);
    if (input.provenance.chatId) {
      const chats = await this.database
        .select({ id: schema.chats.id, projectId: schema.chats.projectId })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.provenance.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!chats[0] || chats[0].projectId !== input.projectId) {
        throw new AgentInteractionConflictError(
          "Interaction provenance does not match the project chat.",
        );
      }
    }

    const now = new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const expiredAtCreation = expiresAt !== null && expiresAt <= now;
    const rows = await this.database
      .insert(schema.agentInteractionRequests)
      .values({
        id: randomUUID(),
        requestKey: input.requestKey,
        ownerId,
        projectId: input.projectId,
        chatId: input.provenance.chatId,
        workerId: input.provenance.workerId,
        executionLaneId: input.provenance.executionLaneId,
        threadId: input.provenance.threadId,
        turnId: input.provenance.turnId,
        itemId: input.provenance.itemId,
        workflowRunId: input.provenance.workflowRunId,
        workflowNodeId: input.provenance.workflowNodeId,
        kind: input.classification.kind,
        status: expiredAtCreation ? "expired" : "pending",
        protectedPayload: input.protectedPayload,
        expiresAt,
        resolvedAt: expiredAtCreation ? now : null,
      })
      .onConflictDoNothing({
        target: schema.agentInteractionRequests.requestKey,
      })
      .returning();
    const inserted = Boolean(rows[0]);
    let request = rows[0];
    if (!request) {
      const existing = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.requestKey, input.requestKey))
        .limit(1);
      request = firstOrThrow(
        existing,
        "reading a protected interaction request",
      );
    }
    const normalized = toEncryptedAgentInteractionRequest(request);
    if (
      !inserted &&
      (normalized.projectId !== input.projectId ||
        JSON.stringify(normalized.provenance) !==
          JSON.stringify(input.provenance) ||
        JSON.stringify(normalized.classification) !==
          JSON.stringify(input.classification) ||
        JSON.stringify(normalized.protectedPayload) !==
          JSON.stringify(input.protectedPayload) ||
        normalized.expiresAt !== (expiresAt?.toISOString() ?? null))
    ) {
      throw new AgentInteractionConflictError(
        "Interaction request key was reused with different request data.",
      );
    }
    if (input.provenance.chatId && request.status === "pending") {
      await this.database
        .update(schema.chats)
        .set({ status: "waiting-for-approval", updatedAt: new Date() })
        .where(eq(schema.chats.id, input.provenance.chatId));
    }
    return normalized;
  }

  async listAgentInteractionRequests(
    ownerId: string,
    query: AgentInteractionRequestQuery,
  ): Promise<AgentInteractionRequestWire[]> {
    await this.expireAgentInteractionRequests();
    const conditions = [eq(schema.agentInteractionRequests.ownerId, ownerId)];
    if (query.chatId) {
      conditions.push(eq(schema.agentInteractionRequests.chatId, query.chatId));
    }
    if (query.workflowRunId) {
      conditions.push(
        eq(schema.agentInteractionRequests.workflowRunId, query.workflowRunId),
      );
    }
    if (query.status) {
      conditions.push(eq(schema.agentInteractionRequests.status, query.status));
    }
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .where(and(...conditions))
      .orderBy(desc(schema.agentInteractionRequests.createdAt))
      .limit(query.limit);
    return rows.map(({ request }) => toAgentInteractionRequestWire(request));
  }

  async getAgentInteractionRequest(
    ownerId: string,
    requestId: string,
  ): Promise<AgentInteractionRequestWire | null> {
    await this.expireAgentInteractionRequests();
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .where(
        and(
          eq(schema.agentInteractionRequests.id, requestId),
          eq(schema.agentInteractionRequests.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toAgentInteractionRequestWire(rows[0].request) : null;
  }

  async getAgentInteractionRequestByKey(
    ownerId: string,
    requestKey: string,
  ): Promise<AgentInteractionRequestWire | null> {
    await this.expireAgentInteractionRequests();
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .where(
        and(
          eq(schema.agentInteractionRequests.requestKey, requestKey),
          eq(schema.agentInteractionRequests.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toAgentInteractionRequestWire(rows[0].request) : null;
  }

  async resolveAgentInteractionRequest(
    ownerId: string,
    requestId: string,
    input: AgentInteractionResolutionCreate,
  ): Promise<AgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const existing = await this.getAgentInteractionRequest(ownerId, requestId);
    if (!existing) return null;
    if (!("payload" in existing)) {
      throw new AgentInteractionConflictError(
        "Protected interaction requests require a protected response.",
      );
    }
    validateAgentInteractionResponse(existing.payload, input.response);
    const storedResponse = agentInteractionResponseForStorage(
      existing.payload,
      input.response,
    );
    if (existing.status !== "pending") {
      const rows = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.id, requestId))
        .limit(1);
      const row = firstOrThrow(rows, "reading a resolved interaction request");
      if (
        row.resolutionIdempotencyKey === input.idempotencyKey &&
        JSON.stringify(row.response) === JSON.stringify(storedResponse)
      ) {
        return toAgentInteractionRequest(row);
      }
      throw new AgentInteractionConflictError(
        `Interaction request is already ${existing.status}.`,
      );
    }

    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({
        status: "resolved",
        response: storedResponse,
        resolutionIdempotencyKey: input.idempotencyKey,
        resolvedByUserId: ownerId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.agentInteractionRequests.id, requestId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new AgentInteractionConflictError(
        "Interaction request was resolved concurrently.",
      );
    }
    if (rows[0].chatId) {
      await this.restoreChatAfterInteractions(rows[0].chatId);
    }
    return toAgentInteractionRequest(rows[0]);
  }

  async validateAgentInteractionResolution(
    ownerId: string,
    requestId: string,
    input: AgentInteractionResolutionCreate,
  ): Promise<AgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const existing = await this.getAgentInteractionRequest(ownerId, requestId);
    if (!existing) return null;
    if (!("payload" in existing)) {
      throw new AgentInteractionConflictError(
        "Protected interaction requests require a protected response.",
      );
    }
    validateAgentInteractionResponse(existing.payload, input.response);
    return existing;
  }

  async resolveEncryptedAgentInteractionRequest(
    ownerId: string,
    requestId: string,
    input: EncryptedAgentInteractionResolutionCreate,
  ): Promise<EncryptedAgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const existing = await this.getAgentInteractionRequest(ownerId, requestId);
    if (!existing) return null;
    if (!("protectedPayload" in existing)) {
      throw new AgentInteractionConflictError(
        "Visible interaction requests require a visible response.",
      );
    }
    if (existing.classification.kind !== input.classification.kind) {
      throw new AgentInteractionConflictError(
        "Response kind does not match the pending request.",
      );
    }
    if (existing.status !== "pending") {
      const rows = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.id, requestId))
        .limit(1);
      const row = firstOrThrow(
        rows,
        "reading a resolved protected interaction request",
      );
      if (row.resolutionIdempotencyKey === input.idempotencyKey) {
        return toEncryptedAgentInteractionRequest(row);
      }
      throw new AgentInteractionConflictError(
        `Interaction request is already ${existing.status}.`,
      );
    }

    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({
        status: "resolved",
        protectedResponse: input.protectedResponse,
        resolutionIdempotencyKey: input.idempotencyKey,
        resolvedByUserId: ownerId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.agentInteractionRequests.id, requestId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new AgentInteractionConflictError(
        "Interaction request was resolved concurrently.",
      );
    }
    if (rows[0].chatId) {
      await this.restoreChatAfterInteractions(rows[0].chatId);
    }
    return toEncryptedAgentInteractionRequest(rows[0]);
  }

  async validateEncryptedAgentInteractionResolution(
    ownerId: string,
    requestId: string,
    input: EncryptedAgentInteractionResolutionCreate,
  ): Promise<EncryptedAgentInteractionRequest | null> {
    await this.expireAgentInteractionRequests();
    const existing = await this.getAgentInteractionRequest(ownerId, requestId);
    if (!existing) return null;
    if (!("protectedPayload" in existing)) {
      throw new AgentInteractionConflictError(
        "Visible interaction requests require a visible response.",
      );
    }
    if (existing.classification.kind !== input.classification.kind) {
      throw new AgentInteractionConflictError(
        "Response kind does not match the pending request.",
      );
    }
    return existing;
  }

  async expireAgentInteractionRequests(
    now = new Date(),
  ): Promise<AgentInteractionRequestWire[]> {
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status: "expired", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.status, "pending"),
          lte(schema.agentInteractionRequests.expiresAt, now),
        ),
      )
      .returning();
    const chatIds = new Set(
      rows.flatMap((request) => (request.chatId ? [request.chatId] : [])),
    );
    for (const chatId of chatIds) {
      await this.restoreChatAfterInteractions(chatId);
    }
    return rows.map(toAgentInteractionRequestWire);
  }

  async interruptAgentInteractionRequests(
    chatId: string,
  ): Promise<AgentInteractionRequestWire[]> {
    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status: "interrupted", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    return rows.map(toAgentInteractionRequestWire);
  }

  async terminalizeAgentInteractionRequestFromWorker(
    requestKey: string,
    chatId: string,
    workerId: string,
    status: "expired" | "interrupted",
  ): Promise<AgentInteractionRequestWire | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.requestKey, requestKey),
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(schema.agentInteractionRequests.workerId, workerId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    if (!rows[0]) return null;
    await this.restoreChatAfterInteractions(chatId);
    return toAgentInteractionRequestWire(rows[0]);
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
    const owned = await this.database
      .select({ id: schema.chats.id })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    if (!owned[0]) return null;
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .insert(schema.chatAttachments)
        .values({
          ...input,
          chatId,
          status: "ready",
        })
        .returning();
      const attachment = firstOrThrow(rows, "creating an attachment");
      await transaction.insert(schema.chatAttachmentReplicas).values({
        attachmentId: attachment.id,
        workerId: input.workerId,
        status: "ready",
      });
      return toChatAttachment(attachment);
    });
  }

  async getChatAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const rows = await this.database
      .select({ attachment: schema.chatAttachments })
      .from(schema.chatAttachments)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatAttachments.chatId),
      )
      .where(
        and(
          eq(schema.chatAttachments.id, attachmentId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toChatAttachment(rows[0].attachment) : null;
  }

  async getChatAttachments(
    ownerId: string,
    chatId: string,
    attachmentIds: string[],
  ): Promise<ChatAttachmentRecord[]> {
    if (attachmentIds.length === 0) return [];
    const rows = await this.database
      .select({ attachment: schema.chatAttachments })
      .from(schema.chatAttachments)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatAttachments.chatId),
          eq(schema.chats.id, chatId),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          inArray(schema.chatAttachments.id, attachmentIds),
        ),
      );
    const byId = new Map(
      rows.map(({ attachment }) => [
        attachment.id,
        toChatAttachment(attachment),
      ]),
    );
    return attachmentIds.flatMap((id) => {
      const attachment = byId.get(id);
      return attachment ? [attachment] : [];
    });
  }

  async getChatAttachmentReplicaWorkerIds(
    ownerId: string,
    attachmentId: string,
  ): Promise<string[]> {
    const rows = await this.database
      .select({ workerId: schema.chatAttachmentReplicas.workerId })
      .from(schema.chatAttachmentReplicas)
      .innerJoin(
        schema.chatAttachments,
        eq(
          schema.chatAttachments.id,
          schema.chatAttachmentReplicas.attachmentId,
        ),
      )
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.chatAttachments.chatId),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatAttachmentReplicas.attachmentId, attachmentId),
          eq(schema.chatAttachmentReplicas.status, "ready"),
        ),
      );
    return [...new Set(rows.map(({ workerId }) => workerId))];
  }

  async deleteChatAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const attachment = await this.getChatAttachment(ownerId, attachmentId);
    if (!attachment) return null;
    await this.database
      .delete(schema.chatAttachments)
      .where(eq(schema.chatAttachments.id, attachmentId));
    return attachment;
  }

  async listMessages(ownerId: string, chatId: string): Promise<ChatMessage[]> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toChatMessage(message));
  }

  async listEncryptedMessages(
    ownerId: string,
    chatId: string,
  ): Promise<ChatMessageOpaqueSummary[]> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          isNotNull(schema.chatMessages.protectedContent),
        ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toEncryptedChatMessage(message));
  }

  async getLatestEncryptedUserMessage(
    ownerId: string,
    chatId: string,
  ): Promise<ChatMessageOpaqueSummary | null> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
          isNull(schema.chats.archivedAt),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.role, "user"),
          isNotNull(schema.chatMessages.protectedContent),
        ),
      )
      .orderBy(desc(schema.chatMessages.sequence))
      .limit(1);
    return rows[0] ? toEncryptedChatMessage(rows[0].message) : null;
  }

  async trimLatestEncryptedTurn(
    ownerId: string,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const chats = await transaction
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, chatId),
            eq(schema.chats.ownerId, ownerId),
            eq(schema.chats.experience, "agent"),
            isNull(schema.chats.archivedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!chats[0]) return false;
      const messages = await transaction
        .select({
          id: schema.chatMessages.id,
          sequence: schema.chatMessages.sequence,
        })
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            eq(schema.chatMessages.role, "user"),
            isNotNull(schema.chatMessages.protectedContent),
          ),
        )
        .orderBy(desc(schema.chatMessages.sequence))
        .limit(1);
      const latest = messages[0];
      if (!latest || latest.id !== messageId) return false;
      await transaction
        .delete(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            gte(schema.chatMessages.sequence, latest.sequence),
          ),
        );
      await transaction
        .update(schema.chats)
        .set({
          protectedPlan: null,
          hasPendingPlanQuestion: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.chats.id, chatId));
      return true;
    });
  }

  private async listOpaqueMessagePageRows(
    ownerId: string,
    chatId: string,
    experience: ChatExperience,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: (typeof schema.chatMessages.$inferSelect)[];
    page: ChatMessagePageInfo;
  }> {
    const protectedColumn =
      experience === "task"
        ? schema.chatMessages.taskProtectedContent
        : schema.chatMessages.protectedContent;
    const cursorCondition = query.beforeSequence
      ? lt(schema.chatMessages.sequence, query.beforeSequence)
      : undefined;
    const headers = await this.database
      .select({
        role: schema.chatMessages.role,
        sequence: schema.chatMessages.sequence,
      })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, experience),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          isNotNull(protectedColumn),
          cursorCondition,
        ),
      )
      .orderBy(desc(schema.chatMessages.sequence))
      .limit(CHAT_MESSAGE_PAGE_BOUNDARY_MAX + 1);

    if (headers.length === 0) {
      return {
        messages: [],
        page: {
          hasMore: false,
          nextBeforeSequence: null,
          oldestSequence: null,
          newestSequence: null,
          startsAtUserTurn: true,
        },
      };
    }

    const window = selectChatMessagePageWindow(headers, query.limit);
    const selectedHeaders = window.selected;
    const selectedSequences = selectedHeaders.map(({ sequence }) => sequence);
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, experience),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          isNotNull(protectedColumn),
          inArray(schema.chatMessages.sequence, selectedSequences),
        ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    const oldestSequence = selectedHeaders.at(-1)?.sequence ?? null;
    return {
      messages: rows.map(({ message }) => message),
      page: {
        hasMore: window.hasMore,
        nextBeforeSequence: window.hasMore ? oldestSequence : null,
        oldestSequence,
        newestSequence: selectedHeaders[0]?.sequence ?? null,
        startsAtUserTurn: window.startsAtUserTurn,
      },
    };
  }

  async listEncryptedMessagePage(
    ownerId: string,
    chatId: string,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: ChatMessageOpaqueSummary[];
    page: ChatMessagePageInfo;
  }> {
    const result = await this.listOpaqueMessagePageRows(
      ownerId,
      chatId,
      "agent",
      query,
    );
    return {
      messages: result.messages.map(toEncryptedChatMessage),
      page: result.page,
    };
  }

  async listAgentMessageWire(ownerId: string, chatId: string) {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) =>
      message.protectedContent
        ? toEncryptedChatMessage(message)
        : toChatMessage(message),
    );
  }

  async listTaskMessages(
    ownerId: string,
    chatId: string,
  ): Promise<TaskMessageOpaqueSummary[]> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "task"),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toTaskMessage(message));
  }

  async listTaskMessagePage(
    ownerId: string,
    chatId: string,
    query: ChatMessagePageQuery,
  ): Promise<{
    messages: TaskMessageOpaqueSummary[];
    page: ChatMessagePageInfo;
  }> {
    const result = await this.listOpaqueMessagePageRows(
      ownerId,
      chatId,
      "task",
      query,
    );
    return {
      messages: result.messages.map(toTaskMessage),
      page: result.page,
    };
  }

  async listMessageHeaders(ownerId: string, chatId: string) {
    const rows = await this.database
      .select({
        id: schema.chatMessages.id,
        executionLaneId: schema.chatMessages.executionLaneId,
        role: schema.chatMessages.role,
        createdAt: schema.chatMessages.createdAt,
      })
      .from(schema.chatMessages)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.chatMessages.chatId))
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map((row) => ({
      ...row,
      role: row.role as "assistant" | "system" | "user",
      createdAt: toISOString(row.createdAt),
    }));
  }

  async listQueuedPrompts(
    ownerId: string,
    chatId: string,
  ): Promise<QueuedPrompt[]> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.queuedPrompts.chatId, chatId))
      .orderBy(
        asc(schema.queuedPrompts.position),
        asc(schema.queuedPrompts.createdAt),
      );
    return rows.map(({ prompt }) => toQueuedPrompt(prompt));
  }

  async listEncryptedQueuedPrompts(
    ownerId: string,
    chatId: string,
  ): Promise<EncryptedQueuedPrompt[]> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .orderBy(
        asc(schema.queuedPrompts.position),
        asc(schema.queuedPrompts.createdAt),
      );
    return rows.map(({ prompt }) => toEncryptedQueuedPrompt(prompt));
  }

  async getEncryptedQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<EncryptedQueuedPrompt | null> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toEncryptedQueuedPrompt(rows[0].prompt) : null;
  }

  async createEncryptedQueuedPrompt(
    ownerId: string,
    chatId: string,
    input: QueuedPromptOpaqueContent,
    attachments: ChatAttachmentOpaqueSummary[],
  ): Promise<EncryptedQueuedPrompt | null> {
    const prompt = queuedPromptOpaqueContentSchema.parse(input);
    const chat = await this.database
      .select({
        contextKind: schema.chats.contextKind,
        experience: schema.chats.experience,
      })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      )
      .limit(1);
    if (!chat[0] || chat[0].experience !== "agent") return null;
    if (
      chat[0].contextKind === "standalone" &&
      (prompt.classification.mode !== "default" ||
        prompt.worktreeId !== null ||
        prompt.customSubagentModel ||
        prompt.subagentModelId !== null ||
        prompt.subagentReasoningEffort !== null)
    ) {
      throw new ExecutionLaneConflictError(
        "Standalone Chat queued prompts must use default mode without worktree or subagent settings.",
      );
    }
    const existing = await this.database
      .select()
      .from(schema.queuedPrompts)
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.queuedPrompts.idempotencyKey, prompt.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return toEncryptedQueuedPrompt(existing[0]);
    const last = await this.database
      .select({ position: schema.queuedPrompts.position })
      .from(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.chatId, chatId))
      .orderBy(desc(schema.queuedPrompts.position))
      .limit(1);
    const result = await this.database
      .insert(schema.queuedPrompts)
      .values({
        id: prompt.id,
        chatId,
        text: null,
        opaqueContent: prompt,
        mode: prompt.classification.mode,
        attachments,
        modelId: prompt.modelId,
        reasoningEffort: prompt.reasoningEffort,
        customSubagentModel: prompt.customSubagentModel,
        subagentModelId: prompt.subagentModelId,
        subagentReasoningEffort: prompt.subagentReasoningEffort,
        worktreeId: prompt.worktreeId,
        position: (last[0]?.position ?? -1) + 1,
        frozen: prompt.frozen,
        idempotencyKey: prompt.idempotencyKey,
      })
      .returning();
    return toEncryptedQueuedPrompt(firstOrThrow(result, "queueing a prompt"));
  }

  async replaceEncryptedQueuedPrompt(
    ownerId: string,
    promptId: string,
    input: QueuedPromptOpaqueContent,
    attachments: ChatAttachmentOpaqueSummary[],
  ): Promise<EncryptedQueuedPrompt | null> {
    const prompt = queuedPromptOpaqueContentSchema.parse(input);
    if (prompt.id !== promptId) return null;
    const contexts = await this.database
      .select({ contextKind: schema.chats.contextKind })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!contexts[0]) return null;
    if (
      contexts[0].contextKind === "standalone" &&
      (prompt.classification.mode !== "default" ||
        prompt.worktreeId !== null ||
        prompt.customSubagentModel ||
        prompt.subagentModelId !== null ||
        prompt.subagentReasoningEffort !== null)
    ) {
      throw new ExecutionLaneConflictError(
        "Standalone Chat queued prompts must use default mode without worktree or subagent settings.",
      );
    }
    const result = await this.database
      .update(schema.queuedPrompts)
      .set({
        opaqueContent: prompt,
        mode: prompt.classification.mode,
        attachments,
        reasoningEffort: prompt.reasoningEffort,
        customSubagentModel: prompt.customSubagentModel,
        subagentModelId: prompt.subagentModelId,
        subagentReasoningEffort: prompt.subagentReasoningEffort,
        worktreeId: prompt.worktreeId,
        frozen: prompt.frozen,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          exists(
            this.database
              .select({ id: schema.chats.id })
              .from(schema.chats)
              .where(
                and(
                  eq(schema.chats.id, schema.queuedPrompts.chatId),
                  eq(schema.chats.ownerId, ownerId),
                ),
              ),
          ),
        ),
      )
      .returning();
    return result[0] ? toEncryptedQueuedPrompt(result[0]) : null;
  }

  async getQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<QueuedPrompt | null> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.queuedPrompts.id, promptId))
      .limit(1);
    return rows[0] ? toQueuedPrompt(rows[0].prompt) : null;
  }

  async createQueuedPrompt(
    ownerId: string,
    chatId: string,
    input: QueuedPromptCreate,
    modelId: string,
    attachments: ChatAttachmentOpaqueSummary[] = [],
  ): Promise<QueuedPrompt | null> {
    const chat = await this.database
      .select({
        experience: schema.chats.experience,
        id: schema.chats.id,
        projectId: schema.chats.projectId,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chats.id, chatId))
      .limit(1);
    if (!chat[0] || chat[0].experience !== "agent") return null;
    const projectId = requiredProjectChatProjectId(chat[0].projectId);
    if (input.worktreeId) {
      const target = await this.database
        .select({ id: schema.projectWorktrees.id })
        .from(schema.projectWorktrees)
        .innerJoin(
          schema.projectSources,
          and(
            eq(
              schema.projectSources.id,
              schema.projectWorktrees.projectSourceId,
            ),
            eq(schema.projectSources.projectId, projectId),
          ),
        )
        .where(
          and(
            eq(schema.projectWorktrees.id, input.worktreeId),
            eq(schema.projectWorktrees.lifecycleState, "ready"),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .limit(1);
      if (!target[0]) return null;
    }

    const existing = await this.database
      .select()
      .from(schema.queuedPrompts)
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.queuedPrompts.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return toQueuedPrompt(existing[0]);

    const last = await this.database
      .select({ position: schema.queuedPrompts.position })
      .from(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.chatId, chatId))
      .orderBy(desc(schema.queuedPrompts.position))
      .limit(1);
    const result = await this.database
      .insert(schema.queuedPrompts)
      .values({
        id: randomUUID(),
        chatId,
        text: input.text,
        mode: input.mode,
        attachments,
        modelId,
        reasoningEffort: input.reasoningEffort ?? null,
        worktreeId: input.worktreeId,
        position: (last[0]?.position ?? -1) + 1,
        frozen: input.frozen,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    return toQueuedPrompt(firstOrThrow(result, "queueing a prompt"));
  }

  async updateQueuedPrompt(
    ownerId: string,
    promptId: string,
    input: QueuedPromptUpdate,
    attachments?: ChatAttachmentOpaqueSummary[],
  ): Promise<QueuedPrompt | null> {
    const owned = await this.database
      .select({
        experience: schema.chats.experience,
        id: schema.queuedPrompts.id,
      })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.queuedPrompts.id, promptId))
      .limit(1);
    if (!owned[0] || owned[0].experience !== "agent") return null;
    const result = await this.database
      .update(schema.queuedPrompts)
      .set({
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.reasoningEffort !== undefined
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
        ...(input.frozen !== undefined ? { frozen: input.frozen } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.queuedPrompts.id, promptId))
      .returning();
    return result[0] ? toQueuedPrompt(result[0]) : null;
  }

  async getQueuedPromptByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<QueuedPrompt | null> {
    const rows = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.queuedPrompts.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toQueuedPrompt(rows[0].prompt) : null;
  }

  async deleteQueuedPrompt(
    ownerId: string,
    promptId: string,
  ): Promise<QueuedPrompt | EncryptedQueuedPrompt | null> {
    const owned = await this.database
      .select({ prompt: schema.queuedPrompts })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.id, promptId),
          eq(schema.chats.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!owned[0]) return null;
    await this.database
      .delete(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.id, promptId));
    return owned[0].prompt.opaqueContent
      ? toEncryptedQueuedPrompt(owned[0].prompt)
      : toQueuedPrompt(owned[0].prompt);
  }

  async reorderQueuedPrompts(
    ownerId: string,
    chatId: string,
    input: QueuedPromptOrder,
  ): Promise<boolean> {
    const prompts = await this.database
      .select({ id: schema.queuedPrompts.id })
      .from(schema.queuedPrompts)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.queuedPrompts.chatId))
      .where(
        and(
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      );
    if (
      prompts.length !== input.ids.length ||
      prompts.some(({ id }) => !input.ids.includes(id))
    ) {
      return false;
    }
    await this.database.transaction(async (transaction) => {
      for (const [position, id] of input.ids.entries()) {
        await transaction
          .update(schema.queuedPrompts)
          .set({ position, updatedAt: new Date() })
          .where(eq(schema.queuedPrompts.id, id));
      }
    });
    return true;
  }

  async appendMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessage | null> {
    if (attribution?.contextKind === "standalone") {
      throw new Error("Standalone Chat messages must use protected content.");
    }
    const chat = await this.database
      .select({
        id: schema.chats.id,
        experience: schema.chats.experience,
        worktreeId: schema.chats.activeWorktreeId,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    if (!chat[0] || chat[0].experience !== "agent") {
      return null;
    }
    const worktreeId = requiredProjectChatWorktreeId(chat[0].worktreeId);

    const activeLanes = attribution
      ? await this.database
          .select({
            id: schema.chatExecutionLanes.id,
            worktreeId: schema.chatExecutionLanes.worktreeId,
          })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.id, attribution.executionLaneId),
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, attribution.worktreeId),
            ),
          )
          .limit(1)
      : await this.database
          .select({
            id: schema.chatExecutionLanes.id,
            worktreeId: schema.chatExecutionLanes.worktreeId,
          })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, worktreeId),
              eq(schema.chatExecutionLanes.state, "active"),
            ),
          )
          .limit(1);
    if (attribution && !activeLanes[0]) return null;

    if (input.idempotencyKey) {
      const existing = await this.database
        .select()
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            eq(schema.chatMessages.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        return toChatMessage(existing[0]);
      }
    }

    const result = await this.database
      .insert(schema.chatMessages)
      .values({
        id: randomUUID(),
        chatId,
        worktreeId: attribution?.worktreeId ?? worktreeId,
        executionLaneId: activeLanes[0]?.id ?? null,
        role: input.role,
        mode: input.mode ?? "default",
        content: input.content,
        reasoningEffort: input.reasoningEffort ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();
    const message = firstOrThrow(result, "appending a chat message");
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toChatMessage(message);
  }

  async appendEncryptedMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessageOpaqueSummary | null> {
    const message = chatMessageOpaqueContentSchema.parse(input);
    const chat = await this.database
      .select({
        contextKind: schema.chats.contextKind,
        experience: schema.chats.experience,
        worktreeId: schema.chats.activeWorktreeId,
        scratchRootId: schema.chats.activeScratchRootId,
      })
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.ownerId, ownerId),
          isNull(schema.chats.archivedAt),
        ),
      )
      .limit(1);
    if (!chat[0] || chat[0].experience !== "agent") return null;
    const worktreeId = chat[0].worktreeId;
    const scratchRootId = chat[0].scratchRootId;
    if ((worktreeId === null) === (scratchRootId === null)) {
      throw new Error("Chat has an invalid execution root.");
    }
    const activeLanes = attribution
      ? await this.database
          .select({ id: schema.chatExecutionLanes.id })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.id, attribution.executionLaneId),
              eq(schema.chatExecutionLanes.chatId, chatId),
              attribution.contextKind === "standalone"
                ? eq(
                    schema.chatExecutionLanes.scratchRootId,
                    attribution.scratchRootId,
                  )
                : eq(
                    schema.chatExecutionLanes.worktreeId,
                    attribution.worktreeId,
                  ),
            ),
          )
          .limit(1)
      : await this.database
          .select({ id: schema.chatExecutionLanes.id })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              worktreeId
                ? eq(schema.chatExecutionLanes.worktreeId, worktreeId)
                : eq(schema.chatExecutionLanes.scratchRootId, scratchRootId!),
              eq(schema.chatExecutionLanes.state, "active"),
            ),
          )
          .limit(1);
    if (attribution && !activeLanes[0]) return null;
    const existing = await this.database
      .select()
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, message.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (
        existing[0].id !== message.id ||
        existing[0].role !== message.classification.role ||
        existing[0].mode !== message.classification.mode ||
        existing[0].reasoningEffort !== message.reasoningEffort ||
        JSON.stringify(existing[0].attachmentIds) !==
          JSON.stringify(message.classification.attachmentIds) ||
        JSON.stringify(existing[0].protectedContent) !==
          JSON.stringify(message.protectedContent)
      ) {
        throw new Error(
          "Encrypted chat message idempotency metadata is inconsistent.",
        );
      }
      return toEncryptedChatMessage(existing[0]);
    }
    const result = await this.database
      .insert(schema.chatMessages)
      .values({
        id: message.id,
        chatId,
        worktreeId: attribution?.worktreeId ?? worktreeId,
        scratchRootId: attribution
          ? (attribution.scratchRootId ?? null)
          : scratchRootId,
        executionLaneId: activeLanes[0]?.id ?? null,
        role: message.classification.role,
        mode: message.classification.mode,
        content: null,
        protectedContent: message.protectedContent,
        attachmentIds: message.classification.attachmentIds,
        taskProtectedContent: null,
        reasoningEffort: message.reasoningEffort,
        idempotencyKey: message.idempotencyKey,
      })
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toEncryptedChatMessage(
      firstOrThrow(result, "appending an encrypted chat message"),
    );
  }

  async upsertEncryptedMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessageOpaqueSummary | null> {
    const message = chatMessageOpaqueContentSchema.parse(input);
    const existing = await this.getEncryptedMessageByIdempotencyKey(
      ownerId,
      chatId,
      message.idempotencyKey,
    );
    if (!existing) {
      return this.appendEncryptedMessage(ownerId, chatId, message, attribution);
    }
    if (existing.id !== message.id) {
      throw new Error("Encrypted chat message update targets another row.");
    }
    const result = await this.database
      .update(schema.chatMessages)
      .set({
        role: message.classification.role,
        mode: message.classification.mode,
        protectedContent: message.protectedContent,
        attachmentIds: message.classification.attachmentIds,
        reasoningEffort: message.reasoningEffort,
      })
      .where(eq(schema.chatMessages.id, message.id))
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toEncryptedChatMessage(
      firstOrThrow(result, "updating an encrypted chat message"),
    );
  }

  async getEncryptedMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<ChatMessageOpaqueSummary | null> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
      )
      .where(
        and(
          eq(schema.chats.ownerId, ownerId),
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toEncryptedChatMessage(rows[0].message) : null;
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
    const rows = await this.database
      .update(schema.chatMessages)
      .set({
        modelId,
        modelRouteId: runtime.routeId,
        providerId: runtime.provider.id,
        providerName: runtime.provider.name,
        providerModelName: runtime.model.name,
        appliedReasoningEffort: reasoning.appliedReasoningEffort,
        reasoningAdjusted: reasoning.reasoningAdjusted,
      })
      .where(
        and(
          eq(schema.chatMessages.id, messageId),
          isNotNull(schema.chatMessages.protectedContent),
          exists(
            this.database
              .select({ id: schema.chats.id })
              .from(schema.chats)
              .where(
                and(
                  eq(schema.chats.id, schema.chatMessages.chatId),
                  eq(schema.chats.ownerId, ownerId),
                ),
              ),
          ),
        ),
      )
      .returning();
    return rows[0] ? toEncryptedChatMessage(rows[0]) : null;
  }

  async appendTaskMessage(
    ownerId: string,
    chatId: string,
    input: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<TaskMessageOpaqueSummary | null> {
    if (attribution?.contextKind === "standalone") {
      throw new Error("Standalone Chats do not support Task messages.");
    }
    const message = taskMessageOpaqueContentSchema.parse(input);
    const chat = await this.database
      .select({
        id: schema.chats.id,
        experience: schema.chats.experience,
        worktreeId: schema.chats.activeWorktreeId,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(and(eq(schema.chats.id, chatId), isNull(schema.chats.archivedAt)))
      .limit(1);
    if (!chat[0] || chat[0].experience !== "task") return null;
    const worktreeId = requiredProjectChatWorktreeId(chat[0].worktreeId);

    const activeLanes = attribution
      ? await this.database
          .select({
            id: schema.chatExecutionLanes.id,
            worktreeId: schema.chatExecutionLanes.worktreeId,
          })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.id, attribution.executionLaneId),
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, attribution.worktreeId),
            ),
          )
          .limit(1)
      : await this.database
          .select({
            id: schema.chatExecutionLanes.id,
            worktreeId: schema.chatExecutionLanes.worktreeId,
          })
          .from(schema.chatExecutionLanes)
          .where(
            and(
              eq(schema.chatExecutionLanes.chatId, chatId),
              eq(schema.chatExecutionLanes.worktreeId, worktreeId),
              eq(schema.chatExecutionLanes.state, "active"),
            ),
          )
          .limit(1);
    if (attribution && !activeLanes[0]) return null;

    const existing = await this.database
      .select()
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, message.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (
        existing[0].id !== message.id ||
        existing[0].role !== message.classification.role ||
        existing[0].mode !== message.classification.mode ||
        existing[0].reasoningEffort !== message.reasoningEffort ||
        JSON.stringify(existing[0].taskAttachmentIds) !==
          JSON.stringify(message.classification.attachmentIds) ||
        JSON.stringify(existing[0].taskProtectedContent) !==
          JSON.stringify(message.protectedContent)
      ) {
        throw new Error(
          "Encrypted Task message idempotency metadata is inconsistent.",
        );
      }
      return toTaskMessage(existing[0]);
    }

    const result = await this.database
      .insert(schema.chatMessages)
      .values({
        id: message.id,
        chatId,
        worktreeId: attribution?.worktreeId ?? worktreeId,
        executionLaneId: activeLanes[0]?.id ?? null,
        role: message.classification.role,
        mode: message.classification.mode,
        content: null,
        taskProtectedContent: message.protectedContent,
        taskAttachmentIds: message.classification.attachmentIds,
        reasoningEffort: message.reasoningEffort,
        idempotencyKey: message.idempotencyKey,
      })
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toTaskMessage(firstOrThrow(result, "appending a Task message"));
  }

  async upsertTaskMessage(
    ownerId: string,
    chatId: string,
    input: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
  ): Promise<TaskMessageOpaqueSummary | null> {
    const message = taskMessageOpaqueContentSchema.parse(input);
    const existing = await this.getTaskMessageByIdempotencyKey(
      ownerId,
      chatId,
      message.idempotencyKey,
    );
    if (!existing) {
      return this.appendTaskMessage(ownerId, chatId, message, attribution);
    }
    if (existing.id !== message.id) {
      throw new Error("Encrypted Task message update targets another row.");
    }
    const result = await this.database
      .update(schema.chatMessages)
      .set({
        role: message.classification.role,
        mode: message.classification.mode,
        taskProtectedContent: message.protectedContent,
        taskAttachmentIds: message.classification.attachmentIds,
        reasoningEffort: message.reasoningEffort,
      })
      .where(eq(schema.chatMessages.id, message.id))
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toTaskMessage(
      firstOrThrow(result, "updating an encrypted Task message"),
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
    const rows = await this.database
      .update(schema.chatMessages)
      .set({
        modelId,
        modelRouteId: runtime.routeId,
        providerId: runtime.provider.id,
        providerName: runtime.provider.name,
        providerModelName: runtime.model.name,
        appliedReasoningEffort: reasoning.appliedReasoningEffort,
        reasoningAdjusted: reasoning.reasoningAdjusted,
      })
      .where(
        and(
          eq(schema.chatMessages.id, messageId),
          isNotNull(schema.chatMessages.taskProtectedContent),
          exists(
            this.database
              .select({ id: schema.chats.id })
              .from(schema.chats)
              .innerJoin(
                schema.projects,
                and(
                  eq(schema.projects.id, schema.chats.projectId),
                  eq(schema.projects.ownerId, ownerId),
                ),
              )
              .where(eq(schema.chats.id, schema.chatMessages.chatId)),
          ),
        ),
      )
      .returning();
    return rows[0] ? toTaskMessage(rows[0]) : null;
  }

  async getTaskMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<TaskMessageOpaqueSummary | null> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "task"),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toTaskMessage(rows[0].message) : null;
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
    const rows = await this.database
      .update(schema.chatMessages)
      .set({
        modelId,
        modelRouteId: runtime.routeId,
        providerId: runtime.provider.id,
        providerName: runtime.provider.name,
        providerModelName: runtime.model.name,
        appliedReasoningEffort: reasoning.appliedReasoningEffort,
        reasoningAdjusted: reasoning.reasoningAdjusted,
      })
      .where(
        and(
          eq(schema.chatMessages.id, messageId),
          isNotNull(schema.chatMessages.content),
          exists(
            this.database
              .select({ id: schema.chats.id })
              .from(schema.chats)
              .innerJoin(
                schema.projects,
                and(
                  eq(schema.projects.id, schema.chats.projectId),
                  eq(schema.projects.ownerId, ownerId),
                ),
              )
              .where(eq(schema.chats.id, schema.chatMessages.chatId)),
          ),
        ),
      )
      .returning();
    return rows[0] ? toChatMessage(rows[0]) : null;
  }

  async upsertMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate & { idempotencyKey: string },
    attribution?: ChatExecutionAttribution,
  ): Promise<ChatMessage | null> {
    const existing = await this.getMessageByIdempotencyKey(
      ownerId,
      chatId,
      input.idempotencyKey,
    );
    if (!existing) {
      return this.appendMessage(ownerId, chatId, input, attribution);
    }

    const result = await this.database
      .update(schema.chatMessages)
      .set({
        role: input.role,
        mode: input.mode ?? existing.mode,
        content: input.content,
        reasoningEffort:
          input.reasoningEffort !== undefined
            ? input.reasoningEffort
            : existing.reasoningEffort,
      })
      .where(eq(schema.chatMessages.id, existing.id))
      .returning();
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toChatMessage(firstOrThrow(result, "updating a chat message"));
  }

  async getMessageByIdempotencyKey(
    ownerId: string,
    chatId: string,
    idempotencyKey: string,
  ): Promise<ChatMessage | null> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.chatMessages.chatId),
          eq(schema.chats.experience, "agent"),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toChatMessage(rows[0].message) : null;
  }

  private async restoreChatAfterInteractions(chatId: string): Promise<void> {
    const pending = await this.database
      .select({ id: schema.agentInteractionRequests.id })
      .from(schema.agentInteractionRequests)
      .where(
        and(
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (pending[0]) return;
    await this.database
      .update(schema.chats)
      .set({ status: "running", updatedAt: new Date() })
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.status, "waiting-for-approval"),
        ),
      );
  }
}
