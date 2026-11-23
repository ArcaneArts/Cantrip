import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { generateAccountMasterKey } from "@cantrip/crypto";
import { ClientEncryptionService } from "@/lib/client-encryption";
import { IndexedDocumentRecoveryStorage } from "@/lib/document-recovery-storage";
import { openNbtRecoveryVault } from "./recovery";
import {
  NbtRecoveryJournal,
  openIndexedNbtRecovery,
} from "@cantrip/nbt/recovery";
import { JAVA_NBT } from "@cantrip/nbt";
const binding = {
  serverId: "server",
  ownerId: "owner",
  workspaceId: "workspace",
  projectId: "project",
  workerId: "worker",
  worktreeId: "worktree",
  documentId: "document",
};
function fixture() {
  const service = new ClientEncryptionService(),
    accountMasterKey = generateAccountMasterKey();
  service.setAccountMasterKey({
    accountMasterKey,
    identity: binding,
    masterKeyRevision: 1,
  });
  return {
    service,
    accountMasterKey,
    storage: new IndexedDocumentRecoveryStorage(new IDBFactory()),
  };
}
it("creates one account-wrapped document key across concurrent views and reloads", async () => {
  const f = fixture(),
    [a, b] = await Promise.all([
      openNbtRecoveryVault(binding, f.storage, f.service),
      openNbtRecoveryVault(binding, f.storage, f.service),
    ]);
  expect(a.id).toBe(b.id);
  const first = await NbtRecoveryJournal.open(
    await openIndexedNbtRecovery(a.id),
    a.id,
    a.key,
  );
  try {
    await first.prepare(
      JAVA_NBT,
      "original",
      (async function* () {
        yield new Uint8Array([10, 0, 0, 0]);
      })(),
    );
    const next = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(b.id),
      b.id,
      b.key,
    );
    try {
      expect(await next.source().read(0, 4)).toEqual(
        new Uint8Array([10, 0, 0, 0]),
      );
    } finally {
      await next.close();
    }
  } finally {
    await first.close();
  }
  const restored = await openNbtRecoveryVault(binding, f.storage, f.service);
  expect(await restored.inspect()).toMatchObject({
    version: "original",
    size: 4,
  });
});
it("does not expose an extractable key and fences vault operations after account locking", async () => {
  const f = fixture(),
    vault = await openNbtRecoveryVault(binding, f.storage, f.service);
  await expect(crypto.subtle.exportKey("raw", vault.key)).rejects.toThrow();
  f.service.lock();
  expect(() => vault.assertCurrent()).toThrow("account changed or locked");
  await expect(vault.inspect()).rejects.toThrow("account changed or locked");
});
