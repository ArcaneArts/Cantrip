import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { onClientSessionIdentityChanged } from "@/lib/client-session";
import type {
  LegacyDraftChoice,
  LegacyDraftConflict,
  ResolveLegacyDraft,
} from "./legacy-document-migration";

/** Sensitive previews exist only in this mounted renderer, not layout state or
 * logs. Context changes, account changes and unmount cancel the pending choice. */
export function useLegacyDraftResolution(context: unknown) {
  const [conflict, setConflict] = useState<LegacyDraftConflict | null>(null);
  const pending = useRef<((choice: LegacyDraftChoice | null) => void) | null>(
    null,
  );
  const lifetime = useMemo(() => ({ active: true }), [context]);
  const settle = useCallback((choice: LegacyDraftChoice | null) => {
    const resolve = pending.current;
    pending.current = null;
    setConflict(null);
    resolve?.(choice);
  }, []);
  useEffect(() => {
    lifetime.active = true;
    const cancel = () => {
      lifetime.active = false;
      settle(null);
    };
    const unsubscribe = onClientSessionIdentityChanged(cancel);
    if (typeof window !== "undefined")
      window.addEventListener("pagehide", cancel);
    return () => {
      unsubscribe();
      if (typeof window !== "undefined")
        window.removeEventListener("pagehide", cancel);
      cancel();
    };
  }, [lifetime, settle]);
  const resolve = useCallback<ResolveLegacyDraft>(
    (next) => {
      if (!lifetime.active || pending.current) return Promise.resolve(null);
      return new Promise((done) => {
        pending.current = done;
        setConflict(next);
      });
    },
    [lifetime],
  );
  const path = conflict
    ? (JSON.parse(conflict.live.id) as string[]).at(-1)
    : "";
  return {
    resolve,
    dialog: conflict ? (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) settle(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto">
          <DialogTitle>Resolve recovered file draft</DialogTitle>
          <DialogDescription>
            Two unsaved versions of {path} differ. Compare them and choose which
            draft to keep for this migration. The other version will be
            replaced. Nothing is saved to disk. Cancel keeps both versions
            unchanged.
          </DialogDescription>
          <div className="grid min-h-0 gap-4 sm:grid-cols-2">
            {(["live", "recovered"] as const).map((kind) => (
              <label key={kind} className="grid min-w-0 gap-2 text-sm">
                {kind === "live" ? "Live draft" : "Recovered draft"}
                <textarea
                  aria-label={
                    kind === "live" ? "Live draft" : "Recovered draft"
                  }
                  readOnly
                  value={conflict[kind].text}
                  className="h-64 w-full resize-y rounded border bg-transparent p-2 font-mono text-xs"
                />
                <span className="break-all text-xs text-muted-foreground">
                  Baseline version: {conflict[kind].version}
                </span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(null)}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => settle("live")}>
              Keep live draft
            </Button>
            <Button onClick={() => settle("recovered")}>
              Keep recovered draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ) : null,
  };
}
