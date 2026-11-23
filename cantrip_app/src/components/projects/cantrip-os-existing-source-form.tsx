import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  CantripOsWorkspaceSummary,
  ProjectSummary,
} from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/error-message";
import {
  createCantripOsBinding,
  prepareCantripOsProvisionRequest,
  submitCantripOsProvision,
  refreshCantripOs,
} from "@/lib/api/cantrip-os";
import {
  clearExistingSourceDraft,
  readExistingSourceDraft,
  saveExistingSourceDraft,
  type ExistingSourceDraft,
} from "@/lib/cantrip-os-existing-source-draft";

export function CantripOsExistingSourceForm({
  project,
  workspace,
  onProvisioned,
  onCancel,
}: {
  project: ProjectSummary;
  workspace: CantripOsWorkspaceSummary;
  onProvisioned(): void;
  onCancel(): void;
}) {
  const [initial] = useState(() => {
    try {
      return {
        draft: readExistingSourceDraft(project.id, workspace.id),
        error: null,
      };
    } catch (error) {
      return { draft: null, error: errorMessage(error) };
    }
  });
  const pending = useRef<ExistingSourceDraft | null>(initial.draft);
  const active = useRef(false);
  const [draft, setDraft] = useState(initial.draft);
  const [draftError, setDraftError] = useState(initial.error);
  const [relativePath, setRelativePath] = useState(
    initial.draft?.request.relativePath ?? "",
  );
  const [added, setAdded] = useState(false);
  function retain(value: ExistingSourceDraft) {
    saveExistingSourceDraft(value);
    pending.current = value;
    setDraft(value);
    return value;
  }
  const registration = useMutation({
    retry: false,
    mutationFn: async () => {
      if (active.current)
        throw new Error("This source registration is already in progress.");
      active.current = true;
      try {
        if (draftError) throw new Error(draftError);
        let current =
          pending.current ??
          retain({
            version: 1,
            projectId: project.id,
            request: {
              mode: "linux-existing",
              operationId: crypto.randomUUID(),
              workspaceId: workspace.id,
              relativePath,
              sourceKind: project.capabilities.git ? "git" : "folder",
            },
          });
        if (!current.binding) {
          const binding = await createCantripOsBinding(
            project.id,
            current.request,
          );
          if (
            binding.projectId !== project.id ||
            binding.workspaceId !== workspace.id ||
            binding.instanceId !== workspace.instanceId ||
            binding.workerId !== workspace.workerId ||
            binding.mode !== "linux-owned"
          )
            throw new Error(
              "The existing source reservation was routed to a different Linux workspace.",
            );
          current = retain({ ...current, binding });
        }
        const binding = current.binding!;
        if (!current.provision) {
          await refreshCantripOs(binding.instanceId);
          current = retain({
            ...current,
            provision: await prepareCantripOsProvisionRequest(binding, {
              mode: "linux-owned",
              source: {
                kind: "existing",
                sourceKind: current.request.sourceKind,
              },
            }),
          });
        }
        const result = await submitCantripOsProvision(
          binding,
          current.provision!,
        );
        if (result.state !== "ready")
          throw new Error(
            result.error ??
              `Existing source verification is ${result.state}. Resume this saved registration to observe the same operation.`,
          );
        if (
          result.receipt.kind !== "source" ||
          result.receipt.source.bindingId !== binding.id ||
          result.receipt.source.workspaceId !== workspace.id ||
          result.receipt.source.guestPath !== binding.guestPath
        )
          throw new Error(
            "The existing source receipt differs from its selected Linux path.",
          );
        clearExistingSourceDraft(project.id, workspace.id);
        pending.current = null;
        setDraft(null);
        setAdded(true);
      } finally {
        active.current = false;
      }
    },
    onSettled: onProvisioned,
  });
  return (
    <form
      className="space-y-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        registration.mutate();
      }}
    >
      <h3 className="font-medium">
        Register existing Linux{" "}
        {project.capabilities.git ? "repository" : "folder"} ·{" "}
        {workspace.guestWorkspaceId}
      </h3>
      <p className="text-sm text-muted-foreground">
        Choose restored or existing files in this workspace. Cantrip inspects
        the actual directory and registers fresh source and binding identities.
        Files and Git state are preserved. Existing chats keep their captured
        source.
      </p>
      <label className="block space-y-1 text-sm">
        Path relative to Linux home
        <Input
          value={relativePath}
          disabled={registration.isPending || Boolean(draft) || added}
          required
          onChange={(event) => setRelativePath(event.target.value)}
          placeholder="checkouts/restored-source-id"
        />
      </label>
      <code className="block break-all text-xs">{workspace.homeGuestPath}</code>
      {draft ? (
        <p role="status" className="text-xs text-muted-foreground">
          This tab retains the source creation ID and encrypted verification
          admission. Resume after a lost response or reload to observe those
          same identities.
        </p>
      ) : null}
      {draftError || registration.error ? (
        <p role="alert" className="text-sm text-destructive">
          {draftError ?? errorMessage(registration.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={registration.isPending || added || Boolean(draftError)}
        >
          {added
            ? "Existing source registered"
            : registration.isPending
              ? "Verifying existing files…"
              : draft
                ? "Resume registration"
                : "Register existing source"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={registration.isPending}
          onClick={onCancel}
        >
          Back to source modes
        </Button>
        {draft || draftError ? (
          <Button
            type="button"
            variant="ghost"
            disabled={registration.isPending}
            onClick={() => {
              clearExistingSourceDraft(project.id, workspace.id);
              pending.current = null;
              setDraft(null);
              setDraftError(null);
              registration.reset();
            }}
          >
            Discard local draft
          </Button>
        ) : null}
      </div>
      {draft || draftError ? (
        <p className="text-xs text-muted-foreground">
          Discarding a local draft does not remove registered files, a reserved
          binding, or its Server history.
        </p>
      ) : null}
    </form>
  );
}
