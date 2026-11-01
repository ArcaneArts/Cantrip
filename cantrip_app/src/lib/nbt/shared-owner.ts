import type {
  NbtDocumentClient,
  NbtDocumentCommand,
  NbtDocumentRequest,
  NbtDocumentResponse,
  NbtDocumentStatus,
} from "@cantrip/nbt/document";
import type { NbtFormat } from "@cantrip/nbt";

export interface NbtInterpretation {
  profile?: string;
  compression?: string;
  format?: NbtFormat;
}
export interface NbtSharedFactory {
  create(
    choice: NbtInterpretation | undefined,
    signal: AbortSignal,
    onCreated: (client: NbtDocumentClient) => void,
  ): Promise<NbtDocumentClient>;
  claim(): Promise<number>;
  attachRecovery(client: NbtDocumentClient): Promise<void>;
  reconcile(client: NbtDocumentClient): Promise<void>;
}
interface Peer {
  active: boolean;
  closing: boolean;
  foreground: number;
  requests: Map<number, AbortController>;
  searches: Map<string, string>;
  exports: Set<string>;
}
const mutates = (type: string) =>
  (type.startsWith("edit.") && type !== "edit.text") ||
  type.startsWith("save.") ||
  type.startsWith("recovery.");
const emptyStatus = (): NbtDocumentStatus => ({
  state: "indexing",
  root: null,
  availableBytes: 0,
  indexedBytes: 0,
  sourceBytesRead: 0,
  nodes: 0,
  cacheBytes: 0,
  indexPages: 0,
  peakIndexPages: 0,
});

/** One lock-owning actor routes all views into one dedicated document worker.
 * Per-view cancellation/searches are isolated; replacement/discard is exclusive. */
