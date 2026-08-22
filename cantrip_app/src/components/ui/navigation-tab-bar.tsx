import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface NavigationTab<TabId extends string> {
  attention?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  id: TabId;
  label: string;
}

export function NavigationTabBar<TabId extends string>({
  activeTab,
  ariaLabel,
  className,
  disabled = false,
  onTabChange,
  tabs,
}: {
  activeTab: TabId | null;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onTabChange(tab: TabId): void;
  tabs: readonly NavigationTab<TabId>[];
}) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1",
        className,
      )}
      role="tablist"
    >
      {tabs.map(
        ({ attention, disabled: tabDisabled, icon: Icon, id, label }) => (
          <Button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            disabled={disabled || tabDisabled}
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
            {Icon ? <Icon className="size-3.5" /> : null}
            {label}
            {attention ? (
              <span
                aria-label={`${label} active`}
                className="size-1.5 rounded-full bg-amber-500"
              />
            ) : null}
          </Button>
        ),
      )}
    </div>
  );
}
