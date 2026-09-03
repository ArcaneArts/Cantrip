import type {
  AgentInteractionResponse,
  AgentThreadSync,
  AgentTurnResult,
  ChatGoalResponse,
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
  AgentOperationResult,
  CodexSkill,
  CompactAgentThreadOptions,
  GoalRuntimeOptions,
  HydrateChatRelocationOptions,
  RuntimeChatAttachment,
  RunAgentTurnOptions,
  RunAgentOperationOptions,
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

export async function interruptChatAcrossRuntimes(
  runtimes: Iterable<Pick<CodexRuntime, "interruptChat">>,
  chatId: string,
  threadId: string | null,
): Promise<{ interrupted: boolean }> {
  const results = await Promise.all(
    [...runtimes].map((runtime) => runtime.interruptChat(chatId, threadId)),
  );
  return { interrupted: results.some((result) => result.interrupted) };
}

export interface CodexRuntime {
  readonly compatibility: CodexRuntimeReport;

  setChatPaused(chatId: string, paused: boolean): void;
  setActiveChatPaused(
    chatId: string,
    paused: boolean,
  ): Promise<{ threadId: string; turnId: string } | null>;
  runTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult>;
  runAgentOperation(
    options: RunAgentOperationOptions,
  ): Promise<AgentOperationResult>;
  listSkills(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
    forceReload?: boolean,
  ): Promise<CodexSkill[]>;
  listSkillInventory(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider">,
    forceReload?: boolean,
  ): Promise<CodexCustomizationInventory["skills"]>;
  readCustomizationInventory(
    options: Pick<RunAgentTurnOptions, "cwd" | "model" | "provider"> & {
      threadId: string | null;
    },
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
      | "cwd"
      | "mcpServers"
      | "model"
      | "permissionProfileId"
      | "provider"
      | "threadId"
    > & { threadId: string },
  ): Promise<void>;
  compactThread(
    options: CompactAgentThreadOptions,
  ): Promise<{ accepted: true }>;
  ensureThread(
    options: GoalRuntimeOptions & { planMode: PlanMode },
  ): Promise<{ threadId: string }>;
  hydrateChatRelocation(
    options: HydrateChatRelocationOptions,
  ): Promise<{ threadId: string }>;
  discardRelocationThread(
    threadId: string,
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
  ): Promise<void>;
  releaseRelocationThread(
    threadId: string | null,
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
  ): Promise<{ released: boolean }>;
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
  answerAgentInteraction(
    requestKey: string,
    response: AgentInteractionResponse,
  ): Promise<{ accepted: true }>;
  cancelAgentInteraction(
    requestKey: string,
    reason: string,
  ): Promise<{ accepted: true }>;
  interruptChat(
    chatId: string,
    threadId: string | null,
  ): Promise<{ interrupted: boolean }>;
  rollbackLatestChatTurn(
    options: Pick<
      RunAgentTurnOptions,
      "cwd" | "model" | "permissionProfileId" | "provider"
    > & {
      clientMessageId: string;
      threadId: string;
    },
  ): Promise<{ rolledBack: true }>;
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
