import { describe, expect, expectTypeOf, it } from "vitest";

import * as protocol from "./index.js";
import {
  workerCommandSchema,
  workerEventSchema,
  workerNotificationSchema,
} from "./index.js";
import type {
  AgentActivity,
  AgentInteractionRequest,
  BrowserSummary,
  CantripMcpBinding,
  CantripVersion,
  ChatRelocationJobSummary,
  ChatSummary,
  ChatTurnCreate,
  ChatFileReferencesResult,
  CodeTabSummary,
  CodexCustomizationInventory,
  DatabaseEngine,
  ExecutionTarget,
  ExternalChatTranscript,
  GitHistory,
  GitDiffFileSide,
  GitManagedOperationResponse,
  GithubInboxList,
  GithubAgentWorkflowContext,
  GithubPullRequestAgentContext,
  GithubPullRequestDetail,
  ProjectSummary,
  ProviderModelCatalogEntry,
  RemoteDesktopSummary,
  RemoteSurfaceCapabilities,
  SettingsBundle,
  SkillSummary,
  TerminalSummary,
  TunnelSummary,
  WorkerCommand,
  WorkerEvent,
  WorkerNotification,
  WorkerServerEnvelope,
  WorkerSummary,
  WorktreeInventory,
} from "./index.js";

function stableFingerprint(value: unknown) {
  const input = JSON.stringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const character = input.charCodeAt(index);
    first = Math.imul(first ^ character, 0x01000193);
    second = Math.imul(second ^ character, 0x85ebca6b);
  }
  const firstHex = (first >>> 0).toString(16).padStart(8, "0");
  const secondHex = (second >>> 0).toString(16).padStart(8, "0");
  return `${firstHex}${secondHex}:${input.length}`;
}

