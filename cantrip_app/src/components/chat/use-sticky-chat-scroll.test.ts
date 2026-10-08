import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  CHAT_FOLLOW_THRESHOLD_PX,
  chatScrollDistanceFromBottom,
  chatScrollIsNearBottom,
  useStickyScroll,
} from "./use-sticky-chat-scroll";

describe("sticky chat scrolling", () => {
  it.each([false, true])(
    "preserves the visible row during overlapping prepend and append (browser anchoring %s)",
    async (browserAnchors) => {
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      const viewport = {
        clientHeight: 100,
        scrollHeight: 1000,
        scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
      };
      let offset = 220;
      const content = {
        children: [] as unknown[],
        contains: (node: unknown) => node === anchor,
      };
      const anchor = {
        isConnected: true,
        getBoundingClientRect: () => ({
          top: offset - viewport.scrollTop,
          bottom: offset - viewport.scrollTop + 50,
        }),
      };
      content.children.push(anchor);
      vi.stubGlobal("window", {
        requestAnimationFrame: (callback: () => void) => {
          callback();
          return 1;
        },
        cancelAnimationFrame: vi.fn(),
      });
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe = vi.fn();
          disconnect = vi.fn();
        },
      );
      let scroll!: ReturnType<typeof useStickyScroll>;
      function Probe() {
        scroll = useStickyScroll("reader");
        return createElement(
          "div",
          { ref: scroll.viewportRef, onScroll: scroll.onScroll },
          createElement("div", { ref: scroll.contentRef }),
        );
      }
      let renderer!: TestRenderer.ReactTestRenderer;
      try {
        await act(async () => {
          renderer = TestRenderer.create(createElement(Probe), {
            createNodeMock: (element) =>
              (element.props as { onScroll?: unknown }).onScroll
                ? viewport
                : content,
          });
        });
        viewport.scrollTop = 200;
        await act(async () => scroll.onScroll());
        await act(async () =>
          scroll.preserveScrollDuringPrepend(async () => {
            offset += 80;
            viewport.scrollHeight += 200;
            if (browserAnchors) viewport.scrollTop += 80;
          }),
        );
        expect(anchor.getBoundingClientRect().top).toBe(20);
        expect(viewport.scrollTop).toBe(280);
        expect(scroll.showScrollToLatest).toBe(true);
      } finally {
        await act(async () => renderer.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["top", "bottom"] as const)(
    "follows the %s edge and leaves older activity readable after scrolling away",
    async (edge) => {
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      const viewport = { clientHeight: 100, scrollHeight: 800, scrollTop: 80 };
      let resize!: () => void;
      vi.stubGlobal("window", {
        requestAnimationFrame: (callback: () => void) => {
          callback();
          return 1;
        },
        cancelAnimationFrame: vi.fn(),
      });
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            resize = callback;
          }
          observe = vi.fn();
          disconnect = vi.fn();
        },
      );
      let scroll!: ReturnType<typeof useStickyScroll>;
      function Harness() {
        scroll = useStickyScroll("turn", 128, edge);
        return createElement(
          "div",
          { ref: scroll.viewportRef, onScroll: scroll.onScroll },
          createElement("div", { ref: scroll.contentRef }),
        );
      }
      let renderer!: TestRenderer.ReactTestRenderer;
      try {
        await act(async () => {
          renderer = TestRenderer.create(createElement(Harness), {
            createNodeMock: (element) =>
              (element.props as { onScroll?: unknown }).onScroll
                ? viewport
                : {},
          });
        });
        expect(viewport.scrollTop).toBe(edge === "top" ? 0 : 800);
        viewport.scrollTop = edge === "top" ? 300 : 0;
        await act(async () => scroll.onScroll());
        expect(scroll.showScrollToLatest).toBe(true);
        const readingPosition = viewport.scrollTop;
        viewport.scrollHeight += 100;
        await act(async () => resize());
        expect(viewport.scrollTop).toBe(readingPosition);
        await act(async () => scroll.scrollToLatest());
        expect(viewport.scrollTop).toBe(edge === "top" ? 0 : 900);
        expect(scroll.showScrollToLatest).toBe(false);
        viewport.scrollHeight += 100;
        await act(async () => resize());
        expect(viewport.scrollTop).toBe(edge === "top" ? 0 : 1000);
        await act(async () => renderer.unmount());
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("measures the remaining scroll distance without returning negatives", () => {
    expect(
      chatScrollDistanceFromBottom({
        clientHeight: 600,
        scrollHeight: 1_500,
        scrollTop: 700,
      }),
    ).toBe(200);
    expect(
      chatScrollDistanceFromBottom({
        clientHeight: 600,
        scrollHeight: 1_000,
        scrollTop: 500,
      }),
    ).toBe(0);
  });

  it("follows output only while the reader remains near the bottom", () => {
    expect(
      chatScrollIsNearBottom({
        clientHeight: 600,
        scrollHeight: 1_500,
        scrollTop: 1_500 - 600 - CHAT_FOLLOW_THRESHOLD_PX,
      }),
    ).toBe(true);
    expect(
      chatScrollIsNearBottom({
        clientHeight: 600,
        scrollHeight: 1_500,
        scrollTop: 1_500 - 600 - CHAT_FOLLOW_THRESHOLD_PX - 1,
      }),
    ).toBe(false);
  });
});
