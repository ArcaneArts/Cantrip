import type {
  ProjectPaneRegion,
  ProjectTabLayoutSummary,
} from "@cantrip/protocol";

import type { ProjectPaneVisualKind } from "@/lib/project-pane";
import type { ProjectSurface } from "@/lib/project-surface";

export type WorkspaceDragItem =
  | { type: "project"; projectId: string; label: string }
  | {
      type: "pane";
      projectId: string;
      paneId: string;
      label: string;
      region: ProjectPaneRegion;
      visualKind: ProjectPaneVisualKind;
    }
  | {
      type: "surface";
      projectId: string;
      paneId: string;
      tabKey: string;
      label: string;
      position: number;
      supportedRegions?: readonly ProjectPaneRegion[];
      visualKind: ProjectSurface["kind"];
    };

export type WorkspaceDropTarget =
  | { type: "project"; projectId: string }
  | {
      type: "pane";
      projectId: string;
      paneId: string;
      panePosition: number;
      region: ProjectPaneRegion;
    }
  | {
      type: "pane-strip";
      projectId: string;
      paneId: string;
      memberPosition: number;
    }
  | {
      type: "pane-tab";
      projectId: string;
      paneId: string;
      tabKey: string;
      memberPosition: number;
    }
  | {
      type: "pane-target";
      projectId: string;
      paneId: string;
    }
  | {
      type: "region";
      projectId: string;
      region: Extract<ProjectPaneRegion, "right" | "bottom">;
      paneId: string | null;
    };

export interface WorkspaceDndData {
  drag?: WorkspaceDragItem;
  drop?: WorkspaceDropTarget;
}

export type TabLayoutCommand =
  | { type: "reorder-panes"; paneIds: string[]; region: ProjectPaneRegion }
  | { type: "reorder-members"; paneId: string; tabKeys: string[] }
  | {
      type: "move-member";
      tabKey: string;
      targetPaneId: string | null;
      targetMemberPosition: number;
      targetPanePosition?: number;
      targetRegion?: ProjectPaneRegion;
    }
  | {
      type: "split-member";
      edge: "left" | "right" | "top" | "bottom";
      fraction?: number;
      tabKey: string;
      targetPaneId: string;
    }
  | { type: "resize-center-split"; splitId: string; fraction: number };

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

