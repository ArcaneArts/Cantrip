import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ModelProviderAccountSummary } from "@cantrip/protocol";
import { GripVertical } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

export function reorderedProviderAccounts(
  accounts: ModelProviderAccountSummary[],
  activeId: string,
  overId: string,
): ModelProviderAccountSummary[] {
  const from = accounts.findIndex(({ id }) => id === activeId);
  const to = accounts.findIndex(({ id }) => id === overId);
  if (from < 0 || to < 0 || from === to) return accounts;
  return arrayMove(accounts, from, to).map((account, position) => ({
    ...account,
    position,
  }));
}

function SortableProviderAccountChip({
  account,
  disabled,
  index,
  onSelect,
  selected,
  sortableEnabled,
}: {
  account: ModelProviderAccountSummary;
  disabled: boolean;
  index: number;
  onSelect(): void;
  selected: boolean;
  sortableEnabled: boolean;
}) {
  const sortable = useSortable({
    id: account.id,
    disabled: disabled || !sortableEnabled,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  return (
    <div
      ref={sortable.setNodeRef}
      className={cn(
        "inline-flex h-8 shrink-0 items-center rounded-md text-sm font-medium transition-colors",
        selected
          ? "border border-input bg-background shadow-xs"
          : "hover:bg-accent hover:text-accent-foreground",
        disabled && "pointer-events-none opacity-50",
        sortable.isDragging && "z-10 opacity-40",
      )}
      style={style}
    >
      {sortableEnabled ? (
        <button
          type="button"
          className="grid h-full w-6 touch-none place-items-center rounded-l-md text-muted-foreground hover:text-foreground"
          disabled={disabled}
          aria-label={`Drag ${account.label} to change priority`}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical className="size-3" />
        </button>
      ) : null}
      <button
        type="button"
        className={cn(
          "flex h-full items-center gap-1.5 rounded-md pr-2.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          sortableEnabled ? "pl-0.5" : "pl-2.5",
        )}
        disabled={disabled}
        aria-label={`${account.label}, priority ${index + 1}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span
          className={`size-1.5 rounded-full ${account.credentialState === "signed-in" ? "bg-emerald-400" : "bg-muted-foreground/45"}`}
        />
        {account.label}
      </button>
    </div>
  );
}

export function ProviderAccountPriorityChips({
  accounts,
  disabled,
  onReorder,
  onSelect,
  selectedAccountId,
}: {
  accounts: ModelProviderAccountSummary[];
  disabled: boolean;
  onReorder(accounts: ModelProviderAccountSummary[]): void;
  onSelect(accountId: string): void;
  selectedAccountId: string | null;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const sortableEnabled = accounts.length > 1;
  const dragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    const reordered = reorderedProviderAccounts(
      accounts,
      String(event.active.id),
      String(event.over.id),
    );
    if (reordered !== accounts) onReorder(reordered);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={dragEnd}
    >
      <SortableContext
        items={accounts.map(({ id }) => id)}
        strategy={rectSortingStrategy}
      >
        <div className="flex flex-wrap gap-1.5">
          {accounts.map((account, index) => (
            <SortableProviderAccountChip
              key={account.id}
              account={account}
              disabled={disabled}
              index={index}
              selected={account.id === selectedAccountId}
              sortableEnabled={sortableEnabled}
              onSelect={() => onSelect(account.id)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
