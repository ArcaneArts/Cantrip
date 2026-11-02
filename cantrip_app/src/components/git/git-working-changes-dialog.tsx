import { useRef, type ComponentProps } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

import { GitChangesPanel } from "./git-changes-panel";

type WorkingChangesDialogProps = Omit<
  ComponentProps<typeof GitChangesPanel>,
  "status"
> & {
  status: ComponentProps<typeof GitChangesPanel>["status"] | null | undefined;
};

export function GitWorkingChangesDialog({
  onClose,
  onOpenFile,
  status,
  ...props
}: WorkingChangesDialogProps) {
  const returnFocus = useRef<HTMLElement | null>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(88svh,900px)] max-w-6xl flex-col gap-0 overflow-hidden p-0"
        showClose={!status}
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
        }}
      >
        <DialogTitle className="sr-only">
          Working changes · {props.worktreeName}
        </DialogTitle>
        {status ? (
          <GitChangesPanel
            {...props}
            status={status}
            onClose={onClose}
            onOpenFile={
              onOpenFile
                ? (path) => {
                    onClose();
                    onOpenFile(path);
                  }
                : undefined
            }
          />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
            Git status is unavailable for this worktree.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
