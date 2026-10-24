import { expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  DocumentRecoveryConflict,
  IndexedDocumentRecoveryStorage,
  nextDocumentRecoveryRecord,
  readDocumentRecoveryRecord,
} from "./document-recovery-storage";

it("distinguishes an absent draft from malformed or unsupported stored data", () => {
  expect(readDocumentRecoveryRecord(undefined)).toEqual({
    version: 1,
    revision: 0,
    envelope: null,
  });
  for (const value of [
    null,
    {},
    { version: 2, revision: 1, envelope: null },
    { version: 1, revision: 0, envelope: null, plaintext: "secret" },
  ])
    expect(() => readDocumentRecoveryRecord(value)).toThrow();
});

it("retains a tombstone revision so delayed writers cannot resurrect discarded drafts", () => {
  const discarded = nextDocumentRecoveryRecord(undefined, 0, null);
  expect(discarded.revision).toBe(1);
  expect(() => nextDocumentRecoveryRecord(discarded, 0, null)).toThrow(
    DocumentRecoveryConflict,
  );
  expect(nextDocumentRecoveryRecord(discarded, 1, null).revision).toBe(2);
});

it("rejects revision overflow instead of losing ordering precision", () => {
  expect(() =>
    nextDocumentRecoveryRecord(
      { version: 1, revision: Number.MAX_SAFE_INTEGER, envelope: null },
      Number.MAX_SAFE_INTEGER,
      null,
    ),
  ).toThrow();
});

it("rejects plaintext keys and reports unavailable storage rather than an empty draft", async () => {
  const storage = new IndexedDocumentRecoveryStorage(undefined);
  await expect(storage.read("/private/project/file.rs")).rejects.toThrow();
  await expect(storage.read("a".repeat(64))).rejects.toThrow(/unavailable/);
});

it("makes committed tombstones visible to a new storage instance", async () => {
  const factory = new IDBFactory();
  const key = "a".repeat(64);
  const first = new IndexedDocumentRecoveryStorage(factory);
  expect(await first.read(key)).toEqual({
    version: 1,
    revision: 0,
    envelope: null,
  });
  await first.write(key, 0, null);
  const reopened = new IndexedDocumentRecoveryStorage(factory);
  expect(await reopened.read(key)).toEqual({
    version: 1,
    revision: 1,
    envelope: null,
  });
  await expect(reopened.write(key, 0, null)).rejects.toBeInstanceOf(
    DocumentRecoveryConflict,
  );
  expect((await first.read(key)).revision).toBe(1);
  expect((await reopened.write(key, 1, null)).revision).toBe(2);
});

it("does not replace a corrupt persisted record with an empty recovery record", async () => {
  const factory = new IDBFactory();
  const key = "b".repeat(64);
  const storage = new IndexedDocumentRecoveryStorage(factory);
  await storage.read(key);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("cantrip-protected-document-recovery", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("documents", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore("documents").put({ version: 99 }, key);
    });
    await expect(storage.read(key)).rejects.toThrow();
    await expect(storage.write(key, 0, null)).rejects.toThrow();
    const retained = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction("documents", "readonly");
      const request = transaction.objectStore("documents").get(key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
    expect(retained).toEqual({ version: 99 });
  } finally {
    database.close();
  }
});

it("allows exactly one writer to commit against a shared revision", async () => {
  const factory = new IDBFactory();
  const key = "c".repeat(64);
  const writers = Array.from(
    { length: 4 },
    () => new IndexedDocumentRecoveryStorage(factory),
  );
  const results = await Promise.allSettled(
    writers.map((writer) => writer.write(key, 0, null)),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = results.filter((result) => result.status === "rejected");
  expect(rejected).toHaveLength(3);
  for (const result of rejected)
    expect(result.reason).toBeInstanceOf(DocumentRecoveryConflict);
  expect((await writers[0]!.read(key)).revision).toBe(1);
});
