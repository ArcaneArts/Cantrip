import { CircleAlert, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const GIT_LONG_PATHS_ENABLE_COMMAND =
  "git config --global core.longpaths true";
export const GIT_LONG_PATHS_VERIFY_COMMAND =
  "git config --global --get core.longpaths";
export const WINDOWS_LONG_PATHS_ENABLE_COMMAND =
  'New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force';

function Command({ children }: { children: string }) {
  return (
    <code className="block overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-muted/60 px-3 py-2 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}

export function WindowsLongPathDialogBody({
  pending,
  retryError,
  onClose,
  onRetry,
}: {
  pending: boolean;
  retryError?: string | null;
  onClose(): void;
  onRetry(): void;
}) {
  return (
    <>
      <DialogHeader>
        <div className="mb-2 grid size-10 place-items-center rounded-full bg-amber-500/10 text-amber-500">
          <CircleAlert className="size-5" />
        </div>
        <DialogTitle>Enable long paths on the Windows worker</DialogTitle>
        <DialogDescription>
          Git for Windows rejected Cantrip&apos;s managed repository path. The
          repository is stored under the worker&apos;s AppData directory, so
          moving the Cantrip installation will not shorten this path.
        </DialogDescription>
      </DialogHeader>

      <ol className="space-y-4 text-sm leading-6">
        <li>
          <p className="mb-2 font-medium">
            1. Open PowerShell on the Windows worker and run:
          </p>
          <Command>{GIT_LONG_PATHS_ENABLE_COMMAND}</Command>
        </li>
        <li>
          <p className="mb-2 font-medium">2. Confirm that Git prints true:</p>
          <Command>{GIT_LONG_PATHS_VERIFY_COMMAND}</Command>
        </li>
        <li>
          <p className="font-medium">
            3. Return to Cantrip and retry repository setup.
          </p>
        </li>
      </ol>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">
          Still seeing the error?
        </p>
        <p className="mb-2">
          Open PowerShell as Administrator, run the Windows setting below, then
          restart Windows:
        </p>
        <Command>{WINDOWS_LONG_PATHS_ENABLE_COMMAND}</Command>
      </div>

      {retryError ? (
        <p className="text-sm text-destructive">{retryError}</p>
      ) : null}

      <DialogFooter>
        <Button disabled={pending} variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button disabled={pending} onClick={onRetry}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RotateCcw className="size-4" />
          )}
          Retry setup
        </Button>
      </DialogFooter>
    </>
  );
}

export function WindowsLongPathDialog({
  open,
  pending,
  retryError,
  onOpenChange,
  onRetry,
}: {
  open: boolean;
  pending: boolean;
  retryError?: string | null;
  onOpenChange(open: boolean): void;
  onRetry(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <WindowsLongPathDialogBody
          pending={pending}
          retryError={retryError}
          onClose={() => onOpenChange(false)}
          onRetry={onRetry}
        />
      </DialogContent>
    </Dialog>
  );
}
