// @vitest-environment jsdom
import type { ChatSummary, WorkerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectSurfacePlacementContext } from "@/components/workspace/project-surface-create-menu";
import { PanelToolbar } from "@/components/workspace/panel-toolbar";
import { AgentPanelActions } from "./agent-panel-actions";

vi.mock("@/lib/api", () => ({ getChatRelocations: vi.fn(async () => []) }));
vi.mock("@/lib/app-live-react", () => ({
  useAppLiveScope: vi.fn(),
  useAppLiveStatus: () => "live",
}));
vi.mock("./customization-panel", () => ({
  CustomizationPanel: (props: { chatId: string; open: boolean }) =>
    props.open ? <span data-customizations-for={props.chatId} /> : null,
}));
vi.mock("./chat-relocation-dialog", () => ({
  activeChatRelocationJob: () => null,
  latestChatRelocationJob: () => null,
  isChatRelocationActive: () => false,
  ChatRelocationDialog: (props: { chat: ChatSummary; open: boolean }) =>
    props.open ? <span data-relocation-for={props.chat.id} /> : null,
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const toggleConsole = vi.fn();
const toggleInspect = vi.fn();
function panels(focused = "one") {
  return (
    <QueryClientProvider client={client}>
      <main data-focused={focused}>
        {["one", "two"].map((id) => (
          <PanelToolbar aria-label={`Agent ${id}`} key={id}>
            <AgentPanelActions
              chat={{ id, title: id } as ChatSummary}
              consoleActive={id === "one"}
              consolePending={false}
              inspectActive={false}
              onToggleConsole={() => toggleConsole(id)}
              onToggleInspect={() => toggleInspect(id)}
              relocation={{
                available: true,
                placement: {
                  projectId: "project-one",
                  replicas: [],
                  workers: [
                    { workerId: "one" } as WorkerSummary,
                    { workerId: "two" } as WorkerSummary,
                  ],
                  worktrees: [],
                } satisfies ProjectSurfacePlacementContext,
                statuses: {},
                synchronizationPolicy: "off",
              }}
            />
          </PanelToolbar>
        ))}
      </main>
    </QueryClientProvider>
  );
}
function button(panel: string, label: string) {
  return container.querySelector<HTMLButtonElement>(
    `[aria-label="Agent ${panel}"] button[aria-label="${label}"]`,
  )!;
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(panels()));
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("Agent panel controls", () => {
  it("keeps both panels' controls available and routes actions to their own chat", async () => {
    expect(button("one", "Show agent")).not.toBeNull();
    expect(button("two", "Show Codex console")).not.toBeNull();
    await act(async () => button("two", "Show Codex console").click());
    await act(async () => button("one", "Open agent Inspect").click());
    expect(toggleConsole).toHaveBeenCalledExactlyOnceWith("two");
    expect(toggleInspect).toHaveBeenCalledExactlyOnceWith("one");
  });

  it("opens customization and relocation for the unfocused panel and preserves them across focus changes", async () => {
    await act(async () =>
      button("two", "Inspect Codex customizations").click(),
    );
    await act(async () =>
      button("two", "Move agent to another worker").click(),
    );
    expect(
      container.querySelector('[data-customizations-for="two"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-relocation-for="two"]'),
    ).not.toBeNull();
    await act(async () => root.render(panels("two")));
    expect(
      container.querySelector('[data-customizations-for="two"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-relocation-for="two"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-customizations-for="one"]'),
    ).toBeNull();
    expect(container.querySelector('[data-relocation-for="one"]')).toBeNull();
  });
});
