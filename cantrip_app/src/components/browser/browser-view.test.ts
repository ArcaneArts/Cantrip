import { describe, expect, it } from "vitest";

import {
  browserUrlIsLocal,
  nativeBrowserContentOffset,
  nativeBrowserSurfacePosition,
} from "./browser-view";

describe("browserUrlIsLocal", () => {
  it("keeps local services out of the public page proxy", () => {
    expect(browserUrlIsLocal("http://localhost:3000/")).toBe(true);
    expect(browserUrlIsLocal("http://192.168.1.20/")).toBe(true);
    expect(browserUrlIsLocal("http://worker.local/")).toBe(true);
  });

  it("proxies public sites", () => {
    expect(browserUrlIsLocal("https://google.com/")).toBe(false);
    expect(browserUrlIsLocal("https://example.com/docs")).toBe(false);
  });
});

describe("nativeBrowserSurfacePosition", () => {
  it("accounts for the native titlebar outside the DOM viewport", () => {
    expect(
      nativeBrowserSurfacePosition({ left: 290, top: 115 } as DOMRect, {
        x: 0,
        y: 31,
      }),
    ).toEqual({ x: 290, y: 146 });
  });
});

describe("nativeBrowserContentOffset", () => {
  it("derives a titlebar inset when native window origins match", () => {
    expect(
      nativeBrowserContentOffset({
        innerPosition: { x: 100, y: 100 },
        innerSize: { width: 2560, height: 1538 },
        outerPosition: { x: 100, y: 100 },
        outerSize: { width: 2560, height: 1600 },
        scaleFactor: 2,
      }),
    ).toEqual({ x: 0, y: 31 });
  });
});
