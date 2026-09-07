import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandedTabCount,
  parseTabDisplay,
  readTabDisplay,
  saveTabDisplay,
} from "./tab-display";
afterEach(() => vi.unstubAllGlobals());
describe("tab display preferences", () => {
  it("defaults independently and recovers from invalid values", () => {
    expect(parseTabDisplay(null, "top")).toBe("tabs");
    expect(parseTabDisplay("invalid", "bottom")).toBe("icons");
    expect(parseTabDisplay("hybrid", "top")).toBe("hybrid");
  });
  it("persists independent choices and notifies consumers", () => {
    const values = new Map<string, string>();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      dispatchEvent,
    });
    saveTabDisplay("top", "icons");
    saveTabDisplay("bottom", "hybrid");
    expect(readTabDisplay("top")).toBe("icons");
    expect(readTabDisplay("bottom")).toBe("hybrid");
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
  });
  it("falls back on read failure and surfaces write failures", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("blocked");
      },
    });
    expect(readTabDisplay("top")).toBe("tabs");
    expect(readTabDisplay("bottom")).toBe("icons");
    expect(() => saveTabDisplay("top", "hybrid")).toThrow("blocked");
  });
});
describe("hybrid trailing label collapse", () => {
  it.each([
    [688, 4],
    [687, 3],
    [568, 3],
    [328, 1],
    [208, 0],
    [0, 0],
    [2000, 4],
  ])("width %i expands %i leading tabs", (width, count) => {
    expect(expandedTabCount("hybrid", 4, width)).toBe(count);
  });
  it("keeps explicit modes independent of width and handles empty bars", () => {
    expect(expandedTabCount("tabs", 4, 0)).toBe(4);
    expect(expandedTabCount("icons", 4, 2000)).toBe(0);
    expect(expandedTabCount("hybrid", 0, 2000)).toBe(0);
  });
});
