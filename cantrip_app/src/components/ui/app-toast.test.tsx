import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_TOAST_AUTO_DISMISS_MS,
  APP_TOAST_VIEWPORT_CLASS_NAME,
  AppToast,
  scheduleAppToastDismiss,
} from "./app-toast";

afterEach(() => vi.unstubAllGlobals());

describe("AppToast", () => {
  it("renders errors as dismissible dark cards with a red outline", () => {
    const markup = renderToStaticMarkup(
      <AppToast
        message="Send a message before compacting this chat."
        onDismiss={() => undefined}
        title="Chat action failed"
        tone="error"
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-slot="app-toast"');
    expect(markup).toContain("bg-neutral-950/95");
    expect(markup).toContain("border-destructive/70");
    expect(markup).not.toContain("bg-destructive");
    expect(markup).toContain('aria-label="Dismiss notification"');
    expect(markup).toContain("Send a message before compacting this chat.");
  });

  it("keeps the notification viewport inside every mobile safe area", () => {
    expect(APP_TOAST_VIEWPORT_CLASS_NAME).toContain("safe-area-inset-top");
    expect(APP_TOAST_VIEWPORT_CLASS_NAME).toContain("safe-area-inset-right");
    expect(APP_TOAST_VIEWPORT_CLASS_NAME).toContain("safe-area-inset-bottom");
    expect(APP_TOAST_VIEWPORT_CLASS_NAME).toContain("safe-area-inset-left");
  });

  it("automatically dismisses after a short default window", () => {
    const scheduled: Array<() => void> = [];
    const clearTimeout = vi.fn();
    const setTimeout = vi.fn((callback: () => void, delay: number) => {
      scheduled.push(callback);
      expect(delay).toBe(APP_TOAST_AUTO_DISMISS_MS);
      return 42;
    });
    vi.stubGlobal("window", { clearTimeout, setTimeout });
    const onDismiss = vi.fn();

    const cancel = scheduleAppToastDismiss(
      onDismiss,
      APP_TOAST_AUTO_DISMISS_MS,
    );
    expect(APP_TOAST_AUTO_DISMISS_MS).toBe(6_000);
    expect(setTimeout).toHaveBeenCalledOnce();

    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(onDismiss).toHaveBeenCalledOnce();

    cancel();
    expect(clearTimeout).toHaveBeenCalledWith(42);
  });

  it("allows auto-dismiss to be disabled", () => {
    const setTimeout = vi.fn();
    vi.stubGlobal("window", { clearTimeout: vi.fn(), setTimeout });

    scheduleAppToastDismiss(() => undefined, 0)();
    expect(setTimeout).not.toHaveBeenCalled();
  });
});
