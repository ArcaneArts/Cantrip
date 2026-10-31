import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  dataTransferHasFiles,
  filesFromDataTransfer,
} from "@/components/chat/file-drop";
import type { ExplorerFileMutationAuthorization } from "./project-sidebar-file-tree";

export type SidebarFileImportProgress = {
  name: string;
  completed: number;
  total: number;
  index: number;
  count: number;
};
export type SidebarFileImporter = (
  path: string,
  files: File[],
  authorization: ExplorerFileMutationAuthorization,
  onProgress: (progress: SidebarFileImportProgress) => void,
) => Promise<void>;

/** Delegate native HTML file drops without interfering with workspace tab drags. */
export function useSidebarFileDrop({
  scope,
  enabled,
  authorize,
  onImport,
  onExpand,
}: {
  scope: string | null;
  enabled: boolean;
  authorize(): ExplorerFileMutationAuthorization | null;
  onImport?: SidebarFileImporter;
  onExpand(path: string): void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [progress, setProgress] = useState<SidebarFileImportProgress | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const highlight = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const clearHighlight = () => {
    highlight.current?.removeAttribute("data-file-drop-target");
    highlight.current = null;
    setTarget(null);
  };
  useEffect(() => {
    generation.current++;
    active.current = false;
    clearHighlight();
    setProgress(null);
    setError(null);
    return () => {
      generation.current++;
      highlight.current?.removeAttribute("data-file-drop-target");
    };
  }, [scope]);

  const location = (event: DragEvent<HTMLElement>) => {
    const element =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-sidebar-drop-folder]")
        : null;
    const row =
      element && event.currentTarget.contains(element) ? element : null;
    return {
      row: row ?? event.currentTarget,
      path: row?.dataset.sidebarDropFolder ?? "",
    };
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect =
      enabled && onImport && !active.current ? "copy" : "none";
    if (!enabled || !onImport || active.current) return;
    const { row, path } = location(event);
    if (highlight.current !== row) {
      highlight.current?.removeAttribute("data-file-drop-target");
      highlight.current = row;
      row.setAttribute("data-file-drop-target", "");
    }
    setTarget(path);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const { path } = location(event);
    clearHighlight();
    if (active.current) return;
    const authorization = authorize();
    if (!enabled || !onImport || !authorization) {
      setError("Project files are unavailable. Try dropping the files again.");
      return;
    }
    const files = filesFromDataTransfer(event.dataTransfer);
    if (
      Array.from(event.dataTransfer.items).some(
        (item) => item.webkitGetAsEntry?.()?.isDirectory,
      )
    ) {
      setError("Drop individual files here; folder uploads are not supported.");
      return;
    }
    if (!files.length) {
      setError("No readable files were included in the drop.");
      return;
    }
    const operation = generation.current;
    const current = () =>
      operation === generation.current && authorization.isCurrent();
    active.current = true;
    setError(null);
    onExpand(path);
    setProgress({
      name: files[0]!.name,
      completed: 0,
      total: files.reduce((total, file) => total + file.size, 0),
      index: 0,
      count: files.length,
    });
    void onImport(
      path,
      files,
      { ...authorization, isCurrent: current },
      (next) => {
        if (current()) setProgress(next);
      },
    )
      .catch((error: unknown) => {
        if (current())
          setError(
            error instanceof Error
              ? error.message
              : "The files could not be added.",
          );
      })
      .finally(() => {
        if (operation === generation.current) {
          active.current = false;
          setProgress(null);
        }
      });
  };
  return {
    target,
    progress,
    error,
    onDragOver,
    onDrop,
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      )
        clearHighlight();
    },
  };
}
