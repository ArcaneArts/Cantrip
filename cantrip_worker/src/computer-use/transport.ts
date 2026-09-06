import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CuaNativeError,
  CuaProcessError,
  CUA_NATIVE_ERROR_CODES,
  type CuaNativeErrorCode,
  type CuaProcessErrorCode,
} from "./errors.js";
import {
  CuaFrameDecoder,
  CUA_PROTOCOL_VERSION,
  encodeCuaFrame,
  type CuaFrame,
  type CuaOutcome,
} from "./framing.js";

export interface CuaTransport {
  request(
    operation: unknown,
    options?: CuaRequestOptions,
  ): Promise<{ data: unknown; payload: Buffer }>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export interface CuaRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Trusted owner cleanup only; never populate from an agent/client request. */
  lifecycle?: boolean;
  /** Trusted execution owner authorizes each host action; never supplied by JS. */
  onHostCall?: (action: unknown, signal: AbortSignal) => Promise<unknown>;
}

export interface CuaTransportOptions {
  args?: string[];
  onFailure?: (error: CuaProcessError) => void;
  /** Complete event message, including sequence and sessionId attribution. */
  onEvent?: (event: unknown) => void;
  spawnProcess?: typeof spawn;
}

interface Pending {
  resolve: (response: { data: unknown; payload: Buffer }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  disposeSignal: () => void;
  onHostCall: CuaRequestOptions["onHostCall"];
  hostController: AbortController;
  lastHostCallId: number;
  hostCallPending: boolean;
}

// Sixteen ordinary correlations plus sixteen native closes and four JS resets.
// The lifecycle owners retain their resource reservations until cleanup settles.
const MAX_OUTSTANDING = 36;
const MAX_ORDINARY_OUTSTANDING = 16;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CANCELLATION_GRACE_MS = 2_000;
const SHUTDOWN_GRACE_MS = 2_000;
const MAX_HOST_CALLS = 16384;

function hostFailure(error: unknown): CuaOutcome {
  let code: CuaNativeErrorCode = "invalid-request";
  if (error instanceof CuaNativeError || error instanceof CuaProcessError) {
    if (CUA_NATIVE_ERROR_CODES.includes(error.code as CuaNativeErrorCode))
      code = error.code as CuaNativeErrorCode;
    else if (error.code === "timeout" || error.code === "closed")
      code = "cancelled";
  }
  return {
    status: "error",
    error: { code, message: new CuaNativeError(code).message },
  };
}

function callback<T>(
  listener: ((value: T) => void) | undefined,
  value: T,
): void {
  try {
    // A consumer callback, including an accidental async callback, cannot break
    // the decoder or create an unhandled rejection in the process owner.
    void Promise.resolve(listener?.(value)).catch(() => {});
  } catch {}
}

class ChildTransport implements CuaTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder: CuaFrameDecoder;
  readonly #pending = new Map<number, Pending>();
  readonly #cancelled = new Map<number, NodeJS.Timeout>();
  readonly #exit: Promise<void>;
  #requestId = 0;
  #eventSequence = 0;
  #closing = false;
  #exited = false;
  #spawned = false;
  #failure: CuaProcessError | undefined;
  #termination: NodeJS.Timeout | undefined;

