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
  workspacePaneSelection,
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
  panes: ["one", "two"].map((id, position) => ({
    id: `group-${id}`,
    projectId: "project-1",
    title: id,
    position,
    region: "center",
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
      paneId: `group-${id}`,
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
        activeTabByPane: { "group-one": "chat:one" },
        destination: "surface",
        focusedPaneId: "group-one",
        projectId: "project-1",
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

  it("keeps every surface kind in the selected pane strip", () => {
    const workspaceSelection = {
      ...emptyWorkspaceSelection("project-1"),
      activeTabByPane: { "group-one": "chat:one" },
      destination: "surface" as const,
      focusedPaneId: "group-one",
    };
    const preview = {
      active: true,
      explorerId: "sidebar-explorer",
      paneId: "group-two",
      path: "src/index.ts",
      projectId: "project-1",
    };

    const activePreview = workspacePaneSelection({
      projectSurfaceIndex: surfaceIndex,
      sidebarFilePreview: preview,
      tabLayout: layout,
      workspaceSelection,
    });
    const inactivePreview = workspacePaneSelection({
      projectSurfaceIndex: surfaceIndex,
      sidebarFilePreview: { ...preview, active: false },
      tabLayout: layout,
      workspaceSelection,
    });

    expect(
      activePreview.selectedPaneSurfaces.map(({ tabKey }) => tabKey),
    ).toEqual(["chat:one", "explorer:file-one"]);
    expect(
      activePreview.orderedProjectSurfaces.map(({ tabKey }) => tabKey),
    ).toEqual([
      "chat:one",
      "explorer:file-one",
      "chat:two",
      "explorer:file-two",
    ]);
    expect(inactivePreview.selectedPaneSurfaces).toEqual(
      activePreview.selectedPaneSurfaces,
    );
  });
});
