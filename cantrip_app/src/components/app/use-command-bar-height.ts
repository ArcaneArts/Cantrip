import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

const storageKey = "cantrip:command-palette-height:v1";
const defaultFraction = 0.7;

function readFraction(fallback = defaultFraction): number {
  try {
    const value = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveFraction(fraction: number): void {
  try {
    window.localStorage.setItem(storageKey, String(fraction));
  } catch {
    // Resizing still works for this session when storage is unavailable.
  }
}

type Geometry = {
  viewport: number;
  available: number;
  chrome: number;
  content: number;
};

function heightBounds(geometry: Geometry) {
  const max = Math.min(geometry.available, geometry.content);
  return { min: Math.min(max, geometry.chrome + 72), max };
}

type Drag = {
  pointerId: number;
  startY: number;
  startHeight: number;
  startFraction: number;
  height: number;
  fraction: number;
};

export function useCommandBarHeight(
  open: boolean,
  listRef: RefObject<HTMLDivElement | null>,
) {
  const id = useId();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [fraction, setFraction] = useState(() => readFraction());
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const drag = useRef<Drag | null>(null);

  const measure = useCallback((): Geometry | null => {
    const list = listRef.current;
    const sizer = list?.querySelector<HTMLElement>("[cmdk-list-sizer]");
    if (!element || !list || !sizer) return null;
    const rect = element.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const listStyle = window.getComputedStyle(list);
    const positioner = element.parentElement;
    const bottomPadding = positioner
      ? parseFloat(window.getComputedStyle(positioner).paddingBottom) || 0
      : 16;
    const viewport = window.visualViewport;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const bottom = Math.min(
      (viewport?.offsetTop ?? 0) + viewportHeight,
      positioner?.getBoundingClientRect().bottom ?? window.innerHeight,
    );
    const chrome = Math.max(0, Math.ceil(rect.height - listRect.height));
    const padding =
      (parseFloat(listStyle.paddingTop) || 0) +
      (parseFloat(listStyle.paddingBottom) || 0);
    return {
      viewport: viewportHeight,
      available: Math.max(
        0,
        Math.floor(Math.min(viewportHeight, bottom - rect.top - bottomPadding)),
      ),
      chrome,
      content:
        chrome + Math.ceil(sizer.getBoundingClientRect().height + padding),
    };
  }, [element, listRef]);

  useLayoutEffect(() => {
    if (open) {
      setFraction((current) => readFraction(current));
    } else {
      setGeometry(null);
      if (drag.current) {
        setFraction(drag.current.startFraction);
        drag.current = null;
      }
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !element) return;
    let frame: number | undefined;
    const update = () => {
      const next = measure();
      if (!next) return;
      setGeometry((current) =>
        current &&
        current.viewport === next.viewport &&
        current.available === next.available &&
        current.chrome === next.chrome &&
        current.content === next.content
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    const sizer = listRef.current?.querySelector("[cmdk-list-sizer]");
    if (sizer) observer.observe(sizer);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [element, listRef, measure, open]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const size = measure();
    if (!current || event.pointerId !== current.pointerId || !size?.viewport)
      return;
    const bounds = heightBounds(size);
    const height = Math.min(
      bounds.max,
      Math.max(
        bounds.min,
        current.startHeight + event.clientY - current.startY,
      ),
    );
    if (Math.abs(height - current.height) < 1) return;
    current.height = height;
    current.fraction =
      Math.abs(height - current.startHeight) < 1
        ? current.startFraction
        : height / size.viewport;
    setFraction(current.fraction);
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drag.current = null;
    if (cancel) setFraction(current.startFraction);
    else if (current.fraction !== current.startFraction)
      saveFraction(current.fraction);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const size = measure();
    if (!size?.viewport || !element) return;
    const bounds = heightBounds(size);
    const current = element.getBoundingClientRect().height;
    const requested =
      event.key === "Home"
        ? bounds.min
        : event.key === "End"
          ? bounds.max
          : current + (event.key === "ArrowDown" ? 32 : -32);
    const height = Math.min(bounds.max, Math.max(bounds.min, requested));
    if (Math.abs(height - current) < 1) return;
    const next = height / size.viewport;
    setFraction(next);
    saveFraction(next);
  };

  const bounds = geometry ? heightBounds(geometry) : null;
  const height =
    geometry && bounds
      ? Math.min(bounds.max, Math.max(bounds.min, fraction * geometry.viewport))
      : undefined;
  const percent = (value: number) =>
    geometry?.viewport ? Math.round((value / geometry.viewport) * 100) : 0;

  return {
    contentRef: setElement,
    id,
    style: {
      height,
      maxHeight: geometry
        ? geometry.available
        : `min(${fraction * 100}svh, 100%)`,
    } satisfies CSSProperties,
    handleProps: {
      "aria-controls": id,
      "aria-valuemin": bounds ? percent(bounds.min) : 0,
      "aria-valuemax": bounds ? percent(bounds.max) : 100,
      "aria-valuenow":
        height !== undefined ? percent(height) : Math.round(fraction * 100),
      "aria-valuetext": `Preferred maximum ${Math.round(fraction * 100)} percent of window height`,
      onKeyDown,
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || drag.current || !element) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const height = element.getBoundingClientRect().height;
        drag.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: height,
          startFraction: fraction,
          height,
          fraction,
        };
      },
      onPointerMove,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        onPointerMove(event);
        finishDrag(event);
      },
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) =>
        finishDrag(event, true),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) =>
        finishDrag(event),
    },
  };
}
