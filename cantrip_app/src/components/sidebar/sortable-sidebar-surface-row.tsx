import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from "react";

import { InlineRenameLabel } from "@/components/workspace/surface-tab-controls";
import { cn } from "@/lib/utils";

export function openSidebarActionsMenu(event: ReactMouseEvent<HTMLElement>) {
  const trigger = event.currentTarget.querySelector<HTMLButtonElement>(
    "[data-actions-trigger]",
  );
  if (!trigger) return;
  event.preventDefault();
  trigger.click();
}

export function SortableSidebarSurfaceRow({
  actions,
  active,
  editing,
  icon,
  onCancelRename,
  onRename,
  onSelect,
  onSubmitRename,
  openActionsOnContextMenu = true,
  renameValue,
  renderContextMenu,
  sortId,
  status,
  title,
  trailing,
}: {
  actions?: ReactNode;
  active: boolean;
  editing: boolean;
  icon: ReactNode;
  onCancelRename(): void;
  onRename(value: string): void;
  onSelect(): void;
  onSubmitRename(): void;
  openActionsOnContextMenu?: boolean;
  renameValue: string;
  renderContextMenu?: (row: ReactElement) => ReactNode;
  sortId: string;
  status?: ReactNode;
  title: string;
  trailing?: ReactNode;
}) {
  const sortable = useSortable({ id: sortId });
  const row = (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.25 : 1,
        zIndex: sortable.isDragging ? 10 : undefined,
      }}
      onContextMenu={
        openActionsOnContextMenu && actions ? openSidebarActionsMenu : undefined
      }
      className={cn(
        "group flex min-w-0 items-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      {editing ? (
        <InlineRenameLabel
          ariaLabel={`Rename ${title}`}
          className="min-w-0 flex-1"
          value={renameValue}
          onCancel={onCancelRename}
          onChange={onRename}
          onSubmit={onSubmitRename}
        />
      ) : (
        <button
          ref={sortable.setActivatorNodeRef}
          type="button"
          className="flex min-w-0 flex-1 touch-none cursor-grab items-center gap-2 px-2 py-1.5 text-left active:cursor-grabbing"
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            onCancelRename();
          }}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          {icon}
          <span className="truncate">{title}</span>
          {status}
        </button>
      )}
      {!editing ? trailing : null}
      {!editing ? actions : null}
    </div>
  );

  return renderContextMenu ? renderContextMenu(row) : row;
}
