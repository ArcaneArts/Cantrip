import { Loader2 } from "lucide-react";
import * as React from "react";

import {
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

type ContentLoadingProps = Omit<React.ComponentProps<"div">, "children"> & {
  label?: React.ReactNode;
};

function ContentLoading({
  className,
  label = "Loading…",
  ...props
}: ContentLoadingProps) {
  return (
    <div
      role="status"
      data-slot="content-loading"
      className={cn(
        "grid min-h-48 place-items-center p-6 text-sm text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span className="flex items-center gap-2">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        {label}
      </span>
    </div>
  );
}

type ContentEmptyProps = Omit<
  React.ComponentProps<typeof EmptyState>,
  "children" | "title"
> & {
  actions?: React.ReactNode;
  description: React.ReactNode;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  titleAs?: "h1" | "h2" | "h3";
};

function ContentEmpty({
  actions,
  description,
  icon,
  title,
  titleAs,
  ...props
}: ContentEmptyProps) {
  return (
    <EmptyState {...props}>
      <EmptyStateContent>
        {icon ? <EmptyStateIcon>{icon}</EmptyStateIcon> : null}
        {title ? <EmptyStateTitle as={titleAs}>{title}</EmptyStateTitle> : null}
        <EmptyStateDescription className={cn(!title && "mt-0")}>
          {description}
        </EmptyStateDescription>
        {actions ? <EmptyStateActions>{actions}</EmptyStateActions> : null}
      </EmptyStateContent>
    </EmptyState>
  );
}

export { ContentEmpty, ContentLoading };
