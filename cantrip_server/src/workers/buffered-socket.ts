import type { WorkerSocket } from "./bridge.js";

const MAX_AUTHENTICATION_BUFFER_BYTES = 8 * 1_024 * 1_024;
const MAX_AUTHENTICATION_BUFFER_EVENTS = 1_024;

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

  constructor(private readonly socket: WorkerSocket) {
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

  activate(): void {
    if (this.#activated) return;
    this.#activated = true;
    for (const event of this.#events.splice(0)) this.#dispatch(event);
    this.#bufferedBytes = 0;
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
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
      this.#inputClosed = true;
      this.#events.length = 0;
      this.#bufferedBytes = 0;
      this.socket.close(1009, "Worker authentication buffer exceeded");
      return;
    }
    this.#events.push(event);
    this.#bufferedBytes += bytes;
    if (event.kind === "close") this.#inputClosed = true;
  }
}
