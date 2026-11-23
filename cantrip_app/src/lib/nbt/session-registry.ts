import type { NbtDocumentClient } from "@cantrip/nbt/document";
import {
  NbtSaveController,
  type NbtBinaryTransport,
  type NbtSaveProgress,
} from "./save";
import { clearNbtSharedDocuments, nbtSharedDocument } from "./shared-document";

/** Runtime ownership is independent of the React view. Durable recovery is a separate store. */
export class NbtViewSession {
  private resolveWrite?: (path: string) => Promise<NbtBinaryTransport>;
  setTransportResolver(resolve: (path: string) => Promise<NbtBinaryTransport>) {
    this.resolveWrite = resolve;
  }
  private listeners = new Set<() => void>();
  private progress: NbtSaveProgress = { phase: "idle", uploaded: 0 };
  private saver?: NbtSaveController;
  private savePath?: string;
  private generation?: number;
  private seenRevision?: number;
  private logicalRevision = 0;
  observe() {
    const generation = this.client.getSnapshot()?.shared?.generation;
    const revision = this.client.getEditSnapshot()?.revision;
    if (generation !== this.generation || revision !== this.seenRevision)
      this.logicalRevision++;
    this.seenRevision = revision;
    if (generation === this.generation) return;
    this.generation = generation;
    this.saver = undefined;
    this.savePath = undefined;
    this.copy = undefined;
    this.progress = { phase: "idle", uploaded: 0 };
    this.emit();
  }
  get revision() {
    this.observe();
    return this.logicalRevision;
  }
  private copy?: {
    path: string;
    transport: NbtBinaryTransport;
    controller: NbtSaveController;
  };
  get pendingCopyPath() {
    const retained = this.client.getEditSnapshot()?.pendingSave?.target;
    return this.copy?.path ?? (retained?.copy ? retained.path : undefined);
  }
  async resumeCopy() {
    const copy = this.copy;
    if (copy) return this.saveAs(copy.path, copy.transport);
    const path = this.pendingCopyPath;
    if (!path || !this.resolveWrite)
      throw new Error("The pending Save As destination is unavailable.");
    return this.saveAs(path, await this.resolveWrite(path));
  }
  private saving = 0;
  private copying = false;
  private emit() {
    this.progress = { ...this.progress };
    for (const listener of this.listeners) listener();
  }
  get busy() {
    return this.saving > 0;
  }
  constructor(readonly client: NbtDocumentClient) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.progress;
  async save(path: string, transport: NbtBinaryTransport) {
    this.observe();
    const generation = this.generation;
    if (this.copying) throw new Error("Wait for Save As to finish.");
    if (this.copy) return this.saveAs(this.copy.path, transport);
    if (this.savePath && path !== this.savePath)
      throw new Error("This save belongs to another document.");
    this.savePath = path;
    this.saver ??= new NbtSaveController(
      this.client,
      path,
      transport,
      (progress) => {
        if (generation !== this.client.getSnapshot()?.shared?.generation)
          return;
        this.progress = progress;
        for (const listener of this.listeners) listener();
      },
    );
    this.saving++;
    this.progress = { phase: "preparing", uploaded: 0 };
    this.emit();
    try {
      return await this.saver.save();
    } finally {
      this.saving--;
      this.emit();
    }
  }
  async abandon() {
    if (this.busy) throw new Error("Wait for the current NBT save to finish.");
    if (!this.saver && !this.copy) {
      const retained = this.client.getEditSnapshot()?.pendingSave;
      if (retained) {
        if (!retained.target || !this.resolveWrite)
          throw new Error("The pending NBT save destination is unavailable.");
        const transport = await this.resolveWrite(retained.target.path);
        const controller = new NbtSaveController(
          this.client,
          retained.target.path,
          transport,
          undefined,
          { copy: retained.target.copy },
        );
        await controller.abandon();
      }
    }
    await this.saver?.abandon();
    await this.copy?.controller.abandon();
    this.copy = undefined;
  }
  async saveAs(path: string, transport: NbtBinaryTransport) {
    this.observe();
    const generation = this.generation;
    if (this.busy) throw new Error("Wait for the current NBT save to finish.");
    if (this.copy && this.copy.path !== path)
      throw new Error(
        "Retry the pending Save As before choosing another destination.",
      );
    this.saving++;
    this.copying = true;
    this.progress = { phase: "preparing", uploaded: 0 };
    this.emit();
    try {
      if (
        !this.saver &&
        !this.copy &&
        this.client.getEditSnapshot()?.pendingSave?.target?.copy === false
      )
        await this.abandonRetainedOriginal();
      await this.saver?.abandon();
      this.copy ??= {
        path,
        transport,
        controller: new NbtSaveController(
          this.client,
          path,
          transport,
          (progress) => {
            if (generation !== this.client.getSnapshot()?.shared?.generation)
              return;
            this.progress = progress;
            this.emit();
          },
          { copy: true },
        ),
      };
      const result = await this.copy.controller.save();
      if (generation === this.generation) this.copy = undefined;
      return result;
    } catch (error) {
      if (
        generation === this.generation &&
        !this.client.getEditSnapshot()?.pendingSaveId
      )
        this.copy = undefined;
      throw error;
    } finally {
      this.saving--;
      this.copying = false;
      this.emit();
    }
  }
  private async abandonRetainedOriginal() {
    const retained = this.client.getEditSnapshot()?.pendingSave;
    if (!retained?.target || retained.target.copy || !this.resolveWrite)
      throw new Error(
        "Reconcile the retained NBT save before choosing another destination.",
      );
    const controller = new NbtSaveController(
      this.client,
      retained.target.path,
      await this.resolveWrite(retained.target.path),
    );
    await controller.abandon();
  }
}
interface Entry {
  controller: AbortController;
  promise: Promise<NbtViewSession>;
  value?: NbtViewSession;
  leases: Map<object, boolean>;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?(): void;
  closed: boolean;
}
const sessions = new Map<string, Entry>();
function pause(entry: Entry) {
  if (entry.value)
    void entry.value.client
      .setPaused(![...entry.leases.values()].some(Boolean))
      .catch(() => {});
}
function collect(key: string, entry: Entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  if (entry.leases.size || entry.closed) return;
  entry.timer = setTimeout(() => {
    if (entry.leases.size || entry.closed) return;
    const status = entry.value?.client.getEditSnapshot();
    // Shared documents retain accepted edits in the durable encrypted journal;
    // detaching a facade must not keep an otherwise idle renderer worker alive.
    const shared = entry.value && nbtSharedDocument(entry.value.client);
    if (
      (!shared && status?.dirty) ||
      status?.editing ||
      status?.saving ||
      (!shared && status?.pendingSaveId) ||
      entry.value?.busy
    )
      return;
    void closeEntry(key, entry).catch(() => {});
  }, 0);
}
async function closeEntry(key: string, entry: Entry) {
  if (entry.closed) return;
  entry.closed = true;
  entry.controller.abort();
  if (entry.timer) clearTimeout(entry.timer);
  if (sessions.get(key) === entry) sessions.delete(key);
  entry.unsubscribe?.();
  const value = (await entry.promise.catch(() => undefined)) ?? entry.value;
  await value?.client.close();
}
export function acquireNbtSession(
  key: string,
  open: (
    signal: AbortSignal,
    onCreated: (client: NbtDocumentClient) => void,
  ) => Promise<NbtDocumentClient>,
  active: boolean,
) {
  let entry = sessions.get(key);
  if (!entry) {
    entry = {
      controller: new AbortController(),
      leases: new Map(),
      closed: false,
      promise: undefined!,
    };
    const created = entry;
    const register = (client: NbtDocumentClient) => {
      if (created.value) return created.value;
      const value = new NbtViewSession(client);
      created.value = value;
      if (created.closed) {
        return value;
      }
      const changed = () => {
        value.observe();
        collect(key, created);
      };
      const document = client.subscribe(changed),
        edits = client.subscribeEdits(changed),
        saves = value.subscribe(() => collect(key, created));
      created.unsubscribe = () => {
        edits();
        document();
        saves();
      };
      pause(created);
      collect(key, created);
      return value;
    };
    created.promise = open(created.controller.signal, register)
      .then(register)
      .catch((error) => {
        created.unsubscribe?.();
        if (sessions.get(key) === created) sessions.delete(key);
        throw error;
      });
    sessions.set(key, created);
  }
  const current = entry,
    token = {};
  current.leases.set(token, active);
  pause(current);
  return {
    promise: current.promise,
    setActive(value: boolean) {
      if (current.leases.has(token)) {
        current.leases.set(token, value);
        pause(current);
      }
    },
    release() {
      current.leases.delete(token);
      pause(current);
      collect(key, current);
    },
  };
}
export async function discardNbtSession(key: string) {
  const entry = sessions.get(key);
  if (!entry) return;
  const value = await entry.promise;
  const shared = nbtSharedDocument(value.client);
  if (shared) await shared.closeView();
  else {
    await value.abandon();
    await value.client.clearRecovery();
  }
  await closeEntry(key, entry);
}
/** Account invalidation releases plaintext regardless of detached React views. */
export async function clearNbtSessions() {
  // Each client terminates in finally. One rejected cache cleanup must not
  // prevent the other account-bound workers from releasing decrypted state.
  await Promise.allSettled(
    [...sessions].map(([key, entry]) => closeEntry(key, entry)),
  );
  await clearNbtSharedDocuments();
}
