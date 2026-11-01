import { PanelToolbar } from "@/components/workspace/panel-toolbar";
import type { CodeAppearance, ExplorerSummary } from "@cantrip/protocol";
import { CantripLoading } from "@/components/ui/cantrip-loading";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { createLegacyFileWindowImporter } from "@/lib/import-legacy-file-window";
import { activateWorkspaceWindowRoute } from "@/lib/workspace-window-route";
import { Button } from "@/components/ui/button";
import { useLegacyDraftResolution } from "./use-legacy-draft-resolution";

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
  const [lifecycleRevision, setLifecycleRevision] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const importing = useRef(false);
  const attempted = useRef(-1);
  const importLegacyFileWindow = useMemo(
    () => createLegacyFileWindowImporter(),
    [explorer?.id, path],
  );
  const resolution = useLegacyDraftResolution(importLegacyFileWindow);
  const onLifecycleChange = useCallback(
    (_id: string, actions: ExplorerLifecycleActions | null) => {
      lifecycle.current = actions;
      setLifecycleRevision((value) => value + 1);
    },
    [],
  );

  useEffect(() => {
    const actions = lifecycle.current;
    if (
      !explorer ||
      !actions ||
      loading ||
      error ||
      importing.current ||
      attempted.current === attempt
    )
      return;
    attempted.current = attempt;
    importing.current = true;
    setImportError(null);
    // Suspension flushes an inert renderer; run outside the React commit.
    void Promise.resolve()
      .then(() =>
        importLegacyFileWindow({
          explorerId: explorer.id,
          projectId: explorer.projectId,
          path,
          lifecycle: actions,
          activate: activateWorkspaceWindowRoute,
          resolveConflict: resolution.resolve,
        }),
      )
      .catch((failure: unknown) => {
        setImportError(
          failure instanceof Error
            ? failure.message
            : "The file window could not be imported.",
        );
      })
      .finally(() => {
        importing.current = false;
      });
  }, [
    explorer,
    loading,
    error,
    path,
    lifecycleRevision,
    attempt,
    importLegacyFileWindow,
    resolution.resolve,
  ]);

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
      {resolution.dialog}
      {overlayTitlebar ? (
        <header
          className="h-8 shrink-0 bg-background"
          data-tauri-drag-region=""
          style={{ paddingLeft: desktopPopoutTitlebarLeftInset(true, true) }}
        />
      ) : null}

      <NativeFileWindowCloseGuard
        hasUnsavedChanges={() => lifecycle.current?.dirty ?? false}
        closeBlocked={() => importing.current}
      />
      {importError ? (
        <div role="alert" className="px-3 py-2 text-sm text-destructive">
          <p>{importError}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry file import
          </Button>
        </div>
      ) : null}
      <PanelToolbar as="header" aria-label="File controls">
        <span className="min-w-0 flex-1 truncate text-xs">{title}</span>
        <ContentHeaderActions compact explorer={header} />
      </PanelToolbar>
      {loading ? (
        <CantripLoading label="Loading file…" />
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
