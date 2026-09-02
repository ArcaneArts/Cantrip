import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { WorkspaceAssignment } from "@/components/workspaces/workspace-assignment";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createManagedFolderProject } from "@/lib/project-encryption";
import { listDesktopWorkers } from "@/lib/desktop-worker";
import { pickLocalFolder } from "@/lib/desktop-folder-picker";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

export type FolderSourceMode = "create" | "existing";

export function folderNameFromPath(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) ?? ""
  );
}

export function FolderProjectDialog({
  activeWorkspaceId,
  defaultWorkerId,
  initialMode = "create",
  onCreatedProject,
  onOpenChange,
  open,
  workers,
  workspaces,
}: {
  activeWorkspaceId: string | null;
  defaultWorkerId: string | null;
  initialMode?: FolderSourceMode;
  onCreatedProject(project: ProjectSummary): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  workers: WorkerSummary[];
  workspaces: ProjectWorkspaceSummary[];
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<FolderSourceMode>(initialMode);
  const [name, setName] = useState("");
  const [existingPath, setExistingPath] = useState("");
  const [workerId, setWorkerId] = useState(defaultWorkerId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktopWorkers = useQuery({
    enabled: open,
    queryFn: listDesktopWorkers,
    queryKey: ["desktop-workers"],
  });
  const eligibleWorkers = useMemo(
    () =>
      workers.filter(({ managedFolders }) =>
        mode === "existing"
          ? managedFolders.attachExisting
          : managedFolders.create,
      ),
    [mode, workers],
  );
  const localWorkerIds = useMemo(
    () => new Set(desktopWorkers.data?.map((worker) => worker.workerId) ?? []),
    [desktopWorkers.data],
  );
  const canBrowse = localWorkerIds.has(workerId);
  const workerEligible = eligibleWorkers.some(
    (worker) => worker.workerId === workerId,
  );

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
  }, [initialMode, open]);

  useEffect(() => {
    if (eligibleWorkers.some((worker) => worker.workerId === workerId)) return;
    setWorkerId(
      eligibleWorkers.find((worker) => worker.workerId === defaultWorkerId)
        ?.workerId ??
        eligibleWorkers.find(({ online }) => online)?.workerId ??
        eligibleWorkers[0]?.workerId ??
        "",
    );
  }, [defaultWorkerId, eligibleWorkers, workerId]);

  const reset = () => {
    setMode(initialMode);
    setName("");
    setExistingPath("");
    setError(null);
    setSubmitting(false);
    setPicking(false);
  };

  const rememberProject = (project: ProjectSummary, workspaceId: string) => {
    queryClient.setQueryData<ProjectSummary[]>(["projects"], (current = []) =>
      [...current.filter((item) => item.id !== project.id), project].sort(
        (left, right) => left.position - right.position,
      ),
    );
    queryClient.setQueryData<ProjectWorkspaceSummary[]>(
      ["project-workspaces"],
      (current) =>
        current?.map((workspace) =>
          workspace.id === workspaceId &&
          !workspace.projectIds.includes(project.id)
            ? {
                ...workspace,
                projectIds: [...workspace.projectIds, project.id],
              }
            : workspace,
        ),
    );
    void queryClient.invalidateQueries({ queryKey: ["project-workspaces"] });
  };

  const chooseFolder = async () => {
    setPicking(true);
    setError(null);
    try {
      const selected = await pickLocalFolder();
      if (!selected) return;
      setExistingPath(selected);
      setName((current) => current || folderNameFromPath(selected));
    } catch (pickError) {
      setError(errorMessage(pickError));
    } finally {
      setPicking(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const projectName = name.trim();
    const path = existingPath.trim();
    if (
      !projectName ||
      !workerEligible ||
      !activeWorkspaceId ||
      (mode === "existing" && !path) ||
      submitting
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const project = await createManagedFolderProject({
        name: projectName,
        workerId,
        ...(mode === "existing" ? { existingPath: path } : {}),
        workspaceId: activeWorkspaceId,
      });
      rememberProject(project, activeWorkspaceId);
      onCreatedProject(project);
      onOpenChange(false);
      reset();
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogContent className="max-w-2xl">
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add folder project</DialogTitle>
            <DialogDescription>
              Create an empty worker-owned folder or attach a directory that
              already exists on a worker.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 rounded-lg bg-muted p-1">
            {(
              [
                ["create", "Create new"],
                ["existing", "Use existing"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={mode === value}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground",
                  mode === value && "bg-background text-foreground shadow-sm",
                )}
                onClick={() => {
                  setMode(value);
                  setError(null);
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-sm">
              <span className="font-medium">Project name</span>
              <Input
                autoFocus
                maxLength={120}
                placeholder="My project"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="font-medium">Owning worker</span>
              <NativeSelect
                className="w-full"
                disabled={eligibleWorkers.length === 0}
                required
                value={workerId}
                onChange={(event) => setWorkerId(event.target.value)}
              >
                {eligibleWorkers.map((worker) => (
                  <option key={worker.workerId} value={worker.workerId}>
                    {worker.name} · {worker.online ? "online" : "offline"}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>

          {mode === "existing" ? (
            <label className="grid gap-2 text-sm">
              <span className="font-medium">Existing folder path</span>
              <div className="flex gap-2">
                <Input
                  className="font-mono"
                  maxLength={8_192}
                  placeholder="/path/on/the/selected/worker"
                  required
                  value={existingPath}
                  onChange={(event) => setExistingPath(event.target.value)}
                />
                {canBrowse ? (
                  <Button
                    disabled={picking}
                    onClick={() => void chooseFolder()}
                    type="button"
                    variant="outline"
                  >
                    {picking ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <FolderOpen className="size-4" />
                    )}
                    Browse
                  </Button>
                ) : null}
              </div>
              <span className="text-xs leading-5 text-muted-foreground">
                {canBrowse
                  ? "Browse this machine or enter an absolute path. Cantrip validates the folder on the worker."
                  : "Enter an absolute path on the selected worker. The folder stays user-owned and is never deleted by Cantrip."}
              </span>
            </label>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              Cantrip creates an empty private directory under the selected
              worker’s managed storage.
            </p>
          )}

          {activeWorkspaceId ? (
            <WorkspaceAssignment
              workspaceId={activeWorkspaceId}
              workspaces={workspaces}
            />
          ) : null}

          {eligibleWorkers.length === 0 ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300">
              No enrolled worker supports this folder operation yet.
            </p>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                submitting ||
                !name.trim() ||
                !workerEligible ||
                !activeWorkspaceId ||
                (mode === "existing" && !existingPath.trim())
              }
              type="submit"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Folder className="size-4" />
              )}
              {submitting
                ? "Adding…"
                : mode === "existing"
                  ? "Use folder"
                  : "Create folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
