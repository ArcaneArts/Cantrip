import type { ProjectSurface } from "@/lib/project-surface";
import { describe, expect, it } from "vitest";

import {
  nextProjectTabAfterRemoval,
  projectTabGroupAnchor,
  projectTabGroupVisualKind,
} from "./project-tab-group";

function surface(
  tabKey: string,
  kind: ProjectSurface["kind"] = "chat",
): ProjectSurface {
  const tabId = tabKey.slice(tabKey.indexOf(":") + 1);
  const base = {
    entity: {
      id: tabId,
      projectId: "project-1",
      title: tabId,
    },
    groupId: "group-1",
    kind,
    member: {
      groupId: "group-1",
      projectId: "project-1",
      tabKind: kind,
      tabId,
      tabKey,
      title: tabId,
      position: 0,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    },
    projectId: "project-1",
    tabId,
    tabKey,
    title: tabId,
  };
  return base as ProjectSurface;
}

describe("project tab group presentation", () => {
  it("uses the stable anchor surface even when it is not first", () => {
    const surfaces = [surface("chat:first"), surface("chat:anchor")];
    expect(
      projectTabGroupAnchor(
        {
          id: "group-1",
          projectId: "project-1",
          title: "Anchor",
          position: 0,
          anchorTabKey: "chat:anchor",
          members: surfaces.map(({ member }) => member),
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        surfaces,
      )?.tabKey,
    ).toBe("chat:anchor");
  });

  it("only uses the mixed icon for distinct surface types", () => {
    expect(
      projectTabGroupVisualKind([surface("chat:one"), surface("chat:two")]),
    ).toBe("chat");
    expect(
      projectTabGroupVisualKind([
        surface("chat:one"),
        surface("terminal:two", "terminal"),
      ]),
    ).toBe("mixed");
  });

  it("uses the Task visual kind without changing the persisted chat tab kind", () => {
    const task = surface("chat:task");
    if (task.kind !== "chat") throw new Error("Expected a Chat surface.");
    task.entity.experience = "task";

    expect(projectTabGroupVisualKind([task])).toBe("task");
    expect(task.member.tabKind).toBe("chat");
  });

  it("selects the right neighbor before falling back to the left", () => {
    const surfaces = [
      surface("chat:left"),
      surface("chat:active"),
      surface("chat:right"),
    ];
    expect(nextProjectTabAfterRemoval(surfaces, "chat:active")).toBe(
      "chat:right",
    );
    expect(nextProjectTabAfterRemoval(surfaces, "chat:right")).toBe(
      "chat:active",
    );
    expect(nextProjectTabAfterRemoval([surfaces[0]!], "chat:left")).toBeNull();
  });
});
