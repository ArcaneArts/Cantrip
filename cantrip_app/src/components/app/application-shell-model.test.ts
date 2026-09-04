import { describe, expect, it } from "vitest";

import {
  codeAppearanceFor,
  modelDisplayName,
  preferredProjectCenterPaneId,
  projectOverviewSectionLabel,
} from "./application-shell-model";

describe("application shell model", () => {
  it("describes automatic model routing only when multiple routes are enabled", () => {
    const model = {
      name: "Cantrip Model",
      routes: [{ enabled: true }, { enabled: false }],
    } as Parameters<typeof modelDisplayName>[0];
    expect(modelDisplayName(model)).toBe("Cantrip Model");

    expect(
      modelDisplayName({
        ...model,
        routes: [{ enabled: true }, { enabled: true }],
      } as Parameters<typeof modelDisplayName>[0]),
    ).toBe("Cantrip Model · Auto (2 routes)");
  });

  it("uses the product label for pull requests", () => {
    expect(projectOverviewSectionLabel("prs")).toBe("Pull requests");
    expect(projectOverviewSectionLabel("issues")).toBe("Issues");
  });

  it("targets the focused center pane and falls back to the first center pane", () => {
    const layout = {
      panes: [
        { id: "center-a", region: "center" },
        { id: "right", region: "right" },
        { id: "center-b", region: "center" },
      ],
    } as Parameters<typeof preferredProjectCenterPaneId>[0];

    expect(preferredProjectCenterPaneId(layout, "center-b")).toBe("center-b");
    expect(preferredProjectCenterPaneId(layout, "right")).toBe("center-a");
    expect(preferredProjectCenterPaneId(layout, null)).toBe("center-a");
    expect(preferredProjectCenterPaneId(null, "center-b")).toBeUndefined();
  });

  it("resolves every appearance dimension without changing precedence", () => {
    expect(codeAppearanceFor(false, false, false)).toBe("light");
    expect(codeAppearanceFor(true, false, false)).toBe("dark");
    expect(codeAppearanceFor(false, true, false)).toBe("high-contrast-light");
    expect(codeAppearanceFor(true, true, false)).toBe("high-contrast-dark");
    expect(codeAppearanceFor(false, false, true)).toBe("pro-light");
    expect(codeAppearanceFor(true, false, true)).toBe("pro-dark");
    expect(codeAppearanceFor(false, true, true)).toBe(
      "pro-high-contrast-light",
    );
    expect(codeAppearanceFor(true, true, true)).toBe("pro-high-contrast-dark");
  });
});
