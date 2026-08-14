import { createHash, randomUUID } from "node:crypto";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { promisify, stripVTControlCharacters } from "node:util";

import {
  agentActivitySchema,
  agentInteractionAcceptedSchema,
  agentInteractionRuntimeRequestSchema,
  agentThreadSyncSchema,
  agentTurnResultSchema,
  chatGptModelInventorySchema,
  chatGoalClearSchema,
  chatGoalResponseSchema,
  chatPlanAcceptedSchema,
  codexExternalImportStatusSchema,
  codexMcpOauthStatusSchema,
  codexMcpReloadResultSchema,
  pendingPlanQuestionSchema,
  permissionProfileCapabilitySchema,
  normalizedAgentMessageSchema,
  threadGoalSchema,
  type AgentActivity,
  type AgentInteractionRequestKind,
  type AgentInteractionResponse,
  type AgentInteractionRuntimeRequest,
  type AgentThreadSync,
  type AgentThreadSyncItem,
  type AgentTurnResult,
  type ChatGptModelInventory,
  type ChatGoalResponse,
  type ChatRelocationContextPayload,
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
  type ChatPlanAnswer,
  type NormalizedAgentMessage,
  type PendingPlanQuestion,
  type PermissionProfileCapability,
  type PlanMode,
  type PlanStep,
  type ThreadGoal,
  type WorkerChatAttachment,
  type WorkerCommand,
} from "@cantrip/protocol";

import { workerLogger } from "../logger.js";
import {
  workflowJsonValueSchema,
  workflowNodeExecutionResultSchema,
  type WorkflowNodeExecutionResult,
} from "@cantrip/protocol/workflows";
import WebSocket, { type RawData } from "ws";

import type { CodexRuntime, CodexRuntimeDiagnostic } from "./runtime.js";
import {
  codexModelProviderName,
  codexProviderConfiguration,
} from "./provider-config.js";
import { writeManagedCodexModelCatalog } from "./model-catalog.js";
import {
  customizationInventory,
  parseExternalImportStatus,
  parseExternalImportPreview,
  parseMcpOauthCompletion,
  parseMcpOauthStart,
  parseMcpResourceRead,
  parseMcpServerPage,
  parseSkillConfigResult,
  resolveProjectSkillRoots,
  selectExternalImportItems,
  skillPathForConfiguration,
} from "./customization.js";

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
  reject(error: Error): void;
  resolve(result: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  baseline: WorkspaceSnapshot;
  chatId: string | null;
  collaborationMode: NativeCollaborationMode | null;
  cwd: string;
  delta: string;
  diffChanges: Array<{ kind: "add" | "delete" | "update"; path: string }>;
  durationMs: number | null;
  executionKind: "chat" | "workflow";
  finalText: string | null;
  interactionMode: "interactive" | "preauthorized";
  latestUsage: TokenUsageBreakdown | null;
  model: RunAgentTurnOptions["model"];
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
  reasoningSummaries: Map<string, string[]>;
  reject(error: Error): void;
  resolve(result: AgentTurnResult | WorkflowNodeExecutionResult): void;
  startedAtMs: number;
  threadId: string;
  timeout: ReturnType<typeof setTimeout> | null;
  workflowOutputSchema: Record<string, unknown> | null;
}

