import { useEffect, useRef } from "react";
import { desktopQuitCoordinator } from "@/lib/desktop-quit-coordinator";
import type { ExplorerLifecycleActions } from "./explorer-view";

export function useEditorQuit(
  lifecycle: ExplorerLifecycleActions,
  protectedDocument: boolean,
) {
  const current = useRef({ lifecycle, protectedDocument });
  current.current = { lifecycle, protectedDocument };
  useEffect(
    () =>
      desktopQuitCoordinator.register({
        suspend: () =>
          current.current.lifecycle.suspendTransfer?.() ?? (() => {}),
        checkpoint: async () => {
          const { lifecycle, protectedDocument } = current.current;
          // Legacy views without protected recovery must not silently lose drafts.
          if (!protectedDocument && lifecycle.dirty)
            throw new Error(
              "This legacy draft has not migrated to protected recovery.",
            );
          await lifecycle.captureTransfer?.();
        },
      }),
    [],
  );
}
