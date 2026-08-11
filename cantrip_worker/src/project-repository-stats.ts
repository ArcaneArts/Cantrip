import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  projectRepositoryStatsSchema,
  type ProjectRepositoryStats,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_SCANNED_BYTES = 256 * 1024 * 1024;
const MAX_SCANNED_FILES = 50_000;
const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;
const SCAN_CONCURRENCY = 16;

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: 30_000,
  });
  return stdout.trimEnd();
}

function textLineCount(content: Buffer): number | null {
  if (content.includes(0)) return null;
  if (content.length === 0) return 0;
  let lines = content.at(-1) === 10 ? 0 : 1;
  for (const byte of content) {
    if (byte === 10) lines += 1;
  }
  return lines;
}

export async function readProjectRepositoryStats(
  cwd: string,
): Promise<ProjectRepositoryStats> {
  const [commitCountText, trackedPathsText] = await Promise.all([
    gitOutput(cwd, ["rev-list", "--count", "--all"]),
    gitOutput(cwd, ["ls-files", "--cached", "-z"]),
  ]);
  const trackedPaths = trackedPathsText.split("\0").filter(Boolean);
  const root = path.resolve(cwd);
  const scanPaths = trackedPaths.slice(0, MAX_SCANNED_FILES);
  let nextIndex = 0;
  let scannedBytes = 0;
  let textFileCount = 0;
  let lineCount = 0;
  let truncated = trackedPaths.length > scanPaths.length;

  const scanNext = async (): Promise<void> => {
    while (nextIndex < scanPaths.length) {
      const relativePath = scanPaths[nextIndex++]!;
      const absolutePath = path.resolve(root, relativePath);
      if (
        absolutePath === root ||
        !absolutePath.startsWith(`${root}${path.sep}`)
      ) {
        truncated = true;
        continue;
      }
      try {
        const stat = await lstat(absolutePath);
        if (!stat.isFile()) continue;
        if (
          stat.size > MAX_SINGLE_FILE_BYTES ||
          scannedBytes + stat.size > MAX_SCANNED_BYTES
        ) {
          truncated = true;
          continue;
        }
        scannedBytes += stat.size;
        const lines = textLineCount(await readFile(absolutePath));
        if (lines === null) continue;
        textFileCount += 1;
        lineCount += lines;
      } catch {
        truncated = true;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, scanPaths.length) }, () =>
      scanNext(),
    ),
  );

  return projectRepositoryStatsSchema.parse({
    commitCount: Number.parseInt(commitCountText, 10) || 0,
    trackedFileCount: trackedPaths.length,
    textFileCount,
    lineCount,
    excludedFileCount: trackedPaths.length - textFileCount,
    truncated,
  });
}
