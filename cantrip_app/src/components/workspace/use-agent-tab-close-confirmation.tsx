import { useState } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ProjectSurface } from "@/lib/project-surface";

export function useAgentTabCloseConfirmation(
  onRemove: (surface: ProjectSurface, stopRunning?: true) => void,
) {
  const [target, setTarget] = useState<ProjectSurface | null>(null);
  return {
    requestClose(surface: ProjectSurface) {
      if (
        surface.kind === "chat" &&
        (surface.entity.status === "running" ||
          surface.entity.status === "waiting-for-approval")
      ) {
        setTarget(surface);
      } else {
        onRemove(surface);
      }
    },
    confirmation: (
      <ConfirmDialog
        confirmLabel="Stop and remove"
        description="Are you sure you want to stop and remove this agent tab?"
        onConfirm={() => {
          if (target) onRemove(target, true);
          setTarget(null);
        }}
        onOpenChange={(open) => !open && setTarget(null)}
        open={target !== null}
        title="Stop and remove agent tab?"
      />
    ),
  };
}
