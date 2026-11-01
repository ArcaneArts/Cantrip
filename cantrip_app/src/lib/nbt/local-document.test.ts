import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { generateAccountMasterKey } from "@cantrip/crypto";
import type { NbtDocumentClient } from "@cantrip/nbt/document";
import { ClientEncryptionService } from "@/lib/client-encryption";
import {
  IndexedDocumentRecoveryStorage,
  type DocumentRecoveryStorage,
} from "@/lib/document-recovery-storage";
import { NbtLocalReferenceSession } from "./local-reference";
import { NbtLocalDocument } from "./local-document";
async function fixture() {
  const binding = {
      serverId: "server",
      ownerId: "owner",
      workspaceId: "workspace",
      projectId: "project",
      workerId: "worker",
      worktreeId: "worktree",
      documentId: crypto.randomUUID(),
    },
    service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: binding,
    masterKeyRevision: 1,
  });
  const inner = new IndexedDocumentRecoveryStorage(new IDBFactory());
  let before = false,
    after = false,
    read = false;
  let hold: Promise<void> | undefined;
  const storage: DocumentRecoveryStorage = {
      async read(key) {
        await hold;
        if (read) throw new Error("Reference read failed");
        return inner.read(key);
      },
      async write(...args) {
        if (before) {
          before = false;
          throw new Error("Reference write failed");
        }
        const result = await inner.write(...args);
        if (after) {
          after = false;
          throw new Error("Reference reply lost");
        }
        return result;
      },
    },
    open = () =>
      NbtLocalReferenceSession.open(binding, "view", storage, service),
    document = await NbtLocalDocument.open(open);
  return {
    document,
    open,
    failBefore() {
      before = true;
    },
    loseReply() {
      after = true;
    },
    failReads(value: boolean) {
      read = value;
    },
    holdReads(value: Promise<void> | undefined) {
      hold = value;
    },
  };
}
const file = () => new File([new Uint8Array([10, 0, 0, 0])], "local.nbt");
const client = (
  checkpointRecovery = vi.fn(async (_signal?: AbortSignal) => ({})),
) => ({ checkpointRecovery }) as unknown as NbtDocumentClient;
it("shows a progressive candidate while its source checkpoint is pending and publishes only after acknowledgement", async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const selected = f.document.select(file()),
      candidate = f.document.getSnapshot().origin!,
      ready = f.document.ready(
        candidate.id,
        client(
          vi.fn(
            () =>
              new Promise((resolve) => {
                release = () => resolve({});
              }),
          ),
        ),
        new AbortController().signal,
      );
    expect(f.document.getSnapshot()).toMatchObject({
      preparing: true,
      blocked: false,
      origin: candidate,
    });
    const before = await f.open();
    expect(before.value).toBeNull();
    before.dispose();
    release();
    await ready;
    await selected;
    expect(f.document.getSnapshot()).toMatchObject({
      preparing: false,
      blocked: false,
      origin: candidate,
    });
    f.document.dispose();
    const restored = await NbtLocalDocument.open(f.open);
    expect(restored.getSnapshot()).toMatchObject({
      origin: candidate,
      preparing: false,
    });
    expect(restored.getSnapshot().file).toBeUndefined();
    restored.dispose();
  } finally {
    release();
    f.document.dispose();
  }
});
it("rolls back a failed baseline checkpoint without publishing a new source", async () => {
  const f = await fixture();
  try {
    const selected = f.document.select(file()),
      id = f.document.getSnapshot().origin!.id;
    await f.document.ready(
      id,
      client(
        vi.fn(async () => {
          throw new Error("Disk full");
        }),
      ),
      new AbortController().signal,
    );
    await expect(selected).rejects.toThrow(/Disk full/);
    expect(f.document.getSnapshot()).toMatchObject({
      origin: null,
      preparing: false,
      error: "Disk full",
    });
    const pointer = await f.open();
    expect(pointer.value).toBeNull();
    pointer.dispose();
  } finally {
    f.document.dispose();
  }
});
it("retains the previous source after a real reference write failure", async () => {
  const f = await fixture();
  try {
    const selected = f.document.select(file()),
      id = f.document.getSnapshot().origin!.id;
    f.failBefore();
    await f.document.ready(id, client(), new AbortController().signal);
    await expect(selected).rejects.toThrow(/write failed/);
    expect(f.document.getSnapshot().origin).toBeNull();
    expect(f.document.getSnapshot().blocked).toBe(false);
  } finally {
    f.document.dispose();
  }
});
it("accepts a committed local source when its pointer reply is lost", async () => {
  const f = await fixture();
  try {
    const selected = f.document.select(file()),
      origin = f.document.getSnapshot().origin!;
    f.loseReply();
    await f.document.ready(origin.id, client(), new AbortController().signal);
    await selected;
    expect(f.document.getSnapshot()).toMatchObject({
      origin,
      preparing: false,
      blocked: false,
    });
  } finally {
    f.document.dispose();
  }
});
it("keeps unknown publication readonly until an explicit retry reads its actual committed source", async () => {
  const f = await fixture();
  try {
    const selected = f.document.select(file()),
      origin = f.document.getSnapshot().origin!;
    f.loseReply();
    f.failReads(true);
    await f.document.ready(origin.id, client(), new AbortController().signal);
    await expect(selected).rejects.toThrow(/read failed/);
    expect(f.document.getSnapshot()).toMatchObject({
      origin,
      blocked: true,
      preparing: false,
    });
    f.failReads(false);
    await f.document.retry();
    expect(f.document.getSnapshot()).toMatchObject({
      origin,
      blocked: false,
      preparing: false,
    });
  } finally {
    f.document.dispose();
  }
});
it("handles failures before a worker facade exists without leaving the candidate pending", async () => {
  const f = await fixture();
  try {
    const selected = f.document.select(file()),
      id = f.document.getSnapshot().origin!.id;
    await f.document.failed(id, new Error("Worker could not open"));
    await expect(selected).rejects.toThrow(/could not open/);
    expect(f.document.getSnapshot().preparing).toBe(false);
  } finally {
    f.document.dispose();
  }
});
it("aborts preparation and releases the selected File when the view is retired", async () => {
  const f = await fixture(),
    selected = f.document.select(file()),
    id = f.document.getSnapshot().origin!.id;
  const ready = f.document.ready(
    id,
    client(
      vi.fn(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(signal!.reason), {
              once: true,
            });
          }),
      ),
    ),
    new AbortController().signal,
  );
  f.document.dispose();
  await expect(selected).rejects.toThrow(/closed/);
  await ready;
  expect(f.document.getSnapshot().file).toBeUndefined();
  const pointer = await f.open();
  expect(pointer.value).toBeNull();
  pointer.dispose();
});
it("retries an approved pointer clear without reopening the local source for edits mid-clear", async () => {
  const f = await fixture();
  try {
    const selected = f.document.select(file()),
      id = f.document.getSnapshot().origin!.id;
    await f.document.ready(id, client(), new AbortController().signal);
    await selected;
    f.failBefore();
    await expect(f.document.discard()).rejects.toThrow(/write failed/);
    expect(f.document.getSnapshot().blocked).toBe(true);
    await f.document.retry();
    expect(f.document.getSnapshot()).toMatchObject({
      origin: null,
      blocked: false,
      preparing: false,
    });
  } finally {
    f.document.dispose();
  }
});

