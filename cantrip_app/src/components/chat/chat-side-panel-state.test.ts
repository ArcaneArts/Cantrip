import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHAT_SIDE_PANEL_VIEW,
  inspectSidePanelView,
  subagentRootSidePanelView,
  subagentSidePanelView,
} from "./chat-side-panel-state";

describe("chat side panel state", () => {
  it("replaces inspect with a focused subagent and can return to inspect", () => {
    expect(subagentSidePanelView("turn:child", "activity:1")).toEqual({
      type: "subagent",
      agentKey: "turn:child",
      focusItemKey: "activity:1",
    });
    expect(inspectSidePanelView()).toBe(DEFAULT_CHAT_SIDE_PANEL_VIEW);
  });

  it("opens the root overview for a subagent turn", () => {
    expect(subagentRootSidePanelView("turn")).toEqual({
      type: "subagent-root",
      rootTurnId: "turn",
    });
  });
});
