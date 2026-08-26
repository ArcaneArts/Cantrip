import type { ChatSummary, ProjectTabLayoutSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { buildProjectSurfaceIndex } from "@/lib/project-surface";
import { emptyWorkspaceSelection } from "@/lib/workspace-selection";

import {
  projectWorkspaceSurfaceSelection,
  workspaceGroupSelection,
} from "./project-workspace-selection";

const timestamp = "2026-08-26T12:00:00.000Z";

function chat(id: string): ChatSummary {
  return {
    id,
    projectId: "project-1",
    title: id,
    experience: "agent",
    position: 0,
    status: "idle",
    activeWorkerId: "worker-1",
    activeWorktreeId: "worktree-1",
    placementRevision: 1,
    worktreeMode: "agent-managed",
    modelId: null,
    reasoningEffort: null,
    permissionProfileId: null,
    planMode: "default",
    hasPendingPlanQuestion: false,
    hasUnreadCompletion: false,
    automationPaused: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const layout: ProjectTabLayoutSummary = {
  projectId: "project-1",
  revision: 1,
  groups: ["one", "two"].map((id, position) => ({
    id: `group-${id}`,
    projectId: "project-1",
    title: id,
    position,
    anchorTabKey: `chat:${id}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    members: [
      {
        tabKey: `chat:${id}`,
        groupId: `group-${id}`,
        projectId: "project-1",
        tabKind: "chat" as const,
        tabId: id,
        title: id,
        position: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  })),
};

const surfaceIndex = buildProjectSurfaceIndex(layout, {
  browsers: [],
  chats: [chat("one"), chat("two")],
  codeTabs: [],
  explorers: [],
  projectViews: [],
  terminals: [],
});

describe("project workspace selection", () => {
  it("derives exactly one typed surface id from the selected tab key", () => {
    expect(
      projectWorkspaceSurfaceSelection({
        activeTabByGroup: { "group-one": "chat:one" },
        destination: "surface",
        projectId: "project-1",
        selectedGroupId: "group-one",
      }),
    ).toEqual({
      selectedBrowserId: null,
      selectedChatId: "one",
      selectedCodeTabId: null,
      selectedExplorerId: null,
      selectedProjectViewId: null,
      selectedTabKey: "chat:one",
      selectedTerminalId: null,
    });
  });

  it("uses the preview group for the tab bar only while the preview is active", () => {
    const workspaceSelection = {
      ...emptyWorkspaceSelection("project-1"),
      activeTabByGroup: { "group-one": "chat:one" },
      destination: "surface" as const,
      selectedGroupId: "group-one",
    };
    const preview = {
      active: true,
      explorerId: "sidebar-explorer",
      groupId: "group-two",
      path: "src/index.ts",
      projectId: "project-1",
    };

    expect(
      workspaceGroupSelection({
        projectSurfaceIndex: surfaceIndex,
        sidebarFilePreview: preview,
        tabLayout: layout,
        workspaceSelection,
      }).projectTabBarSurfaces.map(({ tabKey }) => tabKey),
    ).toEqual(["chat:two"]);
    expect(
      workspaceGroupSelection({
        projectSurfaceIndex: surfaceIndex,
        sidebarFilePreview: { ...preview, active: false },
        tabLayout: layout,
        workspaceSelection,
      }).projectTabBarSurfaces.map(({ tabKey }) => tabKey),
    ).toEqual(["chat:one"]);
  });
});
