import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { generateAccountMasterKey } from "@cantrip/crypto";
import { ClientEncryptionService } from "@/lib/client-encryption";
import { DocumentRecoverySession } from "@/lib/document-recovery-session";
import { documentRecoveryKey } from "@/lib/document-recovery-encryption";
import {
  IndexedDocumentRecoveryStorage,
  DocumentRecoveryConflict,
  type DocumentRecoveryStorage,
} from "@/lib/document-recovery-storage";
import { NbtLocalReferenceSession, nbtLocalReference } from "./local-reference";
const binding = {
  serverId: "server",
  ownerId: "owner",
  workspaceId: "workspace",
  projectId: "project",
  workerId: "worker",
  worktreeId: "worktree",
  documentId: "project-document",
};
const source = (name = "PRIVATE_LOCAL_WORLD.nbt") => ({
  version: 1 as const,
  id: crypto.randomUUID(),
  name,
});
function fixture() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: binding,
    masterKeyRevision: 1,
  });
  const inner = new IndexedDocumentRecoveryStorage(new IDBFactory());
  let before = false,
    after = false,
    read = false;
  const storage: DocumentRecoveryStorage = {
    async read(key) {
      if (read) throw new Error("Recovery read unavailable");
      return inner.read(key);
    },
    async write(...args) {
      if (before) {
        before = false;
        throw new Error("Recovery write unavailable");
      }
      const result = await inner.write(...args);
      if (after) {
        after = false;
        throw new Error("Recovery acknowledgement lost");
      }
      return result;
    },
  };
  return {
    service,
    inner,
    storage,
    open: (view = "view-one") =>
      NbtLocalReferenceSession.open(binding, view, storage, service),
    failBefore() {
      before = true;
    },
    loseReply() {
      after = true;
    },
    failReads(value: boolean) {
      read = value;
    },
  };
}
it("keeps local references encrypted, bound to a view, and recoverable after a window move", async () => {
  const f = fixture(),
    one = await f.open(),
    reference = source();
  await one.change(reference);
  const key = await documentRecoveryKey({
    ...binding,
    tabId: "nbt-local-reference-v1/view-one",
  });
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(await f.inner.read(key))).not.toContain(reference.name);
  const moved = await f.open(),
    other = await f.open("other-view");
  expect(moved.value).toEqual(reference);
  expect(other.value).toBeNull();
  const copy = moved.value!;
  copy.name = "caller mutation";
  expect(moved.value!.name).toBe(reference.name);
  await moved.change(null);
  const reopened = await f.open();
  expect(reopened.value).toBeNull();
  for (const item of [one, moved, other, reopened]) item.dispose();
});
it("does not overwrite another view owner's reference after a real CAS conflict", async () => {
  const f = fixture(),
    a = await f.open(),
    b = await f.open(),
    winner = source();
  try {
    await a.change(winner);
    await expect(b.change(source("other.nbt"))).rejects.toBeInstanceOf(
      DocumentRecoveryConflict,
    );
    expect(() => b.value).toThrow(/another renderer/);
    const actual = await f.open();
    expect(actual.value).toEqual(winner);
    actual.dispose();
  } finally {
    a.dispose();
    b.dispose();
  }
});
it("retains the previous source after a failed write, and permits an actual later retry", async () => {
  const f = fixture(),
    session = await f.open(),
    old = source(),
    next = source("next.nbt");
  try {
    await session.change(old);
    f.failBefore();
    await expect(session.change(next)).rejects.toThrow(/write unavailable/);
    expect(session.value).toEqual(old);
    await session.change(next);
    expect(session.value).toEqual(next);
  } finally {
    session.dispose();
  }
});
it("adopts its own committed source when only the publication acknowledgement is lost", async () => {
  const f = fixture(),
    session = await f.open(),
    next = source();
  try {
    f.loseReply();
    await session.change(next);
    expect(session.value).toEqual(next);
    f.loseReply();
    await session.change(null);
    expect(session.value).toBeNull();
    const reopened = await f.open();
    expect(reopened.value).toBeNull();
    reopened.dispose();
  } finally {
    session.dispose();
  }
});
it("preserves unknown publication state when both a reply and the reconciling read fail", async () => {
  const f = fixture(),
    session = await f.open(),
    next = source();
  try {
    f.loseReply();
    f.failReads(true);
    await expect(session.change(next)).rejects.toThrow(/read unavailable/);
    expect(() => session.value).toThrow(/another renderer/);
    f.failReads(false);
    const actual = await f.open();
    expect(actual.value).toEqual(next);
    actual.dispose();
  } finally {
    session.dispose();
  }
});
it("does not replace an encrypted malformed reference with an empty project-source fallback", async () => {
  const f = fixture(),
    raw = new DocumentRecoverySession(
      { ...binding, tabId: "nbt-local-reference-v1/view-one" },
      f.storage,
      f.service,
    );
  try {
    await raw.load(() => null);
    await raw.checkpoint(
      new TextEncoder().encode(JSON.stringify({ ...source(), version: 2 })),
    );
    const key = await documentRecoveryKey({
        ...binding,
        tabId: "nbt-local-reference-v1/view-one",
      }),
      before = await f.inner.read(key);
    await expect(f.open()).rejects.toThrow(/Invalid local NBT/);
    expect(await f.inner.read(key)).toEqual(before);
  } finally {
    raw.dispose();
  }
});
it("releases local names and fences further reference access when the account locks", async () => {
  const f = fixture(),
    session = await f.open();
  await session.change(source());
  f.service.lock();
  expect(() => session.value).toThrow(/account changed/);
  await expect(session.change(null)).rejects.toThrow(/account changed/);
  session.dispose();
  expect(() => session.value).toThrow(/closed/);
});
it("copies only the supported reference fields and rejects a path used as an identity", () => {
  const value = source();
  expect(
    nbtLocalReference({ ...value, parsedTree: { private: "value" } }),
  ).toEqual(value);
  expect(() =>
    nbtLocalReference({ ...value, id: "/Users/name/world.nbt" }),
  ).toThrow(/Invalid/);
});
