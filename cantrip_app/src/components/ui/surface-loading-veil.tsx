import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

export function SurfaceLoadingVeil({
  className,
  fade = true,
  label,
  visible,
}: {
  className?: string;
  fade?: boolean;
  label: string;
  visible: boolean;
}) {
  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "pointer-events-none absolute inset-0 z-30 grid place-items-center bg-background",
        fade && "transition-opacity duration-500 ease-out",
        visible ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  );
}
