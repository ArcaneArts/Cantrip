import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  GitCommitVertical,
  MoreHorizontal,
  PencilLine,
  RotateCcw,
  WandSparkles,
} from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  CommitActionKind,
  CommitActionRequest,
  CommitActionTarget,
} from "./git-commit-action-dialog";

const itemClass =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-xs outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

function actionItems(
  Item: typeof ContextMenuPrimitive.Item | typeof DropdownMenuPrimitive.Item,
  target: CommitActionTarget,
  onAction: (request: CommitActionRequest) => void,
) {
  const item = (
    kind: CommitActionKind,
    label: string,
    Icon: typeof RotateCcw,
    disabled = false,
  ) => (
    <Item
      key={kind}
      className={cn(
        itemClass,
        kind === "revert" && "text-destructive focus:text-destructive",
      )}
      disabled={disabled}
      onSelect={() => onAction({ kind, target })}
    >
      <Icon className="size-3.5" /> {label}
    </Item>
  );
  return [
    item("cherryPick", "Cherry-pick…", GitCommitVertical),
    item("revert", "Revert…", RotateCcw),
    item("fixup", "Create fixup…", WandSparkles),
    item("amend", "Amend HEAD…", PencilLine, !target.isHead),
  ];
}

export function GitCommitContextMenu({
  children,
  onAction,
  target,
}: {
  children: ReactElement;
  onAction(request: CommitActionRequest): void;
  target: CommitActionTarget;
}) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className="z-50 min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
          {actionItems(ContextMenuPrimitive.Item, target, onAction)}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

export function GitCommitActionsDropdown({
  onAction,
  target,
}: {
  onAction(request: CommitActionRequest): void;
  target: CommitActionTarget;
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          title="Commit actions"
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Commit actions</span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          className="z-50 min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {actionItems(DropdownMenuPrimitive.Item, target, onAction)}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
