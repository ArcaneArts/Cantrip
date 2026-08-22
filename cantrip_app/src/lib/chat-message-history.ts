import type { ChatMessage, ChatMessagePageInfo } from "@cantrip/protocol";

export const CHAT_MESSAGE_DECRYPT_CONCURRENCY = 6;
export const CHAT_MESSAGE_MEMORY_LIMIT = 10_000;
export const CHAT_MESSAGE_CACHE_GC_MS = 30 * 60 * 1_000;

export interface ChatMessagePage {
  messages: ChatMessage[];
  page: ChatMessagePageInfo;
}

export interface ChatMessageLiveOverlay {
  deletedIds: string[];
  upserts: Record<string, ChatMessage>;
}

export const EMPTY_CHAT_MESSAGE_LIVE_OVERLAY: ChatMessageLiveOverlay = {
  deletedIds: [],
  upserts: {},
};

export function chatMessagePagesQueryKey(chatId: string) {
  return ["messages", chatId, "pages"] as const;
}

export function chatMessageLiveQueryKey(chatId: string) {
  return ["message-live", chatId] as const;
}

export function chatMessageOlderPagesQueryKey(
  chatId: string,
  headCursor: number,
) {
  return ["message-history", chatId, headCursor] as const;
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await transform(values[index]!, index);
      }
    }),
  );
  return results;
}

export function upsertChatMessageLiveOverlay(
  current: ChatMessageLiveOverlay | undefined,
  message: ChatMessage,
): ChatMessageLiveOverlay {
  const overlay = current ?? EMPTY_CHAT_MESSAGE_LIVE_OVERLAY;
  return {
    deletedIds: overlay.deletedIds.filter((id) => id !== message.id),
    upserts: { ...overlay.upserts, [message.id]: message },
  };
}

export function deleteFromChatMessageLiveOverlay(
  current: ChatMessageLiveOverlay | undefined,
  messageId: string,
): ChatMessageLiveOverlay {
  const overlay = current ?? EMPTY_CHAT_MESSAGE_LIVE_OVERLAY;
  const upserts = { ...overlay.upserts };
  delete upserts[messageId];
  return {
    deletedIds: [...new Set([...overlay.deletedIds, messageId])],
    upserts,
  };
}

export function mergeChatMessageHistory(
  pagesNewestFirst: readonly ChatMessagePage[],
  overlay: ChatMessageLiveOverlay = EMPTY_CHAT_MESSAGE_LIVE_OVERLAY,
  limit = CHAT_MESSAGE_MEMORY_LIMIT,
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const page of [...pagesNewestFirst].reverse()) {
    for (const message of page.messages) byId.set(message.id, message);
  }
  const oldestLoadedSequence = Math.min(
    ...[...byId.values()].map(({ sequence }) => sequence),
  );
  for (const message of Object.values(overlay.upserts)) {
    if (
      byId.size === 0 ||
      !Number.isFinite(oldestLoadedSequence) ||
      message.sequence >= oldestLoadedSequence
    ) {
      byId.set(message.id, message);
    }
  }
  for (const id of overlay.deletedIds) byId.delete(id);
  return [...byId.values()]
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    )
    .slice(-Math.max(1, limit));
}

export function scheduleWhenIdle(callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const idleWindow = window as Window & {
    cancelIdleCallback?: (handle: number) => void;
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number },
    ) => number;
  };
  if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 1_000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 250);
  return () => window.clearTimeout(handle);
}
