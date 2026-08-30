import type {
  ChatSummary,
  ExplorerSummary,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";
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

function file(id: string): ExplorerSummary {
  return {
    id: `file-${id}`,
    projectId: "project-1",
    title: `${id}.ts`,
    position: 0,
    activeWorkerId: "worker-1",
    worktreeId: "worktree-1",
    selectedPath: `src/${id}.ts`,
    fileMode: "edit",
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
      { tabKind: "chat" as const, tabId: id, title: id },
      {
        tabKind: "explorer" as const,
        tabId: `file-${id}`,
        title: `${id}.ts`,
      },
    ].map((member, memberPosition) => ({
      ...member,
      tabKey: `${member.tabKind}:${member.tabId}`,
      groupId: `group-${id}`,
      projectId: "project-1",
      position: memberPosition,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  })),
};

const surfaceIndex = buildProjectSurfaceIndex(layout, {
  browsers: [],
  chats: [chat("one"), chat("two")],
  codeTabs: [],
  explorers: [file("one"), file("two")],
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

  it("keeps file tabs on top and non-file surfaces in the sidebar", () => {
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

    const activePreview = workspaceGroupSelection({
      projectSurfaceIndex: surfaceIndex,
      sidebarFilePreview: preview,
      tabLayout: layout,
      workspaceSelection,
    });
    const inactivePreview = workspaceGroupSelection({
      projectSurfaceIndex: surfaceIndex,
      sidebarFilePreview: { ...preview, active: false },
      tabLayout: layout,
      workspaceSelection,
    });

    expect(
      activePreview.projectTabBarSurfaces.map(({ tabKey }) => tabKey),
    ).toEqual(["explorer:file-one", "explorer:file-two"]);
    expect(
      activePreview.projectSidebarSurfaces.map(({ tabKey }) => tabKey),
    ).toEqual(["chat:one", "chat:two"]);
    expect(inactivePreview.projectTabBarSurfaces).toEqual(
      activePreview.projectTabBarSurfaces,
    );
  });
});
