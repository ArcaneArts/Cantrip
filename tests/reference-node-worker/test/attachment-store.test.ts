import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
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
    const operationId = "11111111-1111-4111-8111-111111111111";
    const digest = createHash("sha256").update("hello world").digest("hex");
    await store.begin(
      "chat-1",
      "attachment-1",
      "../notes?.txt",
      11,
      operationId,
      digest,
    );
    await store.append(
      "chat-1",
      "attachment-1",
      0,
      Buffer.from("hello "),
      operationId,
      false,
    );
    await store.append(
      "chat-1",
      "attachment-1",
      1,
      Buffer.from("world"),
      operationId,
      true,
    );
    const completed = await store.complete(
      "chat-1",
      "attachment-1",
      operationId,
    );
    const completedPath = store.resolve(
      "chat-1",
      "attachment-1",
      "../notes?.txt",
    );

    expect(completedPath).toContain(
      path.join("attachments", "chat-1", "attachment-1"),
    );
    expect(completedPath).toMatch(/notes_\.txt$/u);
    expect(await readFile(completedPath, "utf8")).toBe("hello world");
    expect(completed).toEqual({ sizeBytes: 11, verified: true });

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
    await expect(readFile(completedPath)).rejects.toThrow();
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
        "operation-1",
        "0".repeat(64),
      ),
    ).rejects.toThrow(/size/u);

    await store.begin(
      "chat-1",
      "attachment-1",
      "small.bin",
      2,
      "operation-1",
      createHash("sha256").update("ab").digest("hex"),
    );
    await expect(
      store.append(
        "chat-1",
        "attachment-1",
        1,
        Buffer.from("a"),
        "operation-1",
        false,
      ),
    ).rejects.toThrow(/Expected attachment chunk 0/u);
    await expect(
      store.append(
        "chat-1",
        "attachment-1",
        0,
        Buffer.alloc(MAX_ATTACHMENT_CHUNK_BYTES + 1),
        "operation-1",
        false,
      ),
    ).rejects.toThrow(/chunk/u);
    await expect(
      store.append(
        "chat-1",
        "attachment-1",
        0,
        Buffer.from("a"),
        "operation-1",
        true,
      ),
    ).rejects.toThrow(/end marker/u);
    await store.append(
      "chat-1",
      "attachment-1",
      0,
      Buffer.from("a"),
      "operation-1",
      false,
    );
    await expect(
      store.append(
        "chat-1",
        "attachment-1",
        1,
        Buffer.from("bc"),
        "operation-1",
        true,
      ),
    ).rejects.toThrow(/declared size/u);
    await expect(
      store.complete("chat-1", "attachment-1", "operation-1"),
    ).rejects.toThrow(/incomplete/u);
  });

  it("sanitizes names and rejects path-like identifiers", async () => {
    expect(safeAttachmentFileName("../../.secret")).toBe("secret");
    expect(safeAttachmentFileName("diagram: 01?.png")).toBe("diagram_ 01_.png");
    const { store } = await testStore();
    await expect(
      store.begin(
        "../chat",
        "attachment-1",
        "file.txt",
        0,
        "operation-1",
        createHash("sha256").update("").digest("hex"),
      ),
    ).rejects.toThrow(/Chat id/u);
  });
});
