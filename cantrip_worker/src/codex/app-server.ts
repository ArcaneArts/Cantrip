import { createHash, randomUUID } from "node:crypto";
import {
  execFile,
  type ChildProcessWithoutNullStreams,
  type ProcessEnvOptions,
} from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { promisify, stripVTControlCharacters } from "node:util";

import {
  agentActivitySchema,
  agentCommandOutputLimitBytes,
  agentFilePreviewLimitCharacters,
  CANTRIP_MCP_TOOL_NAMES,
  agentInteractionAcceptedSchema,
  agentInteractionRuntimeRequestSchema,
  agentThreadSyncSchema,
  agentTurnResultSchema,
  chatGptModelInventorySchema,
  chatGoalClearSchema,
  chatGoalResponseSchema,
  codexExternalImportStatusSchema,
  codexMcpOauthStatusSchema,
  codexMcpReloadResultSchema,
  isManagedCantripMcpName,
  isManagedCodeGraphMcpName,
  pendingPlanQuestionSchema,
  permissionProfileCapabilitySchema,
  providerRateLimitResetConsumeOutcomeSchema,
  providerRateLimitResetConsumeResultSchema,
  YOLO_PERMISSION_PROFILE_ID,
  normalizedAgentMessageSchema,
  threadGoalSchema,
  type AgentActivity,
  type AgentCommunicationKind,
  type AgentScope,
  type AgentInteractionRequestKind,
  type AgentInteractionResponse,
  type AgentInteractionRuntimeRequest,
  type AgentThreadSync,
  type AgentThreadSyncItem,
  type AgentTurnResult,
  type ChatGptModelInventory,
  type ChatGoalResponse,
  type ChatRelocationContextPayload,
  type ChatMessageContent,
  type CodexCustomizationInventory,
  type CodexExternalImportPreview,
  type CodexExternalImportStatus,
  type CodexMcpOauthStartResult,
  type CodexMcpOauthStatus,
  type CodexMcpReloadResult,
  type CodexRuntimeReport,
  type CodexEventCorrelation,
  type CodexMcpResourceRead,
  type CodexSkillConfigResult,
  type CodexSkillRootsResult,
  type NormalizedAgentMessage,
  type PendingPlanQuestion,
  type PermissionProfileCapability,
  type PlanMode,
  type PlanStep,
  type McpServerConfiguration,
  type ProviderAccessTokenLease,
  type ProviderQuotaSnapshot,
  type ProviderRateLimitResetConsumeInput,
  type ProviderRateLimitResetConsumeResult,
  type ThreadGoal,
  type ChatAttachmentSummary,
  type WorkerCommand,
} from "@cantrip/protocol";
import { cantripVersion } from "@cantrip/version";
import { boundedJsonValueSchema } from "@cantrip/protocol/bounded-json";
import {
  measuredAgentUsageSchema,
  type MeasuredAgentUsage,
} from "@cantrip/protocol/agent-usage";

import { spawnGuardedProcess } from "../code/process-guard.js";
import { workerLogError, workerLogger } from "../logger.js";
import {
  ProviderAccessTokenRequestError,
  type ProviderAccessTokenClient,
} from "../provider-access-tokens.js";
import WebSocket, { type RawData } from "ws";

import type { CodexRuntime, CodexRuntimeDiagnostic } from "./runtime.js";
import { attachmentPromptText } from "./attachment-inputs.js";
import {
  codexModelProviderName,
  codexProviderConfiguration,
  isZaiRuntimeProvider,
} from "./provider-config.js";
import {
  createAgentActivityRawEnvelope,
  redactAgentActivityText,
} from "./raw-capture.js";
import {
  runtimeModelSupportsImages,
  writeManagedCodexModelCatalog,
} from "./model-catalog.js";
import {
  customizationInventory,
  parseExternalImportStatus,
  parseExternalImportPreview,
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
import { redactCodexDiagnosticPayload } from "./diagnostic-redaction.js";
import {
  isChatGptTokenExpiredError,
  ProviderAccountReauthenticationRequiredError,
  readableCodexProviderError,
} from "./provider-errors.js";
import {
  chatGptExternalAuthCapabilityError,
  chatGptExternalRefreshResponse,
  chatGptExternalAuthSession,
  chatGptExternalLoginParams,
  refreshExternalChatGptAuthSession,
  type ExternalChatGptAuthSession,
  type RuntimeProvider,
} from "./external-chatgpt-auth.js";
import { mergeCodexSkillRoots } from "./global-skills.js";
import {
  quotaSnapshotFromRateLimits,
  type AccountRateLimitsResult,
} from "./rate-limits.js";

export type CodexProcessLauncher = (
  binary: string,
  arguments_: string[],
  options: ProcessEnvOptions,
) => ChildProcessWithoutNullStreams;

const launchCodexProcess: CodexProcessLauncher = (
  binary,
  arguments_,
  options,
) =>
  spawnGuardedProcess(binary, arguments_, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    stdin: "pipe",
  });

export interface RpcError {
  code: number;
  message: string;
}

export interface RpcMessage {
  error?: RpcError;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface PendingRpcRequest {
  method: string;
  reject(error: Error): void;
  resolve(result: unknown): void;
  startedAtMs: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  agentScope: AgentScope | null;
  baseline: WorkspaceSnapshot;
  chatId: string | null;
  collaborationMode: NativeCollaborationMode | null;
  captureProtectedDiagnostics: boolean;
  commandTelemetry: Map<string, ActiveCommandTelemetry>;
  completedCommandIds: Set<string>;
  cwd: string;
  delta: string;
  diffChanges: FileActivityChange[];
  durationMs: number | null;
  executionKind: "chat" | "operation";
  fileStartedAtMs: Map<string, number>;
  finalText: string | null;
  interactionMode: "interactive" | "preauthorized";
  interruptionRequestedAtMs: number | null;
  itemStartedAtMs: Map<string, number>;
  latestUsage: TokenUsageBreakdown | null;
  liveAgentMessageFingerprints: Set<string>;
  observedActivityFingerprints: Set<string>;
  model: RunAgentTurnOptions["model"];
  providerId: string;
  providerKind: string;
  onActivity?: (activity: AgentActivity) => void;
  onMessage?: (message: NormalizedAgentMessage) => void;
  onInteractionCleared?: (requestKey: string) => void;
  onInteractionExpired?: (requestKey: string) => void;
  onInteractionRequest?: (request: AgentInteractionRuntimeRequest) => void;
  onCheckpoint?: (checkpoint: { text: string; turnId: string }) => void;
  onPlan?: (plan: {
    explanation: string | null;
    steps: PlanStep[];
    turnId: string;
  }) => void;
  onPlanQuestion?: (question: PendingPlanQuestion) => void;
  onPlanQuestionResolved?: (questionId: string) => void;
  pendingActivities: Map<string, AgentActivity>;
  pendingAgentMessage: NormalizedAgentMessage | null;
  reasoningSummaries: Map<string, string[]>;
  reject(error: Error): void;
  resolve(result: AgentTurnResult | AgentOperationResult): void;
  startedAtMs: number;
  streamingAgentMessage: StreamingAgentMessage | null;
  structuredChat: boolean;
  threadId: string;
  timeout: ReturnType<typeof setTimeout> | null;
  structuredOutputSchema: Record<string, unknown> | null;
}

type AgentEventState = Pick<
  ActiveTurn,
  | "agentScope"
  | "captureProtectedDiagnostics"
  | "commandTelemetry"
  | "completedCommandIds"
  | "cwd"
  | "delta"
  | "diffChanges"
  | "fileStartedAtMs"
  | "finalText"
  | "itemStartedAtMs"
  | "latestUsage"
  | "liveAgentMessageFingerprints"
  | "observedActivityFingerprints"
  | "onActivity"
  | "onMessage"
  | "pendingActivities"
  | "pendingAgentMessage"
  | "reasoningSummaries"
  | "startedAtMs"
  | "streamingAgentMessage"
  | "structuredChat"
>;

type AgentRuntimeStatus =
  "starting" | "running" | "idle" | "completed" | "failed" | "interrupted";

interface AgentRuntimeState extends AgentEventState {
  agentPath: string[];
  currentTurnId: string | null;
  depth: number;
  lastActiveAtMs: number;
  nickname: string | null;
  parentThreadId: string;
  role: string | null;
  segmentTurnIds: Set<string>;
  status: AgentRuntimeStatus;
  threadId: string;
}

interface RootExecution {
  active: ActiveTurn;
  agents: Map<string, AgentRuntimeState>;
  rootThreadId: string;
  rootTurnId: string | null;
}

interface ChildThreadMetadata {
  agentPath?: string | null;
  depth?: number | null;
  nickname?: string | null;
  parentThreadId: string;
  role?: string | null;
  threadId: string;
}

interface AgentNotificationTarget {
  active: ActiveTurn;
  execution: RootExecution;
  isRoot: boolean;
  state: AgentEventState;
}

type FileActivityChange = Extract<
  AgentActivity,
  { type: "fileChange" }
>["changes"][number];

export interface CommandOutputBuffer {
  output: string | null;
  truncated: boolean;
}

export interface CommandTelemetryValue extends CommandOutputBuffer {
  startedAtMs: number;
  updatedAtMs: number;
}

interface ActiveCommandTelemetry extends CommandTelemetryValue {
  correlation: CodexEventCorrelation;
  flushTimer: ReturnType<typeof setTimeout> | null;
  item: CommandExecutionItem | null;
}

interface StreamingAgentMessage {
  correlation: CodexEventCorrelation;
  flushTimer: ReturnType<typeof setTimeout> | null;
  id: string;
  lastEmittedText: string;
  phase: NormalizedAgentMessage["phase"];
  text: string;
}

const AGENT_MESSAGE_DELTA_COALESCE_MS = 100;
const COMMAND_OUTPUT_COALESCE_MS = 100;
const MAX_TURN_COMMAND_TELEMETRY = 200;
const MAX_COMPLETED_COMMAND_IDS = 1_000;
const MAX_TURN_FILE_ITEMS = 1_000;
const MAX_TURN_ITEM_TIMESTAMPS = 1_000;
const MAX_AGENT_THREADS_PER_EXECUTION = 256;
const MAX_ORPHAN_AGENT_THREADS = 256;
const MAX_KNOWN_AGENT_THREADS = 512;
const MAX_OBSERVED_ACTIVITY_FINGERPRINTS = 2_000;
const MAX_RECOVERED_AGENT_THREADS = 64;
const MAX_RECOVERED_TURNS_PER_AGENT = 8;
const MAX_RECOVERED_ITEMS_PER_TURN = 1_000;
const RECOVERY_TURN_CLOCK_SLOP_MS = 5_000;

function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function settleRunningActivityAtTurnBoundary(
  activity: AgentActivity,
  status: Exclude<AgentActivity["status"], "running">,
  completedAtMs: number | null,
  correlation: CodexEventCorrelation,
): AgentActivity {
  if (activity.status !== "running") return activity;
  return agentActivitySchema.parse({
    ...activity,
    status,
    ...(completedAtMs === null
      ? {}
      : {
          updatedAtMs: Math.max(activity.updatedAtMs ?? 0, completedAtMs),
          completedAtMs,
        }),
    correlation,
  });
}

function scopedAgentActivity(
  state: AgentEventState,
  activity: AgentActivity,
): AgentActivity {
  return state.agentScope
    ? agentActivitySchema.parse({ ...activity, agentScope: state.agentScope })
    : activity;
}

function agentActivityDeliveryFingerprint(activity: AgentActivity): string {
  return JSON.stringify([
    activity.agentScope?.agentThreadId ??
      activity.correlation?.threadId ??
      null,
    activity.correlation?.turnId ?? null,
    activity.correlation?.itemId ?? activity.id,
    activity.type,
    activity.status,
  ]);
}

function rememberObservedActivity(
  state: AgentEventState,
  activity: AgentActivity,
): void {
  if (
    state.observedActivityFingerprints.size >=
    MAX_OBSERVED_ACTIVITY_FINGERPRINTS
  ) {
    const oldest = state.observedActivityFingerprints.values().next().value;
    if (oldest !== undefined) state.observedActivityFingerprints.delete(oldest);
  }
  state.observedActivityFingerprints.add(
    agentActivityDeliveryFingerprint(activity),
  );
}

function emitTurnActivity(
  state: AgentEventState,
  activity: AgentActivity,
): void {
  const scoped = scopedAgentActivity(state, activity);
  rememberObservedActivity(state, scoped);
  const itemId = scoped.correlation?.itemId;
  if (itemId) {
    if (scoped.status === "running") {
      boundedMapSet(
        state.pendingActivities,
        itemId,
        scoped,
        MAX_TURN_ITEM_TIMESTAMPS,
      );
    } else {
      state.pendingActivities.delete(itemId);
    }
  }
  state.onActivity?.(scoped);
}

function settlePendingTurnActivities(
  active: AgentEventState,
  status: "completed" | "failed",
  completedAtMs: number,
  correlation: CodexEventCorrelation,
): void {
  for (const activity of [...active.pendingActivities.values()]) {
    emitTurnActivity(
      active,
      settleRunningActivityAtTurnBoundary(activity, status, completedAtMs, {
        ...correlation,
        itemId: activity.correlation?.itemId ?? null,
      }),
    );
  }
}

function rememberCompletedCommand(
  active: AgentEventState,
  itemId: string,
): void {
  if (active.completedCommandIds.size >= MAX_COMPLETED_COMMAND_IDS) {
    const oldest = active.completedCommandIds.values().next().value;
    if (oldest !== undefined) active.completedCommandIds.delete(oldest);
  }
  active.completedCommandIds.add(itemId);
}

function boundedCommandTelemetrySet(
  active: AgentEventState,
  itemId: string,
  telemetry: ActiveCommandTelemetry,
): void {
  if (
    !active.commandTelemetry.has(itemId) &&
    active.commandTelemetry.size >= MAX_TURN_COMMAND_TELEMETRY
  ) {
    const oldestId = active.commandTelemetry.keys().next().value;
    if (oldestId !== undefined) {
      const oldest = active.commandTelemetry.get(oldestId);
      if (oldest) clearCommandFlush(oldest);
      active.commandTelemetry.delete(oldestId);
    }
  }
  active.commandTelemetry.set(itemId, telemetry);
}

function emitCommandTelemetry(
  active: AgentEventState,
  telemetry: ActiveCommandTelemetry,
  completedAtMs?: number | null,
  status?: AgentActivity["status"],
): void {
  if (!telemetry.item) return;
  const activity = normalizeCodexThreadItem(
    telemetry.item,
    active.cwd,
    completedAtMs === undefined ? "started" : "completed",
    telemetry.correlation,
    {
      captureRaw: active.captureProtectedDiagnostics,
      commandOutput: {
        output: telemetry.output,
        truncated: telemetry.truncated,
      },
      startedAtMs: telemetry.startedAtMs,
      updatedAtMs: telemetry.updatedAtMs,
      ...(completedAtMs === undefined ? {} : { completedAtMs }),
      ...(status === undefined ? {} : { status }),
    },
  );
  if (activity) emitTurnActivity(active, activity);
}

function clearCommandFlush(telemetry: ActiveCommandTelemetry): void {
  if (!telemetry.flushTimer) return;
  clearTimeout(telemetry.flushTimer);
  telemetry.flushTimer = null;
}

function scheduleCommandTelemetry(
  active: AgentEventState,
  telemetry: ActiveCommandTelemetry,
): void {
  if (!telemetry.item || telemetry.flushTimer) return;
  telemetry.flushTimer = setTimeout(() => {
    telemetry.flushTimer = null;
    if (active.commandTelemetry.get(telemetry.item!.id) !== telemetry) return;
    emitCommandTelemetry(active, telemetry);
  }, COMMAND_OUTPUT_COALESCE_MS);
  telemetry.flushTimer.unref();
}

function clearStreamingAgentMessage(active: AgentEventState): void {
  const streaming = active.streamingAgentMessage;
  if (streaming?.flushTimer) clearTimeout(streaming.flushTimer);
  active.streamingAgentMessage = null;
}

export function normalizeStreamingAgentMessage(
  message: Omit<NormalizedAgentMessage, "phase" | "streaming">,
): NormalizedAgentMessage {
  return normalizedAgentMessageSchema.parse({
    ...message,
    // An agent message item can be followed by more tools or messages. Keep
    // streamed text provisional until the authoritative turn boundary decides
    // whether it was commentary or the final answer.
    phase: "commentary",
    streaming: true,
  });
}

function emitStreamingAgentMessage(active: AgentEventState): void {
  const streaming = active.streamingAgentMessage;
  if (!streaming) return;
  if (streaming.flushTimer) {
    clearTimeout(streaming.flushTimer);
    streaming.flushTimer = null;
  }
  const text = streaming.text.trim();
  if (
    !text ||
    text === streaming.lastEmittedText ||
    streaming.phase === "commentary" ||
    active.structuredChat
  ) {
    return;
  }
  streaming.lastEmittedText = text;
  active.onMessage?.(
    normalizeStreamingAgentMessage({
      id: streaming.id,
      text,
      correlation: streaming.correlation,
      ...(active.agentScope ? { agentScope: active.agentScope } : {}),
    }),
  );
}

function scheduleStreamingAgentMessage(active: AgentEventState): void {
  const streaming = active.streamingAgentMessage;
  if (!streaming || streaming.flushTimer) return;
  streaming.flushTimer = setTimeout(() => {
    if (active.streamingAgentMessage !== streaming) return;
    streaming.flushTimer = null;
    emitStreamingAgentMessage(active);
  }, AGENT_MESSAGE_DELTA_COALESCE_MS);
  streaming.flushTimer.unref();
}

function settleStreamingAgentMessage(
  active: AgentEventState,
  completed: boolean,
): void {
  const streaming = active.streamingAgentMessage;
  if (!streaming) return;
  emitStreamingAgentMessage(active);
  const text = streaming.text.trim();
  clearStreamingAgentMessage(active);
  if (!text || active.structuredChat) return;
  active.onMessage?.(
    normalizedAgentMessageSchema.parse({
      id: streaming.id,
      text,
      phase:
        streaming.phase === "commentary" || !completed
          ? "commentary"
          : "final_answer",
      correlation: streaming.correlation,
      ...(active.agentScope ? { agentScope: active.agentScope } : {}),
    }),
  );
}

function appendStreamingAgentMessageDelta(
  active: AgentEventState,
  itemId: string,
  delta: string,
  correlation: CodexEventCorrelation,
): void {
  if (active.streamingAgentMessage?.id !== itemId) {
    settleStreamingAgentMessage(active, false);
    active.streamingAgentMessage = {
      correlation,
      flushTimer: null,
      id: itemId,
      lastEmittedText: "",
      phase: null,
      text: "",
    };
  }
  active.streamingAgentMessage.text += delta;
  active.streamingAgentMessage.correlation = correlation;
  scheduleStreamingAgentMessage(active);
}

function clearTurnInspectionTelemetry(active: AgentEventState): void {
  clearStreamingAgentMessage(active);
  for (const telemetry of active.commandTelemetry.values()) {
    clearCommandFlush(telemetry);
  }
  active.commandTelemetry.clear();
  active.completedCommandIds.clear();
  active.fileStartedAtMs.clear();
  active.itemStartedAtMs.clear();
  active.pendingActivities.clear();
}

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

export interface CodexThreadTurn {
  completedAt: number | null;
  durationMs: number | null;
  error: TurnError | null;
  id: string;
  items: Array<
    | CodexThreadItem
    | {
        clientId: string | null;
        content: Array<{ type: string; text?: string }>;
        id: string;
        type: "userMessage";
      }
  >;
  startedAt: number | null;
  status: "completed" | "failed" | "interrupted" | "inProgress";
}

export interface CodexThreadReadResponse {
  thread: {
    agentNickname?: string | null;
    agentRole?: string | null;
    id: string;
    model?: string | null;
    parentThreadId?: string | null;
    reasoningEffort?: string | null;
    source?: unknown;
    status: { type: "active" | "idle" | "notLoaded" | "systemError" };
    turns: CodexThreadTurn[];
  };
}

interface CodexThreadListResponse {
  data: Array<CodexThreadReadResponse["thread"]>;
  nextCursor: string | null;
}

interface WorkspaceFileState {
  fingerprint: string;
  status: string;
}

type WorkspaceSnapshot = Map<string, WorkspaceFileState>;
type WorkspaceSnapshotMetadataReader = (
  filePath: string,
) => Promise<{ mode: number; mtimeMs: number; size: number }>;

const execFileAsync = promisify(execFile);
const WORKSPACE_SNAPSHOT_METADATA_CONCURRENCY = 16;
const CODEX_STARTUP_TIMEOUT_MS = 2 * 60_000;
const CODEX_RPC_TIMEOUT_MS = 2 * 60_000;
const CODEX_PAUSE_BOUNDARY_TIMEOUT_MS = 24 * 60 * 60_000;
const COMPLETED_TURN_RECONCILIATION_TIMEOUT_MS = 5_000;
const CODEX_DIAGNOSTIC_LIMIT = 100;
const CUSTOMIZATION_STATUS_LIMIT = 100;

const LEGACY_CHATGPT_FALLBACK_CODES = new Set([
  "credential-unavailable",
  "migration-needed",
]);

// Derived from ServerNotification generated by codex-cli 0.153.1. Known but
// currently unnormalized notifications remain available in the raw diagnostic
// buffer without being mislabeled as schema drift.
const KNOWN_CODEX_NOTIFICATION_METHODS = new Set([
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
  "thread/closed",
  "thread/compacted",
  "thread/deleted",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/goal/cleared",
  "thread/goal/updated",
  "thread/name/updated",
  "thread/project/updated",
  "thread/queue/changed",
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

export type CodexExternalThreadChangeKind = "turn" | "goal" | "queue" | "plan";

export interface CodexExternalThreadChange {
  changes: CodexExternalThreadChangeKind[];
  revision: number;
  threadId: string;
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

export function parseCodexRpcMessage(raw: string): RpcMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const message = parsed as Record<string, unknown>;
  if (
    message.id !== undefined &&
    typeof message.id !== "number" &&
    typeof message.id !== "string"
  ) {
    return null;
  }
  if (message.method !== undefined && typeof message.method !== "string") {
    return null;
  }
  if (message.id === undefined && message.method === undefined) {
    return null;
  }
  if (message.error !== undefined) {
    if (
      !message.error ||
      typeof message.error !== "object" ||
      Array.isArray(message.error)
    ) {
      return null;
    }
    const error = message.error as Record<string, unknown>;
    if (typeof error.code !== "number" || typeof error.message !== "string") {
      return null;
    }
  }
  return parsed as RpcMessage;
}

export function codexEndpointFromLine(line: string): string | null {
  const plainText = stripVTControlCharacters(line);
  return /^\s*listening on:\s+(ws:\/\/\S+)\s*$/.exec(plainText)?.[1] ?? null;
}

export function codexStartupExitMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrLines: readonly string[],
): string {
  const status = signal ?? `code ${String(code)}`;
  const diagnostic = stderrLines
    .map((line) => stripVTControlCharacters(line).trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 2_000);
  return `Codex app-server exited before listening (${status})${diagnostic ? `: ${diagnostic}` : "."}`;
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

export function planQuestionId(
  params: Pick<ToolRequestUserInputParams, "threadId" | "turnId" | "itemId">,
  rpcId: number | string,
): string {
  return `${params.threadId}:${params.turnId}:${params.itemId}:${String(rpcId)}`;
}

export const AGENT_INTERACTION_TIMEOUT_MS = 30 * 60_000;

const AGENT_INTERACTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

function rpcParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("App Server request params must be an object.");
  }
  return params as Record<string, unknown>;
}

function availableCommandDecisions(
  value: unknown,
): Array<
  | "accept"
  | "acceptForSession"
  | "acceptWithExecpolicyAmendment"
  | "applyNetworkPolicyAmendment"
  | "decline"
  | "cancel"
> | null {
  if (!Array.isArray(value)) return null;
  const known: ReadonlySet<string> = new Set([
    "accept",
    "acceptForSession",
    "acceptWithExecpolicyAmendment",
    "applyNetworkPolicyAmendment",
    "decline",
    "cancel",
  ]);
  return value.flatMap((decision) => {
    if (typeof decision === "string" && known.has(decision)) {
      return [
        decision as
          | "accept"
          | "acceptForSession"
          | "acceptWithExecpolicyAmendment"
          | "applyNetworkPolicyAmendment"
          | "decline"
          | "cancel",
      ];
    }
    if (!decision || typeof decision !== "object") return [];
    if ("acceptWithExecpolicyAmendment" in decision) {
      return ["acceptWithExecpolicyAmendment"] as const;
    }
    if ("applyNetworkPolicyAmendment" in decision) {
      return ["applyNetworkPolicyAmendment"] as const;
    }
    return [];
  }) as ReturnType<typeof availableCommandDecisions>;
}

export function agentInteractionRequestFromServerRequest(
  method: string,
  params: unknown,
  requestKey: string,
  nowMs = Date.now(),
): AgentInteractionRuntimeRequest | null {
  if (!AGENT_INTERACTION_METHODS.has(method)) return null;
  const value = rpcParams(params);
  const requestedTimeout =
    method === "item/tool/requestUserInput" &&
    typeof value.autoResolutionMs === "number" &&
    Number.isSafeInteger(value.autoResolutionMs) &&
    value.autoResolutionMs >= 0
      ? value.autoResolutionMs
      : AGENT_INTERACTION_TIMEOUT_MS;
  const expiresAt = new Date(
    nowMs + Math.min(requestedTimeout, AGENT_INTERACTION_TIMEOUT_MS),
  ).toISOString();

  if (method === "item/commandExecution/requestApproval") {
    return agentInteractionRuntimeRequestSchema.parse({
      requestKey,
      threadId: value.threadId,
      turnId: value.turnId,
      itemId: value.itemId,
      expiresAt,
      payload: {
        kind: "commandExecution",
        startedAtMs: value.startedAtMs,
        approvalId: value.approvalId ?? null,
        environmentId: value.environmentId ?? null,
        reason: value.reason ?? null,
        command: value.command ?? null,
        cwd: value.cwd ?? null,
        commandActions: value.commandActions ?? null,
        networkApprovalContext: value.networkApprovalContext ?? null,
        additionalPermissions: value.additionalPermissions ?? null,
        proposedExecpolicyAmendment: value.proposedExecpolicyAmendment ?? null,
        proposedNetworkPolicyAmendments:
          value.proposedNetworkPolicyAmendments ?? null,
        availableDecisions: availableCommandDecisions(value.availableDecisions),
      },
    });
  }
  if (method === "item/fileChange/requestApproval") {
    return agentInteractionRuntimeRequestSchema.parse({
      requestKey,
      threadId: value.threadId,
      turnId: value.turnId,
      itemId: value.itemId,
      expiresAt,
      payload: {
        kind: "fileChange",
        startedAtMs: value.startedAtMs,
        reason: value.reason ?? null,
        grantRoot: value.grantRoot ?? null,
      },
    });
  }
  if (method === "item/permissions/requestApproval") {
    return agentInteractionRuntimeRequestSchema.parse({
      requestKey,
      threadId: value.threadId,
      turnId: value.turnId,
      itemId: value.itemId,
      expiresAt,
      payload: {
        kind: "permissions",
        startedAtMs: value.startedAtMs,
        environmentId: value.environmentId ?? null,
        cwd: value.cwd,
        reason: value.reason ?? null,
        requestedPermissions: value.permissions,
      },
    });
  }
  if (method === "item/tool/requestUserInput") {
    return agentInteractionRuntimeRequestSchema.parse({
      requestKey,
      threadId: value.threadId,
      turnId: value.turnId,
      itemId: value.itemId,
      expiresAt,
      payload: {
        kind: "userInput",
        questions: value.questions,
        autoResolutionMs: value.autoResolutionMs ?? null,
      },
    });
  }
  return agentInteractionRuntimeRequestSchema.parse({
    requestKey,
    threadId: value.threadId,
    turnId: value.turnId ?? null,
    itemId: null,
    expiresAt,
    payload: {
      kind: "mcpElicitation",
      serverName: value.serverName,
      mode: value.mode,
      message: value.message,
      requestedSchema: value.requestedSchema ?? null,
      url: value.url ?? null,
      elicitationId: value.elicitationId ?? null,
      metadata: value._meta ?? null,
    },
  });
}

export function codexResultForAgentInteraction(
  response: AgentInteractionResponse,
): unknown {
  if (response.kind === "commandExecution") {
    if (response.decision === "acceptWithExecpolicyAmendment") {
      if (!response.execpolicyAmendment) {
        throw new Error("Missing execpolicy amendment.");
      }
      return {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: response.execpolicyAmendment,
          },
        },
      };
    }
    if (response.decision === "applyNetworkPolicyAmendment") {
      if (!response.networkPolicyAmendment) {
        throw new Error("Missing network policy amendment.");
      }
      return {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: response.networkPolicyAmendment,
          },
        },
      };
    }
    return { decision: response.decision };
  }
  if (response.kind === "fileChange") {
    return { decision: response.decision };
  }
  if (response.kind === "permissions") {
    return {
      permissions: response.permissions,
      scope: response.scope,
      strictAutoReview: response.strictAutoReview,
    };
  }
  if (response.kind === "userInput") {
    return { answers: response.answers };
  }
  return {
    action: response.action,
    content: response.content,
    _meta: response.metadata,
  };
}

