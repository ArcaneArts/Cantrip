import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { DockRail } from "./project-workspace-frame";

const menuState = vi.hoisted(() => ({
  onOpenChange: null as ((open: boolean) => void) | null,
}));

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }),
}));
vi.mock("@/components/app/global-content-host", () => ({
  DetachedPanePlaceholder: () => null,
  GlobalContentHost: () => null,
}));
vi.mock("@/components/app/persistent-surface-layer", () => ({
  PersistentSurfaceLayer: () => null,
}));
vi.mock("@/components/app/project-pane-render-bindings", () => ({
  projectPaneRenderBindings: () => ({}),
}));
vi.mock("@/components/workspace/project-surface-create-menu", () => ({
  ProjectSurfaceCreateMenu: ({
    onOpenChange,
    trigger,
  }: {
    onOpenChange(open: boolean): void;
    trigger: ReactNode;
  }) => {
    menuState.onOpenChange = onOpenChange;
    return trigger;
  },
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({
    children,
    onOpenChange,
    open,
  }: {
    children: ReactNode;
    onOpenChange(open: boolean): void;
    open: boolean;
  }) => (
    <div
      data-create-tooltip
      data-open={open ? "true" : "false"}
      onPointerEnter={() => onOpenChange(true)}
    >
      {children}
    </div>
  ),
  TooltipButton: () => null,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));

describe("dock rail add tooltip state", () => {
  it.each(["right", "bottom"] as const)(
    "dismisses and suppresses the %s rail tooltip while its menu is open",
    async (region) => {
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      let renderer!: TestRenderer.ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          <DockRail
            activeTabKey={null}
            allSurfaces={[]}
            launchers={[]}
            onCreate={vi.fn()}
            onClose={vi.fn()}
            onDelete={vi.fn()}
            onOpenLauncher={vi.fn()}
            onSelect={vi.fn()}
            pane={undefined}
            pending={false}
            projectId="project-1"
            region={region}
            surfaces={[]}
          />,
        );
      });

      const tooltip = () =>
        renderer.root.findByProps({ "data-create-tooltip": true });

      await act(async () => tooltip().props.onPointerEnter());
      expect(tooltip().props["data-open"]).toBe("true");

      await act(async () => menuState.onOpenChange?.(true));
      expect(tooltip().props["data-open"]).toBe("false");

      await act(async () => tooltip().props.onPointerEnter());
      expect(tooltip().props["data-open"]).toBe("false");

      await act(async () => menuState.onOpenChange?.(false));
      await act(async () => tooltip().props.onPointerEnter());
      expect(tooltip().props["data-open"]).toBe("true");

      await act(async () => renderer.unmount());
    },
  );
});
