import type {
  ProjectReplicaPlacementRequest,
  ProjectWorkspaceSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  FolderInput,
  FolderOpen,
  Link2,
  Loader2,
  Server,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WorkspaceAssignment } from "@/components/workspaces/workspace-assignment";
import { pickLocalFolder } from "@/lib/desktop-folder-picker";
import { listDesktopWorkers } from "@/lib/desktop-worker";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

export type RepositoryPlacementMode = ProjectReplicaPlacementRequest["mode"];

export interface RepositoryImportOptions {
  placement: ProjectReplicaPlacementRequest;
}

export function repositoryPlacementAvailability(worker: WorkerSummary) {
  return {
    managed: true,
    managedLink:
      worker.projectReplicas.managedLinkPlacement &&
      worker.projectReplicas.recursiveParentCreation,
    direct:
      worker.projectReplicas.directPlacement &&
      worker.projectReplicas.attachExisting &&
      worker.projectReplicas.recursiveParentCreation,
  };
}

export function canBrowseRepositoryPath(
  mode: RepositoryPlacementMode,
  workerId: string | null,
  localWorkerIds: ReadonlySet<string>,
): boolean {
  return mode === "direct" && workerId !== null && localWorkerIds.has(workerId);
}

const choices: Array<{
  description: string;
  icon: typeof Server;
  label: string;
  mode: RepositoryPlacementMode;
}> = [
  {
    mode: "managed",
    label: "Managed by Cantrip",
    description: "Clone into this worker's Cantrip repository storage.",
    icon: Server,
  },
  {
    mode: "managed-link",
    label: "Managed clone with link",
    description:
      "Keep the canonical clone managed and create a link at the exact path.",
    icon: Link2,
  },
  {
    mode: "direct",
    label: "Use this worker path",
    description:
      "Clone at a missing path, or attach an existing matching Primary checkout.",
    icon: FolderInput,
  },
];

