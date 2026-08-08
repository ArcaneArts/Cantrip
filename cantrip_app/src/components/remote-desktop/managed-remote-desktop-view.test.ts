import { describe, expect, it } from "vitest";

import {
  desktopPointerCoordinates,
  fitDesktopSize,
} from "./managed-remote-desktop-view";

describe("managed Remote Desktop geometry", () => {
  it("letterboxes a worker display without distorting its aspect ratio", () => {
    expect(
      fitDesktopSize(
        { width: 1_000, height: 1_000 },
        { width: 1_920, height: 1_080 },
      ),
    ).toEqual({ width: 1_000, height: 562 });
  });

  it("maps pointer positions back to worker display coordinates", () => {
    expect(
      desktopPointerCoordinates(
        { clientX: 510, clientY: 291 },
        { left: 10, top: 10, width: 1_000, height: 562 },
        { width: 1_920, height: 1_080 },
      ),
    ).toEqual({ x: 960, y: 540 });
  });
});
