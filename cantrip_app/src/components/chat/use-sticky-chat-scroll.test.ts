import { describe, expect, it } from "vitest";

import {
  CHAT_FOLLOW_THRESHOLD_PX,
  chatScrollDistanceFromBottom,
  chatScrollIsNearBottom,
} from "./use-sticky-chat-scroll";

describe("sticky chat scrolling", () => {
  it("measures the remaining scroll distance without returning negatives", () => {
    expect(
      chatScrollDistanceFromBottom({
        clientHeight: 600,
        scrollHeight: 1_500,
        scrollTop: 700,
      }),
    ).toBe(200);
    expect(
      chatScrollDistanceFromBottom({
        clientHeight: 600,
        scrollHeight: 1_000,
        scrollTop: 500,
      }),
    ).toBe(0);
  });

  it("follows output only while the reader remains near the bottom", () => {
    expect(
      chatScrollIsNearBottom({
        clientHeight: 600,
        scrollHeight: 1_500,
        scrollTop: 1_500 - 600 - CHAT_FOLLOW_THRESHOLD_PX,
      }),
    ).toBe(true);
    expect(
      chatScrollIsNearBottom({
        clientHeight: 600,
        scrollHeight: 1_500,
        scrollTop: 1_500 - 600 - CHAT_FOLLOW_THRESHOLD_PX - 1,
      }),
    ).toBe(false);
  });
});
