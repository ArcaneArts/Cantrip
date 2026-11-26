import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { MessageContent } from "@/components/chat/message-content";
import { TooltipButton, TooltipTarget } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input } from "@/components/ui/input";
import {
  deleteCouncilHistoryMessage,
  readCouncilHistory,
  searchCouncilHistory,
} from "@/lib/api/council-history";
import {
  chatMessageLiveQueryKey,
  deleteFromChatMessageLiveOverlay,
  type ChatMessageLiveOverlay,
} from "@/lib/chat-message-history";
import { errorMessage } from "@/lib/error-message";
import { useChatMessageLiveOverlay } from "@/lib/use-chat-message-history";
import { cn } from "@/lib/utils";

type Props = {
  agentId: string;
  messageId: string | null;
  onClose(): void;
  onOpenFile(path: string): void;
};

export function CouncilHistoryDialog({
  agentId,
  messageId,
  onClose,
  onOpenFile,
}: Props) {
  const [query, setQuery] = useState("");
  const [exact, setExact] = useState(false);
  const [focused, setFocused] = useState(messageId);
  const { deletedIds } = useChatMessageLiveOverlay(agentId);
  const search = useMutation({
    gcTime: 0,
    mutationFn: ({ text, literal }: { text: string; literal: boolean }) =>
      searchCouncilHistory(agentId, text, literal ? "literal" : "terms"),
  });
  const matches = search.data?.matches.filter(
    (match) => !deletedIds.includes(match.messageId),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeTooltip="Close Council history"
        className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Council history</DialogTitle>
          <DialogDescription>
            Find earlier messages, tool activity, and attachments.
          </DialogDescription>
        </DialogHeader>
        {focused ? (
          <>
            <TooltipButton
              tooltip="Back to search"
              type="button"
              variant="ghost"
              className="w-fit"
              onClick={() => setFocused(null)}
            >
              Back to search
            </TooltipButton>
            <HistoryEvidence
              key={focused}
              agentId={agentId}
              messageId={focused}
              deletedIds={deletedIds}
              onDeleted={() => {
                search.reset();
                setQuery("");
              }}
              onOpenFile={onOpenFile}
            />
          </>
        ) : (
          <>
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (query.trim() && !search.isPending)
                  search.mutate({ text: query, literal: exact });
              }}
            >
              <div className="flex gap-2">
                <Input
                  autoFocus
                  aria-label="Search Council history"
                  maxLength={400}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
                <TooltipButton
                  tooltip="Search"
                  type="submit"
                  disabled={!query.trim() || search.isPending}
                >
                  Search
                </TooltipButton>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={exact}
                  onChange={(event) => setExact(event.currentTarget.checked)}
                />
                Exact phrase
              </label>
            </form>
            {search.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Searching history…
              </p>
            ) : null}
            {search.isError ? (
              <InlineAlert>{errorMessage(search.error)}</InlineAlert>
            ) : null}
            {search.data ? (
              <div className="space-y-2">
                {search.data.coverage === "partial" ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Some retained messages could not be fully indexed.
                  </p>
                ) : null}
                {matches?.length ? (
                  <ul className="space-y-2">
                    {matches.map((hit) => (
                      <li key={hit.messageId}>
                        <TooltipTarget tooltip="Open message in history">
                          <button
                            className="w-full rounded-md border p-3 text-left hover:bg-muted focus-visible:outline-2"
                            type="button"
                            onClick={() => setFocused(hit.messageId)}
                          >
                            <HistoryLabel role={hit.role} at={hit.createdAt} />
                            <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm">
                              {hit.snippet}
                            </p>
                          </button>
                        </TooltipTarget>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p role="status" className="text-sm text-muted-foreground">
                    No matching messages.
                  </p>
                )}
              </div>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistoryLabel({
  role,
  at,
}: {
  role: "user" | "assistant" | "system";
  at: string;
}) {
  return (
    <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
      <span>
        {role === "user" ? "You" : role === "assistant" ? "Agent" : "System"}
      </span>
      <time dateTime={at}>{new Date(at).toLocaleString()}</time>
    </span>
  );
}

function HistoryEvidence({
  agentId,
  messageId,
  deletedIds,
  onDeleted,
  onOpenFile,
}: Omit<Props, "onClose" | "messageId"> & {
  messageId: string;
  deletedIds: readonly string[];
  onDeleted(): void;
}) {
  const cache = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const historyKey = ["council", "history", agentId] as const;
  const rangeKey = [...historyKey, messageId] as const;
  const range = useQuery({
    queryKey: rangeKey,
    queryFn: () => readCouncilHistory(agentId, messageId),
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => deleteCouncilHistoryMessage(agentId, messageId),
    onSuccess: () => {
      cache.setQueryData<ChatMessageLiveOverlay>(
        chatMessageLiveQueryKey(agentId),
        (current) => deleteFromChatMessageLiveOverlay(current, messageId),
      );
      cache.setQueryData(rangeKey, {
        messages: [],
        available: false,
        incomplete: false,
      });
      void cache.invalidateQueries({ queryKey: historyKey });
      setConfirmOpen(false);
      onDeleted();
    },
  });
  if (range.isError)
    return <InlineAlert>{errorMessage(range.error)}</InlineAlert>;
  if (range.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Opening message…
      </p>
    );
  const available = range.data.available && !deletedIds.includes(messageId);
  return (
    <div className="space-y-3">
      {!available ? (
        <p role="status" className="text-sm text-muted-foreground">
          This message is unavailable.
        </p>
      ) : null}
      {range.data.incomplete ? (
        <p role="status" className="text-sm text-muted-foreground">
          Some nearby messages could not be opened.
        </p>
      ) : null}
      {range.data.messages
        .filter(({ id }) => !deletedIds.includes(id))
        .map((message) => (
          <article
            key={message.id}
            aria-label={
              message.id === messageId ? "Selected message" : "Nearby message"
            }
            className={cn(
              "min-w-0 space-y-2 rounded-md border p-3",
              message.id === messageId && "border-primary/60 bg-muted/30",
            )}
          >
            <HistoryLabel role={message.role} at={message.createdAt} />
            <MessageContent
              message={message}
              onOpenFile={onOpenFile}
              trackGlobalKey={false}
            />
          </article>
        ))}
      {available ? (
        <TooltipButton
          tooltip="Delete message"
          variant="outline"
          onClick={() => {
            remove.reset();
            setConfirmOpen(true);
          }}
        >
          Delete message
        </TooltipButton>
      ) : null}
      <ConfirmDialog
        buttonTooltips
        title="Delete Council message?"
        description="This permanently removes the selected message and clears the agent’s current Codex context. The agent can still search the rest of its history."
        open={confirmOpen}
        pending={remove.isPending}
        confirmLabel="Delete message"
        confirmPendingLabel="Deleting…"
        error={remove.isError ? errorMessage(remove.error) : null}
        onOpenChange={setConfirmOpen}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
