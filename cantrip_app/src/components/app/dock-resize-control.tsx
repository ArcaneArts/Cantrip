import type { ProjectDockPresentationPreference } from "@cantrip/protocol";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

import { cn } from "@/lib/utils";

export function DockResizeControl({
  direction,
  fraction,
  label,
  mode,
  onDoubleClick,
  onKeyChange,
  onPointerBegin,
  onPointerMove,
  onPointerEnd,
  onPointerCancel,
  style,
}: {
  direction: "horizontal" | "vertical";
  fraction: number;
  label: string;
  mode: ProjectDockPresentationPreference["preferredMode"];
  onDoubleClick(): void;
  onKeyChange(key: string): void;
  onPointerBegin(event: PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: PointerEvent<HTMLDivElement>): void;
  onPointerEnd(event: PointerEvent<HTMLDivElement>): void;
  onPointerCancel(event: PointerEvent<HTMLDivElement>): void;
  style: CSSProperties;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "Enter",
        " ",
      ].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    onKeyChange(event.key);
  };
  return (
    <div
      aria-label={label}
      aria-orientation={direction}
      aria-valuemax={95}
      aria-valuemin={5}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuetext={`${label} ${mode === "closed" ? "closed" : mode === "full" ? "full view" : `${Math.round(fraction * 100)} percent`}`}
      className={cn(
        "group relative z-30 touch-none outline-none",
        direction === "vertical" ? "cursor-col-resize" : "cursor-row-resize",
      )}
      data-dock-resize-mode={mode}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onLostPointerCapture={onPointerEnd}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerBegin}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      role="separator"
      style={style}
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute bg-border opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100 motion-reduce:transition-none",
          direction === "vertical"
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        )}
      />
    </div>
  );
}
