import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type {
  BrowserSummary,
  ChatSummary,
  CodeTabSummary,
  ExplorerSummary,
  ProjectSummary,
  ProjectTabLayoutSummary,
  ProjectWorktreeSummary,
  ProjectViewSummary,
  TerminalSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import {
  CircleAlert,
  CircleHelp,
  CirclePause,
  Code2,
  CopyPlus,
  FolderGit2,
  FolderOpen,
  FolderTree,
  GitCommitHorizontal,
  Globe2,
  GripVertical,
  Loader2,
  MessageSquare,
  MonitorUp,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import {
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import {
  ChatContextMenu,
  ChatDropdownMenu,
  type ChatWorktreeActions,
} from "@/components/chat/chat-menu";
import { Button } from "@/components/ui/button";
import { ProjectSurfaceIcon } from "@/components/workspace/project-surface-icon";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ProjectTabGroupVisualKind } from "@/lib/project-tab-group";
import {
  type WorkspaceDndData,
  workspaceSidebarDropId,
} from "@/lib/workspace-dnd-model";
import {
  WorktreeIndicator,
  type WorktreeStatusMap,
} from "@/components/worktrees/worktree-control";

const projectId = (id: string) => `project:${id}`;
const chatId = (id: string) => `chat:${id}`;
const terminalId = (id: string) => `terminal:${id}`;
const explorerId = (id: string) => `explorer:${id}`;
const browserId = (id: string) => `browser:${id}`;
const codeId = (id: string) => `code:${id}`;
const viewId = (id: string) => `view:${id}`;

function openActionsMenu(event: ReactMouseEvent<HTMLElement>) {
  const trigger = event.currentTarget.querySelector<HTMLButtonElement>(
    "[data-actions-trigger]",
  );
  if (!trigger) return;
  event.preventDefault();
  trigger.click();
}
const menuContentClass =
  "z-50 min-w-36 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg";
const menuItemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

function DragHandle({
  listeners,
  attributes,
}: {
  listeners?: object;
  attributes: object;
}) {
  return (
    <button
      type="button"
      className="grid size-6 shrink-0 touch-none place-items-center rounded text-muted-foreground/50 opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:opacity-100"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-3.5" />
      <span className="sr-only">Drag to reorder</span>
    </button>
  );
}

function SortableChat({
  active,
  chat,
  editing,
  onDelete,
  onDuplicate,
  onRename,
  onSelect,
  renameValue,
  setRenameValue,
  submitRename,
  workers,
  worktree,
  worktreeActions,
  worktreeStatus,
}: {
  active: boolean;
  chat: ChatSummary;
  editing: boolean;
  onDelete(): void;
  onDuplicate(): void;
  onRename(): void;
  onSelect(): void;
  renameValue: string;
  setRenameValue(value: string): void;
  submitRename(): void;
  workers: WorkerSummary[];
  worktree?: ProjectWorktreeSummary;
  worktreeActions?: ChatWorktreeActions;
  worktreeStatus?: WorktreeStatusMap[string];
}) {
  const sortable = useSortable({ id: chatId(chat.id) });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  const actions = {
    onDelete,
    onDuplicate,
    onRename,
    worktree: worktreeActions,
  };
  return (
    <ChatContextMenu actions={actions}>
      <div
        ref={sortable.setNodeRef}
        style={style}
        className={cn(
          "group flex min-w-0 items-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
          active && "bg-muted text-foreground",
        )}
      >
        <DragHandle
          attributes={sortable.attributes}
          listeners={sortable.listeners}
        />
        {editing ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitRename();
              if (event.key === "Escape") onRename();
            }}
            className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
            aria-label={`Rename ${chat.title}`}
          />
        ) : (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
            onClick={onSelect}
            onDoubleClick={(event) => {
              event.preventDefault();
              onRename();
            }}
          >
            <MessageSquare className="size-3.5 shrink-0" />
            <span className="truncate">{chat.title}</span>
            {chat.hasPendingPlanQuestion ? (
              <CircleHelp
                className="ml-auto size-3.5 text-amber-500"
                aria-label="Codex is waiting for a Plan Mode answer"
              />
            ) : chat.automationPaused ? (
              <CirclePause
                className="ml-auto size-3.5 text-amber-500"
                aria-label="Chat automation is paused"
              />
            ) : chat.status === "running" ? (
              <Loader2 className="ml-auto size-3 animate-spin" />
            ) : null}
          </button>
        )}
        {!editing ? (
          <WorktreeIndicator
            leaseOwner={chat.title}
            status={worktreeStatus}
            workers={workers}
            worktree={worktree}
          />
        ) : null}
        {!editing ? (
          <ChatDropdownMenu actions={actions} title={chat.title} />
        ) : null}
      </div>
    </ChatContextMenu>
  );
}

function TerminalTab({
  active,
  editing,
  onDelete,
  onRename,
  onSelect,
  renameValue,
  setRenameValue,
  submitRename,
  terminal,
  workers,
  worktree,
  worktreeStatus,
}: {
  active: boolean;
  editing: boolean;
  onDelete(): void;
  onRename(): void;
  onSelect(): void;
  renameValue: string;
  setRenameValue(value: string): void;
  submitRename(): void;
  terminal: TerminalSummary;
  workers: WorkerSummary[];
  worktree?: ProjectWorktreeSummary;
  worktreeStatus?: WorktreeStatusMap[string];
}) {
  const sortable = useSortable({ id: terminalId(terminal.id) });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      onContextMenu={openActionsMenu}
      className={cn(
        "group flex min-w-0 items-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <DragHandle
        attributes={sortable.attributes}
        listeners={sortable.listeners}
      />
      {editing ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitRename();
            if (event.key === "Escape") onRename();
          }}
          className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
          aria-label={`Rename ${terminal.title}`}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRename();
          }}
        >
          <SquareTerminal className="size-3.5 shrink-0" />
          <span className="truncate">{terminal.title}</span>
          <span
            className={cn(
              "ml-auto size-[5px] rounded-full bg-muted-foreground/40",
              terminal.status === "running" && "bg-emerald-400",
              terminal.status === "failed" && "bg-red-400",
            )}
          />
        </button>
      )}
      {!editing ? (
        <WorktreeIndicator
          status={worktreeStatus}
          workers={workers}
          worktree={worktree}
        />
      ) : null}
      {!editing ? (
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
              data-actions-trigger
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
              <span className="sr-only">Actions for {terminal.title}</span>
            </Button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              className={menuContentClass}
            >
              <DropdownMenuPrimitive.Item
                className={menuItemClass}
                onSelect={onRename}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                className={cn(
                  menuItemClass,
                  "text-destructive focus:bg-destructive/10",
                )}
                onSelect={onDelete}
              >
                <Trash2 className="size-4" /> Delete
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      ) : null}
    </div>
  );
}

