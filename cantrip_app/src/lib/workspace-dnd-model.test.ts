import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { decideWorkspaceDrop } from "./workspace-dnd-model";

const timestamp = "2026-08-09T12:00:00.000Z";
const layout: ProjectTabLayoutSummary = {
  projectId: "project-1",
  revision: 7,
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

describe("workspace drag legality", () => {
  it("sorts top tabs within their own group", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        {
          type: "surface",
          projectId: "project-1",
          groupId: "group-a",
          tabKey: "chat:a",
          label: "Chat",
          visualKind: "chat",
        },
        {
          type: "top-tab",
          projectId: "project-1",
          groupId: "group-a",
          tabKey: "terminal:a",
          memberPosition: 1,
        },
      ),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "reorder-members",
          tabKeys: ["terminal:a", "chat:a"],
        },
      },
    });
  });

  it("allows singleton sidebar groups into the visible top bar", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        {
          type: "group",
          projectId: "project-1",
          groupId: "group-b",
          label: "Explorer",
          visualKind: "explorer",
        },
        {
          type: "top-bar",
          projectId: "project-1",
          groupId: "group-a",
          memberPosition: 2,
        },
      ),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "explorer:b",
          targetGroupId: "group-a",
          targetMemberPosition: 2,
        },
      },
    });
  });

  it("rejects grouped sidebar rows and self-grouping", () => {
    const grouped = {
      type: "group" as const,
      projectId: "project-1",
      groupId: "group-a",
      label: "Chat",
      visualKind: "mixed" as const,
    };
    expect(
      decideWorkspaceDrop(layout, grouped, {
        type: "top-bar",
        projectId: "project-1",
        groupId: "group-b",
        memberPosition: 1,
      }),
    ).toMatchObject({ status: "invalid" });
    expect(
      decideWorkspaceDrop(layout, grouped, {
        type: "top-bar",
        projectId: "project-1",
        groupId: "group-a",
        memberPosition: 2,
      }),
    ).toMatchObject({ status: "invalid" });
  });

  it("splits a top tab into a sidebar singleton", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        {
          type: "surface",
          projectId: "project-1",
          groupId: "group-a",
          tabKey: "terminal:a",
          label: "Terminal",
          visualKind: "terminal",
        },
        {
          type: "sidebar-group",
          projectId: "project-1",
          groupId: "group-b",
          groupPosition: 1,
        },
      ),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "terminal:a",
          targetGroupId: null,
          targetGroupPosition: 1,
        },
      },
    });
  });

  it("rejects cross-project drops", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        {
          type: "surface",
          projectId: "project-1",
          groupId: "group-a",
          tabKey: "chat:a",
          label: "Chat",
          visualKind: "chat",
        },
        {
          type: "top-bar",
          projectId: "project-2",
          groupId: "other",
          memberPosition: 0,
        },
      ),
    ).toMatchObject({ status: "invalid" });
  });
});
