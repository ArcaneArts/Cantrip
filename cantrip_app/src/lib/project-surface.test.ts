import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  buildProjectSurfaceIndex,
  projectSurfaceTabId,
  projectSurfaceTabKey,
} from "./project-surface";

const timestamp = "2026-08-09T12:00:00.000Z";

const layout: ProjectTabLayoutSummary = {
  projectId: "project-1",
  revision: 2,
  groups: [
    {
      id: "group-1",
      projectId: "project-1",
      position: 0,
      anchorTabKey: "chat:chat-1",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [
        {
          tabKey: "chat:chat-1",
          groupId: "group-1",
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
          groupId: "group-1",
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
  it("adapts every persisted member to one discriminated surface", () => {
    const index = buildProjectSurfaceIndex(layout, {
      browsers: [],
      chats: [
        {
          id: "chat-1",
          projectId: "project-1",
          title: "Chat",
          position: 0,
          status: "idle",
          activeWorkerId: "worker-1",
          activeWorktreeId: "worktree-1",
          worktreeMode: "agent-managed",
          modelId: null,
          permissionProfileId: null,
          planMode: "default",
          hasPendingPlanQuestion: false,
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

    expect(index.byGroupId.get("group-1")?.map(({ kind }) => kind)).toEqual([
      "chat",
      "issues",
    ]);
    expect(index.byTabKey.get("view:issues-1")).toMatchObject({
      kind: "issues",
      entity: { id: "issues-1" },
    });
    expect(index.unresolvedTabKeys).toEqual([]);
  });

  it("does not promote linked consoles into standalone project surfaces", () => {
    const terminalLayout: ProjectTabLayoutSummary = {
      ...layout,
      groups: [
        {
          ...layout.groups[0]!,
          anchorTabKey: "terminal:console-1",
          members: [
            {
              ...layout.groups[0]!.members[0]!,
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
          title: "Codex console",
          position: 0,
          status: "running",
          activeWorkerId: "worker-1",
          worktreeId: "worktree-1",
          linkedChatId: "chat-1",
          service: { enabled: false, command: "" },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });
    expect(index.byTabKey.size).toBe(0);
    expect(index.unresolvedTabKeys).toEqual(["terminal:console-1"]);
  });

  it("normalizes view kinds to stable tab keys", () => {
    expect(projectSurfaceTabKey("remote-desktop", "desktop-1")).toBe(
      "view:desktop-1",
    );
    expect(projectSurfaceTabId("view:desktop-1", "view")).toBe("desktop-1");
    expect(projectSurfaceTabId("chat:chat-1", "view")).toBeNull();
  });
});
