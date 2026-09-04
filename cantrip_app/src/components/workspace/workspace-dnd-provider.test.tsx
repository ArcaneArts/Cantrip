import type { Collision } from "@dnd-kit/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  canStartWorkspacePointerDrag,
  filterWorkspacePointerCollisions,
  WorkspaceDragPreview,
} from "./workspace-dnd-provider";

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
  type?: "pane-edge" | "pane-strip" | "pane-tab" | "pane-target",
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
    ).toEqual([tab, target]);
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
