import * as React from "react";

import { cn } from "@/lib/utils";

function EmptyState({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "grid flex-1 place-items-center p-6 text-center",
        className,
      )}
      {...props}
    />
  );
}

function EmptyStateContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state-content"
      className={cn("min-w-0", className)}
      {...props}
    />
  );
}

function EmptyStateIcon({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state-icon"
      className={cn(
        "mx-auto grid size-12 place-items-center rounded-2xl border bg-card",
        className,
      )}
      {...props}
    />
  );
}

type EmptyStateTitleProps = Omit<React.ComponentProps<"h2">, "as"> & {
  as?: "h1" | "h2" | "h3";
};

function EmptyStateTitle({
  as: Title = "h2",
  className,
  ...props
}: EmptyStateTitleProps) {
  return (
    <Title
      data-slot="empty-state-title"
      className={cn("mt-4 font-semibold", className)}
      {...props}
    />
  );
}

function EmptyStateDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-state-description"
      className={cn(
        "mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function EmptyStateActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state-actions"
      className={cn("mt-5 flex justify-center gap-2", className)}
      {...props}
    />
  );
}

export {
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
};
