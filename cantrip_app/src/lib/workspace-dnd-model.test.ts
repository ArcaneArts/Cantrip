import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { decideWorkspaceDrop } from "./workspace-dnd-model";

const timestamp = "2026-08-09T12:00:00.000Z";
const layout: ProjectTabLayoutSummary = {
  projectId: "project-1",
  revision: 7,
  panes: [
    {
      id: "pane-a",
      projectId: "project-1",
      region: "center",
      title: "Mixed pane",
      position: 0,
      anchorTabKey: "explorer:file",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [
        ["explorer:file", "explorer"],
        ["chat:agent", "chat"],
        ["terminal:shell", "terminal"],
      ].map(([tabKey, tabKind], position) => ({
        paneId: "pane-a",
        projectId: "project-1",
        tabKind: tabKind as "explorer" | "chat" | "terminal",
        tabId: tabKey!.split(":")[1]!,
        tabKey: tabKey!,
        title: tabKey!,
        position,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    },
    {
      id: "pane-b",
      projectId: "project-1",
      region: "center",
      title: "Browser pane",
      position: 1,
      anchorTabKey: "browser:docs",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [
        {
          paneId: "pane-b",
          projectId: "project-1",
          tabKind: "browser",
          tabId: "docs",
          tabKey: "browser:docs",
          title: "Docs",
          position: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  ],
};

const drag = {
  type: "surface" as const,
  projectId: "project-1",
  paneId: "pane-a",
  tabKey: "chat:agent",
  label: "Agent",
  position: 1,
  visualKind: "chat" as const,
};

describe("workspace pane drag legality", () => {
  it("reorders mixed surface kinds in one pane", () => {
    expect(
      decideWorkspaceDrop(layout, drag, {
        type: "pane-tab",
        projectId: "project-1",
        paneId: "pane-a",
        tabKey: "explorer:file",
        memberPosition: 0,
      }),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "reorder-members",
          paneId: "pane-a",
          tabKeys: ["chat:agent", "explorer:file", "terminal:shell"],
        },
      },
    });
  });

  it("moves a surface across panes regardless of kind", () => {
    expect(
      decideWorkspaceDrop(layout, drag, {
        type: "pane-target",
        projectId: "project-1",
        paneId: "pane-b",
      }),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "chat:agent",
          targetPaneId: "pane-b",
          targetMemberPosition: 1,
        },
      },
    });
  });

  it("does not reorder a pane when its inventory target is selected", () => {
    expect(
      decideWorkspaceDrop(layout, drag, {
        type: "pane-target",
        projectId: "project-1",
        paneId: "pane-a",
      }),
    ).toEqual({ status: "noop" });
  });

  it("rejects cross-project drops", () => {
    expect(
      decideWorkspaceDrop(layout, drag, {
        type: "pane-target",
        projectId: "project-2",
        paneId: "other",
      }),
    ).toMatchObject({ status: "invalid" });
  });
});
