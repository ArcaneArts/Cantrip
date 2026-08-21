import {
  DailyLogArchive,
  isManagedDailyLogFile,
  type DailyLogArchiveStorage,
} from "@cantrip/logging/archive";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { AsyncGzip, AsyncZipDeflate, Zip, ZipPassThrough } from "fflate";

const ARCHIVE_DIRECTORY = "logs/client";
const EXPORT_DIRECTORY = "cantrip-log-exports";
const ARCHIVE_ROOT = Directory.LibraryNoCloud;
const CHUNK_BYTES = 256 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function base64ToBytes(value: string | Blob): Uint8Array {
  if (typeof value !== "string") {
    throw new Error("Native log storage returned an unexpected binary value.");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function archivePath(name: string): string {
  if (name.includes("/") || name.includes("\\"))
    throw new Error("Archive file names cannot contain paths.");
  return `${ARCHIVE_DIRECTORY}/${name}`;
}

async function ignoreMissing(work: Promise<unknown>): Promise<void> {
  await work.catch(() => undefined);
}

async function streamNativeFile(
  path: string,
  directory: Directory,
  consume: (chunk: Uint8Array, final: boolean) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    void Filesystem.readFileInChunks(
      { chunkSize: CHUNK_BYTES, directory, path },
      (chunk, error) => {
        if (settled) return;
        if (error) {
          settled = true;
          reject(error);
          return;
        }
        if (chunk === null) {
          settled = true;
          consume(new Uint8Array(), true);
          resolve();
          return;
        }
        consume(base64ToBytes(chunk.data), false);
      },
    ).catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

export class CapacitorDailyLogArchiveStorage implements DailyLogArchiveStorage {
  async ensureDirectory(): Promise<void> {
    await Filesystem.mkdir({
      directory: ARCHIVE_ROOT,
      path: ARCHIVE_DIRECTORY,
      recursive: true,
    });
  }

  async list() {
    await this.ensureDirectory();
    const { files } = await Filesystem.readdir({
      directory: ARCHIVE_ROOT,
      path: ARCHIVE_DIRECTORY,
    });
    return files
      .filter((file) => file.type === "file")
      .map((file) => ({
        createdAtMs: file.ctime,
        modifiedAtMs: file.mtime,
        name: file.name,
        size: file.size,
      }));
  }

  async append(name: string, contents: Uint8Array): Promise<void> {
    await Filesystem.appendFile({
      data: bytesToBase64(contents),
      directory: ARCHIVE_ROOT,
      path: archivePath(name),
    });
  }

  async compress(
    source: string,
    temporary: string,
    level: number,
  ): Promise<void> {
    await Filesystem.writeFile({
      data: "",
      directory: ARCHIVE_ROOT,
      path: archivePath(temporary),
    });
    let writes = Promise.resolve();
    let resolveFinished!: () => void;
    let rejectFinished!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    const gzip = new AsyncGzip(
      { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 },
      (error, data, final) => {
        if (error) {
          rejectFinished(error);
          return;
        }
        if (data.byteLength > 0) {
          writes = writes.then(() =>
            Filesystem.appendFile({
              data: bytesToBase64(data),
              directory: ARCHIVE_ROOT,
              path: archivePath(temporary),
            }),
          );
        }
        if (final) void writes.then(resolveFinished, rejectFinished);
      },
    );
    await streamNativeFile(archivePath(source), ARCHIVE_ROOT, (chunk, final) =>
      gzip.push(chunk, final),
    );
    await finished;
  }

  async rename(source: string, destination: string): Promise<void> {
    await Filesystem.rename({
      directory: ARCHIVE_ROOT,
      from: archivePath(source),
      to: archivePath(destination),
    });
  }

  async remove(name: string): Promise<void> {
    await ignoreMissing(
      Filesystem.deleteFile({
        directory: ARCHIVE_ROOT,
        path: archivePath(name),
      }),
    );
  }
}

let archivePromise: Promise<DailyLogArchive | null> | null = null;

export function isMobileNativeRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Capacitor.isNativePlatform() &&
    !("__TAURI_INTERNALS__" in window)
  );
}

async function cleanupStaleExports(): Promise<void> {
  await Filesystem.mkdir({
    directory: Directory.Cache,
    path: EXPORT_DIRECTORY,
    recursive: true,
  });
  const { files } = await Filesystem.readdir({
    directory: Directory.Cache,
    path: EXPORT_DIRECTORY,
  });
  await Promise.all(
    files
      .filter(
        (file) =>
          file.type === "file" && file.name.startsWith("cantrip-client-logs-"),
      )
      .map((file) =>
        ignoreMissing(
          Filesystem.deleteFile({
            directory: Directory.Cache,
            path: `${EXPORT_DIRECTORY}/${file.name}`,
          }),
        ),
      ),
  );
}

export function initializeMobileClientLogArchive(): Promise<DailyLogArchive | null> {
  if (!isMobileNativeRuntime()) return Promise.resolve(null);
  return (archivePromise ??= (async () => {
    await cleanupStaleExports();
    const archive = new DailyLogArchive({
      source: "client",
      storage: new CapacitorDailyLogArchiveStorage(),
    });
    await archive.initialize();
    await App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void archive.maintain();
    });
    return archive;
  })().catch(() => null));
}

export function persistMobileClientLog(record: unknown): void {
  if (!isMobileNativeRuntime()) return;
  void initializeMobileClientLogArchive().then((archive) =>
    archive?.append(record),
  );
}

export async function exportMobileClientLogs(): Promise<void> {
  const archive = await initializeMobileClientLogArchive();
  if (!archive)
    throw new Error("Device log export is available only in the mobile app.");
  await archive.maintain();
  await archive.flush();
  const storage = new CapacitorDailyLogArchiveStorage();
  const entries = (await storage.list())
    .filter(({ name }) => isManagedDailyLogFile(name, "client"))
    .sort((left, right) => left.name.localeCompare(right.name));
  await cleanupStaleExports();
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const name = `cantrip-client-logs-${timestamp}.zip`;
  const outputPath = `${EXPORT_DIRECTORY}/${name}`;
  await Filesystem.writeFile({
    data: "",
    directory: Directory.Cache,
    path: outputPath,
  });

  let writes = Promise.resolve();
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  const zip = new Zip((error, data, final) => {
    if (error) {
      rejectFinished(error);
      return;
    }
    if (data.byteLength > 0) {
      writes = writes.then(() =>
        Filesystem.appendFile({
          data: bytesToBase64(data),
          directory: Directory.Cache,
          path: outputPath,
        }),
      );
    }
    if (final) void writes.then(resolveFinished, rejectFinished);
  });
  for (const entry of entries) {
    const stream = entry.name.endsWith(".gz")
      ? new ZipPassThrough(entry.name)
      : new AsyncZipDeflate(entry.name, { level: 9 });
    zip.add(stream);
    await streamNativeFile(
      archivePath(entry.name),
      ARCHIVE_ROOT,
      (chunk, final) => stream.push(chunk, final),
    );
  }
  zip.end();
  await finished;
  const { uri } = await Filesystem.getUri({
    directory: Directory.Cache,
    path: outputPath,
  });
  await Share.share({
    dialogTitle: "Export Cantrip device logs",
    files: [uri],
    title: "Cantrip device logs",
  });
}
