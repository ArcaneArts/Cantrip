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
  const check = () => {
    if (closed) throw new NbtStorageError("NBT page store is closed.");
  };
  return {
    async get(key) {
      check();
      try {
        const file = await (
          await directory.getFileHandle(pageKey(key))
        ).getFile();
        if (file.size > NBT_PAGE_BYTES + 64)
          throw new NbtStorageError(
            "Encrypted NBT cache page exceeds its byte budget.",
          );
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async set(key, bytes) {
      check();
      const file = await directory.getFileHandle(pageKey(key), {
          create: true,
        }),
        writer = await file.createWritable();
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
      if (remove)
        try {
          await parent.removeEntry(id, { recursive: true });
        } catch (error) {
          if (!missing(error)) throw error;
        }
    },
  };
}
