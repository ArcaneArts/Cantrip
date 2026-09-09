import { afterEach, describe, expect, it, vi } from "vitest";
import { publishPendingInteraction } from "../src/codex/pending-interaction-publication.js";

afterEach(() => vi.useRealTimers());

describe("pending native interaction publication", () => {
  it("recovers synchronous and asynchronous failures, then stops after acknowledgment", async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const publish = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("synchronous failure");
      })
      .mockRejectedValueOnce(new Error("lost acknowledgment"))
      .mockResolvedValue(undefined);
    const cancel = publishPendingInteraction({
      publish,
      failed,
      isCurrent: () => true,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(failed.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(3);
    cancel();
  });

  it("cancels while a publication is in flight without waiting for that transport", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const failed = vi.fn();
    const publish = vi.fn(
      () =>
        new Promise<void>((_resolve, no) => {
          reject = no;
        }),
    );
    const cancel = publishPendingInteraction({
      publish,
      failed,
      isCurrent: () => true,
    });
    cancel();
    reject(new Error("late transport failure"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("does not retry metadata after the pending request is replaced or resolved", async () => {
    vi.useFakeTimers();
    let current = true;
    const publish = vi.fn().mockRejectedValue(new Error("offline"));
    const cancel = publishPendingInteraction({
      publish,
      failed: vi.fn(),
      isCurrent: () => current,
    });
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(1);
    cancel();
  });
});
