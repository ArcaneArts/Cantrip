import { workerLogger } from "../logger.js";
import { readableCodexProviderError } from "./provider-errors.js";
import {
  CodexNativeRpcError,
  CodexRpcObservationError,
} from "./rpc-protocol.js";
import type { PendingRpcRequest, RpcMessage } from "./runtime-types.js";
import type { CodexRuntimeDiagnostic } from "./runtime.js";

interface RpcRequestPorts {
  send(message: RpcMessage): void;
  runtimeId(): string | null;
  secrets(): ReadonlySet<string>;
  isZai(): boolean;
  isEndpoint?(): boolean;
  recordDiagnostic(
    diagnostic: Omit<CodexRuntimeDiagnostic, "id">,
    warning?: string,
  ): string;
}

export interface NativeRpcSettlementObserver {
  /** A matching native reply proves the request finished, including late replies. */
  replied(): void;
  /** The synchronous transport send failed before it accepted the frame. */
  notSent(): void;
}

export class CodexRpcRequests {
  readonly #pending = new Map<number, PendingRpcRequest>();
  // Retain timed-out IDs until their response arrives so late private labels
  // cannot fall through into the unmatched-response diagnostic buffer.
  readonly #privateInferenceRequests = new Set<number>();
  // Unlike promise waiters, these survive a request-observation timeout. A
  // timeout cannot establish that the native inference stopped executing.
  readonly #settlementObservers = new Map<
    number,
    NativeRpcSettlementObserver
  >();
  #nextId = 1;

  constructor(private readonly ports: RpcRequestPorts) {}

  get pendingCount(): number {
    return this.#pending.size;
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    settlement?: NativeRpcSettlementObserver,
  ): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    if (method === "cantrip/inference") this.#privateInferenceRequests.add(id);
    if (settlement) this.#settlementObservers.set(id, settlement);
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
        reject(
          new CodexRpcObservationError(`Codex request ${method} timed out.`),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        reject,
        resolve,
        startedAtMs,
        timeout,
      });
      try {
        this.ports.send({ id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        this.#privateInferenceRequests.delete(id);
        this.#settlementObservers.delete(id);
        clearTimeout(timeout);
        try {
          settlement?.notSent();
        } finally {
          reject(error);
        }
      }
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
    const settlement = this.#settlementObservers.get(id);
    this.#settlementObservers.delete(id);
    try {
      settlement?.replied();
    } catch {
      // Publication/observer failure must not prevent the native reply from
      // settling the original RPC. Do not log private response contents.
      this.ports.recordDiagnostic(
        {
          at: new Date().toISOString(),
          direction: "from-runtime",
          kind: "message",
          method: null,
          payload: { id, settlementObserverFailed: true },
        },
        "Native inference settlement observer failed",
      );
    }
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
            endpoint: this.ports.isEndpoint?.(),
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
      pending.reject(
        new CodexRpcObservationError(error.message, { cause: error }),
      );
    }
    this.#pending.clear();
    this.#privateInferenceRequests.clear();
    // Transport loss is not settlement. Captured native process ownership
    // retains its tickets until the actual exit hook confirms termination.
    this.#settlementObservers.clear();
  }
}
