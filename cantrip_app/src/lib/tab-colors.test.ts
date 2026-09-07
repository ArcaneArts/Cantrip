import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseTabHue,
  readTabHue,
  saveTabHue,
  surfaceColorKey,
  tabColorKey,
  tabColorStyle,
  TAB_COLOR_PRESETS,
} from "./tab-colors";
import type { ProjectSurface } from "./project-surface";

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    dispatchEvent: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("tab color preferences", () => {
  it.each([null, "", "NaN", "Infinity", "-1", "360", "junk"])(
    "ignores invalid stored hue %s",
    (value) => expect(parseTabHue(value)).toBeNull(),
  );
  it.each([0, 40, 215, 359])("restores hue %s and resets to neutral", (hue) => {
    saveTabHue("tab", hue);
    expect(readTabHue("tab")).toBe(hue);
    saveTabHue("tab", null);
    expect(readTabHue("tab")).toBeNull();
    expect(values.has("tab")).toBe(false);
  });
  it("rejects invalid writes and surfaces storage failure", () => {
    expect(() => saveTabHue("tab", 360)).toThrow("0 and 359");
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveTabHue("tab", 20)).toThrow("quota");
  });
  it("shares file color between preview and pinned tab regardless of pane", () => {
    const surface = {
      kind: "explorer",
      projectId: "p",
      tabKey: "explorer:e",
      paneId: "bottom",
      entity: { selectedPath: "src/app.ts" },
    } as ProjectSurface;
    expect(surfaceColorKey(surface)).toBe(tabColorKey("p", "", "src/app.ts"));
    expect(surfaceColorKey({ ...surface, paneId: "right" })).toBe(
      surfaceColorKey(surface),
    );
    expect(tabColorKey("other", "", "src/app.ts")).not.toBe(
      surfaceColorKey(surface),
    );
    expect(tabColorKey("p", "terminal:a")).not.toBe(
      tabColorKey("p", "terminal:b"),
    );
  });
  it("provides five presets and only a hue custom property, never a background", () => {
    expect(TAB_COLOR_PRESETS).toHaveLength(5);
    expect(tabColorStyle(null)).toEqual({});
    expect(tabColorStyle(215)).toEqual({ "--tab-hue": 215 });
  });
});
