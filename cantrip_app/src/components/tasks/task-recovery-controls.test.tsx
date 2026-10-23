// @vitest-environment jsdom
import type { ChatSummary, TaskDetail } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { TaskImplementationDashboard } from "./task-implementation-dashboard";

vi.mock("@/lib/use-chat-message-history", () => ({
  useChatMessageHistory: () => ({ messages: [], refetch: vi.fn() }),
}));
vi.mock("./task-overview-summary", () => ({ TaskOverviewSummary: () => null }));
vi.mock("./task-interaction-requests", () => ({
  TaskInteractionRequests: () => null,
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Task recovery controls", () => {
  afterEach(() => vi.restoreAllMocks());
  it("uses recovery behind Resume when a paused Goal Task has lost its Goal attachment", async () => {
    const task = {
      state: "paused",
      planGoalEnabled: true,
      implementationStartedAt: "2026-10-22T00:00:00Z",
      dispatch: { state: "running" },
    } as TaskDetail;
    const chat = {
      id: "paused-chat",
      projectId: "project",
      status: "idle",
      automationPaused: true,
    } as ChatSummary;
    const recover = vi
      .spyOn(api, "recoverTaskImplementation")
      .mockResolvedValue(task);
    const pause = vi.spyOn(api, "setChatPaused");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <TaskImplementationDashboard
            chat={chat}
            initialTask={task}
            visible={false}
          />
        </QueryClientProvider>,
      );
    });
    try {
      const buttons = renderer.root.findAllByType("button");
      expect(buttons.some((node) => node.children.includes("Retry"))).toBe(
        false,
      );
      const resume = buttons.find((node) => node.children.includes("Resume"))!;
      expect(resume).toBeDefined();
      await act(async () => {
        resume.props.onClick();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await vi.waitFor(() =>
        expect(recover).toHaveBeenCalledExactlyOnceWith(chat.id),
      );
      expect(pause).not.toHaveBeenCalled();
    } finally {
      await act(async () => renderer.unmount());
      client.clear();
    }
  });
  it("offers Retry without a Goal or thread, disables it while recovering and shows actionable failures", async () => {
    const task = {
      state: "failed",
      planGoalEnabled: true,
      implementationStartedAt: "2026-10-22T00:00:00Z",
      dispatch: { state: "expired" },
    } as TaskDetail;
    const chat = {
      id: "chat",
      projectId: "project",
      status: "failed",
      automationPaused: false,
    } as ChatSummary;
    let reject!: (reason: Error) => void;
    const call = vi.spyOn(api, "recoverTaskImplementation").mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <TaskImplementationDashboard
            chat={chat}
            initialTask={task}
            visible={false}
          />
        </QueryClientProvider>,
      );
    });
    const button = () =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("Retry"))!;
    expect(button()).toBeDefined();
    await act(async () => {
      button().props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledExactlyOnceWith("chat"),
    );
    expect(button().props.disabled).toBe(true);
    await act(async () => {
      reject(
        new Error("The worker is offline. Reconnect it, then retry recovery."),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Reconnect it, then retry recovery",
    );
    expect(button().props.disabled).toBe(false);
    await act(async () => renderer.unmount());
    client.clear();
  });
});
