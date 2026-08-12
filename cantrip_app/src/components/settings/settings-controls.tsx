import { Search, X, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SettingsTab<TabId extends string> {
  icon: LucideIcon;
  id: TabId;
  label: string;
}

export function SettingsTabBar<TabId extends string>({
  activeTab,
  ariaLabel = "Settings sections",
  onTabChange,
  tabs,
}: {
  activeTab: TabId;
  ariaLabel?: string;
  onTabChange(tab: TabId): void;
  tabs: readonly SettingsTab<TabId>[];
}) {
  return (
    <div
      aria-label={ariaLabel}
      className="flex h-10 w-full min-w-0 shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain border-b px-4 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden"
      role="tablist"
    >
      {tabs.map(({ icon: Icon, id, label }) => (
        <Button
          key={id}
          type="button"
          role="tab"
          aria-selected={activeTab === id}
          size="sm"
          variant="ghost"
          className={cn(
            "h-10 shrink-0 rounded-none border-b-2 px-2.5 text-xs",
            activeTab === id
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground",
          )}
          onClick={() => onTabChange(id)}
        >
          <Icon className="size-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );
}

export function SettingsSearchField({
  ariaLabel,
  className,
  onValueChange,
  placeholder,
  value,
}: {
  ariaLabel: string;
  className?: string;
  onValueChange(value: string): void;
  placeholder: string;
  value: string;
}) {
  return (
    <div className={cn("relative max-w-xl", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        role="searchbox"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className="h-9 w-full rounded-md border bg-background pl-9 pr-9 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      {value ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-0.5 top-0.5 size-8"
          onClick={() => onValueChange("")}
        >
          <X className="size-3.5" />
          <span className="sr-only">Clear search</span>
        </Button>
      ) : null}
    </div>
  );
}
