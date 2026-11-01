import type {
  NbtDocumentClient,
  NbtDisplayRow,
  NbtEditStatus,
} from "@cantrip/nbt/document";
import type { NbtEditAction } from "./edit-sheet";
import { container, numericArray, nbtControl } from "./format";

export function NbtEditActions({
  client,
  edit,
  selected,
  readOnly,
  onEdit,
  onError,
}: {
  client: NbtDocumentClient;
  edit: NbtEditStatus | null;
  selected: NbtDisplayRow | null;
  readOnly: boolean;
  onEdit(action: NbtEditAction): void;
  onError(message: string): void;
}) {
  const actions: Array<{ action: NbtEditAction; label: string }> = [];
  if (selected) {
    if (!container(selected.node) && !numericArray(selected.node))
      actions.push({ action: "value", label: "Edit value" });
    if (container(selected.node))
      actions.push({ action: "insert", label: "Add tag" });
    if (numericArray(selected.node))
      actions.push({ action: "array", label: "Edit array range" });
    if (selected.node.name) actions.push({ action: "rename", label: "Rename" });
    if (selected.node.parent !== null)
      actions.push(
        { action: "duplicate", label: "Duplicate" },
        { action: "delete", label: "Delete" },
      );
    actions.push({ action: "replace", label: "Change type" });
  }
  const run = (operation: () => Promise<unknown>) =>
    void operation().catch((error) =>
      onError(error instanceof Error ? error.message : "NBT edit failed."),
    );
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/30 px-3 py-2 text-xs"
      aria-label="NBT edit actions"
    >
      <button
        className={nbtControl}
        disabled={!edit?.canUndo || readOnly}
        onClick={() => run(() => client.undo())}
      >
        Undo
      </button>
      <button
        className={nbtControl}
        disabled={!edit?.canRedo || readOnly}
        onClick={() => run(() => client.redo())}
      >
        Redo
      </button>
      {actions.map(({ action, label }) => (
        <button
          key={action}
          className={nbtControl}
          disabled={readOnly}
          onClick={() => onEdit(action)}
        >
          {label}
        </button>
      ))}
      {!selected ? (
        <span className="text-muted-foreground">Select a tag to edit.</span>
      ) : null}
    </div>
  );
}