function ExplorerTab({
  active,
  editing,
  explorer,
  onDelete,
  onRename,
  onSelect,
  renameValue,
  setRenameValue,
  submitRename,
  workers,
  worktree,
  worktreeStatus,
}: {
  active: boolean;
  editing: boolean;
  explorer: ExplorerSummary;
  onDelete(): void;
  onRename(): void;
  onSelect(): void;
  renameValue: string;
  setRenameValue(value: string): void;
  submitRename(): void;
  workers: WorkerSummary[];
  worktree?: ProjectWorktreeSummary;
  worktreeStatus?: WorktreeStatusMap[string];
}) {
  const sortable = useSortable({ id: explorerId(explorer.id) });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      onContextMenu={openActionsMenu}
      className={cn(
        "group flex min-w-0 items-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <DragHandle
        attributes={sortable.attributes}
        listeners={sortable.listeners}
      />
      {editing ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitRename();
            if (event.key === "Escape") onRename();
          }}
          className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
          aria-label={`Rename ${explorer.title}`}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRename();
          }}
        >
          <FolderTree className="size-3.5 shrink-0" />
          <span className="truncate">{explorer.title}</span>
        </button>
      )}
      {!editing ? (
        <WorktreeIndicator
          status={worktreeStatus}
          workers={workers}
          worktree={worktree}
        />
      ) : null}
      {!editing ? (
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
              data-actions-trigger
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
              <span className="sr-only">Actions for {explorer.title}</span>
            </Button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              className={menuContentClass}
            >
              <DropdownMenuPrimitive.Item
                className={menuItemClass}
                onSelect={onRename}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                className={cn(
                  menuItemClass,
                  "text-destructive focus:bg-destructive/10",
                )}
                onSelect={onDelete}
              >
                <Trash2 className="size-4" /> Delete
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      ) : null}
    </div>
  );
}

function CodeTab({
  active,
  codeTab,
  editing,
  onDelete,
  onRename,
  onSelect,
  renameValue,
  setRenameValue,
  submitRename,
  workers,
  worktree,
  worktreeStatus,
}: {
  active: boolean;
  codeTab: CodeTabSummary;
  editing: boolean;
  onDelete(): void;
  onRename(): void;
  onSelect(): void;
  renameValue: string;
  setRenameValue(value: string): void;
  submitRename(): void;
  workers: WorkerSummary[];
  worktree?: ProjectWorktreeSummary;
  worktreeStatus?: WorktreeStatusMap[string];
}) {
  const sortable = useSortable({ id: codeId(codeTab.id) });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      onContextMenu={openActionsMenu}
      className={cn(
        "group flex min-w-0 items-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <DragHandle
        attributes={sortable.attributes}
        listeners={sortable.listeners}
      />
      {editing ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitRename();
            if (event.key === "Escape") onRename();
          }}
          className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
          aria-label={`Rename ${codeTab.title}`}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRename();
          }}
        >
          <Code2 className="size-3.5 shrink-0" />
          <span className="truncate">{codeTab.title}</span>
          <span
            className={cn(
              "ml-auto size-[5px] rounded-full bg-muted-foreground/40",
              codeTab.status === "running" && "bg-emerald-400",
              codeTab.status === "starting" && "animate-pulse bg-amber-500",
              codeTab.status === "failed" && "bg-red-400",
            )}
            title={`Editor ${codeTab.status}`}
          />
        </button>
      )}
      {!editing ? (
        <WorktreeIndicator
          status={worktreeStatus}
          workers={workers}
          worktree={worktree}
        />
      ) : null}
      {!editing ? (
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
              data-actions-trigger
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
              <span className="sr-only">Actions for {codeTab.title}</span>
            </Button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              className={menuContentClass}
            >
              <DropdownMenuPrimitive.Item
                className={menuItemClass}
                onSelect={onRename}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                className={cn(
                  menuItemClass,
                  "text-destructive focus:bg-destructive/10",
                )}
                onSelect={onDelete}
              >
                <Trash2 className="size-4" /> Delete
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      ) : null}
    </div>
  );
}

function BrowserTab({
  active,
  browser,
  editing,
  onDelete,
  onRename,
  onSelect,
  renameValue,
  setRenameValue,
  submitRename,
}: {
  active: boolean;
  browser: BrowserSummary;
  editing: boolean;
  onDelete(): void;
  onRename(): void;
  onSelect(): void;
  renameValue: string;
  setRenameValue(value: string): void;
  submitRename(): void;
}) {
  const sortable = useSortable({ id: browserId(browser.id) });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      onContextMenu={openActionsMenu}
      className={cn(
        "group flex min-w-0 items-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <DragHandle
        attributes={sortable.attributes}
        listeners={sortable.listeners}
      />
      {editing ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitRename();
            if (event.key === "Escape") onRename();
          }}
          className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
          aria-label={`Rename ${browser.title}`}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRename();
          }}
        >
          <Globe2 className="size-3.5 shrink-0" />
          <span className="truncate">{browser.title}</span>
        </button>
      )}
      {!editing ? (
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
              data-actions-trigger
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
              <span className="sr-only">Actions for {browser.title}</span>
            </Button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              className={menuContentClass}
            >
              <DropdownMenuPrimitive.Item
                className={menuItemClass}
                onSelect={onRename}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                className={cn(
                  menuItemClass,
                  "text-destructive focus:bg-destructive/10",
                )}
                onSelect={onDelete}
              >
                <Trash2 className="size-4" /> Delete
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      ) : null}
    </div>
  );
}

