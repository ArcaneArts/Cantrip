import type {
  AgentInteractionResponse,
  AgentThreadSync,
  AgentTurnResult,
  ChatGoalResponse,
  ChatPlanAnswer,
  CodexRuntimeReport,
  PermissionProfileCapability,
  PlanMode,
} from "@cantrip/protocol";

import type {
  CodexSkill,
  CompactAgentThreadOptions,
  GoalRuntimeOptions,
  RunAgentTurnOptions,
} from "./app-server.js";

export interface CodexRuntimeDiagnostic {
  at: string;
  direction: "from-runtime";
  kind:
    | "message"
    | "malformed"
    | "unknown-notification"
    | "unsupported-request"
    | "unmatched-response";
  method: string | null;
  payload: unknown;
}

export interface CodexRuntime {
  readonly compatibility: CodexRuntimeReport;

  setChatPaused(chatId: string, paused: boolean): void;
  runTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult>;
  listSkills(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
    forceReload?: boolean,
  ): Promise<CodexSkill[]>;
  listPermissionProfiles(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
  ): Promise<PermissionProfileCapability>;
  remoteEndpoint(
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
  ): Promise<string>;
  syncThread(
    options: Pick<
      RunAgentTurnOptions,
      "cwd" | "model" | "provider" | "threadId"
    > & { threadId: string },
  ): Promise<AgentThreadSync>;
  prepareExternalSync(
    options: Pick<
      RunAgentTurnOptions,
      "cwd" | "model" | "provider" | "threadId"
    > & { threadId: string },
  ): Promise<void>;
  compactThread(
    options: CompactAgentThreadOptions,
  ): Promise<{ accepted: true }>;
  getGoal(
    options: GoalRuntimeOptions & { threadId: string },
  ): Promise<ChatGoalResponse>;
  createGoal(
    options: GoalRuntimeOptions & {
      objective: string;
      tokenBudget?: number | null;
    },
  ): Promise<ChatGoalResponse>;
  updateGoal(
    options: GoalRuntimeOptions & {
      status: "active" | "paused";
      threadId: string;
    },
  ): Promise<ChatGoalResponse>;
  clearGoal(
    options: GoalRuntimeOptions & { threadId: string },
  ): Promise<{ cleared: boolean }>;
  getPlanMode(
    options: GoalRuntimeOptions & { fallbackMode: PlanMode },
  ): Promise<{ mode: PlanMode; threadId: string | null }>;
  setPlanMode(
    options: GoalRuntimeOptions & { mode: PlanMode },
  ): Promise<{ mode: PlanMode; threadId: string }>;
  answerPlanQuestion(
    questionId: string,
    answers: ChatPlanAnswer["answers"],
  ): Promise<{ accepted: true; requestKey?: string }>;
  answerAgentInteraction(
    requestKey: string,
    response: AgentInteractionResponse,
  ): Promise<{ accepted: true }>;
  cancelAgentInteraction(
    requestKey: string,
    reason: string,
  ): Promise<{ accepted: true }>;
  interruptThread(threadId: string): Promise<{ interrupted: boolean }>;
  steerThread(
    chatId: string,
    threadId: string | null,
    prompt: string,
  ): Promise<{ steered: true; turnId: string }>;
  diagnostics(): CodexRuntimeDiagnostic[];
  close(): void;
}
