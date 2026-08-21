import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { spawnGuardedProcess } from "../code/process-guard.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface CodexRpcError {
  code: number;
  message: string;
}

export interface CodexRpcResponse {
  error?: CodexRpcError;
  id: number;
  result?: unknown;
}

interface PendingRequest {
  reject(error: Error): void;
  resolve(response: CodexRpcResponse): void;
  timeout: ReturnType<typeof setTimeout>;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class CodexRpcClient {
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.resume();
    child.once("error", (error) => this.rejectAll(error));
    child.once("exit", (code, signal) =>
      this.rejectAll(
        new Error(
          `Codex app-server exited (${signal ?? `code ${String(code)}`}).`,
        ),
      ),
    );
  }

  request(method: string, params: unknown): Promise<CodexRpcResponse> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request ${method} timed out.`));
      }, this.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  close(): void {
    this.rejectAll(new Error("Codex app-server client closed."));
    this.child.kill("SIGINT");
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const message = objectValue(value);
    if (!message || typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timeout);
    const error = objectValue(message.error);
    pending.resolve({
      id: message.id,
      result: message.result,
      ...(error &&
      typeof error.code === "number" &&
      typeof error.message === "string"
        ? { error: { code: error.code, message: error.message } }
        : {}),
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export function spawnCodexRpcClient(
  binary: string,
  codexHome: string,
  options: { requestTimeoutMs?: number } = {},
): CodexRpcClient {
  return new CodexRpcClient(
    spawnGuardedProcess(binary, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: codexHome },
      stdin: "pipe",
    }),
    options.requestTimeoutMs,
  );
}

export async function initializeCodexRpcClient(
  client: Pick<CodexRpcClient, "request" | "notify">,
  input: {
    name: string;
    title: string;
    version: string;
    experimentalApi: boolean;
  },
): Promise<unknown> {
  const response = await client.request("initialize", {
    clientInfo: {
      name: input.name,
      title: input.title,
      version: input.version,
    },
    capabilities: {
      experimentalApi: input.experimentalApi,
      requestAttestation: false,
    },
  });
  if (response.error) throw new Error(response.error.message);
  client.notify("initialized", {});
  return response.result;
}
