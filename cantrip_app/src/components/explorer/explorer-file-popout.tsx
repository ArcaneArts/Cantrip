import { PanelToolbar } from "@/components/workspace/panel-toolbar";
import type { CodeAppearance, ExplorerSummary } from "@cantrip/protocol";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ExplorerView,
  type ExplorerHeaderState,
  type ExplorerLifecycleActions,
} from "./explorer-view";
import { ContentHeaderActions } from "@/components/workspace/content-header-actions";
import { NativeFileWindowCloseGuard } from "@/components/app/native-file-window-close-guard";
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
  const [header, setHeader] = useState<ExplorerHeaderState | null>(null);
  const lifecycle = useRef<ExplorerLifecycleActions | null>(null);
  const onLifecycleChange = useCallback(
    (_id: string, actions: ExplorerLifecycleActions | null) => {
      lifecycle.current = actions;
    },
    [],
  );

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

      <NativeFileWindowCloseGuard
        hasUnsavedChanges={() => lifecycle.current?.dirty ?? false}
      />
      <PanelToolbar as="header" aria-label="File controls">
        <span className="min-w-0 flex-1 truncate text-xs">{title}</span>
        <ContentHeaderActions compact explorer={header} />
      </PanelToolbar>
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
          appearance={appearance}
          explorer={explorer}
          transientFile={{ path, close: () => window.close() }}
          showToolbar={false}
          onHeaderChange={setHeader}
          onLifecycleChange={onLifecycleChange}
          repositoryGraphAvailable={false}
        />
      ) : null}
    </main>
  );
}
