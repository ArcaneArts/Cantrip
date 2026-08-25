import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Info, X } from "lucide-react";
import { type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  ResizablePanel,
  clampResizablePanelWidth,
  persistResizablePanelWidth,
  readResizablePanelWidth,
  resizablePanelWidthFromKey,
  resizablePanelWidthFromPointer,
  type ResizablePanelStorage,
} from "@/components/ui/resizable-panel";
import { cn } from "@/lib/utils";

export const DEFAULT_AGENT_INSPECT_WIDTH = 384;
export const MIN_AGENT_INSPECT_WIDTH = 300;
export const MAX_AGENT_INSPECT_WIDTH = 720;
export const AGENT_INSPECT_WIDTH_STORAGE_KEY =
  "cantrip:agent-inspect-panel-width";

export function clampAgentInspectWidth(width: number): number {
  return clampResizablePanelWidth(
    width,
    DEFAULT_AGENT_INSPECT_WIDTH,
    MIN_AGENT_INSPECT_WIDTH,
    MAX_AGENT_INSPECT_WIDTH,
  );
}

export function agentInspectWidthFromPointer(
  clientX: number,
  panelRight: number,
): number {
  return resizablePanelWidthFromPointer({
    boundary: panelRight,
    clientX,
    defaultWidth: DEFAULT_AGENT_INSPECT_WIDTH,
    edge: "left",
    maxWidth: MAX_AGENT_INSPECT_WIDTH,
    minWidth: MIN_AGENT_INSPECT_WIDTH,
  });
}

export function agentInspectWidthFromKey(
  currentWidth: number,
  key: string,
): number | null {
  return resizablePanelWidthFromKey({
    currentWidth,
    defaultWidth: DEFAULT_AGENT_INSPECT_WIDTH,
    edge: "left",
    key,
    maxWidth: MAX_AGENT_INSPECT_WIDTH,
    minWidth: MIN_AGENT_INSPECT_WIDTH,
  });
}

export function readAgentInspectWidth(
  storage?: ResizablePanelStorage | null,
): number {
  return readResizablePanelWidth({
    defaultWidth: DEFAULT_AGENT_INSPECT_WIDTH,
    maxWidth: MAX_AGENT_INSPECT_WIDTH,
    minWidth: MIN_AGENT_INSPECT_WIDTH,
    storage,
    storageKey: AGENT_INSPECT_WIDTH_STORAGE_KEY,
  });
}

export function persistAgentInspectWidth(
  width: number,
  storage?: ResizablePanelStorage | null,
): void {
  persistResizablePanelWidth({
    defaultWidth: DEFAULT_AGENT_INSPECT_WIDTH,
    maxWidth: MAX_AGENT_INSPECT_WIDTH,
    minWidth: MIN_AGENT_INSPECT_WIDTH,
    storage,
    storageKey: AGENT_INSPECT_WIDTH_STORAGE_KEY,
    width,
  });
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
  ariaLabel = "Agent activity inspector",
  children,
  icon,
  onClose,
  title = "Inspect",
}: {
  ariaLabel?: string;
  children?: ReactNode;
  icon?: ReactNode;
  onClose(): void;
  title?: string;
}) {
  return (
    <aside
      aria-label={ariaLabel}
      className="relative flex h-full min-h-0 w-full flex-col bg-background"
      data-slot="agent-inspect-panel"
    >
      <header
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-11 items-center gap-2 px-3"
        data-slot="agent-inspect-header"
      >
        {icon ?? <Info className="size-4 text-muted-foreground" />}
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <Button
          aria-label={`Close ${title}`}
          className="pointer-events-auto ml-auto size-7"
          onClick={onClose}
          size="icon"
          title={`Close ${title}`}
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </aside>
  );
}

function AgentInspectMobilePanel({
  ariaLabel,
  children,
  icon,
  onOpenChange,
  open,
  panelTitle,
}: {
  ariaLabel: string;
  children?: ReactNode;
  icon?: ReactNode;
  onOpenChange(open: boolean): void;
  open: boolean;
  panelTitle: string;
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
            {ariaLabel}
          </DialogPrimitive.Title>
          <AgentInspectPanel
            ariaLabel={ariaLabel}
            icon={icon}
            onClose={() => onOpenChange(false)}
            title={panelTitle}
          >
            {children}
          </AgentInspectPanel>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function AgentInspectPanelShell({
  ariaLabel = "Agent activity inspector",
  children,
  className,
  extendIntoProjectTabBar = false,
  headerIcon,
  onOpenChange,
  onWidthChange,
  open,
  overlay,
  panelTitle = "Inspect",
}: {
  ariaLabel?: string;
  children?: ReactNode;
  className?: string;
  extendIntoProjectTabBar?: boolean;
  headerIcon?: ReactNode;
  onOpenChange(open: boolean): void;
  onWidthChange?(width: number): void;
  open: boolean;
  overlay: boolean;
  panelTitle?: string;
}) {
  if (overlay) {
    return (
      <AgentInspectMobilePanel
        ariaLabel={ariaLabel}
        icon={headerIcon}
        onOpenChange={onOpenChange}
        open={open}
        panelTitle={panelTitle}
      >
        {children}
      </AgentInspectMobilePanel>
    );
  }

  return (
    <ResizablePanel
      ariaLabel={`Resize ${panelTitle} sidebar`}
      className={cn(
        className,
        extendIntoProjectTabBar && "top-[-2.5rem] h-auto",
      )}
      defaultWidth={DEFAULT_AGENT_INSPECT_WIDTH}
      handleDataSlot="agent-inspect-resize-handle"
      maxWidth={MAX_AGENT_INSPECT_WIDTH}
      minWidth={MIN_AGENT_INSPECT_WIDTH}
      onWidthChange={onWidthChange}
      open={open}
      shellDataSlot="agent-inspect-panel-shell"
      storageKey={AGENT_INSPECT_WIDTH_STORAGE_KEY}
      surfaceData={{
        "data-extends-into-project-tab-bar": extendIntoProjectTabBar
          ? "true"
          : undefined,
      }}
      surfaceClassName="bg-background"
      surfaceDataSlot="agent-inspect-panel-surface"
      title={`Drag to resize ${panelTitle} sidebar`}
    >
      <AgentInspectPanel
        ariaLabel={ariaLabel}
        icon={headerIcon}
        onClose={() => onOpenChange(false)}
        title={panelTitle}
      >
        {children}
      </AgentInspectPanel>
    </ResizablePanel>
  );
}
