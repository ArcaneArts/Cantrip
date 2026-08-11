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

export interface RemoteSurfacePointerEventLike
  extends RemoteSurfacePoint, RemoteSurfaceModifierState {
  button: number;
  buttons: number;
  detail: number;
}

export interface RemoteSurfaceWheelEventLike
  extends RemoteSurfacePoint, RemoteSurfaceModifierState {
  deltaX: number;
  deltaY: number;
}

export interface RemoteSurfaceKeyEventLike extends RemoteSurfaceModifierState {
  code: string;
  key: string;
}

export interface RemoteSurfacePointerInput {
  button: ReturnType<typeof remoteSurfacePointerButton>;
  buttons: number;
  clickCount: number;
  deltaX: number;
  deltaY: number;
  event: "down" | "move" | "up" | "wheel";
  modifiers: number;
  type: "pointer";
  x: number;
  y: number;
}

export interface RemoteSurfaceKeyInput {
  code: string;
  event: "down" | "up";
  key: string;
  modifiers: number;
  text: string;
  type: "key";
}

export interface RemoteSurfaceTouchInput {
  event: "cancel" | "end" | "move" | "start";
  modifiers: number;
  points: ReturnType<typeof remoteSurfaceTouchPoints>;
  type: "touch";
}

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

export function remoteSurfacePointerInput(
  event: RemoteSurfacePointerEventLike,
  type: "down" | "move" | "up",
  bounds: RemoteSurfaceBounds,
  target: RemoteSurfaceSize,
  coordinateLimit: RemoteSurfaceCoordinateLimit,
): RemoteSurfacePointerInput {
  return {
    type: "pointer",
    event: type,
    ...remoteSurfacePointerCoordinates(event, bounds, target, coordinateLimit),
    button: remoteSurfacePointerButton(event.button),
    buttons: event.buttons,
    clickCount: event.detail,
    deltaX: 0,
    deltaY: 0,
    modifiers: remoteSurfaceModifiers(event),
  };
}

export function remoteSurfaceWheelInput(
  event: RemoteSurfaceWheelEventLike,
  bounds: RemoteSurfaceBounds,
  target: RemoteSurfaceSize,
  coordinateLimit: RemoteSurfaceCoordinateLimit,
): RemoteSurfacePointerInput {
  return {
    type: "pointer",
    event: "wheel",
    ...remoteSurfacePointerCoordinates(event, bounds, target, coordinateLimit),
    button: "none",
    buttons: 0,
    clickCount: 0,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    modifiers: remoteSurfaceModifiers(event),
  };
}

export function remoteSurfaceKeyInput(
  event: RemoteSurfaceKeyEventLike,
  type: "down" | "up",
  options: { allowAltModifiedText: boolean },
): RemoteSurfaceKeyInput {
  return {
    type: "key",
    event: type,
    key: event.key,
    code: event.code,
    text: remoteSurfaceKeyText(event, type, options),
    modifiers: remoteSurfaceModifiers(event),
  };
}

export function remoteSurfaceTouchInput(
  event: RemoteSurfaceModifierState & {
    touches: Parameters<typeof remoteSurfaceTouchPoints>[0];
  },
  type: "cancel" | "end" | "move" | "start",
  bounds: RemoteSurfaceBounds,
  target: RemoteSurfaceSize,
): RemoteSurfaceTouchInput {
  return {
    type: "touch",
    event: type,
    points: remoteSurfaceTouchPoints(event.touches, bounds, target),
    modifiers: remoteSurfaceModifiers(event),
  };
}

export async function forwardRemoteSurfaceClipboard(
  forward: (text: string) => void,
  readText: () => Promise<string> = () => navigator.clipboard.readText(),
): Promise<string> {
  try {
    const text = await readText();
    forward(text);
    return text ? "Clipboard pasted" : "Clipboard is empty";
  } catch {
    return "Clipboard access was denied by this app environment.";
  }
}
