import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AGENT_INSPECT_WIDTH_STORAGE_KEY,
  AgentInspectPanel,
  AgentInspectPanelShell,
  DEFAULT_AGENT_INSPECT_WIDTH,
  MAX_AGENT_INSPECT_WIDTH,
  MIN_AGENT_INSPECT_WIDTH,
  agentInspectWidthFromKey,
  agentInspectWidthFromPointer,
  clampAgentInspectWidth,
  persistAgentInspectWidth,
  readAgentInspectWidth,
  updateAgentInspectOpenChats,
} from "./agent-inspect-panel";

describe("AgentInspectPanel", () => {
  it("renders the exact inactive presentation", () => {
    const markup = renderToStaticMarkup(
      <AgentInspectPanel active={false} onClose={vi.fn()} />,
    );
    expect(markup).toContain("Inactive");
    expect(markup).toContain("Shows activity when agent is working");
    expect(markup).toContain('aria-label="Close Inspect"');
  });

  it("reserves the active body for live inspection content", () => {
    const markup = renderToStaticMarkup(
      <AgentInspectPanel active onClose={vi.fn()}>
        <p>Live activity</p>
      </AgentInspectPanel>,
    );
    expect(markup).toContain("Live activity");
    expect(markup).not.toContain("Shows activity when agent is working");
  });

  it("marks the desktop shell for accessible resizing and reduced motion", () => {
    const markup = renderToStaticMarkup(
      <AgentInspectPanelShell
        active={false}
        onOpenChange={vi.fn()}
        open
        overlay={false}
      />,
    );
    expect(markup).toContain('data-state="open"');
    expect(markup).toContain('aria-label="Resize Inspect sidebar"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).toContain("group-focus-within/agent-inspect");
  });
});

describe("agent inspector shell state", () => {
  it("keeps open state independently per chat through chat and console switches", () => {
    const first = updateAgentInspectOpenChats(new Set(), "chat-one", true);
    const second = updateAgentInspectOpenChats(first, "chat-two", true);
    const afterConsoleRoundTrip = new Set(second);
    const third = updateAgentInspectOpenChats(second, "chat-one", false);
    expect([...second]).toEqual(["chat-one", "chat-two"]);
    expect([...afterConsoleRoundTrip]).toEqual(["chat-one", "chat-two"]);
    expect([...third]).toEqual(["chat-two"]);
    expect(
      updateAgentInspectOpenChats(third, "new-chat", false).has("new-chat"),
    ).toBe(false);
  });

  it("starts every newly created app-window session with chats collapsed", () => {
    const firstWindow = updateAgentInspectOpenChats(
      new Set(),
      "shared-chat",
      true,
    );
    const secondWindow = new Set<string>();
    expect(firstWindow.has("shared-chat")).toBe(true);
    expect(secondWindow.has("shared-chat")).toBe(false);
  });

  it("clamps pointer and keyboard resizing from the left edge", () => {
    expect(agentInspectWidthFromPointer(600, 1_000)).toBe(400);
    expect(agentInspectWidthFromPointer(950, 1_000)).toBe(
      MIN_AGENT_INSPECT_WIDTH,
    );
    expect(agentInspectWidthFromPointer(0, 1_000)).toBe(
      MAX_AGENT_INSPECT_WIDTH,
    );
    expect(agentInspectWidthFromKey(400, "ArrowLeft")).toBe(416);
    expect(agentInspectWidthFromKey(400, "ArrowRight")).toBe(384);
    expect(agentInspectWidthFromKey(400, "Home")).toBe(MIN_AGENT_INSPECT_WIDTH);
    expect(agentInspectWidthFromKey(400, "End")).toBe(MAX_AGENT_INSPECT_WIDTH);
    expect(agentInspectWidthFromKey(400, "Enter")).toBeNull();
    expect(clampAgentInspectWidth(Number.NaN)).toBe(
      DEFAULT_AGENT_INSPECT_WIDTH,
    );
  });

  it("persists and restores the preferred width safely", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(readAgentInspectWidth(storage)).toBe(DEFAULT_AGENT_INSPECT_WIDTH);
    persistAgentInspectWidth(444, storage);
    expect(values.get(AGENT_INSPECT_WIDTH_STORAGE_KEY)).toBe("444");
    expect(readAgentInspectWidth(storage)).toBe(444);
    values.set(AGENT_INSPECT_WIDTH_STORAGE_KEY, "9999");
    expect(readAgentInspectWidth(storage)).toBe(MAX_AGENT_INSPECT_WIDTH);
  });
});
