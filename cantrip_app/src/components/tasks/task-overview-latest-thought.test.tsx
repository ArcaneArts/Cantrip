// @vitest-environment jsdom
import type { ChatMessage, ChatSummary, TaskDetail } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const history = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  read: vi.fn(),
}));
vi.mock("@/lib/use-chat-message-history", () => ({
  useChatMessageHistory: (options: unknown) => {
    history.read(options);
    return { data: history.messages, hasOlder: false, refetch: vi.fn() };
  },
}));
vi.mock("@/lib/app-live-react", () => ({ useAppLiveStatus: () => "live" }));
import { TaskImplementationDashboard } from "./task-implementation-dashboard";

const chat = {
  id: "task",
  projectId: "project",
  status: "running",
  automationPaused: false,
} as ChatSummary;
const task = {
  state: "implementing",
  planGoalEnabled: true,
  finalPlanMarkdown: "The saved goal plan",
  briefMarkdown: "The saved task prompt",
  implementationStartedAt: "2026-10-31T12:00:00Z",
  createdAt: "2026-10-31T12:00:00Z",
  updatedAt: "2026-10-31T12:00:00Z",
  dispatch: { state: "running" },
} as TaskDetail;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  history.messages = [];
  history.read.mockClear();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["task-dashboard", chat.id], {
    task,
    goal: { status: "active", timeUsedSeconds: 0, tokensUsed: 0 },
    warnings: [],
    pullRequests: [],
  });
  client.setQueryData(["agent-requests", chat.id, "pending"], []);
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});
function message(
  sequence: number,
  content: ChatMessage["content"],
): ChatMessage {
  return {
    id: `message-${sequence}`,
    chatId: chat.id,
    sequence,
    role: "assistant",
    createdAt: `2026-10-31T12:00:0${sequence}Z`,
    content,
  } as ChatMessage;
}
function view(visible = true, currentChat = chat) {
  return (
    <QueryClientProvider client={client}>
      <TaskImplementationDashboard
        chat={currentChat}
        initialTask={task}
        visible={visible}
      />
    </QueryClientProvider>
  );
}

it("places the same latest thought shown by State immediately before Goal plan", () => {
  history.messages = [
    message(1, [
      { type: "text", phase: "commentary", text: "An older thought" },
    ]),
    message(2, [
      {
        type: "text",
        phase: "commentary",
        text: "Reviewing the next implementation step.\nChecking the current changes.",
      },
    ]),
  ];
  const markup = renderToStaticMarkup(view());
  expect(markup).toContain("Latest thought");
  expect(markup).toContain("Reviewing the next implementation step.");
  expect(markup).not.toContain("An older thought");
  expect(markup.indexOf("Latest thought")).toBeLessThan(
    markup.indexOf('id="task-plan-heading"'),
  );
  expect(markup).not.toContain('data-slot="agent-inspect-content"');
  expect(history.read).toHaveBeenCalledOnce();
  expect(history.read).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: chat.id,
      enabled: true,
      refetchInterval: false,
    }),
  );
});

it("uses the latest reasoning summary without adding command or file state", () => {
  history.messages = [
    message(1, [
      { type: "text", phase: "commentary", text: "Previous commentary" },
    ]),
    message(2, [
      {
        type: "activity",
        activity: {
          type: "reasoning",
          id: "reason",
          summary: ["Reviewing the final query boundary."],
          status: "running",
          updatedAtMs: Date.parse("2026-10-31T12:00:02Z"),
        } as never,
      },
    ]),
  ];
  const markup = renderToStaticMarkup(view());
  expect(markup).toContain("Reviewing the final query boundary.");
  expect(markup).not.toContain("Previous commentary");
  expect(markup).not.toContain("Editing now");
});

it("shows the last three nonempty lines and escapes thought content", () => {
  history.messages = [
    message(1, [
      {
        type: "text",
        phase: "commentary",
        text: "Old line\n\nKeep one\nKeep two\n<script>Keep three</script>",
      },
    ]),
  ];
  const markup = renderToStaticMarkup(view());
  expect(markup).not.toContain("Old line");
  expect(markup).toContain("Keep one");
  expect(markup).toContain("&lt;script&gt;Keep three&lt;/script&gt;");
  expect(markup).toContain("line-clamp-3");
});

it("omits the section when hidden, inactive, or without a current thought", () => {
  expect(renderToStaticMarkup(view())).not.toContain("Latest thought");
  history.messages = [
    message(1, [{ type: "text", phase: "commentary", text: "A live thought" }]),
  ];
  expect(renderToStaticMarkup(view(false))).not.toContain("Latest thought");
  expect(
    renderToStaticMarkup(view(true, { ...chat, status: "idle" })),
  ).not.toContain("Latest thought");
  history.messages.push(
    message(2, [{ type: "text", phase: "final_answer", text: "Done" }]),
  );
  expect(renderToStaticMarkup(view())).not.toContain("Latest thought");
});

it("updates the thought in place when existing message history changes", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  history.messages = [
    message(1, [
      { type: "text", phase: "commentary", text: "First live thought" },
    ]),
  ];
  await act(async () => {
    renderer = TestRenderer.create(view());
  });
  try {
    expect(JSON.stringify(renderer.toJSON())).toContain("First live thought");
    history.messages = [
      ...history.messages,
      message(2, [
        { type: "text", phase: "commentary", text: "Updated live thought" },
      ]),
    ];
    await act(async () => renderer.update(view()));
    expect(JSON.stringify(renderer.toJSON())).toContain("Updated live thought");
    expect(JSON.stringify(renderer.toJSON())).not.toContain(
      "First live thought",
    );
  } finally {
    await act(async () => renderer.unmount());
  }
});
