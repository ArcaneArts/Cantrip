import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  terminalOpenResultSchema,
  terminalSnapshotResultSchema,
  type TerminalServiceRuntimeConfiguration,
  type TerminalOpenResult,
  type TerminalSnapshotResult,
  type WorkerCommand,
  type WorkerEvent,
} from "@cantrip/protocol";
import * as pty from "node-pty";

import { codexProviderConfiguration } from "./codex/provider-config.js";

const MAX_SCROLLBACK_CHARS = 2_000_000;
let spawnHelperChecked = false;
const require = createRequire(import.meta.url);

function ensureSpawnHelperExecutable(): void {
  if (spawnHelperChecked || process.platform === "win32") return;
  spawnHelperChecked = true;
  const unixTerminal = require.resolve("node-pty/lib/unixTerminal.js");
  const packageRoot = path.dirname(path.dirname(unixTerminal));
  const candidates = [
    path.join(packageRoot, "build", "Release", "spawn-helper"),
    path.join(packageRoot, "build", "Debug", "spawn-helper"),
    path.join(
      packageRoot,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    ),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const mode = statSync(candidate).mode;
    if ((mode & 0o111) === 0) chmodSync(candidate, mode | 0o755);
    return;
  }
}

interface TerminalSession {
  buffer: string;
  cols: number;
  cwd: string;
  exited: Extract<TerminalOpenResult, { status: "exited" }> | null;
  launch: TerminalLaunch;
  process: pty.IPty | null;
  removeAfterExit: boolean;
  restartDelayOverride: number | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  rows: number;
  subscribers: Map<string, (event: WorkerEvent) => void>;
  waiters: Map<string, (result: TerminalOpenResult) => void>;
}

type CodexLaunchCommand = Extract<
  WorkerCommand,
  { type: "terminal.open" }
>["launch"] & {
  binary?: string;
  codexHome?: string;
};

export type TerminalLaunch =
  | { type: "shell" }
  | { type: "command"; command: string }
  | (Extract<CodexLaunchCommand, { type: "codex" }> & {
      binary: string;
      codexHome: string;
      remoteUrl: string;
    });

function shellCommand(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return (
    process.env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash")
  );
}

function terminalEnvironment(
  overrides: Record<string, string>,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  Object.assign(environment, overrides);
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  return environment;
}

function codexLaunch(
  launch: Extract<TerminalLaunch, { type: "codex" }>,
  cwd: string,
  environment: Record<string, string>,
): { command: string; args: string[]; env: Record<string, string> } {
  const providerConfiguration = codexProviderConfiguration(launch.provider);
  const args = [
    "--remote",
    launch.remoteUrl,
    "-c",
    'cli_auth_credentials_store="file"',
    ...providerConfiguration.arguments.flatMap((argument) => ["-c", argument]),
    "-c",
    `model=${JSON.stringify(launch.model.name)}`,
    ...(launch.model.reasoningEffort
      ? [
          "-c",
          `model_reasoning_effort=${JSON.stringify(launch.model.reasoningEffort)}`,
        ]
      : []),
    "-C",
    cwd,
    "-a",
    "never",
    "-s",
    "workspace-write",
    ...(launch.threadId ? ["resume", launch.threadId] : []),
  ];
  return {
    command: launch.binary,
    args,
    env: {
      ...environment,
      CODEX_HOME: launch.codexHome,
      ...providerConfiguration.environment,
    },
  };
}

function commandLaunch(
  command: string,
  environment: Record<string, string>,
): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  if (process.platform === "win32") {
    const shell = shellCommand();
    const isCommandPrompt = /(?:^|[\\/])cmd(?:\.exe)?$/iu.test(shell);
    return {
      command: shell,
      args: isCommandPrompt
        ? ["/d", "/s", "/c", command]
        : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      env: environment,
    };
  }
  return {
    command: shellCommand(),
    args: ["-lc", command],
    env: environment,
  };
}

export interface TerminalManagerOptions {
  environment?: Record<string, string>;
  serviceRestartDelayMs?: number;
}

