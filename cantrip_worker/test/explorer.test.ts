import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  listExplorerDirectoryCommits,
  listExplorerDirectory,
  readExplorerFile,
  readExplorerMediaFile,
  statExplorerMediaFile,
  writeExplorerFile,
} from "../src/explorer.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("project explorer", () => {
  it("lists folders and reads supported UTF-8 text files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-explorer-test-"));
    directories.push(root);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "README.md"), "# Explorer\n");
    await writeFile(path.join(root, "image.png"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, "sound.mp3"), Buffer.from([3, 4]));
    await writeFile(path.join(root, "video.mp4"), Buffer.from([5, 6, 7]));

    const directory = await listExplorerDirectory(root, "");
    expect(directory.entries.map(({ name }) => name)).toEqual([
      "src",
      "image.png",
      "README.md",
      "sound.mp3",
      "video.mp4",
    ]);
    expect(
      directory.entries.find(({ name }) => name === "README.md"),
    ).toMatchObject({
      viewable: true,
      markdown: true,
    });
    expect(
      directory.entries.find(({ name }) => name === "image.png"),
    ).toMatchObject({
      viewable: true,
      markdown: false,
    });
    expect(
      directory.entries.find(({ name }) => name === "sound.mp3"),
    ).toMatchObject({ viewable: true });
    expect(
      directory.entries.find(({ name }) => name === "video.mp4"),
    ).toMatchObject({ viewable: true });
    const original = await readExplorerFile(root, "README.md");
    expect(original).toMatchObject({
      content: "# Explorer\n",
      markdown: true,
    });
    expect(original.version).toMatch(/^[a-f0-9]{64}$/u);
    const saved = await writeExplorerFile(
      root,
      "README.md",
      "# Updated\n",
      original.version,
    );
    expect(saved.content).toBe("# Updated\n");
    expect(saved.version).not.toBe(original.version);
    await expect(readFile(path.join(root, "README.md"), "utf8")).resolves.toBe(
      "# Updated\n",
    );
    await expect(
      writeExplorerFile(root, "README.md", "# Stale\n", original.version),
    ).rejects.toThrow("changed on disk");
    await expect(readExplorerFile(root, "image.png")).rejects.toThrow(
      "not available for preview",
    );
    await expect(
      statExplorerMediaFile(root, "image.png"),
    ).resolves.toMatchObject({
      path: "image.png",
      kind: "image",
      mimeType: "image/png",
      size: 3,
    });
    const firstChunk = await readExplorerMediaFile(root, "image.png", 0, 2);
    expect(Buffer.from(firstChunk.data, "base64")).toEqual(Buffer.from([0, 1]));
    expect(firstChunk).toMatchObject({ offset: 0, eof: false, size: 3 });
    const finalChunk = await readExplorerMediaFile(root, "image.png", 2, 2);
    expect(Buffer.from(finalChunk.data, "base64")).toEqual(Buffer.from([2]));
    expect(finalChunk).toMatchObject({ offset: 2, eof: true, size: 3 });
  });

  it("rejects path traversal while following symbolic links", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "cantrip-explorer-test-"));
    directories.push(parent);
    const root = path.join(parent, "project");
    const outside = path.join(parent, "outside.txt");
    const outsideDirectory = path.join(parent, "shared");
    await mkdir(root);
    await mkdir(outsideDirectory);
    await writeFile(outside, "private\n");
    await writeFile(path.join(outsideDirectory, "nested.md"), "# Shared\n");
    await symlink(outside, path.join(root, "linked.txt"));
    await symlink(outsideDirectory, path.join(root, "linked-directory"));
    await symlink(path.join(parent, "missing"), path.join(root, "broken"));

    await expect(readExplorerFile(root, "../outside.txt")).rejects.toThrow(
      "traversal",
    );
    await expect(readExplorerFile(root, "linked.txt")).resolves.toMatchObject({
      content: "private\n",
      path: "linked.txt",
    });
    await expect(
      listExplorerDirectory(root, "linked-directory"),
    ).resolves.toMatchObject({
      path: "linked-directory",
      entries: [
        expect.objectContaining({
          kind: "file",
          name: "nested.md",
          path: "linked-directory/nested.md",
        }),
      ],
    });
    const directory = await listExplorerDirectory(root, "");
    expect(
      directory.entries.find(({ name }) => name === "linked-directory"),
    ).toMatchObject({ kind: "directory", symbolicLink: true });
    expect(
      directory.entries.find(({ name }) => name === "linked.txt"),
    ).toMatchObject({ kind: "file", symbolicLink: true, viewable: true });
    expect(
      directory.entries.find(({ name }) => name === "broken"),
    ).toMatchObject({ kind: "other", symbolicLink: true, viewable: false });
    await expect(
      readExplorerMediaFile(root, "../outside.png", 0, 1),
    ).rejects.toThrow("traversal");
    await expect(
      writeExplorerFile(root, "../outside.txt", "overwrite\n", "a".repeat(64)),
    ).rejects.toThrow("traversal");
    const linked = await readExplorerFile(root, "linked.txt");
    await expect(
      writeExplorerFile(root, "linked.txt", "updated\n", linked.version),
    ).resolves.toMatchObject({ content: "updated\n" });
    await expect(readFile(outside, "utf8")).resolves.toBe("updated\n");
  });

  it("hydrates immediate entries with one newest-first history scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-explorer-test-"));
    directories.push(root);
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.name", "Cantrip Test"]);
    await git(root, ["config", "user.email", "cantrip@example.com"]);
    await mkdir(path.join(root, "dir one", "nested"), { recursive: true });
    await writeFile(path.join(root, "dir one", "original file.txt"), "one\n");
    await writeFile(
      path.join(root, "dir one", "nested", "inside.txt"),
      "one\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "--quiet", "-m", "initial files"]);

    await writeFile(
      path.join(root, "dir one", "nested", "inside.txt"),
      "two\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "--quiet", "-m", "update nested directory"]);
    await git(root, [
      "mv",
      "dir one/original file.txt",
      "dir one/renamed file.txt",
    ]);
    await git(root, ["commit", "--quiet", "-m", "rename spaced file"]);
    await writeFile(
      path.join(root, "dir one", "untracked file.txt"),
      "local\n",
    );

    const nested = await listExplorerDirectoryCommits(root, "dir one");
    expect(nested.available).toBe(true);
    expect(nested.entries).toHaveLength(3);
    expect(
      nested.entries.find(({ path: entryPath }) =>
        entryPath.endsWith("renamed file.txt"),
      ),
    ).toMatchObject({
      tracked: true,
      lastCommit: { subject: "rename spaced file" },
    });
    expect(
      nested.entries.find(({ path: entryPath }) =>
        entryPath.endsWith("nested"),
      ),
    ).toMatchObject({
      tracked: true,
      lastCommit: { subject: "update nested directory" },
    });
    expect(
      nested.entries.find(({ path: entryPath }) =>
        entryPath.endsWith("untracked file.txt"),
      ),
    ).toMatchObject({ tracked: false, lastCommit: null });

    const topLevel = await listExplorerDirectoryCommits(root, "");
    expect(topLevel.entries).toEqual([
      expect.objectContaining({
        path: "dir one",
        tracked: true,
        lastCommit: expect.objectContaining({ subject: "rename spaced file" }),
      }),
    ]);
  });

  it("returns unavailable metadata for non-Git and unborn directories", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "cantrip-explorer-test-"));
    directories.push(plain);
    await writeFile(path.join(plain, "plain.txt"), "plain\n");
    await expect(listExplorerDirectoryCommits(plain, "")).resolves.toEqual({
      path: "",
      available: false,
      entries: [],
    });

    const unborn = await mkdtemp(path.join(tmpdir(), "cantrip-explorer-test-"));
    directories.push(unborn);
    await git(unborn, ["init", "--quiet"]);
    await writeFile(path.join(unborn, "unborn.txt"), "unborn\n");
    await expect(listExplorerDirectoryCommits(unborn, "")).resolves.toEqual({
      path: "",
      available: false,
      entries: [],
    });
  });
});
