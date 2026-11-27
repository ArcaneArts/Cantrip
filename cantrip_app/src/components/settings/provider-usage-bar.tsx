import { cn } from "@/lib/utils";

const percentage = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

export function ProviderUsageBar({
  label,
  remainingPercent,
  resetText,
}: {
  label: string;
  remainingPercent: number | null;
  resetText?: string | null;
}) {
  const value =
    remainingPercent === null
      ? "Unavailable"
      : `${percentage.format(remainingPercent)}% left`;
  return (
    <div className="grid gap-1.5">
      <div className="flex justify-between gap-2 text-xs">
        <span>{label}</span>
        <span className="shrink-0 font-medium tabular-nums">{value}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent ?? undefined}
        aria-valuetext={value}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            remainingPercent === null
              ? "bg-muted-foreground/35"
              : remainingPercent <= 10
                ? "bg-destructive"
                : remainingPercent <= 25
                  ? "bg-amber-500"
                  : "bg-emerald-500",
          )}
          style={{ width: `${remainingPercent ?? 0}%` }}
        />
      </div>
      {resetText ? (
        <p className="text-[11px] text-muted-foreground">{resetText}</p>
      ) : null}
    </div>
  );
}