// Reviewed removal of the embedded workbench. Adding these names back only to
// the historical fingerprint keeps every unrelated compatibility assertion intact.
const retiredWorkbenchExports = [
  "CODE_MAX_WEBSOCKET_MESSAGE_BYTES",
  "CODE_SETTINGS_OPERATION",
  "CODE_SETTINGS_PROFILE_ID",
  "codeAgentTurnNotificationResultSchema",
  "codeAgentTurnPreparationResultSchema",
  "codeAgentTurnPreparationSessionSchema",
  "codeAttachmentCreateSchema",
  "codeAttachmentSchema",
  "codeCapabilitiesSchema",
  "codeDirtyEditorSchema",
  "codeEditorBuildSchema",
  "codeInstallVsixResultSchema",
  "codeOpenExtensionsRequestSchema",
  "codeOpenExtensionsResultSchema",
  "codeOpenFileRequestSchema",
  "codeOpenFileResultSchema",
  "codeOpenSettingsRequestSchema",
  "codeOpenSettingsResultSchema",
  "codePresentationSchema",
  "codePresentationUpdateSchema",
  "codeProbeResultSchema",
  "codeProtectedAttachmentCreateSchema",
  "codeProtectedAttachmentIntentSchema",
  "codeProtectedAttachmentWireSchema",
  "codeRuntimeStatusSchema",
  "codeSaveAllResultSchema",
  "codeSaveBeforeAgentTurnSchema",
  "codeSessionAttachmentCreateSchema",
  "codeSessionAttachmentWireSchema",
  "codeSessionListSchema",
  "codeSessionRouteBasePath",
  "codeSessionRouteGrantSchema",
  "codeSessionStatusSchema",
  "codeSessionSummarySchema",
  "codeSettingsContentContext",
  "codeSettingsInvalidationSchema",
  "codeSettingsPayloadSchema",
  "codeSettingsProfileIdSchema",
  "codeSettingsPublicStatusSchema",
  "codeSettingsReservedKeys",
  "codeSettingsResolutionSchema",
  "codeSettingsResolveRequestSchema",
  "codeSettingsRevisionConflictSchema",
  "codeSettingsScopeId",
  "codeSettingsStoredProfileSchema",
  "codeSettingsSyncStateSchema",
  "codeSettingsSynchronizeRequestSchema",
  "codeSettingsUploadSchema",
  "codeSettingsWorkbenchAttachmentCreateSchema",
  "codeSettingsWorkbenchAttachmentWireSchema",
  "codeSettingsWorkbenchOpenResultSchema",
  "codeSettingsWorkbenchSessionAttachmentCreateSchema",
  "codeSettingsWorkbenchSharedAttachmentWireSchema",
  "codeSettingsWorkerStatusSchema",
  "codeSharedAttachmentWireSchema",
  "codeSharedTransportProtocolVersionSchema",
  "codeTabStatusSchema",
  "codeThemeModeSchema",
  "codeThemeUpdateSchema",
  "codeTransportCandidateSchema",
  "codeTransportRevokeCommandSchema",
  "codeTransportRevokeResultSchema",
  "codeTransportRouteAuthorizeCommandSchema",
  "codeTransportRouteAuthorizeResultSchema",
  "codeTransportRouteRevokeCommandSchema",
  "codeTransportRouteRevokeResultSchema",
  "codeTransportSchema",
  "codeTransportWireSchema",
  "codeWorkbenchActiveEditorSchema",
  "codeWorkbenchAgentStatusSchema",
  "codeWorkbenchGitStateSchema",
  "codeWorkbenchStateSchema",
  "explorerCodeAttachmentCreateSchema",
  "explorerCodeProtectedAttachmentCreateSchema",
  "explorerCodeSessionAttachmentCreateSchema",
  "isForwardableCodeWebSocketCloseCode",
  "parseCodeSessionRoutePath",
  "protectedCodeSettingsRecordSchema",
  "unavailableCodeCapabilities",
];
const cuaRuntimeExports = [
  "CUA_CHUNK_BYTES",
  "CUA_CONTROL_BYTES",
  "CUA_MAX_CHUNKS",
  "CUA_REQUIRED_OPERATIONS",
  "MANAGED_CUA_MCP_NAME",
  "computerUseActionSchema",
  "computerUseActivityEventSchema",
  "computerUseChunkEventSchema",
  "computerUseHttpResultSchema",
  "computerUseOperationSchema",
  "computerUseRequestSchema",
  "computerUseResponseSchema",
  "computerUseResultContentSchema",
  "cuaAgentObservationSchema",
  "cuaAgentSourceSchema",
  "cuaAgentSourcesSchema",
  "cuaApprovalRequestEventSchema",
  "cuaApprovalTerminalSchema",
  "cuaBindingSchema",
  "cuaCapabilitiesSchema",
  "cuaControlsResultSchema",
  "cuaCursorAppearanceSchema",
  "cuaIdSchema",
  "cuaImageSchema",
  "cuaInputCommandSchema",
  "cuaInputReceiptSchema",
  "cuaInputResultSchema",
  "cuaInventorySchema",
  "cuaPointSchema",
  "cuaPreviewAuthoritySchema",
  "cuaPreviewBindingSchema",
  "cuaPreviewLeaseSchema",
  "cuaPreviewRevocationSchema",
  "cuaPreviewStopSchema",
  "cuaPreviewStoppedSchema",
  "cuaScopeSchema",
  "cuaSessionResultSchema",
  "cuaSessionSchema",
  "cuaSnapshotSchema",
  "cuaTargetReferenceSchema",
  "cuaTargetSchema",
  "workerComputerUseApprovalResponseCommandSchema",
  "workerComputerUseCommandSchema",
  "workerComputerUsePreviewOpenCommandSchema",
  "workerComputerUsePreviewRevokeCommandSchema",
  "workerComputerUsePreviewStopCommandSchema",
];

