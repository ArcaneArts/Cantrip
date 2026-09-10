import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  request: vi.fn(),
  identity: { userId: "owner", serverId: "server", generation: 1 },
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/api-client", () => ({ request: api.request }));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => api.identity,
  onClientSessionIdentityChanged: (listener: () => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: Record<string, unknown>) =>
    createElement("button", props, children as never),
}));
import { ManagedChatPreparationStatus } from "./managed-chat-preparation-status";
const receipt = (phase: string, failedPhase: string | null = null) => ({
  chatId: "chat",
  workerId: "worker",
  terminalId: "4e143baa-88c8-43bb-a960-0e5f94df6a36",
  generation: "4e143baa-88c8-43bb-a960-0e5f94df6a36",
  phase,
  failedPhase,
  updatedAt: "2026-09-10T00:00:00Z",
});
let renderer: TestRenderer.ReactTestRenderer;
let client: QueryClient;
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.identity = { userId: "owner", serverId: "server", generation: 1 };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  client.clear();
});
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ManagedChatPreparationStatus, {
          chatId: "chat",
          projectId: "project",
        }),
      ),
    );
  });
  await flush();
}
it.each([null, "thread", "console", "ready"])(
  "observes %s without preparing again or opening a view",
  async (phase) => {
    api.request.mockResolvedValue({
      preparation: phase ? receipt(phase) : null,
    });
    await mount();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request.mock.calls[0]![0]).toBe("/api/chats/chat/preparation");
    expect(api.request.mock.calls[0]![1].method).toBeUndefined();
    const tree = JSON.stringify(renderer.toJSON());
    if (phase === null) expect(renderer.toJSON()).toBeNull();
    else
      expect(tree).toContain(
        {
          thread: "Preparing agent session",
          console: "Starting attached CLI",
          ready: "Session prepared",
        }[phase],
      );
  },
);
it("distinguishes CLI failure and retries only when requested", async () => {
  api.request.mockResolvedValue({ preparation: receipt("failed", "console") });
  await mount();
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "Session prepared, but the CLI could not start",
  );
  const button = renderer.root.findByType("button");
  api.request.mockImplementation(async (_path, options) => ({
    preparation: receipt(options.method === "POST" ? "pending" : "ready"),
  }));
  await act(async () => button.props.onClick());
  await flush();
  expect(
    api.request.mock.calls.filter((call) => call[1].method === "POST"),
  ).toHaveLength(1);
  expect(JSON.stringify(renderer.toJSON())).toContain("Session prepared");
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
});
it("discards an old account's retry result after identity changes", async () => {
  let reject!: (error: Error) => void;
  api.request.mockResolvedValue({ preparation: receipt("failed", "thread") });
  await mount();
  api.request.mockImplementation(async (_path, options) =>
    options.method === "POST"
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : { preparation: null },
  );
  let retry: Promise<void>;
  await act(async () => {
    retry = renderer.root.findByType("button").props.onClick();
  });
  await act(async () => {
    api.identity = { ...api.identity, userId: "another-owner", generation: 2 };
    api.listeners.forEach((listener) => listener());
  });
  await flush();
  await act(async () => {
    reject(new Error("Old request failed"));
    await retry!;
  });
  expect(renderer.toJSON()).toBeNull();
});
