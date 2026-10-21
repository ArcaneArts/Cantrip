import { describe, expect, it, vi } from "vitest";
import {
  bindNativeFileWindowClose,
  type NativeFileCloseEvent,
} from "./native-file-window-close";

function fixture(unsaved = false) {
  let handler!: (event: NativeFileCloseEvent) => Promise<void>;
  const destroy = vi.fn(async () => {});
  const remove = vi.fn();
  const confirm = vi.fn(async () => true);
  const error = vi.fn();
  const state = { unsaved };
  const guard = bindNativeFileWindowClose(
    {
      destroy,
      onCloseRequested: async (callback) => {
        handler = callback;
        return remove;
      },
    },
    () => state.unsaved,
    confirm,
    error,
  );
  const close = async () => {
    let prevented = false;
    await handler({
      preventDefault: () => {
        prevented = true;
      },
    });
    // Faithfully model the installed Tauri helper's automatic destroy after its callback.
    if (!prevented) await destroy();
    return prevented;
  };
  return { guard, state, destroy, remove, confirm, error, close };
}

describe("native file close decisions", () => {
  it("closes clean windows exactly once without a confirmation or SDK double-destroy", async () => {
    const current = fixture();
    await current.guard.ready;
    expect(await current.close()).toBe(true);
    expect(current.destroy).toHaveBeenCalledTimes(1);
    expect(current.confirm).not.toHaveBeenCalled();
    await current.close();
    expect(current.destroy).toHaveBeenCalledTimes(1);
  });

  it("checks current dirty/saving state and retains the window when discard is cancelled", async () => {
    const current = fixture();
    await current.guard.ready;
    current.state.unsaved = true;
    current.confirm.mockResolvedValueOnce(false);
    expect(await current.close()).toBe(true);
    expect(current.confirm).toHaveBeenCalledTimes(1);
    expect(current.destroy).not.toHaveBeenCalled();
    await current.close();
    expect(current.destroy).toHaveBeenCalledTimes(1);
    expect(current.state.unsaved).toBe(true); // Only real window destruction discards memory.
  });

  it("coalesces repeated native close requests while the user decides", async () => {
    const current = fixture(true);
    let answer!: (value: boolean) => void;
    current.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await current.guard.ready;
    const first = current.close();
    await current.close();
    expect(current.confirm).toHaveBeenCalledTimes(1);
    expect(current.destroy).not.toHaveBeenCalled();
    answer(true);
    await first;
    expect(current.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps documents available after an actual close failure and allows a later retry", async () => {
    const current = fixture(true);
    current.destroy.mockRejectedValueOnce(new Error("native close failed"));
    await current.guard.ready;
    await current.close();
    expect(current.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "native close failed" }),
    );
    expect(current.state.unsaved).toBe(true);
    await current.close();
    expect(current.destroy).toHaveBeenCalledTimes(2);
    expect(current.confirm).toHaveBeenCalledTimes(2);
  });

  it("prevents destruction when unmounted during a pending confirmation", async () => {
    const current = fixture(true);
    let answer!: (value: boolean) => void;
    current.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await current.guard.ready;
    const pending = current.close();
    current.guard.dispose();
    answer(true);
    await pending;
    expect(current.remove).toHaveBeenCalledTimes(1);
    expect(current.destroy).not.toHaveBeenCalled();
    await current.close();
    expect(current.destroy).not.toHaveBeenCalled();
  });

  it("removes a subscription that completes after disposal", async () => {
    const remove = vi.fn();
    let registered!: (value: () => void) => void;
    const guard = bindNativeFileWindowClose(
      {
        destroy: vi.fn(),
        onCloseRequested: () =>
          new Promise((resolve) => {
            registered = resolve;
          }),
      },
      () => true,
      vi.fn(),
      vi.fn(),
    );
    guard.dispose();
    registered(remove);
    await guard.ready;
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("reports actual listener registration failure without pretending protection exists", async () => {
    const error = vi.fn();
    const guard = bindNativeFileWindowClose(
      {
        destroy: vi.fn(),
        onCloseRequested: async () => {
          throw new Error("listener denied");
        },
      },
      () => true,
      vi.fn(),
      error,
    );
    await guard.ready;
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listener denied" }),
    );
  });
});
