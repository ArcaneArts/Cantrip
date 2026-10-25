import { useEffect, useRef } from "react";
import { isDesktopRuntime, reopenWorkspaceWindow } from "@/lib/desktop-popout";
import type { WorkspaceCommandClient } from "@/lib/workspace-command-client";
import {
  restoreWorkspaceWindows,
  workspaceWindowRecoveryTargets,
} from "@/lib/workspace-window-recovery";

/** Startup/focus recovery is initiated only by the main host. It never moves
 * ownership, replays a transfer payload, or treats a timer as proof of death. */
export function useWorkspaceWindowRecovery(
  connection:
    { controller: WorkspaceCommandClient; windowId: string } | undefined,
  onError: (error: unknown) => void,
) {
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    if (!connection || !isDesktopRuntime()) return;
    const { controller, windowId } = connection;
    if (windowId !== controller.getSnapshot().authoritative.mainWindowId)
      return;
    let disposed = false;
    let running = false;
    const read = () => {
      const state = controller.getSnapshot();
      return disposed || state.disposed ? null : state.authoritative;
    };
    const restore = async () => {
      if (disposed || running) return;
      running = true;
      try {
        await controller.refresh();
        await restoreWorkspaceWindows({
          read,
          open: (id, target) =>
            reopenWorkspaceWindow(id, target, () => {
              const layout = read();
              return (
                !!layout &&
                workspaceWindowRecoveryTargets(layout).some(
                  (candidate) =>
                    candidate.windowId === id &&
                    candidate.target.paneId === target.paneId,
                )
              );
            }),
          onError: (error) => report.current(error),
        });
      } catch (error) {
        if (read()) report.current(error);
      } finally {
        running = false;
      }
    };
    void restore();
    window.addEventListener("focus", restore);
    return () => {
      disposed = true;
      window.removeEventListener("focus", restore);
    };
  }, [connection?.controller, connection?.windowId]);
}
