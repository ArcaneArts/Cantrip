import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

export function ProjectOverviewDialog({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose(): void;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-modal="true"
        aria-describedby={undefined}
        className="flex h-full min-h-0 max-w-none flex-col gap-0 overflow-hidden p-0"
        showClose={false}
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
          <DialogTitle className="truncate text-sm">Overview</DialogTitle>
          <DialogClose asChild>
            <Button
              aria-label="Close Overview"
              className="size-8"
              size="icon"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          </DialogClose>
        </header>
        {children}
      </DialogContent>
    </Dialog>
  );
}
