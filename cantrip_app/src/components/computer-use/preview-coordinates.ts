import type { CuaPoint, CuaTarget } from "@cantrip/protocol/computer-use";

export interface PreviewPointInput {
  clientX: number;
  clientY: number;
  /** The actual displayed image bounds, excluding any object-fit letterboxing. */
  imageRect: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;
  targetBounds: Pick<CuaTarget["bounds"], "width" | "height">;
}

/** Maps a preview click to target-local logical points, never desktop pixels. */
export function previewPointToTarget({
  clientX,
  clientY,
  imageRect,
  targetBounds,
}: PreviewPointInput): CuaPoint | null {
  if (
    ![
      clientX,
      clientY,
      imageRect.left,
      imageRect.top,
      imageRect.width,
      imageRect.height,
      targetBounds.width,
      targetBounds.height,
    ].every(Number.isFinite) ||
    imageRect.width <= 0 ||
    imageRect.height <= 0 ||
    targetBounds.width <= 0 ||
    targetBounds.height <= 0
  ) {
    return null;
  }

  const imageX = clientX - imageRect.left;
  const imageY = clientY - imageRect.top;
  if (
    imageX < 0 ||
    imageY < 0 ||
    imageX >= imageRect.width ||
    imageY >= imageRect.height
  ) {
    return null;
  }

  const x = (imageX / imageRect.width) * targetBounds.width;
  const y = (imageY / imageRect.height) * targetBounds.height;
  // Rounding near the far edge must not produce a point outside the target.
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= targetBounds.width ||
    y >= targetBounds.height
  ) {
    return null;
  }
  return { x, y };
}
