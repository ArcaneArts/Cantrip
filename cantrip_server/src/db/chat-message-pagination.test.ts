import { describe, expect, it } from "vitest";

import {
  CHAT_MESSAGE_PAGE_BOUNDARY_MAX,
  selectChatMessagePageWindow,
} from "./chat-message-pagination.js";

describe("selectChatMessagePageWindow", () => {
  it("extends a nominal page backward to the preceding user turn", () => {
    const result = selectChatMessagePageWindow(
      [
        { role: "assistant", sequence: 8 },
        { role: "assistant", sequence: 7 },
        { role: "assistant", sequence: 6 },
        { role: "user", sequence: 5 },
        { role: "assistant", sequence: 4 },
      ],
      2,
    );
    expect(result).toEqual({
      hasMore: true,
      selected: [
        { role: "assistant", sequence: 8 },
        { role: "assistant", sequence: 7 },
        { role: "assistant", sequence: 6 },
        { role: "user", sequence: 5 },
      ],
      startsAtUserTurn: true,
    });
  });

  it("keeps work bounded when no user boundary is available", () => {
    const headers = Array.from(
      { length: CHAT_MESSAGE_PAGE_BOUNDARY_MAX + 1 },
      (_, index) => ({ role: "assistant", sequence: 1_000 - index }),
    );
    const result = selectChatMessagePageWindow(headers, 150);
    expect(result.selected).toHaveLength(150);
    expect(result.hasMore).toBe(true);
    expect(result.startsAtUserTurn).toBe(false);
  });
});
