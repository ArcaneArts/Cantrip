import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NativeHistoryBinding } from "@cantrip/protocol";
import { AttachmentStore } from "../src/attachment-store.js";
import { NativeHistoryAttachmentStore } from "../src/native-history-attachment-store.js";
import { openWorkerAttachment } from "../src/attachment-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

let directory: string;
let attachments: AttachmentStore;
let binding: NativeHistoryBinding;
const service = {
  ownerId: () => "fixture-owner",
  serverIdentity: () => "fixture-server",
  componentKey: () => ({ key: new Uint8Array(32).fill(21), keyRevision: 1 }),
} as unknown as WorkerEncryptionService;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cantrip-native-attachment-"));
  attachments = new AttachmentStore(directory);
  binding = {
    id: randomUUID(),
    chatId: randomUUID(),
    workerId: randomUUID(),
    threadId: randomUUID(),
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    modelRouteId: null,
    providerAccountId: null,
    createdFromOperationId: null,
    createdAt: new Date().toISOString(),
  };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const store = () =>
  new NativeHistoryAttachmentStore({
    directory: path.join(directory, "history"),
    binding,
    service,
    attachments,
  });
const source = () => ({
  identity: {
    threadId: binding.threadId,
    turnId: "turn",
    itemId: "input",
    component: "user",
    identityKind: "canonical" as const,
  },
  partIndex: 1,
  fileName: "private-note.txt",
  mimeType: "text/plain",
  kind: "text" as const,
  bytes: new TextEncoder().encode("PRIVATE_ATTACHMENT_BYTES"),
});

describe("durable native attachment materialization", () => {
  it.each([false, true])(
    "recovers committed metadata on another worker with a local candidate: %s",
    async (hasCandidate) => {
      const input = source();
      const original = await store().materialize(input);
      const migratedDirectory = path.join(directory, "replacement-worker");
      const migratedFiles = new AttachmentStore(migratedDirectory);
      const migratedBinding = {
        ...binding,
        id: randomUUID(),
        workerId: randomUUID(),
      };
      const migrated = () =>
        new NativeHistoryAttachmentStore({
          directory: path.join(migratedDirectory, "history"),
          binding: migratedBinding,
          service,
          attachments: migratedFiles,
        });
      if (hasCandidate) {
        const candidate = await migrated().materialize(input);
        expect(candidate.attachment.id).toBe(original.attachment.id);
        expect(candidate.attachment.protectedMetadata).not.toEqual(
          original.attachment.protectedMetadata,
        );
      }
      expect(
        await migrated().materialize({
          ...input,
          publishedAttachment: original.attachment,
        }),
      ).toEqual(original);
      expect(await migrated().materialize(input)).toEqual(original);
      const file = migratedFiles.resolve(
        binding.chatId,
        original.attachment.id,
        input.fileName,
      );
      expect(await readFile(file)).toEqual(Buffer.from(input.bytes));
      await rm(file);
      expect(await migrated().materialize(input)).toEqual(original);
      expect(await readFile(file)).toEqual(Buffer.from(input.bytes));
      await expect(
        migrated().materialize({
          ...input,
          bytes: new TextEncoder().encode("different source bytes"),
          publishedAttachment: original.attachment,
        }),
      ).rejects.toThrow("conflicts with its source");
      await expect(
        migrated().materialize({
          ...input,
          publishedAttachment: {
            ...original.attachment,
            createdAt: "2000-01-01T00:00:00.000Z",
          },
        }),
      ).rejects.toThrow("metadata changed");
      expect(await migrated().materialize(input)).toEqual(original);
    },
  );

  it("reuses exact opaque metadata across concurrent handles and restart, and restores missing bytes", async () => {
    const input = source();
    const [a, b] = await Promise.all([
      store().materialize(input),
      store().materialize(input),
    ]);
    expect(b).toEqual(a);
    expect(new TextDecoder().decode(input.bytes)).toBe(
      "PRIVATE_ATTACHMENT_BYTES",
    );
    const opened = await openWorkerAttachment(a.attachment, service);
    const file = attachments.resolve(
      binding.chatId,
      a.attachment.id,
      opened.fileName,
    );
    expect(await readFile(file)).toEqual(Buffer.from(input.bytes));
    expect(JSON.stringify(a.attachment)).not.toContain("private-note");
    expect(JSON.stringify(a.attachment)).not.toContain(
      "PRIVATE_ATTACHMENT_BYTES",
    );
    await rm(file);
    attachments = new AttachmentStore(directory);
    const recovered = await store().materialize(input);
    expect(recovered).toEqual(a);
    expect(await readFile(file)).toEqual(Buffer.from(input.bytes));
    await writeFile(file, "corrupted");
    expect(await store().materialize(input)).toEqual(a);
    expect(await readFile(file)).toEqual(Buffer.from(input.bytes));
  });

  it("distinguishes source positions and versions while retaining empty and multichunk bytes", async () => {
    const input = source();
    const first = await store().materialize(input);
    const position = await store().materialize({ ...input, partIndex: 2 });
    const changed = await store().materialize({
      ...input,
      bytes: new Uint8Array(600_000).fill(99),
    });
    const empty = await store().materialize({
      ...input,
      bytes: new Uint8Array(),
    });
    expect(
      new Set(
        [first, position, changed, empty].map((value) => value.attachment.id),
      ).size,
    ).toBe(4);
    for (const [value, length] of [
      [changed, 600_000],
      [empty, 0],
    ] as const) {
      const opened = await openWorkerAttachment(value.attachment, service);
      expect(
        (
          await readFile(
            attachments.resolve(
              binding.chatId,
              value.attachment.id,
              opened.fileName,
            ),
          )
        ).length,
      ).toBe(length);
    }
  });

  it("does not replace a damaged committed manifest or accept an unrelated source binding", async () => {
    const input = source();
    const original = await store().materialize(input);
    const [scope] = await readdir(path.join(directory, "history"));
    const manifest = path.join(
      directory,
      "history",
      scope!,
      original.attachment.id,
      "attachment.json",
    );
    await writeFile(manifest, "broken JSON");
    await expect(store().materialize(input)).rejects.toThrow();
    expect(await readFile(manifest, "utf8")).toBe("broken JSON");
    await expect(
      store().materialize({
        ...input,
        identity: { ...input.identity, threadId: "another-thread" },
      }),
    ).rejects.toThrow("source binding");
  });
});
