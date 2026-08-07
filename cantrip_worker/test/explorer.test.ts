import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listExplorerDirectory, readExplorerFile } from "../src/explorer.js";

const directories: string[] = [];

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

    const directory = await listExplorerDirectory(root, "");
    expect(directory.entries.map(({ name }) => name)).toEqual([
      "src",
      "image.png",
      "README.md",
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
      viewable: false,
      markdown: false,
    });
    await expect(readExplorerFile(root, "README.md")).resolves.toMatchObject({
      content: "# Explorer\n",
      markdown: true,
    });
    await expect(readExplorerFile(root, "image.png")).rejects.toThrow(
      "not available for preview",
    );
  });

  it("rejects traversal and symbolic-link escapes", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "cantrip-explorer-test-"));
    directories.push(parent);
    const root = path.join(parent, "project");
    const outside = path.join(parent, "outside.txt");
    await mkdir(root);
    await writeFile(outside, "private\n");
    await symlink(outside, path.join(root, "linked.txt"));

    await expect(readExplorerFile(root, "../outside.txt")).rejects.toThrow(
      "traversal",
    );
    await expect(readExplorerFile(root, "linked.txt")).rejects.toThrow(
      "does not follow symbolic links",
    );
  });
});
