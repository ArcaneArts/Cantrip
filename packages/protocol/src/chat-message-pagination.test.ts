import { describe, expect, it } from "vitest";

import {
  CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
  CHAT_MESSAGE_PAGE_MAX_LIMIT,
  chatMessagePageQuerySchema,
  chatMessageWirePageSchema,
} from "./index.js";

describe("chat message pagination contract", () => {
  it("defaults and bounds presentation page sizes", () => {
    expect(chatMessagePageQuerySchema.parse({})).toEqual({
      limit: CHAT_MESSAGE_PAGE_DEFAULT_LIMIT,
    });
    expect(() =>
      chatMessagePageQuerySchema.parse({
        limit: CHAT_MESSAGE_PAGE_MAX_LIMIT + 1,
      }),
    ).toThrow();
  });

  it("accepts an empty encrypted page with an exhausted cursor", () => {
    expect(
      chatMessageWirePageSchema.parse({
        kind: "chat-encrypted",
        messages: [],
        page: {
          hasMore: false,
          nextBeforeSequence: null,
          oldestSequence: null,
          newestSequence: null,
          startsAtUserTurn: true,
        },
      }).page.hasMore,
    ).toBe(false);
  });
});
