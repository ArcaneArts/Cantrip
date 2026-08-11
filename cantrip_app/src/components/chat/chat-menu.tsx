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
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  styledMenuContentClassName,
  styledMenuItemClassName,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

interface Actions {
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

function ContextWorktreeItems({ actions }: { actions: ChatWorktreeActions }) {
  return (
    <ContextMenuPrimitive.Sub>
      <ContextMenuPrimitive.SubTrigger className={itemClass}>
        <GitFork className="size-4" /> Worktree
        <span className="ml-auto text-muted-foreground">›</span>
      </ContextMenuPrimitive.SubTrigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.SubContent
          sideOffset={4}
          className={contentClass}
        >
          {actions.worktrees.map((worktree) => (
            <ContextMenuPrimitive.Item
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
            </ContextMenuPrimitive.Item>
          ))}
          <ContextMenuPrimitive.Item
            className={itemClass}
            disabled={actions.disabled}
            onSelect={actions.onCreate}
          >
            <Plus className="size-4" /> Create worktree…
          </ContextMenuPrimitive.Item>
          <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <ContextMenuPrimitive.Item
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
          </ContextMenuPrimitive.Item>
          <ContextMenuPrimitive.Item
            className={itemClass}
            onSelect={actions.onOpenTerminal}
          >
            <SquareTerminal className="size-4" /> Open Terminal here
          </ContextMenuPrimitive.Item>
          <ContextMenuPrimitive.Item
            className={itemClass}
            onSelect={actions.onOpenExplorer}
          >
            <FolderTree className="size-4" /> Open Explorer here
          </ContextMenuPrimitive.Item>
          <ContextMenuPrimitive.Item
            className={itemClass}
            onSelect={actions.onOpenHistory}
          >
            <History className="size-4" /> Open in Git
          </ContextMenuPrimitive.Item>
        </ContextMenuPrimitive.SubContent>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Sub>
  );
}

function ContextItems({ onDelete, onDuplicate, onRename, worktree }: Actions) {
  return (
    <>
      <ContextMenuPrimitive.Item className={itemClass} onSelect={onRename}>
        <Pencil className="size-4" /> Rename
      </ContextMenuPrimitive.Item>
      <ContextMenuPrimitive.Item className={itemClass} onSelect={onDuplicate}>
        <CopyPlus className="size-4" /> Duplicate
      </ContextMenuPrimitive.Item>
      {worktree ? <ContextWorktreeItems actions={worktree} /> : null}
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

function DropdownWorktreeItems({ actions }: { actions: ChatWorktreeActions }) {
  return (
    <DropdownMenuPrimitive.Sub>
      <DropdownMenuPrimitive.SubTrigger className={itemClass}>
        <GitFork className="size-4" /> Worktree
        <span className="ml-auto text-muted-foreground">›</span>
      </DropdownMenuPrimitive.SubTrigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.SubContent
          sideOffset={4}
          className={contentClass}
        >
          {actions.worktrees.map((worktree) => (
            <DropdownMenuPrimitive.Item
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
            </DropdownMenuPrimitive.Item>
          ))}
          <DropdownMenuPrimitive.Item
            className={itemClass}
            disabled={actions.disabled}
            onSelect={actions.onCreate}
          >
            <Plus className="size-4" /> Create worktree…
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <DropdownMenuPrimitive.Item
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
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            className={itemClass}
            onSelect={actions.onOpenTerminal}
          >
            <SquareTerminal className="size-4" /> Open Terminal here
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            className={itemClass}
            onSelect={actions.onOpenExplorer}
          >
            <FolderTree className="size-4" /> Open Explorer here
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            className={itemClass}
            onSelect={actions.onOpenHistory}
          >
            <History className="size-4" /> Open in Git
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.SubContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Sub>
  );
}

function DropdownItems({ onDelete, onDuplicate, onRename, worktree }: Actions) {
  return (
    <>
      <DropdownMenuPrimitive.Item className={itemClass} onSelect={onRename}>
        <Pencil className="size-4" /> Rename
      </DropdownMenuPrimitive.Item>
      <DropdownMenuPrimitive.Item className={itemClass} onSelect={onDuplicate}>
        <CopyPlus className="size-4" /> Duplicate
      </DropdownMenuPrimitive.Item>
      {worktree ? <DropdownWorktreeItems actions={worktree} /> : null}
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
        <DropdownMenuPrimitive.Content align="end" className={contentClass}>
          <DropdownItems {...actions} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
