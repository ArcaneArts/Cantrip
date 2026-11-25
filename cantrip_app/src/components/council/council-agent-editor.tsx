import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
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
  const { editor, save, showEditor } = controller;
  const agent = editor === "new" ? null : editor;
  const [title, setTitle] = useState(agent?.title ?? "");
  const [role, setRole] = useState<string | null>(agent ? null : "");
  const [primary, setPrimary] = useState(agent?.primary ?? false);
  const [loadError, setLoadError] = useState<unknown>(null);
  useEffect(() => {
    if (!agent) return;
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
        if (!open && !save.isPending) showEditor(null);
      }}
    >
      <DialogContent>
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
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => showEditor(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || !role?.trim() || save.isPending}
            >
              {agent ? "Save" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