// Reviewed additions since the original CUA public-surface baseline at 9c7147979.
// Keep the original baseline fingerprint: additions must not hide removed or
// renamed legacy exports. These cover effects/timelines, context compaction,
// and the managed native session, history, queue, settings and command contracts.
const managedRuntimeExports = [
  "CUA_EFFECTS",
  "CUA_EFFECT_OFF",
  "CUA_MAX_SCRIPT_BYTES",
  "CUA_MAX_TIMELINE_FRAMES",
  "CUA_MAX_TIMELINE_MS",
  "authenticatedNativeModelAttributionSchema",
  "cantripMcpContextCompactInputSchema",
  "cantripMcpContextCompactResultSchema",
  "cantripMcpContextWindowSchema",
  "classifyManagedNativeMethod",
  "cuaEffectConfigurationSchema",
  "cuaEffectIdSchema",
  "cuaEffectPreferencesSchema",
  "cuaEffectStatusSchema",
  "cuaEffectWorkerStatusSchema",
  "effectiveCuaEffects",
  "emptyNativeBehaviorAttribution",
  "encryptedQueuedPromptQueueSchema",
  "managedChatPreparationSchema",
  "managedNativeMethods",
  "managedNativeServerRequests",
  "managedQueueClaimSchema",
  "managedQueueImportAckSchema",
  "managedQueueImportRecordSchema",
  "managedQueueImportResultSchema",
  "managedQueueImportSchema",
  "managedQueueLookupResultSchema",
  "managedQueueLookupSchema",
  "managedQueueMutateSchema",
  "managedQueueMutationResultSchema",
  "managedQueueMutationSchema",
  "managedQueuePendingImportSchema",
  "managedQueueReadSchema",
  "managedQueueSnapshotSchema",
  "managedQueueStartReceiptResultSchema",
  "managedQueueStartReceiptSchema",
  "managedSessionContextSchema",
  "managedSessionSubagentDefaultsSchema",
  "mergeNativeBehaviorAttribution",
  "nativeAccountDefaultsCommandSchema",
  "nativeAccountDefaultsContextSchema",
  "nativeAccountDefaultsRequestSchema",
  "nativeAccountDefaultsResponseSchema",
  "nativeAccountDefaultsResultSchema",
  "nativeAccountDefaultsSnapshotSchema",
  "nativeAccountDefaultsValuesSchema",
  "nativeAccountDefaultsWriteSchema",
  "nativeBehaviorAttributionSchema",
  "nativeChatModelInventoryQuerySchema",
  "nativeChatModelInventorySchema",
  "nativeCommandAdmissionResultSchema",
  "nativeCommandAdmissionSchema",
  "nativeCommandContinuationSchema",
  "nativeCommandDispatchSchema",
  "nativeCommandEventSchema",
  "nativeCommandExecutionSchema",
  "nativeCommandIntentSchema",
  "nativeCommandReceiptSchema",
  "nativeCommandSessionSchema",
  "nativeCommandSettlementResultSchema",
  "nativeCommandSettlementSchema",
  "nativeHistoryArchivePageSchema",
  "nativeHistoryArchiveReadSchema",
  "nativeHistoryBatchArchivePageSchema",
  "nativeHistoryBatchArchiveReadSchema",
  "nativeHistoryBatchRejectionSchema",
  "nativeHistoryBindingOpenResultSchema",
  "nativeHistoryBindingOpenSchema",
  "nativeHistoryBindingSchema",
  "nativeHistoryCommitReceiptSchema",
  "nativeHistoryIngestSchema",
  "nativeHistoryItemEvidenceSchema",
  "nativeHistoryItemIdentitySchema",
  "nativeHistoryItemMappingSchema",
  "nativeHistoryPreparedBatchSchema",
  "nativeHistoryResolveResultSchema",
  "nativeHistoryResolveSchema",
  "nativeHistoryTurnArchivePageSchema",
  "nativeHistoryTurnArchiveReadSchema",
  "nativeHistoryTurnReadIdentitySchema",
  "nativeHistoryTurnReadRequestSchema",
  "nativeHistoryTurnReadResponseSchema",
  "nativeHistoryTurnSchema",
  "nativeHistoryUsageSchema",
  "nativeInitialTurnSettingsSchema",
  "nativeModelAttributionSchema",
  "nativeModelInventoryRequestSchema",
  "nativeModelInventorySchema",
  "nativePendingRequestSchema",
  "nativePermissionPolicyClaimSchema",
  "nativePermissionPolicySchema",
  "nativePermissionTransitionResolutionSchema",
  "nativePermissionTransitionResolveSchema",
  "nativePermissionUpdateCommandSchema",
  "nativeResponseUsageCountsSchema",
  "nativeRuntimeHandoffConfigurationRequestSchema",
  "nativeRuntimeHandoffConfigurationSchema",
  "nativeRuntimeHandoffInventorySchema",
  "nativeRuntimeHandoffPreparedSchema",
  "nativeRuntimeHandoffRequestSchema",
  "nativeRuntimeHandoffStateSchema",
  "nativeRuntimeHandoffWorkerRequestSchema",
  "nativeSettingsApplicationSchema",
  "nativeSettingsBindingSchema",
  "nativeSettingsEvidenceResultSchema",
  "nativeSettingsEvidenceSchema",
  "nativeSettingsIntentSchema",
  "nativeSettingsObservationReceiptSchema",
  "nativeSettingsObservationRequestSchema",
  "nativeSettingsPatchSchema",
  "nativeSettingsPendingSchema",
  "nativeSettingsReadScopeSchema",
  "nativeSettingsRefreshRequestSchema",
  "nativeSettingsSnapshotContextSchema",
  "nativeSettingsStateSchema",
  "nativeSettingsUpdateCommandSchema",
  "nativeSettingsUpdateContextSchema",
  "nativeSettingsUpdateReceiptSchema",
  "nativeSettingsUpdateRequestSchema",
  "nativeSettingsVersionSchema",
  "nativeThreadSettingsSchema",
  "nativeTurnModelAttributionSchema",
  "nativeTurnRecoveryObservationSchema",
  "permissionTransitionSchema",
  "protectedNativeSettingsSnapshotSchema",
  "reconcileNativeHistoryUsage",
  "resolveNativeModelSelection",
  "summarizeNativeBehaviorAttribution",
  "workerComputerUseEffectsCommandSchema",
];

