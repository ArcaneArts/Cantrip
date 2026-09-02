import {
  isLocalGitProject,
  type ProjectReplicaJobSummary,
  type ProjectReplicaSummary,
  type ProjectSummary,
  type WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  GitCompareArrows,
  Link2,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { projectReplicaJobMessage } from "@/lib/job-status-message";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  cancelProjectReplicaJob,
  createProjectReplica,
  getProjectReplicaJobs,
  repairProjectReplicaLink,
  removeProjectReplica,
  retryProjectReplicaJob,
  synchronizeProjectReplica,
} from "@/lib/api";
import {
  RepositoryImportOptionsDialog,
  type RepositoryImportOptions,
} from "@/components/projects/repository-import-options-dialog";
import { errorMessage } from "@/lib/error-message";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { liveResourceRefreshInterval } from "@/lib/live-resource-refresh";
import { updateProjectPreferredWorker } from "@/lib/project-encryption";
import { cn } from "@/lib/utils";

const selectClass =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2";

const activeJobStates = new Set<ProjectReplicaJobSummary["state"]>([
  "queued",
  "running",
]);

export function canonicalReplicaRevision(
  project: ProjectSummary,
): string | null {
  return (
    project.replicas.find(({ id }) => id === project.source?.id)?.head ??
    project.replicas.find(({ ready, head }) => ready && Boolean(head))?.head ??
    null
  );
}

export function projectReplicaForWorker(
  replicas: ProjectReplicaSummary[],
  workerId: string,
): ProjectReplicaSummary | null {
  return replicas.find((replica) => replica.workerId === workerId) ?? null;
}

export function preferredWorkerOptions(
  project: ProjectSummary,
  workers: WorkerSummary[],
): WorkerSummary[] {
  if (!isLocalGitProject(project.originKind, project.capabilities.git)) {
    return workers;
  }
  const eligibleWorkerIds = new Set(
    project.replicas
      .filter(({ ready }) => ready)
      .map(({ workerId }) => workerId),
  );
  return workers.filter(({ workerId }) => eligibleWorkerIds.has(workerId));
}

function shortRevision(revision: string | null): string {
  return revision?.slice(0, 10) ?? "Unknown";
}

export function replicaPlacementLabel(
  mode: ProjectReplicaSummary["placementMode"],
): string {
  if (mode === "managed-link") return "Managed clone with link";
  if (mode === "direct") return "Worker path";
  return "Managed by Cantrip";
}

export function replicaRemovalCopy(replica: ProjectReplicaSummary): string {
  if (replica.ownershipKind === "user") {
    return "This checkout existed before Cantrip and will not be deleted.";
  }
  if (replica.placementMode === "managed-link") {
    return "Keeping local files leaves both the checkout and link on the worker.";
  }
  if (replica.placementMode === "direct") {
    return "Keeping local files leaves the checkout in place and makes it user-managed.";
  }
  return "Keeping local files leaves the managed checkout on the worker.";
}

function replicaStatus(replica: ProjectReplicaSummary | null, online: boolean) {
  if (!replica)
    return { label: "Not provisioned", variant: "outline" as const };
  if (!online) return { label: "Worker offline", variant: "outline" as const };
  if (!replica.ready)
    return { label: "Needs attention", variant: "outline" as const };
  if (replica.dirty)
    return { label: "Local changes", variant: "secondary" as const };
  return { label: "Ready", variant: "secondary" as const };
}

function JobProgress({ job }: { job: ProjectReplicaJobSummary }) {
  return (
    <div className="mt-2 border-l-2 pl-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium capitalize">
          {job.kind} · {job.state}
        </span>
        <span className="text-muted-foreground">
          Attempt {job.attempt} · {job.progress.percent}%
        </span>
      </div>
      <p
        className={cn(
          "mt-0.5 text-muted-foreground",
          job.error && "text-destructive",
        )}
      >
        {projectReplicaJobMessage(job)}
      </p>
    </div>
  );
}

