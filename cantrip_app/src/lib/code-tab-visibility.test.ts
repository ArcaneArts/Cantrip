import { describe, expect, it } from "vitest";

import {
  INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE,
  isVisibleProjectCodeTab,
} from "./code-tab-visibility";

describe("project Code tab visibility", () => {
  it("keeps Explorer popout compatibility sessions out of project tabs", () => {
    expect(
      isVisibleProjectCodeTab(INTERNAL_EXPLORER_EDITOR_CODE_TAB_TITLE),
    ).toBe(false);
    expect(isVisibleProjectCodeTab("Explorer editor")).toBe(false);
  });

  it("keeps normal Code tabs visible", () => {
    expect(isVisibleProjectCodeTab("Code")).toBe(true);
  });
});
