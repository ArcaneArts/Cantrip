import { X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

export const TASK_DIALOG_POSITIONER_CLASS_NAME = "p-0 md:p-6";
export const TASK_DIALOG_CONTENT_CLASS_NAME =
  "flex h-full min-h-0 max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 text-foreground md:rounded-xl md:border";

export function TaskDialog({
  beforeClose,
  compactHeader = false,
  children,
  headerActions,
  onClose,
  open,
  title,
}: {
  beforeClose?(): Promise<void> | undefined;
  compactHeader?: boolean;
  children: ReactNode;
  headerActions?: ReactNode;
  onClose(): void;
  open: boolean;
  title: string;
}) {
  const closingRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const requestClose = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    setCloseError(null);
    try {
      await beforeClose?.();
      onClose();
    } catch (error) {
      setCloseError(errorMessage(error));
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) void requestClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className={TASK_DIALOG_CONTENT_CLASS_NAME}
        positionerClassName={TASK_DIALOG_POSITIONER_CLASS_NAME}
        showClose={false}
        onOpenAutoFocus={() => {
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef.current?.isConnected) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <header
          className={
            compactHeader
              ? "absolute right-4 top-[max(0.5rem,env(safe-area-inset-top))] z-10 md:right-6 md:top-2"
              : "flex shrink-0 items-center gap-3 border-b px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:px-6 md:py-2"
          }
        >
          <DialogTitle
            className={
              compactHeader ? "sr-only" : "min-w-0 flex-1 truncate text-sm"
            }
          >
            {title}
          </DialogTitle>
          {headerActions}
          <Button
            aria-label="Close Task dialog"
            className="size-8"
            pending={closing}
            size="icon"
            variant="ghost"
            onClick={() => void requestClose()}
          >
            <X className="size-4" />
          </Button>
        </header>
        {closeError ? (
          <div
            className={cn(
              "flex shrink-0 flex-wrap items-center gap-3 bg-destructive/5 px-4 py-3 text-sm text-destructive",
              compactHeader ? "order-last border-t" : "border-b",
            )}
            role="alert"
          >
            <span className="min-w-0 flex-1">
              Could not save the Task before closing: {closeError}
            </span>
            <Button size="sm" variant="outline" onClick={onClose}>
              Close without saving
            </Button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)] md:pb-0">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
