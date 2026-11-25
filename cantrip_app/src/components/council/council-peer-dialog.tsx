import { useInfiniteQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { readCouncilPeerPage } from "@/lib/api/council-history";
import { errorMessage } from "@/lib/error-message";

export function CouncilPeerDialog({
  agentId,
  peerId,
  agentTitle,
  peerTitle,
  onClose,
}: {
  agentId: string;
  peerId: string;
  agentTitle: string;
  peerTitle: string;
  onClose(): void;
}) {
  const query = useInfiniteQuery({
    queryKey: ["council", "peer", ...[agentId, peerId].sort()],
    queryFn: ({ pageParam }) => readCouncilPeerPage(agentId, peerId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextBefore,
    refetchInterval: 4_000,
    gcTime: 0,
  });
  const messages = query.data?.pages.flatMap((page) => page.messages).reverse();
  const incomplete = query.data?.pages.some((page) => page.incomplete);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
        data-slot="council-peer-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {agentTitle} and {peerTitle}
          </DialogTitle>
          <DialogDescription>
            Messages these Council agents sent to each other.
          </DialogDescription>
        </DialogHeader>
        {query.isPending ? <p role="status">Loading handoffs…</p> : null}
        {query.isError ? (
          <InlineAlert tone="error">{errorMessage(query.error)}</InlineAlert>
        ) : null}
        {incomplete ? (
          <p className="text-sm text-muted-foreground">
            Some handoffs could not be opened.
          </p>
        ) : null}
        {messages?.length === 0 && !incomplete ? (
          <p className="text-sm text-muted-foreground">No handoffs yet.</p>
        ) : null}
        {query.hasNextPage ? (
          <Button
            className="w-fit"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load earlier messages
          </Button>
        ) : null}
        {messages?.length ? (
          <ol className="space-y-3">
            {messages.map((message) => (
              <li
                className="space-y-1 rounded-lg border px-3 py-2"
                key={message.id}
                data-council-peer-message={message.id}
              >
                <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm font-medium">
                  {message.senderAgentId === agentId ? agentTitle : peerTitle}
                  <time
                    dateTime={message.createdAt}
                    className="text-xs font-normal text-muted-foreground"
                  >
                    {new Date(message.createdAt).toLocaleString()}
                  </time>
                </p>
                <p className="break-words whitespace-pre-wrap text-sm">
                  {message.text}
                </p>
              </li>
            ))}
          </ol>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
