import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

import type { GitHistoryDrawer } from "./git-history-drawer";

const drawerLabels: Record<GitHistoryDrawer["kind"], string> = {
  branches: "Branches",
  changes: "Working changes",
  commit: "Commit details",
  compare: "Compare revisions",
  operations: "Git operations",
  repository: "Repository",
  stashes: "Stashes",
};

export function GitHistoryMobileDrawer({
  children,
  drawer,
  onClose,
  open,
}: {
  children: ReactNode;
  drawer: GitHistoryDrawer | null;
  onClose(): void;
  open: boolean;
}) {
  const label = drawer ? drawerLabels[drawer.kind] : "Git details";

  return (
    <DialogPrimitive.Root
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      open={open}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-black/35 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="mobile-safe-bottom mobile-safe-top fixed inset-0 z-[90] min-h-0 overflow-hidden bg-background shadow-2xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right motion-reduce:animate-none [&>div]:h-full [&>div]:min-h-0 [&>div]:w-full [&>div>aside]:!relative [&>div>aside]:!inset-auto [&>div>aside]:!z-auto [&>div>aside]:!h-full [&>div>aside]:!w-full [&>div>aside]:!max-w-none [&>div>aside]:!border-0 [&>div>aside]:!shadow-none"
          data-kind={drawer?.kind}
          data-slot="git-history-mobile-drawer"
        >
          <DialogPrimitive.Title className="sr-only">
            {label}
          </DialogPrimitive.Title>
          <div>{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
