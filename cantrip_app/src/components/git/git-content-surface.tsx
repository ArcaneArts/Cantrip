import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function GitContentSurface({
  children,
  className,
  dataSlot,
  guttered,
}: {
  children: ReactNode;
  className?: string;
  dataSlot?: string;
  guttered: boolean;
}) {
  return (
    <div
      className={cn("min-h-0 flex-1", className)}
      data-content-gutter={guttered ? "wide" : undefined}
      data-slot={dataSlot}
    >
      {children}
    </div>
  );
}
