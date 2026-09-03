import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Settings, Trash2 } from "lucide-react";
import { useRef, type ReactNode } from "react";

import {
  NativeFolderRevealIcon,
  useShiftKeyHeld,
} from "@/components/ui/native-folder-reveal-icon";
import {
  styledMenuContentClassName,
  styledMenuItemClassName,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

export interface ProjectMenuActions {
  onOpenSettings(): void;
  onRemove(): void;
  onReveal?: (localFolder: boolean) => void;
  revealDisabled?: boolean;
  revealLabel?: string;
}

const contentClass = styledMenuContentClassName("z-[100] min-w-36");
const itemClass = styledMenuItemClassName();

function useRevealSelection(onReveal?: (localFolder: boolean) => void) {
  const revealLocalFolder = useRef(false);
  const shiftKeyHeld = useShiftKeyHeld();
  return {
    onClick: (event: { shiftKey: boolean }) => {
      revealLocalFolder.current = event.shiftKey;
    },
    onSelect: () => {
      const localFolder = revealLocalFolder.current;
      revealLocalFolder.current = false;
      onReveal?.(localFolder);
    },
    shiftKeyHeld,
  };
}

function ContextItems({
  onOpenSettings,
  onRemove,
  onReveal,
  revealDisabled,
  revealLabel,
}: ProjectMenuActions) {
  const reveal = useRevealSelection(onReveal);
  return (
    <>
      <ContextMenuPrimitive.Item
        className={itemClass}
        onSelect={onOpenSettings}
      >
        <Settings className="size-4" /> Settings
      </ContextMenuPrimitive.Item>
      {onReveal ? (
        <ContextMenuPrimitive.Item
          className={itemClass}
          disabled={revealDisabled}
          onClick={reveal.onClick}
          onSelect={reveal.onSelect}
        >
          <NativeFolderRevealIcon
            className="size-4"
            localFolder={reveal.shiftKeyHeld}
          />{" "}
          {revealLabel}
        </ContextMenuPrimitive.Item>
      ) : null}
      <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />
      <ContextMenuPrimitive.Item
        className={cn(itemClass, "text-destructive focus:bg-destructive/10")}
        onSelect={onRemove}
      >
        <Trash2 className="size-4" /> Remove project
      </ContextMenuPrimitive.Item>
    </>
  );
}

function DropdownItems({
  onOpenSettings,
  onRemove,
  onReveal,
  revealDisabled,
  revealLabel,
}: ProjectMenuActions) {
  const reveal = useRevealSelection(onReveal);
  return (
    <>
      <DropdownMenuPrimitive.Item
        className={itemClass}
        onSelect={onOpenSettings}
      >
        <Settings className="size-4" /> Settings
      </DropdownMenuPrimitive.Item>
      {onReveal ? (
        <DropdownMenuPrimitive.Item
          className={itemClass}
          disabled={revealDisabled}
          onClick={reveal.onClick}
          onSelect={reveal.onSelect}
        >
          <NativeFolderRevealIcon
            className="size-4"
            localFolder={reveal.shiftKeyHeld}
          />{" "}
          {revealLabel}
        </DropdownMenuPrimitive.Item>
      ) : null}
      <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
      <DropdownMenuPrimitive.Item
        className={cn(itemClass, "text-destructive focus:bg-destructive/10")}
        onSelect={onRemove}
      >
        <Trash2 className="size-4" /> Remove project
      </DropdownMenuPrimitive.Item>
    </>
  );
}

export function ProjectContextMenu({
  actions,
  children,
}: {
  actions: ProjectMenuActions;
  children: ReactNode;
}) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          className={contentClass}
          data-slot="project-actions-context-menu"
        >
          <ContextItems {...actions} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

export function ProjectDropdownMenu({
  actions,
  children,
}: {
  actions: ProjectMenuActions;
  children: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        {children}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          className={contentClass}
          data-slot="project-actions-dropdown-menu"
          sideOffset={4}
        >
          <DropdownItems {...actions} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