it("keeps a retry exclusive and surfaces its actual read failure", async () => {
  const f = await fixture();
  let release = () => {};
  try {
    f.holdReads(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const retry = f.document.retry();
    expect(f.document.getSnapshot().preparing).toBe(true);
    await expect(f.document.select(file())).rejects.toThrow(/Resolve/);
    await expect(f.document.retry()).rejects.toThrow(/Wait/);
    f.failReads(true);
    release();
    await expect(retry).rejects.toThrow(/read failed/);
    expect(f.document.getSnapshot()).toMatchObject({
      preparing: false,
      blocked: true,
      error: "Reference read failed",
    });
    f.failReads(false);
    await f.document.retry();
    expect(f.document.getSnapshot()).toMatchObject({
      preparing: false,
      blocked: false,
      error: null,
    });
  } finally {
    release();
    f.document.dispose();
  }
});
it("unblocks after a lost clear acknowledgement is reconciled to an empty reference", async () => {
  const f = await fixture();
  try {
    const selected = f.document.select(file()),
      id = f.document.getSnapshot().origin!.id;
    await f.document.ready(id, client(), new AbortController().signal);
    await selected;
    f.loseReply();
    f.failReads(true);
    await expect(f.document.discard()).rejects.toThrow(/read failed/);
    expect(f.document.getSnapshot().blocked).toBe(true);
    f.failReads(false);
    await f.document.retry();
    expect(f.document.getSnapshot()).toMatchObject({
      origin: null,
      preparing: false,
      blocked: false,
      error: null,
    });
  } finally {
    f.document.dispose();
  }
});
