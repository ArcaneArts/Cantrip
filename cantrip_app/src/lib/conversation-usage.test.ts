import { afterEach, expect, it, vi } from "vitest";
import { ConversationUsageTracker } from "./conversation-usage";
afterEach(() => vi.useRealTimers());
it("coalesces one activation and retries exactly the same receipt without blocking", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("lost reply"))
    .mockResolvedValue({});
  const tracker = new ConversationUsageTracker(send, () => true);
  tracker.record("one");
  tracker.record("one");
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  tracker.record("one", "interaction");
  expect(send.mock.calls[2]![1].sequence).toBe(2);
  tracker.dispose();
});
it("drops older retry work when another chat is selected", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockRejectedValue(new Error("offline"));
  const tracker = new ConversationUsageTracker(send, () => true);
  tracker.record("one");
  await Promise.resolve();
  tracker.record("two");
  await vi.advanceTimersByTimeAsync(3000);
  expect(send.mock.calls.filter(([id]) => id === "one")).toHaveLength(1);
  expect(send.mock.calls.filter(([id]) => id === "two")).toHaveLength(3);
  expect(
    new Set(
      send.mock.calls
        .filter(([id]) => id === "two")
        .map(([, operation]) => operation.operationId),
    ).size,
  ).toBe(1);
  tracker.dispose();
});
it("does not retry or record after a session changes or a tracker is disposed", async () => {
  vi.useFakeTimers();
  let current = true;
  const send = vi.fn().mockRejectedValue(new Error("offline"));
  const tracker = new ConversationUsageTracker(send, () => current);
  tracker.record("one");
  await Promise.resolve();
  current = false;
  await vi.advanceTimersByTimeAsync(3000);
  tracker.record("two");
  expect(send).toHaveBeenCalledTimes(1);
  tracker.dispose();
  current = true;
  tracker.record("three");
  expect(send).toHaveBeenCalledTimes(1);
});