export function failClosedAgentInteractionReply(
  kind: AgentInteractionRequestKind,
  reason: string,
): Pick<RpcMessage, "error" | "result"> {
  if (kind === "commandExecution" || kind === "fileChange") {
    return { result: { decision: "cancel" } };
  }
  if (kind === "permissions") {
    return {
      result: {
        permissions: {},
        scope: "turn",
        strictAutoReview: false,
      },
    };
  }
  if (kind === "mcpElicitation") {
    return { result: { action: "cancel", content: null, _meta: null } };
  }
  return { error: { code: -32_000, message: reason } };
}

interface ThreadResponse {
  thread: { id: string };
}

interface TurnStartResponse {
  turn: { id: string };
}

interface TurnStartedParams {
  threadId: string;
  turn: {
    id: string;
    startedAt?: number | null;
  };
}

interface TurnCompletedParams {
  threadId: string;
  turn: {
    completedAt?: number | null;
    durationMs?: number | null;
    error: TurnError | null;
    id: string;
    startedAt?: number | null;
    status: "completed" | "failed" | "interrupted" | "inProgress";
  };
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

interface ThreadStartedParams {
  thread: {
    agentNickname?: string | null;
    agentRole?: string | null;
    id: string;
    parentThreadId?: string | null;
    source?: unknown;
    status?: { type?: string };
  };
}

interface ThreadStatusChangedParams {
  status: { type?: string };
  threadId: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalDepth(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 32)
    : null;
}

export function agentPathSegments(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[/.>]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(0, 32);
}

export function childThreadMetadataFromNotification(
  params: unknown,
): ChildThreadMetadata | null {
  const notification = objectRecord(params);
  const thread = objectRecord(notification?.thread);
  const threadId = optionalString(thread?.id);
  if (!threadId) return null;
  const source = objectRecord(thread?.source);
  const subagent = objectRecord(source?.subAgent ?? source?.subagent);
  const spawn = objectRecord(subagent?.thread_spawn ?? subagent?.threadSpawn);
  const parentThreadId =
    optionalString(thread?.parentThreadId) ??
    optionalString(spawn?.parent_thread_id ?? spawn?.parentThreadId);
  if (!parentThreadId) return null;
  return {
    threadId,
    parentThreadId,
    depth: optionalDepth(spawn?.depth),
    agentPath: optionalString(spawn?.agent_path ?? spawn?.agentPath),
    nickname:
      optionalString(thread?.agentNickname) ??
      optionalString(spawn?.agent_nickname ?? spawn?.agentNickname),
    role:
      optionalString(thread?.agentRole) ??
      optionalString(spawn?.agent_role ?? spawn?.agentRole),
  };
}

function nativeAgentRuntimeStatus(
  status: { type?: string } | null | undefined,
): AgentRuntimeStatus {
  switch (status?.type) {
    case "active":
      return "running";
    case "idle":
      return "idle";
    case "notLoaded":
      return "completed";
    case "systemError":
      return "failed";
    default:
      return "starting";
  }
}

interface AgentMessageDeltaParams {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
}

interface CommandExecutionOutputDeltaParams {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
}

interface ReasoningSummaryPartAddedParams {
  itemId: string;
  summaryIndex: number;
  threadId: string;
  turnId: string;
}

interface ReasoningSummaryTextDeltaParams extends ReasoningSummaryPartAddedParams {
  delta: string;
}

interface CommandExecutionItem {
  aggregatedOutput: string | null;
  command: string;
  cwd: string;
  durationMs?: number | null;
  exitCode: number | null;
  id: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  type: "commandExecution";
}

interface FileUpdateChange {
  diff?: string;
  kind: { type: "add" | "delete" | "update" };
  path: string;
}

interface FileChangeItem {
  changes: FileUpdateChange[];
  id: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  type: "fileChange";
}

interface FileChangePatchUpdatedParams {
  changes: FileUpdateChange[];
  itemId: string;
  threadId: string;
  turnId: string;
}

interface AgentMessageItem {
  id: string;
  phase?: "commentary" | "final_answer" | null;
  text?: string;
  type: "agentMessage";
}

interface PlanItem {
  id: string;
  text: string;
  type: "plan";
}

interface ReasoningItem {
  content?: string[];
  id: string;
  summary: string[];
  type: "reasoning";
}

interface McpToolCallItem {
  arguments?: unknown;
  durationMs: number | null;
  error: {
    code?: number | string | null;
    message: string;
    retryable?: boolean | null;
  } | null;
  id: string;
  result?: {
    content?: unknown[];
    isError?: boolean;
    status?: string;
    structuredContent?: unknown;
  } | null;
  server: string;
  status: "inProgress" | "completed" | "failed";
  tool: string;
  type: "mcpToolCall";
}

interface DynamicToolCallItem {
  durationMs: number | null;
  id: string;
  namespace: string | null;
  status: "inProgress" | "completed" | "failed";
  success: boolean | null;
  tool: string;
  type: "dynamicToolCall";
}

interface CollabAgentToolCallItem {
  agentsStates: Record<
    string,
    { message: string | null; status: string } | undefined
  >;
  id: string;
  model: string | null;
  prompt: string | null;
  receiverThreadIds: string[];
  senderThreadId: string;
  status: "inProgress" | "completed" | "failed";
  tool: string;
  type: "collabAgentToolCall";
}

interface SubAgentActivityItem {
  agentPath: string;
  agentThreadId: string;
  id: string;
  kind: "started" | "interacted" | "completed" | "interrupted";
  type: "subAgentActivity";
}

interface WebSearchItem {
  action: {
    pattern?: string;
    queries?: string[];
    query?: string;
    type: string;
    url?: string;
  } | null;
  id: string;
  query: string;
  type: "webSearch";
}

interface ImageViewItem {
  id: string;
  path: string;
  type: "imageView";
}

interface ReviewModeItem {
  id: string;
  review: string;
  type: "enteredReviewMode" | "exitedReviewMode";
}

interface ContextCompactionItem {
  id: string;
  type: "contextCompaction";
}

type CodexThreadItem =
  | AgentMessageItem
  | PlanItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | DynamicToolCallItem
  | CollabAgentToolCallItem
  | SubAgentActivityItem
  | WebSearchItem
  | ImageViewItem
  | ReviewModeItem
  | ContextCompactionItem;

interface ItemLifecycleParams {
  completedAtMs?: number;
  item: CodexThreadItem;
  startedAtMs?: number;
  threadId: string;
  turnId: string;
}

interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface ThreadTokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
  };
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface AccountRateLimitsUpdatedParams {
  rateLimits: {
    limitId: string | null;
    limitName: string | null;
    planType: string | null;
    primary: RateLimitWindow | null;
    rateLimitReachedType: string | null;
    secondary: RateLimitWindow | null;
  };
}