export class TerminalManager {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #services = new Map<string, TerminalServiceRuntimeConfiguration>();
  readonly #environment: Record<string, string>;
  readonly #serviceRestartDelayMs: number;
  #closing = false;

  constructor(options: TerminalManagerOptions = {}) {
    this.#environment = { ...options.environment };
    this.#serviceRestartDelayMs = options.serviceRestartDelayMs ?? 5_000;
  }

  hasLiveSession(terminalId: string): boolean {
    const session = this.#sessions.get(terminalId);
    return Boolean(session?.process && !session.exited);
  }

  reconcileServices(services: TerminalServiceRuntimeConfiguration[]): void {
    const desired = new Map(
      services.map((service) => [service.terminalId, service]),
    );
    for (const terminalId of this.#services.keys()) {
      if (!desired.has(terminalId)) this.#disableService(terminalId);
    }
    for (const service of desired.values()) this.#configureService(service);
  }

  restartService(terminalId: string): void {
    const service = this.#services.get(terminalId);
    if (!service)
      throw new Error(`Terminal service ${terminalId} is disabled.`);
    const session = this.#sessions.get(terminalId);
    if (!session) {
      this.#startService(service);
      return;
    }
    if (session.restartTimer) {
      clearTimeout(session.restartTimer);
      session.restartTimer = null;
    }
    this.#appendOutput(session, "\r\n\x1b[90m[Restarting service]\x1b[0m\r\n");
    if (session.process) {
      session.restartDelayOverride = 0;
      session.process.kill();
    } else {
      this.#startService(service, session);
    }
  }

  open(
    terminalId: string,
    attachmentId: string,
    cwd: string,
    cols: number,
    rows: number,
    launch: TerminalLaunch,
    emit: (event: WorkerEvent) => void,
  ): Promise<TerminalOpenResult> {
    const service = this.#services.get(terminalId);
    if (service) {
      if (service.cwd !== cwd) {
        throw new Error(
          "Terminal service belongs to a different source folder.",
        );
      }
      let serviceSession = this.#sessions.get(terminalId);
      if (!serviceSession) {
        serviceSession = this.#startService(service);
      } else if (!serviceSession.process && !serviceSession.restartTimer) {
        this.#startService(service, serviceSession);
      }
      return this.#attach(serviceSession, attachmentId, cols, rows, emit);
    }

    let session = this.#sessions.get(terminalId);
    if (session?.exited) {
      this.#sessions.delete(terminalId);
      session = undefined;
    }
    if (!session) {
      ensureSpawnHelperExecutable();
      session = {
        buffer: "",
        cols,
        cwd,
        exited: null,
        launch,
        process: null,
        removeAfterExit: false,
        restartDelayOverride: null,
        restartTimer: null,
        rows,
        subscribers: new Map(),
        waiters: new Map(),
      };
      this.#sessions.set(terminalId, session);
      this.#spawn(terminalId, session);
    } else if (session.cwd !== cwd) {
      throw new Error("Terminal session belongs to a different source folder.");
    }

    if (session.exited) return Promise.resolve(session.exited);
    return this.#attach(session, attachmentId, cols, rows, emit);
  }

  detach(terminalId: string, attachmentId: string): TerminalOpenResult {
    const session = this.#sessions.get(terminalId);
    const result = terminalOpenResultSchema.parse({ status: "detached" });
    if (!session) return result;
    session.subscribers.delete(attachmentId);
    session.waiters.get(attachmentId)?.(result);
    session.waiters.delete(attachmentId);
    return result;
  }

  attachExisting(
    terminalId: string,
    attachmentId: string,
    cols: number,
    rows: number,
    emit: (event: WorkerEvent) => void,
  ): Promise<TerminalOpenResult> {
    const session = this.#sessions.get(terminalId);
    if (!session) {
      throw new Error(`Terminal ${terminalId} is not running.`);
    }
    if (session.exited) return Promise.resolve(session.exited);
    return this.#attach(session, attachmentId, cols, rows, emit);
  }

