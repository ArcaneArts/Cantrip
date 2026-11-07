import { createHash, randomUUID } from "node:crypto";
import {
  MODEL_CATALOG_BYTES_LIMIT,
  MODEL_CATALOG_PAGE_BYTES,
  MODEL_CATALOG_PAGE_ITEMS,
  endpointModelInventorySchema,
  modelCatalogPageSchema,
  modelCatalogSnapshotSchema,
  ollamaModelInventorySchema,
  type EndpointModelInventory,
  type ModelCatalogPageRequest,
  type ModelCatalogSnapshot,
  type OllamaModelInventory,
} from "@cantrip/protocol";

const SNAPSHOT_TTL_MS = 2 * 60_000;
type Snapshot = {
  id: string;
  key: string;
  bytes: number;
  expiresAt: number;
  complete: boolean;
  transfers: Set<string>;
  value: ModelCatalogSnapshot;
};

export class ModelCatalogSnapshots {
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #inFlight = new Map<string, Promise<Snapshot>>();
  readonly #waiters = new Set<() => void>();
  readonly #spaceWaiters = new Set<() => void>();
  readonly #expiry = new Map<string, NodeJS.Timeout>();
  #active = 0;
  #bytes = 0;

  async read(input: {
    scope: { serverId: unknown; ownerId: unknown; workerId: string };
    provider: {
      id: string;
      kind: string;
      baseUrl: string;
      apiKey: string | null;
    };
    kind: ModelCatalogSnapshot["kind"];
    page: ModelCatalogPageRequest | undefined;
    load(
      signal: AbortSignal,
    ): Promise<EndpointModelInventory | OllamaModelInventory>;
  }) {
    this.#prune();
    // Bind every cursor to its actual namespace and connection configuration.
    // Only this digest is retained; credentials are never part of a cursor.
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          input.scope,
          input.kind,
          input.provider.id,
          input.provider.kind,
          input.provider.baseUrl,
          input.provider.apiKey,
        ]),
      )
      .digest("hex");
    const offset = input.page?.offset ?? 0;
    const transferId = input.page?.transferId ?? randomUUID();
    let snapshot: Snapshot;
    if (input.page?.snapshotId) {
      const existing = this.#snapshots.get(input.page.snapshotId);
      if (!existing || existing.key !== key)
        throw new Error(
          "Model catalog snapshot expired or belongs to another connection.",
        );
      snapshot = existing;
      if (!snapshot.transfers.has(transferId))
        throw new Error("Model catalog transfer is no longer active.");
    } else {
      if (offset !== 0)
        throw new Error("A model catalog offset requires its snapshot.");
      let pending = this.#inFlight.get(key);
      if (!pending) {
        pending = this.#create(key, input.kind, input.load);
        this.#inFlight.set(key, pending);
        const clear = () => {
          if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key);
        };
        void pending.then(clear, clear);
      }
      snapshot = await pending;
      if (!snapshot.transfers.has(transferId) && snapshot.transfers.size >= 256)
        throw new Error("Model catalog has too many simultaneous readers.");
      snapshot.transfers.add(transferId);
      snapshot.complete = false;
    }
    try {
      if (!input.page) {
        // A legacy server must receive a full legacy inventory or an explicit
        // failure, never a first page it would reconcile as the complete catalog.
        this.#complete(snapshot, transferId);
        if (snapshot.bytes > 4 * 1024 * 1024)
          throw new Error(
            "Model catalog requires a server supporting paged discovery.",
          );
        return input.kind === "ollama"
          ? ollamaModelInventorySchema.parse(snapshot.value)
          : endpointModelInventorySchema.parse(snapshot.value);
      }
      if (offset > snapshot.value.models.length)
        throw new Error("Model catalog offset is outside its snapshot.");
      snapshot.expiresAt = Date.now() + SNAPSHOT_TTL_MS;
      this.#snapshots.delete(snapshot.id);
      this.#snapshots.set(snapshot.id, snapshot);
      const models = [];
      let bytes = 2_048;
      for (const model of snapshot.value.models.slice(
        offset,
        offset + MODEL_CATALOG_PAGE_ITEMS,
      )) {
        const size = Buffer.byteLength(JSON.stringify(model)) + 1;
        if (size + 2_048 > MODEL_CATALOG_PAGE_BYTES)
          throw new Error(
            "A model catalog entry exceeded the page byte limit.",
          );
        if (bytes + size > MODEL_CATALOG_PAGE_BYTES) break;
        bytes += size;
        models.push(model);
      }
      const next = offset + models.length;
      const page = modelCatalogPageSchema.parse({
        ...snapshot.value,
        models,
        snapshotId: snapshot.id,
        transferId,
        offset,
        nextOffset: next < snapshot.value.models.length ? next : null,
        total: snapshot.value.models.length,
      });
      if (page.nextOffset === null) this.#complete(snapshot, transferId);
      return page;
    } catch (error) {
      this.#complete(snapshot, transferId);
      throw error;
    }
  }

  async #create(
    key: string,
    kind: ModelCatalogSnapshot["kind"],
    load: (
      signal: AbortSignal,
    ) => Promise<EndpointModelInventory | OllamaModelInventory>,
  ): Promise<Snapshot> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(SNAPSHOT_TTL_MS),
    ]);
    let release: (() => void) | undefined;
    try {
      release = await this.#admit(signal);
      const value = modelCatalogSnapshotSchema.parse({
        kind,
        ...(await load(signal)),
      });
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > MODEL_CATALOG_BYTES_LIMIT)
        throw new Error("Model catalog snapshot exceeded 32 MiB.");
      this.#prune();
      while (
        this.#snapshots.size >= 8 ||
        this.#bytes + bytes > MODEL_CATALOG_BYTES_LIMIT
      ) {
        const removable = [...this.#snapshots.values()].find(
          (value) => value.complete,
        );
        if (removable) this.#remove(removable.id);
        else {
          // Do not evict another catalog while its pages are being consumed.
          // Its final page or idle expiry will make room without truncating it.
          await this.#waitForSpace(signal);
          this.#prune();
        }
      }
      const snapshot = {
        id: randomUUID(),
        key,
        bytes,
        value,
        expiresAt: Date.now() + SNAPSHOT_TTL_MS,
        complete: false,
        transfers: new Set<string>(),
      };
      this.#snapshots.set(snapshot.id, snapshot);
      this.#bytes += bytes;
      this.#scheduleExpiry(snapshot);
      return snapshot;
    } finally {
      controller.abort();
      release?.();
    }
  }

  async #admit(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.#active >= 4) {
      await new Promise<void>((resolve, reject) => {
        const clear = () => {
          this.#waiters.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        const wake = () => {
          clear();
          // Reserve the slot before waking the waiter so a newer load cannot
          // take it, including when cancellation races with this handoff.
          this.#active++;
          resolve();
        };
        const abort = () => {
          clear();
          reject(signal.reason);
        };
        this.#waiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else this.#active++;
    if (signal.aborted) {
      this.#release();
      signal.throwIfAborted();
    }
    return () => this.#release();
  }
  #release() {
    this.#active--;
    this.#waiters.values().next().value?.();
  }

  #remove(id: string) {
    const snapshot = this.#snapshots.get(id);
    if (!snapshot) return;
    this.#snapshots.delete(id);
    this.#bytes -= snapshot.bytes;
    clearTimeout(this.#expiry.get(id));
    this.#expiry.delete(id);
    this.#signalSpace();
  }
  #complete(snapshot: Snapshot, transferId: string) {
    snapshot.transfers.delete(transferId);
    snapshot.complete = snapshot.transfers.size === 0;
    this.#signalSpace();
  }
  #signalSpace() {
    for (const wake of this.#spaceWaiters) wake();
  }
  async #waitForSpace(signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const clear = () => {
        this.#spaceWaiters.delete(wake);
        signal.removeEventListener("abort", abort);
      };
      const wake = () => {
        clear();
        resolve();
      };
      const abort = () => {
        clear();
        reject(signal.reason);
      };
      this.#spaceWaiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
  }
  #scheduleExpiry(snapshot: Snapshot) {
    const timer = setTimeout(
      () => {
        if (snapshot.expiresAt <= Date.now()) this.#remove(snapshot.id);
        else this.#scheduleExpiry(snapshot);
      },
      Math.max(1, snapshot.expiresAt - Date.now()),
    );
    timer.unref();
    this.#expiry.set(snapshot.id, timer);
  }
  #prune() {
    for (const [id, snapshot] of this.#snapshots)
      if (snapshot.expiresAt <= Date.now()) this.#remove(id);
  }
}
