import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

import {
  agentActivitySchema,
  agentTurnResultSchema,
  normalizeResponsesBaseUrl,
  type AgentActivity,
  type AgentTurnResult,
  type WorkerCommand,
} from "@cantrip/protocol";

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

interface PendingRpcRequest {
  reject(error: Error): void;
  resolve(result: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  baseline: WorkspaceSnapshot;
  cwd: string;
  delta: string;
  diffChanges: Array<{ kind: "add" | "delete" | "update"; path: string }>;
  finalText: string | null;
  onActivity?: (activity: AgentActivity) => void;
  reject(error: Error): void;
  resolve(result: AgentTurnResult): void;
  threadId: string;
}

interface WorkspaceFileState {
  fingerprint: string;
  status: string;
}

type WorkspaceSnapshot = Map<string, WorkspaceFileState>;

const execFileAsync = promisify(execFile);

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

export interface RunAgentTurnOptions {
  cwd: string;
  model: Extract<WorkerCommand, { type: "chat.turn" }>["model"];
  provider: Extract<WorkerCommand, { type: "chat.turn" }>["provider"];
  prompt: string;
  threadId: string | null;
  onActivity?: (activity: AgentActivity) => void;
}

export function codexModelProviderName(
  provider: RunAgentTurnOptions["provider"],
): "cantrip_runtime" | "openai" {
  return provider.kind === "chatgpt" ? "openai" : "cantrip_runtime";
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
  readonly #loadedThreads = new Set<string>();
  readonly #pending = new Map<number, PendingRpcRequest>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #runtimeId: string | null = null;
  #nextId = 1;
  #starting: Promise<void> | null = null;

  constructor(
    private readonly codexBinary: string,
    private readonly dataDirectory: string,
    private readonly codexHome: string = path.join(dataDirectory, "codex-home"),
  ) {}

  async runTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
    await this.ensureStarted(options.model, options.provider);
    const baseline = await workspaceSnapshot(options.cwd);
    const modelProvider = codexModelProviderName(options.provider);

    let threadId = options.threadId;
    if (threadId && !this.#loadedThreads.has(threadId)) {
      try {
        const resumed = (await this.request("thread/resume", {
          threadId,
          model: options.model.name,
          modelProvider,
          cwd: options.cwd,
          approvalPolicy: "never",
          sandbox: "workspace-write",
        })) as ThreadResponse;
        threadId = resumed.thread.id;
        this.#loadedThreads.add(threadId);
      } catch {
        // The server owns conversation history, while Codex thread state is local
        // to a worker/runtime. A replacement worker can safely begin a new thread.
        threadId = null;
      }
    }

    if (!threadId) {
      const started = (await this.request("thread/start", {
        model: options.model.name,
        modelProvider,
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      })) as ThreadResponse;
      threadId = started.thread.id;
      this.#loadedThreads.add(threadId);
    }

    if (this.#activeTurns.has(threadId)) {
      throw new Error(`Codex thread ${threadId} already has an active turn.`);
    }

    let activeTurn: ActiveTurn | undefined;
    const completion = new Promise<AgentTurnResult>((resolve, reject) => {
      activeTurn = {
        baseline,
        cwd: options.cwd,
        delta: "",
        diffChanges: [],
        finalText: null,
        onActivity: options.onActivity,
        reject,
        resolve,
        threadId,
      };
    });

    const response = (await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      model: options.model.name,
    })) as TurnStartResponse;
    if (!activeTurn) {
      throw new Error("Could not initialize the Codex turn.");
    }
    this.#activeTurns.set(response.turn.id, activeTurn);
    return completion;
  }

  close(): void {
    this.handleExit(new Error("Codex app-server stopped."));
    this.#child?.kill("SIGTERM");
    this.#child = null;
    this.#runtimeId = null;
    this.#starting = null;
  }

  private async ensureStarted(
    model: RunAgentTurnOptions["model"],
    provider: RunAgentTurnOptions["provider"],
  ): Promise<void> {
    const runtimeId = `${provider.id}:${model.id}`;
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
    this.#starting ??= this.start(model, provider);
    await this.#starting;
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
        ...providerArguments.flatMap((argument) => ["-c", argument]),
        "-c",
        `model=${JSON.stringify(model.name)}`,
        ...(model.reasoningEffort
          ? [
              "-c",
              `model_reasoning_effort=${JSON.stringify(model.reasoningEffort)}`,
            ]
          : []),
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

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      this.handleLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[codex] ${chunk}`);
    });
    child.once("exit", (code, signal) => {
      this.handleExit(
        new Error(
          `Codex app-server exited (${signal ?? `code ${String(code)}`}).`,
        ),
      );
      this.#child = null;
      this.#runtimeId = null;
      this.#starting = null;
      this.#loadedThreads.clear();
    });

    await this.request("initialize", {
      clientInfo: { name: "cantrip", title: "Cantrip", version: "0.0.0" },
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
      }, 30_000);
      this.#pending.set(id, { reject, resolve, timeout });
      this.send({ id, method, params });
    });
  }

  private send(message: RpcMessage): void {
    if (!this.#child?.stdin.writable) {
      throw new Error("Codex app-server is not writable.");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
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
      this.handleServerRequest(message);
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
      active.resolve(
        agentTurnResultSchema.parse({
          threadId: active.threadId,
          text: active.finalText ?? active.delta,
          status: "completed",
        }),
      );
    } catch (error) {
      active.reject(error instanceof Error ? error : new Error(String(error)));
    }
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

  private handleServerRequest(message: RpcMessage): void {
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
