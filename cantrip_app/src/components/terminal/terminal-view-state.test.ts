import { describe, expect, it, vi } from "vitest";
import {
  captureTerminalViewState,
  restoreTerminalViewState,
  parseTerminalViewState,
} from "./terminal-view-state";

function fixture() {
  const view = {
    cols: 80,
    rows: 42,
    buffer: {
      active: {
        type: "normal",
        viewportY: 12,
        baseY: 20,
        length: 44,
        getLine: (y: number) =>
          y < 44
            ? {
                isWrapped: false,
                length: 80,
                getCell: (x: number) => ({
                  getWidth: () => 1,
                  getChars: () => (x === 0 ? String(y) : "a"),
                }),
              }
            : undefined,
      },
    },
    getSelectionPosition: () => ({
      start: { x: 3, y: 12 },
      end: { x: 7, y: 13 },
    }),
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    select: vi.fn(),
    clearSelection: vi.fn(),
  };
  return {
    view,
    target: view as unknown as Parameters<typeof captureTerminalViewState>[0],
  };
}
describe("terminal view state", () => {
  it("preserves source rows and accepts legacy snapshots without them", () => {
    const { target } = fixture();
    const state = captureTerminalViewState(target, "terminal", "worker");
    expect(state.rows).toBe(42);
    expect(
      parseTerminalViewState({ ...state, rows: undefined }).rows,
    ).toBeUndefined();
    for (const rows of [0, -1, 1.5, Infinity, "42"]) {
      expect(() => parseTerminalViewState({ ...state, rows })).toThrow(
        /Invalid terminal view state/,
      );
    }
  });
  it("preserves validated anchor context across transport parsing", () => {
    const { target } = fixture();
    const state = captureTerminalViewState(target, "terminal", "worker");
    const start = {
      ...state.anchors!.start!,
      before: { text: "context", distance: 2 },
    };
    const input = { ...state, anchors: { ...state.anchors!, start } };
    expect(parseTerminalViewState(input).anchors!.start).toEqual(start);
    for (const distance of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseTerminalViewState({
          ...input,
          anchors: {
            ...input.anchors,
            start: { ...start, before: { text: "context", distance } },
          },
        }),
      ).toThrow(/Invalid terminal view state/);
    }
  });
  it("restores selection and viewport onto reflowed logical lines", () => {
    const { view, target } = fixture();
    const state = captureTerminalViewState(target, "terminal", "worker");
    const originalLine = view.buffer.active.getLine;
    view.cols = 40;
    view.buffer.active.length = 88;
    view.buffer.active.baseY = 40;
    view.buffer.active.getLine = (y: number) => {
      const line = originalLine(Math.floor(y / 2));
      if (!line) return undefined;
      return {
        isWrapped: y % 2 === 1,
        length: 40,
        getCell: (x: number) => line.getCell(x + (y % 2) * 40),
      };
    };
    restoreTerminalViewState(target, state, "terminal", "worker");
    expect(view.scrollToLine).toHaveBeenCalledWith(24);
    expect(view.select).toHaveBeenCalledWith(3, 24, 84);
  });
  it("captures independent state and restores scroll and multi-row selection after hydration", () => {
    const { view, target } = fixture();
    const state = captureTerminalViewState(target, "terminal", "worker");
    view.buffer.active.viewportY = 20;
    restoreTerminalViewState(target, state, "terminal", "worker");
    expect(view.scrollToLine).toHaveBeenCalledWith(12);
    expect(view.select).toHaveBeenCalledWith(3, 12, 84);
    expect(state.viewportY).toBe(12);
  });
  it("continues following output when the source was at the bottom", () => {
    const { view, target } = fixture();
    view.buffer.active.viewportY = 20;
    const state = captureTerminalViewState(target, "terminal", "worker");
    restoreTerminalViewState(
      target,
      { ...state, selection: null },
      "terminal",
      "worker",
    );
    expect(view.scrollToBottom).toHaveBeenCalledOnce();
    expect(view.select).not.toHaveBeenCalled();
  });
  it("rejects cross-session state before changing the destination", () => {
    const { view, target } = fixture();
    const state = captureTerminalViewState(target, "terminal", "worker");
    expect(() =>
      restoreTerminalViewState(target, state, "other", "worker"),
    ).toThrow(/another session/);
    expect(() =>
      restoreTerminalViewState(target, state, "terminal", "other"),
    ).toThrow(/another session/);
    expect(view.scrollToLine).not.toHaveBeenCalled();
    expect(view.clearSelection).not.toHaveBeenCalled();
  });
  it("rejects invalid ranges and refuses to select unrelated cells after column reflow", () => {
    const { view, target } = fixture();
    const state = captureTerminalViewState(target, "terminal", "worker");
    expect(() => parseTerminalViewState({ ...state, viewportY: -1 })).toThrow();
    expect(() =>
      parseTerminalViewState({
        ...state,
        selection: { start: { x: 2, y: 12 }, end: { x: 1, y: 11 } },
      }),
    ).toThrow();
    view.cols = 40;
    expect(() =>
      restoreTerminalViewState(
        target,
        { ...state, anchors: undefined },
        "terminal",
        "worker",
      ),
    ).toThrow(/remapping/);
    expect(view.select).not.toHaveBeenCalled();
    expect(view.scrollToLine).not.toHaveBeenCalled();
    expect(view.scrollToBottom).not.toHaveBeenCalled();
    expect(view.clearSelection).not.toHaveBeenCalled();
  });
  it("leaves destination state intact when hydration has lost selected rows", () => {
    const { view, target } = fixture();
    const state = captureTerminalViewState(target, "terminal", "worker");
    view.buffer.active.length = 13;
    expect(() =>
      restoreTerminalViewState(target, state, "terminal", "worker"),
    ).toThrow(/missing/);
    expect(view.scrollToLine).not.toHaveBeenCalled();
    expect(view.clearSelection).not.toHaveBeenCalled();
    expect(view.select).not.toHaveBeenCalled();
  });
  it("restores a scroll-only snapshot after a column change", () => {
    const { view, target } = fixture();
    view.buffer.active.viewportY = 20;
    const state = captureTerminalViewState(target, "terminal", "worker");
    view.cols = 40;
    restoreTerminalViewState(
      target,
      { ...state, selection: null },
      "terminal",
      "worker",
    );
    expect(view.scrollToBottom).toHaveBeenCalledOnce();
    expect(view.clearSelection).toHaveBeenCalledOnce();
    expect(view.select).not.toHaveBeenCalled();
  });
});
