// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExplorerLifecycleActions } from "../explorer/explorer-view";
import {
  confirmNativeCodeDiscard,
  nativeCodeOwnerKey,
  prepareNativeCodeTransfer,
  setNativeCodeLifecycle,
  getNativeCodeLifecycle,
  subscribeNativeCodeLifecycle,
  nativeCodeLifecycleRevision,
} from "./native-code-lifecycle";

vi.mock("@/lib/client-session", () => ({
  getClientSession: () => ({ serverId: "server", user: { id: "owner" } }),
}));
const id = "code-test";
function install(dirty = true) {
  const actions = {
    dirty,
    discard: vi.fn(),
    save: vi.fn().mockResolvedValue(true),
    flushViewState: vi.fn().mockResolvedValue(true),
  } as unknown as ExplorerLifecycleActions;
  setNativeCodeLifecycle(nativeCodeOwnerKey(id), actions);
  return actions;
}
afterEach(() => {
  setNativeCodeLifecycle(nativeCodeOwnerKey(id), null);
  vi.restoreAllMocks();
});

describe("native Code confirmation", () => {
  it("notifies registration changes without feeding callback replacements back into renders", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNativeCodeLifecycle(listener);
    try {
      const before = nativeCodeLifecycleRevision();
      const first = install(false);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(nativeCodeLifecycleRevision()).toBe(before + 1);
      const replacement = install(true);
      expect(replacement).not.toBe(first);
      expect(getNativeCodeLifecycle(id)).toBe(replacement);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(nativeCodeLifecycleRevision()).toBe(before + 1);
      setNativeCodeLifecycle(nativeCodeOwnerKey(id), null);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(getNativeCodeLifecycle(id)).toBeUndefined();
      setNativeCodeLifecycle(nativeCodeOwnerKey(id), null);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("does not prompt when the registered editor is clean", async () => {
    install(false);
    const confirm = vi.spyOn(window, "confirm");
    await expect(confirmNativeCodeDiscard(id)).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("waits for the native answer without discarding the buffer", async () => {
    const actions = install();
    let answer!: (value: boolean) => void;
    const confirm = vi.spyOn(window, "confirm").mockImplementation(
      (() =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })) as unknown as typeof window.confirm,
    );
    let settled = false;
    const pending = confirmNativeCodeDiscard(id).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(actions.discard).not.toHaveBeenCalled();
    answer(false);
    await expect(pending).resolves.toBe(false);
    confirm.mockImplementation((() =>
      Promise.resolve(true)) as unknown as typeof window.confirm);
    await expect(confirmNativeCodeDiscard(id)).resolves.toBe(true);
    // The server may still reject close/delete after this approval.
    expect(actions.discard).not.toHaveBeenCalled();
    expect(actions.save).not.toHaveBeenCalled();
  });

  it("propagates a failed native dialog without discarding or saving", async () => {
    const actions = install();
    vi.spyOn(window, "confirm").mockImplementation((() =>
      Promise.reject(
        new Error("dialog denied"),
      )) as unknown as typeof window.confirm);
    await expect(confirmNativeCodeDiscard(id)).rejects.toThrow("dialog denied");
    expect(actions.discard).not.toHaveBeenCalled();
    expect(actions.save).not.toHaveBeenCalled();
  });

  it("does not save or rebind after async cancellation", async () => {
    const actions = install();
    vi.spyOn(window, "confirm").mockImplementation((() =>
      Promise.resolve(false)) as unknown as typeof window.confirm);
    await expect(prepareNativeCodeTransfer(id)).resolves.toBe(false);
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.flushViewState).not.toHaveBeenCalled();
  });
});
