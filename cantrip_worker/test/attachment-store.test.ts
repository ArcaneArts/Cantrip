import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AttachmentStore,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_CHUNK_BYTES,
  safeAttachmentFileName,
} from "../src/attachment-store.js";
import { readWorkerLogs } from "../src/logger.js";

const directories: string[] = [];

async function testStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-attachments-"));
  directories.push(directory);
  return { directory, store: new AttachmentStore(directory) };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AttachmentStore", () => {
  it("stages chunked files outside a repository and survives recreation", async () => {
    const afterCursor = readWorkerLogs({
      afterCursor: 0,
      limit: 200,
      minimumLevel: "trace",
    }).latestCursor;
    const { directory, store } = await testStore();
    await store.begin("chat-1", "attachment-1", "../notes?.txt", 11);
    await store.append("chat-1", "attachment-1", 0, Buffer.from("hello "));
    await store.append("chat-1", "attachment-1", 1, Buffer.from("world"));
    const completed = await store.complete("chat-1", "attachment-1");

    expect(completed.path).toContain(
      path.join("attachments", "chat-1", "attachment-1"),
    );
    expect(completed.path).toMatch(/notes_\.txt$/u);
    expect(await readFile(completed.path, "utf8")).toBe("hello world");
    expect(completed.sha256).toHaveLength(64);

    const recreated = new AttachmentStore(directory);
    const chunk = await recreated.read(
      "chat-1",
      "attachment-1",
      "../notes?.txt",
      6,
      5,
    );
    expect(Buffer.from(chunk.bytes).toString()).toBe("world");
    expect(chunk).toMatchObject({ eof: true, sizeBytes: 11 });

    await recreated.remove("chat-1", "attachment-1");
    await expect(readFile(completed.path)).rejects.toThrow();
    const serializedLogs = JSON.stringify(
      readWorkerLogs({
        afterCursor,
        limit: 200,
        minimumLevel: "trace",
      }).records,
    );
    expect(serializedLogs).not.toContain("hello world");
    expect(serializedLogs).not.toContain("notes_.txt");
    expect(serializedLogs).not.toContain(directory);
  });

  it("enforces upload order, declared sizes, and chunk limits", async () => {
    const { store } = await testStore();
    await expect(
      store.begin(
        "chat-1",
        "attachment-1",
        "large.bin",
        MAX_ATTACHMENT_BYTES + 1,
      ),
    ).rejects.toThrow(/size/u);

    await store.begin("chat-1", "attachment-1", "small.bin", 2);
    await expect(
      store.append("chat-1", "attachment-1", 1, Buffer.from("a")),
    ).rejects.toThrow(/Expected attachment chunk 0/u);
    await expect(
      store.append(
        "chat-1",
        "attachment-1",
        0,
        Buffer.alloc(MAX_ATTACHMENT_CHUNK_BYTES + 1),
      ),
    ).rejects.toThrow(/chunk/u);
    await store.append("chat-1", "attachment-1", 0, Buffer.from("a"));
    await expect(
      store.append("chat-1", "attachment-1", 1, Buffer.from("bc")),
    ).rejects.toThrow(/declared size/u);
    await expect(store.complete("chat-1", "attachment-1")).rejects.toThrow(
      /incomplete/u,
    );
  });

  it("sanitizes names and rejects path-like identifiers", async () => {
    expect(safeAttachmentFileName("../../.secret")).toBe("secret");
    expect(safeAttachmentFileName("diagram: 01?.png")).toBe("diagram_ 01_.png");
    const { store } = await testStore();
    await expect(
      store.begin("../chat", "attachment-1", "file.txt", 0),
    ).rejects.toThrow(/Chat id/u);
  });
});
