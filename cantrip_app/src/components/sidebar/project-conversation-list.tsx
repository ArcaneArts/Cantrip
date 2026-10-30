import { useAppLiveStatus } from "@/lib/app-live-react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2, Plus, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatSummary, WorkerSummary } from "@cantrip/protocol";
import { newAgentChatTitle } from "@/components/chat/agent-chat-name";
import { ChatActivityStatus } from "@/components/chat/chat-activity-status";
import { checkpointChatView } from "@/components/chat/chat-transfer-lifecycle";
import { Button } from "@/components/ui/button";
import {
  getConversationCatalog,
  prepareConversationCreation,
} from "@/lib/api/conversations";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import { errorMessage } from "@/lib/error-message";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { cn } from "@/lib/utils";

export function ProjectConversationList({
  projectId,
  randomAgentNames = false,
  existingTitles = [],
  visible,
  controller,
  selectedChatId,
  workers,
  onOpened,
  focusWindow,
}: {
  projectId: string;
  randomAgentNames?: boolean;
  existingTitles?: readonly string[];
  visible: boolean;
  controller: WorkspaceCommandClient | null;
  selectedChatId: string | null;
  workers: readonly WorkerSummary[];
  onOpened(): void;
  focusWindow(windowId: string): Promise<unknown> | void;
}) {
  const queryClient = useQueryClient();
  const liveStatus = useAppLiveStatus();
  const mounted = useRef(false);
  const currentScope = useRef({ projectId, controller });
  currentScope.current = { projectId, controller };
  const createBusy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function captureAction() {
    const identity = getClientSessionIdentitySnapshot();
    const current = () =>
      mounted.current &&
      currentScope.current.projectId === projectId &&
      currentScope.current.controller === controller &&
      Boolean(identity && clientSessionIdentityMatches(identity));
    return {
      current,
      identity,
      assert: () => {
        if (!current())
          throw new Error(
            "The conversation workspace changed. Open it from the current sidebar.",
          );
      },
    };
  }
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const createOperation = useRef<{
    identity: NonNullable<ReturnType<typeof getClientSessionIdentitySnapshot>>;
    projectId: string;
    run: Awaited<ReturnType<typeof prepareConversationCreation>>;
  } | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["chats", projectId, "conversations", "active"],
    enabled: visible,
    refetchInterval: visible && liveStatus !== "live" ? 10_000 : false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      getConversationCatalog(projectId, {
        state: "active",
        limit: 50,
        cursor: pageParam,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = [
    ...new Map(
      (
        query.data?.pages.flatMap((page) =>
          page.state === "active" ? page.items : [],
        ) ?? []
      ).map((chat) => [chat.id, chat]),
    ).values(),
  ];
  async function open(chat: ChatSummary, action = captureAction()) {
    action.assert();
    if (!controller)
      throw new Error(
        "The workspace is still connecting. Try opening the conversation again.",
      );
    queryClient.setQueryData<ChatSummary[]>(["chats", projectId], (current) => {
      const existing = current ?? [];
      return [...existing.filter((c) => c.id !== chat.id), chat];
    });
    const receipt = await controller.openConversation(chat.id, {
      checkpoint: checkpointChatView,
    });
    action.assert();
    if (receipt.focusWindowId) await focusWindow(receipt.focusWindowId);
    action.assert();
    onOpened();
  }
  async function create() {
    if (createBusy.current) return;
    createBusy.current = true;
    const action = captureAction();
    setCreating(true);
    setError(null);
    try {
      action.assert();
      if (
        createOperation.current &&
        (createOperation.current.projectId !== projectId ||
          !clientSessionIdentityMatches(createOperation.current.identity))
      )
        createOperation.current = null;
      if (!createOperation.current) {
        const run = await prepareConversationCreation(
          projectId,
          newAgentChatTitle(
            [...existingTitles, ...rows.map((chat) => chat.title)],
            randomAgentNames,
          ),
          !randomAgentNames,
        );
        action.assert();
        createOperation.current = {
          run,
          identity: action.identity!,
          projectId,
        };
      }
      const chat = await createOperation.current.run();
      action.assert();
      await queryClient.invalidateQueries({ queryKey: ["chats", projectId] });
      await open(chat, action);
      createOperation.current = null;
    } catch (cause) {
      if (action.current()) setError(cause);
    } finally {
      createBusy.current = false;
      if (mounted.current) setCreating(false);
    }
  }
  return (
    <section
      aria-label="Agent conversations"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-8 shrink-0 items-center justify-between px-2 text-xs text-muted-foreground">
        <span>{query.data?.pages[0]?.total ?? ""} Conversations</span>
        <Button
          aria-label="New agent conversation"
          title="New agent conversation"
          size="icon"
          variant="ghost"
          className="size-6"
          disabled={creating}
          onClick={() => void create()}
        >
          {creating ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Plus className="size-3" />
          )}
        </Button>
      </div>
      {error || query.error ? (
        <div role="alert" className="px-2 py-2 text-xs text-destructive">
          {errorMessage(error ?? query.error)}
          {query.error ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-slot="conversation-list-scroll"
      >
        {query.isPending ? (
          <p role="status" className="p-3 text-xs text-muted-foreground">
            Loading conversations…
          </p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            Create an Agent conversation with +.
          </p>
        ) : null}
        {rows.map((chat) => (
          <button
            key={chat.id}
            type="button"
            data-conversation-id={chat.id}
            aria-current={selectedChatId === chat.id ? "true" : undefined}
            className={cn(
              "flex min-h-8 w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selectedChatId === chat.id && "bg-muted",
            )}
            onClick={() => {
              const action = captureAction();
              setError(null);
              void open(chat, action).catch((cause) => {
                if (action.current()) setError(cause);
              });
            }}
          >
            <Bot className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{chat.title}</span>
            {!workers.some(
              (w) => w.workerId === chat.activeWorkerId && w.online,
            ) ? (
              <WifiOff
                className="size-3 shrink-0 text-muted-foreground"
                aria-label="Worker unavailable"
              />
            ) : null}
            <ChatActivityStatus chat={chat} />
          </button>
        ))}
        {query.hasNextPage ? (
          <Button
            className="w-full"
            variant="ghost"
            size="sm"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more conversations
          </Button>
        ) : null}
      </div>
    </section>
  );
}
