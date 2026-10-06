import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { LayoutDashboard, Settings, Trash2 } from "lucide-react";
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
  onOpenOverview?(): void;
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

function ProjectMenuItems({
  kind,
  onOpenOverview,
  onOpenSettings,
  onRemove,
  onReveal,
  revealDisabled,
  revealLabel,
}: ProjectMenuActions & { kind: "context" | "dropdown" }) {
  const Menu =
    kind === "context" ? ContextMenuPrimitive : DropdownMenuPrimitive;
  const reveal = useRevealSelection(onReveal);
  return (
    <>
      {onOpenOverview ? (
        <Menu.Item className={itemClass} onSelect={onOpenOverview}>
          <LayoutDashboard className="size-4" /> Overview
        </Menu.Item>
      ) : null}
      <Menu.Item className={itemClass} onSelect={onOpenSettings}>
        <Settings className="size-4" /> Project Settings
      </Menu.Item>
      {onReveal ? (
        <Menu.Item
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
        </Menu.Item>
      ) : null}
      <Menu.Separator className="my-1 h-px bg-border" />
      <Menu.Item
        className={cn(itemClass, "text-destructive focus:bg-destructive/10")}
        onSelect={onRemove}
      >
        <Trash2 className="size-4" /> Remove project
      </Menu.Item>
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
          <ProjectMenuItems {...actions} kind="context" />
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
          <ProjectMenuItems {...actions} kind="dropdown" />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
