import type { ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { TooltipButton } from "@/components/ui/tooltip";

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
  onCloseAutoFocus,
  open,
  pending = false,
  title,
  buttonTooltips = false,
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
  onCloseAutoFocus?(event: Event): void;
  open: boolean;
  pending?: boolean;
  title: ReactNode;
  buttonTooltips?: boolean;
}) {
  const requestOpenChange = (nextOpen: boolean) => {
    if (confirmDialogAllowsOpenChange(nextOpen, pending)) {
      onOpenChange(nextOpen);
    }
  };

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        className={contentClassName}
        closeTooltip={buttonTooltips ? "Close confirmation" : undefined}
        showClose={!pending}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <DialogFooter>
          <TooltipButton
            tooltip={buttonTooltips ? cancelLabel : undefined}
            disabled={pending}
            onClick={() => requestOpenChange(false)}
            variant="outline"
          >
            {cancelLabel}
          </TooltipButton>
          <TooltipButton
            tooltip={buttonTooltips ? confirmLabel : undefined}
            disabled={confirmDisabled}
            onClick={onConfirm}
            pending={pending}
            pendingLabel={confirmPendingLabel}
            variant={confirmVariant}
          >
            {confirmLabel}
          </TooltipButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
