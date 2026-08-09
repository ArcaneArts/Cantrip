import type { ProjectTabLayoutSummary } from "@cantrip/protocol";

import type {
  DesktopNativeDropResolution,
  DesktopNativeTabDrag,
} from "./desktop-window-coordinator";
import type { TabLayoutCommand } from "./workspace-dnd-model";

export type DesktopTabDropPlan =
  | { type: "noop" }
  | { type: "invalid"; reason: string }
  | {
      type: "dock";
      closeSourceWindow: boolean;
      command: TabLayoutCommand;
      markTargetDetached: boolean;
      targetGroupId: string;
      targetWindowLabel: string;
    }
  | {
      type: "open-existing";
      position: { x: number; y: number };
    }
  | {
      type: "split-and-open";
      command: TabLayoutCommand;
      position: { x: number; y: number };
    };

export function planDesktopTabDrop(
  drag: DesktopNativeTabDrag,
  resolution: DesktopNativeDropResolution,
  layout: ProjectTabLayoutSummary,
): DesktopTabDropPlan {
  if (resolution.kind === "cancelled" || resolution.kind === "noop") {
    return { type: "noop" };
  }
  if (resolution.kind === "invalid") {
    return { type: "invalid", reason: resolution.reason };
  }
  if (resolution.kind === "dock") {
    if (resolution.targetProjectId !== drag.projectId) {
      return { type: "invalid", reason: "Tab groups cannot span projects." };
    }
    return {
      type: "dock",
      closeSourceWindow: drag.sourceIsPopout && drag.sourceGroupSize === 1,
      command: {
        type: "move-member",
        tabKey: drag.surface.tabKey,
        targetGroupId: resolution.targetGroupId,
        targetMemberPosition: resolution.targetMemberPosition,
      },
      markTargetDetached: !drag.sourceIsPopout && drag.sourceGroupSize === 1,
      targetGroupId: resolution.targetGroupId,
      targetWindowLabel: resolution.targetWindowLabel,
    };
  }
  if (drag.sourceIsPopout && drag.sourceGroupSize === 1) {
    return { type: "noop" };
  }
  const position = { x: resolution.screenX, y: resolution.screenY };
  if (drag.sourceGroupSize === 1) {
    return { type: "open-existing", position };
  }
  return {
    type: "split-and-open",
    command: {
      type: "move-member",
      tabKey: drag.surface.tabKey,
      targetGroupId: null,
      targetGroupPosition: layout.groups.length,
      targetMemberPosition: 0,
    },
    position,
  };
}
