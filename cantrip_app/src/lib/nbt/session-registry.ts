import type { NbtDocumentClient } from "@cantrip/nbt/document";
import {
  NbtSaveController,
  type NbtBinaryTransport,
  type NbtSaveProgress,
} from "./save";

/** Runtime ownership is independent of the React view. Durable recovery is a separate store. */
export class NbtViewSession {
  private listeners = new Set<() => void>();
  private progress: NbtSaveProgress = { phase: "idle", uploaded: 0 };
  private saver?: NbtSaveController;
  private savePath?: string;
  private copy?: {
    path: string;
    transport: NbtBinaryTransport;
    controller: NbtSaveController;
  };
  get pendingCopyPath() {
    return this.copy?.path;
  }
  resumeCopy() {
    const copy = this.copy;
    if (!copy) throw new Error("There is no pending Save As.");
    return this.saveAs(copy.path, copy.transport);
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
    await this.saver?.abandon();
    await this.copy?.controller.abandon();
    this.copy = undefined;
  }
  async saveAs(path: string, transport: NbtBinaryTransport) {
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
      await this.saver?.abandon();
      this.copy ??= {
        path,
        transport,
        controller: new NbtSaveController(
          this.client,
          path,
          transport,
          (progress) => {
            this.progress = progress;
            this.emit();
          },
          { copy: true },
        ),
      };
      const result = await this.copy.controller.save();
      this.copy = undefined;
      return result;
    } catch (error) {
      if (!this.client.getEditSnapshot()?.pendingSaveId) this.copy = undefined;
      throw error;
    } finally {
      this.saving--;
      this.copying = false;
      this.emit();
    }
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
  entry.timer = setTimeout(() => {
    if (entry.leases.size || entry.closed) return;
    const status = entry.value?.client.getEditSnapshot();
    // A detached draft or uncertain save still owns its worker and byte pages.
    if (
      status?.dirty ||
      status?.editing ||
      status?.saving ||
      status?.pendingSaveId ||
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
  const value = await entry.promise.catch(() => undefined);
  await value?.client.close();
}
export function acquireNbtSession(
  key: string,
  open: (signal: AbortSignal) => Promise<NbtDocumentClient>,
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
    created.promise = open(created.controller.signal)
      .then(async (client) => {
        const value = new NbtViewSession(client);
        created.value = value;
        if (created.closed) {
          return value;
        }
        const edits = client.subscribeEdits(() => collect(key, created)),
          saves = value.subscribe(() => collect(key, created));
        created.unsubscribe = () => {
          edits();
          saves();
        };
        pause(created);
        collect(key, created);
        return value;
      })
      .catch((error) => {
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
  await value.abandon();
  await closeEntry(key, entry);
}
/** Account invalidation releases plaintext regardless of detached React views. */
export async function clearNbtSessions() {
  await Promise.all(
    [...sessions].map(([key, entry]) => closeEntry(key, entry)),
  );
}
