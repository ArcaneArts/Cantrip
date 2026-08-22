import type { Dir, Dirent, Stats } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  type FileHandle,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  readProjectFolderStats,
  type ProjectFolderStatsRuntime,
} from "../src/project-folder-stats.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), `cantrip-folder-stats-${label}-`),
  );
  directories.push(directory);
  return directory;
}

function virtualStats(kind: "directory" | "file"): Stats {
  return {
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
    size: 0,
  } as Stats;
}

function virtualFileHandle(): FileHandle {
  return {
    close: async () => undefined,
    stat: async () => virtualStats("file"),
  } as unknown as FileHandle;
}

interface VirtualFolderFixture {
  peakHeapBytes(): number;
  runtime: ProjectFolderStatsRuntime;
  yieldedEntries(): number;
}

function virtualFolderFixture(
  root: string,
  totalEntries: number,
  options: {
    beforeEntry?: () => Promise<void>;
    now?: () => number;
  } = {},
): VirtualFolderFixture {
  let closed = false;
  let entryIndex = 0;
  let peakHeapBytes = process.memoryUsage().heapUsed;
  const directory = {
    async close() {
      closed = true;
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<Dirent> {
      return {
        async next(): Promise<IteratorResult<Dirent>> {
          if (closed || entryIndex >= totalEntries) {
            return { done: true, value: undefined };
          }
          await options.beforeEntry?.();
          const currentIndex = entryIndex++;
          if (currentIndex % 1_000 === 0) {
            peakHeapBytes = Math.max(
              peakHeapBytes,
              process.memoryUsage().heapUsed,
            );
          }
          return {
            done: false,
            value: {
              isDirectory: () => false,
              isFile: () => true,
              isSymbolicLink: () => false,
              name: `file-${currentIndex}.txt`,
            } as unknown as Dirent,
          };
        },
        async return(): Promise<IteratorResult<Dirent>> {
          closed = true;
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  } as unknown as Dir;

  return {
    peakHeapBytes: () => peakHeapBytes,
    runtime: {
      lstat: async (filePath) =>
        virtualStats(filePath === root ? "directory" : "file"),
      now: options.now ?? Date.now,
      openDirectory: async () => directory,
      openFile: async () => virtualFileHandle(),
      realpath: async (filePath) => filePath,
    },
    yieldedEntries: () => entryIndex,
  };
}

describe("project folder statistics", () => {
  it("counts regular files and excludes Git metadata and binary content", async () => {
    const root = await temporaryDirectory("counts");
    await mkdir(path.join(root, "nested"));
    await mkdir(path.join(root, ".git"));
    await Promise.all([
      writeFile(path.join(root, "empty.txt"), ""),
      writeFile(path.join(root, "nested", "text.txt"), "one\ntwo\n"),
      writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2])),
      writeFile(path.join(root, ".git", "config"), "secret\n"),
    ]);

    await expect(readProjectFolderStats(root)).resolves.toEqual({
      kind: "folder",
      fileCount: 3,
      byteCount: 11,
      textFileCount: 2,
      lineCount: 2,
      excludedFileCount: 2,
      truncated: false,
    });
  });

  it("never follows file or directory symlinks outside the root", async () => {
    const root = await temporaryDirectory("root");
    const outside = await temporaryDirectory("outside");
    await writeFile(path.join(outside, "outside.txt"), "outside\n");
    await symlink(outside, path.join(root, "linked-directory"), "dir");
    await symlink(
      path.join(outside, "outside.txt"),
      path.join(root, "linked-file.txt"),
    );

    await expect(readProjectFolderStats(root)).resolves.toEqual({
      kind: "folder",
      fileCount: 0,
      byteCount: 0,
      textFileCount: 0,
      lineCount: 0,
      excludedFileCount: 2,
      truncated: false,
    });
  });

  it("counts every file when the content scan budget is exhausted", async () => {
    const root = await temporaryDirectory("bounded");
    await Promise.all([
      writeFile(path.join(root, "one.txt"), "one\n"),
      writeFile(path.join(root, "two.txt"), "two\n"),
    ]);

    await expect(
      readProjectFolderStats(root, { scannedFiles: 1 }),
    ).resolves.toMatchObject({
      kind: "folder",
      fileCount: 2,
      excludedFileCount: 1,
      truncated: true,
    });
  });

  it("stops directory enumeration at the discovered entry budget", async () => {
    const root = await temporaryDirectory("entry-budget");
    await Promise.all([
      writeFile(path.join(root, "one.txt"), "one\n"),
      writeFile(path.join(root, "two.txt"), "two\n"),
      writeFile(path.join(root, "three.txt"), "six\n"),
    ]);

    await expect(
      readProjectFolderStats(root, {
        discoveredEntries: 1,
        scannedFiles: 1,
      }),
    ).resolves.toMatchObject({
      kind: "folder",
      fileCount: 1,
      excludedFileCount: 1,
      truncated: true,
    });
  });

  it("does not queue subtrees past the discovered directory budget", async () => {
    const root = await temporaryDirectory("directory-budget");
    await Promise.all([
      mkdir(path.join(root, "one")),
      mkdir(path.join(root, "two")),
      writeFile(path.join(root, "root.txt"), "root\n"),
    ]);
    await Promise.all([
      writeFile(path.join(root, "one", "nested.txt"), "one\n"),
      writeFile(path.join(root, "two", "nested.txt"), "two\n"),
    ]);

    await expect(
      readProjectFolderStats(root, { discoveredDirectories: 1 }),
    ).resolves.toEqual({
      kind: "folder",
      fileCount: 1,
      byteCount: 5,
      textFileCount: 1,
      lineCount: 1,
      excludedFileCount: 2,
      truncated: true,
    });
  });

  it("enforces the deadline while a slow directory is yielding entries", async () => {
    const root = path.resolve("virtual-slow-project");
    let clock = 0;
    const fixture = virtualFolderFixture(root, 1_000, {
      beforeEntry: async () => {
        await delay(5);
        clock += 10;
      },
      now: () => clock,
    });
    const startedAt = performance.now();

    const result = await readProjectFolderStats(
      root,
      {
        discoveredEntries: 1_000,
        durationMs: 25,
        scannedFiles: 0,
      },
      fixture.runtime,
    );
    const durationMs = performance.now() - startedAt;

    expect(result).toMatchObject({
      fileCount: 2,
      excludedFileCount: 3,
      truncated: true,
    });
    expect(fixture.yieldedEntries()).toBe(3);
    expect(durationMs).toBeLessThan(250);
  });

  it("refuses a symlink root without reading its target", async () => {
    const parent = await temporaryDirectory("symlink-parent");
    const outside = await temporaryDirectory("symlink-outside");
    const linkedRoot = path.join(parent, "root");
    await writeFile(path.join(outside, "outside.txt"), "outside\n");
    await symlink(outside, linkedRoot, "dir");

    await expect(readProjectFolderStats(linkedRoot)).resolves.toMatchObject({
      kind: "folder",
      fileCount: 0,
      byteCount: 0,
      truncated: true,
    });
  });

  it.skipIf(process.env.CANTRIP_BENCHMARK_FOLDER_STATS !== "1")(
    "benchmarks bounded traversal across 1K, 100K, and 1M virtual files",
    async () => {
      const maximumEntries = 100_000;
      const results: Array<Record<string, number>> = [];

      for (const fixtureFiles of [1_000, 100_000, 1_000_000]) {
        const root = path.resolve(`virtual-scale-${fixtureFiles}`);
        const fixture = virtualFolderFixture(root, fixtureFiles);
        const startingHeapBytes = process.memoryUsage().heapUsed;
        const startedAt = performance.now();
        const result = await readProjectFolderStats(
          root,
          {
            discoveredDirectories: 1,
            discoveredEntries: maximumEntries,
            durationMs: 60_000,
            scannedFiles: 0,
          },
          fixture.runtime,
        );
        const durationMs = performance.now() - startedAt;
        const expectedFiles = Math.min(fixtureFiles, maximumEntries);
        const cutoffProbe = fixtureFiles > maximumEntries ? 1 : 0;
        const peakHeapDeltaBytes = Math.max(
          0,
          fixture.peakHeapBytes() - startingHeapBytes,
        );

        expect(result.fileCount).toBe(expectedFiles);
        expect(result.excludedFileCount).toBe(expectedFiles + cutoffProbe);
        expect(fixture.yieldedEntries()).toBe(expectedFiles + cutoffProbe);
        expect(durationMs).toBeLessThan(5_000);
        expect(peakHeapDeltaBytes).toBeLessThan(128 * 1_024 * 1_024);
        results.push({
          durationMs,
          fixtureFiles,
          peakHeapDeltaBytes,
          traversedEntries: fixture.yieldedEntries(),
        });
      }

      console.info("project folder traversal benchmark", results);
    },
  );
});