export interface WorkspaceSurfaceDropPreview {
  label: string;
  memberPosition: number;
  tabKey: string;
  visualKind: ProjectSurface["kind"];
}

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
      reason: "Panes and tabs cannot span projects.",
    };
  }

  if (drag.type === "pane") {
    if (drop.type !== "pane") {
      return { status: "invalid", reason: "This is not a pane drop target." };
    }
    if (drag.region !== drop.region) {
      return {
        status: "invalid",
        reason: "Pane movement between regions is not available yet.",
      };
    }
    const from = layout.panes.findIndex(({ id }) => id === drag.paneId);
    const to = layout.panes.findIndex(({ id }) => id === drop.paneId);
    if (from < 0 || to < 0) {
      return { status: "invalid", reason: "The pane no longer exists." };
    }
    if (from === to) return { status: "noop" };
    return {
      status: "valid",
      operation: {
        type: "tab-layout",
        projectId: drag.projectId,
        command: {
          type: "reorder-panes",
          region: drag.region,
          paneIds: moved(
            layout.panes
              .filter(({ region }) => region === drag.region)
              .map(({ id }) => id),
            layout.panes
              .filter(({ region }) => region === drag.region)
              .findIndex(({ id }) => id === drag.paneId),
            layout.panes
              .filter(({ region }) => region === drag.region)
              .findIndex(({ id }) => id === drop.paneId),
          ),
        },
      },
    };
  }

  if (drop.type === "pane") {
    return { status: "invalid", reason: "Drop the tab on the pane target." };
  }

  const sourcePane = layout.panes.find(({ id }) => id === drag.paneId);
  const targetPane =
    drop.type === "region"
      ? layout.panes.find(({ id }) => id === drop.paneId)
      : layout.panes.find(({ id }) => id === drop.paneId);
  if (!sourcePane || (drop.type !== "region" && !targetPane)) {
    return { status: "invalid", reason: "The tab's pane no longer exists." };
  }
  const sourcePosition = sourcePane.members.findIndex(
    ({ tabKey }) => tabKey === drag.tabKey,
  );
  if (sourcePosition < 0) {
    return { status: "invalid", reason: "The dragged tab no longer exists." };
  }
  const requestedPosition =
    drop.type === "region"
      ? (targetPane?.members.length ?? 0)
      : drop.type === "pane-target"
        ? targetPane!.members.length
        : drop.memberPosition;

  if (drop.type === "region") {
    if (drag.supportedRegions && !drag.supportedRegions.includes(drop.region)) {
      return {
        status: "invalid",
        reason: `${drag.label} cannot open in the ${drop.region} dock.`,
      };
    }
    if (drop.paneId && targetPane?.region !== drop.region) {
      return {
        status: "invalid",
        reason: "The dock target no longer matches its region.",
      };
    }
    if (targetPane?.id === sourcePane.id || sourcePane.region === drop.region) {
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
          targetPaneId: targetPane?.id ?? null,
          targetMemberPosition: requestedPosition,
          ...(targetPane ? {} : { targetRegion: drop.region }),
        },
      },
    };
  }

  if (sourcePane.id === targetPane!.id) {
    if (drop.type === "pane-target") return { status: "noop" };
    const targetPosition = Math.max(
      0,
      Math.min(requestedPosition, sourcePane.members.length - 1),
    );
    if (
      sourcePosition === targetPosition ||
      (drop.type === "pane-tab" && drop.tabKey === drag.tabKey)
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
          paneId: sourcePane.id,
          tabKeys: moved(
            sourcePane.members.map(({ tabKey }) => tabKey),
            sourcePosition,
            targetPosition,
          ),
        },
      },
    };
  }

  return {
    status: "valid",
    operation: {
      type: "tab-layout",
      projectId: drag.projectId,
      command: {
        type: "move-member",
        tabKey: drag.tabKey,
        targetPaneId: targetPane!.id,
        targetMemberPosition: Math.max(
          0,
          Math.min(requestedPosition, targetPane!.members.length),
        ),
      },
    },
  };
}

export function workspaceSurfaceDropPreview({
  decision,
  drag,
  drop,
  memberCount,
  paneId,
  region,
}: {
  decision: WorkspaceDropDecision | null | undefined;
  drag: WorkspaceDragItem | null | undefined;
  drop: WorkspaceDropTarget | null | undefined;
  memberCount: number;
  paneId: string | null;
  region: ProjectPaneRegion;
}): WorkspaceSurfaceDropPreview | null {
  if (
    drag?.type !== "surface" ||
    decision?.status !== "valid" ||
    !drop ||
    drag.paneId === paneId
  ) {
    return null;
  }

  let memberPosition: number;
  if (
    drop.type === "pane-tab" ||
    drop.type === "pane-strip" ||
    drop.type === "pane-target"
  ) {
    if (drop.paneId !== paneId) return null;
    memberPosition =
      drop.type === "pane-target" ? memberCount : drop.memberPosition;
  } else if (drop.type === "region") {
    if (drop.region !== region || drop.paneId !== paneId) return null;
    memberPosition = memberCount;
  } else {
    return null;
  }

  return {
    label: drag.label,
    memberPosition: Math.max(0, Math.min(memberPosition, memberCount)),
    tabKey: drag.tabKey,
    visualKind: drag.visualKind,
  };
}

export function workspaceProjectDragId(projectId: string): string {
  return `workspace:project:${projectId}`;
}

export function workspacePaneDragId(paneId: string): string {
  return `workspace:pane:${paneId}`;
}

export function workspaceSurfaceDragId(tabKey: string): string {
  return `workspace:surface:${tabKey}`;
}

export function workspacePaneStripDropId(paneId: string): string {
  return `workspace:pane-strip:${paneId}`;
}

export function workspacePaneTargetDropId(paneId: string): string {
  return `workspace:pane-target:${paneId}`;
}

export function workspaceRegionDropId(
  region: Extract<ProjectPaneRegion, "right" | "bottom">,
): string {
  return `workspace:region:${region}`;
}
