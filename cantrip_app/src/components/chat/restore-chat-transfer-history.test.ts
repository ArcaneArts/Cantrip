import { expect, it, vi } from "vitest";
import type { ChatMessagePage } from "@/lib/chat-message-history";
import { restoreChatTransferHistory } from "./restore-chat-transfer-history";

function page(start: number, end: number): ChatMessagePage {
  return {
    messages: Array.from({ length: end - start + 1 }, (_, offset) => ({
      id: `message-${start + offset}`,
      chatId: "chat",
      sequence: start + offset,
      role: "user",
      content: [{ type: "text" as const, text: "Message" }],
      contextKind: "project" as const,
      worktreeId: "tree",
      scratchRootId: null,
      executionLaneId: null,
      mode: "default" as const,
      modelId: null,
      modelRouteId: null,
      providerId: null,
      providerName: null,
      providerModelName: null,
      reasoningEffort: null,
      appliedReasoningEffort: null,
      reasoningAdjusted: false,
      createdAt: "2026-10-24T00:00:00.000Z",
    })),
    page: {
      oldestSequence: start,
      newestSequence: end,
      hasMore: start > 1,
      nextBeforeSequence: start > 1 ? start : null,
      startsAtUserTurn: true,
    },
  };
}
it("reads missing history and trims extra prefix rows to preserve scroll coordinates", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(10, 12))
    .mockResolvedValueOnce(page(5, 9));
  const history = await restoreChatTransferHistory(
    7,
    read,
    new AbortController().signal,
  );
  expect(read.mock.calls).toEqual([[], [10]]);
  expect(history.messages.map(({ sequence }) => sequence)).toEqual([
    7, 8, 9, 10, 11, 12,
  ]);
  expect(history.page).toMatchObject({
    oldestSequence: 7,
    nextBeforeSequence: 7,
    hasMore: true,
  });
});
it("does not fetch older pages for a new transcript", async () => {
  const read = vi.fn(async () => page(10, 12));
  expect(
    (await restoreChatTransferHistory(null, read, new AbortController().signal))
      .messages,
  ).toHaveLength(3);
  expect(read).toHaveBeenCalledOnce();
});
it("rejects actual nonadvancing pagination and aborts before reading more pages", async () => {
  const read = vi.fn(async () => page(10, 12));
  await expect(
    restoreChatTransferHistory(1, read, new AbortController().signal),
  ).rejects.toThrow("did not advance");
  const controller = new AbortController();
  const abortedRead = vi.fn(async () => {
    controller.abort();
    return page(10, 12);
  });
  await expect(
    restoreChatTransferHistory(1, abortedRead, controller.signal),
  ).rejects.toThrow();
  expect(abortedRead).toHaveBeenCalledOnce();
});
