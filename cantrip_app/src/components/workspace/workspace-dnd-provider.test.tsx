import type { Collision } from "@dnd-kit/core";
import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const dndHarness = vi.hoisted(() => ({
  handlers: null as Record<string, (...args: any[]) => void> | null,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, ...handlers }: { children: ReactNode }) => {
    dndHarness.handlers = handlers as typeof dndHarness.handlers;
    return children;
  },
  DragOverlay: ({
    children,
    dropAnimation,
    zIndex,
  }: {
    children: ReactNode;
    dropAnimation: unknown;
    zIndex: number;
  }) => (
    <div
      data-drop-animation={dropAnimation === null ? "disabled" : "enabled"}
      data-overlay-z-index={zIndex}
    >
      {children}
    </div>
  ),
  PointerSensor: class {},
  pointerWithin: () => [],
  useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }),
  useSensor: () => ({}),
  useSensors: () => [],
}));

import {
  canStartWorkspacePointerDrag,
  filterWorkspacePointerCollisions,
  WorkspaceDragPreview,
  WorkspaceDndProvider,
} from "./workspace-dnd-provider";
import { useWorkspaceDndState } from "./workspace-dnd-state";

describe("workspace pointer drag activation", () => {
  it("keeps plain primary presses draggable", () => {
    expect(
      canStartWorkspacePointerDrag({
        button: 0,
        ctrlKey: false,
        isPrimary: true,
      }),
    ).toBe(true);
  });

  it("leaves right-click and Control-click available to context menus", () => {
    expect(
      canStartWorkspacePointerDrag({
        button: 2,
        ctrlKey: false,
        isPrimary: true,
      }),
    ).toBe(false);
    expect(
      canStartWorkspacePointerDrag({
        button: 0,
        ctrlKey: true,
        isPrimary: true,
      }),
    ).toBe(false);
  });
});

function collision(
  id: string,
  type?: "pane-edge" | "pane-strip" | "pane-tab" | "pane-target" | "region",
): Collision {
  return {
    id,
    data: type
      ? { droppableContainer: { data: { current: { drop: { type } } } } }
      : undefined,
  } as Collision;
}

describe("workspace pointer collision filtering", () => {
  it("returns no target outside the current window's registered drop areas", () => {
    expect(filterWorkspacePointerCollisions([])).toEqual([]);
  });

  it("prefers precise pane tabs and targets over their enclosing strip", () => {
    const tab = collision("tab", "pane-tab");
    const target = collision("target", "pane-target");
    expect(
      filterWorkspacePointerCollisions([
        collision("strip", "pane-strip"),
        tab,
        target,
      ]),
    ).toEqual([tab]);
  });

  it("keeps an enclosing strip when it is the only pointer target", () => {
    const strip = collision("strip", "pane-strip");
    expect(filterWorkspacePointerCollisions([strip])).toEqual([strip]);
  });

  it("prefers an explicit center edge over overlapping tab targets", () => {
    const edge = collision("edge", "pane-edge");
    expect(
      filterWorkspacePointerCollisions([
        collision("tab", "pane-tab"),
        edge,
        collision("strip", "pane-strip"),
      ]),
    ).toEqual([edge]);
  });

  it("prefers a rail tab over its enclosing region", () => {
    const tab = collision("tab", "pane-tab");
    const region = collision("right-rail", "region");

    expect(filterWorkspacePointerCollisions([region, tab])).toEqual([tab]);
    expect(filterWorkspacePointerCollisions([region])).toEqual([region]);
  });
});

