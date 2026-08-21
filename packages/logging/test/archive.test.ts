import { describe, expect, it } from "vitest";

import {
  DailyLogArchive,
  type DailyLogArchiveEntry,
  type DailyLogArchiveStorage,
} from "../src/archive.js";

class MemoryStorage implements DailyLogArchiveStorage {
  files = new Map<
    string,
    { bytes: Uint8Array; createdAtMs: number; modifiedAtMs: number }
  >();
  now = Date.parse("2026-08-21T12:00:00.000Z");
  compressFailure = false;
  mutations: string[] = [];

  async ensureDirectory() {}

  async list(): Promise<DailyLogArchiveEntry[]> {
    return [...this.files].map(([name, file]) => ({
      createdAtMs: file.createdAtMs,
      modifiedAtMs: file.modifiedAtMs,
      name,
      size: file.bytes.byteLength,
    }));
  }

  async append(name: string, contents: Uint8Array) {
    const previous = this.files.get(name);
    const bytes = new Uint8Array(
      (previous?.bytes.byteLength ?? 0) + contents.byteLength,
    );
    if (previous) bytes.set(previous.bytes);
    bytes.set(contents, previous?.bytes.byteLength ?? 0);
    this.files.set(name, {
      bytes,
      createdAtMs: previous?.createdAtMs ?? this.now,
      modifiedAtMs: this.now,
    });
    this.mutations.push(`append:${name}`);
  }

  async compress(source: string, temporary: string, level: number) {
    expect(level).toBe(9);
    this.mutations.push(`compress:${source}`);
    if (this.compressFailure) throw new Error("simulated compression failure");
    const file = this.files.get(source)!;
    this.files.set(temporary, {
      ...file,
      bytes: file.bytes.slice(
        0,
        Math.max(1, Math.floor(file.bytes.byteLength / 2)),
      ),
      modifiedAtMs: this.now,
    });
  }

  async rename(source: string, destination: string) {
    this.files.set(destination, this.files.get(source)!);
    this.files.delete(source);
    this.mutations.push(`rename:${source}:${destination}`);
  }

  async remove(name: string) {
    this.files.delete(name);
    this.mutations.push(`remove:${name}`);
  }

  seed(name: string, size: number, createdAtMs = this.now) {
    this.files.set(name, {
      bytes: new Uint8Array(size),
      createdAtMs,
      modifiedAtMs: createdAtMs,
    });
  }
}

function archive(
  storage: MemoryStorage,
  options: { maxBytes?: number; now: () => Date; partBytes?: number },
) {
  return new DailyLogArchive({ source: "client", storage, ...options });
}

