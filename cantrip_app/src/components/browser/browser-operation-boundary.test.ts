import { expect, it, vi } from "vitest";
import { BrowserOperationBoundary } from "./browser-operation-boundary";

it("drains accepted asynchronous navigation while rejecting new input", async () => {
  const boundary = new BrowserOperationBoundary();
  let finish!: () => void;
  const send = vi.fn();
  const navigation = boundary.run(async (current) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (current()) send();
  });
  await Promise.resolve();
  const release = boundary.suspend();
  expect(boundary.accepting).toBe(false);
  await expect(boundary.run(async () => {})).rejects.toThrow(/suspended/);
  let drained = false;
  const drain = boundary.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await navigation;
  await drain;
  expect(send).toHaveBeenCalledOnce();
  release();
  expect(boundary.accepting).toBe(true);
  const second = boundary.suspend();
  release();
  expect(boundary.accepting).toBe(false);
  second();
});

it("rejects capture after cancellation and never replays failed operations", async () => {
  const boundary = new BrowserOperationBoundary();
  let fail!: (error: Error) => void;
  const action = boundary.run(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  await Promise.resolve();
  const release = boundary.suspend();
  const drain = boundary.drain();
  fail(new Error("encryption failed"));
  await expect(action).rejects.toThrow("encryption failed");
  await expect(drain).rejects.toThrow("encryption failed");
  release();
  const retryRelease = boundary.suspend();
  await boundary.drain();
  retryRelease();
});

it("fences disposal and stale cancellation while asynchronous input is pending", async () => {
  const boundary = new BrowserOperationBoundary();
  let finish!: () => void;
  const send = vi.fn();
  const action = boundary.run(async (current) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (current()) send();
  });
  await Promise.resolve();
  const release = boundary.suspend();
  const drain = boundary.drain();
  boundary.dispose();
  finish();
  await action;
  await expect(drain).rejects.toThrow(/cancelled/);
  release();
  expect(boundary.accepting).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
