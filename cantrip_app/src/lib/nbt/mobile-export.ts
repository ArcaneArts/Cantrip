import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { NbtExportSink, OpenNbtExportSink } from "./export-copy";

const root = "nbt-exports";
function base64(bytes: Uint8Array) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 8192)
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
}

/** Explicit OS exports use the platform's shareable cache directory. This is
 * temporary export staging, never the document cache or recovery baseline. */
export const openMobileNbtExport: OpenNbtExportSink = async (name, signal) => {
  const directory = root + "/" + crypto.randomUUID(),
    path = directory + "/" + name;
  let closed = false,
    size = 0;
  const cleanup = async () => {
    closed = true;
    await Filesystem.rmdir({
      path: directory,
      directory: Directory.Cache,
      recursive: true,
    });
  };
  try {
    await Filesystem.writeFile({
      path,
      directory: Directory.Cache,
      recursive: true,
      data: "",
    });
    signal.throwIfAborted();
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
  return {
    completion:
      "Copy handed to the system share sheet. The original draft is retained.",
    async write(bytes) {
      if (closed) throw new Error("The device export is closed.");
      signal.throwIfAborted();
      if (!bytes.length || bytes.length > 256 * 1024)
        throw new Error("The device export requires bounded chunks.");
      await Filesystem.appendFile({
        path,
        directory: Directory.Cache,
        data: base64(bytes),
      });
      size += bytes.length;
    },
    async close(receipt) {
      if (closed) throw new Error("The device export is closed.");
      signal.throwIfAborted();
      const actual = await Filesystem.stat({
        path,
        directory: Directory.Cache,
      });
      if (size !== receipt.size || actual.size !== receipt.size)
        throw new Error("The device export size did not match.");
      const { uri } = await Filesystem.getUri({
        path,
        directory: Directory.Cache,
      });
      signal.throwIfAborted();
      let failed = false;
      try {
        await Share.share({
          title: name,
          dialogTitle: "Export NBT copy",
          files: [uri],
        });
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await cleanup().catch((error) => {
          if (!failed)
            throw new Error(
              "The copy was handed to the system, but temporary export cleanup failed.",
              { cause: error },
            );
        });
      }
    },
    async abort() {
      if (!closed) await cleanup();
    },
  } satisfies NbtExportSink;
};
