import { describe, expect, it } from "vitest";

import {
  browserPointerCoordinates,
  normalizeBrowserAddress,
} from "./browser-view";

describe("normalizeBrowserAddress", () => {
  it("adds HTTPS to host-like input and rejects non-web protocols", () => {
    expect(normalizeBrowserAddress("example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(normalizeBrowserAddress("javascript:alert(1)")).toBeNull();
  });
});

describe("browserPointerCoordinates", () => {
  it("maps and clamps client coordinates into the worker viewport", () => {
    const bounds = { left: 100, top: 50, width: 400, height: 200 } as DOMRect;
    expect(
      browserPointerCoordinates({ clientX: 300, clientY: 150 }, bounds, {
        width: 1_200,
        height: 600,
      }),
    ).toEqual({ x: 600, y: 300 });
    expect(
      browserPointerCoordinates({ clientX: 50, clientY: 500 }, bounds, {
        width: 1_200,
        height: 600,
      }),
    ).toEqual({ x: 0, y: 600 });
  });
});
