import { describe, expect, it } from "vitest";

import {
  NATIVE_TOOLTIP_OBSERVER_OPTIONS,
  suppressNativeTooltips,
} from "./native-tooltip-suppression";

function element(options: { svgTitle?: boolean; title?: string } = {}) {
  let title = options.title ?? null;
  const target = {
    hasAttribute: (name: string) => name === "title" && title !== null,
    matches: (selector: string) =>
      selector === "svg title" && Boolean(options.svgTitle),
    nodeType: 1,
    querySelectorAll: () => [],
    removeAttribute: (name: string) => {
      if (name === "title") title = null;
    },
    textContent: options.svgTitle ? "Browser tooltip" : null,
  };
  return {
    target: target as unknown as Element,
    title: () => title,
  };
}

describe("native tooltip suppression", () => {
  it("removes title attributes and blanks SVG title nodes", () => {
    const titled = element({ title: "Usage details" });
    const svgTitle = element({ svgTitle: true });
    const root = {
      nodeType: 9,
      querySelectorAll: () => [titled.target, svgTitle.target],
    } as unknown as ParentNode;

    expect(suppressNativeTooltips(root)).toBe(2);
    expect(titled.title()).toBeNull();
    expect(svgTitle.target.textContent).toBe("");
  });

  it("watches initial, dynamically added, and updated tooltip sources", () => {
    expect(NATIVE_TOOLTIP_OBSERVER_OPTIONS).toEqual({
      attributeFilter: ["title"],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
});
