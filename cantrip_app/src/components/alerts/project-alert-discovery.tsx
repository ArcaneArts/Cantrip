import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
export function projectAlertCountLabel(count: number) {
  return `${count} ${count === 1 ? "Alert" : "Alerts"}`;
}
export function AlertCountBadge({ count = 0 }: { count?: number }) {
  if (count <= 0) return null;
  const label = projectAlertCountLabel(count);
  return (
    <span
      data-slot="project-alert-count"
      aria-label={label}
      title={label}
      className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-700 dark:text-amber-300"
    >
      {count > 999 ? "999+" : count}
    </span>
  );
}
export function ProjectAlertTile({
  count = 0,
  selected = false,
  onOpen,
}: {
  count?: number;
  selected?: boolean;
  onOpen(): void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      data-slot="project-alert-tile"
      title="Open Alert Inbox"
      aria-current={selected ? "page" : undefined}
      onClick={onOpen}
      className={cn(
        "mb-1 flex h-9 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted",
      )}
    >
      <Bell className="size-4 text-amber-600 dark:text-amber-400" />
      {projectAlertCountLabel(count)}
    </button>
  );
}
