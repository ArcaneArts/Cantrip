import { describe, expect, it } from "vitest";

import { updateChatConsoleOpenChats } from "./chat-console-state";

describe("chat console state", () => {
  it("remembers the CLI surface independently for each chat across tab switches", () => {
    const firstChatOpen = updateChatConsoleOpenChats(
      new Set(),
      "chat-one",
      true,
    );
    const whileViewingGit = firstChatOpen;
    const secondChatOpen = updateChatConsoleOpenChats(
      whileViewingGit,
      "chat-two",
      true,
    );
    const firstChatClosed = updateChatConsoleOpenChats(
      secondChatOpen,
      "chat-one",
      false,
    );

    expect(whileViewingGit.has("chat-one")).toBe(true);
    expect([...secondChatOpen]).toEqual(["chat-one", "chat-two"]);
    expect(firstChatClosed.has("chat-one")).toBe(false);
    expect(firstChatClosed.has("chat-two")).toBe(true);
  });

  it("does not open a chat when closing an unseen console", () => {
    expect(
      updateChatConsoleOpenChats(new Set(), "new-chat", false).has("new-chat"),
    ).toBe(false);
  });
});
