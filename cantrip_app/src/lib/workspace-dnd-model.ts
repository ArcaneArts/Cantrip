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
      projectId: string;
      groupId: string;
      tabKey: string;
      label: string;
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
    }
  | {
      type: "top-bar";
      projectId: string;
      groupId: string;
      memberPosition: number;
    }
  | {
      type: "top-tab";
      projectId: string;
      groupId: string;
      tabKey: string;
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
    if (drop.type !== "top-bar" && drop.type !== "top-tab") {
      return {
        status: "invalid",
        reason: "A group can only be sorted or added to the visible tab bar.",
      };
    }
    if (sourceGroup.id === drop.groupId) {
      return {
        status: "invalid",
        reason: "A group cannot be dropped into its own tab bar.",
      };
    }
    if (sourceGroup.members.length !== 1) {
      return {
        status: "invalid",
        reason: "Only singleton sidebar groups can join another tab bar.",
      };
    }
    return {
      status: "valid",
      operation: {
        type: "tab-layout",
        projectId: drag.projectId,
        command: {
          type: "move-member",
          tabKey: sourceGroup.members[0]!.tabKey,
          targetGroupId: drop.groupId,
          targetMemberPosition: drop.memberPosition,
        },
      },
    };
  }

  const sourceGroup = layout.groups.find(({ id }) => id === drag.groupId);
  if (!sourceGroup) {
    return { status: "invalid", reason: "The dragged tab no longer exists." };
  }
  if (drop.type === "top-tab" || drop.type === "top-bar") {
    if (drop.groupId !== sourceGroup.id) {
      return {
        status: "invalid",
        reason: "Use a singleton sidebar group to join another visible group.",
      };
    }
    const from = sourceGroup.members.findIndex(
      ({ tabKey }) => tabKey === drag.tabKey,
    );
    const to = drop.memberPosition;
    if (
      from === to ||
      (drop.type === "top-tab" && drop.tabKey === drag.tabKey)
    ) {
      return { status: "noop" };
    }
    return {
      status: "valid",
      operation: {
        type: "tab-layout",
        projectId: drag.projectId,
        command: {
          type: "reorder-members",
          groupId: sourceGroup.id,
          tabKeys: moved(
            sourceGroup.members.map(({ tabKey }) => tabKey),
            from,
            to,
          ),
        },
      },
    };
  }
  if (drop.type === "sidebar-group" && drop.groupId === sourceGroup.id) {
    return {
      status: "invalid",
      reason: "A tab cannot be split onto its own sidebar group.",
    };
  }
  const targetGroupPosition =
    drop.type === "sidebar-group"
      ? drop.groupPosition
      : drop.type === "sidebar-project"
        ? drop.groupPosition
        : null;
  if (targetGroupPosition === null) {
    return { status: "invalid", reason: "This is not a sidebar drop target." };
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
