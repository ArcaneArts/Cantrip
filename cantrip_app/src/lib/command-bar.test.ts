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
  it("opens when Shift is pressed twice within 250 milliseconds", () => {
    const first = advanceDoubleShiftGesture(null, shift, 2_000);
    const second = advanceDoubleShiftGesture(first.lastShiftAt, shift, 2_250);

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

  it("makes Shift start a new sequence after an intervening letter", () => {
    const first = advanceDoubleShiftGesture(null, shift, 2_000);
    const letter = advanceDoubleShiftGesture(
      first.lastShiftAt,
      { ...shift, key: "A" },
      2_100,
    );
    const nextShift = advanceDoubleShiftGesture(
      letter.lastShiftAt,
      shift,
      2_200,
    );

    expect(letter).toEqual({ lastShiftAt: null, triggered: false });
    expect(nextShift).toEqual({ lastShiftAt: 2_200, triggered: false });
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
