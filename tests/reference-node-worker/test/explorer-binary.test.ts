import {
  mkdtemp,
  open,
  writeFile,
  rm,
  symlink,
  rename,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { readExplorerBinaryFile } from "../src/explorer.js";
import { BinaryFileChangedError } from "../src/explorer-binary.js";
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-binary-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("reads a sparse one-GiB binary file in bounded ranges", async () => {
  const root = await fixture(),
    file = await open(path.join(root, "large.nbt"), "w+");
  try {
    await file.truncate(1024 ** 3);
    await file.write(Buffer.from([0, 255, 12, 128]), 0, 4, 1024 ** 3 - 4);
  } finally {
    await file.close();
  }
  const first = await readExplorerBinaryFile(root, "large.nbt", 0, 1);
  expect(first.size).toBe(1024 ** 3);
  expect(first.data).toBe("AA==");
  const tail = await readExplorerBinaryFile(
    root,
    "large.nbt",
    1024 ** 3 - 4,
    256 * 1024,
    first.version,
  );
  expect(Buffer.from(tail.data, "base64")).toEqual(
    Buffer.from([0, 255, 12, 128]),
  );
  expect(tail.eof).toBe(true);
});
it("rejects a changed revision even if modification time and size are restored", async () => {
  const root = await fixture(),
    file = path.join(root, "file.nbt");
  await writeFile(file, Buffer.from([1, 2, 3]));
  const first = await readExplorerBinaryFile(root, "file.nbt", 0, 1);
  const handle = await open(file, "r");
  const original = await handle.stat();
  await handle.close();
  await writeFile(file, Buffer.from([3, 2, 1]));
  await utimes(file, original.atime, original.mtime);
  await expect(
    readExplorerBinaryFile(root, "file.nbt", 1, 1, first.version),
  ).rejects.toBeInstanceOf(BinaryFileChangedError);
});
it("rejects replacement files and preserves empty-file semantics", async () => {
  const root = await fixture(),
    file = path.join(root, "file.nbt");
  await writeFile(file, Buffer.alloc(0));
  const first = await readExplorerBinaryFile(root, "file.nbt", 0, 1);
  expect(first).toMatchObject({ size: 0, eof: true, data: "", nextOffset: 0 });
  await writeFile(path.join(root, "new.nbt"), Buffer.alloc(0));
  await rename(path.join(root, "new.nbt"), file);
  await expect(
    readExplorerBinaryFile(root, "file.nbt", 0, 1, first.version),
  ).rejects.toBeInstanceOf(BinaryFileChangedError);
});
it("retains project-relative paths and follows deliberately linked files", async () => {
  const root = await fixture(),
    outside = await fixture();
  await writeFile(path.join(outside, "private.nbt"), Buffer.from([1]));
  try {
    await symlink(
      path.join(outside, "private.nbt"),
      path.join(root, "escape.nbt"),
    );
    expect((await readExplorerBinaryFile(root, "escape.nbt", 0, 1)).data).toBe(
      "AQ==",
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM"))
      throw error;
  }
  await expect(
    readExplorerBinaryFile(root, "../private.nbt", 0, 1),
  ).rejects.toThrow();
  await expect(readExplorerBinaryFile(root, ".", 0, 1)).rejects.toThrow();
});
it("requires the pinned version for nonzero ranges", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "file.nbt"), Buffer.from([1, 2]));
  await expect(
    readExplorerBinaryFile(root, "file.nbt", 1, 1),
  ).rejects.toThrow();
});
