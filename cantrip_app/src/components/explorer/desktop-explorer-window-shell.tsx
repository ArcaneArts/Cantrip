import type { ReactNode } from "react";

export function DesktopExplorerWindowHeader({
  actions,
  path,
  titlebarLeftInset,
}: {
  actions?: ReactNode;
  path: string;
  titlebarLeftInset?: string;
}) {
  return (
    <header
      className="relative flex h-9 shrink-0 items-center border-b border-border/70 bg-background pr-2"
      data-tauri-drag-region=""
      style={{ paddingLeft: titlebarLeftInset ?? "0.5rem" }}
    >
      <span
        className="min-w-0 flex-1 truncate px-2 text-xs text-muted-foreground"
        data-tauri-drag-region=""
      >
        {path}
      </span>
      {actions}
    </header>
  );
}

export function DesktopExplorerWindowLoadingShell({
  path,
  titlebarLeftInset,
}: {
  path: string;
  titlebarLeftInset?: string;
}) {
  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <DesktopExplorerWindowHeader
        path={path}
        titlebarLeftInset={titlebarLeftInset}
      />
      <div className="grid min-h-0 flex-1 place-items-center bg-background">
        <div
          aria-label="Loading editor"
          className="size-5 animate-spin rounded-full border-2 border-muted-foreground/60 border-t-transparent"
          role="status"
        />
      </div>
    </main>
  );
}
