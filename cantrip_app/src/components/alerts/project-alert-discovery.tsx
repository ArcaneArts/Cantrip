import { Bell } from "lucide-react";
import { useRef, useState } from "react";
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
  onOpen(): unknown | Promise<unknown>;
}) {
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  if (count <= 0) return null;
  return (
    <div>
      <button
        type="button"
        data-slot="project-alert-tile"
        title="Open Alert Inbox"
        aria-current={selected ? "page" : undefined}
        aria-busy={opening}
        disabled={opening}
        onClick={async () => {
          if (openingRef.current) return;
          openingRef.current = true;
          setOpening(true);
          setFailed(false);
          try {
            if ((await onOpen()) === false) setFailed(true);
          } catch {
            setFailed(true);
          } finally {
            openingRef.current = false;
            setOpening(false);
          }
        }}
        className={cn(
          "mb-1 flex h-9 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          selected && "bg-muted",
        )}
      >
        <Bell className="size-4 text-amber-600 dark:text-amber-400" />
        {projectAlertCountLabel(count)}
      </button>
      {failed ? (
        <p role="alert" className="px-2 pb-2 text-xs text-destructive">
          Could not open Alert Inbox. Click Alerts to try again.
        </p>
      ) : null}
    </div>
  );
}
