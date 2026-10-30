import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
const api = vi.hoisted(() => ({
  archive: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  checkpoint: vi.fn(),
  matches: vi.fn(),
  forget: vi.fn(),
}));
vi.mock("@/lib/api/conversations", () => ({
  archiveAgentConversation: api.archive,
  restoreAgentConversation: api.restore,
  permanentlyDeleteAgentConversation: api.remove,
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({ userId: "owner" }),
  clientSessionIdentityMatches: api.matches,
}));
vi.mock("@/components/chat/chat-transfer-lifecycle", () => ({
  checkpointChatView: api.checkpoint,
}));
vi.mock("@/lib/chat-composer-draft-persistence", () => ({
  forgetChatComposerDraftPersistence: api.forget,
}));
import { useConversationLifecycle } from "./use-conversation-lifecycle";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let state: ReturnType<typeof useConversationLifecycle>;
let root: TestRenderer.ReactTestRenderer;
let queryClient: QueryClient;
const release = vi.fn();
const refresh = vi.fn();
const controller = {
  getSnapshot: () => ({
    projected: {
      windows: [
        {
          panes: [
            {
              tabs: [],
              conversationView: {
                id: "view",
                resource: {
                  kind: "entity",
                  definitionId: "project.agent",
                  resourceId: "chat",
                },
              },
            },
          ],
        },
      ],
    },
  }),
  refresh,
} as unknown as WorkspaceCommandClient;
function Harness() {
  state = useConversationLifecycle("project", controller);
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks();
  api.matches.mockReturnValue(true);
  api.checkpoint.mockResolvedValue(release);
  refresh.mockResolvedValue(undefined);
  api.archive.mockResolvedValue(undefined);
  api.restore.mockResolvedValue(undefined);
  api.remove.mockResolvedValue(undefined);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
});
it("checkpoints the direct view before archival and retains its draft cache", async () => {
  queryClient.setQueryData(["chat-composer-draft", "chat"], { text: "unsent" });
  await act(async () => {
    expect(await state.archive("chat")).toBe(true);
  });
  expect(api.checkpoint).toHaveBeenCalledExactlyOnceWith({
    tabId: "view",
    chatId: "chat",
    projectId: "project",
  });
  expect(api.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(
    api.archive.mock.invocationCallOrder[0]!,
  );
  expect(release).toHaveBeenCalledTimes(1);
  expect(queryClient.getQueryData(["chat-composer-draft", "chat"])).toEqual({
    text: "unsent",
  });
  expect(api.forget).not.toHaveBeenCalled();
});
it("keeps the conversation active when its protected draft cannot checkpoint", async () => {
  api.checkpoint.mockRejectedValue(new Error("Draft save failed"));
  await act(async () => {
    expect(await state.archive("chat")).toBe(false);
  });
  expect(api.archive).not.toHaveBeenCalled();
  expect(state.errors.get("chat")).toEqual(new Error("Draft save failed"));
  expect(state.pending.size).toBe(0);
});
it("restores without opening or checkpointing a view", async () => {
  await act(async () => {
    expect(await state.restore("chat")).toBe(true);
  });
  expect(api.restore).toHaveBeenCalledWith("project", "chat", {
    userId: "owner",
  });
  expect(api.checkpoint).not.toHaveBeenCalled();
  expect(state.completed).toMatchObject({ chatId: "chat", action: "restore" });
});
it("forgets private cached drafts only after confirmed permanent deletion", async () => {
  queryClient.setQueryData(["chat-composer-draft", "chat"], { text: "unsent" });
  api.remove.mockRejectedValueOnce(new Error("Already restored"));
  await act(async () => {
    expect(await state.remove("chat")).toBe(false);
  });
  expect(api.forget).not.toHaveBeenCalled();
  expect(
    queryClient.getQueryData(["chat-composer-draft", "chat"]),
  ).toBeDefined();
  await act(async () => {
    expect(await state.remove("chat")).toBe(true);
  });
  expect(api.forget).toHaveBeenCalledWith(queryClient, "chat");
  expect(
    queryClient.getQueryData(["chat-composer-draft", "chat"]),
  ).toBeUndefined();
});
it("does not archive after the session changes during checkpointing", async () => {
  api.checkpoint.mockImplementationOnce(async () => {
    api.matches.mockReturnValue(false);
    return release;
  });
  await act(async () => {
    expect(await state.archive("chat", true)).toBe(false);
  });
  expect(api.archive).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it("reconciles a lost mutation response without claiming success or discarding drafts", async () => {
  queryClient.setQueryData(["chats", "project"], []);
  queryClient.setQueryData(["archived-chats", "project"], []);
  queryClient.setQueryData(["chat-composer-draft", "chat"], {
    text: "recover me",
  });
  api.remove.mockRejectedValueOnce(new Error("Response lost"));
  await act(async () => {
    expect(await state.remove("chat")).toBe(false);
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(queryClient.getQueryState(["chats", "project"])?.isInvalidated).toBe(
    true,
  );
  expect(
    queryClient.getQueryState(["archived-chats", "project"])?.isInvalidated,
  ).toBe(true);
  expect(state.completed).toBeNull();
  expect(state.errors.get("chat")).toEqual(new Error("Response lost"));
  expect(api.forget).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(["chat-composer-draft", "chat"])).toEqual({
    text: "recover me",
  });
});
it("allows another conversation's mutation while rejecting duplicate pending actions", async () => {
  let finish!: () => void;
  api.remove.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let first!: Promise<boolean>;
  await act(async () => {
    first = state.remove("chat");
  });
  expect(state.pending.has("chat")).toBe(true);
  await act(async () => {
    expect(await state.remove("chat")).toBe(false);
    expect(await state.restore("other-chat")).toBe(true);
  });
  expect(api.remove).toHaveBeenCalledOnce();
  expect(state.pending.has("chat")).toBe(true);
  await act(async () => {
    finish();
    expect(await first).toBe(true);
  });
  expect(state.pending.size).toBe(0);
});
it("retains the committed result when workspace refresh fails", async () => {
  refresh.mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () => {
    expect(await state.restore("chat")).toBe(true);
  });
  expect(state.completed).toMatchObject({ chatId: "chat", action: "restore" });
  expect(state.errors.size).toBe(0);
});
