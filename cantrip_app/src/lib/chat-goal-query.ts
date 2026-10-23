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

/** Keep a real lookup failure visible while retry is pending, rather than
 * removing/reinserting the banner every time an empty query fetches again. */
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
    statusError: !enabled
      ? null
      : (query.error ??
        (query.isPending && failure?.chatId === chatId ? failure.error : null)),
  };
}
