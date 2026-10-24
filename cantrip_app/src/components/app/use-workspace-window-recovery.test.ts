import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { restoreWorkspaceWindows } from "@/lib/workspace-window-recovery";
import { useWorkspaceWindowRecovery } from "./use-workspace-window-recovery";

vi.mock("@/lib/desktop-popout", () => ({
  isDesktopRuntime: () => true,
  reopenWorkspaceWindow: vi.fn(),
}));
vi.mock("@/lib/workspace-window-recovery", () => ({
  restoreWorkspaceWindows: vi.fn(async () => {}),
  workspaceWindowRecoveryTargets: vi.fn(() => []),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it.each(["main", "popout"])(
  "only the main host restores native owners (%s)",
  async (windowId) => {
    vi.clearAllMocks();
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    const refresh = vi.fn(async () => {});
    const connection = {
      windowId,
      controller: {
        refresh,
        getSnapshot: () => ({
          disposed: false,
          authoritative: { mainWindowId: "main" },
        }),
      },
    } as unknown as NonNullable<
      Parameters<typeof useWorkspaceWindowRecovery>[0]
    >;
    const Probe = () => {
      useWorkspaceWindowRecovery(connection, vi.fn());
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(createElement(Probe));
      });
      expect(refresh).toHaveBeenCalledTimes(windowId === "main" ? 1 : 0);
      await act(async () => {
        events.dispatchEvent(new Event("focus"));
      });
      expect(restoreWorkspaceWindows).toHaveBeenCalledTimes(
        windowId === "main" ? 2 : 0,
      );
      await act(async () => {
        renderer.unmount();
      });
      events.dispatchEvent(new Event("focus"));
      expect(refresh).toHaveBeenCalledTimes(windowId === "main" ? 2 : 0);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("cancels restoration after unmount while the authoritative refresh is pending", async () => {
  vi.clearAllMocks();
  vi.stubGlobal("window", new EventTarget());
  let resolve!: () => void;
  const connection = {
    windowId: "main",
    controller: {
      refresh: () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
      getSnapshot: () => ({
        disposed: false,
        authoritative: { mainWindowId: "main" },
      }),
    },
  } as unknown as NonNullable<Parameters<typeof useWorkspaceWindowRecovery>[0]>;
  const Probe = () => {
    useWorkspaceWindowRecovery(connection, vi.fn());
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
    });
    await act(async () => {
      renderer.unmount();
      resolve();
    });
    const input = vi.mocked(restoreWorkspaceWindows).mock.calls[0]![0];
    expect(input.read()).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
