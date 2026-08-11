import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CopyPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const surfaceMenuContentClass =
  "z-50 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg";
export const surfaceMenuItemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

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
  return (
    <input
      autoFocus
      aria-label={ariaLabel}
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
  onDelete,
  onDuplicate,
  onRename,
  title,
  trigger,
  triggerClassName,
}: {
  align?: "start" | "center" | "end";
  contentClassName?: string;
  onDelete(): void;
  onDuplicate?: () => void;
  onRename(): void;
  title: string;
  trigger?: ReactNode;
  triggerClassName?: string;
}) {
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
        <DropdownMenu.Content
          align={align}
          className={cn(surfaceMenuContentClass, contentClassName)}
        >
          <DropdownMenu.Item
            className={surfaceMenuItemClass}
            onSelect={onRename}
          >
            <Pencil className="size-4" /> Rename
          </DropdownMenu.Item>
          {onDuplicate ? (
            <DropdownMenu.Item
              className={surfaceMenuItemClass}
              onSelect={onDuplicate}
            >
              <CopyPlus className="size-4" /> Duplicate
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            className={cn(
              surfaceMenuItemClass,
              "text-destructive focus:bg-destructive/10",
            )}
            onSelect={onDelete}
          >
            <Trash2 className="size-4" /> Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
