import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
export interface NbtVirtualHandle {
  scrollToIndex(index: number, align?: "auto" | "center"): void;
  /** Logical row position, independent of scaled browser scroll extents. */
  capturePosition(): number;
  restorePosition(position: number): void;
}
const MAX_HEIGHT = 8_000_000;
/** Scaled scroll extent avoids browser element-height limits; DOM work follows the viewport. */
export const NbtVirtualList = forwardRef<
  NbtVirtualHandle,
  {
    count: number;
    rowHeight?: number;
    onRange(offset: number, limit: number): void;
    render(index: number): ReactNode;
    label: string;
    initialPosition?: number;
    complete?: boolean;
  }
>(
  (
    {
      count,
      rowHeight = 32,
      onRange,
      render,
      label,
      initialPosition = 0,
      complete = true,
    },
    ref,
  ) => {
    const viewport = useRef<HTMLDivElement>(null),
      position = useRef(0),
      metrics = useRef({ count, height: 400 }),
      frame = useRef<number | null>(null),
      programmatic = useRef<number | null>(null),
      pending = useRef<number | null>(initialPosition);
    const [view, setView] = useState({
      first: 0,
      limit: 32,
      top: 0,
      height: 400,
    });
    const sizes = useCallback(() => {
      const height = metrics.current.height,
        logical = Math.max(height, metrics.current.count * rowHeight),
        physical = Math.min(MAX_HEIGHT, logical);
      return {
        height,
        logical,
        physical,
        logicalMax: Math.max(0, logical - height),
        physicalMax: Math.max(0, physical - height),
      };
    }, [rowHeight]);
    const update = useCallback(() => {
      const node = viewport.current;
      if (!node) return;
      const size = sizes(),
        logical = Math.min(position.current, size.logicalMax),
        first = Math.max(0, Math.floor(logical / rowHeight) - 8),
        limit = Math.ceil(size.height / rowHeight) + 16,
        top = node.scrollTop + first * rowHeight - logical;
      setView((previous) =>
        previous.first === first &&
        previous.limit === limit &&
        previous.top === top &&
        previous.height === size.height
          ? previous
          : { first, limit, top, height: size.height },
      );
    }, [rowHeight, sizes]);
    const setPosition = useCallback(
      (value: number) => {
        const node = viewport.current;
        if (!node) return;
        const size = sizes();
        position.current = Math.max(0, Math.min(value, size.logicalMax));
        node.scrollTop = size.logicalMax
          ? (position.current / size.logicalMax) * size.physicalMax
          : 0;
        // Scaled extents round physical scrollTop. Preserve the exact logical
        // target when the resulting programmatic scroll event comes back.
        programmatic.current = node.scrollTop;
        update();
      },
      [sizes, update],
    );
    useImperativeHandle(
      ref,
      () => ({
        capturePosition: () => pending.current ?? position.current / rowHeight,
        restorePosition(value) {
          pending.current = value;
          if (sizes().logicalMax >= value * rowHeight || complete) {
            pending.current = null;
            setPosition(value * rowHeight);
          }
        },
        scrollToIndex(index, align = "auto") {
          pending.current = null;
          const size = sizes(),
            top = index * rowHeight;
          if (align === "center")
            setPosition(top - size.height / 2 + rowHeight / 2);
          else if (top < position.current) setPosition(top);
          else if (top + rowHeight > position.current + size.height)
            setPosition(top + rowHeight - size.height);
        },
      }),
      [rowHeight, setPosition, sizes, complete],
    );
    useLayoutEffect(() => {
      const node = viewport.current;
      if (!node) return;
      const resize = () => {
        metrics.current = { count, height: node.clientHeight || 400 };
        const target = pending.current;
        if (
          target !== null &&
          (sizes().logicalMax >= target * rowHeight || complete)
        ) {
          pending.current = null;
          setPosition(target * rowHeight);
        } else setPosition(position.current);
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(node);
      return () => {
        observer.disconnect();
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
      };
    }, [count, setPosition, rowHeight, complete, sizes]);
    useLayoutEffect(
      () => onRange(view.first, view.limit),
      [onRange, view.first, view.limit],
    );
    const scroll = () => {
      const node = viewport.current;
      if (!node) return;
      const size = sizes();
      if (programmatic.current !== node.scrollTop)
        position.current = size.physicalMax
          ? (node.scrollTop / size.physicalMax) * size.logicalMax
          : 0;
      programmatic.current = null;
      if (frame.current === null)
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          update();
        });
    };
    return (
      <div
        ref={viewport}
        aria-label={label}
        className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"
        onScroll={scroll}
        onWheel={() => {
          pending.current = null;
          programmatic.current = null;
        }}
        onPointerDown={() => {
          pending.current = null;
          programmatic.current = null;
        }}
        onKeyDown={() => {
          pending.current = null;
          programmatic.current = null;
        }}
        data-nbt-scroll=""
      >
        <div
          style={{
            height: Math.min(
              MAX_HEIGHT,
              Math.max(view.height, count * rowHeight),
            ),
            position: "relative",
          }}
        >
          <div
            className="absolute inset-x-0 top-0"
            style={{ transform: "translateY(" + view.top + "px)" }}
          >
            {Array.from(
              { length: Math.max(0, Math.min(view.limit, count - view.first)) },
              (_, i) => (
                <div key={view.first + i} style={{ height: rowHeight }}>
                  {render(view.first + i)}
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    );
  },
);
NbtVirtualList.displayName = "NbtVirtualList";
