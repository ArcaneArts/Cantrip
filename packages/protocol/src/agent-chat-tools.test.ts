import { describe, expect, it } from "vitest";
import {
  cantripMcpChatListInputSchema,
  cantripMcpChatReadInputSchema,
  cantripMcpChatSendInputSchema,
  cantripMcpChatWaitInputSchema,
  cantripMcpToolNamesForOperations,
  cantripMcpOperationsForPermissionProfile,
  chatMessageContentSchema,
} from "./index.js";

describe("Agent chat tool contracts", () => {
  it("exposes exact tools while excluding sending from read-only profiles", () => {
    expect(
      cantripMcpToolNamesForOperations([
        "chat.list",
        "chat.read",
        "chat.wait",
        "chat.send",
      ]),
    ).toEqual(["chat_list", "chat_read", "chat_wait", "chat_send"]);
    const readOnly = cantripMcpOperationsForPermissionProfile(":read-only");
    expect(readOnly).toEqual(
      expect.arrayContaining(["chat.list", "chat.read", "chat.wait"]),
    );
    expect(readOnly).not.toContain("chat.send");
  });
  it("bounds discovery, history, waits and outbound messages", () => {
    expect(
      cantripMcpChatListInputSchema.safeParse({ limit: 101 }).success,
    ).toBe(false);
    expect(
      cantripMcpChatReadInputSchema.safeParse({
        chatId: "other",
        maxChars: 100001,
      }).success,
    ).toBe(false);
    expect(
      cantripMcpChatWaitInputSchema.safeParse({
        chatId: "other",
        afterCursor: "a".repeat(64),
        timeoutMs: 30001,
      }).success,
    ).toBe(false);
    expect(
      cantripMcpChatSendInputSchema.safeParse({
        chatId: "other",
        operationId: "bad",
        message: "Hello",
      }).success,
    ).toBe(false);
    expect(
      cantripMcpChatSendInputSchema.safeParse({
        chatId: "other",
        operationId: "11111111-1111-4111-8111-111111111111",
        message: " ",
      }).success,
    ).toBe(false);
  });
  it("preserves protected authorship without changing existing text messages", () => {
    const communication = {
      deliveryId: "11111111-1111-4111-8111-111111111111",
      sourceChatId: "main",
      sourceTitle: "Main",
      targetChatId: "fixer",
      targetTitle: "Fixer",
      direction: "received",
    };
    const content = [
      { type: "text", text: "Hello", chatCommunication: communication },
    ];
    expect(chatMessageContentSchema.parse(content)).toEqual(content);
    expect(
      chatMessageContentSchema.parse([
        { type: "text", text: "Ordinary message" },
      ]),
    ).toEqual([{ type: "text", text: "Ordinary message" }]);
  });
});
