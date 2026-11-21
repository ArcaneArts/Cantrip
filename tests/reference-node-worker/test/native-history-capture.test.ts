import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeHistoryCapture } from "../src/native-history-capture.js";
import { NativeHistorySourceJournal } from "../src/native-history-source-journal.js";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";
import { reduceNativeHistory } from "../src/native-history-reducer.js";

const directories: string[] = [];
const captures: NativeHistoryCapture[] = [];
afterEach(async () => {
  for (const capture of captures.splice(0)) capture.stop();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const snapshot = () =>
  parseCodexNativeHistory(
    { thread: { id: "thread", status: { type: "idle" }, turns: [] } },
    "thread",
  );
async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-history-capture-"),
  );
  directories.push(directory);
  const journal = await NativeHistorySourceJournal.open({
    directory,
    workerId: "worker",
    chatId: "chat",
    bindingId: "binding",
    threadId: "thread",
    service: {
      ownerId: () => "owner",
      serverIdentity: () => "server",
      componentKey: () => ({
        key: new Uint8Array(32).fill(31),
        keyRevision: 1,
      }),
    },
  });
  const observations = new NativeHistoryObservations();
  observations.replace("runtime-1");
  const read = vi.fn(async () => snapshot());
  const append = vi.fn((...args: Parameters<typeof journal.append>) =>
    journal.append(...args),
  );
  const errors = vi.fn();
  const published = vi.fn();
  const capture = new NativeHistoryCapture({
    runtime: {
      observeNativeHistory: (threadId, observer) =>
        observations.subscribe(threadId, observer, read),
    },
    threadId: "thread",
    journal: { append },
    retryDelayMs: 10,
    maxRetryDelayMs: 20,
    snapshotDelayMs: 0,
    onError: errors,
    onPersisted: published,
  });
  captures.push(capture);
  await capture.flush();
  const event = (itemId: string) =>
    observations.notification("item/completed", {
      threadId: "thread",
      turnId: "turn",
      item: { type: "agentMessage", id: itemId, text: "captured secret" },
    });
  return {
    journal,
    observations,
    read,
    append,
    errors,
    published,
    capture,
    event,
  };
}

