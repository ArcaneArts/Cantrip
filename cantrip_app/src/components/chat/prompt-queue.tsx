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
import type { QueuedPrompt } from "@cantrip/protocol";
import {
  CornerDownRight,
  GripVertical,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Snowflake,
  Trash2,
} from "lucide-react";
import { useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

function PromptRow({
  disabled,
  executing,
  onDelete,
  onEdit,
  onFreeze,
  onSteer,
  prompt,
}: {
  disabled: boolean;
  executing: boolean;
  onDelete(): void;
  onEdit(): void;
  onFreeze(): void;
  onSteer(): void;
  prompt: QueuedPrompt;
}) {
  const sortable = useSortable({ id: prompt.id, disabled });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        "group flex h-9 min-w-0 items-center gap-1 rounded-lg px-1.5 text-sm odd:bg-muted/25",
        sortable.isDragging && "opacity-30",
      )}
    >
      <button
        type="button"
        className="grid size-7 shrink-0 touch-none place-items-center rounded-md text-muted-foreground/60 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed"
        disabled={disabled}
        aria-label="Drag queued prompt"
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      {prompt.frozen ? (
        <Snowflake className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="min-w-0 flex-1 truncate" title={prompt.text}>
        {prompt.text || "Attachment prompt"}
      </span>
      {prompt.mode !== "default" ? (
        <span
          className={cn(
            "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize",
            prompt.mode === "goal"
              ? "border-violet-500/30 text-violet-600 dark:text-violet-400"
              : "border-sky-500/30 text-sky-600 dark:text-sky-400",
          )}
        >
          {prompt.mode}
        </span>
      ) : null}
      {prompt.attachments.length > 0 ? (
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
          title={prompt.attachments.map(({ fileName }) => fileName).join(", ")}
        >
          <Paperclip className="size-3" /> {prompt.attachments.length}
        </span>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
        disabled={disabled || (executing && prompt.mode !== "default")}
        title={
          !executing
            ? "Start this queued prompt"
            : prompt.mode === "default"
              ? "Steer the active turn"
              : `${prompt.mode === "goal" ? "Goal" : "Plan"} mode starts with the next turn and cannot steer an active turn`
        }
        onClick={onSteer}
      >
        <CornerDownRight className="size-3.5" /> Steer
      </Button>
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            disabled={disabled}
          >
            <MoreHorizontal className="size-3.5" />
            <span className="sr-only">Queued prompt actions</span>
          </Button>
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <StyledDropdownMenuContent
            align="end"
            sideOffset={4}
            className="min-w-36"
          >
            <StyledDropdownMenuItem onSelect={onEdit}>
              <Pencil className="size-4" /> Edit
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onSelect={onFreeze}>
              <Snowflake className="size-4" />
              {prompt.frozen ? "Unfreeze" : "Freeze"}
            </StyledDropdownMenuItem>
            <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
            <StyledDropdownMenuItem
              className="text-destructive focus:bg-destructive/10"
              onSelect={onDelete}
            >
              <Trash2 className="size-4" /> Delete
            </StyledDropdownMenuItem>
          </StyledDropdownMenuContent>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
    </div>
  );
}

export function PromptQueue({
  disabled,
  editingPromptId,
  executing,
  onDelete,
  onEdit,
  onFreeze,
  onReorder,
  onSteer,
  prompts,
}: {
  disabled: boolean;
  editingPromptId: string | null;
  executing: boolean;
  onDelete(prompt: QueuedPrompt): void;
  onEdit(prompt: QueuedPrompt): void;
  onFreeze(prompt: QueuedPrompt): void;
  onReorder(ids: string[]): void;
  onSteer(prompt: QueuedPrompt): void;
  prompts: QueuedPrompt[];
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const visible = prompts.filter(({ id }) => id !== editingPromptId);
  const active = prompts.find(({ id }) => id === activeId) ?? null;
  const dragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    if (!event.over || event.active.id === event.over.id) return;
    const from = prompts.findIndex(({ id }) => id === event.active.id);
    const to = prompts.findIndex(({ id }) => id === event.over?.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(prompts, from, to).map(({ id }) => id));
  };

  if (visible.length === 0) return null;
  return (
    <div className="chat-composer-surface mb-2 max-h-44 overflow-y-auto rounded-xl border p-1 shadow-xl">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(event: DragStartEvent) =>
          setActiveId(String(event.active.id))
        }
        onDragCancel={() => setActiveId(null)}
        onDragEnd={dragEnd}
      >
        <SortableContext
          items={visible.map(({ id }) => id)}
          strategy={verticalListSortingStrategy}
        >
          {visible.map((prompt) => (
            <PromptRow
              key={prompt.id}
              prompt={prompt}
              disabled={disabled}
              executing={executing}
              onDelete={() => onDelete(prompt)}
              onEdit={() => onEdit(prompt)}
              onFreeze={() => onFreeze(prompt)}
              onSteer={() => onSteer(prompt)}
            />
          ))}
        </SortableContext>
        <DragOverlay dropAnimation={{ duration: 150, easing: "ease" }}>
          {active ? (
            <div className="flex h-9 items-center gap-2 rounded-lg border bg-popover px-2 text-sm shadow-xl">
              <GripVertical className="size-3.5 text-muted-foreground" />
              <span className="max-w-lg truncate">
                {active.text || "Attachment prompt"}
              </span>
              {active.attachments.length > 0 ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="size-3" /> {active.attachments.length}
                </span>
              ) : null}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
