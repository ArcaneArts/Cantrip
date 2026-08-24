import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ExplorerImageViewport,
  moveImageViewportGesture,
  zoomImageViewportAt,
} from "./explorer-image-viewport";

describe("explorer image viewport gestures", () => {
  it("owns touch gestures for responsive pan and pinch controls", () => {
    const markup = renderToStaticMarkup(
      createElement(ExplorerImageViewport, {
        alt: "diagram.png",
        source: "blob:image",
      }),
    );

    expect(markup).toContain("touch-action:none");
    expect(markup).toContain("cursor-grab");
    expect(markup).toContain('draggable="false"');
  });

  it("zooms around the pointer and clamps extreme scales", () => {
    expect(
      zoomImageViewportAt({ scale: 1, x: 0, y: 0 }, 2, { x: 100, y: 50 }),
    ).toEqual({ scale: 2, x: -100, y: -50 });
    expect(
      zoomImageViewportAt({ scale: 1, x: 0, y: 0 }, 100, { x: 0, y: 0 }).scale,
    ).toBe(8);
  });

  it("pans with one pointer", () => {
    expect(
      moveImageViewportGesture(
        { scale: 2, x: 10, y: 20 },
        [{ x: 4, y: 8 }],
        [{ x: 14, y: 3 }],
      ),
    ).toEqual({ scale: 2, x: 20, y: 15 });
  });

  it("combines two-finger pan and pinch zoom around the gesture center", () => {
    expect(
      moveImageViewportGesture(
        { scale: 1, x: 0, y: 0 },
        [
          { x: -50, y: 0 },
          { x: 50, y: 0 },
        ],
        [
          { x: -90, y: 10 },
          { x: 110, y: 10 },
        ],
      ),
    ).toEqual({ scale: 2, x: 10, y: 10 });
  });
});
