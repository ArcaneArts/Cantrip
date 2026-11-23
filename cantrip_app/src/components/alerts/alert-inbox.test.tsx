// @vitest-environment jsdom
import { getAlertInteraction } from "@/lib/project-alert-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChatSummary,
  ProjectAlert,
  AgentInteractionRequest,
} from "@cantrip/protocol";
import { AlertInbox } from "./alert-inbox";
import { AlertSource } from "./alert-source";
import { respondToAgentInteractionRequest } from "@/lib/api";
vi.mock("@/lib/project-alert-api", () => ({
  getProjectAlerts: vi.fn(),
  getAlertInteraction: vi.fn(),
  getAgentAlertDetail: vi.fn(),
  getAlertGoal: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  respondToAgentInteractionRequest: vi.fn(),
  getTask: vi.fn(),
}));
vi.mock("@/lib/alert-navigation", () => ({ requestAlertNavigation: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const alert = {
  id: "alert",
  projectId: "project",
  chatId: "chat",
  source: "interaction",
  sourceId: "request",
  episodeId: "request",
  sourceRevision: 1,
  kind: "permission",
  priority: 0,
  status: "open",
  target: { kind: "interaction", chatId: "chat", requestId: "request" },
  protectedDetail: null,
  createdAt: "2026-11-02T12:00:00.000Z",
  updatedAt: "2026-11-02T12:00:00.000Z",
  resolvedAt: null,
} as ProjectAlert;
const chat = {
  id: "chat",
  projectId: "project",
  title: "Build agent",
  experience: "agent",
} as ChatSummary;
let renderer: ReactTestRenderer | undefined, client: QueryClient | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  client?.clear();
  vi.clearAllMocks();
});
async function render(
  component: React.ReactNode,
  data: Array<[unknown[], unknown]>,
) {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  for (const [key, value] of data) client.setQueryData(key, value);
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client!}>{component}</QueryClientProvider>,
    );
  });
  return renderer!;
}
it("keeps an open Inbox cleanly empty without opening a source or taking an action", async () => {
  const open = vi.fn();
  const ui = await render(
    <AlertInbox
      projectId="project"
      chats={[chat]}
      workers={[]}
      onRename={() => {}}
      onOpenChat={open}
    />,
    [[["project-alerts", "project", null], { items: [], nextCursor: null }]],
  );
  expect(JSON.stringify(ui.toJSON())).toContain("No active alerts");
  expect(open).not.toHaveBeenCalled();
  expect(respondToAgentInteractionRequest).not.toHaveBeenCalled();
});
it("shows attribution and request context only when expanded; opening never approves", async () => {
  const open = vi.fn();
  const request = {
    id: "request",
    status: "pending",
    requestKey: "key",
    provenance: { chatId: "chat", workerId: "worker" },
    payload: {
      kind: "commandExecution",
      reason: "Need to run tests",
      command: "pnpm test",
      availableDecisions: ["accept", "decline"],
    },
  } as AgentInteractionRequest;
  const ui = await render(
    <AlertInbox
      projectId="project"
      chats={[chat]}
      workers={[]}
      onRename={() => {}}
      onOpenChat={open}
    />,
    [
      [
        ["project-alerts", "project", null],
        { items: [alert], nextCursor: null },
      ],
      [["alert-interaction", "request"], request],
    ],
  );
  expect(JSON.stringify(ui.toJSON())).toContain("System");
  await act(async () =>
    ui.root.findByProps({ "aria-expanded": false }).props.onClick(),
  );
  expect(JSON.stringify(ui.toJSON())).toContain("pnpm test");
  expect(open).not.toHaveBeenCalled();
  expect(respondToAgentInteractionRequest).not.toHaveBeenCalled();
});
it("leaves a failed response actionable and retries with the same source idempotency key", async () => {
  vi.mocked(respondToAgentInteractionRequest).mockRejectedValue(
    new Error("Worker unavailable"),
  );
  const request = {
    id: "request",
    status: "pending",
    requestKey: "key",
    provenance: { chatId: "chat", workerId: "worker" },
    payload: {
      kind: "commandExecution",
      reason: "Need to run tests",
      command: "pnpm test",
      availableDecisions: ["accept", "decline"],
    },
  } as AgentInteractionRequest;
  vi.mocked(getAlertInteraction).mockResolvedValue(request);
  const ui = await render(
    <AlertSource
      alert={alert}
      chat={chat}
      workers={[]}
      onRename={() => {}}
      onOpenChat={vi.fn()}
    />,
    [[["alert-interaction", "request"], request]],
  );
  const approve = () =>
    ui.root
      .findAllByType("button")
      .find((b) => b.children.includes("Allow once"))!;
  await act(async () => {
    approve().props.onClick();
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(JSON.stringify(ui.toJSON())).toContain("Worker unavailable");
  expect(approve()).toBeTruthy();
  await act(async () => {
    approve().props.onClick();
    await new Promise((r) => setTimeout(r, 20));
  });
  const calls = vi.mocked(respondToAgentInteractionRequest).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]![0]).toBe("request");
  expect(calls[0]![1].idempotencyKey).toBe(calls[1]![1].idempotencyKey);
});

it.each([
  [
    "usageLimited",
    "Goal waiting for model usage",
    "The model reported a usage limit.",
  ],
  [
    "budgetLimited",
    "Goal budget reached",
    "The Goal reached its configured budget.",
  ],
  ["blocked", "Goal blocked", "The agent reported a blocker."],
])(
  "explains authoritative Goal attention %s without starting execution",
  async (status, title, reason) => {
    const open = vi.fn();
    const goalAlert = {
      ...alert,
      source: "goal",
      target: { kind: "goal", chatId: "chat", threadId: "thread" },
    } as ProjectAlert;
    const ui = await render(
      <AlertSource
        alert={goalAlert}
        chat={chat}
        workers={[]}
        onRename={() => {}}
        onOpenChat={open}
      />,
      [
        [
          ["alert-goal", "alert", 1],
          { status, objective: "Protected objective" },
        ],
      ],
    );
    const markup = JSON.stringify(ui.toJSON());
    expect(markup).toContain(title);
    expect(markup).toContain(reason);
    expect(open).not.toHaveBeenCalled();
    expect(respondToAgentInteractionRequest).not.toHaveBeenCalled();
  },
);
