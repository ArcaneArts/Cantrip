import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ProjectPaneRegion } from "@cantrip/protocol";
import { CopyPlus, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  StyledContextMenuItem,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";
import type { ProjectSurface } from "@/lib/project-surface";
import { TabColorMenuItem } from "./tab-color";

type MoveRegion = Extract<ProjectPaneRegion, "center" | "right" | "bottom">;

export function surfaceMoveTargets(
  surface: ProjectSurface,
  currentRegion: ProjectPaneRegion,
  onMove?: (region: MoveRegion) => void,
) {
  return onMove
    ? (["center", "right", "bottom"] as const)
        .filter(
          (region) =>
            region !== currentRegion &&
            surface.definition.supportedPlacements.includes(region),
        )
        .map((region) => ({
          label: `Move to ${region === "center" ? "Center" : region === "right" ? "Right" : "Bottom"}`,
          onSelect: () => onMove(region),
        }))
    : [];
}

export interface SurfaceMenuActions {
  colorKey?: string;
  deleteDisabled?: boolean;
  deleteIcon?: ReactNode;
  deleteLabel?: ReactNode;
  deleteTone?: "default" | "destructive";
  moveTargets?: ReturnType<typeof surfaceMoveTargets>;
  onClose?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  onKeepOpen?: () => void;
  onRename?: () => void;
  title: string;
}

export function SurfaceMenuItems({
  colorKey,
  deleteDisabled = false,
  deleteIcon,
  deleteLabel = "Delete Resource",
  deleteTone = "destructive",
  kind,
  moveTargets = [],
  onClose,
  onDelete,
  onDuplicate,
  onKeepOpen,
  onRename,
  title,
}: SurfaceMenuActions & { kind: "context" | "dropdown" }) {
  const Item =
    kind === "context" ? StyledContextMenuItem : StyledDropdownMenuItem;
  const Separator =
    kind === "context" ? ContextMenu.Separator : DropdownMenu.Separator;
  return (
    <>
      {colorKey ? (
        <TabColorMenuItem colorKey={colorKey} kind={kind} title={title} />
      ) : null}
      {onRename ? (
        <Item onSelect={onRename}>
          <Pencil className="size-4" /> Rename
        </Item>
      ) : null}
      {onDuplicate ? (
        <Item onSelect={onDuplicate}>
          <CopyPlus className="size-4" /> Duplicate
        </Item>
      ) : null}
      {onKeepOpen ? <Item onSelect={onKeepOpen}>Keep Open</Item> : null}
      {moveTargets.map((target) => (
        <Item key={target.label} onSelect={target.onSelect}>
          {target.label}
        </Item>
      ))}
      {onClose ? (
        <Item onSelect={onClose}>
          <X className="size-4" /> Close View
        </Item>
      ) : null}
      {onDelete ? (
        <>
          <Separator className="my-1 h-px bg-border" />
          <Item
            className={cn(
              deleteTone === "destructive" &&
                "text-destructive focus:bg-destructive/10",
            )}
            disabled={deleteDisabled}
            onSelect={onDelete}
          >
            {deleteIcon ?? <Trash2 className="size-4" />}
            {deleteDisabled ? "Stop agent before deleting" : deleteLabel}
          </Item>
        </>
      ) : null}
    </>
  );
}

export function InlineRenameLabel({
  ariaLabel,
  className,
  onCancel,
  onChange,
  onSubmit,
  value,
}: {
  ariaLabel: string;
  className?: string;
  onCancel(): void;
  onChange(value: string): void;
  onSubmit(): void;
  value: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      autoFocus
      aria-label={ariaLabel}
      data-elite-ignore=""
      className={cn(
        "h-7 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2",
        className,
      )}
      value={value}
      onBlur={onSubmit}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
        if (event.key === "Escape") onCancel();
      }}
    />
  );
}

export function SurfaceActionsMenu({
  align = "end",
  contentClassName,
  title,
  trigger,
  triggerClassName,
  ...actions
}: {
  align?: "start" | "center" | "end";
  contentClassName?: string;
  trigger?: ReactNode;
  triggerClassName?: string;
} & SurfaceMenuActions) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {trigger ?? (
          <Button
            data-actions-trigger
            size="icon"
            variant="ghost"
            className={cn(
              "size-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100",
              triggerClassName,
            )}
          >
            <MoreHorizontal className="size-3.5" />
            <span className="sr-only">Actions for {title}</span>
          </Button>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <StyledDropdownMenuContent
          align={align}
          className={cn("min-w-40", contentClassName)}
        >
          <SurfaceMenuItems {...actions} kind="dropdown" title={title} />
        </StyledDropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
