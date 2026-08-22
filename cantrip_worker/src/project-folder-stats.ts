import { constants, type Dir, type Stats } from "node:fs";
import {
  lstat,
  opendir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
  projectFolderStatsSchema,
  type ProjectFolderStats,
} from "@cantrip/protocol";

export interface ProjectFolderStatsLimits {
  concurrency: number;
  discoveredDirectories: number;
  discoveredEntries: number;
  durationMs: number;
  scannedFiles: number;
  singleTextFileBytes: number;
  textBytes: number;
}

export interface ProjectFolderStatsRuntime {
  lstat(filePath: string): Promise<Stats>;
  now(): number;
  openDirectory(directoryPath: string): Promise<Dir>;
  openFile(filePath: string, flags: number): Promise<FileHandle>;
  realpath(filePath: string): Promise<string>;
}

const DEFAULT_LIMITS: ProjectFolderStatsLimits = {
  concurrency: 16,
  discoveredDirectories: 10_000,
  discoveredEntries: 100_000,
  durationMs: 10_000,
  scannedFiles: 50_000,
  singleTextFileBytes: 8 * 1_024 * 1_024,
  textBytes: 256 * 1_024 * 1_024,
};

const DEFAULT_RUNTIME: ProjectFolderStatsRuntime = {
  lstat: (filePath) => lstat(filePath),
  now: Date.now,
  openDirectory: (directoryPath) => opendir(directoryPath),
  openFile: (filePath, flags) => open(filePath, flags),
  realpath: (filePath) => realpath(filePath),
};

function boundedCount(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function lineCount(content: Buffer): number | null {
  if (content.includes(0)) return null;
  if (content.length === 0) return 0;
  let lines = content.at(-1) === 10 ? 0 : 1;
  for (const byte of content) {
    if (byte === 10) lines += 1;
  }
  return lines;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function emptyTruncatedStats(): ProjectFolderStats {
  return projectFolderStatsSchema.parse({
    kind: "folder",
    fileCount: 0,
    byteCount: 0,
    textFileCount: 0,
    lineCount: 0,
    excludedFileCount: 1,
    truncated: true,
  });
}

export async function readProjectFolderStats(
  requestedRoot: string,
  overrides: Partial<ProjectFolderStatsLimits> = {},
  runtime: ProjectFolderStatsRuntime = DEFAULT_RUNTIME,
): Promise<ProjectFolderStats> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const concurrency = Math.min(32, Math.max(1, limits.concurrency));
  const maximumDirectories = boundedCount(limits.discoveredDirectories);
  const maximumEntries = boundedCount(limits.discoveredEntries);
  const maximumScannedFiles = boundedCount(limits.scannedFiles);
  const startedAt = runtime.now();
  const expired = () => runtime.now() - startedAt >= limits.durationMs;

  let root: string;
  try {
    const requested = path.resolve(requestedRoot);
    const requestedStat = await runtime.lstat(requested);
    if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
      return emptyTruncatedStats();
    }
    root = await runtime.realpath(requested);
    if (expired()) return emptyTruncatedStats();
  } catch {
    return emptyTruncatedStats();
  }

  const directories = maximumDirectories === 0 ? [] : [root];
  const files: string[] = [];
  let directoryIndex = 0;
  let discoveredEntries = 0;
  let fileCount = 0;
  let excludedFileCount = 0;
  let truncated = maximumDirectories === 0;
  let discoveryStopped = maximumDirectories === 0;
  if (discoveryStopped) excludedFileCount += 1;

  const stopDiscovery = (): void => {
    if (!discoveryStopped) excludedFileCount += 1;
    discoveryStopped = true;
    truncated = true;
  };

  while (directoryIndex < directories.length && !discoveryStopped) {
    if (expired() || discoveredEntries >= maximumEntries) {
      stopDiscovery();
      break;
    }
    const directoryPath = directories[directoryIndex++]!;
    try {
      const canonicalDirectory = await runtime.realpath(directoryPath);
      if (expired()) {
        stopDiscovery();
        break;
      }
      if (
        canonicalDirectory !== directoryPath ||
        !isInside(canonicalDirectory, root)
      ) {
        excludedFileCount += 1;
        truncated = true;
        continue;
      }
      const directory = await runtime.openDirectory(directoryPath);
      if (expired()) {
        stopDiscovery();
        await directory.close().catch(() => undefined);
        break;
      }
      for await (const entry of directory) {
        if (expired() || discoveredEntries >= maximumEntries) {
          stopDiscovery();
          break;
        }
        discoveredEntries += 1;
        if (entry.name === ".git") {
          excludedFileCount += 1;
          continue;
        }
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) {
          excludedFileCount += 1;
        } else if (entry.isDirectory()) {
          if (directories.length >= maximumDirectories) {
            excludedFileCount += 1;
            truncated = true;
          } else {
            directories.push(entryPath);
          }
        } else if (entry.isFile()) {
          fileCount += 1;
          if (files.length >= maximumScannedFiles) {
            excludedFileCount += 1;
            truncated = true;
          } else {
            files.push(entryPath);
          }
        } else {
          excludedFileCount += 1;
        }
      }
    } catch {
      excludedFileCount += 1;
      truncated = true;
    }
  }

  let nextFile = 0;
  let scannedTextBytes = 0;
  let byteCount = 0;
  let textFileCount = 0;
  let totalLineCount = 0;

  const scanNext = async (): Promise<void> => {
    while (nextFile < files.length) {
      if (expired()) {
        truncated = true;
        return;
      }
      const filePath = files[nextFile++]!;
      try {
        const before = await runtime.lstat(filePath);
        if (!before.isFile() || before.isSymbolicLink()) {
          excludedFileCount += 1;
          continue;
        }
        const canonicalFile = await runtime.realpath(filePath);
        if (!isInside(canonicalFile, root)) {
          excludedFileCount += 1;
          truncated = true;
          continue;
        }
        const handle = await runtime.openFile(
          filePath,
          constants.O_RDONLY |
            (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || !Number.isSafeInteger(stat.size)) {
            excludedFileCount += 1;
            truncated = true;
            continue;
          }
          if (byteCount > Number.MAX_SAFE_INTEGER - stat.size) {
            byteCount = Number.MAX_SAFE_INTEGER;
            truncated = true;
          } else {
            byteCount += stat.size;
          }
          if (
            stat.size > limits.singleTextFileBytes ||
            scannedTextBytes + stat.size > limits.textBytes
          ) {
            excludedFileCount += 1;
            truncated = true;
            continue;
          }
          scannedTextBytes += stat.size;
          const content = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < content.length) {
            const { bytesRead } = await handle.read(
              content,
              offset,
              content.length - offset,
              offset,
            );
            if (bytesRead === 0) break;
            offset += bytesRead;
          }
          if (offset !== content.length) {
            excludedFileCount += 1;
            truncated = true;
            continue;
          }
          const lines = lineCount(content);
          if (lines === null) {
            excludedFileCount += 1;
            continue;
          }
          textFileCount += 1;
          totalLineCount += lines;
        } finally {
          await handle.close();
        }
      } catch {
        excludedFileCount += 1;
        truncated = true;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, () =>
      scanNext(),
    ),
  );
  if (nextFile < files.length) truncated = true;

  return projectFolderStatsSchema.parse({
    kind: "folder",
    fileCount,
    byteCount,
    textFileCount,
    lineCount: totalLineCount,
    excludedFileCount,
    truncated,
  });
}
