import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { generateAccountMasterKey } from "@cantrip/crypto";
import { JAVA_NBT } from "@cantrip/nbt";
import { NbtDocumentEngine } from "@cantrip/nbt/document";
import {
  NbtRecoveryJournal,
  openIndexedNbtRecovery,
} from "@cantrip/nbt/recovery";
import { ClientEncryptionService } from "@/lib/client-encryption";
import { IndexedDocumentRecoveryStorage } from "@/lib/document-recovery-storage";
import { openNbtRecoveryVault } from "./recovery";
import { openRecoveredNbtSource } from "./local-source";
async function fixture(prepare = true) {
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
  const vault = await openNbtRecoveryVault(
      binding,
      new IndexedDocumentRecoveryStorage(new IDBFactory()),
      service,
    ),
    journal = await NbtRecoveryJournal.open(
      await openIndexedNbtRecovery(vault.id),
      vault.id,
      vault.key,
    ),
    bytes = new Uint8Array([
      10, 0, 0, 4, 0, 1, 110, 0, 0, 0, 0, 0, 0, 0, 42, 0,
    ]);
  if (prepare)
    await journal.prepare(
      JAVA_NBT,
      "local-unique-baseline",
      (async function* () {
        yield bytes;
      })(),
    );
  return { vault, journal, service, bytes };
}
it("provides bounded original bytes and an immutable baseline identity without a browser File", async () => {
  const f = await fixture(),
    source = await openRecoveredNbtSource(f.vault);
  try {
    expect(source.version).toBe("local-unique-baseline");
    expect(source.retainOriginal).toBe(true);
    expect(await source.read(0, 16)).toEqual(f.bytes);
    await expect(source.read(0, 256 * 1024 + 1)).rejects.toThrow(/bounded/);
  } finally {
    await source.close();
    await f.journal.close();
  }
  await expect(source.read(0, 1)).rejects.toThrow(/closed/);
});
it("keeps an exact export available after a validated replacement retires its old journal", async () => {
  const f = await fixture(),
    source = await openRecoveredNbtSource(f.vault),
    engine = await NbtDocumentEngine.open(source, {
      binding: crypto.randomUUID(),
      version: source.version,
      format: JAVA_NBT,
      retainOriginal: source.retainOriginal,
      cacheBytes: 128 * 1024,
    });
  try {
    await engine.completed;
    await f.journal.clear();
    await expect(source.read(0, 16)).rejects.toThrow(/missing|unavailable/i);
    const chunks = [];
    for await (const chunk of engine.serialize(true)) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(f.bytes));
  } finally {
    await engine.close();
    await source.close();
    await f.journal.close();
  }
});
it("reports an actually absent local baseline without falling through to a project path", async () => {
  const f = await fixture(false);
  try {
    await expect(openRecoveredNbtSource(f.vault)).rejects.toThrow(
      /no longer in recovery/,
    );
  } finally {
    await f.journal.close();
  }
});
it("closes local recovery access when its account locks or its opening view aborts", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    source = await openRecoveredNbtSource(f.vault, controller.signal);
  try {
    controller.abort(new Error("View retired"));
    await expect(source.read(0, 16)).rejects.toThrow(/View retired/);
    const other = await openRecoveredNbtSource(f.vault);
    f.service.lock();
    await expect(other.read(0, 16)).rejects.toThrow(/closed|account changed/);
    await other.close();
  } finally {
    await source.close();
    await f.journal.close();
  }
});
