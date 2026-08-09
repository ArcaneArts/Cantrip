import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  applyOptimisticTabLayoutCommand,
  applyOptimisticTabLayoutToCache,
  restoreOptimisticTabLayoutCache,
} from "./project-tab-layout-optimistic";

const timestamp = "2026-08-09T12:00:00.000Z";
const layout: ProjectTabLayoutSummary = {
  projectId: "project-1",
  revision: 4,
  groups: [
    {
      id: "group-a",
      projectId: "project-1",
      position: 0,
      anchorTabKey: "chat:a",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: ["chat:a", "terminal:a"].map((tabKey, position) => ({
        groupId: "group-a",
        projectId: "project-1",
        tabKind: position === 0 ? "chat" : "terminal",
        tabId: tabKey.split(":")[1]!,
        tabKey,
        title: tabKey,
        position,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    },
    {
      id: "group-b",
      projectId: "project-1",
      position: 1,
      anchorTabKey: "explorer:b",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [
        {
          groupId: "group-b",
          projectId: "project-1",
          tabKind: "explorer",
          tabId: "b",
          tabKey: "explorer:b",
          title: "Explorer",
          position: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  ],
};

describe("optimistic tab layouts", () => {
  it("promotes the first remaining member when splitting the anchor", () => {
    const next = applyOptimisticTabLayoutCommand(layout, {
      type: "move-member",
      tabKey: "chat:a",
      targetGroupId: null,
      targetMemberPosition: 0,
      targetGroupPosition: 1,
    });
    expect(next.groups[0]?.anchorTabKey).toBe("terminal:a");
    expect(next.groups[1]?.anchorTabKey).toBe("chat:a");
    expect(next.groups.map(({ position }) => position)).toEqual([0, 1, 2]);
  });

  it("removes an emptied singleton group when joining another group", () => {
    const next = applyOptimisticTabLayoutCommand(layout, {
      type: "move-member",
      tabKey: "explorer:b",
      targetGroupId: "group-a",
      targetMemberPosition: 1,
    });
    expect(next.groups).toHaveLength(1);
    expect(next.groups[0]?.members.map(({ tabKey }) => tabKey)).toEqual([
      "chat:a",
      "explorer:b",
      "terminal:a",
    ]);
  });

  it("restores the authoritative snapshot after a rejected mutation", () => {
    const queryClient = new QueryClient();
    const queryKey = ["project-tab-layout", layout.projectId] as const;
    queryClient.setQueryData(queryKey, layout);
    const snapshot = applyOptimisticTabLayoutToCache(
      queryClient,
      layout.projectId,
      {
        type: "move-member",
        tabKey: "explorer:b",
        targetGroupId: "group-a",
        targetMemberPosition: 1,
      },
    );
    expect(
      queryClient.getQueryData<ProjectTabLayoutSummary>(queryKey)?.groups,
    ).toHaveLength(1);

    restoreOptimisticTabLayoutCache(queryClient, snapshot);
    expect(queryClient.getQueryData(queryKey)).toEqual(layout);
  });
});
