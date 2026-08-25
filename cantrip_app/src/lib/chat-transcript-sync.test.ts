import { describe, expect, it } from "vitest";

import { shouldSyncChatWithExternalConsole } from "./chat-transcript-sync";

describe("chat transcript external console sync", () => {
  it("never synchronizes standalone Chat with a project Codex console", () => {
    expect(shouldSyncChatWithExternalConsole("standalone", true)).toBe(false);
    expect(shouldSyncChatWithExternalConsole("standalone", false)).toBe(false);
  });

  it("preserves external console sync for IDE project chats", () => {
    expect(shouldSyncChatWithExternalConsole("project", true)).toBe(true);
    expect(shouldSyncChatWithExternalConsole("project", false)).toBe(false);
  });
});
