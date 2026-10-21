import { CodexInteractions } from "./interactions.js";
import { CodexAuthRecovery } from "./auth-recovery.js";
import { codexProviderLogContext } from "./provider-config.js";
export {
  planQuestionId,
  AGENT_INTERACTION_TIMEOUT_MS,
  agentInteractionRequestFromServerRequest,
  agentInteractionResponseFromNativeResult,
  codexResultForAgentInteraction,
  failClosedAgentInteractionReply,
} from "./interaction-protocol.js";
import {
  CodexExecutionOwnership,
  childThreadMetadataFromNotification,
  nativeAgentRuntimeStatus,
} from "./execution-ownership.js";
export {
  agentPathSegments,
  childThreadMetadataFromNotification,
} from "./execution-ownership.js";
import { COMPLETED_TURN_RECONCILIATION_TIMEOUT_MS } from "./runtime-limits.js";
import { CodexRpcRequests } from "./rpc-requests.js";
import { parseCodexRpcMessage, CodexNativeRpcError } from "./rpc-protocol.js";
import {
  launchCodexProcess,
  readCodexProcessEndpoint,
  openCodexWebSocket,
} from "./process-transport.js";
export {
  parseCodexRpcMessage,
  codexEndpointFromLine,
  codexStartupExitMessage,
  CodexNativeRpcError,
} from "./rpc-protocol.js";
import type {
  ActiveCommandTelemetry,
  ActiveTurn,
  AdmittedNativeExecution,
  AdmittedNativeReply,
  AdmittedNativeReplyIdentity,
  AdmittedNativeReplyResponse,
  AgentOperationResult,
  AgentRuntimeState,
  CodexExternalThreadChange,
  CodexExternalThreadChangeKind,
  CodexProcessLauncher,
  CodexSkill,
  CompactAgentThreadOptions,
  GoalRuntimeOptions,
  HydrateChatRelocationOptions,
  ManagedExecutionGateHandler,
  ManagedExecutionResolution,
  ManagedNativeCommandDispatcher,
  ManagedNativeGuiCommand,
  NativeCollaborationMode,
  NativeCollaborationModeListResponse,
  NativeReplacementSettings,
  PrepareAdmittedNativeExecutionOptions,
  PrepareImportedManagedThreadOptions,
  PrepareManagedThreadOptions,
  RootExecution,
  RpcMessage,
  RunAgentOperationOptions,
  RunAgentTurnOptions,
  RunAgentTurnRetry,
  RuntimeChatAttachment,
  RuntimeSubagentDefaults,
  ServerRequestResolvedParams,
  ThreadResponse,
  ThreadStartedParams,
  ThreadStatusChangedParams,
  TurnCompletedParams,
  TurnPlanUpdatedParams,
  TurnStartResponse,
  TurnStartedParams,
} from "./runtime-types.js";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import type {
  AgentActivity,
  AgentInteractionResponse,
  AgentThreadSync,
  AgentTurnResult,
  ChatGoalResponse,
  ChatGptModelInventory,
  ChatMessageContent,
  ChatRelocationContextPayload,
  CodexCustomizationInventory,
  CodexExternalImportPreview,
  CodexExternalImportStatus,
  CodexMcpOauthStartResult,
  CodexMcpOauthStatus,
  CodexMcpReloadResult,
  CodexMcpResourceRead,
  CodexRuntimeReport,
  CodexSkillConfigResult,
  CodexSkillRootsResult,
  McpServerConfiguration,
  NativeAccountDefaultsResult,
  NativeAccountDefaultsWrite,
  PermissionProfileCapability,
  PermissionTransition,
  PlanMode,
  ProviderAccessTokenLease,
  ProviderQuotaSnapshot,
  ProviderRateLimitResetConsumeInput,
  ProviderRateLimitResetConsumeResult,
  ThreadGoal,
} from "@cantrip/protocol";
import {
  CANTRIP_MCP_TOOL_NAMES,
  MANAGED_CUA_MCP_NAME,
  YOLO_PERMISSION_PROFILE_ID,
  agentActivitySchema,
  agentTurnResultSchema,
  chatGoalClearSchema,
  chatGoalResponseSchema,
  chatGptModelInventorySchema,
  codexExternalImportStatusSchema,
  codexMcpOauthStatusSchema,
  codexMcpReloadResultSchema,
  isManagedCantripMcpName,
  isManagedCodeGraphMcpName,
  nativeInitialTurnSettingsSchema,
  permissionProfileCapabilitySchema,
  providerRateLimitResetConsumeOutcomeSchema,
  providerRateLimitResetConsumeResultSchema,
  shouldUseChatGptCredits,
  threadGoalSchema,
} from "@cantrip/protocol";
import {
  agentMessageFingerprint,
  boundedMapSet,
  boundedText,
  codexErrorReasonCode,
  completedActivityTimestamps,
  eventCorrelation,
  objectRecord,
} from "./event-values.js";
import type {
  AccountRateLimitsUpdatedParams,
  ActiveAgentContextWindow,
  ActiveAgentContextWindowSource,
  AgentMessageDeltaParams,
  CodexThreadReadResponse,
  CodexThreadTurn,
  CommandExecutionOutputDeltaParams,
  ConfigWarningParams,
  ErrorNotificationParams,
  FileChangePatchUpdatedParams,
  ItemLifecycleParams,
  ReasoningSummaryPartAddedParams,
  ReasoningSummaryTextDeltaParams,
  ThreadGoalClearedParams,
  ThreadGoalUpdatedParams,
  ThreadTokenUsageUpdatedParams,
  TokenUsageBreakdown,
  TurnDiffUpdatedParams,
  WarningParams,
  WorkspaceSnapshot,
} from "./event-types.js";
import { lstat, mkdir } from "node:fs/promises";
import {
  CUA_DISCOVERY_GUIDANCE,
  CUA_START_GUIDANCE,
} from "../mcp/cua-guidance.js";
import { createAgentActivityRawEnvelope } from "./raw-capture.js";
import { boundedJsonValueSchema } from "@cantrip/protocol/bounded-json";
import { measuredAgentUsageSchema } from "@cantrip/protocol/agent-usage";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeProvider } from "./external-chatgpt-auth.js";
import type { CodexRuntime, CodexRuntimeDiagnostic } from "./runtime.js";
import { LiveManagedModelCatalog } from "./live-managed-model-catalog.js";
import { nativeModelAttribution } from "../native-model-attribution.js";
import { workerLogError, workerLogger } from "../logger.js";
import { NativeHistoryObservations } from "./native-history-observation.js";
import { NativeThreadSettingsState } from "./native-thread-settings.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import WebSocket from "ws";
import type { ProviderAccessTokenClient } from "../provider-access-tokens.js";
import { mergeCodexSkillRoots } from "./global-skills.js";
import { z } from "zod";
import { quotaSnapshotFromRateLimits } from "./rate-limits.js";
import type { AccountRateLimitsResult } from "./rate-limits.js";
import { cantripVersion } from "@cantrip/version";
import {
  NativePermissionDeferredError,
  isNativePermissionDeferred,
} from "./native-permission-deferred.js";
import {
  customizationInventory,
  parseExternalImportPreview,
  parseExternalImportStatus,
  parseMcpOauthCompletion,
  parseMcpOauthStart,
  parseMcpResourceRead,
  parseMcpServerPage,
  parseSkillConfigResult,
  parseSkillInventory,
  resolveProjectSkillRoots,
  selectExternalImportItems,
  skillPathForConfiguration,
} from "./customization.js";
import type { CodexNativeHistorySnapshot } from "./native-history.js";
import { readCodexNativeHistory } from "./native-history.js";
import type {
  ManagedHistoryExport,
  ManagedHistoryImport,
} from "./managed-history-transfer.js";
import { requestManagedHistoryTransfer } from "./managed-history-transfer.js";
import type {
  NativeHistoryObserver,
  NativeHistorySubscription,
} from "./native-history-observation.js";
import type {
  NativeSettingsRequest,
  NativeThreadSettings,
} from "./native-thread-settings.js";
import {
  nativeAccountDefaultsParams,
  readNativeAccountDefaults,
  writeNativeAccountDefaults,
} from "./native-account-defaults.js";
import {
  codexModelProviderName,
  codexProviderConfiguration,
  isZaiRuntimeProvider,
} from "./provider-config.js";
import { attachmentPromptText } from "./attachment-inputs.js";
import {
  runtimeModelSupportsImages,
  writeManagedCodexModelCatalog,
} from "./model-catalog.js";
import type { CodexComputerUseExecution } from "./execution-lifetime.js";
import { readableCodexProviderError } from "./provider-errors.js";
import type { RawData } from "ws";
import {
  chatGptExternalAuthCapabilityError,
  chatGptExternalAuthSession,
  chatGptExternalLoginParams,
} from "./external-chatgpt-auth.js";
import { ProviderAccessTokenRequestError } from "../provider-access-tokens.js";

import { redactCodexDiagnosticPayload } from "./diagnostic-redaction.js";
import {
  changedFiles,
  completedCodexThreadTurnFromRead,
  normalizeAgentMessage,
  normalizeCodexThreadItem,
  normalizeCodexThreadReadResponse,
  observedCodexThreadStatus,
  normalizeCodexThreadTurn,
  normalizeNoticeActivity,
  normalizeRateLimitActivity,
  normalizeTokenUsageActivity,
  turnSummaryActivity,
} from "./event-normalization.js";
import { workspaceChanges, workspaceSnapshot } from "./workspace-snapshots.js";
import {
  appendStreamingAgentMessageDelta,
  boundedCommandTelemetrySet,
  clearCommandFlush,
  clearStreamingAgentMessage,
  clearTurnInspectionTelemetry,
  emitCommandTelemetry,
  emitFileActivity,
  emitStreamingAgentMessage,
  emitTurnActivity,
  flushActiveAgentMessage,
  publishGoalCheckpoint,
  publishStagedAgentMessages,
  rememberCompletedCommand,
  resetGoalSegment,
  scheduleCommandTelemetry,
  settlePendingTurnActivities,
  settleStreamingAgentMessage,
  stageAgentMessage,
} from "./turn-streaming.js";
import {
  MAX_TURN_FILE_ITEMS,
  MAX_TURN_ITEM_TIMESTAMPS,
} from "./runtime-limits.js";
import {
  commandTelemetryFromCompletion,
  commandTelemetryFromDelta,
  commandTelemetryFromStart,
} from "./command-output.js";

export type {
  CodexProcessLauncher,
  RpcError,
  RpcMessage,
  CommandOutputBuffer,
  CommandTelemetryValue,
  CodexExternalThreadChangeKind,
  CodexExternalThreadChange,
  RunAgentTurnRetry,
  RunAgentTurnOptions,
  PrepareAdmittedNativeExecutionOptions,
  ManagedExecutionAttempt,
  ManagedExecutionDeclined,
  ManagedExecutionResolution,
  ManagedExecutionGateHandler,
  ManagedNativeGuiCommand,
  ManagedNativeCommandDispatcher,
  AdmittedNativeReplyIdentity,
  AdmittedNativeReply,
  AdmittedNativeReplyResponse,
  AdmittedNativeExecution,
  RuntimeSubagentDefaults,
  RunAgentOperationOptions,
  AgentOperationResult,
  RuntimeChatAttachment,
  GoalRuntimeOptions,
  NativeReplacementSettings,
  PrepareManagedThreadOptions,
  PrepareImportedManagedThreadOptions,
  HydrateChatRelocationOptions,
  CodexSkill,
  CompactAgentThreadOptions,
} from "./runtime-types.js";
export {
  completedActivityTimestamps,
  codexErrorReasonCode,
} from "./event-values.js";
export {
  normalizeStreamingAgentMessage,
  stageAgentMessage,
  flushStagedAgentMessage,
} from "./turn-streaming.js";
export type {
  CodexThreadTurn,
  CodexThreadReadResponse,
  ActiveAgentContextWindow,
  ActiveAgentContextWindowSource,
  StagedAgentMessageResult,
} from "./event-types.js";
export { workspaceSnapshotFromPorcelainRecords } from "./workspace-snapshots.js";
export {
  latestChangedLine,
  changedLinesPreview,
  changedFiles,
  normalizeCodexThreadItem,
  normalizeAgentMessage,
  normalizeTokenUsageActivity,
  normalizeRateLimitActivity,
  normalizeNoticeActivity,
  normalizeCodexThreadTurn,
  normalizeCodexThreadReadResponse,
  completedCodexThreadTurnFromRead,
} from "./event-normalization.js";
export {
  appendBoundedCommandOutput,
  boundedCommandOutput,
  commandTelemetryFromDelta,
  commandTelemetryFromStart,
  commandTelemetryFromCompletion,
} from "./command-output.js";

export function findActiveChatTurn<
  T extends Pick<ActiveTurn, "chatId" | "executionKind" | "threadId">,
>(
  activeTurns: ReadonlyMap<string, T>,
  chatId: string,
  threadId: string | null,
): [string, T] | null {
  for (const entry of activeTurns) {
    if (entry[1].executionKind === "chat" && entry[1].chatId === chatId) {
      return entry;
    }
  }
  if (threadId) {
    for (const entry of activeTurns) {
      if (entry[1].executionKind === "chat" && entry[1].threadId === threadId) {
        return entry;
      }
    }
  }
  return null;
}

const CODEX_RPC_TIMEOUT_MS = 2 * 60_000;
const CODEX_PAUSE_BOUNDARY_TIMEOUT_MS = 24 * 60 * 60_000;
const CODEX_DIAGNOSTIC_LIMIT = 100;
const CUSTOMIZATION_STATUS_LIMIT = 100;

const LEGACY_CHATGPT_FALLBACK_CODES = new Set([
  "credential-unavailable",
  "migration-needed",
]);

// Derived from ServerNotification generated by codex-cli 0.163.0. Known but
// currently unnormalized notifications remain available in the raw diagnostic
// buffer without being mislabeled as schema drift.
const KNOWN_CODEX_NOTIFICATION_METHODS = new Set([
  "account/gatewayOAuth/changed",
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
  "app/list/updated",
  "autoApprovalReview/strictReviewRequired",
  "command/exec/outputDelta",
  "configWarning",
  "deprecationNotice",
  "error",
  "externalAgentConfig/import/completed",
  "externalAgentConfig/import/progress",
  "fs/changed",
  "fuzzyFileSearch/sessionCompleted",
  "fuzzyFileSearch/sessionUpdated",
  "guardianWarning",
  "hook/completed",
  "hook/started",
  "item/agentMessage/delta",
  "item/autoApprovalReview/completed",
  "item/autoApprovalReview/started",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "mcpServer/event/stream/notification",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "model/rerouted",
  "model/safetyBuffering/updated",
  "model/verification",
  "modelProvider/authRecoveryCompleted",
  "modelProvider/authRecoveryStarted",
  "process/exited",
  "process/outputDelta",
  "project/changed",
  "rawResponse/completed",
  "rawResponseItem/completed",
  "remoteControl/status/changed",
  "serverRequest/resolved",
  "skills/changed",
  "thread/archived",
  "thread/attachment/updated",
  "thread/closed",
  "thread/compacted",
  "thread/deleted",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/goal/cleared",
  "thread/goal/updated",
  "thread/name/updated",
  "thread/project/updated",
  "thread/prediction/updated",
  "thread/queue/changed",
  "thread/readState/changed",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/itemAdded",
  "thread/realtime/item/completed",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/started",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/reverted",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/unarchived",
  "turn/completed",
  "turn/diff/updated",
  "turn/moderationMetadata",
  "turn/plan/updated",
  "turn/started",
  "warning",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
]);

export function isKnownCodexNotificationMethod(method: string): boolean {
  return KNOWN_CODEX_NOTIFICATION_METHODS.has(method);
}

const EXTERNAL_THREAD_CHANGE_LIMIT = 4_096;
const EXTERNAL_THREAD_CHANGE_DEBOUNCE_MS = 75;

export class CodexExternalThreadChangeCoalescer {
  readonly #delayMs: number;
  readonly #emit: (change: CodexExternalThreadChange) => void;
  readonly #pending = new Map<
    string,
    {
      changes: Set<CodexExternalThreadChangeKind>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #revision = Date.now() * 1_000;

  constructor(
    emit: (change: CodexExternalThreadChange) => void,
    delayMs = EXTERNAL_THREAD_CHANGE_DEBOUNCE_MS,
  ) {
    this.#emit = emit;
    this.#delayMs = delayMs;
  }

  observe(threadId: string, change: CodexExternalThreadChangeKind): void {
    const existing = this.#pending.get(threadId);
    if (existing) {
      existing.changes.add(change);
      return;
    }
    if (this.#pending.size >= EXTERNAL_THREAD_CHANGE_LIMIT) {
      const oldestThreadId = this.#pending.keys().next().value;
      if (oldestThreadId !== undefined) {
        const oldest = this.#pending.get(oldestThreadId);
        if (oldest) clearTimeout(oldest.timer);
        this.#pending.delete(oldestThreadId);
      }
    }
    const pending = {
      changes: new Set<CodexExternalThreadChangeKind>([change]),
      timer: setTimeout(() => {
        if (this.#pending.get(threadId) !== pending) return;
        this.#pending.delete(threadId);
        this.#revision = Math.max(this.#revision + 1, Date.now() * 1_000);
        this.#emit({
          changes: [...pending.changes],
          revision: this.#revision,
          threadId,
        });
      }, this.#delayMs),
    };
    pending.timer.unref();
    this.#pending.set(threadId, pending);
  }

  clear(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
  }
}

export function isInvalidCompactionBlobError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("could not decode the compaction blob");
}

export function codexWorkspaceContext(cwd: string): {
  cwd: string;
  runtimeWorkspaceRoots: string[];
} {
  const resolved = path.resolve(cwd);
  return { cwd: resolved, runtimeWorkspaceRoots: [resolved] };
}

export function reconciledRootTurnStatus(
  status: TurnCompletedParams["turn"]["status"],
  finalAnswerAvailable: boolean,
  interruptionRequested: boolean,
): TurnCompletedParams["turn"]["status"] {
  if (status === "completed") return status;
  if (finalAnswerAvailable) return "completed";
  if (interruptionRequested) return "interrupted";
  return status;
}

export function activeAgentContextWindow(
  active: ActiveAgentContextWindowSource,
  turnId: string,
): ActiveAgentContextWindow {
  const usedTokens = active.contextUsage?.last.totalTokens ?? null;
  const contextWindowTokens = active.contextUsage?.modelContextWindow ?? null;
  const remainingTokens =
    usedTokens !== null && contextWindowTokens !== null
      ? Math.max(0, contextWindowTokens - usedTokens)
      : null;
  const usedPercent =
    usedTokens !== null && contextWindowTokens !== null
      ? Math.round(
          Math.min(100, Math.max(0, usedTokens / contextWindowTokens) * 100) *
            10,
        ) / 10
      : null;
  return {
    threadId: active.threadId,
    turnId,
    usedTokens,
    contextWindowTokens,
    remainingTokens,
    usedPercent,
    remainingPercent:
      usedPercent === null ? null : Math.round((100 - usedPercent) * 10) / 10,
    usageUpdatedAtMs: active.contextUsageUpdatedAtMs,
    compactionScheduled: active.contextCompactionRequestedAtMs !== null,
  };
}

export function codexReasoningEffortParams(
  model: RunAgentTurnOptions["model"],
): { effort?: NonNullable<RunAgentTurnOptions["model"]["reasoningEffort"]> } {
  return model.reasoningEffort ? { effort: model.reasoningEffort } : {};
}

function relocationContentText(content: ChatMessageContent): string {
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "attachment") {
        return `[Cantrip attachment: ${item.attachment.fileName} (${item.attachment.mimeType}), id ${item.attachment.id}]`;
      }
      if (item.activity.type === "instructionContext") {
        return `[Cantrip effective instructions: ${item.activity.provenance}]`;
      }
      const { raw: _raw, ...normalized } = item.activity;
      return `[Cantrip ${item.activity.type} activity: ${JSON.stringify(normalized)}]`;
    })
    .join("\n\n")
    .trim();
}

export function relocationResponseItems(
  payload: ChatRelocationContextPayload,
): Array<Record<string, unknown>> {
  if (payload.kind !== "visible") {
    throw new Error(
      "Encrypted Task relocation content must be opened before hydration.",
    );
  }
  return payload.messages.map((message) => {
    const text = relocationContentText(message.content) || "[Empty message]";
    const annotated =
      message.mode === "default"
        ? text
        : `[Cantrip ${message.mode} mode]\n${text}`;
    const role = message.role === "system" ? "developer" : message.role;
    return {
      type: "message",
      role,
      content: [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text: annotated,
        },
      ],
    };
  });
}

export function relocationExternalSessionRecords(
  payload: ChatRelocationContextPayload,
  input: { cwd: string; title: string },
): Array<Record<string, unknown>> {
  if (payload.kind !== "visible") {
    throw new Error(
      "Encrypted Task relocation content must be opened before export.",
    );
  }
  const responseItems = relocationResponseItems(payload);
  relocationItemBatches(responseItems);
  const records: Array<Record<string, unknown>> = [
    {
      type: "custom-title",
      customTitle: input.title,
    },
  ];
  let hasUserTurn = false;
  for (const [index, item] of responseItems.entries()) {
    const message = payload.messages[index]!;
    const leadingAssistant: boolean = item.role === "assistant" && !hasUserTurn;
    const role: "assistant" | "user" =
      item.role === "assistant" && !leadingAssistant ? "assistant" : "user";
    hasUserTurn = hasUserTurn || role === "user";
    const content = Array.isArray(item.content)
      ? objectRecord(item.content[0])
      : null;
    const text =
      typeof content?.text === "string" ? content.text : "[Empty message]";
    records.push({
      type: role,
      cwd: input.cwd,
      timestamp: message.createdAt,
      message: {
        content:
          item.role === "developer"
            ? `[Cantrip developer message]\n${text}`
            : leadingAssistant
              ? `[Cantrip assistant message]\n${text}`
              : text,
      },
    });
  }
  if (!hasUserTurn) {
    throw new Error("A Codex export requires at least one visible message.");
  }
  return records;
}

