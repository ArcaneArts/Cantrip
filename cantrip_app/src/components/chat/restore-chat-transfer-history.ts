import type { ChatMessagePage } from "@/lib/chat-message-history";
import {
  CHAT_MESSAGE_MEMORY_LIMIT,
  retainLoadedChatMessageHead,
} from "@/lib/chat-message-history";

/** Read authoritative pages, not a transferred copy of conversation contents. */
export async function restoreChatTransferHistory(
  oldestSequence: number | null,
  read: (beforeSequence?: number) => Promise<ChatMessagePage>,
  signal: AbortSignal,
): Promise<ChatMessagePage> {
  signal.throwIfAborted();
  let history = await read();
  signal.throwIfAborted();
  while (
    oldestSequence !== null &&
    history.page.oldestSequence !== null &&
    history.page.oldestSequence > oldestSequence
  ) {
    const before = history.page.nextBeforeSequence;
    if (!history.page.hasMore || before === null) break;
    const older = await read(before);
    signal.throwIfAborted();
    if (
      older.page.oldestSequence === null ||
      older.page.oldestSequence >= history.page.oldestSequence
    )
      throw new Error("Chat transfer history pagination did not advance.");
    if (
      older.messages.length + history.messages.length >
      CHAT_MESSAGE_MEMORY_LIMIT
    )
      throw new Error(
        "Chat transfer history exceeds the supported transcript window.",
      );
    history = retainLoadedChatMessageHead(
      older,
      history,
      CHAT_MESSAGE_MEMORY_LIMIT,
    );
  }
  if (oldestSequence !== null) {
    const messages = history.messages.filter(
      (message) => message.sequence >= oldestSequence,
    );
    if (messages.length && messages.length !== history.messages.length) {
      history = {
        ...history,
        messages,
        page: {
          ...history.page,
          oldestSequence: messages[0]!.sequence,
          hasMore: true,
          nextBeforeSequence: messages[0]!.sequence,
          startsAtUserTurn: messages[0]!.role === "user",
        },
      };
    }
  }
  return history;
}
