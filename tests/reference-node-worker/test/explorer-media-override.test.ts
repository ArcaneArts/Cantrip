import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readExplorerMediaFile } from "../src/explorer.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-forced-media-"));
  directories.push(root);
  return root;
}
const media = { kind: "image" as const, mimeType: "image/png" };
it("reads explicitly selected media regardless of filename, preserving chunk boundaries", async () => {
  const root = await fixture(),
    bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  await writeFile(path.join(root, "opaque.xyz"), bytes);
  await expect(readExplorerMediaFile(root, "opaque.xyz", 0, 4)).rejects.toThrow(
    "not available as media",
  );
  const first = await readExplorerMediaFile(root, "opaque.xyz", 0, 4, media);
  const second = await readExplorerMediaFile(root, "opaque.xyz", 4, 4, media);
  expect(first).toMatchObject({ ...media, offset: 0, eof: false, size: 8 });
  expect(second).toMatchObject({ ...media, offset: 4, eof: true, size: 8 });
  expect(
    Buffer.concat([
      Buffer.from(first.data, "base64"),
      Buffer.from(second.data, "base64"),
    ]),
  ).toEqual(bytes);
});
it("retains file, traversal, and deliberate symlink behavior for forced viewers", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "folder"));
  await expect(
    readExplorerMediaFile(root, "folder", 0, 4, media),
  ).rejects.toThrow();
  const outside = await fixture();
  await writeFile(path.join(outside, "secret.xyz"), "outside");
  await symlink(path.join(outside, "secret.xyz"), path.join(root, "link.xyz"));
  const linked = await readExplorerMediaFile(root, "link.xyz", 0, 4, media);
  expect(Buffer.from(linked.data, "base64").toString()).toBe("outs");
  await expect(
    readExplorerMediaFile(root, "../outside.xyz", 0, 4, media),
  ).rejects.toThrow();
});