interface ThreadTurn {
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

interface ThreadReadResponse {
  thread: {
    id: string;
    status: { type: "active" | "idle" | "notLoaded" | "systemError" };
    turns: ThreadTurn[];
  };
}

interface WorkspaceFileState {
  fingerprint: string;
  status: string;
}

type WorkspaceSnapshot = Map<string, WorkspaceFileState>;

const execFileAsync = promisify(execFile);
const CODEX_STARTUP_TIMEOUT_MS = 2 * 60_000;
const CODEX_RPC_TIMEOUT_MS = 2 * 60_000;
const CODEX_DIAGNOSTIC_LIMIT = 100;
const CUSTOMIZATION_STATUS_LIMIT = 100;

// Derived from ServerNotification generated by codex-cli 0.147.0. Known but
// currently unnormalized notifications remain available in the raw diagnostic
// buffer without being mislabeled as schema drift.
const KNOWN_CODEX_NOTIFICATION_METHODS = new Set([
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
  "app/list/updated",
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
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "model/rerouted",
  "model/safetyBuffering/updated",
  "model/verification",
  "process/exited",
  "process/outputDelta",
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
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/itemAdded",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/started",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
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

interface AgentMessageDeltaParams {
  delta: string;
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

interface FileChangeItem {
  changes: Array<{
    kind: { type: "add" | "delete" | "update" };
    path: string;
  }>;
  id: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  type: "fileChange";
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
  durationMs: number | null;
  error: { message: string } | null;
  id: string;
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
  kind: "started" | "interacted" | "interrupted";
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
  item: CodexThreadItem;
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
  clientMessageId: string;
  cwd: string;
  isPrimary: Extract<WorkerCommand, { type: "chat.turn" }>["isPrimary"];
  model: Extract<WorkerCommand, { type: "chat.turn" }>["model"];
  mcpServers?: Extract<WorkerCommand, { type: "chat.turn" }>["mcpServers"];
  automationPaused: Extract<
    WorkerCommand,
    { type: "chat.turn" }
  >["automationPaused"];
  planMode: Extract<WorkerCommand, { type: "chat.turn" }>["planMode"];
  provider: Extract<WorkerCommand, { type: "chat.turn" }>["provider"];
  permissionProfileId: Extract<
    WorkerCommand,
    { type: "chat.turn" }
  >["permissionProfileId"];
  prompt: string;
  skillNames: string[];
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

type WorkflowNodeExecuteCommand = Extract<
  WorkerCommand,
  { type: "workflow.node.execute" }
>;

export interface RunWorkflowNodeOptions extends Omit<
  WorkflowNodeExecuteCommand,
  "type"
> {
  onActivity?: ActiveTurn["onActivity"];
  onMessage?: ActiveTurn["onMessage"];
  onInteractionCleared?: ActiveTurn["onInteractionCleared"];
  onInteractionExpired?: ActiveTurn["onInteractionExpired"];
  onInteractionRequest?: ActiveTurn["onInteractionRequest"];
  onPlan?: ActiveTurn["onPlan"];
}

export interface RuntimeChatAttachment extends WorkerChatAttachment {
  path: string;
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

function relocationContentText(
  content: ChatRelocationContextPayload["messages"][number]["content"],
): string {
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "attachment") {
        return `[Cantrip attachment: ${item.attachment.fileName} (${item.attachment.mimeType}), id ${item.attachment.id}]`;
      }
      return `[Cantrip ${item.activity.type} activity: ${JSON.stringify(item.activity)}]`;
    })
    .join("\n\n")
    .trim();
}

export function relocationResponseItems(
  payload: ChatRelocationContextPayload,
): Array<Record<string, unknown>> {
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

function relocationItemBatches(
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

export const GOAL_CONTINUATION_PROMPT =
  "Continue working toward the active goal. Reassess progress, make the next useful scoped change, validate it, and update the goal status when it is complete or genuinely blocked.";

export function goalShouldContinue(
  goal: ThreadGoal | null,
  automationPaused = false,
): boolean {
  return !automationPaused && goal?.status === "active";
}

export const CANTRIP_CLI_DEVELOPER_INSTRUCTIONS =
  "Cantrip-specific operations are available through the `cantrip` CLI; run `cantrip -h` for concise command help. Use standard command-line tools for normal repository work. If a Cantrip command reports that continuation was scheduled, finish the current turn so Cantrip can checkpoint and continue safely.";

export const CANTRIP_DYNAMIC_TOOLS_OVERRIDE = { dynamicTools: [] } as const;

export function cantripChatThreadParams() {
  return {
    developerInstructions: CANTRIP_CLI_DEVELOPER_INSTRUCTIONS,
    ...CANTRIP_DYNAMIC_TOOLS_OVERRIDE,
  } as const;
}

export function codexWorktreeTurnPolicy(
  options: Pick<
    RunAgentTurnOptions,
    "cwd" | "isPrimary" | "worktreeMode" | "worktreePolicy"
  > & { permissionProfileActive?: boolean },
) {
  const cwd = path.resolve(options.cwd);
  const primaryIsReadOnly =
    options.isPrimary && options.worktreePolicy === "required-for-writes";
  const modeInstruction =
    options.worktreeMode === "pinned"
      ? "This chat is pinned to the current worktree. Do not acquire or switch worktrees unless the user first returns the chat to Agent managed mode."
      : "This chat is Agent managed and may use `cantrip worktree` commands when isolation is appropriate.";
  const policyInstruction = primaryIsReadOnly
    ? "The project policy is Required for writes and this turn is on Primary. Primary is inspection-only: do not mutate files or Git state here. Before writing, run `cantrip worktree create --switch` or `cantrip worktree switch`, then finish this turn if the command schedules continuation."
    : options.worktreePolicy === "direct"
      ? "The project policy is Direct. Writes are permitted in the current checkout, including Primary."
      : options.worktreePolicy === "required-for-writes"
        ? "The project policy is Required for writes and this turn is in a secondary worktree, so writes are permitted here."
        : "The project policy is Agent managed. You may work in the current checkout or acquire a secondary worktree when the task benefits from isolation.";
  const sandboxPolicy = primaryIsReadOnly
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
        value: `${policyInstruction} ${modeInstruction}`,
      },
    },
    ...(options.permissionProfileActive ? {} : { sandboxPolicy }),
  } as const;
}

export function codexWorkflowTurnPolicy(
  options: Pick<
    RunWorkflowNodeOptions,
    "cwd" | "mutationMode" | "networkAccess" | "permissionProfileId"
  >,
  permissionProfilesSupported: boolean,
) {
  const permissionProfileActive = Boolean(
    options.permissionProfileId && permissionProfilesSupported,
  );
  if (options.networkAccess === "restricted" && !permissionProfileActive) {
    throw new Error(
      "Restricted workflow network access requires a supported Codex permission profile.",
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

export function parseWorkflowStructuredResult(
  text: string,
  outputSchema: Record<string, unknown>,
): unknown {
  const value =
    Object.keys(outputSchema).length === 0 ? text : JSON.parse(text);
  return workflowJsonValueSchema.parse(value);
}

export function workflowMeasuredUsage(
  usage: TokenUsageBreakdown | null,
  durationMs: number,
) {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    durationMs: Math.max(0, Math.round(durationMs)),
    estimatedCostUsd: null,
    costAvailable: false,
  } as const;
}

export function codexThreadPermissionParams(
  permissionProfileId: string,
  permissionProfilesSupported: boolean,
) {
  return permissionProfilesSupported
    ? { permissions: permissionProfileId }
    : { sandbox: "workspace-write" as const };
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

export type CompactAgentThreadOptions = Pick<
  RunAgentTurnOptions,
  "cwd" | "model" | "permissionProfileId" | "provider"
> & {
  threadId: string;
};

export { codexModelProviderName } from "./provider-config.js";

export function codexMcpConfigOverride(
  servers: NonNullable<RunAgentTurnOptions["mcpServers"]>,
): Record<string, unknown> {
  return {
    mcp_servers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        server.transport === "stdio"
          ? {
              command: server.command,
              args: server.args,
              env: server.environment,
              enabled: server.enabled,
            }
          : {
              url: server.url,
              bearer_token_env_var:
                server.bearerTokenEnvironmentVariable ?? undefined,
              http_headers: server.headers,
              env_http_headers: server.environmentHeaders,
              enabled: server.enabled,
            },
      ]),
    ),
  };
}

export function codexRuntimeId(
  model: RunAgentTurnOptions["model"],
  provider: RunAgentTurnOptions["provider"],
): string {
  const configuration = createHash("sha256")
    .update(
      JSON.stringify({
        modelName: model.name,
        reasoningEffort: model.reasoningEffort,
        modelCatalog: model.catalog ?? null,
        providerName: provider.name,
        providerKind: provider.kind,
        providerAccountId: provider.accountId,
        credentialHomeKey: provider.credentialHomeKey,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${provider.credentialHomeKey ?? provider.id}:${model.routeId}:${configuration}`;
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

function commandOutput(output: string | null): string | null {
  if (!output || output.length <= 20_000) {
    return output;
  }
  return `…output truncated…\n${output.slice(-20_000)}`;
}

export function changedFiles(diff: string): ActiveTurn["diffChanges"] {
  return diff
    .split(/^diff --git /m)
    .slice(1)
    .flatMap((section) => {
      const header = section.split("\n", 1)[0] ?? "";
      const match = /^a\/(.+) b\/(.+)$/.exec(header);
      if (!match?.[2]) {
        return [];
      }
      return [
        {
          path: match[2],
          kind: section.includes("\nnew file mode ")
            ? ("add" as const)
            : section.includes("\ndeleted file mode ")
              ? ("delete" as const)
              : ("update" as const),
        },
      ];
    });
}

async function workspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const records = stdout.split("\0").filter(Boolean);
    const snapshot: WorkspaceSnapshot = new Map();
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
      let fingerprint = "missing";
      try {
        const file = await lstat(path.join(cwd, filePath));
        fingerprint = `${file.size}:${file.mtimeMs}:${file.mode}`;
      } catch {
        // Deleted files intentionally have no filesystem fingerprint.
      }
      snapshot.set(filePath, { fingerprint, status });
    }
    return snapshot;
  } catch {
    return new Map();
  }
}

async function workspaceChanges(
  active: ActiveTurn,
): Promise<ActiveTurn["diffChanges"]> {
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
    changes.set(filePath, { path: filePath, kind });
  }
  return [...changes.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function emitFileActivity(
  active: ActiveTurn,
  turnId: string,
  status: AgentActivity["status"],
  correlation: CodexEventCorrelation,
): void {
  if (active.diffChanges.length === 0) {
    return;
  }
  active.onActivity?.(
    agentActivitySchema.parse({
      type: "fileChange",
      id: `turn:${turnId}:files`,
      status,
      changes: active.diffChanges,
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

export function normalizeCodexThreadItem(
  item: CodexThreadItem,
  cwd: string,
  lifecycle: "started" | "completed",
  correlation: CodexEventCorrelation,
): AgentActivity | null {
  if (item.type === "commandExecution") {
    return agentActivitySchema.parse({
      type: "command",
      id: item.id,
      command: item.command,
      cwd: displayPath(cwd, item.cwd) || ".",
      status: activityStatus(item.status),
      exitCode: item.exitCode,
      output: commandOutput(item.aggregatedOutput),
      durationMs: item.durationMs ?? null,
      correlation,
    });
  }
  if (item.type === "fileChange") {
    return agentActivitySchema.parse({
      type: "fileChange",
      id: item.id,
      status: activityStatus(item.status),
      changes: item.changes.map((change) => ({
        path: displayPath(cwd, change.path),
        kind: change.kind.type,
      })),
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
      correlation,
    });
  }
  if (item.type === "mcpToolCall") {
    return agentActivitySchema.parse({
      type: "mcpToolCall",
      id: item.id,
      status: activityStatus(item.status),
      server: item.server,
      tool: item.tool,
      error: boundedText(item.error?.message),
      durationMs: item.durationMs,
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
      prompt: null,
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
      correlation,
    });
  }
  if (item.type === "imageView") {
    return agentActivitySchema.parse({
      type: "imageView",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
      path: displayPath(cwd, item.path),
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
      correlation,
    });
  }
  if (item.type === "contextCompaction") {
    return agentActivitySchema.parse({
      type: "contextCompaction",
      id: item.id,
      status: lifecycle === "started" ? "running" : "completed",
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
    status: input.level === "error" ? "failed" : "completed",
    level: input.level,
    message: boundedText(input.message)?.trim() || input.level,
    details: boundedText(input.details),
    willRetry: input.willRetry ?? null,
    correlation: input.correlation,
  });
}

function turnSummaryActivity(
  turn: Pick<
    ThreadTurn,
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

export class CodexAppServer implements CodexRuntime {
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #collaborationModes = new Map<string, PlanMode>();
  readonly #externalImportStatuses = new Map<
    string,
    CodexExternalImportStatus
  >();
  readonly #externalTurnBaselines = new Map<string, Set<string>>();
  readonly #goals = new Map<string, ThreadGoal>();
  readonly #imageSupport = new Map<string, boolean>();
  readonly #loadedThreads = new Set<string>();
  readonly #mcpOauthStatuses = new Map<string, CodexMcpOauthStatus>();
  readonly #mcpConfigFingerprintsByThread = new Map<string, string>();
  readonly #permissionProfilesByThread = new Map<string, string>();
  readonly #pending = new Map<number, PendingRpcRequest>();
  readonly #pendingAgentInteractions = new Map<
    string,
    NativePendingAgentInteraction
  >();
  readonly #pendingPlanQuestions = new Map<string, NativePendingPlanQuestion>();
  readonly #pausedChats = new Set<string>();
  readonly #runtimeDiagnostics: CodexRuntimeDiagnostic[] = [];
  readonly #threadKinds = new Map<string, "chat" | "workflow">();
  readonly #workflowThreadOwners = new Map<string, string>();
  #skillRoots: string[] = [];
  #appServerSessionId = randomUUID();
  #child: ChildProcessWithoutNullStreams | null = null;
  #remoteUrl: string | null = null;
  #runtimeId: string | null = null;
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
  ) {}

  diagnostics(): CodexRuntimeDiagnostic[] {
    return [...this.#runtimeDiagnostics];
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

  async listChatGptModels(
    provider: Extract<
      WorkerCommand,
      { type: "model.chatgpt.catalog" }
    >["provider"],
  ): Promise<ChatGptModelInventory> {
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
    return chatGptModelInventorySchema.parse({
      models,
      observedAt: new Date().toISOString(),
    });
  }

  async runTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
    if (options.automationPaused) this.#pausedChats.add(options.chatId);
    await this.ensureStarted(options.model, options.provider);
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

    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }

    let activeTurn: ActiveTurn | undefined;
    const completion = new Promise<
      AgentTurnResult | WorkflowNodeExecutionResult
    >((resolve, reject) => {
      activeTurn = {
        baseline,
        chatId: options.chatId,
        collaborationMode,
        cwd: options.cwd,
        delta: "",
        diffChanges: [],
        durationMs: null,
        executionKind: "chat",
        finalText: null,
        interactionMode: "interactive",
        latestUsage: null,
        model: options.model,
        onActivity: options.onActivity,
        onMessage: options.onMessage,
        onInteractionCleared: options.onInteractionCleared,
        onInteractionExpired: options.onInteractionExpired,
        onInteractionRequest: options.onInteractionRequest,
        onCheckpoint: options.onCheckpoint,
        onPlan: options.onPlan,
        onPlanQuestion: options.onPlanQuestion,
        onPlanQuestionResolved: options.onPlanQuestionResolved,
        reasoningSummaries: new Map(),
        reject,
        resolve,
        startedAtMs: Date.now(),
        threadId,
        timeout: null,
        workflowOutputSchema: null,
      };
    });

    const availableSkills = options.skillNames.length
      ? await this.listSkills(options)
      : [];
    const selectedSkills = new Map(
      availableSkills.flatMap((skill) =>
        skill.path ? ([[skill.name, skill]] as const) : [],
      ),
    );
    const response = (await this.request("turn/start", {
      threadId,
      ...codexWorkspaceContext(options.cwd),
      ...codexWorktreeTurnPolicy({
        ...options,
        permissionProfileActive: this.permissionProfilesSupported(),
      }),
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
      ...(collaborationMode ? { collaborationMode } : {}),
    })) as TurnStartResponse;
    if (!activeTurn) {
      throw new Error("Could not initialize the Codex turn.");
    }
    this.#activeTurns.set(response.turn.id, activeTurn);
    return agentTurnResultSchema.parse(await completion);
  }

  async runWorkflowNode(
    options: RunWorkflowNodeOptions,
  ): Promise<WorkflowNodeExecutionResult> {
    await this.ensureStarted(options.model, options.provider);
    const turnPolicy = codexWorkflowTurnPolicy(
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
        `Workflow skills are unavailable: ${missingSkills.join(", ")}.`,
      );
    }
    if (options.threadId && this.hasActiveThread(options.threadId)) {
      throw new Error(
        `Codex thread ${options.threadId} already has an active turn.`,
      );
    }
    const baseline = await workspaceSnapshot(options.cwd);
    const threadId = await this.loadWorkflowThread(options);
    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }

    let activeTurn: ActiveTurn | undefined;
    const completion = new Promise<
      AgentTurnResult | WorkflowNodeExecutionResult
    >((resolve, reject) => {
      activeTurn = {
        baseline,
        chatId: null,
        collaborationMode: null,
        cwd: options.cwd,
        delta: "",
        diffChanges: [],
        durationMs: null,
        executionKind: "workflow",
        finalText: null,
        interactionMode: options.approvalMode,
        latestUsage: null,
        model: options.model,
        onActivity: options.onActivity,
        onMessage: options.onMessage,
        onInteractionCleared: options.onInteractionCleared,
        onInteractionExpired: options.onInteractionExpired,
        onInteractionRequest: options.onInteractionRequest,
        onPlan: options.onPlan,
        reasoningSummaries: new Map(),
        reject,
        resolve,
        startedAtMs: Date.now(),
        threadId,
        timeout: null,
        workflowOutputSchema: options.outputSchema,
      };
    });

    const response = (await this.request("turn/start", {
      threadId,
      ...codexWorkspaceContext(options.cwd),
      ...turnPolicy,
      approvalPolicy:
        options.approvalMode === "preauthorized" ? "never" : "on-request",
      clientUserMessageId: `cantrip:workflow:${options.idempotencyKey}`,
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
    if (!activeTurn) {
      throw new Error("Could not initialize the Codex workflow turn.");
    }
    this.#activeTurns.set(response.turn.id, activeTurn);
    options.onActivity?.(
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
      const current = this.#activeTurns.get(response.turn.id);
      if (current !== activeTurn) return;
      this.#activeTurns.delete(response.turn.id);
      void this.request("turn/interrupt", {
        threadId,
        turnId: response.turn.id,
      }).catch(() => undefined);
      void this.failTurn(
        activeTurn!,
        response.turn.id,
        new Error(
          `Workflow node execution timed out after ${options.timeoutMs}ms.`,
        ),
      );
    }, options.timeoutMs);
    activeTurn.timeout.unref();
    return workflowNodeExecutionResultSchema.parse(await completion);
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

  async readCustomizationInventory(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
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
            threadId: null,
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
      extraRoots: result.roots,
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
    if (!this.permissionProfilesSupported()) {
      return permissionProfileCapabilitySchema.parse({
        available: false,
        profiles: [],
        reason:
          "The installed Codex runtime does not advertise permission profiles; Cantrip is using its legacy sandbox policy.",
      });
    }
    await this.ensureStarted(options.model, options.provider);
    const profiles: PermissionProfileCapability["profiles"] = [];
    let cursor: string | null = null;
    do {
      const response = (await this.request("permissionProfile/list", {
        cwd: options.cwd,
        cursor,
        limit: 100,
      })) as { data?: unknown; nextCursor?: unknown };
      profiles.push(
        ...permissionProfileCapabilitySchema.shape.profiles.parse(
          response.data,
        ),
      );
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
      "cwd" | "model" | "provider" | "threadId"
    > & { threadId: string },
  ): Promise<AgentThreadSync> {
    await this.ensureStarted(options.model, options.provider);
    const response = (await this.request("thread/read", {
      threadId: options.threadId,
      includeTurns: true,
    })) as ThreadReadResponse;
    const baseline = this.#externalTurnBaselines.get(options.threadId);
    const turns = response.thread.turns
      .filter((turn) => (baseline ? !baseline.has(turn.id) : false))
      .filter(
        (turn) =>
          !turn.items.some(
            (item) =>
              item.type === "userMessage" &&
              item.clientId?.startsWith("cantrip:"),
          ),
      )
      .map((turn) => this.syncTurn(turn, options.cwd, response.thread.id));
    for (const turn of turns) {
      if (turn.status !== "inProgress") baseline?.add(turn.id);
    }
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

  async prepareExternalSync(
    options: Pick<
      RunAgentTurnOptions,
      "cwd" | "model" | "provider" | "threadId"
    > & { threadId: string },
  ): Promise<void> {
    await this.ensureStarted(options.model, options.provider);
    let response: ThreadReadResponse;
    try {
      response = (await this.request("thread/read", {
        threadId: options.threadId,
        includeTurns: true,
      })) as ThreadReadResponse;
    } catch (error) {
      if (!/not materialized yet/i.test(String(error))) throw error;
      this.#externalTurnBaselines.set(options.threadId, new Set());
      return;
    }
    this.#externalTurnBaselines.set(
      options.threadId,
      new Set(response.thread.turns.map((turn) => turn.id)),
    );
  }

  async compactThread(
    options: CompactAgentThreadOptions,
  ): Promise<{ accepted: true }> {
    await this.ensureStarted(options.model, options.provider);
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
    return { accepted: true };
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
    if (
      !profiles.available ||
      !profiles.profiles.some(
        (profile) =>
          profile.id === options.permissionProfileId && profile.allowed,
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

  async answerPlanQuestion(
    questionId: string,
    answers: ChatPlanAnswer["answers"],
  ): Promise<{ accepted: true; requestKey?: string }> {
    const pending = this.#pendingPlanQuestions.get(questionId);
    if (!pending) {
      throw new Error("The Plan Mode question is no longer pending.");
    }
    await this.answerAgentInteraction(pending.requestKey, {
      kind: "userInput",
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, values]) => [
          id,
          { answers: values },
        ]),
      ),
    });
    return chatPlanAcceptedSchema.parse({
      accepted: true,
      requestKey: pending.requestKey,
    });
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

  async interruptThread(threadId: string): Promise<{ interrupted: boolean }> {
    const active = [...this.#activeTurns.entries()].find(
      ([, turn]) => turn.threadId === threadId,
    );
    if (!active) return { interrupted: false };
    await this.request("turn/interrupt", { threadId, turnId: active[0] });
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
    return { steered: true, turnId: result.turnId };
  }

  close(): void {
    this.handleExit(new Error("Codex app-server stopped."));
    this.#socket?.close();
    this.#socket = null;
    this.#child?.kill("SIGINT");
    this.#child = null;
    this.#remoteUrl = null;
    this.#runtimeId = null;
    this.#starting = null;
    this.#loadedThreads.clear();
    this.#mcpConfigFingerprintsByThread.clear();
    this.#permissionProfilesByThread.clear();
    this.#threadKinds.clear();
    this.#workflowThreadOwners.clear();
    this.#externalImportStatuses.clear();
    this.#externalTurnBaselines.clear();
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
    const references = attachments.map(
      (attachment) =>
        `- ${attachment.fileName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes): ${attachment.path}`,
    );
    const text = references.length
      ? `${prompt}\n\nAttachments are stored outside the repository on this worker. Read them from these paths as needed:\n${references.join("\n")}`
      : prompt;
    const imageSupport =
      model && provider && attachments.some(({ kind }) => kind === "image")
        ? await this.modelSupportsImages(model, provider)
        : false;
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
    let supported = provider.kind === "chatgpt";
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
            entry.inputModalities === undefined ||
            entry.inputModalities.includes("image");
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
    const runtimeId = codexRuntimeId(model, provider);
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
    const starting = this.start(model, provider);
    this.#starting = starting;
    try {
      await starting;
    } catch (error) {
      if (this.#starting === starting) {
        this.stopFailedStart();
      }
      throw error;
    } finally {
      if (this.#starting === starting) this.#starting = null;
    }
  }

  private async ensureCatalogStarted(
    provider: Extract<
      WorkerCommand,
      { type: "model.chatgpt.catalog" }
    >["provider"],
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
    const starting = this.start(null, provider);
    this.#starting = starting;
    try {
      await starting;
    } catch (error) {
      if (this.#starting === starting) this.stopFailedStart();
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
    this.#loadedThreads.clear();
    this.#mcpConfigFingerprintsByThread.clear();
    this.#permissionProfilesByThread.clear();
    this.#threadKinds.clear();
    this.#workflowThreadOwners.clear();
    this.#collaborationModes.clear();
    this.#externalImportStatuses.clear();
    this.#externalTurnBaselines.clear();
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
    >,
    create = true,
  ): Promise<string | null> {
    const modelProvider = codexModelProviderName(options.provider);
    const mcpConfig = options.mcpServers
      ? codexMcpConfigOverride(options.mcpServers)
      : null;
    const mcpConfigFingerprint = mcpConfig ? JSON.stringify(mcpConfig) : null;
    let threadId = options.threadId;
    if (threadId && this.#threadKinds.get(threadId) === "workflow") {
      throw new Error(
        `Codex thread ${threadId} belongs to a workflow and cannot be resumed as chat.`,
      );
    }
    if (
      threadId &&
      (!this.#loadedThreads.has(threadId) ||
        this.#permissionProfilesByThread.get(threadId) !==
          options.permissionProfileId ||
        (mcpConfigFingerprint !== null &&
          this.#mcpConfigFingerprintsByThread.get(threadId) !==
            mcpConfigFingerprint))
    ) {
      try {
        if (
          this.#loadedThreads.has(threadId) &&
          mcpConfigFingerprint !== null &&
          this.#mcpConfigFingerprintsByThread.get(threadId) !==
            mcpConfigFingerprint
        ) {
          await this.request("thread/unsubscribe", { threadId });
        }
        const resumed = (await this.request("thread/resume", {
          threadId,
          model: options.model.name,
          modelProvider,
          ...codexWorkspaceContext(options.cwd),
          approvalPolicy: "on-request",
          ...cantripChatThreadParams(),
          ...this.threadPermissionParams(options.permissionProfileId),
          ...(mcpConfig ? { config: mcpConfig } : {}),
        })) as ThreadResponse;
        threadId = resumed.thread.id;
        this.#loadedThreads.add(threadId);
        this.#permissionProfilesByThread.set(
          threadId,
          options.permissionProfileId,
        );
        if (mcpConfigFingerprint !== null) {
          this.#mcpConfigFingerprintsByThread.set(
            threadId,
            mcpConfigFingerprint,
          );
        }
        this.#threadKinds.set(threadId, "chat");
      } catch {
        // Codex thread state is local to its worker/runtime. A normal turn can
        // recover from replacement by starting a new thread; compaction cannot.
        threadId = null;
      }
    }
    if (!threadId && create) {
      const started = (await this.request("thread/start", {
        model: options.model.name,
        modelProvider,
        ...codexWorkspaceContext(options.cwd),
        approvalPolicy: "on-request",
        ...this.threadPermissionParams(options.permissionProfileId),
        ...cantripChatThreadParams(),
        ...(mcpConfig ? { config: mcpConfig } : {}),
      })) as ThreadResponse;
      threadId = started.thread.id;
      this.#loadedThreads.add(threadId);
      this.#permissionProfilesByThread.set(
        threadId,
        options.permissionProfileId,
      );
      if (mcpConfigFingerprint !== null) {
        this.#mcpConfigFingerprintsByThread.set(threadId, mcpConfigFingerprint);
      }
      this.#threadKinds.set(threadId, "chat");
    }
    return threadId;
  }

  private async loadWorkflowThread(
    options: RunWorkflowNodeOptions,
  ): Promise<string> {
    const modelProvider = codexModelProviderName(options.provider);
    const mcpConfig = codexMcpConfigOverride(options.mcpServers);
    const mcpConfigFingerprint = JSON.stringify(mcpConfig);
    const approvalPolicy =
      options.approvalMode === "preauthorized" ? "never" : "on-request";
    const profileKey = options.permissionProfileId
      ? `profile:${options.permissionProfileId}`
      : `sandbox:${options.mutationMode}:${options.networkAccess}`;
    const ownerKey = `${options.workflowRunId}:${options.runNodeId}`;
    let threadId = options.threadId;

    if (threadId && this.#threadKinds.get(threadId) === "chat") {
      throw new Error(
        `Codex thread ${threadId} belongs to chat and cannot be resumed as a workflow.`,
      );
    }
    if (
      threadId &&
      this.#workflowThreadOwners.has(threadId) &&
      this.#workflowThreadOwners.get(threadId) !== ownerKey
    ) {
      throw new Error(
        `Codex workflow thread ${threadId} belongs to a different run node.`,
      );
    }

    if (threadId) {
      try {
        if (
          this.#loadedThreads.has(threadId) &&
          this.#mcpConfigFingerprintsByThread.get(threadId) !==
            mcpConfigFingerprint
        ) {
          await this.request("thread/unsubscribe", { threadId });
        }
        const resumed = (await this.request("thread/resume", {
          threadId,
          model: options.model.name,
          modelProvider,
          ...codexWorkspaceContext(options.cwd),
          approvalPolicy,
          ...this.workflowThreadPermissionParams(options),
          developerInstructions: options.developerInstructions,
          config: mcpConfig,
        })) as ThreadResponse;
        threadId = resumed.thread.id;
      } catch {
        threadId = null;
      }
    }
    if (!threadId) {
      const started = (await this.request("thread/start", {
        model: options.model.name,
        modelProvider,
        ...codexWorkspaceContext(options.cwd),
        approvalPolicy,
        ...this.workflowThreadPermissionParams(options),
        developerInstructions: options.developerInstructions,
        config: mcpConfig,
      })) as ThreadResponse;
      threadId = started.thread.id;
    }

    this.#loadedThreads.add(threadId);
    this.#permissionProfilesByThread.set(threadId, profileKey);
    this.#mcpConfigFingerprintsByThread.set(threadId, mcpConfigFingerprint);
    this.#threadKinds.set(threadId, "workflow");
    this.#workflowThreadOwners.set(threadId, ownerKey);
    return threadId;
  }

  private hasActiveThread(threadId: string): boolean {
    return [...this.#activeTurns.values()].some(
      (active) => active.threadId === threadId,
    );
  }

  private forgetThread(threadId: string): void {
    this.#loadedThreads.delete(threadId);
    this.#mcpConfigFingerprintsByThread.delete(threadId);
    this.#permissionProfilesByThread.delete(threadId);
    this.#threadKinds.delete(threadId);
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

  private workflowThreadPermissionParams(options: RunWorkflowNodeOptions) {
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

  private syncTurn(turn: ThreadTurn, cwd: string, threadId: string) {
    const items = turn.items.flatMap((item): AgentThreadSyncItem[] => {
      if (item.type === "userMessage") {
        const text = item.content
          .flatMap((content) =>
            content.type === "text" && content.text ? [content.text] : [],
          )
          .join("\n\n")
          .trim();
        return text ? [{ type: "userMessage", id: item.id, text }] : [];
      }
      if (item.type === "agentMessage") {
        const message = normalizeAgentMessage(
          item,
          eventCorrelation("thread/read", null, threadId, turn.id, item.id),
        );
        return message ? [{ type: "agentMessage", ...message }] : [];
      }
      const activity = normalizeCodexThreadItem(
        item,
        cwd,
        turn.status === "inProgress" ? "started" : "completed",
        eventCorrelation("thread/read", null, threadId, turn.id, item.id),
      );
      return activity ? [{ type: "activity", activity }] : [];
    });
    if (turn.error?.message) {
      items.push({
        type: "activity",
        activity: normalizeNoticeActivity({
          level: "error",
          message: turn.error.message,
          details: turn.error.additionalDetails,
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

  private async start(
    model: RunAgentTurnOptions["model"] | null,
    provider: RunAgentTurnOptions["provider"],
  ): Promise<void> {
    this.#appServerSessionId = randomUUID();
    await mkdir(this.codexHome, { recursive: true });
    const providerConfiguration = codexProviderConfiguration(provider);
    const modelCatalogPath = model
      ? await writeManagedCodexModelCatalog(this.dataDirectory, model, provider)
      : null;
    const child = spawn(
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
        ...(model ? ["-c", `model=${JSON.stringify(model.name)}`] : []),
        ...(model?.reasoningEffort
          ? [
              "-c",
              `model_reasoning_effort=${JSON.stringify(model.reasoningEffort)}`,
            ]
          : []),
        "--listen",
        "ws://127.0.0.1:0",
      ],
      {
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome,
          ...providerConfiguration.environment,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#child = child;

    const stdoutLines = readline.createInterface({ input: child.stdout });
    const stderrLines = readline.createInterface({ input: child.stderr });
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
        reject(
          new Error(
            `Codex app-server exited before listening (${signal ?? `code ${String(code)}`}).`,
          ),
        );
      });
    });
    this.#remoteUrl = remoteUrl;
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
    socket.on("message", (data: RawData) => this.handleSocketMessage(data));
    socket.on("error", (error) => {
      this.handleExit(error);
    });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.handleExit(new Error("Codex app-server WebSocket closed."));
      this.#socket = null;
      this.#remoteUrl = null;
      this.#runtimeId = null;
      this.#starting = null;
      this.#loadedThreads.clear();
      this.#mcpConfigFingerprintsByThread.clear();
      this.#permissionProfilesByThread.clear();
      this.#threadKinds.clear();
      this.#workflowThreadOwners.clear();
      this.#collaborationModes.clear();
      this.#externalImportStatuses.clear();
      this.#externalTurnBaselines.clear();
      this.#mcpOauthStatuses.clear();
      this.#goals.clear();
      this.#skillRoots = [];
      this.#child?.kill("SIGINT");
      this.#child = null;
    });
    stderrLines.on("line", (line) => {
      if (!line.trimStart().startsWith("listening on:")) {
        process.stderr.write(`[codex] ${line}\n`);
      }
    });
    child.once("exit", (code, signal) => {
      this.handleExit(
        new Error(
          `Codex app-server exited (${signal ?? `code ${String(code)}`}).`,
        ),
      );
      this.#child = null;
      this.#socket = null;
      this.#remoteUrl = null;
      this.#runtimeId = null;
      this.#starting = null;
      this.#loadedThreads.clear();
      this.#mcpConfigFingerprintsByThread.clear();
      this.#permissionProfilesByThread.clear();
      this.#threadKinds.clear();
      this.#workflowThreadOwners.clear();
      this.#externalImportStatuses.clear();
      this.#externalTurnBaselines.clear();
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
  }

  private request(method: string, params: unknown): Promise<unknown> {
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
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request ${method} timed out.`));
      }, CODEX_RPC_TIMEOUT_MS);
      this.#pending.set(id, { reject, resolve, timeout });
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
        pending.reject(new Error(message.error.message));
      } else {
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
      return;
    }

