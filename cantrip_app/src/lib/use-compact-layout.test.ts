import { describe, expect, it } from "vitest";

import {
  shouldUseCompactLayout,
  shouldUseSidebarDrawer,
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

  it("uses a sidebar drawer for narrow primary windows across runtimes", () => {
    expect(shouldUseSidebarDrawer(true, false)).toBe(true);
    expect(shouldUseSidebarDrawer(false, false)).toBe(false);
    expect(shouldUseSidebarDrawer(true, true)).toBe(false);
  });
});