export class NbtSharedOwner {
  private peers = new Map<string, Peer>();
  private controller = new AbortController();
  private client?: NbtDocumentClient;
  private opening = true;
  private changing = false;
  private closed = false;
  private unsubscribe: Array<() => void> = [];
  private mutations = new Set<Promise<unknown>>();
  private controls = Promise.resolve();
  private closing?: Promise<void>;
  private removed = new Set<string>();
  private saveOwner?: { peer: string; id: string };
  private suspending = false;
  private retiring = false;
  private foreground = 0;
  readonly ready: Promise<NbtDocumentClient>;
  generation = 0;
  constructor(
    private factory: NbtSharedFactory,
    private send: (peer: string, message: NbtDocumentResponse) => void,
    private announce: (generation: number, retry?: boolean) => void,
    private idle: () => void,
  ) {
    this.ready = this.start();
    void this.ready.catch(() => {});
  }
  private check() {
    if (this.closed) throw new Error("The NBT document owner is closed.");
  }
  private async start() {
    this.generation = await this.factory.claim();
    this.check();
    this.announce(this.generation);
    const client = await this.factory.create(
      undefined,
      this.controller.signal,
      (client) => this.bind(client),
    );
    this.check();
    this.opening = false;
    this.publish(undefined, true);
    return client;
  }
  private bind(client: NbtDocumentClient) {
    this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
    this.client = client;
    this.unsubscribe = [
      client.subscribe(() => this.publish()),
      client.subscribeEdits(() => {
        this.publish(undefined, true);
        void this.suspendOrphanedSave();
      }),
      client.subscribeSearch(() => {
        const status = client.getSearchSnapshot();
        if (status)
          for (const [id, peer] of this.peers)
            if (peer.active && peer.searches.has(status.id))
              this.send(id, { type: "search.status", status });
      }),
    ];
    this.activity();
  }
  private activity() {
    void this.client
      ?.setPaused(
        !this.foreground &&
          ![...this.peers.values()].some(
            (peer) => peer.active || peer.foreground,
          ),
      )
      .catch(() => {});
  }
  private join(id: string) {
    this.check();
    if (this.removed.has(id)) throw new Error("The NBT view has closed.");
    let peer = this.peers.get(id);
    if (!peer) {
      if (this.peers.size >= 64)
        throw new Error("Too many NBT document views.");
      peer = {
        active: false,
        closing: false,
        foreground: 0,
        requests: new Map(),
        searches: new Map(),
        exports: new Set(),
      };
      this.peers.set(id, peer);
      this.publish();
    }
    return peer;
  }
  private status() {
    const status = this.opening
      ? {
          ...(this.client?.getSnapshot() ?? emptyStatus()),
          state: "indexing" as const,
          root: null,
        }
      : (this.client?.getSnapshot() ?? emptyStatus());
    return {
      ...status,
      shared: {
        generation: this.generation,
        views: [...this.peers.values()].filter((peer) => !peer.closing).length,
        changing: this.changing,
      },
    };
  }
  publish(only?: string, edits = false) {
    if (this.closed) return;
    for (const [id, peer] of this.peers) {
      if (only ? id !== only : !peer.active && !edits) continue;
      if (!this.opening) {
        const status = this.client?.getEditSnapshot();
        if (status) this.send(id, { type: "edit.status", status });
      }
      if (only || peer.active || edits)
        this.send(id, { type: "status", status: this.status() });
    }
  }
  async request(id: string, message: NbtDocumentRequest) {
    if (
      message.type === "request" &&
      message.command.type === "close" &&
      !this.peers.has(id)
    ) {
      this.send(id, { type: "result", id: message.id, value: null });
      return;
    }
    const peer = this.join(id);
    if (message.type === "cancel") {
      peer.requests
        .get(message.id)
        ?.abort(new Error("NBT view request cancelled."));
      return;
    }
    if (message.type !== "request")
      throw new Error("A shared NBT view cannot supply worker source bytes.");
    if (peer.requests.has(message.id)) return;
    const command = message.command;
    const controller = new AbortController();
    peer.requests.set(message.id, controller);
    const foreground =
      mutates(command.type) || command.type.startsWith("serialize.");
    if (foreground) {
      peer.foreground++;
      this.activity();
    }
    const run = (async () => {
      try {
        if (peer.closing && !["close", "pause"].includes(command.type))
          throw new Error("This NBT view is closing.");
        let value: unknown;
        if (command.type === "pause") {
          await this.setActivity(id, command.paused);
          value = this.status();
        } else if (command.type === "close") {
          value = null;
        } else {
          await this.ready;
          this.check();
          controller.signal.throwIfAborted();
          if (
            command.type === "open" ||
            command.type === "recovery.attach" ||
            command.type === "recovery.clear"
          )
            throw new Error(
              "Shared NBT ownership controls document replacement and discard.",
            );
          if (this.changing && mutates(command.type))
            throw new Error(
              "The NBT document is being replaced. Wait for it to finish.",
            );
          if (command.type === "search.start")
            peer.searches.set(command.id, command.context ?? "default");
          if (command.type === "serialize.begin")
            peer.exports.add(command.exportId);
          if (command.type === "save.begin") {
            if (
              this.saveOwner &&
              this.saveOwner.peer !== id &&
              this.peers.has(this.saveOwner.peer) &&
              this.client!.getEditSnapshot()?.saving
            )
              throw new Error("Another NBT view is saving this document.");
            this.saveOwner = { peer: id, id: command.saveId };
          } else if (
            command.type.startsWith("save.") &&
            this.saveOwner &&
            this.saveOwner.peer !== id
          )
            throw new Error("The NBT save belongs to another view.");
          value = await this.client!.request(command, controller.signal);
          if (command.type === "search.cancel")
            peer.searches.delete(command.id);
          if (
            command.type === "serialize.cancel" ||
            (command.type === "serialize.next" &&
              (value as { done?: boolean })?.done)
          )
            peer.exports.delete(command.exportId);
          if (
            command.type === "save.ack" ||
            (command.type === "save.fail" &&
              !this.client!.getEditSnapshot()?.pendingSaveId)
          )
            this.saveOwner = undefined;
          this.publish(id);
        }
        this.send(id, { type: "result", id: message.id, value });
      } catch (error) {
        this.send(id, {
          type: "result",
          id: message.id,
          value: null,
          error: {
            message:
              error instanceof Error
                ? error.message
                : "NBT shared request failed.",
          },
        });
      } finally {
        peer.requests.delete(message.id);
        if (foreground) {
          peer.foreground--;
          this.activity();
        }
        if (command.type === "close") await this.remove(id);
      }
    })();
    if (mutates(command.type)) {
      this.mutations.add(run);
      void run.finally(() => this.mutations.delete(run));
    }
    await run;
  }
  private async cancelSearches(peer: Peer) {
    const searches = [...peer.searches];
    peer.searches.clear();
    await Promise.allSettled(
      searches.map(([id, context]) =>
        this.client?.request({ type: "search.cancel", id, context }),
      ),
    );
  }
  async setActivity(id: string, paused: boolean) {
    const peer = this.join(id);
    peer.active = !paused && !peer.closing;
    this.activity();
    if (paused) await this.cancelSearches(peer);
    this.publish(id);
  }
  get views() {
    return this.peers.size;
  }
  get accepting() {
    return !this.retiring;
  }
  /** Accepted edits already have durable journal acknowledgements. Drain the
   * actual in-flight mutations before handing off or quitting; source bytes
   * and parsed trees never enter the workspace transfer envelope. */
  async checkpoint() {
    this.foreground++;
    this.activity();
    try {
      await this.ready;
      this.check();
      await Promise.allSettled([...this.mutations]);
      this.check();
    } finally {
      this.foreground--;
      this.activity();
    }
  }
  hasPeer(id: string) {
    return this.peers.has(id);
  }
  private async suspendOrphanedSave() {
    const save = this.saveOwner,
      status = this.client?.getEditSnapshot();
    if (
      !save ||
      this.peers.has(save.peer) ||
      status?.pendingSaveId !== save.id ||
      !status.saving ||
      this.suspending
    )
      return;
    this.suspending = true;
    try {
      await this.client!.failSave(save.id, true, true);
    } catch {
    } finally {
      this.suspending = false;
    }
  }
  async remove(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    this.removed.add(id);
    for (const request of peer.requests.values())
      request.abort(new Error("The NBT view closed."));
    await this.cancelSearches(peer);
    await Promise.allSettled(
      [...peer.exports].map((exportId) =>
        this.client?.request({ type: "serialize.cancel", exportId }),
      ),
    );
    await this.suspendOrphanedSave();
    this.activity();
    this.publish();
    if (!this.peers.size) this.idle();
  }
  private exclusive<T>(run: () => Promise<T>) {
    const operation = this.controls.then(async () => {
      this.foreground++;
      this.activity();
      try {
        await this.ready;
        this.check();
        this.changing = true;
        this.publish(undefined, true);
        await Promise.allSettled([...this.mutations]);
        this.check();
        return await run();
      } finally {
        this.foreground--;
        this.changing = false;
        this.activity();
        this.publish(undefined, true);
      }
    });
    this.controls = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  replace(choice?: NbtInterpretation) {
    return this.exclusive(async () => {
      if (this.client!.getEditSnapshot()?.saving)
        throw new Error(
          "Wait for the current NBT save before replacing the document.",
        );
      const current = this.client!,
        candidate = await this.factory.create(
          choice ?? { format: current.getSnapshot()?.format },
          this.controller.signal,
          () => {},
        );
      let adopted = false;
      try {
        await this.complete(candidate);
        await this.factory.reconcile(current);
        await current.clearRecovery();
        await current.close();
        this.generation = await this.factory.claim();
        await this.factory.attachRecovery(candidate);
        this.bind(candidate);
        this.announce(this.generation);
        this.publish();
        adopted = true;
      } finally {
        if (!adopted) await candidate.close();
      }
    });
  }
  closeView(id: string) {
    return this.exclusive(async () => {
      const peer = this.peers.get(id);
      if (!peer || peer.closing) return;
      if (
        [...this.peers.values()].filter((peer) => !peer.closing).length === 1
      ) {
        this.retiring = true;
        try {
          if (this.client!.getEditSnapshot()?.saving)
            throw new Error(
              "Wait for the current NBT save before closing the document.",
            );
          await this.factory.reconcile(this.client!);
          await this.client!.clearRecovery();
        } catch (error) {
          this.retiring = false;
          this.announce(this.generation, true);
          throw error;
        }
      }
      peer.closing = true;
      peer.active = false;
      await this.cancelSearches(peer);
      this.activity();
    });
  }
  private complete(client: NbtDocumentClient) {
    this.controller.signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const done = () => {
        const status = client.getSnapshot();
        if (status?.state === "complete") {
          cleanup();
          resolve();
        } else if (status?.state === "error" || status?.state === "closed") {
          cleanup();
          reject(
            new Error(
              status.error?.message ??
                "The replacement NBT file could not be read.",
            ),
          );
        }
      };
      const abort = () => {
        cleanup();
        reject(this.controller.signal.reason);
      };
      const cleanup = () => {
        unsubscribe();
        this.controller.signal.removeEventListener("abort", abort);
      };
      this.controller.signal.addEventListener("abort", abort, { once: true });
      unsubscribe = client.subscribe(done);
      done();
    });
  }
  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      this.controller.abort(new Error("NBT owner closed."));
      this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
      for (const peer of this.peers.values())
        for (const request of peer.requests.values()) request.abort();
      await this.ready.catch(() => {});
      await this.client?.close().catch(() => {});
      this.peers.clear();
    })());
  }
}
