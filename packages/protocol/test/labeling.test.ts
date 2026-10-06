import { describe, expect, it } from "vitest";
import {
  labelingInstructions,
  lowestLabelingEffort,
  normalizeGeneratedLabel,
} from "../src/labeling.js";

describe("short automatic labels", () => {
  it.each(["agent", "chat"] as const)(
    "caps %s titles at three words",
    (kind) => {
      expect(
        normalizeGeneratedLabel(
          'Title: "Fix the login form without breaking anything."',
          kind,
        ),
      ).toBe("Fix the login");
      expect(labelingInstructions(kind)).toContain(
        "THREE WORDS IS THE ABSOLUTE MAXIMUM",
      );
    },
  );
  it("caps tasks at six words and removes verbosity", () => {
    expect(
      normalizeGeneratedLabel(
        "Fix workspace imports and preserve user files\nHere is why",
        "task",
      ),
    ).toBe("Fix workspace imports and preserve user");
    expect(labelingInstructions("task")).toContain(
      "SIX WORDS IS THE ABSOLUTE MAXIMUM",
    );
  });
  it.each(["", "\n", "---", "```"])("rejects unusable output %j", (raw) => {
    expect(normalizeGeneratedLabel(raw, "chat")).toBeNull();
  });
  it("preserves Unicode and bounds unspaced output", () => {
    expect(normalizeGeneratedLabel("修复 登录 界面", "chat")).toBe(
      "修复 登录 界面",
    );
    expect(
      Array.from(
        normalizeGeneratedLabel("🚀".repeat(100) + "Test", "chat") ?? "",
      ).length,
    ).toBeLessThanOrEqual(60);
  });
  it("uses only known supported effort values, in lowest-first order", () => {
    expect(lowestLabelingEffort(["high", "low", "medium"], "high")).toBe("low");
    expect(lowestLabelingEffort(["none", "minimal"], "high")).toBe("none");
    expect(
      lowestLabelingEffort(["custom-fast", "custom-deep"], "custom-fast"),
    ).toBe("custom-fast");
    expect(lowestLabelingEffort(undefined, "high")).toBe("high");
    expect(lowestLabelingEffort([], null)).toBeNull();
  });
});
