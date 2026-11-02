import type {
  NbtEditOperation,
  NbtEditStatus,
  NbtSaveTarget,
  NbtPendingSave,
} from "../edit/types.js";
import type { NbtTreePage, NbtPathEntry, NbtTablePage } from "../view/types.js";
import type {
  NbtSearchQuery,
  NbtSearchStatus,
  NbtSearchResult,
} from "../search/types.js";
import { assertRange, NbtError } from "../types.js";
import type {
  NbtDisplayRow,
  NbtDocumentCommand,
  NbtDocumentInput,
  NbtDocumentOpenOptions,
  NbtDocumentRequest,
  NbtDocumentResponse,
  NbtSerializationReceipt,
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
  private editStatus: NbtEditStatus | null = null;
  private mutations = 0;
  private frozen = 0;
  private editListeners = new Set<() => void>();
  private searchStatus: NbtSearchStatus | null = null;
  private searchContext = crypto.randomUUID();
  private searchListeners = new Set<() => void>();
  private closing: Promise<void> | undefined;
  private closed = false;
  get isClosed() {
    return this.closed;
  }
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
    input: Blob | NbtDocumentSource | null,
    options: NbtDocumentOpenOptions,
    terminate: () => void = () => {},
    signal?: AbortSignal,
    onCreated?: (client: NbtDocumentClient) => void,
  ) {
    const local = input instanceof Blob,
      client = new NbtDocumentClient(
        endpoint,
        local || input === null ? undefined : input,
        terminate,
      );
    try {
      onCreated?.(client);
      if (!local && input !== null && input.size === undefined)
        throw new NbtError(0, "Remote NBT source requires a snapshot size");
      const source: NbtDocumentInput =
        input === null
          ? { kind: "recovery" }
          : local
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
  /** Attach another view to an existing worker through an app-owned endpoint. */
  static async attach(
    endpoint: NbtMessageEndpoint<NbtDocumentResponse, NbtDocumentRequest>,
    terminate: () => void,
    signal?: AbortSignal,
    onCreated?: (client: NbtDocumentClient) => void,
  ) {
    const client = new NbtDocumentClient(endpoint, undefined, terminate);
    try {
      onCreated?.(client);
      await client.request({ type: "attach" }, signal);
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
        const bytes = new Uint8Array(sourceBytes);
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
    if (message.type === "edit.status") {
      if (!this.closed) {
        this.editStatus = { ...message.status, editing: this.mutations > 0 };
        for (const listener of this.editListeners) listener();
      }
      return;
    }
    if (message.type === "search.status") {
      if (!this.closed) {
        this.searchStatus = message.status;
        for (const listener of this.searchListeners) listener();
      }
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
      !["close", "pause", "serialize.cancel", "search.cancel"].includes(
        command.type,
      )
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
  describe(id: string, signal?: AbortSignal) {
    return this.request<NbtDisplayRow>({ type: "node", id }, signal);
  }
  ancestors(id: string, signal?: AbortSignal) {
    return this.request<NbtPathEntry[]>({ type: "ancestors", id }, signal);
  }
  tree(
    expanded: string[],
    offset: number,
    limit = 128,
    anchor?: string,
    signal?: AbortSignal,
  ) {
    return this.request<NbtTreePage>(
      { type: "tree", expanded, offset, limit, anchor },
      signal,
    );
  }
  table(
    input: Omit<Extract<NbtDocumentCommand, { type: "table" }>, "type">,
    signal?: AbortSignal,
  ) {
    return this.request<NbtTablePage>({ type: "table", ...input }, signal);
  }
  startSearch(id: string, query: NbtSearchQuery) {
    return this.request<NbtSearchStatus>({
      type: "search.start",
      id,
      query,
      context: this.searchContext,
    });
  }
  searchResults(id: string, offset: number, limit = 128, signal?: AbortSignal) {
    return this.request<NbtSearchResult[]>(
      { type: "search.page", id, offset, limit, context: this.searchContext },
      signal,
    );
  }
  cancelSearch(id: string) {
    return this.request({
      type: "search.cancel",
      id,
      context: this.searchContext,
    });
  }
  getSearchSnapshot = () => this.searchStatus;
  subscribeSearch = (listener: () => void) => {
    this.searchListeners.add(listener);
    return () => {
      this.searchListeners.delete(listener);
    };
  };
  getEditSnapshot = () => this.editStatus;
  freezeEdits() {
    if (this.mutations)
      throw new Error("Wait for the current NBT edit to finish.");
    this.frozen++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.frozen--;
      }
    };
  }
  private async mutation<T>(run: () => Promise<T>): Promise<T> {
    if (this.frozen)
      throw new Error("NBT editing is suspended while ownership changes.");
    this.mutations++;
    const emit = () => {
      if (this.editStatus)
        this.editStatus = { ...this.editStatus, editing: this.mutations > 0 };
      for (const listener of this.editListeners) listener();
    };
    emit();
    try {
      return await run();
    } finally {
      this.mutations--;
      emit();
    }
  }
  subscribeEdits = (listener: () => void) => {
    this.editListeners.add(listener);
    return () => {
      this.editListeners.delete(listener);
    };
  };
  edit(
    operations: NbtEditOperation[],
    revision = this.editStatus?.revision ?? 0,
    label?: string,
    signal?: AbortSignal,
  ) {
    return this.mutation(() =>
      this.request<{ selection: string; status: NbtEditStatus }>(
        { type: "edit.apply", operations, revision, label },
        signal,
      ),
    );
  }
  undo(signal?: AbortSignal) {
    return this.mutation(() =>
      this.request<NbtEditStatus>({ type: "edit.undo" }, signal),
    );
  }
  redo(signal?: AbortSignal) {
    return this.mutation(() =>
      this.request<NbtEditStatus>({ type: "edit.redo" }, signal),
    );
  }
  textPage(
    id: string,
    field: "name" | "value",
    offset = 0,
    limit = 4096,
    signal?: AbortSignal,
  ) {
    return this.request<{
      text: string;
      offset: number;
      nextOffset: number;
      totalBytes: number;
      truncated: boolean;
    }>({ type: "edit.text", id, field, offset, limit }, signal);
  }
  beginSave(saveId: string, signal?: AbortSignal, target?: NbtSaveTarget) {
    return this.request<NbtPendingSave>(
      { type: "save.begin", saveId, target },
      signal,
    );
  }
  prepareSave(saveId: string, metadata: NbtSerializationReceipt) {
    return this.request<NbtPendingSave>({
      type: "save.ready",
      saveId,
      metadata,
    });
  }
  acknowledgeSave(saveId: string, version: string) {
    return this.request<NbtEditStatus>({ type: "save.ack", saveId, version });
  }
  failSave(saveId: string, uncertain: boolean, retain = false) {
    return this.request<NbtEditStatus>({
      type: "save.fail",
      saveId,
      uncertain,
      retain,
    });
  }
  /** Call only after an explicit discard and pending-write reconciliation. */
  clearRecovery() {
    return this.request<null>({ type: "recovery.clear" });
  }
  attachRecovery(options: { id: string; key: CryptoKey; replace?: boolean }) {
    return this.request<null>({ type: "recovery.attach", ...options });
  }
  checkpointRecovery(signal?: AbortSignal) {
    return this.request<NbtEditStatus>({ type: "recovery.checkpoint" }, signal);
  }
  setPaused(paused: boolean) {
    return this.request<NbtDocumentStatus>({ type: "pause", paused });
  }
  async *serialize(
    original = true,
    signal?: AbortSignal,
    saveId?: string,
  ): AsyncGenerator<Uint8Array, NbtSerializationReceipt> {
    const exportId = crypto.randomUUID();
    try {
      await this.request(
        { type: "serialize.begin", exportId, original, saveId },
        signal,
      );
      for (;;) {
        const result = await this.request<{
          done: boolean;
          bytes?: Uint8Array;
          size?: number;
          sha256?: string;
        }>({ type: "serialize.next", exportId }, signal);
        if (result.done) {
          if (
            !Number.isSafeInteger(result.size) ||
            !result.sha256?.match(/^[a-f0-9]{64}$/u)
          )
            throw new Error("NBT serialization receipt is invalid.");
          return { size: result.size!, sha256: result.sha256 };
        }
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
      this.searchListeners.clear();
      this.editListeners.clear();
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
    if (this.closed) return this.closing ?? Promise.resolve();
    return (this.closing ??= (async () => {
      try {
        await this.request({ type: "close" });
      } finally {
        this.dispose();
      }
    })());
  }
}
