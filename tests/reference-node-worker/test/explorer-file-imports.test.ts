import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExplorerFileImportChunk } from "@cantrip/protocol/surface-stream";
import { ExplorerFileImports } from "../src/explorer-file-imports.js";

let root: string;
let imports: ExplorerFileImports;
const chunk = (
  overrides: Partial<ExplorerFileImportChunk> = {},
): ExplorerFileImportChunk => ({
  type: "explorer.file.import",
  path: "",
  name: "image.bin",
  size: 4,
  offset: 0,
  data: Buffer.from([0, 255, 128, 10]).toString("base64"),
  eof: true,
  ...overrides,
});
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cantrip-import-test-"));
  imports = new ExplorerFileImports();
});
afterEach(async () => {
  vi.useRealTimers();
  await imports.dispose();
  await rm(root, { recursive: true, force: true });
});

it("publishes exact binary bytes only when every chunk has arrived", async () => {
  await mkdir(path.join(root, "nested"));
  expect(
    await imports.write(
      "upload",
      root,
      0,
      chunk({ path: "nested", data: "AP8=", eof: false }),
    ),
  ).toEqual({ offset: 2, entry: null });
  expect(await readdir(path.join(root, "nested"))).toEqual([]);
  expect(
    await imports.write(
      "upload",
      root,
      1,
      chunk({ path: "nested", offset: 2, data: "gAo=" }),
    ),
  ).toMatchObject({
    offset: 4,
    entry: { name: "image.bin", path: "nested/image.bin", size: 4 },
  });
  expect(await readFile(path.join(root, "nested/image.bin"))).toEqual(
    Buffer.from([0, 255, 128, 10]),
  );
});

it("imports an empty file at the root", async () => {
  expect(
    await imports.write("empty", root, 0, chunk({ size: 0, data: "" })),
  ).toMatchObject({ offset: 0, entry: { size: 0 } });
  expect(await readFile(path.join(root, "image.bin"))).toHaveLength(0);
});

it("preserves existing files and dangling links", async () => {
  await writeFile(path.join(root, "image.bin"), "original");
  await expect(imports.write("collision", root, 0, chunk())).rejects.toThrow(
    "already exists",
  );
  expect(await readFile(path.join(root, "image.bin"), "utf8")).toBe("original");
  await symlink(path.join(root, "missing"), path.join(root, "link.bin"));
  await expect(
    imports.write("link", root, 0, chunk({ name: "link.bin" })),
  ).rejects.toThrow("already exists");
  expect(await readdir(root)).toEqual(["image.bin", "link.bin"]);
});

it.each(["../escape", "/escape", "x/y", "x\\y"])(
  "rejects destination filename %j",
  async (name) => {
    await expect(
      imports.write("escape", root, 0, chunk({ name })),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  },
);

it("confines imports to the current worktree including symlinked destinations", async () => {
  await mkdir(path.join(root, "project"));
  await mkdir(path.join(root, "outside"));
  await symlink(
    path.join(root, "outside"),
    path.join(root, "project/link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    imports.write(
      "traversal",
      path.join(root, "project"),
      0,
      chunk({ path: "../outside" }),
    ),
  ).rejects.toThrow("traversal");
  await expect(
    imports.write(
      "link",
      path.join(root, "project"),
      0,
      chunk({ path: "link" }),
    ),
  ).rejects.toThrow("outside");
  expect(await readdir(path.join(root, "outside"))).toEqual([]);
});

it.each([
  { offset: 1 },
  { size: 6 },
  { name: "other.bin" },
  { path: "other" },
  { data: "", eof: false },
  { data: "AA==", eof: true },
])(
  "discards a transfer after a mismatched or incomplete chunk: %j",
  async (change) => {
    await imports.write(
      "changed",
      root,
      0,
      chunk({ data: "AP8=", eof: false }),
    );
    await expect(
      imports.write(
        "changed",
        root,
        1,
        chunk({ offset: 2, data: "gAo=", ...change }),
      ),
    ).rejects.toThrow();
    await expect(
      imports.write("changed", root, 2, chunk({ offset: 2, data: "gAo=" })),
    ).rejects.toThrow("unavailable");
    expect(await readdir(root)).toEqual([]);
  },
);

it("cancels abandoned transfers and expires idle staging without publishing", async () => {
  await imports.write(
    "cancelled",
    root,
    0,
    chunk({ data: "AP8=", eof: false }),
  );
  await imports.cancel("cancelled");
  await expect(
    imports.write("cancelled", root, 1, chunk({ offset: 2, data: "gAo=" })),
  ).rejects.toThrow("unavailable");
  vi.useFakeTimers();
  await imports.write("expired", root, 0, chunk({ data: "AP8=", eof: false }));
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  await expect(
    imports.write("expired", root, 1, chunk({ offset: 2, data: "gAo=" })),
  ).rejects.toThrow("unavailable");
  expect(await readdir(root)).toEqual([]);
});

it("bounds active transfers and rejects further work after shutdown", async () => {
  await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      imports.write(
        String(index),
        root,
        0,
        chunk({ data: "AP8=", eof: false }),
      ),
    ),
  );
  await expect(imports.write("extra", root, 0, chunk())).rejects.toThrow(
    "Too many",
  );
  await imports.dispose();
  await expect(imports.write("shutdown", root, 0, chunk())).rejects.toThrow(
    "shutting down",
  );
  expect(await readdir(root)).toEqual([]);
});
