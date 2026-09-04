import * as ContextMenu from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { SurfaceActionsMenu } from "@/components/workspace/surface-tab-controls";
import type { ProjectSurface } from "@/lib/project-surface";

import { MobileBottomNavigation } from "./mobile-bottom-navigation";

vi.mock("@radix-ui/react-context-menu", async () => {
  const React = await import("react");
  const Container = React.forwardRef<unknown, { children?: React.ReactNode }>(
    ({ children }, _ref) => React.createElement(React.Fragment, null, children),
  );
  const Trigger = React.forwardRef<unknown, { children?: React.ReactNode }>(
    ({ children }, _ref) => React.createElement(React.Fragment, null, children),
  );
  const Item = React.forwardRef<
    unknown,
    { children?: React.ReactNode; onSelect?(): void }
  >(({ children, onSelect }, _ref) =>
    React.createElement(
      "button",
      { "data-context-menu-item": true, onClick: onSelect, type: "button" },
      children,
    ),
  );
  return {
    Content: Container,
    Item,
    Portal: Container,
    Root: Container,
    Separator: () => null,
    Trigger,
  };
});
vi.mock("@radix-ui/react-dropdown-menu", async () => {
  const React = await import("react");
  const Container = React.forwardRef<unknown, { children?: React.ReactNode }>(
    ({ children }, _ref) => React.createElement(React.Fragment, null, children),
  );
  const Item = React.forwardRef<
    unknown,
    { children?: React.ReactNode; onSelect?(): void }
  >(({ children, onSelect }, _ref) =>
    React.createElement(
      "button",
      { "data-dropdown-menu-item": true, onClick: onSelect, type: "button" },
      children,
    ),
  );
  return {
    Content: Container,
    Item,
    Portal: Container,
    Root: Container,
    Separator: () => null,
    Trigger: Container,
  };
});
vi.mock("@/components/workspace/project-surface-create-menu", () => ({
  ProjectSurfaceCreateMenu: ({ trigger }: { trigger: ReactNode }) => trigger,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function surface(
  tabKey: string,
  kind: "chat" | "terminal",
  title: string,
): ProjectSurface {
  return {
    entity:
      kind === "chat"
        ? { experience: "chat", status: "idle" }
        : { status: "running" },
    groupId: `group-${tabKey}`,
    kind,
    member: {},
    projectId: "project-1",
    tabId: tabKey.split(":")[1]!,
    tabKey,
    title,
  } as ProjectSurface;
}

const surfaces = [
  surface("chat:one", "chat", "Chat One"),
  surface("terminal:one", "terminal", "Terminal One"),
  surface("chat:two", "chat", "Chat Two"),
];

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value && typeof value === "object" && "props" in value) {
    return textContent(
      (value as { props: { children?: unknown } }).props.children,
    );
  }
  return "";
}

describe("mobile project navigation", () => {
  it("renders flat project surfaces without tab groups or selector slots", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        activeTabKey="terminal:one"
        creatingKinds={new Set()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
        onOverview={vi.fn()}
        onSelect={vi.fn()}
        overviewSelected={false}
        surfaces={surfaces}
      />,
    );

    expect(markup).toContain("Chat One");
    expect(markup).toContain("Terminal One");
    expect(markup).toContain('aria-label="Open Terminal One"');
    expect(markup).toContain('aria-label="Actions for Terminal One"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Create project surface"');
    expect(markup).not.toContain("Project tabs");
    expect(markup).not.toContain("tab group");
    expect(markup).not.toContain(">Tabs<");
    expect(markup).not.toContain("Remove bottom tab");
  });

  it("evenly divides up to five actions including Overview and create", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        activeTabKey="terminal:one"
        creatingKinds={new Set()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
        onOverview={vi.fn()}
        onSelect={vi.fn()}
        overviewSelected={false}
        surfaces={surfaces}
      />,
    );

    expect(markup.match(/aria-label="Open /g)).toHaveLength(3);
    expect(markup.match(/data-mobile-surface-tab=/g)).toHaveLength(3);
    expect(markup).toContain('data-layout="equal"');
    expect(markup.match(/min-w-0 flex-1/g)).toHaveLength(5);
  });

  it("uses a horizontal flat list when more than five actions are open", () => {
    const markup = renderToStaticMarkup(
      <MobileBottomNavigation
        activeTabKey={null}
        creatingKinds={new Set()}
        onCreate={vi.fn()}
        onClose={vi.fn()}
        onOverview={vi.fn()}
        onSelect={vi.fn()}
        overviewSelected
        surfaces={[
          ...surfaces,
          surface("terminal:two", "terminal", "Terminal Two"),
        ]}
      />,
    );

    expect(markup).toContain('data-layout="scroll"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup.match(/min-w-\[4\.5rem\]/g)).toHaveLength(6);
  });

  it("keeps tap selection and routes mobile actions through surface close", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <MobileBottomNavigation
          activeTabKey="terminal:one"
          creatingKinds={new Set()}
          onClose={onClose}
          onCreate={vi.fn()}
          onOverview={vi.fn()}
          onSelect={onSelect}
          overviewSelected={false}
          surfaces={surfaces}
        />,
      );
    });

    const terminalTab = renderer.root.findByProps({
      "aria-label": "Open Terminal One",
    });
    terminalTab.props.onClick();
    expect(onSelect).toHaveBeenCalledWith("terminal:one");

    expect(renderer.root.findAllByType(ContextMenu.Trigger)).toHaveLength(3);

    const contextCloseItems = renderer.root
      .findAllByProps({ "data-context-menu-item": true })
      .filter((item) => textContent(item).trim() === "Close View");
    contextCloseItems[1]!.props.onClick();
    expect(onClose).toHaveBeenCalledWith(surfaces[1]);

    const actionMenus = renderer.root.findAllByType(SurfaceActionsMenu);
    onClose.mockClear();
    actionMenus[1]!.props.onClose();
    expect(onClose).toHaveBeenCalledWith(surfaces[1]);

    await act(async () => renderer.unmount());
  });
});
