import type { ExplorerSummary, GitStatus } from "@cantrip/protocol";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ExplorerView,
  type ExplorerHeaderState,
} from "@/components/explorer/explorer-view";
import { ContentHeaderActions } from "@/components/workspace/content-header-actions";
import {
  closeCurrentDesktopWindow,
  desktopPopoutTitlebarLeftInset,
  updateDesktopWindowTitle,
} from "@/lib/desktop-popout";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";
import { cn } from "@/lib/utils";

function fileName(path: string): string {
  return path.split("/").at(-1) || path;
}

export function ExplorerFilePopout({
  error,
  explorer,
  gitStatus,
  loading,
  overlayTitlebar,
  path,
  projectTitle,
}: {
  error: string | null;
  explorer: ExplorerSummary | null;
  gitStatus?: GitStatus;
  loading: boolean;
  overlayTitlebar: boolean;
  path: string;
  projectTitle?: string;
}) {
  const [header, setHeader] = useState<ExplorerHeaderState | null>(null);
  const title = fileName(path);
  const close = useCallback(() => {
    void closeCurrentDesktopWindow().catch((closeError: unknown) => {
      clientLogger.warn("Explorer file pop-out did not close", {
        event: "surface.explorer.popout.close.failed",
        operation: "close-popout",
        status: "failed",
        subsystem: "explorer",
        ...operationalErrorMetadata(closeError),
      });
    });
  }, []);
  const transientFile = useMemo(() => ({ close, path }), [close, path]);

  useEffect(() => {
    const windowTitle = [title, projectTitle, "Cantrip"]
      .filter(Boolean)
      .join(" — ");
    void updateDesktopWindowTitle(windowTitle).catch((titleError: unknown) => {
      clientLogger.warn("Explorer file pop-out title did not update", {
        event: "surface.explorer.popout.title.failed",
        operation: "update-popout-title",
        status: "failed",
        subsystem: "explorer",
        ...operationalErrorMetadata(titleError),
      });
    });
  }, [projectTitle, title]);

  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header
        className={cn(
          "relative flex shrink-0 items-center border-b bg-background",
          overlayTitlebar ? "h-8 gap-2 px-3" : "h-14 gap-3 px-4",
        )}
        data-tauri-drag-region={overlayTitlebar ? "" : undefined}
        style={{
          paddingLeft: desktopPopoutTitlebarLeftInset(true, overlayTitlebar),
        }}
      >
        <div
          className="min-w-0 flex-1"
          data-tauri-drag-region={overlayTitlebar ? "" : undefined}
        >
          <p
            className={cn(
              "truncate font-medium",
              overlayTitlebar ? "text-xs" : "text-sm",
            )}
            data-tauri-drag-region={overlayTitlebar ? "" : undefined}
          >
            {title}
          </p>
          {!overlayTitlebar ? (
            <p className="truncate text-xs text-muted-foreground">{path}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center">
          <ContentHeaderActions compact={overlayTitlebar} explorer={header} />
        </div>
      </header>

      {loading ? (
        <div className="grid min-h-0 flex-1 place-items-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : error ? (
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          <p className="max-w-xl border-y border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </p>
        </div>
      ) : explorer ? (
        <ExplorerView
          explorer={explorer}
          gitStatus={gitStatus}
          onHeaderChange={setHeader}
          transientFile={transientFile}
        />
      ) : null}
    </main>
  );
}