  constructor(
    binary: string,
    private readonly options: CuaTransportOptions,
  ) {
    try {
      this.#child = (options.spawnProcess ?? spawn)(
        binary,
        options.args ?? [],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      ) as ChildProcessWithoutNullStreams;
    } catch {
      throw new CuaProcessError("spawn-failed", "not-sent");
    }
    this.#decoder = new CuaFrameDecoder((frame) => this.#receive(frame));
    this.#exit = new Promise((resolve) => {
      this.#child.once("close", () => {
        this.#exited = true;
        clearTimeout(this.#termination);
        if (!this.#closing && !this.#failure) this.#fail("process-exited");
        resolve();
      });
    });
    this.#child.once("spawn", () => {
      this.#spawned = true;
    });
    this.#child.once("error", () =>
      this.#fail(this.#spawned ? "transport-failed" : "spawn-failed"),
    );
    this.#child.stdin.on("error", () => {
      if (!this.#closing) this.#fail("transport-failed");
    });
    this.#child.stdout.on("error", () => {
      if (!this.#closing) this.#fail("transport-failed");
    });
    this.#child.stderr.on("error", () => {
      if (!this.#closing) this.#fail("transport-failed");
    });
    // Drain without retaining or logging native diagnostic bytes. They may
    // contain protected target details; diagnostics never enter error messages.
    this.#child.stderr.on("data", () => {});
    this.#child.stdout.on("data", (chunk: Buffer) => {
      if (this.#failure) return;
      try {
        this.#decoder.push(chunk);
      } catch {
        this.#fail("protocol-error");
      }
    });
    this.#child.stdout.once("end", () => {
      if (this.#closing || this.#failure) return;
      try {
        this.#decoder.finish();
      } catch {
        this.#fail("protocol-error");
        return;
      }
      // No further request can succeed once the child closes its output, even
      // if its process has not exited yet.
      this.#fail("process-exited");
    });
  }

  get closed(): boolean {
    return this.#closing || this.#failure !== undefined || this.#exited;
  }

  #settlePending(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.disposeSignal();
      pending.hostController.abort();
    }
    return pending;
  }

  #rejectOutstanding(code: CuaProcessErrorCode): void {
    for (const id of this.#pending.keys()) {
      this.#settlePending(id)?.reject(
        new CuaProcessError(
          code,
          code === "spawn-failed" ? "not-sent" : "unknown",
        ),
      );
    }
    for (const timer of this.#cancelled.values()) clearTimeout(timer);
    this.#cancelled.clear();
  }

  #terminate(): void {
    if (this.#exited || this.#termination) return;
    this.#child.kill("SIGTERM");
    this.#termination = setTimeout(() => {
      this.#child.kill("SIGKILL");
      this.#child.stdin.destroy();
      this.#child.stdout.destroy();
      this.#child.stderr.destroy();
    }, 250);
    this.#termination.unref();
  }

  #fail(code: CuaProcessErrorCode): void {
    if (this.#failure || this.#closing) return;
    this.#failure = new CuaProcessError(
      code,
      code === "spawn-failed" ? "not-sent" : "unknown",
    );
    this.#rejectOutstanding(code);
    this.#terminate();
    callback(this.options.onFailure, this.#failure);
  }

  #receive(frame: CuaFrame): void {
    if (this.#closing || this.#failure) return;
    const message = frame.header.message;
    if (message.kind === "hostCall") {
      this.#hostCall(message);
      return;
    }
    if (message.kind === "event") {
      if (message.sequence <= this.#eventSequence) {
        this.#fail("protocol-error");
        return;
      }
      this.#eventSequence = message.sequence;
      callback(this.options.onEvent, message);
      return;
    }
    if (message.kind !== "response") {
      this.#fail("protocol-error");
      return;
    }
    const cancelled = this.#cancelled.get(message.requestId);
    if (cancelled) {
      clearTimeout(cancelled);
      this.#cancelled.delete(message.requestId);
      return;
    }
    // An evaluator cannot report successful completion before its dispatched
    // host action has an authoritative result. Error/cancellation responses can
    // terminate that wait, but must not turn an ambiguous action into success.
    if (
      message.result.status === "ok" &&
      this.#pending.get(message.requestId)?.hostCallPending
    ) {
      this.#fail("protocol-error");
      return;
    }
    const pending = this.#settlePending(message.requestId);
    if (!pending) {
      this.#fail("protocol-error");
      return;
    }
    if (message.result.status === "error")
      pending.reject(new CuaNativeError(message.result.error.code));
    else pending.resolve({ data: message.result.data, payload: frame.payload });
  }

  #hostCall(
    message: Extract<CuaFrame["header"]["message"], { kind: "hostCall" }>,
  ): void {
    const id = message.evaluationRequestId;
    // Cancellation acknowledgement owns this bounded tombstone. Never invoke
    // policy or emit a host result for an already-cancelled evaluation.
    if (this.#cancelled.has(id)) return;
    const pending = this.#pending.get(id);
    if (
      !pending?.onHostCall ||
      pending.hostCallPending ||
      message.callId !== pending.lastHostCallId + 1 ||
      message.callId > MAX_HOST_CALLS
    ) {
      this.#fail("protocol-error");
      return;
    }
    pending.lastHostCallId = message.callId;
    pending.hostCallPending = true;
    const active = () =>
      !this.closed &&
      this.#pending.get(id) === pending &&
      !pending.hostController.signal.aborted;
    const send = (result: CuaOutcome) => {
      if (!active()) return;
      const header = (value: CuaOutcome): CuaFrame["header"] => ({
        version: CUA_PROTOCOL_VERSION,
        message: {
          kind: "hostResult",
          evaluationRequestId: id,
          callId: message.callId,
          result: value,
        },
      });
      let encoded: Buffer;
      try {
        encoded = encodeCuaFrame(header(result));
      } catch (error) {
        encoded = encodeCuaFrame(header(hostFailure(error)));
      }
      // Serialization can invoke a user-defined getter; recheck ownership before
      // writing. Host replies use no ordinary request slot and no binary payload.
      if (!active()) return;
      pending.hostCallPending = false;
      this.#child.stdin.write(encoded, (error) => {
        if (error) this.#fail("transport-failed");
      });
    };
    // Invoke asynchronously: parsing other frames and native command responses
    // cannot wait behind policy, approval, or a native action's Promise.
    void Promise.resolve()
      .then(() =>
        active()
          ? pending.onHostCall!(message.action, pending.hostController.signal)
          : undefined,
      )
      .then(
        (data) =>
          send({ status: "ok", data: data === undefined ? null : data }),
        (error: unknown) => send(hostFailure(error)),
      )
      .catch(() => {
        if (active()) this.#fail("transport-failed");
      });
  }

  #cancel(id: number, code: "cancelled" | "timeout"): void {
    const pending = this.#settlePending(id);
    if (!pending) return;
    // An accepted mutation might have completed before cancellation arrived.
    // Report ambiguity and never replay it; retain only its bounded correlation.
    this.#cancelled.set(
      id,
      setTimeout(() => this.#fail("timeout"), CANCELLATION_GRACE_MS),
    );
    pending.reject(new CuaProcessError(code, "unknown"));
    this.#child.stdin.write(
      encodeCuaFrame({
        version: CUA_PROTOCOL_VERSION,
        message: { kind: "cancel", requestId: id },
      }),
      (error) => {
        if (error) this.#fail("transport-failed");
      },
    );
  }

  request(
    operation: unknown,
    {
      signal,
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      lifecycle = false,
      onHostCall,
    }: CuaRequestOptions = {},
  ): Promise<{ data: unknown; payload: Buffer }> {
    if (this.closed)
      return Promise.reject(new CuaProcessError("closed", "not-sent"));
    if (signal?.aborted)
      return Promise.reject(new CuaProcessError("cancelled", "not-sent"));
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs >
        (operation &&
        typeof operation === "object" &&
        "operation" in operation &&
        operation.operation === "javascript.evaluate"
          ? 7_502_000
          : operation &&
              typeof operation === "object" &&
              "operation" in operation &&
              operation.operation === "input.perform"
            ? 7_205_000
            : 120_000)
    )
      return Promise.reject(new CuaProcessError("invalid-request", "not-sent"));
    // Settled cancellation still consumes a native correlation until its reply
    // arrives. Reserve slots here, not in the owner's pending-promise count, so
    // a burst of cancelled reads cannot prevent all session.close requests.
    const limit =
      lifecycle === true ? MAX_OUTSTANDING : MAX_ORDINARY_OUTSTANDING;
    if (this.#pending.size + this.#cancelled.size >= limit)
      return Promise.reject(new CuaProcessError("capacity", "not-sent"));
    const requestId = this.#requestId + 1;
    let encoded: Buffer;
    try {
      encoded = encodeCuaFrame({
        version: CUA_PROTOCOL_VERSION,
        message: { kind: "request", requestId, operation },
      });
    } catch {
      return Promise.reject(new CuaProcessError("invalid-request", "not-sent"));
    }
    this.#requestId = requestId;
    return new Promise((resolve, reject) => {
      const abort = () => this.#cancel(requestId, "cancelled");
      const timer = setTimeout(
        () => this.#cancel(requestId, "timeout"),
        timeoutMs,
      );
      this.#pending.set(requestId, {
        resolve,
        reject,
        timer,
        disposeSignal: () => signal?.removeEventListener("abort", abort),
        onHostCall,
        hostController: new AbortController(),
        lastHostCallId: 0,
        hostCallPending: false,
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.#child.stdin.write(encoded, (error) => {
        if (error) this.#fail("transport-failed");
      });
    });
  }

  async close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      this.#rejectOutstanding("closed");
      if (!this.#exited) {
        this.#child.stdin.end();
        if (!this.#termination)
          this.#termination = setTimeout(() => {
            this.#termination = undefined;
            this.#terminate();
          }, SHUTDOWN_GRACE_MS);
      }
    }
    await this.#exit;
  }
}

/** The owning service chooses when to launch and if a failed process may restart. */
export function launchCuaTransport(
  binary: string,
  options: CuaTransportOptions = {},
): CuaTransport {
  return new ChildTransport(binary, options);
}
