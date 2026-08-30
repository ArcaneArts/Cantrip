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
      title: "Chat a",
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
      title: "Explorer b",
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
    {
      id: "group-c",
      projectId: "project-1",
      title: "Explorer c",
      position: 2,
      anchorTabKey: "explorer:c",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [
        {
          groupId: "group-c",
          projectId: "project-1",
          tabKind: "explorer",
          tabId: "c",
          tabKey: "explorer:c",
          title: "Explorer c",
          position: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  ],
};

describe("workspace drag legality", () => {
  it("splits and sorts sidebar surfaces without creating nested tabs", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        {
          type: "surface",
          lane: "sidebar",
          projectId: "project-1",
          groupId: "group-a",
          tabKey: "chat:a",
          label: "Chat",
          lanePosition: 0,
          visualKind: "chat",
        },
        {
          type: "sidebar-tab",
          projectId: "project-1",
          groupId: "group-a",
          tabKey: "terminal:a",
          lanePosition: 1,
          memberPosition: 1,
        },
      ),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "chat:a",
          targetGroupId: null,
          targetGroupPosition: 1,
        },
      },
    });
  });

  it("sorts project-wide file tabs across their stored groups", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        {
          type: "surface",
          lane: "file-tabs",
          projectId: "project-1",
          groupId: "group-b",
          tabKey: "explorer:b",
          label: "Explorer b",
          lanePosition: 0,
          visualKind: "explorer",
        },
        {
          type: "top-tab",
          projectId: "project-1",
          groupId: "group-c",
          tabKey: "explorer:c",
          lanePosition: 1,
          memberPosition: 0,
        },
      ),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "explorer:b",
          targetGroupId: null,
          targetGroupPosition: 2,
        },
      },
    });
  });

  it("rejects moving sidebar surfaces into the file bar", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        {
          type: "surface",
          lane: "sidebar",
          projectId: "project-1",
          groupId: "group-a",
          tabKey: "chat:a",
          label: "Chat",
          lanePosition: 0,
          visualKind: "chat",
        },
        {
          type: "top-tab",
          projectId: "project-1",
          groupId: "group-b",
          tabKey: "explorer:b",
          lanePosition: 0,
          memberPosition: 0,
        },
      ),
    ).toMatchObject({ status: "invalid" });
  });

  it("moves a sidebar surface to the end of its lane", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        {
          type: "surface",
          lane: "sidebar",
          projectId: "project-1",
          groupId: "group-a",
          tabKey: "chat:a",
          label: "Chat",
          lanePosition: 0,
          visualKind: "chat",
        },
        {
          type: "sidebar-project",
          projectId: "project-1",
          groupPosition: 3,
          lanePosition: 2,
        },
      ),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "chat:a",
          targetGroupId: null,
          targetGroupPosition: 3,
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
          lane: "sidebar",
          projectId: "project-1",
          groupId: "group-a",
          tabKey: "chat:a",
          label: "Chat",
          lanePosition: 0,
          visualKind: "chat",
        },
        {
          type: "top-bar",
          projectId: "project-2",
          groupId: "other",
          tabKey: "explorer:other",
          lanePosition: 1,
          memberPosition: 0,
        },
      ),
    ).toMatchObject({ status: "invalid" });
  });
});
