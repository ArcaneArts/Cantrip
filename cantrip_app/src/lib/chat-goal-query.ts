import type { ChatSummary } from "@cantrip/protocol";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getChatGoal } from "./api/chats";

export function chatGoalQueryOptions(
  chatId: string,
  status: ChatSummary["status"],
) {
  return queryOptions({
    queryKey: ["goal", chatId],
    queryFn: () => getChatGoal(chatId),
    retry: 2,
    // A queued goal can start after submission returns. Native goal changes
    // are not guaranteed to arrive over the transcript's live subscription.
    refetchInterval: (query) =>
      query.state.status === "error"
        ? 30_000
        : query.state.data?.goal?.status === "active" ||
            status === "running" ||
            status === "waiting-for-approval"
          ? 3_000
          : 30_000,
  });
}

/** Keep lookup failures for a known unfinished goal visible during retries. */
export function useChatGoalQuery(
  chatId: string,
  status: ChatSummary["status"],
  enabled: boolean,
) {
  const query = useQuery({ ...chatGoalQueryOptions(chatId, status), enabled });
  const [failure, setFailure] = useState<{
    chatId: string;
    error: Error;
  } | null>(null);
  useEffect(() => {
    if (query.isError) setFailure({ chatId, error: query.error });
    else if (query.isSuccess) setFailure(null);
  }, [chatId, query.isError, query.isSuccess, query.error]);
  return {
    ...query,
    // Discover goals in every agent chat, but a failed discovery is not a
    // failure of a goal the user never created or already finished.
    // Keep polling for recovery and externally created goals.
    statusError:
      !enabled || !query.data?.goal || query.data.goal.status === "complete"
        ? null
        : (query.error ??
          (query.isPending && failure?.chatId === chatId
            ? failure.error
            : null)),
  };
}
