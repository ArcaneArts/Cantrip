import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function confirmDialogAllowsOpenChange(
  open: boolean,
  pending: boolean,
): boolean {
  return open || !pending;
}

export function ConfirmDialog({
  cancelLabel = "Cancel",
  confirmDisabled = false,
  confirmLabel,
  confirmPendingLabel,
  confirmVariant = "destructive",
  contentClassName,
  description,
  error,
  onConfirm,
  onOpenChange,
  open,
  pending = false,
  title,
}: {
  cancelLabel?: ReactNode;
  confirmDisabled?: boolean;
  confirmLabel: ReactNode;
  confirmPendingLabel?: ReactNode;
  confirmVariant?: "default" | "destructive";
  contentClassName?: string;
  description: ReactNode;
  error?: ReactNode;
  onConfirm(): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  pending?: boolean;
  title: ReactNode;
}) {
  const requestOpenChange = (nextOpen: boolean) => {
    if (confirmDialogAllowsOpenChange(nextOpen, pending)) {
      onOpenChange(nextOpen);
    }
  };

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent className={contentClassName} showClose={!pending}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => requestOpenChange(false)}
            variant="outline"
          >
            {cancelLabel}
          </Button>
          <Button
            disabled={confirmDisabled}
            onClick={onConfirm}
            pending={pending}
            pendingLabel={confirmPendingLabel}
            variant={confirmVariant}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
