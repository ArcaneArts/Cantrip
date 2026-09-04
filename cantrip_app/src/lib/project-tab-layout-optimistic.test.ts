import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  applyOptimisticTabLayoutCommand,
  applyOptimisticTabLayoutToCache,
  removeProjectTabFromLayout,
  restoreOptimisticTabLayoutCache,
} from "./project-tab-layout-optimistic";

const timestamp = "2026-08-09T12:00:00.000Z";
const layout: ProjectTabLayoutSummary = {
  projectId: "project-1",
  revision: 4,
  panes: [
    {
      id: "group-a",
      projectId: "project-1",
      title: "Chat a",
      position: 0,
      region: "center",
      anchorTabKey: "chat:a",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: ["chat:a", "terminal:a"].map((tabKey, position) => ({
        paneId: "group-a",
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
      title: "Explorer b",
      position: 1,
      region: "center",
      anchorTabKey: "explorer:b",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [
        {
          paneId: "group-b",
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
const splitLayout: ProjectTabLayoutSummary = {
  ...layout,
  centerRoot: {
    kind: "split",
    id: "root-split",
    direction: "horizontal",
    fraction: 0.6,
    first: { kind: "pane", paneId: "group-a" },
    second: { kind: "pane", paneId: "group-b" },
  },
};

describe("optimistic tab layouts", () => {
  it("removes a member and immediately promotes the remaining tab", () => {
    const next = removeProjectTabFromLayout(layout, "chat:a");

    expect(next.panes[0]).toMatchObject({
      anchorTabKey: "terminal:a",
      position: 0,
      title: "terminal:a",
    });
    expect(next.panes[0]?.members).toMatchObject([
      { position: 0, tabKey: "terminal:a" },
    ]);
  });

  it("removes and repositions an emptied tab group", () => {
    const next = removeProjectTabFromLayout(layout, "explorer:b");

    expect(next.panes).toHaveLength(1);
    expect(next.panes[0]).toMatchObject({ id: "group-a", position: 0 });
  });

  it("collapses the center tree when the final tab is removed", () => {
    const next = removeProjectTabFromLayout(splitLayout, "explorer:b");
    expect(next.centerRoot).toEqual({ kind: "pane", paneId: "group-a" });
  });

  it("projects edge splits and split resizing into the cache", () => {
    const split = applyOptimisticTabLayoutCommand(splitLayout, {
      type: "split-member",
      edge: "top",
      tabKey: "chat:a",
      targetPaneId: "group-b",
    });
    expect(split.panes.map(({ id }) => id)).toContain("optimistic:pane:chat:a");
    expect(split.centerRoot).toMatchObject({
      second: {
        id: "optimistic:split:chat:a",
        direction: "vertical",
        first: { paneId: "optimistic:pane:chat:a" },
        second: { paneId: "group-b" },
      },
    });

    const resized = applyOptimisticTabLayoutCommand(split, {
      type: "resize-center-split",
      splitId: "root-split",
      fraction: 0.35,
    });
    expect(resized.centerRoot).toMatchObject({ fraction: 0.35 });
  });

  it("promotes the first remaining member when splitting the anchor", () => {
    const next = applyOptimisticTabLayoutCommand(layout, {
      type: "move-member",
      tabKey: "chat:a",
      targetPaneId: null,
      targetMemberPosition: 0,
      targetPanePosition: 1,
    });
    expect(next.panes[0]?.anchorTabKey).toBe("terminal:a");
    expect(next.panes[0]?.title).toBe("terminal:a");
    expect(next.panes[1]?.anchorTabKey).toBe("chat:a");
    expect(next.panes[1]?.title).toBe("chat:a");
    expect(next.panes.map(({ position }) => position)).toEqual([0, 1, 2]);
  });

  it("inserts split panes at a region-local position", () => {
    const rightPane = {
      ...layout.panes[1]!,
      id: "group-right",
      region: "right" as const,
      position: 0,
    };
    const mixedLayout = {
      ...layout,
      panes: [layout.panes[0]!, layout.panes[1]!, rightPane],
    };

    const next = applyOptimisticTabLayoutCommand(mixedLayout, {
      type: "move-member",
      tabKey: "chat:a",
      targetPaneId: null,
      targetMemberPosition: 0,
      targetPanePosition: 1,
    });

    expect(next.panes.map(({ id }) => id)).toEqual([
      "group-a",
      "optimistic:chat:a",
      "group-b",
      "group-right",
    ]);
    expect(next.panes.map(({ position }) => position)).toEqual([0, 1, 2, 0]);
  });

  it("removes an emptied singleton group when joining another group", () => {
    const next = applyOptimisticTabLayoutCommand(layout, {
      type: "move-member",
      tabKey: "explorer:b",
      targetPaneId: "group-a",
      targetMemberPosition: 1,
    });
    expect(next.panes).toHaveLength(1);
    expect(next.panes[0]?.members.map(({ tabKey }) => tabKey)).toEqual([
      "chat:a",
      "explorer:b",
      "terminal:a",
    ]);
    expect(next.panes[0]?.title).toBe("Chat a");
  });

  it("keeps center leaves exact across ordinary moves", () => {
    const joined = applyOptimisticTabLayoutCommand(splitLayout, {
      type: "move-member",
      tabKey: "explorer:b",
      targetPaneId: "group-a",
      targetMemberPosition: 1,
    });
    expect(joined.centerRoot).toEqual({ kind: "pane", paneId: "group-a" });

    const split = applyOptimisticTabLayoutCommand(splitLayout, {
      type: "move-member",
      tabKey: "chat:a",
      targetPaneId: null,
      targetMemberPosition: 0,
      targetPanePosition: 1,
      targetRegion: "center",
    });
    expect(split.centerRoot).toBeDefined();
    const leafIds = JSON.stringify(split.centerRoot).match(
      /(?:group-a|group-b|optimistic:chat:a)/g,
    );
    expect(leafIds).toEqual(["group-a", "optimistic:chat:a", "group-b"]);
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
        targetPaneId: "group-a",
        targetMemberPosition: 1,
      },
    );
    expect(
      queryClient.getQueryData<ProjectTabLayoutSummary>(queryKey)?.panes,
    ).toHaveLength(1);

    restoreOptimisticTabLayoutCache(queryClient, snapshot);
    expect(queryClient.getQueryData(queryKey)).toEqual(layout);
  });
});