export function ProjectReplicaSettings({
  project,
  workers,
}: {
  project: ProjectSummary;
  workers: WorkerSummary[];
}) {
  const queryClient = useQueryClient();
  const replicaResourcesLive = useAppLiveStatus() === "live";
  const [removeTarget, setRemoveTarget] =
    useState<ProjectReplicaSummary | null>(null);
  const [provisionTarget, setProvisionTarget] = useState<WorkerSummary | null>(
    null,
  );
  const [repairOutcome, setRepairOutcome] = useState<{
    message: string;
    replicaId: string;
  } | null>(null);
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(true);
  const [synchronizationPolicy, setSynchronizationPolicy] = useState<
    "verify-only" | "fast-forward-primary"
  >("verify-only");
  const jobs = useQuery({
    queryFn: () => getProjectReplicaJobs(project.id),
    queryKey: ["project-replica-jobs", project.id],
    refetchInterval: (query) =>
      liveResourceRefreshInterval(
        replicaResourcesLive,
        query.state.data?.some((job) => activeJobStates.has(job.state))
          ? 2_000
          : false,
      ),
  });
  const refreshProject = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
      queryClient.invalidateQueries({
        queryKey: ["project-replica-jobs", project.id],
      }),
      queryClient.invalidateQueries({ queryKey: ["worktrees", project.id] }),
      queryClient.invalidateQueries({ queryKey: ["workers"] }),
      queryClient.invalidateQueries({ queryKey: ["worker-management"] }),
    ]);
  };
  const preferredWorker = useMutation({
    mutationFn: (workerId: string | null) =>
      updateProjectPreferredWorker(project.id, { workerId }),
    onSuccess: (updated) => {
      queryClient.setQueryData<ProjectSummary[]>(["projects"], (current = []) =>
        current.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      );
    },
  });
  const provision = useMutation({
    mutationFn: ({
      placement,
      workerId,
    }: {
      placement?: RepositoryImportOptions["placement"];
      workerId: string;
    }) =>
      createProjectReplica(project.id, {
        workerId,
        ...(placement ? { placement } : {}),
        ...(project.github ? { repository: project.github } : {}),
        expectedRevision: canonicalReplicaRevision(project),
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: refreshProject,
  });
  const synchronize = useMutation({
    mutationFn: (replica: ProjectReplicaSummary) =>
      synchronizeProjectReplica(project.id, replica.id, {
        ...(project.github ? { repository: project.github } : {}),
        expectedRevision: canonicalReplicaRevision(project)!,
        policy: synchronizationPolicy,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: refreshProject,
  });
  const remove = useMutation({
    mutationFn: (replica: ProjectReplicaSummary) =>
      removeProjectReplica(project.id, replica.id, {
        ...(project.github ? { repository: project.github } : {}),
        deleteLocalFiles,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async () => {
      setRemoveTarget(null);
      await refreshProject();
    },
  });
  const repairLink = useMutation({
    mutationFn: (replica: ProjectReplicaSummary) =>
      repairProjectReplicaLink(project.id, replica.id),
    onMutate: () => setRepairOutcome(null),
    onSuccess: async (result, replica) => {
      if (result.status === "ready") {
        setRepairOutcome({
          replicaId: replica.id,
          message: result.repaired ? "Link recreated" : "Link verified",
        });
      }
      await refreshProject();
    },
  });
  const retry = useMutation({
    mutationFn: (job: ProjectReplicaJobSummary) =>
      retryProjectReplicaJob(job.id, { stateRevision: job.stateRevision }),
    onSuccess: refreshProject,
  });
  const cancel = useMutation({
    mutationFn: (job: ProjectReplicaJobSummary) =>
      cancelProjectReplicaJob(job.id, { stateRevision: job.stateRevision }),
    onSuccess: refreshProject,
  });
  const latestJobs = useMemo(() => {
    const byWorker = new Map<string, ProjectReplicaJobSummary>();
    for (const job of jobs.data ?? []) {
      const current = byWorker.get(job.workerId);
      if (!current || current.createdAt < job.createdAt) {
        byWorker.set(job.workerId, job);
      }
    }
    return byWorker;
  }, [jobs.data]);
  const lastFetches = useMemo(() => {
    const byWorker = new Map<string, string>();
    for (const job of jobs.data ?? []) {
      if (
        job.state !== "succeeded" ||
        (job.kind !== "provision" && job.kind !== "synchronize") ||
        !job.completedAt
      ) {
        continue;
      }
      const current = byWorker.get(job.workerId);
      if (!current || current < job.completedAt) {
        byWorker.set(job.workerId, job.completedAt);
      }
    }
    return byWorker;
  }, [jobs.data]);
  const provisionOutcomes = useMemo(() => {
    const byWorker = new Map<string, ProjectReplicaJobSummary>();
    for (const job of jobs.data ?? []) {
      if (job.kind !== "provision" || job.state !== "succeeded") continue;
      const current = byWorker.get(job.workerId);
      if (!current || current.createdAt < job.createdAt) {
        byWorker.set(job.workerId, job);
      }
    }
    return byWorker;
  }, [jobs.data]);
  const mutationError =
    preferredWorker.error ??
    provision.error ??
    synchronize.error ??
    remove.error ??
    repairLink.error ??
    retry.error ??
    cancel.error ??
    jobs.error;
  const canonicalRevision = canonicalReplicaRevision(project);
  const localGitProject = isLocalGitProject(
    project.originKind,
    project.capabilities.git,
  );
  const preferredWorkers = useMemo(
    () => preferredWorkerOptions(project, workers),
    [project, workers],
  );

  return (
    <div
      className="min-h-0 w-full flex-1 space-y-5 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8"
      data-content-gutter="standard"
    >
      <section aria-labelledby="replica-placement-title">
        <div className="mb-3">
          <h2 id="replica-placement-title" className="font-semibold">
            Project placement
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the worker Cantrip should prefer when creating new agents,
            terminals, explorers, Code sessions, browsers, and desktops for this
            project.
          </p>
        </div>
        <label className="grid gap-2 border-y px-3 py-3 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-center">
          <span>
            <span className="block text-sm font-medium">Preferred worker</span>
            <span className="block text-xs text-muted-foreground">
              {localGitProject
                ? "Only workers with an attached, ready source are eligible. Existing surfaces are not moved."
                : "Falls back to the global default when no project preference is set. Existing surfaces are not moved."}
            </span>
          </span>
          <NativeSelect
            className={selectClass}
            value={project.preferredWorkerId ?? ""}
            disabled={preferredWorker.isPending}
            onChange={(event) =>
              preferredWorker.mutate(event.target.value || null)
            }
          >
            <option value="">Use global default</option>
            {preferredWorkers.map((worker) => (
              <option key={worker.workerId} value={worker.workerId}>
                {worker.name} ({worker.online ? "online" : "offline"})
              </option>
            ))}
          </NativeSelect>
        </label>
      </section>

      <section aria-labelledby="replicas-title">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="replicas-title" className="font-semibold">
              {localGitProject ? "Worker sources" : "Worker replicas"}{" "}
              <span className="text-muted-foreground">
                ({project.replicas.length})
              </span>
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {localGitProject
                ? "Attach existing compatible checkouts explicitly. Cantrip never clones or deletes these local-only sources."
                : "One logical project with independent worker-local checkouts. Synchronization is revision-pinned and preserves local work."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!localGitProject ? (
              <NativeSelect
                aria-label="Replica synchronization policy"
                size="sm"
                value={synchronizationPolicy}
                onChange={(event) =>
                  setSynchronizationPolicy(
                    event.target.value as typeof synchronizationPolicy,
                  )
                }
              >
                <option value="verify-only">Verify only</option>
                <option value="fast-forward-primary">
                  Fast-forward Primary
                </option>
              </NativeSelect>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={jobs.isFetching}
              onClick={() => void refreshProject()}
            >
              <RefreshCw
                className={cn("size-3.5", jobs.isFetching && "animate-spin")}
              />
              Refresh
            </Button>
          </div>
        </div>

        {mutationError ? (
          <div className="mb-3 flex gap-2 border-y border-destructive/50 px-3 py-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{errorMessage(mutationError)}</span>
          </div>
        ) : null}

        <div className="divide-y border-y">
          {workers.map((worker) => {
            const replica = projectReplicaForWorker(
              project.replicas,
              worker.workerId,
            );
            const status = replicaStatus(replica, worker.online);
            const job = latestJobs.get(worker.workerId) ?? null;
            const lastFetchAt = lastFetches.get(worker.workerId) ?? null;
            const provisionOutcome = provisionOutcomes.get(worker.workerId);
            const capabilities = [
              worker.projectReplicas.provision ? "provision" : null,
              worker.projectReplicas.synchronize ? "sync" : null,
              worker.projectReplicas.remove ? "remove" : null,
              worker.projectReplicas.exactRevision ? "exact revision" : null,
              worker.projectReplicas.directPlacement ? "custom path" : null,
              worker.projectReplicas.managedLinkPlacement ? "links" : null,
            ].filter(Boolean);
            const jobActive = Boolean(job && activeJobStates.has(job.state));
            const canProvision =
              !replica &&
              worker.online &&
              worker.projectReplicas.provision &&
              worker.projectReplicas.exactRevision &&
              (!localGitProject ||
                (Boolean(canonicalRevision) &&
                  worker.projectReplicas.directPlacement &&
                  worker.projectReplicas.attachExisting)) &&
              !jobActive;
            const canSynchronize =
              !localGitProject &&
              Boolean(replica) &&
              worker.online &&
              worker.projectReplicas.synchronize &&
              worker.projectReplicas.exactRevision &&
              Boolean(canonicalRevision) &&
              !jobActive;
            const canRemove =
              Boolean(replica) &&
              project.replicas.length > 1 &&
              worker.online &&
              worker.projectReplicas.remove &&
              !jobActive;
            return (
              <div
                key={worker.workerId}
                data-high-contrast-row
                className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 rounded-full bg-muted-foreground",
                        worker.online && "bg-emerald-400",
                      )}
                    />
                    <span className="truncate text-sm font-medium">
                      {worker.name}
                    </span>
                    <Badge variant={status.variant}>{status.label}</Badge>
                    {project.preferredWorkerId === worker.workerId ? (
                      <Badge variant="outline">Preferred</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {worker.platform} · {worker.architecture}
                    {worker.codexVersion
                      ? ` · Codex ${worker.codexVersion}`
                      : ""}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    Replica capabilities: {capabilities.join(", ") || "none"}
                  </p>
                </div>
                <div className="min-w-0 text-xs">
                  {replica ? (
                    <>
                      <p className="truncate">
                        {replica.branch ?? "Detached"} ·{" "}
                        {shortRevision(replica.head)}
                        {replica.dirty === true
                          ? " · dirty"
                          : replica.dirty === false
                            ? " · clean"
                            : ""}
                      </p>
                      <p className="mt-0.5 truncate text-muted-foreground">
                        {replica.displayPath} · {replica.worktreeCount} worktree
                        {replica.worktreeCount === 1 ? "" : "s"}
                        {replica.lastObservedAt
                          ? ` · observed ${new Date(replica.lastObservedAt).toLocaleString()}`
                          : " · not observed yet"}
                      </p>
                      <p className="mt-0.5 truncate text-muted-foreground">
                        Last fetch:{" "}
                        {lastFetchAt
                          ? new Date(lastFetchAt).toLocaleString()
                          : "No completed fetch recorded"}
                      </p>
                      <div className="mt-2 grid gap-1 rounded-md border bg-muted/15 p-2 text-[11px] text-muted-foreground sm:grid-cols-2">
                        <span>
                          Placement:{" "}
                          {replicaPlacementLabel(replica.placementMode)}
                        </span>
                        <span>
                          Ownership:{" "}
                          {replica.ownershipKind === "user"
                            ? "User-owned; never deleted by Cantrip"
                            : "Cantrip-owned"}
                        </span>
                        <span className="truncate" title={replica.path}>
                          Canonical: {replica.path}
                        </span>
                        <span
                          className="truncate"
                          title={
                            replica.linkPath ??
                            replica.requestedPath ??
                            undefined
                          }
                        >
                          {replica.placementMode === "managed-link"
                            ? `Link: ${replica.linkPath ?? "Unavailable"}`
                            : replica.placementMode === "direct"
                              ? `Requested: ${replica.requestedPath ?? "Unavailable"}`
                              : "Requested path: Cantrip managed"}
                        </span>
                        <span>
                          Materialization:{" "}
                          {provisionOutcome?.resolvedMaterialization ??
                            "Existing replica"}
                        </span>
                        {replica.placementMode === "managed-link" ? (
                          <span>
                            Repair status:{" "}
                            {repairOutcome?.replicaId === replica.id
                              ? repairOutcome.message
                              : replica.linkPath
                                ? "Link can be verified or repaired"
                                : "Link metadata unavailable"}
                          </span>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      {worker.online
                        ? localGitProject
                          ? "No compatible source attached on this worker."
                          : "No checkout on this worker."
                        : localGitProject
                          ? "Connect this worker to attach an existing source."
                          : "Connect this worker to provision a checkout."}
                    </p>
                  )}
                  {job ? <JobProgress job={job} /> : null}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {!worker.online ? (
                    <WifiOff className="mr-1 size-4 text-muted-foreground" />
                  ) : null}
                  {!replica ? (
                    localGitProject ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canProvision || provision.isPending}
                        onClick={() => setProvisionTarget(worker)}
                      >
                        {provision.isPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <MapPin className="size-3.5" />
                        )}
                        Attach source
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canProvision || provision.isPending}
                          onClick={() =>
                            provision.mutate({
                              workerId: worker.workerId,
                              placement: { mode: "managed" },
                            })
                          }
                        >
                          {provision.isPending ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Plus className="size-3.5" />
                          )}
                          Provision
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={!canProvision || provision.isPending}
                          title="Provision with location"
                          onClick={() => setProvisionTarget(worker)}
                        >
                          <MapPin className="size-3.5" />
                          <span className="sr-only">
                            Provision on {worker.name} with location
                          </span>
                        </Button>
                      </>
                    )
                  ) : (
                    <>
                      {!localGitProject ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canSynchronize || synchronize.isPending}
                          onClick={() => synchronize.mutate(replica)}
                        >
                          <GitCompareArrows className="size-3.5" /> Sync
                        </Button>
                      ) : null}
                      {replica.placementMode === "managed-link" ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={
                            !worker.online ||
                            !worker.projectReplicas.managedLinkPlacement ||
                            repairLink.isPending
                          }
                          title="Verify or repair managed link"
                          onClick={() => repairLink.mutate(replica)}
                        >
                          <Link2 className="size-3.5" />
                          <span className="sr-only">
                            Verify or repair link on {worker.name}
                          </span>
                        </Button>
                      ) : null}
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={!canRemove || remove.isPending}
                        onClick={() => {
                          setDeleteLocalFiles(
                            !localGitProject &&
                              replica.placementMode === "managed" &&
                              replica.ownershipKind === "cantrip",
                          );
                          setRemoveTarget(replica);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                        <span className="sr-only">
                          Remove replica from {worker.name}
                        </span>
                      </Button>
                    </>
                  )}
                  {job?.error?.retryable &&
                  (job.state === "failed" || job.state === "blocked") ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate(job)}
                    >
                      <RotateCcw className="size-3.5" /> Retry
                    </Button>
                  ) : null}
                  {job &&
                  (job.state === "queued" || job.state === "blocked") &&
                  !job.cancellationUnsafeAt ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(job)}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
          {!workers.length ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              No linked workers are available.
            </p>
          ) : null}
        </div>
      </section>

      <Dialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {localGitProject
                ? "Detach worker source?"
                : "Remove worker replica?"}
            </DialogTitle>
            <DialogDescription>
              {localGitProject
                ? "Cantrip will remove only its source registration. The checkout and every file in it remain untouched. The last active source cannot be detached."
                : "Cantrip will first verify that no live surface, lease, job, unpublished commit, local change, or extra worktree depends on this checkout. The last active replica cannot be removed."}
            </DialogDescription>
          </DialogHeader>
          {!localGitProject ? (
            <label className="flex items-start gap-3 border-y px-2 py-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-foreground"
                checked={deleteLocalFiles}
                disabled={removeTarget?.ownershipKind === "user"}
                onChange={(event) => setDeleteLocalFiles(event.target.checked)}
              />
              <span>
                <span className="block font-medium">Delete local checkout</span>
                <span className="block text-xs text-muted-foreground">
                  {removeTarget
                    ? replicaRemovalCopy(removeTarget)
                    : "Keep local files on the worker."}
                </span>
              </span>
            </label>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeTarget && remove.mutate(removeTarget)}
              pending={remove.isPending}
              pendingLabel="Removing…"
            >
              <Trash2 className="size-4" />
              {localGitProject ? "Detach source" : "Remove replica"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RepositoryImportOptionsDialog
        attachOnly={localGitProject}
        error={provision.error ? errorMessage(provision.error) : null}
        open={Boolean(provisionTarget)}
        pending={provision.isPending}
        repositoryName={project.github?.nameWithOwner ?? project.name}
        submitLabel={localGitProject ? "Attach source" : "Provision replica"}
        title={
          localGitProject
            ? "Attach local Git source"
            : "Provision with location"
        }
        worker={provisionTarget}
        onOpenChange={(open) => !open && setProvisionTarget(null)}
        onSubmit={async ({ placement }) => {
          if (!provisionTarget) return;
          await provision.mutateAsync({
            workerId: provisionTarget.workerId,
            placement,
          });
          setProvisionTarget(null);
        }}
      />
    </div>
  );
}