function ProjectViewTab({
  active,
  editing,
  onDelete,
  onRename,
  onSelect,
  renameValue,
  setRenameValue,
  submitRename,
  view,
  workers,
  worktree,
  worktreeStatus,
}: {
  active: boolean;
  editing: boolean;
  onDelete(): void;
  onRename(): void;
  onSelect(): void;
  renameValue: string;
  setRenameValue(value: string): void;
  submitRename(): void;
  view: ProjectViewSummary;
  workers: WorkerSummary[];
  worktree?: ProjectWorktreeSummary;
  worktreeStatus?: WorktreeStatusMap[string];
}) {
  const sortable = useSortable({ id: viewId(view.id) });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  const Icon = view.kind === "remote-desktop" ? MonitorUp : GitCommitHorizontal;
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      onContextMenu={openActionsMenu}
      className={cn(
        "group flex min-w-0 items-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <DragHandle
        attributes={sortable.attributes}
        listeners={sortable.listeners}
      />
      {editing ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitRename();
            if (event.key === "Escape") onRename();
          }}
          className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
          aria-label={`Rename ${view.title}`}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRename();
          }}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{view.title}</span>
        </button>
      )}
      {!editing && view.kind === "history" ? (
        <WorktreeIndicator
          status={worktreeStatus}
          workers={workers}
          worktree={worktree}
        />
      ) : null}
      {!editing ? (
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
              data-actions-trigger
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
              <span className="sr-only">Actions for {view.title}</span>
            </Button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              className={menuContentClass}
            >
              <DropdownMenuPrimitive.Item
                className={menuItemClass}
                onSelect={onRename}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                className={cn(
                  menuItemClass,
                  "text-destructive focus:bg-destructive/10",
                )}
                onSelect={onDelete}
              >
                <Trash2 className="size-4" /> Delete
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      ) : null}
    </div>
  );
}

function GroupedSidebarTab({
  active,
  count,
  editing,
  onDelete,
  onDuplicate,
  onRename,
  onSelect,
  renameValue,
  setRenameValue,
  sortId,
  submitRename,
  title,
  visualKind,
}: {
  active: boolean;
  count: number;
  editing: boolean;
  onDelete(): void;
  onDuplicate?: () => void;
  onRename(): void;
  onSelect(): void;
  renameValue: string;
  setRenameValue(value: string): void;
  sortId: string;
  submitRename(): void;
  title: string;
  visualKind: ProjectTabGroupVisualKind;
}) {
  const sortable = useSortable({ id: sortId });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      onContextMenu={openActionsMenu}
      className={cn(
        "group flex min-w-0 items-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <DragHandle
        attributes={sortable.attributes}
        listeners={sortable.listeners}
      />
      {editing ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitRename();
            if (event.key === "Escape") onRename();
          }}
          className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs text-foreground outline-none ring-ring focus:ring-2"
          aria-label={`Rename ${title}`}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRename();
          }}
        >
          <ProjectSurfaceIcon kind={visualKind} className="size-3.5 shrink-0" />
          <span className="truncate">{title}</span>
        </button>
      )}
      {!editing ? (
        <div className="relative mr-1 size-6 shrink-0">
          <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-full bg-background/70 text-[10px] tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 [@media(pointer:coarse)]:opacity-0">
            {count}
          </span>
          <DropdownMenuPrimitive.Root>
            <DropdownMenuPrimitive.Trigger asChild>
              <button
                data-actions-trigger
                type="button"
                className="absolute inset-0 grid place-items-center rounded opacity-0 hover:bg-background/70 group-hover:opacity-100 focus:bg-background focus:opacity-100 data-[state=open]:bg-background data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
                aria-label={`Actions for ${title}`}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuPrimitive.Trigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.Content
                align="end"
                className={menuContentClass}
              >
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={onRename}
                >
                  <Pencil className="size-4" /> Rename
                </DropdownMenuPrimitive.Item>
                {onDuplicate ? (
                  <DropdownMenuPrimitive.Item
                    className={menuItemClass}
                    onSelect={onDuplicate}
                  >
                    <CopyPlus className="size-4" /> Duplicate
                  </DropdownMenuPrimitive.Item>
                ) : null}
                <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
                <DropdownMenuPrimitive.Item
                  className={cn(
                    menuItemClass,
                    "text-destructive focus:bg-destructive/10",
                  )}
                  onSelect={onDelete}
                >
                  <Trash2 className="size-4" /> Delete
                </DropdownMenuPrimitive.Item>
              </DropdownMenuPrimitive.Content>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Root>
        </div>
      ) : null}
    </div>
  );
}

