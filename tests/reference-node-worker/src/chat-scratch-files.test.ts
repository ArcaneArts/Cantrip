import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { fromBuffer } from "yauzl";

import { ChatScratchFileManager } from "./chat-scratch-files.js";
import { ChatScratchManager } from "./chat-scratch.js";

const cleanup: string[] = [];

async function fixture() {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-chat-files-"),
  );
  cleanup.push(dataDirectory);
  const chatId = randomUUID();
  const rootId = randomUUID();
  const scratch = new ChatScratchManager(dataDirectory);
  const provisioned = await scratch.provision({
    attempt: 1,
    chatId,
    jobId: randomUUID(),
    rootId,
  });
  return {
    chatId,
    files: new ChatScratchFileManager(dataDirectory),
    root: provisioned.path,
  };
}

async function readPreparedDownload(
  files: ChatScratchFileManager,
  root: string,
  downloadId: string,
  size: number,
) {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await files.readDownload(root, downloadId, offset, 17);
    const bytes = Buffer.from(chunk.data, "base64");
    chunks.push(bytes);
    offset += bytes.byteLength;
    if (chunk.eof) break;
  }
  expect(offset).toBe(size);
  return Buffer.concat(chunks);
}

function zipEntryNames(bytes: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true }, (error, archive) => {
      if (error || !archive) {
        reject(error ?? new Error("ZIP did not open."));
        return;
      }
      const names: string[] = [];
      archive.on("entry", (entry) => {
        names.push(entry.fileName);
        archive.readEntry();
      });
      archive.once("end", () => resolve(names));
      archive.once("error", reject);
      archive.readEntry();
    });
  });
}

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ChatScratchFileManager", () => {
  it("lists, reads, writes, and resolves files inside one scratch root", async () => {
    const { files, root } = await fixture();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "main.py"), "print('one')\n");

    const rootEntries = await files.list(root, "");
    expect(rootEntries.entries).toMatchObject([
      { kind: "directory", name: "src", path: "src", symbolicLink: false },
    ]);
    const source = await files.read(root, "src/main.py");
    expect(source.content).toBe("print('one')\n");
    const saved = await files.write(
      root,
      "src/main.py",
      "print('two')\n",
      source.version,
    );
    expect(saved.content).toBe("print('two')\n");
    await expect(
      files.write(root, "src/main.py", "stale", source.version),
    ).rejects.toThrow("changed since it was opened");
    await expect(files.resolveReference(root, "src/main.py:4:2")).resolves.toBe(
      "src/main.py",
    );
    await expect(
      files.resolveReference(root, path.join(root, "src", "main.py")),
    ).resolves.toBe("src/main.py");
  });

  it("rejects traversal and symbolic links for every rooted operation", async () => {
    const { files, root } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "cantrip-outside-"));
    cleanup.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(root, "link.txt"),
    );

    const listed = await files.list(root, "");
    expect(
      listed.entries.find(({ name }) => name === "link.txt"),
    ).toMatchObject({
      kind: "other",
      symbolicLink: true,
      viewable: false,
    });
    await expect(files.read(root, "../secret.txt")).rejects.toThrow(
      "traversal",
    );
    await expect(files.read(root, "link.txt")).rejects.toThrow(
      "symbolic links",
    );
    await expect(
      files.prepareDownload({ kind: "file", path: "link.txt", root }),
    ).rejects.toThrow("symbolic links");
    await expect(
      files.resolveReference(root, path.join(outside, "secret.txt")),
    ).rejects.toThrow("outside");
  });

  it("requires recursive confirmation and never permits deleting the root", async () => {
    const { files, root } = await fixture();
    await mkdir(path.join(root, "output"));
    await writeFile(path.join(root, "output", "result.txt"), "result");
    await expect(files.delete(root, "output", false)).rejects.toThrow(
      "Recursive confirmation",
    );
    await expect(files.delete(root, "", true)).rejects.toThrow(
      "path is required",
    );
    await expect(files.delete(root, "output", true)).resolves.toMatchObject({
      path: "output",
      newPath: null,
    });
  });

  it("streams bounded file downloads and safe folder ZIPs", async () => {
    const { files, root } = await fixture();
    await mkdir(path.join(root, "results"));
    await writeFile(path.join(root, "results", "one.txt"), "one");
    await writeFile(path.join(root, "results", "two.txt"), "two");

    const file = await files.prepareDownload({
      kind: "file",
      path: "results/one.txt",
      root,
    });
    const otherRoot = path.join(path.dirname(root), randomUUID());
    await mkdir(otherRoot);
    await expect(
      files.readDownload(otherRoot, file.downloadId, 0, 1),
    ).rejects.toThrow("another scratch folder");
    expect(
      await readPreparedDownload(files, root, file.downloadId, file.size),
    ).toEqual(Buffer.from("one"));
    await expect(
      files.readDownload(root, file.downloadId, file.size, 1),
    ).rejects.toThrow("no longer available");

    const archive = await files.prepareDownload({
      kind: "folder",
      path: "results",
      root,
    });
    expect(archive.fileName).toBe("results.zip");
    const bytes = await readPreparedDownload(
      files,
      root,
      archive.downloadId,
      archive.size,
    );
    await expect(zipEntryNames(bytes)).resolves.toEqual([
      "results/one.txt",
      "results/two.txt",
    ]);
  });

  it("rejects symbolic links while packaging a folder", async () => {
    const { files, root } = await fixture();
    await mkdir(path.join(root, "results"));
    await symlink(root, path.join(root, "results", "loop"));
    await expect(
      files.prepareDownload({ kind: "folder", path: "results", root }),
    ).rejects.toThrow("symbolic links");
  });
});