export function RepositoryImportOptionsDialog({
  error,
  onOpenChange,
  onSubmit,
  open,
  pending = false,
  repositoryName,
  submitLabel = "Add repository",
  title = "Add with location",
  worker,
  workspaceId,
  workspaces = [],
}: {
  error?: string | null;
  onOpenChange(open: boolean): void;
  onSubmit(options: RepositoryImportOptions): Promise<void> | void;
  open: boolean;
  pending?: boolean;
  repositoryName: string;
  submitLabel?: string;
  title?: string;
  worker: WorkerSummary | null;
  workspaceId?: string;
  workspaces?: ProjectWorkspaceSummary[];
}) {
  const [mode, setMode] = useState<RepositoryPlacementMode>("managed");
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const wasOpen = useRef(false);
  const desktopWorkers = useQuery({
    enabled: open,
    queryFn: listDesktopWorkers,
    queryKey: ["desktop-workers"],
  });
  const availability = useMemo(
    () => (worker ? repositoryPlacementAvailability(worker) : null),
    [worker],
  );
  const localWorkerIds = useMemo(
    () => new Set(desktopWorkers.data?.map(({ workerId }) => workerId) ?? []),
    [desktopWorkers.data],
  );
  const canBrowsePath = canBrowseRepositoryPath(
    mode,
    worker?.workerId ?? null,
    localWorkerIds,
  );

  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setMode("managed");
    setPath("");
    setPicking(false);
    setPickerError(null);
  }, [open]);

  const customMode = mode !== "managed";
  const selectedModeAvailable =
    mode === "managed"
      ? availability?.managed
      : mode === "managed-link"
        ? availability?.managedLink
        : availability?.direct;
  const canSubmit = Boolean(
    worker &&
    selectedModeAvailable &&
    !pending &&
    !picking &&
    (!customMode || path.trim()),
  );

  const chooseFolder = async () => {
    setPicking(true);
    setPickerError(null);
    try {
      const selected = await pickLocalFolder();
      if (selected) setPath(selected);
    } catch (pickError) {
      setPickerError(errorMessage(pickError));
    } finally {
      setPicking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Choose where {repositoryName} is available on the selected worker.
            Cantrip always runs the project from its canonical checkout.
          </DialogDescription>
        </DialogHeader>

        {worker ? (
          <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
              <Server className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {worker.name}
              </span>
              <span className="block text-xs text-muted-foreground">
                {worker.platform} · {worker.architecture}
              </span>
            </span>
          </div>
        ) : (
          <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
            The selected worker is unavailable.
          </p>
        )}

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">
            Repository placement
          </legend>
          {choices.map((choice) => {
            const supported =
              choice.mode === "managed"
                ? availability?.managed
                : choice.mode === "managed-link"
                  ? availability?.managedLink
                  : availability?.direct;
            const Icon = choice.icon;
            return (
              <label
                key={choice.mode}
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-3 py-3",
                  supported
                    ? "cursor-pointer hover:bg-muted/30"
                    : "cursor-not-allowed opacity-55",
                  mode === choice.mode &&
                    supported &&
                    "border-foreground/50 bg-muted/30",
                )}
              >
                <input
                  checked={mode === choice.mode}
                  className="mt-1 size-4 accent-foreground"
                  disabled={!supported || pending}
                  name="repository-placement"
                  type="radio"
                  value={choice.mode}
                  onChange={() => {
                    setMode(choice.mode);
                    setPickerError(null);
                  }}
                />
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {choice.label}
                  </span>
                  <span className="block text-xs leading-5 text-muted-foreground">
                    {choice.description}
                  </span>
                  {!supported && choice.mode !== "managed" ? (
                    <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">
                      {choice.mode === "managed-link"
                        ? "This worker cannot safely create repository links."
                        : "This worker cannot safely clone or attach at custom paths."}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>

        {customMode && worker ? (
          <label className="grid gap-2 text-sm font-medium">
            Path on {worker.name}
            <div className="flex gap-2">
              <Input
                autoFocus
                className="min-w-0"
                disabled={pending || picking}
                maxLength={8192}
                placeholder={
                  worker.platform === "win32"
                    ? "D:\\Projects\\repository"
                    : "/srv/projects/repository"
                }
                value={path}
                onChange={(event) => {
                  setPath(event.target.value);
                  setPickerError(null);
                }}
              />
              {canBrowsePath ? (
                <Button
                  className="shrink-0"
                  disabled={pending || picking}
                  type="button"
                  variant="outline"
                  onClick={() => void chooseFolder()}
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
            <span className="font-normal leading-5 text-muted-foreground">
              {canBrowsePath
                ? "Browse this machine or enter the exact final worker path. Missing parent directories are created."
                : "Enter the exact final worker path. Missing parent directories are created. Paths are interpreted on the worker—not this browser or phone—and container workers can use only mounted locations."}
            </span>
            {mode === "direct" ? (
              <span className="font-normal leading-5 text-muted-foreground">
                A missing path is cloned. A matching existing Primary checkout
                is attached without Cantrip taking ownership of its files.
              </span>
            ) : mode === "managed-link" ? (
              <span className="font-normal leading-5 text-muted-foreground">
                Cantrip creates a directory symlink on POSIX workers or a
                directory junction on Windows, while runtime operations keep
                using the managed canonical clone.
              </span>
            ) : null}
          </label>
        ) : null}

        {workspaceId ? (
          <WorkspaceAssignment
            workspaceId={workspaceId}
            workspaces={workspaces}
          />
        ) : null}

        {error || pickerError ? (
          <p
            className="flex gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
            role="alert"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error ?? pickerError}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            disabled={pending}
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            pending={pending}
            pendingLabel="Starting…"
            type="button"
            onClick={() => {
              const options: RepositoryImportOptions = {
                placement:
                  mode === "managed"
                    ? { mode: "managed" }
                    : { mode, path: path.trim() },
              };
              void Promise.resolve(onSubmit(options)).catch(() => undefined);
            }}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
