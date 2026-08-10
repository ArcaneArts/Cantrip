import type { Collision } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";

import { filterWorkspacePointerCollisions } from "./workspace-dnd-provider";

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
