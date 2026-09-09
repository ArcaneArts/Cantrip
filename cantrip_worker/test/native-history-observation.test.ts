import { describe, expect, it, vi } from "vitest";
import {
  NativeHistoryObservations,
  type NativeHistoryNotification,
} from "../src/codex/native-history-observation.js";
import { parseCodexNativeHistory } from "../src/codex/native-history.js";

const snapshot = (threadId = "thread") =>
  parseCodexNativeHistory(
    {
      thread: { id: threadId, status: { type: "idle" }, turns: [] },
    },
    threadId,
  );
function fixture() {
  const observations = new NativeHistoryObservations();
  observations.replace("runtime-1");
  const events: NativeHistoryNotification[] = [];
  const error = vi.fn();
  const read = vi.fn(async () => snapshot());
  const subscription = observations.subscribe(
    "thread",
    {
      capture: (event) => {
        events.push(event);
      },
      onError: error,
    },
    read,
  );
  return { observations, events, error, read, subscription };
}

describe("native history source observations", () => {
  it("captures exact thread-scoped events including unknown and late methods without a GUI turn", () => {
    const f = fixture();
    f.observations.notification("thread/started", {
      thread: { id: "thread", forkedFromId: "original" },
    });
    f.observations.notification("turn/completed", {
      threadId: "thread",
      turn: { id: "turn", status: "completed" },
    });
    f.observations.notification("item/completed", {
      threadId: "thread",
      turnId: "turn",
      item: { id: "late-child", type: "subAgentActivity", kind: "completed" },
    });
    f.observations.notification("future/native/progress", {
      threadId: "thread",
      bytes: "private raw payload",
    });
    f.observations.notification("item/completed", {
      threadId: "other-thread",
      item: { id: "other" },
    });
    f.observations.notification("account/updated", { account: "other" });
    expect(f.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(f.events[0]!.params).toEqual({
      thread: { id: "thread", forkedFromId: "original" },
    });
    expect(f.events[3]!.params.bytes).toBe("private raw payload");
    expect(f.events.every((event) => event.generation === "runtime-1")).toBe(
      true,
    );
    expect(f.error).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it("records both sides of an actual in-flight snapshot instead of labeling concurrent events old", async () => {
    const f = fixture();
    f.observations.notification("item/started", {
      threadId: "thread",
      item: { id: "item" },
    });
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.subscription.readSnapshot();
    f.observations.notification("item/completed", {
      threadId: "thread",
      item: { id: "item", text: "new content" },
    });
    finish(snapshot());
    const frame = await pending;
    expect(frame).toMatchObject({
      kind: "snapshot",
      generation: "runtime-1",
      threadId: "thread",
      readBarrierSequence: 1,
      completedSequence: 2,
    });
    expect(f.events[1]!.sequence).toBeGreaterThan(frame.readBarrierSequence);
    expect((await f.subscription.readSnapshot()).readBarrierSequence).toBe(2);
  });

  it("keeps a failed snapshot retryable on the same observation", async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("capture read failed"));
    await expect(f.subscription.readSnapshot()).rejects.toThrow(
      "capture read failed",
    );
    expect(f.subscription.signal.aborted).toBe(false);
    f.observations.notification("item/completed", {
      threadId: "thread",
      item: { id: "after-failure" },
    });
    expect((await f.subscription.readSnapshot()).completedSequence).toBe(1);
  });

  it("retires old subscriptions and rejects in-flight snapshots when a runtime is replaced", async () => {
    const f = fixture();
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.subscription.readSnapshot();
    f.observations.replace("runtime-2");
    finish(snapshot());
    await expect(pending).rejects.toThrow("replaced or closed");
    expect(f.subscription.signal.aborted).toBe(true);
    const successor: NativeHistoryNotification[] = [];
    f.observations.subscribe(
      "thread",
      {
        capture: (event) => {
          successor.push(event);
        },
        onError: f.error,
      },
      f.read,
    );
    f.observations.notification("item/completed", {
      threadId: "thread",
      item: { id: "successor" },
    });
    expect(f.events).toEqual([]);
    expect(successor[0]).toMatchObject({
      generation: "runtime-2",
      sequence: 1,
    });
  });

  it("isolates consumer mutation and asynchronous failures without blocking later native events", async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumerError = vi.fn(() => {
      throw new Error("diagnostic failure");
    });
    f.observations.subscribe(
      "thread",
      {
        capture: async (event) => {
          (event.params.item as { text: string }).text = "consumer mutation";
          await held;
          throw new Error("disk unavailable");
        },
        onError: consumerError,
      },
      f.read,
    );
    const params = { threadId: "thread", item: { text: "original" } };
    f.observations.notification("item/started", params);
    f.observations.notification("item/completed", params);
    expect(f.events).toHaveLength(2);
    expect(params.item.text).toBe("original");
    expect(f.events[0]!.params.item).toEqual({ text: "original" });
    expect((await f.subscription.readSnapshot()).completedSequence).toBe(2);
    release();
    await vi.waitFor(() => expect(consumerError).toHaveBeenCalledTimes(2));
    expect(consumerError.mock.calls[0]).toEqual([
      expect.any(Error),
      expect.not.objectContaining({ params: expect.anything() }),
    ]);
  });

  it("does not leak an old frame into a subscription created during replacement", () => {
    const f = fixture();
    const next = vi.fn();
    f.observations.subscribe(
      "thread",
      {
        capture: () => {
          f.observations.replace("runtime-2");
          f.observations.subscribe(
            "thread",
            { capture: next, onError: f.error },
            f.read,
          );
        },
        onError: f.error,
      },
      f.read,
    );
    f.observations.notification("item/completed", { threadId: "thread" });
    expect(next).not.toHaveBeenCalled();
    f.observations.notification("item/completed", { threadId: "thread" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ generation: "runtime-2", sequence: 1 }),
    );
  });

  it("closing an observation leaves sibling observers usable", async () => {
    const f = fixture();
    const second = f.observations.subscribe(
      "thread",
      { capture: vi.fn(), onError: f.error },
      f.read,
    );
    f.subscription.close();
    f.observations.notification("turn/completed", { threadId: "thread" });
    expect(f.events).toEqual([]);
    expect(second.signal.aborted).toBe(false);
    expect((await second.readSnapshot()).completedSequence).toBe(1);
    await expect(f.subscription.readSnapshot()).rejects.toThrow(
      "observation was closed",
    );
  });
});
