import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import WebSocket from "ws";
import { spawnGuardedProcess } from "../process-guard.js";
import { workerLogger } from "../logger.js";
import {
  codexEndpointFromLine,
  codexStartupExitMessage,
} from "./rpc-protocol.js";
import type { CodexProcessLauncher } from "./runtime-types.js";

export const launchCodexProcess: CodexProcessLauncher = (
  binary,
  arguments_,
  options,
) =>
  spawnGuardedProcess(binary, arguments_, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    stdin: "pipe",
  });

const CODEX_STARTUP_TIMEOUT_MS = 2 * 60_000;

function codexDiagnosticClass(line: string): string {
  const normalized = line.toLowerCase();
  if (normalized.includes("panic")) return "panic";
  if (normalized.includes("error")) return "error";
  if (normalized.includes("warn")) return "warning";
  return "diagnostic";
}

export function readCodexProcessEndpoint(
  child: ChildProcessWithoutNullStreams,
  options: { runtimeId: string | null; readableError(line: string): string },
): Promise<string> {
  const processRuntimeId = options.runtimeId;
  const stdoutLines = readline.createInterface({ input: child.stdout });
  const stderrLines = readline.createInterface({ input: child.stderr });
  const startupStderr: string[] = [];
  let startupComplete = false;
  stderrLines.on("line", (line) => {
    if (line.trimStart().startsWith("listening on:")) return;
    const diagnosticClass = codexDiagnosticClass(line);
    workerLogger.rateLimited(
      `codex-subprocess:${processRuntimeId ?? "starting"}:${diagnosticClass}`,
      diagnosticClass === "panic" || diagnosticClass === "error"
        ? "warn"
        : "debug",
      "Codex app-server emitted a subprocess diagnostic",
      {
        event: "codex.runtime.diagnostic",
        subsystem: "codex",
        operation: "subprocess-stderr",
        status: diagnosticClass,
        runtimeId: processRuntimeId,
        diagnosticClass,
      },
    );
    if (!startupComplete) {
      startupStderr.push(options.readableError(line));
      if (startupStderr.length > 20) startupStderr.shift();
    }
  });
  return new Promise<string>((resolve, reject) => {
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
        startupComplete = true;
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
      reject(new Error(codexStartupExitMessage(code, signal, startupStderr)));
    });
  });
}

export function openCodexWebSocket(remoteUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(remoteUrl);
  return new Promise<WebSocket>((resolve, reject) => {
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
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
