import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  MobileTerminalCommandBar,
  mobileTerminalKeyInput,
} from "./mobile-terminal-command-bar";
import { measureMobileTerminalViewport } from "./use-mobile-terminal-keyboard";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("mobile terminal command bar", () => {
  it("renders accessible terminal actions above the keyboard", () => {
    const markup = renderToStaticMarkup(
      <MobileTerminalCommandBar
        bottomInset={312}
        onDismiss={vi.fn()}
        onKey={vi.fn()}
      />,
    );

    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain('aria-label="Terminal keyboard actions"');
    expect(markup).toContain('aria-label="Escape"');
    expect(markup).toContain('aria-label="Shift modifier"');
    expect(markup).toContain('aria-label="Arrow left"');
    expect(markup).toContain('aria-label="Arrow up"');
    expect(markup).toContain('aria-label="Arrow down"');
    expect(markup).toContain('aria-label="Arrow right"');
    expect(markup).toContain('aria-label="Dismiss keyboard"');
    expect(markup).toContain("border-t");
    expect(markup).not.toContain("shadow-[");
    expect(markup).toContain("bottom:312px");
  });

  it("offers a working keyboard dismiss action", () => {
    const onDismiss = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <MobileTerminalCommandBar
          bottomInset={0}
          onDismiss={onDismiss}
          onKey={vi.fn()}
        />,
      );
    });
    act(() =>
      renderer.root
        .findByProps({ "aria-label": "Dismiss keyboard" })
        .props.onClick(),
    );

    expect(onDismiss).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it("encodes normal, application-mode, and shifted terminal keys", () => {
    expect(mobileTerminalKeyInput("escape", false, false)).toBe("\x1b");
    expect(mobileTerminalKeyInput("arrow-up", false, false)).toBe("\x1b[A");
    expect(mobileTerminalKeyInput("arrow-up", false, true)).toBe("\x1bOA");
    expect(mobileTerminalKeyInput("arrow-left", true, true)).toBe("\x1b[1;2D");
  });
});

describe("mobile terminal keyboard viewport measurement", () => {
  it("positions the bar over an iOS overlay keyboard", () => {
    expect(
      measureMobileTerminalViewport({
        baselineHeight: 844,
        baselineWidth: 390,
        innerHeight: 844,
        viewportHeight: 497,
        viewportOffsetTop: 0,
        viewportWidth: 390,
      }),
    ).toMatchObject({
      bottomInset: 347,
      keyboardOpen: true,
      nextBaselineHeight: 844,
      visibleBottom: 497,
    });
  });

  it("detects an Android resize keyboard without adding an overlay inset", () => {
    expect(
      measureMobileTerminalViewport({
        baselineHeight: 800,
        baselineWidth: 360,
        innerHeight: 480,
        viewportHeight: 480,
        viewportOffsetTop: 0,
        viewportWidth: 360,
      }),
    ).toMatchObject({
      bottomInset: 0,
      keyboardOpen: true,
      nextBaselineHeight: 800,
      visibleBottom: 480,
    });
  });

  it("ignores browser chrome movement and resets after an orientation change", () => {
    expect(
      measureMobileTerminalViewport({
        baselineHeight: 800,
        baselineWidth: 390,
        innerHeight: 750,
        viewportHeight: 750,
        viewportOffsetTop: 0,
        viewportWidth: 390,
      }).keyboardOpen,
    ).toBe(false);

    expect(
      measureMobileTerminalViewport({
        baselineHeight: 800,
        baselineWidth: 390,
        innerHeight: 390,
        viewportHeight: 390,
        viewportOffsetTop: 0,
        viewportWidth: 844,
      }),
    ).toMatchObject({
      keyboardOpen: false,
      nextBaselineHeight: 390,
      nextBaselineWidth: 844,
    });
  });
});
