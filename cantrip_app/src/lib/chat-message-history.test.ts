import type { ChatMessage } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  deleteFromChatMessageLiveOverlay,
  mapWithConcurrency,
  mergeChatMessageHistory,
  retainLoadedChatMessageHead,
  upsertChatMessageLiveOverlay,
  type ChatMessagePage,
} from "./chat-message-history";

function message(sequence: number): ChatMessage {
  return {
    id: `message-${sequence}`,
    chatId: "chat-one",
    contextKind: "project",
    worktreeId: "worktree-one",
    scratchRootId: null,
    executionLaneId: null,
    sequence,
    role: sequence % 2 === 0 ? "assistant" : "user",
    mode: "default",
    content: [{ type: "text", text: `Message ${sequence}` }],
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
    reasoningEffort: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    createdAt: "2026-08-22T00:00:00.000Z",
  };
}

function page(sequences: number[]): ChatMessagePage {
  return {
    messages: sequences.map(message),
    page: {
      hasMore: true,
      nextBeforeSequence: Math.min(...sequences),
      oldestSequence: Math.min(...sequences),
      newestSequence: Math.max(...sequences),
      startsAtUserTurn: true,
    },
  };
}

describe("chat message history", () => {
  it("retains earlier loaded rows while making the refreshed window authoritative", () => {
    const result = retainLoadedChatMessageHead(
      page([3, 4, 5, 6]),
      page([5, 7, 8]),
    );
    expect(result.messages.map((m) => m.sequence)).toEqual([3, 4, 5, 7, 8]);
    expect(result.page.nextBeforeSequence).toBe(3);
  });
  it("bounds retained rows and moves the older cursor to the actual retained boundary", () => {
    const result = retainLoadedChatMessageHead(
      page([3, 4, 5, 6]),
      page([5, 7, 8]),
      3,
    );
    expect(result.messages.map((m) => m.sequence)).toEqual([5, 7, 8]);
    expect(result.page).toMatchObject({
      oldestSequence: 5,
      nextBeforeSequence: 5,
      hasMore: true,
    });
  });
  it("drops retained rows after an authoritative rewind or another chat's response", () => {
    expect(
      retainLoadedChatMessageHead(
        page([3, 4, 5, 6]),
        page([4, 5]),
      ).messages.map((m) => m.sequence),
    ).toEqual([4, 5]);
    const other = page([7, 8]);
    other.messages = other.messages.map((m) => ({
      ...m,
      chatId: "other-chat",
    }));
    expect(
      retainLoadedChatMessageHead(page([3, 4]), other).messages.map(
        (m) => m.sequence,
      ),
    ).toEqual([7, 8]);
  });
  it("merges newest-first pages into one ascending deduplicated timeline", () => {
    expect(
      mergeChatMessageHistory([page([5, 6]), page([3, 4, 5])]).map(
        ({ sequence }) => sequence,
      ),
    ).toEqual([3, 4, 5, 6]);
  });

  it("keeps live upserts and deletions independent of page snapshots", () => {
    let overlay = upsertChatMessageLiveOverlay(undefined, message(7));
    overlay = deleteFromChatMessageLiveOverlay(overlay, "message-4");
    expect(
      mergeChatMessageHistory([page([3, 4, 5, 6])], overlay).map(
        ({ sequence }) => sequence,
      ),
    ).toEqual([3, 5, 6, 7]);
  });

  it("defers unseen historical live events until that range is loaded", () => {
    const overlay = upsertChatMessageLiveOverlay(undefined, message(2));
    expect(
      mergeChatMessageHistory([page([5, 6])], overlay).map(
        ({ sequence }) => sequence,
      ),
    ).toEqual([5, 6]);
    expect(
      mergeChatMessageHistory([page([5, 6]), page([1, 2, 3, 4])], overlay).map(
        ({ sequence }) => sequence,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("bounds asynchronous decryption concurrency without reordering results", async () => {
    let active = 0;
    let maximumActive = 0;
    const result = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7, 8],
      3,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return value * 2;
      },
    );
    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });
});
