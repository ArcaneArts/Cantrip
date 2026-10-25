import { isTauri, invoke } from "@tauri-apps/api/core";
import { desktopQuitCoordinator } from "./desktop-quit-coordinator";
import { clientLogger } from "./client-log-relay";

const checkpointReasons = new Map([
  ["Editor transfer resource changed or was unmounted.", "resource-changed"],
  ["Editor transfer account changed before suspension.", "account-changed"],
  ["Editor is unavailable or already transferring.", "transfer-pending"],
  ["This legacy draft has not migrated to protected recovery.", "legacy-draft"],
  ["Legacy file recovery is still pending.", "legacy-recovery-pending"],
  ["Document ownership changed while preparing transfer.", "document-changed"],
  [
    "Editor transfer account changed during capture.",
    "capture-account-changed",
  ],
  ["Editor ownership changed during shutdown.", "ownership-changed"],
  ["Document view was closed.", "document-closed"],
]);

/** Installed before rendering editors. Native acknowledgements contain no text. */
export async function installDesktopQuit(): Promise<void> {
  if (!isTauri()) return;
  const { listen } = await import("@tauri-apps/api/event");
  const token = crypto.randomUUID();
  let active: number | null = null;
  let previousInert = false;
  const release = (id: number) => {
    if (active !== id) return;
    desktopQuitCoordinator.cancel(id);
    document.body.inert = previousInert;
    active = null;
  };
  const removePrepare = await listen<number>(
    "cantrip-quit-prepare",
    ({ payload: id }) => {
      if (active !== null) return;
      active = id;
      previousInert = document.body.inert;
      document.body.inert = true;
      void desktopQuitCoordinator
        .prepare(id, () => {
          clientLogger.warn("Desktop quit ownership changed", {
            event: "desktop.quit.invalidated",
          });
          void invoke("acknowledge_desktop_quit", {
            id,
            token,
            ok: false,
          }).catch(() => release(id));
        })
        .then(
          () => invoke("acknowledge_desktop_quit", { id, token, ok: true }),
          (error) => {
            clientLogger.warn("Desktop quit checkpoint failed", {
              event: "desktop.quit.failed",
              reasonCode:
                error instanceof Error
                  ? (checkpointReasons.get(error.message) ??
                    "checkpoint-failed")
                  : "checkpoint-failed",
            });
            return invoke("acknowledge_desktop_quit", { id, token, ok: false });
          },
        )
        .catch(() => release(id));
    },
  );
  const removeCancel = await listen<number>(
    "cantrip-quit-cancel",
    ({ payload }) => release(payload),
  );
  try {
    await invoke("register_desktop_quit", { token });
  } catch (error) {
    removePrepare();
    removeCancel();
    throw error;
  }
}