const accountCreditsExports = [
  "providerCreditBalance",
  "providerCreditsSnapshotSchema",
  "shouldUseChatGptCredits",
];

const labelingExports = [
  "generateLabelCommandSchema",
  "generateLabelResultSchema",
  "labelKindSchema",
  "labelWordLimit",
  "labelingInputSchema",
  "labelingInstructions",
  "lowestLabelingEffort",
  "normalizeGeneratedLabel",
];

// Reviewed read-only Git summary for Task counters; preserve legacy exports.
const gitChangeSummaryExports = [
  "gitChangeSummaryRequestSchema",
  "gitChangeSummarySchema",
];

const browserCursorExports = [
  "browserAgentCursorSchema",
  "cantripMcpWebSessionPointerInputSchema",
  "remoteCursorSpriteSchema",
];

const taskGoalHandoffExports = [
  "TASK_FINALIZER_GOAL_PROMPT_LIMIT",
  "TASK_NATIVE_GOAL_OBJECTIVE_LIMIT",
];

// Reviewed encrypted Task conversation additions from #2001.
const taskConversationExports = [
  "encryptedConversationPromptSubmitResultSchema",
];

// Reviewed file-tree additions from #1992; preserve the legacy fingerprints.
const chatFileReferencesExports = [
  "chatFileReferencesRequestContentSchema",
  "chatFileReferencesResultContentSchema",
];

