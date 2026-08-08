import { describe, expect, it } from "vitest";

import {
  browserOverlayIsOpen,
  browserUrlIsLocal,
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

describe("browserOverlayIsOpen", () => {
  it("detects visible application menus above a native browser", () => {
    const root = {
      querySelectorAll: () => [
        {
          dataset: { state: "open" },
          getClientRects: () => [{ width: 120, height: 90 }],
        },
      ],
    } as unknown as ParentNode;

    expect(browserOverlayIsOpen(root)).toBe(true);
  });

  it("ignores closed overlays", () => {
    const root = {
      querySelectorAll: () => [
        {
          dataset: { state: "closed" },
          getClientRects: () => [{ width: 300, height: 200 }],
        },
      ],
    } as unknown as ParentNode;

    expect(browserOverlayIsOpen(root)).toBe(false);
  });
});