export function relocationItemBatches(
  items: Array<Record<string, unknown>>,
): Array<Array<Record<string, unknown>>> {
  const batches: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let currentBytes = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (itemBytes > 1_000_000) {
      throw new Error(
        "A canonical chat message is too large to hydrate safely.",
      );
    }
    if (
      current.length &&
      (current.length >= 100 || currentBytes + itemBytes > 1_000_000)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function goalShouldContinue(
  goal: ThreadGoal | null,
  automationPaused = false,
): boolean {
  return !automationPaused && goal?.status === "active";
}

export const CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS =
  "The managed `cantrip` MCP server is the preferred interface for Cantrip-owned state and surfaces. Start with `context_get`; use its exact context-window occupancy to judge whether imminent high-volume work fits. Call `context_compact` when the user requests `/compact` or the remaining context is inadequate, then finish the current turn so native compaction can run at the idle boundary. List targets instead of guessing identifiers, and call `tool_help` for the live exact schema before guessing tool arguments. Use `policy_list` plus `policy_read` whenever an effective policy summary requires its current full body. Use `run_configuration_detect` for typed project discovery, then `run_configuration_create`, `run_configuration_get`, and revision-checked `run_configuration_update` to author shared definitions under `.cantrip/run-configurations`. Always use stable configuration IDs and exact worktree IDs, never display names. Run lifecycle intent is explicit through `run_configuration_start`, `run_configuration_restart`, `run_configuration_stop`, `run_configuration_status`, and `run_configuration_read_output`; omitting the worktree selects Primary. Use `run_configuration_secret_set` for write-only encrypted values. If the managed MCP server or a required tool is unavailable, use the worker-authenticated `cantrip` CLI as a fallback and run `cantrip -h` for concise help. When a Cantrip tool or command reports that continuation was scheduled, finish the current turn so Cantrip can checkpoint and continue safely.";

export const NON_GIT_WORKSPACE_DEVELOPER_INSTRUCTIONS =
  "The current project path has no local `.git` metadata in it or any parent directory, so treat this project as a non-Git folder. Do not run Git or GitHub commands, inspect branches, remotes, or worktrees, or attempt commits or pull requests. Work directly with its files. Do not initialize Git unless the user explicitly asks.";

export const STANDALONE_CHAT_DEVELOPER_INSTRUCTIONS =
  "You are in a standalone Cantrip Chat with an isolated scratch folder. This is not an IDE project. The managed `cantrip` MCP exposes only `tool_help`, `web_search`, and `web_read`; use those tools for web research and do not request unavailable project tools through `tool_help`. Do not use or request Cantrip project, worktree, Task, Code, CodeGraph, console, relocation, trajectory, interactive browser, or subagent features. Treat the current scratch folder as the only normal workspace root.";

export const CANTRIP_DYNAMIC_TOOLS_OVERRIDE = { dynamicTools: [] } as const;

export async function workspaceHasGitMetadata(cwd: string): Promise<boolean> {
  let current = path.resolve(cwd);
  while (true) {
    try {
      await lstat(path.join(current, ".git"));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // Only label a workspace non-Git when the absence of metadata is
        // certain. Permission and filesystem errors must fail conservatively.
        return true;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function cantripChatThreadParams(
  hasGitMetadata = true,
  executionProfile: RunAgentTurnOptions["executionProfile"] = "ide",
  mcpServers: NonNullable<RunAgentTurnOptions["mcpServers"]> = [],
) {
  const cuaInstructions = mcpServers.some(
    (server) => server.enabled && server.name === MANAGED_CUA_MCP_NAME,
  )
    ? `${CUA_DISCOVERY_GUIDANCE} ${CUA_START_GUIDANCE}\n\n`
    : "Computer use is not enabled.\n\n";
  if (executionProfile === "standalone-chat") {
    return {
      developerInstructions: `${cuaInstructions}${STANDALONE_CHAT_DEVELOPER_INSTRUCTIONS}`,
      ...CANTRIP_DYNAMIC_TOOLS_OVERRIDE,
    } as const;
  }
  return {
    developerInstructions: hasGitMetadata
      ? `${cuaInstructions}${CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS}`
      : `${cuaInstructions}${CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS}\n\n${NON_GIT_WORKSPACE_DEVELOPER_INSTRUCTIONS}`,
    ...CANTRIP_DYNAMIC_TOOLS_OVERRIDE,
  } as const;
}

function managedThreadConfiguration(
  options: Partial<
    Pick<
      RunAgentTurnOptions,
      "mcpServers" | "executionProfile" | "subagentDefaults"
    >
  > & {
    executionGate?: { runnerGeneration: string };
    canonicalHistory?: boolean;
  },
  hasGitMetadata: boolean,
  preserveSubagentSettings = false,
) {
  const profile = options.executionProfile ?? "ide";
  const enabled = profile === "ide";
  const defaults = enabled ? options.subagentDefaults : null;
  return {
    mcpServers: codexMcpConfigOverride(options.mcpServers ?? []).mcp_servers,
    developerInstructions: cantripChatThreadParams(
      hasGitMetadata,
      profile,
      options.mcpServers,
    ).developerInstructions,
    multiAgentEnabled: enabled,
    ...(preserveSubagentSettings ? { preserveSubagentSettings: true } : {}),
    ...(options.executionGate ? { executionGate: options.executionGate } : {}),
    ...(options.canonicalHistory === undefined
      ? {}
      : { canonicalHistory: options.canonicalHistory }),
    subagentModel: defaults?.model.name ?? null,
    subagentReasoningEffort: defaults?.model.reasoningEffort ?? null,
  };
}

export function codexWorktreeTurnPolicy(
  options: Pick<
    RunAgentTurnOptions,
    | "cwd"
    | "executionProfile"
    | "isPrimary"
    | "resultMode"
    | "rootKind"
    | "worktreeMode"
    | "worktreePolicy"
  > & {
    permissionProfileActive?: boolean;
    policyContext?: RunAgentTurnOptions["policyContext"];
  },
) {
  const cwd = path.resolve(options.cwd);
  if (options.executionProfile === "standalone-chat") {
    return {
      additionalContext: {
        "cantrip.standalone-chat": {
          kind: "application" as const,
          value:
            "This is an isolated standalone Chat scratch workspace, not a Cantrip project. Work only with this conversation, the current scratch folder, and the managed Cantrip web tools (`tool_help`, `web_search`, and `web_read`). Project, worktree, Task, Code, CodeGraph, interactive browser, and subagent workflows are unavailable.",
        },
        ...(options.policyContext
          ? {
              "cantrip.policies": {
                kind: "application" as const,
                value: options.policyContext,
              },
            }
          : {}),
      },
      ...(options.permissionProfileActive
        ? {}
        : {
            sandboxPolicy: {
              type: "workspaceWrite" as const,
              writableRoots: [cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
          }),
    } as const;
  }
  const structuredReadOnly = options.resultMode?.kind === "structured";
  const primaryIsReadOnly =
    options.rootKind === "git-worktree" &&
    options.isPrimary &&
    options.worktreePolicy === "required-for-writes";
  const modeInstruction =
    options.worktreeMode === "pinned"
      ? "This chat is pinned to the current worktree. Do not acquire or switch worktrees unless the user first returns the chat to Agent managed mode."
      : "This chat is Agent managed and may use the managed Cantrip MCP `worktree_create` and `worktree_switch` tools when isolation is appropriate; use `cantrip worktree` only as a fallback.";
  const policyInstruction = primaryIsReadOnly
    ? "The project policy is Required for writes and this turn is on Primary. Primary is inspection-only: do not mutate files or Git state here. Before writing, call `worktree_create` and then `worktree_switch` with its returned target, or call `worktree_switch` for an existing target. Use `cantrip worktree create --switch` or `cantrip worktree switch` only if managed MCP is unavailable, then finish this turn if the operation schedules continuation."
    : options.worktreePolicy === "direct"
      ? "The project policy is Direct. Writes are permitted in the current checkout, including Primary."
      : options.worktreePolicy === "required-for-writes"
        ? "The project policy is Required for writes and this turn is in a secondary worktree, so writes are permitted here."
        : "The project policy is Agent managed. You may work in the current checkout or acquire a secondary worktree when the task benefits from isolation.";
  const folderInstruction = structuredReadOnly
    ? "This is a Cantrip Task planning turn in a worker-managed folder. It is unconditionally read-only: inspect the folder and effective policies, but do not modify files or external systems. The folder has no Git protection, writes in implementation turns occur directly in it, Cantrip worktree commands are unavailable, and running git init does not convert the project automatically."
    : "This project is a worker-managed folder without Git protection. Writes occur directly in this folder. Cantrip worktree commands are unavailable. Running git init does not convert the project automatically; conversion requires the explicit Cantrip GitHub flow.";
  const sandboxPolicy =
    structuredReadOnly || primaryIsReadOnly
      ? { type: "readOnly" as const, networkAccess: false }
      : {
          type: "workspaceWrite" as const,
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };
  return {
    additionalContext: {
      "cantrip.worktree-policy": {
        kind: "application",
        value:
          options.rootKind === "folder-root"
            ? folderInstruction
            : structuredReadOnly
              ? "This is a Cantrip Task planning turn. It is unconditionally read-only: inspect the repository and effective policies, but do not modify files, Git state, GitHub state, or external systems."
              : `${policyInstruction} ${modeInstruction}`,
      },
      ...(options.policyContext
        ? {
            "cantrip.policies": {
              kind: "application" as const,
              value: options.policyContext,
            },
          }
        : {}),
    },
    ...(options.permissionProfileActive && !structuredReadOnly
      ? {}
      : { sandboxPolicy }),
  } as const;
}

function assembledInstructionContextActivity(input: {
  active: ActiveTurn;
  hasGitMetadata: boolean;
  options: RunAgentTurnOptions;
  runtimeVersion: string | null;
  turnId: string;
  turnPolicy: ReturnType<typeof codexWorktreeTurnPolicy>;
}): AgentActivity {
  const initial = input.active.initialSettings;
  const model =
    initial?.model ??
    (input.options.inheritThreadSettings ? null : input.options.model.name);
  const reasoningEffort = initial
    ? initial.reasoningEffort
    : input.options.inheritThreadSettings
      ? null
      : input.options.model.reasoningEffort;
  const collaborationMode =
    initial?.collaborationMode ??
    (input.options.inheritThreadSettings
      ? null
      : (input.active.collaborationMode?.mode ?? input.options.planMode));
  const developerInstructions = cantripChatThreadParams(
    input.hasGitMetadata,
    input.options.executionProfile,
    input.options.resultMode?.kind === "structured"
      ? []
      : input.options.mcpServers,
  ).developerInstructions;
  const contextEntries = Object.entries(input.turnPolicy.additionalContext);
  const selectedSkillSources = input.options.skillNames
    .slice(0, Math.max(0, 98 - contextEntries.length))
    .map((name) => `Selected skill: ${name}`.slice(0, 500));
  const sources = [
    "Cantrip runtime developer instructions",
    ...contextEntries.map(([key]) => `Turn context: ${key}`),
    ...selectedSkillSources,
    "Runtime customization and AGENTS.md context (not exposed verbatim by the runtime)",
  ];
  const instructionText = [
    `Cantrip developer instructions:\n${developerInstructions}`,
    ...contextEntries.map(([key, context]) => `${key}:\n${context.value}`),
    input.options.skillNames.length > 0
      ? `Selected skills: ${input.options.skillNames.join(", ")}`
      : null,
    "Runtime note: Codex may apply additional internal, customization, and AGENTS.md instructions that its app-server protocol does not expose verbatim.",
  ]
    .filter((value): value is string => value !== null)
    .join("\n\n");
  const raw = createAgentActivityRawEnvelope({
    request: instructionText,
    metadata: {
      approvalProfile: input.options.permissionProfileId,
      collaborationMode,
      model,
      providerId: input.options.provider.id,
      providerKind: input.options.provider.kind,
      reasoningEffort,
      runtimeVersion: input.runtimeVersion,
      sandboxPolicy:
        "sandboxPolicy" in input.turnPolicy
          ? JSON.stringify(input.turnPolicy.sandboxPolicy)
          : "permission-profile-managed",
    },
  });
  const capturedAtMs = Date.now();
  return agentActivitySchema.parse({
    type: "instructionContext",
    id: `turn:${input.turnId}:instructions`,
    status: "completed",
    provenance: "assembled",
    text: raw.request?.text ?? null,
    sources,
    model,
    provider: input.options.provider.id,
    reasoningEffort,
    collaborationMode,
    permissionProfile: input.options.permissionProfileId,
    runtimeVersion: input.runtimeVersion,
    startedAtMs: input.active.startedAtMs,
    updatedAtMs: capturedAtMs,
    completedAtMs: capturedAtMs,
    correlation: eventCorrelation(
      "cantrip/trajectory/instructions",
      null,
      input.active.threadId,
      input.turnId,
      `turn:${input.turnId}:instructions`,
    ),
    raw,
  });
}

export function codexAgentOperationTurnPolicy(
  options: Pick<
    RunAgentOperationOptions,
    "cwd" | "mutationMode" | "networkAccess" | "permissionProfileId"
  >,
  permissionProfilesSupported: boolean,
) {
  const permissionProfileActive = Boolean(
    options.permissionProfileId && permissionProfilesSupported,
  );
  if (options.networkAccess === "restricted" && !permissionProfileActive) {
    throw new Error(
      "Restricted agent operation network access requires a supported Codex permission profile.",
    );
  }
  if (permissionProfileActive) return {} as const;

  const networkAccess = options.networkAccess === "unrestricted";
  if (options.mutationMode === "read-only") {
    return {
      sandboxPolicy: { type: "readOnly" as const, networkAccess },
    };
  }
  return {
    sandboxPolicy: {
      type: "workspaceWrite" as const,
      writableRoots: [path.resolve(options.cwd)],
      networkAccess,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

export function parseStructuredAgentResult(
  text: string,
  outputSchema: Record<string, unknown>,
): unknown {
  const value =
    Object.keys(outputSchema).length === 0 ? text : JSON.parse(text);
  return boundedJsonValueSchema.parse(value);
}

export function measuredAgentUsage(
  usage: TokenUsageBreakdown | null,
  durationMs: number,
) {
  return measuredAgentUsageSchema.parse({
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    durationMs: Math.max(0, Math.round(durationMs)),
    estimatedCostUsd: null,
    costAvailable: false,
  });
}

export function codexThreadPermissionParams(
  permissionProfileId: string,
  permissionProfilesSupported: boolean,
) {
  return permissionProfilesSupported
    ? {
        permissions:
          permissionProfileId === YOLO_PERMISSION_PROFILE_ID
            ? ":danger-full-access"
            : permissionProfileId,
      }
    : { sandbox: "workspace-write" as const };
}

export function codexChatApprovalPolicy(
  permissionProfileId: string,
  permissionProfilesSupported: boolean,
) {
  return permissionProfilesSupported &&
    permissionProfileId === YOLO_PERMISSION_PROFILE_ID
    ? ("never" as const)
    : ("on-request" as const);
}

export function codexChatThreadSecurityParams(
  permissionProfileId: string,
  permissionProfilesSupported: boolean,
  structuredReadOnly: boolean,
) {
  return structuredReadOnly
    ? ({ approvalPolicy: "never", sandbox: "read-only" } as const)
    : {
        approvalPolicy: codexChatApprovalPolicy(
          permissionProfileId,
          permissionProfilesSupported,
        ),
        ...codexThreadPermissionParams(
          permissionProfileId,
          permissionProfilesSupported,
        ),
      };
}

export function parseCodexSkills(response: unknown, cwd: string): CodexSkill[] {
  if (!response || typeof response !== "object") return [];
  const data = (response as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const requestedCwd = path.resolve(cwd);
  const group = data.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as { cwd?: unknown }).cwd === "string" &&
      path.resolve((candidate as { cwd: string }).cwd) === requestedCwd,
  ) as { skills?: unknown } | undefined;
  if (!Array.isArray(group?.skills)) return [];

  const skills = new Map<string, CodexSkill>();
  for (const candidate of group.skills) {
    if (!candidate || typeof candidate !== "object") continue;
    const skill = candidate as {
      description?: unknown;
      enabled?: unknown;
      interface?: { displayName?: unknown } | null;
      name?: unknown;
      path?: unknown;
    };
    if (skill.enabled === false || typeof skill.name !== "string") continue;
    const name = skill.name.trim();
    if (!name || skills.has(name)) continue;
    skills.set(name, {
      name,
      description:
        typeof skill.description === "string" ? skill.description : "",
      displayName:
        typeof skill.interface?.displayName === "string"
          ? skill.interface.displayName
          : null,
      path: typeof skill.path === "string" ? skill.path : null,
    });
  }
  return [...skills.values()].sort((left, right) =>
    (left.displayName ?? left.name).localeCompare(
      right.displayName ?? right.name,
    ),
  );
}

export function parsePermissionProfileList(response: unknown) {
  const data =
    response && typeof response === "object"
      ? (response as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) return [];
  return permissionProfileCapabilitySchema.shape.profiles.parse(
    data.map((candidate) => {
      if (!candidate || typeof candidate !== "object") return candidate;
      const profile = candidate as Record<string, unknown>;
      return {
        ...profile,
        description:
          typeof profile.description === "string" ? profile.description : "",
      };
    }),
  );
}

export function chatTurnRollbackBoundary(
  turns: readonly {
    id: string;
    items: readonly { type: string; clientId?: string | null }[];
  }[],
  clientMessageId: string,
): { numTurns: number; turnId: string } | null {
  const turnIndex = turns.findIndex((turn) =>
    turn.items.some(
      (item) =>
        item.type === "userMessage" &&
        item.clientId === `cantrip:${clientMessageId}`,
    ),
  );
  return turnIndex < 0
    ? null
    : {
        numTurns: turns.length - turnIndex,
        turnId: turns[turnIndex]!.id,
      };
}

export { codexModelProviderName } from "./provider-config.js";

function managedCantripEnabledToolNames(server: McpServerConfiguration) {
  const configured = (
    server as McpServerConfiguration & { managedToolNames?: unknown }
  ).managedToolNames;
  if (!Array.isArray(configured)) return [...CANTRIP_MCP_TOOL_NAMES];
  const allowed = new Set(configured);
  return CANTRIP_MCP_TOOL_NAMES.filter((tool) => allowed.has(tool));
}

export function codexMcpConfigOverride(
  servers: NonNullable<RunAgentTurnOptions["mcpServers"]>,
): Record<string, unknown> {
  return {
    mcp_servers: Object.fromEntries(
      servers
        .filter(({ enabled }) => enabled)
        .map((server) => {
          const isManagedCodeGraph = isManagedCodeGraphMcpName(server.name);
          const isManagedCantrip = isManagedCantripMcpName(server.name);
          const isManagedCua = server.name === MANAGED_CUA_MCP_NAME;
          const managedCantripTools = managedCantripEnabledToolNames(server);
          const managedOverrides =
            isManagedCodeGraph || isManagedCantrip || isManagedCua
              ? {
                  required: true,
                  ...(isManagedCua || isManagedCantrip
                    ? { tool_timeout_sec: 0 }
                    : {}),
                  enabled_tools: isManagedCua
                    ? ["js", "js_reset"]
                    : isManagedCodeGraph
                      ? ["codegraph_explore"]
                      : managedCantripTools,
                }
              : {};
          return [
            server.name,
            server.transport === "stdio"
              ? {
                  command: server.command,
                  args: server.args,
                  env: server.environment,
                  enabled: server.enabled,
                  ...managedOverrides,
                }
              : {
                  url: server.url,
                  bearer_token_env_var:
                    server.bearerTokenEnvironmentVariable ?? undefined,
                  http_headers: server.headers,
                  env_http_headers: server.environmentHeaders,
                  enabled: server.enabled,
                  ...managedOverrides,
                },
          ];
        }),
    ),
  };
}

export function managedMcpToolRequirements(
  servers: NonNullable<RunAgentTurnOptions["mcpServers"]>,
) {
  return servers.flatMap((server) => {
    if (!server.enabled) return [];
    if (server.name === MANAGED_CUA_MCP_NAME) {
      return ["js", "js_reset"].map((tool) => ({
        name: MANAGED_CUA_MCP_NAME,
        tool,
      }));
    }
    if (isManagedCodeGraphMcpName(server.name)) {
      return [{ name: "codegraph", tool: "codegraph_explore" }];
    }
    if (isManagedCantripMcpName(server.name)) {
      const tools = managedCantripEnabledToolNames(server);
      return tools.map((tool) => ({
        name: "cantrip",
        tool,
      }));
    }
    return [];
  });
}

export function codexNativeSubagentConfigOverride(
  defaults: RuntimeSubagentDefaults | null,
  enabled = true,
): Record<string, unknown> {
  return {
    features: { multi_agent: enabled },
    agents: {
      enabled,
      ...(enabled && defaults
        ? {
            default_subagent_model: defaults.model.name,
            ...(defaults.model.reasoningEffort
              ? {
                  default_subagent_reasoning_effort:
                    defaults.model.reasoningEffort,
                }
              : {}),
          }
        : {}),
    },
  };
}

export function measureCodexProfileFootprint(
  executionProfile: RunAgentTurnOptions["executionProfile"],
  mcpServers: NonNullable<RunAgentTurnOptions["mcpServers"]>,
  hasGitMetadata = true,
) {
  const threadParameters = cantripChatThreadParams(
    hasGitMetadata,
    executionProfile,
    mcpServers,
  );
  const mcpConfiguration = codexMcpConfigOverride(mcpServers);
  const managedToolRequirements = managedMcpToolRequirements(mcpServers);
  const nativeSubagentConfiguration = codexNativeSubagentConfigOverride(
    null,
    executionProfile === "ide",
  );
  const bytes = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  const threadParametersBytes = bytes(threadParameters);
  const mcpConfigurationBytes = bytes(mcpConfiguration);
  const managedToolSelectionBytes = bytes(managedToolRequirements);
  const nativeSubagentConfigurationBytes = bytes(nativeSubagentConfiguration);
  return {
    executionProfile,
    enabledMcpServerCount: mcpServers.filter(({ enabled }) => enabled).length,
    managedToolCount: managedToolRequirements.length,
    threadParametersBytes,
    dynamicToolSchemaBytes: bytes(threadParameters.dynamicTools),
    mcpConfigurationBytes,
    managedToolSelectionBytes,
    nativeSubagentConfigurationBytes,
    serializedWorkerOverrideBytes:
      threadParametersBytes +
      mcpConfigurationBytes +
      managedToolSelectionBytes +
      nativeSubagentConfigurationBytes,
  } as const;
}

export function codexRuntimeId(
  _model: RunAgentTurnOptions["model"],
  provider: RunAgentTurnOptions["provider"],
  _subagentDefaults: RuntimeSubagentDefaults | null = null,
  executionProfile: RunAgentTurnOptions["executionProfile"] = "ide",
  globalSkillRoots: readonly string[] = [],
): string {
  // Root/child models, effort and catalog metadata belong to threads or the live
  // catalog. They must not create a second writer for an existing native thread.
  // Keep process-owned credentials, provider bootstrap and skill scope isolated.
  const configuration = createHash("sha256")
    .update(
      JSON.stringify({
        providerId: provider.id,
        providerName: provider.name,
        providerKind: provider.kind,
        providerAccountId: provider.accountId ?? null,
        credentialHomeKey: provider.credentialHomeKey ?? null,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        executionProfile,
        globalSkillRoots: [
          ...new Set(globalSkillRoots.map((root) => path.resolve(root))),
        ].sort(),
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${provider.credentialHomeKey ?? provider.id}:${configuration}`;
}

const CANTRIP_CAPACITY_RETRY_DELAYS_MS = [10_000, 20_000, 40_000] as const;

export function cantripCapacityRetryDelayMs(attempt: number): number | null {
  return CANTRIP_CAPACITY_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

export class CodexTurnFailureError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string | null,
    readonly threadId: string,
    readonly turnId: string,
    readonly terminalStatus: "failed" | "interrupted" = "failed",
  ) {
    super(message);
    this.name = "CodexTurnFailureError";
  }
}

function isServerOverloadedError(
  error: unknown,
): error is CodexTurnFailureError {
  return (
    error instanceof CodexTurnFailureError &&
    error.reasonCode === "serverOverloaded"
  );
}

function waitForCapacityRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Codex turn was interrupted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Codex turn was interrupted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class CodexAppServer implements CodexRuntime {
  readonly #liveManagedModelCatalog = new LiveManagedModelCatalog();
  readonly #managedAttributionModels = new Map<
    string,
    RunAgentTurnOptions["model"]
  >();
  #managedModelInventoryProvider: RunAgentTurnOptions["provider"] | null = null;
  #managedModelInventoryRefresh: {
    generation: string;
    promise: Promise<void>;
  } | null = null;
  #managedModelInventory:
    import("@cantrip/protocol").NativeModelInventory | null = null;
  #managedModelInventoryLoader:
    | ((
        provider: RunAgentTurnOptions["provider"],
      ) => Promise<import("@cantrip/protocol").NativeModelInventory>)
    | null = null;

  setManagedModelInventoryLoader(
    loader: (
      provider: RunAgentTurnOptions["provider"],
    ) => Promise<import("@cantrip/protocol").NativeModelInventory>,
  ): void {
    this.#managedModelInventoryLoader = loader;
  }

  getManagedModelInventory():
    import("@cantrip/protocol").NativeModelInventory | null {
    return structuredClone(this.#managedModelInventory);
  }

  getManagedModelAttribution(
    nativeName: string,
    scope: Pick<
      import("@cantrip/protocol").NativeSettingsReadScope,
      "workerId" | "modelRouteId" | "providerAccountId"
    >,
  ): import("@cantrip/protocol").NativeModelAttribution {
    const provider = this.#managedModelInventoryProvider;
    if (!provider || (provider.accountId ?? null) !== scope.providerAccountId)
      return { status: "unavailable" };
    const anchor = scope.modelRouteId
      ? this.#managedAttributionModels.get(scope.modelRouteId)
      : undefined;
    // A configured route remains an exact identity even when discovery omits it.
    // Never substitute the one remaining alias for that known current route.
    if (anchor?.name === nativeName)
      return nativeModelAttribution(scope, nativeName, {
        workerId: scope.workerId,
        providerId: provider.id,
        providerKind: provider.kind,
        providerAccountId: provider.accountId ?? null,
        models: [anchor],
      });
    return nativeModelAttribution(
      scope,
      nativeName,
      this.#managedModelInventory,
    );
  }

  private async loadManagedModelInventory(
    provider: RunAgentTurnOptions["provider"],
  ) {
    if (!this.#managedModelInventoryLoader) return null;
    try {
      const inventory = await this.#managedModelInventoryLoader(provider);
      if (
        inventory.providerId !== provider.id ||
        inventory.providerKind !== provider.kind ||
        inventory.providerAccountId !== (provider.accountId ?? null)
      )
        throw new Error(
          "Native model inventory belongs to another provider/account.",
        );
      return inventory;
    } catch {
      // A catalog read is not an execution prerequisite: keep the explicitly
      // configured models available if this independent discovery request fails.
      workerLogger.event(
        "warn",
        "Managed model inventory could not be refreshed",
        {
          event: "codex.models.inventory-unavailable",
          subsystem: "codex",
          operation: "read-model-inventory",
          providerId: provider.id,
          status: "degraded",
        },
      );
      return null;
    }
  }

  /** Refresh discovery at an explicit picker/selection boundary, never per turn.
   * Discovery failure leaves the real native request free to succeed or fail. */
  async prepareManagedModelCatalogRequest(
    method: string,
    params: unknown,
  ): Promise<void> {
    const values =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    const selectsModel =
      method === "thread/settings/update" &&
      (typeof values.model === "string" ||
        typeof values.subagentModel === "string" ||
        (values.collaborationMode != null &&
          typeof values.collaborationMode === "object"));
    if (!(method === "model/list" && values.cursor == null) && !selectsModel)
      return;
    const generation = this.#nativeTransportGeneration;
    const provider = this.#managedModelInventoryProvider;
    if (!generation || !provider || provider.kind === "chatgpt") return;
    const existing = this.#managedModelInventoryRefresh;
    if (existing?.generation === generation) return existing.promise;
    const promise = (async () => {
      const inventory = await this.loadManagedModelInventory(provider);
      if (!inventory || this.#nativeTransportGeneration !== generation) return;
      try {
        const retainedModelNames = new Set<string>();
        for (const threadId of this.#managedNativeCommandDispatchers.keys()) {
          const state = this.#threadSettings.read(threadId);
          if (state.confirmed) {
            retainedModelNames.add(state.confirmed.settings.model);
            if (state.confirmed.settings.subagentModel)
              retainedModelNames.add(state.confirmed.settings.subagentModel);
          }
          for (const request of state.requests) {
            if (request.status === "rejected" || request.status === "applied")
              continue;
            for (const value of [
              request.patch.model,
              request.patch.subagentModel,
            ]) {
              if (typeof value === "string") retainedModelNames.add(value);
            }
            const mode = request.patch.collaborationMode as
              { settings?: { model?: unknown } } | undefined;
            if (typeof mode?.settings?.model === "string")
              retainedModelNames.add(mode.settings.model);
          }
        }
        await this.#liveManagedModelCatalog.synchronize({
          generation,
          providerKind: provider.kind,
          models: [],
          inventory: inventory.models,
          retainedModelNames: [...retainedModelNames],
          currentGeneration: () => this.#nativeTransportGeneration,
          dispatch: (update) =>
            this.request("model/managedCatalog/update", update),
        });
        if (this.#nativeTransportGeneration === generation) {
          this.#managedModelInventory = inventory;
          this.#imageSupport.clear();
        }
      } catch {
        workerLogger.event(
          "warn",
          "Native model catalog refresh was not acknowledged",
          {
            event: "codex.models.catalog-unavailable",
            subsystem: "codex",
            operation: "update-model-catalog",
            providerId: provider.id,
            status: "degraded",
          },
        );
      }
    })();
    const refresh = { generation, promise };
    this.#managedModelInventoryRefresh = refresh;
    try {
      await promise;
    } finally {
      if (this.#managedModelInventoryRefresh === refresh)
        this.#managedModelInventoryRefresh = null;
    }
  }

  readonly #historyObservations = new NativeHistoryObservations();
  readonly #threadPreparations = new Map<string, Promise<void>>();
  #preparationEpoch = 0;
  readonly #executions = new CodexExecutionOwnership({
    methodAvailable: (method) => this.methodAvailable(method),
    request: (method, params, timeoutMs) =>
      this.request(method, params, timeoutMs),
    canonicalHistory: (threadId) =>
      this.#managedThreadOverlays.get(threadId)?.options.canonicalHistory,
    clearInteractionsForTurn: (active, reason) =>
      this.#interactions.clearInteractionsForTurn(active, reason),
  });

  readonly #threadSettings = new NativeThreadSettingsState();
  readonly #diagnosticSecrets = new Set<string>();
  #runtimeIsZai = false;
  readonly #externalImportStatuses = new Map<
    string,
    CodexExternalImportStatus
  >();
  readonly #externalTurnBaselines = new Map<string, Set<string>>();
  readonly #externalThreadChanges = new CodexExternalThreadChangeCoalescer(
    (change) => this.#externalThreadChangeObserver?.(change),
  );
  #externalThreadChangeObserver:
    ((change: CodexExternalThreadChange) => void) | null = null;
  readonly #goals = new Map<string, ThreadGoal>();
  readonly #managedQueueResumers = new Map<
    string,
    {
      handler: () => Promise<{ resumed: boolean }>;
      transportGeneration: string | null;
    }
  >();
  readonly #managedExecutionGateHandlers = new Map<
    string,
    {
      handler: ManagedExecutionGateHandler;
      controller: AbortController;
      transportGeneration: string | null;
      observedAttempts: Set<string>;
    }
  >();
  readonly #managedNativeCommandDispatchers = new Map<
    string,
    ManagedNativeCommandDispatcher
  >();
  readonly #imageSupport = new Map<string, boolean>();
  readonly #loadedThreads = new Set<string>();
  readonly #managedHistoryImports = new Map<
    string,
    { epoch: number; transferId: string; path: string }
  >();
  readonly #managedImportPreparations = new Map<string, Promise<void>>();
  readonly #threadPreparationVersions = new Map<string, number>();
  readonly #mcpOauthStatuses = new Map<string, CodexMcpOauthStatus>();
  readonly #mcpConfigFingerprintsByThread = new Map<string, string>();
  // Owned native configuration is distinct from readiness and survives failed catalog reads.
  readonly #managedThreadOverlays = new Map<
    string,
    {
      epoch: number;
      options: Pick<
        PrepareManagedThreadOptions,
        | "mcpServers"
        | "executionProfile"
        | "subagentDefaults"
        | "executionGate"
        | "canonicalHistory"
      >;
    }
  >();
  readonly #managedConfigApplications = new Map<
    string,
    { epoch: number; fingerprint: string }
  >();
  readonly #permissionProfilesByThread = new Map<string, string>();
  // Semantic ownership survives an idle unsubscribe of the same durable thread;
  // unlike an applied profile cache it never supplies a security value.
  readonly #managedSecurityOwners = new Set<string>();
  readonly #confirmedManagedPermissions = new Map<
    string,
    { generation: string; profileId: string }
  >();
  readonly #rpcRequests = new CodexRpcRequests({
    send: (message) => this.send(message),
    runtimeId: () => this.#runtimeId,
    secrets: () => this.#diagnosticSecrets,
    isZai: () => this.#runtimeIsZai,
    recordDiagnostic: (diagnostic, warning) =>
      this.recordDiagnostic(diagnostic, warning),
  });

  readonly #interactions = new CodexInteractions({
    rootExecution: (threadId) =>
      this.#executions.rootExecutionsByThread.get(threadId),
    activeTurnForNotification: (threadId, turnId) =>
      this.#executions.activeTurnForNotification(threadId, turnId),
    send: (message) => this.send(message),
    dispatchGuiNativeCommand: (threadId, command) =>
      this.dispatchGuiNativeCommand(threadId, command),
    sessionId: () => this.#appServerSessionId,
  });

  readonly #pendingCapacityRetries = new Map<
    string,
    { controller: AbortController; threadId: string | null }
  >();

  readonly #pausedChats = new Set<string>();
  readonly #runtimeDiagnostics: CodexRuntimeDiagnostic[] = [];
  #skillRoots: string[] = [];
  #appServerSessionId = randomUUID();
  #nativeTransportGeneration: string | null = null;
  #child: ChildProcessWithoutNullStreams | null = null;
  readonly #authRecovery = new CodexAuthRecovery({
    providerAccessTokens: () => this.providerAccessTokens,
    request: (method, params) => this.request(method, params),
    rememberSecret: (secret) => {
      this.#diagnosticSecrets.add(secret);
    },
  });

  #remoteUrl: string | null = null;
  #runtimeId: string | null = null;
  #runtimeStartedAtMs: number | null = null;
  #nextDiagnosticSequence = 1;

  #socket: WebSocket | null = null;
  #starting: Promise<void> | null = null;

  constructor(
    private readonly codexBinary: string,
    private readonly dataDirectory: string,
    private readonly codexHome: string,
    readonly compatibility: CodexRuntimeReport,
    private readonly onDiagnostic?: (
      diagnostic: CodexRuntimeDiagnostic,
    ) => void,
    private readonly resolveProvider?: (
      provider: RunAgentTurnOptions["provider"],
    ) => Promise<RunAgentTurnOptions["provider"]>,
    private readonly providerAccessTokens?: Pick<
      ProviderAccessTokenClient,
      "get"
    >,
    private readonly launchCodex: CodexProcessLauncher = launchCodexProcess,
    private readonly globalSkillRoots: readonly string[] = [],
    private readonly configurationHome: string | null = null,
  ) {}

  private effectiveSkillRoots(): string[] {
    return mergeCodexSkillRoots(this.globalSkillRoots, this.#skillRoots);
  }

  diagnostics(): CodexRuntimeDiagnostic[] {
    return [...this.#runtimeDiagnostics];
  }

  setExternalThreadChangeObserver(
    observer: ((change: CodexExternalThreadChange) => void) | null,
  ): void {
    this.#externalThreadChangeObserver = observer;
  }

  private observeExternalThreadChange(
    threadId: string,
    change: CodexExternalThreadChangeKind,
  ): void {
    if (
      this.hasActiveThread(threadId) ||
      !this.#externalTurnBaselines.has(threadId)
    ) {
      return;
    }
    this.#externalThreadChanges.observe(threadId, change);
  }

  private rememberExternalImportStatus(
    status: CodexExternalImportStatus,
  ): void {
    if (
      !this.#externalImportStatuses.has(status.importId) &&
      this.#externalImportStatuses.size >= CUSTOMIZATION_STATUS_LIMIT
    ) {
      const oldest = this.#externalImportStatuses.keys().next().value;
      if (oldest) this.#externalImportStatuses.delete(oldest);
    }
    this.#externalImportStatuses.set(status.importId, status);
  }

  private rememberMcpOauthStatus(status: CodexMcpOauthStatus): void {
    if (
      !this.#mcpOauthStatuses.has(status.server) &&
      this.#mcpOauthStatuses.size >= CUSTOMIZATION_STATUS_LIMIT
    ) {
      const oldest = this.#mcpOauthStatuses.keys().next().value;
      if (oldest) this.#mcpOauthStatuses.delete(oldest);
    }
    this.#mcpOauthStatuses.set(status.server, status);
  }

  setManagedExecutionGateHandler(
    runnerGeneration: string,
    handler: ManagedExecutionGateHandler | null,
  ): AbortSignal | null {
    this.#managedExecutionGateHandlers
      .get(runnerGeneration)
      ?.controller.abort();
    if (handler)
      this.#managedExecutionGateHandlers.set(runnerGeneration, {
        handler,
        controller: new AbortController(),
        transportGeneration: this.transportGeneration,
        observedAttempts: new Set(),
      });
    else this.#managedExecutionGateHandlers.delete(runnerGeneration);
    return (
      this.#managedExecutionGateHandlers.get(runnerGeneration)?.controller
        .signal ?? null
    );
  }

  private clearManagedExecutionGateHandlers(): void {
    this.#managedQueueResumers.clear();
    for (const entry of this.#managedExecutionGateHandlers.values())
      entry.controller.abort();
    this.#managedExecutionGateHandlers.clear();
  }

  private assertManagedExecutionTransport(expected: string): void {
    if (this.transportGeneration !== expected)
      throw new Error(
        "The managed execution runner belongs to a replaced native transport.",
      );
  }

  async resolveManagedExecution(
    params: ManagedExecutionResolution,
    expectedTransportGeneration: string,
  ): Promise<{ accepted: true }> {
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    const result = await this.request("thread/managedExecution/resolve", {
      threadId: params.threadId,
      runnerGeneration: params.runnerGeneration,
      attemptId: params.attemptId,
      operationGeneration: params.operationGeneration,
      allow: params.allow,
    });
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    return z.object({ accepted: z.literal(true) }).parse(result);
  }

  async invalidateManagedExecution(
    params: { threadId: string; runnerGeneration: string },
    expectedTransportGeneration: string,
  ): Promise<{ invalidated: true }> {
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    const result = await this.request("thread/managedExecution/invalidate", {
      threadId: params.threadId,
      runnerGeneration: params.runnerGeneration,
    });
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    return z.object({ invalidated: z.literal(true) }).parse(result);
  }

  async wakeManagedExecution(
    params: { threadId: string; runnerGeneration: string },
    expectedTransportGeneration: string,
  ): Promise<{ scheduled: boolean }> {
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    const result = await this.request("thread/managedExecution/wake", {
      threadId: params.threadId,
      runnerGeneration: params.runnerGeneration,
    });
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    return z.object({ scheduled: z.boolean() }).parse(result);
  }

  async readManagedNativeQueue(
    threadId: string,
    expectedTransportGeneration: string,
  ): Promise<
    Array<{
      id: string;
      input: Record<string, unknown>[];
      clientUserMessageId: string;
    }>
  > {
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    const rows: Array<{
      id: string;
      input: Record<string, unknown>[];
      clientUserMessageId: string;
    }> = [];
    let cursor: string | null = null;
    do {
      const page = z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              input: z.array(z.record(z.string(), z.unknown())),
              clientUserMessageId: z.string(),
            }),
          ),
          nextCursor: z.string().nullable(),
        })
        .parse(
          await this.request("thread/queue/list", {
            threadId,
            cursor,
            limit: 100,
          }),
        );
      this.assertManagedExecutionTransport(expectedTransportGeneration);
      rows.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }

  async deleteManagedNativeQueue(
    params: {
      threadId: string;
      runnerGeneration: string;
      operationId: string;
      queuedSubmissionId: string;
      expectedInput: Record<string, unknown>[];
      expectedClientUserMessageId: string;
    },
    expectedTransportGeneration: string,
  ): Promise<{ deleted: boolean; conflict: boolean }> {
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    const result = await this.request(
      "thread/managedExecution/queueDelete",
      params,
    );
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    return z
      .object({ deleted: z.boolean(), conflict: z.boolean() })
      .strict()
      .parse(result);
  }

  async executeManagedQueueCommand(command: {
    threadId: string;
    operationId: string;
    queueClaim: { id: string; promptRevision: number };
    method:
      | "thread/goal/set"
      | "thread/goal/clear"
      | "thread/settings/update"
      | "thread/shellCommand";
    params: Record<string, unknown>;
    planMode?: "plan";
    model?: RunAgentTurnOptions["model"];
  }): Promise<unknown> {
    if (
      !this.managedGuiThread(command.threadId) ||
      command.params.threadId !== command.threadId
    )
      throw new Error(
        "The queued command requires its bound managed native thread.",
      );
    const params =
      command.planMode && command.model
        ? {
            ...command.params,
            collaborationMode: await this.collaborationMode(
              command.planMode,
              command.model,
            ),
          }
        : command.params;
    return this.dispatchGuiNativeCommand(command.threadId, {
      operationId: command.operationId,
      queueClaim: command.queueClaim,
      method: command.method,
      params,
      dispatch: async () => {
        await this.prepareManagedModelCatalogRequest(command.method, params);
        return this.request(command.method, params);
      },
    });
  }

  setManagedQueueResume(
    threadId: string,
    handler: () => Promise<{ resumed: boolean }>,
  ): () => void {
    const entry = { handler, transportGeneration: this.transportGeneration };
    this.#managedQueueResumers.set(threadId, entry);
    return () => {
      if (this.#managedQueueResumers.get(threadId) === entry)
        this.#managedQueueResumers.delete(threadId);
    };
  }

  async bindManagedExecution(
    params: {
      threadId: string;
      runnerGeneration: string;
      expectedRunnerGeneration: string | null;
    },
    expectedTransportGeneration: string,
  ): Promise<{ bound: true }> {
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    const result = await this.request("thread/managedExecution/bind", {
      threadId: params.threadId,
      runnerGeneration: params.runnerGeneration,
      expectedRunnerGeneration: params.expectedRunnerGeneration,
    });
    this.assertManagedExecutionTransport(expectedTransportGeneration);
    const bound = z.object({ bound: z.literal(true) }).parse(result);
    const retained = this.#managedThreadOverlays.get(params.threadId);
    if (retained?.epoch === this.#preparationEpoch) {
      retained.options.executionGate = {
        runnerGeneration: params.runnerGeneration,
      };
      this.#managedConfigApplications.delete(params.threadId);
    }
    return bound;
  }

  setManagedNativeCommandDispatcher(
    threadId: string,
    dispatcher: ManagedNativeCommandDispatcher | null,
  ): void {
    if (dispatcher)
      this.#managedNativeCommandDispatchers.set(threadId, dispatcher);
    else {
      this.#managedNativeCommandDispatchers.delete(threadId);
      this.#managedQueueResumers.delete(threadId);
    }
  }

  private dispatchGuiNativeCommand(
    threadId: string,
    command: ManagedNativeGuiCommand,
  ): Promise<unknown> {
    const dispatcher = this.#managedNativeCommandDispatchers.get(threadId);
    return dispatcher ? dispatcher(command) : command.dispatch();
  }

  private requestGuiThreadMutation(
    method: string,
    params: Record<string, unknown> & { threadId: string },
    operationId?: string,
    goalObjectiveOnly?: boolean,
  ): Promise<unknown> {
    return this.dispatchGuiNativeCommand(params.threadId, {
      operationId,
      goalObjectiveOnly,
      method,
      params,
      dispatch: (forward) =>
        this.request(forward?.method ?? method, forward?.params ?? params),
    });
  }

  private managedGuiThread(threadId: string | null | undefined): string | null {
    return threadId && this.#managedNativeCommandDispatchers.has(threadId)
      ? threadId
      : null;
  }

  private assertGuiTurnCurrent(active: ActiveTurn, turnId: string): void {
    if (this.#executions.activeTurns.get(turnId) !== active)
      throw new Error("The native control belongs to a replaced turn.");
  }

  setChatPaused(chatId: string, paused: boolean): void {
    if (paused) {
      this.#pausedChats.add(chatId);
    } else {
      this.#pausedChats.delete(chatId);
    }
  }

  /** Latest requested automation state, regardless of older RPC acknowledgements. */
  isChatPaused(chatId: string): boolean {
    return this.#pausedChats.has(chatId);
  }

  activeContextWindow(
    chatId: string,
    executionLaneId: string,
  ): ActiveAgentContextWindow | null {
    const active = findActiveChatTurn(
      this.#executions.activeTurns,
      chatId,
      null,
    );
    if (!active || active[1].executionLaneId !== executionLaneId) return null;
    return activeAgentContextWindow(active[1], active[0]);
  }

  scheduleActiveContextCompaction(
    chatId: string,
    executionLaneId: string,
  ): ActiveAgentContextWindow {
    const active = findActiveChatTurn(
      this.#executions.activeTurns,
      chatId,
      null,
    );
    if (!active || active[1].executionLaneId !== executionLaneId) {
      throw new Error(
        "The Codex context compaction request does not match the active Cantrip turn.",
      );
    }
    active[1].contextCompactionRequestedAtMs ??= Date.now();
    return activeAgentContextWindow(active[1], active[0]);
  }

  async setActiveChatPaused(
    chatId: string,
    paused: boolean,
  ): Promise<{ threadId: string; turnId: string } | null> {
    this.setChatPaused(chatId, paused);
    const active = [...this.#executions.activeTurns.entries()].find(
      ([, turn]) => turn.executionKind === "chat" && turn.chatId === chatId,
    );
    if (!active) {
      workerLogger.event("debug", "Codex chat pause state stored", {
        event: "codex.turn.pause",
        subsystem: "codex",
        operation: paused ? "pause" : "resume",
        status: "deferred",
        chatId,
      });
      return null;
    }
    try {
      const params = {
        threadId: active[1].threadId,
        turnId: active[0],
        paused,
      };
      await this.dispatchGuiNativeCommand(active[1].threadId, {
        method: "turn/pause",
        params,
        dispatch: () => {
          this.assertGuiTurnCurrent(active[1], active[0]);
          return this.request(
            "turn/pause",
            params,
            CODEX_PAUSE_BOUNDARY_TIMEOUT_MS,
          );
        },
      });
    } catch (error) {
      if (!this.#executions.activeTurns.has(active[0])) return null;
      throw error;
    }
    workerLogger.event("info", `Codex turn ${paused ? "paused" : "resumed"}`, {
      event: "codex.turn.pause",
      subsystem: "codex",
      operation: paused ? "pause" : "resume",
      status: "completed",
      chatId,
      turnId: active[0],
      threadId: active[1].threadId,
    });
    return { threadId: active[1].threadId, turnId: active[0] };
  }

  async listChatGptModels(
    provider: RuntimeProvider & { kind: "chatgpt" },
  ): Promise<ChatGptModelInventory> {
    const startedAtMs = Date.now();
    workerLogger.event("debug", "ChatGPT model catalog refresh started", {
      event: "provider.catalog.refresh",
      subsystem: "provider",
      operation: "chatgpt-catalog",
      status: "started",
      ...codexProviderLogContext(provider),
    });
    try {
      await this.ensureCatalogStarted(provider);
      const models: ChatGptModelInventory["models"] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const response = (await this.request("model/list", {
          cursor,
          includeHidden: true,
          limit: 100,
        })) as { data?: unknown[]; nextCursor?: string | null };
        if (!Array.isArray(response.data)) {
          throw new Error("Codex model/list returned an invalid model page.");
        }
        const page = chatGptModelInventorySchema.shape.models.parse(
          response.data,
        );
        models.push(...page);
        const nextCursor = response.nextCursor ?? null;
        if (nextCursor && seenCursors.has(nextCursor)) {
          throw new Error("Codex model/list repeated a pagination cursor.");
        }
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor && models.length < 1_000);
      let quotaSnapshot: ProviderQuotaSnapshot | null = null;
      try {
        quotaSnapshot = quotaSnapshotFromRateLimits(
          (await this.requestWithChatGptAuthRecovery(
            provider,
            "account/rateLimits/read",
            undefined,
          )) as AccountRateLimitsResult,
          {
            workerVersion: cantripVersion.version,
            codexVersion: this.compatibility.version?.raw ?? null,
          },
        );
      } catch {
        // Model discovery remains useful when quota reporting is unavailable.
      }
      const weekly = quotaSnapshot?.windows.find(
        (window) => window.isWeeklyProjection,
      );
      const inventory = chatGptModelInventorySchema.parse({
        models,
        observedAt: new Date().toISOString(),
        weeklyUsage: weekly
          ? { resetsAt: weekly.resetsAt, usedPercent: weekly.usedPercent }
          : null,
        quotaSnapshot,
      });
      workerLogger.event("info", "ChatGPT model catalog refreshed", {
        event: "provider.catalog.refresh",
        subsystem: "provider",
        operation: "chatgpt-catalog",
        status: "completed",
        durationMs: Date.now() - startedAtMs,
        counts: {
          models: inventory.models.length,
          quotaWindows: inventory.quotaSnapshot?.windows.length ?? 0,
        },
        ...codexProviderLogContext(provider),
      });
      return inventory;
    } catch (error) {
      workerLogger.event("warn", "ChatGPT model catalog refresh failed", {
        event: "provider.catalog.refresh",
        subsystem: "provider",
        operation: "chatgpt-catalog",
        status: "failed",
        durationMs: Date.now() - startedAtMs,
        error: workerLogError(error),
        ...codexProviderLogContext(provider),
      });
      throw error;
    }
  }

  async readQuotaSnapshot(
    provider: RuntimeProvider & { kind: "chatgpt" },
  ): Promise<ProviderQuotaSnapshot> {
    const startedAtMs = Date.now();
    try {
      await this.ensureCatalogStarted(provider);
      const snapshot = quotaSnapshotFromRateLimits(
        (await this.requestWithChatGptAuthRecovery(
          provider,
          "account/rateLimits/read",
          undefined,
        )) as AccountRateLimitsResult,
        {
          workerVersion: cantripVersion.version,
          codexVersion: this.compatibility.version?.raw ?? null,
        },
      );
      workerLogger.sampled(
        `provider-quota:${provider.id}`,
        10,
        "debug",
        "ChatGPT quota snapshot refreshed",
        {
          event: "provider.quota.refresh",
          subsystem: "provider",
          operation: "chatgpt-quota",
          status: "completed",
          durationMs: Date.now() - startedAtMs,
          counts: { windows: snapshot.windows.length },
          ...codexProviderLogContext(provider),
        },
      );
      return snapshot;
    } catch (error) {
      workerLogger.rateLimited(
        `provider-quota-failed:${provider.id}`,
        "warn",
        "ChatGPT quota refresh failed",
        {
          event: "provider.quota.refresh",
          subsystem: "provider",
          operation: "chatgpt-quota",
          status: "failed",
          durationMs: Date.now() - startedAtMs,
          error: workerLogError(error),
          ...codexProviderLogContext(provider),
        },
      );
      throw error;
    }
  }

  async consumeRateLimitResetCredit(
    provider: RuntimeProvider & { kind: "chatgpt" },
    input: ProviderRateLimitResetConsumeInput,
  ): Promise<ProviderRateLimitResetConsumeResult> {
    const startedAtMs = Date.now();
    await this.ensureCatalogStarted(provider);
    const beforeReset = await this.readQuotaSnapshot(provider);
    if (shouldUseChatGptCredits(beforeReset?.credits)) {
      throw new Error(
        "This account has more than 100 credits. Use those credits before redeeming a banked usage reset.",
      );
    }
    const response = (await this.requestWithChatGptAuthRecovery(
      provider,
      "account/rateLimitResetCredit/consume",
      input,
    )) as { outcome?: unknown };
    const outcome = providerRateLimitResetConsumeOutcomeSchema.parse(
      response.outcome,
    );
    const quotaSnapshot = await this.readQuotaSnapshot(provider).catch(
      () => null,
    );
    workerLogger.event("info", "ChatGPT rate-limit reset processed", {
      event: "provider.quota.reset",
      subsystem: "provider",
      operation: "consume-rate-limit-reset",
      status: outcome,
      durationMs: Date.now() - startedAtMs,
      counts: {
        availableResets:
          quotaSnapshot?.rateLimitResetCredits?.availableCount ?? 0,
      },
      ...codexProviderLogContext(provider),
    });
    return providerRateLimitResetConsumeResultSchema.parse({
      outcome,
      quotaSnapshot,
    });
  }

  async runTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
    let currentOptions = options;
    let attemptedThreadId = options.threadId;
    let nativeAttempt = 0;
    let compactionStateRetried = false;
    let capacityRetryAttempt = 0;
    for (;;) {
      options.preparationSignal?.throwIfAborted();
      nativeAttempt += 1;
      const attemptOptions: RunAgentTurnOptions = {
        ...currentOptions,
        threadId: attemptedThreadId,
        onThreadLoaded: (threadId) => {
          attemptedThreadId = threadId;
          currentOptions.onThreadLoaded?.(threadId);
        },
      };
      const preparation =
        nativeAttempt === 1 && currentOptions.onBeforeFirstAttempt
          ? {
              controller: new AbortController(),
              threadId: attemptedThreadId ?? null,
            }
          : null;
      try {
        if (preparation) {
          this.#pendingCapacityRetries.set(options.chatId, preparation);
          const prepared = await currentOptions.onBeforeFirstAttempt!(
            options.preparationSignal
              ? AbortSignal.any([
                  preparation.controller.signal,
                  options.preparationSignal,
                ])
              : preparation.controller.signal,
          );
          preparation.controller.signal.throwIfAborted();
          options.preparationSignal?.throwIfAborted();
          currentOptions = { ...currentOptions, ...prepared };
          attemptedThreadId =
            prepared.threadId === undefined
              ? attemptedThreadId
              : prepared.threadId;
          preparation.threadId = attemptedThreadId ?? null;
          Object.assign(attemptOptions, prepared, {
            threadId: attemptedThreadId,
          });
        }
        return await this.runTurnAttempt(attemptOptions);
      } catch (error) {
        preparation?.controller.signal.throwIfAborted();
        options.preparationSignal?.throwIfAborted();
        const renew = async (
          reason: RunAgentTurnRetry["reason"],
          nextThreadId: string | null,
          signal: AbortSignal,
        ) => {
          if (options.preparationSignal)
            signal = AbortSignal.any([signal, options.preparationSignal]);
          signal.throwIfAborted();
          const updated = await currentOptions.onBeforeRetry?.({
            reason,
            attempt: nativeAttempt + 1,
            operationGeneration: attemptOptions.operationGeneration ?? null,
            threadId:
              error instanceof CodexTurnFailureError
                ? error.threadId
                : attemptedThreadId,
            turnId:
              error instanceof CodexTurnFailureError ? error.turnId : null,
            nextThreadId,
            error,
            signal,
          });
          signal.throwIfAborted();
          if (
            attemptOptions.operationGeneration &&
            (!updated?.operationGeneration ||
              updated.operationGeneration ===
                attemptOptions.operationGeneration)
          )
            throw error;
          currentOptions = { ...currentOptions, ...updated };
          attemptedThreadId =
            updated?.threadId === undefined ? nextThreadId : updated.threadId;
        };
        if (
          attemptedThreadId &&
          !compactionStateRetried &&
          isInvalidCompactionBlobError(error)
        ) {
          if (
            attemptOptions.operationGeneration &&
            !currentOptions.onBeforeRetry
          )
            throw error;
          compactionStateRetried = true;
          const staleThreadId = attemptedThreadId;
          const controller = preparation?.controller ?? new AbortController();
          const pendingRetry = { controller, threadId: staleThreadId };
          this.#pendingCapacityRetries.set(options.chatId, pendingRetry);
          try {
            await renew("invalid-compaction", null, controller.signal);
          } finally {
            if (
              this.#pendingCapacityRetries.get(options.chatId) === pendingRetry
            )
              this.#pendingCapacityRetries.delete(options.chatId);
          }
          const retainedThread = attemptedThreadId === staleThreadId;
          if (!retainedThread) this.forgetThread(staleThreadId);
          workerLogger.warn(
            retainedThread
              ? "Codex rejected stored compaction state; retrying with recovered context on the same thread"
              : "Codex rejected stored compaction state; retrying the turn on a fresh thread",
            {
              chatId: options.chatId,
              providerKind: options.provider.kind,
              staleThreadId,
            },
          );
          continue;
        }
        if (!isServerOverloadedError(error)) throw error;
        // Until the caller supplies fresh continuation admission, surface the
        // actual native failure rather than reusing a prior managed grant.
        if (attemptOptions.operationGeneration && !currentOptions.onBeforeRetry)
          throw error;
        const delayMs = cantripCapacityRetryDelayMs(capacityRetryAttempt + 1);
        if (delayMs === null) throw error;
        capacityRetryAttempt += 1;
        const nextAttemptAtMs = Date.now() + delayMs;
        const retry = {
          owner: "cantrip" as const,
          attempt: capacityRetryAttempt,
          maxAttempts: CANTRIP_CAPACITY_RETRY_DELAYS_MS.length,
          nextAttemptAtMs,
        };
        const correlation = eventCorrelation(
          "cantrip/capacity-retry",
          null,
          error.threadId,
          error.turnId,
          null,
        );
        const retryMessage = "Model at capacity";
        attemptOptions.onActivity?.(
          normalizeNoticeActivity({
            level: "warning",
            message: retryMessage,
            details: null,
            reasonCode: error.reasonCode,
            retry,
            status: "running",
            willRetry: true,
            correlation,
          }),
        );
        workerLogger.event("warn", "Codex model is at capacity; retrying", {
          event: "codex.turn.capacity-retry",
          subsystem: "codex",
          operation: "chat-turn",
          status: "retrying",
          reasonCode: error.reasonCode ?? undefined,
          chatId: options.chatId,
          threadId: error.threadId,
          turnId: error.turnId,
          providerId: options.provider.id,
          providerKind: options.provider.kind,
          model: options.model.name,
          attempt: capacityRetryAttempt,
          maxAttempts: CANTRIP_CAPACITY_RETRY_DELAYS_MS.length,
          delayMs,
          nextAttemptAtMs,
        });
        const controller = preparation?.controller ?? new AbortController();
        const pendingRetry = { controller, threadId: error.threadId };
        this.#pendingCapacityRetries.set(options.chatId, pendingRetry);
        try {
          await waitForCapacityRetry(delayMs, controller.signal);
          await renew("capacity", attemptedThreadId, controller.signal);
          attemptOptions.onActivity?.(
            normalizeNoticeActivity({
              level: "warning",
              message: retryMessage,
              details: null,
              reasonCode: error.reasonCode,
              retry: { ...retry, nextAttemptAtMs: null },
              status: "completed",
              willRetry: null,
              correlation,
            }),
          );
        } finally {
          if (
            this.#pendingCapacityRetries.get(options.chatId) === pendingRetry
          ) {
            this.#pendingCapacityRetries.delete(options.chatId);
          }
        }
      } finally {
        if (
          preparation &&
          this.#pendingCapacityRetries.get(options.chatId) === preparation
        )
          this.#pendingCapacityRetries.delete(options.chatId);
      }
    }
  }

  private createChatExecution(
    options: PrepareAdmittedNativeExecutionOptions | RunAgentTurnOptions,
    threadId: string,
    baseline: WorkspaceSnapshot,
    collaborationMode: NativeCollaborationMode | null,
    resultMode: NonNullable<RunAgentTurnOptions["resultMode"]> = {
      kind: "visible",
    },
  ): {
    active: ActiveTurn;
    completion: Promise<AgentTurnResult | AgentOperationResult>;
  } {
    let activeTurn!: ActiveTurn;
    const completion = new Promise<AgentTurnResult | AgentOperationResult>(
      (resolve, reject) => {
        activeTurn = {
          ...(options.operationGeneration
            ? {
                admission: {
                  operationGeneration: options.operationGeneration,
                  controller: new AbortController(),
                  initialTurnId: null,
                  resolvedRequestIds: new Set(),
                },
              }
            : {}),
          inheritThreadSettings:
            "prompt" in options ? options.inheritThreadSettings === true : true,
          agentScope: null,
          baseline,
          captureProtectedDiagnostics: options.captureProtectedDiagnostics,
          chatId: options.chatId,
          collaborationMode,
          contextCompactionRequestedAtMs: null,
          contextUsage: null,
          contextUsageUpdatedAtMs: null,
          commandTelemetry: new Map(),
          completedCommandIds: new Set(),
          cwd: options.cwd,
          delta: "",
          diffChanges: [],
          durationMs: null,
          executionKind: "chat",
          executionLaneId: options.executionLaneId ?? null,
          fileStartedAtMs: new Map(),
          finalText: null,
          interactionMode: "interactive",
          interruptionRequestedAtMs: null,
          itemStartedAtMs: new Map(),
          latestUsage: null,
          liveAgentMessageFingerprints: new Set(),
          observedActivityFingerprints: new Set(),
          model: options.model,
          providerId: options.provider.id,
          providerKind: options.provider.kind,
          onActivity: options.onActivity,
          onMessage: options.onMessage,
          onInteractionCleared: options.onInteractionCleared,
          onInteractionExpired: options.onInteractionExpired,
          onInteractionRequest: options.onInteractionRequest,
          onNativeInteractionRequest: options.onNativeInteractionRequest,
          onCheckpoint: options.onCheckpoint,
          onPlan: options.onPlan,
          onPlanQuestion: options.onPlanQuestion,
          onPlanQuestionResolved: options.onPlanQuestionResolved,
          pendingActivities: new Map(),
          pendingAgentMessage: null,
          reasoningSummaries: new Map(),
          reject,
          resolve,
          startedAtMs: Date.now(),
          streamingAgentMessage: null,
          structuredChat: resultMode.kind === "structured",
          threadId,
          timeout: null,
          structuredOutputSchema:
            resultMode.kind === "structured" ? resultMode.outputSchema : null,
        };
      },
    );

    void completion.catch(() => {});
    return { active: activeTurn, completion };
  }

  /** Actual connected native transport incarnation, never a capability cache. */
  get transportGeneration(): string | null {
    return this.#socket?.readyState === WebSocket.OPEN
      ? this.#nativeTransportGeneration
      : null;
  }

  async prepareAdmittedNativeExecution(
    options: PrepareAdmittedNativeExecutionOptions,
  ): Promise<AdmittedNativeExecution> {
    const epoch = this.#preparationEpoch;
    const baseline = await workspaceSnapshot(options.cwd);
    this.assertPreparationEpoch(epoch);
    if (this.hasActiveThread(options.threadId)) {
      throw new Error(
        `Codex thread ${options.threadId} already has an active turn.`,
      );
    }
    const { active, completion } = this.createChatExecution(
      options,
      options.threadId,
      baseline,
      null,
    );
    active.admission!.initialTurnId = options.expectedTurnId ?? null;
    const controller = active.admission!.controller;
    this.#executions.trackActiveThread(options.threadId, active);
    this.registerRootExecution(active);
    const current = () =>
      this.#preparationEpoch === epoch &&
      this.#executions.activeTurnsByThread.get(options.threadId) === active &&
      !controller.signal.aborted;
    const assertCurrent = () => {
      if (!current())
        throw new Error("The admitted native execution is no longer current.");
    };
    const fail = (error: Error) => {
      if (!current()) return;
      this.releaseActiveTurn(active);
      clearTurnInspectionTelemetry(active);
      active.reject(error);
    };
    const result = completion.then((value) =>
      agentTurnResultSchema.parse(value),
    );
    // Forwarding can fail before the caller installs its completion observer.
    void result.catch(() => {});
    return {
      operationGeneration: options.operationGeneration,
      threadId: options.threadId,
      signal: controller.signal,
      completion: result,
      assertCurrent,
      fail,
      bindReceipt: (receipt) => {
        const value = receipt as { turn?: { id?: unknown } } | null;
        const turnId = value?.turn?.id;
        if (turnId === undefined) {
          assertCurrent();
          return;
        }
        if (typeof turnId !== "string" || !turnId) {
          const error = new Error(
            "Native execution returned an invalid turn identity.",
          );
          fail(error);
          throw error;
        }
        const observed = active.admission!.initialTurnId;
        if (observed && observed !== turnId) {
          const error = new Error(
            "Native execution receipt does not match its first observed turn.",
          );
          fail(error);
          throw error;
        }
        // Terminal notifications may beat the native receipt. Never recreate
        // their authority or bind this old handle to a replacement execution.
        if (!current()) {
          if (observed === turnId) return;
          assertCurrent();
        }
        active.admission!.initialTurnId = turnId;
        this.bindTurnStartResponse(turnId, active);
      },
    };
  }

  private async runTurnAttempt(
    options: RunAgentTurnOptions,
  ): Promise<AgentTurnResult> {
    const resultMode = options.resultMode ?? { kind: "visible" as const };
    if (options.automationPaused) this.#pausedChats.add(options.chatId);
    await this.ensureStarted(
      options.model,
      options.provider,
      options.subagentDefaults,
      options.executionProfile,
    );
    const baseline = await workspaceSnapshot(options.cwd);
    const threadId = await this.loadThread(
      options,
      !options.inheritThreadSettings,
      options.inheritThreadSettings ? "preserve" : "configure",
    );
    options.preparationSignal?.throwIfAborted();
    if (!threadId) {
      throw new Error("Could not start a Codex thread.");
    }
    options.onThreadLoaded?.(threadId);
    if (this.methodAvailable("thread/goal/get")) {
      await this.refreshGoal(threadId);
    }
    const collaborationMode =
      !options.inheritThreadSettings &&
      this.methodAvailable("collaborationMode/list")
        ? await this.updatePlanModeOnThread(
            threadId,
            options.planMode,
            options.model,
          )
        : null;
    if (
      !options.inheritThreadSettings &&
      options.planMode === "plan" &&
      !collaborationMode
    ) {
      throw new Error(
        "Plan Mode is unavailable in the installed Codex runtime.",
      );
    }
    const turnPolicy = codexWorktreeTurnPolicy({
      ...options,
      permissionProfileActive: this.permissionProfilesSupported(),
    });

    options.preparationSignal?.throwIfAborted();
    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }

    const { active: activeTurn, completion } = this.createChatExecution(
      options,
      threadId,
      baseline,
      collaborationMode,
      resultMode,
    );

    const availableSkills = options.skillNames.length
      ? await this.listSkills(options)
      : [];
    const selectedSkills = new Map(
      availableSkills.flatMap((skill) =>
        skill.path ? ([[skill.name, skill]] as const) : [],
      ),
    );
    options.preparationSignal?.throwIfAborted();
    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }
    this.#executions.trackActiveThread(threadId, activeTurn);
    this.registerRootExecution(activeTurn);
    let response: TurnStartResponse;
    let dispatchedInput: ReadonlyArray<Record<string, unknown>> | undefined;
    try {
      const params = {
        threadId,
        ...codexWorkspaceContext(options.cwd),
        ...turnPolicy,
        clientUserMessageId:
          options.nativeClientUserMessageId ??
          `cantrip:${options.clientMessageId}`,
        input: options.nativeInput
          ? [
              ...structuredClone(options.nativeInput),
              ...(options.attachments?.length
                ? await this.turnAttachmentInputs(
                    "",
                    options.attachments,
                    options.model,
                    options.provider,
                    options.inheritThreadSettings,
                  )
                : []),
            ]
          : [
              ...(await this.turnAttachmentInputs(
                options.prompt,
                options.attachments ?? [],
                options.model,
                options.provider,
                options.inheritThreadSettings,
              )),
              ...options.skillNames.flatMap((name) => {
                const skill = selectedSkills.get(name);
                return skill?.path
                  ? [{ type: "skill", name: skill.name, path: skill.path }]
                  : [];
              }),
            ],
        ...(options.inheritThreadSettings
          ? {}
          : {
              model: options.model.name,
              ...codexReasoningEffortParams(options.model),
              ...(collaborationMode ? { collaborationMode } : {}),
            }),
        ...(resultMode.kind === "structured"
          ? { outputSchema: resultMode.outputSchema }
          : {}),
      };
      options.preparationSignal?.throwIfAborted();
      await options.onBeforeNativeDispatch?.(threadId);
      options.preparationSignal?.throwIfAborted();
      dispatchedInput = params.input;
      response = (await this.request(
        "turn/start",
        params,
      )) as TurnStartResponse;
    } catch (error) {
      const deferred =
        dispatchedInput &&
        error instanceof CodexNativeRpcError &&
        error.requestMethod === "turn/start" &&
        isNativePermissionDeferred("turn/start", {
          error: error.nativeError,
        }) &&
        ![...this.#executions.activeTurns.values()].includes(activeTurn);
      this.releaseActiveTurn(activeTurn);
      if (deferred && options.onNativeDeferred) {
        await options.onNativeDeferred({
          threadId,
          nativeInput: dispatchedInput!,
          frame: { error: error.nativeError },
        });
        throw new NativePermissionDeferredError();
      }
      throw error;
    }
    this.bindTurnStartResponse(response.turn.id, activeTurn);
    await options.onNativeReceipt?.(response);
    if (options.captureProtectedDiagnostics) {
      emitTurnActivity(
        activeTurn,
        assembledInstructionContextActivity({
          active: activeTurn,
          hasGitMetadata: await workspaceHasGitMetadata(options.cwd),
          options,
          runtimeVersion:
            (
              this.compatibility.version?.semantic ??
              this.compatibility.version?.raw
            )?.slice(0, 100) ?? null,
          turnId: response.turn.id,
          turnPolicy,
        }),
      );
    }
    workerLogger.event("info", "Codex chat turn started", {
      event: "codex.turn.lifecycle",
      subsystem: "codex",
      operation: "chat-turn",
      status: "started",
      chatId: options.chatId,
      threadId,
      turnId: response.turn.id,
      providerId: options.provider.id,
      providerKind: options.provider.kind,
      model:
        activeTurn.initialSettings?.model ??
        (options.inheritThreadSettings ? null : options.model.name),
      counts: {
        attachments: options.attachments?.length ?? 0,
        skills: options.skillNames.length,
      },
    });
    return agentTurnResultSchema.parse(await completion);
  }

  async runAgentOperation(
    options: RunAgentOperationOptions,
  ): Promise<AgentOperationResult> {
    await this.ensureStarted(options.model, options.provider);
    const turnPolicy = codexAgentOperationTurnPolicy(
      options,
      this.permissionProfilesSupported(),
    );
    const availableSkills = options.skillNames.length
      ? await this.listSkills(options)
      : [];
    const selectedSkills = new Map(
      availableSkills.flatMap((skill) =>
        skill.path ? ([[skill.name, skill]] as const) : [],
      ),
    );
    const missingSkills = options.skillNames.filter(
      (name) => !selectedSkills.has(name),
    );
    if (missingSkills.length) {
      throw new Error(
        `Agent operation skills are unavailable: ${missingSkills.join(", ")}.`,
      );
    }
    const baseline = await workspaceSnapshot(options.cwd);
    const threadId = await this.loadAgentOperationThread(options);
    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }

    let activeTurn: ActiveTurn | undefined;
    const completion = new Promise<AgentTurnResult | AgentOperationResult>(
      (resolve, reject) => {
        activeTurn = {
          agentScope: null,
          baseline,
          captureProtectedDiagnostics: false,
          chatId: null,
          collaborationMode: null,
          contextCompactionRequestedAtMs: null,
          contextUsage: null,
          contextUsageUpdatedAtMs: null,
          commandTelemetry: new Map(),
          completedCommandIds: new Set(),
          cwd: options.cwd,
          delta: "",
          diffChanges: [],
          durationMs: null,
          executionKind: "operation",
          executionLaneId: null,
          fileStartedAtMs: new Map(),
          finalText: null,
          interactionMode: "preauthorized",
          interruptionRequestedAtMs: null,
          itemStartedAtMs: new Map(),
          latestUsage: null,
          liveAgentMessageFingerprints: new Set(),
          observedActivityFingerprints: new Set(),
          model: options.model,
          providerId: options.provider.id,
          providerKind: options.provider.kind,
          pendingActivities: new Map(),
          pendingAgentMessage: null,
          reasoningSummaries: new Map(),
          reject,
          resolve,
          startedAtMs: Date.now(),
          streamingAgentMessage: null,
          structuredChat: false,
          threadId,
          timeout: null,
          structuredOutputSchema: options.outputSchema,
        };
      },
    );

    if (!activeTurn) {
      throw new Error("Could not initialize the Codex agent operation.");
    }
    this.#executions.trackActiveThread(threadId, activeTurn);
    this.registerRootExecution(activeTurn);
    let response: TurnStartResponse;
    try {
      response = (await this.request("turn/start", {
        threadId,
        ...codexWorkspaceContext(options.cwd),
        ...turnPolicy,
        approvalPolicy: "never",
        clientUserMessageId: `cantrip:operation:${options.operationId}`,
        input: [
          { type: "text", text: options.prompt, text_elements: [] },
          ...options.skillNames.map((name) => {
            const skill = selectedSkills.get(name)!;
            return { type: "skill", name: skill.name, path: skill.path };
          }),
        ],
        model: options.model.name,
        ...(options.model.reasoningEffort
          ? { effort: options.model.reasoningEffort }
          : {}),
        ...(Object.keys(options.outputSchema).length
          ? { outputSchema: options.outputSchema }
          : {}),
      })) as TurnStartResponse;
    } catch (error) {
      this.releaseActiveTurn(activeTurn);
      throw error;
    }
    this.bindTurnStartResponse(response.turn.id, activeTurn);
    workerLogger.event("info", "Codex agent operation started", {
      event: "codex.turn.lifecycle",
      subsystem: "codex",
      operation: "agent-operation",
      status: "started",
      operationId: options.operationId,
      threadId,
      turnId: response.turn.id,
      providerId: options.provider.id,
      providerKind: options.provider.kind,
      model: options.model.name,
      counts: { skills: options.skillNames.length },
    });
    emitTurnActivity(
      activeTurn,
      turnSummaryActivity(
        {
          id: response.turn.id,
          status: "inProgress",
          startedAt: activeTurn.startedAtMs,
          completedAt: null,
          durationMs: null,
        },
        eventCorrelation(
          "turn/started",
          null,
          threadId,
          response.turn.id,
          null,
        ),
      ),
    );
    activeTurn.timeout = setTimeout(() => {
      const current = [...this.#executions.activeTurns.entries()].find(
        ([, candidate]) => candidate === activeTurn,
      );
      if (
        !current ||
        this.#executions.activeTurnsByThread.get(threadId) !== activeTurn
      ) {
        return;
      }
      this.releaseActiveTurn(activeTurn!);
      void this.request("turn/interrupt", {
        threadId,
        turnId: current[0],
      }).catch(() => undefined);
      void this.failTurn(
        activeTurn!,
        current[0],
        new Error(`Agent operation timed out after ${options.timeoutMs}ms.`),
      );
      workerLogger.event("warn", "Codex agent operation timed out", {
        event: "codex.turn.timeout",
        subsystem: "codex",
        operation: "agent-operation",
        status: "timed-out",
        operationId: options.operationId,
        threadId,
        turnId: current[0],
        durationMs: options.timeoutMs,
      });
    }, options.timeoutMs);
    activeTurn.timeout.unref();
    return (await completion) as AgentOperationResult;
  }

  async listSkills(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
    forceReload = false,
  ): Promise<CodexSkill[]> {
    await this.ensureStarted(options.model, options.provider);
    const response = await this.request("skills/list", {
      cwds: [options.cwd],
      forceReload,
    });
    return parseCodexSkills(response, options.cwd);
  }

  async listSkillInventory(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
    forceReload = false,
  ): Promise<CodexCustomizationInventory["skills"]> {
    if (!this.methodAvailable("skills/list")) {
      throw new Error(
        "The installed Codex runtime does not support skill discovery.",
      );
    }
    await this.ensureStarted(options.model, options.provider);
    return parseSkillInventory(
      await this.request("skills/list", {
        cwds: [options.cwd],
        forceReload,
      }),
      options.cwd,
    );
  }

  async reloadSkills(
    options: Pick<
      RunAgentTurnOptions,
      "cwd" | "executionProfile" | "model" | "provider" | "subagentDefaults"
    >,
  ): Promise<void> {
    if (!this.methodAvailable("skills/list")) return;
    await this.ensureStarted(
      options.model,
      options.provider,
      options.subagentDefaults,
      options.executionProfile,
    );
    await this.request("skills/list", {
      cwds: [options.cwd],
      forceReload: true,
    });
  }

  async readCustomizationInventory(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      threadId: string | null;
    },
    forceReload = false,
  ): Promise<CodexCustomizationInventory> {
    await this.ensureStarted(options.model, options.provider);
    const skillsResponse = this.methodAvailable("skills/list")
      ? await this.request("skills/list", {
          cwds: [options.cwd],
          forceReload,
        })
      : { data: [{ cwd: options.cwd, skills: [], errors: [] }] };
    const hooksResponse = this.methodAvailable("hooks/list")
      ? await this.request("hooks/list", { cwds: [options.cwd] })
      : {
          data: [{ cwd: options.cwd, hooks: [], warnings: [], errors: [] }],
        };
    const mcpServers: CodexCustomizationInventory["mcpServers"] = [];
    if (this.methodAvailable("mcpServerStatus/list")) {
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      do {
        const page = parseMcpServerPage(
          await this.request("mcpServerStatus/list", {
            cursor,
            limit: 100,
            detail: "full",
            threadId: options.threadId,
          }),
        );
        mcpServers.push(...page.servers);
        cursor = page.nextCursor;
        if (cursor && seenCursors.has(cursor)) {
          throw new Error("Codex returned a repeated MCP status cursor.");
        }
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
    }
    return customizationInventory({
      report: this.compatibility,
      cwd: options.cwd,
      skillsResponse,
      skillRoots: this.#skillRoots,
      hooksResponse,
      mcpServers,
    });
  }

  async previewExternalAgentConfig(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
  ): Promise<CodexExternalImportPreview> {
    if (!this.methodAvailable("externalAgentConfig/detect")) {
      throw new Error(
        "The installed Codex runtime does not support external-agent configuration detection.",
      );
    }
    await this.ensureStarted(options.model, options.provider);
    const response = await this.request("externalAgentConfig/detect", {
      includeHome: false,
      cwds: [options.cwd],
      maxSessionAgeDays: 30,
      maxSessions: 50,
    });
    return parseExternalImportPreview(response, options.cwd);
  }

  async readMcpResource(
    options: Pick<
      RunAgentTurnOptions,
      "cwd" | "model" | "provider" | "threadId"
    > & {
      server: string;
      uri: string;
    },
  ): Promise<CodexMcpResourceRead> {
    if (!this.methodAvailable("mcpServer/resource/read")) {
      throw new Error(
        "The installed Codex runtime does not support MCP resource reads.",
      );
    }
    await this.ensureStarted(options.model, options.provider);
    return parseMcpResourceRead(
      await this.request("mcpServer/resource/read", {
        threadId: options.threadId,
        server: options.server,
        uri: options.uri,
      }),
    );
  }

  async configureSkill(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      path: string;
      enabled: boolean;
    },
  ): Promise<CodexSkillConfigResult> {
    if (
      !this.methodAvailable("skills/list") ||
      !this.methodAvailable("skills/config/write")
    ) {
      throw new Error(
        "The installed Codex runtime does not support validated skill configuration.",
      );
    }
    await this.ensureStarted(options.model, options.provider);
    const skillPath = skillPathForConfiguration(
      await this.request("skills/list", {
        cwds: [options.cwd],
        forceReload: true,
      }),
      options.cwd,
      options.path,
    );
    return parseSkillConfigResult(
      await this.request("skills/config/write", {
        path: skillPath,
        enabled: options.enabled,
      }),
      skillPath,
    );
  }

  async setSkillRoots(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      roots: string[];
    },
  ): Promise<CodexSkillRootsResult> {
    if (!this.methodAvailable("skills/extraRoots/set")) {
      throw new Error(
        "The installed Codex runtime does not support extra skill roots.",
      );
    }
    const result = await resolveProjectSkillRoots(options.cwd, options.roots);
    await this.ensureStarted(options.model, options.provider);
    await this.request("skills/extraRoots/set", {
      extraRoots: mergeCodexSkillRoots(this.globalSkillRoots, result.roots),
    });
    this.#skillRoots = result.roots;
    return result;
  }

  async startMcpOauth(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      server: string;
    },
  ): Promise<CodexMcpOauthStartResult> {
    if (!this.methodAvailable("mcpServer/oauth/login")) {
      throw new Error(
        "The installed Codex runtime does not support MCP OAuth login.",
      );
    }
    await this.ensureStarted(options.model, options.provider);
    this.rememberMcpOauthStatus(
      codexMcpOauthStatusSchema.parse({
        server: options.server,
        status: "pending",
        error: null,
      }),
    );
    try {
      return parseMcpOauthStart(
        await this.request("mcpServer/oauth/login", {
          name: options.server,
          threadId: null,
        }),
        options.server,
      );
    } catch (error) {
      this.rememberMcpOauthStatus(
        codexMcpOauthStatusSchema.parse({
          server: options.server,
          status: "failed",
          error: "Codex could not start MCP authorization.",
        }),
      );
      throw new Error("Codex could not start MCP authorization.", {
        cause: error,
      });
    }
  }

  mcpOauthStatus(server: string): CodexMcpOauthStatus {
    return (
      this.#mcpOauthStatuses.get(server) ??
      codexMcpOauthStatusSchema.parse({
        server,
        status: "unknown",
        error: null,
      })
    );
  }

  async reloadMcpServers(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
  ): Promise<CodexMcpReloadResult> {
    if (!this.methodAvailable("config/mcpServer/reload")) {
      throw new Error(
        "The installed Codex runtime does not support MCP server reloads.",
      );
    }
    await this.ensureStarted(options.model, options.provider);
    await this.request("config/mcpServer/reload", undefined);
    return codexMcpReloadResultSchema.parse({ reloaded: true });
  }

  async applyExternalAgentConfig(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      itemIds: string[];
    },
  ): Promise<CodexExternalImportStatus> {
    if (
      !this.methodAvailable("externalAgentConfig/detect") ||
      !this.methodAvailable("externalAgentConfig/import")
    ) {
      throw new Error(
        "The installed Codex runtime does not support validated external configuration imports.",
      );
    }
    await this.ensureStarted(options.model, options.provider);
    const detected = await this.request("externalAgentConfig/detect", {
      includeHome: false,
      cwds: [options.cwd],
      maxSessionAgeDays: 30,
      maxSessions: 50,
    });
    const migrationItems = selectExternalImportItems(
      detected,
      options.cwd,
      options.itemIds,
    );
    const response = await this.request("externalAgentConfig/import", {
      migrationItems,
      source: "cantrip",
    });
    const pending = parseExternalImportStatus(response, "pending");
    const existing = this.#externalImportStatuses.get(pending.importId);
    if (existing) return existing;
    this.rememberExternalImportStatus(pending);
    return pending;
  }

  externalImportStatus(importId: string): CodexExternalImportStatus {
    return (
      this.#externalImportStatuses.get(importId) ??
      codexExternalImportStatusSchema.parse({
        importId,
        status: "unknown",
        results: [],
      })
    );
  }

  async listPermissionProfiles(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
  ): Promise<PermissionProfileCapability> {
    await this.ensureStarted(options.model, options.provider);
    if (!this.permissionProfilesSupported()) {
      return permissionProfileCapabilitySchema.parse({
        available: false,
        profiles: [],
        reason:
          "The installed Codex runtime does not advertise permission profiles; Cantrip is using its legacy sandbox policy.",
      });
    }
    const profiles: PermissionProfileCapability["profiles"] = [];
    let cursor: string | null = null;
    do {
      const response = (await this.request("permissionProfile/list", {
        cwd: options.cwd,
        cursor,
        limit: 100,
      })) as { data?: unknown; nextCursor?: unknown };
      profiles.push(...parsePermissionProfileList(response));
      cursor =
        typeof response.nextCursor === "string" ? response.nextCursor : null;
    } while (cursor);
    return permissionProfileCapabilitySchema.parse({
      available: true,
      profiles,
      reason: null,
    });
  }

  async remoteEndpoint(
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
    profile?: Pick<
      RunAgentTurnOptions,
      "subagentDefaults" | "executionProfile"
    >,
  ): Promise<string> {
    await this.ensureStarted(
      model,
      provider,
      profile?.subagentDefaults,
      profile?.executionProfile,
    );
    if (!this.#remoteUrl) {
      throw new Error("Codex app-server did not announce a remote endpoint.");
    }
    return this.#remoteUrl;
  }

  async syncThread(
    options: Pick<
      RunAgentTurnOptions,
      "cwd" | "executionProfile" | "model" | "provider" | "threadId"
    > & { threadId: string; subagentDefaults?: RuntimeSubagentDefaults | null },
  ): Promise<AgentThreadSync> {
    await this.ensureStarted(
      options.model,
      options.provider,
      options.subagentDefaults,
      options.executionProfile,
    );
    return this.readExternalThread(options);
  }

  async observeThread(options: {
    cwd: string;
    threadId: string;
  }): Promise<AgentThreadSync | null> {
    if (this.#socket?.readyState !== WebSocket.OPEN) return null;
    return this.readExternalThread(options);
  }

  async readNativeHistory(
    threadId: string,
  ): Promise<CodexNativeHistorySnapshot> {
    const generation = this.#nativeTransportGeneration;
    const snapshot = await readCodexNativeHistory(
      (method, params) => this.request(method, params),
      threadId,
    );
    if (generation !== this.#nativeTransportGeneration)
      throw new Error("The native history transport changed during the read.");
    return snapshot;
  }

  /** Worker-owned conversation storage; separate from canonical account config. */
  get managedHistoryHome(): string {
    return this.codexHome;
  }

  exportManagedHistory(input: ManagedHistoryExport, signal?: AbortSignal) {
    return requestManagedHistoryTransfer(
      (method, params) => this.request(method, params),
      () => this.transportGeneration,
      "thread/managedHistory/export",
      input,
      signal,
    );
  }

  importManagedHistory(input: ManagedHistoryImport, signal?: AbortSignal) {
    return requestManagedHistoryTransfer(
      (method, params) => this.request(method, params),
      () => this.transportGeneration,
      "thread/managedHistory/import",
      input,
      signal,
    );
  }

  /** Recover only the model context after an admitted native failure. History,
   * settings, queue and presentation remain on the same native thread. */
  async resetManagedModelContext(
    threadId: string,
    expectedTurnId: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const generation = this.#nativeTransportGeneration;
    // A rejection before turn/start has no new turn ID. Read the actual durable
    // boundary and let the native mutation compare it under its turn lock.
    const lastTurnId =
      expectedTurnId ??
      (await this.readNativeHistory(threadId)).thread.turns.at(-1)?.id ??
      null;
    signal.throwIfAborted();
    if (generation !== this.#nativeTransportGeneration)
      throw new Error("The native transport changed before context recovery.");
    await this.request("thread/managedContext/reset", {
      threadId,
      expectedLastTurnId: lastTurnId,
    });
    signal.throwIfAborted();
    if (generation !== this.#nativeTransportGeneration)
      throw new Error("The native transport changed during context recovery.");
  }

  observeNativeHistory(
    threadId: string,
    observer: NativeHistoryObserver,
  ): NativeHistorySubscription {
    return this.#historyObservations.subscribe(threadId, observer, () =>
      this.readNativeHistory(threadId),
    );
  }

  private async readExternalThread(options: {
    cwd: string;
    threadId: string;
  }): Promise<AgentThreadSync> {
    const response = (await this.request("thread/read", {
      threadId: options.threadId,
      includeTurns: true,
    })) as CodexThreadReadResponse;
    const baseline = this.#externalTurnBaselines.get(options.threadId);
    const sourceTurns = response.thread.turns
      .filter((turn) => (baseline ? !baseline.has(turn.id) : false))
      .filter(
        (turn) =>
          !turn.items.some(
            (item) =>
              item.type === "userMessage" &&
              item.clientId?.startsWith("cantrip:"),
          ),
      );
    const sync = normalizeCodexThreadReadResponse(
      { thread: { ...response.thread, turns: sourceTurns } },
      options.cwd,
    );
    // Message deduplication must not erase the current native lifecycle.
    sync.status = observedCodexThreadStatus(response.thread);
    for (const turn of sync.turns) {
      if (turn.status !== "inProgress") baseline?.add(turn.id);
    }
    return sync;
  }

  async prepareExternalSync(
    options: Pick<
      RunAgentTurnOptions,
      | "cwd"
      | "executionProfile"
      | "mcpServers"
      | "model"
      | "permissionProfileId"
      | "provider"
      | "threadId"
    > & { threadId: string; subagentDefaults?: RuntimeSubagentDefaults | null },
  ): Promise<void> {
    await this.ensureStarted(
      options.model,
      options.provider,
      options.subagentDefaults,
      options.executionProfile,
    );
    // Older servers do not send console MCP materialization fields. Preserve
    // their prior attach behavior rather than resuming with an incomplete
    // configuration during a rolling deployment.
    const threadId = options.mcpServers
      ? await this.loadThread(options, false)
      : options.threadId;
    if (!threadId) {
      throw new Error(
        "The Codex console thread is no longer available on this worker.",
      );
    }
    let response: CodexThreadReadResponse;
    try {
      response = (await this.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as CodexThreadReadResponse;
    } catch (error) {
      if (!/not materialized yet/i.test(String(error))) throw error;
      this.#externalTurnBaselines.set(threadId, new Set());
      return;
    }
    this.#externalTurnBaselines.set(
      threadId,
      new Set(response.thread.turns.map((turn) => turn.id)),
    );
  }

  async compactThread(
    options: CompactAgentThreadOptions,
  ): Promise<{ accepted: true }> {
    const startedAtMs = Date.now();
    let threadId = this.managedGuiThread(options.threadId);
    if (!threadId) {
      await this.ensureStarted(
        options.model,
        options.provider,
        null,
        options.executionProfile,
      );
      threadId = await this.loadThread(options, false);
    }
    if (!threadId) {
      throw new Error(
        "The Codex thread is no longer available on this worker.",
      );
    }
    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }
    await this.requestGuiThreadMutation("thread/compact/start", { threadId });
    workerLogger.event("info", "Codex thread compaction accepted", {
      event: "codex.thread.compact",
      subsystem: "codex",
      operation: "compact-thread",
      status: "accepted",
      threadId,
      durationMs: Date.now() - startedAtMs,
      ...codexProviderLogContext(options.provider),
    });
    return { accepted: true };
  }

  async rollbackLatestChatTurn(
    options: CompactAgentThreadOptions & { clientMessageId: string },
  ): Promise<{ rolledBack: true }> {
    const startedAtMs = Date.now();
    let threadId = this.managedGuiThread(options.threadId);
    if (!threadId) {
      await this.ensureStarted(
        options.model,
        options.provider,
        null,
        options.executionProfile,
      );
      threadId = await this.loadThread(options, false);
    }
    if (!threadId) {
      throw new Error(
        "The Codex thread is no longer available on this worker.",
      );
    }
    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }
    const response = (await this.request("thread/read", {
      threadId,
      includeTurns: true,
    })) as CodexThreadReadResponse;
    const boundary = chatTurnRollbackBoundary(
      response.thread.turns,
      options.clientMessageId,
    );
    if (!boundary) {
      throw new Error(
        "The latest Cantrip message could not be matched to its Codex turn.",
      );
    }
    await this.requestGuiThreadMutation("thread/revert", {
      threadId,
      beforeTurnId: boundary.turnId,
    });
    workerLogger.event("info", "Codex chat turn rolled back", {
      event: "codex.thread.rollback",
      subsystem: "codex",
      operation: "rollback-chat-turn",
      status: "completed",
      threadId,
      turnId: boundary.turnId,
      durationMs: Date.now() - startedAtMs,
      ...codexProviderLogContext(options.provider),
    });
    return { rolledBack: true };
  }

  async resumeManagedAutomation(options: {
    threadId: string;
  }): Promise<{ resumed: boolean }> {
    const threadId = this.managedGuiThread(options.threadId);
    if (!threadId)
      throw new Error(
        "Automation resume requires its bound managed native session.",
      );
    const canonicalQueue = this.#managedQueueResumers.get(threadId);
    if (canonicalQueue) {
      if (canonicalQueue.transportGeneration !== this.transportGeneration)
        throw new Error(
          "The managed queue belongs to a replaced native transport.",
        );
      const result = await canonicalQueue.handler();
      if (
        canonicalQueue.transportGeneration !== this.transportGeneration ||
        this.#managedQueueResumers.get(threadId) !== canonicalQueue
      )
        throw new Error("The managed queue was replaced during resume.");
      if (result.resumed) return result;
    }
    const { goal } = await this.refreshGoal(threadId);
    if (goal?.status === "active") {
      const response = chatGoalResponseSchema.parse(
        await this.requestGuiThreadMutation("thread/goal/set", {
          threadId,
          status: "active",
        }),
      );
      this.cacheGoal(response);
      return { resumed: true };
    }
    // A selected canonical queue is the sole queue owner, including when empty.
    if (canonicalQueue) return { resumed: false };
    const queue = z
      .object({ data: z.array(z.unknown()) })
      .parse(await this.request("thread/queue/list", { threadId, limit: 1 }));
    if (!queue.data.length) return { resumed: false };
    await this.requestGuiThreadMutation("thread/queue/start", { threadId });
    return { resumed: true };
  }

  async getGoal(
    options: GoalRuntimeOptions & { threadId: string },
  ): Promise<ChatGoalResponse> {
    if (!this.managedGuiThread(options.threadId))
      await this.ensureStarted(options.model, options.provider);
    // Native goal reads support unloaded threads. Reading metadata must not
    // resume with an incomplete MCP/model/permission configuration.
    return this.refreshGoal(options.threadId);
  }

  async createGoal(
    options: GoalRuntimeOptions & {
      objective: string;
      tokenBudget?: number | null;
      operationId?: string;
      configureTaskPermissions?: boolean;
    },
  ): Promise<ChatGoalResponse> {
    let threadId = this.managedGuiThread(options.threadId);
    if (!threadId) {
      await this.ensureStarted(options.model, options.provider);
      threadId = await this.loadThread(
        options,
        true,
        options.configureTaskPermissions ? "configure" : "preserve",
      );
    }
    if (!threadId) {
      throw new Error("Could not start a Codex thread for the goal.");
    }
    const existing = await this.refreshGoal(threadId);
    if (existing.goal?.status === "complete") {
      const cleared = chatGoalClearSchema.parse(
        await this.requestGuiThreadMutation(
          "thread/goal/clear",
          { threadId },
          options.operationId ? `${options.operationId}:clear` : undefined,
        ),
      );
      if (!cleared.cleared) {
        throw new Error("Could not replace the completed Codex goal.");
      }
      this.#goals.delete(threadId);
    }
    const response = chatGoalResponseSchema.parse(
      await this.requestGuiThreadMutation(
        "thread/goal/set",
        {
          threadId,
          objective: options.objective,
          status: "active",
          tokenBudget: options.tokenBudget ?? null,
        },
        options.operationId,
      ),
    );
    this.cacheGoal(response);
    return response;
  }

  async updateGoal(
    options: GoalRuntimeOptions & {
      status?: "active" | "paused";
      objective?: string;
      threadId: string;
      configureTaskPermissions?: boolean;
    },
  ): Promise<ChatGoalResponse> {
    let threadId = this.managedGuiThread(options.threadId);
    if (!threadId) {
      await this.ensureStarted(options.model, options.provider);
      threadId = await this.loadThread(
        options,
        false,
        options.configureTaskPermissions ? "configure" : "preserve",
      );
    }
    if (!threadId) {
      throw new Error(
        "The Codex thread is no longer available on this worker.",
      );
    }
    const response = chatGoalResponseSchema.parse(
      await this.requestGuiThreadMutation(
        "thread/goal/set",
        {
          threadId,
          ...(options.status === undefined ? {} : { status: options.status }),
          ...(options.objective === undefined
            ? {}
            : { objective: options.objective }),
        },
        undefined,
        options.objective !== undefined && options.status === undefined,
      ),
    );
    this.cacheGoal(response);
    return response;
  }

  async clearGoal(
    options: GoalRuntimeOptions & { threadId: string },
  ): Promise<{ cleared: boolean }> {
    let threadId = this.managedGuiThread(options.threadId);
    if (!threadId) {
      await this.ensureStarted(options.model, options.provider);
      threadId = await this.loadThread(options, false, "preserve");
    }
    if (!threadId) {
      throw new Error(
        "The Codex thread is no longer available on this worker.",
      );
    }
    const response = chatGoalClearSchema.parse(
      await this.requestGuiThreadMutation("thread/goal/clear", { threadId }),
    );
    if (response.cleared) this.#goals.delete(threadId);
    return response;
  }

  /** Observation only: never starts a runtime, resumes a thread or writes settings. */
  getNativeThreadSettings(
    threadId: string,
  ): ReturnType<NativeThreadSettingsState["read"]> {
    return this.#threadSettings.read(threadId);
  }

  /** Called after correlated native application and durable server policy publication. */
  confirmManagedPermissionProfile(
    threadId: string,
    generation: string,
    profileId: string,
  ): void {
    if (this.transportGeneration !== generation)
      throw new Error(
        "The applied permission profile belongs to a replaced runtime.",
      );
    this.#managedSecurityOwners.add(threadId);
    this.#confirmedManagedPermissions.set(threadId, { generation, profileId });
    this.#permissionProfilesByThread.set(threadId, profileId);
  }

  confirmedManagedPermissionProfile(threadId: string): string | undefined {
    const applied = this.#confirmedManagedPermissions.get(threadId);
    return applied?.generation === this.transportGeneration
      ? applied.profileId
      : undefined;
  }

  /** Explicit controller mutation. Never starts/resumes a runtime or infers settings
   * from a turn's bootstrap model. Admission and application remain separate. */
  async updateNativeThreadSettings(options: {
    threadId: string;
    operationId: string;
    settingsBindingId: string;
    nativeEpoch: string;
    patch: Record<string, unknown>;
    permissionTransition?: PermissionTransition;
  }): Promise<NativeSettingsRequest> {
    const dispatcher = this.#managedNativeCommandDispatchers.get(
      options.threadId,
    );
    if (!dispatcher)
      throw new Error(
        "Native settings changes require the managed command controller.",
      );
    return this.applyNativeThreadSettings(
      options.threadId,
      options.operationId,
      options.patch,
      () => {
        if (
          this.#managedNativeCommandDispatchers.get(options.threadId) !==
          dispatcher
        )
          throw new Error("The managed settings controller was replaced.");
        const observedEpoch = this.#threadSettings.read(options.threadId)
          .confirmed?.settings.settingsVersion?.epoch;
        if (observedEpoch && observedEpoch !== options.nativeEpoch)
          throw new Error("The native settings Core was replaced.");
      },
      options.settingsBindingId,
      true,
      options.permissionTransition,
    );
  }

  /** Read/write defaults through the existing managed account, independently of
   * thread selections. Never start a runtime merely to observe its defaults. */
  async nativeAccountDefaults(options: {
    threadId: string;
    operationId: string;
    settingsBindingId: string;
    write?: NativeAccountDefaultsWrite;
  }): Promise<NativeAccountDefaultsResult> {
    const dispatcher = this.#managedNativeCommandDispatchers.get(
      options.threadId,
    );
    if (!dispatcher)
      throw new Error(
        "Account defaults require the managed command controller.",
      );
    const generation = this.transportGeneration;
    const preparationVersion =
      this.#threadPreparationVersions.get(options.threadId) ?? 0;
    const assertCurrent = () => {
      if (
        this.#managedNativeCommandDispatchers.get(options.threadId) !==
          dispatcher ||
        this.transportGeneration !== generation ||
        (this.#threadPreparationVersions.get(options.threadId) ?? 0) !==
          preparationVersion
      )
        throw new Error("The account defaults source was replaced.");
    };
    const request = async (method: string, params: Record<string, unknown>) => {
      assertCurrent();
      const result = await this.request(method, params);
      assertCurrent();
      return result;
    };
    if (!options.write) {
      const snapshot = await readNativeAccountDefaults(request);
      return { snapshot, write: null, verification: "read" };
    }
    const params = nativeAccountDefaultsParams(options.write);
    // Unlike a thread settings mutation, this records an account-defaults
    // command without entering the thread desired/pending/effective journal.
    return (await dispatcher({
      operationId: options.operationId,
      settingsBindingId: options.settingsBindingId,
      method: "config/batchWrite",
      params,
      dispatch: (forward) =>
        writeNativeAccountDefaults(
          (method, params) => this.request(method, params),
          forward?.params ?? params,
          assertCurrent,
        ),
    })) as NativeAccountDefaultsResult;
  }

  private async applyNativeThreadSettings(
    threadId: string,
    operationId: string,
    patch: Record<string, unknown>,
    assertOwner: () => void = () => {},
    settingsBindingId?: string,
    refreshModelCatalog = false,
    permissionTransition?: PermissionTransition,
  ): Promise<NativeSettingsRequest> {
    // Identity fields must never be supplied inside the settings patch.
    if (Object.hasOwn(patch, "threadId") || Object.hasOwn(patch, "operationId"))
      throw new Error(
        "Native settings identity must be separate from its patch.",
      );
    const generation = this.transportGeneration;
    const preparationVersion =
      this.#threadPreparationVersions.get(threadId) ?? 0;
    const assertCurrent = () => {
      assertOwner();
      if (
        this.transportGeneration !== generation ||
        (this.#threadPreparationVersions.get(threadId) ?? 0) !==
          preparationVersion
      )
        throw new Error(
          "Native settings update belongs to a replaced thread or transport.",
        );
    };
    assertCurrent();
    const pending = this.#threadSettings.begin(threadId, operationId, patch);
    const params = { ...structuredClone(patch), threadId, operationId };
    try {
      const acknowledgment = await this.dispatchGuiNativeCommand(threadId, {
        operationId,
        ...(settingsBindingId === undefined ? {} : { settingsBindingId }),
        ...(permissionTransition ? { permissionTransition } : {}),
        method: "thread/settings/update",
        params,
        dispatch: async (forward) => {
          if (refreshModelCatalog) {
            await this.prepareManagedModelCatalogRequest(
              forward?.method ?? "thread/settings/update",
              forward?.params ?? params,
            );
          }
          assertCurrent();
          return this.request(
            forward?.method ?? "thread/settings/update",
            forward?.params ?? params,
          );
        },
      });
      assertCurrent();
      this.#threadSettings.acknowledge(threadId, pending, acknowledgment);
      return structuredClone(pending);
    } catch (error) {
      this.#threadSettings.failed(
        threadId,
        pending,
        error instanceof CodexNativeRpcError,
      );
      throw error;
    }
  }

  /** Read the durable permission journal without starting or replaying input. */
  async readNativePermissionOperation(
    threadId: string,
    operationId: string,
  ): Promise<unknown> {
    const generation = this.transportGeneration;
    const preparationVersion =
      this.#threadPreparationVersions.get(threadId) ?? 0;
    const value = await this.request("thread/settings/operation/read", {
      threadId,
      operationId,
    });
    if (
      this.transportGeneration !== generation ||
      (this.#threadPreparationVersions.get(threadId) ?? 0) !==
        preparationVersion
    )
      throw new Error(
        "Native permission journal read belongs to a replaced thread or transport.",
      );
    return value;
  }

  /** Read Core's atomic settings/version snapshot, without loading or configuring it. */
  async readNativeThreadSettings(
    threadId: string,
  ): Promise<ReturnType<NativeThreadSettingsState["read"]>> {
    const generation = this.transportGeneration;
    const preparationVersion =
      this.#threadPreparationVersions.get(threadId) ?? 0;
    const value = (await this.request("thread/settings/read", {
      threadId,
    })) as { threadId?: unknown };
    if (
      this.transportGeneration !== generation ||
      (this.#threadPreparationVersions.get(threadId) ?? 0) !==
        preparationVersion
    )
      throw new Error(
        "Native settings read belongs to a replaced thread or transport.",
      );
    if (value.threadId !== threadId)
      throw new Error("Native settings read returned another thread.");
    this.#threadSettings.observe(value);
    return this.#threadSettings.read(threadId);
  }

  /** Capture Core's current choices for an authorized invalid-compaction retry. */
  async captureNativeReplacementSettings(
    sourceThreadId: string,
  ): Promise<NativeReplacementSettings> {
    const transportGeneration = this.transportGeneration;
    const sourcePreparationVersion =
      this.#threadPreparationVersions.get(sourceThreadId) ?? 0;
    const { confirmed } = await this.readNativeThreadSettings(sourceThreadId);
    if (!confirmed)
      throw new Error("Native replacement settings were not returned by Core.");
    return {
      sourceThreadId,
      transportGeneration,
      sourcePreparationVersion,
      settings: confirmed.settings,
    };
  }

  private async restoreNativeReplacementSettings(
    threadId: string,
    captured: NativeReplacementSettings,
    assertTarget: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const assertCurrent = () => {
      signal?.throwIfAborted();
      assertTarget();
      if (
        this.transportGeneration !== captured.transportGeneration ||
        (this.#threadPreparationVersions.get(captured.sourceThreadId) ?? 0) !==
          captured.sourcePreparationVersion
      )
        throw new Error("Native replacement settings source was replaced.");
    };
    assertCurrent();
    // A console can update the source while replacement initialization runs.
    // Fence the actual source version/content, never a cached bootstrap choice.
    const current = await this.readNativeThreadSettings(
      captured.sourceThreadId,
    );
    assertCurrent();
    if (!isDeepStrictEqual(current.confirmed?.settings, captured.settings))
      throw new Error(
        "Native source settings changed during thread replacement.",
      );
    const settings = captured.settings;
    const patch = {
      model: settings.model,
      effort: settings.effort,
      // Raw absence differs from an explicit standard-service selection.
      ...(settings.serviceTier === null
        ? { unsetServiceTier: true }
        : { serviceTier: settings.serviceTier }),
      collaborationMode: structuredClone(settings.collaborationMode),
      ...(settings.multiAgentEnabled === undefined
        ? {}
        : { multiAgentEnabled: settings.multiAgentEnabled }),
      ...(settings.subagentModel === undefined
        ? {}
        : { subagentModel: settings.subagentModel }),
      ...(settings.subagentReasoningEffort === undefined
        ? {}
        : { subagentReasoningEffort: settings.subagentReasoningEffort }),
      ...(settings.multiAgentMode === undefined
        ? {}
        : { multiAgentMode: settings.multiAgentMode }),
    };
    await this.applyPreparedNativeSettings(
      threadId,
      patch,
      (actual) =>
        actual.modelProvider === settings.modelProvider &&
        actual.serviceTier === settings.serviceTier &&
        Object.entries(patch).every(([key, value]) =>
          key === "unsetServiceTier"
            ? actual.serviceTier === null
            : isDeepStrictEqual(actual[key], value),
        ),
      assertCurrent,
      signal,
    );
    const finalSource = await this.readNativeThreadSettings(
      captured.sourceThreadId,
    );
    assertCurrent();
    if (!isDeepStrictEqual(finalSource.confirmed?.settings, captured.settings))
      throw new Error(
        "Native source settings changed during thread replacement.",
      );
  }

  /** Preparation must await Core application, not just the enqueue receipt.
   * Normal active-turn settings updates still expose their pending state. */
  private async applyPreparedNativeSettings(
    threadId: string,
    patch: Record<string, unknown>,
    validate: (settings: NativeThreadSettings) => boolean,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const operationId = randomUUID();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const applied = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Native failure/exit may precede the RPC reply; retain that failure without
    // producing an unhandled rejection while the acknowledgment is in flight.
    void applied.catch(() => {});
    const check = () => {
      try {
        assertCurrent();
        const request = this.#threadSettings
          .read(threadId)
          .requests.find((candidate) => candidate.operationId === operationId);
        if (request?.status === "applied") {
          const actual = request.applied?.settings;
          if (!actual || !validate(actual))
            reject(new Error("Native preparation applied different settings."));
          else resolve();
        } else if (
          request?.status === "rejected" ||
          request?.status === "uncertain"
        )
          reject(
            new Error(
              typeof request.error?.message === "string"
                ? request.error.message
                : "Native preparation settings application was not confirmed.",
            ),
          );
      } catch (error) {
        reject(error);
      }
    };
    const subscription = this.observeNativeHistory(threadId, {
      capture: (event) => {
        if (event.method === "thread/closed")
          reject(
            new Error(
              "Native preparation thread closed before settings applied.",
            ),
          );
        // The raw history observer runs before the settings state reducer.
        queueMicrotask(check);
      },
      onError: reject,
    });
    const abort = () => reject(signal?.reason ?? subscription.signal.reason);
    subscription.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      assertCurrent();
      // A rejected/aborted observation must also stop preparation while the
      // enqueue acknowledgment is still pending. Success still waits for both.
      const failure = applied.then(() => new Promise<never>(() => {}));
      await Promise.race([
        this.applyNativeThreadSettings(
          threadId,
          operationId,
          patch,
          assertCurrent,
        ),
        failure,
      ]);
      check();
      await applied;
      assertCurrent();
    } finally {
      signal?.removeEventListener("abort", abort);
      subscription.signal.removeEventListener("abort", abort);
      subscription.close();
    }
  }

  async getPlanMode(
    options: GoalRuntimeOptions & { fallbackMode: PlanMode },
  ): Promise<{ mode: PlanMode; threadId: string | null }> {
    const threadId = options.threadId;
    if (!threadId) {
      return { mode: options.fallbackMode, threadId: null };
    }
    const knownMode = this.#threadSettings.confirmedPlanMode(threadId);
    if (knownMode) return { mode: knownMode, threadId };
    // There is no native unloaded settings read. Resuming here would initialize
    // inherited account MCP before managed preparation, without yielding a mode
    // sample. Keep the fallback observational until a live notification arrives.
    return { mode: options.fallbackMode, threadId };
  }

  async ensureThread(
    options: GoalRuntimeOptions & { planMode: PlanMode },
  ): Promise<{ threadId: string }> {
    await this.ensureStarted(options.model, options.provider);
    const threadId = await this.loadThread(options);
    if (!threadId) {
      throw new Error("Could not initialize the Codex console thread.");
    }
    await this.updatePlanModeOnThread(
      threadId,
      options.planMode,
      options.model,
    );
    return { threadId };
  }

  /** Stage a transferred conversation in this isolated destination runtime.
   * The caller owns handoff authorization and canonical publication. Native
   * resume selects the destination provider/model while inheriting the imported
   * permissions, service tier, collaboration mode and custom child settings. */
  prepareImportedManagedThread(
    options: PrepareImportedManagedThreadOptions,
  ): Promise<{ threadId: string }> {
    const key = options.transfer.threadId;
    const previous =
      this.#managedImportPreparations.get(key) ?? Promise.resolve();
    const result = previous.then(() =>
      this.prepareImportedManagedThreadSerialized(options),
    );
    const settled = result.then(
      () => {},
      () => {},
    );
    this.#managedImportPreparations.set(key, settled);
    void settled.then(() => {
      if (this.#managedImportPreparations.get(key) === settled)
        this.#managedImportPreparations.delete(key);
    });
    return result;
  }

  private async prepareImportedManagedThreadSerialized(
    options: PrepareImportedManagedThreadOptions,
  ): Promise<{ threadId: string }> {
    await this.ensureStarted(
      options.model,
      options.provider,
      options.subagentDefaults,
      options.executionProfile,
    );
    const epoch = this.#preparationEpoch;
    const { transfer } = options;
    options.signal?.throwIfAborted();
    const imported = this.#managedHistoryImports.get(transfer.threadId);
    if (
      imported?.epoch !== epoch ||
      imported.transferId !== transfer.transferId ||
      imported.path !== transfer.path
    ) {
      await this.importManagedHistory(transfer, options.signal);
      this.assertPreparationEpoch(epoch);
      this.#managedHistoryImports.set(transfer.threadId, {
        epoch,
        transferId: transfer.transferId,
        path: transfer.path,
      });
    }
    const threadId = await this.loadThread(
      {
        ...options,
        threadId: transfer.threadId,
        managedConfiguration: true,
        adoptImportedProvider: true,
      },
      false,
      "preserve",
    );
    this.assertPreparationEpoch(epoch);
    options.signal?.throwIfAborted();
    if (threadId !== transfer.threadId)
      throw new Error("Native handoff prepared another conversation.");
    const { confirmed } = await this.readNativeThreadSettings(threadId);
    this.assertPreparationEpoch(epoch);
    if (
      confirmed?.settings.model !== options.model.name ||
      confirmed.settings.modelProvider !==
        codexModelProviderName(options.provider)
    )
      throw new Error(
        "Native handoff did not select the requested provider and model.",
      );
    return { threadId };
  }

  async prepareManagedThread(
    options: PrepareManagedThreadOptions,
  ): Promise<{ threadId: string }> {
    await this.ensureStarted(
      options.model,
      options.provider,
      options.subagentDefaults,
      options.executionProfile,
    );
    const epoch = this.#preparationEpoch;
    const threadId = await this.loadThread(
      { ...options, managedConfiguration: true },
      options.intent === "configure",
      options.intent,
    );
    if (!threadId) {
      throw new Error("Could not initialize the managed Codex thread.");
    }
    const threadVersion = this.#threadPreparationVersions.get(threadId) ?? 0;
    const assertCurrent = () => {
      this.assertPreparationEpoch(epoch);
      if (
        (this.#threadPreparationVersions.get(threadId) ?? 0) !== threadVersion
      ) {
        throw new Error("Codex thread closed or changed during preparation.");
      }
    };
    assertCurrent();
    if (
      options.intent === "configure" &&
      this.#threadSettings.selectedPlanMode(threadId) !== options.planMode
    ) {
      await this.updatePlanModeOnThread(
        threadId,
        options.planMode,
        options.model,
        assertCurrent,
        options.threadId === null ? { signal: options.signal } : undefined,
      );
      assertCurrent();
    }
    if (options.replacementSettings) {
      await this.restoreNativeReplacementSettings(
        threadId,
        options.replacementSettings,
        assertCurrent,
        options.signal,
      );
      assertCurrent();
    }
    return { threadId };
  }

  async hydrateChatRelocation(
    options: HydrateChatRelocationOptions,
  ): Promise<{ threadId: string }> {
    await this.ensureStarted(options.model, options.provider);
    if (!this.methodAvailable("thread/inject_items")) {
      throw new Error(
        "The installed Codex runtime cannot inject canonical thread history.",
      );
    }
    const availableSkills = options.requiredSkillNames.length
      ? await this.listSkills(options, true)
      : [];
    const availableSkillNames = new Set(
      availableSkills.map((skill) => skill.name),
    );
    const missingSkills = options.requiredSkillNames.filter(
      (name) => !availableSkillNames.has(name),
    );
    if (missingSkills.length) {
      throw new Error(
        `Required skills are unavailable on the target worker: ${missingSkills.join(", ")}.`,
      );
    }
    const profiles = await this.listPermissionProfiles(options);
    const codexPermissionProfileId =
      options.permissionProfileId === YOLO_PERMISSION_PROFILE_ID
        ? ":danger-full-access"
        : options.permissionProfileId;
    if (
      !profiles.available ||
      !profiles.profiles.some(
        (profile) => profile.id === codexPermissionProfileId && profile.allowed,
      )
    ) {
      throw new Error(
        profiles.reason ??
          `Permission profile ${options.permissionProfileId} is unavailable on the target worker.`,
      );
    }
    const threadId = await this.loadThread({ ...options, threadId: null });
    if (!threadId) {
      throw new Error("Could not create the target Codex thread.");
    }
    await options.onThreadStarted(threadId);
    for (const items of relocationItemBatches(
      relocationResponseItems(options.payload),
    )) {
      await this.request("thread/inject_items", { threadId, items });
    }
    await this.updatePlanModeOnThread(
      threadId,
      options.planMode,
      options.model,
    );
    return { threadId };
  }

  async discardRelocationThread(
    threadId: string,
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
  ): Promise<void> {
    await this.ensureStarted(model, provider);
    try {
      if (this.methodAvailable("thread/delete")) {
        await this.request("thread/delete", { threadId });
      } else {
        await this.request("thread/unsubscribe", { threadId });
      }
    } catch {
      // An interrupted attempt may have died before Codex persisted the thread.
    }
    this.forgetThread(threadId);
  }

  async releaseRelocationThread(
    threadId: string | null,
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
  ): Promise<{ released: boolean }> {
    if (!threadId) return { released: false };
    await this.ensureStarted(model, provider);
    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} still has an active turn.`);
    }
    try {
      await this.request("thread/unsubscribe", { threadId });
    } catch (error) {
      if (!/not found|not loaded|unknown thread/iu.test(String(error))) {
        throw error;
      }
    }
    this.forgetThread(threadId);
    return { released: true };
  }

  async setPlanMode(
    options: GoalRuntimeOptions & { mode: PlanMode },
  ): Promise<{ mode: PlanMode; threadId: string }> {
    await this.ensureStarted(options.model, options.provider);
    const threadId = await this.loadThread(options);
    if (!threadId) {
      throw new Error("Could not start a Codex thread for Plan Mode.");
    }
    await this.updatePlanModeOnThread(threadId, options.mode, options.model);
    return { mode: options.mode, threadId };
  }

  pendingAdmittedNativeReply(
    input: AdmittedNativeReplyIdentity,
  ): AdmittedNativeReply | null {
    return this.#interactions.pendingAdmittedNativeReply(input);
  }

  awaitPendingAdmittedNativeReply(
    input: AdmittedNativeReplyIdentity,
  ): Promise<AdmittedNativeReply> {
    return this.#interactions.awaitPendingAdmittedNativeReply(input);
  }

  resolveAdmittedNativeReply(
    input: AdmittedNativeReplyIdentity & {
      response: AdmittedNativeReplyResponse;
    },
  ): { accepted: true } {
    return this.#interactions.resolveAdmittedNativeReply(input);
  }

  answerAgentInteraction(
    requestKey: string,
    response: AgentInteractionResponse,
  ): Promise<{ accepted: true }> {
    return this.#interactions.answerAgentInteraction(requestKey, response);
  }

  cancelAgentInteraction(
    requestKey: string,
    reason: string,
  ): Promise<{ accepted: true }> {
    return this.#interactions.cancelAgentInteraction(requestKey, reason);
  }

  async interruptChat(
    chatId: string,
    threadId: string | null,
  ): Promise<{ interrupted: boolean }> {
    const active = findActiveChatTurn(
      this.#executions.activeTurns,
      chatId,
      threadId,
    );
    if (!active) {
      const pendingRetry = this.#pendingCapacityRetries.get(chatId);
      // An autonomous runner can be awaiting admission before it has a native
      // turn. The admitted dispatch hook invalidates that runner; do not invent
      // a turn identity or send an invalid raw turn/interrupt request.
      if (threadId && this.#managedNativeCommandDispatchers.has(threadId)) {
        await this.dispatchGuiNativeCommand(threadId, {
          method: "turn/interrupt",
          params: { threadId },
          dispatch: async () => {
            pendingRetry?.controller.abort();
            return { interrupted: Boolean(pendingRetry) };
          },
        });
        return { interrupted: Boolean(pendingRetry) };
      }
      if (!pendingRetry) return { interrupted: false };
      pendingRetry.controller.abort();
      workerLogger.event("info", "Codex capacity retry interrupted", {
        event: "codex.turn.capacity-retry-interrupted",
        subsystem: "codex",
        operation: "interrupt-chat-turn",
        status: "accepted",
        chatId,
        threadId: pendingRetry.threadId,
      });
      return { interrupted: true };
    }
    const previousRequest = active[1].interruptionRequestedAtMs;
    active[1].interruptionRequestedAtMs = Date.now();
    const execution = this.#executions.rootExecutionsByActive.get(active[1]);
    // A user Stop cancels local host work immediately, even while the native
    // interrupt acknowledgement is pending or ultimately fails.
    if (execution) this.#executions.abortComputerUseExecution(execution);
    try {
      const params = { threadId: active[1].threadId, turnId: active[0] };
      await this.dispatchGuiNativeCommand(active[1].threadId, {
        method: "turn/interrupt",
        params,
        dispatch: () => {
          this.assertGuiTurnCurrent(active[1], active[0]);
          return this.request("turn/interrupt", params);
        },
      });
    } catch (error) {
      active[1].interruptionRequestedAtMs = previousRequest;
      throw error;
    }
    workerLogger.event("info", "Codex chat turn interrupt accepted", {
      event: "codex.turn.interrupt",
      subsystem: "codex",
      operation: "interrupt-chat-turn",
      status: "accepted",
      chatId,
      threadId: active[1].threadId,
      turnId: active[0],
    });
    return { interrupted: true };
  }

  async steerThread(
    chatId: string,
    threadId: string | null,
    prompt: string,
    attachments: RuntimeChatAttachment[] = [],
    model?: RunAgentTurnOptions["model"],
    provider?: RunAgentTurnOptions["provider"],
    queued?: {
      operationId?: string;
      queueClaim?: { id: string; promptRevision: number };
      input?: ReadonlyArray<Record<string, unknown>>;
      clientUserMessageId?: string;
    },
  ): Promise<{ steered: true; turnId: string }> {
    const active = [...this.#executions.activeTurns.entries()].find(
      ([, turn]) =>
        (threadId && turn.threadId === threadId) || turn.chatId === chatId,
    );
    if (!active) {
      throw new Error("The Codex thread does not have an active turn.");
    }
    const activeThreadId = active[1].threadId;
    const inheritThreadSettings =
      this.#managedNativeCommandDispatchers.has(activeThreadId);
    const params = {
      threadId: activeThreadId,
      ...(queued?.clientUserMessageId
        ? { clientUserMessageId: queued.clientUserMessageId }
        : {}),
      input: queued?.input
        ? [
            ...structuredClone(queued.input),
            ...(attachments.length
              ? await this.turnAttachmentInputs(
                  "",
                  attachments,
                  model,
                  provider,
                  inheritThreadSettings,
                )
              : []),
          ]
        : await this.turnAttachmentInputs(
            prompt,
            attachments,
            model,
            provider,
            inheritThreadSettings,
          ),
      expectedTurnId: active[0],
    };
    const result = (await this.dispatchGuiNativeCommand(activeThreadId, {
      ...(queued?.operationId ? { operationId: queued.operationId } : {}),
      ...(queued?.queueClaim ? { queueClaim: queued.queueClaim } : {}),
      method: "turn/steer",
      params,
      dispatch: () => {
        this.assertGuiTurnCurrent(active[1], active[0]);
        return this.request("turn/steer", params);
      },
    })) as { turnId: string };
    workerLogger.event("info", "Codex turn steering accepted", {
      event: "codex.turn.steer",
      subsystem: "codex",
      operation: "steer-turn",
      status: "accepted",
      chatId,
      threadId: activeThreadId,
      turnId: result.turnId,
      expectedTurnId: active[0],
      counts: { attachments: attachments.length },
    });
    return { steered: true, turnId: result.turnId };
  }

  close(): void {
    workerLogger.event("info", "Codex app-server stopping", {
      event: "codex.runtime.lifecycle",
      subsystem: "codex",
      operation: "stop",
      status: "started",
      runtimeId: this.#runtimeId,
      counts: {
        activeTurns: this.#executions.activeTurns.size,
        pendingRequests: this.#rpcRequests.pendingCount,
      },
    });
    this.handleExit(new Error("Codex app-server stopped."));
    this.#socket?.close();
    this.#socket = null;
    this.#child?.kill("SIGINT");
    this.#child = null;
    this.#remoteUrl = null;
    this.#runtimeId = null;
    this.#runtimeStartedAtMs = null;
    this.#authRecovery.setSession(null);
    this.#diagnosticSecrets.clear();
    this.#runtimeIsZai = false;
    this.#starting = null;
    this.#loadedThreads.clear();
    this.#managedHistoryImports.clear();
    this.#managedNativeCommandDispatchers.clear();
    this.#executions.clearOwnership();
    this.#mcpConfigFingerprintsByThread.clear();
    this.#managedConfigApplications.clear();
    this.#managedThreadOverlays.clear();
    this.#permissionProfilesByThread.clear();
    this.#confirmedManagedPermissions.clear();
    this.#managedSecurityOwners.clear();
    this.#externalImportStatuses.clear();
    this.#externalTurnBaselines.clear();
    this.#externalThreadChanges.clear();
    this.#mcpOauthStatuses.clear();
    this.#goals.clear();
    this.#imageSupport.clear();
    this.#skillRoots = [];
  }

  private async turnAttachmentInputs(
    prompt: string,
    attachments: RuntimeChatAttachment[],
    model?: RunAgentTurnOptions["model"],
    provider?: RunAgentTurnOptions["provider"],
    inheritThreadSettings = false,
  ): Promise<Array<Record<string, unknown>>> {
    const imageSupport =
      inheritThreadSettings ||
      (model && provider && attachments.some(({ kind }) => kind === "image")
        ? await this.modelSupportsImages(model, provider)
        : false);
    const text = attachmentPromptText(prompt, attachments, imageSupport);
    return [
      { type: "text", text, text_elements: [] },
      ...(imageSupport
        ? attachments.flatMap((attachment) =>
            attachment.kind === "image"
              ? [{ type: "localImage", path: attachment.path }]
              : [],
          )
        : []),
    ];
  }

  async runLabelInference(options: {
    model: RunAgentTurnOptions["model"];
    provider: RunAgentTurnOptions["provider"];
    instructions: string;
    input: string;
  }): Promise<string> {
    await this.ensureStarted(options.model, options.provider);
    const result = (await this.request(
      "cantrip/inference",
      {
        model: options.model.name,
        reasoningEffort: options.model.reasoningEffort,
        instructions: options.instructions,
        input: options.input,
      },
      27_000,
    )) as { text?: unknown };
    if (typeof result.text !== "string")
      throw new Error("Invalid labeling response.");
    return result.text;
  }

  private async modelSupportsImages(
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
  ): Promise<boolean> {
    const key = `${provider.id}:${model.name}`;
    const cached = this.#imageSupport.get(key);
    if (cached !== undefined) return cached;
    let supported =
      provider.kind === "chatgpt" ||
      runtimeModelSupportsImages(model, provider.kind);
    if (this.methodAvailable("model/list")) {
      try {
        const response = (await this.request("model/list", {
          includeHidden: true,
          limit: 100,
        })) as {
          data?: Array<{
            id?: string;
            inputModalities?: string[];
            model?: string;
          }>;
        };
        const entry = response.data?.find(
          (candidate) =>
            candidate.id === model.name || candidate.model === model.name,
        );
        if (entry) {
          supported =
            supported || entry.inputModalities?.includes("image") === true;
        }
      } catch {
        // ChatGPT defaults remain backward compatible; unknown custom routes
        // retain path-based access without risking an unsupported image input.
      }
    }
    this.#imageSupport.set(key, supported);
    return supported;
  }

  private async ensureStarted(
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
    subagentDefaults: RuntimeSubagentDefaults | null = null,
    executionProfile: RunAgentTurnOptions["executionProfile"] = "ide",
  ): Promise<void> {
    if (
      this.compatibility.compatibility === "missing" ||
      this.compatibility.compatibility === "incompatible"
    ) {
      const detail = this.compatibility.degradedReasons.join(" ");
      throw new Error(
        `Codex runtime is ${this.compatibility.compatibility}; expected ${this.compatibility.testedRange}.${detail ? ` ${detail}` : ""}`,
      );
    }
    const runtimeId = codexRuntimeId(
      model,
      provider,
      subagentDefaults,
      executionProfile,
      this.globalSkillRoots,
    );
    if (this.#starting) {
      await this.#starting;
    }
    if (this.#child) {
      if (this.#runtimeId !== runtimeId) {
        throw new Error(
          "A Codex runtime received a turn for a different model profile.",
        );
      }
      const generation = this.#nativeTransportGeneration;
      if (generation) {
        await this.#liveManagedModelCatalog.synchronize({
          generation,
          providerKind: provider.kind,
          models: [
            model,
            ...(subagentDefaults ? [subagentDefaults.model] : []),
          ],
          currentGeneration: () => this.#nativeTransportGeneration,
          dispatch: (params) =>
            this.request("model/managedCatalog/update", params),
        });
        if (this.#nativeTransportGeneration === generation) {
          this.#managedAttributionModels.set(model.routeId, model);
          if (
            subagentDefaults &&
            subagentDefaults.model.routeId !== model?.routeId
          )
            this.#managedAttributionModels.set(
              subagentDefaults.model.routeId,
              subagentDefaults.model,
            );
        }
      }
      return;
    }
    this.#runtimeId = runtimeId;
    const startedAtMs = Date.now();
    workerLogger.event("info", "Codex app-server startup started", {
      event: "codex.runtime.lifecycle",
      subsystem: "codex",
      operation: "start",
      status: "started",
      runtimeId,
      model: model.name,
      codexVersion: this.compatibility.version?.raw ?? null,
      ...codexProviderLogContext(provider),
    });
    const starting = this.start(
      model,
      provider,
      subagentDefaults,
      executionProfile,
    );
    this.#starting = starting;
    try {
      await starting;
    } catch (error) {
      if (this.#starting === starting) {
        this.stopFailedStart();
      }
      workerLogger.event("error", "Codex app-server startup failed", {
        event: "codex.runtime.lifecycle",
        subsystem: "codex",
        operation: "start",
        status: "failed",
        runtimeId,
        durationMs: Date.now() - startedAtMs,
        error: workerLogError(error),
        ...codexProviderLogContext(provider),
      });
      throw error;
    } finally {
      if (this.#starting === starting) this.#starting = null;
    }
  }

  private async ensureCatalogStarted(
    provider: RuntimeProvider & { kind: "chatgpt" },
  ): Promise<void> {
    if (
      this.compatibility.compatibility === "missing" ||
      this.compatibility.compatibility === "incompatible"
    ) {
      const detail = this.compatibility.degradedReasons.join(" ");
      throw new Error(
        `Codex runtime is ${this.compatibility.compatibility}; expected ${this.compatibility.testedRange}.${detail ? ` ${detail}` : ""}`,
      );
    }
    const runtimeId = `catalog:${provider.id}:${provider.credentialHomeKey}`;
    if (this.#starting) await this.#starting;
    if (this.#child) {
      if (this.#runtimeId !== runtimeId) {
        throw new Error(
          "A Codex catalog runtime received a different account.",
        );
      }
      return;
    }
    this.#runtimeId = runtimeId;
    const startedAtMs = Date.now();
    workerLogger.event("debug", "Codex catalog app-server startup started", {
      event: "codex.runtime.lifecycle",
      subsystem: "codex",
      operation: "start-catalog",
      status: "started",
      runtimeId,
      codexVersion: this.compatibility.version?.raw ?? null,
      ...codexProviderLogContext(provider),
    });
    const starting = this.start(null, provider);
    this.#starting = starting;
    try {
      await starting;
    } catch (error) {
      if (this.#starting === starting) this.stopFailedStart();
      workerLogger.event("warn", "Codex catalog app-server startup failed", {
        event: "codex.runtime.lifecycle",
        subsystem: "codex",
        operation: "start-catalog",
        status: "failed",
        runtimeId,
        durationMs: Date.now() - startedAtMs,
        error: workerLogError(error),
        ...codexProviderLogContext(provider),
      });
      throw error;
    } finally {
      if (this.#starting === starting) this.#starting = null;
    }
  }

  private stopFailedStart(): void {
    this.clearManagedExecutionGateHandlers();
    this.#preparationEpoch += 1;
    this.#threadPreparations.clear();
    this.#threadPreparationVersions.clear();
    const socket = this.#socket;
    const child = this.#child;
    this.#socket = null;
    this.#child = null;
    this.#remoteUrl = null;
    this.#runtimeId = null;
    this.#runtimeStartedAtMs = null;
    this.#authRecovery.setSession(null);
    this.#diagnosticSecrets.clear();
    this.#runtimeIsZai = false;
    this.#loadedThreads.clear();
    this.#managedHistoryImports.clear();
    this.#mcpConfigFingerprintsByThread.clear();
    this.#managedConfigApplications.clear();
    this.#managedThreadOverlays.clear();
    this.#permissionProfilesByThread.clear();
    this.#confirmedManagedPermissions.clear();
    this.#managedSecurityOwners.clear();
    this.#threadSettings.clear();
    this.#externalImportStatuses.clear();
    this.#externalTurnBaselines.clear();
    this.#externalThreadChanges.clear();
    this.#mcpOauthStatuses.clear();
    this.#skillRoots = [];
    socket?.close();
    child?.kill("SIGINT");
  }

  private async loadThread(
    options: Pick<
      RunAgentTurnOptions,
      | "cwd"
      | "mcpServers"
      | "model"
      | "permissionProfileId"
      | "provider"
      | "threadId"
    > & {
      executionProfile?: RunAgentTurnOptions["executionProfile"];
      resultMode?: RunAgentTurnOptions["resultMode"];
      subagentDefaults?: RuntimeSubagentDefaults | null;
      onThreadIdentified?: PrepareManagedThreadOptions["onThreadIdentified"];
      managedConfiguration?: boolean;
      adoptImportedProvider?: boolean;
      executionGate?: PrepareManagedThreadOptions["executionGate"];
      canonicalHistory?: PrepareManagedThreadOptions["canonicalHistory"];
    },
    create = true,
    intent: "configure" | "preserve" = "configure",
  ): Promise<string | null> {
    const epoch = this.#preparationEpoch;
    const prepare = () =>
      this.loadPreparedThread(options, create, intent, epoch);
    // Independent new chats do not have a shared key yet. Their coordinator
    // must deduplicate by chat identity, never by a null native thread ID.
    if (!options.threadId) return prepare();
    const key = options.threadId;
    const previous = this.#threadPreparations.get(key);
    const result = (previous ?? Promise.resolve()).then(prepare);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.#threadPreparations.set(key, tail);
    void tail.then(() => {
      if (this.#threadPreparations.get(key) === tail)
        this.#threadPreparations.delete(key);
    });
    return result;
  }

  private assertPreparationEpoch(epoch: number): void {
    if (epoch !== this.#preparationEpoch)
      throw new Error("Codex runtime changed during thread preparation.");
  }

  private async loadPreparedThread(
    options: Pick<
      RunAgentTurnOptions,
      | "cwd"
      | "mcpServers"
      | "model"
      | "permissionProfileId"
      | "provider"
      | "threadId"
    > & {
      executionProfile?: RunAgentTurnOptions["executionProfile"];
      resultMode?: RunAgentTurnOptions["resultMode"];
      subagentDefaults?: RuntimeSubagentDefaults | null;
      onThreadIdentified?: PrepareManagedThreadOptions["onThreadIdentified"];
      managedConfiguration?: boolean;
      adoptImportedProvider?: boolean;
      executionGate?: PrepareManagedThreadOptions["executionGate"];
      canonicalHistory?: PrepareManagedThreadOptions["canonicalHistory"];
    },
    create: boolean,
    intent: "configure" | "preserve",
    epoch: number,
  ): Promise<string | null> {
    // Resolve omission against this transport's actual acknowledged ownership,
    // before an owned unsubscribe can emit thread/closed and clear its caches.
    const confirmedPermission = options.threadId
      ? this.confirmedManagedPermissionProfile(options.threadId)
      : undefined;
    if (confirmedPermission)
      options = { ...options, permissionProfileId: confirmedPermission };
    const retained = options.threadId
      ? this.#managedThreadOverlays.get(options.threadId)
      : undefined;
    if (retained?.epoch === epoch) {
      options = {
        ...options,
        managedConfiguration: true,
        mcpServers:
          options.mcpServers === undefined
            ? retained.options.mcpServers
            : options.mcpServers,
        executionProfile:
          options.executionProfile ?? retained.options.executionProfile,
        subagentDefaults:
          options.subagentDefaults === undefined
            ? retained.options.subagentDefaults
            : options.subagentDefaults,
        executionGate: options.executionGate ?? retained.options.executionGate,
        canonicalHistory:
          options.canonicalHistory ?? retained.options.canonicalHistory,
      };
    }
    // Existing managed threads own their native security selection. Preparation
    // must inherit it even before an applied event reaches durable publication.
    // A cached profile read cannot close that window; only omission does.
    const inheritManagedSecurity = Boolean(
      options.resultMode?.kind !== "structured" &&
      options.threadId &&
      (options.managedConfiguration ||
        confirmedPermission ||
        this.#managedSecurityOwners.has(options.threadId)),
    );
    let preparingThreadId = options.threadId;
    let threadVersion = preparingThreadId
      ? (this.#threadPreparationVersions.get(preparingThreadId) ?? 0)
      : 0;
    const assertCurrent = () => {
      this.assertPreparationEpoch(epoch);
      if (
        preparingThreadId &&
        (this.#threadPreparationVersions.get(preparingThreadId) ?? 0) !==
          threadVersion
      ) {
        throw new Error("Codex thread closed or changed during preparation.");
      }
    };
    assertCurrent();
    const identify = async (threadId: string) => {
      if (typeof threadId !== "string" || !threadId.trim())
        throw new Error("Codex returned an invalid thread identity.");
      if (!preparingThreadId) {
        preparingThreadId = threadId;
        // A newly created ID cannot predate a close observed by this runtime.
        threadVersion = 0;
      }
      await options.onThreadIdentified?.(threadId);
      assertCurrent();
    };
    if (options.threadId) await identify(options.threadId);
    let replacingUnsubscribedThread = false;
    const request = async (method: string, params: unknown) => {
      assertCurrent();
      // After worker loss, its detached process guard needs up to 2.5 seconds
      // to notice the loss and terminate the old native writer. Retry only an
      // actual lock rejection; never remove the lock or replay turn input.
      const deadline = Date.now() + 3_000;
      let result: unknown;
      for (;;) {
        assertCurrent();
        try {
          result = await this.request(method, params);
          break;
        } catch (error) {
          assertCurrent();
          if (
            method !== "thread/resume" ||
            !options.managedConfiguration ||
            !preparingThreadId ||
            !(error instanceof CodexNativeRpcError) ||
            error.nativeError.code !== -32600 ||
            error.nativeError.message !==
              `thread ${preparingThreadId} already has an active writer` ||
            Date.now() >= deadline
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      this.assertPreparationEpoch(epoch);
      // Only our own unsubscribe/resume sequence can retire an idle engine as
      // part of reconfiguration. A cold resume has no such expected retirement:
      // an unrelated close must invalidate its reply just like any other phase.
      if (
        replacingUnsubscribedThread &&
        (method === "thread/unsubscribe" || method === "thread/resume") &&
        preparingThreadId
      ) {
        threadVersion =
          this.#threadPreparationVersions.get(preparingThreadId) ?? 0;
        if (method === "thread/resume") replacingUnsubscribedThread = false;
      }
      assertCurrent();
      return result;
    };
    if (intent === "preserve" && options.threadId) {
      if (!this.#loadedThreads.has(options.threadId)) {
        const managedConfig =
          options.managedConfiguration && options.mcpServers !== undefined
            ? managedThreadConfiguration(
                options,
                await workspaceHasGitMetadata(options.cwd),
                true,
              )
            : undefined;
        const resumed = (await request("thread/resume", {
          threadId: options.threadId,
          ...(options.adoptImportedProvider
            ? {
                model: options.model.name,
                modelProvider: codexModelProviderName(options.provider),
                ...codexReasoningEffortParams(options.model),
              }
            : {}),
          ...(managedConfig ? { managedConfig } : {}),
        })) as ThreadResponse;
        if (resumed.thread.id !== options.threadId)
          throw new Error("Codex resumed a different thread than requested.");
        this.#loadedThreads.add(options.threadId);
        // A preserving load does not establish an applied Cantrip configuration.
      }
      if (options.managedConfiguration) {
        await this.applyManagedThreadConfiguration(
          options.threadId,
          options,
          assertCurrent,
          true,
        );
      }
      return options.threadId;
    }
    const structuredReadOnly = options.resultMode?.kind === "structured";
    const permissionKey = structuredReadOnly
      ? "cantrip:task-read-only"
      : options.permissionProfileId;
    const modelProvider = codexModelProviderName(options.provider);
    const mcpConfig =
      !structuredReadOnly && options.mcpServers
        ? codexMcpConfigOverride(options.mcpServers)
        : null;
    const threadConfig = {
      ...codexNativeSubagentConfigOverride(
        options.subagentDefaults ?? null,
        (options.executionProfile ?? "ide") === "ide",
      ),
      ...(mcpConfig ?? {}),
    };
    const threadConfigFingerprint = JSON.stringify(threadConfig);
    if (
      options.threadId &&
      this.#mcpConfigFingerprintsByThread.get(options.threadId) !==
        threadConfigFingerprint
    ) {
      this.#managedConfigApplications.delete(options.threadId);
    }
    const hasGitMetadata = await workspaceHasGitMetadata(options.cwd);
    assertCurrent();
    let threadId = options.threadId;
    if (
      threadId &&
      (!this.#loadedThreads.has(threadId) ||
        (!inheritManagedSecurity &&
          this.#permissionProfilesByThread.get(threadId) !== permissionKey) ||
        this.#mcpConfigFingerprintsByThread.get(threadId) !==
          threadConfigFingerprint)
    ) {
      const requestedThreadId = threadId;
      const startedAtMs = Date.now();
      workerLogger.event("debug", "Codex chat thread resume started", {
        event: "codex.thread.resume",
        subsystem: "codex",
        operation: "resume-chat-thread",
        status: "started",
        threadId: requestedThreadId,
        ...codexProviderLogContext(options.provider),
      });
      try {
        if (
          !options.managedConfiguration &&
          this.#loadedThreads.has(threadId) &&
          ((!inheritManagedSecurity &&
            this.#permissionProfilesByThread.get(threadId) !== permissionKey) ||
            this.#mcpConfigFingerprintsByThread.get(threadId) !==
              threadConfigFingerprint)
        ) {
          // Native resume inherits a subscribed Core's security and ignores
          // overrides. Retire the planning Core before restoring implementation
          // permissions, even when its MCP configuration did not change.
          // Once unsubscribe is attempted, an uncertain reply cannot justify
          // trusting the previous attachment or its configuration.
          assertCurrent();
          this.#loadedThreads.delete(threadId);
          this.#mcpConfigFingerprintsByThread.delete(threadId);
          this.#managedConfigApplications.delete(threadId);
          this.#permissionProfilesByThread.delete(threadId);
          this.#confirmedManagedPermissions.delete(threadId);
          replacingUnsubscribedThread = true;
          await request("thread/unsubscribe", { threadId });
        }
        const resumed = (await request("thread/resume", {
          threadId,
          ...(options.managedConfiguration && options.mcpServers !== undefined
            ? {
                managedConfig: managedThreadConfiguration(
                  options,
                  hasGitMetadata,
                ),
              }
            : {}),
          model: options.model.name,
          ...codexReasoningEffortParams(options.model),
          modelProvider,
          ...codexWorkspaceContext(options.cwd),
          ...(inheritManagedSecurity
            ? {}
            : codexChatThreadSecurityParams(
                options.permissionProfileId,
                this.permissionProfilesSupported(),
                structuredReadOnly,
              )),
          ...cantripChatThreadParams(
            hasGitMetadata,
            options.executionProfile ?? "ide",
            structuredReadOnly ? [] : options.mcpServers,
          ),
          config: threadConfig,
        })) as ThreadResponse;
        threadId = resumed.thread.id;
        if (threadId !== requestedThreadId)
          throw new Error("Codex resumed a different thread than requested.");
        this.#loadedThreads.add(threadId);
        if (!inheritManagedSecurity)
          this.#permissionProfilesByThread.set(threadId, permissionKey);
        this.#mcpConfigFingerprintsByThread.set(
          threadId,
          threadConfigFingerprint,
        );
        workerLogger.event("info", "Codex chat thread resumed", {
          event: "codex.thread.resume",
          subsystem: "codex",
          operation: "resume-chat-thread",
          status: "completed",
          threadId,
          durationMs: Date.now() - startedAtMs,
          ...codexProviderLogContext(options.provider),
        });
      } catch (error) {
        workerLogger.event("warn", "Codex chat thread resume failed", {
          event: "codex.thread.resume",
          subsystem: "codex",
          operation: "resume-chat-thread",
          status: "failed",
          reasonCode: "thread-resume-failed",
          threadId: requestedThreadId,
          durationMs: Date.now() - startedAtMs,
          error: workerLogError(error),
          ...codexProviderLogContext(options.provider),
        });
        throw error;
      }
    }
    if (!threadId && create) {
      const startedAtMs = Date.now();
      const started = (await request("thread/start", {
        ...(options.managedConfiguration && options.mcpServers !== undefined
          ? {
              managedConfig: managedThreadConfiguration(
                options,
                hasGitMetadata,
              ),
            }
          : {}),
        model: options.model.name,
        ...codexReasoningEffortParams(options.model),
        modelProvider,
        ...codexWorkspaceContext(options.cwd),
        ...codexChatThreadSecurityParams(
          options.permissionProfileId,
          this.permissionProfilesSupported(),
          structuredReadOnly,
        ),
        ...cantripChatThreadParams(
          hasGitMetadata,
          options.executionProfile ?? "ide",
          structuredReadOnly ? [] : options.mcpServers,
        ),
        config: threadConfig,
      })) as ThreadResponse;
      threadId = started.thread.id;
      await identify(threadId);
      this.#loadedThreads.add(threadId);
      this.#permissionProfilesByThread.set(threadId, permissionKey);
      this.#mcpConfigFingerprintsByThread.set(
        threadId,
        threadConfigFingerprint,
      );
      workerLogger.event("info", "Codex chat thread started", {
        event: "codex.thread.start",
        subsystem: "codex",
        operation: "start-chat-thread",
        status: "completed",
        threadId,
        durationMs: Date.now() - startedAtMs,
        ...codexProviderLogContext(options.provider),
      });
    }
    if (threadId && options.managedConfiguration) {
      await this.applyManagedThreadConfiguration(
        threadId,
        options,
        assertCurrent,
      );
    }
    return threadId;
  }

  private async applyManagedThreadConfiguration(
    threadId: string,
    options: Pick<RunAgentTurnOptions, "cwd" | "mcpServers"> & {
      executionGate?: PrepareManagedThreadOptions["executionGate"];
      canonicalHistory?: PrepareManagedThreadOptions["canonicalHistory"];
      executionProfile?: RunAgentTurnOptions["executionProfile"];
      subagentDefaults?: RuntimeSubagentDefaults | null;
    },
    assertCurrent: () => void,
    preserveSubagentSettings = false,
  ): Promise<void> {
    // Omitted material is observational, not an instruction to disable tools.
    if (options.mcpServers === undefined) return;
    const hasGitMetadata = await workspaceHasGitMetadata(options.cwd);
    assertCurrent();
    const config = managedThreadConfiguration(
      options,
      hasGitMetadata,
      preserveSubagentSettings,
    );
    const fingerprint = JSON.stringify(config);
    const previous = this.#managedConfigApplications.get(threadId);
    if (
      previous?.epoch === this.#preparationEpoch &&
      previous.fingerprint === fingerprint
    )
      return;
    this.#managedConfigApplications.delete(threadId);
    // Start/cold resume apply this overlay before native MCP initialization.
    // The same update path also replaces configuration on a shared live engine.
    // Native startup validates required servers on their actual connections;
    // a separate discovery catalog must not gate configuration or user input.
    const response = (await this.request("thread/managedConfig/update", {
      threadId,
      ...config,
    })) as { threadId: string; applied: boolean };
    assertCurrent();
    if (response.threadId !== threadId || response.applied !== true) {
      throw new Error(
        "Codex did not acknowledge the managed configuration for the requested thread.",
      );
    }
    this.#managedSecurityOwners.add(threadId);
    this.#managedThreadOverlays.set(threadId, {
      epoch: this.#preparationEpoch,
      options: structuredClone({
        mcpServers: options.mcpServers,
        executionProfile: options.executionProfile ?? "ide",
        subagentDefaults: options.subagentDefaults ?? null,
        ...(options.executionGate
          ? { executionGate: options.executionGate }
          : {}),
        ...(options.canonicalHistory === undefined
          ? {}
          : { canonicalHistory: options.canonicalHistory }),
      }),
    });
    this.#managedConfigApplications.set(threadId, {
      epoch: this.#preparationEpoch,
      fingerprint,
    });
  }

  private async loadAgentOperationThread(
    options: RunAgentOperationOptions,
  ): Promise<string> {
    const modelProvider = codexModelProviderName(options.provider);
    const mcpConfig = codexMcpConfigOverride(options.mcpServers);
    const mcpConfigFingerprint = JSON.stringify(mcpConfig);
    const profileKey = options.permissionProfileId
      ? `profile:${options.permissionProfileId}`
      : `sandbox:${options.mutationMode}:${options.networkAccess}`;
    const startedAtMs = Date.now();
    const started = (await this.request("thread/start", {
      model: options.model.name,
      ...codexReasoningEffortParams(options.model),
      modelProvider,
      ...codexWorkspaceContext(options.cwd),
      approvalPolicy: "never",
      ...this.agentOperationThreadPermissionParams(options),
      developerInstructions: options.developerInstructions,
      config: mcpConfig,
    })) as ThreadResponse;
    const threadId = started.thread.id;
    workerLogger.event("info", "Codex agent operation thread started", {
      event: "codex.thread.start",
      subsystem: "codex",
      operation: "start-agent-operation-thread",
      status: "completed",
      operationId: options.operationId,
      threadId,
      durationMs: Date.now() - startedAtMs,
      ...codexProviderLogContext(options.provider),
    });

    this.#loadedThreads.add(threadId);
    this.#permissionProfilesByThread.set(threadId, profileKey);
    this.#mcpConfigFingerprintsByThread.set(threadId, mcpConfigFingerprint);
    return threadId;
  }

  private hasActiveThread(threadId: string): boolean {
    return this.#executions.hasActiveThread(threadId);
  }

  /** Native root/child ownership for lifecycle cancellation, even before CUA is used. */
  ownsComputerUseThread(rootThreadId: string, threadId: string): boolean {
    return this.#executions.ownsComputerUseThread(rootThreadId, threadId);
  }

  /** Resolve an exact observed native turn without creating or rebinding one.
   * The caller separately supplies trusted worker/account/lane authority. */
  resolveComputerUseExecution(input: {
    chatId: string;
    threadId: string;
    turnId: string;
  }): CodexComputerUseExecution | null {
    return this.#executions.resolveComputerUseExecution(input);
  }

  private registerRootExecution(active: ActiveTurn): RootExecution {
    return this.#executions.registerRootExecution(active);
  }

  private reconcileSubagentExecution(
    active: ActiveTurn,
    executionCompletedAtMs: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    return this.#executions.reconcileSubagentExecution(
      active,
      executionCompletedAtMs,
      isCurrent,
    );
  }

  private settleDescendantsAtRootBoundary(
    execution: RootExecution,
    rootStatus: TurnCompletedParams["turn"]["status"],
    observedAtMs: number,
    diagnosticId: string | null,
  ): void {
    return this.#executions.settleDescendantsAtRootBoundary(
      execution,
      rootStatus,
      observedAtMs,
      diagnosticId,
    );
  }

  private bindTurnStartResponse(turnId: string, active: ActiveTurn): void {
    return this.#executions.bindTurnStartResponse(turnId, active);
  }

  private releaseActiveTurn(active: ActiveTurn, turnId?: string): boolean {
    return this.#executions.releaseActiveTurn(active, turnId);
  }

  private forgetThread(threadId: string): void {
    this.#threadPreparationVersions.set(
      threadId,
      (this.#threadPreparationVersions.get(threadId) ?? 0) + 1,
    );
    this.#loadedThreads.delete(threadId);
    this.#mcpConfigFingerprintsByThread.delete(threadId);
    this.#managedConfigApplications.delete(threadId);
    this.#managedThreadOverlays.delete(threadId);
    this.#permissionProfilesByThread.delete(threadId);
    this.#confirmedManagedPermissions.delete(threadId);
    this.#threadSettings.forget(threadId);
    this.#goals.delete(threadId);
  }

  private permissionProfilesSupported(): boolean {
    return Boolean(
      this.compatibility.initialize?.experimentalApi &&
      this.methodAvailable("permissionProfile/list"),
    );
  }

  private threadPermissionParams(permissionProfileId: string) {
    return codexThreadPermissionParams(
      permissionProfileId,
      this.permissionProfilesSupported(),
    );
  }

  private agentOperationThreadPermissionParams(
    options: RunAgentOperationOptions,
  ) {
    if (options.permissionProfileId && this.permissionProfilesSupported()) {
      return { permissions: options.permissionProfileId };
    }
    return {
      sandbox:
        options.mutationMode === "write"
          ? ("workspace-write" as const)
          : ("read-only" as const),
    };
  }

  private async collaborationMode(
    mode: PlanMode,
    model: RunAgentTurnOptions["model"],
  ): Promise<NativeCollaborationMode> {
    const response = (await this.request(
      "collaborationMode/list",
      {},
    )) as NativeCollaborationModeListResponse;
    const preset = response.data.find((candidate) => candidate.mode === mode);
    if (!preset) {
      throw new Error(`Codex does not advertise ${mode} collaboration mode.`);
    }
    return {
      mode,
      settings: {
        model: preset.model ?? model.name,
        reasoning_effort:
          preset.reasoning_effort ??
          (mode === "plan" ? "medium" : model.reasoningEffort),
        developer_instructions: null,
      },
    };
  }

  private async updatePlanModeOnThread(
    threadId: string,
    mode: PlanMode,
    model: RunAgentTurnOptions["model"],
    assertCurrent: () => void = () => {},
    preparation?: { signal?: AbortSignal },
  ): Promise<NativeCollaborationMode> {
    assertCurrent();
    const collaborationMode = await this.collaborationMode(mode, model);
    assertCurrent();
    if (this.#threadSettings.selectedPlanMode(threadId) !== mode) {
      if (preparation) {
        await this.applyPreparedNativeSettings(
          threadId,
          { collaborationMode },
          // Core resolves null developer instructions to the mode's default
          // instructions; compare the explicit selection fields we requested.
          (actual) =>
            actual.collaborationMode.mode === collaborationMode.mode &&
            actual.collaborationMode.settings.model ===
              collaborationMode.settings.model &&
            actual.collaborationMode.settings.reasoning_effort ===
              collaborationMode.settings.reasoning_effort,
          assertCurrent,
          preparation.signal,
        );
        return collaborationMode;
      }
      const operationId = randomUUID();
      await this.applyNativeThreadSettings(
        threadId,
        operationId,
        { collaborationMode },
        assertCurrent,
      );
    }
    return collaborationMode;
  }

  private async start(
    model: RunAgentTurnOptions["model"] | null,
    provider: RunAgentTurnOptions["provider"],
    subagentDefaults: RuntimeSubagentDefaults | null = null,
    _executionProfile: RunAgentTurnOptions["executionProfile"] = "ide",
  ): Promise<void> {
    const startedAtMs = Date.now();
    this.#appServerSessionId = randomUUID();
    await mkdir(this.codexHome, { recursive: true });
    const [runtimeProvider, managedInventory] = await Promise.all([
      this.resolveProvider ? this.resolveProvider(provider) : provider,
      this.loadManagedModelInventory(provider),
    ]);
    this.#runtimeIsZai = isZaiRuntimeProvider(runtimeProvider);
    if (runtimeProvider.apiKey) {
      this.#diagnosticSecrets.add(runtimeProvider.apiKey);
    }
    const externalChatGptLease =
      await this.resolveExternalChatGptLease(runtimeProvider);
    const providerConfiguration = codexProviderConfiguration(runtimeProvider);
    const modelCatalogPath = model
      ? await writeManagedCodexModelCatalog(
          this.dataDirectory,
          model,
          runtimeProvider,
          subagentDefaults?.model ?? null,
          managedInventory?.models ?? [],
        )
      : null;
    const child = this.launchCodex(
      this.codexBinary,
      [
        "app-server",
        "-c",
        'cli_auth_credentials_store="file"',
        ...(this.methodAvailable("thread/goal/get")
          ? ["-c", "features.goals=true"]
          : []),
        ...providerConfiguration.arguments.flatMap((argument) => [
          "-c",
          argument,
        ]),
        ...(modelCatalogPath
          ? ["-c", `model_catalog_json=${JSON.stringify(modelCatalogPath)}`]
          : []),
        // Keep effort off the process configuration so one route runtime owns
        // its threads across composer changes. Thread and turn requests carry
        // the selected effort explicitly.
        ...(model ? ["-c", `model=${JSON.stringify(model.name)}`] : []),
        "--listen",
        "ws://127.0.0.1:0",
      ],
      {
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome,
          CANTRIP_CODEX_USER_CONFIG_FILE: this.configurationHome
            ? path.join(this.configurationHome, "config.toml")
            : undefined,
          ...providerConfiguration.environment,
        },
      },
    );
    this.#child = child;
    this.#runtimeStartedAtMs = startedAtMs;
    const processRuntimeId = this.#runtimeId;
    const processStartedAtMs = startedAtMs;
    workerLogger.event("debug", "Codex app-server process launched", {
      event: "codex.runtime.process",
      subsystem: "codex",
      operation: "spawn",
      status: "started",
      runtimeId: processRuntimeId,
      processId: child.pid ?? null,
      catalogOnly: model === null,
      externalAccountLease: externalChatGptLease !== null,
      ...codexProviderLogContext(runtimeProvider),
    });

    const remoteUrl = await readCodexProcessEndpoint(child, {
      runtimeId: processRuntimeId,
      readableError: (line) =>
        readableCodexProviderError(line, {
          secrets: this.#diagnosticSecrets,
          zai: this.#runtimeIsZai,
        }),
    });
    this.#remoteUrl = remoteUrl;
    workerLogger.event("debug", "Codex app-server endpoint announced", {
      event: "codex.runtime.endpoint",
      subsystem: "codex",
      operation: "discover-endpoint",
      status: "completed",
      runtimeId: processRuntimeId,
      durationMs: Date.now() - startedAtMs,
    });
    const socket = await openCodexWebSocket(remoteUrl);
    this.#socket = socket;
    this.#nativeTransportGeneration = randomUUID();
    this.#managedModelInventoryProvider = provider;
    this.#managedModelInventory = managedInventory;
    this.#managedAttributionModels.clear();
    if (model) this.#managedAttributionModels.set(model.routeId, model);
    if (subagentDefaults && subagentDefaults.model.routeId !== model?.routeId)
      this.#managedAttributionModels.set(
        subagentDefaults.model.routeId,
        subagentDefaults.model,
      );
    this.#liveManagedModelCatalog.replace(
      this.#nativeTransportGeneration,
      [
        ...(model ? [model] : []),
        ...(subagentDefaults ? [subagentDefaults.model] : []),
      ],
      provider.kind,
      managedInventory?.models ?? [],
    );
    this.#historyObservations.replace(this.#nativeTransportGeneration);
    workerLogger.event("debug", "Codex app-server transport connected", {
      event: "codex.runtime.transport",
      subsystem: "codex",
      operation: "connect-websocket",
      status: "connected",
      runtimeId: processRuntimeId,
      durationMs: Date.now() - startedAtMs,
    });
    socket.on("message", (data: RawData) => {
      if (this.#socket === socket) this.handleSocketMessage(data);
    });
    socket.on("error", (error) => {
      if (this.#socket === socket) this.handleExit(error);
    });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      workerLogger.event("warn", "Codex app-server transport closed", {
        event: "codex.runtime.transport",
        subsystem: "codex",
        operation: "connect-websocket",
        status: "disconnected",
        runtimeId: processRuntimeId,
        durationMs: Date.now() - processStartedAtMs,
        counts: {
          activeTurns: this.#executions.activeTurns.size,
          pendingRequests: this.#rpcRequests.pendingCount,
        },
      });
      this.handleExit(new Error("Codex app-server WebSocket closed."));
      this.#socket = null;
      this.#remoteUrl = null;
      this.#runtimeId = null;
      this.#runtimeStartedAtMs = null;
      this.#authRecovery.setSession(null);
      this.#diagnosticSecrets.clear();
      this.#runtimeIsZai = false;
      this.#starting = null;
      this.#loadedThreads.clear();
      this.#managedHistoryImports.clear();
      this.#mcpConfigFingerprintsByThread.clear();
      this.#managedConfigApplications.clear();
      this.#managedThreadOverlays.clear();
      this.#permissionProfilesByThread.clear();
      this.#confirmedManagedPermissions.clear();
      this.#managedSecurityOwners.clear();
      this.#threadSettings.clear();
      this.#externalImportStatuses.clear();
      this.#externalTurnBaselines.clear();
      this.#externalThreadChanges.clear();
      this.#mcpOauthStatuses.clear();
      this.#goals.clear();
      this.#skillRoots = [];
      this.#child?.kill("SIGINT");
      this.#child = null;
    });
    child.once("exit", (code, signal) => {
      if (this.#child !== child) return;
      workerLogger.event(
        code === 0 || signal === "SIGINT" || signal === "SIGTERM"
          ? "info"
          : "error",
        "Codex app-server process exited",
        {
          event: "codex.runtime.process",
          subsystem: "codex",
          operation: "spawn",
          status:
            code === 0 || signal === "SIGINT" || signal === "SIGTERM"
              ? "stopped"
              : "failed",
          runtimeId: processRuntimeId,
          exitCode: code,
          signal,
          durationMs: Date.now() - processStartedAtMs,
          counts: {
            activeTurns: this.#executions.activeTurns.size,
            pendingRequests: this.#rpcRequests.pendingCount,
          },
        },
      );
      this.handleExit(
        new Error(
          `Codex app-server exited (${signal ?? `code ${String(code)}`}).`,
        ),
      );
      this.#child = null;
      this.#socket = null;
      this.#remoteUrl = null;
      this.#runtimeId = null;
      this.#runtimeStartedAtMs = null;
      this.#authRecovery.setSession(null);
      this.#diagnosticSecrets.clear();
      this.#runtimeIsZai = false;
      this.#starting = null;
      this.#loadedThreads.clear();
      this.#managedHistoryImports.clear();
      this.#mcpConfigFingerprintsByThread.clear();
      this.#managedConfigApplications.clear();
      this.#managedThreadOverlays.clear();
      this.#permissionProfilesByThread.clear();
      this.#confirmedManagedPermissions.clear();
      this.#managedSecurityOwners.clear();
      this.#externalImportStatuses.clear();
      this.#externalTurnBaselines.clear();
      this.#externalThreadChanges.clear();
      this.#mcpOauthStatuses.clear();
      this.#skillRoots = [];
    });

    await this.request("initialize", {
      clientInfo: { name: "cantrip", title: "Cantrip", version: "0.0.0" },
      capabilities: {
        experimentalApi:
          this.compatibility.initialize?.experimentalApi ?? false,
        mcpServerOpenaiFormElicitation: true,
        requestAttestation: false,
      },
    });
    this.send({ method: "initialized", params: {} });
    if (
      this.globalSkillRoots.length > 0 &&
      this.methodAvailable("skills/extraRoots/set")
    ) {
      await this.request("skills/extraRoots/set", {
        extraRoots: this.effectiveSkillRoots(),
      });
    }
    if (externalChatGptLease) {
      this.#diagnosticSecrets.add(externalChatGptLease.accessToken);
      const result = (await this.request(
        "account/login/start",
        chatGptExternalLoginParams(runtimeProvider, externalChatGptLease),
      )) as { type?: unknown };
      if (result.type !== "chatgptAuthTokens") {
        throw new Error("Codex rejected portable ChatGPT authentication.");
      }
      this.#authRecovery.setSession(
        chatGptExternalAuthSession(runtimeProvider, externalChatGptLease),
      );
    }
    workerLogger.event("info", "Codex app-server ready", {
      event: "codex.runtime.lifecycle",
      subsystem: "codex",
      operation: model ? "start" : "start-catalog",
      status: "ready",
      runtimeId: this.#runtimeId,
      durationMs: Date.now() - startedAtMs,
      catalogOnly: model === null,
      codexVersion: this.compatibility.version?.raw ?? null,
      ...codexProviderLogContext(runtimeProvider),
    });
  }

  private async resolveExternalChatGptLease(
    provider: RuntimeProvider,
  ): Promise<ProviderAccessTokenLease | null> {
    if (
      provider.kind !== "chatgpt" ||
      !provider.accountId ||
      !this.providerAccessTokens
    ) {
      return null;
    }
    let lease: ProviderAccessTokenLease;
    try {
      lease = await this.providerAccessTokens.get(
        provider.id,
        provider.accountId,
      );
    } catch (error) {
      if (
        error instanceof ProviderAccessTokenRequestError &&
        (error.status === 404 ||
          (error.code && LEGACY_CHATGPT_FALLBACK_CODES.has(error.code)))
      ) {
        return null;
      }
      if (error instanceof ProviderAccessTokenRequestError) throw error;
      throw new Error(
        "Portable ChatGPT authentication could not obtain an access lease.",
      );
    }
    const capabilityError = chatGptExternalAuthCapabilityError(
      this.compatibility,
    );
    if (capabilityError) throw new Error(capabilityError);
    chatGptExternalAuthSession(provider, lease);
    return lease;
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = CODEX_RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.compatibility.methods[method] === "unavailable") {
      return Promise.reject(
        new Error(
          `Codex app-server method ${method} is unavailable in ${this.compatibility.version?.raw ?? "the installed runtime"}.`,
        ),
      );
    }
    return this.#rpcRequests.request(method, params, timeoutMs);
  }

  private methodAvailable(method: string): boolean {
    return this.compatibility.methods[method] === "available";
  }

  private send(message: RpcMessage): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server is not writable.");
    }
    this.#socket.send(JSON.stringify(message));
  }

  private handleSocketMessage(data: RawData): void {
    try {
      this.handleMessage(data);
    } catch {
      this.recordDiagnostic(
        {
          at: new Date().toISOString(),
          direction: "from-runtime",
          kind: "malformed",
          method: null,
          payload: data.toString(),
        },
        "Invalid App Server payload",
      );
    }
  }

  private handleMessage(data: RawData): void {
    const raw = data.toString();
    const message = parseCodexRpcMessage(raw);
    if (!message) {
      this.recordDiagnostic(
        {
          at: new Date().toISOString(),
          direction: "from-runtime",
          kind: "malformed",
          method: null,
          payload: raw,
        },
        "Malformed App Server message",
      );
      return;
    }

    const diagnosticPayload = this.#rpcRequests.diagnosticPayload(message);
    const diagnosticId = this.recordDiagnostic({
      at: new Date().toISOString(),
      direction: "from-runtime",
      kind: "message",
      method: typeof message.method === "string" ? message.method : null,
      payload: diagnosticPayload,
    });

    if (this.#rpcRequests.handleResponse(message, diagnosticPayload)) return;

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message).catch((error) => {
        this.recordDiagnostic(
          {
            at: new Date().toISOString(),
            direction: "from-runtime",
            kind: "unsupported-request",
            method: message.method ?? null,
            payload: message.params,
          },
          `Failed App Server request ${message.method ?? "<missing method>"}: ${error instanceof Error ? error.message : String(error)}`,
        );
        try {
          this.send({
            id: message.id,
            error: {
              code: -32_602,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } catch {
          // The App Server connection may already be closed.
        }
      });
      return;
    }

    let historyParams = message.params;
    let startedTarget: ReturnType<
      CodexExecutionOwnership["notificationTarget"]
    > = null;
    if (message.method === "turn/started") {
      const params = message.params as TurnStartedParams;
      this.#executions.observeComputerUseTurnStart(
        params.threadId,
        params.turn.id,
      );
      startedTarget = this.#executions.notificationTarget(
        params.threadId,
        params.turn.id,
        true,
      );
      const target = startedTarget;
      const initial = nativeInitialTurnSettingsSchema.safeParse(
        params.initialSettings,
      );
      const inventory = this.#managedModelInventory;
      if (target) {
        const child = this.#managedThreadOverlays.get(target.active.threadId)
          ?.options.subagentDefaults?.model;
        const anchor = target.isRoot
          ? target.active.model
          : (child ?? target.active.model);
        const selection =
          initial.success &&
          inventory &&
          this.#managedModelInventoryProvider &&
          initial.data.modelProvider ===
            codexModelProviderName(this.#managedModelInventoryProvider)
            ? this.getManagedModelAttribution(initial.data.model, {
                workerId: inventory.workerId,
                providerAccountId: inventory.providerAccountId,
                modelRouteId: anchor.routeId,
              })
            : { status: "unavailable" as const };
        if (target.state.nativeModelAttribution?.turnId !== params.turn.id)
          target.state.nativeModelAttribution = {
            threadId: params.threadId,
            turnId: params.turn.id,
            isRoot: target.isRoot,
            selection,
            reasoningEffort: initial.success
              ? (initial.data.effectiveReasoningEffort ??
                initial.data.reasoningEffort)
              : null,
          };
        historyParams = {
          ...params,
          cantripModelAttribution: target.state.nativeModelAttribution,
        };
      }
    }
    if (typeof message.method === "string")
      this.#historyObservations.notification(
        message.method,
        historyParams,
        message.historyCursor,
      );

    if (message.method === "thread/settings/updated") {
      try {
        const { threadId } = this.#threadSettings.observe(message.params);
        this.observeExternalThreadChange(threadId, "plan");
      } catch {
        this.recordDiagnostic(
          {
            at: new Date().toISOString(),
            direction: "from-runtime",
            kind: "malformed",
            method: message.method,
            payload: message.params,
          },
          "Malformed native settings notification; confirmed settings were retained.",
        );
      }
      return;
    }

    if (message.method === "thread/started") {
      const params = message.params as ThreadStartedParams;
      const metadata = childThreadMetadataFromNotification(params);
      if (metadata) {
        const state = this.#executions.associateAgentThread(metadata);
        if (state) {
          this.#executions.updateAgentStatus(
            state,
            nativeAgentRuntimeStatus(params.thread.status),
          );
          this.#executions.emitAgentCommunication({
            diagnosticId,
            kind: "spawned",
            milestoneId: "spawn",
            sourceMethod: message.method,
            state,
            status: "running",
            turnId: state.agentScope?.rootTurnId ?? null,
          });
        }
      }
      return;
    }

    if (message.method === "thread/closed") {
      const params = message.params as { threadId: string };
      this.forgetThread(params.threadId);
      this.#executions.abortComputerUseThread(params.threadId);
      return;
    }

    if (message.method === "thread/status/changed") {
      const params = message.params as ThreadStatusChangedParams;
      if (params.status.type === "notLoaded")
        this.forgetThread(params.threadId);
      // These native events describe the thread itself (no turnId). Ordinary
      // idle/active status and historical item status do not revoke authority.
      if (
        params.status.type === "notLoaded" ||
        params.status.type === "systemError"
      )
        // systemError precedes the actual typed turn/completed failure (for
        // example serverOverloaded). Revoke CUA now, but preserve that result
        // and its exact execution identity for retry/terminal handling.
        this.#executions.abortComputerUseThread(
          params.threadId,
          params.status.type === "notLoaded",
        );
      const execution = this.#executions.rootExecutionsByThread.get(
        params.threadId,
      );
      const state = execution?.agents.get(params.threadId);
      if (state) {
        this.#executions.updateAgentStatus(
          state,
          nativeAgentRuntimeStatus(params.status),
        );
        this.#executions.emitAgentCommunication({
          diagnosticId,
          kind: "statusChanged",
          sourceMethod: message.method,
          state,
          status: state.status === "failed" ? "failed" : "completed",
        });
      }
      return;
    }

    if (message.method === "turn/started") {
      const params = message.params as TurnStartedParams;

      const target = startedTarget;
      if (target) {
        const initial = nativeInitialTurnSettingsSchema.safeParse(
          params.initialSettings,
        );
        target.state.initialSettings = initial.success
          ? initial.data
          : undefined;
        emitTurnActivity(
          target.state,
          turnSummaryActivity(
            {
              id: params.turn.id,
              status: "inProgress",
              startedAt: params.turn.startedAt ?? null,
              completedAt: null,
              durationMs: null,
            },
            eventCorrelation(
              message.method,
              diagnosticId,
              params.threadId,
              params.turn.id,
              null,
            ),
            target.state.initialSettings,
          ),
        );
      } else {
        this.observeExternalThreadChange(params.threadId, "turn");
      }
      return;
    }

    if (message.method === "turn/plan/updated") {
      const params = message.params as TurnPlanUpdatedParams;
      const target = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      );
      if (target) {
        if (target.isRoot) {
          target.active.onPlan?.({
            explanation: params.explanation,
            steps: params.plan,
            turnId: params.turnId,
          });
        }
        emitTurnActivity(
          target.state,
          agentActivitySchema.parse({
            type: "plan",
            id: `turn:${params.turnId}:plan`,
            status: "completed",
            text: "",
            explanation: boundedText(params.explanation),
            steps: params.plan.slice(0, 100).map((step) => ({
              ...step,
              step: boundedText(step.step) ?? "",
            })),
            correlation: eventCorrelation(
              message.method,
              diagnosticId,
              params.threadId,
              params.turnId,
              null,
            ),
          }),
        );
      } else {
        this.observeExternalThreadChange(params.threadId, "turn");
      }
      return;
    }

    if (message.method === "serverRequest/resolved") {
      const params = message.params as ServerRequestResolvedParams;
      this.#interactions.resolveServerRequest(params);
      return;
    }

    if (message.method === "mcpServer/oauthLogin/completed") {
      const status = parseMcpOauthCompletion(message.params);
      this.rememberMcpOauthStatus(status);
      return;
    }

    if (
      message.method === "externalAgentConfig/import/progress" ||
      message.method === "externalAgentConfig/import/completed"
    ) {
      const status = parseExternalImportStatus(
        message.params,
        message.method.endsWith("/completed") ? "completed" : "pending",
      );
      this.rememberExternalImportStatus(status);
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const params = message.params as AgentMessageDeltaParams;
      const state = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      if (state) {
        state.delta += params.delta;
        appendStreamingAgentMessageDelta(
          state,
          params.itemId,
          params.delta,
          eventCorrelation(
            message.method,
            diagnosticId,
            params.threadId,
            params.turnId,
            params.itemId,
          ),
        );
      }
      return;
    }

    if (message.method === "item/reasoning/summaryPartAdded") {
      const params = message.params as ReasoningSummaryPartAddedParams;
      const state = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      if (state && params.summaryIndex >= 0 && params.summaryIndex < 100) {
        const summary = state.reasoningSummaries.get(params.itemId) ?? [];
        while (summary.length <= params.summaryIndex) summary.push("");
        state.reasoningSummaries.set(params.itemId, summary);
      }
      return;
    }

    if (message.method === "item/reasoning/summaryTextDelta") {
      const params = message.params as ReasoningSummaryTextDeltaParams;
      const state = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      if (state && params.summaryIndex >= 0 && params.summaryIndex < 100) {
        const observedAtMs = Date.now();
        const startedAtMs =
          state.itemStartedAtMs.get(params.itemId) ?? observedAtMs;
        boundedMapSet(
          state.itemStartedAtMs,
          params.itemId,
          startedAtMs,
          MAX_TURN_ITEM_TIMESTAMPS,
        );
        const summary = state.reasoningSummaries.get(params.itemId) ?? [];
        while (summary.length <= params.summaryIndex) summary.push("");
        summary[params.summaryIndex] =
          boundedText(`${summary[params.summaryIndex] ?? ""}${params.delta}`) ??
          "";
        state.reasoningSummaries.set(params.itemId, summary);
        emitTurnActivity(
          state,
          agentActivitySchema.parse({
            type: "reasoning",
            id: params.itemId,
            status: "running",
            summary: summary.map((part) => part.trim()).filter(Boolean),
            startedAtMs,
            updatedAtMs: observedAtMs,
            completedAtMs: null,
            correlation: eventCorrelation(
              message.method,
              diagnosticId,
              params.threadId,
              params.turnId,
              params.itemId,
            ),
          }),
        );
      }
      return;
    }

    if (message.method === "item/commandExecution/outputDelta") {
      const params = message.params as CommandExecutionOutputDeltaParams;
      const state = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      if (!state || state.completedCommandIds.has(params.itemId)) return;
      const observedAtMs = Date.now();
      const correlation = eventCorrelation(
        message.method,
        diagnosticId,
        params.threadId,
        params.turnId,
        params.itemId,
      );
      const existing = state.commandTelemetry.get(params.itemId);
      const next = commandTelemetryFromDelta(
        existing ?? null,
        params.delta,
        observedAtMs,
      );
      const telemetry: ActiveCommandTelemetry = existing ?? {
        correlation,
        flushTimer: null,
        item: null,
        ...next,
      };
      telemetry.output = next.output;
      telemetry.truncated = next.truncated;
      telemetry.startedAtMs = next.startedAtMs;
      telemetry.updatedAtMs = next.updatedAtMs;
      telemetry.correlation = correlation;
      boundedCommandTelemetrySet(state, params.itemId, telemetry);
      scheduleCommandTelemetry(state, telemetry);
      return;
    }

    if (message.method === "item/fileChange/patchUpdated") {
      const params = message.params as FileChangePatchUpdatedParams;
      const state = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      if (!state) return;
      const observedAtMs = Date.now();
      const startedAtMs =
        state.fileStartedAtMs.get(params.itemId) ?? observedAtMs;
      boundedMapSet(
        state.itemStartedAtMs,
        params.itemId,
        startedAtMs,
        MAX_TURN_ITEM_TIMESTAMPS,
      );
      boundedMapSet(
        state.fileStartedAtMs,
        params.itemId,
        startedAtMs,
        MAX_TURN_FILE_ITEMS,
      );
      const activity = normalizeCodexThreadItem(
        {
          type: "fileChange",
          id: params.itemId,
          status: "inProgress",
          changes: params.changes,
        },
        state.cwd,
        "started",
        eventCorrelation(
          message.method,
          diagnosticId,
          params.threadId,
          params.turnId,
          params.itemId,
        ),
        {
          captureRaw: state.captureProtectedDiagnostics,
          startedAtMs,
          updatedAtMs: observedAtMs,
          completedAtMs: null,
        },
      );
      if (activity) emitTurnActivity(state, activity);
      return;
    }

    if (
      message.method === "thread/managedExecution/requested" ||
      message.method === "thread/managedExecution/declined"
    ) {
      const base = z.object({
        threadId: z.string().min(1),
        runnerGeneration: z.string().min(1),
        attemptId: z.string().min(1),
        turnId: z.string().min(1),
      });
      const parsed = base.safeParse(message.params);
      if (!parsed.success) return;
      const entry = this.#managedExecutionGateHandlers.get(
        parsed.data.runnerGeneration,
      );
      const transport = this.transportGeneration;
      if (
        !transport ||
        (entry?.transportGeneration && entry.transportGeneration !== transport)
      )
        return;
      if (entry) entry.transportGeneration ??= transport;
      if (message.method === "thread/managedExecution/requested") {
        const request = base
          .extend({
            trigger: z.enum(["goal", "queue"]),
            goalEpoch: z.string().min(1).optional(),
            input: z.record(z.string(), z.unknown()),
          })
          .safeParse(message.params);
        if (!request.success) {
          entry?.handler.failed(request.error);
          void this.resolveManagedExecution(
            { ...parsed.data, operationGeneration: null, allow: false },
            transport,
          ).catch((error) => entry?.handler.failed(error));
          return;
        }
        if (entry) {
          if (entry.observedAttempts.has(request.data.attemptId)) return;
          entry.observedAttempts.add(request.data.attemptId);
          if (entry.observedAttempts.size > 1000)
            entry.observedAttempts.delete(
              entry.observedAttempts.values().next().value!,
            );
        }
        const task = entry
          ? Promise.resolve().then(() => {
              entry.controller.signal.throwIfAborted();
              return entry.handler.requested(
                request.data,
                entry.controller.signal,
              );
            })
          : Promise.reject(
              new Error("No managed runner owns this native attempt."),
            );
        void task.catch(async (error) => {
          entry?.handler.failed(error);
          try {
            await this.resolveManagedExecution(
              { ...parsed.data, operationGeneration: null, allow: false },
              transport,
            );
          } catch (failure) {
            entry?.handler.failed(failure);
          }
        });
      } else if (entry) {
        const declined = base
          .extend({
            operationGeneration: z.string().nullable(),
            reason: z.string(),
          })
          .safeParse(message.params);
        if (!declined.success) {
          entry.handler.failed(declined.error);
          return;
        }
        void Promise.resolve()
          .then(() => entry.handler.declined(declined.data))
          .catch((error) => entry.handler.failed(error));
      }
      return;
    }

    if (message.method === "thread/goal/updated") {
      const params = message.params as ThreadGoalUpdatedParams;
      this.#goals.set(params.threadId, threadGoalSchema.parse(params.goal));
      this.observeExternalThreadChange(params.threadId, "goal");
      return;
    }

    if (message.method === "thread/goal/cleared") {
      const params = message.params as ThreadGoalClearedParams;
      this.#goals.delete(params.threadId);
      this.observeExternalThreadChange(params.threadId, "goal");
      return;
    }

    if (message.method === "item/started") {
      const params = message.params as ItemLifecycleParams;
      this.#executions.associateAgentsFromItem(
        params.item,
        params.threadId,
        params.turnId,
        message.method,
        diagnosticId,
      );
      const state = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      if (
        state &&
        params.item.type === "agentMessage" &&
        state.streamingAgentMessage &&
        state.streamingAgentMessage.id !== params.item.id
      ) {
        settleStreamingAgentMessage(state, false);
      }
      if (state && params.item.type === "agentMessage") {
        const correlation = eventCorrelation(
          message.method,
          diagnosticId,
          params.threadId,
          params.turnId,
          params.item.id,
        );
        if (state.streamingAgentMessage?.id === params.item.id) {
          state.streamingAgentMessage.correlation = correlation;
          state.streamingAgentMessage.phase = params.item.phase ?? null;
        } else {
          state.streamingAgentMessage = {
            correlation,
            flushTimer: null,
            id: params.item.id,
            lastEmittedText: "",
            phase: params.item.phase ?? null,
            text: "",
          };
        }
      }
      if (state && params.item.type !== "agentMessage") {
        flushActiveAgentMessage(state, false);
        const observedAtMs = Date.now();
        const startedAtMs = params.startedAtMs ?? observedAtMs;
        boundedMapSet(
          state.itemStartedAtMs,
          params.item.id,
          startedAtMs,
          MAX_TURN_ITEM_TIMESTAMPS,
        );
        const correlation = eventCorrelation(
          message.method,
          diagnosticId,
          params.threadId,
          params.turnId,
          params.item.id,
        );
        if (params.item.type === "reasoning") {
          state.reasoningSummaries.set(params.item.id, params.item.summary);
        }
        if (params.item.type === "commandExecution") {
          const existing = state.commandTelemetry.get(params.item.id);
          const initial = commandTelemetryFromStart(
            existing ?? null,
            params.item.aggregatedOutput,
            startedAtMs,
            observedAtMs,
          );
          const telemetry: ActiveCommandTelemetry = existing ?? {
            correlation,
            flushTimer: null,
            item: params.item,
            ...initial,
          };
          telemetry.item = params.item;
          telemetry.output = initial.output;
          telemetry.truncated = initial.truncated;
          telemetry.startedAtMs = initial.startedAtMs;
          telemetry.updatedAtMs = initial.updatedAtMs;
          telemetry.correlation = correlation;
          boundedCommandTelemetrySet(state, params.item.id, telemetry);
          emitCommandTelemetry(state, telemetry);
          return;
        }
        if (params.item.type === "fileChange") {
          boundedMapSet(
            state.fileStartedAtMs,
            params.item.id,
            startedAtMs,
            MAX_TURN_FILE_ITEMS,
          );
          if (params.item.changes.length === 0) return;
        }
        const activity = normalizeCodexThreadItem(
          params.item,
          state.cwd,
          "started",
          correlation,
          {
            captureRaw: state.captureProtectedDiagnostics,
            startedAtMs,
            updatedAtMs: observedAtMs,
            completedAtMs: null,
          },
        );
        if (activity) emitTurnActivity(state, activity);
      }
      return;
    }

    if (message.method === "item/completed") {
      const params = message.params as ItemLifecycleParams;
      this.#executions.associateAgentsFromItem(
        params.item,
        params.threadId,
        params.turnId,
        message.method,
        diagnosticId,
      );
      const state = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      const observedAtMs = params.completedAtMs ?? Date.now();
      const itemStartedAtMs =
        state && params.item.type !== "agentMessage"
          ? (params.startedAtMs ??
            state.itemStartedAtMs.get(params.item.id) ??
            null)
          : null;
      if (state && params.item.type !== "agentMessage") {
        state.itemStartedAtMs.delete(params.item.id);
      }
      if (
        state &&
        ((params.item.type === "agentMessage" &&
          params.item.phase !== "commentary") ||
          params.item.type === "plan") &&
        typeof params.item.text === "string"
      ) {
        state.finalText = params.item.text;
      }
      if (state && params.item.type === "agentMessage") {
        if (state.streamingAgentMessage?.id === params.item.id) {
          state.streamingAgentMessage.phase = params.item.phase ?? null;
          emitStreamingAgentMessage(state);
        } else if (state.streamingAgentMessage) {
          settleStreamingAgentMessage(state, false);
        }
        const normalized = normalizeAgentMessage(
          params.item,
          eventCorrelation(
            message.method,
            diagnosticId,
            params.threadId,
            params.turnId,
            params.item.id,
          ),
        );
        if (normalized) {
          publishStagedAgentMessages(
            state,
            stageAgentMessage(state.pendingAgentMessage, normalized),
          );
          if (normalized.phase === "commentary") {
            clearStreamingAgentMessage(state);
          }
        }
      } else if (state && params.item.type === "commandExecution") {
        flushActiveAgentMessage(state, false);
        const correlation = eventCorrelation(
          message.method,
          diagnosticId,
          params.threadId,
          params.turnId,
          params.item.id,
        );
        const existing = state.commandTelemetry.get(params.item.id);
        if (existing) clearCommandFlush(existing);
        const completed = commandTelemetryFromCompletion(
          existing ?? null,
          params.item.aggregatedOutput,
          params.item.durationMs,
          observedAtMs,
        );
        const telemetry: ActiveCommandTelemetry = existing ?? {
          correlation,
          flushTimer: null,
          item: params.item,
          ...completed,
        };
        telemetry.item = params.item;
        telemetry.output = completed.output;
        telemetry.truncated = completed.truncated;
        telemetry.startedAtMs =
          existing?.startedAtMs ?? itemStartedAtMs ?? completed.startedAtMs;
        telemetry.updatedAtMs = completed.updatedAtMs;
        telemetry.correlation = correlation;
        emitCommandTelemetry(state, telemetry, observedAtMs);
        state.commandTelemetry.delete(params.item.id);
        rememberCompletedCommand(state, params.item.id);
      } else if (state && params.item.type === "fileChange") {
        flushActiveAgentMessage(state, false);
        const startedAtMs =
          itemStartedAtMs ?? state.fileStartedAtMs.get(params.item.id) ?? null;
        state.fileStartedAtMs.delete(params.item.id);
        const activity = normalizeCodexThreadItem(
          params.item,
          state.cwd,
          "completed",
          eventCorrelation(
            message.method,
            diagnosticId,
            params.threadId,
            params.turnId,
            params.item.id,
          ),
          {
            captureRaw: state.captureProtectedDiagnostics,
            ...completedActivityTimestamps(startedAtMs, observedAtMs),
          },
        );
        if (activity) emitTurnActivity(state, activity);
      } else if (state) {
        flushActiveAgentMessage(state, false);
        const activity = normalizeCodexThreadItem(
          params.item,
          state.cwd,
          "completed",
          eventCorrelation(
            message.method,
            diagnosticId,
            params.threadId,
            params.turnId,
            params.item.id,
          ),
          {
            captureRaw: state.captureProtectedDiagnostics,
            ...completedActivityTimestamps(itemStartedAtMs, observedAtMs),
          },
        );
        if (activity) emitTurnActivity(state, activity);
        if (params.item.type === "reasoning") {
          state.reasoningSummaries.delete(params.item.id);
        }
      }
      return;
    }

    if (message.method === "turn/diff/updated") {
      const params = message.params as TurnDiffUpdatedParams;
      const state = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      if (state) {
        state.diffChanges = changedFiles(params.diff, Date.now());
        emitFileActivity(
          state,
          params.turnId,
          "running",
          eventCorrelation(
            message.method,
            diagnosticId,
            params.threadId,
            params.turnId,
            null,
          ),
        );
      }
      return;
    }

    if (message.method === "thread/tokenUsage/updated") {
      const params = message.params as ThreadTokenUsageUpdatedParams;
      const target = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      );
      if (target) {
        const { active, state } = target;
        state.latestUsage = params.tokenUsage.last;
        if (target.isRoot) {
          active.contextUsage = params.tokenUsage;
          active.contextUsageUpdatedAtMs = Date.now();
        }
        emitTurnActivity(
          state,
          normalizeTokenUsageActivity(
            params,
            eventCorrelation(
              message.method,
              diagnosticId,
              params.threadId,
              params.turnId,
              null,
            ),
          ),
        );
      }
      return;
    }

    if (message.method === "account/rateLimits/updated") {
      const params = message.params as AccountRateLimitsUpdatedParams;
      for (const [turnId, active] of this.#executions.activeTurns) {
        emitTurnActivity(
          active,
          normalizeRateLimitActivity(
            params,
            turnId,
            eventCorrelation(
              message.method,
              diagnosticId,
              active.threadId,
              turnId,
              null,
            ),
          ),
        );
      }
      return;
    }

    if (message.method === "warning") {
      const params = message.params as WarningParams;
      if (params.threadId) {
        const execution = this.#executions.rootExecutionsByThread.get(
          params.threadId,
        );
        const state =
          execution?.agents.get(params.threadId) ?? execution?.active;
        const turnId =
          execution?.agents.get(params.threadId)?.currentTurnId ??
          execution?.rootTurnId;
        if (state && turnId) {
          emitTurnActivity(
            state,
            normalizeNoticeActivity({
              level: "warning",
              message: readableCodexProviderError(params.message, {
                secrets: this.#diagnosticSecrets,
              }),
              correlation: eventCorrelation(
                message.method,
                diagnosticId,
                params.threadId,
                turnId,
                null,
              ),
            }),
          );
        }
        return;
      }
      for (const [turnId, active] of this.#executions.activeTurns) {
        emitTurnActivity(
          active,
          normalizeNoticeActivity({
            level: "warning",
            message: readableCodexProviderError(params.message, {
              secrets: this.#diagnosticSecrets,
            }),
            correlation: eventCorrelation(
              message.method,
              diagnosticId,
              active.threadId,
              turnId,
              null,
            ),
          }),
        );
      }
      return;
    }

    if (message.method === "configWarning") {
      const params = message.params as ConfigWarningParams;
      for (const [turnId, active] of this.#executions.activeTurns) {
        emitTurnActivity(
          active,
          normalizeNoticeActivity({
            level: "warning",
            message: readableCodexProviderError(params.summary, {
              secrets: this.#diagnosticSecrets,
            }),
            details:
              [params.details, params.path]
                .filter((value): value is string => Boolean(value))
                .map((value) =>
                  readableCodexProviderError(value, {
                    secrets: this.#diagnosticSecrets,
                  }),
                )
                .join("\n") || null,
            correlation: eventCorrelation(
              message.method,
              diagnosticId,
              active.threadId,
              turnId,
              null,
            ),
          }),
        );
      }
      return;
    }

    if (message.method === "error") {
      if (this.#threadSettings.observeError(message.params)) return;
      const params = message.params as ErrorNotificationParams;
      const state = this.#executions.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      if (state) {
        emitTurnActivity(
          state,
          normalizeNoticeActivity({
            level: "error",
            message: readableCodexProviderError(params.error.message, {
              secrets: this.#diagnosticSecrets,
              zai: this.#runtimeIsZai,
            }),
            details: params.error.additionalDetails
              ? readableCodexProviderError(params.error.additionalDetails, {
                  secrets: this.#diagnosticSecrets,
                })
              : null,
            reasonCode: codexErrorReasonCode(params.error.codexErrorInfo),
            retry: params.willRetry
              ? {
                  owner: "codex",
                  attempt: null,
                  maxAttempts: null,
                  nextAttemptAtMs: null,
                }
              : null,
            willRetry: params.willRetry,
            correlation: eventCorrelation(
              message.method,
              diagnosticId,
              params.threadId,
              params.turnId,
              null,
            ),
          }),
        );
      }
      return;
    }

    if (message.method === "turn/completed") {
      const params = message.params as TurnCompletedParams;
      const execution = this.#executions.rootExecutionsByThread.get(
        params.threadId,
      );
      const lifetime =
        params.threadId === execution?.rootThreadId
          ? execution.computerUseLifetime
          : (execution?.agents.get(params.threadId)?.computerUseLifetime ??
            this.#executions.unassociatedComputerUseTurn(params.threadId)
              ?.lifetime);
      if (execution?.active.admission && !lifetime?.turnId) return;
      // Late completion of A must not release the still-running B execution.
      // Only real turn starts advance this bounded lifetime, not telemetry.
      if (lifetime?.turnId && lifetime.turnId !== params.turn.id) return;
      // End before resolving UI telemetry: that association may still contain
      // an older turn, and native goals retain their surrounding execution.
      if (execution && params.threadId === execution.rootThreadId)
        this.#executions.abortComputerUseExecution(execution, params.turn.id);
      else lifetime?.abort(params.turn.id);
      const target = this.#executions.notificationTarget(
        params.threadId,
        params.turn.id,
      );
      if (!target) {
        this.observeExternalThreadChange(params.threadId, "turn");
        return;
      }
      const { active, state } = target;
      const correlation = eventCorrelation(
        message.method,
        diagnosticId,
        params.threadId,
        params.turn.id,
        null,
      );
      const observedAtMs =
        params.turn.completedAt === null ||
        params.turn.completedAt === undefined
          ? Date.now()
          : params.turn.completedAt * 1_000;
      const terminalStatus = target.isRoot
        ? reconciledRootTurnStatus(
            params.turn.status,
            active.executionKind === "chat" &&
              !active.structuredChat &&
              Boolean(active.finalText?.trim()),
            active.interruptionRequestedAtMs !== null,
          )
        : params.turn.status;
      if (target.isRoot && terminalStatus !== params.turn.status) {
        workerLogger.event(
          "warn",
          "Reconciled Codex root turn terminal status",
          {
            event: "codex.turn.status-reconciled",
            subsystem: "codex",
            operation: "chat-turn",
            status: terminalStatus,
            reasonCode:
              terminalStatus === "completed"
                ? "final-answer-observed"
                : "interrupt-requested",
            chatId: active.chatId ?? undefined,
            threadId: params.threadId,
            turnId: params.turn.id,
          },
        );
      }
      const pendingCommandStatus =
        terminalStatus === "completed" ? "completed" : "failed";
      for (const telemetry of state.commandTelemetry.values()) {
        clearCommandFlush(telemetry);
        telemetry.updatedAtMs = observedAtMs;
        emitCommandTelemetry(
          state,
          telemetry,
          observedAtMs,
          pendingCommandStatus,
        );
      }
      settlePendingTurnActivities(
        state,
        pendingCommandStatus,
        observedAtMs,
        correlation,
      );
      if (terminalStatus !== "completed" && params.turn.error?.message) {
        emitTurnActivity(
          state,
          normalizeNoticeActivity({
            level: "error",
            message: readableCodexProviderError(params.turn.error.message, {
              secrets: this.#diagnosticSecrets,
              zai: this.#runtimeIsZai,
            }),
            details: params.turn.error.additionalDetails
              ? readableCodexProviderError(
                  params.turn.error.additionalDetails,
                  { secrets: this.#diagnosticSecrets },
                )
              : null,
            reasonCode: codexErrorReasonCode(params.turn.error.codexErrorInfo),
            willRetry: false,
            correlation,
          }),
        );
      }
      flushActiveAgentMessage(state, terminalStatus === "completed");
      emitTurnActivity(
        state,
        turnSummaryActivity(
          {
            id: params.turn.id,
            status: terminalStatus,
            startedAt: params.turn.startedAt ?? null,
            completedAt: params.turn.completedAt ?? null,
            durationMs: params.turn.durationMs ?? null,
          },
          correlation,
          state.initialSettings,
        ),
      );
      if (!target.isRoot) {
        const agent = state as AgentRuntimeState;
        this.#interactions.clearInteractionsForAgentTurn(
          active,
          params.threadId,
          params.turn.id,
          "The child Codex turn completed before the interaction was answered.",
        );
        agent.currentTurnId = null;
        this.#executions.updateAgentStatus(
          agent,
          terminalStatus === "completed"
            ? "completed"
            : terminalStatus === "interrupted"
              ? "interrupted"
              : "failed",
        );
        this.#executions.emitAgentCommunication({
          diagnosticId,
          kind:
            terminalStatus === "completed"
              ? "returned"
              : terminalStatus === "interrupted"
                ? "interrupted"
                : "failed",
          sourceMethod: message.method,
          state: agent,
          status: terminalStatus === "completed" ? "completed" : "failed",
          turnId: params.turn.id,
        });
        clearTurnInspectionTelemetry(agent);
        return;
      }
      this.#executions.deleteActiveTurn(params.turn.id);
      if (active.timeout) {
        clearTimeout(active.timeout);
        active.timeout = null;
      }
      active.durationMs =
        params.turn.durationMs ?? Math.max(0, Date.now() - active.startedAtMs);
      if (terminalStatus !== "completed") {
        void this.failTurn(
          active,
          params.turn.id,
          new CodexTurnFailureError(
            terminalStatus === "interrupted"
              ? "Codex turn was interrupted."
              : params.turn.error?.message
                ? readableCodexProviderError(params.turn.error.message, {
                    secrets: this.#diagnosticSecrets,
                    zai: this.#runtimeIsZai,
                  })
                : `Codex turn ended with ${terminalStatus}.`,
            codexErrorReasonCode(params.turn.error?.codexErrorInfo),
            params.threadId,
            params.turn.id,
            terminalStatus === "interrupted" ? "interrupted" : "failed",
          ),
          terminalStatus,
          observedAtMs,
          diagnosticId,
        );
        return;
      }
      void this.completeTurn(
        active,
        params.turn.id,
        observedAtMs,
        diagnosticId,
      );
      return;
    }

    if (message.method === "thread/queue/changed") {
      const params = message.params as { threadId?: unknown };
      if (typeof params.threadId === "string") {
        this.observeExternalThreadChange(params.threadId, "queue");
      }
      return;
    }

    if (message.method && isKnownCodexNotificationMethod(message.method)) {
      return;
    }

    this.recordDiagnostic(
      {
        at: new Date().toISOString(),
        direction: "from-runtime",
        kind: "unknown-notification",
        method: message.method ?? null,
        payload: message.params,
      },
      `Unknown App Server notification ${message.method ?? "<missing method>"}`,
    );
  }

  private async completeTurn(
    active: ActiveTurn,
    turnId: string,
    observedAtMs: number,
    diagnosticId: string | null,
  ): Promise<void> {
    const isCurrent = this.#executions.turnFinalizationCurrent(active, turnId);
    if (!isCurrent()) return;
    // Capture before the first await: native goals can start their next turn
    // before workspace/history reconciliation finishes. Keep this bounded to
    // one completed segment, independent of exact-turn execution authority.
    if (
      active.executionKind === "chat" &&
      !active.admission &&
      active.contextCompactionRequestedAtMs === null &&
      this.#goals.has(active.threadId) &&
      active.goalCompletion?.turnId !== turnId
    ) {
      active.goalCompletion = {
        turnId,
        text: active.finalText ?? active.delta,
        checkpointPublished: false,
      };
    }
    let released = false;
    try {
      this.#interactions.clearInteractionsForTurn(
        active,
        "The Codex turn completed before the interaction was answered.",
      );
      const changes = await workspaceChanges(active);
      if (!isCurrent()) return;
      active.diffChanges = changes;
      emitFileActivity(
        active,
        turnId,
        "completed",
        eventCorrelation(
          "cantrip/workspaceSnapshot",
          null,
          active.threadId,
          turnId,
          null,
        ),
      );
      await this.reconcileSubagentExecution(active, observedAtMs, isCurrent);
      if (!isCurrent()) return;
      const execution = this.#executions.rootExecutionsByActive.get(active);
      if (execution) {
        this.settleDescendantsAtRootBoundary(
          execution,
          "completed",
          observedAtMs,
          diagnosticId,
        );
      }
      const text = active.finalText ?? active.delta;
      if (active.executionKind === "chat" && this.#goals.has(active.threadId)) {
        await this.replayCompletedTurn(active, turnId, isCurrent);
        if (!isCurrent()) return;
      }
      clearTurnInspectionTelemetry(active);
      const contextCompactionRequestedAtMs =
        active.contextCompactionRequestedAtMs;
      // Managed autonomous runners obtain a fresh admission for every actual
      // turn. Retain the legacy continuous goal behavior only outside that path.
      if (
        active.executionKind === "chat" &&
        !active.admission &&
        contextCompactionRequestedAtMs === null &&
        this.#goals.has(active.threadId)
      ) {
        const response = await this.refreshGoal(active.threadId, isCurrent);
        if (!isCurrent()) return;
        if (
          goalShouldContinue(
            response.goal,
            active.chatId ? this.#pausedChats.has(active.chatId) : false,
          ) &&
          goalShouldContinue(
            this.#goals.get(active.threadId) ?? null,
            active.chatId ? this.#pausedChats.has(active.chatId) : false,
          )
        ) {
          publishGoalCheckpoint(active, turnId);
          const baseline = await workspaceSnapshot(active.cwd);
          if (!isCurrent()) return;
          active.baseline = baseline;
          resetGoalSegment(active);
          workerLogger.event("info", "Codex goal remains active", {
            event: "codex.turn.continuation",
            subsystem: "codex",
            operation: "goal-continuation",
            status: "runtime-managed",
            chatId: active.chatId ?? undefined,
            threadId: active.threadId,
            previousTurnId: turnId,
            providerId: active.providerId,
            providerKind: active.providerKind,
          });
          return;
        }
      }
      if (!this.releaseActiveTurn(active, turnId)) return;
      released = true;
      if (contextCompactionRequestedAtMs !== null) {
        const startedAtMs = Date.now();
        await this.requestGuiThreadMutation("thread/compact/start", {
          threadId: active.threadId,
        });
        workerLogger.event(
          "info",
          "Scheduled Codex context compaction accepted",
          {
            event: "codex.thread.compact",
            subsystem: "codex",
            operation: "compact-thread-after-turn",
            status: "accepted",
            chatId: active.chatId ?? undefined,
            threadId: active.threadId,
            turnId,
            requestedAtMs: contextCompactionRequestedAtMs,
            durationMs: Date.now() - startedAtMs,
          },
        );
      }
      workerLogger.event("info", "Codex turn completed", {
        event: "codex.turn.lifecycle",
        subsystem: "codex",
        operation:
          active.executionKind === "operation"
            ? "agent-operation"
            : "chat-turn",
        status: "completed",
        chatId: active.chatId ?? undefined,
        threadId: active.threadId,
        turnId,
        providerId: active.providerId,
        providerKind: active.providerKind,
        model:
          active.initialSettings?.model ??
          (active.inheritThreadSettings ? null : active.model.name),
        durationMs: active.durationMs ?? Date.now() - active.startedAtMs,
        counts: {
          changedFiles: active.diffChanges.length,
          inputTokens: active.latestUsage?.inputTokens ?? 0,
          outputTokens: active.latestUsage?.outputTokens ?? 0,
        },
      });
      active.resolve(
        active.executionKind === "operation"
          ? ({
              threadId: active.threadId,
              turnId,
              text,
              structuredResult: parseStructuredAgentResult(
                text,
                active.structuredOutputSchema ?? {},
              ),
              measuredUsage: measuredAgentUsage(
                active.latestUsage,
                active.durationMs ?? Date.now() - active.startedAtMs,
              ),
              status: "completed",
            } satisfies AgentOperationResult)
          : agentTurnResultSchema.parse({
              threadId: active.threadId,
              turnId,
              text,
              measuredUsage: active.latestUsage,
              ...(active.structuredChat
                ? {
                    structuredResult: parseStructuredAgentResult(
                      text,
                      active.structuredOutputSchema ?? {},
                    ),
                  }
                : {}),
              status: "completed",
            }),
      );
    } catch (error) {
      if (!released) {
        if (!isCurrent()) return;
        if (!this.releaseActiveTurn(active, turnId)) return;
      }
      clearTurnInspectionTelemetry(active);
      workerLogger.event("error", "Codex turn completion failed", {
        event: "codex.turn.lifecycle",
        subsystem: "codex",
        operation:
          active.executionKind === "operation"
            ? "agent-operation"
            : "chat-turn",
        status: "failed",
        chatId: active.chatId ?? undefined,
        threadId: active.threadId,
        turnId,
        providerId: active.providerId,
        providerKind: active.providerKind,
        durationMs: Date.now() - active.startedAtMs,
        error: workerLogError(error),
      });
      active.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async replayCompletedTurn(
    active: ActiveTurn,
    turnId: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!active.onActivity && !active.onMessage) return;
    try {
      const response = (await this.request(
        "thread/read",
        {
          threadId: active.threadId,
          includeTurns: true,
        },
        COMPLETED_TURN_RECONCILIATION_TIMEOUT_MS,
      )) as CodexThreadReadResponse;
      if (!isCurrent()) return;
      const turn = completedCodexThreadTurnFromRead(
        response,
        active.cwd,
        turnId,
      );
      if (!turn) {
        workerLogger.event(
          "warn",
          "Completed Codex turn was absent from history",
          {
            event: "codex.turn.reconciliation",
            subsystem: "codex",
            operation: "replay-completed-turn",
            status: "skipped",
            chatId: active.chatId ?? undefined,
            threadId: active.threadId,
            turnId,
          },
        );
        return;
      }
      const liveMessageFingerprints = new Set(
        active.liveAgentMessageFingerprints,
      );
      for (const item of turn.items) {
        if (item.type === "agentMessage") {
          const { type: _type, ...message } = item;
          if (liveMessageFingerprints.has(agentMessageFingerprint(message))) {
            continue;
          }
          active.onMessage?.(message);
        } else if (item.type === "activity") {
          emitTurnActivity(active, item.activity);
        }
      }
    } catch (error) {
      workerLogger.event("warn", "Could not reconcile completed Codex turn", {
        event: "codex.turn.reconciliation",
        subsystem: "codex",
        operation: "replay-completed-turn",
        status: "failed",
        chatId: active.chatId ?? undefined,
        threadId: active.threadId,
        turnId,
        error: workerLogError(error),
      });
    }
  }

  private cacheGoal(response: ChatGoalResponse): void {
    if (response.goal) {
      this.#goals.set(response.goal.threadId, response.goal);
    }
  }

  private async refreshGoal(
    threadId: string,
    isCurrent = () => true,
  ): Promise<ChatGoalResponse> {
    const response = chatGoalResponseSchema.parse(
      await this.request("thread/goal/get", { threadId }),
    );
    if (!isCurrent()) return response;
    if (response.goal) {
      this.#goals.set(threadId, response.goal);
    } else {
      this.#goals.delete(threadId);
    }
    return response;
  }

  private async failTurn(
    active: ActiveTurn,
    turnId: string,
    error: Error,
    rootStatus: TurnCompletedParams["turn"]["status"] = "failed",
    observedAtMs = Date.now(),
    diagnosticId: string | null = null,
  ): Promise<void> {
    const isCurrent = this.#executions.turnFinalizationCurrent(active, turnId);
    if (!isCurrent()) return;
    const lifetime = this.#executions.rootExecutionsByActive.get(active);
    if (lifetime) this.#executions.abortComputerUseExecution(lifetime, turnId);
    try {
      if (active.timeout) {
        clearTimeout(active.timeout);
        active.timeout = null;
      }
      this.#interactions.clearInteractionsForTurn(active, error.message);
      const changes = await workspaceChanges(active);
      if (!isCurrent()) return;
      active.diffChanges = changes;
      emitFileActivity(
        active,
        turnId,
        "failed",
        eventCorrelation(
          "cantrip/workspaceSnapshot",
          null,
          active.threadId,
          turnId,
          null,
        ),
      );
      await this.reconcileSubagentExecution(active, observedAtMs, isCurrent);
      if (!isCurrent()) return;
      const execution = this.#executions.rootExecutionsByActive.get(active);
      if (execution) {
        this.settleDescendantsAtRootBoundary(
          execution,
          rootStatus,
          observedAtMs,
          diagnosticId,
        );
      }
    } finally {
      if (!isCurrent()) return;
      if (!this.releaseActiveTurn(active, turnId)) return;
      clearTurnInspectionTelemetry(active);
      workerLogger.event("error", "Codex turn failed", {
        event: "codex.turn.lifecycle",
        subsystem: "codex",
        operation:
          active.executionKind === "operation"
            ? "agent-operation"
            : "chat-turn",
        status: "failed",
        chatId: active.chatId ?? undefined,
        threadId: active.threadId,
        turnId,
        providerId: active.providerId,
        providerKind: active.providerKind,
        durationMs: active.durationMs ?? Date.now() - active.startedAtMs,
        counts: { changedFiles: active.diffChanges.length },
        error,
      });
      active.reject(error);
    }
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    if (message.id === undefined) {
      return;
    }
    if (message.method === "account/chatgptAuthTokens/refresh") {
      this.send({
        id: message.id,
        result: await this.refreshExternalChatGptAuth(message.params),
      });
      return;
    }
    if (this.#interactions.handleServerRequest(message, message.id)) return;
    this.recordDiagnostic(
      {
        at: new Date().toISOString(),
        direction: "from-runtime",
        kind: "unsupported-request",
        method: message.method ?? null,
        payload: message.params,
      },
      `Unsupported App Server request ${message.method ?? "<missing method>"}`,
    );
    this.send({
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported request: ${message.method}`,
      },
    });
  }

  private refreshExternalChatGptAuth(
    params: unknown,
  ): Promise<Record<string, unknown>> {
    return this.#authRecovery.refreshExternalChatGptAuth(params);
  }

  private requestWithChatGptAuthRecovery(
    provider: RuntimeProvider & { kind: "chatgpt" },
    method: string,
    params: unknown,
  ): Promise<unknown> {
    return this.#authRecovery.requestWithChatGptAuthRecovery(
      provider,
      method,
      params,
    );
  }

  private recordDiagnostic(
    diagnostic: Omit<CodexRuntimeDiagnostic, "id">,
    warning?: string,
  ): string {
    const id = `${this.#appServerSessionId}:${this.#nextDiagnosticSequence++}`;
    const correlated = {
      id,
      ...diagnostic,
      payload: redactCodexDiagnosticPayload(
        diagnostic.payload,
        this.#diagnosticSecrets,
      ),
    };
    this.#runtimeDiagnostics.push(correlated);
    if (this.#runtimeDiagnostics.length > CODEX_DIAGNOSTIC_LIMIT) {
      this.#runtimeDiagnostics.splice(
        0,
        this.#runtimeDiagnostics.length - CODEX_DIAGNOSTIC_LIMIT,
      );
    }
    this.onDiagnostic?.(correlated);
    if (warning) {
      workerLogger.warn(
        String(redactCodexDiagnosticPayload(warning, this.#diagnosticSecrets)),
        { subsystem: "codex" },
      );
    }
    return id;
  }

  private handleExit(error: Error): void {
    this.clearManagedExecutionGateHandlers();
    this.#nativeTransportGeneration = null;
    this.#liveManagedModelCatalog.clear();
    this.#managedModelInventoryProvider = null;
    this.#managedModelInventoryRefresh = null;
    this.#managedModelInventory = null;
    this.#managedAttributionModels.clear();
    this.#historyObservations.replace(null);
    this.#preparationEpoch += 1;
    this.#threadPreparations.clear();
    this.#threadPreparationVersions.clear();
    for (const execution of this.#executions.rootExecutionsByActive.values())
      this.#executions.abortComputerUseExecution(execution);
    this.#rpcRequests.rejectAll(error);
    this.#interactions.clearOnExit();
    this.#executions.failActiveTurns(error);
    this.#threadSettings.clear();
  }
}
