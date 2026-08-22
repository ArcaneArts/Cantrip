import { CHAT_MESSAGE_PAGE_BOUNDARY_MAX } from "@cantrip/protocol";

export { CHAT_MESSAGE_PAGE_BOUNDARY_MAX };

export interface ChatMessagePageHeader {
  role: string;
  sequence: number;
}

export function selectChatMessagePageWindow(
  headersNewestFirst: readonly ChatMessagePageHeader[],
  requestedLimit: number,
): {
  hasMore: boolean;
  selected: ChatMessagePageHeader[];
  startsAtUserTurn: boolean;
} {
  if (headersNewestFirst.length === 0) {
    return { hasMore: false, selected: [], startsAtUserTurn: true };
  }
  const nominalCount = Math.min(requestedLimit, headersNewestFirst.length);
  const boundarySearchLimit = Math.min(
    headersNewestFirst.length,
    CHAT_MESSAGE_PAGE_BOUNDARY_MAX,
  );
  let selectedCount = nominalCount;
  let startsAtUserTurn = headersNewestFirst[nominalCount - 1]?.role === "user";
  if (!startsAtUserTurn) {
    for (let index = nominalCount; index < boundarySearchLimit; index += 1) {
      if (headersNewestFirst[index]?.role === "user") {
        selectedCount = index + 1;
        startsAtUserTurn = true;
        break;
      }
    }
  }
  return {
    hasMore: headersNewestFirst.length > selectedCount,
    selected: headersNewestFirst.slice(0, selectedCount),
    startsAtUserTurn,
  };
}
