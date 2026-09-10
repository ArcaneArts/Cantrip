import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { managedChatPreparationSchema } from "@cantrip/protocol";
import { request } from "@/lib/api-client";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { Button } from "@/components/ui/button";

const snapshot = () => JSON.stringify(getClientSessionIdentitySnapshot());
const subscribe = (listener: () => void) =>
  onClientSessionIdentityChanged(listener);
export function ManagedChatPreparationStatus({
  chatId,
  projectId,
}: {
  chatId: string;
  projectId: string;
}) {
  const identityKey = useSyncExternalStore(subscribe, snapshot);
  const identity = useMemo(
    () => JSON.parse(identityKey) as ClientSessionIdentitySnapshot | null,
    [identityKey],
  );
  const client = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current += 1;
    setRetrying(false);
    setError(null);
    return () => {
      lifetime.current += 1;
    };
  }, [identityKey, chatId]);
  const path = `/api/chats/${encodeURIComponent(chatId)}/preparation`;
  const state = useQuery({
    queryKey: ["managed-chat-preparation", chatId, identity],
    enabled: Boolean(identity),
    queryFn: async ({ signal }) => {
      const result = (await request(
        path,
        { signal },
        { expectedIdentity: identity! },
      )) as { preparation: unknown };
      const preparation =
        result.preparation === null
          ? null
          : managedChatPreparationSchema.parse(result.preparation);
      if (preparation && preparation.chatId !== chatId)
        throw new Error("Preparation belongs to another chat.");
      return preparation;
    },
    retry: false,
    refetchInterval: (query) =>
      query.state.data && !["ready", "failed"].includes(query.state.data.phase)
        ? 1000
        : false,
  });
  useEffect(() => {
    if (!state.data) return;
    void client.invalidateQueries({ queryKey: ["native-settings", chatId] });
    if (state.data.phase === "ready") {
      void client.invalidateQueries({ queryKey: ["terminals", projectId] });
      void client.invalidateQueries({ queryKey: ["chats", projectId] });
    }
  }, [state.data?.phase, state.data?.generation, chatId, projectId]);
  if (!identity || (!state.data && !state.error)) return null;
  return (
    <div
      className="flex items-center gap-2 px-4 pt-2 text-xs text-muted-foreground sm:px-8 md:px-10"
      role="status"
    >
      <span>
        {state.error
          ? "Could not read session preparation."
          : {
              pending: "Preparing agent session…",
              thread: "Preparing agent session…",
              console: "Starting attached CLI…",
              ready: "Session prepared",
              failed:
                state.data?.failedPhase === "console"
                  ? "Session prepared, but the CLI is unavailable."
                  : "The agent session could not be prepared.",
            }[state.data!.phase]}
      </span>
      {state.error || state.data?.phase === "failed" ? (
        <Button
          variant="ghost"
          disabled={retrying}
          onClick={async () => {
            const generation = lifetime.current;
            setRetrying(true);
            setError(null);
            try {
              await request(
                path,
                { method: "POST" },
                { expectedIdentity: identity },
              );
              if (lifetime.current === generation) await state.refetch();
            } catch {
              if (lifetime.current === generation)
                setError(
                  "Preparation retry was not confirmed. Refresh to check its status.",
                );
            } finally {
              if (lifetime.current === generation) setRetrying(false);
            }
          }}
        >
          Retry preparation
        </Button>
      ) : null}
      {error ? <span role="alert">{error}</span> : null}
      {error ? (
        <Button variant="ghost" onClick={() => void state.refetch()}>
          Refresh
        </Button>
      ) : null}
    </div>
  );
}
