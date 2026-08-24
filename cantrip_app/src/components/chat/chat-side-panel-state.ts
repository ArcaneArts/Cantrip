export type ChatSidePanelView =
  | { type: "inspect" }
  | { type: "subagent"; agentKey: string; focusItemKey: string | null }
  | { type: "subagent-root"; rootTurnId: string };

export const DEFAULT_CHAT_SIDE_PANEL_VIEW: ChatSidePanelView = {
  type: "inspect",
};

export function inspectSidePanelView(): ChatSidePanelView {
  return DEFAULT_CHAT_SIDE_PANEL_VIEW;
}

export function subagentSidePanelView(
  agentKey: string,
  focusItemKey: string | null = null,
): ChatSidePanelView {
  return { type: "subagent", agentKey, focusItemKey };
}

export function subagentRootSidePanelView(
  rootTurnId: string,
): ChatSidePanelView {
  return { type: "subagent-root", rootTurnId };
}
