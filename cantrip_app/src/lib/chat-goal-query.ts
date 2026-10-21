import type { ChatSummary } from "@cantrip/protocol";
import { queryOptions } from "@tanstack/react-query";
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
      query.state.status === "error" ||
      query.state.data?.goal?.status === "active" ||
      status === "running" ||
      status === "waiting-for-approval"
        ? 3_000
        : 30_000,
  });
}
