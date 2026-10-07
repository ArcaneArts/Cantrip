import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { ProjectSurfaceCreateMenu } from "./project-surface-create-menu";

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children: ReactNode }) => children,
  Trigger: ({ children }: { children: ReactNode }) => children,
  Portal: ({ children }: { children: ReactNode }) => children,
  Sub: ({ children }: { children: ReactNode }) => children,
  Separator: () => <hr />,
}));
vi.mock("@/components/ui/styled-menu", () => ({
  StyledDropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  StyledDropdownMenuSubContent: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  StyledDropdownMenuSubTrigger: ({
    children,
    disabled,
  }: {
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} data-submenu>
      {children}
    </button>
  ),
  StyledDropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect(): void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}));

describe("running configuration submenu", () => {
  it("separates existing runs from creation and opens the selected terminal identity", async () => {
    const onCreate = vi.fn();
    const onOpenRunning = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProjectSurfaceCreateMenu
          allowedKinds={new Set(["chat"])}
          onCreate={onCreate}
          onOpenRunning={onOpenRunning}
          placement={{
            projectId: "project-1",
            replicas: [],
            workers: [],
            worktrees: [],
            runningConfigurations: [
              {
                runtimeId: "run-1",
                terminalId: "terminal-1",
                name: "Run Client",
                targetLabel: "Primary · Local Worker",
              },
              {
                runtimeId: "run-2",
                terminalId: "terminal-2",
                name: "Run Client",
                targetLabel: "feature · Local Worker",
              },
            ],
          }}
          trigger={<button>+</button>}
        />,
      );
    });
    expect(renderer.root.findAllByType("hr")).toHaveLength(1);
    const submenu = renderer.root.findByProps({ "data-submenu": true });
    expect(submenu.props.children).toContain("Running");
    expect(submenu.props.disabled).toBeFalsy();
    const items = renderer.root.findByType("section").findAllByType("button");
    expect(items).toHaveLength(2);
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "feature · Local Worker",
    );
    await act(async () => items[1]!.props.onClick());
    expect(onOpenRunning).toHaveBeenCalledExactlyOnceWith("terminal-2");
    expect(onCreate).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it.each([undefined, []])(
    "hides Running when no active instances exist (%s)",
    async (runningConfigurations) => {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <ProjectSurfaceCreateMenu
            onCreate={vi.fn()}
            onOpenRunning={vi.fn()}
            placement={{
              projectId: "project-1",
              replicas: [],
              workers: [],
              worktrees: [],
              runningConfigurations,
            }}
            trigger={<button>+</button>}
          />,
        );
      });
      expect(
        renderer.root.findAllByProps({ "data-submenu": true }),
      ).toHaveLength(0);
      expect(renderer.root.findAllByType("section")).toHaveLength(0);
      expect(renderer.root.findAllByType("hr")).toHaveLength(0);
      await act(async () => renderer.unmount());
    },
  );
});
