import type {
  ProjectWorkspaceCreate,
  ProjectWorkspaceSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { WorkspaceRepositoryDiscoveryReview } from "@/components/settings/workspace-repository-discovery-review";
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
import { NativeSelect } from "@/components/ui/native-select";
import { getWorkerLocality } from "@/lib/api";
import { pickLocalFolder } from "@/lib/desktop-folder-picker";
import { listDesktopWorkers } from "@/lib/desktop-worker";
import {
  getActiveServerConnection,
  getActiveServerUrl,
} from "@/lib/server-connections";
import { workspaceFolderPickerWorkerIds } from "@/lib/workspace-folder-picker";

export function workspaceCreationCanSubmit(input: {
  name: string;
  selectedWorker: WorkerSummary | undefined;
  storageKind: "attached" | "managed";
  rootPath: string;
  submitting: boolean;
}): boolean {
  return Boolean(
    input.name.trim() &&
    !input.submitting &&
    (input.storageKind === "managed" ||
      (input.selectedWorker && input.rootPath.trim())),
  );
}

export function WorkspaceCreateDialog({
  onCreate,
  onOpenChange,
  open,
  workers,
  workspaces,
}: {
  onCreate(input: ProjectWorkspaceCreate): Promise<ProjectWorkspaceSummary>;
  onOpenChange(open: boolean): void;
  open: boolean;
  workers: WorkerSummary[];
  workspaces: ProjectWorkspaceSummary[];
}) {
  const [name, setName] = useState("");
  const [storageKind, setStorageKind] = useState<"attached" | "managed">(
    "managed",
  );
  const [workerId, setWorkerId] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositoryReviewWorkspace, setRepositoryReviewWorkspace] =
    useState<ProjectWorkspaceSummary | null>(null);
  const [localWorkerIds, setLocalWorkerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const activeConnection = getActiveServerConnection();
  const serverUrl =
    getActiveServerUrl() ||
    (typeof window === "undefined" ? "" : window.location.origin);
  const attachableWorkers = useMemo(
    () =>
      workers.filter(
        ({ managedFolders }) => managedFolders?.attachWorkspaceRoot,
      ),
    [workers],
  );
  useEffect(() => {
    if (!open || storageKind !== "attached") return;
    let cancelled = false;
    void Promise.all([
      listDesktopWorkers().catch(() => []),
      activeConnection?.kind === "local"
        ? getWorkerLocality().catch(() => [])
        : Promise.resolve([]),
    ]).then(([desktopWorkers, workerManagement]) => {
      if (cancelled) return;
      setLocalWorkerIds(
        workspaceFolderPickerWorkerIds({
          connectionKind: activeConnection?.kind ?? null,
          desktopWorkers,
          serverUrl,
          workerManagement,
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [activeConnection?.kind, open, serverUrl, storageKind]);
  useEffect(() => {
    if (storageKind !== "attached" || workerId) return;
    setWorkerId(
      attachableWorkers.find(({ online }) => online)?.workerId ??
        attachableWorkers[0]?.workerId ??
        "",
    );
  }, [attachableWorkers, storageKind, workerId]);
  const selectedWorker = attachableWorkers.find(
    (worker) => worker.workerId === workerId,
  );
  const canSubmit = workspaceCreationCanSubmit({
    name,
    rootPath,
    selectedWorker,
    storageKind,
    submitting,
  });

  const chooseFolder = async () => {
    setPickingFolder(true);
    try {
      const selected = await pickLocalFolder();
      if (selected) setRootPath(selected);
    } finally {
      setPickingFolder(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const workspace = await onCreate({
        name: name.trim(),
        storage:
          storageKind === "attached"
            ? { kind: "attached", workerId, rootPath }
            : { kind: "managed" },
      });
      setName("");
      setStorageKind("managed");
      setWorkerId("");
      setRootPath("");
      onOpenChange(false);
      if (workspace.storage.kind === "attached") {
        setRepositoryReviewWorkspace(workspace);
      }
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Could not create the workspace.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const reviewWorkspaces = repositoryReviewWorkspace
    ? [
        ...workspaces.filter(({ id }) => id !== repositoryReviewWorkspace.id),
        repositoryReviewWorkspace,
      ]
    : workspaces;
  const reviewStorage = repositoryReviewWorkspace?.storage;
  const reviewWorker =
    reviewStorage?.kind === "attached"
      ? workers.find(
          ({ workerId: candidateWorkerId }) =>
            candidateWorkerId === reviewStorage.workerId,
        )
      : undefined;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <form className="grid min-w-0 gap-5" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>New workspace</DialogTitle>
              <DialogDescription>
                Projects created or imported here remain assigned to this
                workspace.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-2 text-sm">
              Name
              <Input
                autoFocus
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Personal Projects"
              />
            </label>
            <div className="grid gap-3">
              <span className="text-sm font-medium">Storage</span>
              <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Button
                  className="h-auto min-w-0 items-start justify-start whitespace-normal px-3 py-3 text-left"
                  onClick={() => setStorageKind("managed")}
                  type="button"
                  variant={storageKind === "managed" ? "default" : "outline"}
                >
                  <span className="min-w-0">
                    <span className="block font-medium">
                      Managed by Cantrip
                    </span>
                    <span className="mt-1 block break-words text-xs font-normal text-muted-foreground">
                      Available independently on every compatible worker.
                    </span>
                  </span>
                </Button>
                <Button
                  className="h-auto min-w-0 items-start justify-start whitespace-normal px-3 py-3 text-left"
                  onClick={() => setStorageKind("attached")}
                  type="button"
                  variant={storageKind === "attached" ? "default" : "outline"}
                >
                  <span className="min-w-0">
                    <span className="block font-medium">
                      Use an existing folder
                    </span>
                    <span className="mt-1 block break-words text-xs font-normal text-muted-foreground">
                      Attach a user-owned directory on one home worker.
                    </span>
                  </span>
                </Button>
              </div>
            </div>
            {storageKind === "attached" ? (
              <div className="grid gap-4 rounded-lg border p-3">
                <label className="grid gap-2 text-sm">
                  Home worker
                  <NativeSelect
                    disabled={!attachableWorkers.length}
                    value={workerId}
                    onChange={(event) => setWorkerId(event.target.value)}
                  >
                    {!attachableWorkers.length ? (
                      <option value="">No compatible workers</option>
                    ) : null}
                    {attachableWorkers.map((worker) => (
                      <option key={worker.workerId} value={worker.workerId}>
                        {worker.name} · {worker.online ? "online" : "offline"}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="grid gap-2 text-sm">
                  Existing folder path
                  <div className="flex gap-2">
                    <Input
                      className="font-mono"
                      maxLength={8_192}
                      placeholder="/path/on/the/selected/worker"
                      value={rootPath}
                      onChange={(event) => setRootPath(event.target.value)}
                    />
                    {localWorkerIds.has(workerId) ? (
                      <Button
                        disabled={pickingFolder}
                        onClick={() => void chooseFolder()}
                        type="button"
                        variant="outline"
                      >
                        {pickingFolder ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <FolderOpen className="size-4" />
                        )}
                        Browse
                      </Button>
                    ) : null}
                  </div>
                  <span className="text-xs leading-5 text-muted-foreground">
                    {localWorkerIds.has(workerId)
                      ? "Browse this machine or enter an absolute path. The worker validates and protects it before Cantrip creates the workspace."
                      : "Enter an absolute path on the selected worker. Cantrip never deletes or relocates the attached folder."}
                  </span>
                  {selectedWorker && !selectedWorker.online ? (
                    <span className="text-xs text-destructive">
                      The home worker must be online to attach this folder.
                    </span>
                  ) : null}
                </label>
              </div>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button disabled={!canSubmit} type="submit">
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                Create and switch
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {repositoryReviewWorkspace ? (
        <WorkspaceRepositoryDiscoveryReview
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setRepositoryReviewWorkspace(null);
          }}
          workspace={repositoryReviewWorkspace}
          workspaces={reviewWorkspaces}
          workerOnline={reviewWorker?.online === true}
        />
      ) : null}
    </>
  );
}
