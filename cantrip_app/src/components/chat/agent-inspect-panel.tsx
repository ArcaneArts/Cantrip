import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Info, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const DEFAULT_AGENT_INSPECT_WIDTH = 384;
export const MIN_AGENT_INSPECT_WIDTH = 300;
export const MAX_AGENT_INSPECT_WIDTH = 720;
export const AGENT_INSPECT_WIDTH_STORAGE_KEY =
  "cantrip:agent-inspect-panel-width";

interface WidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function clampAgentInspectWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_AGENT_INSPECT_WIDTH;
  return Math.min(
    MAX_AGENT_INSPECT_WIDTH,
    Math.max(MIN_AGENT_INSPECT_WIDTH, Math.round(width)),
  );
}

export function agentInspectWidthFromPointer(
  clientX: number,
  panelRight: number,
): number {
  return clampAgentInspectWidth(panelRight - clientX);
}

export function agentInspectWidthFromKey(
  currentWidth: number,
  key: string,
): number | null {
  if (key === "Home") return MIN_AGENT_INSPECT_WIDTH;
  if (key === "End") return MAX_AGENT_INSPECT_WIDTH;
  if (key === "ArrowLeft") {
    return clampAgentInspectWidth(currentWidth + 16);
  }
  if (key === "ArrowRight") {
    return clampAgentInspectWidth(currentWidth - 16);
  }
  return null;
}

export function readAgentInspectWidth(storage?: WidthStorage | null): number {
  try {
    const target =
      storage ?? (typeof window === "undefined" ? null : window.localStorage);
    const stored = target?.getItem(AGENT_INSPECT_WIDTH_STORAGE_KEY);
    return stored === null || stored === undefined
      ? DEFAULT_AGENT_INSPECT_WIDTH
      : clampAgentInspectWidth(Number(stored));
  } catch {
    return DEFAULT_AGENT_INSPECT_WIDTH;
  }
}

export function persistAgentInspectWidth(
  width: number,
  storage?: WidthStorage | null,
): void {
  try {
    const target =
      storage ?? (typeof window === "undefined" ? null : window.localStorage);
    target?.setItem(
      AGENT_INSPECT_WIDTH_STORAGE_KEY,
      String(clampAgentInspectWidth(width)),
    );
  } catch {
    // A blocked local-storage write should not break panel resizing.
  }
}

export function updateAgentInspectOpenChats(
  current: ReadonlySet<string>,
  chatId: string,
  open: boolean,
): Set<string> {
  const next = new Set(current);
  if (open) next.add(chatId);
  else next.delete(chatId);
  return next;
}

