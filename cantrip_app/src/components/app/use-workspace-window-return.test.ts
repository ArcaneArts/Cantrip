import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { NativeFileCloseEvent } from "@/lib/native-file-window-close";
import { detachWorkspaceEditors } from "./detach-workspace-editors";
import { useWorkspaceWindowReturn } from "./use-workspace-window-return";

const native = vi.hoisted(() => ({
  close: null as null | ((event: NativeFileCloseEvent) => Promise<void>),
  destroy: vi.fn(async () => {}),
  remove: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (callback: typeof native.close) => {
      native.close = callback;
      return native.remove;
    },
    destroy: native.destroy,
  }),
}));
vi.mock("./detach-workspace-editors", () => ({
  detachWorkspaceEditors: vi.fn(),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it.each([false, true])(
  "returns every surviving pane before native destruction (failure=%s)",
  async (failure) => {
    vi.clearAllMocks();
    const events: string[] = [];
    const layout = {
      mainWindowId: "main",
      windows: [{ id: "popout", panes: [{ id: "a" }, { id: "b" }] }],
    };
    const source = {
      controller: {
        getSnapshot: () => ({ authoritative: layout, disposed: false }),
      },
      windowId: "popout",
      surfaces: new Map(),
      explorers: new Map(),
    } as unknown as NonNullable<
      Parameters<typeof useWorkspaceWindowReturn>[0]["source"]
    >;
    vi.mocked(detachWorkspaceEditors).mockImplementation(async (input) => {
      expect(input.returnToMain).toBe(true);
      events.push(input.paneId);
      if (failure) throw new Error("return failed");
      layout.windows[0]!.panes = layout.windows[0]!.panes.filter(
        ({ id }) => id !== input.paneId,
      );
      return "main";
    });
    native.destroy.mockImplementation(async () => {
      events.push("destroy");
    });
    const onError = vi.fn();
    const Probe = () => {
      useWorkspaceWindowReturn({ enabled: true, source, onError });
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(createElement(Probe));
      });
      const preventDefault = vi.fn();
      await act(async () => {
        await native.close!({ preventDefault });
      });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(events).toEqual(failure ? ["a"] : ["a", "b", "destroy"]);
      if (failure) {
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "return failed" }),
        );
        expect(native.destroy).not.toHaveBeenCalled();
      } else expect(onError).not.toHaveBeenCalled();
    } finally {
      await act(async () => renderer?.unmount());
    }
    expect(native.remove).toHaveBeenCalledOnce();
  },
);
