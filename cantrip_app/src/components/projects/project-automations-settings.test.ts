import { describe, expect, it } from "vitest";

import { availableProjectAutomationConditionModes } from "./project-automations-settings";

describe("project automation condition authoring", () => {
  it("keeps scripts available while hiding GitHub issue conditions for folders", () => {
    expect(availableProjectAutomationConditionModes(false)).toEqual([
      "none",
      "script",
    ]);
    expect(availableProjectAutomationConditionModes(true)).toContain(
      "open-issues",
    );
  });
});
