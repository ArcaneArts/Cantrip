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
  "permissionTransitionSchema",
  "protectedNativeSettingsSnapshotSchema",
  "reconcileNativeHistoryUsage",
  "resolveNativeModelSelection",
  "summarizeNativeBehaviorAttribution",
  "workerComputerUseEffectsCommandSchema",
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
  "terminal.prepare-state",
];

describe("protocol public surface compatibility", () => {
  it("preserves the root runtime export baseline with reviewed CUA and managed-session additions", () => {
    const exportNames = Object.keys(protocol).sort();
    const baselineNames = exportNames.filter(
      (name) =>
        !cuaRuntimeExports.includes(name) &&
        !managedRuntimeExports.includes(name),
    );

    expect(exportNames).toHaveLength(2_120);
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

    expect(commandTypes).toHaveLength(292);
    expect(
      commandTypes
        .filter((type) => managedWorkerCommands.includes(type))
        .sort(),
    ).toEqual(managedWorkerCommands);
    const baselineCommands = commandTypes.filter(
      (type) => !managedWorkerCommands.includes(type),
    );
    expect(baselineCommands).toHaveLength(278);
    expect(baselineCommands[0]).toBe("computer-use.operation");
    expect(baselineCommands[1]).toBe("computer-use.approval.respond");
    expect(baselineCommands.slice(2, 5)).toEqual([
      "computer-use.preview.open",
      "computer-use.preview.stop",
      "computer-use.preview.revoke",
    ]);
    expect(stableFingerprint(baselineCommands.slice(5))).toBe(
      "9715f45e8704a82a:7004",
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

  it("keeps representative type-only exports available from the root", () => {
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
