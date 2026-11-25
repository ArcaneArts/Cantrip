import type { AgentInteractionResponse } from "@cantrip/protocol";
import { councilProjectRequestLink } from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CircleAlert } from "lucide-react";
import { useRef, useState } from "react";

import { AgentInteractionPanel } from "@/components/chat/agent-interaction-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getAgentInteractionRequests,
  respondToAgentInteractionRequest,
} from "@/lib/api/chats";
import { errorMessage } from "@/lib/error-message";

export function CouncilProjectApprovals({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const replyKeys = useRef(new Map<string, string>());
  const key = ["agent-requests", agentId, "delegated-pending"] as const;
  const pending = useQuery({
    queryKey: key,
    queryFn: () =>
      getAgentInteractionRequests({
        councilAgentId: agentId,
        status: "pending",
      }),
    refetchInterval: 2_500,
  });
  const reply = useMutation({
    mutationFn: ({
      requestId,
      response,
    }: {
      requestId: string;
      response: AgentInteractionResponse;
    }) => {
      const idempotencyKey =
        replyKeys.current.get(requestId) ?? crypto.randomUUID();
      replyKeys.current.set(requestId, idempotencyKey);
      return respondToAgentInteractionRequest(requestId, {
        idempotencyKey,
        response,
      });
    },
    onSuccess: (request) => {
      replyKeys.current.delete(request.id);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({
          queryKey: ["agent-requests", request.provenance.chatId],
        }),
      ]);
    },
  });
  const requests = pending.data ?? [];
  if (!open && !requests.length) return null;
  return (
    <>
      {requests.length ? (
        <Button
          aria-label={`Project requests (${requests.length})`}
          onClick={() => setOpen(true)}
          size="sm"
          variant="outline"
        >
          <CircleAlert className="size-4" /> {requests.length}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Project requests</DialogTitle>
            <DialogDescription>
              Respond to requests from project chats and Tasks this agent
              started or contacted.
            </DialogDescription>
          </DialogHeader>
          {requests.length ? (
            <AgentInteractionPanel
              error={reply.isError ? errorMessage(reply.error) : null}
              pendingRequestId={
                reply.isPending ? reply.variables.requestId : null
              }
              requests={requests}
              onRespond={(requestId, response) =>
                reply.mutate({ requestId, response })
              }
              renderSource={(request) =>
                request.projectId && request.provenance.chatId ? (
                  <a
                    className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    href={councilProjectRequestLink({
                      projectId: request.projectId,
                      chatId: request.provenance.chatId,
                      requestId: request.id,
                      targetKind: request.targetKind,
                    })}
                  >
                    {request.targetKind === "task"
                      ? "Open in Task"
                      : "Open in project chat"}
                    <ArrowUpRight className="size-3" />
                  </a>
                ) : null
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No pending project requests.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
