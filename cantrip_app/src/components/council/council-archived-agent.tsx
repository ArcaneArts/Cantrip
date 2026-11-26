import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { TooltipButton } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import type { CouncilAgent } from "@/lib/api/council";
import { errorMessage } from "@/lib/error-message";
import type { CouncilWorkspaceController } from "./use-council-workspace";

export function CouncilArchivedAgent({
  agent,
  compact,
  controller,
}: {
  agent: CouncilAgent;
  compact: boolean;
  controller: CouncilWorkspaceController;
}) {
  const { changeState, removeArchived, select } = controller;
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        {compact ? (
          <TooltipButton
            tooltip="Back to Council agents"
            aria-label="Back to Council agents"
            onClick={() => select(null)}
            size="icon"
            variant="ghost"
          >
            <ArrowLeft className="size-4" />
          </TooltipButton>
        ) : null}
        <h1 className="min-w-0 truncate font-medium">{agent.title}</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Restore this agent to open its chat and resume its routines.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <TooltipButton
          tooltip="Restore agent"
          onClick={() => changeState.mutate({ agent, archived: false })}
          pending={changeState.isPending}
        >
          Restore agent
        </TooltipButton>
        <TooltipButton
          tooltip="Delete permanently"
          disabled={changeState.isPending || removeArchived.isPending}
          onClick={() => {
            removeArchived.reset();
            setConfirmOpen(true);
          }}
          variant="outline"
        >
          Delete permanently
        </TooltipButton>
      </div>
      {changeState.error ? (
        <InlineAlert>{errorMessage(changeState.error)}</InlineAlert>
      ) : null}
      <ConfirmDialog
        buttonTooltips
        confirmLabel="Delete permanently"
        description={`${agent.title}, its conversation, and its workspace files will be deleted.`}
        error={removeArchived.error && errorMessage(removeArchived.error)}
        onConfirm={() => removeArchived.mutate(agent.id)}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        pending={removeArchived.isPending}
        title="Permanently delete this Council agent?"
      />
    </section>
  );
}
