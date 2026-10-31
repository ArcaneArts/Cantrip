// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorDocumentSession } from "./document-session";
import { NativeCodeEditor } from "./native-code-editor";
import { useSyntaxHighlighting } from "./use-syntax-highlighting";
import { saveCodeEditorLineNumbers } from "@/lib/code-editor-preferences";

vi.mock("./use-syntax-highlighting", () => ({
  useSyntaxHighlighting: vi.fn(() => new Map()),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  window.localStorage.clear();
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

it.each([false, true])(
  "toggles line numbers without replacing the input or losing the draft (readOnly: %s)",
  async (readOnly) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const session = new EditorDocumentSession("file", "const value = 1;", "v1");
    session.edit("const value = 2;");
    session.selection = { start: 6, end: 11, direction: "backward" };
    const ready = vi.fn();
    try {
      await act(async () =>
        root.render(
          <NativeCodeEditor
            session={session}
            path="file.ts"
            readOnly={readOnly}
            onReady={ready}
          />,
        ),
      );
      const input = container.querySelector("textarea")!;
      const before = session.captureRecovery();
      expect(container.querySelector(".cantrip-editor-gutter")).not.toBeNull();
      await act(async () => saveCodeEditorLineNumbers(false));
      expect(container.querySelector(".cantrip-editor-gutter")).toBeNull();
      expect(container.querySelector("textarea")).toBe(input);
      expect(input.value).toBe(before.text);
      expect([
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ]).toEqual([6, 11, "backward"]);
      await act(async () => saveCodeEditorLineNumbers(true));
      expect(container.querySelector(".cantrip-editor-gutter")).not.toBeNull();
      expect(container.querySelector("textarea")).toBe(input);
      expect(session.captureRecovery()).toEqual(before);
      expect(ready).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
    }
  },
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("leaves the paint DOM untouched when an idle parent rerenders", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const session = new EditorDocumentSession("file", "const value = 1;", "v1");
  const colors = new Map([
    [
      1,
      {
        number: 1,
        text: session.text,
        tokens: [
          { from: 0, to: 5, kind: "keyword" as const },
          { from: 5, to: session.text.length, kind: "text" as const },
        ],
      },
    ],
  ]);
  vi.mocked(useSyntaxHighlighting).mockReturnValue(colors);
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) =>
    mutations.push(...records),
  );
  try {
    await act(async () =>
      root.render(<NativeCodeEditor session={session} path="file.ts" />),
    );
    const span = container.querySelector(".syntax-keyword");
    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    for (let i = 0; i < 5; i++)
      await act(async () =>
        root.render(
          <NativeCodeEditor
            session={session}
            path="file.ts"
            onSave={() => {}}
          />,
        ),
      );
    expect([...mutations, ...observer.takeRecords()]).toEqual([]);
    expect(container.querySelector(".syntax-keyword")).toBe(span);
    expect(container.querySelector("textarea")!.defaultValue).toBe("");
  } finally {
    observer.disconnect();
    await act(async () => root.unmount());
    vi.mocked(useSyntaxHighlighting).mockImplementation(() => new Map());
  }
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
