import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CopyPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Actions {
  onDelete(): void;
  onDuplicate(): void;
  onRename(): void;
}

const contentClass =
  "z-50 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg";
const itemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent";

function ContextItems({ onDelete, onDuplicate, onRename }: Actions) {
  return (
    <>
      <ContextMenuPrimitive.Item className={itemClass} onSelect={onRename}>
        <Pencil className="size-4" /> Rename
      </ContextMenuPrimitive.Item>
      <ContextMenuPrimitive.Item className={itemClass} onSelect={onDuplicate}>
        <CopyPlus className="size-4" /> Duplicate
      </ContextMenuPrimitive.Item>
      <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />
      <ContextMenuPrimitive.Item
        className={cn(itemClass, "text-destructive focus:bg-destructive/10")}
        onSelect={onDelete}
      >
        <Trash2 className="size-4" /> Delete
      </ContextMenuPrimitive.Item>
    </>
  );
}

function DropdownItems({ onDelete, onDuplicate, onRename }: Actions) {
  return (
    <>
      <DropdownMenuPrimitive.Item className={itemClass} onSelect={onRename}>
        <Pencil className="size-4" /> Rename
      </DropdownMenuPrimitive.Item>
      <DropdownMenuPrimitive.Item className={itemClass} onSelect={onDuplicate}>
        <CopyPlus className="size-4" /> Duplicate
      </DropdownMenuPrimitive.Item>
      <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
      <DropdownMenuPrimitive.Item
        className={cn(itemClass, "text-destructive focus:bg-destructive/10")}
        onSelect={onDelete}
      >
        <Trash2 className="size-4" /> Delete
      </DropdownMenuPrimitive.Item>
    </>
  );
}

export function ChatContextMenu({
  actions,
  children,
}: {
  actions: Actions;
  children: ReactNode;
}) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className={contentClass}>
          <ContextItems {...actions} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

export function ChatDropdownMenu({
  actions,
  title,
}: {
  actions: Actions;
  title: string;
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" />
          <span className="sr-only">Actions for {title}</span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="start" className={contentClass}>
          <DropdownItems {...actions} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
