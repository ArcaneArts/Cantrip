import type { ChatMessage } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";

import {
  chatMessageLiveQueryKey,
  chatMessagePagesQueryKey,
  chatMessageProvisionalQueryKey,
  upsertChatMessageLiveOverlay,
  type ChatMessagePage,
} from "./chat-message-history";
import { useChatMessageHistory } from "./use-chat-message-history";

const { getMessagePage } = vi.hoisted(() => ({ getMessagePage: vi.fn() }));
vi.mock("./api", () => ({ getMessagePage }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("suspends hidden history subscriptions and older loading, then rejoins the latest cache", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const message = {
    id: "message",
    chatId: "chat",
    contextKind: "project",
    worktreeId: "primary",
    scratchRootId: null,
    executionLaneId: null,
    sequence: 1,
    role: "user",
    mode: "default",
    content: [{ type: "text", text: "original" }],
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
    reasoningEffort: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt: "2026-10-07T00:00:00Z",
  } satisfies ChatMessage;
  const page: ChatMessagePage = {
    messages: [message],
    page: {
      hasMore: true,
      nextBeforeSequence: 1,
      oldestSequence: 1,
      newestSequence: 1,
      startsAtUserTurn: true,
    },
  };
  client.setQueryData(chatMessagePagesQueryKey("chat"), page);
  getMessagePage.mockResolvedValue(page);
  const idle = vi.fn((_callback: () => void) => 1);
  vi.stubGlobal("window", {
    requestIdleCallback: idle,
    cancelIdleCallback: vi.fn(),
  });
  const renders = vi.fn();
  function Probe({ enabled }: { enabled: boolean }) {
    renders();
    const history = useChatMessageHistory({
      autoLoadOlder: true,
      chatId: "chat",
      enabled,
    });
    return <span>{JSON.stringify(history.data)}</span>;
  }
  const render = (enabled: boolean) => (
    <QueryClientProvider client={client}>
      <Probe enabled={enabled} />
    </QueryClientProvider>
  );
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = TestRenderer.create(render(false));
    });
    const hiddenRenders = renders.mock.calls.length;
    const latest = {
      ...message,
      content: [{ type: "text" as const, text: "latest" }],
    };
    await act(async () => {
      client.setQueryData(
        chatMessageLiveQueryKey("chat"),
        upsertChatMessageLiveOverlay(undefined, latest),
      );
      client.setQueryData(
        chatMessageProvisionalQueryKey("chat"),
        upsertChatMessageLiveOverlay(undefined, latest),
      );
      await client.invalidateQueries({
        queryKey: chatMessagePagesQueryKey("chat"),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(renders).toHaveBeenCalledTimes(hiddenRenders);
    expect(getMessagePage).not.toHaveBeenCalled();
    expect(idle).not.toHaveBeenCalled();
    await act(async () => renderer!.update(render(true)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getMessagePage).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByType("span").children.join("")).toContain(
      "latest",
    );
    expect(idle).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => renderer?.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});
