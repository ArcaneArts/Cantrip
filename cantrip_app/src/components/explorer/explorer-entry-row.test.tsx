import type { ExplorerEntry } from "@cantrip/protocol";
import { createElement, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@radix-ui/react-context-menu", async () => {
  const React = await import("react");
  const Container = React.forwardRef<unknown, { children?: React.ReactNode }>(
    ({ children }, _ref) => React.createElement(React.Fragment, null, children),
  );
  const Item = React.forwardRef<
    unknown,
    {
      children?: React.ReactNode;
      onClick?(event: { shiftKey: boolean }): void;
      onSelect?(): void;
    }
  >(({ children, onClick, onSelect }, _ref) =>
    React.createElement(
      "button",
      {
        onClick: (event: { shiftKey: boolean }) => {
          onClick?.(event);
          onSelect?.();
        },
        type: "button",
      },
      children,
    ),
  );
  return {
    Content: Container,
    Item,
    Portal: Container,
    Root: Container,
    Trigger: Container,
  };
});

import { ExplorerEntryRow } from "./explorer-entry-row";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const entry = {
  kind: "file",
  markdown: false,
  modifiedAt: "2026-08-23T12:00:00.000Z",
  name: "example.ts",
  path: "src/example.ts",
  size: 10,
  symbolicLink: false,
  viewable: true,
} satisfies ExplorerEntry;

function textContent(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value && typeof value === "object" && "props" in value) {
    return textContent(
      (value as { props: { children?: ReactNode } }).props.children,
    );
  }
  return "";
}

describe("ExplorerEntryRow native reveal", () => {
  it("offers file reveal and forwards the Shift local preference", async () => {
    const onReveal = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ExplorerEntryRow, {
          change: null,
          commit: null,
          depth: 0,
          entry,
          onOpen: vi.fn(),
          onReveal,
          revealLabel: "Show in Finder",
        }),
      );
    });
    const reveal = renderer.root
      .findAllByType("button")
      .find((button) =>
        textContent(button.props.children).includes("Show in Finder"),
      );
    expect(reveal).toBeDefined();

    await act(async () => reveal!.props.onClick({ shiftKey: false }));
    expect(onReveal).toHaveBeenLastCalledWith(false);
    await act(async () => reveal!.props.onClick({ shiftKey: true }));
    expect(onReveal).toHaveBeenLastCalledWith(true);

    await act(async () => renderer.unmount());
  });
});
