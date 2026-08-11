import { describe, expect, it } from "vitest";

import { rowsWithoutPartiallyVisibleLastLine } from "./terminal-fit";

describe("terminal fitting", () => {
  it("removes one row when the fitted terminal crosses the visible bottom", () => {
    expect(rowsWithoutPartiallyVisibleLastLine(41, 731, 720)).toBe(40);
  });

  it("keeps every row when the fitted terminal is fully visible", () => {
    expect(rowsWithoutPartiallyVisibleLastLine(40, 716, 720)).toBe(40);
    expect(rowsWithoutPartiallyVisibleLastLine(40, 720.25, 720)).toBe(40);
  });

  it("never removes the terminal's only row", () => {
    expect(rowsWithoutPartiallyVisibleLastLine(1, 731, 720)).toBe(1);
  });
});
