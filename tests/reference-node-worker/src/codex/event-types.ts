import type { InterAgentCommunicationItem } from "./agent-communication.js";
import type { NormalizedAgentMessage, ThreadGoal } from "@cantrip/protocol";

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

export interface CodexThreadListResponse {
  data: Array<CodexThreadReadResponse["thread"]>;
  nextCursor: string | null;
}

interface WorkspaceFileState {
  fingerprint: string;
  status: string;
}

export type WorkspaceSnapshot = Map<string, WorkspaceFileState>;

export type WorkspaceSnapshotMetadataReader = (
  filePath: string,
) => Promise<{ mode: number; mtimeMs: number; size: number }>;

export interface AgentMessageDeltaParams {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
}

export interface CommandExecutionOutputDeltaParams {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
}

export interface ReasoningSummaryPartAddedParams {
  itemId: string;
  summaryIndex: number;
  threadId: string;
  turnId: string;
}

export interface ReasoningSummaryTextDeltaParams extends ReasoningSummaryPartAddedParams {
  delta: string;
}

export interface CommandExecutionItem {
  aggregatedOutput: string | null;
  command: string;
  cwd: string;
  durationMs?: number | null;
  exitCode: number | null;
  id: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  type: "commandExecution";
}

export interface FileUpdateChange {
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

export interface FileChangePatchUpdatedParams {
  changes: FileUpdateChange[];
  itemId: string;
  threadId: string;
  turnId: string;
}

export interface AgentMessageItem {
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

export interface McpToolCallItem {
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

export interface WebSearchItem {
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

export type CodexThreadItem =
  | AgentMessageItem
  | PlanItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | DynamicToolCallItem
  | CollabAgentToolCallItem
  | SubAgentActivityItem
  | InterAgentCommunicationItem
  | WebSearchItem
  | ImageViewItem
  | ReviewModeItem
  | ContextCompactionItem;

export interface ItemLifecycleParams {
  completedAtMs?: number;
  item: CodexThreadItem;
  startedAtMs?: number;
  threadId: string;
  turnId: string;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
  };
}

export interface ActiveAgentContextWindow {
  threadId: string;
  turnId: string;
  usedTokens: number | null;
  contextWindowTokens: number | null;
  remainingTokens: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  usageUpdatedAtMs: number | null;
  compactionScheduled: boolean;
}

export interface ActiveAgentContextWindowSource {
  contextCompactionRequestedAtMs: number | null;
  contextUsage: {
    last: { totalTokens: number };
    modelContextWindow: number | null;
  } | null;
  contextUsageUpdatedAtMs: number | null;
  threadId: string;
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountRateLimitsUpdatedParams {
  rateLimits: {
    credits?: import("@cantrip/protocol").ProviderCreditsSnapshot | null;
    limitId: string | null;
    limitName: string | null;
    planType: string | null;
    primary: RateLimitWindow | null;
    rateLimitReachedType: string | null;
    secondary: RateLimitWindow | null;
  };
}

export interface WarningParams {
  message: string;
  threadId: string | null;
}

export interface ConfigWarningParams {
  details: string | null;
  path?: string;
  summary: string;
}

export interface TurnError {
  additionalDetails?: string | null;
  codexErrorInfo?: unknown;
  message: string;
}

export interface ErrorNotificationParams {
  error: TurnError;
  threadId: string;
  turnId: string;
  willRetry: boolean;
}

export interface TurnDiffUpdatedParams {
  diff: string;
  threadId: string;
  turnId: string;
}

export interface ThreadGoalUpdatedParams {
  goal: ThreadGoal;
  threadId: string;
  turnId: string | null;
}

export interface ThreadGoalClearedParams {
  threadId: string;
}

export interface StagedAgentMessageResult {
  emitted: NormalizedAgentMessage[];
  pending: NormalizedAgentMessage | null;
}