describe("daily log archives", () => {
  it("resumes the newest non-full part on the same UTC day", async () => {
    const storage = new MemoryStorage();
    storage.seed("client-2026-08-21.part-0001.jsonl", 20);
    const first = archive(storage, {
      now: () => new Date(storage.now),
      partBytes: 100,
    });
    await first.initialize();
    await first.append({ message: "same-day" });
    await first.close();
    expect(storage.mutations).toContain(
      "append:client-2026-08-21.part-0001.jsonl",
    );
  });

  it("opens a new part before a write exceeds the part limit", async () => {
    const storage = new MemoryStorage();
    storage.seed("client-2026-08-21.part-0001.jsonl", 90);
    const log = archive(storage, {
      now: () => new Date(storage.now),
      partBytes: 100,
    });
    await log.append({ message: "large-enough" });
    expect(storage.mutations.at(-1)).toBe(
      "append:client-2026-08-21.part-0002.jsonl",
    );
  });

  it("rolls over when the UTC day changes", async () => {
    const storage = new MemoryStorage();
    const log = archive(storage, { now: () => new Date(storage.now) });
    await log.append({ message: "before" });
    storage.now = Date.parse("2026-08-22T00:00:00.001Z");
    await log.append({ message: "after" });
    expect(
      storage.mutations.filter((entry) => entry.startsWith("append:")),
    ).toEqual([
      "append:client-2026-08-21.part-0001.jsonl",
      "append:client-2026-08-22.part-0001.jsonl",
    ]);
  });

  it("compresses only inactive parts older than 48 hours and preserves sources on failure", async () => {
    const storage = new MemoryStorage();
    const old = Date.parse("2026-08-18T11:59:59.000Z");
    const boundary = Date.parse("2026-08-19T12:00:00.000Z");
    storage.seed("client-2026-08-18.part-0001.jsonl", 50, old);
    storage.seed("client-2026-08-19.part-0001.jsonl", 50, boundary);
    storage.compressFailure = true;
    const failed = archive(storage, { now: () => new Date(storage.now) });
    await failed.initialize();
    expect(storage.files.has("client-2026-08-18.part-0001.jsonl")).toBe(true);
    storage.compressFailure = false;
    await failed.maintain();
    expect(storage.files.has("client-2026-08-18.part-0001.jsonl.gz")).toBe(
      true,
    );
    expect(storage.files.has("client-2026-08-19.part-0001.jsonl")).toBe(true);
  });

  it("counts compressed and plain parts, deletes oldest first, and ignores unrelated files", async () => {
    const storage = new MemoryStorage();
    storage.seed("client-2026-08-18.part-0001.jsonl.gz", 40);
    storage.seed("client-2026-08-19.part-0001.jsonl", 40);
    storage.seed("client-2026-08-20.part-0001.jsonl", 40);
    storage.seed("do-not-touch.txt", 1_000);
    const log = archive(storage, {
      maxBytes: 80,
      now: () => new Date(storage.now),
    });
    await log.initialize();
    expect(storage.files.has("client-2026-08-18.part-0001.jsonl.gz")).toBe(
      false,
    );
    expect(storage.files.has("client-2026-08-19.part-0001.jsonl")).toBe(true);
    expect(storage.files.has("do-not-touch.txt")).toBe(true);
  });

  it("serializes concurrent appends", async () => {
    const storage = new MemoryStorage();
    const log = archive(storage, {
      now: () => new Date(storage.now),
      partBytes: 80,
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => log.append({ index })),
    );
    const lines = [...storage.files.values()].reduce(
      (count, file) =>
        count + new TextDecoder().decode(file.bytes).trim().split("\n").length,
      0,
    );
    expect(lines).toBe(12);
  });

  it("adopts only explicitly named legacy rotations", async () => {
    const storage = new MemoryStorage();
    storage.seed(
      "client.service.jsonl.1",
      25,
      Date.parse("2026-08-20T08:00:00.000Z"),
    );
    storage.seed("unrelated.service.jsonl", 25);
    const log = new DailyLogArchive({
      legacyFileNames: ["client.service.jsonl"],
      now: () => new Date(storage.now),
      source: "client",
      storage,
    });
    await log.initialize();
    expect(
      [...storage.files.keys()].some((name) =>
        name.startsWith("client-2026-08-20.part-"),
      ),
    ).toBe(true);
    expect(storage.files.has("unrelated.service.jsonl")).toBe(true);
  });

  it("keeps component quota accounting independent", async () => {
    const clientStorage = new MemoryStorage();
    const workerStorage = new MemoryStorage();
    clientStorage.seed("client-2026-08-18.part-0001.jsonl.gz", 60);
    clientStorage.seed("client-2026-08-19.part-0001.jsonl.gz", 60);
    workerStorage.seed("worker-2026-08-18.part-0001.jsonl.gz", 60);
    workerStorage.seed("worker-2026-08-19.part-0001.jsonl.gz", 60);
    const client = new DailyLogArchive({
      maxBytes: 100,
      now: () => new Date(clientStorage.now),
      source: "client",
      storage: clientStorage,
    });
    const worker = new DailyLogArchive({
      maxBytes: 100,
      now: () => new Date(workerStorage.now),
      source: "worker",
      storage: workerStorage,
    });
    await client.initialize();
    expect(
      [...clientStorage.files.values()].reduce(
        (sum, file) => sum + file.bytes.byteLength,
        0,
      ),
    ).toBe(60);
    expect(
      [...workerStorage.files.values()].reduce(
        (sum, file) => sum + file.bytes.byteLength,
        0,
      ),
    ).toBe(120);
    await worker.initialize();
    expect(
      [...workerStorage.files.values()].reduce(
        (sum, file) => sum + file.bytes.byteLength,
        0,
      ),
    ).toBe(60);
  });
});
