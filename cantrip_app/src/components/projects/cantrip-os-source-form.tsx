import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  CantripOsWorkspaceSummary,
  ProjectSummary,
  ProjectWorktreeSummary,
  CantripOsProvisionIntent,
  CantripOsSourceBindingSummary,
} from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  createCantripOsBinding,
  prepareCantripOsProvision,
} from "@/lib/api/cantrip-os";
import { errorMessage } from "@/lib/error-message";

export function CantripOsSourceForm({
  project,
  workspace,
  worktrees,
  onProvisioned,
}: {
  project: ProjectSummary;
  workspace: CantripOsWorkspaceSummary;
  worktrees: ProjectWorktreeSummary[];
  onProvisioned(): void;
}) {
  const [mode, setMode] = useState<"linux-owned" | "linked">("linux-owned");
  const [worktreeId, setWorktreeId] = useState(
    worktrees.find((w) => w.workerId === workspace.workerId && w.isPrimary)
      ?.id ?? "",
  );
  const [url, setUrl] = useState("");
  const [revision, setRevision] = useState("");
  const [overlays, setOverlays] = useState("node_modules");
  const prepared = useRef<Awaited<
    ReturnType<typeof prepareCantripOsProvision>
  > | null>(null);
  const selection = useRef<{
    binding: CantripOsSourceBindingSummary;
    intent: CantripOsProvisionIntent;
  } | null>(null);
  const [admitted, setAdmitted] = useState(false);
  const [added, setAdded] = useState(false);
  const provision = useMutation({
    mutationFn: async () => {
      if (!selection.current) {
        const binding = await createCantripOsBinding(
          project.id,
          mode === "linked"
            ? {
                mode,
                workspaceId: workspace.id,
                worktreeId,
                dependencyOverlays: overlays
                  .split("\n")
                  .map((p) => p.trim())
                  .filter(Boolean)
                  .map((path) => ({ path })),
              }
            : {
                mode,
                workspaceId: workspace.id,
                sourceKind: project.capabilities.git ? "git" : "folder",
              },
        );
        const intent: CantripOsProvisionIntent =
          mode === "linked"
            ? {
                mode,
                workerPath: binding.linkedWorkerPath!,
                dependencyOverlays: binding.dependencyOverlays,
              }
            : {
                mode,
                source: project.capabilities.git
                  ? { kind: "git", repositoryUrl: url, revision }
                  : { kind: "folder" },
              };
        selection.current = { binding, intent };
        setAdmitted(true);
        onProvisioned();
      }
      // Retain the binding and frozen intent even if encryption preparation fails.
      // Once prepared, subsequent submissions observe the same operation identity.
      prepared.current ??= await prepareCantripOsProvision(
        selection.current.binding,
        selection.current.intent,
      );
      const result = await prepared.current();
      if (result.state !== "ready")
        throw new Error(
          result.error ??
            `Source provisioning is ${result.state}. Use Observe outcome to recover it.`,
        );
      return result;
    },
    onSuccess: (result) => {
      if (result.state === "ready") setAdded(true);
    },
    onSettled: onProvisioned,
  });
  return (
    <form
      className="space-y-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        provision.mutate();
      }}
    >
      <h3 className="font-medium">
        Add project source to {workspace.guestWorkspaceId}
      </h3>
      <fieldset
        disabled={admitted || provision.isPending}
        className="space-y-3"
      >
        <label className="block space-y-1 text-sm">
          Source mode
          <NativeSelect
            className="w-full"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="linux-owned">
              Linux-owned {project.capabilities.git ? "checkout" : "folder"}
            </option>
            <option value="linked">Link a worktree from this worker</option>
          </NativeSelect>
        </label>
        {mode === "linux-owned" ? (
          project.capabilities.git ? (
            <>
              <label className="block space-y-1 text-sm">
                Repository URL
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  required
                />
              </label>
              <label className="block space-y-1 text-sm">
                Exact commit
                <Input
                  value={revision}
                  onChange={(e) => setRevision(e.target.value.trim())}
                  pattern="[a-fA-F0-9]{40}([a-fA-F0-9]{24})?"
                  required
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Git access must be available in Linux. This creates a separate
                checkout at that exact commit.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Creates an empty persistent Linux folder for this non-Git project.
            </p>
          )
        ) : (
          <>
            <label className="block space-y-1 text-sm">
              Worktree
              <NativeSelect
                className="w-full"
                value={worktreeId}
                onChange={(e) => setWorktreeId(e.target.value)}
                required
              >
                <option value="">Choose a worktree</option>
                {worktrees
                  .filter((w) => w.workerId === workspace.workerId)
                  .map((w) => (
                    <option value={w.id} key={w.id}>
                      {w.name}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            <label className="block space-y-1 text-sm">
              Separate Linux dependency directories
              <textarea
                className="min-h-20 w-full rounded-md border bg-background px-3 py-2"
                value={overlays}
                onChange={(e) => setOverlays(e.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              One relative directory per line. These directories use Linux
              volumes; other files stay shared, including ignored files.
            </p>
            <p className="text-sm text-muted-foreground">
              Adding this mount recreates CantripOS and interrupts its running
              sessions. Persistent homes, sources, and dependency volumes are
              retained.
            </p>
          </>
        )}
      </fieldset>
      {provision.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(provision.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={provision.isPending || added}>
          {provision.isPending
            ? "Provisioning…"
            : added
              ? "Source added"
              : admitted
                ? "Observe admitted operation"
                : mode === "linked"
                  ? "Link worktree and restart OS"
                  : "Provision Linux source"}
        </Button>
        {admitted ? (
          <Button
            type="button"
            variant="ghost"
            disabled={provision.isPending}
            onClick={() => {
              prepared.current = null;
              selection.current = null;
              setAdmitted(false);
              setAdded(false);
              provision.reset();
            }}
          >
            Add another source
          </Button>
        ) : null}
      </div>
    </form>
  );
}
