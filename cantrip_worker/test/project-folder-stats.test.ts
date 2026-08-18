import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readProjectFolderStats } from "../src/project-folder-stats.js";

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

  it("returns a bounded partial result instead of failing the project", async () => {
    const root = await temporaryDirectory("bounded");
    await Promise.all([
      writeFile(path.join(root, "one.txt"), "one\n"),
      writeFile(path.join(root, "two.txt"), "two\n"),
    ]);

    await expect(
      readProjectFolderStats(root, { files: 1 }),
    ).resolves.toMatchObject({
      kind: "folder",
      fileCount: 1,
      excludedFileCount: 1,
      truncated: true,
    });
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
});
