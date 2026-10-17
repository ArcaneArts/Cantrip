import type {
  ChildProcessWithoutNullStreams,
  ProcessEnvOptions,
} from "node:child_process";
import type {
  AgentActivity,
  AgentInteractionResponse,
  AgentInteractionRuntimeRequest,
  AgentScope,
  AgentTurnResult,
  ChatAttachmentSummary,
  ChatRelocationContextPayload,
  CodexEventCorrelation,
  McpServerConfiguration,
  NativeInitialTurnSettings,
  NormalizedAgentMessage,
  PendingPlanQuestion,
  PermissionTransition,
  PlanMode,
  PlanStep,
  WorkerCommand,
} from "@cantrip/protocol";
import type {
  CommandExecutionItem,
  ThreadTokenUsageUpdatedParams,
  TokenUsageBreakdown,
  TurnError,
  WorkspaceSnapshot,
} from "./event-types.js";
import type { CodexExecutionLifetime } from "./execution-lifetime.js";
import type { RuntimeProvider } from "./external-chatgpt-auth.js";
import type { MeasuredAgentUsage } from "@cantrip/protocol/agent-usage";
import type { NativeThreadSettings } from "./native-thread-settings.js";
import type { ManagedHistoryImport } from "./managed-history-transfer.js";

export type CodexProcessLauncher = (
  binary: string,
  arguments_: string[],
  options: ProcessEnvOptions,
) => ChildProcessWithoutNullStreams;

export interface RpcError {
  code: number;
  message: string;
}

