import { describe, expect, it } from "vitest";

import {
  previewPointToTarget,
  type PreviewPointInput,
} from "./preview-coordinates";

const input: PreviewPointInput = {
  clientX: 220,
  clientY: 140,
  imageRect: { left: 20, top: 40, width: 400, height: 200 },
  targetBounds: { width: 1200, height: 600 },
};

describe("previewPointToTarget", () => {
  it("maps a scaled image center to target-local logical coordinates", () => {
    expect(previewPointToTarget(input)).toEqual({ x: 600, y: 300 });
  });

  it("includes the top-left edge and preserves fractional coordinates", () => {
    expect(
      previewPointToTarget({ ...input, clientX: 20, clientY: 40 }),
    ).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      previewPointToTarget({ ...input, clientX: 20.25, clientY: 40.5 }),
    ).toEqual({ x: 0.75, y: 1.5 });
  });

  it("uses only the actual image bounds, not container padding or native pixels", () => {
    expect(
      previewPointToTarget({
        clientX: 200,
        clientY: 125,
        imageRect: { left: 100, top: 75, width: 200, height: 100 },
        targetBounds: { width: 800, height: 400 },
      }),
    ).toEqual({ x: 400, y: 200 });
    expect(
      previewPointToTarget({
        ...input,
        clientX: 10,
      }),
    ).toBeNull();
  });

  it("does not add a target's desktop origin on offset or negative monitors", () => {
    const bounds = { x: -1920, y: 900, width: 1200, height: 600 };
    expect(previewPointToTarget({ ...input, targetBounds: bounds })).toEqual({
      x: 600,
      y: 300,
    });
  });

  it("supports an image partially outside the browser viewport", () => {
    expect(
      previewPointToTarget({
        ...input,
        clientX: 0,
        clientY: 0,
        imageRect: { left: -200, top: -100, width: 400, height: 200 },
      }),
    ).toEqual({ x: 600, y: 300 });
  });

  it.each([
    { clientX: 420, clientY: 140 },
    { clientX: 220, clientY: 240 },
    { clientX: 420, clientY: 240 },
    { clientX: 19.99, clientY: 140 },
    { clientX: 220, clientY: 39.99 },
    { clientX: 421, clientY: 140 },
    { clientX: 220, clientY: 241 },
  ])("rejects exclusive edges and outside point %o", (point) => {
    expect(previewPointToTarget({ ...input, ...point })).toBeNull();
  });

  it("accepts positions immediately inside the positive edges", () => {
    const point = previewPointToTarget({
      ...input,
      clientX: 419.999,
      clientY: 239.999,
    });
    expect(point?.x).toBeCloseTo(1199.997);
    expect(point?.y).toBeCloseTo(599.997);
    expect(point!.x).toBeLessThan(input.targetBounds.width);
    expect(point!.y).toBeLessThan(input.targetBounds.height);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects nonfinite value %s in every coordinate or dimension",
    (value) => {
      for (const field of ["clientX", "clientY"] as const) {
        expect(previewPointToTarget({ ...input, [field]: value })).toBeNull();
      }
      for (const field of ["left", "top", "width", "height"] as const) {
        expect(
          previewPointToTarget({
            ...input,
            imageRect: { ...input.imageRect, [field]: value },
          }),
        ).toBeNull();
      }
      for (const field of ["width", "height"] as const) {
        expect(
          previewPointToTarget({
            ...input,
            targetBounds: { ...input.targetBounds, [field]: value },
          }),
        ).toBeNull();
      }
    },
  );

  it.each([0, -1])(
    "rejects nonpositive image and target dimensions %s",
    (value) => {
      for (const field of ["width", "height"] as const) {
        expect(
          previewPointToTarget({
            ...input,
            imageRect: { ...input.imageRect, [field]: value },
          }),
        ).toBeNull();
        expect(
          previewPointToTarget({
            ...input,
            targetBounds: { ...input.targetBounds, [field]: value },
          }),
        ).toBeNull();
      }
    },
  );

  it("rejects arithmetic overflow even when each input is finite", () => {
    expect(
      previewPointToTarget({
        ...input,
        clientX: Number.MAX_VALUE,
        imageRect: { ...input.imageRect, left: -Number.MAX_VALUE },
      }),
    ).toBeNull();
  });

  it("does not mutate the image or target metadata", () => {
    const frozen = Object.freeze({
      ...input,
      imageRect: Object.freeze({ ...input.imageRect }),
      targetBounds: Object.freeze({ ...input.targetBounds }),
    });
    expect(previewPointToTarget(frozen)).toEqual({ x: 600, y: 300 });
  });
});
