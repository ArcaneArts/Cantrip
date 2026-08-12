import { ArrowLeft, Settings, X } from "lucide-react";

import { Button } from "@/components/ui/button";

export function MobileProjectHeader({
  context,
  onBack,
  onCloseProject,
  onOpenProjectSettings,
  title,
}: {
  context?: string | null;
  onBack?: () => void;
  onCloseProject?: () => void;
  onOpenProjectSettings?: () => void;
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
    </header>
  );
}
