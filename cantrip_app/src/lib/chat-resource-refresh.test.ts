import { describe, expect, it } from "vitest";

import { chatResourceRefreshIntervalMs } from "./chat-resource-refresh";

describe("chatResourceRefreshIntervalMs", () => {
  it("keeps active turns fresh even while the live event stream is healthy", () => {
    expect(chatResourceRefreshIntervalMs("running", true)).toBe(3_000);
    expect(chatResourceRefreshIntervalMs("waiting-for-approval", true)).toBe(
      3_000,
    );
  });

  it("uses a slow safety refresh for idle live chats", () => {
    expect(chatResourceRefreshIntervalMs("idle", true)).toBe(30_000);
  });

  it("refreshes more often while the live event stream is degraded", () => {
    expect(chatResourceRefreshIntervalMs("idle", false)).toBe(10_000);
    expect(chatResourceRefreshIntervalMs("failed", false)).toBe(10_000);
  });
});
