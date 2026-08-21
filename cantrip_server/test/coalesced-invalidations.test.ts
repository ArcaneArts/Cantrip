import { afterEach, describe, expect, it, vi } from "vitest";

import { CoalescedInvalidations } from "../src/live/coalesced-invalidations.js";

afterEach(() => vi.useRealTimers());

describe("coalesced live invalidations", () => {
  it("coalesces repeated state and flushes the latest value", async () => {
    vi.useFakeTimers();
    const published: string[] = [];
    const invalidations = new CoalescedInvalidations<string>({
      delayMs: 10_000,
      limit: 4,
      publish: (value) => published.push(value),
    });

    invalidations.schedule("project", "first");
    invalidations.schedule("project", "latest");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(published).toEqual(["latest"]);
  });

  it("flushes terminal state immediately and remains bounded", () => {
    vi.useFakeTimers();
    const published: string[] = [];
    const invalidations = new CoalescedInvalidations<string>({
      delayMs: 10_000,
      limit: 2,
      publish: (value) => published.push(value),
    });

    invalidations.schedule("one", "one");
    invalidations.schedule("two", "two");
    invalidations.schedule("three", "three");
    expect(published).toEqual(["one"]);
    invalidations.schedule("two", "two-terminal", true);
    expect(published).toEqual(["one", "two-terminal"]);

    invalidations.close();
    vi.runAllTimers();
    expect(published).toEqual(["one", "two-terminal"]);
  });
});
