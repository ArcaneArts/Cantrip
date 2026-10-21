// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFileCloseEvent } from "@/lib/native-file-window-close";

const native = vi.hoisted(() => ({
  enabled: true,
  destroy: vi.fn(async () => {}),
  remove: vi.fn(),
  handler: null as ((event: NativeFileCloseEvent) => Promise<void>) | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    destroy: native.destroy,
    onCloseRequested: async (
      handler: (event: NativeFileCloseEvent) => Promise<void>,
    ) => {
      native.handler = handler;
      return native.remove;
    },
  }),
}));
import { NativeFileWindowCloseGuard } from "./native-file-window-close-guard";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  native.enabled = true;
  native.destroy.mockReset().mockResolvedValue();
  native.remove.mockClear();
  native.handler = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  )!;

describe("native file window close dialog", () => {
  it("keeps drafts on cancellation, then closes only after explicit discard", async () => {
    await act(async () =>
      root.render(
        <NativeFileWindowCloseGuard hasUnsavedChanges={() => true} />,
      ),
    );
    await vi.waitFor(() => expect(native.handler).not.toBeNull());
    const preventDefault = vi.fn();
    let pending!: Promise<void>;
    await act(async () => {
      pending = native.handler!({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Closing discards unsaved changes",
    );
    await act(async () => button("Keep editing").click());
    await pending;
    expect(native.destroy).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      pending = native.handler!({ preventDefault });
    });
    await act(async () => button("Close and discard").click());
    await pending;
    expect(native.destroy).toHaveBeenCalledTimes(1);
  });

  it("uses updated session state, includes pending saves, and surfaces an actual close error", async () => {
    await act(async () =>
      root.render(
        <NativeFileWindowCloseGuard hasUnsavedChanges={() => false} />,
      ),
    );
    await vi.waitFor(() => expect(native.handler).not.toBeNull());
    await act(async () =>
      root.render(
        <NativeFileWindowCloseGuard hasUnsavedChanges={() => true} />,
      ),
    );
    native.destroy.mockRejectedValueOnce(new Error("destroy denied"));
    let pending!: Promise<void>;
    await act(async () => {
      pending = native.handler!({ preventDefault: vi.fn() });
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "save already in progress",
    );
    await act(async () => button("Close and discard").click());
    await pending;
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "destroy denied",
    );
    await act(async () => button("Retry close protection").click());
    expect(native.remove).toHaveBeenCalled();
  });

  it("leaves browser windows and explicit Code-only windows on their existing close path", async () => {
    native.enabled = false;
    await act(async () =>
      root.render(
        <NativeFileWindowCloseGuard hasUnsavedChanges={() => true} />,
      ),
    );
    expect(native.handler).toBeNull();
    native.enabled = true;
    await act(async () =>
      root.render(
        <NativeFileWindowCloseGuard
          enabled={false}
          hasUnsavedChanges={() => false}
        />,
      ),
    );
    expect(native.handler).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
