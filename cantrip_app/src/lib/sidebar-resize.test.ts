import { describe, expect, it } from "vitest";

import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  sidebarWidthFromKey,
  sidebarWidthFromPointer,
} from "./sidebar-resize";

describe("sidebar resizing", () => {
  it("rounds and clamps pointer widths to the supported range", () => {
    expect(sidebarWidthFromPointer(361.6, 10)).toBe(352);
    expect(sidebarWidthFromPointer(100)).toBe(MIN_SIDEBAR_WIDTH);
    expect(sidebarWidthFromPointer(700)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("supports accessible keyboard resizing", () => {
    expect(sidebarWidthFromKey(288, "ArrowLeft")).toBe(272);
    expect(sidebarWidthFromKey(288, "ArrowRight")).toBe(304);
    expect(sidebarWidthFromKey(288, "Home")).toBe(MIN_SIDEBAR_WIDTH);
    expect(sidebarWidthFromKey(288, "End")).toBe(MAX_SIDEBAR_WIDTH);
    expect(sidebarWidthFromKey(288, "Enter")).toBeNull();
  });
});
