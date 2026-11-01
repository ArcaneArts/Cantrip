import { afterEach, expect, it, vi } from "vitest";
import type { NbtDocumentClient, NbtEditStatus } from "@cantrip/nbt/document";
import { acquireNbtSession, clearNbtSessions } from "./session-registry";

function client() {
  let status: NbtEditStatus = {
    revision: 0,
    dirty: false,
    canUndo: false,
    canRedo: false,
    version: "version",
    saving: false,
    uncertain: false,
  };
  const listeners = new Set<() => void>();
  const api = {
    close: vi.fn(async () => {}),
    setPaused: vi.fn(async () => {}),
    getEditSnapshot: () => status,
    subscribeEdits: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    api: api as unknown as NbtDocumentClient,
    close: api.close,
    paused: api.setPaused,
    update(patch: Partial<NbtEditStatus>) {
      status = { ...status, ...patch };
      for (const listener of listeners) listener();
    },
  };
}
afterEach(async () => {
  await clearNbtSessions();
  vi.useRealTimers();
});
it("shares one worker across views and pauses only when every lease is inactive", async () => {
  vi.useFakeTimers();
  const value = client(),
    open = vi.fn(async () => value.api);
  const first = acquireNbtSession("same-document", open, true),
    second = acquireNbtSession("same-document", open, false);
  expect(await first.promise).toBe(await second.promise);
  expect(open).toHaveBeenCalledTimes(1);
  first.setActive(false);
  expect(value.paused).toHaveBeenLastCalledWith(true);
  second.setActive(true);
  expect(value.paused).toHaveBeenLastCalledWith(false);
  first.release();
  await vi.runAllTimersAsync();
  expect(value.close).not.toHaveBeenCalled();
  second.release();
  await vi.runAllTimersAsync();
  expect(value.close).toHaveBeenCalledTimes(1);
});
it.each([
  { dirty: true },
  { pendingSaveId: "save", uncertain: true },
  { editing: true },
])(
  "retains detached owned work %o and reattaches it without reopening",
  async (patch) => {
    vi.useFakeTimers();
    const value = client(),
      open = vi.fn(async () => value.api);
    const view = acquireNbtSession("draft", open, true),
      session = await view.promise;
    value.update(patch);
    view.release();
    await vi.runAllTimersAsync();
    expect(value.close).not.toHaveBeenCalled();
    const restored = acquireNbtSession("draft", open, true);
    expect(await restored.promise).toBe(session);
    expect(open).toHaveBeenCalledTimes(1);
    restored.release();
    value.update({
      dirty: false,
      pendingSaveId: undefined,
      editing: false,
      uncertain: false,
    });
    await vi.runAllTimersAsync();
    expect(value.close).toHaveBeenCalledTimes(1);
  },
);
it("account invalidation closes detached dirty sessions and prevents later reattachment", async () => {
  vi.useFakeTimers();
  const value = client(),
    open = vi.fn(async () => value.api);
  const view = acquireNbtSession("account", open, true);
  await view.promise;
  value.update({ dirty: true });
  view.release();
  await clearNbtSessions();
  expect(value.close).toHaveBeenCalledTimes(1);
  const next = client(),
    replacement = acquireNbtSession("account", async () => next.api, true);
  expect((await replacement.promise).client).toBe(next.api);
  replacement.release();
});
it("cancels an actual source open when the final clean view is released", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const view = acquireNbtSession(
    "opening",
    (input) =>
      new Promise((_resolve, reject) => {
        signal = input;
        input.addEventListener("abort", () => reject(input.reason), {
          once: true,
        });
      }),
    true,
  );
  const result = view.promise.catch((error) => error);
  view.release();
  await vi.runAllTimersAsync();
  expect(signal?.aborted).toBe(true);
  expect(await result).toBeInstanceOf(Error);
});
it("controls activity while encrypted recovery is still opening instead of waiting for replay to finish", async () => {
  vi.useFakeTimers();
  const value = client();
  let finish!: (client: NbtDocumentClient) => void;
  const view = acquireNbtSession(
    "recovering",
    async (_signal, created) => {
      created(value.api);
      return new Promise<NbtDocumentClient>((resolve) => {
        finish = resolve;
      });
    },
    false,
  );
  expect(value.paused).toHaveBeenLastCalledWith(true);
  view.setActive(true);
  expect(value.paused).toHaveBeenLastCalledWith(false);
  view.setActive(false);
  expect(value.paused).toHaveBeenLastCalledWith(true);
  finish(value.api);
  expect((await view.promise).client).toBe(value.api);
  view.release();
  await vi.runAllTimersAsync();
  expect(value.close).toHaveBeenCalledOnce();
});
