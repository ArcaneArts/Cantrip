import { workerLogger } from "../logger.js";
import { readableCodexProviderError } from "./provider-errors.js";
import { CodexNativeRpcError } from "./rpc-protocol.js";
import type { PendingRpcRequest, RpcMessage } from "./runtime-types.js";
import type { CodexRuntimeDiagnostic } from "./runtime.js";

interface RpcRequestPorts {
  send(message: RpcMessage): void;
  runtimeId(): string | null;
  secrets(): ReadonlySet<string>;
  isZai(): boolean;
  recordDiagnostic(
    diagnostic: Omit<CodexRuntimeDiagnostic, "id">,
    warning?: string,
  ): string;
}

export class CodexRpcRequests {
  readonly #pending = new Map<number, PendingRpcRequest>();
  // Retain timed-out IDs until their response arrives so late private labels
  // cannot fall through into the unmatched-response diagnostic buffer.
  readonly #privateInferenceRequests = new Set<number>();
  #nextId = 1;

  constructor(private readonly ports: RpcRequestPorts) {}

  get pendingCount(): number {
    return this.#pending.size;
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    if (method === "cantrip/inference") this.#privateInferenceRequests.add(id);
    return new Promise((resolve, reject) => {
      const startedAtMs = Date.now();
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        workerLogger.rateLimited(
          `codex-rpc-timeout:${method}`,
          "warn",
          "Codex app-server request timed out",
          {
            event: "codex.rpc.timeout",
            subsystem: "codex",
            operation: method,
            status: "timed-out",
            runtimeId: this.ports.runtimeId(),
            durationMs: Date.now() - startedAtMs,
          },
        );
        reject(new Error(`Codex request ${method} timed out.`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        reject,
        resolve,
        startedAtMs,
        timeout,
      });
      this.ports.send({ id, method, params });
    });
  }

  diagnosticPayload(message: RpcMessage): unknown {
    return !message.method &&
      message.id !== undefined &&
      this.#privateInferenceRequests.delete(Number(message.id))
      ? {
          id: message.id,
          privateInference: true,
          status: message.error ? "failed" : "completed",
        }
      : message;
  }

  handleResponse(message: RpcMessage, diagnosticPayload: unknown): boolean {
    if (message.id === undefined || message.method) return false;

    const id = Number(message.id);
    const pending = this.#pending.get(id);
    if (!pending) {
      this.ports.recordDiagnostic(
        {
          at: new Date().toISOString(),
          direction: "from-runtime",
          kind: "unmatched-response",
          method: null,
          payload: diagnosticPayload,
        },
        `Unmatched App Server response ${String(message.id)}`,
      );
      return true;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    if (message.error) {
      workerLogger.rateLimited(
        `codex-rpc-failed:${pending.method}:${message.error.code}`,
        "warn",
        "Codex app-server request failed",
        {
          event: "codex.rpc.failed",
          subsystem: "codex",
          operation: pending.method,
          status: "failed",
          runtimeId: this.ports.runtimeId(),
          durationMs: Date.now() - pending.startedAtMs,
          reasonCode: `rpc-${message.error.code}`,
        },
      );
      pending.reject(
        new CodexNativeRpcError(
          readableCodexProviderError(message.error.message, {
            secrets: this.ports.secrets(),
            zai: this.ports.isZai(),
          }),
          message.error,
          pending.method,
        ),
      );
    } else {
      workerLogger.sampled(
        `codex-rpc-completed:${pending.method}`,
        100,
        "trace",
        "Codex app-server request completed",
        {
          event: "codex.rpc.completed",
          subsystem: "codex",
          operation: pending.method,
          status: "completed",
          runtimeId: this.ports.runtimeId(),
          durationMs: Date.now() - pending.startedAtMs,
        },
      );
      pending.resolve(message.result);
    }
    return true;
  }

  rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#privateInferenceRequests.clear();
  }
}
