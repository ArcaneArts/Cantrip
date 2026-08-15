import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExternalChatAttachmentStagingStore } from "../src/external-chat-attachments.js";

const temporaryDirectories: string[] = [];
const sourceId = "a".repeat(64);
const attachmentId = "b".repeat(64);

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("external chat attachment staging", () => {
  it("stages supported media behind opaque ids, streams it, and releases it", async () => {
    const root = await temporaryDirectory("cantrip-external-attachment-");
    const managed = path.join(root, "managed");
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
    ]);
    const original = path.join(project, "reference.png");
    await writeFile(original, bytes);
    const store = new ExternalChatAttachmentStagingStore(managed);

    const descriptor = await store.stage(
      sourceId,
      "thread-one",
      {
        id: attachmentId,
        itemId: "user-one",
        kind: "image",
        path: original,
        remoteUrl: null,
      },
      [project],
      1_024,
    );

    expect(descriptor).toEqual({
      id: attachmentId,
      itemId: "user-one",
      fileName: "reference.png",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      kind: "image",
      status: "available",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      warning: null,
    });
    const first = await store.read(sourceId, "thread-one", attachmentId, 0, 5);
    expect(first).toMatchObject({
      status: "available",
      data: bytes.subarray(0, 5).toString("base64"),
      eof: false,
      sizeBytes: bytes.byteLength,
      sha256: descriptor.sha256,
    });
    const last = await store.read(sourceId, "thread-one", attachmentId, 5, 100);
    expect(last).toMatchObject({
      status: "available",
      data: bytes.subarray(5).toString("base64"),
      eof: true,
    });

    await store.release(sourceId, "thread-one");
    await expect(
      store.read(sourceId, "thread-one", attachmentId, 0, 5),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("returns durable placeholders for missing, remote, and invalid media", async () => {
    const root = await temporaryDirectory("cantrip-external-placeholder-");
    const invalid = path.join(root, "not-an-image.png");
    await writeFile(invalid, "plain text");
    const store = new ExternalChatAttachmentStagingStore(
      path.join(root, "managed"),
    );
    const base = {
      id: attachmentId,
      itemId: "user-one",
      kind: "image" as const,
    };

    await expect(
      store.stage(
        sourceId,
        "thread-one",
        { ...base, path: path.join(root, "missing.png"), remoteUrl: null },
        [root],
        1_024,
      ),
    ).resolves.toMatchObject({ status: "missing", sha256: null });
    await expect(
      store.stage(
        sourceId,
        "thread-one",
        { ...base, path: null, remoteUrl: "https://example.com/image.png" },
        [root],
        1_024,
      ),
    ).resolves.toMatchObject({
      status: "unsupported",
      fileName: "image.png",
      sha256: null,
    });
    await expect(
      store.stage(
        sourceId,
        "thread-one",
        { ...base, path: invalid, remoteUrl: null },
        [root],
        1_024,
      ),
    ).resolves.toMatchObject({ status: "unsupported", sha256: null });
  });

  it("does not copy local files outside project and temporary roots", async () => {
    const managed = await temporaryDirectory("cantrip-external-unsafe-");
    const store = new ExternalChatAttachmentStagingStore(managed);

    await expect(
      store.stage(
        sourceId,
        "thread-one",
        {
          id: attachmentId,
          itemId: "user-one",
          kind: "image",
          path: "/etc/hosts",
          remoteUrl: null,
        },
        [path.join(managed, "project")],
        1_024,
      ),
    ).resolves.toMatchObject({
      status: "unsafe",
      warning: expect.stringMatching(/outside the project/iu),
    });
  });
});
