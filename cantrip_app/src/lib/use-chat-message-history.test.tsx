import type { ChatMessage } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";

import {
  chatMessageLiveQueryKey,
  chatMessageLoadedHeadQueryKey,
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

function fixturePage(sequences: number[], hasMore = true): ChatMessagePage {
  return {
    messages: sequences.map((sequence) => ({
      id: `message-${sequence}`,
      chatId: "reader",
      contextKind: "project",
      worktreeId: "primary",
      scratchRootId: null,
      executionLaneId: null,
      sequence,
      role: sequence % 2 ? "user" : "assistant",
      mode: "default",
      content: [{ type: "text", text: `Message ${sequence}` }],
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      reasoningEffort: null,
      appliedReasoningEffort: null,
      reasoningAdjusted: false,
      createdAt: "2026-10-08T00:00:00Z",
    })),
    page: {
      hasMore,
      nextBeforeSequence: hasMore ? sequences[0]! : null,
      oldestSequence: sequences[0]!,
      newestSequence: sequences.at(-1)!,
      startsAtUserTurn: true,
    },
  };
}

async function readingHistory(
  run: (input: {
    client: QueryClient;
    history(): ReturnType<typeof useChatMessageHistory>;
    advance(page: ChatMessagePage): void;
  }) => Promise<void>,
) {
  getMessagePage.mockReset();
  let current = fixturePage([5, 6]);
  getMessagePage.mockImplementation(async (_chatId, options) =>
    options.beforeSequence ? fixturePage([1, 2, 3, 4], false) : current,
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let history!: ReturnType<typeof useChatMessageHistory>;
  function Probe() {
    history = useChatMessageHistory({ chatId: "reader" });
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await history.refetch();
      await new Promise((r) => setTimeout(r, 20));
    });
    await run({
      client,
      history: () => history,
      advance: (page) => {
        current = page;
      },
    });
  } finally {
    await act(async () => renderer.unmount());
    client.clear();
  }
}

it("retains loaded older pages and the head boundary while a new turn arrives", async () => {
  await readingHistory(async ({ history, advance }) => {
    await act(async () => {
      await history().fetchOlder();
      await new Promise((r) => setTimeout(r, 20));
    });
    advance(fixturePage([7, 8]));
    await act(async () => {
      await history().refetch();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(history().data.map((m) => m.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(history().hasOlder).toBe(false);
  });
});

it("joins an in-flight older page once even if the head advances", async () => {
  await readingHistory(async ({ history, advance }) => {
    let resolve!: (page: ChatMessagePage) => void;
    const older = new Promise<ChatMessagePage>((done) => {
      resolve = done;
    });
    getMessagePage.mockImplementation(async (_chatId, options) =>
      options.beforeSequence ? older : fixturePage([7, 8]),
    );
    let loading!: Promise<void>;
    await act(async () => {
      loading = history().fetchOlder();
      await new Promise((r) => setTimeout(r, 20));
    });
    advance(fixturePage([7, 8]));
    await act(async () => {
      await history().refetch();
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      resolve(fixturePage([1, 2, 3, 4], false));
      await loading;
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(history().data.map((m) => m.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
});

it("backfills a forward gap without dropping the already loaded reading range", async () => {
  await readingHistory(async ({ history }) => {
    await act(async () => {
      await history().fetchOlder();
      await new Promise((r) => setTimeout(r, 20));
    });
    getMessagePage.mockImplementation(async (_chatId, options) =>
      options.beforeSequence === 11
        ? fixturePage([7, 8, 9, 10])
        : fixturePage([11, 12]),
    );
    await act(async () => {
      await history().refetch();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(history().data.map((m) => m.sequence)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  });
});

it("discards retained ranges on live scope recovery", async () => {
  await readingHistory(async ({ history, client, advance }) => {
    await act(async () => {
      await history().fetchOlder();
      await new Promise((r) => setTimeout(r, 20));
    });
    advance(fixturePage([7, 8]));
    await act(async () => {
      await history().refetch();
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      client.removeQueries({ queryKey: ["message-history", "reader"] });
      advance(fixturePage([11, 12]));
      await history().refetch();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(history().data.map((m) => m.sequence)).toEqual([11, 12]);
  });
});

it("keeps the loaded range when a bridge response fails to advance", async () => {
  await readingHistory(async ({ history }) => {
    await act(async () => {
      await history().fetchOlder();
      await new Promise((r) => setTimeout(r, 20));
    });
    getMessagePage.mockResolvedValue(fixturePage([11, 12]));
    await act(async () => {
      const result = await history().refetch();
      expect(result.error?.message).toBe(
        "Chat history pagination did not advance.",
      );
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(history().data.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

it("does not restore a cancelled retained range after scope recovery", async () => {
  await readingHistory(async ({ history, client }) => {
    let resolveBridge!: (page: ChatMessagePage) => void;
    const bridge = new Promise<ChatMessagePage>((resolve) => {
      resolveBridge = resolve;
    });
    getMessagePage.mockImplementation(async (_chatId, options) =>
      options.beforeSequence ? bridge : fixturePage([11, 12]),
    );
    let refreshing!: ReturnType<
      ReturnType<typeof useChatMessageHistory>["refetch"]
    >;
    await act(async () => {
      refreshing = history().refetch();
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      await client.cancelQueries({
        queryKey: chatMessagePagesQueryKey("reader"),
      });
      client.removeQueries({ queryKey: ["message-history", "reader"] });
      resolveBridge(fixturePage([7, 8, 9, 10]));
      await refreshing;
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(
      client.getQueryData(chatMessageLoadedHeadQueryKey("reader")),
    ).toBeUndefined();
    getMessagePage.mockResolvedValue(fixturePage([11, 12]));
    await act(async () => {
      await history().refetch();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(history().data.map((m) => m.sequence)).toEqual([11, 12]);
  });
});
