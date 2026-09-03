import { ArrowLeft, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";

export const gitMobileInspectorClassName =
  "fixed inset-0 h-[100svh] max-h-none w-screen max-w-none gap-0 overflow-hidden rounded-none border-0 p-0 md:relative md:inset-auto md:h-auto md:max-h-[calc(100svh-2rem)] md:w-full md:rounded-xl md:border";

export function GitMobileInspectorClose({ label }: { label: string }) {
  return (
    <DialogClose asChild>
      <Button
        aria-label={label}
        className="absolute left-2 top-[max(0.5rem,env(safe-area-inset-top))] z-20 size-10 md:left-auto md:right-4 md:top-4 md:size-8"
        size="icon"
        type="button"
        variant="ghost"
      >
        <ArrowLeft className="size-5 md:hidden" />
        <X className="hidden size-4 md:block" />
      </Button>
    </DialogClose>
  );
}
