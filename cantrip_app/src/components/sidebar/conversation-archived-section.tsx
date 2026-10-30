import { ConversationVirtualList } from "./conversation-virtual-list";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Archive, Loader2 } from "lucide-react";
import {
  getConversationCatalog,
  type ArchivedAgentConversation,
} from "@/lib/api/conversations";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import {
  ConversationRowMenu,
  openConversationRowMenu,
} from "./conversation-row-menu";
export function ConversationArchivedSection({
  projectId,
  visible,
  pending,
  errors,
  onRestore,
  onDelete,
}: {
  projectId: string;
  visible: boolean;
  pending: ReadonlySet<string>;
  errors: ReadonlyMap<string, unknown>;
  onRestore(chat: ArchivedAgentConversation): void;
  onDelete(chat: ArchivedAgentConversation): void;
}) {
  const live = useAppLiveStatus();
  const query = useInfiniteQuery({
    queryKey: ["chats", projectId, "conversations", "archived"],
    enabled: visible,
    refetchInterval: visible && live !== "live" ? 10_000 : false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      getConversationCatalog(projectId, {
        state: "archived",
        limit: 50,
        cursor: pageParam,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = [
    ...new Map(
      (
        query.data?.pages.flatMap((page) =>
          page.state === "archived" ? page.items : [],
        ) ?? []
      ).map((chat) => [chat.id, chat]),
    ).values(),
  ];
  return (
    <section
      aria-label="Archived conversations"
      className="mt-3 border-t border-border/50 pt-2"
    >
      <h3
        tabIndex={-1}
        data-archive-heading=""
        className="px-2 py-1 text-xs font-medium text-muted-foreground"
      >
        Archived {query.data?.pages[0]?.total ?? ""}
      </h3>
      <p className="px-2 pb-2 text-[10px] text-muted-foreground">
        Archived conversations are kept for 90 days.
      </p>
      {query.error ? (
        <div role="alert" className="px-2 text-xs text-destructive">
          {errorMessage(query.error)}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Retry archive
          </Button>
        </div>
      ) : null}
      {query.isPending ? (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          Loading archive…
        </p>
      ) : rows.length === 0 && !query.error ? (
        <p className="px-2 text-xs text-muted-foreground">
          No archived conversations.
        </p>
      ) : null}
      <ConversationVirtualList
        rows={rows}
        estimate={50}
        label="Archived conversation list"
      >
        {(chat) => (
          <div key={chat.id} data-conversation-row="" className="px-1">
            <div className="flex items-center">
              <button
                type="button"
                data-archived-conversation-id={chat.id}
                className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded px-1 text-left text-xs hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(event) =>
                  openConversationRowMenu(event.currentTarget)
                }
                onKeyDown={(event) => {
                  if (event.shiftKey && event.key === "F10") {
                    event.preventDefault();
                    openConversationRowMenu(event.currentTarget);
                  }
                }}
              >
                {pending.has(chat.id) ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                ) : (
                  <Archive className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{chat.title}</span>
              </button>
              <ConversationRowMenu
                title={chat.title}
                pending={pending.has(chat.id)}
                restore={() => onRestore(chat)}
                remove={() => onDelete(chat)}
              />
            </div>
            <p className="px-1 pb-1 text-[10px] text-muted-foreground">
              Deletes {new Date(chat.expiresAt).toLocaleDateString()}
            </p>
            {errors.has(chat.id) ? (
              <p role="alert" className="px-1 text-xs text-destructive">
                {errorMessage(errors.get(chat.id))}
              </p>
            ) : null}
          </div>
        )}
      </ConversationVirtualList>
      {query.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage({ cancelRefetch: false })}
        >
          Load more archived conversations
        </Button>
      ) : null}
    </section>
  );
}
