import type { WorkspaceOwnership } from "@cantrip/protocol";
import type { DesktopPopoutPaneTarget } from "./desktop-popout";

/** Source placements remain authoritative during preparation. Reopening their
 * actual window lets a replacement context acquire its lifetime and reconcile
 * the reservation. Staged destinations must never be promoted by restoration. */
export function workspaceWindowRecoveryTargets(layout: WorkspaceOwnership) {
  const transferring = new Set(
    (layout.pendingTransfers ?? [])
      .filter((transfer) => !transfer.returnSplitId)
      .map((transfer) => transfer.destinationWindowId),
  );
  return layout.windows.flatMap((window) => {
    if (window.id === layout.mainWindowId || transferring.has(window.id))
      return [];
    const pane =
      window.panes.find((pane) => pane.id === window.focusedPaneId) ??
      window.panes.find((pane) => pane.tabs.length > 0);
    if (!pane?.tabs.length) return [];
    return [
      {
        windowId: window.id,
        target: {
          projectId: layout.projectId,
          paneId: pane.id,
          activeTabKey: pane.activeTabId ?? pane.tabs[0]!.id,
        } satisfies DesktopPopoutPaneTarget,
      },
    ];
  });
}

/** Re-read between asynchronous native operations. Errors do not erase owners
 * or prevent the remaining independent windows from being restored. */
export async function restoreWorkspaceWindows(input: {
  read(): WorkspaceOwnership | null;
  open(windowId: string, target: DesktopPopoutPaneTarget): Promise<unknown>;
  onError(error: unknown): void;
}) {
  const initial = input.read();
  if (!initial) return;
  for (const candidate of workspaceWindowRecoveryTargets(initial)) {
    const current = input.read();
    if (!current || current.id !== initial.id) return;
    const target = workspaceWindowRecoveryTargets(current).find(
      (entry) => entry.windowId === candidate.windowId,
    );
    if (!target) continue;
    try {
      await input.open(target.windowId, target.target);
    } catch (error) {
      if (input.read()?.id === initial.id) input.onError(error);
    }
  }
}
