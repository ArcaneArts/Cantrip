import { nativeTurnSettingsForMessages } from "./native-turn-settings-evidence";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { getMessagePage } from "./api";
import {
  CHAT_MESSAGE_CACHE_GC_MS,
  CHAT_MESSAGE_MEMORY_LIMIT,
  EMPTY_CHAT_MESSAGE_LIVE_OVERLAY,
  chatMessageLiveQueryKey,
  chatMessageProvisionalQueryKey,
  chatMessageOlderPagesQueryKey,
  chatMessagePagesQueryKey,
  chatMessageLoadedHeadQueryKey,
  mergeChatMessageHistory,
  retainLoadedChatMessageHead,
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
  const queryClient = useQueryClient();
  const loadedHeadKey = chatMessageLoadedHeadQueryKey(chatId);
  const autoLoadedChatRef = useRef<string | null>(null);
  // Keep retention subscribed for the same lifetime as the transcript. The
  // existing message-history scope reset also clears this cache on recovery.
  useQuery<ChatMessagePage>({
    enabled: false,
    subscribed: enabled,
    gcTime: CHAT_MESSAGE_CACHE_GC_MS,
    queryKey: loadedHeadKey,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const live = useQuery({
    enabled: false,
    subscribed: enabled,
    gcTime: CHAT_MESSAGE_CACHE_GC_MS,
    initialData: EMPTY_CHAT_MESSAGE_LIVE_OVERLAY,
    queryKey: chatMessageLiveQueryKey(chatId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const provisional = useQuery({
    enabled: false,
    subscribed: enabled,
    gcTime: CHAT_MESSAGE_CACHE_GC_MS,
    initialData: EMPTY_CHAT_MESSAGE_LIVE_OVERLAY,
    queryKey: chatMessageProvisionalQueryKey(chatId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const head = useQuery({
    enabled,
    subscribed: enabled,
    gcTime: CHAT_MESSAGE_CACHE_GC_MS,
    queryFn: async ({ signal }) => {
      let previous = queryClient.getQueryData<ChatMessagePage>(loadedHeadKey);
      let page = await getMessagePage(chatId, { signal });
      // A long gap between refreshes can move the server window beyond the
      // retained head. Read the actual intervening pages before joining it.
      while (
        previous?.page.newestSequence != null &&
        page.page.oldestSequence != null &&
        page.page.oldestSequence > previous.page.newestSequence + 1 &&
        page.page.hasMore &&
        page.messages.length < maxCachedMessages
      ) {
        const beforeSequence = page.page.oldestSequence;
        const bridge = await getMessagePage(chatId, { beforeSequence, signal });
        if (!bridge.messages.length) {
          previous = undefined;
          break;
        }
        if (
          bridge.page.oldestSequence == null ||
          bridge.page.oldestSequence >= beforeSequence
        )
          throw new Error("Chat history pagination did not advance.");
        page = retainLoadedChatMessageHead(bridge, page, maxCachedMessages);
      }
      signal.throwIfAborted();
      const retained = retainLoadedChatMessageHead(
        previous,
        page,
        maxCachedMessages,
      );
      queryClient.setQueryData(loadedHeadKey, retained);
      return retained;
    },
    queryKey: chatMessagePagesQueryKey(chatId),
    refetchInterval:
      typeof refetchInterval === "function"
        ? (query) => refetchInterval(query.state.data?.messages ?? [])
        : refetchInterval,
  });
  const historyCursor = head.data?.page.nextBeforeSequence ?? null;
  const older = useInfiniteQuery({
    enabled: false,
    subscribed: enabled,
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
    () =>
      mergeChatMessageHistory(
        pages,
        live.data,
        maxCachedMessages,
        provisional.data,
      ),
    [live.data, maxCachedMessages, pages, provisional.data],
  );
  const nativeTurnSettings = useMemo(
    () =>
      nativeTurnSettingsForMessages(
        data,
        pages.flatMap((page) => page.nativeTurnSettings ?? []),
      ),
    [data, pages],
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
      !enabled ||
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
  }, [autoLoadOlder, chatId, enabled, fetchOlder, hasOlder, older.isFetching]);

  return {
    data,
    nativeTurnSettings,
    fetchOlder,
    hasOlder,
    isFetching: head.isFetching || older.isFetching,
    isFetchingOlder: older.isFetching,
    isLoading: head.isLoading,
    refetch: head.refetch,
  };
}
