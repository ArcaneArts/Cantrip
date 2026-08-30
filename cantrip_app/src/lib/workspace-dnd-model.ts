import type { ProjectTabLayoutSummary } from "@cantrip/protocol";

import type { ProjectTabGroupVisualKind } from "@/lib/project-tab-group";
import type { ProjectSurface } from "@/lib/project-surface";

export type WorkspaceDragItem =
  | { type: "project"; projectId: string; label: string }
  | {
      type: "group";
      projectId: string;
      groupId: string;
      label: string;
      visualKind: ProjectTabGroupVisualKind;
    }
  | {
      type: "surface";
      lane: "file-tabs" | "sidebar";
      projectId: string;
      groupId: string;
      tabKey: string;
      label: string;
      lanePosition: number;
      visualKind: ProjectSurface["kind"];
    };

export type WorkspaceDropTarget =
  | { type: "project"; projectId: string }
  | {
      type: "sidebar-group";
      projectId: string;
      groupId: string;
      groupPosition: number;
    }
  | {
      type: "sidebar-project";
      projectId: string;
      groupPosition: number;
      lanePosition: number;
    }
  | {
      type: "sidebar-tab";
      projectId: string;
      groupId: string;
      tabKey: string;
      lanePosition: number;
      memberPosition: number;
    }
  | {
      type: "top-bar";
      projectId: string;
      groupId: string;
      tabKey: string;
      lanePosition: number;
      memberPosition: number;
    }
  | {
      type: "top-tab";
      projectId: string;
      groupId: string;
      tabKey: string;
      lanePosition: number;
      memberPosition: number;
    };

export interface WorkspaceDndData {
  drag?: WorkspaceDragItem;
  drop?: WorkspaceDropTarget;
}

export type TabLayoutCommand =
  | { type: "reorder-groups"; groupIds: string[] }
  | { type: "reorder-members"; groupId: string; tabKeys: string[] }
  | {
      type: "move-member";
      tabKey: string;
      targetGroupId: string | null;
      targetMemberPosition: number;
      targetGroupPosition?: number;
    };

export type WorkspaceDropOperation =
  | {
      type: "reorder-projects";
      sourceProjectId: string;
      targetProjectId: string;
    }
  | { type: "tab-layout"; projectId: string; command: TabLayoutCommand };

export type WorkspaceDropDecision =
  | { status: "valid"; operation: WorkspaceDropOperation }
  | { status: "invalid"; reason: string }
  | { status: "noop" };

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

export function decideWorkspaceDrop(
  layout: ProjectTabLayoutSummary | null | undefined,
  drag: WorkspaceDragItem | null | undefined,
  drop: WorkspaceDropTarget | null | undefined,
): WorkspaceDropDecision {
  if (!drag || !drop) return { status: "invalid", reason: "No drop target." };
  if (drag.type === "project") {
    if (drop.type !== "project") {
      return {
        status: "invalid",
        reason: "Projects can only be sorted with other projects.",
      };
    }
    return drag.projectId === drop.projectId
      ? { status: "noop" }
      : {
          status: "valid",
          operation: {
            type: "reorder-projects",
            sourceProjectId: drag.projectId,
            targetProjectId: drop.projectId,
          },
        };
  }
  if (!layout || drag.projectId !== layout.projectId) {
    return { status: "invalid", reason: "The project layout is unavailable." };
  }
  if (drop.type === "project" || drop.projectId !== drag.projectId) {
    return {
      status: "invalid",
      reason: "Tab groups cannot span projects.",
    };
  }

  if (drag.type === "group") {
    const sourceGroup = layout.groups.find(({ id }) => id === drag.groupId);
    if (!sourceGroup) {
      return {
        status: "invalid",
        reason: "The dragged group no longer exists.",
      };
    }
    if (drop.type === "sidebar-group") {
      if (drop.groupId === sourceGroup.id) return { status: "noop" };
      const from = layout.groups.findIndex(({ id }) => id === sourceGroup.id);
      const to = layout.groups.findIndex(({ id }) => id === drop.groupId);
      return {
        status: "valid",
        operation: {
          type: "tab-layout",
          projectId: drag.projectId,
          command: {
            type: "reorder-groups",
            groupIds: moved(
              layout.groups.map(({ id }) => id),
              from,
              to,
            ),
          },
        },
      };
    }
    return {
      status: "invalid",
      reason: "Sidebar groups can only be sorted in the sidebar.",
    };
  }

  const sourceGroup = layout.groups.find(({ id }) => id === drag.groupId);
  if (!sourceGroup) {
    return { status: "invalid", reason: "The dragged tab no longer exists." };
  }
  const fileDrop = drop.type === "top-tab" || drop.type === "top-bar";
  const sidebarDrop =
    drop.type === "sidebar-tab" || drop.type === "sidebar-project";
  if (
    (drag.lane === "file-tabs" && !fileDrop) ||
    (drag.lane === "sidebar" && !sidebarDrop)
  ) {
    return {
      status: "invalid",
      reason:
        drag.lane === "file-tabs"
          ? "File tabs stay in the top file bar."
          : "Project surfaces stay in the sidebar.",
    };
  }

  if (drop.type === "sidebar-project") {
    if (drag.lanePosition === drop.lanePosition - 1) {
      return { status: "noop" };
    }
    return {
      status: "valid",
      operation: {
        type: "tab-layout",
        projectId: drag.projectId,
        command: {
          type: "move-member",
          tabKey: drag.tabKey,
          targetGroupId: null,
          targetMemberPosition: 0,
          targetGroupPosition: drop.groupPosition,
        },
      },
    };
  }

  if (
    drop.type !== "top-tab" &&
    drop.type !== "top-bar" &&
    drop.type !== "sidebar-tab"
  ) {
    return { status: "invalid", reason: "This is not a tab drop target." };
  }
  if (drop.tabKey === drag.tabKey) return { status: "noop" };
  const targetGroup = layout.groups.find(({ id }) => id === drop.groupId);
  if (!targetGroup) {
    return { status: "invalid", reason: "The target tab no longer exists." };
  }
  const sourceGroupWillRemain = sourceGroup.members.length > 1;
  const targetPositionAfterRemoval =
    !sourceGroupWillRemain && sourceGroup.position < targetGroup.position
      ? targetGroup.position - 1
      : targetGroup.position;
  const targetGroupPosition =
    targetPositionAfterRemoval +
    (drag.lanePosition < drop.lanePosition ? 1 : 0);
  return {
    status: "valid",
    operation: {
      type: "tab-layout",
      projectId: drag.projectId,
      command: {
        type: "move-member",
        tabKey: drag.tabKey,
        targetGroupId: null,
        targetMemberPosition: 0,
        targetGroupPosition,
      },
    },
  };
}

export function workspaceProjectDragId(projectId: string): string {
  return `workspace:project:${projectId}`;
}

export function workspaceGroupDragId(groupId: string): string {
  return `workspace:group:${groupId}`;
}

export function workspaceSurfaceDragId(tabKey: string): string {
  return `workspace:surface:${tabKey}`;
}

export function workspaceTopBarDropId(groupId: string): string {
  return `workspace:top-bar:${groupId}`;
}

export function workspaceSidebarDropId(projectId: string): string {
  return `workspace:sidebar:${projectId}`;
}
