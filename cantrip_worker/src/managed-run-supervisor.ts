import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  terminalOpenResultSchema,
  terminalSnapshotResultSchema,
  workerRunLogSnapshotSchema,
  workerRunLookupSchema,
  workerRunReconciliationSchema,
  workerRunSnapshotSchema,
  type ProjectRootKind,
  type TerminalOpenResult,
  type TerminalSnapshotResult,
  type WorkerRunIdentity,
  type WorkerRunLogSnapshot,
  type WorkerRunLookup,
  type WorkerRunSnapshot,
} from "@cantrip/protocol";
import * as pty from "node-pty";

import { workerLogError, workerLogger } from "./logger.js";
import { resolveRunConfigurationAction } from "./run-configuration-discovery.js";
import {
  ensureSpawnHelperExecutable,
  type TerminalRuntimeEvent,
} from "./terminal-manager.js";

const MAX_RETAINED_RUNS = 64;
const MAX_SCROLLBACK_CHARS = 256 * 1_024;
const STOP_GRACE_MS = 3_000;
const STOP_FORCE_MS = 1_000;

export interface ManagedRunStart extends WorkerRunIdentity {
  requestId: string;
  rootKind: ProjectRootKind;
  sourcePath: string;
  worktreePath: string;
}

export interface AuthorizedRunRoots {
  sourceRoot: string;
  worktreeRoot: string;
}

interface ManagedRunSession extends ManagedRunStart {
  attachmentWaiters: Map<string, (result: TerminalOpenResult) => void>;
  buffer: string;
  cols: number;
  endedAt: string | null;
  exitCode: number | null;
  process: pty.IPty | null;
  rows: number;
  signal: string | null;
  startedAt: string | null;
  state: WorkerRunSnapshot["state"];
  terminationIntent: "lost" | "stopped" | null;
  subscribers: Map<string, (event: TerminalRuntimeEvent) => void>;
  terminationWaiters: Set<() => void>;
}

export interface ManagedRunSupervisorOptions {
  authorize(input: ManagedRunStart): Promise<AuthorizedRunRoots>;
  environment?: NodeJS.ProcessEnv;
  environmentForRun?(input: ManagedRunStart): Record<string, string>;
  notify?(run: WorkerRunSnapshot): void;
  platform?: NodeJS.Platform;
}

export function runShellInvocation(
  command: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return {
    command:
      environment.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
    args: ["-lc", command],
  };
}

function stringEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function sameIdentity(
  session: ManagedRunSession,
  input: ManagedRunStart,
): boolean {
  return (
    session.requestId === input.requestId &&
    sameDurableIdentity(session, input) &&
    session.rootKind === input.rootKind &&
    session.sourcePath === input.sourcePath &&
    session.worktreePath === input.worktreePath
  );
}

function sameDurableIdentity(
  session: ManagedRunSession,
  input: WorkerRunIdentity,
): boolean {
  return (
    session.projectId === input.projectId &&
    session.worktreeId === input.worktreeId &&
    session.actionId === input.actionId &&
    session.configurationRevision === input.configurationRevision
  );
}

function boundedTail(value: string, maximum: number): string {
  return value.slice(-Math.max(1, Math.min(100_000, maximum)));
}

function pathIsAtOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export class ManagedRunSupervisor {
  readonly #authorize: ManagedRunSupervisorOptions["authorize"];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #environmentForRun: NonNullable<
    ManagedRunSupervisorOptions["environmentForRun"]
  >;
  readonly #notify: NonNullable<ManagedRunSupervisorOptions["notify"]>;
  readonly #platform: NodeJS.Platform;
  readonly #runs = new Map<string, ManagedRunSession>();
  #closing = false;

  constructor(options: ManagedRunSupervisorOptions) {
    this.#authorize = options.authorize;
    this.#environment = options.environment ?? process.env;
    this.#environmentForRun = options.environmentForRun ?? (() => ({}));
    this.#notify = options.notify ?? (() => undefined);
    this.#platform = options.platform ?? process.platform;
  }

  async start(input: ManagedRunStart): Promise<WorkerRunSnapshot> {
    const existing = this.#runs.get(input.runId);
    if (existing) {
      if (!sameIdentity(existing, input)) {
        throw new Error(
          "The Run ID is already associated with another action.",
        );
      }
      return this.#snapshot(existing);
    }
    if (this.#closing) throw new Error("The Run supervisor is shutting down.");
    this.#evictCompleted();
    if (this.#runs.size >= MAX_RETAINED_RUNS) {
      throw new Error(
        "This worker is already retaining the maximum number of Runs.",
      );
    }

    const roots = await this.#authorize(input);
    const selection = await resolveRunConfigurationAction(
      roots.sourceRoot,
      input.actionId,
      input.configurationRevision,
      this.#platform,
    );
    const session: ManagedRunSession = {
      ...input,
      sourcePath: roots.sourceRoot,
      worktreePath: roots.worktreeRoot,
      attachmentWaiters: new Map(),
      buffer: "",
      cols: 120,
      endedAt: null,
      exitCode: null,
      process: null,
      rows: 40,
      signal: null,
      startedAt: null,
      state: "starting",
      subscribers: new Map(),
      terminationIntent: null,
      terminationWaiters: new Set(),
    };
    this.#runs.set(input.runId, session);
    this.#emit(session);

    const environment = {
      ...stringEnvironment(process.env),
      ...stringEnvironment(this.#environment),
      ...this.#environmentForRun(input),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CODEX_WORKTREE_PATH: roots.worktreeRoot,
      CANTRIP_WORKTREE_PATH: roots.worktreeRoot,
      CANTRIP_PROJECT_ROOT: roots.sourceRoot,
      CANTRIP_RUN_ID: input.runId,
      CANTRIP_ACTION_ID: input.actionId,
      CANTRIP_TERMINAL_ID: input.runId,
    };
    const launch = runShellInvocation(
      selection.action.command,
      this.#platform,
      environment,
    );
    try {
      ensureSpawnHelperExecutable();
      const child = pty.spawn(launch.command, launch.args, {
        cols: 120,
        rows: 40,
        cwd: roots.worktreeRoot,
        env: environment,
        name: "xterm-256color",
      });
      session.process = child;
      session.startedAt = new Date().toISOString();
      session.state = "running";
      child.onData((data) => {
        if (session.process !== child) return;
        this.#appendOutput(session, data);
      });
      child.onExit(({ exitCode, signal }) => {
        if (session.process !== child) return;
        session.process = null;
        session.exitCode = exitCode;
        session.signal = signal ? String(signal) : null;
        session.endedAt = new Date().toISOString();
        session.state =
          session.terminationIntent === "lost"
            ? "lost"
            : session.terminationIntent === "stopped"
              ? "stopped"
              : "exited";
        this.#resolveTerminationWaiters(session);
        this.#resolveAttachments(session);
        this.#emit(session);
      });
      this.#emit(session);
      workerLogger.event("info", "Managed Run process started", {
        event: "run.process.started",
        subsystem: "run-supervisor",
        operation: "start",
        status: "running",
        runId: input.runId,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        actionId: input.actionId,
      });
    } catch (error) {
      session.state = "failed";
      session.endedAt = new Date().toISOString();
      this.#emit(session);
      workerLogger.event("error", "Managed Run process failed to start", {
        event: "run.process.start-failed",
        subsystem: "run-supervisor",
        operation: "start",
        reasonCode: "spawn-failed",
        status: "failed",
        runId: input.runId,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        actionId: input.actionId,
        error: workerLogError(error),
      });
    }
    return this.#snapshot(session);
  }

  status(runId: string): WorkerRunLookup {
    const session = this.#runs.get(runId);
    return session
      ? workerRunLookupSchema.parse({
          found: true,
          run: this.#snapshot(session),
        })
      : workerRunLookupSchema.parse({ found: false, runId });
  }

  has(runId: string): boolean {
    return this.#runs.has(runId);
  }

  attach(
    runId: string,
    attachmentId: string,
    cols: number,
    rows: number,
    emit: (event: TerminalRuntimeEvent) => void,
  ): Promise<TerminalOpenResult> {
    const session = this.#runs.get(runId);
    if (!session) throw new Error("The Run is not available on this worker.");
    session.cols = cols;
    session.rows = rows;
    if (session.process) session.process.resize(cols, rows);
    session.subscribers.set(attachmentId, emit);
    // Match regular terminals: scrollback must render before input is enabled.
    if (session.buffer) emit({ type: "terminal.output", data: session.buffer });
    emit({ type: "terminal.ready" });
    if (!session.process) {
      session.subscribers.delete(attachmentId);
      return Promise.resolve(this.#terminalExitResult(session));
    }
    return new Promise((resolve) =>
      session.attachmentWaiters.set(attachmentId, resolve),
    );
  }

  detach(runId: string, attachmentId: string): TerminalOpenResult {
    const result = terminalOpenResultSchema.parse({ status: "detached" });
    const session = this.#runs.get(runId);
    if (!session) return result;
    session.subscribers.delete(attachmentId);
    session.attachmentWaiters.get(attachmentId)?.(result);
    session.attachmentWaiters.delete(attachmentId);
    return result;
  }

  input(runId: string, data: string): void {
    const session = this.#runs.get(runId);
    if (!session?.process || session.state !== "running") {
      throw new Error("The Run is not accepting terminal input.");
    }
    session.process.write(data);
  }

  resize(runId: string, cols: number, rows: number): void {
    const session = this.#runs.get(runId);
    if (!session) throw new Error("The Run is not available on this worker.");
    session.cols = cols;
    session.rows = rows;
    if (session.process) session.process.resize(cols, rows);
  }

  snapshot(runId: string, maxChars: number): TerminalSnapshotResult {
    const session = this.#runs.get(runId);
    if (!session) {
      return terminalSnapshotResultSchema.parse({
        terminalId: runId,
        status: "not-running",
        data: "",
        truncated: false,
        exitCode: null,
      });
    }
    const maximum = Math.max(1, Math.min(100_000, maxChars));
    return terminalSnapshotResultSchema.parse({
      terminalId: runId,
      status: session.process ? "running" : "exited",
      data: session.buffer.slice(-maximum),
      truncated: session.buffer.length > maximum,
      exitCode: session.exitCode,
    });
  }

  logs(runId: string, maximum: number): WorkerRunLogSnapshot {
    const session = this.#runs.get(runId);
    if (!session) throw new Error("The Run is not available on this worker.");
    const data = boundedTail(session.buffer, maximum);
    return workerRunLogSnapshotSchema.parse({
      run: this.#snapshot(session),
      data,
      truncated: session.buffer.length > data.length,
    });
  }

  async stop(runId: string): Promise<WorkerRunLookup> {
    const session = this.#runs.get(runId);
    if (!session) return workerRunLookupSchema.parse({ found: false, runId });
    if (["exited", "failed", "stopped", "lost"].includes(session.state)) {
      return workerRunLookupSchema.parse({
        found: true,
        run: this.#snapshot(session),
      });
    }
    session.state = "stopping";
    session.terminationIntent = "stopped";
    this.#emit(session);
    await this.#terminate(session, "stopped");
    return workerRunLookupSchema.parse({
      found: true,
      run: this.#snapshot(session),
    });
  }

  async stopProject(projectId: string): Promise<number> {
    return this.#stopMatching((session) => session.projectId === projectId);
  }

  async stopForPath(targetPath: string): Promise<number> {
    const canonical = await realpath(targetPath).catch(() =>
      path.resolve(targetPath),
    );
    const matchingRunIds = new Set(
      (
        await Promise.all(
          [...this.#runs.values()].map(async (session) => {
            const [sourcePath, worktreePath] = await Promise.all([
              realpath(session.sourcePath).catch(() =>
                path.resolve(session.sourcePath),
              ),
              realpath(session.worktreePath).catch(() =>
                path.resolve(session.worktreePath),
              ),
            ]);
            return pathIsAtOrInside(canonical, sourcePath) ||
              pathIsAtOrInside(canonical, worktreePath)
              ? session.runId
              : null;
          }),
        )
      ).filter((runId): runId is string => runId !== null),
    );
    return this.#stopMatching((session) => matchingRunIds.has(session.runId));
  }

  reconcile(runs: WorkerRunIdentity[]): WorkerRunLookup[] {
    return workerRunReconciliationSchema.parse(
      runs.map((identity) => {
        const session = this.#runs.get(identity.runId);
        if (!session || !sameDurableIdentity(session, identity)) {
          return { found: false as const, runId: identity.runId };
        }
        return { found: true as const, run: this.#snapshot(session) };
      }),
    );
  }

  async closeAll(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await Promise.all(
      [...this.#runs.values()]
        .filter((session) =>
          ["starting", "running", "stopping"].includes(session.state),
        )
        .map(async (session) => {
          session.terminationIntent = "lost";
          await this.#terminate(session, "lost");
        }),
    );
  }

  async #stopMatching(
    matches: (session: ManagedRunSession) => boolean,
  ): Promise<number> {
    const sessions = [...this.#runs.values()].filter(
      (session) =>
        matches(session) &&
        ["starting", "running", "stopping"].includes(session.state),
    );
    await Promise.all(
      sessions.map(async (session) => {
        session.state = "stopping";
        session.terminationIntent = "stopped";
        this.#emit(session);
        await this.#terminate(session, "stopped");
      }),
    );
    return sessions.length;
  }

  #snapshot(session: ManagedRunSession): WorkerRunSnapshot {
    return workerRunSnapshotSchema.parse({
      runId: session.runId,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      actionId: session.actionId,
      configurationRevision: session.configurationRevision,
      state: session.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      exitCode: session.exitCode,
      signal: session.signal,
    });
  }

  #emit(session: ManagedRunSession): void {
    this.#notify(this.#snapshot(session));
  }

  #appendOutput(session: ManagedRunSession, data: string): void {
    session.buffer = `${session.buffer}${data}`.slice(-MAX_SCROLLBACK_CHARS);
    for (const emit of session.subscribers.values()) {
      emit({ type: "terminal.output", data });
    }
  }

  #resolveTerminationWaiters(session: ManagedRunSession): void {
    for (const resolve of session.terminationWaiters) resolve();
    session.terminationWaiters.clear();
  }

  #resolveAttachments(session: ManagedRunSession): void {
    const result = this.#terminalExitResult(session);
    for (const resolve of session.attachmentWaiters.values()) resolve(result);
    session.attachmentWaiters.clear();
    session.subscribers.clear();
  }

  #terminalExitResult(
    session: ManagedRunSession,
  ): Extract<TerminalOpenResult, { status: "exited" }> {
    const signal = session.signal === null ? null : Number(session.signal);
    return terminalOpenResultSchema.parse({
      status: "exited",
      exitCode: session.exitCode ?? (session.state === "failed" ? 1 : 0),
      signal: Number.isInteger(signal) ? signal : null,
    }) as Extract<TerminalOpenResult, { status: "exited" }>;
  }

  async #terminate(
    session: ManagedRunSession,
    finalState: "lost" | "stopped",
  ): Promise<void> {
    const child = session.process;
    if (!child) {
      session.state = finalState;
      session.endedAt ??= new Date().toISOString();
      this.#emit(session);
      return;
    }
    await this.#signalProcessTree(child, false);
    if (!(await this.#waitForExit(session, STOP_GRACE_MS))) {
      await this.#signalProcessTree(child, true);
      await this.#waitForExit(session, STOP_FORCE_MS);
    }
    if (session.process === child) {
      session.process = null;
      session.state = finalState;
      session.endedAt = new Date().toISOString();
      this.#resolveTerminationWaiters(session);
      this.#resolveAttachments(session);
      this.#emit(session);
    }
  }

  #waitForExit(
    session: ManagedRunSession,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!session.process) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.terminationWaiters.delete(exited);
        resolve(value);
      };
      const exited = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      session.terminationWaiters.add(exited);
    });
  }

  async #signalProcessTree(child: pty.IPty, force: boolean): Promise<void> {
    if (this.#platform === "win32") {
      await new Promise<void>((resolve) => {
        const args = ["/PID", String(child.pid), "/T"];
        if (force) args.push("/F");
        const killer = spawn("taskkill", args, {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => {
          try {
            child.kill();
          } catch {
            // It may already have exited.
          }
          resolve();
        });
        killer.once("exit", () => resolve());
      });
      return;
    }
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      try {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        // It may already have exited.
      }
    }
  }

  #evictCompleted(): void {
    if (this.#runs.size < MAX_RETAINED_RUNS) return;
    const completed = [...this.#runs.values()]
      .filter((session) =>
        ["exited", "failed", "stopped", "lost"].includes(session.state),
      )
      .sort((left, right) =>
        (left.endedAt ?? "").localeCompare(right.endedAt ?? ""),
      );
    while (this.#runs.size >= MAX_RETAINED_RUNS && completed.length > 0) {
      this.#runs.delete(completed.shift()!.runId);
    }
  }
}
