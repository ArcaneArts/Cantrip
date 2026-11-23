import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";

export function ListPageControls({
  count,
  page,
  pageSize,
  label,
  onPageChange,
}: {
  count: number;
  page: number;
  pageSize: number;
  label: string;
  onPageChange(page: number): void;
}) {
  if (count <= pageSize) return null;
  return (
    <nav
      aria-label={`${label} pages`}
      className="flex items-center justify-between gap-2 border-t px-3 py-1"
      onKeyDown={(event) => {
        // A containing command menu must not turn pagination's Enter into an
        // option selection, or interpret its navigation keys as list movement.
        if (
          ["Enter", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
        )
          event.stopPropagation();
      }}
    >
      <span
        role="status"
        aria-live="polite"
        className="min-w-0 text-xs tabular-nums text-muted-foreground"
      >
        {(page * pageSize + 1).toLocaleString()}–
        {Math.min(count, (page + 1) * pageSize).toLocaleString()} of{" "}
        {count.toLocaleString()}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={page === 0}
          aria-label={`Previous ${label} page`}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={(page + 1) * pageSize >= count}
          aria-label={`Next ${label} page`}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </nav>
  );
}
