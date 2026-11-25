import { ArrowLeft, Settings, X } from "lucide-react";
import type { ReactNode } from "react";

import { MobileAppModeSwitch } from "@/components/mobile/mobile-app-mode-switch";
import { Button } from "@/components/ui/button";
import type { ShellAppMode } from "@/lib/app-mode";

export function MobileProjectHeader({
  actions,
  appMode,
  context,
  onBack,
  onCloseProject,
  onChooseMode,
  onOpenProjectSettings,
  onSwitchAppMode,
  title,
}: {
  actions?: ReactNode;
  appMode?: ShellAppMode | null;
  context?: string | null;
  onBack?: () => void;
  onCloseProject?: () => void;
  onChooseMode?(mode: ShellAppMode): void;
  onOpenProjectSettings?: () => void;
  onSwitchAppMode?: () => void;
  title: string;
}) {
  return (
    <header className="mobile-safe-top relative z-30 flex h-16 shrink-0 items-center gap-2 border-b px-3">
      {onBack ? (
        <Button
          aria-label="Back"
          className="size-9"
          onClick={onBack}
          size="icon"
          variant="ghost"
        >
          <ArrowLeft className="size-4" />
        </Button>
      ) : null}
      {onCloseProject ? (
        <Button
          aria-label="Close project"
          className="size-9"
          onClick={onCloseProject}
          size="icon"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1 px-1">
        <h1 className="truncate text-sm font-medium">{title}</h1>
        {context ? (
          <p className="truncate text-xs text-muted-foreground">{context}</p>
        ) : null}
      </div>
      {onOpenProjectSettings || actions || (appMode && onSwitchAppMode) ? (
        <div
          className="flex shrink-0 items-center gap-1"
          data-slot="mobile-project-header-actions"
        >
          {onOpenProjectSettings ? (
            <Button
              aria-label="Project settings"
              className="size-9"
              onClick={onOpenProjectSettings}
              size="icon"
              variant="ghost"
            >
              <Settings className="size-4" />
            </Button>
          ) : null}
          {actions}
          {appMode && onSwitchAppMode ? (
            <MobileAppModeSwitch
              currentMode={appMode}
              onChooseMode={onChooseMode}
              onSwitch={onSwitchAppMode}
            />
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
