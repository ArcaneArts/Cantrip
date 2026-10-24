import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { useChatViewTransfer } from "./use-chat-view-transfer";
import { registerChatTransferLifecycle } from "./chat-transfer-lifecycle";
import type { ChatViewState, IncomingChatView } from "./chat-view-state";

vi.mock("./chat-transfer-lifecycle", () => ({
  registerChatTransferLifecycle: vi.fn(() => vi.fn()),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const owner = { tabId: "tab", chatId: "chat", projectId: "project" };
const state: ChatViewState = {
  version: 1,
  chatId: "chat",
  projectId: "project",
  draft: { text: "draft", mode: "default", reasoningEffort: null },
  nativeModeIntent: null,
  composerSelection: { start: 0, end: 0, scrollTop: 0 },
  transcript: { scrollTop: 0, following: true },
  editingPrompt: null,
  editingSentMessage: null,
  inspectTab: "trajectory",
  trajectoryTargetKey: null,
  sidePanelView: { type: "inspect" },
};

it("flushes before capture and retirement and resumes a cancelled source", async () => {
  vi.mocked(registerChatTransferLifecycle).mockClear();
  const events: string[] = [];
  let locked = false;
  function Probe() {
    locked = useChatViewTransfer({
      owner,
      capture: () => {
        events.push("capture");
        return state;
      },
      flush: async () => {
        events.push("flush");
      },
      restore: async () => {},
    }).transferLocked;
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = TestRenderer.create(createElement(Probe));
    });
    const lifecycle = vi.mocked(registerChatTransferLifecycle).mock
      .calls[0]![1];
    await expect(lifecycle.captureTransfer()).rejects.toThrow("not suspended");
    let release!: () => void;
    await act(async () => {
      release = lifecycle.suspendTransfer();
    });
    expect(locked).toBe(true);
    expect(await lifecycle.captureTransfer()).toEqual(state);
    await act(async () => lifecycle.retireTransfer());
    expect(events).toEqual(["flush", "capture", "flush"]);
    await act(async () => {
      release();
      release();
    });
    expect(locked).toBe(false);
    await expect(lifecycle.captureTransfer()).rejects.toThrow("not suspended");
  } finally {
    await act(async () => tree?.unmount());
  }
});

it("does not capture after cancellation while a draft flush is still pending", async () => {
  vi.mocked(registerChatTransferLifecycle).mockClear();
  let finish!: () => void;
  const capture = vi.fn(() => state);
  let locked = false;
  function Probe() {
    locked = useChatViewTransfer({
      owner,
      capture,
      flush: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      restore: async () => {},
    }).transferLocked;
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = TestRenderer.create(createElement(Probe));
    });
    const lifecycle = vi.mocked(registerChatTransferLifecycle).mock
      .calls[0]![1];
    let release!: () => void;
    await act(async () => {
      release = lifecycle.suspendTransfer();
    });
    const pending = lifecycle.captureTransfer();
    await act(async () => release());
    finish();
    await expect(pending).rejects.toThrow("cancelled");
    expect(capture).not.toHaveBeenCalled();
    expect(locked).toBe(false);
  } finally {
    await act(async () => tree?.unmount());
  }
});

it.each([false, true])(
  "acknowledges restoration only while mounted (cancel=%s)",
  async (cancel) => {
    vi.mocked(registerChatTransferLifecycle).mockClear();
    let finish!: () => void;
    let signal!: AbortSignal;
    const onRestored = vi.fn();
    const onError = vi.fn();
    const incoming = {
      tabId: "tab",
      chat: { id: "chat", projectId: "project" } as IncomingChatView["chat"],
      state,
      staging: { onRestored, onError },
    } as IncomingChatView;
    const restore = vi.fn(
      (_state: ChatViewState, incomingSignal: AbortSignal) => {
        signal = incomingSignal;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    function Probe() {
      const result = useChatViewTransfer({
        owner,
        incoming,
        capture: () => state,
        flush: async () => {},
        restore,
      });
      return createElement("div", { "data-locked": result.transferLocked });
    }
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(createElement(Probe));
    });
    expect(tree.root.findByType("div").props["data-locked"]).toBe(true);
    expect(registerChatTransferLifecycle).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
    if (cancel) await act(async () => tree.unmount());
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(onRestored).toHaveBeenCalledTimes(cancel ? 0 : 1);
    expect(onError).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(cancel);
    if (!cancel) await act(async () => tree.unmount());
  },
);
