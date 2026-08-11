import { describe, expect, it } from "vitest";

import {
  remoteSurfaceKeyText,
  remoteSurfaceModifiers,
  remoteSurfacePointerButton,
  remoteSurfacePointerCoordinates,
  remoteSurfaceTouchPoints,
} from "./remote-surface-input";

const noModifiers = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("remoteSurfacePointerCoordinates", () => {
  const bounds = { left: 100, top: 50, width: 400, height: 200 };
  const target = { width: 1_200, height: 600 };

  it("maps client coordinates into a remote surface", () => {
    expect(
      remoteSurfacePointerCoordinates(
        { clientX: 300, clientY: 150 },
        bounds,
        target,
      ),
    ).toEqual({ x: 600, y: 300 });
  });

  it("preserves edge and last-pixel clamping semantics", () => {
    const outside = { clientX: 900, clientY: 500 };
    expect(remoteSurfacePointerCoordinates(outside, bounds, target)).toEqual({
      x: 1_200,
      y: 600,
    });
    expect(
      remoteSurfacePointerCoordinates(outside, bounds, target, "last-pixel"),
    ).toEqual({ x: 1_199, y: 599 });
    expect(
      remoteSurfacePointerCoordinates(
        { clientX: 0, clientY: 0 },
        bounds,
        target,
        "last-pixel",
      ),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("remoteSurfaceTouchPoints", () => {
  it("maps identifiers, coordinates, pressure, and radii", () => {
    expect(
      remoteSurfaceTouchPoints(
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

  it("preserves browser defaults and clamps invalid touch metrics", () => {
    expect(
      remoteSurfaceTouchPoints(
        [
          {
            clientX: 0,
            clientY: 0,
            force: 0,
            identifier: 1,
            radiusX: -2,
            radiusY: 0,
          },
          {
            clientX: 10,
            clientY: 10,
            force: 2,
            identifier: 2,
          },
        ],
        { left: 0, top: 0, width: 10, height: 10 },
        { width: 10, height: 10 },
      ),
    ).toEqual([
      { id: 1, x: 0, y: 0, force: 1, radiusX: 1, radiusY: 1 },
      { id: 2, x: 10, y: 10, force: 1, radiusX: 1, radiusY: 1 },
    ]);
  });
});

describe("remote surface button and modifier encoding", () => {
  it("encodes every modifier into its protocol bit", () => {
    expect(remoteSurfaceModifiers(noModifiers)).toBe(0);
    expect(
      remoteSurfaceModifiers({
        altKey: true,
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(15);
    expect(
      remoteSurfaceModifiers({ ...noModifiers, ctrlKey: true, shiftKey: true }),
    ).toBe(10);
  });

  it("maps standard mouse buttons and rejects unknown indexes", () => {
    expect([0, 1, 2, 3, 4].map(remoteSurfacePointerButton)).toEqual([
      "left",
      "middle",
      "right",
      "back",
      "forward",
    ]);
    expect(remoteSurfacePointerButton(-1)).toBe("none");
    expect(remoteSurfacePointerButton(5)).toBe("none");
  });
});

describe("remoteSurfaceKeyText", () => {
  it("forwards printable key-down text", () => {
    expect(
      remoteSurfaceKeyText({ ...noModifiers, key: "a" }, "down", {
        allowAltModifiedText: false,
      }),
    ).toBe("a");
  });

  it("suppresses key-up, named keys, and command shortcuts", () => {
    const options = { allowAltModifiedText: false };
    expect(
      remoteSurfaceKeyText({ ...noModifiers, key: "a" }, "up", options),
    ).toBe("");
    expect(
      remoteSurfaceKeyText({ ...noModifiers, key: "Enter" }, "down", options),
    ).toBe("");
    expect(
      remoteSurfaceKeyText(
        { ...noModifiers, key: "a", ctrlKey: true },
        "down",
        options,
      ),
    ).toBe("");
    expect(
      remoteSurfaceKeyText(
        { ...noModifiers, key: "a", metaKey: true },
        "down",
        options,
      ),
    ).toBe("");
  });

  it("retains the browser and desktop Alt-key difference explicitly", () => {
    const event = { ...noModifiers, altKey: true, key: "å" };
    expect(
      remoteSurfaceKeyText(event, "down", { allowAltModifiedText: true }),
    ).toBe("å");
    expect(
      remoteSurfaceKeyText(event, "down", { allowAltModifiedText: false }),
    ).toBe("");
  });
});
