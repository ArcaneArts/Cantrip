import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export interface ResizablePanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ResizablePanelEdge = "left" | "right";
export type ResizablePanelDataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

const suppressedBodyStyles = new WeakMap<
  object,
  { count: number; cursor: string; userSelect: string }
>();

export function suppressResizablePanelBodyInteraction(style: {
  cursor: string;
  userSelect: string;
}): () => void {
  const active = suppressedBodyStyles.get(style);
  const state = active ?? {
    count: 0,
    cursor: style.cursor,
    userSelect: style.userSelect,
  };
  state.count += 1;
  suppressedBodyStyles.set(style, state);
  style.cursor = "col-resize";
  style.userSelect = "none";
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    state.count -= 1;
    if (state.count > 0) return;
    style.cursor = state.cursor;
    style.userSelect = state.userSelect;
    suppressedBodyStyles.delete(style);
  };
}

export function clampResizablePanelWidth(
  width: number,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  if (!Number.isFinite(width)) return defaultWidth;
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

export function resizablePanelWidthFromPointer({
  boundary,
  clientX,
  defaultWidth,
  edge,
  maxWidth,
  minWidth,
}: {
  boundary: number;
  clientX: number;
  defaultWidth: number;
  edge: ResizablePanelEdge;
  maxWidth: number;
  minWidth: number;
}): number {
  return clampResizablePanelWidth(
    edge === "left" ? boundary - clientX : clientX - boundary,
    defaultWidth,
    minWidth,
    maxWidth,
  );
}

export function resizablePanelWidthFromKey({
  currentWidth,
  defaultWidth,
  edge,
  key,
  maxWidth,
  minWidth,
  step = 16,
}: {
  currentWidth: number;
  defaultWidth: number;
  edge: ResizablePanelEdge;
  key: string;
  maxWidth: number;
  minWidth: number;
  step?: number;
}): number | null {
  if (key === "Home") return minWidth;
  if (key === "End") return maxWidth;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const direction = key === "ArrowLeft" ? -1 : 1;
  const edgeDirection = edge === "left" ? -1 : 1;
  return clampResizablePanelWidth(
    currentWidth + direction * edgeDirection * step,
    defaultWidth,
    minWidth,
    maxWidth,
  );
}

export function readResizablePanelWidth({
  defaultWidth,
  maxWidth,
  minWidth,
  storage,
  storageKey,
}: {
  defaultWidth: number;
  maxWidth: number;
  minWidth: number;
  storage?: ResizablePanelStorage | null;
  storageKey: string;
}): number {
  try {
    const target =
      storage ?? (typeof window === "undefined" ? null : window.localStorage);
    const stored = target?.getItem(storageKey);
    return stored === null || stored === undefined
      ? defaultWidth
      : clampResizablePanelWidth(
          Number(stored),
          defaultWidth,
          minWidth,
          maxWidth,
        );
  } catch {
    return defaultWidth;
  }
}

export function persistResizablePanelWidth({
  defaultWidth,
  maxWidth,
  minWidth,
  storage,
  storageKey,
  width,
}: {
  defaultWidth: number;
  maxWidth: number;
  minWidth: number;
  storage?: ResizablePanelStorage | null;
  storageKey: string;
  width: number;
}): void {
  try {
    const target =
      storage ?? (typeof window === "undefined" ? null : window.localStorage);
    target?.setItem(
      storageKey,
      String(clampResizablePanelWidth(width, defaultWidth, minWidth, maxWidth)),
    );
  } catch {
    // Blocked storage must not make panel resizing fail.
  }
}

export function ResizablePanel({
  ariaLabel,
  children,
  className,
  defaultWidth,
  edge = "left",
  handleClassName,
  handleDataSlot,
  maxWidth,
  minWidth,
  onWidthChange,
  open,
  shellDataSlot,
  storageKey,
  surfaceClassName,
  surfaceData,
  surfaceDataSlot,
  title,
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  defaultWidth: number;
  edge?: ResizablePanelEdge;
  handleClassName?: string;
  handleDataSlot?: string;
  maxWidth: number;
  minWidth: number;
  onWidthChange?(width: number): void;
  open: boolean;
  shellDataSlot?: string;
  storageKey: string;
  surfaceClassName?: string;
  surfaceData?: ResizablePanelDataAttributes;
  surfaceDataSlot?: string;
  title?: string;
}) {
  const [width, setWidth] = useState(() =>
    readResizablePanelWidth({
      defaultWidth,
      maxWidth,
      minWidth,
      storageKey,
    }),
  );
  const [resizing, setResizing] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(width);
  const pointerIdRef = useRef<number | null>(null);
  const boundaryRef = useRef(0);
  const startWidthRef = useRef(width);
  const restoreBodyStyleRef = useRef<(() => void) | null>(null);

  const applyWidth = useCallback(
    (nextWidth: number) => {
      const next = clampResizablePanelWidth(
        nextWidth,
        defaultWidth,
        minWidth,
        maxWidth,
      );
      widthRef.current = next;
      setWidth(next);
      onWidthChange?.(next);
    },
    [defaultWidth, maxWidth, minWidth, onWidthChange],
  );
  const restoreBodyStyle = useCallback(() => {
    restoreBodyStyleRef.current?.();
    restoreBodyStyleRef.current = null;
  }, []);
  const finishResize = useCallback(
    (persist: boolean, pointerId = pointerIdRef.current) => {
      if (pointerId === null || pointerIdRef.current !== pointerId) return;
      pointerIdRef.current = null;
      const handle = handleRef.current;
      if (handle?.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
      restoreBodyStyle();
      setResizing(false);
      if (!persist) {
        applyWidth(startWidthRef.current);
      } else if (widthRef.current !== startWidthRef.current) {
        persistResizablePanelWidth({
          defaultWidth,
          maxWidth,
          minWidth,
          storageKey,
          width: widthRef.current,
        });
      }
    },
    [
      applyWidth,
      defaultWidth,
      maxWidth,
      minWidth,
      restoreBodyStyle,
      storageKey,
    ],
  );

  useEffect(
    () => () => {
      pointerIdRef.current = null;
      restoreBodyStyle();
    },
    [restoreBodyStyle],
  );
  useEffect(() => {
    if (!open && pointerIdRef.current !== null) finishResize(false);
  }, [finishResize, open]);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointerIdRef.current !== null) return;
    event.preventDefault();
    const bounds = shellRef.current?.getBoundingClientRect();
    pointerIdRef.current = event.pointerId;
    boundaryRef.current =
      edge === "left"
        ? (bounds?.right ?? window.innerWidth)
        : (bounds?.left ?? 0);
    startWidthRef.current = widthRef.current;
    restoreBodyStyleRef.current = suppressResizablePanelBodyInteraction(
      document.body.style,
    );
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      pointerIdRef.current = null;
      restoreBodyStyle();
      return;
    }
    setResizing(true);
  };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    applyWidth(
      resizablePanelWidthFromPointer({
        boundary: boundaryRef.current,
        clientX: event.clientX,
        defaultWidth,
        edge,
        maxWidth,
        minWidth,
      }),
    );
  };
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = resizablePanelWidthFromKey({
      currentWidth: widthRef.current,
      defaultWidth,
      edge,
      key: event.key,
      maxWidth,
      minWidth,
    });
    if (next === null) return;
    event.preventDefault();
    if (next === widthRef.current) return;
    applyWidth(next);
    persistResizablePanelWidth({
      defaultWidth,
      maxWidth,
      minWidth,
      storageKey,
      width: next,
    });
  };

  return (
    <div
      className={cn(
        "group/resizable-panel relative h-full shrink-0",
        resizing
          ? "transition-none"
          : "transition-[width] duration-150 ease-out motion-reduce:transition-none",
        className,
      )}
      data-slot={shellDataSlot}
      data-resizing={resizing ? "true" : undefined}
      data-state={open ? "open" : "closed"}
      ref={shellRef}
      style={{ width: open ? width : 0 }}
    >
      <div className="absolute inset-0 overflow-hidden">
        <div
          {...surfaceData}
          aria-hidden={!open}
          className={cn(
            "absolute inset-y-0 h-full transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
            edge === "left" ? "right-0" : "left-0",
            open
              ? "translate-x-0 opacity-100"
              : cn(
                  "pointer-events-none opacity-0",
                  edge === "left" ? "translate-x-2" : "-translate-x-2",
                ),
            surfaceClassName,
          )}
          data-slot={surfaceDataSlot}
          inert={!open}
          style={{ width }}
        >
          {children}
        </div>
      </div>
      <div
        aria-label={ariaLabel}
        aria-orientation="vertical"
        aria-valuemax={maxWidth}
        aria-valuemin={minWidth}
        aria-valuenow={width}
        className={cn(
          "absolute inset-y-0 z-40 w-2 cursor-col-resize touch-none outline-none",
          edge === "left" ? "-left-1" : "-right-1",
          "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border after:opacity-0 after:transition-opacity after:duration-150",
          "group-hover/resizable-panel:after:opacity-100 group-focus-within/resizable-panel:after:opacity-100 hover:after:opacity-100 focus-visible:after:opacity-100",
          !open && "pointer-events-none opacity-0",
          resizing && "after:opacity-100",
          handleClassName,
        )}
        data-slot={handleDataSlot}
        onKeyDown={resizeWithKeyboard}
        onLostPointerCapture={(event) => finishResize(false, event.pointerId)}
        onPointerCancel={(event) => finishResize(false, event.pointerId)}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={(event) => finishResize(true, event.pointerId)}
        ref={handleRef}
        role="separator"
        tabIndex={open ? 0 : -1}
        title={title ?? ariaLabel}
      />
    </div>
  );
}
