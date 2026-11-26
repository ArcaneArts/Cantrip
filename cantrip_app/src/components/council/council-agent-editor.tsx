import { useEffect, useState } from "react";

import { TooltipButton } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input } from "@/components/ui/input";
import { openCouncilRole } from "@/lib/api/council";
import { errorMessage } from "@/lib/error-message";
import type { CouncilWorkspaceController } from "./use-council-workspace";

export function CouncilAgentEditor({
  controller,
}: {
  controller: CouncilWorkspaceController;
}) {
  const { changeState, editor, save, showEditor } = controller;
  const agent = editor === "new" ? null : editor;
  const [title, setTitle] = useState(agent?.title ?? "");
  const [role, setRole] = useState<string | null>(agent ? agent.role : "");
  const [primary, setPrimary] = useState(agent?.primary ?? false);
  const [loadError, setLoadError] = useState<unknown>(null);
  useEffect(() => {
    if (!agent || agent.role !== null) return;
    let active = true;
    void openCouncilRole(agent).then(
      (value) => {
        if (active) setRole(value);
      },
      (error: unknown) => {
        if (active) setLoadError(error);
      },
    );
    return () => {
      active = false;
    };
  }, [agent]);
  return (
    <Dialog
      open={Boolean(editor)}
      onOpenChange={(open) => {
        if (!open && !save.isPending && !changeState.isPending)
          showEditor(null);
      }}
    >
      <DialogContent closeTooltip="Close agent editor">
        <DialogHeader>
          <DialogTitle>
            {agent ? "Edit Council agent" : "New Council agent"}
          </DialogTitle>
          <DialogDescription>
            Give the agent a name and describe its role.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (role?.trim() && title.trim())
              save.mutate({ title: title.trim(), role, primary });
          }}
        >
          <label className="grid gap-2 text-sm font-medium">
            Name
            <Input
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Role
            <textarea
              className="min-h-32 resize-y rounded-md border bg-background p-2 text-sm font-normal"
              disabled={role === null}
              onChange={(event) => setRole(event.currentTarget.value)}
              placeholder={
                role === null
                  ? "Opening role…"
                  : "Describe the work this agent should handle"
              }
              required
              value={role ?? ""}
            />
          </label>
          {agent ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={primary}
                onChange={(event) => setPrimary(event.currentTarget.checked)}
                type="checkbox"
              />
              Primary agent
            </label>
          ) : null}
          {loadError || save.error ? (
            <InlineAlert>{errorMessage(loadError ?? save.error)}</InlineAlert>
          ) : null}
          <DialogFooter>
            <TooltipButton
              tooltip="Cancel"
              type="button"
              variant="ghost"
              disabled={save.isPending || changeState.isPending}
              onClick={() => showEditor(null)}
            >
              Cancel
            </TooltipButton>
            <TooltipButton
              tooltip={agent ? "Save" : "Create agent"}
              type="submit"
              disabled={
                !title.trim() ||
                !role?.trim() ||
                save.isPending ||
                changeState.isPending
              }
            >
              {agent ? "Save" : "Create agent"}
            </TooltipButton>
          </DialogFooter>
        </form>
        {agent ? (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <TooltipButton
              tooltip={agent.hidden ? "Show in roster" : "Hide from roster"}
              size="sm"
              variant="ghost"
              disabled={save.isPending || changeState.isPending}
              onClick={() =>
                changeState.mutate({ agent, hidden: !agent.hidden })
              }
            >
              {agent.hidden ? "Show in roster" : "Hide from roster"}
            </TooltipButton>
            <TooltipButton
              tooltip={agent.paused ? "Resume agent" : "Pause agent"}
              size="sm"
              variant="ghost"
              disabled={save.isPending || changeState.isPending}
              onClick={() =>
                changeState.mutate({ agent, paused: !agent.paused })
              }
            >
              {agent.paused ? "Resume agent" : "Pause agent"}
            </TooltipButton>
            <TooltipButton
              tooltip="Archive agent"
              size="sm"
              variant="ghost"
              disabled={save.isPending || changeState.isPending}
              onClick={() => changeState.mutate({ agent, archived: true })}
            >
              Archive agent
            </TooltipButton>
            {changeState.error ? (
              <InlineAlert>{errorMessage(changeState.error)}</InlineAlert>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