function SortableProject({
  active,
  children,
  creatingChat,
  creatingBrowser,
  creatingExplorer,
  creatingCode,
  creatingRemoteDesktop,
  creatingTerminal,
  creatingView,
  onCreateChat,
  onCreateBrowser,
  onCreateCode,
  onCreateExplorer,
  onCreateGit,
  onCreateRemoteDesktop,
  onCreateTerminal,
  onOpenSettings,
  onReveal,
  onRemove,
  onSelect,
  project,
  projectRevealLabel,
  revealDisabled,
}: {
  active: boolean;
  children?: ReactNode;
  creatingChat: boolean;
  creatingBrowser: boolean;
  creatingCode: boolean;
  creatingExplorer: boolean;
  creatingRemoteDesktop: boolean;
  creatingTerminal: boolean;
  creatingView: boolean;
  onCreateChat(): void;
  onCreateBrowser(): void;
  onCreateCode(): void;
  onCreateExplorer(): void;
  onCreateGit(): void;
  onCreateRemoteDesktop(): void;
  onCreateTerminal(): void;
  onOpenSettings(): void;
  onReveal?: () => void;
  onRemove(): void;
  onSelect(): void;
  project: ProjectSummary;
  projectRevealLabel?: string;
  revealDisabled: boolean;
}) {
  const cloning = project.setupStatus === "cloning";
  const failed = project.setupStatus === "failed";
  const sortable = useSortable({
    id: projectId(project.id),
    disabled: cloning,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  return (
    <div ref={sortable.setNodeRef} style={style} className="group mb-1">
      <div
        title={failed ? (project.setupError ?? undefined) : undefined}
        onContextMenu={openActionsMenu}
        className={cn(
          "flex items-center rounded-md hover:bg-muted",
          active && "bg-muted font-medium",
        )}
      >
        <DragHandle
          attributes={sortable.attributes}
          listeners={sortable.listeners}
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-3 text-left text-sm"
          onClick={onSelect}
        >
          {cloning ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : failed ? (
            <CircleAlert className="size-4 shrink-0 text-destructive" />
          ) : (
            <FolderGit2 className="size-4 shrink-0" />
          )}
          <span className="truncate">{project.name}</span>
          {cloning || failed ? (
            <span
              className={cn(
                "ml-auto shrink-0 text-[10px] font-normal text-muted-foreground",
                failed && "text-destructive",
              )}
            >
              {cloning ? "Cloning" : "Failed"}
            </span>
          ) : null}
        </button>
        {project.source ? (
          <DropdownMenuPrimitive.Root>
            <DropdownMenuPrimitive.Trigger asChild>
              <button
                type="button"
                title={`Add to ${project.name}`}
                onClick={(event) => event.stopPropagation()}
                className="mr-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
              >
                <Plus className="size-3.5" />
                <span className="sr-only">Add to {project.name}</span>
              </button>
            </DropdownMenuPrimitive.Trigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.Content
                align="end"
                sideOffset={4}
                className={menuContentClass}
              >
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  disabled={creatingChat}
                  onSelect={onCreateChat}
                >
                  <MessageSquare className="size-4" /> Chat
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  disabled={creatingTerminal}
                  onSelect={onCreateTerminal}
                >
                  <SquareTerminal className="size-4" /> Terminal
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  disabled={creatingExplorer}
                  onSelect={onCreateExplorer}
                >
                  <FolderTree className="size-4" /> Explorer
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  disabled={creatingCode}
                  onSelect={onCreateCode}
                >
                  <Code2 className="size-4" /> Code
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  disabled={creatingBrowser}
                  onSelect={onCreateBrowser}
                >
                  <Globe2 className="size-4" /> Browser
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  disabled={creatingView}
                  onSelect={onCreateGit}
                >
                  <GitCommitHorizontal className="size-4" /> Git
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  disabled={creatingRemoteDesktop}
                  onSelect={onCreateRemoteDesktop}
                >
                  <MonitorUp className="size-4" /> Remote Desktop
                </DropdownMenuPrimitive.Item>
              </DropdownMenuPrimitive.Content>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Root>
        ) : null}
        {cloning ? null : (
          <DropdownMenuPrimitive.Root>
            <DropdownMenuPrimitive.Trigger asChild>
              <button
                data-actions-trigger
                type="button"
                title={`Project actions for ${project.name}`}
                onClick={(event) => event.stopPropagation()}
                className="mr-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
                <span className="sr-only">
                  Project actions for {project.name}
                </span>
              </button>
            </DropdownMenuPrimitive.Trigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.Content
                align="end"
                sideOffset={4}
                className={menuContentClass}
              >
                <DropdownMenuPrimitive.Item
                  className={menuItemClass}
                  onSelect={onOpenSettings}
                >
                  <Settings className="size-4" /> Settings
                </DropdownMenuPrimitive.Item>
                {onReveal ? (
                  <DropdownMenuPrimitive.Item
                    className={menuItemClass}
                    disabled={revealDisabled}
                    onSelect={onReveal}
                  >
                    <FolderOpen className="size-4" /> {projectRevealLabel}
                  </DropdownMenuPrimitive.Item>
                ) : null}
                <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
                <DropdownMenuPrimitive.Item
                  className={cn(
                    menuItemClass,
                    "text-destructive focus:bg-destructive/10",
                  )}
                  onSelect={onRemove}
                >
                  <Trash2 className="size-4" /> Remove project
                </DropdownMenuPrimitive.Item>
              </DropdownMenuPrimitive.Content>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Root>
        )}
      </div>
      {children}
    </div>
  );
}

export function ProjectChatList({
  browsers,
  chats,
  codeTabs,
  creatingBrowser,
  creatingChat,
  creatingCode,
  creatingExplorer,
  creatingRemoteDesktop,
  creatingTerminal,
  creatingView,
  explorers,
  onChangeChatWorktree,
  projectViews,
  onCreateChat,
  onCreateBrowser,
  onCreateCode,
  onCreateExplorer,
  onCreateGit,
  onCreateRemoteDesktop,
  onDeleteChat,
  onDeleteBrowser,
  onDeleteCode,
  onDeleteExplorer,
  onDeleteProjectView,
  onDuplicateChat,
  onOpenChatExplorer,
  onOpenChatHistory,
  onOpenChatTerminal,
  onOpenProjectSettings,
  onRevealProject,
  onCreateTerminal,
  onDeleteTerminal,
  onRemoveProject,
  onRequestChatWorktreeCreate,
  onRenameChat,
  onRenameBrowser,
  onRenameCode,
  onRenameExplorer,
  onRenameProjectView,
  onRenameTerminal,
  onSelectGroup,
  onSelectProject,
  projects,
  projectRevealLabel,
  selectedTabKey,
  selectedProjectId,
  tabLayout,
  terminals,
  workers,
  worktrees,
  worktreeStatuses,
}: {
  browsers: BrowserSummary[];
  chats: ChatSummary[];
  codeTabs: CodeTabSummary[];
  creatingBrowser: boolean;
  creatingChat: boolean;
  creatingCode: boolean;
  creatingExplorer: boolean;
  creatingRemoteDesktop: boolean;
  creatingTerminal: boolean;
  creatingView: boolean;
  explorers: ExplorerSummary[];
  onChangeChatWorktree(
    chatId: string,
    worktreeId: string,
    mode: "agent-managed" | "pinned",
  ): void;
  projectViews: ProjectViewSummary[];
  onCreateChat(projectId: string): void;
  onCreateBrowser(projectId: string): void;
  onCreateCode(projectId: string): void;
  onCreateExplorer(projectId: string): void;
  onCreateGit(projectId: string): void;
  onCreateRemoteDesktop(projectId: string): void;
  onDeleteChat(chatId: string): void;
  onDeleteBrowser(browserId: string): void;
  onDeleteCode(codeTabId: string): void;
  onDeleteExplorer(explorerId: string): void;
  onDeleteProjectView(viewId: string): void;
  onDuplicateChat(chatId: string): void;
  onOpenChatExplorer(chat: ChatSummary): void;
  onOpenChatHistory(chat: ChatSummary): void;
  onOpenChatTerminal(chat: ChatSummary): void;
  onOpenProjectSettings(projectId: string): void;
  onRevealProject?: (project: ProjectSummary) => Promise<void>;
  onCreateTerminal(projectId: string): void;
  onDeleteTerminal(terminalId: string): void;
  onRemoveProject(projectId: string, deleteLocalFiles: boolean): void;
  onRequestChatWorktreeCreate(chat: ChatSummary): void;
  onRenameChat(chatId: string, title: string): void;
  onRenameBrowser(browserId: string, title: string): void;
  onRenameCode(codeTabId: string, title: string): void;
  onRenameExplorer(explorerId: string, title: string): void;
  onRenameProjectView(viewId: string, title: string): void;
  onRenameTerminal(terminalId: string, title: string): void;
  onSelectGroup(groupId: string): void;
  onSelectProject(projectId: string): void;
  projects: ProjectSummary[];
  projectRevealLabel?: string;
  selectedTabKey: string | null;
  selectedProjectId: string | null;
  tabLayout: ProjectTabLayoutSummary | null;
  terminals: TerminalSummary[];
  workers: WorkerSummary[];
  worktrees: ProjectWorktreeSummary[];
  worktreeStatuses: WorktreeStatusMap;
}) {
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingBrowserId, setEditingBrowserId] = useState<string | null>(null);
  const [editingCodeId, setEditingCodeId] = useState<string | null>(null);
  const [editingExplorerId, setEditingExplorerId] = useState<string | null>(
    null,
  );
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(
    null,
  );
  const [editingProjectViewId, setEditingProjectViewId] = useState<
    string | null
  >(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);
  const [deleteBrowserTarget, setDeleteBrowserTarget] =
    useState<BrowserSummary | null>(null);
  const [deleteCodeTarget, setDeleteCodeTarget] =
    useState<CodeTabSummary | null>(null);
  const [deleteExplorerTarget, setDeleteExplorerTarget] =
    useState<ExplorerSummary | null>(null);
  const [deleteTerminalTarget, setDeleteTerminalTarget] =
    useState<TerminalSummary | null>(null);
  const [deleteProjectViewTarget, setDeleteProjectViewTarget] =
    useState<ProjectViewSummary | null>(null);
  const [removeProjectTarget, setRemoveProjectTarget] =
    useState<ProjectSummary | null>(null);
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(false);
  const [revealingProjectId, setRevealingProjectId] = useState<string | null>(
    null,
  );
  const [projectRevealError, setProjectRevealError] = useState<string | null>(
    null,
  );
  const standaloneTerminals = terminals.filter(
    (terminal) => terminal.linkedChatId === null,
  );
  type SidebarTab =
    | { id: string; kind: "chat"; chat: ChatSummary }
    | {
        id: string;
        kind: "terminal";
        terminal: TerminalSummary;
      }
    | {
        id: string;
        kind: "explorer";
        explorer: ExplorerSummary;
      }
    | {
        id: string;
        kind: "browser";
        browser: BrowserSummary;
      }
    | {
        id: string;
        kind: "code";
        codeTab: CodeTabSummary;
      }
    | {
        id: string;
        kind: "view";
        view: ProjectViewSummary;
      };
  const tabs: SidebarTab[] = [
    ...chats.map((chat) => ({
      id: chatId(chat.id),
      kind: "chat" as const,
      chat,
    })),
    ...standaloneTerminals.map((terminal) => ({
      id: terminalId(terminal.id),
      kind: "terminal" as const,
      terminal,
    })),
    ...explorers.map((explorer) => ({
      id: explorerId(explorer.id),
      kind: "explorer" as const,
      explorer,
    })),
    ...browsers.map((browser) => ({
      id: browserId(browser.id),
      kind: "browser" as const,
      browser,
    })),
    ...codeTabs.map((codeTab) => ({
      id: codeId(codeTab.id),
      kind: "code" as const,
      codeTab,
    })),
    ...projectViews.map((view) => ({
      id: viewId(view.id),
      kind: "view" as const,
      view,
    })),
  ];
  const tabByKey = new Map(tabs.map((tab) => [tab.id, tab]));
  const sidebarGroups =
    tabLayout?.groups.flatMap((group) => {
      const members = group.members.flatMap(({ tabKey }) => {
        const tab = tabByKey.get(tabKey);
        return tab ? [tab] : [];
      });
      const anchor =
        members.find((tab) => tab.id === group.anchorTabKey) ?? members[0];
      return anchor
        ? [
            {
              anchor,
              id: group.id,
              members,
              sortId: anchor.id,
            },
          ]
        : [];
    }) ?? [];
  const tabVisualKind = (tab: SidebarTab): ProjectTabGroupVisualKind =>
    tab.kind === "view" ? tab.view.kind : tab.kind;
  const tabTitle = (tab: SidebarTab): string =>
    tab.kind === "chat"
      ? tab.chat.title
      : tab.kind === "terminal"
        ? tab.terminal.title
        : tab.kind === "explorer"
          ? tab.explorer.title
          : tab.kind === "browser"
            ? tab.browser.title
            : tab.kind === "code"
              ? tab.codeTab.title
              : tab.view.title;
  const selectedGroupId = tabLayout?.groups.find(({ members }) =>
    members.some(({ tabKey }) => tabKey === selectedTabKey),
  )?.id;
  const worktreeById = new Map(
    worktrees.map((worktree) => [worktree.id, worktree]),
  );

  const beginRename = (chat: ChatSummary) => {
    if (editingChatId === chat.id) {
      setEditingChatId(null);
      return;
    }
    setEditingChatId(chat.id);
    setRenameValue(chat.title);
  };
  const finishRename = (chat: ChatSummary) => {
    const title = renameValue.trim();
    setEditingChatId(null);
    if (title && title !== chat.title) onRenameChat(chat.id, title);
  };
  const beginTerminalRename = (terminal: TerminalSummary) => {
    if (editingTerminalId === terminal.id) {
      setEditingTerminalId(null);
      return;
    }
    setEditingTerminalId(terminal.id);
    setRenameValue(terminal.title);
  };
  const finishTerminalRename = (terminal: TerminalSummary) => {
    const title = renameValue.trim();
    setEditingTerminalId(null);
    if (title && title !== terminal.title) onRenameTerminal(terminal.id, title);
  };
  const beginExplorerRename = (explorer: ExplorerSummary) => {
    if (editingExplorerId === explorer.id) {
      setEditingExplorerId(null);
      return;
    }
    setEditingExplorerId(explorer.id);
    setRenameValue(explorer.title);
  };
  const finishExplorerRename = (explorer: ExplorerSummary) => {
    const title = renameValue.trim();
    setEditingExplorerId(null);
    if (title && title !== explorer.title) onRenameExplorer(explorer.id, title);
  };
  const beginBrowserRename = (browser: BrowserSummary) => {
    if (editingBrowserId === browser.id) {
      setEditingBrowserId(null);
      return;
    }
    setEditingBrowserId(browser.id);
    setRenameValue(browser.title);
  };
  const beginCodeRename = (codeTab: CodeTabSummary) => {
    if (editingCodeId === codeTab.id) {
      setEditingCodeId(null);
      return;
    }
    setEditingCodeId(codeTab.id);
    setRenameValue(codeTab.title);
  };
  const finishCodeRename = (codeTab: CodeTabSummary) => {
    const title = renameValue.trim();
    setEditingCodeId(null);
    if (title && title !== codeTab.title) onRenameCode(codeTab.id, title);
  };
  const finishBrowserRename = (browser: BrowserSummary) => {
    const title = renameValue.trim();
    setEditingBrowserId(null);
    if (title && title !== browser.title) onRenameBrowser(browser.id, title);
  };
  const beginProjectViewRename = (view: ProjectViewSummary) => {
    if (editingProjectViewId === view.id) {
      setEditingProjectViewId(null);
      return;
    }
    setEditingProjectViewId(view.id);
    setRenameValue(view.title);
  };
  const finishProjectViewRename = (view: ProjectViewSummary) => {
    const title = renameValue.trim();
    setEditingProjectViewId(null);
    if (title && title !== view.title) onRenameProjectView(view.id, title);
  };
  const tabIsEditing = (tab: SidebarTab): boolean =>
    tab.kind === "chat"
      ? editingChatId === tab.chat.id
      : tab.kind === "terminal"
        ? editingTerminalId === tab.terminal.id
        : tab.kind === "explorer"
          ? editingExplorerId === tab.explorer.id
          : tab.kind === "browser"
            ? editingBrowserId === tab.browser.id
            : tab.kind === "code"
              ? editingCodeId === tab.codeTab.id
              : editingProjectViewId === tab.view.id;
  const beginTabRename = (tab: SidebarTab) => {
    if (tab.kind === "chat") beginRename(tab.chat);
    else if (tab.kind === "terminal") beginTerminalRename(tab.terminal);
    else if (tab.kind === "explorer") beginExplorerRename(tab.explorer);
    else if (tab.kind === "browser") beginBrowserRename(tab.browser);
    else if (tab.kind === "code") beginCodeRename(tab.codeTab);
    else beginProjectViewRename(tab.view);
  };
  const finishTabRename = (tab: SidebarTab) => {
    if (tab.kind === "chat") finishRename(tab.chat);
    else if (tab.kind === "terminal") finishTerminalRename(tab.terminal);
    else if (tab.kind === "explorer") finishExplorerRename(tab.explorer);
    else if (tab.kind === "browser") finishBrowserRename(tab.browser);
    else if (tab.kind === "code") finishCodeRename(tab.codeTab);
    else finishProjectViewRename(tab.view);
  };
  const requestTabDelete = (tab: SidebarTab) => {
    if (tab.kind === "chat") setDeleteTarget(tab.chat);
    else if (tab.kind === "terminal") setDeleteTerminalTarget(tab.terminal);
    else if (tab.kind === "explorer") setDeleteExplorerTarget(tab.explorer);
    else if (tab.kind === "browser") setDeleteBrowserTarget(tab.browser);
    else if (tab.kind === "code") setDeleteCodeTarget(tab.codeTab);
    else setDeleteProjectViewTarget(tab.view);
  };
  const sidebarDrop = useDroppable({
    id: workspaceSidebarDropId(selectedProjectId ?? "none"),
    disabled: !selectedProjectId || !tabLayout,
    data: {
      drop:
        selectedProjectId && tabLayout
          ? {
              type: "sidebar-project" as const,
              projectId: selectedProjectId,
              groupPosition: tabLayout.groups.length,
            }
          : undefined,
    } satisfies WorkspaceDndData,
  });

  return (
    <>
      <div className="contents">
        <SortableContext
          items={projects.map((project) => projectId(project.id))}
          strategy={verticalListSortingStrategy}
        >
          {projects.map((project) => {
            const active = project.id === selectedProjectId;
            return (
              <SortableProject
                key={project.id}
                project={project}
                active={active}
                creatingChat={creatingChat}
                creatingBrowser={creatingBrowser}
                creatingCode={creatingCode}
                creatingExplorer={creatingExplorer}
                creatingRemoteDesktop={creatingRemoteDesktop}
                creatingTerminal={creatingTerminal}
                creatingView={creatingView}
                onCreateChat={() => onCreateChat(project.id)}
                onCreateBrowser={() => onCreateBrowser(project.id)}
                onCreateCode={() => onCreateCode(project.id)}
                onCreateExplorer={() => onCreateExplorer(project.id)}
                onCreateGit={() => onCreateGit(project.id)}
                onCreateRemoteDesktop={() => onCreateRemoteDesktop(project.id)}
                onCreateTerminal={() => onCreateTerminal(project.id)}
                onOpenSettings={() => onOpenProjectSettings(project.id)}
                onReveal={
                  project.source && projectRevealLabel && onRevealProject
                    ? () => {
                        if (revealingProjectId) return;
                        setProjectRevealError(null);
                        setRevealingProjectId(project.id);
                        void onRevealProject(project)
                          .catch((error: unknown) => {
                            setProjectRevealError(
                              error instanceof Error
                                ? error.message
                                : "Could not reveal this project.",
                            );
                          })
                          .finally(() => setRevealingProjectId(null));
                      }
                    : undefined
                }
                projectRevealLabel={projectRevealLabel}
                revealDisabled={revealingProjectId !== null}
                onSelect={() => onSelectProject(project.id)}
                onRemove={() => {
                  setDeleteLocalFiles(false);
                  setRemoveProjectTarget(project);
                }}
              >
                {active ? (
                  <div
                    ref={sidebarDrop.setNodeRef}
                    className={cn(
                      "mt-1 min-h-8 rounded-md transition-colors",
                      sidebarDrop.isOver && "bg-muted/40",
                    )}
                  >
                    <SortableContext
                      items={sidebarGroups.map((group) => group.sortId)}
                      strategy={verticalListSortingStrategy}
                    >
                      {sidebarGroups.map((group) => {
                        const tab = group.anchor;
                        const selectGroup = () => onSelectGroup(group.id);
                        if (group.members.length > 1) {
                          const visualKinds = new Set(
                            group.members.map(tabVisualKind),
                          );
                          return (
                            <GroupedSidebarTab
                              key={group.id}
                              active={group.id === selectedGroupId}
                              count={group.members.length}
                              editing={tabIsEditing(tab)}
                              onDelete={() => requestTabDelete(tab)}
                              onDuplicate={
                                tab.kind === "chat"
                                  ? () => onDuplicateChat(tab.chat.id)
                                  : undefined
                              }
                              onRename={() => beginTabRename(tab)}
                              onSelect={selectGroup}
                              renameValue={renameValue}
                              setRenameValue={setRenameValue}
                              sortId={group.sortId}
                              submitRename={() => finishTabRename(tab)}
                              title={tabTitle(tab)}
                              visualKind={
                                visualKinds.size > 1
                                  ? "mixed"
                                  : (visualKinds.values().next().value ??
                                    "mixed")
                              }
                            />
                          );
                        }
                        return tab.kind === "chat" ? (
                          <SortableChat
                            key={tab.id}
                            chat={tab.chat}
                            active={tab.id === selectedTabKey}
                            editing={editingChatId === tab.chat.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() => finishRename(tab.chat)}
                            onSelect={selectGroup}
                            onRename={() => beginRename(tab.chat)}
                            onDuplicate={() => onDuplicateChat(tab.chat.id)}
                            onDelete={() => setDeleteTarget(tab.chat)}
                            workers={workers}
                            worktree={worktreeById.get(
                              tab.chat.activeWorktreeId,
                            )}
                            worktreeStatus={
                              worktreeStatuses[tab.chat.activeWorktreeId]
                            }
                            worktreeActions={{
                              currentWorktreeId: tab.chat.activeWorktreeId,
                              disabled: tab.chat.status === "running",
                              mode: tab.chat.worktreeMode,
                              worktrees,
                              onCreate: () =>
                                onRequestChatWorktreeCreate(tab.chat),
                              onSelect: (worktreeId) =>
                                onChangeChatWorktree(
                                  tab.chat.id,
                                  worktreeId,
                                  tab.chat.worktreeMode,
                                ),
                              onSetMode: (mode) =>
                                onChangeChatWorktree(
                                  tab.chat.id,
                                  tab.chat.activeWorktreeId,
                                  mode,
                                ),
                              onOpenTerminal: () =>
                                onOpenChatTerminal(tab.chat),
                              onOpenExplorer: () =>
                                onOpenChatExplorer(tab.chat),
                              onOpenHistory: () => onOpenChatHistory(tab.chat),
                            }}
                          />
                        ) : tab.kind === "terminal" ? (
                          <TerminalTab
                            key={tab.id}
                            terminal={tab.terminal}
                            active={tab.id === selectedTabKey}
                            editing={editingTerminalId === tab.terminal.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() =>
                              finishTerminalRename(tab.terminal)
                            }
                            onSelect={selectGroup}
                            onRename={() => beginTerminalRename(tab.terminal)}
                            onDelete={() =>
                              setDeleteTerminalTarget(tab.terminal)
                            }
                            workers={workers}
                            worktree={worktreeById.get(tab.terminal.worktreeId)}
                            worktreeStatus={
                              worktreeStatuses[tab.terminal.worktreeId]
                            }
                          />
                        ) : tab.kind === "explorer" ? (
                          <ExplorerTab
                            key={tab.id}
                            explorer={tab.explorer}
                            active={tab.id === selectedTabKey}
                            editing={editingExplorerId === tab.explorer.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() =>
                              finishExplorerRename(tab.explorer)
                            }
                            onSelect={selectGroup}
                            onRename={() => beginExplorerRename(tab.explorer)}
                            onDelete={() =>
                              setDeleteExplorerTarget(tab.explorer)
                            }
                            workers={workers}
                            worktree={worktreeById.get(tab.explorer.worktreeId)}
                            worktreeStatus={
                              worktreeStatuses[tab.explorer.worktreeId]
                            }
                          />
                        ) : tab.kind === "browser" ? (
                          <BrowserTab
                            key={tab.id}
                            browser={tab.browser}
                            active={tab.id === selectedTabKey}
                            editing={editingBrowserId === tab.browser.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() =>
                              finishBrowserRename(tab.browser)
                            }
                            onSelect={selectGroup}
                            onRename={() => beginBrowserRename(tab.browser)}
                            onDelete={() => setDeleteBrowserTarget(tab.browser)}
                          />
                        ) : tab.kind === "code" ? (
                          <CodeTab
                            key={tab.id}
                            codeTab={tab.codeTab}
                            active={tab.id === selectedTabKey}
                            editing={editingCodeId === tab.codeTab.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() => finishCodeRename(tab.codeTab)}
                            onSelect={selectGroup}
                            onRename={() => beginCodeRename(tab.codeTab)}
                            onDelete={() => setDeleteCodeTarget(tab.codeTab)}
                            workers={workers}
                            worktree={worktreeById.get(tab.codeTab.worktreeId)}
                            worktreeStatus={
                              worktreeStatuses[tab.codeTab.worktreeId]
                            }
                          />
                        ) : (
                          <ProjectViewTab
                            key={tab.id}
                            view={tab.view}
                            active={tab.id === selectedTabKey}
                            editing={editingProjectViewId === tab.view.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() =>
                              finishProjectViewRename(tab.view)
                            }
                            onSelect={selectGroup}
                            onRename={() => beginProjectViewRename(tab.view)}
                            onDelete={() =>
                              setDeleteProjectViewTarget(tab.view)
                            }
                            workers={workers}
                            worktree={
                              tab.view.worktreeId
                                ? worktreeById.get(tab.view.worktreeId)
                                : undefined
                            }
                            worktreeStatus={
                              tab.view.worktreeId
                                ? worktreeStatuses[tab.view.worktreeId]
                                : undefined
                            }
                          />
                        );
                      })}
                    </SortableContext>
                  </div>
                ) : null}
              </SortableProject>
            );
          })}
        </SortableContext>
      </div>

      {projectRevealError ? (
        <div
          role="alert"
          className="fixed bottom-5 right-5 z-50 max-w-md rounded-lg bg-destructive px-4 py-3 text-sm text-destructive-foreground shadow-xl"
        >
          Could not reveal project: {projectRevealError}
        </div>
      ) : null}

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.title}” and its conversation history will be
              permanently deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) onDeleteChat(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(removeProjectTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveProjectTarget(null);
            setDeleteLocalFiles(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove project?</DialogTitle>
            <DialogDescription>
              “{removeProjectTarget?.name}” will be unlinked from Cantrip. Its
              repository remains on the worker and can be re-linked later.
            </DialogDescription>
          </DialogHeader>
          {removeProjectTarget?.source ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-destructive"
                checked={deleteLocalFiles}
                onChange={(event) => setDeleteLocalFiles(event.target.checked)}
              />
              <span>
                <span className="font-medium">Also delete local files</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  Permanently removes the checked-out repository from the
                  worker. This cannot be undone by Cantrip.
                </span>
              </span>
            </label>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className={cn(
                deleteLocalFiles &&
                  "bg-destructive text-white hover:bg-destructive/90",
              )}
              onClick={() => {
                if (removeProjectTarget) {
                  onRemoveProject(removeProjectTarget.id, deleteLocalFiles);
                }
                setRemoveProjectTarget(null);
                setDeleteLocalFiles(false);
              }}
            >
              {deleteLocalFiles ? "Delete files and remove" : "Unlink project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteTerminalTarget)}
        onOpenChange={(open) => !open && setDeleteTerminalTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete terminal?</DialogTitle>
            <DialogDescription>
              “{deleteTerminalTarget?.title}” will be closed and removed from
              this project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteTerminalTarget)
                  onDeleteTerminal(deleteTerminalTarget.id);
                setDeleteTerminalTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteExplorerTarget)}
        onOpenChange={(open) => !open && setDeleteExplorerTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete explorer?</DialogTitle>
            <DialogDescription>
              “{deleteExplorerTarget?.title}” will be removed. Project files are
              not changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteExplorerTarget)
                  onDeleteExplorer(deleteExplorerTarget.id);
                setDeleteExplorerTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteBrowserTarget)}
        onOpenChange={(open) => !open && setDeleteBrowserTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete browser?</DialogTitle>
            <DialogDescription>
              “{deleteBrowserTarget?.title}” and its saved address will be
              removed from this project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteBrowserTarget)
                  onDeleteBrowser(deleteBrowserTarget.id);
                setDeleteBrowserTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteProjectViewTarget)}
        onOpenChange={(open) => !open && setDeleteProjectViewTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteProjectViewTarget?.title}?</DialogTitle>
            <DialogDescription>
              This removes the tab only. It does not change repository history
              or GitHub issues.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteProjectViewTarget) {
                  onDeleteProjectView(deleteProjectViewTarget.id);
                }
                setDeleteProjectViewTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteCodeTarget)}
        onOpenChange={(open) => !open && setDeleteCodeTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Code tab?</DialogTitle>
            <DialogDescription>
              “{deleteCodeTarget?.title}” will stop its editor and remove this
              tab. Its persistent worker profile and project files are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteCodeTarget) onDeleteCode(deleteCodeTarget.id);
                setDeleteCodeTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
