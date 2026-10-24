import { useCallback, useEffect, useRef, useState } from "react";
import type { CodeAppearance, ExplorerFileMode } from "@cantrip/protocol";
import type { ProjectSurface } from "@/lib/project-surface";
import type { FileDocument } from "@/lib/api/file-documents";
import { PersistentSurfacePortal } from "@/components/app/persistent-surface-portal";
import { FileDocumentView } from "./file-document-view";
import { defaultExplorerFileMode } from "./explorer-file-language";
import type {
  ExplorerHeaderState,
  ExplorerLifecycleActions,
  IncomingEditorView,
} from "./explorer-view";

interface Placement {
  tabId: string;
  paneId: string;
  portalTarget: Element | null;
  focused: boolean;
}

interface Props {
  incomingViews?: readonly IncomingEditorView<FileDocument>[];
  surfaces: readonly ProjectSurface[];
  placements?: readonly Placement[];
  activeTabId?: string | null;
  appearance: CodeAppearance;
  onlineWorkerIds?: ReadonlySet<string>;
  onOpenFile(projectId: string, worktreeId: string, path: string): void;
  onModeChange?(tabId: string, mode: ExplorerFileMode): Promise<void>;
  onHeaderChange?(header: ExplorerHeaderState | null): void;
  onLifecycleChange?(
    tabId: string,
    actions: ExplorerLifecycleActions | null,
  ): void;
}

function RetainedDocumentView({
  document,
  tabId,
  placement,
  active,
  incoming,
  savedMode,
  ...props
}: Omit<Props, "surfaces" | "placements" | "activeTabId"> & {
  document: FileDocument;
  tabId: string;
  placement?: Placement;
  active: boolean;
  incoming?: IncomingEditorView<FileDocument>;
  savedMode?: ExplorerFileMode;
}) {
  const [mode, setMode] = useState<ExplorerFileMode>(
    () =>
      incoming?.state.fileMode ??
      savedMode ??
      defaultExplorerFileMode(document.path),
  );
  const previousSavedMode = useRef(savedMode);
  useEffect(() => {
    if (savedMode !== undefined && savedMode !== previousSavedMode.current)
      setMode(savedMode);
    previousSavedMode.current = savedMode;
  }, [savedMode]);
  const changeMode = useCallback(
    async (next: ExplorerFileMode) => {
      if (!props.onModeChange)
        throw new Error("File view ownership is unavailable.");
      await props.onModeChange(tabId, next);
      setMode(next);
    },
    [props.onModeChange, tabId],
  );
  const openFile = useCallback(
    (path: string) =>
      props.onOpenFile(document.projectId, document.worktreeId, path),
    [props.onOpenFile, document.projectId, document.worktreeId],
  );
  return (
    <div
      aria-hidden={!active}
      className={
        active ? "flex min-h-0 min-w-0 flex-1 overflow-hidden" : "hidden"
      }
      data-project-pane-id={placement?.paneId}
    >
      <FileDocumentView
        tabId={tabId}
        document={document}
        mode={mode}
        onModeChange={changeMode}
        onOpenFile={openFile}
        appearance={props.appearance}
        active={active}
        initialTransfer={incoming?.state}
        transferStaging={incoming?.staging}
        workerOnline={props.onlineWorkerIds?.has(document.workerId)}
        onHeaderChange={
          active && (!placement || placement.focused)
            ? props.onHeaderChange
            : undefined
        }
        onLifecycleChange={props.onLifecycleChange}
      />
    </div>
  );
}

/** Keep each owned view mounted across selection, pane moves, and catalog refreshes. */
export function PersistentFileDocumentViews({
  surfaces,
  placements,
  activeTabId,
  incomingViews,
  ...props
}: Props) {
  const retained = useRef(new Map<string, FileDocument>());
  const views = surfaces.flatMap((surface) => {
    if (
      surface.resource.ref.kind !== "entity" ||
      surface.resource.ref.definitionId !== "project.file"
    )
      return [];
    const previous = retained.current.get(surface.tabKey);
    const document =
      surface.kind === "file"
        ? surface.entity
        : previous?.id === surface.resource.ref.resourceId &&
            previous.projectId === surface.projectId
          ? previous
          : undefined;
    return document ? [{ tabId: surface.tabKey, document }] : [];
  });
  for (const incoming of incomingViews ?? []) {
    const index = views.findIndex(({ tabId }) => tabId === incoming.tabId);
    const view = { tabId: incoming.tabId, document: incoming.resource };
    if (index < 0) views.push(view);
    else views[index] = view;
  }
  useEffect(() => {
    retained.current = new Map(
      views.map(({ tabId, document }) => [tabId, document]),
    );
  }, [views]);
  return views.map(({ tabId, document }) => {
    const placement = placements?.find((entry) => entry.tabId === tabId);
    const active = placements
      ? Boolean(placement?.portalTarget)
      : activeTabId === tabId;
    const key = `${tabId}:${document.id}`;
    const view = (
      <RetainedDocumentView
        {...props}
        key={key}
        tabId={tabId}
        document={document}
        placement={placement}
        active={active}
        incoming={incomingViews?.find((incoming) => incoming.tabId === tabId)}
        savedMode={
          surfaces.find((surface) => surface.tabKey === tabId)?.fileMode
        }
      />
    );
    return placements ? (
      <PersistentSurfacePortal
        key={key}
        portalKey={key}
        host={placement?.portalTarget ?? null}
      >
        {view}
      </PersistentSurfacePortal>
    ) : (
      view
    );
  });
}
