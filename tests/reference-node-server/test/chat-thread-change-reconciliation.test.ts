import { describe, expect, it, vi } from "vitest";

import { ChatThreadChangeReconciler } from "../src/chats/thread-change-reconciliation.js";

const notification = (
  revision: number,
  changes: Array<"turn" | "goal" | "queue" | "plan"> = ["turn"],
) => ({
  type: "chat.thread.changed" as const,
  threadId: "thread-1",
  revision,
  changes,
});

describe("chat thread change reconciliation", () => {
  it("drops duplicate and out-of-order revisions", async () => {
    const reconcile = vi.fn(async () => undefined);
    const scheduler = new ChatThreadChangeReconciler();

    expect(
      scheduler.schedule("worker:thread", notification(2), reconcile),
    ).toBe(true);
    expect(
      scheduler.schedule("worker:thread", notification(2), reconcile),
    ).toBe(false);
    expect(
      scheduler.schedule("worker:thread", notification(1), reconcile),
    ).toBe(false);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(reconcile).toHaveBeenCalledWith(notification(2));
  });

  it("runs one reconciliation at a time and coalesces newer changes", async () => {
    let releaseFirst: (() => void) | null = null;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const observations: unknown[] = [];
    const reconcile = vi.fn(async (observed) => {
      observations.push(observed);
      if (observations.length === 1) await first;
    });
    const scheduler = new ChatThreadChangeReconciler();

    scheduler.schedule("worker:thread", notification(10), reconcile);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    scheduler.schedule("worker:thread", notification(11, ["goal"]), reconcile);
    scheduler.schedule("worker:thread", notification(12, ["queue"]), reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    expect(observations[1]).toEqual(notification(12, ["goal", "queue"]));
  });

  it("stays bounded when every retained thread is busy", async () => {
    const never = new Promise<void>(() => undefined);
    const reconcile = vi.fn(async () => never);
    const scheduler = new ChatThreadChangeReconciler(() => undefined, 1);
    scheduler.schedule("first", notification(1), reconcile);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(scheduler.schedule("second", notification(1), reconcile)).toBe(
      false,
    );
    scheduler.clear();
  });
});