const managedWorkerCommands = [
  "chat.account-defaults",
  "chat.automation.resume",
  "chat.native-control",
  "chat.native-logical.cancel",
  "chat.native-logical.complete",
  "chat.permissions.update",
  "chat.queue.changed",
  "chat.queue.execute",
  "chat.queue.prepare",
  "chat.runtime.handoff",
  "chat.settings.read",
  "chat.settings.update",
  "computer-use.effects.sync",
  "task.message.protect",
  "terminal.prepare-state",
];
const editorBindingExports = [
  "explorerFileBindingSchema",
  "explorerOperationWireRequestSchema",
  "standaloneChatFileBindingSchema",
];
const taskRecoveryExports = ["taskRecoveryStartSchema"];
// Reviewed additive traffic constants from #2204, omitted from its export list.
const liveTrafficExports = [
  "ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES",
  "ACCOUNT_LIVE_TRAFFIC_SAMPLE_INTERVAL_SECONDS",
  "ACCOUNT_LIVE_TRAFFIC_WINDOW_SECONDS",
];
const workspaceOwnershipExports = [
  "WorkspaceCommandError",
  "applyWorkspaceCommand",
  "seedWorkspaceOwnership",
  "workspaceActionSchema",
  "workspaceCommandSchema",
  "workspaceOwnershipSchema",
  "workspacePaneSchema",
  "workspaceReceiptSchema",
  "workspaceSeedRequestSchema",
  "workspaceTabSchema",
  "workspaceWindowSchema",
];
const taskAutomaticRetryExports = [
  "taskAutomaticRetrySchema",
  "taskFailureKindForError",
  "taskFailureKindSchema",
];
const fileDocumentExports = [
  "fileDocumentCreateSchema",
  "fileDocumentPrivateStateOpaqueSchema",
  "fileDocumentPrivateStateProtectedContentSchema",
  "fileDocumentWireListSchema",
  "fileDocumentWireSummarySchema",
];
const conversationCatalogExports = [
  "archivedConversationWireSummarySchema",
  "conversationCatalogQuerySchema",
  "conversationCatalogWirePageSchema",
  "conversationCursorSchema",
  "conversationRestoreSchema",
  "conversationUsageResultSchema",
  "conversationUsageSchema",
  "conversationWireSummarySchema",
];
const legacyFileImportExports = [
  "importWorkspaceLegacyFiles",
  "workspaceLegacyFileImportReceiptSchema",
  "workspaceLegacyFileImportRequestSchema",
  "workspaceLegacyFileImportSchema",
];

