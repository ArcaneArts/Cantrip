import { assertRange, NbtError } from "../types.js";
import type {
  NbtDisplayRow,
  NbtDocumentCommand,
  NbtDocumentInput,
  NbtDocumentOpenOptions,
  NbtDocumentRequest,
  NbtDocumentResponse,
  NbtDocumentSource,
  NbtDocumentStatus,
  NbtMessageEndpoint,
} from "./types.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};
/** Main-thread bridge: only bounded display pages and bounded source ranges cross it. */
export class NbtDocumentClient {
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private reads = new Map<number, AbortController>();
  private listeners = new Set<() => void>();
  private status: NbtDocumentStatus | null = null;
  private closing: Promise<void> | undefined;
  private closed = false;
  private constructor(
    private endpoint: NbtMessageEndpoint<
      NbtDocumentResponse,
      NbtDocumentRequest
    >,
    private source: NbtDocumentSource | undefined,
    private terminate: () => void,
  ) {
    endpoint.addEventListener("message", this.message);
  }
  static async open(
    endpoint: NbtMessageEndpoint<NbtDocumentResponse, NbtDocumentRequest>,
    input: Blob | NbtDocumentSource,
    options: NbtDocumentOpenOptions,
    terminate: () => void = () => {},
    signal?: AbortSignal,
  ) {
    const local = input instanceof Blob,
      client = new NbtDocumentClient(
        endpoint,
        local ? undefined : input,
        terminate,
      );
    try {
      if (!local && input.size === undefined)
        throw new NbtError(0, "Remote NBT source requires a snapshot size");
      const source: NbtDocumentInput = local
        ? { kind: "blob", blob: input }
        : { kind: "remote", size: input.size! };
      const status = await client.request<NbtDocumentStatus>(
        { type: "open", input: source, options },
        signal,
      );
      // Progress can arrive while the open request is resolving; keep the newer snapshot.
      if (!client.status) client.status = status;
      return client;
    } catch (error) {
      client.dispose(error);
      throw error;
    }
  }
  private message = (event: MessageEvent<NbtDocumentResponse>) => {
    const message = event.data;
    if (message.type === "source.cancel") {
      this.reads.get(message.id)?.abort();
      return;
    }
    if (message.type === "source.read") {
      if (this.closed || !this.source) return;
      const controller = new AbortController();
      if (this.reads.has(message.id) || this.reads.size >= 16) {
        this.endpoint.postMessage({
          type: "source.result",
          id: message.id,
          error: "NBT source read concurrency exceeded.",
        });
        return;
      }
      this.reads.set(message.id, controller);
      void (async () => {
        assertRange(message.offset, message.length);
        if (message.length > 256 * 1024)
          throw new NbtError(
            message.offset,
            "Source ranges are limited to 256 KiB",
          );
        const sourceBytes = await this.source!.read(
          message.offset,
          message.length,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (sourceBytes.length > message.length)
          throw new NbtError(message.offset, "Source exceeded requested range");
        const bytes = sourceBytes.slice();
        if (!this.closed)
          this.endpoint.postMessage(
            { type: "source.result", id: message.id, bytes },
            [bytes.buffer],
          );
      })()
        .catch((error) => {
          if (!this.closed)
            this.endpoint.postMessage({
              type: "source.result",
              id: message.id,
              error:
                error instanceof Error
                  ? error.message
                  : "NBT source reading failed.",
            });
        })
        .finally(() => this.reads.delete(message.id));
      return;
    }
    if (message.type === "status") {
      if (!this.closed) {
        this.status = message.status;
        for (const listener of this.listeners) listener();
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error) {
      const error = new Error(message.error.message);
      if (message.error.offset !== undefined)
        Object.assign(error, { offset: message.error.offset });
      pending.reject(error);
    } else pending.resolve(message.value);
  };
  request<T>(command: NbtDocumentCommand, signal?: AbortSignal): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("NBT document client is closed."));
    signal?.throwIfAborted();
    if (
      this.pending.size >= 64 &&
      !["close", "pause", "serialize.cancel"].includes(command.type)
    )
      return Promise.reject(new Error("NBT request queue is full."));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        this.endpoint.postMessage({ type: "cancel", id });
        reject(signal?.reason);
      };
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.endpoint.postMessage({ type: "request", id, command });
      } catch (error) {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }
  getSnapshot = () => this.status;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  rows(parent: string | null, offset = 0, limit = 128, signal?: AbortSignal) {
    return this.request<NbtDisplayRow[]>(
      { type: "rows", parent, offset, limit },
      signal,
    );
  }
  array(id: string, offset: number, limit = 256, signal?: AbortSignal) {
    return this.request<Array<number | bigint>>(
      { type: "array", id, offset, limit },
      signal,
    );
  }
  setPaused(paused: boolean) {
    return this.request<NbtDocumentStatus>({ type: "pause", paused });
  }
  async *serialize(
    original = true,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const exportId = crypto.randomUUID();
    try {
      await this.request(
        { type: "serialize.begin", exportId, original },
        signal,
      );
      for (;;) {
        const result = await this.request<{
          done: boolean;
          bytes?: Uint8Array;
        }>({ type: "serialize.next", exportId }, signal);
        if (result.done) return;
        yield result.bytes!;
      }
    } finally {
      if (!this.closed)
        await this.request({ type: "serialize.cancel", exportId }).catch(
          () => {},
        );
    }
  }
  private dispose(
    reason: unknown = new Error("NBT document client is closed."),
  ) {
    if (this.closed) return;
    this.closed = true;
    for (const read of this.reads.values()) read.abort(reason);
    this.reads.clear();
    try {
      this.source?.close?.();
    } finally {
      this.endpoint.removeEventListener("message", this.message);
      for (const pending of this.pending.values()) {
        pending.cleanup();
        pending.reject(reason);
      }
      this.pending.clear();
      this.listeners.clear();
      this.terminate();
    }
  }
  fail(error: unknown) {
    try {
      if (!this.closed && this.status) {
        this.status = {
          ...this.status,
          state: "error",
          error: {
            message:
              error instanceof Error
                ? error.message
                : "The NBT document worker stopped.",
          },
        };
        for (const listener of this.listeners) listener();
      }
    } finally {
      this.dispose(error);
    }
  }
  close() {
    return (this.closing ??= (async () => {
      try {
        await this.request({ type: "close" });
      } finally {
        this.dispose();
      }
    })());
  }
}
