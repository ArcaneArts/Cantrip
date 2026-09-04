import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  buildProjectSurfaceIndex,
  omitProjectSurfaceTabs,
  projectSurfaceTabId,
  projectSurfaceTabKey,
} from "./project-surface";

const timestamp = "2026-08-09T12:00:00.000Z";

const layout: ProjectTabLayoutSummary = {
  projectId: "project-1",
  revision: 2,
  panes: [
    {
      id: "group-1",
      projectId: "project-1",
      title: "Chat",
      position: 0,
      region: "center",
      anchorTabKey: "chat:chat-1",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [
        {
          tabKey: "chat:chat-1",
          paneId: "group-1",
          projectId: "project-1",
          tabKind: "chat",
          tabId: "chat-1",
          title: "Chat",
          position: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          tabKey: "view:issues-1",
          paneId: "group-1",
          projectId: "project-1",
          tabKind: "issues",
          tabId: "issues-1",
          title: "Issues",
          position: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  ],
};

describe("project surfaces", () => {
  it("resolves a built-in project tool without an entity collection row", () => {
    const builtInTabKey = "builtin:project-1:git.history";
    const index = buildProjectSurfaceIndex(
      {
        projectId: "project-1",
        revision: 3,
        panes: [
          {
            id: "group-history",
            projectId: "project-1",
            title: "History",
            position: 0,
            region: "center",
            anchorTabKey: builtInTabKey,
            createdAt: timestamp,
            updatedAt: timestamp,
            members: [
              {
                tabKey: builtInTabKey,
                paneId: "group-history",
                projectId: "project-1",
                tabKind: "builtin",
                tabId: "git.history",
                builtInState: {
                  definitionId: "git.history",
                  worktreeId: "worktree-1",
                },
                title: "History",
                position: 0,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
          },
        ],
      },
      {
        browsers: [],
        chats: [],
        codeTabs: [],
        explorers: [],
        projectViews: [],
        terminals: [],
      },
    );

    expect(index.byTabKey.get(builtInTabKey)).toMatchObject({
      kind: "builtin",
      title: "History",
      entity: {
        id: builtInTabKey,
        projectId: "project-1",
        definitionId: "git.history",
        worktreeId: "worktree-1",
      },
      resource: {
        ref: { kind: "builtin", definitionId: "git.history" },
      },
      view: {
        id: builtInTabKey,
        projectId: "project-1",
      },
    });
    expect(index.byPaneId.get("group-history")).toHaveLength(1);
    expect(index.unresolvedTabKeys).toEqual([]);
  });

  it("leaves a malformed built-in member unresolved", () => {
    const malformedTabKey = "builtin:project-1:git.history";
    const index = buildProjectSurfaceIndex(
      {
        projectId: "project-1",
        revision: 3,
        panes: [
          {
            id: "group-history",
            projectId: "project-1",
            title: "History",
            position: 0,
            region: "center",
            anchorTabKey: malformedTabKey,
            createdAt: timestamp,
            updatedAt: timestamp,
            members: [
              {
                tabKey: malformedTabKey,
                paneId: "group-history",
                projectId: "project-1",
                tabKind: "builtin",
                tabId: "git.history",
                title: "History",
                position: 0,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
          },
        ],
      },
      {
        browsers: [],
        chats: [],
        codeTabs: [],
        explorers: [],
        projectViews: [],
        terminals: [],
      },
    );

    expect(index.byTabKey.size).toBe(0);
    expect(index.byPaneId.get("group-history")).toEqual([]);
    expect(index.unresolvedTabKeys).toEqual([malformedTabKey]);
  });

  it("adapts every persisted member to one discriminated surface", () => {
    const index = buildProjectSurfaceIndex(layout, {
      browsers: [],
      chats: [
        {
          id: "chat-1",
          projectId: "project-1",
          title: "Chat",
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
        },
      ],
      codeTabs: [],
      explorers: [],
      projectViews: [
        {
          id: "issues-1",
          projectId: "project-1",
          title: "Issues",
          kind: "issues",
          worktreeId: null,
          position: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      terminals: [],
    });

    expect(index.byPaneId.get("group-1")?.map(({ kind }) => kind)).toEqual([
      "chat",
      "issues",
    ]);
    expect(index.byTabKey.get("view:issues-1")).toMatchObject({
      kind: "issues",
      entity: { id: "issues-1" },
    });
    expect(index.unresolvedTabKeys).toEqual([]);

    const closing = omitProjectSurfaceTabs(index, new Set(["chat:chat-1"]));
    expect(
      closing.byPaneId.get("group-1")?.map(({ tabKey }) => tabKey),
    ).toEqual(["view:issues-1"]);
    expect(closing.byTabKey.has("chat:chat-1")).toBe(false);
    expect(index.byTabKey.has("chat:chat-1")).toBe(true);
  });

  it("does not promote linked consoles into standalone project surfaces", () => {
    const terminalLayout: ProjectTabLayoutSummary = {
      ...layout,
      panes: [
        {
          ...layout.panes[0]!,
          anchorTabKey: "terminal:console-1",
          members: [
            {
              ...layout.panes[0]!.members[0]!,
              tabKey: "terminal:console-1",
              tabKind: "terminal",
              tabId: "console-1",
            },
          ],
        },
      ],
    };
    const index = buildProjectSurfaceIndex(terminalLayout, {
      browsers: [],
      chats: [],
      codeTabs: [],
      explorers: [],
      projectViews: [],
      terminals: [
        {
          id: "console-1",
          projectId: "project-1",
          kind: "chat-console",
          title: "Codex console",
          position: 0,
          status: "running",
          activeWorkerId: "worker-1",
          worktreeId: "worktree-1",
          linkedChatId: "chat-1",
          runConfigurationId: null,
          runConfigurationRuntimeId: null,
          directoryPath: null,
          service: { enabled: false, command: "" },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });
    expect(index.byTabKey.size).toBe(0);
    expect(index.unresolvedTabKeys).toEqual(["terminal:console-1"]);
  });

  it("keeps legacy Task chats out of dedicated project surfaces", () => {
    const index = buildProjectSurfaceIndex(layout, {
      browsers: [],
      chats: [
        {
          id: "chat-1",
          projectId: "project-1",
          title: "Task",
          experience: "task",
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
        },
      ],
      codeTabs: [],
      explorers: [],
      projectViews: [
        {
          id: "issues-1",
          projectId: "project-1",
          title: "Issues",
          kind: "issues",
          worktreeId: null,
          position: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      terminals: [],
    });

    expect(index.byTabKey.has("chat:chat-1")).toBe(false);
    expect(index.byPaneId.get("group-1")?.map(({ kind }) => kind)).toEqual([
      "issues",
    ]);
    expect(index.unresolvedTabKeys).toEqual([]);
  });

  it("normalizes view kinds to stable tab keys", () => {
    expect(projectSurfaceTabKey("remote-desktop", "desktop-1")).toBe(
      "view:desktop-1",
    );
    expect(projectSurfaceTabId("view:desktop-1", "view")).toBe("desktop-1");
    expect(projectSurfaceTabId("chat:chat-1", "view")).toBeNull();
    expect(
      projectSurfaceTabKey("builtin", "project.overview", "project-1"),
    ).toBe("builtin:project-1:project.overview");
    expect(() => projectSurfaceTabKey("builtin", "project.overview")).toThrow(
      "Built-in tab keys require a project id.",
    );
  });
});
