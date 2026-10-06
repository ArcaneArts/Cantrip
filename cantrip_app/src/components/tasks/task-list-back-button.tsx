import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function TaskListBackButton({
  className,
  onBack,
}: {
  className?: string;
  onBack(): void;
}) {
  return (
    <Button
      aria-label="Back to Task list"
      className={cn("-ml-2 size-8 shrink-0", className)}
      size="icon"
      title="Back to Task list"
      variant="ghost"
      onClick={onBack}
    >
      <ArrowLeft className="size-4" />
    </Button>
  );
}
