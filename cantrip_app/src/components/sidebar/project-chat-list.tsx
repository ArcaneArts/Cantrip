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
import type { ChatSummary, ProjectSummary } from "@cantrip/protocol";
import {
  FolderGit2,
  GitBranch,
  GripVertical,
  Loader2,
  MessageSquare,
  Plus,
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

function SortableProject({
  active,
  children,
  creatingChat,
  historyActive,
  onCreateChat,
  onOpenHistory,
  onSelect,
  project,
}: {
  active: boolean;
  children?: ReactNode;
  creatingChat: boolean;
  historyActive: boolean;
  onCreateChat(): void;
  onOpenHistory(): void;
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
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      </div>
      {children}
    </div>
  );
}

export function ProjectChatList({
  chats,
  creatingChat,
  gitHistoryProjectId,
  onCreateChat,
  onDeleteChat,
  onDuplicateChat,
  onOpenGitHistory,
  onRenameChat,
  onReorderChats,
  onReorderProjects,
  onSelectChat,
  onSelectProject,
  projects,
  selectedChatId,
  selectedProjectId,
}: {
  chats: ChatSummary[];
  creatingChat: boolean;
  onCreateChat(projectId: string): void;
  onDeleteChat(chatId: string): void;
  onDuplicateChat(chatId: string): void;
  onOpenGitHistory(projectId: string): void;
  onRenameChat(chatId: string, title: string): void;
  onReorderChats(projectId: string, ids: string[]): void;
  onReorderProjects(ids: string[]): void;
  onSelectChat(chatId: string): void;
  onSelectProject(projectId: string): void;
  projects: ProjectSummary[];
  selectedChatId: string | null;
  selectedProjectId: string | null;
  gitHistoryProjectId?: string | null;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const [activeDrag, setActiveDrag] = useState<string | null>(null);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);

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
      activeId.startsWith("chat:") &&
      overId.startsWith("chat:")
    ) {
      const from = chats.findIndex((chat) => chatId(chat.id) === activeId);
      const to = chats.findIndex((chat) => chatId(chat.id) === overId);
      if (from >= 0 && to >= 0)
        onReorderChats(
          selectedProjectId,
          arrayMove(chats, from, to).map((item) => item.id),
        );
    }
  };
  const draggedProject = projects.find(
    (project) => projectId(project.id) === activeDrag,
  );
  const draggedChat = chats.find((chat) => chatId(chat.id) === activeDrag);

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
                historyActive={gitHistoryProjectId === project.id}
                onCreateChat={() => onCreateChat(project.id)}
                onSelect={() => onSelectProject(project.id)}
                onOpenHistory={() => onOpenGitHistory(project.id)}
              >
                {active ? (
                  <div className="ml-5 mt-1 border-l pl-2">
                    <SortableContext
                      items={chats.map((chat) => chatId(chat.id))}
                      strategy={verticalListSortingStrategy}
                    >
                      {chats.map((chat) => (
                        <SortableChat
                          key={chat.id}
                          chat={chat}
                          active={chat.id === selectedChatId}
                          editing={editingChatId === chat.id}
                          renameValue={renameValue}
                          setRenameValue={setRenameValue}
                          submitRename={() => finishRename(chat)}
                          onSelect={() => onSelectChat(chat.id)}
                          onRename={() => beginRename(chat)}
                          onDuplicate={() => onDuplicateChat(chat.id)}
                          onDelete={() => setDeleteTarget(chat)}
                        />
                      ))}
                    </SortableContext>
                  </div>
                ) : null}
              </SortableProject>
            );
          })}
        </SortableContext>
        <DragOverlay dropAnimation={{ duration: 180, easing: "ease" }}>
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
    </>
  );
}