interface WarningParams {
  message: string;
  threadId: string | null;
}

interface ConfigWarningParams {
  details: string | null;
  path?: string;
  summary: string;
}

interface TurnError {
  additionalDetails?: string | null;
  codexErrorInfo?: unknown;
  message: string;
}

interface ErrorNotificationParams {
  error: TurnError;
  threadId: string;
  turnId: string;
  willRetry: boolean;
}

interface TurnDiffUpdatedParams {
  diff: string;
  threadId: string;
  turnId: string;
}

interface ThreadGoalUpdatedParams {
  goal: ThreadGoal;
  threadId: string;
  turnId: string | null;
}

interface ThreadGoalClearedParams {
  threadId: string;
}

interface NativeCollaborationMode {
  mode: PlanMode;
  settings: {
    model: string;
    reasoning_effort: RunAgentTurnOptions["model"]["reasoningEffort"];
    developer_instructions: null;
  };
}

interface NativeCollaborationModeListResponse {
  data: Array<{
    mode: PlanMode | null;
    model: string | null;
    reasoning_effort: RunAgentTurnOptions["model"]["reasoningEffort"];
  }>;
}

interface ThreadSettingsUpdatedParams {
  threadId: string;
  threadSettings: { collaborationMode: NativeCollaborationMode };
}

interface TurnPlanUpdatedParams {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: PlanStep[];
}

interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: PendingPlanQuestion["questions"];
  autoResolutionMs: number | null;
}

interface ServerRequestResolvedParams {
  threadId: string;
  requestId: number | string;
}

interface NativePendingPlanQuestion {
  active: ActiveTurn;
  question: PendingPlanQuestion;
  requestKey: string;
}

interface NativePendingAgentInteraction {
  active: ActiveTurn;
  request: AgentInteractionRuntimeRequest;
  rpcId: number | string;
  timeout: ReturnType<typeof setTimeout>;
}

export interface RunAgentTurnOptions {
  attachments?: RuntimeChatAttachment[];
  chatId: string;
  captureProtectedDiagnostics: boolean;
  clientMessageId: string;
  cwd: string;
  executionProfile: "ide" | "standalone-chat";
  isPrimary: Extract<WorkerCommand, { type: "chat.turn" }>["isPrimary"];
  model: Extract<WorkerCommand, { type: "chat.turn" }>["model"];
  mcpServers?: McpServerConfiguration[];
  automationPaused: Extract<
    WorkerCommand,
    { type: "chat.turn" }
  >["automationPaused"];
  planMode: Extract<WorkerCommand, { type: "chat.turn" }>["planMode"];
  policyContext: string | null;
  resultMode?: Extract<WorkerCommand, { type: "chat.turn" }>["resultMode"];
  provider: RuntimeProvider;
  permissionProfileId: Extract<
    WorkerCommand,
    { type: "chat.turn" }
  >["permissionProfileId"];
  prompt: string;
  rootKind: Extract<WorkerCommand, { type: "chat.turn" }>["rootKind"];
  skillNames: string[];
  subagentDefaults: RuntimeSubagentDefaults | null;
  subagentProtocolVersion: Extract<
    WorkerCommand,
    { type: "chat.turn" }
  >["subagentProtocolVersion"];
  threadId: string | null;
  worktreeMode: Extract<WorkerCommand, { type: "chat.turn" }>["worktreeMode"];
  worktreePolicy: Extract<
    WorkerCommand,
    { type: "chat.turn" }
  >["worktreePolicy"];
  onActivity?: (activity: AgentActivity) => void;
  onMessage?: ActiveTurn["onMessage"];
  onInteractionCleared?: ActiveTurn["onInteractionCleared"];
  onInteractionExpired?: ActiveTurn["onInteractionExpired"];
  onInteractionRequest?: ActiveTurn["onInteractionRequest"];
  onCheckpoint?: ActiveTurn["onCheckpoint"];
  onPlan?: ActiveTurn["onPlan"];
  onPlanQuestion?: ActiveTurn["onPlanQuestion"];
  onPlanQuestionResolved?: ActiveTurn["onPlanQuestionResolved"];
  onThreadLoaded?: (threadId: string) => void;
}

export interface RuntimeSubagentDefaults {
  model: Extract<WorkerCommand, { type: "chat.turn" }>["model"];
  provider: RuntimeProvider;
}

export interface RunAgentOperationOptions {
  operationId: string;
  cwd: string;
  prompt: string;
  developerInstructions: string | null;
  skillNames: string[];
  outputSchema: Record<string, unknown>;
  mutationMode: "read-only" | "write";
  networkAccess: "none" | "restricted" | "unrestricted";
  permissionProfileId: string | null;
  timeoutMs: number;
  model: RunAgentTurnOptions["model"];
  mcpServers: McpServerConfiguration[];
  provider: RuntimeProvider;
}

export interface AgentOperationResult {
  threadId: string;
  turnId: string;
  text: string;
  structuredResult: unknown;
  measuredUsage: MeasuredAgentUsage;
  status: "completed";
}

export interface RuntimeChatAttachment extends ChatAttachmentSummary {
  path: string;
}

export function codexReasoningEffortParams(
  model: RunAgentTurnOptions["model"],
): { effort?: NonNullable<RunAgentTurnOptions["model"]["reasoningEffort"]> } {
  return model.reasoningEffort ? { effort: model.reasoningEffort } : {};
}

export type GoalRuntimeOptions = Pick<
  RunAgentTurnOptions,
  | "cwd"
  | "mcpServers"
  | "model"
  | "permissionProfileId"
  | "provider"
  | "threadId"
>;

