import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CantripOsSourceBindingSummary } from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/error-message";
import {
  createCantripOsBinding,
  prepareCantripOsProvision,
  refreshCantripOs,
  verifyCantripOsBinding,
} from "@/lib/api/cantrip-os";

export function CantripOsWorktreeForm({
  source,
  onCreated,
  onCancel,
  onChanged,
}: {
  source: CantripOsSourceBindingSummary;
  onCreated(): void;
  onCancel(): void;
  onChanged(): void;
}) {
  const [revision, setRevision] = useState("");
  const [branch, setBranch] = useState("");
  const admission = useRef<{
    operationId: string;
    revision: string;
    branch: string | null;
    binding?: CantripOsSourceBindingSummary;
    provision?: Awaited<ReturnType<typeof prepareCantripOsProvision>>;
  }>(null);
  const create = useMutation({
    mutationFn: async () => {
      admission.current ??= {
        operationId: crypto.randomUUID(),
        revision: revision.trim(),
        branch: branch.trim() || null,
      };
      const current = admission.current;
      if (!current.binding) {
        const observed = await refreshCantripOs(source.instanceId);
        await verifyCantripOsBinding(source.projectId, source.id);
        current.binding = await createCantripOsBinding(source.projectId, {
          mode: "linux-worktree",
          sourceBindingId: source.id,
          expectedRuntimeGeneration: observed.instance.runtimeGeneration!,
          operationId: current.operationId,
        });
      }
      current.provision ??= await prepareCantripOsProvision(current.binding, {
        mode: "linux-owned",
        source: {
          kind: "git-worktree",
          revision: current.revision,
          branch: current.branch,
        },
      });
      const result = await current.provision();
      if (result.state !== "ready")
        throw new Error(
          result.error ??
            `Worktree creation is ${result.state}. Continue to observe this same admission.`,
        );
      return result;
    },
    onSuccess: onCreated,
    onSettled: onChanged,
  });
  const captured = Boolean(admission.current);
  return (
    <form
      className="space-y-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Create a worktree in this Linux source. Primary stays separate.
      </p>
      <label className="block space-y-1 text-sm">
        Commit SHA
        <Input
          aria-label="Worktree commit SHA"
          value={revision}
          onChange={(event) => setRevision(event.target.value)}
          disabled={captured || create.isPending}
          placeholder="Exact commit SHA"
          required
          pattern="[a-fA-F0-9]{40}([a-fA-F0-9]{24})?"
        />
      </label>
      <label className="block space-y-1 text-sm">
        New branch (optional)
        <Input
          aria-label="Worktree new branch"
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          disabled={captured || create.isPending}
          placeholder="Leave empty for a detached worktree"
        />
      </label>
      {create.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(create.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {captured ? "Continue worktree admission" : "Create Linux worktree"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </div>
    </form>
  );
}
