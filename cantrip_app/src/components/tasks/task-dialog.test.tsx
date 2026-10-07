import { createElement, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, ...props }: { children: ReactNode }) =>
    createElement("dialog-root", props, children),
  DialogContent: ({ children, ...props }: { children: ReactNode }) =>
    createElement("dialog-content", props, children),
  DialogTitle: ({ children }: { children: ReactNode }) =>
    createElement("h2", {}, children),
}));

import {
  TaskDialog,
  TASK_DIALOG_CONTENT_CLASS_NAME,
  TASK_DIALOG_POSITIONER_CLASS_NAME,
} from "./task-dialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount(beforeClose?: () => Promise<void>) {
  const onClose = vi.fn();
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(TaskDialog, {
        open: true,
        title: "Task detail",
        onClose,
        beforeClose,
        children: "Task content",
      }),
    );
  });
  return onClose;
}
const root = () => renderer!.root.findByType("dialog-root" as never);
const closeButton = () =>
  renderer!.root.findByProps({ "aria-label": "Close Task dialog" });

describe("Task dialog", () => {
  it("uses symmetric desktop margins and an edge-to-edge mobile content surface", () => {
    expect(TASK_DIALOG_POSITIONER_CLASS_NAME).toBe("p-0 md:p-6");
    const classes = TASK_DIALOG_CONTENT_CLASS_NAME.split(" ");
    for (const value of [
      "h-full",
      "max-w-none",
      "p-0",
      "border-0",
      "rounded-none",
      "md:rounded-xl",
      "md:border",
      "overflow-hidden",
    ])
      expect(classes).toContain(value);
    expect(TASK_DIALOG_CONTENT_CLASS_NAME).not.toContain("max-w-lg");
  });

  it.each(["barrier", "button"] as const)(
    "saves before dismissing with the %s",
    async (source) => {
      const save = vi.fn().mockResolvedValue(undefined);
      const onClose = await mount(save);
      await act(async () => {
        if (source === "barrier") root().props.onOpenChange(false);
        else closeButton().props.onClick();
      });
      expect(save).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
      expect(save.mock.invocationCallOrder[0]).toBeLessThan(
        onClose.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("ignores duplicate dismissal attempts while the draft flush is pending", async () => {
    let finish!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = await mount(save);
    await act(async () => {
      root().props.onOpenChange(false);
      root().props.onOpenChange(false);
    });
    expect(save).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps edits visible after a failed save, allows retry, and offers an explicit discard exit", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Worker offline"))
      .mockResolvedValue(undefined);
    const onClose = await mount(save);
    await act(async () => root().props.onOpenChange(false));
    expect(onClose).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Worker offline");
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Close without saving",
    );
    await act(async () => closeButton().props.onClick());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not attempt to save when Radix announces opening", async () => {
    const save = vi.fn();
    const onClose = await mount(save);
    await act(async () => root().props.onOpenChange(true));
    expect(save).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("allows an explicit discard when saving cannot succeed", async () => {
    const onClose = await mount(
      vi.fn().mockRejectedValue(new Error("Worker offline")),
    );
    await act(async () => root().props.onOpenChange(false));
    const discard = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Close without saving"))!;
    await act(async () => discard.props.onClick());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "restores focus to the opener only while it remains connected (%s)",
    async (isConnected) => {
      class FocusTarget {
        isConnected = isConnected;
        focus = vi.fn();
      }
      const opener = new FocusTarget();
      vi.stubGlobal("HTMLElement", FocusTarget);
      vi.stubGlobal("document", { activeElement: opener });
      await mount();
      const content = renderer!.root.findByType("dialog-content" as never);
      const event = { preventDefault: vi.fn() };
      content.props.onOpenAutoFocus();
      content.props.onCloseAutoFocus(event);
      expect(opener.focus).toHaveBeenCalledTimes(isConnected ? 1 : 0);
      expect(event.preventDefault).toHaveBeenCalledTimes(isConnected ? 1 : 0);
    },
  );
});
