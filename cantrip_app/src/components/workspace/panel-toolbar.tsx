import type { ComponentProps } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Surface-owned controls stay visible independently of workspace focus. */
export function PanelToolbar({
  as: Component = "div",
  children,
  className,
  ...props
}: ComponentProps<"div"> & { as?: "div" | "header" }) {
  return (
    <Component
      role="toolbar"
      data-slot="panel-toolbar"
      className={cn(
        "flex min-h-10 min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-0.5 text-xs [&_[data-slot=button]]:h-8 [&_[data-slot=button]]:shrink-0",
        className,
      )}
      {...props}
    >
      <TooltipProvider>{children}</TooltipProvider>
    </Component>
  );
}
