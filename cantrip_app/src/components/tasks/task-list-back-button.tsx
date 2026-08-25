import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";

export function TaskListBackButton({ onBack }: { onBack(): void }) {
  return (
    <Button
      aria-label="Back to Task list"
      className="-ml-2 size-8 shrink-0"
      size="icon"
      title="Back to Task list"
      variant="ghost"
      onClick={onBack}
    >
      <ArrowLeft className="size-4" />
    </Button>
  );
}
