import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readExplorerFile,
  readExplorerTextPreview,
  writeExplorerFile,
} from "../src/explorer.js";
import { TextPreviewRequiredError } from "../src/explorer-text-preview.js";
import {
  TEXT_PREVIEW_BYTES_LIMIT,
  TEXT_PREVIEW_PAGE_BYTES,
  TEXT_PREVIEW_PAGE_LINES,
  SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT,
} from "@cantrip/protocol/surface-stream";
const roots: string[] = [];
async function fixture(content: string | Buffer) {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-text-preview-"));
  roots.push(root);
  await writeFile(path.join(root, "file.txt"), content);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("reads a 10 MiB file in bounded pages without changing editable save limits", async () => {
  const content = "x".repeat(TEXT_PREVIEW_BYTES_LIMIT - 1) + "\n";
  const root = await fixture(content);
  await expect(readExplorerFile(root, "file.txt")).rejects.toBeInstanceOf(
    TextPreviewRequiredError,
  );
  let offset = 0,
    version: string | undefined;
  const pages: string[] = [];
  do {
    const page = await readExplorerTextPreview(
      root,
      "file.txt",
      offset,
      version,
    );
    expect(page.size).toBe(TEXT_PREVIEW_BYTES_LIMIT);
    expect(page.nextOffset - page.offset).toBeLessThanOrEqual(
      TEXT_PREVIEW_PAGE_BYTES,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          ok: true,
          result: { type: "explorer.file.preview", value: page },
        }),
      ),
    ).toBeLessThan(SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT);
    offset = page.nextOffset;
    version = page.version;
    pages.push(page.content);
    if (page.eof) break;
  } while (offset < content.length);
  expect(pages.join("")).toBe(content);
  expect(pages.length).toBe(40);
  await expect(
    writeExplorerFile(root, "file.txt", "replacement", version!),
  ).rejects.toThrow("2 MB");
});

it("starts with at most 10,000 lines and preserves BOM, CRLF and split UTF-8 characters", async () => {
  const prefix = "\ufeff" + "line\r\n".repeat(TEXT_PREVIEW_PAGE_LINES);
  const content =
    prefix + "a".repeat(TEXT_PREVIEW_PAGE_BYTES - 1) + "😀é日本語\r\nlast";
  const root = await fixture(content);
  const first = await readExplorerTextPreview(root, "file.txt", 0);
  expect(first.content).toBe(prefix);
  expect(first.eof).toBe(false);
  const second = await readExplorerTextPreview(
    root,
    "file.txt",
    first.nextOffset,
    first.version,
  );
  expect(second.content).toBe("a".repeat(TEXT_PREVIEW_PAGE_BYTES - 1));
  const last = await readExplorerTextPreview(
    root,
    "file.txt",
    second.nextOffset,
    second.version,
  );
  expect(last.eof).toBe(true);
  expect(first.content + second.content + last.content).toBe(content);
});

it("rejects changed files instead of joining text from different revisions", async () => {
  const root = await fixture("a\n".repeat(20_000));
  const first = await readExplorerTextPreview(root, "file.txt", 0);
  await writeFile(path.join(root, "file.txt"), "b\n".repeat(20_000));
  await expect(
    readExplorerTextPreview(root, "file.txt", first.nextOffset, first.version),
  ).rejects.toThrow("file changed");
});

it("rejects files above 10 MiB, binary text, malformed UTF-8, unsafe offsets and paths", async () => {
  const root = await fixture(Buffer.alloc(TEXT_PREVIEW_BYTES_LIMIT + 1, 97));
  await expect(readExplorerTextPreview(root, "file.txt", 0)).rejects.toThrow(
    "10 MB",
  );
  await expect(readExplorerFile(root, "file.txt")).rejects.toThrow("10 MB");
  await writeFile(path.join(root, "file.txt"), Buffer.from([97, 0, 98]));
  await expect(readExplorerTextPreview(root, "file.txt", 0)).rejects.toThrow(
    "Binary",
  );
  await writeFile(path.join(root, "file.txt"), Buffer.from([0xf0, 0x9f]));
  await expect(readExplorerTextPreview(root, "file.txt", 0)).rejects.toThrow(
    "UTF-8",
  );
  await expect(readExplorerTextPreview(root, "file.txt", 1)).rejects.toThrow(
    "offset",
  );
  await expect(readExplorerTextPreview(root, "file.txt", -1)).rejects.toThrow(
    "offset",
  );
  await expect(
    readExplorerTextPreview(root, "../file.txt", 0),
  ).rejects.toThrow();
  const outside = await fixture("secret");
  await symlink(path.join(outside, "file.txt"), path.join(root, "escape.txt"));
  // Match the Explorer's deliberate shared-file symlink policy.
  await expect(
    readExplorerTextPreview(root, "escape.txt", 0),
  ).resolves.toMatchObject({ content: "secret" });
});

it("keeps worst-case JSON escaping below the existing protected message cap", async () => {
  const root = await fixture("\u0001".repeat(TEXT_PREVIEW_PAGE_BYTES * 2));
  const page = await readExplorerTextPreview(root, "file.txt", 0);
  expect(page.eof).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(
    SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT,
  );
});

it("bounds old-style carriage-return lines and handles empty files", async () => {
  const root = await fixture("line\r".repeat(TEXT_PREVIEW_PAGE_LINES + 1));
  const first = await readExplorerTextPreview(root, "file.txt", 0);
  expect(first.content).toBe("line\r".repeat(TEXT_PREVIEW_PAGE_LINES));
  expect(first.eof).toBe(false);
  await writeFile(path.join(root, "file.txt"), "");
  await expect(
    readExplorerTextPreview(root, "file.txt", 0),
  ).resolves.toMatchObject({
    content: "",
    offset: 0,
    nextOffset: 0,
    size: 0,
    eof: true,
  });
});
