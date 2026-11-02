import {
  NBT_PAGE_BYTES,
  NbtStorageError,
  missing,
  pageKey,
  type NbtPageStore,
} from "./types.js";

type IterableDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};
interface SyncAccess {
  getSize(): number;
  read(bytes: Uint8Array, options: { at: number }): number;
  write(bytes: Uint8Array, options: { at: number }): number;
  close(): void;
}
type SyncFile = FileSystemFileHandle & {
  createSyncAccessHandle?(): Promise<SyncAccess>;
};
type OpenFile = { file: SyncFile; access?: SyncAccess };
export async function openOpfsNbtStore(
  id: string,
  root?: FileSystemDirectoryHandle,
): Promise<NbtPageStore> {
  const base = root ?? (await navigator.storage.getDirectory());
  const parent = await base.getDirectoryHandle("cantrip-nbt-cache-v1", {
    create: true,
  });
  const directory = await parent.getDirectoryHandle(id, { create: true });
  let closed = false;
  // Disposable encrypted pages do not need a durability flush on every write.
  // Keep a bounded set of worker-only handles instead of repeatedly opening
  // writable streams and committing a swap file for every new cache page.
  const handles = new Map<string, OpenFile>();
  const check = () => {
    if (closed) throw new NbtStorageError("NBT page store is closed.");
  };
  const release = (name: string, entry: OpenFile) => {
    entry.access?.close();
    handles.delete(name);
  };
  async function openFile(name: string, create: boolean): Promise<OpenFile> {
    const found = handles.get(name);
    if (found) {
      handles.delete(name);
      handles.set(name, found);
      return found;
    }
    const file: SyncFile = await directory.getFileHandle(name, { create });
    check();
    if (handles.size >= 16) {
      const [oldest, entry] = handles.entries().next().value!;
      release(oldest, entry);
    }
    let access: SyncAccess | undefined;
    try {
      access = await file.createSyncAccessHandle?.();
    } catch {
      // If synchronous access fails, still attempt the existing writable API.
    }
    if (closed) {
      access?.close();
      check();
    }
    const entry = { file, access };
    if (access) handles.set(name, entry);
    return entry;
  }
  return {
    async get(key) {
      check();
      try {
        const entry = await openFile(pageKey(key), false);
        if (!entry.access) {
          const file = await entry.file.getFile();
          if (file.size > NBT_PAGE_BYTES + 64)
            throw new NbtStorageError(
              "Encrypted NBT cache page exceeds its byte budget.",
            );
          return new Uint8Array(await file.arrayBuffer());
        }
        const size = entry.access.getSize();
        if (size > NBT_PAGE_BYTES + 64)
          throw new NbtStorageError(
            "Encrypted NBT cache page exceeds its byte budget.",
          );
        const bytes = new Uint8Array(size);
        for (let at = 0; at < size;) {
          const count = entry.access.read(bytes.subarray(at), { at });
          if (count <= 0 || count > size - at)
            throw new NbtStorageError(
              "Encrypted NBT cache page is incomplete.",
            );
          at += count;
        }
        return bytes;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async set(key, bytes) {
      check();
      const name = pageKey(key),
        entry = await openFile(name, true);
      if (entry.access && entry.access.getSize() === 0) {
        try {
          for (let at = 0; at < bytes.length;) {
            const count = entry.access.write(bytes.subarray(at), { at });
            if (count <= 0 || count > bytes.length - at)
              throw new NbtStorageError(
                "Encrypted NBT cache page write failed.",
              );
            at += count;
          }
          return;
        } catch (error) {
          try {
            release(name, entry);
          } catch {
            /* Retain the write error. */
          }
          // Never migrate an incomplete first write into fallback storage.
          await directory.removeEntry(name).catch(() => {});
          throw error;
        }
      }
      // Rewriting an existing page must retain the old committed ciphertext
      // if the update fails. Release its exclusive handle before the atomic
      // writable-stream replacement. Recovery journals use a separate store.
      release(name, entry);
      const writer = await entry.file.createWritable();
      try {
        await writer.write(bytes as Uint8Array<ArrayBuffer>);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
    },
    async *keys() {
      check();
      for await (const [name, entry] of (
        directory as IterableDirectory
      ).entries())
        if (entry.kind === "file" && name.startsWith("page-"))
          yield name.slice(5);
    },
    async close(remove = true) {
      if (closed) return;
      closed = true;
      let failure: unknown;
      for (const entry of handles.values()) {
        try {
          entry.access?.close();
        } catch (error) {
          failure ??= error;
        }
      }
      handles.clear();
      if (remove)
        try {
          await parent.removeEntry(id, { recursive: true });
        } catch (error) {
          if (!missing(error)) failure ??= error;
        }
      if (failure) throw failure;
    },
  };
}
