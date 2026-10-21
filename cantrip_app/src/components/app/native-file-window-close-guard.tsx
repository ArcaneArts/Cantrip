import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { bindNativeFileWindowClose } from "@/lib/native-file-window-close";

/** Browser unload warnings do not own Tauri's native titlebar close request. */
export function NativeFileWindowCloseGuard({
  hasUnsavedChanges,
  enabled = true,
}: {
  hasUnsavedChanges(): boolean;
  enabled?: boolean;
}) {
  const current = useRef(hasUnsavedChanges);
  current.current = hasUnsavedChanges;
  const confirmation = useRef<((discard: boolean) => void) | null>(null);
  const [prompt, setPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const settle = (discard: boolean) => {
    const resolve = confirmation.current;
    confirmation.current = null;
    setPrompt(false);
    resolve?.(discard);
  };
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let disposed = false;
    let guard: ReturnType<typeof bindNativeFileWindowClose> | undefined;
    const report = (failure: unknown) => {
      if (!disposed)
        setError(
          failure instanceof Error
            ? failure.message
            : "The file window could not close.",
        );
    };
    setError(null);
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (disposed) return;
        guard = bindNativeFileWindowClose(
          getCurrentWindow(),
          () => current.current(),
          () =>
            new Promise<boolean>((resolve) => {
              confirmation.current = resolve;
              setPrompt(true);
            }),
          report,
        );
        return guard.ready;
      })
      .catch(report);
    return () => {
      disposed = true;
      guard?.dispose();
      confirmation.current?.(false);
      confirmation.current = null;
    };
  }, [attempt, enabled]);
  if (!enabled || !isTauri()) return null;
  return (
    <>
      {error ? (
        <div
          role="alert"
          className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <p>File window close protection: {error}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry close protection
          </Button>
        </div>
      ) : null}
      <Dialog
        open={prompt}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        <DialogContent showClose={false}>
          <DialogHeader>
            <DialogTitle>Close file window?</DialogTitle>
            <DialogDescription>
              Closing discards unsaved changes in this window. A save already in
              progress may still finish.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => settle(true)}>
              Close and discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
