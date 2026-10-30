import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatSummarySchema } from "@cantrip/protocol";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  prepare: vi.fn(),
  checkpoint: vi.fn(),
  matches: vi.fn(),
}));
vi.mock("@/lib/api/conversations", () => ({
  getConversationCatalog: mocks.catalog,
  prepareConversationCreation: mocks.prepare,
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({ userId: "owner" }),
  clientSessionIdentityMatches: mocks.matches,
}));
vi.mock("@/components/chat/chat-transfer-lifecycle", () => ({
  checkpointChatView: mocks.checkpoint,
}));
import { ProjectConversationList } from "./project-conversation-list";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const chat = chatSummarySchema.parse({
  id: "agent",
  projectId: "project",
  experience: "agent",
  title: "Agent one",
  position: 0,
  status: "idle",
  activeWorkerId: null,
  activeWorktreeId: "tree",
  placementRevision: 1,
  worktreeMode: "agent-managed",
  modelId: null,
  reasoningEffort: null,
  permissionProfileId: null,
  planMode: "default",
  hasPendingPlanQuestion: false,
  hasUnreadCompletion: false,
  automationPaused: false,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
});
let renderer: TestRenderer.ReactTestRenderer;
let client: QueryClient;
const openConversation = vi.fn();
const onOpened = vi.fn();
const focusWindow = vi.fn();
const controller = { openConversation } as unknown as WorkspaceCommandClient;
function view(visible = true) {
  return (
    <QueryClientProvider client={client}>
      <ProjectConversationList
        projectId="project"
        visible={visible}
        controller={controller}
        selectedChatId={null}
        workers={[]}
        onOpened={onOpened}
        focusWindow={focusWindow}
      />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.matches.mockReturnValue(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["chats", "project", "conversations", "active"], {
    pages: [
      {
        state: "active",
        items: [{ ...chat, lastUsedAt: chat.createdAt }],
        total: 1,
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
  mocks.catalog.mockResolvedValue({
    state: "active",
    items: [{ ...chat, lastUsedAt: chat.createdAt }],
    total: 1,
    nextCursor: null,
  });
  openConversation.mockResolvedValue({ focusWindowId: null });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  client.clear();
});
it("opens an offline Agent directly and focuses an existing window without creating a tab", async () => {
  openConversation.mockResolvedValue({ focusWindowId: "other-window" });
  await act(async () => {
    renderer = TestRenderer.create(view());
  });
  expect(openConversation).not.toHaveBeenCalled();
  await act(async () =>
    renderer.root
      .findByProps({ "data-conversation-id": "agent" })
      .props.onClick(),
  );
  expect(openConversation).toHaveBeenCalledWith("agent", {
    checkpoint: mocks.checkpoint,
  });
  expect(focusWindow).toHaveBeenCalledWith("other-window");
  expect(onOpened).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(["chats", "project"])).toMatchObject([chat]);
});
it("reuses a prepared creation after an uncertain reply and suppresses double clicks", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValue(chat);
  mocks.prepare.mockResolvedValue(run);
  await act(async () => {
    renderer = TestRenderer.create(view());
  });
  const create = () =>
    renderer.root
      .findAllByType("button")
      .find(
        (button) => button.props["aria-label"] === "New agent conversation",
      )!
      .props.onClick();
  await act(async () => {
    create();
    create();
  });
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(1);
  await act(async () => create());
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(2);
  expect(openConversation).toHaveBeenCalledTimes(1);
});
it("does not open or focus after a pending request outlives its sidebar", async () => {
  let resolve!: (value: typeof chat) => void;
  const pending = new Promise<typeof chat>((done) => {
    resolve = done;
  });
  mocks.prepare.mockResolvedValue(() => pending);
  await act(async () => {
    renderer = TestRenderer.create(view());
  });
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find(
        (button) => button.props["aria-label"] === "New agent conversation",
      )!
      .props.onClick(),
  );
  await act(async () => renderer.unmount());
  await act(async () => resolve(chat));
  expect(openConversation).not.toHaveBeenCalled();
  expect(onOpened).not.toHaveBeenCalled();
});
it("does not query the catalog while its page is hidden", async () => {
  await act(async () => {
    renderer = TestRenderer.create(view(false));
  });
  expect(mocks.catalog).not.toHaveBeenCalled();
});