describe("native history capture recovery", () => {
  it("waits for a stopped in-flight append before encryption can be released", async () => {
    const f = await fixture();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actual = f.append.getMockImplementation()!;
    f.append.mockImplementationOnce(async (...args) => {
      await hold;
      return actual(...args);
    });
    f.event("late-item");
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledTimes(2));
    f.capture.stop();
    let settled = false;
    const stopped = f.capture.whenStopped().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await stopped;
    expect(f.capture.pendingRecords).toBe(0);
    expect((await f.journal.read(0, 10)).at(-1)?.frame).toMatchObject({
      method: "item/completed",
      params: { item: { id: "late-item" } },
    });
    expect(f.published).toHaveBeenCalledTimes(1);
  });

  it("repairs a missing native predecessor across failed and stale reads without another event or UI reconnect", async () => {
    const f = await fixture();
    const cursor = (sequence: string, previousSequence: string | null) => ({
      epoch: "native",
      sequence,
      previousSequence,
    });
    f.read.mockRejectedValueOnce(new Error("snapshot temporarily unavailable"));
    // A successful but stale read is not evidence that the missing prefix arrived.
    f.read.mockResolvedValueOnce(snapshot());
    f.read.mockResolvedValueOnce(snapshot());
    f.read.mockResolvedValueOnce(
      parseCodexNativeHistory(
        {
          thread: { id: "thread", status: { type: "active" }, turns: [] },
          history: {
            version: 1,
            currentTurnId: "turn",
            currentTurnState: "live",
            turns: [],
            live: {
              epoch: "native",
              throughSequence: "3",
              items: [
                {
                  turnId: "turn",
                  item: { id: "answer", type: "agentMessage", text: "AB" },
                  state: "started",
                  startedAtMs: null,
                  completedAtMs: null,
                  cursor: cursor("3", "2"),
                },
              ],
            },
          },
        },
        "thread",
      ),
    );
    f.observations.notification(
      "item/started",
      {
        threadId: "thread",
        turnId: "turn",
        item: { id: "answer", type: "agentMessage", text: "" },
      },
      cursor("1", null),
    );
    f.observations.notification(
      "item/agentMessage/delta",
      { threadId: "thread", turnId: "turn", itemId: "answer", delta: "B" },
      cursor("3", "2"),
    );
    await f.capture.flush();
    expect(f.read).toHaveBeenCalledTimes(5);
    expect(f.errors).toHaveBeenCalledWith(expect.any(Error), "snapshot");
    const records = await f.journal.read();
    expect(
      records.find(
        (record) =>
          record.frame.kind === "notification" &&
          record.frame.method === "item/agentMessage/delta",
      )!.frame,
    ).toMatchObject({ nativeCursor: cursor("3", "2") });
    const repaired = reduceNativeHistory(null, records, "thread");
    expect(repaired.turns[0]!.items[0]!.body.text).toBe("AB");
    f.observations.notification(
      "item/agentMessage/delta",
      { threadId: "thread", turnId: "turn", itemId: "answer", delta: "C" },
      cursor("4", "3"),
    );
    await f.capture.flush();
    expect(f.read).toHaveBeenCalledTimes(5);
    expect(
      reduceNativeHistory(null, await f.journal.read(), "thread").turns[0]!
        .items[0]!.body.text,
    ).toBe("ABC");
  });

  it("does not read again for contiguous item cursors, unrelated item sequences or duplicate notifications", async () => {
    const f = await fixture();
    const cursor = (sequence: string, previousSequence: string | null) => ({
      epoch: "native",
      sequence,
      previousSequence,
    });
    for (const [id, start, next] of [
      ["one", "1", "3"],
      ["two", "2", "4"],
    ]) {
      f.observations.notification(
        "item/started",
        {
          threadId: "thread",
          turnId: "turn",
          item: { id, type: "agentMessage", text: "" },
        },
        cursor(start!, null),
      );
      f.observations.notification(
        "item/agentMessage/delta",
        { threadId: "thread", turnId: "turn", itemId: id, delta: "text" },
        cursor(next!, start!),
      );
      f.observations.notification(
        "item/agentMessage/delta",
        { threadId: "thread", turnId: "turn", itemId: id, delta: "text" },
        cursor(next!, start!),
      );
    }
    await f.capture.flush();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.errors).not.toHaveBeenCalled();
  });
  it("retries actual disk failure in order without a new event, UI reconnect or worker restart", async () => {
    const f = await fixture();
    const obstruction = path.join(
      f.journal.directory,
      "0000000000000002.source.json",
    );
    await mkdir(obstruction);
    f.event("one");
    f.event("two");
    await vi.waitFor(() =>
      expect(f.errors).toHaveBeenCalledWith(expect.any(Error), "append"),
    );
    expect(f.capture.pendingRecords).toBe(2);
    expect(
      f.append.mock.calls
        .slice(1)
        .every(
          ([frame]) => frame.kind === "notification" && frame.sequence === 1,
        ),
    ).toBe(true);
    await rm(obstruction, { recursive: true });
    await f.capture.flush();
    const events = (await f.journal.read()).filter(
      (entry) => entry.frame.kind === "notification",
    );
    expect(events.map((entry) => (entry.frame as any).params.item.id)).toEqual([
      "one",
      "two",
    ]);
    expect(f.capture.pendingRecords).toBe(0);
    expect(f.read).toHaveBeenCalledTimes(1); // Initial recovery read only.
  });

  it("retries an uncertain successful write with the exact captured frame", async () => {
    const f = await fixture();
    f.append.mockImplementationOnce(async (frame) => {
      await f.journal.append(frame);
      throw new Error("lost source persistence acknowledgment");
    });
    f.event("once");
    await f.capture.flush();
    expect(f.append.mock.calls).toHaveLength(3); // Initial snapshot + event + exact retry.
    expect(f.append.mock.calls[2]).toEqual(f.append.mock.calls[1]);
    expect(await f.journal.read()).toHaveLength(2);
  });

  it("retries a failed final snapshot while the source remains idle", async () => {
    const f = await fixture();
    f.read.mockRejectedValueOnce(new Error("read unavailable"));
    f.observations.notification("turn/completed", {
      threadId: "thread",
      turn: { id: "turn", status: "completed" },
    });
    await f.capture.flush();
    expect(f.errors).toHaveBeenCalledWith(expect.any(Error), "snapshot");
    expect(f.read).toHaveBeenCalledTimes(3);
    const records = await f.journal.read();
    expect(records.map((entry) => entry.frame.kind)).toEqual([
      "snapshot",
      "notification",
      "snapshot",
    ]);
    expect(records.at(-1)!.frame).toMatchObject({
      readBarrierSequence: 1,
      completedSequence: 1,
    });
  });

  it("an explicit snapshot begun during another read waits for a fresh read and durable append", async () => {
    const f = await fixture();
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.capture.reconcile();
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    f.event("during-read");
    const requested = f.capture.snapshot();
    finish(snapshot());
    const captured = await requested;
    expect(f.read).toHaveBeenCalledTimes(3);
    expect(captured.observation.readBarrierSequence).toBe(1);
    const records = await f.journal.read();
    expect(
      records.find((entry) => entry.sequence === captured.record.sequence)
        ?.frame,
    ).toEqual(captured.observation);
  });

  it("keeps observing and reading while storage is held without serializing native operations behind it", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.append.mockImplementationOnce(async (frame) => {
      await held;
      return f.journal.append(frame);
    });
    f.event("held");
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledTimes(2));
    f.observations.notification("turn/completed", {
      threadId: "thread",
      turn: { id: "turn", status: "interrupted" },
    });
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    expect(f.capture.pendingRecords).toBe(3);
    release();
    await f.capture.flush();
    expect(await f.journal.read()).toHaveLength(4);
  });

  it("retirement drains already captured events and rejects stale pending snapshots", async () => {
    const f = await fixture();
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const requested = f.capture.snapshot();
    const rejected = expect(requested).rejects.toThrow("replaced or closed");
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    f.event("old-runtime");
    f.observations.replace("runtime-2");
    f.event("replacement-runtime");
    finish(snapshot());
    await rejected;
    await f.capture.flush();
    const records = await f.journal.read();
    expect(records).toHaveLength(2);
    expect(records[1]!.frame).toMatchObject({
      kind: "notification",
      generation: "runtime-1",
    });
  });

  it("close detaches observation but keeps retrying a captured source until it is durable", async () => {
    const f = await fixture();
    f.append.mockRejectedValueOnce(new Error("disk temporarily unavailable"));
    f.event("retained");
    const closed = f.capture.close();
    f.event("after-close");
    await closed;
    expect(await f.journal.read()).toHaveLength(2);
    expect(f.errors).toHaveBeenCalledWith(expect.any(Error), "append");
  });

  it("explicit teardown rejects pending drains rather than claiming unsaved records committed", async () => {
    const f = await fixture();
    f.append.mockRejectedValue(new Error("storage remains unavailable"));
    f.event("unsaved");
    await vi.waitFor(() =>
      expect(f.errors).toHaveBeenCalledWith(expect.any(Error), "append"),
    );
    const drained = f.capture.flush();
    const rejected = expect(drained).rejects.toThrow(
      "stopped before confirming",
    );
    f.capture.stop();
    await rejected;
    expect(f.capture.pendingRecords).toBe(1);
    expect(await f.journal.read()).toHaveLength(1);
    await expect(f.capture.snapshot()).rejects.toThrow("no longer observing");
  });

  it("coalesces repeated dirty requests and survives failing diagnostic/notification callbacks", async () => {
    const f = await fixture();
    f.errors.mockImplementation(() => {
      throw new Error("logger failed");
    });
    f.published.mockImplementationOnce(() => {
      throw new Error("projector wake failed");
    });
    f.append.mockRejectedValueOnce(new Error("one disk failure"));
    for (let index = 0; index < 50; index++) f.capture.reconcile();
    await f.capture.flush();
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(await f.journal.read()).toHaveLength(2);
    expect(f.errors).toHaveBeenCalledWith(expect.any(Error), "notify");
    expect(f.errors).toHaveBeenCalledWith(expect.any(Error), "append");
    expect(f.published).toHaveBeenCalledTimes(3); // Initial source + failed wake + autonomous retry.
    expect(f.published.mock.calls[2]).toEqual(f.published.mock.calls[1]);
  });
});
