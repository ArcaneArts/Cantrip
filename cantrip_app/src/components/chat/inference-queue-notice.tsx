import type {
  ModelProviderSummary,
  WorkerInferenceStatus,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getSettings } from "@/lib/api/settings";
import { useWorkerInference } from "@/lib/worker-inference";

export function useChatInferenceQueue({
  chatId,
  workerId,
  enabled = true,
}: {
  chatId: string;
  workerId: string | null;
  enabled?: boolean;
}) {
  const query = useWorkerInference({
    workerId,
    enabled,
    select: useCallback(
      (status: WorkerInferenceStatus) => {
        for (const pool of status.pools) {
          const operation = pool.operations.find(
            (operation) =>
              operation.chatId === chatId &&
              operation.state === "waiting" &&
              (operation.purpose === "turn" || operation.purpose === "label"),
          );
          if (operation?.queuePosition)
            return {
              providerId: pool.providerId,
              queuePosition: operation.queuePosition,
              activeCount: pool.activeCount,
              limit: pool.maxConcurrentInference,
              purpose: operation.purpose,
            };
        }
        return null;
      },
      [chatId],
    ),
  });
  // Read only selected data/error, not dataUpdatedAt or unrelated query fields.
  return { data: enabled && !query.isError ? query.data : undefined };
}

type Queue = ReturnType<typeof useChatInferenceQueue>["data"];

export function InferenceQueueNotice({
  queue,
  providers,
  onCancel,
  cancelPending = false,
}: {
  queue: Queue;
  providers?: readonly ModelProviderSummary[];
  onCancel?(): void;
  cancelPending?: boolean;
}) {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    enabled: Boolean(queue) && providers === undefined,
  });
  if (!queue) return null;
  const provider = (providers ?? settings.data?.providers)?.find(
    ({ id }) => id === queue.providerId,
  );
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs text-muted-foreground"
    >
      <Clock3 className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Queued · #{queue.queuePosition}
        {provider ? ` for ${provider.name}` : " for provider capacity"} ·{" "}
        {queue.activeCount} of {queue.limit} slots in use. Starts automatically
        when capacity is available.
        {queue.purpose === "label" ? " Waiting for chat naming." : ""}
      </span>
      {onCancel ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={cancelPending}
          onClick={onCancel}
        >
          Cancel queued turn
        </Button>
      ) : null}
    </div>
  );
}

export function ChatInferenceQueue({
  chatId,
  workerId,
  enabled,
  providers,
  onCancel,
  cancelPending,
}: {
  chatId: string;
  workerId: string | null;
  enabled: boolean;
  providers?: readonly ModelProviderSummary[];
  onCancel?(): void;
  cancelPending?: boolean;
}) {
  const queue = useChatInferenceQueue({ chatId, workerId, enabled });
  return (
    <InferenceQueueNotice
      queue={queue.data}
      providers={providers}
      onCancel={onCancel}
      cancelPending={cancelPending}
    />
  );
}
