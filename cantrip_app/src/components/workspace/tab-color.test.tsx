import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabColorDialog } from "./tab-color";

vi.mock("@/components/ui/dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogFooter: Container,
  };
});
afterEach(() => vi.unstubAllGlobals());
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("tab color dialog", () => {
  it("previews custom hue without writing until Save", async () => {
    const setItem = vi.fn(),
      onClose = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem },
      dispatchEvent: vi.fn(),
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TabColorDialog
          target={{ key: "tab", title: "Terminal" }}
          onClose={onClose}
        />,
      );
    });
    const button = (text: string) =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.props.children === text)!;
    await act(async () => button("Custom").props.onClick());
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Custom hue" })
        .props.onChange({ target: { value: "273" } }),
    );
    expect(setItem).not.toHaveBeenCalled();
    await act(async () => button("Save").props.onClick());
    expect(setItem).toHaveBeenCalledWith("tab", "273");
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });
  it("cancels without saving and keeps the dialog open when saving fails", async () => {
    const setItem = vi.fn(() => {
        throw new Error("quota");
      }),
      onClose = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "12", setItem },
      dispatchEvent: vi.fn(),
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TabColorDialog
          target={{ key: "tab", title: "Terminal" }}
          onClose={onClose}
        />,
      );
    });
    const button = (text: string) =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.props.children === text)!;
    await act(async () => button("Save").props.onClick());
    expect(
      renderer.root.findByProps({ role: "alert" }).props.children,
    ).toContain("Could not save");
    expect(onClose).not.toHaveBeenCalled();
    setItem.mockClear();
    await act(async () => button("Cancel").props.onClick());
    expect(setItem).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });
});
