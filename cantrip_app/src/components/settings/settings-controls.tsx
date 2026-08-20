import { Search, X, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  NavigationTabBar,
  type NavigationTab,
} from "@/components/ui/navigation-tab-bar";
import { cn } from "@/lib/utils";

export interface SettingsTab<
  TabId extends string,
> extends NavigationTab<TabId> {
  icon: LucideIcon;
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
    <NavigationTabBar
      activeTab={activeTab}
      ariaLabel={ariaLabel}
      className="w-full border-b px-4 sm:px-6"
      tabs={tabs}
      onTabChange={onTabChange}
    />
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
