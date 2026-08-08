import type {
  AgentThreadSync,
  AgentTurnResult,
  ChatGoalResponse,
  CodexRuntimeReport,
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

  runTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult>;
  listSkills(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
    forceReload?: boolean,
  ): Promise<CodexSkill[]>;
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
  interruptThread(threadId: string): Promise<{ interrupted: boolean }>;
  steerThread(
    chatId: string,
    threadId: string | null,
    prompt: string,
  ): Promise<{ steered: true; turnId: string }>;
  diagnostics(): CodexRuntimeDiagnostic[];
  close(): void;
}
