export interface RemoteSurfacePoint {
  clientX: number;
  clientY: number;
}

export interface RemoteSurfaceBounds {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface RemoteSurfaceSize {
  height: number;
  width: number;
}

export interface RemoteSurfaceModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type RemoteSurfaceCoordinateLimit = "edge" | "last-pixel";

export function remoteSurfacePointerCoordinates(
  point: RemoteSurfacePoint,
  bounds: RemoteSurfaceBounds,
  target: RemoteSurfaceSize,
  coordinateLimit: RemoteSurfaceCoordinateLimit = "edge",
) {
  const maximumX =
    coordinateLimit === "last-pixel"
      ? Math.max(0, target.width - 1)
      : target.width;
  const maximumY =
    coordinateLimit === "last-pixel"
      ? Math.max(0, target.height - 1)
      : target.height;
  return {
    x: Math.max(
      0,
      Math.min(
        maximumX,
        ((point.clientX - bounds.left) / bounds.width) * target.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        maximumY,
        ((point.clientY - bounds.top) / bounds.height) * target.height,
      ),
    ),
  };
}

export function remoteSurfaceTouchPoints(
  touches: ArrayLike<
    RemoteSurfacePoint & {
      force?: number;
      identifier: number;
      radiusX?: number;
      radiusY?: number;
    }
  >,
  bounds: RemoteSurfaceBounds,
  target: RemoteSurfaceSize,
) {
  return Array.from(touches, (touch) => ({
    id: touch.identifier,
    ...remoteSurfacePointerCoordinates(touch, bounds, target),
    radiusX: Math.max(1, touch.radiusX || 1),
    radiusY: Math.max(1, touch.radiusY || 1),
    force: Math.max(0, Math.min(1, touch.force || 1)),
  }));
}

export function remoteSurfaceModifiers(
  event: RemoteSurfaceModifierState,
): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

const POINTER_BUTTONS = ["left", "middle", "right", "back", "forward"] as const;

export function remoteSurfacePointerButton(button: number) {
  return POINTER_BUTTONS[button] ?? "none";
}

export function remoteSurfaceKeyText(
  event: Pick<RemoteSurfaceModifierState, "altKey" | "ctrlKey" | "metaKey"> & {
    key: string;
  },
  type: "down" | "up",
  options: { allowAltModifiedText: boolean },
): string {
  return type === "down" &&
    event.key.length === 1 &&
    !event.metaKey &&
    !event.ctrlKey &&
    (options.allowAltModifiedText || !event.altKey)
    ? event.key
    : "";
}
