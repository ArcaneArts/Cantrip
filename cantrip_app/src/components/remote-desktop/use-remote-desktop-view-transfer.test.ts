import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { useRemoteDesktopViewTransfer } from "./use-remote-desktop-view-transfer";
import { registerRemoteDesktopTransferLifecycle } from "./remote-desktop-transfer-lifecycle";
import type { RemoteDesktopViewState } from "./remote-desktop-view-state";

vi.mock("./remote-desktop-transfer-lifecycle", () => ({
  registerRemoteDesktopTransferLifecycle: vi.fn(() => vi.fn()),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const owner = {
  tabId: "tab",
  desktopId: "desktop",
  projectId: "project",
  workerId: "worker",
};
const state: RemoteDesktopViewState = {
  version: 1,
  desktopId: "desktop",
  projectId: "project",
  workerId: "worker",
  viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  fleetOpen: true,
  targetSearch: "Editor",
};
beforeEach(() => vi.mocked(registerRemoteDesktopTransferLifecycle).mockClear());
const callbacks = () => ({
  capture: vi.fn(() => state),
  restore: vi.fn(),
  cancelInput: vi.fn(),
  drain: vi.fn(async () => {}),
  detach: vi.fn(),
  retry: vi.fn(),
});

it("cancels input before capture, detaches on retirement and reattaches after rollback", async () => {
  const actions = callbacks();
  let result!: ReturnType<typeof useRemoteDesktopViewTransfer>;
  function Probe() {
    result = useRemoteDesktopViewTransfer({ owner, ...actions });
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(createElement(Probe));
  });
  try {
    const lifecycle = vi.mocked(registerRemoteDesktopTransferLifecycle).mock
      .calls[0]![1];
    await expect(lifecycle.captureTransfer()).rejects.toThrow("cancelled");
    let release!: () => void;
    await act(async () => {
      release = lifecycle.suspendTransfer();
      expect(result.accepting()).toBe(false);
    });
    expect(actions.cancelInput).toHaveBeenCalledOnce();
    expect(result.locked).toBe(true);
    expect(await lifecycle.captureTransfer()).toEqual(state);
    expect(actions.drain).toHaveBeenCalledOnce();
    await act(async () => lifecycle.retireTransfer());
    expect(actions.detach).toHaveBeenCalledOnce();
    expect(result.attachEnabled).toBe(false);
    await act(async () => {
      release();
      release();
    });
    expect(result.accepting()).toBe(true);
    expect(result.attachEnabled).toBe(true);
    expect(actions.retry).toHaveBeenCalledOnce();
  } finally {
    await act(async () => tree.unmount());
  }
});

it("does not capture after cancellation during transport drain", async () => {
  const actions = callbacks();
  let finish!: () => void;
  actions.drain.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  function Probe() {
    useRemoteDesktopViewTransfer({ owner, ...actions });
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(createElement(Probe));
  });
  try {
    const lifecycle = vi.mocked(registerRemoteDesktopTransferLifecycle).mock
      .calls[0]![1];
    let release!: () => void;
    await act(async () => {
      release = lifecycle.suspendTransfer();
    });
    const capture = lifecycle.captureTransfer();
    await act(async () => release());
    finish();
    await expect(capture).rejects.toThrow("cancelled");
    expect(actions.capture).not.toHaveBeenCalled();
    expect(actions.detach).not.toHaveBeenCalled();
  } finally {
    await act(async () => tree.unmount());
  }
});

it.each([false, true])(
  "keeps a staged destination disconnected and reports restoration (invalid=%s)",
  async (invalid) => {
    const actions = callbacks();
    const staging = { onRestored: vi.fn(), onError: vi.fn() };
    let result!: ReturnType<typeof useRemoteDesktopViewTransfer>;
    function Probe() {
      result = useRemoteDesktopViewTransfer({
        owner,
        ...actions,
        state: { ...state, workerId: invalid ? "other" : owner.workerId },
        staging,
      });
      return null;
    }
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(createElement(Probe));
    });
    try {
      expect(result.attachEnabled).toBe(false);
      expect(result.accepting()).toBe(false);
      expect(registerRemoteDesktopTransferLifecycle).not.toHaveBeenCalled();
      expect(actions.restore).toHaveBeenCalledTimes(invalid ? 0 : 1);
      expect(staging.onRestored).toHaveBeenCalledTimes(invalid ? 0 : 1);
      expect(staging.onError).toHaveBeenCalledTimes(invalid ? 1 : 0);
    } finally {
      await act(async () => tree.unmount());
    }
  },
);