  input(terminalId: string, data: string): void {
    const session = this.liveSession(terminalId);
    session.process!.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.#sessions.get(terminalId);
    if (!session) throw new Error(`Terminal ${terminalId} is not running.`);
    session.cols = cols;
    session.rows = rows;
    if (session.process) session.process.resize(cols, rows);
  }

  snapshot(terminalId: string, maxChars: number): TerminalSnapshotResult {
    const session = this.#sessions.get(terminalId);
    if (!session) {
      return terminalSnapshotResultSchema.parse({
        terminalId,
        status: "not-running",
        data: "",
        truncated: false,
        exitCode: null,
      });
    }
    const boundedMaxChars = Math.max(1, Math.min(100_000, maxChars));
    return terminalSnapshotResultSchema.parse({
      terminalId,
      status: session.process
        ? "running"
        : session.restartTimer
          ? "restarting"
          : "exited",
      data: session.buffer.slice(-boundedMaxChars),
      truncated: session.buffer.length > boundedMaxChars,
      exitCode: session.exited?.exitCode ?? null,
    });
  }

  close(terminalId: string): void {
    this.#services.delete(terminalId);
    const session = this.#sessions.get(terminalId);
    if (!session) return;
    if (session.restartTimer) {
      clearTimeout(session.restartTimer);
      session.restartTimer = null;
    }
    session.removeAfterExit = true;
    if (session.process) {
      session.process.kill();
      return;
    }
    this.#finalizeSession(
      terminalId,
      session,
      session.exited ?? this.#stoppedResult(),
    );
  }

  closeAll(): void {
    this.#closing = true;
    this.#services.clear();
    for (const terminalId of [...this.#sessions.keys()]) this.close(terminalId);
  }

  private liveSession(terminalId: string): TerminalSession {
    const session = this.#sessions.get(terminalId);
    if (!session?.process || session.exited) {
      throw new Error(`Terminal ${terminalId} is not running.`);
    }
    return session;
  }

  #attach(
    session: TerminalSession,
    attachmentId: string,
    cols: number,
    rows: number,
    emit: (event: WorkerEvent) => void,
  ): Promise<TerminalOpenResult> {
    session.cols = cols;
    session.rows = rows;
    if (session.process) session.process.resize(cols, rows);
    session.subscribers.set(attachmentId, emit);
    emit({ type: "terminal.ready" });
    if (session.buffer) emit({ type: "terminal.output", data: session.buffer });
    return new Promise((resolve) => session.waiters.set(attachmentId, resolve));
  }

  #appendOutput(session: TerminalSession, data: string): void {
    session.buffer = `${session.buffer}${data}`.slice(-MAX_SCROLLBACK_CHARS);
    for (const subscriber of session.subscribers.values()) {
      subscriber({ type: "terminal.output", data });
    }
  }

  #configureService(service: TerminalServiceRuntimeConfiguration): void {
    const previous = this.#services.get(service.terminalId);
    this.#services.set(service.terminalId, service);
    const session = this.#sessions.get(service.terminalId);
    if (
      previous?.cwd === service.cwd &&
      previous.command === service.command &&
      session &&
      (session.process || session.restartTimer)
    ) {
      return;
    }
    if (!session) {
      this.#startService(service);
      return;
    }
    if (session.restartTimer) {
      clearTimeout(session.restartTimer);
      session.restartTimer = null;
    }
    if (session.process) {
      session.restartDelayOverride = 0;
      session.process.kill();
    } else {
      this.#startService(service, session);
    }
  }

  #disableService(terminalId: string): void {
    this.#services.delete(terminalId);
    const session = this.#sessions.get(terminalId);
    if (!session) return;
    if (session.restartTimer) {
      clearTimeout(session.restartTimer);
      session.restartTimer = null;
    }
    if (session.process) {
      session.process.kill();
    } else {
      this.#finalizeSession(
        terminalId,
        session,
        session.exited ?? this.#stoppedResult(),
      );
    }
  }

  #startService(
    service: TerminalServiceRuntimeConfiguration,
    existing?: TerminalSession,
  ): TerminalSession {
    const session = existing ?? {
      buffer: "",
      cols: 80,
      cwd: service.cwd,
      exited: null,
      launch: { type: "command" as const, command: service.command },
      process: null,
      removeAfterExit: false,
      restartDelayOverride: null,
      restartTimer: null,
      rows: 24,
      subscribers: new Map(),
      waiters: new Map(),
    };
    session.cwd = service.cwd;
    session.exited = null;
    session.launch = { type: "command", command: service.command };
    session.restartTimer = null;
    this.#sessions.set(service.terminalId, session);
    this.#appendOutput(
      session,
      "\r\n\x1b[90m[Starting terminal service]\x1b[0m\r\n",
    );
    try {
      this.#spawn(service.terminalId, session);
    } catch (error) {
      this.#appendOutput(
        session,
        `\r\n\x1b[31m[Service failed to start: ${error instanceof Error ? error.message : String(error)}]\x1b[0m\r\n`,
      );
      this.#scheduleServiceRestart(
        service.terminalId,
        session,
        this.#serviceRestartDelayMs,
      );
    }
    return session;
  }

  #spawn(terminalId: string, session: TerminalSession): void {
    ensureSpawnHelperExecutable();
    const environment = {
      ...terminalEnvironment(this.#environment),
      CANTRIP_TERMINAL_ID: terminalId,
    };
    const processLaunch =
      session.launch.type === "codex"
        ? codexLaunch(session.launch, session.cwd, environment)
        : session.launch.type === "command"
          ? commandLaunch(session.launch.command, environment)
          : {
              command: shellCommand(),
              args: [],
              env: environment,
            };
    const child = pty.spawn(processLaunch.command, processLaunch.args, {
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: processLaunch.env,
      name: "xterm-256color",
    });
    session.process = child;
    session.exited = null;
    child.onData((data) => {
      if (session.process !== child) return;
      this.#appendOutput(session, data);
    });
    child.onExit(({ exitCode, signal }) => {
      if (session.process !== child) return;
      session.process = null;
      const result = terminalOpenResultSchema.parse({
        status: "exited",
        exitCode,
        signal: signal || null,
      }) as Extract<TerminalOpenResult, { status: "exited" }>;
      session.exited = result;
      const service = this.#services.get(terminalId);
      if (service && !this.#closing) {
        const delay =
          session.restartDelayOverride ?? this.#serviceRestartDelayMs;
        session.restartDelayOverride = null;
        this.#appendOutput(
          session,
          `\r\n\x1b[90m[Service exited ${exitCode}; restarting ${delay === 0 ? "now" : `in ${Math.ceil(delay / 1_000)} seconds`}]\x1b[0m\r\n`,
        );
        this.#scheduleServiceRestart(terminalId, session, delay);
        return;
      }
      this.#finalizeSession(terminalId, session, result);
    });
  }

  #scheduleServiceRestart(
    terminalId: string,
    session: TerminalSession,
    delay: number,
  ): void {
    if (session.restartTimer) clearTimeout(session.restartTimer);
    session.restartTimer = setTimeout(() => {
      session.restartTimer = null;
      const service = this.#services.get(terminalId);
      if (!service || this.#closing) return;
      this.#startService(service, session);
    }, delay);
    session.restartTimer.unref();
  }

  #finalizeSession(
    terminalId: string,
    session: TerminalSession,
    result: Extract<TerminalOpenResult, { status: "exited" }>,
  ): void {
    session.exited = result;
    for (const resolve of session.waiters.values()) resolve(result);
    session.subscribers.clear();
    session.waiters.clear();
    if (session.removeAfterExit) this.#sessions.delete(terminalId);
  }

  #stoppedResult(): Extract<TerminalOpenResult, { status: "exited" }> {
    return terminalOpenResultSchema.parse({
      status: "exited",
      exitCode: 0,
      signal: null,
    }) as Extract<TerminalOpenResult, { status: "exited" }>;
  }
}
