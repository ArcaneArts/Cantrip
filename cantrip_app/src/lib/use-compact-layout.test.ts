import { describe, expect, it } from "vitest";

import {
  shouldUseCompactLayout,
  shouldUseDesktopSidebarDrawer,
} from "./use-compact-layout";

describe("compact layout runtime boundary", () => {
  it("uses the compact shell for narrow web browsers", () => {
    expect(shouldUseCompactLayout(true, false)).toBe(true);
  });

  it("keeps wide web browsers on the desktop shell", () => {
    expect(shouldUseCompactLayout(false, false)).toBe(false);
  });

  it("keeps narrow Tauri windows on the desktop shell", () => {
    expect(shouldUseCompactLayout(true, true)).toBe(false);
  });

  it("uses a sidebar drawer only for narrow primary Tauri windows", () => {
    expect(shouldUseDesktopSidebarDrawer(true, true, false)).toBe(true);
    expect(shouldUseDesktopSidebarDrawer(false, true, false)).toBe(false);
    expect(shouldUseDesktopSidebarDrawer(true, false, false)).toBe(false);
    expect(shouldUseDesktopSidebarDrawer(true, true, true)).toBe(false);
  });
});
