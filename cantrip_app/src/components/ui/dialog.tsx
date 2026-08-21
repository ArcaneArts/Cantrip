import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DIALOG_POSITIONER_CLASS_NAME =
  "pointer-events-none fixed inset-0 z-50 grid place-items-center p-4";
export const DIALOG_OVERLAY_CLASS_NAME =
  "fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0";
export const DIALOG_CONTENT_CLASS_NAME =
  "cantrip-dialog-content pointer-events-auto relative grid max-h-[calc(100vh-2rem)] w-full max-w-lg gap-5 overflow-y-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-xl";

export function DialogContent({
  children,
  className,
  showClose = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showClose?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      {/*
        Keep close teardown synchronous. Radix Presence retains an overlay
        while its exit animation runs; WKWebView can strand that transparent,
        pointer-active layer after a window focus or compositor transition.
      */}
      <DialogPrimitive.Overlay className={DIALOG_OVERLAY_CLASS_NAME} />
      <div className={DIALOG_POSITIONER_CLASS_NAME}>
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn(DIALOG_CONTENT_CLASS_NAME, className)}
          {...props}
        >
          {children}
          {showClose ? (
            <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("grid gap-1.5 pr-8", className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-lg font-semibold", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm leading-6 text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}
