import type {
  ProjectGithubConversionRepository,
  ProjectWorkspaceSummary,
  WorkspaceRepositoryCandidateSummary,
  WorkspaceRepositoryDiscoverySnapshot,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FolderGit2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getWorkspaceRepositoryDiscovery,
  resolveWorkerRepositoryMetadata,
  startWorkspaceRepositoryDiscovery,
  startWorkspaceRepositoryImports,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { prepareWorkspaceRepositoryImport } from "@/lib/project-encryption";

export interface ResolvedWorkspaceRepositoryCandidate {
  candidate: WorkspaceRepositoryCandidateSummary;
  displayPath: string | null;
  originUrl: string | null;
  github: {
    nameWithOwner: string | null;
    repositoryId: string | null;
    url: string | null;
  } | null;
}

function resolvedString(
  values: Record<string, string | string[] | null>,
  key: string,
): string | null {
  const value = values[key];
  return typeof value === "string" ? value : null;
}

export async function resolveWorkspaceRepositoryCandidate(
  candidate: WorkspaceRepositoryCandidateSummary,
): Promise<ResolvedWorkspaceRepositoryCandidate> {
  const github = candidate.github;
  const values = {
    displayPath: candidate.displayHandle,
    ...(candidate.originUrlHandle
      ? { originUrl: candidate.originUrlHandle }
      : {}),
    ...(github
      ? {
          repositoryId: github.repositoryId,
          nameWithOwner: github.nameWithOwner,
          url: github.url,
        }
      : {}),
  };
  const resolved = await resolveWorkerRepositoryMetadata({
    scopeId: candidate.workspaceId,
    workerId: candidate.workerId,
    values,
  });
  return {
    candidate,
    displayPath: resolvedString(resolved.values, "displayPath"),
    originUrl: resolvedString(resolved.values, "originUrl"),
    github: github
      ? {
          repositoryId: resolvedString(resolved.values, "repositoryId"),
          nameWithOwner: resolvedString(resolved.values, "nameWithOwner"),
          url: resolvedString(resolved.values, "url"),
        }
      : null,
  };
}

export function workspaceRepositoryCandidateClassificationLabel(
  classification: WorkspaceRepositoryCandidateSummary["classification"],
): string {
  switch (classification) {
    case "github-accessible":
      return "GitHub accessible";
    case "github-unavailable":
      return "Local Git · GitHub unavailable";
    case "local-git":
      return "Local Git";
    case "unclassified":
      return "Classifying";
    case "unsupported":
      return "Unsupported checkout";
  }
}

export function workspaceRepositoryCandidateDiagnosticLabel(
  code: WorkspaceRepositoryCandidateSummary["diagnosticCode"],
): string | null {
  switch (code) {
    case "origin-invalid":
      return "The Git origin is not a supported GitHub repository URL.";
    case "origin-unavailable":
      return "The Git origin could not be read.";
    case "github-cli-unavailable":
      return "GitHub CLI is unavailable on this worker.";
    case "github-api-unavailable":
      return "GitHub could not verify access with the worker credential.";
    case "github-api-invalid":
      return "GitHub returned an invalid repository identity.";
    case "github-identity-mismatch":
      return "GitHub returned a different repository than the Git origin.";
    case "bare-repository":
      return "Bare repositories cannot be imported automatically.";
    case "linked-worktree":
      return "Non-primary linked worktrees cannot be imported automatically.";
    case null:
      return null;
  }
}

function discoveryError(
  snapshot: WorkspaceRepositoryDiscoverySnapshot,
): string {
  switch (snapshot.job.error?.code) {
    case "worker-offline":
      return "The home worker is offline. Discovery resumes when it reconnects.";
    case "capability-missing":
      return "This worker does not support attached-workspace discovery.";
    case "root-unavailable":
      return "The attached workspace root is no longer available on its worker.";
    case "discovery-failed":
      return "The worker could not scan this workspace.";
    default:
      return "Repository discovery did not complete.";
  }
}

function progressDescription(
  snapshot: WorkspaceRepositoryDiscoverySnapshot,
): string {
  const counts = snapshot.progress?.counts ?? snapshot.job.counts;
  if (!counts) return "Preparing the worker scan…";
  return `${counts.scannedDirectories.toLocaleString()} directories scanned · ${counts.candidates.toLocaleString()} repositories found`;
}

function CandidateRow({
  checked,
  disabled,
  onCheckedChange,
  resolved,
  workspaceName,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange(checked: boolean): void;
  resolved: ResolvedWorkspaceRepositoryCandidate;
  workspaceName: string | null;
}) {
  const { candidate } = resolved;
  const diagnostic = workspaceRepositoryCandidateDiagnosticLabel(
    candidate.diagnosticCode,
  );
  const conflict = candidate.conflict;
  const status =
    conflict && candidate.importState !== "imported"
      ? "Skipped"
      : candidate.importState === "pending"
        ? null
        : candidate.importState === "queued"
          ? "Queued"
          : candidate.importState === "importing"
            ? "Importing"
            : candidate.importState === "imported"
              ? "Imported"
              : candidate.importState === "blocked"
                ? "Waiting for worker"
                : candidate.importState === "failed"
                  ? "Failed"
                  : "Skipped";
  return (
    <li className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="flex min-w-0 gap-3">
        <input
          aria-label={`Select ${resolved.displayPath ?? "repository"}`}
          checked={checked}
          className="mt-0.5 size-4 shrink-0 accent-primary disabled:opacity-50"
          disabled={disabled}
          onChange={(event) => onCheckedChange(event.target.checked)}
          type="checkbox"
        />
        {candidate.importState === "imported" ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        ) : (
          <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p
            className="truncate font-mono text-xs font-medium"
            title={resolved.displayPath ?? undefined}
          >
            {resolved.displayPath ?? "Protected path unavailable"}
          </p>
          {resolved.github?.nameWithOwner ? (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {resolved.github.nameWithOwner}
            </p>
          ) : resolved.originUrl ? (
            <p
              className="mt-1 truncate text-xs text-muted-foreground"
              title={resolved.originUrl}
            >
              {resolved.originUrl}
            </p>
          ) : null}
          {diagnostic ? (
            <p className="mt-1 text-xs text-muted-foreground">{diagnostic}</p>
          ) : null}
          {conflict ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Already registered in {workspaceName ?? "another workspace"}; it
              will not be moved.
            </p>
          ) : null}
          {candidate.importError ? (
            <p className="mt-1 text-xs text-destructive">
              {importErrorLabel(candidate.importError.code)}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 sm:justify-end">
        <Badge
          variant={
            candidate.classification === "github-accessible"
              ? "secondary"
              : "outline"
          }
        >
          {workspaceRepositoryCandidateClassificationLabel(
            candidate.classification,
          )}
        </Badge>
        {status ? <Badge variant="outline">{status}</Badge> : null}
      </div>
    </li>
  );
}

function importErrorLabel(
  code: NonNullable<WorkspaceRepositoryCandidateSummary["importError"]>["code"],
): string {
  switch (code) {
    case "worker-offline":
      return "The home worker is offline. Import resumes when it reconnects.";
    case "capability-missing":
      return "This worker cannot validate attached repositories.";
    case "repository-unavailable":
      return "This repository path is no longer available.";
    case "repository-changed":
      return "The checkout changed after discovery. Rescan before retrying.";
    case "project-conflict":
      return "The reserved project identity conflicts with another project.";
    case "import-failed":
      return "Cantrip could not register this repository.";
  }
}

export function workspaceRepositoryCandidateName(
  resolved: ResolvedWorkspaceRepositoryCandidate,
) {
  const githubName = resolved.github?.nameWithOwner?.split("/").at(-1);
  if (githubName) return githubName;
  const normalized = resolved.displayPath?.replace(/[\\/]+$/u, "") ?? "";
  const pathName = normalized
    .split(/[\\/]/u)
    .at(-1)
    ?.replace(/\.git$/iu, "");
  return pathName?.trim() || "Repository";
}

export function workspaceRepositoryCandidateGithub(
  resolved: ResolvedWorkspaceRepositoryCandidate,
): ProjectGithubConversionRepository | null {
  if (resolved.candidate.classification !== "github-accessible") return null;
  const github = resolved.github;
  return github?.repositoryId && github.nameWithOwner && github.url
    ? {
        repositoryId: github.repositoryId,
        nameWithOwner: github.nameWithOwner,
        url: github.url,
      }
    : null;
}

export function workspaceRepositoryCandidateCanImport(
  resolved: ResolvedWorkspaceRepositoryCandidate,
) {
  const { candidate } = resolved;
  return (
    !candidate.conflict &&
    ["pending", "failed", "blocked"].includes(candidate.importState) &&
    !["unclassified", "unsupported"].includes(candidate.classification) &&
    Boolean(resolved.displayPath) &&
    (candidate.classification !== "github-accessible" ||
      workspaceRepositoryCandidateGithub(resolved) !== null)
  );
}

export function workspaceRepositoryCandidateIsVisible(
  resolved: ResolvedWorkspaceRepositoryCandidate,
): boolean {
  return (
    resolved.candidate.importState !== "imported" &&
    resolved.candidate.conflict === null
  );
}

export function defaultWorkspaceRepositorySelection(
  candidates: readonly ResolvedWorkspaceRepositoryCandidate[],
): Set<string> {
  return new Set(
    candidates
      .filter(
        (resolved) =>
          resolved.candidate.classification === "github-accessible" &&
          workspaceRepositoryCandidateCanImport(resolved),
      )
      .map(({ candidate }) => candidate.id),
  );
}

export function WorkspaceRepositoryDiscoveryReview({
  open,
  onOpenChange,
  refreshOnOpen = false,
  workspace,
  workspaces,
  workerOnline,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  refreshOnOpen?: boolean;
  workspace: ProjectWorkspaceSummary | null;
  workspaces: ProjectWorkspaceSummary[];
  workerOnline: boolean;
}) {
  const queryClient = useQueryClient();
  const workspaceId = workspace?.id ?? "";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectionScope = useRef<string | null>(null);
  const refreshedWorkspace = useRef<string | null>(null);
  const discovery = useQuery({
    enabled: open && workspace?.storage.kind === "attached",
    queryFn: () => getWorkspaceRepositoryDiscovery(workspaceId),
    queryKey: ["workspace-repository-discovery", workspaceId],
    retry: false,
  });
  const snapshot = discovery.data;
  const metadataKey = snapshot
    ? [
        "workspace-repository-discovery-metadata",
        workspaceId,
        snapshot.job.id,
        snapshot.job.stateRevision,
      ]
    : ["workspace-repository-discovery-metadata", workspaceId];
  const metadata = useQuery({
    enabled:
      open &&
      workerOnline &&
      snapshot?.job.state === "succeeded" &&
      snapshot.candidates.length > 0,
    queryFn: () =>
      Promise.all(
        snapshot!.candidates.map(resolveWorkspaceRepositoryCandidate),
      ),
    queryKey: metadataKey,
    retry: false,
    staleTime: Infinity,
  });
  const rescan = useMutation({
    mutationFn: () =>
      startWorkspaceRepositoryDiscovery(workspaceId, {
        expectedStateRevision: snapshot?.job.stateRevision,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(
        ["workspace-repository-discovery", workspaceId],
        next,
      );
    },
  });
  const candidates = useMemo(
    () =>
      metadata.data ??
      snapshot?.candidates.map((candidate) => ({
        candidate,
        displayPath: null,
        originUrl: null,
        github: null,
      })) ??
      [],
    [metadata.data, snapshot?.candidates],
  );
  const visibleCandidates = useMemo(
    () => candidates.filter(workspaceRepositoryCandidateIsVisible),
    [candidates],
  );
  const busy =
    snapshot?.job.state === "queued" || snapshot?.job.state === "running";
  const activeImports =
    snapshot?.candidates.some(({ importState }) =>
      ["queued", "importing"].includes(importState),
    ) ?? false;
  const selectableIds = useMemo(
    () =>
      new Set(
        visibleCandidates
          .filter(workspaceRepositoryCandidateCanImport)
          .map(({ candidate }) => candidate.id),
      ),
    [visibleCandidates],
  );
  const selectedCandidates = visibleCandidates.filter(({ candidate }) =>
    selected.has(candidate.id),
  );
  const defaultSelection = useMemo(
    () => defaultWorkspaceRepositorySelection(visibleCandidates),
    [visibleCandidates],
  );
  const allSelected =
    selectableIds.size > 0 &&
    [...selectableIds].every((candidateId) => selected.has(candidateId));
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((item) => [item.id, item.name])),
    [workspaces],
  );
  useEffect(() => {
    if (!open || !snapshot) {
      selectionScope.current = null;
      setSelected(new Set());
      return;
    }
    const scope = `${workspaceId}:${snapshot.job.id}:${snapshot.job.stateRevision}`;
    if (selectionScope.current !== scope) {
      if (!metadata.isSuccess) return;
      selectionScope.current = scope;
      setSelected(defaultSelection);
      return;
    }
    setSelected(
      (current) =>
        new Set(
          [...current].filter((candidateId) => selectableIds.has(candidateId)),
        ),
    );
  }, [
    defaultSelection,
    metadata.isSuccess,
    open,
    selectableIds,
    snapshot,
    workspaceId,
  ]);
  useEffect(() => {
    if (!open) refreshedWorkspace.current = null;
  }, [open]);
  const importRepositories = useMutation({
    mutationFn: async () => {
      if (!snapshot || selectedCandidates.length === 0) {
        throw new Error("Select at least one repository to import.");
      }
      const imports = await Promise.all(
        selectedCandidates.map((resolved) =>
          prepareWorkspaceRepositoryImport({
            candidateId: resolved.candidate.id,
            name: workspaceRepositoryCandidateName(resolved),
            repository: workspaceRepositoryCandidateGithub(resolved),
            workerId: resolved.candidate.workerId,
          }),
        ),
      );
      return startWorkspaceRepositoryImports(workspaceId, {
        candidates: imports,
        expectedStateRevision: snapshot.job.stateRevision,
      });
    },
    onSuccess: (next) => {
      setSelected(new Set());
      queryClient.setQueryData(
        ["workspace-repository-discovery", workspaceId],
        next,
      );
      onOpenChange(false);
    },
  });
  useEffect(() => {
    if (
      !open ||
      !refreshOnOpen ||
      !workspaceId ||
      !snapshot ||
      !workerOnline ||
      refreshedWorkspace.current === workspaceId
    ) {
      return;
    }
    refreshedWorkspace.current = workspaceId;
    if (!busy && !activeImports) rescan.mutate();
  }, [
    activeImports,
    busy,
    open,
    refreshOnOpen,
    snapshot,
    workerOnline,
    workspaceId,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90svh,850px)] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {workspace ? `${workspace.name} repositories` : "Repositories"}
          </DialogTitle>
          <DialogDescription>
            Review Git repositories found in this attached workspace. Nothing is
            imported until you explicitly select it.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-40 flex-1 overflow-y-auto rounded-lg border">
          {discovery.isLoading ? (
            <div className="grid min-h-40 place-items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading repository discovery…
            </div>
          ) : discovery.isError ? (
            <div className="grid min-h-40 place-items-center px-6 text-center text-sm text-destructive">
              {errorMessage(
                discovery.error,
                "Repository discovery is unavailable.",
              )}
            </div>
          ) : snapshot && busy ? (
            <div className="grid min-h-40 place-items-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <div>
                <p className="font-medium text-foreground">
                  {snapshot.job.state === "queued"
                    ? "Waiting for the worker…"
                    : "Scanning workspace…"}
                </p>
                <p className="mt-1 text-xs">{progressDescription(snapshot)}</p>
              </div>
            </div>
          ) : snapshot &&
            (snapshot.job.state === "blocked" ||
              snapshot.job.state === "failed") ? (
            <div className="grid min-h-40 place-items-center gap-2 px-6 text-center">
              <AlertTriangle className="size-5 text-destructive" />
              <div>
                <p className="text-sm font-medium">Discovery unavailable</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {discoveryError(snapshot)}
                </p>
              </div>
            </div>
          ) : snapshot && visibleCandidates.length ? (
            <ul className="divide-y">
              {visibleCandidates.map((candidate) => (
                <CandidateRow
                  checked={selected.has(candidate.candidate.id)}
                  disabled={
                    importRepositories.isPending ||
                    !selectableIds.has(candidate.candidate.id)
                  }
                  key={candidate.candidate.id}
                  onCheckedChange={(checked) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(candidate.candidate.id);
                      else next.delete(candidate.candidate.id);
                      return next;
                    });
                  }}
                  resolved={candidate}
                  workspaceName={
                    candidate.candidate.conflict
                      ? (workspaceNames.get(
                          candidate.candidate.conflict.workspaceId,
                        ) ?? null)
                      : null
                  }
                />
              ))}
            </ul>
          ) : snapshot ? (
            <div className="grid min-h-40 place-items-center px-6 text-center">
              <div>
                <p className="text-sm font-medium">
                  {candidates.length
                    ? "No new Git repositories found"
                    : "No Git repositories found"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The scan searched the workspace root through depth{" "}
                  {snapshot.job.depth}.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {snapshot?.job.state === "succeeded" ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{snapshot.candidates.length} repositories found</span>
            <span>{visibleCandidates.length} available to import</span>
            {snapshot.job.counts?.collapsedRepositories ? (
              <span>
                {snapshot.job.counts.collapsedRepositories} nested checkouts
                collapsed
              </span>
            ) : null}
            {snapshot.job.counts?.rejectedRepositories ? (
              <span>
                {snapshot.job.counts.rejectedRepositories} unsupported or
                invalid checkouts rejected
              </span>
            ) : null}
            {snapshot.job.diagnosticCode === "scan-truncated" ? (
              <span className="text-destructive">
                Results reached the bounded scan limit.
              </span>
            ) : null}
            {metadata.isError ? (
              <span>
                Protected repository details are temporarily unavailable.
              </span>
            ) : null}
            {!workerOnline ? (
              <span>Connect the home worker to reveal protected paths.</span>
            ) : null}
          </div>
        ) : null}

        {rescan.isError || importRepositories.isError ? (
          <p className="text-sm text-destructive">
            {rescan.isError
              ? errorMessage(rescan.error, "Could not start another scan.")
              : errorMessage(
                  importRepositories.error,
                  "Could not start repository import.",
                )}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={
              busy ||
              activeImports ||
              importRepositories.isPending ||
              selectableIds.size === 0 ||
              !workerOnline
            }
            onClick={() =>
              setSelected(allSelected ? new Set() : new Set(selectableIds))
            }
            type="button"
            variant="outline"
          >
            {allSelected ? "Select none" : "Select all"}
          </Button>
          <Button
            disabled={!workspace || busy || activeImports || !workerOnline}
            onClick={() => rescan.mutate()}
            pending={rescan.isPending}
            pendingLabel="Starting scan…"
            type="button"
            variant="outline"
          >
            <RefreshCw className="size-4" /> Rescan
          </Button>
          <Button
            disabled={
              busy ||
              activeImports ||
              importRepositories.isPending ||
              selectedCandidates.length === 0 ||
              !workerOnline
            }
            onClick={() => importRepositories.mutate()}
            pending={importRepositories.isPending}
            pendingLabel="Queueing imports…"
            type="button"
          >
            Import selected
          </Button>
          <Button onClick={() => onOpenChange(false)} type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
