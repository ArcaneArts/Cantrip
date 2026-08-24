import type { WorkerSocket } from "./bridge.js";

const MAX_AUTHENTICATION_BUFFER_BYTES = 8 * 1_024 * 1_024;
const MAX_AUTHENTICATION_BUFFER_EVENTS = 1_024;
const MAX_PROCESS_AUTHENTICATION_BUFFER_BYTES = 64 * 1_024 * 1_024;

type BufferedSocketEvent =
  | { kind: "close" }
  | { error: Error; kind: "error" }
  | { data: unknown; isBinary: boolean; kind: "message" };

function frameBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + frameBytes(chunk), 0);
  }
  return Buffer.byteLength(String(data));
}

export class BufferedWorkerSocketByteBudget {
  #usedBytes = 0;

  constructor(readonly limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new Error(
        "Worker authentication buffer limit must be a non-negative safe integer.",
      );
    }
  }

  get usedBytes(): number {
    return this.#usedBytes;
  }

  acquire(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (this.#usedBytes + bytes > this.limitBytes) return false;
    this.#usedBytes += bytes;
    return true;
  }

  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    this.#usedBytes = Math.max(0, this.#usedBytes - bytes);
  }
}

const processAuthenticationBufferBudget = new BufferedWorkerSocketByteBudget(
  MAX_PROCESS_AUTHENTICATION_BUFFER_BYTES,
);

/**
 * Captures the worker's bounded reconnect flush while authentication and any
 * shared-presence claim finish. The bridge owns the socket only after
 * `activate`, so unauthenticated frames are never dispatched early.
 */
export class BufferedWorkerSocket implements WorkerSocket {
  readonly #events: BufferedSocketEvent[] = [];
  readonly #listeners = {
    close: new Set<() => void>(),
    error: new Set<(error: Error) => void>(),
    message: new Set<(data: unknown, isBinary?: boolean) => void>(),
  };
  #activated = false;
  #bufferedBytes = 0;
  #closeDispatched = false;
  #inputClosed = false;
  #readyEnvelope: string | null = null;
  #readyPublished = false;

  constructor(
    private readonly socket: WorkerSocket,
    private readonly byteBudget = processAuthenticationBufferBudget,
  ) {
    socket.on("message", (data, isBinary) => {
      this.#receive({
        data,
        isBinary: Boolean(isBinary),
        kind: "message",
      });
    });
    socket.on("error", (error) => this.#receive({ error, kind: "error" }));
    socket.on("close", () => this.#receive({ kind: "close" }));
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get protocol(): string {
    return this.socket.protocol ?? "";
  }

  activate(): boolean {
    if (this.#activated) return true;
    if (!this.canActivate()) {
      this.#events.length = 0;
      this.#releaseBudget();
      return false;
    }
    this.#activated = true;
    for (const event of this.#events.splice(0)) this.#dispatch(event);
    this.#releaseBudget();
    return true;
  }

  canActivate(): boolean {
    return !this.#inputClosed && this.socket.readyState === 1;
  }

  prepareReady(envelope: string): void {
    if (this.#readyPublished) return;
    this.#readyEnvelope = envelope;
  }

  publishReady(): boolean {
    if (this.#readyPublished || this.#readyEnvelope === null) return true;
    if (!this.canActivate()) return false;
    try {
      this.socket.send(this.#readyEnvelope);
      this.#readyEnvelope = null;
      this.#readyPublished = true;
      return true;
    } catch {
      return false;
    }
  }

  close(code?: number, reason?: string): void {
    if (!this.#activated && !this.#inputClosed) {
      this.#inputClosed = true;
      this.#events.length = 0;
      this.#events.push({ kind: "close" });
      this.#releaseBudget();
    }
    this.#readyEnvelope = null;
    this.socket.close(code, reason);
  }

  disposePending(): void {
    if (this.#activated) return;
    this.#inputClosed = true;
    this.#events.length = 0;
    this.#readyEnvelope = null;
    this.#releaseBudget();
  }

  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary?: boolean) => void,
  ): void;
  on(
    event: "close" | "error" | "message",
    listener:
      | (() => void)
      | ((error: Error) => void)
      | ((data: unknown, isBinary?: boolean) => void),
  ): void {
    if (event === "close") {
      this.#listeners.close.add(listener as () => void);
    } else if (event === "error") {
      this.#listeners.error.add(listener as (error: Error) => void);
    } else {
      this.#listeners.message.add(
        listener as (data: unknown, isBinary?: boolean) => void,
      );
    }
  }

  send(data: string | Uint8Array, options?: { binary?: boolean }): void {
    this.socket.send(data, options);
  }

  #dispatch(event: BufferedSocketEvent): void {
    if (event.kind === "message") {
      if (this.#closeDispatched) return;
      for (const listener of this.#listeners.message) {
        listener(event.data, event.isBinary);
      }
      return;
    }
    if (event.kind === "error") {
      for (const listener of this.#listeners.error) listener(event.error);
      return;
    }
    if (this.#closeDispatched) return;
    this.#closeDispatched = true;
    for (const listener of this.#listeners.close) listener();
  }

  #receive(event: BufferedSocketEvent): void {
    if (this.#activated) {
      this.#dispatch(event);
      return;
    }
    if (this.#inputClosed) return;
    const bytes = event.kind === "message" ? frameBytes(event.data) : 0;
    if (
      this.#events.length >= MAX_AUTHENTICATION_BUFFER_EVENTS ||
      this.#bufferedBytes + bytes > MAX_AUTHENTICATION_BUFFER_BYTES
    ) {
      this.#rejectPending(1009, "Worker authentication buffer exceeded");
      return;
    }
    if (!this.byteBudget.acquire(bytes)) {
      this.#rejectPending(
        1013,
        "Worker authentication capacity is unavailable",
      );
      return;
    }
    if (event.kind !== "message") {
      this.#inputClosed = true;
      this.#events.length = 0;
      this.#readyEnvelope = null;
      this.#releaseBudget();
      return;
    }
    this.#events.push(event);
    this.#bufferedBytes += bytes;
  }

  #rejectPending(code: number, reason: string): void {
    this.#inputClosed = true;
    this.#events.length = 0;
    this.#events.push({ kind: "close" });
    this.#readyEnvelope = null;
    this.#releaseBudget();
    this.socket.close(code, reason);
  }

  #releaseBudget(): void {
    this.byteBudget.release(this.#bufferedBytes);
    this.#bufferedBytes = 0;
  }
}
