import type {
  AgentTurnResult,
  ChatMessage,
  ChatMessageOpaqueContent,
  ChatTurnCreate,
  ReasoningEffort,
  TaskDispatchWorkerLease,
} from "@cantrip/protocol";
import type {
  TaskMessageOpaqueContent,
  TaskOperationRelayRequest,
} from "@cantrip/protocol/tasks";
import type { JsonObject } from "@cantrip/protocol/bounded-json";
import type { FastifyInstance } from "fastify";
import type {
  ChatExecutionAttribution,
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { createLiveMutationRuntime } from "./live-mutation-runtime.js";
import type { createModelRoutingRuntime } from "./model-routing-runtime.js";

type LiveMutationRuntime = ReturnType<typeof createLiveMutationRuntime>;
type ModelRoutingRuntime = ReturnType<typeof createModelRoutingRuntime>;
type OwnerRunner = <T>(ownerId: string, operation: () => T) => T;
export type ChatTurnInput = Omit<ChatTurnCreate, "attachmentIds" | "mode"> & {
  attachmentIds?: string[];
  customSubagentModel?: boolean;
  mode?: ChatTurnCreate["mode"];
  subagentModelId?: string | null;
  subagentReasoningEffort?: ReasoningEffort | null;
};

export interface ChatTurnOptions {
  expectedInputRevision?: number;
  managedQueueClaim?: { id: string; promptRevision: number };
  protectedNativeInput?: import("@cantrip/protocol").EncryptedPayloadEnvelope;
  nativeClientUserMessageId?: string;
  queuedPromptId?: string;
  acquiringActor?: "agent" | "user";
  encryptedTaskMessages?: {
    userMessage: TaskMessageOpaqueContent;
    response?: { id: string; idempotencyKey: string };
  };
  encryptedChatMessages?: {
    userMessage: ChatMessageOpaqueContent;
    response: { id: string; idempotencyKey: string };
  };
  messageRole?: "system" | "user";
  purpose?: string;
  retryMessageId?: string;
  runtimes?: ModelRuntime[];
  preflightWorkerCommandTimeoutMs?: number | null;
  structuredResult?: {
    outputSchema?: JsonObject;
    taskOperation?: TaskOperationRelayRequest;
    afterCompleted?(input: {
      attribution: ChatExecutionAttribution;
      execution: ChatExecutionContext;
      result: AgentTurnResult;
      userMessage: ChatMessage;
    }): Promise<void>;
    onCompleted(input: {
      attribution: ChatExecutionAttribution;
      execution: ChatExecutionContext;
      result: AgentTurnResult;
      userMessage: ChatMessage;
    }): Promise<void>;
    onFailed(input: {
      error: unknown;
      execution: ChatExecutionContext;
      userMessage: ChatMessage;
    }): Promise<void>;
  };
  afterTurnCompleted?(input: {
    attribution: ChatExecutionAttribution;
    execution: ChatExecutionContext;
    result: AgentTurnResult;
    userMessage: ChatMessage;
  }): Promise<void>;
  afterTurnFailed?(input: {
    error: unknown;
    execution: ChatExecutionContext;
    userMessage: ChatMessage;
  }): Promise<void>;
  workerPrompt?: string;
  taskDispatchLease?: TaskDispatchWorkerLease;
}

export type BeginChatTurn = (
  context: ChatExecutionContext,
  input: ChatTurnInput,
  options?: ChatTurnOptions,
) => Promise<ChatMessage>;

interface ChatTurnLiveMutationDependencies extends Pick<
  LiveMutationRuntime,
  | "appendLiveChatMessage"
  | "appendLiveEncryptedChatMessage"
  | "appendLiveTaskMessage"
  | "interruptLiveAgentInteractionRequests"
  | "publishChatSummary"
  | "publishChatTurnBoundary"
  | "publishInferenceProgress"
  | "recordLiveAgentInteractionRequest"
  | "recordLiveEncryptedAgentInteractionRequest"
  | "setLiveChatMessageModelRoute"
  | "setLiveEncryptedChatMessageModelRoute"
  | "setLiveTaskMessageModelRoute"
  | "taskMessageServerStub"
  | "terminalizeLiveAgentInteractionRequest"
  | "updateLiveChatPlanMode"
  | "updateLiveEncryptedChatPlanState"
  | "upsertLiveChatMessage"
  | "upsertLiveEncryptedChatMessage"
  | "upsertLiveTaskMessage"
> {}

interface ChatTurnModelRoutingDependencies extends Pick<
  ModelRoutingRuntime,
  | "captureRuntimeQuota"
  | "recordRuntimeModelBehavior"
  | "recordRuntimeTokenUsage"
  | "resolveModelId"
  | "routePairsForConfiguration"
  | "runtimeCanResumeContext"
  | "scheduleRuntimeQuotaSamples"
> {}

export interface ChatTurnRuntimeDependencies
  extends ChatTurnLiveMutationDependencies, ChatTurnModelRoutingDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  serverId: string;
  bridge: LimitedWorkerCommandBus;
  cancelChatTurnOutcomeRecovery: (
    workerId: string,
    chatId: string,
    clientMessageId: string,
  ) => void;
  continuePendingWorktreeTransition: (chatId: string) => Promise<boolean>;
  dispatchNextQueuedPrompt: (chatId: string) => Promise<void>;
  notifyCodeAgentState: (
    context: Pick<ChatExecutionContext, "chatId" | "cwd" | "workerId">,
    phase: "started" | "completed" | "failed",
    paths?: Iterable<string>,
    timeoutMs?: number | null,
  ) => Promise<void>;
  prepareCodeEditorsForTurn: (
    context: ChatExecutionContext,
    timeoutMs?: number | null,
  ) => Promise<void>;
  repository: ServerRepository;
  resolvePromptAttachments: (
    context: ChatExecutionContext,
    attachmentIds: string[],
  ) => ReturnType<ServerRepository["getChatAttachments"]>;
  routeCooldowns: Map<string, number>;
  runtimeCooldownKey: (runtime: ModelRuntime) => string;
  runAsOwner: OwnerRunner;
}
