import { useConversationChatActions } from "./use-conversation-chat-actions";
import { ConversationVirtualList } from "./conversation-virtual-list";
import { ConversationRowButton } from "./conversation-row-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CantripApiError } from "@/lib/api-client";
import type { ArchivedAgentConversation } from "@/lib/api/conversations";
import { preventMiddleMouseDefault } from "@/lib/tab-middle-click";
import { useConversationLifecycle } from "./use-conversation-lifecycle";
import { useConversationSessionOrder } from "./use-conversation-session-order";
import { ConversationArchivedSection } from "./conversation-archived-section";
import {
  ConversationRowMenu,
  openConversationRowMenu,
} from "./conversation-row-menu";
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
  onPlace,
  placementPending = new Set<string>(),
  archiveFocusRequest,
  onArchiveFocusHandled,
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
  placementPending?: ReadonlySet<string>;
  onPlace?: (
    chatId: string,
    region: "center" | "right" | "bottom",
  ) => Promise<unknown>;
  archiveFocusRequest?: string | null;
  onArchiveFocusHandled?(): void;
  randomAgentNames?: boolean;
  existingTitles?: readonly string[];
  visible: boolean;
  controller: WorkspaceCommandClient | null;
  selectedChatId: string | null;
  workers: readonly WorkerSummary[];
  onOpened(): void;
  focusWindow(windowId: string): Promise<unknown> | void;
}) {
  const chatActions = useConversationChatActions(projectId);
  const queryClient = useQueryClient();
  const liveStatus = useAppLiveStatus();
  const lifecycle = useConversationLifecycle(projectId, controller);
  const listRoot = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!visible || !archiveFocusRequest) return;
    const heading = listRoot.current?.querySelector<HTMLElement>(
      "[data-archive-heading]",
    );
    if (!heading) return;
    heading.focus();
    heading.scrollIntoView?.({ block: "nearest" });
    onArchiveFocusHandled?.();
  }, [visible, archiveFocusRequest, onArchiveFocusHandled]);
  const focusAfterDialogClose = useRef(false);
  const desiredFocus = useRef<{ attribute: string; id?: string } | null>(null);
  const [stopTarget, setStopTarget] = useState<ChatSummary | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<ArchivedAgentConversation | null>(null);
  function restoreRowFocus(fromDialog = false) {
    if (!desiredFocus.current) return;
    const root = listRoot.current;
    const target = desiredFocus.current;
    desiredFocus.current = null;
    if (
      !root ||
      (!fromDialog &&
        document.activeElement !== document.body &&
        !root.contains(document.activeElement))
    )
      return;
    const row = target.id
      ? [...root.querySelectorAll<HTMLElement>(`[${target.attribute}]`)].find(
          (element) => element.getAttribute(target.attribute) === target.id,
        )
      : null;
    (
      row ??
      root.querySelector<HTMLElement>(
        target.attribute === "data-archived-conversation-id"
          ? "[data-archive-heading]"
          : '[aria-label="New agent chat"]',
      )
    )?.focus();
  }
  useEffect(() => {
    if (
      !lifecycle.completed ||
      stopTarget ||
      deleteTarget ||
      focusAfterDialogClose.current
    )
      return;
    restoreRowFocus();
  }, [lifecycle.completed, stopTarget, deleteTarget]);
  function finishDialogFocus(event: Event) {
    if (!focusAfterDialogClose.current) return;
    event.preventDefault();
    focusAfterDialogClose.current = false;
    restoreRowFocus(true);
  }
  function focusNeighbor(chatId: string, attribute: string) {
    const ids = [
      ...(listRoot.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ??
        []),
    ].map((element) => element.getAttribute(attribute)!);
    const index = ids.indexOf(chatId);
    desiredFocus.current = { attribute, id: ids[index + 1] ?? ids[index - 1] };
  }
  function requestArchive(chat: ChatSummary) {
    if (placementPending.has(chat.id)) return;
    const error = lifecycle.errors.get(chat.id);
    if (
      chat.status === "running" ||
      chat.status === "waiting-for-approval" ||
      (error instanceof CantripApiError &&
        error.status === 409 &&
        error.message === "Stop the running chat first.")
    ) {
      setStopTarget(chat);
      return;
    }
    focusNeighbor(chat.id, "data-conversation-id");
    void lifecycle.archive(chat.id);
  }

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
            "The chat workspace changed. Open it from the current sidebar.",
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
  const rows = useConversationSessionOrder(projectId, [
    ...new Map(
      (
        query.data?.pages.flatMap((page) =>
          page.state === "active" ? page.items : [],
        ) ?? []
      ).map((chat) => [chat.id, chat]),
    ).values(),
  ]);
  async function open(chat: ChatSummary, action = captureAction()) {
    action.assert();
    if (!controller)
      throw new Error(
        "The workspace is still connecting. Try opening the chat again.",
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
      ref={listRoot}
      aria-label="Agent chats"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-8 shrink-0 items-center justify-between px-2 text-xs text-muted-foreground">
        <span>{query.data?.pages[0]?.total ?? ""} Chats</span>
        <Button
          aria-label="New agent chat"
          title="New agent chat"
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
            Loading chats…
          </p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            Create an agent chat with +.
          </p>
        ) : null}
        <ConversationVirtualList rows={rows} estimate={32} label="Active chats">
          {(chat) => (
            <div
              key={chat.id}
              data-conversation-row=""
              data-elite-global-key={
                visible
                  ? `conversation:active:${projectId}:${chat.id}`
                  : undefined
              }
            >
              <div className="flex items-center">
                <ConversationRowButton
                  projectId={projectId}
                  chatId={chat.id}
                  title={chat.title}
                  placementEnabled={
                    Boolean(onPlace) && !placementPending.has(chat.id)
                  }
                  disabled={placementPending.has(chat.id)}
                  aria-busy={placementPending.has(chat.id)}
                  type="button"
                  data-conversation-id={chat.id}
                  aria-current={selectedChatId === chat.id ? "true" : undefined}
                  className={cn(
                    "flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selectedChatId === chat.id && "bg-muted",
                  )}
                  onMouseDown={preventMiddleMouseDefault}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      event.stopPropagation();
                      requestArchive(chat);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.shiftKey && event.key === "F10") {
                      event.preventDefault();
                      openConversationRowMenu(event.currentTarget);
                    }
                  }}
                  onClick={() => {
                    const action = captureAction();
                    setError(null);
                    void open(chat, action).catch((cause) => {
                      if (action.current()) setError(cause);
                    });
                  }}
                >
                  {lifecycle.pending.has(chat.id) ||
                  placementPending.has(chat.id) ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Bot className="size-3.5 shrink-0" />
                  )}
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
                </ConversationRowButton>
                <ConversationRowMenu
                  title={chat.title}
                  pending={
                    lifecycle.pending.has(chat.id) ||
                    chatActions.pending.has(chat.id) ||
                    placementPending.has(chat.id)
                  }
                  rename={() => chatActions.rename(chat)}
                  fork={() => chatActions.fork(chat)}
                  place={
                    onPlace
                      ? (region) => {
                          const action = captureAction();
                          setError(null);
                          void onPlace(chat.id, region).catch((cause) => {
                            if (action.current()) setError(cause);
                          });
                        }
                      : undefined
                  }
                  archive={() => requestArchive(chat)}
                />
              </div>
              {lifecycle.errors.has(chat.id) ||
              chatActions.errors.has(chat.id) ? (
                <p role="alert" className="px-2 text-xs text-destructive">
                  {errorMessage(
                    lifecycle.errors.get(chat.id) ??
                      chatActions.errors.get(chat.id),
                  )}
                </p>
              ) : null}
            </div>
          )}
        </ConversationVirtualList>
        {query.hasNextPage ? (
          <Button
            className="w-full"
            variant="ghost"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.fetchNextPage({ cancelRefetch: false })}
          >
            Load more chats
          </Button>
        ) : null}
        <ConversationArchivedSection
          projectId={projectId}
          visible={visible}
          pending={lifecycle.pending}
          errors={lifecycle.errors}
          onRestore={(chat) => {
            desiredFocus.current = {
              attribute: "data-conversation-id",
              id: chat.id,
            };
            void lifecycle.restore(chat.id);
          }}
          onDelete={setDeleteTarget}
        />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {lifecycle.completed
          ? `Chat ${lifecycle.completed.action === "archive" ? "archived" : lifecycle.completed.action === "restore" ? "restored" : "permanently deleted"}.`
          : ""}
      </span>
      {chatActions.dialog}
      <ConfirmDialog
        onCloseAutoFocus={finishDialogFocus}
        open={Boolean(stopTarget)}
        onOpenChange={(open) => {
          if (!open) setStopTarget(null);
        }}
        title="Stop and archive chat?"
        description={`Stop the active work in ${stopTarget?.title ?? "this chat"} and move it to Archived. Its history and draft will remain recoverable.`}
        confirmLabel="Stop and Archive"
        confirmPendingLabel="Archiving…"
        pending={Boolean(stopTarget && lifecycle.pending.has(stopTarget.id))}
        error={
          stopTarget && lifecycle.errors.has(stopTarget.id)
            ? errorMessage(lifecycle.errors.get(stopTarget.id))
            : undefined
        }
        onConfirm={() => {
          if (!stopTarget) return;
          focusNeighbor(stopTarget.id, "data-conversation-id");
          void lifecycle.archive(stopTarget.id, true).then((ok) => {
            if (ok) {
              focusAfterDialogClose.current = true;
              setStopTarget(null);
            }
          });
        }}
      />
      <ConfirmDialog
        onCloseAutoFocus={finishDialogFocus}
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Permanently delete chat?"
        description={`${deleteTarget?.title ?? "This chat"} and its history will be permanently deleted. This cannot be undone.`}
        confirmLabel="Permanently Delete"
        confirmPendingLabel="Deleting…"
        pending={Boolean(
          deleteTarget && lifecycle.pending.has(deleteTarget.id),
        )}
        error={
          deleteTarget && lifecycle.errors.has(deleteTarget.id)
            ? errorMessage(lifecycle.errors.get(deleteTarget.id))
            : undefined
        }
        onConfirm={() => {
          if (!deleteTarget) return;
          focusNeighbor(deleteTarget.id, "data-archived-conversation-id");
          void lifecycle.remove(deleteTarget.id).then((ok) => {
            if (ok) {
              focusAfterDialogClose.current = true;
              setDeleteTarget(null);
            }
          });
        }}
      />
    </section>
  );
}
