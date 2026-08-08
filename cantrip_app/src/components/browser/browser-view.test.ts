import { describe, expect, it } from "vitest";

import {
  browserPointerCoordinates,
  browserTouchPoints,
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

describe("browserTouchPoints", () => {
  it("maps touch identifiers, pressure, and radii into the worker viewport", () => {
    expect(
      browserTouchPoints(
        [
          {
            clientX: 150,
            clientY: 100,
            force: 0.5,
            identifier: 7,
            radiusX: 4,
            radiusY: 6,
          },
        ],
        { left: 100, top: 50, width: 200, height: 100 },
        { width: 1_000, height: 500 },
      ),
    ).toEqual([
      {
        id: 7,
        x: 250,
        y: 250,
        force: 0.5,
        radiusX: 4,
        radiusY: 6,
      },
    ]);
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