export interface RpcMessage {
  historyCursor?: unknown;
  error?: RpcError;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

export interface PendingRpcRequest {
  method: string;
  reject(error: Error): void;
  resolve(result: unknown): void;
  startedAtMs: number;
  timeout: ReturnType<typeof setTimeout>;
}

export interface ActiveTurn {
  goalCompletion?: {
    turnId: string;
    text: string;
    checkpointPublished: boolean;
  };
  nativeModelAttribution?: import("@cantrip/protocol").NativeTurnModelAttribution;
  initialSettings?: NativeInitialTurnSettings;
  inheritThreadSettings?: boolean;
  admission?: {
    operationGeneration: string;
    controller: AbortController;
    initialTurnId: string | null;
    resolvedRequestIds: Set<string>;
  };
  agentScope: AgentScope | null;
  baseline: WorkspaceSnapshot;
  chatId: string | null;
  collaborationMode: NativeCollaborationMode | null;
  contextCompactionRequestedAtMs: number | null;
  contextUsage: ThreadTokenUsageUpdatedParams["tokenUsage"] | null;
  contextUsageUpdatedAtMs: number | null;
  captureProtectedDiagnostics: boolean;
  commandTelemetry: Map<string, ActiveCommandTelemetry>;
  completedCommandIds: Set<string>;
  cwd: string;
  delta: string;
  diffChanges: FileActivityChange[];
  durationMs: number | null;
  executionKind: "chat" | "operation";
  executionLaneId: string | null;
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
  onInteractionCleared?: (
    requestKey: string,
    response?: AgentInteractionResponse,
  ) => void;
  onInteractionExpired?: (requestKey: string) => void;
  onInteractionRequest?: (request: AgentInteractionRuntimeRequest) => void;
  onNativeInteractionRequest?: (
    request: AdmittedNativeReply,
  ) => void | Promise<void>;
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

export type AgentEventState = Pick<
  ActiveTurn,
  | "agentScope"
  | "initialSettings"
  | "nativeModelAttribution"
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

export type AgentRuntimeStatus =
  "starting" | "running" | "idle" | "completed" | "failed" | "interrupted";

export interface AgentRuntimeState extends AgentEventState {
  computerUseLifetime: CodexExecutionLifetime;
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

export interface RootExecution {
  computerUseLifetime: CodexExecutionLifetime;
  active: ActiveTurn;
  agents: Map<string, AgentRuntimeState>;
  rootThreadId: string;
  rootTurnId: string | null;
}

export interface ChildThreadMetadata {
  agentPath?: string | null;
  depth?: number | null;
  nickname?: string | null;
  parentThreadId: string;
  role?: string | null;
  threadId: string;
}

export interface AgentNotificationTarget {
  active: ActiveTurn;
  execution: RootExecution;
  isRoot: boolean;
  state: AgentEventState;
}

export type FileActivityChange = Extract<
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

export interface ActiveCommandTelemetry extends CommandTelemetryValue {
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

export type CodexExternalThreadChangeKind = "turn" | "goal" | "queue" | "plan";

export interface CodexExternalThreadChange {
  changes: CodexExternalThreadChangeKind[];
  revision: number;
  threadId: string;
}

export interface ThreadResponse {
  thread: { id: string };
}

export interface TurnStartResponse {
  turn: { id: string };
}

export interface TurnStartedParams {
  threadId: string;
  initialSettings?: NativeInitialTurnSettings;
  turn: {
    id: string;
    startedAt?: number | null;
  };
}

export interface TurnCompletedParams {
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

export interface ThreadStartedParams {
  thread: {
    agentNickname?: string | null;
    agentRole?: string | null;
    id: string;
    parentThreadId?: string | null;
    source?: unknown;
    status?: { type?: string };
  };
}

export interface ThreadStatusChangedParams {
  status: { type?: string };
  threadId: string;
}

export interface NativeCollaborationMode {
  mode: PlanMode;
  settings: {
    model: string;
    reasoning_effort: RunAgentTurnOptions["model"]["reasoningEffort"];
    developer_instructions: null;
  };
}

export interface NativeCollaborationModeListResponse {
  data: Array<{
    mode: PlanMode | null;
    model: string | null;
    reasoning_effort: RunAgentTurnOptions["model"]["reasoningEffort"];
  }>;
}

export interface TurnPlanUpdatedParams {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: PlanStep[];
}

export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: PendingPlanQuestion["questions"];
  autoResolutionMs: number | null;
}

export interface ServerRequestResolvedParams {
  threadId: string;
  requestId: number | string;
}

export interface NativePendingPlanQuestion {
  active: ActiveTurn;
  question: PendingPlanQuestion;
  requestKey: string;
}

export interface NativePendingAgentInteraction {
  stopPublication?: () => void;
  requestMethod: string;
  active: ActiveTurn;
  request: AgentInteractionRuntimeRequest;
  rpcId: number | string;
  timeout: ReturnType<typeof setTimeout>;
}

export interface RunAgentTurnRetry {
  reason: "capacity" | "invalid-compaction";
  attempt: number;
  operationGeneration: string | null;
  threadId: string | null;
  turnId: string | null;
  nextThreadId: string | null;
  error: unknown;
  signal: AbortSignal;
}

export interface RunAgentTurnOptions {
  /** Shared managed preparation owns configuration; this input inherits the native
   * thread selection instead of replaying a possibly stale GUI bootstrap model. */
  inheritThreadSettings?: boolean;
  /** Already protected, complete native queue vector. Never flatten or append inferred skills. */
  nativeInput?: ReadonlyArray<Record<string, unknown>>;
  nativeClientUserMessageId?: string;
  operationGeneration?: string;
  /** Exact logical-root cancellation before native dispatch; never a chat-wide active-turn interrupt. */
  preparationSignal?: AbortSignal;
  /** Performs initial managed preparation inside native retry/cancellation handling, without model input. */
  onBeforeFirstAttempt?: (
    signal: AbortSignal,
  ) => Promise<Partial<RunAgentTurnOptions>>;
  /** Replaces authority/options for an actual new native attempt after retry delay. */
  onBeforeRetry?: (
    retry: RunAgentTurnRetry,
  ) => Promise<Partial<RunAgentTurnOptions>>;
  onBeforeNativeDispatch?: (threadId: string) => Promise<void>;
  onNativeReceipt?: (receipt: { turn: { id: string } }) => Promise<void>;
  /** Persist an explicitly unconsumed input before ending this GUI attempt. */
  onNativeDeferred?: (input: {
    threadId: string;
    nativeInput: ReadonlyArray<Record<string, unknown>>;
    frame: { error: { code: number; message: string; data?: unknown } };
  }) => Promise<void>;
  onNativeInteractionRequest?: (
    request: AdmittedNativeReply,
  ) => void | Promise<void>;
  attachments?: RuntimeChatAttachment[];
  chatId: string;
  captureProtectedDiagnostics: boolean;
  clientMessageId: string;
  cwd: string;
  executionProfile: "ide" | "standalone-chat";
  executionLaneId?: string;
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

export type PrepareAdmittedNativeExecutionOptions = Pick<
  RunAgentTurnOptions,
  | "chatId"
  | "cwd"
  | "executionLaneId"
  | "model"
  | "provider"
  | "captureProtectedDiagnostics"
  | "onActivity"
  | "onMessage"
  | "onInteractionCleared"
  | "onInteractionExpired"
  | "onInteractionRequest"
  | "onCheckpoint"
  | "onPlan"
  | "onPlanQuestion"
  | "onPlanQuestionResolved"
  | "onNativeInteractionRequest"
> & {
  operationGeneration: string;
  threadId: string;
  /** Native preallocated identity. Matching it does not itself start a turn. */
  expectedTurnId?: string;
};

export interface ManagedExecutionAttempt {
  threadId: string;
  runnerGeneration: string;
  attemptId: string;
  turnId: string;
  trigger: "goal" | "queue";
  goalEpoch?: string;
  input: Record<string, unknown>;
}

export interface ManagedExecutionDeclined extends Omit<
  ManagedExecutionAttempt,
  "input" | "trigger"
> {
  operationGeneration: string | null;
  reason: string;
}

export interface ManagedExecutionResolution {
  threadId: string;
  runnerGeneration: string;
  attemptId: string;
  operationGeneration: string | null;
  allow: boolean;
}

export interface ManagedExecutionGateHandler {
  requested(
    attempt: ManagedExecutionAttempt,
    signal: AbortSignal,
  ): Promise<void>;
  declined(event: ManagedExecutionDeclined): void | Promise<void>;
  failed(error: unknown): void;
}

export interface ManagedNativeGuiCommand {
  permissionTransition?: PermissionTransition;
  operationId?: string;
  /** Server-issued settings source; metadata, never a native API parameter. */
  settingsBindingId?: string;
  queueClaim?: { id: string; promptRevision: number };
  method: string;
  params: Record<string, unknown>;
  reply?: {
    requestId: string | number;
    requestMethod: string;
    turnId: string | null;
  };
  /** Executes the exact already resolved native mutation once admission succeeds. */
  dispatch(forward?: {
    method: string;
    params: Record<string, unknown>;
  }): Promise<unknown>;
}

export type ManagedNativeCommandDispatcher = (
  command: ManagedNativeGuiCommand,
) => Promise<unknown>;

export interface AdmittedNativeReplyIdentity {
  operationGeneration: string;
  rootThreadId: string;
  requestId: string | number;
}

export interface AdmittedNativeReply extends AdmittedNativeReplyIdentity {
  requestKey: string;
  requestMethod: string;
  threadId: string;
  turnId: string | null;
  kind: AgentInteractionRuntimeRequest["payload"]["kind"];
}

export type AdmittedNativeReplyResponse =
  | { result: unknown; error?: never }
  | {
      error: { code: number; message: string; data?: unknown };
      result?: never;
    };

/** Registration of an already admitted operation, before its native mutation. */
export interface AdmittedNativeExecution {
  readonly operationGeneration: string;
  readonly threadId: string;
  /** Whole operation lifetime; actual root/child turn signals remain separate. */
  readonly signal: AbortSignal;
  readonly completion: Promise<AgentTurnResult>;
  assertCurrent(): void;
  /** Actual native receipt, never fabricated to create a turn identity. */
  bindReceipt(receipt: unknown): void;
  fail(error: Error): void;
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

export type GoalRuntimeOptions = Pick<
  RunAgentTurnOptions,
  | "cwd"
  | "mcpServers"
  | "model"
  | "permissionProfileId"
  | "provider"
  | "threadId"
>;

export interface NativeReplacementSettings {
  sourceThreadId: string;
  transportGeneration: string | null;
  sourcePreparationVersion: number;
  settings: NativeThreadSettings;
}

export interface PrepareManagedThreadOptions extends GoalRuntimeOptions {
  /** Actual source Core settings, restored before replacement handoff. */
  replacementSettings?: NativeReplacementSettings;
  signal?: AbortSignal;
  canonicalHistory?: boolean;
  executionGate?: { runnerGeneration: string };
  executionProfile: RunAgentTurnOptions["executionProfile"];
  subagentDefaults: RuntimeSubagentDefaults | null;
  planMode: PlanMode;
  intent: "configure" | "preserve";
  /** Bind identity before later initialization can fail or a view can attach. */
  onThreadIdentified?: (threadId: string) => void | Promise<void>;
}

export type PrepareImportedManagedThreadOptions = Omit<
  PrepareManagedThreadOptions,
  "threadId" | "intent" | "replacementSettings"
> & { transfer: ManagedHistoryImport };

export interface HydrateChatRelocationOptions extends GoalRuntimeOptions {
  payload: ChatRelocationContextPayload;
  planMode: PlanMode;
  requiredSkillNames: string[];
  onThreadStarted(threadId: string): Promise<void>;
}

export interface CodexSkill {
  name: string;
  description: string;
  displayName: string | null;
  path: string | null;
}

export type CompactAgentThreadOptions = Pick<
  RunAgentTurnOptions,
  "cwd" | "executionProfile" | "model" | "permissionProfileId" | "provider"
> & {
  threadId: string;
};
