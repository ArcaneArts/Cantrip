import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
  ChatSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { useRef } from "react";

import { AgentInteractionPanel } from "@/components/chat/agent-interaction-panel";
import { Button } from "@/components/ui/button";
import {
  getAgentInteractionRequests,
  respondToAgentInteractionRequest,
} from "@/lib/api";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { errorMessage } from "@/lib/error-message";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";

export function TaskInteractionRequests({ chat }: { chat: ChatSummary }) {
  const queryClient = useQueryClient();
  const resourcesLive = useAppLiveStatus() === "live";
  const idempotencyKeys = useRef(new Map<string, string>());
  const responding = useRef(false);
  const requests = useQuery({
    queryKey: ["agent-requests", chat.id, "pending"],
    queryFn: () =>
      getAgentInteractionRequests({ chatId: chat.id, status: "pending" }),
    refetchInterval: liveResourceRefreshInterval(
      resourcesLive,
      chat.status === "running" || chat.status === "waiting-for-approval"
        ? 1_000
        : 5_000,
    ),
    retry: false,
  });
  const respond = useMutation({
    mutationFn: ({
      requestId,
      response,
    }: {
      requestId: string;
      response: AgentInteractionResponse;
    }) => {
      const idempotencyKey =
        idempotencyKeys.current.get(requestId) ?? crypto.randomUUID();
      idempotencyKeys.current.set(requestId, idempotencyKey);
      return respondToAgentInteractionRequest(requestId, {
        idempotencyKey,
        response,
      });
    },
    onSuccess: (_, { requestId }) => {
      idempotencyKeys.current.delete(requestId);
      queryClient.setQueryData<AgentInteractionRequest[]>(
        ["agent-requests", chat.id, "pending"],
        (current) => current?.filter((request) => request.id !== requestId),
      );
    },
    onSettled: async () => {
      try {
        await Promise.all(
          [
            ["agent-requests", chat.id],
            ["task", chat.id],
            ["task-dashboard", chat.id],
            ["messages", chat.id],
            ["chats", chat.projectId],
            ["project-task-workload", chat.projectId],
          ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
      } finally {
        responding.current = false;
      }
    },
  });
  const pending = (requests.data ?? []).filter(
    (request) =>
      request.status === "pending" && request.provenance.chatId === chat.id,
  );
  const error = respond.error ?? requests.error;
  if (!pending.length && !error && chat.status !== "waiting-for-approval")
    return null;

  return (
    <section aria-label="Task requests" className="border-b py-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
        Action required
      </h3>
      <AgentInteractionPanel
        requests={pending}
        pendingRequestId={
          respond.isPending ? respond.variables.requestId : null
        }
        onRespond={(requestId, response) => {
          if (responding.current) return;
          responding.current = true;
          respond.mutate({ requestId, response });
        }}
      />
      {error ? (
        <p className="mb-2 break-words text-sm text-destructive" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
      {!pending.length && !error ? (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          {requests.isFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          {requests.isFetching
            ? "Loading request details…"
            : "No pending requests. Refresh to check for updates."}
        </p>
      ) : null}
      {requests.isError || !pending.length ? (
        <Button
          className="mt-2"
          disabled={requests.isFetching}
          onClick={() => void requests.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw className="size-3.5" /> Refresh requests
        </Button>
      ) : null}
    </section>
  );
}