describe("protocol public surface compatibility", () => {
  it("preserves the root runtime export baseline with reviewed CUA and managed-session additions", () => {
    const exportNames = Object.keys(protocol).sort();
    const baselineNames = [
      ...retiredWorkbenchExports,
      ...exportNames.filter(
        (name) =>
          !cuaRuntimeExports.includes(name) &&
          !managedRuntimeExports.includes(name) &&
          !accountCreditsExports.includes(name) &&
          !browserCursorExports.includes(name) &&
          !taskGoalHandoffExports.includes(name) &&
          !taskRecoveryExports.includes(name) &&
          !liveTrafficExports.includes(name) &&
          !workspaceOwnershipExports.includes(name) &&
          !fileDocumentExports.includes(name) &&
          !legacyFileImportExports.includes(name) &&
          !conversationCatalogExports.includes(name) &&
          !taskAutomaticRetryExports.includes(name) &&
          !taskConversationExports.includes(name) &&
          !chatFileReferencesExports.includes(name) &&
          !editorBindingExports.includes(name) &&
          !labelingExports.includes(name) &&
          !gitChangeSummaryExports.includes(name),
      ),
    ].sort();

    expect(
      exportNames.filter((name) => retiredWorkbenchExports.includes(name)),
    ).toEqual([]);
    expect(exportNames).toHaveLength(2101);
    expect(
      exportNames.filter((name) => conversationCatalogExports.includes(name)),
    ).toEqual(conversationCatalogExports);
    expect(
      exportNames.filter((name) => legacyFileImportExports.includes(name)),
    ).toEqual(legacyFileImportExports);
    expect(
      exportNames.filter((name) => fileDocumentExports.includes(name)),
    ).toEqual(fileDocumentExports);
    expect(
      exportNames.filter((name) => liveTrafficExports.includes(name)),
    ).toEqual(liveTrafficExports);
    expect(
      exportNames.filter((name) => workspaceOwnershipExports.includes(name)),
    ).toEqual(workspaceOwnershipExports);
    expect(
      exportNames.filter((name) => taskAutomaticRetryExports.includes(name)),
    ).toEqual(taskAutomaticRetryExports);
    expect(
      exportNames.filter((name) => gitChangeSummaryExports.includes(name)),
    ).toEqual(gitChangeSummaryExports);
    expect(
      exportNames.filter((name) => taskRecoveryExports.includes(name)),
    ).toEqual(taskRecoveryExports);
    expect(
      exportNames.filter((name) => editorBindingExports.includes(name)),
    ).toEqual(editorBindingExports);
    expect(
      exportNames.filter((name) => taskConversationExports.includes(name)),
    ).toEqual(taskConversationExports);
    expect(
      exportNames.filter((name) => chatFileReferencesExports.includes(name)),
    ).toEqual(chatFileReferencesExports);
    expect(
      exportNames.filter((name) => taskGoalHandoffExports.includes(name)),
    ).toEqual(taskGoalHandoffExports);
    expect(
      exportNames.filter((name) => labelingExports.includes(name)),
    ).toEqual(labelingExports);
    expect(
      exportNames.filter((name) => accountCreditsExports.includes(name)),
    ).toEqual(accountCreditsExports);
    expect(
      exportNames.filter((name) => browserCursorExports.includes(name)),
    ).toEqual(browserCursorExports);
    expect(
      exportNames.filter((name) => managedRuntimeExports.includes(name)),
    ).toEqual(managedRuntimeExports);
    expect(
      exportNames.filter((name) => cuaRuntimeExports.includes(name)),
    ).toEqual(cuaRuntimeExports);
    expect(baselineNames).toHaveLength(1_946);
    expect(stableFingerprint(baselineNames)).toBe("abf3ec23c24613e7:63806");
  });

  it("keeps worker discriminators stable and ordered", () => {
    const commandTypes = workerCommandSchema.options.map(
      (option) => option.shape.type.value,
    );
    const eventTypes = workerEventSchema.options.map(
      (option) => option.shape.type.value,
    );
    const notificationTypes = workerNotificationSchema.options.map(
      (option) => option.shape.type.value,
    );

    expect(commandTypes).toHaveLength(278);
    expect(
      commandTypes.filter((type) => type === "file-document.operation"),
    ).toHaveLength(1);
    expect(
      commandTypes.filter((type) => type === "git.change-summary"),
    ).toHaveLength(1);
    expect(commandTypes.some((type) => type.startsWith("code."))).toBe(false);
    expect(
      commandTypes.filter((type) => type === "chat.files.references"),
    ).toHaveLength(1);
    expect(
      commandTypes.filter((type) => type === "label.generate"),
    ).toHaveLength(1);
    expect(
      commandTypes
        .filter((type) => managedWorkerCommands.includes(type))
        .sort(),
    ).toEqual(managedWorkerCommands);
    const baselineCommands = commandTypes.filter(
      (type) =>
        !managedWorkerCommands.includes(type) &&
        type !== "chat.files.references" &&
        type !== "label.generate" &&
        type !== "file-document.operation" &&
        type !== "git.change-summary",
    );
    expect(baselineCommands).toHaveLength(259);
    expect(baselineCommands[0]).toBe("computer-use.operation");
    expect(baselineCommands[1]).toBe("computer-use.approval.respond");
    expect(baselineCommands.slice(2, 5)).toEqual([
      "computer-use.preview.open",
      "computer-use.preview.stop",
      "computer-use.preview.revoke",
    ]);
    expect(stableFingerprint(baselineCommands.slice(5))).toBe(
      "ee8ee6fa79872956:6594",
    );
    expect(eventTypes).toHaveLength(22);
    expect(
      eventTypes.filter((type) => type === "computer-use.activity"),
    ).toHaveLength(1);
    expect(eventTypes.slice(0, 3)).toEqual([
      "computer-use.approval.request",
      "computer-use.approval.terminal",
      "computer-use.snapshot.chunk",
    ]);
    expect(
      stableFingerprint(
        eventTypes.slice(3).filter((type) => type !== "computer-use.activity"),
      ),
    ).toBe("1d616530daf5093c:466");
    expect(notificationTypes).toHaveLength(15);
    expect(notificationTypes[0]).toBe("computer-use.approval.terminal");
    expect(stableFingerprint(notificationTypes.slice(1))).toBe(
      "6768707e4d303352:420",
    );
  });

  it("validates the reviewed file-reference schemas from the public root", () => {
    const request = {
      type: "chat.files.references",
      references: ["src/file.ts", "x".repeat(8_192)],
    };
    expect(
      protocol.chatFileReferencesRequestContentSchema.parse(request),
    ).toEqual(request);
    for (const reference of ["", "x".repeat(8_193)]) {
      expect(
        protocol.chatFileReferencesRequestContentSchema.safeParse({
          ...request,
          references: [reference],
        }).success,
      ).toBe(false);
    }
    const result = {
      root: "/repository",
      entries: [
        { reference: "src/file.ts", path: "src/file.ts", kind: "file" },
      ],
    };
    expect(
      protocol.chatFileReferencesResultContentSchema.parse(result),
    ).toEqual(result);
    expect(
      protocol.chatFileReferencesResultContentSchema.safeParse({
        ...result,
        entries: [{ ...result.entries[0], kind: "unknown" }],
      }).success,
    ).toBe(false);
  });

  it("validates the reviewed Task message protection command", () => {
    const command = {
      type: "task.message.protect",
      message: {
        id: "c8381010-e259-49e9-8035-e14ffaf97a79",
        classification: { role: "user", mode: "default", attachmentIds: [] },
        protectedContent: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "A".repeat(16),
            ciphertext: "A".repeat(22),
          },
        },
        reasoningEffort: null,
        idempotencyKey: "x".repeat(200),
      },
    };
    expect(workerCommandSchema.parse(command)).toEqual(command);
    for (const idempotencyKey of ["", "x".repeat(201)]) {
      expect(
        workerCommandSchema.safeParse({
          ...command,
          message: { ...command.message, idempotencyKey },
        }).success,
      ).toBe(false);
    }
    expect(
      workerCommandSchema.safeParse({ ...command, message: undefined }).success,
    ).toBe(false);
  });

  it("keeps representative type-only exports available from the root", () => {
    expectTypeOf<ChatFileReferencesResult>().not.toBeNever();
    expectTypeOf<DatabaseEngine>().not.toBeNever();
    expectTypeOf<RemoteSurfaceCapabilities>().not.toBeNever();
    expectTypeOf<CantripVersion>().not.toBeNever();
    expectTypeOf<WorkerSummary>().not.toBeNever();
    expectTypeOf<SkillSummary>().not.toBeNever();
    expectTypeOf<ProviderModelCatalogEntry>().not.toBeNever();
    expectTypeOf<SettingsBundle>().not.toBeNever();
    expectTypeOf<ProjectSummary>().not.toBeNever();
    expectTypeOf<ExecutionTarget>().not.toBeNever();
    expectTypeOf<TunnelSummary>().not.toBeNever();
    expectTypeOf<GithubPullRequestDetail>().not.toBeNever();
    expectTypeOf<GithubAgentWorkflowContext>().not.toBeNever();
    expectTypeOf<GithubPullRequestAgentContext>().not.toBeNever();
    expectTypeOf<GithubInboxList>().not.toBeNever();
    expectTypeOf<GitHistory>().not.toBeNever();
    expectTypeOf<GitDiffFileSide>().not.toBeNever();
    expectTypeOf<GitManagedOperationResponse>().not.toBeNever();
    expectTypeOf<WorktreeInventory>().not.toBeNever();
    expectTypeOf<ChatSummary>().not.toBeNever();
    expectTypeOf<ChatRelocationJobSummary>().not.toBeNever();
    expectTypeOf<TerminalSummary>().not.toBeNever();
    expectTypeOf<CodeTabSummary>().not.toBeNever();
    expectTypeOf<BrowserSummary>().not.toBeNever();
    expectTypeOf<RemoteDesktopSummary>().not.toBeNever();
    expectTypeOf<AgentActivity>().not.toBeNever();
    expectTypeOf<AgentInteractionRequest>().not.toBeNever();
    expectTypeOf<CantripMcpBinding>().not.toBeNever();
    expectTypeOf<ChatTurnCreate>().not.toBeNever();
    expectTypeOf<ExternalChatTranscript>().not.toBeNever();
    expectTypeOf<CodexCustomizationInventory>().not.toBeNever();
    expectTypeOf<WorkerCommand>().not.toBeNever();
    expectTypeOf<WorkerEvent>().not.toBeNever();
    expectTypeOf<WorkerNotification>().not.toBeNever();
    expectTypeOf<WorkerServerEnvelope>().not.toBeNever();
  });
});
