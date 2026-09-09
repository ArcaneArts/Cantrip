import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  mkdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";
import { openNativeHistoryBatch } from "../src/native-history-content.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";
import type {
  NativeHistoryNotification,
  NativeHistorySnapshotObservation,
} from "../src/codex/native-history-observation.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const notification = (
  sequence: number,
  generation = "runtime-1",
): NativeHistoryNotification => ({
  kind: "notification",
  generation,
  sequence,
  threadId: "thread",
  receivedAtMs: sequence,
  method: "item/completed",
  params: {
    threadId: "thread",
    turnId: "turn",
    item: {
      id: `native-${sequence}`,
      type: "agentMessage",
      text: "private source message",
    },
  },
});
const snapshot = (): NativeHistorySnapshotObservation => ({
  kind: "snapshot",
  generation: "runtime-1",
  id: "00000000-0000-4000-8000-000000000001",
  threadId: "thread",
  receivedAtMs: 3,
  readBarrierSequence: 1,
  completedSequence: 2,
  snapshot: parseCodexNativeHistory(
    {
      thread: {
        id: "thread",
        status: { type: "idle" },
        turns: [
          {
            id: "turn",
            status: "completed",
            items: [
              {
                id: "native-1",
                type: "agentMessage",
                text: "private source message",
              },
            ],
          },
        ],
      },
    },
    "thread",
  ),
});
async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-history-source-"),
  );
  directories.push(directory);
  let owner = "owner";
  let revision = 1;
  const input = {
    directory,
    workerId: "worker",
    chatId: "chat",
    bindingId: "binding",
    threadId: "thread",
    service: {
      ownerId: () => owner,
      serverIdentity: () => "server",
      componentKey: (_scope: string, at = revision) => ({
        key: new Uint8Array(32).fill(at),
        keyRevision: at,
      }),
    },
  };
  return {
    input,
    journal: await NativeHistorySourceJournal.open(input),
    owner: (next: string) => {
      owner = next;
    },
    rotate: () => {
      revision++;
    },
  };
}

