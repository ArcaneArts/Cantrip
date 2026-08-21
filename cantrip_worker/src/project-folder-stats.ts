import { constants } from "node:fs";
import { lstat, opendir, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  projectFolderStatsSchema,
  type ProjectFolderStats,
} from "@cantrip/protocol";

export interface ProjectFolderStatsLimits {
  concurrency: number;
  durationMs: number;
  scannedFiles: number;
  singleTextFileBytes: number;
  textBytes: number;
}

const DEFAULT_LIMITS: ProjectFolderStatsLimits = {
  concurrency: 16,
  durationMs: 10_000,
  scannedFiles: 50_000,
  singleTextFileBytes: 8 * 1_024 * 1_024,
  textBytes: 256 * 1_024 * 1_024,
};

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
): Promise<ProjectFolderStats> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const concurrency = Math.min(32, Math.max(1, limits.concurrency));
  const startedAt = Date.now();
  const expired = () => Date.now() - startedAt >= limits.durationMs;

  let root: string;
  try {
    const requested = path.resolve(requestedRoot);
    const requestedStat = await lstat(requested);
    if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
      return emptyTruncatedStats();
    }
    root = await realpath(requested);
  } catch {
    return emptyTruncatedStats();
  }

  const directories = [root];
  const files: string[] = [];
  let directoryIndex = 0;
  let fileCount = 0;
  let excludedFileCount = 0;
  let truncated = false;

  while (directoryIndex < directories.length) {
    const directoryPath = directories[directoryIndex++]!;
    try {
      const canonicalDirectory = await realpath(directoryPath);
      if (
        canonicalDirectory !== directoryPath ||
        !isInside(canonicalDirectory, root)
      ) {
        excludedFileCount += 1;
        truncated = true;
        continue;
      }
      const directory = await opendir(directoryPath);
      for await (const entry of directory) {
        if (entry.name === ".git") {
          excludedFileCount += 1;
          continue;
        }
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) {
          excludedFileCount += 1;
        } else if (entry.isDirectory()) {
          directories.push(entryPath);
        } else if (entry.isFile()) {
          fileCount += 1;
          if (files.length >= limits.scannedFiles) {
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
      const filePath = files[nextFile++]!;
      if (expired()) {
        truncated = true;
        return;
      }
      try {
        const before = await lstat(filePath);
        if (!before.isFile() || before.isSymbolicLink()) {
          excludedFileCount += 1;
          continue;
        }
        const canonicalFile = await realpath(filePath);
        if (!isInside(canonicalFile, root)) {
          excludedFileCount += 1;
          truncated = true;
          continue;
        }
        const handle = await open(
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
