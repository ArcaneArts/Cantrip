import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const MIN_IMAGE_SCALE = 0.25;
const MAX_IMAGE_SCALE = 8;

export interface ImageViewportPoint {
  x: number;
  y: number;
}

export interface ImageViewportTransform extends ImageViewportPoint {
  scale: number;
}

const INITIAL_TRANSFORM: ImageViewportTransform = {
  scale: 1,
  x: 0,
  y: 0,
};

const clampScale = (scale: number) =>
  Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale));

export function zoomImageViewportAt(
  transform: ImageViewportTransform,
  requestedScale: number,
  anchor: ImageViewportPoint,
): ImageViewportTransform {
  const scale = clampScale(requestedScale);
  const ratio = scale / transform.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio,
  };
}

export function moveImageViewportGesture(
  transform: ImageViewportTransform,
  previous: readonly ImageViewportPoint[],
  current: readonly ImageViewportPoint[],
): ImageViewportTransform {
  if (!previous.length || !current.length) return transform;
  if (previous.length < 2 || current.length < 2) {
    return {
      ...transform,
      x: transform.x + current[0]!.x - previous[0]!.x,
      y: transform.y + current[0]!.y - previous[0]!.y,
    };
  }
  const previousCenter = {
    x: (previous[0]!.x + previous[1]!.x) / 2,
    y: (previous[0]!.y + previous[1]!.y) / 2,
  };
  const currentCenter = {
    x: (current[0]!.x + current[1]!.x) / 2,
    y: (current[0]!.y + current[1]!.y) / 2,
  };
  const distance = (points: readonly ImageViewportPoint[]) =>
    Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y);
  const previousDistance = distance(previous);
  const currentDistance = distance(current);
  const zoomed = zoomImageViewportAt(
    transform,
    previousDistance > 0
      ? transform.scale * (currentDistance / previousDistance)
      : transform.scale,
    previousCenter,
  );
  return {
    ...zoomed,
    x: zoomed.x + currentCenter.x - previousCenter.x,
    y: zoomed.y + currentCenter.y - previousCenter.y,
  };
}

function pointInViewport(
  point: ImageViewportPoint,
  viewport: HTMLElement,
): ImageViewportPoint {
  const bounds = viewport.getBoundingClientRect();
  return {
    x: point.x - bounds.left - bounds.width / 2,
    y: point.y - bounds.top - bounds.height / 2,
  };
}

export function ExplorerImageViewport({
  alt,
  onError,
  source,
}: {
  alt: string;
  onError?(): void;
  source: string;
}) {
  const [dragging, setDragging] = useState(false);
  const [transform, setTransform] = useState(INITIAL_TRANSFORM);
  const transformRef = useRef(transform);
  const pointersRef = useRef(new Map<number, ImageViewportPoint>());
  const viewportRef = useRef<HTMLDivElement>(null);
  const applyTransform = useCallback((next: ImageViewportTransform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);
  const reset = useCallback(() => {
    pointersRef.current.clear();
    setDragging(false);
    applyTransform(INITIAL_TRANSFORM);
  }, [applyTransform]);
  useEffect(() => reset(), [reset, source]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const deltaScale =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewport.clientHeight
            : 1;
      const requestedScale =
        transformRef.current.scale *
        Math.exp(-event.deltaY * deltaScale * 0.0015);
      applyTransform(
        zoomImageViewportAt(
          transformRef.current,
          requestedScale,
          pointInViewport({ x: event.clientX, y: event.clientY }, viewport),
        ),
      );
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [applyTransform]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    const previousPointers = [...pointersRef.current.values()].map((point) =>
      pointInViewport(point, event.currentTarget),
    );
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const currentPointers = [...pointersRef.current.values()].map((point) =>
      pointInViewport(point, event.currentTarget),
    );
    applyTransform(
      moveImageViewportGesture(
        transformRef.current,
        previousPointers,
        currentPointers,
      ),
    );
  };
  const finishPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    releaseCapture: boolean,
  ) => {
    if (!pointersRef.current.delete(event.pointerId)) return;
    if (
      releaseCapture &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(pointersRef.current.size > 0);
  };
  return (
    <div
      aria-label={`Interactive preview of ${alt}`}
      className={`grid h-full w-full place-items-center overflow-hidden p-4 ${
        dragging ? "cursor-grabbing" : "cursor-grab"
      }`}
      onDoubleClick={reset}
      onLostPointerCapture={(event) => finishPointer(event, false)}
      onPointerCancel={(event) => finishPointer(event, false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointer(event, true)}
      ref={viewportRef}
      style={{ touchAction: "none" }}
      title="Scroll to zoom, drag to pan, or pinch with two fingers. Double-click to reset."
    >
      <img
        alt={alt}
        className="max-h-full max-w-full select-none object-contain"
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onError={onError}
        src={source}
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transformOrigin: "center",
          willChange: "transform",
        }}
      />
    </div>
  );
}
