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
  type?: "top-bar" | "sidebar-project" | "sidebar-group",
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

  it("prefers precise tab and sidebar rows over their enclosing containers", () => {
    const row = collision("row", "sidebar-group");
    expect(
      filterWorkspacePointerCollisions([
        collision("bar", "top-bar"),
        collision("project", "sidebar-project"),
        row,
      ]),
    ).toEqual([row]);
  });

  it("keeps an enclosing bar when it is the only pointer target", () => {
    const bar = collision("bar", "top-bar");
    expect(filterWorkspacePointerCollisions([bar])).toEqual([bar]);
  });
});

describe("workspace drag preview", () => {
  const drag = {
    type: "group" as const,
    projectId: "project-1",
    groupId: "group-1",
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