export interface HydrateChatRelocationOptions extends GoalRuntimeOptions {
  payload: ChatRelocationContextPayload;
  planMode: PlanMode;
  requiredSkillNames: string[];
  onThreadStarted(threadId: string): Promise<void>;
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
  "The managed `cantrip` MCP server is the preferred interface for Cantrip-owned state and surfaces. Start with `context_get`, list targets instead of guessing identifiers, and call `tool_help` for the live exact schema before guessing tool arguments. Use `policy_list` plus `policy_read` whenever an effective policy summary requires its current full body. Use `run_configuration_detect` for typed project discovery, then `run_configuration_create`, `run_configuration_get`, and revision-checked `run_configuration_update` to author shared definitions under `.cantrip/run-configurations`. Always use stable configuration IDs and exact worktree IDs, never display names. Run lifecycle intent is explicit through `run_configuration_start`, `run_configuration_restart`, `run_configuration_stop`, `run_configuration_status`, and `run_configuration_read_output`; omitting the worktree selects Primary. Use `run_configuration_secret_set` for write-only encrypted values. If the managed MCP server or a required tool is unavailable, use the worker-authenticated `cantrip` CLI as a fallback and run `cantrip -h` for concise help. When a Cantrip tool or command reports that continuation was scheduled, finish the current turn so Cantrip can checkpoint and continue safely.";

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
) {
  if (executionProfile === "standalone-chat") {
    return {
      developerInstructions: STANDALONE_CHAT_DEVELOPER_INSTRUCTIONS,
      ...CANTRIP_DYNAMIC_TOOLS_OVERRIDE,
    } as const;
  }
  return {
    developerInstructions: hasGitMetadata
      ? CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS
      : `${CANTRIP_AGENT_DEVELOPER_INSTRUCTIONS}\n\n${NON_GIT_WORKSPACE_DEVELOPER_INSTRUCTIONS}`,
    ...CANTRIP_DYNAMIC_TOOLS_OVERRIDE,
  } as const;
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
  const developerInstructions = cantripChatThreadParams(
    input.hasGitMetadata,
    input.options.executionProfile,
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
      collaborationMode:
        input.active.collaborationMode?.mode ?? input.options.planMode,
      model: input.options.model.name,
      providerId: input.options.provider.id,
      providerKind: input.options.provider.kind,
      reasoningEffort: input.options.model.reasoningEffort,
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
    model: input.options.model.name,
    provider: input.options.provider.id,
    reasoningEffort: input.options.model.reasoningEffort,
    collaborationMode:
      input.active.collaborationMode?.mode ?? input.options.planMode,
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

export interface CodexSkill {
  name: string;
  description: string;
  displayName: string | null;
  path: string | null;
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

export type CompactAgentThreadOptions = Pick<
  RunAgentTurnOptions,
  "cwd" | "executionProfile" | "model" | "permissionProfileId" | "provider"
> & {
  threadId: string;
};

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
          const managedCantripTools = managedCantripEnabledToolNames(server);
          const managedOverrides =
            isManagedCodeGraph || isManagedCantrip
              ? {
                  required: true,
                  enabled_tools: isManagedCodeGraph
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
  model: RunAgentTurnOptions["model"],
  provider: RunAgentTurnOptions["provider"],
  subagentDefaults: RuntimeSubagentDefaults | null = null,
  executionProfile: RunAgentTurnOptions["executionProfile"] = "ide",
): string {
  // Reasoning effort is a thread/turn override. Including it here would spawn
  // another app-server against the same Codex home, so resuming the thread
  // after an effort change would contend with its existing writer.
  const configuration = createHash("sha256")
    .update(
      JSON.stringify({
        modelName: model.name,
        modelCatalog: model.catalog ?? null,
        providerName: provider.name,
        providerKind: provider.kind,
        providerAccountId: provider.accountId,
        credentialHomeKey: provider.credentialHomeKey,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        executionProfile,
        subagentModel: subagentDefaults
          ? {
              name: subagentDefaults.model.name,
              routeId: subagentDefaults.model.routeId,
              catalog: subagentDefaults.model.catalog ?? null,
              providerId: subagentDefaults.provider.id,
              providerKind: subagentDefaults.provider.kind,
              providerAccountId: subagentDefaults.provider.accountId,
              credentialHomeKey: subagentDefaults.provider.credentialHomeKey,
              baseUrl: subagentDefaults.provider.baseUrl,
            }
          : null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${provider.credentialHomeKey ?? provider.id}:${model.routeId}:${configuration}`;
}

function safeProviderOrigin(provider: RuntimeProvider): string | null {
  try {
    return provider.baseUrl ? new URL(provider.baseUrl).origin : null;
  } catch {
    return null;
  }
}

function codexProviderLogContext(provider: RuntimeProvider) {
  return {
    providerId: provider.id,
    providerKind: provider.kind,
    providerOrigin: safeProviderOrigin(provider),
  };
}

function codexDiagnosticClass(line: string): string {
  const normalized = line.toLowerCase();
  if (normalized.includes("panic")) return "panic";
  if (normalized.includes("error")) return "error";
  if (normalized.includes("warn")) return "warning";
  return "diagnostic";
}

function activityStatus(
  status: "inProgress" | "completed" | "failed" | "declined",
): AgentActivity["status"] {
  return status === "inProgress" ? "running" : status;
}

function boundedText(value: string | null | undefined, limit = 20_000) {
  if (value === null || value === undefined) return null;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…truncated…`;
}

function boundedJson(value: unknown) {
  if (value === null || value === undefined) return null;
  try {
    return boundedText(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
  } catch {
    return null;
  }
}

function objectStringField(value: unknown, field: string) {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}

interface NormalizedMcpFailure {
  code: string | null;
  message: string;
  retryable: boolean | null;
}

interface McpFailureCandidate {
  code?: unknown;
  message: string;
  retryable?: unknown;
}

function primitiveMcpErrorCode(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const code = redactAgentActivityText(value).trim();
  return code && code.length <= 200 ? code : null;
}

function explicitMcpRetryability(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function genericMcpFailureMessage(message: string): boolean {
  return /^(?:(?:mcp|tool)\s+)?(?:tool\s+)?call failed[.!]?$/iu.test(
    message.trim(),
  );
}

function parsedMcpJson(text: string): unknown {
  const trimmed = text.trim();
  if (!(
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function mcpFailureCandidate(
  value: unknown,
  depth = 0,
): McpFailureCandidate | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = parsedMcpJson(value);
    return parsed === null
      ? value.trim()
        ? { message: value }
        : null
      : mcpFailureCandidate(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = mcpFailureCandidate(entry, depth + 1);
      if (candidate) return candidate;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const code = record.code ?? record.errorCode;
  const retryable =
    record.retryable ?? record.willRetry ?? record.canRetry ?? undefined;
  const directMessage =
    typeof record.message === "string"
      ? record.message
      : typeof record.error === "string"
        ? record.error
        : null;
  if (directMessage?.trim()) {
    return { code, message: directMessage, retryable };
  }
  for (const field of [
    "error",
    "result",
    "structuredContent",
    "data",
    "cause",
  ]) {
    const nested = mcpFailureCandidate(record[field], depth + 1);
    if (nested) {
      return {
        code: nested.code ?? code,
        message: nested.message,
        retryable: nested.retryable ?? retryable,
      };
    }
  }
  if (Array.isArray(record.content)) {
    for (const content of record.content) {
      if (
        typeof content === "object" &&
        content !== null &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        const nested = mcpFailureCandidate(content.text, depth + 1);
        if (nested) {
          return {
            code: nested.code ?? code,
            message: nested.message,
            retryable: nested.retryable ?? retryable,
          };
        }
      }
    }
  }
  return null;
}

function normalizedMcpFailure(
  item: Pick<McpToolCallItem, "error" | "result" | "status">,
): NormalizedMcpFailure | null {
  if (
    item.status !== "failed" &&
    !item.error &&
    item.result?.isError !== true &&
    item.result?.status !== "failed"
  ) {
    return null;
  }
  const resultCandidate = mcpFailureCandidate(item.result);
  const explicitCandidate = item.error
    ? {
        code: item.error.code,
        message: item.error.message,
        retryable: item.error.retryable,
      }
    : null;
  const candidate =
    resultCandidate &&
    (!explicitCandidate || genericMcpFailureMessage(explicitCandidate.message))
      ? resultCandidate
      : (explicitCandidate ?? resultCandidate);
  if (!candidate) return null;
  const message =
    boundedText(redactAgentActivityText(candidate.message).trim(), 4_000) ?? "";
  if (!message) return null;
  const embeddedCode =
    /\bMCP error\s+(-?\d+)\b/iu.exec(message)?.[1] ??
    /\bHTTP\s+(\d{3})\b/iu.exec(message)?.[1] ??
    null;
  return {
    code:
      primitiveMcpErrorCode(candidate.code) ??
      primitiveMcpErrorCode(explicitCandidate?.code) ??
      primitiveMcpErrorCode(resultCandidate?.code) ??
      embeddedCode,
    message,
    retryable:
      explicitMcpRetryability(candidate.retryable) ??
      explicitMcpRetryability(explicitCandidate?.retryable) ??
      explicitMcpRetryability(resultCandidate?.retryable),
  };
}

function mcpResultText(result: McpToolCallItem["result"]) {
  if (!result) return null;
  const text = (result.content ?? [])
    .flatMap((content) => {
      if (
        typeof content === "object" &&
        content !== null &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        return [content.text];
      }
      return [];
    })
    .join("\n\n")
    .trim();
  if (text) return boundedText(redactAgentActivityText(text));
  if (
    result.structuredContent !== null &&
    result.structuredContent !== undefined
  ) {
    const serialized = boundedJson(result.structuredContent);
    return serialized ? redactAgentActivityText(serialized) : null;
  }
  const serialized =
    (result.content?.length ?? 0) > 0 ? boundedJson(result.content) : null;
  return serialized ? redactAgentActivityText(serialized) : null;
}

export function completedActivityTimestamps(
  startedAtMs: number | null | undefined,
  completedAtMs: number,
) {
  return {
    ...(startedAtMs === null || startedAtMs === undefined
      ? {}
      : { startedAtMs }),
    updatedAtMs: completedAtMs,
    completedAtMs,
  };
}

function stableActivityId(prefix: string, ...parts: Array<string | null>) {
  const digest = createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\0"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}:${digest}`;
}

function eventCorrelation(
  sourceMethod: string,
  diagnosticId: string | null,
  threadId: string | null,
  turnId: string | null,
  itemId: string | null,
): CodexEventCorrelation {
  return {
    sourceMethod,
    diagnosticId,
    threadId,
    turnId,
    itemId,
  };
}

function displayPath(cwd: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath;
  }
  if (path.resolve(filePath) === path.resolve(cwd)) {
    return ".";
  }
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

export function appendBoundedCommandOutput(
  current: CommandOutputBuffer,
  delta: string,
): CommandOutputBuffer {
  if (!delta) return current;
  const plainDelta = stripVTControlCharacters(delta);
  let safeDelta = "";
  for (const character of plainDelta) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 0x20 &&
        codePoint !== 0x09 &&
        codePoint !== 0x0a &&
        codePoint !== 0x0d) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      continue;
    }
    safeDelta += character;
  }
  if (!safeDelta) return current;
  const currentBytes = Buffer.from(current.output ?? "", "utf8");
  const deltaBytes = Buffer.from(safeDelta, "utf8");
  const totalBytes = currentBytes.byteLength + deltaBytes.byteLength;
  if (totalBytes <= agentCommandOutputLimitBytes) {
    return {
      output: `${current.output ?? ""}${safeDelta}`,
      truncated: current.truncated,
    };
  }

  const retained = Buffer.allocUnsafe(agentCommandOutputLimitBytes);
  const deltaStart = Math.max(0, deltaBytes.byteLength - retained.byteLength);
  const retainedDelta = deltaBytes.subarray(deltaStart);
  const retainedCurrentBytes = retained.byteLength - retainedDelta.byteLength;
  if (retainedCurrentBytes > 0) {
    currentBytes.copy(
      retained,
      0,
      Math.max(0, currentBytes.byteLength - retainedCurrentBytes),
    );
  }
  retainedDelta.copy(retained, Math.max(0, retainedCurrentBytes));

  let start = 0;
  while (start < retained.byteLength && (retained[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return {
    output: retained.subarray(start).toString("utf8"),
    truncated: true,
  };
}

export function boundedCommandOutput(
  output: string | null,
): CommandOutputBuffer {
  return appendBoundedCommandOutput(
    { output: null, truncated: false },
    output ?? "",
  );
}

function transcriptCommandOutput(output: string | null): string | null {
  if (!output || output.length <= 20_000) return output;
  return `…output truncated…\n${output.slice(-20_000)}`;
}

export function commandTelemetryFromDelta(
  current: CommandTelemetryValue | null,
  delta: string,
  observedAtMs: number,
): CommandTelemetryValue {
  return {
    ...appendBoundedCommandOutput(
      current ?? { output: null, truncated: false },
      delta,
    ),
    startedAtMs: current?.startedAtMs ?? observedAtMs,
    updatedAtMs: observedAtMs,
  };
}

export function commandTelemetryFromStart(
  current: CommandTelemetryValue | null,
  aggregatedOutput: string | null,
  startedAtMs: number,
  observedAtMs: number,
): CommandTelemetryValue {
  const initial = boundedCommandOutput(aggregatedOutput);
  return {
    output: current?.output ?? initial.output,
    truncated: current?.truncated ?? initial.truncated,
    startedAtMs,
    updatedAtMs: observedAtMs,
  };
}

export function commandTelemetryFromCompletion(
  current: CommandTelemetryValue | null,
  aggregatedOutput: string | null,
  durationMs: number | null | undefined,
  observedAtMs: number,
): CommandTelemetryValue {
  const output =
    aggregatedOutput === null
      ? {
          output: current?.output ?? null,
          truncated: current?.truncated ?? false,
        }
      : boundedCommandOutput(aggregatedOutput);
  return {
    ...output,
    startedAtMs:
      current?.startedAtMs ??
      (durationMs === null || durationMs === undefined
        ? observedAtMs
        : Math.max(0, observedAtMs - durationMs)),
    updatedAtMs: observedAtMs,
  };
}

function boundedFilePreview(value: string): string {
  return value.length <= agentFilePreviewLimitCharacters
    ? value
    : value.slice(-agentFilePreviewLimitCharacters);
}

export function latestChangedLine(
  diff: string | null | undefined,
): string | null {
  if (!diff) return null;
  let latestAdded: string | null = null;
  let latestRemoved: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      latestAdded = line.slice(1);
    } else if (line.startsWith("-") && !line.startsWith("--- ")) {
      latestRemoved = line.slice(1);
    }
  }
  const latest = latestAdded ?? latestRemoved;
  return latest === null ? null : boundedFilePreview(latest);
}

export function changedLinesPreview(
  diff: string | null | undefined,
): string | null {
  if (!diff) return null;
  const preview = diff
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++ ")) ||
        (line.startsWith("-") && !line.startsWith("--- ")),
    )
    .join("\n");
  return preview ? boundedFilePreview(preview) : null;
}

export function changedFiles(
  diff: string,
  lastActivityAtMs?: number,
): ActiveTurn["diffChanges"] {
  return diff
    .split(/^diff --git /m)
    .slice(1)
    .flatMap((section) => {
      const header = section.split("\n", 1)[0] ?? "";
      const match = /^a\/(.+) b\/(.+)$/.exec(header);
      if (!match?.[2]) {
        return [];
      }
      const latestLine = latestChangedLine(section);
      const diffPreview = changedLinesPreview(section);
      return [
        {
          path: match[2],
          kind: section.includes("\nnew file mode ")
            ? ("add" as const)
            : section.includes("\ndeleted file mode ")
              ? ("delete" as const)
              : ("update" as const),
          ...(latestLine === null ? {} : { latestLine }),
          ...(diffPreview === null ? {} : { diffPreview }),
          ...(lastActivityAtMs === undefined ? {} : { lastActivityAtMs }),
        },
      ];
    });
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (values.length === 0) return [];
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function workspaceSnapshotFromPorcelainRecords(
  cwd: string,
  records: readonly string[],
  readMetadata: WorkspaceSnapshotMetadataReader = lstat,
): Promise<WorkspaceSnapshot> {
  const entries: Array<{ filePath: string; status: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) {
      continue;
    }
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
    entries.push({ filePath, status });
  }

  const snapshotEntries = await mapWithConcurrency(
    entries,
    WORKSPACE_SNAPSHOT_METADATA_CONCURRENCY,
    async ({ filePath, status }) => {
      let fingerprint = "missing";
      if (status !== " D") {
        try {
          const file = await readMetadata(path.join(cwd, filePath));
          fingerprint = `${file.size}:${file.mtimeMs}:${file.mode}`;
        } catch {
          // Deleted or concurrently removed files have no filesystem fingerprint.
        }
      }
      return [filePath, { fingerprint, status }] as const;
    },
  );
  return new Map(snapshotEntries);
}

async function workspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return await workspaceSnapshotFromPorcelainRecords(
      cwd,
      stdout.split("\0").filter(Boolean),
    );
  } catch {
    return new Map();
  }
}

async function workspaceChanges(
  active: ActiveTurn,
): Promise<ActiveTurn["diffChanges"]> {
  const observedAtMs = Date.now();
  const after = await workspaceSnapshot(active.cwd);
  const paths = new Set([...active.baseline.keys(), ...after.keys()]);
  const changes = new Map(
    active.diffChanges.map((change) => [change.path, change]),
  );
  for (const filePath of paths) {
    const beforeState = active.baseline.get(filePath);
    const afterState = after.get(filePath);
    if (
      beforeState?.status === afterState?.status &&
      beforeState?.fingerprint === afterState?.fingerprint
    ) {
      continue;
    }
    const status = afterState?.status ?? "D ";
    const kind =
      (status === "??" || status.includes("A")) && !beforeState
        ? "add"
        : status.includes("D")
          ? "delete"
          : "update";
    changes.set(filePath, {
      path: filePath,
      kind,
      lastActivityAtMs: observedAtMs,
    });
  }
  return [...changes.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function emitFileActivity(
  active: AgentEventState,
  turnId: string,
  status: AgentActivity["status"],
  correlation: CodexEventCorrelation,
): void {
  if (active.diffChanges.length === 0) {
    return;
  }
  emitTurnActivity(
    active,
    agentActivitySchema.parse({
      type: "fileChange",
      id: `turn:${turnId}:files`,
      status,
      changes: active.diffChanges,
      startedAtMs:
        active.diffChanges
          .map((change) => change.lastActivityAtMs)
          .filter((value): value is number => value !== undefined)
          .sort((left, right) => left - right)[0] ?? active.startedAtMs,
      updatedAtMs: Math.max(
        ...active.diffChanges.map(
          (change) => change.lastActivityAtMs ?? active.startedAtMs,
        ),
      ),
      completedAtMs: status === "running" ? null : Date.now(),
      correlation,
    }),
  );
}

function webSearchAction(item: WebSearchItem): string | null {
  if (!item.action) return null;
  if (item.action.type === "open_page") {
    return item.action.url
      ? `Opened ${safeDisplayUrl(item.action.url)}`
      : "Opened a page";
  }
  if (item.action.type === "find_in_page") {
    const location = item.action.url
      ? ` in ${safeDisplayUrl(item.action.url)}`
      : "";
    return item.action.pattern
      ? `Found “${item.action.pattern}”${location}`
      : `Searched within a page${location}`;
  }
  if (item.action.type === "search") {
    const queries =
      item.action.queries ?? (item.action.query ? [item.action.query] : []);
    return queries.length > 0 ? `Searched ${queries.join(", ")}` : "Searched";
  }
  return item.action.type === "other" ? "Web search" : item.action.type;
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/u, 1)[0] ?? "page";
  }
}

function createThreadItemRawCapture(
  item: CodexThreadItem,
  commandOutput?: CommandOutputBuffer,
) {
  const metadata = { itemId: item.id, itemType: item.type };
  switch (item.type) {
    case "commandExecution":
      return createAgentActivityRawEnvelope({
        request: { command: item.command, cwd: item.cwd },
        response: {
          durationMs: item.durationMs ?? null,
          exitCode: item.exitCode,
          output: commandOutput?.output ?? item.aggregatedOutput,
          outputTruncated: commandOutput?.truncated ?? false,
          status: item.status,
        },
        metadata,
      });
    case "fileChange":
      return createAgentActivityRawEnvelope({
        request: { changes: item.changes },
        response: {
          changes: item.changes.map((change) => ({
            kind: change.kind.type,
            path: change.path,
          })),
          status: item.status,
        },
        metadata,
      });
    case "plan":
      return createAgentActivityRawEnvelope({
        response: { text: item.text },
        metadata,
      });
    case "reasoning":
      return createAgentActivityRawEnvelope({
        response: { content: item.content, summary: item.summary },
        metadata,
      });
    case "mcpToolCall":
      return createAgentActivityRawEnvelope({
        request: item.arguments,
        response: {
          error: item.error,
          result: item.result,
          status: item.status,
        },
        metadata: { ...metadata, server: item.server, tool: item.tool },
      });
    case "dynamicToolCall":
      return createAgentActivityRawEnvelope({
        response: {
          durationMs: item.durationMs,
          status: item.status,
          success: item.success,
        },
        metadata: {
          ...metadata,
          namespace: item.namespace,
          tool: item.tool,
        },
      });
    case "collabAgentToolCall":
      return createAgentActivityRawEnvelope({
        request: {
          model: item.model,
          prompt: item.prompt,
          receiverThreadIds: item.receiverThreadIds,
          senderThreadId: item.senderThreadId,
        },
        response: { agentStates: item.agentsStates, status: item.status },
        metadata: { ...metadata, tool: item.tool },
      });
    case "subAgentActivity":
      return createAgentActivityRawEnvelope({
        response: {
          agentPath: item.agentPath,
          agentThreadId: item.agentThreadId,
          kind: item.kind,
        },
        metadata,
      });
    case "webSearch":
      return createAgentActivityRawEnvelope({
        request: { query: item.query },
        response: { action: item.action },
        metadata,
      });
    case "imageView":
      return createAgentActivityRawEnvelope({
        request: { path: item.path },
        metadata,
      });
    case "enteredReviewMode":
    case "exitedReviewMode":
      return createAgentActivityRawEnvelope({
        request: { review: item.review },
        metadata,
      });
    case "contextCompaction":
      return createAgentActivityRawEnvelope({ metadata });
    case "agentMessage":
      return createAgentActivityRawEnvelope({
        response: { phase: item.phase, text: item.text },
        metadata,
      });
  }
}

export function normalizeCodexThreadItem(
  item: CodexThreadItem,
  cwd: string,
  lifecycle: "started" | "completed",
  correlation: CodexEventCorrelation,
  telemetry: {
    commandOutput?: CommandOutputBuffer;
    captureRaw?: boolean;
    completedAtMs?: number | null;
    fileChanges?: FileActivityChange[];
    startedAtMs?: number;
    status?: AgentActivity["status"];
    updatedAtMs?: number;
  } = {},
): AgentActivity | null {
  const timestamps = {
    ...(telemetry.startedAtMs === undefined
      ? {}
      : { startedAtMs: telemetry.startedAtMs }),
    ...(telemetry.updatedAtMs === undefined
      ? {}
      : { updatedAtMs: telemetry.updatedAtMs }),
    ...(telemetry.completedAtMs === undefined
      ? {}
      : { completedAtMs: telemetry.completedAtMs }),
  };
  const raw = telemetry.captureRaw
    ? {
        raw: createThreadItemRawCapture(item, telemetry.commandOutput),
      }
    : {};
  if (item.type === "commandExecution") {
    const output =
      telemetry.commandOutput ?? boundedCommandOutput(item.aggregatedOutput);
    return agentActivitySchema.parse({
      type: "command",
      id: item.id,
      command: item.command,
      cwd: displayPath(cwd, item.cwd) || ".",
      status: activityStatus(item.status),
      exitCode: item.exitCode,
      output: transcriptCommandOutput(item.aggregatedOutput),
      outputTail: output.output,
      outputTruncated: output.truncated,
      durationMs: item.durationMs ?? null,
      ...raw,
      ...timestamps,
      ...(telemetry.status === undefined ? {} : { status: telemetry.status }),
      correlation,
    });
  }
  if (item.type === "fileChange") {
    const changes =
      telemetry.fileChanges ??
      item.changes.map((change) => {
        const latestLine = latestChangedLine(change.diff);
        const diffPreview = changedLinesPreview(change.diff);
        return {
          path: displayPath(cwd, change.path),
          kind: change.kind.type,
          ...(latestLine === null ? {} : { latestLine }),
          ...(diffPreview === null ? {} : { diffPreview }),
          ...(telemetry.updatedAtMs === undefined
            ? {}
            : { lastActivityAtMs: telemetry.updatedAtMs }),
        };
      });
    return agentActivitySchema.parse({
      type: "fileChange",
      id: item.id,
      status: activityStatus(item.status),
      changes,
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "plan") {
    return agentActivitySchema.parse({
      type: "plan",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      text: boundedText(item.text) ?? "",
      explanation: null,
      steps: [],
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "reasoning") {
    return agentActivitySchema.parse({
      type: "reasoning",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      summary: item.summary
        .map((part) => boundedText(part)?.trim() ?? "")
        .filter(Boolean)
        .slice(0, 100),
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "mcpToolCall") {
    const isCodeGraph = item.server.toLowerCase() === "codegraph";
    const failure = normalizedMcpFailure(item);
    return agentActivitySchema.parse({
      type: "mcpToolCall",
      id: item.id,
      status: failure ? "failed" : activityStatus(item.status),
      server: item.server,
      tool: item.tool,
      query: isCodeGraph
        ? boundedText(objectStringField(item.arguments, "query"), 4_000)
        : null,
      resultText: isCodeGraph && !failure ? mcpResultText(item.result) : null,
      error: failure?.message ?? null,
      errorCode: failure?.code ?? null,
      retryable: failure?.retryable ?? null,
      durationMs: item.durationMs,
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "dynamicToolCall") {
    return agentActivitySchema.parse({
      type: "dynamicToolCall",
      id: item.id,
      status: activityStatus(item.status),
      namespace: item.namespace?.trim() || null,
      tool: item.tool,
      success: item.success,
      durationMs: item.durationMs,
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "collabAgentToolCall") {
    return agentActivitySchema.parse({
      type: "collabToolCall",
      id: item.id,
      status: activityStatus(item.status),
      tool: item.tool,
      senderThreadId: item.senderThreadId,
      receiverThreadIds: item.receiverThreadIds.slice(0, 100),
      prompt: boundedText(item.prompt, 100_000),
      model: item.model,
      agentStates: Object.entries(item.agentsStates)
        .flatMap(([threadId, state]) =>
          state
            ? [
                {
                  threadId,
                  status: state.status,
                  message: boundedText(state.message, 4_000),
                },
              ]
            : [],
        )
        .slice(0, 100),
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "subAgentActivity") {
    return agentActivitySchema.parse({
      type: "subAgent",
      id: item.id,
      status:
        item.kind === "started"
          ? "running"
          : item.kind === "interrupted"
            ? "failed"
            : "completed",
      kind: item.kind,
      agentThreadId: item.agentThreadId,
      agentPath: item.agentPath || item.agentThreadId,
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "webSearch") {
    return agentActivitySchema.parse({
      type: "webSearch",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      query: boundedText(item.query, 4_000) ?? "",
      action: boundedText(webSearchAction(item), 4_000),
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "imageView") {
    return agentActivitySchema.parse({
      type: "imageView",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      path: displayPath(cwd, item.path),
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return agentActivitySchema.parse({
      type: "reviewMode",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      state: item.type === "enteredReviewMode" ? "entered" : "exited",
      review: boundedText(item.review) ?? "",
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  if (item.type === "contextCompaction") {
    return agentActivitySchema.parse({
      type: "contextCompaction",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      ...raw,
      ...timestamps,
      correlation,
    });
  }
  return null;
}

export function normalizeAgentMessage(
  item: AgentMessageItem,
  correlation: CodexEventCorrelation,
): NormalizedAgentMessage | null {
  const text = item.text?.trim();
  if (!text) return null;
  return normalizedAgentMessageSchema.parse({
    id: item.id,
    text,
    phase: item.phase ?? null,
    correlation,
  });
}

export interface StagedAgentMessageResult {
  emitted: NormalizedAgentMessage[];
  pending: NormalizedAgentMessage | null;
}

function asCommentary(message: NormalizedAgentMessage): NormalizedAgentMessage {
  return message.phase === "commentary"
    ? message
    : { ...message, phase: "commentary" };
}

export function stageAgentMessage(
  pending: NormalizedAgentMessage | null,
  message: NormalizedAgentMessage,
): StagedAgentMessageResult {
  if (message.phase === "commentary") {
    return {
      emitted: pending ? [asCommentary(pending), message] : [message],
      pending: null,
    };
  }
  return {
    emitted: pending ? [asCommentary(pending)] : [],
    pending: message,
  };
}

export function flushStagedAgentMessage(
  pending: NormalizedAgentMessage | null,
  completed: boolean,
): StagedAgentMessageResult {
  return {
    emitted: pending ? [completed ? pending : asCommentary(pending)] : [],
    pending: null,
  };
}

function publishStagedAgentMessages(
  active: AgentEventState,
  staged: StagedAgentMessageResult,
): void {
  active.pendingAgentMessage = staged.pending;
  for (const message of staged.emitted) {
    if (!active.structuredChat || message.phase === "commentary") {
      const scoped = normalizedAgentMessageSchema.parse({
        ...message,
        ...(active.agentScope ? { agentScope: active.agentScope } : {}),
      });
      active.liveAgentMessageFingerprints.add(agentMessageFingerprint(scoped));
      active.onMessage?.(scoped);
    }
  }
}

function agentMessageFingerprint(message: NormalizedAgentMessage): string {
  return JSON.stringify([
    message.phase === "commentary" ? "commentary" : "final",
    message.text,
  ]);
}

function flushActiveAgentMessage(
  active: AgentEventState,
  completed: boolean,
): void {
  settleStreamingAgentMessage(active, completed);
  publishStagedAgentMessages(
    active,
    flushStagedAgentMessage(active.pendingAgentMessage, completed),
  );
}

export function normalizeTokenUsageActivity(
  params: ThreadTokenUsageUpdatedParams,
  correlation: CodexEventCorrelation,
): AgentActivity {
  const window = params.tokenUsage.modelContextWindow;
  const contextUsedPercent = window
    ? Math.round((params.tokenUsage.last.totalTokens / window) * 1_000) / 10
    : null;
  return agentActivitySchema.parse({
    type: "usage",
    id: `turn:${params.turnId}:usage`,
    status: "completed",
    ...params.tokenUsage,
    contextUsedPercent,
    correlation,
  });
}

export function normalizeRateLimitActivity(
  params: AccountRateLimitsUpdatedParams,
  turnId: string,
  correlation: CodexEventCorrelation,
): AgentActivity {
  return agentActivitySchema.parse({
    type: "rateLimit",
    id: `turn:${turnId}:rate-limit`,
    status: params.rateLimits.rateLimitReachedType ? "failed" : "completed",
    updatedAtMs: Date.now(),
    limitId: params.rateLimits.limitId,
    limitName: params.rateLimits.limitName,
    planType: params.rateLimits.planType,
    reachedType: params.rateLimits.rateLimitReachedType,
    primary: params.rateLimits.primary,
    secondary: params.rateLimits.secondary,
    correlation,
  });
}

export function normalizeNoticeActivity(input: {
  correlation: CodexEventCorrelation;
  details?: string | null;
  level: "warning" | "error";
  message: string;
  reasonCode?: string | null;
  retry?: {
    owner: "codex" | "cantrip";
    attempt: number | null;
    maxAttempts: number | null;
    nextAttemptAtMs: number | null;
  } | null;
  status?: AgentActivity["status"];
  willRetry?: boolean | null;
}): AgentActivity {
  return agentActivitySchema.parse({
    type: "notice",
    id: stableActivityId(
      input.level,
      input.correlation.turnId,
      input.correlation.sourceMethod,
      input.message,
    ),
    status:
      input.status ??
      (input.willRetry
        ? "running"
        : input.level === "error"
          ? "failed"
          : "completed"),
    level: input.level,
    message: boundedText(input.message)?.trim() || input.level,
    details: boundedText(input.details),
    willRetry: input.willRetry ?? null,
    reasonCode: input.reasonCode ?? null,
    retry: input.retry ?? null,
    correlation: input.correlation,
  });
}

export function codexErrorReasonCode(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const record = objectRecord(value);
  if (!record) return null;
  const keys = Object.keys(record);
  return keys.length === 1 ? keys[0]! : null;
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

function turnSummaryActivity(
  turn: Pick<
    CodexThreadTurn,
    "completedAt" | "durationMs" | "id" | "startedAt" | "status"
  >,
  correlation: CodexEventCorrelation,
): AgentActivity {
  return agentActivitySchema.parse({
    type: "turnSummary",
    id: `turn:${turn.id}:summary`,
    status:
      turn.status === "inProgress"
        ? "running"
        : turn.status === "completed"
          ? "completed"
          : "failed",
    durationMs: turn.durationMs,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    correlation,
  });
}

export function normalizeCodexThreadTurn(
  turn: CodexThreadTurn,
  cwd: string,
  threadId: string,
  externalAttachmentIdsByItemId: ReadonlyMap<string, string[]> = new Map(),
): AgentThreadSync["turns"][number] {
  let lastFinalMessageIndex = -1;
  if (turn.status === "completed") {
    for (let index = 0; index < turn.items.length; index += 1) {
      const item = turn.items[index];
      if (
        item?.type === "agentMessage" &&
        item.phase !== "commentary" &&
        item.text?.trim()
      ) {
        lastFinalMessageIndex = index;
      }
    }
  }
  const items = turn.items.flatMap((item, index): AgentThreadSyncItem[] => {
    if (item.type === "userMessage") {
      const text = item.content
        .flatMap((content) =>
          content.type === "text" && content.text ? [content.text] : [],
        )
        .join("\n\n")
        .trim();
      const externalAttachmentIds =
        externalAttachmentIdsByItemId.get(item.id) ?? [];
      return text || externalAttachmentIds.length
        ? [
            {
              type: "userMessage",
              id: item.id,
              text,
              externalAttachmentIds,
            },
          ]
        : [];
    }
    if (item.type === "agentMessage") {
      const message = normalizeAgentMessage(
        item,
        eventCorrelation("thread/read", null, threadId, turn.id, item.id),
      );
      if (!message) return [];
      return [
        {
          type: "agentMessage",
          ...(message.phase !== "commentary" && index !== lastFinalMessageIndex
            ? asCommentary(message)
            : message),
        },
      ];
    }
    const correlation = eventCorrelation(
      "thread/read",
      null,
      threadId,
      turn.id,
      item.id,
    );
    const normalizedActivity = normalizeCodexThreadItem(
      item,
      cwd,
      turn.status === "inProgress" ? "started" : "completed",
      correlation,
    );
    const activity =
      normalizedActivity && turn.status !== "inProgress"
        ? settleRunningActivityAtTurnBoundary(
            normalizedActivity,
            turn.status === "completed" ? "completed" : "failed",
            turn.completedAt === null ? null : turn.completedAt * 1_000,
            correlation,
          )
        : normalizedActivity;
    if (activity) return [{ type: "activity", activity }];
    const unknown = item as { id?: unknown; type?: unknown };
    const itemId = typeof unknown.id === "string" ? unknown.id : null;
    const itemType =
      typeof unknown.type === "string" ? unknown.type : "unknown";
    return [
      {
        type: "activity",
        activity: normalizeNoticeActivity({
          level: "warning",
          message: "An unsupported Codex history item could not be rendered.",
          details: `Item type: ${itemType.slice(0, 200)}`,
          correlation: eventCorrelation(
            "thread/read",
            null,
            threadId,
            turn.id,
            itemId,
          ),
        }),
      },
    ];
  });
  if (turn.error?.message) {
    items.push({
      type: "activity",
      activity: normalizeNoticeActivity({
        level: "error",
        message: turn.error.message,
        details: turn.error.additionalDetails,
        reasonCode: codexErrorReasonCode(turn.error.codexErrorInfo),
        willRetry: false,
        correlation: eventCorrelation(
          "thread/read",
          null,
          threadId,
          turn.id,
          null,
        ),
      }),
    });
  }
  items.push({
    type: "activity",
    activity: turnSummaryActivity(
      turn,
      eventCorrelation("thread/read", null, threadId, turn.id, null),
    ),
  });
  return {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    items,
  };
}

export function normalizeCodexThreadReadResponse(
  response: CodexThreadReadResponse,
  cwd: string,
  externalAttachmentIdsByItemId: ReadonlyMap<string, string[]> = new Map(),
): AgentThreadSync {
  const turns = response.thread.turns.map((turn) =>
    normalizeCodexThreadTurn(
      turn,
      cwd,
      response.thread.id,
      externalAttachmentIdsByItemId,
    ),
  );
  const status = turns.some((turn) => turn.status === "inProgress")
    ? "running"
    : turns.some((turn) => turn.status === "failed")
      ? "failed"
      : "idle";
  return agentThreadSyncSchema.parse({
    threadId: response.thread.id,
    status,
    turns,
  });
}

export function completedCodexThreadTurnFromRead(
  response: CodexThreadReadResponse,
  cwd: string,
  turnId: string,
): AgentThreadSync["turns"][number] | null {
  const turn = response.thread.turns.find(
    (candidate) => candidate.id === turnId && candidate.status !== "inProgress",
  );
  return turn ? normalizeCodexThreadTurn(turn, cwd, response.thread.id) : null;
}

export class CodexAppServer implements CodexRuntime {
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #activeTurnsByThread = new Map<string, ActiveTurn>();
  readonly #rootExecutionsByActive = new Map<ActiveTurn, RootExecution>();
  readonly #rootExecutionsByThread = new Map<string, RootExecution>();
  readonly #orphanAgentThreads = new Map<string, ChildThreadMetadata>();
  readonly #knownAgentThreads = new Map<string, ChildThreadMetadata>();
  readonly #collaborationModes = new Map<string, PlanMode>();
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
  readonly #imageSupport = new Map<string, boolean>();
  readonly #loadedThreads = new Set<string>();
  readonly #mcpOauthStatuses = new Map<string, CodexMcpOauthStatus>();
  readonly #mcpConfigFingerprintsByThread = new Map<string, string>();
  readonly #readyMcpConfigFingerprintsByThread = new Map<string, string>();
  readonly #permissionProfilesByThread = new Map<string, string>();
  readonly #pending = new Map<number, PendingRpcRequest>();
  readonly #pendingAgentInteractions = new Map<
    string,
    NativePendingAgentInteraction
  >();
  readonly #pendingCapacityRetries = new Map<
    string,
    { controller: AbortController; threadId: string }
  >();
  readonly #pendingPlanQuestions = new Map<string, NativePendingPlanQuestion>();
  readonly #pausedChats = new Set<string>();
  readonly #runtimeDiagnostics: CodexRuntimeDiagnostic[] = [];
  #skillRoots: string[] = [];
  #appServerSessionId = randomUUID();
  #child: ChildProcessWithoutNullStreams | null = null;
  #externalChatGptAuth: ExternalChatGptAuthSession | null = null;
  #externalChatGptReauthentication: Promise<void> | null = null;
  #remoteUrl: string | null = null;
  #runtimeId: string | null = null;
  #runtimeStartedAtMs: number | null = null;
  #nextDiagnosticSequence = 1;
  #nextId = 1;
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

  setChatPaused(chatId: string, paused: boolean): void {
    if (paused) {
      this.#pausedChats.add(chatId);
    } else {
      this.#pausedChats.delete(chatId);
    }
  }

  async setActiveChatPaused(
    chatId: string,
    paused: boolean,
  ): Promise<{ threadId: string; turnId: string } | null> {
    this.setChatPaused(chatId, paused);
    const active = [...this.#activeTurns.entries()].find(
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
      await this.request(
        "turn/pause",
        {
          threadId: active[1].threadId,
          turnId: active[0],
          paused,
        },
        CODEX_PAUSE_BOUNDARY_TIMEOUT_MS,
      );
    } catch (error) {
      if (!this.#activeTurns.has(active[0])) return null;
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
    let attemptedThreadId = options.threadId;
    let compactionStateRetried = false;
    let capacityRetryAttempt = 0;
    for (;;) {
      const attemptOptions: RunAgentTurnOptions = {
        ...options,
        threadId: attemptedThreadId,
        onThreadLoaded: (threadId) => {
          attemptedThreadId = threadId;
          options.onThreadLoaded?.(threadId);
        },
      };
      try {
        return await this.runTurnAttempt(attemptOptions);
      } catch (error) {
        if (
          attemptedThreadId &&
          !compactionStateRetried &&
          isInvalidCompactionBlobError(error)
        ) {
          compactionStateRetried = true;
          this.forgetThread(attemptedThreadId);
          workerLogger.warn(
            "Codex rejected stored compaction state; retrying the turn on a fresh thread",
            {
              chatId: options.chatId,
              providerKind: options.provider.kind,
              staleThreadId: attemptedThreadId,
            },
          );
          attemptedThreadId = null;
          continue;
        }
        if (!isServerOverloadedError(error)) throw error;
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
        options.onActivity?.(
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
        const controller = new AbortController();
        const pendingRetry = { controller, threadId: error.threadId };
        this.#pendingCapacityRetries.set(options.chatId, pendingRetry);
        try {
          await waitForCapacityRetry(delayMs, controller.signal);
          options.onActivity?.(
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
      }
    }
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
    const threadId = await this.loadThread(options);
    if (!threadId) {
      throw new Error("Could not start a Codex thread.");
    }
    options.onThreadLoaded?.(threadId);
    if (this.methodAvailable("thread/goal/get")) {
      await this.refreshGoal(threadId);
    }
    const collaborationMode = this.methodAvailable("collaborationMode/list")
      ? await this.updatePlanModeOnThread(
          threadId,
          options.planMode,
          options.model,
        )
      : null;
    if (options.planMode === "plan" && !collaborationMode) {
      throw new Error(
        "Plan Mode is unavailable in the installed Codex runtime.",
      );
    }
    const turnPolicy = codexWorktreeTurnPolicy({
      ...options,
      permissionProfileActive: this.permissionProfilesSupported(),
    });

    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }

    let activeTurn: ActiveTurn | undefined;
    const completion = new Promise<AgentTurnResult | AgentOperationResult>(
      (resolve, reject) => {
        activeTurn = {
          agentScope: null,
          baseline,
          captureProtectedDiagnostics: options.captureProtectedDiagnostics,
          chatId: options.chatId,
          collaborationMode,
          commandTelemetry: new Map(),
          completedCommandIds: new Set(),
          cwd: options.cwd,
          delta: "",
          diffChanges: [],
          durationMs: null,
          executionKind: "chat",
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

    const availableSkills = options.skillNames.length
      ? await this.listSkills(options)
      : [];
    const selectedSkills = new Map(
      availableSkills.flatMap((skill) =>
        skill.path ? ([[skill.name, skill]] as const) : [],
      ),
    );
    if (!activeTurn) {
      throw new Error("Could not initialize the Codex turn.");
    }
    this.#activeTurnsByThread.set(threadId, activeTurn);
    this.registerRootExecution(activeTurn);
    let response: TurnStartResponse;
    try {
      response = (await this.request("turn/start", {
        threadId,
        ...codexWorkspaceContext(options.cwd),
        ...turnPolicy,
        clientUserMessageId: `cantrip:${options.clientMessageId}`,
        input: [
          ...(await this.turnAttachmentInputs(
            options.prompt,
            options.attachments ?? [],
            options.model,
            options.provider,
          )),
          ...options.skillNames.flatMap((name) => {
            const skill = selectedSkills.get(name);
            return skill?.path
              ? [{ type: "skill", name: skill.name, path: skill.path }]
              : [];
          }),
        ],
        model: options.model.name,
        ...codexReasoningEffortParams(options.model),
        ...(collaborationMode ? { collaborationMode } : {}),
        ...(resultMode.kind === "structured"
          ? { outputSchema: resultMode.outputSchema }
          : {}),
      })) as TurnStartResponse;
    } catch (error) {
      this.releaseActiveTurn(activeTurn);
      throw error;
    }
    this.bindTurnStartResponse(response.turn.id, activeTurn);
    if (options.captureProtectedDiagnostics) {
      emitTurnActivity(
        activeTurn,
        assembledInstructionContextActivity({
          active: activeTurn,
          hasGitMetadata: await workspaceHasGitMetadata(options.cwd),
          options,
          runtimeVersion: this.compatibility.version?.raw ?? null,
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
      model: options.model.name,
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
          commandTelemetry: new Map(),
          completedCommandIds: new Set(),
          cwd: options.cwd,
          delta: "",
          diffChanges: [],
          durationMs: null,
          executionKind: "operation",
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
    this.#activeTurnsByThread.set(threadId, activeTurn);
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
      const current = [...this.#activeTurns.entries()].find(
        ([, candidate]) => candidate === activeTurn,
      );
      if (!current || this.#activeTurnsByThread.get(threadId) !== activeTurn) {
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
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
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
        threadId: null,
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
  ): Promise<string> {
    await this.ensureStarted(model, provider);
    if (!this.#remoteUrl) {
      throw new Error("Codex app-server did not announce a remote endpoint.");
    }
    return this.#remoteUrl;
  }

  async syncThread(
    options: Pick<
      RunAgentTurnOptions,
      "cwd" | "executionProfile" | "model" | "provider" | "threadId"
    > & { threadId: string },
  ): Promise<AgentThreadSync> {
    await this.ensureStarted(
      options.model,
      options.provider,
      null,
      options.executionProfile,
    );
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
    > & { threadId: string },
  ): Promise<void> {
    await this.ensureStarted(
      options.model,
      options.provider,
      null,
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
    await this.ensureStarted(
      options.model,
      options.provider,
      null,
      options.executionProfile,
    );
    const threadId = await this.loadThread(options, false);
    if (!threadId) {
      throw new Error(
        "The Codex thread is no longer available on this worker.",
      );
    }
    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }
    await this.request("thread/compact/start", { threadId });
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
    await this.ensureStarted(
      options.model,
      options.provider,
      null,
      options.executionProfile,
    );
    const threadId = await this.loadThread(options, false);
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
    if (this.methodAvailable("thread/revert")) {
      try {
        await this.request("thread/revert", {
          threadId,
          beforeTurnId: boundary.turnId,
        });
      } catch (error) {
        if (!/paginated|not supported/iu.test(String(error))) throw error;
        await this.request("thread/rollback", {
          threadId,
          numTurns: boundary.numTurns,
        });
      }
    } else {
      await this.request("thread/rollback", {
        threadId,
        numTurns: boundary.numTurns,
      });
    }
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

  async getGoal(
    options: GoalRuntimeOptions & { threadId: string },
  ): Promise<ChatGoalResponse> {
    await this.ensureStarted(options.model, options.provider);
    if (!this.methodAvailable("thread/goal/get")) {
      return chatGoalResponseSchema.parse({ goal: null });
    }
    const threadId = await this.loadThread(options, false);
    if (!threadId) {
      throw new Error(
        "The Codex thread is no longer available on this worker.",
      );
    }
    return this.refreshGoal(threadId);
  }

  async createGoal(
    options: GoalRuntimeOptions & {
      objective: string;
      tokenBudget?: number | null;
    },
  ): Promise<ChatGoalResponse> {
    await this.ensureStarted(options.model, options.provider);
    const threadId = await this.loadThread(options);
    if (!threadId) {
      throw new Error("Could not start a Codex thread for the goal.");
    }
    const existing = await this.refreshGoal(threadId);
    if (existing.goal?.status === "complete") {
      const cleared = chatGoalClearSchema.parse(
        await this.request("thread/goal/clear", { threadId }),
      );
      if (!cleared.cleared) {
        throw new Error("Could not replace the completed Codex goal.");
      }
      this.#goals.delete(threadId);
    }
    const response = chatGoalResponseSchema.parse(
      await this.request("thread/goal/set", {
        threadId,
        objective: options.objective,
        status: "active",
        tokenBudget: options.tokenBudget ?? null,
      }),
    );
    this.cacheGoal(response);
    return response;
  }

  async updateGoal(
    options: GoalRuntimeOptions & {
      status: "active" | "paused";
      threadId: string;
    },
  ): Promise<ChatGoalResponse> {
    await this.ensureStarted(options.model, options.provider);
    const threadId = await this.loadThread(options, false);
    if (!threadId) {
      throw new Error(
        "The Codex thread is no longer available on this worker.",
      );
    }
    const response = chatGoalResponseSchema.parse(
      await this.request("thread/goal/set", {
        threadId,
        status: options.status,
      }),
    );
    this.cacheGoal(response);
    return response;
  }

  async clearGoal(
    options: GoalRuntimeOptions & { threadId: string },
  ): Promise<{ cleared: boolean }> {
    await this.ensureStarted(options.model, options.provider);
    const threadId = await this.loadThread(options, false);
    if (!threadId) {
      throw new Error(
        "The Codex thread is no longer available on this worker.",
      );
    }
    const response = chatGoalClearSchema.parse(
      await this.request("thread/goal/clear", { threadId }),
    );
    if (response.cleared) this.#goals.delete(threadId);
    return response;
  }

  async getPlanMode(
    options: GoalRuntimeOptions & { fallbackMode: PlanMode },
  ): Promise<{ mode: PlanMode; threadId: string | null }> {
    await this.ensureStarted(options.model, options.provider);
    const threadId = await this.loadThread(options, false);
    if (!threadId) {
      return { mode: options.fallbackMode, threadId: null };
    }
    const knownMode = this.#collaborationModes.get(threadId);
    if (knownMode) return { mode: knownMode, threadId };
    await this.updatePlanModeOnThread(
      threadId,
      options.fallbackMode,
      options.model,
    );
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

  async answerAgentInteraction(
    requestKey: string,
    response: AgentInteractionResponse,
  ): Promise<{ accepted: true }> {
    const pending = this.#pendingAgentInteractions.get(requestKey);
    if (!pending) {
      throw new Error("The agent interaction is no longer pending.");
    }
    if (pending.request.payload.kind !== response.kind) {
      throw new Error("The agent interaction response kind does not match.");
    }
    this.send({
      id: pending.rpcId,
      result: codexResultForAgentInteraction(response),
    });
    this.releaseAgentInteraction(pending);
    return agentInteractionAcceptedSchema.parse({ accepted: true });
  }

  async cancelAgentInteraction(
    requestKey: string,
    reason: string,
  ): Promise<{ accepted: true }> {
    const pending = this.#pendingAgentInteractions.get(requestKey);
    if (!pending) {
      return agentInteractionAcceptedSchema.parse({ accepted: true });
    }
    this.send({
      id: pending.rpcId,
      ...failClosedAgentInteractionReply(pending.request.payload.kind, reason),
    });
    this.releaseAgentInteraction(pending);
    return agentInteractionAcceptedSchema.parse({ accepted: true });
  }

  async interruptChat(
    chatId: string,
    threadId: string | null,
  ): Promise<{ interrupted: boolean }> {
    const active = findActiveChatTurn(this.#activeTurns, chatId, threadId);
    if (!active) {
      const pendingRetry = this.#pendingCapacityRetries.get(chatId);
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
    try {
      await this.request("turn/interrupt", {
        threadId: active[1].threadId,
        turnId: active[0],
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
  ): Promise<{ steered: true; turnId: string }> {
    const active = [...this.#activeTurns.entries()].find(
      ([, turn]) =>
        (threadId && turn.threadId === threadId) || turn.chatId === chatId,
    );
    if (!active) {
      throw new Error("The Codex thread does not have an active turn.");
    }
    const activeThreadId = active[1].threadId;
    const result = (await this.request("turn/steer", {
      threadId: activeThreadId,
      input: await this.turnAttachmentInputs(
        prompt,
        attachments,
        model,
        provider,
      ),
      expectedTurnId: active[0],
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
        activeTurns: this.#activeTurns.size,
        pendingRequests: this.#pending.size,
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
    this.#externalChatGptAuth = null;
    this.#diagnosticSecrets.clear();
    this.#runtimeIsZai = false;
    this.#starting = null;
    this.#loadedThreads.clear();
    for (const execution of this.#rootExecutionsByActive.values()) {
      for (const state of execution.agents.values()) {
        clearTurnInspectionTelemetry(state);
      }
    }
    this.#rootExecutionsByActive.clear();
    this.#rootExecutionsByThread.clear();
    this.#orphanAgentThreads.clear();
    this.#knownAgentThreads.clear();
    this.#mcpConfigFingerprintsByThread.clear();
    this.#readyMcpConfigFingerprintsByThread.clear();
    this.#permissionProfilesByThread.clear();
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
  ): Promise<Array<Record<string, unknown>>> {
    const imageSupport =
      model && provider && attachments.some(({ kind }) => kind === "image")
        ? await this.modelSupportsImages(model, provider)
        : false;
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
    const socket = this.#socket;
    const child = this.#child;
    this.#socket = null;
    this.#child = null;
    this.#remoteUrl = null;
    this.#runtimeId = null;
    this.#runtimeStartedAtMs = null;
    this.#externalChatGptAuth = null;
    this.#diagnosticSecrets.clear();
    this.#runtimeIsZai = false;
    this.#loadedThreads.clear();
    this.#mcpConfigFingerprintsByThread.clear();
    this.#readyMcpConfigFingerprintsByThread.clear();
    this.#permissionProfilesByThread.clear();
    this.#collaborationModes.clear();
    this.#externalImportStatuses.clear();
    this.#externalTurnBaselines.clear();
    this.#externalThreadChanges.clear();
    this.#mcpOauthStatuses.clear();
    this.#skillRoots = [];
    socket?.close();
    child?.kill("SIGINT");
  }

  private async ensureManagedMcpReady(
    threadId: string,
    servers: NonNullable<RunAgentTurnOptions["mcpServers"]>,
    fingerprint: string,
  ): Promise<void> {
    const requirements = managedMcpToolRequirements(servers);
    if (!requirements.length) return;
    if (
      this.#readyMcpConfigFingerprintsByThread.get(threadId) === fingerprint
    ) {
      return;
    }
    if (!this.methodAvailable("mcpServerStatus/list")) {
      throw new Error(
        "The installed Codex runtime cannot verify required managed MCP servers.",
      );
    }

    const startedAtMs = Date.now();
    const deadline = startedAtMs + 10_000;
    let lastError: unknown = null;
    do {
      try {
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        const available = new Map<string, Set<string>>();
        do {
          const page = parseMcpServerPage(
            await this.request("mcpServerStatus/list", {
              cursor,
              detail: "toolsAndAuthOnly",
              limit: 100,
              threadId,
            }),
          );
          for (const status of page.servers) {
            const key = status.name.trim().toLowerCase();
            if (!available.has(key)) available.set(key, new Set());
            for (const tool of status.tools) {
              available.get(key)!.add(tool.name);
            }
          }
          if (
            requirements.every(({ name, tool }) =>
              available.get(name)?.has(tool),
            )
          ) {
            this.#readyMcpConfigFingerprintsByThread.set(threadId, fingerprint);
            workerLogger.event("info", "Managed MCP servers are ready", {
              event: "codex.mcp.ready",
              subsystem: "codex",
              operation: "prepare-managed-mcp",
              status: "ready",
              threadId,
              durationMs: Date.now() - startedAtMs,
              counts: { tools: requirements.length },
            });
            return;
          }
          cursor = page.nextCursor;
          if (cursor && seenCursors.has(cursor)) break;
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
      } catch (error) {
        lastError = error;
      }
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } while (Date.now() < deadline);

    workerLogger.event("error", "Managed MCP servers did not become ready", {
      event: "codex.mcp.ready",
      subsystem: "codex",
      operation: "prepare-managed-mcp",
      reasonCode: "managed-mcp-unavailable",
      status: "failed",
      threadId,
      durationMs: Date.now() - startedAtMs,
      error: lastError ? workerLogError(lastError) : undefined,
    });
    throw new Error(
      `Required managed MCP tools did not become ready: ${requirements
        .map(({ name, tool }) => `${name}/${tool}`)
        .join(", ")}.`,
      lastError ? { cause: lastError } : undefined,
    );
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
    },
    create = true,
  ): Promise<string | null> {
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
    const mcpConfigFingerprint = mcpConfig ? JSON.stringify(mcpConfig) : null;
    const hasGitMetadata = await workspaceHasGitMetadata(options.cwd);
    let threadId = options.threadId;
    if (
      threadId &&
      (!this.#loadedThreads.has(threadId) ||
        this.#permissionProfilesByThread.get(threadId) !== permissionKey ||
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
          this.#loadedThreads.has(threadId) &&
          this.#mcpConfigFingerprintsByThread.get(threadId) !==
            threadConfigFingerprint
        ) {
          await this.request("thread/unsubscribe", { threadId });
        }
        const resumed = (await this.request("thread/resume", {
          threadId,
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
          ),
          config: threadConfig,
        })) as ThreadResponse;
        threadId = resumed.thread.id;
        this.#loadedThreads.add(threadId);
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
        // Codex thread state is local to its worker/runtime. A normal turn can
        // recover from replacement by starting a new thread; compaction cannot.
        workerLogger.event("warn", "Codex chat thread resume fell back", {
          event: "codex.thread.resume",
          subsystem: "codex",
          operation: "resume-chat-thread",
          status: "recovering",
          reasonCode: "thread-resume-failed",
          threadId: requestedThreadId,
          durationMs: Date.now() - startedAtMs,
          error: workerLogError(error),
          ...codexProviderLogContext(options.provider),
        });
        threadId = null;
      }
    }
    if (!threadId && create) {
      const startedAtMs = Date.now();
      const started = (await this.request("thread/start", {
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
        ),
        config: threadConfig,
      })) as ThreadResponse;
      threadId = started.thread.id;
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
    if (threadId && mcpConfigFingerprint !== null && options.mcpServers) {
      await this.ensureManagedMcpReady(
        threadId,
        options.mcpServers,
        mcpConfigFingerprint,
      );
    }
    return threadId;
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
    await this.ensureManagedMcpReady(
      threadId,
      options.mcpServers,
      mcpConfigFingerprint,
    );
    return threadId;
  }

  private hasActiveThread(threadId: string): boolean {
    return this.#rootExecutionsByThread.has(threadId);
  }

  private agentScope(
    execution: RootExecution,
    state: AgentRuntimeState | null,
  ): AgentScope | null {
    if (!execution.rootTurnId) return null;
    return {
      agentThreadId: state?.threadId ?? execution.rootThreadId,
      rootThreadId: execution.rootThreadId,
      parentThreadId: state?.parentThreadId ?? null,
      rootTurnId: execution.rootTurnId,
      agentPath: state?.agentPath ?? ["root"],
      nickname: state?.nickname ?? null,
      role: state?.role ?? null,
      depth: state?.depth ?? 0,
      isRoot: state === null,
    };
  }

  private refreshExecutionScopes(execution: RootExecution): void {
    execution.active.agentScope = this.agentScope(execution, null);
    for (const state of execution.agents.values()) {
      state.agentScope = this.agentScope(execution, state);
    }
  }

  private registerRootExecution(active: ActiveTurn): RootExecution {
    const existing = this.#rootExecutionsByActive.get(active);
    if (existing) return existing;
    const execution: RootExecution = {
      active,
      agents: new Map(),
      rootThreadId: active.threadId,
      rootTurnId: null,
    };
    this.#rootExecutionsByActive.set(active, execution);
    this.#rootExecutionsByThread.set(active.threadId, execution);
    this.associateWaitingAgentThreads(active.threadId);
    return execution;
  }

  private bindRootTurn(execution: RootExecution, turnId: string): void {
    if (execution.rootTurnId !== turnId) {
      execution.rootTurnId = turnId;
      execution.active.observedActivityFingerprints.clear();
      for (const state of execution.agents.values()) {
        state.segmentTurnIds.clear();
        state.observedActivityFingerprints.clear();
        state.liveAgentMessageFingerprints.clear();
      }
      this.refreshExecutionScopes(execution);
    }
    for (const [knownTurnId, candidate] of this.#activeTurns) {
      if (candidate === execution.active && knownTurnId !== turnId) {
        this.#activeTurns.delete(knownTurnId);
      }
    }
    this.#activeTurns.set(turnId, execution.active);
  }

  private childFallbackPath(
    execution: RootExecution,
    metadata: ChildThreadMetadata,
  ): string[] {
    const parent = execution.agents.get(metadata.parentThreadId);
    const parentPath = parent?.agentPath ?? ["root"];
    const label = metadata.nickname ?? `agent-${metadata.threadId.slice(-8)}`;
    return [...parentPath, label].slice(0, 32);
  }

  private createAgentRuntimeState(
    execution: RootExecution,
    metadata: ChildThreadMetadata,
  ): AgentRuntimeState {
    const active = execution.active;
    const parent = execution.agents.get(metadata.parentThreadId);
    const path = agentPathSegments(metadata.agentPath);
    const now = Date.now();
    const state: AgentRuntimeState = {
      agentScope: null,
      agentPath:
        path.length > 0 ? path : this.childFallbackPath(execution, metadata),
      captureProtectedDiagnostics: active.captureProtectedDiagnostics,
      commandTelemetry: new Map(),
      completedCommandIds: new Set(),
      currentTurnId: null,
      cwd: active.cwd,
      delta: "",
      depth: metadata.depth ?? Math.min((parent?.depth ?? 0) + 1, 32),
      diffChanges: [],
      fileStartedAtMs: new Map(),
      finalText: null,
      itemStartedAtMs: new Map(),
      lastActiveAtMs: now,
      latestUsage: null,
      liveAgentMessageFingerprints: new Set(),
      observedActivityFingerprints: new Set(),
      nickname: metadata.nickname ?? null,
      onActivity: active.onActivity,
      onMessage: active.onMessage,
      parentThreadId: metadata.parentThreadId,
      pendingActivities: new Map(),
      pendingAgentMessage: null,
      reasoningSummaries: new Map(),
      role: metadata.role ?? null,
      segmentTurnIds: new Set(),
      startedAtMs: now,
      status: "starting",
      streamingAgentMessage: null,
      structuredChat: false,
      threadId: metadata.threadId,
    };
    state.agentScope = this.agentScope(execution, state);
    return state;
  }

  private rememberOrphanAgentThread(metadata: ChildThreadMetadata): void {
    if (
      !this.#orphanAgentThreads.has(metadata.threadId) &&
      this.#orphanAgentThreads.size >= MAX_ORPHAN_AGENT_THREADS
    ) {
      const oldest = this.#orphanAgentThreads.keys().next().value;
      if (oldest !== undefined) this.#orphanAgentThreads.delete(oldest);
    }
    this.#orphanAgentThreads.set(metadata.threadId, metadata);
  }

  private rememberKnownAgentThread(metadata: ChildThreadMetadata): void {
    if (
      !this.#knownAgentThreads.has(metadata.threadId) &&
      this.#knownAgentThreads.size >= MAX_KNOWN_AGENT_THREADS
    ) {
      const oldest = this.#knownAgentThreads.keys().next().value;
      if (oldest !== undefined) this.#knownAgentThreads.delete(oldest);
    }
    this.#knownAgentThreads.set(metadata.threadId, metadata);
  }

  private associateAgentThread(
    input: ChildThreadMetadata,
  ): AgentRuntimeState | null {
    const remembered = this.#knownAgentThreads.get(input.threadId);
    const metadata: ChildThreadMetadata = {
      ...remembered,
      ...input,
      agentPath: input.agentPath ?? remembered?.agentPath,
      depth: input.depth ?? remembered?.depth,
      nickname: input.nickname ?? remembered?.nickname,
      role: input.role ?? remembered?.role,
    };
    const execution = this.#rootExecutionsByThread.get(metadata.parentThreadId);
    if (!execution) {
      this.rememberOrphanAgentThread(metadata);
      return null;
    }
    if (metadata.threadId === execution.rootThreadId) return null;
    const existing = execution.agents.get(metadata.threadId);
    if (existing) {
      existing.parentThreadId = metadata.parentThreadId;
      existing.nickname = metadata.nickname ?? existing.nickname;
      existing.role = metadata.role ?? existing.role;
      existing.depth =
        metadata.depth ??
        Math.min(
          (execution.agents.get(metadata.parentThreadId)?.depth ?? 0) + 1,
          32,
        );
      const path = agentPathSegments(metadata.agentPath);
      if (path.length > 0) existing.agentPath = path;
      existing.agentScope = this.agentScope(execution, existing);
      this.#orphanAgentThreads.delete(metadata.threadId);
      this.rememberKnownAgentThread(metadata);
      return existing;
    }
    if (execution.agents.size >= MAX_AGENT_THREADS_PER_EXECUTION) return null;
    const state = this.createAgentRuntimeState(execution, metadata);
    execution.agents.set(metadata.threadId, state);
    this.#rootExecutionsByThread.set(metadata.threadId, execution);
    this.#orphanAgentThreads.delete(metadata.threadId);
    this.rememberKnownAgentThread(metadata);
    this.associateWaitingAgentThreads(metadata.threadId);
    return state;
  }

  private associateWaitingAgentThreads(parentThreadId: string): void {
    const waiting = [...this.#orphanAgentThreads.values()].filter(
      (candidate) => candidate.parentThreadId === parentThreadId,
    );
    for (const metadata of waiting) this.associateAgentThread(metadata);
  }

  private updateAgentStatus(
    state: AgentRuntimeState,
    status: AgentRuntimeStatus,
  ): void {
    state.status = status;
    state.lastActiveAtMs = Date.now();
  }

  private emitAgentCommunication(input: {
    diagnosticId: string | null;
    itemId?: string | null;
    kind: AgentCommunicationKind;
    message?: string | null;
    milestoneId?: string | null;
    sourceMethod: string;
    state: AgentRuntimeState;
    status: AgentActivity["status"];
    turnId?: string | null;
  }): void {
    if (!input.state.agentScope) return;
    const milestoneId =
      input.milestoneId ??
      ((input.kind === "returned" ||
        input.kind === "failed" ||
        input.kind === "interrupted") &&
      input.turnId
        ? `${input.kind}:${input.turnId}`
        : input.kind);
    emitTurnActivity(
      input.state,
      agentActivitySchema.parse({
        type: "agentCommunication",
        id: `agent:${input.state.agentScope.rootTurnId}:${input.state.threadId}:${milestoneId}`,
        kind: input.kind,
        senderThreadId:
          input.kind === "spawned" || input.kind === "followupSent"
            ? input.state.parentThreadId
            : input.state.threadId,
        receiverThreadIds:
          input.kind === "spawned" || input.kind === "followupSent"
            ? [input.state.threadId]
            : [input.state.parentThreadId],
        message: boundedText(input.message, 100_000),
        status: input.status,
        updatedAtMs: Date.now(),
        correlation: eventCorrelation(
          input.sourceMethod,
          input.diagnosticId,
          input.state.threadId,
          input.turnId ?? input.state.currentTurnId,
          input.itemId ?? null,
        ),
      }),
    );
  }

  private collaborationAgentStatus(value: string): AgentRuntimeStatus {
    const normalized = value.toLowerCase();
    if (normalized.includes("interrupt")) return "interrupted";
    if (
      normalized.includes("fail") ||
      normalized.includes("error") ||
      normalized.includes("notfound")
    ) {
      return "failed";
    }
    if (
      normalized.includes("complete") ||
      normalized.includes("done") ||
      normalized.includes("shutdown")
    ) {
      return "completed";
    }
    if (normalized.includes("idle") || normalized.includes("wait")) {
      return "idle";
    }
    return "running";
  }

  private associateAgentsFromItem(
    item: CodexThreadItem,
    notificationThreadId: string,
    notificationTurnId: string,
    sourceMethod: string,
    diagnosticId: string | null,
  ): void {
    if (item.type === "collabAgentToolCall") {
      const parentThreadId = this.#rootExecutionsByThread.has(
        item.senderThreadId,
      )
        ? item.senderThreadId
        : notificationThreadId;
      const targetThreadIds = new Set([
        ...item.receiverThreadIds,
        ...Object.keys(item.agentsStates),
      ]);
      for (const threadId of targetThreadIds) {
        if (threadId === parentThreadId) continue;
        const state = this.associateAgentThread({
          threadId,
          parentThreadId,
        });
        const advertised = item.agentsStates[threadId];
        if (state && advertised?.status) {
          this.updateAgentStatus(
            state,
            this.collaborationAgentStatus(advertised.status),
          );
        }
        if (state) {
          const tool = item.tool.replaceAll("_", "").toLowerCase();
          const advertisedMessage = boundedText(advertised?.message, 100_000);
          const kind: AgentCommunicationKind =
            tool === "spawnagent"
              ? "spawned"
              : tool === "sendinput" || tool === "resumeagent"
                ? "followupSent"
                : tool === "wait" && advertisedMessage
                  ? "returned"
                  : tool === "wait"
                    ? "waiting"
                    : "statusChanged";
          this.emitAgentCommunication({
            diagnosticId,
            itemId: item.id,
            kind,
            message:
              kind === "returned" ? advertisedMessage : (item.prompt ?? null),
            milestoneId: kind === "spawned" ? "spawn" : `${kind}:${item.id}`,
            sourceMethod,
            state,
            status:
              item.status === "inProgress"
                ? "running"
                : item.status === "failed"
                  ? "failed"
                  : "completed",
            turnId: notificationTurnId,
          });
        }
      }
      return;
    }
    if (
      item.type === "subAgentActivity" &&
      item.agentThreadId !== notificationThreadId
    ) {
      const state = this.associateAgentThread({
        threadId: item.agentThreadId,
        parentThreadId: notificationThreadId,
        agentPath: item.agentPath,
      });
      if (state) {
        this.updateAgentStatus(
          state,
          item.kind === "interrupted"
            ? "interrupted"
            : item.kind === "interacted"
              ? "idle"
              : "running",
        );
      }
    }
  }

  private async discoverSubagentThreads(
    execution: RootExecution,
  ): Promise<void> {
    if (!this.methodAvailable("thread/list")) return;
    let cursor: string | null = null;
    let discovered = 0;
    do {
      const response = (await this.request(
        "thread/list",
        {
          ancestorThreadId: execution.rootThreadId,
          cursor,
          limit: Math.min(100, MAX_RECOVERED_AGENT_THREADS - discovered),
          sortKey: "created_at",
          sortDirection: "asc",
          useStateDbOnly: true,
        },
        COMPLETED_TURN_RECONCILIATION_TIMEOUT_MS,
      )) as CodexThreadListResponse;
      if (!Array.isArray(response.data)) {
        throw new Error("Codex returned an invalid descendant thread page.");
      }
      for (const thread of response.data) {
        const metadata = childThreadMetadataFromNotification({ thread });
        if (metadata) this.associateAgentThread(metadata);
      }
      discovered += response.data.length;
      cursor = optionalString(response.nextCursor);
    } while (cursor && discovered < MAX_RECOVERED_AGENT_THREADS);
  }

  private recoveredAgentTurns(
    response: CodexThreadReadResponse,
    state: AgentRuntimeState,
    executionStartedAtMs: number,
    executionCompletedAtMs: number,
  ): CodexThreadTurn[] {
    const windowStart = executionStartedAtMs - RECOVERY_TURN_CLOCK_SLOP_MS;
    const windowEnd = executionCompletedAtMs + RECOVERY_TURN_CLOCK_SLOP_MS;
    return response.thread.turns
      .filter((turn) => {
        if (state.segmentTurnIds.has(turn.id)) return true;
        if (turn.startedAt === null) return false;
        const startedAtMs = turn.startedAt * 1_000;
        return startedAtMs >= windowStart && startedAtMs <= windowEnd;
      })
      .slice(-MAX_RECOVERED_TURNS_PER_AGENT)
      .map((turn) => ({
        ...turn,
        items: turn.items.slice(-MAX_RECOVERED_ITEMS_PER_TURN),
      }));
  }

  private async reconcileAgentThread(
    execution: RootExecution,
    state: AgentRuntimeState,
    executionCompletedAtMs: number,
  ): Promise<void> {
    const response = (await this.request(
      "thread/read",
      { threadId: state.threadId, includeTurns: true },
      COMPLETED_TURN_RECONCILIATION_TIMEOUT_MS,
    )) as CodexThreadReadResponse;
    const metadata = childThreadMetadataFromNotification({
      thread: response.thread,
    });
    if (metadata) this.associateAgentThread(metadata);
    const turns = this.recoveredAgentTurns(
      response,
      state,
      execution.active.startedAtMs,
      executionCompletedAtMs,
    );
    for (const turn of turns) {
      state.segmentTurnIds.add(turn.id);
      const normalized = normalizeCodexThreadTurn(
        turn,
        execution.active.cwd,
        state.threadId,
      );
      for (const item of normalized.items) {
        if (item.type === "userMessage") {
          this.emitAgentCommunication({
            diagnosticId: null,
            itemId: item.id,
            kind:
              response.thread.turns[0]?.id === turn.id
                ? "spawned"
                : "followupSent",
            message: item.text || null,
            milestoneId:
              response.thread.turns[0]?.id === turn.id
                ? "spawn"
                : `followupSent:${item.id}`,
            sourceMethod: "thread/read",
            state,
            status: "completed",
            turnId: turn.id,
          });
          continue;
        }
        if (item.type === "agentMessage") {
          const { type: _type, ...message } = item;
          const scoped = normalizedAgentMessageSchema.parse({
            ...message,
            agentScope: state.agentScope,
          });
          const fingerprint = agentMessageFingerprint(scoped);
          if (state.liveAgentMessageFingerprints.has(fingerprint)) continue;
          state.liveAgentMessageFingerprints.add(fingerprint);
          state.onMessage?.(scoped);
          continue;
        }
        const scoped = scopedAgentActivity(state, item.activity);
        if (
          state.observedActivityFingerprints.has(
            agentActivityDeliveryFingerprint(scoped),
          )
        ) {
          continue;
        }
        emitTurnActivity(state, item.activity);
      }
      if (turn.status !== "inProgress") {
        const status =
          turn.status === "completed"
            ? "completed"
            : turn.status === "interrupted"
              ? "interrupted"
              : "failed";
        this.updateAgentStatus(state, status);
        this.emitAgentCommunication({
          diagnosticId: null,
          kind:
            status === "completed"
              ? "returned"
              : status === "interrupted"
                ? "interrupted"
                : "failed",
          sourceMethod: "thread/read",
          state,
          status: status === "completed" ? "completed" : "failed",
          turnId: turn.id,
        });
      }
    }
  }

  private async reconcileSubagentExecution(
    active: ActiveTurn,
    executionCompletedAtMs: number,
  ): Promise<void> {
    if (active.executionKind !== "chat") return;
    const execution = this.#rootExecutionsByActive.get(active);
    if (!execution?.rootTurnId || (!active.onActivity && !active.onMessage)) {
      return;
    }
    try {
      await this.discoverSubagentThreads(execution);
    } catch (error) {
      workerLogger.event(
        "warn",
        "Could not discover descendant Codex threads",
        {
          event: "codex.subagent.reconciliation",
          subsystem: "codex",
          operation: "list-descendant-threads",
          status: "failed",
          chatId: active.chatId ?? undefined,
          threadId: execution.rootThreadId,
          turnId: execution.rootTurnId,
          error: workerLogError(error),
        },
      );
    }
    const states = [...execution.agents.values()]
      .sort((left, right) => left.depth - right.depth)
      .slice(0, MAX_RECOVERED_AGENT_THREADS);
    for (let offset = 0; offset < states.length; offset += 4) {
      await Promise.all(
        states.slice(offset, offset + 4).map(async (state) => {
          try {
            await this.reconcileAgentThread(
              execution,
              state,
              executionCompletedAtMs,
            );
          } catch (error) {
            workerLogger.event(
              "warn",
              "Could not reconcile a descendant Codex thread",
              {
                event: "codex.subagent.reconciliation",
                subsystem: "codex",
                operation: "read-descendant-thread",
                status: "failed",
                chatId: active.chatId ?? undefined,
                threadId: state.threadId,
                turnId: execution.rootTurnId ?? undefined,
                error: workerLogError(error),
              },
            );
          }
        }),
      );
    }
  }

  private settleDescendantsAtRootBoundary(
    execution: RootExecution,
    rootStatus: TurnCompletedParams["turn"]["status"],
    observedAtMs: number,
    diagnosticId: string | null,
  ): void {
    for (const state of execution.agents.values()) {
      const runtimeStatus: AgentRuntimeStatus =
        state.status === "completed" || state.status === "idle"
          ? "completed"
          : state.status === "failed" || state.status === "interrupted"
            ? state.status
            : rootStatus === "failed"
              ? "failed"
              : "interrupted";
      const childCompleted = runtimeStatus === "completed";
      const settledStatus = childCompleted ? "completed" : "failed";
      const turnId = state.currentTurnId;
      if (turnId) {
        const correlation = eventCorrelation(
          "turn/completed",
          diagnosticId,
          state.threadId,
          turnId,
          null,
        );
        for (const telemetry of state.commandTelemetry.values()) {
          clearCommandFlush(telemetry);
          telemetry.updatedAtMs = observedAtMs;
          emitCommandTelemetry(state, telemetry, observedAtMs, settledStatus);
        }
        settlePendingTurnActivities(
          state,
          settledStatus,
          observedAtMs,
          correlation,
        );
        flushActiveAgentMessage(state, childCompleted);
        emitTurnActivity(
          state,
          turnSummaryActivity(
            {
              id: turnId,
              status: childCompleted ? "completed" : "interrupted",
              startedAt: Math.floor(state.startedAtMs / 1_000),
              completedAt: Math.floor(observedAtMs / 1_000),
              durationMs: Math.max(0, observedAtMs - state.startedAtMs),
            },
            correlation,
          ),
        );
      }
      state.currentTurnId = null;
      this.updateAgentStatus(state, runtimeStatus);
      this.emitAgentCommunication({
        diagnosticId,
        kind:
          runtimeStatus === "completed"
            ? "returned"
            : runtimeStatus === "failed"
              ? "failed"
              : "interrupted",
        sourceMethod: "turn/completed",
        state,
        status: runtimeStatus === "completed" ? "completed" : "failed",
        turnId,
      });
      clearTurnInspectionTelemetry(state);
    }
  }

  private notificationTarget(
    threadId: string,
    turnId: string,
  ): AgentNotificationTarget | null {
    const execution = this.#rootExecutionsByThread.get(threadId);
    if (!execution) return null;
    if (threadId === execution.rootThreadId) {
      this.bindRootTurn(execution, turnId);
      return {
        active: execution.active,
        execution,
        isRoot: true,
        state: execution.active,
      };
    }
    const state = execution.agents.get(threadId);
    if (!state) return null;
    if (
      state.currentTurnId &&
      state.currentTurnId !== turnId &&
      state.status === "running"
    ) {
      return null;
    }
    if (state.currentTurnId !== turnId) {
      if (state.currentTurnId) {
        flushActiveAgentMessage(state, false);
        clearTurnInspectionTelemetry(state);
      }
      state.currentTurnId = turnId;
      state.delta = "";
      state.diffChanges = [];
      state.finalText = null;
      state.latestUsage = null;
      state.pendingAgentMessage = null;
      state.startedAtMs = Date.now();
      state.liveAgentMessageFingerprints.clear();
      state.observedActivityFingerprints.clear();
      state.reasoningSummaries.clear();
    }
    state.segmentTurnIds.add(turnId);
    state.status = "running";
    state.lastActiveAtMs = Date.now();
    state.agentScope = this.agentScope(execution, state);
    return {
      active: execution.active,
      execution,
      isRoot: false,
      state,
    };
  }

  private activeTurnForNotification(
    threadId: string,
    turnId: string,
  ): ActiveTurn | undefined {
    return this.notificationTarget(threadId, turnId)?.active;
  }

  private bindTurnStartResponse(turnId: string, active: ActiveTurn): void {
    this.bindRootTurn(this.registerRootExecution(active), turnId);
  }

  private releaseActiveTurn(active: ActiveTurn): void {
    if (this.#activeTurnsByThread.get(active.threadId) === active) {
      this.#activeTurnsByThread.delete(active.threadId);
    }
    for (const [turnId, candidate] of this.#activeTurns) {
      if (candidate === active) this.#activeTurns.delete(turnId);
    }
    const execution = this.#rootExecutionsByActive.get(active);
    if (!execution) return;
    const releasedThreadIds = new Set([
      execution.rootThreadId,
      ...execution.agents.keys(),
    ]);
    for (const state of execution.agents.values()) {
      clearTurnInspectionTelemetry(state);
      this.#rootExecutionsByThread.delete(state.threadId);
    }
    this.#rootExecutionsByThread.delete(execution.rootThreadId);
    this.#rootExecutionsByActive.delete(active);
    for (const [threadId, metadata] of this.#orphanAgentThreads) {
      if (
        releasedThreadIds.has(threadId) ||
        releasedThreadIds.has(metadata.parentThreadId)
      ) {
        this.#orphanAgentThreads.delete(threadId);
      }
    }
  }

  private forgetThread(threadId: string): void {
    this.#loadedThreads.delete(threadId);
    this.#mcpConfigFingerprintsByThread.delete(threadId);
    this.#readyMcpConfigFingerprintsByThread.delete(threadId);
    this.#permissionProfilesByThread.delete(threadId);
    this.#collaborationModes.delete(threadId);
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
  ): Promise<NativeCollaborationMode> {
    const collaborationMode = await this.collaborationMode(mode, model);
    if (this.#collaborationModes.get(threadId) !== mode) {
      await this.request("thread/settings/update", {
        threadId,
        collaborationMode,
      });
      this.#collaborationModes.set(threadId, mode);
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
    const runtimeProvider = this.resolveProvider
      ? await this.resolveProvider(provider)
      : provider;
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

    const stdoutLines = readline.createInterface({ input: child.stdout });
    const stderrLines = readline.createInterface({ input: child.stderr });
    const startupStderr: string[] = [];
    let startupComplete = false;
    stderrLines.on("line", (line) => {
      if (line.trimStart().startsWith("listening on:")) return;
      const diagnosticClass = codexDiagnosticClass(line);
      workerLogger.rateLimited(
        `codex-subprocess:${processRuntimeId ?? "starting"}:${diagnosticClass}`,
        diagnosticClass === "panic" || diagnosticClass === "error"
          ? "warn"
          : "debug",
        "Codex app-server emitted a subprocess diagnostic",
        {
          event: "codex.runtime.diagnostic",
          subsystem: "codex",
          operation: "subprocess-stderr",
          status: diagnosticClass,
          runtimeId: processRuntimeId,
          diagnosticClass,
        },
      );
      if (!startupComplete) {
        startupStderr.push(
          readableCodexProviderError(line, {
            secrets: this.#diagnosticSecrets,
            zai: this.#runtimeIsZai,
          }),
        );
        if (startupStderr.length > 20) startupStderr.shift();
      }
    });
    const remoteUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              "Codex app-server did not announce an endpoint within 120 seconds.",
            ),
          ),
        CODEX_STARTUP_TIMEOUT_MS,
      );
      const inspectLine = (line: string) => {
        const endpoint = codexEndpointFromLine(line);
        if (endpoint) {
          startupComplete = true;
          clearTimeout(timeout);
          resolve(endpoint);
        }
      };
      stdoutLines.on("line", inspectLine);
      stderrLines.on("line", inspectLine);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(codexStartupExitMessage(code, signal, startupStderr)));
      });
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
    const socket = new WebSocket(remoteUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              "Codex app-server WebSocket did not connect within 120 seconds.",
            ),
          ),
        CODEX_STARTUP_TIMEOUT_MS,
      );
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    this.#socket = socket;
    workerLogger.event("debug", "Codex app-server transport connected", {
      event: "codex.runtime.transport",
      subsystem: "codex",
      operation: "connect-websocket",
      status: "connected",
      runtimeId: processRuntimeId,
      durationMs: Date.now() - startedAtMs,
    });
    socket.on("message", (data: RawData) => this.handleSocketMessage(data));
    socket.on("error", (error) => {
      this.handleExit(error);
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
          activeTurns: this.#activeTurns.size,
          pendingRequests: this.#pending.size,
        },
      });
      this.handleExit(new Error("Codex app-server WebSocket closed."));
      this.#socket = null;
      this.#remoteUrl = null;
      this.#runtimeId = null;
      this.#runtimeStartedAtMs = null;
      this.#externalChatGptAuth = null;
      this.#diagnosticSecrets.clear();
      this.#runtimeIsZai = false;
      this.#starting = null;
      this.#loadedThreads.clear();
      this.#mcpConfigFingerprintsByThread.clear();
      this.#readyMcpConfigFingerprintsByThread.clear();
      this.#permissionProfilesByThread.clear();
      this.#collaborationModes.clear();
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
            activeTurns: this.#activeTurns.size,
            pendingRequests: this.#pending.size,
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
      this.#externalChatGptAuth = null;
      this.#diagnosticSecrets.clear();
      this.#runtimeIsZai = false;
      this.#starting = null;
      this.#loadedThreads.clear();
      this.#mcpConfigFingerprintsByThread.clear();
      this.#readyMcpConfigFingerprintsByThread.clear();
      this.#permissionProfilesByThread.clear();
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
      this.#externalChatGptAuth = chatGptExternalAuthSession(
        runtimeProvider,
        externalChatGptLease,
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
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const startedAtMs = Date.now();
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        workerLogger.rateLimited(
          `codex-rpc-timeout:${method}`,
          "warn",
          "Codex app-server request timed out",
          {
            event: "codex.rpc.timeout",
            subsystem: "codex",
            operation: method,
            status: "timed-out",
            runtimeId: this.#runtimeId,
            durationMs: Date.now() - startedAtMs,
          },
        );
        reject(new Error(`Codex request ${method} timed out.`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        reject,
        resolve,
        startedAtMs,
        timeout,
      });
      this.send({ id, method, params });
    });
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

    const diagnosticId = this.recordDiagnostic({
      at: new Date().toISOString(),
      direction: "from-runtime",
      kind: "message",
      method: typeof message.method === "string" ? message.method : null,
      payload: message,
    });

    if (message.id !== undefined && !message.method) {
      const id = Number(message.id);
      const pending = this.#pending.get(id);
      if (!pending) {
        this.recordDiagnostic(
          {
            at: new Date().toISOString(),
            direction: "from-runtime",
            kind: "unmatched-response",
            method: null,
            payload: message,
          },
          `Unmatched App Server response ${String(message.id)}`,
        );
        return;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      if (message.error) {
        workerLogger.rateLimited(
          `codex-rpc-failed:${pending.method}:${message.error.code}`,
          "warn",
          "Codex app-server request failed",
          {
            event: "codex.rpc.failed",
            subsystem: "codex",
            operation: pending.method,
            status: "failed",
            runtimeId: this.#runtimeId,
            durationMs: Date.now() - pending.startedAtMs,
            reasonCode: `rpc-${message.error.code}`,
          },
        );
        pending.reject(
          new Error(
            readableCodexProviderError(message.error.message, {
              secrets: this.#diagnosticSecrets,
              zai: this.#runtimeIsZai,
            }),
          ),
        );
      } else {
        workerLogger.sampled(
          `codex-rpc-completed:${pending.method}`,
          100,
          "trace",
          "Codex app-server request completed",
          {
            event: "codex.rpc.completed",
            subsystem: "codex",
            operation: pending.method,
            status: "completed",
            runtimeId: this.#runtimeId,
            durationMs: Date.now() - pending.startedAtMs,
          },
        );
        pending.resolve(message.result);
      }
      return;
    }

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

    if (message.method === "thread/settings/updated") {
      const params = message.params as ThreadSettingsUpdatedParams;
      this.#collaborationModes.set(
        params.threadId,
        params.threadSettings.collaborationMode.mode,
      );
      this.observeExternalThreadChange(params.threadId, "plan");
      return;
    }

    if (message.method === "thread/started") {
      const params = message.params as ThreadStartedParams;
      const metadata = childThreadMetadataFromNotification(params);
      if (metadata) {
        const state = this.associateAgentThread(metadata);
        if (state) {
          this.updateAgentStatus(
            state,
            nativeAgentRuntimeStatus(params.thread.status),
          );
          this.emitAgentCommunication({
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

    if (message.method === "thread/status/changed") {
      const params = message.params as ThreadStatusChangedParams;
      const execution = this.#rootExecutionsByThread.get(params.threadId);
      const state = execution?.agents.get(params.threadId);
      if (state) {
        this.updateAgentStatus(state, nativeAgentRuntimeStatus(params.status));
        this.emitAgentCommunication({
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
      const target = this.notificationTarget(params.threadId, params.turn.id);
      if (target) {
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
          ),
        );
      } else {
        this.observeExternalThreadChange(params.threadId, "turn");
      }
      return;
    }

    if (message.method === "turn/plan/updated") {
      const params = message.params as TurnPlanUpdatedParams;
      const target = this.notificationTarget(params.threadId, params.turnId);
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
      const pending = [...this.#pendingAgentInteractions.values()].find(
        (candidate) =>
          candidate.request.threadId === params.threadId &&
          String(candidate.rpcId) === String(params.requestId),
      );
      if (pending) {
        this.releaseAgentInteraction(pending);
        pending.active.onInteractionCleared?.(pending.request.requestKey);
      }
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
      const state = this.notificationTarget(
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
      const state = this.notificationTarget(
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
      const state = this.notificationTarget(
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
      const state = this.notificationTarget(
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
      const state = this.notificationTarget(
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
      this.associateAgentsFromItem(
        params.item,
        params.threadId,
        params.turnId,
        message.method,
        diagnosticId,
      );
      const state = this.notificationTarget(
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
      this.associateAgentsFromItem(
        params.item,
        params.threadId,
        params.turnId,
        message.method,
        diagnosticId,
      );
      const state = this.notificationTarget(
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
      const state = this.notificationTarget(
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
      const state = this.notificationTarget(
        params.threadId,
        params.turnId,
      )?.state;
      if (state) {
        state.latestUsage = params.tokenUsage.last;
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
      for (const [turnId, active] of this.#activeTurns) {
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
        const execution = this.#rootExecutionsByThread.get(params.threadId);
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
      for (const [turnId, active] of this.#activeTurns) {
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
      for (const [turnId, active] of this.#activeTurns) {
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
      const params = message.params as ErrorNotificationParams;
      const state = this.notificationTarget(
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
      const target = this.notificationTarget(params.threadId, params.turn.id);
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
        ),
      );
      if (!target.isRoot) {
        const agent = state as AgentRuntimeState;
        this.clearInteractionsForAgentTurn(
          active,
          params.threadId,
          params.turn.id,
          "The child Codex turn completed before the interaction was answered.",
        );
        agent.currentTurnId = null;
        this.updateAgentStatus(
          agent,
          terminalStatus === "completed"
            ? "completed"
            : terminalStatus === "interrupted"
              ? "interrupted"
              : "failed",
        );
        this.emitAgentCommunication({
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
      this.#activeTurns.delete(params.turn.id);
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
    try {
      this.clearInteractionsForTurn(
        active,
        "The Codex turn completed before the interaction was answered.",
      );
      active.diffChanges = await workspaceChanges(active);
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
      await this.reconcileSubagentExecution(active, observedAtMs);
      const execution = this.#rootExecutionsByActive.get(active);
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
        await this.replayCompletedTurn(active, turnId);
      }
      clearTurnInspectionTelemetry(active);
      if (active.executionKind === "chat" && this.#goals.has(active.threadId)) {
        const response = await this.refreshGoal(active.threadId);
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
          active.onCheckpoint?.({ text, turnId });
          active.baseline = await workspaceSnapshot(active.cwd);
          active.delta = "";
          active.diffChanges = [];
          active.finalText = null;
          active.interruptionRequestedAtMs = null;
          active.liveAgentMessageFingerprints.clear();
          active.reasoningSummaries.clear();
          active.startedAtMs = Date.now();
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
      this.releaseActiveTurn(active);
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
        model: active.model.name,
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
      this.releaseActiveTurn(active);
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

  private async refreshGoal(threadId: string): Promise<ChatGoalResponse> {
    const response = chatGoalResponseSchema.parse(
      await this.request("thread/goal/get", { threadId }),
    );
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
    try {
      if (active.timeout) {
        clearTimeout(active.timeout);
        active.timeout = null;
      }
      this.clearInteractionsForTurn(active, error.message);
      active.diffChanges = await workspaceChanges(active);
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
      await this.reconcileSubagentExecution(active, observedAtMs);
      const execution = this.#rootExecutionsByActive.get(active);
      if (execution) {
        this.settleDescendantsAtRootBoundary(
          execution,
          rootStatus,
          observedAtMs,
          diagnosticId,
        );
      }
    } finally {
      this.releaseActiveTurn(active);
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

  private clearInteractionsForTurn(active: ActiveTurn, reason: string): void {
    for (const pending of [...this.#pendingAgentInteractions.values()]) {
      if (pending.active !== active) continue;
      try {
        this.send({
          id: pending.rpcId,
          ...failClosedAgentInteractionReply(
            pending.request.payload.kind,
            reason,
          ),
        });
      } catch {
        // The turn or runtime may already be closed.
      }
      this.releaseAgentInteraction(pending);
      active.onInteractionCleared?.(pending.request.requestKey);
    }
  }

  private clearInteractionsForAgentTurn(
    active: ActiveTurn,
    threadId: string,
    turnId: string,
    reason: string,
  ): void {
    for (const pending of [...this.#pendingAgentInteractions.values()]) {
      if (
        pending.active !== active ||
        pending.request.threadId !== threadId ||
        pending.request.turnId !== turnId
      ) {
        continue;
      }
      try {
        this.send({
          id: pending.rpcId,
          ...failClosedAgentInteractionReply(
            pending.request.payload.kind,
            reason,
          ),
        });
      } catch {
        // The child turn or runtime may already be closed.
      }
      this.releaseAgentInteraction(pending);
      active.onInteractionCleared?.(pending.request.requestKey);
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
    const request = agentInteractionRequestFromServerRequest(
      message.method ?? "",
      message.params,
      `codex:${this.#appServerSessionId}:${String(message.id)}`,
    );
    if (request) {
      const active = request.turnId
        ? this.activeTurnForNotification(request.threadId, request.turnId)
        : this.#rootExecutionsByThread.get(request.threadId)?.active;
      if (!active?.onInteractionRequest) {
        this.send({
          id: message.id,
          ...failClosedAgentInteractionReply(
            request.payload.kind,
            "No active Cantrip interaction channel.",
          ),
        });
        return;
      }
      if (active.interactionMode === "preauthorized") {
        this.send({
          id: message.id,
          ...failClosedAgentInteractionReply(
            request.payload.kind,
            "Preauthorized agent operations cannot open interactive requests.",
          ),
        });
        return;
      }
      this.registerAgentInteraction(active, message.id, request);
      if (
        request.payload.kind === "userInput" &&
        request.turnId &&
        request.itemId
      ) {
        const question = pendingPlanQuestionSchema.parse({
          id: request.requestKey,
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          questions: request.payload.questions,
          createdAt: new Date().toISOString(),
        });
        this.#pendingPlanQuestions.set(question.id, {
          active,
          question,
          requestKey: request.requestKey,
        });
        active.onPlanQuestion?.(question);
      }
      return;
    }
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

  private async refreshExternalChatGptAuth(
    params: unknown,
  ): Promise<Record<string, unknown>> {
    const session = this.#externalChatGptAuth;
    if (!session || !this.providerAccessTokens) {
      throw new Error("Portable ChatGPT authentication is not active.");
    }
    const refreshed = await refreshExternalChatGptAuthSession(
      session,
      this.providerAccessTokens,
      params,
    );
    this.#diagnosticSecrets.add(refreshed.accessToken);
    return refreshed.response;
  }

  private async requestWithChatGptAuthRecovery(
    provider: RuntimeProvider & { kind: "chatgpt" },
    method: string,
    params: unknown,
  ): Promise<unknown> {
    try {
      return await this.request(method, params);
    } catch (error) {
      if (!isChatGptTokenExpiredError(error)) throw error;
    }

    await this.reauthenticateExternalChatGptRuntime(provider);
    try {
      return await this.request(method, params);
    } catch (error) {
      if (isChatGptTokenExpiredError(error)) {
        throw new ProviderAccountReauthenticationRequiredError();
      }
      throw error;
    }
  }

  private async reauthenticateExternalChatGptRuntime(
    provider: RuntimeProvider & { kind: "chatgpt" },
  ): Promise<void> {
    if (this.#externalChatGptReauthentication) {
      return this.#externalChatGptReauthentication;
    }
    const pending = this.performExternalChatGptReauthentication(provider);
    this.#externalChatGptReauthentication = pending;
    try {
      await pending;
    } finally {
      if (this.#externalChatGptReauthentication === pending) {
        this.#externalChatGptReauthentication = null;
      }
    }
  }

  private async performExternalChatGptReauthentication(
    provider: RuntimeProvider & { kind: "chatgpt" },
  ): Promise<void> {
    const session = this.#externalChatGptAuth;
    if (!session || !this.providerAccessTokens) {
      throw new ProviderAccountReauthenticationRequiredError();
    }

    let lease: ProviderAccessTokenLease;
    try {
      lease = await this.providerAccessTokens.get(
        session.providerId,
        session.providerAccountId,
        {
          credentialRevision: session.credentialRevision,
          forceRefresh: true,
          minimumValiditySeconds: 120,
        },
      );
    } catch (error) {
      if (
        error instanceof ProviderAccessTokenRequestError &&
        error.code === "reauth-required"
      ) {
        throw new ProviderAccountReauthenticationRequiredError();
      }
      throw new Error(
        "Cantrip could not refresh ChatGPT authentication. Try again.",
        {
          cause: error,
        },
      );
    }

    const refreshed = chatGptExternalRefreshResponse(
      session,
      lease,
      session.upstreamAccountId,
    );
    this.#diagnosticSecrets.add(lease.accessToken);
    let result: { type?: unknown };
    try {
      result = (await this.request("account/login/start", {
        type: "chatgptAuthTokens",
        ...refreshed,
      })) as { type?: unknown };
    } catch (error) {
      if (isChatGptTokenExpiredError(error)) {
        throw new ProviderAccountReauthenticationRequiredError();
      }
      throw new Error(
        "Codex could not accept refreshed ChatGPT authentication.",
        {
          cause: error,
        },
      );
    }
    if (result.type !== "chatgptAuthTokens") {
      throw new Error("Codex rejected refreshed ChatGPT authentication.");
    }
    session.credentialRevision = lease.credentialRevision;
    workerLogger.event(
      "info",
      "ChatGPT authentication refreshed after an expired token",
      {
        event: "provider.auth.refresh",
        subsystem: "provider-auth",
        operation: "refresh-expired-token",
        status: "completed",
        ...codexProviderLogContext(provider),
      },
    );
  }

  private registerAgentInteraction(
    active: ActiveTurn,
    rpcId: number | string,
    request: AgentInteractionRuntimeRequest,
  ): void {
    const existing = this.#pendingAgentInteractions.get(request.requestKey);
    if (existing) {
      if (String(existing.rpcId) !== String(rpcId)) {
        throw new Error("Agent interaction request key was reused.");
      }
      return;
    }
    let pending: NativePendingAgentInteraction;
    const timeout = setTimeout(
      () => this.expireAgentInteraction(pending),
      Math.max(0, Date.parse(request.expiresAt) - Date.now()),
    );
    timeout.unref();
    pending = { active, request, rpcId, timeout };
    this.#pendingAgentInteractions.set(request.requestKey, pending);
    try {
      active.onInteractionRequest?.(request);
    } catch (error) {
      this.releaseAgentInteraction(pending);
      throw error;
    }
  }

  private expireAgentInteraction(pending: NativePendingAgentInteraction): void {
    if (
      this.#pendingAgentInteractions.get(pending.request.requestKey) !== pending
    ) {
      return;
    }
    try {
      this.send({
        id: pending.rpcId,
        ...failClosedAgentInteractionReply(
          pending.request.payload.kind,
          "The Cantrip interaction expired before it was answered.",
        ),
      });
    } catch {
      // The runtime may already be unavailable; the request still expires.
    }
    this.releaseAgentInteraction(pending);
    pending.active.onInteractionExpired?.(pending.request.requestKey);
  }

  private releaseAgentInteraction(
    pending: NativePendingAgentInteraction,
  ): void {
    clearTimeout(pending.timeout);
    this.#pendingAgentInteractions.delete(pending.request.requestKey);
    const planQuestion = this.#pendingPlanQuestions.get(
      pending.request.requestKey,
    );
    if (planQuestion) {
      this.#pendingPlanQuestions.delete(planQuestion.question.id);
      planQuestion.active.onPlanQuestionResolved?.(planQuestion.question.id);
    }
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
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const pending of [...this.#pendingAgentInteractions.values()]) {
      this.releaseAgentInteraction(pending);
      pending.active.onInteractionCleared?.(pending.request.requestKey);
    }
    this.#pendingAgentInteractions.clear();
    this.#pendingPlanQuestions.clear();
    for (const active of this.#activeTurnsByThread.values()) {
      if (active.timeout) clearTimeout(active.timeout);
      flushActiveAgentMessage(active, false);
      clearTurnInspectionTelemetry(active);
      active.reject(error);
    }
    for (const execution of this.#rootExecutionsByActive.values()) {
      for (const state of execution.agents.values()) {
        flushActiveAgentMessage(state, false);
        clearTurnInspectionTelemetry(state);
      }
    }
    this.#activeTurns.clear();
    this.#activeTurnsByThread.clear();
    this.#rootExecutionsByActive.clear();
    this.#rootExecutionsByThread.clear();
    this.#orphanAgentThreads.clear();
    this.#knownAgentThreads.clear();
    this.#collaborationModes.clear();
  }
}
