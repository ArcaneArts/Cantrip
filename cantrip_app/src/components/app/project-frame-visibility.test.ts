import { describe, expect, it } from "vitest";

import { projectFrameVisible } from "./project-frame-visibility";

const visibleProjectFrame = {
  desktopProjectFrame: true,
  mobileProjectSelectorOpen: false,
  showArchivedStandaloneChats: false,
  showImporter: false,
  showProjectSettings: false,
  showServerAdmin: false,
  showSettings: false,
} as const;

describe("project frame visibility", () => {
  it("keeps the workspace visible behind the Overview dialog", () => {
    const state = { ...visibleProjectFrame, showProjectOverview: true };
    expect(projectFrameVisible(state)).toBe(true);
  });

  it.each(["showSettings", "showProjectSettings"] as const)(
    "hides panes and rails while %s owns the content area",
    (setting) => {
      expect(
        projectFrameVisible({ ...visibleProjectFrame, [setting]: true }),
      ).toBe(false);
    },
  );
});
