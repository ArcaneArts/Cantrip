import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getChats: vi.fn(),
  setChatPaused: vi.fn(),
  interruptChat: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { info: vi.fn(), warn: vi.fn() },
  operationalErrorMetadata: () => ({}),
}));
import { AppLiveQueryBridge } from "@/lib/app-live-query";
import { LinkedConsoleControls } from "./linked-console-controls";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: TestRenderer.ReactTestRenderer | undefined;
let client: QueryClient;
const current = () => ({
  id: "chat-one",
  status: "running",
  automationPaused: false,
  hasPendingPlanQuestion: false,
});
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
const button = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === label)!;
const text = () => JSON.stringify(renderer!.toJSON());
async function mount(rows: ReturnType<typeof current>[] = [current()]) {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["chats", "project-one"], rows);
  api.getChats.mockResolvedValue(rows);
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(LinkedConsoleControls, {
          chatId: "chat-one",
          projectId: "project-one",
        }),
      ),
    );
  });
}
beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  client?.clear();
});

describe("linked console controls", () => {
  it("reflects canonical state changes without submitting input", async () => {
    await mount();
    expect(text()).toContain("Working");
    await act(async () => {
      client.setQueryData(
        ["chats", "project-one"],
        [{ ...current(), status: "idle", automationPaused: true }],
      );
    });
    await settle();
    expect(text()).toContain("Automatic work paused");
    expect(button("Resume automatic agent work")).toBeTruthy();
    await act(async () => {
      client.setQueryData(
        ["chats", "project-one"],
        [
          {
            ...current(),
            status: "waiting-for-approval",
            hasPendingPlanQuestion: true,
          },
        ],
      );
    });
    await settle();
    expect(text()).toContain("Waiting for an answer");
    expect(api.setChatPaused).not.toHaveBeenCalled();
    expect(api.interruptChat).not.toHaveBeenCalled();
  });

  it("refreshes terminal-only status through the app live-event bridge", async () => {
    await mount();
    const bridge = new AppLiveQueryBridge(client);
    api.getChats.mockResolvedValue([{ ...current(), status: "idle" }]);
    await act(async () => {
      bridge.handleEvent({
        type: "event",
        cursor: 1,
        action: "updated",
        entityId: "chat-one",
        revision: null,
        payload: null,
        occurredAt: "2026-09-10T00:00:00.000Z",
        resource: "chat",
        scope: { kind: "project", projectId: "project-one" },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(api.getChats).toHaveBeenCalledWith("project-one");
    expect(text()).toContain("Ready");
    expect(api.interruptChat).not.toHaveBeenCalled();
  });

  it("keeps controls scoped to each visible console", async () => {
    await mount([
      current(),
      { ...current(), id: "chat-two", automationPaused: true },
    ]);
    await act(async () => {
      renderer!.update(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            "div",
            {},
            createElement(LinkedConsoleControls, {
              chatId: "chat-one",
              projectId: "project-one",
            }),
            createElement(LinkedConsoleControls, {
              chatId: "chat-two",
              projectId: "project-one",
            }),
          ),
        ),
      );
    });
    api.setChatPaused.mockResolvedValue({ paused: false });
    api.interruptChat.mockResolvedValue({ interrupted: true });
    const bars = renderer!.root.findAllByProps({ role: "toolbar" });
    expect(bars).toHaveLength(2);
    const find = (index: number, label: string) =>
      bars[index]!.findAllByType("button").find(
        (node) => node.props["aria-label"] === label,
      )!;
    await act(async () => {
      find(1, "Resume automatic agent work").props.onClick();
    });
    await settle();
    expect(api.setChatPaused).toHaveBeenCalledWith("chat-two", false);
    await act(async () => {
      find(0, "Stop current operation").props.onClick();
    });
    await settle();
    expect(api.interruptChat).toHaveBeenCalledWith("chat-one");
  });

  it("dispatches Stop while pause is still awaiting its native boundary", async () => {
    await mount();
    let release!: () => void;
    api.setChatPaused.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    api.interruptChat.mockResolvedValue({ interrupted: true });
    await act(async () => button("Pause agent").props.onClick());
    await settle();
    expect(api.setChatPaused).toHaveBeenCalledWith("chat-one", true);
    expect(text()).toContain("Pausing at the next safe boundary");
    expect(button("Stop current operation").props.disabled).toBe(false);
    await act(async () => button("Stop current operation").props.onClick());
    await settle();
    expect(api.interruptChat).toHaveBeenCalledWith("chat-one");
    api.getChats.mockResolvedValue([
      { ...current(), status: "idle", automationPaused: true },
    ]);
    await act(async () => release());
    await settle();
    expect(text()).toContain("Automatic work paused");
    api.setChatPaused.mockResolvedValue({ paused: false });
    api.getChats.mockResolvedValue([{ ...current(), status: "idle" }]);
    await act(async () =>
      button("Resume automatic agent work").props.onClick(),
    );
    await settle();
    expect(api.setChatPaused).toHaveBeenLastCalledWith("chat-one", false);
    expect(text()).toContain("Ready");
  });

  it("attempts the actual linked-chat control even when cached status is missing and shows rejection", async () => {
    await mount([]);
    api.interruptChat.mockRejectedValue(
      new Error("The active placement changed."),
    );
    expect(button("Stop current operation").props.disabled).toBe(false);
    await act(async () => button("Stop current operation").props.onClick());
    await settle();
    expect(api.interruptChat).toHaveBeenCalledWith("chat-one");
    expect(text()).toContain("The active placement changed.");
    expect(
      renderer!.root.findAllByProps({ role: "alert" }).length,
    ).toBeGreaterThan(0);
  });
});
