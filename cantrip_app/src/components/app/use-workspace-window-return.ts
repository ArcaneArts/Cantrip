import { useEffect, useRef } from "react";
import { bindNativeFileWindowClose } from "@/lib/native-file-window-close";
import { detachWorkspaceEditors } from "./detach-workspace-editors";

type Source = Parameters<typeof detachWorkspaceEditors>[0];

/** The native close callback owns destruction. Failed handoffs leave the
 * window and protected source sessions alive for recovery. Application exit
 * is handled by the native application lifecycle, not this close request. */
export function useWorkspaceWindowReturn({
  enabled,
  source,
  onError,
}: {
  enabled: boolean;
  source: Omit<Source, "paneId" | "title"> | null;
  onError(error: unknown): void;
}) {
  const current = useRef({ source, onError });
  current.current = { source, onError };
  useEffect(() => {
    if (!enabled || !source) return;
    const { controller, windowId } = source;
    let disposed = false;
    let binding: ReturnType<typeof bindNativeFileWindowClose> | undefined;
    const report = (error: unknown) => {
      if (!disposed) current.current.onError(error);
    };
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (disposed) return;
        binding = bindNativeFileWindowClose(
          getCurrentWindow(),
          () => true,
          async () => {
            const initial = current.current.source;
            if (
              !initial ||
              initial.controller !== controller ||
              initial.windowId !== windowId
            )
              throw new Error("Workspace changed before window return.");
            const layout = controller.getSnapshot().authoritative;
            if (windowId === layout.mainWindowId)
              throw new Error("The main window cannot return to itself.");
            const panes =
              layout.windows.find(({ id }) => id === windowId)?.panes ?? [];
            for (const pane of panes) {
              if (disposed || current.current.source?.controller !== controller)
                throw new Error("Workspace changed during window return.");
              await detachWorkspaceEditors({
                ...initial,
                paneId: pane.id,
                title: "Returning workspace",
                returnToMain: true,
              });
            }
            const final = controller.getSnapshot();
            if (
              final.disposed ||
              final.authoritative.windows.find(({ id }) => id === windowId)
                ?.panes.length
            )
              throw new Error(
                "The window still owns views; it was not closed.",
              );
            return true;
          },
          report,
        );
      })
      .catch(report);
    return () => {
      disposed = true;
      binding?.dispose();
    };
  }, [enabled, source?.controller, source?.windowId]);
}
