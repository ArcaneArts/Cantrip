export type ChatSidePanelView =
  | { type: "inspect" }
  | { type: "subagent"; agentKey: string; focusItemKey: string | null };

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
