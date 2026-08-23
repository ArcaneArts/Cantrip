import type { CodeAppearance, ExplorerSummary } from "@cantrip/protocol";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";

import { ExplorerCodeEditor } from "@/components/explorer/explorer-code-editor";
import {
  desktopPopoutTitlebarLeftInset,
  updateDesktopWindowTitle,
} from "@/lib/desktop-popout";
import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";

function fileName(path: string): string {
  return path.split("/").at(-1) || path;
}

export function ExplorerFilePopout({
  error,
  appearance,
  explorer,
  loading,
  overlayTitlebar,
  path,
  projectTitle,
}: {
  appearance: CodeAppearance;
  error: string | null;
  explorer: ExplorerSummary | null;
  loading: boolean;
  overlayTitlebar: boolean;
  path: string;
  projectTitle?: string;
}) {
  const title = fileName(path);

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
      {overlayTitlebar ? (
        <header
          className="h-8 shrink-0 bg-background"
          data-tauri-drag-region=""
          style={{ paddingLeft: desktopPopoutTitlebarLeftInset(true, true) }}
        />
      ) : null}

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
        <ExplorerCodeEditor
          appearance={appearance}
          explorerId={explorer.id}
          path={path}
          projectId={explorer.projectId}
          worktreeId={explorer.worktreeId}
        />
      ) : null}
    </main>
  );
}
