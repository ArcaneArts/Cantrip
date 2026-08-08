import type {
  AgentInteractionResponse,
  AgentThreadSync,
  AgentTurnResult,
  ChatGoalResponse,
  ChatPlanAnswer,
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
  PermissionProfileCapability,
  PlanMode,
} from "@cantrip/protocol";

import type {
  CodexSkill,
  CompactAgentThreadOptions,
  GoalRuntimeOptions,
  RuntimeChatAttachment,
  RunAgentTurnOptions,
} from "./app-server.js";

export interface CodexRuntimeDiagnostic {
  id: string;
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
  readCustomizationInventory(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
    forceReload?: boolean,
  ): Promise<CodexCustomizationInventory>;
  previewExternalAgentConfig(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
  ): Promise<CodexExternalImportPreview>;
  readMcpResource(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      server: string;
      uri: string;
    },
  ): Promise<CodexMcpResourceRead>;
  configureSkill(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      path: string;
      enabled: boolean;
    },
  ): Promise<CodexSkillConfigResult>;
  setSkillRoots(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      roots: string[];
    },
  ): Promise<CodexSkillRootsResult>;
  startMcpOauth(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      server: string;
    },
  ): Promise<CodexMcpOauthStartResult>;
  mcpOauthStatus(server: string): CodexMcpOauthStatus;
  reloadMcpServers(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
  ): Promise<CodexMcpReloadResult>;
  applyExternalAgentConfig(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      itemIds: string[];
    },
  ): Promise<CodexExternalImportStatus>;
  externalImportStatus(importId: string): CodexExternalImportStatus;
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
    attachments?: RuntimeChatAttachment[],
    model?: RunAgentTurnOptions["model"],
    provider?: RunAgentTurnOptions["provider"],
  ): Promise<{ steered: true; turnId: string }>;
  diagnostics(): CodexRuntimeDiagnostic[];
  close(): void;
}
