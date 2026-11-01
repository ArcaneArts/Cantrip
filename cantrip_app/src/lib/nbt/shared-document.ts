import {
  NbtDocumentClient,
  type NbtDocumentRequest,
  type NbtDocumentResponse,
  type NbtMessageEndpoint,
} from "@cantrip/nbt/document";
import { nbtSharedWire } from "./shared-wire";
import {
  NbtSharedOwner,
  type NbtInterpretation,
  type NbtSharedFactory,
} from "./shared-owner";

interface Port {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}
type Packet = {
  from: string;
  to: string;
  term: number;
  seq: number;
  kind: "rpc" | "event" | "ready" | "activity" | "control" | "control.result";
  data: unknown;
};
type Control = { id: string } & (
  | { type: "replace"; choice?: NbtInterpretation }
  | { type: "closeView" }
  | { type: "checkpoint" }
);
export interface NbtSharedDocumentOptions {
  id: string;
  key: CryptoKey;
  factory: NbtSharedFactory;
  assertCurrent(): void;
  /** Account/connection invalidation is independent of whether a React view
   * still lives in the renderer currently owning the background worker. */
  onInvalidate(notify: () => void): () => void;
  locks?: Pick<LockManager, "request">;
  channel?: (name: string) => Port;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void,
    reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const uuid = /^[a-f0-9-]{36}$/u;
const views = new WeakMap<NbtDocumentClient, NbtSharedDocument>();
const live = new Set<NbtSharedDocument>();
export function nbtSharedDocument(client: NbtDocumentClient) {
  return views.get(client);
}
export async function clearNbtSharedDocuments() {
  await Promise.allSettled(
    [...live].map((connection) =>
      connection.shutdown(new Error("The NBT account changed or locked.")),
    ),
  );
}

/** One origin-wide lock owns the parser; each view holds a separate lifetime
 * lock. Actual lock release detects renderer death without polling or lease
 * expiry guesses. New owners recover the journal, fence its generation and
 * reconnect surviving views without replaying ambiguous mutation requests. */
export class NbtSharedDocument implements NbtMessageEndpoint<
  NbtDocumentResponse,
  NbtDocumentRequest
> {
  private readonly id = crypto.randomUUID();
  private readonly lifetime = new AbortController();
  private readonly releaseView = deferred<void>();
  private readonly releaseOwner = deferred<void>();
  private readonly listeners = new Set<
    (event: MessageEvent<NbtDocumentResponse>) => void
  >();
  private readonly pending = new Map<number, NbtDocumentRequest>();
  private readonly controls = new Map<
    string,
    {
      type: string;
      resolve(value: unknown): void;
      reject(error: unknown): void;
    }
  >();
  private readonly watches = new Map<string, AbortController>();
  private readonly lastSequence = new Map<string, number>();
  private wire!: Awaited<ReturnType<typeof nbtSharedWire>>;
  private port!: Port;
  private locks!: Pick<LockManager, "request">;
  private owner?: NbtSharedOwner;
  private ownerTask?: Promise<unknown>;
  private viewTask?: Promise<unknown>;
  private outgoing = Promise.resolve();
  private incoming = Promise.resolve();
  private seq = 0;
  private term = 0;
  private ownerId?: string;
  private paused = true;
  private localClosed = false;
  private closed = false;
  private unsubscribe = () => {};
  private client?: NbtDocumentClient;
  private idle = false;
  private serverWork = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private options: NbtSharedDocumentOptions | undefined;
  private constructor(options: NbtSharedDocumentOptions) {
    this.options = options;
  }
  private get context() {
    if (!this.options) throw new Error("The NBT shared document has closed.");
    return this.options;
  }

  static async open(
    options: NbtSharedDocumentOptions,
    signal?: AbortSignal,
    onCreated?: (client: NbtDocumentClient) => void,
  ) {
    const connection = new NbtSharedDocument(options);
    try {
      await connection.start(signal);
      const client = await NbtDocumentClient.attach(
        connection,
        () => connection.stopView(),
        signal,
        (client) => {
          connection.client = client;
          views.set(client, connection);
          onCreated?.(client);
        },
      );
      return client;
    } catch (error) {
      await connection.shutdown(error);
      throw error;
    }
  }
  private lockName(peer?: string) {
    return (
      "cantrip-nbt-v1:" + this.context.id + (peer ? ":view:" + peer : ":owner")
    );
  }
  private async start(signal?: AbortSignal) {
    this.context.assertCurrent();
    signal?.throwIfAborted();
    this.wire = await nbtSharedWire(this.context.id, this.context.key);
    this.port =
      this.context.channel?.("cantrip-nbt-v1:" + this.context.id) ??
      new BroadcastChannel("cantrip-nbt-v1:" + this.context.id);
    this.port.addEventListener("message", this.message);
    this.locks = this.context.locks ?? navigator.locks;
    this.unsubscribe = this.context.onInvalidate(() => {
      try {
        this.context.assertCurrent();
      } catch (error) {
        void this.shutdown(error);
      }
    });
    live.add(this);
    const held = deferred<void>();
    // Attempt the actual locking operation. Unsupported/blocked locking is an
    // operation failure, not an inferred eligibility or quota check.
    this.viewTask = this.locks.request(
      this.lockName(this.id),
      { signal: this.lifetime.signal },
      async () => {
        held.resolve();
        await this.releaseView.promise;
      },
    );
    void this.viewTask.catch(held.reject);
    if (signal) {
      const abort = () => {
        held.reject(signal.reason);
        void this.shutdown(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await held.promise;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } else await held.promise;
    this.context.assertCurrent();
    this.ownerTask = this.locks.request(
      this.lockName(),
      { signal: this.lifetime.signal },
      async () => {
        if (this.closed || this.localClosed) return;
        const owner = new NbtSharedOwner(
          this.context.factory,
          (peer, message) => {
            void this.send(peer, "event", message);
          },
          (_generation, retry) => {
            void this.send("*", "ready", retry ? "retry" : null);
          },
          () => {
            this.idle = true;
          },
        );
        this.owner = owner;
        try {
          await this.releaseOwner.promise;
        } finally {
          await owner.close();
          for (const watch of this.watches.values()) watch.abort();
          this.watches.clear();
          if (this.owner === owner) this.owner = undefined;
        }
      },
    );
    void this.ownerTask.catch((error) => {
      if (!this.closed) void this.shutdown(error);
    });
  }
  private emit(message: NbtDocumentResponse) {
    if (this.localClosed) return;
    if (message.type === "result") this.pending.delete(message.id);
    for (const listener of this.listeners)
      listener({ data: message } as MessageEvent<NbtDocumentResponse>);
  }
  postMessage(message: NbtDocumentRequest) {
    if (this.localClosed || this.closed)
      throw new Error("The NBT shared view is closed.");
    if (message.type === "request") {
      this.pending.set(message.id, structuredClone(message));
      if (message.command.type === "pause")
        this.paused = message.command.paused;
    } else if (message.type === "cancel") this.pending.delete(message.id);
    void this.send("owner", "rpc", message);
  }
  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<NbtDocumentResponse>) => void,
  ) {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<NbtDocumentResponse>) => void,
  ) {
    this.listeners.delete(listener);
  }
  private send(to: string, kind: Packet["kind"], data: unknown) {
    const packet: Packet = structuredClone({
      from: this.id,
      to,
      kind,
      data,
      term: this.owner?.generation ?? this.term,
      seq: ++this.seq,
    });
    const operation = this.outgoing.then(async () => {
      if (this.closed) return;
      this.context.assertCurrent();
      const local = to === this.id || (to === "owner" && this.owner);
      if (!local) {
        const frame = await this.wire.seal(packet);
        if (this.closed) return;
        this.context.assertCurrent();
        this.port.postMessage(frame);
      }
      if (local || to === "*") this.accept(packet);
    });
    this.outgoing = operation.catch((error) => {
      void this.shutdown(error);
    });
    return operation;
  }
  private message = (event: MessageEvent) => {
    this.incoming = this.incoming.then(async () => {
      if (this.closed) return;
      try {
        this.context.assertCurrent();
        this.accept(await this.wire.open(event.data));
      } catch {
        /* Foreign keys/corrupt packets cannot change ownership or content. */
      }
    });
  };
  private accept(value: unknown) {
    if (this.closed || !value || typeof value !== "object") return;
    const packet = value as Packet;
    if (
      !uuid.test(packet.from) ||
      !(packet.to === "owner" || packet.to === "*" || uuid.test(packet.to)) ||
      !Number.isSafeInteger(packet.term) ||
      packet.term < 0 ||
      !Number.isSafeInteger(packet.seq) ||
      packet.seq < 1 ||
      ![
        "rpc",
        "event",
        "ready",
        "activity",
        "control",
        "control.result",
      ].includes(packet.kind)
    )
      return;
    if (packet.seq <= (this.lastSequence.get(packet.from) ?? 0)) return;
    this.lastSequence.set(packet.from, packet.seq);
    if (packet.to === "owner") {
      if (!this.owner) return;
      const work = this.serve(packet).catch((error) => {
        void this.shutdown(error);
      });
      this.serverWork.add(work);
      void work.finally(() => {
        this.serverWork.delete(work);
        void this.collect();
      });
      return;
    }
    if ((packet.to !== "*" && packet.to !== this.id) || this.localClosed)
      return;
    if (packet.term < this.term) return;
    if (packet.kind === "ready") {
      if (packet.term === this.term && packet.from === this.ownerId) {
        if (packet.data === "retry") {
          void this.send("owner", "activity", this.paused);
          for (const pending of this.pending.values())
            if (
              pending.type === "request" &&
              ["attach", "pause"].includes(pending.command.type)
            )
              void this.send("owner", "rpc", pending);
        }
        return;
      }
      const previous = this.ownerId;
      this.term = packet.term;
      this.ownerId = packet.from;
      if (previous && this.client?.getSnapshot())
        this.emit({
          type: "status",
          status: {
            ...this.client.getSnapshot()!,
            state: "indexing",
            root: null,
            shared: {
              generation: this.term,
              views: this.client.getSnapshot()!.shared?.views ?? 1,
              changing: true,
            },
          },
        });
      for (const [id, pending] of this.pending) {
        if (
          pending.type === "request" &&
          ["attach", "pause"].includes(pending.command.type)
        )
          continue;
        this.emit({
          type: "result",
          id,
          value: null,
          error: {
            message:
              "The NBT owner changed. The journal was retained; check the recovered document before retrying this operation.",
          },
        });
      }
      if (previous && previous !== this.ownerId) {
        for (const control of this.controls.values())
          control.reject(
            new Error("The NBT owner changed while applying this action."),
          );
        this.controls.clear();
      }
      void this.send("owner", "activity", this.paused);
      for (const pending of this.pending.values())
        if (
          pending.type === "request" &&
          ["attach", "pause"].includes(pending.command.type)
        )
          void this.send("owner", "rpc", pending);
      return;
    }
    if (packet.term !== this.term || packet.from !== this.ownerId) return;
    if (packet.kind === "event") this.emit(packet.data as NbtDocumentResponse);
    if (packet.kind === "control.result") {
      const result = packet.data as {
          id: string;
          error?: string;
          value?: unknown;
        },
        pending = this.controls.get(result.id);
      if (!pending) return;
      this.controls.delete(result.id);
      if (result.error) pending.reject(new Error(result.error));
      else pending.resolve(result.value);
    }
  }
  private watch(peer: string) {
    if (this.watches.has(peer)) return;
    const controller = new AbortController();
    this.watches.set(peer, controller);
    void this.locks
      .request(this.lockName(peer), { signal: controller.signal }, async () => {
        await this.owner?.remove(peer);
        await this.collect();
      })
      .catch(() => {});
  }
  private async serve(packet: Packet) {
    const owner = this.owner!;
    if (!owner.accepting && !owner.hasPeer(packet.from)) return;
    const rpc = packet.data as NbtDocumentRequest;
    const initial =
      packet.kind === "rpc" &&
      rpc?.type === "request" &&
      ["attach", "pause", "close"].includes(rpc.command?.type);
    if (packet.term !== owner.generation && !(packet.term === 0 && initial)) {
      await this.send(packet.from, "ready", null);
      return;
    }
    this.idle = false;
    this.watch(packet.from);
    if (initial) await this.send(packet.from, "ready", null);
    if (packet.kind === "rpc") {
      try {
        await owner.request(packet.from, rpc);
      } catch (error) {
        if (rpc?.type === "request")
          await this.send(packet.from, "event", {
            type: "result",
            id: rpc.id,
            value: null,
            error: {
              message:
                error instanceof Error
                  ? error.message
                  : "The NBT view is unavailable.",
            },
          });
      }
    } else if (packet.kind === "activity" && typeof packet.data === "boolean") {
      if (owner.hasPeer(packet.from) || owner.accepting)
        await owner.setActivity(packet.from, packet.data).catch(() => {});
    } else if (packet.kind === "control") {
      const control = packet.data as Control;
      if (!control || !uuid.test(control.id)) return;
      try {
        if (control.type === "replace") {
          if (
            (control.choice?.profile &&
              ![
                "auto",
                "java",
                "java-unnamed",
                "bedrock",
                "bedrock-level",
                "network",
                "network-named",
              ].includes(control.choice.profile)) ||
            (control.choice?.compression &&
              !["auto", "none", "gzip", "zlib"].includes(
                control.choice.compression,
              ))
          )
            throw new Error("Unsupported NBT interpretation.");
          await owner.replace(control.choice);
        } else if (control.type === "checkpoint") await owner.checkpoint();
        else if (control.type === "closeView")
          await owner.closeView(packet.from);
        else throw new Error("Invalid NBT ownership action.");
        await this.send(packet.from, "control.result", {
          id: control.id,
          value: null,
        });
      } catch (error) {
        await this.send(packet.from, "control.result", {
          id: control.id,
          error:
            error instanceof Error
              ? error.message
              : "NBT ownership action failed.",
        });
      }
    }
    await this.outgoing;
  }
  private async collect() {
    if (
      !this.closed &&
      this.owner &&
      this.idle &&
      !this.owner.views &&
      !this.serverWork.size
    ) {
      await this.outgoing;
      if (!this.owner.views && !this.serverWork.size) await this.shutdown();
    }
  }
  private control(
    type: "replace" | "closeView" | "checkpoint",
    choice?: NbtInterpretation,
  ) {
    if (this.closed || this.localClosed)
      return Promise.reject(new Error("The NBT shared view is closed."));
    const id = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.controls.set(id, { type, resolve: () => resolve(), reject });
      void this.send("owner", "control", {
        id,
        type,
        ...(choice ? { choice } : {}),
      }).catch(reject);
    });
  }
  replace(choice?: NbtInterpretation) {
    return this.control("replace", choice);
  }
  closeView() {
    return this.control("closeView");
  }
  checkpoint() {
    return this.control("checkpoint");
  }
  private stopView() {
    if (this.localClosed) return;
    this.localClosed = true;
    this.releaseView.resolve();
    for (const control of this.controls.values())
      control.reject(new Error("The NBT view closed."));
    this.controls.clear();
    this.pending.clear();
    this.listeners.clear();
    if (this.owner) {
      void this.owner.remove(this.id).then(() => this.collect());
    } else void this.shutdown();
  }
  shutdown(reason?: unknown) {
    if (this.closed) return this.closing ?? Promise.resolve();
    this.closed = true;
    this.closing = (async () => {
      this.unsubscribe();
      this.lifetime.abort(reason ?? new Error("NBT shared document closed."));
      this.releaseView.resolve();
      this.releaseOwner.resolve();
      for (const watch of this.watches.values()) watch.abort();
      this.watches.clear();
      if (reason) this.client?.fail(reason);
      for (const control of this.controls.values())
        control.reject(reason ?? new Error("NBT shared document closed."));
      this.controls.clear();
      await this.owner?.close();
      await this.ownerTask?.catch(() => {});
      await this.viewTask?.catch(() => {});
      await this.outgoing.catch(() => {});
      this.wire?.close();
      this.port?.removeEventListener("message", this.message);
      this.port?.close();
      this.pending.clear();
      this.lastSequence.clear();
      this.listeners.clear();
      this.client = undefined;
      // A disposed endpoint must not retain vault keys or source factories,
      // even if a view still holds its now-closed client object.
      this.options = undefined;
      live.delete(this);
    })();
    return this.closing;
  }
}
