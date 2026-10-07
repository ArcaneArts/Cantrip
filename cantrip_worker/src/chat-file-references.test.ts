import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { chatFileReferences } from "./chat-file-references.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-reference-tree-"));
  cleanup.push(root);
  await mkdir(path.join(root, "folder.ext"));
  await writeFile(path.join(root, "LICENSE"), "license");
  await writeFile(path.join(root, "folder.ext", "app.ts"), "app");
  return root;
}

describe("chat file reference metadata", () => {
  it("classifies actual files and directories, including dotted folders, extensionless files, and the root", async () => {
    const root = await fixture();
    const result = await chatFileReferences(root, [
      "folder.ext",
      "LICENSE",
      `${path.join(root, "folder.ext/app.ts")}:12`,
      pathToFileURL(path.join(root, "LICENSE")).href,
      ".",
      "missing.ts",
    ]);
    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "directory",
      "file",
      "file",
      "file",
      "directory",
      null,
    ]);
    expect(result.entries[2]!.path).toBe(path.join(root, "folder.ext/app.ts"));
    expect(result.entries[5]!.path).toBe(path.join(root, "missing.ts"));
    expect(result.entries).toHaveLength(6);
  });

  it("does not inspect paths outside the chat root or follow links out of it", async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(
      outside,
      path.join(root, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await chatFileReferences(root, [
      path.join(outside, "LICENSE"),
      "../other",
      "outside/LICENSE",
      "LICENSE",
    ]);
    expect(result.entries.map((entry) => entry.kind)).toEqual([
      null,
      null,
      null,
      "file",
    ]);
  });

  it("supports the canonical absolute paths on hosts whose temporary root is an alias", async () => {
    const root = await fixture();
    const canonical = await realpath(root);
    const result = await chatFileReferences(root, [
      path.join(canonical, "LICENSE"),
    ]);
    expect(result.entries[0]!.kind).toBe("file");
    expect(result.entries[0]!.path).toBe(path.join(root, "LICENSE"));
  });
});