    if (message.method === "turn/plan/updated") {
      const params = message.params as TurnPlanUpdatedParams;
      const active = this.#activeTurns.get(params.turnId);
      if (active) {
        active.onPlan?.({
          explanation: params.explanation,
          steps: params.plan,
          turnId: params.turnId,
        });
        active.onActivity?.(
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
      const active = this.#activeTurns.get(params.turnId);
      if (active) {
        active.delta += params.delta;
      }
      return;
    }

    if (message.method === "item/reasoning/summaryPartAdded") {
      const params = message.params as ReasoningSummaryPartAddedParams;
      const active = this.#activeTurns.get(params.turnId);
      if (active && params.summaryIndex >= 0 && params.summaryIndex < 100) {
        const summary = active.reasoningSummaries.get(params.itemId) ?? [];
        while (summary.length <= params.summaryIndex) summary.push("");
        active.reasoningSummaries.set(params.itemId, summary);
      }
      return;
    }

    if (message.method === "item/reasoning/summaryTextDelta") {
      const params = message.params as ReasoningSummaryTextDeltaParams;
      const active = this.#activeTurns.get(params.turnId);
      if (active && params.summaryIndex >= 0 && params.summaryIndex < 100) {
        const summary = active.reasoningSummaries.get(params.itemId) ?? [];
        while (summary.length <= params.summaryIndex) summary.push("");
        summary[params.summaryIndex] =
          boundedText(`${summary[params.summaryIndex] ?? ""}${params.delta}`) ??
          "";
        active.reasoningSummaries.set(params.itemId, summary);
        active.onActivity?.(
          agentActivitySchema.parse({
            type: "reasoning",
            id: params.itemId,
            status: "running",
            summary: summary.map((part) => part.trim()).filter(Boolean),
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

    if (message.method === "thread/goal/updated") {
      const params = message.params as ThreadGoalUpdatedParams;
      this.#goals.set(params.threadId, threadGoalSchema.parse(params.goal));
      return;
    }

    if (message.method === "thread/goal/cleared") {
      const params = message.params as ThreadGoalClearedParams;
      this.#goals.delete(params.threadId);
      return;
    }

    if (message.method === "item/started") {
      const params = message.params as ItemLifecycleParams;
      const active = this.#activeTurns.get(params.turnId);
      if (
        active &&
        params.item.type !== "agentMessage" &&
        params.item.type !== "fileChange"
      ) {
        if (params.item.type === "reasoning") {
          active.reasoningSummaries.set(params.item.id, params.item.summary);
        }
        const activity = normalizeCodexThreadItem(
          params.item,
          active.cwd,
          "started",
          eventCorrelation(
            message.method,
            diagnosticId,
            params.threadId,
            params.turnId,
            params.item.id,
          ),
        );
        if (activity) active.onActivity?.(activity);
      }
      return;
    }

    if (message.method === "item/completed") {
      const params = message.params as ItemLifecycleParams;
      const active = this.#activeTurns.get(params.turnId);
      if (
        active &&
        ((params.item.type === "agentMessage" &&
          params.item.phase !== "commentary") ||
          params.item.type === "plan") &&
        typeof params.item.text === "string"
      ) {
        active.finalText = params.item.text;
      }
      if (active && params.item.type === "agentMessage") {
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
        if (normalized) active.onMessage?.(normalized);
      } else if (active) {
        if (params.item.type !== "fileChange") {
          const activity = normalizeCodexThreadItem(
            params.item,
            active.cwd,
            "completed",
            eventCorrelation(
              message.method,
              diagnosticId,
              params.threadId,
              params.turnId,
              params.item.id,
            ),
          );
          if (activity) active.onActivity?.(activity);
        }
        if (params.item.type === "reasoning") {
          active.reasoningSummaries.delete(params.item.id);
        }
      }
      return;
    }

    if (message.method === "turn/diff/updated") {
      const params = message.params as TurnDiffUpdatedParams;
      const active = this.#activeTurns.get(params.turnId);
      if (active) {
        active.diffChanges = changedFiles(params.diff);
        emitFileActivity(
          active,
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
      const active = this.#activeTurns.get(params.turnId);
      if (active) {
        active.latestUsage = params.tokenUsage.last;
        active.onActivity?.(
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
        active.onActivity?.(
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
      for (const [turnId, active] of this.#activeTurns) {
        if (params.threadId && params.threadId !== active.threadId) continue;
        active.onActivity?.(
          normalizeNoticeActivity({
            level: "warning",
            message: params.message,
            correlation: eventCorrelation(
              message.method,
              diagnosticId,
              params.threadId ?? active.threadId,
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
        active.onActivity?.(
          normalizeNoticeActivity({
            level: "warning",
            message: params.summary,
            details:
              [params.details, params.path]
                .filter((value): value is string => Boolean(value))
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
      this.#activeTurns.get(params.turnId)?.onActivity?.(
        normalizeNoticeActivity({
          level: "error",
          message: params.error.message,
          details: params.error.additionalDetails,
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
      return;
    }

    if (message.method === "turn/completed") {
      const params = message.params as TurnCompletedParams;
      const active = this.#activeTurns.get(params.turn.id);
      if (!active) {
        return;
      }
      const correlation = eventCorrelation(
        message.method,
        diagnosticId,
        params.threadId,
        params.turn.id,
        null,
      );
      if (params.turn.error?.message) {
        active.onActivity?.(
          normalizeNoticeActivity({
            level: "error",
            message: params.turn.error.message,
            details: params.turn.error.additionalDetails,
            willRetry: false,
            correlation,
          }),
        );
      }
      active.onActivity?.(
        turnSummaryActivity(
          {
            id: params.turn.id,
            status: params.turn.status,
            startedAt: params.turn.startedAt ?? null,
            completedAt: params.turn.completedAt ?? null,
            durationMs: params.turn.durationMs ?? null,
          },
          correlation,
        ),
      );
      this.#activeTurns.delete(params.turn.id);
      if (active.timeout) {
        clearTimeout(active.timeout);
        active.timeout = null;
      }
      active.durationMs =
        params.turn.durationMs ?? Math.max(0, Date.now() - active.startedAtMs);
      if (params.turn.status !== "completed") {
        void this.failTurn(
          active,
          params.turn.id,
          new Error(
            params.turn.error?.message ??
              `Codex turn ended with ${params.turn.status}.`,
          ),
        );
        return;
      }
      void this.completeTurn(active, params.turn.id);
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
      const text = active.finalText ?? active.delta;
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
          active.reasoningSummaries.clear();
          const continued = (await this.request("turn/start", {
            threadId: active.threadId,
            ...codexWorkspaceContext(active.cwd),
            clientUserMessageId: `cantrip:goal:${turnId}`,
            input: [
              {
                type: "text",
                text: GOAL_CONTINUATION_PROMPT,
                text_elements: [],
              },
            ],
            model: active.model.name,
            ...(active.collaborationMode
              ? { collaborationMode: active.collaborationMode }
              : {}),
          })) as TurnStartResponse;
          this.#activeTurns.set(continued.turn.id, active);
          return;
        }
      }
      active.resolve(
        active.executionKind === "workflow"
          ? workflowNodeExecutionResultSchema.parse({
              threadId: active.threadId,
              turnId,
              text,
              structuredResult: parseWorkflowStructuredResult(
                text,
                active.workflowOutputSchema ?? {},
              ),
              measuredUsage: workflowMeasuredUsage(
                active.latestUsage,
                active.durationMs ?? Date.now() - active.startedAtMs,
              ),
              status: "completed",
            })
          : agentTurnResultSchema.parse({
              threadId: active.threadId,
              turnId,
              text,
              status: "completed",
            }),
      );
    } catch (error) {
      active.reject(error instanceof Error ? error : new Error(String(error)));
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
    } finally {
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

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    if (message.id === undefined) {
      return;
    }
    const request = agentInteractionRequestFromServerRequest(
      message.method ?? "",
      message.params,
      `codex:${this.#appServerSessionId}:${String(message.id)}`,
    );
    if (request) {
      const active = request.turnId
        ? this.#activeTurns.get(request.turnId)
        : [...this.#activeTurns.values()].find(
            (candidate) => candidate.threadId === request.threadId,
          );
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
            "Preauthorized workflow nodes cannot open interactive requests.",
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
    const correlated = { id, ...diagnostic };
    this.#runtimeDiagnostics.push(correlated);
    if (this.#runtimeDiagnostics.length > CODEX_DIAGNOSTIC_LIMIT) {
      this.#runtimeDiagnostics.splice(
        0,
        this.#runtimeDiagnostics.length - CODEX_DIAGNOSTIC_LIMIT,
      );
    }
    this.onDiagnostic?.(correlated);
    if (warning) workerLogger.warn(warning, { subsystem: "codex" });
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
    for (const active of this.#activeTurns.values()) {
      if (active.timeout) clearTimeout(active.timeout);
      active.reject(error);
    }
    this.#activeTurns.clear();
    this.#collaborationModes.clear();
  }
}