describe("workspace drag preview", () => {
  const drag = {
    type: "pane" as const,
    paneId: "group-1",
    projectId: "project-1",
    region: "center" as const,
    label: "Terminal",
    visualKind: "terminal" as const,
  };

  it("uses a subtle cancel indicator without destructive highlighting", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceDragPreview
        drag={drag}
        decision={{ status: "invalid", reason: "Cannot drop here." }}
      />,
    );

    expect(markup).toContain('data-drop-status="invalid"');
    expect(markup).toContain('aria-label="Cannot drop here."');
    expect(markup).toContain("bg-muted text-muted-foreground");
    expect(markup).not.toContain("destructive");
  });

  it("does not show the cancel indicator for non-invalid destinations", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceDragPreview drag={drag} decision={{ status: "noop" }} />,
    );

    expect(markup).not.toContain("Cannot drop here.");
  });
});

describe("workspace drag lifecycle", () => {
  it("shows cross-container state before drop and clears it before commit", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const timestamp = "2026-09-04T12:00:00.000Z";
    const layout = {
      projectId: "project-1",
      revision: 1,
      panes: [
        {
          id: "right-pane",
          projectId: "project-1",
          region: "right",
          title: "Right",
          position: 0,
          anchorTabKey: "browser:right",
          createdAt: timestamp,
          updatedAt: timestamp,
          members: [],
        },
        {
          id: "bottom-pane",
          projectId: "project-1",
          region: "bottom",
          title: "Bottom",
          position: 0,
          anchorTabKey: "terminal:bottom",
          createdAt: timestamp,
          updatedAt: timestamp,
          members: [
            {
              paneId: "bottom-pane",
              projectId: "project-1",
              tabKind: "terminal",
              tabId: "bottom",
              tabKey: "terminal:bottom",
              title: "Terminal",
              position: 0,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      ],
    } as ProjectTabLayoutSummary;
    const drag = {
      type: "surface" as const,
      projectId: "project-1",
      paneId: "bottom-pane",
      tabKey: "terminal:bottom",
      label: "Terminal",
      position: 0,
      supportedRegions: ["center", "right", "bottom"] as const,
      visualKind: "terminal" as const,
    };
    const drop = {
      type: "region" as const,
      projectId: "project-1",
      region: "right" as const,
      paneId: "right-pane",
    };
    const active = {
      id: "workspace:surface:terminal:bottom",
      data: { current: { drag } },
    };
    const over = {
      id: "workspace:region:right",
      data: { current: { drop } },
    };
    const onOperation = vi.fn();
    const observed: Array<ReturnType<typeof useWorkspaceDndState>> = [];
    const Probe = () => {
      const state = useWorkspaceDndState();
      observed.push(state);
      return (
        <div
          data-active-drag={state.activeDrag?.type ?? "none"}
          data-drop-target={state.dropTarget?.type ?? "none"}
        />
      );
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WorkspaceDndProvider
          layout={layout}
          onOperation={onOperation}
          projects={[]}
        >
          <Probe />
        </WorkspaceDndProvider>,
      );
    });

    expect(
      renderer.root.findByProps({ "data-drop-animation": "disabled" }).props[
        "data-overlay-z-index"
      ],
    ).toBe(1000);
    await act(async () => dndHarness.handlers!.onDragStart!({ active }));
    expect(
      renderer.root.findAllByProps({
        "data-workspace-drag-preview": "surface",
      }),
    ).toHaveLength(1);

    await act(async () => dndHarness.handlers!.onDragOver!({ active, over }));
    expect(
      renderer.root.findByType(Probe).findByType("div").props,
    ).toMatchObject({
      "data-active-drag": "surface",
      "data-drop-target": "region",
    });

    await act(async () => dndHarness.handlers!.onDragEnd!({ active, over }));
    expect(onOperation).toHaveBeenCalledWith({
      type: "tab-layout",
      projectId: "project-1",
      command: {
        type: "move-member",
        tabKey: "terminal:bottom",
        targetPaneId: "right-pane",
        targetMemberPosition: 0,
      },
    });
    expect(
      renderer.root.findAllByProps({
        "data-workspace-drag-preview": "surface",
      }),
    ).toHaveLength(0);
    expect(observed.at(-1)).toMatchObject({
      activeDrag: null,
      decision: null,
      dropTarget: null,
    });

    await act(async () => renderer.unmount());
  });
});
