import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_COMPOSER_NOTICE_AUTO_DISMISS_MS,
  ChatComposerNotice,
  scheduleChatComposerNoticeDismiss,
} from "./chat-composer-notice";

afterEach(() => vi.unstubAllGlobals());

describe("ChatComposerNotice", () => {
  it("renders active work as an in-chat status above the composer", () => {
    const markup = renderToStaticMarkup(
      <ChatComposerNotice loading message="Compacting conversation context…" />,
    );

    expect(markup).toContain('data-slot="chat-composer-notice"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Compacting conversation context…");
    expect(markup).toContain("animate-spin");
  });

  it("uses restrained semantic colors for completed and actionable notices", () => {
    const successMarkup = renderToStaticMarkup(
      <ChatComposerNotice message="Latest response copied." tone="success" />,
    );
    const warningMarkup = renderToStaticMarkup(
      <ChatComposerNotice
        message="This model may not accept image input."
        tone="warning"
      />,
    );

    expect(successMarkup).toContain("text-emerald-700");
    expect(warningMarkup).toContain("text-amber-700");
  });

  it("schedules one-shot notices to disappear", () => {
    const scheduled: Array<() => void> = [];
    const clearTimeout = vi.fn();
    const setTimeout = vi.fn((callback: () => void, delay: number) => {
      scheduled.push(callback);
      expect(delay).toBe(CHAT_COMPOSER_NOTICE_AUTO_DISMISS_MS);
      return 42;
    });
    vi.stubGlobal("window", { clearTimeout, setTimeout });
    const onDismiss = vi.fn();

    const cancel = scheduleChatComposerNoticeDismiss(onDismiss);
    expect(CHAT_COMPOSER_NOTICE_AUTO_DISMISS_MS).toBe(4_000);
    expect(setTimeout).toHaveBeenCalledOnce();

    scheduled[0]!();
    expect(onDismiss).toHaveBeenCalledOnce();

    cancel();
    expect(clearTimeout).toHaveBeenCalledWith(42);
  });
});