export function AgentInspectPanel({
  active,
  children,
  onClose,
}: {
  active: boolean;
  children?: ReactNode;
  onClose(): void;
}) {
  return (
    <aside
      aria-label="Agent activity inspector"
      className="flex h-full min-h-0 w-full flex-col bg-background"
      data-slot="agent-inspect-panel"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Info className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Inspect</h2>
        <Button
          aria-label="Close Inspect"
          className="ml-auto size-7"
          onClick={onClose}
          size="icon"
          title="Close Inspect"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {active ? (
          children
        ) : (
          <div
            className="grid h-full place-items-center p-6 text-center"
            data-slot="agent-inspect-inactive"
          >
            <div>
              <p className="text-sm font-medium">Inactive</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Shows activity when agent is working
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function AgentInspectMobilePanel({
  active,
  children,
  onOpenChange,
  open,
}: {
  active: boolean;
  children?: ReactNode;
  onOpenChange(open: boolean): void;
  open: boolean;
}) {
  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-black/35 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="mobile-safe-bottom mobile-safe-top fixed inset-0 z-[90] min-h-0 overflow-hidden bg-background shadow-2xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right motion-reduce:animate-none"
          data-slot="agent-inspect-mobile-overlay"
        >
          <DialogPrimitive.Title className="sr-only">
            Agent activity inspector
          </DialogPrimitive.Title>
          <AgentInspectPanel
            active={active}
            onClose={() => onOpenChange(false)}
          >
            {children}
          </AgentInspectPanel>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function AgentInspectPanelShell({
  active,
  children,
  className,
  onOpenChange,
  onWidthChange,
  open,
  overlay,
}: {
  active: boolean;
  children?: ReactNode;
  className?: string;
  onOpenChange(open: boolean): void;
  onWidthChange?(width: number): void;
  open: boolean;
  overlay: boolean;
}) {
  const [width, setWidth] = useState(readAgentInspectWidth);
  const [resizing, setResizing] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(width);
  const resizePointerIdRef = useRef<number | null>(null);
  const resizeRightRef = useRef(0);
  const resizeStartWidthRef = useRef(width);
  const resizeBodyStyleRef = useRef<{
    cursor: string;
    userSelect: string;
  } | null>(null);

  const applyWidth = (nextWidth: number) => {
    const next = clampAgentInspectWidth(nextWidth);
    widthRef.current = next;
    setWidth(next);
    onWidthChange?.(next);
  };
  const restoreBodyStyle = () => {
    const previous = resizeBodyStyleRef.current;
    if (!previous || typeof document === "undefined") return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    resizeBodyStyleRef.current = null;
  };
  useEffect(() => restoreBodyStyle, []);

  if (overlay) {
    return (
      <AgentInspectMobilePanel
        active={active}
        onOpenChange={onOpenChange}
        open={open}
      >
        {children}
      </AgentInspectMobilePanel>
    );
  }

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizePointerIdRef.current = event.pointerId;
    resizeRightRef.current =
      shellRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    resizeStartWidthRef.current = widthRef.current;
    resizeBodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizePointerIdRef.current !== event.pointerId) return;
    applyWidth(
      agentInspectWidthFromPointer(event.clientX, resizeRightRef.current),
    );
  };
  const finishResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    persist: boolean,
  ) => {
    if (resizePointerIdRef.current !== event.pointerId) return;
    resizePointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    restoreBodyStyle();
    setResizing(false);
    if (!persist) {
      applyWidth(resizeStartWidthRef.current);
      return;
    }
    if (widthRef.current !== resizeStartWidthRef.current) {
      persistAgentInspectWidth(widthRef.current);
    }
  };
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = agentInspectWidthFromKey(widthRef.current, event.key);
    if (next === null) return;
    event.preventDefault();
    if (next === widthRef.current) return;
    applyWidth(next);
    persistAgentInspectWidth(next);
  };

  return (
    <div
      className={cn(
        "group/agent-inspect relative h-full shrink-0",
        resizing
          ? "transition-none"
          : "transition-[width] duration-150 ease-out motion-reduce:transition-none",
        className,
      )}
      data-slot="agent-inspect-panel-shell"
      data-state={open ? "open" : "closed"}
      ref={shellRef}
      style={{ width: open ? width : 0 }}
    >
      <div className="absolute inset-0 overflow-hidden">
        <div
          aria-hidden={!open}
          className={cn(
            "absolute inset-y-0 right-0 h-full bg-background transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
            open
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-2 opacity-0",
          )}
          data-slot="agent-inspect-panel-surface"
          inert={!open}
          style={{ width }}
        >
          <AgentInspectPanel
            active={active}
            onClose={() => onOpenChange(false)}
          >
            {children}
          </AgentInspectPanel>
        </div>
      </div>
      <div
        aria-label="Resize Inspect sidebar"
        aria-orientation="vertical"
        aria-valuemax={MAX_AGENT_INSPECT_WIDTH}
        aria-valuemin={MIN_AGENT_INSPECT_WIDTH}
        aria-valuenow={width}
        className={cn(
          "absolute inset-y-0 -left-1 z-40 w-2 cursor-col-resize touch-none outline-none",
          "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border after:opacity-0 after:transition-opacity after:duration-150",
          "group-hover/agent-inspect:after:opacity-100 group-focus-within/agent-inspect:after:opacity-100 hover:after:opacity-100 focus-visible:after:opacity-100",
          !open && "pointer-events-none opacity-0",
          resizing && "after:opacity-100",
        )}
        data-slot="agent-inspect-resize-handle"
        onKeyDown={resizeWithKeyboard}
        onPointerCancel={(event) => finishResize(event, false)}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={(event) => finishResize(event, true)}
        role="separator"
        tabIndex={open ? 0 : -1}
        title="Drag to resize Inspect sidebar"
      />
    </div>
  );
}
