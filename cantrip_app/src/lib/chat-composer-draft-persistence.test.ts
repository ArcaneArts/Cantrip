import type { ChatComposerDraft } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ChatComposerDraftPersistence,
  scopedChatComposerDraftPersistence,
} from "./chat-composer-draft-persistence";

const firstDraft: ChatComposerDraft = {
  text: "first",
  mode: "default",
  reasoningEffort: null,
};

describe("chat composer draft persistence", () => {
  it("coalesces pending keystrokes into the latest draft", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const persistence = new ChatComposerDraftPersistence(save, 50);

    persistence.schedule(firstDraft);
    persistence.schedule({ ...firstDraft, text: "latest" });
    await vi.advanceTimersByTimeAsync(50);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ ...firstDraft, text: "latest" });
    vi.useRealTimers();
  });

  it("serializes a clear behind an in-flight save", async () => {
    let releaseFirstSave: (() => void) | undefined;
    const saved: Array<ChatComposerDraft | null> = [];
    const persistence = new ChatComposerDraftPersistence(async (draft) => {
      saved.push(draft);
      if (saved.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        });
      }
    });

    persistence.schedule(firstDraft);
    const flushing = persistence.flush();
    await vi.waitFor(() => expect(saved).toEqual([firstDraft]));
    persistence.schedule(null);
    releaseFirstSave?.();
    await flushing;

    expect(saved).toEqual([firstDraft, null]);
  });

  it("retries an unchanged draft after a failed write", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<(draft: ChatComposerDraft | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const persistence = new ChatComposerDraftPersistence(save);
    persistence.schedule(firstDraft);

    await expect(persistence.flush()).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("shares one ordered queue across composer remounts", () => {
    const scope = {};
    const save = async () => undefined;

    expect(scopedChatComposerDraftPersistence(scope, "chat-one", save)).toBe(
      scopedChatComposerDraftPersistence(scope, "chat-one", save),
    );
    expect(
      scopedChatComposerDraftPersistence(scope, "chat-two", save),
    ).not.toBe(scopedChatComposerDraftPersistence(scope, "chat-one", save));
  });
});
