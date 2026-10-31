import type { ComponentProps } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Surface-owned controls stay visible independently of workspace focus. */
export function PanelToolbar({
  as: Component = "div",
  children,
  className,
  scrollDivider = false,
  ...props
}: ComponentProps<"div"> & { as?: "div" | "header"; scrollDivider?: boolean }) {
  return (
    <Component
      role="toolbar"
      data-slot="panel-toolbar"
      className={cn(
        "flex min-h-10 min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-0.5 text-xs [&_[data-slot=button]]:h-8 [&_[data-slot=button]]:shrink-0",
        scrollDivider && "relative border-transparent",
        className,
      )}
      {...props}
    >
      <TooltipProvider>{children}</TooltipProvider>
      {scrollDivider ? (
        <span
          aria-hidden="true"
          data-slot="panel-scroll-divider"
          className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-border/60 transition-opacity duration-200 motion-reduce:transition-none"
          style={{ opacity: "var(--panel-scroll-divider-opacity, 0)" }}
        />
      ) : null}
    </Component>
  );
}
