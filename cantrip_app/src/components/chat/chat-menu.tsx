import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ProjectWorktreeSummary } from "@cantrip/protocol";
import {
  CopyPlus,
  FolderTree,
  GitBranch,
  GitFork,
  History,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  styledMenuContentClassName,
  styledMenuItemClassName,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

interface Actions {
  deleteLabel?: string;
  deleteDisabled?: boolean;
  onClose?: () => void;
  onDelete(): void;
  onDuplicate(): void;
  onRename(): void;
  worktree?: ChatWorktreeActions;
}

export interface ChatWorktreeActions {
  currentWorktreeId: string;
  disabled?: boolean;
  mode: "agent-managed" | "pinned";
  onCreate(): void;
  onOpenExplorer(): void;
  onOpenHistory(): void;
  onOpenTerminal(): void;
  onSelect(worktreeId: string): void;
  onSetMode(mode: "agent-managed" | "pinned"): void;
  worktrees: ProjectWorktreeSummary[];
}

const contentClass = styledMenuContentClassName("min-w-40");
const itemClass = styledMenuItemClassName();

function WorktreeItems({
  actions,
  kind,
}: {
  actions: ChatWorktreeActions;
  kind: "context" | "dropdown";
}) {
  const Menu =
    kind === "context" ? ContextMenuPrimitive : DropdownMenuPrimitive;
  return (
    <Menu.Sub>
      <Menu.SubTrigger className={itemClass}>
        <GitFork className="size-4" /> Worktree
        <span className="ml-auto text-muted-foreground">›</span>
      </Menu.SubTrigger>
      <Menu.Portal>
        <Menu.SubContent sideOffset={4} className={contentClass}>
          {actions.worktrees.map((worktree) => (
            <Menu.Item
              key={worktree.id}
              className={itemClass}
              disabled={actions.disabled || worktree.lifecycleState !== "ready"}
              onSelect={() => actions.onSelect(worktree.id)}
            >
              {worktree.isPrimary ? (
                <GitBranch className="size-4" />
              ) : (
                <GitFork className="size-4 text-violet-500" />
              )}
              <span className="min-w-0 flex-1 truncate">{worktree.name}</span>
              {worktree.id === actions.currentWorktreeId ? "✓" : null}
            </Menu.Item>
          ))}
          <Menu.Item
            className={itemClass}
            disabled={actions.disabled}
            onSelect={actions.onCreate}
          >
            <Plus className="size-4" /> Create worktree…
          </Menu.Item>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item
            className={itemClass}
            disabled={actions.disabled}
            onSelect={() =>
              actions.onSetMode(
                actions.mode === "pinned" ? "agent-managed" : "pinned",
              )
            }
          >
            {actions.mode === "pinned" ? (
              <PinOff className="size-4" />
            ) : (
              <Pin className="size-4" />
            )}
            {actions.mode === "pinned"
              ? "Return to Agent managed"
              : "Pin to current"}
          </Menu.Item>
          <Menu.Item className={itemClass} onSelect={actions.onOpenTerminal}>
            <SquareTerminal className="size-4" /> Open Terminal here
          </Menu.Item>
          <Menu.Item className={itemClass} onSelect={actions.onOpenExplorer}>
            <FolderTree className="size-4" /> Open Explorer here
          </Menu.Item>
          <Menu.Item className={itemClass} onSelect={actions.onOpenHistory}>
            <History className="size-4" /> Open in Git
          </Menu.Item>
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  );
}

function ChatMenuItems({
  kind,
  deleteLabel = "Delete",
  deleteDisabled,
  onClose,
  onDelete,
  onDuplicate,
  onRename,
  worktree,
}: Actions & { kind: "context" | "dropdown" }) {
  const Menu =
    kind === "context" ? ContextMenuPrimitive : DropdownMenuPrimitive;
  return (
    <>
      <Menu.Item className={itemClass} onSelect={onRename}>
        <Pencil className="size-4" /> Rename
      </Menu.Item>
      <Menu.Item className={itemClass} onSelect={onDuplicate}>
        <CopyPlus className="size-4" /> Duplicate
      </Menu.Item>
      {worktree ? <WorktreeItems actions={worktree} kind={kind} /> : null}
      {onClose ? (
        <Menu.Item className={itemClass} onSelect={onClose}>
          <X className="size-4" /> Close View
        </Menu.Item>
      ) : null}
      <Menu.Separator className="my-1 h-px bg-border" />
      <Menu.Item
        className={cn(itemClass, "text-destructive focus:bg-destructive/10")}
        disabled={deleteDisabled}
        onSelect={onDelete}
      >
        <Trash2 className="size-4" />
        {deleteDisabled
          ? `Stop agent before ${deleteLabel.toLowerCase()}`
          : deleteLabel}
      </Menu.Item>
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
          <ChatMenuItems {...actions} kind="context" />
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
        <DropdownMenuPrimitive.Content align="end" className={contentClass}>
          <ChatMenuItems {...actions} kind="dropdown" />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
