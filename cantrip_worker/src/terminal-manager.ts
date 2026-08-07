import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  terminalOpenResultSchema,
  type TerminalOpenResult,
  type WorkerEvent,
} from "@cantrip/protocol";
import * as pty from "node-pty";

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
  cwd: string;
  exited: Extract<TerminalOpenResult, { status: "exited" }> | null;
  process: pty.IPty;
  subscribers: Map<string, (event: WorkerEvent) => void>;
  waiters: Map<string, (result: TerminalOpenResult) => void>;
}

function shellCommand(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return (
    process.env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash")
  );
}

function terminalEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  return environment;
}

export class TerminalManager {
  readonly #sessions = new Map<string, TerminalSession>();

  open(
    terminalId: string,
    attachmentId: string,
    cwd: string,
    cols: number,
    rows: number,
    emit: (event: WorkerEvent) => void,
  ): Promise<TerminalOpenResult> {
    let session = this.#sessions.get(terminalId);
    if (session?.exited) {
      this.#sessions.delete(terminalId);
      session = undefined;
    }
    if (!session) {
      ensureSpawnHelperExecutable();
      const process = pty.spawn(shellCommand(), [], {
        cols,
        rows,
        cwd,
        env: terminalEnvironment(),
        name: "xterm-256color",
      });
      session = {
        buffer: "",
        cwd,
        exited: null,
        process,
        subscribers: new Map(),
        waiters: new Map(),
      };
      this.#sessions.set(terminalId, session);
      process.onData((data) => {
        session!.buffer = `${session!.buffer}${data}`.slice(
          -MAX_SCROLLBACK_CHARS,
        );
        for (const subscriber of session!.subscribers.values()) {
          subscriber({ type: "terminal.output", data });
        }
      });
      process.onExit(({ exitCode, signal }) => {
        const result = terminalOpenResultSchema.parse({
          status: "exited",
          exitCode,
          signal: signal || null,
        }) as Extract<TerminalOpenResult, { status: "exited" }>;
        session!.exited = result;
        for (const resolve of session!.waiters.values()) resolve(result);
        session!.subscribers.clear();
        session!.waiters.clear();
      });
    } else if (session.cwd !== cwd) {
      throw new Error("Terminal session belongs to a different source folder.");
    }

    if (session.buffer) emit({ type: "terminal.output", data: session.buffer });
    if (session.exited) return Promise.resolve(session.exited);
    session.process.resize(cols, rows);
    session.subscribers.set(attachmentId, emit);
    return new Promise((resolve) =>
      session!.waiters.set(attachmentId, resolve),
    );
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

  input(terminalId: string, data: string): void {
    const session = this.liveSession(terminalId);
    session.process.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.liveSession(terminalId);
    session.process.resize(cols, rows);
  }

  close(terminalId: string): void {
    const session = this.#sessions.get(terminalId);
    if (!session || session.exited) return;
    session.process.kill();
  }

  closeAll(): void {
    for (const terminalId of this.#sessions.keys()) this.close(terminalId);
  }

  private liveSession(terminalId: string): TerminalSession {
    const session = this.#sessions.get(terminalId);
    if (!session || session.exited) {
      throw new Error(`Terminal ${terminalId} is not running.`);
    }
    return session;
  }
}
