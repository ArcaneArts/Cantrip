import { useState } from "react";
import {
  cantripOsResetPathsSchema,
  type CantripOsInstanceSummary,
  type CantripOsWorkspaceSummary,
} from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";

export type CantripOsResetSelection = {
  instanceId: string;
  attachmentGeneration: string;
  runtimeGeneration: string;
  workspace: CantripOsWorkspaceSummary;
  paths: string[];
};
export function CantripOsResetForm({
  instance,
  workspace,
  disabled,
  onReset,
}: {
  instance: CantripOsInstanceSummary;
  workspace?: CantripOsWorkspaceSummary;
  disabled: boolean;
  onReset(selection: CantripOsResetSelection): void;
}) {
  const [paths, setPaths] = useState("");
  const [whole, setWhole] = useState(false);
  const [selection, setSelection] = useState<CantripOsResetSelection | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const changed = Boolean(
    selection &&
    (selection.instanceId !== instance.id ||
      selection.attachmentGeneration !== instance.attachmentGeneration ||
      selection.runtimeGeneration !== instance.runtimeGeneration ||
      selection.workspace.id !== workspace?.id ||
      selection.workspace.uid !== workspace.uid ||
      selection.workspace.gid !== workspace.gid ||
      selection.workspace.homeGuestPath !== workspace.homeGuestPath),
  );
  return (
    <form
      className="space-y-2 border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        try {
          if (!workspace || !instance.runtimeGeneration)
            throw new Error("Select a workspace with an observed OS runtime.");
          setSelection({
            instanceId: instance.id,
            attachmentGeneration: instance.attachmentGeneration,
            runtimeGeneration: instance.runtimeGeneration,
            workspace,
            paths: cantripOsResetPathsSchema.parse(
              whole
                ? ["."]
                : paths.split(/\r?\n/).filter((value) => value !== ""),
            ),
          });
        } catch (failure) {
          setError(errorMessage(failure));
        }
      }}
    >
      <h4 className="text-sm font-medium">Reset workspace state</h4>
      <p className="text-sm">
        {instance.name} ·{" "}
        {workspace?.guestWorkspaceId ?? "Choose a workspace above"}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={whole}
          disabled={disabled}
          onChange={(event) => {
            setWhole(event.target.checked);
            setSelection(null);
          }}
        />
        Reset entire workspace home
      </label>
      {!whole ? (
        <label className="block space-y-1 text-sm">
          Reset home-relative paths, one per line
          <textarea
            className="min-h-16 w-full rounded-md border bg-transparent p-2"
            value={paths}
            disabled={disabled}
            placeholder=".config/chromium"
            onChange={(event) => {
              setPaths(event.target.value);
              setSelection(null);
            }}
          />
        </label>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Reset interrupts all managed workspace services on this OS. Shared
        packages and system configuration stay in place. The personal desktop is
        independent.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="ghost" disabled={disabled || !workspace}>
        Review reset
      </Button>
      {selection ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm">
            Reset {selection.workspace.guestWorkspaceId} · UID{" "}
            {selection.workspace.uid} · {instance.name}
          </p>
          <code className="block break-all text-xs">
            {selection.workspace.homeGuestPath}
          </code>
          <pre className="whitespace-pre-wrap break-all text-xs">
            {selection.paths.join("\n")}
          </pre>
          <p className="text-xs text-muted-foreground">
            {selection.paths[0] === "."
              ? "This replaces the entire home, including checkouts and browser profiles, with fresh workspace defaults. "
              : "Selected entries are removed or returned to fresh workspace defaults; unselected files are preserved. "}
            The original home is retained for undo. Undo retains the replaced
            home and later writes; it does not merge files or restart old
            processes. Removed checkouts require explicit source verification or
            registration.
          </p>
          {changed ? (
            <p role="alert" className="text-sm text-destructive">
              The workspace or OS runtime changed. Review the intended selection
              again.
            </p>
          ) : null}
          <Button
            type="button"
            disabled={disabled || changed}
            onClick={() => {
              const confirmed = selection;
              setSelection(null);
              onReset(confirmed);
            }}
          >
            Confirm reset
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => setSelection(null)}
          >
            Cancel reset
          </Button>
        </div>
      ) : null}
    </form>
  );
}
