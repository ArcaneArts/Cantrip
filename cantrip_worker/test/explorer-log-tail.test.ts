import { mkdtemp, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  LOG_TAIL_PAGE_BYTES,
  SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT,
} from "@cantrip/protocol/surface-stream";
import { readExplorerLogTail } from "../src/explorer.js";
const roots: string[] = [];
async function fixture(content: string | Buffer) {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-log-tail-"));
  roots.push(root);
  const file = path.join(root, "daemon.log");
  await writeFile(file, content);
  return { root, file };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("starts at the end of a large log and reads only appended bytes thereafter", async () => {
  const { root, file } = await fixture(
    "old line\n".repeat(1_300_000) + "SENTINEL latest\n",
  );
  const first = await readExplorerLogTail(root, "daemon.log");
  expect(first.reset).toBe(true);
  expect(first.startOffset).toBeGreaterThan(0);
  expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(
    LOG_TAIL_PAGE_BYTES,
  );
  expect(first.content.endsWith("SENTINEL latest\n")).toBe(true);
  const idle = await readExplorerLogTail(root, "daemon.log", first.cursor);
  expect(idle).toMatchObject({
    reset: false,
    content: "",
    cursor: first.cursor,
  });
  await appendFile(file, "new output 😀\n");
  const next = await readExplorerLogTail(root, "daemon.log", first.cursor);
  expect(next).toMatchObject({
    reset: false,
    content: "new output 😀\n",
    startOffset: first.cursor.offset,
  });
  expect(next.cursor.offset).toBe(next.size);
});
it("resets on rotation, truncation, same-size overwrite, and truncate/regrow between polls", async () => {
  const { root, file } = await fixture("original\n".repeat(100));
  const first = await readExplorerLogTail(root, "daemon.log");
  await rename(file, file + ".1");
  await writeFile(file, "replacement\n".repeat(200));
  const rotated = await readExplorerLogTail(root, "daemon.log", first.cursor);
  expect(rotated.reset).toBe(true);
  expect(rotated.cursor.identity).not.toBe(first.cursor.identity);
  await writeFile(file, "tiny\n");
  const truncated = await readExplorerLogTail(
    root,
    "daemon.log",
    rotated.cursor,
  );
  expect(truncated).toMatchObject({ reset: true, content: "tiny\n" });
  await writeFile(file, "newer\n".repeat(100));
  const regrown = await readExplorerLogTail(
    root,
    "daemon.log",
    truncated.cursor,
  );
  expect(regrown.reset).toBe(true);
  expect(regrown.content.startsWith("newer")).toBe(true);
  await writeFile(file, "other\n".repeat(100));
  const overwritten = await readExplorerLogTail(
    root,
    "daemon.log",
    regrown.cursor,
  );
  expect(overwritten.reset).toBe(true);
  expect(overwritten.content.startsWith("other")).toBe(true);
});
it("jumps to a fresh bounded tail when output outruns the cursor", async () => {
  const { root, file } = await fixture("start\n");
  const first = await readExplorerLogTail(root, "daemon.log");
  await appendFile(file, "later line\n".repeat(50_000));
  const next = await readExplorerLogTail(root, "daemon.log", first.cursor);
  expect(next.reset).toBe(true);
  expect(Buffer.byteLength(next.content)).toBeLessThanOrEqual(
    LOG_TAIL_PAGE_BYTES,
  );
  expect(next.cursor.offset).toBe(next.size);
});
it("waits for split UTF-8 writes without replacement glyphs or lost bytes", async () => {
  const emoji = Buffer.from("😀");
  const { root, file } = await fixture(
    Buffer.concat([Buffer.from("line\n"), emoji.subarray(0, 2)]),
  );
  const first = await readExplorerLogTail(root, "daemon.log");
  expect(first.content).toBe("line\n");
  expect(first.cursor.offset).toBe(5);
  await appendFile(file, emoji.subarray(2));
  const next = await readExplorerLogTail(root, "daemon.log", first.cursor);
  expect(next.content).toBe("😀");
  expect(next.reset).toBe(false);
});
it("handles empty logs, long final lines, bounded JSON escaping and unsafe paths", async () => {
  const { root, file } = await fixture("");
  expect(await readExplorerLogTail(root, "daemon.log")).toMatchObject({
    reset: true,
    content: "",
    size: 0,
  });
  await writeFile(file, "x".repeat(LOG_TAIL_PAGE_BYTES + 100) + "\n");
  const long = await readExplorerLogTail(root, "daemon.log");
  expect(long.content.length).toBeGreaterThan(0);
  expect(long.content.endsWith("\n")).toBe(true);
  await writeFile(file, "\u0001".repeat(LOG_TAIL_PAGE_BYTES));
  expect(
    Buffer.byteLength(
      JSON.stringify(await readExplorerLogTail(root, "daemon.log")),
    ),
  ).toBeLessThan(SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT);
  await expect(readExplorerLogTail(root, "../secret.log")).rejects.toThrow(
    "traversal",
  );
  await writeFile(file, Buffer.from([0, 97]));
  await expect(readExplorerLogTail(root, "daemon.log")).rejects.toThrow(
    "Binary",
  );
});
