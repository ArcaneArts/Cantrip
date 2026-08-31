import { chmodSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

import {
  terminalOpenResultSchema,
  terminalSnapshotResultSchema,
  type TerminalHydrationMetadata,
  type TerminalOpenResult,
  type TerminalSnapshotResult,
  type WorkerCommand,
} from "@cantrip/protocol";
import * as pty from "node-pty";

import { codexProviderConfiguration } from "./codex/provider-config.js";
import { workerLogErrorIdentity, workerLogger } from "./logger.js";
import type { RuntimeProvider } from "./protected-secrets.js";
import {
  TerminalCanonicalState,
  type TerminalCanonicalSnapshot,
} from "./terminal-canonical-state.js";

const MAX_SCROLLBACK_CHARS = 2_000_000;
const MAX_RUNTIME_OUTPUT_CHARS = 32 * 1_024;
const MAX_HYDRATION_PENDING_CHARS = 2_000_000;
const RECOVERY_REDRAW_RESTORE_DELAY_MS = 25;
let spawnHelperChecked = false;
const require = createRequire(import.meta.url);

function runtimeOutputChunks(data: string): string[] {
  if (data.length === 0) return [""];
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length;) {
    let end = Math.min(data.length, offset + MAX_RUNTIME_OUTPUT_CHARS);
    if (
      end < data.length &&
      end > offset &&
      /[\uD800-\uDBFF]/u.test(data[end - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(data[end]!)
    ) {
      end -= 1;
    }
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function ensureSpawnHelperExecutable(): void {
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

export type TerminalRuntimeEvent =
  | { type: "terminal.ready" }
  | {
      type: "terminal.output";
      data: string;
      hydration?: TerminalHydrationMetadata;
    };

interface TerminalSubscriber {
  emit(event: TerminalRuntimeEvent): void;
  hydrating: boolean;
  pending: string[];
  pendingCharacters: number;
  resnapshotRequired: boolean;
}

interface TerminalAttachmentSnapshot {
  outputBoundary: number;
  processGeneration: number;
  snapshot: TerminalCanonicalSnapshot;
}

type TerminalRecoveryRedraw =
  | { recovery: "not-needed" | "redraw-requested" }
  | {
      recovery: "redraw-failed";
      recoveryReason: "no-live-process" | "resize-failed";
    };

interface TerminalSession {
  buffer: string;
  bufferTruncated: boolean;
  canonicalAvailable: boolean;
  canonicalState: TerminalCanonicalState;
  cols: number;
  cwd: string;
  exited: Extract<TerminalOpenResult, { status: "exited" }> | null;
  launch: TerminalLaunch;
  outputBoundary: number;
  process: pty.IPty | null;
  processGeneration: number;
  recoveryRedraw: {
    processGeneration: number;
    result: Promise<TerminalRecoveryRedraw>;
  } | null;
  removeAfterExit: boolean;
  restartDelayOverride: number | null;
  restartCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  rows: number;
  startedAtMs: number | null;
  stateQueue: Promise<void>;
  subscribers: Map<string, TerminalSubscriber>;
  waiters: Map<string, (result: TerminalOpenResult) => void>;
}

type CodexLaunchCommand = Omit<
  Extract<
    Extract<WorkerCommand, { type: "terminal.open" }>["launch"],
    { type: "codex" }
  >,
  "provider"
> & {
  binary?: string;
  codexHome?: string;
  provider: RuntimeProvider;
};

export type TerminalLaunch =
  | { type: "shell" }
  | { type: "command"; command: string }
  | (CodexLaunchCommand & {
      type: "codex";
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
  canonicalStateFactory?(cols: number, rows: number): TerminalCanonicalState;
  environment?: Record<string, string>;
  environmentForCwd?(cwd: string): Record<string, string>;
  maxScrollbackCharacters?: number;
  observeLifecycle?(observation: TerminalLifecycleObservation): void;
  serviceRestartDelayMs?: number;
}

export interface TerminalLifecycleObservation {
  terminalId: string;
  status: "exited";
  exitCode: number;
  signal: number | null;
}

export interface TerminalServiceRuntime {
  terminalId: string;
  cwd: string;
  command: string;
}

export class TerminalManager {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #services = new Map<string, TerminalServiceRuntime>();
  readonly #environment: Record<string, string>;
  readonly #canonicalStateFactory: NonNullable<
    TerminalManagerOptions["canonicalStateFactory"]
  >;
  readonly #environmentForCwd: NonNullable<
    TerminalManagerOptions["environmentForCwd"]
  >;
  #observeLifecycle: NonNullable<TerminalManagerOptions["observeLifecycle"]>;
  readonly #serviceRestartDelayMs: number;
  readonly #maxScrollbackCharacters: number;
  #closing = false;
  #serviceFingerprint = "";

  constructor(options: TerminalManagerOptions = {}) {
    this.#canonicalStateFactory =
      options.canonicalStateFactory ??
      ((cols, rows) => new TerminalCanonicalState(cols, rows));
    this.#environment = { ...options.environment };
    this.#environmentForCwd = options.environmentForCwd ?? (() => ({}));
    this.#observeLifecycle = options.observeLifecycle ?? (() => undefined);
    this.#serviceRestartDelayMs = options.serviceRestartDelayMs ?? 5_000;
    this.#maxScrollbackCharacters = Math.max(
      1,
      Math.floor(options.maxScrollbackCharacters ?? MAX_SCROLLBACK_CHARS),
    );
  }

  setLifecycleObserver(
    observer: NonNullable<TerminalManagerOptions["observeLifecycle"]>,
  ): void {
    this.#observeLifecycle = observer;
  }

  hasLiveSession(terminalId: string): boolean {
    const session = this.#sessions.get(terminalId);
    return Boolean(session?.process && !session.exited);
  }

  reconcileServices(services: TerminalServiceRuntime[]): void {
    const desired = new Map(
      services.map((service) => [service.terminalId, service]),
    );
    for (const terminalId of this.#services.keys()) {
      if (!desired.has(terminalId)) this.#disableService(terminalId);
    }
    for (const service of desired.values()) this.#configureService(service);
    const fingerprint = [...desired.values()]
      .map((service) =>
        createHash("sha256")
          .update(`${service.terminalId}\0${service.cwd}\0${service.command}`)
          .digest("hex"),
      )
      .sort()
      .join("|");
    if (fingerprint !== this.#serviceFingerprint) {
      this.#serviceFingerprint = fingerprint;
      workerLogger.event("info", "Terminal services reconciled", {
        event: "terminal.service.reconciled",
        subsystem: "terminal",
        operation: "reconcile-services",
        status: "completed",
        counts: { configured: services.length },
      });
    }
  }

  restartService(terminalId: string): void {
    const service = this.#services.get(terminalId);
    if (!service)
      throw new Error(`Terminal service ${terminalId} is disabled.`);
    workerLogger.event("info", "Terminal service restart requested", {
      event: "terminal.service.restart-requested",
      subsystem: "terminal",
      operation: "restart-service",
      status: "started",
      terminalId,
    });
    const session = this.#sessions.get(terminalId);
    if (!session) {
      this.#startService(service);
      return;
    }
    if (session.restartTimer) {
      clearTimeout(session.restartTimer);
      session.restartTimer = null;
    }
    this.#appendOutput(
      terminalId,
      session,
      "\r\n\x1b[90m[Restarting service]\x1b[0m\r\n",
    );
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
    emit: (event: TerminalRuntimeEvent) => void,
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
      return this.#attach(terminalId, serviceSession, attachmentId, emit);
    }

    let session = this.#sessions.get(terminalId);
    if (session?.exited) {
      this.#sessions.delete(terminalId);
      const exitedSession = session;
      void exitedSession.stateQueue.finally(() =>
        exitedSession.canonicalState.dispose(),
      );
      session = undefined;
    }
    if (!session) {
      ensureSpawnHelperExecutable();
      session = {
        buffer: "",
        bufferTruncated: false,
        canonicalAvailable: true,
        canonicalState: this.#canonicalStateFactory(cols, rows),
        cols,
        cwd,
        exited: null,
        launch,
        outputBoundary: 0,
        process: null,
        processGeneration: 0,
        recoveryRedraw: null,
        removeAfterExit: false,
        restartDelayOverride: null,
        restartCount: 0,
        restartTimer: null,
        rows,
        startedAtMs: null,
        stateQueue: Promise.resolve(),
        subscribers: new Map(),
        waiters: new Map(),
      };
      this.#sessions.set(terminalId, session);
      this.#spawn(terminalId, session);
    } else if (session.cwd !== cwd) {
      throw new Error("Terminal session belongs to a different source folder.");
    }

    if (session.exited) return Promise.resolve(session.exited);
    return this.#attach(terminalId, session, attachmentId, emit);
  }

  detach(terminalId: string, attachmentId: string): TerminalOpenResult {
    const session = this.#sessions.get(terminalId);
    const result = terminalOpenResultSchema.parse({ status: "detached" });
    if (!session) return result;
    const subscriber = session.subscribers.get(attachmentId);
    if (subscriber) {
      subscriber.pending.length = 0;
      subscriber.pendingCharacters = 0;
    }
    session.subscribers.delete(attachmentId);
    session.waiters.get(attachmentId)?.(result);
    session.waiters.delete(attachmentId);
    workerLogger.event("debug", "Terminal client detached", {
      event: "terminal.client.detached",
      subsystem: "terminal",
      operation: "detach",
      status: "completed",
      terminalId,
      attachmentId,
      counts: { clients: session.subscribers.size },
    });
    return result;
  }

  attachExisting(
    terminalId: string,
    attachmentId: string,
    emit: (event: TerminalRuntimeEvent) => void,
  ): Promise<TerminalOpenResult> {
    const session = this.#sessions.get(terminalId);
    if (!session) {
      throw new Error(`Terminal ${terminalId} is not running.`);
    }
    if (session.exited) return Promise.resolve(session.exited);
    return this.#attach(terminalId, session, attachmentId, emit);
  }

  input(terminalId: string, data: string): void {
    const session = this.liveSession(terminalId);
    session.process!.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.#sessions.get(terminalId);
    if (!session) throw new Error(`Terminal ${terminalId} is not running.`);
    const previousCols = session.cols;
    const previousRows = session.rows;
    session.cols = cols;
    session.rows = rows;
    if (session.process) session.process.resize(cols, rows);
    this.#queueCanonicalMutation(terminalId, session, "resize", () =>
      session.canonicalState.resize(cols, rows),
    );
    if (previousCols !== cols || previousRows !== rows) {
      workerLogger.event("debug", "Terminal session resized", {
        event: "terminal.session.resized",
        subsystem: "terminal",
        operation: "resize",
        status: "completed",
        terminalId,
        dimensions: {
          previous: { cols: previousCols, rows: previousRows },
          current: { cols, rows },
        },
      });
    }
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

  async canonicalSnapshot(
    terminalId: string,
  ): Promise<TerminalCanonicalSnapshot | null> {
    const session = this.#sessions.get(terminalId);
    if (!session) return null;
    return this.#queueCanonicalSnapshot(terminalId, session).then(
      (attachment) => attachment?.snapshot ?? null,
    );
  }

  close(terminalId: string): void {
    const service = this.#services.has(terminalId);
    this.#services.delete(terminalId);
    const session = this.#sessions.get(terminalId);
    if (!session) return;
    workerLogger.event("info", "Terminal session stopping", {
      event: "terminal.session.stopping",
      subsystem: "terminal",
      operation: "close",
      status: "started",
      terminalId,
      service,
      counts: { clients: session.subscribers.size },
    });
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
    workerLogger.event("info", "Terminal manager stopping", {
      event: "terminal.manager.stopping",
      subsystem: "terminal",
      operation: "close-all",
      status: "started",
      counts: {
        sessions: this.#sessions.size,
        services: this.#services.size,
      },
    });
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
    terminalId: string,
    session: TerminalSession,
    attachmentId: string,
    emit: (event: TerminalRuntimeEvent) => void,
  ): Promise<TerminalOpenResult> {
    const attachedAtMs = Date.now();
    const subscriber: TerminalSubscriber = {
      emit,
      hydrating: true,
      pending: [],
      pendingCharacters: 0,
      resnapshotRequired: false,
    };
    session.subscribers.set(attachmentId, subscriber);
    const opened = new Promise<TerminalOpenResult>((resolve) =>
      session.waiters.set(attachmentId, resolve),
    );
    void this.#hydrateSubscriber(
      terminalId,
      session,
      attachmentId,
      subscriber,
      attachedAtMs,
    );
    return opened;
  }

  #appendOutput(
    terminalId: string,
    session: TerminalSession,
    data: string,
  ): void {
    session.outputBoundary += 1;
    const nextBuffer = `${session.buffer}${data}`;
    if (nextBuffer.length > this.#maxScrollbackCharacters) {
      session.bufferTruncated = true;
    }
    session.buffer = nextBuffer.slice(-this.#maxScrollbackCharacters);
    this.#queueCanonicalMutation(terminalId, session, "write", () =>
      session.canonicalState.write(data),
    );
    for (const subscriber of session.subscribers.values()) {
      if (!subscriber.hydrating) {
        this.#emitOutput(subscriber, data);
        continue;
      }
      subscriber.pending.push(data);
      subscriber.pendingCharacters += data.length;
      if (subscriber.pendingCharacters > MAX_HYDRATION_PENDING_CHARS) {
        subscriber.pending.length = 0;
        subscriber.pendingCharacters = 0;
        subscriber.resnapshotRequired = true;
      }
    }
  }

  #configureService(service: TerminalServiceRuntime): void {
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
    service: TerminalServiceRuntime,
    existing?: TerminalSession,
  ): TerminalSession {
    const session = existing ?? {
      buffer: "",
      bufferTruncated: false,
      canonicalAvailable: true,
      canonicalState: this.#canonicalStateFactory(80, 24),
      cols: 80,
      cwd: service.cwd,
      exited: null,
      launch: { type: "command" as const, command: service.command },
      outputBoundary: 0,
      process: null,
      processGeneration: 0,
      recoveryRedraw: null,
      removeAfterExit: false,
      restartDelayOverride: null,
      restartCount: 0,
      restartTimer: null,
      rows: 24,
      startedAtMs: null,
      stateQueue: Promise.resolve(),
      subscribers: new Map(),
      waiters: new Map(),
    };
    if (existing) this.#resetReplayState(service.terminalId, session);
    session.cwd = service.cwd;
    session.exited = null;
    session.launch = { type: "command", command: service.command };
    session.restartTimer = null;
    this.#sessions.set(service.terminalId, session);
    this.#appendOutput(
      service.terminalId,
      session,
      "\r\n\x1b[90m[Starting terminal service]\x1b[0m\r\n",
    );
    try {
      this.#spawn(service.terminalId, session);
    } catch {
      workerLogger.rateLimited(
        `terminal-service-start-failed:${service.terminalId}`,
        "warn",
        "Terminal service failed to start; retry scheduled",
        {
          event: "terminal.service.start-failed",
          subsystem: "terminal",
          operation: "start-service",
          reasonCode: "spawn-failed",
          status: "retrying",
          terminalId: service.terminalId,
          attempt: session.restartCount + 1,
          reconnectDelayMs: this.#serviceRestartDelayMs,
        },
      );
      this.#appendOutput(
        service.terminalId,
        session,
        "\r\n\x1b[31m[Service failed to start]\x1b[0m\r\n",
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
    session.processGeneration += 1;
    session.recoveryRedraw = null;
    const environment = {
      ...terminalEnvironment(this.#environment),
      ...this.#environmentForCwd(session.cwd),
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
    const startedAtMs = Date.now();
    workerLogger.event("info", "Terminal process starting", {
      event: "terminal.process.starting",
      subsystem: "terminal",
      operation: "spawn",
      status: "started",
      terminalId,
      launchType: session.launch.type,
      service: this.#services.has(terminalId),
      attempt: session.restartCount + 1,
      processGeneration: session.processGeneration,
    });
    const child = pty.spawn(processLaunch.command, processLaunch.args, {
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: processLaunch.env,
      name: "xterm-256color",
    });
    session.process = child;
    session.exited = null;
    session.startedAtMs = startedAtMs;
    workerLogger.event("info", "Terminal process started", {
      event: "terminal.process.started",
      subsystem: "terminal",
      operation: "spawn",
      status: "running",
      terminalId,
      processId: child.pid,
      launchType: session.launch.type,
      service: this.#services.has(terminalId),
      durationMs: Date.now() - startedAtMs,
      processGeneration: session.processGeneration,
    });
    child.onData((data) => {
      if (session.process !== child) return;
      this.#appendOutput(terminalId, session, data);
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
        session.restartCount += 1;
        workerLogger.event(
          exitCode === 0 ? "info" : "warn",
          "Terminal service process exited; restart scheduled",
          {
            event: "terminal.service.restart-scheduled",
            subsystem: "terminal",
            operation: "restart-service",
            reasonCode: exitCode === 0 ? "process-exited" : "process-failed",
            status: "retrying",
            terminalId,
            exitCode,
            signal: signal || null,
            durationMs: session.startedAtMs
              ? Date.now() - session.startedAtMs
              : undefined,
            reconnectDelayMs: delay,
            attempt: session.restartCount,
          },
        );
        this.#appendOutput(
          terminalId,
          session,
          `\r\n\x1b[90m[Service exited ${exitCode}; restarting ${delay === 0 ? "now" : `in ${Math.ceil(delay / 1_000)} seconds`}]\x1b[0m\r\n`,
        );
        this.#scheduleServiceRestart(terminalId, session, delay);
        return;
      }
      workerLogger.event(
        exitCode === 0 || session.removeAfterExit ? "info" : "warn",
        "Terminal process exited",
        {
          event: "terminal.process.exited",
          subsystem: "terminal",
          operation: "spawn",
          status: "stopped",
          terminalId,
          exitCode,
          signal: signal || null,
          durationMs: session.startedAtMs
            ? Date.now() - session.startedAtMs
            : undefined,
          counts: { clients: session.subscribers.size },
        },
      );
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
    if (session.removeAfterExit) {
      this.#sessions.delete(terminalId);
      void session.stateQueue.finally(() => session.canonicalState.dispose());
    }
    this.#observeLifecycle({
      terminalId,
      status: "exited",
      exitCode: result.exitCode,
      signal: result.signal,
    });
  }

  #stoppedResult(): Extract<TerminalOpenResult, { status: "exited" }> {
    return terminalOpenResultSchema.parse({
      status: "exited",
      exitCode: 0,
      signal: null,
    }) as Extract<TerminalOpenResult, { status: "exited" }>;
  }

  #queueCanonicalMutation(
    terminalId: string,
    session: TerminalSession,
    operation: "reset" | "resize" | "write",
    mutation: () => Promise<void> | void,
  ): void {
    session.stateQueue = session.stateQueue
      .then(async () => {
        if (!session.canonicalAvailable && operation !== "reset") return;
        await mutation();
        if (operation === "reset") session.canonicalAvailable = true;
      })
      .catch((error: unknown) =>
        this.#recordCanonicalFailure(terminalId, session, operation, error),
      );
  }

  #queueCanonicalSnapshot(
    terminalId: string,
    session: TerminalSession,
  ): Promise<TerminalAttachmentSnapshot | null> {
    const startedAtMs = Date.now();
    const snapshot = session.stateQueue.then(() => {
      if (!session.canonicalAvailable) return null;
      const canonical = session.canonicalState.snapshot();
      const attachment = {
        outputBoundary: session.outputBoundary,
        processGeneration: session.processGeneration,
        snapshot: canonical,
      } satisfies TerminalAttachmentSnapshot;
      workerLogger.event("debug", "Terminal canonical snapshot created", {
        event: "terminal.snapshot.created",
        subsystem: "terminal",
        operation: "serialize",
        status: "completed",
        terminalId,
        durationMs: Date.now() - startedAtMs,
        snapshot: {
          activeBuffer: canonical.activeBuffer,
          characters: canonical.data.length,
          format: "canonical-xterm-v1",
          generation: canonical.generation,
          outputBoundary: attachment.outputBoundary,
          processGeneration: attachment.processGeneration,
          scrollbackRows: canonical.scrollbackRows,
        },
      });
      return attachment;
    });
    session.stateQueue = snapshot
      .then(() => undefined)
      .catch((error: unknown) =>
        this.#recordCanonicalFailure(terminalId, session, "serialize", error),
      );
    return snapshot.catch(() => null);
  }

  #hydrateSubscriber(
    terminalId: string,
    session: TerminalSession,
    attachmentId: string,
    subscriber: TerminalSubscriber,
    attachedAtMs: number,
  ): Promise<void> {
    const legacyReplay = session.buffer;
    const legacyReplayTruncated = session.bufferTruncated;
    const legacyOutputBoundary = session.outputBoundary;
    const legacyProcessGeneration = session.processGeneration;
    const canonicalSnapshot = this.#queueCanonicalSnapshot(terminalId, session);
    return canonicalSnapshot.then(async (attachmentSnapshot) => {
      if (session.subscribers.get(attachmentId) !== subscriber) return;
      if (
        !attachmentSnapshot &&
        legacyProcessGeneration !== session.processGeneration
      ) {
        subscriber.pending.length = 0;
        subscriber.pendingCharacters = 0;
        subscriber.resnapshotRequired = false;
        return this.#hydrateSubscriber(
          terminalId,
          session,
          attachmentId,
          subscriber,
          attachedAtMs,
        );
      }
      if (subscriber.resnapshotRequired) {
        subscriber.pending.length = 0;
        subscriber.pendingCharacters = 0;
        subscriber.resnapshotRequired = false;
        return this.#hydrateSubscriber(
          terminalId,
          session,
          attachmentId,
          subscriber,
          attachedAtMs,
        );
      }
      const snapshot = attachmentSnapshot?.snapshot ?? null;
      const replayData = snapshot?.data ?? legacyReplay;
      const recovery = snapshot
        ? ({ recovery: "not-needed" } as const)
        : await this.#requestRecoveryRedraw(
            terminalId,
            session,
            legacyReplayTruncated,
          );
      if (session.subscribers.get(attachmentId) !== subscriber) return;
      if (
        legacyProcessGeneration !== session.processGeneration ||
        subscriber.resnapshotRequired
      ) {
        subscriber.pending.length = 0;
        subscriber.pendingCharacters = 0;
        subscriber.resnapshotRequired = false;
        return this.#hydrateSubscriber(
          terminalId,
          session,
          attachmentId,
          subscriber,
          attachedAtMs,
        );
      }
      if (!snapshot) {
        workerLogger.event(
          legacyReplayTruncated ? "warn" : "debug",
          "Terminal legacy replay selected",
          {
            event: "terminal.snapshot.legacy-selected",
            subsystem: "terminal",
            operation: "hydrate",
            reasonCode: session.canonicalAvailable
              ? "canonical-snapshot-unavailable"
              : "canonical-state-degraded",
            status: legacyReplayTruncated ? "degraded" : "completed",
            terminalId,
            snapshot: {
              characters: replayData.length,
              format: "legacy-raw-v1",
              outputBoundary: legacyOutputBoundary,
              processGeneration: legacyProcessGeneration,
              truncated: legacyReplayTruncated,
            },
            recovery: recovery.recovery,
          },
        );
      }
      this.#emitHydration(
        subscriber,
        replayData,
        snapshot
          ? {
              activeBuffer: snapshot.activeBuffer,
              cols: snapshot.cols,
              cursor: snapshot.cursor,
              format: "canonical-xterm",
              generation: snapshot.generation,
              modes: snapshot.modes,
              outputBoundary: attachmentSnapshot!.outputBoundary,
              processGeneration: attachmentSnapshot!.processGeneration,
              rows: snapshot.rows,
              scrollbackRows: snapshot.scrollbackRows,
              version: 1,
            }
          : {
              cols: session.cols,
              format: "legacy-raw",
              generation: session.canonicalState.generation,
              outputBoundary: legacyOutputBoundary,
              processGeneration: legacyProcessGeneration,
              ...recovery,
              rows: session.rows,
              truncated: legacyReplayTruncated,
              version: 1,
            },
      );
      const queuedDeltas = subscriber.pending.length;
      for (const data of subscriber.pending) {
        this.#emitOutput(subscriber, data);
      }
      subscriber.pending.length = 0;
      subscriber.pendingCharacters = 0;
      subscriber.hydrating = false;
      // Replayed control sequences can make terminal emulators emit replies,
      // so keep the input-ready marker behind hydration and queued deltas.
      subscriber.emit({ type: "terminal.ready" });
      workerLogger.event("debug", "Terminal client attached", {
        event: "terminal.client.attached",
        subsystem: "terminal",
        operation: "attach",
        status: "completed",
        terminalId,
        attachmentId,
        durationMs: Date.now() - attachedAtMs,
        dimensions: { cols: session.cols, rows: session.rows },
        replay: {
          characters: replayData.length,
          format: snapshot ? "canonical-xterm-v1" : "legacy-raw-v1",
          generation: snapshot?.generation ?? session.canonicalState.generation,
          outputBoundary:
            attachmentSnapshot?.outputBoundary ?? legacyOutputBoundary,
          processGeneration:
            attachmentSnapshot?.processGeneration ?? legacyProcessGeneration,
          recovery: recovery.recovery,
          truncated: snapshot ? false : legacyReplayTruncated,
        },
        counts: {
          clients: session.subscribers.size,
          queuedDeltas,
        },
      });
    });
  }

  #requestRecoveryRedraw(
    terminalId: string,
    session: TerminalSession,
    truncated: boolean,
  ): Promise<TerminalRecoveryRedraw> {
    if (!truncated) return Promise.resolve({ recovery: "not-needed" });
    if (
      session.recoveryRedraw?.processGeneration === session.processGeneration
    ) {
      return session.recoveryRedraw.result;
    }
    const processGeneration = session.processGeneration;
    const result = this.#performRecoveryRedraw(
      terminalId,
      session,
      processGeneration,
    );
    session.recoveryRedraw = { processGeneration, result };
    return result;
  }

  async #performRecoveryRedraw(
    terminalId: string,
    session: TerminalSession,
    processGeneration: number,
  ): Promise<TerminalRecoveryRedraw> {
    const process = session.process;
    if (!process) {
      return {
        recovery: "redraw-failed",
        recoveryReason: "no-live-process",
      };
    }
    const recoveryCols = session.cols === 1 ? 2 : session.cols - 1;
    try {
      process.resize(recoveryCols, session.rows);
      workerLogger.event("info", "Terminal recovery redraw requested", {
        event: "terminal.recovery-redraw.requested",
        subsystem: "terminal",
        operation: "recovery-redraw",
        reasonCode: "truncated-legacy-replay",
        status: "started",
        terminalId,
        processGeneration,
        dimensions: {
          temporary: { cols: recoveryCols, rows: session.rows },
          restore: { cols: session.cols, rows: session.rows },
        },
      });
    } catch (error) {
      workerLogger.rateLimited(
        `terminal-recovery-redraw:${terminalId}`,
        "warn",
        "Terminal recovery redraw request failed",
        {
          ...workerLogErrorIdentity(error),
          event: "terminal.recovery-redraw.failed",
          subsystem: "terminal",
          operation: "recovery-redraw",
          reasonCode: "resize-failed",
          status: "failed",
          terminalId,
          processGeneration,
          phase: "request",
        },
        { summaryEvery: 5, windowMs: 30_000 },
      );
      return {
        recovery: "redraw-failed",
        recoveryReason: "resize-failed",
      };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RECOVERY_REDRAW_RESTORE_DELAY_MS);
      timer.unref();
    });
    if (
      session.process !== process ||
      session.exited ||
      session.processGeneration !== processGeneration
    ) {
      return {
        recovery: "redraw-failed",
        recoveryReason: "no-live-process",
      };
    }
    try {
      process.resize(session.cols, session.rows);
      workerLogger.event("info", "Terminal recovery dimensions restored", {
        event: "terminal.recovery-redraw.restored",
        subsystem: "terminal",
        operation: "recovery-redraw",
        status: "completed",
        terminalId,
        processGeneration,
        dimensions: { cols: session.cols, rows: session.rows },
      });
      return { recovery: "redraw-requested" };
    } catch (error) {
      workerLogger.rateLimited(
        `terminal-recovery-restore:${terminalId}`,
        "warn",
        "Terminal recovery dimensions could not be restored",
        {
          ...workerLogErrorIdentity(error),
          event: "terminal.recovery-redraw.failed",
          subsystem: "terminal",
          operation: "recovery-redraw",
          reasonCode: "resize-failed",
          status: "failed",
          terminalId,
          processGeneration,
          phase: "restore",
        },
        { summaryEvery: 5, windowMs: 30_000 },
      );
      return {
        recovery: "redraw-failed",
        recoveryReason: "resize-failed",
      };
    }
  }

  #emitHydration(
    subscriber: TerminalSubscriber,
    data: string,
    metadata:
      | Omit<
          Extract<TerminalHydrationMetadata, { format: "canonical-xterm" }>,
          "snapshotCharacters" | "snapshotChunks"
        >
      | Omit<
          Extract<TerminalHydrationMetadata, { format: "legacy-raw" }>,
          "snapshotCharacters" | "snapshotChunks"
        >,
  ): void {
    const chunks = runtimeOutputChunks(data);
    const hydration = {
      ...metadata,
      snapshotCharacters: data.length,
      snapshotChunks: chunks.length,
    } as TerminalHydrationMetadata;
    for (const [index, chunk] of chunks.entries()) {
      subscriber.emit({
        type: "terminal.output",
        data: chunk,
        ...(index === 0 ? { hydration } : {}),
      });
    }
  }

  #emitOutput(subscriber: TerminalSubscriber, data: string): void {
    for (const chunk of runtimeOutputChunks(data)) {
      subscriber.emit({ type: "terminal.output", data: chunk });
    }
  }

  #recordCanonicalFailure(
    terminalId: string,
    session: TerminalSession,
    operation: string,
    error: unknown,
  ): void {
    session.canonicalAvailable = false;
    workerLogger.rateLimited(
      `terminal-canonical-state:${terminalId}`,
      "warn",
      "Terminal canonical state update failed",
      {
        ...workerLogErrorIdentity(error),
        event: "terminal.canonical-state.failed",
        subsystem: "terminal",
        operation,
        reasonCode: "emulator-update-failed",
        status: "degraded",
        terminalId,
      },
      { summaryEvery: 20, windowMs: 30_000 },
    );
  }

  #resetReplayState(terminalId: string, session: TerminalSession): void {
    session.buffer = "";
    session.bufferTruncated = false;
    this.#queueCanonicalMutation(terminalId, session, "reset", () =>
      session.canonicalState.reset(session.cols, session.rows),
    );
  }
}
