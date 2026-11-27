import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

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
  panelIdPrefix,
  tabs,
}: {
  activeTab: TabId | null;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onTabChange(tab: TabId): void;
  panelIdPrefix?: string;
  tabs: readonly NavigationTab<TabId>[];
}) {
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const enabledTabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]:enabled',
      ),
    );
    const current = enabledTabs.findIndex((tab) => tab === event.target);
    if (current < 0) return;

    const last = enabledTabs.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowRight"
            ? (current + 1) % enabledTabs.length
            : (current + last) % enabledTabs.length;
    event.preventDefault();
    enabledTabs[next]?.focus();
    enabledTabs[next]?.click();
  }

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain",
        className,
      )}
      role="tablist"
      onKeyDown={panelIdPrefix ? moveFocus : undefined}
    >
      {tabs.map(
        ({ attention, disabled: tabDisabled, icon: Icon, id, label }) => (
          <Button
            key={id}
            type="button"
            role="tab"
            id={panelIdPrefix ? `${panelIdPrefix}-${id}-tab` : undefined}
            aria-controls={
              panelIdPrefix ? `${panelIdPrefix}-${id}-panel` : undefined
            }
            aria-selected={activeTab === id}
            tabIndex={panelIdPrefix ? (activeTab === id ? 0 : -1) : undefined}
            disabled={disabled || tabDisabled}
            size="sm"
            variant="ghost"
            className={cn(
              "h-10 shrink-0 rounded-none border-b-2 px-2.5 text-xs",
              activeTab === id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground",
              panelIdPrefix && "focus-visible:ring-inset",
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
