// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EditorDocumentSession } from "./document-session";
import { NativeCodeEditor } from "./native-code-editor";

vi.mock("./use-syntax-highlighting", () => ({
  useSyntaxHighlighting: () => [],
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

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
        />,
      ),
    );
    expect(container.querySelector("textarea")).toBe(input);
    expect(input!.readOnly).toBe(false);
    expect(ready).toHaveBeenCalledOnce();
    expect(session.dirty).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});
