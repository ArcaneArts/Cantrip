import { describe, expect, it } from "vitest";

import { standaloneChatFileDownloadsVisible } from "./standalone-chat-file-locality";

describe("standalone Chat file locality", () => {
  it("shows downloads only when locality has not been proven", () => {
    expect(standaloneChatFileDownloadsVisible(false)).toBe(true);
    expect(standaloneChatFileDownloadsVisible(true)).toBe(false);
  });
});
