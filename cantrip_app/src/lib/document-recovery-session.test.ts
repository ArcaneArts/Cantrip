import { generateAccountMasterKey } from "@cantrip/crypto";
import { expect, it, vi } from "vitest";
import { ClientEncryptionService } from "./client-encryption";
import { DocumentRecoverySession } from "./document-recovery-session";
import {
  DocumentRecoveryConflict,
  nextDocumentRecoveryRecord,
  readDocumentRecoveryRecord,
  type DocumentRecoveryRecord,
  type DocumentRecoveryStorage,
} from "./document-recovery-storage";

const binding = {
  serverId: "server",
  ownerId: "owner",
  workspaceId: "workspace",
  projectId: "project",
  workerId: "worker",
  worktreeId: "worktree",
  documentId: "document",
  tabId: "tab",
};
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
function fixture() {
  const service = new ClientEncryptionService();
  const accountMasterKey = generateAccountMasterKey();
  service.setAccountMasterKey({
    accountMasterKey,
    identity: binding,
    masterKeyRevision: 1,
  });
  let record: DocumentRecoveryRecord | undefined;
  const storage: DocumentRecoveryStorage = {
    read: vi.fn(async () => readDocumentRecoveryRecord(record)),
    write: vi.fn(async (_key, revision, envelope) => {
      record = nextDocumentRecoveryRecord(record, revision, envelope);
      return record;
    }),
  };
  return {
    service,
    accountMasterKey,
    storage,
    session: () => new DocumentRecoverySession(binding, storage, service),
  };
}

it("serializes edits and durable clearing, then restores through another session", async () => {
  const f = fixture(),
    source = f.session();
  expect(await source.load(decode)).toBeNull();
  const bytes = encode("first");
  const first = source.checkpoint(bytes);
  bytes.fill(0);
  await first;
  expect(await f.session().load(decode)).toBe("first");
  await Promise.all([
    source.checkpoint(encode("second")),
    source.checkpoint(null),
  ]);
  await source.flush();
  expect(await f.session().load(decode)).toBeNull();
});

it("does not replace a checkpoint whose decoded content failed validation", async () => {
  const f = fixture(),
    source = f.session();
  await source.load(decode);
  await source.checkpoint(encode("retained"));
  const destination = f.session();
  await expect(
    destination.load(() => {
      throw new Error("invalid document");
    }),
  ).rejects.toThrow("invalid document");
  await expect(destination.checkpoint(null)).rejects.toThrow(
    /Load and validate/,
  );
  expect(await f.session().load(decode)).toBe("retained");
});

it("rejects a stale writer rather than rebasing over a newer draft", async () => {
  const f = fixture(),
    first = f.session(),
    stale = f.session();
  await first.load(decode);
  await stale.load(decode);
  await first.checkpoint(encode("newer"));
  await expect(stale.checkpoint(encode("stale"))).rejects.toBeInstanceOf(
    DocumentRecoveryConflict,
  );
  await expect(stale.flush()).rejects.toBeInstanceOf(DocumentRecoveryConflict);
  expect(await f.session().load(decode)).toBe("newer");
});

it("flush retains actual write failures until a checkpoint succeeds", async () => {
  const f = fixture(),
    session = f.session();
  await session.load(decode);
  vi.mocked(f.storage.write).mockRejectedValueOnce(new Error("disk full"));
  await expect(session.checkpoint(encode("draft"))).rejects.toThrow(
    "disk full",
  );
  await expect(session.flush()).rejects.toThrow("disk full");
  await session.checkpoint(encode("draft"));
  await expect(session.flush()).resolves.toBeUndefined();
});

it("prevents queued writes after disposal", async () => {
  const f = fixture(),
    session = f.session();
  await session.load(decode);
  const pending = session.checkpoint(encode("draft"));
  session.dispose();
  await expect(pending).rejects.toThrow(/closed/);
  expect(f.storage.write).not.toHaveBeenCalled();
});

it("coalesces waiting edits behind an actual pending write without resolving them early", async () => {
  const f = fixture(),
    session = f.session();
  await session.load(decode);
  const original = f.storage.write;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.storage.write = vi.fn(
    async (...args: Parameters<DocumentRecoveryStorage["write"]>) => {
      entered();
      await hold;
      return original(...args);
    },
  );
  const first = session.checkpoint(encode("in flight"));
  await started;
  const second = session.checkpoint(encode("superseded"));
  const third = session.checkpoint(encode("latest"));
  expect(second).toBe(third);
  const completed = vi.fn();
  void third.then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  release();
  await Promise.all([first, second, third]);
  expect(f.storage.write).toHaveBeenCalledTimes(2);
  expect(await f.session().load(decode)).toBe("latest");
});

it("does not coalesce edits across an explicit clear barrier", async () => {
  const f = fixture(),
    session = f.session();
  await session.load(decode);
  await Promise.all([
    session.checkpoint(encode("before discard")),
    session.checkpoint(null),
    session.checkpoint(encode("after discard")),
  ]);
  expect(f.storage.write).toHaveBeenCalledTimes(3);
  expect(vi.mocked(f.storage.write).mock.calls[1]![2]).toBeNull();
  expect(await f.session().load(decode)).toBe("after discard");
});

it("renews the same account key after unlock without replaying the stored text", async () => {
  const f = fixture(),
    session = f.session();
  await session.load(decode);
  await session.checkpoint(encode("old checkpoint"));
  f.service.setAccountMasterKey({
    accountMasterKey: f.accountMasterKey,
    identity: binding,
    masterKeyRevision: 1,
  });
  await expect(session.checkpoint(encode("new live draft"))).rejects.toThrow(
    /changed/,
  );
  await session.renewEncryption();
  await session.checkpoint(encode("new live draft"));
  expect(await f.session().load(decode)).toBe("new live draft");
});

it("does not use encryption renewal to rebase a stale writer", async () => {
  const f = fixture(),
    source = f.session(),
    stale = f.session();
  await source.load(decode);
  await stale.load(decode);
  await source.checkpoint(encode("new owner"));
  f.service.setAccountMasterKey({
    accountMasterKey: f.accountMasterKey,
    identity: binding,
    masterKeyRevision: 1,
  });
  await expect(stale.renewEncryption()).rejects.toBeInstanceOf(
    DocumentRecoveryConflict,
  );
  await expect(stale.checkpoint(encode("obsolete"))).rejects.toThrow();
  expect(await f.session().load(decode)).toBe("new owner");
});

it("refuses renewal under another account or an unauthenticating replacement key", async () => {
  const f = fixture(),
    session = f.session();
  await session.load(decode);
  await session.checkpoint(encode("retained"));
  f.service.setAccountMasterKey({
    accountMasterKey: f.accountMasterKey,
    identity: { ...binding, ownerId: "other" },
    masterKeyRevision: 1,
  });
  await expect(session.renewEncryption()).rejects.toThrow();
  f.service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: binding,
    masterKeyRevision: 1,
  });
  await expect(session.renewEncryption()).rejects.toThrow();
  f.service.setAccountMasterKey({
    accountMasterKey: f.accountMasterKey,
    identity: binding,
    masterKeyRevision: 1,
  });
  expect(await f.session().load(decode)).toBe("retained");
});
