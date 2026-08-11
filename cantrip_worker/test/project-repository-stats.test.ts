import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readProjectRepositoryStats } from "../src/project-repository-stats.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function repository(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-project-stats-test-"),
  );
  directories.push(directory);
  await execFileAsync("git", ["-C", directory, "init"]);
  await execFileAsync("git", [
    "-C",
    directory,
    "config",
    "user.name",
    "Cantrip Test",
  ]);
  await execFileAsync("git", [
    "-C",
    directory,
    "config",
    "user.email",
    "cantrip@example.com",
  ]);
  return directory;
}

describe("project repository statistics", () => {
  it("counts commits and lines across tracked text files", async () => {
    const root = await repository();
    await Promise.all([
      writeFile(path.join(root, "with-newline.txt"), "one\ntwo\n"),
      writeFile(path.join(root, "without-newline.txt"), "three"),
      writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 3])),
      symlink("with-newline.txt", path.join(root, "linked.txt")),
    ]);
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "fixture"]);

    await expect(readProjectRepositoryStats(root)).resolves.toEqual({
      commitCount: 1,
      trackedFileCount: 4,
      textFileCount: 2,
      lineCount: 3,
      excludedFileCount: 2,
      truncated: false,
    });
  });

  it("returns zero counts for an empty repository", async () => {
    const root = await repository();

    await expect(readProjectRepositoryStats(root)).resolves.toEqual({
      commitCount: 0,
      trackedFileCount: 0,
      textFileCount: 0,
      lineCount: 0,
      excludedFileCount: 0,
      truncated: false,
    });
  });

  it("rejects a directory that is not a Git repository", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-not-a-repository-"),
    );
    directories.push(directory);

    await expect(readProjectRepositoryStats(directory)).rejects.toThrow();
  });
});
