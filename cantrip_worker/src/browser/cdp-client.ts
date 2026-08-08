import WebSocket from "ws";

interface CdpResponse {
  error?: { code: number; message: string };
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  sessionId?: string;
}

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

export type CdpEventListener = (
  params: unknown,
  sessionId: string | undefined,
) => void;

export class CdpClient {
  readonly #listeners = new Map<string, Set<CdpEventListener>>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #socket: WebSocket;
  #closed = false;
  #requestId = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("close", () =>
      this.close(new Error("Chromium CDP connection closed.")),
    );
    socket.on("error", (error) => this.close(error));
  }

  static connect(url: string, timeoutMs = 15_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        maxPayload: 16 * 1_024 * 1_024,
        perMessageDeflate: false,
      });
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("Timed out connecting to Chromium CDP."));
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve(new CdpClient(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  on(method: string, listener: CdpEventListener): () => void {
    let listeners = this.#listeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(method);
    };
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Chromium CDP connection is not open."));
    }
    const id = ++this.#requestId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout: setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`CDP command ${method} timed out.`));
        }, 30_000),
      });
      try {
        this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        const pending = this.#pending.get(id);
        if (pending) clearTimeout(pending.timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(reason = new Error("Chromium CDP connection closed.")): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.#pending.clear();
    this.#listeners.clear();
  }

  private onMessage(raw: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(`CDP ${message.error.code}: ${message.error.message}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    for (const listener of this.#listeners.get(message.method) ?? []) {
      try {
        listener(message.params, message.sessionId);
      } catch {
        // One malformed or stale CDP event must not terminate the worker.
      }
    }
  }
}
