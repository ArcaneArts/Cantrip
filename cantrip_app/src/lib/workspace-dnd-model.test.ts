import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  decideWorkspaceDrop,
  workspaceSurfaceDropPreview,
} from "./workspace-dnd-model";

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
    {
      id: "pane-right",
      projectId: "project-1",
      region: "right",
      title: "Right dock",
      position: 0,
      anchorTabKey: "browser:reference",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [
        {
          paneId: "pane-right",
          projectId: "project-1",
          tabKind: "browser",
          tabId: "reference",
          tabKey: "browser:reference",
          title: "Reference",
          position: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
    {
      id: "pane-bottom",
      projectId: "project-1",
      region: "bottom",
      title: "Bottom dock",
      position: 0,
      anchorTabKey: "terminal:dock",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [
        {
          paneId: "pane-bottom",
          projectId: "project-1",
          tabKind: "terminal",
          tabId: "dock",
          tabKey: "terminal:dock",
          title: "Dock terminal",
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

  it("moves a supported surface into a new empty dock region", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        { ...drag, supportedRegions: ["center", "bottom"] },
        {
          type: "region",
          projectId: "project-1",
          region: "bottom",
          paneId: null,
        },
      ),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "chat:agent",
          targetPaneId: null,
          targetMemberPosition: 0,
          targetRegion: "bottom",
        },
      },
    });
  });

  it("appends to an existing dock pane without sending a redundant region", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        { ...drag, supportedRegions: ["center", "right"] },
        {
          type: "region",
          projectId: "project-1",
          region: "right",
          paneId: "pane-right",
        },
      ),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "chat:agent",
          targetPaneId: "pane-right",
          targetMemberPosition: 1,
        },
      },
    });
    const decision = decideWorkspaceDrop(
      layout,
      { ...drag, supportedRegions: ["center", "right"] },
      {
        type: "region",
        projectId: "project-1",
        region: "right",
        paneId: "pane-right",
      },
    );
    expect(
      decision.status === "valid"
        ? decision.operation.type === "tab-layout"
          ? decision.operation.command
          : null
        : null,
    ).not.toHaveProperty("targetRegion");
  });

  it("rejects unsupported or stale region targets", () => {
    expect(
      decideWorkspaceDrop(
        layout,
        { ...drag, supportedRegions: ["center"] },
        {
          type: "region",
          projectId: "project-1",
          region: "bottom",
          paneId: null,
        },
      ),
    ).toMatchObject({ status: "invalid" });
    expect(
      decideWorkspaceDrop(layout, drag, {
        type: "region",
        projectId: "project-1",
        region: "bottom",
        paneId: "pane-right",
      }),
    ).toMatchObject({ status: "invalid" });
  });

  it("moves exactly one member between bottom, right, and center panes", () => {
    const bottomDrag = {
      ...drag,
      paneId: "pane-bottom",
      tabKey: "terminal:dock",
      label: "Dock terminal",
      position: 0,
      visualKind: "terminal" as const,
    };
    expect(
      decideWorkspaceDrop(layout, bottomDrag, {
        type: "pane-tab",
        projectId: "project-1",
        paneId: "pane-right",
        tabKey: "browser:reference",
        memberPosition: 0,
      }),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "terminal:dock",
          targetPaneId: "pane-right",
          targetMemberPosition: 0,
        },
      },
    });
    expect(
      decideWorkspaceDrop(layout, bottomDrag, {
        type: "pane-strip",
        projectId: "project-1",
        paneId: "pane-a",
        memberPosition: 3,
      }),
    ).toMatchObject({
      status: "valid",
      operation: {
        command: {
          type: "move-member",
          tabKey: "terminal:dock",
          targetPaneId: "pane-a",
          targetMemberPosition: 3,
        },
      },
    });
  });

  it("projects a cross-container insertion only while the drop is valid", () => {
    const bottomDrag = {
      ...drag,
      paneId: "pane-bottom",
      tabKey: "terminal:dock",
      label: "Dock terminal",
      visualKind: "terminal" as const,
    };
    const drop = {
      type: "pane-tab" as const,
      projectId: "project-1",
      paneId: "pane-right",
      tabKey: "browser:reference",
      memberPosition: 0,
    };
    const decision = decideWorkspaceDrop(layout, bottomDrag, drop);

    expect(
      workspaceSurfaceDropPreview({
        decision,
        drag: bottomDrag,
        drop,
        memberCount: 1,
        paneId: "pane-right",
        region: "right",
      }),
    ).toEqual({
      label: "Dock terminal",
      memberPosition: 0,
      tabKey: "terminal:dock",
      visualKind: "terminal",
    });
    expect(
      workspaceSurfaceDropPreview({
        decision: { status: "noop" },
        drag: bottomDrag,
        drop,
        memberCount: 1,
        paneId: "pane-right",
        region: "right",
      }),
    ).toBeNull();
  });
});
