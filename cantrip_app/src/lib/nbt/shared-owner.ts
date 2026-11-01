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
export type NbtOwnerAnnouncement = "owner" | "replace" | "recover" | "retry";
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
  private workerController = new AbortController();
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
  private recovering = false;
  private recovery?: Promise<NbtDocumentClient>;
  private failure?: string;
  private automaticRecovery = true;
  ready: Promise<NbtDocumentClient>;
  constructor(
    private factory: NbtSharedFactory,
    private send: (peer: string, message: NbtDocumentResponse) => void,
    private announce: (
      generation: number,
      reason: NbtOwnerAnnouncement,
    ) => void,
    private idle: () => void,
    public generation = 0,
  ) {
    this.ready = this.start();
    void this.ready.catch(() => {});
  }
  private check() {
    if (this.closed) throw new Error("The NBT document owner is closed.");
  }
  private signal() {
    return AbortSignal.any([
      this.controller.signal,
      this.workerController.signal,
    ]);
  }
  private async start(reason: NbtOwnerAnnouncement = "owner") {
    try {
      const generation = await this.factory.claim();
      this.check();
      this.generation = generation;
      this.announce(generation, reason);
      const client = await this.factory.create(
        undefined,
        this.signal(),
        (client) => this.bind(client),
      );
      this.check();
      this.opening = false;
      this.failure = undefined;
      if (client.getSnapshot()?.state === "complete")
        this.automaticRecovery = true;
      this.publish(undefined, true);
      return client;
    } catch (error) {
      this.opening = false;
      this.failure =
        error instanceof Error
          ? error.message
          : "The NBT recovery could not be opened.";
      // A failed claim must not invent a journal revision. Announce the last
      // observed generation with an unavailable state so surviving views can
      // request a real retry instead of waiting indefinitely for a new owner.
      if (!this.closed) {
        this.announce(this.generation, reason);
        this.publish(undefined, true);
      }
      throw error;
    }
  }
  private bind(client: NbtDocumentClient) {
    this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
    this.client = client;
    this.unsubscribe = [
      client.subscribe(() => {
        if (client.getSnapshot()?.state === "error") {
          // fail() publishes before disposing its endpoint. Observe actual
          // disposal after that turn; parser diagnostics alone are not crashes.
          queueMicrotask(() => this.workerFailed(client));
        } else {
          if (
            client.getSnapshot()?.state === "complete" &&
            !this.opening &&
            !this.recovering
          )
            this.automaticRecovery = true;
          this.publish();
        }
      }),
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
  private workerFailed(client: NbtDocumentClient) {
    if (
      this.closed ||
      this.client !== client ||
      this.recovering ||
      this.opening
    )
      return;
    if (!client.isClosed) {
      this.publish();
      return;
    }
    this.failure =
      client.getSnapshot()?.error?.message ??
      "The NBT document worker stopped.";
    if (this.automaticRecovery) {
      this.automaticRecovery = false;
      void this.recover().catch(() => {});
    } else this.publish(undefined, true);
  }
  /** Reopen the authoritative journal under the existing origin owner lock.
   * No ambiguous edit or save request is resent into the recovered model. */
  recover() {
    if (this.closed)
      return Promise.reject(new Error("The NBT document owner is closed."));
    if (this.recovery) return this.recovery;
    const ready = this.ready,
      mutations = [...this.mutations];
    this.recovering = true;
    this.failure = undefined;
    this.workerController.abort(new Error("The NBT worker is recovering."));
    this.publish(undefined, true);
    const operation = this.controls.then(async () => {
      await ready.catch(() => {});
      this.check();
      this.foreground++;
      this.activity();
      try {
        await Promise.allSettled(mutations);
        this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
        await this.client?.close().catch(() => {});
      } finally {
        this.foreground--;
      }
      this.check();
      this.client = undefined;
      this.saveOwner = undefined;
      for (const peer of this.peers.values()) {
        peer.searches.clear();
        peer.exports.clear();
      }
      this.workerController = new AbortController();
      this.opening = true;
      return this.start("recover");
    });
    const recovery = operation.finally(() => {
      this.recovering = false;
      if (this.recovery === recovery) this.recovery = undefined;
      this.activity();
      this.publish(undefined, true);
    });
    this.ready = this.recovery = recovery;
    this.controls = recovery.then(
      () => {},
      () => {},
    );
    void recovery.catch(() => {});
    return recovery;
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
    const snapshot = this.client?.getSnapshot() ?? emptyStatus();
    const status = this.failure
      ? {
          ...snapshot,
          state: "error" as const,
          root: null,
          error: { message: this.failure },
        }
      : this.opening || this.recovering
        ? {
            ...snapshot,
            state: "indexing" as const,
            root: null,
            error: undefined,
          }
        : (this.client?.getSnapshot() ?? emptyStatus());
    return {
      ...status,
      shared: {
        generation: this.generation,
        views: [...this.peers.values()].filter((peer) => !peer.closing).length,
        changing: this.changing || this.recovering,
        unavailable: Boolean(this.failure),
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
    const generation = this.generation;
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
          if (this.recovering && command.type !== "attach")
            throw new Error(
              "The NBT document is recovering. Wait for it to finish.",
            );
          await this.ready;
          this.check();
          controller.signal.throwIfAborted();
          if (command.type !== "attach" && generation !== this.generation)
            throw new Error(
              "The NBT document generation changed before this request could run.",
            );
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
    const ready = this.ready,
      generation = this.generation;
    const operation = this.controls.then(async () => {
      this.foreground++;
      this.activity();
      try {
        await ready;
        this.check();
        if (generation !== this.generation || this.recovering)
          throw new Error(
            "The NBT document changed before this action could run.",
          );
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
          this.signal(),
          () => {},
        );
      let adopted = false,
        clearing = false;
      try {
        await this.complete(candidate, this.signal());
        await this.factory.reconcile(current);
        clearing = true;
        await current.clearRecovery();
        await current.close();
        const generation = await this.factory.claim();
        await this.factory.attachRecovery(candidate);
        this.generation = generation;
        this.bind(candidate);
        this.announce(this.generation, "replace");
        this.publish();
        adopted = true;
      } catch (error) {
        // The clear may have committed even if its reply was lost. Reopen the
        // actual journal rather than guessing which baseline is authoritative.
        if (clearing) void this.recover().catch(() => {});
        throw error;
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
          this.announce(this.generation, "retry");
          throw error;
        }
      }
      peer.closing = true;
      peer.active = false;
      await this.cancelSearches(peer);
      this.activity();
    });
  }
  private complete(client: NbtDocumentClient, signal: AbortSignal) {
    signal.throwIfAborted();
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
        reject(signal.reason);
      };
      const cleanup = () => {
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
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
