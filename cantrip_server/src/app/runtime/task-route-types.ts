import type {
  AgentTurnResult,
  ChatMessage,
  ChatTurnCreate,
  ModelConfiguration,
  TaskDispatchCycleSummary,
  TaskDispatchWorkerLease,
} from "@cantrip/protocol";
import type {
  TaskGoalWorkerResult,
  TaskMessageOpaqueContent,
  TaskOpaqueSummary,
  TaskOperationRelayRequest,
} from "@cantrip/protocol/tasks";
import type { FastifyReply } from "fastify";
import type {
  ChatExecutionAttribution,
  ChatExecutionContext,
  ChatLiveRouting,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import type {
  ClaimedTaskDispatch,
  TaskDispatchEligibilityResolver,
} from "../../db/task-dispatch.js";
import type { ResolvedModelRoutePair } from "../../models/subagent-routing.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { ChatLiveResource } from "../shared/live-resources.js";

type TaskTurnInput = Omit<ChatTurnCreate, "attachmentIds" | "mode"> & {
  attachmentIds?: string[];
  customSubagentModel?: boolean;
  mode?: ChatTurnCreate["mode"];
  subagentModelId?: string | null;
  subagentReasoningEffort?: ChatExecutionContext["reasoningEffort"];
};

interface TaskTurnCallbackInput {
  attribution: ChatExecutionAttribution;
  execution: ChatExecutionContext;
  result: AgentTurnResult;
  userMessage: ChatMessage;
}

interface TaskTurnOptions {
  encryptedTaskMessages?: {
    userMessage: TaskMessageOpaqueContent;
    response?: { id: string; idempotencyKey: string };
  };
  purpose?: string;
  runtimes?: ModelRuntime[];
  preflightWorkerCommandTimeoutMs?: number | null;
  structuredResult?: {
    taskOperation: TaskOperationRelayRequest;
    afterCompleted?(input: TaskTurnCallbackInput): Promise<void>;
    onCompleted(input: TaskTurnCallbackInput): Promise<void>;
    onFailed(input: {
      error: unknown;
      execution: ChatExecutionContext;
      userMessage: ChatMessage;
    }): Promise<void>;
  };
  afterTurnCompleted?(input: TaskTurnCallbackInput): Promise<void>;
  afterTurnFailed?(input: {
    error: unknown;
    execution: ChatExecutionContext;
    userMessage: ChatMessage;
  }): Promise<void>;
  taskDispatchLease?: TaskDispatchWorkerLease;
}

interface TaskGoalLaunchOptions {
  afterTurnCompleted?(input: TaskTurnCallbackInput): Promise<void>;
  afterTurnFailed?(input: {
    error: unknown;
    execution: ChatExecutionContext;
    userMessage: ChatMessage;
  }): Promise<void>;
  modelConfiguration?: ModelConfiguration;
  runtimes?: ModelRuntime[];
  taskDispatchLease?: TaskDispatchWorkerLease;
}

export interface PreparedTaskDispatchEligibility {
  resolve: TaskDispatchEligibilityResolver;
  runtimeForClaim(claim: ClaimedTaskDispatch): ModelRuntime | null;
}

export interface TaskRouteRuntimeDependencies {
  appendLiveTaskMessage: (
    ownerId: string,
    chatId: string,
    message: TaskMessageOpaqueContent,
    attribution?: ChatExecutionAttribution,
    routing?: ChatLiveRouting,
  ) => ReturnType<ServerRepository["appendTaskMessage"]>;
  applicationOwnerId: () => string;
  availableModelRuntimes: (
    context: { providerAccountId?: string | null; workerId: string },
    modelId: string,
  ) => Promise<ModelRuntime[]>;
  beginTurn: (
    context: ChatExecutionContext,
    input: TaskTurnInput,
    options?: TaskTurnOptions,
  ) => Promise<ChatMessage>;
  bridge: LimitedWorkerCommandBus;
  failTaskGoalLaunch: (
    chatId: string,
    operationId: string,
    error: unknown,
  ) => Promise<void>;
  launchPreparedTaskGoal: (
    chatId: string,
    operationId: string,
    options?: TaskGoalLaunchOptions,
  ) => Promise<unknown>;
  publishChatInvalidation: (
    chatId: string,
    resource: ChatLiveResource,
    entityId?: string | null,
    routing?: ChatLiveRouting,
  ) => void;
  publishChatSummary: (chatId: string, projectId: string | null) => void;
  publishLiveInvalidation: (
    resource: "task",
    input: { projectId: string },
  ) => void;
  readEncryptedTaskGoal: (
    context: ChatExecutionContext,
    task: TaskOpaqueSummary,
  ) => Promise<
    Omit<TaskGoalWorkerResult, "task"> & { task: TaskOpaqueSummary }
  >;
  releaseTaskGoalLease: (cycleId: string) => void;
  repository: ServerRepository;
  resolveModelId: (
    context: ChatExecutionContext,
    requestedModelId?: string,
  ) => Promise<string>;
  retainTaskGoalLease: (lease: TaskDispatchWorkerLease) => Promise<void>;
  resumeChatAutomation: (chatId: string) => Promise<void>;
  routePairsForConfiguration: (
    context: ChatExecutionContext,
    configuration: ModelConfiguration,
    rootRuntimes?: ModelRuntime[],
  ) => Promise<ResolvedModelRoutePair[]>;
  runAsOwner: <T>(ownerId: string, operation: () => T) => T;
  runtimeCanResumeContext: (
    context: ChatExecutionContext,
    runtime: ModelRuntime,
  ) => boolean;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  scheduledTaskGoalTurnOptions: (
    lease: TaskDispatchWorkerLease,
  ) => TaskGoalLaunchOptions;
  sendModelConfigurationResolutionFailure: (
    reply: FastifyReply,
    error: unknown,
  ) => FastifyReply | null;
  serverId: string;
  serverInstanceId: string;
  taskDispatchCycleLease: (
    dispatch: TaskDispatchCycleSummary | null,
  ) => TaskDispatchWorkerLease | null;
}
