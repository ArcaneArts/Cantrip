import { createHash } from "node:crypto";
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
  agentThreadSyncSchema,
  agentTurnResultSchema,
  chatGoalClearSchema,
  chatGoalResponseSchema,
  normalizeResponsesBaseUrl,
  threadGoalSchema,
  type AgentActivity,
  type AgentWorktreeToolName,
  type AgentWorktreeToolResult,
  type AgentThreadSync,
  type AgentThreadSyncItem,
  type AgentTurnResult,
  type ChatGoalResponse,
  type ThreadGoal,
  type WorkerCommand,
} from "@cantrip/protocol";
import WebSocket, { type RawData } from "ws";

interface RpcError {
  code: number;
  message: string;
}

interface RpcMessage {
  error?: RpcError;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface DynamicToolCallParams {
  arguments: unknown;
  callId: string;
  threadId: string;
  tool: string;
  turnId: string;
}

interface PendingRpcRequest {
  reject(error: Error): void;
  resolve(result: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

export type WorktreeToolHandler = (input: {
  arguments: Record<string, unknown>;
  callId: string;
  tool: AgentWorktreeToolName;
}) => Promise<AgentWorktreeToolResult>;

interface ActiveTurn {
  baseline: WorkspaceSnapshot;
  chatId: string;
  cwd: string;
  delta: string;
  diffChanges: Array<{ kind: "add" | "delete" | "update"; path: string }>;
  finalText: string | null;
  model: RunAgentTurnOptions["model"];
  onActivity?: (activity: AgentActivity) => void;
  onCheckpoint?: (checkpoint: { text: string; turnId: string }) => void;
  onWorktreeToolCall?: WorktreeToolHandler;
  reject(error: Error): void;
  resolve(result: AgentTurnResult): void;
  threadId: string;
}

interface ThreadTurn {
  completedAt: number | null;
  durationMs: number | null;
  error: { message: string } | null;
  id: string;
  items: Array<
    | (AgentMessageItem & { id: string })
    | CommandExecutionItem
    | FileChangeItem
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

interface ThreadResponse {
  thread: { id: string };
}

interface TurnStartResponse {
  turn: { id: string };
}

interface TurnCompletedParams {
  threadId: string;
  turn: {
    error: { message: string } | null;
    id: string;
    status: "completed" | "failed" | "interrupted" | "inProgress";
  };
}

interface AgentMessageDeltaParams {
  delta: string;
  threadId: string;
  turnId: string;
}

interface CommandExecutionItem {
  aggregatedOutput: string | null;
  command: string;
  cwd: string;
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
  phase?: "commentary" | "final_answer" | null;
  text?: string;
  type: "agentMessage";
}

interface ItemLifecycleParams {
  item: AgentMessageItem | CommandExecutionItem | FileChangeItem;
  threadId: string;
  turnId: string;
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

export interface RunAgentTurnOptions {
  chatId: string;
  clientMessageId: string;
  cwd: string;
  isPrimary: Extract<WorkerCommand, { type: "chat.turn" }>["isPrimary"];
  model: Extract<WorkerCommand, { type: "chat.turn" }>["model"];
  provider: Extract<WorkerCommand, { type: "chat.turn" }>["provider"];
  prompt: string;
  skillNames: string[];
  threadId: string | null;
  worktreeMode: Extract<WorkerCommand, { type: "chat.turn" }>["worktreeMode"];
  worktreePolicy: Extract<
    WorkerCommand,
    { type: "chat.turn" }
  >["worktreePolicy"];
  onActivity?: (activity: AgentActivity) => void;
  onCheckpoint?: ActiveTurn["onCheckpoint"];
  onWorktreeToolCall?: ActiveTurn["onWorktreeToolCall"];
}

type GoalRuntimeOptions = Pick<
  RunAgentTurnOptions,
  "cwd" | "model" | "provider" | "threadId"
>;

export const GOAL_CONTINUATION_PROMPT =
  "Continue working toward the active goal. Reassess progress, make the next useful scoped change, validate it, and update the goal status when it is complete or genuinely blocked.";

export function goalShouldContinue(goal: ThreadGoal | null): boolean {
  return goal?.status === "active";
}

const WORKTREE_TOOL_NAMES = new Set<AgentWorktreeToolName>([
  "cantrip_worktrees_list",
  "cantrip_worktree_acquire",
  "cantrip_worktree_create",
  "cantrip_worktree_switch",
  "cantrip_worktree_status",
  "cantrip_worktree_release",
  "cantrip_worktree_remove",
]);

const worktreeIdProperty = {
  type: "string",
  description: "The opaque Cantrip worktree id returned by a Cantrip tool.",
};

export const CANTRIP_WORKTREE_DYNAMIC_TOOLS = [
  {
    type: "function",
    name: "cantrip_worktrees_list",
    description:
      "List every validated worktree for this Cantrip project, including Primary, lifecycle, branch, ownership, and lease metadata.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "cantrip_worktree_create",
    description:
      "Create a worker-managed worktree without changing this running turn. Paths are chosen and validated by Cantrip.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short user-facing worktree name.",
        },
        intent: {
          type: "string",
          enum: ["newBranch", "existingBranch", "detached"],
          description: "How the checkout should be created.",
        },
        branch: {
          type: ["string", "null"],
          description: "Branch for newBranch or existingBranch intent.",
        },
        baseRevision: {
          type: ["string", "null"],
          description:
            "Optional base for a new branch; required revision for detached intent.",
        },
      },
      required: ["name", "intent"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "cantrip_worktree_acquire",
    description:
      "Create and acquire a new branch worktree, then schedule controlled continuation there. After success, stop the current turn; Cantrip will resume it safely in the new runtime.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short user-facing worktree name.",
        },
        intent: {
          type: "string",
          enum: ["newBranch", "existingBranch", "detached"],
          description: "How the checkout should be created.",
        },
        branch: {
          type: ["string", "null"],
          description: "Branch for newBranch or existingBranch intent.",
        },
        baseRevision: {
          type: ["string", "null"],
          description:
            "Optional base for a new branch; required revision for detached intent.",
        },
        purpose: { type: "string", description: "Why this lane is needed." },
      },
      required: ["name", "intent", "purpose"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "cantrip_worktree_switch",
    description:
      "Schedule controlled continuation in an existing worktree. After success, stop the current turn; Cantrip will resume it safely in the selected runtime.",
    inputSchema: {
      type: "object",
      properties: {
        worktreeId: worktreeIdProperty,
        purpose: { type: "string", description: "Why the chat is switching." },
      },
      required: ["worktreeId", "purpose"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "cantrip_worktree_status",
    description:
      "Read validated Git/worktree status for the current or specified worktree.",
    inputSchema: {
      type: "object",
      properties: {
        worktreeId: { ...worktreeIdProperty, type: ["string", "null"] },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "cantrip_worktree_release",
    description:
      "Safely release the current secondary worktree and schedule continuation in Primary. Dirty worktrees are rejected. After success, stop this turn.",
    inputSchema: {
      type: "object",
      properties: {
        purpose: { type: "string", description: "Why the lane is complete." },
      },
      required: ["purpose"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "cantrip_worktree_remove",
    description:
      "Remove a clean, non-current, agent-owned worktree after Cantrip verifies no active chat, terminal, or lease uses it. This never deletes its branch.",
    inputSchema: {
      type: "object",
      properties: { worktreeId: worktreeIdProperty },
      required: ["worktreeId"],
      additionalProperties: false,
    },
  },
] as const;

const CANTRIP_WORKTREE_DEVELOPER_INSTRUCTIONS =
  "Cantrip owns Git worktree paths and execution lanes. Use the cantrip_worktree_* tools instead of invoking git worktree directly. A successful acquire, switch, or release schedules a safe runtime transition; immediately finish the current turn after that tool returns so Cantrip can checkpoint and continue in the selected worktree. Never claim that CWD changed inside the current turn.";

export function codexWorktreeTurnPolicy(
  options: Pick<
    RunAgentTurnOptions,
    "cwd" | "isPrimary" | "worktreeMode" | "worktreePolicy"
  >,
) {
  const cwd = path.resolve(options.cwd);
  const primaryIsReadOnly =
    options.isPrimary && options.worktreePolicy === "required-for-writes";
  const modeInstruction =
    options.worktreeMode === "pinned"
      ? "This chat is pinned to the current worktree. Do not acquire or switch worktrees unless the user first returns the chat to Agent managed mode."
      : "This chat is Agent managed and may use Cantrip worktree tools when isolation is appropriate.";
  const policyInstruction = primaryIsReadOnly
    ? "The project policy is Required for writes and this turn is on Primary. Primary is inspection-only: do not mutate files or Git state here. Before writing, acquire, create, or switch to a secondary worktree with a Cantrip tool, then finish this turn so Cantrip can continue safely."
    : options.worktreePolicy === "direct"
      ? "The project policy is Direct. Writes are permitted in the current checkout, including Primary."
      : options.worktreePolicy === "required-for-writes"
        ? "The project policy is Required for writes and this turn is in a secondary worktree, so writes are permitted here."
        : "The project policy is Agent managed. You may work in the current checkout or acquire a secondary worktree when the task benefits from isolation.";
  return {
    additionalContext: {
      "cantrip.worktree-policy": {
        kind: "application",
        value: `${policyInstruction} ${modeInstruction}`,
      },
    },
    sandboxPolicy: primaryIsReadOnly
      ? { type: "readOnly", networkAccess: false }
      : {
          type: "workspaceWrite",
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
  } as const;
}

export async function executeDynamicWorktreeTool(
  handler: WorktreeToolHandler | undefined,
  params: DynamicToolCallParams,
): Promise<{
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
}> {
  const tool = params.tool as AgentWorktreeToolName;
  if (!handler || !WORKTREE_TOOL_NAMES.has(tool)) {
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: `Cantrip cannot handle dynamic tool ${params.tool}.`,
        },
      ],
    };
  }
  try {
    const result = await handler({
      arguments:
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {},
      callId: params.callId,
      tool,
    });
    return {
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
    };
  } catch (error) {
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
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
  "cwd" | "model" | "provider"
> & {
  threadId: string;
};

export function codexModelProviderName(
  provider: RunAgentTurnOptions["provider"],
): "cantrip_runtime" | "openai" {
  return provider.kind === "chatgpt" ? "openai" : "cantrip_runtime";
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
        providerName: provider.name,
        providerKind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${provider.id}:${model.routeId}:${configuration}`;
}

function activityStatus(
  status: CommandExecutionItem["status"],
): AgentActivity["status"] {
  return status === "inProgress" ? "running" : status;
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
    }),
  );
}

function toActivity(
  item: CommandExecutionItem | FileChangeItem,
  cwd: string,
): AgentActivity {
  if (item.type === "commandExecution") {
    return agentActivitySchema.parse({
      type: "command",
      id: item.id,
      command: item.command,
      cwd: displayPath(cwd, item.cwd) || ".",
      status: activityStatus(item.status),
      exitCode: item.exitCode,
      output: commandOutput(item.aggregatedOutput),
    });
  }
  return agentActivitySchema.parse({
    type: "fileChange",
    id: item.id,
    status: activityStatus(item.status),
    changes: item.changes.map((change) => ({
      path: displayPath(cwd, change.path),
      kind: change.kind.type,
    })),
  });
}

export class CodexAppServer {
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #externalTurnBaselines = new Map<string, Set<string>>();
  readonly #goals = new Map<string, ThreadGoal>();
  readonly #loadedThreads = new Set<string>();
  readonly #pending = new Map<number, PendingRpcRequest>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #remoteUrl: string | null = null;
  #runtimeId: string | null = null;
  #nextId = 1;
  #socket: WebSocket | null = null;
  #starting: Promise<void> | null = null;

  constructor(
    private readonly codexBinary: string,
    private readonly dataDirectory: string,
    private readonly codexHome: string = path.join(dataDirectory, "codex-home"),
  ) {}

  async runTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
    await this.ensureStarted(options.model, options.provider);
    const baseline = await workspaceSnapshot(options.cwd);
    const threadId = await this.loadThread(options);
    if (!threadId) {
      throw new Error("Could not start a Codex thread.");
    }
    await this.refreshGoal(threadId);

    if (this.hasActiveThread(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }

    let activeTurn: ActiveTurn | undefined;
    const completion = new Promise<AgentTurnResult>((resolve, reject) => {
      activeTurn = {
        baseline,
        chatId: options.chatId,
        cwd: options.cwd,
        delta: "",
        diffChanges: [],
        finalText: null,
        model: options.model,
        onActivity: options.onActivity,
        onCheckpoint: options.onCheckpoint,
        onWorktreeToolCall: options.onWorktreeToolCall,
        reject,
        resolve,
        threadId,
      };
    });

    const availableSkills = options.skillNames.length
      ? await this.listSkills(options)
      : [];
    const selectedSkills = new Map(
      availableSkills.map((skill) => [skill.name, skill]),
    );
    const response = (await this.request("turn/start", {
      threadId,
      ...codexWorkspaceContext(options.cwd),
      ...codexWorktreeTurnPolicy(options),
      clientUserMessageId: `cantrip:${options.clientMessageId}`,
      input: [
        { type: "text", text: options.prompt, text_elements: [] },
        ...options.skillNames.flatMap((name) => {
          const skill = selectedSkills.get(name);
          return skill?.path
            ? [{ type: "skill", name: skill.name, path: skill.path }]
            : [];
        }),
      ],
      model: options.model.name,
    })) as TurnStartResponse;
    if (!activeTurn) {
      throw new Error("Could not initialize the Codex turn.");
    }
    this.#activeTurns.set(response.turn.id, activeTurn);
    return completion;
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
      .map((turn) => this.syncTurn(turn, options.cwd));
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
      input: [{ type: "text", text: prompt, text_elements: [] }],
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
    this.#externalTurnBaselines.clear();
    this.#goals.clear();
  }

  private async ensureStarted(
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
  ): Promise<void> {
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

  private stopFailedStart(): void {
    const socket = this.#socket;
    const child = this.#child;
    this.#socket = null;
    this.#child = null;
    this.#remoteUrl = null;
    this.#runtimeId = null;
    this.#loadedThreads.clear();
    this.#externalTurnBaselines.clear();
    socket?.close();
    child?.kill("SIGINT");
  }

  private async loadThread(
    options: Pick<
      RunAgentTurnOptions,
      "cwd" | "model" | "provider" | "threadId"
    >,
    create = true,
  ): Promise<string | null> {
    const modelProvider = codexModelProviderName(options.provider);
    let threadId = options.threadId;
    if (threadId && !this.#loadedThreads.has(threadId)) {
      try {
        const resumed = (await this.request("thread/resume", {
          threadId,
          model: options.model.name,
          modelProvider,
          ...codexWorkspaceContext(options.cwd),
          approvalPolicy: "never",
          sandbox: "workspace-write",
        })) as ThreadResponse;
        threadId = resumed.thread.id;
        this.#loadedThreads.add(threadId);
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
        approvalPolicy: "never",
        sandbox: "workspace-write",
        developerInstructions: CANTRIP_WORKTREE_DEVELOPER_INSTRUCTIONS,
        dynamicTools: CANTRIP_WORKTREE_DYNAMIC_TOOLS,
      })) as ThreadResponse;
      threadId = started.thread.id;
      this.#loadedThreads.add(threadId);
    }
    return threadId;
  }

  private hasActiveThread(threadId: string): boolean {
    return [...this.#activeTurns.values()].some(
      (active) => active.threadId === threadId,
    );
  }

  private syncTurn(turn: ThreadTurn, cwd: string) {
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
        const text = item.text?.trim();
        return text
          ? [
              {
                type: "agentMessage",
                id: item.id,
                text,
                phase: item.phase ?? null,
              },
            ]
          : [];
      }
      if (item.type === "commandExecution" || item.type === "fileChange") {
        return [{ type: "activity", activity: toActivity(item, cwd) }];
      }
      return [];
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
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
  ): Promise<void> {
    await mkdir(this.codexHome, { recursive: true });
    const providerArguments =
      provider.kind === "chatgpt"
        ? ['model_provider="openai"']
        : [
            'model_provider="cantrip_runtime"',
            `model_providers.cantrip_runtime.name=${JSON.stringify(provider.name)}`,
            `model_providers.cantrip_runtime.base_url=${JSON.stringify(normalizeResponsesBaseUrl(provider.baseUrl))}`,
            'model_providers.cantrip_runtime.wire_api="responses"',
            ...(provider.apiKey
              ? [
                  'model_providers.cantrip_runtime.env_key="CANTRIP_PROVIDER_API_KEY"',
                ]
              : []),
          ];
    const child = spawn(
      this.codexBinary,
      [
        "app-server",
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        "features.goals=true",
        ...providerArguments.flatMap((argument) => ["-c", argument]),
        "-c",
        `model=${JSON.stringify(model.name)}`,
        ...(model.reasoningEffort
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
          ...(provider.apiKey
            ? { CANTRIP_PROVIDER_API_KEY: provider.apiKey }
            : {}),
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
    socket.on("message", (data: RawData) => this.handleMessage(data));
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
      this.#externalTurnBaselines.clear();
      this.#goals.clear();
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
      this.#externalTurnBaselines.clear();
    });

    await this.request("initialize", {
      clientInfo: { name: "cantrip", title: "Cantrip", version: "0.0.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.send({ method: "initialized", params: {} });
  }

  private request(method: string, params: unknown): Promise<unknown> {
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

  private send(message: RpcMessage): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server is not writable.");
    }
    this.#socket.send(JSON.stringify(message));
  }

  private handleMessage(data: RawData): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(data.toString()) as RpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const id = Number(message.id);
      const pending = this.#pending.get(id);
      if (!pending) {
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
      void this.handleServerRequest(message);
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
      if (active && params.item.type === "commandExecution") {
        active.onActivity?.(toActivity(params.item, active.cwd));
      }
      return;
    }

    if (message.method === "item/completed") {
      const params = message.params as ItemLifecycleParams;
      const active = this.#activeTurns.get(params.turnId);
      if (
        active &&
        params.item.type === "agentMessage" &&
        params.item.phase !== "commentary" &&
        typeof params.item.text === "string"
      ) {
        active.finalText = params.item.text;
      }
      if (active && params.item.type === "commandExecution") {
        active.onActivity?.(toActivity(params.item, active.cwd));
      }
      return;
    }

    if (message.method === "turn/diff/updated") {
      const params = message.params as TurnDiffUpdatedParams;
      const active = this.#activeTurns.get(params.turnId);
      if (active) {
        active.diffChanges = changedFiles(params.diff);
        emitFileActivity(active, params.turnId, "running");
      }
      return;
    }

    if (message.method === "turn/completed") {
      const params = message.params as TurnCompletedParams;
      const active = this.#activeTurns.get(params.turn.id);
      if (!active) {
        return;
      }
      this.#activeTurns.delete(params.turn.id);
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
    }
  }

  private async completeTurn(
    active: ActiveTurn,
    turnId: string,
  ): Promise<void> {
    try {
      active.diffChanges = await workspaceChanges(active);
      emitFileActivity(active, turnId, "completed");
      const text = active.finalText ?? active.delta;
      if (this.#goals.has(active.threadId)) {
        const response = await this.refreshGoal(active.threadId);
        if (
          goalShouldContinue(response.goal) &&
          goalShouldContinue(this.#goals.get(active.threadId) ?? null)
        ) {
          active.onCheckpoint?.({ text, turnId });
          active.baseline = await workspaceSnapshot(active.cwd);
          active.delta = "";
          active.diffChanges = [];
          active.finalText = null;
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
          })) as TurnStartResponse;
          this.#activeTurns.set(continued.turn.id, active);
          return;
        }
      }
      active.resolve(
        agentTurnResultSchema.parse({
          threadId: active.threadId,
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
      active.diffChanges = await workspaceChanges(active);
      emitFileActivity(active, turnId, "failed");
    } finally {
      active.reject(error);
    }
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    if (message.id === undefined) {
      return;
    }
    if (message.method === "item/commandExecution/requestApproval") {
      this.send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    if (message.method === "item/fileChange/requestApproval") {
      this.send({ id: message.id, result: { decision: "decline" } });
      return;
    }
    if (message.method === "item/tool/call") {
      const params = message.params as DynamicToolCallParams;
      const active = this.#activeTurns.get(params.turnId);
      this.send({
        id: message.id,
        result: await executeDynamicWorktreeTool(
          active?.onWorktreeToolCall,
          params,
        ),
      });
      return;
    }
    this.send({
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported request: ${message.method}`,
      },
    });
  }

  private handleExit(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const active of this.#activeTurns.values()) {
      active.reject(error);
    }
    this.#activeTurns.clear();
  }
}
