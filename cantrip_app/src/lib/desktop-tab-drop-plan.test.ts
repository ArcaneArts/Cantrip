import type { ProjectTabLayoutSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { planDesktopTabDrop } from "./desktop-tab-drop-plan";
import type { DesktopNativeTabDrag } from "./desktop-window-coordinator";

const layout = {
  projectId: "project-1",
  revision: 8,
  groups: [{ id: "group-source" }, { id: "group-target" }],
} as ProjectTabLayoutSummary;

function drag(
  sourceGroupSize: number,
  sourceIsPopout: boolean,
): DesktopNativeTabDrag {
  return {
    groupId: "group-source",
    projectId: "project-1",
    sourceGroupSize,
    sourceIsPopout,
    surface: { kind: "chat", tabKey: "chat:one", title: "Chat" },
  };
}

describe("desktop cross-window tab drop planning", () => {
  it("docks with the atomic membership command and closes only an empty popout", () => {
    const resolution = {
      kind: "dock" as const,
      targetGroupId: "group-target",
      targetMemberPosition: 1,
      targetProjectId: "project-1",
      targetWindowLabel: "target-window",
    };
    expect(planDesktopTabDrop(drag(1, true), resolution, layout)).toMatchObject(
      {
        type: "dock",
        closeSourceWindow: true,
        markTargetDetached: false,
        command: {
          type: "move-member",
          tabKey: "chat:one",
          targetGroupId: "group-target",
          targetMemberPosition: 1,
        },
      },
    );
    expect(planDesktopTabDrop(drag(2, true), resolution, layout)).toMatchObject(
      {
        type: "dock",
        closeSourceWindow: false,
      },
    );
  });

  it("splits a grouped tab but reuses a singleton group", () => {
    const resolution = { kind: "detach" as const, screenX: -400, screenY: 90 };
    expect(
      planDesktopTabDrop(drag(2, false), resolution, layout),
    ).toMatchObject({
      type: "split-and-open",
      command: {
        type: "move-member",
        targetGroupId: null,
        targetGroupPosition: 2,
      },
      position: { x: -400, y: 90 },
    });
    expect(planDesktopTabDrop(drag(1, false), resolution, layout)).toEqual({
      type: "open-existing",
      position: { x: -400, y: 90 },
    });
  });

  it("leaves a moved singleton popout intact and rejects cross-project docking", () => {
    expect(
      planDesktopTabDrop(
        drag(1, true),
        { kind: "detach", screenX: 20, screenY: 30 },
        layout,
      ),
    ).toEqual({ type: "noop" });
    expect(
      planDesktopTabDrop(
        drag(1, false),
        {
          kind: "dock",
          targetGroupId: "elsewhere",
          targetMemberPosition: 0,
          targetProjectId: "project-2",
          targetWindowLabel: "other",
        },
        layout,
      ),
    ).toEqual({ type: "invalid", reason: "Tab groups cannot span projects." });
  });
});
