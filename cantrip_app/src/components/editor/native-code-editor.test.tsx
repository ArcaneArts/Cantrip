// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorDocumentSession } from "./document-session";
import { NativeCodeEditor } from "./native-code-editor";
import { useSyntaxHighlighting } from "./use-syntax-highlighting";

vi.mock("./use-syntax-highlighting", () => ({
  useSyntaxHighlighting: vi.fn(() => new Map()),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(useSyntaxHighlighting).mockClear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) =>
    clearTimeout(id),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reports readiness after installing the document into its inert DOM input", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  const session = new EditorDocumentSession("file", "saved", "v1");
  const viewChanged = vi.fn();
  session.edit("unsaved contents");
  session.selection = { start: 2, end: 7, direction: "backward" };
  session.scrollTop = 120;
  session.scrollLeft = 30;
  const ready = vi.fn((restored: EditorDocumentSession) => {
    const input = container.querySelector("textarea")!;
    expect(restored).toBe(session);
    expect(input.value).toBe("unsaved contents");
    expect([
      input.selectionStart,
      input.selectionEnd,
      input.selectionDirection,
    ]).toEqual([2, 7, "backward"]);
    expect([input.scrollTop, input.scrollLeft]).toEqual([120, 30]);
    expect(input.readOnly).toBe(true);
  });
  try {
    await act(async () =>
      root.render(
        <NativeCodeEditor
          session={session}
          path="file.ts"
          active={false}
          readOnly
          onReady={ready}
          onViewStateChange={viewChanged}
        />,
      ),
    );
    expect(ready).toHaveBeenCalledOnce();
    const input = container.querySelector("textarea");
    await act(async () =>
      root.render(
        <NativeCodeEditor
          session={session}
          path="file.ts"
          active
          onReady={ready}
          onViewStateChange={viewChanged}
        />,
      ),
    );
    expect(container.querySelector("textarea")).toBe(input);
    expect(input!.readOnly).toBe(false);
    expect(ready).toHaveBeenCalledOnce();
    expect(session.dirty).toBe(true);
    await act(async () => {
      input!.scrollTop = 180;
      input!.scrollLeft = 45;
      input!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(viewChanged).toHaveBeenCalledOnce();
    expect([session.scrollTop, session.scrollLeft]).toEqual([180, 45]);
    await act(async () =>
      input!.dispatchEvent(new Event("scroll", { bubbles: true })),
    );
    expect(viewChanged).toHaveBeenCalledOnce();
    await act(async () => {
      input!.setSelectionRange(3, 8, "backward");
      input!.dispatchEvent(new Event("select", { bubbles: true }));
    });
    expect(session.selection).toEqual({
      start: 3,
      end: 8,
      direction: "backward",
    });
    expect(viewChanged).toHaveBeenCalledTimes(2);
    await act(async () =>
      input!.dispatchEvent(new Event("select", { bubbles: true })),
    );
    expect(viewChanged).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});

it("tracks scroll paint immediately while coalescing line renders and explorer checkpoints", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const session = new EditorDocumentSession(
    "large",
    Array.from({ length: 1000 }, (_, i) => `const value${i} = ${i};`).join(
      "\n",
    ),
    "v1",
  );
  const changed = vi.fn();
  const render = (active = true) =>
    root.render(
      <NativeCodeEditor
        session={session}
        path="large.ts"
        active={active}
        onViewStateChange={changed}
      />,
    );
  try {
    await act(async () => render());
    const input = container.querySelector("textarea")!;
    const renders = vi.mocked(useSyntaxHighlighting).mock.calls.length;
    await act(async () => {
      for (let top = 1; top <= 120; top++) {
        input.scrollTop = top;
        input.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    });
    expect(session.scrollTop).toBe(120);
    expect(
      container.querySelector<HTMLElement>(".cantrip-editor-code")!.style
        .transform,
    ).toBe("translate(0px, -108px)");
    expect(vi.mocked(useSyntaxHighlighting).mock.calls).toHaveLength(renders);
    await act(async () => vi.advanceTimersByTimeAsync(16));
    expect(vi.mocked(useSyntaxHighlighting).mock.calls).toHaveLength(renders);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => {
      for (let top = 800; top <= 900; top++) {
        input.scrollTop = top;
        input.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(vi.mocked(useSyntaxHighlighting).mock.calls).toHaveLength(
      renders + 1,
    );
    expect(changed).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => {
      input.scrollLeft = 50;
      input.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(
      container.querySelector<HTMLElement>(".cantrip-editor-code")!.style
        .transform,
    ).toContain("translate(-50px,");
    await act(async () => render(false));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(session.scrollLeft).toBe(50);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(changed).toHaveBeenCalledTimes(2);
    await act(async () => render());
    await act(async () => {
      input.scrollTop = 1600;
      input.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(session.scrollTop).toBe(1600);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
  expect(changed).toHaveBeenCalledTimes(3);
});
