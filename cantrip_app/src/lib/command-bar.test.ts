import { describe, expect, it } from "vitest";

import {
  advanceDoubleShiftGesture,
  commandBarScopesAfterBackspace,
  DOUBLE_SHIFT_WINDOW_MS,
  type DoubleShiftKeyInput,
} from "./command-bar";

const shift: DoubleShiftKeyInput = {
  altKey: false,
  ctrlKey: false,
  key: "Shift",
  metaKey: false,
  repeat: false,
};

describe("command bar gesture", () => {
  it("opens when Shift is pressed twice within one second", () => {
    const first = advanceDoubleShiftGesture(null, shift, 2_000);
    const second = advanceDoubleShiftGesture(first.lastShiftAt, shift, 2_999);

    expect(first.triggered).toBe(false);
    expect(second).toEqual({ lastShiftAt: null, triggered: true });
  });

  it("starts a new sequence after the double-Shift window expires", () => {
    const result = advanceDoubleShiftGesture(
      2_000,
      shift,
      2_000 + DOUBLE_SHIFT_WINDOW_MS + 1,
    );

    expect(result).toEqual({
      lastShiftAt: 2_000 + DOUBLE_SHIFT_WINDOW_MS + 1,
      triggered: false,
    });
  });

  it("cancels the sequence when another key is pressed", () => {
    const result = advanceDoubleShiftGesture(
      2_000,
      { ...shift, key: "A" },
      2_100,
    );

    expect(result).toEqual({ lastShiftAt: null, triggered: false });
  });

  it("ignores key repeats and modified Shift presses", () => {
    expect(
      advanceDoubleShiftGesture(2_000, { ...shift, repeat: true }, 2_100),
    ).toEqual({ lastShiftAt: null, triggered: false });
    expect(
      advanceDoubleShiftGesture(2_000, { ...shift, metaKey: true }, 2_100),
    ).toEqual({ lastShiftAt: null, triggered: false });
  });

  it("removes the armed nested action when Backspace has no query", () => {
    expect(
      commandBarScopesAfterBackspace(["new-project", "folder"], ""),
    ).toEqual(["new-project"]);
    expect(
      commandBarScopesAfterBackspace(["new-project", "folder"], "Cantrip"),
    ).toEqual(["new-project", "folder"]);
    expect(commandBarScopesAfterBackspace([], "")).toEqual([]);
  });
});