describe("encrypted native history source journal", () => {
  it("discovers only existing owned journals and isolates damaged identities without creating replacements", async () => {
    const f = await fixture();
    await f.journal.append(notification(1));
    const other = await NativeHistorySourceJournal.open({
      ...f.input,
      workerId: "other-worker",
    });
    await other.append(notification(1));
    const foreignService = { ...f.input.service, ownerId: () => "other-owner" };
    const foreign = await NativeHistorySourceJournal.open({
      ...f.input,
      service: foreignService,
    });
    await foreign.append(notification(1));
    const broken = await NativeHistorySourceJournal.open({
      ...f.input,
      chatId: "broken",
    });
    await broken.append(notification(1));
    const manifest = path.join(broken.directory, "source.json");
    const bytes = await readFile(manifest);
    await rm(manifest);
    const collect = async (
      known?: (scope: typeof f.journal.scope, journalId: string) => boolean,
    ) => {
      const entries = [];
      for await (const entry of NativeHistorySourceJournal.recover({
        ...f.input,
        known,
      }))
        entries.push(entry);
      return entries;
    };
    const recovered = await collect();
    expect(
      recovered
        .filter((entry) => entry.journal)
        .map((entry) => entry.journal!.journalId),
    ).toEqual([f.journal.journalId]);
    expect(recovered.filter((entry) => entry.error)).toHaveLength(1);
    await expect(readFile(manifest)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await recovered.find((entry) => entry.journal)!.journal!.read(),
    ).toEqual(await f.journal.read());
    await writeFile(manifest, bytes);
    expect(
      (await collect()).map((entry) => entry.journal!.journalId).sort(),
    ).toEqual([f.journal.journalId, broken.journalId].sort());
    const known: string[] = [];
    expect(
      await collect((_scope, journalId) => {
        known.push(journalId);
        return true;
      }),
    ).toEqual([]);
    expect(known.sort()).toEqual(
      [f.journal.journalId, broken.journalId].sort(),
    );
  });

  it("does not create a missing recovery directory and rejects recovery after cancellation", async () => {
    const f = await fixture();
    const missing = path.join(f.input.directory, "absent");
    const found = [];
    for await (const entry of NativeHistorySourceJournal.recover({
      ...f.input,
      directory: missing,
    }))
      found.push(entry);
    expect(found).toEqual([]);
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    const abort = new AbortController();
    abort.abort(new Error("cancel recovery"));
    await expect(async () => {
      for await (const _entry of NativeHistorySourceJournal.recover({
        ...f.input,
        signal: abort.signal,
      })) {
        /* No entries should be yielded. */
      }
    }).rejects.toThrow("cancel recovery");
  });

  it("recovers exact ordered source events and snapshot barriers in bounded pages across reopen and key rotation", async () => {
    const f = await fixture();
    const first = await f.journal.append(notification(1));
    f.rotate();
    await f.journal.append(notification(2));
    await f.journal.append(snapshot());
    await f.journal.append(notification(1, "runtime-2"));
    expect(await f.journal.append(notification(1))).toEqual(first);
    const reopened = await NativeHistorySourceJournal.open(f.input);
    expect(reopened.journalId).toBe(f.journal.journalId);
    const page = await reopened.read(0, 2);
    expect(page.map((entry) => entry.frame)).toEqual([
      notification(1),
      notification(2),
    ]);
    const tail = await reopened.read(page.at(-1)!.sequence, 2);
    expect(tail.map((entry) => entry.frame)).toEqual([
      snapshot(),
      notification(1, "runtime-2"),
    ]);
    expect(await reopened.read(4)).toEqual([]);
    await expect(reopened.read(5)).rejects.toThrow("checkpoint is ahead");
    for (const filename of await readdir(reopened.directory)) {
      const stored = await readFile(
        path.join(reopened.directory, filename),
        "utf8",
      );
      expect(stored).not.toContain("private source message");
      expect(stored).not.toContain("agentMessage");
      if (process.platform !== "win32")
        expect(
          (await stat(path.join(reopened.directory, filename))).mode & 0o777,
        ).toBe(0o600);
    }
  });

  it("separates raw source encryption from deliverable prepared batches", async () => {
    const f = await fixture();
    const header = await f.journal.append(notification(1));
    const stored = JSON.parse(
      await readFile(
        path.join(f.journal.directory, "0000000000000001.source.json"),
        "utf8",
      ),
    );
    await expect(
      openNativeHistoryBatch({
        service: f.input.service,
        context: {
          workerId: "worker",
          chatId: "chat",
          bindingId: "binding",
          streamId: f.journal.journalId,
          sequence: header.sequence,
          recordId: header.recordId,
          previousDigest: header.previousDigest,
        },
        envelope: stored.envelope,
      }),
    ).rejects.toThrow();
    expect((await f.journal.read())[0]!.frame).toEqual(notification(1));
  });

  it("serializes separate handles and deduplicates the same source without losing successor events", async () => {
    const f = await fixture();
    const other = await NativeHistorySourceJournal.open(f.input);
    const [first, same] = await Promise.all([
      f.journal.append(notification(1)),
      other.append(notification(1)),
    ]);
    expect(first).toEqual(same);
    await Promise.all([
      other.append(notification(2)),
      f.journal.append(notification(3)),
    ]);
    expect((await other.read()).map((entry) => entry.frame)).toEqual([
      notification(1),
      notification(2),
      notification(3),
    ]);
    await expect(
      other.append({ ...notification(1), method: "item/started" }),
    ).rejects.toThrow("reused with different content");
  });

  it("reports actual disk failures and permits retry with the original frame after repair", async () => {
    const f = await fixture();
    const obstruction = path.join(
      f.journal.directory,
      "0000000000000001.source.json",
    );
    await mkdir(obstruction);
    await expect(f.journal.append(notification(1))).rejects.toThrow();
    await rm(obstruction, { recursive: true });
    expect((await f.journal.append(notification(1))).sequence).toBe(1);
    expect((await f.journal.read())[0]!.frame).toEqual(notification(1));
  });

  it("does not reinterpret missing durable identity or a missing source record as an empty journal", async () => {
    const f = await fixture();
    await f.journal.append(notification(1));
    await f.journal.append(notification(2));
    await rm(path.join(f.journal.directory, "0000000000000001.source.json"));
    await expect(f.journal.read()).rejects.toThrow("missing records");
    await expect(NativeHistorySourceJournal.open(f.input)).rejects.toThrow(
      "missing records",
    );
    await rm(path.join(f.journal.directory, "source.json"));
    await expect(NativeHistorySourceJournal.open(f.input)).rejects.toThrow(
      "lost its identity",
    );
  });

  it("pins ownership and snapshots caller data before asynchronous persistence", async () => {
    const f = await fixture();
    const frame = notification(1);
    const pending = f.journal.append(frame);
    frame.params.item = { id: "changed", text: "caller changed it" };
    await pending;
    expect((await f.journal.read())[0]!.frame).toEqual(notification(1));
    await expect(
      f.journal.append({ ...notification(2), threadId: "another-thread" }),
    ).rejects.toThrow("another thread");
    await expect(
      f.journal.append({ ...snapshot(), readBarrierSequence: 20 }),
    ).rejects.toThrow("invalid snapshot barrier");
    f.owner("another-owner");
    await expect(f.journal.read()).rejects.toThrow(
      "encryption identity changed",
    );
    await expect(f.journal.append(notification(2))).rejects.toThrow(
      "encryption identity changed",
    );
  });
});
