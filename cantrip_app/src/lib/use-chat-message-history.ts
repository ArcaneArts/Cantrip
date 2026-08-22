import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { getMessagePage } from "./api";
import {
  CHAT_MESSAGE_CACHE_GC_MS,
  CHAT_MESSAGE_MEMORY_LIMIT,
  EMPTY_CHAT_MESSAGE_LIVE_OVERLAY,
  chatMessageLiveQueryKey,
  chatMessageOlderPagesQueryKey,
  chatMessagePagesQueryKey,
  mergeChatMessageHistory,
  scheduleWhenIdle,
  type ChatMessagePage,
} from "./chat-message-history";

interface UseChatMessageHistoryOptions {
  autoLoadOlder?: boolean;
  chatId: string;
  enabled?: boolean;
  maxCachedMessages?: number;
  refetchInterval?:
    | false
    | number
    | ((messages: import("@cantrip/protocol").ChatMessage[]) => false | number);
}

export function useChatMessageHistory({
  autoLoadOlder = false,
  chatId,
  enabled = true,
  maxCachedMessages = CHAT_MESSAGE_MEMORY_LIMIT,
  refetchInterval = false,
}: UseChatMessageHistoryOptions) {
  const autoLoadedChatRef = useRef<string | null>(null);
  const live = useQuery({
    enabled: false,
    gcTime: CHAT_MESSAGE_CACHE_GC_MS,
    initialData: EMPTY_CHAT_MESSAGE_LIVE_OVERLAY,
    queryKey: chatMessageLiveQueryKey(chatId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const head = useQuery({
    enabled,
    gcTime: CHAT_MESSAGE_CACHE_GC_MS,
    queryFn: ({ signal }) => getMessagePage(chatId, { signal }),
    queryKey: chatMessagePagesQueryKey(chatId),
    refetchInterval:
      typeof refetchInterval === "function"
        ? (query) => refetchInterval(query.state.data?.messages ?? [])
        : refetchInterval,
  });
  const historyCursor = head.data?.page.nextBeforeSequence ?? null;
  const older = useInfiniteQuery({
    enabled: false,
    gcTime: CHAT_MESSAGE_CACHE_GC_MS,
    initialPageParam: historyCursor ?? undefined,
    queryKey: chatMessageOlderPagesQueryKey(chatId, historyCursor ?? 0),
    queryFn: ({ pageParam, signal }) =>
      getMessagePage(chatId, { beforeSequence: pageParam, signal }),
    getNextPageParam: (lastPage, allPages) => {
      const loaded =
        (head.data?.messages.length ?? 0) +
        allPages.reduce((count, page) => count + page.messages.length, 0);
      return loaded >= maxCachedMessages
        ? undefined
        : (lastPage.page.nextBeforeSequence ?? undefined);
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const pages = useMemo<ChatMessagePage[]>(
    () => [...(head.data ? [head.data] : []), ...(older.data?.pages ?? [])],
    [head.data, older.data?.pages],
  );
  const data = useMemo(
    () => mergeChatMessageHistory(pages, live.data, maxCachedMessages),
    [live.data, maxCachedMessages, pages],
  );
  const hasOlder =
    historyCursor !== null &&
    (older.data === undefined || older.hasNextPage === true);
  const fetchOlder = useCallback(async () => {
    if (!hasOlder || older.isFetching) return;
    if (older.data === undefined) {
      await older.refetch();
    } else {
      await older.fetchNextPage();
    }
  }, [
    hasOlder,
    older.data,
    older.fetchNextPage,
    older.isFetching,
    older.refetch,
  ]);

  useEffect(() => {
    if (
      !autoLoadOlder ||
      !hasOlder ||
      older.isFetching ||
      autoLoadedChatRef.current === chatId
    ) {
      return;
    }
    return scheduleWhenIdle(() => {
      autoLoadedChatRef.current = chatId;
      void fetchOlder();
    });
  }, [autoLoadOlder, chatId, fetchOlder, hasOlder, older.isFetching]);

  return {
    data,
    fetchOlder,
    hasOlder,
    isFetching: head.isFetching || older.isFetching,
    isFetchingOlder: older.isFetching,
    isLoading: head.isLoading,
    refetch: head.refetch,
  };
}
