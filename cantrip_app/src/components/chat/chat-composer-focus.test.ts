import { describe, expect, it, vi } from "vitest";

import { scheduleChatComposerFocus } from "./chat-composer-focus";

describe("chat composer focus", () => {
  it("focuses the current enabled composer on the next frame", () => {
    const focus = vi.fn();
    let composer: { disabled: boolean; focus: typeof focus } | null = null;
    let frame: FrameRequestCallback = () => undefined;

    scheduleChatComposerFocus(
      () => composer,
      (callback) => {
        frame = callback;
        return 1;
      },
    );
    composer = { disabled: false, focus };
    frame(0);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does not focus a missing or disabled composer", () => {
    const focus = vi.fn();
    const frames: FrameRequestCallback[] = [];
    const schedule = (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    };

    scheduleChatComposerFocus(() => null, schedule);
    scheduleChatComposerFocus(() => ({ disabled: true, focus }), schedule);
    frames.forEach((frame) => frame(0));

    expect(focus).not.toHaveBeenCalled();
  });
});
