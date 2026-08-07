import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type {
  BrowserSummary,
  ChatSummary,
  ExplorerSummary,
  ProjectSummary,
  TerminalSummary,
} from "@cantrip/protocol";
import {
  FolderGit2,
  FolderTree,
  GitBranch,
  Globe2,
  GripVertical,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";

import { ChatContextMenu, ChatDropdownMenu } from "@/components/chat/chat-menu";
import { Button } from "@/components/ui/button";
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

const projectId = (id: string) => `project:${id}`;
const chatId = (id: string) => `chat:${id}`;
const terminalId = (id: string) => `terminal:${id}`;
const explorerId = (id: string) => `explorer:${id}`;
const browserId = (id: string) => `browser:${id}`;
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
}) {
  const sortable = useSortable({ id: chatId(chat.id) });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  const actions = { onDelete, onDuplicate, onRename };
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
            {chat.status === "running" ? (
              <Loader2 className="ml-auto size-3 animate-spin" />
            ) : null}
          </button>
        )}
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
              "ml-auto size-1.5 rounded-full bg-muted-foreground/40",
              terminal.status === "running" && "bg-emerald-500",
              terminal.status === "failed" && "bg-destructive",
            )}
          />
        </button>
      )}
      {!editing ? (
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
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
              align="start"
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
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
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
              align="start"
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
              align="start"
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

function SortableProject({
  active,
  children,
  creatingChat,
  creatingBrowser,
  creatingExplorer,
  creatingTerminal,
  historyActive,
  onCreateChat,
  onCreateBrowser,
  onCreateExplorer,
  onCreateTerminal,
  onOpenHistory,
  onRemove,
  onSelect,
  project,
}: {
  active: boolean;
  children?: ReactNode;
  creatingChat: boolean;
  creatingBrowser: boolean;
  creatingExplorer: boolean;
  creatingTerminal: boolean;
  historyActive: boolean;
  onCreateChat(): void;
  onCreateBrowser(): void;
  onCreateExplorer(): void;
  onCreateTerminal(): void;
  onOpenHistory(): void;
  onRemove(): void;
  onSelect(): void;
  project: ProjectSummary;
}) {
  const sortable = useSortable({ id: projectId(project.id) });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.25 : 1,
    zIndex: sortable.isDragging ? 10 : undefined,
  };
  return (
    <div ref={sortable.setNodeRef} style={style} className="group mb-1">
      <div
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
          <FolderGit2 className="size-4 shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>
        <button
          type="button"
          title={`Git history for ${project.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenHistory();
          }}
          className={cn(
            "mr-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:opacity-100",
            historyActive && "bg-background text-foreground opacity-100",
          )}
        >
          <GitBranch className="size-3.5" />
          <span className="sr-only">Git history for {project.name}</span>
        </button>
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <button
              type="button"
              title={`Add to ${project.name}`}
              disabled={!project.source}
              onClick={(event) => event.stopPropagation()}
              className="mr-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
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
                <Plus className="size-4" /> Chat
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className={menuItemClass}
                disabled={creatingTerminal}
                onSelect={onCreateTerminal}
              >
                <Plus className="size-4" /> Terminal
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className={menuItemClass}
                disabled={creatingExplorer}
                onSelect={onCreateExplorer}
              >
                <Plus className="size-4" /> Explorer
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className={menuItemClass}
                disabled={creatingBrowser}
                onSelect={onCreateBrowser}
              >
                <Plus className="size-4" /> Browser
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <button
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
      </div>
      {children}
    </div>
  );
}

export function ProjectChatList({
  browsers,
  chats,
  creatingBrowser,
  creatingChat,
  creatingExplorer,
  creatingTerminal,
  explorers,
  gitHistoryProjectId,
  onCreateChat,
  onCreateBrowser,
  onCreateExplorer,
  onDeleteChat,
  onDeleteBrowser,
  onDeleteExplorer,
  onDuplicateChat,
  onCreateTerminal,
  onDeleteTerminal,
  onOpenGitHistory,
  onRemoveProject,
  onRenameChat,
  onRenameBrowser,
  onRenameExplorer,
  onRenameTerminal,
  onReorderTabs,
  onReorderProjects,
  onSelectChat,
  onSelectBrowser,
  onSelectExplorer,
  onSelectTerminal,
  onSelectProject,
  projects,
  selectedChatId,
  selectedBrowserId,
  selectedExplorerId,
  selectedProjectId,
  selectedTerminalId,
  terminals,
}: {
  browsers: BrowserSummary[];
  chats: ChatSummary[];
  creatingBrowser: boolean;
  creatingChat: boolean;
  creatingExplorer: boolean;
  creatingTerminal: boolean;
  explorers: ExplorerSummary[];
  onCreateChat(projectId: string): void;
  onCreateBrowser(projectId: string): void;
  onCreateExplorer(projectId: string): void;
  onDeleteChat(chatId: string): void;
  onDeleteBrowser(browserId: string): void;
  onDeleteExplorer(explorerId: string): void;
  onDuplicateChat(chatId: string): void;
  onCreateTerminal(projectId: string): void;
  onDeleteTerminal(terminalId: string): void;
  onOpenGitHistory(projectId: string): void;
  onRemoveProject(projectId: string, deleteLocalFiles: boolean): void;
  onRenameChat(chatId: string, title: string): void;
  onRenameBrowser(browserId: string, title: string): void;
  onRenameExplorer(explorerId: string, title: string): void;
  onRenameTerminal(terminalId: string, title: string): void;
  onReorderTabs(projectId: string, ids: string[]): void;
  onReorderProjects(ids: string[]): void;
  onSelectChat(chatId: string): void;
  onSelectBrowser(browserId: string): void;
  onSelectExplorer(explorerId: string): void;
  onSelectTerminal(terminalId: string): void;
  onSelectProject(projectId: string): void;
  projects: ProjectSummary[];
  selectedChatId: string | null;
  selectedBrowserId: string | null;
  selectedExplorerId: string | null;
  selectedProjectId: string | null;
  selectedTerminalId: string | null;
  terminals: TerminalSummary[];
  gitHistoryProjectId?: string | null;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const [activeDrag, setActiveDrag] = useState<string | null>(null);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingBrowserId, setEditingBrowserId] = useState<string | null>(null);
  const [editingExplorerId, setEditingExplorerId] = useState<string | null>(
    null,
  );
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);
  const [deleteBrowserTarget, setDeleteBrowserTarget] =
    useState<BrowserSummary | null>(null);
  const [deleteExplorerTarget, setDeleteExplorerTarget] =
    useState<ExplorerSummary | null>(null);
  const [deleteTerminalTarget, setDeleteTerminalTarget] =
    useState<TerminalSummary | null>(null);
  const [removeProjectTarget, setRemoveProjectTarget] =
    useState<ProjectSummary | null>(null);
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(false);
  const standaloneTerminals = terminals.filter(
    (terminal) => terminal.linkedChatId === null,
  );
  const selectedLinkedChatId = terminals.find(
    (terminal) => terminal.id === selectedTerminalId,
  )?.linkedChatId;
  const tabs: Array<
    | { id: string; kind: "chat"; chat: ChatSummary; position: number }
    | {
        id: string;
        kind: "terminal";
        terminal: TerminalSummary;
        position: number;
      }
    | {
        id: string;
        kind: "explorer";
        explorer: ExplorerSummary;
        position: number;
      }
    | {
        id: string;
        kind: "browser";
        browser: BrowserSummary;
        position: number;
      }
  > = [
    ...chats.map((chat) => ({
      id: chatId(chat.id),
      kind: "chat" as const,
      chat,
      position: chat.position,
    })),
    ...standaloneTerminals.map((terminal) => ({
      id: terminalId(terminal.id),
      kind: "terminal" as const,
      terminal,
      position: terminal.position,
    })),
    ...explorers.map((explorer) => ({
      id: explorerId(explorer.id),
      kind: "explorer" as const,
      explorer,
      position: explorer.position,
    })),
    ...browsers.map((browser) => ({
      id: browserId(browser.id),
      kind: "browser" as const,
      browser,
      position: browser.position,
    })),
  ].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

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
  const finishBrowserRename = (browser: BrowserSummary) => {
    const title = renameValue.trim();
    setEditingBrowserId(null);
    if (title && title !== browser.title) onRenameBrowser(browser.id, title);
  };
  const handleDragStart = (event: DragStartEvent) => {
    setActiveDrag(String(event.active.id));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    if (!event.over || event.active.id === event.over.id) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    if (activeId.startsWith("project:") && overId.startsWith("project:")) {
      const from = projects.findIndex(
        (project) => projectId(project.id) === activeId,
      );
      const to = projects.findIndex(
        (project) => projectId(project.id) === overId,
      );
      if (from >= 0 && to >= 0)
        onReorderProjects(arrayMove(projects, from, to).map((item) => item.id));
    }
    if (
      selectedProjectId &&
      !activeId.startsWith("project:") &&
      !overId.startsWith("project:")
    ) {
      const from = tabs.findIndex((tab) => tab.id === activeId);
      const to = tabs.findIndex((tab) => tab.id === overId);
      if (from >= 0 && to >= 0)
        onReorderTabs(
          selectedProjectId,
          arrayMove(tabs, from, to).map((tab) => tab.id),
        );
    }
  };
  const draggedProject = projects.find(
    (project) => projectId(project.id) === activeDrag,
  );
  const draggedChat = chats.find((chat) => chatId(chat.id) === activeDrag);
  const draggedTerminal = standaloneTerminals.find(
    (terminal) => terminalId(terminal.id) === activeDrag,
  );
  const draggedExplorer = explorers.find(
    (explorer) => explorerId(explorer.id) === activeDrag,
  );
  const draggedBrowser = browsers.find(
    (browser) => browserId(browser.id) === activeDrag,
  );

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={() => setActiveDrag(null)}
        onDragEnd={handleDragEnd}
      >
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
                creatingExplorer={creatingExplorer}
                creatingTerminal={creatingTerminal}
                historyActive={gitHistoryProjectId === project.id}
                onCreateChat={() => onCreateChat(project.id)}
                onCreateBrowser={() => onCreateBrowser(project.id)}
                onCreateExplorer={() => onCreateExplorer(project.id)}
                onCreateTerminal={() => onCreateTerminal(project.id)}
                onSelect={() => onSelectProject(project.id)}
                onOpenHistory={() => onOpenGitHistory(project.id)}
                onRemove={() => {
                  setDeleteLocalFiles(false);
                  setRemoveProjectTarget(project);
                }}
              >
                {active ? (
                  <div className="ml-5 mt-1 border-l pl-2">
                    <SortableContext
                      items={tabs.map((tab) => tab.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {tabs.map((tab) =>
                        tab.kind === "chat" ? (
                          <SortableChat
                            key={tab.id}
                            chat={tab.chat}
                            active={
                              tab.chat.id === selectedChatId ||
                              tab.chat.id === selectedLinkedChatId
                            }
                            editing={editingChatId === tab.chat.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() => finishRename(tab.chat)}
                            onSelect={() => onSelectChat(tab.chat.id)}
                            onRename={() => beginRename(tab.chat)}
                            onDuplicate={() => onDuplicateChat(tab.chat.id)}
                            onDelete={() => setDeleteTarget(tab.chat)}
                          />
                        ) : tab.kind === "terminal" ? (
                          <TerminalTab
                            key={tab.id}
                            terminal={tab.terminal}
                            active={tab.terminal.id === selectedTerminalId}
                            editing={editingTerminalId === tab.terminal.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() =>
                              finishTerminalRename(tab.terminal)
                            }
                            onSelect={() => onSelectTerminal(tab.terminal.id)}
                            onRename={() => beginTerminalRename(tab.terminal)}
                            onDelete={() =>
                              setDeleteTerminalTarget(tab.terminal)
                            }
                          />
                        ) : tab.kind === "explorer" ? (
                          <ExplorerTab
                            key={tab.id}
                            explorer={tab.explorer}
                            active={tab.explorer.id === selectedExplorerId}
                            editing={editingExplorerId === tab.explorer.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() =>
                              finishExplorerRename(tab.explorer)
                            }
                            onSelect={() => onSelectExplorer(tab.explorer.id)}
                            onRename={() => beginExplorerRename(tab.explorer)}
                            onDelete={() =>
                              setDeleteExplorerTarget(tab.explorer)
                            }
                          />
                        ) : (
                          <BrowserTab
                            key={tab.id}
                            browser={tab.browser}
                            active={tab.browser.id === selectedBrowserId}
                            editing={editingBrowserId === tab.browser.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            submitRename={() =>
                              finishBrowserRename(tab.browser)
                            }
                            onSelect={() => onSelectBrowser(tab.browser.id)}
                            onRename={() => beginBrowserRename(tab.browser)}
                            onDelete={() => setDeleteBrowserTarget(tab.browser)}
                          />
                        ),
                      )}
                    </SortableContext>
                  </div>
                ) : null}
              </SortableProject>
            );
          })}
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {draggedProject ? (
            <div className="flex w-64 items-center gap-2 rounded-md border bg-popover px-3 py-2 text-sm shadow-xl">
              <FolderGit2 className="size-4" />
              <span className="truncate">{draggedProject.name}</span>
            </div>
          ) : draggedChat ? (
            <div className="flex w-56 items-center gap-2 rounded-md border bg-popover px-3 py-2 text-xs shadow-xl">
              <MessageSquare className="size-3.5" />
              <span className="truncate">{draggedChat.title}</span>
            </div>
          ) : draggedTerminal ? (
            <div className="flex w-56 items-center gap-2 rounded-md border bg-popover px-3 py-2 text-xs shadow-xl">
              <SquareTerminal className="size-3.5" />
              <span className="truncate">{draggedTerminal.title}</span>
            </div>
          ) : draggedExplorer ? (
            <div className="flex w-56 items-center gap-2 rounded-md border bg-popover px-3 py-2 text-xs shadow-xl">
              <FolderTree className="size-3.5" />
              <span className="truncate">{draggedExplorer.title}</span>
            </div>
          ) : draggedBrowser ? (
            <div className="flex w-56 items-center gap-2 rounded-md border bg-popover px-3 py-2 text-xs shadow-xl">
              <Globe2 className="size-3.5" />
              <span className="truncate">{draggedBrowser.title}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

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
                Permanently removes the checked-out repository from the worker.
                This cannot be undone by Cantrip.
              </span>
            </span>
          </label>
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
    </>
  );
}
